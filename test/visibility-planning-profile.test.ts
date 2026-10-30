import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
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
 const oldCompany="FROM (SELECT DISTINCT e.company_id FROM employment e WHERE e.tenant_id = app.current_tenant_id()) c";
 expect(body).toContain(oldCompany);
 const fenced=body.replace('admin_company AS (',"tenant_company AS MATERIALIZED (SELECT DISTINCT e.company_id FROM employment e WHERE e.tenant_id = app.current_tenant_id()), admin_company AS MATERIALIZED (").replace(oldCompany,'FROM tenant_company c');
 const visibilityPlans=await owner.withTenant(probeCtx,async tx=>{
   await tx.execute(sql`SET LOCAL jit = off`);
   const baseline=await tx.execute(sql.raw('explain (analyze,buffers,format json) '+body));
   const candidate=await tx.execute(sql.raw('explain (analyze,buffers,format json) '+fenced));
   const before=await tx.execute(sql.raw(body)),after=await tx.execute(sql.raw(fenced));
   expect(after).toEqual(before);
   return {baseline,candidate};
 });
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/visibility-planning.json',JSON.stringify(visibilityPlans,null,2));
},60000);
