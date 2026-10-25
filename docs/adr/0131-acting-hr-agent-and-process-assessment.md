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
  ciphertext is automatically deleted on schedule. Scheduled cleanup and preparation admission/rate
  bounds must be integrated and observed before exposing a production preparation endpoint.

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

Before wiring, demonstrate these cases on the actual restricted-owner/app-role database, forced
constraint and concurrent erasure/prepare orderings, revocation/transfer/snapshot boundaries, scheduled
cleanup and retained-backup limits, plus existing privacy/Assistant/leave consumers. Resolve any
source-integration findings in the final released baseline. The two SQL drafts remain outside the
migration journal without numbers; central allocation and ascending release order come later.

The atomic confirmation command is still absent. It must protect legacy leave-writer dependencies,
recheck the exact reviewed effect at the canonical write, commit the request/exact submitted event
and completed action receipt together, and reconcile uncertain transport outcomes. It must not
mistake this pending store or its digests for that missing authority, concurrency or execution proof.

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
