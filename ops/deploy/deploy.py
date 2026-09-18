"""Root-owned, forced-command deployment controller. No arbitrary shell commands."""

import datetime
from contextlib import closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import sqlite3
import subprocess
import sys
import tempfile
import urllib.request
import uuid


def validate(request, repository):
    if not isinstance(request, dict) or set(request) - {
        "action",
        "image",
        "revision",
        "registry_user",
        "registry_token",
        "oidc_token",
        "delivery_run",
    }:
        raise ValueError("Invalid deployment request")
    action = request.get("action", "deploy")
    if action not in ("deploy", "rollback"):
        raise ValueError("Unknown action")
    if action == "deploy":
        if not re.fullmatch(
            re.escape(repository) + r"@sha256:[a-f0-9]{64}", request.get("image", "")
        ):
            raise ValueError(
                "An immutable digest from the configured registry is required"
            )
        if not re.fullmatch(r"[a-f0-9]{40}", request.get("revision", "")):
            raise ValueError("Full commit SHA is required")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", request.get("registry_user", "")):
        raise ValueError("Registry username required")
    if (
        not isinstance(request.get("registry_token"), str)
        or not 20 <= len(request["registry_token"]) <= 4096
    ):
        raise ValueError("Registry token required")
    return action


def snapshot(source, destination):
    """SQLite backup includes committed WAL data; never copy a live database file."""
    with closing(
        sqlite3.connect("file:" + str(source) + "?mode=ro", uri=True)
    ) as original:
        with closing(sqlite3.connect(destination)) as target:
            original.backup(target)
            if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("SQLite snapshot integrity failed")


SMOKE = r"""
const base='http://127.0.0.1:3080';
const fetch=(url,options={})=>globalThis.fetch(url,{...options,signal:AbortSignal.timeout(5000)});
for (const path of ['/health','/admin','/client']) {
  const response=await fetch(base+path);
  if(response.status!==200) throw Error('Smoke check failed: '+path);
  if(path==='/health' && (await response.json()).ok!==true) throw Error('Invalid health response');
}
if((await fetch(base+'/api/state')).status!==401) throw Error('Admin access is not protected');
if(process.env.CI_SMOKE_PASSWORD) {
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:process.env.PUBLIC_URL,'Content-Type':'application/json'},body:JSON.stringify({password:process.env.CI_SMOKE_PASSWORD})});
  if(!login.ok) throw Error('Preflight login failed');
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const response=await fetch(base+'/api/state',{headers:{Cookie:cookie}});
  if(!response.ok || !Array.isArray((await response.json()).vehicles)) throw Error('Preflight database read failed');
}
console.log('Smoke checks passed');
"""


