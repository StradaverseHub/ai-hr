/** The Rewards Access role permission grid (board db14e49c, docs/adr/2026-11-12-rewards-role-permission-grid.md).
 *
 * Reads: one bounded read of the saved matrix, its latest revision, the waiting batches and the recent versions.
 * Commands: a batch of 1-200 cells saved together or not at all, under the tenant's role-permission advisory lock
 * and an optimistic revision. Each command recomputes the "Review before saving" summary in its own transaction
 * (packs/rewards/config-change), applies the cells, writes one version and one change-log row. A batch by someone
 * without immediate authority waits for an independent checker. The database refuses locked, above-default and
 * own-role cells by itself (migration 5520 and the 5400 self rule). */
import 'server-only';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {withRewardsTenant} from '../../core/module-gate';
import en from '../../messages/en.json';
import {assertRewardWritableTx} from './access-policy';
import {assertRewardConfigReviewed,recordRewardConfigChangeTx,rewardConfigSummary,rewardConfigSummaryDigest,RewardConfigReviewError,type RewardConfigSummary} from './config-change';
import {
 REWARD_PERMISSION_BATCH_LIMIT,rewardAccessRoles,rewardBatchProblems,rewardCellKey,rewardDefaultLevel,effectiveRewardLevel,applyRewardPermissionChanges,
 rewardLevelRank,type RewardAccessRole,type RewardCapability,type RewardLevel,type RewardPermissionChange,type RewardPermissionMatrix,type RewardBatchProblem,
} from './access-policy-model';

export type RewardRolePermissionErrorCode='stale'|'locked'|'forbidden'|'invalid'|'held'|'changed'|'reason'|'decided';
export class RewardRolePermissionError extends Error{
 constructor(public code:RewardRolePermissionErrorCode,message:string,public problems:RewardBatchProblem[]=[]){super(message);this.name='RewardRolePermissionError';}
}

const levelSchema=z.enum(['full','step','view','none']);
const changeSchema=z.object({role:z.enum(rewardAccessRoles),capability:z.string().min(1).max(40),after:levelSchema}).strict();
export const rewardRolePermissionBatchSchema=z.object({
 baseRevision:z.number().int().min(0),
 changes:z.array(changeSchema).min(1).max(REWARD_PERMISSION_BATCH_LIMIT),
 reason:z.string().max(2000).default(''),
 digest:z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
 action:z.enum(['saved','reset','restored']).default('saved'),
 restoredFrom:z.number().int().positive().nullable().optional(),
}).strict();
export type RewardRolePermissionBatchInput=z.input<typeof rewardRolePermissionBatchSchema>;

type Authority={immediate:boolean;seat:boolean;viewingAs:boolean};
async function authorityTx(tx:Tx):Promise<Authority>{
 const [a]=await tx.execute<Authority>(sql`select app.reward_role_permission_immediate() as immediate,app.reward_role_permission_seat() as seat,not coalesce(app.reward_not_viewing_as(),false) as "viewingAs"`);
 return a??{immediate:false,seat:false,viewingAs:false};
}
/** Roles the current principal holds (the self rule): one set-wise statement. */
async function heldRolesTx(tx:Tx):Promise<RewardAccessRole[]>{
 const rows=await tx.execute<{role:RewardAccessRole}>(sql`select r as role from unnest(${sql.raw(`ARRAY[${rewardAccessRoles.map(r=>`'${r}'`).join(',')}]`)}::text[]) r where app.reward_actor_holds_role(r)`);
 return rows.map(r=>r.role);
}
/** The saved matrix. Writers serialise on the tenant's role-permission advisory lock instead of row locks: SELECT ...
 * FOR UPDATE would apply the UPDATE row policies (the self rule) and hide the rows of roles the editor holds. */
