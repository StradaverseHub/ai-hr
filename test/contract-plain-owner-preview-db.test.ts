/** Real production queue-owner transport; never wrap this plain pool with createDb/drizzle. */
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {openImportWorkerOwner} from '../db/worker-connection';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {readBulkJob} from '../core/bulk-job';
import {closeAll,migrateTestDb,owner,createAppUser} from './harness';
import {fixture as endingFixture} from './helpers/contract-document-fixture';
import {saveAutomationDocumentTemplate} from '../packs/automation/service';
import {contractPostingFixture} from './helpers/contract-posting-fixture';
import {previewContractSharedDecision,readContractSharedDecisionPreview,submitContractSharedDecision,contractPreviewJobHandler,contractAutomationJobHandler,readContractSharedApproval,actContractSharedApproval,readContractSharedLetter,actContractSharedLetter,contractSharedContext} from '../packs/contracts/service';
beforeAll(migrateTestDb);afterAll(closeAll);
it('previews the real native decision and creates its approval and letter through an unchanged plain owner JSON codec',async()=>{
 const f=await contractPostingFixture({future:false,payChanges:true});
 const queue=openImportWorkerOwner(process.env.TEST_MIGRATION_DATABASE_URL!);
 const codecs=()=>({parsers:Object.getOwnPropertyDescriptors(queue.options.parsers),serializers:Object.getOwnPropertyDescriptors(queue.options.serializers)});
 const errors=new Map<string,unknown>(),handlers=[contractPreviewJobHandler,contractAutomationJobHandler].map(handler=>({...handler,async describeFailure(...args:Parameters<NonNullable<typeof handler.describeFailure>>){errors.set(args[0].id,args[1]);const describe=handler.describeFailure;if(!describe)throw Error('Native Contract failure descriptor is required.');return describe(...args);}}));
 try{
  // Establish the native raw connection and array types before taking its codec witness.
  const[raw]=await queue<{kind:string;data:{blockers:string[];workflows:unknown[]}}[]>`select jsonb_typeof(${'{"blockers":[],"workflows":[]}'}::text::jsonb) as kind,${'{"blockers":[],"workflows":[]}'}::text::jsonb as data`;
  expect(raw).toEqual({kind:'object',data:{blockers:[],workflows:[]}});const before=codecs();
  async function finish(id:string,actor:SessionContext,kind:'contract_preview'|'contract_automation'){
   for(let n=0;n<100;n++){
    const job=await readBulkJob(actor,id,kind);if(job.state==='completed')return;
    if(job.state==='failed'||job.state==='cancelled')throw errors.get(id)??new Error(job.error??'Actual plain-owner Contract job failed.');
    const worked=await runBulkJobTick(queue,{handlers});if(!worked)await new Promise(resolve=>setTimeout(resolve,50));
   }
   throw Error('Actual plain-owner Contract job did not complete.');
  }
  const preview=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,draft:f.draft});await finish(preview.jobId,f.proposer,'contract_preview');
  const view=await readContractSharedDecisionPreview(f.proposer,preview.previewId);expect(view.plan?.blockers).toEqual([]);expect(view.plan?.workflows.map(w=>w.id)).toEqual([f.workflow.id]);
  const accepted=await submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,previewId:preview.previewId});await finish(accepted.jobId,f.proposer,'contract_automation');
  const[approvalRow]=await owner.db.execute<{id:string}>(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`);if(!approvalRow)throw Error('Actual native approval was not created.');
  const approval=await readContractSharedApproval(f.admin,approvalRow.id);if(!approval.pendingLayerId)throw Error('Actual assigned approval layer is unavailable.');
  await actContractSharedApproval(f.admin,{id:approval.id,actionId:randomUUID(),layerId:approval.pendingLayerId,revision:approval.contentRevision,hash:approval.contentHash,action:'approve',reason:'Actual native plain-owner transport proof.'});
  const[completion]=await owner.db.execute<{id:string}>(sql`select job_id as id from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and trigger_event='approvalsComplete'`);if(!completion)throw Error('Actual approval continuation was not queued.');
  await finish(completion.id,f.admin,'contract_automation');
  const[letterRow]=await owner.db.execute<{id:string}>(sql`select id from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and purpose='outcome'`);if(!letterRow)throw Error('Actual native Letter was not created.');
  const letter=await readContractSharedLetter(f.admin,letterRow.id);expect(letter.pendingAction?.kind).toBe('review');
  expect(await owner.db.execute(sql`select id,error from bulk_job where tenant_id=${f.b.tenantId}::uuid and state in('failed','cancelled')`)).toEqual([]);
  const[runtime]=await owner.db.execute<{remaining:string;log:string}>(sql`select jsonb_typeof(remaining_steps) as remaining,jsonb_typeof(log) as log from automation_run where tenant_id=${f.b.tenantId}::uuid and subject_id=${f.caseId}::uuid`);expect(runtime).toEqual({remaining:'array',log:'array'});
  expect(codecs()).toEqual(before);
 }finally{await queue.end({timeout:5});}
 // The real hosted source-service workflow takes seconds; allow migration and native runtime headroom.
},180_000);

it('releases an actual reviewed and company-signed End letter before plain-owner native Offboarding, keeping Personnel termination manual',async()=>{
 const f=await endingFixture('end');
 const[person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${f.b.tenantId}::uuid,'Fictional separate company signer',${randomUUID()+'@plain-owner.test'}) returning id`);if(!person)throw Error('Actual separate signer Personnel identity is required.');
 const userId=await createAppUser(f.b.tenantId,person.id,'employee'),signer:SessionContext={...f.admin,userId,personId:person.id,roles:['employee'],grants:undefined};
 const templateId=f.workflow.steps[0].params.letterTemplateId;if(typeof templateId!=='string')throw Error('The actual ending workflow must select its published letter.');
 await saveAutomationDocumentTemplate(f.admin,{template:{id:templateId,module:'contract_staff',name:'Fictional plain-owner ending letter',description:'Actual native review and company signature',rules:{},blocks:[{id:'terms',type:'text',text:'Dear {employee.name}, your contract ends on {contract.end}.',section:''}],fields:[],routing:[{id:'review',order:1,action:'review',owner:true,who:{kind:'people',userIds:[f.admin.userId!]}},{id:'company-sign',order:2,action:'sign',owner:false,who:{kind:'people',userIds:[userId]}}]},expectedRevision:1,publish:true,retired:false});
 const queue=openImportWorkerOwner(process.env.TEST_MIGRATION_DATABASE_URL!),errors=new Map<string,unknown>();
 const handlers=[contractPreviewJobHandler,contractAutomationJobHandler].map(handler=>({...handler,async describeFailure(...args:Parameters<NonNullable<typeof handler.describeFailure>>){errors.set(args[0].id,args[1]);const describe=handler.describeFailure;if(!describe)throw Error('Native Contract failure descriptor is required.');return describe(...args);}}));
 try{
  async function finish(id:string,actor:SessionContext,kind:'contract_preview'|'contract_automation'){
   for(let n=0;n<100;n++){
    const job=await readBulkJob(actor,id,kind);if(job.state==='completed')return;
    if(job.state==='failed'||job.state==='cancelled')throw errors.get(id)??new Error(job.error??'Actual plain-owner End job failed.');
    const worked=await runBulkJobTick(queue,{handlers});if(!worked)await new Promise(resolve=>setTimeout(resolve,50));
   }
   throw Error('Actual plain-owner End job did not complete.');
  }
  const preview=await previewContractSharedDecision(f.admin,{caseId:f.caseId,revision:1,draft:{kind:'end',payChanges:false,endReason:'contract_expiry',reason:'The actual agreed period ends.'}});await finish(preview.jobId,f.admin,'contract_preview');
  expect((await readContractSharedDecisionPreview(f.admin,preview.previewId)).plan?.blockers).toEqual([]);
  const accepted=await submitContractSharedDecision(f.admin,{caseId:f.caseId,revision:1,previewId:preview.previewId});await finish(accepted.jobId,f.admin,'contract_automation');
  const[created]=await owner.db.execute<{id:string}>(sql`select id from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and purpose='outcome'`);if(!created)throw Error('Actual End letter was not created.');
  const review=await readContractSharedLetter(f.admin,created.id);if(!review.pendingAction||!review.contentHash)throw Error('Actual HR review is unavailable.');expect(review.pendingAction.kind).toBe('review');
  await actContractSharedLetter(f.admin,{id:review.id,actionId:randomUUID(),stepId:review.pendingAction.stepId,revision:review.contentRevision,hash:review.contentHash,action:'reviewed'});
  expect(await owner.db.execute(sql`select id from lc_v9_case where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid and module='off'`)).toEqual([]);
  const signing=await readContractSharedLetter(signer,created.id);if(!signing.pendingAction||!signing.contentHash)throw Error('Actual company signature is unavailable.');expect(signing.pendingAction.kind).toBe('sign');
  const released=await actContractSharedLetter(signer,{id:signing.id,actionId:randomUUID(),stepId:signing.pendingAction.stepId,revision:signing.contentRevision,hash:signing.contentHash,action:'signed',method:'typed',value:'Fictional separate company signer',consent:true});expect(released.state).toBe('released');
  const[event]=await owner.db.execute<{job:string}>(sql`select job_id as job from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and trigger_event='letterReleased' and data->>'letterId'=${released.id}`);if(!event)throw Error('Actual released-letter continuation is required.');
  await finish(event.job,signer,'contract_automation');
  const view=await contractSharedContext(f.admin,f.caseId);expect(view.flow?.stage).toBe('offboarding');expect(view.flow?.offboardingId).toBeTruthy();
  const exits=await owner.db.execute<{id:string;kind:string;data:Record<string,unknown>}>(sql`select id,jsonb_typeof(data) as kind,data from lc_v9_case where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid and module='off'`);expect(exits).toHaveLength(1);expect(exits[0].kind).toBe('object');
  expect(exits[0].data).toMatchObject({state:'pending',contractSharedSourceCaseId:f.caseId,contractSharedSourceLetter:{letterId:released.id},contractSharedTerminationReason:'contract_expiry',contractSharedClearance:'pending-manual-personnel',facts:{lastDay:f.end,caseType:'Contract end'}});
  const[personnel]=await owner.db.execute<{terminated:string|null;lastDay:string|null;counter:number}>(sql`select terminated_on::text as terminated,last_working_date::text as "lastDay",contract_number as counter from employment where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`);expect(personnel).toEqual({terminated:null,lastDay:null,counter:3});
  expect(await owner.db.execute(sql`select id from personnel_posting where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid`)).toEqual([]);
  expect(await owner.db.execute(sql`select id,error from bulk_job where tenant_id=${f.b.tenantId}::uuid and state in('failed','cancelled')`)).toEqual([]);
  await finish(event.job,signer,'contract_automation');expect(await owner.db.execute(sql`select id from lc_v9_case where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid and module='off'`)).toHaveLength(1);
 }finally{await queue.end({timeout:5});}
},180_000);
