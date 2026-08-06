/**
 * Rounding — persistence round-trip through the server actions (b81d3c52, rewritten by 8fec719e).
 *
 * 8fec719e MOVED THE SURFACE THIS FILE GUARDS. Rounding is now a leave-TYPE rule with two choices (No
 * Rounding / Custom Rounding) and a band table, written by setLeaveTypeRulesAction. The per-policy
 * dropdown that used to write `leave_policy.accrual.roundingMethod` is GONE — it still offered Round Up
 * and Round Down, the choices this item removes, and it wrote them to a key the type-level overlay
 * ignores. What remains is:
 *
 *   §1 the TYPE-level round trip: the Earning Method form sets the method AND the table together, and the
 *      forms that do not render the rounding control preserve both.
 *
 * The tri-state marker (`roundingMethodRendered`, mirroring serviceBands) is what makes that work: a form
 * that RENDERS the Rounding dropdown posts the marker, so 'none' CLEARS and 'custom' SETS; a form that does
 * NOT render it (Carry Forward) posts no marker and the writer PRESERVES the stored value.
 *
 * ── 6e9a126e RELEASE THREE RETIRED §2 ────────────────────────────────────────────────────────────────
 * §2 was "the LEGACY JSONB copy is never written again, but never silently rebuilt away": six tests over
 * `leave_policy.accrual.roundingMethod`, driven through `createLeavePolicy`, `updateLeavePolicyAction` and
 * `createLeavePoliciesMultiAction`. Migration 0405 DROPPED `leave_policy` and all three writers are gone
 * with it, so there is no longer a second storage surface for a policy save to accidentally clear. The
 * property §2 protected — "a save that does not render the control must preserve what is stored" — is not
 * lost: it is exactly what §1's carry-only-save and malformed-payload tests assert, on the ONE surface that
 * now exists. What is genuinely gone is the guard that a crafted POST naming a retired method ('up') cannot
 * store it; that refusal still lives in `setLeaveTypeRules` (`isUserRoundingMethod`) and is pinned by
 * test/leave-rounding-bands.test.ts §2.
 *
 * These are BEHAVIOURAL tests: they drive the real server actions with the exact FormData each form
 * submits and assert what was stored, which is the regression a static "does the source contain a hidden
 * input" grep cannot catch on its own. The static guard lives in leave-entitlement-rounding.test.ts.
 *
 * Module mocks mirror test/entitlement-save-stay.test.ts (the established precedent for driving
 * app/admin/actions.ts from the harness): redirect() throws in real Next.js, so the mock must throw too.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let actionCtx: import('../db/client').SessionContext | null = null;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
const redirectSpy = vi.fn((path: string): never => {
  throw new RedirectError(path);
});
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => actionCtx) }));
// Keep the REST of lib/authz real — core/leave.ts (reached via the recalc kernel) imports isAdmin /
// hasGrantFor / withEffectiveGrants from it; only requireAdmin needs the harness session.
vi.mock('../lib/authz', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireAdmin: vi.fn(async () => actionCtx),
}));
vi.mock('next/navigation', () => ({ redirect: (p: string) => redirectSpy(p), notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

import * as schema from '../db/schema';
import type { RoundingBand } from '../core/leave-compute';
import { setLeaveTypeRulesAction } from '../app/admin/actions';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

/** Run an action that ends in redirect() (throws RedirectError here) and swallow the redirect. */
const run = async (fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (e) {
    if (e instanceof RedirectError) return;
    throw e;
  }
};

const fd = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** The leave TYPE's stored rounding, which is where 8fec719e put it. */
const typeRulesOf = async (): Promise<{ roundingMethod: string | null; roundingBands: unknown }> => {
  const [row] = await owner.db
    .select({ roundingMethod: schema.leaveType.roundingMethod, roundingBands: schema.leaveType.roundingBands })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
  return row!;
};

/** The two-row table that reproduces the retired "Nearest 0.5 day" default, as HR would type it. */
const HALF_DAY_TABLE: RoundingBand[] = [
  { from: 0, to: 0.5, result: 0 },
  { from: 0.5, to: 1, result: 0.5 },
];

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  actionCtx = adminCtx(b);
  redirectSpy.mockClear();
});

