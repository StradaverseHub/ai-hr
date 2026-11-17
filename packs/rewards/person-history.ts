import 'server-only';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {withRewardsTenant} from '../../core/module-gate';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import type {CalculatedEntry} from './engine';
import {rewardHistoryValues,type RewardPersonHistoryRow} from './person-history-model';
export type {RewardPersonHistoryRow} from './person-history-model';

/** One bounded indexed read, only for the open person; the SQL owner repeats current review visibility. */
export async function rewardPersonHistory(ctx:SessionContext,unitId:string,entryId:string):Promise<RewardPersonHistoryRow[]>{
 z.uuid().parse(unitId);z.uuid().parse(entryId);
 return withRewardsTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const [row]=await tx.execute<{value:RewardPersonHistoryRow[]}>(sql`select app.reward_person_history(${unitId}::uuid,${entryId}::uuid) as value`);
  return row?.value??[];
 });
}

/** Called inside the native payroll posting transaction after effects, before setting posted status.
 * This is a single set insert; no new employee query/write loop is introduced. */
export async function recordRewardPersonHistoryTx(tx:Tx,ctx:SessionContext,unit:{id:string;companyId:string;kind:string;policy:{year:number}},rows:readonly CalculatedEntry[]){
 if(!rows.length)return;
 const values=rows.map(row=>({entryId:row.id,employmentId:row.source.employmentId,...rewardHistoryValues(row)}));
 await tx.execute(sql`insert into reward_person_history(tenant_id,company_id,employment_id,year,kind,source,unit_id,entry_id,talent,performance,
  merit_bp,promotion_bp,special_bp,increment_cents,total_increase_bp,promoted,promotion_grade,bonus_cents,bonus_months_bp,lump_cents,withheld,created_by)
 select ${ctx.tenantId}::uuid,${unit.companyId}::uuid,v."employmentId",${unit.policy.year},${unit.kind==='annual'?'annual':'offcycle'},'review',${unit.id}::uuid,v."entryId",
  v.talent,v.performance,v."meritBp",v."promotionBp",v."specialBp",v."incrementCents",v."totalIncreaseBp",v.promoted,v."promotionGrade",v."bonusCents",v."bonusMonthsBp",v."lumpCents",v.withheld,${ctx.userId}::uuid
 from jsonb_to_recordset(${JSON.stringify(values)}::jsonb) as v("entryId" uuid,"employmentId" uuid,talent text,performance text,"meritBp" integer,"promotionBp" integer,"specialBp" integer,
  "incrementCents" bigint,"totalIncreaseBp" integer,promoted boolean,"promotionGrade" text,"bonusCents" bigint,"bonusMonthsBp" integer,"lumpCents" bigint,withheld jsonb)
 on conflict(entry_id) where source='review' do nothing`);
}
