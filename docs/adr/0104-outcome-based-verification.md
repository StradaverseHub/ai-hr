# ADR-0104 — Verify requested outcomes before the release gate

- **Date:** 2026-10-13
- **Status:** Accepted — owner requested this guidance after reviewing testing cost and escaped defects.
- **Related:** CLAUDE.md §4 and §8; ADR-0075; ADR-0094.
- **Scope:** Development and review process. The implemented release classifier and receipt checks remain in force.

## Context

Full regression runs have not prevented missing requirements or weak interface design. The
current-workspace-ledger entry in docs/HANDOFF-HISTORY.md records a rollout that changed styling
without implementing the approved workspace and Ledger interactions. Tests written around an
incomplete interpretation can all pass while the requested experience remains incomplete.

ADR-0094 measured a full gate at 28.6 minutes and one presentational affected gate at 55 seconds.
These are historical measurements, not estimates for every change. Database work dominates the
full gate; repeating it does not establish requirement coverage or visual quality.

## Decision

CLAUDE.md §8 is the operational checklist. Acceptance and experience review happen before the
expensive final release gate. Verification has three distinct claims:

| Claim | Evidence |
| --- | --- |
| Requested scope is delivered | Each original requirement mapped to an implemented outcome and a check |
| The experience works and fits the product | Actual journey and visual review with representative data |
| Technical regressions are controlled | Focused development tests and the applicable release gate |

Keep a compact acceptance checklist in the existing task plan or working notes. Each item names
the outcome, affected surface/role, verification method and result. Reconcile against the original
request and attachments, not just the changed files. Explicitly identify omissions and unverified
items. Do not create another permanent status document or require approval for routine review.

For UI work, review a representative screen before extending the design. Judge it against approved
references and product conventions: clear hierarchy and primary action, useful density, specific
language, realistic long content, coherent interactions and relevant responsive states. Generic
cards, repetitive headings, filler copy and decoration need a user purpose. Inspect the rendered
result; snapshots and assertions alone cannot decide whether the design is good.

Walk the changed user journey through its meaningful result. Choose applicable roles, states and
viewports from the requirement and risk; document a material exclusion. Verify persistence by
reopening when applicable and check the resulting record or document where that is the user's
outcome. Use disposable representative fixtures, with enough data to exercise the feature. Broad
visual audits of unrelated screens are not required for a local change.

During development, test the changed behaviour and its consumers, including cross-module contracts
such as attendance feeding payroll. Select tests by dependencies and relevant source-reading guards,
not only filenames. Prefer behaviour assertions and defect regressions over tests that repeat the
implementation. Reuse existing coverage where it establishes the same claim. An escaped defect
should produce a specific correction to acceptance, test selection, journey coverage or design review.

Finish scope and design corrections before the final release gate. Reuse passing development evidence
while its relevant source, dependencies, fixtures and environment remain unchanged. Repeat checks
when a correction affects them; broaden for a named risk or failure. The release still requires a
valid receipt for the exact shipping commit, so changes after gating can require a fresh gate. Never
hand-write a receipt or combine unrelated runs into a claim the gate does not support.

## Gate boundaries and future work

ADR-0094 supersedes ADR-0075's blanket full-suite policy for eligible presentational changes.
Use that existing affected tier whenever its classifier permits. Database batches partition one
full suite to control resource use; they are not repeated passes over the whole suite.

Extending selective release testing to isolated business logic remains future implementation work.
It needs explicit dependency and cross-module coverage, including tests outside the import graph,
plus classifier and release-check changes. This documentation does not claim that capability exists
or authorize bypassing the current classifier. Shared permissions, tenant isolation, payroll
foundations, migrations and configuration continue to receive the full gate under current rules.

For documentation-only edits, review the diff, references and instruction consistency. Do not start
application tests, database rebuilds or deployment solely to save Markdown guidance. A separately
requested release still follows the release workflow.

## Consequences

Completion reports lead with demonstrated requested outcomes and identify gaps; test counts are
supporting evidence. Review effort moves earlier, where omissions and design defects are cheaper
to fix. Required technical coverage remains intact, without adding automatic review rounds or a
large checklist to every small task. Evaluate improvement through escaped defects, missed scope,
rework and verification time, rather than the number of tests added or batches run.
