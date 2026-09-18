import importlib.util
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric import rsa
import jwt

spec = importlib.util.spec_from_file_location(
    "identity", Path(__file__).with_name("identity.py")
)
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)
CONFIG = {
    "github_repository": "example/Panel",
    "environment": "production",
    "production_actor": "example",
    "oidc_audience": "test-deploy",
}


def claims():
    now = int(time.time())
    return {
        "iss": identity.ISSUER,
        "aud": "test-deploy",
        "iat": now,
        "nbf": now,
        "exp": now + 300,
        "jti": "test-identity",
        "repository": "example/Panel",
        "repository_owner": "example",
        "actor": "example",
        "ref": "refs/heads/main",
        "workflow_ref": "example/Panel/.github/workflows/production.yml@refs/heads/main",
        "event_name": "workflow_dispatch",
        "run_attempt": "1",
        "run_id": "12345",
        "sha": "a" * 40,
    }


class IdentityTest(unittest.TestCase):
    def test_only_explicit_owner_main_production_workflow_is_allowed(self):
        identity.policy(claims(), CONFIG, "deploy")
        for key, value in {
            "actor": "collaborator",
            "run_attempt": "2",
            "ref": "refs/heads/feature",
            "event_name": "push",
            "workflow_ref": "example/Panel/.github/workflows/pipeline.yml@refs/heads/main",
            "repository": "other/Panel",
        }.items():
            with self.subTest(key=key), self.assertRaises(ValueError):
                identity.policy(claims() | {key: value}, CONFIG, "deploy")

    def test_signature_audience_expiry_and_replay_are_enforced(self):
        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        fake = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(identity.jwt, "PyJWKClient") as client,
        ):
            client.return_value.get_signing_key_from_jwt.return_value = SimpleNamespace(
                key=private.public_key()
            )
            config = CONFIG | {"work_dir": temp}
            valid = jwt.encode(claims(), private, algorithm="RS256")
            self.assertEqual(
                identity.verify(valid, config, "deploy")["run_id"], "12345"
            )
            with self.assertRaisesRegex(ValueError, "already been used"):
                identity.verify(valid, config, "deploy")
            for token in (
                jwt.encode(claims(), fake, algorithm="RS256"),
                jwt.encode(
                    claims() | {"aud": "another-server"}, private, algorithm="RS256"
                ),
                jwt.encode(
                    claims() | {"exp": int(time.time()) - 60},
                    private,
                    algorithm="RS256",
                ),
            ):
                with self.assertRaises(jwt.PyJWTError):
                    identity.verify(token, config, "deploy")


if __name__ == "__main__":
    unittest.main()
