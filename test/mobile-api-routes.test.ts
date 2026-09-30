/**
 * ADR-0088 §2 — the v1 read endpoints, called as Next calls them (`GET(request)`), against the database.
 *
 * The session is the ONE thing mocked: `getMobileSession` is proven separately, end to end, in
 * test/mobile-api-session.test.ts. Here each case swaps the caller and asserts what crosses the wire:
 * what one employee may never see of another's, what an administrator may never see through their own
 * phone, and the fields no response may carry however the underlying core read grows.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { closeBatch, createBatch, generatePayslips } from '../core/payroll';
import { myEmployments, myPayslips } from '../core/read';
import { myLeaveDashboard } from '../core/my-leave';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { hireEmployee } from '../core/org';
import { AuthRequiredError } from '../lib/auth-errors';
import { todayInKualaLumpur } from '../lib/hr-date';
import { mobileRoute } from '../lib/mobile-api/handler';
import {
  adminCtx,
  closeAll,
  createAppUser,
  harnessSnapshot,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  seedEntitlement,
  setModule,
  type Base,
} from './harness';

let caller: SessionContext;
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session')>()),
  getMobileSession: async () => caller,
}));

const { GET: getMe } = await import('../app/api/mobile/v1/me/route');
const { GET: getPayslips } = await import('../app/api/mobile/v1/payslips/route');
const { GET: getLeave } = await import('../app/api/mobile/v1/leave/route');
const { GET: getNotifications } = await import('../app/api/mobile/v1/notifications/route');

const call = async (handler: (r: Request) => Promise<Response>, path: string) => {
  const res = await handler(new Request(`http://localhost/api/mobile/v1/${path}`));
  const text = await res.text();
  return { res, text, body: JSON.parse(text) as Record<string, unknown> & { items?: Array<Record<string, unknown>> } };
};

let base: Base;
let icSeq = 0;
const nextIc = () => `9204040${String(30000 + icSeq++).slice(-5)}`;
const year = () => Number(todayInKualaLumpur().slice(0, 4));

/** A distinctive salary, so "it is not in the response" cannot be satisfied by an unrelated figure. */
const BASIC = '7345.67';

