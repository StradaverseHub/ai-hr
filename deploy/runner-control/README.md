# Runner control commissioning

The Scheduled Actions page uses a restricted Unix socket, never SSH, sudo, a database owner URL or
arbitrary commands from Next. Server actions re-resolve the session and require the installation
operator grant; customer group administrators can only read status. The socket independently checks
the exact web UID. The web process is trusted to authenticate that operator; this is not a separate
identity-verification service. A web compromise could invoke only commissioned catalog capabilities.

The root-owned local policy selects staging or production and explicitly commissions each runner.
No request can select an environment, unit, command, environment file or source path. Production
replacement holidays and backups are held in the broker regardless of submitted values or policy.
Removing either hold requires a separately reviewed source/policy release and owner decision.

The controller does not install worker code or create schedules automatically. First fix and verify
workers in staging. Use immutable, root-protected accepted worker releases, dedicated nonlogin users
and protected minimal environment files. Never run privileged maintenance from the web-writable
application checkout. Preserve existing authentication/TLS/tenant/role boundaries.

Before management, migrate each legacy cron entry in the exclusive staging window, preserving the
original crontab and removing only reviewed matching schedules and their obsolete heartbeat alarms.
Verify no duplicate scheduler remains. The installer refuses management while matching cron remains.
A combined provisioning CLI includes replacement holidays: split that scheduler before claiming
independent control of provisioning, holidays and report delivery. Use `scripts/provision-only-runner.ts` for independent provisioning and the existing
`--installed-internal-reports-only` mode for report delivery. The controller refuses enabling either
capability through the combined entrypoint. Until then leave it unmanaged.
Optional capabilities without provider/destination prerequisites also stay unmanaged.

Policy example (root-owned file, 0600; replace webUid with the actual verified UID):

```json
{"environment":"staging","webUid":1001,"jobs":{"reviews":{"managed":false,"note":"Pending accepted source and legacy cron migration."}}}
```

From an exact reviewed accepted source package, root runs:

```sh
python3 -I -B deploy/runner-control/install.py --policy /root/runner-policy.json --web-user WEB_ACCOUNT --check
python3 -I -B deploy/runner-control/install.py --policy /root/runner-policy.json --web-user WEB_ACCOUNT
```

The installer checks dedicated nonroot identities and immutable working trees for managed services,
refuses unit hooks and overlapping legacy cron, and requires unlimited graceful drain for continuous
workers. Independently review ExecStart's protected binary, fixed arguments and minimal EnvironmentFile
against the accepted worker receipt before setting managed=true; the installer does not authenticate
a release receipt or prove the service's complete runtime configuration. It installs only the control
socket/service and adds web socket-group access. Restart the web service within its release window to
acquire that group. No HR runner is enabled by installation. Verify peer-UID refusal and operator vs
customer denial on the real installation before commissioning writes.

Schedule edits clear previous calendar/monotonic directives, use explicit Asia/Kuala_Lumpur and turn
off Persistent catch-up. Monthly accrual remains day 1; yearly carry expiry remains 1 April. Interval
settings mean time after completion. They do not change policy effective dates or retention periods.
Disabling timers permits any already-running transaction to finish. Continuous services must handle
SIGTERM by draining, with SendSIGKILL=no and TimeoutStopSec=infinity; disable then requests asynchronous
stop. Configured off and currently draining can coexist and are shown separately.

Stale-form revisions and a host lock serialize edits. The protected JSONL audit records intent before
mutation and applied/failed outcomes afterward. A failed or timed-out request may have changed part of
the scheduler: refresh actual state before retrying. Keep audit records under the installation's
approved retention/backup procedure. Raw worker logs, HR values and credentials never enter responses.
Systemd's last success is process-exit evidence, not proof of email receipt or business correctness.
Missing/unmanaged jobs can still have external cron schedules: the UI explicitly says not managed here.

Acceptance must include an actual scheduled invocation, expected data effects, history/delivery
outcomes, failure visibility, persistence after restart, stale edits, customer-denied writes and
production hold refusal. Source tests alone are not commissioning. No production rollout until the
staging results and exact installed source/build have been accepted by the owner.
