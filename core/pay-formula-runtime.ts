/** Authorized source adapter shared by simulation and the native payroll kernel. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {Tx,SessionContext} from '../db/client';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {isCalendarDate} from '../lib/calendar-date';
import {serviceYearsAt} from '../lib/completed-years';
import {evaluatePayFormula,analyzePayFormula,normalizeFormulaDecimal,addFormulaDecimal,applyFormulaAmount,divideFormulaDecimal,type FormulaRequest,type FormulaValue} from '../lib/pay-formula-language';
import {PayFormulaError,type ActiveFormula,type PayFormulaContext,type FormulaReadRequirements} from '../lib/pay-formula-model';
import {resolvePayrollPermission,loadActiveFormulaProgramTx,loadFormulaAccumulationGroupsTx,recordFormulaEvaluationTx,resolvePayComponentSet,resolveAssignedPolicy,resolveProrationSettings,prorationDivisorDays,usesWorkingDayProration,workingDayRoster,cutOffWindowFor,type PayRuleScope,type PayRuleFormulaRuntime,type ResolvablePayComponent} from '../packs/payroll/service';
import {assertWorkforceCompanyTx,assertWorkforceEmploymentTx} from './workforce-access';
import {companyOnDate} from './employment-company';
import {employmentInformationAt} from './information-correction-history';
import {employment,companyPayrollConfig} from '../db/schema';
import {eq} from 'drizzle-orm';
import {holidayDatesFor} from './holidays';
import {payrollProrationRatio} from '../lib/payroll-proration';

const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const fingerprint=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const decimal=(v:string):FormulaValue=>({type:'decimal',value:normalizeFormulaDecimal(v)});
const unavailable=(name:string)=>new PayFormulaError('Formula source is unavailable or ambiguous: '+name,'FORMULA_SOURCE_UNAVAILABLE');
const category=(s:string):FormulaReadRequirements['categories'][number]=>s==='payroll'?'compensation':s==='restricted'||s==='documents'?'confidential_hr':s==='identity'||s==='bank'||s==='statutory'?s:'personnel';
const requirements=(fields:string[]):FormulaReadRequirements=>({fieldIds:[...new Set(fields)].sort(),categories:[...new Set(fields.map(id=>{const f=PERSONNEL_FIELDS.find(f=>f.id===id);if(!f)throw unavailable(id);return category(f.sensitivity);}))].sort()});
export async function formulaReadRequirementsAllowedTx(tx:Tx,ctx:SessionContext,companyId:string,employmentId:string,r:FormulaReadRequirements){
 try{await assertWorkforceCompanyTx(tx,ctx,companyId,'view');await assertWorkforceEmploymentTx(tx,ctx,employmentId,'view');}catch{return false;}
 if(r.fieldIds.some(id=>!PERSONNEL_FIELDS.some(f=>f.id===id)))return false;
 const needed=new Set([...r.categories,...requirements(r.fieldIds).categories]);
 for(const c of needed)if(!await resolvePayrollPermission(tx,ctx,`report.read.${c}`,companyId))return false;
 return true;
}
const profileFields:Record<string,string>={joinDate:'employment.employment_dates_and_service.joindate',groupJoinDate:'employment.employment_dates_and_service.hiredon',resignationDate:'employment.employment_dates_and_service.resignationdate',confirmationDate:'employment.employment_dates_and_service.confirmationdate',lastWorkingDate:'employment.employment_dates_and_service.lastworkingdate',employmentType:'employment.organisation_assignment.employmenttype',employeeNo:'profile.personal_details.employeecode',departmentCode:'employment.organisation_assignment.departmentname',positionCode:'employment.organisation_assignment.positionname',gradeCode:'employment.organisation_assignment.gradename'};
const employeeFields:Record<string,string>={dateOfBirth:'profile.personal_details.dateofbirth',gender:'profile.personal_details.gender',nationality:'profile.personal_details.nationality',maritalStatus:'profile.personal_details.maritalstatus'};
const basicField='payroll.basic_salary_and_salary_history.basicsalary',payModeField='payroll.basic_salary_and_salary_history.paymode';
function sourceFields(request:FormulaRequest):string[]{
 const code=request.code,a=String(request.args[0]?.value??'');
 if(code==='Basic')return [basicField];if(code==='Payrate')return [payModeField];
 if(code==='EmployeeProfile')return [profileFields[a]];if(code==='EmployeeInformation')return [employeeFields[a]];
 if(['JoinDate','JoinedThisMonth'].includes(code))return [profileFields.joinDate];
 if(['GroupJoinDate','GroupJoinedThisMonth'].includes(code))return [profileFields.groupJoinDate];
 if(['ResignationDate','ResignedThisMonth'].includes(code))return [profileFields.resignationDate];
 if(code==='ServiceLength')return [profileFields[String(request.args[1]?.value)==='joinDate'?'joinDate':'groupJoinDate']];
 if(['PayItem','PayItemNoProrate','PayItemInput','Accumulation','AnotherPayItems'].includes(code))return [basicField];return [];
}
type CatalogRow={id:string;code:string;kind:string;rule:ResolvablePayComponent['rule'];prorates:boolean;rounding:string;resolutionOrder:number;context:{ordinaryRate?:string;hoursPerDay?:string;rate?:string}|null};
export type FormulaRuntimeSnapshot={components:readonly ResolvablePayComponent[];scope:PayRuleScope;basic:string;proratedBasic:string;factor:string;batchId?:string};
type Evaluation={formula:ActiveFormula;componentCode:string;amount:string;explanations:string[];reads:unknown;sources:unknown;readRequirements:FormulaReadRequirements};

/** Scope is checked before every source read. Denied or absent branch sources remain errors,
 * not zeros; evaluating a branch that never reads that source remains possible. */
