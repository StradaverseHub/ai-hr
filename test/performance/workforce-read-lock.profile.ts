/** Compare actual scope reads with native exclusive/shared locks; no mocked SQL or authority. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import type {SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
const mode=vi.hoisted(()=>({shared:false}));
vi.mock('../../core/access-configuration-lock',async original=>{
 const native=await original<typeof import('../../core/access-configuration-lock')>();
 return {...native,lockAccessConfigurationReadTx:(...args:Parameters<typeof native.lockAccessConfigurationReadTx>)=>
  mode.shared?native.lockAccessConfigurationReadTx(...args):native.lockAccessConfigurationTx(...args)};
});
import {workforceViewScope} from '../../core/workforce-access';
beforeAll(migrateTestDb);afterAll(closeAll);
it('measures500 live menu reads before, during and after shared-reader scheduling',async()=>{
 await resetDb();const b=await seedBase(),base=adminCtx(b),companies=[b.companyId];
 for(let i=1;i<5;i++){const [co]=await owner.db.insert(s.company).values({tenantId:b.tenantId,country:'MY',legalName:'Fictional lock company '+i}).returning();companies.push(co.id);}
 const users=Array.from({length:500},(_,i)=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),companyId:companies[i%5],role:i<2?'hr_admin' as const:'employee' as const}));
 await owner.db.insert(s.person).values(users.map((u,i)=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional menu '+i,primaryEmail:u.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:u.companyId,hiredOn:'2025-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'menu_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:u.role,companyId:u.role==='hr_admin'?null:u.companyId})));
 const phases:Record<string,unknown>={};
 try{
  for(const phase of ['exclusive-before','shared','exclusive-after']){
   mode.shared=phase==='shared';const times:number[]=[],started=performance.now();
   const results=await Promise.allSettled(users.map(async u=>{
    const ctx:SessionContext={...base,userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:u.role==='hr_admin'?null:u.companyId}]};
    const before=performance.now(),scope=await workforceViewScope(ctx);
    expect(scope).toEqual({companyIds:u.role==='hr_admin'?[...companies].sort():[],canOpen:u.role==='hr_admin'});times.push(performance.now()-before);
   }));
   times.sort((a,b)=>a-b);const errors=results.flatMap(result=>result.status==='rejected'?[String(result.reason)]:[]);
   phases[phase]={principals:500,elapsedMs:performance.now()-started,p50Ms:times[249],p95Ms:times[474],maxMs:times.at(-1),errors};
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'workforce-read-lock.json'),JSON.stringify({kind:'NATIVE_SCOPE_READ_LOCK_EXPERIMENT',releaseEligible:false,phases},null,2));expect(errors).toEqual([]);
  }
 }finally{mode.shared=false;}
},120000);
