# Expired AI custody maintenance

These source templates are disabled and have not been installed or runtime verified. They provide
one bounded pass after startup and five minutes after the previous pass finishes. The same service
cannot overlap itself through this timer. They do not establish a maximum retention lag: sustained
backlog, database contention, downtime or inadequate capacity can delay erasure.

Before exposing review custody, the combined release must verify the reserved migrations, actual
physical database owner and FORCE-RLS policies, expired-only erasure, rollback, busy interval skip,
and enough repeated-pass capacity for observed volume. The dedicated `aihr-retention` OS identity
must already be provisioned and able to read the maintenance bundle and Node runtime. The verified
release must be installed separately at `/opt/aihr-maintenance/current`, including its required
runtime dependencies. Root owns the bundle, its selection link and every writable parent. Neither
the web user nor the maintenance user may modify the sources, dependencies, Node binary, selection
link or their parent directories; reject external symlinks resolving to writable content. Do not
load this privileged connection through the web application's mutable source/dependency tree.
The installer must prove actual file ownership/modes and exact verified source/dependency identity
on the host before starting the service. This template installs none of those prerequisites.
Root owns the separate
`/etc/aihr/retention.env` file with mode0600. It contains only the approved maintenance connection;
never copy the web application's environment or put connection values in Git, arguments or logs.
The runner refuses app-role connections and has no credential fallback or privilege self-grant.
Its actual physical table-owner connection must also be able to execute the single guarded policy
helper `app.agent_signal_custody_visible(text,uuid,uuid,uuid)`. The migration/function owner already
has that privilege. A separately provisioned table owner needs only explicit EXECUTE on this helper;
never substitute PUBLIC EXECUTE, app-role membership, candidate-table SELECT or BYPASSRLS. The runner
checks this function privilege before processing custody and grants itself nothing.

The runner emits only aggregate counts, whether expired work remains, and the oldest expired age in
seconds. It prints no tenant/user IDs, review text, feedback text or connection identity. An invalid
aggregate or failed cleanup rolls back the entire pass and exits nonzero. A successful pass with a
backlog is not a failed database transaction, and is not proof the backlog is healthy. The operator
must bind these signals to the existing alerting owner before enabling exposure: alert on failed or
timed-out service runs, missing successful runs for three timer intervals, and nondecreasing oldest
expired age across three successful passes. These are operational investigation thresholds, not a
retention SLA or permission to relax capacity/security requirements.

After the verified release, validate the units using the actual host's `systemd-analyze verify`, run
one service pass, inspect its real exit/status and aggregate backlog, then enable the timer. Verify
at least two timer-triggered runs and record actual cleanup lag privately. Do not infer installation
from these files or enable the timer on a database missing the custody migrations. Disable the timer
before rolling source back to a version incompatible with those migrations; preserve schema and
completed canonical references. No SQL or canonical HR rows are replayed by this operator procedure.

The [official timer documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)
defines inactive-relative scheduling and non-overlapping service activation. The
[service documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
defines oneshot completion. Validate compatibility with the installed host version before use.
