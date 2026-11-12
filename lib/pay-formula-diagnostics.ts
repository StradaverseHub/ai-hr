/** Editor and save-time checks for Pay Formula source. Diagnostics only: payroll evaluation is owned by
 * lib/pay-formula-language.ts and is not changed by anything here. Errors block saving; warnings do not. */
import {inspectPayFormula,addFormulaDecimal,multiplyFormulaDecimal,divideFormulaDecimal,normalizeFormulaDecimal,type FormulaExpression,type FormulaProgram,type FormulaStatement} from './pay-formula-language';
import {PAY_FORMULA_FUNCTIONS,payFormulaFunction} from './pay-formula-registry';
import {personnelFormulaAdapter,personnelFormulaInternalId} from './pay-formula-personnel';

export type FormulaDiagnosticCode='unknown_function'|'unknown_variable'|'missing_return'|'division_by_zero'|'possible_zero_divisor'|'internal_id_compared'|'syntax';
export type FormulaDiagnostic={
 severity:'error'|'warning';
 /** A translated message exists for every named code; any other engine problem uses `message`. */
 code:FormulaDiagnosticCode|string;
 line:number;column:number;length:number;
 /** English engine text, used when no translated message exists for the code. */
 message:string;
 name?:string;suggestion?:string;
 /** internal_id_compared: the literal the internal ID is compared with. */
 value?:string;
};
export const PAY_FORMULA_DIAGNOSTIC_CAP=50;
/** Sources that are typed per employee or per run and can legitimately be 0. Named values derived from
 * them inherit the same possibility. CalendarDays and positive literals are never 0. */
const MAY_BE_ZERO=new Set(['Input','PayItemInput','AnotherPayItems']);

