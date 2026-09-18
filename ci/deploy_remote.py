"""Send a bounded request to a forced-command SSH deployment account."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request

host = os.environ["DEPLOY_HOST"]
user = os.environ["DEPLOY_USER"]
port = os.environ.get("DEPLOY_PORT", "22")
if not re.fullmatch(r"[a-zA-Z0-9.:-]+", host) or not re.fullmatch(
    r"[a-z][a-z0-9-]+", user
):
    raise SystemExit("Invalid deployment endpoint")
if not port.isdigit() or not 1 <= int(port) <= 65535:
    raise SystemExit("Invalid SSH port")
identity_request = urllib.request.Request(
    os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
    + "&audience="
    + urllib.parse.quote(os.environ["DEPLOY_AUDIENCE"], safe=""),
    headers={"Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]},
)
with urllib.request.urlopen(identity_request, timeout=30) as response:
    identity = json.load(response)["value"]
image = os.environ.get("DEPLOY_IMAGE", "recorded-previous")
revision = os.environ.get("DEPLOY_REVISION", "recorded-previous")
delivery_run = os.environ.get("DELIVERY_RUN_ID", os.environ["GITHUB_RUN_ID"])
if os.environ.get("DEPLOY_RECEIPT"):
    receipt = json.loads(Path(os.environ["DEPLOY_RECEIPT"]).read_text())
    if receipt["revision"] != revision or str(receipt["run_id"]) != delivery_run:
        raise SystemExit("Artifact does not match the approved delivery run")
    image = receipt["image"]
payload = json.dumps(
    {
        "action": os.environ.get("DEPLOY_ACTION", "deploy"),
        "image": image,
        "revision": revision,
        "delivery_run": delivery_run,
        "oidc_token": identity,
        "registry_user": os.environ["REGISTRY_USER"],
        "registry_token": os.environ["REGISTRY_TOKEN"],
    }
)
with tempfile.TemporaryDirectory(prefix="panel-deploy-") as directory:
    key = Path(directory) / "key"
    hosts = Path(directory) / "known_hosts"
    key.write_text(os.environ["DEPLOY_SSH_KEY"] + "\n")
    hosts.write_text(os.environ["DEPLOY_KNOWN_HOSTS"] + "\n")
    key.chmod(0o600)
    subprocess.run(
        [
            "ssh",
            "-i",
            str(key),
            "-p",
            port,
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "UserKnownHostsFile=" + str(hosts),
            "-o",
            "ConnectTimeout=15",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=4",
            user + "@" + host,
            "deploy",
        ],
        input=payload,
        text=True,
        check=True,
        timeout=600,
    )
