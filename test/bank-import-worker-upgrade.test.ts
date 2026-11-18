/** Privileged helper controls execute without root operations or live services, only in Actions. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('preserves managed drain, production first activation, production update and rollback, immutable bytes and privileged refusal boundaries',()=>{
 const result=spawnSync('python3',['-I','-B','test/fixtures/bank-import-worker-upgrade-tests.py'],{encoding:'utf8',maxBuffer:1024**2});
 expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
 expect(result.stderr).toContain('Ran 90 tests');
});

it('admits only the root-pinned live CI runtime and monotonic native finish, with unchanged quarantine',()=>{
 const result=spawnSync('python3',['-I','-B','test/fixtures/bank-import-worker-ci-runtime-tests.py'],{encoding:'utf8',maxBuffer:1024**2});
 expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);
 expect(result.stderr).toContain('Ran 36 tests');
 // Gate 44354971179 timed out at 136.205 s; allow about 3x headroom while retaining native runtime controls.
},420000);

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

it('executes the real inventory CLI against a clean frozen Git checkout and actual canonical filter owners',async()=>{
 const fs=await import('node:fs'),path=await import('node:path'),os=await import('node:os'),crypto=await import('node:crypto');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aihr-worker-inventory-cli-')),source=path.join(dir,'frozen'),out=path.join(dir,'private');fs.mkdirSync(out,{mode:0o700});
 const git=(...args:string[])=>{const r=spawnSync('git',['-c','core.hooksPath=/dev/null',...args],{encoding:'utf8',maxBuffer:4*1024**2,timeout:60000});expect(r.signal).toBeNull();expect(r.status,r.stderr).toBe(0);return r.stdout.trim();};
 const env:NodeJS.ProcessEnv={...process.env};for(const name of ['AIHR_SSH_CONFIG','IMPROVE_SSH_HOST','IMPROVE_SSH_USER','IMPROVE_SSH_PORT'])delete env[name];
 try{
  git('clone','--shared','--no-hardlinks','--quiet',process.cwd(),source);
  fs.symlinkSync(path.join(process.cwd(),'node_modules'),path.join(source,'node_modules'),'dir');
  fs.appendFileSync(path.join(source,'.gitignore'),'\n/canonical-ignored-extra/\n/fixture-nested/\n/mobile/fixture-secret.p8\n/mobile/fixturedeep/\n');
  git('-C',source,'add','.gitignore');git('-C',source,'-c','user.name=Fictional worker fixture','-c','user.email=worker-fixture@example.invalid','commit','-qm','Isolated ignored canonical source fixtures');
  const head=git('-C',source,'rev-parse','HEAD');
  for(const [name,body]of [['canonical-ignored-extra/included.txt','ignored but canonical'],['.improve/private.txt','excluded root fixture'],['fixture-nested/node_modules/private.txt','excluded component'],['mobile/fixture-secret.p8','excluded anchored pattern'],['mobile/fixturedeep/included.p8','included exact owner depth']]as const){const target=path.join(source,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,body);}
  fs.symlinkSync('included.txt',path.join(source,'canonical-ignored-extra/link'));
  expect(git('-C',source,'status','--porcelain')).toBe('');
  const cli=path.join(source,'scripts/bank-import-worker-source-inventory.mjs'),file=path.join(out,'inventory.json');
  const invoke=(output:string)=>{const result=spawnSync(process.execPath,['--import','tsx',cli,source,head,output],{cwd:process.cwd(),env,encoding:'utf8',maxBuffer:4*1024**2,timeout:60000});expect(result.signal,'Inventory CLI must finish without timeout termination').toBeNull();return result;};
  const first=invoke(file);expect(first.status,first.stderr).toBe(0);
  const raw=fs.readFileSync(file),inventory=JSON.parse(raw.toString()),ack=JSON.parse(first.stdout);
  expect(ack.manifestSha256).toBe(crypto.createHash('sha256').update(raw).digest('hex'));expect(fs.statSync(file).mode&0o777).toBe(0o600);expect(inventory.source).toBe(head);
  const originalOwner=await import('../scripts/improve/release');const owner=originalOwner.deploymentRsyncArgs;
  expect(inventory.filters).toEqual(owner!(source,'unused:/').flatMap((v:string,i:number,a:string[])=>v==='--exclude'?[a[i+1]]:[]));
  expect(inventory.entries.length).toBeGreaterThan(100);const nodes=new Map<string,{kind:string;sha256?:string;target?:string}>(inventory.entries.map((r:{path:string;kind:string;sha256?:string;target?:string})=>[r.path,r]));
  expect(nodes.get('canonical-ignored-extra/included.txt')?.sha256).toBe(crypto.createHash('sha256').update('ignored but canonical').digest('hex'));expect(nodes.get('canonical-ignored-extra/link')).toMatchObject({kind:'link',target:'included.txt'});expect(nodes.has('mobile/fixturedeep/included.p8')).toBe(true);
  for(const key of ['.git','node_modules','.improve','fixture-nested/node_modules','mobile/fixture-secret.p8'])expect(nodes.has(key)).toBe(false);
  const again=invoke(file);expect(again.status).not.toBe(0);expect(fs.readFileSync(file)).toEqual(raw);
  const outside=path.join(dir,'outside');fs.writeFileSync(outside,'must remain outside');const escape=path.join(source,'canonical-ignored-extra/escape');fs.symlinkSync('../../outside',escape);const escaped=invoke(path.join(out,'escape.json'));expect(escaped.status).not.toBe(0);expect(escaped.stderr).toContain('Source link');fs.unlinkSync(escape);
  fs.appendFileSync(path.join(source,'.gitignore'),'\n# Tracked WIP must refuse\n');const dirty=invoke(path.join(out,'dirty.json'));expect(dirty.status).not.toBe(0);expect(dirty.stderr).toContain('cleanHead');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
},120000);
