"""Observe one publisher Chrome archive as data. This entry grants no install or run authority."""
import base64
import hashlib
import hmac
import http.client
import json
import os
import pathlib
import platform
import re
import signal
import ssl
import stat
import struct
import subprocess
import tempfile
import time
import urllib.request
import zipfile
import zlib

BRANCH = 'codex/native-browser-toolchain-observation-20261109'
REF = 'refs/heads/' + BRANCH
WORKFLOW = '.github/workflows/alpha-staging.yml'
ENTRY = '.github/ci/native-workload-browser-toolchain.py'
REPOSITORY = 'StradaverseHub/ai-hr'
VERSION = '151.0.7922.34'
REVISION = '1234'
BROWSER_ROOT = 'chrome-headless-shell-linux64'
EXECUTABLE = BROWSER_ROOT + '/chrome-headless-shell'
BUCKET = 'chrome-for-testing-public'
OBJECT = VERSION + '/linux64/' + BROWSER_ROOT + '.zip'
PUBLIC_MEDIA = 'https://storage.googleapis.com/' + BUCKET + '/' + OBJECT
OBJECT_METADATA = ('https://storage.googleapis.com/storage/v1/b/' + BUCKET + '/o/'
                   + OBJECT.replace('/', '%2F'))
CATALOG = 'https://googlechromelabs.github.io/chrome-for-testing/' + VERSION + '.json'
RECEIPT = 'aihr-browser-toolchain-observation.json'
SOURCE_PINS = {
    'package.json': '7f67e35d869a29d2cb58d65c6f63413afc63db2cc6c6cf9dacb5086bce70ec2c',
    'pnpm-lock.yaml': '0413a070eca23d390fabdcd78cb63b2dcf4b0b69fe90408c7b57a4f672d21dbd',
}
KIB = 1024
MIB = 1024 * KIB
MAX_METADATA = 64 * KIB
MAX_RECEIPT = 256 * KIB
MAX_ARCHIVE = 256 * MIB
MAX_EXPANDED = 512 * MIB
MAX_MEMBER = 384 * MIB
MAX_ENTRIES = 1024
MAX_CENTRAL_DIRECTORY = 2 * MIB
CENTRAL_HEADER = struct.Struct('<4s6H3I5H2I')
END_HEADER = struct.Struct('<4s4H2IH')
ZIP64_LOCATOR_BYTES = 20
OBSERVATION_SECONDS = 150
READ_SECONDS = 10
CHUNK = 256 * KIB
SHA = re.compile(r'[a-f0-9]{40}')
SHA256 = re.compile(r'[a-f0-9]{64}')
POSITIVE = re.compile(r'[1-9][0-9]{0,19}')
PATH_PART = re.compile(r'[A-Za-z0-9][A-Za-z0-9._+-]*')
FIXED_GIT_ENV = {
    'PATH': '/usr/bin:/bin',
    'HOME': '/nonexistent',
    'LANG': 'C',
    'LC_ALL': 'C',
    'GIT_CONFIG_NOSYSTEM': '1',
    'GIT_CONFIG_GLOBAL': '/dev/null',
    'GIT_OPTIONAL_LOCKS': '0',
    'GIT_NO_REPLACE_OBJECTS': '1',
}


class Refused(Exception):
    """A closed observation failure code suitable for the public receipt."""


def need(condition, reason):
    if not condition:
        raise Refused(reason)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_object(raw, reason):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, reason)
            result[key] = value
        return result

    def bad_constant(_value):
        raise Refused(reason)

    try:
        result = json.loads(raw.decode('utf-8'), object_pairs_hook=unique, parse_constant=bad_constant)
    except (UnicodeError, ValueError, RecursionError):
        raise Refused(reason) from None
    need(type(result) is dict, reason)
    return result


