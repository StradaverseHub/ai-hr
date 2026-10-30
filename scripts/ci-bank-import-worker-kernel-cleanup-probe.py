"""Actual disposable Linux gate EOF/freezer cleanup probes. Never a throughput receipt."""
import time
STARTED=time.monotonic()
import argparse
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import posixpath
import re
import select
import signal
import stat
import subprocess
import sys
import zipfile

SUBJECT=Path(__file__).with_name('bank_import_worker_throughput_proof.py')
spec=importlib.util.spec_from_file_location('kernel_probe_helper',SUBJECT)
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)

def deadline(signum,frame): raise TimeoutError('Kernel cleanup probe deadline exceeded; success forbidden')

def event(phase,**fields):
    print(json.dumps({'phase':phase,'elapsedSeconds':round(time.monotonic()-STARTED,3),**fields},sort_keys=True),flush=True)

CLOSURE_ENTRIES=512
CLOSURE_BYTES=64*1024**2

def closure_plan(archive,manifest,fmt):
    """A separately labelled subset of an already fully authenticated archive, never a packet."""
    inspected=fmt.inspect_archive(archive,manifest['source'],manifest['lockSha256'],manifest['packageSha256'])
    h.check(h.exact(inspected,manifest),'closure input differs from authenticated complete manifest')
    entries={row['path']:row for row in manifest['entries']};links=set()
    def resolve(name,seen=()):
        fmt.safe_path(name);parts=name.split('/')
        for index in range(1,len(parts)+1):
            prefix='/'.join(parts[:index]);row=entries.get(prefix)
            h.check(row is not None,'closure binding is missing: '+prefix)
            if row['type']=='symlink':
                h.check(prefix not in seen and len(seen)<64,'closure link is cyclic or too deep')
                links.add(prefix)
                target=posixpath.normpath(posixpath.join(posixpath.dirname(prefix),row['target'],*parts[index:]))
                return resolve(target,(*seen,prefix))
            h.check(index==len(parts) or row['type']=='directory','closure ancestor is not a directory')
        return name
    def raw_file(name,bound=65536):
        row=entries.get(name);h.check(row is not None and row['type']=='file' and row['size']<=bound,'bounded regular closure metadata required')
        with zipfile.ZipFile(archive) as packet,packet.open('payload/'+name) as incoming: raw=incoming.read(bound+1)
        h.check(len(raw)==row['size'] and h.digest(raw)==row['sha256'],'closure metadata bytes differ')
        return raw
    package_root=resolve('node_modules/esbuild')
    h.check(entries[package_root]['type']=='directory','root esbuild binding must resolve to a package directory')
    package=json.loads(raw_file(package_root+'/package.json'));version=package.get('version')
    h.check(package.get('name')=='esbuild' and isinstance(version,str) and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',version) and package.get('main')=='lib/main.js' and package.get('type','commonjs')=='commonjs' and 'exports' not in package,'reviewed esbuild CommonJS entry/version required')
    h.check(not package.get('dependencies') and not package.get('peerDependencies'),'unexpected esbuild runtime dependency; no fallback closure')
    optional=package.get('optionalDependencies')
    h.check(isinstance(optional,dict) and optional.get('@esbuild/linux-x64')==version and all(isinstance(name,str) and name.startswith('@esbuild/') and value==version for name,value in optional.items()),'esbuild platform dependency versions differ')
    native_binding=posixpath.dirname(package_root)+'/@esbuild/linux-x64'
    native_root=resolve(native_binding)
    h.check(entries[native_root]['type']=='directory','native binding must resolve to a package directory')
    native=json.loads(raw_file(native_root+'/package.json'))
    h.check(native.get('name')=='@esbuild/linux-x64' and native.get('version')==version and native.get('os')==['linux'] and native.get('cpu')==['x64'] and not native.get('dependencies') and not native.get('peerDependencies') and not native.get('optionalDependencies') and 'exports' not in native,'native package identity/version/layout differs')
    main=resolve(package_root+'/lib/main.js');binary=resolve(native_binding+'/bin/esbuild')
    h.check(main==package_root+'/lib/main.js' and binary==native_root+'/bin/esbuild' and entries[main]['type']=='file' and entries[binary]['type']=='file' and entries[binary]['mode']==0o755,'exact regular esbuild entry and executable native binary required')
    roots=[package_root,native_root]
    selected={name for name in entries if any(name==root or name.startswith(root+'/') for root in roots)}|{'package.json'}
    # Preserve ALL package bytes (including unused bin wrappers), but refuse any
    # symlink that would expand this closure to an unreviewed third dependency.
    for name in list(selected):
        if entries[name]['type']=='symlink':
            resolved=resolve(name)
            h.check(any(resolved==root or resolved.startswith(root+'/') for root in roots),'selected package link escapes the two-package closure')
    selected|=links
    for name in list(selected):
        for ancestor in Path(name).parents:
            if str(ancestor)!='.':
                key=ancestor.as_posix();h.check(entries.get(key,{}).get('type')=='directory','closure ancestor missing from authenticated manifest');selected.add(key)
    rows=[entries[name] for name in sorted(selected)];total=sum(row['size'] for row in rows if row['type']=='file')
    h.check(0<len(rows)<=CLOSURE_ENTRIES and 0<total<=CLOSURE_BYTES,'bounded complete two-package closure required')
    h.check(sum(row['type']=='file' and row['path'].endswith('/@esbuild/linux-x64/bin/esbuild') for row in rows)==1,'exactly one selected native auxiliary binary required')
    return {'kind':'AUTHENTICATED_PROBE_ESBUILD_CLOSURE_NOT_FULL_PACKET','source':manifest['source'],'manifestSha256':h.digest(fmt.canonical(manifest)),'version':version,'packageRoot':package_root,'nativeRoot':native_root,'binary':binary,'entries':rows,'unpackedBytes':total}

def materialize_closure(archive,destination,plan,manifest,fmt):
    h.check(h.exact(plan,closure_plan(archive,manifest,fmt)),'closure plan changed or contains extra/missing entries')
    destination=Path(destination)
    h.check(destination.is_dir() and not destination.is_symlink() and destination.resolve(strict=True)==destination and destination.stat().st_uid==os.geteuid() and not any(destination.iterdir()),'empty literal private closure destination required')
    rows={row['path']:row for row in plan['entries']}
    for name,row in rows.items():
        if row['type']=='directory': (destination/name).mkdir(mode=0o755,parents=True,exist_ok=True)
    with zipfile.ZipFile(archive) as packet:
        for name,row in rows.items():
            if row['type']!='file': continue
            target=destination/name;count=0;digest=hashlib.sha256()
            fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,row['mode']&0o555)
            with os.fdopen(fd,'wb') as output,packet.open('payload/'+name) as incoming:
                for block in iter(lambda:incoming.read(1024**2),b''):
                    count+=len(block);h.check(count<=row['size'],'selected ZIP member exceeds authenticated size');digest.update(block);output.write(block)
                output.flush();os.fchmod(output.fileno(),row['mode']&0o555);os.fsync(output.fileno())
            h.check(count==row['size'] and digest.hexdigest()==row['sha256'],'selected ZIP member bytes differ')
    for name,row in rows.items():
        if row['type']=='symlink': os.symlink(row['target'],destination/name)
    for name,row in rows.items():
        path=destination/name;info=path.lstat()
        h.check(info.st_uid==os.geteuid(),'materialized closure owner changed')
        if row['type']=='directory':
            h.check(stat.S_ISDIR(info.st_mode) and not path.is_symlink(),'materialized closure directory changed');os.chmod(path,0o555)
        elif row['type']=='symlink': h.check(stat.S_ISLNK(info.st_mode) and os.readlink(path)==row['target'] and path.resolve(strict=True).is_relative_to(destination),'materialized closure link escapes or changed')
        else: h.check(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size==row['size'] and stat.S_IMODE(info.st_mode)==row['mode']&0o555 and h.file_hash(path)==row['sha256'],'materialized closure file/mode changed')
    os.chmod(destination,0o555)
    h.check({path.relative_to(destination).as_posix() for path in destination.rglob('*')}==set(rows),'materialized closure inventory has extras or missing entries')
    return h.digest(h.canonical(plan))

