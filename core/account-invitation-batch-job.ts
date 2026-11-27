/**
 * Board 0735d1b7 — the By Batch Send Invitation job ('account_invitation_batch', migration 7600) on the shared bulk-job
 * kernel. Admission and the results screen are core/account-invitation-batch.ts.
 *
 * ONE STEP PER PERSON (mode 'send', the person ids frozen at admission) or per failed delivery (mode 'retry'). Each
 * step uses the kernel's prepared-step form so that the email is never sent under a lock and never inside the
 * step's own transaction:
 *  1. the invitation transaction (core/auth.ts inviteActivationCandidate, or retryAccountEmail for a retry): the
 *     creator's current group administration, the exclusive Access lock for a few milliseconds, the person's
 *     eligibility checked again, the invitation, its delivery row and its audit event, committed together;
 *  2. the email attempt after that commit, outside every lock (core/account-email.ts attemptAccountEmail);
 *  3. the returned callback, the only write in the kernel's fenced step transaction, records the person's outcome:
 *     sent, failed with the delivery's error code, skipped with a reason code, or uncertain.
 * The raw invitation token exists only in this process between 1 and 2; it is never stored on the job.
 * Writing in step 1 (before the fenced callback) is deliberate: the token cannot be kept until a later transaction,
 * and every effect of step 1 is protected by its own native owner's checks, not by the job's lease. If the worker
 * dies or loses its lease after step 1, the step runs again; the person's pending invitation is found by its audit
 * event (it names this job) and reported as 'uncertain' with its delivery status. An uncertain email is shown, never
 * sent again automatically; the administrator can resend it from the account page or the email log.
 *
 * QUEUE BOUNDS (docs/architecture/FUTURE-BUILD-CONTRACT.md): at most INVITATION_BATCH_MAX (5,000) people per job and
 * a 256 KB input; one active batch per tenant (the kind is tenant-exclusive, bulk_job_one_active); one step per
 * chunk, so one invitation (and one email) at a time, which also paces the mail relay; the kernel's 60 s lease, its
 * bounded transient retries (a person that keeps failing transiently is recorded as failed after
 * TRANSIENT_STEP_LIMIT retries and the batch moves on) and its one-day notice window. Cancellation stops the steps
 * not yet started; an invitation already created stays (it is a normal pending invitation the administrator can
 * revoke). A failure of one person never stops the others ('per-step'). Sending an invitation never creates or
 * enables a login: each person stays Pending Activation until they activate their own account.
 */
import {sql} from 'drizzle-orm';
import {withTenant,type Tx} from '../db/client';
import {BulkJobAuthorityLost,type BulkJobPreparedStepHandler,type BulkJobStepOutcome} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';
import {inviteActivationCandidate,retryAccountEmail,type AuthProvider} from './auth';
import {ACCOUNT_INVITATION_BATCH_JOB,INVITATION_BATCH_MAX,isInvitationBatchResult,type InvitationBatchResult,type InvitationOutcome,type StoredInvitationOutcome} from './account-invitation-batch';

