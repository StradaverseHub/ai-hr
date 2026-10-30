import { expect, it } from 'vitest';
import { v9EmploymentClass, v9EmploymentRule, type V9EmploymentFacts } from '../lib/lifecycle-v9-employment';
import { matches as nativeMatches, effectiveFacts, blankCase, type Environment } from '../lib/onboarding-model';
import { matches, workflowMatches, type Case, type Workflow } from '../lib/lifecycle-v9-model';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import { parseV9Config } from '../lib/lifecycle-v9-validation';
export const classificationExamples: [V9EmploymentFacts, string | null][] = [
  [{ employmentType: 'contract', joinDate: '2026-10-01', confirmationDate: '2027-01-01' }, 'contract'],
  [{ employmentType: 'full_time', joinDate: '2026-10-01' }, 'permanent'],
  [{ employmentType: 'full_time', joinDate: '2026-10-01', confirmationDate: '2026-10-02' }, 'probation'],
  [{ employmentType: 'full_time', joinDate: '2026-10-02', confirmationDate: '2026-10-02' }, 'permanent'],
  [{ employmentType: 'full_time', joinDate: '2026-10-03', confirmationDate: '2026-10-02' }, 'permanent'],
  [{ employmentType: 'full_time', joinDate: '2026-10-03', finalConfirmationDate: '2026-11-01', confirmationDate: '2026-10-02' }, 'probation'],
  [{ employmentType: 'full_time', joinDate: '2026-10-01', finalConfirmationDate: '', probationEndDate: '2026-11-01' }, 'probation'],
  [{ employmentType: 'full_time', joinDate: '2026-10-01', provisionalEndOn: '2026-11-01' }, 'probation'],
  [{ employmentType: 'full_time', joinDate: '2026-10-01', noticeDate: '2026-09-01', confirmationDate: '2026-09-15' }, 'probation'],
  [{ employmentType: 'full_time', joinDate: '2026-10-01', confirmationDate: '2026-02-30' }, null],
  ...['part_time', 'intern', 'assignment', ''].map(employmentType => [{ employmentType, joinDate: '2026-10-01', confirmationDate: '2027-01-01' }, null] as [V9EmploymentFacts, null]),
];
it('uses the approved categories, canonical confirmation precedence and case date without changing source facts', () => {
  for (const [facts, expected] of classificationExamples) {
    const before = structuredClone(facts); expect(v9EmploymentClass(facts)).toBe(expected); expect(facts).toEqual(before);
    for (const value of ['Permanent','Contract','Probation']) expect(v9EmploymentRule(value, facts)).toBe(expected === null ? null : expected === value.toLowerCase());
  }
});
it('matches V9 categories without turning unsupported types into an inverse-category match', () => {
  const facts = { employmentType: 'full_time', joinDate: '2026-10-01', confirmationDate: '2027-01-01' } as Case['facts'];
  expect(matches({ employmentType: ['Probation'] }, facts)).toBe(true); expect(matches({ employmentType: ['Permanent'] }, facts)).toBe(false); expect(facts.employmentType).toBe('full_time');
  const workflow = { module: 'onb', conditions: [{ field: 'employmentType', op: 'isNot', value: 'Permanent' }] } as Workflow;
  expect(workflowMatches({ module: 'onb', facts } as Case, workflow, '2026-10-01')).toBe(true);
  facts.employmentType = 'part_time'; expect(workflowMatches({ module: 'onb', facts } as Case, workflow, '2026-10-01')).toBe(false);
  expect(matches({ employmentType: [] }, facts)).toBe(true);
});
it('retains canonical Native type predicates while V9 category predicates use the same source dates', () => {
  const environment = { now: '2026-10-01T00:00:00Z' } as Environment;
  const c = blankCase('case', 'OB-1', 'draft', { employmentType: 'full_time', joinDate: '2026-10-01', confirmationDate: '2027-01-01' }, environment);
  const facts = effectiveFacts(c); expect(nativeMatches({ employmentType: ['Probation'] }, facts)).toBe(true); expect(nativeMatches({ employmentType: ['full_time'] }, facts)).toBe(true); expect(nativeMatches({ employmentType: ['Permanent'] }, facts)).toBe(false);
  expect(facts.finalConfirmationDate).toBe(''); expect(facts.confirmationDate).toBe('2027-01-01');
});
it('keeps V9 category choices explicit instead of accepting unsupported kernel types as category labels', () => {
  const config = v9Defaults(); config.checklists[0].rules.employmentType = ['Permanent']; expect(() => parseV9Config(config)).not.toThrow();
  config.checklists[0].rules.employmentType = ['part_time']; expect(() => parseV9Config(config)).toThrow('Permanent, Contract or Probation');
});
