import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {setCompensation} from '../core/comp';
import {v9Setup,v9Workspace,v9SaveConfig} from '../packs/lifecycle/service';
import {saveAutomationDocumentTemplate,saveAutomationWorkflow} from '../packs/automation/service';
import {contractSharedTracker,openContractSharedPeriod,contractSharedWorkspace,contractSharedConfigurationChoices,contractSharedAccessPeople,contractSharedWaiting,contractSharedLetterActions,pendingContractSharedTasks,previewContractSharedDecision,submitContractSharedDecision,readContractSharedApproval,actContractSharedApproval,readContractSharedLetter,actContractSharedLetter,saveContractSharedRole,saveContractSharedMember} from '../packs/contracts/service';
import {contractPreviewJobHandler} from '../core/contract-shared-preview-job';
import {contractAutomationJobHandler} from '../core/contract-shared-automation-job';
import {readBulkJob,runBulkJobTick} from '../core/bulk-job';
import type {AutomationWorkflow} from '../lib/automation/workflow';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base,admin:SessionContext;
const year=Number(todayInKualaLumpur().slice(0,4)),start=`${year}-01-01`,end=`${year}-12-31`;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);
 const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional workspace administrator',${randomUUID()+'@workspace.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${admin.userId}::uuid`);admin={...admin,personId:person.id};await v9Setup(admin);
});
async function ordinary(name:string){
 const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,${name},${randomUUID()+'@workspace.test'}) returning id`);
 return {...admin,userId:await createAppUser(b.tenantId,person.id,'employee'),personId:person.id,roles:['employee'],grants:undefined} as SessionContext;
}
async function tickToDone(id:string,actor:SessionContext,kind:'contract_preview'|'contract_automation'){
 let failure:unknown;
 const handler=kind==='contract_preview'?contractPreviewJobHandler:contractAutomationJobHandler;
 const diagnostic={...handler,describeFailure:async(...args:Parameters<NonNullable<typeof handler.describeFailure>>)=>{failure=args[1];return handler.describeFailure!(...args);}};
 for(let attempt=0;attempt<100;attempt++){
  const job=await readBulkJob(actor,id,kind);if(job.state==='failed')throw failure??new Error(job.error??'Contract job failed');if(job.state==='completed')return;
  await runBulkJobTick(owner.client,{handlers:[diagnostic]});
 }
 throw new Error('Contract job did not complete');
}
async function routedCase(){
 const config=(await v9Workspace(admin)).config!,ops=randomUUID(),ceo=randomUUID();
 await v9SaveConfig(admin,config.revision,{...config,groups:[...config.groups,{id:ops,name:'Contract People Ops',members:[admin.userId!],limit:0},{id:ceo,name:'Contract CEO group',members:[admin.userId!],limit:0}],peopleOpsGroup:ops});
 const manager=await hireEmployee(admin,{person:{fullName:'Fictional direct superior',primaryEmail:randomUUID()+'@workspace.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:start});
 const proposer={...admin,userId:await createAppUser(b.tenantId,manager.personId,'employee'),personId:manager.personId,roles:['employee'],grants:undefined} as SessionContext;
 const employee=await hireEmployee(admin,{person:{fullName:'Fictional Contract employee',primaryEmail:randomUUID()+'@workspace.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'contract',hiredOn:start,provisionalEndOn:end,reportingManagerEmploymentId:manager.employmentId});
 await setEmploymentInfo(admin,{employmentId:employee.employmentId,contractStartDate:start,contractEndDate:end,contractNumber:4});await setCompensation(admin,{employmentId:employee.employmentId,basicSalary:4976.21,effectiveFrom:start});
 const employeeSession={...admin,userId:await createAppUser(b.tenantId,employee.personId,'employee'),personId:employee.personId,roles:['employee'],grants:undefined} as SessionContext;
 const row=(await contractSharedTracker(proposer)).rows[0],opened=await openContractSharedPeriod(proposer,{employmentId:employee.employmentId,sourceRevision:row.sourceRevision!});
 const templateId=randomUUID(),approvalStep=randomUUID();
 await saveAutomationDocumentTemplate(admin,{template:{id:templateId,module:'contract_staff',name:'Fictional Contract outcome',description:'',rules:{decision:['Renew']},blocks:[{id:'intro',type:'text',text:'Dear {employee.name}',section:''}],fields:[],routing:[{id:randomUUID(),order:1,action:'review',owner:true,who:{kind:'group',groupId:ops}},{id:randomUUID(),order:2,action:'sign',owner:false,who:{kind:'employee'}}]},expectedRevision:0,publish:true,retired:false});
 const workflow:AutomationWorkflow={id:randomUUID(),module:'contract_staff',name:'Fictional Contract workflow',description:'',status:'live',required:false,trigger:{event:'decisionSubmitted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:randomUUID(),type:'requestApproval',conditions:[],to:[],cc:[],params:{layers:[{id:approvalStep,name:'CEO',pick:'any',approver:{kind:'group',groupId:ceo}}]}},{id:randomUUID(),type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:templateId}}]};
 await saveAutomationWorkflow(admin,{workflow,expectedRevision:0,reason:'Fictional native assignment read proof'});
 return {caseId:opened.caseId,employee,proposer,employeeSession,ops,ceo};
}
it('projects the actual approval group and current letter step without granting the employee Case View',async()=>{
 const f=await routedCase(),outsider=await ordinary('Fictional additional CEO member');
 expect((await pendingContractSharedTasks(f.proposer,undefined)).map(t=>t.kind)).toContain('contractDecision');
 const requested=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,draft:{kind:'renew',months:12,payChanges:false,reason:'Continue specialist work'}});
 await tickToDone(requested.jobId,f.proposer,'contract_preview');const submitted=await submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,previewId:requested.previewId});await tickToDone(submitted.jobId,f.proposer,'contract_automation');
 const workspace=await contractSharedWorkspace(admin,f.caseId),approvalId=workspace.approvals[0].id;
 expect(workspace.approvals[0]).toMatchObject({workflowName:'Fictional Contract workflow',status:'pending',decisionRevision:1});
 expect((await pendingContractSharedTasks(admin,undefined)).some(t=>t.id===approvalId&&t.kind==='contractApproval')).toBe(true);
 expect(await pendingContractSharedTasks(outsider,undefined)).toEqual([]);
 const current=(await v9Workspace(admin)).config!;await v9SaveConfig(admin,current.revision,{...current,groups:current.groups.map(g=>g.id===f.ceo?{...g,members:[...g.members,outsider.userId!]}:g)});
 expect((await pendingContractSharedTasks(outsider,undefined)).map(t=>t.id)).toContain(approvalId);
 const approval=await readContractSharedApproval(outsider,approvalId);expect(approval.canAct).toBe(true);
 await expect(contractSharedWorkspace(outsider,f.caseId)).rejects.toMatchObject({code:'forbidden'});
 const waiting=await contractSharedWaiting(admin,[f.caseId]);expect(waiting[0].waitingOn).toBe('CEO');expect(waiting[0].waitingFor).toBeTruthy();
 const approved=await actContractSharedApproval(outsider,{id:approvalId,actionId:randomUUID(),layerId:approval.pendingLayerId!,revision:approval.contentRevision,hash:approval.contentHash,action:'approve',reason:'Agreed'});expect(approved.status).toBe('approved');
 const [event]=await owner.db.execute<{id:string}>(sql`select job_id as id from contract_shared_event where tenant_id=${b.tenantId}::uuid and case_id=${f.caseId}::uuid and trigger_event='approvalsComplete'`);await tickToDone(event.id,outsider,'contract_automation');
 const letterId=(await contractSharedWorkspace(admin,f.caseId)).letters[0].id,letter=await readContractSharedLetter(admin,letterId);
 expect(letter.pendingAction?.kind).toBe('review');expect((await pendingContractSharedTasks(admin,undefined)).some(t=>t.id===letterId&&t.kind==='contractLetter')).toBe(true);expect(await pendingContractSharedTasks(f.employeeSession,undefined)).toEqual([]);
 await actContractSharedLetter(admin,{id:letterId,actionId:randomUUID(),stepId:letter.pendingAction!.stepId,revision:letter.contentRevision,hash:letter.contentHash!,action:'reviewed'});
 const employeeTasks=await pendingContractSharedTasks(f.employeeSession,undefined);expect(employeeTasks).toHaveLength(1);expect(employeeTasks[0]).toMatchObject({id:letterId,kind:'contractLetter',linkPath:'/lifecycle/contracts/letters/'+letterId,subjectName:'Fictional Contract employee'});
 expect(Object.keys(employeeTasks[0]).sort()).toEqual(['createdAt','id','kind','linkPath','subjectName']);
 expect((await readContractSharedLetter(f.employeeSession,letterId)).pendingAction?.kind).toBe('sign');await expect(contractSharedWorkspace(f.employeeSession,f.caseId)).rejects.toMatchObject({code:'forbidden'});
 expect(JSON.stringify([...employeeTasks,...workspace.approvals,...workspace.runs])).not.toMatch(/497621|4976\.21|candidatePersonIds|signingPolicy|holderPersonId/);
 const other=await ordinary('Fictional wrong relinked identity');await owner.db.execute(sql`update app_user set person_id=${other.personId!}::uuid where id=${f.employeeSession.userId!}::uuid`);
 expect(await pendingContractSharedTasks({...f.employeeSession,personId:other.personId},undefined)).toEqual([]);
 await owner.db.execute(sql`update app_user set person_id=${f.employee.personId}::uuid where id=${f.employeeSession.userId!}::uuid`);
 expect(await contractSharedLetterActions(admin,letterId)).toEqual({canBindEmployee:false});
 const currentGroups=(await v9Workspace(admin)).config!;await v9SaveConfig(admin,currentGroups.revision,{...currentGroups,groups:currentGroups.groups.map(g=>g.id===f.ceo?{...g,members:[]}:g)});
 expect(await pendingContractSharedTasks(outsider,undefined)).toEqual([]);
},180000);
it('limits configuration and person choices to the real access administrator',async()=>{
 const viewer=await ordinary('Fictional company access delegate'),roleId=randomUUID();
 await saveContractSharedRole(admin,{id:roleId,name:'Company configuration only',permissions:['access'],expectedRevision:0});await saveContractSharedMember(admin,{id:randomUUID(),roleId,userId:viewer.userId!,companyId:b.companyId,businessGroupId:null,validFrom:start,validTo:null,revoked:false});
 const choices=await contractSharedConfigurationChoices(viewer);expect(choices.accessAdmin).toBe(false);expect(choices.companies.map(c=>c.id)).toContain(b.companyId);expect(choices.people).toEqual([]);expect(choices.scopes).toEqual([]);
 await expect(contractSharedAccessPeople(viewer,'Fictional')).rejects.toThrow();
 const allowed=await contractSharedAccessPeople(admin,'Fictional company access delegate');expect(allowed).toEqual([{id:viewer.userId,name:'Fictional company access delegate'}]);
 expect(JSON.stringify(allowed)).not.toMatch(/primary_email|workos|salary|personId/);
});
it('reads all 1,000 actual open case assignments across 70 companies and matches the native owner under one company',async()=>{
 // The sibling tracker fixture already measures the same 1,000/70 Personnel shape. Here every employment also has
 // a current case, so the assigned-work reader cannot pass by reading a thousand employments but one case.
 await owner.db.execute(sql`with companies as(insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'Workspace company '||lpad(n::text,2,'0') from generate_series(1,70) n returning id,legal_name),departments as(insert into department(tenant_id,company_id,name) select ${b.tenantId}::uuid,id,'Workspace department' from companies returning id,company_id),numbered as materialized(select c.id,d.id as department_id,row_number() over(order by c.legal_name) as n from companies c join departments d on d.company_id=c.id),fixture as materialized(select n,gen_random_uuid() as person_id,gen_random_uuid() as employment_id,c.id as company_id,c.department_id from generate_series(1,1000) n join numbered c on c.n=((n-1)%70)+1),people as(insert into person(id,tenant_id,full_name,primary_email) select person_id,${b.tenantId}::uuid,'Workspace employee '||lpad(n::text,4,'0'),'workspace-scale-'||n||'@workspace.test' from fixture),employments as(insert into employment(id,tenant_id,person_id,company_id,hired_on,employee_code,contract_start_date,contract_end_date,contract_number) select employment_id,${b.tenantId}::uuid,person_id,company_id,${start}::date,'WORKSPACE-SCALE-'||n,${start}::date,${end}::date,4 from fixture) insert into assignment(id,tenant_id,employment_id,company_id,department_id,employment_type,valid_from) select gen_random_uuid(),${b.tenantId}::uuid,employment_id,company_id,department_id,'contract',${start}::date from fixture`);
 await owner.db.execute(sql`with fixture as materialized(select e.id as employment_id,e.company_id,gen_random_uuid() as term_id,gen_random_uuid() as case_id,app.contract_shared_period_revision(e.id) as source_revision from employment e where e.tenant_id=${b.tenantId}::uuid and e.employee_code like 'WORKSPACE-SCALE-%'),terms as(insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision) select term_id,${b.tenantId}::uuid,company_id,employment_id,1,'fixed_term',${start}::date,${end}::date,source_revision from fixture),cases as(insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data) select case_id,${b.tenantId}::uuid,company_id,employment_id,term_id,'CT-WORKSPACE-'||case_id::text,1,jsonb_build_object('revision',1,'state','upcoming','term',jsonb_build_object('id',term_id,'startOn',${start}::text,'endOn',${end}::text),'decision',NULL,'decisionDraft',NULL) from fixture) insert into contract_shared_case(tenant_id,case_id,revision,data) select ${b.tenantId}::uuid,case_id,1,jsonb_build_object('version',2,'revision',1,'stage','open','period',jsonb_build_object('id',term_id,'startOn',${start}::text,'endOn',${end}::text,'number','4','sourceRevision',source_revision),'decision',NULL,'decisionHistory','[]'::jsonb,'flags','[]'::jsonb,'lastActivityAt',now(),'posting',NULL,'payConfirmation',NULL,'offboardingId',NULL,'declined',NULL) from fixture`);
 admin={...await entitledCtx(b),personId:admin.personId};
 const all=await pendingContractSharedTasks(admin,undefined),expected=await owner.db.execute<{id:string;companyId:string;name:string}>(sql`select c.id,c.company_id as "companyId",p.full_name as name from contract_shared_case f join contract_case c on c.tenant_id=f.tenant_id and c.id=f.case_id join employment e on e.tenant_id=c.tenant_id and e.id=c.employment_id join person p on p.tenant_id=e.tenant_id and p.id=e.person_id where f.tenant_id=${b.tenantId}::uuid order by c.id`);
 expect(all).toHaveLength(1000);expect(all.map(t=>t.id)).toEqual(expected.map(r=>r.id));expect(all.every(t=>t.kind==='contractDecision')).toBe(true);expect(new Set(expected.map(r=>r.companyId)).size).toBe(70);
 const company=expected[0].companyId,single=await pendingContractSharedTasks(admin,[company]),oracle=expected.filter(r=>r.companyId===company);expect(single.map(t=>t.id)).toEqual(oracle.map(r=>r.id));expect(single.map(t=>t.subjectName)).toEqual(oracle.map(r=>r.name));
 const viewer=await ordinary('Fictional scoped decision delegate'),roleId=randomUUID();await saveContractSharedRole(admin,{id:roleId,name:'Scoped decisions',permissions:['view','decide'],expectedRevision:0});await saveContractSharedMember(admin,{id:randomUUID(),roleId,userId:viewer.userId!,companyId:company,businessGroupId:null,validFrom:start,validTo:null,revoked:false});
 expect((await pendingContractSharedTasks(viewer,undefined)).map(t=>t.id)).toEqual(oracle.map(r=>r.id));expect(await pendingContractSharedTasks(viewer,[expected.find(r=>r.companyId!==company)!.companyId])).toEqual([]);
 const unrelated=await ordinary('Fictional unrelated employee');expect(await pendingContractSharedTasks(unrelated,undefined)).toEqual([]);
 expect(await contractSharedWaiting(admin,expected.slice(0,100).map(r=>r.id))).toEqual([]);
 expect(JSON.stringify(all)).not.toMatch(/salary|candidatePerson|contentHash|sourceRevision|reason/);
},180000);
