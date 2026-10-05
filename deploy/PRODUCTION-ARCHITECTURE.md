# Production resources and protection of HR data

This is a proposed deployment design, not evidence that a server has been provisioned or certified.
Revalidate capacity, provider features and software security releases before purchase or launch.
Use `CUSTOMER.md` for installation and `../docs/CUSTOMER-DEPLOYMENT-READINESS.md` for acceptance evidence.

## Starting capacity

REQUIREMENT: 4,000 employees at launch, increasing gradually (owner, 5 October 2026).
REQUIREMENT: newly procured servers in the owner's private cloud; database and host operations are
the owner's responsibility, unless separately contracted. No managed public-cloud database is assumed.
ASSUMPTION: 100–200 active users plus concentrated morning clock-in traffic, with externally hosted AI
inference. Active users are not all issuing requests simultaneously. These are load-test inputs, not
tested capacity guarantees. Peak traffic, payroll size, attachment growth and budget remain unknown.

| Component | Initial allocation | Purpose and limits |
|---|---|---|
| Application | 2 instances, each 4 vCPU, 8 GiB RAM, 60 GiB encrypted SSD | Dedicated private app instances across independent zones; complete the multi-instance checks below before serving traffic from both. No unrelated applications. |
| PostgreSQL 16 | 2 VMs, each 4 vCPU, 16 GiB RAM, 40 GiB OS plus 200 GiB encrypted SSD data volume | Dedicated primary and streaming standby on independent compute/storage failure domains. Size data/WAL IOPS and attachment growth. The standby is not extra application write capacity. |
| Scheduled jobs | 2 vCPU, 4 GiB RAM, 40 GiB encrypted SSD | One private job runner, using the same release as the web service. Run existing CLI jobs on one scheduler. Verify retry/idempotency before adding workers. |
| Build runner | 4 vCPU, 16 GiB RAM, 60 GiB temporary storage | Linux x86_64, matching the runtime and supported Node release. Build away from the live web/database host. No employee data in CI. |
| Edge | Private-cloud HA load balancer/WAF; if unavailable, two 1 vCPU / 2 GiB proxy VMs | Only HTTPS public; HTTP may redirect to HTTPS. Origin access only from the approved proxy. Validate how the virtual IP/load balancer itself fails over. |
| Backup service | 2 vCPU, 4 GiB RAM, 40 GiB OS; initially reserve 1 TiB encrypted backup capacity on an independent failure boundary | Base backups plus continuous WAL archive/PITR; separately protected recovery configuration. Confirm retention capacity from measured backup compression, daily changes and WAL generation. One TiB is an initial reservation, not a guarantee of 35 days at full database allocation. |
| Staging | Separate app: 2 vCPU / 4 GiB / 40 GiB SSD; separate DB: 2 vCPU / 8 GiB / 100 GiB SSD | Synthetic or explicitly anonymized fixtures; no copies of production credentials. Temporarily match the production topology and allocation for performance tests. |
| GPU / Redis | None initially | AI inference uses provider APIs. Add cache/queue services only when the application needs and supports them. |

The steady application/database/job allocation totals **18 vCPU and 52 GiB RAM**, excluding backup,
build, staging and edge services. Including the proposed backup and build runners gives **24 vCPU and
72 GiB RAM**; two optional proxy VMs add 2 vCPU / 4 GiB. Reserve hypervisor headroom independently and
avoid placing every VM on one physical host or storage array. A DB witness/failover coordinator, if
selected, is additional infrastructure; two DB VMs alone do not provide safe automatic failover.
These totals assume the private-cloud platform supplies centralized monitoring/log collection and
administrative access services. If it does not, size those services separately from the measured log
volume and retention policy; do not consume the database/backup reservation for unbounded logs.

RECOMMENDATION: use the same approved data region for the database, app, backups and logs. Malaysia
is a candidate if the owner requires local hosting; do not assume that authentication, AI, telemetry
or support access stays in that region. Review each processor's actual terms and processing locations.
No provider price or monthly total is asserted until region, availability, backup retention and traffic
are chosen. Include private-cloud compute/storage HA, backup storage, outbound traffic, WAF, logs, authentication, AI API
usage, staging and operational support in the quote.

The two-instance allocation is an architecture target, not an immediately safe change of replica
count: complete the coordination checks below first. If initially using one active instance with a
standby while coordination is implemented, disclose the failover interruption and test it; that is not
active-active availability. Scale the database to 8 vCPU / 32 GiB or expand app capacity when load
tests or measured utilization justify it. More RAM cannot fix unbounded queries or authorization bugs.

## Network, identities and secrets

