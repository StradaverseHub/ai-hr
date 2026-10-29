#!/usr/bin/env bash
# Compile/run actual Swift recovery models with synthetic vendor/storage ports. No app/DB/deploy.
set -euo pipefail
native_source=${1:?Frozen candidate directory required}
: "${AIHR_CI_HEAD:?Exact candidate SHA required}"
: "${RUNNER_TEMP:?Runner temporary directory required}"
[[ "$AIHR_CI_HEAD" =~ ^[0-9a-f]{40}$ ]]
[[ "$(git -C "$native_source" rev-parse HEAD)" == "$AIHR_CI_HEAD" ]]
git -C "$native_source" diff --exit-code
git -C "$native_source" diff --cached --exit-code
[[ "$(uname -s)" == Darwin ]]
sw_vers
xcrun swiftc --version
xcrun --show-sdk-version
native_model_dir=$(mktemp -d "$RUNNER_TEMP/mobile-native-proof-models.XXXXXX")
trap 'rm -rf "$native_model_dir"' EXIT
/usr/bin/time -l xcrun swiftc -parse-as-library -swift-version 5 \
 "$native_source/mobile/modules/aihr-integrity/ios/AppAttestProofStore.swift" \
 "$native_source/test/fixtures/mobile-integrity/AppAttestProofStoreHarness.swift" \
 -o "$native_model_dir/enrollment"
/usr/bin/time -l "$native_model_dir/enrollment"
/usr/bin/time -l xcrun swiftc -parse-as-library -swift-version 5 \
 "$native_source/mobile/modules/aihr-integrity/ios/AppAttestProofStore.swift" \
 "$native_source/mobile/modules/aihr-integrity/ios/AppAttestAssertionStore.swift" \
 "$native_source/test/fixtures/mobile-integrity/AppAttestAssertionStoreHarness.swift" \
 -o "$native_model_dir/assertions"
/usr/bin/time -l "$native_model_dir/assertions"
[[ "$(git -C "$native_source" rev-parse HEAD)" == "$AIHR_CI_HEAD" ]]
git -C "$native_source" diff --exit-code
git -C "$native_source" diff --cached --exit-code
printf '%s\n' 'Swift host models passed. No iOS binary, vendor or OS Keychain acceptance claimed.'
