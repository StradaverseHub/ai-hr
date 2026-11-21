/** Combined native migration-tail regression. Genuine service-created subjects and custody proofs only.
 * Authored against Contract f575 and Resignation27ccf6767; UNRUN until the combined source is assembled.
 */
import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterEach,afterAll,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {owner,migrateTestDb,resetDb,closeAll,createAppUser} from './harness';
import {contractPostingFixture} from './helpers/contract-posting-fixture';
import {resignationJourneyFixture} from './helpers/resignation-journey-fixture';
import {commandResignationJourney,resignationCase} from '../packs/lifecycle/service';
import {prepareResignationProofTx} from '../core/resignation-proof';
import {deliverAutomationEmails} from '../core/automation-email-delivery';
import {pgErrorChain,pgSqlState} from '../lib/db-error';

beforeAll(migrateTestDb);beforeEach(resetDb);afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
async function access(ctx:SessionContext,subjectId:string){
 return withTenant(ctx,async tx=>{
  const[row]=await tx.execute<{contractView:boolean;offView:boolean;contractRun:boolean;offRun:boolean;unknownView:boolean;unknownRun:boolean}>(sql`select
   app.automation_run_subject_access('contract_staff',${subjectId}::uuid) as "contractView",
   app.automation_run_subject_access('off',${subjectId}::uuid) as "offView",
   app.automation_can_run('contract_staff',${subjectId}::uuid) as "contractRun",
   app.automation_can_run('off',${subjectId}::uuid) as "offRun",
   app.automation_run_subject_access('unknown_module',${subjectId}::uuid) as "unknownView",
   app.automation_can_run('unknown_module',${subjectId}::uuid) as "unknownRun"`);
  return row;
 });
}
it('preserves actual Contract Case View and Resignation participant access without cross-module or direct-human runner authority',async()=>{
 // Contract's existing fixture resets the disposable DB, so construct it before the other tenant.
 const contract=await contractPostingFixture({future:false,payChanges:false}),resignation=await resignationJourneyFixture();
 // The bridge's retained original OID must not remain a second application reader.
 const[session]=await withTenant(contract.admin,tx=>tx.execute<{role:string}>(sql`select current_user as role`));
 expect(session.role).toBe('ai_hr_app');
 let archiveRefusal:unknown;
 try{await withTenant(contract.admin,tx=>tx.execute(sql`select * from app.contract_configuration_directory_before_combined(ARRAY[${contract.b.companyId}::uuid], 'Fictional', ARRAY[${contract.proposer.userId!}::uuid])`));}catch(error){archiveRefusal=error;}
 expect(pgSqlState(archiveRefusal)).toBe('42501');
 expect(pgErrorChain(archiveRefusal).find(link=>link.code==='42501')?.message).toContain('permission denied for function contract_configuration_directory_before_combined');
 expect(await access(contract.proposer,contract.caseId)).toEqual({contractView:true,offView:false,contractRun:false,offRun:false,unknownView:false,unknownRun:false});
 expect(await access(resignation.staff,resignation.journey.id)).toEqual({contractView:false,offView:true,contractRun:false,offRun:false,unknownView:false,unknownRun:false});
 expect(await access(resignation.watcher,resignation.journey.id)).toMatchObject({offView:true,offRun:false});
 expect(await access(contract.proposer,resignation.journey.id)).toEqual({contractView:false,offView:false,contractRun:false,offRun:false,unknownView:false,unknownRun:false});
 expect(await access(resignation.staff,contract.caseId)).toEqual({contractView:false,offView:false,contractRun:false,offRun:false,unknownView:false,unknownRun:false});
 expect(await access(resignation.staff,randomUUID())).toEqual({contractView:false,offView:false,contractRun:false,offRun:false,unknownView:false,unknownRun:false});
 // A real second login for the FYI Person is not the originally assigned participant account.
 const outsiderId=await createAppUser(resignation.base.tenantId,resignation.fyi.personId,'employee');
 const outsider:SessionContext={...resignation.watcher,userId:outsiderId};
 expect(await access(outsider,resignation.journey.id)).toMatchObject({offView:false,offRun:false});
 await expect(resignationCase(outsider,resignation.journey.id)).rejects.toThrow();
},180_000);
it('admits off execution only inside the exact same-transaction native authorized command intent',async()=>{
 const f=await resignationJourneyFixture();
 expect((await access(f.staff,f.journey.id)).offRun).toBe(false);
 await withTenant(f.staff,async tx=>{
  // This is the real server proof issuer and native begin adjudicator, not inserted runtime state.
  await prepareResignationProofTx(tx,f.staff,{operation:'begin',caseId:f.journey.id,revision:f.journey.revision,command:{type:'withdraw'},args:{}});
  const[row]=await tx.execute<{off:boolean;contract:boolean;unknown:boolean}>(sql`select app.automation_can_run('off',${f.journey.id}::uuid) as off,app.automation_can_run('contract_staff',${f.journey.id}::uuid) as contract,app.automation_can_run('off',${randomUUID()}::uuid) as unknown`);
  expect(row).toEqual({off:true,contract:false,unknown:false});
 });
 // No command was saved; neither another actor nor a later transaction inherits the intent.
 expect((await access(f.staff,f.journey.id)).offRun).toBe(false);
 expect((await access(f.admin,f.journey.id)).offRun).toBe(false);
 expect((await resignationCase(f.staff,f.journey.id)).revision).toBe(f.journey.revision);
},180_000);
it('refuses unknown subjects, other-tenant subjects and an unassigned command even with genuinely issued runtime claims',async()=>{
 const f=await resignationJourneyFixture(),other=await resignationJourneyFixture();
 for(const caseId of [randomUUID(),other.journey.id]){
  let refused:unknown;
  try{await withTenant(f.staff,tx=>prepareResignationProofTx(tx,f.staff,{operation:'begin',caseId,revision:f.journey.revision,command:{type:'withdraw'},args:{}}));}catch(error){refused=error;}
  expect(pgSqlState(refused)).toBe('42501');
 }
 let refused:unknown;
 try{await withTenant(f.watcher,tx=>prepareResignationProofTx(tx,f.watcher,{operation:'begin',caseId:f.journey.id,revision:f.journey.revision,command:{type:'withdraw'},args:{}}));}catch(error){refused=error;}
 expect(pgSqlState(refused)).toBe('42501');
 // The actor fields of a signed claim cannot nominate a different principal from the actual transaction.
 refused=undefined;
 try{await withTenant(f.staff,tx=>prepareResignationProofTx(tx,f.admin,{operation:'begin',caseId:f.journey.id,revision:f.journey.revision,command:{type:'withdraw'},args:{}}));}catch(error){refused=error;}
 expect(pgSqlState(refused)).toBe('42501');
 expect((await access(f.staff,f.journey.id)).offRun).toBe(false);
},180_000);
it('retains the native off journey target after genuine workflow queueing and a real delivery lease',async()=>{
 const origin='https://resignation-compat.example.test',f=await resignationJourneyFixture({decisionWorkflow:false,origin});
 await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+f.base.tenantId},${f.employeeUserId},${f.employeeUserId}::uuid)`);
 await f.workflow('submitted',[{id:'compat-notice',type:'notify',conditions:[],to:[{kind:'person',userId:f.employeeUserId}],cc:[],params:{subject:'Fictional native compatibility notice',body:'Your real resignation workflow is recorded.'}}]);
 await commandResignationJourney(f.admin,{caseId:f.journey.id,revision:f.journey.revision,command:{type:'runWorkflowsAgain'}});
 const[delivery]=await owner.db.execute<{id:string;createdBy:string;module:string;subjectId:string}>(sql`select id,created_by as "createdBy",module,subject_id as "subjectId" from automation_email_delivery where tenant_id=${f.base.tenantId}::uuid and module='off' and subject_id=${f.journey.id}::uuid and payload->'mail'->>'subject'='Fictional native compatibility notice'`);
 expect(delivery).toMatchObject({createdBy:f.managerUserId,module:'off',subjectId:f.journey.id});
 let inspected=0;let senderFailure:unknown;
 await deliverAutomationEmails({...f.admin,userId:undefined,personId:undefined,roles:[],grants:undefined},owner,async request=>{
  try{
  expect(request.deliveryId).toBe(delivery.id);inspected++;
  // The canonical sweep created the lease; owner use here is custody reads only, never forged delivery/proof.
  const [custody]=await owner.db.execute<{target:{id:string;tenantId:string;module:string;subjectId:string;bindings:{userId:string;issuer:string}[]}|null;unknown:unknown;wrongOrigin:unknown}>(sql`select
   app.automation_email_target(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${origin}) as target,
   app.automation_email_target(${randomUUID()}::uuid,${request.leaseToken}::uuid,${origin}) as unknown,
   app.automation_email_target(${request.deliveryId}::uuid,${request.leaseToken}::uuid,'https://unrelated-compat.example.test') as "wrongOrigin"`);
  expect(custody.target).toMatchObject({id:delivery.id,tenantId:f.base.tenantId,module:'off',subjectId:f.journey.id,bindings:[{userId:f.employeeUserId,issuer:origin+'/auth/'+f.base.tenantId}]});
  expect(custody.unknown).toBeNull();expect(custody.wrongOrigin).toBeNull();
  // No human transport is invoked and no claim of a sent email is manufactured.
  return {outcome:'skipped',error:'notEligible'};
  }catch(error){senderFailure=error;throw error;}
 });
 if(senderFailure)throw senderFailure;
 expect(inspected).toBe(1);
},180_000);
