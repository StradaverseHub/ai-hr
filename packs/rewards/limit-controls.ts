import 'server-only';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {appendEvents,actorOf} from '../../db/events';
import {setupLock,setupReadTenant,setupTenant} from './setup-data';
import {RewardSetupError} from './setup-model';
import {assertRewardConfigReviewed,recordRewardConfigChangeTx,rewardConfigLines,rewardConfigSummary,rewardConfigSummaryDigest,rewardConfigDigest,type RewardConfigSummary} from './config-change';
import {
 baselineRewardLimitValues,baselineRewardLimits,rewardLimitLineLabel,rewardLimitSummaryRecord,rewardLimitValuesSchema,versionRewardLimits,
 rewardConfigurableLimitKeys,rewardLimitKeys,type RewardLimitAccess,type RewardLimitKey,type RewardLimitReviewStage,type RewardLimitValues,type RewardLimits,
} from './limit-controls-model';
import type {RewardPolicy} from './model';
export * from './limit-controls-model';

/** Rewards Limit Controls (board fc804e8c, docs/adr/2026-11-12-rewards-limit-controls.md).
 *
 * Readers for other Rewards owners:
 *  - rewardLimitsForUnitTx(tx,unit): the confirmed limits a review calculates with (Draft: the year's current
 *    version; past Draft: the version it keeps; no version: the baseline). Used by every annual calculation.
 *  - rewardLimitsForYearTx(tx,year): the current confirmed version of a reward year for Limit Controls readers
 *    (Group Rewards, CTRO, EC); null when the year has none.
 * Commands follow the configuration change seam (packs/rewards/config-change.ts): preview returns {summary,digest};
 * the save recomputes the summary in its transaction, calls assertRewardConfigReviewed, applies, then
 * recordRewardConfigChangeTx with area 'limit'. */

export async function rewardLimitControlsAccessTx(tx:Tx):Promise<RewardLimitAccess>{
 const [row]=await tx.execute<{access:'edit'|'view'|null}>(sql`select app.reward_limit_controls_access() as access`);
 return row?.access??null;
}
async function requireAccessTx(tx:Tx,needed:'view'|'edit'){
 const access=await rewardLimitControlsAccessTx(tx);
 if(!access||needed==='edit'&&access!=='edit')throw new RewardSetupError('forbidden','Limit Controls are not available to you.');
 return access;
}

type StoredVersion={id:string;revision:number;year:number;values:unknown};
/** The limits a review calculates with. The database function authorizes through the review's own row security,
 * so the reviewers' calculation uses the confirmed values without exposing them to the reviewers' pages. */
export async function rewardLimitsForUnitTx(tx:Tx,unit:{id:string;policy?:Pick<RewardPolicy,'standardPools'|'hPools'|'lumpShareBp'|'lumpStepCents'|'lumpCapCents'>|null}):Promise<RewardLimits>{
 const [ready]=await tx.execute<{ready:boolean}>(sql`select to_regprocedure('app.reward_unit_limit_version(uuid)') is not null as ready`);
 if(!ready?.ready)return baselineRewardLimits(unit.policy);
 const [row]=await tx.execute<{value:{mode:'current'|'pinned'|'legacy';year:number;version:StoredVersion|null}|null}>(sql`select app.reward_unit_limit_version(${unit.id}::uuid) as value`);
 const version=row?.value?.version;
 return version?versionRewardLimits(version):baselineRewardLimits(unit.policy);
}
/** The current confirmed version of a reward year, for Limit Controls readers; null when the year has none. */
export async function rewardLimitsForYearTx(tx:Tx,year:number):Promise<RewardLimits|null>{
 const [version]=await tx.execute<StoredVersion>(sql`select id,revision,year,limit_values as values from reward_limit_version where tenant_id=app.current_tenant_id() and year=${year} order by revision desc limit 1`);
 return version?versionRewardLimits(version):null;
}
/** Board b945f0cc: the limits an off-cycle request calculates with, from its reward year (the funding annual review's
 * year): Draft uses the year's current version, a submitted request keeps the version it was checked with, and a
 * request submitted before this change keeps the baseline. Authorized by the request's own seats. */