class Docker:
    def __init__(self, config, environment):
        self.config = config
        self.environment = environment
        self.state_file = Path(config["state_file"])

    def run(self, *args, input=None, env=None):
        result = subprocess.run(
            args,
            input=input,
            text=True,
            capture_output=True,
            env=env or self.environment,
            timeout=240,
        )
        if result.returncode:
            # Do not expose stdin, environment, container logs or credential files.
            raise RuntimeError("Command failed: " + " ".join(args[:2]))
        return result.stdout.strip()

    def compose(self, image, *args):
        environment = self.environment | {
            "PANEL_IMAGE": image,
            "PANEL_PORT": str(self.config["port"]),
            "PANEL_DATA_VOLUME": self.config["volume"],
            "BYTEDEPP_SOURCE": self.config["byte_db"],
        }
        return self.run(
            "docker",
            "compose",
            "--project-name",
            self.config["project"],
            "--env-file",
            self.config["env_file"],
            "--file",
            self.config["compose_file"],
            *args,
            env=environment,
        )

    def current(self):
        # All managed environments are bootstrapped explicitly before enabling CI.
        container = self.run("docker", "inspect", self.config["container"])
        item = json.loads(container)[0]
        if not item["State"]["Running"]:
            raise RuntimeError(
                "Current service is not running; investigate before deploying"
            )
        current = {
            "image": item["Image"],
            "local_image": item["Image"],
            "revision": "legacy",
        }
        state = (
            json.loads(self.state_file.read_text()) if self.state_file.exists() else {}
        )
        if state:
            if state["current"]["local_image"] != item["Image"]:
                raise RuntimeError(
                    "Live image differs from deployment state; manual reconciliation required"
                )
            current = state["current"]
        return current, state.get("previous")

    def pull(self, target, request):
        if not target["image"].startswith("sha256:"):
            self.run(
                "docker",
                "login",
                "ghcr.io",
                "--username",
                request["registry_user"],
                "--password-stdin",
                input=request["registry_token"],
            )
            self.compose(target["image"], "pull", "panel")
        metadata = json.loads(self.run("docker", "image", "inspect", target["image"]))[
            0
        ]
        if target["revision"] != "legacy":
            actual = (metadata["Config"].get("Labels") or {}).get(
                "org.opencontainers.image.revision"
            )
            if actual != target["revision"]:
                raise RuntimeError("Image revision does not match the approved commit")
        return target | {"local_image": metadata["Id"]}

    def trial(self, image, directory, password):
        name = "panel-preflight-" + uuid.uuid4().hex
        try:
            salt = secrets.token_hex(16)
            digest = hashlib.scrypt(
                password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64
            ).hex()
            self.run(
                "docker",
                "run",
                "--detach",
                "--name",
                name,
                "--network",
                "none",
                "--read-only",
                "--cap-drop=ALL",
                "--security-opt=no-new-privileges:true",
                "--tmpfs",
                "/tmp:size=32m",
                "--mount",
                "type=bind,src=" + str(directory / "data") + ",dst=/app/data",
                "--mount",
                "type=bind,src="
                + str(directory / "byte.sqlite")
                + ",dst=/source/bytedepp.sqlite3,readonly",
                "--env",
                "BYTEDEPP_DB=/source/bytedepp.sqlite3",
                "--env",
                "PUBLIC_URL=http://127.0.0.1:3080",
                "--env",
                "ADMIN_PASSWORD_HASH=" + salt + ":" + digest,
                "--env",
                "CI_SMOKE_PASSWORD=" + password,
                image,
            )
            # Explicit retries cover startup without exposing this candidate to real traffic.
            for attempt in range(20):
                try:
                    self.run(
                        "docker",
                        "exec",
                        name,
                        "node",
                        "--input-type=module",
                        "-e",
                        SMOKE,
                    )
                    return
                except RuntimeError:
                    if attempt == 19:
                        raise
                    __import__("time").sleep(1)
        finally:
            subprocess.run(
                ["docker", "rm", "-f", name], capture_output=True, timeout=30
            )

    def preflight(self, target, current):
        directory = Path(self.config["backup_dir"]) / (
            datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            + "-"
            + uuid.uuid4().hex[:8]
        )
        directory.mkdir(parents=True, mode=0o700)
        live_db = Path(self.config["data_dir"]) / "fleet.sqlite"
        snapshot(live_db, directory / "fleet.sqlite")
        snapshot(self.config["byte_db"], directory / "byte.sqlite")
        # Backups are retained separately; the preflight copies may be migrated by the candidate.
        with tempfile.TemporaryDirectory(
            prefix="preflight-", dir=self.config["work_dir"]
        ) as temp:
            trial = Path(temp)
            (trial / "data").mkdir()
            snapshot(directory / "fleet.sqlite", trial / "data/fleet.sqlite")
            snapshot(directory / "byte.sqlite", trial / "byte.sqlite")
            os.chown(trial / "data", 1000, 1000)
            os.chown(trial / "data/fleet.sqlite", 1000, 1000)
            os.chmod(trial / "byte.sqlite", 0o644)
            password = secrets.token_urlsafe(32)
            self.trial(target["image"], trial, password)
            # Old version must also read the migrated snapshot; unsafe migrations block cutover.
            self.trial(current["image"], trial, password)

    def activate(self, image):
        self.compose(
            image,
            "up",
            "-d",
            "--no-build",
            "--pull",
            "never",
            "--wait",
            "--wait-timeout",
            "90",
            "panel",
        )

    def smoke(self):
        self.run(
            "docker",
            "exec",
            self.config["container"],
            "node",
            "--input-type=module",
            "-e",
            SMOKE,
        )
        with urllib.request.urlopen(self.config["health_url"], timeout=15) as response:
            if response.status != 200 or json.load(response).get("ok") is not True:
                raise RuntimeError("Public health check failed")

    def save(self, target, previous):
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        temp = self.state_file.with_suffix(".tmp")
        with temp.open("w") as output:
            json.dump(
                {
                    "current": target,
                    "previous": previous,
                    "updated_at": datetime.datetime.now(
                        datetime.timezone.utc
                    ).isoformat(),
                },
                output,
                indent=2,
            )
            output.flush()
            os.fsync(output.fileno())
        temp.chmod(0o600)
        temp.replace(self.state_file)


