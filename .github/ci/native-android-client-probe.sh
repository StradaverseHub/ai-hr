#!/usr/bin/env bash
# Review artifact only. Standard hosted runner; no private credentials, device,
# server, paid EAS build, source integration or store submission.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux ]]
[[ "${GITHUB_REPOSITORY:-}" == StradaverseHub/ai-hr ]]
[[ "${EXPECTED_SOURCE:-}" == 0ec19e9706cb16a7d6139d71be45e2fa570512b9 ]]
[[ "$(git -C source rev-parse HEAD)" == "$EXPECTED_SOURCE" ]]
[[ -z "$(git -C source status --porcelain)" ]]
[[ -d "${JAVA_HOME_17_X64:?Standard runner JDK17 required}" ]]
[[ -d "${ANDROID_HOME:?Standard runner Android SDK required}" ]]
export JAVA_HOME="$JAVA_HOME_17_X64"
export PATH="$JAVA_HOME/bin:$PATH"
java -version
df -h .
pnpm --dir source install --frozen-lockfile
npm ci --prefix source/mobile --no-audit --no-fund
npm --prefix source/mobile run eas-build-post-install
npm --prefix source/mobile run typecheck
(
  cd source/mobile
  npm exec --offline -- expo prebuild --platform android --no-install
)
# Generated projects may be added; frozen authored mobile source must not change.
git -C source diff --exit-code -- mobile ':!mobile/android'
review_dir="$RUNNER_TEMP/onehr-android-client-probe"
mkdir -p "$review_dir"
(
  cd source/mobile/android
  ./gradlew :app:createBundleReleaseJsAndAssets --no-daemon --max-workers=2 \
    -PreactNativeArchitectures=arm64-v8a \
    '-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m'
) > "$review_dir/gradle-review.log" 2>&1 || { tail -100 "$review_dir/gradle-review.log"; exit 1; }
export REVIEW_DIR="$review_dir"
cp source/mobile/android/app/build/generated/assets/react/release/index.android.bundle "$review_dir/index.android.hbc"
python3 controller/.github/ci/repackage-client-probe.py
build_tools="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)"
"$build_tools/zipalign" -P 16 -f 4 "$review_dir/unaligned.apk" "$review_dir/aligned.apk"
"$build_tools/apksigner" sign --ks source/mobile/android/app/debug.keystore --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out "$review_dir/OneHR-client-probe.apk" "$review_dir/aligned.apk"
"$build_tools/apksigner" verify --verbose --print-certs "$review_dir/OneHR-client-probe.apk" > "$review_dir/signature.txt"
grep -F 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c' "$review_dir/signature.txt"
python3 controller/.github/ci/repackage-client-probe.py --verify
rm "$review_dir/unaligned.apk" "$review_dir/aligned.apk"
