/** AI v2 P2-2a — the read services behind AI Centre › Operations › Loops › Payroll cycle (no React here).
 *
 * One group pipeline per month, filtered to the companies the viewer administers (owner decision 6): for each company,
 * the Pre-salary loop's checks and the Salary payroll loop's runs, as their last runs recorded them (the loops' own
 * cases, never a fresh computation on view), the last three cycles compared, and the people loops' open cards. The Audit
 * loop's column is a separate read (P2-2b); this service leaves its slot empty (`audit: null`) until that read exists.
 *
 * Administrators only (the page's requireAdmin, checked again here). Every row is read under the viewer's row-level
 * security: an administrator of one company sees that company only, and a named person appears only where the viewer
 * may read their record. The Salary payroll page and the settings page add what only payroll administrators may see:
 * each person's net-swing flag (a ratio, never an amount) and the thresholds. No model is called; no figure of pay is
 * computed here. */
import {and,count,desc,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {appUser,company,companyPayrollConfig,domainEvent,employment,payrollBatch,payrollStatusHistory,person} from '../../db/schema';
import {terasLoopCase,terasLoopPause} from '../../db/teras-schema';
import {terasPayrollSwingDisposition,terasPayrollThresholdDecision} from '../../db/teras-payroll-cycle-schema';
import {isAdmin} from '../../lib/authz-model';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {tenantStoppedTx,workerSwitchStateTx} from '../agent-registry/controls';
import {registeredWorker} from '../agent-registry/workers';
import {anomalyMetrics} from '../payroll-anomaly';
import {PAY_CAUSE_KINDS,type PayCauseKind} from '../pay-difference';
import {decodeCheck,type PreSalaryCheck} from './pre-salary-checks';
import {daysBetween,nextPeriod,preSalaryWindows,previousPeriod,payrollKey,type CompanyCutOffs} from './payroll-inputs';
import {payrollLoopSettingHistoryTx,payrollLoopSettingsTx,thresholdProposalsTx,type PayrollLoopSetting} from './payroll-loop-settings';
import {startKey,type BankCheck} from './salary-payroll';
import type {SwingProposal} from './swing-proposals';
import type {LoopFacts,LoopId} from './types';

export class PayrollCycleRefused extends Error{constructor(readonly reason:'not_administrator'|'invalid'){super('Payroll cycle view refused: '+reason);this.name='PayrollCycleRefused';}}
const PERIOD=/^\d{4}-(0[1-9]|1[0-2])$/;
const requireViewer=(ctx:SessionContext)=>{if(!ctx.userId||ctx.agent||!isAdmin(ctx))throw new PayrollCycleRefused('not_administrator');};
const str=(facts:LoopFacts,key:string)=>typeof facts[key]==='string'?facts[key] as string:null;
const num=(facts:LoopFacts,key:string)=>typeof facts[key]==='number'?facts[key] as number:0;
const list=(facts:LoopFacts,key:string)=>Array.isArray(facts[key])?(facts[key] as readonly string[]).filter(value=>typeof value==='string'):[];
const klDay=(at:Date)=>todayInKualaLumpur(at);

export type CompanyRef=Readonly<{companyId:string;companyName:string}>;
export type LoopSwitch=Readonly<{on:boolean;stopped:boolean}>;
export type PreSalaryState='off'|'paused'|'not_checked'|'open'|'done'|'missed';
export type PreSalaryView=Readonly<{state:PreSalaryState;payPeriod:string;cutOff:string;from:string;daysToCutOff:number;checks:readonly PreSalaryCheck[];
 lastCheckedAt:Date|null;interval:PayrollLoopSetting['interval']}>;
export type SalaryRunView=Readonly<{caseId:string;batchId:string;companyId:string;payPeriod:string;runType:string;runSeq:number;status:'draft'|'processed'|'closed';
 stale:boolean;employees:number;detectors:number;evaluated:boolean;exceptions:number;changed:number;flagged:number;thresholdBp:number;
 causes:readonly Readonly<{kind:PayCauseKind;count:number}>[];ruleVersion:string|null;rulesNewer:readonly string[];bank:BankCheck;done:boolean;
 reopened:number;closedBy:string|null;checkedAt:Date}>;
export type SalaryState='off'|'paused'|'before_cut_off'|'not_checked'|'ready_to_start'|'in_progress'|'attention'|'done';
export type SalaryView=Readonly<{state:SalaryState;cutOff:string;runs:readonly SalaryRunView[]}>;
export type PayrollCycleCompany=Readonly<CompanyRef&{payDay:string|null;preSalary:PreSalaryView;salary:SalaryView}>;
export type CycleHistoryRow=Readonly<{period:string;
 /** Days before the cut-off the inputs were ready (0 = on the day); 'missed' when not ready by it; null when not measured. */
 inputsReady:number|'missed'|null;issuesCaught:number|null;closedOn:string|null;allClosed:boolean;correctionsAfter:number;runs:number}>;
export type PeopleLoopView=Readonly<{id:LoopId;open:number}>;
export type PayrollCycleOverview=Readonly<{period:string;today:string;allowed:readonly CompanyRef[];filter:string|null;companies:readonly PayrollCycleCompany[];
 loops:Readonly<{preSalary:LoopSwitch;salary:LoopSwitch}>;history:readonly CycleHistoryRow[];people:readonly PeopleLoopView[];
 /** The Audit loop's column (P2-2b). Null until its read exists: the page then shows no status for it. */
 audit:null;statutoryDue:string}>;

const PEOPLE_LOOPS:readonly LoopId[]=Object.freeze(['loop_probation_ending','loop_missing_employee_data','loop_document_expiry']);
const BANK_CHECKS:readonly BankCheck[]=['match','total_mismatch','count_mismatch','not_available','blocked','not_ready'];

/** Companies the viewer administers, by name. */
async function allowedTx(tx:Tx,ctx:SessionContext,payrollOnly=false):Promise<CompanyRef[]>{
 const rows=await tx.execute(sql`select c.id,c.legal_name from public.company c where c.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(c.id)
  ${payrollOnly?sql`and app.can_admin_payroll_for(c.id)`:sql``} order by c.legal_name,c.id`) as unknown as {id:string;legal_name:string}[];
 return Array.from(rows).map(row=>Object.freeze({companyId:row.id,companyName:row.legal_name}));
}
async function switchTx(tx:Tx,ctx:SessionContext,id:LoopId,stopped:boolean):Promise<LoopSwitch>{
 const worker=registeredWorker(id);
 const state=worker?await workerSwitchStateTx(tx,ctx,worker):{on:false};
 return Object.freeze({on:state.on,stopped});
}
async function pausedTx(tx:Tx,ctx:SessionContext){
 const rows=await tx.select({workerId:terasLoopPause.workerId,companyId:terasLoopPause.companyId}).from(terasLoopPause)
  .where(and(eq(terasLoopPause.tenantId,ctx.tenantId),eq(terasLoopPause.paused,true)));
 return new Set(rows.map(row=>`${row.workerId}:${row.companyId}`));
}
/** The name of the person behind each app user, where the viewer may read it. */
async function namesTx(tx:Tx,userIds:readonly string[]){
 const ids=[...new Set(userIds)];
 if(!ids.length)return new Map<string,string|null>();
 const rows=await tx.select({id:appUser.id,name:person.fullName}).from(appUser).leftJoin(person,eq(person.id,appUser.personId)).where(inArray(appUser.id,ids));
 return new Map(rows.map(row=>[row.id,row.name??null]));
}
/** Who closed each run: the native close event's own actor. */
async function closedByTx(tx:Tx,ctx:SessionContext,batchIds:readonly string[]){
 if(!batchIds.length)return new Map<string,string|null>();
 const rows=await tx.select({batchId:domainEvent.aggregateId,actorId:domainEvent.actorId,at:domainEvent.occurredAt}).from(domainEvent)
  .where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.aggregateType,'payroll-batch'),eq(domainEvent.eventType,'payroll-batch.closed'),
   inArray(domainEvent.aggregateId,[...batchIds]))).orderBy(desc(domainEvent.occurredAt));
 const latest=new Map<string,string|null>();
 for(const row of rows)if(!latest.has(row.batchId))latest.set(row.batchId,row.actorId??null);
 const names=await namesTx(tx,[...latest.values()].filter((id):id is string=>!!id));
 return new Map([...latest].map(([batchId,actorId])=>[batchId,actorId?names.get(actorId)??null:null]));
}

