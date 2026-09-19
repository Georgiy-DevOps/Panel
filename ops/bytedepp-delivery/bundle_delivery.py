"""Immutable source/catalog bundles. Never follow developer-controlled symlinks."""

import hashlib
import json
import os
import secrets
import shutil
import stat
import time

MAX_BYTES = 8 * 1024**3
MAX_FILES = 20000
SKIP = {".git", "__pycache__", ".env", ".DS_Store"}


def included(name, scope):
    if name in SKIP or name.startswith("._"):
        return False
    if scope == "server" and (
        name.endswith((".service", ".pyc", ".sqlite", ".sqlite3", ".key", ".pem"))
        or name.startswith(".env")
    ):
        return False
    return True


def inventory(base, destination=None):
    """Open relative to directory descriptors; reject symlink, FIFO, device and hardlink files."""
    entries = {}
    total = 0
    count = 0

    def walk(fd, prefix, scope):
        nonlocal total, count
        before_dir = os.fstat(fd)
        names = sorted(os.listdir(fd))
        for name in names:
            if not included(name, scope):
                continue
            if len(name) > 240 or any(ord(c) < 32 for c in name):
                raise ValueError("Unsupported filename")
            relative = prefix + "/" + name
            if len(relative) > 1000:
                raise ValueError("Path too long")
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(
                    name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd
                )
                try:
                    if destination:
                        (destination / relative).mkdir(mode=0o755)
                        (destination / relative).chmod(0o755)
                    walk(child, relative, scope)
                finally:
                    os.close(child)
                continue
            child = os.open(
                name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd
            )
            with os.fdopen(child, "rb") as file:
                before = os.fstat(file.fileno())
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                    raise ValueError("Only ordinary files are allowed")
                count += 1
                if count > MAX_FILES or before.st_size + total > MAX_BYTES:
                    raise ValueError("Bundle exceeds 8 GiB / 20000 files")
                output = (destination / relative).open("xb") if destination else None
                digest = hashlib.sha256()
                size = 0
                try:
                    while block := file.read(1024 * 1024):
                        size += len(block)
                        total += len(block)
                        if total > MAX_BYTES:
                            raise ValueError("Bundle grew beyond limit")
                        digest.update(block)
                        if output:
                            output.write(block)
                    after = os.fstat(file.fileno())
                    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                        after.st_size,
                        after.st_mtime_ns,
                        after.st_ctime_ns,
                    ) or size != before.st_size:
                        raise ValueError(
                            "Files changed during submission; save and retry"
                        )
                    entries[relative] = {"sha256": digest.hexdigest(), "size": size}
                finally:
                    if output:
                        output.close()
                        (destination / relative).chmod(0o444)
        after_dir = os.fstat(fd)
        if before_dir.st_mtime_ns != after_dir.st_mtime_ns:
            raise ValueError("Directory changed during submission")

    base_fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for scope in ["server", "lynkco900"]:
            fd = os.open(
                scope, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base_fd
            )
            try:
                if destination:
                    (destination / scope).mkdir(mode=0o755)
                    (destination / scope).chmod(0o755)
                walk(fd, scope, scope)
            finally:
                os.close(fd)
    finally:
        os.close(base_fd)
    if "server/bytedepp_server.py" not in entries:
        raise ValueError("Server entry point is missing")
    return entries


