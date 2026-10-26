import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';

/** Calculations and report snapshots share this barrier. A history correction takes it exclusively
 * before any authority/record locks, preventing a payroll run from consuming half a correction. */
export async function lockPayrollHistoryReadTx(tx:Tx,tenantId:string){
 await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${'payroll-history:'+tenantId},0))`);
}
export async function lockPayrollHistoryWriteTx(tx:Tx,tenantId:string){
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'payroll-history:'+tenantId},0))`);
}
export function withPayrollHistoryTenant<T>(ctx:SessionContext,fn:(tx:Tx)=>Promise<T>,options?:{readOnlySnapshot:true}):Promise<T>{
 return withTenant(ctx,async tx=>{await lockPayrollHistoryReadTx(tx,ctx.tenantId);return fn(tx);},options);
}
