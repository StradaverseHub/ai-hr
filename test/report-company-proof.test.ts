import { describe,expect,it } from 'vitest';
import { proveCompanySegments } from '../core/employment-company';
const tenure={hiredOn:'2024-01-01',terminatedOn:null};
describe('strict company interval evidence without payroll compatibility filler',()=>{
 it('retains the recorded old company and applies a transfer on its exact exclusive boundary',()=>{
  expect(proveCompanySegments([{companyId:'old',from:'2024-01-01',to:'2024-02-11'},{companyId:'new',from:'2024-02-11',to:null}],tenure,'2024-02-10','2024-02-12')).toEqual([{companyId:'old',from:'2024-02-10',to:'2024-02-10',reason:null},{companyId:'new',from:'2024-02-11',to:'2024-02-12',reason:null}]);
 });
 it('keeps a gap between identical company endpoints unknown rather than merging it away',()=>{
  expect(proveCompanySegments([{companyId:'same',from:'2024-01-01',to:'2024-02-02'},{companyId:'same',from:'2024-02-04',to:null}],tenure,'2024-02-01','2024-02-05')).toEqual([{companyId:'same',from:'2024-02-01',to:'2024-02-01',reason:null},{companyId:null,from:'2024-02-02',to:'2024-02-03',reason:'assignment_missing'},{companyId:'same',from:'2024-02-04',to:'2024-02-05',reason:null}]);
 });
 it('preserves NULL history and overlapping assignments as distinct unavailable evidence',()=>{
  expect(proveCompanySegments([{companyId:null,from:'2024-01-01',to:null}],tenure,'2024-02-01','2024-02-02')).toEqual([{companyId:null,from:'2024-02-01',to:'2024-02-02',reason:'assignment_missing'}]);
  expect(proveCompanySegments([{companyId:'one',from:'2024-01-01',to:null},{companyId:'two',from:'2024-02-02',to:'2024-02-03'}],tenure,'2024-02-01','2024-02-03')).toEqual([{companyId:'one',from:'2024-02-01',to:'2024-02-01',reason:null},{companyId:null,from:'2024-02-02',to:'2024-02-02',reason:'assignment_ambiguous'},{companyId:'one',from:'2024-02-03',to:'2024-02-03',reason:null}]);
 });
 it('clamps to hire and inclusive termination, including one-day tenure and a reversed empty range',()=>{
  const versions=[{companyId:'one',from:'2024-01-01',to:null}];expect(proveCompanySegments(versions,{hiredOn:'2024-02-02',terminatedOn:'2024-02-02'},'2024-02-01','2024-02-03')).toEqual([{companyId:'one',from:'2024-02-02',to:'2024-02-02',reason:null}]);
  expect(proveCompanySegments(versions,tenure,'2024-02-03','2024-02-02')).toEqual([]);expect(proveCompanySegments(versions,tenure,'2023-01-01','2023-12-31')).toEqual([]);
 });
 it('does not assign any day to a zero-length version',()=>{
  expect(proveCompanySegments([{companyId:'zero',from:'2024-02-01',to:'2024-02-01'}],tenure,'2024-02-01','2024-02-01')).toEqual([{companyId:null,from:'2024-02-01',to:'2024-02-01',reason:'assignment_missing'}]);
 });
});
