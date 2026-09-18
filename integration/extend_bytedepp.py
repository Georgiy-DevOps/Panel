"""Add optional car software reporting to the existing ByteDepp session API.

Usage: python3 extend_bytedepp.py /path/to/bytedepp_server.py
Back up the source and database before applying this patch.
"""

import ast
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
if "def vehicle_session(body):" in source:
    print("ByteDepp vehicle reporting is already installed")
    sys.exit(0)


def replace(old, new):
    global source
    if source.count(old) != 1:
        raise RuntimeError(
            "Unexpected ByteDepp source; patch was not applied: " + old[:70]
        )
    source = source.replace(old, new, 1)


replace("import json\n", "import json\nimport re\n")
replace("import sqlite3\n", "import sqlite3\nfrom contextlib import contextmanager\n")
replace(
    """def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn
""",
    """@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            yield conn
    finally:
        conn.close()
""",
)
replace(
    """        conn.commit()


def get_device(device_id):""",
    """        columns = {row[1] for row in conn.execute("PRAGMA table_info(devices)")}
        for name, kind in [
            ("vehicle_software_version", "TEXT"),
            ("vin_reported_at", "INTEGER"),
            ("vehicle_software_reported_at", "INTEGER"),
        ]:
            if name not in columns:
                conn.execute(f"ALTER TABLE devices ADD COLUMN {name} {kind}")
        conn.commit()


def get_device(device_id):""",
)

start = source.index("def upsert_device(")
end = source.index("\ndef bind_telegram(", start)
source = (
    source[:start]
    + """def upsert_device(device_id, vin="", vehicle_software_version=None):
    timestamp = now_ms()
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute("SELECT * FROM devices WHERE device_id = ?", (device_id,)).fetchone()
        if existing:
            changed_vin = bool(vin and vin != existing["vin"])
            software = None if changed_vin else existing["vehicle_software_version"]
            software_at = None if changed_vin else existing["vehicle_software_reported_at"]
            if vehicle_software_version:
                software, software_at = vehicle_software_version, timestamp
            conn.execute(
                "UPDATE devices SET vin=?, vehicle_software_version=?, vin_reported_at=?, vehicle_software_reported_at=?, updated_at=? WHERE device_id=?",
                (vin or existing["vin"], software, timestamp if vin else existing["vin_reported_at"], software_at, timestamp, device_id),
            )
        else:
            pair_code = secrets.token_hex(3).upper()
            conn.execute(
                "INSERT INTO devices (device_id,vin,pair_code,created_at,updated_at,vehicle_software_version,vin_reported_at,vehicle_software_reported_at) VALUES(?,?,?,?,?,?,?,?)",
                (device_id, vin, pair_code, timestamp, timestamp, vehicle_software_version,
                 timestamp if vin else None, timestamp if vehicle_software_version else None),
            )
        conn.commit()
    return get_device(device_id)


def vehicle_session(body):
    if not isinstance(body, dict):
        raise ValueError("JSON object is required")

    def text(name, maximum, required=False):
        value = body.get(name)
        if value is None and not required:
            return ""
        if not isinstance(value, str) or len(value) > maximum or any(ord(c) < 32 for c in value):
            raise ValueError("Invalid " + name)
        value = value.strip()
        if required and not value:
            raise ValueError(name + " is required")
        return value

    device_id = text("deviceId", 256, required=True)
    vin = text("vin", 32).upper()
    if vin and not re.fullmatch(r"[A-HJ-NPR-Z0-9]{17}", vin):
        raise ValueError("VIN must contain 17 letters and digits, excluding I, O, Q")
    software = text("vehicleSoftwareVersion", 128)
    if software and not vin:
        raise ValueError("vin is required with vehicleSoftwareVersion")
    return upsert_device(device_id, vin, software or None)


"""
    + source[end + 1 :]
)

replace(
    """        "vin": device["vin"],
""",
    """        "vin": device["vin"],
        "vehicleSoftwareVersion": device["vehicle_software_version"],
        "vinReportedAtMillis": device["vin_reported_at"],
        "vehicleSoftwareReportedAtMillis": device["vehicle_software_reported_at"],
""",
)

replace(
    """            body = read_json(self)
            device_id = body.get("deviceId", "")
            if not device_id:
                send_json(self, 400, {"error": "deviceId is required"})
                return
            device = upsert_device(device_id, body.get("vin", ""))
            send_json(self, 200, license_payload(device))
""",
    """            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length > 32768:
                    self.close_connection = True
                    send_json(self, 413, {"error": "Request too large"})
                    return
                if length <= 0:
                    raise ValueError("JSON body is required")
                device = vehicle_session(read_json(self))
            except (ValueError, UnicodeDecodeError) as error:
                send_json(self, 400, {"error": str(error)})
                return
            send_json(self, 200, license_payload(device))
""",
)

ast.parse(source)
path.write_text(source, encoding="utf-8")
print("ByteDepp vehicle reporting patch applied")