Internet traffic terminates at the HTTPS edge, then reaches private app instances. The database accepts
connections only from app, job runner and explicitly controlled migration/recovery identities. Do not
expose PostgreSQL or the Next.js port to the internet. Restrict administrative access to a VPN or managed
session service with MFA; disable public password-based SSH. Keep management/monitoring ports private.

The customer service binds Next to loopback. With a separate load balancer, install a local HTTPS
reverse proxy on each application VM: edge → app VM private HTTPS listener → `127.0.0.1:3000`.
Firewall that private listener to the edge addresses and verify the edge-to-origin certificate.
A remote load balancer cannot connect directly to another VM's loopback address. Keep the local
proxy's resource use inside the app VM allocation and include it in load tests.

Use a supported patched Node 22 or Node 24 LTS release, a supported OS and PostgreSQL patch release,
and the tested package lockfile. Node 20 and Node 18 are end-of-life as of this design. Verify releases
against the official [Node support schedule](https://nodejs.org/en/about/previous-releases).

The web service must run as a dedicated non-root account that cannot modify its executable code or
read deployment, migration and backup credentials. Loading a migration secret and then removing its
environment variable is insufficient if that account can still read the source file. The customer
systemd unit therefore uses a separate root-owned runtime environment and hides deployment env files.
Use a managed secret store where available; keep keys out of logs, process arguments and source control.
Rotate secrets using a rehearsed procedure. Protect `AI_CONFIG_SECRET` in recovery storage: losing it
can make existing encrypted provider keys unusable.

The normal database role must remain `NOSUPERUSER`, `NOBYPASSRLS`, without schema ownership or role
administration. Keep owner/migration credentials out of the web process. The platform role crosses
tenant row boundaries and needs a separate explicit access decision; do not distribute it to every
customer service by default. Review grants on new tables and test employee, manager, company and tenant
boundaries on reads, writes, exports and document downloads.

Real authentication is required before loading HR records. Disable all demo identities; enforce MFA
for privileged users in the identity provider, and verify invitations, sign-in, reset, logout,
revocation and offboarding with real test accounts. Record administrative changes and sensitive
exports without logging tokens, bank details, identity numbers, uploaded documents or full prompts.

Arm audit chaining before the first real record and verify new events, including bootstrap and jobs.
The fresh-customer bootstrap arms its transaction before the first write and persists the tenant's
`audit.hash_chain_enabled` setting. Verify that tenant setting as well as the deployment environment;
an existing explicit tenant setting takes precedence over the environment fallback. Check auth and
scheduled-job events too, since they do not all run through an ordinary signed-in user transaction.
Database-local hashes alone do not protect against a database owner who can rewrite both data and
hashes. Send audit evidence to separately administered append-only storage and test verification.

## Data, recovery and monitoring

FACT: the application currently stores uploaded files in PostgreSQL. Encrypt database storage,
snapshots and backups, and use certificate-validated TLS for remote connections. Account for files
in restore time and database capacity. Private object storage is a future adaptation, not an existing
upload backend. Any move needs authorization checks, size/type validation, scanning/quarantine,
retention/deletion and recovery tests. Storage encryption does not replace application authorization.

PROPOSED recovery objectives, requiring owner agreement: no more than 15 minutes of data loss (RPO),
and restore service within 4 hours (RTO). Daily dumps alone cannot meet the proposed RPO. Enable
continuous WAL archiving plus periodic base backups, retain 35 days initially, and protect a
backup copy from application credentials and accidental deletion. Retention for statutory records,
employee documents and backup copies needs its own approved policy; 35 days is an operational recovery
proposal, not a legal retention rule.

For self-managed PostgreSQL, use a mature backup system such as pgBackRest after validating it against
the selected OS/storage. Prove the latest recoverable time from archived WAL; a running replica is
not a backup against accidental deletion or corruption. Use a dedicated replication role, encrypted
replication links and replication-lag/WAL-space alarms. Choose synchronous replication only with an
explicit availability/data-loss tradeoff. Until a quorum-based failover controller and fencing are
installed and tested, document controlled manual promotion: fence the previous primary before
promoting its standby, then rejoin it safely. Never promote based only on a network timeout.

Set and test `archive_timeout` or equivalent continuous WAL delivery so quiet periods cannot exceed
the agreed RPO while a WAL segment remains unfinished. Alert before the oldest unarchived write
reaches that objective; monitor both archive failures and lag, including during low traffic.

For a logical `pg_dump` plus manifest, run `scripts/restore-rehearsal.sh` against a protected disposable
restore target. It checks that logical format; it cannot restore pgBackRest base backups or prove PITR.
Separately restore the physical base backup and archived WAL into an isolated cluster, recover to a
chosen timestamp with the selected backup tool, and verify known transactions on both sides of that
timestamp. In both drills verify migration watermark, table permissions and tenant isolation, then
exercise login and representative HR workflows. Measure time from incident declaration to usable
service. Exercise a corrupt backup, a failed restore and loss of the primary host. Never rehearse
over the live database.

Alert an explicitly nominated operator on failed/stale backups, missing job heartbeats, failed login
bursts, application 5xx, `/health` failure, database connection pressure, replication lag, disk growth
and audit verification failures. A log file or syslog event without a monitored destination is not
delivery to a human. Use redacted structured logs; do not ship request bodies or raw SQL parameters.
Test alert delivery before handover and document coverage outside office hours.

For AI features, document which fields leave the system, why, to whom, for how long and in which
regions. Minimize or redact personal identifiers and scope retrieval to the caller's permissions.
Do not enable sensitive-data AI workflows until vendor retention/training terms and customer consent
or other applicable basis have been established by the responsible owner.

## Deployment, scaling and rollback

Build once for the target Linux architecture, scan the lockfile, run the repository gate and publish
an immutable release. Keep build/migration credentials separate from runtime. Deploy into a fresh
release directory and switch traffic only after readiness checks. The current in-place demo deploy
script does not implement atomic immutable releases; a customer runbook must not imply it does.
Do not run concurrent migrations. Keep a previous application artifact, but do not assume old code
can run against a changed schema: rehearse each migration's forward recovery/rollback strategy.

Before using multiple web instances:

- Distribute the same build and Server Action encryption key to each replica; verify rolling-release
  behavior and stale browser sessions. Never independently build each live replica.
- Audit cache usage and coordinate invalidation where mutable cached data exists. Do not cache
  authenticated HTML, RSC responses, APIs or exports at a shared CDN. Cache only approved static assets.
- Apply rate limits at the shared trusted edge. A process-local limiter is multiplied by replica count.
- Keep scheduled jobs on one runner until their concurrency/claim semantics are proven. Do not enable
  the same crontab on each web host.
- Budget database connections across every web process, job and privileged pool. The app's default
  pool maximum is ten per connection string per process, not ten for the whole installation.
- Test login, file access, imports, exports, payroll and cache invalidation while deliberately routing
  consecutive requests to different instances.

Load-test a production-shaped staging environment with 4,000 employees and a growth dataset of 8,000,
at expected peak concurrency plus a 2x burst. A provisional arrival scenario is 4,000 clock-ins over
ten minutes (about 6.7 per second), with a brief 2x burst and ordinary page traffic at the same time;
confirm whether real shifts produce a sharper peak. Include
morning clock-in, daily attendance, large imports, payroll processing and PDF exports concurrently.
Measure p95 response time, job completion time, CPU, memory, database locks/connections and storage I/O.
Agree a response-time target first; a provisional target is p95 below two seconds for ordinary pages,
with explicit budgets for longer payroll/import/export work. Increase resources or fix expensive
queries based on the measured bottleneck. Do not promise a headcount limit from CPU/RAM alone.

## Launch evidence and outstanding decisions

Owner inputs needed to finalize provisioning: peak users, private-cloud provider/platform and allowed
regions, monthly budget, domain, recovery objectives, backup retention, identity-provider environment,
first administrator and alert recipient. Customer-specific inputs also include import files, payroll
cut-off/pay day, benefit/approval rules, bank payment layout and statutory filing sign-off.

Before release, obtain evidence for: customer deployment preflight; actual WorkOS lifecycle with MFA;
chained new events; encrypted private storage; successful off-host recovery; delivered failure alerts;
tenant/role isolation; required schedules; load test; customer import reconciliation; a parallel payroll
month; and filing/bank submission rehearsals with acknowledgements where required. Code tests cannot
stand in for agency acceptance or customer payroll approval.

## Sources

- [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting): reverse proxy, shared builds,
  Server Action keys, caches and multi-instance coordination.
- [AWS task sizing](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/capacity-tasksize.html):
  size from load tests; the allocations above are engineering assumptions.
- [PostgreSQL continuous archiving](https://www.postgresql.org/docs/16/continuous-archiving.html),
  [warm standby](https://www.postgresql.org/docs/16/warm-standby.html), and
  [pgBackRest documentation](https://pgbackrest.org/user-guide.html): self-managed recovery and replication.
- [OWASP authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html),
  [secrets management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html),
  [logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), and
  [AI sensitive information disclosure](https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/).
