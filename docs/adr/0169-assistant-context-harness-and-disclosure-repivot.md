# ADR-0169 — Assistant repivot: context layer, agent harness and minimum-necessary disclosure

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- **Status:** Direction accepted by the owner on 2026-11-01 ("Option 2, with review"), **conditional on privacy/legal review** (§5.1). No real HR data may reach a provider under this design until that review passes. The number is provisional: reconcile it at merge (open PR126 holds 0167).
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

### 5.1 Owner decision (1 November 2026)

The owner chose **option 2, with review** ("Option 2, with review"). This settles the direction; it does not authorise disclosure. Until the review passes:
- No real HR data, real questions or tenant records go to a provider under this design. Work uses fictional data only, as in the phase-1 probes.
- Today's closed reference protocol stays in production unchanged.
- Phase B (context and capability layers, no egress change) and the phase-C harness may be built and measured on fictional data. They ship behind a switch that stays off.

**The review must produce, before any pilot:**
- the per-tool, per-field disclosure contract;
- the identifier denylist;
- a processor decision: direct upstream contract versus the OpenRouter intermediary;
- a data processing agreement confirming zero retention and no training;
- a PDPA cross-border transfer assessment;
- an updated data register (threat-model R21/WP12);
- an updated threat model.

**Still open:** who performs the privacy/legal review. Its approval binds to the exact source, as existing provider approvals do; a later change needs fresh approval.

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

## 8. Addendum (3 November 2026): pay averages

**Owner decision:** "Yes, averages only" (AI Centre round, issue 13b). This is §2.2's first governed metric: a named measure with small-group suppression, never free-form queries. It adds no disclosure class and does not by itself authorise real data reaching a provider: §5.1 still gates that.

**What is computed, and by whom.** The payroll pack's owner (`packs/payroll/pay-averages.ts` `payAverages`, through `packs/payroll/service`) computes every figure. The model only words them. It reports:
- headcount, average and median of **one** measure, `basic_pay_paid`: the Basic figure each payslip of the company's latest closed regular run prints (the payslip and Payroll Register figure). This is prorated for joiners and leavers, and is rate × days or hours for daily and hourly pay. It is taken before unpaid leave and every other deduction, and it excludes allowances, overtime, bonus and claims;
- by company, and optionally by the person's current department;
- with averages rounded half up to the cent and medians to the nearest 10 currency units, so an odd group's median is never one person's exact pay.

**Who may ask.** Only a caller with payroll access: an HR administrator or a payroll partner (`canManagePayroll`). The harness offers the read only to them. Each company is then admitted by the database's own payroll scope (`app.can_admin_payroll_for`, the payslip RLS owner), for a current principal, with the payroll module enabled. The read runs as the caller under RLS. Everyone else is refused in one sentence, and a company filter outside the scope gets the same sentence, so the refusal is not an existence oracle.

**Suppression**, decided over the caller's whole scope before any filter selects what is returned:
1. Any group of fewer than 5 people is withheld (people, not payslips; each person counts once per company). So is any group, the all-companies total included, whose members are all paid the same: its average and median would be each member's exact pay.
2. Differencing: a group whose complement within its parent is 1–4 people is withheld. The parent is the company for a department, and all companies combined for a company.
3. Complementary suppression: within a parent, the withheld groups must be none, or at least two groups holding at least 5 people together whose values are not all equal. Otherwise the smallest published group is withheld too, so no single withheld cell, and no set of withheld cells on one shared value, can be recovered as the total minus the rest.
4. A withheld company withholds all its departments.
5. The all-companies total covers the caller's whole scope whatever the filter. It is published only when the companies share one currency.

A withheld group carries a reason and no headcount or figure.

**What reaches the provider.** The `pay_aggregates` tool result is declared as entity `pay_aggregate` (`core/semantic-model/entities-metrics.ts`):
- every headcount, average and median is `bands`: a placeholder plus its band, restored locally for the person;
- company and department names are `minimum`, kept for this administrator audience;
- no person, id, name or single person's figure is in the result;
- the trace records counts, paths and digests only.

**Residual risks** (not addressed here):
- a group where most members share one value still shows that value through its median when it is a multiple of 10;
- results compared across months, or between callers with different scopes, can be differenced;
- the department is the current assignment, not the one at the run date.

## 9. Addendum (3 November 2026): stored AI Centre chats, retention and erasure

**Owner decisions.** "Store on server now", then "But with active removal in a few days or months, which are configurable" (AI Centre round, issue 8). The floating panel and Ask share one stored conversation (issue 18 item 1). Production is held; staging uses fictional data only. This addendum records how; it authorises no disclosure change or deployment.

