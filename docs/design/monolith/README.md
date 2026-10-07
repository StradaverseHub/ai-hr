# Monolith — the AIHR design language

Monolith is a quiet instrument with one heavy object. A bone page, ink text, hairlines instead of cards, mono labels for structure, orange only as a mark, and on hub screens one black glossy object under a pool of light that you can orbit with the mouse.

It was designed on the canvas at https://claude.ai/artifact/AJgxP9Z821f876RftyHY4c (the owner's account can open it). Everything here is the transferable form: tokens, the shell, the primitives, the object recipes and a rollout plan. The design boards for every real screen (128 of them) are in that canvas, and a representative set is copied under `reference/`.

Owner decision on record: PRODUCT.md's anti-references (3D, glossy objects, motion) are deliberately overridden for Monolith. What is NOT overridden: "trust the numbers". Figures are flat, static and tabular; status is never colour alone; nothing financial animates.

## 1. Tokens

Drop `tokens.css` into `app/globals.css` (replace the `:root` and `.dark` blocks, add the `@theme inline` lines). Every existing token name is kept, so `components/ui/*` restyles without edits, then gets tuned per §4.

| Role | Light | Dark | Rule |
| --- | --- | --- | --- |
| Bone (page) | `#F2F0EB` | `#111111` | Everything sits on it. No white, no cards. |
| Pressed | `#ECE9E2` | `#1A1A1A` | Hover and selected rows, the frame behind the shell. |
| Ink | `#111111` | `#F2F0EB` | Text, hairline sections, the one accent, the objects. |
| Hairline | `#D9D6CF` | `#2A2A2A` | 1px dividers. Section tops are 1px ink. |
| Mid | `#63625D` | `#A8A69E` | Secondary text, labels. 5.9:1 on bone. |
| Faint | `#9A988F` | `#6B6A66` | Placeholders and off states only. |
| Signal | `#FF4D00` | same | Marks only: 2–3px lines, dots, rings, glows, the live dot. Never a fill behind text. |
| Signal text | `#C23A00` | `#FF6A2B` | Orange as text: pending, overdue, needs you. AA on bone. |
| Light | `#FBFAF7` | `#1C1C1C` | The radial pool under an object. |

Radius is 0 except pills (999px). No drop shadows on UI, only the object's long skewed shadow.

## 2. Type

- Display and body: **Schibsted Grotesk** (Google Fonts). Weights 400, 500, 600. Headlines 500 with tracking −0.04em; page `h1` 56px on product screens (88–96px only on the concept/hub boards).
- Labels, figures, status words: **DM Mono** 11px, uppercase, tracking 0.12em (the `.mono` class). All numbers use `font-variant-numeric: tabular-nums` (the `.num` class).
- In `app/layout.tsx` swap `Plus_Jakarta_Sans` for `Schibsted_Grotesk` (variable `--font-schibsted`) and `Geist_Mono` for `DM_Mono` (variable `--font-dm-mono`, weights 400 and 500). Keep the CJK fallbacks.

## 3. The shell

See `shell.css` (plain CSS, class names below) and any `reference/P-*.dc.html` for the markup. Replace the floating, rounded, shadowed panels with:

- **Rail** (`.rail`, 232px): brand line `AIHR / SYSTEM 01` in mono, then the three groups exactly as `components/sidebar.tsx` orders them (everyday, Manage, Admin). Items are mono uppercase, 32px tall, ink text with a 1px ink left border when active; group labels mid with a hairline under. A module with children lists them inline, indented behind a hairline, active child in signal-text. No icons. The user line sits at the bottom. Collapse keeps the same rows at icon width if you want it, but the boards assume the rail is always open on desktop and hidden below 900px.
- **Top line** (`.top`): the route path in mono, a hairline tick, the company switcher as mono text with a ▾, then on the right the live dot and clock, and the notice count with the number in signal-text. No search box here.
- **Intent bar** (`.intent`): 60px, 1px ink top and bottom, orange sparkle, a plain input at 19px, ↵ on the right. It is the command palette (⌘K) made visible. Screens that have nothing to ask omit it.
- **Header**: mono kicker (scope · date), `h1`, optional actions as `.pill` (ink fill, bone text, 44px) and `.txt` (underlined text buttons), and 3–5 stat `.cell`s separated by hairlines with big mono figures.
- **Sections** (`.sec`): 1px ink top, a mono index label (`01 · Period`) left and tabs or a note right, then content. Never a card.
- **Footer** (`.stat`): one mono status line: `Sys OK · scope · last sweep`.

## 4. Primitives → components

`components.md` maps every primitive to a React component and says which `components/ui/*` to retune. The short version:

