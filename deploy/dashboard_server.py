#!/usr/bin/env python3
"""Static Mission Control host and remote telemetry aggregator."""

import json
import math
import os
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
DEVICES = Path(os.environ.get("MISSION_CONTROL_DEVICES", ROOT / "devices.json"))
DIST = ROOT / "dist"
MAX_FETCH_WORKERS = 8


CACHE_SECONDS = 10
MAX_RESPONSE_BYTES = 1024 * 1024
PUBLIC_DEVICE_FIELDS = ("id", "name", "label", "type", "accent")
TELEMETRY_FIELDS = ("online", "os", "uptime", "specs", "usage", "drives", "containers", "services", "error", "collectedAt")


class ConfigurationError(ValueError):
    """An invalid device configuration must be visible, not an empty dashboard."""


def public_device(device):
    return {key: device[key] for key in PUBLIC_DEVICE_FIELDS if key in device}


def failed_device(device, error):
    return {**public_device(device), "online": False, "status": "down", "error": str(error),
            "checkedAt": datetime.now(timezone.utc).isoformat(), "usage": {}, "specs": {}}


def validate_devices(data):
    if not isinstance(data, list):
        raise ConfigurationError("Device configuration must be a JSON array")
    seen = set()
    for index, device in enumerate(data):
        if not isinstance(device, dict):
            raise ConfigurationError(f"Device {index + 1} must be an object")
        for key in ("id", "name"):
            if not isinstance(device.get(key), str) or not device[key].strip():
                raise ConfigurationError(f"Device {index + 1} needs a nonempty {key}")
        if device["id"] in seen:
            raise ConfigurationError(f"Device {index + 1} has a duplicate id")
        seen.add(device["id"])
        for key in ("label", "type", "accent", "endpoint"):
            if key in device and not isinstance(device[key], str):
                raise ConfigurationError(f"Device {index + 1} {key} must be a string")
        endpoint = device.get("endpoint", "").strip()
        if endpoint and endpoint != "local":
            try:
                parsed = urlsplit(endpoint)
                port = parsed.port
                valid = (parsed.scheme in ("http", "https") and parsed.hostname
                         and not parsed.username and not parsed.password
                         and not parsed.query and not parsed.fragment
                         and (port is None or port > 0))
            except ValueError:
                valid = False
            if not valid:
                raise ConfigurationError(f"Device {index + 1} needs an HTTP(S) endpoint without credentials")
    return data


def validate_stats(stats):
    if not isinstance(stats, dict) or not isinstance(stats.get("online"), bool):
        raise ValueError("Invalid telemetry: expected an object with boolean online")
    for key in ("specs", "usage"):
        if key in stats and not isinstance(stats[key], dict):
            raise ValueError(f"Invalid telemetry: {key} must be an object")
    for key in ("drives", "containers", "services"):
        if key in stats and (not isinstance(stats[key], list)
                             or any(not isinstance(item, dict) for item in stats[key])):
            raise ValueError(f"Invalid telemetry: {key} must be an array of objects")
    for key in ("os", "error", "collectedAt"):
        if key in stats and not isinstance(stats[key], str):
            raise ValueError(f"Invalid telemetry: {key} must be a string")
    if "uptime" in stats and (isinstance(stats["uptime"], bool)
                             or not isinstance(stats["uptime"], (float, int))
                             or not math.isfinite(stats["uptime"])):
        raise ValueError("Invalid telemetry: uptime must be numeric")
    for key, value in stats.get("specs", {}).items():
        if value is not None and not isinstance(value, str):
            raise ValueError(f"Invalid telemetry: specs.{key} must be a string or null")
    for key, value in stats.get("usage", {}).items():
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float, str))
                                  or isinstance(value, (int, float)) and not math.isfinite(value)):
            raise ValueError(f"Invalid telemetry: usage.{key} must be a finite number, string or null")
    string_fields = {
        "drives": ("name", "device", "model", "capacity", "mount", "health"),
        "containers": ("name", "state", "status", "health"),
        "services": ("id", "name", "state", "detail"),
    }
    for collection, fields in string_fields.items():
        for item in stats.get(collection, []):
            for key in fields:
                if key in item and item[key] is not None and not isinstance(item[key], str):
                    raise ValueError(f"Invalid telemetry: {collection}.{key} must be a string or null")
    return {key: stats[key] for key in TELEMETRY_FIELDS if key in stats}


