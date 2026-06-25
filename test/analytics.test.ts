/**
 * Wave 4B — HR analytics read layer. Active headcount (terminated excluded), new-hire / termination
 * cohorts by period, the standard turnover KPI (leavers ÷ avg headcount), and master-data export with
 * compensation gated to the includeComp flag (admin-only; Wave 1 #5).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import { assignment } from '../db/schema';
import { hireEmployee, terminateEmployment, transferEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import {
  changeJobTransactions,
  headcountSummary,
  masterDataExport,
  newHires,
  terminations,
  turnoverRate,
} from '../core/analytics';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const hire = (ctx: SessionContext, b: Base, name: string, hiredOn: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });

describe('Wave 4B — analytics read layer', () => {
  let base: Base;
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

  // E1 active (Jan), E2 active (Mar), E3 hired Feb + terminated 20 May (voluntary), E4 active (Jun 1).
  async function cohort() {
    const a = adminCtx(base);
    const e1 = await hire(a, base, 'Ann', '2026-01-15');
    const e2 = await hire(a, base, 'Bob', '2026-03-01');
    const e3 = await hire(a, base, 'Cara', '2026-02-10');
    const e4 = await hire(a, base, 'Dan', '2026-06-01');
    await terminateEmployment(a, { employmentId: e3.employmentId, terminationDate: '2026-05-20', terminationType: 'voluntary' });
    return { a, e1, e2, e3, e4 };
  }

  it('headcount: counts only active employees as of the date', async () => {
    const { a } = await cohort();
    const hc = await headcountSummary(a, undefined, { asOf: '2026-06-17' });
    expect(hc.total).toBe(3); // Ann, Bob, Dan active; Cara terminated 20 May
    expect(hc.byCompany.reduce((s, r) => s + r.count, 0)).toBe(3);
  });

  it('new hires: only those hired within the window', async () => {
    const { a } = await cohort();
    expect((await newHires(a, undefined, { from: '2026-06-01', to: '2026-06-30' })).map((r) => r.name)).toEqual(['Dan']);
    expect((await newHires(a, undefined, { from: '2026-01-01', to: '2026-12-31' })).length).toBe(4);
  });

  it('terminations: the leaver cohort with classification', async () => {
    const { a } = await cohort();
    const rows = await terminations(a, undefined, { from: '2026-05-01', to: '2026-05-31' });
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ name: 'Cara', terminationType: 'voluntary', terminatedOn: '2026-05-20' });
  });

  it('turnover %: leavers ÷ average headcount × 100', async () => {
    const { a } = await cohort();
    const t = await turnoverRate(a, undefined, { from: '2026-05-01', to: '2026-05-31' });
    // Start (1 May) = Ann, Bob, Cara = 3; End (31 May) = Ann, Bob = 2; avg = 2.5; leavers = 1 → 40%.
    expect(t).toMatchObject({ leavers: 1, headcountStart: 3, headcountEnd: 2, avgHeadcount: 2.5, turnoverPct: 40 });
  });

  it('master-data export: compensation gated to the includeComp flag', async () => {
    const { a, e1 } = await cohort();
    await setCompensation(a, { employmentId: e1.employmentId, basicSalary: 5000, monthlyAllowance: 300, effectiveFrom: '2026-01-15' });

    const without = await masterDataExport(a, undefined, { includeComp: false });
    expect(without.every((r) => r.basicSalary === undefined)).toBe(true);

    const withComp = await masterDataExport(a, undefined, { includeComp: true });
    const ann = withComp.find((r) => r.name === 'Ann');
    expect(ann?.basicSalary).toBe('5000.00');
    expect(ann?.currency).toBe('MYR');
    // Active roster excludes the terminated employee by default.
    expect(withComp.some((r) => r.name === 'Cara')).toBe(false);
  });

  // ── ADR-0047: Change Job Transactions ──────────────────────────────────────
  describe('changeJobTransactions (ADR-0047)', () => {
    it('reports a transfer only when its effectiveOn falls in the window', async () => {
      const a = adminCtx(base);
      const e = await hire(a, base, 'Eve', '2026-01-10'); // genesis in deptA
      await transferEmployee(a, { employmentId: e.employmentId, effectiveDate: '2026-03-15', departmentId: base.deptB });

      const inWindow = await changeJobTransactions(a, undefined, { from: '2026-03-01', to: '2026-03-31' });
      expect(inWindow.map((r) => r.name)).toEqual(['Eve']);
      expect(inWindow[0]).toMatchObject({
        fromDepartment: 'Finance',
        toDepartment: 'Operations',
        effectiveOn: '2026-03-15',
      });

      // The same transfer is absent from a window that does not contain its effective date.
      const outOfWindow = await changeJobTransactions(a, undefined, { from: '2026-04-01', to: '2026-04-30' });
      expect(outOfWindow.length).toBe(0);
    });

    it('the genesis hire does NOT appear as a change', async () => {
      const a = adminCtx(base);
      await hire(a, base, 'Fred', '2026-02-05'); // hire only — never transferred
      const rows = await changeJobTransactions(a, undefined, { from: '2026-01-01', to: '2026-12-31' });
      expect(rows.some((r) => r.name === 'Fred')).toBe(false);
    });

    it('a terminated employee produces no change row', async () => {
      const a = adminCtx(base);
      const e = await hire(a, base, 'Gail', '2026-01-20');
      await terminateEmployment(a, { employmentId: e.employmentId, terminationDate: '2026-05-10', terminationType: 'voluntary' });
      const rows = await changeJobTransactions(a, undefined, { from: '2026-01-01', to: '2026-12-31' });
      expect(rows.some((r) => r.name === 'Gail')).toBe(false);
    });

    it('a superseded (corrected) transfer is excluded', async () => {
      const a = adminCtx(base);
      const e = await hire(a, base, 'Hugo', '2026-01-08');
      const { assignmentId } = await transferEmployee(a, {
        employmentId: e.employmentId,
        effectiveDate: '2026-06-12',
        departmentId: base.deptB,
      });
      // The successor row before tombstoning is visible.
      expect((await changeJobTransactions(a, undefined, { from: '2026-06-01', to: '2026-06-30' })).map((r) => r.name)).toEqual(['Hugo']);

      // Mark the successor as a correction tombstone (supersededAt set) — owner connection bypasses RLS.
      await owner.db.update(assignment).set({ supersededAt: new Date() }).where(eq(assignment.id, assignmentId));
      expect((await changeJobTransactions(a, undefined, { from: '2026-06-01', to: '2026-06-30' })).length).toBe(0);
    });
  });

  // ── ADR-0047: scoping filter (department + free-text q) ─────────────────────
  describe('report filter (ADR-0047)', () => {
    it('masterDataExport filters by department and by q (name)', async () => {
      const a = adminCtx(base);
      await hire(a, base, 'Ivy', '2026-01-05'); // deptA
      const moved = await hire(a, base, 'Jack', '2026-01-06'); // deptA → deptB
      await transferEmployee(a, { employmentId: moved.employmentId, effectiveDate: '2026-02-01', departmentId: base.deptB });

      const inB = await masterDataExport(a, undefined, { filter: { departmentId: base.deptB } });
      expect(inB.map((r) => r.name)).toEqual(['Jack']);

      const byName = await masterDataExport(a, undefined, { filter: { q: 'ivy' } });
      expect(byName.map((r) => r.name)).toEqual(['Ivy']);
    });

    it('terminations dept filter resolves the assignment AS OF the termination date (leaver not dropped)', async () => {
      const a = adminCtx(base);
      const e = await hire(a, base, 'Kara', '2026-01-15'); // hired into deptA
      await terminateEmployment(a, { employmentId: e.employmentId, terminationDate: '2026-05-20', terminationType: 'voluntary' });

      // The leaver's open assignment is CLOSED at termination — a current-assignment dept join would
      // drop her. The event-date resolution keeps her under her deptA-at-termination.
      const inA = await terminations(a, undefined, { from: '2026-05-01', to: '2026-05-31', filter: { departmentId: base.deptA } });
      expect(inA.map((r) => r.name)).toEqual(['Kara']);
      expect(inA[0].department).toBe('Finance');

      const inB = await terminations(a, undefined, { from: '2026-05-01', to: '2026-05-31', filter: { departmentId: base.deptB } });
      expect(inB.length).toBe(0);
    });

    it('comp stays gated by isAdmin even when includeComp=true under a filter', async () => {
      const a = adminCtx(base);
      const e = await hire(a, base, 'Liam', '2026-01-15');
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4200, monthlyAllowance: 0, effectiveFrom: '2026-01-15' });

      // Admin + includeComp → comp present (and the q-filter still resolves the row).
      const adminRows = await masterDataExport(a, undefined, { includeComp: true, filter: { q: 'liam' } });
      expect(adminRows.map((r) => r.name)).toEqual(['Liam']);
      expect(adminRows[0].basicSalary).toBe('4200.00');

      // Same DB row, manager-role ctx: the app-layer gate (withComp = includeComp && isAdmin) drops comp.
      // (We re-seed via the admin so the manager ctx need not satisfy RLS visibility — assert the gate,
      // not row visibility: whatever rows return, none carries a comp column.)
      const managerCtx: SessionContext = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['manager'] };
      const managerRows = await masterDataExport(managerCtx, undefined, { includeComp: true, filter: { q: 'liam' } });
      expect(managerRows.every((r) => r.basicSalary === undefined && r.currency === undefined)).toBe(true);
    });
  });
});
