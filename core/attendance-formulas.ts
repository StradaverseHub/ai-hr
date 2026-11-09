/** Company-scoped immutable Attendance formula versions and actual-data testing. No pay posting. */
import {createHash,randomUUID} from 'node:crypto';
import {and,asc,desc,eq,gte,lte,ilike,inArray,isNull,or,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {attendanceFormula,attendanceFormulaRevision,attendanceFormulaTest,attendanceFormulaEvent,attendanceFormulaResult,attendanceFormulaResultEvent,payComponent,company,employment,person} from '../db/schema';
import {employedByCompanyDuring,provenCompanyDatesTx} from './employment-company';
import {withAttendanceTenant} from './module-gate';
import {assertWorkforceEmploymentTx} from './workforce-access';
import {appendEvent,actorOf} from '../db/events';
import {readAttendanceFormulaDaysTx} from '../packs/attendance/service';
import {attendanceFormulaCompanyIds,validateAttendanceFormulaConfiguration,type AttendanceFormulaConfiguration} from '../lib/attendance-formula-model';
import {compileAttendanceFormulaLibrary,evaluateAttendanceFormula} from '../lib/attendance-formula-language';
import {attendanceFormulaPeriod} from '../lib/attendance-formula-periods';
import {allowanceEmployeeExpressionMatches,allowanceEmployeeLeaves} from '../lib/allowance-employee-expression';
import {assertPayComponentReady} from '../lib/pay-component-contract';
import {ATTENDANCE_FORMULA_CATALOG_VERSION} from '../lib/attendance-formula-catalog';
import {PAY_FORMULA_EVALUATOR_VERSION} from '../lib/pay-formula-language';
import {payComponentAppliesToCompany} from '../lib/pay-component-company';
import {priceAttendanceFormulaQuantity} from '../packs/payroll/service';
import {pgSqlState} from '../lib/db-error';
import {isCalendarDate} from '../lib/calendar-date';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_key,entry)=>entry&&typeof entry==='object'&&!Array.isArray(entry)?Object.fromEntries(Object.entries(entry).sort(([a],[b])=>a.localeCompare(b))):entry)).digest('hex');
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function actor(ctx:SessionContext){if(!ctx.userId||!uuid.test(ctx.userId))throw Error('Use an authenticated administrator to maintain Attendance formulas.');return ctx.userId;}
async function scope(tx:Tx,companyId:string){if(!uuid.test(companyId))throw Error('Choose a formula company.');const [allowed]=await tx.execute<{ok:boolean}>(sql`select app.attendance_policy_principal_current() and app.is_admin_for(c.id) as ok from public.company c where c.id=${companyId}::uuid and c.tenant_id=app.current_tenant_id()`);if(!allowed?.ok)throw Error('Company administration access is required.');}
export async function assertAttendanceFormulaAuthorTx(tx:Tx,ctx:SessionContext,companyId:string){actor(ctx);await scope(tx,companyId);}
async function lock(tx:Tx,ctx:SessionContext,id:string){if(!uuid.test(id))throw Error('Formula is unavailable.');await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId.toLowerCase()+':attendance-formula:'+id.toLowerCase()},0))`);}
async function identity(tx:Tx,id:string){if(!uuid.test(id))throw Error('Formula is unavailable.');const [formula]=await tx.select().from(attendanceFormula).where(eq(attendanceFormula.id,id));if(!formula)throw Error('Formula or company scope is unavailable.');return formula;}
async function events(tx:Tx,id:string){return tx.select().from(attendanceFormulaEvent).where(eq(attendanceFormulaEvent.formulaId,id)).orderBy(desc(attendanceFormulaEvent.sequence)).limit(100);}
async function latest(tx:Tx,id:string){const [revision]=await tx.select().from(attendanceFormulaRevision).where(eq(attendanceFormulaRevision.formulaId,id)).orderBy(desc(attendanceFormulaRevision.ordinal)).limit(1);if(!revision)throw Error('Save a formula version first.');return revision;}
async function lifecycle(tx:Tx,id:string){const history=await events(tx,id);const [state]=await tx.select().from(attendanceFormulaEvent).where(and(eq(attendanceFormulaEvent.formulaId,id),inArray(attendanceFormulaEvent.kind,['activated','deactivated','archived']))).orderBy(desc(attendanceFormulaEvent.sequence)).limit(1);return {history,state};}
async function writable(tx:Tx,id:string){const current=await lifecycle(tx,id);if(current.state?.kind==='archived')throw Error('An archived formula retains its history and cannot change.');return current;}
async function item(tx:Tx,configuration:AttendanceFormulaConfiguration){const [component]=await tx.select().from(payComponent).where(eq(payComponent.id,configuration.payItemId));if(!component||component.archivedAt||component.isNonPayable||!['allowance','deduction'].includes(component.kind)||!attendanceFormulaCompanyIds(configuration).every(id=>payComponentAppliesToCompany(component,id)))throw Error('Choose an active Pay Item available in every selected company.');assertPayComponentReady(component);if((component.kind==='deduction')!==(configuration.purpose==='deduction'))throw Error('The Pay Item must match the earning or deduction purpose.');return component;}
type FormulaIdentity=Pick<typeof attendanceFormula.$inferSelect,'id'|'companyId'|'code'>;
async function event(tx:Tx,ctx:SessionContext,formula:FormulaIdentity,kind:typeof attendanceFormulaEvent.$inferInsert.kind,p:{revisionId?:string;testId?:string;detail?:Record<string,unknown>}={}){await tx.insert(attendanceFormulaEvent).values({tenantId:ctx.tenantId,companyId:formula.companyId,formulaId:formula.id,createdBy:actor(ctx),kind,...p});await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-formula',aggregateId:formula.id,eventType:'attendance-formula.'+kind,actor:actorOf(ctx),payload:{companyId:formula.companyId,revisionId:p.revisionId??null,testId:p.testId??null}});}
export function saveAttendanceFormula(ctx:SessionContext,input:{id?:string;expectedRevisionId?:string;configuration:unknown}){
 const configuration=validateAttendanceFormulaConfiguration(input.configuration);
 return withAttendanceTenant(ctx,async tx=>{
  const userId=actor(ctx);await scope(tx,configuration.companyId);
  const companyIds=attendanceFormulaCompanyIds(configuration);
  if(configuration.companyScope&&configuration.eligibility.mode==='selected'){
   const date=configuration.effectiveFrom;
   const proofs=await provenCompanyDatesTx(tx,configuration.eligibility.employmentIds.map(employmentId=>({employmentId,date})));
   if([...proofs.values()].some(proof=>proof.reason||!proof.companyId||!companyIds.includes(proof.companyId)))
    throw Error('Every selected employee must belong to a formula company on the effective date.');
  }
  const id=input.id??randomUUID();await lock(tx,ctx,id);
  let formula:FormulaIdentity;
  if(input.id){formula=await identity(tx,id);if(formula.companyId!==configuration.companyId||formula.code!==configuration.code)throw Error('Keep the saved company and Formula ID; create another formula for a new identity.');await writable(tx,id);if((await latest(tx,id)).id!==input.expectedRevisionId)throw Error('The formula changed. Reopen its current version before saving.');}
  else {
   formula={id,companyId:configuration.companyId,code:configuration.code};
   // The owner can validate the creation event, but application reads start with the first revision.
   await tx.insert(attendanceFormula).values({...formula,tenantId:ctx.tenantId,createdBy:userId});
   await event(tx,ctx,formula,'created');
  }
  const component=await item(tx,configuration),compiled=compileAttendanceFormulaLibrary(configuration.library,configuration.code),requirements={...compiled.requirements,workforce:compiled.requirements.workforce||configuration.eligibility.mode==='criteria'};
  const prior=await tx.select().from(attendanceFormulaRevision).where(eq(attendanceFormulaRevision.formulaId,id)).orderBy(desc(attendanceFormulaRevision.ordinal)).limit(1);
  const contentHash=hash({configuration,requirements,registry:ATTENDANCE_FORMULA_CATALOG_VERSION,evaluator:PAY_FORMULA_EVALUATOR_VERSION});if(prior[0]?.contentHash===contentHash)return {id,revisionId:prior[0].id,ordinal:prior[0].ordinal};
  const [revision]=await tx.insert(attendanceFormulaRevision).values({tenantId:ctx.tenantId,companyId:formula.companyId,formulaId:id,ordinal:(prior[0]?.ordinal??0)+1,payComponentId:component.id,definition:configuration,registryVersion:ATTENDANCE_FORMULA_CATALOG_VERSION,evaluatorVersion:PAY_FORMULA_EVALUATOR_VERSION,contentHash,readRequirements:requirements,createdBy:userId}).returning();await event(tx,ctx,formula,'saved',{revisionId:revision.id});return {id,revisionId:revision.id,ordinal:revision.ordinal};
 });
}
async function evaluate(tx:Tx,ctx:SessionContext,revision:ExecutionRevision,employmentId:string,date:string){
 if(revision.registryVersion!==ATTENDANCE_FORMULA_CATALOG_VERSION||revision.evaluatorVersion!==PAY_FORMULA_EVALUATOR_VERSION)throw Error('The formula engine changed. Save and test a new version.');
 if(!uuid.test(employmentId))throw Error('Choose a test employee.');const configuration=validateAttendanceFormulaConfiguration(revision.definition),component=await item(tx,configuration),period=attendanceFormulaPeriod(date,configuration.period),compiled=compileAttendanceFormulaLibrary(configuration.library,configuration.code);
 // Testing validates a draft against historical evidence; effectiveFrom governs application to pay.
 const {companyId}=await attendanceFormulaCompanyAt(tx,employmentId,period.to);
 if(!attendanceFormulaCompanyIds(configuration).includes(companyId))throw Error('The employee is outside the formula company scope.');
 const source=await readAttendanceFormulaDaysTx(tx,ctx,{companyId,employmentId,from:period.from,to:period.to,fields:compiled.fields,variables:compiled.variables,includeEligibility:configuration.eligibility.mode==='criteria'});
 if(configuration.eligibility.mode==='selected'&&!configuration.eligibility.employmentIds.includes(employmentId))throw Error('Choose an employee included by this formula.');
 if(configuration.eligibility.mode==='criteria'){
  await assertWorkforceEmploymentTx(tx,ctx,employmentId,'view');const criterion=configuration.eligibility.expression,selected=source.eligibilityFacts.at(-1)?.facts;
  if(!selected||allowanceEmployeeLeaves(criterion).some(leaf=>selected[leaf.field]==null))throw Error('The employee eligibility source is incomplete for this period.');if(!allowanceEmployeeExpressionMatches(criterion,selected))throw Error('This employee does not meet the formula eligibility conditions.');
 }
 const result=evaluateAttendanceFormula(configuration.library,configuration.code,source.days);
 if(result.amount.startsWith('-'))throw Error('Return a non-negative quantity or amount; use the deduction purpose for deductions.');
 if(configuration.outputUnit==='minutes'&&!/^\d+$/.test(result.amount))throw Error('A minute result must be a whole number; use an explicit approved rounding rule.');
 priceAttendanceFormulaQuantity(component,{quantity:result.amount,unit:configuration.outputUnit});
 return {companyId,period,result,days:source.days,eligibility:source.eligibilityFacts,sourceHash:hash({configuration:revision.contentHash,source:source.sourceDigest,component,eligibility:source.eligibilityFacts})};
}
export function testAttendanceFormula(ctx:SessionContext,input:{id:string;revisionId:string;employmentId:string;date:string}){return withAttendanceTenant(ctx,async tx=>{
 actor(ctx);await lock(tx,ctx,input.id);const formula=await identity(tx,input.id);await writable(tx,input.id);const revision=await latest(tx,input.id);if(revision.id!==input.revisionId)throw Error('Save and test the current version.');const evaluated=await evaluate(tx,ctx,revision,input.employmentId,input.date);
 const [proof]=await tx.insert(attendanceFormulaTest).values({tenantId:ctx.tenantId,companyId:evaluated.companyId,formulaId:formula.id,revisionId:revision.id,employmentId:input.employmentId,periodFrom:evaluated.period.from,periodTo:evaluated.period.to,passed:true,sourceHash:evaluated.sourceHash,payload:{result:evaluated.result,days:evaluated.days,eligibility:evaluated.eligibility},createdBy:actor(ctx)}).returning();await event(tx,ctx,formula,'tested',{revisionId:revision.id,testId:proof.id});return proof;
});}
export function activateAttendanceFormula(ctx:SessionContext,input:{id:string;revisionId:string;testId:string}){return withAttendanceTenant(ctx,async tx=>{
 actor(ctx);await lock(tx,ctx,input.id);const formula=await identity(tx,input.id);await writable(tx,input.id);const revision=await latest(tx,input.id);if(revision.id!==input.revisionId)throw Error('Activate only the current saved version.');const [proof]=await tx.select().from(attendanceFormulaTest).where(and(eq(attendanceFormulaTest.id,input.testId),eq(attendanceFormulaTest.formulaId,formula.id),eq(attendanceFormulaTest.revisionId,revision.id)));if(!proof?.passed)throw Error('Choose a matching successful actual-attendance test.');const evaluated=await evaluate(tx,ctx,revision,proof.employmentId,proof.periodTo);if(evaluated.companyId!==proof.companyId||evaluated.sourceHash!==proof.sourceHash||hash(evaluated.result)!==hash(proof.payload.result))throw Error('Attendance, eligibility or Pay Item inputs changed. Test this version again.');try{await event(tx,ctx,formula,'activated',{revisionId:revision.id,testId:proof.id});}catch(error){
  if(pgSqlState(error)==='AF001')throw Error('An active formula overlaps this company scope, Formula ID or Pay Item. Review its posting rule or deactivate it first.');
  if(pgSqlState(error)==='AF002')throw Error('Company coverage changed. Save and test an updated version.');
  throw error;
 }return {id:formula.id,revisionId:revision.id};
});}
export function changeAttendanceFormulaStatus(ctx:SessionContext,input:{id:string;command:'deactivate'|'archive';reason:string}){if(!input.reason.trim()||input.reason.length>1000)throw Error('Give a reason of at most 1000 characters.');return withAttendanceTenant(ctx,async tx=>{actor(ctx);await lock(tx,ctx,input.id);const formula=await identity(tx,input.id),current=await lifecycle(tx,input.id);if(current.state?.kind==='archived')return {id:formula.id};await event(tx,ctx,formula,input.command==='archive'?'archived':'deactivated',{revisionId:current.state?.revisionId??undefined,detail:{reason:input.reason.trim()}});return {id:formula.id};});}
export function getAttendanceFormula(ctx:SessionContext,id:string){return withAttendanceTenant(ctx,async tx=>{
 actor(ctx);const formula=await identity(tx,id),current=await latest(tx,id);
 const [versions,history,tests]=await Promise.all([
  tx.select({id:attendanceFormulaRevision.id,ordinal:attendanceFormulaRevision.ordinal,createdAt:attendanceFormulaRevision.createdAt}).from(attendanceFormulaRevision).where(eq(attendanceFormulaRevision.formulaId,id)).orderBy(desc(attendanceFormulaRevision.ordinal)).limit(100),
  lifecycle(tx,id),
  tx.select({id:attendanceFormulaTest.id,revisionId:attendanceFormulaTest.revisionId,employmentId:attendanceFormulaTest.employmentId,periodFrom:attendanceFormulaTest.periodFrom,periodTo:attendanceFormulaTest.periodTo,passed:attendanceFormulaTest.passed,createdAt:attendanceFormulaTest.createdAt}).from(attendanceFormulaTest).where(eq(attendanceFormulaTest.formulaId,id)).orderBy(desc(attendanceFormulaTest.createdAt),desc(attendanceFormulaTest.id)).limit(25),
 ]);
 const activeRevisionId=history.state?.kind==='activated'?history.state.revisionId:null;
 const [active]=activeRevisionId?await tx.select({ordinal:attendanceFormulaRevision.ordinal}).from(attendanceFormulaRevision).where(and(eq(attendanceFormulaRevision.id,activeRevisionId),eq(attendanceFormulaRevision.formulaId,id))).limit(1):[];
 return {formula,latest:current,versions,tests,events:history.history,activeOrdinal:active?.ordinal??null,status:history.state?.kind==='archived'?'archived':history.state?.kind==='activated'?'active':'inactive',activeRevisionId:history.state?.kind==='activated'?history.state.revisionId:null};
});}
export function readAttendanceFormulaTest(ctx:SessionContext,p:{id:string;testId:string}){return withAttendanceTenant(ctx,async tx=>{actor(ctx);await identity(tx,p.id);if(!uuid.test(p.testId))throw Error('Test result is unavailable.');const [proof]=await tx.select().from(attendanceFormulaTest).where(and(eq(attendanceFormulaTest.id,p.testId),eq(attendanceFormulaTest.formulaId,p.id)));if(!proof)throw Error('Test result or permission is unavailable.');return proof;});}
export function attendanceFormulaSetup(ctx:SessionContext,companyIds:string[]){return withAttendanceTenant(ctx,async tx=>{
 actor(ctx);if(companyIds.length>500||companyIds.some(id=>!uuid.test(id)))throw Error('Choose a valid company scope.');if(!companyIds.length)return {companies:[],payItems:[],canSelectAll:false};
 const companies=await tx.select({id:company.id,label:company.legalName,currency:company.currency}).from(company).where(and(inArray(company.id,companyIds),isNull(company.archivedAt),sql`app.attendance_policy_principal_current() and app.is_admin_for(${company.id})`)).orderBy(asc(company.legalName),asc(company.id));
 const items=await tx.select({id:payComponent.id,code:payComponent.code,name:payComponent.name,kind:payComponent.kind,archivedAt:payComponent.archivedAt,pendingInputKind:payComponent.pendingInputKind,isNonPayable:payComponent.isNonPayable,appliedCompanyIds:payComponent.appliedCompanyIds}).from(payComponent).orderBy(asc(payComponent.code),asc(payComponent.id));
 const payItems=items.filter(item=>!item.archivedAt&&!item.pendingInputKind&&!item.isNonPayable&&['allowance','deduction'].includes(item.kind)).flatMap(item=>{const available=companies.filter(company=>payComponentAppliesToCompany(item,company.id)).map(company=>company.id);return available.length?[{id:item.id,code:item.code,name:item.name,kind:item.kind,companyIds:available}]:[];});
 const [coverage]=await tx.execute<{whole:boolean}>(sql`select app.is_group_admin()
  and app.attendance_policy_principal_current()
  and not exists(select 1 from public.company c where c.tenant_id=app.current_tenant_id()
    and c.archived_at is null and not(${JSON.stringify(companies.map(row=>row.id))}::jsonb ? c.id::text)) as whole`);
 return {companies,payItems,canSelectAll:coverage?.whole===true&&companies.length>0};
});}
export function listAttendanceFormulas(ctx:SessionContext,p:{companyIds:string[];query?:string;status?:'active'|'inactive'|'archived'}){return withAttendanceTenant(ctx,async tx=>{
 actor(ctx);if(!p.companyIds.length)return [];if(p.companyIds.length>500||p.companyIds.some(id=>!uuid.test(id))||(p.query?.length??0)>150)throw Error('Choose a valid formula scope and search.');const term='%'+(p.query??'').replace(/[\\%_]/g,'\\$&')+'%';
 return tx.execute<{id:string;code:string;companyId:string;companyName:string;companyMode:'all'|'selected';description:string;method:string;ordinal:number;status:'active'|'inactive'|'archived'}>(sql`
 select f.id,f.code,f.company_id as "companyId",array_to_string(ARRAY(SELECT name.legal_name FROM public.company name WHERE name.tenant_id=f.tenant_id
  AND name.id=ANY(app.attendance_formula_companies(f.company_id,r.definition)) ORDER BY name.legal_name,name.id),', ') as "companyName",
 coalesce(r.definition->'companyScope'->>'mode','selected') as "companyMode",r.definition->>'description' as description,r.definition->'period'->>'method' as method,r.ordinal,
 case when state.kind='archived' then 'archived' when state.kind='activated' then 'active' else 'inactive' end as status
 from attendance_formula f join company c on c.id=f.company_id and c.tenant_id=f.tenant_id
 join lateral(select ordinal,definition from attendance_formula_revision where formula_id=f.id and tenant_id=f.tenant_id order by ordinal desc limit 1)r on true
 left join lateral(select kind from attendance_formula_event where formula_id=f.id and tenant_id=f.tenant_id and kind in('activated','deactivated','archived') order by sequence desc limit 1)state on true
 where app.attendance_formula_companies(f.company_id,r.definition)<@array[${sql.join(p.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]
 and(f.code ilike ${term} or r.definition->>'description' ilike ${term})
 and(${p.status??null}::text is null or case when state.kind='archived' then 'archived' when state.kind='activated' then 'active' else 'inactive' end=${p.status??null})
 order by f.code,f.id limit 501`);
});}

/** Dated, bounded identity choices only. Testing independently proves every day and all source grants. */
export function searchAttendanceFormulaEmployees(ctx:SessionContext,p:{id:string;revisionId:string;date:string;query:string;page:number}){return withAttendanceTenant(ctx,async tx=>{
 actor(ctx);const formula=await identity(tx,p.id),revision=await latest(tx,p.id);await scope(tx,formula.companyId);
 if(revision.id!==p.revisionId)throw Error('Reopen the current saved version before testing.');
 if(typeof p.query!=='string'||p.query.length>150||!Number.isInteger(p.page)||p.page<1||p.page>100000)throw Error('Choose a valid employee search.');
 const configuration=validateAttendanceFormulaConfiguration(revision.definition),period=attendanceFormulaPeriod(p.date,configuration.period),term='%'+p.query.replace(/[\\%_]/g,'\\$&')+'%';
 const rows=await tx.select({id:employment.id,code:employment.employeeCode,name:person.fullName}).from(employment).innerJoin(person,and(eq(person.id,employment.personId),eq(person.tenantId,employment.tenantId))).where(and(or(...attendanceFormulaCompanyIds(configuration).map(id=>employedByCompanyDuring(id,period.from,period.to))),sql`app.can_admin_employment(${employment.id})`,or(ilike(person.fullName,term),ilike(employment.employeeCode,term)),configuration.eligibility.mode==='selected'?inArray(employment.id,configuration.eligibility.employmentIds):undefined)).orderBy(asc(person.fullName),asc(employment.employeeCode),asc(employment.id)).limit(26).offset((p.page-1)*25);
 const page=rows.slice(0,25),proofs=await provenCompanyDatesTx(tx,page.map(row=>({employmentId:row.id,date:period.to})));
 return {rows:page.filter(row=>{const proof=proofs.get(row.id+'|'+period.to);return proof&&!proof.reason&&!!proof.companyId&&attendanceFormulaCompanyIds(configuration).includes(proof.companyId);}),hasMore:rows.length>25,period};
});}

export async function attendanceFormulaResultStateTx(tx:Tx,id:string){const [state]=await tx.select().from(attendanceFormulaResultEvent).where(eq(attendanceFormulaResultEvent.resultId,id)).orderBy(desc(attendanceFormulaResultEvent.sequence)).limit(1);return state;}
export async function appendAttendanceFormulaResultEventTx(tx:Tx,ctx:SessionContext,r:typeof attendanceFormulaResult.$inferSelect,kind:typeof attendanceFormulaResultEvent.$inferInsert.kind,reason:string,batchId?:string){
 if(typeof reason!=='string'||!reason.trim()||reason.length>1000)throw Error('Give a reason of at most1000characters.');
 await tx.insert(attendanceFormulaResultEvent).values({tenantId:ctx.tenantId,companyId:r.companyId,employmentId:r.employmentId,resultId:r.id,kind,reason:reason.trim(),batchId,createdBy:actor(ctx)});
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-formula-result',aggregateId:r.id,eventType:'attendance-formula-result.'+kind,actor:actorOf(ctx),subjectEmploymentId:r.employmentId,payload:{formulaId:r.formulaId,revisionId:r.revisionId,reason:reason.trim(),batchId:batchId??null}});
}
async function attendanceFormulaCompanyAt(tx:Tx,employmentId:string,date:string){
 const proof=(await provenCompanyDatesTx(tx,[{employmentId,date}])).get(employmentId+'|'+date);
 if(!proof?.companyId||proof.reason)throw Error('The dated employee company is unavailable.');
 await scope(tx,proof.companyId);
 return {companyId:proof.companyId};
}

type ExecutionRevision=Pick<typeof attendanceFormulaRevision.$inferSelect,'id'|'formulaId'|'definition'|'contentHash'|'registryVersion'|'evaluatorVersion'|'readRequirements'|'ordinal'>;
async function subjectRevision(tx:Tx,p:{companyId:string;employmentId:string;date:string;formulaId:string;resultId?:string}){
 const [revision]=await tx.execute<ExecutionRevision>(sql`select id,formula_id as "formulaId",definition,content_hash as "contentHash",
   registry_version as "registryVersion",evaluator_version as "evaluatorVersion",read_requirements as "readRequirements",ordinal
   from app.attendance_formula_subject_versions(${p.companyId}::uuid,${p.employmentId}::uuid,${p.date}::date,
    ${p.formulaId}::uuid,${p.resultId??null}::uuid)`);
 return revision;
}
/** Called only with a DB-owned immutable result. Testing evidence cannot become a payable result. */
export async function replayAttendanceFormulaResultTx(tx:Tx,ctx:SessionContext,r:typeof attendanceFormulaResult.$inferSelect){
 const revision=await subjectRevision(tx,{companyId:r.companyId,employmentId:r.employmentId,date:r.periodTo,formulaId:r.formulaId,resultId:r.id});
 if(revision?.id!==r.revisionId)throw Error('The original formula version is unavailable.');const configuration=validateAttendanceFormulaConfiguration(revision.definition);
 const evaluated=await evaluate(tx,ctx,revision,r.employmentId,r.periodTo),component=await item(tx,configuration),price=priceAttendanceFormulaQuantity(component,{quantity:evaluated.result.amount,unit:configuration.outputUnit});
 if(evaluated.period.from!==r.periodFrom||evaluated.period.to!==r.periodTo||r.sourceHash!==evaluated.sourceHash||r.quantity!==evaluated.result.amount||r.unit!==configuration.outputUnit||r.payComponentId!==component.id||r.amount!==price.amount||r.rate!==price.rate||hash(r.payload)!==hash({result:evaluated.result,days:evaluated.days,eligibility:evaluated.eligibility}))throw Error('Attendance, eligibility, formula engine or Pay Item changed. Recalculate and review a new result.');
 return {configuration,evaluated,component,price};
}
/** A single employee-period calculation is bounded and explicit. No Payroll or Attendance rows are changed. */
export function calculateAttendanceFormulaResult(ctx:SessionContext,p:{id:string;employmentId:string;date:string;companyIds?:readonly string[]}){return withAttendanceTenant(ctx,async tx=>{
 actor(ctx);if(!uuid.test(p.employmentId)||!isCalendarDate(p.date))throw Error('Choose an employee and date.');await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+p.employmentId},0))`);await lock(tx,ctx,p.id);
 const {companyId}=await attendanceFormulaCompanyAt(tx,p.employmentId,p.date);
 if(p.companyIds&&!p.companyIds.includes(companyId))throw Error('Choose the employee company in your selected scope.');
 const revision=await subjectRevision(tx,{companyId,employmentId:p.employmentId,date:p.date,formulaId:p.id});
 if(!revision)throw Error('Activate a tested formula effective for this employee company before calculation.');
 const configuration=validateAttendanceFormulaConfiguration(revision.definition),evaluated=await evaluate(tx,ctx,revision,p.employmentId,p.date);
 if(evaluated.period.from<configuration.effectiveFrom)throw Error('The whole calculation period must be on or after the formula effective date.');
 const [companyRow]=await tx.select({currency:company.currency}).from(company).where(eq(company.id,companyId));
 if(!companyRow||companyRow.currency!=='MYR')throw Error('Attendance formula monetary review currently requires a MYR company.');
 const component=await item(tx,configuration),price=priceAttendanceFormulaQuantity(component,{quantity:evaluated.result.amount,unit:configuration.outputUnit});
 const previous=await tx.select().from(attendanceFormulaResult).where(and(eq(attendanceFormulaResult.formulaId,p.id),eq(attendanceFormulaResult.companyId,companyId),eq(attendanceFormulaResult.employmentId,p.employmentId),lte(attendanceFormulaResult.periodFrom,evaluated.period.to),gte(attendanceFormulaResult.periodTo,evaluated.period.from))).orderBy(desc(attendanceFormulaResult.createdAt),desc(attendanceFormulaResult.id)).limit(501);
 if(previous.length>500)throw Error('The calculation history exceeds the supported review bound.');
 const current=[];for(const row of previous){const state=await attendanceFormulaResultStateTx(tx,row.id);if(state?.kind==='posted')throw Error('This period is posted to Payroll. Use the controlled Payroll reversal before recalculating.');if(state&& !['superseded','reversed'].includes(state.kind))current.push(row);}
 const same=current.find(row=>row.revisionId===revision.id&&row.sourceHash===evaluated.sourceHash&&row.amount===price.amount&&row.rate===price.rate&&row.quantity===evaluated.result.amount&&row.periodFrom===evaluated.period.from&&row.periodTo===evaluated.period.to);if(same&&current.length===1)return same;
 for(const prior of current)await appendAttendanceFormulaResultEventTx(tx,ctx,prior,'superseded','Recalculated from current actual Attendance evidence.');
 const [result]=await tx.insert(attendanceFormulaResult).values({tenantId:ctx.tenantId,companyId,formulaId:p.id,revisionId:revision.id,employmentId:p.employmentId,periodFrom:evaluated.period.from,periodTo:evaluated.period.to,payComponentId:component.id,quantity:evaluated.result.amount,unit:configuration.outputUnit,rate:price.rate,amount:price.amount,sourceHash:evaluated.sourceHash,readRequirements:{...revision.readRequirements,financial:true},payload:{result:evaluated.result,days:evaluated.days,eligibility:evaluated.eligibility},createdBy:actor(ctx)}).returning();
 await appendAttendanceFormulaResultEventTx(tx,ctx,result,'calculated','Calculated from the effective active formula and actual Attendance.');return result;
});}
export function reviewAttendanceFormulaResult(ctx:SessionContext,p:{resultId:string;command:'review'|'approve';reason:string}){return withAttendanceTenant(ctx,async tx=>{
 actor(ctx);if(!uuid.test(p.resultId)||!['review','approve'].includes(p.command))throw Error('Choose a result and review action.');const [initial]=await tx.select().from(attendanceFormulaResult).where(eq(attendanceFormulaResult.id,p.resultId));if(!initial)throw Error('Result or permission is unavailable.');await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+initial.employmentId},0))`);const current=await attendanceFormulaResultStateTx(tx,initial.id);if(current?.kind!==(p.command==='review'?'calculated':'reviewed'))throw Error('Reopen the result current review state.');await replayAttendanceFormulaResultTx(tx,ctx,initial);await appendAttendanceFormulaResultEventTx(tx,ctx,initial,p.command==='review'?'reviewed':'approved',p.reason);return {id:initial.id};
});}
export function listAttendanceFormulaResults(ctx:SessionContext,p:{employmentId:string;date:string}){return withAttendanceTenant(ctx,async tx=>{
 actor(ctx);if(!uuid.test(p.employmentId)||!/^\d{4}-\d{2}-\d{2}$/.test(p.date))throw Error('Choose an employee and date.');
 const rows=await tx.select({result:{id:attendanceFormulaResult.id,companyId:attendanceFormulaResult.companyId,formulaId:attendanceFormulaResult.formulaId,revisionId:attendanceFormulaResult.revisionId,employmentId:attendanceFormulaResult.employmentId,periodFrom:attendanceFormulaResult.periodFrom,periodTo:attendanceFormulaResult.periodTo,payComponentId:attendanceFormulaResult.payComponentId,quantity:attendanceFormulaResult.quantity,unit:attendanceFormulaResult.unit,rate:attendanceFormulaResult.rate,amount:attendanceFormulaResult.amount,createdAt:attendanceFormulaResult.createdAt},payCode:payComponent.code,payName:payComponent.name}).from(attendanceFormulaResult).innerJoin(payComponent,eq(payComponent.id,attendanceFormulaResult.payComponentId)).where(and(eq(attendanceFormulaResult.employmentId,p.employmentId),lte(attendanceFormulaResult.periodFrom,p.date),gte(attendanceFormulaResult.periodTo,p.date))).orderBy(desc(attendanceFormulaResult.createdAt),desc(attendanceFormulaResult.id)).limit(501);
 if(rows.length>500)throw Error('Narrow the result history.');
 return Promise.all(rows.map(async row=>{
  const result=row.result;
  const revision=await subjectRevision(tx,{companyId:result.companyId,employmentId:result.employmentId,date:result.periodTo,formulaId:result.formulaId,resultId:result.id});
  if(!revision)throw Error('The retained formula version is unavailable.');
  return {result,code:revision.definition.code,version:revision.ordinal,
   definition:{description:revision.definition.description,period:{method:revision.definition.period.method}},payCode:row.payCode,payName:row.payName,
   state:(await attendanceFormulaResultStateTx(tx,result.id))?.kind??'calculated'};
 }));
});}

export async function readAttendanceFormulaResultTx(tx:Tx,ctx:SessionContext,id:string){actor(ctx);if(!uuid.test(id))throw Error('Choose an Attendance result.');const [row]=await tx.select().from(attendanceFormulaResult).where(and(eq(attendanceFormulaResult.id,id),eq(attendanceFormulaResult.tenantId,ctx.tenantId)));if(!row)throw Error('Result or permission is unavailable.');return row;}

export function readAttendanceFormulaResult(ctx:SessionContext,id:string){return withAttendanceTenant(ctx,tx=>readAttendanceFormulaResultTx(tx,ctx,id));}
export function attendanceFormulaChoicesForDay(ctx:SessionContext,p:{employmentId:string;date:string;companyIds:string[]}){return withAttendanceTenant(ctx,async tx=>{
 actor(ctx);if(!uuid.test(p.employmentId)||p.companyIds.length>500||p.companyIds.some(id=>!uuid.test(id)))throw Error('Choose a valid employee/company scope.');const proof=(await provenCompanyDatesTx(tx,[{employmentId:p.employmentId,date:p.date}])).get(p.employmentId+'|'+p.date);if(!proof?.companyId||proof.reason||!p.companyIds.includes(proof.companyId))return [];
 await scope(tx,proof.companyId);const [employee]=await tx.execute<{allowed:boolean}>(sql`select app.can_admin_employment(${p.employmentId}::uuid) as allowed`);if(!employee?.allowed)throw Error('Employee administrative scope is required.');
 return Array.from(await tx.execute<{id:string;code:string;description:string;method:string}>(sql`
  select formula_id as id,definition->>'code' as code,definition->>'description' as description,definition->'period'->>'method' as method
  from app.attendance_formula_subject_versions(${proof.companyId}::uuid,${p.employmentId}::uuid,${p.date}::date)
  order by definition->>'code',formula_id`));
});}

/** Shared period-end eligibility for conflict planning. Missing native criteria facts refuse. */
export async function attendanceFormulaEligibleForPeriodTx(tx:Tx,ctx:SessionContext,raw:unknown,p:{employmentId:string;from:string;to:string}){
 const configuration=validateAttendanceFormulaConfiguration(raw);if(configuration.effectiveFrom>p.from)return false;if(configuration.eligibility.mode==='all')return true;
 if(configuration.eligibility.mode==='selected')return configuration.eligibility.employmentIds.includes(p.employmentId);
 const source=await readAttendanceFormulaDaysTx(tx,ctx,{companyId:configuration.companyId,employmentId:p.employmentId,from:p.from,to:p.to,variables:[],includeEligibility:true}),facts=source.eligibilityFacts.at(-1)?.facts;
 if(!facts||allowanceEmployeeLeaves(configuration.eligibility.expression).some(leaf=>facts[leaf.field]==null))throw Error('The employee eligibility source is incomplete for this period.');
 return allowanceEmployeeExpressionMatches(configuration.eligibility.expression,facts);
}
