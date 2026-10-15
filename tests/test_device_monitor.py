from tests import safety  # noqa: F401; no live monitoring

import io
import threading
import unittest
from unittest.mock import Mock, patch

from deploy import dashboard_server as dashboard


DEVICE = {"id": "pc", "name": "PC", "endpoint": "http://pc.example"}


class ManualPool:
    def __init__(self):
        self.jobs = []

    def submit(self, fn, *args):
        self.jobs.append((fn, args))

    def finish(self):
        jobs, self.jobs = self.jobs, []
        for fn, args in jobs:
            fn(*args)


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.clock = 0
        self.fetch = Mock(return_value={"online": True, "status": "up", "usage": {"cpu": 7},
                                       "checkedAt": "2026-10-15T16:00:00+00:00"})
        self.health = Mock(return_value=False)
        self.monitor = dashboard.DeviceMonitor(fetch=self.fetch, health=self.health, now=lambda: self.clock)
        self.pool = self.monitor._pool = ManualPool()
        self.monitor.get([DEVICE])

    def snapshot(self, devices=None):
        return self.monitor.get(devices or [DEVICE])["devices"][0]

    def check(self, at):
        self.clock = at
        self.monitor.run_due()
        self.pool.finish()

    def test_initial_check_is_background_and_shared_by_clients(self):
        self.assertEqual(self.snapshot()["status"], "stale")
        self.fetch.assert_not_called()
        self.monitor.run_due()
        for _ in range(20):
            self.snapshot()
            self.monitor.run_due()
        self.assertEqual(len(self.pool.jobs), 1)
        self.pool.finish()
        self.assertEqual(self.snapshot()["status"], "up")
        self.fetch.assert_called_once()
        self.check(9.999)
        self.fetch.assert_called_once()
        self.check(10)
        self.assertEqual(self.fetch.call_count, 2)

    def test_running_scheduler_does_not_block_snapshot_reads_and_closes_cleanly(self):
        started, release = threading.Event(), threading.Event()
        def collect(_device):
            started.set()
            release.wait(timeout=2)
            return {"online": True, "status": "up"}
        self.fetch.side_effect = collect
        self.monitor.start()
        try:
            self.assertTrue(started.wait(timeout=1))
            self.assertEqual(self.snapshot()["status"], "stale")
        finally:
            release.set()
            self.monitor.close()
        self.assertEqual(self.snapshot()["status"], "up")
        self.assertFalse(self.monitor._thread.is_alive())

    def test_one_second_recovery_preserves_readings_and_resumes_telemetry(self):
        self.check(0)
        self.fetch.return_value = {"online": False}
        self.check(10)
        failed = self.snapshot()
        self.assertEqual(failed["status"], "stale")
        self.assertEqual(failed["usage"], {"cpu": 7})
        self.assertEqual(failed["lastGoodAt"], "2026-10-15T16:00:00+00:00")
        self.check(10.999)
        self.health.assert_not_called()
        self.health.return_value = True
        self.fetch.return_value = {"online": True, "status": "up", "usage": {"cpu": 9}}
        self.check(11)
        self.health.assert_called_once()
        self.assertEqual(self.snapshot()["usage"], {"cpu": 9})
        self.assertEqual(self.snapshot()["status"], "up")

    def test_down_at_exactly_ten_seconds_then_fifteen_second_checks(self):
        self.fetch.side_effect = OSError("private endpoint")
        self.check(0)
        for second in range(1, 10):
            self.check(second)
        self.clock = 9.999
        self.assertEqual(self.snapshot()["status"], "stale")
        self.clock = 10
        self.assertEqual(self.snapshot()["status"], "down")
        self.monitor.run_due()
        self.pool.finish()
        self.assertEqual(self.health.call_count, 10)
        self.check(24.999)
        self.assertEqual(self.health.call_count, 10)
        self.health.return_value = True
        self.fetch.side_effect = None
        self.check(25)
        self.assertEqual(self.snapshot()["status"], "up")
        self.assertNotIn("private", str(self.snapshot()))

    def test_healthy_connection_with_slow_metrics_remains_stale(self):
        self.fetch.return_value = {"online": False}
        self.check(0)
        self.health.return_value = True
        for second in range(1, 13):
            self.check(second)
        self.assertEqual(self.snapshot()["status"], "stale")
        self.assertIn("responds to health", self.snapshot()["error"])

    def test_down_does_not_clear_last_readings(self):
        self.check(0)
        self.fetch.return_value = {"online": False}
        self.check(10)
        self.check(20)
        self.assertEqual(self.snapshot()["status"], "down")
        self.assertFalse(self.snapshot()["online"])
        self.assertEqual(self.snapshot()["usage"], {"cpu": 7})

    def test_worker_limit_and_no_overlapping_checks_during_config_changes(self):
        devices = [{**DEVICE, "id": str(i)} for i in range(12)]
        self.monitor.get(devices)
        self.monitor.run_due()
        self.assertEqual(len(self.pool.jobs), 8)
        self.monitor.get([{**d, "name": "Renamed"} for d in devices])
        self.monitor.run_due()
        self.assertEqual(len(self.pool.jobs), 8)
        self.pool.finish()
        self.monitor.run_due()
        self.assertEqual(len(self.pool.jobs), 4)
        self.pool.finish()
        self.assertEqual(self.fetch.call_count, 12)

    def test_endpoint_change_ignores_old_result_and_keeps_global_worker_limit(self):
        self.monitor.run_due()
        replacement = {**DEVICE, "endpoint": "http://replacement.example", "name": "New PC"}
        self.monitor.get([replacement])
        self.pool.finish()
        self.assertEqual(self.snapshot([replacement])["status"], "stale")
        self.check(0)
        result = self.snapshot([replacement])
        self.assertEqual(result["status"], "up")
        self.assertEqual(result["name"], "New PC")
        self.assertNotIn("endpoint", result)

    def test_replaced_endpoints_cannot_exceed_worker_capacity(self):
        devices = [{**DEVICE, "id": str(i)} for i in range(8)]
        self.monitor.get(devices)
        self.monitor.run_due()
        replacement = [{**d, "endpoint": "http://replacement.example"} for d in devices]
        self.monitor.get(replacement)
        self.monitor.run_due()
        self.assertEqual(len(self.pool.jobs), 8)
        self.pool.finish()
        self.monitor.run_due()
        self.assertEqual(len(self.pool.jobs), 8)
        self.pool.finish()
        self.assertTrue(all(d["status"] == "up" for d in self.monitor.get(replacement)["devices"]))

    def test_health_exception_does_not_poison_future_checks(self):
        self.fetch.return_value = {"online": False}
        self.check(0)
        self.health.side_effect = RuntimeError("private endpoint")
        self.check(1)
        self.assertNotIn("private", str(self.snapshot()))
        self.health.side_effect = None
        self.health.return_value = True
        self.fetch.return_value = {"online": True, "status": "up"}
        self.check(2)
        self.assertEqual(self.snapshot()["status"], "up")

    def test_unexpected_state_update_error_releases_worker_for_retry(self):
        with patch.object(dashboard, "datetime") as date:
            date.now.side_effect = RuntimeError("fixture formatting error")
            self.check(0)
        self.assertEqual(self.snapshot()["status"], "stale")
        self.assertEqual(self.monitor._active, 0)
        self.health.return_value = True
        self.check(1)
        self.assertEqual(self.snapshot()["status"], "up")

    def test_scheduler_start_is_idempotent_and_can_restart_after_close(self):
        self.monitor.start()
        thread = self.monitor._thread
        try:
            self.monitor.start()
            self.assertIs(self.monitor._thread, thread)
        finally:
            self.monitor.close()
        self.assertIsNone(self.monitor._pool)
        self.monitor.start()
        try:
            self.assertIsNot(self.monitor._thread, thread)
            self.assertTrue(self.monitor._thread.is_alive())
        finally:
            self.monitor.close()

    def test_removed_devices_stop_scheduling_and_empty_configuration_works(self):
        self.assertEqual(self.monitor.get([])["devices"], [])
        self.check(0)
        self.fetch.assert_not_called()


