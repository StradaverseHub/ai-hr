# Notification worker native capability design

Frozen proposal for controller review, 7 November 2026. No production code, migration number, role
allocation, journal edit or runtime qualification. Audit source remains
`194215b679a13977decdeca594f4304920d15cf8`. This replaces the earlier proposed app-role SET edge.
The [unnumbered SQL](NOTIFICATION-WORKER-NATIVE-PROPOSAL.sql) is a non-installable review draft of
protected state and API signatures. Function bodies, canonical adapter extraction and tests remain
implementation work; this document does not claim those gaps are already closed.

Root subsequently authorized an isolated source/CI prototype under these namespace names.
The [stage1 lifecycle implementation](NOTIFICATION-WORKER-LIFECYCLE-PROTOTYPE.md) now supplies
real native admission/run/batch functions and hostile-role tests. It does not implement
canonical projection/preparation, allocate a migration or commission the full contract below.

## Exact role and grants contract

Proposed names are review vocabulary, not allocated installation roles:

| Principal | Database grants and properties |
| --- | --- |
| `ai_hr_notification_worker` | LOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION; no memberships at all. CONNECT to the verified DB, USAGE on `notification_worker`, EXECUTE on the explicit public API list only. **Zero table/column/sequence grants**, including SELECT. No USAGE on `app`, `identity_email` or the private schema; no CREATE on any shared schema. |
| `ai_hr_owner` | Owns the API/private schema, protected state and fixed SECURITY DEFINER bodies. Existing owner membership/other sweeps are unchanged. Owner credentials are absent from the new worker and web environments. |
| `ai_hr_app`, platform and customer sessions | No private-schema/table privileges or worker API execution. No worker membership or reverse SET edge. Existing unrelated privileges remain unchanged. |
| Installation DBA | Creates/authenticates the login and validates the actual grant graph/profile. This is separate from package/source/schedule acceptance. No credential appears in source or arguments. |

Migration 0525's isolated `identity_email` schema explicitly warns against granting `app` USAGE
because older helpers inherit PUBLIC EXECUTE. Reuse that boundary. `REVOKE FROM worker` cannot undo
a privilege inherited from PUBLIC. Before activation, native catalog checks must reject unexpected
app/private/other sensitive schema USAGE, shared schema CREATE, accessible user-defined SECURITY
DEFINER routines outside the explicit API allowlist, inherited table writes, special server roles,
and any membership/SET path. Public/extension schema facts must be inspected on the real DB; source
absence is not proof. Default PUBLIC TEMP privileges do not make temporary objects trusted: every
API reference is schema-qualified and the search path is `pg_catalog,pg_temp`.

The new worker cannot call `SET ROLE ai_hr_app`, even if it sets `app.roles=super_admin`, chooses a
real administrator's user UUID, fabricates company grants or clears `app.agent_principal_id`.
Those settings grant neither schema access nor table/function privileges. Each API ignores them,
checks `session_user` against the DBA-bound login OID and derives its tenant/event from protected
state before setting any internal maintenance context for a fixed reviewed native helper.

## Protected admission representation

Use real persistent private tables owned by the schema owner. Do not use caller JSON, transaction
GUCs, `application_name`, a worker-created temporary table, a PID alone or a TypeScript brand as proof.

| State | Required protected fields and lifecycle |
| --- | --- |
| `authority` | Singleton enabled flag, expected login OID, native API version and finite run/batch/event caps. DBA-installed; no source/schedule/accepted flag. Changed login OID or privileged profile refuses. |
| `run` | Exact `job_run` UUID, login OID, backend PID **and backend start time**, started time and native aggregate counts/state. A dedicated physical connection owns a run across commits. Session advisory try-lock prevents overlapping narrow-worker runs; disconnect releases it. The recorded unfinished run remains visible. |
| `run_scope` | Server-enumerated tenant IDs/standing, chosen consumer, settled outcome, native backlog count/oldest observation/time and committed totals. System tenant excluded. No caller entitlement/scope list. Enumerate IDs without storing names in global job history. |
| `batch` | Random server UUID, run/tenant/consumer, login OID, backend PID/start, `pg_current_xact_id()` (`xid8`), opened time and bounded event count. One active batch per backend/transaction. Created and destroyed inside the projection transaction. |
| `batch_event` | Batch/event/consumer/sequence selected by the database from still-pending processing intent, plus native finish disposition and inserted projection count. Caller cannot add rows, substitute event IDs or mark them finished directly. |
| `batch_effect` | Event-bound notification UUIDs and counts actually inserted by the API, including account-addressed Rewards notifications and reminder preparation outcome. No caller-computed success counter. Created/destroyed with the batch. |

