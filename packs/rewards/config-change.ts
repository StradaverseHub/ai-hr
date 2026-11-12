import 'server-only';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {appendEvent,actorOf} from '../../db/events';
import {withRewardsTenant} from '../../core/module-gate';
import {lockAccessConfigurationTx} from '../../core/access-configuration-lock';
import {rewardConfigAreas,type RewardConfigArea,type RewardConfigSummary} from './config-change-model';
export * from './config-change-model';

/** The Rewards configuration change log (board 60f1fdcd, docs/adr/2026-11-12-rewards-direct-configuration.md).
 *
 * Interface for every Rewards configuration command:
 *  1. compute the change's RewardConfigSummary inside the command transaction (rewardConfigSummary);
 *  2. assertRewardConfigReviewed(summary,{reason,digest}) - a high-impact summary must match the reviewed digest;
 *  3. apply the change;
 *  4. recordRewardConfigChangeTx(tx,ctx,{...}) - exactly one append-only row and one co-administrator notice per
 *     save, in the same transaction, so a failed command leaves neither.
 * Pages read the log with rewardConfigChangeLog / rewardConfigChangeExport and an item's versions with
 * rewardConfigItemHistory. */
export type RewardConfigChangeInput={
 area:RewardConfigArea;action:string;itemId:string|null;itemLabel:string;companyIds:readonly string[];versionRef?:string|null;
 reason:string;summary:RewardConfigSummary;subjectUnitId?:string|null;subjectEntryIds?:readonly string[];restoredFrom?:string|null;
};
export async function recordRewardConfigChangeTx(tx:Tx,ctx:SessionContext,change:RewardConfigChangeInput):Promise<string>{
 const companies=[...new Set(change.companyIds)].sort();
 const [row]=await tx.execute<{id:string}>(sql`select app.reward_config_change_record(${change.area},${change.action},${change.itemId}::uuid,${change.itemLabel.slice(0,300)},
  ${companies.length?sql`ARRAY[${sql.join(companies.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`:sql`'{}'::uuid[]`},${change.versionRef??null},${change.reason},
  ${change.summary.highImpact.length>0},${change.summary.changedCount},${JSON.stringify(change.summary)}::jsonb,${change.subjectUnitId??null}::uuid,
  ${change.subjectEntryIds?.length?sql`ARRAY[${sql.join(change.subjectEntryIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`:sql`'{}'::uuid[]`},${change.restoredFrom??null}::text) as id`);
 const [actor]=await tx.execute<{name:string|null}>(sql`select p.full_name as name from app_user u left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.id=app.current_user_id() and u.tenant_id=app.current_tenant_id()`);
 // One notice per save. The payload names the item and the count, never a value.
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'rewards-config',aggregateId:row.id,eventType:'rewards-config.changed',actor:actorOf(ctx),
  payload:{area:change.area,action:change.action,itemLabel:change.itemLabel.slice(0,300),changedCount:change.summary.changedCount,actorName:actor?.name??null,reason:change.reason.slice(0,300),highImpact:change.summary.highImpact.length>0}});
 return row.id;
}

export const rewardConfigLogFilterSchema=z.object({
 area:z.enum(rewardConfigAreas).optional(),itemId:z.uuid().optional(),companyId:z.uuid().optional(),actor:z.string().trim().max(120).optional(),
 from:z.iso.date().optional(),to:z.iso.date().optional(),highImpact:z.boolean().optional(),
 page:z.number().int().min(1).max(10_000).default(1),
}).strict();
export type RewardConfigLogFilter=z.input<typeof rewardConfigLogFilterSchema>;
export type RewardConfigLogRow={id:string;area:RewardConfigArea;action:string;itemId:string|null;itemLabel:string;companyIds:string[];companyNames:string[];
 versionRef:string|null;actorKind:'user'|'system';actorName:string|null;at:string;reason:string;highImpact:boolean;changedCount:number;summary:RewardConfigSummary|Record<string,unknown>;restoredFrom:string|null};
export const REWARD_CONFIG_LOG_PAGE=50;
export const REWARD_CONFIG_EXPORT_LIMIT=5000;

function filtered(f:z.output<typeof rewardConfigLogFilterSchema>){
 return sql`c.tenant_id=app.current_tenant_id()
  ${f.area?sql`and c.area=${f.area}`:sql``}
  ${f.itemId?sql`and c.item_id=${f.itemId}::uuid`:sql``}
  ${f.companyId?sql`and ${f.companyId}::uuid=any(c.company_ids)`:sql``}
  ${f.from?sql`and c.at>=(${f.from}::date::timestamp at time zone 'Asia/Kuala_Lumpur')`:sql``}
  ${f.to?sql`and c.at<((${f.to}::date+1)::timestamp at time zone 'Asia/Kuala_Lumpur')`:sql``}
  ${f.highImpact?sql`and c.high_impact`:sql``}
  ${f.actor?sql`and p.full_name ilike ${'%'+f.actor.replace(/[\\%_]/g,m=>'\\'+m)+'%'}`:sql``}`;
}
async function logRowsTx(tx:Tx,f:z.output<typeof rewardConfigLogFilterSchema>,limit:number,offset:number){
 // Row security admits only the companies the reader configures and never a row about their own entry; the page
 // is ordered and bounded in SQL, and company names come from one set-wise join.
 return [...await tx.execute<RewardConfigLogRow>(sql`select c.id,c.area,c.action,c.item_id as "itemId",c.item_label as "itemLabel",c.company_ids as "companyIds",
   coalesce((select array_agg(x.legal_name order by x.legal_name) from company x where x.tenant_id=c.tenant_id and x.id=any(c.company_ids)),'{}') as "companyNames",
   c.version_ref as "versionRef",c.actor_kind as "actorKind",p.full_name as "actorName",c.at::text as at,c.reason,c.high_impact as "highImpact",c.changed_count as "changedCount",c.summary,c.restored_from as "restoredFrom"
  from reward_config_change c left join person p on p.id=c.actor_person_id and p.tenant_id=c.tenant_id
  where ${filtered(f)} order by c.at desc,c.id desc limit ${limit} offset ${offset}`)];
}
/** Readers hold the shared Access lock only (docs/SCALE-AND-RELEASE-RULES.md rule 1). */
function logRead<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>){
 if(!ctx.userId)throw new Error('Sign in to continue.');
 return withRewardsTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,ctx.tenantId);return read(tx);});
}
export async function rewardConfigChangeLog(ctx:SessionContext,raw:RewardConfigLogFilter){
 const f=rewardConfigLogFilterSchema.parse(raw);
 return logRead(ctx,async tx=>{
  const [access]=await tx.execute<{allowed:boolean}>(sql`select (app.reward_setup_allowed(null,'library_view') or exists(select 1 from company x where x.tenant_id=app.current_tenant_id() and app.reward_setup_allowed(x.id,'manage'))) as allowed`);
  if(!access?.allowed)throw new Error('The Rewards change log is not available to you.');
  const rows=await logRowsTx(tx,f,REWARD_CONFIG_LOG_PAGE+1,(f.page-1)*REWARD_CONFIG_LOG_PAGE);
  return{rows:rows.slice(0,REWARD_CONFIG_LOG_PAGE),page:f.page,hasMore:rows.length>REWARD_CONFIG_LOG_PAGE};
 });
}
/** Export rows: the same population and order as the page, bounded; the export itself is audited. */
export async function rewardConfigChangeExport(ctx:SessionContext,raw:RewardConfigLogFilter){
 const f=rewardConfigLogFilterSchema.parse({...raw,page:1});
 return logRead(ctx,async tx=>{
  const [access]=await tx.execute<{allowed:boolean}>(sql`select (app.reward_setup_allowed(null,'library_view') or exists(select 1 from company x where x.tenant_id=app.current_tenant_id() and app.reward_setup_allowed(x.id,'manage'))) as allowed`);
  if(!access?.allowed)throw new Error('The Rewards change log is not available to you.');
  const rows=await logRowsTx(tx,f,REWARD_CONFIG_EXPORT_LIMIT+1,0);
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'rewards-config',aggregateId:ctx.userId!,eventType:'rewards-config.exported',actor:actorOf(ctx),payload:{rows:Math.min(rows.length,REWARD_CONFIG_EXPORT_LIMIT),filter:{...f,actor:f.actor?'(text)':undefined}}});
  return{rows:rows.slice(0,REWARD_CONFIG_EXPORT_LIMIT),truncated:rows.length>REWARD_CONFIG_EXPORT_LIMIT};
 });
}
/** An item's recorded changes, newest first (compare and restore read the item's own versions). */
export async function rewardConfigItemHistoryTx(tx:Tx,area:RewardConfigArea,itemId:string,limit=50){
 return logRowsTx(tx,rewardConfigLogFilterSchema.parse({area,itemId}),Math.min(limit,200),0);
}

/** Company choices for the change-log filter: the companies the reader configures, one set-wise statement. */
export async function rewardConfigLogCompanies(ctx:SessionContext){
 return logRead(ctx,async tx=>[...await tx.execute<{id:string;name:string}>(sql`select x.id,x.legal_name as name from company x where x.tenant_id=app.current_tenant_id() and x.archived_at is null and app.reward_setup_allowed(x.id,'manage') order by x.legal_name,x.id limit 1000`)]);
}
