# Assistant capability review: our code, every kind of user, and AI-native products (November 2026)

> Review record at its date. Current source, later ADRs and the [repository policy](../REPOSITORY-AND-ENVIRONMENTS.md) govern. Nothing here authorises a disclosure change, deployment or production contact. It supports [ADR-0169](../adr/0169-assistant-context-harness-and-disclosure-repivot.md); the ADR's §5.1 privacy/legal review still gates any real data reaching a model.

**Inputs.**
- This branch (`claude/assistant-onyx-phase1-20261031`, draft PR 170). Source was read directly; key claims were spot-checked.
- A code inventory of ~130 manual journeys across every access type, with file:line evidence for each.
- A web survey of 16 AI-native products (2025–26 sources, each claim marked as vendor-stated or independently reported).
- The real-model probe runs recorded in the [phase-1 review](assistant-conversational-phase1-2026-10.md).

The two research files are kept with the builder evidence (`RESUME/AI-DEV-CLAUDE-EVIDENCE-20261031/`).

**Labels.** Fact = read in code or a cited source. Inference = reasoning from facts. Vendor claim = what a vendor says about itself, not independently tested.

## 1. Verdict

**Confidence: medium.** The code facts are high-confidence. The ranking of what users do most often is inferred: no usage data was available.

1. **The safety foundations are stronger than in most products surveyed.** Three examples:
   - The model never decides permissions or money.
   - Changes complete on the product's own review pages.
   - Disclosure to a provider is bound to approved source digests.

   Only one surveyed product documents hiding small groups in AI analytics (Microsoft Viva, minimum 5). We already have this, at 20 people per cohort and 5 per slice (`core/ai-domain-analysis.ts`). Salesforce's own material says its masking is disabled for agents.
2. **What users can get from the AI is far behind those products.** The production Assistant understands a fixed list of 19 request types (`lib/ai/provider-assistant-policy.ts`). Most of each role's daily work has no Assistant help at all (§3). The phase B context layer on this branch closes part of that gap, but nothing in production uses it yet.
3. **The biggest wins need no new disclosure: they need the harness.** The highest-value, lowest-risk items are:
   - the approver's leave decision;
   - cancelling approved leave;
   - "what is waiting for me";
   - setup readiness;
   - grounded "how do I…" answers.

   All of them wrap native owners that already exist. What's missing is the production harness (ADR-0169 phase C) that can call them safely: a fixed privacy gate, budgets, fencing of untrusted text, exact figures restored from tool results, and task memory.
4. **Some popular AI features should not be copied** (§6), for example inferring an employee's attitude or likelihood to leave from their messages.

## 2. What exists today (facts)

| Layer | Production today | This branch (not in production, fictional data only) |
|---|---|---|
| Understanding | Fixed grammar of 19 request types; the provider receives numbered references only | The real model sees the question and calls tools. A fixed pre-read privacy gate (`lib/product-context/request-gate.ts`) removes private reads for other-person, override and attachment turns |
| Reads | 12 own-scope reads (`core/assistant-tools.ts`), reachable only through the grammar | Plus context reads: destinations (built from the sidebar sources, with a drift test), guides, setup readiness (payroll, records, leave health, holidays, schedule groups, onboarding), company setup, approval queue counts |
| Changes | 7 inline cards; other registry actions are links | All human-confirmed registry actions can be suggested, each opening its review page; the person confirms there |
| Analytics | Governed AI analysis on `/analytics` (bands only, person-count thresholds, per-company admin check, centrally reviewed) | Not offered to the Assistant (§5) |
| Measurement | Oracle baseline | Behaviour scoring over 58 + 16 turns with independently reviewed expected answers; hard failures for private reads on refusal turns, blank replies, invented links, and (new) claims that a change is already made |

Latest real-model results are in the phase-1 review §15–§16.

## 3. Coverage by kind of user

Facts from the inventory. Counts are journey rows, not screens.

