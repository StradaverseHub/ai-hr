/** Shared-mode Workforce authority checks (reader/writer Access lock, payroll wave).
 *
 * core/workforce-access.ts still takes the EXCLUSIVE Access lock before each check, which is right for
 * the callers it serves today. A payroll, statutory or letter writer that now runs under the SHARED lock
 * must not ask for the exclusive one in the same transaction: two such writers would deadlock upgrading.
 * These run the same predicates and refuse with the same WorkforceAccessError, behind the shared barrier
 * (an access configuration editor still cannot change authority while they run). Fold them into
 * core/workforce-access.ts when that module's own barrier converts to shared. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {WorkforceAccessError,type WorkforceOperation} from './workforce-access';

async function sharedWorkforceBarrierTx(tx:Tx,ctx:SessionContext,operation:WorkforceOperation){
 await lockAccessConfigurationTx(tx,ctx.tenantId);
 // 'maintain' joined the SQL barrier, which also holds the generation rows; keep that, in shared mode.
 if(operation==='maintain')await tx.execute(sql`select app.access_workforce_write_lock()`);
}
export async function assertWorkforceEmploymentSharedTx(tx:Tx,ctx:SessionContext,employmentId:string,operation:WorkforceOperation){
 await sharedWorkforceBarrierTx(tx,ctx,operation);
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${employmentId}::uuid,${'workforce.'+operation}) as allowed`);
 if(!row?.allowed)throw new WorkforceAccessError();
}
export async function assertWorkforcePersonSharedTx(tx:Tx,ctx:SessionContext,personId:string,operation:WorkforceOperation){
 await sharedWorkforceBarrierTx(tx,ctx,operation);
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_person(${personId}::uuid,${'workforce.'+operation}) as allowed`);
 if(!row?.allowed)throw new WorkforceAccessError();
}
