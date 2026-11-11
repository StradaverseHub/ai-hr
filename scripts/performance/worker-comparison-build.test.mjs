/** Filesystem models for the hosted Linux byte owner. No Next build or worker starts here. */
import assert from 'node:assert/strict';
import fs,{chmodSync,existsSync,linkSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readlinkSync,realpathSync,renameSync,rmSync,symlinkSync,truncateSync,writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {holdDevelopmentBuildSnapshot} from './worker-comparison-build.mjs';

const privateName='aihr-worker-comparison-next';
const sourceSha='a'.repeat(40);
const runtimeAliases=['fontkit-aaaaaaaa','sharp-bbbbbbbb'];
function fixture(work){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'aihr-build-snapshot-model-'));
 const workspace=join(root,'workspace'),source=join(workspace,'source'),temp=join(root,'temp');
 const next=join(source,'.next'),privateRoot=join(temp,privateName),seed=join(privateRoot,'seed');
 mkdirSync(source,{recursive:true});mkdirSync(temp);
 for(const name of ['fontkit','sharp']){
  const packagePath=join(source,'node_modules','.store',name);
  mkdirSync(packagePath,{recursive:true});
  writeFileSync(join(packagePath,'package.json'),JSON.stringify({name,version:'1.0.0'}));
  writeFileSync(join(packagePath,'index.js'),'module.exports = 1;');
  symlinkSync('.store/'+name,join(source,'node_modules',name),'dir');
 }
 const env={GITHUB_WORKSPACE:workspace,RUNNER_TEMP:temp,GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',
  RUNNER_OS:'Linux',RUNNER_ARCH:'X64',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',
  GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW:'alpha-focused-checks',GITHUB_JOB:'selected-tests',
  GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'12345',AIHR_CI_HEAD:sourceSha,AIHR_CI_CONTROL_HEAD:sourceSha,GITHUB_SHA:sourceSha,GITHUB_WORKFLOW_SHA:sourceSha};
 let snapshot;
 const open=()=>snapshot=holdDevelopmentBuildSnapshot(env);
 const build=(path=next)=>{
  mkdirSync(join(path,'server','app'),{recursive:true});
  mkdirSync(join(path,'node_modules'));
  // Next emits aliases to the installed source packages, not copies under .next.
  symlinkSync('../../node_modules/fontkit',join(path,'node_modules',runtimeAliases[0]),'dir');
  symlinkSync(join(source,'node_modules','.store','sharp'),join(path,'node_modules',runtimeAliases[1]),'dir');
  writeFileSync(join(path,'BUILD_ID'),'model-build-id');
  writeFileSync(join(path,'server','app','route.js'),'const stock=1;');
  writeFileSync(join(path,'server','app','empty'),'');
  chmodSync(join(path,'server','app','route.js'),0o640);
 };
 try{work({root,workspace,source,temp,next,privateRoot,seed,env,open,build});}
 finally{try{snapshot?.close();}finally{rmSync(root,{recursive:true,force:true});}}
}

test('holds one build and produces exactly two fresh independent copies at the original name',()=>{
 fixture(({source,next,privateRoot,seed,open,build})=>{
  const snapshot=open();build();
  const original=snapshot.capture();
  assert.deepEqual(original.identity,{candidateSha:sourceSha,controllerSha:sourceSha,runId:12345,runAttempt:1});
  assert.equal(original.seal.buildId,'model-build-id');assert.equal(original.seal.entries,9);
  const links=runtimeAliases.map(name=>readlinkSync(join(next,'node_modules',name)));
  assert.equal(original.seal.bytes,Buffer.byteLength('model-build-idconst stock=1;'+links.join('')));
  assert.match(original.seal.sha256,/^[a-f0-9]{64}$/);
  assert.equal(lstatSync(privateRoot).mode&0o777,0o700);
  const relative=join('server','app','route.js'),directories=[original.directory.inode];
  for(let copy=1;copy<=2;copy++){
   writeFileSync(join(next,relative),'runtime cache mutated this cell');
   renameSync(next,join(source,'retired-'+copy));
   const installed=snapshot.install();
   assert.deepEqual(installed.seal,original.seal);assert.deepEqual(installed.identity,original.identity);
   assert.equal(installed.directory.device,original.directory.device);directories.push(installed.directory.inode);
   assert.equal(readFileSync(join(next,relative),'utf8'),'const stock=1;');
   assert.equal(readFileSync(join(seed,relative),'utf8'),'const stock=1;');
   assert.equal(lstatSync(join(next,relative)).mode&0o777,0o640);
   assert.equal(lstatSync(join(next,relative)).nlink,1);
   assert.notEqual(lstatSync(join(next,relative)).ino,lstatSync(join(seed,relative)).ino);
   for(const [index,name] of runtimeAliases.entries()){
    const installedPath=join(next,'node_modules',name),seedPath=join(seed,'node_modules',name);
    assert.equal(readlinkSync(installedPath),links[index]);
    assert.equal(readlinkSync(seedPath),links[index]);
    assert.notEqual(lstatSync(installedPath).ino,lstatSync(seedPath).ino);
    assert.equal(realpathSync(installedPath),join(source,'node_modules','.store',name.split('-')[0]));
   }
  }
  assert.equal(new Set(directories).size,3);
  assert.deepEqual(snapshot.verify(),original.seal);
  renameSync(next,join(source,'retired-3'));
  assert.throws(()=>snapshot.install(),/course exhausted/);assert.equal(existsSync(next),false);
 });
});

