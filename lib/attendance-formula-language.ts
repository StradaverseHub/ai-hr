import {ATTENDANCE_FORMULA_CATALOG_VERSION,ATTENDANCE_FORMULA_ALIASES,ATTENDANCE_FORMULA_VARIABLES,ATTENDANCE_FORMULA_FIELDS,attendanceFormulaVariable} from './attendance-formula-catalog';
import {parsePayFormula,validatePayFormula,evaluatePayFormula,addFormulaDecimal,type FormulaDialect,type FormulaProgram,type FormulaTraceEvent,type FormulaRequest} from './pay-formula-language';
import {payFormulaFunction,type FormulaFunction,type FormulaValue} from './pay-formula-registry';
export type AttendanceFormulaDefinition={code:string;source:string};
export type AttendanceFormulaLibrary={formulas:readonly AttendanceFormulaDefinition[];conditions:readonly (AttendanceFormulaDefinition&{description?:string;type?:'decimal'|'boolean'})[]};
export type AttendanceFormulaFact={state:'known';value:FormulaValue;source:string;revision:string}|{state:'unavailable';reason:string};
export type AttendanceFormulaDay={date:string;values:Readonly<Record<string,AttendanceFormulaFact>>};
const idPattern=/^[A-Za-z][A-Za-z0-9_]{0,63}$/;
function referenceFunction(code:string,choices:readonly string[],returns:FormulaFunction['returns']):FormulaFunction{return {code,aliases:[],category:'attendance',label:code,description:'An exact versioned attendance reference.',returns,parameters:[{name:'ID',type:'string',literal:true,choices}],source:'canonical attendance'};}
function dialectFor(library:AttendanceFormulaLibrary):FormulaDialect{
 const fieldFunctions=[...new Set(ATTENDANCE_FORMULA_FIELDS.map(field=>field.function))].map(code=>referenceFunction(code,ATTENDANCE_FORMULA_FIELDS.filter(field=>field.function===code).map(field=>field.key),'field'));
 const functions=[...fieldFunctions,referenceFunction('FormulaID',[...ATTENDANCE_FORMULA_VARIABLES.map(v=>v.id),...library.formulas.map(f=>f.code)],'field'),referenceFunction('ConditionID',library.conditions.map(c=>c.code),'field')];
 return {version:ATTENDANCE_FORMULA_CATALOG_VERSION,extendedSyntax:true,lookup:code=>functions.find(f=>f.code.toLowerCase()===code.toLowerCase())??(['Rounding','Date'].includes(payFormulaFunction(code)?.code??'')?payFormulaFunction(code):undefined),fieldType:(code,field)=>code==='ConditionID'?(library.conditions.find(condition=>condition.code===field)?.type??'decimal'):code==='FormulaID'?attendanceFormulaVariable(field)?.type??(library.formulas.some(f=>f.code===field)?'decimal':undefined):ATTENDANCE_FORMULA_FIELDS.find(descriptor=>descriptor.function===code&&descriptor.key===field)?.type};
}
export function compileAttendanceFormulaLibrary(library:AttendanceFormulaLibrary,rootCode?:string){
 if(JSON.stringify(library).length>262144)throw Error('The complete attendance dependency plan exceeds 256 KB.');
 if(library.formulas.length>64||library.conditions.length>64)throw Error('Keep at most 64 formulas and 64 conditions in one dependency plan.');
 const names=new Set<string>();for(const item of [...library.formulas,...library.conditions]){if(!idPattern.test(item.code)||names.has(item.code.toLowerCase())||ATTENDANCE_FORMULA_VARIABLES.some(variable=>variable.id.toLowerCase()===item.code.toLowerCase()))throw Error('Choose unique formula and condition IDs outside the variable library.');names.add(item.code.toLowerCase());}
 const dialect=dialectFor(library),programs=new Map<string,FormulaProgram>();
 const conditionTypes=new Map(library.conditions.map(condition=>[condition.code,condition.type??'decimal']));
 for(const item of [...library.formulas,...library.conditions]){try{programs.set(item.code,parsePayFormula(item.source,{...dialect,returnType:conditionTypes.get(item.code)??'decimal'}));}catch(error){throw Error(item.code+': '+(error instanceof Error?error.message:'Invalid source.'));}}
 const allCalls:FormulaRequest[]=[],callsByCode=new Map<string,FormulaRequest[]>();
 const visiting=new Set<string>(),visited=new Set<string>();
 const visit=(code:string,depth:number)=>{if(depth>12||visiting.has(code))throw Error('Formula references contain a cycle or exceed 12 levels.');if(visited.has(code))return;visiting.add(code);const program=programs.get(code);if(!program)throw Error('Formula reference is unavailable.');const calls=validatePayFormula(program,{...dialect,returnType:conditionTypes.get(code)??'decimal'}).calls;allCalls.push(...calls);callsByCode.set(code,calls);for(const call of calls){if(['FormulaID','ConditionID'].includes(call.code)){const target=String(call.args[0].value);if(programs.has(target))visit(target,depth+1);}}visiting.delete(code);visited.add(code);};
 for(const code of programs.keys())visit(code,0);
 const heights=new Map<string,number>();
 const height=(code:string):number=>{const old=heights.get(code);if(old!==undefined)return old;const targets=(callsByCode.get(code)??[]).filter(call=>['FormulaID','ConditionID'].includes(call.code)&&programs.has(String(call.args[0].value))).map(call=>String(call.args[0].value));const result=1+Math.max(0,...targets.map(height));if(result>12)throw Error('Formula dependencies exceed 12 levels.');heights.set(code,result);return result;};
 for(const code of programs.keys())height(code);
 const reachable=new Set<string>();const collect=(code:string)=>{if(reachable.has(code))return;if(!programs.has(code))throw Error('Choose a saved root formula.');reachable.add(code);for(const call of callsByCode.get(code)??[]){const target=String(call.args[0]?.value);if(['FormulaID','ConditionID'].includes(call.code)&&programs.has(target))collect(target);}};
 if(rootCode)collect(rootCode);
 const sourceCalls=rootCode?[...reachable].flatMap(code=>callsByCode.get(code)??[]):allCalls;
 const fields=[...new Map(sourceCalls.filter(call=>ATTENDANCE_FORMULA_FIELDS.some(field=>field.function===call.code&&field.key===String(call.args[0]?.value))).map(call=>[call.code+':'+String(call.args[0].value),{code:call.code,key:String(call.args[0].value)}])).values()].sort((a,b)=>(a.code+':'+a.key).localeCompare(b.code+':'+b.key));
 const variables=[...new Set(sourceCalls.filter(call=>call.code==='FormulaID'&&!programs.has(String(call.args[0]?.value))).map(call=>String(call.args[0]?.value)))].sort();
 // A dependency graph may use either spelling, but cannot combine two names for the same minutes.
 // Check each reachable root independently so unrelated reusable formulas remain legal.
 const checkedRoots=rootCode?[rootCode]:library.formulas.map(formula=>formula.code);
 for(const root of checkedRoots){const seen=new Set<string>(),ids=new Set<string>();const walk=(code:string)=>{if(seen.has(code))return;seen.add(code);for(const call of callsByCode.get(code)??[]){const id=String(call.args[0]?.value);if(['FormulaID','ConditionID'].includes(call.code)&&programs.has(id))walk(id);else if(call.code==='FormulaID')ids.add(id);}};walk(root);const canonical=new Map<string,string>();for(const id of ids){const key=ATTENDANCE_FORMULA_ALIASES[id]??id,prior=canonical.get(key);if(prior&&prior!==id)throw Error(`Attendance variables ${prior} and ${id} are aliases of the same minutes. Use one ID to prevent duplicate counting.`);canonical.set(key,id);}}
 return {dialect,programs,fields,variables,requirements:{financial:fields.some(field=>field.code==='EmployeeInformation'&&field.key==='basicSalary'),workforce:fields.some(field=>field.code.startsWith('Employee')&&field.key!=='basicSalary')}};
}
/** Every value comes from an authorized native source. This engine cannot read storage or post pay. */
export function evaluateAttendanceFormula(library:AttendanceFormulaLibrary,code:string,days:readonly AttendanceFormulaDay[]){
 if(!days.length||days.length>62||new Set(days.map(day=>day.date)).size!==days.length||days.some((day,i)=>i>0&&day.date<=days[i-1].date))throw Error('Supply a nonempty ordered attendance period of at most 62 dates.');
 const {dialect,programs}=compileAttendanceFormulaLibrary(library),conditionTypes=new Map(library.conditions.map(c=>[c.code,c.type??'decimal'])),cache=new Map<string,string>(),trace:{formula:string;event:FormulaTraceEvent;request?:FormulaRequest}[]=[];let totalSteps=0;
 const fact=(key:string):FormulaValue=>{
  const variable=attendanceFormulaVariable(key),values=days.map(day=>{const value=day.values[key];if(!value||value.state!=='known'||!value.source||!value.revision)throw Error(`Attendance variable ${key} is unavailable for ${day.date}.`);return value.value;});
  if(variable?.aggregation==='sum'){let sum='0';for(const value of values){if(value.type!=='decimal')throw Error('The attendance source returned an incompatible unit.');sum=addFormulaDecimal(sum,value.value);}return {type:'decimal',value:sum};}
  if(variable?.aggregation==='last')return values.at(-1)!;
  if(values.some(value=>JSON.stringify(value)!==JSON.stringify(values[0])))throw Error(`Attendance variable ${key} differs across this period; use a daily formula.`);
  return values[0];
 };
 const run=(id:string):string=>{const hit=cache.get(id);if(hit!==undefined)return hit;let lastRead:FormulaRequest|undefined;const program=programs.get(id);if(!program)throw Error('Formula is unavailable in the tested version.');const result=evaluatePayFormula(program,{resolve:request=>{lastRead=request;const key=String(request.args[0]?.value);if(request.code==='FormulaID')return programs.has(key)?{type:'decimal',value:run(key)}:fact(key);if(request.code==='ConditionID'){const value=run(key);return conditionTypes.get(key)==='boolean'?{type:'boolean',value:value==='1'}:{type:'decimal',value};}return fact(request.code+':'+key);},trace:event=>{if(trace.length>=6000)throw Error('Attendance dependency trace exceeds its limit.');trace.push({formula:id,event,...(event.kind==='read'&&lastRead?{request:lastRead}:{})});}},{...dialect,returnType:conditionTypes.get(id)??'decimal'});totalSteps+=result.steps;if(totalSteps>12000)throw Error('Attendance dependency evaluation exceeded its limit.');cache.set(id,result.amount);return result.amount;};
 return {amount:run(code),trace,registryVersion:ATTENDANCE_FORMULA_CATALOG_VERSION};
}