def fingerprint(entries):
    return hashlib.sha256(
        json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def changes(before, after):
    return {
        key: sum(1 for name in names if condition(name))
        for key, names, condition in [
            ("added", after, lambda n: n not in before),
            ("modified", after, lambda n: n in before and before[n] != after[n]),
            ("removed", before, lambda n: n not in after),
        ]
    }


def submit(c):
    with c.database() as db:
        db.execute("BEGIN IMMEDIATE")
        if db.execute(
            "SELECT 1 FROM releases WHERE status IN ('queued','testing','deploying')"
        ).fetchone():
            raise ValueError("A release is already running")
        if db.execute(
            "SELECT 1 FROM releases WHERE created>?", (time.time() - 60,)
        ).fetchone():
            raise ValueError("Wait one minute before submitting again")
        # Bundles contain large APKs: retain at most ten until owner maintenance.
        if len(list(c.ROOT.glob("*/manifest.json"))) >= 10:
            raise ValueError(
                "Ten bundle archives retained; administrator cleanup required"
            )
        if shutil.disk_usage(c.ROOT).free < 3 * MAX_BYTES:
            raise ValueError(
                "At least 24 GiB free disk space required for safe delivery"
            )
        rid = secrets.token_hex(16)
        folder = c.ROOT / rid
        folder.mkdir(mode=0o755)
        folder.chmod(0o755)
        candidate = folder / "bundle"
        candidate.mkdir(mode=0o755)
        candidate.chmod(0o755)
        try:
            entries = inventory(c.SOURCE.parent.parent, candidate)
            baseline = inventory(c.LIVE.parent.parent)
            sha = fingerprint(entries)
            manifest = {
                "format": 2,
                "files": entries,
                "changes": changes(baseline, entries),
            }
            (folder / "manifest.json").write_text(json.dumps(manifest, sort_keys=True))
            (folder / "manifest.json").chmod(0o444)
            db.execute(
                "UPDATE releases SET status='superseded' WHERE status IN ('pending','notifying')"
            )
            db.execute(
                "INSERT INTO releases(id,sha,base_sha,created,status) VALUES(?,?,?,?,?)",
                (rid, sha, fingerprint(baseline), time.time(), "queued"),
            )
        except Exception:
            # Only this fresh root-created snapshot; never delete the working folder.
            shutil.rmtree(folder)
            raise
    print("Bundle submitted:", rid, sha, manifest["changes"])
    print("Production unchanged. Owner approval required.")


def verify(folder, sha):
    manifest = json.loads((folder / "manifest.json").read_text())
    actual = inventory(folder / "bundle")
    if actual != manifest["files"] or fingerprint(actual) != sha:
        raise RuntimeError("Bundle integrity failed")
    return manifest


def restore(c, folder):
    """Write-ahead marker lets recovery restore both folders after any interrupted rename."""
    backup = folder / "backup"
    live = c.LIVE.parent.parent
    if not (backup / "switching").exists():
        return
    for name in ["server", "lynkco900"]:
        saved = backup / name
        target = live / name
        if saved.exists():
            if target.exists():
                failed = backup / (name + ".failed")
                if failed.exists():
                    raise RuntimeError("Recovery requires administrator inspection")
                target.rename(failed)
            saved.rename(target)


def deploy(c, row):
    folder = c.ROOT / row["id"]
    verify(folder, row["sha"])
    if fingerprint(inventory(c.LIVE.parent.parent)) != row["base_sha"]:
        raise RuntimeError("Production changed; submit again")
    preflight = folder / "preflight"
    preflight.mkdir(mode=0o700)
    test_db = preflight / "database.sqlite3"
    c.schema_only(c.LIVE_DB, test_db)
    before = c.db_fingerprint(test_db)
    os.chown(preflight, 10001, 10001)
    os.chown(test_db, 10001, 10001)
    c.sandbox(row["id"], "preflight", preflight)
    if c.db_fingerprint(test_db) != before:
        raise RuntimeError("Automatic database migrations remain disabled")
    backup = folder / "backup"
    backup.mkdir(mode=0o700)
    # Preparation occurs outside the downtime window; production cannot write these copies.
    prepared = folder / "prepared"
    shutil.copytree(folder / "bundle", prepared)
    c.command(["systemctl", "stop", "bytedepp.service"], timeout=45)
    try:
        c.snapshot(c.LIVE_DB, backup / "database.sqlite3")
        (backup / "database.sqlite3").chmod(0o600)
        (backup / "switching").write_text(
            "Restore both saved directories on interruption"
        )
        for name in ["server", "lynkco900"]:
            (c.LIVE.parent.parent / name).rename(backup / name)
            (prepared / name).rename(c.LIVE.parent.parent / name)
        c.command(["systemctl", "start", "bytedepp.service"], timeout=45)
        c.health()
        time.sleep(3)
        c.health()
    except Exception:
        c.command(["systemctl", "stop", "bytedepp.service"], timeout=45)
        restore(c, folder)
        c.command(["systemctl", "start", "bytedepp.service"], timeout=45)
        c.health()
        raise RuntimeError(
            "Bundle failed; old code and catalogs restored. DB backup retained."
        ) from None
