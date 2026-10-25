# ADR-0131: Acting HR agent, harness and process assessment

Date: 2026-10-19
Status: Accepted direction. Phase 1 (process assessment) implemented in this round; Phases 2–4 are
future increments and are not claimed capabilities.

Extends [ADR-0109](0109-central-hr-orchestrator.md) (central orchestrator), [ADR-0116](0116-central-ai-inventory-and-allowances.md)
(AI allowances) and [ADR-0084](0084-propose-adjudicate-learn.md) (proposal ledger).

Dependency reconciliation, 2026-10-23: the original dependency on ADR-0127's session-bound Assistant
conversations and confirmed proposals referred to `codex/board16-home-ai`. The owner subsequently
superseded that branch as reference only (see the `atelier-shell-r1` and `assistant-dispatch-offered` entries
in [round history](../HANDOFF-HISTORY.md)). It must not be merged as a second conversation or confirmation
owner. Main still has the read-only Assistant and its offered-tool dispatch fix. The replacement leave
action-layer plan is not implemented and still awaits owner approval. Reconcile that plan with Phase 2
before introducing one shared action/confirmation owner; do not create competing ledgers.

The `ai-process-assessment` history records Phase 2 tasks 2–6 as held until the owner says go. On
2026-10-23 the owner reaffirmed: "Keep Phase 2 held; strengthen the current harness." The direction
below does not authorize held implementation. Replay coverage for the existing deterministic
orchestrator is authorized separately from the future action registry, execution ledger, named
principal and versioned model bundle.

On 2026-10-23 the owner authorized **design only** for one human-confirmed leave action and explicitly
kept implementation on hold. The proposed first-action contract below is preparation for that later
decision. It does not lift the Phase 2 hold, allocate migrations or authorize new action code.

Owner amendment, 2026-10-24: the hold is lifted **only for source-only development of
human-confirmed own-leave submission**, in a separate worktree. The human explicitly retained the
resource order: runtime checks wait for both Board 1 and Board 3 verified releases and explicit
handbacks, and the current harness must release before Phase 2. This authorizes only the first-action
slice below and its necessary shared preparation/confirmation lifecycle. It does not authorize an
unattended principal, other actions, new autonomy, authentication changes or allowance changes.
No migration number is allocated or database changed by this amendment. Source authored under this
exception remains unvalidated until the granted runtime window and is not a shipped capability.

## Owner amendment, 2026-10-25: delivery order and import evaluation

The owner revised the sequence: release the current harness and the Assistant's human-confirmed
own-leave action; add another API provider, with OpenRouter named as a candidate; then expand into
orchestration and evaluate its capability and measurable improvement during production data imports.
This supersedes the earlier roadmap order. It is a delivery direction, not evidence that any of these
capabilities has shipped. Preserve the current harness's release precedence while completing the
own-leave slice; provider expansion follows both releases.
This feature order does not change the coordinated resource handback: Mobile retains its window
after the current harness release, and own-leave runtime/release follows later coordination. The
current harness release excludes own-leave, new providers and import orchestration.

1. **Current harness and confirmed own leave.** Finish the existing exact-candidate integration and
   acceptance, then complete the single own-leave action's confirmation, canonical effect/receipt,
   concurrency, authorization, privacy and recovery boundaries. Submission is not approval. The
   current release and runtime coordination remains in force.
2. **Additional provider support.** Integrate OpenRouter as the first candidate through the existing
   tenant provider configuration, encrypted key custody, model gateway, inventory, allowances and
   pause controls. Verify its current API, model/tool behavior, routing and data-handling terms before
   choosing the adapter contract. Record the selected provider/model and supported behavior; preserve
   fail-closed configuration and bounded calls. A provider switch must not change HR permissions,
   confirmation requirements or the owning business services. Compare capability, latency and usage
   cost using the same reviewed scenarios. Provider connectivity, credentials and production HR data
   transfer are separate acceptance steps, not implied by this roadmap amendment.
3. **Orchestration evaluated through imports.** Select one concrete import workflow after reviewing
   the production import needs. Start with source-backed mapping suggestions, ambiguity/duplicate
   detection, validation explanations and correction proposals. Keep page/cell/row provenance where
   the supported input permits it. The existing module preview, fresh server validation, human
   review and canonical commit remain the owners of imported facts. Expand into durable multi-step
   coordination only through the typed registry and the existing autonomy/approval rules. Never
   bypass import validation or invent missing HR values to improve a benchmark.
4. **Measure during the production import.** Establish a comparable manual or existing-flow baseline
   and log the AI-assisted flow on reviewed, comparable batches. Measure elapsed preparation and
   completion time; actual human handling time when recorded; manual corrections/interventions;
   mapping acceptance and reviewed errors; validation failures, duplicates, rework and successfully
   committed rows; and model usage, cost and latency where available. Separate model extraction or
   suggestions from validated and committed outcomes. Retain batch/source references and evaluation
   definitions so the comparison can be checked. Report observed improvements and regressions with
   their sample limits; do not equate elapsed time with staff effort or invent headcount savings.

The exact first production dataset, import module, supported file formats, provider/model selection
and improvement targets are still **UNKNOWN**. Determine them from the actual import work before
finalizing acceptance. The future live installation remains distinct from today's alpha/staging
host under the repository/environment owner decision; this amendment does not deploy to either or
authorize sending an existing production dataset to a new provider immediately.

## Request

The owner wants an AI HR orchestration agent and its harness on top of the existing HR engine. The
agent must do work, not only answer questions. It must also assess which processes agents can improve,
to reduce handling time and headcount.

## Facts at decision time (verified in code on 2026-10-19)

- The HR Assistant's ten tools are read-only by design and by test (`core/assistant-tools.ts`,
  `test/assistant-tools-shape.test.ts`). Tool calls in one turn run concurrently, which is only safe
  because no tool writes.
- The only executed agent effect is `close_fixed_upstream` (`core/agent-actions.ts`), human-approved,
  precondition-rechecked and applied through the existing payroll anomaly service.
- `core/orchestrator-harness.ts` versions a label and one state function. No prompt, action set,
  autonomy policy or evaluation set is versioned.
- The governed write services already exist and enforce their own permissions: leave, claims,
  attendance corrections, profile changes, movements, lifecycle cases and steps, reminders. There is no
  generic workflow engine; each module owns its approval chain.
- The scheduled orchestrator runs as an anonymous system context with `hr_admin` role
  (`scripts/review-sweep.ts`).
- No code measures cycle time or human handling time. `domain_event`, step timestamps, `lc_history` and
  `hr_orchestration_case` hold enough to measure volume, elapsed time, waiting, rework and how many
  times a person acted. **Minutes of human effort are not recorded anywhere.**

## Decisions

### 1. The agent acts only through a closed, typed action registry

Every effect is an entry in a code-owned registry: input schema, required permission, autonomy tier,
preconditions, blast-radius cap, idempotency key and the existing governed service it calls. The model
never writes to the database, never names the actor and never chooses a service outside the registry.
Text from HR records is data: an instruction inside a claim description cannot add an action, widen
scope or skip a confirmation, because deterministic code validates every argument before execution.

### 2. Three autonomy tiers (owner decision, 2026-10-19)

| Tier | Meaning | Allowed for |
| --- | --- | --- |
| Automatic | Executes without a click, within caps and switches | Reminders, requests for missing information, chasing overdue approvers along existing escalation routes, and steps whose completion the engine itself can prove |
| Confirm | The person sees the exact effect and clicks to execute | Actions on the requester's own behalf (for example submit my leave), opening a case |
| Approve | The agent prepares; the existing approver decides | Profile corrections and anything already routed through an approval chain |

Pay, claim money, approvals, terminations, ratings, hiring, promotion, discipline, payroll and access
are never Automatic and never self-approved. A model can lower a tier, never raise it.

### 3. A named agent account per tenant (owner decision, 2026-10-19)

Unattended runs act as a named agent principal per tenant, restricted to the registry, not as an
anonymous `hr_admin`. Each effect records `actor_type='agent'`, the agent principal and the
administrator who switched that agent on. The principal is not a login and cannot sign in.

### 4. Execution is durable and outside the model loop

An action executes in its own transaction through its owning service, after the model turn ends,
never inside the assistant's concurrent tool loop. A new execution ledger (Phase 2) records intent,
state, idempotency key, precondition digest and the receipt event id. `domain_event` stays the record
of what changed; the ledger never copies HR values. A timeout is never permission to repeat an effect.

### 5. Harness

A versioned bundle (prompt, action set, autonomy policy, model) is stamped on every run. Evaluation
uses redacted replay scenarios plus adversarial cases (injected instructions, cross-company and
cross-tenant reads, salary leakage, unauthorized actions). A new bundle is compared against the
previous one before a reviewed per-tenant rollout, with rollback on measured outcomes.

### 6. Process assessment is deterministic and comes first

Savings cannot be claimed without a measured baseline, so assessment ships before any acting agent.
Code computes every figure; no model participates in Phase 1. The assessment reports, per process
and over a selectable window:

- volume started, completed and still open, and open items older than seven days;
- median and 90th-percentile elapsed time to the final decision or completion;
- staff actions per 30 days: recorded actions on the window's cases by a login that is not the employee
  the case is about (a login linked to the same person counts as the employee);
- the share of recorded actions already done by system or agent;
- cases closed without any decision (withdrawn or cancelled while pending), so that started equals
  completed plus open plus closed;
- rework: rejected, withdrawn, cancelled or reopened share.

Each process also carries a static, versioned fit profile in code: whether the engine can verify the
outcome, whether the decision is routine, judgement or consequential, and the candidate agent actions
with their tier. The recommended agent role follows from those facts:

