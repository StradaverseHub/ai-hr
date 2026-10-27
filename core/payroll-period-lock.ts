/** Canonical SAME company/month membership/status owner. This is a per-period advisory key,
 * including BEFORE a parent row exists, not a parent-FK fence or a tenant/global table lock.
 * Existing Access ownership is tenant-exclusive: these ordinary roots serialize across a tenant;
 * this source makes NO throughput/latency claim.
 * Busy/partial ownership always requires the WHOLE caller Tx to roll back. No late key upgrades. */
import {eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {payrollBatch,payPeriod} from '../db/schema';
import {lockAccessConfigurationTx} from './access-configuration-lock';
/** Ordinary authenticated kernel owners may carry statutory/bootstrap metadata. Those markers
 * grant NOTHING here. AI source owners apply their stricter no-marker prerequisite separately. */
async function currentPayrollPeriodPrincipalTx(tx:Tx,ctx:SessionContext){
 const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null})),roles=ctx.roles??[...new Set(grants.map(g=>g.role))];
 const [row]=await tx.execute<{allowed:boolean}>(sql`select exists(select 1 from public.app_user u
  where u.id=${ctx.userId??null}::uuid and u.tenant_id=${ctx.tenantId}::uuid and u.id=app.current_user_id()
   and u.tenant_id=app.current_tenant_id() and u.archived_at is null and not app.login_blocked(u.id)
   and (${ctx.personId??null}::uuid is null or u.person_id=${ctx.personId??null}::uuid)
   and current_setting('transaction_isolation')='read committed' and app.principal_snapshot_current()
   and current_setting('app.roles',true)=${roles.join(',')} and current_setting('app.grants',true)::jsonb=${JSON.stringify(grants)}::jsonb) as allowed`);
 if(row?.allowed!==true)throw new PayrollPeriodOwnershipUnavailable();
}
export type PayrollPeriodSelection=Readonly<{companyId:string;payPeriod:string}>;
export class PayrollPeriodOwnershipUnavailable extends Error{constructor(){super('Payroll period is unavailable. Reload the selected run.');this.name='PayrollPeriodOwnershipUnavailable';}}
const canonicalUuid=(value:string)=>{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new PayrollPeriodOwnershipUnavailable();return value.toLowerCase();};
const canonicalMonth=(value:string)=>{if(typeof value!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(value))throw new PayrollPeriodOwnershipUnavailable();return value;};
/** Internal owners feed PostgreSQL-normalized UUID text here. Public pure callers may use canonical
 * hyphen UUID case aliases; no alternate month is guessed or converted into a different key. */
const periodOwnerKey=(tenantId:string,companyId:string,month:string)=>'payroll-period:'+JSON.stringify([tenantId,companyId,month]);
export const payrollPeriodOwnerKey=(tenantId:string,p:PayrollPeriodSelection)=>periodOwnerKey(canonicalUuid(tenantId),canonicalUuid(p.companyId),canonicalMonth(p.payPeriod));
async function canonicalPeriodContextTx(tx:Tx,supplied:SessionContext){const captured={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};const [row]=await tx.execute<{tenantId:string}>(sql`select ${captured.tenantId}::uuid::text as "tenantId"`);return{...captured,tenantId:row.tenantId};}
/** Capture COMPLETE keys before any wait. Existing native financial scope, including ancestors and
 * actual Payroll partners, remains the authority; the key supplies no role or company entitlement. */
