import json
import os
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


if __name__ == "__main__":
    unittest.main()
