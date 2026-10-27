/** Adopt a verified server directory timestamp into an owned local baseline.
 * No server writes; no output filtering; every source-file difference is fatal.
 */
import assert from 'node:assert/strict';
import {lstatSync,realpathSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
export function requireOnlyRootDirectoryTime(output){
 assert(typeof output==='string'&&(output===''||output==='.d..t...... ./\n'),
  'Source difference exceeds root-directory timestamp; no alignment allowed');
 return output!=='';
}
const directory=s=>({device:s.dev.toString(),inode:s.ino.toString(),uid:s.uid.toString(),gid:s.gid.toString(),mode:Number(s.mode&0o777n),atimeNs:s.atimeNs.toString(),mtimeNs:s.mtimeNs.toString()});
function setOwnedDirectoryTimes(source,identity,atimeNs,mtimeNs){
 const code="import os,stat,sys; p,device,inode,atime,mtime=sys.argv[1:]; fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); s=os.fstat(fd); assert stat.S_ISDIR(s.st_mode) and s.st_uid==os.getuid() and str(s.st_dev)==device and str(s.st_ino)==inode; assert os.path.realpath(p)==p; os.utime(fd,ns=(int(atime),int(mtime))); after=os.lstat(p); assert (after.st_dev,after.st_ino)==(s.st_dev,s.st_ino); os.close(fd)";
 execFileSync('python3',['-I','-c',code,source,identity.device,identity.inode,atimeNs,mtimeNs],{stdio:['ignore','pipe','pipe'],timeout:5000});
}
export function alignOwnedSourceRootTime({source,readDiff,readRemote,verifyRemote,verifySource,save}){
 source=resolve(source);assert(realpathSync(source)===source&&lstatSync(source).isDirectory()&&!lstatSync(source).isSymbolicLink());
 const gitBefore=verifySource(),localBefore=directory(lstatSync(source,{bigint:true})),remoteBefore=readRemote();verifyRemote(remoteBefore);
 const rawBefore=readDiff(),needed=requireOnlyRootDirectoryTime(rawBefore);
 assert.deepEqual(readRemote(),remoteBefore,'Server root changed during full checksum');
 if(needed)setOwnedDirectoryTimes(source,localBefore,localBefore.atimeNs,remoteBefore.directory.mtimeNs);
 const rawAfter=readDiff();assert.equal(rawAfter,'','Actual canonical source checksum is not empty after local metadata alignment');
 assert.deepEqual(verifySource(),gitBefore,'Retained source identity changed');
 const remoteAfter=readRemote();verifyRemote(remoteAfter);assert.deepEqual(remoteAfter,remoteBefore,'Server changed during alignment');
 if(needed)setOwnedDirectoryTimes(source,localBefore,localBefore.atimeNs,remoteBefore.directory.mtimeNs);
 const localAfter=directory(lstatSync(source,{bigint:true}));
 for(const key of ['device','inode','uid','gid','mode'])assert.equal(localAfter[key],localBefore[key],'Local directory identity/ownership changed');
 if(needed){assert.equal(localAfter.atimeNs,localBefore.atimeNs,'Local atime not preserved');assert.equal(localAfter.mtimeNs,remoteBefore.directory.mtimeNs,'Nanosecond directory time differs');}
 const proof={kind:'LOCAL_SOURCE_ROOT_TIME_ALIGNMENT_NOT_RELEASE',rawBefore,rawAfter,sourceIdentity:gitBefore,localBefore,localAfter,remoteBefore,remoteAfter,localDirectoryTimeAligned:needed,serverWritten:false,sourceFilesWritten:false,receiptFiltered:false,observedAt:new Date().toISOString()};
 save(proof);return proof;
}

