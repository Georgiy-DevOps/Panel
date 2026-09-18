import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "deployment", Path(__file__).with_name("deploy.py")
)
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
REPOSITORY = "ghcr.io/example/panel"
OLD = {
    "image": REPOSITORY + "@sha256:" + "1" * 64,
    "local_image": "sha256:" + "a" * 64,
    "revision": "a" * 40,
}
NEW = REPOSITORY + "@sha256:" + "2" * 64
REQUEST = {
    "image": NEW,
    "revision": "b" * 40,
    "registry_user": "example",
    "registry_token": "fixture-token-not-a-credential",
}


class FakeDocker:
    config = {"image_repository": REPOSITORY}

    def __init__(self, fail=None, previous=None):
        self.fail = fail
        self.previous = previous
        self.calls = []
        self.smokes = 0

    def current(self):
        return OLD, self.previous

    def pull(self, target, request):
        self.calls.append("pull")
        if self.fail == "pull":
            raise RuntimeError("Registry unavailable")
        return target | {"local_image": "sha256:" + "b" * 64}

    def preflight(self, target, current):
        self.calls.append("preflight")
        if self.fail == "preflight":
            raise RuntimeError("Migration incompatible with previous image")

    def activate(self, image):
        self.calls.append(image)
        if self.fail == "activate" and image == NEW:
            raise RuntimeError("Candidate startup failed")

    def smoke(self):
        self.calls.append("smoke")
        self.smokes += 1
        if self.fail == "smoke" and self.smokes == 1:
            raise RuntimeError("Unhealthy candidate")

    def save(self, target, previous):
        self.calls.append("save")
        self.saved = target, previous


class DeploymentTest(unittest.TestCase):
    def test_mutable_foreign_and_injected_image_rejected_before_actions(self):
        for image in (
            REPOSITORY + ":latest",
            "ghcr.io/attacker/image@sha256:" + "1" * 64,
            NEW + "; echo bad",
        ):
            driver = FakeDocker()
            with self.assertRaises(ValueError):
                deployment.deploy(driver, REQUEST | {"image": image})
            self.assertEqual(driver.calls, [])

    def test_missing_revision_and_unknown_actions_are_rejected(self):
        for change in (
            {"revision": "main"},
            {"action": "exec"},
            {"command": "whoami"},
            {"registry_token": ""},
        ):
            with self.assertRaises(ValueError):
                deployment.validate(REQUEST | change, REPOSITORY)

    def test_pull_failure_leaves_live_service_untouched(self):
        driver = FakeDocker("pull")
        with self.assertRaises(RuntimeError):
            deployment.deploy(driver, REQUEST)
        self.assertEqual(driver.calls, ["pull"])

    def test_preflight_failure_leaves_live_service_untouched(self):
        driver = FakeDocker("preflight")
        with self.assertRaises(RuntimeError):
            deployment.deploy(driver, REQUEST)
        self.assertEqual(driver.calls, ["pull", "preflight"])

    def test_success_records_current_and_previous_only_after_health(self):
        driver = FakeDocker()
        deployment.deploy(driver, REQUEST)
        self.assertEqual(driver.calls, ["pull", "preflight", NEW, "smoke", "save"])
        self.assertEqual(driver.saved[1], OLD)

    def test_failed_start_or_health_restores_old_image_without_advancing_state(self):
        for failure in ("activate", "smoke"):
            driver = FakeDocker(failure)
            with self.assertRaisesRegex(
                RuntimeError, "previous application image restored"
            ):
                deployment.deploy(driver, REQUEST)
            self.assertIn(OLD["image"], driver.calls)
            self.assertNotIn("save", driver.calls)

    def test_rollback_without_previous_fails_without_changing_service(self):
        driver = FakeDocker()
        with self.assertRaisesRegex(RuntimeError, "No previous"):
            deployment.deploy(driver, REQUEST | {"action": "rollback"})
        self.assertEqual(driver.calls, [])

    def test_explicit_rollback_preflights_and_retains_replaced_release(self):
        previous = OLD | {"image": REPOSITORY + "@sha256:" + "3" * 64}
        driver = FakeDocker(previous=previous)
        deployment.deploy(driver, REQUEST | {"action": "rollback"})
        self.assertIn(previous["image"], driver.calls)
        self.assertEqual(driver.saved[1], OLD)

    def test_sqlite_snapshot_includes_committed_wal_and_does_not_modify_source(self):
        with tempfile.TemporaryDirectory() as temp:
            source, destination = (
                Path(temp) / "live.sqlite",
                Path(temp) / "snapshot.sqlite",
            )
            with sqlite3.connect(source) as db:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("PRAGMA wal_autocheckpoint=0")
                db.execute("CREATE TABLE records(value TEXT)")
                db.execute("INSERT INTO records VALUES('before deployment')")
                db.commit()
                deployment.snapshot(source, destination)
                with sqlite3.connect(destination) as snapshot:
                    self.assertEqual(
                        snapshot.execute("SELECT value FROM records").fetchone()[0],
                        "before deployment",
                    )
                self.assertEqual(
                    db.execute("SELECT COUNT(*) FROM records").fetchone()[0], 1
                )


if __name__ == "__main__":
    unittest.main()
