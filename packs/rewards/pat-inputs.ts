import 'server-only';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {appendEvent,actorOf} from '../../db/events';
import {setupPersonTx,setupAuthority,setupTenant,setupAuditedReadTenant,setupLock,setupEvent,setupCompanyEligible} from './setup-data';
import {patInputSchema,patProjection,setupUuid,setupYear,setupReason,RewardSetupError,type PatInput} from './setup-model';
export type {PatVersion,PatCompany} from './setup-query-owner';
import {rewardSetupCompaniesQueryTx,rewardPatInputsQueryTx,rewardPlanCompanyChoicesQueryTx,type PatVersion,type PatCompany} from './setup-query-owner';
import {legacyRewardSetupQueryPort} from './setup-legacy-query-port';
import {assertRewardConfigReviewed,recordRewardConfigChangeTx,rewardConfigLines,rewardConfigMoney,rewardConfigMonths,rewardConfigSummary,rewardConfigSummaryDigest} from './config-change';
export async function rewardSetupCompaniesTx(tx:Tx,ctx:SessionContext,year:number):Promise<PatCompany[]>{return rewardSetupCompaniesQueryTx(tx,ctx,year,legacyRewardSetupQueryPort);}
export async function latestConfirmedPatTx(tx:Tx,ctx:SessionContext,companyId:string,year:number):Promise<PatVersion|null>{await setupAuthority(tx,companyId,'manage');const [r]=await tx.execute<PatVersion>(sql`select id,company_id as "companyId",year,revision,inputs,state,created_by as "createdBy",confirmed_by as "confirmedBy",confirmed_at::text as "confirmedAt",reason from reward_pat_version where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid and year=${year} and state='confirmed' order by revision desc limit 1`);if(r)patInputSchema.parse(r.inputs);return r??null;}
function auditedPatRead<T>(ctx:SessionContext,year:number,read:(tx:Tx)=>Promise<T>){
 setupYear.parse(year);
 return setupAuditedReadTenant(ctx,async tx=>{
  const rows=await read(tx);
  await setupEvent(tx,ctx,'pat.viewed',null,{year});
  return rows;
 });
}
export function rewardPatInputs(ctx:SessionContext,year:number){
 return auditedPatRead(ctx,year,tx=>rewardPatInputsQueryTx(tx,ctx,year,legacyRewardSetupQueryPort));
}
/** Plans keeps the historical PAT view event and reads only eligible company labels. */
export function rewardPlanCompanyChoices(ctx:SessionContext,year:number){
 return auditedPatRead(ctx,year,tx=>rewardPlanCompanyChoicesQueryTx(tx,year,legacyRewardSetupQueryPort));
}
const patRowSchema=z.object({companyId:setupUuid,year:setupYear,expectedRevision:z.number().int().nonnegative(),inputs:patInputSchema,reason:setupReason}).strict();
/** Saves one company-year's PAT as its working Draft (stored as the 'pending' version). The expected revision is the
 * latest revision the editor saw: a Draft at that revision is updated in place, an Active one gets a successor. */
/** The company-year advisory lock serialises every PAT writer; a row lock would apply the Draft-only UPDATE policy
 * and hide an Active latest version. */
async function savePatDraftTx(tx:Tx,ctx:SessionContext,p:z.infer<typeof patRowSchema>){await setupAuthority(tx,p.companyId,'manage');await setupPersonTx(tx);await setupCompanyEligible(tx,p.companyId,p.year);await setupLock(tx,ctx,'pat:'+p.companyId+':'+p.year);const [current]=await tx.execute<{id:string;revision:number;state:string}>(sql`select id,revision,state from reward_pat_version where tenant_id=${ctx.tenantId}::uuid and company_id=${p.companyId}::uuid and year=${p.year} order by revision desc limit 1`);if((current?.revision??0)!==p.expectedRevision)throw new RewardSetupError('changed','These PAT figures changed in another session. Reload before saving.');
 const [locked]=await tx.execute<{locked:boolean}>(sql`select exists(select 1 from reward_unit u join reward_cycle c on c.id=u.cycle_id and c.tenant_id=u.tenant_id join reward_unit_setup binding on binding.unit_id=u.id and binding.tenant_id=u.tenant_id where u.tenant_id=${ctx.tenantId}::uuid and u.company_id=${p.companyId}::uuid and c.year=${p.year} and u.deleted_at is null and u.status in('ec','approved','posted')) as locked`);if(locked?.locked)throw new RewardSetupError('locked','PAT figures are locked once an affected review reaches EC approval.');
 if(current?.state==='pending'){await tx.execute(sql`update reward_pat_version set inputs=${JSON.stringify(p.inputs)}::jsonb,reason=${p.reason} where id=${current.id}::uuid and tenant_id=${ctx.tenantId}::uuid and state='pending'`);await setupEvent(tx,ctx,'pat.proposed',current.id,{companyId:p.companyId,year:p.year,revision:current.revision,privateVersion:true,draftUpdated:true});return current.id;}
 const id=randomUUID();await tx.execute(sql`insert into reward_pat_version(id,tenant_id,company_id,year,revision,inputs,created_by,reason) values(${id}::uuid,${ctx.tenantId}::uuid,${p.companyId}::uuid,${p.year},${p.expectedRevision+1},${JSON.stringify(p.inputs)}::jsonb,${ctx.userId}::uuid,${p.reason})`);await setupEvent(tx,ctx,'pat.proposed',id,{companyId:p.companyId,year:p.year,revision:p.expectedRevision+1,privateVersion:true});return id;}
