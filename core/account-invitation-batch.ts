/**
 * Board 0735d1b7 — Security Center › Users › By Batch Send Invitation, web side: who can receive an invitation, the
 * admission of a batch, the retry of its failed emails and the batch's results. The worker side, which sends the
 * invitations one person at a time, is core/account-invitation-batch-job.ts.
 *
 * WHO: a group administrator only (the same people who invite one person today, core/auth.ts inviteUser). A
 * company-scoped administrator is refused here, and row security on person, app_invitation and bulk_job is the
 * backstop. A batch job is readable only by the administrator who started it (bulk_job row security).
 *
 * THE POPULATION (one set-based statement, no per-person loop): every person of the tenant who is Pending Activation
 * — no login, no pending invitation, no manual account setup in progress, and not a leaver (the activation candidate
 * rule of core/employee-user-activation.ts, written in SQL as app.login_blocked_on does for logins). Each person is
 * eligible unless the work email is blank ('noEmail') or another person already has a login or an invitation with
 * that email ('emailInUse', the 5e0b2154 rule). The list pages by key (lib/pagination.ts) with a capped count; the
 * eligible count used by "Select all" is bounded at the batch cap.
 *
 * ADMISSION freezes the population on the server: "Select all" means every eligible person matching the search at
 * the moment of admission, never the page the browser showed; ticked ids are intersected with the eligible set. The
 * administrator confirmed a number, so a different number refuses ('countChanged') and the screen shows the new one.
 * Everyone is re-checked again when the worker reaches them; sending an invitation never creates or enables a login.
 */
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {emailLocale as emailLocaleSchema} from '../lib/email-design/model';
import {cappedTotal,keysetReadLimit,keysetSlice,listCountCap,type KeysetPageQuery,type KeysetRead} from '../lib/pagination';
import {uuidArrayParam} from '../db/sql-arrays';
import {ROLES} from './auth';
import {bulkJobProgress,bulkJobTx,enqueueBulkJobTx,BulkJobError,listBulkJobsTx} from './bulk-job';
import {manualSetupPersonIdsTx} from './manual-identity-setup';
import type {BulkJobProgress} from '../lib/bulk-job';

export const ACCOUNT_INVITATION_BATCH_JOB='account_invitation_batch';
/** At most this many people in one batch (the job input stays under the kind's 256 KB input bound). */
export const INVITATION_BATCH_MAX=5000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvitationBatchError extends Error{constructor(readonly code:'forbidden'|'invalid'|'countChanged'|'tooMany'|'empty'|'nothingToRetry'|'running'|'installing'|'unavailable',readonly count?:number){super(code);this.name='InvitationBatchError';}}

/** Same rule as core/auth.ts assertGroupAdmin: a group-wide hr_admin or a super_admin (a roles-only test context is
 * group-wide). */
function assertGroupAdmin(ctx:SessionContext){
 const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null as string|null}));
 if(!ctx.userId||!grants.some(g=>g.role==='super_admin'||(g.role==='hr_admin'&&g.companyId==null)))throw new InvitationBatchError('forbidden');
}

/** A kernel refusal as this screen's code: another batch is running (one per tenant), or the worker is mid-upgrade. */
function admissionError(error:unknown){
 if(error instanceof BulkJobError&&error.status===409)return new InvitationBatchError('running');
 if(error instanceof BulkJobError&&error.status===503)return new InvitationBatchError('installing');
 return error;
}

export type BatchCandidateIneligible='noEmail'|'emailInUse';
export type BatchCandidate={id:string;name:string;email:string;employeeCode:string|null;ineligible:BatchCandidateIneligible|null};

const likeOf=(search:string)=>`%${search.replace(/[\\%_]/g,m=>`\\${m}`)}%`;
export function normalizeBatchSearch(raw:unknown){return typeof raw==='string'?raw.trim().slice(0,100):'';}

