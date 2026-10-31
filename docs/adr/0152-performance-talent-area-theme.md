# ADR-0152 — Performance & Talent area theme (one scoped palette across app themes)

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- **Date:** 2026-10-29
- **Status:** Owner decision recorded (D-P1-32 D3 "match the source system's look", APR-025; mockup approved). Built on `claude/pt-theme` (package PT-T); not released.
- **Supersedes for this area only:** the app-wide theme choice (Classic, Monolith, Atelier) inside Performance & Talent. Everywhere else the user's theme is unchanged.
- **Related:** ADR-0141, ADR-0142 (the performance partner), DESIGN.md (the sign-in scoped-palette precedent).

## Context

Performance & Talent is migrated from a source system whose users know its look. The owner decided (D3) that the area keeps that look as an AI-HR theme scoped to the area, while AI-HR keeps its own shell, sidebar, icons and identity. AI-HR already themes by CSS variables read at the element (Tailwind v4 `@theme inline`), with Classic on `:root`, Monolith and Atelier under `:root[data-ui-theme]`, structural `monolith:` / `atelier:` variants, and Atelier's unlayered structural rules. The sign-in surface is the precedent for a palette scoped locally that does not follow the app theme.

## Decision

1. **One wrapper.** `app/(app)/performance/layout.tsx` renders every page under `/performance` (employee and administration, DQ-16) inside `<div data-area-theme="performance">`, inside the unchanged `moduleLayout('performance')` guard. A navy band at its top carries the area title (`nav.performanceTalent`, six locales; DQ-14). The cycle and tab strips render per page, so the layout reads nothing else.
2. **One stylesheet,** `app/(app)/performance/area-theme.css`, a module import of `app/(app)/layout.tsx` after `atelier.css` (explicit edge for the deploy cache guard). Three parts:
   - **Tokens (unlayered):** AI-HR's own token names re-declared on the wrapper with the source values (navy `#252A59` primary and band, `#f5f6fa` page, white cards, `#1f2330` ink, `#5f6678` muted, `#e4e7ef` lines, 12px radius, no card shadow, system font stack) plus area roles (`--pt-*`). A navy-tinted dark variant under `.dark [data-area-theme='performance']` keeps the same navy and red; every dark text pair is at least 4.5:1.
   - **Structure (`@layer area-theme`, after Tailwind's layers):** beats utilities, loses to unlayered theme rules. Restyles the shared Card corner, headings, buttons (one solid navy primary, every other filled or outlined button the white outline), AI actions (red with AI-HR's sparkles icon, DQ-3), and density: the source's 34px/30px controls on `(pointer: fine)` only, so 44px targets stay on coarse pointers (DQ-15). Area primitives (`pt-card`, `pt-btn`, `pt-tabs`, `pt-tabline`, `pt-pill`, `pt-rows`, `pt-rail`) for the area's own screens.
   - **Neutralisers (unlayered):** each Atelier or Monolith structural rule that would reach inside the area is mirrored with the wrapper inserted (one attribute more specific) and `revert-layer`, handing the property back to the area layer or the utilities.
3. **Variants exclude the area.** `@custom-variant monolith` and `atelier` gain `:not(:where([data-area-theme], [data-area-theme] *))` — zero specificity, so nothing outside the area changes.
4. **Structural branches.** `<UiThemeArea>` (components/ui-theme-context.tsx) makes `useUiTheme()` return Classic inside the area, so client components render Classic structure there.
5. **No functional change:** no route, permission, data read or write changes; no logo, wordmark or client name.

## Consequences

- The area looks the same in all three app themes and in light and dark; outside it nothing computes differently (the variants' exclusion has zero specificity and every area rule is scoped to the wrapper, pinned by `test/performance-area-theme.test.ts`).
- Portaled overlays (Radix dialogs, menus, popovers, toasts) render under `<body>`, outside the wrapper, and keep the user's theme until a later package portals them into the area.
- The server `Pager` reads the theme cookie, not context, so in Atelier it keeps its compact markup inside the area (styled by the area tokens).
- Two source light values are below 4.5:1 and are kept for fidelity, listed in the test: the faint caption `#8a90a2` on white (3.19:1) and the AE pill `#1a7a54` on `#d7f0e0` (4.41:1).
- Routes outside `app/(app)/performance` that belong to the module (`/me/performance`, the home block on `/`, `/assistant/performance`, `/admin/personnel/[employmentId]/review/[reviewId]`) keep the user's theme.
