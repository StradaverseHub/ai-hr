/** Native owned-projection lock comparison. No permission/result cache or writer alteration. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq} from 'drizzle-orm';
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
import {listEmployees,listEmployeesPage,listWorkforcePickOptions,countEmployeesByStatus,employeeDetail} from '../../core/read';
beforeAll(migrateTestDb);afterAll(closeAll);
it('measures500 real principals across five complete Workforce projections with unchanged authority',async()=>{
 await resetDb();const b=await seedBase(),base=adminCtx(b),companies=[b.companyId];
 for(let i=1;i<5;i++){const [co]=await owner.db.insert(s.company).values({tenantId:b.tenantId,country:'MY',legalName:'Fictional lock company '+i}).returning();companies.push(co.id);}
 const users=Array.from({length:500},(_,i)=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),companyId:companies[i%5],role:i<2?'hr_admin' as const:'employee' as const}));
 await owner.db.insert(s.person).values(users.map((u,i)=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional menu '+i,primaryEmail:u.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:u.companyId,hiredOn:'2025-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'menu_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:u.role,companyId:u.role==='hr_admin'?null:u.companyId})));
 const phases:Record<string,unknown>={},reference=new Map<string,unknown>();
 const ctxOf=(u:typeof users[number]):SessionContext=>({...base,userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:u.role==='hr_admin'?null:u.companyId}]});
 async function read(u:typeof users[number]){
  const ctx=ctxOf(u);
  const list=await listEmployees(ctx,companies,'workforce');
  const picker=await listWorkforcePickOptions(ctx,companies);
  const counts=await countEmployeesByStatus(ctx,{companyIds:companies},'workforce');
  const page=await listEmployeesPage(ctx,{companyIds:companies,limit:25,offset:0},'workforce');
  const detail=await employeeDetail(ctx,u.employmentId,'workforce');
  return {list,picker,counts,page,detail};
 }
 try{
  for(const phase of ['exclusive-before','shared-application','exclusive-restored']){
   mode.shared=phase==='shared-application';const times:number[]=[],started=performance.now();
   const results=await Promise.allSettled(users.map(async u=>{
    const before=performance.now(),value=await read(u);times.push(performance.now()-before);
    const count=u.role==='hr_admin'?500:0;
    expect(value.list).toHaveLength(count);expect(value.picker).toHaveLength(count);expect(value.counts.total).toBe(count);
    expect(value.page.total).toBe(count);expect(value.page.rows).toHaveLength(Math.min(count,25));
    if(u.role==='hr_admin')expect(value.detail?.employmentId).toBe(u.employmentId);else expect(value.detail).toBeNull();
    if(!reference.has(u.id))reference.set(u.id,value);else expect(value).toEqual(reference.get(u.id));
   }));
   const u=users[0];
   try{
    await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,u.id));
    expect(await read(u)).toEqual({list:[],picker:[],counts:{total:0,byStatus:{}},page:{rows:[],total:0},detail:null});
   }finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,u.id));}
   expect((await read(u)).counts.total).toBe(500);
   times.sort((a,b)=>a-b);const errors=results.flatMap(result=>result.status==='rejected'?[String(result.reason)]:[]);
   phases[phase]={principals:500,publicReaderCallsPerPrincipal:5,elapsedMs:performance.now()-started,p50Ms:times[249],p95Ms:times[474],maxMs:times.at(-1),errors,orderedValuesExact:true,archiveRefused:true};
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'workforce-read-lock.json'),JSON.stringify({kind:'NATIVE_OWNED_PROJECTION_LOCK_COMPARISON',releaseEligible:false,scope:'500 real principals and five owned readers per principal; unchanged native writer/borrowed locks. Not HTTP acceptance.',phases},null,2));expect(errors).toEqual([]);
  }
 }finally{mode.shared=false;}
},240000);