function runView(row:{id:string;companyId:string;subjectKey:string;state:string;closeReason:string|null;reopenCount:number;facts:LoopFacts;checkedAt:Date},closedBy:string|null):SalaryRunView|null{
 const facts=row.facts,payPeriod=str(facts,'payPeriod'),status=str(facts,'status'),bank=str(facts,'bank');
 if(!payPeriod||!PERIOD.test(payPeriod)||(status!=='draft'&&status!=='processed'&&status!=='closed'))return null;
 const causes=list(facts,'causes').flatMap(value=>{const [kind,n]=value.split(':');return (PAY_CAUSE_KINDS as readonly string[]).includes(kind)&&/^\d+$/.test(n??'')?[{kind:kind as PayCauseKind,count:Number(n)}]:[];});
 return Object.freeze({caseId:row.id,batchId:row.subjectKey.slice('salaryrun:'.length),companyId:row.companyId,payPeriod,runType:str(facts,'runType')??'regular',
  runSeq:num(facts,'runSeq'),status,stale:facts.stale===true,employees:num(facts,'employees'),detectors:num(facts,'detectors'),evaluated:facts.evaluated===true,
  exceptions:num(facts,'exceptions'),changed:num(facts,'changed'),flagged:num(facts,'flagged'),thresholdBp:num(facts,'thresholdBp'),causes:Object.freeze(causes),
  ruleVersion:str(facts,'ruleVersion'),rulesNewer:Object.freeze(list(facts,'rulesNewer')),bank:BANK_CHECKS.includes(bank as BankCheck)?bank as BankCheck:'not_ready',
  done:row.state==='closed'&&row.closeReason==='done',reopened:row.reopenCount,closedBy,checkedAt:row.checkedAt});
}

