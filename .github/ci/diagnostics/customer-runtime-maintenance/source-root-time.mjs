/** Adopt a verified server directory timestamp into an owned local baseline.
 * No server writes; no output filtering; every source-file difference is fatal.
 */
import assert from 'node:assert/strict';
import {lstatSync,realpathSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {retainedSourceIdentity} from './source-proof.mjs';
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

async function main(){
 const[candidate,source,planPath,sshConfig,expectedRootPath,output]=process.argv.slice(2);
 assert(output&&process.argv.length===8,'Usage: source-root-time.mjs <candidate> <retained-source> <plan> <SSH-config> <root-before-json> <new-proof>');
 const root=resolve(candidate),plan=JSON.parse(readFileSync(planPath)),expectedRoot=JSON.parse(readFileSync(expectedRootPath));
 const git=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8'}).trim();
 assert(git('rev-parse','HEAD')===plan.candidate&&git('status','--porcelain')==='');
 const load=async name=>{const raw=await import(pathToFileURL(join(root,name)).href);return{...(raw.default??{}),...raw};};
 const official=await load('scripts/improve/release.ts');const{stagingTransport}=await load('.github/ci/staging-transport.mjs');
 const transport=stagingTransport(root,{...process.env,AIHR_SSH_CONFIG:resolve(sshConfig)});
 const code=String.raw`import os,stat,json,hashlib
root='/opt/ai-hr'
assert os.path.realpath(root)==root
s=os.lstat(root);assert stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode)
def fields(name):
 return dict(line.split('=',1) for line in open(name).read().splitlines() if '=' in line)
current=fields('/var/tmp/aihr-deploy/current');last=fields('/var/tmp/aihr-deploy/last-ok')
active=os.lstat(root+'/.next')
env=root+'/.env.production';fd=os.open(env,os.O_RDONLY|os.O_NOFOLLOW)
with os.fdopen(fd,'rb') as f:env_sha=hashlib.sha256(f.read()).hexdigest()
unit='/etc/systemd/system/aihr.service.d/40-customer-node22.conf'
unit_sha=None
if os.path.lexists(unit):
 fd=os.open(unit,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as f:unit_sha=hashlib.sha256(f.read()).hexdigest()
print(json.dumps({'directory':{'device':str(s.st_dev),'inode':str(s.st_ino),'uid':str(s.st_uid),'gid':str(s.st_gid),'mode':stat.S_IMODE(s.st_mode),'mtimeNs':str(s.st_mtime_ns)},'currentRef':current['ref'],'currentResult':current['result'],'lastOkRef':last['ref'],'buildId':open(root+'/.next/BUILD_ID').read().strip(),'activeDirectory':{'device':str(active.st_dev),'inode':str(active.st_ino)},'pending':os.path.lexists('/var/tmp/aihr-deploy/pending'),'environmentSha256':env_sha,'unitSha256':unit_sha}))
`;
 const readRemote=()=>JSON.parse(execFileSync('ssh',transport.sshArgs('python3 -I -'),{input:code,encoding:'utf8',timeout:30000,maxBuffer:65536,stdio:['pipe','pipe','pipe']}));
 const verifyRemote=value=>{
  for(const key of ['device','inode','uid','gid','mode'])assert.equal(value.directory[key],expectedRoot.directory[key],'Actual source-root identity/ownership differs');
  assert(value.currentRef===plan.baseline&&value.currentResult==='ok'&&value.lastOkRef===plan.baseline&&value.buildId===plan.snapshot.baseline.buildId&&!value.pending,'Retained real baseline required');
  assert.deepEqual(value.activeDirectory,{device:String(plan.snapshot.baseline.activeDirectory.device),inode:String(plan.snapshot.baseline.activeDirectory.inode)});
  assert([plan.snapshot.proposal.environment.originalSha256,plan.snapshot.proposal.environment.proposedSha256].includes(value.environmentSha256),'Unreviewed private configuration');
  assert(value.unitSha256===null||value.unitSha256===plan.snapshot.proposal.unit.sha256,'Unreviewed service drop-in');
 };
 const readDiff=()=>execFileSync('rsync',['--dry-run','--checksum','--itemize-changes',...transport.rsyncArgs(official,resolve(source))],{encoding:'utf8',timeout:120000,maxBuffer:8*1024**2});
 const proof=alignOwnedSourceRootTime({source,readDiff,readRemote,verifyRemote,verifySource:()=>retainedSourceIdentity(source,plan.baseline),save:p=>writeFileSync(output,JSON.stringify(p,null,2)+'\n',{flag:'wx',mode:0o600})});
 console.log(JSON.stringify({kind:proof.kind,localDirectoryTimeAligned:proof.localDirectoryTimeAligned,rawBefore:proof.rawBefore,rawAfter:proof.rawAfter,serverWritten:false,sourceFilesWritten:false,sourceIdentity:proof.sourceIdentity}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