export async function rewardOffcycleLimitsTx(tx:Tx,unit:{id:string;policy?:Pick<RewardPolicy,'standardPools'|'hPools'|'lumpShareBp'|'lumpStepCents'|'lumpCapCents'>|null}):Promise<RewardLimits>{
 const [ready]=await tx.execute<{ready:boolean}>(sql`select to_regprocedure('app.reward_offcycle_limit_version(uuid)') is not null as ready`);
 if(!ready?.ready)return baselineRewardLimits(unit.policy);
 const [row]=await tx.execute<{value:{mode:'current'|'pinned'|'legacy';year:number;version:StoredVersion|null}|null}>(sql`select app.reward_offcycle_limit_version(${unit.id}::uuid) as value`);
 const version=row?.value?.version;
 return version?versionRewardLimits(version):baselineRewardLimits(unit.policy);
}
/** Submitting an off-cycle request keeps the version it was checked with (reward_unit_limit_pin). */
export async function pinRewardOffcycleLimitsOnSubmitTx(tx:Tx,unitId:string,limits:RewardLimits){
 const [ready]=await tx.execute<{ready:boolean}>(sql`select to_regprocedure('app.reward_offcycle_limit_pin(uuid,uuid)') is not null as ready`);
 if(!ready?.ready)return;
 await tx.execute(sql`select app.reward_offcycle_limit_pin(${unitId}::uuid,${limits.versionId}::uuid)`);
}
/** Submission keeps the version the review was checked with. */
export async function pinRewardLimitsOnSubmitTx(tx:Tx,unitId:string,limits:RewardLimits){
 const [ready]=await tx.execute<{ready:boolean}>(sql`select to_regprocedure('app.reward_limit_pin_on_submit(uuid,uuid)') is not null as ready`);
 if(!ready?.ready)return;
 await tx.execute(sql`select app.reward_limit_pin_on_submit(${unitId}::uuid,${limits.versionId}::uuid)`);
}

const yearSchema=z.number().int().min(2000).max(2200);
async function versionsTx(tx:Tx,year:number){
 return [...await tx.execute<{id:string;revision:number;values:unknown;reason:string;createdAt:string;createdByName:string|null}>(sql`select v.id,v.revision,v.limit_values as values,v.reason,v.created_at::text as "createdAt",p.full_name as "createdByName"
  from reward_limit_version v left join person p on p.id=v.created_by_person_id and p.tenant_id=v.tenant_id
  where v.tenant_id=app.current_tenant_id() and v.year=${year} order by v.revision desc limit 100`)];
}
/** Reviews of the year that a change reaches: one bounded, set-wise read. */
async function yearReviewsTx(tx:Tx,year:number):Promise<RewardLimitReviewStage[]>{
 return [...await tx.execute<RewardLimitReviewStage>(sql`select u.id as "reviewId",coalesce(c.legal_name,'Review')||' · '||coalesce(nullif(trim(b.label),''),b.code,'')||' '||${String(year)} as label,u.status as stage,
   (u.status<>'draft' or not coalesce(u.preparation_required,false) or g.state->'preparation'->>'state'='released') as released,
   p.unit_id is not null as pinned,v.revision as "pinnedRevision"
  from reward_unit u left join company c on c.id=u.company_id and c.tenant_id=u.tenant_id left join business_unit b on b.id=u.business_unit_id and b.tenant_id=u.tenant_id
  left join reward_governance g on g.unit_id=u.id and g.tenant_id=u.tenant_id
  left join reward_unit_limit_pin p on p.unit_id=u.id and p.tenant_id=u.tenant_id left join reward_limit_version v on v.id=p.limit_version_id and v.tenant_id=p.tenant_id
  where u.tenant_id=app.current_tenant_id() and u.deleted_at is null and u.kind='annual' and u.policy->>'year'=${String(year)} and u.status not in('withdrawn','rejected')
  order by 2,1 limit 201`)];
}
/** Budget-cap exemptions recorded on the year's reviews (they relax budget caps only). */
async function exemptionsTx(tx:Tx,year:number){
 return [...await tx.execute<{reviewId:string;label:string;reason:string}>(sql`select u.id as "reviewId",coalesce(c.legal_name,'Review')||' · '||coalesce(nullif(trim(b.label),''),b.code,'') as label,g.state->'exemption'->>'reason' as reason
  from reward_unit u join reward_governance g on g.unit_id=u.id and g.tenant_id=u.tenant_id left join company c on c.id=u.company_id and c.tenant_id=u.tenant_id left join business_unit b on b.id=u.business_unit_id and b.tenant_id=u.tenant_id
  where u.tenant_id=app.current_tenant_id() and u.deleted_at is null and u.kind='annual' and u.policy->>'year'=${String(year)} and g.state->'exemption'->>'confirmedBy' is not null
  order by 2,1 limit 200`)];
}

