# ADR-0169 — Assistant repivot: context layer, agent harness and minimum-necessary disclosure

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- **Status:** Proposed. Before any implementation changes what leaves the system, it needs an owner decision on §5 and a privacy/legal review. The number is provisional: reconcile it at merge (open PR126 holds 0167).
- **Date:** 2026-11-01
- **Deciders:** Owner. The Orchestrator owns sequencing against the release queue.
- **Amends:** [ADR-0082](0082-ai-assistant-access-scoped-tool-calling.md). It restores access-scoped tool calling, now with a context layer. For Assistant conversation, it replaces the closed intent/reference protocol: defined in `cbf0fbc45`, then bound to chat and planning in `b131fedb3` and `6db32d4e8` (all 30 October 2026).
- **Keeps:** [ADR-0084](0084-propose-adjudicate-learn.md) (models propose, deterministic services adjudicate), [ADR-0151](0151-orchestrator-action-layer-and-system-learning.md) (prepared human-confirmed actions), [ADR-0116](0116-central-ai-inventory-and-allowances.md) (allowances).
- **Evidence:** [phase-1 review](../reviews/assistant-conversational-phase1-2026-10.md), the corpus and probes in `test/assistant-production-baseline*.ts` and `test/assistant-model-ceiling.eval.test.ts`, and the raw run JSON kept in the builder evidence folder.

## 1. Context

**History.** ADR-0082 designed the Assistant as a tool-calling loop: the model saw the question, called caller-scoped reads and composed the answer. The [AI threat model](../architecture/ai-threat-model.md) (last changed 29 October, now stale against current code) still says conversation "deliberately sends the caller-authorized transcript/tool payload".

On 30 October, to meet the owner's masking requirement, the closed protocol replaced that design:
1. A local fixed-phrase grammar picks the task.
2. One predefined own-subject read runs.
3. The provider receives only numbered references, with no question, no values and `tools:[]`.
4. Templates render the reply.

No ADR recorded the trade-off. This record makes it explicit.

**Measurements** (fictional data through the real route; review §2 and §9–§11):

| 58-turn corpus | Today: closed protocol, oracle selector | Real model sees question + tools (run 41216417843) | + product context (run 41220205814) |
| --- | --- | --- | --- |
| Turns understood¹ | 11 | 38 | 35 |
| Generic "which area?" when the task was already stated | 35 | 0 | 0 |
| **Hard gate: negative turns read no private source** | **pass** | **2 breaches** (`neg-named` read reporting line, `neg-file` read module summary) | **1 breach** (`neg-file`; its reply also invited the person to paste payroll details) |
| Setup-guidance turns that called a product-context tool² | 0 of 12 | 0 of 12 (no such tool offered) | 10 of 12 |
| Literal links to pages that do not exist³ | n/a | 0 (post-hoc manual check) | 0 (automated check against 466 real pages) |
| Blank replies | 0 | 1 | 2 |

1. The oracle's modes come from deterministic code. The real model's modes are **self-reported**: guide, social, honest-gap, refuse and clarify turns are credited from the model's own final mode. About 12 of the 38 understood turns rest on that alone.
2. "Called a tool" shows the reply could be grounded, not that it was. Grounding was judged by reading replies (review §11).
3. Only literal `/path` strings are checked. Page names in prose are not.

Both real-model runs used `openai/gpt-6-luna` via OpenRouter, with an Azure upstream, data collection denied and zero retention. Each is a single run on a corpus the same team wrote, with no held-out turns and no human rubric yet.

**What this supports.** On this corpus, the closed protocol's ceiling is 11 of 58 even with a perfect selector. A single real-model run reached 35–38 of 58, and with product context it answered "Is our payroll ready?" from the native readiness owner (0 of 3 employees ready, 2 blockers, missing fields named). This **motivates** a repivot. It does **not** prove the proposed design meets the goal, and the probe did **not** meet the existing negative-turn hard gate.

