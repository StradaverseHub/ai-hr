import {describe,expect,it} from 'vitest';
import {parsePersonnelListQuery,personnelQueryParams,draftMatchesQuery,headcountFilters} from '../app/admin/personnel/list-query';
import {visibleDuplicateEmploymentIds} from '../core/personnel-quality';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
describe('approved Personnel organisation query semantics',()=>{
 it('round trips multi hierarchy, grade, quality and dates without broadening scope',()=>{
  const sp={company:a,companies:[a,b],bu:a,parent:b,group:b,grade:['H','12','23','99'],position:a,quality:['missing_business_unit','suspected_duplicate','forged'],confirmation:'unconfirmed',joinedFrom:'2026-01-01',joinedTo:'2026-06-30',probationFrom:'2026-07-01',probationTo:'invalid',bucket:'probation'};
  const parsed=parsePersonnelListQuery(sp);expect(parsed.filters).toMatchObject({companyId:a,filterCompanyIds:[a,b],businessUnitIds:[a],parentCompanyIds:[b],businessGroupIds:[b],jobGrades:['H','12','23'],qualityFlags:['missing_business_unit','suspected_duplicate'],confirmationState:'unconfirmed',joinedFrom:'2026-01-01',joinedTo:'2026-06-30',probationEndFrom:'2026-07-01',probationEndTo:undefined});
  expect(parsePersonnelListQuery(Object.fromEntries(personnelQueryParams(sp))).filters).toEqual(parsed.filters);
  expect(headcountFilters(parsed).employmentStatuses).toBeUndefined();expect(headcountFilters(parsed).jobGrades).toEqual(['H','12','23']);
 });
 it('only ordinary selections are portable and an opaque private result stays separate from legacy text',()=>{
  const token='a'.repeat(43),query=parsePersonnelListQuery({q:'ordinary name',search:token,companies:a});expect(query.filters.privateSearch).toBe(token);expect(query.filters.q).toBe('ordinary name');
  expect(personnelQueryParams({search:token,companies:a}).toString()).not.toContain('passport');
  expect(parsePersonnelListQuery({search:'forged'}).filters.privateSearch).toBe('invalid');
 });
 it('employment-only fields suppress drafts while multi-company filtering remains meaningful',()=>{
  const draft={companyId:a,label:'Fictional draft',reservedEmployeeCode:'DRAFT-1',companyName:'Company'};
  expect(draftMatchesQuery(draft,parsePersonnelListQuery({companies:[a,b]}))).toBe(true);
  expect(draftMatchesQuery(draft,parsePersonnelListQuery({companies:b}))).toBe(false);
  for(const sp of [{bu:a},{grade:'12'},{quality:'missing_job_grade'},{search:'a'.repeat(43)},{joinedFrom:'2026-01-01'}])expect(draftMatchesQuery(draft,parsePersonnelListQuery(sp))).toBe(false);
 });
 it('duplicates use normalized same name and same hire date across distinct Persons, not multiple employments',()=>{
  const rows=[{employmentId:'one',personId:'same',fullName:' Lee  Sample ',hiredOn:'2026-01-01'},{employmentId:'two',personId:'same',fullName:'LEE SAMPLE',hiredOn:'2026-01-01'},{employmentId:'three',personId:'other',fullName:'lee sample',hiredOn:'2026-01-02'}];
  expect([...visibleDuplicateEmploymentIds(rows)]).toEqual([]);
  expect([...visibleDuplicateEmploymentIds([...rows,{...rows[2],employmentId:'four',hiredOn:'2026-01-01'}])].sort()).toEqual(['four','one','two']);
 });
});
