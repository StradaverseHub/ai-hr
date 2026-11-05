/** ADR-0170 §3.13 Preparers, step 5 — the daily digest: what is waiting for one person today.
 *
 * Built only from existing owners, as the person (for a mandate run: under their freshly resolved authority,
 * core/mandates/run.ts):
 *  - approvals waiting: the approvals inbox (core/approvals-inbox.ts listPendingTasks), counted by kind;
 *  - setup gaps, for administrators: the go-live co-pilot's stages (core/setup-copilot/copilot.ts) across the
 *    companies the database says they administer (app.is_admin_for), counted as blocked or attention;
 *  - deadlines, for administrators: the statutory notification worklist (core/reporting.ts complianceWorklist),
 *    counted as overdue or due within seven days.
 * Output is counts and links only: no name, no item, nothing about another person beyond the counts the inbox
 * already shows them. Wording is a deterministic template; no model.
 *
 * Off by default per tenant: the digest is the `daily_digest` work-job type, so it runs only after a group
 * administrator enables the type (key 1) and the person delegates it for themself (key 2), and the tenant-wide
 * stop switch halts it. Each run's prepared digest is kept in its outcome record (counts and pages only), which
 * is the prepared item the person reads (latestDailyDigest). Projecting it into the notification bell needs a
 * registry entry in core/notifications.ts, which sits in the approved provider closure: that is left for the
 * next approval of that closure, so no new channel and no closure change here. */
import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {company} from '../../db/schema';
import {terasMandate,terasOutcomeRecord} from '../../db/teras-schema';
import {isAdmin} from '../../lib/authz-model';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {listPendingTasks} from '../approvals-inbox';
import {isModuleEnabled} from '../entitlements';
import type {MandateScope} from '../mandates/job-types';
import type {WorkJobResult} from '../mandates/team-absence-summary';
import type {OutcomeRead} from '../outcome-record/types';
import {complianceWorklist} from '../reporting';
import {setupCopilot} from '../setup-copilot/copilot';

// AI Centre restructure (Today fix c): setup gaps open the go-live setup with its readiness stages, the one place setup is
// shown (Record readiness lists record gaps and shows no stages).
export const DIGEST_PAGES=Object.freeze({approvals:'/approvals',setup:'/payroll/setup?readiness=full',deadlines:'/payroll/statutory-forms'} as const);
/** At most this many administered companies are checked for setup gaps and deadlines in one digest. */
export const DIGEST_COMPANY_LIMIT=20;
export type DailyDigest=Readonly<{kind:'teras.daily_digest';version:1;asOf:string;
 approvals:Readonly<{total:number;byKind:readonly Readonly<{kind:string;count:number}>[];page:string}>;
 setup:Readonly<{blocked:number;attention:number;companies:number;unknown:number;page:string}>|null;
 deadlines:Readonly<{overdue:number;dueSoon:number;page:string}>|null;
 text:string}>;

const plural=(n:number,one:string,many=one+'s')=>`${n} ${n===1?one:many}`;
export function digestText(digest:Omit<DailyDigest,'text'|'kind'|'version'>):string{
 const parts=[digest.approvals.total?`${plural(digest.approvals.total,'item')} ${digest.approvals.total===1?'waits':'wait'} for your decision (${digest.approvals.byKind.map(row=>`${row.kind} ${row.count}`).join(', ')}).`
  :'Nothing waits for your decision.'];
 if(digest.setup)parts.push(`Setup: ${plural(digest.setup.blocked,'stage')} blocked, ${digest.setup.attention} need attention, across ${plural(digest.setup.companies,'company','companies')}.`);
 if(digest.deadlines)parts.push(`Statutory notifications: ${digest.deadlines.overdue} overdue, ${digest.deadlines.dueSoon} due within seven days.`);
 return parts.join(' ');
}

