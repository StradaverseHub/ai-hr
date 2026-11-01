/** ADR-0170 §3.10, step 5a — work-job mandates: grant, renew, revoke, the two keys and the stop switch.
 *
 * Off by default. Two keys: a group administrator enables a job type, with ceilings (key 1, default none
 * enabled); then a person delegates within it (key 2). A person delegates only what they can do now, as
 * themself; every mandate is bounded (scope, limits, validity up to the tenant ceiling and a hard year, a
 * notification choice) and revocable at once by its grantor or a group administrator. A tenant-wide stop
 * switch closes granting and running. One agent identity per mandate, generated at grant.
 *
 * The database enforces the same rules (migration 0890 policies and the mandate guard trigger): a grant
 * without both keys, an edit other than revocation or renewal, or a delete is refused there as well.
 * Every change appends an audit event. Running a mandate lives in ./run.ts. Not imported by the production
 * Assistant; no screen is wired in this step. */
import {and,desc,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {terasMandate,terasMandateControl,terasMandateJobTypeEnablement} from '../../db/teras-schema';
import {hasTeamAccess,isGroupAdmin} from '../../lib/authz-model';
import {MandateRefused,WORK_JOB_TYPES,delegableJobType,type MandateLimits,type MandateSchedule,type MandateScope,type WorkJobType} from './job-types';

export {MandateRefused} from './job-types';
export const MAX_VALIDITY_DAYS=365;
const DAY_MS=86_400_000;
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const intIn=(value:unknown,min:number,max:number)=>typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max;
function requireGroupAdmin(ctx:SessionContext){if(!ctx.userId||ctx.agent||!isGroupAdmin(ctx))throw new MandateRefused('not_administrator');}

/** Whether the person holds, right now, the authority a job type needs. Used at grant and at every run. */
export function holdsJobAuthority(ctx:SessionContext,jobType:WorkJobType):boolean{
 const job=WORK_JOB_TYPES[jobType];
 if(!ctx.userId||!ctx.personId||ctx.agent)return false;
 return job.requires==='team_manager'&&hasTeamAccess(ctx);
}

// ── Key 1 and the stop switch (group administrators) ──

export async function setJobTypeEnablement(supplied:SessionContext,input:Readonly<{jobType:unknown;enabled:boolean;maxValidityDays?:number;maxRunsPerDay?:number}>){
 const ctx=capture(supplied);requireGroupAdmin(ctx);
 const jobType=delegableJobType(input.jobType);
 const maxValidityDays=input.maxValidityDays??90,maxRunsPerDay=input.maxRunsPerDay??1;
 if(typeof input.enabled!=='boolean'||!intIn(maxValidityDays,1,MAX_VALIDITY_DAYS)||!intIn(maxRunsPerDay,1,24))throw new MandateRefused('invalid');
 return withTenant(ctx,async tx=>{
  const values={enabled:input.enabled,maxValidityDays,maxRunsPerDay,changedByUserId:ctx.userId!,changedAt:sql`now()`};
  const [row]=await tx.insert(terasMandateJobTypeEnablement).values({tenantId:ctx.tenantId,jobType,...values})
   .onConflictDoUpdate({target:[terasMandateJobTypeEnablement.tenantId,terasMandateJobTypeEnablement.jobType],set:values}).returning();
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-mandate-job-type',aggregateId:ctx.tenantId,
   eventType:input.enabled?'teras-mandate.job-type-enabled':'teras-mandate.job-type-disabled',actor:actorOf(ctx),
   payload:{jobType,maxValidityDays,maxRunsPerDay,version:row.version}});
  return Object.freeze(row);
 });
}

export async function setMandateStopSwitch(supplied:SessionContext,stopped:boolean){
 const ctx=capture(supplied);requireGroupAdmin(ctx);
 if(typeof stopped!=='boolean')throw new MandateRefused('invalid');
 return withTenant(ctx,async tx=>{
  const values={stopped,changedByUserId:ctx.userId!,changedAt:sql`now()`};
  const [row]=await tx.insert(terasMandateControl).values({tenantId:ctx.tenantId,...values})
   .onConflictDoUpdate({target:terasMandateControl.tenantId,set:values}).returning();
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-mandate-control',aggregateId:ctx.tenantId,
   eventType:stopped?'teras-mandate.stopped':'teras-mandate.resumed',actor:actorOf(ctx),payload:{version:row.version}});
  return Object.freeze(row);
 });
}

