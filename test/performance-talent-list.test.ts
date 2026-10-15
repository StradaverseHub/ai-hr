import { expect,it } from 'vitest';
import golden from './fixtures/onehr/talent-list-golden.json';
import { talentListColumns,talentListRows,talentListValues,type TalentListPerson,type TalentListFilters,type TalentListSort } from '../packs/performance/onehr/talent-list-model';
it('matches the isolated source list for default box order, natural grades, combined filters and retained column selections',()=>{
 for(const sample of golden.cases){
  const rows=sample.rows as TalentListPerson[],filters=sample.filters as TalentListFilters,sort=sample.sort as TalentListSort;
  expect(talentListRows(rows,filters,sample.category,sort).map(r=>r.id)).toEqual(sample.expectedIds);
  for(const column of talentListColumns)expect(talentListValues(rows,column,filters,sample.category)).toEqual(sample.expectedValues[column]);
 }
});