**External reference pattern.** The pages from Attio and Legora and IBM's AI-in-HR overview are vendor material; their claims are not verified. All three describe the same layers:
- a shared context layer;
- an agent harness (tool routing, control flow, memory, guardrails);
- a capability interface that carries the system's rules and validations instead of the UI;
- permissions, audit and governance.

None of them describes giving the model the codebase; they describe curated, permissioned descriptions of the business and the system.

## 2. Decision (proposed)

Rebuild the Assistant AI core as five layers. Keep the safety owners listed in §3. Replace the closed grammar and numbered-reference call as the primary conversation path. §3 also lists the egress gates this deliberately retires and what replaces them.

### 2.1 Context layer: a system self-description, never the codebase

The model never reads source code. It receives curated descriptions, generated from source-owned registries and permission-filtered at run time:

| Context | Source owner (exists / to build) |
| --- | --- |
| Capability registry: each tool's purpose, inputs, who may use it, and whether it reads, prepares or changes anything | `lib/ai/agent-action-registry.ts` exists for actions. The twelve read tools in `core/assistant-tools.ts` need the same metadata. |
| Navigation registry: real destinations and labels by role | **To build.** Destinations are embedded in `components/sidebar.tsx`. The probe parsed them with a regex, which is not a production design. |
| Product knowledge | `content/guides` (45 guides by audience) and `GLOSSARY.md`. Tenant KB documents need their own disclosure rule. |
| Live setup state | `core/payroll-readiness.ts` and `core/record-readiness.ts` exist. Leave, attendance and onboarding readiness: **to build**. |
| Caller profile | Role, company scope and readable modules. Never a capability grant. |

### 2.2 Capability layer: native owners as typed tools

Today's Assistant has 12 read tools (ADR-0082 amendment of 29 October) and 7 proposable actions (`lib/ai/assistant-action-proposal-hints.ts`). Every tool wraps a native owner under the caller's own transaction and row-level security.

- **Missing reads to add** (from the evidence): setup readiness, the person's approval queue, and governed workforce metrics.
- **Metrics:** a semantic layer of named measures and dimensions with small-group suppression, **not** free-form SQL over HR tables.
- **Changes:** remain ADR-0151 prepared reviews. A deterministic validator rejects proposals with missing required fields, and the model may not call anything "prepared" until the native review exists (the probe did both).

### 2.3 Agent harness

A bounded planner/tool loop:
- **Budgets and authorisation:** per-step authorisation; step, token, time and spend budgets.
- **Loop control:** a repeat-call guard and no empty replies.
- **Refusals:** explicit refusal handling. A refusal or named-other turn makes **no private read**, enforced by the harness, not left to the model.
- **Untrusted content:** tool output, employee text and KB text are fenced as untrusted. The probe passed raw tool JSON without fencing, so its evidence says nothing about injection resistance.
- **Money and rules:** computed only by native owners.
- **Exact values (to build):** restored locally from tool evidence rather than taken from model text. In both runs the model's own text carried the figures.

### 2.4 Task memory

An authenticated task state alongside existing transcript custody: goal, selectors, period, pending detail, completed reads, proposed reviews. It is re-authorised every turn and is never HR truth. It removes the clarification trap, where one pending question captured the next ten turns.

### 2.5 Disclosure model (the owner decision, §5)

What may reach the external model is set per tool and per field by a reviewed disclosure contract. The contract is bound to its exact source, enforced by egress gates, and needs fresh approval when it changes.

## 3. Invariants kept, and gates deliberately retired

**Kept:**
- Tenant and company isolation.
- USER, PERSON, EMPLOYEE and EMPLOYMENT stay distinct.
- Permissions are evaluated in the database, never by the model.
- No automatic sensitive effect; human confirmation through the owning service.
- Native money and rule calculation.
- No training on tenant data.
- An audit record of every tool call.
- Retention and erasure owners.
- Hard security gates are never averaged into quality scores.

**Retired for conversation under option 2:** the "no question text to the provider" and "no tools offered" (`tools:[]`) egress gates. They are replaced by:
- a per-tool, per-field disclosure contract;
- an identifier denylist test (IC, passport, bank and tax numbers never leave);
- the negative-turn no-private-read gate enforced in the harness;
- a per-tenant opt-in switch.

