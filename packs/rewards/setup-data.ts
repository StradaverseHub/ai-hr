import 'server-only';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {withRewardsTenant} from '../../core/module-gate';
import {lockAccessConfigurationTx,lockAccessConfigurationWriteTx} from '../../core/access-configuration-lock';
import {appendEvent,actorOf} from '../../db/events';
import {RewardSetupError} from './setup-model';
export async function setupAuthority(tx:Tx,companyId:string|null,operation:'library_view'|'manage'){
 const[r]=await tx.execute<{allowed:boolean}>(sql`select app.reward_setup_allowed(${companyId}::uuid,${operation}) as allowed`);if(!r?.allowed)throw new RewardSetupError('forbidden','This Rewards configuration is not available to you.');
}
/** Setup commands: they change Rewards configuration that other setup commands read, so they keep the exclusive
 * Access lock. Never use it for a view: an exclusive request queued behind any shared holder stops every new shared
 * caller in the tenant until it is granted or gives up (staging, 11 November 2026). */
export async function setupTenant<T>(ctx:SessionContext,fn:(tx:Tx)=>Promise<T>){if(!ctx.userId)throw new RewardSetupError('forbidden','Sign in to continue.');return withRewardsTenant(ctx,async tx=>{await lockAccessConfigurationWriteTx(tx,ctx.tenantId);return fn(tx);});}
/** Audited setup views and exports: the same native authority, read and History append as setupTenant under the
 * shared Access lock. Setup commands and Access editors still exclude them; views overlap each other and ordinary
 * writers, and a long view never queues an exclusive request ahead of the tenant's other work. */
export async function setupAuditedReadTenant<T>(ctx:SessionContext,fn:(tx:Tx)=>Promise<T>){if(!ctx.userId)throw new RewardSetupError('forbidden','Sign in to continue.');return withRewardsTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,ctx.tenantId);return fn(tx);});}
/** Pure setup presentation owns one database-enforced snapshot. Commands keep setupTenant and audited
 * views setupAuditedReadTenant: their Access lock and History append are intentional.
 * Authority is rechecked from native rows on every call; no cached grant or person
 * claim is used. A snapshot describes data and never authorizes a later mutation. */
export async function setupReadTenant<T>(supplied:SessionContext,fn:(tx:Tx)=>Promise<T>){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};
 if(!ctx.userId)throw new RewardSetupError('forbidden','Sign in to continue.');
 return withRewardsTenant(ctx,async tx=>{
  const [actor]=await tx.execute<{allowed:boolean}>(sql`select exists(select 1 from app_user u
   where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid
    and u.id=app.current_user_id() and u.tenant_id=app.current_tenant_id()
    and u.archived_at is null and not app.login_blocked(u.id)
    and app.principal_snapshot_current()) as allowed`);
  if(actor?.allowed!==true)throw new RewardSetupError('forbidden','This Rewards configuration is not available to you.');
  return fn(tx);
 },{readOnlySnapshot:true});
}
export async function setupLock(tx:Tx,ctx:SessionContext,key='configuration'){await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+key},2203))`);}
export async function setupEvent(tx:Tx,ctx:SessionContext,action:string,id:string|null,payload:unknown){await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'rewards-setup',aggregateId:id??randomUUID(),eventType:'rewards-setup.'+action,actor:actorOf(ctx),payload});}
export async function setupCompanyEligible(tx:Tx,companyId:string,year:number){const[r]=await tx.execute<{ok:boolean}>(sql`select app.reward_setup_company_eligible(${companyId}::uuid,${year}) as ok`);if(!r?.ok)throw new RewardSetupError('invalid','Choose an active legal employer included in this reward year.');}
/** Human independence uses the principal's current stored link, never a caller-supplied person claim. */
export async function setupPersonTx(tx:Tx){const [r]=await tx.execute<{personId:string|null}>(sql`select person_id as "personId" from app_user where id=app.current_user_id() and tenant_id=app.current_tenant_id() and archived_at is null`);if(!r?.personId)throw new RewardSetupError('forbidden','A person-backed Group Rewards account is required.');return r.personId;}
