import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * r270 (995387c6) — THE URL MAY ASK FOR A TAB, AND STORED STATE MAY NOT OVERRULE IT.
 *
 * WHY THIS EXISTS. This round took the Benefit schemes editor off
 * `/admin/leave-config/entitlement-tables`, so the only mount that reads `?editRule=` / `?editTemplate=`
 * is now the one embedded in a leave type's third tab. Two callers send people there: the explain
 * panel's "Open scheme" link, and every table/rule save that returns without an `embeddedLeaveTypeId`.
 *
 * The defect this pins is one a 200 and a green suite both miss, and the round's own verify pass found
 * it: `LeaveTypeTabs` seeds `activeTab` to 'identity' and then an effect overwrites it from
 * `leaveTypeCards:<id>` in localStorage. So the link opened the right leave type with the editor
 * MOUNTED BUT NOT ON SCREEN, on whatever tab that reader last used — tab 1 for anyone who has never
 * switched. A control that silently does nothing is precisely what item 995387c6 was raised to remove;
 * introducing one while satisfying it would be the worst possible outcome.
 *
 * THE DEFECT LIVES IN THE CONTRACT BETWEEN TWO FILES, so it is pinned across both (CLAUDE.md §8):
 * the page must SEND the tab, and the component must LET IT WIN. Either half alone is green and broken.
 */

const TABS = 'app/admin/leave-config/types/leave-type-tabs.tsx';
const PAGE = 'app/admin/leave-config/types/page.tsx';

const read = (p: string) => readFileSync(p, 'utf8');

describe('r270 · the tab a link asks for beats the tab a browser remembers', () => {
  it('the page derives the tab from BOTH edit parameters and passes it down', () => {
    const src = read(PAGE);
    // Both parameters mean "the embedded tables block wants you": editRule opens a scheme, editTemplate
    // opens a table. Pinning both stops a later edit from fixing one link and leaving the other dead.
    expect(src).toMatch(/openTab=\{[^}]*editRule[^}]*editTemplate[^}]*\}/);
    expect(src).toMatch(/openTab=\{[^}]*'entitlement'[^}]*\}/);
    // And it must still be the page that reads them from the URL, not a client guess.
    expect(src).toContain('const { error, editTemplate, editRule } = await searchParams;');
  });

  it('the component seeds its tab from the prop rather than always starting at tab 1', () => {
    expect(read(TABS)).toContain("useState<TabKey>(openTab ?? 'identity')");
  });

  it('and the stored-state effect STANDS DOWN when the URL asked — checked by ORDER, not by presence', () => {
    const src = read(TABS);
    const guard = src.indexOf('if (openTab) return;');
    const storage = src.indexOf('window.localStorage.getItem(`leaveTypeCards:${id}`)');
    expect(guard, 'the early return must exist').toBeGreaterThan(-1);
    expect(storage, 'the hydration read must exist').toBeGreaterThan(-1);
    // The whole defect is an ordering one. A guard placed AFTER the read still overwrites the tab, and
    // an assertion that only checked both strings were present would pass on the broken arrangement.
    expect(guard, 'the guard must run BEFORE the stored tab is read').toBeLessThan(storage);
  });

  it('the prop is in the effect dependency list, so it is not captured stale', () => {
    expect(read(TABS)).toMatch(/\}, \[id, openTab\]\);/);
  });

  it('arriving by link does NOT rewrite the remembered tab — an errand is not a preference', () => {
    const src = read(TABS);
    // `selectTab` is the only writer, and it must stay keyed on a human click. If a future edit persists
    // `openTab`, one "Open scheme" link would silently move an administrator's tab for every later visit.
    const persist = src.slice(src.indexOf('const selectTab'));
    expect(persist).toContain('activeTab: key');
    expect(persist).not.toContain('openTab');
  });
});
