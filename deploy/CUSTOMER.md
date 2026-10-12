# Fresh customer / UAT installation

Candidate procedure for 1,000 employees and 200 concurrent testers. This is not proof of a completed installation. Start with [UAT-HOSTING.md](UAT-HOSTING.md) for sizing, security acceptance, load tests and rollback. Use a disposable Linux rehearsal before installing real data. Provider, UAT DNS/access and named operators remain to be supplied.

## Boundaries and prerequisites

Use the customer branch's complete gated release. Do not copy selected files into an older build. Initial placement is app + Keycloak + private email agent + **local identity PostgreSQL + scheduled-job processes** on one 8-vCPU/24-GiB host, and a separate 4-vCPU/16-GiB HR database. No separate jobs VM is needed initially. Linux build capacity is additional. Jobs remain separate supervised processes with private credentials; they do not execute inside the Next.js request process. This sizing is provisional until the mixed 200-user/job acceptance run passes.

Install the approved patched Linux distribution, root-owned Node 24 under /opt/node24, pinned pnpm from package.json, PostgreSQL 16 client, Python 3, nginx and required Keycloak Java packages. Verify the selected OS provides the installer's pinned Java package. The existing Keycloak installer manages local identity PostgreSQL; it does not create the remote HR database. Do not substitute development database settings.

Create non-login aihr for the web runtime; use a separate authorized deployment account. Keep /opt/ai-hr and Node executables unwritable by aihr. The deployment account owns the release and a mode-0600 .env.production; aihr may traverse/read code but must not read that file. Use a root-owned mode-0700 /etc/aihr directory containing mode-0600 runtime.env. PID 1 reads runtime.env and passes only runtime credentials into the service. Never run the web app as the deployer/root.

Provision trusted HTTPS and private DNS first. Permit public HTTPS only; restrict administration to approved access, PostgreSQL to required private sources, and app/identity management listeners to loopback. Verify edge-to-origin trust. New UAT is separate from the existing consultant demo.

## 1. Create the HR database

On the HR PostgreSQL host, place the reviewed bootstrap files in a postgres-readable, non-writable directory, then run:

```bash
sudo -u postgres /secure/installation/deploy/bootstrap-db.sh
```

It prompts invisibly for owner, application and platform passwords. A secret manager may supply exactly three newline-terminated records via --stdin; never put passwords in arguments, command history or a pasted shell pipeline. The SQL creates ai_hr and roles, sets SCRAM password storage and default grants. It does not rotate existing roles or prove existing roles are safe. On anything other than a blank cluster, stop and inspect flags, memberships and existing ownership before proceeding.

Configure private TLS, certificate matching, pg_hba SCRAM rules and the required CA. Verify ai_hr_app has no superuser/BYPASSRLS/role-creation/database-creation privileges or privileged memberships. Keep ai_hr_platform credentials out of the web service; enable a separately operated control plane only if required.

Have the database operator create a distinct LOGIN role named aihr_identity_email with NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS, no memberships/ownership/table grants, and a privately generated password. The identity installer later grants only its narrow functions. Do not give it the web or migration role.

## 2. Install and configure the local identity service

Review deploy/keycloak/README.md, install.sh and configure.ts for the exact candidate. Use the approved target HTTPS origin, not the demo hostname. From the root-owned reviewed release:

```bash
cd /opt/ai-hr
sudo env AUTH_PUBLIC_ORIGIN=https://YOUR_APPROVED_UAT_HOST bash deploy/keycloak/install.sh
sudo env AUTH_PUBLIC_ORIGIN=https://YOUR_APPROVED_UAT_HOST /opt/node24/bin/node --import tsx deploy/keycloak/configure.ts
```

Replace the hostname placeholder with the approved public origin (the installer accepts HTTPS without a port/path). Installation creates a local identity database, root-owned private configuration and versioned binaries. It does not enroll the HR administrator, activate email or change the app to Keycloak. Preserve private generated files in /etc/aihr-keycloak and keep the console private.

