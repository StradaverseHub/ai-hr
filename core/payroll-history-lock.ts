import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';

/** Calculations and report snapshots share this barrier. A history correction takes it exclusively
 * before any authority/record locks, preventing a payroll run from consuming half a correction. */
export async function lockPayrollHistoryReadTx(tx:Tx,tenantId:string){
 await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${'payroll-history:'+tenantId},0))`);
}
/** An enclosing Assistant transaction already owns Access. Never wait here behind a history
 * writer that acquires History then Access. Refusal requires the entire caller transaction rollback. */
export async function tryLockPayrollHistoryReadTx(tx:Tx,tenantId:string){
 const [row]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock_shared(hashtextextended(${'payroll-history:'+tenantId},0)) as owned`);
 if(row?.owned!==true)throw Error('Current payroll history source unavailable.');
}
export async function lockPayrollHistoryWriteTx(tx:Tx,tenantId:string){
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'payroll-history:'+tenantId},0))`);
}
export function withPayrollHistoryTenant<T>(ctx:SessionContext,fn:(tx:Tx)=>Promise<T>,options?:{readOnlySnapshot:true}):Promise<T>{
 return withTenant(ctx,async tx=>{await lockPayrollHistoryReadTx(tx,ctx.tenantId);return fn(tx);},options);
}
