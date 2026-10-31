/** Reversible native routing experiment. No migration, installation or authorization-result cache. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {hireEmployee,setReportingLine} from '../../core/org';
import {checkIn,checkOut,requestAttendanceCorrection,pendingAttendanceTaskMetadata} from '../../core/attendance';
import {saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../../core/attendance-workflow';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('compares fresh request-grained routing before, during and after query-plan reuse and necessary denial gates',async()=>{
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
 const signatures=['app.can_see_employment(uuid)','app.is_admin_report_of(uuid,uuid)','app.can_decide_via_delegation_from(uuid,uuid,text,text)'];
 const definitions=[];
 for(const signature of signatures){
  const [row]=await owner.client`select pg_get_functiondef(${signature}::regprocedure) as original,prosrc as body,l.lanname as language from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=${signature}::regprocedure`;
  expect(row.language).toBe('sql');
  const cached=row.original.replace('LANGUAGE sql','LANGUAGE plpgsql').replace(/AS (\$[^$]*\$)[\s\S]*\1/,(_all:string,delimiter:string)=>'AS '+delimiter+'\nBEGIN RETURN (\n'+row.body.trim().replace(/;$/,'')+'\n); END;\n'+delimiter);
  expect(cached).not.toBe(row.original);definitions.push({original:row.original,cached});
 }
 const [assignment]=await owner.client`select pg_get_functiondef('app.attendance_workflow_v3_assigned_allowed(uuid,integer,text,text)'::regprocedure) as original`;
 const marker=" IF NOT EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id";
 expect(assignment.original.split(marker)).toHaveLength(2);
 // These are necessary conditions only. Every positive result still passes the complete original
 // live actor, dates, roles, tenant, module/task and organizational delegation proof below them.
 const denialGates=`
 IF acting='assigned' AND (caller.id<>(actor->>'userId')::uuid OR caller.person_id<>(actor->>'personId')::uuid) THEN RETURN false; END IF;
 IF acting='delegate' AND NOT EXISTS(SELECT 1 FROM public.reporting_line d JOIN public.employment recipient ON recipient.id=d.manager_employment_id AND recipient.tenant_id=d.tenant_id
  WHERE d.tenant_id=w.tenant_id AND d.subordinate_employment_id=(actor->>'employmentId')::uuid AND recipient.person_id=caller.person_id) THEN RETURN false; END IF;
`;
 const guarded=assignment.original.replace(marker,denialGates+marker),expected=new Map<number,unknown>();
 const phases:Record<string,unknown>={},oldAudit=process.env.AUDIT_HASH_CHAIN_ENABLED;
 process.env.AUDIT_HASH_CHAIN_ENABLED='true';
 try{
  const [audit]=await withTenant(actors[0].ctx,tx=>tx.execute<{armed:string}>(sql`select current_setting('app.audit_hash_chain',true)as armed`));expect(audit.armed).toBe('on');
  for(const phase of ['original-before','cached-plans','cached-plans-and-denial-gates','original-after']){
   for(const d of definitions)await owner.client.unsafe(phase.startsWith('cached')?d.cached:d.original);
   await owner.client.unsafe(phase==='cached-plans-and-denial-gates'?guarded:assignment.original);
   const measurements=[];
   for(let i=0;i<4;i++){
    const times=[];
    for(let j=0;j<3;j++){
     const start=performance.now(),rows=await pendingAttendanceTaskMetadata(actors[i].ctx,[b.companyId]);times.push(performance.now()-start);
     expect(rows).toHaveLength(i<2?32:0);
     if(!expected.has(i))expected.set(i,rows);else expect(rows).toEqual(expected.get(i));
    }
    measurements.push({principal:i,role:actors[i].role,elapsedMs:times,exactOrderedMetadata:true});
   }
   await expect(pendingAttendanceTaskMetadata({...actors[0].ctx,personId:randomUUID()},[b.companyId])).rejects.toThrow();
   try{
    await owner.db.update(s.reportingLine).set({validTo:today}).where(eq(s.reportingLine.id,delegation.reportingLineId));
    expect(await pendingAttendanceTaskMetadata(actors[1].ctx,[b.companyId])).toEqual([]);
   }finally{await owner.db.update(s.reportingLine).set({validTo:null}).where(eq(s.reportingLine.id,delegation.reportingLineId));}
   expect(await pendingAttendanceTaskMetadata(actors[1].ctx,[b.companyId])).toEqual(expected.get(1));
   try{
    await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,actors[0].ctx.userId!));
    expect(await pendingAttendanceTaskMetadata(actors[1].ctx,[b.companyId])).toEqual([]);
   }finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,actors[0].ctx.userId!));}
   expect(await pendingAttendanceTaskMetadata(actors[0].ctx,[b.companyId])).toEqual(expected.get(0));
   phases[phase]={measurements,expiredDelegationRefused:true,archivedAssignedActorRefused:true,forgedPersonRefused:true};
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'attendance-routing.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_ATTENDANCE_ROUTING',releaseEligible:false,pendingRequests:32,realLinkedPrincipals:35,auditGucVerified:'on',phases},null,2));
  }
 }finally{
  for(const d of definitions)await owner.client.unsafe(d.original);
  await owner.client.unsafe(assignment.original);
  if(oldAudit===undefined)delete process.env.AUDIT_HASH_CHAIN_ENABLED;else process.env.AUDIT_HASH_CHAIN_ENABLED=oldAudit;
 }
},300000);
