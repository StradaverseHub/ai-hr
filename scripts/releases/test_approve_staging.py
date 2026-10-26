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
    def __init__(self):
        self.refs = {}; self.objects = {}; self.release = None; self.calls = []; self.fail_upload = False

    def api(self, path, method='GET', value=None):
        self.calls.append((path, method))
        if path == '': return {'private': True}
        if path.startswith('git/ref/heads/'): return {'object': {'sha': SHA}}
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
        if path.startswith('git/ref/tags/'): return self.refs[path.removeprefix('git/ref/tags/')]
        if path == 'releases/generate-notes': return {'body': '## Changes\n* Customer provisioning improvement'}
        if path == 'releases':
            self.release = {**value, 'id': 5, 'assets': [], 'html_url': 'https://example/release'}
            return copy.deepcopy(self.release)
        if path == 'releases/5':
            if method == 'PATCH': self.release['draft'] = value['draft']
            return copy.deepcopy(self.release)
        raise AssertionError(path)

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

    def publish(self):
        return release.publish(self.github, self.directory, self.state, lambda v: release.save(self.directory/'state.json',v))

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

    def test_private_repository_and_aligned_refs_required(self):
        with patch.object(self.github,'api',return_value={'private':False}),self.assertRaises(ValueError): release.branches(self.github,SHA)
        with patch.object(self.github,'api',side_effect=[{'private':True},{'object':{'sha':'b'*40}}]),self.assertRaises(ValueError): release.branches(self.github,SHA)

    def test_already_reserved_build_refuses_duplicate_tag(self):
        self.github.refs['prod-2026-10-26.1']={'ref':'refs/tags/prod-2026-10-26.1','object':{'type':'tag','sha':'9'*40}}
        self.github.objects['9'*40]={'message':f'aihr-staging-release:{SHA}:{BUILD}'}
        with self.assertRaisesRegex(ValueError,'already has a reserved'): self.publish()
        self.assertEqual(len(self.github.refs),1)

    def test_same_build_published_by_another_output_is_not_duplicated(self):
        self.github.release={'tag_name':'prod-2026-10-26.1','assets':[{'name':'release-manifest.json'}],'html_url':'existing'}
        self.github.asset=lambda a:json.dumps({'commit':SHA,'buildId':BUILD}).encode()
        with self.assertRaisesRegex(ValueError,'already has a release'): self.publish()
        self.assertFalse(self.github.refs)

    def test_state_written_before_remote_ref_and_collision_gets_next_sequence(self):
        original=self.github.api; collided=False
        def api(path,method='GET',value=None):
            nonlocal collided
            if path=='git/refs' and not collided:
                collided=True
                saved=json.loads((self.directory/'state.json').read_text())
                self.assertEqual(saved['tagObject'],value['sha'])
                self.github.refs[saved['tag']]={'ref':'refs/tags/'+saved['tag'],'object':{'type':'tag','sha':'9'*40}}
                self.github.objects['9'*40]={'message':'another approved build'}
                raise subprocess.CalledProcessError(1,['gh'])
            return original(path,method,value)
        self.github.api=api; self.publish(); self.assertEqual(self.state['tag'],'prod-2026-10-26.2')

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
        original=self.github.api; failed=False
        def api(path,method='GET',value=None):
            nonlocal failed
            result=original(path,method,value)
            if path=='git/refs' and not failed:
                failed=True;raise subprocess.CalledProcessError(1,['gh'])
            return result
        self.github.api=api;self.publish()
        self.assertEqual(self.state['tag'],'prod-2026-10-26.1');self.assertEqual(len(self.github.refs),1)

    def test_official_source_exclusions_do_not_skip_application_code(self):
        for name in ['app/login/page.tsx','lib/auth.ts','public/icon.png','db/migrations/0600.sql','deploy/deploy.sh']:
            self.assertTrue(release.staged_source(name))
        for name in ['docs/adr/0100.md','docs/HANDOFF-HISTORY.md','mobile/android/key.jks','.env.production.example','.improve/ssh_config']:
            self.assertFalse(release.staged_source(name))


if __name__=='__main__': unittest.main()
