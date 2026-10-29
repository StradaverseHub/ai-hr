# AI architecture review — October 2026

- **Date:** 2026-10-29
- **Reviewed source:** `origin/main` = `alpha` = `82f7c6570` (ADR-0151 wave 1 on staging, migration 0670).
- **Method:** source reading only. Nothing was built, tested, run or queried against an installation. Every
  claim cites `file:line` at `82f7c6570`. "Verified" means read in source; runtime behaviour on staging is
  **not** established by this review (see §9).
- **Measured against:** the owner goal ("the orchestrator does everything each user can do within their
  permissions, and measurably reduces manual HR work") and the accepted ADR-0082, 0084, 0109, 0116, 0131 and 0151.
- **Parallel work at review time:** `ai-wave1b` had uncommitted work (migration 0671, a generic *assigned*
  review store, overtime and approver-decision contracts). `ai-learning-loop` and `ai-hr-admin-agent` had no
  diff yet. §8 maps the findings to those sessions.

## 1. Executive summary

The product has a **sound safety core but a thin, fragmented agent layer**. All model traffic goes through one
gateway with admission, allowances and pause. Every write goes through human-confirmed, digest-bound prepared
actions executed by the owning service. No model calculates money or writes HR facts unreviewed. That
foundation matches ADR-0084 and ADR-0151 and should be kept.

What sits on top of it is less than the names suggest, and partly does not work:

1. **The scheduled "AI agents" cannot reach a model.** The nightly sweeps run with no user id. The AI
   principal check refuses every context without a user (`core/ai-principal.ts:11`). Readiness reminders and
   claims triage fall back silently to templates or "not configured". The sweep log says "[no AI provider]"
   (`scripts/review-sweep.ts:158`), and the status pages show those agents as "on" with AI configured. The
   feedback-planning cron fails every item. Background AI is effectively deterministic today.
2. **The "learning loop" is close to inert.**
   - A routing candidate can never be promoted. The candidate passes a case only if the baseline also passes
     it (`core/module-agent-evaluation-harness.ts:51`), and promotion requires strictly more correct cases
     (`lib/ai/paired-evaluation.ts:12`).
   - Promotions apply only to the author's own Assistant (`core/module-agent-releases.ts:1153`).
   - Any repository change invalidates every candidate, because the source manifest hashes the whole repo
     (`scripts/ai-agent-source-manifest.mjs:9-13`).
   - No candidate kind covers the action entries or the tool catalogue.
3. **The action layer works but does not scale.** 22 actions sit across four store shapes (12 dedicated
   stores of about 70 lines each). Every new action touches about 10 hand-kept closed lists in TypeScript and
   SQL, and the four authorization pre-checks are re-composed in about 30 files. ADR-0151's "one registry,
   tool catalogue derived at runtime" (§4.2, §4.6a) is not yet true: the chat has 12 hand-listed read-only
   tools, and actions reach chat only as links.
4. **"Agent" names at least four different things**, and the "AI Control Tower" holds deterministic HR pages.
   An administrator cannot see every AI component, switch, cost and outcome in one place. Pausing the
   Assistant also pauses all 22 actions, with no per-action switch.
5. **Measured reduction of HR work is not yet possible.** ADR-0131 Phase 1 process assessment exists, but
   nothing links an AI-prepared action to staff actions avoided. `agent_proposal` does not cover the
   Assistant, and there is no per-entry outcome aggregate.

A second pass (§7.1) added R15–R22. The most important is R15: rank the action backlog by measured staff work,
so that each wave moves the headcount measure. §7.2 lists the decisions needed from the owner.
[ai-architecture-handoff-2026-10.md](ai-architecture-handoff-2026-10.md) turns all of this into ordered work
packages, with a prompt for an implementing agent.

**Top five recommendations** (full list in §7):

1. Ship the named agent principal and make the scheduled agents honest in the meantime.
2. Collapse the action layer onto one registry plus the generic store, and derive the chat catalogue from it.
3. Repair the promotion harness so learning can actually happen, at tenant scope, with action-entry evaluations.
4. Build one AI inventory page with a per-component switch, last run, cost and outcomes.
5. Add a "staff actions avoided" measure tied to the process assessment.

## 2. Component map

```mermaid
flowchart LR
  subgraph Interactive["Interactive (signed-in user, own SessionContext)"]
    L[Launcher<br/>app/assistant/launcher-actions.ts] --> C
    C[Assistant chat<br/>core/assistant.ts<br/>12 read-only tools<br/>core/assistant-tools.ts:980]
    C -->|my_module_work| R[20 module read bindings<br/>'module agents'<br/>lib/ai/module-agents.ts:2<br/>core/module-agent-readers.ts:60]
    R --> S[Specialist playbooks<br/>deterministic<br/>lib/ai/module-specialists.ts:41]
    S -->|links| H[Handoff routes<br/>lib/ai/module-human-handoffs.ts:6]
    H --> P[/22 prepare–confirm pages<br/>app/assistant/*/]
    P --> ST[(Prepared-action store<br/>app.assistant_own_leave_review<br/>0622 + generic 0670)]
    ST -->|confirm, same tx| OS[Owning services<br/>packs/*/service]
    OS --> DE[(domain_event)]
    ST --> NO[(ai_native_outcome_association<br/>0650)]
    G[Governed tasks / harness<br/>core/module-agent-releases.ts] -.promotes per author.-> C
  end
  subgraph Embedded["Embedded features (user-triggered)"]
    E1[Pay-rule draft] & E2[Report designer] & E3[Payroll narration] & E4[Import mapping] & E5[Performance drafts] & E6[Feedback plan]
  end
  subgraph Scheduled["Scheduled (cron, NO user id)"]
    RS[review-sweep 03:00<br/>scripts/review-sweep.ts:90] --> HO[Deterministic HR orchestrator<br/>core/hr-orchestrator.ts:110]
    HO --> NU[Readiness reminders] & TR[Claims triage]
    AS[anomaly-sweep 02:30] --> HY[Payroll hypotheses]
    HO --> OC[(hr_orchestration_case)]
  end
  C & E1 & E2 & E3 & E4 & E5 & E6 & NU & TR & HY --> GW[Gateway lib/ai/index.ts<br/>governed() + ai_admit<br/>allowances, pause, spend]
  GW --> MR[(ai_model_run)]
  E1 & E2 & E3 & E5 & NU & TR & HY & CT[Control Tower action<br/>close_fixed_upstream] --> AP[(agent_proposal<br/>ADR-0084)]
  NU & TR & HY -. principal refused: no model call .-x GW
```

## 3. Q1 — Overlaps and duplication

| # | Overlap | Evidence | Verdict | How |
|---|---|---|---|---|
| D1 | Two "orchestrators" | Deterministic readiness coordinator `core/hr-orchestrator.ts:30-122` and the chat `core/assistant.ts`. They share no code or tables; both use the gateway and `agent_proposal`. | **Justified as two runtimes; misleading as one name.** | Keep both. Rename the nightly one "HR work queue" (it reconciles readiness cases, `orchestrator-harness.ts:70-87`). Under ADR-0151 §4.5 it becomes the executor of **Automatic-tier registry entries** under the agent principal. Both should share one registry, not two vocabularies. |
| D2 | "Module agents" vs specialists vs handoffs vs actions vs jobs | 20 `[module, capability]` pairs (`lib/ai/module-agents.ts:2-11`), the same 20 codes again in `lib/ai/module-jobs.ts:3-8`, one reader `switch` (`core/module-agent-readers.ts:60-125`), a deterministic playbook per module (`lib/ai/module-specialists.ts:41-72`), a fixed card formatter (`module-job-presentation.ts`), and 22 handoff routes re-listed as three zod enums (`module-human-handoffs.ts:6-30`). | **Consolidate.** None of these is an agent; they are one per-module descriptor split over six files. | One `ModuleCapability` registry entry per module: code, category, reader, presenter, playbook, and the action ids it can hand off to. Make handoffs a field derived from action entries. ADR-0131 already calls the 20 "internal logical capabilities" (`docs/adr/0131…:1125-1128`). |
| D3 | Outcome and evidence ledgers | `agent_proposal` (0452), the prepared-action store (0622/0670), `ai_native_outcome_association` (0650), `domain_event`, `hr_orchestration_case` (0535), `ai_model_run` (0541). | **Partly justified.** `domain_event` (effect audit), `ai_model_run` (usage) and `hr_orchestration_case` (coordination state) own distinct facts. `agent_proposal` and the prepared-action store both model propose → decide → outcome with different vocabularies. The Assistant never writes `agent_proposal` (no `recordProposal` in `core/assistant-actions/*`), so ADR-0084 proposal rates miss all Assistant actions. | Do not merge tables. Add a read-only **disposition view** that projects prepared-action lifecycle (and outcome associations) into the `agent_proposal` disposition vocabulary, so one measurement query covers both (ADR-0151 §4.6c). |
| D4 | Per-action review stores vs the generic store | Generic store used by `leave.cancel`/`leave.edit` only (`leave-change-review-store.ts:7-18`). `claims.cancel` uses the generic SQL but a hand-copied TypeScript clone (`claim-cancellation-review-store.ts:1-25`). 7 actions in `module-action-review-store.ts`, `leave.apply` in `own-leave-store.ts`, and 12 dedicated stores. `seal(` and the `Binding` schema are each repeated in 14 files. Each dedicated store has its own SQL function family. | **Consolidate.** The custody guarantees are identical; only the content schema and the owning-service call differ. | New actions use the generic store only (wave1b already adds a generic *assigned* family). Migrate dedicated stores one by one, keeping applied SQL bytes. Replace the `action_kind` CHECK lists (re-declared in 0622, 0650, 0655, 0657, 0670) with a reference table and FK, so a new action is an `INSERT`, not a constraint rewrite. |
| D5 | Closed action lists | About 10 per action: effect-id type, adapter union, nomination union and parse chain (`module-agent-actions.ts:30,33,145,152-172`), `NATIVE_OUTCOME_ACTIONS` (`module-native-outcomes.ts:7-31`), handoff routes plus 3 enums, `AGENT_ACTION_TIER_CEILING` (`agent-capability-inventory.ts:31-40`), `completed-outcome-readers.ts:40`, the server dispatch (`module-action-server.ts:140-169`), and at least 4 SQL lists. | **Consolidate.** This is exactly the "fourth list" ADR-0151 §4.2 wanted to avoid. | One `defineAgentAction({...})` per entry. Every TS list is derived from it; the SQL side is fed by the reference table in D4. The drift test checks that the DB rows equal the registry. |
| D6 | Repeated authorization pre-checks | `assertAiPrincipalTx` 129× in 63 files; `assertAiActionUnpausedTx` 47× in 30 files; `assertMayUseAssistant` 32×; `assertModuleEnabled` 86×. Two composition shapes. The login-currency SQL is duplicated in `own-leave-actor.ts:19-41` and `ai-principal.ts:9-27`. | **Consolidate the composition, keep the per-call re-check.** The fresh in-transaction re-check is required by ADR-0151 §4.1; copying it 30 times is not. | One `withAgentActionGuard(tx, ctx, actionId)` that derives module, pause key and grant from the registry entry. Delete the duplicate login predicate by having `own-leave-actor` call `isAiPrincipalCurrentTx` and add its person predicate. |
| D7 | Duplicated feature switches | The setting→feature map exists in TS (`lib/ai/features.ts:8-16`) and as a hard-coded SQL CASE (0541:73-77 → 0568:50-54 → 0621:18-22; the SQL copy omits `feedback_planning`). Setting-backed features are paused by the setting **or** a `feature:` policy row, but the management view ignores policy rows for them (`core/ai-management.ts:82`), so a stale row would be a hidden off-switch. Performance switches have two writers (`packs/performance/onehr/ai-settings.ts:52-56`, `core/ai-management.ts:183`). Two quota systems overlap: `ai_admit` plus OneHR's 5-per-field-per-day (`packs/performance/onehr/ai.ts:39`). | **Consolidate.** | One switch owner per feature (setting **or** policy row, never both), read by SQL from a table rather than a CASE. Fold OneHR's quota into an `ai_admit` allowance row. |
| D8 | Test-only parallel implementations | `runModuleReadPlan` (`core/module-agent-orchestrator.ts`) is used only by tests; production uses `runGovernedReadJob` (`module-agent-releases.ts:362`). `lib/ai/module-agent-improvement.ts` is used only by `test/module-agent-governance.test.ts`, although ADR-0151 cites it as the live harness. `createRoutingAgentCandidate`/`promoteRoutingAgentCandidate`/`maintainModuleAgentReleases` have no app or cron caller. | **Remove or wire.** | Delete the test-only modules (or make the tests target the live path), and delete the routing candidate kind (see R5). This removes a whole layer. |

## 4. Q2 — Management: can an admin see and control every AI component in one place?

**No.** AI management (`/control-tower/agents`, 8 sections, `app/control-tower/agents/sections.ts:6`) covers the
provider, Assistant grants, feature switches, allowances, spend, the orchestrator page and the latest 50 runs.
The rest is scattered or missing.

| Need | State | Evidence |
|---|---|---|
| Inventory completeness | `AI_FEATURES` has 20 workloads (`lib/ai/features.ts:2-17`). Not listed as components: the 22 actions and their tier ceilings, the 20 read bindings, the specialists (a count only, `screen.tsx:94-98`), the nightly orchestrator steps, and the operator feedback loop (`scripts/improve/*`, which talks to the database over SSH outside the gateway, `scripts/improve/remote.ts:215`). `agentCapabilityCoverage()` (`agent-capability-inventory.ts:236`) is computed but unused outside a test. | Missing |
| Switches | Feature on/off only. Feature rows cannot carry caps (0541:8, 0662:17). `hr_assistant` pause also stops every action and specialist (38 call sites); there is no per-action switch. Platform features (feedback planning) need owner SQL (`DEPLOY.md:777-786`). | Partial |
| Allowances and spend | Good: company, user, user-default and group tiers; USD reservation; spend receipts. The Assistant's own budget uses a UTC day (`core/assistant.ts:235`), not Malaysia time, and checks before acting (concurrent questions can both pass). | Mostly present |
| Pause | Present at admission (`core/ai-governance.ts:77-79`) and per action (`assertAiActionUnpausedTx`). The comment above it still says "SOURCE-ONLY … Not wired to an endpoint" (`core/ai-governance.ts:24-30`), which is stale. | Present, mislabelled |
| Observability | Latest 50 runs, no paging or date range (`core/ai-management.ts:157-160`). Schedules and last runs are on `/admin/scheduled-actions` (`core/job-run.ts:63-72`). Triage and hypothesis counters are not saved in `job_run.result` (`review-sweep.ts:183-196`, `anomaly-sweep.ts:214-221`). The nightly run is invisible to company-scoped HR admins: the queue matches `scopeDigest`, and the cron's digest is always `all-employments` (`core/hr-orchestrator.ts:21-27,142,157`), so they see `orchestrator.unobserved` (`messages/en.json:18933`). | Weak |
| Audit | `ai-control.*` events are written; no screen reads them. Connection probes (`core/ai-config.ts:371-393`) are not written to `ai_model_run`. | Missing UI |
| Outcomes | Proposal agreement rates are on `/control-tower` (`core/control-tower.ts:313`), not in AI management, and exclude the Assistant (D3). No per-action outcome view. | Missing |
| Cost per component | Run ledger is per feature. Every action and specialist rolls up under `hr_assistant`. | Partial |

**Naming that misleads users or admins**

- "Agent" means the 20 read bindings ("Module agent evaluation", `en.json:23490`), the background jobs ("The
  chaser", "The second opinion", "The claim reader", `en.json:8890-8894`), and Control Tower actions
  (`core/agent-actions.ts`). The UI calls the read bindings "specialists" ("HR assistant and module
  specialists", `en.json:23609-23611`). The code calls the playbooks specialists too.
- "AI Control Tower" (`en.json:397`, `components/sidebar.tsx:489-510`) contains deterministic pages: Employee
  data, Payroll exceptions, Approvals.
- "Central HR orchestrator … its deterministic checks do not consume model tokens; the feature switches above
  control its AI agents" (`en.json:23479`). Nothing is "above" on its own page now, and the AI agents it names
  cannot call a model when run nightly (§1.1).
- Status pages show the scheduled agents as on with AI configured (`core/control-domains.ts:125-132`,
  `core/control-tower.ts:341-343`). The sweep log says "[no AI provider]" when the real cause is the missing
  principal (`review-sweep.ts:158`).
- There are two entry points: Administration › AI → `/admin/ai`, which only redirects (`app/admin/ai/page.tsx:5-6`),
  and AI management › Provider.
- The launcher intro says it does not know what is on screen (`en.json:18708`), but it sends the record UUID
  from the URL (`app/assistant/launcher-actions.ts:28`, bounded by `lib/ai/page-context.ts:27-37`).
- `app.assistant_own_leave_review` stores every action kind (ADR-0151 already defers the rename).
  `rollbackRoutingAgent` rolls back every candidate kind (`app/assistant/specialist-review-actions.ts:34`).

## 5. Findings — security, failure handling and cost

| # | Finding | Evidence | Severity |
|---|---|---|---|
| S1 | The gateway fails open. `governed()` runs the call with no-op recorders when `cfg.governance` is absent, so any hand-built `{provider, model, apiKey}` skips admission, caps, pause and the ledger. Today only `testConnection` builds one deliberately. | `lib/ai/governance.ts:9-11`, `core/ai-config.ts:371-374` | Medium (latent) |
| S2 | The caller-inventory drift test walks only `core`, `packs` and `app`. It checks three SDK names, cannot see raw `fetch` to providers, and accepts pack files that merely contain `assessmentAiConfigTx`. It is not in the always-run set. | `test/ai-management-contract.test.ts:26-48`, `scripts/gate-affected-plan.ts:26-35` | Medium |
| S3 | Prompts include record text without untrusted-data framing: the performance manager draft sends self-comments, goals and peer 360 text with `redactPII` only and no output check beyond non-empty (`core/performance.ts:2943`); claims triage sends employee descriptions without that framing (`core/input-triage.ts:200-218`, but its output space is closed). OneHR (`packs/performance/onehr/ai.ts:33-81`), import mapping and the chat prompt (`lib/ai/assistant-conversation-system.ts:38-43`) do frame it. | as cited | Medium |
| S4 | The pay-rule draft lets the model propose money parameters (percentage, rate, cap). The editor fills the form with them (`app/admin/pay-components/pay-rule-editor.tsx:335-341`). The admin's Save is the only human step; Preview is optional. This is consistent with "models propose" (ADR-0084), but money parameters deserve a mandatory preview against a sample and explicit bounds. | `core/pay-rule-ai.ts:96`, prompt bound `:52` | Medium |
| S5 | The report designer has no core-level authority or source-bound admission check. It relies on `isAdmin` in the server action. | `core/report-ai.ts:89-97`, `app/reports/actions.ts:146` | Low–Medium |
| S6 | Transcripts store the question, answer and tool inputs in full (`db/schema.ts:9628-9636`). `converse()` deliberately skips `redactPII` (`lib/ai/index.ts:139-144`). The 30-day retirement depends on `aihr-ai-retention.timer`, whose source is a "disabled template … not installed or runtime verified" (`deploy/systemd/AI-RETENTION.md:3-6`). Whether staging runs it is **unknown**. | as cited | High if not installed |
| S7 | There is no AI threat model. The only threat model puts AI out of scope ("get their own threat models when scheduled"). | `docs/architecture/threat-model.md:4-5` | Medium |
| S8 | Promotion integrity: the promoter is not checked to differ from the evaluators (`core/module-agent-releases.ts:236` checks the author only). No suite has an explicit cross-tenant case. | §6 | Low–Medium |
| S9 | The provider key is AES-256-GCM, derived by scrypt from one `AI_CONFIG_SECRET` with a fixed salt; there is no key-id rotation scheme beyond a version byte. A tenant without config silently uses the platform environment key, and `isAiConfigured` reports true (`core/ai-config.ts:167`, `core/ai-provider-snapshot.ts:64-67`). | `lib/ai/crypto.ts:1-37` | Low (operational) |
| F1 | Failure transparency: the scheduled agents swallow principal refusals as "not configured" (`readiness-nudge.ts:155`, `input-triage.ts:371`, `payroll-hypothesis.ts:670,682`). The chat maps grant and module errors to `provider_error` (`app/assistant/actions.ts:35`). The chat deadline is checked only between turns (`core/assistant.ts:65-76`). | as cited | Medium |

## 6. Learning loop and evaluation coverage (ADR-0151 §4.6d, ADR-0131)

| Aspect | State at `82f7c6570` | Evidence |
|---|---|---|
| What can change | Four candidate kinds, each a switch between variants already in code. There is no free-form prompt change. | `core/module-agent-releases.ts:62`, `module-agent-prompt-candidate.ts:56`, `assistant-conversation-candidate.ts:7` |
| Routing kind | Cannot be promoted: the candidate passes only where the baseline passes, and promotion needs strictly more correct. | `module-agent-evaluation-harness.ts:51`, `paired-evaluation.ts:12`, `releases.ts:228` |
| Scope of a promotion | Only the author's own Assistant (`owner_user_id = ctx.userId`). There is no tenant rollout, unlike ADR-0131:146. | `releases.ts:252,939,1153` |
| Invalidation | The source manifest hashes every tracked ts/tsx/mjs/sql/json file, so every deploy retires every promotion. | `scripts/ai-agent-source-manifest.mjs:9-13`, `releases.ts:70-74,943` |
| Regression rollback | Triggered by a failed synthetic run, a specialist exception or source drift. Not by measured outcomes; "incorrect" feedback does not roll back. | `releases.ts:673,952,943,310-327` |
| Maintenance | `maintainModuleAgentReleases` is not scheduled; expiry is enforced at read time. | `releases.ts` (no caller) |
| Holdout coverage | Conversation suite: 192 cases (32 × 6 locales) including injection, salary, other company and ambiguity, but it exercises only 4 of the 12 tools. Untested: `employee_profile` (reads other people), `who_is_away`, `team_leave_summary`, both pay tools, claims and reporting line. Prompt suite: 144 cases; specialist suite: 87 plus 52 follow-up. **No suite covers action prepare/confirm entries or handoffs**, and no explicit cross-tenant case exists. | `lib/ai/assistant-conversation-holdouts.ts:153-186`, `module-agent-prompt-candidate.ts:11-38`, `module-specialist-holdouts.ts` |
| "Scenarios" | ADR-0131 uses "redacted replay scenarios"; the code has fictional constant holdouts. ADR-0109 uses "scenarios" for the orchestrator bitmask replay (`test/orchestrator-harness.test.ts:8`). | as cited |

Net: the governance machinery (independent evaluators, author ≠ promoter, bounded jobs, expiry) is
well-built. What it can promote is narrow, short-lived and per-person, so it produces no fleet-wide improvement.

## 7. Q3 — Ranked recommendations

Value: H/M/L. Effort: S (≤2 days), M (≤2 weeks), L (more). Risk is the implementation risk. The order weighs
value against effort and dependency.

| Rank | Recommendation | Value | Effort | Risk | ADR | Parallel work |
|---|---|---|---|---|---|---|
| R1 | **Make scheduled AI honest now.** Distinguish "principal refused" from "no provider" in nudge, triage and hypothesis results. Save triage and hypothesis counters in `job_run.result`. Show "AI drafting unavailable for scheduled runs" on status pages instead of "on, AI configured". Fix `scopeDigest` so company-scoped admins see the nightly run. | H | S | L | 0109, 0116 | — |
| R2 | **Named per-tenant agent principal** for every scheduled job (review-sweep, anomaly-sweep, feedback-plan), with `actor_type='agent'`, enabling administrator, Automatic-tier-only authority and a principal path through `assertAiPrincipalTx`. Then decide per job whether the model step is worth keeping; the templates already work. | H | M | M (RLS, migration) | 0151 §4.5, 0131 §3 | `ai-hr-admin-agent` Part A (claim 0672); see the note below |

**Note on R2 (29 Oct 2026, uncommitted work in `ai-hr-admin-agent`).** That session adds `core/agent-principal.ts`
and migration 0672. The orchestrator pass in `scripts/review-sweep.ts` runs as the tenant's named agent
principal. A scheduled specialist runs only behind an administrator's attributed switch-on, and effects name
both the principal and that administrator. The principal is **deliberately not admitted to model spend**:

- readiness reminders send the fixed template;
- claims triage stops before reading claims and reports `notConfigured`.

Overnight AI therefore stays model-free by design rather than by accident. This review accepts that as a
reasonable choice; enabling model spend for the principal would be a separate decision with its own allowance
subject. Still open after that work:

- (a) The R1 log and status wording. `[no AI provider]` would still print for an agent run.
- (b) `scripts/anomaly-sweep.ts` and `scripts/feedback-plan.ts` still use the anonymous `hr_admin` context and
  were not changed.

Re-check the merged state before acting on this note.
| R3 | **One action registry.** `defineAgentAction` derives the effect union, nomination parser, tier ceiling, native-outcome list, handoff route, dispatch and outcome readers. A DB reference table plus FK replaces the CHECK lists. The drift test asserts registry = DB = inventory. | H | M | M | 0151 §4.2 | wave1b adds kinds the old way (0671 rewrites the CHECK again) |
| R4 | **Collapse stores onto the generic families** (own and assigned): migrate `claims.cancel`'s TS clone first, then the 12 dedicated stores. Add `withAgentActionGuard` (D6). Expected removal: roughly 800 lines of TS custody code and 12 SQL function families (estimate). | H | L (incremental) | M | 0151 §4.3, 0131 (no second ledger) | wave1b `generic-assigned-review-store.ts` is the target shape |
| R5 | **Make learning real.** Delete the routing candidate kind and `module-agent-improvement.ts`/`module-agent-orchestrator.ts` (test-only). Promote at **tenant scope** chosen by the approver (ADR-0131 §146). Scope the source manifest to AI-relevant files. Require promoter ∉ evaluators. Schedule maintenance. Trigger rollback from measured outcomes. Add holdouts for all 12 tools, every action entry (injection in record text, cross-company, cross-tenant, salary, missing permission, ambiguity → question). | H | M | L | 0151 §4.6d–e, 0084, 0131 | `ai-learning-loop` (measurement side) |
| R6 | **Derive the chat tool catalogue and action proposals from the registry**, filtered per caller, with inline review cards built from canonical prepared content. Keep the confirmation as a separate human command. Update the "stable per (tenant, role)" cache claims, since strategy selection is per user. | H | M | M | 0151 §4.3, §4.6a; 0082 | `ai-wave1b` (in-chat cards) |
| R7 | **Measure reduced manual work.** Per entry: offered → prepared → edited → confirmed/discarded/expired/reversed, joined to `domain_event`. Add a disposition view into `agent_proposal` vocabulary. Add a "staff actions avoided" estimate per process: confirmed AI-prepared actions × the process assessment's baseline staff steps, with elapsed-time deltas. Show it beside ADR-0131 opportunities. Aggregates only, RLS-scoped. | H | M | L | 0151 §4.6c, 0131 Phase 4, 0084 | `ai-learning-loop` PR #34 (open) adds per-kind lifecycle counts, a non-causal before/after per process and a coverage panel (migration 0674). Still open: the `agent_proposal` disposition view, "offered/edited/failed" (no source records them), and an attributed staff-actions-avoided estimate |
| R8 | **One AI inventory screen**: every component (chat, read bindings, specialists, each action with tier, scheduled jobs, embedded features, orchestrator steps, operator loop as out-of-band). Each row shows its switch, allowance, pause key, last run, 30-day cost, outcome rates and audit events. Add a per-action pause key (e.g. `hr_assistant:<actionId>`) under the module pause. Add run paging and date range, and log connection probes. | H | M | L | 0116, 0151 §4.7 | `ai-learning-loop` (outcome tiles) |
| R9 | **Gateway fail-closed.** `governed()` refuses without governance unless the config is an explicit `UngovernedProbe` type. Extend the drift test to `lib/` and `scripts/`, detect raw provider `fetch`, and make it always-run. | M | S | L | 0116 | — |
| R10 | **Single switch owner.** Move the setting→feature map to one table read by SQL; forbid `feature:` policy rows for setting-backed features (or display them); merge the OneHR quota into allowances. Decide and document the performance AI default-on (comments in `core/entitlements.ts:322,870` say all defaults are false). | M | S–M | L | 0116 | — |
| R11 | **Prompt and output hardening.** Untrusted-data framing plus output adjudication for the performance manager draft and claims triage. Mandatory preview with bounds for pay-rule drafts. Core-level authority plus `withAiAdmissionCheck` in `report-ai`. Atomic Assistant budget in Malaysia time. | M | S–M | L | 0084, 0082 | — |
| R12 | **Retention and threat model.** Verify on staging that `aihr-ai-retention.timer` is installed and running (query the target; this review could not). Document it in `DEPLOY.md`. Write an AI threat model covering leakage, injection, cross-tenant, unauthorized action, spend abuse and the agent principal. | H (if absent) | S | L | 0116, 0082 | — |
| R13 | **Naming clean-up.** "Module agents" → "module read capabilities" (code) and one user term. "AI Control Tower" → "Control Tower". The nightly orchestrator → "HR work queue". Remove the `/admin/ai` redirect entry. Rename `rollbackRoutingAgent`. One meaning of "agent": the agent principal and its scheduled jobs. | M | S | L | 0151, 0109 | — |
| R14 | **Doc refresh** (amendments, not rewrites): ADR-0082 status and retention; ADR-0151 vocabulary (`backlog/internal` vs `human_only/not_user_facing`), harness facts and action count; `DEPLOY.md` job counts and the review-sweep scope; the stale comments in §9. | L | S | L | 0082, 0151 | — |

**Simplifications that remove whole layers:**

1. The routing candidate kind and its harness (unpromotable).
2. The test-only `module-agent-orchestrator.ts` and `module-agent-improvement.ts`.
3. The six per-module descriptor files merged into one registry (D2).
4. 12 dedicated stores folded into two generic families (R4).
5. About 10 closed action lists derived from one definition (R3).

Keep: the gateway, `ai_admit`, digest-bound confirmation, outcome semantics, the inventory drift guard, and the
deterministic orchestrator.

### 7.1 Second pass: recommendations added on 29 Oct 2026

A second read against the owner goal found eight gaps that R1–R14 did not cover. The biggest is that nothing
decides *which* backlog actions to build next by how much staff work they would remove. That choice drives the
headcount goal more than any architectural clean-up.

| Rank | Recommendation | Value | Effort | Risk | ADR | Evidence and notes |
|---|---|---|---|---|---|---|
| R15 | **Rank the capability backlog by measured staff work.** Join the inventory backlog (`agentBacklogByTier()` in PR #34, `agent-capability-inventory.ts`) to the ADR-0131 process assessment's staff-action volume per process. Publish a ranked build list (entry, tier, staff actions per 30 days, users affected). Each new wave picks from the top. Without this, waves are chosen by intuition and may not move the headcount measure. | H | S | L | 0131 Phase 1, 0151 §5 | `core/process-assessment.ts:19-46`; about 250 classified entry points, 22 prepared |
| R16 | **A generic per-entry parity harness.** ADR-0151 §7 requires a role matrix per entry: employee, manager, assigned approver, company HR, group HR, payroll partner, performance partners and other tenant. Each role must get the same allow/deny from the agent as from the screen. No shared harness exists; parity is tested ad hoc per feature. Build one fixture matrix driven by the registry (R3), so every new entry gets parity, cross-company and cross-tenant refusal for free. | H | M | L | 0151 §4.1, §7 | No `test/*` runner over `MODULE_AGENT_ACTIONS`; existing matrix tests are feature-specific (e.g. `test/ess-permission-matrix.dom.test.tsx`) |
| R17 | **Enforce tiers at runtime.** `AGENT_ACTION_TIER_CEILING` is read only by its test (`agent-capability-inventory.ts:31`). The prepare path, any future Automatic executor and the agent principal must refuse an entry above its ceiling. Make never-Automatic categories a type-level and runtime constant. This is a precondition for R18. | H | S | L | 0151 §4.4, §4.6e | as cited |
| R18 | **First Automatic-tier entries under the agent principal**, all deterministic (no model):<br/>• chase overdue approvers along existing escalation routes (generalise `core/leave-escalation.ts` beyond leave to claims, attendance and replacement leave);<br/>• probation and contract-end reminders;<br/>• missing clock-in nudges;<br/>• expiring documents;<br/>• lifecycle step chasing.<br/>These are the cheapest real reductions in manual HR follow-up. They answer ADR-0151 open question 2, so the owner should confirm the order. | H | M | M | 0151 §4.4–4.5, 0109 | ADR-0151 §4.5 lists these; none exists as a registry entry |
| R19 | **Treat a provider or model change as a release.** Promotions are bound to the provider fingerprint (`module-agent-releases.ts:571,601`), but the baseline itself is never re-evaluated. A tenant switching model, or an `AI_DRAFT_MODEL` change, silently changes behaviour for every feature. On a change, run the holdout suites against the baseline and show pass/fail in AI management before activation. Also allow per-feature caps: feature rows cannot hold caps today (0541:8, 0662:17). | M | M | L | 0116, 0084 | `lib/ai/registry.ts:22` |
| R20 | **Alert, don't only display.** AI failure rate, principal refusals, spend near cap, scheduled-job failures and drift between configured and effective switches surface only on screens. Route them through the existing `deploy/cron-alert.sh` path and a Control Tower banner. | M | S | L | 0116, 0109 | `deploy/cron-alert.sh`; job counters gap in §4 |
| R21 | **Provider data register (PDPA).** For each feature, record which fields leave the tenant for the provider, after which redaction. Names are never masked (`lib/ai/index.ts:170`), and `converse()` skips redaction (`:139-144`). Show it in AI management beside the provider choice, so an administrator consents knowingly. Keep it current through the R8 inventory. | M | S | L | 0023 (PDPA note :73), 0116, 0151 §8 Q3 | as cited |
| R22 | **Close the two remaining anonymous jobs.** Move `scripts/anomaly-sweep.ts` and `scripts/feedback-plan.ts` onto the agent principal, or retire their model step explicitly. Either way, report "not admitted to model spend" instead of "not configured". This completes R1 and R2. | M | S | L | 0151 §4.5 | `anomaly-sweep.ts:114`, `feedback-plan.ts:48`, `payroll-hypothesis.ts:682` |

**Not recommended, recorded for completeness:**
- The mobile app has no Assistant (`mobile/` has no assistant screen). Add one only after R6's in-chat cards
  exist, because mobile confirmation must reuse the same digest-bound command.
- Bulk manager decisions remain an owner decision (ADR-0151 §8 Q1). The review takes no position until R7
  shows single-decision volumes.

### 7.2 Decisions needed from the owner

1. **R18 order.** Which Automatic-tier reminders and chasers come first? ADR-0151 open question 2.
2. **Model spend for the agent principal.** Currently "no" by design in `ai-hr-admin-agent`. Keep scheduled work
   template-only, or give the principal its own allowance subject?
3. **Performance AI switches.** Six of them default to on (`packs/catalog.ts:210-216`); every other AI switch
   defaults to off. Keep or flip?
4. **Naming (R13).** Approve the user-facing terms: "Assistant", "Control Tower", "HR work queue", "scheduled
   agent", and dropping "module agent" and "specialist" from the UI.
5. **Bulk manager decisions.** ADR-0151 §8 Q1.

**Resolved 29 Oct 2026.** The owner answered all five in chat: R18 order as recommended (a)–(e), all deterministic; no model spend for the agent principal; performance AI switches default off; naming as proposed (already approved); bulk manager decisions approved in principle as a separate package outside WP6–WP14. Recorded in [ADR-0151, Owner decisions — 29 October 2026](../adr/0151-orchestrator-action-layer-and-system-learning.md#owner-decisions--29-october-2026).

## 8. Q4 — Gaps against the owner goal and ADR-0151

**Capabilities.**
- The inventory classifies about 250 human entry points. The AI can prepare 22, plus 12 chat reads and 20
  module reads.
- Wave 1 on main has `claims.cancel`, `leave.cancel` and `leave.edit`. Cancelling *approved* leave
  (`requestLeaveCancellationAction`) is still `backlog:confirm` (`agent-capability-inventory.ts:169`).
- Overtime, claim, attendance-correction and replacement-leave decisions are backlog (`:182,137,149,169`).
  `ai-wave1b` is implementing them (0671).
- Every manager approval except leave is missing. HR personnel maintenance, lifecycle cases, leave and
  attendance administration, payroll inputs, statutory filings and access administration are missing
  (`ai-hr-admin-agent` Part B targets HR-prepared actions, claim 0674).
- There is no Automatic tier in use at all. The tier ceilings are data only, read by nothing at runtime
  except the test (`AGENT_ACTION_TIER_CEILING`, `agent-capability-inventory.ts:31`). So the reminders and
  chasing that ADR-0151 §4.4 allows to run unattended do not yet exist as registry entries.
- The drift guard classifies `"use server"` exports and mutating routes, but not the service entry points
  that ADR-0151 §4.2 names. It does not require each declared action to map back to a human entry point
  (`claims.draft.save`, `ess.profile.request` and `performance.onehr.plan.acknowledge` have none).
  `employees.import` is `registered` with a `handoff` ceiling.

**Measurement.**
- There is no metric linking AI to staff actions or headcount. The process assessment (ADR-0131 Phase 1,
  `core/process-assessment.ts:19-46`) measures volume, elapsed time, staff actions and rework per process,
  but nothing attributes a change to AI.
- There is no per-entry outcome aggregate (ADR-0151 §4.6c), and `agent_proposal` misses the Assistant (D3).
- The scheduled jobs' counters are partly unrecorded (§4).
- `core/tenant-settings.ts:17` notes `agent_proposal` is empty on production, so proposal rates there are
  currently zero-evidence.

**Governance.**
- No agent principal exists (§4.5).
- No per-action pause.
- No AI threat model.
- Retention installation is unverified.
- The gateway fails open (S1).
- The promoter may also be an evaluator (S8).
- The operator improve loop sits outside AI governance and is not listed in the inventory.

**Docs claiming what code does not do.**

| Claim | Reality |
|---|---|
| ADR-0151:32 "automatic baseline on regression", citing `module-agent-improvement.ts` | That file is test-only; rollback is triggered by exceptions or drift, not measured regression |
| ADR-0151 §4.6a: tool catalogue derived from the registry | Hand-maintained `ASSISTANT_TOOLS` (`core/assistant-tools.ts:980-993`) |
| ADR-0151 §4.6d: routing, tool-description and argument-extraction candidates | No such kinds exist except routing, which cannot be promoted |
| ADR-0151 §2 row 4: checks centralised in `module-action-server.ts` | Spread across about 30 files (D6) |
| ADR-0131:146: per-tenant rollout, redacted replay scenarios | Per-author promotions, fictional constant holdouts |
| ADR-0109:17-18: execution scoped to the caller's authorised employments | The cron has no caller; it uses group-wide `hr_admin` |
| ADR-0082:5 "Proposed … no code written"; :533 retention "STILL OPEN"; :101 `core/assistant-budget.ts`; :155,:243 concurrent tool calls; :529 `search_handbook` | Implemented; retention implemented (installation unverified); the file does not exist; tool calls run sequentially (`core/assistant.ts:415`); no such tool |
| `content/guides/admin-ai-reporting.md:7` "runs the existing readiness and claims agents" | It runs them, but without a model (§1.1) |
| `deploy/DEPLOY.md:172,183` "Four routine jobs", "All three"; `:180` review-sweep scope | Three in the table; the sweep also runs the orchestrator, nudges and triage |

## 9. Stale comments (listed, not changed)

This PR is docs-only so it does not trigger code gates. These stale comments are left for the next PR that
touches each file:

- `core/ai-governance.ts:24-30`: "SOURCE-ONLY … Not wired to an endpoint". Migration 0621 is applied and the
  function has 47 call sites.
- About ten `core/assistant-actions/*` headers say "UNMOUNTED … No model tool, route or public UI binds this
  file" although they are dispatched (`module-action-server.ts:143-168`), e.g. `own-claim-source.ts:1`,
  `reviewed-rewards-post-source.ts:1`, `attendance-correction-review-store.ts:3`, `own-profile-change-source.ts:1`.
- `core/assistant-tools.ts:223,235` "The nine tools" (there are 12). `:1004-1007` counts 11 and says "stable
  per (tenant, role)". `core/assistant.ts:33` says "caller's ROLE only" (strategy is per user). `:402` says
  "Promises may queue concurrently" (the loop is sequential).
- `scripts/review-sweep.ts:3,72` say the actor is `system`; orchestrator events record `agent`
  (`core/hr-orchestrator.ts:87,99,118`). `review-sweep.ts:12-16` and `anomaly-sweep.ts:139-150` describe
  nightly AI work that the principal check blocks.
- `lib/ai/module-agent-routing.ts:1` "The only currently evaluable candidate kind" (there are four).
  `human-plan-holdouts.ts:1` "all-module routing suite" (only 2 plans read data).
- `core/payroll-anomaly-narrate.ts:6` "The only place an LLM touches the payroll control tower" (hypotheses
  do too).
- `core/entitlements.ts:322,870`, `core/entitlement-types.ts:126`: "every catalogued default is false" (the
  performance AI switches default true, `packs/catalog.ts:210-216`).
- `core/feedback.ts:241` and ADR-0044 tell readers to set `FEEDBACK_AI_PLANNING_ENABLED`, which nothing reads.
- `.env.example:33`: AI "powers Draft with AI on the manager review" (it powers about 19 features).
  `deploy/systemd/README.md:3` "Five sweeps" (6 unit pairs).
- `core/assistant-actions/claim-cancellation-review-store.ts:1` and `module-agent-actions.ts:72` say "through
  the generic own-review store" (true at the SQL level only).
- `messages/en.json:23479` `orchestratorHelp` ("feature switches above"; "do not consume model tokens").
  `controlTower.agents` block `en.json:8869-8880` appears unreferenced.

## 10. Evidence limits

- **Not established by this review:** behaviour on staging, including whether the crontab, the retention
  timer and any `ai_control_policy` `feature:` rows exist. These need a query against the target.
- **Inferred:** "a context without a user cannot get a model config" is a code-path reading
  (`core/ai-principal.ts:11` → `core/ai-provider-snapshot.ts:41` → `core/ai-config.ts:155`). It was not
  executed, and a test that mocks `assertAiPrincipalTx` could hide it.
- **Estimates:** the line and column counts for 0622 and the boilerplate estimate.
- **Not reviewed in depth:** ADR-0131 amendments past about line 210; non-English message files;
  `validatePayRule` and `validateReportSpec` bounds.
