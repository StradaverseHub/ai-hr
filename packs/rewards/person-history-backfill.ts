import 'server-only';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../../db/client';
import {withRewardHistoryBackfill} from './service';
import {recordRewardPersonHistoryTx} from './person-history';

/** One explicitly selected posted review per transaction. Dry run is the default; no historical
 * recommendation, compensation, payroll input, limit version or stored trace is rewritten. */
export async function backfillRewardPersonHistory(ctx:SessionContext,unitId:string,apply=false){
 return withRewardHistoryBackfill(ctx,unitId,apply,async(tx,{unit,roles},calculated,commands)=>{
  const [authority]=await tx.execute<{allowed:boolean}>(sql`select app.reward_admin(${unit.companyId}::uuid) and app.reward_not_viewing_as() as allowed`);
  if(!authority?.allowed||!roles.includes('payroll'))throw Error('The review’s payroll seat and company administrator authority are required.');
  if(unit.status!=='posted')throw Error('Backfill only a posted review.');
  const matches=await tx.execute<{entryId:string;basic:string|null;alreadyRecorded:boolean}>(sql`select e.id as "entryId",c.basic_salary as basic,
   e.id in(select app.reward_history_recorded_entries(${unitId}::uuid)) as "alreadyRecorded"
   from reward_entry e left join compensation c on c.id=e.enacted_compensation_id and c.tenant_id=e.tenant_id and c.employment_id=e.employment_id
   where e.unit_id=${unitId}::uuid and e.tenant_id=app.current_tenant_id() order by e.id`);
  const byId=new Map(matches.map(row=>[row.entryId,row])),accepted:typeof calculated.rows=[],refused:{entryId:string;reason:string}[]=[],alreadyRecorded:string[]=[];
  for(const row of calculated.rows){
   const match=byId.get(row.id);
   if(match?.alreadyRecorded){alreadyRecorded.push(row.id);continue;}
   // Parse fixed decimals exactly. A value that cannot be proved in cents is refused, never rounded.
   const amount=match?.basic;
   const cents=amount&&/^\d+(\.\d{1,2})?$/.test(amount)?Number(BigInt(amount.split('.')[0])*BigInt(100)+BigInt((amount.split('.')[1]??'').padEnd(2,'0'))):null;
   if(cents===null||!Number.isSafeInteger(cents)||cents!==row.newBasicCents)refused.push({entryId:row.id,reason:'The recalculated basic does not match the entry’s enacted compensation record.'});
   else accepted.push(row);
  }
  const inserted=apply&&accepted.length?await recordRewardPersonHistoryTx(tx,ctx,unit,accepted):0;
  if(inserted)await commands.stamp('person-history-backfilled',{entryIds:accepted.map(row=>row.id),refusedCount:refused.length});
  return{unitId,dryRun:!apply,accepted:accepted.map(row=>row.id),alreadyRecorded,refused,inserted};
 });
}
