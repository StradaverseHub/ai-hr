# Monolith primitives → React components

Each row is a class in `shell.css` and the markup the design boards use (see `reference/P-*.dc.html`; the generator that produced them is `reference/generator.py`, its `render_section` is the authoritative markup per primitive).

| Primitive | Class | Build as | Retune from `components/ui` |
| --- | --- | --- | --- |
| Rail | `.rail`, `.it`, `.kids`, `.gl` | `components/sidebar.tsx` rewrite; groups and hrefs unchanged | — |
| Top line | `.top` | header in `app/layout.tsx`; company switcher as mono text | `company-switcher.tsx` |
| Intent bar | `.intent` | `IntentBar` wrapping `command-bar.tsx`; always visible on hubs | `command-bar.tsx` |
| Header | kicker + `h1` + actions | `PageHeader({ kicker, title, actions, cells })` | page header pattern |
| Stat cell | `.cells`, `.cell` | `Cells([{ label, value, unit, sub, signal }])` | KPI tiles |
| Section | `.sec`, `.sh`, `.tabs` | `Section({ index, label, tabs, right, children })` | `card.tsx` (becomes this) |
| Table | `.th`, `.tbl`, `.tr`, `.st` | `HairlineTable({ cols, widths, rows, statusCol })`; rows are `<button>` when selectable | all data tables |
| Spec grid | `.kv` | `Kv([{ label, value, big, color }], cols)` | definition lists |
| Form | `.fm`, `.fd`, `.sw` | `Field`, `UnderlineInput`, `UnderlineSelect`, `Switch` | `input.tsx`, checkboxes |
| List | `.ls` | `HairlineList([{ a, title, sub, right, color }])` | activity lists |
| Steps | `.steps`, `.step` | `Steps([{ label, sub, state }])` | wizard headers |
| Ruler | `.ruler`, `.tick` | `Ruler({ ticks, on, onPick })` | month pickers, year filters |
| Bars | `.bars`, `.bar` | `Bars([{ label, value, signal }])` (hairline chart; keep charts flat) | dashboard charts |
| Note | `.note` | `Note({ label, title, body, action, warn })` | alert/amber cards |
| Empty | `.empty` | `Empty({ label, title, body })` | empty states |
| Side panel | `.panel` | `Panel({ kicker, title, body, kv, actions })` right column 300–420px | detail drawers |
| Pill | `.pill`, `.pill.ghost` | `Button variant="pill"` | `button.tsx` default |
| Text button | `.txt` | `Button variant="txt"` | `button.tsx` ghost/link |
| Status word | `.mono` + colour | `Status({ word, tone: 'ink' | 'signal' | 'mid' })` | `badge.tsx` (replace) |
| Live dot | `.dot` | `LiveDot` | — |
| Object stage | `.stage`, `.spot`, `.shadow`, `.cam`, `.ob` | `ObjectStage({ kind })` + `useOrbit()` | — |
| Status footer | `.stat` | `StatusLine([...])` | — |

Status tones: `ink` = done, released, active, approved; `signal` (signal-text) = pending, overdue, blocking, needs you; `mid` = neutral, cancelled, inactive, upcoming.

Column widths used across the boards are in each `P-*.dc.html` as `grid-template-columns`; keep them as the starting point.
