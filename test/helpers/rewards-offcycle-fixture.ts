/** Board b945f0cc fixtures: open a cycle's off-cycle year directly (as the restricted owner, tenant-scoped) and run
 * off-cycle decisions on a fixed date outside the 1 October - 31 January blackout. Only JS Date is faked; database
 * time and timers are untouched. */
import {sql} from 'drizzle-orm';
import {vi} from 'vitest';
import {owner} from '../harness';

export async function openRewardOffcycleYearFixture(tenantId:string,cycleId:string,openedBy:string,window:{from:string;to:string}|null=null){
 await owner.db.transaction(async tx=>{
  await tx.execute(sql`select set_config('app.tenant_id',${tenantId},true)`);
  await tx.execute(sql`insert into reward_offcycle_year(tenant_id,cycle_id,opened_by,updated_by,midyear_from,midyear_to)
   values(${tenantId}::uuid,${cycleId}::uuid,${openedBy}::uuid,${openedBy}::uuid,${window?.from??null}::date,${window?.to??null}::date) on conflict do nothing`);
 });
}
/** A mid-June day of the current year: outside the blackout and inside offcycleMidyearWindowFixture. */
export const offcycleOpenDay=()=>`${new Date().getUTCFullYear()}-06-15`;
export const offcycleMidyearWindowFixture=()=>({from:`${new Date().getUTCFullYear()}-06-01`,to:`${new Date().getUTCFullYear()}-06-30`});
export async function outsideOffcycleBlackout<T>(work:()=>Promise<T>,day=offcycleOpenDay()):Promise<T>{
 vi.useFakeTimers({toFake:['Date'],now:new Date(`${day}T04:00:00Z`)});
 try{return await work();}finally{vi.useRealTimers();}
}
