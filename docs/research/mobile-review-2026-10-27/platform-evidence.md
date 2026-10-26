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

Server assertion proof follow-up: at `6bf77e07e`, four focused integrity suites passed 34 tests and root
TypeScript exited 0. The checker interoperates with the public assertion/public-key/client-data fixture
from `uebelack/node-app-attest@f16c4bb71b737466872bc8b8a7dfd215364eaa83`; that fixture and its MIT license
are preserved under `test/fixtures/mobile-integrity/`. This is independent sample compatibility, not
proof of that sample's hardware origin, a valid employee enrollment or a vendor certificate chain.
[Upstream fixture](https://github.com/uebelack/node-app-attest/blob/f16c4bb71b737466872bc8b8a7dfd215364eaa83/test/verifyAssertion.test.js),
[Apple validation rules](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server).

The server pins `cbor@10.0.12`; its decoder/tag-conversion source matched the reviewed installed 10.0.11
source. Decoding is capped at 8 KiB with finite depth, duplicate/trailing-data refusal and no semantic
tag conversion. Tests cover changed payload/key/app, unsigned counters through `0xffffffff`, forged or
reused counters, malformed configuration, malformed/extra fields and unknown authenticator suffixes.
The initial compiler failure at `ec65e565c` was unknown-value narrowing after an inferred helper;
`fa93e99d8` repaired it with a declared never-returning function, without weakening input types.

A controlled local mutation at `fa93e99d8` bypassed the signature check: two tests failed and seven
passed. Restoring the committed source exactly returned all nine assertion tests to PASS (`git diff`
exit 0). The later configuration check adds refusal coverage without changing that signature path.
No production process or API used the mutation. Certificate-chain attestation, registered-key ownership,
stored challenge issuance/consumption, atomic counter updates, Android vendor verification and attendance
adjudication are still required. The pure checker returns a next counter and deliberately persists nothing.

Enrollment-key proof follow-up at `774500510`: five focused suites passed 44 tests; root TypeScript
exited 0. The immutable MIT-licensed captured production/development fixtures validate certificate paths
to Apple's pinned root at historical issuance times and fail with current/too-early server dates.
The root was read from Apple's certificate-authority site; its DER SHA-256 is
`1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932`.
[Apple root](https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem),
[captured fixtures](https://github.com/uebelack/node-app-attest/tree/f16c4bb71b737466872bc8b8a7dfd215364eaa83/test/fixtures).

The initial `a6d7cb6e4` guide-sample attempt failed four tests despite passing TypeScript. Investigation
confirmed the published guide certificate's nonce is `h7fQbZOkKU5G8BHma2zEAPC6sgcpl2xhlYC0KuYL/24=`:
it equals SHA-256(authenticator data || raw `example_server_challenge`), whereas SHA-256(authenticator
data || SHA-256(challenge)) is `HRzniRKJfeiM/p/OVSGqs3q/sJ3FRIM/8RVhJVLPdfM=`. The verifier retains
the documented 32-byte input-hash requirement and refuses this sample. Its signed bundle value is `1`,
while nearby explanatory prose says `1.0`; the actual bytes are preserved in the fixture.
[Current guide](https://developer.apple.com/documentation/devicecheck/attestation-object-validation-guide).

The two captured legacy fixtures have consistent nonce/key/app/environment proofs but no signed
distribution/build metadata. The key-proof result reports that absence; strict metadata-complete
enrollment refuses it. The decoder's empty `unused` value was null; the repair derives the remainder
from the checked consumed length and does not ignore suffixes. A controlled path-result bypass at
`774500510` caused one expired-certificate refusal test to fail (nine passed); exact source restoration
returned all ten enrollment-proof tests to PASS with no diff. The positive modern-metadata path lacks
a valid complete signed fixture and is not accepted as verified. Fraud-receipt validation, current
revocation, actor/key/challenge persistence, Android vendor checks, physical devices and full CI remain
open. The new helpers make no business writes and are not activated in v1 routes.

Play standard-token boundary at `a718ad7bc`: six focused suites passed 55 tests and root TypeScript
exited 0. All Google transport/auth responses were synthetic ports; no Google decode, credential access,
quota use or hardware acceptance occurred. The public discovery schema confirmed `integrityToken`,
`tokenPayloadExternal`, request/app fields and the `https://www.googleapis.com/auth/playintegrity` scope.
[Discovery schema](https://playintegrity.googleapis.com/$discovery/rest?version=v1),
[standard flow](https://developer.android.com/google/play/integrity/standard),
[verdict fields](https://developer.android.com/google/play/integrity/verdicts).

Coverage includes fixed endpoint/no redirects, canonical hash/package/version/signer binding, old/future
timestamps, expiry after response, replay-cleared evaluation, truthful lower signals, malformed/oversized
bodies, credential errors, quotas/outages, stalled bodies, cancellation and late credentials without a
late decode. The initial 17-test pass at `59f0932c2` had one compiler narrowing error; a captured validated
command repairs that without assertions or weaker types. Invalid numeric configuration is guarded before
BigInt conversion. A controlled hash-comparison deletion caused one test to fail (ten passed); exact
source restoration returned all eleven Play tests to PASS with no diff. Existing API routes do not use
this adapter. Android key-attestation verification, enrolled-key ownership, stored one-use challenges,
atomic receipts/counters and live Google/Play-distributed device evidence are still required.

Persistent challenge substrate at `8523ab7c0`: three affected database/API suites passed 49 tests,
including fourteen new lifecycle cases, migration-journal ordering and existing mobile journeys. Root
TypeScript exited 0. Migration `0622_mobile_integrity_challenges` was appended after the previous journal
watermark and exercised only on fresh, disposable local test databases. This is not a rehearsal from the
live staging baseline, a full gate or a staging migration. No existing applied SQL was edited.

Coverage proves one original nonce under concurrent issuance, immutable request bindings, current own
subject/RLS isolation, active capacity/shared budget behavior, terminal expiry without nonce replacement,
atomic callback/audit rollback, stable consumed receipts and application write/delete restrictions.
The first checkpoint `f281e35d1` failed test loading because of an extra parenthesis; no tests ran in that
attempt. The repair preserves driver Date precision and explicit types; the initial eight-case pass and
later expanded checks are retained separately. [Lifecycle decision](../../adr/0148-mobile-integrity-challenge-lifecycle.md).

The first row-lock mutation at `ceff87e57` unexpectedly passed its ordinary concurrent test (and passed
after restoration), exposing a coverage gap. A deterministic test now holds one consumer inside its
transaction until the other owned database connection is observably waiting for a lock. At `03ce947b4`,
removing `FOR UPDATE` caused that test to fail; exact restoration returned it to PASS (one selected case,
twelve skipped). The tests do not infer overlap merely from two promises being started.

A further write-veto test installs and removes a trigger only in its disposable database. The service
requires an actual returned transition row before any callback/audit. At `8523ab7c0`, ignoring that guard
caused the selected test to fail; exact source restoration passed (one selected case, thirteen skipped).
Both successful mutation harnesses reported `mutation=1 restored=0 exact=0`. These prove local replay and
transaction safety, not vendor/key ownership or attendance acceptance. Stored keys, canonical enrollment
assembly, proof-to-challenge binding, revocation, versioned APIs/native integration and full release/device
verification remain unfinished; the generic challenge functions are not exposed as public routes.

Apple enrollment custody at `1dd2a4027`: four affected database suites passed 57 tests and root
TypeScript exited 0. These checks use real disposable databases, RLS, transactions and receipt
encryption; vendor proof success is a synthetic integration port. The real default verifier refuses
malformed proof without consuming the challenge. No modern metadata-complete signed positive fixture
or hardware enrollment was added. Earlier `0331ed42f` failed test loading/type parsing because of a
missing function brace; no tests ran in that attempt. The repaired two-suite run passed 20 tests before
the expanded 57-test run. Logs are retained separately.

The owner now derives proof context from authenticated scope and the stored challenge, seals opaque
receipts with tenant/actor/key/challenge AAD, and commits key custody with challenge/audit atomically.
Checks cover duplicate completion, exact-proof receipt recovery before re-verification, revoked receipt
recovery, permanent fingerprint ownership, refusal to replace active installation keys, the five-key
capacity, active-first listings, metadata requirements, encryption-master outage, peer/admin isolation
and offboarding. Stored public material/counters/revocation are guarded against rewrites, and vendor
receipt material is absent from public receipts and audit. Secret-master encryption is not per-person
crypto-shredding; retention, erasure and rotation remain unfinished release requirements.

At `fbc10ef77`, three portable enrollment tests passed an independent expected-byte vector, object-order
and UUID normalization, strict domain/shape/lifetime refusals, and synthetic signature tampering across
each scope/challenge/target field. Synthetic signatures prove byte binding only. A controlled deletion
of the stored proof-digest receipt guard failed the changed-proof reconciliation test; exact restoration
passed (one selected case, seven skipped). The harness reported `mutation=1 restored=0 exact=True`.
Root TypeScript also exited 0 after adding the independent binding tests. No full CI or release
acceptance is claimed for these local additions.

Migration `0623_mobile_integrity_keys`, alongside `0621` and `0622`, is a local draft allocation subject
to a reported central filename collision. Do not apply or blindly renumber it. These migrations have
only been exercised on disposable local databases here; no staging/shared database was migrated.
No public route or native flow invokes enrollment yet. Android enrolled-key attestation, atomic stored
assertion counters in command acceptance, vendor receipt/fraud checks and device acceptance remain open.

Stored Apple online assertion owner at `2dd81f984`: three affected database files passed 31 cases,
including nine new assertion transaction cases, and root TypeScript exited 0. The initial seven-case
checkpoint `626061acf` also passed its database suite and compiler. Enrollment success uses a synthetic
vendor port; assertions use real P-256 signatures over the actual canonical command bytes, and counters,
RLS, locks, photo-byte hashing, audit and rollback use real disposable databases. This is not hardware
or vendor-distribution acceptance.

Tests cover identical concurrent consumption, two distinct challenges competing for the same counter,
wrong signatures, changed command/source/photo/installation, failed callback writes, revoked keys,
own-account eligibility, configured metadata and database counter-write veto. The distinct-challenge
test holds the first callback until the second owned connection is observed waiting for the key lock;
only one callback commits. Separate lock-wait cases change eligibility or let a short-lived owned
fixture expire while the request is observably blocked, then require rollback without invoking the
business callback. Fixture lifetimes are seeded directly in the disposable database; production
challenge lifetimes remain unchanged.

Three controlled mutations individually removed the post-lock expiry check, post-lock employment
check and required returned counter row. Each selected test failed because the request proceeded
instead of refusing; restoring exact source returned each case to PASS (one selected, eight skipped
per run). All three harness results were `mutation=1 restored=0 exact=True`. The source has no mutation
diff. These are targeted transaction-safety results, not a full CI or release witness.

The service is an internal transaction seam, with no new migration or API activation. The existing
attendance writer still owns its own transaction and must join this transaction before integration.
Already-consumed means reconcile the business receipt, not reverified replacement proof or accepted
attendance. Historical enrollment metadata and signed source/version claims do not prove the currently
running build or physical presence. Modern metadata/assertion fixtures, registered-device policy,
signed-device runs and full frozen-candidate verification remain required.

The joined attendance carrier at `4002e0e6a` passed all 201 cases across eleven affected database
suites, including eighteen proof/real-writer cases, legacy web/native clocking, registered devices,
geofence containment, corrected days, clock origins, home state and module gates. Root TypeScript
exited 0. The first integration checkpoint `875651a5b` passed 63 of 65 cases and its compiler; two new
assertions incorrectly expected custom Error.name strings from classes that retain the default name.
They now assert the actual error classes. Those original failed observations are retained separately.

The internal signed carrier now uses the real existing attendance writer in the proof transaction.
Concurrent completions return one original actor receipt with one punch and one proof link. It refuses
to upgrade a reference previously accepted through the unsigned carrier, and preserves current photo,
registered-device, geofence, freshness, correction, ordering and abandonment rules. The challenge also
binds the exact registered-device credential digest; a token cannot be substituted after issuance.
This preserves the bearer gate without asserting a hardware relationship between the token and key.
Only key/challenge references, counter and historical proof kind enter the link audit.

The tests force both an actual punch insertion failure and a later integrity-link audit failure.
Both roll back attendance, capture, counter, challenge and their tentative audit; the same original
proof can succeed after the owned fixture failure is removed. The late audit failure explicitly occurs
after the writer returned its tentative receipt. Separate deterministic subject-lock tests observe the
request waiting, then expire its short-lived fixture or remove employment eligibility before release.
The proof owner rechecks eligibility and database expiry after tentative business writes, so this later
wait cannot extend the grant. Production lifetimes are unchanged.

Three controlled integration mutations at `4002e0e6a` each caused the selected case to fail: removing
the new-capture guard returned an unsigned capture as checked, changing the joined writer back to a
separate transaction left a capture committed after integrity-link failure, and removing the credential
digest accepted a substituted registered-device token. Each exact restoration passed (one selected,
seventeen skipped per run); all harness results were `mutation=1 restored=0 exact=True`. The atomicity
failure specifically observed a persisted capture, rather than merely a timeout or unrelated refusal.

Final `8ef714776` passed all nineteen assertion/real-writer cases and root TypeScript. Its added
required-photo case signs a real PNG's exact bytes, changes the caller's original buffer immediately
after completion starts, and still accepts the retained snapshot through the actual decoder. The
stored original-byte digest matches the signed digest, while the stored image is the normalized JPEG.
The ten other suites' unchanged passing regression evidence above remains applicable; this follow-up
does not relabel the original failed attempt or claim a complete gate.

No new migration, public API/configuration loader, native orchestration or deployment was introduced.
Existing public routes still use their established carrier; this local internal integration does not
establish production enforcement or physical presence. Hardware/vendor acceptance, supported-version
rollout policy and complete frozen-candidate verification remain open.

1. iOS release/TestFlight build: initial key attestation online, then generate and persist ordered assertions in airplane mode; reconnect, validate counters/challenges; repeat after force quit, update, reinstall and restore.
2. Both OSes: anchor a native sleep-inclusive clock, sleep for a shift, alter wall time/timezone, kill/relaunch, reboot, and upload out of order. Measure drift and uncertainty; validate bounded expiry and no silent loss.
3. Location: denied/once-only/revoked/approximate permission, services off, indoor uncertainty, stale/future timestamps, Android mock flag, iOS Xcode simulation versus third-party provider, accessory receiver. Record capability/unknown values without assuming a clean device.
4. Android distribution and outage: installed Play build versus internal APK; missing/old Play services, unsupported device, quota exhaustion, Google timeout, invalid hash/package/certificate and repeated token decode. No outage may silently become an “attested” result.
5. Replay and tampering: identical batch retries, altered coordinates/photo digest/time with same request ID, missing/reordered chain element, old permit, replaced device, revoked key, employment/account/tenant change. One claim must produce at most one authoritative punch and a stable receipt.
6. On-site corroboration: signed rotating QR can add evidence but screenshots/relay remain possible. Test replay/expiry and define whether policy accepts that residual risk. Never call a QR or device attestation alone proof of presence.

**Recommendation:** preserve separate recorded evidence, deterministic integrity assessment, attendance acceptance, and human exception resolution. An unavailable platform check is not a failed employee action and must not silently erase the attempt.
