#!/usr/bin/env python3
"""Dependency-free Mission Control telemetry agent for Linux hosts."""

import json
import math
import os
import platform
import re
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_HEALTH_WORKERS = 8


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


def installed_memory_label(total_bytes):
    """Present Linux's slightly reduced MemTotal as installed RAM capacity."""
    gib = total_bytes / 1073741824
    standard_sizes = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024]
    nearest = min(standard_sizes, key=lambda size: abs(size - gib))
    value = nearest if abs(nearest - gib) / max(nearest, 1) <= 0.1 else round(gib)
    return f"{value} GB"


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


def clean_gpu_name(raw_name):
    """Reduce verbose PCI descriptions to the useful consumer GPU model."""
    bracketed = re.findall(r"\[([^]]+)]", raw_name)
    for candidate in reversed(bracketed):
        if re.search(r"Radeon|GeForce|Arc\s|UHD Graphics|Iris|HD Graphics", candidate, re.IGNORECASE):
            return candidate
    cleaned = re.sub(r"^.*?(?:VGA compatible controller|3D controller)(?:\s*\[[^]]+])?:?\s*", "", raw_name)
    cleaned = re.sub(r"^(?:Advanced Micro Devices, Inc\.\s*)?\[AMD/ATI]\s*", "", cleaned)
    cleaned = re.sub(r"^NVIDIA Corporation\s*", "", cleaned)
    return cleaned.strip() or "Integrated / unavailable"


def gpu_details():
    configured_name = os.environ.get("MISSION_CONTROL_GPU_NAME", "").strip()
    model = "Integrated / unavailable"
    if shutil.which("nvidia-smi"):
        try:
            result = subprocess.run(
                ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=3,
            )
            if result.returncode == 0 and result.stdout.strip():
                model = result.stdout.splitlines()[0].strip()
        except (OSError, subprocess.TimeoutExpired):
            pass
    if model == "Integrated / unavailable" and shutil.which("lspci"):
        try:
            result = subprocess.run(["lspci", "-nn"], capture_output=True, text=True, timeout=3)
            for line in result.stdout.splitlines():
                if "VGA compatible controller" in line or "3D controller" in line:
                    model = clean_gpu_name(line)
                    break
        except (OSError, subprocess.TimeoutExpired):
            pass
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
    return configured_name or model, load


def decimal_capacity(size_bytes):
    if size_bytes >= 1_000_000_000_000:
        value, unit = size_bytes / 1_000_000_000_000, "TB"
    else:
        value, unit = size_bytes / 1_000_000_000, "GB"
    precision = 0 if value >= 10 or math.isclose(value, round(value), abs_tol=0.05) else 1
    return f"{value:.{precision}f} {unit}"


def drive_health(path):
    """Return a conservative SMART status without ever requiring elevated access.

    Health is best-effort: ``unavailable`` means the SMART result could not be
    read (not that the drive is failing). Genuine transport failures propagate
    to the caller so a concurrent collector can count them without killing the
    rest of the payload.
    """
    smartctl = shutil.which("smartctl")
    if not smartctl:
        return "unavailable"
    command = [smartctl, "-H", "-j", path]
    if os.environ.get("MISSION_CONTROL_SMARTCTL_SUDO", "").lower() in ("1", "true", "yes"):
        command = ["sudo", "-n", *command]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=4)
        payload = json.loads(result.stdout or "{}")
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"SMART health check timed out for {path}") from error
    except json.JSONDecodeError as error:
        raise RuntimeError(f"SMART health check returned invalid data for {path}") from error
    passed = payload.get("smart_status", {}).get("passed")
    critical = payload.get("nvme_smart_health_information_log", {}).get("critical_warning")
    if passed is False:
        return "failing"
    if isinstance(critical, int) and critical:
        return "warning"
    if passed is True or critical == 0:
        return "healthy"
    return "unavailable"


