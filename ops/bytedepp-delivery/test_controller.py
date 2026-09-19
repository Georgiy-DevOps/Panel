import importlib.util
from pathlib import Path
import tempfile
import sqlite3
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location(
    "delivery", Path(__file__).with_name("controller.py")
)
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class ApprovalTests(unittest.TestCase):
    def test_schema_copy_never_contains_production_rows(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.sqlite"
            target = Path(folder) / "test.sqlite"
            with sqlite3.connect(source) as db:
                db.execute("CREATE TABLE sample(value TEXT)")
                db.execute("INSERT INTO sample VALUES('private production record')")
            delivery.schema_only(source, target)
            with sqlite3.connect(target) as db:
                self.assertEqual(
                    db.execute("SELECT count(*) FROM sample").fetchone()[0], 0
                )
            self.assertNotIn(b"private production record", target.read_bytes())

    def test_failed_health_restores_code_and_keeps_database_backup(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "release").mkdir()
            live = root / "live.py"
            live.write_bytes(b"old code")
            (root / "release/bytedepp_server.py").write_bytes(b"new code")
            live_db = root / "live.sqlite"
            with sqlite3.connect(live_db) as db:
                db.execute("CREATE TABLE sample(value TEXT)")
                db.execute("INSERT INTO sample VALUES('preserved')")
            row = {
                "id": "release",
                "sha": delivery.digest(b"new code"),
                "base_sha": delivery.digest(b"old code"),
            }
            with (
                patch.object(delivery, "ROOT", root),
                patch.object(delivery, "LIVE", live),
                patch.object(delivery, "LIVE_DB", live_db),
                patch.object(delivery, "sandbox"),
                patch.object(delivery, "command"),
                patch.object(
                    delivery, "health", side_effect=[RuntimeError("down"), None]
                ),
                patch.object(delivery.os, "chown"),
            ):
                with self.assertRaisesRegex(RuntimeError, "previous code restored"):
                    delivery.deploy(row)
                self.assertEqual(live.read_bytes(), b"old code")
                self.assertEqual(
                    delivery.db_fingerprint(live_db),
                    delivery.db_fingerprint(root / "release/backup/database.sqlite3"),
                )

    def test_confirmation_consumed_once_and_other_user_cannot_deploy(self):
        with tempfile.TemporaryDirectory() as folder:
            with (
                patch.object(delivery, "ROOT", Path(folder)),
                patch.object(delivery, "deploy") as deploy,
            ):
                delivery.init()
                with delivery.database() as db:
                    db.execute(
                        "INSERT INTO releases VALUES(?,?,?,?,?,?,?,?)",
                        (
                            "r",
                            "hash",
                            "base",
                            delivery.time.time(),
                            "pending",
                            10,
                            None,
                            None,
                        ),
                    )
                bot = Mock(chat=123)
                q = {
                    "id": "callback",
                    "data": "bd:yes:r",
                    "from": {"id": 456},
                    "message": {"chat": {"id": 123}, "message_id": 10},
                }
                delivery.callback(q, bot)
                deploy.assert_not_called()
                q["from"]["id"] = 123
                delivery.callback(q, bot)
                delivery.callback(q, bot)
                deploy.assert_called_once()

    def test_only_owner_correct_message_and_fresh_pending_release(self):
        row = {"status": "pending", "created": 1000, "message_id": 10}
        query = {
            "from": {"id": 123},
            "message": {"chat": {"id": 123}, "message_id": 10},
        }
        self.assertTrue(delivery.authenticate_callback(query, 123, row, 1001))
        self.assertFalse(
            delivery.authenticate_callback(
                query | {"from": {"id": 456}}, 123, row, 1001
            )
        )
        self.assertFalse(
            delivery.authenticate_callback(
                query | {"message": {"chat": {"id": 456}, "message_id": 10}},
                123,
                row,
                1001,
            )
        )
        self.assertFalse(
            delivery.authenticate_callback(query, 123, row | {"message_id": 11}, 1001)
        )
        self.assertFalse(delivery.authenticate_callback(query, 123, row, 100000))
        for state in ["deploying", "deployed", "rejected", "superseded", "failed"]:
            self.assertFalse(
                delivery.authenticate_callback(
                    query, 123, row | {"status": state}, 1001
                )
            )

    def test_submission_copies_bytes_and_does_not_update_production(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            live = root / "live.py"
            source = root / "source.py"
            live.write_text("old version")
            source.write_text("new version")
            with (
                patch.object(delivery, "ROOT", root / "state"),
                patch.object(delivery, "LIVE", live),
                patch.object(delivery, "SOURCE", source),
            ):
                delivery.init()
                delivery.submit()
                source.write_text("changed after submit")
                with delivery.database() as db:
                    row = db.execute("SELECT * FROM releases").fetchone()
                self.assertEqual(
                    (delivery.ROOT / row["id"] / "bytedepp_server.py").read_text(),
                    "new version",
                )
                self.assertEqual(live.read_text(), "old version")
                with self.assertRaises(ValueError):
                    delivery.submit()

    def test_candidate_tampering_blocks_before_service_commands(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "release").mkdir()
            (root / "release/bytedepp_server.py").write_text("changed")
            with (
                patch.object(delivery, "ROOT", root),
                patch.object(delivery, "command") as command,
            ):
                with self.assertRaises(RuntimeError):
                    delivery.deploy(
                        {"id": "release", "sha": "expected", "base_sha": "expected"}
                    )
                command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
