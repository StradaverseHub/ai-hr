#!/usr/bin/env bash
# Unsigned physical-device compilation on a standard hosted runner. Signing stays local.
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
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath "$derived_dir" -jobs 2 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  DEVELOPMENT_TEAM=ZVZQ463ZLX ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
  build > "$RUNNER_TEMP/onehr-ios-build.log" 2>&1 || {
    tail -160 "$RUNNER_TEMP/onehr-ios-build.log"
    exit 1
  }
app="$derived_dir/Build/Products/Release-iphoneos/OneHR.app"
[[ -d "$app/PlugIns/ExpoWidgetsTarget.appex" ]]
/usr/libexec/PlistBuddy -c 'Print CFBundleSupportedPlatforms:0' "$app/Info.plist" | grep -qx iPhoneOS
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$app" "$review_dir/OneHR-device-unsigned.zip"
shasum -a 256 "$review_dir/OneHR-device-unsigned.zip" > "$review_dir/SHA256SUMS.txt"
git rev-parse HEAD > "$review_dir/source.txt"