const TOKEN=/^(?:\{#[A-Za-z][A-Za-z0-9_]*\}|\d+(?:\.\d*)?|\.\d+|[A-Za-z_][A-Za-z0-9_]*|"(?:[^"]|"")*"?|<=|>=|<>)/;
/** Length of the source token that starts at a 1-based line/column; 1 when nothing recognisable starts there. */
export function formulaTokenLength(source:string,line:number,column:number):number{
 const text=source.split(/\r\n|\r|\n/)[line-1];if(text===undefined)return 1;
 const match=TOKEN.exec(text.slice(column-1));return Math.max(1,match?.[0].length??1);
}
/** 0-based character offset of a 1-based line/column, for moving the editor cursor. */
export function formulaOffset(source:string,line:number,column:number):number{
 let offset=0,current=1;
 for(let i=0;i<source.length&&current<line;i++){if(source[i]==='\r'&&source[i+1]==='\n')i++;if(source[i]==='\n'||source[i]==='\r'){current++;offset=i+1;}}
 return Math.min(source.length,offset+Math.max(0,column-1));
}
function distance(a:string,b:string){
 const row=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){let previous=row[0];row[0]=i;for(let j=1;j<=b.length;j++){const saved=row[j];row[j]=Math.min(row[j]+1,row[j-1]+1,previous+(a[i-1]===b[j-1]?0:1));previous=saved;}}
 return row[b.length];
}
/** The closest candidate within a small edit distance, or undefined. Ties keep the first candidate. */
export function nearestFormulaName(name:string,candidates:readonly string[]):string|undefined{
 const target=name.toLowerCase();let best:string|undefined,score=Infinity;
 for(const candidate of candidates){const d=distance(target,candidate.toLowerCase());if(d<score){best=candidate;score=d;}}
 return best!==undefined&&score<=Math.max(1,Math.floor(name.length/3))?best:undefined;
}
const functionNames=()=>PAY_FORMULA_FUNCTIONS.map(fn=>fn.code);
function declaredNames(source:string){return [...source.matchAll(/^\s*Dim\s+([A-Za-z_][A-Za-z0-9_]*)/gim)].map(m=>m[1]);}

function constant(e:FormulaExpression):string|null{
 try{
  if(e.kind==='literal')return e.value.type==='decimal'?normalizeFormulaDecimal(e.value.value):null;
  if(e.kind==='unary'&&e.operator!=='Not'){const v=constant(e.operand);return v===null?null:e.operator==='-'?normalizeFormulaDecimal(v.startsWith('-')?v.slice(1):'-'+v):v;}
  if(e.kind==='binary'&&['+','-','*','/'].includes(e.operator)){
   const a=constant(e.left),b=constant(e.right);if(a===null||b===null)return null;
   if(e.operator==='+')return addFormulaDecimal(a,b);
   if(e.operator==='-')return addFormulaDecimal(a,b.startsWith('-')?b.slice(1):'-'+b);
   if(e.operator==='*')return multiplyFormulaDecimal(a,b);
   return divideFormulaDecimal(a,b);
  }
 }catch{return null;}
 return null;
}
type Source={key:string;label:string};
const keyOf=(e:FormulaExpression):Source|null=>e.kind==='call'?{key:'call:'+e.code.toLowerCase(),label:'{#'+e.code+'}'}:e.kind==='name'?{key:'name:'+e.name.toLowerCase(),label:e.name}:null;
/** Facts a condition proves inside its own branch (x > 0, x <> 0, x >= positive), and facts its
 * failure proves in later branches (x = 0, x <= 0 failed). */
function proves(c:FormulaExpression,when:boolean):string[]{
 if(c.kind==='binary'&&c.operator==='And'&&when)return [...proves(c.left,true),...proves(c.right,true)];
 if(c.kind==='binary'&&c.operator==='Or'&&!when)return [...proves(c.left,false),...proves(c.right,false)];
 if(c.kind!=='binary')return [];
 const source=keyOf(c.left),limit=constant(c.right);if(!source||limit===null)return [];
 const n=Number(limit);
 if(when&&((c.operator==='>'&&n>=0)||(c.operator==='<>'&&n===0)||(c.operator==='>='&&n>0)))return [source.key];
 if(!when&&((c.operator==='='&&n===0)||(c.operator==='<='&&n>=0)||(c.operator==='<'&&n>0)))return [source.key];
 return [];
}
function divisionChecks(program:FormulaProgram,source:string):FormulaDiagnostic[]{
 const out:FormulaDiagnostic[]=[];
 const zeroSources=(e:FormulaExpression,taint:Map<string,boolean>):Source[]=>{
  switch(e.kind){
   case 'call':return MAY_BE_ZERO.has(e.code)?[keyOf(e)!]:[];
   case 'name':return taint.get(e.name.toLowerCase())?[keyOf(e)!]:[];
   case 'unary':return zeroSources(e.operand,taint);
   case 'binary':return ['+','-','*','/'].includes(e.operator)?[...zeroSources(e.left,taint),...zeroSources(e.right,taint)]:[];
   default:return [];
  }
 };
 const visit=(e:FormulaExpression,taint:Map<string,boolean>,guarded:Set<string>)=>{
  if(e.kind==='binary'){
   if(e.operator==='/'){
    const at={line:e.right.loc.line,column:e.right.loc.column,length:formulaTokenLength(source,e.right.loc.line,e.right.loc.column)};
    const value=constant(e.right);
    if(value!==null&&Number(value)===0)out.push({severity:'error',code:'division_by_zero',...at,message:'Division by zero is not allowed'});
    else{const risky=zeroSources(e.right,taint).filter(s=>!guarded.has(s.key));if(risky.length)out.push({severity:'warning',code:'possible_zero_divisor',...at,name:risky[0].label,message:`This divides by ${risky[0].label}, which can be 0`});}
   }
   visit(e.left,taint,guarded);visit(e.right,taint,guarded);
  }else if(e.kind==='unary')visit(e.operand,taint,guarded);
  else if(e.kind==='call')for(const arg of e.args)visit(arg,taint,guarded);
 };
 const block=(statements:FormulaStatement[],taint:Map<string,boolean>,guarded:Set<string>)=>{
  const local=new Set(guarded);
  for(const s of statements){
   switch(s.kind){
    case 'declare':case 'assign':visit(s.value,taint,local);taint.set(s.name.toLowerCase(),zeroSources(s.value,taint).length>0||(s.kind==='assign'&&!!taint.get(s.name.toLowerCase())));break;
    case 'return':case 'explain':visit(s.value,taint,local);break;
    case 'if':{
     const failed:string[]=[];
     for(const branch of s.branches){
      visit(branch.condition,taint,new Set([...local,...failed]));
      block(branch.body,new Map(taint),new Set([...local,...failed,...proves(branch.condition,true)]));
      // An early `Return` under "x = 0" proves x is not 0 for the rest of this block.
      const last=[...branch.body].reverse().find(b=>b.kind!=='comment');
      if(last?.kind==='return')for(const key of proves(branch.condition,false))local.add(key);
      failed.push(...proves(branch.condition,false));
     }
     block(s.otherwise,new Map(taint),new Set([...local,...failed]));break;
    }
    default:break;
   }
  }
 };
 block(program.statements,new Map(),new Set());
 return out;
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPARISONS=new Set(['=','<>','<','<=','>','>=']);
/** What an author probably meant instead of an internal ID: the readable field on the same record. */
const READABLE_ALTERNATIVE:Readonly<Record<string,string>>={companyId:'companyCode',departmentId:'departmentCode',positionId:'positionCode',gradeId:'gradeCode'};
/** An internal-ID Personnel field (a UUID) compared with text that is not a UUID can never match, so every
 * employee silently takes the other branch. Text with no letter or digit (blank, or an unresolved
 * {#MISSING:...} placeholder's analysis surrogate) is not a code and is left alone. The company ID is the reported production case and blocks
 * saving; the other internal-ID fields warn. Named values that hold such a field are followed. */
function internalIdChecks(program:FormulaProgram,source:string):FormulaDiagnostic[]{
 const out:FormulaDiagnostic[]=[];
 const field=(e:FormulaExpression,names:Map<string,string>):string|undefined=>{
  if(e.kind==='name')return names.get(e.name.toLowerCase());
  if(e.kind!=='call'||e.args[0]?.kind!=='literal'||e.args[0].value.type!=='string')return undefined;
  const code=payFormulaFunction(e.code)?.code,adapter=code?personnelFormulaAdapter(code,e.args[0].value.value):undefined;
  return adapter&&personnelFormulaInternalId(adapter)?adapter.key:undefined;
 };
 const visit=(e:FormulaExpression,names:Map<string,string>)=>{
  if(e.kind==='binary'){
   if(COMPARISONS.has(e.operator))for(const [side,other] of [[e.left,e.right],[e.right,e.left]] as const){
    const key=field(side,names);
    if(key&&other.kind==='literal'&&other.value.type==='string'&&/[\p{L}\p{N}]/u.test(other.value.value)&&!UUID.test(other.value.value.trim())){
     const value=other.value.value,company=key==='companyId',suggestion=READABLE_ALTERNATIVE[key];
     out.push({severity:company?'error':'warning',code:'internal_id_compared',line:other.loc.line,column:other.loc.column,length:formulaTokenLength(source,other.loc.line,other.loc.column),name:key,value,suggestion,
      message:company?`companyId is the company's internal ID, so it never equals "${value}". Use companyCode for the company code, or companyName for the legal name.`
       :`${key} is an internal ID, so it never equals "${value}". Choose a value from the field's permitted list${suggestion?`, or use ${suggestion}`:''}.`});
    }
   }
   visit(e.left,names);visit(e.right,names);
  }else if(e.kind==='unary')visit(e.operand,names);
  else if(e.kind==='call')for(const arg of e.args)visit(arg,names);
 };
 const block=(statements:FormulaStatement[],names:Map<string,string>)=>{
  for(const s of statements){
   switch(s.kind){
    case 'declare':case 'assign':{visit(s.value,names);const key=field(s.value,names);if(key)names.set(s.name.toLowerCase(),key);else names.delete(s.name.toLowerCase());break;}
    case 'return':case 'explain':visit(s.value,names);break;
    case 'if':for(const branch of s.branches){visit(branch.condition,names);block(branch.body,new Map(names));}block(s.otherwise,new Map(names));break;
    default:break;
   }
  }
 };
 block(program.statements,new Map());
 return out;
}

/** Every problem the editor can find, sorted by position and capped. Never throws for user input. */
export function diagnosePayFormula(source:string):FormulaDiagnostic[]{
 if(typeof source!=='string'||!source.trim())return [{severity:'error',code:'source',line:1,column:1,length:1,message:'Enter a formula'}];
 const {tree,problems}=inspectPayFormula(source,PAY_FORMULA_DIAGNOSTIC_CAP);
 const diagnostics:FormulaDiagnostic[]=problems.map(problem=>{
  const at={line:problem.line,column:problem.column,length:formulaTokenLength(source,problem.line,problem.column)};
  const name=problem.detail?.name;
  if(problem.code==='function'&&name)return {severity:'error',code:'unknown_function',...at,message:problem.reason,name,suggestion:nearestFormulaName(name,functionNames())};
  if(problem.code==='identifier'&&name){
   const fn=nearestFormulaName(name,functionNames()),exactFunction=fn&&fn.toLowerCase()===name.toLowerCase();
   const local=nearestFormulaName(name,declaredNames(source).filter(n=>n.toLowerCase()!==name.toLowerCase()));
   return {severity:'error',code:'unknown_variable',...at,message:problem.reason,name,suggestion:exactFunction?'{#'+fn+'}':local??(fn?'{#'+fn+'}':undefined)};
  }
  if(problem.code==='return')return {severity:'error',code:'missing_return',...at,message:problem.reason};
  return {severity:'error',code:problem.code,...at,message:problem.reason};
 });
 if(tree)diagnostics.push(...divisionChecks(tree,source),...internalIdChecks(tree,source));
 const seen=new Set<string>();
 return diagnostics.filter(d=>{const key=d.severity+d.line+':'+d.column+':'+d.code;if(seen.has(key))return false;seen.add(key);return true;})
  .sort((a,b)=>a.line-b.line||a.column-b.column||(a.severity===b.severity?0:a.severity==='error'?-1:1)).slice(0,PAY_FORMULA_DIAGNOSTIC_CAP);
}
export const formulaHasBlockingDiagnostic=(diagnostics:readonly FormulaDiagnostic[])=>diagnostics.some(d=>d.severity==='error');