Every batch API checks enabled authority, the real login OID, matching run/backend/start/xid8, exact
admitted event membership and current tenant/consumer relationships. It rejects completed runs,
finished events, wrong consumer, changed standing/activation, cross-tenant aggregate substitutions
and IDs copied from another transaction. IDs need not be secrets: the native binding provides authority.

`open_batch` takes the same `notification-cursor:<tenant>` transaction advisory lock as legacy
projection. It reads pending `notification_event_processing` joined to its source event and orders
by event sequence with the existing bounded limit. Source/intent rows remain protected against
concurrent deletion while admitted. Do not select `sequence > cursor`; late commits behind the
cursor are still pending work. Do not commit the admission transaction before registry projection.

Finished batches delete their temporary-in-purpose **persistent protected** rows and increment
private run/scope aggregates in the same commit as notifications/outbox/dispositions/cursor. Rollback
removes admission and every effect together. Abandoned open-batch transactions disconnect/rollback;
the durable run start remains `running`. A cleanup routine cannot complete or replay business work.

Native DB admission is an upper bound on allowed work: `notifications` has no dependencies in the
audited module catalog; global active/trial unexpired purchase permits the global consumer, otherwise
qualifying company purchases permit only assessment reminders. Tenant standing is active/trial.
Canonical `toSnapshot`/`isModuleEnabled`/settings and MODULE_KILL/SETTING_KILL remain in the shared
TypeScript decision path and may narrow execution. Pin a drift test on the catalog dependency/standing
contract; a future dependency change requires native-gate review. A DB capability does not prove a
process honored an environment kill lever; protected package/environment qualification supplies that
separate fact. Do not claim native admission authenticates process environment.

## Exact API contract

All functions live in `notification_worker`, with explicit signature EXECUTE grants only. UUIDs
returned by the API identify native objects, not accepted source. Bodies use fixed fully qualified
SQL; there is no SQL-string, table-name, role-name, generic callback or caller-selected job-key input.

| Signature | Native behavior and output |
| --- | --- |
| `open_run() -> uuid` | Validate login/profile and take the session singleton try-lock. Create durable `job_run` start for fixed key `notifications.project`, then private run and server scope. API version is distinct from accepted package identity. No arbitrary result JSON. |
| `scope_page(run uuid, after_tenant uuid, count integer) -> SETOF scope_row` | Fixed maximum page size; return native tenant ID/standing/consumer and minimal raw entitlement snapshot. Scope must belong to this actual backend run. Run ledger, not caller pagination claims, determines completeness. |
| `open_batch(run uuid, tenant uuid, count integer) -> uuid` | Require a native in-scope tenant and appropriate consumer, enforce finite caps, acquire tenant transaction lock and create protected admission plus selected event rows. Count is clamped/rejected against the installed native cap. Return an empty admitted batch when no work exists. |
| `events(batch uuid) -> SETOF event_row` | Return only admitted ID, aggregate type/ID, event type, subject employment ID, payload and sequence; no arbitrary event lookup. |
| `facts(batch uuid, event uuid, family text) -> jsonb` | Closed family allowlist below, source-derived aggregate/subject/payload arguments only. Reject unrelated family/event combinations. Return typed fact schemas, not SQL/row handles. |
| `prepare_assessment(batch uuid, event uuid, decision jsonb) -> uuid[]` | Only admitted `assessment.reminder-queued`; derive the reminder row from event aggregate/source linkage. Apply the exact shared evaluator's bounded preparation proposal after native epoch, row/run/user/tenant, outcome and deadline checks. Only columns listed below may change. Return current employment route or empty. No arbitrary reminder/employee/cycle ID argument. |
| `project(batch uuid, event uuid, kind text, recipient uuid, rendered jsonb, category text) -> projection_row` | Insert employment-addressed notification for the admitted tenant/source only, retain duplicate checks and permitted kind/category contract, then invoke the existing conditional enqueue semantics internally. Validate recipient belongs to tenant; body is projection data, not authority. Return actual ID/created boolean. No transport execution. |
| `project_reward_account(batch uuid, event uuid) -> integer` | Only admitted native `reward-access.suspended`; call existing account-addressed suspension notification projector internally with protected tenant context. It inserts notifications, not role/access changes. |
| `finish_event(batch uuid, event uuid, disposition text) -> void` | Accept only processed/ignored for a still-admitted event, with no uncommitted/invalid preparation effects. Unknown/obsolete decisions follow shared canonical registry and native obsolete checks. Do not expose arbitrary receipt UPDATE. |
| `finish_batch(batch uuid) -> batch_result` | Require every admitted event finished exactly once; update only admitted pending processing rows, compare affected count, advance the correct cursor monotonically and aggregate actual effect counts. Delete protected batch state. Return processed/created counts inside the transaction; CLI reports them only after commit resolves. |
| `settle_scope(run uuid, tenant uuid, stop_reason text) -> backlog_row` | Read real current pending/oldest backlog and store the observation; never accept supplied counts. Finite stop-reason enum can reduce health, never turn pending work into completed. A status/entitlement change records a deliberate skip/refusal, not fabricated completion. |
| `finish_run(run uuid) -> void` | Derive terminal counters from private scope/batch state and native observations; exact unfinished jobRun CAS. Cannot mark success with unsettled scope, pending/capped/blocked/failed work or outstanding batches. No raw duration/outcome/result input. |
| `fail_run(run uuid, reason text) -> void` | Fixed safe error codes only; terminal failed CAS while preserving actual committed counters. Cannot reopen a run or alter another job. Failure to persist completion makes process exit nonzero. |

