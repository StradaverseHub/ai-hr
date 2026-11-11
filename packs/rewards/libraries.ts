import 'server-only';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {setupPersonTx,setupAuthority,setupTenant,setupAuditedReadTenant,setupReadTenant,setupLock,setupEvent} from './setup-data';
import {validateRewardLibrary,gradeCodeForLibrary,setupUuid,setupYear,setupReason,RewardSetupError,type RewardLibrary,type LibraryCandidate} from './setup-model';
export type {RewardLibraryVersion} from './setup-query-owner';
import {libraryVersionQueryTx,rewardLibrariesQueryTx,rewardPlanLibraryChoicesQueryTx,type RewardLibraryVersion} from './setup-query-owner';
import {legacyRewardSetupQueryPort} from './setup-legacy-query-port';
/** Descriptive page access only: protected reads and every command re-admit authority.
 * The native manage predicate returns false for denial; database failures propagate
 * instead of continuing an aborted snapshot or masquerading as a permission answer. */
export function rewardLibraryPageAccess(ctx:SessionContext){
 return setupReadTenant(ctx,async tx=>{
  await setupAuthority(tx,null,'library_view');
  const [row]=await tx.execute<{allowed:boolean}>(sql`select app.reward_setup_allowed(null::uuid,'manage') as allowed`);
  return {canManage:row?.allowed===true};
 });
}
export async function libraryVersionTx(tx:Tx,ctx:SessionContext,id:string,requireConfirmed=false):Promise<RewardLibraryVersion>{return libraryVersionQueryTx(tx,ctx,id,requireConfirmed,legacyRewardSetupQueryPort);}
async function checkGradeIds(tx:Tx,_ctx:SessionContext,data:RewardLibrary){const grades=await tx.execute<{id:string;code:string}>(sql`select id,code from app.reward_setup_grade_choices()`);for(const g of data.rows)if(!grades.some(row=>row.id===g.gradeId&&gradeCodeForLibrary(row.code)===g.grade))throw new RewardSetupError('invalid','A library grade must match the active Grade Ladder identity.');}
function auditedLibraryRead<T>(ctx:SessionContext,kind:'salary'|'bonus'|undefined,year:number|undefined,read:(tx:Tx)=>Promise<T>){
 if(year!==undefined)setupYear.parse(year);
 return setupAuditedReadTenant(ctx,async tx=>{
  const result=await read(tx);
  await setupEvent(tx,ctx,'libraries.viewed',null,{kind:kind??null,year:year??null});
  return result;
 });
}
export function rewardLibraries(ctx:SessionContext,kind?:'salary'|'bonus',year?:number){
 return auditedLibraryRead(ctx,kind,year,tx=>rewardLibrariesQueryTx(tx,ctx,kind,year,legacyRewardSetupQueryPort));
}
/** Plans keeps its existing committed view event for the narrower selector. */
export function rewardPlanLibraryChoices(ctx:SessionContext,year:number){
 return auditedLibraryRead(ctx,undefined,year,tx=>rewardPlanLibraryChoicesQueryTx(tx,ctx,year,legacyRewardSetupQueryPort));
}
export function saveRewardLibrary(ctx:SessionContext,raw:unknown){const p=z.object({libraryId:setupUuid.nullable(),versionId:setupUuid.nullable(),expectedLock:z.number().int().nonnegative(),name:z.string().trim().min(1).max(100),year:setupYear,tags:z.array(z.string().trim().min(1).max(80)).max(20),groupDefault:z.boolean(),previousLibraryId:setupUuid.nullable(),sourcePolicyVersionId:setupUuid.nullable().optional(),data:z.unknown(),reason:setupReason}).strict().parse(raw);const data=validateRewardLibrary(p.data);return setupTenant(ctx,async tx=>{await setupAuthority(tx,null,'manage');await setupPersonTx(tx);await setupLock(tx,ctx,'library');await checkGradeIds(tx,ctx,data);let libraryId=p.libraryId;
 if(!libraryId){if(p.sourcePolicyVersionId){if(p.previousLibraryId)throw new RewardSetupError('invalid','Choose one source for the new library.');const {setupPolicySourceTx}=await import('./plan-configuration'),source=await setupPolicySourceTx(tx,p.sourcePolicyVersionId);if(source.policy.year>p.year)throw new RewardSetupError('invalid','Choose a shared source from this year or an earlier year.');}if(p.previousLibraryId){const [prior]=await tx.execute<{kind:string;year:number}>(sql`select kind,year from reward_library where tenant_id=${ctx.tenantId}::uuid and id=${p.previousLibraryId}::uuid`);if(!prior||prior.kind!==data.kind||prior.year>p.year)throw new RewardSetupError('invalid','Choose a prior library of the same kind.');}libraryId=randomUUID();await tx.execute(sql`insert into reward_library(id,tenant_id,kind,name,year,tags,group_default,previous_library_id,source_policy_version_id,created_by) values(${libraryId}::uuid,${ctx.tenantId}::uuid,${data.kind},${p.name},${p.year},ARRAY[${sql.join(p.tags.map(tag=>sql`${tag}`),sql`, `)}]::text[],${p.groupDefault},${p.previousLibraryId}::uuid,${p.sourcePolicyVersionId??null}::uuid,${ctx.userId}::uuid)`);}
 else{const[r]=await tx.execute<{kind:string;name:string;year:number}>(sql`select kind,name,year from reward_library where id=${libraryId}::uuid and tenant_id=${ctx.tenantId}::uuid`);if(!r||r.kind!==data.kind||r.name!==p.name||r.year!==p.year)throw new RewardSetupError('invalid','Existing library identity is fixed; duplicate it to change its name or year.');}
 if(p.versionId){const prior=await libraryVersionTx(tx,ctx,p.versionId);if(prior.libraryId!==libraryId||prior.state!=='draft'||prior.lockVersion!==p.expectedLock)throw new RewardSetupError('changed','Reopen the current draft before saving.');await tx.execute(sql`update reward_library_version set data=${JSON.stringify(data)}::jsonb,reason=${p.reason},lock_version=lock_version+1,updated_at=now() where id=${p.versionId}::uuid and tenant_id=${ctx.tenantId}::uuid`);await setupEvent(tx,ctx,'library.saved',p.versionId,{libraryId});return p.versionId;}
 const id=randomUUID();await tx.execute(sql`insert into reward_library_version(id,tenant_id,library_id,revision,data,state,created_by,contributor_ids,reason) select ${id}::uuid,${ctx.tenantId}::uuid,${libraryId}::uuid,coalesce(max(revision),0)+1,${JSON.stringify(data)}::jsonb,'draft',${ctx.userId}::uuid,array[${ctx.userId}::uuid],${p.reason} from reward_library_version where tenant_id=${ctx.tenantId}::uuid and library_id=${libraryId}::uuid`);await setupEvent(tx,ctx,'library.created',id,{libraryId,sourcePolicyVersionId:p.sourcePolicyVersionId??null});return id;
 });}
