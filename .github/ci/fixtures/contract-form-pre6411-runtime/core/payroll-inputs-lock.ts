import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {acquireBoundedAdvisoryLockTx} from './access-configuration-lock';

/**
 * Payroll inputs serialiser (reader/writer Access lock, payroll wave).
 *
 * While every payroll writer held the tenant Access lock exclusively, nothing could change an
 * employee's salary, statutory profile, fixed pay items, payroll policy or a draft run's payroll input
 * while a payroll run was reading them. Under the shared Access lock those writers overlap each other,
 * so they now meet a payroll run on one key per company instead:
 *
 * - Input writers take payroll-inputs:<tenant>:<company> in SHARED mode for every company that employs
 *   the subject. They overlap each other freely.
 * - Payroll lifecycle owners (create, process, reprocess, close, reset, unlock, delete, remove) take it
 *   EXCLUSIVELY for their run's company, through core/payroll-period-lock.ts.
 *
 * So a change either commits before the run reads its inputs (the run includes it), or waits for the
 * run to commit and then finds the processed run and marks it for recalculation through the existing
 * payroll_batch.needs_recalc_at owner. A wait that reaches the Access-lock bound raises the same
 * retryable 55P03 as before, and nothing is written.
 *
 * Order: Access lock, then payroll period keys, then payroll inputs keys (sorted), then rows. An input
 * writer never takes a period key, so it cannot invert against a lifecycle owner.
 */
const inputsKey=(tenantId:string,companyId:string)=>'payroll-inputs:'+tenantId+':'+companyId;

async function heldExclusively(tx:Tx,key:string):Promise<boolean>{
 const [row]=await tx.execute<{held:boolean}>(sql`select exists(select 1 from pg_catalog.pg_locks l
  where l.locktype='advisory' and l.pid=pg_backend_pid() and l.granted and l.objsubid=1 and l.mode='ExclusiveLock'
   and ((l.classid::bigint<<32)|l.objid::bigint)=hashtextextended(${key},0)) as held`);
 return row?.held===true;
}
async function heldShared(tx:Tx,key:string):Promise<boolean>{
 const [row]=await tx.execute<{held:boolean}>(sql`select exists(select 1 from pg_catalog.pg_locks l
  where l.locktype='advisory' and l.pid=pg_backend_pid() and l.granted and l.objsubid=1 and l.mode='ShareLock'
   and ((l.classid::bigint<<32)|l.objid::bigint)=hashtextextended(${key},0)) as held`);
 return row?.held===true;
}

/** Shared mode for the companies employing these employments and/or this person. Resolved by the
 * database for the current tenant, independent of the caller's read scope. */
export async function lockPayrollInputsTx(tx:Tx,subject:{employmentIds?:readonly string[];personId?:string|null}){
 const ids=[...new Set((subject.employmentIds??[]).filter((id):id is string=>typeof id==='string'))];
 if(!ids.length&&!subject.personId)return;
 const keys=await tx.execute<{key:string}>(sql`select k as key from app.payroll_input_lock_keys(
  ARRAY(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid[],${subject.personId??null}::uuid) k`);
 for(const {key} of keys)await acquireBoundedAdvisoryLockTx(tx,key,true);
}

/** Exclusive mode for payroll lifecycle owners. Ids must already be PostgreSQL-normalised UUID text. */
export async function lockPayrollRunInputsTx(tx:Tx,tenantId:string,companyIds:readonly string[],tryOnly=false):Promise<boolean>{
 for(const key of [...new Set(companyIds.map(companyId=>inputsKey(tenantId,companyId)))].sort()){
  // Test-only: an input writer that later becomes a lifecycle owner would upgrade, and two such
  // transactions deadlock. Strict mode makes that misordering fail deterministically.
  if(process.env.AIHR_ACCESS_LOCK_STRICT==='on'&&await heldShared(tx,key)&&!await heldExclusively(tx,key)){
   throw new Error('Payroll inputs strict mode: shared holder requested the exclusive lock');
  }
  if(tryOnly){
   const [row]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as owned`);
   if(row?.owned!==true)return false;
  }else await acquireBoundedAdvisoryLockTx(tx,key,false);
 }
 return true;
}