test('requires the exact hosted source identity before creating a custody directory',()=>{
 fixture(({env,privateRoot})=>{
  for(const changed of [{GITHUB_JOB:'another-job'},{GITHUB_RUN_ATTEMPT:'2'},{GITHUB_RUN_ID:'123\n'},
   {GITHUB_WORKFLOW_SHA:'b'.repeat(40)},{AIHR_CI_CONTROL_HEAD:'b'.repeat(40)},{GITHUB_REPOSITORY_ID:'1'}]){
   assert.throws(()=>holdDevelopmentBuildSnapshot({...env,...changed}),/hosted source identity refused/);
   assert.equal(existsSync(privateRoot),false);
  }
 });
});

test('admits the parallel build and cell jobs only for a parallel worker course',()=>{
 fixture(({env,privateRoot})=>{
  for(const job of ['worker-build','worker-cell']){
   for(const course of [undefined,'serial-2-4-8','preflight-2','off'])
    assert.throws(()=>holdDevelopmentBuildSnapshot({...env,GITHUB_JOB:job,AIHR_MEASURED_BROWSER_COURSE:course}),/hosted source identity refused/);
   assert.equal(existsSync(privateRoot),false);
  }
  for(const course of ['parallel-2-4-8','parallel-smoke']){
   holdDevelopmentBuildSnapshot({...env,GITHUB_JOB:'worker-build',AIHR_MEASURED_BROWSER_COURSE:course}).close();
   rmSync(privateRoot,{recursive:true});
  }
 });
});

test('a parallel cell reproduces the upstream seal exactly from the tar transport',()=>{
 fixture(({root,source,next,privateRoot,seed,env,build})=>{
  const course={AIHR_MEASURED_BROWSER_COURSE:'parallel-smoke'};
  const upstream=holdDevelopmentBuildSnapshot({...env,...course,GITHUB_JOB:'worker-build'});
  let sealed;
  try{
   build();
   sealed=upstream.capture();
   execFileSync('/usr/bin/tar',['--create','--file',join(root,'next.tar'),'--directory',seed,'--sort=name','--numeric-owner',
    '--owner=0','--group=0','--format=gnu','.']);
  }finally{upstream.close();}
  // A fresh runner: no build, no custody directory, only the transported archive.
  rmSync(next,{recursive:true});rmSync(privateRoot,{recursive:true});
  const cell=holdDevelopmentBuildSnapshot({...env,...course,GITHUB_JOB:'worker-cell'});
  try{
   mkdirSync(next,{mode:0o700});
   execFileSync('/usr/bin/tar',['--extract','--file',join(root,'next.tar'),'--directory',next,'--no-same-owner','--preserve-permissions']);
   const installed=cell.capture();
   assert.deepEqual(installed.seal,sealed.seal);assert.deepEqual(installed.identity,sealed.identity);
   assert.equal(lstatSync(join(next,'server','app','route.js')).mode&0o777,0o640);
   assert.equal(realpathSync(join(next,'node_modules',runtimeAliases[1])),join(source,'node_modules','.store','sharp'));
   assert.deepEqual(cell.verify(),sealed.seal);
  }finally{cell.close();}
  // Any changed transported byte yields a different seal, which the cell model refuses.
  rmSync(next,{recursive:true});rmSync(privateRoot,{recursive:true});
  const tampered=holdDevelopmentBuildSnapshot({...env,...course,GITHUB_JOB:'worker-cell'});
  try{
   mkdirSync(next,{mode:0o700});
   execFileSync('/usr/bin/tar',['--extract','--file',join(root,'next.tar'),'--directory',next,'--no-same-owner','--preserve-permissions']);
   writeFileSync(join(next,'server','app','route.js'),'const stock=2;');
   assert.notEqual(tampered.capture().seal.sha256,sealed.seal.sha256);
  }finally{tampered.close();}
 });
});

