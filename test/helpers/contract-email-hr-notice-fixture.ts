/** Fictional identities; real native SendEmail, immutable pin, canonical Form, kernel and fixed notice. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {expect} from 'vitest';
import type {SessionContext} from '../../db/client';
import {owner} from '../harness';
import {contractPostingFixture} from './contract-posting-fixture';
import {saveAnswers} from './contract-document-fixture';
import {saveAutomationDocumentTemplate,saveAutomationEmailTemplate,saveAutomationWorkflow} from '../../packs/automation/service';
import {startContractSharedManualWorkflow,contractSharedContext,contractSharedSettings,saveContractSharedSettings,contractAutomationJobHandler,contractScheduleJobHandler,contractScheduledAutomationJobHandler,readContractSharedLetter,readContractSharedForm,actContractSharedLetter} from '../../packs/contracts/service';
import {runBulkJobTick} from '../../core/bulk-job-worker';
import {todayInKualaLumpur} from '../../lib/hr-date';
export async function contractEmailHRNoticeFixture(origin:string,options:{system?:boolean;parallel?:boolean;unboundEmployee?:boolean}={}){
 const f=await contractPostingFixture({future:false,payChanges:false});
 for(const user of[f.admin.userId!,f.approver.userId!,f.employeeActor.userId!])await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+f.b.tenantId},${f.b.tenantId+'/'+user},${user}::uuid)`);
 if(options.unboundEmployee)await owner.db.execute(sql`update app_user set person_id=null where tenant_id=${f.b.tenantId}::uuid and id=${f.employeeActor.userId}::uuid`);
 const documentId=randomUUID(),emailId=randomUUID(),workflowId=randomUUID();
 await saveAutomationDocumentTemplate(f.admin,{template:{id:documentId,module:'contract_staff',name:'Fictional fixed HR notice Form',description:'',rules:{},blocks:[{id:'intro',type:'text',text:'Original fictional acknowledgement.',section:''},{id:'answers',type:'fields',text:'',section:'main'}],fields:[{id:'hrAnswer',label:'Private HR answer',type:'text',owner:'hr',pmKey:null,required:true,sensitive:false,options:[],section:'main',when:null}],routing:[{id:'hr',order:1,action:'review',owner:true,who:{kind:'people',userIds:[f.admin.userId!]}},{id:'bp',order:2,action:'sign',owner:false,who:{kind:'people',userIds:[f.approver.userId!]}},{id:'employee',order:options.parallel?1:3,action:'sign',owner:false,who:{kind:'employee'}}]},expectedRevision:0,publish:true,retired:false});
 await saveAutomationEmailTemplate(f.admin,{template:{id:emailId,module:'contract_staff',name:'Fictional explicit employee invitation',active:true,subject:'Employee invitation from authored SendEmail',body:'Your document is ready. {{case.link}}',cc:[],documentIds:[documentId]},expectedRevision:0,retired:false,reason:'Native fixed notice boundary proof'});
 await saveAutomationWorkflow(f.admin,{workflow:{id:workflowId,module:'contract_staff',name:'Fictional fixed notice source',description:'',status:'live',required:false,trigger:{event:options.system?'afterContractEnd':'manual',days:options.system?1:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:'email',type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:emailId}}]},expectedRevision:0,reason:'Actual held source; no authored notice trigger'});
 if(options.system){
  const settings=await contractSharedSettings(f.admin,f.b.companyId);await saveContractSharedSettings(f.admin,{companyId:f.b.companyId,expectedRevision:settings.revision,settings:{...settings.settings,fallbackGroupId:f.groupId,postingApproverGroupId:f.groupId}});
  const day=todayInKualaLumpur();await owner.client.begin(async native=>{await native`select set_config('app.tenant_id',${f.b.tenantId},true),set_config('app.user_id','',true)`;await native`select app.contract_shared_system_enqueue('contract_schedule',${randomUUID()}::uuid,jsonb_build_object('day',${day}::text),'morning',${day}::date)`;});
 }else await startContractSharedManualWorkflow(f.admin,{caseId:f.caseId,revision:(await contractSharedContext(f.admin,f.caseId)).flow!.revision,workflowId,workflowRevision:1,requestId:randomUUID()});
 const tick=async()=>{const worked=await runBulkJobTick(owner.client,{handlers:[contractAutomationJobHandler,contractScheduleJobHandler,contractScheduledAutomationJobHandler]});
  expect(await owner.db.execute(sql`select id,error from bulk_job where tenant_id=${f.b.tenantId}::uuid and state='failed'`)).toEqual([]);
  if(!worked)await new Promise(resolve=>setTimeout(resolve,50));return worked;};
 let pin:{id:string;letterId:string;runId:string}|undefined;
 for(let count=0;count<100&&!pin;count++){await tick();[pin]=await owner.db.execute<{id:string;letterId:string;runId:string}>(sql`select pin.id,pin.documents->>${documentId} as "letterId",pin.workflow_run_id as "runId" from contract_shared_email_document_step pin join automation_run run on run.tenant_id=pin.tenant_id and run.id=pin.workflow_run_id and run.status='waiting' and run.waiting_for=pin.id where pin.tenant_id=${f.b.tenantId}::uuid and pin.email_template_id=${emailId}::uuid`);}
 if(!pin)throw Error('Actual native email did not reach its Form prerequisite.');const actualPin=pin;
 const[admitted]=await owner.db.execute<{count:number}>(sql`select count(*)::integer count from app.contract_email_hr_notice where tenant_id=${f.b.tenantId}::uuid and pin_id=${actualPin.id}::uuid and letter_id=${actualPin.letterId}::uuid`);expect(admitted.count,'Actual held SendEmail must admit its initial HR notice before polling delivery').toBe(1);
 const notices=()=>owner.db.execute<{id:string;payload:{context:Record<string,unknown>;mail:{to:string[];cc:string[];subject:string;body:string;delivery:Record<string,unknown>}}}>(sql`select id,payload from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and subject_id=${f.caseId}::uuid and payload->'context'?'hrNoticeEventId' order by created_at,id`);
 const drainNotice=async(userId:string)=>{for(let count=0;count<100;count++){const items=await notices();if(items.some(item=>item.payload.mail.to.includes(userId)))return items;await tick();}throw Error('Actual fixed HR notice did not queue.');};
 const act=async(actor:SessionContext,action:'reviewed'|'signed'|'returned'|'resent')=>{
  const letter=await readContractSharedLetter(actor,actualPin.letterId),form=await readContractSharedForm(actor,actualPin.letterId);if(!form?.visible)throw Error('Actual routed Form is unavailable.');
  const stepId=letter.pendingAction?.stepId??letter.layers.find(step=>step.owner)?.id;if(!stepId)throw Error('Actual pending or returned owner step is unavailable.');
  return actContractSharedLetter(actor,{id:letter.id,actionId:randomUUID(),stepId,revision:letter.contentRevision,hash:letter.contentHash!,responseRevision:form.responseRevision,responseHash:form.responseHash,action,comment:action==='returned'?'Please correct the fictional wording.':'',...(action==='signed'?{method:'typed' as const,value:'Fictional native signer',consent:true}:{})});
 };
 const answer=()=>saveAnswers(f.admin,actualPin.letterId,{hrAnswer:'FICTIONAL-PRIVATE-ANSWER-MUST-NOT-MAIL'});
 const employeeMail=()=>owner.db.execute(sql`select id from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and payload->'mail'->>'templateId'=${emailId}`);
 const snapshot=()=>owner.db.execute(sql`select id,trigger_event,workflow_versions,data,actor_type,actor_user_id,actor_person_id from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and trigger_event='emailDocumentHRNotice' order by created_at,id`);
 expect((await owner.db.execute<{count:number}>(sql`select count(*)::integer count from automation_run where tenant_id=${f.b.tenantId}::uuid and subject_id=${f.caseId}::uuid`))[0].count).toBe(1);
 return {...f,documentId,emailId,workflowId,pin:actualPin,tick,notices,drainNotice,act,answer,employeeMail,snapshot};
}
