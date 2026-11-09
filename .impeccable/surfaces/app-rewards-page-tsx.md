---
version: 1
slug: "app-rewards-page-tsx"
primary_target: "app/rewards/page.tsx"
related_targets: ["app/rewards/dashboard.tsx","app/rewards/[unitId]/setup/page.tsx","app/admin/pay-components/company-applicability.tsx","components/sidebar.tsx"]
---

# Approved Rewards and Payroll board extensions

Scope: feedback ab44b4a2, 41df93f3, a24cb308 and a99800d1, each approved at plan revision 1 on 8 November 2026. Visitor mode: Operate. This is an extension of the existing authenticated HR workspace. Company administrators configure Pay Item availability; assigned Rewards reviewers inspect their own scope; Group Rewards prepares and a different person releases a review. Attendance definitions and the Maybank hashing arrangement remain separate board questions.

## Direction contract

THESIS: Keep scope and readiness visible at the point of action. The dashboard names the next review, while sensitive preparation stays with its authorized owner.
OWN-WORLD: Incumbent shared components and theme tokens: Atelier white surfaces, neutral borders and orange actions; retain Classic and Monolith compatibility. Existing typography, cards, selectors, buttons and status labels; no global visual-system change.
STORY: Choose a permitted scope, read separate salary and one-off bonus budgets, open work waiting on the viewer, then review or prepare the named unit. A disabled release names the exact unfinished step. A pending reviewer sees an expected-date notice without figures.
FIRST VIEWPORT: Dashboard greeting and scope/period controls above three parallel salary, bonus and waiting tiles. Unit set-up opens with company/unit context, Review/Unit set-up tabs and six numbered checks. Pay Items use an All/Selected company control. Navigation retains its queues under My Action Centre.
FORM: Code-led extension pinned by the four owner-approved board previews at revision 1; familiar operational forms and lists with scope-preserving links as the signature interaction. No concept roll was run: the local-extension rule in new-work.md preserves the approved composition. No seed reference was produced. seed: none (unavailable)
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Quality bar and boundaries

Judge as a working HR product: clear hierarchy, correct scope, usable native controls, restrained density, no viewport overflow, keyboard labels, six languages and explicit empty/restricted states. The approved previews pin the information architecture; fictional sketch amounts never become business facts. Native financial owners and current permissions govern all figures and actions. Screenshot fixtures demonstrate rendered components, not an authenticated installation journey. No raster assets ship. Preserve DESIGN.md and its sidecar for this ordinary extension; report pre-existing drift without redesigning it.
