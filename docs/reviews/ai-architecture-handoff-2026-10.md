# Handoff: implementing the October 2026 AI architecture review

- **Written:** 2026-10-29. Base: `origin/main` = `alpha` = `82f7c6570`.
- **Source of findings:** [ai-architecture-review-2026-10.md](ai-architecture-review-2026-10.md) (R1–R22, with
  `file:line` evidence). Read it first. This file turns it into ordered work packages.
- **Audience:** an implementing agent (Codex or Claude) working in this repository.
- **Status words:** a work package is *done* only when it is merged, gated and, where it needs it, accepted on
  staging. These are separate states (CLAUDE.md).

## 1. Goal and non-negotiables

The owner wants the AI to do everything each user can do within their own permissions, and to measurably reduce
manual HR work and eventually headcount. The accepted design is
[ADR-0151](../adr/0151-orchestrator-action-layer-and-system-learning.md). It extends ADR-0082, 0084, 0109, 0116
and 0131.

Every work package must keep these properties:

1. **The model proposes; deterministic code prepares; a person confirms.** The owning service writes the
   effect and the review receipt in one transaction. A model never writes HR facts, calculates money, or
   confirms anything.
2. **Parity, never more.** Agent authority = the user's current authority ∩ registry ∩ tier ∩ switches and
   allowances. No second permission model.
3. **Tiers.** Automatic only for reads, reminders and chasing. Pay, approvals, access, terminations, ratings,
   hiring, promotion, discipline and payroll are never Automatic.
4. **Tenant and company isolation, effective dates and audit history are preserved.** USER, PERSON, EMPLOYEE,
   EMPLOYMENT, ROLE, PERMISSION and SCOPE stay distinct (`GLOSSARY.md`).
5. **No training on tenant data.** Learning happens only through measured outcomes and the promotion harness.
6. **Applied migration bytes are immutable.** Append only. Claim numbers before writing (§4).

## 2. Read before starting

1. `CLAUDE.md` (canonical) and `AGENTS.md`. Follow the "Start every session" steps exactly.
2. `docs/reviews/ai-architecture-review-2026-10.md`: findings, R1–R22, owner decisions in §7.2.
3. `docs/adr/0151-…md` (whole), then ADR-0116, ADR-0084, ADR-0131 §1–4 and ADR-0082 §2.
4. `docs/REPOSITORY-AND-ENVIRONMENTS.md`, `docs/MIGRATION-ALLOCATION.md`, `docs/LOCAL-RESOURCE-LOCKS.md`,
   `docs/CI-STAGING-VERIFICATION-POLICY.md`, ADR-0114 and `scripts/gate.sh`.
5. For any Next.js change: the installed `node_modules/next/dist/docs/`.

## 3. Work already in flight elsewhere (do not duplicate)

At handoff time three other sessions were working in this area. **Re-check each one's merged state before
starting a dependent package.** Use `gh pr list`, `git log origin/main`, and the shared notes if available.

| Work | Owner session | State on 29 Oct | Touches |
|---|---|---|---|
| Overtime request, claim/attendance/replacement-leave approver decisions, in-chat confirmation cards. Migration 0671; new `generic-assigned-review-store.ts` | `ai-wave1b` | Uncommitted | R3, R4, R6 |
| Per-kind outcome counts, non-causal before/after per process, coverage panel on `/control-tower/opportunities`. Migration 0674 | `ai-learning-loop` | PR #34 open | R7, R8, R15 |
| Named per-tenant agent principal for `review-sweep` (0672); HR-admin prepared actions (0677). Principal is **not** admitted to model spend | `ai-hr-admin-agent` | Uncommitted | R1, R2, R18, R22 |
| This review | `ai-architecture-review` | PR #33 open (docs only) | — |

## 4. Shared-resource rules

- **Migrations.** Known claims: 0669, 0671, 0672, 0673 (Mobile), 0674, 0675/0676 (Board), 0677. Before writing
  SQL:
  - re-read the alpha journal and the live staging watermark;
  - take the next free number;
  - pick a journal `when` strictly above every alpha entry and the live watermark;
  - record the claim in `docs/MIGRATION-ALLOCATION.md` or the coordinator's channel.

  Never reuse a historical number.
- **New tables** need grants as well as RLS. Review every writer before adding a constraint (NOT VALID still
  affects later writes).
