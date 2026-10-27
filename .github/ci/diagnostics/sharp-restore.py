"""Restore only the authenticated generated Sharp shim; never installs, migrates or restarts."""
import base64,hashlib,json,os,pathlib,re,runpy,stat,subprocess,sys
BUNDLE_PATH=pathlib.Path('/opt/ai-hr/.github/ci/build-bundle.py') if __name__=='__main__' else pathlib.Path(__file__).resolve().parents[1]/'build-bundle.py'
M=runpy.run_path(str(BUNDLE_PATH))
PRODUCER='/home/runner/work/ai-hr/ai-hr/source'
CI_SHA='b6c0f6603f483295ef4d82f60123febc7d9a57584a56918349c0a7f7a2e514e6'
OLD_ID='2024815a-9960-4c16-8121-0f3cf1f727af'
def digest(b):return hashlib.sha256(b).hexdigest()
def exact_host_bytes(ci,source):
 assert digest(ci)==CI_SHA,'Exact authenticated CI shim required'
 desired=M['rebase_installer_shim'](ci,pathlib.Path(PRODUCER),str(source))
 assert M['rebase_installer_shim'](desired,source,PRODUCER)==ci,'Exact inverse rebase required'
 return desired

def restore(source,ci,old,backup,authority,*,apply=False,uid=None):
 source=pathlib.Path(source);uid=os.getuid() if uid is None else uid
 before_context=authority()
 assert source.resolve()==source
 ci_bytes=base64.b64decode(ci['shim']['rawBase64'],validate=True);desired=exact_host_bytes(ci_bytes,source)
 assert digest(M['canonical'](ci['rows']))==ci['descriptor']['packageTreeSha256']
 actual,target=M['package_identity'](source,'sharp',producer_source=PRODUCER)
 assert actual==old['descriptor'],'Original complete package identity changed'
 expected={v['path']:v for v in ci['rows']};observed={v['path']:v for v in old['rows']}
 assert len(expected)==len(observed) and set(expected)==set(observed)
 assert [p for p in expected if expected[p]!=observed[p]]==['node_modules/.bin/semver'],'Only the known generated shim may differ'
 path=target/'node_modules/.bin/semver';parent=path.parent
 assert parent.resolve()==parent and parent.is_dir() and not parent.is_symlink()
 fd=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 temp='semver.ci-restore-temporary';temp_identity=None;replaced=False
 try:
  original_fd=os.open('semver',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
  try:
   st=os.fstat(original_fd);assert stat.S_ISREG(st.st_mode) and st.st_uid==uid and st.st_nlink==1 and stat.S_IMODE(st.st_mode)==0o755
   original=os.read(original_fd,16385);assert len(original)<=16384 and digest(original)==old['shim']['rawSha256']
   assert M['identity'](os.fstat(original_fd))==M['identity'](os.stat('semver',dir_fd=fd,follow_symlinks=False))==M['identity'](st)
  finally:os.close(original_fd)
  short=(parent/'../../../semver/bin/semver.js').resolve(strict=True)
  long=(parent/'../../../../../semver@7.8.5/node_modules/semver/bin/semver.js').resolve(strict=True)
  assert short==long and short.is_relative_to(source/'node_modules') and short.is_file(),'Both launchers must select the same locked dependency'
  if not apply:return {'kind':'SHARP_SHIM_RESTORATION_PREVIEW','originalSha256':digest(original),'desiredSha256':digest(desired),'written':False}
  backup=pathlib.Path(backup);backup.mkdir(mode=0o700);assert backup.resolve()==backup and backup.stat().st_uid==uid and stat.S_IMODE(backup.stat().st_mode)==0o700
  saved=os.open(backup/'semver.original',os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
  with os.fdopen(saved,'wb') as f:f.write(original);f.flush();os.fsync(f.fileno())
  assert digest((backup/'semver.original').read_bytes())==digest(original)
  out=os.open(temp,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600,dir_fd=fd)
  with os.fdopen(out,'wb') as f:
   f.write(desired);f.flush();os.fchmod(f.fileno(),stat.S_IMODE(st.st_mode));os.fsync(f.fileno());temp_identity=M['identity'](os.fstat(f.fileno()))
  assert M['identity'](os.stat('semver',dir_fd=fd,follow_symlinks=False))==M['identity'](st)
  assert authority()==before_context,'Actual authority or failed context changed'
  os.replace(temp,'semver',src_dir_fd=fd,dst_dir_fd=fd);replaced=True;os.fsync(fd)
  installed=os.stat('semver',dir_fd=fd,follow_symlinks=False);assert M['identity'](installed)[:4]==temp_identity[:4];temp_identity=M['identity'](installed)
  after,_=M['package_identity'](source,'sharp',producer_source=PRODUCER)
  assert after==ci['descriptor'],'The unchanged original full package hash must match CI'
  assert authority()==before_context,'Actual authority or failed context changed after restoration'
  result={'authority':before_context,'kind':'EXACT_CI_SHARP_GENERATED_SHIM_RESTORED','oldRawSha256':digest(original),'newRawSha256':digest(desired),'completePackage':after,'sameCanonicalSemverTarget':str(short),'onlyGeneratedShimWritten':True,'integrityPolicyChanged':False,'applicationBuildRun':False}
  (backup/'restoration.json').write_text(json.dumps(result,indent=2)+'\n');return result
 except BaseException as error:
  if replaced:
   # Revert only the inode and bytes this invocation installed. Never overwrite a peer's replacement.
   current=os.stat('semver',dir_fd=fd,follow_symlinks=False)
   assert M['identity'](current)==temp_identity,'Restored shim changed externally; retained backup requires operator review'
   check=os.open('semver',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
   try:assert os.read(check,16385)==desired,'Restored shim bytes changed externally'
   finally:os.close(check)
   rollback='semver.ci-restore-rollback'
   recovery=os.open(rollback,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600,dir_fd=fd)
   with os.fdopen(recovery,'wb') as f:
    f.write(original);f.flush();os.fchmod(f.fileno(),stat.S_IMODE(st.st_mode));os.fsync(f.fileno())
   assert M['identity'](os.stat('semver',dir_fd=fd,follow_symlinks=False))==temp_identity
   os.replace(rollback,'semver',src_dir_fd=fd,dst_dir_fd=fd);os.fsync(fd)
   restored,_=M['package_identity'](source,'sharp',producer_source=PRODUCER)
   assert restored==old['descriptor'],'Original package restoration failed'
   (backup/'restoration-failed.json').write_text(json.dumps({'kind':'SHIM_RESTORATION_REFUSED_ORIGINAL_RESTORED','error':str(error),'originalSha256':digest(original)})+'\n')
  raise
 finally:
  if temp_identity is not None and not replaced:
   try:
    if M['identity'](os.stat(temp,dir_fd=fd,follow_symlinks=False))==temp_identity:os.unlink(temp,dir_fd=fd)
   except FileNotFoundError:pass
  os.close(fd)

def authority_program(new_id,relationship):
 return """import fs from'node:fs';import{execFileSync}from'node:child_process';import{readPrivateInstall}from'./.github/ci/staging-build-install.mjs';import{fingerprintStagingEnvironment}from'./.github/ci/staging-environment.mjs';const a=readPrivateInstall('%s',{allowExpired:true}),b=readPrivateInstall('%s');const g=b.grant;const relationship=%s;const sha=v=>createHash('sha256').update(v).digest('hex');if(a.authorizationSha256!==relationship.parentAuthorizationSha256||b.authorizationSha256!==relationship.authorizationSha256||g?.installId===a.grant.installId)throw Error('Exact renewal relationship required');for(const k of['source','controller','controllerBranch','baseline','baselineBuildId','environmentSha256','runId','runAttempt','runCreatedAt','producerStartedAt','producerCompletedAt','witnessFingerprint','artifact','build'])if(JSON.stringify(a.grant[k])!==JSON.stringify(g[k]))throw Error('Forward authority changed original build/environment');if(Date.parse(g.expiresAt)-Date.now()<600000)throw Error('Fresh authority needs at least ten minutes');if(g.source!=='9bf924ff3389fd5f5a41c03d062a40c429216585'||g.baseline!=='9541b1686d7941f89e564723271e48bf85a21a89'||g.baselineBuildId!=='RZT3KRDc_BngwxXFhSv1S'||g.runId!==40447785648)throw Error('Exact forward authority required');for(const p of[a,b])for(const n of['next','verified.json','activated.json','runtime.json']){try{fs.lstatSync(p.directory+'/'+n);throw Error('Install advanced beyond original refusal')}catch(e){if(e.code!=='ENOENT')throw e}};const state=Object.fromEntries(execFileSync('deploy/deploy-state.sh',['status'],{encoding:'utf8'}).split(String.fromCharCode(10)).filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return[x.slice(0,i),x.slice(i+1)]}));if(state.state!=='incomplete'||state.phase!=='ci-build-verify'||state.ref!==g.source||state.built_ref!==g.baseline||state.built_build_id!==g.baselineBuildId||state.stale_build!=='1'||state.exit_code!=='1')throw Error('Actual failed context required');const kv=b=>Object.fromEntries(b.toString().split(String.fromCharCode(10)).filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)]}));const read=p=>{const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==1000||s.size>1048576)throw Error('Private context file changed');return fs.readFileSync(p)};const pending=kv(read('/var/tmp/aihr-deploy/pending')),current=read('/var/tmp/aihr-deploy/current'),c=kv(current);if(pending.ref!==g.source||c.ref!==g.source||c.result!=='failed'||c.phase!=='ci-build-verify'||c.pid!=='3354827'||c.exit_code!=='1'||createHash('sha256').update(current).digest('hex')!==%s)throw Error('Underlying original failed record changed');let alive=true;try{process.kill(3354827,0)}catch(e){if(e.code!=='ESRCH')throw e;alive=false}if(alive)throw Error('Original deploy process still alive');if(execFileSync('systemctl',['show','aihr','--property=MainPID','--value']).toString().trim()!=='3327801'||execFileSync('systemctl',['is-active','aihr']).toString().trim()!=='active'||fs.readFileSync('.next/BUILD_ID','utf8').trim()!==g.baselineBuildId||fingerprintStagingEnvironment('/opt/ai-hr')!==g.environmentSha256)throw Error('Retained actual runtime/configuration changed');import{createHash}from'node:crypto';if(sha(read('/var/tmp/aihr-deploy/last-ok'))!==relationship.parentFailedContext.lastOkSha256||sha(fs.readFileSync('/proc/sys/kernel/random/boot_id'))!==relationship.parentFailedContext.bootIdSha256)throw Error('Retained baseline or boot identity changed');const lock=createHash('sha256').update(fs.readFileSync('pnpm-lock.yaml')).digest('hex');if(lock!==g.build.lockSha256||fs.readFileSync('node_modules/.deploy-lockfile-sha','utf8').trim()!==lock)throw Error('Normal spine would reinstall dependencies');console.log(JSON.stringify({newInstallId:g.installId,authorizationSha256:b.authorizationSha256,source:g.source,baseline:g.baseline,expiresAt:g.expiresAt}));"""%(OLD_ID,new_id,json.dumps(relationship,separators=(',',':')),json.dumps(relationship['parentFailedContext']['currentSha256']))

if __name__=='__main__':
 assert os.getuid()==1000,'Application code may never run as OS root'
 payload=json.loads(sys.stdin.buffer.read(65537));assert len(json.dumps(payload))<=65536
 new_id=payload['newInstallId'];assert re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',new_id) and new_id!=OLD_ID
 code=authority_program(new_id,payload['relationship'])
 def authority():return json.loads(subprocess.check_output(['/opt/node22/bin/node','--input-type=module','-e',code],cwd='/opt/ai-hr',env={'PATH':'/opt/node22/bin:/usr/bin:/bin','LANG':'C.UTF-8'},timeout=30))
 assert payload['ci']['descriptor']['packageTreeSha256']=='d69a084d753231b315413e9b8c3d7bf17abb7e4fe7b26bf9c68aa32e2a12ce2f'
 assert payload['before']['descriptor']['packageTreeSha256']=='83f90ac4514e7c0c3e22e22dc2718c7b485f5ac16991e0df668a66f906c5f48e'
 result=restore(pathlib.Path('/opt/ai-hr'),payload['ci'],payload['before'],pathlib.Path('/var/tmp/aihr-sharp-restore-'+new_id),authority,apply=payload.get('apply') is True,uid=1000);print(json.dumps(result))
