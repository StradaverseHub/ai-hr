/** Reviewed draft conversions. No SQL, source-text substitution or saved revision mutation. */
import {analyzePayFormula,type FormulaProgram,type FormulaExpression} from './pay-formula-language';
export const FORMULA_BUSINESS_CODE_ALTERNATIVES:Readonly<Record<string,string>>={companyId:'companyCode',businessUnitId:'businessUnitCode',departmentId:'departmentBusinessCode',positionId:'positionBusinessCode',gradeId:'jobGradeCode',departmentCode:'departmentBusinessCode',positionCode:'positionBusinessCode',gradeCode:'jobGradeCode'};
export type FormulaCodeComparison={line:number;column:number;field:string;value:string;target:string};
export function formulaCodeReview(program:FormulaProgram){
 const references=[...new Set(analyzePayFormula(program).calls.filter(call=>call.code==='EmployeeProfile').map(call=>String(call.args[0]?.value??'')).filter(key=>key in FORMULA_BUSINESS_CODE_ALTERNATIVES))];
 const comparisons:FormulaCodeComparison[]=[];
 const visit=(value:unknown):void=>{
  if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(visit);return;}
  const node=value as FormulaExpression;
  if(node.kind==='binary'&&['=','<>','<','<=','>','>='].includes(node.operator))for(const [side,literal]of [[node.left,node.right],[node.right,node.left]]){
   if(side.kind!=='call'||side.code!=='EmployeeProfile'||side.args[0]?.kind!=='literal'||side.args[0].value.type!=='string'||literal.kind!=='literal'||literal.value.type!=='string')continue;
   const field=side.args[0].value.value,target=FORMULA_BUSINESS_CODE_ALTERNATIVES[field];
   if(target)comparisons.push({line:node.loc.line,column:node.loc.column,field,value:literal.value.value,target});
  }
  Object.values(value).forEach(visit);
 };
 visit(program);return {references,comparisons};
}
export function convertReviewedFormulaCode(program:FormulaProgram,comparison:FormulaCodeComparison,code:string){
 if(!code.trim()||FORMULA_BUSINESS_CODE_ALTERNATIVES[comparison.field]!==comparison.target)throw new Error('Choose and review an exact configured business code.');
 const next=structuredClone(program);let matched=0;
 const visit=(value:unknown):void=>{
  if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(visit);return;}
  const node=value as FormulaExpression;
  if(node.kind==='binary'&&node.loc.line===comparison.line&&node.loc.column===comparison.column)for(const [side,literal]of [[node.left,node.right],[node.right,node.left]]){
   if(side.kind==='call'&&side.code==='EmployeeProfile'&&side.args[0]?.kind==='literal'&&side.args[0].value.type==='string'&&side.args[0].value.value===comparison.field&&literal.kind==='literal'&&literal.value.type==='string'&&literal.value.value===comparison.value){side.args[0].value.value=comparison.target;literal.value.value=code;matched++;}
  }
  Object.values(value).forEach(visit);
 };
 visit(next);if(matched!==1)throw new Error('The formula changed. Review the comparison again.');return next;
}
