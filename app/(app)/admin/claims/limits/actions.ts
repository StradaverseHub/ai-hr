'use server';

import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { setGradeClaimLimits, type GradeLimitEdit } from '@/packs/claims/service';

const BASE = '/admin/claims/limits';
const fail = (e: unknown) => redirect(`${BASE}?error=${encodeURIComponent(publicErrorMessage(e))}`);

const numOrNull = (v: unknown): number | null => {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error('Limits must be numbers');
  return n;
};
const intOrNull = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n == null ? null : Math.trunc(n);
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One row as the grid serialises it. Everything arrives as a string because it came out of an input. */
type PostedRow = {
  claimTypeId?: unknown;
  claimItemId?: unknown;
  perClaimCap?: unknown;
  monthlyLimit?: unknown;
  annualBudget?: unknown;
  maxClaimsPerYear?: unknown;
  blockEnabled?: unknown;
  blockLimit?: unknown;
  blockLength?: unknown;
  blockUnit?: unknown;
};

/**
 * SAVE EVERY CHANGED LIMIT FOR ONE JOB GRADE (e7eb5d83 rev 5, step 3).
 *
 * ⚠️ NOTE WHAT IS ABSENT: there is no rateKind, no ratePerKm, no fixedAmount, and no rateConfig passed to
 * the service. That is the plan's promise — "saving limits will never touch a rate again" — and it works
 * because setClaimPolicyTx treats an ABSENT rateConfig as INHERIT (step 1a) rather than as "clear it". The
 * predecessor of this action always posted a rate whether one had been asked for or not, which is exactly
 * how the company's live RM0.70/km mileage rate was one Save away from being deleted. `GradeLimitEdit`
 * omits rateConfig from its own type, so re-introducing one here is a compile error rather than a habit.
 *
 * THE PAYLOAD IS UNTRUSTED, like any POST. The grid sends only the rows the admin actually edited, but a
 * hand-rolled request can send anything: every field is re-parsed here, a non-numeric limit is refused
 * rather than coerced to NaN, and the service re-validates each row (and refuses a sub-claim that does
 * not belong to its claim type) inside the transaction.
 */
/** PURE parse — no I/O and, deliberately, no redirect. See the action below for why that matters. */
function rowsFrom(formData: FormData): GradeLimitEdit[] {
  const raw = String(formData.get('payload') ?? '[]');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Could not read the changed limits from this form');
  }
  if (!Array.isArray(parsed)) throw new Error('Could not read the changed limits from this form');
  return (parsed as PostedRow[]).map((r) => {
    const claimTypeId = str(r.claimTypeId);
    if (!claimTypeId) throw new Error('A changed row arrived without a claim type');
    // Per block is all-four-or-none. The tick is the switch: unticked sends the whole rule as null, which
    // is "no per-block rule" and is every row on production today. blockStartOn is deliberately NEVER
    // sent — the service inherits the anchor already on the rule rather than restarting the window, so
    // editing an unrelated cap cannot silently move everybody's two-year boundary.
    const blockOn = r.blockEnabled === true || r.blockEnabled === 'true' || r.blockEnabled === 'on';
    return {
      claimTypeId,
      claimItemId: str(r.claimItemId) || null,
      perClaimCap: numOrNull(r.perClaimCap),
      monthlyLimit: numOrNull(r.monthlyLimit),
      annualBudget: numOrNull(r.annualBudget),
      maxClaimsPerYear: intOrNull(r.maxClaimsPerYear),
      blockLength: blockOn ? intOrNull(r.blockLength) : null,
      blockUnit: blockOn ? (str(r.blockUnit) || 'year') : null,
      blockLimit: blockOn ? numOrNull(r.blockLimit) : null,
      blockStartOn: null,
    };
  });
}

export async function setGradeClaimLimitsAction(formData: FormData) {
  const s = await getSession();
  const gradeId = String(formData.get('gradeId') ?? '').trim() || null;

  // ⚠️ redirect() SIGNALS BY THROWING, so there is exactly ONE redirect in this function and it is the
  // last statement. An earlier `redirect()` inside the try would be caught by the catch below and turned
  // into an error banner reading "NEXT_REDIRECT" — the trap this repo has hit before.
  let rows: GradeLimitEdit[] = [];
  try {
    rows = rowsFrom(formData);
  } catch (e) {
    fail(e);
  }
  if (rows.length > 0) {
    try {
      await setGradeClaimLimits(s, { gradeId, effectiveFrom: String(formData.get('effectiveFrom')), rows });
    } catch (e) {
      fail(e);
    }
  }
  revalidatePath(BASE);
  // Nothing edited is NOT an error: an admin who opened a grade to look and pressed Save should be told
  // nothing happened, not shown a red banner — and certainly not have nine identical versions written
  // into an append-only table.
  const message = rows.length === 0 ? 'No changes to save' : 'Claim limits saved';
  // The limits screen is grade-first and its selection lives in ?gradeId=. Redirecting back without it
  // would bounce the admin to the company-wide view after every save, which reads as the save having gone
  // to the wrong grade.
  const back = gradeId ? `${BASE}?gradeId=${encodeURIComponent(gradeId)}` : BASE;
  redirect(`${back}${gradeId ? '&' : '?'}toast=${encodeURIComponent(message)}`);
}
