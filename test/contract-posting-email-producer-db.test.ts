/** Full6000–08 integration proof: the FIRST posting producer can yield only its optional email wait. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {migrateTestDb,closeAll,owner} from './harness';
import {contractPostingFixture,releaseContractPosting,approveAppliedContractPosting,finishContractPostingJob} from './helpers/contract-posting-fixture';
import {saveAutomationDocumentTemplate,saveAutomationEmailTemplate,saveAutomationWorkflow} from '../packs/automation/service';
import {contractAutomationJobHandler,readContractSharedPosting,readContractSharedLetter,readContractSharedForm,saveContractSharedForm,actContractSharedLetter,contractSharedContext} from '../packs/contracts/service';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {readBulkJob} from '../core/bulk-job';

beforeAll(migrateTestDb);afterAll(closeAll);
describe('Posting followed by an independent email Form in the same frozen workflow',()=>{
 it('approves the released agreement while only that email waits, advances the case, then sends the same email once after real HR and employee completion',async()=>{
  const f=await contractPostingFixture({payChanges:false});
  const issuer='https://contract-email-producer-fixture.invalid/auth/'+f.b.tenantId,subject=randomUUID();
  await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${issuer},${subject},${f.employeeActor.userId!}::uuid)`);
  const [recipient]=await owner.db.execute<{userId:string;personId:string;tenantId:string;issuer:string;subject:string;unrevoked:boolean;reachable:boolean}>(sql`
   select u.id as "userId",u.person_id as "personId",u.tenant_id as "tenantId",identity.issuer,identity.subject,identity.revoked_at is null as unrevoked,
    (identity.revoked_at is null and identity.issuer like '%/auth/'||u.tenant_id::text and u.person_id is not null and u.archived_at is null and not app.login_blocked(u.id)) as reachable
   from app_user u join app_external_identity identity on identity.app_user_id=u.id
   where u.tenant_id=${f.b.tenantId}::uuid and u.id=${f.employeeActor.userId!}::uuid and identity.issuer=${issuer} and identity.subject=${subject}`);
  expect(recipient).toEqual({userId:f.employeeActor.userId,personId:f.employeeActor.personId,tenantId:f.b.tenantId,issuer,subject,unrevoked:true,reachable:true});
  const documentId=randomUUID(),emailId=randomUUID(),emailStep=randomUUID();
  await saveAutomationDocumentTemplate(f.admin,{template:{id:documentId,module:'contract_staff',name:'Fictional retained acknowledgement',description:'',rules:{},
   blocks:[{id:'intro',type:'text',text:'Acknowledge the retained agreement.',section:''},{id:'answers',type:'fields',text:'',section:'main'}],
   fields:[{id:'ack',label:'I acknowledge the agreement',type:'checkbox',owner:'employee',pmKey:null,required:true,sensitive:false,options:[],section:'main',when:null}],
   routing:[{id:'hr',order:1,action:'review',owner:true,who:{kind:'people',userIds:[f.admin.userId!]}},{id:'employee',order:2,action:'sign',owner:false,who:{kind:'employee'}}]},expectedRevision:0,publish:true,retired:false});
  await saveAutomationEmailTemplate(f.admin,{template:{id:emailId,module:'contract_staff',name:'Fictional retained acknowledgement email',active:true,subject:'Your retained agreement',body:'Open the acknowledgement.',cc:[],documentIds:[documentId]},retired:false,expectedRevision:0,reason:'Actual same-workflow prerequisite proof'});
  await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,steps:[...f.workflow.steps,{id:emailStep,type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:emailId}}]},expectedRevision:1,reason:'Send the independent acknowledgement after creating the posting'});
  const posting=await releaseContractPosting(f,{returnAtPosting:true});
  let emailLetterId:string|undefined;
  for(let attempt=0;attempt<100;attempt++){
   await runBulkJobTick(owner.client,{handlers:[contractAutomationJobHandler]});
   const[waiting]=await owner.db.execute<{id:string}>(sql`
    select letter.id from public.contract_shared_email_document_step pin
    join public.automation_run run on run.tenant_id=pin.tenant_id and run.id=pin.workflow_run_id
    join public.contract_shared_letter letter on letter.tenant_id=pin.tenant_id and letter.id=(pin.documents->>${documentId})::uuid
    where pin.tenant_id=${f.b.tenantId}::uuid and pin.case_id=${f.caseId}::uuid and pin.workflow_step_id=${emailStep}
     and run.status='waiting' and run.waiting_for=pin.id`);
   const current=await readContractSharedPosting(f.approver,posting.id);
   if(waiting&&current?.workflowReady){emailLetterId=waiting.id;break;}
   await new Promise(resolve=>setTimeout(resolve,50)); // Respect the genuine kernel wait; never advance its clock or lease.
  }
  expect(emailLetterId,'actual email pin wait and native producer certification must both exist').toBeTruthy();
  const original=await readBulkJob(f.employeeActor,posting.continuationJobId,'contract_automation');
  expect(original.state).toBe('finalizing');
  expect(await readContractSharedPosting(f.approver,posting.id)).toMatchObject({status:'pending',workflowReady:true,canApprove:true});
  const approved=await approveAppliedContractPosting(f.approver,{id:posting.id,revision:posting.revision});
  expect(approved.postingStatus).toBe('approved');
  const closed=(await contractSharedContext(f.proposer,f.caseId)).flow!;
  expect(closed.stage).toBe('renewed');
  const hr=await readContractSharedLetter(f.admin,emailLetterId!),hrForm=await readContractSharedForm(f.admin,emailLetterId!);
  if(!hrForm?.visible)throw Error('The actual routed HR Form is unavailable.');
  await actContractSharedLetter(f.admin,{id:hr.id,actionId:randomUUID(),stepId:hr.pendingAction!.stepId,revision:hr.contentRevision,hash:hr.contentHash!,responseRevision:hrForm.responseRevision,responseHash:hrForm.responseHash,action:'reviewed'});
  const employeeForm=await readContractSharedForm(f.employeeActor,emailLetterId!);
  const sign=await readContractSharedLetter(f.employeeActor,emailLetterId!);
  if(!employeeForm?.visible)throw Error('The actual routed employee Form is unavailable.');
  const saved=await saveContractSharedForm(f.employeeActor,{id:emailLetterId!,contentRevision:sign.contentRevision,contentHash:sign.contentHash!,responseRevision:employeeForm.responseRevision,responseHash:employeeForm.responseHash,values:{ack:'true'}});
  if(!saved?.visible)throw Error('The employee acknowledgement was not saved.');
  await actContractSharedLetter(f.employeeActor,{id:sign.id,actionId:randomUUID(),stepId:sign.pendingAction!.stepId,revision:sign.contentRevision,hash:sign.contentHash!,responseRevision:saved.responseRevision,responseHash:saved.responseHash,action:'signed',method:'typed',value:'Fictional Contract employee',consent:true});
  await finishContractPostingJob(posting.continuationJobId,f.employeeActor,'contract_automation');
  await runBulkJobTick(owner.client,{handlers:[contractAutomationJobHandler]});
  const[delivery]=await owner.db.execute<{count:number}>(sql`select count(*)::int as count from public.automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and payload->'mail'->>'templateId'=${emailId}`);
  expect(delivery.count).toBe(1);
  expect((await contractSharedContext(f.proposer,f.caseId)).flow!.stage).toBe('renewed');
 });
});
