/** Actual pending queue under an independent native Access reader; no permission mocks. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {hireEmployee,setReportingLine} from '../core/org';
import {checkIn,checkOut,requestAttendanceCorrection,pendingAttendanceTaskMetadata} from '../core/attendance';
import {todayInKualaLumpur} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('reads the exact actionable Attendance queue alongside another metadata reader',async()=>{
 await resetDb();const b=await seedBase(),admin=adminCtx(b);
 const hire=(name:string)=>hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const subject=await hire('Fictional Attendance subject'),manager=await hire('Fictional Attendance manager');
 await setReportingLine(admin,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const login=async(personId:string,role:'employee'|'manager'):Promise<SessionContext>=>({...admin,userId:await createAppUser(b.tenantId,personId,role),personId,roles:[role],grants:[{role,companyId:b.companyId}]});
 const self=await login(subject.personId,'employee'),actor=await login(manager.personId,'manager');
 const day=new Date(todayInKualaLumpur()+'T00:00:00Z');day.setUTCDate(day.getUTCDate()-7);day.setUTCDate(day.getUTCDate()+3-day.getUTCDay());const date=day.toISOString().slice(0,10);
 await checkIn(admin,{employmentId:subject.employmentId,date,time:'08:00',manual:true});
 await checkOut(admin,{employmentId:subject.employmentId,date,time:'17:00',manual:true});
 const {correctionId}=await requestAttendanceCorrection(self,{employmentId:subject.employmentId,date,checkIn:'09:00',checkOut:'18:00',reason:'Fictional native metadata overlap'});
 const baseline=await pendingAttendanceTaskMetadata(actor,[b.companyId]);expect(baseline.map(row=>row.id)).toEqual([correctionId]);
 const states:{role:string;readOnly:boolean;isolation:string}[]=[];
 await owner.client.begin(async holder=>{
  await holder`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  const actual=database.withTenant;
  const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:{readOnlySnapshot:true})=>actual(ctx,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='3s'`);
   const value=await read(tx);
   const [state]=await tx.execute<{role:string;readOnly:boolean;isolation:string}>(sql`select current_user as role,current_setting('transaction_read_only')='on'as "readOnly",current_setting('transaction_isolation')as isolation`);states.push(state);return value;
  },options));
  try{
   const results=await Promise.allSettled([pendingAttendanceTaskMetadata(actor,[b.companyId]),pendingAttendanceTaskMetadata(actor,[b.companyId])]);
   if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'attendance-task-metadata-read-lock.json'),JSON.stringify({kind:'NATIVE_ATTENDANCE_METADATA_READ_OVERLAP_COMPONENT_ONLY',releaseEligible:false,results:results.map(row=>({status:row.status,sqlState:row.status==='rejected'?pgSqlState(row.reason):null})),states},null,2));
   expect(results.map(row=>row.status)).toEqual(['fulfilled','fulfilled']);
   for(const row of results)if(row.status==='fulfilled')expect(row.value).toEqual(baseline);
   expect(states).toEqual(Array.from({length:2},()=>({role:'ai_hr_app',readOnly:true,isolation:'read committed'})));
  }finally{spy.mockRestore();}
 });
 await expect(pendingAttendanceTaskMetadata({...actor,userId:randomUUID()},[b.companyId])).rejects.toThrow();
});
