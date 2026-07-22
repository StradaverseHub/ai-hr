/**
 * Leave-type config: active-section indicator on the category headers (feedback 27136ea6; card list
 * restructured to five by 123c1e76 — General / Eligibility / Entitlement / Condition / Custom).
 *
 * The collapsible category headers in components/leave-type-panel.tsx used to look identical whether
 * open or closed (the rotating chevron was the only cue). Now `cardHeaderBtn` is a function of the card's
 * open state: an OPEN header gets the accent wash (bg-accent), a slightly indented title (pl-6) and a bolder
 * CardTitle ([&_h3]:font-semibold). "Active" means EXPANDED — the cards are independent accordions by design,
 * so SEVERAL headers may be highlighted at once; do not assert exclusivity.
 *
 * Static source guard (the repo convention for this DOM-runner-less component; see
 * leave-type-config-categories.test.ts / leave-type-edit-layout.test.ts). A static test CANNOT prove the
 * bolder title actually renders bolder, nor that the accent background follows the card's rounded corners —
 * those two are assigned to browser verification and that assignment is not optional.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');

const CARD_KEYS = ['general', 'eligibility', 'entitlement', 'ess', 'custom'] as const;

describe('27136ea6 · active (expanded) category headers are visually distinguished', () => {
  it('each of the 5 header buttons derives its classes from its OWN openCards key', () => {
    // The genuine bug class across near-identical call sites is a copy-paste key mismatch
    // (e.g. the entitlement button styling off openCards.ess).
    for (const key of CARD_KEYS) {
      const re = new RegExp(
        `toggleCard\\('${key}'\\)[^\\n]*className=\\{cardHeaderBtn\\(!!openCards\\.${key}\\)\\}`,
      );
      expect(panelSrc, `header button for '${key}' passes its own key to cardHeaderBtn`).toMatch(re);
    }
  });

  it('the active branch carries the highlight, the indent, and the bolder-title rule', () => {
    const defStart = panelSrc.indexOf('const cardHeaderBtn');
    expect(defStart).toBeGreaterThan(-1);
    // The definition ends at the arrow function's closing `);` — slice generously to the first call site.
    const def = panelSrc.slice(defStart, panelSrc.indexOf("toggleCard('general')"));
    // Kept deliberately loose (substring, not exact literals): bg-accent still matches if a designer later
    // tunes to bg-accent/60 (the half-active treatment nav-collapsible-group.tsx already uses).
    expect(def).toContain('bg-accent');
    expect(def).toContain('pl-6');
    // The fragile piece: the descendant rule that bolds the CardTitle h3 from the button. If this is
    // refactored into something that no-ops (e.g. an inherited weight on a wrapper), the requirement
    // silently fails — hence it is pinned here.
    expect(def).toContain('[&_h3]:font-semibold');
  });
});