def deploy(driver, request):
    action = validate(request, driver.config["image_repository"])
    current, previous = driver.current()
    if action == "rollback":
        if not previous:
            raise RuntimeError("No previous release is recorded")
        target = previous
    else:
        target = {"image": request["image"], "revision": request["revision"]}
    if target["image"] == current["image"]:
        driver.smoke()
        return current
    target = driver.pull(target, request)
    driver.preflight(target, current)
    try:
        driver.activate(target["image"])
        driver.smoke()
        driver.save(target, current)
    except Exception:
        try:
            driver.activate(current["image"])
            driver.smoke()
        except Exception as rollback_error:
            raise RuntimeError(
                "Deployment failed AND automatic rollback failed; operator recovery required"
            ) from rollback_error
        raise RuntimeError(
            "Deployment failed; previous application image restored"
        ) from None
    return target


def main():
    from identity import verify

    os.umask(0o077)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    if len(sys.argv) != 2 or sys.argv[1] not in ("staging", "production"):
        raise SystemExit("Environment must be staging or production")
    if os.environ.get("SSH_ORIGINAL_COMMAND", "deploy") != "deploy":
        raise SystemExit("Only the deployment protocol is allowed")
    config = json.loads(Path("/etc/panel-cd", sys.argv[1] + ".json").read_text())
    payload = sys.stdin.buffer.read(32769)
    if len(payload) > 32768:
        raise SystemExit("Request too large")
    request = json.loads(payload)
    action = validate(request, config["image_repository"])
    with Path("/var/lib/panel-cd/deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        claims = verify(request.get("oidc_token", ""), config, action)
        if sys.argv[1] == "staging":
            if (
                action != "deploy"
                or request["revision"] != claims["sha"]
                or request.get("delivery_run") != claims["run_id"]
            ):
                raise ValueError("Staging must deploy the requesting main run")
        elif action == "deploy":
            staging = json.loads(Path(config["staging_state_file"]).read_text())
            if not (
                staging["current"]["image"] == request["image"]
                and staging["current"]["revision"] == request["revision"]
                and staging.get("delivery_run") == request.get("delivery_run")
            ):
                raise ValueError(
                    "Candidate is not the currently verified staging release"
                )
        with tempfile.TemporaryDirectory(
            prefix="registry-", dir=config["work_dir"]
        ) as auth:
            driver = Docker(config, os.environ | {"DOCKER_CONFIG": auth})
            result = deploy(driver, request)
            if sys.argv[1] == "staging":
                state = json.loads(driver.state_file.read_text())
                state["delivery_run"] = claims["run_id"]
                receipt = driver.state_file.with_suffix(".tmp")
                receipt.write_text(json.dumps(state, indent=2))
                receipt.chmod(0o600)
                receipt.replace(driver.state_file)
    print(
        json.dumps(
            {
                "status": "healthy",
                "environment": sys.argv[1],
                "image": result["image"],
                "revision": result["revision"],
            }
        )
    )


if __name__ == "__main__":
    main()