/** The shared FROM/WHERE of the population (persons p) with the in-use emails (held h). */
function population(ctx:SessionContext,setup:readonly string[],search:string):{held:SQL;from:SQL;eligible:SQL;ineligible:SQL}{
 const held=sql`held as materialized (
  select lower(i.email) as email,i.person_id from app_invitation i where i.tenant_id=${ctx.tenantId}::uuid and i.status in ('pending','accepted')
  union all
  select lower(trim(q.primary_email)),q.id from app_user u join person q on q.id=u.person_id and q.tenant_id=u.tenant_id
   where u.tenant_id=${ctx.tenantId}::uuid and coalesce(trim(q.primary_email),'')<>'')`;
 const q=search?likeOf(search):null;
 const from=sql`from person p where p.tenant_id=${ctx.tenantId}::uuid
  and not exists(select 1 from app_user u where u.tenant_id=p.tenant_id and u.person_id=p.id)
  and not exists(select 1 from app_invitation i where i.tenant_id=p.tenant_id and i.person_id=p.id and i.status='pending')
  ${setup.length?sql`and not (p.id = any(${uuidArrayParam(setup)}))`:sql``}
  and (not exists(select 1 from employment e where e.tenant_id=p.tenant_id and e.person_id=p.id)
   or exists(select 1 from employment e where e.tenant_id=p.tenant_id and e.person_id=p.id and e.blacklisted_at is null
    and (least(e.resignation_date,e.last_working_date,e.terminated_on) is null or current_date<=least(e.resignation_date,e.last_working_date,e.terminated_on))))
  ${q?sql`and (p.full_name ilike ${q} or p.primary_email ilike ${q}
   or exists(select 1 from employment e where e.tenant_id=p.tenant_id and e.person_id=p.id and e.employee_code ilike ${q}))`:sql``}`;
 const ineligible=sql`case when coalesce(trim(p.primary_email),'') not like '%_@_%' then 'noEmail'
  when exists(select 1 from held h where h.email=lower(trim(p.primary_email)) and h.person_id is distinct from p.id) then 'emailInUse' end`;
 const eligible=sql`coalesce(trim(p.primary_email),'') like '%_@_%' and not exists(select 1 from held h where h.email=lower(trim(p.primary_email)) and h.person_id is distinct from p.id)`;
 return {held,from,eligible,ineligible};
}

export type BatchCandidatesPage={rows:BatchCandidate[];eligible:{count:number;capped:boolean}}&KeysetRead;

/** One keyset page of Pending Activation people, the list's capped total and the bounded eligible count ("Select
 * all"). Read only, no lock: three statements (manual setup proof and list, the page, both counts). */
