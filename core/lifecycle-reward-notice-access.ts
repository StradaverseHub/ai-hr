/** Administrative action ceiling only. Every caller retains its native role, row and workflow gate. */
import {sql} from 'drizzle-orm';
import type {Tx,SessionContext} from '../db/client';
import {lockAccessConfigurationTx} from './access-configuration-lock';
export type LifecycleRewardNoticeDomain='lifecycle'|'rewards'|'notices'|'lifecycle_configuration'|'rewards_configuration'|'notices_global';
export type NativeAction='view'|'add'|'edit'|'delete';
export async function nativeFunctionActionTx(tx:Tx,ctx:Pick<SessionContext,'tenantId'>,domain:LifecycleRewardNoticeDomain,action:NativeAction,companyId:string|null=null){
 if(action==='view')await lockAccessConfigurationTx(tx,ctx.tenantId);else await tx.execute(sql`select app.access_workforce_write_lock()`);
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.lifecycle_reward_notice_action(${domain},${action},${companyId}::uuid) as allowed`);
 return row?.allowed===true;
}