**What is stored.** One `teras_chat` row per Noveri conversation of one login (migration 0952, `core/teras-chats.ts`), keyed by the conversation id that `core/teras-wiring/history.ts` issues, and one `teras_chat_turn` row per answered turn:
- the person's words, the reply they were shown and the turn's model-side rows (the only history a later turn accepts), each AES-256-GCM encrypted with the existing helper (`lib/ai/crypto.ts`). The additional data binds tenant, login, chat, sequence and field, so a ciphertext copied to another tenant, login, chat, turn or column fails;
- for a turn the pre-read gate routed or refused (a sensitive topic, a crisis, a workplace-harms request): **no words at all**, only `withheld=true`;
- nothing without the encryption secret; never plaintext. The chat row itself holds no words: owner, person, starting company and scope digest, turn count and times.

The chat command (`app/assistant/launcher-actions.ts`) stores a turn after its reply has rendered; a storage failure never changes the reply. The panel's "Open in AI Centre" opens `/assistant?chat=<id>`. Ask reopens the chat and, while the tenant's Noveri conversation switch admits the caller, turns the stored model-side rows into a fresh signed continuation, so the next question continues the same chat. The browser's continuation is no longer the only copy of a conversation; its two-hour expiry still bounds an unopened browser session.

**Who can read.** Only the login, by **forced** row-level security on all three new tables, so the physical table owner is bound too. There is no group administrator, HR, manager, agent or other-login policy, and the application role holds only `SELECT, INSERT, DELETE` and `UPDATE (turn_count)` on chats, `SELECT, INSERT` on turns and `SELECT, INSERT, UPDATE` on the setting. Listing and reopening also re-authorise the caller (current AI principal, Assistant module and grant, from fresh entitlements) and require the scope the chat started under: the same digest as saved closed-grammar chats (tenant, login, person, roles, grants, company scope). A chat from another scope or role is neither listed nor reopened; the person starts a new chat.

**Retention.** A per-tenant "Keep chats for" setting (`teras_chat_retention`): 1, 7, 30, 90, 180 or 365 days, default 30. Only a current group administrator changes it, through `setChatRetention`; the database refuses anyone else and any other value, and every change is audited (`teras-chat-retention.changed`: actor, time, from, to, version). `expires_at` is stamped by the database at every turn as the last message time plus the setting. A shorter setting brings every stored expiry of the tenant forward at once; a longer one applies from each chat's next message, so an expired chat is never revived. The existing retention runner (`scripts/ai-retention-runner.ts`, `core/teras-chat-expiry.ts`) hard-deletes expired chats each pass, in the physical owner's own transaction, and reports them in its backlog signal.

**Why retention cannot read words, without weakening RLS.** An earlier design proposed ENABLE-only row security because the retention runner is not BYPASSRLS; that was refused. The chosen route is the existing owner-session pattern (migration 0650), narrowed:
- the owner's own session (`current_user = session_user`, not the application role) has policies on `teras_chat` that admit only rows with `expires_at <= now()`, and that table carries no words;
- the owner has **no** policy on `teras_chat_turn`. Turns leave by the foreign-key cascade, which Postgres runs as the table owner with forced row security suspended; so the retention session can delete them with their chat but can never select one, live or expired;
- the chat's task memory goes by a delete trigger.

A dedicated DELETE-only role was considered and not chosen: a role is cluster-wide, would need provisioning outside migrations on every installation, and a DELETE with a predicate still needs a SELECT policy, so it would not be narrower than the owner-session policies above. `test/teras-chats-owner.test.ts` proves all of this with a restricted, non-superuser owner, because CI's superuser bypasses even forced row security.

**Erasure.** A person deletes one chat or erases all of theirs, expired or not and without needing the Assistant grant; "Clear my chat text" now erases stored chats too. Person erasure (`core/pdpa.ts`) calls `app.teras_chats_redact` inside the same admitted, audited review-erasure intent as transcript redaction; it deletes the subject's chats (by the original person) and their logins' task memory, and reads no turn. Every path that removes a chat (own, retention, person erasure, a deleted login) also removes that conversation's task memory. Two narrow definer paths reach other logins' chats, each with its own owner-only policy: person erasure (admitted intent, delete only) and a shortened setting (that tenant only, `expires_at` only).

