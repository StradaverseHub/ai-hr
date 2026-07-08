/**
 * Custom-report registry validator (ADR-0074, c440b365). Pure-logic tests for `validateReportSpec` — the
 * single contract shared by the builder UI, the runner and the AI designer. No DB access.
 */
import { describe, it, expect } from 'vitest';
import { validateReportSpec, REPORT_DATASETS, getDataset } from '../core/report-registry';
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
    for (const id of ['branch', 'position', 'shift', 'clockIn', 'clockOut', 'lateMinutes', 'attendanceStatus', 'clockingLocation', 'geofencingStatus', 'remarks'])
      expect(ids.has(id)).toBe(true);
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
