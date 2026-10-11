from tests import safety  # noqa: F401; deny live I/O in targeted test runs

import os
import subprocess
import time
import unittest
from unittest.mock import patch

from agent import telemetry_agent as agent


class ServiceTests(unittest.TestCase):
    def test_slow_failed_and_not_installed_service_states(self):
        def fixture(command, **kwargs):
            name = command[-1]
            self.assertEqual(command[2], "--property=LoadState,ActiveState,SubState,Description")
            self.assertEqual(command[-2], "--")
            self.assertEqual(kwargs["timeout"], 3)
            if name == "missing.service":
                return subprocess.CompletedProcess(command, 0, "LoadState=not-found")
            if name == "slow.service":
                raise subprocess.TimeoutExpired(command, 3)
            if name == "denied.service":
                return subprocess.CompletedProcess(command, 1, "")
            return subprocess.CompletedProcess(command, 0, "LoadState=loaded\nActiveState=failed\nSubState=failed\nDescription=Fixture Service")
        with patch.dict(os.environ, {"MISSION_CONTROL_SERVICES": "failed.service,missing.service,slow.service,denied.service"}), patch.object(
            agent.subprocess, "run", side_effect=fixture
        ):
            services = agent.monitored_services()
        self.assertEqual([s["id"] for s in services], ["failed.service", "slow.service", "denied.service"])
        self.assertEqual([s["state"] for s in services], ["failed", "unknown", "unknown"])

    def test_duplicate_names_do_not_duplicate_probes(self):
        with patch.dict(os.environ, {"MISSION_CONTROL_SERVICES": "fixture.service, fixture.service,,"}), patch.object(
            agent.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "LoadState=loaded\nActiveState=active\nSubState=running")
        ) as run:
            services = agent.monitored_services()
        self.assertEqual(run.call_count, 1)
        self.assertEqual(services[0]["state"], "active")

    def test_checks_run_concurrently_and_empty_config_does_no_work(self):
        def fixture(command, **_kwargs):
            time.sleep(0.05)
            return subprocess.CompletedProcess(command, 0, "LoadState=loaded\nActiveState=active")
        with patch.dict(os.environ, {"MISSION_CONTROL_SERVICES": "a.service,b.service,c.service"}), patch.object(
            agent.subprocess, "run", side_effect=fixture
        ):
            started = time.monotonic()
            self.assertEqual(len(agent.monitored_services()), 3)
            self.assertLess(time.monotonic() - started, 0.13)
        with patch.dict(os.environ, {"MISSION_CONTROL_SERVICES": ""}), patch.object(agent.subprocess, "run") as run:
            self.assertEqual(agent.monitored_services(), [])
            run.assert_not_called()
