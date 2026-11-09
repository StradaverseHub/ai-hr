"""Source models for the dormant command contract. No services or mounts."""

import base64
import pathlib
import unittest
from types import ModuleType


def load(name, filename):
    source = pathlib.Path(__file__).with_name(filename)
    module = ModuleType(name)
    module.__file__ = str(source)
    exec(compile(source.read_bytes(), str(source), 'exec', dont_inherit=True), module.__dict__)
    return module


P = load('synthetic_launch_plan_model', 'native-workload-browser-launch-plan.py')
H = load('synthetic_launch_host_model', 'native-workload-browser-host.py')
I = load('synthetic_launch_issuer_model', 'native-workload-browser-issuer.py')
ROOT = '/run/aihr-browser-capability-427'
SOURCE = ROOT + '/launch-source'
RUNTIME = ROOT + '/runtime'
NONCE = '0123456789abcdef'
SPKI = base64.b64encode(bytes(32)).decode('ascii')
DECOY = (ROOT + '/private/observer', I._synthetic_decoy('427'))
SOCKET_MASKS = '-/run/docker.sock -/run/containerd/containerd.sock'
DRIVER_CREDENTIAL_MASK = '-/run/credentials/aihrbc-driver-427.service'


def command(role, **changes):
    inputs = {'mode': 'capability-only', 'role': role, 'run_id': '427', 'owner_nonce': NONCE, 'stage': SOURCE}
    if role == 'driver':
        inputs['credential'] = DECOY
    if role == 'browser':
        inputs['spki'] = SPKI
    return P.synthetic_role_command(H, **(inputs | changes))


