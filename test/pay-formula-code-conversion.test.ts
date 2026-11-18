import {describe,it,expect} from 'vitest';
import {parsePayFormula,printPayFormula,evaluatePayFormula} from '../lib/pay-formula-language';
import {formulaCodeReview,convertReviewedFormulaCode} from '../lib/pay-formula-code-conversion';
import {PAY_FORMULA_PERSONNEL_ADAPTERS,personnelFormulaInternalId,personnelFormulaProviderVersion,PAY_FORMULA_PERSONNEL_PROVIDER_VERSION,PAY_FORMULA_BUSINESS_CODE_PROVIDER_VERSION} from '../lib/pay-formula-personnel';

describe('reviewed business code conversion',()=>{
 const source='If {#EmployeeProfile}("positionId") = "2910adcc-bfb6-426a-b885-05bc8d0d6029" Then\nReturn 10\nElse\nReturn 0\nEnd If';
 it('retains the old program and changes one reviewed typed comparison only',()=>{
  const original=parsePayFormula(source),review=formulaCodeReview(original),before=JSON.stringify(original);
  expect(review.references).toEqual(['positionId']);expect(review.comparisons).toHaveLength(1);
  const next=convertReviewedFormulaCode(original,review.comparisons[0],'J0113');
  expect(JSON.stringify(original)).toBe(before);expect(printPayFormula(next)).toContain('"positionBusinessCode") = "J0113"');
  expect(evaluatePayFormula(next,{resolve:()=>({type:'string',value:'J0113'})}).amount).toBe('10');
 });
 it('reports legacy aliases and indirect references without guessing a replacement literal',()=>{
  const review=formulaCodeReview(parsePayFormula('Dim Previous As String = {#EmployeeProfile}("positionCode")\nIf Previous = "Old code" Then\nReturn 1\nElse\nReturn 0\nEnd If'));
  expect(review.references).toEqual(['positionCode']);expect(review.comparisons).toEqual([]);
 });
 it('refuses stale comparison coordinates and blank or unapproved replacements',()=>{
  const program=parsePayFormula(source),comparison=formulaCodeReview(program).comparisons[0];
  expect(()=>convertReviewedFormulaCode(program,{...comparison,value:'different'},'J0113')).toThrow(/changed/);
  expect(()=>convertReviewedFormulaCode(program,comparison,' ')).toThrow(/exact configured/);
  expect(()=>convertReviewedFormulaCode(program,{...comparison,target:'companyCode'},'J0113')).toThrow();
 });
 it('keeps the v2 frozen provider boundary and internal-ID vocabulary unchanged',()=>{
  const old=PAY_FORMULA_PERSONNEL_ADAPTERS.find(adapter=>adapter.key==='positionId')!;
  const added=PAY_FORMULA_PERSONNEL_ADAPTERS.find(adapter=>adapter.key==='positionBusinessCode')!;
  expect(personnelFormulaProviderVersion(old)).toBe(PAY_FORMULA_PERSONNEL_PROVIDER_VERSION);
  expect(personnelFormulaProviderVersion(added)).toBe(PAY_FORMULA_BUSINESS_CODE_PROVIDER_VERSION);
  expect(personnelFormulaInternalId(old)).toBe(true);expect(personnelFormulaInternalId(added)).toBe(false);
  expect(PAY_FORMULA_PERSONNEL_ADAPTERS.filter(personnelFormulaInternalId).map(adapter=>adapter.key).sort()).toEqual(['businessUnitId','companyId','departmentId','gradeId','positionId']);
 });
});
