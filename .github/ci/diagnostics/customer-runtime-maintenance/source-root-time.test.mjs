import test from 'node:test';
import assert from 'node:assert/strict';
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,lstatSync,renameSync,utimesSync,rmSync,unlinkSync,chmodSync}from'node:fs';
import{tmpdir}from'node:os';import{join}from'node:path';import{execFileSync}from'node:child_process';
import{alignOwnedSourceRootTime,requireOnlyRootDirectoryTime}from'./source-root-time.mjs';
const meta=p=>{const s=lstatSync(p,{bigint:true});return{device:s.dev.toString(),inode:s.ino.toString(),uid:s.uid.toString(),gid:s.gid.toString(),mode:Number(s.mode&0o777n),mtimeNs:s.mtimeNs.toString()};};
function fixture(run){
 const root=mkdtempSync(join(tmpdir(),'aihr-source-time-'));const source=join(root,'source'),server=join(root,'server');mkdirSync(source);mkdirSync(server);
 writeFileSync(join(source,'app.js'),'immutable baseline code\n');writeFileSync(join(server,'.env.production'),'original private fixture\n');
 const old=Math.floor(Date.now()/1000)-1000;utimesSync(source,old,old);
 const rsync=(...args)=>execFileSync('rsync',args,{encoding:'utf8',timeout:5000});
 rsync('-a','--exclude','.env*',source+'/',server+'/');
 const diff=()=>rsync('--dry-run','--checksum','--itemize-changes','-a','--delete','--exclude','.env*',source+'/',server+'/');
 const replaceEnv=value=>{writeFileSync(join(server,'.env.private-temp'),value);renameSync(join(server,'.env.private-temp'),join(server,'.env.production'));};
 const beforeServer=meta(server);let proof;
 const align=()=>alignOwnedSourceRootTime({source,readDiff:diff,readRemote:()=>({directory:meta(server)}),verifyRemote:r=>{for(const k of['device','inode','uid','gid','mode'])assert.equal(r.directory[k],beforeServer[k]);},verifySource:()=>({retainedSourceRef:'fictional-exact-baseline',tree:'same-tree'}),save:p=>{proof=p;}});
 try{run({source,server,diff,replaceEnv,align,getProof:()=>proof});}finally{rmSync(root,{recursive:true,force:true});}
}
test('real Linux atomic private-env rename changes only root time; exact local adoption preserves all data',()=>fixture(f=>{
 assert.equal(f.diff(),'');f.replaceEnv('approved new private fixture\n');assert.equal(f.diff(),'.d..t...... ./\n');
 const env=readFileSync(join(f.server,'.env.production')),app=readFileSync(join(f.source,'app.js'));const remoteBefore=meta(f.server);const atime=lstatSync(f.source,{bigint:true}).atimeNs.toString();
 f.align();const p=f.getProof();assert.equal(p.rawBefore,'.d..t...... ./\n');assert.equal(p.rawAfter,'');
 assert.equal(p.localAfter.mtimeNs,remoteBefore.mtimeNs);assert.equal(p.localAfter.atimeNs,p.localBefore.atimeNs);
 assert(readFileSync(join(f.server,'.env.production')).equals(env));assert(readFileSync(join(f.source,'app.js')).equals(app));assert.deepEqual(meta(f.server),remoteBefore);
 assert.equal(p.serverWritten,false);assert.equal(p.receiptFiltered,false);assert.equal(f.diff(),'');
}));
test('pre-release env restoration changes parent time again; same strict local preservation works',()=>fixture(f=>{
 f.replaceEnv('new private fixture\n');f.align();assert.equal(f.diff(),'');
 f.replaceEnv('restored original private fixture\n');f.align();assert.equal(f.diff(),'');
 assert.equal(readFileSync(join(f.server,'.env.production'),'utf8'),'restored original private fixture\n');
 assert.equal(f.getProof().serverWritten,false);
}));
test('already-empty source comparison does not adopt any timestamp',()=>fixture(f=>{
 const before=meta(f.source);f.align();assert.equal(f.getProof().localDirectoryTimeAligned,false);assert.deepEqual(meta(f.source),before);
}));
test('changed source bytes with identical build markers stay fatal and untouched',()=>fixture(f=>{
 f.replaceEnv('new fixture\n');writeFileSync(join(f.server,'app.js'),'unexpected drift\n');
 const before=meta(f.source);assert.throws(()=>f.align(),/exceeds root-directory timestamp/);assert.deepEqual(meta(f.source),before);assert.equal(readFileSync(join(f.server,'app.js'),'utf8'),'unexpected drift\n');assert.equal(f.getProof(),undefined);
}));
test('extra and deleted source entries are never reconciled',()=>{
 for(const change of['add','delete'])fixture(f=>{
  f.replaceEnv('new fixture\n');if(change==='add')writeFileSync(join(f.server,'unexpected.js'),'unexpected');else unlinkSync(join(f.server,'app.js'));
  const before=meta(f.source);assert.throws(()=>f.align(),/exceeds root-directory timestamp/);assert.deepEqual(meta(f.source),before);assert.equal(f.getProof(),undefined);
 });
});
test('permission, file-time and other directory-path drift are refused',()=>{
 for(const raw of['.d...p..... ./\n','.f..t...... app.js\n','.d..t...... nested/\n','.d..tp..... ./\n','*deleting extra.js\n'])assert.throws(()=>requireOnlyRootDirectoryTime(raw));
});