export async function readInvitationBatchCandidates(ctx:SessionContext,input:{search?:string;page:Pick<KeysetPageQuery,'limit'|'after'|'before'|'last'|'exactCount'|'size'>}):Promise<BatchCandidatesPage>{
 assertGroupAdmin(ctx);
 const search=normalizeBatchSearch(input.search);
 return withTenant(ctx,async tx=>{
  const setup=await manualSetupPersonIdsTx(tx,ctx);
  const {held,from,ineligible,eligible}=population(ctx,setup,search);
  const anchor=(id:string)=>sql`(select a.full_name,a.id from person a where a.id=${id}::uuid and a.tenant_id=${ctx.tenantId}::uuid)`;
  const read=async(cursor:Pick<KeysetPageQuery,'after'|'before'|'last'>)=>{
   const backwards=cursor.before!==undefined||cursor.last;
   const seek=cursor.after?sql`and (p.full_name,p.id) > ${anchor(cursor.after)}`:cursor.before?sql`and (p.full_name,p.id) < ${anchor(cursor.before)}`:sql``;
   return [...await tx.execute<{id:string;name:string;email:string;employee_code:string|null;ineligible:BatchCandidateIneligible|null}>(sql`with ${held}
    select p.id,p.full_name as name,p.primary_email as email,
     (select min(e.employee_code) from employment e where e.tenant_id=p.tenant_id and e.person_id=p.id) as employee_code,${ineligible} as ineligible
    ${from} ${seek} order by ${backwards?sql`p.full_name desc,p.id desc`:sql`p.full_name,p.id`} limit ${keysetReadLimit(input.page)}`)];
  };
  const cursor={after:input.page.after,before:input.page.before,last:input.page.last};
  let fetched=await read(cursor),anchorFound=true;
  if(fetched.length===0&&(cursor.after||cursor.before)){anchorFound=false;fetched=await read({last:false});}
  const page=keysetSlice(fetched,{...(anchorFound?cursor:{last:false}),limit:input.page.limit},anchorFound);
  const cap=listCountCap(input.page.size);
  const [counted]=await tx.execute<{total:number;eligible:number}>(sql`with ${held} select
   (select count(*)::int from (select 1 ${from} ${input.page.exactCount?sql``:sql`limit ${cap+1}`}) t) as total,
   (select count(*)::int from (select 1 ${from} and ${eligible} limit ${INVITATION_BATCH_MAX+1}) e) as eligible`);
  const eligibleSeen=Number(counted?.eligible??0);
  return {rows:page.rows.map(r=>({id:r.id,name:r.name,email:r.email,employeeCode:r.employee_code,ineligible:r.ineligible})),
   total:cappedTotal(Number(counted?.total??0),cap,input.page.exactCount),hasPrev:page.hasPrev,hasNext:page.hasNext,anchorFound,
   eligible:eligibleSeen>INVITATION_BATCH_MAX?{count:INVITATION_BATCH_MAX,capped:true}:{count:eligibleSeen,capped:false}};
 },{readOnlySnapshot:true});
}

export type StartInvitationBatchInput={selection:'ids'|'all';personIds?:readonly string[];search?:string;role:string;companyId:string|null;emailLocale:string;expectedCount:number;operationKey?:string};

/** The eligible people among `ids` (or every eligible person matching `search`), in list order. */
async function resolveEligibleTx(tx:Tx,ctx:SessionContext,selection:'ids'|'all',ids:readonly string[],search:string){
 const setup=await manualSetupPersonIdsTx(tx,ctx);
 const {held,from,eligible}=population(ctx,setup,selection==='all'?search:'');
 return [...await tx.execute<{id:string}>(sql`with ${held} select p.id ${from} and ${eligible}
  ${selection==='ids'?sql`and p.id = any(${uuidArrayParam(ids)})`:sql``} order by p.full_name,p.id limit ${INVITATION_BATCH_MAX+1}`)].map(r=>r.id);
}

/** Admit a batch: one transaction, group administrator, the population resolved and frozen here, one active batch per
 * tenant (the kind is tenant-exclusive). Returns the job id and how many posted ids were dropped as no longer eligible. */
