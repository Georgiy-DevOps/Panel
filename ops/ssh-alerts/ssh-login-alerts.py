#!/usr/bin/env python3
"""Independent SSH login notifications from trusted journald records.

No PAM/sshd hooks: Telegram availability never affects SSH authentication.
Credentials are supplied by systemd LoadCredential, not command-line arguments.
"""

import argparse
import contextlib
import datetime as dt
import hashlib
import ipaddress
import json
import logging
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

LOG = logging.getLogger("ssh-login-alerts")
TRUSTED_EXES = {
    "/usr/sbin/sshd",
    "/usr/lib/openssh/sshd-session",
    "/usr/libexec/openssh/sshd-session",
}
ACCEPTED = re.compile(
    r"^Accepted (?P<method>[A-Za-z0-9@._/+-]+) for (?P<user>\S+) "
    r"from (?P<ip>\S+) port (?P<port>\d+) ssh2(?P<details>.*)$"
)


def login_event(entry, allowed_users):
    if (
        entry.get("_UID") != "0"
        or not isinstance(entry.get("_EXE"), str)
        or entry.get("_EXE") not in TRUSTED_EXES
        or entry.get("_SYSTEMD_UNIT") not in ("ssh.service", "sshd.service")
    ):
        return None
    message = entry.get("MESSAGE")
    match = ACCEPTED.fullmatch(message) if isinstance(message, str) else None
    if not match or match["user"] not in allowed_users:
        return None
    try:
        source = str(ipaddress.ip_address(match["ip"]))
        port = int(match["port"])
        timestamp = int(entry["__REALTIME_TIMESTAMP"])
        cursor = entry["__CURSOR"]
        if not 0 < port < 65536 or not isinstance(cursor, str) or not cursor:
            return None
        dt.datetime.fromtimestamp(timestamp / 1_000_000, dt.timezone.utc)
    except (ValueError, TypeError, KeyError, OverflowError):
        return None
    fingerprint = re.search(r"\bSHA256:[A-Za-z0-9+/=]+", match["details"])
    return dict(
        cursor=cursor,
        timestamp=timestamp,
        user=match["user"],
        source=source,
        port=port,
        method=match["method"],
        fingerprint=fingerprint[0] if fingerprint else None,
    )


def notification(event, config):
    event_id = hashlib.sha256(event["cursor"].encode()).hexdigest()[:16]
    occurred = dt.datetime.fromtimestamp(
        event["timestamp"] / 1_000_000, dt.timezone.utc
    ).astimezone(ZoneInfo(config["timezone"]))
    lines = [
        "🔐 Успешный вход по SSH",
        "Сервер: " + config["server_name"],
        "IP сервера: " + config["server_ip"],
        "Пользователь: " + event["user"],
        "Время: " + occurred.strftime("%d.%m.%Y %H:%M:%S %Z (UTC%z)"),
        "Откуда: " + event["source"],
        "Порт источника: " + str(event["port"]),
        "Способ входа: " + event["method"],
    ]
    if event["fingerprint"]:
        lines.append("Ключ: " + event["fingerprint"])
    lines.append("Событие: " + event_id)
    return "\n".join(lines)


