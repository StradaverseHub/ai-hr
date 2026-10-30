/** Actual createDb/withTenant, same pool and native context; only unused relational setup differs. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Sql} from 'postgres';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as s from '../../db/schema';
const mode=vi.hoisted(()=>({lean:false}));
vi.mock('drizzle-orm/postgres-js',async original=>{
 const native=await original<typeof import('drizzle-orm/postgres-js')>();
 const schema=await import('../../db/schema');
 return {...native,drizzle:(client:Sql,options:Record<string,unknown>={})=>{
  const {schema:_schema,...rest}=options;
  return mode.lean?native.drizzle(client,rest):native.drizzle(client,{...rest,schema});
 }};
});
import {createDb,type SessionContext} from '../../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('compares500 users with ten real tenant transactions before, without and after relational-schema setup',async()=>{
 await resetDb();const b=await seedBase(),base=adminCtx(b);
 const users=Array.from({length:500},(_,i)=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),name:'Fictional ORM '+i}));
 await owner.db.insert(s.person).values(users.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:u.name,primaryEmail:u.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2025-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'orm_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:'employee' as const,companyId:b.companyId})));
 const phases:Record<string,unknown>={};
 try{
  for(const phase of ['schema-before','lean','schema-after']){
   mode.lean=phase==='lean';const {withTenant}=createDb(process.env.DATABASE_URL!),times:number[]=[],started=performance.now();
   const results=await Promise.allSettled(users.map(async u=>{
    const ctx:SessionContext={...base,userId:u.id,personId:u.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
    const before=performance.now();for(let step=0;step<10;step++){
     const [row]=await withTenant(ctx,tx=>tx.execute(sql`select current_user as role,app.current_tenant_id() as tenant,app.current_user_id() as actor,app.principal_snapshot_current() as current`));
     expect(row).toEqual({role:'ai_hr_app',tenant:b.tenantId,actor:u.id,current:true});
    }times.push(performance.now()-before);
   }));
   times.sort((a,b)=>a-b);const errors=results.flatMap(result=>result.status==='rejected'?[String(result.reason)]:[]);
   phases[phase]={principals:500,transactionsPerPrincipal:10,elapsedMs:performance.now()-started,p50Ms:times[249],p95Ms:times[474],maxMs:times.at(-1),errors};
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'orm-schema-overhead.json'),JSON.stringify({kind:'NATIVE_WITH_TENANT_SCHEMA_OVERHEAD',releaseEligible:false,phases},null,2));expect(errors).toEqual([]);
  }
 }finally{mode.lean=false;}
},180000);
