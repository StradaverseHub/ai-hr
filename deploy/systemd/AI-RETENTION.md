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
Its actual physical table-owner connection must also be able to execute the guarded policy helper
`app.agent_signal_custody_visible(text,uuid,uuid,uuid)`. The migration/function owner already
has that privilege. The runner checks this fixed policy function privilege before processing custody and
grants itself nothing; never substitute PUBLIC EXECUTE, app-role membership, candidate-table SELECT
or BYPASSRLS for any grant below. The runner also checks EXECUTE on the exact global review CHECK
predicate `app._payroll_completion_shape(jsonb,text,text)` before any retirement write. This is an
IMMUTABLE invoker-only shape predicate, not a Payroll data reader or effect owner. The existing
migration/table/function owner already has implicit EXECUTE and remains the preferred topology.
A split maintenance owner needs only this individually reviewed outer predicate capability, without
grant option; it receives no nested UUID-array predicate or other private Payroll helper capability.
The fixed preflight refuses missing capability; it never grants privileges or discovers arbitrary
functions to execute. Re-review direct CHECK dependencies when changing the maintained schema.
Raw Assistant chat content (question, answer, tool inputs, disclosure receipt, error) is also retired
by this pass 30 days after it was asked, at most 100 exchanges per tenant per pass, inside the same
tenant Access interval and before any other expiry. Exchange rows, dates, tokens and usage remain, so
retirement never replenishes an allowance; linked feedback, completed strategy markers and original
identity custody retire with the content and are not counted separately (`transcripts` counts
exchanges). The transcript step runs through `app.assistant_transcripts_retire_expired`, which refuses
unless the session is a superuser or BOTH that function's owner and `public.assistant_exchange`'s
owner. An exchange inserted already retired (accounting only) captures no identity and is never
selected again.

A separately provisioned nonsuperuser owner role needs exactly the following. The runner refuses
when relation or `app.assistant_transcripts_retire_expired` ownership, or the outer CHECK
capability, is incomplete; any other omission fails the pass and rolls the whole pass back:

- Ownership of every relation listed in `AI_RETENTION_MAINTAINED_RELATIONS`
  (`core/ai-retention-maintenance.ts`; currently 19, derived from the relations the pass mutates, its
  declared cascades and the transcript helper), including the employee-import comparison parent and
  its admitted-run membership table.
- EXECUTE, without grant option, on the exact pure outer CHECK predicate
  `app._payroll_completion_shape(jsonb,text,text)`. Preserve its migration owner, IMMUTABLE/invoker
  definition, PUBLIC/app denials and the existing native discard child's typed grant. Do not grant
  `app._payroll_completion_uuid_array(jsonb)` or other private Payroll helpers to maintenance.
- Ownership of `app.assistant_transcripts_retire_expired(uuid,integer,integer)` and its two private
  helpers `app._assistant_transcripts_retire(uuid,uuid[],boolean)` and `app._assistant_transcript_bounds()`.
- EXECUTE on the helpers that PUBLIC row-security policies call on the FORCE-RLS tables it owns.
  Ownership does not bypass FORCE RLS, and PostgreSQL checks EXECUTE on every function in an applicable
  policy before any row is read, so each one is required even though it returns false for this role:
  `app.agent_signal_custody_visible(text,uuid,uuid,uuid)` and
  `app.agent_native_signal_custody_visible(text,uuid,uuid,uuid)` (job receipt, job feedback and native
  outcome association), `app.principal_snapshot_current()` (feedback, candidate provenance and
  conversation metadata), `app._answer_metadata_erasure_authorized(uuid,uuid,uuid)` (conversation
  metadata) and `app.assistant_transcript_retirement_visible(uuid,uuid)` (feedback and strategy
  markers). `app.current_tenant_id()`, `app.current_user_id()` and `app.is_group_admin()` are also
  called there; they are PUBLIC-executable unless an installation revoked that.

Expiry follows the existing native cleanup contract in one parent UPDATE: pending Payroll reopening
roots clear before the immediate CHECK, and pending reporting-change manager/previous-manager links
clear with the expired state. The body then retires; completed receipts and native HR/payroll records
remain. Clearing these private fields grants no reopening, reporting change, approval or payment.
Verify genuine prepared Payroll and reporting custody under the actual owner topology, alongside
unexpired siblings, completed history, rollback, bounded backlog and FORCE-RLS visibility checks.

These prerequisites are not a blanket ownership-reassignment procedure. Verify existing native
physical-owner contracts and migration preflights before any installation change. Prefer running
maintenance as the existing installer/table/helper owner.

Ownership transfer is not isolated. `ALTER ... OWNER` moves the previous owner's own privileges to the
new owner. The own-clear and PDPA transcript functions (`app.assistant_transcripts_erase_own`,
`app.assistant_transcripts_redact`), the policy helper `app.assistant_transcript_retirement_visible`
and the review/native/conversation custody trigger functions run as their own owner and read or call
the objects above. If that owner is not a superuser, transferring those objects to a separate role
can make own-clear, PDPA erasure or ordinary Assistant feedback reads fail with permission denied.
This has not been runtime verified on a nonsuperuser migration owner. Before transferring ownership on
such a target, verify those paths there, or run maintenance as the role that already owns all of
these objects.

Expired employee-import comparison metadata is deleted after its 30-day lifetime; at most 100 parents are selected per tenant per pass, with at most 128 declared
run links cascading per parent. Aggregate deletion counts report direct parents, not cascaded links.
Canonical HR records, import completion events and provider billing runs remain untouched.

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
