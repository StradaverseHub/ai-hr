import {describe,it,expect} from 'vitest';
import {parseMyTeamQuery,serializeMyTeamQuery,stepMyTeamAnchor,MyTeamQueryError} from '../lib/my-team-query';
import {hasTeamAccess} from '../lib/authz';
import type {SessionContext} from '../db/client';
describe('My Team URL state preserves narrowing without inventing authority',()=>{
 it('preserves explicit all-layers-off, team IDs and selected employment through a round trip',()=>{
  const query={view:'week' as const,scope:'all' as const,anchorDate:'2026-10-01',companyIds:['11111111-1111-4111-8111-111111111111'],employmentId:'22222222-2222-4222-8222-222222222222',search:'=SUM(A1)',tile:'late' as const,layers:{roster:false,attendance:false,leave:false}};
  expect(parseMyTeamQuery(serializeMyTeamQuery(query))).toEqual(query);
  expect(serializeMyTeamQuery(query).get('layers')).toBe('');
 });
 it('keeps explicit empty company scope through a URL without broadening it',()=>{
  expect(parseMyTeamQuery(serializeMyTeamQuery({view:'week',scope:'direct',companyIds:[]})).companyIds).toEqual([]);
  expect(parseMyTeamQuery(new URLSearchParams()).companyIds).toBeUndefined();
  expect(()=>parseMyTeamQuery(new URLSearchParams('companyIds=&companyIds=11111111-1111-4111-8111-111111111111'))).toThrow(MyTeamQueryError);
 });
 it.each(['view=custom','scope=tenant','anchorDate=2026-02-30','anchorDate=not-a-date','companyIds=not-an-id','departmentId=all','employmentId=arbitrary','tile=salary','layers=roster,roster','layers=salary'])('refuses invalid input %s',raw=>{expect(()=>parseMyTeamQuery(new URLSearchParams(raw))).toThrow(MyTeamQueryError);});
 it('uses existing calendar stepping across week and month boundaries',()=>{
  expect(stepMyTeamAnchor({view:'week',scope:'direct',anchorDate:'2026-12-28'},1)).toBe('2027-01-04');
  expect(stepMyTeamAnchor({view:'month',scope:'direct',anchorDate:'2026-01-31'},-1)).toBe('2025-12-01');
  expect(()=>stepMyTeamAnchor({view:'week',scope:'direct'},1)).toThrow(MyTeamQueryError);
 });
 it('has one explicit role boundary, excluding employee delegation and functional partners',()=>{
  for(const role of ['employee','payroll_partner','performance_comp_partner','operator'])expect(hasTeamAccess({roles:[role]} as SessionContext),role).toBe(false);
  for(const role of ['manager','hr_admin','super_admin'])expect(hasTeamAccess({roles:[role]} as SessionContext),role).toBe(true);
  expect(hasTeamAccess({roles:['employee'],grants:[{role:'employee',companyId:null}]} as SessionContext)).toBe(false);
 });
});