async function matrixTx(tx:Tx):Promise<RewardPermissionMatrix>{
 const rows=await tx.execute<{role:RewardAccessRole;capability:RewardCapability;level:RewardLevel|null;allowed:boolean}>(sql`select role,capability,level,allowed from reward_role_permission where tenant_id=app.current_tenant_id() order by role,capability`);
 const matrix:RewardPermissionMatrix={};
 for(const r of rows){const level=r.level??(r.allowed?rewardDefaultLevel(r.role,r.capability):'none');if(level!==rewardDefaultLevel(r.role,r.capability))matrix[rewardCellKey(r.role,r.capability)]=level;}
 return matrix;
}
async function revisionTx(tx:Tx){const [r]=await tx.execute<{revision:number}>(sql`select coalesce(max(revision),0)::int as revision from reward_role_permission_version where tenant_id=app.current_tenant_id()`);return r?.revision??0;}
const lockTx=(tx:Tx)=>tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text,2206))`);

/** English labels for the change log and the summary (stored text; the grid itself is translated on screen). */
const policy=en.rewardAccessPolicy as unknown as {roles:Record<string,string>;levels:Record<string,string>;permissions:Record<string,unknown>};
export function rewardPermissionLabel(capability:string){
 const parts=capability.split('.');let node:unknown=policy.permissions;for(const p of parts)node=(node as Record<string,unknown>|undefined)?.[p];
 return typeof node==='string'?node:capability;
}
const roleLabel=(role:string)=>policy.roles[role]??role;
const levelLabel=(level:string)=>policy.levels[level]??level;

function normalise(input:z.output<typeof rewardRolePermissionBatchSchema>,matrix:RewardPermissionMatrix,held:readonly RewardAccessRole[]){
 const problems=rewardBatchProblems(input.changes,held);
 if(problems.length){
  const code=problems.some(p=>p.code==='held')?'held':problems.some(p=>p.code==='locked')?'locked':'invalid';
  throw new RewardRolePermissionError(code,code==='held'?'You cannot change the permission switches for a role you hold. Ask another Rewards administrator.':code==='locked'?'This cell is fixed and cannot be changed.':'This permission change is not allowed.',problems);
 }
 const changes:RewardPermissionChange[]=input.changes.map(c=>{const capability=c.capability as RewardCapability;return{role:c.role,capability,before:effectiveRewardLevel(c.role,capability,matrix[rewardCellKey(c.role,capability)]),after:c.after};}).filter(c=>c.before!==c.after);
 if(!changes.length)throw new RewardRolePermissionError('invalid','There are no changes to save.');
 return changes;
}
export function rewardRolePermissionSummary(changes:readonly RewardPermissionChange[]):RewardConfigSummary{
 return rewardConfigSummary({area:'role_permission',itemLabel:'Role permissions',
  lines:changes.map(c=>({key:rewardCellKey(c.role,c.capability),label:`${roleLabel(c.role)} · ${rewardPermissionLabel(c.capability)}`,before:levelLabel(c.before),after:levelLabel(c.after)})),
  highImpact:changes.some(c=>rewardLevelRank(c.after)<rewardLevelRank(c.before))?['remove-access']:[]});
}

/** Who can open the Role permissions tab and how their save is treated. */
export function rewardRolePermissionEntry(ctx:SessionContext){
 return withRewardsTenant(ctx,async tx=>{const a=await authorityTx(tx);return{reader:a.immediate||a.seat,immediate:a.immediate,proposer:!a.immediate&&a.seat&&!a.viewingAs};});
}

export type RewardRolePermissionVersion={revision:number;action:'saved'|'reset'|'restored'|'approved';savedAt:string;savedBy:string|null;reason:string;changes:RewardPermissionChange[];matrix:RewardPermissionMatrix;restoredFrom:number|null};
export type RewardRolePermissionRequest={id:string;changes:RewardPermissionChange[];baseRevision:number;reason:string;requestedBy:string;requestedName:string|null;requestedAt:string;status:'pending'|'applied'|'rejected'|'lapsed';decidedName:string|null;decidedAt:string|null;decisionReason:string|null;canDecide:boolean};
export const REWARD_ROLE_PERMISSION_VERSION_LIMIT=50;

/** The grid page read: bounded, authorize-first, four statements. Never returns users or reward figures. */
export function rewardRolePermissionGrid(ctx:SessionContext){
 return withRewardsTenant(ctx,async tx=>{
  const a=await authorityTx(tx);
  if(!a.immediate&&!a.seat)throw new RewardRolePermissionError('forbidden','Role permissions are not available to you.');
  const [matrix,revision,held]=[await matrixTx(tx),await revisionTx(tx),await heldRolesTx(tx)];
  const versions=await tx.execute<RewardRolePermissionVersion>(sql`select v.revision,v.action,v.saved_at::text as "savedAt",p.full_name as "savedBy",v.reason,v.changes,v.matrix,v.restored_from as "restoredFrom"
   from reward_role_permission_version v left join app_user u on u.id=v.saved_by and u.tenant_id=v.tenant_id left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id
   where v.tenant_id=app.current_tenant_id() order by v.revision desc limit ${REWARD_ROLE_PERMISSION_VERSION_LIMIT}`);
  const requests=await tx.execute<Omit<RewardRolePermissionRequest,'canDecide'>>(sql`select q.id,q.changes,q.base_revision as "baseRevision",q.reason,q.requested_by as "requestedBy",rp.full_name as "requestedName",q.requested_at::text as "requestedAt",
    q.status,dp.full_name as "decidedName",q.decided_at::text as "decidedAt",q.decision_reason as "decisionReason"
   from reward_role_permission_request q left join app_user ru on ru.id=q.requested_by and ru.tenant_id=q.tenant_id left join person rp on rp.id=ru.person_id and rp.tenant_id=ru.tenant_id
   left join app_user du on du.id=q.decided_by and du.tenant_id=q.tenant_id left join person dp on dp.id=du.person_id and dp.tenant_id=du.tenant_id
   where q.tenant_id=app.current_tenant_id() order by (q.status='pending') desc,q.requested_at desc,q.id limit 50`);
  return{matrix,revision,heldRoles:held,immediate:a.immediate,proposer:!a.immediate&&a.seat&&!a.viewingAs,viewingAs:a.viewingAs,
   versions:[...versions],requests:requests.map(q=>({...q,canDecide:a.immediate&&!a.viewingAs&&q.status==='pending'&&q.requestedBy!==ctx.userId}))};
 });
}

/** The "Review before saving" summary for a batch, computed in a read transaction. */
export function previewRewardRolePermissionBatch(ctx:SessionContext,raw:unknown){
 const input=rewardRolePermissionBatchSchema.parse(raw);
 return withRewardsTenant(ctx,async tx=>{
  const a=await authorityTx(tx);if(!a.immediate&&!a.seat)throw new RewardRolePermissionError('forbidden','Role permissions are not available to you.');
  const [matrix,revision,held]=[await matrixTx(tx),await revisionTx(tx),await heldRolesTx(tx)];
  if(revision!==input.baseRevision)throw new RewardRolePermissionError('stale','The role permissions changed since you opened them. Reload to see the latest.');
  const summary=rewardRolePermissionSummary(normalise(input,matrix,held));
  return{summary,digest:rewardConfigSummaryDigest(summary),mode:a.immediate?'apply' as const:'request' as const};
 });
}

async function applyTx(tx:Tx,ctx:SessionContext,changes:readonly RewardPermissionChange[],matrix:RewardPermissionMatrix,revision:number,reason:string,action:RewardRolePermissionVersion['action'],summary:RewardConfigSummary,opts:{restoredFrom?:number|null;requestId?:string|null}={}){
 const reverts=changes.filter(c=>c.after===rewardDefaultLevel(c.role,c.capability)),sets=changes.filter(c=>c.after!==rewardDefaultLevel(c.role,c.capability));
 if(reverts.length)await tx.execute(sql`delete from reward_role_permission p using (values ${sql.join(reverts.map(c=>sql`(${c.role},${c.capability})`),sql`,`)}) as x(role,capability)
  where p.tenant_id=app.current_tenant_id() and p.role=x.role and p.capability=x.capability`);
 if(sets.length)await tx.execute(sql`insert into reward_role_permission(tenant_id,role,capability,allowed,level,changed_by,reason)
  values ${sql.join(sets.map(c=>sql`(app.current_tenant_id(),${c.role},${c.capability},${c.after!=='none'},${c.after},app.current_user_id(),${reason})`),sql`,`)}
  on conflict(tenant_id,role,capability) do update set level=excluded.level,allowed=excluded.allowed,changed_by=excluded.changed_by,reason=excluded.reason,updated_at=now()`);
 const next=applyRewardPermissionChanges(matrix,changes);
 // The database stored exactly what was meant: re-read the matrix in the same transaction.
 const stored=await matrixTx(tx);
 if(JSON.stringify(Object.entries(stored).sort())!==JSON.stringify(Object.entries(next).sort()))throw new RewardRolePermissionError('invalid','The role permissions could not be saved as shown.');
 await tx.execute(sql`insert into reward_role_permission_version(tenant_id,revision,action,matrix,changes,reason,saved_by,restored_from,request_id)
  values(app.current_tenant_id(),${revision+1},${action},${JSON.stringify(next)}::jsonb,${JSON.stringify(changes)}::jsonb,${reason},app.current_user_id(),${opts.restoredFrom??null},${opts.requestId??null}::uuid)`);
 await recordRewardConfigChangeTx(tx,ctx,{area:'role_permission',action:action==='saved'?'batch-saved':action==='approved'?'batch-approved':action,itemId:null,itemLabel:'Role permissions',companyIds:[],
  versionRef:String(revision+1),reason,summary,restoredFrom:opts.restoredFrom?String(opts.restoredFrom):null});
 return revision+1;
}

function translateDbError(error:unknown):never{
 if(error instanceof RewardRolePermissionError||error instanceof RewardConfigReviewError)throw error;
 const text=String((error as {cause?:{message?:string}})?.cause?.message??(error as Error)?.message??'');
 if(/role you hold/.test(text))throw new RewardRolePermissionError('held','You cannot change the permission switches for a role you hold. Ask another Rewards administrator.');
 if(/Fixed Rewards role permission/.test(text))throw new RewardRolePermissionError('locked','This cell is fixed and cannot be changed.');
 if(/row-level security|42501|authority required|permission denied/i.test(text))throw new RewardRolePermissionError('forbidden','Role permissions are not available to you.');
 throw error;
}

/** Save a batch. Immediate authority applies it; a proposer's batch waits for approval. All cells or none. */
export async function saveRewardRolePermissionBatch(ctx:SessionContext,raw:unknown):Promise<{mode:'applied';revision:number}|{mode:'requested';requestId:string}>{
 const input=rewardRolePermissionBatchSchema.parse(raw);
 try{return await withRewardsTenant(ctx,async tx=>{
  await assertRewardWritableTx(tx);await lockTx(tx);
  const a=await authorityTx(tx);if(!a.immediate&&!a.seat)throw new RewardRolePermissionError('forbidden','Role permissions are not available to you.');
  const [matrix,revision,held]=[await matrixTx(tx),await revisionTx(tx),await heldRolesTx(tx)];
  if(revision!==input.baseRevision)throw new RewardRolePermissionError('stale','The role permissions changed since you opened them. Reload to see the latest.');
  const changes=normalise(input,matrix,held),summary=rewardRolePermissionSummary(changes);
  const reason=assertRewardConfigReviewed(summary,{reason:input.reason,digest:input.digest});
  if(a.immediate)return{mode:'applied' as const,revision:await applyTx(tx,ctx,changes,matrix,revision,reason,input.action,summary,{restoredFrom:input.action==='restored'?input.restoredFrom??null:null})};
  const [row]=await tx.execute<{id:string}>(sql`insert into reward_role_permission_request(tenant_id,changes,base_revision,reason,requested_by) values(app.current_tenant_id(),${JSON.stringify(changes)}::jsonb,${revision},${reason},app.current_user_id()) returning id`);
  return{mode:'requested' as const,requestId:row.id};
 });}catch(error){translateDbError(error);}
}

/** An independent immediate-authority checker approves or rejects a waiting batch. A batch proposed against an
 * older revision lapses instead of overwriting newer saves. */
export async function decideRewardRolePermissionRequest(ctx:SessionContext,raw:unknown):Promise<{status:'applied'|'rejected'|'lapsed';revision?:number}>{
 const p=z.object({requestId:z.uuid(),approve:z.boolean(),reason:z.string().max(2000).default('')}).strict().parse(raw);
 try{return await withRewardsTenant(ctx,async tx=>{
  await assertRewardWritableTx(tx);await lockTx(tx);
  const a=await authorityTx(tx);if(!a.immediate)throw new RewardRolePermissionError('forbidden','Only Group Rewards, HR Admin or CTRO can decide role permission changes.');
  const [q]=await tx.execute<{id:string;changes:RewardPermissionChange[];baseRevision:number;reason:string;requestedBy:string;status:string}>(sql`select id,changes,base_revision as "baseRevision",reason,requested_by as "requestedBy",status from reward_role_permission_request where id=${p.requestId}::uuid and tenant_id=app.current_tenant_id()`);
  if(!q)throw new RewardRolePermissionError('forbidden','This request is not available.');
  if(q.status!=='pending')throw new RewardRolePermissionError('decided','This request was already decided.');
  if(q.requestedBy===ctx.userId)throw new RewardRolePermissionError('forbidden','An independent checker must decide this request.');
  const decide=(status:'applied'|'rejected'|'lapsed',applied:number|null)=>tx.execute(sql`update reward_role_permission_request set status=${status},decided_by=app.current_user_id(),decided_at=now(),decision_reason=${p.reason.trim()||null},applied_revision=${applied} where id=${q.id}::uuid`);
  if(!p.approve){if(p.reason.trim().length<10)throw new RewardRolePermissionError('reason','Give a reason of at least 10 characters.');await decide('rejected',null);return{status:'rejected' as const};}
  const [matrix,revision,held]=[await matrixTx(tx),await revisionTx(tx),await heldRolesTx(tx)];
  if(revision!==q.baseRevision){await decide('lapsed',null);return{status:'lapsed' as const};}
  const changes=normalise(rewardRolePermissionBatchSchema.parse({baseRevision:revision,changes:q.changes.map(c=>({role:c.role,capability:c.capability,after:c.after})),reason:q.reason}),matrix,held);
  const summary=rewardRolePermissionSummary(changes);
  const next=await applyTx(tx,ctx,changes,matrix,revision,q.reason,'approved',summary,{requestId:q.id});
  await decide('applied',next);
  return{status:'applied' as const,revision:next};
 });}catch(error){translateDbError(error);}
}

/** Export access audit rows: saved batches, waiting/decided batches and the legacy one-cell events. Bounded. */
export const REWARD_ROLE_PERMISSION_AUDIT_LIMIT=2000;
export function rewardRolePermissionAuditRows(ctx:SessionContext){
 return withRewardsTenant(ctx,async tx=>{
  const a=await authorityTx(tx);if(!a.immediate&&!a.seat)throw new RewardRolePermissionError('forbidden','Role permissions are not available to you.');
  const cell=(c:{role:string;capability:string},level:string|null)=>`${roleLabel(c.role)} · ${rewardPermissionLabel(c.capability)}: ${level===null?'Default':levelLabel(level)}`;
  const versions=await tx.execute<{revision:number;action:string;savedAt:string;savedBy:string|null;reason:string;changes:RewardPermissionChange[];requestId:string|null}>(sql`select v.revision,v.action,v.saved_at::text as "savedAt",p.full_name as "savedBy",v.reason,v.changes,v.request_id as "requestId"
   from reward_role_permission_version v left join app_user u on u.id=v.saved_by and u.tenant_id=v.tenant_id left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id
   where v.tenant_id=app.current_tenant_id() order by v.revision desc limit ${REWARD_ROLE_PERMISSION_AUDIT_LIMIT}`);
  const requests=await tx.execute<{id:string;changes:RewardPermissionChange[];requestedBy:string|null;requestedAt:string;status:string;decidedBy:string|null;decidedAt:string|null;reason:string;decisionReason:string|null}>(sql`select q.id,q.changes,rp.full_name as "requestedBy",q.requested_at::text as "requestedAt",q.status,dp.full_name as "decidedBy",q.decided_at::text as "decidedAt",q.reason,q.decision_reason as "decisionReason"
   from reward_role_permission_request q left join app_user ru on ru.id=q.requested_by and ru.tenant_id=q.tenant_id left join person rp on rp.id=ru.person_id and rp.tenant_id=ru.tenant_id
   left join app_user du on du.id=q.decided_by and du.tenant_id=q.tenant_id left join person dp on dp.id=du.person_id and dp.tenant_id=du.tenant_id
   where q.tenant_id=app.current_tenant_id() order by q.requested_at desc limit ${REWARD_ROLE_PERMISSION_AUDIT_LIMIT}`);
  const legacy=await tx.execute<{id:string;eventType:string;at:string;actor:string|null;payload:{role?:string;capability?:string;before?:boolean|null;after?:boolean|null;reason?:string;before_rows?:unknown}&Record<string,unknown>}>(sql`select e.id,e.event_type as "eventType",e.occurred_at::text as at,p.full_name as actor,e.payload
   from domain_event e left join app_user u on u.id=e.actor_id and u.tenant_id=e.tenant_id left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id
   where e.tenant_id=app.current_tenant_id() and e.aggregate_type='reward-access' and e.event_type in('reward-access.permission.changed','reward-access.permissions.reset') order by e.occurred_at desc limit ${REWARD_ROLE_PERMISSION_AUDIT_LIMIT}`);
  const flag=(v:boolean|null|undefined)=>v===null||v===undefined?null:v?'Default':'none';
  type Row=[string,string,string,string,string,string,string,string,string,string,string,string];
  const rows:Row[]=[];
  for(const v of versions)for(const c of v.changes)rows.push([v.requestId??`version ${v.revision}`,'Role permissions','','',v.savedBy??'',cell(c,c.before),cell(c,c.after),`batch-${v.action}`,v.savedAt,v.action==='approved'?v.savedBy??'':'',v.reason,'']);
  for(const q of requests)for(const c of q.changes){
   rows.push([q.id,'Role permissions','','',q.requestedBy??'',cell(c,c.before),cell(c,c.after),'batch-requested',q.requestedAt,'',q.reason,'']);
   if(q.decidedAt&&q.status!=='applied')rows.push([q.id,'Role permissions','','',q.requestedBy??'',cell(c,c.before),cell(c,c.after),`batch-${q.status}`,q.decidedAt,q.decidedBy??'',q.decisionReason??'','']);
  }
  for(const e of legacy){
   if(e.eventType==='reward-access.permission.changed'&&e.payload.role&&e.payload.capability){
    const c={role:e.payload.role,capability:e.payload.capability},before=flag(e.payload.before),after=flag(e.payload.after);
    rows.push([e.id,'Role permissions','','',e.actor??'',cell(c,before),cell(c,after),'permission.changed',e.at,'',String(e.payload.reason??''),'']);
   }else{
    const before=Array.isArray(e.payload.before)?e.payload.before as {role:string;capability:string;allowed:boolean}[]:[];
    for(const c of before)rows.push([e.id,'Role permissions','','',e.actor??'',cell(c,c.allowed?'Default':'none'),cell(c,null),'permissions.reset',e.at,'',String(e.payload.reason??''),'']);
   }
  }
  return rows;
 });
}
