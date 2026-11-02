"""Hosted, same-input format-3 comparison. No application, activation or release authority."""
import gzip
import importlib.util
import json
import os
from pathlib import Path
import platform
import resource
import stat
import subprocess
import sys
import tarfile
import time
import zlib

sys.dont_write_bytecode = True

BASELINE_SOURCE = '193c50e84ebe5671223f4eb57d9624ace3e024a0'
ORIGINAL_SOURCE = '17b4321508bec1441f05b812e2c2a6b8ab94b1fb'
ORIGINAL_RUN = 41405151781
ORIGINAL_ARCHIVE_BYTES = 238025577
ORIGINAL_ARCHIVE_SHA = '6688dea6ceb7b3e78a22cb6de17f906ca52f4d696fcd29996f2d1882e8068b95'
BASELINE_ARCHIVE_BYTES = 235317606
BASELINE_ARCHIVE_SHA = 'aeb3a3de0489e2e4094feefd634b7b26f7318a92ea1636674708363ff5256f4c'
LOGICAL_FILES = 21418
LOGICAL_MAPS = 8202


def require(condition, message):
    if not condition:
        raise ValueError('Map comparison refused: ' + message)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git_head(directory):
    return subprocess.check_output(['git', '-C', str(directory), 'rev-parse', 'HEAD'],
                                   text=True, timeout=10).strip()


def save(path, value):
    with path.open('x', encoding='utf8') as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write('\n')


def measured(operation):
    started, cpu = time.monotonic(), time.process_time()
    result = operation()
    return result, {'elapsedSeconds': time.monotonic() - started,
                    'cpuSeconds': time.process_time() - cpu}


def logical_inventory(manifest, original, map_format):
    allowed = {'format', 'kind', 'archiveBytes', 'archiveSha256', 'mapCopies'}
    require(set(manifest) == set(original) | ({'mapCopies'} if map_format else set()),
            'manifest fields differ')
    for key in set(original) - allowed:
        require(manifest[key] == original[key], 'original logical inventory differs: ' + key)
    require(manifest['format'] == (3 if map_format else 2), 'unexpected format')
    require(manifest['kind'] == ('next-map-byte-bundle' if map_format else original['kind']),
            'unexpected bundle kind')


def physical_inventory(archive, manifest, rows, copies):
    """Read raw USTAR headers, including headers a general tar reader might hide."""
    expected = {path: row for path, row in rows.items() if path not in copies}
    seen, total = set(), 0
    require(archive.stat().st_size == manifest['archiveBytes'], 'physical archive size differs')
    with archive.open('rb') as raw:
        header = raw.read(10)
        require(header[:4] == b'\x1f\x8b\x08\x00' and header[4:8] == b'\0' * 4,
                'unexpected gzip header')
        raw.seek(0)
        with gzip.GzipFile(fileobj=raw, mode='rb') as stream:
            while True:
                header = stream.read(512)
                require(len(header) == 512, 'truncated physical header')
                if header == b'\0' * 512:
                    require(stream.read(512) == b'\0' * 512, 'missing physical terminator')
                    padding = stream.read(10241)
                    require(len(padding) <= 10240 and not any(padding), 'trailing physical data')
                    break
                require(header[257:263] == b'ustar\0' and header[263:265] == b'00', 'non-USTAR header')
                info = tarfile.TarInfo.frombuf(header, 'utf8', 'strict')
                require(info.type == tarfile.REGTYPE and not info.linkname and info.uid == info.gid == 0
                        and info.mtime == 0 and not info.uname and not info.gname,
                        'physical payload is not ordinary regular files')
                require(info.name in expected and info.name not in seen, 'unexpected physical path')
                row = expected[info.name]
                require(info.size == row['size'] and info.mode == row['mode'], 'physical metadata differs')
                remaining = info.size
                while remaining:
                    data = stream.read(min(remaining, 1024 ** 2))
                    require(bool(data), 'truncated physical member')
                    remaining -= len(data)
                padding = stream.read((-info.size) % 512)
                require(len(padding) == (-info.size) % 512 and not any(padding), 'invalid physical padding')
                seen.add(info.name)
                total += info.size
    require(seen == set(expected), 'missing physical members')
    return {'regularFiles': len(seen), 'unpackedBytes': total, 'allMembersOrdinaryRegular': True}


def copy_inventory(manifest, rows):
    copies = manifest['mapCopies']
    require(isinstance(copies, list) and 0 < len(copies) < len(rows), 'nonempty bounded map copies required')
    destinations = set()
    for copy in copies:
        require(isinstance(copy, dict) and set(copy) == {'path', 'source'}, 'map copy shape differs')
        destination, source = copy['path'], copy['source']
        require(destination in rows and source in rows and destination != source
                and destination.endswith('.map') and source.endswith('.map'), 'invalid map copy paths')
        require(destination not in destinations, 'duplicate map copy destination')
        require((rows[destination]['size'], rows[destination]['sha256']) ==
                (rows[source]['size'], rows[source]['sha256']), 'map copy bytes differ')
        destinations.add(destination)
    require(all(copy['source'] not in destinations for copy in copies), 'map copy chains are not physical primaries')
    return destinations