def telemetry_status(stats):
    if not stats.get("online"):
        return "down"
    degraded = bool(stats.get("error")) or any(
        service.get("state") != "active" for service in stats.get("services", [])
    ) or any(
        container.get("state") != "running" or container.get("health") in ("unhealthy", "starting")
        for container in stats.get("containers", [])
    ) or any(drive.get("health") in ("warning", "failing") for drive in stats.get("drives", []))
    return "degraded" if degraded else "up"


def reject_constant(_value):
    raise ValueError("Invalid telemetry: non-finite JSON number")


def fetch_device(device):
    raw_endpoint = (device.get("endpoint") or "").strip().rstrip("/")
    if not raw_endpoint:
        return failed_device(device, "Endpoint not configured")
    if raw_endpoint == "local":
        agent_port = os.environ.get("MISSION_CONTROL_PORT", "4242")
        endpoint = f"http://127.0.0.1:{agent_port}"
    else:
        endpoint = raw_endpoint
    try:
        request = urllib.request.Request(f"{endpoint}/api/agent/stats")
        with urllib.request.urlopen(request, timeout=4) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise ValueError("Telemetry response exceeds size limit")
            stats = validate_stats(json.loads(body, parse_constant=reject_constant))
        return {**public_device(device), **stats, "status": telemetry_status(stats),
                "checkedAt": datetime.now(timezone.utc).isoformat()}
    except ValueError as error:
        return failed_device(device, error)
    except (OSError, urllib.error.URLError):
        return failed_device(device, "Telemetry endpoint unavailable or timed out")


def load_devices():
    try:
        return validate_devices(json.loads(DEVICES.read_text()))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ConfigurationError("Cannot read device configuration; check its path and JSON syntax") from error


def aggregate_devices(devices):
    """Fetch every endpoint concurrently so a single slow or offline node cannot
    stretch the refresh cycle for the rest. Per-device failures stay offline
    instead of failing the whole batch."""
    if not devices:
        return []
    def safe_fetch(device):
        try:
            return fetch_device(device)
        except Exception as error:  # A worker failure must not take down every card.
            return failed_device(device, f"Telemetry fetch failed: {error}")
    with ThreadPoolExecutor(max_workers=min(len(devices), MAX_FETCH_WORKERS)) as pool:
        return list(pool.map(safe_fetch, devices))


class DeviceCache:
    """One refresh at a time across browser clients; failures are cached too."""
    def __init__(self):
        self._lock = threading.Lock()
        self._devices = None
        self._payload = None
        self._expires = 0

    def get(self, devices):
        with self._lock:
            if self._payload is not None and self._devices == devices and time.monotonic() < self._expires:
                return self._payload
            results = aggregate_devices(devices)
            payload = {"devices": results, "updatedAt": datetime.now(timezone.utc).isoformat()}
            self._devices = devices
            self._payload = payload
            self._expires = time.monotonic() + CACHE_SECONDS
            return payload


DEVICE_CACHE = DeviceCache()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def do_GET(self):
        path = urlsplit(self.path).path.rstrip("/") or "/"
        if path == "/api/health":
            return self.send_json({"ok": True})
        if path == "/api/devices":
            try:
                return self.send_json(DEVICE_CACHE.get(load_devices()))
            except ConfigurationError as error:
                return self.send_json({"error": str(error)}, status=503)
        if not path.startswith("/assets/") and not (DIST / path.lstrip("/")).is_file():
            self.path = "/index.html"
        return super().do_GET()

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    host = os.environ.get("MISSION_CONTROL_DASHBOARD_HOST", os.environ.get("MISSION_CONTROL_HOST", "0.0.0.0")).strip() or "0.0.0.0"
    port = int(os.environ.get("MISSION_CONTROL_DASHBOARD_PORT", "8080"))
    print(f"Mission Control dashboard listening on {host}:{port}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
