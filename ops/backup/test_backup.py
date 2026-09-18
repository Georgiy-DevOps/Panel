"""Linux integration test against an isolated real restic repository."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest


spec = importlib.util.spec_from_file_location('fleet_backup', Path(__file__).with_name('fleet-backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


@unittest.skipUnless(shutil.which('restic'), 'restic is required')
class BackupRecoveryTest(unittest.TestCase):
    def test_live_wal_recovery_and_failed_run_does_not_prune(self):
        with tempfile.TemporaryDirectory(prefix='fleet-backup-test-') as temp:
            base = Path(temp)
            source = base / 'source'
            source.mkdir()
            (source / 'config.txt').write_text('restore this file')
            password = base / 'password'
            password.write_text('fixture-only-password-never-used-on-a-server')
            live = source / 'fleet.sqlite'
            connection = sqlite3.connect(live)
            try:
                connection.execute('PRAGMA journal_mode=WAL')
                connection.execute('PRAGMA wal_autocheckpoint=0')
                connection.execute('CREATE TABLE vehicles (vin TEXT)')
                connection.execute("INSERT INTO vehicles VALUES ('TEST-VIN')")
                connection.commit()
                self.assertTrue(Path(str(live) + '-wal').exists())
                config = dict(repository=str(base / 'repo'), password_file=str(password),
                              state_directory=str(base / 'state'), roots=[str(source)],
                              required_sqlite=[str(live)], minimum_free_bytes=0)
                env = os.environ | {'RESTIC_REPOSITORY': config['repository'],
                                    'RESTIC_PASSWORD_FILE': str(password)}
                subprocess.run(['restic', 'init'], env=env, check=True, capture_output=True)
                backup.run(config)
                status = json.loads((base / 'state/status.json').read_text())
                self.assertEqual(status['status'], 'ok')
                self.assertEqual(status['sqlite_verified'], 1)
                restored = base / 'restored'
                subprocess.run(['restic', 'restore', status['local_snapshot'], '--target',
                                str(restored), '--verify'], env=env, check=True, capture_output=True)
                staged = restored / str(base / 'state/staging').lstrip('/')
                manifest = json.loads((staged / 'manifest.json').read_text())
                db = sqlite3.connect(staged / manifest['sqlite'][0]['staged'])
                try:
                    self.assertEqual(db.execute('SELECT vin FROM vehicles').fetchall(), [('TEST-VIN',)])
                finally:
                    db.close()
                self.assertEqual((restored / str(source).lstrip('/') / 'config.txt').read_text(), 'restore this file')
                self.assertFalse((restored / str(live).lstrip('/')).exists())
                self.assertFalse((restored / (str(live).lstrip('/') + '-wal')).exists())
                mirror_env = env | {'RESTIC_REPOSITORY': str(base / 'mirror')}
                subprocess.run(['restic', 'init'], env=mirror_env, check=True, capture_output=True)
                config['remote_repository'] = str(base / 'mirror')
                backup.run(config)
                status = json.loads((base / 'state/status.json').read_text())
                self.assertIn('remote_verified_at', status)
                self.assertIn('remote_full_checked_at', status)
                remote_snapshots = subprocess.run(['restic', 'snapshots', '--json'], env=mirror_env,
                                                 check=True, capture_output=True, text=True)
                self.assertEqual(len(json.loads(remote_snapshots.stdout)), 1)
                config['required_sqlite'].append(str(source / 'missing.sqlite'))
                with self.assertRaisesRegex(RuntimeError, 'Required SQLite'):
                    backup.run(config)
                failure = json.loads((base / 'state/status.json').read_text())
                self.assertEqual(failure['status'], 'failed')
                self.assertEqual(failure['last_success'], status['last_success'])
                self.assertFalse((base / 'state/staging').exists())
                snapshots = subprocess.run(['restic', 'snapshots', '--json'], env=env,
                                           check=True, capture_output=True, text=True)
                self.assertEqual(len(json.loads(snapshots.stdout)), 2)
            finally:
                connection.close()


if __name__ == '__main__':
    unittest.main()