export type RewardLimitRowHistory={changedBy:string|null;changedAt:string|null;revision:number|null};
/** The Limit Controls page: Group Rewards edits, CTRO and EC view. */
export async function rewardLimitControls(ctx:SessionContext,rawYear:number){
 const year=yearSchema.parse(rawYear);
 return setupReadTenant(ctx,async tx=>{
  const access=await requireAccessTx(tx,'view');
  const versions=await versionsTx(tx,year);
  const current=versions[0]?versionRewardLimits({...versions[0],year}):null;
  // Last changed: the oldest version from which each key kept its current value and type.
  const ascending=[...versions].reverse().map(v=>({...v,limits:versionRewardLimits({...v,year}).values}));
  const history=Object.fromEntries(rewardLimitKeys.map(key=>{
   let since:typeof ascending[number]|null=null,previous:RewardLimitValues[RewardLimitKey]|null=null;
   for(const v of ascending){const setting=v.limits[key];if(!previous||previous.value!==setting.value||previous.type!==setting.type)since=v;previous=setting;}
   return[key,{changedBy:since?.createdByName??null,changedAt:since?.createdAt??null,revision:since?.revision??null} satisfies RewardLimitRowHistory];
  })) as Record<RewardLimitKey,RewardLimitRowHistory>;
  const [reviews,exemptions,years]=[await yearReviewsTx(tx,year),await exemptionsTx(tx,year),
   (await tx.execute<{year:number}>(sql`select distinct year from (select year from reward_limit_version where tenant_id=app.current_tenant_id() union select y.year from reward_cycle y where y.tenant_id=app.current_tenant_id()) x order by year desc limit 50`)).map(r=>Number(r.year))];
  return{year,access,canEdit:access==='edit',years,values:current?.values??baselineRewardLimitValues(),version:current?{id:current.versionId!,revision:current.revision!}:null,
   history,versions:versions.map(({values:_v,...v})=>v),reviews:reviews.slice(0,200),reviewsTruncated:reviews.length>200,exemptions};
 });
}

const saveSchema=z.object({year:yearSchema,expectedRevision:z.number().int().min(0),values:z.unknown(),reason:z.string().max(4000).default(''),summaryDigest:rewardConfigDigest.nullable().optional()}).strict();
function parseSave(raw:unknown){
 const p=saveSchema.parse(raw);
 const parsed=rewardLimitValuesSchema.safeParse(p.values);
 if(!parsed.success)throw new RewardSetupError('invalid',parsed.error.issues[0]?.message??'Correct the highlighted limits.');
 return{...p,values:parsed.data};
}
async function saveSummaryTx(tx:Tx,year:number,before:RewardLimitValues|null,after:RewardLimitValues):Promise<RewardConfigSummary>{
 const reviews=await yearReviewsTx(tx,year);
 const lines=rewardConfigLines(rewardLimitSummaryRecord(before??baselineRewardLimitValues()),rewardLimitSummaryRecord(after)!,rewardLimitLineLabel);
 return rewardConfigSummary({area:'limit',itemLabel:`Limit Controls ${year}`,lines,
  affected:reviews.map(r=>({reviewId:r.reviewId,label:r.label,stage:r.stage,consequence:r.stage==='draft'?'repriced' as const:'keeps-version' as const})),
  highImpact:reviews.some(r=>r.released)?['released-limit']:[]});
}
function merged(values:Partial<RewardLimitValues>):RewardLimitValues{
 const out=baselineRewardLimitValues();for(const key of rewardConfigurableLimitKeys)if(values[key])out[key]=values[key]!;return out;
}
/** Read-only preview for "Review before saving". */
export async function previewRewardLimitSave(ctx:SessionContext,raw:unknown){
 const p=parseSave(raw);
 return setupReadTenant(ctx,async tx=>{
  await requireAccessTx(tx,'edit');
  const current=await rewardLimitsForYearTx(tx,p.year);
  if((current?.revision??0)!==p.expectedRevision)throw new RewardSetupError('changed','Limit Controls changed. Reload before saving.');
  const summary=await saveSummaryTx(tx,p.year,current?.values??null,merged(p.values));
  return{summary,digest:rewardConfigSummaryDigest(summary)};
 });
}
/** Save a new version for the reward year. It takes effect at once for Draft reviews; reviews past Draft keep theirs. */
export async function saveRewardLimits(ctx:SessionContext,raw:unknown){
 const p=parseSave(raw);
 return setupTenant(ctx,async tx=>{
  await requireAccessTx(tx,'edit');
  await setupLock(tx,ctx,`limit-controls:${p.year}`);
  const current=await rewardLimitsForYearTx(tx,p.year);
  if((current?.revision??0)!==p.expectedRevision)throw new RewardSetupError('changed','Limit Controls changed. Reload before saving.');
  const values=merged(p.values),summary=await saveSummaryTx(tx,p.year,current?.values??null,values);
  if(!summary.changedCount&&current)throw new RewardSetupError('invalid','Nothing changed.');
  const reason=assertRewardConfigReviewed(summary,{reason:p.reason,digest:p.summaryDigest});
  const stored=Object.fromEntries(rewardConfigurableLimitKeys.map(key=>[key,values[key]]));
  const [version]=await tx.execute<{id:string;revision:number}>(sql`insert into reward_limit_version(tenant_id,year,revision,limit_values,reason,created_by)
   values(app.current_tenant_id(),${p.year},${p.expectedRevision+1},${JSON.stringify(stored)}::jsonb,${reason},app.current_user_id()) returning id,revision`);
  await recordRewardConfigChangeTx(tx,ctx,{area:'limit',action:'saved',itemId:version.id,itemLabel:summary.itemLabel,companyIds:[],versionRef:String(version.revision),reason,summary});
  return{versionId:version.id,revision:version.revision};
 });
}

