# UI/UX Enhancement Plan

A planning doc for raising the interface from "functional and clean" to "polished product."
It runs as a **parallel track** to the localization slices — interleaved, never blocking the
payroll critical path.

## Honest current-state audit

**What's good:** consistent dark-default + light theme, indigo accent, sidebar + topbar shell,
single-page modules, card/table layout, status + role badges, server-action forms wired to the
real services.

**What's rough / missing:**

- **Feedback & states** — no pending/loading indicator on submit (every action is a full
  redirect), no success confirmation, errors surface only as a top-of-page banner (no
  field-level validation), no confirmation step before destructive actions (terminate, revoke).
- **Lists** — no search, filter, sort, or pagination. The requirements spec actually
  *specifies* filter + sort criteria per entity (Department/Type/Status, etc.) — unimplemented.
- **Navigation / IA** — `/` just redirects to People; no **dashboard/home**, no breadcrumbs, and
  **no mobile navigation** (the sidebar is simply hidden below `sm`).
- **Inputs** — native selects/date inputs; no currency formatting, no input masks (IC, bank).
- **Design system** — components are ad-hoc Tailwind strings; no shared primitives, no
  semantic tokens (success/warning/danger), no empty-state or skeleton treatments.
- **Accessibility** — not audited (focus management, keyboard nav, ARIA, contrast).
- **Responsiveness** — desktop-first; tablet/mobile untested.

## Principles

- **Restrained, editorial, geometric** — clean and minimal over ornamental; generous
  whitespace, strong type hierarchy, restrained colour. (Matches the founder's stated taste.)
- **Fast feedback** — every action shows pending → result; optimistic where safe.
- **Accessible by default** — keyboard + screen-reader usable; WCAG AA contrast.
- **One system** — shared primitives, semantic tokens, consistent spacing/typography scale.
- **Responsive** — works on phone, tablet, desktop.

## Enhancement themes (prioritized)

**A — Feedback & interaction (highest impact, low cost)**
- Pending states via React 19 `useActionState` / `useFormStatus` on server-action forms.
- Toasts for success/error (replace redirect-banner round-trips).
- Inline, field-level validation (IC format, salary > 0, date ranges).
- Confirmation dialogs for destructive actions (terminate, revoke role, end reporting line).

**B — Lists & data**
- Search + filter + sort + pagination on People (and the spec'd filters on every list).
- URL-driven state (shareable, server-rendered).
- Column-level display per the spec's "List display requirements."

**C — Navigation & IA**
- A **Dashboard** home: headcount, who's on leave today, pending approvals, upcoming holidays.
- Mobile nav (top bar + drawer); breadcrumbs on detail pages.

**D — Design system**
- Shared primitives: Button, Input, Select, Dialog, Toast, Table, Card, Badge, Tabs, Tooltip.
- Semantic colour tokens + spacing/type scale; empty states + skeletons.

**E — Accessibility** — focus rings, keyboard nav, ARIA labels, contrast pass, reduced-motion.

**F — HR-specific polish** — avatars/initials, a real visual org chart, status timelines on the
detail page, a proper payslip layout (lands with Slice 4), holiday calendar view.

**G — Responsiveness** — audit every page at sm/md/lg; fix tables (horizontal scroll/cards).

## Key decisions (recommended)

1. **Component foundation → adopt [shadcn/ui](https://ui.shadcn.com)** (Radix primitives +
   Tailwind, copy-in — *not* a heavy runtime dependency). It gives accessible Dialog, Select,
   Dropdown, Toast, Tabs, etc. out of the box, matches our stack, and we own the code. Bespoke
   stays where it's trivial. *Trade-off:* a one-time refactor of current ad-hoc components.
2. **Forms** → React 19 server actions + `useActionState` for pending/validation/errors; **Zod**
   (already a dependency) for shared client+server schemas. No heavy form library yet.
3. **Toasts** → Sonner (tiny, accessible).
4. **Charts** (dashboard/org chart) → defer; pick a lightweight option (e.g. visx/Recharts) when
   the dashboard lands.

## Recommended sequencing

- **Quick wins now** (a polish pass, ~1 slice): Theme A (pending states, toasts, confirm
  dialogs, inline validation) + People search/filter (Theme B) + mobile nav (Theme C). High
  perceived-quality jump, low cost.
- **Design-system slice** (Theme D): introduce shadcn/ui + refactor primitives — do this *once*,
  early enough that later modules build on it, but it can follow the quick-wins pass.
- **Dashboard** (Theme C/F): after Attendance (Slice 3) gives it data worth showing.
- **A11y + responsive audit** (Themes E/G): continuous, with a dedicated pass before any launch.

> Guard rail: the **payroll engine (Slice 4)** remains the functional critical path. UX work is
> interleaved in small passes, not a big-bang redesign that stalls feature delivery.
