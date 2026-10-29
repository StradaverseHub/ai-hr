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

*Implemented 29 Oct 2026 (`core/assistant-outcomes.ts`, migration 0674).* One read-only definer,
`app.assistant_action_outcome_summary`, returns counts per kind and state, plus the all-time first use. A row
counts only for an administrator of its company; a row without a company counts only for a group
administrator. Counts per kind cover prepared, confirmed, discarded, expired (including unswept past-expiry
pending), refused and waiting. "Later undone" is counted only where a canonical row or event proves it: a
submitted leave, claim, attendance correction or profile change later rejected or cancelled, or an edited
leave edited again or withdrawn. It is null for every other kind. Offered, edited before confirmation and
failed have no recording source: digests are cleared at the end of review and a failed confirmation rolls
back. They are shown as unmeasured, not zero. Native outcome associations are own-user consent records and
are not aggregated. Each process's before/after compares staff actions per 30 days, using the ADR-0131
counting rules, over two equal periods either side of the first Assistant use in scope. It is labelled
non-causal. The coverage panel reads `agentCapabilityCoverage()` and `agentBacklogByTier()`.

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

## Amendment, 2026-10-29: the named agent principal (§4.5)

Status: implementation decision for §4.5 under the owner's 2026-10-29 instruction to build the agent account
and the first HR-admin actions. Verified in source at main `82f7c6570`. Accepted here is not merged, tested or
installed.

### Facts that shaped it

| Fact | Where |
| --- | --- |
| The nightly pass's only authority is the session setting `app.grants=[{hr_admin, null}]`; nothing checks it against a login or role row. Every row it reads it reads through the `is_admin*` branches. | `scripts/review-sweep.ts`, `db/client.ts`, migration 0016 |
| No model call is ever admitted for it: provider, spend and claims-source admission all require a current login (`assertAiPrincipalTx`). Readiness reminders always use the fixed templates, and claims triage always reports "no AI provider". | `core/ai-principal.ts`, `core/readiness-nudge.ts`, `core/input-triage.ts` |
| Pending profile corrections are invisible to it (the restrictive `access_profile_review_read` needs a login), so a person who already submitted a correction can still be chased. | migration 0579, `core/readiness-actions.ts` |
| Its events are `actor_type='agent'` with no `actor_id`, and its proposals carry no decider. Process assessment counts `agent` and `system` actions as automated. | `core/hr-orchestrator.ts`, `core/process-assessment.ts` |

### Decision

1. **Identity.** `app.ai_agent_principal` holds one row per tenant (an id and a creation time). It is not an
   `app_user`, has no `role_assignment` and no credentials, so no login path can resolve to it. A session
   context carries it as `agent: { principalId, enablements }`. `withTenant` sets the principal in its own
   transaction-local setting and refuses an agent context that also carries a login or any grant.
2. **Authority.** An agent context holds **no grants**: `is_admin()`, `is_admin_for()` and every login branch
   are false. `app.current_agent_principal()` (SECURITY DEFINER) returns the principal only when that setting
   names this tenant's row, there is no login and there are no grants. Additive policies for that predicate give
   exactly what the two specialists use:
   - `hr_orchestration_case`: read, open and update cases;
   - `employment`: read (company, person, payment method, termination), used to find recipients and leavers;
   - `agent_proposal`: read, record and settle `readiness_fix` proposals only;
   - `domain_event`: read `readiness.nudge-raised` only (for de-duplication).

   Statutory numbers, bank accounts, compensation and pending correction values are **not** readable. Two
   presence-only functions return, per active employment, whether each readiness field is present, and per
   pending correction, the names of the fields it touches. They never return values.
3. **Every effect is attributable.** A restrictive insert policy on `domain_event` binds any agent-context
   event to:
   - `actor_type='agent'`;
   - `actor_id` = the principal;
   - a closed list of orchestrator and nudge event types;
   - a payload `agent` stamp naming the principal and, for each switch it relies on, the administrator and
     the `tenant-setting.changed` event that switched it on.

   A restrictive insert policy on `agent_proposal` limits an agent context to `readiness_fix`.
4. **Enablement reuses the existing switches.** `notifications.readiness_nudge_enabled` and
   `claims.input_triage_enabled` stay the switches. A group administrator changes them in AI management
   (`setAiFeature` → `setTenantSetting`, ADR-0116), and every customer write goes through `setTenantSetting`. The administrator who switched an agent on is the actor of
   the latest `tenant-setting.changed` event for that key, when its value is `true`. A switch that is on without
   such an event (set by the platform or before events existed) is **unattributed**: that agent does not run,
   the nightly log says so, and AI management shows "an administrator must switch this on again". The nightly
   pass runs only when at least one specialist is on and attributed. Pausing is switching off; the principal has
   no switch of its own.
