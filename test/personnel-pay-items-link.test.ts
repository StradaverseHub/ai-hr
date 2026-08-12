/**
 * 2f889bae — the Pay items rows on the Personnel Payroll tab link to the item's own page.
 *
 * The reporter's point was that Edit, Stop and Remove already existed but were unreachable from the
 * employee's own screen: the table was read-only and the buttons sat one screen away under
 * Payroll → Transactions → Fixed. Five of that item's seven original steps had already shipped under a
 * DIFFERENT item (2aed39d4, r185) and one of them contradicts what is now live, so this link is the only
 * work revision 2 asks for.
 *
 * SOURCE-SHAPE assertions, deliberately. What is being pinned is that TWO SURFACES AGREE about one
 * destination — the personnel tab and fixed-list.tsx must build the same href and use the same labels.
 * A rendered-output test of either screen alone would pass while the two drifted apart, which is the
 * failure this guards.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const personnel = readFileSync(join(root, 'app/admin/personnel/[employmentId]/page.tsx'), 'utf8');
const fixedList = readFileSync(join(root, 'app/payroll/transactions/fixed/fixed-list.tsx'), 'utf8');
const en = JSON.parse(readFileSync(join(root, 'messages/en.json'), 'utf8'));

/** Strip comments — this file's own explanation quotes the retired reasoning, and the pack-drift ratchet
 *  is the standing lesson about scanning source without stripping them first. */
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const HREF = /href=\{`\/payroll\/transactions\/fixed\/\$\{[a-zA-Z.]+\}\?employmentId=\$\{encodeURIComponent\([a-zA-Z.]+\)\}`\}/;

describe('2f889bae: Pay items rows reach the item page', () => {
  it('the personnel Pay items table renders a link per row', () => {
    const code = strip(personnel);
    expect(code).toMatch(HREF);
    expect(code).toMatch(/tFixed\('viewEdit'\)/);
    expect(code).toMatch(/tFixed\('actions'\)/);
  });

  it('it builds the SAME href shape as Fixed Transactions, so the two cannot drift', () => {
    // Both must match the identical pattern — that is the whole point of copying it verbatim.
    expect(strip(fixedList)).toMatch(HREF);
  });

  it('it reuses Fixed Transactions own labels rather than minting personnel copies', () => {
    // If someone later adds people.detail.viewEdit, the two screens can start disagreeing about what the
    // same destination is called. Reusing the existing namespace is what prevents that.
    expect(en.payroll.transactions.fixed.viewEdit).toBeTruthy();
    expect(en.payroll.transactions.fixed.actions).toBeTruthy();
    expect(en.people?.detail?.viewEdit).toBeUndefined();
  });

  it('the retired "no per-row Edit" reasoning is GONE, not just contradicted', () => {
    // The old comment argued the writer closed the prior row AT effectiveFrom so the kernel paid twice.
    // r180 changed the close and r185 made an overlap impossible. Leaving that text in place is how this
    // link gets reverted by the next reader who greps for why the table was read-only.
    expect(personnel).not.toMatch(/NO per-row Edit here, deliberately/);
    // And the reason that IS still true must remain findable: the mid-month restatement, which is a
    // design decision raised separately and is NOT something this link could fix.
    expect(personnel).toMatch(/MID-MONTH/);
  });

  it('both screens sit behind the same guard, so the link cannot lead somewhere the viewer is refused', () => {
    // Verified rather than assumed: revision 1 listed this as unverified.
    expect(personnel).toMatch(/scopedAdmin\(\)/);
    const destination = readFileSync(join(root, 'app/payroll/transactions/fixed/[id]/page.tsx'), 'utf8');
    expect(destination).toMatch(/scopedAdmin\(\)/);
  });
});
