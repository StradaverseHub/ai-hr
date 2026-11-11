/** Transport fixtures only: tiny owned children, no app, database, compiler or external network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,symlinkSync,chmodSync,existsSync,statSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BUILD_ARTIFACT,BUILD_ZIP_MAX} from './build-artifact.mjs';
import {downloadCiArchives,readCiArchive} from './archive-downloads.mjs';
const payload=Buffer.from('immutable fixture bytes 中文\n');
const digest=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const artifact=(id=1)=>({id,name:'unit-fixture-'+id,expired:false,size_in_bytes:payload.length,digest:digest(payload)});
function directory(t){const path=realpathSync(mkdtempSync(join(tmpdir(),'archive-fixture-')));chmodSync(path,0o700);t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
function transport({bytes=payload,code=0,delay=0,stderr='',hang=false}={}){
 return ()=>spawn(process.execPath,['-e',`process.stdout.write(Buffer.from(${JSON.stringify(bytes.toString('hex'))},'hex'));process.stderr.write(${JSON.stringify(stderr)});${hang?'setInterval(()=>{},1000);':`setTimeout(()=>process.exit(${code}),${delay});`}`],{stdio:['ignore','pipe','pipe']});
}
test('exact streamed bytes and a second bounded read preserve digest, mode and no release authority',async t=>{
 const dir=directory(t),a=artifact(),r=await downloadCiArchives([a],dir,{start:transport()});assert.equal(r.releaseAuthorized,false);assert.equal(r.artifacts[0].status,'verified');assert.equal(r.artifacts[0].bytes,payload.length);
 assert.deepEqual(readCiArchive(a,r.artifacts[0].path),payload);assert.equal(statSync(r.artifacts[0].path).mode&0o777,0o600);
});
test('worker pool overlaps bounded independent transfers and retains every exact identity',async t=>{
 const dir=directory(t),list=Array.from({length:7},(_,i)=>artifact(i+1));let active=0,peak=0;
 const start=a=>{active++;peak=Math.max(peak,active);const child=transport({delay:30})(a);child.once('close',()=>active--);return child;};
 const r=await downloadCiArchives(list,dir,{concurrency:4,start});assert.equal(peak,4);assert.equal(active,0);assert.deepEqual(r.artifacts.map(x=>x.id),list.map(x=>x.id));assert(r.artifacts.every(x=>x.digest===digest(payload)));
});
test('invalid or duplicate metadata refuses before opening a child or destination',async t=>{
 const dir=directory(t);let starts=0;const start=()=>{starts++;throw Error('must not start');};
 for(const list of [[],[artifact(),artifact()],[{...artifact(),id:0}],[{...artifact(),name:'../escape'}],[{...artifact(),name:'unsafe/name'}],[{...artifact(),expired:true}],[{...artifact(),digest:'sha256:bad'}],[{...artifact(),size_in_bytes:64*1024**2+1}]])await assert.rejects(downloadCiArchives(list,dir,{start}));
 for(const concurrency of [0,5,Infinity,1.5])await assert.rejects(downloadCiArchives([artifact()],dir,{start,concurrency}));assert.equal(starts,0);assert(!existsSync(join(dir,'unit-fixture-1.zip')));
});
test('changed digest, truncated bytes, oversized bytes and nonzero exit never become verified inputs',async t=>{
 for(const options of [{bytes:Buffer.alloc(payload.length,65)},{bytes:payload.subarray(1)},{bytes:Buffer.concat([payload,Buffer.from('x')])},{code:3}]){
  const dir=directory(t);await assert.rejects(downloadCiArchives([artifact()],dir,{start:transport(options)}),e=>{assert.equal(e.report.artifacts[0].status,'failed');assert.equal(e.report.releaseAuthorized,false);return true;});
 }
});
test('deadline kills only the owned transfer and refuses a partial archive',async t=>{
 const dir=directory(t);let child;await assert.rejects(downloadCiArchives([artifact()],dir,{timeoutMs:150,start:a=>(child=transport({hang:true})(a))}));assert(child.exitCode!==null||child.signalCode==='SIGKILL');
});
test('one failed artifact does not erase separately valid completed evidence',async t=>{
 const dir=directory(t),list=[artifact(1),artifact(2),artifact(3)];await assert.rejects(downloadCiArchives(list,dir,{start:a=>transport({code:a.id===2?1:0})(a)}),e=>{assert.equal(e.report.artifacts.filter(x=>x.status==='verified').length,2);assert.equal(e.report.artifacts[1].status,'failed');return true;});
 assert.deepEqual(readCiArchive(list[0],join(dir,list[0].name+'.zip')),payload);
});
test('private directory and no-overwrite boundaries refuse redirection or replacement',async t=>{
 const dir=directory(t),parent=directory(t),link=join(parent,'linked');symlinkSync(dir,link);await assert.rejects(downloadCiArchives([artifact()],link,{start:transport()}));
 chmodSync(dir,0o755);await assert.rejects(downloadCiArchives([artifact()],dir,{start:transport()}));chmodSync(dir,0o700);
 const path=join(dir,artifact().name+'.zip');writeFileSync(path,'retained');await assert.rejects(downloadCiArchives([artifact()],dir,{start:transport()}));assert.equal(readFileSync(path,'utf8'),'retained');
});
test('post-download corruption, truncation, growth and symlinks refuse before extraction',async t=>{
 for(const value of [Buffer.alloc(payload.length,65),payload.subarray(1),Buffer.concat([payload,Buffer.from('x')])]){
  const dir=directory(t),a=artifact();const r=await downloadCiArchives([a],dir,{start:transport()});writeFileSync(r.artifacts[0].path,value);assert.throws(()=>readCiArchive(a,r.artifacts[0].path));
 }
 const dir=directory(t),target=join(dir,'target'),link=join(dir,'link');writeFileSync(target,payload);symlinkSync(target,link);assert.throws(()=>readCiArchive(artifact(),link));
});

test('large authenticated archive starts first while results retain the original inventory order',async t=>{
 const dir=directory(t),sizes=[1,9,3],data=new Map(sizes.map((n,i)=>[i+1,Buffer.alloc(n,65+i)])),list=sizes.map((n,i)=>({...artifact(i+1),size_in_bytes:n,digest:digest(data.get(i+1))})),started=[];
 const r=await downloadCiArchives(list,dir,{concurrency:1,start:a=>{started.push(a.id);return transport({bytes:data.get(a.id)})(a);}});
 assert.deepEqual(started,[2,3,1]);assert.deepEqual(r.artifacts.map(a=>a.id),[1,2,3]);assert.equal(r.scheduling,'largest-authenticated-archive-first');
});

test('authenticated prefetched bytes avoid repeat transport and keep separate immutable output',async t=>{
 const cache=directory(t),dir=directory(t),a=artifact();writeFileSync(join(cache,a.name+'.zip'),payload,{mode:0o600});let starts=0;
 const r=await downloadCiArchives([a],dir,{prefetchDirectory:cache,start:()=>{starts++;throw Error('no repeated transfer');}});
 assert.equal(starts,0);assert.equal(r.releaseAuthorized,false);assert.equal(r.artifacts[0].reusedPrefetch,true);
 assert.deepEqual(readCiArchive(a,join(dir,a.name+'.zip')),payload);assert.deepEqual(readFileSync(join(cache,a.name+'.zip')),payload);
 assert.notEqual(statSync(join(cache,a.name+'.zip')).ino,statSync(join(dir,a.name+'.zip')).ino);
});
test('partial prefetch fetches missing artifacts only and preserves authenticated inventory order',async t=>{
 const cache=directory(t),dir=directory(t),list=[artifact(1),artifact(2)];writeFileSync(join(cache,list[0].name+'.zip'),payload,{mode:0o600});const starts=[];
 const r=await downloadCiArchives(list,dir,{prefetchDirectory:cache,start:a=>{starts.push(a.id);return transport()(a);}});
 assert.deepEqual(starts,[2]);assert.deepEqual(r.artifacts.map(a=>a.id),[1,2]);assert(r.artifacts[0].reusedPrefetch);assert(!r.artifacts[1].reusedPrefetch);
});
test('altered prefetch is refused against final API metadata without silently redownloading',async t=>{
 for(const bytes of [payload.subarray(1),Buffer.alloc(payload.length,65),Buffer.concat([payload,Buffer.from('x')])]){
  const cache=directory(t),dir=directory(t),a=artifact();writeFileSync(join(cache,a.name+'.zip'),bytes,{mode:0o600});let starts=0;
  await assert.rejects(downloadCiArchives([a],dir,{prefetchDirectory:cache,start:()=>{starts++;throw Error('must refuse');}}));assert.equal(starts,0);
 }
});
test('prefetch symlinks, public files/directories and output alias refuse',async t=>{
 const cache=directory(t),dir=directory(t),a=artifact(),target=join(cache,'target');writeFileSync(target,payload,{mode:0o600});symlinkSync(target,join(cache,a.name+'.zip'));
 await assert.rejects(downloadCiArchives([a],dir,{prefetchDirectory:cache,start:transport()}));
 const publicCache=directory(t);writeFileSync(join(publicCache,a.name+'.zip'),payload,{mode:0o644});await assert.rejects(downloadCiArchives([a],directory(t),{prefetchDirectory:publicCache,start:transport()}));
 chmodSync(publicCache,0o755);await assert.rejects(downloadCiArchives([a],directory(t),{prefetchDirectory:publicCache,start:transport()}));
 await assert.rejects(downloadCiArchives([a],cache,{prefetchDirectory:cache,start:transport()}));
});


test('build namespace alone reaches the unchanged280MiB metadata boundary; +1 refuses before transport',async t=>{
 assert.equal(BUILD_ZIP_MAX,293601280);
 for(const size of [BUILD_ZIP_MAX,BUILD_ZIP_MAX+1]){
  let starts=0;const dir=directory(t),a={...artifact(),name:BUILD_ARTIFACT,size_in_bytes:size};
  await assert.rejects(downloadCiArchives([a],dir,{start:()=>{starts++;throw Error('metadata-only transfer probe');}}));
  assert.equal(starts,size===BUILD_ZIP_MAX?1:0,'Exact boundary reaches transport; oversized metadata never opens a child');
 }
 for(const name of ['unit-fixture-1','diagnostic-build-transport-producer']){
  let starts=0;await assert.rejects(downloadCiArchives([{...artifact(),name,size_in_bytes:64*1024**2+1}],directory(t),{start:()=>{starts++;throw Error('must not start');}}));assert.equal(starts,0);
 }
});
test('build-prefetch still validates authenticated exact bytes before copy and refuses stream overflow',async t=>{
 const a={...artifact(),name:BUILD_ARTIFACT};
 const cache=directory(t),dir=directory(t);writeFileSync(join(cache,a.name+'.zip'),payload,{mode:0o600});
 const r=await downloadCiArchives([a],dir,{prefetchDirectory:cache,start:()=>{throw Error('must use intact cache');}});
 assert.deepEqual(readCiArchive(a,r.artifacts[0].path),payload);assert.equal(r.artifacts[0].reusedPrefetch,true);
 const alteredCache=directory(t);writeFileSync(join(alteredCache,a.name+'.zip'),Buffer.alloc(payload.length,65),{mode:0o600});let starts=0;
 await assert.rejects(downloadCiArchives([a],directory(t),{prefetchDirectory:alteredCache,start:()=>{starts++;throw Error('must not redownload');}}));assert.equal(starts,0);
 await assert.rejects(downloadCiArchives([a],directory(t),{start:transport({bytes:Buffer.concat([payload,Buffer.from('x')])})}));
});
