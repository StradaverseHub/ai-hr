/** Stock Next type generation only, after the protected kernel probe's host grant. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync,constants,existsSync,fstatSync,lstatSync,openSync,readdirSync,readFileSync,readSync,realpathSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join,relative} from 'node:path';

export const protectedAppSource='a1397fa78ed35188849445962d35bdf48087b7a4';
export const protectedAppTree='d0a14fd8d4341b86a2352a6697163adda632f74e';
export const protectedLock='0413a070eca23d390fabdcd78cb63b2dcf4b0b69fe90408c7b57a4f672d21dbd';
const swcIntegrity='sha512-Istng1hMGp9TGO4lUqeKLd70MPN/OOkucVTP2Nmj+gLkwBgmPqUw8CJYBCC7nbl/B/23bBCcjCI5Hsh6hazC1A==';
const depRoot='/project/node_modules';
const deps=[['typescript','5.9.3','lib/typescript.d.ts'],['@types/node','20.19.41','index.d.ts'],
 ['@types/react','19.2.16','index.d.ts'],['@types/react-dom','19.2.3','index.d.ts']];
export const generatedNames=['cache-life.d.ts','root-params.d.ts','routes.d.ts','validator.ts'];
const hash=raw=>createHash('sha256').update(raw).digest('hex');

export function sealProtectedFile(path,maxBytes){
 assert.equal(realpathSync(path),path);
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=fstatSync(fd),digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024**2);
  assert(before.isFile()&&before.size>0&&before.size<=maxBytes);
  let size=0;
  for(let count;(count=readSync(fd,buffer,0,buffer.length,null))!==0;){size+=count;assert(size<=before.size);digest.update(buffer.subarray(0,count));}
  const after=fstatSync(fd),named=lstatSync(path);
  for(const key of ['dev','ino','size','mode','mtimeMs','ctimeMs'])assert(before[key]===after[key]&&before[key]===named[key]);
  assert.equal(size,before.size);
  return {bytes:size,sha256:digest.digest('hex')};
 }finally{closeSync(fd);}
}
const ownedDependency=path=>{
 const actual=realpathSync(path);
 assert(actual.startsWith(depRoot+'/.pnpm/'));
 return actual;
};
function packageManifest(owner,name,version){
 const path=ownedDependency(owner.resolve(name+'/package.json')),seal=sealProtectedFile(path,1024*1024);
 const manifest=JSON.parse(readFileSync(path,'utf8'));
 assert.equal(manifest.name,name);assert.equal(manifest.version,version);
 return {path,manifest,seal};
}
export function assertGnuSwcElf(header){
 assert(header.length>=64&&header.subarray(0,6).equals(Buffer.from([0x7f,0x45,0x4c,0x46,2,1])));
 assert.equal(header.readUInt16LE(16),3);
 assert.equal(header.readUInt16LE(18),62);
}
function dependencyEvidence(){
 assert.equal(realpathSync(depRoot),depRoot);
 const app=createRequire('/project/package.json'),next=packageManifest(app,'next','16.4.1');
 const nextRoot=dirname(next.path),loader=ownedDependency(join(nextRoot,'dist/build/swc/index.js'));
 const cli=ownedDependency(join(nextRoot,'dist/bin/next'));
 assert(loader.startsWith(nextRoot+'/')&&cli.startsWith(nextRoot+'/'));
 const nextRequire=createRequire(loader),swcName='@next/swc-linux-x64-gnu';
 assert.equal(next.manifest.optionalDependencies[swcName],'16.4.1');
 const swc=packageManifest(nextRequire,swcName,'16.4.1'),entry=ownedDependency(nextRequire.resolve(swcName));
 assert.equal(entry,join(dirname(swc.path),'next-swc.linux-x64-gnu.node'));
 const fd=openSync(entry,constants.O_RDONLY|constants.O_NOFOLLOW),header=Buffer.alloc(64);
 try{assert.equal(readSync(fd,header,0,header.length,0),header.length);assertGnuSwcElf(header);}finally{closeSync(fd);}
 assert(process.report.getReport().header.glibcVersionRuntime,'GNU libc witness required');
 const native=sealProtectedFile(entry,256*1024**2);
 const loaded=nextRequire(swcName);
 assert.equal(typeof loaded.transform,'function');
 assert(readFileSync('/proc/self/maps','utf8').split('\n').some(line=>line.endsWith(' '+entry)),'Exact GNU SWC ELF was not mapped');
 const types=deps.map(([name,version,type])=>{
  const required=packageManifest(app,name,version),file=ownedDependency(join(dirname(required.path),type));
  assert(file.startsWith(dirname(required.path)+'/'));
  return {name,version,packageJson:required.seal,entry:sealProtectedFile(file,16*1024**2)};
 });
 const lock=readFileSync('/project/pnpm-lock.yaml','utf8');
 assert.equal(hash(lock),protectedLock);
 assert(lock.includes("  '@next/swc-linux-x64-gnu@16.4.1':\n    resolution: {integrity: "+swcIntegrity+"}"));
 return {cli,proof:{nextVersion:'16.4.1',nextPackage:next.seal,nextCli:sealProtectedFile(cli,2*1024**2),
  nextSwcLoader:sealProtectedFile(loader,2*1024**2),swcPackage:swc.seal,nativeSwc:native,swcLockIntegrity:swcIntegrity,
  swcVersion:'16.4.1',gnuElfLoaded:true,installedArtifactTarballIndependentlyVerified:false,typescriptInputs:types}};
}
export function generatedSeals(project='/project',nextDirectory=join(project,'.next'),environment=join(project,'next-env.d.ts')){
 assert.deepEqual(readdirSync(nextDirectory).sort(),['types']);
 const types=join(nextDirectory,'types');
 assert(lstatSync(types).isDirectory()&&realpathSync(types)===types);
 assert.deepEqual(readdirSync(types).sort(),generatedNames);
 return Object.fromEntries([['next-env.d.ts',environment],...generatedNames.map(name=>['.next/types/'+name,join(types,name)])]
  .map(([name,path])=>[name,sealProtectedFile(path,8*1024**2)]));
}
export function runProtectedNextTypegen(){
 assert(process.platform==='linux'&&process.pid===1&&process.cwd()==='/work'&&process.versions.node==='22.23.3');
 assert(!existsSync('/project/.git')&&!existsSync('/project/.env')&&!existsSync('/project/.env.local'));
 assert.deepEqual(readdirSync('/project/.next'),[]);assert.equal(lstatSync('/project/next-env.d.ts').size,0);
 assert.throws(()=>writeFileSync('/project/forbidden','blocked',{flag:'wx'}),{code:'EROFS'});
 assert.throws(()=>writeFileSync('/project/node_modules/forbidden','blocked',{flag:'wx'}),{code:'EROFS'});
 const before=dependencyEvidence();
 const denied='postgres://nobody:nothing@127.0.0.1:1/no_database';
 const env={PATH:'/runtime',HOME:'/nonexistent',TMPDIR:'/project/.next',LANG:'C',LC_ALL:'C',TZ:'UTC',NODE_ENV:'production',
  CI:'true',GITHUB_ACTIONS:'true',NEXT_TELEMETRY_DISABLED:'1',NEXT_DISABLE_SWC_WASM:'1',NEXT_IGNORE_INCORRECT_LOCKFILE:'1',
  DATABASE_URL:denied,TEST_DATABASE_URL:denied,MIGRATION_DATABASE_URL:denied,TEST_MIGRATION_DATABASE_URL:denied};
 const argv=['--max-old-space-size=12288',before.cli,'typegen','/project'];
 writeFileSync('/work/typegen-launch.json',JSON.stringify({intended:true,argvSha256:hash(JSON.stringify(argv))})+'\n',{flag:'wx',mode:0o600});
 const start=performance.now();
 const child=spawnSync('/runtime/node',argv,{
  cwd:'/project',env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:12000,killSignal:'SIGKILL',maxBuffer:262144});
 const elapsedMs=Math.round(performance.now()-start);
 const output=(child.stdout??'')+(child.stderr??'');
 const execution={invoked:true,exit:child.status,signal:child.signal,errorCode:child.error?.code??null,elapsedMs,
  outputBytes:Buffer.byteLength(output),outputSha256:hash(output)};
 writeFileSync('/work/typegen-execution.json',JSON.stringify(execution)+'\n',{flag:'wx',mode:0o600});
 assert(!child.error&&!child.signal&&child.status===0,'Exact stock Next typegen refused');
 assert.match(output,/Generating route types|Generated route types|Types generated/i);
 const after=dependencyEvidence();
 assert.deepEqual(before,after);
 const generated=generatedSeals();
 const validator=readFileSync('/project/.next/types/validator.ts','utf8');
 const routes=readFileSync('/project/.next/types/routes.d.ts','utf8');
 assert(validator.includes('app/payroll/transactions/tp1/[year]/page.js')&&routes.includes('/payroll/transactions/tp1/[year]'));
 const report={kind:'PROTECTED_STOCK_NEXT_TYPEGEN',source:protectedAppSource,tree:protectedAppTree,...execution,dependencies:before.proof,
  generated,trackedProductWrites:0,packageDownloads:false,strictCompilerInvoked:false,routeSemanticCoverage:false,releaseEligible:false};
 writeFileSync('/work/typegen-result.json',JSON.stringify(report)+'\n',{flag:'wx',mode:0o600});
}