- **Local resources.** Call `bash scripts/gate.sh` directly; it takes both memory slots and the database
  atomically. While another full gate runs, only read, edit and commit. Use your own worktree, database
  namespace, ports and evidence directory.
- **Deployment.**
  - Staging only through the normal operator path and the inter-session staging-window protocol, if the owner
    has authorised it for you.
  - Production never, without a separate explicit owner request.
  - Branch alignment or package publication grants no deployment authority.

## 5. Work packages (in recommended order)

Each package lists: recommendations covered, dependencies, files to start from, what *done* means, and the
evidence required. Keep one package per PR unless it says otherwise. Prefer small PRs into the integration base
named by the repository policy.

### WP1 — Honest scheduled-AI status (R1, R22). Small. No migration.

- **Depends on:** `ai-hr-admin-agent` merged, or coordinate with it first; it edits the same files.
- **Start at:**
  - `scripts/review-sweep.ts:158` (the "[no AI provider]" text);
  - `core/input-triage.ts:371`, `core/readiness-nudge.ts:155`, `core/payroll-hypothesis.ts:670,682`;
  - `scripts/anomaly-sweep.ts:114,214-221`, `scripts/feedback-plan.ts:48`;
  - `core/control-domains.ts:125-132`, `core/control-tower.ts:341-343`;
  - `core/hr-orchestrator.ts:21-27,142,157` (`scopeDigest`);
  - `messages/*.json` key `orchestratorHelp`.
- **Do:**
  1. Return a distinct reason, `principal_not_admitted` vs `no_provider`, and print and store it accurately.
  2. Save triage and hypothesis counters in `job_run.result`.
  3. Make status pages say "AI drafting is not used in scheduled runs" when that is true.
  4. Let company-scoped HR admins see the latest nightly pass for their companies (today they see
     `orchestrator.unobserved`).
  5. Move `anomaly-sweep` and `feedback-plan` onto the agent principal, or remove their model step explicitly.
- **Done when:** the sweep output, `job_run.result` and the Control Tower all show the same truthful state, in
  six locales.
- **Evidence:**
  - focused tests for each reason code;
  - a rendered Control Tower screen for a group admin and a company-scoped admin, after a fixture sweep.

### WP2 — Runtime tier enforcement (R17). Small.

- **Start at:** `lib/ai/agent-capability-inventory.ts:31-40`, `lib/ai/module-agent-actions.ts`,
  `core/assistant-actions/module-action-server.ts`.
- **Do:**
  1. Read the ceiling on prepare and confirm paths, and refuse above-ceiling use.
  2. Make the never-Automatic category set a single exported constant, checked by type and at runtime.
  3. Add a test that no entry in those categories can be marked Automatic.
- **Done when:** a test proves refusal, and an Automatic executor (when WP12 exists) cannot run a
  non-Automatic entry.

### WP3 — Ranked build list from measured staff work (R15). Small.

- **Depends on:** PR #34 merged (`agentBacklogByTier()`, the `measure` end parameter).
- **Start at:** `core/process-assessment.ts`, `lib/ai/agent-capability-inventory.ts`,
  `app/control-tower/opportunities/page.tsx`.
- **Do:** map each backlog inventory row to its ADR-0131 process, and rank by staff actions per 30 days and the
  number of people affected. Show it to group admins, and export it as the input to every later wave.
- **Done when:** the ranked list renders, with counts that reconcile with the process assessment on a fixture.

### WP4 — Gateway fail-closed and drift guard (R9). Small.

- **Start at:** `lib/ai/governance.ts:9-11`, `core/ai-config.ts:371-393`,
  `test/ai-management-contract.test.ts:26-48`, `scripts/gate-affected-plan.ts:26-35`.
- **Do:**
  1. `governed()` throws without governance unless the config is an explicit `UngovernedProbe` type, used only by
     the connection test.
  2. Log probes to `ai_model_run` as `probe`.
  3. Extend the drift test to `lib/` and `scripts/`, detect raw provider `fetch`, and remove the
     `assessmentAiConfigTx` string bypass.
  4. Put the test in the always-run set.
- **Evidence:** a negative test proving an ungoverned config refuses; a test proving an injected raw `fetch`
  fails the drift guard.

### WP5 — Prompt and output hardening (R11, S3–S5). Small to medium.