class Store:
    def __init__(self, path):
        self.path = path
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS queue (
                    cursor TEXT PRIMARY KEY, message TEXT NOT NULL, occurred_us INTEGER NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0,
                    delivered_at REAL, message_id INTEGER, last_error TEXT);
            """)

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=FULL")
            with db:
                yield db
        finally:
            db.close()

    def checkpoint(self):
        with self.connect() as db:
            row = db.execute(
                "SELECT value FROM metadata WHERE name='checkpoint'"
            ).fetchone()
        return json.loads(row[0]) if row else None

    def consume(self, entry, message=None):
        cursor, timestamp = entry["__CURSOR"], int(entry["__REALTIME_TIMESTAMP"])
        with self.connect() as db:
            if message is not None:
                db.execute(
                    "INSERT OR IGNORE INTO queue(cursor,message,occurred_us) VALUES(?,?,?)",
                    (cursor, message, timestamp),
                )
            # A durable queue entry and reader cursor advance in the SAME transaction.
            db.execute(
                "INSERT OR REPLACE INTO metadata VALUES('checkpoint',?)",
                (json.dumps(dict(cursor=cursor, timestamp=timestamp)),),
            )

    def next_pending(self):
        with self.connect() as db:
            return db.execute(
                "SELECT cursor,message,attempts,next_attempt FROM queue "
                "WHERE delivered_at IS NULL ORDER BY occurred_us,cursor LIMIT 1"
            ).fetchone()

    def sent(self, cursor, message_id):
        with self.connect() as db:
            db.execute(
                "UPDATE queue SET delivered_at=?,message_id=?,last_error=NULL WHERE cursor=?",
                (time.time(), message_id, cursor),
            )
            db.execute(
                "DELETE FROM queue WHERE delivered_at < ?", (time.time() - 30 * 86400,)
            )

    def failed(self, cursor, reason, delay):
        with self.connect() as db:
            db.execute(
                "UPDATE queue SET attempts=attempts+1,next_attempt=?,last_error=? WHERE cursor=?",
                (time.time() + delay, reason, cursor),
            )


class DeliveryError(Exception):
    def __init__(self, reason, retry_after=None):
        super().__init__(reason)
        self.retry_after = retry_after


class Telegram:
    def __init__(self, credentials):
        token, chat = credentials["token"], credentials["chatId"]
        if not re.fullmatch(r"\d+:[A-Za-z0-9_-]+", token):
            raise ValueError("Invalid Telegram token format")
        if not re.fullmatch(r"-?\d+", str(chat)):
            raise ValueError("Telegram chatId must be numeric")
        self.url = "https://api.telegram.org/bot" + token + "/sendMessage"
        self.chat = chat
        # Never send bot credentials through a proxy inherited from the environment.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def send(self, message):
        payload = json.dumps(
            {"chat_id": self.chat, "text": message, "disable_web_page_preview": True}
        ).encode()
        request = urllib.request.Request(
            self.url, data=payload, headers={"Content-Type": "application/json"}
        )
        try:
            with self.opener.open(request, timeout=15) as response:
                data = json.loads(response.read(65536))
            if data.get("ok") is not True:
                raise DeliveryError("telegram-api-rejected")
            return int(data["result"]["message_id"])
        except urllib.error.HTTPError as error:
            delay = None
            try:
                data = json.loads(error.read(65536))
                value = data.get("parameters", {}).get("retry_after")
                if value is not None:
                    delay = max(1, int(value))
            except (ValueError, TypeError, AttributeError):
                pass
            # HTTPError/URLError strings can contain the URL, INCLUDING THE TOKEN.
            raise DeliveryError("telegram-http-" + str(error.code), delay) from None
        except DeliveryError:
            raise
        except Exception:
            raise DeliveryError("telegram-network-or-response-error") from None


class Collector(threading.Thread):
    def __init__(self, store, config, stop):
        super().__init__(name="ssh-journal-reader", daemon=True)
        self.store, self.config, self.stop = store, config, stop
        self.process = None

    def run(self):
        use_since = False
        while not self.stop.is_set():
            checkpoint = self.store.checkpoint()
            command = [
                "journalctl",
                "--follow",
                "--no-tail",
                "--no-pager",
                "--all",
                "--output=json",
            ]
            if checkpoint["cursor"] and not use_since:
                command.append("--after-cursor=" + checkpoint["cursor"])
            else:
                # Cursor vacuum/rotation recovery: overlap one second, deduplicate by cursor.
                command.append(
                    "--since=@" + str(checkpoint["timestamp"] / 1_000_000 - 1)
                )
            command += ["_SYSTEMD_UNIT=ssh.service", "_SYSTEMD_UNIT=sshd.service"]
            try:
                with tempfile.TemporaryFile() as errors:
                    self.process = subprocess.Popen(
                        command,
                        stdout=subprocess.PIPE,
                        stderr=errors,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                    )
                    if self.stop.is_set():
                        self.process.terminate()
                    for line in self.process.stdout:
                        if self.stop.is_set():
                            break
                        entry = json.loads(line)
                        if (
                            "__CURSOR" not in entry
                            or "__REALTIME_TIMESTAMP" not in entry
                        ):
                            continue
                        event = login_event(entry, self.config["allowed_users"])
                        self.store.consume(
                            entry, notification(event, self.config) if event else None
                        )
                        use_since = False
                    if self.stop.is_set():
                        self.process.terminate()
                    result = self.process.wait(timeout=10)
                    errors.seek(0)
                    diagnostic = errors.read(16384).decode(errors="replace").lower()
                    if result and "cursor" in diagnostic and not use_since:
                        use_since = True
                        LOG.warning(
                            "Journal cursor unavailable; replaying from saved timestamp"
                        )
                    elif not self.stop.is_set():
                        LOG.warning("Journal reader exited, code=%s; retrying", result)
            except Exception as error:
                # Type only: untrusted journal content must not be copied into service logs.
                LOG.error("Journal reader failure: %s", type(error).__name__)
                if self.process and self.process.poll() is None:
                    self.process.terminate()
                    self.process.wait(timeout=10)
            if not self.stop.is_set():
                self.stop.wait(5)

    def close(self):
        self.stop.set()
        if self.process and self.process.poll() is None:
            self.process.terminate()
        self.join(timeout=20)


def initialize(store):
    if store.checkpoint() is not None:
        return
    result = subprocess.run(
        ["journalctl", "-n", "1", "--no-pager", "--output=json"],
        capture_output=True,
        text=True,
        check=True,
        timeout=15,
    )
    rows = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    if rows:
        store.consume(rows[-1])
    else:
        store.consume(
            {"__CURSOR": "", "__REALTIME_TIMESTAMP": int(time.time() * 1_000_000)}
        )
    LOG.info("Initialized at current journal head; historical logins will not be sent")


def run(config, credential_path):
    os.umask(0o077)
    # Validate non-secret configuration before initializing state or sending anything.
    ipaddress.ip_address(config["server_ip"])
    ZoneInfo(config["timezone"])
    if config.get("allowed_users") != ["root"]:
        raise ValueError("This deployment is restricted to root SSH logins")
    if not 1 <= len(config["server_name"]) <= 120:
        raise ValueError("Invalid server name")
    directory = Path(config["state_directory"])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    store = Store(directory / "state.sqlite")
    telegram = Telegram(json.loads(Path(credential_path).read_text()))
    initialize(store)
    stop = threading.Event()
    collector = Collector(store, config, stop)
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stop.set())
    collector.start()
    LOG.info("Watching successful SSH authentications for root")
    try:
        while not stop.is_set():
            if not collector.is_alive():
                raise RuntimeError("Journal collector stopped")
            row = store.next_pending()
            if not row or row[3] > time.time():
                stop.wait(1)
                continue
            cursor, message, attempts, _ = row
            try:
                message_id = telegram.send(message)
                store.sent(cursor, message_id)
                LOG.info(
                    "Delivered event %s",
                    hashlib.sha256(cursor.encode()).hexdigest()[:16],
                )
                stop.wait(1.2)
            except DeliveryError as error:
                delay = error.retry_after or min(300, 5 * 2 ** min(attempts, 6))
                store.failed(cursor, str(error), delay)
                LOG.warning("Delivery pending: %s; retry in %ss", error, delay)
    finally:
        collector.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/fleet-ssh-alerts/config.json")
    parser.add_argument(
        "--credentials",
        default=str(
            Path(os.environ.get("CREDENTIALS_DIRECTORY", "/etc/fleet-ssh-alerts"))
            / "telegram.json"
        ),
    )
    args = parser.parse_args()
    try:
        run(json.loads(Path(args.config).read_text()), args.credentials)
    except Exception as error:
        LOG.error("Notifier stopped: %s", type(error).__name__)
        raise SystemExit(1)
