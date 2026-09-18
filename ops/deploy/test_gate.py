import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "gate", Path(__file__).resolve().parents[2] / "ci/check_production_gate.py"
)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class GateTest(unittest.TestCase):
    def test_only_successful_main_delivery_can_be_promoted(self):
        good = {
            "repository": {"full_name": "example/Panel"},
            "event": "push",
            "head_branch": "main",
            "path": ".github/workflows/pipeline.yml",
            "status": "completed",
            "conclusion": "success",
            "head_sha": "a" * 40,
        }
        self.assertEqual(gate.verify_run(good, "example/Panel"), "a" * 40)
        for key, value in {
            "event": "pull_request",
            "head_branch": "feature",
            "conclusion": "failure",
            "status": "in_progress",
            "path": ".github/workflows/other.yml",
            "head_sha": "main",
            "repository": {"full_name": "attacker/Panel"},
        }.items():
            with self.subTest(key=key), self.assertRaises(ValueError):
                gate.verify_run(good | {key: value}, "example/Panel")


if __name__ == "__main__":
    unittest.main()
