import {PERSONNEL_EMPLOYMENT_FILTERS} from '../lib/personnel-list-employment-fields';
import {describe,expect,it} from 'vitest';
import {matchesPersonnelColumnFilters,parsePersonnelColumnFilters} from '../lib/personnel-list-controls';
import {parsePersonnelListQuery,personnelQueryParams} from '../app/admin/personnel/list-query';
describe('Personnel listing controls',()=>{
 it('closes the field and operator vocabulary, validates typed values and treats blanks explicitly',()=>{
  const parse=(x:Record<string,string>)=>parsePersonnelColumnFilters(new URLSearchParams(x));
  expect(()=>parse({'field.injected':'x'})).toThrow();expect(()=>parse({'field.joinDate':'2026-02-30'})).toThrow();expect(()=>parse({'field.employment.probationValue':'many'})).toThrow();
  expect(parse({'field.name':'','operator.name':'blank'})).toEqual([{field:'name',operator:'blank',value:''}]);
  expect(parse({'field.name':''})).toEqual([]);
 });
 it('combines numeric/date/text criteria, never equates an unavailable field with authorised blank',()=>{
  const filters=parsePersonnelColumnFilters(new URLSearchParams({'field.name':'Example','field.employment.probationValue':'12','operator.employment.probationValue':'from','field.joinDate':'2026-01-01','operator.joinDate':'to'}));
  const row={name:'Example person',employmentFieldsPermitted:true,probationValue:12,joinDate:'2025-12-31'};
  expect(matchesPersonnelColumnFilters(row,filters)).toBe(true);expect(matchesPersonnelColumnFilters({...row,probationValue:2},filters)).toBe(false);expect(matchesPersonnelColumnFilters({...row,employmentFieldsPermitted:false},filters)).toBe(false);
 });
 it('catalogues current Employment facts without exposing classification, file or history fields',()=>{
  expect(PERSONNEL_EMPLOYMENT_FILTERS.map(f=>f.key)).toEqual(expect.arrayContaining(['orgDivision','orgBranch','probationValue','noticeAfterConfirmationValue','contractStartDate','contractRemark','groupService']));
  expect(PERSONNEL_EMPLOYMENT_FILTERS.map(f=>f.key)).not.toContain('isTestRecord');
 });
 it('round trips only validated sorting through screen and export with no paging or raw criteria',()=>{
  const sp={sort:'joinDate',direction:'desc',companies:'11111111-1111-4111-8111-111111111111'};const query=parsePersonnelListQuery(sp);expect(query.filters.columnSort).toBe('joinDate');expect(query.filters.sortDirection).toBe('desc');expect(personnelQueryParams(sp).get('sort')).toBe('joinDate');expect(parsePersonnelListQuery({sort:'employeeCode; drop table person'}).filters.columnSort).toBeUndefined();
 });
});