5. **No model calls under the principal (unchanged behaviour, now explicit).** Readiness reminders keep their
   fixed templates, and claims triage under the principal stops before reading claims. Admitting the principal to
   model spend needs its own allowance subject in ADR-0116 admission and the provider data-handling decision in
   §8.3. It is a separate, reviewed change.
6. **Scope.** Only the orchestrator pass (`runHrOrchestrator`) moves to the principal. The deterministic engine
   jobs in the same script remain system jobs with their existing context: review opening and reminders, leave
   escalation, future-dated movements and notification dispatch. They are not agents.

### Consequences

- Correction: the agent now sees which gaps already have a pending correction and stops chasing those people.
  The values in those corrections stay unreadable to it.
- Tenants with no attributed agent no longer get a nightly readiness observation. An HR administrator's refresh
  in the Control Tower still runs it under their own login.
- Event readers that join `actor_id` to `app_user` find no user for agent events, as before (they were `NULL`).
- Rejected alternatives:
  - a real `app_user` for the agent: it could be granted roles, sign-in could resolve it, and it would pass the
    login-only AI admission by construction;
  - keeping `hr_admin` and filtering in code: authority would be unenforced at the database.

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

## Implementation and vocabulary amendment — 29 October 2026

Verified source base: matching main/alpha `b5758c54c`, not the original decision-time `c0dd878b1`.
This amendment corrects implementation claims; the accepted safety decisions remain binding.

- The catalogue declares **23** action IDs, including the `employees.import` Handoff. **22** have prepared
  human-review paths; the three own leave/claim changes are now included. Wave 1b's four additions and
  HR-admin prepared work are separate in-flight changes and are not counted as merged here.
- Inventory spellings are `registered`, `backlog:<tier>`, `handoff:<reason>` and `internal:<reason>`.
  These implement the design's classification intent; `human_only` and `not_user_facing` are design
  vocabulary, not current literal values. A backlog entry is not an executable capability.
- Authorization composition is spread across source adapters and custody services, not centralized in
  `module-action-server.ts`. Fresh in-transaction checks and the owning service remain authoritative.
- Twelve chat tools are hand-listed; the catalogue is not derived from the action registry yet. Chat tool
  reads execute sequentially. Preparation/confirmation stays outside the model loop regardless of order.
- Production evaluation/promotion is in `core/module-agent-releases.ts`. The cited
  `lib/ai/module-agent-improvement.ts` and `core/module-agent-orchestrator.ts` are test-only models, not
  the live execution owner. Current candidate kinds are routing, read-plan prompt, canonical guidance and conversation.
  Tool-description and argument-extraction candidates are not implemented. Routing cannot beat the
  baseline under its present paired criteria. Fixed synthetic holdouts are not redacted production replay.
- Promotions are per author; automatic baseline fallback follows exceptions/source or provider drift,
  not measured outcome regression. Author differs from promoter; promoter/evaluator separation is still
  incomplete. These remain R5/WP11 work. No learning or headcount reduction is established by this PR.
- At this base the sweep uses a legacy no-login context; explicit orchestrator event attribution does not
  establish a named tenant principal. PR #41 is separate in-flight principal work. Scheduled model spend
  remains an owner decision; this documentation grants none.
- The owner approved **Assistant**, **Control Tower**, **HR work queue**, **scheduled agent**, dropping
  “module agent” and “specialist” from user-facing language. Code now names the logical bindings module
  read capabilities. Compatibility exports and historical URLs/DB names remain while concurrent consumers
  migrate; these are not distinct authority owners. The duplicate Administration → AI navigation entry
  is removed; the existing redirect remains available to bookmarks.

The 29 October read-only staging check found the retention timer absent. Installation is release-owner
work under [deployment instructions](../../deploy/DEPLOY.md). See the [AI threat model](../architecture/ai-threat-model.md).
WP2 and WP4 are separate review candidates; their gate and installation status must be read from their
exact PR evidence, not inferred from these amendments. No deployment was performed.

### Release integration update — 29 October 2026

The combined WP2/WP4/WP15 release candidate starts from canonical `46049dead`, which already contains
wave 1b, the named principal, three HR-prepared actions and outcome measurement. There are now **30**
declared action IDs, including the import Handoff, and **29** prepared human-review paths. The runtime
tier categories and generic assigned-review guard cover those merged additions as well. Earlier base
observations above retain their original meaning; they do not describe missing merged functionality.

