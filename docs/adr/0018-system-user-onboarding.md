# ADR-0018 — System-user onboarding (first-login product tour)

Status: **Accepted** · Date: 2026-06-14

## Context

When someone logs into AI HR for the first time, they face a full product with no orientation. We want
a **guided product tour**: step-by-step coachmark bubbles that spotlight parts of the UI and explain
them, shown once on first login and replayable on demand. This is the **system user's** onboarding
(learning the app) — explicitly *not* employee onboarding (a new hire joining the company, which is the
HR process the People/Org modules already model).

The deep reference content lives in the Knowledge Base (ADR-0017); the tour is the lightweight, in-place
"what is this and where do I go" layer that points people at it.

## Decision

### 1. Completion state on `app_user`, written through a SECURITY DEFINER seam

A nullable `app_user.onboarded_at timestamptz` records whether a user has finished or dismissed the tour
(`NULL` = not yet). Reads/writes go through SECURITY DEFINER functions in the `app` schema (the same
seam as `app.principal`, ADR-0004) rather than a broad RLS UPDATE policy on `app_user` — that keeps the
write **column-safe** (a user can only touch their own `onboarded_at`, never `person_id`/`workos_user_id`):

- `app.onboarding_status()` → boolean, for the current user (`app.current_user_id()`).
- `app.onboarding_complete()` → sets `onboarded_at = now()` for the current user (idempotent).
- `app.onboarding_reset()` → clears it (dev/QA replay).

`core/onboarding.ts` wraps these. Completion is **UI-preference state**, so it does *not* append a domain
event (documented skip, per the substrate carve-out for derived/UI writes).

### 2. A declarative, role-aware step registry anchored by `data-tour`

Tour steps live in `lib/onboarding-tour.ts` as data: each step has a `target` (a `data-tour="<id>"`
attribute on a real UI element, or `null` for a centered welcome/finish card), an i18n `titleKey` /
`bodyKey`, a `placement`, and an optional `roles` filter. Anchors are added to the sidebar nav items and
the topbar controls. The server filters steps to the caller's roles (an employee never sees the "Admin
setup" step) and passes the resolved list to the client — so the tour adapts: an HR admin gets the
setup-focused tour, a manager gets approvals, an employee gets the self-service basics.

### 3. A self-contained spotlight component (no library)

`components/onboarding-tour.tsx` (client) renders the tour with the design system, no third-party tour
dependency:

- **Spotlight** via the box-shadow trick — a transparent, rounded box positioned over the target with a
  huge spread `box-shadow` in the scrim colour dims everything *except* the target. Centered steps use a
  plain dimmed backdrop.
- **Bubble** positioned beside the target (placement-aware, flips to stay on-screen) with title, body,
  a step counter, and Back / Next / Skip / Done. Motion is ease-out and subtle (respects
  `prefers-reduced-motion`); the spotlight transitions smoothly between steps.
- Recomputes on scroll/resize and scrolls the next target into view.
- Finishing or skipping calls the completion action and the tour disappears for good.

### 4. Trigger + replay

The layout renders the tour for a signed-in user whose `onboarded_at` is `NULL` (first login). A topbar
**help (?)** control re-launches it any time via a custom `aihr:start-tour` DOM event the tour listens
for — no global state library, no query-param round-trip. The component is always mounted (cheap when
idle) so the launcher works from any page.

## Update (2026-06-14) — per-guide interactive walkthroughs

The single welcome tour was generalized into a **named-tour registry** so each Knowledge Base guide can
launch an interactive, in-product walkthrough of its module:

- `TOURS` keyed by id (`welcome` + one per module: `me`, `leave`, `attendance`, `payroll`, `people`,
  `performance`, `approvals`, `org`, `admin`). `START_TOUR_EVENT` now carries a `tourId`. A guide view
  renders a **Start walkthrough** button (`components/guide-tour-button.tsx`) that dispatches it;
  `guideTourId(slug)` maps each seeded guide to its tour.
- Steps gained an optional **`route`** — the tour navigates there before showing the step, so a
  walkthrough can cross pages (e.g. the leave tour spotlights `/leave`, then the admin step jumps to
  `/admin/leave`). Because the tour lives in the layout, its state survives the navigation. The measure
  step **retries** until the anchor appears (handles async render after a route change), falling back to
  a centered card if an element never shows.
- Module tours are generated data: a workflow added `data-tour` anchors to the real pages and authored
  the steps; `scripts/merge-guide-tours.mjs` wrote `lib/module-tours.json` + the `onboarding.tour.*`
  i18n keys (translated into all 6 languages). Adding a tour is data + anchors, no engine change.

Verified: launching the leave guide's walkthrough navigates `/knowledge-base/… → /leave` and spotlights
the real Balances card (step 2/5), role-filtered (admin-only `/admin/leave` step), no console errors.

## Consequences

- New users get oriented in seconds and are pointed at the Knowledge Base for depth; the tour is one
  more reason the product doesn't feel like a blank slate on day one.
- The step registry is data, so adding/relabelling steps (or anchoring new modules) is a one-line change
  plus a `data-tour` attribute — no component changes.
- `onboarded_at` is per-user UI state; it carries no audit weight and is intentionally event-free.
- When WorkOS auth lands, nothing changes here: `app.current_user_id()` already abstracts "who is this".

## Alternatives considered

- **A tour library (driver.js / intro.js / shepherd)** — extra dependency, its own DOM/styling to fight,
  and theming to match the design system anyway. A ~150-line component gives full control and on-brand
  craft.
- **localStorage for completion** — not durable across devices and invisible to the backend. A column is
  the right home for a per-user product state.
- **A broad RLS UPDATE policy on `app_user`** — would let a user write any column of their own row. The
  SECURITY DEFINER function restricts the write to exactly `onboarded_at`.
- **A separate `user_onboarding` table** — overkill for one nullable timestamp; revisit if we add
  multiple independent tours with per-tour completion.

## Update (2026-10-12) — walkthrough coverage for refreshed guides

Every bundled tenant and operator guide now maps to a runnable walkthrough. New steps cover the
attendance-calculation guide and claims/loans, lifecycle, rewards, AI/reporting, mobile design,
communications and operator responsibilities. A catalog-wide guard pins mappings, audience-role
coverage, real routes/anchors and operator isolation. Operator launch buttons are rendered inside
the existing guarded console; its tours require the operator role and remain on that route.

The new explanatory text is explicitly English, matching the reviewed guide bodies. `TourStep`
accepts either the existing translation keys or `{ text: { title, body, lang: 'en' } }`; the coachmark
marks inline copy with its language while navigation controls remain localized. This is an honest
intermediate publication state, not a claim of translated content. Reviewed localized copy can move
back to the existing translation-key representation. Walkthroughs explain real controls and navigate;
they never submit the business actions they describe.
