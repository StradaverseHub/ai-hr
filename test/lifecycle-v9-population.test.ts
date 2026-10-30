import { expect, it } from 'vitest';
import { checklistPopulation, type ChecklistCandidate } from '../lib/lifecycle-v9-population';
import { nativeV9Facts } from '../lib/lifecycle-v9-native';
import { blankCase, type Environment } from '../lib/onboarding-model';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
function candidate(id: string, department: string, employmentType = 'full_time'): ChecklistCandidate {
  const native = blankCase(id, 'OB-' + id, 'draft', { fullName: id, department, employmentType, joinDate: '2026-10-30' }, { now: '2026-10-30T00:00:00Z' } as Environment);
  return { id, module: 'onb', facts: nativeV9Facts(native) };
}
it('distinguishes rule matches from frozen and manual case choices without changing existing work', () => {
  const config = v9Defaults(); config.checklists = [{ id: 'general', name: 'General', module: 'onb', rules: {}, tasks: [] }, { id: 'special', name: 'Special', module: 'onb', rules: { department: ['actual-dept-id'] }, tasks: [] }];
  const cases = [candidate('automatic', 'actual-dept-id'), { ...candidate('active snapshot', 'actual-dept-id'), selectedChecklistId: 'general' }, { ...candidate('manual none', 'actual-dept-id'), selectedChecklistId: null }, candidate('different department', 'another-dept')];
  const before = JSON.stringify({ config, cases }), result = checklistPopulation(config, config.checklists[1], cases);
  expect(result.matching).toBe(3); expect(result.selected).toBe(1);
  expect(result.rows.map(row => [row.name, row.matches, row.selected, row.fixed])).toEqual([['automatic', true, true, false], ['active snapshot', true, false, true], ['manual none', true, false, true], ['different department', false, false, false]]);
  expect(JSON.stringify({ config, cases })).toBe(before);
});
it('warns on overlapping equal-specificity rules and respects explicit unclassified employment categories', () => {
  const config = v9Defaults(); config.checklists = [
    { id: 'a', name: 'First', module: 'onb', rules: { employmentType: ['Permanent'] }, tasks: [] },
    { id: 'b', name: 'Second', module: 'onb', rules: { department: ['actual-dept-id'] }, tasks: [] },
    { id: 'c', name: 'Other category', module: 'onb', rules: { employmentType: ['Contract'] }, tasks: [] },
  ];
  const result = checklistPopulation(config, config.checklists[0], [candidate('Permanent joiner', 'actual-dept-id'), candidate('Unclassified intern', 'actual-dept-id', 'intern')]);
  expect(result.conflicts.map(checklist => checklist.id)).toEqual(['b']);
  expect(result.rows.map(row => [row.matches, row.selected, row.tie])).toEqual([[true, true, true], [false, false, false]]);
});