`rendered` has exactly `{title,body,linkPath,severity}`, with bounded lengths and local link rules.
`decision` has exactly one of the existing skip outcomes, or the current typed preparation fields;
native epochs/deadline and event linkage constrain the write. These are **data proposals**, not native
proof that a compromised worker computed the correct text, recipients or pending-task graph. The
security guarantee is bounded projection authority, denial of unrelated HR writes, and protected
event/run/transaction linkage. Correct canonical calculations require parity and source/runtime
qualification. Do not mislabel a caller-proposed plan as independent native correctness verification.

Keep one canonical registry/render implementation. Kind/category admission should derive from that
registry's versioned closed contract and be checked for drift in native qualification; do not maintain
an unnoticed second business registry in SQL. Native event-specific read/preparation wrappers may use
existing canonical native helpers internally, but those helpers are never granted directly to the worker.

## Exact mutation allowlist

The login receives **no direct grants** on any entry below. Only the named fixed API bodies may mutate:

| Table | Columns/effects allowed through the API |
| --- | --- |
| `public.notification` | INSERT generated ID, admitted tenant/source, same-tenant employment recipient, kind/title/body/link/severity. Account Rewards path may additionally use existing `recipient_user_id`/`company_id` behavior. Never UPDATE read state or DELETE notifications. |
| `public.notification_delivery` | INSERT only through existing `notification_email_enqueue` consent/category/identity logic. No lease/attempt/status/error/sent-at update, no delete and no delivery. |
| `public.notification_event_processing` | UPDATE `disposition,processed_at` only for the admitted event/consumer whose prior disposition is NULL; exact affected-row count. No insert/delete/sequence/tenant/event substitution. |
| `public.notification_cursor` | INSERT admitted tenant and correct last-sequence field, or UPDATE only that consumer's monotonic sequence and `updated_at`. Never lower the other consumer's cursor. |
| `public.performance_assessment_reminder_recipient` | UPDATE only admitted native reminder row: `outcome,tasks,mail_words,prepared_at,prepared_until,tenant_epoch,cycle_epoch`. Preserve existing skip clearing and prepare semantics. No ID/run/user/employment/source-event/created-at change, insert or delete. |
| `public.job_run` | INSERT fixed notification key/running start; UPDATE only that exact still-running run's duration/outcome/aggregate counts/safe error. No other job, delete, start-time/key change or completion overwrite. |
| Private run/scope/batch/event/effect state | Owner API only; caller cannot directly read or write it. Retention is separately bounded and cannot replay effects. |

No Personnel, payroll ledger/batch/payslip, employment/person, grant/user/access, lifecycle source,
Letter source/delivery, performance review/decision/result, settings, module purchases, domain-event
append, arbitrary maintenance or other-job writes are allowed. Trigger effects of each permitted
write must be included in the hostile-role audit, not assumed harmless.

