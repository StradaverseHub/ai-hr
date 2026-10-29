# ADR-0151 — Orchestrator action layer: user-parity actions and learning from the system

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- **Date:** 2026-10-28
- **Status:** Accepted by the owner on 2026-10-28 ("Accept, start wave 1"), including the six first-wave entries
  (§5) and the generic receipt shape on the existing prepared-action store (§4.3). The design go-ahead came the
  same day ("Yes go ahead for step 1"), with the added requirement that "we also have to consider the agent
  learning from the system itself as we will be enhancing and adding functionalities to the system as time pass."
  Wave 1 implementation is authorized. Bulk manager decisions, scheduled agents and any provider change are not
  part of wave 1 (§8). Accepted is not merged, tested, installed or released.
- **Extends:** [ADR-0131](0131-acting-hr-agent-and-process-assessment.md) Phase 2–4 (registry, ledger, agent
  principal, harness), [ADR-0109](0109-central-hr-orchestrator.md), [ADR-0116](0116-central-ai-inventory-and-allowances.md),
  [ADR-0084](0084-propose-adjudicate-learn.md), [ADR-0082](0082-ai-assistant-access-scoped-tool-calling.md).
- **Related:** ADR-0004 (authorization), ADR-0135 (configurable access), ADR-0006 (domain events).

## 1. Request

The owner wants the AI orchestrator to be able to do **everything each user can do with their access rights**,
and to keep doing so as the product grows: when a module or screen is added, the agent must be able to learn
it without a parallel rewrite, and its behaviour must improve from how the system is actually used.

## 2. Facts at decision time (verified in source at main `c0dd878b1`)

| Fact | Where |
| --- | --- |
| The Assistant chat has 12 read-only tools; one turn runs tools concurrently, which is only safe because none writes. | `core/assistant-tools.ts:981`, `core/assistant.ts` |
| 19 actions are prepared and confirmed by a person on fixed `/assistant/*` pages; the model only links there. The model's nomination parser can return `prepare` with `effect:'none'` only. | `lib/ai/module-human-handoffs.ts`, `lib/ai/module-agent-actions.ts:135` |
| One physical store already owns every prepared action: `app.assistant_own_leave_review` (name historical), with an `action_kind` CHECK over the 19 actions, intent/reviewed digests, sealed encrypted content, a five-state lifecycle and per-action unique receipt-event columns. | `db/migrations/0622_own_leave_review_store.sql`, `core/assistant-actions/*-review-store.ts` |
| Every action source re-checks login currency, Assistant grant, module entitlement and the `hr_assistant` pause before reading choices, preparing or confirming. | `core/assistant-actions/module-action-server.ts` |
| Completed outcomes are linked to the job that produced them only through a closed, human-chosen association; semantics name what the effect does **not** prove (e.g. `submitted_not_approved`). | `lib/ai/module-native-outcomes.ts`, migration 0650 |
| A governed improvement harness exists: candidate → ≥2 independent held-out evaluations with zero security/quality failures → promotion by an approver who is not the author → bounded jobs and ≤24h expiry → automatic baseline on regression. | `lib/ai/module-agent-improvement.ts`, `core/module-agent-releases.ts` |
| The Control Tower agent action catalogue has one type, `close_fixed_upstream`, `propose_only`, blast-radius cap 50. | `core/agent-actions.ts` |
| The nightly orchestrator runs as an anonymous system context with role `hr_admin`. | `scripts/review-sweep.ts` |
| Process assessment (ADR-0131 Phase 1) measures volume, elapsed time, staff actions and rework per process; no model participates. | `/control-tower/opportunities` |

Coverage gap (source sweep of 165 `"use server"` files, 28 Oct 2026): roughly 250 human capabilities, of which the
AI can prepare 19 and read about a dozen. Largest gaps: employee leave edit/cancel, claim cancel, overtime and
clock-removal requests; every manager approval except a single leave decision; HR personnel maintenance,
imports, leave and attendance administration, lifecycle cases; payroll inputs and statutory filings; user,
role and access administration. Several mutating services rely on RLS alone (e.g. `assignRole`,
`setCompensation`, `erasePersonPii`); their enforcement must be confirmed before they are wrapped.

## 3. Graph

Nodes: tenant, login (USER), person, employment, role assignment, effective permission, registry entry,
prepared action, confirmation, owning service, domain event, outcome association, evaluation suite, harness
bundle, agent principal.

- A **prepared action** belongs to one tenant, one login, one registry entry and the subjects that entry
  names. It stores digests and sealed content, never a copy of HR facts.
