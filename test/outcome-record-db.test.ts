/** ADR-0170 step 5a — the outcome record over a real harness turn on fictional data (migration 0890).
 *
 *  1. A real turn's trace persists as one outcome record: authority, reads, checks with rule versions,
 *     replay, outcome, and the two new fields (human involvement, notice).
 *  2. Tenant isolation: another tenant neither reads nor writes it; inside a tenant only the asker and
 *     group administrators read it.
 *  3. A person records only their own turn; values that could carry prose or data are refused.
 *  4. Append-only: the app role has no UPDATE/DELETE/TRUNCATE privilege, and even the owner's UPDATE and
 *     DELETE are refused by the trigger. Later decisions, undo and notice are appended as follow-ups. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {terasOutcomeFollowup,terasOutcomeRecord} from '../db/teras-schema';
import {withTenant,type SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import {persistTurnTrace} from '../core/harness/trace-persistence';
import {OutcomeRecordRefused,listOutcomeRecords,recordOutcomeFollowup,writeOutcomeRecord} from '../core/outcome-record/record';
import {scriptedModel} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';

let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-outcome-passphrase');await resetDb();base=await seedBase();for(const code of ['assistant','claims'])await setModule(base.tenantId,code,'active');});

async function person(b:Base,role:'employee'|'hr_admin',name:string):Promise<SessionContext>{
 const admin=adminCtx(b);
 const hired=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);await grantAssistant(admin,{appUserId:userId});
 return{...await entitledCtx(b,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]};
}
async function balanceTurn(ctx:SessionContext){
 return runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question:'How much annual leave do I have?',scope:{companyId:base.companyId,locale:'en'},
  model:scriptedModel([{calls:[{name:'my_leave_balances'}]},{final:{reply:'Your balance is shown on your leave page.',mode:'answer'}}]),memory:new InMemoryTaskMemoryStore()});
}
const pgText=(error:unknown)=>{const parts:string[]=[];for(let cur=error as Record<string,unknown>|undefined,n=0;cur&&typeof cur==='object'&&n<5;cur=cur.cause as never,n++)
 for(const key of ['message','detail'])if(typeof cur[key]==='string')parts.push(cur[key] as string);return parts.join(' | ');};
async function refusedWith(promise:Promise<unknown>,pattern:RegExp){const error=await promise.then(()=>null,(e:unknown)=>e);expect(error,'expected a refusal').not.toBeNull();expect(pgText(error)).toMatch(pattern);}
const minimal=(askedByUserId:string)=>({runId:randomUUID(),runKind:'turn' as const,startedAt:new Date(),finishedAt:new Date(),authority:{kind:'person' as const,askedByUserId},
 agentIdentity:'teras.assistant',reads:[],checks:[],replay:{model:null,provider:null,instructionSet:null,specVersion:null,specDigest:null,toolCatalogue:null},
 outcomeKind:'answered' as const,outcome:{},humanInvolvement:'none' as const,notice:'not_applicable' as const});

describe('outcome record',()=>{
 it('persists a real harness turn as one record with authority, reads, rule versions, replay and the two new fields',async()=>{
  await seedEntitlement(adminCtx(base),{leaveTypeId:base.annualLeaveTypeId,annualDays:14,validFrom:'2020-01-01'});
  const employee=await person(base,'employee','Fictional Outcome Employee');
  const turn=await balanceTurn(employee);
  expect(turn.trace.calls[0]).toMatchObject({tool:'my_leave_balances',status:'ok'});
  const written=await persistTurnTrace(employee,turn.trace,{companyId:base.companyId});
  expect(written.runId).toBe(turn.trace.turnId);
  const [record]=await listOutcomeRecords(employee);
  expect(record).toMatchObject({id:written.id,runKind:'turn',authorityKind:'person',askedByUserId:employee.userId,mandateId:null,grantorUserId:null,
   agentIdentity:'teras.assistant',companyId:base.companyId,outcomeKind:'answered',humanInvolvement:'none',notice:'not_applicable',
   effectiveHumanInvolvement:'none',effectiveNotice:'not_applicable',decision:null});
  expect(record.reads).toEqual([{tool:'my_leave_balances',status:'ok',argumentsDigest:turn.trace.calls[0].argumentsDigest}]);
  const specLabel=`harness_spec:v${turn.trace.spec.version}#${turn.trace.spec.digest.slice(0,16)}`;
  expect(record.checks.map(check=>check.check)).toEqual(['turn_gate','non_blank','destination_links','overclaim','identifiers']);
  expect(record.checks.every(check=>check.ruleVersion===specLabel)).toBe(true);
  expect(record.replay).toEqual({model:'fictional/scripted-model',provider:'fictional',instructionSet:specLabel,specVersion:String(turn.trace.spec.version),
   specDigest:turn.trace.spec.digest,toolCatalogue:expect.stringMatching(/^offered:[a-f0-9]{16}$/)});
  expect(record.trace).toMatchObject({kind:'teras.turn-trace',turnId:turn.trace.turnId});
  // References and names only: the reply text never enters the record.
  expect(JSON.stringify(record)).not.toContain('Your balance is shown');
 });

 it('isolates tenants and, inside a tenant, shows a record only to the asker and group administrators',async()=>{
  const employee=await person(base,'employee','Fictional Asker');
  const colleague=await person(base,'employee','Fictional Colleague');
  const hr=await person(base,'hr_admin','Fictional Group Administrator');
  const turn=await balanceTurn(employee);await persistTurnTrace(employee,turn.trace);
  expect(await listOutcomeRecords(employee)).toHaveLength(1);
  expect(await listOutcomeRecords(colleague)).toHaveLength(0);
  expect(await listOutcomeRecords(hr)).toHaveLength(1);
  const other=await seedBase();for(const code of ['assistant','claims'])await setModule(other.tenantId,code,'active');
  const foreignAdmin={...await entitledCtx(other,['hr_admin']),userId:other.adminUserId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
  expect(await listOutcomeRecords(foreignAdmin)).toHaveLength(0);
  // Another tenant's session cannot write into this tenant, even naming this tenant's ids.
  await refusedWith(withTenant(foreignAdmin,tx=>tx.insert(terasOutcomeRecord).values({...minimalRow(employee.userId!),tenantId:base.tenantId})),/row-level security/i);
  // The same session id in the wrong tenant context sees nothing.
  expect(await withTenant({...employee,tenantId:other.tenantId},tx=>tx.select().from(terasOutcomeRecord))).toEqual([]);
 });

 it('records only the caller\'s own turn and refuses values that could carry prose or data',async()=>{
  const employee=await person(base,'employee','Fictional Recorder');
  const colleague=await person(base,'employee','Fictional Other Person');
  await expect(writeOutcomeRecord(employee,minimal(colleague.userId!))).rejects.toThrow(OutcomeRecordRefused);
  await refusedWith(withTenant(employee,tx=>tx.insert(terasOutcomeRecord).values(minimalRow(colleague.userId!))),/row-level security/i);
  await expect(writeOutcomeRecord(employee,{...minimal(employee.userId!),outcome:{reply:'x'.repeat(500)}})).rejects.toThrow(OutcomeRecordRefused);
  await expect(writeOutcomeRecord(employee,{...minimal(employee.userId!),outcome:{nested:{deep:'value'}} as never})).rejects.toThrow(OutcomeRecordRefused);
  await expect(writeOutcomeRecord(employee,{...minimal(employee.userId!),reads:[{tool:'my_leave_balances',status:'ok',refs:['Siti binti Fictional has 14 days']}]})).rejects.toThrow(OutcomeRecordRefused);
  await expect(writeOutcomeRecord(employee,{...minimal(employee.userId!),authority:{kind:'mandate',mandateId:randomUUID(),mandateVersion:1,grantorUserId:employee.userId!},runKind:'mandate_run'})).rejects.toThrow(OutcomeRecordRefused);
  const ok=await writeOutcomeRecord(employee,minimal(employee.userId!));expect(ok.id).toMatch(/^[0-9a-f-]{36}$/);
 });

 it('is append-only for every role, with decisions, undo and notice appended as follow-ups',async()=>{
  const employee=await person(base,'employee','Fictional Append Only');
  const hr=await person(base,'hr_admin','Fictional Append Admin');
  const {id}=await writeOutcomeRecord(employee,{...minimal(employee.userId!),outcomeKind:'suggested',outcome:{suggestion:'leave.apply'}});
  await refusedWith(withTenant(hr,tx=>tx.update(terasOutcomeRecord).set({outcomeKind:'done'}).where(eq(terasOutcomeRecord.id,id))),/permission denied/i);
  await refusedWith(withTenant(hr,tx=>tx.delete(terasOutcomeRecord).where(eq(terasOutcomeRecord.id,id))),/permission denied/i);
  await refusedWith(withTenant(hr,tx=>tx.execute(sql`truncate teras_outcome_record`)),/permission denied/i);
  await refusedWith(owner.db.update(terasOutcomeRecord).set({outcomeKind:'done'}).where(eq(terasOutcomeRecord.id,id)),/append-only/i);
  await refusedWith(owner.db.delete(terasOutcomeRecord).where(eq(terasOutcomeRecord.id,id)),/append-only/i);
  const privileges=await owner.db.execute(sql`select has_table_privilege('ai_hr_app','public.teras_outcome_record','INSERT') as can_insert,
   has_table_privilege('ai_hr_app','public.teras_outcome_record','UPDATE') as can_update,has_table_privilege('ai_hr_app','public.teras_outcome_record','DELETE') as can_delete,
   has_table_privilege('ai_hr_app','public.teras_outcome_record','TRUNCATE') as can_truncate,(select relrowsecurity from pg_class where oid='public.teras_outcome_record'::regclass) as rls`);
  expect(privileges[0]).toEqual({can_insert:true,can_update:false,can_delete:false,can_truncate:false,rls:true});
  // A colleague cannot append to someone else's record.
  const colleague=await person(base,'employee','Fictional Follow-up Stranger');
  await expect(recordOutcomeFollowup(colleague,{kind:'decision',recordId:id,decision:'accepted',humanInvolvement:'decided'})).rejects.toThrow();
  await recordOutcomeFollowup(employee,{kind:'decision',recordId:id,decision:'accepted',humanInvolvement:'decided',reference:{proposal:randomUUID()}});
  await recordOutcomeFollowup(hr,{kind:'notice',recordId:id,notice:'given',channel:'in_app'});
  const followups=await owner.db.select().from(terasOutcomeFollowup).where(eq(terasOutcomeFollowup.recordId,id));
  await refusedWith(owner.db.update(terasOutcomeFollowup).set({decision:'rejected'}).where(eq(terasOutcomeFollowup.id,followups[0].id)),/append-only/i);
  await refusedWith(withTenant(employee,tx=>tx.insert(terasOutcomeFollowup).values({tenantId:base.tenantId,recordId:id,kind:'mandate_completion',decision:'completed',humanInvolvement:'none'})),/row-level security|violates check/i);
  const [view]=await listOutcomeRecords(employee);
  expect(view).toMatchObject({humanInvolvement:'none',notice:'not_applicable',effectiveHumanInvolvement:'decided',effectiveNotice:'given',decision:'accepted'});
  expect(view.followups).toHaveLength(2);
  await recordOutcomeFollowup(employee,{kind:'undo',recordId:id});
  expect((await listOutcomeRecords(employee))[0].decision).toBe('undone');
 });
});

function minimalRow(askedByUserId:string){
 return{tenantId:base.tenantId,runId:randomUUID(),runKind:'turn' as const,startedAt:new Date(),finishedAt:new Date(),authorityKind:'person' as const,askedByUserId,
  agentIdentity:'teras.assistant',reads:[],checks:[],replay:{model:null,provider:null,instructionSet:null,specVersion:null,specDigest:null,toolCatalogue:null},
  outcomeKind:'answered' as const,outcome:{},humanInvolvement:'none' as const,notice:'not_applicable' as const};
}