def independent_regular_files(tree, rows):
    for path in rows:
        entry = (tree / path).lstat()
        require(stat.S_ISREG(entry.st_mode) and entry.st_nlink == 1,
                'logical files must be independent regular files: ' + path)


def require_canonical_rejection(module, manifest):
    try:
        module.read_manifest(manifest)
    except ValueError:
        return
    raise ValueError('Map comparison refused: canonical format-2 admission accepted format 3')


def mutate_one_copy(tree, copies, rows, baseline):
    eligible = [copy for copy in copies if 0 < rows[copy['path']]['size'] <= 4 * 1024 ** 2]
    require(bool(eligible), 'bounded nonempty restored duplicate map required')
    copy = min(eligible, key=lambda entry: (rows[entry['path']]['size'], entry['path']))
    target, primary = tree / copy['path'], tree / copy['source']
    require(target.stat().st_nlink == primary.stat().st_nlink == 1
            and (target.stat().st_dev, target.stat().st_ino) != (primary.stat().st_dev, primary.stat().st_ino),
            'copy and primary share storage identity')
    with target.open('r+b') as stream:
        original = stream.read(1)
        require(len(original) == 1, 'missing duplicate map byte')
        try:
            stream.seek(0)
            stream.write(bytes([original[0] ^ 1]))
            stream.flush()
            os.fsync(stream.fileno())
            require(baseline.digest_file(target) != rows[copy['path']]['sha256'], 'copy mutation had no effect')
            require(baseline.digest_file(primary) == rows[copy['source']]['sha256'], 'copy mutation changed primary')
        finally:
            stream.seek(0)
            stream.write(original)
            stream.flush()
            os.fsync(stream.fileno())
    require(baseline.digest_file(target) == rows[copy['path']]['sha256'], 'duplicate map restoration failed')
    return {**copy, 'independentInodes': True, 'linkCounts': [1, 1],
            'primaryUnchangedDuringMutation': True, 'originalCopyBytesRestored': True}


