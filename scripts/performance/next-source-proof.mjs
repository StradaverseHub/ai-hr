/** Nonroot Git object collection only; root independently verifies every object. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {realpathSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';

const OID=/^[a-f0-9]{40}$/;
const objectId=(kind,bytes)=>createHash('sha1').update(kind+' '+bytes.length+'\0').update(bytes).digest('hex');
export function collectNativeSourceProof(directory,candidate){
 assert(process.platform==='linux'&&process.getuid()>0,'Git collection requires the actual nonroot Linux wrapper');
 assert(OID.test(candidate)&&realpathSync(directory)===directory);
 const info=lstatSync(directory);assert(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid());
 const env={PATH:'/usr/bin:/bin',HOME:'/var/empty/aihr',LANG:'C',LC_ALL:'C',
  GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'};
 const git=(args,options={})=>execFileSync('/usr/bin/git',['--literal-pathspecs','-c','core.fsmonitor=false',
  '-c','core.hooksPath=/dev/null','-c','core.pager=cat',...args],
  {cwd:directory,env,timeout:20000,maxBuffer:72*1024**2,...options});
 assert.equal(git(['rev-parse','HEAD']).toString().trim(),candidate);
 assert.equal(git(['status','--porcelain=v1','--untracked-files=no']).length,0,'Tracked source changed before native packaging');
 const commit=git(['cat-file','commit',candidate],{maxBuffer:65536});
 assert.equal(objectId('commit',commit),candidate);
 const root=/^tree ([a-f0-9]{40})\n/.exec(commit.toString('utf8'))?.[1];assert(root);
 const inventory=git(['ls-tree','-r','-d','-z',candidate],{maxBuffer:16*1024**2});
 assert(inventory.length===0||inventory.at(-1)===0,'Complete directory tree inventory required');
 const objects=new Set([root]);
 for(const record of inventory.toString('utf8').split('\0').filter(Boolean)){
  const match=/^040000 tree ([a-f0-9]{40})\t/.exec(record);assert(match,'Unexpected Git tree inventory record');objects.add(match[1]);
 }
 const ids=[...objects].sort();assert(ids.length>0&&ids.length<=50000);
 const batch=git(['cat-file','--batch'],{input:ids.join('\n')+'\n'});
 const trees=[];let offset=0,total=0;
 for(const oid of ids){
  const end=batch.indexOf(10,offset);assert(end>=offset&&end-offset<=128);
  const header=/^([a-f0-9]{40}) tree ([0-9]+)$/.exec(batch.subarray(offset,end).toString('ascii'));
  assert(header&&header[1]===oid);const size=Number(header[2]);
  assert(Number.isSafeInteger(size)&&size>=0&&size<=16*1024**2);total+=size;assert(total<=64*1024**2);
  const start=end+1;assert(start+size<batch.length&&batch[start+size]===10);
  const bytes=batch.subarray(start,start+size);assert.equal(objectId('tree',bytes),oid);
  trees.push({oid,bytes:bytes.toString('base64')});offset=start+size+1;
 }
 assert.equal(offset,batch.length,'Unexpected trailing Git object data');
 assert.equal(git(['rev-parse','HEAD']).toString().trim(),candidate);
 assert.equal(git(['status','--porcelain=v1','--untracked-files=no']).length,0,'Tracked source changed during native packaging');
 return {version:1,source:candidate,commit:commit.toString('base64'),trees};
}
