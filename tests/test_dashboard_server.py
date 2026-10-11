import time
import unittest
from unittest.mock import patch

from deploy import dashboard_server


class AggregateDevicesTests(unittest.TestCase):
    def test_missing_endpoint_reports_offline_without_network(self):
        device = {"id": "ghost", "name": "Ghost", "endpoint": ""}
        result = dashboard_server.fetch_device(device)
        self.assertFalse(result["online"])
        self.assertEqual(result["error"], "Endpoint not configured")
        self.assertEqual(result["usage"], {})
        self.assertEqual(result["specs"], {})

    def test_unconfigured_list_yields_one_offline_card_per_device(self):
        devices = [
            {"id": "a", "name": "A", "endpoint": ""},
            {"id": "b", "name": "B"},
        ]
        results = dashboard_server.aggregate_devices(devices)
        self.assertEqual([r["id"] for r in results], ["a", "b"])  # order preserved
        for result in results:
            self.assertFalse(result["online"])
            self.assertIn("error", result)

    def test_fetches_run_concurrently_not_sequentially(self):
        """Each node is fetched in its own worker; total wall time must stay
        near the slowest fetch, not the sum of all fetches."""
        sleeps = [0.3, 0.3, 0.3]
        calls = []
        def fake_fetch(device):
            index = len(calls)
            time.sleep(sleeps[index])
            calls.append(time.monotonic())
            return {**device, "online": True, "specs": {"cpu": "stub"}, "usage": {"cpu": 1}}

        devices = [{"id": str(i)} for i in range(3)]
        with patch.object(dashboard_server, "fetch_device", side_effect=fake_fetch):
            started = time.monotonic()
            results = dashboard_server.aggregate_devices(devices)
            elapsed = time.monotonic() - started
        self.assertEqual(len(results), 3)
        self.assertTrue(all(r["online"] for r in results))
        # Sequential execution would take ~0.9s; concurrent must land well under that.
        self.assertLess(elapsed, 0.75)
        self.assertGreater(len(calls), 2)  # every device was actually fetched

    def test_single_worker_failure_does_not_take_down_batch(self):
        devices = [{"id": "ok"}, {"id": "boom"}]
        def fake_fetch(device):
            if device["id"] == "boom":
                raise RuntimeError("socket exploded")
            return {**device, "online": True, "specs": {"cpu": "stub"}, "usage": {"cpu": 2}}
        with patch.object(dashboard_server, "fetch_device", side_effect=fake_fetch):
            results = dashboard_server.aggregate_devices(devices)
        by_id = {r["id"]: r for r in results}
        self.assertTrue(by_id["ok"]["online"])
        self.assertFalse(by_id["boom"]["online"])
        self.assertIn("socket exploded", by_id["boom"]["error"])

    def test_aggregate_handles_empty_device_list_without_error(self):
        self.assertEqual(dashboard_server.aggregate_devices([]), [])


class FetchDeviceEndpointTests(unittest.TestCase):
    def test_reachable_agent_endpoint_merges_stats_into_device(self):
        import io
        device = {"id": "node", "name": "Node", "endpoint": "http://node.example"}
        with patch.object(dashboard_server.urllib.request, "urlopen", return_value=io.BytesIO(
            b'{"online": true, "specs": {"cpu": "test"}, "usage": {"cpu": 7}}'
        )) as request:
            result = dashboard_server.fetch_device(device)
        self.assertTrue(result["online"])
        self.assertEqual(result["specs"], {"cpu": "test"})
        self.assertEqual(result["usage"], {"cpu": 7})
        self.assertEqual(result["name"], "Node")
        self.assertEqual(request.call_args.kwargs["timeout"], 4)

    def test_local_endpoint_resolves_to_local_agent(self):
        import io
        with patch.dict("os.environ", {"MISSION_CONTROL_PORT": "4243"}), patch.object(
            dashboard_server.urllib.request, "urlopen", return_value=io.BytesIO(
                b'{"online": true, "specs": {}, "usage": {}}'
            )
        ) as request:
            result = dashboard_server.fetch_device({"id": "local", "endpoint": "local"})
        self.assertTrue(result["online"])
        self.assertEqual(request.call_args.args[0].full_url, "http://127.0.0.1:4243/api/agent/stats")

    def test_unreachable_endpoint_reports_offline_with_reason(self):
        with patch.object(dashboard_server.urllib.request, "urlopen", side_effect=OSError("fixture timeout")):
            result = dashboard_server.fetch_device({"id": "dead", "endpoint": "http://down.example"})
        self.assertFalse(result["online"])
        self.assertTrue(result["error"])
        self.assertEqual(result["usage"], {})


class DashboardHandlerRoutingTests(unittest.TestCase):
    def test_load_devices_handles_missing_file_safely(self):
        from pathlib import Path
        with patch.object(dashboard_server, "DEVICES", Path("/nonexistent/devices.json")):
            self.assertEqual(dashboard_server.load_devices(), [])

    def test_load_devices_handles_malformed_json_safely(self, tmp_path=None):
        import tempfile
        from pathlib import Path
        with tempfile.NamedTemporaryFile("w+", delete=False) as f:
            f.write("{ invalid json")
            f.flush()
            temp_path = Path(f.name)
        try:
            with patch.object(dashboard_server, "DEVICES", temp_path):
                self.assertEqual(dashboard_server.load_devices(), [])
        finally:
            temp_path.unlink(missing_ok=True)

    def test_do_get_query_string_routing(self):
        from unittest.mock import Mock
        handler = object.__new__(dashboard_server.Handler)
        handler.path = "/api/health?cache=123"
        handler.send_json = Mock()
        handler.do_GET()
        handler.send_json.assert_called_once_with({"ok": True})


if __name__ == "__main__":
    unittest.main()
