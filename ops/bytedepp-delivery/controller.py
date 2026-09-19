#!/usr/bin/python3
"""Owner-approved, immutable ByteDepp server-file delivery; no GitHub credentials."""

import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.request

ROOT = Path("/var/lib/bytedepp-delivery")
LIB = Path("/usr/local/lib/bytedepp-delivery")
LIVE = Path("/srv/bytedepp/server/bytedepp_server.py")
SOURCE = Path("/srv/bytedepp-development/server/bytedepp_server.py")
LIVE_DB = Path("/srv/bytedepp/bytedepp.sqlite3")
MAX_SOURCE = 2 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


@contextlib.contextmanager
def database():
    db = sqlite3.connect(ROOT / "state.sqlite", timeout=15)
    db.row_factory = sqlite3.Row
    try:
        with db:
            yield db
    finally:
        db.close()


def init():
    ROOT.mkdir(mode=0o700, exist_ok=True)
    with database() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS releases(
          id TEXT PRIMARY KEY,sha TEXT NOT NULL,base_sha TEXT NOT NULL,
          created REAL NOT NULL,status TEXT NOT NULL,message_id INTEGER,
          approved REAL,error TEXT);
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT);
        """)


def read_source(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as file:
        before = os.fstat(file.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_SOURCE:
            raise ValueError(
                "Only a regular Python source file up to 2 MiB is accepted"
            )
        data = file.read(MAX_SOURCE + 1)
        after = os.fstat(file.fileno())
    if len(data) > MAX_SOURCE or (before.st_size, before.st_mtime_ns) != (
        after.st_size,
        after.st_mtime_ns,
    ):
        raise ValueError("Source changed during submission; retry after saving")
    data.decode("utf-8")
    return data


def submit():
    if (SOURCE.parent.parent / ".bundle-mode").exists():
        import bundle_delivery

        return bundle_delivery.submit(sys.modules[__name__])
    data = read_source(SOURCE)
    source_hash = digest(data)
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT count(*) FROM releases").fetchone()[0] >= 100:
            raise ValueError(
                "Release archive limit reached; administrator cleanup required"
            )
        if db.execute(
            "SELECT 1 FROM releases WHERE status IN ('queued','testing','deploying')"
        ).fetchone():
            raise ValueError("Another release is being processed")
        if db.execute(
            "SELECT 1 FROM releases WHERE created>?", (time.time() - 60,)
        ).fetchone():
            raise ValueError("Wait one minute before submitting again")
        if db.execute(
            "SELECT 1 FROM releases WHERE sha=? AND status IN ('pending','notifying')",
            (source_hash,),
        ).fetchone():
            raise ValueError("This exact version already awaits approval")
        rid = secrets.token_hex(16)
        folder = ROOT / rid
        folder.mkdir(mode=0o755)
        folder.chmod(0o755)
        (folder / "bytedepp_server.py").write_bytes(data)
        (folder / "bytedepp_server.py").chmod(0o444)
        db.execute(
            "UPDATE releases SET status='superseded' WHERE status IN ('pending','notifying')"
        )
        db.execute(
            "INSERT INTO releases(id,sha,base_sha,created,status) VALUES(?,?,?,?,?)",
            (rid, source_hash, digest(LIVE.read_bytes()), time.time(), "queued"),
        )
    print("Submitted:", rid, "SHA256:", source_hash)
    print("Production unchanged. Tests run automatically; owner approval is required.")


def status():
    with database() as db:
        rows = db.execute(
            "SELECT id,sha,status,error FROM releases ORDER BY created DESC LIMIT 5"
        ).fetchall()
    for row in rows:
        print(dict(row))


def command(args, timeout=120):
    # Untrusted application output must never enter Telegram, journals or root logs.
    result = subprocess.run(
        args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout
    )
    if result.returncode:
        raise RuntimeError("Controlled check failed: " + Path(args[0]).name)


def config():
    return json.loads(Path("/etc/bytedepp-delivery/config.json").read_text())


def sandbox(rid, mode, db_dir=None):
    name = "bytedepp-check-" + rid
    folder = ROOT / rid
    args = [
        "docker",
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        "--user",
        "10001:10001",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--memory=256m",
        "--memory-swap=256m",
        "--cpus=0.5",
        "--pids-limit=48",
        "--log-driver=none",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
        "--mount",
        f"type=bind,src={folder},dst=/candidate,readonly",
        "--mount",
        f"type=bind,src={LIB}/checks,dst=/checks,readonly",
    ]
    if db_dir:
        args += ["--mount", f"type=bind,src={db_dir},dst=/data"]
    args += [config()["image"], "python3", "-B", "/checks/check.py", mode]
    try:
        command(args, timeout=600)
    finally:
        subprocess.run(
            ["docker", "rm", "-f", name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def snapshot(source, destination):
    with contextlib.closing(
        sqlite3.connect("file:" + str(source) + "?mode=ro", uri=True)
    ) as src:
        with contextlib.closing(sqlite3.connect(destination)) as dst:
            src.backup(dst)
            if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("Database snapshot integrity check failed")


def db_fingerprint(path):
    with contextlib.closing(
        sqlite3.connect("file:" + str(path) + "?mode=ro", uri=True)
    ) as db:
        return digest("\n".join(db.iterdump()).encode())


def schema_only(source, destination):
    """Copy DDL only: no production records or credentials enter test containers."""
    with contextlib.closing(
        sqlite3.connect("file:" + str(source) + "?mode=ro", uri=True)
    ) as src:
        statements = src.execute(
            "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name"
        ).fetchall()
    with contextlib.closing(sqlite3.connect(destination)) as target:
        for (statement,) in statements:
            target.execute(statement)
        target.commit()


class Telegram:
    def __init__(self):
        credentials = json.loads(
            Path("/etc/fleet-ssh-alerts/telegram.json").read_text()
        )
        self.chat = int(credentials["chatId"])
        if self.chat <= 0:
            raise ValueError("A private owner chat is required")
        self.token = credentials["token"]
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, method, payload):
        req = urllib.request.Request(
            "https://api.telegram.org/bot" + self.token + "/" + method,
            json.dumps(payload).encode(),
            {"Content-Type": "application/json"},
        )
        try:
            with self.opener.open(req, timeout=20) as response:
                result = json.load(response)
            if not result.get("ok"):
                raise ValueError("API rejected request")
            return result["result"]
        except Exception:
            raise RuntimeError("Telegram unavailable") from None

    def send(self, text, buttons=None):
        body = {"chat_id": self.chat, "text": text}
        if buttons:
            body["reply_markup"] = {"inline_keyboard": [buttons]}
        return self.call("sendMessage", body)["message_id"]


def set_status(rid, state, error=None):
    with database() as db:
        db.execute(
            "UPDATE releases SET status=?,error=? WHERE id=?", (state, error, rid)
        )


def authenticate_callback(query, owner, row, now):
    message = query.get("message", {})
    return bool(
        row
        and row["status"] == "pending"
        and now - row["created"] <= 86400
        and query.get("from", {}).get("id") == owner
        and message.get("chat", {}).get("id") == owner
        and message.get("message_id") == row["message_id"]
    )


def health():
    for _ in range(20):
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:8787/health", timeout=2
            ) as response:
                if response.status == 200 and json.load(response).get("ok") is True:
                    return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError("Production health check failed")


def replace_live(data):
    temp = LIVE.with_suffix(".delivery.tmp")
    temp.write_bytes(data)
    temp.chmod(0o644)
    os.chown(temp, 0, 0)
    temp.replace(LIVE)


def deploy(row):
    rid = row["id"]
    folder = ROOT / rid
    if (folder / "manifest.json").exists():
        import bundle_delivery

        return bundle_delivery.deploy(sys.modules[__name__], row)
    data = (folder / "bytedepp_server.py").read_bytes()
    if digest(data) != row["sha"] or digest(LIVE.read_bytes()) != row["base_sha"]:
        raise RuntimeError("Candidate or production changed; submit a fresh version")
    # Only an empty schema-equivalent database enters the isolated startup check.
    preflight = folder / "preflight"
    preflight.mkdir(mode=0o700)
    copy = preflight / "database.sqlite3"
    schema_only(LIVE_DB, copy)
    before = db_fingerprint(copy)
    os.chown(preflight, 10001, 10001)
    os.chown(copy, 10001, 10001)
    sandbox(rid, "preflight", preflight)
    if db_fingerprint(copy) != before:
        raise RuntimeError("Automatic schema/data migrations are not allowed")
    backup = folder / "backup"
    backup.mkdir(mode=0o700)
    old = LIVE.read_bytes()
    (backup / "bytedepp_server.py").write_bytes(old)
    (backup / "bytedepp_server.py").chmod(0o600)
    command(["systemctl", "stop", "bytedepp.service"], timeout=45)
    replaced = False
    try:
        snapshot(LIVE_DB, backup / "database.sqlite3")
        (backup / "database.sqlite3").chmod(0o600)
        replace_live(data)
        replaced = True
        command(["systemctl", "start", "bytedepp.service"], timeout=45)
        health()
        time.sleep(3)
        command(["systemctl", "is-active", "bytedepp.service"])
        health()
    except Exception:
        if replaced:
            command(["systemctl", "stop", "bytedepp.service"], timeout=45)
            replace_live(old)
        command(["systemctl", "start", "bytedepp.service"], timeout=45)
        health()
        raise RuntimeError(
            "Update failed; previous code restored. Database backup retained."
        ) from None


def callback(query, bot):
    value = query.get("data", "")
    if not isinstance(value, str) or not value.startswith("bd:"):
        return
    parts = value.split(":")
    if len(parts) != 3 or parts[1] not in ("yes", "no"):
        return
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM releases WHERE id=?", (parts[2],)).fetchone()
        allowed = authenticate_callback(query, bot.chat, row, time.time())
        if allowed:
            db.execute(
                "UPDATE releases SET status=?,approved=? WHERE id=?",
                (
                    "deploying" if parts[1] == "yes" else "rejected",
                    time.time(),
                    row["id"],
                ),
            )
    with contextlib.suppress(Exception):
        bot.call(
            "answerCallbackQuery",
            {
                "callback_query_id": query["id"],
                "text": (
                    "Принято"
                    if allowed
                    else "Недоступно: чужое, устаревшее или уже обработанное подтверждение"
                ),
            },
        )
    if not allowed:
        return
    with contextlib.suppress(Exception):
        bot.call(
            "editMessageReplyMarkup",
            {
                "chat_id": bot.chat,
                "message_id": row["message_id"],
                "reply_markup": {"inline_keyboard": []},
            },
        )
    if parts[1] == "no":
        bot.send(
            "ByteDepp: версия "
            + row["sha"][:12]
            + " отклонена. Рабочий сервер не изменён."
        )
        return
    try:
        deploy(row)
    except Exception as error:
        set_status(row["id"], "failed", str(error)[:250])
        bot.send(
            "ByteDepp: обновление "
            + row["sha"][:12]
            + " не завершено. "
            + str(error)[:250]
        )
    else:
        set_status(row["id"], "deployed")
        bot.send(
            "ByteDepp обновлён: "
            + row["sha"][:12]
            + "\nПроверка работоспособности пройдена. Резервная копия сохранена."
        )


def process_release(bot):
    with database() as db:
        row = db.execute(
            "SELECT * FROM releases WHERE status IN ('queued','notifying') ORDER BY created LIMIT 1"
        ).fetchone()
    if not row:
        return
    if row["status"] == "queued":
        set_status(row["id"], "testing")
        try:
            if (ROOT / row["id"] / "manifest.json").exists():
                import bundle_delivery

                bundle_delivery.verify(ROOT / row["id"], row["sha"])
            elif (
                digest((ROOT / row["id"] / "bytedepp_server.py").read_bytes())
                != row["sha"]
            ):
                raise RuntimeError("Candidate digest mismatch")
            sandbox(row["id"], "test")
        except Exception:
            set_status(
                row["id"], "failed", "Isolated checks failed; production unchanged"
            )
            bot.send(
                "ByteDepp: версия "
                + row["sha"][:12]
                + " не прошла проверки. Рабочий сервер не изменён."
            )
            return
        set_status(row["id"], "notifying")
    scope = "\nОбновляется только server/bytedepp_server.py; APK и каталог не меняются."
    manifest_path = ROOT / row["id"] / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        change = manifest["changes"]
        scope = (
            "\nНабор: серверный код, каталоги и APK. Файлов: "
            + str(len(manifest["files"]))
            + "\nДобавлено: "
            + str(change["added"])
            + "; изменено: "
            + str(change["modified"])
            + "; удаляется: "
            + str(change["removed"])
        )
    message = bot.send(
        "ByteDepp: серверная версия прошла изолированные проверки.\n"
        "Сервер: 84.21.173.88\nSHA256: "
        + row["sha"]
        + scope
        + "\nПодтверждение действует 24 часа. Обновить рабочий сервер?",
        [
            {"text": "Обновить", "callback_data": "bd:yes:" + row["id"]},
            {"text": "Отклонить", "callback_data": "bd:no:" + row["id"]},
        ],
    )
    with database() as db:
        db.execute(
            "UPDATE releases SET status='pending',message_id=? WHERE id=? AND status='notifying'",
            (message, row["id"]),
        )


def worker():
    lock = (ROOT / "worker.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    bot = Telegram()
    # Do not silently repeat an interrupted deployment or reuse old approvals after restart.
    with database() as db:
        interrupted = db.execute(
            "SELECT * FROM releases WHERE status='deploying'"
        ).fetchall()
    for row in interrupted:
        if (ROOT / row["id"] / "manifest.json").exists():
            import bundle_delivery

            command(["systemctl", "stop", "bytedepp.service"], timeout=45)
            bundle_delivery.restore(sys.modules[__name__], ROOT / row["id"])
            command(["systemctl", "start", "bytedepp.service"], timeout=45)
            health()
        backup = ROOT / row["id"] / "backup/bytedepp_server.py"
        if backup.exists():
            command(["systemctl", "stop", "bytedepp.service"], timeout=45)
            replace_live(backup.read_bytes())
            command(["systemctl", "start", "bytedepp.service"], timeout=45)
            health()
        set_status(
            row["id"],
            "interrupted",
            "Worker restarted; previous code restored if deployment had started",
        )
        with contextlib.suppress(Exception):
            bot.send(
                "ByteDepp: публикация была прервана. Повторное обновление требует новой заявки; проверьте статус."
            )
    with database() as db:
        db.execute(
            "UPDATE releases SET status='interrupted',error='Worker restarted; submit again' WHERE status='testing'"
        )
    while True:
        try:
            process_release(bot)
            with database() as db:
                row = db.execute(
                    "SELECT value FROM metadata WHERE key='offset'"
                ).fetchone()
            updates = bot.call(
                "getUpdates",
                {
                    "offset": int(row["value"]) if row else 0,
                    "timeout": 5,
                    "allowed_updates": ["callback_query"],
                },
            )
            for update in updates:
                if "callback_query" in update:
                    callback(update["callback_query"], bot)
                with database() as db:
                    db.execute(
                        "INSERT OR REPLACE INTO metadata VALUES('offset',?)",
                        (str(update["update_id"] + 1),),
                    )
        except Exception:
            print(
                "Delivery worker operation failed; retrying without exposing credentials",
                flush=True,
            )
            time.sleep(10)


if __name__ == "__main__":
    if os.geteuid() != 0 or len(sys.argv) != 2:
        raise SystemExit("Root maintenance or restricted SSH entry required")
    init()
    action = sys.argv[1]
    if action == "submit" and os.environ.get("SUDO_USER") == "ArtemDeveloper":
        submit()
    elif action == "status" and os.environ.get("SUDO_USER") == "ArtemDeveloper":
        status()
    elif action == "worker" and not os.environ.get("SUDO_USER"):
        worker()
    else:
        raise SystemExit("Action denied")