- Table rows are 50px hairline rows; the first column mono mid, the second 500 weight, status as a mono word coloured by meaning (ink done, signal-text pending or blocking, mid neutral). Hover is pressed, selected is ink with bone text. An orange 3px bar appears at the row's left edge on hover.
- Forms are underlined inputs (`.fd`): mono label above, 1px ink bottom border, 40px tall. Switches are a 40×22 hairline pill with an ink dot; off moves the dot and hollows it.
- Spec grids (`.kv`) are the read-only form: mono label over a 500-weight value, big figures at 28px mono.
- Steps are a flex strip of mono labels with a 1px line under each; the current step's line is signal with a glow.
- Rulers (`.ruler`) are the time scrubber: 72px, hairline ticks, the current tick in signal.
- Notes (`.note`) replace alert cards: a mono label (signal-text when it warns), one sentence at 18px, a line of detail, a text link. No tinted boxes.
- Empty states are a dashed faint box with a mono label and one sentence.
- Badges become status words. Delete `Badge` colour variants; a status is `<span class="mono" style="color: …">Pending</span>`.
- Buttons: `.pill` for the one primary action on a screen, `.pill.ghost` (ink outline) rarely, `.txt` for everything else. No icon buttons without a label.

## 5. The object

Hub screens carry one black object; config, list and detail screens carry none. The rule is in the System board: Home (monolith), Payroll (plates), Leave (ticket), Statutory (tablets), People (orb and ring), Attendance (clock), Claims (deck), Organization (cube), Drive (cabinet), Org tower (the tower), Campus (the estate). Product screens use the compact set: slab, plates, orb, coin, cube, card (see `.ob` in `shell.css`).

Every object sits in a `.stage` with a `.spot` light pool and a long skewed `.shadow`, has a sheen that passes every 7–8s, and orbits on drag, zooms on wheel, with a `.cam` wrapper and per-object tilt and zoom limits. `objects.md` has the CSS-3D recipes (cuboid faces, the isometric plane with four outward walls, stacked floors, drawers, billboards, the camera methods and the fly-to-selection maths). Port them as a `useOrbit()` hook plus a handful of client components; they are pure CSS transforms, no WebGL.

Respect `prefers-reduced-motion` and the `motion` switch: everything still renders, nothing moves.

## 6. Motion

| What | Timing |
| --- | --- |
| Reveal (`.rv`) | 0.8s, cubic-bezier(.2,.8,.2,1), staggered 50ms per block |
| Camera fly / orbit settle | 0.6–0.8s, same curve; none while dragging |
| Sheen | 7–8s loop, 115deg, 20% white |
| Live dot | 2.4s beat |
| Pull-out (floor, drawer, card) | 0.5–0.7s |
| Figures and status | never |

## 7. Rollout plan for the build session

1. **Tokens and fonts** — `tokens.css` into `globals.css`, fonts in `layout.tsx`. The app turns bone and ink immediately. Check contrast on the few places that used white-on-indigo.
2. **Shell** — rebuild `components/sidebar.tsx` (rail), the top bar in `app/layout.tsx` (top line), and surface the command bar as the intent bar. Remove rounded panels, shadows and the canvas frame.
3. **Primitives** — the shared pieces in `components/ui`: button (pill, txt), input (underline), badge (status word), card (section with hairline), plus new `Section`, `Cells`, `Kv`, `Steps`, `Ruler`, `Note`, `Empty`, `Panel`. Keep APIs; change rendering.
4. **Screens by module**, hub first — each `app/**/page.tsx` has a board under `reference/` or in the canvas with the exact layout, copy and status vocabulary: Dashboard and My Profile, Payroll, Leave, Attendance, Claims, Personnel and Organization, Statutory and reports, Admin settings.
5. **Objects** — add `useOrbit()` and the compact objects to hubs only, then the heavy ones (tower, campus, cabinet) where the room exists.
6. **The game dashboard** — parked. The full implementation is `reference/dashboard-game.py` (a complete artboard with a game loop); treat it as a prototype, not a spec, until the owner un-parks it.

Each step ships on its own, passes the usual gate, and keeps `test/function-access.test.ts` untouched: Monolith changes no routes or guards.

## 8. Do and don't

- Do divide with hairlines, label with mono, mark with orange, fill with ink.
- Do keep every status a word. Colour only reinforces it.
- Do give each screen one primary action and make it a pill.
- Don't use cards, tinted panels, gradients on UI, shadows, icons as the only label, or any orange fill behind text.
- Don't animate a figure, a total or a balance.
- Don't put an object on a config or detail screen.