def supervised():
    """An external root parent bounds work plus independent cleanup to 120 seconds."""
    h.check(os.geteuid()==0 and sys.flags.isolated==1 and sys.flags.dont_write_bytecode==1,'root Python -I -B required')
    h.invocation();child=os.fork()
    if child==0: return
    try:
        while time.monotonic()<STARTED+120:
            done,status=os.waitpid(child,os.WNOHANG)
            if done==child: os._exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 125)
            time.sleep(0.02)
        os.kill(child,signal.SIGKILL);os._exit(124)
    except BaseException:
        # Our unreaped direct child cannot have its PID reused.
        try:
            done,_=os.waitpid(child,os.WNOHANG)
            if done==0: os.kill(child,signal.SIGKILL)
        except BaseException: pass
        os._exit(125)

def bounded_json(fd,seconds):
    ready,_,_=select.select([fd],[],[],seconds)
    h.check(ready,'kernel controller readiness timeout')
    raw=os.read(fd,4097);h.check(0<len(raw)<=4096 and raw.endswith(b'\n'),'bounded controller readiness required')
    return json.loads(raw)

def stop_controller(pid,identity):
    done,_=os.waitpid(pid,os.WNOHANG);h.check(done==0,'probe controller exited before intentional loss')
    actual=h.proc_snapshot(pid)
    h.check(h.same_identity(actual,{**identity,'argv':[v.encode() for v in identity['argv']]}),'probe controller PID/start/identity changed; no signal sent')
    h.check(actual['parent']==os.getpid(),'probe controller is not our direct child; no signal sent')
    os.kill(pid,signal.SIGKILL);done,status=os.waitpid(pid,0)
    h.check(done==pid and os.WIFSIGNALED(status) and os.WTERMSIG(status)==signal.SIGKILL,'exact controller loss not observed')

