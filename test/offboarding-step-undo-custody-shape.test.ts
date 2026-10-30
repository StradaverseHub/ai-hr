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
 const rows=await owner.db.execute<{name:string;bytes:number;occurrences:number}>(sql`with predicates as materialized(select conname,pg_get_expr(conbin,conrelid) as expression from pg_constraint where conrelid='app.assistant_own_leave_review'::regclass and contype='c') select conname as name,octet_length(expression)::int bytes,((length(expression)-length(replace(expression,'lifecycle.offboarding.step.undo','')))/length('lifecycle.offboarding.step.undo'))::int occurrences from predicates where expression like '%lifecycle.offboarding.step.undo%' order by conname`);
 console.info('[lifecycle constraint sizes]',Array.from(rows));expect(rows).toHaveLength(4);for(const row of rows){expect(row.occurrences,row.name).toBe(1);expect(row.bytes,row.name).toBeGreaterThan(0);expect(row.bytes,row.name).toBeLessThanOrEqual(6932534+2048);}
});