const reapplySchema=z.object({year:yearSchema,revision:z.number().int().min(1),reviewIds:z.array(z.uuid()).min(1).max(200),reason:z.string().max(4000).default(''),summaryDigest:rewardConfigDigest.nullable().optional()}).strict();
async function reapplySummaryTx(tx:Tx,p:z.output<typeof reapplySchema>){
 const current=await rewardLimitsForYearTx(tx,p.year);
 if(!current||current.revision!==p.revision)throw new RewardSetupError('changed','Limit Controls changed. Review the summary again.');
 const wanted=new Set(p.reviewIds),reviews=(await yearReviewsTx(tx,p.year)).filter(r=>wanted.has(r.reviewId));
 if(reviews.length!==wanted.size||reviews.some(r=>!(['bg','gr','ctro','ec'] as string[]).includes(r.stage)))throw new RewardSetupError('changed','This selection changed. Review the summary again.');
 const summary=rewardConfigSummary({area:'limit',itemLabel:`Limit Controls ${p.year} · apply version ${current.revision}`,
  lines:reviews.map(r=>({key:r.reviewId,label:r.label,before:r.pinnedRevision?`Version ${r.pinnedRevision}`:'Baseline',after:`Version ${current.revision}`})),
  affected:reviews.map(r=>({reviewId:r.reviewId,label:r.label,stage:r.stage,consequence:'recalculation-required' as const})),highImpact:['released-limit']});
 return{current,summary};
}
export async function previewRewardLimitReapply(ctx:SessionContext,raw:unknown){
 const p=reapplySchema.parse(raw);
 return setupReadTenant(ctx,async tx=>{await requireAccessTx(tx,'edit');const {summary}=await reapplySummaryTx(tx,p);return{summary,digest:rewardConfigSummaryDigest(summary)};});
}
/** Explicitly apply the year's current version to reviews in the approval route. Their checks are recalculated from
 * the new version (and enforced again at the next approval), and each review's current approver is told. */
export async function reapplyRewardLimits(ctx:SessionContext,raw:unknown){
 const p=reapplySchema.parse(raw);
 return setupTenant(ctx,async tx=>{
  await requireAccessTx(tx,'edit');
  await setupLock(tx,ctx,`limit-controls:${p.year}`);
  const {current,summary}=await reapplySummaryTx(tx,p);
  const reason=assertRewardConfigReviewed(summary,{reason:p.reason,digest:p.summaryDigest});
  const applied=(await tx.execute<{id:string}>(sql`select app.reward_limit_reapply(ARRAY[${sql.join(p.reviewIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[],${current.versionId}::uuid,${reason}) as id`)).map(r=>r.id).sort();
  const companies=(await tx.execute<{id:string}>(sql`select distinct company_id as id from reward_unit where tenant_id=app.current_tenant_id() and id=any(ARRAY[${sql.join(applied.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`)).map(r=>r.id);
  // One notice per re-applied review to its current approver; payloads carry no limit value.
  await appendEvents(tx,applied.map(unitId=>({tenantId:ctx.tenantId,aggregateType:'reward-unit',aggregateId:unitId,eventType:'reward-unit.limits-reapplied',actor:actorOf(ctx),payload:{year:p.year,revision:current.revision,privateHistory:true}})));
  await recordRewardConfigChangeTx(tx,ctx,{area:'limit',action:'applied',itemId:current.versionId,itemLabel:summary.itemLabel,companyIds:companies,versionRef:String(current.revision),reason,summary});
  return{applied};
 });
}
