/** Fake driver mechanics only. Native projection behavior also runs against real hosted fixture SQL. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readNativeLedger,readOwnedNativeLedger,FOCUSED_NATIVE_DATABASES,retainNativeLedgerForController} from './native-ledger-reader.mjs';
const tenantId = '11111111-1111-4111-8111-111111111111';
function database(rows) {
  const calls = [];
  return {calls, client: {begin: async (mode, work) => {
    calls.push({mode});
    const tx=async(strings,...values)=>{calls.push({sql:strings.join('?'),values});return [];};
    tx.unsafe=async(sql,values)=>{calls.push({sql,values});return rows;};
    return work(tx);
  }}};
}
test('reads all native runs in the independent tenant under a bounded read-only transaction', async () => {
  const rows = [{runId:'not-a-complete-verifier-fixture'}],db=database(rows);
  assert.deepEqual(await readNativeLedger(db.client,{tenantId,maxAttempts:2}),rows);
  assert.equal(db.calls[0].mode,'read only');
  const projection=db.calls.find(row=>row.sql?.includes('from public.ai_model_run'));
  assert.deepEqual(projection.values,[tenantId,3]);
  assert.match(projection.sql,/left join app.ai_spend_reservation/);
  assert.doesNotMatch(projection.sql,/m\.id\s*=|run_id\s+in|confirmed_nanos\s*>/i);
});
test('overflow refuses instead of presenting a truncated ledger as complete', async () => {
  const db=database([{},{}]);
  await assert.rejects(readNativeLedger(db.client,{tenantId,maxAttempts:1}),/ledger unavailable/);
});
test('invalid tenant or unbounded population refuses before any database operation', async () => {
  for(const scope of [{tenantId:'bad',maxAttempts:1},{tenantId,maxAttempts:0},{tenantId,maxAttempts:1501}]){
    const db=database([]);await assert.rejects(readNativeLedger(db.client,scope));assert.equal(db.calls.length,0);
  }
});
test('driver failure is not a successful empty or zero-cost ledger', async () => {
  await assert.rejects(readNativeLedger({begin:async()=>{throw Error('fictional offline');}},{tenantId,maxAttempts:1}),/offline/);
});

const identity={GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1'};
const image=readFileSync(new URL('../postgres.sh',import.meta.url),'utf8').match(/postgres:16@sha256:[a-f0-9]{64}/)[0];
function transport(inspect={Config:{Image:image,Labels:{'aihr-owner':'aihr-ci-123-1-db-1'}},State:{Running:true},HostConfig:{NetworkMode:'host'}},rows=[]){
 const calls=[];
 return {calls,execute:(file,args,options)=>{calls.push({file,args,options});return {status:0,stdout:JSON.stringify(args[0]==='inspect'?inspect:typeof rows==='function'?rows(args):args.includes(FOCUSED_NATIVE_DATABASES[0])?rows:[])};}};
}
test('controller readback uses only absolute Docker and owned pinned SQL client, ignoring candidate dependency paths',()=>{
 const fake=transport(undefined,[{runId:'fictional'}]);
 assert.deepEqual(readOwnedNativeLedger({tenantId,maxAttempts:2},{...identity,NODE_PATH:'/candidate/fake-postgres',NODE_OPTIONS:'--require=/candidate/invent-rows.cjs',PATH:'/candidate/bin'},fake.execute),[{runId:'fictional'}]);
 assert.equal(fake.calls.length,3);
 for(const row of fake.calls){assert.equal(row.file,'/usr/bin/docker');assert.deepEqual(row.options.env,{PATH:'/usr/bin:/bin'});}
 const command=fake.calls[1];assert.ok(command.args.includes('--no-psqlrc'));assert.ok(command.args.includes(FOCUSED_NATIVE_DATABASES[0]));assert.ok(fake.calls[2].args.includes(FOCUSED_NATIVE_DATABASES[1]));
 assert.match(command.options.input,/BEGIN READ ONLY/);assert.match(command.options.input,/where m.tenant_id=:'tenant_id'/);
 assert.doesNotMatch(command.options.input,/candidate|run_id\s+in/i);
});
test('wrong image, foreign owner or stopped database refuses before SQL execution',()=>{
 for(const change of [v=>v.Config.Image='unreviewed:image',v=>v.Config.Labels['aihr-owner']='foreign',v=>v.State.Running=false]){
  const record={Config:{Image:image,Labels:{'aihr-owner':'aihr-ci-123-1-db-1'}},State:{Running:true},HostConfig:{NetworkMode:'host'}};change(record);
  const fake=transport(record);assert.throws(()=>readOwnedNativeLedger({tenantId,maxAttempts:1},identity,fake.execute));assert.equal(fake.calls.length,1);
 }
});
test('controller rejects truncated readback and malformed execution identity',()=>{
 const fake=transport(undefined,[{},{}]);assert.throws(()=>readOwnedNativeLedger({tenantId,maxAttempts:1},identity,fake.execute));
 const untouched=transport();assert.throws(()=>readOwnedNativeLedger({tenantId,maxAttempts:1},{...identity,GITHUB_RUN_ID:'../foreign'},untouched.execute));assert.equal(untouched.calls.length,0);
});

test('one combined ledger bound applies across both workers; missing second worker is not an empty ledger',()=>{
 const combined=transport(undefined,()=>[{}]);
 assert.throws(()=>readOwnedNativeLedger({tenantId,maxAttempts:1},identity,combined.execute),/ledger unavailable/);
 assert.equal(combined.calls.length,3);
 const missing=transport();
 const execute=(file,args,options)=>args.includes(FOCUSED_NATIVE_DATABASES[1])?{status:1,stderr:'fictional missing database'}:missing.execute(file,args,options);
 assert.throws(()=>readOwnedNativeLedger({tenantId,maxAttempts:2},identity,execute),/ledger unavailable/);
});
const retained={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',
 GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_WORKFLOW:'alpha-focused-checks',TEST_DB_NAMESPACE:'aifocus',VITEST_MAX_WORKERS:'2',
 AIHR_EVAL_RETAIN_NATIVE_LEDGER:'true',AIHR_EVAL_REQUESTED:'true',AIHR_EVAL_MODEL:'openai/gpt-6-luna',AIHR_EVAL_PATH:'production',
 AIHR_EVAL_PLAN_HASH:'a'.repeat(64),AIHR_EVAL_CORPUS_REVIEW_DIGEST:'b'.repeat(64),AIHR_CI_HEAD:'c'.repeat(40),AIHR_CI_CONTROL_HEAD:'d'.repeat(40),
 AIHR_FOCUSED_TESTS:JSON.stringify(['test/assistant-model-ceiling.eval.test.ts'])};
test('ordinary teardown remains unchanged; admitted focused retention only defers disposable cleanup',()=>{
 assert.equal(retainNativeLedgerForController({}),false);
 assert.equal(retainNativeLedgerForController({...retained,AIHR_EVAL_RETAIN_NATIVE_LEDGER:undefined}),false);
 assert.equal(retainNativeLedgerForController(retained),true);
});
for(const change of [{GITHUB_ACTIONS:'false'},{CI:'false'},{RUNNER_ENVIRONMENT:'self-hosted'},{GITHUB_RUN_ATTEMPT:'2'},
 {GITHUB_REPOSITORY:'foreign/repo'},{GITHUB_WORKFLOW:'release'},{TEST_DB_NAMESPACE:''},{VITEST_MAX_WORKERS:'1'},{WORKER_DB:'0'},
 {AIHR_EVAL_REQUESTED:'false'},{AIHR_EVAL_MODEL:'unapproved'},{AIHR_EVAL_PATH:'harness'},{AIHR_EVAL_PLAN_HASH:''},
 {AIHR_EVAL_CORPUS_REVIEW_DIGEST:''},{AIHR_CI_HEAD:'bad'},{AIHR_CI_CONTROL_HEAD:'bad'},{AIHR_FOCUSED_TESTS:'[]'},
 {AIHR_FOCUSED_TESTS:JSON.stringify(['test/ordinary.test.ts'])}]) {
 test('retention refuses malformed or foreign intent: '+JSON.stringify(change),()=>{
  assert.throws(()=>retainNativeLedgerForController({...retained,...change}));
 });
}
