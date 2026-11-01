/** Paired task-read transport experiment; all native decision owners remain unchanged. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {and,desc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {SessionContext} from '../../db/client';
import {withAttendanceTenant as withTenant} from '../../core/module-gate';
import {assertAssignedWorkPrincipalTx,isApprovalDecisionRefusal} from '../../core/approvals';
import {AttendanceWorkflowError} from '../../lib/attendance-workflow';
import {assertCanDecideAttendanceApplicationTx,saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../../core/attendance-workflow';
import * as s from '../../db/schema';
import {hireEmployee,setReportingLine} from '../../core/org';
import {checkIn,checkOut,requestAttendanceCorrection,pendingAttendanceTaskMetadata} from '../../core/attendance';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
// Exact pre-batching reader, including the qualified necessary-only precheck. Counterfactual
// transport only: every request uses the original scalar command decision owner unchanged.
async function scalarMetadata(ctx:SessionContext,companyIds:string[]){
 return withTenant(ctx,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,ctx);
  const [candidate]=await tx.execute<{possible:boolean}>(sql`select app.may_have_attendance_task_metadata()as possible`);
  if(candidate?.possible===false)return [];
  const rows=await tx.select({id:s.attendanceCorrection.id,employmentId:s.attendanceCorrection.employmentId,
   personId:sql<string>`subject.person_id`,employee:sql<string|null>`subject.employee`,createdAt:s.attendanceCorrection.createdAt})
   .from(s.attendanceCorrection).innerJoin(sql`LATERAL app.attendance_application_subject(${s.attendanceCorrection.id})AS subject`,sql`true`)
   .where(and(eq(s.attendanceCorrection.tenantId,ctx.tenantId),eq(s.attendanceCorrection.status,'pending'),
    sql`NOT app.is_self_person(subject.person_id)`,companyIds.length?sql`(subject.company_id IN (${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`,`)}) OR app.attendance_workflow_v3_decision_slot(${s.attendanceCorrection.id}) IS NOT NULL)`:sql`false`))
   .orderBy(desc(s.attendanceCorrection.createdAt),s.attendanceCorrection.id);
  const result=[];
  for(const row of rows){
   try{await assertCanDecideAttendanceApplicationTx(tx,ctx,row.id,row.employmentId);result.push(row);}
   catch(error){if(error instanceof AttendanceWorkflowError&&error.code==='notApprover')continue;
    if(isApprovalDecisionRefusal(error,'attendance application'))continue;throw error;}
  }
  return result;
 });
}
it('compares scalar native decisions with the exact batched application and a restored scalar control',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'attendance','active');
 const root=adminCtx(b),today=todayInKualaLumpur();
 const actors=[];
 for(let i=0;i<35;i++){
  const role=i<2?'hr_admin' as const:i===2?'manager' as const:'employee' as const;
  const hired=await hireEmployee(root,{person:{fullName:'Fictional routing '+i,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const userId=await createAppUser(b.tenantId,hired.personId,role);
  const ctx:SessionContext={...root,userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]};
  actors.push({...hired,ctx,role});
 }
 for(const a of actors.slice(3))await setReportingLine(root,{subordinateEmploymentId:a.employmentId,managerEmploymentId:actors[2].employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const delegation=await setReportingLine(root,{subordinateEmploymentId:actors[0].employmentId,managerEmploymentId:actors[1].employmentId,lineType:'delegate',validFrom:'2020-01-01',scopes:[{module:'attendance',taskType:'attendance.correction'}]});
 await saveAttendanceWorkflow(root,{companyId:b.companyId,applicationType:'irregularity',routingVersion:4,code:'PERF_ROUTING',name:'Fictional named approver',priority:100,active:true,criteria:{employeeIds:actors.slice(3).map(a=>a.employmentId)},stages:[{name:'Named HR',mode:'any_one',sources:[{kind:'specific_employee',employmentIds:[actors[0].employmentId]}],hrAlternative:false}],cc:[]});
 await setAttendanceWorkflowEnabled(root,b.companyId,'irregularity',true);
 for(const a of actors.slice(3)){
  await checkIn(root,{employmentId:a.employmentId,date:today,time:'08:00',manual:true});
  await checkOut(root,{employmentId:a.employmentId,date:today,time:'17:00',manual:true});
  await requestAttendanceCorrection(a.ctx,{employmentId:a.employmentId,date:today,checkIn:'09:00',checkOut:'18:00',reason:'Fictional native routing profile'});
 }
 const signatures=['app.can_see_employment(uuid)','app.is_admin_report_of(uuid,uuid)','app.can_decide_via_delegation_from(uuid,uuid,text,text)','app.attendance_workflow_v3_effective(uuid,integer)','app.attendance_workflow_v3_actor(uuid,integer,text)','app.principal(uuid)','app.attendance_workflow_v3_assigned_allowed(uuid,integer,text,text)','app.may_have_attendance_task_metadata()'];
 const attributes=async(signature:string)=>{
  const [row]=await owner.client`select p.proowner::regrole::text as owner,p.proacl::text as acl,p.prosecdef,p.provolatile,p.proconfig,p.proparallel,p.proisstrict,p.proleakproof,p.procost,p.prorettype::regtype::text as returns,p.proretset from pg_proc p where p.oid=${signature}::regprocedure`;return row;
 };
 const expectedAttributes=new Map<string,unknown>();for(const signature of signatures)expectedAttributes.set(signature,await attributes(signature));
 const [gate]=await owner.client`select pg_get_functiondef('app.may_have_attendance_task_metadata()'::regprocedure)as definition`;
 const marker='WHERE r.tenant_id=caller.tenant_id AND e.person_id=caller.person_id) THEN RETURN true; END IF;';
 expect(gate.definition.split(marker)).toHaveLength(2);
 const narrowedGate=gate.definition.replace(marker,`WHERE r.tenant_id=caller.tenant_id AND e.person_id=caller.person_id
 AND (
  r.line_type='delegate' OR (
   r.line_type='administrative' AND EXISTS(
    SELECT 1 FROM public.attendance_correction c
    WHERE c.tenant_id=caller.tenant_id AND c.status='pending'
    AND NOT EXISTS(
     SELECT 1 FROM public.attendance_workflow_request w
     WHERE w.correction_id=c.id AND w.tenant_id=c.tenant_id AND w.routing_version IN(2,3,4)
    )
   )
  )
 )
) THEN RETURN true; END IF;`);
 const phases:Record<string,unknown>={},expected=new Map<number,unknown>(),oldAudit=process.env.AUDIT_HASH_CHAIN_ENABLED;
 process.env.AUDIT_HASH_CHAIN_ENABLED='true';
 try{
  const [audit]=await withTenant(actors[0].ctx,tx=>tx.execute<{armed:string}>(sql`select current_setting('app.audit_hash_chain',true)as armed`));expect(audit.armed).toBe('on');
  for(const phase of ['batched-before','narrowed-candidate','batched-restored']){
   await owner.client.unsafe(phase==='narrowed-candidate'?narrowedGate:gate.definition);
   const read=pendingAttendanceTaskMetadata;
   for(const signature of signatures)expect(await attributes(signature)).toEqual(expectedAttributes.get(signature));
   expect(await owner.client`select * from app.principal(${randomUUID()}::uuid)`).toHaveLength(0);
   try{
    await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,actors[0].ctx.userId!));
    const principal=await owner.client`select * from app.principal(${actors[0].ctx.userId!}::uuid)`;
    expect(principal).toHaveLength(1);expect(principal[0].grants).toEqual([{role:'employee',companyId:null}]);
    await expect(read(actors[0].ctx,[b.companyId])).rejects.toThrow();
   }finally{await owner.db.update(s.roleAssignment).set({role:'hr_admin'}).where(eq(s.roleAssignment.appUserId,actors[0].ctx.userId!));}
   const measurements=[];
   for(let i=0;i<4;i++){
    const times=[];
    for(let j=0;j<3;j++){
     const start=performance.now(),rows=await read(actors[i].ctx,[b.companyId]);times.push(performance.now()-start);
     expect(rows).toHaveLength(i<2?32:0);if(!expected.has(i))expected.set(i,rows);else expect(rows).toEqual(expected.get(i));
    }
    measurements.push({principal:i,role:actors[i].role,elapsedMs:times,exactOrderedMetadata:true});
   }
   await expect(read({...actors[0].ctx,personId:randomUUID()},[b.companyId])).rejects.toThrow();
   try{await owner.db.update(s.reportingLine).set({validTo:today}).where(eq(s.reportingLine.id,delegation.reportingLineId));expect(await read(actors[1].ctx,[b.companyId])).toEqual([]);}
   finally{await owner.db.update(s.reportingLine).set({validTo:null}).where(eq(s.reportingLine.id,delegation.reportingLineId));}
   expect(await read(actors[1].ctx,[b.companyId])).toEqual(expected.get(1));
   try{await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,actors[0].ctx.userId!));expect(await read(actors[1].ctx,[b.companyId])).toEqual([]);}
   finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,actors[0].ctx.userId!));}
   expect(await read(actors[0].ctx,[b.companyId])).toEqual(expected.get(0));
   phases[phase]={measurements,expiredDelegationRefused:true,archivedAssignedActorRefused:true,forgedPersonRefused:true,liveGrantChangesChecked:true,securityAttributesOwnerAndAclUnchanged:true};
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'attendance-routing.json'),JSON.stringify({kind:'PAIRED_NATIVE_ATTENDANCE_TASK_TRANSPORT',releaseEligible:false,pendingRequests:32,realLinkedPrincipals:35,auditGucVerified:'on',phases},null,2));
  }
  await owner.client.unsafe(narrowedGate);
  try{
   for(const a of actors.slice(0,2))await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,a.ctx.userId!));
   for(const a of actors.slice(0,2)){
    const ctx:SessionContext={...a.ctx,roles:['employee'],grants:[{role:'employee',companyId:null}]};
    const original=await scalarMetadata(ctx,[b.companyId]);expect(original).toHaveLength(32);
    expect(await pendingAttendanceTaskMetadata(ctx,[b.companyId])).toEqual(original);
   }
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'attendance-possible-assignment.json'),JSON.stringify({namedNonAdminActor:true,nonAdminDelegate:true,orderedMetadataExact:true,nativeApplicationBatch:true},null,2));
  }finally{for(const a of actors.slice(0,2))await owner.db.update(s.roleAssignment).set({role:'hr_admin'}).where(eq(s.roleAssignment.appUserId,a.ctx.userId!));}
  // Preserve the unrouted administrative fallback with a real additional native request.
  const prior=new Date(today+'T12:00:00Z');prior.setUTCDate(prior.getUTCDate()-1);const date=prior.toISOString().slice(0,10);
  await setAttendanceWorkflowEnabled(root,b.companyId,'irregularity',false);
  await checkIn(root,{employmentId:actors[3].employmentId,date,time:'08:00',manual:true});
  await checkOut(root,{employmentId:actors[3].employmentId,date,time:'17:00',manual:true});
  const legacy=await requestAttendanceCorrection(actors[3].ctx,{employmentId:actors[3].employmentId,date,checkIn:'09:00',checkOut:'18:00',reason:'Fictional necessary legacy fallback'});
  expect(await owner.client`select id from attendance_workflow_request where correction_id=${legacy.correctionId}::uuid`).toHaveLength(0);
  await owner.client.unsafe(gate.definition);
  const legacyExpected=await Promise.all(actors.slice(0,4).map(a=>pendingAttendanceTaskMetadata(a.ctx,[b.companyId])));
  expect(legacyExpected[2].map(row=>row.id)).toEqual([legacy.correctionId]);
  await owner.client.unsafe(narrowedGate);
  for(let i=0;i<4;i++)expect(await pendingAttendanceTaskMetadata(actors[i].ctx,[b.companyId])).toEqual(legacyExpected[i]);
  writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'attendance-legacy-candidate.json'),JSON.stringify({nativeUnroutedRequest:true,administrativeManagerPreserved:true,allOrderedMetadataExact:true,versionedNamedAndDelegatedActorsPreserved:true},null,2));
 }finally{await owner.client.unsafe(gate.definition);if(oldAudit===undefined)delete process.env.AUDIT_HASH_CHAIN_ENABLED;else process.env.AUDIT_HASH_CHAIN_ENABLED=oldAudit;}
},300000);
