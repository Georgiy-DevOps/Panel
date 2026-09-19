# ByteDepp: publication approved in Telegram

Installed on 84.21.173.88. This is a server-folder workflow, not a GitHub workflow.
It does not change the Android repository or publish APKs.

## Artem

Connect using the existing personal key:

```sh
ssh -i ~/.ssh/id_ed25519 ArtemDeveloper@84.21.173.88
cd /srv/bytedepp/server
```

This path now mounts `/srv/bytedepp-development` on the host. It is a development
copy, not the live source. The current live file was preserved before switching.
The Mac checkout and uncommitted changes were not modified.

Save `bytedepp_server.py`, then submit from a separate terminal on the Mac:

```sh
ssh -i ~/.ssh/id_ed25519 ArtemDeveloper@84.21.173.88 bytedepp-submit
ssh -i ~/.ssh/id_ed25519 ArtemDeveloper@84.21.173.88 bytedepp-status
```

Submission snapshots the file, runs Python syntax, isolated reporting/license
regression tests, startup, health and static-fixture checks. Only a passing
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
blocks deployment. Production source must still match the baseline hash.

The controller stops only ByteDepp, saves the live code and SQLite backup, replaces
the approved source and checks health after restart. Failure restores the previous
code. **Database backups are retained but not automatically restored**: automatic
restoration could discard newly received writes. An interrupted deployment is
not automatically repeated; startup recovery restores the saved old code if the
deployment had reached that point. Administrator inspection may still be needed.

## Boundaries

- Only `server/bytedepp_server.py` is delivered. APKs, static catalogs, systemd
  units, additional modules and migrations require separate reviewed work.
- No host shell, Docker socket, Panel files, production DB or backups are mounted
  into Artem's development container. Production restart permission was removed.
- The app runs under its existing service account. Approved code can access the
  data available to that application; automated tests cannot prove code harmless.
- Docker uses the host kernel; this is not separate-VM isolation.
- Controller and configuration are root-owned. Credentials never enter development
  mounts, Git, command-line arguments or logs. Existing SSH alerts remain separate.
- Submission is limited to 2 MiB, one active test/deployment, one submission per
  minute and 100 archived releases. Administrator maintenance is required at the
  archive limit; no user data is automatically deleted.

Controller: `/usr/local/lib/bytedepp-delivery/controller.py`.
State and release backups: `/var/lib/bytedepp-delivery` (root only).
Service: `bytedepp-delivery.service`.
Initial access/source backup: `/root/bytedepp-approval-bootstrap`.

Installation is intentionally one-time and refuses existing directories. Do not
rerun `install.py` to upgrade: review and replace controller files separately.
Tests: `python3 -m unittest discover -s ops/bytedepp-delivery -p test_controller.py`.