def sealed_runtime(registry,fmt,package,manifest,node_input,plan):
    area=registry.prepare_area();runtime=area/'runtime';runtime.mkdir(mode=0o700)
    materialize_closure(package/'worker-package.zip',runtime,plan,manifest,fmt)
    node=area/'node'
    # Bound the native Node input and preserve its exact bytes in a root-owned inode.
    info=node_input.stat();h.check(stat.S_ISREG(info.st_mode) and 0<info.st_size<=256*1024**2,'bounded native Node input required')
    with node_input.open('rb') as incoming,node.open('xb') as output:
        for block in iter(lambda:incoming.read(1024**2),b''): output.write(block)
    os.chmod(node,0o555);h.check(h.file_hash(node)==h.file_hash(node_input),'copied probe Node bytes differ')
    worker=registry.prepare_user();work=area/'worker-private';work.mkdir(mode=0o700);os.chown(work,worker.pw_uid,worker.pw_gid)
    return area,runtime,node,worker,work

def no_worker_processes(uid):
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal(): continue
        try: lines=(entry/'status').read_text().splitlines()
        except (FileNotFoundError,ProcessLookupError): continue
        for line in lines:
            if line.startswith('Uid:') and str(uid) in line.split(':',1)[1].split(): return False
    return True

def assert_removed(case,area,worker,registry):
    h.check(not os.path.lexists(area) and not os.path.lexists(h.cgroup_root(case)),'probe runtime/cgroup namespace survived cleanup')
    h.check(not any(u.pw_name==worker.pw_name or u.pw_uid==worker.pw_uid for u in h.pwd.getpwall()),'probe native user/UID survived cleanup')
    h.check(not any(g.gr_name==worker.pw_name or g.gr_gid==worker.pw_gid for g in h.grp.getgrall()),'probe group/GID survived cleanup')
    h.check(no_worker_processes(worker.pw_uid),'probe native UID process survived cleanup')
    h.check(not registry.data['children'] and registry.data['createdChildren']==registry.data['finishedChildren'],'probe child groups not completely reaped')

