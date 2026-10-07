---
name: monolith-theme
description: Apply the Monolith design language (bone page, ink, hairlines, mono labels, orange marks, one orbiting black object per hub) to AIHR screens. Use when restyling the shell, a component, or any app/**/page.tsx to the new theme, or when asked about the theme's tokens, rules or boards.
---

# Monolith theme

Install: copy this file to `.claude/skills/monolith-theme/SKILL.md` in your checkout (that folder is gitignored here), or just read the files below.

Read, in this order, before changing any styling:

1. `docs/design/monolith/README.md` — the language, the shell, the rollout plan, do and don't.
2. `docs/design/monolith/tokens.css` — the drop-in tokens for `app/globals.css`.
3. `docs/design/monolith/components.md` — primitive → component map.
4. The board for the screen you are on: `docs/design/monolith/reference/P-<Screen>.dc.html` when present, else the canvas at https://claude.ai/artifact/AJgxP9Z821f876RftyHY4c (open it with the Artifact tool's `read`, path `project/P-<Screen>.dc.html`; `project/canvas.json` lists every board by route). The markup inside `<x-dc>` is the layout; the `<style>` block is the CSS; the script holds the copy and status vocabulary.
5. `docs/design/monolith/objects.md` only when the screen is a hub that carries an object.

Rules that override habit:
- Status is a word in DM Mono; colour reinforces it (ink done, `--signal-text` pending or blocking, `--mid` neutral). Never a coloured badge.
- Orange (`--signal`) is a mark: lines, dots, rings, glows. Never a fill behind text. Orange text uses `--signal-text`.
- Hairlines divide; nothing is a card. Section tops are 1px ink with a mono index label.
- One primary action per screen as a pill; everything else is an underlined text button.
- Figures, totals and balances never animate. Objects do.
- Objects live on hubs only. Config, list and detail screens have none.
- Respect `prefers-reduced-motion`.
- Do not change routes, guards or `lib/permissions.ts`. The theme touches rendering only.

Ship in the README's rollout order: tokens and fonts, shell, primitives, then screens by module with hubs first, then objects. Each step passes the normal gate on its own.
