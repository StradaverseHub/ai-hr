/** Native comparison of the shared preview and full assigned-work entry points. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {client,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {listPendingTasks,pendingTaskSummary,type InboxModules} from '../../core/approvals-inbox';
import {hireEmployee,setReportingLine} from '../../core/org';
import {AssignedWorkPrincipalUnavailableError} from '../../lib/assigned-work';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();});
const modules:InboxModules={attendance:false,claims:false,performance:false,rewards:false};
const options={noticeAcknowledgements:false};
const original=(ctx:SessionContext,scope?:string[])=>listPendingTasks(ctx,scope,modules,options);
const candidate=async(ctx:SessionContext,scope?:string[])=>{
 const full=await pendingTaskSummary(ctx,scope,modules,options);
 expect(full.total).toBe(full.items.length);
 return full.items;
};
const sqlState=async(p:Promise<unknown>)=>{try{await p;}catch(error){let e=error as {code?:string;cause?:unknown};while(e&&!e.code)e=e.cause as typeof e;return e?.code;}return undefined;};
it('coalesces four sparse header owners without omitting any actual assigned work or error',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),group=adminCtx(b),today=todayInKualaLumpur();
 const hire=(name:string)=>hireEmployee(group,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const subject=await hire('Fictional decision subject'),manager=await hire('Fictional reporting manager'),outsider=await hire('Fictional unrelated employee');
 await setReportingLine(group,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const actor=async(personId:string):Promise<SessionContext>=>({...group,userId:await createAppUser(b.tenantId,personId,'employee'),personId,roles:['employee'],grants:[{role:'employee',companyId:null}]});
 const managerCtx=await actor(manager.personId),otherCtx=await actor(outsider.personId),scope=[b.companyId];
 const [leave]=await owner.db.insert(s.leaveRequest).values({tenantId:b.tenantId,employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:today,endDate:today,days:'1',status:'approved'}).returning();
 const cancellation={tenantId:b.tenantId,employmentId:subject.employmentId,leaveRequestId:leave.id,cancelDates:[today],requestedDays:'1'};
 const resignation={tenantId:b.tenantId,employmentId:subject.employmentId,personId:subject.personId,lastWorkingDay:today};
 const review={tenantId:b.tenantId,employmentId:subject.employmentId,personId:subject.personId,managerEmploymentId:manager.employmentId,endDate:today,dueDate:today};
 await owner.db.insert(s.leaveCancellationRequest).values(Array.from({length:500},()=>({...cancellation,status:'rejected'})));
 await owner.db.insert(s.resignationRequest).values(Array.from({length:500},()=>({...resignation,status:'rejected' as const})));
 await owner.db.insert(s.employmentReview).values(Array.from({length:500},()=>({...review,reviewType:'contract' as const,status:'cancelled' as const})));
 const nativeBegin=client.begin;let active=false,trips=0,transactions=0;
 vi.spyOn(client,'begin').mockImplementation(((...args:unknown[])=>{if(active)transactions++;const i=args.findIndex(v=>typeof v==='function'),cb=args[i] as(native:typeof client)=>unknown;
  args[i]=(native:typeof client)=>cb(new Proxy(native,{get(target,key,receiver){if(key==='unsafe')return(...query:unknown[])=>{if(active)trips++;return Reflect.apply(target.unsafe,target,query);};return Reflect.get(target,key,receiver);}}));return Reflect.apply(nativeBegin,client,args);
 }) as typeof client.begin);
 const measure=async(read:typeof original)=>{trips=0;transactions=0;active=true;const start=performance.now();try{
  const values=await Promise.all(Array.from({length:40},(_,i)=>read([group,managerCtx,otherCtx][i%3],scope)));expect(values.every(value=>value.length===0)).toBe(true);return{elapsedMs:performance.now()-start,trips,transactions};
 }finally{active=false;}};
 const phases={original:await measure(original),candidate:await measure(candidate),warm:await measure(candidate),restored:await measure(original)};
 expect(phases.original.transactions-phases.candidate.transactions).toBe(160);
 expect(phases.original.trips-phases.candidate.trips).toBe(400);
 expect(await sqlState(original(group,['not-a-uuid']))).toBe('22P02');expect(await sqlState(candidate(group,['not-a-uuid']))).toBe('22P02');
 const [cancel]=await owner.db.insert(s.leaveCancellationRequest).values(cancellation).returning();
 const [resign]=await owner.db.insert(s.resignationRequest).values(resignation).returning();
 const [mgr]=await owner.db.insert(s.employmentReview).values({...review,reviewType:'probation'}).returning();
 const [hr]=await owner.db.insert(s.employmentReview).values({...review,reviewType:'contract',status:'pending_hr'}).returning();
 for(const [ctx,companies] of [[group,scope],[managerCtx,scope],[otherCtx,scope],[adminCtx(foreign),[foreign.companyId]],[group,[]],[group,[foreign.companyId]]] as [SessionContext,string[]][]){expect(await candidate(ctx,companies)).toEqual(await original(ctx,companies));}
 const g=await candidate(group,scope),m=await candidate(managerCtx,scope);
 expect(g.filter(row=>row.kind==='leaveCancellation').map(row=>row.id)).toEqual([cancel.id]);
 expect(g.filter(row=>row.kind==='resignation').map(row=>row.id)).toEqual([resign.id]);
 expect(g.filter(row=>row.kind==='hrReview').map(row=>row.id)).toEqual([hr.id]);
 expect(m.filter(row=>row.kind==='managerReview').map(row=>row.id)).toEqual([mgr.id]);
 const forged={...otherCtx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};await expect(candidate(forged,scope)).rejects.toBeInstanceOf(AssignedWorkPrincipalUnavailableError);
 await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,b.adminUserId));
 try{await expect(candidate(group,scope)).rejects.toBeInstanceOf(AssignedWorkPrincipalUnavailableError);}finally{await owner.db.update(s.roleAssignment).set({role:'hr_admin'}).where(eq(s.roleAssignment.appUserId,b.adminUserId));}
 await owner.client.unsafe('REVOKE SELECT ON public.resignation_request FROM ai_hr_app');
 await owner.client.unsafe('GRANT SELECT(id,tenant_id,employment_id,person_id,status) ON public.resignation_request TO ai_hr_app');
 try{expect(await sqlState(original(group,[]))).toBe('42501');expect(await sqlState(candidate(group,[]))).toBe('42501');}
 finally{await owner.client.unsafe('GRANT SELECT ON public.resignation_request TO ai_hr_app');await owner.client.unsafe('REVOKE SELECT(id,tenant_id,employment_id,person_id,status) ON public.resignation_request FROM ai_hr_app');}
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'sparse-home-task-summary.json'),JSON.stringify({kind:'NATIVE_SPARSE_HOME_TASK_SUMMARY',releaseEligible:false,historicalRows:1500,concurrentReads:40,phases,positiveOwnersPreserved:true,forgedRevokedForeignAndScopeRefused:true,malformedScopeAndColumnErrorsPreserved:true,limitations:'Native task summary only. Browser and 500-user results are separate.'},null,2));
},300000);