/** The month's group pipeline for the companies the viewer administers, optionally one of them. */
export async function payrollCycleOverview(ctx:SessionContext,options:Readonly<{period?:unknown;companyId?:unknown;today?:string}>={}):Promise<PayrollCycleOverview>{
 requireViewer(ctx);
 const today=options.today??todayInKualaLumpur();
 const period=typeof options.period==='string'&&PERIOD.test(options.period)?options.period:today.slice(0,7);
 return withTenant(ctx,async tx=>{
  const allowed=await allowedTx(tx,ctx);
  const filter=typeof options.companyId==='string'&&allowed.some(item=>item.companyId===options.companyId)?options.companyId:null;
  const scope=filter?allowed.filter(item=>item.companyId===filter):allowed;
  const ids=scope.map(item=>item.companyId);
  const stopped=await tenantStoppedTx(tx,ctx.tenantId);
  const loops={preSalary:await switchTx(tx,ctx,'loop_payroll_inputs',stopped),salary:await switchTx(tx,ctx,'loop_salary_payroll',stopped)};
  const paused=await pausedTx(tx,ctx);
  const settings=await payrollLoopSettingsTx(tx,ctx.tenantId,ids);
  const cutOffs=await companyCutOffsTx(tx,ctx.tenantId,ids);
  const periods=[period,previousPeriod(period),previousPeriod(previousPeriod(period)),previousPeriod(previousPeriod(previousPeriod(period)))];
  const preKeys=ids.flatMap(companyId=>periods.map(p=>payrollKey(companyId,p)));
  const cases=ids.length?await tx.select({id:terasLoopCase.id,workerId:terasLoopCase.workerId,companyId:terasLoopCase.companyId,subjectKey:terasLoopCase.subjectKey,
   state:terasLoopCase.state,closeReason:terasLoopCase.closeReason,reopenCount:terasLoopCase.reopenCount,facts:terasLoopCase.facts,checkedAt:terasLoopCase.checkedAt,
   closedAt:terasLoopCase.closedAt}).from(terasLoopCase)
   .where(and(eq(terasLoopCase.tenantId,ctx.tenantId),inArray(terasLoopCase.companyId,ids),inArray(terasLoopCase.workerId,['loop_payroll_inputs','loop_salary_payroll']),
    sql`(${inArray(terasLoopCase.subjectKey,preKeys)} or ${terasLoopCase.subjectKey} like 'salaryrun:%' or ${terasLoopCase.subjectKey} like 'salarystart:%')`)):[];
  const runCases=cases.filter(row=>row.workerId==='loop_salary_payroll'&&row.subjectKey.startsWith('salaryrun:')&&periods.includes(str(row.facts,'payPeriod')??''));
  const closedBy=await closedByTx(tx,ctx,runCases.map(row=>row.subjectKey.slice('salaryrun:'.length)));
  const runs=runCases.map(row=>runView(row,closedBy.get(row.subjectKey.slice('salaryrun:'.length))??null)).filter((row):row is SalaryRunView=>!!row);
  const companies=scope.map(ref=>{
   const cfg=cutOffs.get(ref.companyId)??null,windows=preSalaryWindows(cfg,period),setting=settings.get(ref.companyId)!;
   const pre=cases.find(row=>row.workerId==='loop_payroll_inputs'&&row.subjectKey===payrollKey(ref.companyId,period));
   const preState:PreSalaryState=!loops.preSalary.on||loops.preSalary.stopped?'off':paused.has(`loop_payroll_inputs:${ref.companyId}`)?'paused'
    :!pre?'not_checked':pre.state!=='closed'?'open':pre.closeReason==='done'?'done':'missed';
   const preSalary:PreSalaryView=Object.freeze({state:preState,payPeriod:period,cutOff:windows.salary.end,from:windows.salary.start,
    daysToCutOff:daysBetween(today,windows.salary.end),checks:Object.freeze(pre?list(pre.facts,'checks').map(decodeCheck).filter((c):c is PreSalaryCheck=>!!c):[]),
    lastCheckedAt:pre?.checkedAt??null,interval:setting.interval});
   const own=runs.filter(run=>run.companyId===ref.companyId&&run.payPeriod===period).sort((a,b)=>a.runSeq-b.runSeq);
   const start=cases.find(row=>row.workerId==='loop_salary_payroll'&&row.subjectKey===startKey(ref.companyId,period));
   const salaryState:SalaryState=!loops.salary.on||loops.salary.stopped?'off':paused.has(`loop_salary_payroll:${ref.companyId}`)?'paused'
    :own.length?(own.some(run=>!run.done&&(run.bank==='total_mismatch'||run.bank==='count_mismatch'||run.bank==='blocked'))?'attention':own.every(run=>run.done)?'done':'in_progress')
    :start&&start.state!=='closed'?'ready_to_start':windows.salary.end>=today?'before_cut_off':'not_checked';
   return Object.freeze({...ref,payDay:payDayOf(cfg?.payDay??null,period),preSalary,salary:Object.freeze({state:salaryState,cutOff:windows.salary.end,runs:Object.freeze(own)})});
  });
  // The last three cycles, for the same companies.
  const history:CycleHistoryRow[]=[];
  for(const p of periods.slice(1)){
   const pres=ids.map(companyId=>cases.find(row=>row.workerId==='loop_payroll_inputs'&&row.subjectKey===payrollKey(companyId,p)));
   const measured=pres.filter((row):row is NonNullable<typeof row>=>!!row&&row.state==='closed');
   let inputsReady:CycleHistoryRow['inputsReady']=null;
   if(measured.some(row=>row.closeReason==='expired'))inputsReady='missed';
   else if(measured.length&&measured.length===pres.length&&measured.every(row=>row.closeReason==='done'&&row.closedAt)){
    inputsReady=Math.min(...measured.map(row=>daysBetween(klDay(row.closedAt!),str(row.facts,'cutOff')??klDay(row.closedAt!))));
   }
   const batches=ids.length?await tx.select({id:payrollBatch.id,runType:payrollBatch.runType,status:payrollBatch.status,closedAt:payrollBatch.closedAt}).from(payrollBatch)
    .where(and(inArray(payrollBatch.companyId,ids),eq(payrollBatch.payPeriod,p),sql`${payrollBatch.historyImportAttemptId} is null`)):[];
   const regular=batches.filter(batch=>batch.runType==='regular');
   const allClosed=regular.length>0&&regular.every(batch=>batch.status==='closed'&&batch.closedAt);
   const closedOn=allClosed?klDay(new Date(Math.max(...regular.map(batch=>batch.closedAt!.getTime())))):null;
   const [unlocks]=batches.length?await tx.select({n:count()}).from(payrollStatusHistory)
    .where(and(inArray(payrollStatusHistory.batchId,batches.map(batch=>batch.id)),eq(payrollStatusHistory.action,'unlock'))):[{n:0}];
   let issuesCaught:number|null=null;
   const processed=batches.filter(batch=>batch.status!=='draft');
   if(processed.length){
    issuesCaught=0;
    for(const batch of processed){const metrics=await anomalyMetrics(ctx,{batchId:batch.id});issuesCaught+=metrics.review+metrics.block;}
    const [swings]=await tx.select({n:count()}).from(terasLoopCase).where(and(eq(terasLoopCase.tenantId,ctx.tenantId),eq(terasLoopCase.workerId,'loop_salary_payroll'),
     inArray(terasLoopCase.companyId,ids),sql`${terasLoopCase.subjectKey} like ${'swing:%:'+p}`));
    issuesCaught+=Number(swings?.n??0);
   }
   history.push(Object.freeze({period:p,inputsReady,issuesCaught,closedOn,allClosed,correctionsAfter:Number(unlocks?.n??0),runs:batches.length}));
  }
  const people=ids.length?await tx.select({workerId:terasLoopCase.workerId,n:count()}).from(terasLoopCase)
   .where(and(eq(terasLoopCase.tenantId,ctx.tenantId),inArray(terasLoopCase.workerId,[...PEOPLE_LOOPS]),inArray(terasLoopCase.companyId,ids),inArray(terasLoopCase.state,['open','waiting'])))
   .groupBy(terasLoopCase.workerId):[];
  return Object.freeze({period,today,allowed:Object.freeze(allowed),filter,companies:Object.freeze(companies),loops:Object.freeze(loops),history:Object.freeze(history),
   people:Object.freeze(PEOPLE_LOOPS.map(id=>Object.freeze({id,open:Number(people.find(row=>row.workerId===id)?.n??0)}))),audit:null,
   statutoryDue:`${nextPeriod(period)}-15`});
 });
}

