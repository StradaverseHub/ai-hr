import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validatePostgresEvidence,capturePostgresEvidence,validatePostgresProfile,postgresProfileFromEnv,V15_POSTGRES_PROFILE} from './postgres-evidence.mjs';
import {CI_EXECUTION} from './manifest.mjs';
function evidence(){return {schemaVersion:2,profileVersion:2,configuredCapBytes:2113929216,peakBudgetBytes:2147483648,errors:{},memoryLimit:2113929216,memorySwap:2113929216,memoryMax:2113929216,memorySwapMax:0,memoryPeak:1500000000,memoryEvents:{max:0,oom:0,oom_kill:0},state:{Running:true,OOMKilled:false,Dead:false},settings:{jit:'on',jitAvailable:true,serverVersionNum:'160015'}};}
const ordinaryEnv={AIHR_CI_PG_PROFILE:'2',AIHR_CI_PG_CONFIGURED_CAP_BYTES:'2113929216',AIHR_CI_PG_PEAK_BUDGET_BYTES:'2147483648',AIHR_CI_PG_JIT:'on'};
const selectors=['AIHR_CI_PG_PROFILE','AIHR_CI_PG_MEMORY_GIB','AIHR_CI_PG_CONFIGURED_CAP_BYTES','AIHR_CI_PG_PEAK_BUDGET_BYTES','AIHR_CI_PG_JIT'];
function cleanEnv(){const env={...process.env};for(const key of selectors)delete env[key];return env;}
test('Measured v15 lower actual cap and unchanged raw 2 GiB peak budget admit',()=>{
 assert.equal(validatePostgresEvidence(evidence(),CI_EXECUTION),true);
 for(const peak of [2113929216+4096,2147483648])assert.equal(validatePostgresEvidence({...evidence(),memoryPeak:peak,memoryEvents:{max:3,oom:0,oom_kill:0}},CI_EXECUTION),true);
});
for(const [name,change] of [
 ['missing snapshot',()=>null],['wrong schema',e=>({...e,schemaVersion:1})],['wrong profile',e=>({...e,profileVersion:1})],
 ['missing declared cap',e=>({...e,configuredCapBytes:undefined})],['altered declared cap',e=>({...e,configuredCapBytes:2147483648})],
 ['missing hard budget',e=>({...e,peakBudgetBytes:undefined})],['altered hard budget',e=>({...e,peakBudgetBytes:2147483649})],
 ['legacy field',e=>({...e,memoryBytes:2147483648})],['legacy profile id',e=>({...e,profileId:'legacy-2g'})],
 ['old Docker cap',e=>({...e,memoryLimit:2147483648})],['wrong cgroup cap',e=>({...e,memoryMax:2147483648})],
 ['wrong Docker swap',e=>({...e,memorySwap:2147483648})],['missing Docker swap',e=>({...e,memorySwap:undefined})],
 ['enabled cgroup swap',e=>({...e,memorySwapMax:1})],['missing cgroup swap',e=>({...e,memorySwapMax:undefined})],
 ['missing peak',e=>({...e,memoryPeak:null})],['zero peak',e=>({...e,memoryPeak:0})],['fractional peak',e=>({...e,memoryPeak:1.5})],
 ['peak one byte above hard budget',e=>({...e,memoryPeak:2147483649})],['original 4c peak',e=>({...e,memoryPeak:2147504128})],['original b090 peak',e=>({...e,memoryPeak:2147495936})],
 ['OOM without kill',e=>({...e,memoryEvents:{oom:1,oom_kill:0}})],['actual backend OOM kill',e=>({...e,memoryEvents:{oom:0,oom_kill:1}})],
 ['missing OOM count',e=>({...e,memoryEvents:{oom_kill:0}})],['missing kill count',e=>({...e,memoryEvents:{oom:0}})],['invalid event counter',e=>({...e,memoryEvents:{oom:0,oom_kill:0,max:-1}})],
 ['Docker OOM kill',e=>({...e,state:{...e.state,OOMKilled:true}})],['stopped server',e=>({...e,state:{...e.state,Running:false}})],
 ['dead server',e=>({...e,state:{...e.state,Dead:true}})],['unknown server',e=>({...e,state:null})],
 ['blanket disabled JIT',e=>({...e,settings:{...e.settings,jit:'off'}})],['missing JIT provider',e=>({...e,settings:{...e.settings,jitAvailable:false}})],
 ['wrong PostgreSQL major',e=>({...e,settings:{...e.settings,serverVersionNum:'170005'}})],['unknown settings',e=>({...e,settings:null})],
 ['capture error',e=>({...e,errors:{memorySwap:'unreadable'}})],['missing capture errors',e=>({...e,errors:undefined})],
])test('Resource evidence refuses '+name,()=>assert.throws(()=>validatePostgresEvidence(change(evidence()),CI_EXECUTION)));
test('Missing, mixed, foreign and unversioned execution profiles refuse',()=>{
 for(const profile of [null,{}, {...V15_POSTGRES_PROFILE,profileVersion:1},{...V15_POSTGRES_PROFILE,profileVersion:3},
  {...V15_POSTGRES_PROFILE,memoryBytes:2147483648},{memoryBytes:2147483648,jit:'on'},
  {...V15_POSTGRES_PROFILE,configuredCapBytes:2147483648},{...V15_POSTGRES_PROFILE,peakBudgetBytes:2147483649},
  {...V15_POSTGRES_PROFILE,jit:'off'},{...V15_POSTGRES_PROFILE,profileId:'legacy-2g'}]){
  assert.throws(()=>validatePostgresProfile(profile));assert.throws(()=>validatePostgresEvidence(evidence(),{postgres:profile}));
 }
 assert.throws(()=>validatePostgresEvidence(evidence(),null));
});
test('Legacy diagnostics remain explicit and cannot replace current profile evidence',()=>{
 for(const gib of [1,2])for(const jit of ['on','off']){
  const profile=postgresProfileFromEnv({AIHR_CI_PG_PROFILE:`legacy-${gib}g`,AIHR_CI_PG_MEMORY_GIB:String(gib),AIHR_CI_PG_JIT:jit});
  const legacy={...evidence(),schemaVersion:1,...profile,memoryLimit:gib*1073741824,memorySwap:gib*1073741824,memoryMax:gib*1073741824,memoryPeak:1000000000,settings:{...evidence().settings,jit}};
  assert.equal(validatePostgresEvidence(legacy,{postgres:profile}),true);
  assert.throws(()=>validatePostgresEvidence(legacy,CI_EXECUTION));assert.throws(()=>validatePostgresEvidence(evidence(),{postgres:profile}));
 }
 assert.throws(()=>validatePostgresEvidence({schemaVersion:1,memoryLimit:2147483648,memoryMax:2147483648,memoryPeak:1000000000,memoryEvents:{oom_kill:0},state:evidence().state,settings:evidence().settings},CI_EXECUTION));
});
const badEnvironments=[{},...selectors.filter(k=>k!=='AIHR_CI_PG_MEMORY_GIB').map(key=>{const e={...ordinaryEnv};delete e[key];return e;}),
 {...ordinaryEnv,AIHR_CI_PG_MEMORY_GIB:'2'},{...ordinaryEnv,AIHR_CI_PG_MEMORY_GIB:''},{...ordinaryEnv,AIHR_CI_PG_PROFILE:'3'},
 {...ordinaryEnv,AIHR_CI_PG_CONFIGURED_CAP_BYTES:'2147483648'},{...ordinaryEnv,AIHR_CI_PG_PEAK_BUDGET_BYTES:'2147483649'},
 {...ordinaryEnv,AIHR_CI_PG_JIT:'off'},
 {AIHR_CI_PG_PROFILE:'legacy-1g',AIHR_CI_PG_MEMORY_GIB:'2',AIHR_CI_PG_JIT:'on'},
 {AIHR_CI_PG_PROFILE:'legacy-2g',AIHR_CI_PG_MEMORY_GIB:'2',AIHR_CI_PG_JIT:'on',AIHR_CI_PG_CONFIGURED_CAP_BYTES:''}];
