"""Verify GitHub's short-lived signed identity in addition to the SSH key."""

import json
from pathlib import Path
import re

import jwt

ISSUER = "https://token.actions.githubusercontent.com"


def policy(claims, config, action):
    repository = config["github_repository"]
    stage = config["environment"] == "staging"
    workflow = (
        "pipeline.yml"
        if stage
        else ("production.yml" if action == "deploy" else "rollback.yml")
    )
    expected = {
        "repository": repository,
        "repository_owner": repository.split("/")[0],
        "ref": "refs/heads/main",
        "workflow_ref": f"{repository}/.github/workflows/{workflow}@refs/heads/main",
        "event_name": "push" if stage else "workflow_dispatch",
    }
    if not stage:
        expected |= {"actor": config["production_actor"], "run_attempt": "1"}
    if any(claims.get(key) != value for key, value in expected.items()):
        raise ValueError(
            "GitHub identity is not authorized for this environment/action"
        )
    if not re.fullmatch(r"[0-9]{1,20}", claims.get("run_id", "")):
        raise ValueError("Missing GitHub run identity")
    if not re.fullmatch(r"[a-f0-9]{40}", claims.get("sha", "")):
        raise ValueError("Missing GitHub revision")


def verify(token, config, action):
    key = jwt.PyJWKClient(
        ISSUER + "/.well-known/jwks", timeout=15
    ).get_signing_key_from_jwt(token)
    claims = jwt.decode(
        token,
        key.key,
        algorithms=["RS256"],
        audience=config["oidc_audience"],
        issuer=ISSUER,
        options={"require": ["exp", "iat", "nbf", "jti", "aud", "iss"]},
        leeway=15,
    )
    policy(claims, config, action)
    if claims["exp"] - claims["iat"] > 600:
        raise ValueError("Unexpected identity lifetime")
    used = Path(config["work_dir"]) / "used-identities.json"
    records = json.loads(used.read_text()) if used.exists() else {}
    records = {j: exp for j, exp in records.items() if exp >= claims["iat"] - 30}
    if claims["jti"] in records:
        raise ValueError("GitHub identity has already been used")
    records[claims["jti"]] = claims["exp"]
    temp = used.with_suffix(".tmp")
    temp.write_text(json.dumps(records))
    temp.chmod(0o600)
    temp.replace(used)
    return claims
