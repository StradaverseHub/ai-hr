/** Real canonical Form progress resumes one pinned email, then the original sealed workflow owner. */
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {closeAll,migrateTestDb,owner,createAppUser} from './harness';
import {fixture,finish,letters,saveAnswers,actForm} from './helpers/contract-document-fixture';
import {saveAutomationEmailTemplate,saveAutomationDocumentTemplate,saveAutomationWorkflow} from '../packs/automation/service';
import {previewContractSharedDecision,submitContractSharedDecision,contractAutomationJobHandler,readContractSharedLetter} from '../packs/contracts/service';
import {runBulkJobTick} from '../core/bulk-job-worker';
const origin='https://contract-recovery-fixture.invalid';
beforeAll(migrateTestDb);afterAll(closeAll);

it('uses actual first-prepared Form, HR completion and immutable template to retry only its email before original approval tail',async()=>{
 const f=await fixture('renew'),employeeId=await createAppUser(f.b.tenantId,f.employee.personId,'employee');
 for(const userId of[f.admin.userId!,employeeId])await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+f.b.tenantId},${randomUUID()},${userId}::uuid)`);
 const documentId=f.workflow.steps[0].params.letterTemplateId as string;
 await saveAutomationDocumentTemplate(f.admin,{template:{id:documentId,module:'contract_staff',name:'Fictional recovery Form',description:'Actual native HR evidence',rules:{},blocks:[{id:'intro',type:'text',text:'For {Full name}.',section:''},{id:'fields',type:'fields',text:'',section:'main'}],fields:[{id:'hrChoice',label:'HR decision',type:'select',owner:'hr',pmKey:null,required:true,sensitive:false,options:['Yes','No'],section:'main',when:null}],routing:[{id:'hr-review',order:1,action:'review',owner:true,who:{kind:'group',groupId:f.groupId}},{id:'hr-sign',order:2,action:'sign',owner:false,who:{kind:'group',groupId:f.groupId}},{id:'employee-sign',order:3,action:'sign',owner:false,who:{kind:'employee'}}]},expectedRevision:1,publish:true,retired:false});
 const emailId=randomUUID(),email={id:emailId,module:'contract_staff' as const,name:'Pinned recovery email',active:true,subject:'Original recovery for {{employee.name}}',body:'Original frozen wording',cc:[{kind:'person' as const,userId:f.admin.userId!}],documentIds:[documentId]};
 await saveAutomationEmailTemplate(f.admin,{template:email,expectedRevision:0,retired:false,reason:'Actual first preparation'});
 const emailStep=randomUUID(),tailStep=randomUUID();
 await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,steps:[{id:emailStep,type:'sendEmail',conditions:[],to:[{kind:'employee'}],cc:[],params:{emailTemplateId:emailId}},{id:tailStep,type:'requestApproval',conditions:[],to:[],cc:[],params:{layers:[{id:randomUUID(),name:'Original authority approval',pick:'any',approver:{kind:'person',userId:f.admin.userId!}}]}}]},expectedRevision:1,reason:'Same email then actual protected approval'});
 const preview=await previewContractSharedDecision(f.admin,{caseId:f.caseId,revision:1,draft:{kind:'renew',payChanges:false,months:6,reason:'Continue actual fictional role'}});
 await finish(preview.jobId,f.admin,'contract_preview');const accepted=await submitContractSharedDecision(f.admin,{caseId:f.caseId,revision:1,previewId:preview.previewId});
 const tick=async()=>{await runBulkJobTick(owner.client,{handlers:[contractAutomationJobHandler]});const failed=await owner.db.execute<{error:string}>(sql`select error from bulk_job where tenant_id=${f.b.tenantId}::uuid and state='failed'`);expect(failed).toEqual([]);};
 let pin:{id:string;runId:string;revision:number}|undefined;
 for(let n=0;n<30&&!pin;n++){await tick();[pin]=await owner.db.execute<{id:string;runId:string;revision:number}>(sql`select p.id,p.workflow_run_id as "runId",p.email_revision as revision from contract_shared_email_document_step p join automation_run r on r.tenant_id=p.tenant_id and r.id=p.workflow_run_id and r.status='waiting' and r.waiting_for=p.id where p.tenant_id=${f.b.tenantId}::uuid and p.case_id=${f.caseId}::uuid`);}
 expect(pin).toBeTruthy();expect(pin!.revision).toBe(1);const [letter]=await letters(f);expect(letter.purpose).toBe('email');
 const [job]=await owner.db.execute<{state:string}>(sql`select state from bulk_job where id=${accepted.jobId}::uuid`);expect(job.state).toBe('finalizing');
 expect(await owner.db.execute(sql`select id from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
 await saveAnswers(f.admin,letter.id,{hrChoice:'Yes'});await actForm(f.admin,letter.id,'reviewed');
 expect(await owner.db.execute(sql`select event_id from app.contract_email_prerequisite_resume where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
 await saveAutomationEmailTemplate(f.admin,{template:{...email,active:false,subject:'Later wording',body:'Later body',cc:[],documentIds:[]},expectedRevision:1,retired:false,reason:'The waiting email keeps its actual immutable version'});
 await actForm(f.admin,letter.id,'signed');expect((await readContractSharedLetter({...f.admin,userId:employeeId,personId:f.employee.personId,roles:['employee'],grants:undefined},letter.id)).pendingAction?.kind).toBe('sign');
 const receipts=await owner.db.execute<{eventId:string;actor:string;jobId:string}>(sql`select r.event_id as "eventId",e.actor_user_id as actor,e.job_id as "jobId" from app.contract_email_prerequisite_resume r join contract_shared_event e on e.tenant_id=r.tenant_id and e.id=r.event_id where r.tenant_id=${f.b.tenantId}::uuid`);
 expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({actor:f.admin.userId,jobId:accepted.jobId});
 await expect(withTenant(f.admin,tx=>tx.execute(sql`select app.contract_shared_email_prerequisite_signal(${pin!.id}::uuid)`))).rejects.toThrow();
 // The durable wait uses the kernel's genuine not-before delay; no local admission/proof bypass.
 await new Promise(resolve=>setTimeout(resolve,2100));await tick();
 const deliveries=await owner.db.execute<{id:string;payload:{mail:{subject:string;body:string;cc:string[]}}}>(sql`select id,payload from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid`);
 expect(deliveries).toHaveLength(1);expect(deliveries[0].payload.mail).toMatchObject({subject:'Original recovery for Fictional ending subject',body:'Original frozen wording',cc:[f.admin.userId]});
 expect(await owner.db.execute(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
 const [run]=await owner.db.execute<{status:string;cursor:number;tail:string}>(sql`select status,step_cursor as cursor,remaining_steps->0->'step'->>'id' as tail from automation_run where tenant_id=${f.b.tenantId}::uuid and id=${pin!.runId}::uuid`);expect(run).toEqual({status:'running',cursor:1,tail:tailStep});
 for(let n=0;n<10;n++)await tick();
 expect(await owner.db.execute(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(1);
 expect(await letters(f)).toHaveLength(1);expect(await owner.db.execute(sql`select event_id from app.contract_email_prerequisite_resume where tenant_id=${f.b.tenantId}::uuid and completed_at is not null and continued_at is not null`)).toHaveLength(1);
 expect(await owner.db.execute(sql`select id from personnel_posting where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
},120_000);
