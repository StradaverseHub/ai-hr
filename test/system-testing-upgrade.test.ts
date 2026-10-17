/** Genuine pre0557 tables/observations -> complete on-disk0557 inside an owner transaction.
 * No trigger bypass. Reconstruction and upgrade roll back even on assertion failure. UNRUN. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase } from './harness';
const read = (name: string) => readFileSync(resolve(process.cwd(),'db/migrations',name),'utf8');
const upgrade = read('0557_versioned_system_testing.sql');
const legacy = read('0482_system_testing.sql');
const historicalPolicies = ['0093_feedback_module.sql','0318_feedback_plan_revision.sql','0323_feedback_block_answer.sql'].flatMap(name => [...read(name).matchAll(/CREATE POLICY feedback_(?:request|attachment|plan_revision|block)[\s\S]*?;/g)].map(m => m[0]));
const visibilityPolicies = [...read('0515_set_based_visibility.sql').matchAll(/ALTER POLICY "feedback_(?:request|attachment|plan_revision|block)[\s\S]*?;/g)].map(m => m[0]);
beforeAll(migrateTestDb); beforeEach(resetDb); afterAll(closeAll);
it('preserves actual pre-upgrade identity/history, publishes only the current baseline and never backfills prior instruction truth', async () => {
  const b = await seedBase(), caseId = randomUUID(), runId = randomUUID(), rollback = new Error('rollback-only-upgrade-proof');
  const reporter=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional legacy reporter',primaryEmail:'legacy-retention@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const appFeedback=randomUUID(),ownerFeedback=randomUUID(),appRun=randomUUID(),ownerRun=randomUUID();
  let observed = false;
  expect(historicalPolicies).toHaveLength(8); expect(visibilityPolicies.length).toBeGreaterThan(0);
  try { await owner.db.transaction(async tx => {
    // Remove only0557-owned objects, then recreate the genuine retained0482 tables and pre0557 policies.
    const names = [...upgrade.matchAll(/CREATE FUNCTION app\.([a-z_]+)\(/g)].map(m => m[1]);
    const functions = await tx.execute(sql`SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname=ANY(ARRAY[${sql.join(names.map(n => sql`${n}`),sql`, `)}]::text[]) ORDER BY p.oid`) as unknown as { signature: string }[];
    expect(functions.length).toBe(names.length);
    for (const f of functions) await tx.execute(sql.raw('DROP FUNCTION IF EXISTS '+f.signature+' CASCADE'));
    for (const table of ['test_execution_attachment','test_catalogue_update','test_run','test_execution','test_assignment','test_case_version','test_case']) await tx.execute(sql.raw('DROP TABLE IF EXISTS public.'+table+' CASCADE'));
    const remainingPolicies = await tx.execute(sql`SELECT tablename,policyname FROM pg_policies WHERE schemaname='public' AND tablename IN ('feedback_request','feedback_attachment','feedback_plan_revision','feedback_block') ORDER BY tablename,policyname`) as unknown as { tablename: string; policyname: string }[];
    for (const p of remainingPolicies) await tx.execute(sql.raw('DROP POLICY "'+p.policyname.replaceAll('"','""')+'" ON public."'+p.tablename+'"'));
    await tx.execute(sql`ALTER TABLE public.feedback_request DROP CONSTRAINT feedback_reporter_identity_ck,ALTER COLUMN reporter_employment_id SET NOT NULL`);
    await tx.execute(sql`ALTER TABLE public.feedback_attachment ALTER COLUMN employment_id SET NOT NULL`);
    for (const statement of historicalPolicies.concat(visibilityPolicies)) await tx.execute(sql.raw(statement));
    for (const statement of legacy.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) await tx.execute(sql.raw(statement));
    await tx.execute(sql`SELECT set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${b.adminUserId},true),set_config('app.roles','hr_admin',true),set_config('app.grants','[{"role":"hr_admin","companyId":null}]',true)`);
    await tx.execute(sql`SET LOCAL ROLE ai_hr_app`);
    const [principal] = await tx.execute(sql`SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`) as unknown as { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[];
    expect(principal).toEqual({ current_user: 'ai_hr_app',rolsuper: false,rolbypassrls: false });
    await tx.execute(sql`INSERT INTO public.test_case(id,tenant_id,case_no,module_code,title,steps,expected_behavior,created_by_user_id) VALUES(${caseId}::uuid,${b.tenantId}::uuid,7,'cross_module','Fictional original guide','["Original observed step"]'::jsonb,'Original expected result',${b.adminUserId}::uuid)`);
    await tx.execute(sql`INSERT INTO public.test_run(id,tenant_id,test_case_id,run_no,outcome,actual_result,run_by_user_id) VALUES(${runId}::uuid,${b.tenantId}::uuid,${caseId}::uuid,3,'pass','Original observed result',${b.adminUserId}::uuid)`);
    // The pre-upgrade owner permits script changes; this later current guide cannot become past truth.
    await tx.execute(sql`UPDATE public.test_case SET title='Fictional current guide',steps='["Current step"]'::jsonb WHERE id=${caseId}::uuid`);
    // Same historic guide, with one independently changed field per control: old subset hashes collide.
    for(const [offset,precondition,testType,priority] of [[1,'Different prerequisite','functional','medium'],[2,null,'security','medium'],[3,null,'functional','high']] as const){
      await tx.execute(sql`INSERT INTO public.test_case(tenant_id,case_no,module_code,title,precondition,steps,test_type,priority,expected_behavior,created_by_user_id) VALUES(${b.tenantId}::uuid,${7+offset},'cross_module','Fictional current guide',${precondition},'["Current step"]'::jsonb,${testType},${priority},'Original expected result',${b.adminUserId}::uuid)`);
    }
    for(const [feedbackId,observationId,runNo] of [[appFeedback,appRun,4],[ownerFeedback,ownerRun,5]] as const){
      await tx.execute(sql`INSERT INTO public.feedback_request(id,tenant_id,reporter_employment_id,reporter_user_id,category,title,description) VALUES(${feedbackId}::uuid,${b.tenantId}::uuid,${reporter.employmentId}::uuid,${b.adminUserId}::uuid,'issue','Fictional linked legacy finding','Retained legacy observation evidence')`);
      await tx.execute(sql`INSERT INTO public.test_run(id,tenant_id,test_case_id,run_no,outcome,actual_result,run_by_user_id,feedback_request_id) VALUES(${observationId}::uuid,${b.tenantId}::uuid,${caseId}::uuid,${runNo},'fail','Retained fictional failure',${b.adminUserId}::uuid,${feedbackId}::uuid)`);
    }
    const [beforeRun] = await tx.execute(sql`SELECT to_jsonb(r) AS value FROM public.test_run r WHERE id=${runId}::uuid`) as unknown as { value: Record<string,unknown> }[];
    await tx.execute(sql`RESET ROLE`);
    for (const statement of upgrade.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) await tx.execute(sql.raw(statement));
    const [caseRow] = await tx.execute(sql`SELECT c.id,c.case_no,c.current_version_id,v.ordinal,v.provenance,v.definition FROM public.test_case c JOIN public.test_case_version v ON v.id=c.current_version_id WHERE c.id=${caseId}::uuid`) as unknown as { id: string; case_no: number; current_version_id: string; ordinal: number; provenance: string; definition: unknown }[];
    expect(caseRow).toMatchObject({ id: caseId,case_no: 7,ordinal: 1,provenance: 'upgrade_baseline',definition: { format: 0,history: 'upgrade_baseline',title: 'Fictional current guide',steps: ['Current step'] } });
    const [afterRun] = await tx.execute(sql`SELECT to_jsonb(r)-ARRAY['version_id','execution_id','execution_revision','execution_status','comments','defect_notes','improvement_notes']::text[] AS value,version_id,execution_id FROM public.test_run r WHERE id=${runId}::uuid`) as unknown as { value: Record<string,unknown>; version_id: string|null; execution_id: string|null }[];
    expect(afterRun).toEqual({ value: beforeRun.value,version_id: null,execution_id: null });
    const [count] = await tx.execute(sql`SELECT count(*)::integer AS n FROM public.test_case_version WHERE test_case_id=${caseId}::uuid`) as unknown as { n: number }[]; expect(count.n).toBe(1);
    const baselineHashes=await tx.execute(sql`SELECT v.content_hash,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v.definition::text,'UTF8')),'hex') AS full_hash,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(jsonb_build_object('title',c.title,'module',c.module_code,'steps',c.steps,'expectedBehavior',c.expected_behavior,'expectedFunction',c.expected_function)::text,'UTF8')),'hex') AS old_subset_hash
      FROM public.test_case_version v JOIN public.test_case c ON c.id=v.test_case_id WHERE v.tenant_id=${b.tenantId}::uuid ORDER BY c.case_no`) as unknown as {content_hash:string;full_hash:string;old_subset_hash:string}[];
    expect(baselineHashes).toHaveLength(4);expect(new Set(baselineHashes.map(row=>row.old_subset_hash)).size).toBe(1);
    expect(new Set(baselineHashes.map(row=>row.content_hash)).size).toBe(4);for(const row of baselineHashes)expect(row.content_hash).toBe(row.full_hash);
    const [retainedBefore]=await tx.execute(sql`SELECT to_jsonb(r)-'feedback_request_id' AS value FROM public.test_run r WHERE id=${appRun}::uuid`) as unknown as {value:unknown}[];
    await tx.execute(sql`SET LOCAL ROLE ai_hr_app`);
    const [appPrincipal]=await tx.execute(sql`SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`) as unknown as {current_user:string;rolsuper:boolean;rolbypassrls:boolean}[];
    expect(appPrincipal).toEqual({current_user:'ai_hr_app',rolsuper:false,rolbypassrls:false});
    for(const update of [
      sql`UPDATE public.test_run SET feedback_request_id=NULL WHERE id=${appRun}::uuid`,
      sql`UPDATE public.test_run SET feedback_request_id=${ownerFeedback}::uuid WHERE id=${appRun}::uuid`,
      sql`UPDATE public.test_run SET actual_result='Forbidden rewrite',feedback_request_id=NULL WHERE id=${appRun}::uuid`,
    ]){
      try{await tx.transaction(async nested=>{await nested.execute(update);});throw new Error('Direct legacy observation mutation unexpectedly succeeded');}
      catch(error){expect(pgSqlState(error)).toBe('23514');}
    }
    // The ordinary authorized parent DELETE performs its actual nested FK action, not a direct UPDATE.
    await tx.execute(sql`DELETE FROM public.feedback_request WHERE id=${appFeedback}::uuid`);
    const [appRetained]=await tx.execute(sql`SELECT to_jsonb(r)-'feedback_request_id' AS value,feedback_request_id FROM public.test_run r WHERE id=${appRun}::uuid`) as unknown as {value:unknown;feedback_request_id:null}[];
    expect(appRetained).toEqual({value:retainedBefore.value,feedback_request_id:null});
    await tx.execute(sql`RESET ROLE`);
    await tx.execute(sql`SELECT set_config('app.tenant_id','',true),set_config('app.user_id','',true),set_config('app.roles','',true),set_config('app.grants','[]',true)`);
    const [noContext]=await tx.execute(sql`SELECT app.current_tenant_id() AS tenant,app.current_user_id() AS actor`) as unknown as {tenant:null;actor:null}[];
    expect(noContext).toEqual({tenant:null,actor:null});
    // An owner has no app context and still cannot invoke cleanup via an ordinary direct UPDATE.
    try{await tx.transaction(async nested=>{await nested.execute(sql`UPDATE public.test_run SET feedback_request_id=NULL WHERE id=${ownerRun}::uuid`);});throw new Error('Direct owner pointer clearing unexpectedly succeeded');}
    catch(error){expect(pgSqlState(error)).toBe('42501');}
    const [ownerBefore]=await tx.execute(sql`SELECT to_jsonb(r)-'feedback_request_id' AS value FROM public.test_run r WHERE id=${ownerRun}::uuid`) as unknown as {value:unknown}[];
    await tx.execute(sql`DELETE FROM public.feedback_request WHERE id=${ownerFeedback}::uuid`);
    const [ownerRetained]=await tx.execute(sql`SELECT to_jsonb(r)-'feedback_request_id' AS value,feedback_request_id FROM public.test_run r WHERE id=${ownerRun}::uuid`) as unknown as {value:unknown;feedback_request_id:null}[];
    expect(ownerRetained).toEqual({value:ownerBefore.value,feedback_request_id:null});
    const [parents]=await tx.execute(sql`SELECT count(*)::int AS n FROM public.feedback_request WHERE id IN (${appFeedback}::uuid,${ownerFeedback}::uuid)`) as unknown as {n:number}[];expect(parents.n).toBe(0);
    observed = true; throw rollback;
  }); } catch (error) { if (error !== rollback) throw error; }
  expect(observed).toBe(true);
});
