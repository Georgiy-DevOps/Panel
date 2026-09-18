import importlib.util
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location(
    "alerts", Path(__file__).with_name("ssh-login-alerts.py")
)
alerts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alerts)

CONFIG = dict(
    server_name="Сервер 1",
    server_ip="192.0.2.10",
    timezone="Europe/Moscow",
    allowed_users=["root"],
)


def record(
    message="Accepted publickey for root from 198.51.100.4 port 40123 ssh2: ED25519 SHA256:example",
    cursor="cursor-a",
    timestamp=1789740000000000,
):
    return dict(
        _UID="0",
        _EXE="/usr/lib/openssh/sshd-session",
        _SYSTEMD_UNIT="ssh.service",
        MESSAGE=message,
        __CURSOR=cursor,
        __REALTIME_TIMESTAMP=str(timestamp),
    )


class ParserTest(unittest.TestCase):
    def test_successful_root_with_ipv4_and_key(self):
        event = alerts.login_event(record(), ["root"])
        self.assertEqual(event["source"], "198.51.100.4")
        self.assertEqual(event["fingerprint"], "SHA256:example")
        message = alerts.notification(event, CONFIG)
        self.assertIn("IP сервера: 192.0.2.10", message)
        self.assertIn("Откуда: 198.51.100.4", message)
        self.assertIn("UTC+0300", message)
        self.assertIn("Пользователь: root", message)

    def test_ipv6_and_password(self):
        event = alerts.login_event(
            record("Accepted password for root from 2001:db8::2 port 30000 ssh2"),
            ["root"],
        )
        self.assertEqual(event["source"], "2001:db8::2")
        self.assertIsNone(event["fingerprint"])
        self.assertEqual(event["method"], "password")

    def test_failed_logins_prechecks_and_service_users_are_not_alerted(self):
        messages = [
            "Failed password for root from 198.51.100.4 port 40123 ssh2",
            "Accepted key ED25519 SHA256:example found at /root/.ssh/authorized_keys:1",
            "Accepted publickey for beszel-tunnel from 198.51.100.4 port 40123 ssh2",
            "Accepted publickey for fleet-backup from 198.51.100.4 port 40123 ssh2",
            "Accepted publickey for root from not-an-ip port 40123 ssh2",
            "Accepted publickey for root from 198.51.100.4 port 999999 ssh2",
        ]
        for message in messages:
            with self.subTest(message=message):
                self.assertIsNone(alerts.login_event(record(message), ["root"]))

    def test_spoofed_syslog_message_is_rejected(self):
        for changes in (
            {"_UID": "1000"},
            {"_EXE": "/usr/bin/logger"},
            {"_SYSTEMD_UNIT": "fake.service"},
            {"_EXE": ["bad"]},
            {"MESSAGE": [1, 2]},
        ):
            self.assertIsNone(alerts.login_event(record() | changes, ["root"]))


class QueueTest(unittest.TestCase):
    def test_checkpoint_queue_and_delivery_survive_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "queue.sqlite"
            store = alerts.Store(path)
            entry = record()
            message = alerts.notification(alerts.login_event(entry, ["root"]), CONFIG)
            store.consume(entry, message)
            store = alerts.Store(path)
            self.assertEqual(store.checkpoint()["cursor"], "cursor-a")
            self.assertEqual(store.next_pending()[1], message)
            store.consume(
                entry, message
            )  # journal overlap must not enqueue a second copy
            with store.connect() as db:
                self.assertEqual(
                    db.execute("SELECT count(*) FROM queue").fetchone()[0], 1
                )
            store.failed("cursor-a", "telegram-http-429", 45)
            row = alerts.Store(path).next_pending()
            self.assertEqual(row[2], 1)
            self.assertGreater(row[3], time.time() + 40)
            store.sent("cursor-a", 123)
            self.assertIsNone(alerts.Store(path).next_pending())
            store.consume(entry, message)
            self.assertIsNone(store.next_pending())

    def test_ignored_records_advance_cursor_without_notification(self):
        with tempfile.TemporaryDirectory() as directory:
            store = alerts.Store(Path(directory) / "queue.sqlite")
            store.consume(
                record(
                    "Accepted publickey for fleet-backup from 192.0.2.1 port 10000 ssh2"
                )
            )
            self.assertEqual(store.checkpoint()["cursor"], "cursor-a")
            self.assertIsNone(store.next_pending())


class TelegramTest(unittest.TestCase):
    def setUp(self):
        self.token = "123456:THIS_IS_A_FAKE_TEST_TOKEN"
        self.client = alerts.Telegram({"token": self.token, "chatId": 12345})

    def test_server_acknowledgment_and_plain_text_payload(self):
        response = io.BytesIO(
            json.dumps({"ok": True, "result": {"message_id": 81}}).encode()
        )
        with patch.object(self.client.opener, "open", return_value=response) as send:
            self.assertEqual(self.client.send("тест <tag>"), 81)
        body = json.loads(send.call_args.args[0].data)
        self.assertEqual(body["text"], "тест <tag>")
        self.assertNotIn("parse_mode", body)

    def test_rate_limit_preserves_retry_after_without_exposing_token(self):
        error = urllib.error.HTTPError(
            self.client.url,
            429,
            "Too many requests",
            {},
            io.BytesIO(b'{"parameters":{"retry_after":42}}'),
        )
        with patch.object(self.client.opener, "open", side_effect=error):
            with self.assertRaises(alerts.DeliveryError) as caught:
                self.client.send("message")
        self.assertEqual(caught.exception.retry_after, 42)
        self.assertEqual(str(caught.exception), "telegram-http-429")
        self.assertNotIn(self.token, str(caught.exception))

    def test_network_error_and_invalid_response_do_not_acknowledge_or_leak_token(self):
        with patch.object(
            self.client.opener,
            "open",
            side_effect=urllib.error.URLError(self.client.url),
        ):
            with self.assertRaises(alerts.DeliveryError) as caught:
                self.client.send("message")
        self.assertNotIn(self.token, str(caught.exception))
        with patch.object(
            self.client.opener, "open", return_value=io.BytesIO(b'{"ok":true}')
        ):
            with self.assertRaises(alerts.DeliveryError):
                self.client.send("message")


if __name__ == "__main__":
    unittest.main()
