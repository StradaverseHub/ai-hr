/** Test-only native absence proof. Positive or uncertain results always use the original task owners. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql,type SQL} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {client,withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {assertAssignedWorkPrincipalTx} from '../../core/approvals';
import {pendingLeaveCancellationTaskMetadata} from '../../packs/leave/service';
import {pendingResignationTaskMetadata} from '../../core/offboarding';
import {pendingReviewTaskMetadata} from '../../core/employment-review';
import {hireEmployee,setReportingLine} from '../../core/org';
import {AssignedWorkPrincipalUnavailableError} from '../../lib/assigned-work';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();});
const original=(ctx:SessionContext,scope?:string[])=>Promise.all([pendingLeaveCancellationTaskMetadata(ctx,scope),pendingResignationTaskMetadata(ctx,scope),pendingReviewTaskMetadata(ctx,'manager',scope),pendingReviewTaskMetadata(ctx,'hr',scope)]);
const candidate=async(ctx:SessionContext,scope?:string[]):ReturnType<typeof original>=>{
 const possible=await withTenant(ctx,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,ctx);
  const inside=(column:SQL)=>scope===undefined?sql`true`:sql`${column}=any(ARRAY[${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`;
  // Same source metadata columns, joins, RLS, self/purpose/scope predicates as the current owners.
  // EXISTS does not project DTOs. Keep the selected columns to preserve column-grant validation.
  const [row]=await tx.execute<{possible:boolean}>(sql`select (
   exists(select c.id,c.employment_id,c.created_at,a.person_id,a.employee from public.leave_cancellation_request c
    join lateral app.delegated_approval_subject(c.employment_id,'leave','leave.cancellation') a on true
    where c.tenant_id=${ctx.tenantId}::uuid and c.status='pending' and not app.is_self_person(a.person_id) and ${inside(sql`a.company_id`)})
   or exists(select r.id,r.employment_id,r.person_id,p.full_name,r.created_at from public.resignation_request r
    join public.employment e on e.id=r.employment_id and e.tenant_id=r.tenant_id
    left join public.person p on p.id=r.person_id and p.tenant_id=r.tenant_id
    where r.tenant_id=${ctx.tenantId}::uuid and r.status='pending' and not app.is_self_person(r.person_id) and ${inside(sql`e.company_id`)})
   or exists(select r.id,r.employment_id,r.person_id,p.full_name,r.created_at,r.due_date,r.manager_employment_id from public.employment_review r
    join public.employment e on e.id=r.employment_id and e.tenant_id=r.tenant_id
    left join public.person p on p.id=r.person_id and p.tenant_id=r.tenant_id
    where r.tenant_id=${ctx.tenantId}::uuid and not app.is_self_person(r.person_id) and not app.probation_legacy_review_owned(r.id) and ${inside(sql`e.company_id`)}
    and (r.status='pending_hr' or (r.status='pending_manager' and exists(select 1 from public.employment m where m.id=r.manager_employment_id and m.tenant_id=r.tenant_id and app.is_self_person(m.person_id)))))
   ) as possible`);
  return row?.possible!==false;
 });
 return possible?original(ctx,scope):[[],[],[],[]];
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
  const values=await Promise.all(Array.from({length:40},(_,i)=>read([group,managerCtx,otherCtx][i%3],scope)));expect(values.every(value=>value.flat().length===0)).toBe(true);return{elapsedMs:performance.now()-start,trips,transactions};
 }finally{active=false;}};
 const phases={original:await measure(original),candidate:await measure(candidate),warm:await measure(candidate),restored:await measure(original)};
 expect(phases.candidate.transactions).toBe(40);expect(phases.original.transactions).toBe(200);expect(phases.candidate.trips).toBeLessThan(phases.original.trips*.5);
 expect(await sqlState(original(group,['not-a-uuid']))).toBe('22P02');expect(await sqlState(candidate(group,['not-a-uuid']))).toBe('22P02');
 const [cancel]=await owner.db.insert(s.leaveCancellationRequest).values(cancellation).returning();
 const [resign]=await owner.db.insert(s.resignationRequest).values(resignation).returning();
 const [mgr]=await owner.db.insert(s.employmentReview).values({...review,reviewType:'probation'}).returning();
 const [hr]=await owner.db.insert(s.employmentReview).values({...review,reviewType:'contract',status:'pending_hr'}).returning();
 for(const [ctx,companies] of [[group,scope],[managerCtx,scope],[otherCtx,scope],[adminCtx(foreign),[foreign.companyId]],[group,[]],[group,[foreign.companyId]]] as [SessionContext,string[]][]){expect(await candidate(ctx,companies)).toEqual(await original(ctx,companies));}
 const g=await candidate(group,scope),m=await candidate(managerCtx,scope);expect(g[0].map(row=>row.id)).toEqual([cancel.id]);expect(g[1].map(row=>row.id)).toEqual([resign.id]);expect(g[3].map(row=>row.id)).toEqual([hr.id]);expect(m[2].map(row=>row.id)).toEqual([mgr.id]);
 const forged={...otherCtx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};await expect(candidate(forged,scope)).rejects.toBeInstanceOf(AssignedWorkPrincipalUnavailableError);
 await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,b.adminUserId));
 try{await expect(candidate(group,scope)).rejects.toBeInstanceOf(AssignedWorkPrincipalUnavailableError);}finally{await owner.db.update(s.roleAssignment).set({role:'hr_admin'}).where(eq(s.roleAssignment.appUserId,b.adminUserId));}
 await owner.client.unsafe('REVOKE SELECT ON public.resignation_request FROM ai_hr_app');
 await owner.client.unsafe('GRANT SELECT(id,tenant_id,employment_id,person_id,status) ON public.resignation_request TO ai_hr_app');
 try{expect(await sqlState(original(group,[]))).toBe('42501');expect(await sqlState(candidate(group,[]))).toBe('42501');}
 finally{await owner.client.unsafe('GRANT SELECT ON public.resignation_request TO ai_hr_app');await owner.client.unsafe('REVOKE SELECT(id,tenant_id,employment_id,person_id,status) ON public.resignation_request FROM ai_hr_app');}
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'sparse-core-task-probe.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_SPARSE_CORE_TASK_PROBE',releaseEligible:false,historicalRows:1500,concurrentReads:40,phases,positiveOwnersPreserved:true,forgedRevokedForeignAndScopeRefused:true,malformedScopeAndColumnErrorsPreserved:true,limitations:'Component only. No app, policy, lock, cache, browser or 500-user change.'},null,2));
},300000);
