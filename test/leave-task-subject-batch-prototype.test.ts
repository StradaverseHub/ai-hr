/** Native installed consumer plus frozen scalar candidate-query control; step/decision owners remain real. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {and,asc,desc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type Tx,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {assertAssignedWorkPrincipalTx} from '../core/approvals';
import {pendingLeaveTaskMetadata} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);
async function readCandidates(ctx:SessionContext,batch:boolean,companyIds?:string[]){
 return withTenant(ctx,async tx=>{await assertAssignedWorkPrincipalTx(tx,ctx);return candidateQuery(tx,ctx,batch,companyIds);});
}
function candidateQuery(tx:Tx,ctx:SessionContext,batch:boolean,companyIds?:string[]){
  if(!batch)return tx.select({id:s.leaveRequest.id,employmentId:s.leaveRequest.employmentId,personId:sql<string>`approval_subject.person_id`,employee:sql<string>`approval_subject.employee`,createdAt:s.leaveRequest.createdAt})
   .from(s.leaveRequest).innerJoin(sql`LATERAL app.delegated_approval_subject(${s.leaveRequest.employmentId},'leave','leave.application') AS approval_subject`,sql`true`)
   .where(and(eq(s.leaveRequest.tenantId,ctx.tenantId),eq(s.leaveRequest.status,'pending'),sql`NOT app.is_self_person(approval_subject.person_id)`,
    companyIds===undefined?undefined:sql`approval_subject.company_id=ANY(ARRAY[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`))
   .orderBy(desc(s.leaveRequest.createdAt),asc(s.leaveRequest.id));
  const source=sql`(
   with headers as materialized(select q.id,q.employment_id,q.created_at from public.leave_request q where q.tenant_id=${ctx.tenantId}::uuid and q.status='pending'),
   distinct_subjects as(select distinct employment_id from headers),
   numbered_subjects as(select employment_id,(row_number()over(order by employment_id)-1)/1000 as bucket from distinct_subjects),
   subject_batches as(select array_agg(employment_id order by employment_id)as ids from numbered_subjects group by bucket),
   subject_rows as materialized(select r.* from subject_batches b cross join lateral app.delegated_approval_subjects(b.ids,'leave','leave.application')r)
   select h.id,h.employment_id,h.created_at,r.person_id,r.employee,r.company_id from headers h join subject_rows r on r.employment_id=h.employment_id
  ) as pending_leave`;
  const id=sql<string>`pending_leave.id`,createdAt=sql<Date>`pending_leave.created_at`.mapWith(s.leaveRequest.createdAt);
  return tx.select({id,employmentId:sql<string>`pending_leave.employment_id`,personId:sql<string>`pending_leave.person_id`,employee:sql<string>`pending_leave.employee`,createdAt}).from(source)
   .where(and(sql`NOT app.is_self_person(pending_leave.person_id)`,companyIds===undefined?undefined:sql`pending_leave.company_id=ANY(ARRAY[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`))
   .orderBy(desc(createdAt),asc(id));
}
async function plan(ctx:SessionContext,batch:boolean,companyIds:string[]){return withTenant(ctx,async tx=>{await assertAssignedWorkPrincipalTx(tx,ctx);return tx.execute(sql`explain (analyze,buffers,settings,format json) ${candidateQuery(tx,ctx,batch,companyIds)}`);});}
async function analyzeFixture(){for(const table of ['leave_request','employment','person','role_assignment','reporting_line','reporting_line_scope','leave_approval_step'])await owner.client.unsafe('analyze public.'+table);}
function functionLoops(explain:unknown,functionName:string){
 const rows=explain as {'QUERY PLAN':{Plan:{[key:string]:unknown}}[]}[];
 let loops=0;
 const walk=(node:{[key:string]:unknown})=>{if(node['Node Type']==='Function Scan'&&node['Function Name']===functionName)loops+=Number(node['Actual Loops']);for(const child of (node.Plans??[]) as {[key:string]:unknown}[])walk(child);};
 walk(rows[0]['QUERY PLAN'][0].Plan);return loops;
}

it('preserves native visible headers and live assignments while batching repeated Leave subjects',async()=>{
 await resetDb();const b=await seedBase(),admin=adminCtx(b),today=todayInKualaLumpur();
 const hire=(name:string,departmentId=b.deptA)=>hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01'});
 const applicant=await hire('Fictional Leave batch applicant'),manager=await hire('Fictional Leave batch manager',b.deptB),standIn=await hire('Fictional Leave batch stand-in',b.deptB);
 await setReportingLine(admin,{subordinateEmploymentId:applicant.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const login=async(personId:string,role:'employee'|'manager'):Promise<SessionContext>=>({...admin,userId:await createAppUser(b.tenantId,personId,role),personId,roles:[role],grants:[{role,companyId:null}]});
 const self=await login(applicant.personId,'employee'),reviewer=await login(manager.personId,'manager'),delegate=await login(standIn.personId,'employee');
 const requests=await owner.db.insert(s.leaveRequest).values(Array.from({length:211},()=>({tenantId:b.tenantId,employmentId:applicant.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:today,endDate:today,days:'1',reason:'PRIVATE_LEAVE_BATCH_REASON'}))).returning({id:s.leaveRequest.id});
 const profile=process.env.AIHR_CI_PG_STATEMENTS==='1';if(profile)await owner.client.unsafe('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
 const groupedCalls=async()=>Number((await owner.client`select coalesce(sum(calls),0)::int as calls from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database()) and position('as pending_leave' in query)>0 and position('subject_batches' in query)>0`)[0].calls);
 const expected=await readCandidates(admin,false,[b.companyId]);expect(expected).toHaveLength(211);expect(new Set(expected.map(row=>row.id))).toEqual(new Set(requests.map(row=>row.id)));
 const controls:string[]=[];
 for(const [label,ctx,scope]of [['admin',admin,[b.companyId]],['manager',reviewer,[b.companyId]],['self',self,[b.companyId]],['unscoped',admin,undefined],['empty',admin,[]]]as const){
  const ids=scope===undefined?undefined:[...scope];expect(await readCandidates(ctx,true,ids)).toEqual(await readCandidates(ctx,false,ids));controls.push(label);
 }
 const shapeBefore=profile?await groupedCalls():null;
 expect(await pendingLeaveTaskMetadata(admin,[b.companyId])).toEqual(expected);const shapeAfter=profile?await groupedCalls():null;
 if(profile)expect(shapeAfter!-shapeBefore!).toBe(1);expect(await pendingLeaveTaskMetadata(reviewer,[b.companyId])).toEqual(expected);expect(await pendingLeaveTaskMetadata(self,[b.companyId])).toEqual([]);
 const foreign=await seedBase();expect(await readCandidates(adminCtx(foreign),true,[b.companyId])).toEqual([]);controls.push('foreignTenant');
 for(const shape of [false,true]){
  await expect(readCandidates({...self,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},shape)).rejects.toThrow();
  await expect(readCandidates(admin,shape,['not-a-uuid'])).rejects.toThrow();
 }
 controls.push('forgedRoleRefused','invalidScopeRefused');
 await analyzeFixture();
 const plans:unknown[]=[];
 const measurements:{actor:string;phase:string;reads:number;elapsedMs:number}[]=[];
 for(const [actor,ctx]of [['admin',admin],['manager',reviewer]]as const)for(const phase of ['original','candidate','candidate-warm','restored']){
  plans.push({actor,phase,explain:await plan(ctx,phase==='candidate'||phase==='candidate-warm',[b.companyId])});
  const started=performance.now();for(let i=0;i<15;i++)expect(await readCandidates(ctx,phase==='candidate'||phase==='candidate-warm',[b.companyId])).toEqual(expected);
  measurements.push({actor,phase,reads:15,elapsedMs:performance.now()-started});
 }
 // The table read remains minimal: private Leave payloads are not needed by either candidate query.
 await owner.client.unsafe('revoke select on public.leave_request from ai_hr_app');
 await owner.client.unsafe('grant select(id,tenant_id,employment_id,status,created_at) on public.leave_request to ai_hr_app');
 try{
  for(const shape of [false,true])expect(await readCandidates(admin,shape,[b.companyId])).toEqual(expected);
  await expect(withTenant(admin,tx=>tx.select({reason:s.leaveRequest.reason}).from(s.leaveRequest))).rejects.toThrow();
 }finally{
  await owner.client.unsafe('grant select on public.leave_request to ai_hr_app');
  await owner.client.unsafe('revoke select(id,tenant_id,employment_id,status,created_at) on public.leave_request from ai_hr_app');
 }
 controls.push('privateColumnsNotNeeded');
 const [edge]=await owner.db.insert(s.reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:manager.employmentId,managerEmploymentId:standIn.employmentId,lineType:'delegate',validFrom:'2020-01-01',scopeCompanyId:b.companyId}).returning();
 expect(await readCandidates(delegate,true,[b.companyId])).toEqual(await readCandidates(delegate,false,[b.companyId]));expect(await pendingLeaveTaskMetadata(delegate,[b.companyId])).toEqual(expected);controls.push('nativeDelegation');
 await owner.db.insert(s.reportingLineScope).values({tenantId:b.tenantId,reportingLineId:edge.id,module:'attendance',taskType:'attendance.correction'});
 expect(await readCandidates(delegate,true,[b.companyId])).toEqual([]);expect(await readCandidates(delegate,false,[b.companyId])).toEqual([]);expect(await pendingLeaveTaskMetadata(delegate,[b.companyId])).toEqual([]);controls.push('wrongDelegationPurpose');
 await owner.db.delete(s.reportingLineScope).where(eq(s.reportingLineScope.reportingLineId,edge.id));
 await owner.db.update(s.reportingLine).set({validTo:'2020-01-02'}).where(eq(s.reportingLine.id,edge.id));expect(await readCandidates(delegate,true,[b.companyId])).toEqual([]);controls.push('expiredDelegation');
 await owner.db.insert(s.leaveApprovalStep).values([
  {tenantId:b.tenantId,leaveRequestId:requests[0].id,subjectEmploymentId:applicant.employmentId,stepIndex:0,approverKind:'hr_admin'},
  {tenantId:b.tenantId,leaveRequestId:requests[1].id,subjectEmploymentId:applicant.employmentId,stepIndex:0,approverKind:'specific_employee',approverEmploymentId:standIn.employmentId,approverAlternates:['direct_manager']},
  {tenantId:b.tenantId,leaveRequestId:requests[2].id,subjectEmploymentId:applicant.employmentId,stepIndex:0,approverKind:'direct_manager',status:'approved',decidedByEmploymentId:manager.employmentId,decidedAt:new Date()},
  {tenantId:b.tenantId,leaveRequestId:requests[3].id,subjectEmploymentId:applicant.employmentId,stepIndex:0,approverKind:'direct_manager',status:'approved',decidedByEmploymentId:manager.employmentId,decidedAt:new Date()},
  {tenantId:b.tenantId,leaveRequestId:requests[3].id,subjectEmploymentId:applicant.employmentId,stepIndex:1,approverKind:'hr_admin'},
 ]);
 expect(await readCandidates(reviewer,true,[b.companyId])).toEqual(await readCandidates(reviewer,false,[b.companyId]));
 expect((await pendingLeaveTaskMetadata(reviewer,[b.companyId])).map(row=>row.id)).toEqual(expected.filter(row=>![requests[0].id,requests[2].id,requests[3].id].includes(row.id)).map(row=>row.id));
 expect((await pendingLeaveTaskMetadata(admin,[b.companyId])).map(row=>row.id)).toEqual(expected.filter(row=>row.id!==requests[2].id).map(row=>row.id));controls.push('currentStep','completedChainOmitted','namedAlternate');
 const ratios=Object.fromEntries(['admin','manager'].map(actor=>{const m=measurements.filter(row=>row.actor===actor);return[actor,Math.max(m[1].elapsedMs,m[2].elapsedMs)/Math.min(m[0].elapsedMs,m[3].elapsedMs)];}));
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'leave-task-subject-batch-prototype.json'),JSON.stringify({kind:'NATIVE_LEAVE_CANDIDATE_QUERY_COMPONENT_ONLY',releaseEligible:false,fixtureRequests:211,fixtureSubjects:1,explicitAnalyze:true,singletonSpeedAcceptance:false,singletonReason:'PostgreSQL Memoize already reduces the scalar control to one subject lookup; latency ratios are observations only',plans,measurements,ratios,controls,currentDecisionOwnerUnchanged:true,actualConsumerGroupedQueryCalls:shapeBefore===null||shapeAfter===null?null:shapeAfter-shapeBefore,limitations:'Candidate-query comparison only; no500-user or whole-page speed claim; retained native owner fixtures, not application throughput'},null,2));
 // ANALYZE lets PostgreSQL Memoize this singleton queue: both shapes perform one subject lookup.
 // A mandatory20% wall-clock gain here would compare two already optimal one-lookup plans.
 for(const observation of plans as {phase:string;explain:unknown}[])expect(functionLoops(observation.explain,observation.phase==='original'||observation.phase==='restored'?'delegated_approval_subject':'delegated_approval_subjects')).toBe(1);
},600000);

it('splits more than1000distinct subject identities without truncating the native candidate queue',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b),today=todayInKualaLumpur();
 const people=Array.from({length:1001},(_,index)=>({id:randomUUID(),employmentId:randomUUID(),name:'Fictional Leave distinct subject '+index}));
 await owner.db.insert(s.person).values(people.map(p=>({id:p.id,tenantId:b.tenantId,fullName:p.name,primaryEmail:p.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(people.map(p=>({id:p.employmentId,tenantId:b.tenantId,personId:p.id,companyId:b.companyId,hiredOn:'2020-01-01'})));
 const requests=await owner.db.insert(s.leaveRequest).values(people.map(p=>({tenantId:b.tenantId,employmentId:p.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:today,endDate:today,days:'1',reason:'PRIVATE_LEAVE_DISTINCT_REASON'}))).returning({id:s.leaveRequest.id});
 const original=await readCandidates(ctx,false,[b.companyId]),candidate=await readCandidates(ctx,true,[b.companyId]);expect(original).toHaveLength(1001);expect(candidate).toEqual(original);expect(new Set(candidate.map(row=>row.id))).toEqual(new Set(requests.map(row=>row.id)));
 expect(await pendingLeaveTaskMetadata(ctx,[b.companyId])).toEqual(original);expect(JSON.stringify(candidate)).not.toContain('PRIVATE_LEAVE_DISTINCT_REASON');
 await analyzeFixture();
 const manager=await hireEmployee(ctx,{person:{fullName:'Fictional distinct-subject manager',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:'2020-01-01'});
 await owner.db.insert(s.reportingLine).values(people.map(p=>({tenantId:b.tenantId,subordinateEmploymentId:p.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative' as const,validFrom:'2020-01-01'})));
 const reviewer:SessionContext={...ctx,userId:await createAppUser(b.tenantId,manager.personId,'manager'),personId:manager.personId,roles:['manager'],grants:[{role:'manager',companyId:null}]};
 await analyzeFixture();
 const measurements:{actor:string;phase:string;reads:number;elapsedMs:number}[]=[],plans:{actor:string;phase:string;explain:unknown}[]=[];
 for(const [actor,who]of [['admin',ctx],['manager',reviewer]]as const){
  const expected=await readCandidates(who,false,[b.companyId]);expect(expected).toHaveLength(1001);
  for(const phase of ['original','candidate','candidate-warm','restored']){
   const batch=phase==='candidate'||phase==='candidate-warm';plans.push({actor,phase,explain:await plan(who,batch,[b.companyId])});
   const started=performance.now();for(let i=0;i<5;i++)expect(await readCandidates(who,batch,[b.companyId])).toEqual(expected);
   measurements.push({actor,phase,reads:5,elapsedMs:performance.now()-started});
  }
 }
 const ratios=Object.fromEntries(['admin','manager'].map(actor=>{const rows=measurements.filter(row=>row.actor===actor);return[actor,Math.max(rows[1].elapsedMs,rows[2].elapsedMs)/Math.min(rows[0].elapsedMs,rows[3].elapsedMs)];}));
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'leave-distinct-subject-plan-diagnostic.json'),JSON.stringify({kind:'NATIVE_ANALYZED_HETEROGENEOUS_LEAVE_QUERY_COMPONENT',releaseEligible:false,fixtureSubjects:1001,explicitAnalyze:true,plans,measurements,ratios,limitations:'Only native candidate-query component; original and installed2141 grouped helper; no HTTP/browser/500-user or million-row claim'},null,2));
 for(const observation of plans)expect(functionLoops(observation.explain,observation.phase==='original'||observation.phase==='restored'?'delegated_approval_subject':'delegated_approval_subjects')).toBe(observation.phase==='original'||observation.phase==='restored'?1001:2);
 expect(ratios.admin).toBeLessThan(.8);expect(ratios.manager).toBeLessThan(.8);

},600000);
