# Customer runtime isolation

This runbook replaces the demo's service and environment setup in `DEPLOY.md`. It is a deployment
template, not evidence that an existing server has these controls installed. Use a dedicated customer
host/network and a supported Linux distribution with systemd (Ubuntu 24.04 LTS is the reference).
Do not install this profile over the shared consultant demo during an ordinary code release.
Use [PRODUCTION-ARCHITECTURE.md](PRODUCTION-ARCHITECTURE.md) for the 4,000-employee launch topology,
capacity assumptions, security boundaries and rollout requirements.

The operating-system identities have different jobs:

| Identity | Can read | Can change |
|---|---|---|
| Deployment operator | `/opt/ai-hr/.env.production`, including the migration DB credential | Release files, builds, migrations; narrowly authorized service restarts |
| `aihr` web service | Runtime values supplied by systemd; application files | Its private temporary directory, `.next/cache`, application DB rows permitted by RLS |
| `root` / systemd | `/etc/aihr/runtime.env` | Service configuration and host controls |

The `aihr` account has no login shell, SSH key, sudo rule, deployment-group membership or ownership of
the application code. Merely removing the owner URL from the process environment is insufficient if
the same account can read it again from disk. The customer unit hides all Next environment files in
the application directory as well as dropping migration and demo variables. It binds only to
`127.0.0.1:3000`; an authenticated HTTPS reverse proxy or controlled tunnel must front it. PostgreSQL
must listen only on loopback/a private network and accept only the necessary application/admin hosts.

## 1. Prepare accounts, runtime and release files

Install a currently patched Node 22 distribution at `/opt/node22`, owned by root and unwritable by
`aihr`. Install PostgreSQL 16 clients and your package manager for the deployment operator. Keep the
operator's account separate from the account created below. Run this once on the new customer host:

```bash
sudo useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin aihr
sudo install -d -o root -g root -m 0700 /etc/aihr
sudo install -o root -g root -m 0600 /dev/null /etc/aihr/runtime.env
```

If `aihr` already exists, inspect its groups, login shell, sudo rights, keys and owned files first;
do not assume an existing account is isolated. Sync the reviewed release into `/opt/ai-hr` as the
deployment operator. Its directories must be traversable and code readable by `aihr`, but neither
the release tree nor its parent may be writable by `aihr`. Preserve executable bits. Do not run a
recursive `chown aihr` on the code tree. Keep SSH keys, backups and all unrelated services outside it.

Bootstrap a fresh database through `sudo -u postgres deploy/bootstrap-db.sh` as described in
`DEPLOY.md`. Store the three generated passwords in the approved secret manager. New customer data
must start in an empty database, never the consultant demo database or a copy containing demo rows.

## 2. Configure deployment and runtime separately

As the deployment operator, create `.env.production` from `deploy/.env.customer.example`, restrict it
to owner-only permissions (`chmod 0600 .env.production`), and populate all required values before
running any customer deployment, including `--migrate-only`:

