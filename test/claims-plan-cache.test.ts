/** Isolated, reversible experiment: change no migration, policy or installation. */
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {closeAll,migrateTestDb,owner} from './harness';
import {runClaimsLoad} from './fixtures/claims-load';
beforeAll(migrateTestDb);afterAll(closeAll);
it('compares repeated permission planning against a connection-local cached plan',async()=>{
 const out=process.env.AIHR_FOCUSED_EVIDENCE_DIR!;expect(out).toBeTruthy();
 const [definition]=await owner.client`select pg_get_functiondef('app.visible_employment_ids()'::regprocedure)as original,prosrc as body from pg_proc where oid='app.visible_employment_ids()'::regprocedure`;
 const body=readFileSync(new URL('../db/migrations/0726_claim_history_order.sql',import.meta.url),'utf8').split('AS $$')[1].split('$$;')[0].trim().replace(/;$/,'');
 try{
  await owner.client.unsafe(`CREATE OR REPLACE FUNCTION app.visible_employment_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $baseline$ ${body} $baseline$`);
  await runClaimsLoad('-cache-baseline');
  // PostgreSQL caches a PL/pgSQL expression's plan per connection. Only the plan is retained;
  // current principal, grants and date are evaluated afresh, never cached as authorization results.
  await owner.client.unsafe(`CREATE OR REPLACE FUNCTION app.visible_employment_ids() RETURNS uuid[]
   LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $plan_cache$
   BEGIN RETURN (${body}); END;
   $plan_cache$`);
  await runClaimsLoad('-cache-candidate');
  await owner.client.unsafe(`CREATE OR REPLACE FUNCTION app.visible_employment_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $baseline$ ${body} $baseline$`);
  await runClaimsLoad('-cache-baseline-after');
 }finally{await owner.client.unsafe(definition.original);}
 const result={kind:'REVERSIBLE_DEVELOPMENT_EXPERIMENT',releaseEligible:false,
  baselineAfter:JSON.parse(readFileSync(join(out,'claims-500-sessions-cache-baseline-after.json'),'utf8')),
  baseline:JSON.parse(readFileSync(join(out,'claims-500-sessions-cache-baseline.json'),'utf8')),
  candidate:JSON.parse(readFileSync(join(out,'claims-500-sessions-cache-candidate.json'),'utf8'))};
 writeFileSync(join(out,'claims-plan-cache-comparison.json'),JSON.stringify(result,null,2));
 expect(result.candidate.phases.paced.errors).toBe(0);
},480000);
