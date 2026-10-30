import copy
import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import approve_staging as release

SHA = 'a' * 40
BUILD = 'verified-build'


class GitHub:
    def __init__(self, repository=release.RELEASE_REPOSITORY):
        self.repository = repository
        self.private = repository == release.RELEASE_REPOSITORY
        self.repo_id = release.RELEASE_REPOSITORY_ID if self.private else release.REPOSITORY_ID
        self.write_access = True
        self.heads = {'alpha': SHA, 'main': SHA}; self.ancestors = set()
        self.refs = {}; self.objects = {}; self.release = None; self.calls = []; self.fail_upload = False

    def api(self, path, method='GET', value=None):
        self.calls.append((path, method))
        if path == '': return {'private': self.private, 'id': self.repo_id, 'full_name': self.repository, 'permissions': {'push': self.write_access}}
        if path.startswith('git/ref/heads/'): return {'object': {'sha': self.heads[path.split('/')[-1]]}}
        if path.startswith('compare/'):
            base, head = path.removeprefix('compare/').split('?')[0].split('...')
            ancestor = (base, head) in self.ancestors
            return {'status': 'ahead' if ancestor else 'diverged',
                    'merge_base_commit': {'sha': base if ancestor else 'f' * 40}}
        if path.startswith('git/matching-refs/'): return list(self.refs.values())
        if path == 'git/tags':
            key = str(len(self.objects)+1)*40
            self.objects[key] = {'message': value['message'], 'object': {'sha': value['object'], 'type': 'commit', 'url': 'commit-url'}}
            return {'sha': key}
        if path.startswith('git/tags/'): return self.objects[path.split('/')[-1]]
        if path == 'git/refs':
            tag = value['ref'].removeprefix('refs/tags/')
            if tag in self.refs: raise subprocess.CalledProcessError(1, ['gh'])
            self.refs[tag] = {'ref': value['ref'], 'object': {'sha': value['sha'], 'type': 'tag'}}
            return self.refs[tag]
        if path.startswith('git/ref/tags/'):
            tag = path.removeprefix('git/ref/tags/')
            if tag not in self.refs: raise subprocess.CalledProcessError(1, ['gh'])
            return self.refs[tag]
        if path == 'releases/generate-notes': return {'body': '## Changes\n* Customer provisioning improvement'}
        if path == 'releases':
            self.release = {**value, 'id': 5, 'assets': [], 'html_url': 'https://example/release'}
            return copy.deepcopy(self.release)
        if path == 'releases/5':
            if method == 'PATCH': self.release['draft'] = value['draft']
            return copy.deepcopy(self.release)
        raise AssertionError(path)

    def mirror(self, source, state):
        self.refs[state['tag']] = copy.deepcopy(source.refs[state['tag']])
        self.objects[state['tagObject']] = copy.deepcopy(source.objects[state['tagObject']])

    def releases(self): return [] if not self.release else [copy.deepcopy(self.release)]
    def upload(self, tag, paths):
        for path in paths:
            self.release['assets'].append({'name': path.name, 'size': path.stat().st_size, 'state': 'uploaded',
                                          'digest': 'sha256:' + release.digest(path)})
            if self.fail_upload:
                self.fail_upload = False
                raise subprocess.CalledProcessError(1, ['gh', 'release', 'upload'])
    def asset(self, asset): raise AssertionError('Unexpected metadata download')


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.directory = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        for name in ('source.tar.gz', 'runtime.tar.gz'): (self.directory / name).write_bytes(name.encode())
        self.state = {'sha': SHA, 'buildId': BUILD, 'date': '2026-10-26', 'acceptedAt': '2026-10-26T00:00:00Z',
                      'approvalKind': 'operator-staging-acceptance', 'evidenceSha256': 'd'*64,
                      'snapshot': {'nodeVersion': 'v24.22.1', 'nextVersion': '16.3.8', 'sourceFilesVerified': 6000},
                      'archives': {n: {'bytes': (self.directory/n).stat().st_size, 'sha256': release.digest(self.directory/n)}
                                   for n in ('source.tar.gz', 'runtime.tar.gz')}}
        self.github = GitHub()
        self.source = GitHub(release.REPOSITORY)

    def publish(self):
        return release.publish(self.source, self.github, self.directory, self.state, lambda v: release.save(self.directory/'state.json',v))

    def archive(self, entries):
        path = self.directory / 'test.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, value in entries:
                item = tarfile.TarInfo(name)
                if isinstance(value, tuple): item.type = tarfile.SYMTYPE; item.linkname = value[0]; archive.addfile(item)
                else:
                    data = value.encode(); item.size = len(data); archive.addfile(item, io.BytesIO(data))
        return path

    def runtime(self, additions=()):
        return self.archive([('.next/BUILD_ID', BUILD), ('node_modules/.deploy-lockfile-sha','e'*64),
                             ('.next/prerender-manifest.json', json.dumps({'routes': {'/_not-found': {}},'dynamicRoutes': {}})),
                             *additions])

    def test_date_and_sequence(self):
        self.assertEqual(release.date_in_kl(dt.datetime(2026,10,25,16,1,tzinfo=dt.timezone.utc)), '2026-10-26')
        self.assertEqual(release.next_tag('2026-10-26',['prod-2026-10-26.1','prod-2026-10-26.9','prod-2026-10-25.99','prod-2026-10-26.0']), 'prod-2026-10-26.10')

    def test_exact_archive_allows_template_and_pnpm_links(self):
        path = self.runtime([('node_modules/.pnpm/pkg/node_modules/pkg/index.js','package'),
                             ('node_modules/pkg', ('.pnpm/pkg/node_modules/pkg',))])
        self.assertIn('.next/BUILD_ID', release.audit_archive(path, True, BUILD,'e'*64))
        self.assertIn('deploy/.env.production.example',release.audit_archive(self.archive([('deploy/.env.production.example','template')])))

    def test_rejects_secrets_traversal_cache_and_links(self):
        for name,value in [('.next/.env.production','secret'), ('node_modules/runtime.env','secret'),
                           ('.next/cache/fetch-cache/a','customer data'),('../oops','bad'),
                           ('node_modules/pkg',('/etc/aihr/runtime.env',)),
                           ('node_modules/pkg',('../../etc/passwd',)),
                           ('node_modules/pkg',('../.improve/secret',))]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                release.audit_archive(self.runtime([(name,value)]), True,BUILD,'e'*64)

    def test_ci_build_aliases_become_relative_and_other_absolute_links_still_refuse(self):
        sharp = 'node_modules/.pnpm/sharp@0.35.5/node_modules/sharp'
        fontkit = 'node_modules/.pnpm/fontkit@1.9.0/node_modules/fontkit'
        captured = self.runtime([(sharp + '/package.json', '{}'), (fontkit + '/package.json', '{}'),
                                 ('.next/node_modules/sharp-3e5442f104a9f950', ('/opt/ai-hr/' + sharp,)),
                                 ('.next/node_modules/fontkit-386bd8d9fd7fd3ab', ('/opt/ai-hr/' + fontkit,))])
        with self.assertRaisesRegex(ValueError, 'Absolute archive link'):
            release.audit_archive(captured, True, BUILD, 'e'*64)
        output = self.directory / 'relative.tar.gz'
        self.assertEqual(release.relativize_build_aliases(captured, output, '/opt/ai-hr/'),
                         ['.next/node_modules/sharp-3e5442f104a9f950', '.next/node_modules/fontkit-386bd8d9fd7fd3ab'])
        self.assertIn(sharp + '/package.json', release.audit_archive(output, True, BUILD, 'e'*64))
        with tarfile.open(output) as archive:
            self.assertEqual(archive.getmember('.next/node_modules/sharp-3e5442f104a9f950').linkname, '../../' + sharp)
            self.assertEqual(archive.getmember('.next/node_modules/fontkit-386bd8d9fd7fd3ab').linkname, '../../' + fontkit)
            self.assertEqual(archive.extractfile(sharp + '/package.json').read(), b'{}')
        # Only the two known aliases, and only into the installation's own dependencies, are repointed.
        for name, target in [('.next/node_modules/sharp-3e5442f104a9f950', '/opt/other/' + sharp),
                             ('.next/node_modules/sharp-3e5442f104a9f950', '/opt/ai-hr/node_modules/../../../etc'),
                             ('.next/node_modules/sharp-3e5442f104a9f950', '/opt/ai-hr/.env.production'),
                             ('.next/node_modules/other-3e5442f104a9f950', '/opt/ai-hr/' + sharp),
                             ('node_modules/sharp-3e5442f104a9f950', '/opt/ai-hr/' + sharp)]:
            with self.subTest(name=name, target=target):
                output.unlink()
                self.assertEqual(release.relativize_build_aliases(self.runtime([(name, (target,))]), output, '/opt/ai-hr'), [])
                with self.assertRaisesRegex(ValueError, 'Absolute archive link'):
                    release.audit_archive(output, True, BUILD, 'e'*64)

    def test_rejects_link_chain_into_private_data_and_duplicate(self):
        for entries in [[('node_modules/a',('b',)),('node_modules/b',('../../etc/passwd',))],
                        [('node_modules/a','first'),('node_modules/a','second')]]:
            with self.assertRaises(ValueError): release.audit_archive(self.runtime(entries),True,BUILD,'e'*64)

    def test_rejects_build_lock_and_prerendered_customer_data(self):
        path = self.runtime()
        for build,lock in [('wrong','e'*64),(BUILD,'f'*64)]:
            with self.assertRaises(ValueError): release.audit_archive(path,True,build,lock)
        path = self.archive([('.next/BUILD_ID',BUILD),('node_modules/.deploy-lockfile-sha','e'*64),
                             ('.next/prerender-manifest.json',json.dumps({'routes':{'/payroll':{}},'dynamicRoutes':{}}))])
        with self.assertRaises(ValueError): release.audit_archive(path,True,BUILD,'e'*64)

    def test_publication_and_unchanged_retry(self):
        self.assertEqual(self.publish(),'https://example/release')
        self.assertFalse(self.github.release['draft'])
        self.assertEqual(self.state['tag'],'prod-2026-10-26.1')
        self.assertEqual(len(self.github.release['assets']),5)
        manifest=json.loads((self.directory/'release-manifest.json').read_text())
        self.assertFalse(manifest['verification']['productionDeploymentPerformed'])
        self.assertFalse(manifest['verification']['publisherReassessesApplicationGate'])
        sums=(self.directory/'SHA256SUMS').read_text().splitlines()
        self.assertEqual(len(sums),4)
        for line in sums:
            wanted,name=line.split('  '); self.assertEqual(release.digest(self.directory/name),wanted)
        before=list(self.github.calls); self.publish()
        self.assertFalse(any(method in ('POST','PATCH') for path,method in self.github.calls[len(before):]))

    def test_interrupted_upload_resumes_missing_only(self):
        self.github.fail_upload = True
        with self.assertRaises(subprocess.CalledProcessError): self.publish()
        self.assertTrue(self.github.release['draft']); self.assertEqual(len(self.github.release['assets']),1)
        self.publish(); self.assertFalse(self.github.release['draft']); self.assertEqual(len(self.github.release['assets']),5)

    def test_bad_existing_asset_is_never_overwritten_or_published(self):
        self.github.fail_upload=True
        with self.assertRaises(subprocess.CalledProcessError): self.publish()
        self.github.release['assets'][0]['digest']='sha256:'+'0'*64
        with self.assertRaises(ValueError): self.publish()
        self.assertTrue(self.github.release['draft'])
        self.assertFalse(any(method=='PATCH' for path,method in self.github.calls))

    def test_owner_exception_is_retained(self):
        self.state['approvalKind']='owner-exception'; self.publish()
        self.assertEqual(json.loads((self.directory/'release-manifest.json').read_text())['stagingApproval']['kind'],'owner-exception')
        self.assertIn('owner-exception',(self.directory/'RELEASE_NOTES.md').read_text())

    def test_exact_approved_commit_in_both_branches(self):
        self.assertEqual(release.branches(self.source, SHA), self.source.heads)

    def test_later_documentation_and_divergent_heads_keep_exact_candidate(self):
        # Release recording and later work can advance each branch independently.
        self.source.heads = {'alpha': 'b' * 40, 'main': 'c' * 40}
        self.source.ancestors = {(SHA, head) for head in self.source.heads.values()}
        proof = release.branches(self.source, SHA)
        self.assertEqual(proof, self.source.heads)
        self.publish()
        obj = self.source.objects[self.state['tagObject']]
        self.assertEqual(obj['object']['sha'], SHA)
        self.assertEqual(json.loads((self.directory/'release-manifest.json').read_text())['commit'], SHA)

    def test_candidate_missing_from_either_branch_refuses(self):
        for branch in ('alpha', 'main'):
            with self.subTest(branch=branch):
                self.source.heads = {'alpha': SHA, 'main': SHA}
                self.source.heads[branch] = 'b' * 40
                with self.assertRaisesRegex(ValueError, branch):
                    release.branches(self.source, SHA)
        self.assertFalse(self.source.refs)

    def test_canonical_source_repository_required(self):
        for repo in [{'id': 1, 'full_name': release.REPOSITORY}, {'id': release.REPOSITORY_ID, 'full_name': 'foreign/repo'}]:
            with self.subTest(repo=repo), patch.object(self.source, 'api', return_value=repo), self.assertRaises(ValueError):
                release.branches(self.source, SHA)

    def test_comparison_must_prove_the_exact_candidate_is_merge_base(self):
        original = self.source.api
        self.source.heads['alpha'] = 'b' * 40
        def api(path, method='GET', value=None):
            if path.startswith('compare/'):
                return {'status': 'ahead', 'merge_base_commit': {'sha': 'c' * 40}}
            return original(path, method, value)
        with patch.object(self.source, 'api', side_effect=api), self.assertRaises(ValueError):
            release.branches(self.source, SHA)

    def test_public_or_wrong_package_repository_refuses_before_any_tag(self):
        for private, name in [(False, release.RELEASE_REPOSITORY), (True, 'foreign/releases')]:
            self.github.private = private; self.github.repository = name
            with self.subTest(private=private, name=name), self.assertRaises(ValueError): self.publish()
            self.assertFalse(self.source.refs); self.assertIsNone(self.github.release)

    def test_private_repository_identity_is_pinned_across_resume(self):
        self.publish(); self.state['releaseRepositoryId'] += 1
        with self.assertRaisesRegex(ValueError, 'identity changed'): self.publish()
        self.assertEqual(len(self.source.refs), 1)

    def test_read_only_destination_cannot_allocate_tags(self):
        self.github.write_access = False
        with self.assertRaises(ValueError): self.publish()
        self.assertFalse(self.source.refs)

    def test_account_selection_is_local_and_never_mutates_shared_credentials(self):
        import os
        with patch.dict(os.environ, {'GH_TOKEN': 'another-process-token', 'GITHUB_TOKEN': 'another-token'}), \
             patch.object(release, 'run', return_value=b'stored-test-account-token\n') as command:
            env = release.github_environment('stradaverse-hub')
            self.assertEqual(env['GH_TOKEN'], 'stored-test-account-token')
            self.assertNotIn('GITHUB_TOKEN', env)
            self.assertEqual(env['GIT_TERMINAL_PROMPT'], '0')
            self.assertEqual(os.environ['GH_TOKEN'], 'another-process-token')
            self.assertEqual(command.call_args.args[0], ['gh','auth','token','--hostname','github.com','--user','stradaverse-hub'])
            self.assertNotIn('GH_TOKEN', command.call_args.kwargs['env'])
            self.assertNotIn('GITHUB_TOKEN', command.call_args.kwargs['env'])
        with patch.object(release, 'run') as command, self.assertRaises(ValueError):
            release.github_environment('bad/account')
        command.assert_not_called()

    def test_public_source_never_receives_release_assets(self):
        self.assertFalse(self.source.private)
        self.publish()
        self.assertIsNone(self.source.release)
        self.assertFalse(any(path == 'releases' and method == 'POST' for path, method in self.source.calls))
        self.assertEqual(self.source.refs, self.github.refs)
        self.assertEqual(len(self.github.release['assets']), 5)

    def test_conflicting_private_tag_is_never_overwritten(self):
        self.github.refs['prod-2026-10-26.1'] = {'object': {'type': 'tag', 'sha': 'f'*40}}
        with self.assertRaisesRegex(ValueError, 'Private release tag differs'): self.publish()
        self.assertIsNone(self.github.release)
        self.assertEqual(self.github.refs['prod-2026-10-26.1']['object']['sha'], 'f'*40)

    def test_repository_becoming_public_during_upload_cannot_be_published(self):
        upload = self.github.upload
        def changed(tag, paths):
            upload(tag, paths); self.github.private = False
        self.github.upload = changed
        with self.assertRaises(ValueError): self.publish()
        self.assertTrue(self.github.release['draft'])

    def test_already_reserved_build_refuses_duplicate_tag(self):
        self.source.refs['prod-2026-10-26.1']={'ref':'refs/tags/prod-2026-10-26.1','object':{'type':'tag','sha':'9'*40}}
        self.source.objects['9'*40]={'message':f'aihr-staging-release:{SHA}:{BUILD}'}
        with self.assertRaisesRegex(ValueError,'already has a reserved'): self.publish()
        self.assertEqual(len(self.source.refs),1)

    def test_reserved_build_on_an_earlier_date_is_not_duplicated(self):
        self.source.refs['prod-2026-10-25.1'] = {'ref': 'refs/tags/prod-2026-10-25.1',
                                               'object': {'type': 'tag', 'sha': '9'*40}}
        self.source.objects['9'*40] = {'message': f'aihr-staging-release:{SHA}:{BUILD}'}
        with self.assertRaisesRegex(ValueError, 'already has a reserved'): self.publish()
        self.assertEqual(len(self.source.refs), 1)

    def test_same_build_published_by_another_output_is_not_duplicated(self):
        self.github.release={'tag_name':'prod-2026-10-26.1','assets':[{'name':'release-manifest.json'}],'html_url':'existing'}
        self.github.asset=lambda a:json.dumps({'commit':SHA,'buildId':BUILD}).encode()
        with self.assertRaisesRegex(ValueError,'already has a release'): self.publish()
        self.assertFalse(self.github.refs)

    def test_state_written_before_remote_ref_and_collision_gets_next_sequence(self):
        original=self.source.api; collided=False
        def api(path,method='GET',value=None):
            nonlocal collided
            if path=='git/refs' and not collided:
                collided=True
                saved=json.loads((self.directory/'state.json').read_text())
                self.assertEqual(saved['tagObject'],value['sha'])
                self.source.refs[saved['tag']]={'ref':'refs/tags/'+saved['tag'],'object':{'type':'tag','sha':'9'*40}}
                self.source.objects['9'*40]={'message':'another approved build'}
                raise subprocess.CalledProcessError(1,['gh'])
            return original(path,method,value)
        self.source.api=api; self.publish(); self.assertEqual(self.state['tag'],'prod-2026-10-26.2')

    def snapshot(self, *, state='ok', inactive=False, wrong_source=False, old_process=False):
        import contextlib, os, types, sys
        root=self.directory/'installed'; (root/'.next').mkdir(parents=True,exist_ok=True)
        (root/'node_modules/next').mkdir(parents=True,exist_ok=True)
        (root/'.next/BUILD_ID').write_text(BUILD); os.utime(root/'.next/BUILD_ID',(99990,99990))
        (root/'node_modules/.deploy-lockfile-sha').write_text('e'*64)
        (root/'node_modules/next/package.json').write_text('{"version":"16.3.8"}')
        (root/'package.json').write_text('changed' if wrong_source else 'source')
        status='\n'.join(f'{k}={v}' for k,v in {'state':state,'stale_build':'0','ref':SHA,'built_ref':SHA,'build_id':BUILD,'built_build_id':BUILD}.items())
        def process(args,**kwargs):
            if args[:2]==['bash','deploy/deploy-state.sh']: out=status
            elif 'is-active' in args:
                if inactive: raise subprocess.CalledProcessError(1,args)
                out=''
            elif 'MainPID' in ' '.join(args): out='42'
            else: out='v24.22.1'
            return types.SimpleNamespace(stdout=out)
        def path(value):
            if str(value)=='/proc/42/cwd': return types.SimpleNamespace(resolve=lambda:root.resolve())
            if str(value)=='/proc/42/exe': return types.SimpleNamespace(resolve=lambda:Path('/node'))
            if str(value)=='/proc/uptime': return types.SimpleNamespace(read_text=lambda:'1000 0')
            if str(value)=='/proc/42/stat':
                fields=['0']*20;fields[19]='98000' if old_process else '99500'
                return types.SimpleNamespace(read_text=lambda:'42 (node) '+' '.join(fields))
            return Path(value)
        connection=unittest.mock.MagicMock();connection.getresponse.return_value.status=200
        request={'directory':str(root),'service':'aihr','sha':SHA,'lock':'e'*64,
                 'files':{'package.json':hashlib.sha256(b'source').hexdigest()}}
        output=io.StringIO(); previous=os.getcwd()
        try:
            with patch.dict(sys.modules,{'pathlib':types.SimpleNamespace(Path=path)}), \
                 patch('subprocess.run',side_effect=process),patch('sys.stdin',io.StringIO(json.dumps(request))), \
                 patch('platform.system',return_value='Linux'),patch('platform.machine',return_value='x86_64'), \
                 patch('time.time',return_value=100000),patch('os.sysconf',return_value=100), \
                 patch('http.client.HTTPConnection',return_value=connection),contextlib.redirect_stdout(output):
                exec(release.SNAPSHOT,{})
        finally: os.chdir(previous)
        return json.loads(output.getvalue())

    def test_actual_remote_probe_accepts_active_exact_source(self):
        self.assertEqual(self.snapshot()['buildId'],BUILD)

    def test_actual_remote_probe_refuses_stale_inactive_changed_or_old_service(self):
        for kwargs in [{'state':'running'},{'inactive':True},{'wrong_source':True},{'old_process':True}]:
            with self.subTest(kwargs=kwargs),self.assertRaises((RuntimeError,subprocess.CalledProcessError)):
                self.snapshot(**kwargs)

    def test_lost_tag_response_resumes_same_tag(self):
        original=self.source.api; failed=False
        def api(path,method='GET',value=None):
            nonlocal failed
            result=original(path,method,value)
            if path=='git/refs' and not failed:
                failed=True;raise subprocess.CalledProcessError(1,['gh'])
            return result
        self.source.api=api;self.publish()
        self.assertEqual(self.state['tag'],'prod-2026-10-26.1');self.assertEqual(len(self.source.refs),1)

    def test_official_source_exclusions_do_not_skip_application_code(self):
        for name in ['app/login/page.tsx','lib/auth.ts','public/icon.png','db/migrations/0600.sql','deploy/deploy.sh']:
            self.assertTrue(release.staged_source(name))
        for name in ['docs/adr/0100.md','docs/HANDOFF-HISTORY.md','mobile/android/key.jks','.env.production.example','.improve/ssh_config']:
            self.assertFalse(release.staged_source(name))


