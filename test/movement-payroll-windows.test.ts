import {describe,expect,it} from 'vitest';
import {movementPayrollWindows} from '../lib/movement-payroll-windows';
describe('Movement payroll windows',()=>{
 const decisions=[{id:'old',date:'2026-01-01',fields:['basicSalary']},{id:'later',date:'2026-03-01',fields:['basicSalary']},{id:'department',date:'2026-04-01',fields:['departmentId']}];
 it('bounds an older salary correction at the next deliberate salary decision',()=>{
  expect(movementPayrollWindows(decisions,[{date:'2026-01-01',fields:['basicSalary']}],'old')).toEqual([{from:'2026-01-01',until:'2026-03-01'}]);
 });
 it('preserves a gap of unchanged months when moving an event past a later decision',()=>{
  expect(movementPayrollWindows(decisions,[{date:'2026-01-01',fields:['basicSalary']},{date:'2026-06-01',fields:['basicSalary']}],'old')).toEqual([{from:'2026-01-01',until:'2026-03-01'},{from:'2026-06-01',until:null}]);
 });
 it('does not treat a different field as a boundary and merges overlapping changed intervals',()=>{
  expect(movementPayrollWindows(decisions,[{date:'2026-02-01',fields:['departmentId','gradeId']}])).toEqual([{from:'2026-02-01',until:null}]);
 });
 it('returns no financial invalidation for a pure remarks correction',()=>{
  expect(movementPayrollWindows(decisions,[{date:'2026-01-01',fields:[]}],'old')).toEqual([]);
 });
});
