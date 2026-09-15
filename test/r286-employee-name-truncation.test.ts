import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * r286 — THE NAME MUST BE ABLE TO SHRINK, AND THE ID MUST NOT.
 *
 * Reported as "throughout the system, there's a lot of such cases where the words overspill", with the org
 * chart as the example: a card whose role line ellipsised correctly while the employee NAME beside it ran
 * straight through the card's border.
 *
 * The cause was one shared component, which is why it looked systemic — `EmployeeName` is rendered from 28
 * files. Callers passed `truncate` in `className` and reasonably expected clipping. It could never work:
 * `truncate` is overflow-hidden + text-overflow-ellipsis + nowrap, and on an INLINE-FLEX box the ellipsis
 * applies to that box's own inline text, of which it has none — never to its flex children. The name span
 * was itself a flex item sitting at its automatic minimum content width, so it would not shrink and simply
 * overflowed.
 *
 * ⚠️ THESE ARE SOURCE-SHAPE ASSERTIONS ON PURPOSE. jsdom has no layout engine: it reports every width as
 * 0, so a rendered test CANNOT observe overflow and would pass just as happily against the broken version.
 * A guard that cannot fail is worse than none (this session has found four of those), so this pins the
 * three class names that carry the behaviour, and says why each one is load-bearing.
 */
const UI = readFileSync('components/ui.tsx', 'utf8');
const fn = UI.slice(UI.indexOf('export function EmployeeName'), UI.indexOf('export function', UI.indexOf('export function EmployeeName') + 1));

describe('r286 — EmployeeName cannot overspill its container', () => {
  it('the group can shrink inside whatever flex or grid parent holds it', () => {
    expect(fn, 'EmployeeName still exists').not.toBe('');
    // Without this the group sits at its automatic minimum width and pushes out of the parent instead of
    // letting the name clip — which is the org-chart card's failure exactly.
    expect(fn).toMatch(/inline-flex min-w-0 items-baseline/);
  });

  it('the NAME carries the truncation, not the flex container', () => {
    // The whole defect in one line: `truncate` on the container does nothing for children.
    expect(fn).toContain('<span className="min-w-0 truncate">{name}</span>');
  });

  it('the employee ID refuses to shrink, because a half-eaten id is worse than a clipped name', () => {
    expect(fn).toMatch(/EmployeeCode code=\{code\} className=\{cn\('shrink-0', codeClassName\)\}/);
  });

  it('every caller still gets to style the group', () => {
    // `className` must keep reaching the group, or 28 call sites lose their spacing and weight.
    expect(fn).toMatch(/cn\('inline-flex min-w-0 items-baseline gap-1\.5', className\)/);
  });
});
