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
| Assistant authorization | `core/assistant-grant.ts`; current grant helper opens its own transaction |
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
