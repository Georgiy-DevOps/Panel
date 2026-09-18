# CI/CD verification, 2026-09-19 (MSK)

Verified before GitHub publication:

- Panel: 22 Node tests passed; 96.87% line coverage in the declared server/shared modules (minimum 70%). Prettier, ESLint, Black and Ruff passed.
- Linux: 5 vehicle reporting integration tests, 9 SSH-alert tests, 1 real Restic backup/WAL restore/cross-repository copy test, and 12 deployment/identity/approval tests passed. Python coverage is informational (51%); it is not presented as 70% application coverage.
- npm and Python dependency audits found no known vulnerabilities at verification time.
- Gitleaks found no secrets in existing repository history; new commits are scanned again before publication.
- actionlint with Linux ShellCheck accepted Panel pipeline, manual production, rollback and ByteDepp Android workflows.
- Docker image built successfully. Initial scan found CVE-2026-59873 in npm's bundled `tar`. Runtime package managers were removed because the panel uses Node built-ins. Rescan found zero CRITICAL findings without an ignore list or `--ignore-unfixed`.
- Staging `panel-staging-panel-1` is healthy on loopback port 3081, with its own empty database/volume and a separate generated administrator password. It is not a public endpoint.
- On real staging Docker containers: snapshot preflight, successful deployment, injected post-cutover health failure with automatic restoration of the old image, and explicit rollback all passed. The final staging image is the scanned candidate. These tests were administrator-run against local images; they do not substitute for an actual GitHub OIDC/GHCR workflow run.
- Both restricted SSH accounts accepted their dedicated keys and refused a deployment request with an invalid OIDC token.
- Production `app-panel-1` retained the same container ID and start time throughout deployment tests. It was not updated or restarted.

Remaining activation steps: publish branches, run actual GitHub PR checks, configure repository variables/secrets, confirm main protection is enforced, review/merge PRs, verify the first main-to-staging delivery. Production requires the owner's separate manual dispatch. GitHub authentication, repository permissions and plan support must be confirmed; files alone do not activate GitHub settings.

ByteDepp Android builds/lint and unit tests passed; whole-app Java coverage is 1.85%, SigningPolicy 100%. Its resolved dependency SBOM scan found no HIGH/CRITICAL findings. Release signing and vehicle installation remain deferred.
