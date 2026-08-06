/**
 * Retain current page after saving a leave entitlement adjustment (#9b0503ac).
 *
 * The reported bug: saving an entitlement change bounced HR off the config panel to /admin/leave, losing
 * the selected leave type mid-configuration. The fix is a URL contract, and it is fragile in a specific
 * way — the success redirect must carry the toast in the QUERY and the workspace's selection anchor as a
 * FRAGMENT AFTER it (a fragment before `?toast=` swallows the query and ToastFromQuery renders nothing),
 * and failures must stay on the same screen with `?error=` and NO fragment at all (the b9dac2d1
 * precedent). None of that is visible from a passing save; only a test that reads the redirect TARGET
 * sees it.
 *
 * ── 6e9a126e RELEASE THREE — REPOINTED, AND ONE HALF OF IT SPLIT IN TWO ──────────────────────────────
 *
 * The four actions this file named are gone with the layer they wrote: upsertSchemeEntitlementAction,
 * updateLeavePolicyAction, createLeavePoliciesMultiAction and deleteLeavePolicyAction. The BEHAVIOUR they
 * were here to pin did not go anywhere — an entitlement save still has to return the operator to the
 * screen they saved on — so the file is repointed at the writes that replaced them. What it must not do
 * is quietly assume the target is the same, because it is NOT, and the difference is deliberate:
 *
 *   • The entitlement WRITES (tables + eligibility) moved to their own screen and return to
 *     ENTITLEMENT_TEMPLATES via `okToast`. Steps 1 and 2 are one screen and an operator writing a table
 *     then assigning it must not be bounced into the Leave Type workspace between them — see
 *     app/admin/_redirects.ts, which says so at the constant. These carry a toast and NO fragment.
 *
 *   • The #type-<id> ANCHOR CONTRACT IS STILL LIVE and still needs a guard, so it is repointed rather
 *     than dropped: `okEntitlements` now has exactly ONE caller left, setLeaveTypeRulesAction, which is
 *     an entitlement-area save INSIDE the leave-type workspace — the reporter's own flow. Deleting the
 *     anchor assertions along with the four dead actions would have left the fragile half of the URL
 *     contract (fragment AFTER query, empty id degrades to the bare route) with no test at all.
 *
 * The templates actions had NO redirect coverage before this — nothing in test/ referenced them — so
 * this is a repoint that also closes a gap the new screen shipped with.
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
import { listEntitlementTemplates } from '../core/entitlement-template';
import { setLeaveTypeRulesAction } from '../app/admin/actions';
import {
  createEligibilityRuleAction,
  createEntitlementTemplateAction,
  retireEntitlementTemplateAction,
  updateEntitlementTemplateAction,
} from '../app/admin/leave/entitlements/templates/actions';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const ENTITLEMENTS = '/admin/leave/entitlements';
const TEMPLATES = '/admin/leave/entitlements/templates';

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

/** The three service bands the entitlement editors post as one JSON field (under 2 / 2–5 / over 5 years). */
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

/** Create a table through the real action and hand back its lineage id (the edit/retire handle). */
async function seedTemplate(name: string): Promise<{ lineageId: string; name: string }> {
  await captureRedirect(() =>
    createEntitlementTemplateAction(
      fd({
        leaveTypeId: b.annualLeaveTypeId,
        name,
        serviceBands: JSON.stringify(tier(12, 16, 20)),
        validFrom: '2026-01-01',
      }),
    ),
  );
  const rows = await listEntitlementTemplates(adminCtx(b), {});
  const row = rows.find((r) => r.name === name)!;
  return { lineageId: row.lineageId, name };
}