The orchestrator now uses the named tenant principal with attributed switch enabling. It still receives
no model-spend authority. Outcome measurement is merged; its comparisons remain non-causal. Other
architecture packages, including scheduled-status behavior and generic parity, are not implemented by
this integration. Final gate and staging arrival are separate evidence, recorded on the release PR.

### WP1 scheduled-status contract — 29 October 2026

A configured provider or a specialist switch is not admission for the named principal. Scheduled model
spending remains unapproved. The readiness pass uses fixed templates; claims triage reports
`principal_not_admitted` before reading claims. Missing provider for a signed-in caller is `no_provider`.
The anonymous model steps in anomaly-sweep and feedback-plan are retired; deterministic anomaly checks
and recurrence continue, and the legacy feedback cron command explicitly logs a no-op. Administrator
planning through the existing signed-in service remains available.

Company HR may read only sanitized execution-status metadata of an explicitly marked named scheduled
pass. Its case rows and counts still come from the caller's existing RLS-scoped source query; a tenant
pass is not evidence of that company's outcomes. Manual pass receipts still match exact administrative
scope. This adds no execution ledger or database authority. See the [WP1 verification contract](../reviews/ai-architecture-wp1-verification-2026-10.md);
this amendment alone proves no gate result or installation.

### WP7 one action registry (§4.2) — 30 October 2026

`lib/ai/agent-action-registry.ts` is the one registry §4.2 asked for. Each `defineAgentAction` entry
declares the §4.2 fields plus its custody store family, browser dispatch owner and AI pause key; its tier
ceiling reuses the WP2 policy type, so a never-Automatic category paired with Automatic does not compile.
The effect-id union, module declarations, nomination parser, tier-ceiling and category maps, native-outcome
list, handoff routes, completed-outcome readers and browser dispatch owners are derived from it.

Migration 0693 adds `app.assistant_action_kind` (read-only to the application role) with one row per entry.
The prepared-review store and the native-outcome association reference it through validated foreign keys,
and the closed `action_kind`/`action` CHECK lists are dropped. Adding an action is one registry entry plus
one `INSERT` row in a new migration; its owning service, store adapter and per-kind SQL column rule and
verifier remain the action's own behaviour (WP9 collapses the stores). A parity test holds registry = seeded
rows = capability inventory = tier-ceiling map. This amendment proves no gate result or installation.

### WP13 first Automatic-tier entries (§4.4–4.5, R18) — 30 October 2026

Owner decisions of 29 October 2026 set the order (approval chasers, then probation and contract-end reminders,
then missing clock-in, expiring documents and lifecycle steps) and give the agent principal no model spend.
Four registry entries now carry tier `automatic`: `approvals.claim.chase`, `approvals.attendance.chase` and
`approvals.toil.chase` (category `chaser`, specialist `approval_chasers`) and `employees.review_overdue.remind`
(category `reminder`, specialist `review_chasers`). Each declares an `automatic` block (overdue threshold in
working days on the requester's roster minus holidays, the leave escalation's clock; registry defaults,
per-company values a follow-up; cooldown per item and stage, lifetime cap per item and stage, cap per run) that
`core/automatic-chasers.ts` enforces. They have no review store row, are never nominated, prepared or
confirmed by a model, and stay out of the chat module contract, so existing specialist digests do not change.

The tenant's agent principal runs them nightly in `scripts/review-sweep.ts`, each only behind its own AI
management switch (`notifications.approval_chasers_enabled`, `notifications.review_chasers_enabled`, default
off) attributed to the administrator who switched it on, re-checked in every effect transaction. A run appends
one stamped `automatic-chase.*` event per item; nothing is approved, rejected, submitted or changed. The
notification registry re-checks that the item still waits at the chased stage and tells its current approver
(claims and replacement leave: the administrative manager on a current, non-superseded line, else company HR;
participant-routed attendance: only the participants the workflow's outstanding rule says can act now, so one in
a sequential level; reviews: the manager at the manager stage, else company HR). The delegated-approvals
package adds active matching stand-ins for claims, replacement leave and delegate-capable attendance routes;
frozen v3/v4 participants remain exact. The leave escalation is unchanged. Reminders before a review's end date stay the existing engine job.

