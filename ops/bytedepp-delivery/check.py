"""Runs exclusively inside a disposable container with no network or production mounts."""

import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request
import urllib.parse
import hashlib
import zipfile

source = Path("/candidate/bytedepp_server.py")
bundle = Path("/candidate/bundle")
if bundle.exists():
    source = bundle / "server/bytedepp_server.py"
    sys.path.insert(0, str(source.parent))
    for py in (bundle / "server").rglob("*.py"):
        compile(py.read_bytes(), str(py), "exec")
compile(source.read_bytes(), str(source), "exec")
mode = sys.argv[1]
env = os.environ | {
    "BYTEDEPP_DB": (
        "/data/database.sqlite3" if mode == "preflight" else "/tmp/test.sqlite3"
    ),
    "BYTEDEPP_HOST": "127.0.0.1",
    "BYTEDEPP_PORT": "8787",
    "BYTEDEPP_STATIC_ROOT": (
        str(bundle / "lynkco900") if bundle.exists() else "/tmp/static"
    ),
    "PYTHONPATH": str(source.parent),
    "BYTEDEPP_ADMIN_TOKEN": "isolated-test-only",
    "TELEGRAM_BOT_TOKEN": "",
    "BYTEDEPP_AUTO_GRANT_ON_BIND": "0",
    "BYTEDEPP_SERVER_SOURCE": str(source),
}
Path("/tmp/static").mkdir(exist_ok=True)
(Path("/tmp/static") / "probe.txt").write_text("isolated fixture")
if mode == "test":
    if bundle.exists():
        for file in (bundle / "lynkco900").rglob("*"):
            if not file.is_file():
                continue
            if file.suffix.lower() == ".json":
                if file.stat().st_size > 16 * 1024**2:
                    raise RuntimeError("JSON catalog too large")
                json.loads(file.read_text(encoding="utf-8-sig"))
            if file.suffix.lower() == ".apk":
                with zipfile.ZipFile(file) as apk:
                    if "AndroidManifest.xml" not in apk.namelist():
                        raise RuntimeError("APK missing AndroidManifest.xml")
                    if (
                        len(apk.infolist()) > 100000
                        or sum(i.file_size for i in apk.infolist()) > 2 * 1024**3
                    ):
                        raise RuntimeError("APK archive limits exceeded")
                    if apk.testzip() is not None:
                        raise RuntimeError("APK CRC check failed")
    subprocess.run(
        [sys.executable, "-B", "/checks/test_reporting.py"],
        env=env,
        check=True,
        timeout=40,
    )
process = subprocess.Popen(
    [sys.executable, "-B", str(source)],
    env=env,
    cwd=source.parent,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
try:
    for attempt in range(30):
        if process.poll() is not None:
            raise RuntimeError("Server exited")
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:8787/health", timeout=1
            ) as response:
                assert response.status == 200 and json.load(response)["ok"] is True
                break
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.2)
    else:
        raise RuntimeError("Health check timed out")
    if mode == "test":
        if bundle.exists():
            small = next(
                (
                    p
                    for p in (bundle / "lynkco900").rglob("*")
                    if p.is_file()
                    and p.suffix != ".json"
                    and p.stat().st_size < 1024**2
                ),
                None,
            )
            if small:
                url = "http://127.0.0.1:8787/static/lynkco900/" + urllib.parse.quote(
                    small.relative_to(bundle / "lynkco900").as_posix()
                )
                with urllib.request.urlopen(url, timeout=5) as response:
                    assert (
                        hashlib.sha256(response.read()).digest()
                        == hashlib.sha256(small.read_bytes()).digest()
                    )
        else:
            with urllib.request.urlopen(
                "http://127.0.0.1:8787/static/lynkco900/probe.txt"
            ) as response:
                assert response.read() == b"isolated fixture"
    time.sleep(1)
    assert process.poll() is None
finally:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
