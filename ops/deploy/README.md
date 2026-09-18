# Panel CI/CD

PR to `main` runs format, lint, Node tests (70% line coverage gate on server/shared logic), Linux integration and recovery tests, full-history Gitleaks, npm/pip audits, Docker build and Trivy (any CRITICAL blocks). Python coverage is reported without a global threshold. PR code receives no deployment keys, write token or production data. Use GitHub-hosted runners, never a runner on production for PRs.

After merge, the same scanned image is published to GHCR with the full commit SHA and deployed by immutable digest to staging. It is not rebuilt between scan, staging and production. Staging has its own empty databases, volume and password, and listens only on `127.0.0.1:3081`.

Production requires a separate **Deploy production** workflow dispatch by `Kirill-DevSecOps` from `main`. Enter the successful **Panel pipeline run ID** and `DEPLOY`. The workflow verifies success of that main run and downloads its staging receipt. No automatic production deployment runs on push. This is a manual workflow, not GitHub Enterprise's environment approval UI.

The host also verifies GitHub OIDC signature, issuer, audience, expiry, repository, exact workflow, `main`, event, actor and first run attempt. Tokens cannot be reused. The restricted SSH key alone cannot authorize a deployment. A production digest/revision/run must match the currently verified staging state; deploying an older staging artifact requires restaging it. Owner reruns are deliberately rejected: start a new manual dispatch instead.

## Initial host setup

`install.py` is explicit root maintenance code. Review paths before running it on another host. It expects the existing `app-panel-1`, production volume `app_fleet_data`, production `.env` at `/srv/fleet-control/app/.env`, and ByteDepp SQLite at `/srv/bytedepp/bytedepp.sqlite3`. It checks the layout and does not restart production. Bootstrap requires an already-scanned local image:

```sh
python3 ops/deploy/install.py --bootstrap-image sha256:REVIEWED_IMAGE_ID --host SERVER_IP
```

It creates:

- Root-owned controller/venv at `/usr/local/lib/panel-cd` and configs in `/etc/panel-cd`.
- `panel-staging` and `panel-production` accounts: forced command, no PTY/forwarding, no Docker group, only an exact sudo command. The controller cannot be edited by these accounts.
- Separate keys `/etc/panel-cd/keys/staging` and `production` (root-only).
- Staging volume `panel_staging_data`, empty ByteDepp database and separate `.env` under `/srv/fleet-control/staging`.
- Random staging password in `/etc/panel-cd/staging-password.txt`, root-only. Retrieve through your authenticated SSH session; never commit it.

No SSH root/password settings, firewall, production credentials, Telegram, Beszel or backup schedules are changed.

## GitHub configuration (required before merge)

Use an authenticated official `gh` CLI with access to this private repository and the `workflow` scope. From the Panel root:

```sh
gh auth login --hostname github.com --git-protocol https --web --scopes workflow
python ci/configure_github.py --ssh-key /path/to/authorized/key --known-hosts /path/to/verified/known_hosts --host SERVER_IP
```

The helper reads only the two new CD private keys through authenticated SSH and sends them directly to GitHub **repository secrets** via stdin. It does not display them or write local copies. It also sets the variables and applies main protection. It never triggers production. Pass `--gh /path/to/gh` if needed. Run only in a trusted administrator session.

Manual equivalent, Settings → Secrets and variables → Actions:

| Name                              | Kind     | Value                                                                       |
| --------------------------------- | -------- | --------------------------------------------------------------------------- |
| `STAGING_SSH_KEY`                 | Secret   | `/etc/panel-cd/keys/staging`                                                |
| `PRODUCTION_SSH_KEY`              | Secret   | `/etc/panel-cd/keys/production`                                             |
| `STAGING_HOST`, `PRODUCTION_HOST` | Variable | `84.21.173.88`                                                              |
| `STAGING_USER`                    | Variable | `panel-staging`                                                             |
| `PRODUCTION_USER`                 | Variable | `panel-production`                                                          |
| `STAGING_PORT`, `PRODUCTION_PORT` | Variable | `22`                                                                        |
| `STAGING_AUDIENCE`                | Variable | `panel-cd:84.21.173.88:staging`                                             |
| `PRODUCTION_AUDIENCE`             | Variable | `panel-cd:84.21.173.88:production`                                          |
| `DEPLOY_KNOWN_HOSTS`              | Variable | Verified server host-key line; do not obtain trust with blind `ssh-keyscan` |

`GITHUB_TOKEN` is automatic: write to GHCR only in publishing, read during deployments, short-lived and kept in a temporary Docker config. Keep the GHCR package private and grant this repository Actions access if package permissions were customized.

`ci/main-protection.json` requires a PR, up-to-date `Panel CI`, resolved conversations, no direct/force pushes, no deletion, including administrators. It allows zero approving reviews so a sole owner can merge their own PR after CI; add a second reviewer and raise the requirement to one when available. For private repos GitHub requires an eligible paid plan for branch protection. A JSON file does **not** activate protection; API/Settings must confirm it. If GitHub returns 403/upgrade required, do not claim protection is active or merge unchecked code. Keep repository write/admin access limited, and review workflow/controller changes carefully.

## Access staging

```sh
ssh -N -L 3081:127.0.0.1:3081 root@84.21.173.88
```

Select your personal SSH key in Termius or add `-i` for OpenSSH. Open `http://127.0.0.1:3081/admin`. The CD accounts cannot open tunnels; use your own account. Staging uses test data, not production customers/VINs.

## Cutover and rollback

Before cutover, the controller pulls the digest, verifies its revision label, takes SQLite backup-API snapshots (including committed WAL), and verifies database integrity. It tests the candidate on writable snapshot copies in a network-isolated container, then checks that the old version can read the migrated copy. Only then does Compose recreate the target service with the new image. Container health, HTTP pages, protected admin API and host health URL must pass. Real production passwords/cookies are not placed in test artifacts.

An error before cutover leaves the live container alone. A startup/health error after cutover restores the previous image and checks it. A Compose recreate can cause a short interruption; this is not blue/green zero-downtime deployment. Loss of the host, Docker or power can still need operator recovery. Smoke tests cannot prove compatibility of every query: use backward-compatible additive database migrations. Automatic rollback never overwrites live databases, which could discard new writes.

**Roll back production** is a separate owner-only dispatch with `ROLLBACK`. It restores the server-recorded previous image, not an arbitrary user-supplied tag. Current/previous are in `/var/lib/panel-cd/production/state.json`. Retain those images; do not prune them. For a stopped/missing production container or state drift, investigate and recover through administrator SSH; the controller fails closed. If an image rollback cannot restore service because of data damage, use the consistent snapshots under `/var/backups/panel-deploy/production` and the independent Restic backups under an explicit recovery plan. Snapshots have no automatic retention deletion; include them in capacity monitoring.

## Moving servers

Workflows and GHCR stay in GitHub. Copy/restore the application databases, production `.env`, ByteDepp source, controller, configs, deployment state and required previous image to the new host. Verify backups and host key, create new restricted CD keys, update host/key/audience variables and secrets, test staging, then approve production. Remove old CD keys after the move. Paths and resource limits are configurable; no server IP is embedded in the workflow code.

This initial configuration keeps both environments on one host and checks its local staging receipt under one lock. Splitting staging and production across hosts additionally requires an authenticated receipt-transfer design; merely changing one host variable is insufficient.
