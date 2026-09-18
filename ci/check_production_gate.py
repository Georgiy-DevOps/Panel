"""Fail closed unless the owner manually selected a successful main delivery run."""

import json
import os
from pathlib import Path
import re
import urllib.request


def verify_run(run, repository):
    if not (
        run.get("repository", {}).get("full_name") == repository
        and run.get("event") == "push"
        and run.get("head_branch") == "main"
        and run.get("path") == ".github/workflows/pipeline.yml"
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and re.fullmatch(r"[a-f0-9]{40}", run.get("head_sha", ""))
    ):
        raise ValueError(
            "Selected run must be a successful main pipeline including staging"
        )
    return run["head_sha"]


def main():
    repository = os.environ["GITHUB_REPOSITORY"]
    owner = repository.split("/")[0]
    if not (
        os.environ["GITHUB_EVENT_NAME"] == "workflow_dispatch"
        and os.environ["GITHUB_REF"] == "refs/heads/main"
        and os.environ["GITHUB_ACTOR"] == owner
        and os.environ["GITHUB_TRIGGERING_ACTOR"] == owner
        and os.environ["GITHUB_RUN_ATTEMPT"] == "1"
    ):
        raise SystemExit(
            "Only a new manual run on main by the repository owner is allowed"
        )
    run_id = os.environ.get("DELIVERY_RUN_ID", "")
    if not run_id:
        return
    if not re.fullmatch(r"[0-9]{1,20}", run_id):
        raise SystemExit("Invalid delivery run ID")
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repository}/actions/runs/{run_id}",
        headers={
            "Authorization": "Bearer " + os.environ["GH_TOKEN"],
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        revision = verify_run(json.load(response), repository)
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write("revision=" + revision + "\n")
    print("Selected main run completed successfully, including staging")


if __name__ == "__main__":
    main()
