from tests import safety  # noqa: F401; deny live I/O in targeted test runs

import io
import socket
import unittest
from urllib.error import URLError
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
    def test_transient_timeout_preserves_degraded_status(self):
        device = {"id": "node", "name": "Node", "endpoint": "http://node.example"}
        payload = b'{"online":true,"services":[{"name":"Fixture","state":"inactive"}]}'
        for error in (
            TimeoutError("private endpoint"),
            socket.timeout("private endpoint"),
            URLError(TimeoutError("private endpoint")),
            URLError(socket.timeout("private endpoint")),
        ):
            with self.subTest(error=type(error)):
                with patch.object(
                    dashboard_server, "open_endpoint", side_effect=[error, io.BytesIO(payload)],
                ) as request, self.assertLogs(dashboard_server.LOGGER, level="WARNING") as logs:
                    result = dashboard_server.fetch_device(device)
                self.assertEqual(result["status"], "degraded")
                self.assertEqual([call.kwargs["timeout"] for call in request.call_args_list], [4, 3])
                self.assertNotIn("private endpoint", str(logs.output))

    def test_persistent_timeout_only_retries_once(self):
        device = {"id": "node", "name": "Node", "endpoint": "http://node.example"}
        with patch.object(dashboard_server, "open_endpoint", side_effect=TimeoutError) as request, \
                self.assertLogs(dashboard_server.LOGGER, level="WARNING"):
            result = dashboard_server.fetch_device(device)
        self.assertFalse(result["online"])
        self.assertEqual(request.call_count, 2)

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

    def test_spa_traversal_path_rewrites_to_index_html(self):
        handler = object.__new__(dashboard_server.Handler)
        handler.path = "/../etc/passwd"
        with patch.object(dashboard_server.SimpleHTTPRequestHandler, "do_GET", return_value=None) as super_get:
            handler.do_GET()
        self.assertEqual(handler.path, "/index.html")
        super_get.assert_called_once()

    def test_asset_traversal_path_returns_404(self):
        from unittest.mock import Mock
        handler = object.__new__(dashboard_server.Handler)
        handler.path = "/assets/../../etc/passwd"
        handler.send_error = Mock()
        with patch.object(dashboard_server.SimpleHTTPRequestHandler, "do_GET", return_value=None) as super_get:
            handler.do_GET()
        handler.send_error.assert_called_once_with(404)
        super_get.assert_not_called()

    def test_legitimate_asset_is_served_and_symlink_escapes_are_blocked(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            dist = tmp_root / "dist"
            assets = dist / "assets"
            assets.mkdir(parents=True)
            (assets / "app.js").write_text("console.log('ok');")
            outside = tmp_root / "secret.txt"
            outside.write_text("secret")
            (assets / "escape.js").symlink_to(outside)
            (dist / "escape.html").symlink_to(outside)

            with patch.object(dashboard_server, "DIST", dist):
                # Legitimate asset passes through unchanged
                ok_handler = object.__new__(dashboard_server.Handler)
                ok_handler.path = "/assets/app.js"
                ok_handler.send_error = Mock()
                with patch.object(dashboard_server.SimpleHTTPRequestHandler, "do_GET", return_value=None) as super_get:
                    ok_handler.do_GET()
                self.assertEqual(ok_handler.path, "/assets/app.js")
                ok_handler.send_error.assert_not_called()
                super_get.assert_called_once()

                # Asset symlink escaping DIST returns 404
                asset_esc = object.__new__(dashboard_server.Handler)
                asset_esc.path = "/assets/escape.js"
                asset_esc.send_error = Mock()
                with patch.object(dashboard_server.SimpleHTTPRequestHandler, "do_GET", return_value=None) as super_get:
                    asset_esc.do_GET()
                asset_esc.send_error.assert_called_once_with(404)
                super_get.assert_not_called()

                # Non-asset symlink escaping DIST rewrites to /index.html
                root_esc = object.__new__(dashboard_server.Handler)
                root_esc.path = "/escape.html"
                with patch.object(dashboard_server.SimpleHTTPRequestHandler, "do_GET", return_value=None) as super_get:
                    root_esc.do_GET()
                self.assertEqual(root_esc.path, "/index.html")
                super_get.assert_called_once()


if __name__ == "__main__":
    unittest.main()
