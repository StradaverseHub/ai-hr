# Mobile attendance platform evidence — 27 October 2026

Research scope: current official Apple, Android/Google Play and Expo SDK 57 documentation. This is platform evidence for the parent code review of `main@67be2710c`, not a device test or a security guarantee. Platform research only; no application behavior changed.

## Findings that change or refine ADR-0088

1. **FACT: iOS has a documented sleep-inclusive monotonic clock.** `mach_continuous_time()` increments during system sleep; Apple recommends the nanosecond equivalent `clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)`. Swift `ContinuousClock` also progresses through sleep. The old “does such a clock exist?” unknown can be closed. **UNKNOWN:** the app's native bridge, persisted anchor representation, reboot detection and measured drift still need hardware tests. Do not persist a Swift opaque `Instant` and assume its representation is a protocol. [Mach continuous time](https://developer.apple.com/documentation/kernel/1646199-mach_continuous_time), [Swift ContinuousClock](https://developer.apple.com/documentation/swift/continuousclock/continuous).

2. **FACT: App Attest assertions are generated locally, without an Apple round trip.** Apple explicitly states this in WWDC26 and an Apple engineer reconfirms it in August 2026. Key attestation does contact Apple. Keys survive updates but become invalid after reinstall/restore and do not sync across devices. Therefore the prior “can assertion generation happen without network?” uncertainty has an official answer; the selected bridge and actual airplane-mode behavior remain device acceptance checks. **RECOMMENDATION:** do not describe all App Attest operations as online-only. [WWDC26 App Attest](https://developer.apple.com/videos/play/wwdc2026/201/), [Apple engineer clarification](https://developer.apple.com/forums/thread/838933).

3. **FACT: Apple's normal assertion protocol includes a one-time server challenge and increasing assertion counter.** Server verification checks the app ID, signature, increasing counter and challenge. **DESIGN IMPLICATION:** an offline punch cannot obtain a fresh server challenge on demand. Use a reviewed pre-issued, expiring, device/user/installation-bound challenge or signed offline permit design, then consume it atomically at upload. This is a proposed protocol, not a capability guaranteed by the API. Process queued assertions in generation order; concurrent/out-of-order upload must not cause valid earlier claims to disappear. [Apple server validation](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server), [Assertion API](https://developer.apple.com/documentation/devicecheck/dcappattestservice/generateassertion(_:clientdatahash:completionhandler:)).

## Location evidence and its limits

- **FACT:** Android `Location.isMock()` reports a location marked as mock, typically supplied by a framework test provider; it is not a signed proof of genuine physical position. Its predecessor is deprecated from API 31. `getElapsedRealtimeNanos()` provides fix time since boot, is monotonic and includes deep sleep, and cannot be compared across boots/devices. **INFERENCE:** a negative mock flag does not authenticate coordinates submitted by a modified client. [Android Location](https://developer.android.com/reference/android/location/Location).
- **FACT:** Apple `isSimulatedBySoftware` describes Core Location on-device simulation; `isProducedByAccessory` describes an external accessory. Apple DTS explicitly says the simulation flag is not set for the third-party provider path discussed in its forum. A false/missing value must therefore remain unknown rather than “not spoofed.” Do not automatically label every accessory fraudulent. [Apple source-information API](https://developer.apple.com/documentation/corelocation/cllocation/sourceinformation), [Apple simulation flag](https://developer.apple.com/documentation/corelocation/cllocationsourceinformation/issimulatedbysoftware), [Apple DTS limitation](https://developer.apple.com/forums/thread/803179).
- **FACT:** classic `expo-location` SDK 57 exposes `LocationObject.mocked` as Android-only, fix epoch `timestamp`, and `coords.accuracy` as an uncertainty radius. Permission responses expose Android `accuracy: fine/coarse/none` and iOS `accuracy: full/reduced`; generic granted permission alone does not mean precise access. `canAskAgain=false` calls for a Settings recovery path. **RECOMMENDATION:** inspect these fields and provide separate permission, approximate-location, services-disabled, timeout and poor-fix messages. iOS simulation/accessory and monotonic evidence require an evaluated native bridge/API. A requested High accuracy is not a guaranteed result. [Expo SDK 57 location](https://docs.expo.dev/versions/v57.0.0/sdk/location/).

## Android integrity binding, network and quotas

- **FACT:** Play Integrity standard flow obtains a token, sends it through the app backend, and uses Google's server to decrypt/verify. Bind the exact canonical command (or batch digest) through `requestHash`, then recompute and compare on the server. Standard tokens have automatic replay mitigation, but attendance still needs its own actor/device-scoped idempotency receipts. **INFERENCE:** an integrity check performed only at registration does not establish the later punch's request integrity; a fresh check at synchronization does not retroactively establish offline coordinates or wall-clock time. [Standard request flow](https://developer.android.com/google/play/integrity/standard).
- **FACT:** verdicts describe app, device and account integrity, with request package/hash/timestamp checked before verdict interpretation. App licensing and recognition depend on distribution; a sideloaded test APK cannot simply be assumed equivalent to a Play-distributed release. **RECOMMENDATION:** test chosen distribution channels and unsupported/no-Play states, retaining truthful lower-trust/review states rather than inventing a passing verdict. Neither Play Integrity nor App Attest provides a GPS-present verdict. [Integrity verdicts](https://developer.android.com/google/play/integrity/verdicts).
- **FACT:** current default quotas are 10,000 daily token requests (classic requests plus standard token preparations) and 10,000 server decryptions (classic plus standard), tied to Cloud project. Quota increases require eligibility and can take up to a week; monitor usage and gradual rollout. Avoid the misleading shorthand that every standard token generation consumes the same preparation quota; server decryptions remain a scale constraint. [Play Integrity setup and quotas](https://developer.android.com/google/play/integrity/setup).
- **FACT:** Android `SystemClock.elapsedRealtimeNanos()` measures time since boot including deep sleep. **RECOMMENDATION:** bind every offline server-time anchor to the current boot, device key, user/installation and policy version; detect discontinuity/reboot and preserve a time-unverified claim for review instead of deriving a fabricated instant. [Android SystemClock](https://developer.android.com/reference/android/os/SystemClock).

## Required device/protocol spikes before offline rollout

Native implementation follow-up, 27 October: Apple's `serverUnavailable` guidance requires retaining
both the same key and the same `clientDataHash`; retrying with a fresh challenge/hash is not equivalent.
[Primary guidance](https://developer.apple.com/documentation/devicecheck/dcerror-swift.struct/serverunavailable).
iOS 18 explicitly removed `kern.bootsessionuuid` access, so the native spike does not probe it or
invent a replacement from wall time. [Release notes](https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-18-release-notes).
Apple's required-reason rules also restrict off-device raw uptime/boot-time information; only elapsed
app-event durations are used by the proposed timing transport. Raw snapshots remain local, with an
opaque process identifier and unknown continuity after restart where no valid boot binding exists.
[API reason rules](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype).
These constraints refine the protocol; they do not establish a hardware or signed-build acceptance pass.

Local native-spike verification, 27 October: the source preserved at `626afd5b2` compiled against the
installed Android SDK, Expo module API and pinned Play Integrity library (`compileDebugKotlin`, exit 0).
The three focused JavaScript model/capture suites passed 25 tests; root and mobile TypeScript checks
passed, as did Swift frontend parsing. Swift parsing is syntax evidence only: no iOS framework build,
entitlement check, vendor attestation or physical-device acceptance was performed. Subsequent changes
to the JavaScript-tested source were documentation and Android lint configuration only.

Full Android lint did **not** pass. Both `lintDebug` and a narrower `lintAnalyzeDebug` request failed
in the dependency task `:react-native-worklets:lintAnalyzeDebug` with `Cannot find a KaModule for the
VirtualFile`, while parsing Kotlin build scripts. The narrower task still invokes dependency analysis,
so it does not establish a separate clean integrity-module lint result. Google's
[tracked issue](https://issuetracker.google.com/issues/430991549) describes the matching failure pattern;
that resemblance is not proof of an installed-version fix. No dependency files were patched or checks
suppressed to obtain a pass. The integrity module explicitly overrides Expo's non-blocking library
default with `abortOnError = true`. Preserve lint as an unresolved verification requirement.

The subsequent online command-binding primitive was checked at `5518bfd4e`: three focused suites
passed 24 tests, and root/mobile TypeScript checks both exited 0. The production shared positional
encoding and server SHA-256 implementation were exercised with generated synthetic P-256 keys.
Changing any scope, challenge, command, attachment or reported-source field invalidated that synthetic
signature; true/false/unavailable signals stayed distinct. The native hashing adapter was exercised
through its actual source with a crypto port and obsolete-actor refusal. These tests establish command
binding and adapter behavior only. They do not test Apple assertion encoding/signing, a verified vendor
certificate, an issued challenge, atomic counter consumption or an accepted attendance write. The v1
routes remain unchanged and do not use the primitive. Persistent enrollment/challenge owners and
cryptographic vendor verifiers remain required before this protocol can be enabled.

1. iOS release/TestFlight build: initial key attestation online, then generate and persist ordered assertions in airplane mode; reconnect, validate counters/challenges; repeat after force quit, update, reinstall and restore.
2. Both OSes: anchor a native sleep-inclusive clock, sleep for a shift, alter wall time/timezone, kill/relaunch, reboot, and upload out of order. Measure drift and uncertainty; validate bounded expiry and no silent loss.
3. Location: denied/once-only/revoked/approximate permission, services off, indoor uncertainty, stale/future timestamps, Android mock flag, iOS Xcode simulation versus third-party provider, accessory receiver. Record capability/unknown values without assuming a clean device.
4. Android distribution and outage: installed Play build versus internal APK; missing/old Play services, unsupported device, quota exhaustion, Google timeout, invalid hash/package/certificate and repeated token decode. No outage may silently become an “attested” result.
5. Replay and tampering: identical batch retries, altered coordinates/photo digest/time with same request ID, missing/reordered chain element, old permit, replaced device, revoked key, employment/account/tenant change. One claim must produce at most one authoritative punch and a stable receipt.
6. On-site corroboration: signed rotating QR can add evidence but screenshots/relay remain possible. Test replay/expiry and define whether policy accepts that residual risk. Never call a QR or device attestation alone proof of presence.

**Recommendation:** preserve separate recorded evidence, deterministic integrity assessment, attendance acceptance, and human exception resolution. An unavailable platform check is not a failed employee action and must not silently erase the attempt.
