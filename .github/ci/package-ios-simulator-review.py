"""Verify normal Xcode simulator signing, including its separate simulated entitlement section.

No re-signing or credential access is performed. Real signing entitlements and simulator entitlements
are different: the latter are linked by Xcode into __TEXT,__entitlements. Code signing must remain
allowed during the simulator build for those identity declarations to exist.
"""
import hashlib
import json
import os
import plistlib
import re
import subprocess
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def simulated_scope(executable):
    output = subprocess.check_output(['otool', '-arch', 'arm64', '-s', '__TEXT', '__entitlements', str(executable)], text=True)
    data = bytearray()
    for line in output.splitlines():
        cells = line.split()
        if len(cells) < 2 or not re.fullmatch(r'[0-9a-fA-F]{8,16}', cells[0]):
            continue
        for cell in cells[1:]:
            if re.fullmatch(r'(?:[0-9a-fA-F]{2}){1,4}', cell):
                value = bytes.fromhex(cell)
                data.extend(value[::-1] if len(value) == 4 else value)
    return plistlib.loads(bytes(data).rstrip(b'\0'))


app = Path(os.environ['REVIEW_APP_PATH'])
info = plistlib.loads((app / 'Info.plist').read_bytes())
assert info['CFBundleIdentifier'] == 'ai.stradaverse.aihr.test'
assert info['CFBundleVersion'] == '14'
assert info['CFBundleSupportedPlatforms'] == ['iPhoneSimulator']
assert (app / 'main.jsbundle').is_file()
extensions = sorted((app / 'PlugIns').glob('*.appex'))
assert len(extensions) == 1
scopes = []
for target in [app, *extensions]:
    meta = plistlib.loads((target / 'Info.plist').read_bytes())
    identifier = meta['CFBundleIdentifier']
    assert identifier in ['ai.stradaverse.aihr.test', 'ai.stradaverse.aihr.test.ExpoWidgetsTarget']
    assert meta['CFBundleVersion'] == '14'
    scope = simulated_scope(target / meta['CFBundleExecutable'])
    # Match the verified existing EAS simulator identity, retaining its protected-store namespace.
    assert scope['application-identifier'] == 'FAKETEAMID.' + identifier
    assert scope['com.apple.security.application-groups'] == ['group.ai.stradaverse.aihr.test']
    if scope.get('keychain-access-groups'):
        assert scope['keychain-access-groups'] == ['FAKETEAMID.' + identifier]
    scopes.append(scope)
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
manifest = {'source': os.environ['EXPECTED_SOURCE'], 'route': 'standard macos-26; normal Xcode simulator signing',
            'build': '14', 'bundleIdentifier': info['CFBundleIdentifier'], 'executable': info['CFBundleExecutable'],
            'executableSha256': sha(app / info['CFBundleExecutable']), 'bundleSha256': sha(app / 'main.jsbundle'),
            'simulatedSigningScopes': scopes, 'githubRun': os.environ['GITHUB_RUN_ID'],
            'xcode': subprocess.check_output(['xcodebuild', '-version'], text=True).strip(),
            'extensions': [{'id': 'ai.stradaverse.aihr.test.ExpoWidgetsTarget', 'build': '14'}]}
Path(os.environ['REVIEW_MANIFEST_PATH']).write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest))