| Kind of user (how decided) | Answered today | Change suggested today | Nothing today: the most frequent work |
|---|---|---|---|
| **Employee** (any signed-in person; own-subject helpers) | 9: leave balances/taken/requests, holidays, claim status, profile, reporting line, payslip and pay change | 4 cards + 8 links (apply leave is a link, not a card) | Clock-in status, cancelling *approved* leave, withdrawing attendance/overtime requests, resigning, acknowledging letters and notices, TP1/TP3/EA forms, own delegation, goals and self-review |
| **Manager / approver** (`hasTeamAccess`; `assertCanDecide` per item) | Team leave summary, who is away | Claim, attendance and replacement-leave decisions as cards | **Leave decision is link-only**, although it is the most common one. Nothing for leave-cancellation decisions, bulk decisions, resignations, probation reviews, roster, delegation setup |
| **Delegate** (reporting line of type `delegate`) | As above | As above | No actor class of its own; whether the Assistant's decision sources admit a covering delegate is **unverified** |
| **HR admin** (`isAdmin`, company-scoped grants) | One employee profile at a time | ~22 record-maintenance review links | 17 of 18 movement kinds (confirmation, promotion, termination…), new hires, approving profile changes, *other employees'* leave (every leave read is own-subject by design), creating companies/departments/positions, letters, notices, users and roles, reports |
| **Configurer** (admin; some group-admin only) | Holidays | 5 links | Leave types, entitlements, approval chains, imports, shifts, schedule-group creation, overtime patterns, workflows, geofences, **all claims configuration** (no readiness owner exists), email and branding |
| **Payroll admin / partner** (`canManagePayroll`; payroll permission sets) | None beyond own payslip | Create run, close, reopen, reset, pay code: links | Inputs and prefills, compute, anomalies, statutory files and forms, bank file, cycles, policies, loans, permission sets |
| **Performance and reward partners, letter-capability holders, lifecycle staff** | None | A few links | Cycle administration, letters end to end |
| **Operator** | Out of tenant scope by design | — | — |

**Review observations found on the way.** They are unverified and outside this branch's scope, so they need their own check:
- `/admin/leave-config/approval-chains`, `/admin/payroll-config/*` and `/admin/rewards/[unitId]` use `scopedSession`, so a non-admin can open them. Writes are gated in services or SQL.
- `/payroll/**` pages redirect payroll partners, although database permissions admit them.
- `lib/permissions.ts` lists some route guards differently from the pages.

## 4. AI-native products compared: can we have it, and should we

Source: the landscape survey. "Have" means shipped in production, not on this branch.