describe('§1 8fec719e — the TYPE-level round trip: method and table are saved together', () => {
  it('the Earning Method front door stores BOTH the method and the table', async () => {
    await run(() =>
      setLeaveTypeRulesAction(
        fd({
          leaveTypeId: b.annualLeaveTypeId,
          earningRendered: '1',
          method: 'grant_on_hire_prorated',
          roundingMethodRendered: '1',
          roundingMethod: 'custom',
          roundingBands: JSON.stringify(HALF_DAY_TABLE),
        }),
      ),
    );
    const r = await typeRulesOf();
    expect(r.roundingMethod).toBe('custom');
    expect(r.roundingBands).toEqual(HALF_DAY_TABLE);
  });

  it('a carry-only save posts no marker, so BOTH the method and the table are preserved', async () => {
    await run(() =>
      setLeaveTypeRulesAction(
        fd({
          leaveTypeId: b.annualLeaveTypeId,
          earningRendered: '1',
          method: 'grant_on_hire_prorated',
          roundingMethodRendered: '1',
          roundingMethod: 'custom',
          roundingBands: JSON.stringify(HALF_DAY_TABLE),
        }),
      ),
    );
    // CarryPolicyForm renders the OTHER half of the row and posts no roundingMethodRendered marker.
    await run(() =>
      setLeaveTypeRulesAction(
        fd({
          leaveTypeId: b.annualLeaveTypeId,
          carryBlockRendered: '1',
          carryForwardEnabled: 'on',
          carryForwardMax: '9',
          carryForwardExpiryMode: 'date',
        }),
      ),
    );
    const r = await typeRulesOf();
    expect(r.roundingMethod).toBe('custom');
    expect(r.roundingBands).toEqual(HALF_DAY_TABLE);
  });

  it('switching back to No Rounding clears the method but KEEPS the table the reporter typed', async () => {
    await run(() =>
      setLeaveTypeRulesAction(
        fd({
          leaveTypeId: b.annualLeaveTypeId,
          earningRendered: '1',
          method: 'earned_monthly',
          roundingMethodRendered: '1',
          roundingMethod: 'custom',
          roundingBands: JSON.stringify(HALF_DAY_TABLE),
        }),
      ),
    );
    // No Rounding: the editor stops rendering the table, so no roundingBands field is posted — which the
    // action reads as a clear. The METHOD is what turns rounding off; the table going with it is the
    // documented consequence of the form no longer rendering it.
    await run(() =>
      setLeaveTypeRulesAction(
        fd({
          leaveTypeId: b.annualLeaveTypeId,
          earningRendered: '1',
          method: 'earned_monthly',
          roundingMethodRendered: '1',
          roundingMethod: 'none',
        }),
      ),
    );
    const r = await typeRulesOf();
    expect(r.roundingMethod).toBeNull();
    expect(r.roundingBands).toBeNull();
    // …and the type did NOT go unruled — the earning method is still a rule, so nothing falls through to
    // the legacy grade policy. (The one-rule case is pinned in leave-type-rules-editor.test.ts.)
    const [row] = await owner.db
      .select({ accrualMethod: schema.leaveType.accrualMethod })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    expect(row!.accrualMethod).toBe('earned_monthly');
  });

  it('a malformed roundingBands payload PRESERVES the stored table rather than wiping it', async () => {
    // The serviceBandsField precedent: a client-side bug must not destroy work an administrator typed. A
    // table that DOES parse but contradicts itself is a different case and is refused loudly by the writer.
    await run(() =>
      setLeaveTypeRulesAction(
        fd({
          leaveTypeId: b.annualLeaveTypeId,
          earningRendered: '1',
          method: 'grant_on_hire_prorated',
          roundingMethodRendered: '1',
          roundingMethod: 'custom',
          roundingBands: JSON.stringify(HALF_DAY_TABLE),
        }),
      ),
    );
    await run(() =>
      setLeaveTypeRulesAction(
        fd({
          leaveTypeId: b.annualLeaveTypeId,
          earningRendered: '1',
          method: 'grant_on_hire_prorated',
          roundingMethodRendered: '1',
          roundingMethod: 'custom',
          roundingBands: '{not json',
        }),
      ),
    );
    expect((await typeRulesOf()).roundingBands).toEqual(HALF_DAY_TABLE);
  });
});
