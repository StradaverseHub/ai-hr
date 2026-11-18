/** Production-shaped regression: a saved, inactive candidate must survive a settings reload
 * when both its table and metadata reader have a non-bypass owner. No provider requests. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {getAiConfigView,saveAiProviderConfig} from '../core/ai-config';
import {readOpenRouterOptions} from '../lib/ai/providers/openrouter-configuration';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';

beforeAll(migrateTestDb);
afterAll(async()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();await closeAll();});
const policy='ai_provider_candidate_owner_presentation';
const migration=readFileSync(new URL('../db/migrations/6500_ai_provider_candidate_presentation_rls.sql',import.meta.url),'utf8');
it('reveals saved metadata only to its current tenant group admin without granting key or command access',async()=>{
 await resetDb();
 vi.stubEnv('AI_CONFIG_SECRET','fictional-candidate-presentation-secret');
 const network=vi.fn(async()=>{throw new Error('Provider calls are forbidden in a settings read');});
 vi.stubGlobal('fetch',network);
 const base=await seedBase(),foreign=await seedBase(),ctx=adminCtx(base);
 const routing=readOpenRouterOptions({version:1,routing:{allowedProviders:['openai'],allowFallbacks:false,sort:'latency'}});
 await saveAiProviderConfig(ctx,{provider:'openrouter',model:'fictional/saved-model',apiKey:'fixture-never-sent-key',providerOptions:routing});
 await saveAiProviderConfig(adminCtx(foreign),{provider:'openrouter',model:'fictional/other-tenant',apiKey:'foreign-never-sent-key',providerOptions:routing});
 const restricted='provider_display_'+randomUUID().replaceAll('-','');
 const [original]=await owner.db.execute<{tableOwner:string;viewOwner:string}>(sql`SELECT
  (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.ai_provider_candidate'::regclass) AS "tableOwner",
  (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='app.ai_provider_candidate_view_v1()'::regprocedure) AS "viewOwner"`);
 let roleCreated=false;
 try{
  await owner.db.transaction(async tx=>{
   await tx.execute(sql.raw(`CREATE ROLE ${restricted} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`));
   await tx.execute(sql.raw(`GRANT USAGE,CREATE ON SCHEMA public,app TO ${restricted}`));
   await tx.execute(sql.raw(`GRANT EXECUTE ON FUNCTION app.current_tenant_id(),app._ai_provider_evaluation_actor_valid(),app._ai_provider_presentation_actor_valid() TO ${restricted}`));
   await tx.execute(sql.raw(`ALTER TABLE public.ai_provider_candidate OWNER TO ${restricted}`));
   await tx.execute(sql.raw(`ALTER FUNCTION app.ai_provider_candidate_view_v1() OWNER TO ${restricted}`));
   await tx.execute(sql.raw(`DROP POLICY ${policy} ON public.ai_provider_candidate`));
  });
  roleCreated=true;
  const [security]=await owner.db.execute(sql`SELECT rolsuper,rolbypassrls,pg_has_role('ai_hr_app',oid,'MEMBER') AS member FROM pg_roles WHERE rolname=${restricted}`);
  expect(security).toEqual({rolsuper:false,rolbypassrls:false,member:false});
  const [guard]=await owner.db.execute(sql`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.ai_provider_candidate'::regclass`);
  expect(guard).toEqual({relrowsecurity:true,relforcerowsecurity:true});
  // The old policy silently returns no candidate, exactly like the production page.
  const before=await getAiConfigView(ctx);
  expect(before.providers.find(p=>p.provider==='openrouter')).toMatchObject({configured:false,candidateSaved:false});
  // Apply the actual append-only migration AS the restricted installation owner.
  await owner.db.transaction(async tx=>{
   await tx.execute(sql.raw(`SET LOCAL ROLE ${restricted}`));
   await tx.execute(sql.raw(migration));
  });
  const expected={configured:true,candidateSaved:true,isActive:false,model:'fictional/saved-model',keyLast4:'-key',providerOptions:routing};
  const after=await getAiConfigView(ctx);
  expect(after.providers.find(p=>p.provider==='openrouter')).toMatchObject(expected);
  expect(await getAiConfigView(ctx)).toEqual(after); // a second request retains the saved candidate
  const serialized=JSON.stringify(after);
  for(const secret of ['fixture-never-sent-key','foreign-never-sent-key','api_key_ciphertext','fictional/other-tenant'])expect(serialized).not.toContain(secret);
  expect((await getAiConfigView(adminCtx(foreign))).providers.find(p=>p.provider==='openrouter')).toMatchObject({candidateSaved:true,model:'fictional/other-tenant'});
  await expect(withTenant(ctx,tx=>tx.execute(sql`SELECT * FROM public.ai_provider_candidate`),{readOnlySnapshot:true})).rejects.toThrow();
  await expect(withTenant(ctx,tx=>tx.execute(sql`SELECT * FROM app.ai_provider_evaluation_candidate_v1('openrouter')`),{readOnlySnapshot:true})).rejects.toThrow();
  await expect(withTenant(ctx,tx=>tx.execute(sql`SELECT app.ai_provider_candidate_remove_v1()`),{readOnlySnapshot:true})).rejects.toThrow();
  await expect(withTenant(ctx,async tx=>{
   await tx.execute(sql`SELECT set_config('app.agent_principal_id',${randomUUID()},true)`);
   return tx.execute(sql`SELECT * FROM app.ai_provider_candidate_view_v1()`);
  },{readOnlySnapshot:true})).rejects.toThrow();
  // A real current company-scoped HR login and ordinary employee remain denied.
  for(const role of ['hr_admin','employee']){
   const [user]=await owner.db.execute<{id:string}>(sql`INSERT INTO app_user(tenant_id,workos_user_id) VALUES(${base.tenantId}::uuid,${'provider-display-'+randomUUID()}) RETURNING id`);
   await owner.db.execute(sql`INSERT INTO role_assignment(tenant_id,app_user_id,company_id,role) VALUES(${base.tenantId}::uuid,${user.id}::uuid,${role==='hr_admin'?base.companyId:null}::uuid,${role}::role)`);
   const denied:SessionContext={...ctx,userId:user.id,roles:[role],grants:[{role,companyId:role==='hr_admin'?base.companyId:null}]};
   await expect(withTenant(denied,tx=>tx.execute(sql`SELECT * FROM app.ai_provider_candidate_view_v1()`),{readOnlySnapshot:true})).rejects.toThrow();
  }
  await owner.db.execute(sql`DELETE FROM role_assignment WHERE tenant_id=${base.tenantId}::uuid AND app_user_id=${base.adminUserId}::uuid`);
  await expect(getAiConfigView(ctx)).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
 }finally{
  if(roleCreated)await owner.db.transaction(async tx=>{
   await tx.execute(sql`ALTER TABLE public.ai_provider_candidate OWNER TO ${sql.identifier(original.tableOwner)}`);
   await tx.execute(sql`ALTER FUNCTION app.ai_provider_candidate_view_v1() OWNER TO ${sql.identifier(original.viewOwner)}`);
   // Restore the current migrated schema even if the pre-fix assertion failed.
   await tx.execute(sql.raw(`DROP POLICY IF EXISTS ${policy} ON public.ai_provider_candidate`));
   await tx.execute(sql.raw(migration));
   await tx.execute(sql.raw(`DROP OWNED BY ${restricted}`));
   await tx.execute(sql.raw(`DROP ROLE ${restricted}`));
  });
 }
});