The two switches are template-only AI management agents: they never enter model admission, and the AI control
context is unchanged. Migration 0697 adds the reference rows, the principal's read and stamp policies for the new
event types, two id-and-date-only source definers, an outstanding-participant reader for attendance and an
administrator-scoped outcome summary shown beside Assistant outcomes. Missing clock-in nudges, expiring documents and lifecycle step
chasing are not yet built. The effective pause for these entries is their specialist switch (and
`SETTING_KILL`); their `pauseKey` stays `hr_assistant` until WP12 widens it. This amendment proves no gate
result or installation.


### WP9 store 1 — claim cancellation custody, 30 October 2026

`claims.cancel` now uses `createGenericOwnReviewStore` through the same public transport functions. Its
0670 SQL kind, nonce commitment, sealed-body identity/purpose strings, metadata, reviewed digest, receipt
and event verifier are unchanged. Existing in-flight rows remain readable; no migration or 0698 allocation
is needed for this store. Compatibility tests construct the pre-refactor sealed-row format directly and
reopen/complete/retire it through the generic family. A lost-reply fixture commits the native cancellation
before the simulated transport failure, then reconciles it without repeating the effect.

`withAgentActionGuard` composes current principal, Assistant grant, registered module, human review phase,
tier and pause as additional prerequisites. The own-claim source and native cancellation service still own
subject authority and effect rules. Other stores have not been migrated by this increment. The shared
own-leave actor now calls `isAiPrincipalCurrentTx` for the existing principal/carrier check. No model writes
or Automatic approval authority is added. Focused CI, combined-candidate acceptance and release gates
remain separate evidence.

### WP9 store 2 amendment — retained TOIL own-request custody (30 October 2026)

The employee replacement-leave request now uses the generic own review owner with a typed compatibility repository for its installed SQL protocol. The repository translates projection names only: existing sealed bodies, binding order, encryption purposes, commitments, request/event columns and native SQL verifiers stay unchanged. Completion still runs the canonical native request service in the same top-level transaction; no credit or cash is granted by submission. Source authority composes the current registry guard and retains its own-employment and leave dependency interval. Retained old-writer rows and uncertain committed replies require real database evidence, and the action joins the screen/Assistant role matrix. No migration is required.

### WP9 — login-bound publication compatibility (30 October 2026)

Knowledge article publication uses the generic own compatibility lifecycle. Its binding remains the real author login/current person with null employment and company; source author and audience checks remain canonical. The generic owner controls the same ten-minute metadata, sealed body, private commitment, digest-bound confirmation, atomic native effect/completion and completed-only reconciliation. Installed SQL functions and row/ciphertext formats are retained through typed adapters, including existing creation provenance fences. Login-only privacy retirement remains separate from source authority. No migration or row rewrite is required.

### WP9 — pay catalogue creation compatibility (30 October 2026)

Typed pay-component catalogue creation uses the generic own compatibility lifecycle, bound to the actual current login with null employment/company. The source retains current payroll and typed-pay-component module gates, canonical catalogue locking and native administrator authority. Human content, installed SQL/ciphertext formats, 32KiB sealed-body limit, 64KiB outward-review cap, atomic created-event proof and historical-create reconciliation remain unchanged. No employee assignment, payroll run or model-calculated value is introduced; no migration is required.

### WP9 — additional payroll draft compatibility (30 October 2026)

Multi-cycle draft creation uses the generic own compatibility lifecycle with its exact installed company/month/cycle/run-type binding, 45KB sealed-body cap and source-owned erasure targets. Its explicit peek protocol keeps current actor and canonical source interval before encrypted nomination, full native preflight before custody NOWAIT, and an exact snapshot reread before execution. Completed rows reconcile without preparing or creating another run. Sensitive Approve-tier authority stays explicit; no payroll processing, closing, payslip or payment is performed. No migration or ciphertext rewrite is required.

### WP9 — statutory profile compatibility (30 October 2026)

The Personnel EPF/SOCSO review uses the generic assigned compatibility lifecycle, retaining the actual actor/target/person/statutory/company/country binding and installed encrypted row format. Workforce write admission, granular native field/company authority, native PERSON/statutory tuple ownership, pending preflight before custody NOWAIT, exact snapshot reread and complete erasure targets remain source-owned. The country pack remains the sole statutory writer; no Identity/Tax/Bank/TP3/Zakat or payroll calculation authority is added. Existing uppercase action-ID reopening remains supported through a protocol-local normalization option. No migration is required.

### WP9 — equipment acknowledgement compatibility (30 October 2026)

