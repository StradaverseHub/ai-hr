/** Native candidate storage and protocol custody with staging's non-bypass database-owner shape.
 * No provider call or HR writer. Ownership/role changes and all synthetic rows roll back together. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {saveOpenRouterCandidateTx,providerCandidatesTx} from '../core/ai-provider-readiness';
import {readOpenRouterOptions} from '../lib/ai/providers/openrouter-configuration';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();base=await seedBase();vi.stubEnv('AI_CONFIG_SECRET','fictional-restricted-provider-owner-key');});
afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});
it('upgrades forced-RLS custody and saves, reloads, evaluates and promotes through a restricted owner',async()=>{
 const ctx=adminCtx(base),role='provider_custody_'+randomUUID().replaceAll('-','');
 const rollback=new Error('rollback-provider-owner-fixture');let verified=false;
 try{await owner.withTenant(ctx,async tx=>{
  await tx.execute(sql.raw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`));
  await tx.execute(sql.raw(`GRANT USAGE,CREATE ON SCHEMA public,app TO ${role}`));
  const [ordinary]=await tx.execute<{id:string}>(sql`INSERT INTO public.app_user(tenant_id,workos_user_id)
   VALUES(${ctx.tenantId}::uuid,${'synthetic-provider-user-'+randomUUID()}) RETURNING id`);
  await tx.execute(sql`INSERT INTO public.role_assignment(tenant_id,app_user_id,company_id,role)
   VALUES(${ctx.tenantId}::uuid,${ordinary.id}::uuid,NULL,'employee')`);
  const [agent]=await tx.execute<{id:string}>(sql`INSERT INTO app.ai_agent_principal(tenant_id)
   VALUES(${ctx.tenantId}::uuid) ON CONFLICT(tenant_id) DO UPDATE SET tenant_id=excluded.tenant_id RETURNING id`);
  for(const table of ['ai_provider_candidate','ai_provider_protocol_evaluation','ai_provider_config'])
   await tx.execute(sql.raw(`ALTER TABLE public.${table} OWNER TO ${role}`));
  await tx.execute(sql.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`));
  await tx.execute(sql.raw(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ${role}`));
  const names=['_ai_provider_evaluation_actor_valid','ai_provider_candidate_view_v1','ai_provider_evaluation_candidate_v1',
   'ai_provider_candidate_save_v1','ai_provider_evaluation_record_v1','ai_provider_evaluation_consume_v1',
   'ai_provider_candidate_promote_v1','ai_provider_candidate_remove_v1'];
  const functions=await tx.execute<{signature:string}>(sql`SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app'
   AND p.proname=ANY(ARRAY[${sql.join(names.map(name=>sql`${name}`),sql`, `)}]::text[])`);
  expect(functions).toHaveLength(names.length);
  for(const fn of functions)await tx.execute(sql.raw(`ALTER FUNCTION ${fn.signature} OWNER TO ${role}`));
  const [security]=await tx.execute(sql`SELECT rolsuper,rolbypassrls,pg_has_role('ai_hr_app',oid,'MEMBER') AS app_member
   FROM pg_roles WHERE rolname=${role}`);
  expect(security).toEqual({rolsuper:false,rolbypassrls:false,app_member:false});
  for(const table of ['ai_provider_candidate','ai_provider_protocol_evaluation']){
   const [guard]=await tx.execute(sql`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=${'public.'+table}::regclass`);
   expect(guard).toEqual({relrowsecurity:true,relforcerowsecurity:true});
  }
  // Rehearse the exact append-only SQL against the pre-fix state, even when the full journal
  // already installed it. This proves both the native failure and correction in one transaction.
  await tx.execute(sql`DROP POLICY IF EXISTS ai_provider_candidate_owner_custody ON public.ai_provider_candidate`);
  await tx.execute(sql`DROP POLICY IF EXISTS ai_provider_protocol_evaluation_owner_custody ON public.ai_provider_protocol_evaluation`);
  await tx.execute(sql`SET LOCAL ROLE ai_hr_app`);
  const routing=readOpenRouterOptions({version:1,routing:{allowedProviders:['openai'],allowFallbacks:false,sort:'latency'}});
  await expect(tx.transaction(attempt=>attempt.execute(sql`SELECT app.ai_provider_candidate_save_v1(
   'fictional/owner-model','synthetic-ciphertext-never-sent','sent',${JSON.stringify(routing)}::jsonb)`)))
   .rejects.toMatchObject({cause:expect.objectContaining({code:'42501'})});
  await tx.execute(sql`RESET ROLE`);
  const migration=readFileSync(new URL('../db/migrations/0686_ai_provider_custody_owner_rls.sql',import.meta.url),'utf8');
  for(const statement of migration.split('--> statement-breakpoint'))await tx.execute(sql.raw(statement));
  await tx.execute(sql`SET LOCAL ROLE ai_hr_app`);
  const id=await saveOpenRouterCandidateTx(tx,ctx,{model:'fictional/owner-model',apiKey:'fixture-never-sent-key',providerOptions:routing});
  const [saved]=await providerCandidatesTx(tx,ctx);
  expect(saved).toMatchObject({id,model:'fictional/owner-model',keyLast4:'-key'});
  expect(JSON.stringify(saved)).not.toContain('fixture-never-sent-key');
  await saveOpenRouterCandidateTx(tx,ctx,{model:'fictional/edited-model',providerOptions:routing});
  const [edited]=await providerCandidatesTx(tx,ctx);expect(edited.model).toBe('fictional/edited-model');expect(edited.version).not.toBe(saved.version);
  // These are synthetic SQL issuer fixtures, not evidence of a hosted provider evaluation.
  const evaluation=randomUUID(),fingerprint='a'.repeat(64),principal='b'.repeat(64);
  const summary={calls:3,elapsedMs:1,usageReportedCalls:3,inputTokens:0,outputTokens:0,cachedInputTokens:0,accountChargeCredits:null};
  const proof=await tx.execute(sql`SELECT * FROM app.ai_provider_evaluation_record_v1(${evaluation}::uuid,${id}::uuid,
   ${edited.version}::uuid,${fingerprint},${principal},${JSON.stringify(summary)}::jsonb)`);
  expect(proof).toHaveLength(1);
  for(const table of ['ai_provider_candidate','ai_provider_protocol_evaluation'])
   await expect(tx.transaction(attempt=>attempt.execute(sql.raw(`SELECT * FROM public.${table}`)))).rejects.toThrow();
  // A different tenant and missing principal remain denied by issuers.
  for(const patch of [{tenant:randomUUID(),user:ctx.userId!},{tenant:ctx.tenantId,user:''}]){
   await expect(tx.transaction(async attempt=>{
    await attempt.execute(sql`SELECT set_config('app.tenant_id',${patch.tenant},true),set_config('app.user_id',${patch.user},true)`);
    await attempt.execute(sql`SELECT * FROM app.ai_provider_candidate_view_v1()`);
   })).rejects.toThrow();
  }
  await expect(tx.transaction(async attempt=>{
   await attempt.execute(sql`RESET ROLE`);
   await attempt.execute(sql`DELETE FROM public.role_assignment WHERE tenant_id=${ctx.tenantId}::uuid AND app_user_id=${ctx.userId!}::uuid`);
   await attempt.execute(sql`SET LOCAL ROLE ai_hr_app`);
   await attempt.execute(sql`SELECT * FROM app.ai_provider_candidate_view_v1()`);
  })).rejects.toThrow();
  for(const identity of [
   {user:ordinary.id,roles:'employee',grants:JSON.stringify([{role:'employee',companyId:null}]),agent:''},
   {user:'',roles:'',grants:'[]',agent:agent.id},
  ]){
   const restore=new Error('rollback-custody-negative-context');
   try{await tx.transaction(async scope=>{
    await scope.execute(sql`SELECT set_config('app.user_id',${identity.user},true),set_config('app.roles',${identity.roles},true),
     set_config('app.grants',${identity.grants},true),set_config('app.agent_principal_id',${identity.agent},true)`);
    // Verify a genuine current tenant principal before testing the provider-specific denial.
    if(identity.agent){const [current]=await scope.execute(sql`SELECT app.current_agent_principal() AS id`);expect(current.id).toBe(agent.id);}
    else{const [current]=await scope.execute(sql`SELECT app.principal_snapshot_current() AS valid`);expect(current.valid).toBe(true);}
    await expect(scope.transaction(attempt=>attempt.execute(sql`SELECT * FROM app.ai_provider_candidate_view_v1()`))).rejects.toThrow();
    await expect(scope.transaction(attempt=>attempt.execute(sql`SELECT app.ai_provider_candidate_save_v1(
     'fictional/forbidden','synthetic-ciphertext-never-sent','sent',${JSON.stringify(routing)}::jsonb)`))).rejects.toThrow();
    await expect(scope.transaction(attempt=>attempt.execute(sql`SELECT * FROM app.ai_provider_evaluation_record_v1(
     ${randomUUID()}::uuid,${id}::uuid,${edited.version}::uuid,${fingerprint},${principal},${JSON.stringify(summary)}::jsonb)`))).rejects.toThrow();
    throw restore;
   });}catch(error){if(error!==restore)throw error;}
  }
  const [consumed]=await tx.execute(sql`SELECT app.ai_provider_evaluation_consume_v1(${evaluation}::uuid,${fingerprint},${principal}) AS id`);
  expect(consumed.id).toBe(evaluation);
  const [promoted]=await tx.execute(sql`SELECT app.ai_provider_candidate_promote_v1(${evaluation}::uuid) AS id`);
  expect(promoted.id).toEqual(expect.any(String));
  await expect(tx.transaction(attempt=>attempt.execute(sql`SELECT app.ai_provider_evaluation_consume_v1(${evaluation}::uuid,${fingerprint},${principal})`))).rejects.toThrow();
  const [live]=await tx.execute(sql`SELECT provider::text,model,is_active FROM public.ai_provider_config`);
  expect(live).toMatchObject({provider:'openrouter',model:'fictional/edited-model',is_active:true});
  verified=true;throw rollback;
 });}catch(error){if(error!==rollback)throw error;}
 expect(verified).toBe(true);
 expect(await owner.db.execute(sql`SELECT rolname FROM pg_roles WHERE rolname=${role}`)).toHaveLength(0);
});
