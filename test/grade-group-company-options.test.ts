import { describe, expect, it } from 'vitest';
import { gradeGroupsForCompanies, memberGradeIds, type GradeGroupOption } from '../lib/grade-group-coverage';

const groups: GradeGroupOption[] = [
  { id: 'global', name: 'Global', gradeIds: ['general'] },
  { id: 'a', name: 'A only', gradeIds: ['general'], scopeCompanyIds: ['a'] },
  { id: 'ab', name: 'A and B', gradeIds: ['general'], scopeCompanyIds: ['a', 'b'] },
];
describe('Grade Group expansion respects the whole selected company audience', () => {
  it.each([
    [[], ['global']],
    [['a'], ['global', 'a', 'ab']],
    [['b'], ['global', 'ab']],
    [['a', 'b'], ['global', 'ab']],
    [['a', 'c'], ['global']],
  ])('offers the covered groups for %j', (companies, expected) => {
    expect(gradeGroupsForCompanies(groups, companies).map((g) => g.id)).toEqual(expected);
  });
  it('cannot expand an A-only group to global grades for company B', () => {
    expect(memberGradeIds(['a'], gradeGroupsForCompanies(groups, ['b']))).toEqual([]);
  });
});
