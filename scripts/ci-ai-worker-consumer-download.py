"""Authenticate an accepted producer artifact before separate disposable consumer verification.

The token belongs only to this trusted downloader. No app import or worker executes here.
This is preparation, never a deployment/activation grant.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

REPO = 'StradaverseHub/ai-hr'
MEMBERS = {'worker-package.zip', 'worker-manifest.json', 'worker-provenance.json', 'worker-runtime-proof.json'}

def require(value, message):
    if not value:
        raise RuntimeError('Worker consumer download refused: ' + message)

def api(path):
    raw = subprocess.check_output(['gh', 'api', 'repos/' + REPO + '/' + path], timeout=60)
    require(len(raw) <= 4 * 1024**2, 'bounded API JSON required')
    return json.loads(raw)

def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024**2), b''):
            result.update(chunk)
    return result.hexdigest()

def main():
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('CI') == 'true', 'disposable Actions only')
    require(os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'original consumer attempt required')
    values = {key: os.environ[key] for key in ('PRODUCER_RUN', 'ARTIFACT_ID', 'ARTIFACT_SHA256', 'PRODUCER_CONTROLLER', 'WORKER_SOURCE', 'WEB_SOURCE')}
    for key in ('PRODUCER_RUN', 'ARTIFACT_ID'):
        require(re.fullmatch('[1-9][0-9]{0,19}', values[key]), 'exact positive API identity')
    for key in ('PRODUCER_CONTROLLER', 'WORKER_SOURCE', 'WEB_SOURCE'):
        require(re.fullmatch('[a-f0-9]{40}', values[key]), 'exact full commit identity')
    require(re.fullmatch('[a-f0-9]{64}', values['ARTIFACT_SHA256']), 'exact artifact digest')
    run = api('actions/runs/' + values['PRODUCER_RUN'])
    require(run['repository']['id'] == 1333414856 and run['repository']['full_name'] == REPO, 'repository binding')
    require(run['id'] == int(values['PRODUCER_RUN']) and run['head_sha'] == values['PRODUCER_CONTROLLER'], 'producer run/controller binding')
    require(run['event'] == 'workflow_dispatch' and run['path'] == '.github/workflows/bank-import-worker-package.yml', 'reviewed producer workflow required')
    require(run['run_attempt'] == 1 and run['status'] == 'completed' and run['conclusion'] == 'success', 'successful original producer attempt required')
    artifact = api('actions/artifacts/' + values['ARTIFACT_ID'])
    require(artifact['id'] == int(values['ARTIFACT_ID']) and artifact['name'] == 'worker-package-v2' and not artifact['expired'], 'exact live producer artifact')
    require(artifact['workflow_run']['id'] == run['id'] and artifact['workflow_run']['head_sha'] == values['PRODUCER_CONTROLLER'], 'artifact producer binding')
    require(artifact['digest'] == 'sha256:' + values['ARTIFACT_SHA256'], 'authenticated API digest differs')
    require(0 < artifact['size_in_bytes'] <= 512 * 1024**2, 'bounded producer artifact')
    target = Path(os.environ['PACKAGE_DIR'])
    target.mkdir(mode=0o700, parents=True, exist_ok=False)
    outer = target.parent / 'producer-artifact.zip'
    with outer.open('xb') as output:
        subprocess.run(['gh', 'api', 'repos/' + REPO + '/actions/artifacts/' + values['ARTIFACT_ID'] + '/zip'], stdout=output, check=True, timeout=240)
    require(outer.stat().st_size == artifact['size_in_bytes'] and digest(outer) == values['ARTIFACT_SHA256'], 'download bytes differ from API')
    with zipfile.ZipFile(outer) as archive:
        entries = archive.infolist()
        require(len(entries) == 4 and {entry.filename for entry in entries} == MEMBERS, 'closed four-member artifact required')
        for entry in entries:
            limit = 512 * 1024**2 if entry.filename == 'worker-package.zip' else 16 * 1024**2
            mode = entry.external_attr >> 16
            require(not entry.is_dir() and not entry.flag_bits & 1 and (mode & 0o170000) in (0, 0o100000), 'plain unencrypted artifact members')
            require(0 < entry.file_size <= limit, 'bounded member required')
            with archive.open(entry) as source, (target / entry.filename).open('xb') as destination:
                total = 0
                while chunk := source.read(1024**2):
                    total += len(chunk)
                    require(total <= limit, 'expanded member exceeds bound')
                    destination.write(chunk)
                require(total == entry.file_size, 'member length differs')
    provenance = json.loads((target / 'worker-provenance.json').read_bytes())
    proof = json.loads((target / 'worker-runtime-proof.json').read_bytes())
    manifest = json.loads((target / 'worker-manifest.json').read_bytes())
    require(provenance['format'] == manifest['format'] == 2, 'corrected V2 source package required')
    for row in (provenance, manifest, proof):
        require(row['source'] == values['WORKER_SOURCE'] and row['controllerSource'] == values['PRODUCER_CONTROLLER'], 'producer source identities differ')
    require(provenance['archiveSha256'] == proof['archiveSha256'] == digest(target / 'worker-package.zip'), 'inner archive binding')
    require(proof['provenanceSha256'] == digest(target / 'worker-provenance.json'), 'original producer proof/provenance binding')
    require(proof['kind'] == 'CI_EXTRACTED_WORKER_RUNTIME_NOT_RELEASE' and proof['runId'] == run['id'] and proof['runAttempt'] == 1, 'producer runtime witness binding')
    require(proof['migrationLedger']['rows'] == 562 and proof['rootOwnedReadOnly'] is True and proof['extractedPostRunVerified'] is True, 'ordinary producer schema and immutable runtime proof')
    require(proof['cli']['noUnexpectedStderr'] is True and all(code == 0 for code in proof['cli']['exitCodes']), 'clean native producer execution required')
    require(proof['releaseAuthorized'] is False, 'producer proof is not release authority')
    evidence = {'kind': 'AUTHENTICATED_PRODUCER_INPUT_NOT_CONSUMER_RUNTIME_PROOF', **values,
                'consumerController': os.environ['GITHUB_SHA'], 'producerRun': run, 'producerArtifact': artifact,
                'members': {name: digest(target / name) for name in sorted(MEMBERS)}, 'releaseAuthorized': False}
    (target.parent / 'producer-input.json').write_text(json.dumps(evidence, sort_keys=True) + '\n')
    print(json.dumps({'authenticatedProducerRun': run['id'], 'artifact': artifact['id'], 'workerSource': values['WORKER_SOURCE'],
                      'webSource': values['WEB_SOURCE'], 'actualConsumerExecution': False, 'releaseAuthorized': False}))

if __name__ == '__main__':
    main()