async function hire(name: string, basic = BASIC) {
  const a = adminCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: Number(basic), monthlyAllowance: 412.34, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
  const userId = await createAppUser(base.tenantId, e.personId, 'employee');
  const ctx: SessionContext = {
    tenantId: base.tenantId,
    userId,
    roles: ['employee'],
    personId: e.personId,
    entitlements: harnessSnapshot(base.tenantId),
  };
  return { ...e, ctx };
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('GET /me', () => {
  it('names the caller’s active employments and carries no pay figure, although the core read does', async () => {
    const a = await hire('Me Aisyah');
    caller = a.ctx;
    // Non-vacuity: the source row genuinely carries the salary this test says must not escape.
    const [src] = await myEmployments(a.ctx);
    expect(Number(src.basic)).toBe(Number(BASIC));

    const { res, text, body } = await call(getMe, 'me');
    expect(res.status).toBe(200);
    expect(body.apiVersion).toBe('v1');
    expect(body.employments).toEqual([
      expect.objectContaining({ employmentId: a.employmentId, company: 'Acme Sdn Bhd' }),
    ]);
    expect(body.roles).toEqual(['employee']);
    expect(text).not.toContain('7345');
    expect(text).not.toContain('412.34');
    for (const k of ['basic', 'allowance', 'costAllocation', 'compensation']) expect(text).not.toContain(`"${k}"`);
  });
});

describe('GET /payslips', () => {
  it('lists only RELEASED slips: a processed run is invisible, closing it publishes it', async () => {
    const a = await hire('Slip Ahmad');
    caller = a.ctx;
    const admin = adminCtx(base);
    const { batchId } = await createBatch(admin, { companyId: base.companyId, payPeriod: '2026-03' });
    await generatePayslips(admin, { batchId });

    // Non-vacuity: the row EXISTS and core reports it unreleased — so an empty list below is the release
    // rule, not a missing slip or an RLS miss.
    const raw = await myPayslips(a.ctx, [a.employmentId]);
    expect(raw).toHaveLength(1);
    expect(raw[0].released).toBe(false);
    expect((await call(getPayslips, 'payslips')).body).toEqual({ enabled: true, items: [] });

    await closeBatch(admin, { batchId });
    const { body } = await call(getPayslips, 'payslips');
    expect(body.items).toHaveLength(1);
    expect(body.items![0]).toMatchObject({ id: raw[0].id, payPeriod: '2026-03', company: 'Acme Sdn Bhd' });
    expect(body.items![0].net).toMatch(/^-?\d+(\.\d+)?$/); // a decimal string, never a float
    expect(Object.keys(body.items![0]).sort()).toEqual(['company', 'deductions', 'gross', 'id', 'net', 'payPeriod', 'runType']);
  });

  it('never lists a colleague’s slip from the same run', async () => {
    const a = await hire('Slip Beng');
    const b = await hire('Slip Chitra', '9876.54');
    const admin = adminCtx(base);
    const { batchId } = await createBatch(admin, { companyId: base.companyId, payPeriod: '2026-04' });
    await generatePayslips(admin, { batchId });
    await closeBatch(admin, { batchId });

    caller = a.ctx;
    const mine = await call(getPayslips, 'payslips');
    caller = b.ctx;
    const theirs = await call(getPayslips, 'payslips');
    expect(mine.body.items).toHaveLength(1);
    expect(theirs.body.items).toHaveLength(1);
    expect(mine.body.items![0].id).not.toBe(theirs.body.items![0].id);
    const [bSlip] = await owner.db
      .select({ id: schema.payslip.id })
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, b.employmentId));
    expect(mine.text).not.toContain(bSlip.id);
  });

  it('answers enabled:false and reads nothing when the tenant does not hold Payroll', async () => {
    const a = await hire('Slip Dina');
    // The snapshot could not be resolved ⇒ every billable module reads off (isModuleEnabledOrFalse).
    caller = { ...a.ctx, entitlements: undefined, entitlementsError: 'test: no snapshot' };
    expect((await call(getPayslips, 'payslips')).body).toEqual({ enabled: false, items: [] });
  });
});

describe('GET /notifications', () => {
  it('answers enabled:false and reads nothing when the tenant does not hold Notifications', async () => {
    const a = await hire('Notif Zara');
    await owner.db.insert(schema.notification).values({
      tenantId: base.tenantId, recipientEmploymentId: a.employmentId, kind: 'test', title: 'Hidden', body: 'z', severity: 'info',
    });
    caller = a.ctx;
    expect((await call(getNotifications, 'notifications')).body).toEqual({ enabled: false, unread: 0, items: [] });
  });

  it('shows each person only their own — administrators included', async () => {
    await setModule(base.tenantId, 'notifications', 'active');
    const a = await hire('Notif Aida');
    const b = await hire('Notif Bala');
    await owner.db.insert(schema.notification).values([
      { tenantId: base.tenantId, recipientEmploymentId: a.employmentId, kind: 'test', title: 'For Aida', body: 'a', severity: 'info' },
      { tenantId: base.tenantId, recipientEmploymentId: b.employmentId, kind: 'test', title: 'For Bala', body: 'b', severity: 'info' },
    ]);

    caller = a.ctx;
    const mine = await call(getNotifications, 'notifications');
    expect(mine.body.enabled).toBe(true);
    expect(mine.body.unread).toBe(1);
    expect(mine.body.items!.map((n) => n.title)).toEqual(['For Aida']);
    expect(mine.text).not.toContain('For Bala');

    caller = adminCtx(base); // an HR admin's phone: their own bell, not the tenant's
    const adminView = await call(getNotifications, 'notifications');
    expect(adminView.body.enabled).toBe(true);
    expect(adminView.body.items).toEqual([]);
  });
});