export async function readMandateKeysTx(tx:Tx,tenantId:string,jobType:WorkJobType){
 const [enablement]=await tx.select().from(terasMandateJobTypeEnablement)
  .where(and(eq(terasMandateJobTypeEnablement.tenantId,tenantId),eq(terasMandateJobTypeEnablement.jobType,jobType))).limit(1);
 const [control]=await tx.select().from(terasMandateControl).where(eq(terasMandateControl.tenantId,tenantId)).limit(1);
 return{enablement:enablement??null,control:control??null};
}

// ── Key 2: a person delegates ──

export type GrantMandateInput=Readonly<{jobType:unknown;scope:unknown;limits:unknown;schedule:unknown;notify:unknown;validDays:unknown}>;
function parseGrant(jobType:WorkJobType,input:GrantMandateInput):Readonly<{scope:MandateScope;limits:MandateLimits;schedule:MandateSchedule;notify:'each_action'|'daily_summary';validDays:number}>{
 const job=WORK_JOB_TYPES[jobType];
 const scope=input.scope as Partial<MandateScope>|null,limits=input.limits as Partial<MandateLimits>|null,schedule=input.schedule as Partial<MandateSchedule>|null;
 if(!scope||typeof scope!=='object'||Object.keys(scope).length!==1||!job.scopes.includes(scope.team as MandateScope['team']))throw new MandateRefused('invalid');
 if(!limits||typeof limits!=='object'||Object.keys(limits).length!==2||!intIn(limits.maxRunsPerDay,1,24)||!intIn(limits.maxPeople,1,job.limits.maxPeople))throw new MandateRefused('invalid');
 if(!schedule||typeof schedule!=='object'||Object.keys(schedule).length!==1||!intIn(schedule.weekday,1,7))throw new MandateRefused('invalid');
 if(input.notify!=='each_action'&&input.notify!=='daily_summary')throw new MandateRefused('invalid');
 if(!intIn(input.validDays,1,MAX_VALIDITY_DAYS))throw new MandateRefused('invalid');
 return{scope:{team:scope.team!},limits:{maxRunsPerDay:limits.maxRunsPerDay!,maxPeople:limits.maxPeople!},schedule:{weekday:schedule.weekday!},
  notify:input.notify,validDays:input.validDays as number};
}

export async function grantMandate(supplied:SessionContext,input:GrantMandateInput,now:Date=new Date()){
 const ctx=capture(supplied);
 const jobType=delegableJobType(input.jobType);
 const grant=parseGrant(jobType,input);
 if(!holdsJobAuthority(ctx,jobType))throw new MandateRefused('no_authority');
 return withTenant(ctx,async tx=>{
  const {enablement,control}=await readMandateKeysTx(tx,ctx.tenantId,jobType);
  if(control?.stopped)throw new MandateRefused('stopped');
  if(!enablement?.enabled)throw new MandateRefused('not_enabled');
  if(grant.validDays>enablement.maxValidityDays||grant.limits.maxRunsPerDay>enablement.maxRunsPerDay)throw new MandateRefused('over_ceiling');
  const [row]=await tx.insert(terasMandate).values({tenantId:ctx.tenantId,jobType,grantorUserId:ctx.userId!,grantorPersonId:ctx.personId!,
   scope:grant.scope,limits:grant.limits,schedule:grant.schedule,notify:grant.notify,
   validFrom:now,validUntil:new Date(now.getTime()+grant.validDays*DAY_MS)}).returning();
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-mandate',aggregateId:row.id,eventType:'teras-mandate.granted',actor:actorOf(ctx),
   payload:{jobType,version:row.version,agentIdentityId:row.agentIdentityId,validUntil:row.validUntil.toISOString(),scope:grant.scope,limits:grant.limits,
    schedule:grant.schedule,notify:grant.notify,enablementVersion:enablement.version}});
  return Object.freeze(row);
 });
}

