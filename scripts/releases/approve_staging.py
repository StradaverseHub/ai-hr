#!/usr/bin/env python3
"""Final operator staging acceptance -> immutable production packages. No deployment."""
import argparse
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shlex
import subprocess
import sys
import tarfile
from zoneinfo import ZoneInfo

REPOSITORY = 'StradaverseHub/ai-hr'
REPOSITORY_ID = 1333414856
RELEASE_REPOSITORY = 'StradaverseHub/ai-hr-releases'
RELEASE_REPOSITORY_ID = 1434418441
ROOT = Path(__file__).resolve().parents[2]
SHA = re.compile(r'^[0-9a-f]{40}$')
BUILD = re.compile(r'^[A-Za-z0-9_-]{1,100}$')
TAG = re.compile(r'^prod-(\d{4}-\d{2}-\d{2})\.([1-9]\d*)$')


def require(ok, message):
    if not ok:
        raise ValueError(message)


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs).stdout


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def save(path, value):
    temporary = path.with_suffix('.pending')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def date_in_kl(instant):
    return instant.astimezone(ZoneInfo('Asia/Kuala_Lumpur')).date().isoformat()


def next_tag(date, tags):
    numbers = [int(m[2]) for t in tags if (m := TAG.fullmatch(t)) and m[1] == date]
    return f'prod-{date}.{max(numbers, default=0) + 1}'


def private_path(name):
    p = PurePosixPath(name)
    return (any(x in {'.git', '.ssh', '.improve'} for x in p.parts)
            or p.name in {'runtime.env', 'deploy.env', 'provision.env', 'installation-secrets.json', '.npmrc'}
            or (p.name.startswith('.env') and not p.name.endswith(('.example', '.sample', '.template'))))


def audit_archive(path, runtime=False, build=None, lock=None):
    """Inspect without extraction; pnpm relative links must stay inside allowed roots."""
    names, files, links, special = set(), {}, [], {}
    total = 0
    with tarfile.open(path, 'r:gz') as archive:
        for item in archive:
            name = item.name.rstrip('/')
            require(name and not name.startswith('/') and '..' not in PurePosixPath(name).parts,
                    'Unsafe archive path')
            require(name not in names, 'Duplicate archive path: ' + name)
            names.add(name)
            require(len(names) <= 500000, 'Archive exceeds entry bound')
            require(not private_path(name), 'Private configuration in package: ' + name)
            if runtime:
                require(PurePosixPath(name).parts[0] in {'.next', 'node_modules'}, 'Unexpected runtime root')
                require(not any(name == p or name.startswith(p + '/') for p in
                                ('.next/cache', '.next/dev', '.next/trace', 'node_modules/.cache')),
                        'Application cache in runtime')
            require(item.isdir() or item.isfile() or item.issym() or item.islnk(), 'Special archive entry')
            if item.issym() or item.islnk():
                require(not item.linkname.startswith('/'), 'Absolute archive link')
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), item.linkname)
                                           if item.issym() else item.linkname)
                require(target != '..' and not target.startswith('../'), 'Escaping archive link')
                if runtime:
                    require(target.split('/')[0] in {'.next', 'node_modules'}, 'Escaping runtime link')
                require(not private_path(target), 'Private archive link')
                links.append((name, target))
            elif item.isfile():
                total += item.size
                require(total <= 8 * 1024**3 and len(names) <= 500000, 'Archive exceeds inventory bound')
                stream = archive.extractfile(item)
                h = hashlib.sha256()
                collect = name in {'.next/BUILD_ID', 'node_modules/.deploy-lockfile-sha', '.next/prerender-manifest.json'}
                require(not collect or item.size <= 4 * 1024**2, 'Oversized runtime identity')
                content = bytearray()
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    h.update(block)
                    if collect:
                        content.extend(block)
                files[name] = h.hexdigest()
                if collect:
                    special[name] = bytes(content)
        # Links through another symlink could escape even if each textual target looks safe.
        link_map = dict(links)
        for name, target in links:
            visited = {name}
            for _ in range(100):
                parts = target.split('/')
                prefix = next(('/'.join(parts[:i]) for i in range(1, len(parts)+1)
                               if '/'.join(parts[:i]) in link_map), None)
                if prefix is None:
                    break
                require(prefix not in visited, 'Cyclic archive link')
                visited.add(prefix)
                target = posixpath.normpath(link_map[prefix] + target[len(prefix):])
            else:
                raise ValueError('Archive link depth exceeded')
            require(target != '..' and not target.startswith('../') and not target.startswith('/'), 'Escaping link chain')
            require(not private_path(target), 'Private link chain')
            if runtime:
                require(target.split('/')[0] in {'.next', 'node_modules'}, 'Escaping runtime link chain')
    if runtime:
        require(special.get('.next/BUILD_ID', b'').decode().strip() == build, 'Runtime build ID mismatch')
        require(special.get('node_modules/.deploy-lockfile-sha', b'').decode().strip() == lock, 'Runtime lockfile mismatch')
        prerender = json.loads(special.get('.next/prerender-manifest.json', b'{}'))
        require('routes' in prerender and 'dynamicRoutes' in prerender, 'Missing prerender inventory')
        require(set(prerender['routes']) <= {'/_not-found', '/_global-error', '/404', '/500'},
                'Runtime contains prerendered application data; review before publication')
        require(not prerender['dynamicRoutes'], 'Runtime contains dynamic prerender data')
    require(files, 'Empty archive')
    return files