/** The outcome record's reference shape; an item id outside it is counted but not referenced. */
const REF=/^[a-z0-9_.:/#@-]{1,80}$/i;
type Prepared=Readonly<{digest:DailyDigest;reads:readonly OutcomeRead[]}>;
/** For the Inbox view: the approvals list the Inbox already read as the viewer (so the digest counts the same
 * list it shows, and the queue is not read twice), and the companies in the viewer's current scope (so the
 * setup and deadline counts cover the same companies as that list). Both absent for the scheduled job. */
export type DigestViewInput=Readonly<{approvals?:readonly Readonly<{id:string;kind:string}>[];companyIds?:readonly string[]}>;
/** How many administered companies are checked at once: each check is itself several parallel owner reads,
 * so this keeps one digest well inside the connection pool while not walking twenty companies one by one. */
const COMPANY_CONCURRENCY=4;
async function inBatches<T,R>(items:readonly T[],size:number,run:(item:T)=>Promise<R>):Promise<R[]>{
 const out:R[]=[];
 for(let i=0;i<items.length;i+=size)out.push(...await Promise.all(items.slice(i,i+size).map(run)));
 return out;
}
async function prepare(ctx:SessionContext,today:string,view:DigestViewInput={},setupFrom:'compute'|'prepared'='compute'):Promise<Prepared>{
 const modules={attendance:isModuleEnabled(ctx,'attendance'),claims:isModuleEnabled(ctx,'claims'),performance:isModuleEnabled(ctx,'performance'),rewards:isModuleEnabled(ctx,'rewards')};
 const tasks=view.approvals??await listPendingTasks(ctx,undefined,modules,{noticeAcknowledgements:false});
 const counts=new Map<string,number>();for(const task of tasks)counts.set(task.kind,(counts.get(task.kind)??0)+1);
 const byKind=[...counts].map(([kind,count])=>Object.freeze({kind,count})).sort((a,b)=>b.count-a.count||a.kind.localeCompare(b.kind));
 const reads:OutcomeRead[]=[{tool:'core/approvals-inbox.ts#listPendingTasks',status:'ok',refs:tasks.map(task=>task.id).filter(id=>REF.test(id)).slice(0,200)}];
 let setup:DailyDigest['setup']=null,deadlines:DailyDigest['deadlines']=null;
 if(isAdmin(ctx)&&setupFrom==='prepared'){
  // Review H4: a view never recomputes setup and deadlines (several native reads over every employment, per
  // company: 17 s for a 2000-employment administrator in run 41358551609). They come from today's prepared digest
  // (the scheduled daily_digest run, all administered companies); without one the tiles are simply absent.
  const prepared=await latestDailyDigest(ctx).catch(()=>null);
  if(prepared&&prepared.digest.asOf===today){setup=prepared.digest.setup;deadlines=isModuleEnabled(ctx,'payroll')?prepared.digest.deadlines:null;}
 }
 else if(isAdmin(ctx)){
  const scope=view.companyIds;
  const companies=scope&&scope.length===0?[]:await withTenant(ctx,tx=>tx.select({id:company.id}).from(company)
   .where(and(sql`app.is_admin_for(${company.id})`,scope?inArray(company.id,[...scope]):undefined)).orderBy(company.id).limit(DIGEST_COMPANY_LIMIT));
  // Statutory notifications are a payroll page; without the payroll module there is no deadline tile to give.
  const payroll=isModuleEnabled(ctx,'payroll');
  const results=await inBatches(companies,COMPANY_CONCURRENCY,async({id})=>{
   const [copilot,items]=await Promise.all([setupCopilot(ctx,id,today).catch(()=>null),payroll?complianceWorklist(ctx,{companyId:id,today}).catch(()=>null):Promise.resolve([])]);
   return {copilot,items};
  });
  let blocked=0,attention=0,unknown=0,overdue=0,dueSoon=0,checked=0;
  for(const {copilot,items} of results){
   if(copilot){checked++;blocked+=copilot.stages.filter(stage=>stage.status==='blocked').length;attention+=copilot.stages.filter(stage=>stage.status==='attention').length;}
   else unknown++;
   if(items){overdue+=items.filter(item=>item.status==='overdue').length;dueSoon+=items.filter(item=>item.status==='due_soon').length;}
   else unknown++;
  }
  const refs=companies.map(row=>row.id);
  reads.push({tool:'core/setup-copilot/copilot.ts#setupCopilot',status:unknown?'partial':'ok',refs});
  if(payroll)reads.push({tool:'core/reporting.ts#complianceWorklist',status:unknown?'partial':'ok',refs});
  setup=Object.freeze({blocked,attention,companies:checked,unknown,page:DIGEST_PAGES.setup});
  deadlines=payroll?Object.freeze({overdue,dueSoon,page:DIGEST_PAGES.deadlines}):null;
 }
 const body={asOf:today,approvals:Object.freeze({total:tasks.length,byKind:Object.freeze(byKind),page:DIGEST_PAGES.approvals}),setup,deadlines};
 return Object.freeze({digest:Object.freeze({kind:'teras.daily_digest' as const,version:1 as const,...body,text:digestText(body)}),reads:Object.freeze(reads)});
}

/** The digest for the caller, from the owners, as the caller. Not recorded. */
export async function prepareDailyDigest(ctx:SessionContext,today:string=todayInKualaLumpur()):Promise<DailyDigest>{
 if(!ctx.userId||!ctx.personId||ctx.agent)throw Error('The daily digest is prepared for a person.');
 return (await prepare(ctx,today)).digest;
}
/** Read service for the interface: what the caller's digest would say right now, without a mandate or a record.
 * The Inbox passes its own approvals list and company scope (DigestViewInput), so "Your day" and the list
 * below it have one owner and one scope (PR 198 review M9) and the queue is read once per view (H4). An
 * administrator's setup and deadline counts are read from today's prepared digest, never recomputed on a view (H4);
 * they cover every administered company as of that run. */
export async function digestPreview(ctx:SessionContext,options:DigestViewInput&Readonly<{today?:string}>={}):Promise<DailyDigest>{
 if(!ctx.userId||!ctx.personId||ctx.agent)throw Error('The daily digest is prepared for a person.');
 const {today=todayInKualaLumpur(),...view}=options;
 return (await prepare(ctx,today,view,'prepared')).digest;
}

/** The `daily_digest` job, run by core/mandates/run.ts under the grantor's current authority. */
export async function dailyDigestJob(grantor:SessionContext,mandate:Readonly<{scope:MandateScope}>,now:Date):Promise<WorkJobResult<DailyDigest>>{
 if(mandate.scope.team!=='self')throw Error('The daily digest covers the grantor\'s own items only.');
 const {digest,reads}=await prepare(grantor,todayInKualaLumpur(now));
 return Object.freeze({summary:digest,reads,checks:Object.freeze([]),outcome:Object.freeze({
  asOf:digest.asOf,approvalsTotal:digest.approvals.total,approvalsByKind:digest.approvals.byKind.map(row=>`${row.kind}:${row.count}`),
  setupBlocked:digest.setup?.blocked??null,setupAttention:digest.setup?.attention??null,setupCompanies:digest.setup?.companies??null,setupUnknown:digest.setup?.unknown??null,
  deadlinesOverdue:digest.deadlines?.overdue??null,deadlinesDueSoon:digest.deadlines?.dueSoon??null})});
}

/** The caller's latest prepared digest, rebuilt from its outcome record (the prepared item). Null when none. */
export async function latestDailyDigest(ctx:SessionContext):Promise<Readonly<{recordId:string;preparedAt:Date;digest:DailyDigest}>|null>{
 if(!ctx.userId||ctx.agent)return null;
 const [row]=await withTenant(ctx,tx=>tx.select({id:terasOutcomeRecord.id,at:terasOutcomeRecord.startedAt,outcome:terasOutcomeRecord.outcome}).from(terasOutcomeRecord)
  .innerJoin(terasMandate,and(eq(terasMandate.tenantId,terasOutcomeRecord.tenantId),eq(terasMandate.id,terasOutcomeRecord.mandateId)))
  .where(and(eq(terasOutcomeRecord.tenantId,ctx.tenantId),eq(terasOutcomeRecord.grantorUserId,ctx.userId!),eq(terasMandate.jobType,'daily_digest'),
   eq(terasOutcomeRecord.outcomeKind,'prepared'))).orderBy(desc(terasOutcomeRecord.startedAt),desc(terasOutcomeRecord.id)).limit(1));
 if(!row)return null;
 const o=row.outcome as Record<string,unknown>,n=(value:unknown)=>typeof value==='number'?value:null;
 const byKind=(Array.isArray(o.approvalsByKind)?o.approvalsByKind:[]).flatMap(item=>{const [kind,count]=String(item).split(':');const value=Number(count);
  return kind&&Number.isInteger(value)?[Object.freeze({kind,count:value})]:[];});
 const setup=n(o.setupBlocked)===null?null:Object.freeze({blocked:n(o.setupBlocked)!,attention:n(o.setupAttention)??0,companies:n(o.setupCompanies)??0,unknown:n(o.setupUnknown)??0,page:DIGEST_PAGES.setup});
 const deadlines=n(o.deadlinesOverdue)===null?null:Object.freeze({overdue:n(o.deadlinesOverdue)!,dueSoon:n(o.deadlinesDueSoon)??0,page:DIGEST_PAGES.deadlines});
 const body={asOf:String(o.asOf),approvals:Object.freeze({total:n(o.approvalsTotal)??0,byKind:Object.freeze(byKind),page:DIGEST_PAGES.approvals}),setup,deadlines};
 return Object.freeze({recordId:row.id,preparedAt:row.at,digest:Object.freeze({kind:'teras.daily_digest' as const,version:1 as const,...body,text:digestText(body)})});
}
