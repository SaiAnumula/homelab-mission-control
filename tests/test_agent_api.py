from tests import safety  # noqa: F401; deny live I/O in targeted test runs

import io
import json
import threading
import time
import unittest
from unittest.mock import Mock, patch

from agent import telemetry_agent as agent


class AgentCacheTests(unittest.TestCase):
    def test_cache_expires_and_caches_failures_without_old_online_data(self):
        cache = agent.StatsCache()
        with patch.object(agent, "stats", return_value={"online": True, "collectedAt": "fixture"}) as stats, patch.object(
            agent.time, "monotonic", return_value=100
        ) as clock:
            self.assertEqual(cache.get()[1], 200)
            cache.get()
            self.assertEqual(stats.call_count, 1)
            clock.return_value = 110
            stats.side_effect = RuntimeError("private fixture")
            payload, status = cache.get()
            self.assertEqual(status, 503)
            self.assertFalse(payload["online"])
            self.assertNotIn("private", payload["error"])
            cache.get()
            self.assertEqual(stats.call_count, 2)
            clock.return_value = 120
            stats.side_effect = None
            self.assertEqual(cache.get()[1], 200)

    def test_multiple_dashboard_clients_share_collection(self):
        cache = agent.StatsCache()
        results = []
        def fixture():
            time.sleep(0.05)
            return {"online": True}
        with patch.object(agent, "stats", side_effect=fixture) as stats:
            workers = [threading.Thread(target=lambda: results.append(cache.get())) for _ in range(8)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=2)
        self.assertEqual(len(results), 8)
        self.assertEqual(stats.call_count, 1)


class AgentApiTests(unittest.TestCase):
    def handler(self, path):
        handler = object.__new__(agent.Handler)
        handler.path = path
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.send_error = Mock()
        handler.wfile = io.BytesIO()
        return handler

    def test_stats_returns_json_with_collection_failure_status(self):
        handler = self.handler("/api/agent/stats?fixture=1")
        with patch.object(agent, "STATS_CACHE") as cache:
            cache.get.return_value = ({"online": False, "error": "Fixture unavailable"}, 503)
            handler.do_GET()
        handler.send_response.assert_called_once_with(503)
        handler.send_header.assert_any_call("Cache-Control", "no-store")
        self.assertFalse(json.loads(handler.wfile.getvalue())["online"])

    def test_unknown_routes_and_health_do_not_collect_hardware(self):
        with patch.object(agent, "STATS_CACHE") as cache:
            handler = self.handler("/api/unknown")
            handler.do_GET()
            handler.send_error.assert_called_once_with(404)
            health = self.handler("/api/health")
            health.do_GET()
            self.assertEqual(json.loads(health.wfile.getvalue()), {"ok": True})
            cache.get.assert_not_called()