BUILD_ALIAS = re.compile(r'\.next/node_modules/(sharp|fontkit)-[a-f0-9]{8,64}')


def relativize_build_aliases(source, destination, directory):
    """CI-installed builds (.github/ci/build-bundle.py) link Next's two external-package aliases to
    absolute dependency paths under the installation directory. Repoint only those aliases to the same
    dependency relative to the package; every other link, and any alias aimed elsewhere, is left for
    audit_archive to refuse."""
    prefix = posixpath.normpath(directory) + '/node_modules/'
    rewritten = []
    with tarfile.open(source, 'r:gz') as captured, \
            tarfile.open(destination, 'w:gz', compresslevel=1, format=captured.format) as output:
        for item in captured:
            name = item.name.rstrip('/')
            target = posixpath.normpath(item.linkname) if item.issym() else ''
            if BUILD_ALIAS.fullmatch(name) and target.startswith(prefix):
                item.linkname = posixpath.relpath('node_modules/' + target[len(prefix):], posixpath.dirname(name))
                rewritten.append(name)
            output.addfile(item, captured.extractfile(item) if item.isfile() else None)
    return rewritten


def staged_source(name):
    """Match official release rsync exclusions; all application/source files are still hashed."""
    parts = PurePosixPath(name).parts
    return not (any(p in {'node_modules', '.next', '.git', '.turbo', 'coverage', '.claude',
                         'graphify-out', '.vitest-attachments'} or p.startswith('.env') for p in parts)
                or parts[0] in {'scratchpad', '.improve'}
                or name == 'docs/HANDOFF-HISTORY.md' or name.startswith('docs/adr/')
                or any(name.startswith('mobile/' + p + '/') for p in ('android', 'ios', 'dist', 'builds', '.expo'))
                or (name.startswith('mobile/') and (name == 'mobile/credentials.json'
                    or PurePosixPath(name).suffix in {'.p8', '.key', '.pem', '.p12', '.jks', '.keystore', '.mobileprovision'})))


