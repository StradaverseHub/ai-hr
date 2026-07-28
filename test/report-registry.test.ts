/**
 * Custom-report registry validator (ADR-0074, c440b365). Pure-logic tests for `validateReportSpec` — the
 * single contract shared by the builder UI, the runner and the AI designer. No DB access.
 */
import { describe, it, expect } from 'vitest';
import { validateReportSpec, REPORT_DATASETS, getDataset, datasetsForCategory, reportVerbAllowed } from '../core/report-registry';
import type { CustomReportSpec } from '../db/schema';

const base = (over: Partial<CustomReportSpec> = {}): CustomReportSpec => ({
  datasetId: 'master',
  columns: ['name', 'department'],
  ...over,
});

describe('validateReportSpec', () => {
  it('accepts a well-formed spec', () => {
    expect(validateReportSpec(base()).ok).toBe(true);
  });

  it('rejects an unknown dataset', () => {
    const r = validateReportSpec({ datasetId: 'nope', columns: ['x'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown-dataset');
  });

  it('rejects an empty column set', () => {
    const r = validateReportSpec(base({ columns: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-columns');
  });

  it('rejects an unknown column', () => {
    const r = validateReportSpec(base({ columns: ['name', 'not_a_field'] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('unknown-column');
  });

  it('rejects duplicate columns', () => {
    const r = validateReportSpec(base({ columns: ['name', 'name'] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('duplicate-column');
  });

  it('rejects an unknown filter', () => {
    const r = validateReportSpec(base({ filters: { bogus: 'x' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('unknown-filter');
  });

  it('rejects a sort on a field outside the dataset', () => {
    const r = validateReportSpec(base({ sort: { field: 'ghost', dir: 'asc' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad-sort');
  });

  it('rejects a summary field outside the dataset', () => {
    const r = validateReportSpec(base({ layout: { summary: ['ghost'] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('bad-summary');
  });

  it('rejects layout align/width/average/freeze/page-break on unknown fields', () => {
    expect(validateReportSpec(base({ layout: { align: { ghost: 'left' } } })).ok).toBe(false);
    expect(validateReportSpec(base({ layout: { widths: { ghost: 2 } } })).ok).toBe(false);
    expect(validateReportSpec(base({ layout: { averages: ['ghost'] } })).ok).toBe(false);
    expect(validateReportSpec(base({ layout: { freeze: ['ghost'] } })).ok).toBe(false);
    expect(validateReportSpec(base({ layout: { pageBreakOn: 'ghost' } })).ok).toBe(false);
  });

  it('accepts a full layout that names only known fields', () => {
    const r = validateReportSpec(
      base({
        columns: ['name', 'department', 'basicSalary'],
        layout: {
          align: { name: 'left', basicSalary: 'right' },
          widths: { name: 2 },
          summary: ['basicSalary'],
          averages: ['basicSalary'],
          freeze: ['name'],
          pageBreakOn: 'department',
          permissions: { hr_admin: ['view', 'export'] },
        },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('the daily-attendance dataset exposes the reporter field list', () => {
    const ds = getDataset('attendance_daily');
    expect(ds).toBeDefined();
    const ids = new Set(ds!.fields.map((f) => f.id));
    for (const id of ['branch', 'position', 'shift', 'clockIn', 'clockOut', 'lateMinutes', 'attendanceStatus', 'attendanceAllowance', 'replacementLeave', 'clockingLocation', 'geofencingStatus', 'remarks'])
      expect(ids.has(id)).toBe(true);
  });

  it('the Performance category carries real datasets (reviews + goals)', () => {
    const list = datasetsForCategory('performance');
    expect(list.map((d) => d.id).sort()).toEqual(['performance_goals', 'performance_reviews']);
    const reviews = getDataset('performance_reviews')!;
    const rIds = new Set(reviews.fields.map((f) => f.id));
    for (const id of ['employeeCode', 'name', 'cycleName', 'cycleStatus', 'reviewStatus', 'selfRating', 'managerRating', 'overallRating', 'reviewer', 'periodStart', 'periodEnd'])
      expect(rIds.has(id)).toBe(true);
    const goals = getDataset('performance_goals')!;
    const gIds = new Set(goals.fields.map((f) => f.id));
    for (const id of ['employeeCode', 'name', 'goalTitle', 'goalStatus', 'progress', 'approvalStatus', 'dueOn'])
      expect(gIds.has(id)).toBe(true);
  });

  it('the Payroll Register dataset carries the reporter template groups + fields (622e12eb)', () => {
    const ds = getDataset('payroll_register');
    expect(ds).toBeDefined();
    const byId = new Map(ds!.fields.map((f) => [f.id, f]));
    // The six groups the reporter listed, in template order.
    expect([...new Set(ds!.fields.map((f) => f.group))]).toEqual([
      'Employee & Organisation Info',
      'Earnings',
      'Total Earnings',
      'Deductions',
      'Total Deductions & Nett Wage',
      'Employer Contributions',
    ]);
    for (const id of ['employeeCode', 'employeeName', 'department', 'jobGrade', 'employmentStatus', 'payPeriod', 'payrollCycle'])
      expect(byId.get(id)?.group).toBe('Employee & Organisation Info');
    // Employee share vs employer contribution are DISTINCT columns — the point of a register.
    for (const id of ['epfEmployee', 'socsoEmployee', 'socsoSkbbk', 'eisEmployee', 'pcb', 'cp38', 'zakat', 'otherDeductions'])
      expect(byId.get(id)?.group).toBe('Deductions');
    for (const id of ['epfEmployer', 'socsoEmployer', 'eisEmployer', 'hrdf', 'employerCost'])
      expect(byId.get(id)?.group).toBe('Employer Contributions');
    expect(byId.get('net')?.group).toBe('Total Deductions & Nett Wage');
    // Every filter names a real field so the shared contains-filter path in runReportSpec can apply it.
    for (const f of ds!.filters) expect(byId.has(f.id)).toBe(true);
  });

  it('Payroll offers the register FIRST so "New report" seeds it, with history still selectable', () => {
    const list = datasetsForCategory('payroll');
    expect(list.map((d) => d.id)).toEqual(['payroll_register', 'payroll_history']);
  });

  it('default alignment follows the reporter rule (names left, dates/status center, numbers/currency right)', async () => {
    const { defaultAlign } = await import('../core/report-registry');
    expect(defaultAlign('text')).toBe('left');
    expect(defaultAlign('date')).toBe('center');
    expect(defaultAlign('status')).toBe('center');
    expect(defaultAlign('number')).toBe('right');
    expect(defaultAlign('currency')).toBe('right');
  });

  it('every dataset declares valid default columns', () => {
    for (const ds of Object.values(REPORT_DATASETS)) {
      const fieldIds = new Set(ds.fields.map((f) => f.id));
      for (const c of ds.defaultColumns) expect(fieldIds.has(c)).toBe(true);
    }
  });

  it('getDataset resolves known ids and rejects unknown', () => {
    expect(getDataset('master')?.id).toBe('master');
    expect(getDataset('nope')).toBeUndefined();
  });
});

describe('reportVerbAllowed (7-verb per-report permission grid)', () => {
  const grid = { manager: ['view'], hr_admin: ['view', 'export', 'edit'] };

  it('empty/absent grid allows everyone the route guard let in', () => {
    expect(reportVerbAllowed(undefined, ['employee'], ['delete'])).toBe(true);
    expect(reportVerbAllowed({}, ['employee'], ['delete'])).toBe(true);
  });

  it('super_admin is the always-allowed superrole', () => {
    expect(reportVerbAllowed(grid, ['super_admin'], ['delete'])).toBe(true);
    expect(reportVerbAllowed(grid, ['super_admin'], ['manageTemplates'])).toBe(true);
  });

  it('grants are verb-exact: view does not imply export or edit', () => {
    expect(reportVerbAllowed(grid, ['manager'], ['view'])).toBe(true);
    expect(reportVerbAllowed(grid, ['manager'], ['export'])).toBe(false);
    expect(reportVerbAllowed(grid, ['manager'], ['edit'])).toBe(false);
    expect(reportVerbAllowed(grid, ['hr_admin'], ['edit'])).toBe(true);
    expect(reportVerbAllowed(grid, ['hr_admin'], ['delete'])).toBe(false);
    expect(reportVerbAllowed(grid, ['hr_admin'], ['share'])).toBe(false);
    expect(reportVerbAllowed(grid, ['hr_admin'], ['manageTemplates'])).toBe(false);
    expect(reportVerbAllowed(grid, ['hr_admin'], ['create'])).toBe(false);
  });

  it('an any-of verb list passes when any requested verb is granted', () => {
    expect(reportVerbAllowed(grid, ['manager'], ['view', 'edit'])).toBe(true);
    expect(reportVerbAllowed(grid, ['manager'], ['delete', 'share'])).toBe(false);
  });

  it('ungranted roles are denied every verb when a grid is set', () => {
    expect(reportVerbAllowed(grid, ['employee'], ['view'])).toBe(false);
    expect(reportVerbAllowed(grid, [], ['view'])).toBe(false);
  });
});
