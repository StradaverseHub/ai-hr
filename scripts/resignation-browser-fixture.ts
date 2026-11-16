/** Public synthetic fixture for the hosted resignation renderer. Never targets an installation. */
import {demoSeedRefusal,DEMO_TENANT_ID,SYSTEM_TENANT_ID} from '../db/seed-guard';
import {demoSwitcherEnabled} from '../lib/demo-mode';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import type {SessionContext} from '../db/client';
const refusal=demoSeedRefusal(process.env);if(refusal)throw Error(refusal);
if(process.env.GITHUB_ACTIONS!=='true'||process.env.CI!=='true'||process.env.NODE_ENV==='production'||!demoSwitcherEnabled()||process.env.TEST_DB_NAMESPACE!=='resignationbrowser')throw Error('Hosted fictional resignation fixture only.');
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL']){const url=new URL(process.env[key]??'');if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5433'||url.pathname!=='/ai_hr_resignation_browser'||url.search||url.hash)throw Error('Closed disposable resignation database required.');}
const requested=process.argv[2]??'prepare';if(!['prepare','observe','clearance','publish-regeneration'].includes(requested)||process.argv.length>3)throw Error('Unknown fixture operation.');
type Actor={key:string;userId:string;personId:string|null;employmentId?:string;name:string};
type Fixture={version:1;tenantId:string;companyId:string;actors:Actor[];lastWorkingDay:string;effectiveDate:string;groupId:string;retentionTemplateId:string;acceptanceTemplateId:string;workflowIds:string[];privateSentinel:string};
async function main(){
 const {randomUUID}=await import('node:crypto'),{and,eq,isNull,sql}=await import('drizzle-orm');
 const {createDb,client}=await import('../db/client'),s=await import('../db/schema');
 const {resolveEntitlementsTx}=await import('../core/entitlements'),{assignRole,createDepartment,createPosition,createJobGrade}=await import('../core/admin'),{hireEmployee,setEmploymentGrade}=await import('../core/org'),{setCompensation}=await import('../core/comp');
 const {v9Setup,v9SaveConfig,v9Configuration,v9CaseDetail,v9Command}=await import('../packs/lifecycle/service');
 const {saveAutomationWorkflow}=await import('../packs/automation/service');
 const {resignationEmployeeView,installResignationDefaults}=await import('../packs/lifecycle/resignation/service');
 const {resignationRuntimeKey}=await import('../lib/resignation-runtime-proof');
 const owner=createDb(process.env.MIGRATION_DATABASE_URL!),tenantId=DEMO_TENANT_ID,event='dev.resignation-browser.fixture-prepared',reserved=await owner.client.reserve();
 try{
  await reserved`select pg_advisory_lock(hashtextextended('resignation-browser-fixture',0))`;
  const tenants=await owner.db.select({id:s.tenant.id}).from(s.tenant);if(!tenants.some(t=>t.id===tenantId)||tenants.some(t=>![tenantId,SYSTEM_TENANT_ID].includes(t.id)))throw Error('Fresh demo database required.');
  async function context(actor:{userId:string;personId:string|null}):Promise<SessionContext>{const grants=await owner.db.select({role:s.roleAssignment.role,companyId:s.roleAssignment.companyId}).from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId,tenantId),eq(s.roleAssignment.appUserId,actor.userId)));return{tenantId,userId:actor.userId,personId:actor.personId,grants,roles:[...new Set(grants.map(g=>g.role))],entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenantId))};}
  if(requested==='prepare'){await owner.db.execute(sql`update tenant_module set status='active',expires_at=null where tenant_id=${tenantId}::uuid and module_code='lifecycle' and company_id is null`);
  await owner.db.execute(sql`insert into tenant_module(tenant_id,module_code,status) select ${tenantId}::uuid,'lifecycle','active' where not exists(select 1 from tenant_module where tenant_id=${tenantId}::uuid and module_code='lifecycle' and company_id is null)`);}
  const [user]=await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId,tenantId),eq(s.appUser.workosUserId,'user_dev_admin'),isNull(s.appUser.archivedAt)));if(!user)throw Error('Seeded administrator required.');
  const root=await context({userId:user.id,personId:user.personId});if(!root.grants?.some(g=>g.companyId===null&&['hr_admin','super_admin'].includes(g.role)))throw Error('Actual group authority required.');
  if(requested==='prepare')await owner.db.execute(sql`insert into app.resignation_runtime_verifier(singleton,secret) values(true,${resignationRuntimeKey(process.env.AUTH_SESSION_KEY!)}) on conflict(singleton) do update set secret=excluded.secret`);
  const [existing]=await owner.db.select({payload:s.domainEvent.payload}).from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,tenantId),eq(s.domainEvent.eventType,event))).limit(1);
  let fixture:Fixture;
  if(existing)fixture=existing.payload as Fixture;
  else{
   if(requested!=='prepare')throw Error('Prepare synthetic identities first.');
   const [company]=await owner.db.select({id:s.company.id}).from(s.company).where(and(eq(s.company.tenantId,tenantId),isNull(s.company.archivedAt))).orderBy(s.company.id).limit(1);if(!company)throw Error('Seeded company required.');
   const department=await createDepartment(root,{companyId:company.id,name:'Fictional resignation browser team'});
   const position=await createPosition(root,{companyId:company.id,title:'Fictional resignation coordinator'});
   const grade=await createJobGrade(root,{code:'RJ_BROWSER',name:'Fictional resignation grade',scopeCompanyIds:[company.id]});
   const actors:Actor[]=[{key:'configurer',userId:user.id,personId:user.personId,name:'Fixture configuration administrator'}];
   const manager=await hireEmployee(root,{person:{fullName:'Fictional resignation manager',primaryEmail:'rj-manager@example.invalid'},companyId:company.id,departmentId:department.id,positionId:position.id,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
   for(const key of ['manager','bp','accept','retain','decline','recall','outsider']){
    const hired=key==='manager'?manager:await hireEmployee(root,{person:{fullName:'Fictional resignation '+key,primaryEmail:'rj-'+key+'@example.invalid'},companyId:company.id,departmentId:department.id,positionId:position.id,employmentType:'full_time',hiredOn:todayInKualaLumpur(),reportingManagerEmploymentId:manager.employmentId});
    await setEmploymentGrade(root,{employmentId:hired.employmentId,gradeId:grade.id});
    const [account]=await owner.db.insert(s.appUser).values({tenantId,personId:hired.personId,workosUserId:'resignation-browser:'+key,onboardedAt:new Date()}).returning();
    await assignRole(root,{appUserId:account.id,role:key==='manager'?'hr_admin':'employee',...(key==='manager'?{companyId:company.id}:{})});
    actors.push({key,userId:account.id,personId:hired.personId,employmentId:hired.employmentId,name:'Fictional resignation '+key});
    if(['accept','retain','decline','recall'].includes(key))await setCompensation(root,{employmentId:hired.employmentId,basicSalary:5000,monthlyAllowance:0,effectiveFrom:todayInKualaLumpur()});
   }
   const [configured]=await owner.db.execute<{present:boolean}>(sql`select exists(select 1 from lc_v9_config where tenant_id=${tenantId}::uuid) as present`);if(!configured.present)await v9Setup(root);
   await installResignationDefaults(root);
   const projection=await v9Configuration(root),config=structuredClone(projection.config!);if(!config)throw Error('Lifecycle configuration required.');
   const decisionActor=actors.find(a=>a.key==='manager')!,bp=actors.find(a=>a.key==='bp')!,groupId=randomUUID(),retentionTemplateId=randomUUID(),acceptanceTemplateId=randomUUID();
   config.groups.push({id:groupId,name:'Fictional resignation People Ops',members:[decisionActor.userId,user.id],limit:100});config.peopleOpsGroup=groupId;config.offboarding={postingApproverGroupId:groupId,reofferMonths:12};
   const [leaveType]=await owner.db.execute<{id:string}>(sql`select id from leave_type where tenant_id=${tenantId}::uuid and archived_at is null order by case when code='AL' then 0 else 1 end,id limit 1`);if(leaveType&&config.settlementPolicy)config.settlementPolicy.leaveTypeIds=[leaveType.id];
   for(const [id,kind]of [[retentionTemplateId,'retention'],[acceptanceTemplateId,'acceptance']]as const)config.templates.push({id,name:'Fictional '+kind+' letter',module:'off',type:'Letter',rules:{},hrStep:'none',employeeAck:true,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:new Date().toISOString(),by:'Fixture configuration administrator',fields:[],routing:[{id:'owner-review',order:1,action:'review',who:{kind:'people',userIds:[decisionActor.userId]},owner:true},{id:'employee-sign',order:2,action:'sign',who:{kind:'employee'},owner:false}],blocks:[{id:'heading',type:'heading',text:kind==='retention'?'Retention offer':'Resignation accepted',section:'main'},{id:'body',type:'text',text:kind==='retention'?'Dear {employee.name}, proposed position {retention.title}, base salary {retention.salary}, effective {retention.effectiveDate}.':'Dear {employee.name}, your last working day is {resignation.lastDay}.',section:'main'},{id:'signature',type:'signature',text:'',role:'step:employee-sign',label:'Employee signature',section:'main'}]}]});
   await v9SaveConfig(root,config.revision,config);
   const workflows=[
    {event:'submitted',steps:[{id:'decision',type:'requestDecision',to:[{kind:'person',userId:decisionActor.userId}],cc:[],conditions:[],params:{choices:'both',watch:[{kind:'person',userId:bp.userId}],canComment:true,dueDays:3}}]},
    {event:'retention',steps:[{id:'letter',type:'generateDocument',to:[],cc:[],conditions:[],params:{letterTemplateId:retentionTemplateId,replyDays:5,remindDays:2}}]},
    {event:'accepted',steps:[{id:'letter',type:'generateDocument',to:[],cc:[],conditions:[],params:{letterTemplateId:acceptanceTemplateId}},{id:'clearance',type:'startOffboarding',to:[],cc:[],conditions:[],params:{exitReason:'Resignation'}}]},
    {event:'offerDeclined',steps:[{id:'accept-only',type:'requestDecision',to:[{kind:'person',userId:decisionActor.userId}],cc:[],conditions:[],params:{choices:'accept',watch:[{kind:'person',userId:bp.userId}],canComment:true}}]},
    {event:'offerAccepted',steps:[{id:'posting',type:'createPosting',to:[],cc:[],conditions:[],params:{eventType:'Promotion',dateFrom:'offerEff',fields:['title','grade','salary']}}]},
   ];const workflowIds:string[]=[];
   for(const item of workflows){const id=randomUUID();await saveAutomationWorkflow(root,{workflow:{id,module:'off',name:'Fictional browser '+item.event,description:'Synthetic authorized resignation journey',status:'live',required:false,trigger:{event:item.event,days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:item.steps as import('../lib/automation/workflow').AutomationStep[]},expectedRevision:0,reason:'Configure fictional hosted browser journey'});workflowIds.push(id);}
   fixture={version:1,tenantId,companyId:company.id,actors,lastWorkingDay:addCalendarMonths(todayInKualaLumpur(),3),effectiveDate:addCalendarMonths(todayInKualaLumpur(),1),groupId,retentionTemplateId,acceptanceTemplateId,workflowIds,privateSentinel:'RJ_BROWSER_PRIVATE_93017'};
   await owner.db.insert(s.domainEvent).values({tenantId,aggregateType:'dev_fixture',aggregateId:tenantId,eventType:event,actorType:'user',actorId:user.id,payload:fixture});
  }
  const cases:Record<string,unknown[]>={};for(const actor of fixture.actors.filter(a=>['accept','retain','decline','recall'].includes(a.key)))cases[actor.key]=(await resignationEmployeeView(await context(actor),actor.employmentId!)).cases;
  let publishedTemplate:{id:string;version:number}|null=null;if(requested==='publish-regeneration'){const projection=await v9Configuration(root),config=structuredClone(projection.config!);const template=config.templates.find(item=>item.id===fixture.acceptanceTemplateId);if(!template)throw Error('The owned synthetic acceptance template is unavailable.');const previous=template.versions.find(version=>version.version===template.currentVersion);if(!previous)throw Error('A current published template is required.');const version=Math.max(...template.versions.map(item=>item.version))+1;template.versions.push({...structuredClone(previous),version,state:'published',at:new Date().toISOString(),by:'Fixture configuration administrator',blocks:previous.blocks.map(block=>block.id==='body'?{...block,text:block.text+' Published template revision '+version+'.'}:structuredClone(block))});template.currentVersion=version;await v9SaveConfig(root,config.revision,config);publishedTemplate={id:template.id,version};}
  let clearance:unknown=null;if(requested==='clearance'){const journey=(cases.accept as {offboardingCaseId:string|null}[])[0];if(!journey?.offboardingCaseId)throw Error('The signed acceptance must first create its actual Offboarding case.');let detail=await v9CaseDetail(root,journey.offboardingCaseId);if(detail.case.state==='pending'){await v9Command(root,journey.offboardingCaseId,detail.case.revision,{type:'submit'});detail=await v9CaseDetail(root,journey.offboardingCaseId);}if(!detail.calculation?.ready)throw Error('Synthetic clearance source missing: '+JSON.stringify(detail.calculation?.missing??[]));await v9Command(root,journey.offboardingCaseId,detail.case.revision,{type:'clear',sourceRevision:detail.calculation.sourceRevision,reason:'Fictional browser acceptance: authorized manual clearance of synthetic outstanding work.'});clearance={caseId:journey.offboardingCaseId,state:(await v9CaseDetail(root,journey.offboardingCaseId)).case.state};}
  console.log(JSON.stringify({publishedTemplate,clearance,preparationOnly:requested==='prepare',reused:!!existing,fixture,cases}));
 }finally{await reserved`select pg_advisory_unlock(hashtextextended('resignation-browser-fixture',0))`;reserved.release();await owner.client.end();await client.end();}
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error instanceof Error?error.message:'Synthetic fixture failed');process.exit(1);});
