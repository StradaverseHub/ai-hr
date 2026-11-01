/** Sample-value test for unsaved formula source (feedback 02472802). It runs the payroll evaluator
 * (evaluatePayFormula) with a resolver that answers ONLY from values the user typed. It reads no
 * employee data, writes nothing and is never activation evidence: activation still needs the saved
 * revision's employee test. */
import {applyFormulaAmount,evaluatePayFormula,normalizeFormulaDecimal,parsePayFormula,PayFormulaError,type FormulaTraceEvent,type FormulaValue} from './pay-formula-language';

export const PAY_FORMULA_SAMPLE_VARIABLES=['Basic','FixedAllowances','CalendarDays','Input','Rate','OrdinaryRate','HoursPerDay'] as const;
export type PayFormulaSampleVariable=typeof PAY_FORMULA_SAMPLE_VARIABLES[number];
export type PayFormulaSampleValues=Partial<Record<PayFormulaSampleVariable,string>>;
export type PayFormulaSampleStep=Exclude<FormulaTraceEvent,{kind:'read'}>|{kind:'read';code:string;value:FormulaValue;loc:{line:number;column:number}};
export type PayFormulaSampleErrorCode='invalid_formula'|'sample_missing'|'sample_invalid'|'needs_employee_test'|'division_by_zero'|'out_of_range'|'calculation';
export type PayFormulaSampleResult={
 passed:boolean;
 /** Exact evaluator result (12 decimal places at most). */
 amount:string|null;
 /** The same 2-decimal step payroll applies before any Pay Item proration or rounding setting. */
 payable:string|null;
 explanations:string[];steps:PayFormulaSampleStep[];stepsTruncated:boolean;
 error:null|{code:PayFormulaSampleErrorCode;message:string;line?:number;column?:number;variable?:string};
};
export const PAY_FORMULA_SAMPLE_STEP_LIMIT=200;
const SAMPLE=new Set<string>(PAY_FORMULA_SAMPLE_VARIABLES);
class SampleSourceError extends PayFormulaError{constructor(code:'sample_missing'|'needs_employee_test',variable:string,loc:{line:number;column:number}){super(code,code==='sample_missing'?`Enter a sample value for ${variable}`:`${variable} needs a real employee test`,loc,{name:variable});}}

/** Validate typed values once, before evaluation, so a malformed value is reported by name. */
function sampleValues(values:PayFormulaSampleValues):{ok:true;values:Map<string,string>}|{ok:false;variable:string}{
 const out=new Map<string,string>();
 for(const name of PAY_FORMULA_SAMPLE_VARIABLES){
  const raw=values?.[name];if(raw===undefined||raw===null||String(raw).trim()==='')continue;
  let value:string;try{value=normalizeFormulaDecimal(String(raw).trim());}catch{return {ok:false,variable:name};}
  if(name==='CalendarDays'&&!/^(28|29|30|31)$/.test(value))return {ok:false,variable:name};
  out.set(name,value);
 }
 return {ok:true,values:out};
}

export function runPayFormulaSample(source:string,values:PayFormulaSampleValues):PayFormulaSampleResult{
 const empty={amount:null,payable:null,explanations:[],steps:[],stepsTruncated:false};
 const checked=sampleValues(values);
 if(!checked.ok)return {passed:false,...empty,error:{code:'sample_invalid',message:`Enter a valid number for ${checked.variable}`,variable:checked.variable}};
 let program;try{program=parsePayFormula(source);}catch(error){if(error instanceof PayFormulaError)return {passed:false,...empty,error:{code:'invalid_formula',message:error.reason,line:error.line,column:error.column}};throw error;}
 const steps:PayFormulaSampleStep[]=[];let truncated=false;
 const trace=(event:FormulaTraceEvent)=>{if(steps.length>=PAY_FORMULA_SAMPLE_STEP_LIMIT){truncated=true;return;}steps.push(structuredClone(event));};
 try{
  const result=evaluatePayFormula(program,{trace,resolve(request){
   // Only typed sample inputs are answered. Everything else needs an authorized employee snapshot.
   if(!SAMPLE.has(request.code))throw new SampleSourceError('needs_employee_test',request.code,request.loc);
   const value=checked.values.get(request.code);if(value===undefined)throw new SampleSourceError('sample_missing',request.code,request.loc);
   return {type:'decimal',value};
  }});
  // Same Pay Item amount limits the payroll adapter enforces after evaluation.
  if(Number(result.amount)<0||Number(result.amount)>1e8)return {passed:false,...empty,amount:result.amount,explanations:result.explanations,steps,stepsTruncated:truncated,error:{code:'out_of_range',message:'The result is outside the supported Pay Item amount range'}};
  return {passed:true,amount:result.amount,payable:applyFormulaAmount(result.amount),explanations:result.explanations,steps,stepsTruncated:truncated,error:null};
 }catch(error){
  if(!(error instanceof PayFormulaError))throw error;
  const code:PayFormulaSampleErrorCode=error.code==='sample_missing'||error.code==='needs_employee_test'||error.code==='division_by_zero'?error.code:'calculation';
  return {passed:false,...empty,steps,stepsTruncated:truncated,error:{code,message:error.reason,line:error.line,column:error.column,...(error.detail?.name?{variable:error.detail.name}:{})}};
 }
}
