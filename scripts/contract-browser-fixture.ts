/** Native source-service preparation for a NEW hosted fictional Contract database only. */
import {demoSeedRefusal,DEMO_TENANT_ID,SYSTEM_TENANT_ID} from '../db/seed-guard';
import {demoSwitcherEnabled} from '../lib/demo-mode';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import type {SessionContext} from '../db/client';
import {CONTRACT_BROWSER_BRANCH} from './lib/contract-browser-role-admission';
const refusal=demoSeedRefusal(process.env);if(refusal)throw Error(refusal);
if(process.env.GITHUB_ACTIONS!=='true'||process.env.CI!=='true'||process.env.NODE_ENV==='production'||!demoSwitcherEnabled()||process.env.TEST_DB_NAMESPACE!=='contractbrowser')throw Error('Hosted fictional Contract fixture only.');
if(process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.GITHUB_WORKFLOW!=='contract-walkthrough'||process.env.GITHUB_JOB!=='production-renderer'||process.env.GITHUB_REF!=='refs/heads/'+CONTRACT_BROWSER_BRANCH||!process.env.AIHR_CI_HEAD||process.env.AIHR_CI_HEAD!==process.env.AIHR_CI_CONTROL_HEAD||process.env.AIHR_CI_HEAD!==process.env.GITHUB_SHA)throw Error('Exact hosted Contract source required.');
for(const [key,user] of [['DATABASE_URL','ai_hr_app'],['MIGRATION_DATABASE_URL','postgres']] as const){const url=new URL(process.env[key]??'');if(url.protocol!=='postgres:'||url.hostname!=='127.0.0.1'||url.port!=='5433'||url.username!==user||url.password||url.pathname!=='/ai_hr_contract_browser'||url.search||url.hash)throw Error('Exact disposable Contract database required.');}
const operation=process.argv[2]??'prepare';if(!['prepare','observe','tick'].includes(operation)||process.argv.length>3)throw Error('Unknown Contract fixture operation.');
type Actor={key:'configurer'|'proposer'|'peopleOps'|'ceo'|'bp'|'employee'|'outsider'|'conversionEmployee'|'endingEmployee'|'declineEmployee';userId:string;personId:string;employmentId:string|null;name:string};
type Fixture={version:2;tenantId:string;companyId:string;companyName:string;businessUnitId:string;businessUnitName:string;departmentId:string;departmentName:string;employmentId:string;actors:Actor[];groupId:string;roleId:string;workflowId:string;templateId:string;templateName:string;initialSalary:string;agreedSalary:string;startOn:string;endOn:string;newStartOn:string;newEndOn:string;contractNumber:number;routingId:string;emailTemplateId:string;scenarios:Record<'renewPay'|'conversion'|'ending'|'decline',{employmentId:string;actorKey:Actor['key']}> };
async function main(){
 const {randomUUID}=await import('node:crypto'),{and,eq,isNull,sql}=await import('drizzle-orm');
 const {createDb,client}=await import('../db/client'),s=await import('../db/schema');
 const {createAdminChain}=await import('../db/provision'),{completeOnboarding}=await import('../core/onboarding');
 const {resolveEntitlementsTx}=await import('../core/entitlements'),{assignRole,createBusinessUnit,createDepartment,createPosition}=await import('../core/admin');
 const {hireEmployee,setEmploymentInfo}=await import('../core/org'),{setCompensation}=await import('../core/comp');
 const {v9Setup,v9Configuration,v9SaveConfig,onboardingRegisterContext,onboardingSaveConfig}=await import('../packs/lifecycle/service');
 const {saveAutomationWorkflow,saveAutomationDocumentTemplate,listAutomationWorkflows,saveAutomationEmailTemplate,saveAutomationRouting,automationBusinessPartnerWorkspace}=await import('../packs/automation/service');
 const {saveContractSharedRole,saveContractSharedMember,contractSharedSettings,saveContractSharedSettings,contractPreviewJobHandler,contractAutomationJobHandler,contractPostingApplyJobHandler}=await import('../packs/contracts/service');
 const {runBulkJobTick}=await import('../core/bulk-job-worker');
 const {openImportWorkerOwner}=await import('../db/worker-connection');
 const owner=createDb(process.env.MIGRATION_DATABASE_URL!),tenantId=DEMO_TENANT_ID,event='dev.contract-browser.fixture-prepared',reserved=await owner.client.reserve();
 try{
  await reserved`select pg_advisory_lock(hashtextextended('contract-browser-fixture',0))`;
  const tenants=await owner.db.select({id:s.tenant.id}).from(s.tenant);
  if(!tenants.some(t=>t.id===tenantId)||tenants.some(t=>![tenantId,SYSTEM_TENANT_ID].includes(t.id)))throw Error('Fresh seeded demo database required.');
  async function context(actor:{userId:string;personId:string|null}):Promise<SessionContext>{const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId,tenantId),eq(s.roleAssignment.appUserId,actor.userId)));return{tenantId,userId:actor.userId,personId:actor.personId,grants,roles:[...new Set(grants.map(g=>g.role))],entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenantId))};}
  const [existing]=await owner.db.select({payload:s.domainEvent.payload}).from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,tenantId),eq(s.domainEvent.eventType,event))).limit(1);
  let fixture:Fixture;
  if(existing){fixture=existing.payload as Fixture;if(fixture.version!==2)throw Error('Fixture contract changed.');}
  else{
   if(operation!=='prepare')throw Error('Prepare the native fictional identities first.');
   await owner.db.execute(sql`update tenant_module set status='active',expires_at=null where tenant_id=${tenantId}::uuid and module_code='lifecycle' and company_id is null`);
   await owner.db.execute(sql`insert into tenant_module(tenant_id,module_code,status) select ${tenantId}::uuid,'lifecycle','active' where not exists(select 1 from tenant_module where tenant_id=${tenantId}::uuid and module_code='lifecycle' and company_id is null)`);
   const [admin]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,'user_dev_admin'),isNull(s.appUser.archivedAt)));
   if(!admin)throw Error('Seeded administrator required.');let root=await context({userId:admin.id,personId:admin.personId});
   if(!root.grants?.some(g=>g.companyId===null&&['hr_admin','super_admin'].includes(g.role)))throw Error('Actual tenant administrator required.');
   const chain=await owner.db.transaction(tx=>createAdminChain(tx,tenantId,{email:'contract-configurer@example.invalid',fullName:'Fictional Contract configurer',withRoleAssignment:false}));
   await assignRole(root,{appUserId:chain.appUserId,role:'hr_admin'});root=await context({userId:chain.appUserId,personId:chain.personId});await completeOnboarding(root);
   const [company]=await owner.db.select({id:s.company.id,name:s.company.legalName}).from(s.company).where(and(eq(s.company.tenantId,tenantId),isNull(s.company.archivedAt))).orderBy(s.company.id).limit(1);if(!company)throw Error('Seeded company required.');
   const businessUnitName='Fictional Contract browser unit',departmentName='Fictional Contract browser team';
   const businessUnit=await createBusinessUnit(root,{companyId:company.id,code:'CONTRACT-BROWSER-BP',name:businessUnitName});
   const department=await createDepartment(root,{companyId:company.id,businessUnitId:businessUnit.id,name:departmentName}),position=await createPosition(root,{companyId:company.id,title:'Fictional Contract specialist'});
   const today=todayInKualaLumpur(),startOn=addCalendarMonths(today,-12),endOn=addDaysIso(today,-1),newStartOn=today,newEndOn=addDaysIso(addCalendarMonths(today,6),-1);
   const actors:Actor[]=[{key:'configurer',userId:chain.appUserId,personId:chain.personId,employmentId:null,name:'Fictional Contract configurer'}];
   for(const key of ['proposer','peopleOps','ceo','bp','employee','outsider','conversionEmployee','endingEmployee','declineEmployee'] as const){
    const subject=['employee','conversionEmployee','endingEmployee','declineEmployee'].includes(key);
    const hired=await hireEmployee(root,{person:{fullName:'Fictional Contract '+key,primaryEmail:'contract-'+key+'@example.invalid'},companyId:company.id,businessUnitId:businessUnit.id,departmentId:department.id,positionId:position.id,employmentType:subject?'contract':'full_time',hiredOn:startOn,...(subject?{provisionalEndOn:endOn,reportingManagerEmploymentId:actors.find(a=>a.key==='proposer')!.employmentId!}:{})});
    const [account]=await owner.db.insert(s.appUser).values({tenantId,personId:hired.personId,workosUserId:'contract-browser:'+key,onboardedAt:new Date()}).returning();
    await assignRole(root,{appUserId:account.id,role:key==='peopleOps'?'hr_admin':'employee',...(key==='peopleOps'?{companyId:company.id}:{})});
    actors.push({key,userId:account.id,personId:hired.personId,employmentId:hired.employmentId,name:'Fictional Contract '+key});
    if(subject){await setEmploymentInfo(root,{employmentId:hired.employmentId,contractStartDate:startOn,contractEndDate:endOn,contractNumber:4});await setCompensation(root,{employmentId:hired.employmentId,basicSalary:4800,effectiveFrom:startOn});}
   }
   const [configured]=await owner.db.execute<{present:boolean}>(sql`select exists(select 1 from lc_v9_config where tenant_id=${tenantId}::uuid) present`);if(!configured.present)await v9Setup(root);
   const peopleOps=actors.find(a=>a.key==='peopleOps')!,bp=actors.find(a=>a.key==='bp')!,ceo=actors.find(a=>a.key==='ceo')!,employee=actors.find(a=>a.key==='employee')!;
   const nativeAccess=await onboardingRegisterContext(root);if(!nativeAccess.actor.master)throw Error('Actual native Master Admin required for fictional Offboarding access');
   await onboardingSaveConfig(root,nativeAccess.revision,{...nativeAccess.config,access:{...nativeAccess.config.access,offboarding:[...new Set([...nativeAccess.config.access.offboarding,root.userId!,peopleOps.userId])]}});
   // Access configuration advances the native shared revision; read it before saving groups.
   const config=(await v9Configuration(root)).config!;if(!config?.peopleOpsGroup)throw Error('Native People Ops group required.');
   await v9SaveConfig(root,config.revision,{...config,groups:config.groups.map(group=>group.id===config.peopleOpsGroup?{...group,name:'Fictional Contract People Ops',members:[peopleOps.userId]}:group)});
   const roleId=randomUUID();await saveContractSharedRole(root,{id:roleId,name:'Fictional People Business Partner',permissions:['view','decide'],expectedRevision:0});
   await saveContractSharedMember(root,{id:randomUUID(),roleId,userId:bp.userId,companyId:company.id,businessGroupId:null,validFrom:startOn,validTo:null,revoked:false,expectedRevision:0});
   const settings=await contractSharedSettings(root,company.id);await saveContractSharedSettings(root,{companyId:company.id,expectedRevision:settings.revision,settings:{...settings.settings,fallbackGroupId:config.peopleOpsGroup,postingApproverGroupId:config.peopleOpsGroup}});
   if((await listAutomationWorkflows(root,{module:'contract_staff'})).length)throw Error('Expected a fresh Contract automation namespace; existing workflows were preserved.');
   const workflowId=randomUUID(),templateId=randomUUID(),templateName='Fictional Contract renewal agreement';
   await saveAutomationDocumentTemplate(root,{template:{id:templateId,module:'contract_staff',name:templateName,description:'Native fictional browser acceptance',rules:{decision:['Renew']},blocks:[{id:'terms',type:'text',text:'Dear {employee.name},\n\nYour contract is renewed from {contract.newStart} to {contract.newEnd}. The agreed basic salary is RM 5,200.12.\n\nPlease review and sign.',section:''}],fields:[],routing:[{id:randomUUID(),order:1,action:'review',owner:true,who:{kind:'people',userIds:[peopleOps.userId]}},{id:randomUUID(),order:2,action:'sign',owner:false,who:{kind:'people',userIds:[bp.userId]}},{id:randomUUID(),order:3,action:'sign',owner:false,who:{kind:'employee'}}]},expectedRevision:0,publish:true,retired:false});
   await saveAutomationWorkflow(root,{workflow:{id:workflowId,module:'contract_staff',name:'Fictional Contract renewal journey',description:'Native browser acceptance: approval, letter and Personnel posting',status:'live',required:false,trigger:{event:'decisionSubmitted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[{field:'decision',op:'is',values:['Renew']}],steps:[{id:randomUUID(),type:'requestApproval',conditions:[],to:[],cc:[],params:{layers:[{id:randomUUID(),name:'CEO approval',pick:'any',approver:{kind:'person',userId:ceo.userId}}]}},{id:randomUUID(),type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:templateId}},{id:randomUUID(),type:'createPosting',conditions:[],to:[],cc:[],params:{eventType:'Renewal'}}]},expectedRevision:0,reason:'Fictional native Contract browser acceptance'});
   // All extra scenarios start as real Personnel employments only. Cases, routes, signatures,
   // postings and Offboarding receipts must subsequently be created by the actual UI/kernel.
   const routingId=randomUUID(),emailTemplateId=randomUUID();
   await saveAutomationRouting(root,{routing:{id:routingId,name:'Fictional BP by business group',rows:[{match:{},assignTo:{kind:'people',userIds:[bp.userId]}}]},retired:false,expectedRevision:0,reason:'Native fictional browser routing'});
   await saveAutomationEmailTemplate(root,{template:{id:emailTemplateId,module:'contract_staff',name:'Fictional Contract email preview',active:true,subject:'Contract update for {{employee.name}}',body:'Dear {{employee.name}},\nPlease review your Contract case.\n{{case.link}}',cc:[{kind:'routing',routingId}]},retired:false,expectedRevision:0,reason:'Native fictional browser email preview only; no Send email step'});
   for(const kind of ['convert','end','declined'] as const){
    const id=randomUUID(),decision=kind==='convert'?'Convert to permanent':'End';
    await saveAutomationDocumentTemplate(root,{template:{id,module:'contract_staff',name:'Fictional Contract '+kind+' letter',description:'Native fictional outcome',rules:{},blocks:[{id:'terms',type:'text',text:kind==='convert'?'Dear {employee.name}, your employment becomes permanent from {contract.newStart}.':'Dear {employee.name}, your fixed-term contract ends on {contract.end}.',section:''}],fields:[],routing:[{id:randomUUID(),order:1,action:'review',owner:true,who:{kind:'people',userIds:[peopleOps.userId]}},{id:randomUUID(),order:2,action:'sign',owner:false,who:{kind:'people',userIds:[bp.userId]}},...(kind==='convert'?[{id:randomUUID(),order:3,action:'sign' as const,owner:false,who:{kind:'employee' as const}}]:[])]},expectedRevision:0,publish:true,retired:false});
    await saveAutomationWorkflow(root,{workflow:{id:randomUUID(),module:'contract_staff',name:'Fictional Contract '+kind+' journey',description:'Native fictional browser outcome',status:'live',required:false,trigger:{event:kind==='declined'?'employeeDeclined':'decisionSubmitted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:kind==='declined'?[]:[{field:'decision',op:'is',values:[decision]}],steps:[{id:randomUUID(),type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:id}},{id:randomUUID(),type:kind==='convert'?'createPosting':'startOffboarding',conditions:[],to:[],cc:[],params:kind==='convert'?{eventType:'Conversion to permanent'}:{}}]},expectedRevision:0,reason:'Native fictional browser outcome'});
   }
   fixture={version:2,tenantId,companyId:company.id,companyName:company.name,businessUnitId:businessUnit.id,businessUnitName,departmentId:department.id,departmentName,employmentId:employee.employmentId!,actors,groupId:config.peopleOpsGroup,roleId,workflowId,templateId,templateName,initialSalary:'4800.00',agreedSalary:'5200.12',startOn,endOn,newStartOn,newEndOn,contractNumber:4,routingId,emailTemplateId,scenarios:Object.fromEntries(([['renewPay','employee'],['conversion','conversionEmployee'],['ending','endingEmployee'],['decline','declineEmployee']] as const).map(([key,actorKey])=>[key,{employmentId:actors.find(a=>a.key===actorKey)!.employmentId!,actorKey}])) as Fixture['scenarios']};
   await owner.db.insert(s.domainEvent).values({tenantId,aggregateType:'tenant',aggregateId:tenantId,eventType:event,actorType:'system',actorId:null,payload:fixture});
  }
  if(operation==='tick'){
   const errors:string[]=[];const handlers=[contractPreviewJobHandler,contractAutomationJobHandler,contractPostingApplyJobHandler].map(handler=>({...handler,describeFailure:async(...args:Parameters<NonNullable<typeof handler.describeFailure>>)=>{errors.push(String(args[1]));return handler.describeFailure!(...args);}}));
   const queue=openImportWorkerOwner(process.env.MIGRATION_DATABASE_URL!);
   try{
    for(let count=0;count<200;count++){const [pending]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from bulk_job where tenant_id=${tenantId}::uuid and kind in('contract_preview','contract_automation','contract_posting_apply') and state not in('completed','failed','cancelled')`);if(!pending.n)break;await runBulkJobTick(queue,{handlers});if(count===199)throw Error('Contract native jobs did not quiesce.');}
   }finally{await queue.end({timeout:5});}
   if(errors.length)throw Error('Native Contract worker failed: '+errors.join('; '));
  }
  const subjectIds='{'+Object.values(fixture.scenarios).map(s=>s.employmentId).join(',')+'}';
  const cases=await owner.db.execute<{id:string;flow:Record<string,unknown>}>(sql`select c.id,c.employment_id,f.data as flow from contract_case c left join contract_shared_case f on f.tenant_id=c.tenant_id and f.case_id=c.id where c.tenant_id=${tenantId}::uuid and c.employment_id=any(${subjectIds}::uuid[]) order by c.created_at,c.id`);
  const approvals=await owner.db.execute(sql`select id,case_id,data->>'status' status from contract_shared_approval where tenant_id=${tenantId}::uuid and case_id in(select id from contract_case where tenant_id=${tenantId}::uuid and employment_id=any(${subjectIds}::uuid[])) order by created_at,id`);
  const letters=await owner.db.execute(sql`select l.id,l.case_id,l.data->>'state' state,coalesce(d.data->'actions','[]'::jsonb) history from contract_shared_letter l left join document_signing_document d on d.tenant_id=l.tenant_id and d.id=l.signing_document_id where l.tenant_id=${tenantId}::uuid and l.case_id in(select id from contract_case where tenant_id=${tenantId}::uuid and employment_id=any(${subjectIds}::uuid[])) order by l.updated_at,l.id`);
  const postings=await owner.db.execute(sql`select id,source_ref as case_id,status,proposed,applied from personnel_posting where tenant_id=${tenantId}::uuid and source='contract_staff' and employment_id=any(${subjectIds}::uuid[]) order by created_at,id`);
  const workflows=await owner.db.execute(sql`select revision,definition->>'name' name from automation_workflow_version where tenant_id=${tenantId}::uuid and workflow_id=${fixture.workflowId}::uuid order by revision`);
  const [facts]=await owner.db.execute(sql`select e.contract_start_date::text start_on,e.contract_end_date::text end_on,e.contract_number,co.basic_salary::text salary from employment e left join lateral(select basic_salary from compensation where tenant_id=e.tenant_id and employment_id=e.id and superseded_at is null and valid_from<=(now() at time zone 'Asia/Kuala_Lumpur')::date and(valid_to is null or valid_to>(now() at time zone 'Asia/Kuala_Lumpur')::date) order by valid_from desc,id limit 1) co on true where e.tenant_id=${tenantId}::uuid and e.id=${fixture.employmentId}::uuid`);
  const sources=await owner.db.execute(sql`select e.id,e.person_id,e.contract_number,e.contract_end_date::text end_on,e.terminated_on::text terminated_on,
   (select count(*)::int from probation_case pc where pc.tenant_id=e.tenant_id and pc.employment_id=e.id) as probation_cases,
   (select a.employment_type from assignment a where a.tenant_id=e.tenant_id and a.employment_id=e.id and a.superseded_at is null and a.valid_from<=(now() at time zone 'Asia/Kuala_Lumpur')::date and(a.valid_to is null or a.valid_to>(now() at time zone 'Asia/Kuala_Lumpur')::date) order by a.valid_from desc,a.id limit 1) as employment_type,
   (select co.basic_salary::text from compensation co where co.tenant_id=e.tenant_id and co.employment_id=e.id and co.superseded_at is null and co.valid_from<=(now() at time zone 'Asia/Kuala_Lumpur')::date and(co.valid_to is null or co.valid_to>(now() at time zone 'Asia/Kuala_Lumpur')::date) order by co.valid_from desc,co.id limit 1) as salary
   from employment e where e.tenant_id=${tenantId}::uuid and e.id=any(${subjectIds}::uuid[]) order by e.id`);
  // Actual authorized native projection, independent of browser input/DOM. This observation performs no configuration writes.
  const businessPartners=await automationBusinessPartnerWorkspace(await context(fixture.actors.find(actor=>actor.key==='configurer')!));
  const businessPartnersOutsider=await automationBusinessPartnerWorkspace(await context(fixture.actors.find(actor=>actor.key==='outsider')!));
  console.log(JSON.stringify({preparationOnly:operation==='prepare',reused:!!existing,fixture,cases,approvals,letters,postings,workflows,facts,sources,businessPartners,businessPartnersOutsider}));
 }finally{await reserved`select pg_advisory_unlock(hashtextextended('contract-browser-fixture',0))`;reserved.release();await owner.client.end({timeout:5});await client.end({timeout:5});}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Contract fixture refused.');process.exitCode=1;});