def raw_file(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as handle:
        before = os.fstat(handle.fileno())
        need(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
             and before.st_nlink == 1 and 0 < before.st_size <= maximum, 'owned-source-file')
        raw = handle.read(maximum + 1)
        after = os.fstat(handle.fileno())
        need(len(raw) == before.st_size and
             (before.st_dev, before.st_ino, before.st_size, before.st_ctime_ns, before.st_mtime_ns) ==
             (after.st_dev, after.st_ino, after.st_size, after.st_ctime_ns, after.st_mtime_ns),
             'source-file-changed')
        return raw


def git(root, deadline, *args):
    result = subprocess.run(
        ['/usr/bin/git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', str(root), *args],
        env=FIXED_GIT_ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        timeout=min(READ_SECONDS, remaining(deadline)), check=False,
    )
    need(result.returncode == 0 and len(result.stdout) <= MIB, 'source-git')
    return result.stdout


def admit(deadline):
    env = os.environ
    for key, expected in {
        'GITHUB_ACTIONS': 'true', 'CI': 'true', 'GITHUB_REPOSITORY': REPOSITORY,
        'GITHUB_REPOSITORY_ID': '1333414856', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
        'GITHUB_WORKFLOW': 'alpha-staging-ci', 'GITHUB_WORKFLOW_REF': REPOSITORY + '/' + WORKFLOW + '@' + REF,
        'GITHUB_REF': REF, 'GITHUB_REF_NAME': BRANCH, 'GITHUB_RUN_ATTEMPT': '1',
        'GITHUB_JOB': 'runner-diagnostics', 'RUNNER_ENVIRONMENT': 'github-hosted',
        'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64',
    }.items():
        need(env.get(key) == expected, 'observation-context')
    need(os.getuid() > 0 and platform.system() == 'Linux' and platform.machine() == 'x86_64'
         and not any(env.get(key) for key in ('GH_TOKEN', 'GITHUB_TOKEN')), 'observation-process')
    sha, run_id = env.get('GITHUB_SHA', ''), env.get('GITHUB_RUN_ID', '')
    need(SHA.fullmatch(sha) and POSITIVE.fullmatch(run_id)
         and all(env.get(key) == sha for key in ('GITHUB_WORKFLOW_SHA', 'AIHR_CI_CONTROL_HEAD', 'AIHR_CI_HEAD')),
         'self-controller-source')
    temp = pathlib.Path(env['RUNNER_TEMP'])
    workspace = pathlib.Path(env['GITHUB_WORKSPACE'])
    root = workspace / 'automation'
    need(temp.is_absolute() and temp.resolve(strict=True) == temp and temp.is_dir() and temp.stat().st_uid == os.getuid()
         and root.resolve(strict=True) == root == pathlib.Path.cwd()
         and pathlib.Path(__file__).resolve(strict=True) == root / ENTRY, 'observation-layout')
    event_path = pathlib.Path(env['GITHUB_EVENT_PATH'])
    need(event_path == temp / '_github_workflow/event.json'
         and event_path.resolve(strict=True) == event_path, 'observation-event-path')
    event = json_object(raw_file(event_path, MIB), 'observation-event')
    repo = event.get('repository')
    need(type(repo) is dict and repo.get('id') == 1333414856 and repo.get('full_name') == REPOSITORY
         and event.get('ref') in (BRANCH, REF), 'observation-event')
    need(event.get('inputs') == {
        'candidate_ref': BRANCH, 'expected_sha': sha, 'test_parallelism': '4',
        'build_only': 'false', 'diagnostics_only': 'true', 'controller_only': 'false',
    }, 'observation-inputs')
    need(git(root, deadline, 'rev-parse', 'HEAD') == (sha + '\n').encode()
         and git(root, deadline, 'status', '--porcelain', '--untracked-files=all') == b'', 'source-checkout')
    sources = {}
    for path in (*SOURCE_PINS, ENTRY, WORKFLOW):
        current = raw_file(root / path, MIB)
        need(current == git(root, deadline, 'show', 'HEAD:' + path), 'source-checkout')
        source_sha = digest(current)
        need(path not in SOURCE_PINS or SOURCE_PINS[path] == source_sha, 'source-package-pin')
        sources[path] = {'bytes': len(current), 'sha256': source_sha}
    memory = re.search(r'^MemTotal:\s+([0-9]+) kB$', pathlib.Path('/proc/meminfo').read_text(), re.MULTILINE)
    os_release = platform.freedesktop_os_release()
    cpus = len(os.sched_getaffinity(0))
    need(memory and cpus == 4 and os_release.get('ID') == 'ubuntu' and os_release.get('VERSION_ID') == '24.04',
         'standard-runner-profile')
    memory_bytes = int(memory[1]) * KIB
    need(15 * 1024**3 <= memory_bytes <= 17 * 1024**3, 'standard-runner-profile')
    return temp, {
        'kind': 'BROWSER_TOOLCHAIN_PUBLISHER_OBSERVATION_ONLY', 'version': 1,
        'source': sha, 'controller': sha, 'runId': run_id, 'attempt': 1, 'job': 'runner-diagnostics',
        'runner': {'os': 'ubuntu-24.04', 'arch': 'x86_64', 'cpus': cpus, 'memoryBytes': memory_bytes},
        'sources': sources, 'packageHooksExecuted': False, 'chromiumExecuted': False,
        'databaseExecuted': False, 'releaseEligible': False, 'installAuthorized': False,
    }


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _request, _fp, _code, _msg, _headers, _newurl):
        return None