- A **confirmation** belongs to the same login (or to the existing approver for Approve-tier entries) and binds
  the exact reviewed digest.
- The **owning service** writes HR facts and emits the domain event; the prepared action stores only the
  receipt event id.
- A **registry entry** names its owning service, permission predicate, tier ceiling, evaluation cases and
  outcome semantics. It is code, reviewed like code.
- The **agent principal** belongs to one tenant, is enabled by a named administrator and can act only through
  Automatic-tier registry entries.

## 4. Decisions

### 4.1 Parity rule: the agent can do exactly what the user can, never more

For a signed-in user, the orchestrator's authority is:

> current effective authority of that login **∩** registry entries **∩** tier policy **∩** tenant switches and allowances

It is achieved by construction, not by a second permission model:
- every effect executes through the **same owning service** a screen uses, under the caller's own
  `SessionContext`, with fresh in-transaction checks and RLS;
- the registry's permission predicate is a **mirror for offering only** (as `moduleActionEntryRoleFloor` is
  today); a mirror that is looser than the service is harmless, a mirror that is stricter only hides an offer;
- revocation applies at the next check; no grant, scope or role is cached in a prepared action.

The agent can be **less** capable than the user (an entry is missing, a tier forbids it, a switch is off),
never more. Acceptance requires a role matrix per entry — employee, manager, assigned approver, company HR,
group HR, payroll partner, performance partners, other tenant — proving the same allow/deny as the screen.

### 4.2 One capability registry covering every mutating entry point

Extend the existing closed catalogues (`MODULE_AGENT_ACTIONS`, `NATIVE_OUTCOME_ACTIONS`, the handoff routes)
into one registry rather than adding a fourth list. Each entry declares:

- id, module, owning service function and the screen that performs the same effect;
- input schema (typed IDs, enums, dates via the HR date owner), and which inputs a person must supply rather
  than the model (remarks, reasons, attachments, free-text declarations);
- permission mirror (offer only), subjects, blast-radius cap and idempotency key derivation;
- **tier ceiling** (§4.4) and reversibility;
- outcome semantics (what completion does and does not prove);
- evaluation cases, including adversarial ones (§4.6d).

Every mutating server action, route handler and service entry point is **classified** in a closed inventory:
`registered`, `handoff` (link to the screen, with reason), `human_only` (with reason, e.g. erasure, access
administration) or `not_user_facing`. A CI drift guard fails when a new mutating entry point is unclassified,
in the same way ADR-0116's caller inventory fails on an unregistered model caller.

### 4.3 From conversation to confirmed effect

1. The model **proposes** an entry and argument values from the conversation. It never names the actor,
   chooses a service, or supplies IDs the caller could not already read.
2. After the model turn ends, deterministic code validates the proposal, resolves references with fresh reads,
   and calls the entry's `prepare` in its own transaction. Ambiguity (two employments, two matching leave
   types, missing required human input) returns a question, never a guess.
3. The chat renders an **inline review card** from the canonical prepared content (not model prose) with the
   engine's own preview (e.g. deducted days).
4. The person confirms on the card. Confirmation is a separate same-origin human command that binds the
   reviewed digest — the existing browser command path — never a tool call. Approve-tier entries instead
   route to the existing approver's inbox.
5. The owning service commits the effect and its domain event; the prepared action records the receipt.
   A timeout after commit is reported as uncertain and is reconciled by reading the receipt, never retried
   blindly.

Model text inside HR records (a claim description, a remark) is data. It cannot add an entry, widen scope,
change a tier or skip confirmation, because steps 2–5 never take instructions from the model.

**Storage.** Keep `app.assistant_own_leave_review` as the single prepared-action owner (ADR-0131: no second
ledger). It currently grows one CHECK value and receipt column(s) per action. Recommended: for new entries add
one generic receipt shape (`receipt_event_id`, `subject_kind`, `subject_id`) and stop adding per-action columns;
existing columns and applied bytes stay. Option rejected: a new `agent_action` table, which would split
lifecycle ownership. A rename is cosmetic and deferred.

### 4.4 Tiers (inherits ADR-0131 §2; this record adds the per-category ceilings)

| Tier | Meaning | Ceiling applies to |
| --- | --- | --- |
| Automatic | Executes within caps and switches, no click | Reads; reminders and missing-information requests; chasing overdue approvers along existing escalation routes; steps whose completion the engine itself verifies |
| Confirm | The person sees the exact effect and confirms | Anything a person does for themselves; preparing a case or draft for their own work |
| Approve | Agent prepares; the existing approver decides | Anything already routed through an approval chain; personnel changes; payroll preparation |
| Handoff | Link to the screen only | Erasure, payroll unlock/rollback, role/access administration, provider/credential settings, terminations |