- **Start at:**
  - `core/performance.ts:2943` (manager review draft);
  - `core/input-triage.ts:200-218`;
  - `core/pay-rule-ai.ts:52,88,96` and `app/admin/pay-components/pay-rule-editor.tsx:335-341`;
  - `core/report-ai.ts:89-97`;
  - `core/assistant.ts:227-242`.
- **Do:**
  1. Frame record text as untrusted data, and add output adjudication to the performance draft. Follow the
     pattern in `packs/performance/onehr/ai.ts:33-81`.
  2. Add the same untrusted-data framing to claims triage.
  3. Pay-rule draft: make the preview against a sample mandatory before Save, add explicit numeric bounds, and
     report "not authorised" correctly instead of `invalid_output`.
  4. Report designer: add the core authority check plus `withAiAdmissionCheck`.
  5. Assistant budget: use the HR date owner's Malaysia day and an atomic reservation.
- **Evidence:** adversarial cases (instructions in record text, out-of-range pay parameters, a non-admin
  caller) refuse or neutralise.

### WP6 — One switch owner per AI feature (R10). Medium. Migration.

- **Start at:**
  - `lib/ai/features.ts:8-16`;
  - the SQL CASE in `db/migrations/0621_ai_action_controls.sql:18-22` (and its 0541/0568 ancestors);
  - `core/ai-management.ts:82,173-191`;
  - `packs/performance/onehr/ai-settings.ts:52-56`, `packs/performance/onehr/ai.ts:39`.
- **Do:**
  1. Replace the hard-coded CASE with a settings→feature table read by `_ai_control_context`. Add
     `feedback_planning`, which the SQL copy omits.
  2. Forbid, or visibly show, `feature:` policy rows for setting-backed features.
  3. Fold the OneHR per-field quota into an `ai_admit` allowance.
  4. Correct the "every catalogued default is false" comments, or flip the performance defaults, per owner
     decision 3.
- **Evidence:** a parity test that every `AI_FEATURES` setting appears in the SQL table; a populated-baseline
  migration rehearsal.

### WP7 — One action registry (R3). Medium. Migration.

- **Depends on:** `ai-wave1b` merged; it adds four kinds the current way.
- **Start at:**
  - `lib/ai/module-agent-actions.ts:30,33,145,152-172`;
  - `lib/ai/module-native-outcomes.ts:7-31`;
  - `lib/ai/module-human-handoffs.ts:6-30`;
  - `lib/ai/agent-capability-inventory.ts:31-40`;
  - `core/assistant-actions/completed-outcome-readers.ts:40`;
  - `core/assistant-actions/module-action-server.ts:140-169`;
  - the `action_kind` lists in migrations 0622/0650/0655/0657/0670/0671.
- **Do:**
  1. Write one `defineAgentAction({...})` per entry: id, module, owning service, screen, input schema,
     human-supplied inputs, permission mirror, subjects, blast-radius cap, idempotency key, tier ceiling,
     reversibility, outcome semantics, evaluation cases and handoff route.
  2. Derive every TypeScript list from it.
  3. Add `app.assistant_action_kind` (a reference table with grants) and an FK from the store. Leave the old
     CHECK constraints byte-identical in applied files; drop them in the new migration only after the FK is
     validated.
  4. A test asserts registry = DB rows = inventory = tier ceilings.
- **Done when:** adding a new action means one registry entry plus one `INSERT` row.

### WP8 — Generic parity harness (R16). Medium.

- **Depends on:** WP7.
- **Do:** run a fixture matrix driven by the registry, for every entry. Roles: employee, manager, assigned
  approver, company HR, group HR, payroll partner, performance partners, another company, another tenant. Each
  role must get the same allow/deny on the agent offer, prepare and confirm paths as the owning screen's
  service.
- **Done when:** the harness runs in the gate, and a new entry without matrix fixtures fails CI.

### WP9 — Collapse prepared-action stores (R4). Large, incremental: one store per PR.

- **Depends on:** WP7. Use the `ai-wave1b` generic own and assigned families as the target.
- **Start at:** `core/assistant-actions/claim-cancellation-review-store.ts` (a hand clone of the generic store;
  do it first), then the 12 dedicated `*-review-store.ts` files, `module-action-review-store.ts` and
  `own-leave-store.ts`.
- **Do:**
  1. Move each kind to the generic families, keeping its existing rows readable.
  2. Add `withAgentActionGuard(tx, ctx, actionId)`, which composes principal, grant, module and pause from the
     registry entry.
  3. Make `core/assistant-actions/own-leave-actor.ts:19-41` reuse `isAiPrincipalCurrentTx` instead of copying
     its SQL.
