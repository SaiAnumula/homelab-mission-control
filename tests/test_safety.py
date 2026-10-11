"""Fail closed: the entire unittest run uses fixtures, never live services."""

import socket
import subprocess
import unittest
from unittest.mock import patch


from tests import safety  # noqa: F401; fail closed for targeted runs too


class SafetyTests(unittest.TestCase):
    def test_outgoing_network_is_blocked(self):
        with socket.socket() as connection:
            with self.assertRaises(AssertionError):
                connection.connect(("monitor.example", 80))

    def test_process_execution_is_blocked(self):
        with self.assertRaises(AssertionError):
            subprocess.run(["fixture-command"], check=True)
