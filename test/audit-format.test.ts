import { describe, it, expect } from 'vitest';
import {
  describePayload,
  actionOf,
  moduleKeyOf,
  isHighImpactAction,
  MODULE_LABEL_EN,
} from '../lib/audit-format';

describe('4ec5a940 — audit-format before/after diff renderer', () => {
  it('renders only the changed keys as "old → new"', () => {
    const lines = describePayload({
      before: { annualDays: 12, carryForwardMax: 5, method: 'grant_on_hire_prorated' },
      after: { annualDays: 14, carryForwardMax: 5, method: 'grant_on_hire_prorated' },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ key: 'annualDays', value: '12 → 14', changed: true });
  });

  it('handles a null before (first-time upsert) — every after key is a change from —', () => {
    const lines = describePayload({ before: null, after: { enabled: true, levels: ['MANAGER', 'HR'] } });
    const byKey = Object.fromEntries(lines.map((l) => [l.key, l.value]));
    expect(byKey.enabled).toBe('— → true');
    expect(byKey.levels).toContain('→');
  });

  it('renders remaining flat keys (companyId, recalc) after the comparison', () => {
    const lines = describePayload({
      companyId: 'c1',
      before: { annualDays: 12 },
      after: { annualDays: 13 },
      recalc: { affected: 2, totalDelta: 4 },
    });
    const keys = lines.map((l) => l.key);
    expect(keys).toContain('annualDays');
    expect(keys).toContain('companyId');
    expect(keys).toContain('recalc');
    // the changed diff comes before the flat keys
    expect(keys.indexOf('annualDays')).toBeLessThan(keys.indexOf('companyId'));
  });

  it('masks a sensitive key even inside a before/after diff', () => {
    const lines = describePayload({ before: { basicSalary: 5000 }, after: { basicSalary: 6000 } });
    expect(lines[0].value).not.toContain('5000');
    expect(lines[0].value).not.toContain('6000');
    expect(lines[0].value).toContain('••••');
  });

  it('truncates a very long nested value', () => {
    const big = { note: 'x'.repeat(300) };
    const lines = describePayload({ before: {}, after: big });
    expect(lines[0].value.length).toBeLessThan(140);
    expect(lines[0].value).toContain('…');
  });

  it('a no-op before/after pair reports "changed: —" rather than blank', () => {
    const lines = describePayload({ before: { a: 1 }, after: { a: 1 } });
    expect(lines).toEqual([{ key: 'changed', value: '—' }]);
  });

  it('still supports the { diff } and { fields } conventions', () => {
    expect(describePayload({ diff: { name: { from: 'A', to: 'B' } } })[0]).toEqual({
      key: 'name',
      value: 'A → B',
      changed: true,
    });
    expect(describePayload({ fields: ['x', 'y'] })).toEqual([{ key: 'changed fields', value: 'x, y' }]);
  });
});

describe('4ec5a940 — actionOf classification', () => {
  it('maps the last dot-segment to a coarse action', () => {
    expect(actionOf('leave-type.created')).toBe('created');
    expect(actionOf('leave-policy.updated')).toBe('updated');
    expect(actionOf('leave-policy.deleted')).toBe('deleted');
    expect(actionOf('leave-type.archived')).toBe('archived');
    expect(actionOf('leave-type.unarchived')).toBe('unarchived');
    expect(actionOf('grade.superseded')).toBe('superseded');
    expect(actionOf('leave-grant.granted')).toBe('created');
    expect(actionOf('something.weird')).toBe('other');
  });

  it('flags irreversible / archival actions as high-impact', () => {
    expect(isHighImpactAction(actionOf('x.deleted'))).toBe(true);
    expect(isHighImpactAction(actionOf('x.archived'))).toBe(true);
    expect(isHighImpactAction(actionOf('x.updated'))).toBe(false);
  });
});

describe('4ec5a940 — moduleKeyOf', () => {
  it('maps aggregates to their bounded context', () => {
    expect(moduleKeyOf('leave-type')).toBe('leave');
    expect(moduleKeyOf('job-grade')).toBe('organization');
    expect(moduleKeyOf('payroll-batch')).toBe('payroll');
    expect(moduleKeyOf('attendance')).toBe('attendance');
    expect(moduleKeyOf('performance-review')).toBe('performance');
    expect(moduleKeyOf('totally-unknown')).toBe('other');
  });

  it('every module key has an English export label', () => {
    for (const k of ['leave', 'organization', 'payroll', 'attendance', 'performance', 'other'] as const) {
      expect(MODULE_LABEL_EN[k]).toBeTruthy();
    }
  });
});
