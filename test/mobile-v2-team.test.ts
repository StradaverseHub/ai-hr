/**
 * M13 (D14) — team availability over a caller-chosen window, through the REAL route handler, core and RLS. Only bearer
 * session resolution is injected (as test/mobile-native-journeys.test.ts does).
 *
 * Pinned: the window bounds (default seven days; at most 31 days inclusive; inverted, malformed, repeated and
 * `to`-without-`from` are 400); a non-team caller gets enabled:false; membership is My Team's alone and no query
 * parameter widens or narrows it; dates come only from inside the window; no leave type, code, id or reason leaves the
 * server; v1 `team` keeps its shape for installed clients.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { AuthRequiredError } from '../lib/auth-errors';
import { todayInKualaLumpur } from '../lib/hr-date';
import { addCalendarDays, TEAM_WINDOW_MAX_DAYS, TeamAvailabilityV2 } from '../lib/mobile-api/v2/team';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let caller: SessionContext;
let blocked = false;
vi.mock('../lib/session', async (original) => ({ ...(await original<typeof import('../lib/session')>()), getMobileSession: async () => { if (blocked) throw new AuthRequiredError('revoked'); return caller; } }));
const availability = await import('../app/api/mobile/v2/team/availability/route');
const v1team = await import('../app/api/mobile/v1/team/route');

let base: Base;
const TODAY = todayInKualaLumpur();
const URL0 = 'https://hr.example.com/api/mobile/v2/team/availability';
const get = async (query = '') => { const r = await availability.GET(new Request(URL0 + query)); return { status: r.status, body: await r.json() }; };

async function hire(name: string, role: 'employee' | 'manager' | 'hr_admin' = 'employee', departmentId = base.deptA) {
  const e = await hireEmployee(adminCtx(base), { person: { fullName: name, primaryEmail: randomUUID() + '@m13-team.test' }, companyId: base.companyId, departmentId, employmentType: 'full_time', hiredOn: '2024-01-01' });
  const userId = await createAppUser(base.tenantId, e.personId, role);
  const ctx: SessionContext = { tenantId: base.tenantId, userId, personId: e.personId, roles: [role], grants: [{ role, companyId: base.companyId }], entitlements: harnessSnapshot(base.tenantId) };
  return { ...e, ctx };
}
/** One leave request on `dates`, each recorded per date, with a reason that must never leave the server. */
async function leave(employmentId: string, dates: string[], status: 'approved' | 'pending', durationType = 'full_day') {
  const sorted = [...dates].sort();
  const [request] = await owner.db.insert(schema.leaveRequest).values({ tenantId: base.tenantId, employmentId, leaveTypeId: base.annualLeaveTypeId, startDate: sorted[0], endDate: sorted.at(-1)!, days: String(dates.length), status, durationType, reason: 'SECRET M13 REASON' }).returning();
  await owner.db.insert(schema.leaveRequestDate).values(sorted.map((leaveDate) => ({ tenantId: base.tenantId, leaveRequestId: request.id, subjectEmploymentId: employmentId, leaveDate, days: '1', status })));
  return request.id;
}

let manager: Awaited<ReturnType<typeof hire>>, report: Awaited<ReturnType<typeof hire>>, second: Awaited<ReturnType<typeof hire>>, peer: Awaited<ReturnType<typeof hire>>;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); base = await seedBase(); blocked = false;
  manager = await hire('Mira Manager', 'manager'); report = await hire('Rafi Report'); second = await hire('Siti Second'); peer = await hire('Other Department Peer', 'employee', base.deptB);
  for (const e of [report, second]) await setReportingLine(adminCtx(base), { subordinateEmploymentId: e.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: '2024-01-01' });
});

describe('window bounds', () => {
  it('defaults to today and the next six days, accepts exactly 31 days, and refuses anything wider or malformed', async () => {
    caller = manager.ctx;
    const plain = await get();
    expect(plain.status).toBe(200);
    expect(TeamAvailabilityV2.safeParse(plain.body).success).toBe(true);
    expect(plain.body).toMatchObject({ enabled: true, today: TODAY, from: TODAY, to: addCalendarDays(TODAY, 6), scope: 'my_team' });
    const from = addCalendarDays(TODAY, 3);
    expect((await get(`?from=${from}`)).body).toMatchObject({ from, to: addCalendarDays(from, 6) });
    const widest = await get(`?from=${from}&to=${addCalendarDays(from, TEAM_WINDOW_MAX_DAYS - 1)}`);
    expect(widest.status).toBe(200);
    expect(widest.body.to).toBe(addCalendarDays(from, TEAM_WINDOW_MAX_DAYS - 1));
    expect((await get(`?from=${from}&to=${from}`)).status).toBe(200);
    for (const query of [
      `?from=${from}&to=${addCalendarDays(from, TEAM_WINDOW_MAX_DAYS)}`, // 32 days
      `?from=${from}&to=${addCalendarDays(from, -1)}`, // inverted
      `?to=${from}`, // to without from
      '?from=2026-02-30', '?from=2026-13-01', '?from=yesterday', `?from=${from}&from=${from}`,
    ]) expect((await get(query)).status, query).toBe(400);
    blocked = true;
    expect((await get()).status).toBe(401);
  });
});