**Letter requests from chat (AI v2 Phase 2 wave 2, migration 0973).** A letter request confirmed from a chat card has two parts in two custody classes. The request (letter type, purpose, status, HR's linked letter, decline reason and message, who handled it) and its `letter-request.*` events are **the HR record**: they follow the letters domain's own retention and are never deleted or changed when a chat is. The card is **chat-linked**: as a signed proposal it is no row of its own, and an open card in the conversation's task memory already goes with the chat; its id, kept on the request as `client_key` so a repeated Confirm is the same request, is cleared by a delete trigger on `teras_chat` on every path that removes a chat (own delete or erase, retention, person erasure, a deleted login). No chat-to-request link is stored, so the trigger clears the key on that login's requests confirmed since the chat started (with the card's ten-minute life as a margin); a wider clear can at most turn a repeated Confirm of a still-open card into the "already requested" refusal. The trigger changes `client_key` only, under a transaction-local marker for the chat's own tenant and login that two owner-only policies and the request guard require; the application role gains nothing.

**Not yet decided (for the AI Centre revamp).** The Chats list, per-chat delete and the "Keep chats for" control have server functions and actions (`app/assistant/chat-actions.ts`) but no screen. A reopened chat shows no line for a withheld turn. "Clear my chat text" still describes a 30-day period, which now covers transcripts only.

## 10. Addendum (3 November 2026): workforce metrics (AI v2 W7)

**Scope.** AI v2 Phase 1 workstream W7: governed metrics for analysis in chat, built on the §8 pattern. Four named metrics behind one read, `workforce_metrics`. It adds no disclosure class and authorises no real data reaching a provider: §5.1 still gates that.

**What is computed, and by whom.** `core/workforce-metrics.ts` `workforceMetrics` computes every figure, reading as the caller under RLS. The model only words the figures and chooses a named period; it never works out dates or figures.
- **Headcount**: people with an employment active on a date (hired on or before it, not yet terminated). Departments come from the assignment in force on that date. With a period, the headcount is on its last day; joiners and leavers are counted in it, and a move from one employment to another in the same company is neither.
- **Turnover**: leavers ÷ the average of the first-day and last-day headcount, as a percentage to one decimal place.
- **Overtime trend**: overtime **hours, not pay**, for each of the six full months before the current one. Each attendance day contributes its stored `ot_minutes`, or the recorded duration where an overtime pattern calculated the day: the Overtime report's own sum (`summarizeOvertimeRecords`). A month with days not yet calculated is marked not complete.
- **Leave liability**: the outstanding annual leave balance in **days, not money**, on a date. This is the sum of annual-leave ledger entries dated on or before it; pending requests are not deducted.

For all four, each person counts once per company. Named periods (this or last month, quarter or year) and the six months are resolved from the HR date owner (`lib/hr-date.ts`). Each metric carries an exact label of what it counts.

**Who may ask.**
- **An HR administrator**, for the companies the database says they administer: `app.is_admin_for`, for a current principal (`app.principal_snapshot_current`), the company not archived, with the employees module and the metric's module (attendance or leave) enabled.
- **A manager**, for their own team only: the My Team scope (`resolveMyTeamScopeTx`, every report the page shows), and only what that page already shows. That is headcount as of today, overtime where attendance is on (the page links each person's attendance records), and annual leave days where the leave type's Available and Pending lines are visible. A manager gets no turnover, no joiners or leavers, and no past dates.
- **Employees and payroll partners** are not offered the read, and the service refuses them in one sentence. So is a session that claims a role the database does not hold.

**Suppression.** These are the §8 rules, decided over the caller's whole scope, with people as the unit. A group's size is its population: the people active on the date, or everyone employed in it during the period or month.
1. A group of fewer than 5 people is withheld. For overtime and leave days, so is a group whose members all have the same figure, zero included: a total of zero hours or days would state each member's figure.
2. A group whose complement within its parent is 1–4 people is withheld. The parent is the company or team for a department, and all companies for a company.
3. Complementary suppression, as in §8.
4. A withheld company or team withholds all its departments.

A company with nobody in it reads `no_people` and protects nothing.

**What reaches the provider.** The result is declared as entity `workforce_metric` (`core/semantic-model/entities-metrics.ts`, audience `admin`, page `/analytics`):
- every count, rate, average headcount, hour figure and day figure is `bands`: a placeholder plus its band, restored locally for the person;
- company and department names are `minimum`: configuration the administrator administers, or that the manager sees on My Team;
- company ids and the threshold are dropped before the model sees anything. No person, id, name or single person's figure is in the result;
- the trace records counts, paths and digests only.

**Residual risks** (not addressed here):
- One person can carry most of a group's overtime, and the total then nearly states their hours. There is no dominance rule.
- Results compared across dates, months or callers with different scopes can be differenced.
- A manager's team is today's team, so its overtime months cover today's members, not those of each month.
- Overtime on a day an overtime pattern calculated is read only where the caller can read the recorded duration. Otherwise the day counts as not calculated.