/** The pay day of a period: the company's pay day of the month, or the month end; clamped to the month. */
export function payDayOf(day:number|null,period:string):string{
 const y=Number(period.slice(0,4)),m=Number(period.slice(5,7)),last=new Date(Date.UTC(y,m,0)).getUTCDate();
 return `${period}-${String(Math.min(day&&day>0?day:last,last)).padStart(2,'0')}`;
}

async function companyCutOffsTx(tx:Tx,tenantId:string,companyIds:readonly string[]):Promise<Map<string,CompanyCutOffs>>{
 if(!companyIds.length)return new Map();
 const rows=await tx.select({companyId:companyPayrollConfig.companyId,cutOffDay:companyPayrollConfig.cutOffDay,overtimeCutOffDay:companyPayrollConfig.overtimeCutOffDay,
  claimCutOffDay:companyPayrollConfig.claimCutOffDay,unpaidLeaveCutOffDay:companyPayrollConfig.unpaidLeaveCutOffDay,attendanceCutOffDay:companyPayrollConfig.attendanceCutOffDay,
  payDay:companyPayrollConfig.payDay}).from(companyPayrollConfig).where(and(eq(companyPayrollConfig.tenantId,tenantId),inArray(companyPayrollConfig.companyId,[...companyIds])));
 return new Map(rows.map(row=>[row.companyId,row]));
}

