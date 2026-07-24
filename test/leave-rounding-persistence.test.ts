/**
 * Rounding Method — persistence round-trip through the server actions (feedback b81d3c52).
 *
 * `leave_policy.accrual` is a JSONB blob that createLeavePolicy / updateLeavePolicy rebuild WHOLESALE on
 * every save, so any key the submitting form did not post used to be silently DROPPED. This ticket makes the
 * Rounding Method REMEMBER itself with a TRI-STATE marker (`roundingMethodRendered`, mirroring serviceBands)
 * instead of the fragile hidden pass-through input the codebase flagged as a footgun: a form that renders
 * the Rounding dropdown (the Earning Method front door + the multi-scope add form) posts the marker, so
 * 'none' CLEARS and 'up'/'down' SET; a form that does NOT render it (Carry Forward, Eligibility inline edit)
 * posts no marker and the writer PRESERVES the stored value.
 *
 * These are BEHAVIOURAL tests: they drive the real server actions with the exact FormData each form
 * submits and assert the stored JSONB, which is the regression a static "does the source contain a hidden
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
import { createJobGrade, createLeavePolicy } from '../core/admin';
import { createLeavePoliciesMultiAction, updateLeavePolicyAction } from '../app/admin/actions';
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

const accrualOf = async (policyId: string): Promise<Record<string, unknown>> => {
  const [row] = await owner.db
    .select({ accrual: schema.leavePolicy.accrual })
    .from(schema.leavePolicy)
    .where(eq(schema.leavePolicy.id, policyId));
  return (row?.accrual as Record<string, unknown>) ?? {};
};

const allAccruals = async (): Promise<Record<string, unknown>[]> => {
  const rows = await owner.db
    .select({ accrual: schema.leavePolicy.accrual })
    .from(schema.leavePolicy)
    .where(eq(schema.leavePolicy.leaveTypeId, b.annualLeaveTypeId));
  return rows.map((r) => (r.accrual as Record<string, unknown>) ?? {});
};

/** A policy already configured with Round Up, as HR would leave it after using the Earning Method form. */
const seededPolicy = () =>
  createLeavePolicy(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: 12,
    carryForwardMax: 5,
    roundingMethod: 'up',
    validFrom: '2026-01-01',
  });

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