export async function preparePayFormulaRuntimeTx(tx:Tx,ctx:SessionContext,context:PayFormulaContext,snapshot:FormulaRuntimeSnapshot,override?:ActiveFormula){
 if(!uuid.test(context.companyId)||!uuid.test(context.employmentId)||!uuid.test(context.cycleId)||!/^\d{4}-\d{2}$/.test(context.period)||!isCalendarDate(context.asOf))throw unavailable('test context');
 await assertWorkforceCompanyTx(tx,ctx,context.companyId,'view');await assertWorkforceEmploymentTx(tx,ctx,context.employmentId,'view');
 if(await companyOnDate(tx,context.employmentId,context.asOf)!==context.companyId)throw unavailable('employee company at selected date');
 const cycles=await tx.execute<{id:string}>(sql`select id from payroll_cycle where id=${context.cycleId}::uuid and company_id=${context.companyId}::uuid and tenant_id=${ctx.tenantId}::uuid`);if(cycles.length!==1)throw unavailable('payroll cycle');
 const catalog=await tx.execute<CatalogRow>(sql`select id,code,kind,rule,prorates,rounding_method as rounding,resolution_order as "resolutionOrder",formula_context as context from pay_component where tenant_id=${ctx.tenantId}::uuid and archived_at is null order by code`);
 const active=new Map<string,ActiveFormula>();if(override)active.set(override.formulaId,override);
 for(const c of snapshot.components)if(c.rule?.kind==='formula_builder'&&!active.has(c.rule.formulaId))active.set(c.rule.formulaId,await loadActiveFormulaProgramTx(tx,ctx,c.rule.formulaId,context.companyId));
 for(const c of snapshot.components)if(c.rule?.kind==='formula_builder'&&!(override&&c.code===context.currentCode)&&JSON.stringify([...c.rule.dependencies].sort())!==JSON.stringify([...(active.get(c.rule.formulaId)?.dependencies??[])].sort()))throw unavailable('Pay Item dependency plan');
 const calls=[...active.values()].flatMap(f=>analyzePayFormula(f.program).calls);
 const allowed=new Map<string,boolean>(),values=new Map<string,unknown>(),sources:unknown[]=[];
 for(const call of calls){for(const id of sourceFields(call)){if(allowed.has(id))continue;allowed.set(id,await formulaReadRequirementsAllowedTx(tx,ctx,context.companyId,context.employmentId,requirements([id])));}}
 const hiredOn=employmentInformationAt('hiredOn',sql`${context.asOf}::date`,sql`${employment.hiredOn}`),joinDate=employmentInformationAt('joinDate',sql`${context.asOf}::date`,sql`${employment.joinDate}`);
 // Only fetch source categories the actor can read. Exact named columns avoid accidental widening.
 const employmentNeeded=[...allowed].some(([id,yes])=>yes&&Object.values(profileFields).includes(id));
 if(employmentNeeded){const rows=await tx.execute<Record<string,unknown>>(sql`select ${hiredOn}::text as "groupJoinDate",${joinDate}::text as "joinDate",resignation_date::text as "resignationDate",confirmation_date::text as "confirmationDate",last_working_date::text as "lastWorkingDate",employee_code as "employeeNo" from employment where id=${context.employmentId}::uuid`);for(const [k,v]of Object.entries(rows[0]??{}))if(allowed.get(profileFields[k]))values.set(profileFields[k],v);sources.push({owner:'employment-information',asOf:context.asOf,values:[...values]});
 const assignments=await tx.execute<Record<string,unknown>>(sql`select a.id,a.employment_type as "employmentType",d.name as "departmentCode",p.title as "positionCode" from assignment a left join department d on d.id=a.department_id left join position p on p.id=a.position_id where a.employment_id=${context.employmentId}::uuid and a.company_id=${context.companyId}::uuid and a.valid_from<=${context.asOf}::date and (a.valid_to is null or a.valid_to>${context.asOf}::date) and a.superseded_at is null`);if(assignments.length===1)for(const [k,v]of Object.entries(assignments[0]))if(allowed.get(profileFields[k]))values.set(profileFields[k],v);
 if(allowed.get(profileFields.gradeCode)){const rows=await tx.execute<{value:string}>(sql`select g.name as value from employment e join job_grade g on g.id=e.grade_id where e.id=${context.employmentId}::uuid`);values.set(profileFields.gradeCode,rows[0]?.value);}
 }
 for(const [key,id]of Object.entries(employeeFields))if(allowed.get(id)){
 const column={dateOfBirth:'date_of_birth',gender:'gender',nationality:'nationality',maritalStatus:'marital_status'}[key]!;
 const rows=await tx.execute<{value:unknown}>(sql`select ${sql.identifier(column)} as value from person where id=(select person_id from employment where id=${context.employmentId}::uuid)`);values.set(id,rows[0]?.value);sources.push({owner:'person-current',field:id,value:rows[0]?.value});
 }
 if(allowed.get(basicField))values.set(basicField,snapshot.basic);
 if(allowed.get(payModeField)){const rows=await tx.execute<{id:string;value:string}>(sql`select id,pay_mode as value from compensation where employment_id=${context.employmentId}::uuid and valid_from<=${context.asOf}::date and (valid_to is null or valid_to>${context.asOf}::date) and superseded_at is null`);if(rows.length===1){values.set(payModeField,rows[0].value);sources.push({owner:'compensation',...rows[0]});}}
 const groups=await loadFormulaAccumulationGroupsTx(tx,ctx),history=new Map<string,FormulaValue|Error>();
 for(const call of calls.filter(c=>c.code==='AnotherPayItems')){
 const args=call.args.map(a=>String(a.value)),key=JSON.stringify(args);if(history.has(key))continue;
 if(!allowed.get(basicField)){history.set(key,new PayFormulaError('Formula source permission is unavailable.','FORMULA_SOURCE_DENIED'));continue;}
 const [code,period,cycle,result]=args;if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)||period>context.period||!result||(!uuid.test(result)&&!/^\d+$/.test(result))){history.set(key,unavailable('historical result'));continue;}
 const rows=await tx.execute<{id:string;version:number;statutory:Record<string,unknown>;basic:string;batchId:string}>(sql`select s.id,s.version,s.statutory,s.basic_salary as basic,b.id as "batchId" from payslip s join payroll_batch b on b.id=s.batch_id join payroll_cycle c on c.id=b.cycle_id where s.employment_id=${context.employmentId}::uuid and b.company_id=${context.companyId}::uuid and b.pay_period=${period} and (c.id::text=${cycle} or c.code=${cycle}) and (${uuid.test(result)?sql`s.id=${result}::uuid`:sql`b.run_seq=${Number(result)}`}) and ${snapshot.batchId?sql`b.id<>${snapshot.batchId}::uuid`:sql`true`}`);
 if(rows.length!==1){history.set(key,unavailable('historical result'));continue;}const row=rows[0],lines=[...(Array.isArray(row.statutory.componentLines)?row.statutory.componentLines:[]),...(Array.isArray(row.statutory.importedLines)?row.statutory.importedLines:[])].filter((l):l is {code:string;amount:string|number}=>!!l&&typeof l==='object'&&'code'in l&&String(l.code).toUpperCase()===code.toUpperCase()&&'amount'in l);
 try{const value=code.toUpperCase()==='BASIC'?normalizeFormulaDecimal(row.basic):lines.length?lines.reduce((sum,l)=>addFormulaDecimal(sum,String(l.amount)),'0'):(()=>{throw unavailable(code);})();history.set(key,decimal(value));sources.push({owner:'payroll-history',payslipId:row.id,version:row.version,batchId:row.batchId,code,value});}catch{history.set(key,unavailable(code));}
 }
 const raw=new Map<string,string>(),unprorated=new Map<string,string>([['BASIC',snapshot.basic]]),prorated=new Map<string,string>([['BASIC',snapshot.proratedBasic]]),applied=new Map<ResolvablePayComponent,string>(),exact=new Map<ResolvablePayComponent,string>(),evaluations:Evaluation[]=[];
 for(const c of snapshot.components)if(c.formulaInput!==undefined)raw.set(c.code,addFormulaDecimal(raw.get(c.code)??'0',c.formulaInput));
 const usedFields=new Set<string>(),read=(id:string)=>{if(!allowed.get(id))throw new PayFormulaError('Formula source permission is unavailable.','FORMULA_SOURCE_DENIED');usedFields.add(id);const v=values.get(id);if(v===null||v===undefined||v==='')throw unavailable(id);return String(v);};
 const fieldValue=(id:string,type:'date'|'string'):FormulaValue=>({type,value:read(id)});
 const fromMap=(m:Map<string,string>,name:string)=>{if(!allowed.get(basicField))throw new PayFormulaError('Formula source permission is unavailable.','FORMULA_SOURCE_DENIED');usedFields.add(basicField);const v=m.get(name.toUpperCase());if(v===undefined)throw unavailable(name);return decimal(v);};
 const runtime:PayRuleFormulaRuntime={
 resolve(rule,component){const formula=active.get(rule.formulaId);if(!formula)throw unavailable(rule.formulaId);const config=catalog.find(c=>c.code===component.code);if(!config)throw unavailable(component.code);
 const result=evaluatePayFormula(formula.program,{resolve(request){const args=request.args.map(a=>String(a.value)),code=request.code;for(const id of sourceFields(request))if(!allowed.get(id))throw new PayFormulaError('Formula source permission is unavailable.','FORMULA_SOURCE_DENIED');
 switch(code){
 case 'Basic':return decimal(read(basicField));
 case 'Payrate':return {type:'string',value:read(payModeField)};
 case 'Input':if(component.formulaInput===undefined)throw unavailable('current input');return decimal(component.formulaInput);
 case 'InputType':return {type:'string',value:config.rule?.kind??'fixed'};
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
 }});const amount=result.amount;exact.set(component,amount);if(Number(amount)<0||Number(amount)>1e8)throw unavailable('result outside Pay Item amount limits');const paid=applyFormulaAmount(result.amount,{factor:(component.prorateOverride??component.prorates)?snapshot.factor:undefined,rounding:component.rounding as 'none'|'up'|'down'|'nearest'});applied.set(component,paid);
 evaluations.push({formula,componentCode:component.code,amount:paid,explanations:result.explanations,reads:result.reads,sources:{context,catalog:config,sourceEvidence:sources,raw:[...raw],unprorated:[...unprorated],prorated:[...prorated],factor:snapshot.factor},readRequirements:requirements([...usedFields])});return amount;
 },
 publish(code,components){if(code==='BASIC')return;let before='0',after='0';for(const row of components){const value=applied.get(row.component);before=addFormulaDecimal(before,exact.get(row.component)??String(row.amount));after=addFormulaDecimal(after,value??applyFormulaAmount(String(row.amount),{factor:(row.component.prorateOverride??row.component.prorates)?snapshot.factor:undefined,rounding:row.component.rounding as 'none'|'up'|'down'|'nearest'}));}unprorated.set(code,before);prorated.set(code,after);}
 };
 return {runtime,applied,evaluations,sourceFingerprint:()=>fingerprint({context,catalog,groups,sources,raw:[...raw],basic:snapshot.basic,proratedBasic:snapshot.proratedBasic,factor:snapshot.factor}),readRequirements:()=>requirements([...usedFields]),async record(){const refs=[];for(const e of evaluations){if(!snapshot.batchId)throw unavailable('payroll batch');const evaluationId=await recordFormulaEvaluationTx(tx,ctx,{...e,companyId:context.companyId,employmentId:context.employmentId,batchId:snapshot.batchId,period:context.period});refs.push({formulaId:e.formula.formulaId,revisionId:e.formula.revisionId,contentHash:e.formula.contentHash,evaluationId,componentCode:e.componentCode,amount:e.amount});}return refs;}};
}

