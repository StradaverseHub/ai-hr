# Probation Confirmation reshape and shared HR automation builders

Status: accepted direction (owner decisions 15 Nov 2026); source implementation in slices on
`claude/probation-confirmation-aihr-b81c70`. Nothing installed. Production and staging untouched.
Inputs: the Probation Confirmation build handoff and prototype (owned by GBS People Ops), and the owner's private
merge mockups (one screen per prototype page). Refines `probation-module-configuration-and-mapping.md`,
ADR-0053 (legacy review), ADR-0095 (Lifecycle), ADR-0135 (access), ADR-0166 (movement types) and ADR-0172 (signing).

## Context

The handoff describes Probation Confirmation as if new. AI-HR already runs it (`app/lifecycle/probation`,
`packs/probation`, migration 0949 and later): cases, parts 1-3, scoring, signing routes, letters, intake and per-company
cut-over. The prototype changes how it is configured and moves configuration into builders shared with On/Off
Boarding and Contract staff.

Today there are three workflow engines with three schemas, sharing only presentation
(`app/lifecycle/workflow-editor-shell.tsx`: "each module owns schema, permissions, saves and execution"):

- On/Off Boarding V9 (`lib/lifecycle-v9-model.ts`, one JSON config per tenant in `lc_v9_config`, module `onb | off`).
- Contract staff (`lib/contract-management-workflow.ts`, zod schema, own rows).
- Probation (`lib/probation-workflow.ts`, notify-only steps, own rows, per company).

Email templates exist only in V9. Assignment groups and the PBP rule live in the V9 config and are already read by
Probation and Contracts (ADR-0172).

## Decisions (owner, 15 Nov 2026)

1. **Shared builders get their own menu section** (working label "HR Automation": Workflows, Templates, Assignment
   groups), not under On/Off Boarding. Overrides handoff §1. Old builder URLs redirect with the module filter preset.
2. **One shared automation engine with per-module catalogues.** Each module registers its triggers, condition fields
   and values, step types, recipient roles and merge fields; the engine owns the definition envelope, condition
   evaluation (multi-value, step-level), recipient resolution, dry run, Live/Paused and frozen run copies.
   Probation moves first. On/Off Boarding and Contract staff definitions are not rewritten in this build; they move
   later behind adapters. Every capability any engine supports today is a floor that the shared engine keeps
   (`test/automation-floor-inventory.test.ts`).
3. **Probation settings scope is configurable, with field-level overrides.** One group standard sets every field for
   all companies. A company setting for selected companies overrides only the fields it ticks and inherits the rest,
   including later standard changes. A company belongs to at most one company setting. A case pins the resolved
   values (standard version + override version) when it starts. Overrides handoff B6 ("no per-company configuration").
4. **Personnel postings are approved only by the posting-approver group** (Approve, or Save event on the movement
   page). Anyone who can record movements may correct a posting; the correction stays on the posting as
   "Edited, waiting for approval". Only approval writes the movement. Overrides handoff A4.
5. **Legacy `employment_review` probation reviews retire once every company is live** on the new module. Until then
   the per-employee handover (`app.probation_owns_legacy`) stays. Contract and internship reviews and review history
   are kept. The AI probation loop's open-review action is removed for probation; its Today card points to the case.
6. **A probation case opens at activation** (draft completed into an employment), before the start date, shown
   "Waiting for start date", with no tasks or reminders until the start date. A withdrawn hire closes the case as
   "Did not join". Today's sweep admits only join dates up to today; this changes it. Eligibility stays as today.
7. **Delegation extends the general delegation** (`lib/delegation-scope.ts`) with a Probation module. Existing
   whole-scope delegations do not include it. Only Review, Approve and letter Sign steps (HOD, PBP, GBS) are
   delegable; Line Manager and employee steps are not. `probation_delegate` stays for per-case fixes.

Kept from AI-HR although the prototype omits them: the reviewed activation flow (rehearsal digest, installation
reference, single transaction) and the duplicate-role signing policy.

## Build order

0. Floor inventory test (this slice).
1. Shared automation core: envelope, catalogue registry, conditions, recipients, dry run, Live/Paused, frozen runs.
2. Shared assignment groups and named routings (adapter over V9 groups and `bpRules`; Job title; named people).
3. Shared templates: email module value; document routing per version (Review, Approve, Sign; owner; send-back;
   lock after first signature; visibility; preview).
4. Probation on the shared engine: new triggers and steps, generate-then-pause, postings, start offboarding.
5. Probation module: settings scope (decision 3), form approval routing, access roles and Direct Superiors rule,
   tracker additions, declined signature, override flag, intake extensions, case at activation (decision 6).
6. Personnel postings and Save event (decision 4).
After every company is live: decision 5. Later: On/Off Boarding and Contract staff onto the shared engine.

Each slice follows `docs/architecture/FUTURE-BUILD-CONTRACT.md` and `docs/SCALE-AND-RELEASE-RULES.md`, registers its
module in `docs/architecture/module-contracts.json`, and allocates migrations through `docs/MIGRATION-ALLOCATION.md`.

## Consequences

Four handoff rules are overridden (decisions 1, 3, 4 and 7's restriction of delegable steps); the handoff owner must
be told before a build agent follows the handoff as written. A shared engine means one regression can stop
onboarding emails, so every shared change runs the regression suites of all modules that use it.
