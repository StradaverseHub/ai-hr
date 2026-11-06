import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {pendingAttendanceTaskMetadata} from '../core/attendance';
import {adminCtx,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');});
async function employee(){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional unassigned task reader',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,'employee');
 const ctx:SessionContext={...adminCtx(b),userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 return ctx;
}
it('avoids the correction scan for a validated unassigned employee and retains the full HR reader',async()=>{
 const ctx=await employee();
 // This reproduces the costly call-site scan directly: the original reader fails with
 //42501, while the negative candidate path has no need to read corrections at all.
 await owner.client.unsafe('REVOKE SELECT ON public.attendance_correction FROM ai_hr_app');
 const [gate]=await owner.client`select pg_get_functiondef('app.may_have_attendance_task_metadata()'::regprocedure)as definition`;
 try{
  await owner.client.unsafe(gate.definition.replace(/AS (\$[^$]*\$)[\s\S]*\1/,(_all:string,d:string)=>'AS '+d+' BEGIN RETURN true; END; '+d));
  await expect(pendingAttendanceTaskMetadata(ctx,[b.companyId])).rejects.toThrow();
  await owner.client.unsafe(gate.definition);
  expect(await pendingAttendanceTaskMetadata(ctx,[b.companyId])).toEqual([]);
  await expect(pendingAttendanceTaskMetadata(adminCtx(b),[b.companyId])).rejects.toThrow();
 }finally{await owner.client.unsafe(gate.definition);await owner.client.unsafe('GRANT SELECT ON public.attendance_correction TO ai_hr_app');}
});
it('validates actual identity and person binding before returning an empty task queue',async()=>{
 const ctx=await employee();
 expect(await pendingAttendanceTaskMetadata(ctx)).toEqual([]);
 await expect(pendingAttendanceTaskMetadata({...ctx,personId:randomUUID()})).rejects.toThrow();
 await expect(pendingAttendanceTaskMetadata({...ctx,userId:randomUUID()})).rejects.toThrow();
 await expect(pendingAttendanceTaskMetadata({...ctx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]})).rejects.toThrow();
});
it('uses UUID-native frozen actor keys and a private stable precheck with no caller-supplied identity',async()=>{
 const ctx=await employee(),actor={userId:ctx.userId!.toUpperCase().replaceAll('-',''),personId:ctx.personId!.toUpperCase()};
 for(const [shape,payload]of [['stages',[{approvers:[actor]}]],['actors',[actor]],['actor',actor]]as const){
  const [row]=await withTenant(ctx,tx=>tx.execute<{ids:string[]}>(sql`select app.attendance_frozen_actor_identity_keys(${JSON.stringify(payload)}::jsonb,${shape})as ids`));
  expect(row.ids.sort()).toEqual([ctx.userId!,ctx.personId!].sort());
 }
 const [attrs]=await owner.client`select prosecdef,provolatile,proargtypes::text as args,proconfig from pg_proc where oid='app.may_have_attendance_task_metadata()'::regprocedure`;
 expect(attrs).toMatchObject({prosecdef:true,provolatile:'s',args:''});
 expect(attrs.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
 const [acl]=await owner.client`select exists(select 1 from pg_proc p,lateral aclexplode(p.proacl)a where p.oid='app.may_have_attendance_task_metadata()'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE')as public_execute`;
 expect(acl.public_execute).toBe(false);
});

it('refuses a changed Attendance SELECT policy before installing the optimized reader',async()=>{
 const source=readFileSync(new URL('../db/migrations/2503_attendance_pending_visible_headers.sql',import.meta.url),'utf8');
 const end=source.indexOf('CREATE FUNCTION app.attendance_pending_visible_headers');
 expect(end).toBeGreaterThan(0);
 await expect(owner.client.begin(async tx=>{
  await tx.unsafe('create policy test_unreviewed_attendance_read on public.attendance_correction for select using (true)');
  await tx.unsafe(source.slice(0,end));
 })).rejects.toMatchObject({code:'55000',message:'Attendance correction read policies differ from the reviewed source'});
 const [drift]=await owner.client`select count(*)::int as count from pg_policies
  where schemaname='public' and tablename='attendance_correction' and policyname='test_unreviewed_attendance_read'`;
 expect(drift.count).toBe(0);
});