- **Evidence per store:**
  - digest-bound confirmation;
  - refusal when the source is stale or changed;
  - replay and concurrency;
  - reconciliation of an uncertain commit;
  - WP8 parity;
  - existing in-flight rows still complete after deploy (rehearse on a populated baseline).

### WP10 — Chat catalogue derived from the registry (R6). Medium.

- **Depends on:** WP7 and the `ai-wave1b` in-chat cards.
- **Start at:** `core/assistant-tools.ts:980-1018`, `core/assistant.ts:33,402,415`,
  `lib/ai/grounded-tool-presentation.ts`.
- **Do:**
  1. Offer action proposals from registry entries, filtered per caller.
  2. Keep confirmation a separate same-origin human command bound to the digest.
  3. Correct the "stable per (tenant, role)" and "nine tools" comments.
  4. Keep the prompt-prefix caching order rule.
- **Evidence:**
  - rendered chat cards: confirm, discard, stale and failure states, in six locales, desktop and mobile;
  - an injection holdout showing record text cannot add an entry.

### WP11 — Make the learning loop real (R5, S8). Medium.

- **Start at:**
  - `core/module-agent-releases.ts` (lines 62, 236, 252, 939, 1153);
  - `core/module-agent-evaluation-harness.ts:51`, `lib/ai/paired-evaluation.ts:12`;
  - `scripts/ai-agent-source-manifest.mjs:9-13`;
  - the holdout files in `lib/ai/*-holdouts.ts`.