describe('b81d3c52 · persistence — every writer preserves the stored Rounding Method', () => {
  it('the Earning Method front door SETS it (the reporter\'s configuration flow)', async () => {
    const created = await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      validFrom: '2026-01-01',
    });
    expect('roundingMethod' in (await accrualOf(created.id))).toBe(false);

    // EarningMethodForm: identity fields + FrontDoorPreservedCarry + the mapped method + the rendered
    // Rounding select. It RENDERS the dropdown, so it posts the tri-state marker roundingMethodRendered=1.
    await run(() =>
      updateLeavePolicyAction(
        fd({
          id: created.id,
          leaveTypeId: b.annualLeaveTypeId,
          annualDays: '12',
          validFrom: '2026-01-01',
          gradeId: '',
          companyId: '',
          carryBlockRendered: '1',
          carryForwardMax: '5',
          carryForwardExpiryMode: 'date',
          method: 'grant_on_hire_prorated',
          roundingMethodRendered: '1',
          roundingMethod: 'up',
        }),
      ),
    );
    expect(await accrualOf(created.id)).toMatchObject({ roundingMethod: 'up' });
  });

  it('the Carry Forward front door PRESERVES it — a carry-only save (no marker) does NOT wipe it', async () => {
    const created = await seededPolicy();
    // CarryPolicyForm: identity + preserved method + the carry block. It does NOT render the Rounding
    // dropdown, so it posts NO roundingMethodRendered marker — the tri-state writer preserves the stored
    // 'up' (the former hidden roundingMethod pass-through input is gone).
    await run(() =>
      updateLeavePolicyAction(
        fd({
          id: created.id,
          leaveTypeId: b.annualLeaveTypeId,
          annualDays: '12',
          validFrom: '2026-01-01',
          gradeId: '',
          companyId: '',
          method: 'grant_on_hire_prorated',
          carryBlockRendered: '1',
          carryForwardEnabled: 'on',
          carryForwardMax: '9', // the field this form actually edits
          carryForwardExpiryMode: 'date',
        }),
      ),
    );
    const acc = await accrualOf(created.id);
    expect(acc).toMatchObject({ carryForwardMax: 9, roundingMethod: 'up' });
  });

  it('the Eligibility inline EDIT form PRESERVES it — a days/scope edit (no marker) does NOT wipe it', async () => {
    const created = await seededPolicy();
    // This form does not render the Rounding dropdown, so it posts no roundingMethodRendered marker — the
    // stored 'up' is preserved (no hidden pass-through input any more).
    await run(() =>
      updateLeavePolicyAction(
        fd({
          id: created.id,
          leaveTypeId: b.annualLeaveTypeId,
          annualDays: '16', // the field this form actually edits
          validFrom: '2026-01-01',
          gradeId: '',
          companyId: '',
          method: 'grant_on_hire_prorated',
          carryBlockRendered: '1',
          carryForwardMax: '5',
          carryForwardExpiryMode: 'date',
          serviceBandsRendered: '1',
          serviceBands: '',
        }),
      ),
    );
    expect(await accrualOf(created.id)).toMatchObject({ annualDays: 16, roundingMethod: 'up' });
  });

  it('PRESERVE PIN (tri-state): a save that omits the marker now PRESERVES the stored method — no hidden input needed', async () => {
    // INVERTED for this ticket: under the old forward-only contract an omitting save CLEARED the key (which
    // is why every form carried a hidden pass-through input). Now a save with no roundingMethodRendered
    // marker means "the form did not render the dropdown" ⇒ the writer PRESERVES the stored 'up'. This is
    // the whole point of removing the fragile hidden-input coupling.
    const created = await seededPolicy();
    await run(() =>
      updateLeavePolicyAction(
        fd({
          id: created.id,
          leaveTypeId: b.annualLeaveTypeId,
          annualDays: '12',
          validFrom: '2026-01-01',
          method: 'grant_on_hire_prorated',
        }),
      ),
    );
    expect(await accrualOf(created.id)).toMatchObject({ roundingMethod: 'up' });
  });

  it('picking No Rounding on the Earning Method form clears the stored key (marker present + none = clear)', async () => {
    const created = await seededPolicy();
    await run(() =>
      updateLeavePolicyAction(
        fd({
          id: created.id,
          leaveTypeId: b.annualLeaveTypeId,
          annualDays: '12',
          validFrom: '2026-01-01',
          method: 'grant_on_hire_prorated',
          carryBlockRendered: '1',
          carryForwardMax: '5',
          carryForwardExpiryMode: 'date',
          roundingMethodRendered: '1',
          roundingMethod: 'none',
        }),
      ),
    );
    expect('roundingMethod' in (await accrualOf(created.id))).toBe(false);
  });

  it('createLeavePoliciesMultiAction threads it onto EVERY fanned-out (company × grade) row', async () => {
    const exec = await createJobGrade(adminCtx(b), { code: 'EXEC', name: 'Executive' });
    const mgr = await createJobGrade(adminCtx(b), { code: 'MGR', name: 'Manager' });
    const f = fd({
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: '12.4',
      validFrom: '2026-01-01',
      // the multi-scope add form RENDERS the Rounding dropdown, so it posts the marker.
      roundingMethodRendered: '1',
      roundingMethod: 'down',
    });
    f.append('gradeIds', exec.id);
    f.append('gradeIds', mgr.id);
    await run(() => createLeavePoliciesMultiAction(f));

    const accruals = await allAccruals();
    expect(accruals.length).toBe(2);
    for (const acc of accruals) expect(acc).toMatchObject({ annualDays: 12.4, roundingMethod: 'down' });
  });

  it('createLeavePoliciesMultiAction omits the key when No Rounding is selected (marker present + none)', async () => {
    const f = fd({
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: '12',
      validFrom: '2026-01-01',
      roundingMethodRendered: '1',
      roundingMethod: 'none',
    });
    await run(() => createLeavePoliciesMultiAction(f));
    const accruals = await allAccruals();
    expect(accruals.length).toBe(1);
    expect('roundingMethod' in accruals[0]).toBe(false);
  });
});
