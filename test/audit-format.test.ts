import { describe, it, expect } from 'vitest';
import {
  describePayload,
  humanizeEvent,
  aggregateLabel,
  actionOf,
  aggregateHref,
  canOpenAggregate,
  moduleKeyOf,
  isHighImpactAction,
  MODULE_LABEL_EN,
  auditReferences,
  structurePayload,
  type AuditDisplayField,
  type AuditStructuredDetail,
} from '../lib/audit-format';
import { AUDIT_FIELD_KEYS, AUDIT_FIELD_LABEL_KEYS, auditFieldDef, formatAuditEntity, humanizeFieldKey } from '../lib/audit-fields';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

describe('4ec5a940 — audit-format before/after diff renderer', () => {
  it('shows neutral Performance names for retained legacy assessment events',()=>{
    expect(humanizeEvent('onehr.scorecard-approved')).toBe('Performance scorecard approved');
    expect(humanizeEvent('reward.onehr-results-imported')).toBe('Reward performance results imported');
    expect(aggregateLabel('onehr')).toBe('Performance');
    expect(moduleKeyOf('onehr')).toBe('performance');
  });
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

/**
 * 47609f53 — the dashboard's Recent activity card offered every reader a link into the admin-only
 * Personnel screen, which redirects a non-admin straight back to the dashboard. `canOpenAggregate`
 * decides whether a row is OFFERED as a link; it grants nothing.
 *
 * AGGREGATE holds exactly four linkable types and their destinations are gated three different ways:
 *   /admin/personnel/{id}    scopedAdmin  (employee, employment)
 *   /payroll/{id}            requireAdmin (payroll-batch)
 *   /performance/{id}        requireAdmin (review-cycle)
 *   /performance/review/{id} getSession + RLS on can_see_employment (performance-review) — NOT admin
 * The last one is the one that ALREADY WORKS for a non-admin and must keep working: the feed is
 * filtered by domain_event_read, whose non-admin branch is that same can_see_employment predicate, so
 * a reader who can see the row can open the page. Un-linking it would be a regression, not a fix.
 */
describe('47609f53 — canOpenAggregate gates a Recent activity row on the reader', () => {
  const ADMIN_ONLY = ['employee', 'employment', 'payroll-batch', 'review-cycle'] as const;

  for (const type of ADMIN_ONLY) {
    it(`${type} → linked for an admin, plain text for everyone else`, () => {
      expect(canOpenAggregate(type, true)).toBe(true);
      expect(canOpenAggregate(type, false)).toBe(false);
    });
  }

  it('performance-review stays linked for a non-admin (its destination is not admin-gated)', () => {
    expect(canOpenAggregate('performance-review', false)).toBe(true);
    expect(canOpenAggregate('performance-review', true)).toBe(true);
  });

  it('a type with no destination is never openable, admin or not', () => {
    // The overwhelming majority of aggregates carry a label but no href — there is nothing to open,
    // so the answer must be false rather than "true, an admin may open <undefined>".
    for (const type of ['leave-request', 'attendance', 'payslip', 'totally-unknown']) {
      expect(aggregateHref(type, 'x')).toBeUndefined();
      expect(canOpenAggregate(type, true)).toBe(false);
      expect(canOpenAggregate(type, false)).toBe(false);
    }
  });

  it('every gate answer agrees with whether a href exists at all', () => {
    // Cannot-drift check: canOpenAggregate must never say true for a type aggregateHref won't resolve.
    for (const type of [...ADMIN_ONLY, 'performance-review', 'person', 'holiday']) {
      for (const isAdmin of [true, false]) {
        if (canOpenAggregate(type, isAdmin)) expect(aggregateHref(type, 'id1')).toBeTruthy();
      }
    }
  });
});

/**
 * 74a7a074 — the readable Audit Trail detail. Fictional ids only. structurePayload splits a payload into
 * Record / Changes / Other details / Technical details and returns references as {kind, ids} for the
 * server resolver; describePayload (the export's formatter) is untouched and pinned separately.
 */
describe('74a7a074 — structured audit detail', () => {
  const C = '11111111-1111-4111-8111-111111111111';
  const E = '22222222-2222-4222-8222-222222222222';
  const D1 = '33333333-3333-4333-8333-333333333331';
  const D2 = '33333333-3333-4333-8333-333333333332';
  const M = '44444444-4444-4444-8444-444444444444';
  const P = '55555555-5555-4555-8555-555555555555';
  const X = '66666666-6666-4666-8666-666666666666';
  const row = (payload: unknown, aggregateType = 'employment', eventType = 'employment.info.updated', aggregateId = E) => ({
    aggregateType,
    aggregateId,
    eventType,
    payload,
  });
  const byKey = (fields: AuditDisplayField[]) => Object.fromEntries(fields.map((f) => [f.key, f]));
  const visible = (d: AuditStructuredDetail) => JSON.stringify([d.record, d.changes, d.other]);

  it('labels registered keys and splits Record, Changes and Other details', () => {
    const d = structurePayload(
      row({ companyId: C, employmentId: E, positionId: P, effectiveDate: '2026-11-20', before: { departmentId: D1, managerEmploymentId: M }, after: { departmentId: D2, managerEmploymentId: X } }),
    );
    expect(d.record.map((f) => [f.key, f.label.key])).toEqual([
      ['companyId', 'company'],
      ['employmentId', 'employee'],
      ['positionId', 'position'],
    ]);
    expect(byKey(d.record).companyId.value).toEqual({ type: 'ref', kind: 'company', ids: [C] });
    expect(d.changes.map((c) => [c.key, c.label.key, c.previous, c.updated])).toEqual([
      ['departmentId', 'department', { type: 'ref', kind: 'department', ids: [D1] }, { type: 'ref', kind: 'department', ids: [D2] }],
      ['managerEmploymentId', 'directSuperior', { type: 'ref', kind: 'employment', ids: [M] }, { type: 'ref', kind: 'employment', ids: [X] }],
    ]);
    expect(d.other).toEqual([{ key: 'effectiveDate', label: { key: 'effectiveDate', fallback: 'Effective date' }, value: { type: 'text', text: '2026-11-20' } }]);
    expect(d.noFieldChanged).toBe(false);
  });

  it('reads the { from, to } shape of assignment.transferred as a Previous / Updated comparison', () => {
    const d = structurePayload(
      row({ employmentId: E, from: { departmentId: D1, locationId: null }, to: { departmentId: D2, locationId: null }, effectiveDate: '2026-11-01' }, 'assignment', 'assignment.transferred', X),
    );
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]).toMatchObject({ key: 'departmentId', previous: { type: 'ref', ids: [D1] }, updated: { type: 'ref', ids: [D2] } });
    expect(d.record.map((f) => f.key)).toEqual(['employmentId']);
    expect(aggregateLabel('assignment')).toBe('Assignment');
    // The assignment id itself has no lookup; it is traceable under Technical details.
    expect(d.technical).toContainEqual({ key: 'aggregateId', value: X });
    expect(d.technical).toContainEqual({ key: 'from.departmentId', value: D1 });
    expect(d.technical).toContainEqual({ key: 'to.departmentId', value: D2 });
  });

  it('a no-op pair says no field changed', () => {
    const d = structurePayload(row({ before: { a: 1 }, after: { a: 1 } }));
    expect(d.changes).toEqual([]);
    expect(d.noFieldChanged).toBe(true);
  });

  it('keeps masking on screen and in Technical details, including inside a comparison', () => {
    const d = structurePayload(row({ basicSalary: 98765, before: { bankAccountNo: '1234567890' }, after: { bankAccountNo: '5555666677' } }, 'compensation', 'compensation.updated', X));
    const all = JSON.stringify(d);
    for (const secret of ['98765', '1234567890', '5555666677', '123456', '555566']) expect(all).not.toContain(secret);
    expect(d.changes[0].previous).toEqual({ type: 'text', text: '•••• 7890' });
    expect(d.technical).toContainEqual({ key: 'basicSalary', value: '•••• 8765' });
  });

  it('flattens the hire information block, drops its empty entries, and names the record', () => {
    const d = structurePayload(
      row(
        { employmentInformation: { hiredOn: '2026-11-20', orgBranch: 'Fictional Branch', confirmationDate: null }, personId: P, companyId: C, departmentId: D1, businessUnitId: null, hiredOn: '2026-11-20', employmentType: 'full_time' },
        'employment',
        'employment.hired',
      ),
    );
    const rec = byKey(d.record);
    expect(Object.keys(rec)).toEqual(['aggregateId', 'personId', 'companyId', 'departmentId', 'businessUnitId']);
    expect(rec.aggregateId).toMatchObject({ label: { key: 'employee' }, value: { type: 'ref', kind: 'employment', ids: [E] } });
    expect(rec.businessUnitId.value).toEqual({ type: 'empty' });
    // hiredOn appears at both levels of the hire payload; it is shown once.
    expect(d.other.map((f) => f.key)).toEqual(['orgBranch', 'hiredOn', 'employmentType']);
    expect(d.other.find((f) => f.key === 'orgBranch')?.label).toEqual({ key: null, fallback: 'Org branch' });
    expect(d.technical).toContainEqual({ key: 'employmentInformation.confirmationDate', value: '—' });
  });

  it('keeps an unknown id under Technical details only, and module-restricted keys outside their module', () => {
    const d = structurePayload(row({ caseId: X, batchId: M, note: 'Fictional note' }, 'notice', 'notice.updated', X));
    expect(visible(d)).not.toContain(X);
    expect(visible(d)).not.toContain(M);
    expect(d.other.map((f) => f.key)).toEqual(['note']);
    expect(d.technical.map((t) => t.key)).toEqual(['aggregateType', 'aggregateId', 'eventType', 'caseId', 'batchId', 'note']);
    // The same batchId inside payroll is a payroll run.
    const pay = structurePayload(row({ batchId: M }, 'payslip', 'payslip.created', X));
    expect(pay.record[0]).toMatchObject({ key: 'batchId', label: { key: 'payrollRun' }, value: { type: 'ref', kind: 'payrollBatch', ids: [M] } });
    expect(auditFieldDef('batchId', 'leave')?.kind).toBeUndefined();
    expect(auditFieldDef('batchId', 'payroll')?.kind).toBe('payrollBatch');
  });

  it('a changed unknown id shows a "see technical details" cell rather than vanishing', () => {
    const d = structurePayload(row({ before: { caseId: M }, after: { caseId: X } }));
    expect(d.changes).toEqual([{ key: 'caseId', label: { key: null, fallback: 'Case id' }, previous: { type: 'technical' }, updated: { type: 'technical' } }]);
  });

  it('supports { diff } and names-only { fields }', () => {
    const d = structurePayload(row({ diff: { departmentId: { from: D1, to: D2 } } }));
    expect(d.changes[0]).toMatchObject({ label: { key: 'department' }, previous: { ids: [D1] }, updated: { ids: [D2] } });
    expect(d.technical).toContainEqual({ key: 'diff.departmentId.from', value: D1 });
    const f = structurePayload(row({ fields: ['departmentId', 'someFlag'] }));
    expect(f.other).toEqual([
      { key: 'fields', label: { key: 'changedFields', fallback: 'Changed fields' }, value: { type: 'fields', labels: [{ key: 'department', fallback: 'Department id' }, { key: null, fallback: 'Some flag' }] } },
    ]);
  });

  it('collects every reference once per kind, across rows, including id lists', () => {
    const refs = auditReferences([
      structurePayload(row({ companyId: C, before: { departmentId: D1 }, after: { departmentId: D2 } })),
      structurePayload(row({ companyIds: [C, X], employmentId: E }, 'leave-approval-template', 'leave-approval-template.assigned', M)),
    ]);
    expect([...refs.keys()].sort()).toEqual(['company', 'department', 'employment', 'leaveApprovalTemplate']);
    expect([...refs.get('company')!].sort()).toEqual([C, X].sort());
    expect([...refs.get('employment')!]).toEqual([E]);
    expect([...refs.get('leaveApprovalTemplate')!]).toEqual([M]);
  });

  it('formats resolved names with their codes', () => {
    expect(formatAuditEntity('company', { label: 'Sample Holdings', code: 'SHB' })).toBe('Sample Holdings (SHB)');
    expect(formatAuditEntity('employment', { label: 'SAMPLE EMPLOYEE', code: 'EMP0001' })).toBe('SAMPLE EMPLOYEE / EMP0001');
    expect(formatAuditEntity('department', { label: 'Human Resources', code: null })).toBe('Human Resources');
    expect(humanizeFieldKey('carry_forward_max')).toBe('Carry forward max');
  });

  it('every registry label and every new string exists, non-empty, in all six locales', () => {
    const extra = ['sectionAction', 'sectionRecord', 'sectionChanges', 'sectionOther', 'doneBy', 'when', 'event', 'columnField', 'columnPrevious', 'columnUpdated', 'notAvailable', 'seeTechnical', 'noFieldChanged', 'currentNames', 'technicalDetails'];
    for (const k of AUDIT_FIELD_KEYS) expect(AUDIT_FIELD_LABEL_KEYS, k).toContain(auditFieldDef(k, 'payroll')!.label);
    for (const [loc, m] of Object.entries({ en, ms, ta, th, vi, zh })) {
      const table = (m as { components: { auditTable: Record<string, string> } }).components.auditTable;
      for (const k of [...extra, ...AUDIT_FIELD_LABEL_KEYS.map((x) => `field_${x}`)]) expect(table[k]?.trim(), `${loc}.${k}`).toBeTruthy();
    }
  });
});
