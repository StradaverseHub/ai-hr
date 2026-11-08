import {withAiCentreActivity,assertAiCentreRunningTx} from '../ai-centre-control';
/** AI v2 P2-2b — one daily run of the Audit loop for one tenant, at the Prepare level (the W8 runner's shape, core/loops/run.ts).
 *
 *  1. Gate, as the tenant's agent principal: the loop is registered, its own switch is on (teras_worker_control
 *     `loop_payroll_audit`, off by default), the tenant stop switch is off and payroll is in use. Otherwise nothing runs and
 *     nothing is recorded.
 *  2. Sponsor: the group administrator who switched the loop on. Their CURRENT authority is re-read from the database; a
 *     sponsor who lost it stops the loop, recorded once. Scope: the companies the sponsor administers now (as an HR and a
 *     payroll administrator), less the companies where the loop is paused.
 *  3. For each company and each of the last three pay months (core/payroll-audit/capture.ts auditPeriodsFor): run the control
 *     checks as the sponsor, record new findings as the agent principal, then collect the month's evidence as the sponsor and
 *     append what is new or changed as the agent principal. The database refuses an agent write once the switch is off, the
 *     tenant stopped or the company paused (migration 0965). A month with no run and no statutory or bank file is skipped.
 *  4. Record: one append-only teras_loop_run row per company (observed: artefacts collected; opened: findings opened; open now:
 *     findings without a disposition). A failed owner read records a failed run and writes nothing for that company.
 * No model is called; nothing is filed, submitted, closed or changed. Called by the nightly sweep (scripts/review-sweep.ts),
 * and (Phase 2 hardening, 4 November 2026) by the 15-minute payroll tick with `onlyChanged`, for the companies whose payroll
 * runs, statutory files or bank files changed since the loop last ran there (core/loops/payroll-freshness.ts), so a run
 * processed, reprocessed or closed is captured and checked within the quarter hour, not the next morning. */
