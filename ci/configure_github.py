"""Apply CI settings through an already-authenticated official GitHub CLI.

No tokens are read from the credential manager. SSH keys travel only in memory
from the approved host to GitHub repository secrets. Run from the repository root.
"""

import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ssh-key", required=True)
    parser.add_argument("--known-hosts", required=True)
    parser.add_argument("--host", default="84.21.173.88")
    parser.add_argument("--gh", default="gh")
    parser.add_argument("--protect-only", action="store_true")
    parser.add_argument(
        "--skip-protection",
        action="store_true",
        help="Configure delivery only; main remains unprotected",
    )
    args = parser.parse_args()
    repository = "Kirill-DevSecOps/Panel"
    gh = args.gh
    subprocess.run([gh, "auth", "status"], check=True)
    if not args.protect_only:
        host_line = next(
            line
            for line in Path(args.known_hosts).read_text().splitlines()
            if line.startswith(args.host + " ") and "ssh-ed25519" in line
        )
        variables = {"DEPLOY_KNOWN_HOSTS": host_line}
        for env in ("staging", "production"):
            prefix = env.upper()
            variables |= {
                prefix + "_HOST": args.host,
                prefix + "_PORT": "22",
                prefix + "_USER": "panel-" + env,
                prefix + "_AUDIENCE": f"panel-cd:{args.host}:{env}",
            }
            key = subprocess.check_output(
                [
                    "ssh",
                    "-i",
                    args.ssh_key,
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    "-o",
                    "UserKnownHostsFile=" + args.known_hosts,
                    "root@" + args.host,
                    "cat /etc/panel-cd/keys/" + env,
                ]
            )
            subprocess.run(
                [gh, "secret", "set", prefix + "_SSH_KEY", "--repo", repository],
                input=key,
                check=True,
            )
        for name, value in variables.items():
            subprocess.run(
                [gh, "variable", "set", name, "--repo", repository, "--body", value],
                check=True,
            )
        subprocess.run(
            [
                gh,
                "api",
                "--method",
                "PUT",
                "repos/" + repository + "/actions/permissions/workflow",
                "--input",
                "-",
            ],
            input=json.dumps(
                {
                    "default_workflow_permissions": "read",
                    "can_approve_pull_request_reviews": False,
                }
            ).encode(),
            check=True,
        )
    if not args.skip_protection:
        subprocess.run(
            [
                gh,
                "api",
                "--method",
                "PUT",
                "repos/" + repository + "/branches/main/protection",
                "--input",
                "ci/main-protection.json",
            ],
            check=True,
        )
        print("Main protection configured.")
    else:
        print(
            "WARNING: main protection was NOT enabled. An eligible plan is still required."
        )
    print("Requested CI settings applied. No production deployment was triggered.")


if __name__ == "__main__":
    main()