## Canonical read adapter and fixed fact families

Extract pure registry/render and recipient decision functions from broad service facades. Their
read port returns the following closed fact families from fixed event-bound SQL. The ordinary web
adapter retains its existing RLS/current-principal semantics; the maintenance adapter obtains facts
only through `facts` in the **same transaction**. Never supply a fake Drizzle `Tx`, translate arbitrary
SQL or start another connection from a resolver. Extract existing predicates rather than normalize
differences in reporting-line validity or effective dates.

| Family | Existing owner and exact minimal fact surface |
| --- | --- |
| `org-approvers` | `hrAdminsForCompany`, `delegateRecipient`, `approverEmploymentsForKind`, `resolveSubjectHead`: employment ID/person/company, role-assignment role/app-user/company, app-user ID/person/archived state/native login-blocked result; reporting-line ID/manager/subordinate/type/valid-from/valid-to/superseded-at; current assignment employment/department/valid-to/superseded-at and department/business-unit head IDs. No names, pay or personal documents. Include current delegate IDs only through existing native `active_delegate_employments` behavior. |
| `approval-chase` | Source-linked claim/replacement/attendance ID/employment/status, frozen attendance workflow/effective stage/outstanding participant kind/employment ID, source-linked leave request status and step index/status. Preserve the existing v3/v4 participant and stand-in decisions; no decision/write functions. |
| `legacy-review` | Admitted review ID/employment/manager/status and native legacy-probation-owned boolean; current HR seats above. Preserve obsolete legacy handling. |
| `payroll-audience` | Distinct employment IDs of payslips in the admitted closed batch only. No amounts, tax, bank or salary columns. |
| `notice-audience` | Admitted published Notice snapshot employment IDs joined to the admitted tenant. No arbitrary Notice, audience editing or current-target recomputation. |
| `probation-audience` | Existing `app.probation_notification_recipients` for admitted aggregate **and source event** only. |
| `contract-audience` | Existing `app.contract_notification_recipients` for admitted native message only. |
| `onboarding-audience` | Existing `app.onboarding_mail_recipient` for case/user derived from the admitted digest payload and same-tenant source linkage only. |
| `rewards-audience` | Existing pool/stage/upload-check/suspension-event recipient helpers for admitted unit/source and the existing stage mapping. No Rewards amounts or approval actions. Account notification insertion remains the separate bounded mutation above. |
| `peer-feedback` | Admitted pending request ID/peer employment, current employment/person/termination state and app-user archive/login-blocked result. No answers, remarks or principle comments. |
| `assessment-review` | Source review/cycle linkage; `performance_onehr_review` fields consumed by the current resolver: cycle/employment/kpis/competencies/competency-status/results-submitted/manager-performance; native reviewer/closed-at; cycle status/period-end/policy; frozen-result existence; plan-year/status; native participation, moderator choices **IDs only**, effective reviewer, unit-out flags and live recipient IDs. Preserve pure `reviewWorkspaceParts` and `assessmentWorkWindowOpen`, stripping names/person IDs unused by those decisions. |
| `assessment-reminder` | Admitted reminder recipient/run IDs/user/employment/outcome/mode/cycle/source linkage, tenant/cycle epochs, native pending work graph, mail routes and cooldown boolean; current relevant entitlements/rules, minimum module-expiry boundary and current word template. The graph intentionally includes the names used by existing prepared reminder mail. Keep these private facts off global job history/logs. Use the existing pure `assessmentReminderWork`/word formatter; no changes to work windows, cooldown, consent, cache keys or the second epoch check. |
| `automatic-followup` | Existing source-specific `automatic_followup_facts`, current step applicability/rules/transition time, staff IDs and working-day facts needed by `currentFollowupTargetsTx`; passport source returns expiry/chase facts, never passport number/document. Preserve `buildStepViews`, the source module gate and the existing calendar owner. |

The family names are a closed API enumeration, not arbitrary query selectors. Within each family,
native SQL derives all object arguments from admitted events and verified relationships. A worker
cannot use a payroll event to fetch a different cycle graph or arbitrary individual's facts. Native
helpers requiring a maintenance GUC context receive a freshly initialized context from protected
admission; no caller `user_id`, role, grant, company or agent value survives that initialization.

