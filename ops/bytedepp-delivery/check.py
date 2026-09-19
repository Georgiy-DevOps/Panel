"""Runs exclusively inside a disposable container with no network or production mounts."""

import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

source = Path("/candidate/bytedepp_server.py")
compile(source.read_bytes(), str(source), "exec")
mode = sys.argv[1]
env = os.environ | {
    "BYTEDEPP_DB": (
        "/data/database.sqlite3" if mode == "preflight" else "/tmp/test.sqlite3"
    ),
    "BYTEDEPP_HOST": "127.0.0.1",
    "BYTEDEPP_PORT": "8787",
    "BYTEDEPP_STATIC_ROOT": "/tmp/static",
    "BYTEDEPP_ADMIN_TOKEN": "isolated-test-only",
    "TELEGRAM_BOT_TOKEN": "",
    "BYTEDEPP_AUTO_GRANT_ON_BIND": "0",
    "BYTEDEPP_SERVER_SOURCE": str(source),
}
Path("/tmp/static").mkdir(exist_ok=True)
(Path("/tmp/static") / "probe.txt").write_text("isolated fixture")
if mode == "test":
    subprocess.run(
        [sys.executable, "-B", "/checks/test_reporting.py"],
        env=env,
        check=True,
        timeout=40,
    )
process = subprocess.Popen(
    [sys.executable, "-B", str(source)],
    env=env,
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
