/** Real canonical Form progress resumes one pinned email, then the original sealed workflow owner. */
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {closeAll,migrateTestDb,owner,createAppUser} from './harness';
import {fixture,finish,letters,saveAnswers,actForm} from './helpers/contract-document-fixture';
import {saveAutomationEmailTemplate,saveAutomationDocumentTemplate,saveAutomationWorkflow,uploadAutomationEmailAsset} from '../packs/automation/service';
import {previewContractSharedDecision,submitContractSharedDecision,contractAutomationJobHandler,readContractSharedLetter} from '../packs/contracts/service';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {v9Workspace,v9SaveConfig} from '../packs/lifecycle/service';
const origin='https://contract-recovery-fixture.invalid';
beforeAll(migrateTestDb);afterAll(closeAll);

async function actualRecovery(callbackChange?:'archive'|'relink',requiredFile?:'legacy'|'hint'){
 const f=await fixture('renew'),employeeId=await createAppUser(f.b.tenantId,f.employee.personId,'employee');
 let callbackActor=f.admin;
 if(callbackChange){
  const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${f.b.tenantId}::uuid,'Fictional independent HR reviewer',${randomUUID()+'@recovery.test'}) returning id`);
  const userId=await createAppUser(f.b.tenantId,person.id,'hr_admin');callbackActor={...f.admin,userId,personId:person.id};
  const config=(await v9Workspace(f.admin)).config!;await v9SaveConfig(f.admin,config.revision,{...config,groups:config.groups.map(group=>group.id===f.groupId?{...group,members:[...group.members,userId]}:group)});
 }
 for(const userId of[f.admin.userId!,employeeId])await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+f.b.tenantId},${randomUUID()},${userId}::uuid)`);
 const documentId=f.workflow.steps[0].params.letterTemplateId as string;
 await saveAutomationDocumentTemplate(f.admin,{template:{id:documentId,module:'contract_staff',name:'Fictional recovery Form',description:'Actual native HR evidence',rules:{},blocks:[{id:'intro',type:'text',text:'For {Full name}.',section:''},{id:'fields',type:'fields',text:'',section:'main'}],fields:[{id:'hrChoice',label:'HR decision',type:'select',owner:'hr',pmKey:null,required:true,sensitive:false,options:['Yes','No'],section:'main',when:null}],routing:[{id:'hr-review',order:1,action:'review',owner:true,who:{kind:'group',groupId:f.groupId}},{id:'hr-sign',order:2,action:'sign',owner:false,who:{kind:'group',groupId:f.groupId}},{id:'employee-sign',order:3,action:'sign',owner:false,who:{kind:'employee'}}]},expectedRevision:1,publish:true,retired:false});
 const emailId=randomUUID(),slotId=randomUUID(),email={id:emailId,module:'contract_staff' as const,name:'Pinned recovery email',active:true,subject:'Original recovery for {{employee.name}}',body:'Original frozen wording',cc:[{kind:'person' as const,userId:f.admin.userId!}],documentIds:[documentId],...(requiredFile?{slots:[{id:slotId,label:'Actual required evidence',required:true}]}:{})};
 await saveAutomationEmailTemplate(f.admin,{template:email,expectedRevision:0,retired:false,reason:'Actual first preparation'});
 const emailStep=randomUUID(),tailStep=randomUUID();
 await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,steps:[{id:emailStep,type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:emailId}},{id:tailStep,type:'requestApproval',conditions:[],to:[],cc:[],params:{layers:[{id:randomUUID(),name:'Original authority approval',pick:'any',approver:{kind:'person',userId:f.admin.userId!}}]}}]},expectedRevision:1,reason:'Same email then actual protected approval'});
 const preview=await previewContractSharedDecision(f.admin,{caseId:f.caseId,revision:1,draft:{kind:'renew',payChanges:false,months:6,reason:'Continue actual fictional role'}});
 await finish(preview.jobId,f.admin,'contract_preview');const accepted=await submitContractSharedDecision(f.admin,{caseId:f.caseId,revision:1,previewId:preview.previewId});
 let checkedHeldGuards=false;
 const diagnostic:typeof contractAutomationJobHandler={...contractAutomationJobHandler,async finalize(ctx,job,unit){
  return contractAutomationJobHandler.finalize!(ctx,job,{...unit,ownerTx:async callback=>unit.ownerTx!(async native=>{
   await native`select set_config('app.tenant_id',${f.b.tenantId},true),set_config('app.user_id','',true)`;
   const [child]=await native<{id:string;revision:number;run:string;step:string}[]>`select id,decision_revision as revision,data->>'runId' as run,data->>'stepId' as step from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and job_id=${job.id}::uuid and trigger_event='emailDocumentReady' and processed_at is null order by created_at,id limit 1`;
   if(child&&!checkedHeldGuards){
    await native`select set_config('app.contract_event',${child.id},true)`;
    const [start]=await native<{value:{ready:boolean}}[]>`select app.contract_shared_email_prerequisite_begin(${child.id}::uuid) as value`;expect(start.value.ready).toBe(!callbackChange);
    for(const type of['sendEmail','notify','generateDocument','requestApproval','createPosting','startOffboarding']){
     const [held]=await native<{current:boolean;cached:boolean}[]>`select app.contract_shared_effect_held(${f.caseId}::uuid,${child.run}::uuid,${child.step},${type}) as current,app.contract_shared_effect_held_before_email_recovery(${f.caseId}::uuid,${child.run}::uuid,${child.step},${type}) as cached`;
     expect(held).toEqual({current:!callbackChange&&type==='sendEmail',cached:!callbackChange&&type==='sendEmail'});
    }
    const [worker]=await native<{current:boolean;cached:boolean}[]>`select app.contract_shared_worker_event_held(${f.caseId}::uuid,${child.revision}) as current,app.contract_shared_worker_event_held_before_email_recovery(${f.caseId}::uuid,${child.revision}) as cached`;expect(worker).toEqual({current:!callbackChange,cached:!callbackChange});checkedHeldGuards=true;
   }
   return callback(native);
  })});
 }};
 const tick=async()=>{await runBulkJobTick(owner.client,{handlers:[diagnostic]});const failed=await owner.db.execute<{error:string}>(sql`select error from bulk_job where tenant_id=${f.b.tenantId}::uuid and state='failed'`);expect(failed).toEqual([]);};
 let pin:{id:string;runId:string;revision:number}|undefined;
 for(let n=0;n<30&&!pin;n++){await tick();[pin]=await owner.db.execute<{id:string;runId:string;revision:number}>(sql`select p.id,p.workflow_run_id as "runId",p.email_revision as revision from contract_shared_email_document_step p join automation_run r on r.tenant_id=p.tenant_id and r.id=p.workflow_run_id and r.status='waiting' and r.waiting_for=p.id where p.tenant_id=${f.b.tenantId}::uuid and p.case_id=${f.caseId}::uuid`);}
 expect(pin).toBeTruthy();expect(pin!.revision).toBe(1);const [letter]=await letters(f);expect(letter.purpose).toBe('email');
 const [job]=await owner.db.execute<{state:string}>(sql`select state from bulk_job where id=${accepted.jobId}::uuid`);expect(job.state).toBe('finalizing');
 expect(await owner.db.execute(sql`select id from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
 await saveAnswers(callbackActor,letter.id,{hrChoice:'Yes'});await actForm(callbackActor,letter.id,'reviewed');
 expect(await owner.db.execute(sql`select event_id from app.contract_email_prerequisite_resume where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
 if(requiredFile!=='legacy')await saveAutomationEmailTemplate(f.admin,{template:{...email,active:false,subject:'Later wording',body:'Later body',cc:[],documentIds:[]},expectedRevision:1,retired:false,reason:'The waiting email keeps its actual immutable version'});
 await actForm(callbackActor,letter.id,'signed');expect((await readContractSharedLetter({...f.admin,userId:employeeId,personId:f.employee.personId,roles:['employee'],grants:undefined},letter.id)).pendingAction?.kind).toBe('sign');
 if(requiredFile){
  expect(await owner.db.execute(sql`select event_id from app.contract_email_prerequisite_resume where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
  await uploadAutomationEmailAsset(f.admin,{templateId:emailId,module:'contract_staff',revision:1,kind:'file',name:'required-evidence.txt',content:Buffer.from('Actual fictional required file'),caseId:f.caseId,slotId,...(requiredFile==='hint'?{prerequisiteId:pin!.id}:{})});
 }
 const receipts=()=>owner.db.execute<{eventId:string;actor:string;jobId:string}>(sql`select r.event_id as "eventId",e.actor_user_id as actor,e.job_id as "jobId" from app.contract_email_prerequisite_resume r join contract_shared_event e on e.tenant_id=r.tenant_id and e.id=r.event_id where r.tenant_id=${f.b.tenantId}::uuid`);
 if(requiredFile==='legacy')expect(await receipts()).toHaveLength(0);
 else{const actual=await receipts();expect(actual).toHaveLength(1);expect(actual[0]).toMatchObject({actor:callbackActor.userId,jobId:accepted.jobId});}
 await expect(withTenant(f.admin,tx=>tx.execute(sql`select app.contract_shared_email_prerequisite_signal(${pin!.id}::uuid)`))).rejects.toThrow();
 if(callbackChange==='archive')await owner.db.execute(sql`update app_user set archived_at=now() where tenant_id=${f.b.tenantId}::uuid and id=${callbackActor.userId}::uuid`);
 if(callbackChange==='relink'){
  const [replacement]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${f.b.tenantId}::uuid,'Fictional replacement identity',${randomUUID()+'@recovery.test'}) returning id`);
  await owner.db.execute(sql`update app_user set person_id=${replacement.id}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${callbackActor.userId}::uuid`);
 }
 // The durable wait uses the kernel's genuine not-before delay; no local admission/proof bypass.
 await new Promise(resolve=>setTimeout(resolve,2100));await tick();if(requiredFile==='legacy')await tick();
 const deliveries=await owner.db.execute<{id:string;payload:{mail:{subject:string;body:string;cc:string[]}}}>(sql`select id,payload from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid`);
 if(callbackChange){
  expect(checkedHeldGuards).toBe(true);expect(deliveries).toHaveLength(0);
  expect(await owner.db.execute(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
  const [waiting]=await owner.db.execute<{status:string;waiting:string}>(sql`select status,waiting_for as waiting from automation_run where tenant_id=${f.b.tenantId}::uuid and id=${pin!.runId}::uuid`);expect(waiting).toEqual({status:'waiting',waiting:pin!.id});
  expect(await owner.db.execute(sql`select event_id from app.contract_email_prerequisite_resume where tenant_id=${f.b.tenantId}::uuid and completed_at is not null`)).toHaveLength(0);return;
 }
 expect(deliveries).toHaveLength(1);expect(deliveries[0].payload.mail).toMatchObject({subject:'Original recovery for Fictional ending subject',body:'Original frozen wording',cc:[f.admin.userId]});
 expect(checkedHeldGuards).toBe(true);
 const completed=await receipts();expect(completed).toHaveLength(1);expect(completed[0]).toMatchObject({actor:callbackActor.userId,jobId:accepted.jobId});
 const token=randomUUID();await owner.db.execute(sql`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '3 minutes' where id=${deliveries[0].id}::uuid`);
 const target=async()=>(await owner.db.execute<{value:unknown}>(sql`select app.automation_email_target(${deliveries[0].id}::uuid,${token}::uuid,${origin}) as value`))[0].value;
 expect(await target()).not.toBeNull();
 const [foreignPerson]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${f.b.tenantId}::uuid,'Fictional unrelated recipient identity',${randomUUID()+'@recovery.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${foreignPerson.id}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${employeeId}::uuid`);expect(await target()).toBeNull();
 await owner.db.execute(sql`update app_user set person_id=${f.employee.personId}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${employeeId}::uuid`);expect(await target()).not.toBeNull();
 expect(await owner.db.execute(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
 const [run]=await owner.db.execute<{status:string;cursor:number;tail:string}>(sql`select status,step_cursor as cursor,remaining_steps->0->'step'->>'id' as tail from automation_run where tenant_id=${f.b.tenantId}::uuid and id=${pin!.runId}::uuid`);expect(run).toEqual({status:'running',cursor:1,tail:tailStep});
 for(let n=0;n<10;n++)await tick();
 expect(await owner.db.execute(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(1);
 expect(await letters(f)).toHaveLength(1);expect(await owner.db.execute(sql`select event_id from app.contract_email_prerequisite_resume where tenant_id=${f.b.tenantId}::uuid and completed_at is not null and continued_at is not null`)).toHaveLength(1);
 expect(await owner.db.execute(sql`select id from personnel_posting where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
}
// The hosted genuine kernel/Signing/Form path takes several seconds; allow migration/load headroom.
it('uses actual first-prepared Form, HR completion and immutable template to retry only its email before original approval tail',()=>actualRecovery(),120_000);
it('refuses an archived actual HR callback while the original workflow owner remains active',()=>actualRecovery('archive'),120_000);
it('refuses a relinked actual HR callback while retaining the same pending email and untouched tail',()=>actualRecovery('relink'),120_000);
it('recovers a real required-file hold from an actual legacy upload observation without requiring a reupload',()=>actualRecovery(undefined,'legacy'),120_000);
it('uses actual hinted old-version upload proof after the waiting template is edited and turned off',()=>actualRecovery(undefined,'hint'),120_000);
