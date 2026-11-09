/** Filesystem models for the hosted Linux byte owner. No Next build or worker starts here. */
import assert from 'node:assert/strict';
import {chmodSync,existsSync,linkSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,symlinkSync,truncateSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {holdDevelopmentBuildSnapshot} from './worker-comparison-build.mjs';

const privateName='aihr-worker-comparison-next';
const sourceSha='a'.repeat(40);
function fixture(work){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'aihr-build-snapshot-model-'));
 const workspace=join(root,'workspace'),source=join(workspace,'source'),temp=join(root,'temp');
 const next=join(source,'.next'),privateRoot=join(temp,privateName),seed=join(privateRoot,'seed');
 mkdirSync(source,{recursive:true});mkdirSync(temp);
 const env={GITHUB_WORKSPACE:workspace,RUNNER_TEMP:temp,GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',
  RUNNER_OS:'Linux',RUNNER_ARCH:'X64',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',
  GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW:'alpha-focused-checks',GITHUB_JOB:'selected-tests',
  GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'12345',AIHR_CI_HEAD:sourceSha,AIHR_CI_CONTROL_HEAD:sourceSha,GITHUB_SHA:sourceSha,GITHUB_WORKFLOW_SHA:sourceSha};
 let snapshot;
 const open=()=>snapshot=holdDevelopmentBuildSnapshot(env);
 const build=(path=next)=>{
  mkdirSync(join(path,'server','app'),{recursive:true});
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
  assert.equal(original.seal.buildId,'model-build-id');assert.equal(original.seal.entries,6);
  assert.equal(original.seal.bytes,Buffer.byteLength('model-build-idconst stock=1;'));
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

test('refuses a build hardlink and a writable foreign mode',()=>{
 fixture(({root,next,open,build})=>{
  const snapshot=open();build();
  const outside=join(root,'outside');writeFileSync(outside,'outside');
  const linked=join(next,'server','linked');linkSync(outside,linked);
  assert.throws(()=>snapshot.capture(),/unsupported link/);
  assert.equal(lstatSync(linked).nlink,2);assert.equal(readFileSync(outside,'utf8'),'outside');
 });
 fixture(({next,open,build})=>{
  const snapshot=open();build();
  const path=join(next,'server','app','route.js');chmodSync(path,0o666);
  assert.throws(()=>snapshot.capture(),/unsupported link, owner, mode/);
  assert.equal(lstatSync(path).mode&0o777,0o666);
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