def collect_drive_health(devices):
    """Measure every physical disk concurrently.

    Health is the slow part of ``storage_details()``: each probe can burn its
    full four-second timeout, and a stalled disk in a large RAID used to
    stretch the whole stats round past the dashboard's own 4 s fetch timeout,
    which then marked the *healthy* node offline. Workers are capped like the
    dashboard aggregator so probe time stays bounded by the slowest disk, not
    the sum of all disks, and one bad probe is reported as ``unavailable``
    instead of tearing down the payload for every other drive.
    """
    if not devices:
        return {}
    paths = [device.get("device", "") for device in devices]
    with ThreadPoolExecutor(max_workers=min(len(devices), MAX_HEALTH_WORKERS)) as pool:
        futures = [pool.submit(drive_health, path) for path in paths]
        results = []
        for index, future in enumerate(futures):
            try:
                results.append(future.result())
            except Exception:
                results.append("unavailable")
    return dict(zip(paths, results))


def _walk_devices(devices):
    for device in devices:
        yield device
        yield from _walk_devices(device.get("children", []))


def storage_details():
    """Return physical disks, with the root filesystem's disk listed first."""
    if not shutil.which("lsblk"):
        disk = shutil.disk_usage("/")
        return [{
            "name": "Root filesystem", "device": "/", "model": "",
            "capacity": decimal_capacity(disk.total), "size_bytes": disk.total,
            "mount": "/", "used_bytes": disk.used,
            "usage": round(100 * disk.used / disk.total), "health": "unavailable", "primary": True,
        }]
    try:
        result = subprocess.run(
            ["lsblk", "--json", "--bytes", "--paths", "--output",
             "NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS,MODEL,TRAN"],
            capture_output=True, text=True, timeout=4,
        )
        payload = json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return []

    candidate_drives = []
    for disk in payload.get("blockdevices", []):
        if disk.get("type") != "disk" or disk.get("name", "").startswith(("/dev/loop", "/dev/zram")):
            continue
        descendants = list(_walk_devices(disk.get("children", [])))
        mountpoints = []
        for item in [disk, *descendants]:
            mountpoints.extend(mount for mount in (item.get("mountpoints") or []) if mount and mount != "[SWAP]")
        mountpoints = sorted(set(mountpoints), key=lambda mount: (mount != "/", len(mount), mount))
        candidate_drives.append({
            "name": Path(disk.get("name", "")).name, "device": disk.get("name", ""),
            "model": (disk.get("model") or "").strip(),
            "capacity": decimal_capacity(int(disk.get("size") or 0)),
            "size_bytes": int(disk.get("size") or 0),
            "mount": "/" if "/" in mountpoints else (mountpoints[0] if mountpoints else None),
            "primary": "/" in mountpoints, "mountpoints": mountpoints,
        })
    health = collect_drive_health(candidate_drives)
    drives = []
    for candidate in candidate_drives:
        used = usage = None
        if candidate["mount"]:
            try:
                totals = shutil.disk_usage(candidate["mount"])
                used = totals.used
                usage = round(100 * totals.used / totals.total) if totals.total else 0
            except OSError:
                pass
        candidate["used_bytes"] = used
        candidate["usage"] = usage
        candidate["health"] = health.get(candidate["device"], "unavailable")
        drives.append({
            "name": candidate["name"], "device": candidate["device"], "model": candidate["model"],
            "capacity": candidate["capacity"], "size_bytes": candidate["size_bytes"],
            "mount": candidate["mount"], "used_bytes": candidate["used_bytes"],
            "usage": candidate["usage"], "health": candidate["health"], "primary": candidate["primary"],
        })
    return sorted(drives, key=lambda drive: (not drive["primary"], drive["name"]))


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
    drives = storage_details()
    primary_drive = next((drive for drive in drives if drive["primary"]), drives[0] if drives else None)
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
            "memory": installed_memory_label(total_memory),
            "disk": primary_drive["capacity"] if primary_drive else "Unavailable",
            "gpu": gpu_model,
        },
        "usage": {
            "cpu": cpu_usage(),
            "memory": memory_pct,
            "disk": primary_drive["usage"] if primary_drive else None,
            "gpu": gpu_load,
            "temperature": None,
        },
        "drives": drives,
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
