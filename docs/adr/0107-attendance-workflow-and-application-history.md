# ADR-0107: Frozen Attendance approval routes and request-bound final effects

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

**Status:** Accepted for implementation; branch verification and release pending
**Date:** 2026-10-12
**Deciders:** Approved board plans 58f383e6 and aff9dc45; delegated effect design agreed with the integrating agent

## Context

Attendance previously had a single manager/administrator decision and no independent template store.
The approved plans require sequential stages, any-one alternatives, immutable routing and actual actor
history, while old pending applications retain their original rules. Approval can amend pay-relevant
attendance. A scoped delegate can decide a request but must not gain the subject's personnel or pay
visibility. Migration 0515 also makes an ordinary employment join hide such a request from the inbox.

## Decision

Attendance owns four tables: template versions, company/type routing enablement, resolved request
snapshots and immutable decisions. No Leave template or approval row is created. The shared pure
approver vocabulary, organisational criteria resolver and delegation predicates are reused.

The supported kinds are the direct administrative manager and scoped HR administrators. Ordered stages
may name either or both as any-one alternatives. Named employees, department/BU heads, manager's
manager, custom roles and payroll approvers are not offered: the existing attendance amendment kernel
has no safe effect contract for those additional authorities. Department, business unit, grade and
division are supported assignment axes, with the template company as a mandatory clamp. Shared/global
labels use the existing company usability resolver. Lower numeric priority wins; overlapping active
scopes at equal priority are refused, and an injected tie still refuses submission.

Activation validates every current target; submission validates its actual employee again. Each stage
must have at least one live non-self actor. An unavailable manager or self-only/inactive HR alternative
is omitted from that stage's resolved alternatives, never from the ordered stage list. Manager-only
stages therefore refuse when no unique usable manager exists. Manager resolution excludes the same
person across different employments, unavailable login authority, company visibility dead ends and
cycles in the active administrative graph. A recursive guard also rejects owner-injected graph cycles;
the normal org writer already rejects cycles. HR resolution returns only whether a different live
administrator has scoped authority; employee submission cannot enumerate administrators.

Routing is off by default for each company/application type. Enabling requires active valid templates;
a missing match or highest-priority tie then refuses the entire new submission transaction. Disabling
changes future submissions only. Existing requests without a snapshot stay on legacy rules, and no
historical stages are backfilled. Persisted requestKind determines Irregularity versus Self Overtime;
only null legacy values use the conservative OT-only payload fallback.

Submission freezes the selected version, stage names and resolved manager identities. HR remains a
scoped role group, not a fabricated named employment. Version edits retire the prior template and
insert a new immutable version. Every deciding surface supplies the stage it rendered. Request locks,
a unique request/stage decision and stale-stage refusal serialize concurrent clicks. Intermediate
approval records the decision and advances routing without changing attendance. Rejection ends the
application. Only final approval reaches the existing amendment kernel; its error rolls back the
stage decision and advancement. Frozen managers lose authority after an incompatible org move;
authorised non-self HR can act on behalf, with that distinct mode recorded. Authority follows the
subject’s current company after a transfer; the saved workflow company remains historical provenance.

Decision and cancellation commands first read the visible correction without a row lock, acquire its
subject's canonical advisory lock, and re-read the correction for update before validating its current
state. This preserves subject → correction → workflow/payroll → tenant audit lock order across clock
writers, OT landing and allowance transfer. No stage event can take the audit lock before the subject
lock. The deferred landing claim also requires the plan still be approved when its conditional update
wins; a concurrent legacy writer cannot cancel a selected plan and then have it land anyway.

The final-approved stage event is carried as fixed audit data until the existing attendance effect and
payroll recalculation work completes and delegated identity is restored. It preserves the original
database decision timestamp, actual actor, assignment and remarks in the same atomic transaction.
Intermediate approval and rejection emit immediately. This also preserves payroll batch → tenant audit
lock ordering: payroll generation must be able to finish its audit while a final approval waits for its
batch. Returning fixed event data grants no arbitrary callback or additional authority.

## Request-bound delegation

The attendance_correction RLS addition exposes only a request with a valid current delegation from its
frozen assigned manager, including task, organisation and date scope. A narrow subject-descriptor
function supplies employee identity for that inbox row. Employment, person, punches, salary and
payslip policies are unchanged. An update trigger preserves immutable request fields, requires an
immutable authorised final decision and rejects payload edits or manual stage advancement.

A private fixed block in decideAttendanceCorrection handles a delegated final approval. Its definer
checks the current authenticated actor, exact correction and subject, frozen assigned manager,
just-recorded final decision, live reporting line and active scoped delegation. It returns only the
manager's existing live login and employee/manager grants that cover the request company. HR authority
is never synthesized or borrowed. The block temporarily changes only app.user_id, app.roles and
app.grants and first asserts the subject is visible under that existing authority. Missing authority
refuses with scoped HR handoff guidance; no hidden calculation fallback exists.

