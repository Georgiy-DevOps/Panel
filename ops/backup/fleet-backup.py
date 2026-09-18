#!/usr/bin/env python3
"""Encrypted file backups with online SQLite snapshots and restore verification.

Configuration and repository passwords live outside Git in /etc/fleet-backup.
This is an application/configuration backup, not a bootable disk image.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import stat
import subprocess
import tempfile
import time


def atomic_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    os.chmod(temp, 0o600)
    temp.replace(path)


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def sqlite_snapshot(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    start = time.monotonic()

    def progress(*_):
        if time.monotonic() - start > 180:
            raise TimeoutError(f'SQLite backup timed out: {source}')

    original = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=15)
    snapshot = sqlite3.connect(destination)
    try:
        original.backup(snapshot, pages=256, progress=progress, sleep=0.1)
        rows = snapshot.execute('PRAGMA integrity_check').fetchall()
        if rows != [('ok',)]:
            raise RuntimeError(f'SQLite integrity check failed: {source}')
    finally:
        original.close()
        snapshot.close()
    return sha256(destination)


def under(path, parent):
    return path == parent or parent in path.parents


def discover_sqlite(roots, excludes):
    """Inspect headers, including extensionless PocketBase/other SQLite files."""
    found = []

    def failed(error):
        raise error

    for root in roots:
        for directory, dirs, files in os.walk(root, followlinks=False, onerror=failed):
            directory = Path(directory)
            dirs[:] = [name for name in dirs if not any(
                under(directory / name, excluded) for excluded in excludes)]
            for name in files:
                path = directory / name
                if any(under(path, excluded) for excluded in excludes):
                    continue
                try:
                    metadata = path.lstat()
                    if not stat.S_ISREG(metadata.st_mode):
                        continue
                    with path.open('rb') as source:
                        if source.read(16) == b'SQLite format 3\x00':
                            found.append(path)
                except FileNotFoundError:
                    # Transient application files are checked again by restic.
                    continue
    return sorted(set(found))


def run(config):
    os.umask(0o077)
    state = Path(config['state_directory']).resolve()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(state, 0o700)
    with (state / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        perform_backup(config, state)


def perform_backup(config, state):
    status_path = state / 'status.json'
    status = json.loads(status_path.read_text()) if status_path.exists() else {}
    status.update(status='running', started_at=dt.datetime.now(dt.timezone.utc).isoformat())
    status.pop('error', None)
    atomic_json(status_path, status)
    stage = state / 'staging'
    env = os.environ.copy()
    env.update(RESTIC_REPOSITORY=config['repository'],
               RESTIC_PASSWORD_FILE=config['password_file'],
               RESTIC_CACHE_DIR=str(state / 'cache'))

    def restic(*args, other_env=None, json_output=False, options=()):
        result = subprocess.run(['restic', *options, *args], env=other_env or env,
                                text=True, capture_output=True, check=False,
                                timeout=config.get('command_timeout_seconds', 7200))
        if result.returncode:
            # Exit 3 (incomplete snapshot) is also an error: never prune on it.
            raise RuntimeError(f'restic {args[0]} failed ({result.returncode}): '
                               + result.stderr[-2000:])
        if not json_output:
            print(result.stdout[-2000:], flush=True)
        return result.stdout

    def verify_restore(snapshot, manifest, other_env=None, options=()):
        with tempfile.TemporaryDirectory(prefix='verify-', dir=state) as target:
            restic('restore', snapshot, '--host', socket.gethostname(), '--tag', 'fleet-daily',
                   '--include', str(stage), '--target', target, '--verify',
                   other_env=other_env, options=options)
            restored_stage = Path(target) / str(stage).lstrip('/')
            restored_manifest = json.loads((restored_stage / 'manifest.json').read_text())
            if restored_manifest != manifest:
                raise RuntimeError('Restored manifest does not match this backup run')
            for entry in manifest['sqlite']:
                path = restored_stage / entry['staged']
                if sha256(path) != entry['sha256']:
                    raise RuntimeError('Restored SQLite hash mismatch: ' + entry['source'])
                connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
                try:
                    if connection.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                        raise RuntimeError('Restored SQLite is corrupt: ' + entry['source'])
                finally:
                    connection.close()

    def verify_repository(field, other_env=None, options=()):
        previous = status.get(field)
        due = not previous or (dt.datetime.now(dt.timezone.utc) -
                              dt.datetime.fromisoformat(previous)).days >= 7
        restic('check', *(['--read-data'] if due else []), other_env=other_env, options=options)
        if due:
            status[field] = dt.datetime.now(dt.timezone.utc).isoformat()

    try:
        roots = [Path(p).resolve() for p in config['roots']]
        excludes = [Path(p).resolve() for p in config.get('exclude_paths', [])]
        for root in roots:
            if not root.is_dir():
                raise RuntimeError(f'Required backup directory is missing: {root}')
        repository = config['repository']
        if not repository.startswith('/'):
            raise ValueError('The primary repository must be a local absolute path')
        if any(under(Path(repository).resolve(), root) or under(state, root) for root in roots):
            raise ValueError('Backup repository/state must be outside all source roots')
        if shutil.disk_usage(state).free < config.get('minimum_free_bytes', 2 * 1024**3):
            raise RuntimeError('Not enough free disk space; backup/retention were not run')
        if stage.exists():
            shutil.rmtree(stage)
        stage.mkdir(mode=0o700)
        databases = discover_sqlite(roots, excludes)
        missing = set(config.get('required_sqlite', [])) - {str(p) for p in databases}
        if missing:
            raise RuntimeError('Required SQLite database was not found: ' + ', '.join(sorted(missing)))
        entries = []
        for source in databases:
            destination = stage / 'sqlite' / str(source).lstrip('/')
            digest = sqlite_snapshot(source, destination)
            metadata = source.stat()
            entries.append(dict(source=str(source), staged=str(destination.relative_to(stage)),
                                sha256=digest, uid=metadata.st_uid, gid=metadata.st_gid,
                                mode=stat.S_IMODE(metadata.st_mode)))
        manifest = dict(created_at=status['started_at'], hostname=socket.gethostname(),
                        roots=[str(p) for p in roots],
                        exclude_paths=[str(p) for p in excludes], sqlite=entries)
        atomic_json(stage / 'manifest.json', manifest)
        print(f'Prepared {len(entries)} consistent SQLite snapshots', flush=True)
        args = ['backup', '--json', '--host', socket.gethostname(), '--tag', 'fleet-daily']
        # Exclude live DBs and their journals; only verified SQLite snapshots count.
        for path in excludes:
            args += ['--exclude', str(path)]
        for source in databases:
            for suffix in ('', '-wal', '-shm', '-journal'):
                args += ['--exclude', str(source) + suffix]
        args += [str(p) for p in roots] + [str(stage)]
        messages = restic(*args, json_output=True).splitlines()
        summary = next((json.loads(line) for line in reversed(messages)
                        if json.loads(line).get('message_type') == 'summary'), None)
        if not summary or not summary.get('snapshot_id'):
            raise RuntimeError('Backup did not return a snapshot ID')
        snapshot = summary['snapshot_id']
        if databases != discover_sqlite(roots, excludes):
            raise RuntimeError('SQLite database set changed during backup; retry required')
        verify_repository('local_full_checked_at')
        verify_restore(snapshot, manifest)
        status.update(local_snapshot=snapshot, sqlite_verified=len(entries),
                      local_verified_at=dt.datetime.now(dt.timezone.utc).isoformat())
        atomic_json(status_path, status)
        # Optional remote repository is initialized separately; password stays local.
        remote = config.get('remote_repository')
        if remote:
            remote_env = env | {'RESTIC_REPOSITORY': remote}
            remote_options = config.get('remote_options', [])
            restic('copy', '--from-repo', repository, '--from-password-file',
                   config['password_file'], snapshot, other_env=remote_env, options=remote_options)
            verify_repository('remote_full_checked_at', other_env=remote_env, options=remote_options)
            # copy can rewrite snapshot IDs; the exact restored manifest proves
            # that the current run (not just an older remote snapshot) is present.
            verify_restore('latest', manifest, other_env=remote_env, options=remote_options)
            status['remote_verified_at'] = dt.datetime.now(dt.timezone.utc).isoformat()
            atomic_json(status_path, status)
            retention = config.get('retention', {'daily': 14, 'weekly': 8, 'monthly': 6})
            if not config.get('remote_append_only', False):
                restic('forget', '--tag', 'fleet-daily', '--host', socket.gethostname(),
                       '--group-by', 'host,tags', '--keep-daily', str(retention['daily']),
                       '--keep-weekly', str(retention['weekly']), '--keep-monthly', str(retention['monthly']),
                       '--prune', other_env=remote_env, options=remote_options)
        retention = config.get('retention', {'daily': 14, 'weekly': 8, 'monthly': 6})
        restic('forget', '--tag', 'fleet-daily', '--host', socket.gethostname(),
               '--group-by', 'host,tags', '--keep-daily', str(retention['daily']),
               '--keep-weekly', str(retention['weekly']), '--keep-monthly', str(retention['monthly']),
               '--prune')
        status.update(status='ok', last_success=dt.datetime.now(dt.timezone.utc).isoformat())
        atomic_json(status_path, status)
        print(f'Backup and SQLite restore verified: {snapshot}', flush=True)
    except Exception as error:
        status.update(status='failed', error=str(error),
                      failed_at=dt.datetime.now(dt.timezone.utc).isoformat())
        atomic_json(status_path, status)
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default='/etc/fleet-backup/config.json')
    arguments = parser.parse_args()
    run(json.loads(Path(arguments.config).read_text()))
