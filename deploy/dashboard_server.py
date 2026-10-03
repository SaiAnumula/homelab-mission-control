#!/usr/bin/env python3
"""Static Mission Control host and remote telemetry aggregator."""

import json
import os
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


def fetch_device(device):
    raw_endpoint = (device.get("endpoint") or "").strip().rstrip("/")
    if not raw_endpoint:
        return {**device, "online": False, "error": "Endpoint not configured", "usage": {}, "specs": {}}
    if raw_endpoint == "local":
        agent_port = os.environ.get("MISSION_CONTROL_PORT", "4242")
        endpoint = f"http://127.0.0.1:{agent_port}"
    else:
        endpoint = raw_endpoint
    try:
        request = urllib.request.Request(f"{endpoint}/api/agent/stats")
        with urllib.request.urlopen(request, timeout=4) as response:
            stats = json.load(response)
        return {**device, **stats}
    except (OSError, ValueError, urllib.error.URLError, json.JSONDecodeError) as error:
        return {**device, "online": False, "error": str(error), "usage": {}, "specs": {}}


def load_devices():
    if not DEVICES.is_file():
        return []
    try:
        data = json.loads(DEVICES.read_text())
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


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
            return {**device, "online": False, "error": f"Telemetry fetch failed: {error}", "usage": {}, "specs": {}}
    with ThreadPoolExecutor(max_workers=min(len(devices), MAX_FETCH_WORKERS)) as pool:
        return list(pool.map(safe_fetch, devices))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def do_GET(self):
        path = urlsplit(self.path).path.rstrip("/") or "/"
        if path == "/api/health":
            return self.send_json({"ok": True})
        if path == "/api/devices":
            devices = aggregate_devices(load_devices())
            return self.send_json({
                "devices": devices,
                "updatedAt": datetime.now(timezone.utc).isoformat(),
            })
        if not path.startswith("/assets/") and not (DIST / path.lstrip("/")).is_file():
            self.path = "/index.html"
        return super().do_GET()

    def send_json(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
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