test('refuses an occupied pre-build .next, including a link, without touching it or its target',()=>{
 fixture(({root,next,privateRoot,open})=>{
  const outside=join(root,'outside');mkdirSync(outside);
  writeFileSync(join(outside,'sentinel'),'outside');symlinkSync(outside,next,'dir');
  assert.throws(open,/absent pre-build .next/);
  assert.equal(lstatSync(next).isSymbolicLink(),true);
  assert.equal(readFileSync(join(outside,'sentinel'),'utf8'),'outside');
  assert.equal(existsSync(privateRoot),false);
 });
});

test('allows sibling churn while binding the path, but refuses an ancestor mode change',()=>{
 for(const [testChurn,mutate] of [
  [true,workspace=>mkdirSync(join(workspace,'unrelated-sibling'))],
  [false,workspace=>chmodSync(workspace,0o700)],
 ])fixture(({workspace,open,build})=>{
  chmodSync(workspace,0o755);
  const original=fs.lstatSync;
  let changed=false;
  fs.lstatSync=(path,options)=>{
   const row=original(path,options);
   if(!changed&&typeof path==='string'&&/^\/proc\/self\/fd\/\d+\/workspace$/.test(path)){
    changed=true;
    mutate(workspace);
   }
   return row;
  };
  syncBuiltinESMExports();
  try{
   if(testChurn){
    const snapshot=open();
    build();
    assert.equal(snapshot.capture().seal.buildId,'model-build-id');
   }else assert.throws(open,/directory changed during open/);
   assert.equal(changed,true);
  }finally{
   fs.lstatSync=original;
   syncBuiltinESMExports();
  }
 });
});

test('refuses linked ancestors and stale private custody before reading build files',()=>{
 fixture(({root,workspace,temp,env,privateRoot,open})=>{
  const linked=join(root,'link');symlinkSync(workspace,linked,'dir');
  assert.throws(()=>holdDevelopmentBuildSnapshot({...env,GITHUB_WORKSPACE:linked}),/ancestor is a link/);
  rmSync(linked);symlinkSync(temp,linked,'dir');
  assert.throws(()=>holdDevelopmentBuildSnapshot({...env,RUNNER_TEMP:linked}),/ancestor is a link/);
  mkdirSync(privateRoot);const sentinel=join(privateRoot,'keep');writeFileSync(sentinel,'original');
  assert.throws(open,{code:'EEXIST'});assert.equal(readFileSync(sentinel,'utf8'),'original');
 });
});

test('refuses nested links without touching their targets or retrying a partial capture',()=>{
 fixture(({root,next,open,build})=>{
  const snapshot=open();build();
  const outside=join(root,'outside');mkdirSync(outside);
  const sentinel=join(outside,'sentinel');writeFileSync(sentinel,'outside');
  const linked=join(next,'server','app','linked');symlinkSync(outside,linked,'dir');
  assert.throws(()=>snapshot.capture(),/unsupported link/);
  assert.equal(lstatSync(linked).isSymbolicLink(),true);
  assert.equal(readFileSync(sentinel,'utf8'),'outside');
  assert.throws(()=>snapshot.capture(),/snapshot unavailable/);
 });
});

test('refuses a required alias pointed at the other canonical package and never opens a seed',()=>{
 fixture(({source,next,seed,open,build})=>{
  const snapshot=open();build();
  const alias=join(next,'node_modules',runtimeAliases[0]);
  rmSync(alias);symlinkSync(join(source,'node_modules','sharp'),alias,'dir');
  assert.throws(()=>snapshot.capture(),/runtime aliases or package identity refused/);
  assert.equal(readlinkSync(alias),join(source,'node_modules','sharp'));
  assert.equal(existsSync(seed),false);
 });
});

