/** Live preview: real services, real RLS; only test accounts are synthetic. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { myEmployments, listLeaveRequestsPage } from '../core/read';
import { myLeaveDashboard } from '../core/my-leave';
import { todayInKualaLumpur } from '../lib/hr-date';
import { loadMobilePreview } from '../app/mobile-preview/data';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, setModule, type Base } from './harness';

let b: Base;
const today = todayInKualaLumpur();
const start = `${today.slice(0, 4)}-01-01`;
async function hire(name: string, base = b, role: 'employee' | 'manager' | 'hr_admin' = 'employee') {
  const e = await hireEmployee(adminCtx(base), { person: { fullName: name, primaryEmail: `${randomUUID()}@preview.test` },
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: `${Number(today.slice(0, 4)) - 1}-01-01` });
  const userId = await createAppUser(base.tenantId, e.personId, role);
  const ctx: SessionContext = { ...await entitledCtx(base, [role]), userId, personId: e.personId,
    roles: [role], grants: [{ role, companyId: base.companyId }] };
  return { ...e, ctx };
}
async function request(employmentId: string, status: 'pending' | 'approved' = 'pending', base = b) {
  const [r] = await owner.db.insert(schema.leaveRequest).values({ tenantId: base.tenantId, employmentId,
    leaveTypeId: base.annualLeaveTypeId, startDate: today, endDate: today, days: '1.00', status }).returning({ id: schema.leaveRequest.id });
  return r.id;
}
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
afterAll(closeAll);

describe('Mobile App Preview uses the viewer’s authorized records', () => {
  it('shows an employed admin only their own leave history despite broader RLS access', async () => {
    const a = await hire('Preview Owner', b, 'hr_admin'), peer = await hire('Private Peer');
    const ownId = await request(a.employmentId), peerId = await request(peer.employmentId);
    const visible = await listLeaveRequestsPage(a.ctx, { limit: 20, offset: 0 });
    expect(visible.rows.map(r => r.id)).toContain(peerId); // filter must do real work beyond RLS
    const view = await loadMobilePreview(a.ctx, [b.companyId], 'en');
    expect(view.requests).toEqual({ status: 'ready', data: { total: 1, items: [expect.objectContaining({ id: ownId })] } });
    expect(JSON.stringify(view.requests)).not.toContain(peerId);
  });

  it('keeps peers and two populated tenants separate, and strips compensation', async () => {
    await setModule(b.tenantId, 'notifications', 'active');
    const a = await hire('Actual Viewer'), peer = await hire('Private Colleague');
    const foreignBase = await seedBase(), foreign = await hire('Foreign Viewer', foreignBase);
    await setCompensation(adminCtx(b), { employmentId: a.employmentId, basicSalary: 7345.67, monthlyAllowance: 412.34, effectiveFrom: start });
    expect(Number((await myEmployments(a.ctx))[0].basic)).toBe(7345.67);
    const ids = await Promise.all([request(a.employmentId), request(peer.employmentId), request(foreign.employmentId, 'pending', foreignBase)]);
    await owner.db.insert(schema.notification).values([a, peer].map(e => ({ tenantId: b.tenantId, recipientEmploymentId: e.employmentId,
      kind: 'test', title: e === a ? 'Own update' : 'PRIVATE PEER UPDATE', body: 'Body', severity: 'info' as const })));
    const view = await loadMobilePreview(a.ctx, [b.companyId], 'en');
    expect(view.employment?.id).toBe(a.employmentId);
    expect(view.requests.status === 'ready' && view.requests.data.items.map(r => r.id)).toEqual([ids[0]]);
    expect(view.inbox.status === 'ready' && view.inbox.data.map(n => n.title)).toEqual(['Own update']);
    const wire = JSON.stringify(view);
    for (const secret of [peer.employmentId, foreign.employmentId, ids[1], ids[2], 'PRIVATE PEER UPDATE', '7345.67', '412.34', 'basicSalary']) expect(wire).not.toContain(secret);
    expect(view.team.status).toBe('disabled');
    const other = await loadMobilePreview(foreign.ctx, [foreignBase.companyId], 'en');
    expect(other.requests.status === 'ready' && other.requests.data.items.map(r => r.id)).toEqual([ids[2]]);
  });

  it('uses every visible dashboard type and exact masked figures, never the unrestricted catalogue', async () => {
    const a = await hire('Balance Viewer');
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 14, validFrom: start });
    await owner.db.insert(schema.leaveLedger).values({ tenantId: b.tenantId, employmentId: a.employmentId,
      leaveTypeId: b.annualLeaveTypeId, entryType: 'accrual', days: '12.50', effectiveOn: start });
    const [hidden] = await owner.db.insert(schema.leaveType).values({ tenantId: b.tenantId, code: 'PRIVATE', name: 'Hidden Type', paid: true, counting: 'calendar_days', visibleToEmployee: false }).returning({ id: schema.leaveType.id });
    await owner.db.insert(schema.leaveLedger).values({ tenantId: b.tenantId, employmentId: a.employmentId,
      leaveTypeId: hidden.id, entryType: 'accrual', days: '99.00', effectiveOn: start });
    const source = await myLeaveDashboard(a.ctx, a.employmentId, { today, locale: 'en' });
    expect(source.cards.length).toBeGreaterThan(0);
    const view = await loadMobilePreview(a.ctx, [b.companyId], 'en');
    expect(view.leave.status).toBe('ready');
    if (view.leave.status !== 'ready') throw new Error('Missing balances');
    expect(view.leave.data.map(c => c.id)).toEqual(source.cards.map(c => c.leaveTypeId));
    expect(view.leave.data.some(c => c.id === hidden.id)).toBe(false);
    for (const c of view.leave.data) {
      const original = source.cards.find(o => o.leaveTypeId === c.id)!;
      expect(c).toMatchObject({ available: original.canApplyFor, balance: original.balance, pending: original.pending, taken: original.taken });
    }
  });

  it('resolves current reports and narrows team data to the company switcher; an employee gets no team', async () => {
    const manager = await hire('Manager Viewer', b, 'manager'), report = await hire('Visible Report'), stranger = await hire('Private Stranger');
    await setReportingLine(adminCtx(b), { subordinateEmploymentId: report.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: start });
    const view = await loadMobilePreview(manager.ctx, [b.companyId], 'en');
    expect(view.team.status === 'ready' && view.team.data.map(p => p.employmentId)).toEqual([report.employmentId]);
    const narrowed = await loadMobilePreview(manager.ctx, [], 'en');
    expect(narrowed.team).toEqual({ status: 'ready', data: [] });
    expect((await loadMobilePreview(stranger.ctx, [b.companyId], 'en')).team.status).toBe('disabled');
    await owner.db.update(schema.reportingLine).set({ validTo: today }).where(eq(schema.reportingLine.subordinateEmploymentId, report.employmentId));
    expect((await loadMobilePreview(manager.ctx, [b.companyId], 'en')).team).toEqual({ status: 'ready', data: [] });
  });

  it('has no fictional employee fallback and distinguishes unavailable reads from zero balances', async () => {
    const admin = await loadMobilePreview(adminCtx(b), [b.companyId], 'en');
    expect(admin.employment).toBeNull();
    for (const key of ['clock', 'leave', 'requests', 'claims', 'inbox', 'payslips'] as const) expect(admin[key]).toEqual({ status: 'disabled' });
    const a = await hire('Unavailable Viewer');
    const view = await loadMobilePreview({ ...a.ctx, entitlements: undefined, entitlementsError: 'test outage' }, [b.companyId], 'en');
    // Leave is a core module: its authorized read survives an optional-pack snapshot outage.
    expect(view.leave.status).toBe('ready');
    expect(view.clock).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(view)).not.toContain('test outage');
  });
});
