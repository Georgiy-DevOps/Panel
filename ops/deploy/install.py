"""Bootstrap an isolated staging service and restricted CD accounts on the panel host.

Run explicitly as root after reviewing paths. Never restarts the production service.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import socket
import sqlite3
import subprocess


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bootstrap-image",
        required=True,
        help="Already scanned local image ID (sha256:...)",
    )
    parser.add_argument("--repository", default="Kirill-DevSecOps/Panel")
    parser.add_argument("--host", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("Run as root")
    image = json.loads(run("docker", "image", "inspect", args.bootstrap_image))[0]["Id"]
    live = json.loads(run("docker", "inspect", "app-panel-1"))[0]
    if not live["State"]["Running"] or not any(
        m.get("Name") == "app_fleet_data" and m["Destination"] == "/app/data"
        for m in live["Mounts"]
    ):
        raise SystemExit(
            "Unexpected production layout; review paths before installation"
        )
    config_dir, code_dir = Path("/etc/panel-cd"), Path("/usr/local/lib/panel-cd")
    if (config_dir / "staging.json").exists():
        raise SystemExit(
            "Already installed. Review/update files explicitly; bootstrap will not overwrite credentials"
        )
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 3081))
    os.umask(0o077)
    for directory in (
        config_dir,
        code_dir,
        Path("/var/lib/panel-cd"),
        Path("/srv/fleet-control/staging"),
    ):
        directory.mkdir(parents=True, exist_ok=True)
        directory.chmod(0o700)
    source = Path(__file__).resolve().parent
    for name in ("deploy.py", "identity.py", "compose.image.yaml", "requirements.txt"):
        shutil.copyfile(source / name, code_dir / name)
    subprocess.run(["python3", "-m", "venv", str(code_dir / "venv")], check=True)
    subprocess.run(
        [
            str(code_dir / "venv/bin/python"),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "-r",
            str(code_dir / "requirements.txt"),
        ],
        check=True,
    )
    stage_root = Path("/srv/fleet-control/staging")
    with sqlite3.connect(stage_root / "bytedepp.sqlite3") as db:
        db.execute(
            """CREATE TABLE devices(device_id TEXT PRIMARY KEY, vin TEXT,
          language_active INTEGER DEFAULT 0, language_expires_at INTEGER DEFAULT 0,
          store_active INTEGER DEFAULT 0, store_expires_at INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0,
          vehicle_software_version TEXT, vin_reported_at INTEGER, vehicle_software_reported_at INTEGER)"""
        )
    (stage_root / "bytedepp.sqlite3").chmod(0o644)
    password, salt = secrets.token_urlsafe(32), secrets.token_hex(16)
    digest = hashlib.scrypt(
        password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64
    ).hex()
    (stage_root / ".env").write_text(
        f"PUBLIC_URL=http://127.0.0.1:3081\nADMIN_PASSWORD_HASH={salt}:{digest}\n"
    )
    (config_dir / "staging-password.txt").write_text(password + "\n")
    run("docker", "volume", "create", "panel_staging_data")
    data_dir = json.loads(run("docker", "volume", "inspect", "panel_staging_data"))[0][
        "Mountpoint"
    ]
    os.chown(data_dir, 1000, 1000)
    for env in ("staging", "production"):
        stage = env == "staging"
        work_dir = Path("/var/lib/panel-cd") / env
        work_dir.mkdir(exist_ok=True)
        config = {
            "environment": env,
            "github_repository": args.repository,
            "production_actor": args.repository.split("/")[0],
            "oidc_audience": f"panel-cd:{args.host}:{env}",
            "image_repository": "ghcr.io/" + args.repository.lower(),
            "state_file": str(work_dir / "state.json"),
            "staging_state_file": "/var/lib/panel-cd/staging/state.json",
            "port": 3081 if stage else 3080,
            "volume": "panel_staging_data" if stage else "app_fleet_data",
            "byte_db": (
                str(stage_root / "bytedepp.sqlite3")
                if stage
                else "/srv/bytedepp/bytedepp.sqlite3"
            ),
            "data_dir": (
                data_dir if stage else "/var/lib/docker/volumes/app_fleet_data/_data"
            ),
            "project": "panel-staging" if stage else "app",
            "container": "panel-staging-panel-1" if stage else "app-panel-1",
            "env_file": (
                str(stage_root / ".env") if stage else "/srv/fleet-control/app/.env"
            ),
            "compose_file": str(code_dir / "compose.image.yaml"),
            "backup_dir": "/var/backups/panel-deploy/" + env,
            "work_dir": str(work_dir),
            "health_url": (
                "http://127.0.0.1:3081/health"
                if stage
                else f"https://{args.host}:8443/health"
            ),
        }
        (config_dir / (env + ".json")).write_text(json.dumps(config, indent=2))
        account = "panel-" + env
        try:
            user = pwd.getpwnam(account)
        except KeyError:
            run("useradd", "--create-home", "--shell", "/bin/sh", account)
            user = pwd.getpwnam(account)
        key_dir = config_dir / "keys"
        key_dir.mkdir(exist_ok=True)
        key = key_dir / env
        run(
            "ssh-keygen",
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-C",
            "panel-cd-" + env,
            "-f",
            str(key),
        )
        ssh_dir = Path(user.pw_dir) / ".ssh"
        ssh_dir.mkdir(mode=0o700, exist_ok=True)
        command = f"{code_dir}/venv/bin/python {code_dir}/deploy.py {env}"
        authorized = ssh_dir / "authorized_keys"
        authorized.write_text(
            'restrict,command="sudo -n '
            + command
            + '" '
            + key.with_suffix(".pub").read_text()
        )
        authorized.chmod(0o600)
        os.chown(ssh_dir, user.pw_uid, user.pw_gid)
        os.chown(authorized, user.pw_uid, user.pw_gid)
        sudoers = Path("/etc/sudoers.d") / account
        sudoers.write_text(f"{account} ALL=(root) NOPASSWD: {command}\n")
        sudoers.chmod(0o440)
        run("visudo", "-cf", str(sudoers))
    # Bootstrap only staging. Production's first change requires a manual GitHub dispatch.
    from deploy import Docker

    config = json.loads((config_dir / "staging.json").read_text())
    driver = Docker(config, dict(os.environ))
    driver.activate(image)
    driver.smoke()
    driver.save({"image": image, "local_image": image, "revision": "legacy"}, None)
    print(
        "Staging ready on 127.0.0.1:3081. Production unchanged. CI keys and staging password are root-only in /etc/panel-cd."
    )


if __name__ == "__main__":
    main()
