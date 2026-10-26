/** Authored UNRUN. Actual canonical import/event custody, fictional data; no provider or benefit proof. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {withTenant} from '../db/client';
import {beginEmployeeImportEvaluation,employeeImportEvaluationInputDigest,reopenEmployeeImportEvaluation,recordEmployeeImportEvaluationTelemetry,claimEmployeeImportEvaluationTx,completeEmployeeImportEvaluationTx} from '../core/personnel-import-evaluation';
import {preparePersonnelImportAssistanceTx,claimPersonnelImportAssistanceTx,completePersonnelImportAssistanceTx} from '../core/personnel-import-assistance-store';
import {personnelImportHeaderDigests} from '../lib/personnel-import-assistance.server';
import {commitEmployeeImport} from '../core/import';
import {EmployeeImportEvaluationBeginSchema,EmployeeImportEvaluationTelemetrySchema,type EmployeeImportEvaluationBinding} from '../lib/personnel-import-evaluation';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;beforeAll(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-evaluation-secret-01234567890123456789');await migrateTestDb();});beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(async()=>{await closeAll();vi.unstubAllEnvs();});
const ctx=()=>adminCtx(b);
function inputs(){return{companyId:b.companyId,records:[{full_name:'Fictional Evaluation Person',email:randomUUID()+'@fixture.test',department:'Finance',hired_on:'2026-01-05',ic_number:'900101105566',basic_salary:'5000',employment_type:'full_time',employee_code:'EVAL-001'}]};}
const metadata=()=>({version:1,companyId:b.companyId,operationNonce:randomUUID(),cohortId:randomUUID(),mode:'baseline',sourceRevision:'a'.repeat(64),adoptedHeaderAttemptId:null,associationHumanConfirmed:false});
const binding=(r:{attemptId:string;attemptVersion:1}):EmployeeImportEvaluationBinding=>({attemptId:r.attemptId,attemptVersion:r.attemptVersion});
const state=()=>owner.db.execute(sql`select id from public.employment order by id`);
it('records the exact canonical committed event/counts atomically and replays the same measured import without another employee/event/history row',async()=>{
 const p=inputs(),m=metadata(),prepared=await beginEmployeeImportEvaluation(ctx(),p,m);expect(prepared).toMatchObject({state:'prepared',canonicalCounts:null,accounting:{associatedRuns:0,accountCostCredits:null,providerReportedTokens:null}});
 const result=await commitEmployeeImport(ctx(),{...p,evaluationBinding:binding(prepared)});expect(result.imported,JSON.stringify(result)).toBe(1);expect(result.evaluationReceipt).toMatchObject({state:'committed',canonicalCounts:{imported:1,failed:0,skipped:0,dependents:0,qualification:0,emergency:0}});
 const [stored]=await owner.db.execute<{event_id:string}>(sql`select event_id from public.employee_import_evaluation_attempt where id=${prepared.attemptId}::uuid`),[event]=await owner.db.execute<{event_type:string}>(sql`select event_type from public.domain_event where id=${stored.event_id}::uuid`);expect(event.event_type).toBe('employee-import.completed');
 const before={employees:await state(),events:await owner.db.execute(sql`select id from public.domain_event order by id`),history:await owner.db.execute(sql`select id from public.employee_import_run order by id`)};
 const replay=await commitEmployeeImport(ctx(),{...p,evaluationBinding:binding(prepared)});expect(replay.imported).toBe(1);expect(replay.evaluationReceipt?.attemptId).toBe(prepared.attemptId);expect(await state()).toEqual(before.employees);expect(await owner.db.execute(sql`select id from public.domain_event order by id`)).toEqual(before.events);expect(await owner.db.execute(sql`select id from public.employee_import_run order by id`)).toEqual(before.history);
 const reopened=await reopenEmployeeImportEvaluation(ctx(),binding(prepared),b.companyId);expect(reopened.canonicalCounts?.imported).toBe(1);expect(reopened.serverCommitMilliseconds).toBeGreaterThanOrEqual(0);
 const raw=await owner.db.execute(sql`select * from public.employee_import_evaluation_attempt where id=${prepared.attemptId}::uuid`);for(const value of ['Fictional Evaluation Person',p.records[0].email,'900101105566','a'.repeat(64),employeeImportEvaluationInputDigest(p)])expect(JSON.stringify(raw)).not.toContain(value);
});
it('rolls all real employee effects and exact completion event back if measurement persistence fails',async()=>{
 const p=inputs(),prepared=await beginEmployeeImportEvaluation(ctx(),p,metadata()),before=await state();
 await owner.db.execute(sql`create function public.fixture_evaluation_refusal() returns trigger language plpgsql as $$begin if new.state='committed' then raise exception 'fictional evaluation refusal';end if;return new;end$$`);await owner.db.execute(sql`create trigger fixture_evaluation_refusal before update on public.employee_import_evaluation_attempt for each row execute function public.fixture_evaluation_refusal()`);
 try{const result=await commitEmployeeImport(ctx(),{...p,evaluationBinding:binding(prepared)});expect(result.imported).toBe(0);expect(result.fileErrors.length).toBeGreaterThan(0);expect(result.evaluationReceipt).toBeUndefined();expect(await state()).toEqual(before);expect(await owner.db.execute(sql`select id from public.domain_event where event_type='employee-import.completed'`)).toHaveLength(0);const reopened=await reopenEmployeeImportEvaluation(ctx(),binding(prepared),b.companyId);expect(reopened.state).toBe('prepared');expect(reopened.canonicalCounts).toBeNull();}finally{await owner.db.execute(sql`drop trigger fixture_evaluation_refusal on public.employee_import_evaluation_attempt`);await owner.db.execute(sql`drop function public.fixture_evaluation_refusal()`);}
});
it('binds normalized actual input independently of file labels and refuses retargeted inputs, foreign scope, old events and erased identities',async()=>{
 const p=inputs(),m=metadata(),prepared=await beginEmployeeImportEvaluation(ctx(),p,m),before=await state();
 expect(employeeImportEvaluationInputDigest({...p,records:[Object.fromEntries(Object.entries(p.records[0]).reverse())]})).toBe(employeeImportEvaluationInputDigest(p));
 await expect(beginEmployeeImportEvaluation(ctx(),{...p,records:[{...p.records[0],full_name:'Retargeted'}]},m)).rejects.toThrow();
 await expect(commitEmployeeImport(ctx(),{...p,records:[{...p.records[0],email:'changed@fixture.test'}],evaluationBinding:binding(prepared)})).rejects.toThrow();expect(await state()).toEqual(before);
 const unmeasured=await commitEmployeeImport(ctx(),p);expect(unmeasured.imported).toBe(1);const [event]=await owner.db.execute<{id:string}>(sql`select id from public.domain_event where event_type='employee-import.completed'`);
 await expect(withTenant(ctx(),async tx=>{await claimEmployeeImportEvaluationTx(tx,ctx(),binding(prepared),p);await completeEmployeeImportEvaluationTx(tx,ctx(),binding(prepared),b.companyId,event.id,{imported:1,failed:0,skipped:0,dependents:0,qualification:0,emergency:0});})).rejects.toThrow();
 const foreign=await seedBase();await expect(reopenEmployeeImportEvaluation(adminCtx(foreign),binding(prepared),b.companyId)).rejects.toThrow();
 await withTenant(ctx(),tx=>tx.execute(sql`delete from public.employee_import_evaluation_attempt where id=${prepared.attemptId}::uuid`));const after=await state();await expect(commitEmployeeImport(ctx(),{...p,evaluationBinding:binding(prepared)})).rejects.toThrow();expect(await state()).toEqual(after);expect(await owner.db.execute(sql`select id from public.employee_import_evaluation_attempt`)).toHaveLength(0);
});
it('keeps reported effort/quality separate, permits honest zero, and deduplicates exact telemetry nonces',async()=>{
 const prepared=await beginEmployeeImportEvaluation(ctx(),inputs(),metadata()),value={nonce:randomUUID(),stage:{kind:'outcome',origin:'unknown',verifiedCommittedRows:null,errorRows:null,duplicateRows:null,reworkRows:null},humanHandling:{milliseconds:null,origin:'unknown'}};
 const first=await recordEmployeeImportEvaluationTelemetry(ctx(),binding(prepared),b.companyId,value),second=await recordEmployeeImportEvaluationTelemetry(ctx(),binding(prepared),b.companyId,value);expect(second.observations).toEqual(first.observations);expect(second.observations).toHaveLength(1);expect(second.canonicalCounts).toBeNull();expect(second.serverCommitMilliseconds).toBeNull();
 await expect(recordEmployeeImportEvaluationTelemetry(ctx(),binding(prepared),b.companyId,{...value,humanHandling:{milliseconds:0,origin:'client_focus_reported'}})).rejects.toThrow();
 const reported=await recordEmployeeImportEvaluationTelemetry(ctx(),binding(prepared),b.companyId,{nonce:randomUUID(),stage:{kind:'correction',mappingChanges:1,editedRows:0,reason:'mapping'},humanHandling:{milliseconds:0,origin:'human_attested'}});expect(reported.observations).toHaveLength(2);expect(reported.observations[1].reported.humanHandling).toEqual({milliseconds:0,origin:'human_attested'});
 expect(()=>EmployeeImportEvaluationTelemetrySchema.parse({...value,stage:{...value.stage,verifiedCommittedRows:10}})).toThrow();expect(()=>EmployeeImportEvaluationBeginSchema.parse({...metadata(),runId:randomUUID()})).toThrow();
});

it.each([0,null])('links an explicitly associated actual own header run with honest charge %s, without causal attribution or header-retention dependence',async cost=>{
 const headings=[{columnIndex:0,heading:'Full name'}],digests=personnelImportHeaderDigests(headings),headerInput={companyId:b.companyId,operationNonce:randomUUID(),...digests,inputDigest:'b'.repeat(64),headerIndexes:[0],mode:'ai' as const,consent:{headersReviewed:true as const,sendHeadingsOnly:true}};
 const prepared=await withTenant(ctx(),tx=>preparePersonnelImportAssistanceTx(tx,ctx(),headerInput)),headerBinding={attemptId:prepared.attemptId,attemptVersion:prepared.attemptVersion,companyId:b.companyId,sourceRevision:digests.sourceRevision,registryDigest:digests.registryDigest,inputDigest:headerInput.inputDigest};let runId='';
 await withTenant(ctx(),async tx=>{const [r]=await tx.execute<{run_id:string;allowed:boolean}>(sql`select * from app.ai_admit('personnel_import_mapping','draft','openrouter','fictional/header-model',100,false)`);expect(r.allowed).toBe(true);runId=r.run_id;await claimPersonnelImportAssistanceTx(tx,ctx(),headerBinding,runId);});
 await withTenant(ctx(),tx=>tx.execute(sql`select app.ai_settle_observed(${runId}::uuid,true,13,'reported',8,3,2,${cost}::numeric,4)`));
 await withTenant(ctx(),tx=>completePersonnelImportAssistanceTx(tx,ctx(),headerBinding,{version:1,sourceRevision:digests.sourceRevision,registryDigest:digests.registryDigest,mappings:[{columnIndex:0,status:'mapped',field:'full_name'}]}));
 const m={...metadata(),mode:'assisted',adoptedHeaderAttemptId:prepared.attemptId,associationHumanConfirmed:true},evaluation=await beginEmployeeImportEvaluation(ctx(),inputs(),m);expect(evaluation).toMatchObject({mode:'assisted',association:'human_confirmed',accounting:{associatedRuns:1,accountCostCredits:cost,unit:cost===null?null:'openrouter_account_credits',providerReportedTokens:13,attribution:'associated_run_unallocated'}});expect(JSON.stringify(evaluation)).not.toContain(runId);
 await withTenant(ctx(),tx=>tx.execute(sql`delete from public.personnel_import_assistance_attempt where id=${prepared.attemptId}::uuid`));expect((await reopenEmployeeImportEvaluation(ctx(),binding(evaluation),b.companyId)).accounting).toEqual(evaluation.accounting);
 await expect(beginEmployeeImportEvaluation(ctx(),inputs(),{...metadata(),mode:'assisted',adoptedHeaderAttemptId:prepared.attemptId,associationHumanConfirmed:true})).rejects.toThrow();
});