describe('membership and disclosure', () => {
  it('a caller with no team access gets enabled:false, never an empty-but-enabled team', async () => {
    caller = report.ctx;
    expect((await get()).body).toMatchObject({ enabled: false, items: [], memberCount: 0, truncated: false });
    // Naming a team, a company or a peer does not open one.
    expect((await get(`?employmentId=${peer.employmentId}&companyId=${base.companyId}&scope=department`)).body).toMatchObject({ enabled: false, items: [] });
  });

  it('membership is My Team’s own: query parameters neither widen nor narrow it', async () => {
    caller = manager.ctx;
    const plain = await get();
    const ids = (body: { items: { employmentId: string }[] }) => body.items.map((i) => i.employmentId).sort();
    expect(ids(plain.body)).toEqual([report.employmentId, second.employmentId].sort());
    expect(plain.body.memberCount).toBe(2);
    expect(plain.body.companies).toBeGreaterThanOrEqual(1);
    for (const query of [
      `?employmentId=${peer.employmentId}`, `?employmentIds=${peer.employmentId}`, `?companyId=${randomUUID()}`, `?companyIds=${base.companyId}`,
      `?departmentId=${base.deptB}`, '?scope=department', '?scope=direct', `?employmentId=${report.employmentId}`,
    ]) {
      const r = await get(query);
      expect(r.status, query).toBe(200);
      expect(ids(r.body), query).toEqual(ids(plain.body));
    }
  });

  it('dates come from inside the window only, approved vs pending with the session — and no type, code, id or reason', async () => {
    const inside = addCalendarDays(TODAY, 2), outside = addCalendarDays(TODAY, 9);
    await leave(report.employmentId, [inside], 'approved');
    await leave(second.employmentId, [inside], 'pending', 'half_day_am');
    await leave(report.employmentId, [outside], 'approved');
    caller = manager.ctx;
    const r = await get();
    const byId = new Map(r.body.items.map((i: { employmentId: string }) => [i.employmentId, i]));
    expect((byId.get(report.employmentId) as { dates: unknown[] }).dates).toEqual([{ date: inside, status: 'approved', session: 'full_day' }]);
    expect((byId.get(second.employmentId) as { dates: unknown[] }).dates).toEqual([{ date: inside, status: 'pending', session: 'AM' }]);
    // The next week shows the other request and not the first.
    const next = await get(`?from=${addCalendarDays(TODAY, 7)}`);
    const nextReport = next.body.items.find((i: { employmentId: string }) => i.employmentId === report.employmentId);
    expect(nextReport.dates).toEqual([{ date: outside, status: 'approved', session: 'full_day' }]);
    // Every member carries exactly name, id and dates; every date exactly date, status, session.
    for (const body of [r.body, next.body]) for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(['dates', 'employmentId', 'name']);
      for (const d of item.dates) expect(Object.keys(d).sort()).toEqual(['date', 'session', 'status']);
    }
    const [type] = await owner.db.select({ id: schema.leaveType.id, code: schema.leaveType.code, name: schema.leaveType.name }).from(schema.leaveType).where(eq(schema.leaveType.id, base.annualLeaveTypeId));
    const wire = JSON.stringify([r.body, next.body]);
    expect(type.name.length).toBeGreaterThan(0);
    for (const secret of ['SECRET M13 REASON', type.id, type.name, type.code]) expect(wire, secret).not.toContain(secret);
  });

  it('v1 team keeps its shape for installed clients', async () => {
    caller = manager.ctx;
    const r = await v1team.GET(new Request('https://hr.example.com/api/mobile/v1/team'));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['enabled', 'items', 'through', 'today']);
    expect(body.through).toBe(addCalendarDays(TODAY, 6));
  });
});
