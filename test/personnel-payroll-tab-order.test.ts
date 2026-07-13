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
