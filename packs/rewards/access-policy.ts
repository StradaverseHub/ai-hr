/** Server-side capability owner. Row confidentiality and route authority remain mandatory. */
import 'server-only';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {withRewardsTenant} from '../../core/module-gate';
import {appendEvent,actorOf} from '../../db/events';
import {rewardRoles,type RewardRole} from './model';
import {permissionRows,rolePermission,editableRewardPermission,type RewardCapability,type RewardAccessRole} from './access-policy-model';
export async function rewardSetupAuthorityTx(tx:Tx,_ctx:SessionContext,companyId:string|null|undefined,operation:'library_view'|'manage'){
 const [r]=await tx.execute<{allowed:boolean}>(sql`select app.reward_setup_allowed(${companyId??null}::uuid,${operation}) as allowed`);
 if(!r?.allowed)throw new Error('This Rewards configuration is not available to you.');
}
export async function assertRewardCapabilityTx(tx:Tx,unitId:string,capability:RewardCapability){
 const [r]=await tx.execute<{allowed:boolean}>(sql`select app.reward_capability(${unitId}::uuid,${capability}) as allowed`);if(!r?.allowed)throw new Error('Your Rewards role does not permit this action.');
}
export async function assertRewardWritableTx(tx:Tx){
 const [r]=await tx.execute<{viewing:boolean}>(sql`select exists(select 1 from reward_access_view_session where tenant_id=app.current_tenant_id() and viewer_id=app.current_user_id() and ended_at is null and expires_at>now()) as viewing`);
 if(r?.viewing)throw new Error('End the read-only View as session before changing Rewards.');
}
export async function rewardPermissions(ctx:SessionContext){return withRewardsTenant(ctx,async tx=>{
 await rewardSetupAuthorityTx(tx,ctx,null,'manage');
 const values=await tx.execute<{role:RewardAccessRole;capability:RewardCapability;allowed:boolean}>(sql`select role,capability,allowed from reward_role_permission where tenant_id=app.current_tenant_id() order by role,capability`);
 return{rows:permissionRows,values,roles:rewardRoles,defaults:Object.fromEntries(rewardRoles.map(role=>[role,Object.fromEntries(permissionRows.map(row=>[row.id,rolePermission(role,row.id)]))]))};
});}
export async function changeRewardPermission(ctx:SessionContext,raw:unknown){
 const p=z.object({role:z.enum(['bu','bg','proxy_bg','gr','ctro','ec','pbp','hr_admin','payroll']),capability:z.string(),allowed:z.boolean(),reason:z.string().trim().min(10).max(2000),reset:z.boolean().default(false)}).strict().parse(raw);
 const row=permissionRows.find(x=>x.id===p.capability);if(!row||!editableRewardPermission(p.role,row.id))throw new Error('This route, scope or governance permission is fixed.');
 return withRewardsTenant(ctx,async tx=>{await assertRewardWritableTx(tx);await rewardSetupAuthorityTx(tx,ctx,null,'manage');await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text,2206))`);
 const [before]=await tx.execute<{allowed:boolean}>(sql`select allowed from reward_role_permission where tenant_id=app.current_tenant_id() and role=${p.role} and capability=${row.id} for update`);
 if(p.reset)await tx.execute(sql`delete from reward_role_permission where tenant_id=app.current_tenant_id() and role=${p.role} and capability=${row.id}`);
 else await tx.execute(sql`insert into reward_role_permission(tenant_id,role,capability,allowed,changed_by,reason) values(app.current_tenant_id(),${p.role},${row.id},${p.allowed},app.current_user_id(),${p.reason}) on conflict(tenant_id,role,capability) do update set allowed=excluded.allowed,changed_by=excluded.changed_by,reason=excluded.reason,updated_at=now()`);
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'reward-access',aggregateId:ctx.userId!,eventType:'reward-access.permission.changed',actor:actorOf(ctx),payload:{role:p.role,capability:row.id,before:before?.allowed??null,after:p.reset?null:p.allowed,reason:p.reason}});
 });
}
export function beginRewardViewAs(ctx:SessionContext,userId:string){z.uuid().parse(userId);return withRewardsTenant(ctx,async tx=>{
 await rewardSetupAuthorityTx(tx,ctx,null,'manage');await tx.execute(sql`select app.reward_view_as_principal(${userId}::uuid)`);
 await tx.execute(sql`update reward_access_view_session set ended_at=now() where tenant_id=app.current_tenant_id() and viewer_id=app.current_user_id() and ended_at is null`);
 const [session]=await tx.execute<{id:string}>(sql`insert into reward_access_view_session(tenant_id,viewer_id,target_id) values(app.current_tenant_id(),app.current_user_id(),${userId}::uuid) returning id`);
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'reward-access',aggregateId:session.id,eventType:'reward-access.view-as.started',actor:actorOf(ctx),payload:{targetUserId:userId}});return session.id;
});}
export function endRewardViewAs(ctx:SessionContext){return withRewardsTenant(ctx,async tx=>{const rows=await tx.execute<{id:string}>(sql`update reward_access_view_session set ended_at=now() where tenant_id=app.current_tenant_id() and viewer_id=app.current_user_id() and ended_at is null returning id`);for(const row of rows)await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'reward-access',aggregateId:row.id,eventType:'reward-access.view-as.ended',actor:actorOf(ctx)});});}
export async function rewardViewAsState(ctx:SessionContext){return withRewardsTenant(ctx,async tx=>{
 const [session]=await tx.execute<{id:string;targetId:string}>(sql`select id,target_id as "targetId" from reward_access_view_session where tenant_id=app.current_tenant_id() and viewer_id=app.current_user_id() and ended_at is null and expires_at>now()`);if(!session)return null;
 await rewardSetupAuthorityTx(tx,ctx,null,'manage');const [principal]=await tx.execute<{value:SessionContext}>(sql`select app.reward_view_as_principal(${session.targetId}::uuid) as value`);
 const units=await tx.execute<{id:string;company:string;cycle:string}>(sql`select u.id,c.legal_name as company,y.name as cycle from reward_unit u join company c on c.id=u.company_id and c.tenant_id=u.tenant_id join reward_cycle y on y.id=u.cycle_id and y.tenant_id=u.tenant_id where u.tenant_id=app.current_tenant_id() and u.deleted_at is null and 'gr'=any(array(select app.reward_roles(u.id))) and exists(select 1 from reward_member m where m.unit_id=u.id and m.tenant_id=u.tenant_id and m.user_id=${session.targetId}::uuid and app.reward_member_eligible(m.id)) order by c.legal_name,y.year,u.id`);
 return{session,principal:{...principal.value,entitlements:ctx.entitlements,entitlementsExempt:ctx.entitlementsExempt},units};
 });}
export function resetRewardRolePermissions(ctx:SessionContext,reason:string){const why=z.string().trim().min(10).max(2000).parse(reason);return withRewardsTenant(ctx,async tx=>{await assertRewardWritableTx(tx);await rewardSetupAuthorityTx(tx,ctx,null,'manage');await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text,2206))`);const before=await tx.execute<{role:string;capability:string;allowed:boolean}>(sql`select role,capability,allowed from reward_role_permission where tenant_id=app.current_tenant_id() order by role,capability for update`);await tx.execute(sql`delete from reward_role_permission where tenant_id=app.current_tenant_id()`);await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'reward-access',aggregateId:ctx.userId!,eventType:'reward-access.permissions.reset',actor:actorOf(ctx),payload:{before,reason:why}});});}
