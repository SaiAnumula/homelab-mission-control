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


HEALTHY_CHECK_SECONDS = 10
RECOVERY_SECONDS = 1
DOWN_AFTER_SECONDS = 10
DOWN_CHECK_SECONDS = 15
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
    if not isinstance(data, list) or len(data) > 64:
        raise ConfigurationError("Device configuration must be a JSON array of at most 64 devices")
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
            if collection in ("services", "containers") and any(
                not isinstance(item.get(key), str) for key in ("name", "state")
            ):
                raise ValueError(f"Invalid telemetry: {collection} entries need string name and state")
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


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def open_endpoint(request, timeout):
    try:
        return urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        error.close()
        raise


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
        with open_endpoint(request, timeout=4) as response:
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


def check_health(device):
    endpoint = device.get("endpoint", "").strip().rstrip("/")
    if endpoint == "local":
        endpoint = f"http://127.0.0.1:{os.environ.get('MISSION_CONTROL_PORT', '4242')}"
    if not endpoint:
        return False
    try:
        with open_endpoint(f"{endpoint}/api/health", timeout=1) as response:
            body = response.read(16385)
            return len(body) <= 16384 and json.loads(body).get("ok") is True
    except (OSError, ValueError, AttributeError):
        return False


class DeviceMonitor:
    """Background checks shared by all clients, with one job per device."""
    def __init__(self, fetch=fetch_device, health=check_health, now=time.monotonic):
        self._lock = threading.Lock()
        self._entries = {}
        self._fetch = fetch
        self._health = health
        self._now = now
        self._stop = threading.Event()
        self._thread = None
        self._pool = None
        self._active = 0

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._pool = ThreadPoolExecutor(max_workers=MAX_FETCH_WORKERS)
        self._thread = threading.Thread(target=self._run, daemon=True, name="device-monitor")
        self._thread.start()

    def close(self):
        self._stop.set()
        if self._thread:
            self._thread.join()
        if self._pool:
            self._pool.shutdown(wait=True, cancel_futures=True)
            self._pool = None

    def _run(self):
        while not self._stop.is_set():
            self.run_due()
            self._stop.wait(0.1)

    def run_due(self):
        with self._lock:
            if self._pool is None:
                return
            # Submit only available worker slots, rather than queueing stale jobs.
            available = max(0, MAX_FETCH_WORKERS - self._active)
            due = sorted((e for e in self._entries.values()
                          if not e["pending"] and e["due"] <= self._now()), key=lambda e: e["due"])
            for entry in due[:available]:
                entry["pending"] = True
                self._active += 1
                self._pool.submit(self._check, entry)

    def _is_down(self, entry):
        return (entry["failed_since"] is not None
                and self._now() - entry["failed_since"] >= DOWN_AFTER_SECONDS)

    def _check(self, entry):
        try:
            self._collect(entry)
        except Exception:
            with self._lock:
                entry["recovering"] = True
                entry["error"] = "Telemetry check failed"
                if entry["failed_since"] is None:
                    entry["failed_since"] = self._now()
                entry["due"] = self._now() + RECOVERY_SECONDS
        finally:
            with self._lock:
                entry["pending"] = False
                self._active -= 1

    def _collect(self, entry):
        started = self._now()
        reachable = False
        result = None
        try:
            if entry["recovering"]:
                reachable = self._health(entry["device"])
                if reachable:
                    # A live health endpoint establishes reachability even if
                    # the slower metrics request fails or is still in progress.
                    with self._lock:
                        entry["failed_since"] = None
            if not entry["recovering"] or reachable:
                result = self._fetch(entry["device"])
        except Exception:
            result = failed_device(entry["device"], "Telemetry check failed")
        with self._lock:
            entry["checked_at"] = datetime.now(timezone.utc).isoformat()
            if result and result.get("online"):
                entry["last_good"] = result
                entry["recovering"] = False
                entry["failed_since"] = None
                entry["error"] = None
            else:
                entry["recovering"] = True
                entry["error"] = ("Telemetry delayed; device responds to health checks" if reachable
                                  else "Telemetry unavailable; checking connection")
                if not reachable and entry["failed_since"] is None:
                    entry["failed_since"] = self._now()
            interval = (DOWN_CHECK_SECONDS if self._is_down(entry) else
                        RECOVERY_SECONDS if entry["recovering"] else HEALTHY_CHECK_SECONDS)
            entry["due"] = max(started + interval, self._now())

    def get(self, devices):
        with self._lock:
            entries = {}
            for device in devices:
                entry = self._entries.get(device["id"])
                if entry is None or entry["device"].get("endpoint") != device.get("endpoint"):
                    entry = {"device": dict(device), "last_good": None, "failed_since": None,
                             "recovering": False, "pending": False, "due": 0,
                             "checked_at": None, "error": "Waiting for first telemetry check"}
                entry["device"] = dict(device)
                entries[device["id"]] = entry
            self._entries = entries
            results = []
            for entry in entries.values():
                result = dict(entry["last_good"] or {
                    **public_device(entry["device"]), "online": False, "specs": {}, "usage": {},
                })
                if entry["recovering"] or entry["last_good"] is None:
                    down = self._is_down(entry)
                    result.update(status="down" if down else "stale", error=entry["error"])
                    if down:
                        result["online"] = False
                    result["lastGoodAt"] = (entry["last_good"] or {}).get("checkedAt")
                result["checkedAt"] = entry["checked_at"]
                result.update(public_device(entry["device"]))
                results.append(result)
            return {"devices": results, "updatedAt": datetime.now(timezone.utc).isoformat()}


DEVICE_MONITOR = DeviceMonitor()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def do_GET(self):
        path = urlsplit(self.path).path.rstrip("/") or "/"
        if path == "/api/health":
            return self.send_json({"ok": True})
        if path == "/api/devices":
            try:
                return self.send_json(DEVICE_MONITOR.get(load_devices()))
            except ConfigurationError as error:
                return self.send_json({"error": str(error)}, status=503)
        if path == "/api" or path.startswith("/api/"):
            return self.send_json({"error": "Not found"}, status=404)
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
    DEVICE_MONITOR.start()
    try:
        with ThreadingHTTPServer((host, port), Handler) as server:
            server.serve_forever()
    finally:
        DEVICE_MONITOR.close()