test('Environment requires one exact named profile with no mixed selectors or silent defaults',()=>{
 assert.deepEqual(postgresProfileFromEnv(ordinaryEnv),V15_POSTGRES_PROFILE);
 for(const env of badEnvironments)assert.throws(()=>postgresProfileFromEnv(env));
});
test('Actual generated Docker arguments bind memory AND swap to exact byte caps; invalid selectors refuse before Docker',()=>{
 const dir=mkdtempSync(join(tmpdir(),'aihr-pg-args-')),trace=join(dir,'trace');
 try{
  writeFileSync(join(dir,'docker'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$AIHR_DOCKER_TRACE"\nif [ "$1" = container ]; then exit 1; fi\nexit 0\n',{mode:0o700});
  const env={...cleanEnv(),PATH:dir+':/usr/bin:/bin',AIHR_DOCKER_TRACE:trace,GITHUB_ACTIONS:'true',CI:'true',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',AIHR_CI_UNIT:'db-1',...ordinaryEnv};
  const script=fileURLToPath(new URL('./postgres.sh',import.meta.url));
  const run=changes=>spawnSync('/bin/bash',[script,'reset'],{env:{...env,...changes},encoding:'utf8'});
  let result=run({});assert.equal(result.status,0,result.stderr);
  const args=readFileSync(trace,'utf8').split('\n').find(line=>line.startsWith('run ')).split(' ');
  assert(args.includes('--memory=2113929216'));assert(args.includes('--memory-swap=2113929216'));assert(args.includes('jit=on'));
  for(const bad of badEnvironments){rmSync(trace,{force:true});const invalid={...env};for(const key of selectors)delete invalid[key];Object.assign(invalid,bad);
   result=spawnSync('/bin/bash',[script,'reset'],{env:invalid,encoding:'utf8'});assert.equal(result.status,2,result.stderr);assert.equal(existsSync(trace),false);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Collector reads actual Docker swap and cgroup limits, preserves raw peaks and refuses foreign ownership',{skip:process.platform!=='linux'},()=>{
 const dir=mkdtempSync(join(tmpdir(),'aihr-pg-capture-'));
 try{
  writeFileSync(join(dir,'docker'),`#!/bin/sh
if [ "$1" = inspect ]; then
 case "$3" in
  *aihr-owner*) if [ "\${AIHR_FAKE_FOREIGN:-0}" = 1 ]; then echo foreign; else echo aihr-ci-123-1-db-1; fi ;;
  *json*) echo '{"Running":true,"OOMKilled":false,"Dead":false}' ;;
  *MemorySwap*) echo "\${AIHR_FAKE_SWAP:-2113929216}" ;;
  *Memory*) echo 2113929216 ;;
 esac
elif [ "$1" = exec ]; then
 case "$*" in
  *memory.max*) printf '2113929216\\n0\\n2147495936\\nmax 3\\noom 0\\noom_kill 0\\n' ;;
  *) echo '{"jit":"on","jitAvailable":true,"serverVersionNum":"160015"}' ;;
 esac
fi
`,{mode:0o700});
  const env={...cleanEnv(),PATH:dir+':'+process.env.PATH,GITHUB_ACTIONS:'true',CI:'true',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',AIHR_CI_UNIT:'db-1',...ordinaryEnv};
  const module=new URL('./postgres-evidence.mjs',import.meta.url).href;
  const code=`import {capturePostgresEvidence,V15_POSTGRES_PROFILE} from ${JSON.stringify(module)};console.log(JSON.stringify(capturePostgresEvidence('db-1',V15_POSTGRES_PROFILE)));`;
  const collect=changes=>spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...env,...changes},encoding:'utf8'});
  let result=collect({AIHR_FAKE_SWAP:'2120000000'});assert.equal(result.status,0,result.stderr);
  const actual=JSON.parse(result.stdout);assert.equal(actual.memorySwap,2120000000);assert.equal(actual.memorySwapMax,0);assert.equal(actual.memoryPeak,2147495936);assert.equal(actual.memoryEvents.max,3);
  assert.throws(()=>validatePostgresEvidence(actual,CI_EXECUTION));
  result=collect({AIHR_FAKE_FOREIGN:'1'});assert.notEqual(result.status,0);assert.match(result.stderr,/ownership mismatch/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Capture refuses outside disposable GitHub CI before accessing Docker',()=>{const previous=process.env.GITHUB_ACTIONS;try{process.env.GITHUB_ACTIONS='false';assert.throws(()=>capturePostgresEvidence('db-'+'a'.repeat(16),V15_POSTGRES_PROFILE));}finally{if(previous===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=previous;}});