- too few completed cases → *measure first*;
- consequential decision → *assist* (prepare, check completeness, chase; a person decides);
- otherwise → *automate parts*, naming the candidate actions.

Processes are ranked by staff actions per 30 days. Staff time and full-time-equivalent figures appear
only when the administrator enters minutes per staff action and hours per full-time month. Those
inputs are not stored and the result is labelled an estimate from the administrator's inputs. No
default minutes, no removable-share percentage and no headcount reduction are invented.

## Phase 1 scope and limits

- Route `/control-tower/opportunities`, admin only, scoped by existing RLS: every query starts from
  the scoped source table and joins events by aggregate id, so a company administrator sees only
  cases they could already open. Aggregates only; no names, amounts or reasons.
- Processes: leave requests (excluding imported history), claims (excluding drafts), attendance
  correction requests, profile change requests, onboarding cases, offboarding cases and employee-data
  readiness cases.
- Counting rules: a leave submission split into several rows is one case, and events recorded on its group
  id belong to it. Rows re-issued by a partial cancellation carry the original decision on a newer row; they
  are bookkeeping copies, not cases, and are excluded. Durations that would be negative are excluded rather
  than shown as zero. Per-date decisions emit one event per date, so one approval session can count as several
  staff actions. Actions on separate leave-cancellation requests and events from external actors are not
  counted.
- Limits: staff action counts depend on services writing events. A person's work outside the system
  (email, phone, spreadsheets) is invisible. Elapsed time is not effort. Lifecycle staff actions come
  from `lc_history`. This is a baseline, not an efficiency audit.

## Future phases (not claimed)

2. Registry, execution ledger, agent principal and harness v1 with about six actions. The assistant
   proposes actions as confirmation cards, integrated with the reconciled Assistant action layer rather
   than a second mechanism (see the dependency reconciliation above).
3. Goal-driven orchestration agent (scheduled or requested from the Control Tower) planning only
   within the registry; deterministic plan validation; durable steps with leases, approval-bound
   resume and a dead-letter list.
4. Before/after measurement per process using the Phase 1 baseline; the assessment then recommends the
   next agent from measured outcomes.

Each phase is a separate round with its own acceptance evidence. New model callers register in the AI
inventory (ADR-0116) and are governed by its allowances.

## Design-only amendment, 2026-10-23: submit my leave

Status: **Source-only development authorized on 2026-10-24; runtime and release deferred as above.** Source review used main `acfede39b`; this is not
runtime acceptance or a production capability claim. The current harness increment remains separate
and awaits both boards' explicit resource handovers before validation.

### Outcome and first boundary

An employee asks for leave, reviews an engine-produced effect, and explicitly confirms submission of
their own request. Success means the canonical request was recorded and can be reopened. It does not
mean the leave was approved, the absence occurred or a payroll outcome was achieved.

Recommended first envelope: one eligible ordinary Annual Leave type, one explicitly selected own
active employment, one prospective calendar date, and `full_day` duration. The engine determines the
deductible weight; the model must not assume that a full-day application always deducts 1.0 days.
Use the eligible type's ID and canonical semantics, never a guessed name or translated label. Resolve
multiple employments or matching types with the person before preparing anything.

Hand off to the existing Leave form for spans, half/hourly leave, emergency/maternity/replacement
leave, required documents or extra statutory facts, unpaid portions, conversion/splitting overrides,
and privileged policy exceptions. Required remarks must be supplied by the person or handed off;
they are never invented. Do not silently broaden this envelope to make a request succeed. The Leave
page already supports opening its form with `apply=1` and an optional `start`; no broader prefill or
free-text-in-URL contract is established by this design.

Options considered: using only the existing form is simplest and remains the fallback, but does not
deliver the confirmed Assistant action. Writing inside the model tool loop is rejected because a
tool call is not human confirmation and the current loop is concurrent. The recommended separate,
human-only command adds a small durable lifecycle and transaction-scoped validation work, while
preserving the leave owner and avoiding conversation threads or a general planner in this slice.

### Existing owners and reconciliation

FACT — the sources to reuse:

| Fact / operation | Existing owner and relevant limit |
| --- | --- |
| Own employments and eligible types | `core/read.ts`; all applicable own employments must be considered |
| Day/balance preview | `previewLeaveDeduction` through `packs/leave/service`; advisory, not every submission gate |
| Submit and approval routing | `requestLeave` through `packs/leave/service`; accepts an explicit enclosing transaction |
| Submission result | `RequestLeaveResult` references the request and possible children; it does not itself return approval status |
| Atomic replay precedent | `core/mobile-leave-command.ts`: own-subject check, lock, intent digest, domain command and receipt in one transaction |
| Assistant authorization | `core/assistant-grant.ts`; the source-only change accepts an optional caller transaction; module resolution remains separate |
| Model work and allowances | `core/assistant.ts`, the governed gateway and ADR-0116 |
| HR change history | `domain_event` and canonical leave records; no model-written HR facts |

The earlier `ai-round1-action-layer-PLAN.md` revision 2 was read from the prior planning session's
side-session notes. It remains unapproved and broader than this amendment: it included leave
decisions, conversation threads and folding the anomaly action into a registry. Reuse its independent
human-confirmation boundary and savepoint idea. Its old dispatch defect is already fixed on main;
do not rebuild it. Do not merge `codex/board16-home-ai`, adopt its obsolete migrations, copy its broad
authority-stamp function or create a parallel prepared-action mechanism.

For the eventual implementation, choose one shared owner for prepared Assistant actions. Its lifecycle
metadata owns preparation, confirmation and execution references; leave records own leave facts.
`agent_proposal` remains derived evaluation evidence, never the execution receipt. The existing
`close_fixed_upstream` anomaly workflow retains its own business owner; this slice does not migrate it.
Mobile's receipt pattern is precedent, not permission to emit `mobile.leave.submitted` for Assistant
actions or to add a second retry layer around a committed submission.

### Graph and authority contract

`authenticated user → own active employment → eligible leave type → prepared intent → explicit
confirmation → requestLeave → canonical request + submission events → existing approval chain`.

The proposed code-owned registry has only `leave.apply` at contract version 1 in this slice, tier
**Confirm**, blast radius one submission. It names a strict schema, supported envelope, permission
checks, deterministic preview, freshness dependencies and the canonical executor. No arbitrary service
name, SQL, actor, tenant, approval decision or consent token is accepted from the model.
Its proposed versioned bundle identifies the preparation prompt/schema, one-entry action set,
confirmation policy and configured model revision. The receipt links the initiating exchange and
governed model-run references without copying their content. This action bundle is distinct from the
current deterministic `readiness-v2` harness; no versioned action bundle exists merely because this
design names one.

Preparation and confirmation require the live authenticated login, person linkage, own active subject,
applicable company scope, Assistant grant, required modules and unpaused AI/action controls. A manager
or HR role does not turn this into on-behalf submission. Keep the real user context; never synthesize
`hr_admin` authority or discard grants to emulate another role. A company transfer, person relink,
termination, revoked grant or lost module invalidates the old preparation.

This confirmed self-service action records the human as the domain actor with separate Assistant
provenance. A named unattended agent principal and unattended execution are outside this first slice;
the broader Phase 2 principal decision is not treated as implemented.

### Preparation, card and human confirmation

1. The current ten Assistant read tools remain read-only and their offered-only dispatch stays intact.
   A future bounded proposal adapter may nominate one structured intent after the model turn. Server
   validation and persistence happen outside the concurrent read-tool loop. There is no model-callable
   confirm, execute, discard or approval tool. No new conversation-thread store is required for this slice.
2. Deterministic code resolves the own subject/type, checks the supported envelope and obtains the
   source preview. Ambiguous or unsupported input yields a question or the existing form, not a card
   with invented fields. A preview is not a promise that all submission gates will pass.
3. Store one immutable, user-bound prepared intent with a server-issued action ID, version, creation
   and expiry, exact input digest, effect digest and dependency references. Proposed expiry is ten
   minutes; this is a design recommendation, not an existing customer rule. Expiry never replaces
   live revalidation. A changed intent is a new preparation and requires a new confirmation.
4. Render the card from validated fields and localized templates: company/employment, leave type,
   weekday and full date, requested duration, engine-calculated deduction, available/after balance
   labelled as a current estimate, the person's own reason/remark, warnings, and the approval handoff.
   Unknown routing is labelled unknown. The button says **Submit leave request**; asking a question,
   pressing Enter in chat, selecting a card or a model's assertion is never confirmation.
5. The human-only authenticated POST accepts the opaque action ID and the reviewed digest/version,
   not replacement business arguments. Apply the application's origin/CSRF protections. Bind the
   action to the same login, tenant and person; replay by another login is refused even for the same
   person. Discard and expiry create no leave request.

The source-only candidate reader creates no action ID or durable preparation. It requires a separate
human-selected employment/type pair matching the model nomination, uses the salary-free own-subject
inventory and dated company proof, and delegates the eligible catalogue and deduction to their existing
owners. Unknown company history, future company transfers, documents, non-Annual types, uncovered
deductions and conversion/split previews hand off to the existing form. This narrows the Assistant
envelope; it does not change what the canonical form or leave service permits.

Available estimates must subtract pending reservations through `availableLeaveBalance`; the legacy
preview's `balanceAvailable` is the raw ledger figure. The opt-in preview fields preserve that distinction
without changing existing consumers. The own-leave card respects the canonical ESS `available` setting
and omits both estimates when hidden. Full-day duration retains the engine's weight, including 0.5.
These source paths remain unvalidated and internal. They do not check every submission gate or AI
control and cannot be wired as a prepared/confirmable action until those owners are complete.
The candidate reader captures validated copies of nomination, human selection and human text before
its first database await, while withholding their refusal responses until after authorization. A
retained input object cannot replace this invocation's human text or selection during actor reads.
The corresponding real-transaction mutation regression is authored but unrun.