export async function simulatePayFormulaTx(tx:Tx,ctx:SessionContext,formula:ActiveFormula,context:PayFormulaContext){
 // Native source owners, not caller-supplied substitutes. The only sample is current input.
 await assertWorkforceCompanyTx(tx,ctx,context.companyId,'view');await assertWorkforceEmploymentTx(tx,ctx,context.employmentId,'view');
 if(!isCalendarDate(context.asOf)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(context.period))throw unavailable('test date');
 const start=context.period+'-01',dim=new Date(Date.UTC(Number(context.period.slice(0,4)),Number(context.period.slice(5)),0)).getUTCDate(),end=context.period+'-'+String(dim).padStart(2,'0');
 const [salary]=await tx.execute<{id:string;basic:string;payMode:string}>(sql`select id,basic_salary as basic,pay_mode as "payMode" from compensation where employment_id=${context.employmentId}::uuid and valid_from<=${context.asOf}::date and (valid_to is null or valid_to>${context.asOf}::date) and superseded_at is null`);if(!salary)throw unavailable('effective compensation');
 const [dates]=await tx.execute<{hiredOn:string;terminatedOn:string|null}>(sql`select ${employmentInformationAt('hiredOn',sql`${context.asOf}::date`,sql`${employment.hiredOn}`)}::text as "hiredOn",terminated_on::text as "terminatedOn" from employment where id=${context.employmentId}::uuid`);if(!dates)throw unavailable('employment dates');
 const policy=await resolveAssignedPolicy(tx,context.employmentId),cfg=policy?.config??null,[companyCfg]=await tx.select().from(companyPayrollConfig).where(eq(companyPayrollConfig.companyId,context.companyId));
 const settings=resolveProrationSettings(cfg,{isHire:dates.hiredOn>start,isResign:!!dates.terminatedOn&&dates.terminatedOn<end}),divisorDays=prorationDivisorDays(settings,dim),window=cutOffWindowFor('salary',cfg,companyCfg??null,context.period),workingDayBasis=usesWorkingDayProration(settings)?{roster:workingDayRoster(settings),holidays:settings?.includeHoliday?new Set<string>():await holidayDatesFor(tx,{employmentId:context.employmentId,startDate:start,endDate:end})}:undefined;
 const ratio=payrollProrationRatio(context.period,dates.hiredOn,dates.terminatedOn,{divisorDays:divisorDays===dim?undefined:divisorDays,workingDayBasis,window}),factor=divideFormulaDecimal(String(ratio.numerator),String(ratio.denominator));
 const components=await tx.execute<ResolvablePayComponent>(sql`select c.code,c.kind,c.rule,c.prorates,c.rounding_method as rounding,c.resolution_order as "resolutionOrder",e.prorate_override as "prorateOverride",e.amount::text as "formulaInput",e.amount::float as amount from employment_pay_component e join pay_component c on c.id=e.component_id where e.employment_id=${context.employmentId}::uuid and e.valid_from<=${end}::date and (e.valid_to is null or e.valid_to>=${start}::date) and e.superseded_at is null and c.archived_at is null`);
 const [catalog]=await tx.execute<ResolvablePayComponent>(sql`select code,kind,rule,prorates,rounding_method as rounding,resolution_order as "resolutionOrder" from pay_component where code=${context.currentCode} and tenant_id=${ctx.tenantId}::uuid and archived_at is null`);if(!catalog)throw unavailable('selected Pay Item');
 const selected={...catalog,amount:Number(context.input),formulaInput:normalizeFormulaDecimal(context.input),rule:{kind:'formula_builder' as const,formulaId:formula.formulaId,dependencies:formula.dependencies},resolutionOrder:100000};
 const all=[...components.filter(c=>c.code!==context.currentCode),selected],scope:PayRuleScope={basic:Number(salary.basic),proratedBasic:Number(applyFormulaAmount(salary.basic,{factor})),calendarDays:dim,daysWorked:Number(factor)*dim,hours:0,components:{BASIC:Number(salary.basic)}};
 const prepared=await preparePayFormulaRuntimeTx(tx,ctx,context,{components:all,scope,basic:salary.basic,proratedBasic:String(scope.proratedBasic),factor},formula);scope.formulaBuilder=prepared.runtime;
 try{resolvePayComponentSet(all,scope);const result=prepared.evaluations.find(e=>e.componentCode===context.currentCode);if(!result)throw unavailable('result');return {passed:true,amount:result.amount,error:null,explanations:result.explanations,sourceFingerprint:prepared.sourceFingerprint(),readRequirements:prepared.readRequirements()};}
 catch(e){if(e instanceof PayFormulaError&&e.code==='FORMULA_SOURCE_DENIED')throw e;return {passed:false,amount:null,error:e instanceof PayFormulaError?e.message:'The formula could not calculate from the selected inputs.',explanations:[],sourceFingerprint:prepared.sourceFingerprint(),readRequirements:prepared.readRequirements()};}
}