test('refuses an extra runtime alias and the same bytes under a replaced seed link',()=>{
 fixture(({next,seed,open,build})=>{
  const snapshot=open();build();
  symlinkSync('../../node_modules/fontkit',join(next,'node_modules','other-cccccccc'),'dir');
  assert.throws(()=>snapshot.capture(),/runtime alias inventory exceeds bound/);
  assert.equal(existsSync(seed),false);
 });
 fixture(({source,next,seed,open,build})=>{
  const snapshot=open();build();snapshot.capture();renameSync(next,join(source,'retired'));
  const alias=join(seed,'node_modules',runtimeAliases[0]),target=readlinkSync(alias);
  renameSync(alias,join(source,'held-alias'));symlinkSync(target,alias,'dir');
  assert.throws(()=>snapshot.install(),/runtime alias birth or target changed/);
  assert.equal(existsSync(next),false);
 });
});

test('refuses changed runtime dependency bytes with the same name and package version before copying',()=>{
 fixture(({source,next,open,build})=>{
  const snapshot=open();build();snapshot.capture();renameSync(next,join(source,'retired'));
  writeFileSync(join(source,'node_modules','.store','sharp','index.js'),'module.exports = 2;');
  assert.throws(()=>snapshot.install(),/runtime package bytes changed/);
  assert.equal(existsSync(next),false);
 });
});

test('refuses a build hardlink and special mode before changing either member',()=>{
 fixture(({root,next,open,build})=>{
  const snapshot=open();build();
  const outside=join(root,'outside');writeFileSync(outside,'outside');
  const linked=join(next,'server','linked');linkSync(outside,linked);
  assert.throws(()=>snapshot.capture(),/unsupported link/);
  assert.equal(lstatSync(linked).nlink,2);assert.equal(readFileSync(outside,'utf8'),'outside');
 });
 fixture(({next,open,build})=>{
  const snapshot=open();build();
  const path=join(next,'server','app','route.js');chmodSync(path,0o4666);
  assert.throws(()=>snapshot.capture(),/unsupported link, owner, mode/);
  assert.equal(lstatSync(path).mode&0o7777,0o4666);
 });
});

test('refuses a generated build root missing owner permissions without adding access',()=>{
 fixture(({next,open,build})=>{
  const snapshot=open();build();chmodSync(next,0o500);
  try{
   assert.throws(()=>snapshot.capture(),/build root lacks owner access/);
   assert.equal(lstatSync(next).mode&0o777,0o500);
  }finally{chmodSync(next,0o700);}
 });
});

test('restricts only original generated writes and seals the same modes and bytes in all three cells',()=>{
 fixture(({source,next,seed,open,build})=>{
  const snapshot=open();build();
  chmodSync(next,0o755);
  chmodSync(join(next,'node_modules'),0o777);
  chmodSync(join(next,'server'),0o777);
  chmodSync(join(next,'server','app'),0o731);
  const file='server/app/route.js';
  const raw=readFileSync(join(next,file));
  chmodSync(join(next,file),0o666);
  const initialAlias=join(next,'node_modules',runtimeAliases[0]);
  const aliasBefore=lstatSync(initialAlias,{bigint:true}),link=readlinkSync(initialAlias);
  const expectedModes={'.':0o700,node_modules:0o755,server:0o755,'server/app':0o711,[file]:0o644};
  const original=snapshot.capture();
  const aliasAfter=lstatSync(initialAlias,{bigint:true});
  assert.deepEqual([aliasAfter.ino,aliasAfter.mode,aliasAfter.ctimeNs,readlinkSync(initialAlias)],
   [aliasBefore.ino,aliasBefore.mode,aliasBefore.ctimeNs,link]);
  function check(tree){
   for(const [path,mode] of Object.entries(expectedModes))assert.equal(lstatSync(join(tree,path)).mode&0o7777,mode);
   assert.deepEqual(readFileSync(join(tree,file)),raw);
  }
  check(next);check(seed);
  for(const ordinal of [1,2]){
   renameSync(next,join(source,'retired-'+ordinal));
   const installed=snapshot.install();
   assert.deepEqual(installed.seal,original.seal);
   check(next);
  }
 });
});