- **Do:**
  1. Delete the routing candidate kind, `lib/ai/module-agent-improvement.ts` and `core/module-agent-orchestrator.ts`
     (test-only), and update their tests.
  2. Promotion scope: the approver chooses user, company or tenant.
  3. Require the promoter to differ from every evaluator.
  4. Scope the source manifest to AI-relevant files.
  5. Schedule `maintainModuleAgentReleases`.
  6. Roll back on measured outcome regression (from PR #34 data).
  7. Extend holdouts to all 12 tools and to every registry entry: injection in record text, cross-company,
     cross-tenant, salary leakage, missing permission, and ambiguity that must produce a question.
- **Done when:**
  - a candidate is refused without two independent evaluations;
  - a tenant-scoped promotion affects another user;
  - a measured regression rolls it back;
  - all of this is shown in tests.

### WP12 — One AI inventory screen, alerts and data register (R8, R20, R21). Medium.

- **Start at:** `app/control-tower/agents/*`, `core/ai-management.ts`, `lib/ai/features.ts`,
  `agentCapabilityCoverage()`, `core/job-run.ts:63-72`, `deploy/cron-alert.sh`.
- **Do:**
  1. One table listing every component: chat, read bindings, specialists, each action with its tier, scheduled
     jobs, embedded features, orchestrator steps, and the operator improve loop marked out-of-band. Each row
     shows its switch, allowance, pause key, last run, 30-day cost, outcome rates (from PR #34) and
     `ai-control.*` audit events.
  2. A per-action pause key under the `hr_assistant` pause.
  3. Run history with paging and a date range.
  4. Alerts for failure rate, principal refusals, spend near cap and configured-vs-effective switch drift.
  5. A per-feature data register: which fields leave the tenant, after which redaction.
- **Access:** group admin only, per ADR-0151 §4.7; company HR gets the read-only registry/tier view.

### WP13 — First Automatic-tier entries (R18). Medium.

- **Blocked on:** owner decision 1 (order); the agent principal merged; WP2.
- **Start at:** `core/leave-escalation.ts`, `core/hr-orchestrator.ts`, ADR-0151 §4.5.
- **Do:** deterministic chasers and reminders only, under the principal: overdue approvers on claims,
  attendance and replacement leave; probation and contract end; missing clock-in; expiring documents;
  lifecycle steps. Each is a registry entry with tier `automatic`, caps, cooldown and outcome semantics, and
  each is measured in PR #34's outcome view.

### WP14 — Model and provider change gate (R19). Medium.

- **Do:**
  1. On a provider or model change (tenant config or `AI_DRAFT_MODEL`), run the baseline holdout suites and show
     pass/fail in AI management before the new config becomes active.
  2. Allow per-feature caps (new migration; feature rows currently must have null caps, 0541:8 and 0662:17).

### WP15 — Retention, threat model, naming and docs (R12, R13, R14). Small.

- **Retention:** query staging through the operator path (`deploy/OPERATOR-ACCESS.md`) to confirm that
  `aihr-ai-retention.timer` is installed and running. If it is not, the release owner installs it. Document it
  in `deploy/DEPLOY.md`.
- **Threat model:** write `docs/architecture/ai-threat-model.md`. Cover leakage, injection, cross-tenant access,
  unauthorized action, spend abuse, the agent principal and provider data handling.
- **Naming:** apply after owner decision 4. Fix every stale comment listed in review §9. Amend ADR-0082 and
  ADR-0151 (vocabulary, action count, harness facts).

## 6. Evidence expected for every code PR (ADR-0151 §7)

| Outcome | Evidence |
|---|---|
| Parity | Role matrix against the same fixtures as the screen (WP8, once it exists) |
| Confirmation integrity | Digest-bound confirm; stale-source refusal; replay and concurrency; uncertain-commit reconciliation |
| Injection and leakage | Adversarial holdouts pass with zero failures; cross-company and cross-tenant refused |
| Inventory | Drift guard fails on an unclassified mutating entry point |
| Experience | Rendered screens in six locales, desktop and mobile, for any UI change |
| Release | The impact-selected `scripts/gate.sh` run on the exact head; preserve failures and rerun per policy; never relabel evidence onto another commit |

## 7. Owner decisions to obtain (do not assume)

These are listed in review §7.2:

1. The order of the Automatic-tier reminders and chasers.
2. Whether the agent principal gets model spend.
3. Whether the performance AI switches stay on by default.
4. User-facing naming.
5. Bulk manager decisions.

Packages blocked on a decision say so above.

**Resolved 29 Oct 2026.** The owner answered all five in chat: (1) order (a) overdue-approver chasers, (b) probation/contract-end reminders, (c) missing clock-in nudges, (d) expiring documents, (e) lifecycle step chasing, all deterministic; (2) no model spend for the scheduled agent principal; (3) performance AI switches default off; (4) naming as already approved; (5) bulk manager decisions approved in principle, to be designed as its own package outside WP6–WP14. Recorded in [ADR-0151, Owner decisions — 29 October 2026](../adr/0151-orchestrator-action-layer-and-system-learning.md#owner-decisions--29-october-2026).

## 8. Prompt for the implementing agent

Copy the block below.

```text
You are implementing the October 2026 AI architecture review in the ai-hr repository.

Read, in order:
1. CLAUDE.md (canonical; AGENTS.md routes there). Follow "Start every session" exactly: verify the checkout,
   fetch origin/main and origin/alpha, report ahead/behind, choose the integration base per
   docs/REPOSITORY-AND-ENVIRONMENTS.md, and preserve any WIP.
2. docs/reviews/ai-architecture-handoff-2026-10.md (this plan) and docs/reviews/ai-architecture-review-2026-10.md
   (the findings with file:line evidence).
3. docs/adr/0151-orchestrator-action-layer-and-system-learning.md, then ADR-0116, 0084, 0131 §1-4 and 0082 §2.

Then:
- Re-verify every finding you act on against current source. The review was written at 82f7c6570; later
  merges (PR #34 outcome measurement, ai-wave1b, ai-hr-admin-agent) may have changed lines or fixed items.
  Record what you verified, what was already fixed, and what remains.
- Work through the work packages in section 5 in order, one package per PR. Skip any package marked blocked
  on an owner decision or on unmerged work, and say why.
- Before any migration: re-read the alpha journal and the live watermark, claim the next free number, and
  use a journal `when` strictly above all existing entries. Append only; never edit applied SQL.
- Keep the non-negotiables in section 1: the model proposes and a person confirms; parity, never more
  authority; pay/approvals/access/terminations never Automatic; tenant and company isolation; no training
  on tenant data.
- Verify with focused behaviour checks during development, then `bash scripts/gate.sh` on the frozen
  candidate. Give the evidence listed in section 6. Do not claim PASS without the receipt for that exact
  commit.
- Do not deploy to production. Deploy to staging only if the owner has authorised it for you, through the
  normal operator path and the staging-window protocol.
- Ask the owner, in one short question, before starting any package that depends on a decision in
  section 7.

For each PR, report: the package and recommendations covered, the commit SHA, the files changed, the
evidence (test names, gate result, screenshots), what you did not verify, and the next package.
```
