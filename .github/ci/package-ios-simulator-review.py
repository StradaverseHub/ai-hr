"""Bind an already compiled simulator bundle to its normal ad-hoc app identity.

This is neither device signing nor authentication bypass. The working EAS simulator uses the same
bundle identifiers, no team and an empty entitlement dictionary. No private key or account is used.
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
entitlements = Path(os.environ['RUNNER_TEMP']) / 'onehr-empty-simulator-entitlements.plist'
entitlements.write_bytes(plistlib.dumps({}))
for framework in sorted(app.rglob('*.framework'), key=lambda p: len(p.parts), reverse=True):
    subprocess.run(['codesign', '--force', '--sign', '-', str(framework)], check=True)
for target in [*extensions, app]:
    target_info = plistlib.loads((target / 'Info.plist').read_bytes())
    subprocess.run(['codesign', '--force', '--sign', '-', '--identifier', target_info['CFBundleIdentifier'],
                    '--entitlements', str(entitlements), str(target)], check=True)
for path, expected in texts.items():
    assert hashlib.sha256(run('otool', '-s', '__TEXT', '__text', str(path)).encode()).hexdigest() == expected
assert sha(app / 'main.jsbundle') == original_bundle
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
manifest = {'source': source, 'packagingSource': os.environ['EXPECTED_SOURCE'],
            'route': 'standard macos-26; ad-hoc simulator bundle identity; no new entitlements',
            'build': '12', 'bundleIdentifier': info['CFBundleIdentifier'], 'executable': info['CFBundleExecutable'],
            'originalExecutableSha256': original_executable, 'executableSha256': sha(executable),
            'bundleSha256': original_bundle, 'nativeInstructionSectionsUnchanged': True,
            'originalBuildRun': original_run, 'githubRun': os.environ['GITHUB_RUN_ID'],
            'extensions': [{'id': 'ai.stradaverse.aihr.test.ExpoWidgetsTarget', 'build': '12'}]}
Path(os.environ['REVIEW_MANIFEST_PATH']).write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest))
