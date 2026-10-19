---
version: 1
slug: "app-layout-tsx"
primary_target: "app/layout.tsx"
related_targets: ["app/page.tsx","app/people/page.tsx","app/assistant/page.tsx","components/sidebar.tsx"]
---

# Assistant-first shell

Scope: the authenticated app shell (sidebar, top bar, assistant dock) and its two reference surfaces, Home and the People list. Visitor mode: Operate. Confirmed by the owner on 2026-10-19 after three direction rounds; reference mocks in `.impeccable/mocks/shell/` (home.html, people.html, shell.css).

## Audience and job
- One shell for employees, managers and HR/payroll admins; what it shows and allows changes with role and entitlement, never the layout.
- Home is the assistant: ask in plain language or drop in a file. The assistant prepares work; a named person confirms it. Lists (People first) keep a docked assistant that knows the current view.
- Success: the user finds what needs them on Home, acts from there, and trusts every figure before confirming.

## Constraints and boundaries
- The assistant never saves anything by itself. Every prepared action shows its effect (counts, before and after, held items) and offers Confirm, Review or Discard. Payroll figures come from the payroll engine only.
- Prepared items depend on the assistant action layer, which is not built yet (AI roadmap round 1). Until it ships, "Needs you" shows real pending approvals and tasks only; nothing is labelled "Prepared" that the assistant did not prepare.
- Six locales, WCAG 2.1 AA in light mode, keyboard operable, reduced motion respected. Dark mode and the mobile layout are open decisions, not part of this brief.
- Standard platform controls only. No new display font; system UI stack.

## Unresolved decisions
- Dark mode palette; phone layout; migration order for the remaining ~320 screens; retirement of the Classic, Monolith and Current themes.

## Direction contract
THESIS: The assistant prepares, a person finishes. The shell refuses the category's chatbot-with-sidebar and its enterprise-admin clutter; it is a quiet Attio/Linear-grade workspace where prepared work is visibly unconfirmed until someone signs it.
OWN-WORLD: Neutral greys at chroma zero (white content, #f8f8f9 sidebar, #e8e8eb hairlines, #1c1c1f ink). Fire orange #c2410c is the only accent: primary buttons, focus ring, selection wash. Semantic pills: green active, amber held or probation, blue leave or starting, red notice. 8px controls, 12px cards, 1px borders, soft two-layer shadow on the ask box only. 16px stroke icons.
STORY: The user arrives, reads what needs them, sees exactly what the assistant prepared and what it would change, confirms or corrects, and leaves with each confirmed item stamped with their mark.
FIRST VIEWPORT: Sidebar 248px (workspace switcher, Quick actions ⌘K plus search, Home/Inbox/Approvals/Tasks, then My HR, Workforce, Payroll, Insights; user at foot). 48px top bar with breadcrumb and company scope. Centred 860px column: greeting with today's pressure line, the ask box with file chip and scope, four suggestion chips, then Needs you with the first item expanded and Confirm as the primary action.
FORM: Category standard executed at Attio/Linear craft (canon, owner-selected after the Hermès steer), carrying the Maker's Mark signature from that round; position: canon. seed:3a2374ea7b8daed1
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