export async function startInvitationBatch(ctx:SessionContext,input:StartInvitationBatchInput):Promise<{jobId:string;count:number;dropped:number;existing:boolean}>{
 assertGroupAdmin(ctx);
 if(input.selection!=='ids'&&input.selection!=='all')throw new InvitationBatchError('invalid');
 if(!ROLES.has(input.role))throw new InvitationBatchError('invalid');
 const companyId=input.companyId&&input.companyId!=='group'?input.companyId:null;
 if(companyId&&!UUID.test(companyId))throw new InvitationBatchError('invalid');
 if(input.role==='super_admin'&&companyId)throw new InvitationBatchError('invalid');
 const locale=emailLocaleSchema.safeParse(input.emailLocale);if(!locale.success)throw new InvitationBatchError('invalid');
 const expected=Number(input.expectedCount);
 if(!Number.isSafeInteger(expected)||expected<1)throw new InvitationBatchError('empty');
 if(expected>INVITATION_BATCH_MAX)throw new InvitationBatchError('tooMany',INVITATION_BATCH_MAX);
 const posted=input.selection==='ids'?[...new Set(input.personIds??[])]:[];
 if(input.selection==='ids'){
  if(posted.length>INVITATION_BATCH_MAX)throw new InvitationBatchError('tooMany',INVITATION_BATCH_MAX);
  if(posted.some(id=>!UUID.test(id)))throw new InvitationBatchError('invalid');
  // The human confirmed the number of people they ticked.
  if(posted.length!==expected)throw new InvitationBatchError('countChanged',posted.length);
 }
 return withTenant(ctx,async tx=>{
  if(companyId){
   const [found]=await tx.execute<{id:string}>(sql`select id from company where id=${companyId}::uuid and tenant_id=${ctx.tenantId}::uuid`);
   if(!found)throw new InvitationBatchError('invalid');
  }
  const ids=await resolveEligibleTx(tx,ctx,input.selection,posted,normalizeBatchSearch(input.search));
  if(ids.length>INVITATION_BATCH_MAX)throw new InvitationBatchError('tooMany',INVITATION_BATCH_MAX);
  if(!ids.length)throw new InvitationBatchError('empty');
  // "Select all": the eligible population changed since the screen counted it, so the administrator is told the new
  // number before anything starts. Ticked ids: anyone who stopped being eligible since the page was drawn is dropped
  // here (never invited) and the admission says how many.
  if(input.selection==='all'&&ids.length!==expected)throw new InvitationBatchError('countChanged',ids.length);
  try{
   const {row,existing}=await enqueueBulkJobTx(tx,ctx,{kind:ACCOUNT_INVITATION_BATCH_JOB,operationKey:input.operationKey,
    input:{mode:'send',personIds:ids,role:input.role,emailLocale:locale.data,...(companyId?{companyId}:{})}});
   return {jobId:row.id,count:ids.length,dropped:input.selection==='ids'?posted.length-ids.length:0,existing};
  }catch(error){throw admissionError(error);}
 });
}

export type InvitationOutcome='sent'|'failed'|'skipped'|'uncertain';
/** One person's line in a finished batch (stored on the job's result by the worker's finalize; no token, no email). */
export type StoredInvitationOutcome={p:string|null;o:InvitationOutcome;r:string|null;d:string|null};
export type InvitationBatchResult={mode:'send'|'retry';role:string|null;companyId:string|null;emailLocale:string|null;
 counts:Record<InvitationOutcome,number>;outcomes:StoredInvitationOutcome[]};

export function isInvitationBatchResult(value:unknown):value is InvitationBatchResult{
 const v=value as Partial<InvitationBatchResult>|null;return !!v&&typeof v==='object'&&Array.isArray(v.outcomes)&&!!v.counts;
}

/** Retry only the failed emails of one of the caller's finished batches, as a new job. The failed deliveries are read
 * again (still failed, an invitation email, not already retried); each step reissues through retryAccountEmail. */
export async function startInvitationBatchRetry(ctx:SessionContext,input:{jobId:string;operationKey?:string}):Promise<{jobId:string;count:number}>{
 assertGroupAdmin(ctx);
 if(!UUID.test(input.jobId))throw new InvitationBatchError('unavailable');
 return withTenant(ctx,async tx=>{
  const job=await bulkJobTx(tx,input.jobId,{kind:ACCOUNT_INVITATION_BATCH_JOB}).catch(()=>{throw new InvitationBatchError('unavailable');});
  if(!['completed','failed','cancelled'].includes(job.state)||!isInvitationBatchResult(job.result))throw new InvitationBatchError('nothingToRetry');
  const failed=job.result.outcomes.filter(o=>o.o==='failed'&&o.d&&UUID.test(o.d)).map(o=>o.d!);
  if(!failed.length)throw new InvitationBatchError('nothingToRetry');
  const retryable=[...await tx.execute<{id:string}>(sql`select d.id from account_email_delivery d where d.tenant_id=${ctx.tenantId}::uuid
   and d.id = any(${uuidArrayParam(failed)}) and d.kind='invitation' and d.status='failed'
   and not exists(select 1 from account_email_delivery r where r.replaces_delivery_id=d.id) order by d.created_at,d.id`)].map(r=>r.id);
  if(!retryable.length)throw new InvitationBatchError('nothingToRetry');
  try{
   const {row}=await enqueueBulkJobTx(tx,ctx,{kind:ACCOUNT_INVITATION_BATCH_JOB,operationKey:input.operationKey,input:{mode:'retry',deliveryIds:retryable}});
   return {jobId:row.id,count:retryable.length};
  }catch(error){throw admissionError(error);}
 });
}