def remaining(deadline):
    value = deadline - time.monotonic()
    need(value > 0, 'observation-deadline')
    return value


def header(response, name, required=False):
    values = response.headers.get_all(name, [])
    need(len(values) <= 1 and (not required or len(values) == 1), 'publisher-header')
    return values[0] if values else None


def request(opener, url, accept, deadline):
    req = urllib.request.Request(url, headers={
        'Accept': accept, 'Accept-Encoding': 'identity', 'User-Agent': 'aihr-browser-toolchain-observation/1',
    })
    response = opener.open(req, timeout=min(READ_SECONDS, remaining(deadline)))
    try:
        need(response.status == 200 and response.geturl() == url and
             header(response, 'Content-Encoding') in (None, 'identity') and
             header(response, 'Content-Range') is None, 'publisher-response')
    except BaseException:
        response.close()
        raise
    return response


def get_json(opener, url, deadline):
    with request(opener, url, 'application/json', deadline) as response:
        length = header(response, 'Content-Length')
        if length is not None:
            need(POSITIVE.fullmatch(length) and int(length) <= MAX_METADATA, 'publisher-metadata-length')
        raw = response.read(MAX_METADATA + 1)
        remaining(deadline)
        need(0 < len(raw) <= MAX_METADATA and (length is None or len(raw) == int(length)),
             'publisher-metadata-length')
    return raw, json_object(raw, 'publisher-metadata-json')


def canonical_base64(value, size):
    need(isinstance(value, str) and len(value) <= 32, 'publisher-object-hash')
    try:
        raw = base64.b64decode(value, validate=True)
    except ValueError:
        raise Refused('publisher-object-hash') from None
    need(len(raw) == size and base64.b64encode(raw).decode('ascii') == value, 'publisher-object-hash')
    return value


def catalog_facts(value):
    downloads = value.get('downloads')
    need(value.get('version') == VERSION and type(downloads) is dict, 'publisher-catalog')
    variants = downloads.get('chrome-headless-shell')
    need(type(variants) is list and all(type(row) is dict for row in variants), 'publisher-catalog')
    matches = [row for row in variants if row.get('platform') == 'linux64']
    need(len(matches) == 1 and matches[0].get('url') == PUBLIC_MEDIA, 'publisher-catalog')
    published_sha = matches[0].get('sha256')
    need('sha256' not in matches[0] or isinstance(published_sha, str) and SHA256.fullmatch(published_sha),
         'publisher-catalog-sha256')
    return published_sha


