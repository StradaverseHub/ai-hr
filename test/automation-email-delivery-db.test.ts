// Real email for shared workflow steps (lane F1, migration 5754). A Probation "Notify someone" or "Send an email" step
// leaves the in-app notice and records a durable email intent in the same transaction; the out-of-band worker leases
// it, the private sender (simulated here through the same capability functions) starts and finishes it, and a message
// whose send started is never re-sent. Fictional people and addresses only.
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {adminCtx,closeAll,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {probationOutcomeFixture} from './helpers/probation-outcome-fixture';
import type {SessionContext,Tx} from '../db/client';
import {deliverAutomationEmails} from '../core/automation-email-delivery';
import {emitProbationEventTx,probationAutomationCaseTx} from '../core/probation-automation';
import type {AutomationDeliveryRequest,AutomationDeliveryResult} from '../lib/automation-email-ipc';

const ORIGIN='https://workflow-mail-fixture.example';
let b:Base,admin:SessionContext,fixture:ReturnType<typeof probationOutcomeFixture>;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);fixture=probationOutcomeFixture(b,admin);});

async function liveWorkflow(trigger:string,steps:Record<string,unknown>[]){
 const definition={name:'Fictional email workflow',description:'Emails',module:'probation',trigger:{event:trigger,days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],
  steps:steps.map((step,i)=>({id:'s'+(i+1),conditions:[],to:[],cc:[],params:{},...step}))};
 await owner.db.execute(sql`insert into automation_workflow_version(tenant_id,workflow_id,revision,module,status,required,definition,reason,saved_by) values(${b.tenantId}::uuid,${randomUUID()}::uuid,1,'probation','live',false,${JSON.stringify(definition)}::jsonb,'Fictional live workflow',${admin.userId}::uuid)`);
}
async function emailTemplate(active:boolean){
 const id=randomUUID();
 await owner.db.execute(sql`insert into automation_email_template_version(tenant_id,template_id,revision,module,name,active,subject,body,cc,reason,saved_by) values(${b.tenantId}::uuid,${id}::uuid,1,'probation','Fictional template',${active},'Review for {{employee.name}}','Please open {{ case.link }} for {{employee.name}}.','[]'::jsonb,'Fictional template',${admin.userId}::uuid)`);
 return id;
}
const identity=(userId:string)=>owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${ORIGIN+'/auth/'+b.tenantId},${randomUUID()},${userId}::uuid)`);
const deliveries=()=>owner.db.execute<{key:string;status:string;to:string[];cc:string[];subject:string;body:string;error:string|null}>(sql`select mail_key as key,status,payload->'mail'->'to' as to,payload->'mail'->'cc' as cc,payload->'mail'->>'subject' as subject,payload->'mail'->>'body' as body,error_code as error from automation_email_delivery where tenant_id=${b.tenantId}::uuid order by mail_key`);
const port={withTenant:async<T>(context:SessionContext,run:(tx:Tx)=>Promise<T>)=>owner.withTenant(context,run)};
/** The private sender's database protocol (lib/internal-auth/automation-mail.ts) without SMTP. */
function simulatedSender(behaviour:'send'|'relayMissing'|'lostReceipt'){
 return async(request:AutomationDeliveryRequest):Promise<AutomationDeliveryResult>=>{
  if(behaviour==='relayMissing')return{outcome:'skipped',error:'relayUnavailable'};
  const [{target}]=await owner.db.execute<{target:{bindings:unknown[]}|null}>(sql`select app.automation_email_target(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${ORIGIN}) as target`);
  if(!target)return{outcome:'skipped',error:'notEligible'};
  const proof={bindings:target.bindings,addresses:target.bindings.map((_,i)=>`person${i}@mail-fixture.invalid`),relayRevision:'1'};
  const [{started}]=await owner.db.execute<{started:boolean}>(sql`select app.automation_email_start(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${ORIGIN},${JSON.stringify(proof)}::jsonb) as started`);
  if(!started)return{outcome:'skipped',error:'notEligible'};
  if(behaviour==='lostReceipt')throw new Error('The private sender stopped after SMTP started');
  await owner.db.execute(sql`select app.automation_email_finish(${request.deliveryId}::uuid,${request.leaseToken}::uuid,'sent',null)`);
  return{outcome:'sent',error:null};
 };
}

async function raise(caseId:string,partId:string,occurrence:string){
 const runner={...admin,userId:undefined,roles:[],grants:undefined} as SessionContext;
 return owner.withTenant(runner,async tx=>{
  const record=await probationAutomationCaseTx(tx,caseId);
  return emitProbationEventTx(tx,runner,{trigger:'lowResult',occurrence,record:record!,facts:{partId,partType:3}});
 });
}

describe('Shared workflow email (F1, 5754)',()=>{
 it('queues To and CC apart beside the in-app notice, skips a template turned off, records people without an email, and sends once',async()=>{
  const {ids,staff,manager,admin:pbp}=await fixture.recordedConfirm();admin=pbp;
  await identity(staff.userId);await identity(pbp.userId!); // the Line Manager has no sign-in email
  const off=await emailTemplate(false),on=await emailTemplate(true);
  await liveWorkflow('lowResult',[
   {type:'notify',params:{subject:'Assessment for {{employee.name}}',body:'Open {{case.link}}'},to:[{kind:'role',role:'employee'}],cc:[{kind:'role',role:'directSuperior'},{kind:'group',groupId:'probation-people'}]},
   {type:'sendEmail',params:{emailTemplateId:off},to:[{kind:'role',role:'employee'}]},
   {type:'sendEmail',params:{emailTemplateId:on},to:[{kind:'group',groupId:'probation-people'}]},
  ]);
  const result=await raise(ids.caseId,ids.part,'first');
  expect(result.runs).toHaveLength(1);
  const log=result.runs[0].log;
  expect(log.find(e=>e.stepId==='s1')).toMatchObject({kind:'stepDone',recipients:expect.arrayContaining([staff.userId,manager.userId,pbp.userId]),unresolved:[expect.objectContaining({reason:expect.stringContaining('in-app notice only')})]});
  expect(log.find(e=>e.stepId==='s2')).toMatchObject({kind:'stepSkipped',message:'Skipped: the email template is turned off.'});
  const rows=await deliveries();
  expect(rows.map(r=>({...r,key:r.key.split(':').slice(1).join(':')}))).toEqual([
   {key:'s1:0',status:'queued',to:[staff.userId],cc:[pbp.userId],subject:'Assessment for Fictional Staff',body:'Open {{case.link}}',error:null},
   {key:'s3:0',status:'queued',to:[pbp.userId],cc:[],subject:'Review for Fictional Staff',body:'Please open {{case.link}} for Fictional Staff.',error:null},
  ]);
  // The in-app notice is kept for everyone the step resolved.
  const notices=await owner.db.execute<{users:string[]}>(sql`select recipient_user_ids as users from probation_occurrence where case_id=${ids.caseId}::uuid and kind='automation' order by source_key`);
  expect(notices.map(n=>[...n.users].sort())).toEqual(expect.arrayContaining([[staff.userId,manager.userId,pbp.userId].sort()]));
  expect(await owner.db.execute(sql`select 1 from domain_event where tenant_id=${b.tenantId}::uuid and event_type='automation.email-queued'`)).toHaveLength(2);
  // The same event again starts no run and queues nothing.
  expect((await raise(ids.caseId,ids.part,'first')).alreadyRan).toHaveLength(1);
  expect(await deliveries()).toHaveLength(2);
  const runner={...admin,userId:undefined,roles:[],grants:undefined} as SessionContext;
  expect(await deliverAutomationEmails(runner,port,simulatedSender('send'))).toEqual({attempted:2,sent:2,held:0,failed:0,cancelled:0});
  expect((await deliveries()).map(r=>r.status)).toEqual(['sent','sent']);
  expect(await deliverAutomationEmails(runner,port,simulatedSender('send'))).toEqual({attempted:0,sent:0,held:0,failed:0,cancelled:0});
 });

 it('holds a message while no relay is applied and never re-sends one whose send started',async()=>{
  const {ids,staff,admin:pbp}=await fixture.recordedConfirm();admin=pbp;
  await identity(staff.userId);
  await liveWorkflow('lowResult',[{type:'notify',params:{subject:'Assessment',body:'Body'},to:[{kind:'role',role:'employee'}]}]);
  await raise(ids.caseId,ids.part,'second');
  const runner={...admin,userId:undefined,roles:[],grants:undefined} as SessionContext;
  expect(await deliverAutomationEmails(runner,port,simulatedSender('relayMissing'))).toMatchObject({attempted:1,held:1});
  expect(await deliveries()).toEqual([expect.objectContaining({status:'queued',error:'relayUnavailable'})]);
  // Not due yet: nothing is attempted until the hold passes.
  expect(await deliverAutomationEmails(runner,port,simulatedSender('send'))).toMatchObject({attempted:0});
  await owner.db.execute(sql`update automation_email_delivery set next_attempt_at=now() where tenant_id=${b.tenantId}::uuid`);
  expect(await deliverAutomationEmails(runner,port,simulatedSender('lostReceipt'))).toMatchObject({attempted:1,held:1});
  expect(await deliveries()).toEqual([expect.objectContaining({status:'uncertain',error:'uncertain'})]);
  expect(await deliverAutomationEmails(runner,port,simulatedSender('send'))).toMatchObject({attempted:0});
  await expect(owner.db.execute(sql`update automation_email_delivery set started_at=null where tenant_id=${b.tenantId}::uuid`)).rejects.toThrow();
 });

 it('refuses a caller without access to the case and a capability read without a live lease',async()=>{
  const {ids,staff}=await fixture.recordedConfirm();
  const stranger={...staff.ctx,userId:randomUUID()} as SessionContext;
  await expect(owner.withTenant(stranger,tx=>tx.execute(sql`select app.automation_email_queue('probation',${ids.caseId}::uuid,'k',${`{${staff.userId}}`}::uuid[],null,'Subject','Body')`))).rejects.toThrow();
  const [{target}]=await owner.db.execute<{target:unknown}>(sql`select app.automation_email_target(${randomUUID()}::uuid,${randomUUID()}::uuid,${ORIGIN}) as target`);
  expect(target).toBeNull();
 });
});
