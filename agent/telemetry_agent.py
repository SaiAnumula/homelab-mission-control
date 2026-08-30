#!/usr/bin/env python3
"""Dependency-free Mission Control telemetry agent for Linux hosts."""

import json
import os
import platform
import shutil
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def read(path, default=""):
    try:
        return Path(path).read_text().strip()
    except (OSError, PermissionError):
        return default


def cpu_sample():
    fields = [int(value) for value in read("/proc/stat").splitlines()[0].split()[1:]]
    idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
    return sum(fields), idle


def cpu_usage():
    total_a, idle_a = cpu_sample()
    time.sleep(0.12)
    total_b, idle_b = cpu_sample()
    elapsed = total_b - total_a
    return round(100 * (1 - ((idle_b - idle_a) / elapsed))) if elapsed else 0


def memory():
    values = {}
    for line in read("/proc/meminfo").splitlines():
        key, value = line.split(":", 1)
        values[key] = int(value.strip().split()[0]) * 1024
    total = values.get("MemTotal", 0)
    available = values.get("MemAvailable", 0)
    used_pct = round(100 * (total - available) / total) if total else 0
    return total, used_pct


def cpu_details():
    model = "Unknown CPU"
    physical = set()
    current_physical = current_core = None
    for line in read("/proc/cpuinfo").splitlines() + [""]:
        if line.startswith("model name"):
            model = line.split(":", 1)[1].strip()
        elif line.startswith("physical id"):
            current_physical = line.split(":", 1)[1].strip()
        elif line.startswith("core id"):
            current_core = line.split(":", 1)[1].strip()
        elif not line and current_core is not None:
            physical.add((current_physical, current_core))
            current_physical = current_core = None
    threads = os.cpu_count() or 0
    cores = len(physical) or threads
    return model, f"{cores}C / {threads}T"


def gpu_details():
    model = "Integrated / unavailable"
    if shutil.which("lspci"):
        result = subprocess.run(["lspci"], capture_output=True, text=True, timeout=3)
        for line in result.stdout.splitlines():
            if "VGA compatible controller" in line or "3D controller" in line:
                model = line.split(": ", 1)[-1]
                break
    load = None
    for metric in Path("/sys/class/drm").glob("card[0-9]*/device/gpu_busy_percent"):
        try:
            load = round(float(metric.read_text().strip()))
            break
        except (OSError, ValueError):
            pass
    if load is None and shutil.which("nvidia-smi"):
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=3,
            )
            value = result.stdout.splitlines()[0].strip()
            if result.returncode == 0 and value:
                load = round(float(value))
        except (OSError, subprocess.TimeoutExpired, ValueError, IndexError):
            pass
    return model, load


def docker_containers():
    if not shutil.which("docker"):
        return []
    try:
        result = subprocess.run(
            ["docker", "ps", "-a", "--format", "{{json .}}"],
            capture_output=True, text=True, timeout=4,
        )
        if result.returncode:
            return []
        containers = []
        for line in result.stdout.splitlines():
            item = json.loads(line)
            containers.append({
                "name": item.get("Names", "unknown"),
                "state": item.get("State", "unknown").lower(),
                "status": item.get("Status", ""),
            })
        return containers
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return []


def monitored_services():
    """Report known game/services only when they are installed on this host."""
    names = os.environ.get("MISSION_CONTROL_SERVICES", "palworld.service").split(",")
    services = []
    for name in (item.strip() for item in names if item.strip()):
        try:
            result = subprocess.run(
                ["systemctl", "show", name, "--property=LoadState,ActiveState,SubState,Description"],
                capture_output=True, text=True, timeout=3,
            )
            fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
            if fields.get("LoadState") != "loaded":
                continue
            services.append({
                "id": name,
                "name": fields.get("Description") or name.removesuffix(".service").title(),
                "state": fields.get("ActiveState", "unknown"),
                "detail": fields.get("SubState", "unknown"),
            })
        except (OSError, subprocess.TimeoutExpired):
            pass
    return services


def stats():
    total_memory, memory_pct = memory()
    disk = shutil.disk_usage("/")
    cpu_model, cores = cpu_details()
    gpu_model, gpu_load = gpu_details()
    os_release = {}
    for line in read("/etc/os-release").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            os_release[key] = value.strip('"')
    return {
        "online": True,
        "os": os_release.get("PRETTY_NAME", platform.platform()),
        "uptime": float(read("/proc/uptime", "0").split()[0]),
        "specs": {
            "cpu": cpu_model,
            "cores": cores,
            "memory": f"{total_memory / 1073741824:.0f} GB",
            "disk": f"{disk.total / 1073741824:.0f} GB",
            "gpu": gpu_model,
        },
        "usage": {
            "cpu": cpu_usage(),
            "memory": memory_pct,
            "disk": round(100 * disk.used / disk.total),
            "gpu": gpu_load,
            "temperature": None,
        },
        "containers": docker_containers(),
        "services": monitored_services(),
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ("/api/agent/stats", "/api/health"):
            self.send_error(404)
            return
        payload = {"ok": True} if self.path == "/api/health" else stats()
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} - {fmt % args}")


if __name__ == "__main__":
    port = int(os.environ.get("MISSION_CONTROL_PORT", "4242"))
    print(f"Mission Control agent listening on 0.0.0.0:{port}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
