/**
 * Tab retention after save (feedback bd2f0bb2) — the Personnel (Admin) employee-detail page must remain on the
 * tab the HR admin was editing after a save, instead of resetting to the first tab (Profile).
 *
 * Mechanism under test (server side): the client tab shell injects a hidden `tab` field into whichever
 * per-section <form> submits, so the field arrives in the action's FormData. Each save action then appends
 * `&tab=<key>` to its post-save redirect (and to its error redirect), and the page re-hydrates the shell from
 * the `?tab=` param — landing back on the originating tab. When the field is absent (legacy submit / no tab),
 * the redirect carries NO tab param → the page falls back to the first tab exactly as before (backward compat).
 *
 * This asserts the redirect URLs directly for a representative action from EACH redirect path:
 *   • setPersonAction        → withTab() helper in actions.ts
 *   • addCp38Action          → back() helper in cp38-actions.ts
 *   • assignPolicyAction      → tabSuffix in payroll-policy/actions.ts
 *
 * next/navigation redirect + next/cache are stubbed inert; requireAdmin / getSession are stubbed to the seeded
 * admin so the real FormData→service→redirect path runs against the real DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

// Hoisted so the vi.mock factories (lifted to top-of-file) can safely reference the redirect spy.
const { redirect, sess } = vi.hoisted(() => ({
  redirect: vi.fn((_url: string) => undefined),
  sess: { ctx: null as unknown },
}));
vi.mock('next/navigation', () => ({ redirect, notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('../lib/authz', async (importActual) => {
  const actual = await importActual<typeof import('../lib/authz')>();
  return { ...actual, requireAdmin: vi.fn(async () => sess.ctx) };
});
// assignPolicyAction (payroll-policy) resolves its session via getSession(), not requireAdmin().
vi.mock('../lib/session', async (importActual) => {
  const actual = await importActual<typeof import('../lib/session')>();
  return { ...actual, getSession: vi.fn(async () => sess.ctx) };
});
// getTranslations is a server-only next-intl API unavailable in the test runner; stub it to echo the key so
// assignPolicyAction's success toast resolves without a request context.
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { setPersonAction } from '../app/admin/personnel/[employmentId]/actions';
import { addCp38Action } from '../app/admin/personnel/[employmentId]/cp38-actions';
import { assignPolicyAction } from '../app/admin/payroll-policy/actions';

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

const lastRedirect = () => redirect.mock.calls.at(-1)?.[0] as string;

describe('Personnel — retain current tab after save (bd2f0bb2)', () => {
  let base: Base;
  let employmentId: string;
  let personId: string;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    const a = adminCtx(base);
    sess.ctx = a;
    const emp = await hireEmployee(a, {
      person: { fullName: 'Tab Keeper', primaryEmail: `tab${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    employmentId = emp.employmentId;
    personId = emp.personId;
    redirect.mockClear();
  });
  afterAll(async () => {
    await closeAll();
  });

  const person = (tab?: string) =>
    fd({
      employmentId,
      personId,
      fullName: 'Tab Keeper',
      primaryEmail: `tab${randomUUID()}@acme.test`,
      employeeCode: '',
      gradeId: '',
      ...(tab === undefined ? {} : { tab }),
    });

  it('setPersonAction success redirect carries the originating tab (not Profile)', async () => {
    await setPersonAction(person('job'));
    const url = lastRedirect();
    expect(url).toContain('toast=Saved');
    expect(url).toContain('&tab=job');
  });

  it('setPersonAction with NO tab field falls back to the tab-less URL (legacy → first tab)', async () => {
    await setPersonAction(person(undefined));
    const url = lastRedirect();
    expect(url).toContain('toast=Saved');
    expect(url).not.toContain('tab=');
  });

  it('setPersonAction error redirect also preserves the tab', async () => {
    // Force the service to throw: a non-existent personId makes updatePerson raise "Person not found", so the
    // action takes the catch → error redirect path. (redirect() is stubbed inert here, so execution does not
    // halt at the throw the way it would in production — we therefore assert that SOME redirect call carried
    // both the error and the tab, rather than only inspecting the last call.)
    await setPersonAction(
      fd({ employmentId, personId: randomUUID(), fullName: 'X', primaryEmail: 'x@acme.test', tab: 'payroll' }),
    );
    const calls = redirect.mock.calls.map((c) => c[0]);
    expect(calls.some((u) => u.includes('error=') && u.includes('&tab=payroll'))).toBe(true);
  });

  it('addCp38Action (sibling back() helper) preserves the tab on save', async () => {
    await addCp38Action(
      fd({ employmentId, cp38Ref: 'CP38-001', amount: '100', validFrom: '2026-01-01', tab: 'payroll' }),
    );
    const url = lastRedirect();
    expect(url).toContain('toast=Saved');
    expect(url).toContain('&tab=payroll');
  });

  it('assignPolicyAction (payroll-policy action) preserves the tab on save', async () => {
    // Clearing (empty policyId) is a valid assign that succeeds without needing a seeded policy row.
    await assignPolicyAction(fd({ employmentId, policyId: '', tab: 'payroll' }));
    const url = lastRedirect();
    expect(url).toContain('toast=');
    expect(url).toContain('&tab=payroll');
  });
});
