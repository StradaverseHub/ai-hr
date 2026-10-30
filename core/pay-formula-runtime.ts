/** Authorized source adapter shared by simulation and the native payroll kernel. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {Tx,SessionContext} from '../db/client';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {isCalendarDate} from '../lib/calendar-date';
import {serviceYearsAt} from '../lib/completed-years';
import {PayFormulaError as FormulaLanguageError,evaluatePayFormula,analyzePayFormula,normalizeFormulaDecimal,addFormulaDecimal,applyFormulaAmount,divideFormulaDecimal,type FormulaRequest,type FormulaValue} from '../lib/pay-formula-language';
import {PAY_FORMULA_PROVIDER_VERSION} from '../lib/pay-formula-registry';
import {PayFormulaError,type ActiveFormula,type PayFormulaContext,type FormulaReadRequirements} from '../lib/pay-formula-model';
import {resolvePayrollPermission,loadActiveFormulaProgramTx,loadFormulaAccumulationGroupsTx,recordFormulaEvaluationTx,resolvePayComponentSet,resolveAssignedPolicy,resolveProrationSettings,prorationDivisorDays,usesWorkingDayProration,workingDayRoster,cutOffWindowFor,type PayRuleScope,type PayRuleFormulaRuntime,type ResolvablePayComponent,readPayrollComponentInputsTx,readPayrollIndividualLedgerTx,readPayrollAttendanceHoursTx,payRuleDependencies,payRuleReadsFixedAllowanceTotal,payItemFeedsOvertimeOrp} from '../packs/payroll/service';
import {assertWorkforceEmploymentTx} from './workforce-access';
import {companyOnDate,companySegmentsForPeriodBulk,segmentForCompany} from './employment-company';
import {employmentInformationAt} from './information-correction-history';
import {employment,companyPayrollConfig} from '../db/schema';
import {eq} from 'drizzle-orm';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {holidayDatesFor} from './holidays';
import {eligibleWorkingDays,payrollIncrementBasic,payrollRateBasic,payrollRoundAmount} from '../lib/payroll-basic';
import {isModuleEnabled,settingEnabled} from './entitlements';
import {payrollProrationRatio} from '../lib/payroll-proration';

const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const fingerprint=(v:unknown)=>createHash('sha256').update(JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value)).digest('hex');
const legacyDecimal=(v:number)=>{if(!Number.isFinite(v)||Math.abs(v)>1e8)throw unavailable('legacy source amount');const text=String(v);return normalizeFormulaDecimal(/^-?\d+(?:\.\d{1,12})?$/.test(text)?text:v.toFixed(12));};
const itemKey=(code:string)=>code.trim().toUpperCase();
const decimal=(v:string):FormulaValue=>({type:'decimal',value:normalizeFormulaDecimal(v)});
const unavailable=(name:string)=>new PayFormulaError('Formula source is unavailable or ambiguous: '+name,'FORMULA_SOURCE_UNAVAILABLE');
const category=(s:string):FormulaReadRequirements['categories'][number]=>s==='payroll'?'compensation':s==='restricted'||s==='documents'?'confidential_hr':s==='identity'||s==='bank'||s==='statutory'?s:'personnel';
const requirements=(fields:string[],workforce?:boolean):FormulaReadRequirements=>({fieldIds:[...new Set(fields)].sort(),categories:[...new Set(fields.map(id=>{const f=PERSONNEL_FIELDS.find(f=>f.id===id);if(!f)throw unavailable(id);return category(f.sensitivity);}))].sort(),...(workforce===undefined?{}:{workforce})});
/** Financial source authority remains the Native financial owner. Workforce-record purposes
 * are an additional requirement only when an expression actually reads that class of source. */