Lifecycle acknowledgement uses the generic own compatibility lifecycle with an explicit exact-wire body protocol. The old caseNumber field stays in the private commitment and ciphertext in its original position; it is not dropped or re-created as public metadata. The current login/person, native case person, employment and company remain distinct and nullable as before, including email-owned unlinked prehire cases. Native case readiness, equipment normalization, actual submission SQL and completed historical receipt remain canonical. Complete case/person/employment privacy targets and login-only retirement remain intact. No migration is required.

### WP9 — reporting graph compatibility (30 October 2026)

Reporting-line change custody uses the generic assigned compatibility lifecycle with its exact original metadata, cached-review body, manager/previous-manager person snapshots and org-specific AAD/key purposes. The protocol does not add a contractVersion field to installed metadata or substitute the module-action commitment. Native Workforce graph/field/company authority, prior/new manager views, original target capture and canonical set-event proof remain unchanged. Current source preparation revalidates every cached graph fact before pending disclosure. Completed retries reconcile instead of executing; no migration or ciphertext rewrite is required.

### WP9 — attendance request compatibility (30 October 2026)

Own attendance correction custody uses the generic own compatibility lifecycle with an exact legacy intent-wire codec. Its private commitment/encryption still serialize `intent`, never a renamed content field. Existing own-employee/configuration/credit ownership, bounded canonical policy/day/payroll preparation before custody NOWAIT, exact encrypted snapshot reread and native correction/request binding remain unchanged. Completed retries lock and reconcile only the existing correction without pending preparation. The public action/version/intent packet and digest-bound confirmation are unchanged; native clock and other-HR rules still adjudicate every request. No migration is required.

### WP9 assigned Leave decision custody

The Leave decision adapter uses generic ASSIGNED compatibility custody. Its original sealed content, actor/subject binding, pending versus recorded source nomination, native step/event provenance, privacy targets and installed SQL remain authoritative. The shared guard requests Approve explicitly; the model cannot decide. No migration or ciphertext rewrite is needed.

### WP9 Payroll close custody

Payroll close uses generic OWN compatibility custody while the payroll pack retains Access/period/OT/batch locks, preflight-before-custody ordering, completion provenance, configured payslip release semantics and exact post-close privacy targets. Original SQL and sealed wire stay unchanged; explicit human Approve is required.

### WP9 Rewards post custody

Rewards post uses generic ASSIGNED compatibility custody with its original actor/company/unit binding, sealed content, posted revision/batch/event proof and full native preflight before custody NOWAIT. Rewards retains funding, cohort, compensation and payroll authority; shared guard requires human Approve. Existing SQL and ciphertext are unchanged.

### WP9 default family foundation

The default 0670 OWN and 0671 ASSIGNED factories are protocol adapters to the shared custody engine, rather than separate sealing/lifecycle implementations. Their public APIs, strict binding/row validation, self-decision refusal, SQL verifiers and optional OwnReviewPersistence/nativeRequestId compatibility are retained. The seven legacy module variants and own-leave remain separate pending their explicit protocol adapters; this foundation does not claim those have already collapsed.

### WP9 notification preferences custody

Notification preferences use generic OWN compatibility custody with the exact nonce/intent/cached-review wire and original capability supplied by the authenticated server owner. Current principal, module, own subject and configuration locks precede saved-card disclosure; native confirmation revalidates the original source digest. Cached reopen semantics and provider-free retirement remain unchanged.

### WP9 profile request custody

Profile change requests use generic OWN compatibility custody, retaining the original content wire, Workforce/own-employee interval, native request/event proof and source-drift refusal. The effect remains submission for HR review; it never applies or approves the proposal automatically.

### WP9 claim draft custody

Claim draft saving uses generic OWN compatibility custody while retaining the exact sealed provisional amount/quantity/taxable fields, original human content and native source fingerprint. Canonical Claims remains the sole money/rule owner; confirmation only saves a draft, never submits or reimburses. Existing rows and native provenance remain unchanged.

### WP9 closed Performance acknowledgement custody

Standard-cycle and OneHR plan acknowledgements share one closed OWN custody adapter, retaining the original discriminated engine/intent/cached-review wire, original private digest, employee binding and native acknowledgement event proof. Reopen compares the exact original canonical review including its original nonce. This does not edit ratings, goals, career facts or promotion decisions.

### WP9 USER-scoped testing observation custody

Testing observations use generic OWN compatibility custody while retaining nullable PERSON/EMPLOYMENT/company identity, exact original intent/cached-review wire, 600000-byte body and 819200-byte cipher limits, real assignment interval and native run/event proof. No staff identity is fabricated; a recorded observation is never relabeled independent verification.