test('refuses a path replacement during permission restriction and preserves the replacement',()=>{
 fixture(({next,source,open,build})=>{
  const snapshot=open();build();
  const path=join(next,'server','app','route.js');
  const moved=join(source,'moved-original');
  chmodSync(path,0o666);
  const before=lstatSync(path,{bigint:true});
  const realFchmod=fs.fchmodSync;
  let replaced=false;
  fs.fchmodSync=(fd,mode)=>{
   if(!replaced&&fs.fstatSync(fd,{bigint:true}).ino===before.ino){
    renameSync(path,moved);
    writeFileSync(path,'unowned replacement');
    chmodSync(path,0o666);
    replaced=true;
   }
   return realFchmod(fd,mode);
  };
  syncBuiltinESMExports();
  try{assert.throws(()=>snapshot.capture(),/entry changed during mode restriction/);}
  finally{fs.fchmodSync=realFchmod;syncBuiltinESMExports();}
  assert.equal(replaced,true);
  assert.equal(readFileSync(path,'utf8'),'unowned replacement');
  assert.equal(lstatSync(path).mode&0o777,0o666);
  assert.equal(readFileSync(moved,'utf8'),'const stock=1;');
 });
});

test('refuses to normalize a seed that became writable after capture',()=>{
 fixture(({source,next,seed,open,build})=>{
  const snapshot=open();build();snapshot.capture();renameSync(next,join(source,'retired'));
  const path=join(seed,'server','app','route.js');
  chmodSync(path,0o666);
  assert.throws(()=>snapshot.install(),/unsupported link, owner, mode/);
  assert.equal(lstatSync(path).mode&0o777,0o666);
  assert.equal(existsSync(next),false);
 });
});

test('refuses occupied copy names and preserves the preceding cell tree',()=>{
 fixture(({next,open,build})=>{
  const snapshot=open();build();const original=snapshot.capture();
  writeFileSync(join(next,'BUILD_ID'),'still-owned-by-previous-cell');
  assert.throws(()=>snapshot.install(),/target is occupied/);
  assert.equal(lstatSync(next,{bigint:true}).ino.toString(),original.directory.inode);
  assert.equal(readFileSync(join(next,'BUILD_ID'),'utf8'),'still-owned-by-previous-cell');
 });
});

test('refuses identical bytes under a replaced seed inode and never creates the copy',()=>{
 fixture(({next,source,privateRoot,seed,open,build})=>{
  const snapshot=open();build();snapshot.capture();renameSync(next,join(source,'retired'));
  renameSync(seed,join(privateRoot,'held-seed'));build(seed);
  assert.throws(()=>snapshot.install(),/seed name changed/);assert.equal(existsSync(next),false);
  assert.equal(readFileSync(join(seed,'BUILD_ID'),'utf8'),'model-build-id');
 });
});

test('refuses a same-size seed byte mutation even when the build ID agrees',()=>{
 fixture(({next,source,seed,open,build})=>{
  const snapshot=open();build();snapshot.capture();renameSync(next,join(source,'retired'));
  writeFileSync(join(seed,'server','app','route.js'),'const stock=2;');
  assert.throws(()=>snapshot.install(),/seed bytes changed/);assert.equal(existsSync(next),false);
 });
});

test('rejects a sparse oversized source member and malformed build ID',()=>{
 fixture(({next,open,build})=>{
  const snapshot=open();build();
  const oversized=join(next,'oversized');writeFileSync(oversized,'');truncateSync(oversized,3*1024**3+1);
  assert.throws(()=>snapshot.capture(),/byte ceiling exceeded/);
 });
 fixture(({next,open,build})=>{
  const snapshot=open();build();writeFileSync(join(next,'BUILD_ID'),'model-build-id\n');
  assert.throws(()=>snapshot.capture(),/build ID refused/);
 });
});

test('refuses a replaced checkout root and releases the local descriptors on close',()=>{
 fixture(({source,workspace,next,open})=>{
  const snapshot=open();renameSync(source,join(workspace,'moved'));mkdirSync(source);
  assert.throws(()=>snapshot.capture(),/root name changed/);assert.equal(existsSync(next),false);
  snapshot.close();snapshot.close();assert.throws(()=>snapshot.verify(),/snapshot unavailable/);
 });
});