/** Makes a PAT Draft active. Draft reviews are repriced in this transaction; reviews beyond the BU CEO are flagged
 * for recalculation and their approvers told (the existing final-pool-changed notice). EC-approved figures stay locked. */
async function activatePatTx(tx:Tx,ctx:SessionContext,id:string){const [p]=await tx.execute<{id:string;company_id:string;year:number;revision:number;inputs:PatInput;state:string}>(sql`select * from reward_pat_version where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid`);if(!p||p.state!=='pending')throw new RewardSetupError('changed','This PAT draft is no longer open.');await setupAuthority(tx,p.company_id,'manage');await setupPersonTx(tx);await setupCompanyEligible(tx,p.company_id,p.year);await setupLock(tx,ctx,'pat:'+p.company_id+':'+p.year);const [pending]=await tx.execute<{state:string}>(sql`select state from reward_pat_version where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid for update`);if(pending?.state!=='pending')throw new RewardSetupError('changed','This PAT draft is no longer open.');patInputSchema.parse(p.inputs);
 const affected=await tx.execute<{id:string;status:string}>(sql`select * from app.reward_pat_affected_units(${p.company_id}::uuid,${p.year})`);if(affected.some(u=>['ec','approved','posted'].includes(u.status)))throw new RewardSetupError('locked','An affected review has reached EC approval. These PAT figures are locked.');
 await tx.execute(sql`update reward_pat_version set state='confirmed',confirmed_by=${ctx.userId}::uuid,confirmed_at=now() where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid`);
 for(const unit of affected){await setupEvent(tx,ctx,'pat.recalculation.required',unit.id,{companyId:p.company_id,year:p.year,patVersionId:id});await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'reward-unit',aggregateId:unit.id,eventType:'reward-unit.final-pool-changed',actor:actorOf(ctx),payload:{recalculationRequired:true,privateHistory:true}});}
 await setupEvent(tx,ctx,'pat.confirmed',id,{companyId:p.company_id,year:p.year,revision:p.revision,affectedReviewIds:affected.map(u=>u.id)});return affected.map(u=>u.id);}
export function proposeRewardPat(ctx:SessionContext,raw:unknown,providedTx?:Tx){const p=patRowSchema.parse(raw);const operation=(tx:Tx)=>savePatDraftTx(tx,ctx,p);return providedTx?operation(providedTx):setupTenant(ctx,operation);}
/** Makes one company's PAT Draft active (no second person: board 60f1fdcd). */
export function confirmRewardPat(ctx:SessionContext,id:string,review?:{reason?:string;summaryDigest?:string|null}){setupUuid.parse(id);return setupTenant(ctx,async tx=>{const [row]=await tx.execute<{company_id:string;year:number;revision:number;inputs:PatInput;reason:string}>(sql`select company_id,year,revision,inputs,reason from reward_pat_version where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid and state='pending'`);if(!row)throw new RewardSetupError('changed','This PAT draft is no longer open.');const summary=await patSummaryTx(tx,ctx,row.year,[{companyId:row.company_id,inputs:row.inputs}],'active');const reason=assertRewardConfigReviewed(summary,{reason:review?.reason??row.reason.slice(0,4000),digest:review?.summaryDigest});const affected=await activatePatTx(tx,ctx,id);await recordRewardConfigChangeTx(tx,ctx,{area:'pat',action:'activated',itemId:id,itemLabel:summary.itemLabel,companyIds:[row.company_id],versionRef:String(row.revision),reason,summary});return affected;});}
export function rewardPatExport(ctx:SessionContext,year:number){return setupAuditedReadTenant(ctx,async tx=>{const companies=await rewardSetupCompaniesTx(tx,ctx,year);
 // One statement for every company's Active figures (not one read per company).
 const ids=companies.map(c=>c.id),active=ids.length?new Map((await tx.execute<{companyId:string;revision:number;inputs:PatInput}>(sql`select distinct on (company_id) company_id as "companyId",revision,inputs from reward_pat_version where tenant_id=${ctx.tenantId}::uuid and year=${year} and state='confirmed' and company_id=any(ARRAY[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) order by company_id,revision desc`)).map(r=>[r.companyId,r])):new Map<string,{revision:number;inputs:PatInput}>();
 const rows=companies.map(company=>{const p=active.get(company.id);if(p)patInputSchema.parse(p.inputs);return{company,inputs:p?.inputs??{targetCents:null,forecastCents:null,actualCents:null,targetMonthsBp:20000},revision:p?.revision??0};});
 await setupEvent(tx,ctx,'pat.exported',null,{year,companyCount:rows.length});return rows;});}
