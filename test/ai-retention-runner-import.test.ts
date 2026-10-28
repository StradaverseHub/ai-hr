/** Isolated process/import boundary only: fake bounds then fake ownership refusal, no sockets or DB calls.
 * The fake answers the bounds probe so the refusal is the actual ownership guard, not an earlier throw. */
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe,expect,it} from 'vitest';
const message='AI retention maintenance could not be confirmed.';
const fictional='postgres://fixture_owner:FICTIONAL_NEVER_CONNECT@127.0.0.1:1/fixture';
const runner=resolve('scripts/ai-retention-runner.ts');
function isolatedEnv(){const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'production'};delete env.DATABASE_URL;delete env.MIGRATION_DATABASE_URL;delete env.NODE_OPTIONS;return env;}
describe('operator retention runner independent import boundary',()=>{
 it('imports the real runner without DATABASE_URL and reaches its actual ownership refusal using only a fake transaction',()=>{
  const env=isolatedEnv();env.MIGRATION_DATABASE_URL=fictional;
  const script=`
   const loaded=await import(${JSON.stringify(pathToFileURL(runner).href)});
   const run=loaded.runAiRetentionTick??loaded.default?.runAiRetentionTick;
   if(typeof run!=='function'||process.env.DATABASE_URL!==undefined)throw Error('owned import boundary failed');
   const orm=await import('drizzle-orm/pg-core');const dialect=new orm.PgDialect();
   let queries=0,transactions=0;
   const owner={db:{transaction:async(fn,options)=>{transactions++;
    if(options?.isolationLevel!=='read committed')throw Error('owned isolation boundary failed');
    return fn({execute:async(statement)=>{queries++;const rendered=dialect.sqlToQuery(statement),query=rendered.sql;
     // First the non-increasing local bounds, then the ownership proof: reach the REAL guard refusal.
     if(queries===1){if(!query.includes('pg_catalog.pg_settings'))throw Error('owned bounds boundary failed');return [{name:'lock_timeout',value:'500'},{name:'statement_timeout',value:'5000'}];}
     if(!query.includes('current_user=session_user')||!query.includes('pg_catalog.pg_roles')||!query.includes('app.assistant_transcripts_retire_expired(uuid,integer,integer)')
      ||!rendered.params.includes('public.assistant_exchange')||!rendered.params.includes('public.ai_assistant_answer_evaluation_intent'))throw Error('owned guard boundary failed');
     guarded=true;return [{allowed:false}];}});
   }}};
   let rejected=false,guarded=false;try{await run(owner);}catch(error){if(error?.message!==${JSON.stringify(message)})throw Error('owned bounded refusal failed');rejected=true;}
   if(!rejected||!guarded||queries!==2||transactions!==1)throw Error('owned refusal evidence missing');
   process.stdout.write('OWNED_GUARD_REFUSED\\n');
  `;
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{env,cwd:process.cwd(),encoding:'utf8',timeout:15000,maxBuffer:65536});
  expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status).toBe(0);expect(result.stdout).toBe('OWNED_GUARD_REFUSED\n');expect(result.stderr).toBe('');
  expect(result.stdout+result.stderr).not.toContain(fictional);
 });
 it.each(['absent','app-only'] as const)('missing operator credential (%s) exits with one bounded error and no URL, app fallback or raw import stack',mode=>{
  const env=isolatedEnv();if(mode==='app-only')env.DATABASE_URL=fictional;
  const result=spawnSync(process.execPath,['--import','tsx',runner],{env,cwd:process.cwd(),encoding:'utf8',timeout:15000,maxBuffer:65536});
  expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status).toBe(1);expect(result.stdout).toBe('');expect(result.stderr).toBe(message+'\n');expect(result.stderr).not.toContain(fictional);expect(result.stderr).not.toContain('DATABASE_URL is not set');expect(result.stderr).not.toContain(' at ');
 });
});
