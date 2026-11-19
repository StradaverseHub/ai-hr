/** Combined original-migration-order regression: all positive deliveries originate in real workflow runtimes.
 * SOURCE ONLY / UNRUN. Install under test/ after the additive module-check compatibility tail.
 */
import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterEach,afterAll,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {owner,migrateTestDb,resetDb,closeAll,seedBase,setModule,adminCtx} from './harness';
import {probationOutcomeFixture} from './helpers/probation-outcome-fixture';
import {fixture as contractFixture,submit as submitContract} from './helpers/contract-document-fixture';
import {resignationJourneyFixture} from './helpers/resignation-journey-fixture';
import {saveAutomationWorkflow} from '../packs/automation/service';
import {commandResignationJourney} from '../packs/lifecycle/service';
import {emitProbationEventTx,probationAutomationCaseTx} from '../core/probation-automation';
import {deliverAutomationEmails} from '../core/automation-email-delivery';
import {pgErrorChain,pgSqlState} from '../lib/db-error';
const ORIGIN='https://combined-mail-fixture.example.test';
beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
const identity=(tenantId:string,userId:string)=>owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${ORIGIN+'/auth/'+tenantId},${randomUUID()},${userId}::uuid)`);
/** Read only custody with the actual lease returned by the canonical owner sweep. No start/SMTP/sent fabrication. */
async function inspectQueued(actor:SessionContext,module:'probation'|'off'|'contract_staff',subjectId:string,recipient:string,subject:string){
 const queued=await owner.db.execute<{id:string;payload:unknown}>(sql`select id,payload from automation_email_delivery where tenant_id=${actor.tenantId}::uuid and module=${module} and subject_id=${subjectId}::uuid and payload->'mail'->>'subject'=${subject}`);
 expect(queued).toHaveLength(1);const delivery=queued[0];let matched=0;let senderFailure:unknown;
 // Even a real authorized HR actor has no table-wide delivery reader.
 let tableRefusal:unknown;
 try{await withTenant(actor,tx=>tx.execute(sql`select payload from automation_email_delivery where id=${delivery.id}::uuid`));}catch(error){tableRefusal=error;}
 expect(pgSqlState(tableRefusal)).toBe('42501');
 const result=await deliverAutomationEmails({...actor,userId:undefined,personId:undefined,roles:[],grants:undefined},owner,async request=>{
  try{
  const[row]=await owner.db.execute<{target:{id:string;tenantId:string;module:string;subjectId:string;payload:unknown;bindings:{userId:string;issuer:string}[]}|null;badLease:unknown;badOrigin:unknown}>(sql`select
   app.automation_email_target(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${ORIGIN}) as target,
   app.automation_email_target(${request.deliveryId}::uuid,${randomUUID()}::uuid,${ORIGIN}) as "badLease",
   app.automation_email_target(${request.deliveryId}::uuid,${request.leaseToken}::uuid,'https://wrong-origin.example.test') as "badOrigin"`);
  if(request.deliveryId===delivery.id){
   matched++;expect(row.target).toMatchObject({id:delivery.id,tenantId:actor.tenantId,module,subjectId,payload:delivery.payload,bindings:[{userId:recipient,issuer:ORIGIN+'/auth/'+actor.tenantId}]});
   expect(row.badLease).toBeNull();expect(row.badOrigin).toBeNull();
  }
  return {outcome:'skipped',error:'notEligible'};
  }catch(error){senderFailure=error;throw error;}
 });
 if(senderFailure)throw senderFailure;
 expect(result.attempted).toBeGreaterThan(0);expect(matched).toBe(1);
 return delivery.id;
}
it('queues, genuinely leases and resolves the native Probation target after both migration families',async()=>{
 const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');
 const fixture=probationOutcomeFixture(b,adminCtx(b)),f=await fixture.recordedConfirm();await identity(b.tenantId,f.staff.userId);
 const definition={name:'Combined native Probation notice',description:'Compatibility proof',module:'probation',trigger:{event:'lowResult',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:'compat-notice',type:'notify',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{subject:'Combined Probation notice',body:'Open your actual review.'}}]};
 await owner.db.execute(sql`insert into automation_workflow_version(tenant_id,workflow_id,revision,module,status,required,definition,reason,saved_by) values(${b.tenantId}::uuid,${randomUUID()}::uuid,1,'probation','live',false,${JSON.stringify(definition)}::jsonb,'Fictional native compatibility proof',${f.admin.userId}::uuid)`);
 const runner={...f.admin,userId:undefined,personId:undefined,roles:[],grants:undefined};
 await owner.withTenant(runner,async tx=>{const record=await probationAutomationCaseTx(tx,f.ids.caseId);expect(record).not.toBeNull();await emitProbationEventTx(tx,runner,{trigger:'lowResult',occurrence:'combined-native-modules',record:record!,facts:{partId:f.ids.part,partType:3}});});
 await inspectQueued(f.admin,'probation',f.ids.caseId,f.staff.userId,'Combined Probation notice');
},180_000);
it('queues, genuinely leases and resolves the native Resignation target after both migration families',async()=>{
 const f=await resignationJourneyFixture({decisionWorkflow:false,origin:ORIGIN});await identity(f.base.tenantId,f.employeeUserId);
 await f.workflow('submitted',[{id:'compat-notice',type:'notify',conditions:[],to:[{kind:'person',userId:f.employeeUserId}],cc:[],params:{subject:'Combined Resignation notice',body:'Your actual resignation workflow is recorded.'}}]);
 await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'runWorkflowsAgain'}});
 await inspectQueued(f.admin,'off',f.journey.id,f.employeeUserId,'Combined Resignation notice');
},180_000);
it('keeps native Contract workflow delivery and rejects an unknown module using an otherwise real queued payload',async()=>{
 const f=await contractFixture('renew');await identity(f.b.tenantId,f.admin.userId!);
 await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,name:'Combined native Contract notice',steps:[{id:'compat-notice',type:'notify',conditions:[],to:[{kind:'person',userId:f.admin.userId!}],cc:[],params:{subject:'Combined Contract notice',body:'Your actual Contract decision is recorded.'}}]},expectedRevision:1,reason:'Fictional native combined-module compatibility proof'});
 await submitContract(f,'renew');
 const[actual]=await owner.db.execute<{id:string}>(sql`select id from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and module='contract_staff' and subject_id=${f.caseId}::uuid and payload->'mail'->>'subject'='Combined Contract notice'`);expect(actual).toBeDefined();
 // Negative only: copying a real native row with solely the invalid module changed must hit the CHECK.
 // The failed insert rolls back; positive rows, leases, events and workflow proofs are never fabricated.
 for(const forbidden of ['unknown_module','onb']){
  let refused:unknown;
  try{await owner.db.transaction(async tx=>{await tx.execute(sql`insert into automation_email_delivery(tenant_id,module,subject_id,mail_key,payload,created_by) select tenant_id,${forbidden},subject_id,${'invalid-module-'+randomUUID()},payload,created_by from automation_email_delivery where id=${actual.id}::uuid`);});}catch(error){refused=error;}
  expect(pgSqlState(refused)).toBe('23514');
  expect(pgErrorChain(refused).find(link=>link.code==='23514')?.message).toContain('automation_email_delivery_module_check');
  expect(await owner.db.execute(sql`select id from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and module=${forbidden}`)).toHaveLength(0);
 }
 await inspectQueued(f.admin,'contract_staff',f.caseId,f.admin.userId!,'Combined Contract notice');
},180_000);

it('retains a validated closed delivery module set, forced tenant row security and private table ACL',async()=>{
 const[row]=await owner.db.execute<{validated:boolean;expression:string;rls:boolean;forced:boolean;appRead:boolean;appWrite:boolean;publicGrant:boolean}>(sql`select check_rule.convalidated as validated,
  regexp_replace(pg_get_expr(check_rule.conbin,check_rule.conrelid),'[[:space:]]','','g') as expression,
  table_rule.relrowsecurity as rls,table_rule.relforcerowsecurity as forced,
  has_table_privilege('ai_hr_app',table_rule.oid,'SELECT') as "appRead",has_table_privilege('ai_hr_app',table_rule.oid,'INSERT,UPDATE,DELETE,TRUNCATE') as "appWrite",
  exists(select 1 from aclexplode(coalesce(table_rule.relacl,acldefault('r',table_rule.relowner))) a where a.grantee=0) as "publicGrant"
  from pg_constraint check_rule join pg_class table_rule on table_rule.oid=check_rule.conrelid
  where check_rule.conrelid='public.automation_email_delivery'::regclass and check_rule.conname='automation_email_delivery_module_check'`);
 expect(row).toEqual({validated:true,expression:"(module=ANY(ARRAY['probation'::text,'contract_staff'::text,'off'::text]))",rls:true,forced:true,appRead:false,appWrite:false,publicGrant:false});
});
