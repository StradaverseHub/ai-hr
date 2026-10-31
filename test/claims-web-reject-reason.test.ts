/**
 * Owner decision (Phase F defaults, 29 October 2026): a claim rejected on the web carries the approver's reason, as in
 * the app (D12), and the employee sees it on /claims. The kernel stamps it on the rejection event (decideClaim's
 * rejectReason, pinned in test/claims-mobile-kernel-seams.test.ts); this pins the web's three halves of the contract:
 * the reject form asks for it, the actions refuse (single) or skip (bulk) without it and pass it on, and the
 * employee's list renders the owner's reader with a key present in every locale.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
/** A slice between two markers, proving both were found and the slice is substantial (CLAUDE.md §8). */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThanOrEqual(0);
  const out = src.slice(a, b);
  expect(out.length).toBeGreaterThan(200);
  return out;
}

describe('web claim rejection reason', () => {
  const actions = read('app/(app)/approvals/actions.ts');

  it('the single-claim action refuses a reasonless rejection and passes the reason to decideClaim', () => {
    const single = between(actions, 'export async function approveClaimAction', 'await done(');
    expect(single).toMatch(/formData\.get\('rejectReason'\)/);
    expect(single).toMatch(/if \(!approved && !rejectReason\) throw new ClaimError\(/);
    expect(single).toMatch(/rejectReason: approved \? null : rejectReason/);
  });

  it('a bulk rejection skips a claim without a reason and otherwise passes it on', () => {
    const bulk = between(actions, "case 'claim':", "case 'attendance':");
    expect(bulk).toMatch(/decision === 'rejected' && !rejectReason\) throw new ClaimError\(/);
    expect(bulk).toMatch(/rejectReason: decision === 'rejected' \? rejectReason \?\? null : null/);
  });

  it('the approvals page asks for a required reason when rejecting a claim', () => {
    const page = read('app/(app)/approvals/page.tsx');
    expect(page).toContain("<DecideButtons action={approveClaimAction} id={c.id} disabled={mine(c.personId)} labels={decideLabels} rejectReasonLabel={t('rejectReasonPlaceholder')} nav={nav} />");
    // DecideButtons renders a REQUIRED rejectReason textarea when given a rejectReasonLabel.
    expect(page).toMatch(/<textarea name="rejectReason" required/);
  });

  it('the employee list shows the reason through the claims owner reader, translated in every locale', () => {
    const claims = read('app/(app)/claims/page.tsx');
    expect(claims).toMatch(/claimRecordFacts\(s, claims\.filter\(\(c\) => c\.status === 'rejected'\)/);
    expect(claims).toMatch(/t\('rejectReasonShown', \{ reason:/);
    for (const locale of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const catalogue = JSON.parse(read(`messages/${locale}.json`)) as { claims: Record<string, string> };
      expect(catalogue.claims.rejectReasonShown, locale).toMatch(/\{reason\}/);
    }
  });
});
