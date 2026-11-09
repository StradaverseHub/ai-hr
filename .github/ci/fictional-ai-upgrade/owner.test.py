"""Local contract tests. These use no database, workflow credentials, Docker or nftables."""
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.util.spec_from_file_location('fictional_owner',Path(__file__).with_name('owner.py'))
owner = importlib.util.module_from_spec(loader)
loader.loader.exec_module(owner)


class Admission(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.event = Path(self.directory.name).resolve()/'event.json'
        controller = 'a'*40
        self.env = {
            'GITHUB_RUN_ID':'1010','GITHUB_WORKFLOW_SHA':controller,'GITHUB_SHA':controller,
            'AIHR_CI_CONTROL_HEAD':controller,'AIHR_CI_HEAD':owner.CANDIDATE,
            'GITHUB_ACTIONS':'true','CI':'true','RUNNER_ENVIRONMENT':'github-hosted',
            'RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_REPOSITORY':owner.REPO,'GITHUB_REPOSITORY_ID':'1333414856',
            'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_WORKFLOW':'alpha-focused-checks','GITHUB_JOB':'selected-tests',
            'GITHUB_RUN_ATTEMPT':'1','GITHUB_REF':'refs/heads/'+owner.BRANCH,
            'GITHUB_WORKFLOW_REF':owner.REPO+'/.github/workflows/alpha-focused-checks.yml@refs/heads/'+owner.BRANCH,
            'AIHR_AI_UPGRADE_STAGING_ENABLED':'false','AIHR_AI_UPGRADE_PRODUCTION_ENABLED':'false',
            'GITHUB_EVENT_PATH':str(self.event),
        }
        self.payload = {'repository':{'full_name':owner.REPO,'id':1333414856,'private':False},
            'ref':owner.BRANCH,'inputs':{'expected_sha':owner.CANDIDATE,'selected_tests':owner.SELECTED,
                'candidate_ref':'codex/frozen-candidate'}}

    def admit(self, job='selected-tests'):
        self.event.write_text(json.dumps(self.payload))
        return owner.admit(self.env,job)

    def test_closed_first_attempt(self):
        self.assertEqual(self.admit()[:2],('1010','a'*40))
        self.env['GITHUB_JOB'] = 'resolve'
        self.assertEqual(self.admit('resolve')[0],'1010')

    def test_actual_sudo_boundary_preserves_exact_owner_inputs(self):
        class ObservedEnvironment(dict):
            def __init__(self, values):
                super().__init__(values)
                self.accessed = set()

            def __getitem__(self, key):
                self.accessed.add(key)
                return super().__getitem__(key)

            def get(self, key, default=None):
                self.accessed.add(key)
                return super().get(key, default)

        self.env = ObservedEnvironment(self.env)
        self.admit()
        # main also resolves these two custody paths. SUDO_UID is assigned by sudo itself.
        required = self.env.accessed | {'GITHUB_WORKSPACE', 'RUNNER_TEMP'}
        workflow = Path(__file__).resolve().parents[2]/'workflows'/'alpha-focused-checks.yml'
        step = workflow.read_text().split('id: fictional-ai-upgrade\n',1)[1]
        step = step.split('      - name: Publish closed fictional Assistant upgrade evidence',1)[0]
        entries = re.findall(r'^\s+keep=(\S+)\s*$',step,re.M)
        self.assertEqual(len(entries),2)
        for entry in entries:
            keys = entry.split(',')
            self.assertTrue(all(re.fullmatch(r'[A-Z_][A-Z0-9_]*',key) for key in keys))
            self.assertCountEqual(keys,required)
        self.assertEqual(len(re.findall(r'(?m)^\s+sudo --preserve-env="\$keep" /usr/bin/python3 ',step)),2)

    def test_workflow_uses_the_fixture_install_for_sudo(self):
        workflow = Path(__file__).resolve().parents[2]/'workflows'/'alpha-focused-checks.yml'
        text = workflow.read_text()
        scope = text.split('id: fictional-ai-upgrade-runtime\n',1)[1]
        scope = scope.split('id: fictional-ai-upgrade-recovery\n',1)[0]
        self.assertIn('dest: ${{ steps.fictional-ai-upgrade-runtime.outputs.path }}/pnpm',scope)
        self.assertIn('install -m 0755 "$(command -v node)" "$runtime/bin/node"',scope)
        self.assertIn('pnpm --dir "$checkout" install --frozen-lockfile --ignore-scripts --store-dir "$runtime/pnpm-store"',scope)
        self.assertIn(' -B "$owner" "$runtime" "$runtime/bin/node" "$runtime/pnpm/node_modules/.bin/pnpm"',scope)

    def test_fixture_runtime_refuses_other_runs_and_unsafe_permissions(self):
        root = self.event.parent
        runtime = root/'aihr-fictional-upgrade.1010.a1234567'
        runtime.mkdir(mode=0o755)
        runtime.chmod(0o755)
        with patch.object(owner,'FIXTURE_RUNTIME_ROOT',root):
            self.assertEqual(owner.fixture_runtime_path(str(runtime),'1010',runtime.stat().st_uid),runtime)
            with self.assertRaises(ValueError):
                owner.fixture_runtime_path(str(runtime),'9999',runtime.stat().st_uid)
            runtime.chmod(0o777)
            with self.assertRaises(ValueError):
                owner.fixture_runtime_path(str(runtime),'1010',runtime.stat().st_uid)

    def test_path_probe_identifies_each_denied_input_without_disclosing_paths(self):
        fixture = str(self.event.parent)
        readable = str(Path(__file__).resolve())
        paths = [sys.executable,sys.executable,sys.executable,readable,readable,fixture,fixture]
        command = [sys.executable,'-I','-B','-c',owner.FIXTURE_PATH_PROBE]
        passed = subprocess.run(command+[fixture]+paths,cwd=fixture,capture_output=True,check=False)
        self.assertEqual((passed.returncode,passed.stderr),(0,b''))
        wrong_cwd = subprocess.run(command+[fixture+'/missing']+paths,cwd=fixture,capture_output=True,check=False)
        self.assertEqual((wrong_cwd.returncode,wrong_cwd.stderr),(2,b'fictional-upgrade-path-refused:checkout-cwd\n'))
        for index,label in enumerate(('node','pnpm','git','checkout','tsx','fixture-temp','role-evidence')):
            with self.subTest(label=label):
                blocked = paths.copy()
                blocked[index] = fixture+'/private-missing-path'
                result = subprocess.run(command+[fixture]+blocked,cwd=fixture,capture_output=True,check=False)
                self.assertEqual((result.returncode,result.stderr),(2,('fictional-upgrade-path-refused:'+label+'\n').encode()))
                self.assertEqual(owner.migration_failure_category(result.stderr,False),label+'-path-refused')

    def test_database_start_uses_closed_network_and_empty_copy_canary(self):
        argv = owner.start_argv('fictional','nonce')
        self.assertEqual(argv[argv.index('--network')+1],'none')
        self.assertNotIn('--publish',argv)
        self.assertNotIn('--privileged',argv)
        self.assertIn('--pull=never',argv)
        canary = owner.copy_program_canary()
        self.assertTrue(canary.startswith(b'COPY (SELECT NULL::text WHERE FALSE) TO PROGRAM'))
        self.assertIn(b'/dev/tcp/127.0.0.1/5433',canary)
        self.assertIn(b'/dev/tcp/192.0.2.1/443',canary)
        self.assertIn(b'/dev/tcp/2001:db8::1/443',canary)

    def test_missing_container_still_requires_absent_host_listener(self):
        with patch.object(owner,'owned_container',return_value=None), patch.object(owner,'docker') as docker:
            with patch.object(owner,'listener',return_value=b'LISTEN 127.0.0.1:5433') as listener:
                with self.assertRaises(ValueError):
                    owner.stop_owned('fixture','nonce')
                listener.assert_called_once()
            with patch.object(owner,'listener',return_value=b'') as listener:
                owner.stop_owned('fixture','nonce')
                listener.assert_called_once()
            docker.assert_not_called()

    def test_reused_session_pid_refuses_without_signalling(self):
        custody = self.event.parent
        (custody/'active-session.json').write_text(json.dumps({'kind':'session-admitted','pid':42,'start':20}))
        with patch.object(owner,'root_file',side_effect=Path.read_bytes), patch.object(owner,'current_process',
                return_value={'pid':42,'session':42,'start':25,'state':'S'}), patch.object(owner.os,'pidfd_open',create=True) as pidfd:
            with self.assertRaises(ValueError):
                owner.settle_interrupted(custody)
            pidfd.assert_not_called()

    def test_migration_failures_publish_only_closed_categories(self):
        cases = (
            (b'nsenter: refused private ns path\n','namespace-entry-refused'),
            (b'env: /private/pnpm: Permission denied\n','toolchain-access-refused'),
            (b'fatal: detected dubious ownership in repository at /private/source\n','checkout-access-refused'),
            (b"Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /private/app\n",'dependency-unavailable'),
            (b'Disposable focused role fixture prerequisites are not satisfied.\n','focused-role-refused'),
            (b'Existing migration engine did not complete normally.\n','migration-engine-launch-refused'),
            (b'fictional private data, unknown error or SQL text\n','unclassified-stage-failure'),
        )
        for excerpt, category in cases:
            with self.subTest(category=category):
                self.assertEqual(owner.migration_failure_category(excerpt,False),category)
        self.assertEqual(owner.migration_failure_category(b'fictional private SQL details',True),'migration-engine-failed')

    def test_engine_boundary_needs_role_receipt_for_exact_phase(self):
        path = self.event.parent/'roles.json'
        source = Path(__file__).resolve().parents[3]
        receipt = {'kind':'PERSONNEL_DRAFT_DISCARD_PREMIGRATION_ROLE_PREREQUISITES',
                   'phase':'before_initial_candidate_migration','candidate':owner.BASE,
                   'controller':'a'*40,'runId':'1010','attempt':'1','fixture':{'mode':'focused_disposable'}}
        receipt.update({key:owner.digest((source/file).read_bytes()) for key,file in owner.ROLE_SOURCES.items()})
        path.write_text(json.dumps(receipt))
        with patch.object(owner,'UID',path.stat().st_uid):
            self.assertEqual(json.loads(owner.phase_role_bytes(path,source,owner.BASE,'a'*40,'1010')),receipt)
            with self.assertRaises(ValueError):
                owner.phase_role_bytes(path,source,owner.CANDIDATE,'a'*40,'1010')

    def test_mixed_course_or_source_refuses(self):
        for key,wrong in [('model_eval','paid-model'),('run_build','true'),
                          ('measured_browser_course','preflight-2'),('expected_sha',owner.BASE),
                          ('selected_tests','[]'),('extra','true')]:
            with self.subTest(key=key):
                saved = self.payload['inputs'].copy()
                self.payload['inputs'][key] = wrong
                with self.assertRaises(ValueError):
                    self.admit()
                self.payload['inputs'] = saved

    def test_deployment_or_retry_refuses(self):
        for key,wrong in [('GITHUB_RUN_ATTEMPT','2'),('AIHR_AI_UPGRADE_STAGING_ENABLED','true'),
                          ('AIHR_AI_UPGRADE_PRODUCTION_ENABLED','true'),('GITHUB_JOB','resolve'),
                          ('GITHUB_WORKFLOW_SHA','b'*40),('GITHUB_REF','refs/heads/alpha')]:
            with self.subTest(key=key):
                saved = self.env[key]
                self.env[key] = wrong
                with self.assertRaises(ValueError):
                    self.admit()
                self.env[key] = saved


if __name__ == '__main__':
    unittest.main()