class HealthTests(unittest.TestCase):
    def test_redirects_never_contact_the_redirect_target(self):
        from email.message import Message
        for health_check in (False, True):
            response = io.BytesIO(b"")
            response.code, response.msg = 302, "Found"
            headers = Message()
            headers["Location"] = "http://unexpected.example/private"
            response.info = lambda: headers
            with self.subTest(health=health_check), patch.object(
                dashboard.urllib.request.HTTPHandler, "http_open", return_value=response
            ) as transport:
                if health_check:
                    self.assertFalse(dashboard.check_health(DEVICE))
                else:
                    self.assertEqual(dashboard.fetch_device(DEVICE)["status"], "down")
                transport.assert_called_once()

    def test_health_has_short_timeout_and_validates_payload(self):
        for body, expected in [(b'{"ok": true}', True), (b'{"ok": false}', False),
                               (b'[]', False), (b'broken', False), (b'x' * 16385, False)]:
            with self.subTest(body=body[:20]), patch.object(
                dashboard, "open_endpoint", return_value=io.BytesIO(body)
            ) as request:
                self.assertEqual(dashboard.check_health(DEVICE), expected)
                self.assertEqual(request.call_args.kwargs["timeout"], 1)
                self.assertEqual(request.call_args.args[0], "http://pc.example/api/health")

    def test_network_errors_and_local_endpoint(self):
        with patch.object(dashboard, "open_endpoint", side_effect=OSError):
            self.assertFalse(dashboard.check_health(DEVICE))
        with patch.dict("os.environ", {"MISSION_CONTROL_PORT": "4243"}), patch.object(
            dashboard, "open_endpoint", return_value=io.BytesIO(b'{"ok": true}')
        ) as request:
            self.assertTrue(dashboard.check_health({"endpoint": "local"}))
            self.assertEqual(request.call_args.args[0], "http://127.0.0.1:4243/api/health")


if __name__ == "__main__":
    unittest.main()