type SendInput={mode:'send';personIds:string[];role:string;companyId?:string;emailLocale:string};
type RetryInput={mode:'retry';deliveryIds:string[]};
/** A step carries its own settings, so it never depends on the plan being loaded with the claim. */
type Step={personId?:string;deliveryId?:string;role?:string;companyId?:string|null;emailLocale?:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSIENT_STEP_LIMIT=20;

/** A retry refusal the screen explains (the delivery cannot be retried any more) rather than a failed step. */
const RETRY_SKIPS:readonly [RegExp,string][]=[[/no longer pending/,'notPending'],[/already has a replacement/,'alreadyRetried'],[/cannot be retried/,'notRetryable']];

function inputOf(job:{input:unknown}):SendInput|RetryInput{
 const raw=job.input as {mode?:unknown;personIds?:string[];deliveryIds?:string[];role?:unknown;emailLocale?:unknown;companyId?:unknown}|null;
 if(raw?.mode==='send'&&Array.isArray(raw.personIds)&&typeof raw.role==='string'&&typeof raw.emailLocale==='string')
  return {mode:'send',personIds:raw.personIds,role:raw.role,emailLocale:raw.emailLocale,...(typeof raw.companyId==='string'?{companyId:raw.companyId}:{})};
 if(raw?.mode==='retry'&&Array.isArray(raw.deliveryIds))return {mode:'retry',deliveryIds:raw.deliveryIds};
 throw new Error('This invitation batch is not valid. Start it again.');
}

/** One read of the job's steps, in admission order (bounded by INVITATION_BATCH_MAX). A step that failed with an
 * unexpected error is recorded as failed with no delivery; steps never started (a stopped batch) are left out. */
async function batchResultTx(tx:Tx,job:BulkJobRow):Promise<InvitationBatchResult>{
 const rows=await tx.execute<{state:string;payload:Step;result:StoredInvitationOutcome|null}>(sql`
  select state,payload,result from bulk_job_step where job_id=${job.id}::uuid order by seq`);
 const counts:Record<InvitationOutcome,number>={sent:0,failed:0,skipped:0,uncertain:0};
 const outcomes:StoredInvitationOutcome[]=[];
 for(const row of rows){
  if(row.state==='pending')continue;
  const stored=row.state==='applied'&&row.result&&typeof row.result==='object'?row.result:null;
  const outcome:StoredInvitationOutcome=stored?{p:stored.p??null,o:stored.o,r:stored.r??null,d:stored.d??null}
   :{p:row.payload?.personId??null,o:'failed',r:'stepFailed',d:row.payload?.deliveryId??null};
  counts[outcome.o]+=1;outcomes.push(outcome);
 }
 const plan=job.plan as {mode?:'send'|'retry';role?:string|null;companyId?:string|null;emailLocale?:string|null}|null;
 return {mode:plan?.mode==='retry'?'retry':'send',role:plan?.role??null,companyId:plan?.companyId??null,emailLocale:plan?.emailLocale??null,counts,outcomes};
}

/** The handler, with an injectable email provider for tests; the worker registers accountInvitationBatchJobHandler. */
export function accountInvitationBatchHandler(provider?:AuthProvider):BulkJobPreparedStepHandler<Step>{
 return {
  kind:ACCOUNT_INVITATION_BATCH_JOB,mode:'per-step',transientStepLimit:TRANSIENT_STEP_LIMIT,
  phaseOf:()=>'invitations',
  // Identifiers only on a row error, never an email address or a token.
  stepRef:step=>step.payload.personId??step.payload.deliveryId??'',
  async prepare(_ctx,job){
   const input=inputOf(job);
   const ids=[...new Set(input.mode==='send'?input.personIds:input.deliveryIds)].filter(id=>typeof id==='string'&&UUID.test(id));
   if(!ids.length)return {refused:'This invitation batch has nobody to invite.'};
   if(ids.length>INVITATION_BATCH_MAX)return {refused:'This invitation batch is too large. Start it again with fewer people.'};
   const plan=input.mode==='send'?{mode:'send',role:input.role,companyId:input.companyId??null,emailLocale:input.emailLocale}:{mode:'retry',role:null,companyId:null,emailLocale:null};
   return {steps:ids.map((id,i)=>({kind:input.mode,rowNum:i+1,payload:input.mode==='send'
    ?{personId:id,role:input.role,companyId:input.companyId??null,emailLocale:input.emailLocale}:{deliveryId:id}})),plan,counters:{total:ids.length}};
  },
  async prepareStep(ctx,job,step){
   const record=(outcome:StoredInvitationOutcome)=>async():Promise<BulkJobStepOutcome>=>({result:outcome,counters:{[outcome.o]:1}});
   if(step.kind==='send'&&step.payload.personId){
    const personId=step.payload.personId,role=step.payload.role,emailLocale=step.payload.emailLocale;
    if(!role||!emailLocale)throw new Error('This invitation batch is not valid. Start it again.');
    const result=await inviteActivationCandidate(ctx,{personId,role,companyId:step.payload.companyId??null,emailLocale,batchJobId:job.id},provider);
    return record({p:personId,o:result.outcome,r:result.reason??null,d:result.deliveryId??null});
   }
   if(step.kind==='retry'&&step.payload.deliveryId){
    const deliveryId=step.payload.deliveryId;
    const [target]=await withTenant(ctx,tx=>tx.execute<{person_id:string|null}>(sql`select i.person_id from account_email_delivery d
     join app_invitation i on i.id=d.invitation_id where d.id=${deliveryId}::uuid and d.tenant_id=${ctx.tenantId}::uuid`));
    const personId=target?.person_id??null;
    let retried:Awaited<ReturnType<typeof retryAccountEmail>>;
    try{retried=await retryAccountEmail(ctx,deliveryId,true,undefined,provider);}
    catch(error){
     const message=error instanceof Error?error.message:'';
     const skip=RETRY_SKIPS.find(([pattern])=>pattern.test(message));
     if(skip)return record({p:personId,o:'skipped',r:skip[1],d:deliveryId});
     throw error;
    }
    if(!retried)return record({p:personId,o:'uncertain',r:null,d:deliveryId});
    const replacement=retried;
    let reason:string|null=null;
    if(replacement.outcome==='failed'){
     const [row]=await withTenant(ctx,tx=>tx.execute<{last_error:string|null}>(sql`select last_error from account_email_delivery where id=${replacement.deliveryId}::uuid`));
     reason=row?.last_error??null;
    }
    return record({p:personId,o:replacement.outcome,r:reason,d:replacement.deliveryId});
   }
   throw new Error('This invitation batch is not valid. Start it again.');
  },
  /** The kernel deletes the steps after the job ends, so the per-person outcomes are kept on the job's result. */
  async finalize(ctx,job){
   const result=await withTenant(ctx,tx=>batchResultTx(tx,job));
   return {result,counters:result.counts};
  },
  /** A batch stopped at the creator's request (or failed) does not finalize: its outcomes so far are kept here, before
   * the kernel deletes the steps. Idempotent (a result already written is kept); fenced on the job's lease. */
  async settle(ctx,job,unit){
   if(job.state==='completed'||!ctx||isInvitationBatchResult(job.result))return;
   await withTenant(ctx,async tx=>{
    try{await unit.fenceTx(tx);}catch(error){if(error instanceof BulkJobAuthorityLost)return;throw error;}
    await unit.set(tx,{result:await batchResultTx(tx,job)});
   });
  },
 };
}
export const accountInvitationBatchJobHandler=accountInvitationBatchHandler();
