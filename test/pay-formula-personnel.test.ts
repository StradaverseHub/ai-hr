import {describe,it,expect} from 'vitest';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {PAY_FORMULA_PERSONNEL_ADAPTERS,PAY_FORMULA_PERSONNEL_INVENTORY} from '../lib/pay-formula-personnel';
import {parsePayFormula,evaluatePayFormula,applyFormulaAmount} from '../lib/pay-formula-language';
const company='10000000-0000-4000-8000-000000000001';
const branch=`If {#EmployeeProfile}("companyId") = "${company}" Then\n Return ({#Basic} + {#FixedAllowances}) / 26 / 8 * 1.5 * {#Input}\nElse\n Return {#Basic} / 26 / 8 * 1.5 * {#Input}\nEnd If`;
describe('typed Personnel formula vocabulary',()=>{
 it('inventories every Profile/Employment descriptor and explicitly marks repeated, file and draft sources',()=>{
  expect(PAY_FORMULA_PERSONNEL_INVENTORY.map(f=>f.fieldId).sort()).toEqual(PERSONNEL_FIELDS.filter(f=>f.tab==='Profile'||f.tab==='Employment').map(f=>f.id).sort());
  expect(PAY_FORMULA_PERSONNEL_INVENTORY.filter(f=>f.grain==='many').every(f=>f.unavailableReason==='repeating')).toBe(true);
  expect(PAY_FORMULA_PERSONNEL_ADAPTERS.some(a=>a.key==='companyId'&&a.type==='string'&&a.dateBasis==='effective-date')).toBe(true);
  expect(PAY_FORMULA_PERSONNEL_ADAPTERS.every(a=>PERSONNEL_FIELDS.some(f=>f.id===a.fieldId&&f.grain==='single'))).toBe(true);
 });
 it.each([[company,'66'],['10000000-0000-4000-8000-000000000002','60']])('uses the verified stable company literal %s with independent exact branch result %s',(current,expected)=>{
  const result=evaluatePayFormula(parsePayFormula(branch),{resolve:request=>request.code==='EmployeeProfile'?{type:'string',value:current}:{type:'decimal',value:request.code==='Basic'?'4160':request.code==='FixedAllowances'?'416':'2'}});expect(applyFormulaAmount(result.amount,{rounding:'nearest'})).toBe(expected);
 });
 it('enforces text, number and date types and refuses unresolved placeholders',()=>{
  expect(()=>parsePayFormula('Return {#EmployeeProfile}("companyId") + 1')).toThrow();
  expect(()=>parsePayFormula('If {#EmployeeProfile}("employment.employment_dates_and_service.probationvalue") > 3 Then\nReturn 1\nElse\nReturn 0\nEnd If')).not.toThrow();
  expect(()=>parsePayFormula('If {#EmployeeInformation}("profile.identity_and_passport.passportexpirydate") < {#Date}("2026-01-01") Then\nReturn 1\nElse\nReturn 0\nEnd If')).not.toThrow();
  expect(()=>parsePayFormula('Return {#MISSING:Company}')).toThrow();
 });
});
