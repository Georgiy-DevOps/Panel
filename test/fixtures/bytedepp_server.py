import json
import mimetypes
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


DB_PATH = os.environ.get("BYTEDEPP_DB", "bytedepp_licenses.sqlite3")
HOST = os.environ.get("BYTEDEPP_HOST", "0.0.0.0")
PORT = int(os.environ.get("BYTEDEPP_PORT", "8787"))
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
BOT_USERNAME = os.environ.get("TELEGRAM_BOT_USERNAME", "")
ADMIN_TOKEN = os.environ.get("BYTEDEPP_ADMIN_TOKEN", "dev-admin")
ADMIN_IDS = {
    int(value.strip())
    for value in os.environ.get("BYTEDEPP_ADMIN_IDS", "").split(",")
    if value.strip().isdigit()
}
AUTO_GRANT_ON_BIND = os.environ.get("BYTEDEPP_AUTO_GRANT_ON_BIND", "0") == "1"
STATIC_ROOT_VALUE = os.environ.get("BYTEDEPP_STATIC_ROOT", "").strip()
STATIC_ROOT = Path(STATIC_ROOT_VALUE).expanduser() if STATIC_ROOT_VALUE else None
STATIC_URL_PREFIX = "/static/lynkco900/"
CATALOG_DESCRIPTIONS = {
    "com.geely.engineermode": (
        "Приложение для доступа к инженерному меню автомобилей Geely. "
        "Здесь вы найдёте скрытые настройки и возможность установки сторонних приложений."
    ),
    "ru.yandex.androidkeyboard": (
        "Умная клавиатура от Яндекса. Поддерживает голосовой ввод, "
        "автокоррекцию и встроенный переводчик."
    ),
    "com.yandex.browser": (
        "Быстрый и безопасный браузер со встроенной защитой от вредоносных сайтов "
        "и удобным режимом чтения."
    ),
    "com.waze": (
        "Навигация с информацией о пробках, камерах и ДТП "
        "от других водителей в реальном времени."
    ),
    "com.useronestudio.radiodubai": (
        "Онлайн-радио для прослушивания FM-станций Дубая и ОАЭ "
        "в прямом эфире и фоновом режиме."
    ),
    "com.spotify.music": (
        "Музыкальный стриминговый сервис с доступом к миллионам треков, "
        "подкастов и персональных плейлистов."
    ),
    "com.carwizard.li.youtube": (
        "Приложение для просмотра видео, трансляций и музыки "
        "со всего мира."
    ),
    "app.netmirror.newtv": (
        "Приложение для просмотра фильмов и сериалов в высоком качестве. "
        "Здесь вы найдёте большую коллекцию контента на любой вкус."
    ),
}


def now_ms():
    return int(time.time() * 1000)


