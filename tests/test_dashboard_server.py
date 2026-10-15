from tests import safety  # noqa: F401; deny live I/O in targeted test runs

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



class FetchDeviceEndpointTests(unittest.TestCase):
    def test_reachable_agent_endpoint_merges_stats_into_device(self):
        import io
        device = {"id": "node", "name": "Node", "endpoint": "http://node.example"}
        with patch.object(dashboard_server, "open_endpoint", return_value=io.BytesIO(
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
            dashboard_server, "open_endpoint", return_value=io.BytesIO(
                b'{"online": true, "specs": {}, "usage": {}}'
            )
        ) as request:
            result = dashboard_server.fetch_device({"id": "local", "endpoint": "local"})
        self.assertTrue(result["online"])
        self.assertEqual(request.call_args.args[0].full_url, "http://127.0.0.1:4243/api/agent/stats")

    def test_unreachable_endpoint_reports_offline_with_reason(self):
        with patch.object(dashboard_server, "open_endpoint", side_effect=OSError("fixture timeout")):
            result = dashboard_server.fetch_device({"id": "dead", "endpoint": "http://down.example"})
        self.assertFalse(result["online"])
        self.assertTrue(result["error"])
        self.assertEqual(result["usage"], {})


class DashboardHandlerRoutingTests(unittest.TestCase):
    def test_load_devices_handles_missing_file_safely(self):
        from pathlib import Path
        with patch.object(dashboard_server, "DEVICES", Path("/nonexistent/devices.json")):
            with self.assertRaises(dashboard_server.ConfigurationError):
                dashboard_server.load_devices()

    def test_load_devices_handles_malformed_json_safely(self, tmp_path=None):
        import tempfile
        from pathlib import Path
        with tempfile.NamedTemporaryFile("w+", delete=False) as f:
            f.write("{ invalid json")
            f.flush()
            temp_path = Path(f.name)
        try:
            with patch.object(dashboard_server, "DEVICES", temp_path):
                with self.assertRaises(dashboard_server.ConfigurationError):
                    dashboard_server.load_devices()
        finally:
            temp_path.unlink(missing_ok=True)

    def test_do_get_query_string_routing(self):
        from unittest.mock import Mock
        handler = object.__new__(dashboard_server.Handler)
        handler.path = "/api/health?cache=123"
        handler.send_json = Mock()
        handler.do_GET()
        handler.send_json.assert_called_once_with({"ok": True})

    def test_unknown_api_route_is_json_404_instead_of_spa_html(self):
        from unittest.mock import Mock
        handler = object.__new__(dashboard_server.Handler)
        handler.path = "/api/missing?fixture=1"
        handler.send_json = Mock()
        handler.do_GET()
        handler.send_json.assert_called_once_with({"error": "Not found"}, status=404)


if __name__ == "__main__":
    unittest.main()
