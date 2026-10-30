import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {appUser,employment,person,roleAssignment} from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('profiles current permission planning over 500 employments without changing any policies',async()=>{
 await resetDb();const b=await seedBase(),admin=adminCtx(b);
 const users=Array.from({length:500},(_,i)=>({personId:randomUUID(),employmentId:randomUUID(),userId:randomUUID(),name:'Fictional '+i}));
 await owner.db.insert(person).values(users.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:u.name,primaryEmail:u.userId+'@example.invalid'})));
 await owner.db.insert(employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2026-01-01'})));
 await owner.db.insert(appUser).values(users.map(u=>({id:u.userId,tenantId:b.tenantId,personId:u.personId,workosUserId:'fictional_visibility_'+u.userId})));
 await owner.db.insert(roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.userId,role:'employee' as const,companyId:b.companyId})));
 const probe=users[0],probeCtx={...admin,userId:probe.userId,personId:probe.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
 const [{body}]=await owner.client`select prosrc as body from pg_proc where oid='app.visible_employment_ids()'::regprocedure`;
 const original=readFileSync(new URL('../db/migrations/0515_set_based_visibility.sql',import.meta.url),'utf8')
   .split('CREATE OR REPLACE FUNCTION app.visible_employment_ids()')[1].split('AS $$')[1].split('$$;')[0];
 expect(original).toContain('FROM (SELECT DISTINCT e.company_id');
 expect(body).toContain('tenant_company AS MATERIALIZED');
 const fenced=body;
 const visibilityPlans=await owner.withTenant(probeCtx,async tx=>{
   await tx.execute(sql`SET LOCAL jit = off`);
   const baseline=await tx.execute(sql.raw('explain (analyze,buffers,format json) '+original));
   const candidate=await tx.execute(sql.raw('explain (analyze,buffers,format json) '+fenced));
   const before=await tx.execute(sql.raw(original)),after=await tx.execute(sql.raw(fenced));
   expect(Object.values(before[0])[0]).toEqual([probe.employmentId]);
   expect(after).toEqual(before);
   return {baseline,candidate};
 });
 const appVisible=await withTenant(probeCtx,tx=>tx.execute(sql`select app.visible_employment_ids() as ids`));
 expect(appVisible[0].ids).toEqual([probe.employmentId]);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/visibility-planning.json',JSON.stringify(visibilityPlans,null,2));
},60000);
