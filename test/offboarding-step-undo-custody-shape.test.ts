/** Focused actual-ledger shape and bounded predicate proof on the held development stack. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,afterEach,it,expect,vi} from 'vitest';
import * as s from '../db/schema';
import type {SessionContext} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import {grantAssistant} from '../core/assistant-grant';
import {createOffboardingCase,tickStep} from '../packs/lifecycle/service';
import {offboardingStepUndoReviews} from '../core/assistant-actions/offboarding-step-undo-review-store';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,caseId:string,caseNumber:string;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-offboarding-shape-key-123456789');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await setModule(b.tenantId,'lifecycle','active');const userId=await createAppUser(b.tenantId,null,'employee');await owner.db.insert(s.lcStaff).values({tenantId:b.tenantId,userId,companyId:b.companyId,level:'manager'});await grantAssistant(adminCtx(b),{appUserId:userId});ctx={tenantId:b.tenantId,userId,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}],entitlements:harnessSnapshot(b.tenantId)};const c=await createOffboardingCase(adminCtx(b),{companyId:b.companyId,fullName:'Fictional shape subject',employeeNo:'F-'+randomUUID().slice(0,8),resignationDate:'2026-10-01'});caseId=c.id;caseNumber=c.number;await tickStep(ctx,'offboarding',caseNumber,'resign_submit');});
it('rejects foreign dedicated/generic hybrid columns and loss of true case/company scope',async()=>{
 const result=await offboardingStepUndoReviews.prepare(ctx,{caseId,caseNumber,stepKey:'resign_submit',reason:null,confirmUndo:true,acceptCaseReopening:false});const id=result.review.actionId;
 for(const column of ['knowledge_article_id','decision_request_id','testing_execution_id','payroll_close_batch_id','country_statutory_id','receipt_subject_id','offboarding_completion_event_id']){
  let error:unknown;try{await owner.db.execute(sql`update app.assistant_own_leave_review set ${sql.identifier(column)}=${randomUUID()}::uuid where id=${id}::uuid`);}catch(cause){error=cause;}expect(pgSqlState(error),column).toBe('23514');
 }
 for(const column of ['company_id','lifecycle_case_id']){let error:unknown;try{await owner.db.execute(sql`update app.assistant_own_leave_review set ${sql.identifier(column)}=null where id=${id}::uuid`);}catch(cause){error=cause;}expect(pgSqlState(error),column).toBe('23514');}
 const [row]=await owner.db.execute(sql`select state,(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);expect(row).toMatchObject({state:'awaiting_confirmation',bodies:1});
});
it('records actual finite predicate sizes and exactly one new-kind branch in each necessary constraint',async()=>{
 const bounded=['assistant_own_leave_review_check','assistant_own_leave_review_check16','assistant_review_kind_columns','assistant_offboarding_step_undo_columns'].sort();
 // The shared effect/version guard also names both actions; it is NOT a fourth inherited extension.
 const rows=await owner.db.execute<{name:string;validated:boolean;bytes:number;occurrences:number}>(sql`with predicates as materialized(select conname,convalidated,pg_get_expr(conbin,conrelid) as expression from pg_constraint where conrelid='app.assistant_own_leave_review'::regclass and contype='c') select conname as name,convalidated as validated,octet_length(expression)::int bytes,((length(expression)-length(replace(expression,'lifecycle.offboarding.step.undo','')))/length('lifecycle.offboarding.step.undo'))::int occurrences from predicates where expression like '%lifecycle.offboarding.step.undo%' order by conname`);
 expect(rows.map(row=>row.name)).toEqual([...bounded,'assistant_step_effect_columns'].sort());
 const extensions=rows.filter(row=>bounded.includes(row.name));expect(extensions.map(row=>row.name)).toEqual(bounded);
 console.info('[lifecycle constraint sizes]',Array.from(rows));for(const row of extensions){expect(row.validated,row.name).toBe(true);expect(row.occurrences,row.name).toBe(1);expect(row.bytes,row.name).toBeGreaterThan(0);expect(row.bytes,row.name).toBeLessThanOrEqual(6932534+2048);}
 // Independent canonical predicate, parsed by the same PostgreSQL deparser. No whitespace/boolean
 // normalization that could erase a state test, foreign-kind null guard or commitment format.
 await owner.db.transaction(async tx=>{
  const tableName='expected_step_effect_'+randomUUID().replaceAll('-',''),table=sql.identifier(tableName);
  await tx.execute(sql`create temporary table ${table}(action_kind text,state text,offboarding_step_effect_commitment text,offboarding_step_case_version text,offboarding_step_version text,
   constraint expected_step_effect check(case when action_kind in ('lifecycle.offboarding.step.complete','lifecycle.offboarding.step.undo') then
    ((state='awaiting_confirmation')=(offboarding_step_effect_commitment is not null))
    and (offboarding_step_effect_commitment is null or offboarding_step_effect_commitment ~ '^[a-f0-9]{64}$')
    and ((state='completed')=(offboarding_step_case_version is not null)) and ((state='completed')=(offboarding_step_version is not null))
    and (offboarding_step_case_version is null or offboarding_step_case_version ~ '^[0-9]+$')
    and (offboarding_step_version is null or offboarding_step_version ~ '^[0-9]+$')
    else offboarding_step_effect_commitment is null and offboarding_step_case_version is null and offboarding_step_version is null end)) on commit drop`);
  const expectedTable='pg_temp.'+tableName;
  const [expected]=await tx.execute<{expression:string}>(sql`select pg_get_expr(conbin,conrelid) as expression from pg_constraint where conrelid=to_regclass(${expectedTable}) and conname='expected_step_effect' and contype='c' and convalidated`);
  const [actual]=await tx.execute<{expression:string;validated:boolean}>(sql`select pg_get_expr(conbin,conrelid) as expression,convalidated as validated from pg_constraint where conrelid='app.assistant_own_leave_review'::regclass and conname='assistant_step_effect_columns' and contype='c'`);
  expect(expected?.expression.length).toBeGreaterThan(0);expect(actual?.validated).toBe(true);expect(actual?.expression).toBe(expected.expression);
  const shared=rows.find(row=>row.name==='assistant_step_effect_columns')!;expect(shared.occurrences).toBe(1);expect(shared.bytes).toBeGreaterThan(0);expect(shared.bytes).toBeLessThanOrEqual(8192);
 });
});