Source-only preview work also adds opt-in `includeHolidayWarnings` to `previewLeaveDeduction`.
Read-only projection and submission events share the leave owner's dated company/calendar traversal
and the holidays owner's completeness calculation; the default preview output stays unchanged.
The projection creates no request or warning event. Its new tests inspect the still-open transaction
and compare preview/submission warnings, but remain unrun. The Assistant candidate now carries the
exact canonical warning list, and the review digest binds each country/state/year/loaded/required
field, including absence. The bounded one-date candidate accepts at most one warning; unexpected
fan-out hands off to the Leave form. The schema describes evidence, not a second completeness rule.
The future UI must actually render these fields before its confirmation is usable.

One strict candidate schema is shared by the source reader and human-review digest. The review digest
uses a separate domain from the immutable input digest and binds the exact labels, deduction and
visible estimates to that input. Hidden estimates remain null together. This does not freeze or
validate hidden source dependencies; the command still needs the authoritative effect check before
writing. Neither hash encrypts protected content or proves consent.

### Atomic execution and uncertain outcomes

The intended confirm transaction locks the prepared action, checks its identity/final state/expiry,
refreshes authority, and validates the exact current effect before executing. It calls
`requestLeave(ctx, input, tx)` through the pack facade. A successful domain write, canonical event
references and completed action receipt commit together. One action ID can produce at most one
committed submission, including simultaneous double clicks and a lost HTTP response.

The source-only bounded path now requests the canonical submitted event's ID directly from
`appendEvent`'s own INSERT, and returns it with the request reference. A later holiday warning or
other companion event cannot substitute for that reference. Existing event callers retain their
insert-only/void path; ordinary leave callers do not receive the new field. The opt-in INSERT uses
RETURNING under the caller's existing event policies; it does not add an access grant. Authored
tests check an employee's own event, a later warning companion, the ordinary result and enclosing
transaction rollback, but remain unrun. These are uncommitted source references, not an action
receipt or acknowledgment of commit. The command, lifecycle storage and atomic completed receipt
still do not exist.

The source-only exception adds optional enclosing-transaction parameters to the existing preview and
Assistant grant helpers. Their default paths still open their own transactions; passing the command's
caller-scoped transaction is required for a shared recheck. These source changes and their rollback
regression tests are not yet runtime-validated. The grant helper still consumes the supplied session's
entitlement snapshot: that snapshot must be freshly resolved by the command's authority owner.
Neither change establishes an atomic confirm command. The leave owner must expose/check the
confirmed effect at the authoritative calculation
point, with the relevant existing locks or dependency checks, before its first write. A second preview
on a different snapshot is insufficient. Do not implement a preview by calling the write service and
rolling it back, or duplicate the leave engine's policy math in the action registry.
The source candidate now composes an internal `readOwnLeaveActorTx`: it joins the existing access
configuration lock, checks the transaction's login/tenant/role carriers against the supplied context,
verifies the live login/person link and `app.principal_snapshot_current()`, then resolves fresh entitlements and
uses the canonical Assistant-grant gate in that transaction. It never replaces claimed roles with
broader current grants. It refuses a transaction isolation other than Read Committed rather than
calling an older report snapshot fresh. The shared access migration already joins identity/role/lifecycle
writers to that lock. This is a bounded authority prerequisite; it does not fence Assistant grants, modules,
leave policies or balances, and does not supply the missing AI pause check. Its refusal tests for a
disabled module, relinked person, removed role, older snapshot and mismatched transaction/role claims
remain unrun. No confirmation command or authority capability is created by this refreshed context.
The actor reader copies identity and nested role carriers before its first await, so caller mutation
cannot switch the context between its transaction proof and subsequent reads. Its unrun regression
mutates the retained input while the real lock query is pending and checks the original binding.
Source-only work now adds an optional server-owned `ReviewedOwnLeaveEffect` precondition to
`requestLeave`, requiring an enclosing transaction. It captures the expected subject/company/type,
one date, deduction and private pending-aware balance; it can only add a refusal. The ordinary calling
path retains its existing policy. The guarded path excludes documents/consents/special facts and
nonordinary types, checks own-subject/company binding, and compares this execution's deduction and
canonical availability immediately before insertion. Existing HR bypass flags (including advance
notice) are refused without fabricating another role context. Tests catch the typed refusal inside
the still-open transaction and then check for unchanged requests/events, so rollback cannot conceal
a guard placed after a write. These tests remain unrun.
Source review found that the candidate's exact human remark could differ from the canonical
request's stored text: submission trims the remark and stores an empty result as null. The bounded
candidate now consumes that same normalization owner and hands such input to the existing form;
the guarded write independently refuses a normalization change before insertion. It never silently
rewrites the immutable intent or changes the ordinary form's storage policy. Missing required
remarks still request human input. Internal whitespace and reason text remain exact when the
canonical writer preserves them. Candidate/refusal/persistence regressions for these cases are
authored but unrun; the prior whitespace candidate test was insufficient to prove stored text.
The expected effect now also requires an explicit canonical warning list, copied before awaits and
compared field-for-field with a read-only recheck before insertion. An unrun regression changes the
loaded gazette count on another date while preserving deduction/balance, then requires refusal in
the still-open transaction. This is a sequential recheck; calendar writers still need the eventual
dependency concurrency protection, including the post-insertion warning-event path.
The guarded path also reuses `isEmploymentEnded` for both the current day and requested date and
requires the employment to have started. A last-day login retaining source visibility does not make
a later absence an active-employment request. The unrun test asserts visibility before refusal.

This precondition is not a concurrency solution. The command still needs a source/dependency strategy
covering changes by existing form, approval, ledger and configuration writers; an action-ID mutex alone
does not coordinate those writers. Hidden balance expectations belong in protected server-owned
content, not in a posted review or public lifecycle metadata. No confirmation endpoint may rely on this
precondition as an authorization, freshness or receipt mechanism by itself.
Two additional authored regressions change actual source data after review: an ordinary canonical
borrower submission reserves Annual availability while its raw ledger stays unchanged, and the
public Attendance policy owner changes Full dates to Half while availability and holiday warnings
stay unchanged. Each requires the stale reviewed effect to refuse inside a still-open transaction
without adding requests/events. Both remain unrun and cover sequential revalidation only, not
concurrent writer fencing or a completed confirm command.
Source review confirms that `withTenant` passes no explicit write-isolation option and does not call
`lockAccessConfigurationTx`. Its optional read-only report snapshot cannot be treated as a write
dependency lock. Joining an explicit transaction is therefore only one prerequisite of confirmation.

FACT (source only) — the balance dependency extends beyond the selected Annual type.
`availableLeaveBalance` resolves its source ledger and subtracts pending requests for that source
**and every type borrowing from it**, through `balanceSpenderTypeIds` and `pendingLeaveDays`.
Excluding borrowing types from this Assistant's selectable menu does not exclude their reservations
from the authoritative balance. A lock on only this action ID or selected request cannot protect that
predicate, including insertion of a new pending borrower request.

The existing approval owner takes `leave-balance:<tenant>:<employment>:<source type>` in
`finalizeLeaveApproval`. Source inspection found additional direct ledger inserts in leave adjustments,
opening-balance/history/ordinary imports, hiring, TOIL and the leave grant/year/reversal owners.
The inspected adjustment and import services do not explicitly join that approval lock. The existing
`guard_frozen_leave_balance` trigger checks an encashment hold; it does not acquire the balance lock.
These findings do not establish an exhaustive transitive writer inventory or current database behavior.
They rule out treating the approval mutex as an already universal reservation barrier.

A bounded static inventory at the same runtime source base found 62 direct Drizzle writes to the
named `leaveLedger`, `leaveRequest`, `leaveRequestDate` and `leaveType` bindings across 17 files in
`core`, `packs`, `db` and `scripts`. This includes cancellation/edit and encashment paths as well as
submission, approval, imports, adjustments, hiring, grants and source-type configuration. It is a
starting set, not a complete dependency graph: aliases, raw SQL, stored procedures, historical
migrations, external writers and transitive lock acquisition are outside that syntactic query.
Finding a lock literal anywhere in an enclosing function does not prove that a particular branch
acquires it; not finding one does not rule out a callee doing so.

FACT (source only) — [`commitLeaveHistoryImport`](../../core/leave-history-import.ts) and
[`commitLeaveBfImport`](../../core/leave-bf-import.ts) deliberately open a separate `withTenant`
transaction per accepted row, then append their batch summary in another transaction. A barrier on
an outer import wrapper or its final summary would not cover the actual row writes. Any participant
integration must join the real per-row write transaction before that row's protected reads/effects;
it must preserve the existing row-level failure isolation. Runtime interleaving and rollback behavior
remain unverified.

DECISION — settle and enforce the dependency barrier at the existing source owners before exposing
confirmation, covering pending reservation inserts/status changes, ledger movements and source-type
mapping changes. Do not add an Assistant-only mutex and call it protection from legacy writers.
Prove the chosen strategy against actual legacy form submissions, approval/cancellation, negative
adjustments/imports and a borrowing type reserving Annual balance, with the protected expectation
either still valid at the serialized effect or refused for fresh review. The participant/lock order,
predicate coverage, employee RLS behavior and deadlock handling still require design and runtime
evidence; no new barrier, migration or isolation guarantee is implemented by this audit.

