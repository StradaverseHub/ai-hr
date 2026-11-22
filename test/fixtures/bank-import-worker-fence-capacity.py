"""Measure the actual four metadata walks in disposable Linux, without release authority."""
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

candidate, runtime = (Path(arg).resolve(strict=True) for arg in sys.argv[1:])
assert (candidate / '.next/BUILD_ID').read_text().strip() == 'pDe2JKsQG-bY3fuGOGSVx'
assert Path('/sys/fs/cgroup/memory.max').read_text().strip() == str(4 * 1024**3)
assert Path('/sys/fs/cgroup/cpu.max').read_text().split() == ['200000', '100000']


def load_owner(name):
    path = candidate / 'deploy/systemd' / f'bank_import_worker_{name}_v1.py'
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def require(condition, message):
    if not condition:
        raise ValueError(message)


fences = load_owner('fences')
ci = load_owner('ci_runtime')
base = SimpleNamespace(check=require, read_bounded=lambda path, limit: path.read_bytes()[:limit])
filters = ci.canonical_filters(base, candidate)
ignore_nothing = lambda _: False
scans = [
    ('source', candidate, ci.source_excluder(filters)),
    ('compiled', candidate / '.next', lambda name: name == 'cache'),
    ('dependencies', candidate / 'node_modules', ignore_nothing),
    ('runtime', runtime, ignore_nothing),
]
roots = [str(root) for _, root, _ in scans]
prior = None
for sample in range(1, 7):
    started = time.monotonic()
    deadline = started + 60
    results = {}
    timings = {}
    for name, root, exclude in scans:
        phase = time.monotonic()
        results[name] = fences.capture_tree(str(root), exclude, roots, deadline)
        timings[name] = round(time.monotonic() - phase, 3)
    covered = {str(root) + ('/' + row['path'] if row['path'] else '')
               for name, root, _ in scans for row in results[name]['entries']}
    for result in results.values():
        require(all(row['resolvedTarget']['path'] in covered
                    for row in result['entries'] if row['kind'] == 'link'),
                'unobserved link target')
    cache = candidate / '.next/cache'
    cache_state = {'present': cache.exists() or cache.is_symlink()}
    results['cache'] = cache_state
    metadata_sha = hashlib.sha256(ci.canonical(results)).hexdigest()
    require(prior is None or prior == metadata_sha, 'metadata changed between samples')
    prior = metadata_sha

    phase = time.monotonic()
    node = runtime / 'bin/node'
    for _ in range(2):
        with node.open('rb') as executable:
            require(len(hashlib.file_digest(executable, 'sha256').digest()) == 32, 'Node hash failed')
    subprocess.run([str(node), '--version'], check=True, capture_output=True, timeout=3)
    timings['twoNodeHashesAndStartup'] = round(time.monotonic() - phase, 3)
    total = round(time.monotonic() - started, 3)
    print(json.dumps({
        'kind': 'DISPOSABLE_FENCE_CAPACITY_SAMPLE_NOT_RELEASE',
        'sample': sample,
        'timingsSeconds': timings,
        'observedSeconds': total,
        'remainingInTwentySeconds': round(20 - total, 3),
        'nodes': {name: results[name]['nodes'] for name, _, _ in scans},
        'links': {name: results[name]['links'] for name, _, _ in scans},
        'metadataSha256': metadata_sha,
        'memoryPeakBytes': int(Path('/sys/fs/cgroup/memory.peak').read_text()),
        'releaseAuthorized': False,
    }), flush=True)
    del covered, results