Review the pinned artifact digest/advisories and the generated edge configuration before enabling the route. Complete the TLS proxy wiring for this target; the demo tunnel's route is not a portable customer configuration. Verify the approved public realm routes and that admin/management/test-realm routes are denied publicly.

## 3. Configure deployment and runtime secrets

Start from deploy/.env.customer.example and replace every placeholder. Merge the generated identity app configuration from /etc/aihr-keycloak into the private deployment configuration once; do not append duplicate keys. Use a shell-compatible .env.production because deploy.sh sources it. Quote values safely; never enable shell tracing. No .env, .env.local or .env.production.local may remain in the release.

The two database URLs must use distinct roles on the same HR endpoint/database. Remote connections require sslmode=verify-full and the trusted CA. Preserve the stable AI_CONFIG_SECRET and independent 64-hex AUTH_SESSION_KEY. Set AUTH_PROVIDER=keycloak and AUDIT_HASH_CHAIN_ENABLED=true. Do not set demo identities.

Create /etc/aihr/runtime.env with only reviewed runtime values: NODE_ENV, PORT, app DATABASE_URL, applicable CA settings, stable keys, audit and Keycloak configuration. Exclude MIGRATION_DATABASE_URL, all test/backup/platform credentials, NODE_OPTIONS and demo identities. The systemd unit masks deployment environment files and /etc/aihr from the running web process. Test effective privileges on Linux; configuration intent alone is insufficient.

## 4. Build and migrate in the maintenance window

The current pipeline is an in-place build. It is **not** a build-once/atomic-release system. Until a tested immutable artifact pipeline is available, use the complete release on the target with traffic blocked, application stopped and a verified previous release/backup retained. Budget build resources separately; do not build during the 200-user run.

```bash
cd /opt/ai-hr
./deploy/deploy-customer.sh --migrate-only
```

Despite its name, this installs dependencies, validates configuration, builds, migrates and seeds catalogs; it stops before service restart. Customer preflight refuses unsafe identity/audit/TLS/configuration before install/build/migration. It cannot prove credentials work or validate actual DB grants.

Never run db:seed, --demo or --reseed. Verify migration count, ordered hashes and watermark against the shipping journal. On failure, keep traffic blocked; inspect deployment state and restore/rebuild a complete artifact before any restart.

## 5. Create the first customer and pending administrator

Store a mode-0600 JSON file owned by the deploying account, for example /secure/customer/bootstrap.json:

```json
{
  "name": "UAT Organisation",
  "adminEmail": "APPROVED_ADMIN_ADDRESS",
  "baseUrl": "https://YOUR_APPROVED_UAT_HOST",
  "country": "MY",
  "modules": []
}
```

Replace placeholders. An empty modules list selects core modules only. Select optional module codes and all dependencies from packs/catalog.ts based on the agreed UAT scope; do not invent codes. For the initial operator-led UAT commissioning, use the installation owner address defined by lib/identity/bootstrap.ts as the first administrator. That policy is currently fixed by the existing realm installer, not configurable per customer. A different first owner requires an explicitly designed enrollment change; do not silently edit the constant or assume a customer HR admin can manage deployment email. Invite customer administrators afterward through the normal verified identity flow. Use a mode-0700 output directory owned by the same invoking account.

```bash
cd /opt/ai-hr
/opt/node24/bin/node --import tsx scripts/bootstrap-customer.ts --config /secure/customer/bootstrap.json
/opt/node24/bin/node --import tsx scripts/bootstrap-customer.ts --config /secure/customer/bootstrap.json --apply --activation-file /secure/customer/administrator-activation.txt
```

The first invocation checks configuration, role separation and absence of an existing customer. The second creates one tenant and a pending administrator invitation in a transaction, enables tenant audit chaining and writes the one-time link only to the new private file. It refuses an existing customer/output. An ambiguous commit retains the file: inspect database state before retrying. Do not delete evidence and blindly retry.