export function submitRewardLibrary(ctx:SessionContext,id:string,expectedLock:number){setupUuid.parse(id);return setupTenant(ctx,async tx=>{await setupAuthority(tx,null,'manage');await setupPersonTx(tx);await setupLock(tx,ctx,'library');const v=await libraryVersionTx(tx,ctx,id);if(v.state!=='draft'||v.lockVersion!==expectedLock)throw new RewardSetupError('changed','Reopen the current draft.');validateRewardLibrary(v.data);await checkGradeIds(tx,ctx,v.data);await tx.execute(sql`update reward_library_version set state='pending',lock_version=lock_version+1,updated_at=now() where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid`);await setupEvent(tx,ctx,'library.submitted',id,{libraryId:v.libraryId});});}
export function confirmRewardLibrary(ctx:SessionContext,id:string,expectedLock:number){setupUuid.parse(id);return setupTenant(ctx,async tx=>{await setupAuthority(tx,null,'manage');await setupPersonTx(tx);await setupLock(tx,ctx,'library');const v=await libraryVersionTx(tx,ctx,id);if(v.state!=='pending'||v.lockVersion!==expectedLock)throw new RewardSetupError('changed','Reopen the current pending version.');if(v.contributors.includes(ctx.userId!)||(v.contributorPersonIds??[]).includes(await setupPersonTx(tx)))throw new RewardSetupError('independent','A different Group Rewards user must confirm this version.');validateRewardLibrary(v.data);await checkGradeIds(tx,ctx,v.data);await tx.execute(sql`update reward_library_version set state='confirmed',confirmed_by=${ctx.userId}::uuid,confirmed_at=now(),lock_version=lock_version+1,updated_at=now() where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid`);await setupEvent(tx,ctx,'library.confirmed',id,{libraryId:v.libraryId,version:v.version});});}
export function libraryCandidates(rows:readonly RewardLibraryVersion[]):LibraryCandidate[]{return rows.filter(r=>r.state==='confirmed').map(r=>({id:r.id,libraryId:r.libraryId,name:r.name,year:r.year,version:r.version,kind:r.kind,tags:r.tags,groupDefault:r.groupDefault,previousLibraryId:r.previousLibraryId,...(r.data.kind==='bonus'?{type:r.data.type}:{})}));}
export function rewardLibraryForExport(ctx:SessionContext,id:string){return setupAuditedReadTenant(ctx,async tx=>{const v=await libraryVersionTx(tx,ctx,id);await setupEvent(tx,ctx,'library.exported',id,{libraryId:v.libraryId,version:v.version});return v;});}
export function rewardLibraryGradeChoices(ctx:SessionContext){return setupReadTenant(ctx,async tx=>{await setupAuthority(tx,null,'library_view');const rows=await tx.execute<{id:string;code:string;name:string}>(sql`select * from app.reward_setup_grade_choices()`);return rows.map(r=>({gradeId:r.id,grade:gradeCodeForLibrary(r.code),name:r.name}));});}

export function rewardLibraryHistory(ctx:SessionContext,id:string){
 setupUuid.parse(id);
 return setupReadTenant(ctx,async tx=>{
  await setupAuthority(tx,null,'library_view');
  return [...await tx.execute<{lockVersion:number;actorId:string;occurredAt:string;reason:string;beforeState:string|null;afterState:string;before:RewardLibrary|null;after:RewardLibrary}>(sql`select lock_version as "lockVersion",actor_id as "actorId",occurred_at::text as "occurredAt",reason,before_state as "beforeState",after_state as "afterState",before_values as "before",after_values as "after" from reward_library_revision_audit where version_id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid order by lock_version desc`)];
 });
}