def object_facts(value):
    need(value.get('kind') == 'storage#object' and value.get('bucket') == BUCKET and value.get('name') == OBJECT,
         'publisher-object')
    generation, metageneration, size = (value.get(key) for key in ('generation', 'metageneration', 'size'))
    need(all(isinstance(item, str) and POSITIVE.fullmatch(item) for item in (generation, metageneration, size))
         and int(size) <= MAX_ARCHIVE, 'publisher-object-identity')
    md5 = canonical_base64(value.get('md5Hash'), 16)
    crc32c = canonical_base64(value['crc32c'], 4) if 'crc32c' in value else None
    return {'generation': generation, 'metageneration': metageneration, 'bytes': int(size),
            'md5': md5, 'crc32c': crc32c}


def fetch_archive(opener, facts, archive, deadline):
    url = OBJECT_METADATA + '?alt=media&generation=' + facts['generation']
    sha = hashlib.sha256()
    md5 = hashlib.md5(usedforsecurity=False)
    size = 0
    with request(opener, url, 'application/zip, application/octet-stream', deadline) as response:
        length = header(response, 'Content-Length', True)
        generation = header(response, 'x-goog-generation', True)
        metageneration = header(response, 'x-goog-metageneration')
        need(length == str(facts['bytes']) and generation == facts['generation']
             and metageneration in (None, facts['metageneration']), 'publisher-media-identity')
        media = {'url': url, 'status': response.status, 'contentLength': int(length), 'generation': generation,
                 'metageneration': metageneration, 'contentEncoding': header(response, 'Content-Encoding')}
        while True:
            remaining(deadline)
            block = response.read(min(CHUNK, facts['bytes'] - size + 1))
            if not block:
                break
            size += len(block)
            need(size <= facts['bytes'], 'publisher-media-length')
            sha.update(block)
            md5.update(block)
            archive.write(block)
    need(size == facts['bytes'], 'publisher-media-length')
    need(hmac.compare_digest(base64.b64encode(md5.digest()).decode('ascii'), facts['md5']),
         'publisher-media-md5')
    archive.flush()
    return sha.hexdigest(), media


def classic_extra_fields(extra):
    cursor = 0
    while cursor < len(extra):
        need(len(extra) - cursor >= 4, 'zip-central-extra')
        kind, length = struct.unpack_from('<HH', extra, cursor)
        need(kind != 0x0001, 'zip64-central-extra')
        cursor += 4 + length
        need(cursor <= len(extra), 'zip-central-extra')


def archive_count(archive, size, deadline):
    # Bound the bytes and actual records before ZipFile allocates its directory.
    # CPython otherwise lets a locator override the validated classic EOCD.
    archive.seek(0, os.SEEK_END)
    need(archive.tell() == size, 'zip-archive-size')
    end = size - END_HEADER.size
    need(end >= ZIP64_LOCATOR_BYTES, 'zip-central-directory')
    archive.seek(end - ZIP64_LOCATOR_BYTES)
    need(archive.read(4) != b'PK\x06\x07', 'zip64-locator')
    archive.seek(end)
    marker, disk, central_disk, disk_count, count, central_size, offset, comment = END_HEADER.unpack(
        archive.read(END_HEADER.size),
    )
    need(marker == b'PK\x05\x06' and disk == central_disk == comment == 0 and disk_count == count
         and 0 < count <= MAX_ENTRIES and 0 < central_size <= MAX_CENTRAL_DIRECTORY
         and 0 < offset < end and offset + central_size == end, 'zip-central-directory')
    archive.seek(offset)
    expanded = 0
    for _ in range(count):
        remaining(deadline)
        need(end - archive.tell() >= CENTRAL_HEADER.size, 'zip-central-record')
        (marker, _created, needed, _flags, _method, _clock, _date, _crc, compressed, uncompressed,
         name_length, extra_length, comment_length, disk_start, _internal, _external,
         local_offset) = CENTRAL_HEADER.unpack(archive.read(CENTRAL_HEADER.size))
        need(marker == b'PK\x01\x02', 'zip-central-record')
        need(needed < 45 and disk_start == 0 and all(value != 0xffffffff for value in (
            compressed, uncompressed, local_offset,
        )), 'zip64-central-record')
        need(0 < name_length <= 256 and name_length + extra_length + comment_length <= end - archive.tell()
             and local_offset + 30 + compressed <= offset and uncompressed <= MAX_MEMBER, 'zip-central-record')
        expanded += uncompressed
        need(expanded <= MAX_EXPANDED, 'zip-expanded-bound')
        archive.seek(name_length, os.SEEK_CUR)
        extra = archive.read(extra_length)
        need(len(extra) == extra_length, 'zip-central-extra')
        classic_extra_fields(extra)
        archive.seek(comment_length, os.SEEK_CUR)
    need(archive.tell() == end, 'zip-central-record-count')
    return count