def compare(runtime, candidate, packet, output):
    require(os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted' and sys.platform == 'linux',
            'standard GitHub-hosted Linux runner required')
    for path in [runtime, candidate, packet, output]:
        require(path.is_dir() and path.resolve() == path, 'canonical existing directories required')
    parent = output.stat()
    require(parent.st_uid == os.getuid() and stat.S_IMODE(parent.st_mode) == 0o700,
            'private owned comparison directory required')
    require(git_head(runtime) == BASELINE_SOURCE, 'runtime must use the frozen current-order producer')
    candidate_sha = git_head(candidate)
    if os.environ.get('GITHUB_SHA'):
        require(candidate_sha == os.environ['GITHUB_SHA'], 'workflow and candidate differ')
    baseline_path = runtime / '.github/ci/build-bundle.py'
    candidate_path = candidate / '.github/ci/build-map-bundle.py'
    baseline, proposed = load('old_bundle', baseline_path), load('map_bundle', candidate_path)
    candidate_canonical = load('candidate_canonical_bundle', candidate / '.github/ci/build-bundle.py')
    provenance = json.loads((packet / 'build-provenance.json').read_text())
    require(provenance['source'] == ORIGINAL_SOURCE and provenance['runId'] == ORIGINAL_RUN,
            'unexpected original build identity')
    require(provenance['archiveBytes'] == ORIGINAL_ARCHIVE_BYTES
            and provenance['archiveSha256'] == ORIGINAL_ARCHIVE_SHA, 'original archived bytes differ')
    require(baseline.digest_file(packet / 'bytes/build-bundle-files.json') == provenance['manifestSha256'],
            'authenticated original manifest differs')
    require(baseline.digest_file(runtime / 'pnpm-lock.yaml') == provenance['lockSha256']
            and baseline.digest_file(runtime / 'package.json') == provenance['packageSha256'], 'dependencies differ')
    # Preserve installer comparison at the exact original hosted source path. No
    # dependency wrapper rewrite, manifest normalization, or origin bypass is used.
    require(str(runtime) == provenance['buildSourcePath'], 'runtime must retain original source path')
    original = baseline.unpack(packet / 'bytes/build-bundle.tar.gz', packet / 'bytes/build-bundle-files.json',
                               runtime / '.next', runtime)
    rows = {row['path']: row for row in original['files']}
    require(len(rows) == LOGICAL_FILES and sum(path.endswith('.map') for path in rows) == LOGICAL_MAPS,
            'original logical file/map population differs')
    identity = {'kind': 'MAP_BUNDLE_COMPARISON_IDENTITY_NOT_RELEASE', 'candidate': candidate_sha,
                'baseline': BASELINE_SOURCE, 'originalBuildSource': ORIGINAL_SOURCE, 'originalBuildRun': ORIGINAL_RUN,
                'workflowRun': os.environ.get('GITHUB_RUN_ID'), 'workflowController': os.environ.get('GITHUB_SHA'),
                'python': platform.python_version(), 'zlibBuild': zlib.ZLIB_VERSION,
                'zlibRuntime': zlib.ZLIB_RUNTIME_VERSION,
                'node': subprocess.check_output(['node', '--version'], text=True, timeout=10).strip(),
                'toolSha256': {'baseline:.github/ci/build-bundle.py': baseline.digest_file(baseline_path),
                               'candidate:.github/ci/build-bundle.py': baseline.digest_file(candidate / '.github/ci/build-bundle.py'),
                               'candidate:.github/ci/build-map-bundle.py': baseline.digest_file(candidate_path),
                               'candidate:.github/ci/build-map-bundle-compare.py': baseline.digest_file(Path(__file__).absolute()),
                               'candidate:.github/ci/build-map-debug-check.mjs': baseline.digest_file(candidate / '.github/ci/build-map-debug-check.mjs')},
                'originalManifestSha256': baseline.digest_file(packet / 'bytes/build-bundle-files.json'),
                'releaseAuthorized': False}
    save(output / 'identity.json', identity)
    records, manifests = [], []
    for name, producer in [('baseline', baseline), ('candidate', proposed)]:
        baseline.verify_directory(runtime / '.next', packet / 'bytes/build-bundle-files.json', runtime)
        manifest, pack_time = measured(lambda: producer.pack(runtime, output / name))
        logical_inventory(manifest, original, name == 'candidate')
        copies = copy_inventory(manifest, rows) if name == 'candidate' else set()
        archive = output / name / 'build-bundle.tar.gz'
        require(baseline.digest_file(archive) == manifest['archiveSha256'], 'measured archive hash differs')
        physical, inspection_time = measured(lambda: physical_inventory(archive, manifest, rows, copies))
        restored = output / (name + '-restored')
        _, unpack_time = measured(lambda: producer.unpack(archive, output / name / 'build-bundle-files.json',
                                                         restored, runtime))
        _, verify_time = measured(lambda: baseline.verify_directory(
            restored, packet / 'bytes/build-bundle-files.json', runtime))
        independent_regular_files(restored, rows)
        if name == 'candidate':
            require_canonical_rejection(baseline, output / name / 'build-bundle-files.json')
            require_canonical_rejection(candidate_canonical, output / name / 'build-bundle-files.json')
            mutation = mutate_one_copy(restored, manifest['mapCopies'], rows, baseline)
            baseline.verify_directory(restored, packet / 'bytes/build-bundle-files.json', runtime)
        manifests.append(manifest)
        records.append({'producer': name, 'format': manifest['format'], 'archiveBytes': manifest['archiveBytes'],
                        'archiveSha256': manifest['archiveSha256'], 'physical': physical,
                        'logicalRegularFiles': len(rows), 'logicalMapFiles': LOGICAL_MAPS,
                        'logicalUnpackedBytes': original['unpackedBytes'], 'mapCopyCount': len(copies),
                        'pack': pack_time, 'unpack': unpack_time, 'oldFullInventoryVerification': verify_time,
                        'physicalInspection': inspection_time, 'allLogicalFilesLinkCountOne': True,
                        'oldReceiverFullInventoryVerifiedAgainstOriginal': True})
    require(records[0]['archiveBytes'] == BASELINE_ARCHIVE_BYTES
            and records[0]['archiveSha256'] == BASELINE_ARCHIVE_SHA, 'current-order baseline did not reproduce')
    require(records[1]['archiveBytes'] < records[0]['archiveBytes'], 'no actual format-3 archive reduction')
    debug = output / 'debug-mappings.json'
    debug_started = time.monotonic()
    subprocess.run(['node', '--max-old-space-size=512', str(candidate / '.github/ci/build-map-debug-check.mjs'),
                    str(runtime / '.next'), str(output / 'candidate-restored'),
                    str(packet / 'bytes/build-bundle-files.json'), str(debug)], check=True, timeout=120)
    baseline.verify_directory(runtime / '.next', packet / 'bytes/build-bundle-files.json', runtime)
    baseline.verify_directory(output / 'candidate-restored', packet / 'bytes/build-bundle-files.json', runtime)
    result = {**identity, 'kind': 'SAME_INPUT_MAP_BUNDLE_COMPARISON_NOT_RELEASE', 'records': records,
              'savedBytes': records[0]['archiveBytes'] - records[1]['archiveBytes'],
              'mapCopyPrimaryCount': len({row['source'] for row in manifests[1]['mapCopies']}),
              'mutation': mutation, 'debugMappings': json.loads(debug.read_text()),
              'debugElapsedSeconds': time.monotonic() - debug_started,
              'maximumResidentSetKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
              'allLogicalPathsBytesModesDirectoriesAliasesUnchanged': True,
              'regularFormat2ReadersRejectMapFormat3': True, 'activationExercised': False,
              'activeServiceVerified': False, 'releaseAuthorized': False}
    save(output / 'comparison.json', result)
    print(json.dumps(result, allow_nan=False))


if __name__ == '__main__':
    require(len(sys.argv) == 5, 'Usage: build-map-bundle-compare.py RUNTIME CANDIDATE PACKET PRIVATE_OUTPUT')
    compare(*(Path(value).absolute() for value in sys.argv[1:]))
