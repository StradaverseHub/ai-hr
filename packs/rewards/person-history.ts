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
 const [recorded]=await tx.execute<{count:number}>(sql`select app.reward_record_person_history(${unit.id}::uuid,${JSON.stringify(values)}::jsonb) as count`);
 if(recorded?.count!==rows.length)throw Error('Reward history could not be recorded completely.');
 return recorded.count;
}
