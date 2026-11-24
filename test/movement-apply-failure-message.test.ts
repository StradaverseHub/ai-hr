import {describe,expect,it} from 'vitest';
import {failureMessage} from '../core/movement-apply';

describe('movement sweep failure line',()=>{
 it('names the database cause behind a driver\'s "Failed query" wrapper, without its parameters',()=>{
  const cause=new Error('new row violates row-level security policy for table "information_payslip_snapshot"');
  const wrapped=new Error('Failed query: select app.preserve_movement_payroll($1::uuid) as count\nparams: 00000000-0000-4000-8000-000000000001',{cause});
  expect(failureMessage(wrapped)).toBe('Failed query: select app.preserve_movement_payroll($1::uuid) as count — caused by: '
   +'new row violates row-level security policy for table "information_payslip_snapshot"');
 });
 it('keeps a plain refusal as it was and tolerates non-errors',()=>{
  expect(failureMessage(new Error('The date 12-Nov-2026 is before the current assignment record.'))).toBe('The date 12-Nov-2026 is before the current assignment record.');
  expect(failureMessage('boom')).toBe('boom');
 });
});
