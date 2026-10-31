import {describe,expect,it} from 'vitest';
import {resolvePersonalPayslipSelection} from '../app/(app)/me/payslip/selection-state';
import {resolvePayslipSelection,type PayslipRun} from '../app/(app)/payroll/individual-payslip/period-options';
const runs:PayslipRun[]=[
 {payslipId:'own-bonus',companyId:'own-company',payPeriod:'2025-03',runType:'bonus',runSeq:2},
 {payslipId:'own-regular',companyId:'own-company',payPeriod:'2025-03',runType:'regular',runSeq:1},
 {payslipId:'own-prior-company',companyId:'prior-company',payPeriod:'2024-12',runType:'regular',runSeq:1},
];
describe('personal payslip selection retains exact subject and period constraints',()=>{
 it('defaults to a real released-index entry and preserves the precise selected repeated run',()=>{
  expect(resolvePersonalPayslipSelection(runs,{})).toMatchObject({payslipId:'own-regular',year:2025,month:3});
  expect(resolvePersonalPayslipSelection(runs,{companyId:'own-company',year:'2025',month:'03',payslipId:'own-bonus'})).toMatchObject({payslipId:'own-bonus',runType:'bonus',runSeq:2});
 });
 it.each([{year:'2023'},{month:'04'},{companyId:'prior-company',year:'2025'},{year:'2025',month:'12'},{year:'2024',payslipId:'own-bonus'}])('does not relax an unavailable requested period %j',request=>{
  expect(resolvePersonalPayslipSelection(runs,request).payslipId).toBeNull();
 });
 it.each([{year:''},{year:'2025-03'},{month:'13'},{month:'garbled'},{companyId:''},{payslipId:''},{payslipId:'foreign-id'},{companyId:'foreign-company'}])('refuses malformed or foreign selection %j',request=>{
  expect(resolvePersonalPayslipSelection(runs,request).payslipId).toBeNull();
 });
 it('retains the administrator helper’s existing period relaxation contract',()=>{
  expect(resolvePayslipSelection(runs,{year:2023}).payslipId).toBe('own-regular');
  expect(resolvePersonalPayslipSelection(runs,{year:'2023'}).payslipId).toBeNull();
 });
 it('offers no result for an empty index or a malformed saved period',()=>{
  expect(resolvePersonalPayslipSelection([],{}).payslipId).toBeNull();
  expect(resolvePersonalPayslipSelection([{...runs[0],payPeriod:'not-a-period'}],{}).payslipId).toBeNull();
 });
});
