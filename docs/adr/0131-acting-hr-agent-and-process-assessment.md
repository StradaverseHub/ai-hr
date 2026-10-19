# ADR-0131: Acting HR agent, harness and process assessment

Date: 2026-10-19
Status: Accepted direction. Phase 1 (process assessment) implemented in this round; Phases 2–4 are
future increments and are not claimed capabilities.

Extends [ADR-0109](0109-central-hr-orchestrator.md) (central orchestrator), [ADR-0116](0116-central-ai-inventory-and-allowances.md)
(AI allowances) and [ADR-0084](0084-propose-adjudicate-learn.md) (proposal ledger). Must integrate with
ADR-0127 (session-bound assistant conversations and confirmed proposals), which is being built on a
separate branch and is not yet on main.

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
- staff actions per case: actions by a login that is not the employee the case is about;
- employee actions per case, and the share of actions already done by system or agent;
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
- Limits: staff action counts depend on services writing events. A person's work outside the system
  (email, phone, spreadsheets) is invisible. Elapsed time is not effort. Lifecycle staff actions come
  from `lc_history`. This is a baseline, not an efficiency audit.

## Future phases (not claimed)

2. Registry, execution ledger, agent principal and harness v1 with about six actions. The assistant
   proposes actions as confirmation cards, integrated with ADR-0127's confirmed-proposal flow rather
   than a second mechanism.
3. Goal-driven orchestration agent (scheduled or requested from the Control Tower) planning only
   within the registry; deterministic plan validation; durable steps with leases, approval-bound
   resume and a dead-letter list.
4. Before/after measurement per process using the Phase 1 baseline; the assessment then recommends the
   next agent from measured outcomes.

Each phase is a separate round with its own acceptance evidence. New model callers register in the AI
inventory (ADR-0116) and are governed by its allowances.
