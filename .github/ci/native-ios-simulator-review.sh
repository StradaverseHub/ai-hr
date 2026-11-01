#!/usr/bin/env bash
# Standard hosted simulator build only. FAKETEAMID matches the existing EAS simulator namespace;
# it is not an Apple account, device provisioning profile, certificate or private signing key.
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
  CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES CODE_SIGN_IDENTITY=- \
  DEVELOPMENT_TEAM=FAKETEAMID ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
  build > "$RUNNER_TEMP/onehr-ios-build.log" 2>&1 || {
    tail -160 "$RUNNER_TEMP/onehr-ios-build.log"
    exit 1
  }
export REVIEW_APP_PATH="$derived_dir/Build/Products/Release-iphonesimulator/OneHR.app"
export REVIEW_MANIFEST_PATH="$review_dir/manifest.json"
python3 .github/ci/package-ios-simulator-review.py
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$REVIEW_APP_PATH" "$review_dir/OneHR-simulator.zip"
