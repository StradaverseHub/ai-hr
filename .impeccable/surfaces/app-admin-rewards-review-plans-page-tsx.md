---
version: 1
slug: "app-admin-rewards-review-plans-page-tsx"
primary_target: "app/admin/rewards/review-plans/page.tsx"
related_targets: ["app/admin/rewards/review-plans/editor.tsx","app/admin/rewards/review-plans/new-year.tsx","app/admin/rewards/review-before-saving.tsx","app/admin/rewards/earlier-plans/page.tsx"]
---

# Review Plans — approved board extension 0c0d8710

Mode: Operate. This surface implements approved item `0c0d8710-d271-4def-90ea-7556e131b50e`, plan revision 1, “Rename Shared Rewards Configuration to Review Plans; creating a reward year creates a draft plan for each company.” It is an ordinary extension of the existing Rewards and PAT Inputs configuration workspace, preserving the incumbent system in DESIGN.md. The older Rewards dashboard brief is context for the surrounding product, not this grid's direction authority.

## Direction contract

THESIS: Keep company coverage, authority and readiness visible while accountable editors make annual choices in one place.

OWN-WORLD: Retain shared operational PageHeader, Field, Button, table and native dialog components. Atelier uses white surfaces, neutral boundaries and orange actions; Classic and Monolith remain supported. Suggestion highlighting and edited/read-only labels express actual state, with no decorative motion or global theme changes.

STORY: Open the reward year, check the company population and gaps, accept or change each company's plan type and library choices, review the comparison, then save and create authorized Ready reviews in the background. Earlier configurations remain read-only. A new year copies editable dates; a missing year offers a clear creation path.

FIRST VIEWPORT: Review Plans title and purpose, reward-year controls, compact filters and the coverage line lead into the company grid. Bulk controls belong to that grid. Company and Business Unit identify each row; plan type, salary structure, bonus matrix, headcount, PAT and status share a consistent ordered table. Narrow screens preserve horizontal table scrolling, complete native choice labels and visible read-only guidance. Save controls must not cover mobile fields.

FORM: A code-led, precisely specified extension governed by the approved board plan and the existing PAT Inputs editor. No visual-world selection, concept tournament, random roll or seed command was run: the incumbent-extension path in Impeccable new-work preserves the established world and the owner's specified grid. Seed status is **not applicable to this extension**; there is no generated or unavailable seed to imply. The board had no submitted attachments or approved image comp. `docs/mockups/0c0d8710-review-plans.html` is an explanatory fictional sketch, not an approved pixel target.

FINISH: Use bounded desktop and mobile source-component captures plus scoped interaction assertions. Record the exact candidate/run and reviewer disposition. Source rendering with mocked service capabilities establishes presentation and interactions only; native principal checks, database state transitions, installed arrival and human acceptance remain separate.

## Five surface promises

1. One year-wide, authorized company population with matching coverage counts and Business Unit facets.
2. Choices and suggestions stay visibly staged until a server-reviewed comparison saves them; plan-type labels remain readable.
3. Group Rewards, CTRO and HR Admin edit only within authority; EC's read-only state is visible before and inside the wide grid.
4. Errors retain entered values, exclusion reasons explain their ten-character minimum, and a stale comparison can be explicitly regenerated from current source revisions before saving.
5. New-year dates and background review creation expose honest empty, pending, saved, failed and completed outcomes, without treating a preview or job admission as installation acceptance.

## QUALITY BAR

A working HR operations page: compact 13 px table content, sentence-case controls, clear company scope, semantic suggestion washes, tabular counts, native keyboard interaction, explicit permission and recovery guidance, no page overflow and no obscured mobile controls. Reuse the incumbent component vocabulary; express missing information plainly. Six UI catalogues cover new labels and notices. No shipping raster assets or new visual-system tokens are introduced.

## Evidence boundaries

The hosted fixture `test/rewards-review-plans-rendered.dom.test.tsx` renders the actual page, grid and new-year components with fictional companies and mocked Group Rewards/EC/company-scoped-HR projections. Keyboard and edit/recovery assertions run in jsdom. Chrome captures the serialized source DOM with application CSS and restores the native modal top layer for open confirmations. These fixtures do not authenticate a principal against an installation or establish database authorization, payroll correctness, migration execution or release acceptance.