# Remote code only reads the active service, deploy status, committed source and public build identity.
# It never reads any environment file, database, operator credential or installation secret.
SNAPSHOT = r'''
import hashlib,http.client,json,os,pathlib,platform,subprocess,sys,time
p=json.load(sys.stdin);root=pathlib.Path(p['directory']);os.chdir(root)
def command(args):return subprocess.run(args,check=True,capture_output=True,text=True).stdout.strip()
status=dict(line.split('=',1) for line in command(['bash','deploy/deploy-state.sh','status']).splitlines() if '=' in line)
if not (status.get('state')=='ok' and status.get('stale_build')=='0' and status.get('ref')==p['sha']==status.get('built_ref')):raise RuntimeError('Staging is not a completed exact-commit build')
build=(root/'.next/BUILD_ID').read_text().strip()
if not (build==status.get('build_id')==status.get('built_build_id')):raise RuntimeError('Staging build identity mismatch')
if platform.system()!='Linux' or platform.machine()!='x86_64':raise RuntimeError('Linux x64 runtime required')
command(['systemctl','is-active','--quiet',p['service']])
pid=int(command(['systemctl','show',p['service'],'--property=MainPID','--value']))
if pid<1 or pathlib.Path('/proc/'+str(pid)+'/cwd').resolve()!=root.resolve():raise RuntimeError('Wrong service working directory')
stat=pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()
started=time.time()-float(pathlib.Path('/proc/uptime').read_text().split()[0])+int(stat[19])/os.sysconf('SC_CLK_TCK')
if started+1<(root/'.next/BUILD_ID').stat().st_mtime:raise RuntimeError('Service was not restarted after the build')
for name,wanted in p['files'].items():
 f=root/name
 if not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest()!=wanted:raise RuntimeError('Staging source differs from approved commit')
lock=(root/'node_modules/.deploy-lockfile-sha').read_text().strip()
if lock!=p['lock']:raise RuntimeError('Staging dependency lockfile mismatch')
conn=http.client.HTTPConnection('127.0.0.1',3000,timeout=15);conn.request('GET','/health');response=conn.getresponse();response.read(1048576);conn.close()
if response.status not in (200,401):raise RuntimeError('Staging health failed')
node=command([str(pathlib.Path('/proc/'+str(pid)+'/exe').resolve()),'--version'])
next_version=json.loads((root/'node_modules/next/package.json').read_text())['version']
print(json.dumps({'sha':p['sha'],'buildId':build,'pid':pid,'buildMtime':(root/'.next/BUILD_ID').stat().st_mtime_ns,'lock':lock,'nodeVersion':node,'nextVersion':next_version,'healthStatus':response.status,'sourceFilesVerified':len(p['files']),'platform':'linux','architecture':'x86_64'}))
'''


def github_environment(account=None):
    """Use a stored account only in child processes; never switch shared gh state."""
    env = os.environ.copy()
    env.update(GH_HOST='github.com', GIT_TERMINAL_PROMPT='0', GH_PROMPT_DISABLED='1')
    if account:
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}', account), 'Invalid GitHub account')
        lookup = env.copy()
        for name in ('GH_TOKEN', 'GITHUB_TOKEN'):
            lookup.pop(name, None)
        token = run(['gh', 'auth', 'token', '--hostname', 'github.com', '--user', account], env=lookup).decode().strip()
        require(token and '\n' not in token and '\r' not in token, 'Stored GitHub account has no valid token')
        env['GH_TOKEN'] = token
        env.pop('GITHUB_TOKEN', None)
    return env


