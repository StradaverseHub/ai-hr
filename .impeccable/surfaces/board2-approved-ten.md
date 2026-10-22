---
version: 1
slug: "board2-approved-ten"
primary_target: "app/attendance/my-roster/page.tsx"
related_targets: ["app/attendance/page.tsx", "app/attendance/application-history/page.tsx", "app/admin/personnel/[employmentId]/page.tsx", "app/me/payslip/page.tsx", "app/me/tax-relief/page.tsx", "app/me/tp3/page.tsx", "app/me/ea/page.tsx"]
---

# Approved Attendance and personal Payroll extensions

The owner approved the ten board plans and their current-revision static previews on 22 October 2026. Those plans pin the interaction and composition; this extends the existing Atelier world. Visitor mode: Operate. HR reviews attendance; employees review only their own calendar, requests and released payroll documents or submit their own declarations.

## Direction contract

THESIS: Preserve context from selection through review and back. Remove redundant Personnel/Overview sections and give each calendar, request and personal payroll task a clear existing owner.
OWN-WORLD: Existing Atelier white surfaces, neutral foreground and borders, orange primary actions, semantic status labels, system UI typography and the shared 12px cards/standard controls. No new global theme or shell direction.
STORY: Select the permitted subject or period, inspect recorded evidence, act only where authorised, and return without losing filters. Unavailable evidence stays explicit.
FIRST VIEWPORT: Existing authenticated shell; page heading, identity/period context and primary control. Calendar/List tabs or scoped collapsible employee list sit above the relevant records. Personal Payroll never offers another employee's selector.
FORM: Owner-approved board previews for revisions 1c44b94c r2,797ba70b r3,1230d075 r2,e84ccdfd r2,39306a9e r2,54f33b59 r2 and four Payroll r1 plans. Code-led extension of incumbent surfaces; no concept roll required for the precisely approved layouts. seed: none (owner-pinned)
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Boundaries

No global system change. Keep existing DESIGN artifacts; report pre-existing missing/drifted files instead of repairing them. Screenshots and approval references belong in the review packet, not browser-delivered code. Calculations, historical records, company/tenant boundaries and release controls retain their canonical owners. Exact acceptance and verification derive from each approved board plan, not from this design contract.
