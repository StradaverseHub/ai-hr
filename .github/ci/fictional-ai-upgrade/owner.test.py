"""Local contract tests. These use no database, workflow credentials, Docker or nftables."""
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest

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
        self.assertEqual(len(entries),1)
        keys = entries[0].split(',')
        self.assertTrue(all(re.fullmatch(r'[A-Z_][A-Z0-9_]*',key) for key in keys))
        self.assertCountEqual(keys,required)
        self.assertRegex(step,r'(?m)^\s+sudo --preserve-env="\$keep" /usr/bin/python3 ')

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
