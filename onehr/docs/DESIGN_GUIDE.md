# OneHR — UI Design Guide

Platform-wide UI conventions for OneHR by Chin Hin. These are the rules a new surface should
follow so the product reads as one system. Class names below are in `static/style.css`.

This is a living document — add a convention here when we settle one, rather than re-deciding it
per page.

## Interactive states

### Hover — background-colour highlight ONLY
For **any** hover effect, change the **background colour**. Do not:
- **Change `border-color` on hover.** A card's border often carries meaning (e.g. the amber
  pending accent `border-left: 3px solid #c9862b` on a to-do item); a hover that touches the
  border greys that accent out. Keep the border fixed; move only the background.
- **Underline text on hover.** The app has a global `a:hover { text-decoration: underline }`;
  suppress it on nav/tab/card links (`text-decoration: none`) — the background fill is the cue,
  not an underline.

Established token: the left-nav item hover is `background: #e8edf6` (`.rv-nav-item:hover`).

### Selection / "current"
The selected or current item is the **navy box**: `border-color: var(--navy)`, `background:
#eef0fb`, `box-shadow: 0 0 0 2px rgba(37,42,89,0.14)` (`[aria-current="true"]`). This is the
single, consistent "you are here / this is chosen" cue across the left panel.

To distinguish a **second level** of selection from the peer/item selection, use a different
hue rather than a second navy box: the active **stage chip** is teal
(`border-color: #0f6e56; background: #e8f3ef`, `.rv-nav-chip.rv-chip-on`), so "which stage" and
"which item" never look identical.

## Accents & status colour

- **Pending / to-do accent:** amber left border `#c9862b`; amber text `#9a5a12`; amber pill
  `background: #fdf0e2` (`.rv-pill.amber`).
- **Performance-band pills** reuse the app's one band palette (`.potential-pill[data-band]` /
  `.rv-nav-donerow .rv-dn-meta[data-band]`): UA red `#fbdada`/`#a02323`, BE amber
  `#fde6cc`/`#8a4500`, ME blue `#e0e9fb`/`#1b46b3`, AE green `#d7f0e0`/`#1a7a54`, OU dark-green
  `#d4f5dc`/`#1d6b34`. Never invent a second colour for a band.
- **Done / success:** green `#0f6e56` (progress bars, the Demonstrate pill, the done tick).

## Chat dialogue action buttons

Every action button in a chat-dialogue widget (the guided-review journey cards) sits **bottom-right**
of its widget — the single, consistent place the primary action lives across ALL chat action widgets:
the sign-off / confirm cards (`.rv-confirm-actions`), the fill-then-save footers (`.rv-kpi-foot`), the
manager approve / lock footers (`.rv-sum-foot`), the Career Plan save (`.rv-cp-save`), and the manager
review / close-plan actions. Implement an action row as `display: flex; justify-content: flex-end`
(or, for a lone button in a flex-column widget, `align-self: flex-end`). Never leave a chat action
button left-aligned. A footer that carries only meta text (e.g. `.rv-mgr-foot`'s "Their overall: …"
line) is not an action row and stays left; put an action button in an action-row class instead.

## Cards & density

- Left-nav cards are compact: name `0.82rem`/weight 600 (not bold), sub-line `0.74rem` muted
  `#6b7280`. Keep names to **one line** with ellipsis (`.rv-ni-name`) unless there is a specific
  reason to wrap.
- A grouped list carries its state on the **group header** (e.g. `PENDING TO ASSESS` with the
  pending count right-aligned), not as a per-row "Not started" label.
