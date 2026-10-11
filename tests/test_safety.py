"""Fail closed: the entire unittest run uses fixtures, never live services."""

import socket
import subprocess
import unittest
from unittest.mock import patch


def blocked(*_args, **_kwargs):
    raise AssertionError("Live network/process access is forbidden in tests; mock it")


# Discovery imports this module before running tests. Intentional command tests
# patch subprocess.run with their own fixture on top of these process-wide guards.
_guards = [
    patch.object(socket.socket, "connect", blocked),
    patch.object(socket.socket, "connect_ex", blocked),
    patch.object(socket.socket, "bind", blocked),
    patch.object(socket, "getaddrinfo", blocked),
    patch.object(subprocess, "Popen", blocked),
]
for _guard in _guards:
    _guard.start()


class SafetyTests(unittest.TestCase):
    def test_outgoing_network_is_blocked(self):
        with socket.socket() as connection:
            with self.assertRaises(AssertionError):
                connection.connect(("monitor.example", 80))

    def test_process_execution_is_blocked(self):
        with self.assertRaises(AssertionError):
            subprocess.run(["fixture-command"], check=True)