async function financialSubjectTx(tx:Tx,ctx:SessionContext,companyId:string,employmentId:string){
 if(!uuid.test(companyId)||!uuid.test(employmentId)||!ctx.userId)throw new PayFormulaError('The payroll employee or permission is unavailable.','FORMULA_SOURCE_DENIED');
 await lockAccessConfigurationTx(tx,ctx.tenantId);
 const [row]=await tx.execute<{companyId:string;allowed:boolean}>(sql`select e.company_id as "companyId",app.principal_snapshot_current() and app.can_admin_payroll_for(${companyId}::uuid) and app.can_admin_payroll_employment(e.id) as allowed from public.employment e join public.company paying on paying.id=${companyId}::uuid and paying.tenant_id=${ctx.tenantId}::uuid where e.id=${employmentId}::uuid and e.tenant_id=${ctx.tenantId}::uuid`);
 if(!row?.allowed)throw new PayFormulaError('The payroll employee or permission is unavailable.','FORMULA_SOURCE_DENIED');return row;
}
export async function formulaReadRequirementsAllowedTx(tx:Tx,ctx:SessionContext,companyId:string,employmentId:string,r:FormulaReadRequirements){
 let subject:{companyId:string};try{subject=await financialSubjectTx(tx,ctx,companyId,employmentId);}catch{return false;}
 const valid=['personnel','compensation','identity','bank','statutory','confidential_hr'];
 if(r.fieldIds.some(id=>!PERSONNEL_FIELDS.some(f=>f.id===id))||r.categories.some(c=>!valid.includes(c)))return false;
 const needed=new Set([...r.categories,...requirements(r.fieldIds).categories]),privateRecord=[...needed].some(c=>['identity','bank','statutory','confidential_hr'].includes(c));
 const workforce=privateRecord||(typeof r.workforce==='boolean'?r.workforce:[...needed].some(c=>c!=='compensation'));
 if(workforce){try{await assertWorkforceEmploymentTx(tx,ctx,employmentId,'view');}catch{return false;}}
 for(const c of needed){if(!await resolvePayrollPermission(tx,ctx,`report.read.${c}`,companyId))return false;
  if(workforce&&c!=='compensation'&&subject.companyId!==companyId&&!await resolvePayrollPermission(tx,ctx,`report.read.${c}`,subject.companyId))return false;
 }return true;
}
const profileFields:Record<string,string>={joinDate:'employment.employment_dates_and_service.joindate',groupJoinDate:'employment.employment_dates_and_service.hiredon',resignationDate:'employment.employment_dates_and_service.resignationdate',confirmationDate:'employment.employment_dates_and_service.confirmationdate',lastWorkingDate:'employment.employment_dates_and_service.lastworkingdate',employmentType:'employment.organisation_assignment.employmenttype',employeeNo:'profile.personal_details.employeecode',departmentCode:'employment.organisation_assignment.departmentname',positionCode:'employment.organisation_assignment.positionname',gradeCode:'employment.organisation_assignment.gradename'};
const employeeFields:Record<string,string>={dateOfBirth:'profile.personal_details.dateofbirth',gender:'profile.personal_details.gender',nationality:'profile.personal_details.nationality',maritalStatus:'profile.personal_details.maritalstatus'};
const basicField='payroll.basic_salary_and_salary_history.basicsalary',payModeField='payroll.basic_salary_and_salary_history.paymode';
function sourceFields(request:FormulaRequest):string[]{
 const code=request.code,a=String(request.args[0]?.value??'');
 if(code==='Basic'||code==='Input')return [basicField];if(code==='Payrate')return [payModeField];
 if(code==='EmployeeProfile')return [profileFields[a]];if(code==='EmployeeInformation')return [employeeFields[a]];
 if(['JoinDate','JoinedThisMonth'].includes(code))return [profileFields.joinDate];
 if(['GroupJoinDate','GroupJoinedThisMonth'].includes(code))return [profileFields.groupJoinDate];
 if(['ResignationDate','ResignedThisMonth'].includes(code))return [profileFields.resignationDate];
 if(code==='ServiceLength')return [profileFields[String(request.args[1]?.value)==='joinDate'?'joinDate':'groupJoinDate']];
 if(['PayItem','PayItemNoProrate','PayItemInput','Accumulation','AnotherPayItems'].includes(code))return [basicField];return [];
}
type CatalogRow={id:string;code:string;kind:string;rule:ResolvablePayComponent['rule'];prorates:boolean;rounding:string;resolutionOrder:number;context:{ordinaryRate?:string;hoursPerDay?:string;rate?:string}|null;archived:boolean};
export type FormulaRuntimeSnapshot={components:readonly ResolvablePayComponent[];scope:PayRuleScope;basic:string;proratedBasic:string;factor:string;legacyFactor?:number;inputComponents?:readonly ResolvablePayComponent[];sourceEvidence?:unknown;batchId?:string};
type Evaluation={formula:ActiveFormula;componentCode:string;amount:string;explanations:string[];reads:unknown;sources:unknown;readRequirements:FormulaReadRequirements};

/** Scope is checked before every source read. Denied or absent branch sources remain errors,
 * not zeros; evaluating a branch that never reads that source remains possible. */