| Capability (products that ship it) | Have? | Can we? | Security condition / note |
|---|---|---|---|
| **Acts strictly as the user** (Glean, Copilot, Notion, Attio, Rippling, Deel) | **Yes**: own-scope reads under the caller's transaction and RLS | — | Keep. Never add a "service account" read for chat |
| **Confirm before any change** (Rippling, Deel, Anthropic/OpenAI agent SDKs) | **Yes**: review pages | — | Keep. The probe now fails any reply claiming a change is already made |
| **Recommendation with reasons and policy version** (Ramp Policy Agent: approve / needs review / reject, cited policy) | No | **Yes**, for approvers: deterministic checks (balance, overlap, policy) produce the three states; the model only explains | Recommendation is computed by native owners, never the model; reviewer has the final say; "needs review" is the default |
| **Per-action autonomy ladder** (Linear show / auto-apply / hide; Ramp; Copilot Studio staged approvals) | No | **Partly**, and later | Only for non-sensitive, reversible actions (e.g. pre-fill a leave type). Pay, employment status and access never auto-apply (CLAUDE.md: human decisions govern) |
| **Two-layer permissions + agent registry** (Workday Agent System of Record) | Partly: per-user Assistant grant + module + registry actor classes | **Yes** | Add a report that lists actions a person could be offered but cannot complete; give delegates an actor class |
| **Per-run trace on the review page** (Attio, Ramp, Legora, Purview audit) | No | **Yes** | Show what was read and why the action was suggested; store it with the review, not in the model |
| **Sensitive-topic routing to a person** (ServiceNow HR filters, Intercom mandatory handoff) | No | **Yes**, deterministic, like the pre-read gate | Harassment, grievance, medical, self-harm, termination: reply with the HR contact or case route, no reads |
| **Workplace-harms boundary** (Microsoft forbids inferring performance, attitude or emotion) | Implicit only | **Yes**: write it into the harness rules and the test corpus | The opposite choice (Rippling Talent Signal) drew analyst criticism; do not copy it |
| **Prompt-injection screening, log first then block** (Microsoft, ServiceNow AI Guardian, Glean) | Override patterns in the pre-read gate; **tool output is not fenced** | **Yes**, in phase C | Fence tool, record and KB text as untrusted; screening log-only per tenant first; holdout suites stay release gates |
| **Natural-language metrics with small-group suppression** (Viva only documents ≥5) | Governed analysis on `/analytics` | **Yes**, through the existing governed owner (§5) | Bands and person-count thresholds, never free SQL, never exact small counts to the model |
| **Proactive flags and digests** (Deel payroll checks, Workday payroll agent, Lattice burnout flags, Ramp fraud) | Deterministic detectors exist (payroll anomalies, readiness, scheduled chasers), mostly **off** by default | **Yes**: a daily "what needs you" digest from the approval queue and readiness, as a notification | Deterministic detection; the model only words it. No predictive judgements about individuals |
| **Scheduled / triggered agents in plain language** (Notion, Linear, Attio, Ramp) | Scheduled chasers (agent principal), off | Later | Needs the agent-principal path and tenant opt-in; never makes changes |
| **Plan before multi-step change** (Claude Code, Cursor) | No | **Yes** for bulk or multi-step work (onboarding a cohort, year-end leave) | The plan is a list of review pages; each step still confirmed |
| **Spreadsheet intake: map → flag → approve → apply** (Rippling) | Personnel import header mapping exists (AI proposes mappings, never rows) | **Yes**, extend to leave balances and pay items | The model maps columns; native import validates and previews; a person applies |
| **Receipt and document extraction** (Ramp receipts, Workday documents, Harvey) | No | **Yes**, for claims | Needs its own disclosure contract (images are personal data); extract into a draft only |
| **Policy document → structured rules** (Ramp, Intercom Guidance) | No | **Later** | Drift between the handbook and configured rules is a known failure (Ramp says so); show differences, never auto-configure |
| **Letter and note drafting** (Copilot, ServiceNow, Workday) | No (letters are deterministic templates) | **Yes** | Draft only, through the letters approval workflow and capability grants |
| **Citations to sources** (Copilot, Notion, Legora) | Phase B guides carry their page; replies not yet cited | **Yes** | Cite the guide, page or record type, not raw data |
| **Verified knowledge sources** (Notion) | No | **Yes** | HR marks KB articles verified; the Assistant prefers them. Tenant KB disclosure rule needed first (ADR §2.1) |
| **Multilingual** (Intercom: 45+ languages) | Interface in 6 languages; gate patterns en/ms/zh/vi | **Yes** | Tamil and Thai gate patterns need a native-speaker review |
| **Task memory / personalisation** (Copilot history, Linear guidance, Claude Code memory) | No | **Yes**, phase C task state | Re-authorised every turn; never HR truth; erasable with the transcript |
| **Customer-facing evaluation** (Agentforce Testing Center, Intercom simulations, Ramp alignment) | Internal probe only | **Later** | An admin page showing agreement between suggestions and human decisions, from audit data, no new disclosure |
| **Admin model choice, zero retention, regional residency** (Glean, Copilot, Notion; residency only Microsoft, Harvey, Intercom, OpenAI) | Provider configuration per tenant; the fictional-data probes requested zero retention and no data collection from OpenRouter (production provider terms are not proven by code) | **Decision for the privacy review** | No vendor documents Malaysia-resident inference or a PDPA cross-border consent flow; assume cross-border transfer |

## 5. Governed workforce metrics: design (ADR-0169 §2.2)

**Finding (fact).** A governed analysis owner already exists. It is used by `/analytics` and shown on `/assistant`:
- `core/ai-workforce-analysis.ts` covers headcount change. `core/ai-domain-analysis.ts` covers attendance, leave, claims, performance, rewards and organisation.
- Authorisation runs per company: `has_role_for('hr_admin'|'super_admin')`, the module, and the employee-master report-field resolver.
- It counts distinct people. The threshold is a population of at least 20; a slice and its complement must each be 0 or at least 5.
- Only change bands and shares leave the system: no names, ids, dates or exact counts.
- The source is fingerprinted and replayed at admission.

