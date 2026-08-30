#!/usr/bin/env python3
"""Static Mission Control host and remote telemetry aggregator."""

import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEVICES = Path(os.environ.get("MISSION_CONTROL_DEVICES", ROOT / "devices.json"))
DIST = ROOT / "dist"


def fetch_device(device):
    endpoint = device.get("endpoint", "").rstrip("/")
    try:
        request = urllib.request.Request(f"{endpoint}/api/agent/stats")
        with urllib.request.urlopen(request, timeout=4) as response:
            stats = json.load(response)
        return {**device, **stats}
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        return {**device, "online": False, "error": str(error), "usage": {}, "specs": {}}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def do_GET(self):
        if self.path == "/api/health":
            return self.send_json({"ok": True})
        if self.path == "/api/devices":
            devices = json.loads(DEVICES.read_text())
            return self.send_json({
                "devices": [fetch_device(device) for device in devices],
                "updatedAt": datetime.now(timezone.utc).isoformat(),
            })
        if not self.path.startswith("/assets/") and not (DIST / self.path.lstrip("/")).is_file():
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
    port = int(os.environ.get("MISSION_CONTROL_DASHBOARD_PORT", "8080"))
    print(f"Mission Control dashboard listening on 0.0.0.0:{port}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
