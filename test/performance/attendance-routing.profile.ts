/** Reversible native routing experiment. No migration, installation or authorization-result cache. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {SessionContext} from '../../db/client';
import {withAttendanceTenant as withTenant} from '../../core/module-gate';
import {assertAssignedWorkPrincipalTx,isApprovalDecisionRefusal} from '../../core/approvals';
import {AttendanceWorkflowError} from '../../lib/attendance-workflow';
import {assertCanDecideAttendanceApplicationTx} from '../../core/attendance-workflow';
import * as s from '../../db/schema';
import {hireEmployee,setReportingLine} from '../../core/org';
import {checkIn,checkOut,requestAttendanceCorrection,pendingAttendanceTaskMetadata} from '../../core/attendance';
import {saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../../core/attendance-workflow';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {adminCtx,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
// Candidate query shape only: keep real request RLS and every per-request canonical decision proof.
// Resolve names only after decision authority succeeds, avoiding repeated delegated subject projection
// for broadly readable requests that are not assigned to this principal.
async function metadataAfterDecision(ctx:SessionContext,companyIds:string[]){
 return withTenant(ctx,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,ctx);
  const headers=await tx.select({id:s.attendanceCorrection.id,employmentId:s.attendanceCorrection.employmentId})
   .from(s.attendanceCorrection).where(and(eq(s.attendanceCorrection.tenantId,ctx.tenantId),eq(s.attendanceCorrection.status,'pending')))
   .orderBy(desc(s.attendanceCorrection.createdAt),s.attendanceCorrection.id);
  const allowed=[];
  for(const row of headers){
   try{await assertCanDecideAttendanceApplicationTx(tx,ctx,row.id,row.employmentId);allowed.push(row.id);}
   catch(error){
    if(error instanceof AttendanceWorkflowError&&error.code==='notApprover')continue;
    if(isApprovalDecisionRefusal(error,'attendance application'))continue;
    throw error;
   }
  }
  if(!allowed.length)return [];
  return tx.select({id:s.attendanceCorrection.id,employmentId:s.attendanceCorrection.employmentId,
   personId:sql<string>`subject.person_id`,employee:sql<string|null>`subject.employee`,createdAt:s.attendanceCorrection.createdAt})
   .from(s.attendanceCorrection).innerJoin(sql`LATERAL app.attendance_application_subject(${s.attendanceCorrection.id}) AS subject`,sql`true`)
   .where(and(eq(s.attendanceCorrection.tenantId,ctx.tenantId),eq(s.attendanceCorrection.status,'pending'),inArray(s.attendanceCorrection.id,allowed),
    sql`NOT app.is_self_person(subject.person_id)`,companyIds.length?sql`(subject.company_id IN (${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`,` )}) OR app.attendance_workflow_v3_decision_slot(${s.attendanceCorrection.id}) IS NOT NULL)`:sql`false`))
   .orderBy(desc(s.attendanceCorrection.createdAt),s.attendanceCorrection.id);
 });
}
const possibleAssignmentSql=`
CREATE FUNCTION app.perf_possible_attendance_work() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $possible$
DECLARE caller public.app_user; stage_user jsonb; stage_person jsonb; actor_user jsonb; actor_person jsonb;
BEGIN
 SELECT u.* INTO caller FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL;
 -- Unknown identity/configuration always falls through to the original authoritative reader.
 IF NOT FOUND OR caller.person_id IS NULL OR NOT app.principal_snapshot_current() THEN RETURN true; END IF;
 IF EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=caller.tenant_id AND r.app_user_id=caller.id AND r.role::text IN ('hr_admin','super_admin')) THEN RETURN true; END IF;
 -- Include historical, inactive and every line kind. False positives are deliberately harmless.
 IF EXISTS(SELECT 1 FROM public.reporting_line r JOIN public.employment e ON e.id=r.manager_employment_id AND e.tenant_id=r.tenant_id
  WHERE r.tenant_id=caller.tenant_id AND e.person_id=caller.person_id) THEN RETURN true; END IF;
 actor_user:=lower(jsonb_build_object('userId',caller.id::text)::text)::jsonb;
 actor_person:=lower(jsonb_build_object('personId',caller.person_id::text)::text)::jsonb;
 stage_user:=jsonb_build_array(jsonb_build_object('approvers',jsonb_build_array(actor_user)));
 stage_person:=jsonb_build_array(jsonb_build_object('approvers',jsonb_build_array(actor_person)));
 IF EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.tenant_id=caller.tenant_id AND w.routing_version IN (2,3,4)
  AND (lower(w.stages::text)::jsonb @> stage_user OR lower(w.stages::text)::jsonb @> stage_person)) THEN RETURN true; END IF;
 IF EXISTS(SELECT 1 FROM public.attendance_workflow_reassignment r WHERE r.tenant_id=caller.tenant_id
  AND (lower(r.approvers::text)::jsonb @> jsonb_build_array(actor_user) OR lower(r.approvers::text)::jsonb @> jsonb_build_array(actor_person))) THEN RETURN true; END IF;
 IF EXISTS(SELECT 1 FROM public.attendance_workflow_participant_reassignment r WHERE r.tenant_id=caller.tenant_id
  AND (lower(r.assigned::text)::jsonb @> actor_user OR lower(r.assigned::text)::jsonb @> actor_person)) THEN RETURN true; END IF;
 RETURN false;
END;
$possible$;
REVOKE ALL ON FUNCTION app.perf_possible_attendance_work() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.perf_possible_attendance_work() TO ai_hr_app;
`;
async function metadataWithPossibleAssignment(ctx:SessionContext,companyIds:string[]){
 const possible=await withTenant(ctx,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,ctx);
  const [row]=await tx.execute<{possible:boolean}>(sql`select app.perf_possible_attendance_work()as possible`);return row.possible;
 });
 // This experiment retains the whole original positive path and its fresh transaction/guards.
 // Production promotion would put this check in the owner's existing transaction, never cache it.
 return possible?pendingAttendanceTaskMetadata(ctx,companyIds):[];
}
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
 const signatures=['app.can_see_employment(uuid)','app.is_admin_report_of(uuid,uuid)','app.can_decide_via_delegation_from(uuid,uuid,text,text)','app.attendance_workflow_v3_effective(uuid,integer)','app.attendance_workflow_v3_actor(uuid,integer,text)','app.heads_department_of(uuid,uuid)','app.can_decide_via_delegation(uuid,text,text)','app.unrouted_attendance_delegate(uuid)','app.principal(uuid)'];
 const assignmentSignature='app.attendance_workflow_v3_assigned_allowed(uuid,integer,text,text)';
 const installed=[];
 const attributes=async(signature:string)=>{
  const [row]=await owner.client`select p.proowner::regrole::text as owner,p.proacl::text as acl,p.prosecdef,p.provolatile,p.proconfig,p.proparallel,p.proisstrict,p.proleakproof,p.procost,p.prorettype::regtype::text as returns,p.proretset from pg_proc p where p.oid=${signature}::regprocedure`;return row;
 };
 const expectedAttributes=new Map<string,unknown>();
 for(const signature of [...signatures,assignmentSignature]){
  const [row]=await owner.client`select pg_get_functiondef(${signature}::regprocedure)as definition`;
  installed.push(row.definition);expectedAttributes.set(signature,await attributes(signature));
  const name=signature.slice(4,signature.indexOf('('));
  const file=name==='principal'?'0016_company_scoped_authz.sql':name==='can_see_employment'||name==='is_admin_report_of'?'0109_hierarchy_visibility_rls.sql':name==='heads_department_of'?'0121_rls_leak_fixes.sql':['can_decide_via_delegation_from','can_decide_via_delegation','unrouted_attendance_delegate'].includes(name)?'0818_delegated_approvals.sql':'0592_attendance_workflow_v4.sql';
  const source=readFileSync(new URL('../../db/migrations/'+file,import.meta.url),'utf8');
  let start=source.indexOf('CREATE OR REPLACE FUNCTION app.'+name+'(');if(start<0)start=source.indexOf('CREATE FUNCTION app.'+name+'(');
  const end=source.indexOf('$$;',start)+3;
  expect(start).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(start);
  await owner.client.unsafe(source.slice(start,end).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'));
 }
 const definitions=[];
 for(const signature of signatures){
  const [row]=await owner.client`select pg_get_functiondef(${signature}::regprocedure) as original,prosrc as body,p.proretset as returns_set,l.lanname as language from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=${signature}::regprocedure`;
  expect(row.language).toBe('sql');
  const body=row.body.trim().replace(/;$/,'');
  const cached=row.original.replace('LANGUAGE sql','LANGUAGE plpgsql').replace(/AS (\$[^$]*\$)[\s\S]*\1/,(_all:string,delimiter:string)=>'AS '+delimiter+(row.returns_set?'\nBEGIN RETURN QUERY\n'+body+'; END;\n':'\nBEGIN RETURN (\n'+body+'\n); END;\n')+delimiter);
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
  await owner.client.unsafe(possibleAssignmentSql);
  for(const phase of ['original-before','cached-plans','cached-plans-and-denial-gates','routing-plans-and-denial-gates','original-after','migration-files','migration-plus-live-guard-plans','migration-files-restored','migration-metadata-after-decision','migration-metadata-restored','migration-principal-plan','migration-principal-restored','migration-principal-file','migration-possible-assignment','migration-possible-restored']){
   for(const [index,d]of definitions.entries())await owner.client.unsafe((phase.startsWith('cached')&&index<3)||(phase.startsWith('routing')&&index<5)?d.cached:d.original);
   await owner.client.unsafe(phase.endsWith('denial-gates')?guarded:assignment.original);
   if(phase.startsWith('migration'))for(const file of ['0871_visibility_routing_plans.sql','0872_attendance_assignment_work.sql']){
    const contents=readFileSync(new URL('../../db/migrations/'+file,import.meta.url),'utf8');
    for(const statement of contents.split('--> statement-breakpoint'))await owner.client.unsafe(statement);
   }
   if(phase==='migration-plus-live-guard-plans')for(const d of definitions.slice(5,8))await owner.client.unsafe(d.cached);
   if(phase==='migration-principal-plan')await owner.client.unsafe(definitions[8].cached);
   if(phase==='migration-principal-file')await owner.client.unsafe(readFileSync(new URL('../../db/migrations/0877_principal_query_plan.sql',import.meta.url),'utf8'));
   for(const signature of [...signatures,assignmentSignature])expect(await attributes(signature)).toEqual(expectedAttributes.get(signature));
   const liveBootstrap=await owner.client`select * from app.principal(${actors[0].ctx.userId!}::uuid)`;
   expect(liveBootstrap).toHaveLength(1);expect(liveBootstrap[0].person_id).toBe(actors[0].personId);
   expect(liveBootstrap[0].tenant_id).toBe(b.tenantId);expect(liveBootstrap[0].grants).toEqual([{role:'hr_admin',companyId:null}]);
   expect(await owner.client`select * from app.principal(${randomUUID()}::uuid)`).toHaveLength(0);
   try{
    await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,actors[0].ctx.userId!));
    const [changed]=await owner.client`select * from app.principal(${actors[0].ctx.userId!}::uuid)`;
    expect(changed.grants).toEqual([{role:'employee',companyId:null}]);
    await expect(pendingAttendanceTaskMetadata(actors[0].ctx,[b.companyId])).rejects.toThrow();
   }finally{await owner.db.update(s.roleAssignment).set({role:'hr_admin'}).where(eq(s.roleAssignment.appUserId,actors[0].ctx.userId!));}
   const read=phase==='migration-metadata-after-decision'?metadataAfterDecision:phase==='migration-possible-assignment'?metadataWithPossibleAssignment:pendingAttendanceTaskMetadata;
   const measurements=[];
   for(let i=0;i<4;i++){
    const times=[];
    for(let j=0;j<3;j++){
     const start=performance.now(),rows=await read(actors[i].ctx,[b.companyId]);times.push(performance.now()-start);
     expect(rows).toHaveLength(i<2?32:0);
     if(!expected.has(i))expected.set(i,rows);else expect(rows).toEqual(expected.get(i));
    }
    measurements.push({principal:i,role:actors[i].role,elapsedMs:times,exactOrderedMetadata:true});
   }
   await expect(read({...actors[0].ctx,personId:randomUUID()},[b.companyId])).rejects.toThrow();
   try{
    await owner.db.update(s.reportingLine).set({validTo:today}).where(eq(s.reportingLine.id,delegation.reportingLineId));
    expect(await read(actors[1].ctx,[b.companyId])).toEqual([]);
   }finally{await owner.db.update(s.reportingLine).set({validTo:null}).where(eq(s.reportingLine.id,delegation.reportingLineId));}
   expect(await read(actors[1].ctx,[b.companyId])).toEqual(expected.get(1));
   try{
    await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,actors[0].ctx.userId!));
    expect(await read(actors[1].ctx,[b.companyId])).toEqual([]);
   }finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,actors[0].ctx.userId!));}
   expect(await read(actors[0].ctx,[b.companyId])).toEqual(expected.get(0));
   phases[phase]={measurements,expiredDelegationRefused:true,archivedAssignedActorRefused:true,forgedPersonRefused:true,securityAttributesOwnerAndAclUnchanged:true};
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'attendance-routing.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_ATTENDANCE_ROUTING',releaseEligible:false,pendingRequests:32,realLinkedPrincipals:35,auditGucVerified:'on',phases},null,2));
  }
  try{
   for(const a of actors.slice(0,2))await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,a.ctx.userId!));
   for(const a of actors.slice(0,2)){
    const ctx:SessionContext={...a.ctx,roles:['employee'],grants:[{role:'employee',companyId:null}]};
    const original=await pendingAttendanceTaskMetadata(ctx,[b.companyId]);expect(original).toHaveLength(32);
    expect(await metadataWithPossibleAssignment(ctx,[b.companyId])).toEqual(original);
   }
   expect(await metadataWithPossibleAssignment({...actors[3].ctx,personId:randomUUID()},[b.companyId]).then(()=>false,()=>true)).toBe(true);
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'attendance-possible-assignment.json'),JSON.stringify({namedNonAdminActor:true,nonAdminDelegate:true,orderedMetadataExact:true,forgedPersonRefused:true,noApplicationChange:true},null,2));
  }finally{for(const a of actors.slice(0,2))await owner.db.update(s.roleAssignment).set({role:'hr_admin'}).where(eq(s.roleAssignment.appUserId,a.ctx.userId!));}

 }finally{
  await owner.client.unsafe('DROP FUNCTION IF EXISTS app.perf_possible_attendance_work()');
  for(const definition of installed)await owner.client.unsafe(definition);
  if(oldAudit===undefined)delete process.env.AUDIT_HASH_CHAIN_ENABLED;else process.env.AUDIT_HASH_CHAIN_ENABLED=oldAudit;
 }
},300000);

it('measures indexed frozen-actor lookups over one million synthetic workflow documents',async()=>{
 const tenant=randomUUID(),foreign=randomUUID(),user=randomUUID(),person=randomUUID(),foreignUser=randomUUID(),foreignPerson=randomUUID();
 const userToken=[{approvers:[{userId:user}]}],personToken=[{approvers:[{personId:person}]}];
 const phases:Record<string,unknown>={};
 await owner.client.begin(async tx=>{
  await tx.unsafe('CREATE TEMP TABLE perf_possible_history(id bigint,tenant_id uuid,routing_version integer,stages jsonb) ON COMMIT DROP');
  const started=performance.now();
  await tx`insert into perf_possible_history select n,case when n%2=0 then ${tenant}::uuid else ${foreign}::uuid end,4,
   jsonb_build_array(jsonb_build_object('approvers',jsonb_build_array(jsonb_build_object('userId',gen_random_uuid()::text,'personId',gen_random_uuid()::text)))) from generate_series(1,1000000)n`;
  await tx`insert into perf_possible_history values(1000001,${tenant}::uuid,4,${tx.json([{approvers:[{userId:user.toUpperCase(),personId:person.toUpperCase()}]}])})`;
  await tx`insert into perf_possible_history values(1000002,${foreign}::uuid,4,${tx.json([{approvers:[{userId:foreignUser,personId:foreignPerson}]}])})`;
  await tx.unsafe('ANALYZE perf_possible_history');
  const setupMs=performance.now()-started;
  for(const phase of ['scan-before','indexed','scan-restored']){
   let indexBuildMs:number|undefined;
   if(phase==='indexed'){
    const started=performance.now();await tx.unsafe('CREATE INDEX perf_possible_history_gin ON perf_possible_history USING gin ((lower(stages::text)::jsonb) jsonb_path_ops)');indexBuildMs=performance.now()-started;
   }
   if(phase==='scan-restored')await tx.unsafe('DROP INDEX perf_possible_history_gin');
   const cases=[];
   for(const match of ['present','absent','foreign-only']){
    const wantedUser=match==='present'?userToken:[{approvers:[{userId:match==='foreign-only'?foreignUser:randomUUID()}]}];
    const wantedPerson=match==='present'?personToken:[{approvers:[{personId:match==='foreign-only'?foreignPerson:randomUUID()}]}];
    const times=[];
    for(let i=0;i<3;i++){
     const started=performance.now();
     const rows=await tx`select id from perf_possible_history where tenant_id=${tenant}::uuid and routing_version in(2,3,4)
      and(lower(stages::text)::jsonb @> ${tx.json(wantedUser)} or lower(stages::text)::jsonb @> ${tx.json(wantedPerson)})limit 1`;
     times.push(performance.now()-started);expect(rows.map(row=>Number(row.id))).toEqual(match==='present'?[1000001]:[]);
    }
    const [explained]=await tx`explain(analyze,buffers,format json)select id from perf_possible_history where tenant_id=${tenant}::uuid and routing_version in(2,3,4)
     and(lower(stages::text)::jsonb @> ${tx.json(wantedUser)} or lower(stages::text)::jsonb @> ${tx.json(wantedPerson)})limit 1`;
    const plan=explained['QUERY PLAN'];
    if(phase==='indexed')expect(JSON.stringify(plan)).toContain('perf_possible_history_gin');
    cases.push({match,elapsedMs:times,exactIdAndTenant:true,uppercaseStoredIdentityMatched:match==='present',plan});
   }
   phases[phase]={indexBuildMs,cases};
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'attendance-assignment-index-scale.json'),JSON.stringify({kind:'SYNTHETIC_QUERY_ACCESS_PATH_ONLY',releaseEligible:false,rows:1000002,tenants:2,setupMs,scope:'Native authorization is tested separately; this measures the same actor-containment expression on a temporary synthetic table, not native request creation or HTTP capacity.',phases},null,2));
  }
 });
},300000);
