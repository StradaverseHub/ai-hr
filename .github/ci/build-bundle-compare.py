"""Same-input packaging measurement on a hosted runner; never a release receipt."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time

sys.dont_write_bytecode = True

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def compare(runtime, candidate, packet, output):
    baseline = load('baseline_bundle', runtime/'.github/ci/build-bundle.py')
    proposed = load('candidate_bundle', candidate/'.github/ci/build-bundle.py')
    provenance = json.loads((packet/'build-provenance.json').read_text())
    # Packet authentication runs first in the workflow; the unchanged receiver
    # independently verifies every member and installed runtime dependency here.
    baseline.require(provenance['source']=='17b4321508bec1441f05b812e2c2a6b8ab94b1fb', 'unexpected input source')
    baseline.require(baseline.digest_file(runtime/'pnpm-lock.yaml')==provenance['lockSha256']
                     and baseline.digest_file(runtime/'package.json')==provenance['packageSha256'], 'runtime dependencies differ')
    origin = provenance['buildSourcePath'] if str(runtime)!=provenance['buildSourcePath'] else None
    original = baseline.unpack(packet/'bytes/build-bundle.tar.gz',packet/'bytes/build-bundle-files.json',
                               runtime/'.next',runtime,origin)
    records = []
    manifests = []
    for name, producer in [('baseline',baseline),('candidate',proposed)]:
        started = time.monotonic()
        manifest = producer.pack(runtime,output/name)
        elapsed = time.monotonic()-started
        for key in ['files','directories','aliases','unpackedBytes','nextBuildId','format','capacityProfile','kind','platform']:
            baseline.require(manifest[key]==original[key], 'original installed inventory differs: '+key)
        # A new unpacked tree must work with the *old* receiver, including its
        # original path/mode/hash, special-file and external-package safeguards.
        manifest_path = output/name/'build-bundle-files.json'
        restored = output/(name+'-restored')
        baseline.unpack(output/name/'build-bundle.tar.gz',manifest_path,restored,runtime)
        baseline.verify_directory(restored,manifest_path,runtime)
        manifests.append(manifest)
        records.append({'producer':name,'archiveBytes':manifest['archiveBytes'],
                        'archiveSha256':manifest['archiveSha256'],'packSeconds':elapsed,
                        'oldReceiverFullInventoryVerified':True})
    baseline.require(manifests[0]['aliases']==manifests[1]['aliases'], 'runtime aliases differ')
    baseline.require(manifests[0]['archiveSha256']==original['archiveSha256'], 'baseline archive did not reproduce')
    baseline.require(records[1]['archiveBytes']<records[0]['archiveBytes'], 'no measured archive reduction')
    result = {'kind':'SAME_INPUT_BUNDLE_COMPARISON_NOT_RELEASE','candidate':subprocess.check_output(
        ['git','-C',str(candidate),'rev-parse','HEAD'],text=True).strip(),
        'baseline':subprocess.check_output(['git','-C',str(runtime),'rev-parse','HEAD'],text=True).strip(),
        'originalBuildSource':provenance['source'],'originalBuildRun':provenance['runId'],
        'files':len(original['files']),'unpackedBytes':original['unpackedBytes'],
        'unchangedPathsBytesModes':True,'records':records,
        'savedBytes':records[0]['archiveBytes']-records[1]['archiveBytes'],
        'releaseAuthorized':False,'activeServiceVerified':False}
    (output/'comparison.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))

if __name__=='__main__':
    compare(*(Path(value).resolve() for value in sys.argv[1:]))
