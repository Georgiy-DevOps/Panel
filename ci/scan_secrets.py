"""Fail closed on scanner errors as well as findings. Never print secret values."""

import os
from pathlib import Path
import re
import subprocess

binary = os.environ.get("GITLEAKS_BIN", str(Path(".ci-tools/gitleaks").resolve()))
subprocess.run(
    ["git", "rev-parse", "--verify", "HEAD"], check=True, capture_output=True
)
result = subprocess.run(
    [binary, "git", ".", "--redact=100", "--no-banner", "--log-opts=--all"],
    capture_output=True,
    text=True,
)
output = result.stdout + result.stderr
print(output)
if result.returncode or re.search(r"\bERR\b", output):
    raise SystemExit("Secret scan failed")
if not re.search(r"\b[1-9][0-9]* commits? scanned", output):
    raise SystemExit("Secret scanner did not verify any commits")