Before implementing savepoint recovery, trace every command callee for effects outside the supplied
transaction. A database rollback cannot undo a network delivery or a separately committed writer;
such a path must be moved behind the existing transactional event owner or excluded from this action.

FACT (source review only, own-leave source `61d5cce61a913faaf86e341cc034b8c1c88f1693`) — the inspected
post-insertion path in [`requestLeave`](../../core/leave.ts) does not deliver a notification or open a
second transaction. `insertLeaveRequest` receives the supplied `tx`, inserts the pending request,
obtains the exact submitted event reference through `appendEvent(tx, ..., { returnId: true })`, and
calls `generateApprovalSteps` with that same transaction. [`appendEvent`](../../db/events.ts) performs
only the event insertion; returning its identifier is not a delivery acknowledgement.
The final working-day warning path also retains that transaction: `leaveHolidayCompletenessTx`
passes it to [`warnIfHolidaysIncomplete`](../../core/holidays.ts), which reads the holiday counts and
appends `holiday.completeness.warned` through the same event owner. The dynamically imported
[`frozenSnapshotFor`](../../core/leave-encashment.ts) is a supplied-transaction SELECT, not a separately
committed encashment operation. The `withTenant` fallback at `requestLeave`'s return is not selected
when the future command supplies `existingTx`.

This narrows the effect audit; it does not establish an exhaustive transitive audit, trigger behavior,
or a working savepoint boundary. The bounded reviewed path refuses attachments and conversion
consent, requires Annual leave, and fixes both dates to one day; attachment, Emergency decomposition,
replacement-credit and multi-date branches must stay unreachable rather than being assumed safe.
One additional dependency is explicit: `generateApprovalSteps` resolves approval configuration and
org/reporting facts **after** inserting the request. Those reads, and the final holiday-warning reads,
must remain inside the eventual protected dependency interval. The earlier approval-chain read or
pre-insertion holiday comparison cannot stand in for their protection. The review deliberately says
`approvalRouting: unknown`; a submitted receipt must not claim a particular approver or approval.
Runtime rollback/event/step atomicity and the remaining read dependencies are still unverified.
A regression is now authored in `test/leave-reviewed-own-effect.test.ts` for that late-effect boundary:
it configures a real two-level approval policy and working-day warning, submits through the existing
guarded service inside a supplied transaction, first requires both actual approval steps plus submitted
and warning events to exist, then throws an enclosing-command error and requires all request/step/event
rows to be absent outside that transaction. It has not run. It checks rollback of those real callees,
not savepoint recovery, concurrent-writer fencing, or a completed action receipt.
A second unrun regression uses the actual `applyLeaveAdjustmentBatch` owner to subtract one Annual
day after review, requires its canonical adjustment event and fresh balance change, and then requires
the old reviewed expectation to refuse without adding requests/events in the still-open transaction.
This covers a sequential HR adjustment, not an interleaving or participation in a shared lock.

If a dependency or effect changed, refuse the old confirmation and offer a freshly reviewed proposal.
If the service refuses, a savepoint may roll back its writes while the outer transaction records a
bounded refusal code. Unexpected errors abort the transaction. Never silently add override/unpaid
consent, substitute another type or change the date. Any unexpected split/child result is outside
this first contract and must roll back before it can be labelled successful.

Proposed durable states are `awaiting_confirmation → completed | refused | discarded | expired`.
Executing is transient under the transaction lock; it is not advertised as durable progress before
commit. A lost commit acknowledgement is still an **unknown client outcome**, even for a wholly
database-owned command. A timeout must show **Checking submission**, not Failed or Submitted, and
must not generate a fresh action ID. Reconcile by reading the same action under fresh authorization.
The same ID can return its committed receipt or safely resume the locked, uncommitted intent after
revalidation; it cannot bypass this owner by directly calling the service again. Recovery must not
infer identity from similar dates/reasons. Never automatically cancel a committed request to undo an
uncertain transport result.

The completed receipt holds only source references, action/bundle version and bounded outcome codes.
Reopening the request rechecks current source access; a frozen receipt does not preserve access after
revocation. Display current canonical approval status separately from **Submission recorded**.
Notifications remain owned by existing event projection; delivery failure cannot resubmit leave.

Source preparation now makes that display boundary fail closed in
`core/assistant-actions/own-leave-reconciliation.ts`: a completed lifecycle/receipt pair alone returns
**Checking submission**. To name the recorded request, the interpreter additionally requires minimal
server-only projections of the currently readable canonical request and its actual submitted event.
The request must match the receipt reference and current tenant/person/employment/company binding;
the exact event must match the receipt reference, request aggregate, submitting user and subject.
Wrong event kinds/actors, missing evidence, transplanted references and extra private/status fields
remain unconfirmed. Those projections are not a posted capability, and parsing does not establish
authorization or provenance. The actual authorized canonical read owner and completed-state storage
are still missing. New pure regressions are authored but unrun; prior 101-test evidence applies only
to the earlier source. No endpoint, read transport, submission, retry or provider call is added.

### Privacy, allowance and Control Tower boundaries

The minimum proposed intent envelope contains the selected IDs, date/duration and user-authored
reason/remark needed to submit. It is not a copy of balances, payroll, profiles, rosters or model tool
results. Sensitive free text must not enter generic traces, action history, model-usage ledgers or
metrics. Separate erasable, short-lived intent content from immutable metadata and digests; retention,
erasure and protected-storage integration must be settled against the existing privacy owner before
implementation. No new cryptographic storage or retention guarantee is claimed here.

Model-assisted preparation uses the existing Assistant gateway and all current user/company daily
request and monthly token policies, including the default-user replacement rule and cumulative
company caps. Preserve the older Assistant business quotas and their documented periods too.
Confirmation/reconciliation are deterministic and make no provider call or new token reservation;
they neither refund nor reset earlier model usage. Recommendation: exhausted model allowances stop
new model admissions, while a still-authorized prepared confirmation spends no extra model quota.
Explicit pause/revocation stops new confirmations; the ordinary Leave form remains available. A future
non-admitting control check must reuse the canonical governance owners, not invent a quota bypass.

FACT (source only) — `0541_ai_control_centre.sql` and its replacement admission function in
`0568_ai_user_default_allowance.sql` do not expose a non-admitting pause check. `app.ai_admit` inserts
an `ai_model_run` for both allowed and blocked requests, including a zero-token reservation. An
allowed zero-token run still participates in daily request counting. Calling it and settling zero
tokens therefore cannot implement deterministic confirmation without changing accounting. The
ordinary policy read is also insufficient: its RLS permits an employee to read feature/default/own
user policies but not every applicable company policy. An absent visible company policy cannot mean
that company is unpaused.

DECISION — confirmation must consume a non-admitting answer from the canonical governance owner,
with complete policy visibility and the same tenant `ai-control` lock used by policy writes. Extract
the applicable pause predicate there when the centrally coordinated migration is available; do not
duplicate the filtered policy query in the Assistant action owner or change existing admission
accounting. Preserve the admission owner's applicable-company resolution and the individual-user
replacement of the default policy, including disabled defaults. Checking only the nominated
employment's company would silently narrow the existing control scope. This is a required owner
integration, not an existing function or a claim that the full dependency concurrency problem is
solved. No endpoint may execute while that answer is unavailable. Acceptance must show that an
otherwise invisible applicable company pause refuses confirmation, and deterministic confirmation,
replay and reconciliation leave model-run rows and allowance usage unchanged.

FACT (source only) — `lib/ai/crypto.ts` provides master-key authenticated encryption; the per-subject
erasure key custody is a separate owner in `core/pii-vault.ts`. Directly encrypting an action payload
with the master key does not join subject erasure. The vault's existing seal/unseal wrappers open
their own transactions and its key rows are admin/DPO-only. The confirmed employee flow must not
expand those permissions, open a second transaction for private intent custody or claim that importing
the crypto helpers supplies erasure. Protected intent storage still needs an explicitly scoped
transactional owner, action/identity binding and integration with `erasePersonPii`; none exists in this
source checkpoint. Keep private text and hidden balance expectations out of metadata and receipts
while that integration is unresolved.

The same action owner supplies the person's prepared card and status. Control Tower uses scoped
metadata aggregates and authorized failure codes; it does not expose employee reasons, bank data or
another user's confirmation button. Execution completion and approved HR outcomes stay separate.

### Acceptance required before any implementation can be called complete

| Outcome | Required evidence after explicit implementation authorization |
| --- | --- |
| Confirmed own submission | Actual ask → card → confirm → source request → reopen; single and multiple own employments |
| Human intent and immutable effect | Forged input, another login/employee/company/tenant, altered date/type/digest, expired/discarded action and injected record text cannot execute |
| Fresh authority and policy | Revocation, transfer, relink, module/pause changes, balance/roster/calendar/notice changes and KL midnight invalidate or recheck safely |
| No duplicate committed effect | Parallel confirms, connection loss around commit and same-ID replay; source row/events and receipt agree; prove key assertions with isolated mutations |
| Safe failure and recovery | Domain refusal saves no request; unexpected failure rolls back; uncertain outcome reconciles without blind retry or invented success |
| Existing service contracts | Offered-only Assistant dispatch, read-only tools, Mobile receipts, leave approvals/notifications and governance consumers retain valid behavior |
| Honest experience | Six locales, populated/empty/refused/changed/unknown states, desktop/mobile, keyboard confirmation, source links and runtime logs |
| Privacy and accounting | No source/private text in traces; retention/erasure demonstrated; model admissions count normally and deterministic confirm makes no provider call |