def member_identity(member):
    raw = member.orig_filename
    name = raw[:-1] if member.is_dir() else raw
    parts = name.split('/')
    need(raw == member.filename and len(name) <= 255 and 1 <= len(parts) <= 12
         and parts[0] == BROWSER_ROOT and all(PATH_PART.fullmatch(part) for part in parts), 'zip-member-path')
    mode = member.external_attr >> 16
    file_type = stat.S_IFMT(mode)
    if member.is_dir():
        need(file_type in (0, stat.S_IFDIR) and member.file_size == 0, 'zip-member-type')
    else:
        need(len(parts) > 1 and file_type in (0, stat.S_IFREG) and
             0 <= member.file_size <= MAX_MEMBER, 'zip-member-type')
    need(not mode & 0o7000 and not member.flag_bits & ~0x080e and
         member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'zip-member-mode')
    return name, mode


def archive_tree(archive, size, deadline):
    expected_count = archive_count(archive, size, deadline)
    observed = {}
    expanded = 0
    with zipfile.ZipFile(archive) as contents:
        members = contents.infolist()
        need(len(members) == expected_count, 'zip-member-count')
        for member in members:
            remaining(deadline)
            name, mode = member_identity(member)
            need(name not in observed, 'zip-duplicate-member')
            expanded += member.file_size
            need(expanded <= MAX_EXPANDED, 'zip-expanded-bound')
            if member.is_dir():
                with contents.open(member) as source:
                    need(source.read(1) == b'', 'zip-directory-content')
                observed[name] = ['directory', 0o555, 0, None]
                continue
            length = 0
            sha = hashlib.sha256()
            with contents.open(member) as source:
                first = source.read(64)
                if name == EXECUTABLE:
                    need(len(first) == 64 and first[:7] == b'\x7fELF\x02\x01\x01'
                         and struct.unpack_from('<HHI', first, 16) in ((2, 62, 1), (3, 62, 1))
                         and mode & 0o111, 'zip-browser-elf')
                block = first
                while block:
                    remaining(deadline)
                    length += len(block)
                    need(length <= member.file_size, 'zip-member-length')
                    sha.update(block)
                    block = source.read(CHUNK)
            need(length == member.file_size, 'zip-member-length')
            observed[name] = ['file', 0o555 if mode & 0o111 else 0o444, length, sha.hexdigest()]
    need(EXECUTABLE in observed and observed[EXECUTABLE][0] == 'file', 'zip-browser-elf')
    rows = dict(observed)
    for name in observed:
        for parent in pathlib.PurePosixPath(name).parents:
            if parent == pathlib.PurePosixPath('.'):
                break
            path = parent.as_posix()
            directory = rows.setdefault(path, ['directory', 0o555, 0, None])
            need(directory[0] == 'directory', 'zip-path-collision')
    need(len(rows) <= MAX_ENTRIES, 'zip-tree-count')
    tree = [[name, *rows[name]] for name in sorted(rows)]
    # The full archive digest binds the raw bytes. This projection describes
    # the declared bytes decoded by stdlib, without admitting stream framing.
    return {'archiveMembers': expected_count, 'treeMembers': len(tree), 'expandedBytes': expanded,
            'treeScope': 'STDLIB_DECLARED_DECODED_MEMBERS', 'strictMemberFramingVerified': False,
            'treeSha256': digest(canonical(tree)), 'rows': tree,
            'executable': {'path': EXECUTABLE, 'bytes': rows[EXECUTABLE][2], 'sha256': rows[EXECUTABLE][3]}}


