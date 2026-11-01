#!/usr/bin/env bash
# Review-only standard hosted runner. No EAS account, signing keys, app data or deployment.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == macOS && "${RUNNER_ARCH:-}" == ARM64 ]]
[[ "${GITHUB_REPOSITORY:-}" == StradaverseHub/ai-hr ]]
[[ "${EXPECTED_SOURCE:-}" =~ ^[0-9a-f]{40}$ ]]
[[ "$(git rev-parse HEAD)" == "$EXPECTED_SOURCE" ]]
[[ -z "$(git status --porcelain)" ]]
review_dir="$RUNNER_TEMP/onehr-ios-review"
mkdir -p "$review_dir"
xcodebuild -version
if [[ "${REUSE_IOS_RUN:-0}" != 0 ]]; then
  [[ "$REUSE_IOS_RUN" =~ ^[0-9]+$ && "$REUSE_IOS_SOURCE" =~ ^[0-9a-f]{40}$ ]]
  git fetch --no-tags --depth=1 origin "$REUSE_IOS_SOURCE"
  gh run view "$REUSE_IOS_RUN" --repo StradaverseHub/ai-hr --json headSha,status,conclusion > "$review_dir/original-run.json"
  gh run download "$REUSE_IOS_RUN" --repo StradaverseHub/ai-hr \
    --name "onehr-ios-simulator-$REUSE_IOS_SOURCE" --dir "$review_dir/original"
  /usr/bin/ditto -x -k "$review_dir/original/OneHR-simulator.zip" "$review_dir/repackaged"
  export REVIEW_APP_PATH="$review_dir/repackaged/OneHR.app"
  export REVIEW_ORIGINAL_MANIFEST="$review_dir/original/manifest.json"
else
  node --version
  npm ci --prefix mobile --no-audit --no-fund
  npm --prefix mobile run eas-build-post-install
  (
    cd mobile
    npm exec --offline -- expo prebuild --platform ios --no-install
    cd ios
    pod install
  )
  derived_dir="$RUNNER_TEMP/onehr-ios-derived"
  xcodebuild -workspace mobile/ios/OneHR.xcworkspace -scheme OneHR \
    -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$derived_dir" -jobs 2 \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
    build > "$RUNNER_TEMP/onehr-ios-build.log" 2>&1 || {
      tail -160 "$RUNNER_TEMP/onehr-ios-build.log"
      exit 1
    }
  export REVIEW_APP_PATH="$derived_dir/Build/Products/Release-iphonesimulator/OneHR.app"
fi
export REVIEW_MANIFEST_PATH="$review_dir/manifest.json"
python3 .github/ci/package-ios-simulator-review.py
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$REVIEW_APP_PATH" "$review_dir/OneHR-simulator.zip"