The original design created no action registry, table, endpoint, confirmation card, principal, prompt
or migration. The 2026-10-24 exception permits only source development of this first action. Before
runtime validation, refresh released source and reconcile the final shared lifecycle with the prior
plan, coordinate any migration allocation centrally, and honor both predecessor handbacks. Complete
and release the current harness before Phase 2 release work.

### Adjacent candidates discussed, not part of the first action

The same leave agent can later offer **withdraw my pending request** as a separate typed Confirm
action through `cancelOwnLeave`. Its current service is pending-only, own-person-only and refuses
grouped requests; it must be rechecked at confirmation. If approval wins the race, do not transform
withdrawal into approved-leave cancellation. Approved cancellation remains the separate existing
`requestLeaveCancellation` workflow, with its own eligibility and approval rules. Neither is added to
this first submission contract.

A future document import agent can extract and propose mappings from explicitly supported formats,
retain page/cell evidence, flag ambiguity and duplicates, then submit a reviewed batch through each
module's existing import owner. Broad-format extraction does not grant write access or justify guessed
identity, bank, salary or policy values. This is a candidate scenario, not authorization to build it.

## Amendment, 2026-10-25: remaining AI delivery and non-admitting controls

The owner instructed AI dev 2 to work on all remaining AI parts and explicitly selected **Take over
and coordinate directly** for AI dev, Board 3 and Mobile. This authorizes continuing the remaining
design and implementation. It does not establish that any future phase is implemented, remove the
existing human decision boundaries, or permit concurrent use of another chat's runtime window.

Delivery order follows the dependencies: finish the existing harness and its production-mode outcome
walkthrough first; complete the confirmed own-leave action with protected intent, fresh authority,
source dependency protection and atomic receipt next; then expand the closed action registry and
named non-login principal, durable orchestration/recovery, controlled bundle evaluation/rollout and
before/after measurement. Each action must demonstrate its own canonical outcome and boundaries.
Completing a shared runtime does not establish that every HR adapter is ready. Existing user/company
daily request and monthly token controls remain authoritative. No invented savings or unattended
consequential HR decisions are authorized.

### A pause check is not a model admission

FACT (source): `app.ai_admit` always inserts a model-run row. An allowed zero-token reservation still
counts as a daily request, while an employee's ordinary policy query cannot see every applicable
company policy. Neither operation is a suitable pause check for deterministic confirmation.

DECISION: use a non-admitting boolean from the canonical governance owner within the command's
caller-scoped transaction. It checks the same feature switches, applicable company scope and effective
user policy as admission, including individual-user replacement of the tenant default. It reveals no
policy rows or hidden company identity. New model admissions still enforce quotas; deterministic
confirmation consumes no additional model request/tokens and does not refund prior usage. An explicit
pause refuses a new effect even if the earlier proposal was admitted.

The source draft extracts two **private** SQL helpers shared by model admission and this boolean:

- Context validation, the existing tenant `ai-control` lock, authorized company attribution and canonical
  feature setting resolution.
- Applicable feature/company/user/default policy selection, in the existing `scope_key` order.

Admission keeps its quota loop, attribution, reservation, run insertion and settlement contract. A
feature pause retains its precedence over quota refusals. The action check considers enabled/paused
state only; zero/exhausted quotas do not become pauses. The internal policy selectors are revoked from
PUBLIC and the application role; only the boolean is exposed. The TypeScript wrapper shares the
gateway's existing fresh entitlement/platform-kill calculation and treats absent/malformed answers
as unavailable.

This boolean is only a prerequisite. It does not grant Assistant, module, employment, action or
approval authority; verify those through their canonical owners. The action owner must keep the same
transaction open through the effect. The `ai-control` lock fences `ai_control_policy` writes, including
removal of a user override. It does not by itself fence settings, membership, company transfers or
other source changes. Those still require the action's existing access barrier and complete dependency
strategy. A stale repeatable-read snapshot must not be presented as a fresh control read.

### Draft integration and required acceptance

`db/migration-drafts/ai-action-controls.sql` is deliberately outside the migration journal and must
never be applied manually. Allocate a migration only after coordinating the current unpublished
Board 3 reservations and their ascending release order. No existing applied migration is edited.
No route, model tool, UI, principal or action executor calls this source-only check.

The authored integration cases require an actually migrated, isolated database and app-role execution:
hidden applicable company pause; full company scope; effective default/override replacement; feature,
setting and platform pauses; no-login/default behavior and tenant isolation; inaccessible private
helpers; invalid capability refusal; and byte-equivalent model-run rows before/after repeated checks.
Admission must still enforce zero quotas and retain pending reservations. Also required before wiring:
concurrent pause/confirmation ordering, source actor freshness, valid and invalid tenant contexts,
unchanged allowance/accounting consumers, restricted-owner upgrade rehearsal and the final release
gate. These cases are authored or specified, **not runtime-verified** by this source checkpoint.

## Source amendment, 2026-10-25: private pending-review lifecycle

The owner explicitly reaffirmed continuing the remaining AI **source changes** while waiting, with
no shared runtime until handback. The own-leave branch now integrates the already-released main
`573c01ff3`, including its Home/privacy wrapper; no unpublished Board 3 source is adopted. The
current harness release candidate remains separate from this Phase 2 source.

### Authoritative ownership and graph

`human input + canonical read-only candidate → pending review metadata + private envelope → reopen |
discard | expiry | canonical person erasure`. This increment creates no leave request, completion
receipt, approval, model tool, route or submission executor. A stored review is not human confirmation
or proof that current eligibility/dependencies still match.

`app.assistant_own_leave_review` owns only the pending review's identity, immutable input/review
digests, server creation/expiry and retirement state. Its companion private content row owns the
encrypted nomination, exact human text, displayed review and hidden pending-aware balance expectation.
The existing HR engine remains the owner of every source fact. No metadata, event or public card
contains the hidden balance, encryption envelope, key custody or copied source records.

The candidate now retains its private availability expectation separately from its display review.
The public card uses one strict schema and explicitly maps its fields; it never serializes the
server-only candidate result. Both displayed estimates remain null when ESS hides availability.
The candidate/digest and card share one warning evidence shape; gazette thresholds remain owned by
the holidays service.

### Custody and lifecycle decisions

- One random DEK per pending action, using the existing envelope primitives and master-key owner.
  Authenticated bindings include action/version, tenant, login, person, company, employment and both
  intent/review digests. This does not widen `pii_key` access or use the statutory subject key table.
  The private row holds the wrapped action key and ciphertext together. Errors carrying encrypted
  query parameters are replaced with a bounded error without their cause before leaving the store.
- SQL owns creation and a ten-minute review lifetime. This is the lifetime of a confirmation review,
  not an HR policy or a substitute for revalidation. The cipher binds immutable identity/digests;
  provisional application timestamps are not trusted as persisted expiry.
- Prepare and reopen refresh Assistant access through its owner and check the non-admitting AI pause
  prerequisite in the caller transaction. No model run, provider call or quota reservation occurs.
  Existing module/grant/dependency barriers are still required at eventual execution.
- Discard requires current same-login/person/source custody and the exact reviewed digest. It remains
  possible after an AI pause or removed Assistant grant, because it only removes private intent and
  can never submit leave. Repeated discard returns the same terminal reference.
- Read expiry and discard remove both private body and wrapped key in the same transaction as the
  metadata transition. The private tables and full-record helpers have no application-role grants;
  only the narrow custody functions are callable. No `completed` state/writer is exposed by this store.
- A bounded group-administrator expiry primitive retires at most 1,000 expired reviews per call. No
  scheduled caller is wired yet. Validity expiry therefore does **not** establish that unaccessed
  ciphertext is automatically deleted on schedule. Scheduled cleanup must be integrated and observed
  before exposing a production preparation endpoint.
- Private preparation has its own deterministic storage admission, separate from provider/model
  allowances: at most five unexpired pending reviews and twenty newly prepared reviews per login and
  tenant in a rolling ten-minute window. These are technical storage/abuse limits, not HR policy or
  consent. The existing tenant Access lock serializes the count and insertion; SQL owns creation and
  expiry times. Retiring a review frees outstanding capacity but does not reset its creation-rate
  budget. Other logins do not share that budget. A private owner/time index bounds the rolling lookup.
  Pending/rate refusal uses the same non-content store error and changes no model accounting.
  Runtime proof of concurrent admission ordering and endpoint request-rate control remain required.

These are source contracts, not measured security guarantees. No KMS/HSM upgrade, irreversible
deletion from retained backups/WAL/old exports or JavaScript-memory erasure is claimed.

### Canonical person erasure

The privacy service composes `assistant_own_leave_reviews_redact` after its existing Home/Access
erasure admission, within the same transaction. The admission already owns the current subject,
administrator scope, Access/privacy barriers and final canonical audit. Review erasure follows the
**person**, across all their employments and logins, and clears untyped review content for every
valid erasure scope, matching the existing private-message/vault treatment. It does not change the
existing statutory retention rules.

The new owner records an ephemeral transaction-bound erasure intent, removes action keys/bodies,
retires pending reviews as unavailable and requires the real `pii.erased` event to report
`assistantPreparedReviews` exactly when content was removed. Missing admission, forged/mismatched
audit or unfinished effects refuse the transaction. The current-transaction marker survives forced
early deferred-constraint evaluation, so a later preparation cannot recreate uncaptured private text
in that erasure transaction. A later authorized custody call prunes completed older markers under
the shared Access lock. No raw reason, review or key is copied to this erasure marker/audit.

### Acceptance and remaining boundary

Source integration review caught a concrete erasure/report boundary defect: the new
`assistantPreparedReviews` report label reached the legacy field-to-column lookup, which assumed
every report entry was a PII column. The column update now iterates the canonical field registry
and selects only its erased members; private-review retirement remains a reported effect. Authored
regression cases require contact NULLing and review/key retirement together, and ordinary contact
erasure without a false review-erasure report. These cases remain UNRUN.