def run_case(case,fmt,package,manifest,node_input,tracked,plan):
    event('kernel-case-start',case=case)
    tracked.append(case);root=h.initialize(case);registry=h.Registry(root,case)
    area,runtime,node,worker,work=sealed_runtime(registry,fmt,package,manifest,node_input,plan)
    event('kernel-closure-materialized',case=case,entries=len(plan['entries']),bytes=plan['unpackedBytes'])
    env={'PATH':str(area)+':/usr/bin:/bin','LANG':'C.UTF-8','TZ':'Asia/Kuala_Lumpur','HOME':str(work),'TMPDIR':str(work),'NODE_ENV':'production','CI':'true','GITHUB_ACTIONS':'true'}
    auxiliaries=h.auxiliary_contracts(runtime,{'entries':plan['entries']})
    h.check(len(auxiliaries)==1 and auxiliaries[0]['exe']==str((runtime/plan['binary']).resolve(strict=True)),'one exact selected manifest esbuild auxiliary required')
    invalid_receipt=root/'probe-invalid-receipt.json'
    if case=='kernel-orphan':
        h.evidence_bytes(invalid_receipt,h.canonical({'kind':'KERNEL_PROBE_INVALIDATION_SENTINEL_NOT_MEASUREMENT'}))
        registry.register_receipt(invalid_receipt,invalid_receipt.stat())
    code="const esbuild=require('esbuild');esbuild.transform('const probe:number=1',{loader:'ts'}).then(r=>{if(!r.code.includes('probe')||r.code.includes(':number'))throw Error('transform failed');process.stdout.write(JSON.stringify({compiled:true,runtime:{node:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime}})+'\\n');setInterval(()=>{},1000)}).catch(e=>{console.error(e);process.exitCode=1})"
    argv=[str(node),'-e',code]
    ready_r,ready_w=os.pipe();observer=os.getpid();child=os.fork();controller_identity=None
    if child==0:
        os.close(ready_r)
        try:
            # If the outer probe is killed, its controller must close every retained
            # release writer too. This is a real Linux guarantee, checked before launch.
            h.check(ctypes.CDLL(None,use_errno=True).prctl(1,signal.SIGKILL,0,0,0)==0 and os.getppid()==observer,'kernel parent-death controller guard failed')
            signal.setitimer(signal.ITIMER_REAL,max(0.01,STARTED+90-time.monotonic()))
            stderr=h.private_log(area/'worker-0.stderr')
            process=registry.popen(argv,cwd=runtime,env=env,gate_timeout=10,stdout=subprocess.PIPE,stderr=stderr,user=worker.pw_uid,group=worker.pw_gid,extra_groups=[],umask=0o077,auxiliaries=auxiliaries,_release=case!='kernel-eof')
            if case=='kernel-orphan':
                ready,_,_=select.select([process.stdout],[],[],10)
                h.check(ready,'actual sealed Node/esbuild readiness missing')
                ready_message=json.loads(process.stdout.readline(1024))
                h.check(h.exact(ready_message,{'compiled':True,'runtime':fmt.RUNTIME}),'actual sealed Node/host or esbuild transform differs')
            os.write(ready_w,json.dumps({'pid':process.pid,'controller':h.serial_identity(h.proc_snapshot(os.getpid()))}).encode()+b'\n')
            os.close(ready_w)
            while True: signal.pause()  # EOF probe retains the sole release-pipe writer here.
        except BaseException:
            os._exit(125)
    os.close(ready_w)
    try:
        message=bounded_json(ready_r,15);controller_identity=message['controller']
        event('kernel-native-ready',case=case)
        h.check(controller_identity['pid']==child,'readiness belongs to another controller')
        registry=h.Registry(root,case);records=[r for r in registry.data['children'] if r.get('pid')==message['pid']]
        h.check(len(records)==1,'one exact durable native child required');record=records[0]
        group=h.cgroup_root(case)/record['cgroup'];members=h.cgroup_members(group)
        h.check(message['pid'] in members,'native child escaped exact probe cgroup')
        if case=='kernel-eof':
            h.check(members==[message['pid']],'unreleased gate unexpectedly spawned an auxiliary')
        else:
            h.check(len(members)==2,'actual Node and one manifest esbuild service required')
            esbuild=[pid for pid in members if pid!=message['pid']][0]
            actual=h.proc_snapshot(esbuild)
            h.check(any(actual['exe']==a['exe'] and actual['argv']==[v.encode() for v in a['argv']] and h.file_hash(actual['exe'])==a['sha256'] for a in auxiliaries),'actual service is not manifest esbuild')
        stop_controller(child,controller_identity);child=None
        if case=='kernel-eof':
            until=min(STARTED+90,time.monotonic()+3)
            while h.cgroup_members(group) and time.monotonic()<until: time.sleep(0.02)
            h.check(not h.cgroup_members(group),'unreleased actual gate did not exit on sole-writer EOF; no signal sent')
        forced=False
        try: registry.cleanup()
        except ValueError as error:
            # Forced cleanup must remain a failed measurement, even though this probe expects it.
            h.check(case=='kernel-orphan' and str(error)=='CI throughput proof refused: forced cleanup invalidates every receipt','unexpected independent cleanup failure')
            forced=True
        h.check(forced==(case=='kernel-orphan') and registry.data['forcedCleanup']==forced,'forced-cleanup invalidation differs')
        if forced:
            h.check({r['pid'] for r in record.get('cleanupIdentities',[])}==set(members),'freezer cleanup must witness both actual Node and esbuild identities')
            registry.invalidate_receipt();h.check(not invalid_receipt.exists(),'forced cleanup did not invalidate exact sentinel receipt')
        assert_removed(case,area,worker,registry)
        event('kernel-case-cleaned',case=case,forcedCleanup=forced)
        return {'case':case,'actualCgroupMembers':len(members),'controllerLoss':'SIGKILL','forcedCleanupInvalidatesReceipt':forced,'eofExitedWithoutSignal':case=='kernel-eof','ownedResourcesRemoved':True,'noForeignSignals':True,'cleanupIdentities':record.get('cleanupIdentities',[]),'unreleasedGateIdentity':record['gate'] if case=='kernel-eof' else None}
    finally:
        os.close(ready_r)
        if child is not None:
            # Still our unreaped direct child; never signal an uncertain descendant.
            try:
                done,_=os.waitpid(child,os.WNOHANG)
                if done==0:
                    if controller_identity is None: controller_identity=h.serial_identity(h.proc_snapshot(child))
                    stop_controller(child,controller_identity)
            except ChildProcessError: pass

