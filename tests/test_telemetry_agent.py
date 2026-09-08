import json
import os
import subprocess
import time
import unittest
from collections import namedtuple
from unittest.mock import patch

from agent import telemetry_agent


Completed = namedtuple("Completed", "stdout returncode")
Usage = namedtuple("Usage", "total used free")


class TelemetryFormattingTests(unittest.TestCase):
    def test_installed_memory_uses_standard_capacity(self):
        self.assertEqual(telemetry_agent.installed_memory_label(int(31.2 * 2**30)), "32 GB")
        self.assertEqual(telemetry_agent.installed_memory_label(int(23.4 * 2**30)), "24 GB")

    def test_decimal_drive_capacities_match_marketed_sizes(self):
        self.assertEqual(telemetry_agent.decimal_capacity(2_000_398_934_016), "2 TB")
        self.assertEqual(telemetry_agent.decimal_capacity(128_035_676_160), "128 GB")

    def test_gpu_names_drop_vendor_noise(self):
        amd = "03:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 48 [Radeon RX 9070/9070 XT/9070 GRE] [1002:7550]"
        nvidia = "01:00.0 VGA compatible controller: NVIDIA Corporation GB205 [GeForce RTX 5070] [10de:2f04]"
        intel = "00:02.0 VGA compatible controller [0300]: Intel Corporation Alder Lake-UP3 GT1 [UHD Graphics] [8086:46b3]"
        self.assertEqual(telemetry_agent.clean_gpu_name(amd), "Radeon RX 9070/9070 XT/9070 GRE")
        self.assertEqual(telemetry_agent.clean_gpu_name(nvidia), "GeForce RTX 5070")
        self.assertEqual(telemetry_agent.clean_gpu_name(intel), "UHD Graphics")


class StorageTests(unittest.TestCase):
    @patch.dict(os.environ, {"MISSION_CONTROL_SMARTCTL_SUDO": "1"})
    @patch.object(telemetry_agent.shutil, "which", return_value="/usr/sbin/smartctl")
    @patch.object(telemetry_agent.subprocess, "run")
    def test_optional_smartctl_sudo_is_noninteractive_and_read_only(self, run, _which):
        run.return_value = Completed(json.dumps({"smart_status": {"passed": True}}), 0)

        self.assertEqual(telemetry_agent.drive_health("/dev/sda"), "healthy")
        self.assertEqual(run.call_args.args[0], ["sudo", "-n", "/usr/sbin/smartctl", "-H", "-j", "/dev/sda"])

    @patch.object(telemetry_agent, "drive_health", return_value="healthy")
    @patch.object(telemetry_agent.shutil, "disk_usage", return_value=Usage(128_000_000_000, 32_000_000_000, 96_000_000_000))
    @patch.object(telemetry_agent.shutil, "which", return_value="/usr/bin/lsblk")
    @patch.object(telemetry_agent.subprocess, "run")
    def test_root_disk_is_primary_and_other_disk_is_included(self, run, _which, _usage, _health):
        run.return_value = Completed(json.dumps({"blockdevices": [
            {"name": "/dev/sda", "type": "disk", "size": 128_000_000_000, "model": "Boot SSD", "mountpoints": [],
             "children": [{"name": "/dev/sda2", "type": "part", "size": 127_000_000_000, "mountpoints": ["/"]}]},
            {"name": "/dev/sdb", "type": "disk", "size": 2_000_000_000_000, "model": "Data HDD", "mountpoints": [],
             "children": [{"name": "/dev/sdb1", "type": "part", "size": 2_000_000_000_000, "mountpoints": ["/mnt/data"]}]},
            {"name": "/dev/zram0", "type": "disk", "size": 32_000_000_000, "model": None, "mountpoints": ["[SWAP]"]},
        ]}), 0)

        drives = telemetry_agent.storage_details()

        self.assertEqual([drive["name"] for drive in drives], ["sda", "sdb"])
        self.assertTrue(drives[0]["primary"])
        self.assertEqual(drives[1]["capacity"], "2 TB")
        self.assertEqual(drives[1]["mount"], "/mnt/data")


class DriveHealthTests(unittest.TestCase):
    """drive_health stays conservative: it never maps a transport failure
    onto a pass/fail status; real failures surface as errors the concurrent
    collector converts to ``unavailable``."""

    @patch.object(telemetry_agent.shutil, "which", return_value="/usr/sbin/smartctl")
    @patch.object(telemetry_agent.subprocess, "run")
    def test_timeout_surfaces_as_an_error_not_a_status(self, run, _which):
        run.side_effect = subprocess.TimeoutExpired(["smartctl"], 4)
        with self.assertRaises(RuntimeError):
            telemetry_agent.drive_health("/dev/sda")

    @patch.object(telemetry_agent.shutil, "which", return_value="/usr/sbin/smartctl")
    @patch.object(telemetry_agent.subprocess, "run")
    def test_invalid_json_surfaces_as_an_error_not_a_status(self, run, _which):
        run.return_value = Completed("this is not json", 0)
        with self.assertRaises(RuntimeError):
            telemetry_agent.drive_health("/dev/sda")

    @patch.object(telemetry_agent.shutil, "which", return_value="/usr/sbin/smartctl")
    @patch.object(telemetry_agent.subprocess, "run")
    def test_unexpected_error_code_stays_unavailable(self, run, _which):
        run.return_value = Completed(json.dumps({}), 1)
        self.assertEqual(telemetry_agent.drive_health("/dev/sda"), "unavailable")