- The distinct app and migration DB URLs.
- `AUDIT_HASH_CHAIN_ENABLED=true`, a strong stable `AI_CONFIG_SECRET`, and `SHARE_PASSWORD`.
- `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, and the exact HTTPS
  `NEXT_PUBLIC_WORKOS_REDIRECT_URI` ending in `/callback`. Configure that callback in the WorkOS
  environment first, and require MFA/appropriate access policy there.
- `NODE_ENV=production` and `PORT=3000`.

Remove `.env`, `.env.local`, and `.env.production.local` from the release directory. Customer deploys
refuse these extra files because Next could load conflicting credentials or demo identity flags.
Never add `ALLOW_DEMO_SESSION`, `DEV_TENANT_ID` or `DEV_USER_ID`. The demo cutover runbook's temporary
identity-switcher and rollback steps do not apply to a customer deployment.

Use `sudoedit /etc/aihr/runtime.env` to add only the runtime allowlist below, with the same values as
the corresponding deployment settings. This root-owned file is read by systemd; the service account
cannot open it directly. Keep one simple `KEY=value` assignment per line, without shell commands or
variable expansion. Store values safely in the secret manager; never print a filled environment file.

```dotenv
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://ai_hr_app:REPLACE_WITH_APP_PASSWORD@localhost:5432/ai_hr
AI_CONFIG_SECRET=REPLACE_WITH_STABLE_RANDOM_SECRET
AUDIT_HASH_CHAIN_ENABLED=true
SHARE_PASSWORD=REPLACE_WITH_RANDOM_GATE_PASSWORD
WORKOS_API_KEY=REPLACE_WITH_WORKOS_API_KEY
WORKOS_CLIENT_ID=REPLACE_WITH_WORKOS_CLIENT_ID
WORKOS_COOKIE_PASSWORD=REPLACE_WITH_RANDOM_COOKIE_PASSWORD
NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://REPLACE_WITH_CUSTOMER_HOST/callback
```

Do not include `MIGRATION_DATABASE_URL`, backup storage credentials, test URLs or demo identities.
Add `PLATFORM_DATABASE_URL` only when the operator/control-plane features are intentionally enabled;
that role bypasses tenant RLS for its explicitly granted tables, so keep it out of a customer-only
runtime. Likewise add only the provider/runtime settings a deliberately enabled feature requires.
The platform pool is not a replacement for the app URL. Treat both environment files as secret
material in rotation and recovery procedures, with changes applied to both where a value is shared.
The unit validates these effective runtime values before every start, independently of the deploy
preflight. A stale/missing WorkOS setting, disabled audit chain or non-production runtime must refuse
to start rather than reopen a demo authentication path.

## 3. Build, then prepare the cache and install the unit

Run the customer path as the deployment operator under Node 22. The `--migrate-only` flag still builds
and runs migrations/catalog provisioning but leaves service restart to the following controlled step:

For an **update to an existing installation**, first take that app host out of the load balancer,
stop its service, and hand the private cache back to the deployment operator before building. The
previous runtime's `0700` cache must not strand the next build under a different account:

```bash
cd /opt/ai-hr
sudo systemctl stop aihr
sudo chown -R "$(id -u):$(id -g)" /opt/ai-hr/.next/cache
```

For a fresh installation skip those two service/cache handoff commands. Then build and install:

```bash
cd /opt/ai-hr
PATH=/opt/node22/bin:$PATH ./deploy/deploy-customer.sh --migrate-only
sudo install -d -o aihr -g aihr -m 0700 /opt/ai-hr/.next/cache
sudo chown -R aihr:aihr /opt/ai-hr/.next/cache
sudo chmod -R u+rwX,go-rwx /opt/ai-hr/.next/cache
sudo install -o root -g root -m 0644 deploy/aihr-customer.service /etc/systemd/system/aihr.service
sudo systemd-analyze verify /etc/systemd/system/aihr.service
sudo systemctl daemon-reload
sudo systemctl enable --now aihr
```

The unit is intentionally installed **as `aihr.service`**, the name deployment tooling restarts.
After later builds, repeat cache ownership/permissions before `sudo systemctl restart aihr`; builds
can recreate it as the deployment operator. Do not grant `aihr` permission to run `sudo`. If unattended
restarts are needed, authorize only the deployment operator for the exact `systemctl restart aihr`
command. Schedule a maintenance window: the current build/deploy path replaces `.next` in place and
is not an atomic release switch.

The source currently has no application-side persistent file writer for uploads/documents; these
are stored/read through application data paths. Next needs its `.next/cache`; private `/tmp` remains
available. `ProtectSystem=strict` keeps the remaining release filesystem read-only for the service.
Recheck file writes if adding ISR/file-backed storage. Node's JIT needs executable memory, so the unit
does not use `MemoryDenyWriteExecute`. Review the [systemd execution controls](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)
against the target OS. The 6 GiB/7 GiB memory bounds assume a dedicated 8 GiB application host with
PostgreSQL, builds and batch workers elsewhere. They are starting settings, not a load-tested capacity
claim; watch cgroup memory and tune to the host/workload. Do not copy these limits onto the small
shared demo server.

## 4. Verify isolation and the real customer journey

Inspect the effective installed unit and runtime without printing its environment values:

```bash
sudo systemctl show aihr -p User -p Group -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p ReadWritePaths -p InaccessiblePaths -p UnsetEnvironment
sudo systemd-analyze security aihr.service
sudo -u aihr test ! -r /opt/ai-hr/.env.production
sudo -u aihr test ! -r /etc/aihr/runtime.env
sudo -u aihr test ! -w /opt/ai-hr
sudo -u aihr test -w /opt/ai-hr/.next/cache
sudo systemctl status aihr --no-pager
```

The file-access checks are intentionally outside the service namespace: account permissions must
protect secrets even if a process is launched outside systemd. Confirm `.next/cache` is the only
service-owned release directory and `aihr` has no sudo capability. Check listening ports, public HTTPS
and certificate renewal; 3000 and 5432 must not be reachable from the public internet. Verify sign-in,
callback, logout, missing-access refusal, payroll/PDF rendering and attachment authorization using
non-sensitive acceptance data. Inspect the service journal for permission/cache/render errors without
exporting secrets or HR records. A healthy HTTP status alone does not prove these workflows render.

Provision the tenant and bind its first real admin through the operator/provisioning workflow.
**Manual prerequisite:** a completely fresh installation also needs its first authorized platform
operator identity created and bound to WorkOS before that workflow is reachable. There is no completed
one-command first-operator bootstrap in this runbook; prepare and review that privileged procedure
with the owner before opening access. A new customer has no seeded admin; do not bypass that by
enabling the demo switcher. Keep import of real
employee records closed until the authentication, cross-tenant access, audit, recovery and monitoring
checks have passed on this specific installation.

## 5. Scheduled jobs and recovery are separate identities/configuration

Do not copy the demo's cron commands or `deploy/systemd/*` units unchanged: they currently use Node 20
and read the combined `.env.production`. Configure required application sweeps with Node 22 and a
dedicated non-login job identity, a root-owned environment containing only its required DB/runtime
credentials, and the same read-only code/secret separation. Provisioning/migrations and other jobs
that legitimately need owner privileges run as separate operator jobs, never inside the web service.
Choose schedules that do not overlap backups/deploys. Confirm successful job records, catch-up
semantics, alert delivery and last-success age before enabling business-changing sweeps.

`scripts/backup-db.sh` and `scripts/restore-rehearsal.sh` provide dump/verification tools, not an
installed backup service. Configure an encrypted off-host destination and separate backup identity;
keep its DB/storage credentials inaccessible to web and ordinary job accounts. A daily dump alone
can lose nearly a day of writes: agree the customer's recovery point/time objectives and enable
PostgreSQL PITR through continuous WAL archiving to the independent backup host/storage. The private
cloud design uses a self-managed PostgreSQL 16 primary/standby pair: require certificate-verified TLS
for remote DB connections, restricted replication credentials, tested failover/fencing, and a named
operator responsible for patching, replication lag, WAL retention and recovery. A standby is not a
backup. Rehearse both failover and archive-based point-in-time recovery. Choose retention and immutability that meet
the actual contract. Schedule the backup, route both failure and stale-success alerts to an owner,
and complete an isolated restore rehearsal before sensitive data is loaded. Do not restore customer
dumps onto developer laptops. Record measured recovery time and latest recoverable timestamp; do
not infer them from a successful upload or a timer being enabled.

Bootstrap credential regression checks can be run locally with PostgreSQL 16 binaries available:
`node --test test/bootstrap-db.node.test.mjs`. They start a temporary isolated cluster and do not use
the application's database. This does not validate the Linux service sandbox; validate that on the
target customer staging host before cutover.