import {randomUUID} from 'node:crypto';
import {and,count,eq,notExists,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {payrollAuditDisposition,payrollAuditFinding} from '../../db/payroll-audit-schema';
import {terasLoopPause,terasLoopRun,terasMandateControl,terasWorkerControl} from '../../db/teras-schema';
import {isAdmin} from '../../lib/authz-model';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {agentContext} from '../agent-principal';
import {workerRunGateTx} from '../agent-registry/controls';
import type {EntitlementSnapshot} from '../entitlement-types';
import {isModuleEnabled} from '../entitlements';
import {currentSponsorTx} from '../loops/run';
import {lastLoopRunsTx,payrollChangedCompanies} from '../loops/payroll-freshness';
import type {LoopCheck,LoopRead} from '../loops/types';
import {appendCapturesTx,auditPeriodsFor,collectPayrollPeriodArtefactsTx,type AuditArtefact} from './capture';
import {detectControlFindingsTx,recordFindingsTx,type ControlObservation} from './controls';
import {AUDIT_LOOP_ID,AUDIT_LOOP_VERSION} from './types';

export type AuditRunOptions=Readonly<{tenantId:string;principalId:string;entitlements:EntitlementSnapshot;today?:string;
 /** Only the companies whose payroll or its files changed since the loop last ran there (the payroll tick's refresh). */
 onlyChanged?:true}>;
export type AuditRunResult=
 |Readonly<{workerId:typeof AUDIT_LOOP_ID;status:'not_run';reasons:readonly string[]}>
 |Readonly<{workerId:typeof AUDIT_LOOP_ID;status:'sponsor_lost';runId:string}>
 |Readonly<{workerId:typeof AUDIT_LOOP_ID;status:'ran';runId:string;companies:number;captured:number;findingsOpened:number;failed:number}>;

const check=(name:string,ruleVersion:string|null,ok:boolean):LoopCheck=>Object.freeze({check:name,ruleVersion,result:ok?'pass':'fail'});
const read=(tool:string,owner:string,status:LoopRead['status']='ok'):LoopRead=>Object.freeze({tool,owner,status});
const READS:readonly LoopRead[]=Object.freeze([read('payroll.runs','core/payroll-audit/capture.ts#collectPayrollPeriodArtefactsTx'),
 read('payroll.filed','core/statutory-filed.ts#periodFiledTx'),read('payroll.anomaly_context','core/payroll-anomaly.ts#loadBatchContexts'),
 read('payroll.controls','core/payroll-audit/controls.ts#detectControlFindingsTx')]);

async function controlTx(tx:Tx,tenantId:string){
 const [row]=await tx.select({enabled:terasWorkerControl.enabled,version:terasWorkerControl.version,sponsorUserId:terasWorkerControl.changedByUserId})
  .from(terasWorkerControl).where(and(eq(terasWorkerControl.tenantId,tenantId),eq(terasWorkerControl.workerId,AUDIT_LOOP_ID))).limit(1);
 return row??null;
}
async function pausedTx(tx:Tx,tenantId:string):Promise<Set<string>>{
 const rows=await tx.select({companyId:terasLoopPause.companyId}).from(terasLoopPause)
  .where(and(eq(terasLoopPause.tenantId,tenantId),eq(terasLoopPause.workerId,AUDIT_LOOP_ID),eq(terasLoopPause.paused,true)));
 return new Set(rows.map(row=>row.companyId));
}

export async function runPayrollAuditLoop(...args:Parameters<typeof runPayrollAuditLoopActivity>):Promise<Awaited<ReturnType<typeof runPayrollAuditLoopActivity>>>{
 args=structuredClone(args);
 return withAiCentreActivity(agentContext(args[0].tenantId,args[0].principalId,args[0].entitlements),()=>runPayrollAuditLoopActivity(...args)).catch(error=>{if(error instanceof Error&&error.name==='AiAllowanceError')return Object.freeze({workerId:'loop_payroll_audit',status:'not_run' as const,reasons:Object.freeze(['stopped'])});throw error;});
}
async function runPayrollAuditLoopActivity(options:AuditRunOptions):Promise<AuditRunResult>{
 const workerId=AUDIT_LOOP_ID,today=options.today??todayInKualaLumpur(),runId=randomUUID(),startedAt=new Date();
 const agent=agentContext(options.tenantId,options.principalId,options.entitlements);
 const first=await withTenant(agent,async tx=>{
  const gate=await workerRunGateTx(tx,agent,workerId);
  const control=await controlTx(tx,options.tenantId);
  const [stop]=await tx.select({version:terasMandateControl.version}).from(terasMandateControl).where(eq(terasMandateControl.tenantId,options.tenantId)).limit(1);
  const paused=await pausedTx(tx,options.tenantId);
  const sponsor=gate.run&&control?.sponsorUserId?await currentSponsorTx(tx,options.tenantId,control.sponsorUserId,options.entitlements):null;
  return{gate,control,stopVersion:stop?.version??null,paused,sponsor};
 });
 if(!first.gate.run)return Object.freeze({workerId,status:'not_run' as const,reasons:Object.freeze([...first.gate.reasons])});
 if(!isModuleEnabled(agent,'payroll'))return Object.freeze({workerId,status:'not_run' as const,reasons:Object.freeze(['module_off'])});
 const control=first.control!,sponsorUserId=control.sponsorUserId;
 const gateChecks=[check('loop_switch',`teras_worker_control:${workerId}@v${control.version}`,true),
  check('stop_switch',first.stopVersion===null?'teras_mandate_control:none':`teras_mandate_control@v${first.stopVersion}`,true),check('module_enabled','module:payroll',true)];
 const sponsor=first.sponsor&&isAdmin(first.sponsor)?first.sponsor:null;
 const scope=sponsor?await withTenant(sponsor,async tx=>{
  const [snapshot]=await tx.execute(sql`select app.principal_snapshot_current() as ok`) as unknown as {ok:boolean|null}[];
  if(snapshot?.ok!==true)return null;
  const rows=await tx.execute(sql`select c.id from public.company c where c.tenant_id=${options.tenantId}::uuid and app.is_admin_for(c.id) and app.can_admin_payroll_for(c.id) order by c.id`) as unknown as {id:string}[];
  return Array.from(rows).map(row=>row.id);
 }).catch(()=>null):null;
 if(!sponsor||!scope){
  await withTenant(agent,tx=>tx.insert(terasLoopRun).values({tenantId:options.tenantId,runId,workerId,companyId:null,status:'sponsor_lost',sponsorUserId,loopVersion:AUDIT_LOOP_VERSION,
   startedAt,finishedAt:new Date(Math.max(Date.now(),startedAt.getTime())),checks:[...gateChecks,check('sponsor_authority',null,false)],reads:[]}));
  return Object.freeze({workerId,status:'sponsor_lost' as const,runId});
 }
 const checks=[...gateChecks,check('sponsor_authority','sponsor:current',true),check('company_not_paused','teras_loop_pause',true)];
 let companies=scope.filter(companyId=>!first.paused.has(companyId)&&isModuleEnabled(agent,'payroll',companyId));
 if(options.onlyChanged&&companies.length){
  const since=await withTenant(agent,tx=>lastLoopRunsTx(tx,options.tenantId,workerId,companies));
  companies=await payrollChangedCompanies(sponsor,{companies,since,files:true}).catch(()=>[]);
 }
 let captured=0,findingsOpened=0,failed=0;
 for(const companyId of companies){
  const companyStarted=new Date();let observed=0,opened=0,status:'ran'|'failed'='ran';
  try{
   for(const payPeriod of auditPeriodsFor(today)){
    const p={companyId,payPeriod};
    // Checks first, as the sponsor; their findings are recorded, then captured with the rest of the month's evidence.
    const observations:ControlObservation[]=await withTenant(sponsor,tx=>detectControlFindingsTx(tx,sponsor,p));
    if(observations.length)opened+=await withTenant(agent,async tx=>{await assertAiCentreRunningTx(tx,agent);return recordFindingsTx(tx,options.tenantId,{kind:'agent',principalId:options.principalId,runId},observations);});
    const artefacts:AuditArtefact[]=await withTenant(sponsor,tx=>collectPayrollPeriodArtefactsTx(tx,sponsor,p));
    if(!artefacts.some(item=>item.kind==='run'||item.kind==='statutory_file'||item.kind==='bank_file'))continue;
    observed+=artefacts.length;
    captured+=await withTenant(agent,async tx=>{await assertAiCentreRunningTx(tx,agent);return appendCapturesTx(tx,options.tenantId,{kind:'agent',principalId:options.principalId,runId},p,artefacts);});
   }
  }catch{status='failed';failed++;}
  findingsOpened+=opened;
  // The run record, per company. A company whose switch, stop or pause changed mid-run is refused by the database.
  await withTenant(agent,async tx=>{
   const [open]=await tx.select({n:count()}).from(payrollAuditFinding).where(and(eq(payrollAuditFinding.tenantId,options.tenantId),eq(payrollAuditFinding.companyId,companyId),
    notExists(tx.select({id:payrollAuditDisposition.id}).from(payrollAuditDisposition).where(and(eq(payrollAuditDisposition.tenantId,payrollAuditFinding.tenantId),
     eq(payrollAuditDisposition.findingId,payrollAuditFinding.id))))));
   await tx.insert(terasLoopRun).values({tenantId:options.tenantId,runId,workerId,companyId,status,sponsorUserId,loopVersion:AUDIT_LOOP_VERSION,startedAt:companyStarted,
    finishedAt:new Date(Math.max(Date.now(),companyStarted.getTime())),observed,opened,reopened:0,closed:0,openNow:Number(open?.n??0),waitingNow:0,capped:false,
    checks:status==='ran'?checks:[...checks,check('owner_read',AUDIT_LOOP_VERSION,false)],reads:status==='ran'?[...READS]:[]});
  }).catch(()=>{failed++;});
 }
 return Object.freeze({workerId,status:'ran' as const,runId,companies:companies.length,captured,findingsOpened,failed});
}
