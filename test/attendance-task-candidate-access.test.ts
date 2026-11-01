import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee,setReportingLine} from '../core/org';
import {pendingAttendanceTaskMetadata,checkIn,checkOut,requestAttendanceCorrection} from '../core/attendance';
import {todayInKualaLumpur} from '../lib/hr-date';
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

it('retains unrouted administrative assignments for an actual manager without a Manager role',async()=>{
 const worker=await employee(),manager=await employee(),root=adminCtx(b),today=todayInKualaLumpur();
 const workers=await owner.client`select id from employment where tenant_id=${b.tenantId}::uuid and person_id=${worker.personId!}::uuid`;
 const managers=await owner.client`select id from employment where tenant_id=${b.tenantId}::uuid and person_id=${manager.personId!}::uuid`;
 expect(workers).toHaveLength(1);expect(managers).toHaveLength(1);
 await setReportingLine(root,{subordinateEmploymentId:workers[0].id,managerEmploymentId:managers[0].id,lineType:'administrative',validFrom:'2020-01-01'});
 await checkIn(root,{employmentId:workers[0].id,date:today,time:'08:00',manual:true});
 await checkOut(root,{employmentId:workers[0].id,date:today,time:'17:00',manual:true});
 const request=await requestAttendanceCorrection(worker,{employmentId:workers[0].id,date:today,checkIn:'09:00',checkOut:'18:00',reason:'Fictional unrouted task precheck'});
 expect(await owner.client`select id from attendance_workflow_request where correction_id=${request.correctionId}::uuid`).toHaveLength(0);
 expect(manager.roles).toEqual(['employee']);
 expect((await pendingAttendanceTaskMetadata(manager,[b.companyId])).map(row=>row.id)).toEqual([request.correctionId]);
 expect(await pendingAttendanceTaskMetadata(worker,[b.companyId])).toEqual([]);
});
