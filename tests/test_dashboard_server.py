import threading
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
    """Exercise fetch_device against real (local) sockets where the behavior
    depends on the wire, not on injected stubs."""

    def setUp(self):
        import http.server
        import socket

        class AgentHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/api/agent/stats":
                    body = b'{"online": true, "specs": {"cpu": "test"}, "usage": {"cpu": 7}}'
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.send_error(404)

            def log_message(self, fmt, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), AgentHandler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

        # A port that is free: bind, then release.
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.bind(("127.0.0.1", 0))
        self.dead_port = probe.getsockname()[1]
        probe.close()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def test_reachable_agent_endpoint_merges_stats_into_device(self):
        device = {"id": "node", "name": "Node", "endpoint": f"http://127.0.0.1:{self.port}/"}
        result = dashboard_server.fetch_device(device)
        self.assertTrue(result["online"])
        self.assertEqual(result["specs"], {"cpu": "test"})
        self.assertEqual(result["usage"], {"cpu": 7})
        self.assertEqual(result["name"], "Node")

    def test_unreachable_endpoint_reports_offline_with_reason(self):
        device = {"id": "dead", "name": "Dead", "endpoint": f"http://127.0.0.1:{self.dead_port}"}
        result = dashboard_server.fetch_device(device)
        self.assertFalse(result["online"])
        self.assertTrue(result["error"])
        self.assertEqual(result["usage"], {})


if __name__ == "__main__":
    unittest.main()