All event and punch actor fields continue to use the real delegate SessionContext. The three changed
GUCs are saved exactly and restored in finally. A savepoint surrounds the effect so a PostgreSQL error
can be rolled back before restoring settings in an otherwise aborted subtransaction. The successful
path verifies equality with the original settings before writing the final application outcome. No
exported arbitrary callback can run under this context, and the public service returns only the
existing attendance outcome. A manager with no usable employee/manager grants cannot supply delegated
operational authority; the existing scoped HR on-behalf path is the recovery route.

## Application history and cancellation

Application History is a server-paginated read model over attendance_correction. Company scope is
intersected with authoritative SQL admin scope, including for direct URLs and forged company lists.
Current department/BU/grade/division placement and KL submission dates filter the same query as count
and pagination. The attendance date remains separate. Finite bounded pagination, UUID validation and
date validation produce domain guidance before SQL. Detail shows frozen progress, immutable actual
actors, supporting evidence and the application action ledger. My Attendance reads the same snapshots.

Pending cancellation withdraws no attendance effect and preserves partial decisions. Administrative
cancellation/withdrawal requires scoped non-self HR and an explanation. Approved reversal requires
its recorded before/after effect, an unchanged day and effective punch fingerprint, no later approved
application for that date, and open payroll. It restores only that recorded effect and appends reversal
events. Historical approvals without an attributable reversible record refuse and require a new
correction. A dependent Leave Credit must first be reviewed/reversed through its own owning module;
Attendance does not silently delete or settle that credit. Approved deferred OT with no landed effect
can be cancelled without a day rewrite only when the approval event explicitly records deferral and
no application/landing effect exists. NULL appliedAt alone predates this guarantee: ambiguous historical
OT refuses administrative cancellation and employee withdrawal. Existing decisions and decided
timestamps remain visible.

The combined employee status filter includes Cancelled and Withdrawn, while individual outcomes keep
their distinct labels. New settings and history copy is present in all six locale catalogues. New/edit
workflow forms reuse the parent-owned settings navigation guard, acknowledge only a successfully saved
revision and disable the whole editor while asynchronous persistence is pending.

## Options considered

- Broad delegate employment visibility would simplify calculations but disclose unrelated personnel and
  pay facts. It was rejected.
- Refusing every delegate-only final stage would preserve privacy but leave a supported workflow
  unfinished. It was rejected.
- Copying operational facts into a second calculation kernel would diverge from payroll/attendance
  rules. The fixed, request-bound existing-authority closure was selected instead.

## Verification and remaining release work

The integrating agent holds both heavy-tool slots. No TypeScript compiler, tests, migration execution,
build, dev server or browser verification has run for this branch. Source inspection and diff whitespace
checks are not evidence of runtime correctness. Migration 0533 must be integrated after centrally
allocated 0529–0532, and the shared AttendanceSettingsNavigation component must be integrated before
compilation.

The real-DB suite covers legacy routing, snapshots and version edits, no-match/tie/overlap,
sequential/any-one decisions, self-only HR, same-person manager routing, inactive identities, cycles,
concurrent stale stages, organisation moves, delegate-only inbox access, task/date/org scope,
immutable delegate updates, final exactly-once effects, SQL-fault rollback and identity restoration,
all history filters, pagination, grants-only and sibling/cross-tenant scope, partial withdrawal,
approved reversal, later attendance changes, dependent credits and payroll-protected final approval.
Pure tests cover input validation, canonical type selection and bulk stage tokens.

Additional unrun regressions hold the subject lock on a separate DB connection and assert every decision
or cancellation waits before taking its correction/audit locks; revalidate a landed plan after that
wait; cancel a selected plan before its landing claim to exercise the approved-status backstop; refuse
historical appliedAt-null counted OT; retain genuine deferred cancellation; and mark processed payroll
stale after a recorded reversal. These are source-prepared tests, not execution evidence.
A separate two-session regression arms the tenant audit chain, holds a processed payroll batch, waits
until final approval is blocked in payroll protection, and verifies the batch session can acquire the
exact tenant audit key and append its event. After release it checks the original stage actor/timestamp
and exactly one stage event after the effect/recalculation events. This case remains unrun too.

Non-vacuity oracles include unchanged attendance after an intermediate stage; exactly one winner for
concurrent clicks; real delegate subject-employment and payslip reads returning zero before/after an
effect that changes attendance; immutable actual delegate attribution; failed effects leaving no new
decision; retained earlier decisions after payroll refusal or withdrawal; and foreign-company detail
remaining absent despite a forged company list. Required integration work remains: execute these tests,
compile, run the full gate and browser-review all new screens and dirty/save/failure navigation. This
ADR does not claim those checks have passed or either board item has been released.