This does not create a Keycloak user. Through the private identity console, create/select the intended administrator and verify the exact invitation email. Configure required password change/MFA. Complete identity verification and then redeem the HR activation link while authenticated as that verified identity. Never infer HR authority from a matching token role. Preserve exact issuer/subject binding and verify the resulting internal user, tenant and grants. The activation step needs the web service in step 6 running behind the restricted UAT entry point; keep general tester access closed until commissioning finishes.

On a fresh system with mail not activated, an authorized operator must verify account ownership through the agreed out-of-band process before marking that exact identity email verified in the private console. A delivered invitation or provisioning "done" state is not successful sign-in. Do not use the demo owner UUID or keycloak-link-owner.ts with an invented existing user ID.

## 6. Install the private email agent and web service

After all migrations (including 0527), create an additional root-only installer env file containing MIGRATION_DATABASE_URL, AIHR_IDENTITY_EMAIL_DATABASE_URL (the precreated restricted role on the same remote HR DB), NODE_EXTRA_CA_CERTS and AIHR_APP_USER=aihr. No credential belongs in the command itself. If the HR database uses a private CA, also put NODE_EXTRA_CA_CERTS with the same approved absolute certificate-bundle path in /etc/aihr-keycloak/email-agent.env before installation. The installer environment is temporary and is not inherited by the installed service. Keep that CA bundle root-owned, read-only and readable by aihr-identity-email under an accessible system path such as /etc/ssl/certs; do not put it under a protected home directory. Verify certificate trust from the running service after installation.

```bash
cd /opt/ai-hr
sudo /opt/node24/bin/node --env-file=/etc/aihr/identity-install.env --import tsx deploy/identity-email/install.ts
sudo install -d -o aihr -g aihr -m 0700 /opt/ai-hr/.next/cache
sudo install -o root -g root -m 0644 deploy/aihr-customer.service /etc/systemd/system/aihr.service
sudo systemd-analyze verify /etc/systemd/system/aihr.service
sudo systemctl daemon-reload
sudo systemctl enable --now aihr
```

The installer uses the app user's actual primary group for the Unix socket, verifies the supplied role, applies narrow grants, probes its login and copies the private service runtime into a root-owned directory. It is a one-time installer; a partial failure requires inspection, not blind retries. Remove the temporary installer file through the secret-handling procedure after success. Confirm the app can use the socket but cannot read vault secrets, replace its bundle or call it from an unrelated OS account.

Verify /health and a real browser login/callback/refresh/logout, exact roles, denied cross-scope requests and privileged MFA. Health alone is insufficient. The customer web unit uses Node 24 and a 10-GiB soft/12-GiB hard memory bound. On the proposed 24-GiB host, commission aggregate budgets for web, jobs, identity/PostgreSQL/email and OS; the web cap alone does not guarantee headroom for the other services. Measure and adjust; this does not establish capacity.

After the installation owner has redeemed the invitation and the resulting group HR-admin UUID/binding has been reviewed, enroll that exact existing account as the deployment email operator using scripts/keycloak-link-owner.ts with --app-user-id=THE_REVIEWED_UUID. Run via root-owned Node 24 with the private deployment env file; never substitute the demo UUID. This preserves the existing HR grants and adds the explicit operator binding. Verify the owner login, MFA and Admin → Email delivery access. A customer HR-admin grant alone does not confer this deployment privilege. Configure the approved implicit-TLS relay; send only an explicitly approved test message, verify receipt and activate the exact tested revision. Then verify invitation/recovery. Keep workflow categories/consent off until their tests are authorized.

Migration 0528 enforces persisted audit opt-in and the existing no-disarm-after-history rule in the shared database trigger, covering raw identity and job writers as well as withTenant. Fresh bootstrap explicitly arms both the customer and reserved pre-authentication system tenant. Apply this migration before bootstrap, verify chain fields on real login/email/job events and retain the required tests. This does not backfill old unchained events or make the database owner unable to tamper; separately protected audit evidence remains a commissioning decision.

## 7. Jobs, backups and commissioning

