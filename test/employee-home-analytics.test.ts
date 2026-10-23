import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {recordHomeCardInteractions,readHomeCardInteractions} from '../core/employee-home-analytics';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,caller:SessionContext;
vi.mock('../lib/session',()=>({getSession:async()=>caller}));
const {POST}=await import('../app/api/home/interactions/route');
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function worker(){
 const person=await hireEmployee(adminCtx(b),{person:{fullName:'PRIVATE fictional name',primaryEmail:randomUUID()+'@example.invalid'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur().slice(0,4)+'-01-01'});
 const ctx={...await entitledCtx(b,['employee']),userId:await createAppUser(b.tenantId,person.personId,'employee'),personId:person.personId};
 return {...person,ctx};
}
const body={version:1,events:[{card:'today',action:'view'},{card:'today',action:'click'}]};
const saved=()=>owner.db.execute(sql`SELECT tenant_id,observed_on::text,card,action,interactions::text FROM app.home_card_interaction_count ORDER BY tenant_id,observed_on,card,action`);
const request=(value:unknown,origin='http://localhost')=>new Request('http://localhost/api/home/interactions',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
describe('anonymous Home card observations',()=>{
 it('aggregates actual concurrent interactions under the server tenant/day without retaining individual content or identity',async()=>{
  const own=await worker();await Promise.all([recordHomeCardInteractions(own.ctx,body),recordHomeCardInteractions(own.ctx,body)]);
  expect(Array.from(await saved())).toEqual([
   {tenant_id:b.tenantId,observed_on:todayInKualaLumpur(),card:'today',action:'click',interactions:'2'},
   {tenant_id:b.tenantId,observed_on:todayInKualaLumpur(),card:'today',action:'view',interactions:'2'},
  ]);
  const columns=await owner.db.execute<{column_name:string}>(sql`SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND table_name='home_card_interaction_count' ORDER BY ordinal_position`);
  expect(Array.from(columns).map(row=>row.column_name)).toEqual(['tenant_id','observed_on','card','action','interactions']);
  expect(await readHomeCardInteractions(adminCtx(b))).toEqual(expect.arrayContaining([{card:'today',views:2,clicks:2}]));
 });
 it('refuses raw content-bearing batches, direct table access, missing own identity and revoked actual grants',async()=>{
  const own=await worker();
  expect(()=>recordHomeCardInteractions(own.ctx,{...body,employeeName:'PRIVATE'})).toThrow();
  await expect(withTenant(own.ctx,tx=>tx.execute(sql`SELECT app.record_home_card_interactions(${'[{"card":"today","action":"view","name":"PRIVATE"}]'}::jsonb)`))).rejects.toThrow();
  await expect(withTenant(own.ctx,tx=>tx.execute(sql`SELECT * FROM app.home_card_interaction_count`))).rejects.toThrow();
  await expect(recordHomeCardInteractions(adminCtx(b),body)).rejects.toThrow();
  await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,own.ctx.userId!));
  await expect(recordHomeCardInteractions(own.ctx,body)).rejects.toThrow();expect(Array.from(await saved())).toEqual([]);
 });
 it('refuses ordinary and company-scoped readers, and keeps other-tenant aggregate counts separate',async()=>{
  const own=await worker();await recordHomeCardInteractions(own.ctx,body);
  await expect(readHomeCardInteractions(own.ctx)).rejects.toThrow();
  await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,own.ctx.userId!));
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:own.ctx.userId!,role:'hr_admin',companyId:b.companyId});
  const scoped={...own.ctx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  await expect(readHomeCardInteractions(scoped)).rejects.toThrow();
  const other=await seedBase();expect((await readHomeCardInteractions(adminCtx(other))).every(row=>row.views===0&&row.clicks===0)).toBe(true);
 });
 it('uses the addressed Host for a browser request when Next exposes an internal listener URL',async()=>{
  const own=await worker();caller=own.ctx;
  const addressed=(origin:string,host:string)=>new Request('http://localhost:3311/api/home/interactions',{
   method:'POST',headers:{origin,host,'Content-Type':'application/json'},body:JSON.stringify(body),
  });
  expect((await POST(addressed('http://127.0.0.1:3311','127.0.0.1:3311'))).status).toBe(204);
  const before=Array.from(await saved());
  expect((await POST(addressed('http://foreign.invalid','127.0.0.1:3311'))).status).toBe(400);
  expect((await POST(new Request('http://localhost:3311/api/home/interactions',{
   method:'POST',headers:{origin:'http://foreign.invalid',host:'127.0.0.1:3311','x-forwarded-host':'foreign.invalid','Content-Type':'application/json'},body:JSON.stringify(body),
  }))).status).toBe(400);
  expect(Array.from(await saved())).toEqual(before);
 });
 it('accepts only the bounded same-origin contract and leaves malformed calls without counter effects',async()=>{
  const own=await worker();caller=own.ctx;
  expect((await POST(request(body,'https://other.invalid'))).status).toBe(400);
  expect((await POST(request({...body,url:'/PRIVATE/person'}))).status).toBe(400);
  expect((await POST(request({version:1,events:[{card:'today',action:'view',content:'x'.repeat(3000)}]}))).status).toBe(400);
  expect(Array.from(await saved())).toEqual([]);
  const response=await POST(request(body));expect(response.status).toBe(204);expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(Array.from(await saved())).toHaveLength(2);
 });
});