export async function preparePayFormulaRuntimeTx(tx:Tx,ctx:SessionContext,context:PayFormulaContext,snapshot:FormulaRuntimeSnapshot,override?:ActiveFormula){
 if(!uuid.test(context.companyId)||!uuid.test(context.employmentId)||(!uuid.test(context.cycleId)&&!(snapshot.batchId&&context.cycleId===''))||!/^\d{4}-\d{2}$/.test(context.period)||!isCalendarDate(context.asOf))throw unavailable('test context');
 await financialSubjectTx(tx,ctx,context.companyId,context.employmentId);
 if(await companyOnDate(tx,context.employmentId,context.asOf)!==context.companyId)throw unavailable('employee company at selected date');
 const cycles=context.cycleId?await tx.execute<{id:string}>(sql`select id from payroll_cycle where id=${context.cycleId}::uuid and company_id=${context.companyId}::uuid and tenant_id=${ctx.tenantId}::uuid`):[];if(context.cycleId&&cycles.length!==1)throw unavailable('payroll cycle');
 const catalog=await tx.execute<CatalogRow>(sql`select id,code,kind,rule,prorates,rounding_method as rounding,resolution_order as "resolutionOrder",formula_context as context,archived_at is not null as archived from pay_component where tenant_id=${ctx.tenantId}::uuid order by code`);
 const catalogItem=(name:string)=>{const matches=catalog.filter(c=>itemKey(c.code)===itemKey(name));if(matches.length!==1||matches[0].archived)throw unavailable(name);return matches[0];};
 const active=new Map<string,ActiveFormula>();if(override)active.set(override.formulaId,override);
 for(const c of snapshot.components)if(c.rule?.kind==='formula_builder'&&!active.has(c.rule.formulaId))active.set(c.rule.formulaId,await loadActiveFormulaProgramTx(tx,ctx,c.rule.formulaId,context.companyId));
 for(const c of snapshot.components)if(c.rule?.kind==='formula_builder'&&!(override&&itemKey(c.code)===itemKey(context.currentCode))&&JSON.stringify([...c.rule.dependencies].sort())!==JSON.stringify([...(active.get(c.rule.formulaId)?.dependencies??[])].sort()))throw unavailable('Pay Item dependency plan');
 const calls=[...active.values()].flatMap(f=>analyzePayFormula(f.program).calls);
 const allowed=new Map<string,boolean>(),values=new Map<string,unknown>(),sources:unknown[]=[];
 const requestedFields=new Set(calls.flatMap(sourceFields));requestedFields.add(basicField);
 for(const id of requestedFields)allowed.set(id,await formulaReadRequirementsAllowedTx(tx,ctx,context.companyId,context.employmentId,requirements([id])));
 const financialAllowed=new Map<string,boolean>();for(const id of [basicField,profileFields.groupJoinDate])financialAllowed.set(id,await formulaReadRequirementsAllowedTx(tx,ctx,context.companyId,context.employmentId,requirements([id],false)));
 const hiredOn=employmentInformationAt('hiredOn',sql`${context.asOf}::date`,sql`${employment.hiredOn}`),joinDate=employmentInformationAt('joinDate',sql`${context.asOf}::date`,sql`${employment.joinDate}`);
 // Only fetch source categories the actor can read. Exact named columns avoid accidental widening.
 const employmentNeeded=[...requestedFields].some(id=>allowed.get(id)&&Object.values(profileFields).includes(id));
 if(employmentNeeded){const rows=await tx.execute<Record<string,unknown>>(sql`select ${hiredOn}::text as "groupJoinDate",${joinDate}::text as "joinDate",resignation_date::text as "resignationDate",confirmation_date::text as "confirmationDate",last_working_date::text as "lastWorkingDate",employee_code as "employeeNo" from employment where id=${context.employmentId}::uuid`);for(const [k,v]of Object.entries(rows[0]??{}))if(allowed.get(profileFields[k]))values.set(profileFields[k],v);sources.push({owner:'employment-information',asOf:context.asOf,values:[...values]});
 const assignments=await tx.execute<Record<string,unknown>>(sql`select a.id,a.employment_type as "employmentType",d.name as "departmentCode",p.title as "positionCode" from assignment a join employment on employment.id=a.employment_id left join department d on d.id=a.department_id left join position p on p.id=a.position_id where a.employment_id=${context.employmentId}::uuid and coalesce(a.company_id,${employmentInformationAt('companyId',sql`${context.asOf}::date`,sql`${employment.companyId}`)}::uuid)=${context.companyId}::uuid and a.valid_from<=${context.asOf}::date and (a.valid_to is null or a.valid_to>${context.asOf}::date) and a.superseded_at is null`);if(assignments.length===1)for(const [k,v]of Object.entries(assignments[0]))if(allowed.get(profileFields[k]))values.set(profileFields[k],v);
 if(allowed.get(profileFields.gradeCode)){const rows=await tx.execute<{value:string}>(sql`select g.code as value from employment e join job_grade g on g.id=e.grade_id where e.id=${context.employmentId}::uuid`);values.set(profileFields.gradeCode,rows[0]?.value);}
 }
 for(const [key,id]of Object.entries(employeeFields))if(allowed.get(id)){
 const column={dateOfBirth:'date_of_birth',gender:'gender',nationality:'nationality',maritalStatus:'marital_status'}[key]!;
 const rows=await tx.execute<{value:unknown}>(sql`select ${sql.identifier(column)}::text as value from person where id=(select person_id from employment where id=${context.employmentId}::uuid)`);values.set(id,rows[0]?.value);sources.push({owner:'person-current',field:id,value:rows[0]?.value});
 }
 if(allowed.get(basicField))values.set(basicField,snapshot.basic);
 if(allowed.get(payModeField)){const rows=await tx.execute<{id:string;value:string}>(sql`select id,pay_mode as value from compensation where employment_id=${context.employmentId}::uuid and valid_from<=${context.asOf}::date and (valid_to is null or valid_to>${context.asOf}::date) and superseded_at is null`);if(rows.length===1){values.set(payModeField,rows[0].value);sources.push({owner:'compensation',...rows[0]});}}
 const groups=await loadFormulaAccumulationGroupsTx(tx,ctx),history=new Map<string,FormulaValue|Error>();
 for(const call of calls.filter(c=>c.code==='AnotherPayItems')){
 const args=call.args.map(a=>String(a.value)),key=JSON.stringify(args);if(history.has(key))continue;
 if(!allowed.get(basicField)){history.set(key,new PayFormulaError('Formula source permission is unavailable.','FORMULA_SOURCE_DENIED'));continue;}
 const [code,period,cycle,result]=args;if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)||period>context.period||!result||(!uuid.test(result)&&!/^\d+$/.test(result))){history.set(key,unavailable('historical result'));continue;}
 const rows=await tx.execute<{id:string;version:number;statutory:Record<string,unknown>;basic:string;batchId:string}>(sql`select s.id,s.version,s.statutory,s.basic_salary as basic,b.id as "batchId" from payslip s join payroll_history_effective_batch b on b.id=s.batch_id join payroll_cycle c on c.id=b.payroll_cycle_id where s.employment_id=${context.employmentId}::uuid and b.company_id=${context.companyId}::uuid and b.pay_period=${period} and (c.id::text=${cycle} or c.code=${cycle}) and (${uuid.test(result)?sql`s.id=${result}::uuid`:sql`b.run_seq=${Number(result)}`}) and ${snapshot.batchId?sql`b.id<>${snapshot.batchId}::uuid`:sql`true`}`);
 if(rows.length!==1){history.set(key,unavailable('historical result'));continue;}const row=rows[0],nativeLines=Array.isArray(row.statutory.componentLines)?row.statutory.componentLines:[],importedLines=Array.isArray(row.statutory.importedLines)?row.statutory.importedLines:[],lines=(nativeLines.some(l=>l&&typeof l==='object'&&'code'in l&&String(l.code).toUpperCase()===code.toUpperCase())?nativeLines:importedLines).filter((l):l is {code:string;amount:string|number}=>!!l&&typeof l==='object'&&'code'in l&&String(l.code).toUpperCase()===code.toUpperCase()&&'amount'in l);
 try{const value=code.toUpperCase()==='BASIC'?normalizeFormulaDecimal(row.basic):lines.length?lines.reduce((sum,l)=>addFormulaDecimal(sum,String(l.amount)),'0'):(()=>{throw unavailable(code);})();history.set(key,decimal(value));sources.push({owner:'payroll-history',payslipId:row.id,version:row.version,batchId:row.batchId,code,value});}catch{history.set(key,unavailable(code));}
 }
 const raw=new Map<string,string>(),unprorated=new Map<string,string>([['BASIC',snapshot.basic]]),prorated=new Map<string,string>([['BASIC',snapshot.proratedBasic]]),applied=new Map<ResolvablePayComponent,string>(),exact=new Map<ResolvablePayComponent,string>(),evaluations:Evaluation[]=[];
 const unknownInputs=new Set<string>();for(const c of snapshot.inputComponents??snapshot.components){if(c.formulaInput===undefined)unknownInputs.add(itemKey(c.code));else raw.set(itemKey(c.code),addFormulaDecimal(raw.get(itemKey(c.code))??'0',c.formulaInput));}for(const code of unknownInputs)raw.delete(code);raw.set('BASIC',snapshot.basic);
 let usedWorkforce=false;const usedFields=new Set<string>(),read=(id:string)=>{if(!allowed.get(id))throw new PayFormulaError('Formula source permission is unavailable.','FORMULA_SOURCE_DENIED');usedFields.add(id);const v=values.get(id);if(v===null||v===undefined||v==='')throw unavailable(id);return String(v);};
 const fieldValue=(id:string,type:'date'|'string'):FormulaValue=>({type,value:read(id)});
 const legacyPersonnel=(code:string,proratedValue:boolean,seen=new Set<string>()):boolean=>{
  if(code==='BASIC')return proratedValue;if(seen.has(code))return false;seen.add(code);
  for(const c of snapshot.components.filter(c=>itemKey(c.code)===itemKey(code))){
   if(proratedValue&&(c.prorateOverride??c.prorates))return true;
   const rule=c.rule;if(rule?.kind==='per_day'||rule?.kind==='per_hour')return true;
   if(rule?.kind==='formula'&&[rule.start,...rule.terms.map(t=>t.operand)].some(o=>['prorated_basic','days','hours'].includes(o.ref)))return true;
   if(rule?.kind!=='formula_builder'){
    if(payRuleDependencies(rule).some(dep=>legacyPersonnel(dep,false,new Set(seen))))return true;
    if(payRuleReadsFixedAllowanceTotal(rule)&&snapshot.components.some(item=>itemKey(item.code)!==itemKey(code)&&!item.nonPayable&&!item.oneOff&&payItemFeedsOvertimeOrp(item.code,item.kind,item.rule,item.orpOvertime)&&legacyPersonnel(item.code,false,new Set(seen))))return true;
   }
  }return false;
 };
 const fromMap=(m:Map<string,string>,name:string)=>{if(itemKey(name)!=='BASIC')catalogItem(name);if(!allowed.get(basicField))throw new PayFormulaError('Formula source permission is unavailable.','FORMULA_SOURCE_DENIED');usedFields.add(basicField);if(m!==raw&&legacyPersonnel(itemKey(name),m===prorated)){if(!financialAllowed.get(profileFields.groupJoinDate))throw new FormulaLanguageError('source_denied','Formula source permission is unavailable.');usedFields.add(profileFields.groupJoinDate);}const v=m.get(itemKey(name));if(v===undefined)throw unavailable(name);return decimal(v);};
 const runtime:PayRuleFormulaRuntime={
 resolve(rule,component){const formula=active.get(rule.formulaId);if(!formula)throw unavailable(rule.formulaId);const config=catalogItem(component.code);
 const implicitFields=[basicField,...((component.prorateOverride??component.prorates)?[profileFields.groupJoinDate]:[])];for(const id of implicitFields){if(!financialAllowed.get(id))throw new PayFormulaError('Formula source permission is unavailable.','FORMULA_SOURCE_DENIED');usedFields.add(id);}
 let result:ReturnType<typeof evaluatePayFormula>;try{result=evaluatePayFormula(formula.program,{resolve(request){const args=request.args.map(a=>String(a.value)),code=request.code;const fields=sourceFields(request);for(const id of fields){if(!allowed.get(id))throw new FormulaLanguageError('source_denied','Formula source permission is unavailable.',request.loc);usedFields.add(id);}if(requirements(fields).categories.some(c=>c!=='compensation'))usedWorkforce=true;
 switch(code){
 case 'Basic':return decimal(read(basicField));
 case 'Payrate':{const value=({monthly:'Monthly',daily:'Daily',hourly:'Hourly',custom_period:'Custom Period'} as Record<string,string>)[read(payModeField)];if(!value)throw unavailable('pay mode');return {type:'string',value};}
 case 'Input':if(component.formulaInput===undefined)throw unavailable('current input');return decimal(component.formulaInput);
 case 'InputType':return {type:'string',value:rule.kind};
 case 'OrdinaryRate':case 'HoursPerDay':case 'Rate':{const key=code==='OrdinaryRate'?'ordinaryRate':code==='HoursPerDay'?'hoursPerDay':'rate',value=config.context?.[key];if(value===undefined)throw unavailable(code);return decimal(value);}
 case 'PayItem':return fromMap(prorated,args[0]);case 'PayItemNoProrate':return fromMap(unprorated,args[0]);case 'PayItemInput':return fromMap(raw,args[0]);
 case 'Accumulation':{const group=groups.find(g=>g.code===args[0].toUpperCase());if(!group)throw unavailable(args[0]);return decimal(group.members.reduce((sum,c)=>addFormulaDecimal(sum,String(fromMap(prorated,c).value)),'0'));}
 case 'AnotherPayItems':{usedFields.add(basicField);const result=history.get(JSON.stringify(args));if(result instanceof Error)throw result;if(!result)throw unavailable('historical result');return result;}
 case 'EmployeeProfile':return fieldValue(profileFields[args[0]],/Date$/.test(args[0])?'date':'string');
 case 'EmployeeInformation':return fieldValue(employeeFields[args[0]],args[0]==='dateOfBirth'?'date':'string');
 case 'JoinDate':case 'GroupJoinDate':case 'ResignationDate':return fieldValue(profileFields[code[0].toLowerCase()+code.slice(1)],'date');
 case 'JoinedThisMonth':case 'GroupJoinedThisMonth':case 'ResignedThisMonth':{const id=profileFields[code==='JoinedThisMonth'?'joinDate':code==='GroupJoinedThisMonth'?'groupJoinDate':'resignationDate'];usedFields.add(id);const value=values.get(id);return {type:'boolean',value:typeof value==='string'&&value.slice(0,7)===context.period};}
 case 'ServiceLength':{const basis=args[1]==='joinDate'?'joinDate':'groupJoinDate',date=read(profileFields[basis]);if(date>context.asOf)throw unavailable('service start');const start=new Date(date+'T00:00:00Z'),end=new Date(context.asOf+'T00:00:00Z');const n=args[0]==='years'?serviceYearsAt(date,context.asOf):args[0]==='months'?(end.getUTCFullYear()-start.getUTCFullYear())*12+end.getUTCMonth()-start.getUTCMonth()-(end.getUTCDate()<start.getUTCDate()?1:0):Math.floor((end.getTime()-start.getTime())/86400000);return decimal(String(n));}
 default:throw unavailable(code);
 }
 }});}catch(error){if(error instanceof FormulaLanguageError&&error.code==='source_denied')throw new PayFormulaError('Formula source permission is unavailable.','FORMULA_SOURCE_DENIED');throw error;}const amount=result.amount;exact.set(component,amount);if(Number(amount)<0||Number(amount)>1e8)throw unavailable('result outside Pay Item amount limits');const paid=applyFormulaAmount(result.amount,{factor:(component.prorateOverride??component.prorates)?snapshot.factor:undefined,rounding:component.rounding as 'none'|'up'|'down'|'nearest'});applied.set(component,paid);
 evaluations.push({formula,componentCode:component.code,amount:paid,explanations:result.explanations,reads:result.reads,sources:{providerVersion:PAY_FORMULA_PROVIDER_VERSION,context:{...context,currentCode:component.code,input:component.formulaInput??context.input},catalog:config,sourceEvidence:sources.map(source=>Object.fromEntries(Object.entries(source as Record<string,unknown>).filter(([key])=>!['value','values'].includes(key)))),factor:(component.prorateOverride??component.prorates)?snapshot.factor:undefined,sourceFingerprint:fingerprint({providerVersion:PAY_FORMULA_PROVIDER_VERSION,sources,fields:[...values].sort(([a],[b])=>a.localeCompare(b)),raw:[...raw],basic:snapshot.basic,proratedBasic:snapshot.proratedBasic})},readRequirements:requirements([...usedFields],usedWorkforce)});return amount;
 },
 publish(code,components){if(code==='BASIC')return;let before='0',after='0';for(const row of components){const value=applied.get(row.component);before=addFormulaDecimal(before,exact.get(row.component)??((!row.component.rule||row.component.rule.kind==='fixed')&&row.component.formulaInput!==undefined?normalizeFormulaDecimal(row.component.formulaInput):legacyDecimal(row.amount)));after=addFormulaDecimal(after,value??normalizeFormulaDecimal(String(payrollRoundAmount((row.component.prorateOverride??row.component.prorates)?row.amount*(snapshot.legacyFactor??Number(snapshot.factor)):row.amount,row.component.rounding))));}unprorated.set(code,before);prorated.set(code,after);}
 };
 return {runtime,applied,evaluations,sourceFingerprint:()=>fingerprint({providerVersion:PAY_FORMULA_PROVIDER_VERSION,context,catalog,groups,sources,raw:[...raw],basic:snapshot.basic,proratedBasic:snapshot.proratedBasic,factor:snapshot.factor,fields:[...values].sort(([a],[b])=>a.localeCompare(b)),sourceEvidence:snapshot.sourceEvidence}),readRequirements:()=>requirements([...usedFields],usedWorkforce),async record(){const refs=[];for(const e of evaluations){if(!snapshot.batchId)throw unavailable('payroll batch');const evaluationId=await recordFormulaEvaluationTx(tx,ctx,{...e,companyId:context.companyId,employmentId:context.employmentId,batchId:snapshot.batchId,period:context.period});refs.push({formulaId:e.formula.formulaId,revisionId:e.formula.revisionId,contentHash:e.formula.contentHash,evaluationId,componentCode:e.componentCode,amount:e.amount});}return refs;}};
}

