import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location(
    "bundle", Path(__file__).with_name("bundle_delivery.py")
)
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class BundleTests(unittest.TestCase):
    def test_macos_metadata_is_not_delivered(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            self.tree(root)
            before = bundle.inventory(root)
            (root / "lynkco900/._install-manifest.json").write_bytes(b"\x00\x05")
            (root / "lynkco900/.DS_Store").write_bytes(b"metadata")
            self.assertEqual(bundle.inventory(root), before)

    def tree(self, root):
        (root / "server").mkdir()
        (root / "lynkco900").mkdir()
        (root / "server/bytedepp_server.py").write_text("print(1)")
        (root / "lynkco900/example.apk").write_bytes(b"example")

    def test_snapshot_is_independent_and_tracks_deletions(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            source = root / "source"
            source.mkdir()
            self.tree(source)
            dest = root / "copy"
            dest.mkdir()
            old = bundle.inventory(source, dest)
            (source / "lynkco900/example.apk").unlink()
            (source / "server/bytedepp_server.py").write_text("print(2)")
            self.assertEqual(bundle.inventory(dest), old)
            self.assertEqual(
                bundle.changes(old, bundle.inventory(source)),
                {"added": 0, "modified": 1, "removed": 1},
            )

    def test_symlink_and_hardlink_are_rejected(self):
        for link in ["symlink", "hardlink"]:
            with self.subTest(link=link), tempfile.TemporaryDirectory() as path:
                root = Path(path)
                self.tree(root)
                secret = root / "outside"
                secret.write_text("not for delivery")
                target = root / "lynkco900/link"
                if link == "symlink":
                    target.symlink_to(secret)
                else:
                    os.link(secret, target)
                with self.assertRaises((ValueError, OSError)):
                    bundle.inventory(root)

    def test_fifo_is_rejected_without_blocking(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            self.tree(root)
            os.mkfifo(root / "lynkco900/pipe")
            with self.assertRaises(ValueError):
                bundle.inventory(root)

    def test_recovery_restores_both_directories_after_partial_switch(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            live = root / "live"
            live.mkdir()
            self.tree(live)
            release = root / "release"
            backup = release / "backup"
            backup.mkdir(parents=True)
            (backup / "switching").write_text("recover")
            (live / "server").rename(backup / "server")
            (live / "server").mkdir()
            (live / "server/bytedepp_server.py").write_text("new")
            (live / "lynkco900").rename(backup / "lynkco900")
            c = SimpleNamespace(LIVE=live / "server/bytedepp_server.py")
            bundle.restore(c, release)
            self.assertEqual(c.LIVE.read_text(), "print(1)")
            self.assertEqual((live / "lynkco900/example.apk").read_bytes(), b"example")
            bundle.restore(c, release)


if __name__ == "__main__":
    unittest.main()
