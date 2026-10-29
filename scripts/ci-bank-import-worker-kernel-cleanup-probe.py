"""Actual disposable Linux gate EOF/freezer cleanup probes. Never a throughput receipt."""
import time
STARTED=time.monotonic()
import argparse
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import stat
import subprocess
import sys

SUBJECT=Path(__file__).with_name('bank_import_worker_throughput_proof.py')
spec=importlib.util.spec_from_file_location('kernel_probe_helper',SUBJECT)
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)

def deadline(signum,frame): raise TimeoutError('Kernel cleanup probe deadline exceeded; success forbidden')

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

def sealed_runtime(registry,fmt,package,manifest,node_input):
    area=registry.prepare_area();runtime=area/'runtime';runtime.mkdir(mode=0o700)
    actual=fmt.extract_archive(package/'worker-package.zip',runtime,manifest['source'],manifest['lockSha256'],manifest['packageSha256'])
    h.check(fmt.canonical(actual)==fmt.canonical(manifest),'probe extraction manifest changed')
    entries={row['path']:row for row in manifest['entries']}
    for path in runtime.rglob('*'):
        if not path.is_symlink(): os.chmod(path,0o555 if path.is_dir() else entries[path.relative_to(runtime).as_posix()]['mode']&0o555)
    os.chmod(runtime,0o555)
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

def run_case(case,fmt,package,manifest,node_input,tracked):
    tracked.append(case);root=h.initialize(case);registry=h.Registry(root,case)
    area,runtime,node,worker,work=sealed_runtime(registry,fmt,package,manifest,node_input)
    env={'PATH':str(area)+':/usr/bin:/bin','LANG':'C.UTF-8','TZ':'Asia/Kuala_Lumpur','HOME':str(work),'TMPDIR':str(work),'NODE_ENV':'production','CI':'true','GITHUB_ACTIONS':'true'}
    auxiliaries=h.auxiliary_contracts(runtime,manifest)
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
    inputs,manifest,ledger=h.verify_packet(args.source,args.producer_controller)
    budget=h.remaining_job_seconds(inputs['consumerJobStartedAt'],time.time(),float(os.environ['THROUGHPUT_FIRST_STEP_EPOCH']))
    h.check(budget>=120,'whole-job budget cannot preserve kernel probe work/cleanup and workflow reserve')
    producer=Path(args.producer_controller).resolve(strict=True)
    fmt=h.load_module('kernel_probe_format',producer/'deploy/systemd/bank_import_worker_format.py')
    package=h.root_directory()/'accepted';node=Path(args.node).resolve(strict=True);tracked=[];results=[];failed=False
    try:
        for case in ['kernel-eof','kernel-orphan']: results.append(run_case(case,fmt,package,manifest,node,tracked))
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
    h.evidence_bytes(report,h.canonical(proof),mode=0o644);print(json.dumps(proof,sort_keys=True))

if __name__=='__main__':
    supervised();main()