Source audit found a mutation hidden in `assessmentReminderRecipientsTx` at reminder-service line
185: skip clears fields; success saves task/mail preparation with epoch/deadline validation. Extract
its evaluator and fact reads, but keep the bounded preparation write in the transaction. Do not
replace it with a pure recipient list. Likewise preserve `reward_access_project_account_suspension`.

## Same-transaction sequence and scheduler split

Use a direct physical database connection with an explicit total pool budget of one for this initial
serial worker. Transaction-pooling proxies are incompatible with run/backend binding. Avoid module
imports that initialize the global app pool; prove observed connection totals on hosted native tests.

1. `open_run`, commit its durable start. Fetch scope in bounded pages on the same physical connection.
2. For each tenant: BEGIN; `open_batch`; `events`; fixed fact reads, pure canonical resolver/render,
   bounded preparation/project APIs and `finish_event`; `finish_batch`; COMMIT. Only now report the
   committed batch. A failed/uncertain commit is investigated by receipt/state; never blind retry.
3. Drain within native run/batch/time caps, then `settle_scope` records actual pending/oldest work.
4. `finish_run` commits derived terminal state; protected installer/invocation collector independently
   binds that exact native run to accepted bytes and an observed timer cause. No native API receives
   or creates an accepted-source/installed/schedule-verification boolean.

Keep the combined runner's Lifecycle/Probation/Contracts/Performance queueing, Letters and existing
delivery duties. Introduce an explicit internal projection-disabled mode only after the narrow worker
is accepted, so the original minute/review schedules cease projecting without losing those duties.
Review the exact scheduled unit/CLI ownership transition; neither disabling the whole job nor running
two projection owners is an accepted shortcut. Existing event/tenant advisory lock remains a safe
overlap backstop during controlled migration. No SMTP is executed in qualification.

## Hosted hostile-role and correctness proof

Controller-owned standard hosted Actions only; no local runtime checks. Use PostgreSQL 16 real
nonsuperuser LOGIN/session identity and native grants, not only a superuser `SET ROLE` imitation.

- Catalog exhaustiveness: actual accessible tables/columns/schemas/functions and every membership
  path match the closed allowlist. Show app/private schema and special-role denial. Reject future
  unexpected PUBLIC grants or mutable helper ownership before activation.
- Outside and inside a real admitted batch, forge valid tenant/user/group-admin/company/agent GUCs.
  Attempt Personnel/person/employment CRUD, payroll/payslip/ledger/approval writes, user/grant/access
  changes, domain-event append, settings/module changes, lifecycle/Letter/performance decisions,
  another `job_run`, direct notification/delivery/receipt/cursor writes and known SECURITY DEFINER
  mutation calls. Every attempt fails natively and independent owner snapshots prove zero effects.
- Try SET ROLE/SET SESSION AUTHORIZATION to app/owner/platform/read-helper/another worker identity,
  GRANT, DDL, owner/table/sequence access, temp-object and search-path shadowing. Verify deny results
  under exact installed PUBLIC defaults. A writable temp object or forged JSON must never admit work.
- Cross-run/backend/transaction/login/event/tenant/consumer IDs, reused terminal run, guessed batch
  UUID, changed login OID, reconnect/PID reuse, epoch change, malformed family, nonmember recipient,
  count overflow, wrong category/kind, excess payload and cap exhaustion all refuse atomically.
- Per registry event/spec, compare legacy canonical and narrow adapter outputs on isolated identical
  fictional fixtures: recipient IDs, kind/title/body/local action, account Rewards path, consent/outbox,
  reminder preparation and all date/window/delegation rules. Do not compare by replaying both into
  one mutated fixture or by exercising SMTP.
- Fault at admission, fact/preparation/write, disposition/cursor, commit, native terminal CAS and
  protected receipt publication. Verify rollback/late-commit/duplicate/retention semantics, mixed
  legacy concurrency, no cross-tenant leak and no manufactured terminal success.
- Missing/newest failed/running/stale invocation, source/build/DB/scheduler mismatch and restart still
  refuse operational readiness. Native API tests do not establish installation or browser acceptance.

Root must reserve the migration/role/journal ownership and review body-level canonical SQL before
implementation. The frozen proposal deliberately grants no production-code, installation, SMTP or
deployment authority. Existing page catch-up and always-refusing scheduling prerequisite remain.