class GitHub:
    def __init__(self, repository=REPOSITORY, environment=None):
        self.repository = repository
        self.environment = environment

    def api(self, path, method='GET', value=None):
        args = ['gh', 'api', f'repos/{self.repository}' + ('/' + path if path else ''), '--method', method]
        if value is not None:
            args += ['--input', '-']
        return json.loads(run(args, input=None if value is None else json.dumps(value).encode(), env=self.environment))

    def asset(self, asset):
        require(asset['size'] <= 4 * 1024**2, 'Oversized release metadata')
        return run(['gh', 'api', '-H', 'Accept: application/octet-stream',
                    f'repos/{self.repository}/releases/assets/{asset["id"]}'], env=self.environment)

    def releases(self):
        for page in range(1, 11):
            values = self.api(f'releases?per_page=100&page={page}')
            yield from values
            if len(values) < 100:
                return
        raise ValueError('Release inventory exceeds bound')

    def upload(self, tag, files):
        run(['gh', 'release', 'upload', tag, '--repo', self.repository, *map(str, files)], env=self.environment)


    def mirror(self, source, state):
        require(self.repository == RELEASE_REPOSITORY and source.repository == REPOSITORY, 'Invalid tag transport')
        git = ['git', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential']
        run(git + ['fetch', '--no-tags', '--no-write-fetch-head',
                   f'https://github.com/{REPOSITORY}.git', state['tagObject']], cwd=ROOT, env=self.environment)
        require(run(['git', 'rev-parse', state['tagObject'] + '^{commit}'], cwd=ROOT).decode().strip()
                == state['sha'], 'Fetched source tag differs')
        run(git + ['push', '--porcelain', '--no-follow-tags', f'https://github.com/{RELEASE_REPOSITORY}.git',
                   state['tagObject'] + ':refs/tags/' + state['tag']], cwd=ROOT, env=self.environment)


def branches(github, sha):
    """Prove release lineage, never choose a candidate from a moving branch head."""
    repo = github.api('')
    require(repo['id'] == REPOSITORY_ID and repo['full_name'] == REPOSITORY,
            'Source must be the canonical repository')
    heads = {}
    for branch in ('alpha', 'main'):
        head = github.api('git/ref/heads/' + branch)['object']['sha']
        require(SHA.fullmatch(head), 'Invalid published ' + branch + ' commit')
        heads[branch] = head
        if head != sha:
            # Compare immutable IDs, not branch names that can move between API calls.
            comparison = github.api(f'compare/{sha}...{head}?per_page=1')
            require(comparison['status'] == 'ahead' and comparison['merge_base_commit']['sha'] == sha,
                    'Approved source must be contained in published ' + branch)
    return heads


def private_destination(github):
    repo = github.api('')
    require(repo['private'] is True and repo['full_name'] == RELEASE_REPOSITORY
            and repo['id'] == RELEASE_REPOSITORY_ID and repo.get('permissions', {}).get('push') is True,
            'Production assets require write access to the verified private release repository')
    return repo['id']


def mirror_tag(source, packages, state):
    """Copy the exact annotated source tag, never push a branch or force an existing ref."""
    path = 'git/ref/tags/' + state['tag']
    try:
        existing = packages.api(path)
    except subprocess.CalledProcessError:
        existing = None
    if existing is None:
        packages.mirror(source, state)
        existing = packages.api(path)
    require(existing['object']['type'] == 'tag' and existing['object']['sha'] == state['tagObject'],
            'Private release tag differs; refusing replacement')
    obj = packages.api('git/tags/' + state['tagObject'])
    require(obj['object']['sha'] == state['sha'] and obj['object']['type'] == 'commit',
            'Private release source differs')


def verify_assets(release, expected, notes):
    assets = release['assets']
    require(len(assets) == len(expected), 'Unexpected or incomplete release assets')
    actual = {a['name']: a for a in assets}
    require(set(actual) == set(expected), 'Release asset inventory mismatch')
    for name, wanted in expected.items():
        a = actual[name]
        require(a['state'] == 'uploaded' and a['size'] == wanted['bytes']
                and a.get('digest') == 'sha256:' + wanted['sha256'], 'GitHub asset digest mismatch: ' + name)
    require(release['body'].strip() == notes.strip() and not release['prerelease'], 'Release notes/identity mismatch')


def publish(source, github, directory, state, checkpoint):
    """Remote ref creation arbitrates concurrent publishers; never overwrite a tag or asset."""
    destination_id = private_destination(github)
    require(state.get('releaseRepositoryId', destination_id) == destination_id, 'Private release repository identity changed')
    if 'releaseRepositoryId' not in state:
        state['releaseRepositoryId'] = destination_id; checkpoint(state)
    identity = f"aihr-staging-release:{state['sha']}:{state['buildId']}"
    if not state.get('tag'):
        # Also prevents duplicates from another operator/output directory, including the initial manual release.
        for inventory in (source, github):
            for release in inventory.releases():
                if not TAG.fullmatch(release['tag_name']):
                    continue
                manifests = [a for a in release['assets'] if a['name'] == 'release-manifest.json']
                if manifests:
                    manifest = json.loads(inventory.asset(manifests[0]))
                    if manifest.get('commit') == state['sha'] and manifest.get('buildId') == state['buildId']:
                        raise ValueError('This staging build already has a release (resume with its original local output): ' + release['html_url'])
        for _ in range(8):
            refs = source.api('git/matching-refs/tags/prod-')
            require(len(refs) <= 10000, 'Production tag inventory exceeds bound')
            tag = next_tag(state['date'], [r['ref'].removeprefix('refs/tags/') for r in refs])
            # Refuse another approval of the same build even across dates or output directories.
            for ref in refs:
                if ref['object']['type'] == 'tag':
                    obj = source.api('git/tags/' + ref['object']['sha'])
                    require(identity not in obj['message'], 'This build already has a reserved production tag; resume the original output')
            obj = source.api('git/tags', 'POST', {'tag': tag, 'message': 'Approved staging package\n' + identity,
                                                'object': state['sha'], 'type': 'commit'})
            # Save BEFORE the remote mutation so an interrupted/unknown response can resume this exact tag.
            state.update(tag=tag, tagObject=obj['sha']); checkpoint(state)
            try:
                source.api('git/refs', 'POST', {'ref': 'refs/tags/' + tag, 'sha': obj['sha']})
                break
            except subprocess.CalledProcessError:
                found = source.api('git/ref/tags/' + tag)
                if found['object']['sha'] == obj['sha']:
                    break
                del state['tag']; del state['tagObject']; checkpoint(state)
        else:
            raise ValueError('Tag allocation remained busy; retry')
    tag = state['tag']
    try:
        ref = source.api('git/ref/tags/' + tag)
    except subprocess.CalledProcessError:
        source.api('git/refs', 'POST', {'ref': 'refs/tags/' + tag, 'sha': state['tagObject']})
        ref = source.api('git/ref/tags/' + tag)
    require(ref['object']['type'] == 'tag' and ref['object']['sha'] == state['tagObject'], 'Production tag changed')
    obj = source.api('git/tags/' + state['tagObject'])
    require(obj['object']['sha'] == state['sha'] and obj['object']['type'] == 'commit'
            and identity in obj['message'], 'Annotated tag source mismatch')
    mirror_tag(source, github, state)
    source_name = f'ai-hr-{tag}-source.tar.gz'
    runtime_name = f'ai-hr-{tag}-linux-x64-runtime.tar.gz'
    for original, name in [('source.tar.gz', source_name), ('runtime.tar.gz', runtime_name)]:
        target = directory / name
        if not target.exists():
            os.link(directory / original, target)
        require(digest(target) == state['archives'][original]['sha256'], 'Prepared archive changed')
    artifacts = [dict(name=n, **state['archives'][old]) for old, n in
                 [('source.tar.gz', source_name), ('runtime.tar.gz', runtime_name)]]
    manifest = {'schemaVersion': 1, 'release': tag, 'releaseDate': state['date'],
                'releaseDateTimezone': 'Asia/Kuala_Lumpur', 'repository': REPOSITORY,
                'packageRepository': RELEASE_REPOSITORY, 'packageRepositoryId': state['releaseRepositoryId'],
                'commit': state['sha'], 'buildId': state['buildId'], 'platform': 'linux', 'architecture': 'x86_64',
                'stagingRuntimeNodeVersion': state['snapshot']['nodeVersion'], 'nextVersion': state['snapshot']['nextVersion'],
                'artifacts': artifacts, 'stagingApproval': {'acceptedAt': state['acceptedAt'], 'kind': state['approvalKind'],
                    'evidenceSha256': state['evidenceSha256'], 'sourceFilesVerified': state['snapshot']['sourceFilesVerified']},
                'verification': {'publisherReassessesApplicationGate': False, 'productionDeploymentPerformed': False},
                'installation': {'sourceAndRuntimeArchivesBothRequired': True, 'nodeRuntimeIncluded': False,
                    'privateConfigurationIncluded': False, 'databaseDataIncluded': False, 'applicationCacheIncluded': False,
                    'normalUpdatesPreserveDatabase': True}}
    save(directory / 'release-manifest.json', manifest)
    notes = f'''AI HR production package `{tag}`

Approved staging source: `{state['sha']}`  
Staging build: `{state['buildId']}`  
Acceptance: {state['approvalKind']}; {state['acceptedAt']}.

This release packages the existing Linux x64 staging build without rebuilding it. The publisher checks the running service, exact source, build ID, dependency lockfile, health and archive inventory. Application gate evidence remains the staging release owner's responsibility; this publication does not create a new full-gate PASS or claim a production deployment.

Install both the source and runtime archives into the same application release directory. Supply the compatible Node runtime and private production configuration separately. Apply pending migrations using the normal production deployment procedure; preserve the database during updates. These packages contain no installation environment files, database export or application cache.

Verify the downloaded assets with `shasum -a 256 -c SHA256SUMS` (or `sha256sum -c SHA256SUMS` on Linux). Published tags and assets are immutable; corrections need a new release. The release manifest records the approved source and evidence digest.

<!-- {identity} -->
'''
    # GitHub generated notes contain the commit/PR changes since the previous published release.
    # Save once so resume cannot silently change notes after another release is published.
    notes_path = directory / 'RELEASE_NOTES.md'
    if not notes_path.exists():
        previous = next((r['tag_name'] for r in github.releases()
                         if TAG.fullmatch(r['tag_name']) and not r['draft'] and not r['prerelease'] and r['tag_name'] != tag), None)
        request = {'tag_name': tag, 'target_commitish': state['sha']}
        if previous:
            request['previous_tag_name'] = previous
        generated = source.api('releases/generate-notes', 'POST', request)
        notes_path.write_text(notes + '\n' + generated['body'] + '\n'); notes_path.chmod(0o600)
    notes = notes_path.read_text()
    names = [source_name, runtime_name, 'release-manifest.json', 'RELEASE_NOTES.md']
    (directory / 'SHA256SUMS').write_text(''.join(digest(directory / name) + '  ' + name + '\n' for name in names))
    names.append('SHA256SUMS')
    expected = {name: {'sha256': digest(directory / name), 'bytes': (directory / name).stat().st_size} for name in names}
    if not state.get('releaseId'):
        releases = [r for r in github.releases() if r['tag_name'] == tag]
        require(len(releases) <= 1, 'Duplicate release')
        if releases:
            release = releases[0]
            require(identity in release['body'], 'Unrelated release already uses the tag')
        else:
            release = github.api('releases', 'POST', {'tag_name': tag, 'name': 'AI HR ' + tag,
                                 'target_commitish': state['sha'], 'body': notes, 'draft': True, 'prerelease': False})
        state['releaseId'] = release['id']; checkpoint(state)
    release = github.api('releases/' + str(state['releaseId']))
    require(release['tag_name'] == tag, 'Release tag mismatch')
    if release['draft']:
        for asset in release['assets']:
            name = asset['name']
            require(name in expected and asset['state'] == 'uploaded'
                    and asset['size'] == expected[name]['bytes']
                    and asset.get('digest') == 'sha256:' + expected[name]['sha256'],
                    'Existing draft asset differs; refusing replacement')
        present = {a['name'] for a in release['assets']}
        missing = [directory / name for name in names if name not in present]
        if missing:
            github.upload(tag, missing)
        release = github.api('releases/' + str(state['releaseId']))
        verify_assets(release, expected, notes)
        require(private_destination(github) == destination_id, 'Private release repository changed')
        github.api('releases/' + str(state['releaseId']), 'PATCH', {'draft': False, 'make_latest': 'true'})
    final = github.api('releases/' + str(state['releaseId']))
    verify_assets(final, expected, notes)
    require(not final['draft'], 'Release publication unconfirmed')
    state['url'] = final['html_url']; checkpoint(state)
    return state['url']


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ref', required=True, help='Exact approved 40-character commit SHA')
    parser.add_argument('--ssh-config', required=True, type=Path, help='Private SSH configuration outside tracked files')
    parser.add_argument('--staging-alias', default='aihr-staging')
    parser.add_argument('--remote-directory', default='/opt/ai-hr')
    parser.add_argument('--service', default='aihr')
    parser.add_argument('--approval-evidence', type=Path, help='Original acceptance/gate evidence; required for publication; only its SHA256 is published')
    parser.add_argument('--build-id', help='Exact build ID accepted by the human staging reviewer; required for publication')
    parser.add_argument('--github-account', help='Existing local gh account with write access to both repositories; no global account switch')
    parser.add_argument('--owner-exception', action='store_true', help='Explicitly label owner-exception acceptance; never relabel as a full PASS')
    intent = parser.add_mutually_exclusive_group(required=True)
    intent.add_argument('--check', action='store_true', help='Read-only preflight: do not approve, tag, package or publish')
    intent.add_argument('--accept-staging', action='store_true', help='Explicit human staging acceptance; package and publish this exact source/build, never deploy')
    parser.add_argument('--output-root', type=Path, default=ROOT / '.improve/production-releases')
    args = parser.parse_args(argv)
    os.umask(0o077)
    require(SHA.fullmatch(args.ref), 'Use an exact full commit SHA')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', args.staging_alias), 'Invalid private staging alias')
    require(re.fullmatch(r'[A-Za-z0-9_-]+', args.service), 'Invalid service name')
    require(args.remote_directory.startswith('/') and '\n' not in args.remote_directory, 'Invalid remote directory')
    require(args.ssh_config.is_file(), 'Private SSH config is required')
    if args.build_id is not None:
        require(BUILD.fullmatch(args.build_id), 'Invalid accepted build ID')
    if args.accept_staging:
        require(args.build_id is not None, 'Publication requires the exact human-accepted --build-id')
        require(args.approval_evidence is not None and args.approval_evidence.is_file(),
                'Publication requires original acceptance evidence')
        require(0 < args.approval_evidence.stat().st_size <= 16 * 1024**2, 'Invalid acceptance evidence size')
    # Source is always git archive of the exact accepted commit, never local working-tree changes.
    require(run(['git', 'rev-parse', args.ref + '^{commit}'], cwd=ROOT).decode().strip() == args.ref, 'Source commit missing')
    environment = github_environment(args.github_account)
    source = GitHub(environment=environment); branches(source, args.ref)
    github = GitHub(RELEASE_REPOSITORY, environment=environment); private_destination(github)
    root = args.output_root.resolve(); root.mkdir(parents=True, exist_ok=True, mode=0o700); root.chmod(0o700)
    with (root / '.publisher.lock').open('a') as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        capture_and_publish(args, source, github, root)


def capture_and_publish(args, source_github, github, root):
    # Source archive can be prepared before the build identity is known, but --check never writes packages.
    import tempfile
    with tempfile.TemporaryDirectory(prefix='aihr-release-') as temporary:
        source = Path(temporary) / 'source.tar.gz'
        with subprocess.Popen(['git', 'archive', '--format=tar', args.ref], cwd=ROOT, stdout=subprocess.PIPE) as proc:
            with source.open('xb') as output, gzip.GzipFile(fileobj=output, mode='wb', mtime=0, compresslevel=2) as zipped:
                for block in iter(lambda: proc.stdout.read(1024 * 1024), b''):
                    zipped.write(block)
            require(proc.wait() == 0, 'Exact source archive failed')
        files = audit_archive(source)
        lock = hashlib.sha256(run(['git', 'show', args.ref + ':pnpm-lock.yaml'], cwd=ROOT)).hexdigest()
        request = {'sha': args.ref, 'directory': args.remote_directory, 'service': args.service,
                   'files': {n: h for n, h in files.items() if staged_source(n)}, 'lock': lock}
        ssh = ['ssh', '-F', str(args.ssh_config.resolve()), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
               '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', args.staging_alias]
        # Package capture shares the staging lease with installation and acceptance. The credential
        # is private; read-only --check remains usable without acquiring a lease.
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'staging'))
        from lease import load_lease, guard_command
        staging_lease = load_lease(args.ref) if args.accept_staging else None
        def protected(command):
            return guard_command(staging_lease, command) if staging_lease else command
        def snapshot():
            value = json.loads(run(ssh + [protected('python3 -c ' + shlex.quote(SNAPSHOT))], input=json.dumps(request).encode()))
            require(value['sha'] == args.ref and BUILD.fullmatch(value['buildId']), 'Invalid staging identity')
            return value
        before = snapshot()
        require(args.build_id is None or before['buildId'] == args.build_id,
                'Running staging build differs from the human-accepted --build-id')
        if args.check:
            print(json.dumps({'preflight': 'passed', 'commit': args.ref, 'buildId': before['buildId'], 'publicationPerformed': False})); return
        directory = root / (args.ref + '-' + before['buildId']); directory.mkdir(exist_ok=True, mode=0o700)
        state_path = directory / 'state.json'
        checkpoint = lambda value: save(state_path, value)
        if state_path.exists():
            state = json.loads(state_path.read_text())
            require(state['sha'] == args.ref and state['buildId'] == before['buildId'], 'Local release identity mismatch')
            require(state['evidenceSha256'] == digest(args.approval_evidence), 'Approval evidence changed; resume with the original evidence')
            require(state['approvalKind'] == ('owner-exception' if args.owner_exception else 'operator-staging-acceptance'), 'Approval kind changed')
        else:
            accepted = dt.datetime.now(dt.timezone.utc)
            state = {'sha': args.ref, 'buildId': before['buildId'], 'snapshot': before,
                     'acceptedAt': accepted.isoformat(), 'date': date_in_kl(accepted),
                     'approvalKind': 'owner-exception' if args.owner_exception else 'operator-staging-acceptance',
                     'evidenceSha256': digest(args.approval_evidence)}
            checkpoint(state)
        source_path = directory / 'source.tar.gz'
        if not source_path.exists():
            import shutil
            shutil.copyfile(source, source_path)
        require(digest(source_path) == digest(source), 'Prepared source differs from exact commit')
        runtime = directory / 'runtime.tar.gz'
        if not state.get('archives'):
            capture, partial = directory / 'runtime.capture', directory / 'runtime.partial'
            command = ('cd ' + shlex.quote(args.remote_directory) + ' && nice -n 15 tar '
                       '--exclude=.next/cache --exclude=.next/dev --exclude=.next/trace '
                       '--exclude=node_modules/.cache --use-compress-program="gzip -1" -cf - .next node_modules')
            with capture.open('wb') as output:
                subprocess.run(ssh + [protected(command)], stdout=output, check=True, timeout=1800)
            require(snapshot() == before, 'Staging changed during runtime capture; retry after acceptance')
            relativize_build_aliases(capture, partial, args.remote_directory)
            capture.unlink()
            audit_archive(partial, runtime=True, build=before['buildId'], lock=lock)
            partial.replace(runtime)
            state['archives'] = {n: {'sha256': digest(directory / n), 'bytes': (directory / n).stat().st_size}
                                 for n in ('source.tar.gz', 'runtime.tar.gz')}
            checkpoint(state)
        else:
            for name, wanted in state['archives'].items():
                require(digest(directory / name) == wanted['sha256'], 'Prepared package changed')
            audit_archive(runtime, runtime=True, build=before['buildId'], lock=lock)
        require(snapshot() == before, 'Staging changed before publication')
        branches(source_github, args.ref)
        print(publish(source_github, github, directory, state, checkpoint))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        # Do not dump SSH input, credential environment, signed URLs or binary API responses.
        print('Production package publication refused: ' + re.sub(r'[a-f0-9]{64}', '<REDACTED>', str(error)), file=sys.stderr)
        sys.exit(1)