export async function simulatePayFormulaTx(tx:Tx,ctx:SessionContext,formula:ActiveFormula,context:PayFormulaContext){
 await financialSubjectTx(tx,ctx,context.companyId,context.employmentId);
 if(!isCalendarDate(context.asOf)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(context.period)||!uuid.test(context.cycleId))throw unavailable('test context');
 if(!isModuleEnabled(ctx,'typed_pay_components'))throw unavailable('Typed Pay Items module');
 const start=context.period+'-01',dim=new Date(Date.UTC(Number(context.period.slice(0,4)),Number(context.period.slice(5)),0)).getUTCDate(),end=context.period+'-'+String(dim).padStart(2,'0');
 if(context.asOf<start||context.asOf>end)throw new PayFormulaError('Choose an effective date within the selected payroll month.');
 const [cycle]=await tx.execute<{id:string;runType:string}>(sql`select id,run_type as "runType" from payroll_cycle where id=${context.cycleId}::uuid and company_id=${context.companyId}::uuid`);if(!cycle)throw unavailable('payroll cycle');
 const requestedBatchId=(context as PayFormulaContext&{batchId?:string}).batchId;if(requestedBatchId&&!uuid.test(requestedBatchId))throw unavailable('payroll run');
 const batches=await tx.execute<{id:string;runType:string;payrollCycleId:string|null;runSeq:number}>(sql`select id,run_type as "runType",payroll_cycle_id as "payrollCycleId",run_seq as "runSeq" from payroll_batch where company_id=${context.companyId}::uuid and pay_period=${context.period} and ${requestedBatchId?sql`id=${requestedBatchId}::uuid and (payroll_cycle_id=${context.cycleId}::uuid or (payroll_cycle_id is null and run_type=${cycle.runType}))`:sql`payroll_cycle_id=${context.cycleId}::uuid`} order by id`);
 if(batches.length>1)throw new PayFormulaError('Choose the exact payroll run before testing this formula.');if(requestedBatchId&&batches.length!==1)throw unavailable('selected payroll run');const batch=batches[0];
 // A selected Native run owns its compensation at period end; standalone previews use the chosen record date.
 const salaryDate=batch?end:context.asOf;
 const salaryRows=await tx.execute<{id:string;basic:string;payMode:string;rateAmount:string|null;validFrom:string;validTo:string|null}>(sql`select id,basic_salary as basic,pay_mode as "payMode",rate_amount as "rateAmount",valid_from::text as "validFrom",valid_to::text as "validTo" from compensation where employment_id=${context.employmentId}::uuid and valid_from<=${salaryDate}::date and (valid_to is null or valid_to>${salaryDate}::date) and superseded_at is null`);if(salaryRows.length!==1)throw unavailable('effective compensation');const salary=salaryRows[0];
 const [dates]=await tx.execute<{companyId:string;hiredOn:string;terminatedOn:string|null}>(sql`select company_id as "companyId",${employmentInformationAt('hiredOn',sql`${context.asOf}::date`,sql`${employment.hiredOn}`)}::text as "hiredOn",terminated_on::text as "terminatedOn" from employment where id=${context.employmentId}::uuid`);if(!dates)throw unavailable('employment dates');
 const segments=await companySegmentsForPeriodBulk(tx,[context.employmentId],start,end,new Map([[context.employmentId,dates.companyId]])),mine=segmentForCompany(segments.get(context.employmentId)??[],context.companyId);if(!mine||mine.split||context.asOf<mine.from||context.asOf>mine.to)throw unavailable('employer segment for the selected payroll month');
 const hired=mine&&mine.from>dates.hiredOn?mine.from:dates.hiredOn,terminated=mine&&mine.to<end?dates.terminatedOn&&dates.terminatedOn<mine.to?dates.terminatedOn:mine.to:dates.terminatedOn;
 const policy=await resolveAssignedPolicy(tx,context.employmentId),cfg=policy?.config??null,[companyCfg]=await tx.select().from(companyPayrollConfig).where(eq(companyPayrollConfig.companyId,context.companyId));
 const settings=resolveProrationSettings(cfg,{isHire:dates.hiredOn>start,isResign:!!dates.terminatedOn&&dates.terminatedOn<end}),divisorDays=prorationDivisorDays(settings,dim),window=cutOffWindowFor('salary',cfg,companyCfg??null,context.period),workingDayBasis=usesWorkingDayProration(settings)?{roster:workingDayRoster(settings),holidays:settings?.includeHoliday?new Set<string>():await holidayDatesFor(tx,{employmentId:context.employmentId,startDate:start,endDate:end})}:undefined;
 const ratio=payrollProrationRatio(context.period,hired,terminated,{divisorDays:divisorDays===dim?undefined:divisorDays,workingDayBasis,window}),factor=divideFormulaDecimal(String(ratio.numerator),String(ratio.denominator)),legacyFactor=ratio.numerator/ratio.denominator;
 const hours=(await readPayrollAttendanceHoursTx(tx,{employmentIds:[context.employmentId],periodStart:start,periodEnd:end})).get(context.employmentId)??0;
 const {recurring,batch:batchRows}=await readPayrollComponentInputsTx(tx,{employmentIds:[context.employmentId],periodStart:start,periodEnd:end,batchId:batch?.id});
 const components:ResolvablePayComponent[]=[...recurring,...batchRows].map(r=>({...r,formulaInput:r.amount,amount:Number(r.amount)}));
 const ledger=settingEnabled(ctx,'payroll.individual_txn_pay_enabled')?await readPayrollIndividualLedgerTx(tx,{employmentIds:[context.employmentId],batchId:batch?.id,unattached:{companyId:context.companyId,payPeriod:context.period,payrollCycleId:batch?batch.payrollCycleId:context.cycleId,runType:batch?.runType??cycle.runType}}):[];
 for(const row of ledger)if(['earning','deduction'].includes(row.kind)&&row.compCode){const builder=row.compRule?.kind==='formula_builder';components.push({code:row.compCode,kind:row.compKind,amount:payrollRoundAmount(Number(row.amount)),formulaInput:row.amount,rule:builder?row.compRule:null,prorates:row.compProrates??false,prorateOverride:null,rounding:row.compRounding,oneOff:true,orpOvertime:false,orpUnpaidLeave:false,nonPayable:row.compNonPayable??false,resolutionOrder:builder?row.compResolutionOrder:0});}
 let paidBasic=payrollRateBasic(Number(salary.basic),legacyFactor),basicEvidence:unknown={salary,salaryDate};
 if(salary.payMode==='daily'){if(salary.rateAmount===null)throw unavailable('daily rate');const holidays=await holidayDatesFor(tx,{employmentId:context.employmentId,startDate:start,endDate:end}),days=eligibleWorkingDays(context.period,hired,terminated,holidays);paidBasic=payrollRateBasic(Number(salary.rateAmount),days);basicEvidence={salary,salaryDate,days,holidays:[...holidays].sort()};}
 else if(salary.payMode==='hourly'){if(salary.rateAmount===null)throw unavailable('hourly rate');paidBasic=payrollRateBasic(Number(salary.rateAmount),hours);basicEvidence={salary,salaryDate,hours};}
 else if(salary.payMode==='custom_period')throw unavailable('custom period pay');
 else if(cfg?.salaryIncrementProration){const rows=await tx.execute<{id:string;basic:string;validFrom:string;validTo:string|null}>(sql`select id,basic_salary as basic,valid_from::text as "validFrom",valid_to::text as "validTo" from compensation where employment_id=${context.employmentId}::uuid and valid_from<=${end}::date and (valid_to is null or valid_to>=${start}::date) and superseded_at is null order by valid_from,id`),increment=payrollIncrementBasic(rows.map(r=>({...r,basic:Number(r.basic)})),start,end,dim);if(increment!==undefined){paidBasic=increment;basicEvidence={rows,salaryDate};}}
 const selectedCatalog=await tx.execute<ResolvablePayComponent>(sql`select code,kind,rule,prorates,rounding_method as rounding,resolution_order as "resolutionOrder" from pay_component where upper(trim(code))=${itemKey(context.currentCode)} and tenant_id=${ctx.tenantId}::uuid and archived_at is null`);if(selectedCatalog.length!==1||itemKey(selectedCatalog[0].code)==='BASIC')throw unavailable('selected Pay Item');const catalog=selectedCatalog[0];
 if(Number(context.input)<0||Number(context.input)>1e8)throw unavailable('current input amount');
 const selected={...catalog,amount:Number(context.input),formulaInput:normalizeFormulaDecimal(context.input),rule:{kind:'formula_builder' as const,formulaId:formula.formulaId,dependencies:formula.dependencies},resolutionOrder:100000};
 // Resolve only the selected output closure; unrelated inactive formulas cannot poison a test.
 const candidates=[...components.filter(c=>itemKey(c.code)!==itemKey(context.currentCode)),selected],needed=new Set(formula.dependencies),queue=[...needed];
 for(let i=0;i<queue.length;i++){if(i>1000)throw unavailable('dependency size');for(const component of candidates.filter(c=>itemKey(c.code)===itemKey(queue[i]))){const dependencies=payRuleDependencies(component.rule);if(payRuleReadsFixedAllowanceTotal(component.rule))for(const c of candidates)if(itemKey(c.code)!==itemKey(component.code)&&payItemFeedsOvertimeOrp(c.code,c.kind,c.rule,c.orpOvertime)&&!c.nonPayable&&!c.oneOff)dependencies.push(c.code);for(const code of dependencies)if(!needed.has(code)){needed.add(code);queue.push(code);}}}
 const all=candidates.filter(c=>c===selected||needed.has(itemKey(c.code))),scope:PayRuleScope={basic:Number(salary.basic),proratedBasic:payrollRateBasic(Number(salary.basic),legacyFactor),calendarDays:dim,daysWorked:legacyFactor*dim,hours,components:{BASIC:Number(salary.basic)}};
 const prepared=await preparePayFormulaRuntimeTx(tx,ctx,context,{components:all,inputComponents:components,scope,basic:salary.basic,proratedBasic:String(paidBasic),factor,legacyFactor,batchId:batch?.id,sourceEvidence:{basic:basicEvidence,policy:cfg,companyCfg,window,ratio,hours,recurring,batch:batchRows,ledger,run:batch??{payrollCycleId:context.cycleId,runType:cycle.runType}}},formula);scope.formulaBuilder=prepared.runtime;
 try{resolvePayComponentSet(all,scope);const result=prepared.evaluations.find(e=>itemKey(e.componentCode)===itemKey(context.currentCode));if(!result)throw unavailable('result');return {passed:true,amount:result.amount,error:null,explanations:result.explanations,sourceFingerprint:prepared.sourceFingerprint(),readRequirements:prepared.readRequirements()};}
 catch(e){if(e instanceof FormulaLanguageError&&e.code==='source_denied')throw new PayFormulaError('Formula source permission is unavailable.','FORMULA_SOURCE_DENIED');if(e instanceof PayFormulaError&&e.code==='FORMULA_SOURCE_DENIED')throw e;return {passed:false,amount:null,error:e instanceof PayFormulaError||e instanceof FormulaLanguageError?e.message:'The formula could not calculate from the selected inputs.',explanations:[],sourceFingerprint:prepared.sourceFingerprint(),readRequirements:prepared.readRequirements()};}
}
