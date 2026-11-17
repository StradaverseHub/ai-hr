/** Genuine current-period system origin, actual human Form completion, same leased job and restricted OneHR sender. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,it,expect,vi} from 'vitest';
import {sql} from 'drizzle-orm';
const auth=vi.hoisted(()=>({origin:'https://historical-mail.example.test',send:vi.fn()}));
// Only external Auth/relay credentials and SMTP are fictional. All capability/queue/Form/kernel SQL is real.
vi.mock('../lib/internal-auth/config',async original=>({...await original<typeof import('../lib/internal-auth/config')>(),internalSelected:()=>true,internalConfig:()=>({origin:auth.origin,key:'ab'.repeat(32)}),internalIssuer:(tenant:string)=>auth.origin+'/auth/'+tenant}));
vi.mock('../lib/internal-auth/active-relay',()=>({readLifecycleRelayTx:async()=>({revision:'fixture',senderName:'OneHR',relay:{config:{from:'noreply@historical-mail.example.test',fromName:'OneHR'}}})}));
vi.mock('../lib/internal-auth/store',async original=>({...await original<typeof import('../lib/internal-auth/store')>(),admittedAuthSql:{},readRecord:async(_:unknown,key:string)=>{const[tenant,user]=key.slice('credential:'.length).split('/');return {subject:tenant+'/'+user,tenantId:tenant,issuer:auth.origin+'/auth/'+tenant,email:user+'@historical-mail.example.test'};}}));
vi.mock('../lib/internal-auth/service',async original=>({...await original<typeof import('../lib/internal-auth/service')>(),InternalAuthError:class extends Error{},assertActiveCredential:async(_:unknown,credential:{subject:string})=>({app_user_id:credential.subject.split('/')[1]})}));
vi.mock('../lib/internal-auth/smtp',()=>({sendSmtp:auth.send}));
import {client,withTenant} from '../db/client';
import {closeAll,migrateTestDb,owner} from './harness';
import {historicalManualEmailFixture,unrelatedReconciliationCases} from './helpers/contract-historical-email-fixture';
import {saveAutomationDocumentTemplate,saveAutomationEmailTemplate,saveAutomationWorkflow} from '../packs/automation/service';
import {internalAutomationMail} from '../lib/internal-auth/automation-mail';
import {setEmploymentInfo} from '../core/org';
import {actForm} from './helpers/contract-document-fixture';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {contractAutomationJobHandler} from '../packs/contracts/service';
import {readContractSharedExecutionInputs} from '../core/contract-shared-preview-job';
import {contractSharedAutomationContext} from '../core/contract-shared-context';
import {contractSharedEmailExecutors} from '../core/contract-shared-email';
import {prepareContractSharedEmailStep} from '../core/contract-shared-email-documents';
import {beginContractEmailRecovery,retryContractEmailRecovery} from '../core/contract-shared-email-recovery';
import {reservedSqlExecutor} from '../db/sql-executor';
import {contractAutomationRead} from '../lib/contract-automation-context';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {historicalStartedCohortFixture} from './helpers/contract-historical-cohort-fixture';
import {historicalTwoPeriodPostingFixture} from './helpers/contract-historical-two-period-fixture';
import {releaseContractPosting,approveAppliedContractPosting,contractPostingFixture} from './helpers/contract-posting-fixture';
import {contractSharedTracker,openContractSharedPeriod,readContractSharedLetter,contractSharedWorkspace,contractSharedEmailReconciliations,contractSharedContext,readContractSharedPosting,approveContractSharedPosting} from '../packs/contracts/service';
beforeAll(migrateTestDb);afterAll(closeAll);
async function assertStoppedSuffix(f:Awaited<ReturnType<typeof historicalManualEmailFixture>>){
 const[run]=await owner.db.execute<{status:string;remaining:{step:{id:string};index:number}[];failure:string}>(sql`select status,remaining_steps as remaining,failure from automation_run where tenant_id=${f.b.tenantId}::uuid and id=${f.pin.runId}::uuid`);
 expect(run.status).toBe('failed');expect(run.failure).toBe('Original workflow authority changed; remaining steps stopped.');expect(run.remaining.map(item=>({id:item.step.id,index:item.index}))).toEqual([{id:f.tailStep,index:1}]);
 const visible=(await contractSharedWorkspace(f.admin,f.caseId)).runs.find(item=>item.id===f.pin.runId);expect(visible?.status).toBe('failed');expect(visible?.steps.some(item=>item.id===f.tailStep&&item.type==='requestApproval')).toBe(true);
 expect(await owner.db.execute(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid and workflow_run_id=${f.pin.runId}::uuid`)).toEqual([]);
 const[receipt]=await owner.db.execute<{revision:number;disposition:string;complete:boolean;continued:boolean}>(sql`select p.decision_revision as revision,r.disposition,r.completed_at is not null as complete,r.continued_at is not null as continued from app.contract_email_prerequisite_resume r join contract_shared_email_document_step p on p.tenant_id=r.tenant_id and p.id=r.pin_id where r.tenant_id=${f.b.tenantId}::uuid and r.pin_id=${f.pin.id}::uuid order by r.completed_at limit 1`);
 expect(receipt).toEqual({revision:0,disposition:'authority_changed',complete:true,continued:true});
}
it('recovers an actual Manual0 email after decision1 before posting, with truthful authority wording and no business suffix',async()=>{
 const f=await historicalManualEmailFixture(auth.origin);await f.firstDecision();
 const[before]=await owner.db.execute<{current:boolean}>(sql`select app.contract_shared_delivery_period_current(${f.b.tenantId}::uuid,${f.caseId}::uuid) as current`);expect(before.current).toBe(true);
 await f.completeHR();await f.settle();expect(await f.deliveries()).toHaveLength(1);await assertStoppedSuffix(f);
 const[event]=await owner.db.execute<{error:string}>(sql`select error from contract_shared_event where id=${f.start.eventId}::uuid`);expect(event.error).toContain('workflow authority changed');expect(event.error).not.toContain('period changed');
},180_000);
it.each(['renew','convert'] as const)('after actual native %s posting, admits one restricted fake SMTP delivery after kernel input/seal cleanup and refuses its replay',async kind=>{
 auth.send.mockReset();auth.send.mockResolvedValue(undefined);
 const f=await historicalManualEmailFixture(auth.origin,false,()=>contractPostingFixture({kind,future:false,payChanges:false}));await f.post();
 const[before]=await owner.db.execute<{current:boolean}>(sql`select app.contract_shared_delivery_period_current(${f.b.tenantId}::uuid,${f.caseId}::uuid) as current`);expect(before.current).toBe(false);
 await f.completeHR();await f.settle();await assertStoppedSuffix(f);
 const deliveries=await f.deliveries();expect(deliveries).toHaveLength(1);
 const[job]=await owner.db.execute<{state:string;input:unknown}>(sql`select state,input from bulk_job where id=${f.start.jobId}::uuid`);expect(job.state).toBe('completed');expect(job.input).toBeNull();
 expect(await owner.db.execute(sql`select job_id from app.bulk_job_seal where job_id=${f.start.jobId}::uuid`)).toEqual([]);
 const[receipt]=await owner.db.execute<{deliveryId:string;hash:string}>(sql`select delivery_id as "deliveryId",encode(payload_hash,'hex') hash from app.contract_email_delivery_receipt where tenant_id=${f.b.tenantId}::uuid`);expect(receipt.deliveryId).toBe(deliveries[0].id);expect(receipt.hash).toMatch(/^[a-f0-9]{64}$/);
 const token=randomUUID();await owner.db.execute(sql`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '3 minutes' where id=${receipt.deliveryId}::uuid`);
 expect((await client`select current_user role,app.current_tenant_id() tenant`)[0]).toEqual({role:'ai_hr_app',tenant:null});
 await expect(withTenant(f.admin,tx=>tx.execute(sql`select app.contract_shared_email_recovery_source(${f.b.tenantId}::uuid,${f.pin.id}::uuid)`))).rejects.toThrow();
 expect(await internalAutomationMail({deliveryId:receipt.deliveryId,leaseToken:token},auth.send)).toMatchObject({outcome:'sent'});expect(auth.send).toHaveBeenCalledOnce();
 expect(await internalAutomationMail({deliveryId:receipt.deliveryId,leaseToken:token},auth.send)).toMatchObject({outcome:'skipped'});expect(auth.send).toHaveBeenCalledOnce();
},180_000);
it('rejects actual manual PM period drift after a valid posted receipt instead of treating any old posting as current provenance',async()=>{
 const f=await historicalManualEmailFixture(auth.origin);await f.post();await f.completeHR();await f.settle();const[d]=await f.deliveries();expect(d).toBeTruthy();
 await setEmploymentInfo(f.admin,{employmentId:f.employee.employmentId,contractNumber:91});
 const token=randomUUID();await owner.db.execute(sql`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '3 minutes' where id=${d.id}::uuid`);
 expect((await owner.db.execute<{target:unknown}>(sql`select app.automation_email_target(${d.id}::uuid,${token}::uuid,${auth.origin}) as target`))[0].target).toBeNull();
},180_000);
it('closes a genuine stale callback after its same email run already advanced, without claiming that run still waits',async()=>{
 const f=await historicalManualEmailFixture(auth.origin);await f.firstDecision();await f.completeHR();
 // A real employee signature is a second authorized canonical progress callback; no event or proof is inserted.
 await actForm(f.employeeActor,f.letter.id,'signed');
 const callbacks=await owner.db.execute<{id:string}>(sql`select e.id from contract_shared_event e join app.contract_email_prerequisite_resume r on r.tenant_id=e.tenant_id and r.event_id=e.id where r.tenant_id=${f.b.tenantId}::uuid and r.pin_id=${f.pin.id}::uuid order by e.created_at,e.id`);expect(callbacks).toHaveLength(2);
 let advanced=false;
 const diagnostic:typeof contractAutomationJobHandler={...contractAutomationJobHandler,async finalize(ctx,job,unit){
  return contractAutomationJobHandler.finalize!(ctx,job,{...unit,ownerTx:callback=>unit.ownerTx!(async native=>{
   if(job.id===f.start.jobId&&!advanced){
    // Use the real kernel's held owner transaction, actual later native callback and canonical email
    // executor to exercise out-of-order completion. No lease, event, actor or capability is fabricated.
    const latest=callbacks[1].id;await native`select set_config('app.tenant_id',${f.b.tenantId},true),set_config('app.user_id','',true),set_config('app.contract_event',${latest},true)`;
    const db=reservedSqlExecutor(native),start=await beginContractEmailRecovery(db,latest);expect(start.ready).toBe(true);
    const inputs=await readContractSharedExecutionInputs(native,{...ctx,userId:undefined},f.caseId),context=contractSharedAutomationContext(inputs.view,inputs.refs),today=todayInKualaLumpur();
    const executor=contractSharedEmailExecutors(db,{context,today,templates:inputs.runtimeEmails,prepareTemplate:(step,current)=>prepareContractSharedEmailStep(db,{...ctx,userId:undefined},{step,current,create:async()=>{throw Error('Recovery cannot generate another document');}})});
    await retryContractEmailRecovery(db,latest,start,executor.sendEmail,contractAutomationRead(context,'manual',today));advanced=true;
   }
   return callback(native);
  })});
 }};
 await new Promise(resolve=>setTimeout(resolve,2100));await runBulkJobTick(owner.client,{handlers:[diagnostic]});expect(advanced).toBe(true);
 const[stale]=await owner.db.execute<{processed:boolean;error:string}>(sql`select processed_at is not null as processed,error from contract_shared_event where id=${callbacks[0].id}::uuid`);
 expect(stale).toEqual({processed:true,error:'The email run already advanced; this callback sent nothing.'});
 expect(await f.deliveries()).toHaveLength(1);await f.settle();expect(await f.deliveries()).toHaveLength(1);
},180_000);

it('recovers a genuine SYSTEM historical email after native posting without widening the ordinary system business guard',async()=>{
 const f=await historicalManualEmailFixture(auth.origin,true);await f.post();await f.completeHR();await f.settle();await assertStoppedSuffix(f);expect(await f.deliveries()).toHaveLength(1);
 const[job]=await owner.db.execute<{kind:string;creator:string|null;context:unknown;state:string}>(sql`select kind,created_by creator,context,state from bulk_job where id=${f.start.jobId}::uuid`);
 expect(job).toEqual({kind:'contract_scheduled_automation',creator:null,context:{tenantId:f.b.tenantId,roles:[]},state:'completed'});
 const[event]=await owner.db.execute<{type:string;user:string|null;person:string|null}>(sql`select actor_type type,actor_user_id as "user",actor_person_id person from contract_shared_event where id=${f.start.eventId}::uuid`);expect(event).toEqual({type:'system',user:null,person:null});
 expect(await owner.db.execute(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid and workflow_run_id=${f.pin.runId}::uuid`)).toEqual([]);
},180_000);

it('recovers the original email through two genuine canonical committed period edges while its independent Form remains current',async()=>{
 const f=await historicalManualEmailFixture(auth.origin,false,()=>historicalTwoPeriodPostingFixture({future:false,payChanges:false}));
 await f.post();
 const row=(await contractSharedTracker(f.proposer)).rows.find(item=>item.employmentId===f.employee.employmentId);if(!row?.sourceRevision)throw Error('Actual new-period tracker source is unavailable');
 const opened=await openContractSharedPeriod(f.proposer,{employmentId:f.employee.employmentId,sourceRevision:row.sourceRevision});expect(opened.caseId).not.toBe(f.caseId);
 const nextStart=addDaysIso(f.newEnd,1),nextEnd=addDaysIso(addCalendarMonths(nextStart,6),-1);
 expect(nextEnd<todayInKualaLumpur()).toBe(true);
 const second={...f,caseId:opened.caseId,start:f.newStart,end:f.newEnd,newStart:nextStart,newEnd:nextEnd,draft:{...f.draft,startOn:nextStart,endOn:nextEnd,reason:'A second real retained six-month agreement'}};
 const posting=await releaseContractPosting(second);await approveAppliedContractPosting(f.admin,{id:posting.id,revision:posting.revision});
 const receipts=await owner.db.execute<{id:string}>(sql`select r.posting_id as id from contract_shared_posting r join personnel_posting p on p.tenant_id=r.tenant_id and p.id=r.posting_id where p.tenant_id=${f.b.tenantId}::uuid and p.employment_id=${f.employee.employmentId}::uuid and r.applied_at is not null`);expect(receipts).toHaveLength(2);
 await f.completeHR();await f.settle();expect(await f.deliveries()).toHaveLength(1);await assertStoppedSuffix(f);
 const edges=await owner.db.execute<{before:string;after:string|null}>(sql`select source_revision as "before",after_period_revision as "after" from contract_shared_posting where tenant_id=${f.b.tenantId}::uuid and posting_id in(select id from personnel_posting where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid) order by applied_at,posting_id`);expect(edges).toHaveLength(2);expect(edges.every(edge=>edge.after!==null)).toBe(true);expect(edges.some(edge=>edges.some(next=>next.before===edge.after))).toBe(true);
 expect((await readContractSharedLetter(f.employeeActor,f.letter.id)).pendingAction?.kind).toBe('sign');
 const[current]=await owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${f.b.tenantId},true)`;return tx<{current:boolean}[]>`select app.contract_shared_email_document_current(${f.b.tenantId}::uuid,${f.letter.id}::uuid) as current`;});expect(current.current).toBe(true);
},240_000);

it('keeps every newly introduced recovery port private and both orchestration tables under explicit forced owner RLS',async()=>{
 const functions=['app.contract_shared_email_recovery_source(uuid,uuid)','app.contract_shared_email_recovery_frame(uuid)','app.contract_shared_system_job_held_current(uuid)','app.contract_shared_email_recovery_disposition(uuid)','app.contract_shared_delivery_eligible(uuid,uuid,uuid,jsonb)','app.contract_shared_email_recovery_original(uuid)','app.contract_shared_ordinary_event_progress(uuid,jsonb)','app.contract_shared_posting_period_capture_valid(uuid)','app.contract_shared_posting_capture_applied_period(uuid)','app.contract_shared_posting_after_period_guard()','app.contract_shared_posting_period_receipt()','app.contract_shared_email_event_cursor(uuid)','app.contract_shared_email_retain_unattempted(uuid)','app.contract_shared_email_reconciliation_page(uuid,integer,integer)','app.contract_shared_email_stop_completed_tail(uuid)'];
 const rows=await owner.db.execute<{signature:string;app:boolean;pub:boolean}>(sql`select signature,has_function_privilege('ai_hr_app',signature,'EXECUTE') as app,exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE') as pub from jsonb_array_elements_text(${JSON.stringify(functions)}::jsonb) signatures(signature) join pg_proc p on p.oid=signature::regprocedure order by signature`);
 expect(rows).toHaveLength(functions.length);expect(rows.every(row=>!row.app&&!row.pub)).toBe(true);
 const tables=await owner.db.execute<{name:string;rls:boolean;forced:boolean;app:boolean}>(sql`select c.relname name,c.relrowsecurity rls,c.relforcerowsecurity forced,has_table_privilege('ai_hr_app',c.oid,'SELECT,INSERT,UPDATE,DELETE') app from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app' and c.relname in('contract_email_delivery_receipt','contract_ordinary_event_progress') order by c.relname`);expect(tables).toHaveLength(2);expect(tables.every(table=>table.rls&&table.forced&&!table.app)).toBe(true);
 const policies=await owner.db.execute<{table:string;name:string;roles:string[];qual:string;check:string}>(sql`select tablename as "table",policyname name,roles::text[] roles,qual,with_check as "check" from pg_policies where schemaname='app' and tablename in('contract_email_delivery_receipt','contract_ordinary_event_progress') order by tablename`);
 expect(policies).toHaveLength(2);for(const policy of policies){expect(policy.name).toBe(policy.table+'_owner');expect(policy.roles).toEqual(['ai_hr_owner']);expect(policy.qual).toBe('app.acting_as_owner()');expect(policy.check).toBe('app.acting_as_owner()');}
});

it('retains a genuinely started non-email sibling after email-only A completes, including old-case links, counts and scope after native posting',async()=>{
 const f=await historicalStartedCohortFixture();
 const[bBefore]=await owner.db.execute<{image:Record<string,unknown>}>(sql`select to_jsonb(run) as image from automation_run run where tenant_id=${f.b.tenantId}::uuid and id=${f.cohort.bRunId}::uuid`);
 expect(bBefore.image.status).toBe('waiting');expect(bBefore.image.remaining_steps).toEqual([]);
 await f.post();expect((await contractSharedContext(f.admin,f.caseId)).flow!.stage).toBe('renewed');await f.complete();
 await new Promise(resolve=>setTimeout(resolve,2100));
 for(let count=0;count<100;count++){await f.tick();const[job]=await owner.db.execute<{state:string}>(sql`select state from bulk_job where id=${f.startEvent.jobId}::uuid`);if(job.state==='completed')break;}
 const[bAfter]=await owner.db.execute<{image:Record<string,unknown>}>(sql`select to_jsonb(run) as image from automation_run run where tenant_id=${f.b.tenantId}::uuid and id=${f.cohort.bRunId}::uuid`);expect(bAfter.image).toEqual(bBefore.image);
 const[a]=await owner.db.execute<{status:string;remaining:unknown[]}>(sql`select status,remaining_steps remaining from automation_run where tenant_id=${f.b.tenantId}::uuid and id=${f.cohort.runId}::uuid`);expect(a).toEqual({status:'done',remaining:[]});
 const[deliveries]=await owner.db.execute<{count:number}>(sql`select count(*)::integer count from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and payload->'mail'->>'templateId'=${f.emailId}`);expect(deliveries.count).toBe(1);
 const[event]=await owner.db.execute<{processed:boolean;error:string;retained:{workflows:{id:string;name:string;revision:number;stage:string}[];retainedRunIds:string[]}}>(sql`select processed_at is not null as processed,error,email_reconciliation as retained from contract_shared_event where id=${f.startEvent.eventId}::uuid`);
 expect(event.processed).toBe(true);expect(event.error).toContain('retained for reconciliation');
 const[jobReceipt]=await owner.db.execute<{state:string;error:string}>(sql`select state,error from bulk_job where id=${f.startEvent.jobId}::uuid`);expect(jobReceipt.state).toBe('completed');expect(jobReceipt.error).toContain('retained for reconciliation');
 expect(event.retained.workflows).toEqual([{id:f.bId,name:'Frozen B started approval',revision:1,stage:'needs_reconciliation'}]);expect(event.retained.retainedRunIds).toEqual([f.cohort.bRunId]);
 const beforeOpen=await contractSharedTracker(f.proposer,{attention:true,limit:1});expect(beforeOpen.total).toBe(1);expect(beforeOpen.summary.attention).toBe(1);expect(beforeOpen.rows[0]).toMatchObject({caseId:null,reconciliationNeeded:true,reconciliationCaseId:f.caseId});expect(beforeOpen.rows[0].flags).toContain('workflow_reconciliation');
 const initial=(await contractSharedTracker(f.proposer)).rows.find(item=>item.employmentId===f.employee.employmentId);if(!initial?.sourceRevision)throw Error('Actual new period source is unavailable');
 const opened=await openContractSharedPeriod(f.proposer,{employmentId:f.employee.employmentId,sourceRevision:initial.sourceRevision});expect(opened.caseId).not.toBe(f.caseId);
 // Prove both actual existing CaseView gates, rather than granting old case access from an employment guess.
 expect((await contractSharedContext(f.proposer,f.caseId)).id).toBe(f.caseId);expect((await contractSharedContext(f.proposer,opened.caseId)).id).toBe(opened.caseId);
 const workspace=await contractSharedWorkspace(f.proposer,opened.caseId),page=await contractSharedEmailReconciliations(f.proposer,opened.caseId,0);
 expect(workspace.attention?.attention).toBe(true);expect(workspace.attention?.flags).toContain('workflow_reconciliation');expect(page.total).toBe(1);expect(page.hasMore).toBe(false);expect(page.items[0]).toMatchObject({eventId:f.startEvent.eventId,caseId:f.caseId,reason:'authority_changed',workflows:event.retained.workflows});expect(workspace.emailReconciliations).toEqual(page);
 expect(await contractSharedEmailReconciliations(f.proposer,opened.caseId,1)).toMatchObject({items:[],total:1,offset:1,hasMore:false});
 const attention=await contractSharedTracker(f.proposer,{attention:true,limit:1});expect(attention.total).toBe(1);expect(attention.summary.attention).toBe(1);expect(attention.rows[0]).toMatchObject({caseId:opened.caseId,reconciliationCaseId:f.caseId});
 const unrelated=await unrelatedReconciliationCases(f);expect(unrelated.sameCompany.personId).not.toBe(f.employee.personId);expect(unrelated.otherCompany.personId).not.toBe(f.employee.personId);
 for(const other of[unrelated.sameCompany,unrelated.otherCompany]){
  await expect(contractSharedEmailReconciliations(f.proposer,other.caseId,0)).rejects.toThrow();
  expect((await contractSharedEmailReconciliations(f.admin,other.caseId,0)).items).toEqual([]);
 }
 await expect(contractSharedEmailReconciliations(f.employeeActor,opened.caseId,0)).rejects.toThrow();
 await expect(withTenant(f.admin,async tx=>{await tx.execute(sql`select set_config('app.requested_contract_email_reconciliation_offset','not-an-offset',true)`);return tx.execute(sql`select app.contract_shared_workspace(${opened.caseId}::uuid)`);})).rejects.toThrow();
},240_000);

it('fails only a genuine completed-email running tail when authority changes before continuation and retains every immutable run field',async()=>{
 const f=await historicalManualEmailFixture(auth.origin);await f.completeHR();await new Promise(resolve=>setTimeout(resolve,2100));await f.tick();
 const[before]=await owner.db.execute<{status:string;immutable:Record<string,unknown>}>(sql`select run.status,to_jsonb(run)-array['status','failure','waiting_for','log','updated_at'] as immutable from automation_run run where run.tenant_id=${f.b.tenantId}::uuid and run.id=${f.pin.runId}::uuid`);expect(before.status).toBe('running');
 const[receipt]=await owner.db.execute<{completed:boolean;continued:boolean;hashMatches:boolean}>(sql`select r.completed_at is not null completed,r.continued_at is not null continued,r.result_run_hash=encode(sha256(convert_to((to_jsonb(run)-'updated_at')::text,'UTF8')),'hex') as "hashMatches" from app.contract_email_prerequisite_resume r join contract_shared_email_document_step p on p.tenant_id=r.tenant_id and p.id=r.pin_id join automation_run run on run.tenant_id=p.tenant_id and run.id=p.workflow_run_id where r.tenant_id=${f.b.tenantId}::uuid and p.id=${f.pin.id}::uuid`);expect(receipt).toEqual({completed:true,continued:false,hashMatches:true});
 await f.firstDecision();await f.settle();
 const[after]=await owner.db.execute<{status:string;failure:string;immutable:Record<string,unknown>;tail:{step:{id:string}}[]}>(sql`select run.status,run.failure,to_jsonb(run)-array['status','failure','waiting_for','log','updated_at'] as immutable,run.remaining_steps as tail from automation_run run where run.tenant_id=${f.b.tenantId}::uuid and run.id=${f.pin.runId}::uuid`);
 expect(after.status).toBe('failed');expect(after.failure).toBe('Original workflow authority changed; remaining steps stopped.');expect(after.immutable).toEqual(before.immutable);expect(after.tail.map(item=>item.step.id)).toEqual([f.tailStep]);
 expect(await owner.db.execute(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid and workflow_run_id=${f.pin.runId}::uuid`)).toEqual([]);expect(await f.deliveries()).toHaveLength(1);
 const visible=await contractSharedEmailReconciliations(f.admin,f.caseId,0);expect(visible.items.some(item=>item.retainedRunIds.includes(f.pin.runId))).toBe(true);
},180_000);
it('projects a real waiting run for review without manufacturing a failure when no completed-email receipt exists',async()=>{
 const f=await historicalManualEmailFixture(auth.origin);await f.firstDecision();await new Promise(resolve=>setTimeout(resolve,2100));await f.tick();
 const[run]=await owner.db.execute<{status:string;waiting:string;failure:string|null}>(sql`select status,waiting_for waiting,failure from automation_run where tenant_id=${f.b.tenantId}::uuid and id=${f.pin.runId}::uuid`);expect(run).toEqual({status:'waiting',waiting:f.pin.id,failure:null});
 expect(await owner.db.execute(sql`select event_id from app.contract_email_prerequisite_resume where tenant_id=${f.b.tenantId}::uuid and pin_id=${f.pin.id}::uuid and completed_at is not null`)).toEqual([]);
 const visible=await contractSharedEmailReconciliations(f.admin,f.caseId,0);expect(visible.items.some(item=>item.retainedRunIds.includes(f.pin.runId))).toBe(true);expect(await f.deliveries()).toEqual([]);
 await f.completeHR();await f.settle();expect(await f.deliveries()).toHaveLength(1);
},180_000);


it('does not treat real technical closure as posting approval readiness after an authorized Personnel correction is genuinely restored',async()=>{
 const f=await contractPostingFixture({future:false,payChanges:false});const documentId=randomUUID(),emailId=randomUUID(),emailStep=randomUUID(),bId=randomUUID();
 await saveAutomationDocumentTemplate(f.admin,{template:{id:documentId,module:'contract_staff',name:'Actual producer email prerequisite',description:'',rules:{},blocks:[{id:'body',type:'text',text:'Review this actual producer acknowledgement.',section:''}],fields:[],routing:[{id:'hr',order:1,action:'review',owner:true,who:{kind:'people',userIds:[f.admin.userId!]}},{id:'sign',order:2,action:'sign',owner:false,who:{kind:'people',userIds:[f.admin.userId!]}}]},expectedRevision:0,publish:true,retired:false});
 await saveAutomationEmailTemplate(f.admin,{template:{id:emailId,module:'contract_staff',name:'Actual producer email',active:true,subject:'Actual producer acknowledgement',body:'Open the retained acknowledgement.',cc:[],documentIds:[documentId]},expectedRevision:0,retired:false,reason:'Actual current callback before source correction'});
 await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,steps:[...f.workflow.steps,{id:emailStep,type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:emailId}}]},expectedRevision:1,reason:'Actual FIRST producer followed by no-tail email'});
 await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,id:bId,name:'Frozen unattempted release sibling',trigger:{event:'letterReleased',days:0,workdays:false,repeat:false},conditions:[],steps:[{id:'must-not-send',type:'notify',conditions:[],to:[{kind:'person',userId:f.admin.userId!}],cc:[],params:{subject:'Unattempted release sibling must not send',body:'Retain this authored reference.'}}]},expectedRevision:0,reason:'Actual later dispatch manifest reference'});
 const posting=await releaseContractPosting(f,{returnAtPosting:true});const tick=()=>runBulkJobTick(owner.client,{handlers:[contractAutomationJobHandler]});
 let pin:{id:string;runId:string;letterId:string;originId:string}|undefined;
 for(let count=0;count<100&&!pin;count++){
  [pin]=await owner.db.execute<{id:string;runId:string;letterId:string;originId:string}>(sql`select pin.id,pin.workflow_run_id as "runId",pin.documents->>${documentId} as "letterId",binding.origin_event_id as "originId" from contract_shared_email_document_step pin join automation_run run on run.tenant_id=pin.tenant_id and run.id=pin.workflow_run_id and run.status='waiting' and run.waiting_for=pin.id join app.contract_email_prerequisite_origin binding on binding.tenant_id=pin.tenant_id and binding.pin_id=pin.id where pin.tenant_id=${f.b.tenantId}::uuid and pin.email_template_id=${emailId}::uuid`);
  if(!pin)await tick();
 }
 if(!pin)throw Error('The actual FIRST producer did not reach its email wait.');
 const[original]=await owner.db.execute<{trigger:string;refs:{workflowId:string}[];producer:boolean}>(sql`select event.trigger_event as trigger,event.workflow_versions as refs,exists(select 1 from app.contract_posting_producer producer where producer.tenant_id=event.tenant_id and producer.posting_id=${posting.id}::uuid and producer.event_id=event.id) as producer from contract_shared_event event where event.id=${pin.originId}::uuid`);
 expect(original.trigger).toBe('letterReleased');expect(original.refs.map(ref=>ref.workflowId)).toEqual([bId]);expect(original.producer).toBe(true);
 await actForm(f.admin,pin.letterId,'reviewed');await actForm(f.admin,pin.letterId,'signed');
 await new Promise(resolve=>setTimeout(resolve,2100));
 let completedEmail=false;
 for(let count=0;count<100&&!completedEmail;count++){await tick();const[run]=await owner.db.execute<{status:string}>(sql`select status from automation_run where tenant_id=${f.b.tenantId}::uuid and id=${pin.runId}::uuid`);completedEmail=run.status==='done';}
 expect(completedEmail).toBe(true);
 // Stop on the genuine callback unit before ordinary current-event refs start; no plan/cursor is edited.
 expect(await owner.db.execute(sql`select id from automation_run where tenant_id=${f.b.tenantId}::uuid and workflow_id=${bId}::uuid`)).toEqual([]);
 await setEmploymentInfo(f.admin,{employmentId:f.employee.employmentId,contractNumber:91});
 await new Promise(resolve=>setTimeout(resolve,2100));
 for(let count=0;count<100;count++){await tick();const[job]=await owner.db.execute<{state:string}>(sql`select state from bulk_job where id=${posting.continuationJobId}::uuid`);if(job.state==='completed')break;}
 const[closed]=await owner.db.execute<{state:string;processed:boolean;metadata:{workflows:{id:string;stage:string}[]}}>(sql`select job.state,event.processed_at is not null as processed,event.email_reconciliation as metadata from contract_shared_event event join bulk_job job on job.tenant_id=event.tenant_id and job.id=event.job_id where event.id=${pin.originId}::uuid`);
 expect(closed.state).toBe('completed');expect(closed.processed).toBe(true);expect(closed.metadata.workflows).toEqual([{id:bId,revision:1,name:'Frozen unattempted release sibling',stage:'not_started'}]);
 await setEmploymentInfo(f.admin,{employmentId:f.employee.employmentId,contractNumber:4});
 const[current]=await owner.db.execute<{current:boolean;conflict:unknown;decision:number}>(sql`select app.contract_shared_decision_current(c.tenant_id,c.id,receipt.decision_revision) as current,c.source_conflict as conflict,receipt.decision_revision as decision from contract_case c join contract_shared_posting receipt on receipt.tenant_id=c.tenant_id and receipt.case_id=c.id where receipt.posting_id=${posting.id}::uuid`);
 expect(current).toEqual({current:true,conflict:null,decision:1});
 expect(await readContractSharedPosting(f.approver,posting.id)).toMatchObject({status:'pending',sourceCurrent:true,workflowReady:false,canApprove:false});
 await expect(approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision})).rejects.toThrow();
 expect(await owner.db.execute(sql`select id from automation_run where tenant_id=${f.b.tenantId}::uuid and workflow_id=${bId}::uuid`)).toEqual([]);
 expect(await owner.db.execute(sql`select id from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and payload->'mail'->>'subject'='Unattempted release sibling must not send'`)).toEqual([]);
 const[unchanged]=await owner.db.execute<{state:string;applied:boolean}>(sql`select posting.status as state,receipt.applied_at is not null as applied from personnel_posting posting join contract_shared_posting receipt on receipt.tenant_id=posting.tenant_id and receipt.posting_id=posting.id where posting.id=${posting.id}::uuid`);expect(unchanged).toEqual({state:'pending',applied:false});
},240_000);
