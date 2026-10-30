/** Native empty-queue comparison; neither HTTP capacity nor a release receipt. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {and,desc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {pendingProfileTaskMetadata,actionableProfileChangeIds} from '../../core/profile';
import {freshProfileEditPolicyTx} from '../../core/profile-edit-policy';
import {profileRouteReaderPredicate} from '../../core/profile-routing';
import {assertAssignedWorkPrincipalTx} from '../../core/approvals';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';

beforeAll(migrateTestDb);afterAll(closeAll);
// Frozen pre-change algorithm from83d3e4304. The whole original reader is retained
// so both paths use native RLS, principal proof and current decision authority.
async function previous(ctx:SessionContext){
 const candidates=await withTenant(ctx,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,ctx);
  const current=(await freshProfileEditPolicyTx(tx,ctx)).ctx;
  return tx.select({id:s.profileChangeRequest.id,employmentId:s.profileChangeRequest.employmentId,personId:s.profileChangeRequest.personId,
   employee:s.person.fullName,createdAt:s.profileChangeRequest.createdAt}).from(s.profileChangeRequest)
   .innerJoin(s.employment,and(eq(s.employment.id,s.profileChangeRequest.employmentId),eq(s.employment.tenantId,s.profileChangeRequest.tenantId)))
   .leftJoin(s.person,and(eq(s.person.id,s.profileChangeRequest.personId),eq(s.person.tenantId,s.profileChangeRequest.tenantId)))
   .where(and(eq(s.profileChangeRequest.tenantId,ctx.tenantId),eq(s.profileChangeRequest.status,'pending'),profileRouteReaderPredicate(current),
    sql`NOT app.is_self_person(${s.profileChangeRequest.personId})`))
   .orderBy(desc(s.profileChangeRequest.createdAt),s.profileChangeRequest.id);
 });
 if(!candidates.length)return [];
 const allowed=new Set(await actionableProfileChangeIds(ctx,candidates.map(row=>row.id)));
 return candidates.filter(row=>allowed.has(row.id));
}
it('compares profile queue reads for500 actual linked principals without removing native guards',async()=>{
 await resetDb();const b=await seedBase(),base=adminCtx(b);
 const users=Array.from({length:500},(_,i)=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),role:i<2?'hr_admin' as const:'employee' as const}));
 await owner.db.insert(s.person).values(users.map((u,i)=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional profile reader '+i,primaryEmail:u.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2025-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'profile_reader_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:u.role,companyId:u.role==='hr_admin'?null:b.companyId})));
 for(const table of ['person','employment','app_user','role_assignment','profile_change_request'])await owner.client.unsafe('analyze '+table);
 const context=(u:typeof users[number]):SessionContext=>({...base,userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:u.role==='hr_admin'?null:b.companyId}]});
 const phases:Record<string,unknown>={},oldAudit=process.env.AUDIT_HASH_CHAIN_ENABLED;
 process.env.AUDIT_HASH_CHAIN_ENABLED='true';
 try{
  for(const phase of ['previous-before','current','previous-after']){
   const read=phase==='current'?pendingProfileTaskMetadata:previous;
   for(const u of users.slice(0,5))expect(await read(context(u))).toEqual([]);
   await expect(read({...context(users[4]),personId:users[5].personId})).rejects.toThrow();
   await expect(read({...context(users[4]),userId:randomUUID()})).rejects.toThrow();
   const times:number[]=[],started=performance.now();
   const results=await Promise.allSettled(users.map(async u=>{
    const before=performance.now();for(let i=0;i<3;i++)expect(await read(context(u))).toEqual([]);
    times.push(performance.now()-before);
   }));
   const errors=results.flatMap(result=>result.status==='rejected'?[String(result.reason)]:[]);times.sort((a,b)=>a-b);
   phases[phase]={principals:500,readsPerPrincipal:3,elapsedMs:performance.now()-started,p50Ms:times[249],p95Ms:times[474],maxMs:times.at(-1),errors};
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'profile-task-reader.json'),JSON.stringify({kind:'NATIVE_PROFILE_QUEUE_READ_COMPARISON',releaseEligible:false,emptyQueue:true,auditArmed:true,phases},null,2));
   expect(errors).toEqual([]);
  }
 }finally{if(oldAudit===undefined)delete process.env.AUDIT_HASH_CHAIN_ENABLED;else process.env.AUDIT_HASH_CHAIN_ENABLED=oldAudit;}
},240000);