**Decision.** No second metrics layer on this branch: two owners of "headcount" would contradict CLAUDE.md's one-owner rule.

Offering these metrics to the Assistant needs one of two things. Either export the authorisation and projection functions, or add an Assistant entry point beside `generateWorkforceAnalysis`. Both change files inside the approved provider digest, so they need fresh approval. They belong in the §5.1 review package.

**Where suppression applies, and where it does not** (owner question, 1 November 2026). The person's own access remains the primary control.
- **No suppression when the person can already read every row behind the figure.** A manager asking about their own team's leave gets the exact answer; hiding it would protect nothing.
- **Suppression applies in two cases:**
  1. **A total over data the person may not read row by row.** Examples: pay (managers may not see subordinate base pay, `core/analytics.ts`), leave reasons, or groups outside their scope. A small group would turn a permitted total into one person's forbidden value.
  2. **Anything sent to the external model, whatever the person's rights.** The provider is a separate recipient, and that disclosure is the PDPA cross-border question. The model gets bands or placeholders; the exact figure the person may see is filled in locally (ADR-0169 §2.3).

**Shape when approved.**
- A context tool `workforce_trends(domain, period)`, administrators only, calling the same `authorizeSourceTx` and projection.
- The model receives the band and support class only.
- The exact figure, where the person may see it on `/analytics`, is filled in locally from the tool result (phase C "exact values").
- Free-form questions map onto the fixed measure list. Anything else gets the analytics page.

## 6. What we should not build

Inference, with reasons:
- **Judgements about individuals:** predicting resignation, inferring sentiment or "talent signals" from messages. These are high-risk under PDPA's purpose limitation, they have a power asymmetry, and the training data can't be audited.
- **Free-form SQL or a "chat with the database" tool.** It bypasses the native owners and RLS-shaped reads that make answers trustworthy.
- **Auto-applying pay, employment-status or access changes**, at any autonomy level.
- **The model calculating money, entitlements or dates.** It explains native results only (ADR-0084).
- **Agent memory treated as HR truth**, or kept longer than the transcript.

## 7. Recommended order

Each step runs on fictional data behind a switch that stays off, until the §5.1 review passes. Release order stays with the Orchestrator.

1. **Phase C harness as product code** (allowed by ADR §5.1). It includes:
   - the pre-read gate;
   - budgets;
   - fencing of untrusted text;
   - exact figures restored from tool results;
   - task memory;
   - the per-tenant switch;
   - the per-run trace stored with each review.

   It needs no new reads, and it is the prerequisite for everything below.
2. **Cards for the most frequent changes:** the leave decision, approved-leave cancellation, and apply leave. All three already have review pages and registry entries.
3. **Sensitive-topic routing** and the **workplace-harms rule**, as deterministic gate categories with tests.
4. **Approver recommendation in three states.** Native checks decide the state; the model explains it.
5. **Readiness completions from existing owners:**
   - employees without an entitlement table (`listEmploymentsWithoutEntitlementTable`);
   - employees without a login (`listEmployeeActivationCandidates`);
   - letter settings (`readLetterSettingsReadiness`);
   - leave generation runs.

   Claims setup needs a readiness owner built first.
6. **Daily "what needs you" digest** from the approval queue and readiness, as a notification.
7. **After the §5.1 review:**
   - workforce trends (§5);
   - receipt extraction into claim drafts;
   - letter drafting;
   - spreadsheet intake for balances and pay items;
   - tenant-facing evaluation.

## 8. Unknowns

- How often each journey actually happens (no usage telemetry was read).
- Whether the Assistant's decision sources admit covering delegates, and whether a payroll partner passes the payroll actor checks.
- The production model, cost and latency at real traffic, and reply quality on real data.
- The vendor capability claims in §4 are mostly vendor-stated. No independent security tests were found.
- Whether tenants accept option 2 disclosure at all.
