"""Exercise the real integration patch and ops tests without credentials or live data."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def run(*arguments, env=None):
    subprocess.run([sys.executable, *arguments], env=env, check=True)


if not shutil.which("restic"):
    raise SystemExit("restic is required; do not silently skip backup recovery tests")
with tempfile.TemporaryDirectory(prefix="panel-ci-") as directory:
    source = Path(directory) / "bytedepp_server.py"
    shutil.copyfile("test/fixtures/bytedepp_server.py", source)
    run("integration/extend_bytedepp.py", str(source))
    # Re-applying the production patch must be harmless.
    run("integration/extend_bytedepp.py", str(source))
    env = os.environ | {"BYTEDEPP_SERVER_SOURCE": str(source)}
    run("test/test_bytedepp.py", env=env)
for directory in (
    "ops/ssh-alerts",
    "ops/backup",
    "ops/deploy",
    "ops/bytedepp-delivery",
):
    run(
        "-m",
        "coverage",
        "run",
        "--parallel-mode",
        "-m",
        "unittest",
        "discover",
        "-s",
        directory,
    )
run("-m", "coverage", "combine")
run("-m", "coverage", "report")
run("-m", "coverage", "xml")
