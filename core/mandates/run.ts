/** ADR-0170 §3.10 and §3.13, step 5a — one run of a work-job mandate, under the tenant's agent principal.
 *
 * The run is the agent acting FOR the grantor, never AS them:
 *  1. As the agent principal (core/agent-principal.ts; no login, no grant), it loads the mandate and both
 *     keys and checks, in code: the stop switch, the job type enabled (key 1), the job type delegable, the
 *     mandate in force (not revoked, within validity), and the run limit for today.
 *  2. It resolves the grantor's CURRENT authority from the database (app.principal, app.login_blocked), never
 *     from the mandate or a cached session, and requires the job's authority there (§3.10 rule 3). A grantor
 *     who lost the role, was archived or blocked stops the mandate.
 *  3. The job reads through the native owners under that current authority, narrowed by the mandate's scope
 *     and limits: the intersection, never more than either.
 *  4. Every run, including a stopped one, writes an outcome record as the agent principal, naming the
 *     mandate id and version, the grantor and the mandate's own agent identity. The record is written only if
 *     the mandate is still the same version at write time; a revocation in between turns the run into a
 *     stopped one and the prepared result is discarded.
 * Work jobs complete nothing, so a run's human involvement is "none" and its result is "prepared" for the
 * grantor to read. Not scheduled or wired in this step; the scheduler supplies the principal. */
import {createHash} from 'node:crypto';
import {and,count,eq,gte,sql} from 'drizzle-orm';
import {withTenant,type Grant,type SessionContext,type Tx} from '../../db/client';
import {terasMandate,terasOutcomeRecord} from '../../db/teras-schema';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {agentContext} from '../agent-principal';
import type {EntitlementSnapshot} from '../entitlement-types';
import {newRunId,writeOutcomeRecordTx,type OutcomeCheck} from '../outcome-record/record';
import {MandateRefused,WORK_JOB_TYPES,WORK_JOB_TYPES_VERSION,delegableJobType,type WorkJobType} from './job-types';
import {holdsJobAuthority,mandateAgentIdentity,mandateState,readMandateKeysTx} from './mandates';
import {teamAbsenceWeeklySummary,type TeamAbsenceSummary,type WorkJobResult} from './team-absence-summary';
import {dailyDigestJob} from '../digest/daily-digest';

export type MandateRunOptions=Readonly<{tenantId:string;principalId:string;entitlements:EntitlementSnapshot;mandateId:string;now?:Date}>;
/** `S` is the prepared result of the mandate's job type: the team summary by default, the digest for
 * `daily_digest` (core/digest/daily-digest.ts runDailyDigestMandate narrows it by job type). */
export type MandateRunResult<S=TeamAbsenceSummary>=Readonly<{status:'prepared';recordId:string;runId:string;summary:S}>
 |Readonly<{status:'stopped';recordId:string;runId:string;failed:readonly string[]}>;

const JOBS:Record<WorkJobType,(grantor:SessionContext,mandate:typeof terasMandate.$inferSelect,now:Date)=>Promise<WorkJobResult<unknown>>>={
 team_absence_weekly_summary:(grantor,mandate,now)=>teamAbsenceWeeklySummary(grantor,mandate,now),
 daily_digest:(grantor,mandate,now)=>dailyDigestJob(grantor,mandate,now),
};
const OWNER='core/mandates/run.ts#runMandate';
/** A fingerprint of the grantor's roles and grants as resolved for this run, for the record; never the grants. */
const authorityFingerprint=(ctx:SessionContext)=>createHash('sha256').update(JSON.stringify([ctx.tenantId,ctx.userId,ctx.personId,
 [...(ctx.grants??[])].map(grant=>grant.role+'@'+(grant.companyId??'*')).sort()])).digest('hex').slice(0,16);
const check=(name:string,ruleVersion:string|null,ok:boolean):OutcomeCheck=>({check:name,owner:OWNER,ruleVersion,result:ok?'pass':'fail'});

/** The grantor's authority now, from the database. Null when the login is gone, archived or blocked. */
async function currentGrantorTx(tx:Tx,tenantId:string,userId:string,entitlements:EntitlementSnapshot):Promise<SessionContext|null>{
 const [principal]=await tx.execute(sql`select p.tenant_id,p.person_id,p.grants,app.login_blocked(${userId}::uuid) as blocked from app.principal(${userId}::uuid) p`) as unknown as
  {tenant_id:string;person_id:string|null;grants:Grant[]|null;blocked:boolean}[];
 if(!principal||principal.tenant_id!==tenantId||principal.blocked||!principal.person_id)return null;
 const grants=(principal.grants??[]).map(grant=>({role:grant.role,companyId:grant.companyId??null}));
 return{tenantId,userId,personId:principal.person_id,grants,roles:[...new Set(grants.map(grant=>grant.role))],entitlements};
}