describe('9b0503ac — entitlement saves stay on the screen they were made on', () => {
  it('createEntitlementTemplateAction (the day table) redirects back to the Entitlement Tables screen with its toast', async () => {
    const name = `Stay Table ${randomUUID().slice(0, 8)}`;
    const target = await captureRedirect(() =>
      createEntitlementTemplateAction(
        fd({
          leaveTypeId: b.annualLeaveTypeId,
          name,
          serviceBands: JSON.stringify(tier(12, 16, 20)),
          validFrom: '2026-01-01',
        }),
      ),
    );
    // The old bug in its current form would be a redirect to /admin/leave or to ENTITLEMENTS — either one
    // takes the operator away from the table they were typing.
    expect(target.startsWith(`${TEMPLATES}?toast=`)).toBe(true);
    expect(decodeURIComponent(target)).toContain(name);
    expect(revalidateSpy).toHaveBeenCalledWith(TEMPLATES);
  });

  it('updateEntitlementTemplateAction (an edit, which supersedes) stays on the same screen', async () => {
    const { lineageId, name } = await seedTemplate(`Edit Table ${randomUUID().slice(0, 8)}`);
    redirectSpy.mockClear();
    revalidateSpy.mockClear();
    const target = await captureRedirect(() =>
      updateEntitlementTemplateAction(
        fd({
          lineageId,
          name,
          serviceBands: JSON.stringify(tier(14, 18, 22)),
          validFrom: '2027-01-01', // strictly after the running version — an edit is a supersede
        }),
      ),
    );
    expect(target.startsWith(`${TEMPLATES}?toast=`)).toBe(true);
    expect(decodeURIComponent(target)).toContain(name);
    expect(revalidateSpy).toHaveBeenCalledWith(TEMPLATES);
  });

  it('createEligibilityRuleAction (step 2 — who gets it) does NOT bounce back to the Leave Type workspace', async () => {
    // This is the case the ENTITLEMENT_TEMPLATES constant exists for: an operator who has just written a
    // table and is now assigning it must land back beside it, not in the leave-type panel.
    const { lineageId } = await seedTemplate(`Rule Table ${randomUUID().slice(0, 8)}`);
    redirectSpy.mockClear();
    const ruleName = `Executives ${randomUUID().slice(0, 8)}`;
    const target = await captureRedirect(() =>
      createEligibilityRuleAction(
        fd({ name: ruleName, templateLineageId: lineageId, validFrom: '2026-01-01' }),
      ),
    );
    expect(target.startsWith(`${TEMPLATES}?toast=`)).toBe(true);
    expect(target.startsWith(`${ENTITLEMENTS}?`)).toBe(false);
    expect(decodeURIComponent(target)).toContain(ruleName);
  });

  it('retireEntitlementTemplateAction (stop from a date) also stays, with the stopped toast', async () => {
    const { lineageId, name } = await seedTemplate(`Stop Table ${randomUUID().slice(0, 8)}`);
    redirectSpy.mockClear();
    const target = await captureRedirect(() =>
      retireEntitlementTemplateAction(fd({ lineageId, name, validTo: '2027-01-01' })),
    );
    expect(target.startsWith(`${TEMPLATES}?toast=`)).toBe(true);
    expect(decodeURIComponent(target)).toContain('Stopped');
    expect(decodeURIComponent(target)).toContain(name);
  });

  it('a templates-screen failure stays on the templates screen (?error=, and no fragment to swallow it)', async () => {
    const target = await captureRedirect(() =>
      updateEntitlementTemplateAction(
        fd({
          lineageId: randomUUID(), // no such table — the service throws
          name: 'Nope',
          serviceBands: JSON.stringify(tier(12, 16, 20)),
          validFrom: '2027-01-01',
        }),
      ),
    );
    expect(target.startsWith(`${TEMPLATES}?error=`)).toBe(true);
    expect(target).not.toContain('#'); // a fragment before ?error= would swallow the query
  });
});

describe('9b0503ac — the #type anchor contract, on its one surviving caller', () => {
  // okEntitlements is down to a single call site (app/admin/actions.ts, setLeaveTypeRulesAction). It is
  // still an entitlement-area save inside the leave-type workspace — the reporter's exact flow — so the
  // anchor half of the contract keeps a guard here rather than disappearing with the four dead actions.
  it('setLeaveTypeRulesAction returns to the panel with the toast AND the #type selection anchor', async () => {
    const target = await captureRedirect(() =>
      setLeaveTypeRulesAction(fd({ leaveTypeId: b.annualLeaveTypeId })),
    );
    // The old bug: redirect(`/admin/leave?toast=…`) — a different route, bouncing HR off the panel.
    expect(target.startsWith(`${ENTITLEMENTS}?toast=`)).toBe(true);
    expect(target).toContain('entitlementUpdatedToast');
    // THE FRAGILE PART: the fragment rides AFTER the query, or ToastFromQuery never sees ?toast=.
    expect(target.endsWith(`#type-${b.annualLeaveTypeId}`)).toBe(true);
    expect(target.indexOf('#')).toBeGreaterThan(target.indexOf('?'));
    expect(revalidateSpy).toHaveBeenCalledWith(ENTITLEMENTS);
  });
});