Pay, claim money, approvals, terminations, ratings, hiring, promotion, discipline, payroll and access are never
Automatic and never self-approved. A model or a measurement may **lower** a tier for one request, never raise
it; raising a ceiling is a reviewed code change (§4.6e).

### 4.5 Named agent principal for unattended work

Replace the anonymous `hr_admin` context in `scripts/review-sweep.ts` with one agent principal per tenant
(ADR-0131 §3): not a login, cannot sign in, restricted to Automatic-tier entries, every effect stamped
`actor_type='agent'`, the principal and the administrator who enabled it. New scheduled agents (overdue approver
chasing, probation/contract-end reminders, missing clock-in nudges, expiring documents, lifecycle step chasing,
payroll cut-off readiness) run only under this principal and only after it exists.

### 4.6 Learning from the system

"Learning" here means the agent's **capabilities, knowledge and behaviour** follow the product as it changes,
through reviewed, measurable channels. It never means the model rewriting its own permissions, prompts or
tiers, or absorbing tenant HR data.

**a. New features become agent capabilities through the registry, in the same change.** A feature PR that adds
a mutating entry point must classify it (§4.2). If registered, the entry ships with its schema, permission
mirror, tier ceiling, outcome semantics and evaluation cases, and the chat's tool catalogue is **derived from
the registry at runtime**, filtered per caller. There is no separate prompt or tool list to update by hand.
The drift guard makes "the agent did not learn the new screen" a CI failure, not a silent gap.

**b. Product knowledge comes from versioned system sources, read with the caller's authority.** For "how do
I…", "why was…" and "what does this field mean" the agent reads: registry descriptions; the personnel field
registry; published Knowledge Base articles visible to the caller; `GLOSSARY.md`-derived terms; and policy
configuration through owning services (leave entitlement explain, payroll configuration). When those sources
change, answers change; nothing is retrained. Private records of other people are never knowledge sources.

**c. Outcome measurement per entry, from existing owners.** Offered, prepared, edited before confirmation,
confirmed, discarded, refused, failed, expired and later reversed — derived from the prepared-action lifecycle,
`domain_event`, `agent_proposal` dispositions and native outcome associations. Aggregates only, scoped by
existing RLS, shown beside the ADR-0131 process assessment in the Control Tower so each process has a
before/after. No names, amounts or reasons leave their owners.

