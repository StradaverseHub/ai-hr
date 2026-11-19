/** Fictional two-past-period native fixture. Only initial hire dates differ; both advances use real Contract owners. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../../db/client';
import {resetDb,seedBase,setModule,entitledCtx,createAppUser,owner} from '../harness';
import {hireEmployee,setEmploymentInfo} from '../../core/org';
import {setCompensation} from '../../core/comp';
import {v9Setup,v9Workspace,v9SaveConfig} from '../../packs/lifecycle/service';
import {saveAutomationDocumentTemplate,saveAutomationWorkflow,type AutomationWorkflow} from '../../packs/automation/service';
import {adoptContractSharedCase,previewContractSharedDecision,submitContractSharedDecision,contractPreviewJobHandler,contractAutomationJobHandler,readContractSharedApproval,actContractSharedApproval,readContractSharedLetter,actContractSharedLetter,listContractSharedPostings,contractSharedContext} from '../../packs/contracts/service';
import {readBulkJob} from '../../core/bulk-job';
import {runBulkJobTick} from '../../core/bulk-job-worker';
import {todayInKualaLumpur,addCalendarMonths} from '../../lib/hr-date';
import {addDaysIso} from '../../lib/roster-month';

export async function finishContractPostingJob(id:string,actor:SessionContext,kind:'contract_preview'|'contract_automation'){
 const handler=kind==='contract_preview'?contractPreviewJobHandler:contractAutomationJobHandler;let failure:unknown;
 const diagnostic={...handler,describeFailure:async(...args:Parameters<NonNullable<typeof handler.describeFailure>>)=>{failure=args[1];return handler.describeFailure!(...args);}};
 for(let count=0;count<100;count++){
  const job=await readBulkJob(actor,id,kind);
  if(job.state==='failed')throw failure??new Error(job.error??'Contract fixture job failed.');
  if(job.state==='completed')return job;
  if(job.state==='cancelled')throw new Error('Contract fixture job was cancelled.');
  await runBulkJobTick(owner.client,{handlers:[diagnostic]});
 }
 throw new Error('Contract fixture job did not finish.');
}
export async function historicalTwoPeriodPostingFixture(options:{kind?:'renew'|'convert';payChanges?:boolean;future?:boolean}={}){
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');let admin=await entitledCtx(b);
 const [adminPerson]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional Contract reviewer',${randomUUID()+'@posting.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${adminPerson.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${admin.userId}::uuid`);admin={...admin,personId:adminPerson.id};
 const today=todayInKualaLumpur(),start=addCalendarMonths(today,-24),end=addDaysIso(addCalendarMonths(today,-13),-1),newStart=addDaysIso(end,1),newEnd=addDaysIso(addCalendarMonths(newStart,6),-1);
 const actor=async(name:string)=>{
  const employment=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@posting.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:start});
  const userId=await createAppUser(b.tenantId,employment.personId,'employee');
  return {employment,ctx:{...admin,userId,personId:employment.personId,roles:['employee'],grants:undefined} as SessionContext};
 };
 const proposer=await actor('Fictional Contract proposer'),approver=await actor('Fictional Contract posting approver');
 await v9Setup(admin);const config=(await v9Workspace(admin)).config!,groupId=config.peopleOpsGroup;
 // Keep the existing shared group identity. Changing the default would exercise the separately reviewed
 // Offboarding reassignment owner; this fixture only changes the current Contract posting membership.
 await v9SaveConfig(admin,config.revision,{...config,groups:config.groups.map(g=>g.id===groupId?{...g,name:'Fictional Contract People Ops',members:[approver.ctx.userId!]}:g)});
 const employee=await hireEmployee(admin,{person:{fullName:'Fictional Contract employee',primaryEmail:randomUUID()+'@posting.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'contract',hiredOn:start,provisionalEndOn:end,reportingManagerEmploymentId:proposer.employment.employmentId});
 await setEmploymentInfo(admin,{employmentId:employee.employmentId,contractStartDate:start,contractEndDate:end,contractNumber:4});
 // Retained historical confirmation facts must survive a later Contract renewal/conversion.
 await owner.db.execute(sql`update employment set probation_end_date=${addDaysIso(start,90)}::date,confirmation_date=${addDaysIso(start,95)}::date,final_confirmation_date=${addDaysIso(start,95)}::date where tenant_id=${b.tenantId}::uuid and id=${employee.employmentId}::uuid`);
 await setCompensation(admin,{employmentId:employee.employmentId,basicSalary:4976.21,effectiveFrom:start});
 const employeeUser=await createAppUser(b.tenantId,employee.personId,'employee'),employeeActor:SessionContext={...admin,userId:employeeUser,personId:employee.personId,roles:['employee'],grants:undefined};
 const termId=randomUUID(),caseId=randomUUID(),templateId=randomUUID(),kind=options.kind??'renew';
 await owner.db.execute(sql`insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision) values(${termId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,1,'project',${start}::date,${end}::date,'fixture-native-period')`);
 await owner.db.execute(sql`insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data) values(${caseId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,${termId}::uuid,'CT-POSTING-1',1,jsonb_build_object('revision',1,'state','upcoming','term',jsonb_build_object('startOn',${start}::text,'endOn',${end}::text),'decision',NULL,'decisionDraft',NULL))`);
 await adoptContractSharedCase(proposer.ctx,caseId);
 await saveAutomationDocumentTemplate(admin,{template:{id:templateId,module:'contract_staff',name:'Fictional agreed Contract letter',description:'Posting fixture',rules:{decision:[kind==='renew'?'Renew':'Convert to permanent']},blocks:[{id:'agreed',type:'text',text:'The agreed employment starts {contract.newStart}.',section:''}],fields:[],routing:[{id:randomUUID(),order:1,action:'review',owner:true,who:{kind:'people',userIds:[admin.userId!]}},{id:randomUUID(),order:2,action:'sign',owner:false,who:{kind:'employee'}}]},expectedRevision:0,publish:true,retired:false});
 const workflow:AutomationWorkflow={id:randomUUID(),module:'contract_staff',name:'Fictional Contract posting workflow',description:'',status:'live',required:false,trigger:{event:'decisionSubmitted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[{field:'decision',op:'is',values:[kind==='renew'?'Renew':'Convert to permanent']}],steps:[
  {id:randomUUID(),type:'requestApproval',conditions:[],to:[],cc:[],params:{layers:[{id:randomUUID(),name:'CEO',pick:'any',approver:{kind:'person',userId:admin.userId!}}]}},
  {id:randomUUID(),type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:templateId}},
  {id:randomUUID(),type:'createPosting',conditions:[],to:[],cc:[],params:{eventType:kind==='renew'?'Renewal':'Conversion to permanent'}},
 ]};
 await saveAutomationWorkflow(admin,{workflow,expectedRevision:0,reason:'Reviewed fictional Contract posting journey'});
 const draft={kind,startOn:newStart,...(kind==='renew'?{endOn:newEnd,months:6}:{}),payChanges:options.payChanges??false,...(options.payChanges?{basicSalary:'5200.12'}:{}),reason:'Retain the agreed specialist role'};
 return {b,admin,proposer:proposer.ctx,approver:approver.ctx,employeeActor,employee,caseId,groupId,workflow,draft,today,start,end,newStart,newEnd,kind};
}
