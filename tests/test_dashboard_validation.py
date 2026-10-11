import io
import json
import threading
import time
import unittest
from unittest.mock import Mock, patch

from deploy import dashboard_server as dashboard


DEVICE = {"id": "node", "name": "Fixture Node", "endpoint": "http://node.example"}


class ConfigurationTests(unittest.TestCase):
    def test_rejects_bad_shapes_duplicate_ids_and_credentials(self):
        for value in ({}, [None], [{}], [{**DEVICE, "endpoint": 123}],
                      [DEVICE, DEVICE], [{**DEVICE, "endpoint": "file:///tmp/fixture"}],
                      [{**DEVICE, "endpoint": "https://user:fixture@node.example"}],
                      [{**DEVICE, "endpoint": "http://node.example:invalid"}],
                      [{**DEVICE, "endpoint": "https://node.example?fixture=1"}]):
            with self.subTest(value=value), self.assertRaises(dashboard.ConfigurationError):
                dashboard.validate_devices(value)

    def test_empty_and_missing_endpoint_are_allowed(self):
        self.assertEqual(dashboard.validate_devices([]), [])
        device = {"id": "fixture", "name": "Fixture"}
        self.assertEqual(dashboard.validate_devices([device]), [device])

    def test_api_config_failure_has_error_status(self):
        handler = object.__new__(dashboard.Handler)
        handler.path = "/api/devices?fixture=1"
        handler.send_json = Mock()
        with patch.object(dashboard, "load_devices", side_effect=dashboard.ConfigurationError("Bad fixture")):
            handler.do_GET()
        handler.send_json.assert_called_once_with({"error": "Bad fixture"}, status=503)

    def test_api_returns_cached_payload_without_collecting_again(self):
        handler = object.__new__(dashboard.Handler)
        handler.path = "/api/devices"
        handler.send_json = Mock()
        with patch.object(dashboard, "load_devices", return_value=[DEVICE]), patch.object(
            dashboard, "DEVICE_CACHE"
        ) as cache:
            cache.get.return_value = {"devices": []}
            handler.do_GET()
        cache.get.assert_called_once_with([DEVICE])
        handler.send_json.assert_called_once_with({"devices": []})


class TelemetryValidationTests(unittest.TestCase):
    def fetch(self, payload, device=None):
        with patch.object(dashboard.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(payload).encode())):
            return dashboard.fetch_device(device or DEVICE)

    def test_identity_and_private_config_do_not_leave_backend(self):
        result = self.fetch({"online": True, "id": "spoofed", "name": "Spoofed", "token": "fixture-secret"},
                            {**DEVICE, "token": "fixture-secret"})
        self.assertEqual(result["id"], "node")
        self.assertEqual(result["name"], "Fixture Node")
        self.assertNotIn("token", result)
        self.assertNotIn("endpoint", result)
        self.assertEqual(result["status"], "up")
        self.assertIn("checkedAt", result)

    def test_invalid_agent_responses_report_down(self):
        for payload in ([], None, {}, {"online": "yes"}, {"online": True, "usage": []},
                        {"online": True, "services": [None]}, {"online": True, "os": []}):
            with self.subTest(payload=payload):
                result = self.fetch(payload)
                self.assertFalse(result["online"])
                self.assertEqual(result["status"], "down")
                self.assertIn("Invalid telemetry", result["error"])

    def test_truncated_and_oversized_responses_report_down(self):
        for body in (b'{"online":', b"x" * (dashboard.MAX_RESPONSE_BYTES + 1)):
            with patch.object(dashboard.urllib.request, "urlopen", return_value=io.BytesIO(body)):
                self.assertEqual(dashboard.fetch_device(DEVICE)["status"], "down")

    def test_unhealthy_services_containers_and_drives_are_degraded(self):
        for extra in ({"services": [{"state": "failed"}]},
                      {"services": [{"state": "unknown"}]},
                      {"containers": [{"state": "running", "health": "unhealthy"}]},
                      {"drives": [{"health": "warning"}]}):
            with self.subTest(extra=extra):
                self.assertEqual(self.fetch({"online": True, **extra})["status"], "degraded")
        self.assertEqual(self.fetch({"online": False})["status"], "down")

    def test_json_response_has_error_status_and_no_store(self):
        handler = object.__new__(dashboard.Handler)
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.wfile = io.BytesIO()
        handler.send_json({"error": "fixture"}, status=503)
        handler.send_response.assert_called_once_with(503)
        handler.send_header.assert_any_call("Cache-Control", "no-store")
        self.assertEqual(json.loads(handler.wfile.getvalue()), {"error": "fixture"})


class CacheTests(unittest.TestCase):
    def test_expiry_config_changes_and_failed_checks(self):
        cache = dashboard.DeviceCache()
        with patch.object(dashboard, "aggregate_devices", return_value=[{"status": "down"}]) as fetch, patch.object(
            dashboard.time, "monotonic", return_value=100
        ) as clock:
            first = cache.get([DEVICE])
            self.assertIs(cache.get([DEVICE]), first)
            self.assertEqual(fetch.call_count, 1)
            clock.return_value = 110
            cache.get([DEVICE])
            self.assertEqual(fetch.call_count, 2)
            cache.get([{**DEVICE, "name": "Changed"}])
            self.assertEqual(fetch.call_count, 3)

    def test_concurrent_clients_share_one_fetch(self):
        cache = dashboard.DeviceCache()
        results = []
        def fixture(_devices):
            time.sleep(0.05)
            return [{"online": False}]
        with patch.object(dashboard, "aggregate_devices", side_effect=fixture) as fetch:
            workers = [threading.Thread(target=lambda: results.append(cache.get([DEVICE]))) for _ in range(8)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=2)
            self.assertEqual(len(results), 8)
            self.assertEqual(fetch.call_count, 1)


if __name__ == "__main__":
    unittest.main()
