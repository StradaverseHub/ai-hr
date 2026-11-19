"""Hosted-only fictional metadata prototype benchmark; not native qualification/release authority.
Frozen7637 baseline, SAME real65322-node/four-root tree, two-CPU affinity, baseline-first.
No application imports, database, byte payload execution, live host or native actions.
"""
import collections
import gc
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import tempfile
import time
import types
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
BASELINE='7637f53bec0bb8e5052cce34dbf3308bfeec90d5'
PATH='deploy/systemd/bank_import_worker_fences_v1.py'
BASELINE_SHA='f7a47bc19c18e0c87cf6aba342a7a77a07706f46dfcbdcce4cc5eec753b618ed'
raw=subprocess.run(['git','show',BASELINE+':'+PATH],cwd=ROOT,capture_output=True,check=True).stdout
assert hashlib.sha256(raw).hexdigest()==BASELINE_SHA
baseline=types.ModuleType('frozen_baseline');exec(compile(raw,'frozen7637:'+PATH,'exec'),baseline.__dict__)
spec=importlib.util.spec_from_file_location('candidate',ROOT/PATH);candidate=importlib.util.module_from_spec(spec);spec.loader.exec_module(candidate)
assert sys.platform=='linux'
available=sorted(os.sched_getaffinity(0));assert len(available)>=2
os.sched_setaffinity(0,set(available[:2]));assert len(os.sched_getaffinity(0))==2

def measured(module,roots):
    calls=collections.Counter();phase=collections.Counter();timings=[]
    originals={name:getattr(os,name)for name in('stat','fstat','open','close','readlink','listdir')}
    def counted(name):
        def wrapped(*args,**kwargs):calls[name]+=1;return originals[name](*args,**kwargs)
        return wrapped
    enum=module.enumerate_tree;target=module.target_identity;dumps=module.json.dumps
    def walk(*args,**kwargs):
        start=time.monotonic();result=enum(*args,**kwargs);timings.append(time.monotonic()-start);return result
    def resolve(*args,**kwargs):
        start=time.monotonic();result=target(*args,**kwargs);phase['targetResolutionSeconds']+=time.monotonic()-start;calls['target_identity']+=1;return result
    def encode(*args,**kwargs):
        start=time.monotonic();result=dumps(*args,**kwargs);phase['jsonSeconds']+=time.monotonic()-start;return result
    material=getattr(module,'materialize_rows',None)
    def materialize(*args,**kwargs):
        start=time.monotonic();result=material(*args,**kwargs);phase['materializeSeconds']+=time.monotonic()-start;return result
    from contextlib import ExitStack
    with ExitStack()as stack:
        for name in originals:stack.enter_context(patch.object(module.os,name,counted(name)))
        stack.enter_context(patch.object(module,'enumerate_tree',walk));stack.enter_context(patch.object(module,'target_identity',resolve));stack.enter_context(patch.object(module.json,'dumps',encode))
        if material is not None:stack.enter_context(patch.object(module,'materialize_rows',materialize))
        start=time.monotonic();cpu=time.process_time();deadline=start+120;results=[]
        for index,root in enumerate(roots):
            exclude=(lambda name:name in('.next','node_modules'))if index==0 else(lambda name:False)
            results.append(module.capture_tree(str(root),exclude,[str(p)for p in roots],deadline))
        elapsed=time.monotonic()-start;cpu_elapsed=time.process_time()-cpu
    assert len(timings)==8,'all4roots independently walked twice'
    assert sum(r['nodes']for r in results)==65322
    return results,{'elapsedSeconds':elapsed,'cpuSeconds':cpu_elapsed,'walk1Seconds':sum(timings[::2]),'walk2Seconds':sum(timings[1::2]),'targetResolutionSeconds':phase['targetResolutionSeconds'],'materializeSeconds':phase['materializeSeconds'],'jsonSeconds':phase['jsonSeconds'],'otherSeconds':elapsed-sum(timings)-phase['materializeSeconds']-phase['jsonSeconds'],'calls':dict(calls),'nodes':sum(r['nodes']for r in results),'links':sum(r['links']for r in results)}

