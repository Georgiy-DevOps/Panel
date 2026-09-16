"""Test the patched ByteDepp source using isolated databases, never its live service."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

source = Path(os.environ["BYTEDEPP_SERVER_SOURCE"]).resolve()
spec = importlib.util.spec_from_file_location("bytedepp_under_test", source)
byte = importlib.util.module_from_spec(spec)
spec.loader.exec_module(byte)
VIN = "L6T79D2D0PP123456"
VIN2 = "L6T79D2D0PP123457"


class VehicleReporting(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bytedepp-report-test-")
        byte.DB_PATH = str(Path(self.temp.name) / "devices.sqlite3")
        byte.BOT_USERNAME = ""
        with sqlite3.connect(byte.DB_PATH) as conn:
            conn.executescript("""
              CREATE TABLE devices(device_id TEXT PRIMARY KEY,vin TEXT NOT NULL DEFAULT '',pair_code TEXT UNIQUE,
                telegram_id INTEGER,language_active INTEGER NOT NULL DEFAULT 0,language_expires_at INTEGER NOT NULL DEFAULT 0,
                store_active INTEGER NOT NULL DEFAULT 0,store_expires_at INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
            """)
            conn.execute("INSERT INTO devices VALUES(?,?,?,?,?,?,?,?,?,?)", ("existing", VIN, "SAMPLE", 123, 1, 0, 1, 9999999999999, 10, 20))
        conn.close()
        byte.init_db()

    def tearDown(self):
        self.temp.cleanup()

    def license_values(self, device_id):
        row = byte.get_device(device_id)
        return tuple(row[k] for k in ("pair_code", "telegram_id", "language_active", "language_expires_at", "store_active", "store_expires_at", "created_at"))

    def test_migration_is_idempotent_and_keeps_existing_licenses(self):
        before = self.license_values("existing")
        byte.init_db()
        self.assertEqual(before, self.license_values("existing"))
        row = byte.get_device("existing")
        self.assertIsNone(row["vehicle_software_version"])
        self.assertIsNone(row["vin_reported_at"])
        self.assertEqual(byte.license_payload(row)["language"]["active"], True)

    def test_legacy_requests_preserve_reports_and_license_reads_do_not_fake_freshness(self):
        before = self.license_values("existing")
        row = byte.vehicle_session({"deviceId": "existing", "vin": VIN.lower(), "vehicleSoftwareVersion": "  ZEEKR OS 6.3.1  "})
        self.assertEqual(row["vin"], VIN)
        self.assertEqual(row["vehicle_software_version"], "ZEEKR OS 6.3.1")
        self.assertGreater(row["vin_reported_at"], 0)
        with byte.connect() as conn:
            conn.execute("UPDATE devices SET vin_reported_at=100,vehicle_software_reported_at=200 WHERE device_id='existing'")
        byte.vehicle_session({"deviceId": "existing"})
        row = byte.upsert_device("existing")
        self.assertEqual(row["vin_reported_at"], 100)
        self.assertEqual(row["vehicle_software_reported_at"], 200)
        self.assertEqual(row["vehicle_software_version"], "ZEEKR OS 6.3.1")
        self.assertEqual(before, self.license_values("existing"))

    def test_vin_change_clears_previous_car_version_and_new_devices_have_no_license(self):
        byte.vehicle_session({"deviceId": "existing", "vin": VIN, "vehicleSoftwareVersion": "1.0"})
        row = byte.vehicle_session({"deviceId": "existing", "vin": VIN2})
        self.assertIsNone(row["vehicle_software_version"])
        self.assertIsNone(row["vehicle_software_reported_at"])
        row = byte.vehicle_session({"deviceId": "new", "vin": VIN, "vehicleSoftwareVersion": "2.0"})
        self.assertEqual(row["vehicle_software_version"], "2.0")
        self.assertEqual(row["language_active"], 0)
        self.assertEqual(row["store_active"], 0)

    def test_invalid_reports_do_not_change_existing_data(self):
        before = dict(byte.get_device("existing"))
        invalid = [[], {"deviceId": {}}, {"deviceId": "existing", "vin": "INVALID"},
                   {"deviceId": "existing", "vin": 123}, {"deviceId": "existing", "vehicleSoftwareVersion": "1.0"},
                   {"deviceId": "existing", "vin": VIN, "vehicleSoftwareVersion": "X" * 129},
                   {"deviceId": "existing", "vin": VIN, "vehicleSoftwareVersion": {"version": "1.0"}}]
        for body in invalid:
            with self.subTest(body=body), self.assertRaises(ValueError):
                byte.vehicle_session(body)
        self.assertEqual(dict(byte.get_device("existing")), before)

    def test_http_session_round_trip_and_bad_payloads(self):
        server = byte.ThreadingHTTPServer(("127.0.0.1", 0), byte.ApiHandler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        url = f"http://127.0.0.1:{server.server_port}/api/device/session"
        def post(data):
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=5) as response:
                    return response.status, json.load(response)
            except urllib.error.HTTPError as error:
                with error:
                    return error.code, json.load(error)
        try:
            status, payload = post(json.dumps({"deviceId": "http-test", "vin": VIN, "vehicleSoftwareVersion": "LYNK OS 1.4"}).encode())
            self.assertEqual(status, 200)
            self.assertEqual(payload["vin"], VIN)
            self.assertEqual(payload["vehicleSoftwareVersion"], "LYNK OS 1.4")
            self.assertGreater(payload["vehicleSoftwareReportedAtMillis"], 0)
            self.assertFalse(payload["store"]["active"])
            status, legacy = post(b'{"deviceId":"legacy"}')
            self.assertEqual(status, 200)
            self.assertIsNone(legacy["vehicleSoftwareVersion"])
            self.assertEqual(post(b'{broken')[0], 400)
            self.assertEqual(post(b'[]')[0], 400)
            self.assertEqual(post(b' ' * 32769)[0], 413)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == "__main__":
    unittest.main()
