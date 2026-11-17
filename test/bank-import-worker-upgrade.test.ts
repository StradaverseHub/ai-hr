/** Privileged helper controls execute without root operations or live services, only in Actions. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('preserves managed drain, production first activation, production update and rollback, immutable bytes and privileged refusal boundaries',()=>{
 const result=spawnSync('python3',['-I','-B','test/fixtures/bank-import-worker-upgrade-tests.py'],{encoding:'utf8',maxBuffer:1024**2});
 expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
 expect(result.stderr).toContain('Ran 84 tests');
});

it('admits only the root-pinned live CI runtime and monotonic native finish, with unchanged quarantine',()=>{
 const result=spawnSync('python3',['-I','-B','test/fixtures/bank-import-worker-ci-runtime-tests.py'],{encoding:'utf8',maxBuffer:1024**2});
 expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
 expect(result.stderr).toContain('Ran 13 tests');
},120000);

it('keeps the real all-kind heartbeat predicate and bounds only selected CI to the reviewed 600 seconds',async()=>{
 const {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
 const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const deploy=readFileSync('deploy/deploy.sh','utf8'),start=deploy.indexOf('# aihr-worker-ci-runtime/v1:'),end=deploy.indexOf('# DEMO MODE',start),policy=deploy.slice(start,end);
 expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const dir=mkdtempSync(join(tmpdir(),'aihr-ci-worker-wait-'));
 try{
  const privateEnv=join(dir,'.env.production');writeFileSync(privateEnv,'AIHR_IMPORT_WORKER_REQUIRED=1\n',{mode:0o600});
  for(const [ci,configured,expected]of [[true,undefined,'600'],[true,'600','600'],[false,undefined,'45'],[false,'23','23']]as const){
   const env:NodeJS.ProcessEnv={...process.env,AIHR_SELECTED_CI_BUILD_INSTALL:ci?'fixture':'',AIHR_IMPORT_WORKER_REQUIRED:'1'};delete env.AIHR_IMPORT_WORKER_WAIT_SECONDS;if(configured!==undefined)env.AIHR_IMPORT_WORKER_WAIT_SECONDS=configured;
   const r=spawnSync('bash',['-uc',policy+'\nprintf "%s" "$AIHR_SELECTED_IMPORT_WORKER_WAIT"'],{env,encoding:'utf8'});expect(r.status,r.stderr).toBe(0);expect(r.stdout).toBe(expected);
  }
  for(const value of ['', '45','599','601','0600']){
   const r=spawnSync('bash',['-uc',policy],{env:{...process.env,AIHR_SELECTED_CI_BUILD_INSTALL:'fixture',AIHR_IMPORT_WORKER_WAIT_SECONDS:value},encoding:'utf8'});expect(r.status).toBe(1);expect(r.stderr).toContain('configuration unchanged');
  }
  expect(readFileSync(privateEnv,'utf8')).toBe('AIHR_IMPORT_WORKER_REQUIRED=1\n');
  // Execute the actual checker with its SQL/live-kind predicate unchanged; only the DB and clock are deterministic ports.
  mkdirSync(join(dir,'node_modules/postgres'),{recursive:true});
  writeFileSync(join(dir,'node_modules/postgres/package.json'),JSON.stringify({name:'postgres',type:'module',exports:'./index.mjs'}));
  writeFileSync(join(dir,'node_modules/postgres/index.mjs'),`export default function(){const db=async strings=>{if(!strings.join('').includes('from bulk_job_kind k left join bulk_job_worker'))throw Error('wrong predicate');return [{kind:'ordinary',live:true,beat_at:new Date(Date.now())},{kind:'new-approved-kind',live:Date.now()>=Number(process.env.FIXTURE_HEARTBEAT_MS),beat_at:null}];};db.end=async()=>{};return db;}`);
  writeFileSync(join(dir,'clock.mjs'),`let now=0;Date.now=()=>now;globalThis.setTimeout=(fn,ms)=>{now+=ms;queueMicrotask(fn);return 0;};`);
  const checker=join(dir,'check-import-worker.ts');writeFileSync(checker,readFileSync('scripts/check-import-worker.ts','utf8'));
  for(const [wait,heartbeat,expected]of [[45,60000,2],[600,60000,0],[600,601000,2]]as const){
   const r=spawnSync(process.execPath,['--import','tsx','--import',join(dir,'clock.mjs'),checker,'--wait',String(wait)],{env:{...process.env,MIGRATION_DATABASE_URL:'postgres://fixture@localhost/unused',FIXTURE_HEARTBEAT_MS:String(heartbeat)},encoding:'utf8'});
   expect(r.status,r.stderr).toBe(expected);if(expected===0)expect(r.stdout).toContain('Import worker ready for: ordinary, new-approved-kind.');else expect(r.stderr).toContain('new-approved-kind');
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
},60000);