class SyntheticLaunchPlanModels(unittest.TestCase):
    def assert_role(self, plan, role, uid, workdir, environment, properties, executable):
        unit = f'aihrbc-{role}-427.service'
        description = f'AIHR synthetic Chromium 427 {role} 0123456789abcdef'
        self.assertEqual((plan.unit, plan.uid, plan.gid, plan.control_group, plan.description),
                         (unit, uid, uid, '/system.slice/' + unit, description))
        self.assertEqual(plan.launcher_environment, (('PATH', '/usr/sbin:/usr/bin:/sbin:/bin'), ('LANG', 'C'), ('LC_ALL', 'C')))
        self.assertEqual(plan.argv[:11], ('/usr/bin/systemd-run', '--system', '--wait', '--pipe', '--quiet',
                         '--no-ask-password', '--expand-environment=no', '--slice=system.slice', '--unit=' + unit,
                         '--description=' + description, '--working-directory=' + workdir))
        separator = plan.argv.index('--')
        property_options = [value[len('--property='):] for value in plan.argv[11:separator] if value.startswith('--property=')]
        env_options = [value[len('--setenv='):] for value in plan.argv[11:separator] if value.startswith('--setenv=')]
        self.assertEqual(len(property_options) + len(env_options), separator - 11)
        self.assertEqual(len(property_options), len(properties))
        self.assertEqual(dict(value.split('=', 1) for value in property_options), properties)
        self.assertEqual(len(env_options), len(environment))
        self.assertEqual(dict(value.split('=', 1) for value in env_options), environment)
        self.assertEqual(plan.argv[separator + 1:], executable)

    def test_driver_has_only_fixed_synthetic_credential_and_playwright_view(self):
        plan = command('driver')
        home = ROOT + '/driver-home'
        leaves = ('node', 'roles/native-workload-browser-driver.mjs', 'roles/native-workload-browser-server.mjs',
                  'node_modules/playwright', 'node_modules/playwright-core')
        properties = H.role_properties('driver') | {
            'PrivateMounts': 'yes', 'DynamicUser': 'no', 'SetLoginEnvironment': 'no', 'PassEnvironment': '',
            'BindReadOnlyPaths': ' '.join(f'{SOURCE}/{leaf}:{RUNTIME}/{leaf}:norbind' for leaf in leaves),
            'InaccessiblePaths': SOCKET_MASKS + ' ' + ROOT + '/browser-home',
            'ReadWritePaths': home + '/scratch', 'LoadCredential': 'observer:' + ROOT + '/private/observer',
        }
        environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'HOME': home, 'TMPDIR': home + '/scratch'}
        self.assert_role(plan, 'driver', 62120, home, environment, properties,
                         (RUNTIME + '/node', RUNTIME + '/roles/native-workload-browser-driver.mjs', '--capability-only'))
        self.assertNotIn('aihr-browser-isolation-v1', ' '.join(plan.argv))
        self.assertNotIn('CREDENTIALS_DIRECTORY=', ' '.join(plan.argv))

    def test_browser_has_fixed_server_probe_and_chromium_view_without_driver_files(self):
        home = ROOT + '/browser-home'
        leaves = ('node', 'roles/native-workload-browser-server.mjs', 'roles/native-workload-browser-host.py',
                  'node_modules/playwright', 'node_modules/playwright-core', 'chromium/chrome-headless-shell-linux64')
        properties = H.role_properties('browser') | {
            'PrivateMounts': 'yes', 'DynamicUser': 'no', 'SetLoginEnvironment': 'no', 'PassEnvironment': '',
            'BindReadOnlyPaths': ' '.join(f'{SOURCE}/{leaf}:{RUNTIME}/{leaf}:norbind' for leaf in leaves),
            'InaccessiblePaths': SOCKET_MASKS + ' ' + ROOT + '/driver-home ' + DRIVER_CREDENTIAL_MASK,
            'ReadWritePaths': home + '/scratch',
        }
        environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'HOME': home, 'TMPDIR': home + '/scratch'}
        self.assert_role(command('browser'), 'browser', 62121, home, environment, properties,
                         (RUNTIME + '/node', RUNTIME + '/roles/native-workload-browser-server.mjs', SPKI))

    def test_third_has_only_fixed_python_probe_and_no_writable_role_view(self):
        probe = 'roles/native-workload-browser-host.py'
        properties = H.role_properties('driver') | {
            'User': '65534', 'Group': '65534', 'PrivateMounts': 'yes', 'DynamicUser': 'no',
            'SetLoginEnvironment': 'no', 'PassEnvironment': '', 'BindReadOnlyPaths': f'{SOURCE}/{probe}:{RUNTIME}/{probe}:norbind',
            'InaccessiblePaths': SOCKET_MASKS + ' ' + ROOT + '/driver-home ' + ROOT + '/browser-home ' + DRIVER_CREDENTIAL_MASK,
        }
        environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'HOME': '/nonexistent'}
        self.assert_role(command('third'), 'third', 65534, '/', environment, properties,
                         ('/usr/bin/python3', '-I', '-B', RUNTIME + '/' + probe, 'probe-third'))

    def test_non_synthetic_scope_malformed_identity_and_sibling_stage_refuse(self):
        for changes, reason in (({'mode': 'observer'}, 'mode'), ({'role': 'probe-browser'}, 'role'),
                                ({'run_id': '0427'}, 'run'), ({'run_id': '9007199254740992'}, 'run'),
                                ({'owner_nonce': NONCE.upper()}, 'owner'), ({'stage': ROOT + '/runtime'}, 'stage'),
                                ({'stage': SOURCE.replace('427', '428')}, 'stage'),
                                ({'stage': SOURCE + ':foreign\n--property=User=root'}, 'stage')):
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, '^synthetic-launch-' + reason + '$'):
                if 'role' in changes:
                    command(changes['role'])
                else:
                    command('driver', **changes)
        for override in ({'argv': ['sh']}, {'binds': ['/home/runner']}, {'environment': {'NODE_OPTIONS': '--inspect'}}):
            with self.subTest(override=override), self.assertRaises(TypeError):
                command('driver', **override)

    def test_driver_refuses_wrong_path_or_decoy_and_other_roles_refuse_credentials(self):
        for credential in (None, (DECOY[0].replace('427', '428'), DECOY[1]),
                           (DECOY[0], I._synthetic_decoy('428')),
                           (DECOY[0], b'postgres://observer:fictional@127.0.0.1:5433/ai_hr_test_w1'),
                           (DECOY[0], DECOY[1] + b'extra'), [*DECOY]):
            with self.subTest(credential=credential), self.assertRaisesRegex(ValueError, '^synthetic-launch-credential$'):
                command('driver', credential=credential)
        for role in ('browser', 'third'):
            with self.subTest(role=role), self.assertRaisesRegex(ValueError, '^synthetic-launch-credential$'):
                command(role, credential=DECOY)

    def test_only_browser_accepts_one_canonical_spki(self):
        for spki in (None, SPKI.rstrip('='), SPKI[:-2] + 'B=', SPKI + '\n', '--no-sandbox'):
            with self.subTest(spki=spki), self.assertRaisesRegex(ValueError, '^synthetic-launch-spki$'):
                command('browser', spki=spki)
        for role in ('driver', 'third'):
            with self.subTest(role=role), self.assertRaisesRegex(ValueError, '^synthetic-launch-spki$'):
                command(role, spki=SPKI)


if __name__ == '__main__':
    unittest.main()