class CommandTests(unittest.TestCase):
    """Exercise the real CLI, Git source archive and publisher with only transports doubled."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'checkout'; self.root.mkdir()
        (self.root / 'pnpm-lock.yaml').write_text('accepted lockfile')
        (self.root / 'app.txt').write_text('accepted source')
        def git(*args): return subprocess.run(['git', *args], cwd=self.root, check=True, capture_output=True).stdout
        git('init', '-q'); git('add', '.')
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Accepted source')
        self.sha = git('rev-parse', 'HEAD').decode().strip()
        # Dirty local edits must never enter the source package.
        (self.root / 'app.txt').write_text('unapproved working tree edit')
        self.config = Path(self.tmp.name) / 'ssh_config'; self.config.write_text('private config')
        self.evidence = Path(self.tmp.name) / 'acceptance.json'; self.evidence.write_text('original human acceptance')
        self.github = GitHub(); self.source = GitHub(release.REPOSITORY)
        self.source.heads = {'alpha': self.sha, 'main': self.sha}
        self.snapshot_count = 0; self.after_capture = lambda: None
        self.snapshot = {'sha': self.sha, 'buildId': BUILD, 'pid': 42, 'buildMtime': 1,
                         'nodeVersion': 'v24.22.1', 'nextVersion': '16.3.8', 'sourceFilesVerified': 2}
        self.args = ['--ref', self.sha, '--ssh-config', str(self.config)]
        self.approval = ['--accept-staging', '--build-id', BUILD, '--approval-evidence', str(self.evidence)]
        self.lease = Path(self.tmp.name) / 'lease.json'
        self.lease.write_text(json.dumps({'protocol':'aihr-staging-queue/v1','candidate':self.sha,'epoch':1,'batch':'00000000-0000-4000-8000-000000000001','token':'b'*64,'releaseAuthorized':False}))
        self.lease.chmod(0o600)
        import os
        lease_env = patch.dict(os.environ, {'AIHR_STAGING_LEASE_FILE':str(self.lease.resolve())})
        lease_env.start(); self.addCleanup(lease_env.stop)
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w:gz') as archive:
            for name, value in [('.next/BUILD_ID', BUILD),
                    ('node_modules/.deploy-lockfile-sha', release.digest(self.root/'pnpm-lock.yaml')),
                    ('.next/prerender-manifest.json', '{"routes":{},"dynamicRoutes":{}}')]:
                item = tarfile.TarInfo(name); content = value.encode(); item.size = len(content)
                archive.addfile(item, io.BytesIO(content))
        self.runtime = raw.getvalue()
        self.original_process = subprocess.run

    def process(self, args, **kwargs):
        if args[0] != 'ssh': return self.original_process(args, **kwargs)
        self.assertIn('StrictHostKeyChecking=yes', args)
        self.assertEqual(args[-2], 'aihr-staging')
        if ' tar ' in args[-1]:
            self.assertIn('coordinator.py guard -- bash -c', args[-1])
            self.assertIn('AIHR_STAGING_CANDIDATE=' + self.sha, args[-1])
            kwargs['stdout'].write(self.runtime); self.after_capture()
            return subprocess.CompletedProcess(args, 0)
        self.snapshot_count += 1
        return subprocess.CompletedProcess(args, 0, json.dumps(self.snapshot).encode())

    def invoke(self, *args):
        import contextlib
        output = io.StringIO()
        with patch.object(release, 'ROOT', self.root), patch.object(release, 'GitHub', side_effect=lambda repository=release.REPOSITORY, environment=None: self.source if repository == release.REPOSITORY else self.github), \
             patch('subprocess.run', side_effect=self.process), contextlib.redirect_stdout(output):
            release.main(self.args + list(args))
        return output.getvalue()

    def test_no_mode_or_approval_details_cannot_publish(self):
        import contextlib
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit): self.invoke()
        for options in [[], ['--build-id', BUILD], ['--approval-evidence', str(self.evidence)]]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.invoke('--accept-staging', *options)
        self.assertFalse(self.github.calls)

    def test_publication_refuses_missing_or_foreign_lease_without_github_writes(self):
        import os
        with patch.dict(os.environ, {'AIHR_STAGING_LEASE_FILE':''}), self.assertRaises(ValueError):
            self.invoke(*self.approval)
        grant=json.loads(self.lease.read_text());grant['candidate']='c'*40
        self.lease.write_text(json.dumps(grant))
        with self.assertRaises(ValueError): self.invoke(*self.approval)
        self.assertFalse(self.github.refs)

    def test_preflight_requires_no_acceptance_and_makes_no_github_writes(self):
        result = json.loads(self.invoke('--check'))
        self.assertFalse(result['publicationPerformed']); self.assertEqual(result['buildId'], BUILD)
        self.assertTrue(all(method == 'GET' for _, method in self.github.calls))
        self.assertFalse(list((self.root/'.improve/production-releases').glob('*/state.json')))

    def test_cli_passes_selected_account_without_switching_shared_login(self):
        with patch.object(release, 'github_environment', return_value={'GH_TOKEN': 'test-only-token'}) as select:
            self.invoke('--check', '--github-account', 'stradaverse-hub')
        select.assert_called_once_with('stradaverse-hub')
        self.assertTrue(all(method == 'GET' for _, method in self.github.calls))

    def test_rebuilt_same_commit_is_not_silently_accepted(self):
        self.snapshot['buildId'] = 'rebuilt-after-acceptance'
        with self.assertRaisesRegex(ValueError, 'human-accepted'): self.invoke(*self.approval)
        self.assertFalse(self.github.refs)

    def test_cli_publishes_exact_git_source_and_runtime_then_resumes(self):
        self.invoke(*self.approval)
        directory = next((self.root/'.improve/production-releases').glob(self.sha+'-*'))
        with tarfile.open(directory/'source.tar.gz') as source:
            self.assertEqual(source.extractfile('app.txt').read(), b'accepted source')
        manifest = json.loads((directory/'release-manifest.json').read_text())
        self.assertEqual(manifest['commit'], self.sha); self.assertEqual(manifest['buildId'], BUILD)
        self.assertEqual(manifest['stagingApproval']['evidenceSha256'], release.digest(self.evidence))
        self.assertFalse(manifest['verification']['productionDeploymentPerformed'])
        before = len(self.github.calls); self.invoke(*self.approval)
        self.assertTrue(all(method == 'GET' for _, method in self.github.calls[before:]))
        self.assertEqual(len(self.github.refs), 1)

    def test_cli_packages_ci_installed_build_aliases_as_relative_links(self):
        target = 'node_modules/.pnpm/sharp@0.35.5/node_modules/sharp'
        raw = io.BytesIO()
        with tarfile.open(fileobj=io.BytesIO(self.runtime)) as accepted, tarfile.open(fileobj=raw, mode='w:gz') as archive:
            for item in accepted: archive.addfile(item, accepted.extractfile(item))
            item = tarfile.TarInfo(target + '/package.json'); item.size = 2; archive.addfile(item, io.BytesIO(b'{}'))
            item = tarfile.TarInfo('.next/node_modules/sharp-3e5442f104a9f950')
            item.type = tarfile.SYMTYPE; item.linkname = '/opt/ai-hr/' + target; archive.addfile(item)
        self.runtime = raw.getvalue()
        self.invoke(*self.approval)
        directory = next((self.root/'.improve/production-releases').glob(self.sha+'-*'))
        self.assertFalse((directory/'runtime.capture').exists())
        with tarfile.open(directory/'runtime.tar.gz') as runtime:
            self.assertEqual(runtime.getmember('.next/node_modules/sharp-3e5442f104a9f950').linkname, '../../' + target)
        self.assertEqual(len(self.github.refs), 1)

    def test_runtime_or_branch_change_during_capture_refuses_before_tagging(self):
        def rebuild(): self.snapshot['buildId'] = 'another-build'
        def reset(): self.source.heads['main'] = 'b' * 40
        for change in [rebuild, reset]:
            with self.subTest(change=change.__name__):
                self.snapshot['buildId'] = BUILD
                self.source.heads['main'] = self.sha
                self.after_capture = change
                # Distinct outputs make each attempt exercise capture.
                with self.assertRaises(ValueError):
                    self.invoke(*self.approval, '--output-root', str(self.root/change.__name__))
                self.assertFalse(self.github.refs)

    def test_actual_tag_transport_preserves_commit_and_annotation_without_branch_push(self):
        bare = Path(self.tmp.name)/'private.git'
        self.original_process(['git', 'init', '--bare', '-q', str(bare)], check=True)
        self.original_process(['git', 'config', 'push.followTags', 'true'], cwd=self.root, check=True)
        self.original_process(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                              'tag', '-am', 'Unrelated annotation', 'unrelated-tag', self.sha], cwd=self.root, check=True)
        tag = 'prod-2026-10-26.1'
        self.original_process(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                              'tag', '-am', 'Accepted source identity', tag, self.sha], cwd=self.root, check=True)
        obj = self.original_process(['git', 'rev-parse', tag], cwd=self.root, check=True, capture_output=True).stdout.decode().strip()
        commands = []
        def transport(args, **kwargs):
            commands.append(args)
            args = [str(self.root) if a == f'https://github.com/{release.REPOSITORY}.git' else
                    str(bare) if a == f'https://github.com/{release.RELEASE_REPOSITORY}.git' else a for a in args]
            return self.original_process(args, check=True, capture_output=True, **kwargs).stdout
        with patch.object(release, 'ROOT', self.root), patch.object(release, 'run', side_effect=transport):
            release.GitHub(release.RELEASE_REPOSITORY).mirror(release.GitHub(), {'tag': tag, 'tagObject': obj, 'sha': self.sha})
        def remote(ref):
            return self.original_process(['git', '--git-dir', str(bare), 'rev-parse', ref], check=True, capture_output=True).stdout.decode().strip()
        self.assertEqual(remote('refs/tags/'+tag), obj)
        self.assertEqual(remote('refs/tags/'+tag+'^{commit}'), self.sha)
        refs = self.original_process(['git', '--git-dir', str(bare), 'for-each-ref', '--format=%(refname)'], check=True, capture_output=True).stdout.decode().splitlines()
        self.assertEqual(refs, ['refs/tags/'+tag])
        push = next(c for c in commands if 'push' in c)
        self.assertNotIn('--force', push); self.assertNotIn('--no-verify', push)
        self.assertIn('--no-follow-tags', push); self.assertEqual(push[-1], obj+':refs/tags/'+tag)

    def test_changed_evidence_on_resume_refuses(self):
        self.invoke(*self.approval); self.evidence.write_text('different acceptance')
        before = len(self.github.calls)
        with self.assertRaisesRegex(ValueError, 'evidence changed'): self.invoke(*self.approval)
        self.assertTrue(all(method == 'GET' for _, method in self.github.calls[before:]))


if __name__=='__main__': unittest.main()
