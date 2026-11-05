import 'server-only';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {withRewardsTenant} from '../../core/module-gate';
import {lockAccessConfigurationTx} from '../../core/access-configuration-lock';
import {appendEvent,actorOf} from '../../db/events';
import {RewardSetupError} from './setup-model';
export async function setupAuthority(tx:Tx,companyId:string|null,operation:'library_view'|'manage'){
 const[r]=await tx.execute<{allowed:boolean}>(sql`select app.reward_setup_allowed(${companyId}::uuid,${operation}) as allowed`);if(!r?.allowed)throw new RewardSetupError('forbidden','This Rewards configuration is not available to you.');
}
export async function setupTenant<T>(ctx:SessionContext,fn:(tx:Tx)=>Promise<T>){if(!ctx.userId)throw new RewardSetupError('forbidden','Sign in to continue.');return withRewardsTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,ctx.tenantId);return fn(tx);});}
export async function setupLock(tx:Tx,ctx:SessionContext,key='configuration'){await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+key},2203))`);}
export async function setupEvent(tx:Tx,ctx:SessionContext,action:string,id:string|null,payload:unknown){await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'rewards-setup',aggregateId:id??randomUUID(),eventType:'rewards-setup.'+action,actor:actorOf(ctx),payload});}
export async function setupCompanyEligible(tx:Tx,companyId:string,year:number){const[r]=await tx.execute<{ok:boolean}>(sql`select app.reward_setup_company_eligible(${companyId}::uuid,${year}) as ok`);if(!r?.ok)throw new RewardSetupError('invalid','Choose an active legal employer included in this reward year.');}
/** Human independence uses the principal's current stored link, never a caller-supplied person claim. */
export async function setupPersonTx(tx:Tx){const [r]=await tx.execute<{personId:string|null}>(sql`select person_id as "personId" from app_user where id=app.current_user_id() and tenant_id=app.current_tenant_id() and archived_at is null`);if(!r?.personId)throw new RewardSetupError('forbidden','A person-backed Group Rewards account is required.');return r.personId;}