async function loadOwnTx(tx:Tx,ctx:SessionContext,mandateId:string){
 if(typeof mandateId!=='string')throw new MandateRefused('invalid');
 const [row]=await tx.select().from(terasMandate).where(and(eq(terasMandate.tenantId,ctx.tenantId),eq(terasMandate.id,mandateId))).limit(1);
 if(!row)throw new MandateRefused('not_found');
 return row;
}

/** The grantor extends a valid mandate, within the tenant's current ceiling counted from now. */
export async function renewMandate(supplied:SessionContext,input:Readonly<{mandateId:string;validDays:unknown}>,now:Date=new Date()){
 const ctx=capture(supplied);
 if(!intIn(input.validDays,1,MAX_VALIDITY_DAYS))throw new MandateRefused('invalid');
 return withTenant(ctx,async tx=>{
  const mandate=await loadOwnTx(tx,ctx,input.mandateId);
  if(mandate.grantorUserId!==ctx.userId)throw new MandateRefused('not_grantor');
  if(mandate.revokedAt)throw new MandateRefused('revoked');
  if(mandate.validUntil<=now)throw new MandateRefused('expired');
  const jobType=delegableJobType(mandate.jobType);
  if(!holdsJobAuthority(ctx,jobType))throw new MandateRefused('no_authority');
  const {enablement,control}=await readMandateKeysTx(tx,ctx.tenantId,jobType);
  if(control?.stopped)throw new MandateRefused('stopped');
  if(!enablement?.enabled)throw new MandateRefused('not_enabled');
  if((input.validDays as number)>enablement.maxValidityDays)throw new MandateRefused('over_ceiling');
  const [row]=await tx.update(terasMandate).set({validUntil:new Date(now.getTime()+(input.validDays as number)*DAY_MS)})
   .where(and(eq(terasMandate.id,mandate.id),eq(terasMandate.version,mandate.version))).returning();
  if(!row)throw new MandateRefused('not_found');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-mandate',aggregateId:row.id,eventType:'teras-mandate.renewed',actor:actorOf(ctx),
   payload:{version:row.version,validUntil:row.validUntil.toISOString(),enablementVersion:enablement.version}});
  return Object.freeze(row);
 });
}

/** Revocation at once, by the grantor or a group administrator. Final: a revoked mandate never runs again. */
export async function revokeMandate(supplied:SessionContext,mandateId:string){
 const ctx=capture(supplied);
 if(!ctx.userId||ctx.agent)throw new MandateRefused('invalid');
 return withTenant(ctx,async tx=>{
  const mandate=await loadOwnTx(tx,ctx,mandateId);
  if(mandate.revokedAt)throw new MandateRefused('revoked');
  const by=mandate.grantorUserId===ctx.userId?'grantor' as const:isGroupAdmin(ctx)?'administrator' as const:null;
  if(!by)throw new MandateRefused('not_grantor');
  const [row]=await tx.update(terasMandate).set({revokedAt:sql`now()`,revokedByUserId:ctx.userId!,revokedBy:by})
   .where(and(eq(terasMandate.id,mandate.id),eq(terasMandate.version,mandate.version))).returning();
  if(!row)throw new MandateRefused('not_found');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-mandate',aggregateId:row.id,eventType:'teras-mandate.revoked',actor:actorOf(ctx),
   payload:{version:row.version,revokedBy:by}});
  return Object.freeze(row);
 });
}

/** The caller's own mandates, or every mandate in the tenant for a group administrator (RLS decides). */
export function listMandates(supplied:SessionContext){
 const ctx=capture(supplied);
 return withTenant(ctx,tx=>tx.select().from(terasMandate).where(eq(terasMandate.tenantId,ctx.tenantId)).orderBy(desc(terasMandate.createdAt),desc(terasMandate.id)));
}

export type MandateState='active'|'revoked'|'expired'|'not_started';
export function mandateState(mandate:Readonly<{revokedAt:Date|null;validFrom:Date;validUntil:Date}>,now:Date):MandateState{
 if(mandate.revokedAt)return'revoked';
 if(now<mandate.validFrom)return'not_started';
 return now<mandate.validUntil?'active':'expired';
}
export const mandateAgentIdentity=(mandate:Readonly<{agentIdentityId:string}>)=>`mandate-agent:${mandate.agentIdentityId}`;