export const publicPatProjection=(v:PatVersion|null)=>v?{version:v.revision,...patProjection(v.inputs)}:{version:null,status:'not-set' as const,achievementBp:null,targetMonthsBp:20000};

const PAT_FIELDS=[['targetCents','Target PAT'],['forecastCents','Forecast 9+3'],['actualCents','Actual PAT'],['targetMonthsBp','Target months']] as const;
const patDisplay=(inputs:PatInput|null)=>inputs?Object.fromEntries(PAT_FIELDS.map(([key])=>[key,key==='targetMonthsBp'?rewardConfigMonths(inputs[key]):rewardConfigMoney(inputs[key])])):null;
/** The change summary for a PAT batch: changed cells against each company's current figures (its open Draft, else
 * its Active version) and, when made active, the reviews it reaches. Changing PAT once a review using it has left the
 * BU CEO is high impact. Set-wise reads: one statement per concern for the whole batch. */
async function patSummaryTx(tx:Tx,ctx:SessionContext,year:number,rows:readonly{companyId:string;inputs:PatInput}[],mode:'draft'|'active'){
 const ids=[...new Set(rows.map(r=>r.companyId))].sort();
 const list=sql`ARRAY[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
 const names=new Map((await tx.execute<{id:string;name:string}>(sql`select id,legal_name as name from company where tenant_id=${ctx.tenantId}::uuid and id=any(${list})`)).map(r=>[r.id,r.name]));
 const current=new Map((await tx.execute<{companyId:string;inputs:PatInput}>(sql`select distinct on (company_id) company_id as "companyId",inputs from reward_pat_version where tenant_id=${ctx.tenantId}::uuid and year=${year} and company_id=any(${list}) ${mode==='active'?sql`and state='confirmed'`:sql``} order by company_id,revision desc`)).map(r=>[r.companyId,r.inputs]));
 const lines=rows.flatMap(r=>{const label=names.get(r.companyId)??r.companyId;return rewardConfigLines(patDisplay(current.get(r.companyId)??null),patDisplay(r.inputs)!,key=>`${label}: ${PAT_FIELDS.find(([k])=>k===key)?.[1]??key}`).map(line=>({...line,key:`${label}:${r.companyId}:${line.key}`}));});
 const affected=mode==='active'&&ids.length?await tx.execute<{reviewId:string;label:string;stage:string}>(sql`select u.id as "reviewId",coalesce(c.legal_name,'Review')||' '||${String(year)} as label,u.status as stage
  from reward_unit u join reward_cycle y on y.id=u.cycle_id and y.tenant_id=u.tenant_id join reward_unit_setup s on s.unit_id=u.id and s.tenant_id=u.tenant_id left join company c on c.id=u.company_id and c.tenant_id=u.tenant_id
  where u.tenant_id=${ctx.tenantId}::uuid and u.company_id=any(${list}) and y.year=${year} and u.deleted_at is null and u.status not in('withdrawn','rejected') order by 2,1 limit 201`):[];
 const itemLabel=ids.length===1?`PAT ${year} · ${names.get(ids[0])??''}`.trim():`PAT ${year} · ${ids.length} companies`;
 return rewardConfigSummary({area:'pat',itemLabel,lines,affected:affected.map(a=>({...a,consequence:a.stage==='draft'?'repriced' as const:'recalculation-required' as const})),highImpact:affected.some(a=>a.stage!=='draft')?['released-pat']:[]});
}
const patBatchSchema=z.object({year:setupYear,mode:z.enum(['draft','active']),reason:setupReason,summaryDigest:z.string().nullable().optional(),
 rows:z.array(z.object({companyId:setupUuid,expectedRevision:z.number().int().nonnegative(),inputs:patInputSchema}).strict()).min(1).max(1000)}).strict();
function parsePatBatch(raw:unknown){const p=patBatchSchema.parse(raw);if(new Set(p.rows.map(r=>r.companyId)).size!==p.rows.length)throw new RewardSetupError('invalid','Each company can appear once in a save.');return{...p,rows:[...p.rows].sort((a,b)=>a.companyId.localeCompare(b.companyId))};}
/** Read-only preview for activating one company's open PAT Draft. */
export function previewRewardPatActivation(ctx:SessionContext,id:string){setupUuid.parse(id);return setupAuditedReadTenant(ctx,async tx=>{const [row]=await tx.execute<{company_id:string;year:number;inputs:PatInput}>(sql`select company_id,year,inputs from reward_pat_version where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid and state='pending'`);if(!row)throw new RewardSetupError('changed','This PAT draft is no longer open.');await setupAuthority(tx,row.company_id,'manage');const summary=await patSummaryTx(tx,ctx,row.year,[{companyId:row.company_id,inputs:row.inputs}],'active');return{summary,digest:rewardConfigSummaryDigest(summary)};});}
/** Read-only preview for "Review before saving" on the PAT grid. */
export function previewRewardPatBatch(ctx:SessionContext,raw:unknown){const p=parsePatBatch(raw);return setupAuditedReadTenant(ctx,async tx=>{for(const r of p.rows)await setupAuthority(tx,r.companyId,'manage');const summary=await patSummaryTx(tx,ctx,p.year,p.rows,p.mode);return{summary,digest:rewardConfigSummaryDigest(summary)};});}
/** Board 2103041d + 60f1fdcd: one save for every edited PAT cell. All rows or none: deterministic company lock order,
 * per-row optimistic revisions, one reason, one change-log row and one notice. 'active' makes the figures active
 * immediately; there is no second-person confirmation. */
export function saveRewardPatBatch(ctx:SessionContext,raw:unknown){const p=parsePatBatch(raw);return setupTenant(ctx,async tx=>{
 for(const r of p.rows)await setupAuthority(tx,r.companyId,'manage');
 const summary=await patSummaryTx(tx,ctx,p.year,p.rows,p.mode);const reason=assertRewardConfigReviewed(summary,{reason:p.reason,digest:p.summaryDigest});
 if(!summary.changedCount&&p.mode==='draft')throw new RewardSetupError('invalid','Nothing changed.');
 const ids:string[]=[],affected:string[]=[];
 for(const r of p.rows)ids.push(await savePatDraftTx(tx,ctx,{companyId:r.companyId,year:p.year,expectedRevision:r.expectedRevision,inputs:r.inputs,reason}));
 if(p.mode==='active')for(const id of ids)affected.push(...await activatePatTx(tx,ctx,id));
 await setupEvent(tx,ctx,'pat.imported',null,{count:ids.length,versionIds:ids,mode:p.mode});
 await recordRewardConfigChangeTx(tx,ctx,{area:'pat',action:p.mode==='active'?'activated':'saved-draft',itemId:ids.length===1?ids[0]:null,itemLabel:summary.itemLabel,companyIds:p.rows.map(r=>r.companyId),versionRef:String(p.year),reason,summary});
 return{versionIds:ids,affectedReviewIds:[...new Set(affected)]};
});}
/** Legacy import commit: saves the rows as Drafts. */
export function proposeRewardPatBatch(ctx:SessionContext,raw:unknown){const rows=z.array(z.object({companyId:setupUuid,year:setupYear,expectedRevision:z.number().int().nonnegative(),inputs:patInputSchema,reason:setupReason}).strict()).min(1).max(1000).parse(raw);if(new Set(rows.map(r=>r.companyId+':'+r.year)).size!==rows.length)throw new RewardSetupError('invalid','Each company-year can appear once in an import.');const years=new Set(rows.map(r=>r.year));if(years.size!==1)throw new RewardSetupError('invalid','Import one reward year at a time.');return saveRewardPatBatch(ctx,{year:rows[0].year,mode:'draft',reason:rows[0].reason,rows:rows.map(r=>({companyId:r.companyId,expectedRevision:r.expectedRevision,inputs:r.inputs}))}).then(r=>r.versionIds);}
