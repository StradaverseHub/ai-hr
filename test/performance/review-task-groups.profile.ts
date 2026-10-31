/** Reversible native shell-reader comparison; never an HTTP capacity or release receipt. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {pendingReviewTaskGroups,pendingReviewTaskMetadata} from '../../core/employment-review';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';

beforeAll(migrateTestDb);afterAll(closeAll);
it('compares two independent review reads with grouped reads for 500 actual principals',async()=>{
 await resetDb();const b=await seedBase(),base=adminCtx(b);
 // The HTTP fixture's common empty-queue case, using actual linked native principals.
 const users=Array.from({length:500},(_,i)=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),name:'Fictional review reader '+i}));
 await owner.db.insert(s.person).values(users.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:u.name,primaryEmail:u.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2025-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'review_profile_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:'employee' as const,companyId:b.companyId})));
 const context=(u:typeof users[number]):SessionContext=>({...base,userId:u.id,personId:u.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]});
 const independent=async(ctx:SessionContext)=>{
  const [manager,hr]=await Promise.all([pendingReviewTaskMetadata(ctx,'manager'),pendingReviewTaskMetadata(ctx,'hr')]);
  return {manager,hr};
 };
 const phases:Record<string,unknown>={};
 const previous=process.env.AUDIT_HASH_CHAIN_ENABLED;
 // The harness clears this flag during import. Match the audited HTTP app explicitly.
 process.env.AUDIT_HASH_CHAIN_ENABLED='true';
 try{
  for(const u of users.slice(0,20)){
   expect(await independent(context(u))).toEqual({manager:[],hr:[]});
   expect(await pendingReviewTaskGroups(context(u))).toEqual({manager:[],hr:[]});
  }
  for(const phase of ['independent-before','grouped','independent-after']){
   const times:number[]=[],started=performance.now();
   const results=await Promise.allSettled(users.map(async u=>{
    const ctx=context(u),before=performance.now();
    for(let step=0;step<5;step++){
     const result=await (phase==='grouped'?pendingReviewTaskGroups(ctx):independent(ctx));
     expect(result).toEqual({manager:[],hr:[]});
    }
    times.push(performance.now()-before);
   }));
   const elapsedMs=performance.now()-started,errors=results.flatMap(result=>result.status==='rejected'?[String(result.reason)]:[]);
   times.sort((a,b)=>a-b);
   phases[phase]={principals:500,pairsPerPrincipal:5,elapsedMs,p50Ms:times[249],p95Ms:times[474],maxMs:times.at(-1),errors};
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'review-task-groups.json'),JSON.stringify({kind:'NATIVE_REVIEW_QUEUE_GROUPING',releaseEligible:false,emptyQueue:true,auditArmed:true,phases},null,2));
   expect(errors).toEqual([]);
  }
 }finally{
  if(previous===undefined)delete process.env.AUDIT_HASH_CHAIN_ENABLED;
  else process.env.AUDIT_HASH_CHAIN_ENABLED=previous;
 }
},180000);
