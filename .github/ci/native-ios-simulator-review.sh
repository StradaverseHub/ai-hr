#!/usr/bin/env bash
# Review-only standard hosted runner fallback. No EAS account, signing keys, app data or deployment.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == macOS && "${RUNNER_ARCH:-}" == ARM64 ]]
[[ "${GITHUB_REPOSITORY:-}" == StradaverseHub/ai-hr ]]
[[ "${EXPECTED_SOURCE:-}" =~ ^[0-9a-f]{40}$ ]]
[[ "$(git rev-parse HEAD)" == "$EXPECTED_SOURCE" ]]
[[ -z "$(git status --porcelain)" ]]
xcodebuild -version
node --version
npm ci --prefix mobile --no-audit --no-fund
npm --prefix mobile run eas-build-post-install
(
  cd mobile
  npm exec --offline -- expo prebuild --platform ios --no-install
  cd ios
  pod install
)
review_dir="$RUNNER_TEMP/onehr-ios-review"
derived_dir="$RUNNER_TEMP/onehr-ios-derived"
mkdir -p "$review_dir"
xcodebuild -workspace mobile/ios/OneHR.xcworkspace -scheme OneHR \
  -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$derived_dir" -jobs 2 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
  build > "$RUNNER_TEMP/onehr-ios-build.log" 2>&1 || {
    tail -160 "$RUNNER_TEMP/onehr-ios-build.log"
    exit 1
  }
export REVIEW_APP_PATH="$derived_dir/Build/Products/Release-iphonesimulator/OneHR.app"
export REVIEW_MANIFEST_PATH="$review_dir/manifest.json"
python3 - <<'PY'
import hashlib,json,os,plistlib,subprocess
from pathlib import Path
app=Path(os.environ['REVIEW_APP_PATH'])
info=plistlib.loads((app/'Info.plist').read_bytes())
assert info['CFBundleIdentifier']=='ai.stradaverse.aihr.test'
assert info['CFBundleVersion']=='12'
assert info['CFBundleSupportedPlatforms']==['iPhoneSimulator']
assert (app/'main.jsbundle').is_file()
extensions=[]
for extension in (app/'PlugIns').glob('*.appex'):
    meta=plistlib.loads((extension/'Info.plist').read_bytes())
    assert meta['CFBundleVersion']=='12'
    extensions.append({'id':meta['CFBundleIdentifier'],'build':meta['CFBundleVersion']})
assert len(extensions)==1
manifest={'source':os.environ['EXPECTED_SOURCE'],'route':'standard GitHub-hosted macos-26; unsigned simulator review only','build':'12','bundleIdentifier':info['CFBundleIdentifier'],'executable':info['CFBundleExecutable'],'executableSha256':hashlib.sha256((app/info['CFBundleExecutable']).read_bytes()).hexdigest(),'bundleSha256':hashlib.sha256((app/'main.jsbundle').read_bytes()).hexdigest(),'extensions':extensions,'xcode':subprocess.check_output(['xcodebuild','-version'],text=True).strip(),'githubRun':os.environ['GITHUB_RUN_ID']}
Path(os.environ['REVIEW_MANIFEST_PATH']).write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(manifest))
PY
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$REVIEW_APP_PATH" "$review_dir/OneHR-simulator.zip"