Configure required jobs once on the application host, at the same release SHA, with /opt/node24/bin/node and private job-specific environments supplied to separate non-login service identities. Keep web, job, backup and maintenance credentials isolated. Several scripts currently require MIGRATION_DATABASE_URL/owner access; review each actual contract rather than assuming a restricted job role already works. Prefer reviewed systemd oneshot/timer definitions; existing demo units are not ready-made customer units. Do not copy the demo's ubuntu/Node20 cron or deploy/keycloak/maintenance.sh unchanged: the latter assumes readable demo .env.production.

Initially serialize heavy jobs and commission an aggregate job budget of up to 2 vCPU/4 GiB within the application host. Configure and test resource bounds, non-overlap, exit/failure alerts and interrupted-run recovery; these are installation tasks, not features automatically installed by this guide. If cron is used, use a protected flock lock; never enable cron and a timer for the same job. Keep one enabled schedule per job and stagger routine batches. The Scheduled Actions screen reports selected job outcomes; it does not run the scheduler. Do not add web-process setInterval scheduling. Run representative jobs alongside the 200-user test and verify web latency, job deadlines and at least 25% steady-load memory headroom. If contention remains after tuning, increase host capacity or move job processes to a separate host, ensuring the old schedules are disabled before the new ones start.

Run status and failure tracking in the system is a UAT requirement. Complete the [job monitoring contract in UAT-HOSTING.md](UAT-HOSTING.md#required-job-run-tracking-and-failure-visibility) before opening UAT: every enabled job needs durable run references, start/completion/interruption status, per-job history and safe failure summaries. The existing Scheduled Actions screen covers completion results for six sweeps; running/crashed states and coverage of provisioning, workflow email, backups and session maintenance remain implementation gaps. Keep private diagnostics operator-only, obtain a named alert recipient/channel, and demonstrate received failure/recovery alerts plus an external missed-heartbeat/host-outage alert. Display schedule/next-due information only from the installed scheduler's authoritative state. No new runner/monitoring functionality is installed by this document.

Session pruning must use a separate non-web maintenance account and private job environment: scripts/keycloak-session-prune.ts requires MIGRATION_DATABASE_URL, and app.identity_session_prune() is deliberately revoked from ai_hr_app. Have the DBA provision a dedicated restricted login with CONNECT on the HR database, USAGE on app and EXECUTE only on app.identity_session_prune(); supply that credential through the script's expected variable. Do not copy the owner credential into the web runtime or grant pruning to the web role. Install and test this separate job definition before checking maintenance off. Identity DB backups remain local to the identity host and need off-host transfer.

Use the hardened scripts/backup-db.sh and scripts/restore-rehearsal.sh with private environment injection. They preserve certificate verification and keep passwords out of argv; they do not provision backup storage, encryption policy, scheduling or alert recipients. Configure those explicitly. Back up HR DB, identity DB, matching secrets/vault/configuration and retained release. Rehearse recovery to isolated databases through working login and HR workflows.

Commission monitoring, controlled alerts, the 1,000-employee synthetic dataset and 200 distinct accounts. Execute the UAT-HOSTING.md checklist, denial cases, 200-user load plan, restore and rollback. Record evidence against the exact release and target. Full repo gate, Linux clean install/upgrade, live security acceptance, off-host recovery and measured 200-user capacity are separate required results. Until all pass, the installation remains preparation in progress.

## Reproduce candidate installation checks

In the repository development environment, hold both CLAUDE.md test-lock slots for every command below. Run pnpm test:customer-install as an unprivileged account with PostgreSQL 16 binaries, Python 3/libpq and OpenSSL available (PG_BIN may select the binary directory). These native tests create disposable private clusters; they are intentionally separate from Vitest and must be run in addition to the full gate. Never run their fixtures against a customer database.

The customer integration suites are test/bootstrap-customer.test.ts, test/r387-customer-env-preflight.test.ts and test/customer-identity-install.test.ts; the existing deployment, platform and identity suites cover shared behavior. Run type checking, the complete chunked repository gate and a production build on the exact candidate SHA. A clean local pass does not replace Linux service/installer and live UAT acceptance.
