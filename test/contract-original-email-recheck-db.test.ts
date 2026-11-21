/** Genuine original sealed jobs observe live PM/account readiness without inventing a callback actor. */
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {migrateTestDb,closeAll,owner,createAppUser} from './harness';
import {fixture,finish} from './helpers/contract-document-fixture';
import {saveAutomationDocumentTemplate,saveAutomationEmailTemplate,saveAutomationWorkflow} from '../packs/automation/service';
import {previewContractSharedDecision,submitContractSharedDecision,contractAutomationJobHandler} from '../packs/contracts/service';
import {runBulkJobTick} from '../core/bulk-job-worker';
const origin='https://original-owner-recheck.invalid';
beforeAll(migrateTestDb);afterAll(closeAll);
async function prepare(keys:('bankAcc'|'icNo')[],concurrentChildren=false){
 const f=await fixture('renew'),employeeId=await createAppUser(f.b.tenantId,f.employee.personId,'employee');
 for(const userId of[f.admin.userId!,employeeId])await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+f.b.tenantId},${randomUUID()},${userId}::uuid)`);
 await owner.db.execute(sql`insert into employee_statutory_my(tenant_id,person_id,ic_number,bank_account_no) values(${f.b.tenantId}::uuid,${f.employee.personId}::uuid,null,null)`);
 const definitions:{key:string;emailId:string;workflowId:string}[]=[];
 for(const key of keys){
  const documentId=randomUUID(),emailId=randomUUID(),workflowId=randomUUID();
  await saveAutomationDocumentTemplate(f.admin,{template:{id:documentId,module:'contract_staff',name:'Actual required '+key,description:'Live selected native field',rules:{},blocks:[{id:'fields',type:'fields',text:'',section:'main'}],fields:[{id:'required',label:'Required '+key,type:'text',owner:'pmLocked',pmKey:key,required:true,sensitive:true,options:[],section:'main',when:null}],routing:[{id:'employee',order:1,action:'sign',owner:true,who:{kind:'employee'}}]},expectedRevision:0,publish:true,retired:false});
  await saveAutomationEmailTemplate(f.admin,{template:{id:emailId,module:'contract_staff',name:'Actual email '+key,active:true,subject:'Required '+key,body:'Open your actual assigned Form.',cc:[],documentIds:[documentId]},expectedRevision:0,retired:false,reason:'Actual PM-only prerequisite hold'});
  await saveAutomationWorkflow(f.admin,{workflow:{id:workflowId,module:'contract_staff',name:'Actual PM-only '+key,description:'',status:'live',required:false,trigger:{event:'decisionSubmitted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:'email',type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:emailId}}]},expectedRevision:0,reason:'Original sealed workflow owns its real email'});
  definitions.push({key,emailId,workflowId});
 }
 if(concurrentChildren){
  await saveAutomationWorkflow(f.admin,{workflow:{id:randomUUID(),module:'contract_staff',name:'Actual independent decision approval',description:'',status:'live',required:false,trigger:{event:'decisionSubmitted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:'approval',type:'requestApproval',conditions:[],to:[],cc:[],params:{layers:[{id:randomUUID(),name:'Actual same-job approver',pick:'any',approver:{kind:'person',userId:f.admin.userId!}}]}}]},expectedRevision:0,reason:'An independent approval must not wait for a PM-only email'});
  await saveAutomationWorkflow(f.admin,{workflow:{id:randomUUID(),module:'contract_staff',name:'Actual ordinary letter notice',description:'',status:'live',required:false,trigger:{event:'letterActionNeeded',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:'notice',type:'notify',conditions:[],to:[{kind:'pending'}],cc:[],params:{subject:'Actual ordinary letter owner is waiting',body:'Please review your assigned outcome letter.'}}]},expectedRevision:0,reason:'Actual native ordinary letter child follows its original owner'});
 }
 const preview=await previewContractSharedDecision(f.admin,{caseId:f.caseId,revision:1,draft:{kind:'renew',payChanges:false,months:6,reason:'Actual current-period recheck fixture'}});await finish(preview.jobId,f.admin,'contract_preview');
 const accepted=await submitContractSharedDecision(f.admin,{caseId:f.caseId,revision:1,previewId:preview.previewId});
 const tick=async()=>{await runBulkJobTick(owner.client,{handlers:[contractAutomationJobHandler]});const failures=await owner.db.execute(sql`select error from bulk_job where tenant_id=${f.b.tenantId}::uuid and state='failed'`);expect(failures).toEqual([]);};
 let pins:{id:string;email:string}[]=[];
 for(let n=0;n<40&&pins.length<keys.length;n++){await tick();pins=await owner.db.execute<{id:string;email:string}>(sql`select p.id,p.email_template_id as email from contract_shared_email_document_step p join automation_run r on r.tenant_id=p.tenant_id and r.id=p.workflow_run_id and r.status='waiting' and r.waiting_for=p.id where p.tenant_id=${f.b.tenantId}::uuid and p.case_id=${f.caseId}::uuid order by p.id`);}
 expect(pins).toHaveLength(keys.length);
 const deliveries=()=>owner.db.execute<{template:string}>(sql`select payload->'mail'->>'templateId' as template from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and payload->'mail'->>'templateId' is not null order by id`);
 expect(await deliveries()).toEqual([]);
 expect(await owner.db.execute(sql`select event_id from app.contract_email_prerequisite_resume where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
 return {...f,employeeId,definitions,pins,jobId:accepted.jobId,tick,deliveries};
}
async function retry(f:Awaited<ReturnType<typeof prepare>>){await new Promise(resolve=>setTimeout(resolve,2100));await f.tick();}
it('resumes a genuine original PM-only hold once after a real native field correction, without a Form read/action or invented callback',async()=>{
 const f=await prepare(['bankAcc']);
 await owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-CORRECTED-BANK' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);
 for(let n=0;n<4&&!(await f.deliveries()).length;n++)await retry(f);
 expect(await f.deliveries()).toEqual([{template:f.definitions[0].emailId}]);
 expect(await owner.db.execute(sql`select event_id from app.contract_email_prerequisite_resume where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
 const [original]=await owner.db.execute<{type:string;actor:string}>(sql`select actor_type as type,actor_user_id as actor from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and job_id=${f.jobId}::uuid and trigger_event='decisionSubmitted'`);expect(original).toEqual({type:'user',actor:f.admin.userId});
 for(let n=0;n<5;n++)await f.tick();expect(await f.deliveries()).toHaveLength(1);
 await expect(withTenant(f.admin,tx=>tx.execute(sql`select app.contract_shared_email_original_recheck(${randomUUID()}::uuid,null)`))).rejects.toThrow();
},120_000);
it('continues holding a real corrected Form while its pinned employee account is inactive and recovers after actual account restoration',async()=>{
 const f=await prepare(['bankAcc']);
 await owner.db.execute(sql`update app_user set archived_at=now() where tenant_id=${f.b.tenantId}::uuid and id=${f.employeeId}::uuid`);
 await owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-CORRECTED-BANK' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);
 await retry(f);expect(await f.deliveries()).toEqual([]);
 await owner.db.execute(sql`update app_user set archived_at=null where tenant_id=${f.b.tenantId}::uuid and id=${f.employeeId}::uuid`);
 for(let n=0;n<4&&!(await f.deliveries()).length;n++)await retry(f);
 expect(await f.deliveries()).toEqual([{template:f.definitions[0].emailId}]);
 expect(await owner.db.execute(sql`select event_id from app.contract_email_prerequisite_resume where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
},120_000);
it('rotates across two actual waiting pins so the first incomplete Form cannot starve a later ready one',async()=>{
 const f=await prepare(['bankAcc','icNo']),second=f.pins[1],definition=f.definitions.find(item=>item.emailId===second.email)!;
 if(definition.key==='bankAcc')await owner.db.execute(sql`update employee_statutory_my set bank_account_no='FICTIONAL-READY-SECOND' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);
 else await owner.db.execute(sql`update employee_statutory_my set ic_number='990101011234' where tenant_id=${f.b.tenantId}::uuid and person_id=${f.employee.personId}::uuid`);
 for(let n=0;n<5&&!(await f.deliveries()).length;n++)await retry(f);
 expect(await f.deliveries()).toEqual([{template:second.email}]);
 const [first]=await owner.db.execute<{status:string;pin:string}>(sql`select r.status,r.waiting_for as pin from contract_shared_email_document_step p join automation_run r on r.tenant_id=p.tenant_id and r.id=p.workflow_run_id where p.tenant_id=${f.b.tenantId}::uuid and p.id=${f.pins[0].id}::uuid`);expect(first).toEqual({status:'waiting',pin:f.pins[0].id});
 expect(await owner.db.execute(sql`select event_id from app.contract_email_prerequisite_resume where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
},120_000);
it('processes genuine same-job approval and ordinary letter notice children while an unrelated email prerequisite remains held',async()=>{
 const f=await prepare(['bankAcc'],true);
 for(let n=0;n<18;n++)await retry(f);
 const children=await owner.db.execute<{trigger:string;done:Date|null}>(sql`select trigger_event as trigger,processed_at as done from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and job_id=${f.jobId}::uuid and root_event_id is not null and trigger_event in('approvalActionNeeded','letterActionNeeded') order by trigger_event`);
 expect(children.map(child=>child.trigger)).toEqual(['approvalActionNeeded','letterActionNeeded']);expect(children.every(child=>child.done!==null)).toBe(true);
 const notices=await owner.db.execute<{subject:string}>(sql`select payload->'mail'->>'subject' as subject from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid order by payload->'mail'->>'subject'`);
 expect(notices.map(notice=>notice.subject)).toEqual(['Actual ordinary letter owner is waiting','Contract decision approval is waiting']);
 expect(await f.deliveries()).toEqual([]);
 const [waiting]=await owner.db.execute<{status:string}>(sql`select r.status from contract_shared_email_document_step p join automation_run r on r.tenant_id=p.tenant_id and r.id=p.workflow_run_id where p.tenant_id=${f.b.tenantId}::uuid and p.id=${f.pins[0].id}::uuid`);expect(waiting.status).toBe('waiting');
 expect(await owner.db.execute(sql`select id from personnel_posting where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
},120_000);
