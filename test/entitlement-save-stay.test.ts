/**
 * Retain current page after saving a leave entitlement adjustment (#9b0503ac).
 *
 * The reported bug: saving an entitlement adjustment (the under-2 / 2–5 / over-5 service-band day
 * values, a policy add/edit, or a policy removal) bounced HR off the Entitlements config panel to
 * /admin/leave, losing the selected leave type mid-configuration. The fix: every entitlement-area
 * save's SUCCESS redirect targets /admin/leave/entitlements carrying BOTH the success toast
 * (?toast=…, rendered by the globally mounted ToastFromQuery) and the workspace's selection anchor
 * (#type-<leaveTypeId>, the hash contract LeaveTypeWorkspace applies on mount/hashchange) — so the
 * admin lands back on the exact leave type + step they were on. Failures also stay on the
 * Entitlements page (?error=, no fragment — it would swallow the query, the b9dac2d1 precedent).
 *
 * Redirect-target assertions per action (the plan's test note):
 *  - upsertSchemeEntitlementAction  (the reporter's exact flow: scheme service-band day values)
 *  - updateLeavePolicyAction        (policy edit incl. the ServiceBandEditor's enclosing form)
 *  - createLeavePoliciesMultiAction (policy add)
 *  - deleteLeavePolicyAction        (policy remove)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// redirect() in real Next.js THROWS to abort the request; the mock must throw too, or execution
// would fall through. The sentinel carries the target path so tests assert the redirect TARGET.
let actionCtx: import('../db/client').SessionContext | null = null;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
const redirectSpy = vi.fn((path: string): never => {
  throw new RedirectError(path);
});
const revalidateSpy = vi.fn((_path: string) => undefined);
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => actionCtx) }));
// requireAdmin() (Clerk/session) is unavailable in the harness — return the seeded admin ctx.
vi.mock('../lib/authz', () => ({ requireAdmin: vi.fn(async () => actionCtx) }));
vi.mock('next/navigation', () => ({ redirect: (p: string) => redirectSpy(p), notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidateSpy(p), revalidateTag: vi.fn(() => undefined) }));
// The actions localise toasts before redirecting; the key-echoing fake keeps the URL assertable.
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

import { randomUUID } from 'node:crypto';
import { createLeavePolicy } from '../core/admin';
import { createBenefitScheme } from '../core/benefit-scheme';
import {
  createLeavePoliciesMultiAction,
  deleteLeavePolicyAction,
  updateLeavePolicyAction,
  upsertSchemeEntitlementAction,
} from '../app/admin/actions';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const ENTITLEMENTS = '/admin/leave/entitlements';

/** Run a server action that ends in redirect() (throws RedirectError here) and return the target path. */
async function captureRedirect(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof RedirectError) return e.path;
    throw e;
  }
  throw new Error('expected the action to redirect, but it did not');
}

const fd = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** The per-type table's three service bands (under 2 / 2–5 / over 5 years). */
const tier = (d0: number, d1: number, d2: number) => [
  { fromYears: 0, toYears: 2, days: d0 },
  { fromYears: 2, toYears: 5, days: d1 },
  { fromYears: 5, toYears: null, days: d2 },
];

let b: Base;

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
  revalidateSpy.mockClear();
});

describe('9b0503ac — entitlement saves stay on the Entitlements panel (toast + #type anchor)', () => {
  it('upsertSchemeEntitlementAction (service-band day values) redirects back to the same type with the success toast', async () => {
    const scheme = await createBenefitScheme(adminCtx(b), {
      companyId: b.companyId,
      employmentType: 'full_time',
      name: `Stay Scheme ${randomUUID().slice(0, 8)}`,
      status: 'active',
    });
    const target = await captureRedirect(() =>
      upsertSchemeEntitlementAction(
        fd({
          benefitSchemeId: scheme.id,
          leaveTypeId: b.annualLeaveTypeId,
          serviceBands: JSON.stringify(tier(12, 16, 20)),
        }),
      ),
    );
    expect(target.startsWith(`${ENTITLEMENTS}?toast=`)).toBe(true);
    expect(target).toContain('entitlementUpdatedToast');
    expect(target.endsWith(`#type-${b.annualLeaveTypeId}`)).toBe(true);
    expect(revalidateSpy).toHaveBeenCalledWith(ENTITLEMENTS);
  });

  it('updateLeavePolicyAction (policy edit / ServiceBandEditor form) stays on the panel — not /admin/leave', async () => {
    const created = await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 14,
      validFrom: '2026-01-01',
    });
    const target = await captureRedirect(() =>
      updateLeavePolicyAction(
        fd({
          id: created.id,
          leaveTypeId: b.annualLeaveTypeId, // the panel's hidden anchor field
          annualDays: '16',
          validFrom: '2026-01-01',
          serviceBandsRendered: '1',
          serviceBands: JSON.stringify(tier(16, 18, 21)),
        }),
      ),
    );
    // The old bug: redirect(`/admin/leave?toast=…`) — a different route, bouncing HR off the panel.
    expect(target.startsWith(`${ENTITLEMENTS}?toast=`)).toBe(true);
    expect(target.endsWith(`#type-${b.annualLeaveTypeId}`)).toBe(true);
    // No employees seeded ⇒ no recalc blast radius ⇒ the reporter's plain success confirmation.
    expect(target).toContain('entitlementUpdatedToast');
    expect(revalidateSpy).toHaveBeenCalledWith(ENTITLEMENTS);
  });

  it('createLeavePoliciesMultiAction (policy add) anchors back to the hosting leave type', async () => {
    const target = await captureRedirect(() =>
      createLeavePoliciesMultiAction(
        fd({
          leaveTypeId: b.annualLeaveTypeId,
          annualDays: '14',
          validFrom: '2026-01-01',
        }),
      ),
    );
    expect(target.startsWith(`${ENTITLEMENTS}?toast=`)).toBe(true);
    expect(target).toContain('entitlementUpdatedToast');
    expect(target.endsWith(`#type-${b.annualLeaveTypeId}`)).toBe(true);
  });

  it('deleteLeavePolicyAction (policy remove) also stays, with the removal toast', async () => {
    const created = await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 14,
      validFrom: '2026-01-01',
    });
    const target = await captureRedirect(() =>
      deleteLeavePolicyAction(fd({ id: created.id, leaveTypeId: b.annualLeaveTypeId })),
    );
    expect(target.startsWith(`${ENTITLEMENTS}?toast=`)).toBe(true);
    expect(target).toContain('entitlementRemovedToast');
    expect(target.endsWith(`#type-${b.annualLeaveTypeId}`)).toBe(true);
  });

  it('failures stay on the Entitlements page too (?error=, no fragment) instead of bouncing to /admin/leave', async () => {
    const target = await captureRedirect(() =>
      updateLeavePolicyAction(
        fd({
          id: randomUUID(), // no such policy — the service throws
          leaveTypeId: b.annualLeaveTypeId,
          annualDays: '16',
          validFrom: '2026-01-01',
        }),
      ),
    );
    expect(target.startsWith(`${ENTITLEMENTS}?error=`)).toBe(true);
    expect(target).not.toContain('#type-'); // a fragment before ?error= would swallow the query
  });
});