with tempfile.TemporaryDirectory(prefix='aihr-fence-64k-',dir='/tmp')as temporary:
    base=Path(temporary);source=base/'source';source.mkdir();roots=[source,source/'.next',source/'node_modules',base/'runtime']
    for root in roots[1:]:root.mkdir()
    for root,total,links in zip(roots,[15000,12000,35322,3000],[64,64,2048,64]):
        buckets=[root/('bucket-%02d'%n)for n in range(32)]
        for bucket in buckets:bucket.mkdir()
        files=total-1-len(buckets)-links
        for n in range(files):(buckets[n%32]/('row-%05d'%n)).write_bytes(b'fixed fictional payload')
        for n in range(links):
            # Real directory-descriptor symlink chain; approved cross-root paths are
            # intentionally NOT cached, and every resolve/reopen syscall is retained.
            link=buckets[n%32]/('alias-%05d'%n)
            target=buckets[0]/'row-00000'if n%2==0 else buckets[(n-1)%32]/('alias-%05d'%(n-1))
            link.symlink_to(os.path.relpath(target,link.parent))
    records=[]
    artifact=Path(os.environ['RUNNER_TEMP'])/'fence-metadata-prototype';artifact.mkdir(exist_ok=False)
    def one_child(module,name,repetition):
        # A fresh process per measurement avoids retaining the baseline's complete
        # entry graph while measuring candidate RSS. Parent never hydrates payload.
        result_path=base/(name+'-result.json');rfd,wfd=os.pipe();pid=os.fork()
        if pid==0:
            os.close(rfd)
            try:
                gc.collect();result,record=measured(module,roots)
                record['captureMaxRssKiB']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
                with result_path.open('w')as stream:json.dump(result,stream,sort_keys=True,separators=(',',':'),ensure_ascii=True)
                message=json.dumps({'ok':True,'record':record}).encode()
                os.write(wfd,message);os.close(wfd);os._exit(0)
            except BaseException as error:
                os.write(wfd,json.dumps({'ok':False,'category':type(error).__name__,'detail':str(error)}).encode());os.close(wfd);os._exit(1)
        os.close(wfd);parts=[]
        while True:
            data=os.read(rfd,65536)
            if not data:break
            parts.append(data)
        os.close(rfd);_,status=os.waitpid(pid,0);message=json.loads(b''.join(parts))
        assert status==0 and message['ok'],message
        return message['record'],result_path
    def equal_bytes(left,right):
        with left.open('rb')as a,right.open('rb')as b:
            while True:
                x,y=a.read(1024**2),b.read(1024**2)
                assert x==y,'ALL emitted complete result bytes must equal frozen baseline'
                if not x:break
    for repetition in range(5):
        for name,module in [('baseline',baseline),('candidate',candidate)]:
            record,result_path=one_child(module,name,repetition)
            record.update(implementation=name,repetition=repetition)
            if name=='baseline':baseline_calls=record['calls'];baseline_path=result_path
            else:
                equal_bytes(baseline_path,result_path)
                assert record['calls']==baseline_calls,'all actual descriptor/stat/link/listdir call counts retained'
                record.update(fullResultBytesEqual=True,allObservedSyscallCountsEqual=True)
            records.append(record)
            (artifact/'measurement-progress.json').write_text(json.dumps({'kind':'INCOMPLETE_PROTOTYPE_PROGRESS_NOT_RELEASE','measurements':records},indent=2)+'\n')
            print(json.dumps({'kind':'FENCE_METADATA_PROTOTYPE_MEASUREMENT',**record}),flush=True)
    output={'kind':'HOSTED_FENCE_METADATA_PROTOTYPE_NOT_RELEASE','source':subprocess.run(['git','rev-parse','HEAD'],cwd=ROOT,capture_output=True,text=True,check=True).stdout.strip(),'baseline':BASELINE,'baselineModuleSha256':BASELINE_SHA,'candidateModuleSha256':hashlib.sha256((ROOT/PATH).read_bytes()).hexdigest(),'cpuAffinity':sorted(os.sched_getaffinity(0)),'fixtureNodes':65322,'fixtureRoots':4,'twoIndependentWalksPerRoot':True,'allCompleteOutputsAndDigestsEqual':True,'allObservedSyscallCountsEqual':True,'freshProcessPerMeasurement':True,'measurements':records,'liveTargetObserved':False,'releaseAuthorized':False}
    (artifact/'measurement.json').write_text(json.dumps(output,indent=2)+'\n')