describe('GET /leave', () => {
  it('returns the web dashboard’s card fronts, figure for figure, and no breakdown', async () => {
    const a = await hire('Leave Anis');
    caller = a.ctx;
    await seedEntitlement(adminCtx(base), { leaveTypeId: base.annualLeaveTypeId, annualDays: 14, validFrom: `${year() - 1}-01-01` });

    const today = todayInKualaLumpur();
    const dash = await myLeaveDashboard(a.ctx, a.employmentId, { today, locale: 'en' });
    expect(dash.cards.length).toBeGreaterThan(0); // non-vacuity: there is a card to compare

    const { body, text } = await call(getLeave, 'leave');
    expect(body.employmentId).toBe(a.employmentId);
    const cards = body.cards as Array<Record<string, unknown>>;
    expect(cards.map((c) => c.leaveTypeId)).toEqual(dash.cards.map((c) => c.leaveTypeId));
    for (const [i, c] of cards.entries()) {
      const d = dash.cards[i];
      for (const k of ['balance', 'canApplyFor', 'taken', 'pending', 'entitlement', 'earnedSoFar'] as const) {
        expect(c[k], `${d.leaveType}.${k}`).toEqual(d[k]);
      }
    }
    expect(text).not.toContain('"breakdown"');
    expect(text).not.toContain('"essView"');
  });

  it('refuses an employmentId that is not one of the caller’s own, before any read', async () => {
    const a = await hire('Leave Bakar');
    const b = await hire('Leave Cheng');
    caller = a.ctx;
    for (const q of [`employmentId=${b.employmentId}`, 'employmentId=not-a-uuid']) {
      const { res, body } = await call(getLeave, `leave?${q}`);
      expect(res.status, q).toBe(400);
      expect(body).toEqual({ error: 'bad_request' });
    }
    // And the caller's own id is accepted.
    expect((await call(getLeave, `leave?employmentId=${a.employmentId}`)).res.status).toBe(200);
  });
});

describe('mobileRoute — the wrapper every endpoint goes through', () => {
  const Ok = z.object({ ok: z.literal(true) });
  const req = () => new Request('http://localhost/api/mobile/v1/x');

  it('maps a credential fault to 401 auth_required, and nothing else', async () => {
    const h = mobileRoute(Ok, async () => ({ ok: true as const }), async () => {
      throw new AuthRequiredError('expired');
    });
    const res = await h(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'auth_required' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('maps an availability fault during sign-in to 503 — an outage must not sign the employee out', async () => {
    const h = mobileRoute(Ok, async () => ({ ok: true as const }), async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
    });
    const res = await h(req());
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(JSON.stringify({ error: 'unavailable' }));
  });

  it('answers a handler failure with a bare code — no message, stack or SQL reaches the phone', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = mobileRoute(Ok, async () => {
      throw new Error('relation "payslip" does not exist');
    }, async () => adminCtx(base));
    const res = await h(req());
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(JSON.stringify({ error: 'internal' }));
    spy.mockRestore();
  });

  it('refuses to send a body that breaks its contract, and strips a field the contract does not name', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = mobileRoute(Ok, async () => ({ ok: 'yes' }) as never, async () => adminCtx(base));
    expect((await broken(req())).status).toBe(500);
    const leaky = mobileRoute(Ok, async () => ({ ok: true as const, basicSalary: '9999.99' }), async () => adminCtx(base));
    const res = await leaky(req());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    spy.mockRestore();
  });
});

describe('every mobile route goes through mobileRoute (the share-gate bypass depends on it)', () => {
  const root = new URL('../app/api/mobile/', import.meta.url).pathname;
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f === 'route.ts') routes.push(p);
    }
  };
  walk(root);

  it('finds the routes it is guarding', () => {
    expect(routes.length).toBeGreaterThanOrEqual(4);
  });

  it.each(routes.map((r) => [r.slice(root.length)]))('%s', (rel) => {
    const src = readFileSync(join(root, rel), 'utf8');
    const exportsAll = src.match(/^export\s+/gm) ?? [];
    const exportsWrapped = src.match(/^export const (GET|POST|PUT|PATCH|DELETE) = mobileRoute\(/gm) ?? [];
    expect(exportsWrapped.length, 'every export is a method handler built by mobileRoute').toBe(exportsAll.length);
    expect(src, 'no route resolves a session itself').not.toMatch(/\bgetSession\b|\bgetMobileSession\b|cookies\(/);
  });
});