New authored cases cover envelope round-trip/tamper/transplant/oversize/missing-key failures; actual
save/reopen/discard/expiry; hidden balances/public-field exclusions; same-person different logins and
tenant refusal; no model accounting or leave writes; private-table/helper ACLs; enclosing rollback;
bounded cleanup; cross-employment person erasure and forged/unfinished erasure audits. All new tests,
SQL application, types, builds and app journeys remain **UNRUN** under the resource restriction.

Additional authored storage-admission cases distinguish the five-pending limit from a twenty-created
rolling window, cover retired-review budget consumption, old-window release and separate-login
capacity, and require zero model/request writes. Competing preparation calls must share five pending
slots, and simultaneous discard deliveries must reconcile to the same terminal reference with no
remaining private body. They remain UNRUN; no concurrent capacity guarantee or deployed rate-control
claim follows from source review.

Before wiring, demonstrate these cases on the actual restricted-owner/app-role database, forced
constraint and concurrent erasure/prepare orderings, revocation/transfer/snapshot boundaries, scheduled
cleanup and retained-backup limits, plus existing privacy/Assistant/leave consumers. Resolve any
source-integration findings in the final released baseline. The two SQL drafts remain outside the
migration journal without numbers; central allocation and ascending release order come later.

The atomic confirmation command is still absent. It must protect legacy leave-writer dependencies,
recheck the exact reviewed effect at the canonical write, commit the request/exact submitted event
and completed action receipt together, and reconcile uncertain transport outcomes. It must not
mistake this pending store or its digests for that missing authority, concurrency or execution proof.

### Source-only canonical submission reference reader

The canonical read owner now has an unmounted `readOwnLeaveSubmissionReferenceTx` draft. In the
caller's transaction it joins the exact request and submitted-event IDs through the existing leave,
employment, person and type sources, with RLS and the flat leave reader's delegation filter. It
additionally narrows to the caller's own person and original human event actor, including for an HR
admin. It selects only request identity/company references and submitted-event identity/actor/subject
references; it never materializes reason, balance, status, approvers or event payload. An authored DB
regression uses a real employee submission and fresh read, refuses another real login for the same
person even with an HR role, and refuses a mismatched event reference. A second authored case creates
another person's real submission, proves that the HR caller can read its canonical request, and
requires the own-submission projection to refuse it and a cross-linked real event reference.
Source review then found that comparing only the supplied context did not itself bind that context
to the transaction login. The draft now composes the existing `ownPersonPredicate` and explicit
current transaction user/tenant checks. Authored cases also borrow a different real context inside
the HR caller's transaction, including another login for the same person; both must refuse. These
cases remain unrun and do not establish the future adapter's complete freshness/authorization proof.

This is **UNRUN** source preparation. Syntax parsing and diff checks are not database/RLS proof.
The helper neither establishes fresh Assistant authority nor reads completed action storage; a
future server-only lifecycle adapter must obtain that authority and bind these source projections to
the same stored action/receipt. There is no mounted confirmation/reconciliation endpoint, new effect,
provider call or migration. The existing concurrency/atomic-completion and security acceptance remain
unfinished. The P branch's canonical read change must be integrated with the actually released
baseline before runtime acceptance; it is excluded from the current H release and Mobile handback.

### Source-only representative display

`components/assistant/own-leave-review-card.tsx` consumes only the strict public card shape and is not
mounted on any route. It renders exact source labels, selected KL date, requested full-day duration,
canonical deduction (which can differ from one day), visible-only balance estimates, warnings and
plain human text. Unknown approval routing and the saved estimate/expiry are explicit. There is no
submit handler, form action, hidden command payload, local persistence or model/client/database import.
The only navigation is the existing date-only Leave-form fallback; its copy explicitly asks the person
to check the company, type and text in that governed form.

The six catalogues contain matching new display keys/placeholders and existing keys are preserved.
Authored DOM cases cover text escaping, hidden balances, malformed/private props, exact date/deduction,
date-only fallback and each locale's warning. They remain UNRUN. No visual quality, translation review,
keyboard/screen-reader behavior or real viewport/render evidence is claimed. Review the representative
screen in the actual app before mounting/propagating the component or adding confirmed submission.


## Owner expansion: AI workspace, providers and governed domain agents (2026-10-26 KL)

**Decision:** After the current harness release, deliver a complete AI product plan covering
provider/router configuration (OpenRouter as the first candidate), an AI home/workspace and chatbot,
orchestration, and Import, Payroll, Leave and Attendance agents. The purpose includes measuring
capability and improvement during real production imports. Access-right enforcement is a release
condition, not a model instruction. This extends the earlier roadmap; it does not claim these agents
are implemented or authorize unreviewed production data transfer. Current H release remains separate.
The coordinated Mobile window still follows H; own-leave verification uses its later agreed window.

### Existing surfaces and honest gaps

Source inspection of the H candidate finds `/assistant` (question form, own recent exchanges, visible
stop states/tool-use disclosure, module/grant checks), `/admin/ai` (admin tenant provider settings),
`/control-tower/agents` and the orchestrator section of `/control-tower` (operations/agent management).
`/me/home` is the employee home; do not silently replace it or expose HR operations there. The current
Assistant is a basic ask/history screen, not the proposed complete conversational workspace. Source
presence does not establish that a particular production user has the module, grant or configured
provider. Confirm production entitlement and navigation through the authorized user's actual UI
without publishing private grants or keys. Existing canonical tools include own leave balances and
requests; extending that registry must preserve its explicit field projections and refusal semantics.

Use the existing Assistant entry as the user AI workspace rather than create competing chat histories.
The workspace should offer permitted tasks, a conversational thread, source links the caller can open,
review cards, pending confirmations, run progress and honest terminal receipts. Show active company/
employment when relevant, but never let a client selector grant access. Denied, unavailable, incomplete,
stale and cancelled outcomes need distinct actionable messages. Keep admin provider controls and
cross-workforce queues in their existing guarded operations surfaces. Review desktop/mobile and all
six locales before propagating the final representative interface. Discoverability, grant denial and
empty/unconfigured states are acceptance items, not merely route existence.

### Delivery sequence and entry/exit conditions

| Order | Deliverable | Required exit evidence |
| --- | --- | --- |
| 0 — current | Release the existing reviewed harness | Exact-candidate required local gate, outcome walkthrough, official deployment and arrival; preserve current baseline and peer changes. |
| 1 | Human-confirmed own-leave Assistant | Complete the existing atomicity, legacy-writer fencing, current authority, receipt/reconciliation, CSRF, retention and DB security/concurrency work. Real submit/reopen and uncertain-response recovery must not duplicate requests. |
| 2 | AI workspace and provider configuration | Extend existing surfaces/gateway; first provider adapter contract tests and fake-server security tests, then explicitly configured live connection verification. No production HR payload required for connection tests. |
| 3 | Governed orchestration and first Import agent | Bounded planner/tool runner through the harness, reviewed dry-run import suggestions, canonical validation and human commit; demonstrate scope/privacy and actual measurement capture. |
| 4 | Payroll, Leave and Attendance agent expansion | Domain-specific canonical tools and approval boundaries, security matrix, actual UI outcomes and fresh candidate release evidence for each increment. |
| 5 | Controlled production-import evaluation | Approved exact dataset/module/provider/data policy, recorded baseline and assisted comparison, canonical commits and reconciliation; report measured outcomes and limitations. |

Planning/source preparation may overlap these phases. Provider and additional agent execution does
not bypass unfinished own-leave correctness or the coordinated release/resource order. Do not invent
calendar delivery dates or classify an unrun adapter as ready.

### Provider/router configuration

Extend the tenant BYOK/configuration/gateway owners; do not create agent-specific key stores. Admin
configuration covers provider, approved endpoint, model, supported tool/structured-output capabilities,
privacy/routing policy, bounded timeout/retry, token/run/concurrency budgets and usage visibility.
Store encrypted secrets server-side; return masked presence only. Rotate/revoke without exposing keys
in the browser, tools, events, diagnostic errors or exports. Connection testing is explicit and uses a
non-HR payload. Validate supported capabilities per selected model and fail visibly on incompatibility.

An OpenAI-compatible URL is not evidence that every tool/stream/usage/error behavior is interchangeable.
Implement a normalized provider contract and test malformed tool arguments, partial streams, refusal,
truncation, cancellation, rate limits, timeout, usage reporting and provider failure. Tool writes are
never replayed merely because the provider timed out. Bind receipts to the actual provider/model and
policy version, not a silently substituted model.

Allow only approved HTTPS endpoints; reject private/loopback/link-local/metadata destinations,
redirect escape and DNS rebinding. Custom enterprise endpoints require deliberate allowlisting and
must not convert provider configuration into an SSRF route. Routing/model fallback cannot loosen
privacy, region, capability or cost constraints; refuse if no eligible endpoint remains. No automatic
external search/plugins/subagent tools receiving HR data. An application agent can only invoke our
registered, authorized tools. Provider credentials do not grant data access.

