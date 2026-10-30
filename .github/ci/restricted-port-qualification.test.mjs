/** Dependency-free controller regressions; no candidate import, driver, role or database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {restrictedPortRequest,fixedQualificationArgs,executeDatabaseSetup,FIXED_ENTRY,REQUIRED_DB_FILES,SOURCE_PINS} from './restricted-port-qualification.mjs';
test('default and explicitfalse retain ordinary setup',()=>{for(const flag of [undefined,'false']){assert.equal(restrictedPortRequest(flag,{NODB:[],DB:[]},undefined),false);const calls=[];executeDatabaseSetup(false,Object.fromEntries(['reset','before','migrate','after'].map(key=>[key,()=>calls.push(key)])));assert.deepEqual(calls,['reset','migrate']);}});
test('exact opt-in requires genuine DB ownership files plus whole compiler',()=>{assert.equal(restrictedPortRequest('true',{DB:[...REQUIRED_DB_FILES],NODB:[]},'true'),true);for(const groups of [{DB:[],NODB:[...REQUIRED_DB_FILES]},{DB:[REQUIRED_DB_FILES[0]],NODB:[]},{DB:['test/unrelated.test.ts'],NODB:[]},{DB:[...REQUIRED_DB_FILES,'test/extra.test.ts'],NODB:[]},{DB:[...REQUIRED_DB_FILES],NODB:['test/extra.test.ts']}])assert.throws(()=>restrictedPortRequest('true',groups,'true'));for(const tc of [undefined,'false','1'])assert.throws(()=>restrictedPortRequest('true',{DB:[...REQUIRED_DB_FILES]},tc));});
for(const flag of ['','1','TRUE','true;echo unsafe',true,false,{},[]])test('reject nonliteral opt-in '+JSON.stringify(flag),()=>assert.throws(()=>restrictedPortRequest(flag,{DB:[...REQUIRED_DB_FILES]},'true')));
test('fixed closed command has no caller command/path/URL parameter',()=>{assert.equal(FIXED_ENTRY,'scripts/qualify-restricted-port-prerequisites.ts');assert.deepEqual(fixedQualificationArgs('before','/tmp/owned/aihr-focused'),['--import','tsx',FIXED_ENTRY,'before','/tmp/owned/aihr-focused']);for(const phase of ['../after','before;echo unsafe','reset',''])assert.throws(()=>fixedQualificationArgs(phase,'/tmp/owned/aihr-focused'));for(const path of ['postgres://staging','/tmp/arbitrary','/tmp/../aihr-focused'])assert.throws(()=>fixedQualificationArgs('before',path));});
test('setup ordering is reset -> prehook -> native migration -> installedapp probe',()=>{const calls=[];executeDatabaseSetup(true,Object.fromEntries(['reset','before','migrate','after'].map(key=>[key,()=>calls.push(key)])));assert.deepEqual(calls,['reset','before','migrate','after']);});
for(const failed of ['reset','before','migrate','after'])test('failure at '+failed+' cannot continue or claim successful qualification',()=>{const calls=[],sentinel=Error(failed);assert.throws(()=>executeDatabaseSetup(true,Object.fromEntries(['reset','before','migrate','after'].map(key=>[key,()=>{calls.push(key);if(key===failed)throw sentinel;}]))),error=>error===sentinel);assert.deepEqual(calls,['reset','before','migrate','after'].slice(0,['reset','before','migrate','after'].indexOf(failed)+1));});
test('reviewed source pins are fixed paths and full hashes',()=>{assert.ok(Object.hasOwn(SOURCE_PINS,FIXED_ENTRY));assert.ok(Object.hasOwn(SOURCE_PINS,'scripts/fixtures/restricted-port-operator-v4/qualification-source-manifest.json'));for(const [path,sha]of Object.entries(SOURCE_PINS)){assert.match(path,/^(?:scripts|\.github\/ci)\/[A-Za-z0-9_./-]+$/);assert.match(sha,/^[a-f0-9]{64}$/);assert.ok(!path.split('/').includes('..'));}});

import {assertQualificationEnvironment,assertPrefix,assertAppliedLedger} from '../../scripts/lib/restricted-port-qualification.ts';
const validEnv={AIHR_QUALIFY_RESTRICTED_PORT:'true',GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW:'alpha-focused-checks',GITHUB_JOB:'selected-tests',TEST_DB_NAMESPACE:'aifocus',AIHR_FOCUSED_SUITE_CAPACITY:'true',GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-focused-checks.yml@refs/heads/codex/reviewed-controller',AIHR_CI_HEAD:'a'.repeat(40),AIHR_CI_CONTROL_HEAD:'b'.repeat(40),AIHR_CI_PG_PROFILE:'2',AIHR_CI_PG_CONFIGURED_CAP_BYTES:'2113929216',AIHR_CI_PG_PEAK_BUDGET_BYTES:'2147483648',AIHR_CI_PG_JIT:'on',VITEST_MAX_WORKERS:'2',DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev',MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_dev',TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test',TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test'};
test('candidate guard admits only exact disposed controller context (pure; no DB)',()=>assert.doesNotThrow(()=>assertQualificationEnvironment(validEnv,'a'.repeat(40),'linux')));
for(const [key,value] of Object.entries({...validEnv,GITHUB_RUN_ID:'invalid',GITHUB_RUN_ATTEMPT:'invalid'}))test('candidate refuses changed required '+key,()=>assert.throws(()=>assertQualificationEnvironment({...validEnv,[key]:value==='true'?'false':value==='2'?'4':'unexpected'},'a'.repeat(40),'linux')));
test('candidate refuses foreign host, database, password and params before connection',()=>{for(const url of ['postgres://postgres@staging:5433/ai_hr_dev','postgres://postgres@127.0.0.1:5432/ai_hr_dev','postgres://postgres@127.0.0.1:5433/sibling','postgres://postgres:secret@127.0.0.1:5433/ai_hr_dev','postgres://postgres@127.0.0.1:5433/ai_hr_dev?sslmode=disable'])assert.throws(()=>assertQualificationEnvironment({...validEnv,MIGRATION_DATABASE_URL:url},'a'.repeat(40),'linux'));assert.throws(()=>assertQualificationEnvironment(validEnv,'c'.repeat(40),'linux'));assert.throws(()=>assertQualificationEnvironment(validEnv,'a'.repeat(40),'darwin'));});
test('581 prefix checks full ordered hashes, not merely count/watermark (pure synthetic input)',()=>{const expected=Array.from({length:581},(_,i)=>({id:String(i+1),hash:'a'.repeat(64),created_at:i===580?'1793330000075':String(i+1)}));assert.doesNotThrow(()=>assertPrefix(expected,structuredClone(expected)));for(const mutation of [rows=>rows[0].hash='b'.repeat(64),rows=>rows.reverse(),rows=>rows.pop(),rows=>rows[10].created_at='wrong']){const rows=structuredClone(expected);mutation(rows);assert.throws(()=>assertPrefix(expected,rows));}});

import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {appliedMigrationExecution} from './restricted-port-history.mjs';
import {HISTORICAL_MIGRATIONS,appliedMigrationIdentity} from './migration-history.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const actualInstalled581=JSON.parse(readFileSync(new URL('../../scripts/fixtures/restricted-port-operator-v4/installed-ledger-581.json',import.meta.url),'utf8'));
for(const record of HISTORICAL_MIGRATIONS){
 test('real installed identity and EXECUTED bytes are authenticated archive for '+record.tag,()=>{
  const current=readFileSync(new URL('../../db/migrations/'+record.tag+'.sql',import.meta.url));
  const archive=readFileSync(new URL('./historical-migrations/'+record.tag+'.sql',import.meta.url));
  const chosen=appliedMigrationExecution(record.tag,record.when,current),installed=actualInstalled581.filter(row=>row.created_at===String(record.when));
  assert.equal(installed.length,1);assert.equal(installed[0].hash,record.appliedSha256);
  assert.equal(sha(current),record.currentSha256);assert.notEqual(sha(current),installed[0].hash);
  assert.deepEqual(chosen.sql,archive);assert.equal(sha(chosen.sql),installed[0].hash);assert.equal(chosen.identity.hash,installed[0].hash);
  assert.deepEqual(chosen.identity.historicalAppliedVersion,{originalCommit:record.originalCommit,originalSqlSha256:record.appliedSha256});
 });
 test('refuse actual historical source/timestamp/archive substitution for '+record.tag,()=>{
  const current=readFileSync(new URL('../../db/migrations/'+record.tag+'.sql',import.meta.url));
  assert.throws(()=>appliedMigrationExecution(record.tag,record.when+1,current));
  assert.throws(()=>appliedMigrationExecution(record.tag,record.when,Buffer.concat([current,Buffer.from(' ')])));
  assert.throws(()=>appliedMigrationIdentity(record.tag,record.when,current,{readArchive:()=>current}));
  assert.throws(()=>appliedMigrationIdentity(record.tag,record.when,current,{readArchive:()=>Buffer.from('-- forged original')}));
 });
}
test('ordinary execution keeps exact current bytes without fabricating historical metadata',()=>{
 const raw=Buffer.from('-- ordinary fixture only\nSELECT 1;\n'),chosen=appliedMigrationExecution('9999_fixture',1,raw);
 assert.deepEqual(chosen.sql,raw);assert.deepEqual(chosen.identity,{hash:sha(raw)});
});
test('legacy or mixed cap keys cannot silently qualify on the new profile',()=>{
 for(const other of [{AIHR_CI_PG_MEMORY_GIB:'2'},{AIHR_CI_PG_MEMORY_GIB:''},{AIHR_CI_PG_PROFILE:'legacy-2g'},{AIHR_CI_PG_CONFIGURED_CAP_BYTES:'2147483648'},{AIHR_CI_PG_PEAK_BUDGET_BYTES:'2113929216'},{AIHR_CI_PG_JIT:'off'}])assert.throws(()=>assertQualificationEnvironment({...validEnv,...other},'a'.repeat(40),'linux'));
});

test('real gapped581 IDs are retained as observed evidence, not fabricated into disposable allocation history',()=>{
 assert.equal(actualInstalled581.length,581);assert.equal(actualInstalled581[162].id,'199');assert.equal(actualInstalled581.at(-1).id,'618');
 const disposable=actualInstalled581.map((row,i)=>({...row,id:String(i+1)}));
 assert.notDeepEqual(disposable,actualInstalled581);assert.doesNotThrow(()=>assertPrefix(actualInstalled581,disposable));assert.equal(actualInstalled581[162].id,'199');
 for(const mutate of [rows=>rows.reverse(),rows=>rows[162].hash='0'.repeat(64),rows=>rows[162].created_at=String(BigInt(rows[162].created_at)+1n),rows=>rows[162].id=rows[161].id,rows=>rows[162].id='0',rows=>rows[162].id='-1',rows=>rows[162].id='1']){const rows=structuredClone(disposable);mutate(rows);assert.throws(()=>assertPrefix(actualInstalled581,rows));}
 // General post-tail comparison uses the same applied identity owner and physical-ID rules.
 assert.doesNotThrow(()=>assertAppliedLedger(actualInstalled581.map(({hash,created_at})=>({hash,created_at})),disposable));
});
