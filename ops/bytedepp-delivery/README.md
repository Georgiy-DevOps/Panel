# ByteDepp: publication approved in Telegram

Installed on 84.21.173.88. This is a server-folder workflow, not a GitHub workflow.
It does not change the Android repository. Bundle mode publishes already-built
APKs and catalogs alongside server application files; it does not build, sign or
install APKs on vehicles.

## Artem

Connect using the existing personal key:

```sh
ssh -i ~/.ssh/id_ed25519 ArtemDeveloper@84.21.173.88
cd /srv/bytedepp/server
```

This path now mounts `/srv/bytedepp-development` on the host. It is a development
copy, not the live source. The current live file was preserved before switching.
The Mac checkout and uncommitted changes were not modified.

Edit `server/` and `lynkco900/` under `/srv/bytedepp`, then submit from a separate terminal on the Mac:

```sh
ssh -i ~/.ssh/id_ed25519 ArtemDeveloper@84.21.173.88 bytedepp-submit
ssh -i ~/.ssh/id_ed25519 ArtemDeveloper@84.21.173.88 bytedepp-status
```

Submission snapshots both folders with per-file hashes, runs Python syntax,
isolated reporting/license regression tests, startup, health, static delivery,
JSON parsing and APK ZIP/manifest/CRC checks. These do not verify the APK signer
or prove that an APK is safe or compatible with a vehicle. Only a passing
snapshot produces approval buttons. No production credentials or data are used
in these initial tests. Subsequent edits require a new submission.

## Owner

The existing bot sends **Обновить** and **Отклонить** to the configured private
owner chat. Approval checks both the sender ID and private chat ID, exact message
ID, random release ID, pending state and 24-hour expiration. A newer submission
invalidates previous pending releases. Repeated clicks cannot repeat deployment.

After approval, startup is checked against an empty database with the production
schema, with no network and discarded application output. No production rows are
copied into the test environment. Any schema or data change during this startup
blocks deployment. Production code and static files must still match the baseline hash.

The controller stops only ByteDepp, saves the live code, catalogs and SQLite backup,
switches both folders and checks health after restart. Failure restores both previous
folders. **Database backups are retained but not automatically restored**: automatic
restoration could discard newly received writes. An interrupted deployment is
not automatically repeated; startup recovery restores the saved old code if the
deployment had reached that point. Administrator inspection may still be needed.

## Boundaries

- Bundle mode (`/srv/bytedepp-development/.bundle-mode`, root-owned) delivers
  `server/` and `lynkco900/`. The Python entry point remains mandatory. Database
  files, keys, `.env`, systemd units, Python caches and Git metadata are excluded
  from server files. Root-level production databases are never selected.
- Deleting a working file requests its removal from the next production bundle.
  macOS metadata (`._*` and `.DS_Store`) is excluded from both folders.
  Telegram reports added, modified and removed file counts before approval.
- Symlinks, hardlinks, special files and files changing during snapshot are rejected.
  Snapshot files cannot be changed by the developer after submission.
- New OS/Python dependencies, launch configuration and database migrations require
  administrator work; deployment does not run package installers supplied by code.
- No host shell, Docker socket, Panel files, production DB or backups are mounted
  into Artem's development container. Production restart permission was removed.
- The app runs under its existing service account. Approved code can access the
  data available to that application; automated tests cannot prove code harmless.
- Docker uses the host kernel; this is not separate-VM isolation.
- Controller and configuration are root-owned. Credentials never enter development
  mounts, Git, command-line arguments or logs. Existing SSH alerts remain separate.
- Bundles are limited to 8 GiB/20000 files, one active test/deployment, one submission
  per minute and ten retained bundle archives, with 24 GiB free disk required.
  Legacy single-file mode retains its earlier limits. Administrator maintenance is required at the
  archive limit; no user data is automatically deleted.

Controller: `/usr/local/lib/bytedepp-delivery/controller.py`.
State and release backups: `/var/lib/bytedepp-delivery` (root only).
Service: `bytedepp-delivery.service`.
Initial access/source backup: `/root/bytedepp-approval-bootstrap`.

Installation is intentionally one-time and refuses existing directories. Do not
rerun `install.py` to upgrade: review and replace controller files separately.
The initial installer enables legacy single-file mode. Bundle upgrades additionally
install `bundle_delivery.py`, update checks and copy only reviewed application/static
files to the development folder before creating the root-owned marker. Preserve
existing developer files and never copy the production database into that folder.
Tests: `python3 -m unittest discover -s ops/bytedepp-delivery -p 'test_*.py'`.
