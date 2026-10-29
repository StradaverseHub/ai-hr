"""GHA-only actual-archive runtime gate. No staging credentials, deployment or release authority."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess
import tempfile

SOURCE='968354c00a71df7baccd499eb60757a3307ed61e'
APP='postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test'
OWNER='postgres://ai_hr_owner@127.0.0.1:5433/ai_hr_test'
USER='aihr-worker-archive-ci'

def require(ok,message):
    if not ok: raise RuntimeError('Actual worker archive gate refused: '+message)

def digest(raw): return hashlib.sha256(raw).hexdigest()
def file_hash(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda:stream.read(1024**2),b''): h.update(data)
    return h.hexdigest()
def command(argv,*,cwd='/',env=None,timeout=60):
    result=subprocess.run(argv,cwd=cwd,env=env or {'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},text=True,capture_output=True,timeout=timeout)
    # This gate admits only the fixed disposable trust-auth DB and fictional fixture, never live credentials/data.
    require(result.returncode==0,'bounded CI-only command failed: '+Path(argv[0]).name+'; stderr='+result.stderr[-12000:])
    return result

def main():
    parser=argparse.ArgumentParser()
    for name in ('controller','source','package-dir','node'): parser.add_argument('--'+name,required=True)
    args=parser.parse_args()
    require(os.geteuid()==0 and os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('CI')=='true' and os.uname().sysname=='Linux','root orchestration on disposable GitHub Linux runner only')
    run_id=os.environ.get('GITHUB_RUN_ID','');attempt=os.environ.get('GITHUB_RUN_ATTEMPT','')
    require(run_id.isdigit() and attempt=='1','original first GHA attempt only')
    controller,source,package=map(lambda x:Path(x).resolve(strict=True),(args.controller,args.source,args.package_dir))
    require(controller!=source and not controller.is_relative_to(source) and not source.is_relative_to(controller),'sibling controller and production checkouts required')
    def git(root,*argv): return command(['/usr/bin/git','-c','safe.directory='+str(root),'-C',str(root),*argv]).stdout.strip()
    controller_sha=git(controller,'rev-parse','HEAD')
    require(controller_sha==os.environ.get('GITHUB_SHA') and git(source,'rev-parse','HEAD')==SOURCE,'exact controller API head and fixed production source required')
    def frozen():
        require(git(controller,'rev-parse','HEAD')==controller_sha and git(source,'rev-parse','HEAD')==SOURCE and not git(controller,'status','--porcelain','--untracked-files=all') and not git(source,'status','--porcelain','--untracked-files=all'),'both clean frozen checkouts required')
    frozen()
    fmt_path=controller/'deploy/systemd/bank_import_worker_format.py'
    spec=importlib.util.spec_from_file_location('reviewed_worker_format',fmt_path)
    fmt=importlib.util.module_from_spec(spec);spec.loader.exec_module(fmt)
    require(set(p.name for p in package.iterdir())=={'worker-package.zip','worker-manifest.json','worker-provenance.json'},'exact pre-proof three output members required')
    provenance_bytes=(package/'worker-provenance.json').read_bytes()
    provenance=json.loads(provenance_bytes)
    archive=package/'worker-package.zip'
    archive_sha=file_hash(archive)
    require(provenance['format']==2 and provenance['source']==SOURCE and provenance['controllerSource']==controller_sha and provenance['archiveSha256']==archive_sha and provenance['archiveBytes']==archive.stat().st_size,'actual v2 provenance/archive binding required')
    require(provenance['producerSha256']==file_hash(controller/'scripts/bank-import-worker-package.py') and provenance['formatSha256']==file_hash(fmt_path),'exact reviewed producer/format bytes required')
    # Copy/authenticate before extraction into a new root-owned namespace away from both checkouts.
    area=Path(tempfile.mkdtemp(prefix='aihr-worker-archive-ci-',dir='/opt'));os.chmod(area,0o755)
    snapshot=area/'worker-package.zip';shutil.copyfile(archive,snapshot);os.chmod(snapshot,0o400)
    require(file_hash(snapshot)==archive_sha,'root-private archive copy changed')
    runtime=area/'runtime';runtime.mkdir(mode=0o700)
    manifest=fmt.extract_archive(snapshot,runtime,SOURCE,provenance['lockSha256'],provenance['packageSha256'])
    require(fmt.canonical(manifest)==(package/'worker-manifest.json').read_bytes() and digest(fmt.canonical(manifest))==provenance['manifestSha256'],'actual inner and outer manifest differ')
    require(manifest['format']==2 and manifest['controllerSource']==controller_sha,'actual extracted v2 source/controller binding required')
    fmt.require_activation_manifest(manifest,controller_sha)
    entries={r['path']:r for r in manifest['entries']}
    for required in ('localization/registry.ts','i18n/config.ts','scripts/bank-import-runner.ts'):
        require(entries.get(required,{}).get('type')=='file','runtime module closure input absent: '+required)
    for path in runtime.rglob('*'):
        if not path.is_symlink(): os.chmod(path,0o555 if path.is_dir() else entries[path.relative_to(runtime).as_posix()]['mode']&0o555)
    os.chmod(runtime,0o555)
    node=area/'node';shutil.copyfile(Path(args.node).resolve(strict=True),node);os.chmod(node,0o555)
    require(command([str(node),'--version']).stdout.strip()=='v22.23.3','exact Node runtime required')
    actual_runtime=json.loads(command([str(node),'-e',"console.log(JSON.stringify({node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime}))"]).stdout)
    require(actual_runtime==provenance['runtime']==fmt.RUNTIME,'actual copied Node/host runtime differs from authenticated package')
    try: pwd.getpwnam(USER)
    except KeyError: pass
    else: raise RuntimeError('CI worker identity unexpectedly exists')
    command(['/usr/sbin/useradd','--system','--user-group','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',USER])
    identity=pwd.getpwnam(USER);require(identity.pw_uid>0 and identity.pw_gid>0,'dedicated nonroot identity required')
    work=area/'fixture-private';work.mkdir(mode=0o700);os.chown(work,identity.pw_uid,identity.pw_gid)
    # Unset deferred gates match test/env.ts: explicit audit '=false' is also OFF, but intentionally warns.
    env={'PATH':str(area)+':/usr/bin:/bin','LANG':'C.UTF-8','TZ':'Asia/Kuala_Lumpur','HOME':str(work),'TMPDIR':str(work),'NODE_ENV':'production','GITHUB_ACTIONS':'true','CI':'true','DATABASE_URL':APP,'MIGRATION_DATABASE_URL':OWNER,'TEST_DATABASE_URL':APP,'TEST_MIGRATION_DATABASE_URL':OWNER}
    # Controller/canonical fixture preparation belongs to the original unprivileged checkout owner.
    # GitHub's runner home may be private: do not chmod its ancestors or make the real worker borrow its UID.
    runner_uid=source.stat().st_uid
    require(runner_uid>0 and runner_uid==controller.stat().st_uid==package.stat().st_uid and str(runner_uid)==os.environ.get('SUDO_UID'),'exact original nonroot Actions checkout/invoker identity required')
    runner=pwd.getpwuid(runner_uid)
    require(runner.pw_uid!=identity.pw_uid,'fixture runner and actual worker must be separate identities')
    fixture_work=area/'controller-fixture-private';fixture_work.mkdir(mode=0o700);os.chown(fixture_work,runner.pw_uid,runner.pw_gid)
    fixture_env={**env,'HOME':str(fixture_work),'TMPDIR':str(fixture_work)}
    state=fixture_work/'fixture.json';fixture=controller/'scripts/ci-bank-import-worker-archive-runtime-smoke.ts'
    loader=source/'node_modules/tsx/dist/loader.mjs'
    def as_fixture(argv,timeout=60):
        return command(['/usr/sbin/runuser','--user',runner.pw_name,'--','/usr/bin/env','-i',*[k+'='+v for k,v in fixture_env.items()],*argv],cwd=runtime,timeout=timeout)
    def as_user(argv,timeout=60):
        return command(['/usr/sbin/runuser','--user',USER,'--','/usr/bin/env','-i',*[k+'='+v for k,v in env.items()],*argv],cwd=runtime,timeout=timeout)
    access_check="const fs=require('node:fs');for(const p of process.argv.slice(1))fs.accessSync(p,fs.constants.R_OK);"
    as_fixture([str(node),'-e',access_check,str(loader),str(fixture),str(source/'test/harness.ts'),str(runtime/'db/client.ts')])
    as_user([str(node),'-e',access_check,str(runtime/'scripts/bank-import-runner.ts'),str(runtime/'node_modules/tsx/dist/loader.mjs')])
    def fixture_phase(phase):
        # Source loader/harness are fixture setup only under their original owner, never the actual worker CLI.
        result=as_fixture([str(node),'--import',str(loader),str(fixture),phase,str(runtime),str(source),str(state)],120)
        require(result.stderr=='','unexpected CI-only fictional fixture stderr in '+phase+'; cannot claim clean runtime: '+result.stderr[-12000:])
        return json.loads(result.stdout)
    def verify_tree():
        require(runtime.stat().st_uid==0 and stat.S_IMODE(runtime.stat().st_mode)==0o555,'root-owned read-only runtime root changed')
        actual={p.relative_to(runtime).as_posix() for p in runtime.rglob('*')}
        require(actual==set(entries),'runtime file set changed')
        for name,row in entries.items():
            path=runtime/name;info=path.lstat()
            require(info.st_uid==0 and (stat.S_ISLNK(info.st_mode) or not info.st_mode&0o222),'runtime owner/write permissions changed')
            if row['type']=='file': require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size==row['size'] and file_hash(path)==row['sha256'] and stat.S_IMODE(info.st_mode)==row['mode']&0o555,'runtime file bytes/mode changed')
            elif row['type']=='directory': require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode)==0o555,'runtime directory changed')
            else: require(stat.S_ISLNK(info.st_mode) and os.readlink(path)==row['target'] and path.resolve(strict=True).is_relative_to(runtime),'runtime symlink changed')
    fixture_phase('setup')
    # Bootstrap owner was privileged for canonical migrations/fixtures only; actual worker has physical ownership, no bypass/superuser.
    command(['/usr/bin/psql','postgres://postgres@127.0.0.1:5433/ai_hr_test','-X','-v','ON_ERROR_STOP=1','-c','ALTER ROLE ai_hr_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;'])
    before=fixture_phase('snapshot');require(before['queueRows']==0,'empty queue required before actual archive startup')
    child_results=[]
    def worker_once():
        verify_tree()
        result=as_user([str(node),'--import','tsx','scripts/bank-import-runner.ts','--once'],90)
        require(result.stdout=='' and result.stderr=='','actual archived CLI emitted unexpected CI-only stdout/stderr: stdout='+result.stdout[-12000:]+'; stderr='+result.stderr[-12000:])
        child_results.append(result);return result
    empty_result=worker_once();after=fixture_phase('snapshot')
    require(before==after,'empty queue worker unexpectedly mutated public DB rows or migration/role proof')
    fixture_phase('admit')
    for _ in range(3): worker_once()
    preview=fixture_phase('preview')
    for _ in range(2): worker_once()
    completed=fixture_phase('assert-completed')
    verify_tree();frozen()
    require(file_hash(archive)==archive_sha and provenance_bytes==(package/'worker-provenance.json').read_bytes() and fmt.canonical(manifest)==(package/'worker-manifest.json').read_bytes(),'package changed during runtime gate')
    proof={'format':1,'kind':'CI_EXTRACTED_WORKER_RUNTIME_NOT_RELEASE','source':SOURCE,'controllerSource':controller_sha,'producerSha256':provenance['producerSha256'],'formatSha256':provenance['formatSha256'],'archiveSha256':archive_sha,'manifestSha256':provenance['manifestSha256'],'packageSha256':provenance['packageSha256'],'lockSha256':provenance['lockSha256'],'runtime':provenance['runtime'],'runId':int(run_id),'runAttempt':int(attempt),'rootOwnedReadOnly':True,'extractedOutsideCheckout':not runtime.is_relative_to(source) and not runtime.is_relative_to(controller),'modulePathsClean':True,'roleProof':before['roleProof'],'migrationLedger':{'rows':before['ledgerRows'],'sha256':before['ledgerSha256']},'emptyQueue':{'before':before['queueRows'],'after':after['queueRows'],'publicTables':len(before['publicTables']),'contentSha256':digest(fmt.canonical(before['publicTables'])),'noHrMutation':True,'exitCode':empty_result.returncode,'stdoutSha256':digest(empty_result.stdout.encode()),'stderrSha256':digest(empty_result.stderr.encode())},'nativeFixture':{'syntheticOnly':True,'previewValid':preview['valid'],'previewInvalid':preview['invalid'],'previewHrUnchanged':preview['hrUnchanged'],'saved':completed['saved'],'failed':completed['failed'],'total':completed['total'],'processed':completed['processed'],'auditItems':completed['nativeAuditItems'],'sourceChunksReleased':completed['sourceChunksReleased'],'cliInvocations':5},'cli':{'invocations':len(child_results),'exitCodes':[r.returncode for r in child_results],'noUnexpectedStderr':all(r.stderr=='' for r in child_results)},'extractedPostRunVerified':True,'releaseAuthorized':False}
    output=package/'worker-runtime-proof.json'
    proof['provenanceSha256']=digest(provenance_bytes)
    with output.open('xb') as stream:stream.write(fmt.canonical(proof))
    os.chmod(output,0o644);print(json.dumps(proof,sort_keys=True))

if __name__=='__main__': main()