**d. Behaviour changes only through the existing promotion harness.** Prompt, routing, tool-description and
argument-extraction changes are candidates evaluated on held-out suites (the existing holdout files plus the
new entries' cases) by at least two independent evaluators with zero security and quality failures, promoted by
an approver who is not the author, bounded and expiring, rolled back on regression. Every registry entry
contributes adversarial cases: injected instructions in record text, cross-company and cross-tenant targets,
salary leakage, actions the caller lacks, and ambiguous inputs that must produce a question.

**e. Autonomy follows measured evidence and a person's decision.** Outcome data may **recommend** a change —
for example an entry confirmed unchanged in nearly every case, or one that is frequently discarded and needs a
better preview. Raising a tier ceiling remains a reviewed registry change approved by an administrator and
recorded with its evidence window. Never-Automatic categories in §4.4 are fixed in code and cannot be
recommended upward.

**f. Not learning.** No training or fine-tuning on tenant data; no cross-tenant aggregation; no persisted memory
of one user's data reused for another; no learned grants, scopes or tiers; no prompt or response content in the
usage ledger beyond existing retention (ADR-0116).

### 4.7 Who sees what

| Surface | Employee | Manager | Payroll / performance partner | Company HR | Group HR / super admin |
| --- | --- | --- | --- | --- | --- |
| Chat, launcher, own Confirm actions | with grant | with grant | with grant | with grant | with grant |
| Approve-tier items in their inbox | — | assigned | payroll items they administer | in scope | all |
| Control Tower queues, opportunities, outcome measurements | — | — | payroll exceptions/actions (future) | own companies | all |
| Registry/tier view (read-only) | — | — | — | yes | yes |
| Agent principal enablement, switches, provider, spend, per-user runs | — | — | — | — | yes |

## 5. First implementation wave (after acceptance)

Six entries chosen for reach and low risk, each Confirm or Approve:

1. Edit or cancel own pending leave (Confirm) — `editLeaveRequest` / `cancelOwnLeave` /
   `requestLeaveCancellation` in `core/leave.ts`, reached through `packs/leave/service` (which re-exports
   `core/leave` wholesale). Correction, 28 Oct 2026: an earlier draft said these needed new pack exports;
   they do not.
2. Cancel own claim (Confirm) — `cancelClaim`, `core/claims.ts`.
3. Request overtime (Confirm) — `requestAttendanceCorrection` with the overtime kind, as `myRequestOvertime` does.
4. Decide a claim (Approve: the assigned approver confirms) — `decideClaim`, `core/claims.ts`.
5. Decide an attendance correction (Approve) — `decideAttendanceCorrection`, `core/attendance.ts`.
6. Decide a replacement-leave request (Approve) — `decideReplacementLeaveRequest`, `core/replacement-request.ts`.

"Approve" for items 4–6 means the person who confirms is the existing assigned approver acting on their own
inbox item; the agent prepares and explains, and the service's own approver checks decide.

Plus the inline review card (§4.3) for the existing 19 actions, which removes the separate-page step without
changing their owners. Later waves: HR lifecycle cases and prepared personnel changes, leave administration,
payroll preparation (inputs and checks, never close or unlock as Automatic), then scheduled agents under §4.5.

### 5.1 Amendment, 29 Oct 2026: assigned decisions on the generic receipt shape (wave 1b)

Items 3–6 use migration 0671. Overtime (item 3) is a generic OWN kind whose subject is the caller's own
employment, because the native request row exists only after confirmation. The three decisions (items 4–6)
add a second generic binding mode, **assigned**, modelled on the leave-decision custody:

- The review row keeps the decider's login and nullable person, and the subject's employment, company and
  person. The subject person lives in the existing `decision_subject_person_id` column, so the existing
  privacy-erasure and outcome-capture owners cover it without change.
- Authority is the native service's. The adapter asks it (`assertCanDecide`, the frozen attendance workflow)
  before preparing and the service decides again when it writes. The decider can never decide their own
  request, for any role: the adapter, the SQL binding and the completion verifier each refuse it, although
  `assertCanDecide` itself lets a super admin decide their own item on the screen.
- Completion still proves the native row and event were committed in this transaction, by this login, for
  this subject. An attendance decision binds the pending workflow level (and participant slot) into the
  reviewed digest; it may record one level and leave the request pending.
- One pending review per item per decider, so one approver's open review neither blocks nor reveals itself
  to another approver of the same item. Index and discard are bound to the login's current person.

### 5.2 Amendment, 29 Oct 2026: inline review cards (§4.3), first increment

- The model proposes through a new answer-plan mode, never a tool:
  `{"version":1,"mode":"propose","action":"<id>","hints":{...}}`. It is parsed by the same strict canonical-JSON
  parser and sealed in the same exchange record as every other plan; no table or ledger is added and the chat
  tool loop stays read-only. Nothing is prepared or written during the model turn.
- Proposable now: the seven generic wave 1/1b actions with typed hints only (`leave.cancel` {startDate?},
  `leave.edit` {startDate?, newStartDate, newEndDate}, `claims.cancel` {incurredOn?},
  `attendance.overtime.request` {date, plannedStartTime, plannedEndTime}, and the three assigned decisions with
  no hints). Hints carry no IDs, names or human text, and never a decision. A proposal is accepted only for an
  implemented prepare nomination whose module the caller can currently read; otherwise it fails closed.
- After the turn the card resolves hints against the caller's own fresh `choices` from the guarded module-action
  endpoint: one match is preselected, zero or several ask the person to pick. Human fields start empty;
  preparation, confirmation and lost-response reopening use the existing panels and digest-bound commands.
- Not yet covered: the other implemented actions keep their bespoke protocols and the existing human-review link
  card. Each needs its own typed hint shape and panel prefill before it can be proposed inline.

## 6. Alternatives considered

- **Give the agent its own broad role** (as the nightly sweep does today). Rejected: authority would no longer
  equal the user's, and every effect would need a second authorization model.
- **Let the model call write tools inside the chat loop.** Rejected: a tool call is not human confirmation and
  the loop is concurrent.
- **Discover capabilities by crawling routes or forms at runtime.** Rejected: it cannot know preconditions,
  tiers or outcome semantics, and would treat page text as authority.
- **Fine-tune on tenant usage.** Rejected: privacy, tenant isolation and auditability; outcome measurement plus
  the promotion harness gives the improvement loop without moving HR data into a model.

## 7. Acceptance evidence required per implementation increment

| Outcome | Evidence |
| --- | --- |
| Parity | Per-entry role matrix against the same fixtures as the screen, allow and deny |
| Confirmation integrity | Digest-bound confirmation, stale/changed source refusal, replay and concurrency, uncertain-commit reconciliation |
| Injection and leakage | Adversarial holdouts pass with zero failures; cross-company and cross-tenant targets refused |
| Inventory completeness | Drift guard fails on an unclassified mutating entry point; classification reviewed |
| Learning loop | Outcome aggregates reconcile with source counts; a candidate is refused without independent evaluations and rolled back on regression |
| Experience | Rendered chat card, confirmation and failure states in six locales, desktop and mobile |

Each increment still needs its focused checks, the impact-selected gate on GitHub Actions and staging
acceptance; merged, tested, installed and accepted remain separate states.

## 8. Owner answers and remaining questions

Answered on acceptance (2026-10-28): the §5 first wave as written, and the generic receipt shape (§4.3).

Still open, outside wave 1:
1. Should managers get **bulk** decisions (each item still individually reviewed), or single items only? Wave 1
   ships single items.
2. Which scheduled agents should come first once the agent principal exists?
3. Provider data handling: wave 1 uses the tenant's existing configured provider under the existing Assistant
   grant, allowances and pause; it sends no prepared-action content to any new provider. Any provider change
   remains a separate decision (ADR-0131 amendment of 2026-10-25).

## Amendment, 2026-10-29: first HR-administrator actions (§5 "later waves")

Status: implementation decision under the owner's 2026-10-29 instruction. The actions reuse the wave 1b
"assigned" binding (migration 0671, `createGenericAssignedReviewStore`); they add no parallel custody.
Accepted here is not merged, tested or installed.

### Choice

No installation measures how often these happen yet: staging holds demo data and the process assessment has
no production window. The choice therefore rests on the code paths. Each entry is a single-employee HR
correction that recurs every month for every company, is keyed by hand on a dedicated screen today, and has
a native service that already checks the HR administrator's authority over that employee's company:

1. `leave.adjustment.apply`: add or deduct leave days for one employee and one leave type, with an effective
   date and a reason (`applyLeaveAdjustmentBatch`, individual mode, one employment).
2. `toil.credit.grant`: grant Leave Credit for one date one employee worked
   (`grantLeaveCreditRows`, `hr_manual_grant`). HR enters the date, the hours worked, the reason and the
   First Schedule consent. The engine names the day type from the roster, computes the credit, expiry and
   First Schedule floor, refuses a date already credited, and shows the overtime the credit would stop
   paying.
3. `employees.movement.transfer`: an assignment-only Transfer or Organisation Assignment Change with an
   effective date (`createMovementEventTx`). Department, position, business unit and location only; no grade,
   pay, company or end of employment. A future date is recorded as a pending movement, exactly as on the
   screen.

Not taken:
- Onboarding cases, because the onboarding module is mid-way through its v3.1 replacement and its legacy
  case service is being retired.
- Employment exit, discipline, access, erasure and payroll reversal, which remain permanent handoffs
  (§4.4).

### Binding and authority

- The caller is the HR administrator; the subject is another person's employment. The binding names:
  - the administrator's login and person;
  - the subject's employment, company and person.
- The stored subject is the employment (`receipt_subject_kind='employment'`).
- Refused before anything else: a subject whose person is the caller's own, for every role.
- Authority is the native service's. Preparation runs the same check the screen's write runs:
  - leave adjustment: the employment visible and administered under `can_admin_employment`;
  - Leave Credit: `assertAdminForEmploymentTx`;
  - movement: `assertWorkforceEmploymentTx(...,'maintain')`.

  The service checks again when it writes.
- The model never supplies the days, the reason, the dates worked or the destination. Those are HR's own
  inputs on the review card; the agent only opens the card for an employee HR chose.

### Proof

Completion is accepted only if the native effect was committed in this transaction, by this login, for
this employment. The completion verifier proves, per kind:

- leave adjustment: a batch of this login, a ledger row for this employment and leave type, and the
  `leave.adjustment.applied` event on that batch;
- Leave Credit: an `hr_manual_grant` accrual for this employment and its `toil.accrued` event;
- movement: the movement's own event for this employment, either applied or scheduled.

A prior-transaction event is refused as proof.

Tier ceiling: Approve. These are HR decisions about someone else's record, and HR is the person who
confirms.