class ConcurrentHealthTests(unittest.TestCase):
    def _run_probe(self, command, **_kwargs):
        """Dispatch on a per-device plan: (sleep, "ok" | "stall" | "empty")."""
        device = command[-1]
        delay, action = self._plan[device]
        if delay:
            time.sleep(delay)
        if action == "stall":
            raise subprocess.TimeoutExpired(command, 4)
        if action == "empty":
            return Completed(json.dumps({}), 0)
        return Completed(json.dumps({"smart_status": {"passed": True}}), 0)

    def _plan_for(self, device, delay, action):
        self._plan[device] = (delay, action)

    @patch.object(telemetry_agent.shutil, "which", return_value="/usr/sbin/smartctl")
    @patch.object(telemetry_agent.subprocess, "run")
    def test_health_checks_run_concurrently_not_sequentially(self, run, _which):
        """Total wall time must track the slowest single probe, not the sum
        of all probes, and one stalled probe stays isolated."""
        self._plan = {}
        self._plan_for("/dev/sda", 0.0, "ok")
        self._plan_for("/dev/sdb", 0.45, "ok")      # slow probe, succeeds
        self._plan_for("/dev/sdc", 0.45, "stall")   # slow probe, times out
        run.side_effect = self._run_probe
        devices = [{"device": f"/dev/sd{letter}"} for letter in "abc"]

        started = time.monotonic()
        results = telemetry_agent.collect_drive_health(devices)
        elapsed = time.monotonic() - started

        self.assertEqual(results, {
            "/dev/sda": "healthy",
            "/dev/sdb": "healthy",
            "/dev/sdc": "unavailable",  # stall must not raise out of the pool
        })
        # Sequential would take ~0.9s for the two slow probes alone.
        self.assertLess(elapsed, 0.7)

    @patch.object(telemetry_agent.shutil, "which", return_value="/usr/sbin/smartctl")
    @patch.object(telemetry_agent.subprocess, "run")
    def test_empty_smart_payload_is_unavailable_not_failing(self, run, _which):
        """An all-zero/empty SMART body is indeterminate, so it must report
        ``unavailable`` rather than marking the drive healthy or failing."""
        self._plan = {"/dev/sda": (0.0, "empty")}
        run.side_effect = self._run_probe
        results = telemetry_agent.collect_drive_health([{"device": "/dev/sda"}])
        self.assertEqual(results, {"/dev/sda": "unavailable"})

    @patch.object(telemetry_agent.shutil, "which", return_value="/usr/sbin/smartctl")
    @patch.object(telemetry_agent.subprocess, "run")
    def test_many_disks_round_stays_under_dashboard_fetch_timeout(self, run, _which):
        """The full storage_details round must clear the dashboard's four-second
        fetch timeout even when a dozen disks each burn their allowance."""
        self._plan = {}
        letters = "abcdefghijkl"
        for letter in letters:
            self._plan_for(f"/dev/sd{letter}", 1.2, "ok")
        blockdevices = []
        for letter in letters:
            blockdevices.append({
                "name": f"/dev/sd{letter}", "type": "disk", "size": 2_000_000_000_000,
                "model": letter.upper(), "mountpoints": [],
                "children": [{"name": f"/dev/sd{letter}1", "type": "part",
                              "size": 2_000_000_000_000,
                              "mountpoints": ["/"] if letter == letters[0] else []}],
            })

        def fake_run(command, **_kwargs):
            if command[0].endswith("lsblk"):
                return Completed(json.dumps({"blockdevices": blockdevices}), 0)
            return self._run_probe(command, **_kwargs)

        run.side_effect = fake_run
        started = time.monotonic()
        drives = telemetry_agent.storage_details()
        elapsed = time.monotonic() - started

        # One-by-one probing would burn ~14.4s of fake smartctl time across
        # twelve disks; concurrent must settle far inside the dashboard's
        # four-second fetch timeout.
        self.assertLess(elapsed, 4.0)
        self.assertEqual(len(drives), len(letters))
        self.assertTrue(all(d["health"] in ("healthy", "unavailable") for d in drives))
        self.assertFalse(any(d["health"] == "failing" for d in drives))


if __name__ == "__main__":
    unittest.main()