def days_from_now_ms(days):
    return now_ms() + int(days) * 24 * 60 * 60 * 1000


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS devices (
                device_id TEXT PRIMARY KEY,
                vin TEXT NOT NULL DEFAULT '',
                pair_code TEXT UNIQUE,
                telegram_id INTEGER,
                language_active INTEGER NOT NULL DEFAULT 0,
                language_expires_at INTEGER NOT NULL DEFAULT 0,
                store_active INTEGER NOT NULL DEFAULT 0,
                store_expires_at INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """
        )
        conn.commit()


def get_device(device_id):
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM devices WHERE device_id = ?",
            (device_id,),
        ).fetchone()


def get_device_by_code(pair_code):
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM devices WHERE pair_code = ?",
            (pair_code,),
        ).fetchone()


def upsert_device(device_id, vin=""):
    existing = get_device(device_id)
    timestamp = now_ms()
    if existing:
        with connect() as conn:
            conn.execute(
                "UPDATE devices SET vin = COALESCE(NULLIF(?, ''), vin), updated_at = ? WHERE device_id = ?",
                (vin or "", timestamp, device_id),
            )
            conn.commit()
        return get_device(device_id)

    pair_code = secrets.token_hex(3).upper()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO devices (device_id, vin, pair_code, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (device_id, vin or "", pair_code, timestamp, timestamp),
        )
        conn.commit()
    return get_device(device_id)


def bind_telegram(pair_code, telegram_id):
    device = get_device_by_code(pair_code)
    if not device:
        return None

    language_active = device["language_active"]
    language_expires_at = device["language_expires_at"]
    store_active = device["store_active"]
    store_expires_at = device["store_expires_at"]
    if AUTO_GRANT_ON_BIND:
        language_active = 1
        language_expires_at = 0
        store_active = 1
        store_expires_at = days_from_now_ms(3)

    with connect() as conn:
        conn.execute(
            """
            UPDATE devices
            SET telegram_id = ?, language_active = ?, language_expires_at = ?,
                store_active = ?, store_expires_at = ?, updated_at = ?
            WHERE device_id = ?
            """,
            (
                telegram_id,
                language_active,
                language_expires_at,
                store_active,
                store_expires_at,
                now_ms(),
                device["device_id"],
            ),
        )
        conn.commit()
    return get_device(device["device_id"])


def grant(device_id, language=None, store_days=None):
    device = get_device(device_id)
    if not device:
        return None

    language_active = device["language_active"]
    language_expires_at = device["language_expires_at"]
    store_active = device["store_active"]
    store_expires_at = device["store_expires_at"]

    if language is not None:
        language_active = 1 if language else 0
        language_expires_at = 0
    if store_days is not None:
        store_active = 1 if int(store_days) > 0 else 0
        store_expires_at = days_from_now_ms(int(store_days)) if store_active else 0

    with connect() as conn:
        conn.execute(
            """
            UPDATE devices
            SET language_active = ?, language_expires_at = ?,
                store_active = ?, store_expires_at = ?, updated_at = ?
            WHERE device_id = ?
            """,
            (
                language_active,
                language_expires_at,
                store_active,
                store_expires_at,
                now_ms(),
                device_id,
            ),
        )
        conn.commit()
    return get_device(device_id)


def license_payload(device):
    current = now_ms()
    store_active = bool(device["store_active"])
    if store_active and device["store_expires_at"] and current > device["store_expires_at"]:
        store_active = False

    language_active = bool(device["language_active"])
    if language_active and device["language_expires_at"] and current > device["language_expires_at"]:
        language_active = False

    return {
        "deviceId": device["device_id"],
        "vin": device["vin"],
        "telegramId": device["telegram_id"],
        "pairCode": device["pair_code"],
        "botStartUrl": bot_start_url(device["pair_code"]),
        "language": {
            "active": language_active,
            "expiresAtMillis": int(device["language_expires_at"]),
            "source": "server",
        },
        "store": {
            "active": store_active,
            "expiresAtMillis": int(device["store_expires_at"]),
            "source": "server",
        },
    }


def bot_start_url(pair_code):
    if not BOT_USERNAME:
        return ""
    return f"https://t.me/{BOT_USERNAME}?start={urllib.parse.quote(pair_code)}"


def read_json(handler):
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def send_json(handler, status, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def send_static(handler, request_path):
    if STATIC_ROOT is None:
        send_json(handler, 404, {"error": "static root is not configured"})
        return

    relative_path = urllib.parse.unquote(request_path[len(STATIC_URL_PREFIX):])
    root = STATIC_ROOT.resolve()
    candidate = (root / relative_path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        send_json(handler, 403, {"error": "forbidden"})
        return

    if not candidate.is_file():
        send_json(handler, 404, {"error": "file not found"})
        return

    content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
    if candidate.suffix.lower() == ".json":
        data = candidate.read_bytes()
        host = handler.headers.get("Host", f"127.0.0.1:{PORT}")
        public_base = f"http://{host}"
        text = data.decode("utf-8")
        if candidate.name == "store.json":
            catalog = json.loads(text)
            available_apps = []
            for app in catalog.get("apps", []):
                apk_url = app.get("url", "")
                apk_name = Path(urllib.parse.urlparse(apk_url).path).name
                if apk_name and (candidate.parent / apk_name).is_file():
                    description = CATALOG_DESCRIPTIONS.get(app.get("package", ""))
                    if description:
                        app["description"] = description
                    available_apps.append(app)
                else:
                    print(f"[catalog] hidden missing APK: {apk_name or app.get('name', 'unknown')}")
            catalog["apps"] = available_apps
            text = json.dumps(catalog, ensure_ascii=False, indent=2)
        text = text.replace("http://192.168.137.1", public_base)
        data = text.encode("utf-8")
        content_type = "application/json; charset=utf-8"

        handler.send_response(200)
        handler.send_header("Content-Type", content_type)
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
        return

    handler.send_response(200)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(candidate.stat().st_size))
    handler.end_headers()
    with candidate.open("rb") as source:
        shutil.copyfileobj(source, handler.wfile, length=1024 * 1024)


class ApiHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.path.startswith(STATIC_URL_PREFIX):
            send_static(self, parsed.path)
            return
        if parsed.path == "/api/license/status":
            device_id = (query.get("deviceId") or [""])[0]
            if not device_id:
                send_json(self, 400, {"error": "deviceId is required"})
                return
            device = upsert_device(device_id)
            send_json(self, 200, license_payload(device))
            return
        if parsed.path == "/health":
            send_json(self, 200, {"ok": True})
            return
        send_json(self, 404, {"error": "not found"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/device/session":
            body = read_json(self)
            device_id = body.get("deviceId", "")
            if not device_id:
                send_json(self, 400, {"error": "deviceId is required"})
                return
            device = upsert_device(device_id, body.get("vin", ""))
            send_json(self, 200, license_payload(device))
            return

        if parsed.path == "/api/admin/grant":
            if self.headers.get("X-Admin-Token") != ADMIN_TOKEN:
                send_json(self, 403, {"error": "forbidden"})
                return
            body = read_json(self)
            device = grant(
                body.get("deviceId", ""),
                language=body.get("languageActive"),
                store_days=body.get("storeDays"),
            )
            if not device:
                send_json(self, 404, {"error": "device not found"})
                return
            send_json(self, 200, license_payload(device))
            return

        send_json(self, 404, {"error": "not found"})

    def log_message(self, fmt, *args):
        print("[http]", fmt % args)


def telegram_api(method, payload=None):
    if not BOT_TOKEN:
        return {}
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=35) as resp:
        return json.loads(resp.read().decode("utf-8"))


def send_message(chat_id, text):
    telegram_api("sendMessage", {"chat_id": chat_id, "text": text})


def is_admin(chat_id):
    return not ADMIN_IDS or int(chat_id) in ADMIN_IDS


def handle_bot_message(message):
    chat = message.get("chat", {})
    chat_id = chat.get("id")
    text = (message.get("text") or "").strip()
    if not chat_id or not text:
        return

    parts = text.split()
    command = parts[0].lower()

    if command == "/start" and len(parts) >= 2:
        device = bind_telegram(parts[1].upper(), int(chat_id))
        if not device:
            send_message(chat_id, "Код не найден. Откройте ByteDepp и возьмите новый код привязки.")
            return
        payload = license_payload(device)
        send_message(
            chat_id,
            "ByteDepp привязан.\n"
            f"Device: {payload['deviceId']}\n"
            f"VIN: {payload['vin'] or 'не указан'}\n"
            f"Язык: {'активен' if payload['language']['active'] else 'закрыт'}\n"
            f"Магазин: {'активен' if payload['store']['active'] else 'закрыт'}",
        )
        return

    if command == "/grant_all" and len(parts) >= 3 and is_admin(chat_id):
        device = grant(parts[1], language=True, store_days=int(parts[2]))
        send_message(chat_id, "Готово." if device else "Device не найден.")
        return

    if command == "/grant_language" and len(parts) >= 2 and is_admin(chat_id):
        device = grant(parts[1], language=True)
        send_message(chat_id, "Язык активирован." if device else "Device не найден.")
        return

    if command == "/grant_store" and len(parts) >= 3 and is_admin(chat_id):
        device = grant(parts[1], store_days=int(parts[2]))
        send_message(chat_id, "Магазин активирован." if device else "Device не найден.")
        return

    send_message(
        chat_id,
        "Команды:\n"
        "/start CODE - привязать машину\n"
        "/grant_all DEVICE_ID DAYS - выдать язык и магазин\n"
        "/grant_language DEVICE_ID - выдать язык\n"
        "/grant_store DEVICE_ID DAYS - выдать магазин",
    )


def bot_loop():
    if not BOT_TOKEN:
        print("[bot] TELEGRAM_BOT_TOKEN is empty, bot disabled")
        return
    offset = 0
    print("[bot] polling started")
    while True:
        try:
            result = telegram_api("getUpdates", {"timeout": 30, "offset": offset})
            for update in result.get("result", []):
                offset = max(offset, update["update_id"] + 1)
                if "message" in update:
                    handle_bot_message(update["message"])
        except Exception as exc:
            print("[bot] error:", exc)
            time.sleep(5)


def main():
    init_db()
    threading.Thread(target=bot_loop, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), ApiHandler)
    print(f"[http] listening on http://{HOST}:{PORT}")
    if STATIC_ROOT is not None:
        print(f"[static] {STATIC_URL_PREFIX} -> {STATIC_ROOT.resolve()}")
    server.serve_forever()


if __name__ == "__main__":
    main()
