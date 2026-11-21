import {describe,it,expect} from 'vitest';
import {normalisePostingValues,postingSalary,postingDisplayStatus} from '../lib/personnel-posting';
const day='2026-11-16',id='00000000-0000-4000-8000-000000000001';
describe('Offboarding Personnel posting boundaries',()=>{
 it('keeps Probation values and event types isolated from salary changes',()=>{
  expect(normalisePostingValues('promotion',{effectiveDate:day,basicSalary:'10000'}).ok).toBe(false);
  expect(normalisePostingValues('confirmation',{effectiveDate:day,basicSalary:'10000'}).ok).toBe(false);
  expect(normalisePostingValues('probationExtension',{effectiveDate:day,endDate:'2027-01-01'}).ok).toBe(true);
  expect(normalisePostingValues('probationExtension',{effectiveDate:day,endDate:'2027-01-01'},'offboarding').ok).toBe(false);
 });
 it('only admits scoped Position/Job Grade pairs and exact decimal Basic salary',()=>{
  expect(normalisePostingValues('promotion',{effectiveDate:day,positionId:id,position:'Engineer',gradeId:id,jobGrade:'G4',basicSalary:'12000.5'},'offboarding')).toMatchObject({ok:true,values:{basicSalary:'12000.50'}});
  for(const values of [{positionId:id},{position:'Engineer'},{gradeId:id},{jobGrade:'G4'},{basicSalary:'1e6'},{basicSalary:'0'},{basicSalary:'-1'},{basicSalary:'12.345'},{allowances:[]},{currency:'USD'},{endDate:day}])expect(normalisePostingValues('promotion',{effectiveDate:day,...values},'offboarding').ok).toBe(false);
  expect(postingSalary('9999999999.99')).toBe('9999999999.99');
  expect(postingSalary('10000000000.00')).toBeNull();
 });
 it('requires resignation facts for termination and rejects salary or allowance payloads',()=>{
  const values={effectiveDate:day,resignationDate:'2026-10-16',exitReason:'Resignation'};
  expect(normalisePostingValues('termination',values,'offboarding').ok).toBe(true);
  expect(normalisePostingValues('termination',{...values,basicSalary:'1'},'offboarding').ok).toBe(false);
  expect(normalisePostingValues('termination',{effectiveDate:day},'offboarding').ok).toBe(false);
  expect(normalisePostingValues('termination',{...values,effectiveDate:'0000-01-01'},'offboarding').ok).toBe(false);
  expect(postingDisplayStatus({status:'rejected',edited:values})).toBe('rejected');
 });
});