// ── The Salary payroll loop's page: its runs and the net-swing flags, for payroll administrators ──

export type SwingFlagView=Readonly<{caseId:string;companyId:string;companyName:string|null;personName:string|null;payPeriod:string;swingBp:number;direction:'up'|'down'|null;
 pattern:string;thresholdBp:number;causes:readonly PayCauseKind[];state:'open'|'closed';closeReason:string|null;
 disposition:Readonly<{value:'expected'|'problem';by:string|null;at:Date}>|null}>;
export type SalaryLoopPage=Readonly<{period:string;today:string;allowed:readonly CompanyRef[];filter:string|null;loop:LoopSwitch;
 companies:readonly Readonly<CompanyRef&{cutOff:string;thresholdBp:number;startOpen:boolean;runs:readonly SalaryRunView[]}>[];flags:readonly SwingFlagView[]}>;

export async function salaryLoopPage(ctx:SessionContext,options:Readonly<{period?:unknown;companyId?:unknown;today?:string}>={}):Promise<SalaryLoopPage>{
 requireViewer(ctx);
 const today=options.today??todayInKualaLumpur();
 const period=typeof options.period==='string'&&PERIOD.test(options.period)?options.period:today.slice(0,7);
 return withTenant(ctx,async tx=>{
  const allowed=await allowedTx(tx,ctx,true);
  const filter=typeof options.companyId==='string'&&allowed.some(item=>item.companyId===options.companyId)?options.companyId:null;
  const scope=filter?allowed.filter(item=>item.companyId===filter):allowed;
  const ids=scope.map(item=>item.companyId);
  const loop=await switchTx(tx,ctx,'loop_salary_payroll',await tenantStoppedTx(tx,ctx.tenantId));
  const settings=await payrollLoopSettingsTx(tx,ctx.tenantId,ids),cutOffs=await companyCutOffsTx(tx,ctx.tenantId,ids);
  const cases=ids.length?await tx.select({id:terasLoopCase.id,companyId:terasLoopCase.companyId,employmentId:terasLoopCase.employmentId,subjectKey:terasLoopCase.subjectKey,
   state:terasLoopCase.state,closeReason:terasLoopCase.closeReason,reopenCount:terasLoopCase.reopenCount,facts:terasLoopCase.facts,checkedAt:terasLoopCase.checkedAt,
   personName:person.fullName,companyName:company.legalName}).from(terasLoopCase)
   .leftJoin(employment,eq(employment.id,terasLoopCase.employmentId)).leftJoin(person,eq(person.id,employment.personId)).leftJoin(company,eq(company.id,terasLoopCase.companyId))
   .where(and(eq(terasLoopCase.tenantId,ctx.tenantId),eq(terasLoopCase.workerId,'loop_salary_payroll'),inArray(terasLoopCase.companyId,ids),
    sql`${terasLoopCase.facts}->>'payPeriod'=${period}`)).orderBy(desc(terasLoopCase.checkedAt),desc(terasLoopCase.id)):[];
  const runCases=cases.filter(row=>row.subjectKey.startsWith('salaryrun:'));
  const closedBy=await closedByTx(tx,ctx,runCases.map(row=>row.subjectKey.slice('salaryrun:'.length)));
  const runs=runCases.map(row=>runView(row,closedBy.get(row.subjectKey.slice('salaryrun:'.length))??null)).filter((row):row is SalaryRunView=>!!row);
  const swingCases=cases.filter(row=>row.subjectKey.startsWith('swing:')&&row.employmentId);
  const dispositions=swingCases.length?await tx.select({caseId:terasPayrollSwingDisposition.caseId,value:terasPayrollSwingDisposition.disposition,
   by:terasPayrollSwingDisposition.decidedByUserId,at:terasPayrollSwingDisposition.decidedAt}).from(terasPayrollSwingDisposition)
   .where(and(eq(terasPayrollSwingDisposition.tenantId,ctx.tenantId),inArray(terasPayrollSwingDisposition.caseId,swingCases.map(row=>row.id)))):[];
  const names=await namesTx(tx,dispositions.map(row=>row.by));
  const flags=swingCases.flatMap(row=>{
   const facts=row.facts,pattern=str(facts,'pattern'),direction=str(facts,'direction');
   if(!pattern)return [];
   const d=dispositions.find(item=>item.caseId===row.id);
   // A flag that no longer applies (reprocessed under the threshold) is not listed.
   if(row.state==='closed'&&!d)return [];
   return [Object.freeze({caseId:row.id,companyId:row.companyId,companyName:row.companyName??null,personName:row.personName??null,payPeriod:period,swingBp:num(facts,'swingBp'),
    direction:direction==='up'||direction==='down'?direction:null,pattern,thresholdBp:num(facts,'thresholdBp'),
    causes:Object.freeze(list(facts,'causes').filter((kind):kind is PayCauseKind=>(PAY_CAUSE_KINDS as readonly string[]).includes(kind))),
    state:row.state==='closed'?'closed' as const:'open' as const,closeReason:row.closeReason,
    disposition:d?Object.freeze({value:d.value,by:names.get(d.by)??null,at:d.at}):null})];
  }).sort((a,b)=>(a.disposition?1:0)-(b.disposition?1:0)||b.swingBp-a.swingBp||(a.personName??'').localeCompare(b.personName??''));
  const companies=scope.map(ref=>Object.freeze({...ref,cutOff:preSalaryWindows(cutOffs.get(ref.companyId)??null,period).salary.end,
   thresholdBp:settings.get(ref.companyId)!.thresholdBp,
   startOpen:cases.some(row=>row.subjectKey===startKey(ref.companyId,period)&&row.state!=='closed'),
   runs:Object.freeze(runs.filter(run=>run.companyId===ref.companyId).sort((a,b)=>a.runSeq-b.runSeq))}));
  return Object.freeze({period,today,allowed:Object.freeze(allowed),filter,loop,companies:Object.freeze(companies),flags:Object.freeze(flags)});
 });
}

