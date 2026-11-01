"""Bind an already compiled simulator bundle to its normal ad-hoc app identity.

This is neither device signing nor authentication bypass. Each target gets only its own keychain
identity, plus the already source-declared widget display-snapshot group. No private key or account
is used. The extension never receives the main application credential group.
"""
import hashlib
import json
import os
import plistlib
import subprocess
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(*args):
    return subprocess.check_output(args, text=True)


app = Path(os.environ['REVIEW_APP_PATH'])
info = plistlib.loads((app / 'Info.plist').read_bytes())
assert info['CFBundleIdentifier'] == 'ai.stradaverse.aihr.test'
assert info['CFBundleVersion'] == '12'
assert info['CFBundleSupportedPlatforms'] == ['iPhoneSimulator']
executable = app / info['CFBundleExecutable']
original_executable = sha(executable)
original_bundle = sha(app / 'main.jsbundle')
source = os.environ['EXPECTED_SOURCE']
original_run = None
if os.environ.get('REVIEW_ORIGINAL_MANIFEST'):
    prior_path = Path(os.environ['REVIEW_ORIGINAL_MANIFEST'])
    prior = json.loads(prior_path.read_text())
    prior_run = json.loads((prior_path.parent.parent / 'original-run.json').read_text())
    assert prior_run == {'conclusion': 'success', 'headSha': os.environ['REUSE_IOS_SOURCE'], 'status': 'completed'}
    assert prior['source'] == os.environ['REUSE_IOS_SOURCE']
    assert prior['githubRun'] == os.environ['REUSE_IOS_RUN']
    assert prior['executableSha256'] == original_executable
    assert prior['bundleSha256'] == original_bundle
    # The intervening patch is Android-only. Refuse reuse after any iOS runtime/input change.
    changed = run('git', 'diff', '--name-only', prior['source'], 'HEAD', '--', 'mobile', 'lib').splitlines()
    assert all(p.startswith('mobile/modules/aihr-attendance-widget/android/') or p == 'mobile/app.json' for p in changed), changed
    before = json.loads(run('git', 'show', prior['source'] + ':mobile/app.json'))
    after = json.loads(Path('mobile/app.json').read_text())
    for config in (before, after):
        config['expo']['android'].pop('versionCode', None)
    assert before == after
    source, original_run = prior['source'], prior['githubRun']

extensions = sorted((app / 'PlugIns').glob('*.appex'))
assert len(extensions) == 1
for extension in extensions:
    meta = plistlib.loads((extension / 'Info.plist').read_bytes())
    assert meta['CFBundleIdentifier'] == 'ai.stradaverse.aihr.test.ExpoWidgetsTarget'
    assert meta['CFBundleVersion'] == '12'

# Only signing metadata may change. Independently retain the exact native instruction-section hashes.
texts = {p: hashlib.sha256(run('otool', '-s', '__TEXT', '__text', str(p)).encode()).hexdigest()
         for p in [executable, *[e / plistlib.loads((e / 'Info.plist').read_bytes())['CFBundleExecutable'] for e in extensions]]}
group_id = 'group.ai.stradaverse.aihr.test'
# The existing Expo Widgets configuration declares this exact group by bundle identifier.
config = json.loads(Path('mobile/app.json').read_text())['expo']
assert config['ios']['bundleIdentifier'] == 'ai.stradaverse.aihr.test'
widgets = next(p[1] for p in config['plugins'] if isinstance(p, list) and p[0] == 'expo-widgets')
assert widgets.get('groupIdentifier', 'group.' + config['ios']['bundleIdentifier']) == group_id
signing_scopes = []
for framework in sorted(app.rglob('*.framework'), key=lambda p: len(p.parts), reverse=True):
    subprocess.run(['codesign', '--force', '--sign', '-', str(framework)], check=True)
for target in [*extensions, app]:
    target_info = plistlib.loads((target / 'Info.plist').read_bytes())
    identifier = target_info['CFBundleIdentifier']
    scope = {'application-identifier': identifier, 'keychain-access-groups': [identifier],
             'com.apple.security.application-groups': [group_id]}
    entitlements = Path(os.environ['RUNNER_TEMP']) / (identifier + '.simulator-entitlements.plist')
    entitlements.write_bytes(plistlib.dumps(scope))
    subprocess.run(['codesign', '--force', '--sign', '-', '--identifier', identifier,
                    '--entitlements', str(entitlements), str(target)], check=True)
    signing_scopes.append(scope)
for path, expected in texts.items():
    assert hashlib.sha256(run('otool', '-s', '__TEXT', '__text', str(path)).encode()).hexdigest() == expected
assert sha(app / 'main.jsbundle') == original_bundle
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
manifest = {'source': source, 'packagingSource': os.environ['EXPECTED_SOURCE'],
            'route': 'standard macos-26; ad-hoc simulator identity; per-app keychain and existing widget snapshot group',
            'simulatorSigningScopes': signing_scopes,
            'build': '12', 'bundleIdentifier': info['CFBundleIdentifier'], 'executable': info['CFBundleExecutable'],
            'originalExecutableSha256': original_executable, 'executableSha256': sha(executable),
            'bundleSha256': original_bundle, 'nativeInstructionSectionsUnchanged': True,
            'originalBuildRun': original_run, 'githubRun': os.environ['GITHUB_RUN_ID'],
            'extensions': [{'id': 'ai.stradaverse.aihr.test.ExpoWidgetsTarget', 'build': '12'}]}
Path(os.environ['REVIEW_MANIFEST_PATH']).write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest))
