/**
 * Payroll tab card order (feedback 326f0b5e) — Basic Salary first.
 *
 * The Personnel (Admin) employee-detail Payroll tab previously rendered the Basic Salary /
 * salary-history card (compensationCard) LAST, forcing HR/Payroll admins to scroll past pay
 * components, CP38, encashment and the payroll policy to reach the most-referenced attribute.
 *
 * This item is a pure JSX reorder: compensationCard is pinned FIRST in the payroll fragment, every
 * other card definition and behaviour unchanged. We assert the rendered order directly from the
 * page source — the payroll fragment lists the five card expressions in a fixed sequence, so a
 * source-order assertion is the exact, deterministic contract for "Basic Salary opens at the top".
 * (Mounting the full server component against the DB would exercise data loading, not the ordering
 * concern this item is about.)
 *
 * ── r256 (420ebab5 part two) UPDATED THIS FILE RATHER THAN REPLACING IT ────────────────────────────
 * The Payroll tab now has ONE "Save Changes" for its three field-edit cards, and a tab Save can only
 * enclose a CONTIGUOUS run of cards. Its three bucket (a) cards were not contiguous: Payment Method is
 * rendered inside Basic Salary (first), the payroll policy is second, and TP3 was SIXTH — behind Pay
 * Items, CP38 and Leave Encashment. So TP3 moved up to third and the (a) run now leads the tab.
 *
 * 326f0b5e IS NOT REVERSED AND MUST NOT BE. compensationCard is still FIRST — that is this file's
 * original subject and the assertions below are unchanged. R46 79eb7151's "policy directly under Basic
 * Salary" is likewise still true. What moved is TP3, whose sixth slot was never a decision anybody took:
 * item a6a47698 appended it when it relocated the card here from Bank & Statutory, and no guard held it.
 * The new run is pinned below so the next round cannot drift it back and quietly break the contiguity the
 * tab's Save depends on — see docs/audits/420ebab5-personnel-save-classification.md finding 3.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE = join(__dirname, '..', 'app', 'admin', 'personnel', '[employmentId]', 'page.tsx');

/** Extract the JSX inside `payroll: ( <> ... </> ),` from the page source. */
function payrollFragment(src: string): string {
  const anchor = src.indexOf('payroll: (');
  expect(anchor).toBeGreaterThan(-1);
  const close = src.indexOf('</>', anchor);
  expect(close).toBeGreaterThan(anchor);
  return src.slice(anchor, close);
}

describe('Personnel — Payroll tab renders Basic Salary first (326f0b5e)', () => {
  const src = readFileSync(PAGE, 'utf8');
  const frag = payrollFragment(src);

  const cards = ['compensationCard', 'payComponentsCard', 'cp38Card', 'encashmentCard', 'payrollPolicyCard'];

  it('lists all five payroll cards in the fragment', () => {
    for (const c of cards) expect(frag).toContain(`{${c}}`);
  });

  it('compensationCard (Basic Salary) is the FIRST card rendered', () => {
    const positions = cards.map((c) => frag.indexOf(`{${c}}`));
    const compIdx = frag.indexOf('{compensationCard}');
    for (const c of cards.filter((c) => c !== 'compensationCard')) {
      expect(compIdx).toBeLessThan(frag.indexOf(`{${c}}`));
    }
    // sanity: no card is missing (-1) from the ordering set
    expect(Math.min(...positions)).toBeGreaterThan(-1);
    expect(compIdx).toBe(Math.min(...positions));
  });

  it('compensationCard precedes payComponentsCard specifically (the previously-first card)', () => {
    expect(frag.indexOf('{compensationCard}')).toBeLessThan(frag.indexOf('{payComponentsCard}'));
  });
});

describe('Personnel — Payroll tab: the field-edit run leads the tab (420ebab5 r256)', () => {
  const src = readFileSync(PAGE, 'utf8');
  const frag = payrollFragment(src);

  it('the three cards under the tab Save are contiguous and first: compensation → policy → TP3', () => {
    const at = (c: string) => {
      const i = frag.indexOf(`{${c}}`);
      expect(i, `${c} renders on the Payroll tab`).toBeGreaterThan(-1);
      return i;
    };
    expect(at('compensationCard')).toBeLessThan(at('payrollPolicyCard'));
    expect(at('payrollPolicyCard')).toBeLessThan(at('tp3Card'));
    // Contiguous: nothing the tab Save does NOT own may sit between them, or the scope could not wrap
    // them without swallowing a child-record register.
    for (const outsider of ['payComponentsCard', 'cp38Card', 'encashmentCard', 'zakatSummaryCard']) {
      expect(at('tp3Card'), `${outsider} must not break the run`).toBeLessThan(at(outsider));
    }
  });

  it('TP3 moved up from sixth — the three money registers now follow the consolidated run', () => {
    // Before r256 the order was compensation → policy → payComponents → cp38 → encashment → tp3 → zakat.
    // This is the assertion that would have failed then, and the one that fails if it drifts back.
    expect(frag.indexOf('{tp3Card}')).toBeLessThan(frag.indexOf('{cp38Card}'));
    expect(frag.indexOf('{tp3Card}')).toBeLessThan(frag.indexOf('{encashmentCard}'));
  });
});