Primary documentation checked 2026-10-26: [OpenRouter provider routing](https://github.com/OpenRouterTeam/docs/blob/main/guides/routing/provider-selection.mdx),
[ZDR guidance](https://github.com/OpenRouterTeam/docs/blob/main/guides/features/zdr.mdx),
and [retention boundaries](https://openrouter.ai/blog/insights/zero-data-retention/).
Routing preferences, required parameters and retention filters need explicit adapter enforcement.
Provider inference retention controls do not cover our logs or external tool services; audit those
separately. Recheck current documentation, selected endpoint terms and account capabilities before
implementation/live enablement. No pricing, residency or universal no-retention guarantee is assumed.

### Agent boundaries

| Agent | Allowed job within current user scope | Human/canonical boundary |
| --- | --- | --- |
| Import | Suggest column mappings, normalize proposed formats, explain validation errors, flag ambiguity/duplicates and assemble a reviewable correction plan. | Never invent missing HR facts. Existing module preview and fresh validation own admissibility; a human reviews exact rows/mappings and invokes canonical commit. |
| Payroll | Explain authorized canonical payroll results, locate exceptions and propose investigation/correction steps. | Canonical payroll engine computes every amount. No model calculation, pay change, batch close, payment, export or sensitive-document disclosure without the real permissions and governed human action. |
| Leave | Explain visible balances/policy and prepare an own-leave request; expand scoped HR assistance only through separate authorized tools. | Exact human confirmation for submission; canonical leave validation/approval routing remains authoritative. An employee cannot query another employee's balance by name or guessed ID. |
| Attendance | Explain visible attendance/exceptions and prepare correction or import proposals. | Actual clock/evidence ownership, manager/HR attestations and approval workflows remain unchanged; no fabricated work times or autonomous overtime approval. |

Agent names are task configurations over one governed harness, not new authority-bearing accounts.
Adding more agents never enlarges the caller's tool set. For multi-step work, display the proposed
plan, affected records and review checkpoints; bind each step to explicit typed tool contracts.
Bound steps, wall time, tokens, concurrency, cost and result size. Pause/cancel must stop further
admissions and reconcile in-flight canonical effects. Retries use domain-supported idempotency and
stored receipts; no generic repeat-write loop. Record proposed/running/awaiting-human/completed/
refused/failed/cancelled/uncertain states accurately. A model saying success is never a receipt.

### Access and privacy invariants — release blocking

Authenticate fresh on the server and derive tenant/user/person/employment, roles, grants, delegations
and company scope there. Never accept these as authority from prompt, tool arguments or browser state.
Each retrieval, tool call, download and eventual write rechecks current authorization through the
canonical read/write owner and RLS. Filter before retrieval/provider dispatch: do not send broad rows
to the model and ask it to hide unauthorized fields afterward. Use explicit allowlisted projections,
field-level sensitive-data rules and least-data result limits.

A manager sees only currently delegated/direct-report information allowed by the product; ordinary
employees receive their own authorized records only. HR/admin labels alone do not mean unrestricted
salary, medical, discipline or tenant access. Multi-employment/company selection preserves the exact
underlying authorization. Unknown scope denies. Identifiers, names, file cells and model instructions
cannot grant access. Refusals should not reveal whether an inaccessible employee or document exists.

Conversation/run/attachment storage, source links, audit views, exports and background continuations
must enforce their own current permissions. Permission revocation must invalidate queued work and
prevent retained conversation or cached/RAG snippets from leaking now-inaccessible data. Cache/vector
indexes must carry tenant, subject/field scope, authorization version and retention/deletion metadata;
recheck source permission before reuse. Establish tenant/user isolation before introducing retrieval
augmentation or long-lived memory. Logs should retain minimal operational metadata, not raw salary,
identity documents, prompts or imported personal rows by default. Define retention, erasure and
provider-dispatch records with the existing privacy owners.

Imported documents, CSV cells, retrieved text and tool results are untrusted data, including embedded
instructions to reveal records or call tools. Tool selection, strict schemas, authorization, egress
policy and write confirmation remain deterministic. No free-form SQL, shell, generic HTTP, privileged
service credential, credential-reading tool or cross-agent authority transfer is exposed to the model.

Security acceptance covers own/other employee, manager in/out of reporting scope, delegated/expired
scope, HR restricted company, group roles, foreign company/tenant, suspended/revoked user, guessed IDs,
conversation/attachment replay, poisoned cache/RAG, malicious import cells, tool argument injection,
indirect prompt injection, provider fallback, background retry and export/source links. Test result
content AND absence of unauthorized database reads/provider payloads/cache hits/log entries. Exercise
both direct endpoints and the actual chatbot UI; a prompt-only refusal is insufficient. Any proven
unauthorized disclosure blocks release and requires fixing the canonical boundary and regression.

### Production-import capability and improvement evaluation

First identify the actual import module, supported formats, dataset ownership/size, sensitive columns,
canonical validator and commit/reversal semantics. Start synthetic/redacted, then approved production
samples in preview-only mode. Exact raw HR payload dispatch requires explicit tenant-authorized policy
and provider approval; the roadmap itself is not that approval. Compare equivalent datasets/tasks and
scope under the same canonical validation. Keep the baseline and AI-assisted attempt records separate;
use fresh isolated evaluation copies where necessary so a prior commit cannot contaminate comparison.

Record elapsed preview-to-success time, actual human handling time (separately from model/server wait),
interventions, accepted/rejected suggestions, reviewed mapping accuracy, unresolved ambiguity,
validation errors, duplicates, rework, successfully committed/reconciled rows, input/output tokens,
cost and latency. Publish denominators, dataset/version, model/prompt/tool versions, failed attempts
and quality tradeoffs. Calculate improvement only from comparable measured values; no guessed time
savings or headcount claims. Acceptance requires no unauthorized disclosure, no invented accepted facts,
canonical validation and exact commit reconciliation, then an owner-agreed quality/cost/time target
based on the real baseline. Faster invalid imports do not count as improvement.

### Implementation ownership and release discipline

Existing AI configuration/gateway, Assistant registry, harness, canonical module services and privacy
owners remain authoritative. Start with a source inventory and acceptance/security matrix for each
increment; update the graph for identity, permission, tool, event, run, receipt and dependency edges.
Allocate migrations centrally and preserve applied hashes. Validate representative desktop/mobile,
localization, keyboard access, populated/empty/error/refusal/stale/uncertain states and actual save/reopen.
Local verification is required in this session under the user's no-GitHub-Actions instruction.
Run the classifier-selected exact-candidate release gate after outcome evidence; only then use the
canonical release and verify service/build/source/ledger arrival. Keep main/alpha at the same VERIFIED
commit per standing owner policy. These remain planned acceptance requirements, not current PASS claims.


### Owner requirement: self-improving agents, orchestrator and shared harness

**Decision (2026-10-26 KL):** Every domain agent, the orchestrator tied to the Assistant, and the
shared harness must support measurable self-improvement. This is required product scope, not an
optional later label. The Assistant remains the human interaction and confirmation boundary; the
orchestrator plans and coordinates its scoped tools/agents behind that boundary. A separate chat,
agent or improvement worker cannot inherit greater authority from orchestration.

Use one versioned improvement loop: authorized feedback and verified run outcomes → categorized
failure/opportunity → proposed candidate → isolated replay/evaluation → security and quality gates →
controlled promotion → monitored outcomes → rollback when required. Capture user corrections,
rejected suggestions, unresolved questions, canonical validation results, failed/refused/uncertain
runs, import rework and measured cost/latency. A model self-rating or unverified user assertion is not
a ground-truth label. Preserve provenance and distinguish observations from reviewed labels.

- **Domain agents:** improve prompts, task plans, explanation clarity, mapping suggestions and tool
  selection against domain-specific evaluation cases. Retain canonical financial/leave/attendance
  rules; do not learn new policy or missing HR facts from an example. Learn from successful AND failed
  cases and review error categories rather than simply optimize completion counts.
- **Orchestrator:** evaluate routing, decomposition, handoff quality, tool ordering, recovery,
  cancellation, repeated-work avoidance and budget use across the Assistant's actual end-to-end jobs.
  No routing shortcut may bypass human confirmation, current permission checks or canonical validators.
- **Harness:** turn observed failures into proposed regression cases and improve diagnostic coverage,
  typed contracts, bounded retries, reconciliation and evaluation instrumentation. Harness/code/tool
  changes use the repository's reviewed implementation and exact-candidate verification pipeline.
  An executing model has no shell, repository-writing or deploy credential to patch its own guardrails.

Version agent definitions, prompts, tool schemas, orchestration policy, model/provider configuration,
evaluation datasets and harness code. Record which versions produced each result and improvement.
Compare candidates with the same baseline and protected holdout cases, including adversarial security,
not solely examples seen while learning. Check task accuracy, factual grounding, refusal correctness,
canonical successful effects, duplicate prevention, human corrections, privacy, latency and cost.
Reject regressions in mandatory access/privacy or money/data-integrity invariants even if average
quality or speed improves. Include tests that deliberately attempt to weaken these invariants.

Promotions are bounded by an independently owned policy: candidate generation and sandbox evaluation
can run automatically within explicit tenant budgets; only the permitted change classes may use
validated automatic promotion. Authorization rules, security/evaluation thresholds, tool capabilities,
provider data policies, financial rules, production datasets and rollout eligibility cannot be relaxed
by the candidate or evaluator itself. High-impact changes use the existing owner/review/release path.
The improvement loop cannot approve its own security exception or remove a failing release test.
No infinite self-modification/retry cycle: cap iterations, concurrency, spend and wall time, and pause
on repeated failure, leakage suspicion, degraded outcomes or insufficient evidence.

Use offline/redacted replays first, shadow recommendations next and a limited opted-in rollout only
after eligibility. Promotion must have a reversible version pointer and a recorded reason/evidence;
rollback or disable the new version when monitoring finds regressions. Shadow work cannot make
business writes. Test actual rollback, interrupted promotion and in-flight version consistency.

Learning data remains permission-scoped. Do not pool raw conversations, import rows, salary or
employee facts into shared prompts, embeddings, memory, training sets or provider fine-tuning.
Tenant/user authorization, consent where applicable, retention and erasure govern feedback storage
and reuse. A current user may not retrieve another user's historical learning examples. Cross-tenant
product improvements must use approved de-identified/synthetic cases and privacy review; a claimed
anonymization is not evidence. Provider model training or fine-tuning requires a separate explicit
approved data policy. Revocation and erasure must propagate to derived feedback and replay datasets.

Acceptance for EACH agent AND the Assistant-linked orchestrator/harness includes: a reproducible
baseline; one observed failure converted into a reviewed improvement candidate; measured before/after
results on relevant held-out cases; unchanged negative access/security results; bounded evaluation
cost; honest failure/uncertainty reporting; versioned promotion receipt; and verified rollback. A
candidate must demonstrate improved outcomes without lowering security or silently reducing coverage.
Until that loop is implemented and proven for a component, label it learning-capable/planned rather
than claiming it is already self-improving. The current H release does not acquire these capabilities
merely because this roadmap records them.


### Owner clarification: one governed self-improving agent for every module

**Decision (2026-10-26 KL):** Import, Payroll, Leave and Attendance are initial examples, not the
complete agent scope. Every system module must have a self-improving module agent. Each agent talks
to its own canonical module engine/service through registered typed adapters. The Assistant-linked
orchestrator routes and coordinates these agents; it does not become a second business engine.

Use `packs/catalog.ts`'s `MODULE_CATALOG`, the pack registry and actual canonical service owners to
build the coverage matrix. Include core, HR, payroll and platform modules, submodule capabilities,
and future additions. Do not infer that an entitlement flag already has a separate engine; identify
its real owning service and explicitly map that capability. Non-pack-backed modules still need a
named canonical owner. No omitted module may silently count as complete because it lacks a pack.
Country/jurisdiction capabilities use their established country-pack rules, not model-derived law.

For every module record: module/agent identity; canonical engine owner and public service boundary;
permitted read/explain/prepare/confirm capabilities; input/output schemas and minimal projections;
tenant/module entitlement and current user/scope checks; human approval requirements; audit/event/
receipt ownership; idempotency and reconciliation behavior; dependency/version compatibility;
provider/privacy/budget constraints; evaluation dataset and improvement version; pause/rollback
control; implementation status and acceptance evidence. A coverage invariant must flag a new module
or changed engine contract that has no matching declared agent capability/evaluation coverage.
Unimplemented entries remain explicitly pending and unavailable, never generic unrestricted tools.

An agent is a logical module capability on the shared harness, not a mandatory permanently running
model process. It may be invoked on demand, conserving cost while preserving one accountable agent
identity per module. Submodule agents can reuse their parent engine adapters only with explicit
capability/entitlement mapping and their own relevant evaluation coverage. Reuse shared orchestration,
provider and improvement machinery; do not duplicate records, balance calculations, workflows or
policy rules into prompts or agent memory.

The invocation path is: authenticated Assistant request → authorized orchestrator plan → permitted
module-agent capability → typed canonical service/engine → source-derived result/receipt → scoped
Assistant response. The server constructs the actor/scope at every boundary; a model cannot supply an
admin context, arbitrary service name or SQL. Reads and effects must satisfy the same engine rules
as the module UI. Permission revocation and scope changes are rechecked before handoffs and effects.

Cross-module work composes independently authorized capabilities and canonical receipts. Permission
to use one module never grants another module's records, sensitive fields or actions. Cross-agent
messages contain only the minimum authorized references/results and do not transfer credentials or
accumulate the union of service privileges. A Payroll→Attendance→Leave task must refuse any denied
step without exposing denied facts; resume or reconciliation must not duplicate already committed
work. Persistent/background work requires an explicit scoped delegation lifecycle and revocation
checks, not an unbounded service-account identity.

Every module agent participates in the versioned self-improvement loop above. The module's actual
engine and deterministic business rules stay authoritative. Learned orchestration strategies and
agent improvements must preserve ALL module permission, financial, workflow and privacy invariants.
Platform agents cannot grant access, change security policy, send arbitrary notifications or mark
release tests passed merely because those are platform functions. Their tools remain narrowly
scoped and their high-impact actions stay under the established human/governed workflows.

Deliver in measurable waves beginning with the existing own-leave and production-import goals, then
expand through the complete module matrix. The final scope is system-wide; staged delivery changes
sequence, not that requirement. A module agent is done only after its real engine integration, UI
journey, denied-access/prompt-injection tests, audited effects where allowed, measured improvement
loop and rollback are demonstrated. An empty registry entry or chatbot persona is not completion.


### Owner requirements: low communication/token cost and responsive interaction

**Decision (2026-10-26 KL):** Token use, communication cost and response latency are core acceptance
criteria for every module agent, the Assistant, orchestrator and self-improving harness. Optimize
cost per successfully completed, authorized task together with quality and responsiveness. Do not
claim savings or response-time compliance before measuring a representative baseline and candidate.

One logical agent per module does not require an LLM call per module or per handoff. Use deterministic
intent routing and canonical engine queries for supported structured tasks; invoke a model only where
interpretation, planning or explanation adds value. Avoid repeated model restatement/reasoning at each
hop. Engine-to-agent structured results and internal service calls do not inherently need model tokens.
Use compact typed messages, source references and versioned shared run state rather than forwarding
whole transcripts, catalogs, schemas, imports or employee records between agents. Load only the
relevant authorized tool definitions and minimal fields/rows, with bounded pagination/result sizes.

Read bounded previews/summaries from canonical sources; do not send entire import files for a small
mapping question. Preserve exact dates, identity, units, warnings, permissions and receipt references
when compressing context. Summaries are derived context, not new HR facts or permission evidence.
Coalesce identical authorized in-flight reads and cache only when subject/tenant/scope/source version,
retention and revocation are correctly bound. Never reuse another user's sensitive response simply
to save tokens. Provider prompt/result caching must meet the selected privacy policy; cache eligibility
and actual billable discounts require provider-specific verification. No blanket cache or savings claim.

Route suitable tasks to evaluated smaller/less expensive models and escalate only on defined quality
or capability criteria. Escalation/fallback must retain tool support, privacy and authorization policy.
Set per-task and per-tenant limits across ALL steps, retries, agents and improvement evaluations:
input/output/context tokens, provider requests, tool calls, concurrency, elapsed time and spend. Stop
with an honest partial/uncertain state when exhausted; never drop an access check or silently truncate
a required validation to meet a budget. Bound retries and avoid duplicate provider/tool work after a
transport error; effect reconciliation remains canonical and does not require another model request.

For latency, define task classes: direct authorized lookup, conversational explanation, proposed action,
and long-running import/orchestration. The first two take the shortest eligible path; do not launch
multi-agent planning for a simple balance question. Provide an immediate honest acknowledgement for
longer work, stream useful permitted answer content when safe, and show actual stage progress for
background jobs. A spinner/acknowledgement is not a completed answer. Do not stream unvalidated,
unauthorized or speculative sensitive content. Separate first acknowledgement, first useful result,
final answer, confirmation and committed business effect in telemetry and user claims.

Bound provider/tool deadlines, queue time, overall interactive time and background-job duration.
Parallelize only independent authorized reads; preserve transaction/ordering and confirmation rules
for effects. Use bounded queues/backpressure instead of unlimited agents competing for resources.
The user can cancel or leave/reopen a long job and inspect its canonical progress/receipt; reconnecting
must not restart paid work or repeat business writes. Timeouts disclose what completed, failed or is
still being reconciled. Provider failure must produce a prompt actionable result, not an indefinite
wait or a fabricated success. Degrade to available canonical UI/engine results when appropriate.

Instrument p50/p95 latency and cold/warm behavior for the actual end-to-end task, including permission
checks, retrieval, queueing, provider/tool time and retries. Record input/output and cached/reasoning
usage only where actually reported, request counts, payload sizes, cost and successful completion.
Distinguish measured usage from estimates and reconcile billing where supported. Agree numerical
latency/cost budgets by task class using real baseline and production-import targets, not one arbitrary
SLA for every workload. Alerts, hard budgets, regression gates, run inspection and tenant pause
controls must make overruns visible and controllable.

Every self-improvement candidate must report quality/security, human corrections, cost and latency
against comparable baseline cases. Reject optimizations that save tokens/time by weakening scope,
privacy, factual accuracy, financial rules, required review or evaluation coverage. Test cancellation,
timeouts, rate limits, unavailable models, cold caches and large imports as well as the happy path.
The acceptance matrix for each module includes these cost/responsiveness outcomes alongside its
engine integration, access controls and improvement/rollback proof.


### Current AI release verification: explicit owner retest exception

On 2026-10-26 KL the owner explicitly instructed: “And only repair and retest those that fail,
dont need to rerun. I give full permission for the exception”. For this AI release, retain authentic
completed passing checks, repair and retest the failures, and execute required checks that have not
yet run. Do not restart the whole suite merely because a repair changes the candidate commit.
This direct owner exception overrides the general fresh-whole/reuse restriction for this release.

Keep original raw outcomes, exact counted coverage, source/diff lineage, environment and failed-to-
repaired retest results. A cancelled run, unexecuted check or still-failing assertion remains so;
never manufacture a PASS receipt or relabel partial coverage as a completed whole run. If existing
release verification cannot represent this authorized evidence composition, use an explicit reviewed
exception validation path that verifies the real evidence and its scope. Do not silently bypass the
operator's integrity checks. The exception does not authorize weakened permissions, financial or
privacy rules, fake clocks, omitted outcomes or GitHub Actions in this session.