async function stateTx(tx:Tx,tenantId:string,mandateId:string,now:Date){
 const [mandate]=await tx.select().from(terasMandate).where(and(eq(terasMandate.tenantId,tenantId),eq(terasMandate.id,mandateId))).limit(1);
 if(!mandate)throw new MandateRefused('not_found');
 let jobType:WorkJobType|null=null;try{jobType=delegableJobType(mandate.jobType);}catch{jobType=null;}
 const keys=jobType?await readMandateKeysTx(tx,tenantId,jobType):{enablement:null,control:null};
 // The HR day (Asia/Kuala_Lumpur, fixed UTC+08:00) that `now` falls in.
 const dayStart=new Date(todayInKualaLumpur(now)+'T00:00:00+08:00');
 const [runs]=await tx.select({n:count()}).from(terasOutcomeRecord).where(and(eq(terasOutcomeRecord.tenantId,tenantId),
  eq(terasOutcomeRecord.mandateId,mandateId),gte(terasOutcomeRecord.startedAt,dayStart)));
 const runLimit=Math.min(mandate.limits.maxRunsPerDay,keys.enablement?.maxRunsPerDay??0);
 const checks:OutcomeCheck[]=[
  check('stop_switch',keys.control?`teras_mandate_control@v${keys.control.version}`:'teras_mandate_control:none',!keys.control?.stopped),
  check('job_type_delegable',WORK_JOB_TYPES_VERSION,jobType!==null),
  check('job_type_enabled',keys.enablement?`teras_mandate_job_type:${mandate.jobType}@v${keys.enablement.version}`:null,keys.enablement?.enabled===true),
  check('mandate_in_force',`teras_mandate:${mandate.id}@v${mandate.version}`,mandateState(mandate,now)==='active'),
  check('run_limit',keys.enablement?`teras_mandate_job_type:${mandate.jobType}@v${keys.enablement.version}`:null,(runs?.n??0)<runLimit),
 ];
 return{mandate,jobType,checks};
}

export async function runMandate<S=TeamAbsenceSummary>(options:MandateRunOptions):Promise<MandateRunResult<S>>{
 const now=options.now??new Date(),realStart=Date.now(),runId=newRunId();
 const agent=agentContext(options.tenantId,options.principalId,options.entitlements);
 // 1 and 2: the mandate, both keys and the grantor's current authority, read as the agent.
 const first=await withTenant(agent,async tx=>{
  const state=await stateTx(tx,options.tenantId,options.mandateId,now);
  const grantor=await currentGrantorTx(tx,options.tenantId,state.mandate.grantorUserId,options.entitlements);
  const authorised=!!grantor&&grantor.personId===state.mandate.grantorPersonId&&state.jobType!==null&&holdsJobAuthority(grantor,state.jobType);
  return{...state,grantor:authorised?grantor:null,
   checks:[...state.checks,check('grantor_authority',grantor?`authority:${authorityFingerprint(grantor)}`:null,authorised)]};
 });
 const failed=first.checks.filter(item=>item.result!=='pass').map(item=>item.check);
 // 3: the job, under the grantor's current authority narrowed by the mandate. A refusal by an owner is a stop.
 let result:WorkJobResult<unknown>|null=null;
 if(!failed.length&&first.grantor&&first.jobType){
  try{result=await JOBS[first.jobType](first.grantor,first.mandate,now);}catch{failed.push('job_refused');}
 }
 // 4: the outcome record, only against the same mandate version.
 return withTenant(agent,async tx=>{
  const again=await stateTx(tx,options.tenantId,options.mandateId,now);
  // Only a run that passed its checks can be overtaken: a revocation, renewal or switch change since then.
  const changed=again.mandate.version!==first.mandate.version||again.checks.some(item=>item.check!=='run_limit'&&item.result!=='pass');
  if(result&&!failed.length&&changed)failed.push('mandate_changed');
  const stopped=failed.length>0||!result;
  const job=first.jobType?WORK_JOB_TYPES[first.jobType]:null;
  const record=await writeOutcomeRecordTx(tx,agent,{
   runId,runKind:'mandate_run',startedAt:now,finishedAt:new Date(now.getTime()+Math.max(0,Date.now()-realStart)),
   authority:{kind:'mandate',mandateId:again.mandate.id,mandateVersion:again.mandate.version,grantorUserId:again.mandate.grantorUserId},
   agentIdentity:mandateAgentIdentity(again.mandate),
   reads:stopped?[]:[...result!.reads],
   checks:[...first.checks,...(stopped?[]:result!.checks)],
   replay:{model:null,provider:null,instructionSet:WORK_JOB_TYPES_VERSION,specVersion:null,specDigest:null,toolCatalogue:null},
   outcomeKind:stopped?'stopped':'prepared',
   outcome:stopped?{jobType:again.mandate.jobType,failed}:{jobType:again.mandate.jobType,...result!.outcome},
   humanInvolvement:'none',
   notice:stopped||!job?'not_applicable':job.notice,
  });
  return stopped?Object.freeze({status:'stopped' as const,recordId:record.id,runId,failed:Object.freeze([...failed])})
   :Object.freeze({status:'prepared' as const,recordId:record.id,runId,summary:result!.summary as S});
 });
}