def raw_evidence(raw):
    return {'bytes': len(raw), 'sha256': digest(raw), 'base64': base64.b64encode(raw).decode('ascii')}


def observe(temp, start, deadline):
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    tls.load_verify_locations(cafile='/etc/ssl/certs/ca-certificates.crt')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
                                         urllib.request.HTTPSHandler(context=tls))
    catalog_raw, catalog = get_json(opener, CATALOG, deadline)
    published_sha = catalog_facts(catalog)
    metadata_raw, metadata = get_json(opener, OBJECT_METADATA, deadline)
    facts = object_facts(metadata)
    with tempfile.TemporaryFile(mode='w+b', dir=temp) as archive:
        identity = os.fstat(archive.fileno())
        need(stat.S_ISREG(identity.st_mode) and identity.st_uid == os.getuid() and identity.st_nlink == 0
             and stat.S_IMODE(identity.st_mode) == 0o600, 'observation-scratch')
        observed_sha, media = fetch_archive(opener, facts, archive, deadline)
        need(published_sha is None or hmac.compare_digest(published_sha, observed_sha),
             'publisher-media-sha256')
        tree = archive_tree(archive, facts['bytes'], deadline)
    remaining(deadline)
    return {'catalog': {'url': CATALOG, **raw_evidence(catalog_raw)},
            'object': {'bucket': BUCKET, 'name': OBJECT, 'metadataUrl': OBJECT_METADATA,
                       'metadata': raw_evidence(metadata_raw), **facts},
            'archive': {'sha256': observed_sha, 'publisherSha256': published_sha, 'media': media, **tree},
            'archiveScratchClosed': archive.closed, 'durationMs': round((time.monotonic() - start) * 1000)}


def write_receipt(temp, value):
    payload = canonical(value)
    need(0 < len(payload) <= MAX_RECEIPT, 'observation-receipt-bound')
    fd = os.open(temp / RECEIPT, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def main():
    def expired(_signum, _frame):
        raise Refused('observation-deadline')

    start = time.monotonic()
    deadline = start + OBSERVATION_SECONDS
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, OBSERVATION_SECONDS)
    try:
        temp, binding = admit(deadline)
        binding.update({'browserVersion': VERSION, 'playwrightRevision': REVISION})
        try:
            result = observe(temp, start, deadline)
            need(result['archiveScratchClosed'], 'observation-scratch')
            evidence = {**binding, 'outcome': 'observed', **result}
            need(len(canonical(evidence)) <= MAX_RECEIPT, 'observation-receipt-bound')
        except Refused as error:
            evidence = {**binding, 'outcome': 'unavailable', 'reason': str(error)}
        except (OSError, ValueError, RuntimeError, EOFError, http.client.HTTPException,
                struct.error, zipfile.BadZipFile, zlib.error):
            evidence = {**binding, 'outcome': 'unavailable', 'reason': 'publisher-transfer-or-archive-refused'}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    write_receipt(temp, evidence)
    return 0 if evidence['outcome'] == 'observed' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (Refused, OSError, KeyError, subprocess.SubprocessError):
        raise SystemExit('Browser toolchain observation admission or receipt refused') from None
