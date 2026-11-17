/** Preparation only, as the ordinary frozen-checkout owner. Generates content evidence, never cutover authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync,readlinkSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {resolve,join,relative,isAbsolute,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const [input,source,output]=process.argv.slice(2),root=realpathSync(input);
assert(process.getuid()>0,'Inventory preparation runs only as the ordinary frozen-checkout owner');
const parent=dirname(resolve(output)),parentStat=lstatSync(parent);
assert(isAbsolute(output)&&resolve(output)===output&&realpathSync(parent)===parent&&parentStat.isDirectory()&&!parentStat.isSymbolicLink()&&parentStat.uid===process.getuid()&&(parentStat.mode&0o077)===0,'Canonical private owned output parent required');
assert(process.argv.length===5&&/^[a-f0-9]{40}$/.test(source),'Exact frozen checkout, full source and private output required');
assert(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()===source,'Frozen checkout HEAD differs');
assert(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8',maxBuffer:4*1024**2}).trim()==='','Frozen checkout must satisfy normal cleanHead; ignored canonical extras are still inventoried');
const official=await import(pathToFileURL(join(root,'scripts/improve/release.ts')).href);
const deploymentRsyncArgs=official.deploymentRsyncArgs??official.default?.deploymentRsyncArgs;
assert(typeof deploymentRsyncArgs==='function','Canonical deployment owner export missing');
const {canonicalSourceExclusions}=await import(pathToFileURL(join(root,'.github/ci/normal-cleanup-fences.mjs')).href);
const args=deploymentRsyncArgs(root,'unused:/'),filters=args.flatMap((v,i)=>v==='--exclude'?[args[i+1]]:[]),excluded=canonicalSourceExclusions(args);
const relOutput=relative(root,resolve(output));
assert(relOutput.startsWith('..')||isAbsolute(relOutput)||excluded(relOutput),'Inventory output must be outside canonical included source');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),entries=[];
const identity=s=>[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].map(String);
function walk(path,relative=''){
 assert(entries.length<200000,'Bounded full canonical inventory required');
 const before=lstatSync(path,{bigint:true}),s=lstatSync(path),mode=s.mode&0o7777;
 if(s.isDirectory()){
  entries.push({path:relative,kind:'directory',mode});
  const names=readdirSync(path).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  for(const name of names){const child=relative?relative+'/'+name:name;if(!excluded(child))walk(join(path,name),child);}
  assert.deepEqual(readdirSync(path).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))),names,'Source directory changed');
 }else if(s.isFile()){
  assert(s.nlink===1&&s.size<=256*1024**2,'Bounded non-linked source file required');entries.push({path:relative,kind:'file',mode,sha256:hash(readFileSync(path))});
 }else if(s.isSymbolicLink()){
  const target=readlinkSync(path),resolved=realpathSync(path);assert(!isAbsolute(target)&&resolved!==root&&resolved.startsWith(root+'/'),'Source link must remain inside frozen tree');
  entries.push({path:relative,kind:'link',mode,target});
 }else assert.fail('Special source node refused');
 assert.deepEqual(identity(lstatSync(path,{bigint:true})),identity(before),'Source node changed while hashing');
}
walk(root);
assert(entries.length>100,'Nonempty complete source required');
const result={format:1,kind:'CANONICAL_FROZEN_SOURCE_CONTENT_INVENTORY',policy:'aihr-worker-ci-runtime/v1',source,filters,entries,
 releaseSha256:hash(readFileSync(join(root,'scripts/improve/release.ts'))),filterOwnerSha256:hash(readFileSync(join(root,'.github/ci/normal-cleanup-fences.mjs')))};
const bytes=JSON.stringify(result)+'\n';writeFileSync(output,bytes,{mode:0o600,flag:'wx'});
console.log(JSON.stringify({manifestSha256:hash(bytes),includedNodes:entries.length,releaseAuthorized:false}));