// ── Settings: the interval and threshold per company, the proposals and the history ──

export type ThresholdDecisionView=Readonly<{id:string;kind:'threshold'|'exclusion';fromThresholdBp:number;toThresholdBp:number|null;pattern:string|null;
 decision:'approved'|'rejected';by:string|null;at:Date}>;
export type SettingHistoryView=Readonly<{version:number;interval:PayrollLoopSetting['interval'];thresholdBp:number;exclusions:readonly string[];source:'admin'|'proposal';
 by:string|null;at:Date}>;
export type PayrollLoopSettingsPage=Readonly<{companies:readonly Readonly<CompanyRef&{setting:PayrollLoopSetting;proposals:readonly SwingProposal[];
 history:readonly SettingHistoryView[];decisions:readonly ThresholdDecisionView[]}>[]}>;

export async function payrollLoopSettingsPage(ctx:SessionContext,options:Readonly<{now?:Date}>={}):Promise<PayrollLoopSettingsPage>{
 requireViewer(ctx);
 const now=options.now??new Date();
 return withTenant(ctx,async tx=>{
  const allowed=await allowedTx(tx,ctx);
  const ids=allowed.map(item=>item.companyId);
  const history=await payrollLoopSettingHistoryTx(tx,ctx.tenantId,ids,100);
  const decisions=ids.length?await tx.select().from(terasPayrollThresholdDecision)
   .where(and(eq(terasPayrollThresholdDecision.tenantId,ctx.tenantId),inArray(terasPayrollThresholdDecision.companyId,ids)))
   .orderBy(desc(terasPayrollThresholdDecision.decidedAt)).limit(100):[];
  const names=await namesTx(tx,[...history.map(row=>row.changedByUserId),...decisions.map(row=>row.decidedByUserId)]);
  const companies=[];
  for(const ref of allowed){
   const {setting,proposals}=await thresholdProposalsTx(tx,ctx.tenantId,ref.companyId,now);
   companies.push(Object.freeze({...ref,setting,proposals,
    history:Object.freeze(history.filter(row=>row.companyId===ref.companyId).slice(0,10).map(row=>Object.freeze({version:row.version,interval:row.checkInterval,
     thresholdBp:row.swingThresholdBp,exclusions:Object.freeze([...row.swingExclusions]),source:row.source,by:names.get(row.changedByUserId)??null,at:row.changedAt}))),
    decisions:Object.freeze(decisions.filter(row=>row.companyId===ref.companyId).slice(0,10).map(row=>Object.freeze({id:row.id,kind:row.kind,fromThresholdBp:row.fromThresholdBp,
     toThresholdBp:row.toThresholdBp,pattern:row.pattern,decision:row.decision,by:names.get(row.decidedByUserId)??null,at:row.decidedAt})))}));
  }
  return Object.freeze({companies:Object.freeze(companies)});
 });
}