def main():
    parser=argparse.ArgumentParser(allow_abbrev=False)
    for name in ['source','producer-controller','node','report']: parser.add_argument('--'+name,required=True)
    args=parser.parse_args();h.invocation();h.check(h.proof_mode()=='preflight-401','kernel probes belong only to explicit short preflight mode');signal.signal(signal.SIGALRM,deadline);signal.setitimer(signal.ITIMER_REAL,max(0.01,STARTED+90-time.monotonic()))
    # Authenticate baseline packet and all source/dependency bytes before any probe namespace exists.
    event('kernel-full-packet-verification-start')
    inputs,manifest,ledger=h.verify_packet(args.source,args.producer_controller)
    event('kernel-full-packet-verification-complete')
    budget=h.remaining_job_seconds(inputs['consumerJobStartedAt'],time.time(),float(os.environ['THROUGHPUT_FIRST_STEP_EPOCH']))
    h.check(budget>=120,'whole-job budget cannot preserve kernel probe work/cleanup and workflow reserve')
    producer=Path(args.producer_controller).resolve(strict=True)
    fmt=h.load_module('kernel_probe_format',producer/'deploy/systemd/bank_import_worker_format.py')
    package=h.root_directory()/'accepted';node=Path(args.node).resolve(strict=True);tracked=[];results=[];failed=False
    plan=closure_plan(package/'worker-package.zip',manifest,fmt)
    event('kernel-closure-selected',entries=len(plan['entries']),bytes=plan['unpackedBytes'],version=plan['version'])
    try:
        for case in ['kernel-eof','kernel-orphan']: results.append(run_case(case,fmt,package,manifest,node,tracked,plan))
    except BaseException:
        failed=True;raise
    finally:
        # Independent cleanup gets up to 30 seconds after work fails, within the external 120s cap.
        signal.setitimer(signal.ITIMER_REAL,max(0.01,min(30,STARTED+120-time.monotonic())))
        errors=[]
        for case in ['kernel-eof','kernel-orphan']:
            try:
                if not h.recover_initialization(case):
                    registry=h.Registry(h.root_directory(case),case)
                    try: registry.cleanup()
                    except ValueError as error:
                        h.check(case=='kernel-orphan' and str(error)=='CI throughput proof refused: forced cleanup invalidates every receipt' and registry.data['forcedCleanup'] and not registry.data['children'] and not os.path.lexists(h.cgroup_root(case)),'probe cleanup remains incomplete')
                    registry.invalidate_receipt()
            except BaseException as error: errors.append(str(error))
        for error in errors: print('Kernel probe final cleanup: '+error,file=sys.stderr)
        if not failed: h.check(not errors,'kernel probe final cleanup failed')
    report=Path(args.report).absolute();parent=report.parent;info=parent.stat()
    h.check(h.authenticated_inputs()['members']==inputs['members'],'baseline accepted packet changed during kernel probes')
    h.verify_source_bytes(Path(args.source).resolve(strict=True),manifest)
    h.remaining_job_seconds(inputs['consumerJobStartedAt'],time.time(),float(os.environ['THROUGHPUT_FIRST_STEP_EPOCH']))
    h.check(parent.resolve(strict=True)==parent and parent.name=='bank-throughput-evidence' and str(info.st_uid)==os.environ.get('SUDO_UID') and not info.st_mode&0o022 and not os.path.lexists(report),'new private runner probe report required')
    proof={'format':1,'kind':'ACTUAL_KERNEL_CLEANUP_PROBE_NOT_THROUGHPUT','mode':'preflight-401','runId':int(os.environ['GITHUB_RUN_ID']),'controllerSource':os.environ['GITHUB_SHA'],'acceptedProducer':inputs['producer'],'acceptedMembers':inputs['members'],'cases':results,'elapsedSeconds':round(time.monotonic()-STARTED,3),'allocationKillpointsExercised':False,'throughputRowsVerified':0,'releaseAuthorized':False,'acceptanceRequires':'original workflow success and independent owned cleanup success'}
    proof['probeClosure']={'kind':plan['kind'],'manifestSha256':plan['manifestSha256'],'sha256':h.digest(h.canonical(plan)),'version':plan['version'],'entries':len(plan['entries']),'unpackedBytes':plan['unpackedBytes'],'selectedPaths':[row['path'] for row in plan['entries']]}
    h.evidence_bytes(report,h.canonical(proof),mode=0o644);print(json.dumps(proof,sort_keys=True))

if __name__=='__main__':
    supervised();main()