export async function lockPayrollPeriodsTx(tx:Tx,supplied:SessionContext,selections:readonly PayrollPeriodSelection[],tryOnly=false){
 const rawContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))},captured=selections.map(p=>({companyId:p.companyId,payPeriod:canonicalMonth(p.payPeriod)}));
 const ctx=await canonicalPeriodContextTx(tx,rawContext),normalized:PayrollPeriodSelection[]=[];
 // UUID casts normalize EVERY spelling the database itself accepts, before any advisory resource.
 for(const p of captured){const [row]=await tx.execute<{companyId:string}>(sql`select ${p.companyId}::uuid::text as "companyId"`);normalized.push({companyId:row.companyId,payPeriod:p.payPeriod});}
 const ordered=[...new Map(normalized.map(p=>[payrollPeriodOwnerKey(ctx.tenantId,p),p] as const)).entries()].sort(([a],[b])=>a.localeCompare(b));
 await lockAccessConfigurationTx(tx,ctx.tenantId);await currentPayrollPeriodPrincipalTx(tx,ctx);
 for(const [,p]of ordered){const [scope]=await tx.execute<{allowed:boolean}>(sql`select exists(select 1 from public.company c where c.id=${p.companyId}::uuid and c.tenant_id=${ctx.tenantId}::uuid and app.can_admin_payroll_for(c.id)) as allowed`);if(scope?.allowed!==true)throw new PayrollPeriodOwnershipUnavailable();}
 for(const [key]of ordered){if(tryOnly){const [row]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as owned`);if(row?.owned!==true)throw new PayrollPeriodOwnershipUnavailable();}else await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);}
 return ordered.map(([,p])=>p);
}
/** Resolve only the RLS-visible key BEFORE period ownership, then reread the SAME key/parent.
 * Every caller invokes this BEFORE OT policy, job, batch, source, employee/credit or Payroll rows. */
export async function lockPayrollBatchPeriodTx(tx:Tx,supplied:SessionContext,batchId:string,tryOnly=false){
 const rawContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))},id=batchId;
 const ctx=await canonicalPeriodContextTx(tx,rawContext);
 await lockAccessConfigurationTx(tx,ctx.tenantId);await currentPayrollPeriodPrincipalTx(tx,ctx);
 const read=()=>tx.select({id:payrollBatch.id,companyId:payrollBatch.companyId,payPeriod:payrollBatch.payPeriod,payPeriodId:payrollBatch.payPeriodId}).from(payrollBatch).where(eq(payrollBatch.id,id)).limit(1);
 const [nominee]=await read();if(!nominee)throw new PayrollPeriodOwnershipUnavailable();
 await lockPayrollPeriodsTx(tx,ctx,[nominee],tryOnly);
 const [current]=await read();if(!current||JSON.stringify(current)!==JSON.stringify(nominee))throw new PayrollPeriodOwnershipUnavailable();
 const [parent]=await tx.select({id:payPeriod.id,companyId:payPeriod.companyId,period:payPeriod.period}).from(payPeriod).where(eq(payPeriod.id,current.payPeriodId)).limit(1);
 if(!parent||parent.companyId!==current.companyId||parent.period!==current.payPeriod)throw new PayrollPeriodOwnershipUnavailable();
 return current;
}
/** NATIVE lifecycle owners (create, additional run, draft delete, process, close, reset, unlock,
 * reprocess, remove employee). They join the SAME tenant Access phase and the SAME company/month
 * advisory key as the reviewed owner above (identical key text for every canonical month), so reviewed
 * custody and native writers still serialize on one owner. This interval adds NO principal, payroll-scope
 * or month-shape refusal of its own: the native writer's existing RLS, granular permission and period
 * rules remain the only authority and keep their existing outcomes and messages. A month the screens
 * cannot validate keys on its exact stored text, the identity pay_period itself compares on. */
export async function lockNativePayrollPeriodsTx(tx:Tx,supplied:SessionContext,selections:readonly PayrollPeriodSelection[]):Promise<void>{
 const rawContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};
 const captured=selections.filter(p=>typeof p?.companyId==='string'&&typeof p?.payPeriod==='string').map(p=>({companyId:p.companyId,payPeriod:p.payPeriod}));
 const ctx=await canonicalPeriodContextTx(tx,rawContext),keys:string[]=[];
 for(const p of captured){const [row]=await tx.execute<{companyId:string}>(sql`select ${p.companyId}::uuid::text as "companyId"`);keys.push(periodOwnerKey(ctx.tenantId,row.companyId,p.payPeriod));}
 await lockAccessConfigurationTx(tx,ctx.tenantId);
 for(const key of [...new Set(keys)].sort((a,b)=>a.localeCompare(b)))await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
}
/** Native batch owners: own the RLS-visible nominee's company/month key, then reread the SAME row.
 * An invisible or vanished batch returns null with no refusal of its own, so the caller's existing read
 * reports its existing not-found outcome. A batch whose company/month moved under the key is refused. */
export async function lockNativePayrollBatchPeriodTx(tx:Tx,supplied:SessionContext,batchId:string){
 const rawContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))},id=batchId;
 if(typeof id!=='string')return null;
 const ctx=await canonicalPeriodContextTx(tx,rawContext);await lockAccessConfigurationTx(tx,ctx.tenantId);
 const read=()=>tx.select({id:payrollBatch.id,companyId:payrollBatch.companyId,payPeriod:payrollBatch.payPeriod,payPeriodId:payrollBatch.payPeriodId}).from(payrollBatch).where(eq(payrollBatch.id,id)).limit(1);
 const [nominee]=await read();if(!nominee)return null;
 await lockNativePayrollPeriodsTx(tx,ctx,[nominee]);
 const [current]=await read();if(!current)return null;
 if(JSON.stringify(current)!==JSON.stringify(nominee))throw new PayrollPeriodOwnershipUnavailable();
 return current;
}
