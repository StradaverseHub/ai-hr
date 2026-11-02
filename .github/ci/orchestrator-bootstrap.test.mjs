import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {inspectOrchestratorBootstrap} from './orchestrator-bootstrap.mjs';
function fixture(){
 const head='a'.repeat(40),controller='b'.repeat(40),workspace='/home/runner/work/ai-hr/ai-hr',temp='/home/runner/work/_temp';
 const env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW:'ai-orchestrator-walkthrough',GITHUB_JOB:'production-renderer',GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',AIHR_CI_HEAD:head,AIHR_CI_CONTROL_HEAD:controller,GITHUB_SHA:controller,GITHUB_WORKSPACE:workspace,RUNNER_TEMP:temp,GITHUB_EVENT_PATH:temp+'/_github_workflow/event.json',GITHUB_REF:'refs/heads/codex/fixture',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/ai-orchestrator-walkthrough.yml@refs/heads/codex/fixture',TEST_DB_NAMESPACE:'orchbrowser23',AIHR_CI_UNIT:'db-1',NODE_ENV:'development',AIHR_CI_PG_PROFILE:'2',AIHR_CI_PG_CONFIGURED_CAP_BYTES:'2113929216',AIHR_CI_PG_PEAK_BUDGET_BYTES:'2147483648',AIHR_CI_PG_JIT:'on'};
 for(const key of ['DATABASE_URL','TEST_DATABASE_URL','MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])env[key]=`postgres://${key.includes('MIGRATION')?'postgres':'ai_hr_app'}@127.0.0.1:5433/ai_hr_orchestrator_browser`;
 const event={repository:{full_name:env.GITHUB_REPOSITORY,id:1333414856},inputs:{candidate_ref:'codex/fixture',expected_sha:head},ref:env.GITHUB_REF};
 const container={Name:'/aihr-ci-12345-1-db-1',Config:{Image:'postgres:16@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97',Labels:{'aihr-owner':'aihr-ci-12345-1-db-1'},Cmd:['-c','listen_addresses=127.0.0.1','-c','port=5433','-c','fsync=off','-c','synchronous_commit=off','-c','full_page_writes=off','-c','wal_level=minimal','-c','max_wal_senders=0','-c','jit=on','-c','shared_buffers=128MB','-c','max_connections=100','-c','max_locks_per_transaction=256']},HostConfig:{NetworkMode:'host',Memory:2113929216,MemorySwap:2113929216},State:{Running:true,Dead:false,OOMKilled:false}};
 let inspections=0;
 const input={env,platform:'linux',cwd:workspace+'/source',realpath:path=>path,read:()=>JSON.stringify(event),git:(path,args)=>{
  if(args.join(' ')==='rev-parse --show-toplevel')return path;
  if(args.join(' ')==='rev-parse HEAD')return path.endsWith('/source')?head:controller;
  if(args[0]==='status')return '';
  if(args[0]==='remote')return 'https://github.com/StradaverseHub/ai-hr.git';
  throw Error('Unexpected Git command');
 },inspect:name=>{assert.equal(name,'aihr-ci-12345-1-db-1');inspections++;return container;},evidenceDirectory:temp+'/orchestrator-production-renderer',adminUrl:'postgres://postgres@127.0.0.1:5433/postgres'};
 return {input,event,container,inspections:()=>inspections};
}
test('only the exact job-owned hosted fictional target is admitted, without release authority',()=>{
 const f=fixture(),result=inspectOrchestratorBootstrap(f.input);
 assert.equal(result.candidate,'a'.repeat(40));assert.equal(result.controller,'b'.repeat(40));assert.equal(result.releaseAuthorized,false);assert.equal(f.inspections(),1);
 f.container.Config.Cmd.unshift('postgres');assert.deepEqual(inspectOrchestratorBootstrap(f.input),result);
});
const badEnv={GITHUB_ACTIONS:'false',CI:'false',RUNNER_ENVIRONMENT:'self-hosted',RUNNER_OS:'macOS',GITHUB_REPOSITORY:'fork/ai-hr',GITHUB_REPOSITORY_ID:'1',GITHUB_EVENT_NAME:'push',GITHUB_WORKFLOW:'alpha-staging',GITHUB_JOB:'unit',GITHUB_RUN_ID:'0',GITHUB_RUN_ATTEMPT:'0',AIHR_CI_HEAD:'bad',AIHR_CI_CONTROL_HEAD:'bad',GITHUB_SHA:'c'.repeat(40),GIT_DIR:'/tmp/git',GIT_WORK_TREE:'/tmp/tree',GIT_INDEX_FILE:'/tmp/index',AIHR_FOCUSED_EVIDENCE_DIR:'/tmp/evidence',AIHR_CI_ROLE_MODE:'full',AIHR_CI_DISPOSABLE_ROLE_MODE:'full',TEST_DB_NAMESPACE:'aifocus',AIHR_CI_UNIT:'db-2',NODE_ENV:'production',AIHR_CI_PG_PROFILE:'legacy-2g',AIHR_CI_PG_CONFIGURED_CAP_BYTES:'2147483648',AIHR_CI_PG_PEAK_BUDGET_BYTES:'4294967296',AIHR_CI_PG_JIT:'off',AIHR_CI_PG_MEMORY_GIB:'2',DATABASE_URL:'postgres://ai_hr_app@staging/live',TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test',MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_dev',TEST_MIGRATION_DATABASE_URL:'postgres://postgres:secret@127.0.0.1:5433/ai_hr_orchestrator_browser',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/main',GITHUB_REF:'refs/tags/release',GITHUB_EVENT_PATH:'/tmp/event.json'};
for(const [key,value]of Object.entries(badEnv))test('refuses '+key+' before container inspection',()=>{const f=fixture();f.input.env[key]=value;assert.throws(()=>inspectOrchestratorBootstrap(f.input));assert.equal(f.inspections(),0);});
for(const [name,mutate]of Object.entries({
 'non-Linux platform':f=>f.input.platform='darwin',
 'admin database':f=>f.input.adminUrl='postgres://postgres@127.0.0.1:5433/live',
 'outside evidence':f=>f.input.evidenceDirectory='/tmp/evidence',
 'symlinked source':f=>f.input.realpath=p=>p.endsWith('/source')?'/tmp/source':p,
 'wrong cwd':f=>f.input.cwd='/tmp/source',
 'dirty checkout':f=>f.input.git=()=> 'dirty',
 'event candidate mismatch':f=>f.event.inputs.expected_sha='c'.repeat(40),
 'event repository mismatch':f=>f.event.repository.id=1,
 'event ref mismatch':f=>f.event.ref='refs/heads/main',
 'unsafe candidate ref':f=>f.event.inputs.candidate_ref='../main',
 'oversized event':f=>f.input.read=()=> ' '.repeat(4*1024*1024+1),
 'malformed event':f=>f.input.read=()=> '{',
}))test('refuses '+name+' before container inspection',()=>{const f=fixture();mutate(f);assert.throws(()=>inspectOrchestratorBootstrap(f.input));assert.equal(f.inspections(),0);});
for(const [name,mutate]of Object.entries({
 'foreign name':d=>d.Name='/foreign', 'foreign label':d=>d.Config.Labels['aihr-owner']='foreign',
 'stopped':d=>d.State.Running=false, 'dead':d=>d.State.Dead=true,'OOM killed':d=>d.State.OOMKilled=true,
 'unpinned image':d=>d.Config.Image='postgres:16','bridge network':d=>d.HostConfig.NetworkMode='bridge',
 'larger memory':d=>d.HostConfig.Memory=4294967296,'swap':d=>d.HostConfig.MemorySwap=4294967296,
 'other port':d=>d.Config.Cmd[3]='port=5432','external listen':d=>d.Config.Cmd[1]='listen_addresses=*',
 'altered JIT':d=>d.Config.Cmd[15]='jit=off',
}))test('refuses container '+name,()=>{const f=fixture();mutate(f.container);assert.throws(()=>inspectOrchestratorBootstrap(f.input));});
test('entry point is explicit and ordinary migration admission remains separate',()=>{
 const ordinary=readFileSync(new URL('../../scripts/migrate-with-focused-prerequisites.ts',import.meta.url),'utf8');
 assert(!ordinary.includes('prepareOrchestratorDraftDiscardRoles'));
 const renderer=readFileSync(new URL('./orchestrator-browser.mjs',import.meta.url),'utf8');
 assert(renderer.indexOf("'bootstrap-fictional-role-prerequisites'")<renderer.indexOf("'migrate-fictional-database'"));
 assert(renderer.includes("['db:migrate'], dbEnv, 300_000"));assert(renderer.includes('NODE_OPTIONS: \'--max-old-space-size=6144\''));
});
