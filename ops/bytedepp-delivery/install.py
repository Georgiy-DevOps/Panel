"""One-time, administrator-only installation. Preserves current live source before changing access."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
LIB = Path("/usr/local/lib/bytedepp-delivery")
DEV = Path("/srv/bytedepp-development")


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


if __name__ == "__main__":
    if os.geteuid() != 0 or LIB.exists() or DEV.exists():
        raise SystemExit(
            "Fresh root installation required; existing installation preserved"
        )
    live = Path("/srv/bytedepp/server/bytedepp_server.py")
    image = json.loads(run("docker", "inspect", "artem-bytedepp-live"))[0]["Image"]
    backup = Path("/root/bytedepp-approval-bootstrap")
    backup.mkdir(mode=0o700)
    wrapper = Path("/usr/local/sbin/artem-container-shell")
    shutil.copy2(wrapper, backup / "ssh-wrapper.py")
    service = Path("/etc/systemd/system/artem-developer.service")
    shutil.copy2(service, backup / "artem-developer.service")
    LIB.mkdir(mode=0o755)
    (LIB / "checks").mkdir(mode=0o755)
    for src, dst in [
        ("controller.py", "controller.py"),
        ("check.py", "checks/check.py"),
        ("test_reporting.fixture", "checks/test_reporting.py"),
    ]:
        shutil.copyfile(HERE / src, LIB / dst)
        (LIB / dst).chmod(0o644)
    conf = Path("/etc/bytedepp-delivery")
    conf.mkdir(mode=0o700)
    (conf / "config.json").write_text(json.dumps({"image": image}))
    (conf / "config.json").chmod(0o600)
    DEV.mkdir(mode=0o755)
    (DEV / "server").mkdir(mode=0o775)
    os.chown(DEV / "server", 0, 10001)
    # Disconnect the former production-write workspace before taking the definitive source copy.
    run("systemctl", "stop", "artem-developer.service")
    data = live.read_bytes()
    (backup / "bytedepp_server.py").write_bytes(data)
    (backup / "bytedepp_server.py").chmod(0o600)
    (DEV / "server/bytedepp_server.py").write_bytes(data)
    os.chown(DEV / "server/bytedepp_server.py", 10001, 10001)
    (DEV / "server/bytedepp_server.py").chmod(0o664)
    (DEV / "lynkco900").mkdir(mode=0o775)
    os.chown(DEV / "lynkco900", 10001, 10001)
    # Source is root-managed after approval; the app continues to write its database as before.
    for path in [live.parent, *live.parent.rglob("*")]:
        if path.is_symlink():
            raise SystemExit("Unexpected production source symlink")
        os.chown(path, 0, 0)
        path.chmod(0o755 if path.is_dir() else 0o644)
    hardening = Path("/etc/systemd/system/bytedepp.service.d/95-approved-source.conf")
    hardening.write_text("[Service]\nReadOnlyPaths=/srv/bytedepp/server\n")
    # Applies on the next approved application restart, not during setup.
    run(
        "docker",
        "create",
        "--name",
        "artem-bytedepp-development",
        "--hostname",
        "bytedepp-development",
        "--network",
        "developer-artem",
        "--user",
        "10001:10001",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--init",
        "--memory=768m",
        "--memory-swap=768m",
        "--cpus=0.75",
        "--pids-limit=128",
        "--log-opt",
        "max-size=5m",
        "--log-opt",
        "max-file=2",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=128m,mode=1777",
        "--mount",
        "type=bind,src=/srv/developer/ArtemDeveloper,dst=/home/artem",
        "--mount",
        f"type=bind,src={DEV},dst=/srv/bytedepp",
        image,
    )
    text = (
        wrapper.read_text()
        .replace("10001:986", "10001:10001")
        .replace("artem-bytedepp-live", "artem-bytedepp-development")
    )
    start = text.index('    if sys.argv[1] in ("bytedepp-restart", "bytedepp-status"):')
    end = text.index("    os.execve(\n", start)
    text = (
        text[:start] + """    if sys.argv[1] in ("bytedepp-submit", "bytedepp-status"):
        action = "submit" if sys.argv[1] == "bytedepp-submit" else "status"
        os.execve("/usr/bin/python3", ["python3", "/usr/local/lib/bytedepp-delivery/controller.py", action],
                  {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "SUDO_USER": "ArtemDeveloper"})
    if sys.argv[1] == "bytedepp-restart":
        raise SystemExit("Production restart requires owner approval. Use bytedepp-submit.")
""" + text[end:]
    )
    compile(text, str(wrapper), "exec")
    wrapper.write_text(text)
    wrapper.chmod(0o755)
    service.write_text(
        service.read_text().replace("artem-bytedepp-live", "artem-bytedepp-development")
    )
    unit = Path("/etc/systemd/system/bytedepp-delivery.service")
    unit.write_text("""[Unit]
Description=Owner-approved ByteDepp server updates via Telegram
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service
[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/local/lib/bytedepp-delivery/controller.py worker
Restart=on-failure
RestartSec=10
UMask=0077
NoNewPrivileges=yes
ProtectHome=yes
PrivateTmp=yes
[Install]
WantedBy=multi-user.target
""")
    note = Path("/srv/developer/ArtemDeveloper/LIVE-ACCESS.txt")
    note.write_text(
        """Production write access has been replaced with owner-approved delivery.
/srv/bytedepp/server/bytedepp_server.py is now your DEVELOPMENT copy.
Your current server code was preserved when switching; the Mac project is untouched.
From your Mac, submit the saved server file:
  ssh -i ~/.ssh/id_ed25519 ArtemDeveloper@84.21.173.88 bytedepp-submit
View delivery status:
  ssh -i ~/.ssh/id_ed25519 ArtemDeveloper@84.21.173.88 bytedepp-status
Tests run automatically. Only the owner can approve production in Telegram.
Only the Python server file is delivered. APKs, static catalogs, databases and systemd units are excluded.
Use a separate test.sqlite3 for local testing; production data/secrets/backups are not mounted.
"""
    )
    os.chown(note, 10001, 10001)
    note.chmod(0o600)
    run("systemctl", "daemon-reload")
    run("systemctl", "start", "artem-developer.service")
    run("systemctl", "enable", "--now", "bytedepp-delivery.service")
    print(
        "APPROVAL_DELIVERY_INSTALLED; SOURCE_PRESERVED_SHA256="
        + hashlib.sha256(data).hexdigest()
    )
