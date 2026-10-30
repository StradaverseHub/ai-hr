/**
 * 1d58019a Step 2 (ADR-0166) — the pure Field Controls rules shared by the settings grid, the New Event form,
 * the server writer and the import (lib/movement-field-rules.ts). The database behaviour is in
 * test/movement-type-controls.test.ts; this pins the rule itself.
 */
import { describe, expect, it } from 'vitest';
import {
  MOVEMENT_RULE_FIELDS,
  defaultMovementFieldRule,
  effectiveMovementFieldRules,
  movementFieldRuleViolations,
  movementRuleFieldsFor,
  normaliseMovementFieldRule,
  type MovementFieldRule,
} from '../lib/movement-field-rules';

const r = (field: MovementFieldRule['field'], over: Partial<MovementFieldRule> = {}): MovementFieldRule => ({
  ...defaultMovementFieldRule(field),
  ...over,
});

describe('Field Controls — shape and defaults', () => {
  it('offers Company only to Entity Transfer', () => {
    expect(movementRuleFieldsFor('transfer')).not.toContain('companyId');
    expect(movementRuleFieldsFor('entityTransfer')).toContain('companyId');
    expect(movementRuleFieldsFor('entityTransfer')).toHaveLength(MOVEMENT_RULE_FIELDS.length);
  });

  it('no stored rules is today: every field included and editable, nothing required, no document', () => {
    const { configured, rules } = effectiveMovementFieldRules('promotion', []);
    expect(configured).toBe(false);
    expect(rules.every((x) => x.included && x.editable && !x.mustChange && x.document === 'none')).toBe(true);
    expect(movementFieldRuleViolations(rules, new Set(['departmentId', 'basicSalary']), new Set())).toEqual([]);
  });

  it('normalises the grid’s dependencies and locks Entity Transfer’s company', () => {
    expect(normaliseMovementFieldRule('transfer', r('gradeId', { included: false, editable: true, mustChange: true, document: 'required' })))
      .toEqual({ field: 'gradeId', included: false, editable: false, mustChange: false, document: 'none' });
    expect(normaliseMovementFieldRule('transfer', r('gradeId', { editable: false, mustChange: true, document: 'optional' })))
      .toEqual({ field: 'gradeId', included: true, editable: false, mustChange: false, document: 'none' });
    expect(normaliseMovementFieldRule('entityTransfer', r('companyId', { included: false, editable: false, mustChange: false })))
      .toMatchObject({ included: true, editable: true, mustChange: true });
  });
});

describe('Field Controls — violations', () => {
  const rules = effectiveMovementFieldRules('transfer', [
    r('departmentId', { mustChange: true, document: 'required' }),
    r('positionId', { editable: false }),
    r('gradeId', { included: false }),
    r('basicSalary', { document: 'optional' }),
  ]).rules;

  it('accepts a compliant change with its document', () => {
    expect(movementFieldRuleViolations(rules, new Set(['departmentId', 'basicSalary']), new Set(['departmentId']))).toEqual([]);
  });

  it('names each kind of refusal', () => {
    expect(movementFieldRuleViolations(rules, new Set(['departmentId', 'gradeId']), new Set(['departmentId']))).toEqual([
      { code: 'field_not_included', field: 'gradeId' },
    ]);
    expect(movementFieldRuleViolations(rules, new Set(['departmentId', 'positionId']), new Set(['departmentId']))).toEqual([
      { code: 'field_not_editable', field: 'positionId' },
    ]);
    expect(movementFieldRuleViolations(rules, new Set(['basicSalary']), new Set())).toEqual([
      { code: 'field_must_change', field: 'departmentId' },
    ]);
    expect(movementFieldRuleViolations(rules, new Set(['departmentId']), new Set())).toEqual([
      { code: 'document_required', field: 'departmentId' },
    ]);
    expect(movementFieldRuleViolations(rules, new Set(['departmentId']), new Set(['departmentId', 'positionId']))).toEqual([
      { code: 'document_not_enabled', field: 'positionId' },
    ]);
    // Company is not in a Transfer's grid at all: a document for it is not enabled either.
    expect(movementFieldRuleViolations(rules, new Set(['departmentId']), new Set(['departmentId', 'companyId']))).toEqual([
      { code: 'document_not_enabled', field: 'companyId' },
    ]);
  });

  it('a required document is needed only when its field changes', () => {
    const salary = effectiveMovementFieldRules('salaryAdjustment', [r('basicSalary', { document: 'required' })]).rules;
    expect(movementFieldRuleViolations(salary, new Set(['currency']), new Set())).toEqual([]);
    expect(movementFieldRuleViolations(salary, new Set(['basicSalary']), new Set())).toEqual([
      { code: 'document_required', field: 'basicSalary' },
    ]);
  });
});
