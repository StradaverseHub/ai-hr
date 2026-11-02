#!/usr/bin/env bash
# Review artifact only. Standard hosted runner; no private credentials, device,
# server, paid EAS build, source integration or store submission.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux ]]
[[ "${GITHUB_REPOSITORY:-}" == StradaverseHub/ai-hr ]]
[[ "${EXPECTED_SOURCE:-}" == b918bac3abff806c157d270f286354b67a4c37bd ]]
[[ "$(git -C source rev-parse HEAD)" == "$EXPECTED_SOURCE" ]]
[[ -z "$(git -C source status --porcelain)" ]]
[[ -d "${JAVA_HOME_17_X64:?Standard runner JDK17 required}" ]]
[[ -d "${ANDROID_HOME:?Standard runner Android SDK required}" ]]
export JAVA_HOME="$JAVA_HOME_17_X64"
export PATH="$JAVA_HOME/bin:$PATH"
java -version
df -h .
npm ci --prefix source --ignore-scripts --no-audit --no-fund
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
  ./gradlew :app:assembleRelease --no-daemon --max-workers=2 \
    -PreactNativeArchitectures=arm64-v8a \
    '-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m' \
    -x lint -x test
) > "$review_dir/gradle-review.log" 2>&1 || {
  tail -120 "$review_dir/gradle-review.log"
  exit 1
}
apk=source/mobile/android/app/build/outputs/apk/release/app-release.apk
[[ -f "$apk" ]]
cp "$apk" "$review_dir/OneHR-client-probe.apk"
export REVIEW_DIR="$review_dir"
python3 - <<'PY'
import hashlib,json,os,pathlib,subprocess
root=pathlib.Path(os.environ['REVIEW_DIR']);apk=root/'OneHR-client-probe.apk'
digest=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
v={'source':os.environ['EXPECTED_SOURCE'],'controller':os.environ['GITHUB_SHA'],
   'githubRun':os.environ['GITHUB_RUN_ID'],'runAttempt':os.environ['GITHUB_RUN_ATTEMPT'],
   'platform':'android','abi':'arm64-v8a','configuration':'release',
   'apk':'OneHR-client-probe.apk','apkSha256':digest(apk),
   'mobileLockSha256':digest('source/mobile/package-lock.json'),
   'signing':'Generated Expo Android template public debug review signing; no production key',
   'productionOrStoreReady':False,'finalBinaryBackupRulesVerified':False,
   'note':'Compile/provenance only; inspect actual APK XML/permissions/signature independently before accepting hardening'}
(root/'manifest.json').write_text(json.dumps(v,indent=2)+'\n')
PY