The existing adversarial and conversation holdout suites (`lib/ai/assistant-adversarial-holdouts.ts`, `lib/ai/assistant-conversation-holdouts.ts`) remain release gates.

## 4. Consequences and risks

- **Retired as primary path:** the closed grammar and numbered-reference adjudication. They may remain as a fallback when a tenant opts out or the provider is unavailable.
- **New owners:** navigation registry, tool metadata, readiness reads, governed metrics, harness, task state, disclosure contracts. The threat model must be updated.
- **Not yet met:** the real-model design breached the negative-turn gate and produced blank replies and an overclaimed action proposal. These must pass before any pilot.
- **Cost and latency:**
  - Cost, OpenRouter-reported, one model, no cache or retry overhead: about $0.0003 per turn ($0.0144 and $0.0204 per 58-turn run).
  - Latency from the run logs: 336 s and 422 s per 58-turn run, about 6–7 s per turn including tools and fixtures.
  - Cost and latency at real traffic are unknown.
- **Risks:**
  - **Disclosure:** personal data goes to a processor. The routing is through an intermediary (OpenRouter), not a direct processor contract. PDPA cross-border rules apply.
  - **Data minimisation:** the payslip and pay-change tools would expose pay data to the model.
  - **Prompt injection** through records and tool output.
  - **Retention:** question text stays in transcripts.
  - **Model nondeterminism and version drift:** single-run results will vary.
  - **Over-trust:** people may trust fluent replies too much.
  - **Registry drift:** registries fall behind as features change. Mitigate with build-time generation and tests that fail when a page or tool lacks metadata.

## 5. Decision required from the owner

Choose the disclosure model:

1. **Keep closed references (status quo).** No new disclosure. The measured ceiling is about 11 of 58 turns understood.
2. **Minimum-necessary disclosure to a contracted processor (recommended).** Only the question and the fields each tool's contract admits reach the model. Identifiers never do. Conditions:
   - a data processing agreement with zero retention and no training;
   - decide whether to contract the upstream processor directly rather than through an intermediary;
   - a fixed region and upstream;
   - a PDPA cross-border transfer assessment and an updated data register (threat-model R21/WP12);
   - a per-tenant opt-in switch;
   - specialist privacy and legal review before any real HR data flows.
3. **In-boundary model only.** No external disclosure. It requires hosting a model, and its understanding is weaker and unmeasured.

Option 2 can be combined with option 3 for the most sensitive domains, such as pay amounts and medical leave reasons.

## 6. Sequencing and acceptance

This work queues behind the current release order; recheck the order with the Orchestrator. As of 1 November: PR167 merged on 31 October; the V9 audit status is held by its own chat; PR126 and PR116 are open; PR166 follows.

- **A — Decide.** §5, plus approval of this record.
- **B — Context and capability layers.** No egress change. Measured with the existing oracle and probe on fictional data.
- **C — Harness and task memory** behind a tenant switch. Tested with fictional data on hosted CI, then on staging under the shared queue.
- **D — Pilot** with one tenant's consent, after legal sign-off.

**Acceptance**, on the corpus plus independent held-out turns written by someone other than the implementer:
- The hard gates of review §2, asserted per turn, including the negative-turn no-private-read gate.
- The existing adversarial and conversation holdouts.
- At least 90% understood and at least 80% complete on supported turns, scored deterministically where possible. Self-reported modes do not count alone.
- At most 5% generic chooser.
- Zero links to pages that do not exist.
- Zero blank replies.
- Zero proposals described as prepared before the native review exists.
- Human rubric review.

Focused passes are development evidence; release follows CI policy.

## 7. Unknowns

- The production model and its cost at real traffic.
- The provider's contractual data handling (code cannot prove it).
- Tenant acceptance of option 2.
- Reply quality on real data.
- Run-to-run variance.

Nothing in this record authorises a disclosure change, deployment or production contact.