export type InvitationBatchLine={personId:string|null;name:string|null;employeeCode:string|null;outcome:InvitationOutcome;reason:string|null};
export type InvitationBatchView={job:BulkJobProgress;result:InvitationBatchResult|null;lines:InvitationBatchLine[];
 filter:InvitationOutcome|'all';hasNext:boolean;nextAfter:string|null;canRetry:boolean};
const RESULT_PAGE=50;

/** One batch of the caller's (bulk_job row security: its creator only), with one page of its per-person results
 * filtered by outcome. Names are read for the page's people only (one statement). Results follow the batch's order
 * (the list order at admission); `after` is the last shown person (or delivery) id. */
export async function readInvitationBatch(ctx:SessionContext,input:{jobId:string;outcome?:string;after?:string}):Promise<InvitationBatchView>{
 assertGroupAdmin(ctx);
 if(!UUID.test(input.jobId))throw new InvitationBatchError('unavailable');
 const filter=(['sent','failed','skipped','uncertain'] as const).find(o=>o===input.outcome)??'all';
 return withTenant(ctx,async tx=>{
  const job=await bulkJobTx(tx,input.jobId,{kind:ACCOUNT_INVITATION_BATCH_JOB}).catch(()=>{throw new InvitationBatchError('unavailable');});
  const result=isInvitationBatchResult(job.result)?job.result:null;
  const wanted=(result?.outcomes??[]).filter(o=>filter==='all'||o.o===filter);
  const key=(o:StoredInvitationOutcome)=>o.p??o.d??'';
  const start=input.after&&UUID.test(input.after)?wanted.findIndex(o=>key(o)===input.after)+1:0;
  const shown=wanted.slice(start,start+RESULT_PAGE);
  const ids=[...new Set(shown.flatMap(o=>o.p&&UUID.test(o.p)?[o.p]:[]))];
  const people=new Map<string,{name:string;code:string|null}>();
  if(ids.length)for(const r of await tx.execute<{id:string;name:string;code:string|null}>(sql`select p.id,p.full_name as name,
   (select min(e.employee_code) from employment e where e.tenant_id=p.tenant_id and e.person_id=p.id) as code
   from person p where p.tenant_id=${ctx.tenantId}::uuid and p.id = any(${uuidArrayParam(ids)})`))people.set(r.id,{name:r.name,code:r.code});
  const lines=shown.map(o=>({personId:o.p,name:o.p?people.get(o.p)?.name??null:null,employeeCode:o.p?people.get(o.p)?.code??null:null,outcome:o.o,reason:o.r}));
  const last=shown.at(-1);
  return {job:bulkJobProgress(job),result,lines,filter,hasNext:start+RESULT_PAGE<wanted.length,nextAfter:last?key(last):null,
   canRetry:!!result&&['completed','failed','cancelled'].includes(job.state)&&result.outcomes.some(o=>o.o==='failed'&&o.d!==null)};
 },{readOnlySnapshot:true});
}

/** The caller's latest batch, so the list screen can point back to a batch still running. */
export async function latestInvitationBatch(ctx:SessionContext):Promise<BulkJobProgress|null>{
 assertGroupAdmin(ctx);
 return withTenant(ctx,async tx=>{const [row]=await listBulkJobsTx(tx,ctx,ACCOUNT_INVITATION_BATCH_JOB,1);return row?bulkJobProgress(row):null;},{readOnlySnapshot:true});
}
