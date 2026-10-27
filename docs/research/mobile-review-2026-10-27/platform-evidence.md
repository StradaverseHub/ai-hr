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

HTTP assembly checkpoint `afb1a6e4f` passed 28 database cases across the new HTTP handlers and signed
writer, plus root TypeScript. At `32c611dc0`, the carrier moved into the attendance pack and the adapter
used its facade; those suites plus the unchanged import guard passed 30 cases and root TypeScript.
No import-ratchet allowlist exception was introduced. Review then isolated the optional stack behind
the pack's narrow `mobile-integrity` facade so ordinary attendance imports do not load vendor crypto.

At `01c5f2a72`, five affected suites passed all 66 cases: real HTTP wrapper/DB behavior, signed writer,
vendor import isolation, pack boundaries and established native journeys. Root TypeScript exited 0.
The isolation fixtures make both optional Apple owners throw if evaluated; the ordinary attendance
facade and current v1 clock handler still load. No filesystem route was registered for the new protocol.

At `a97b647a8`, all thirteen affected HTTP cases and three portable contract cases passed, with root
TypeScript exiting 0. The HTTP tests inject only bearer resolution and the trusted configuration read;
clock keys are seeded through a synthetic vendor enrollment port, then checked with real signatures
and the actual attendance writer/RLS. The default enrollment verifier rejects malformed vendor proof.
This is not a positive hardware/vendor HTTP enrollment or signed-device acceptance witness.

Coverage includes explicit own-employment selection before configuration, peer/admin refusal, forbidden
client authority, deployment origin despite forged Host/app headers, bounded JSON/multipart and canonical
base64, malformed proof without consumption/fallback, concurrent stable receipts, key inventory/revoke
during configuration outage, revoked bearer refusal, invalid configuration, shared issuance capacity and
retained-reference recovery. Expected refusals produce closed codes without raw error logs. Typed poor
accuracy remains distinct. Configuration timeout, caller abort and cooperative read rejection abort the
read and ignore late completion without issuing a challenge or punch. Response compatibility fixtures
discard private/additive envelope fields and accept bounded future discovery names, while unknown
outcomes, codes, versions and client authority still refuse.

The handler factory requires a trusted company/deployment configuration owner; none is selected from
request data. A new rollout policy, supported older-carrier behavior and human exception path must be
owned before route registration. This work adds no migration, feature environment flag, mandatory
hardware policy, native flow or deployment; it preserves existing v1 responses and receipt recovery.

Controlled HTTP mutations at `a97b647a8` independently removed the own-subject pre-configuration guard
and canonical base64 comparison. Each selected HTTP test failed, then passed after exact restoration
(one selected, twelve skipped). The scope mutation specifically reached the trusted configuration port
for a peer before the deeper service refused it. A third mutation re-exported the optional vendor stack
through the ordinary attendance facade; both legacy import-isolation cases failed by evaluating the
deliberately unavailable Apple owner, then both passed after restoration. All three harness results
were `mutation=1 restored=0 exact=True`; no mutation diff remains. These are targeted boundary checks,
not an official full gate, route activation or deployment witness.

Native Apple proof recovery began at `4eaf465e4`: the actual Swift cache helper compiled on the host
against Foundation/Security/CryptoKit and passed ten model scenarios with injected in-memory
persistence/vendor ports. No real Keychain or DeviceCheck operation occurred. The existing ten bridge
cases and native TypeScript also passed. Expanded `6846da278` passed thirteen Swift scenarios,
fourteen JavaScript bridge cases, native TypeScript and syntax parsing of the module plus helper.
Actual Android `:aihr-integrity:compileDebugKotlin` passed in 39 seconds after adding the explicit
unsupported method; root TypeScript exited 0. The previous dependency lint failure remains unresolved
and is not relabelled by this compile result.

Scenarios cover durable intent before the vendor call, commit before reply, cached/restarted proof
recovery, delayed native completion after the JS operation stops, explicit same-key/hash outage retry,
unknown/interrupted calls without retry, failed/ambiguous storage replies, retained uncommitted bytes,
bounded artifacts/capacity, corrupt/cross-key records, duplicate callback generations and eight truly
concurrent callers with one vendor invocation. Bridge cases preserve all four recovery states without
verification, reject malformed/oversized/noncanonical proof records, distinguish binding/recovery
errors, handle an older binary's missing method and reject an artifact delivered to an obsolete actor.

Four controlled native mutations at `6846da278` individually removed the intent commit, artifact commit,
hash binding and interrupted-call refusal. Each mutated Swift source still compiled, its model run
failed, and exact restoration compiled and passed. All four harness results recorded
`compile=0 mutation=1 restored_compile=0 restored=0 exact=True`. The checks fail on those specific
state/persistence invariants, rather than an unrelated compiler error.

The expanded boundary probe at `9c9b30a60` then found a real failure: a valid 64 KiB artifact with
slash-heavy base64 and maximum escaped key metadata exceeded the record cap under default JSON slash
escaping. Compilation passed but the model failed with storageUnavailable. Repair `9c0f41808` disables
slash escaping without raising the cap. All thirteen scenarios, including worst-case bytes, then
passed, and combined iOS source parsing passed. The original failed probe/log remains separate.

The implementation uses a dedicated non-synchronizing, unlocked/device-only Keychain service, capped
at sixteen persisted records and four active/uncommitted operations, without silent eviction or key
replacement. These are configured native mechanisms, not device-tested guarantees. The encrypted
enrollment journal, installation reset, receipt reconciliation/cleanup and iOS signed-framework/device
acceptance remain unfinished. A crash before the artifact is stored remains explicitly uncertain;
no retry or attendance acceptance is inferred. No public route, UI enrollment flow or deployment was
enabled by this dependency work.

Encrypted enrollment journal work at `542d27834` initially failed native TypeScript because mutable
phase references lost narrowing across async closures. `84daf45c2` connected encrypted native storage
and passed 52 cases, but both compilers still rejected inferred loop-local types. Explicit immutable
phase/hash/key references repaired the inference without relaxing strictness. At `eb48c5eb7`, all 54
cases across enrollment, native adapter, existing submission journal and integrity bridge passed;
both native and root TypeScript exited 0. The failed compiler observations remain separate.

The model preserves the original intent, validates server scope/hash/alias, commits irreversible stages,
recovers native key/proof references without replacement, and reconciles stable server receipts before
resending exact saved evidence. Shared scope queues serialize multiple instances and re-read actual
commit state after interrupted writes. Tests cover phase-write failures, native uncertainties/outages,
changed nonce/context, unavailable versus missing key storage, unsupported binary/build, lost server
replies, revoked receipts, wrong actor/employment/receipt and obsolete operation ownership.

The shipped native adapter shares the established device-only AES-GCM master, with distinct enrollment
AAD/paths/pointers and a 128 KiB slot bound. Its VM filesystem/Keychain/Expo ports use real AES-GCM in
the fixture. Encryption/restart/tamper/transplant, missing pointer/slot and master-generation install
identity tests passed alongside the unchanged clock/leave cases. Enrollment refuses existing orphan
slots with no pointer; it cannot silently recreate the enrollment. This is not OS Keychain or power-loss
acceptance. Native alias/proof Keychain cleanup/reset remains separate unfinished work.

Four controlled mutations at `eb48c5eb7` removed the durable key-intent write, prepared hash/alias check,
uncertain-attestation refusal and enrollment orphan-pointer protection. Each selected test failed and
exact restoration passed (one selected, eleven skipped per run). All harness results were
`mutation=1 restored=0 exact=True`. Missing guards caused premature progression or an empty state where
the original operation needed preservation; the failures were not unrelated schema or environment errors.

Both Hermes exports passed at `eb48c5eb7`, with 1,332 iOS and 1,463 Android source-map entries. The maps
include the enrollment journal, native adapter and shared enrollment/integrity contracts, and contain no
server core/database/session, private mobile API handlers/verifiers, PKI packages or nested Zod 3. The
initial map checker expected mobile-prefixed paths; inspection found Metro's actual `/lib/...` names.
The corrected exact-name checker passed all required inclusions and exclusions. Exports themselves
passed on the original attempt; these are local bundles, not signed-device or store evidence.

At `28695da9b`, all 56 affected cases and root TypeScript passed after adding a full 64 KiB encrypted
proof and ambiguous SecureStore acknowledgement case. The stored proof exceeds the old 64 KiB metadata
bound, survives restart, resends byte-identically, and is removed from the JS snapshot only after its
receipt commits. At `9460253e1`, all thirteen enrollment-model cases and root TypeScript passed with an
additional failed-receipt-commit case: pending proof survives server acceptance and resolves from the
owned catalog during a configuration outage without another attestation or completion request. Those
last commits change tests only; the passing native compiler/export and other consumer evidence remains
applicable. No migration, filesystem API route, enrollment screen, live transport or deployment was added.

1. iOS release/TestFlight build: initial key attestation online, then generate and persist ordered assertions in airplane mode; reconnect, validate counters/challenges; repeat after force quit, update, reinstall and restore.
2. Both OSes: anchor a native sleep-inclusive clock, sleep for a shift, alter wall time/timezone, kill/relaunch, reboot, and upload out of order. Measure drift and uncertainty; validate bounded expiry and no silent loss.
3. Location: denied/once-only/revoked/approximate permission, services off, indoor uncertainty, stale/future timestamps, Android mock flag, iOS Xcode simulation versus third-party provider, accessory receiver. Record capability/unknown values without assuming a clean device.
4. Android distribution and outage: installed Play build versus internal APK; missing/old Play services, unsupported device, quota exhaustion, Google timeout, invalid hash/package/certificate and repeated token decode. No outage may silently become an “attested” result.
5. Replay and tampering: identical batch retries, altered coordinates/photo digest/time with same request ID, missing/reordered chain element, old permit, replaced device, revoked key, employment/account/tenant change. One claim must produce at most one authoritative punch and a stable receipt.
6. On-site corroboration: signed rotating QR can add evidence but screenshots/relay remain possible. Test replay/expiry and define whether policy accepts that residual risk. Never call a QR or device attestation alone proof of presence.

**Recommendation:** preserve separate recorded evidence, deterministic integrity assessment, attendance acceptance, and human exception resolution. An unavailable platform check is not a failed employee action and must not silently erase the attempt.


Receipt-bound native cleanup at `38d8a65f0`, tightened at `56434a99a`, passed 55 focused client cases
and 54 server enrollment/challenge/assertion/HTTP cases. Both root and native TypeScript exited 0.
Seventeen host Swift scenarios passed and combined module/helper syntax parsing exited 0. The native
proof cache replaces completed bytes with a released tombstone only after durable receipt recovery;
uncertain/in-flight work remains protected. Receipt binding independently hashes the challenge and
SDK key reference, so a matching challenge cannot release proof for another native key. Fixed-length
references and proof schemas reject trailing newlines. These are model/compiler results; no real
DeviceCheck, OS Keychain or signed-iOS acceptance is claimed.

The verified first-install owner now waits for native alias/proof cleanup before clearing the AES
master, journals and installation marker transition. Failed/malformed native acknowledgements preserve
the pending bootstrap and encrypted files for retry. An optional missing/older bridge remains usable
for established app initialization; it cannot initiate the new enrollment protocol. Ordinary logout
preserves pending records. Released tombstones still occupy the bounded sixteen-record cache; this
change does not establish voluntary retirement, backend revocation or deletion of the SDK private key.
Reinstall through an older binary followed by upgrade remains a device/retirement acceptance case.

With the human's explicit credential-access approval, a read-only staging query on 27 October 2026
returned `count=498`, `max(created_at)=1792997586564`. The query sourced only the existing server-side
configuration and displayed no credential. It changed no schema/data/configuration. This is a watermark
observation, not a live-baseline migration rehearsal or authorization to apply the provisional migrations.


At the same runtime source `56434a99a`, actual Android `:aihr-integrity:compileDebugKotlin` exited 0
in 39 seconds. Both local Hermes exports exited 0. Their source maps contained 1,334 iOS and 1,465
Android entries, including enrollment, storage, bridge, native module and portable contracts; no
application server core/database/session module, private API verifier, PKI dependency or Zod 3 appeared.
The initial checker incorrectly matched dependency directories containing `/core/` and the mobile
`session.tsx`/`session-state.ts`; inspection corrected it to the application server paths, then both
maps passed. The exports passed initially. Android dependency lint's earlier UAST failure remains
unresolved; Kotlin compilation does not relabel it. No full Xcode/signed-iOS build was performed.

Six controlled mutations against checkpoint `adb3e4eac` individually removed receipt-before-cleanup
ordering, receipt-to-native-key binding, failed-bootstrap refusal, released-key replay refusal,
completed-only proof release and active/uncommitted reset refusal. Every mutant failed the intended
behavioral assertion; every exact restored source passed. All three native mutants compiled, excluding
compiler failure as the witness. Results were `mutation=1 restored=0 exact=true` for all six, with
`compile=0 restoredCompile=0` for native cases. Logs preserve the failed and restored attempts separately.
No migration, public API registration, enrollment UI, cloud upload or deployment occurred in this slice.


Explicit native key revocation at `dee30053c` passed 57 affected client cases and both root/native
TypeScript checks. Nine new model cases and one encrypted-adapter case cover durable intent before
transport, failed/lost/ambiguous acknowledgements, explicit retry only, refused/unavailable/malformed
responses, changed receipt binding, pending enrollment refusal, obsolete owners and version compatibility.
The encrypted adapter reopens the pending revocation and retains a separate attendance command unchanged.
A current employment selector authorizes revocation without rewriting original enrollment provenance.
There is still no screen or live transport invoking this model; it does not replace the SDK key or
claim a completed retirement lifecycle.

A separate database probe at `c0bdf712c` reproduced stale subject authorization: revocation waiting on
either the actor advisory lock or key row lock still fulfilled after its selected employment became
ineligible. Both cases failed their refusal expectation (`fulfilled` instead of `rejected`); lock
waiting was observed in `pg_stat_activity` before changing eligibility. Repair `8058d665c` rechecks
own-employment eligibility after both locks. All 42 affected enrollment/assertion/HTTP cases then passed,
including both wait races, and the full root TypeScript compiler exited 0. This addresses stale entry
checks across those waits; it does not assert serializable authorization against every possible
concurrent employment update. No migration or shared database was changed.

Three controlled native-journal mutations removed durable revocation intent, matching receipt checks
and pending-status refusal. Each selected behavioral test failed, then exact restoration passed:
`mutation=1 restored=0 exact=true` for all three. The genuine initial database race failures above are
separate negative evidence for the server repair. All failures/restored observations retain their
original checkpoint attribution.


Both local Hermes exports for runtime source `8058d665c` exited 0. Source maps contain 1,334 iOS and
1,465 Android modules, including the intended enrollment/storage/bridge/native-module contracts and no
application server core/database/session/private verifier, PKI dependency or Zod 3. The unchanged native
Swift/Kotlin mechanisms retain their previous compiler evidence; this slice changes their JavaScript
orchestration only. These are local bundles, not signed-device, cloud/full-gate or deployment evidence.


Key recovery route wiring at `30f62fddd` separated actor-owned inventory/revocation and the common
receipt mapper from optional vendor verification. The source mounts GET `integrity/keys` and POST
`integrity/revoke` through the established mobile wrapper. Five focused suites passed 52 cases:
mounted HTTP behavior, enrollment/key custody, assertion transactions, import isolation and attendance
pack boundaries. Bearer resolution in the mounted HTTP fixture is synthetic; transactions/RLS are real.
The separate existing real bearer resolver suite then passed all 12 cases on disposable databases.

The first root compiler at `30f62fddd` rejected two new route callbacks whose outcome literals had
widened to string. Repair `a94c92798` preserves the two discriminators with `as const`; strictness and
runtime validation were unchanged. That compiler rerun passed. After the stronger wire-byte probe at
`17284ce4e`, the final full root compiler also exited 0. Original failed compiler evidence remains separate.
No mobile runtime source changed here, so the prior native compiler/bundle evidence remains applicable;
this server wiring does not supply signed-device, complete-gate or deployed-release evidence.

Mounted checks cover explicit unique selectors, peer-key refusal without mutation, configuration and
receipt-encryption outage, idempotent revocation, no-store/auth refusal before parsing, extra authority,
false content length, streaming wire bounds and attendance module refusal. Response fields retain the
same nine-field receipt allowlist. Optional-owner poison tests confirm both recovery routes load when
Apple enrollment and assertion owners throw. No enrollment or signed-clock route was mounted.

Three controlled mutations at `17284ce4e` introduced a vendor-owner import, allowed duplicate selectors
and weakened the 256-byte revoke reader to 4 KiB. Each intended test failed and exact restoration passed:
`mutation=1 restored=0 exact=true` for all three. The byte-limit probe uses an otherwise valid command
with excessive JSON whitespace, so schema strictness alone cannot mask a missing streaming cap. These
are local process/database observations; no provider request, cloud build, new migration allocation,
shared database write, publication or deployment occurred.


Mobile key review at `ca0e67f3e` passed 42 initial screen/transport/revocation cases and both root/native
TypeScript checks. Guard/accessibility follow-up `841bc02d3` passed 71 affected cases across key screen,
real API client, local enrollment revocation, existing native attendance journeys and pending submissions;
both strict compilers exited 0. The screen is reachable from Me and protected on direct navigation.
New English/Malay text distinguishes keys from named phones or location proof. Existing machine-drafted
Malay and the remaining four mobile locales still require their planned language acceptance.

The screen tests execute shipped TSX with native view/dialog/session/HTTP ports replaced. Cases cover
no mutation on load, destructive confirmation, duplicate taps, empty/loading/prerequisite/older-server
states, failed reads, uncertain reply/reference retention, explicit status reconciliation, monotonic
known-revoked display, refused/mismatched receipts, unmount and changed employment/account/connection/
language. The shared API fixture exercises actual request construction, bearer/locale headers, omitted
cookies/redirects, response allowlists and the twenty-key bound. No actual OS dialog, vendor or signed
device is exercised by these models. A confirmation or list receipt never creates attendance.

Three mutations at `841bc02d3` sent revocation before confirmation, removed obsolete-confirmation refusal
and accepted a mismatched receipt. Every selected behavioral probe failed; each exact restored source
passed (`mutation=1 restored=0 exact=true`). Both local Hermes exports passed. Maps contain 1,337 iOS
and 1,468 Android sources, including the new screen/helper/API integration, with no application server
core/database/session/private verifier, PKI dependencies or Zod 3. No native Swift/Kotlin source changed.
These exports do not establish real-device layout, accessibility, process-loss or OS-storage acceptance.

The UI skill's initial design search returned an unsuitable landing-page pattern; its narrower
confirmation query matched this flow. The shipped screen reuses established tenant presentation and
native confirmation rather than introducing a competing palette/component dependency. Physical light/
dark, large-text, small/large phone/tablet, screen-reader focus and signed-device walkthrough remain
open. No screenshot or visual-device pass is claimed. No migration allocation, shared database write,
public/cloud publication or staging deployment occurred in this slice.


Rollout review identified a receipt dependency on the twenty-entry display list. At `e977e62ea`, exact
own-key lookup by original challenge replaced that dependency in the native enrollment journal. The
new POST `integrity/key-receipt` is independently mounted through the recovery owner, with a 256-byte
strict selector body, explicit own employment, shared bearer/admission/no-store handling and minimal
nullable receipt contract. It does not load vendor configuration or expose proof/key material.

Four database/API/pack suites passed 35 cases and five native model/storage/client/screen suites passed
80 cases; both root and native TypeScript exited 0. The owned synthetic-history fixture places twenty
newer revoked keys after an accepted revoked key, verifies the old key is absent from the display list,
then recovers that exact receipt with receipt encryption configuration absent. Normal app-role/RLS
reads return null for a peer and another tenant. These seeded historical rows are visibility fixtures,
not vendor validation evidence. HTTP probes cover exact/absent/peer lookup, extra authority, false
content length, actual body cap, revoked bearer and configuration independence without key mutation.

Native cases recover a matching revoked receipt during configuration outage without another enrollment
completion or SDK call. Explicit absent/unavailable/mismatched results retain the old operation; an
uncertain SDK attempt is not repeated. Follow-up `e07144dfa` passed all 28 transport/contract cases
(including the already counted client suite), validating the real request shape and nullable versus
malformed lookup distinction. The final full root TypeScript compiler also exited 0.

Three controlled mutations regressed lookup to bounded display history, weakened the exact endpoint's
reader to 4 KiB and repeated an uncertain attestation after an absent receipt. All selected behavioral
probes failed, then exact restoration passed: `mutation=1 restored=0 exact=true` for each. Both local
Hermes exports exited 0; their 1,337 iOS / 1,468 Android source maps include the intended client/recovery
modules and no application server core/database/session/private verifier, PKI dependency or Zod 3.
No Swift/Kotlin source changed, vendor service was called or device acceptance was established.

The central allocation record was read again and still reserves filename tags0621–0628 to the other
workstream, deferring journal positions/timestamps to source freeze. This slice allocated/renumbered no
migration and changed no shared database. The rollout configuration owner remains unfinished; the exact
receipt dependency was repaired before proceeding with it. No full CI, publication or deployment occurred.


Android KeyDescription work at `101c990df` initially passed 32 of 33 vendor/decoder cases but rejected
a captured legacy boot record with an empty boot-key digest. Its initial compiler also rejected BigInt
literal syntax under the repository target. Repair `cb624428f` preserves empty digest lengths as
unverified facts and uses supported BigInt construction; strict compilation passed. That test rerun
still failed because the test assumed the legacy fixture had a digest list. Upstream explicitly omits
it and reports unlocked/unverified boot. The decoder had preserved the omission correctly; the test
expectation was corrected without manufacturing missing evidence.

At `c6489d69d`, all 44 cases across Android decoding, existing Apple enrollment proof and Play verifier
passed, with strict root TypeScript exit0. Version-field review added refusal of app identity under
schema1 and patch fields before schema3. At `b02b56426`, all 24 Android decoder cases and the full root
compiler passed. Captured v3, remote-provisioning v400 and StrongBox v300 descriptions match independently
published upstream expectations; malformed locked-state and unordered-tag captures refuse. Synthetic
cases exercise supported versions, DER canonicality/truncation/nesting/node bounds, app identity sets,
unsigned64 app versions and absent versus unverified facts. None validates a certificate chain.

Nine upstream public artifacts are pinned to34652d3df68b8d6887a6670b00eb0856090dae6d, with exact decoded
Git-blob bytes verified before commit. Five PEM files were explicitly tracked after verifying their
blocks contain only public CERTIFICATE material; the repository generally ignores PEM. The accompanying
Apache license and SHA256/Gitblob manifest are retained. These fixture roots/challenges are not deployment
trust configuration. Three controlled mutations removed authorization ordering, raised the node budget
and leaked boot identifier bytes. Each selected behavioral test failed and exact restoration passed:
`mutation=1 restored=0 exact=true`. The version-field follow-up is covered by its final dedicated run.

The human-authorized migration report was sent to coordinator chat01a16cee-9004-72c2-aaf0-932d4d0a1582
with actual four tags/indices/timestamps/hashes and persistent-apply status. Mobile accepted proposed
replacement0633/0634/0635 names in principle, pending confirmation and final coordinated journal
allocation. No migration name or applied SQL was changed. All Mobile additions remain unapplied to
staging; the latest read-only watermark remains498 at1792997586564. No active job depends on filenames.
This Android slice changes server-only decoder/test/docs; no mobile export, cloud build, shared DB
write, publication or deployment occurred. Android chain/revocation/custody and rollout remain unfinished.


Android revocation observation at `522ef50d1` initially passed50of51 focused cases; the one failure
reused an already-consumed synthetic Response on the second invocation. The initial compiler also
rejected an inferred optional-header union in the fixture. Repair `ad4cc7988` creates a fresh response
stream per invocation and gives the fixture an explicit string-header map. No production refusal
was weakened. All51 cases across revocation, Android description and Play verifier then passed, and
the strict root TypeScript compiler exited0. Original failed test/compiler logs remain separate.

Sixteen revocation cases cover the fixed credential-free URL/request, every supplied path serial,
revoked/suspended precedence, no expired-entry override, absence versus provider failure, changed
statuses without cache reuse, canonical serial/input limits, stale/future/missing Date/Age metadata,
body elapsed time, caller-input mutation, duplicate escaped JSON keys, closed schema/date bounds,
actual bytes despite false Content-Length, redirect/304/403/429/500 refusal without retry, transport/
body deadlines, cancellation, late success and backwards server time. These are synthetic HTTP
observations; web research read the public endpoint separately and is not a runtime verification pass.

Three controlled mutations removed checks for later path serials, duplicate members and freshness
limits. Each selected behavioral probe failed, exact restoration passed and source bytes matched:
`mutation=1 restored=0 exact=true` for all three. No mobile runtime source, native compiler/export,
migration, shared database, cloud publication or deployment changed in this slice. The reader is not
yet connected to Android chain/custody/attendance verification; complete Android integrity remains open.

Coordinator supplied definitive unapplied allocation: Board616–617, AI618–629, Mobile630–633. Mobile
rows retain timestamps1793039596595/1793047796775/1793054626620/1793055753390 with final tags0613/0633/0634/0635.
The private allocation manifest SHA256703407b13d5170c9aafdd16b97528ec3dd32389caa85a71a44b65fa4c17523f0
and all four bound Mobile SQL hashes were independently verified. Acknowledgement was sent under the
human's coordination authorization. Current provisional journal/names remain unchanged until a complete
ordered integration includes Board+AI prerequisites and actual canonical prefix. No higher timestamp
may ship independently and no staging application was requested. Historical candidates remain intact.


Android signed-path assembly `bc3d786c5` captured the two public Google root certificates from the
fixed official endpoint and bound DER/SPKI pins in `android-attestation-roots.json`. The factory SPKI
pin isfeb2ea7551ee316ed4bb443c8293b884dbfdea40b603ee3e4f4a897e4580fbae; rotated root SPKI
is3ee44512a1af2beb39c889490c60ea3f82e43f5d5a5532f5ab9419f676cd07ec. This retrieval is trust-source
capture, not an attestation result. Pinned official Kotlin verifier path/validator sources were read
to distinguish factory expiration from mandatory RKP issuer validity and target-device dates.

The initial run passed42of50 cases but eight captured-path cases stopped at the expected-challenge
length check: official fixtures use bounded non32-byte challenge formats. Strict compilation passed.
Repair `d75d87a2d` permits exact server-owned1–128-byte challenges at the generic signature boundary,
without modifying captured signatures or the future native enrollment's32-byte protocol requirement.
The captured path suite then passed. Expanded `6c5d08c81` passed all63 cases across path/decoder/status/
Apple enrollment proof and the full strict root TypeScript compiler exited0. Captured path signatures,
key hashes, ASN1 and PKI validation are real; status responses are synthetic and clearly separate.

Tests cover rotated-root StrongBox/RKP historical positives, factory expiry exception with unverified
boot facts preserved, expired/future RKP issuer refusal, not-yet-valid factory refusal, changed SPKI/
challenge, signature mutation, substituted/reversed/duplicate/trailing-byte paths, input bounds,
revoked/suspended/incomplete status, cancelled/future/stale observations, expiry during delayed status
and copies of caller buffers. Malformed upstream extensions refuse. No runtime Google status request,
Android enrollment/key custody or attendance acceptance is established by these tests.

Three controlled mutations removed challenge binding, RKP expiry checks and published revocation
refusal. Every intended behavioral test failed and exact restoration passed:
`mutation=1 restored=0 exact=true` for each. There was no source/type failure masquerading as that
behavioral witness. No mobile runtime/native source changed, so no new device build/export is claimed.
Profiles without a common historical structural-check instant or outside the captured4/5-cert shapes
remain unsupported. This is not a claim of full Kotlin-verifier compatibility or completed Android
integrity. App policy, custody, protocol wiring and device/distribution acceptance remain unfinished.
No migration, shared database, publication, cloud build or deployment changed in this slice.


Android app/key policy at `ae49e37b3` initially passed50of62 affected cases; twelve captured path/policy
cases refused because older signed provisioning maps omit the newer documented entity field. Strict
compilation passed. The actual maps were inspected: legacy issuer info includes issued-count and old
optional keys but no entity/lost-device metadata. Repair `af0fc4660` preserves missing known fields as
unavailable, validates present known fields and cross-checks the signed issuer level. All63 cases then
passed; the compiler caught a mixed-value Map inference in the new fixture, which was repaired with an
explicit type. No certificate signature, expected app identity or refusal policy was bypassed.

At `42fc289c2`, all64 cases across policy/path/description/status and the strict root compiler passed.
Real captured StrongBox key evidence is matched only to its actual upstream collector app/build/signer;
changing expectations to the AI HR app refuses. Synthetic policy mutations test software/shared-UID/
wrong signer/build/curve/origin/purpose/digest/boot/patch states without claiming hardware provenance.
Composed positive tests use actual captured signatures and synthetic revocation, not current Google
status or a signed AI HR installation. Pure lost-device/issuer-signal tests separately witness those
policy guards. Caller changes cannot mutate the verifier's parsed settings during an async operation.

Three controlled mutations removed signer allowlisting, locked-boot enforcement and lost-device
refusal; every selected behavioral test failed and exact restoration passed:
`mutation=1 restored=0 exact=true`. Explicit metadata policy follow-up `d05e8139b` then passed25
policy/path cases, including legacy-unavailable versus required-modern metadata refusal. The final
strict root TypeScript compiler exited0. No mobile runtime/native build, migration, shared
DB, vendor call, public/cloud publication or deployment changed. Android custody, challenge protocol,
Play composition, rollout and actual device/distribution acceptance remain open.


Coordinated migration source integration at `cd9833e89` independently refreshed published alpha and
confirmed9541b1686d7941f89e564723271e48bf85a21a89. All501 prefix journal entries and501 canonical SQL
files matched exactly. The18 addition hashes were checked against the coordinator's pinned manifest:
Board616–617, AI618–629, Mobile630–633. The actual Board source ref and AI frozen96c2 draft blobs matched
the bound hashes before copying. All original SQL bytes/timestamps were preserved. Only unapplied
Mobile0621/22/23 names changed to0633/34/35;0613 remained. Ordinary descendant commits preserve earlier
candidates; no historical proof was relabelled for the new519-entry tree.

The complete source chain migrated into disposable local template/worker databases. All62 cases across
journal ordering, budgets, Mobile enrollment/challenge/HTTP transactions passed. This is fresh-development
installation evidence, not populated staging upgrade proof. No shared DB/schema/ledger was altered.
A separate frozen allocation witness at79b607ced initially failed on an extra parenthesis in its new
assertion; compiler syntax checks failed too. Repair `a1346f9c4` changed only that syntax, retaining all
expected hashes. All8 allocation/journal guard cases and strict root compilation then passed. The
source manifest/prefix/order/SQL-body witness is now independently retained in test fixtures.

Coordinator was notified under human-authorized routine coordination. It explicitly reiterated that
this519-row SQL overlay is NOT deployable without actual paired Board+AI application ancestry and
semantic verification. Mobile acknowledged that boundary. Board0602 affects existing payroll history
visibility and needs its runtime reader/writer/schema/facade/import companions;0603 needs its Letters
and private-agent capability companions. No full feature/gate evidence for those workstreams is
inherited by copying SQL. No canonical ref advance, staging application, publication or deployment
occurred. Further Mobile implementation continues locally against this development overlay until the
paired integration and complete required verification can be established.


Android online command signatures at `84db503ee` passed30 focused cases across the new checker,
Android key policy and existing Apple assertions, with strict root TypeScript exit0. Tests use real
synthetic P256 signatures to bind scope, key ID, challenge, request/action/coordinates/uncertainty/time,
photo bytes metadata and original source flags. Unsupported platform/app/build/configuration, wrong
keys, private/RSA/other-curve keys, noncanonical DER, scalar bounds, truncated/trailing/P1363 input and
caller authority fail. Double-hashed signing fails; UUID case/property order canonicalization passes.
Signature checks intentionally do not enforce receipt/counter/time/physical-presence semantics.

A temporary Java source-file generator then ran under shared locks with the Android Studio bundled
OpenJDK. It generated a P256 pair in process, signed independently encoded canonical UTF8 using
`Signature.getInstance("SHA256withECDSA")`, and wrote public SPKI/signature only. Fixture
`android-jca-clock-signature.json` records the independent message, public vector and generator hash;
no private key was written. At `03c0aa9e2`, the test verifies the actual JCA signature with the shipped
server owner. Follow-up `7bba3e936` derives the distinct mathematically valid alternate ECDSA signature
and verifies both map to the same canonical command digest. This demonstrates why signature-byte
identity cannot own idempotency. It does not establish real Keystore signing or Android hardware custody.

The final32 affected cases and strict full root compiler passed. Three controlled mutations removed
signature enforcement, platform restriction and positional native encoding. Each intended behavioral
probe failed and exact restoration passed: `mutation=1 restored=0 exact=true`. No native/mobile
runtime source changed; no fresh bundle/device result is claimed. No migration, shared database,
vendor service, cloud/public publication or deployment changed. Android key custody/transactional
challenge consumption and native attendance wiring remain unfinished.


Native Android canonical signing adapter `564497b23` passed all38 affected cases across the new adapter,
server signatures, existing bridge and canonical binding, plus both strict native/root TypeScript
compilers. A VM executes the actual adapter with native/foreground/ownership ports, the actual bridge
validates its bounded artifact/deadline, a synthetic P256 signer signs the exact decoded bytes, and the
real server primitive verifies the result. Independent Java-vector canonical text matches the bytes
passed to the bridge. Non-ASCII native app-version UTF8 also matches server encoding without hashing
or normalizing away command facts.

Cases refuse changed native app/version/build/platform, malformed authority, invalid alias, wrong
platform capability, background before/after signing, obsolete owner on native success/failure,
invalid-key/malformed/timeout results and automatic retry. No key is generated/replaced or uploaded.
The module remains an internal adapter, not a wired attendance-screen/API flow. No Android SDK was
called; the synthetic signer and VM foreground predicates do not establish physical-device behavior.
No mobile export is claimed because the new adapter has no runtime caller in the shipped route graph.

Three controlled mutations removed foreground refusal, capability identity binding and canonical
positional encoding. Every intended behavioral probe failed, exact restoration passed and bytes
matched: `mutation=1 restored=0 exact=true`. A routine coordination request was sent for an additional
future Android-custody migration allocation; no tag/index/timestamp was guessed and existing0635 SQL
was not edited. The519-row overlay remains development-only pending paired Board+AI runtime ancestry.
No migration, shared database, vendor service, cloud/public publication or deployment changed here.


## Android enrollment binding verification — 27 October 2026

Source checkpoint88c473a09 introduced the portable context, shared policy schema, Expo digest port
and database challenge owner. The first run passed four byte/port cases and four database cases but
failed its fifth database assertion: the existing RequestBudgetExceeded class has Error.name, not a
custom name. Repair71e76dc0f checks the class. The five database cases subsequently passed. The policy
consumer regression and root TypeScript then exposed missing month/day references from the schema
extraction; those four policy failures and three compiler diagnostics remain failed attempts.
Repaire1e712cac reuses the shared field validators. All12 policy cases and root TypeScript passed
following that repair. Native TypeScript passed during the preceding complete-set run. Combined
valid coverage is21 cases (4 byte/port,5 database,12 policy), not a full release gate.

Two controlled mutations omitted the canonical package and the stored configuration binding,
respectively. Both intended behavioral probes failed, exact source restoration passed and source
bytes matched: mutation=1 restored=0 exact=True. Logs are the local /tmp/mobile-android-binding-*
and /tmp/mobile-android-policy-* artifacts. These tests use synthetic cryptography/Expo ports and a
disposable fresh database, not Android hardware, a vendor acceptance call or a live schema upgrade.

Coordinator reserved0636_mobile_android_key_custody and journalidx634 exclusively; final when is
deferred until actual SQL/dependency freeze. The hold was acknowledged. No SQL or journal entry was
created from that reservation, no0635 bytes changed, and no shared/staging application or deployment
occurred. Paired Board/AI runtime integration remains a release prerequisite for the519-row overlay.


## Android custody migration rehearsal — 27 October 2026

Draft8577e3188 adds reserved0636_mobile_android_key_custody.sql without a journal entry. Frozen SQL
SHA256 is9063b27c0cc316b715d552561d636ffc6412e447ca9275758bf497870c995df7. The0635 predecessor
retains60128ba64bd368a532b5cff0593727c0301a4ef2d41043344f82c5ada7b46e7c. Coordinator received
the hash/dependency report; final when remains pending. No timestamp was guessed.

Three transactional migration cases and root TypeScript passed at8577e3188. Test strengthening at
e1a667976 pins insert refusals to PostgreSQL check violations and compares policies/indexes/triggers,
in addition to RLS flags and ACLs. Removing the entire paired platform-evidence constraint made all
three intended probes fail because invalid writes resolved; exact SQL restoration passed all three.
Result: mutation=1 restored=0 exact=True. Logs: /tmp/mobile-android-custody-draft.log,
/tmp/mobile-android-custody-draft-ts.log, /tmp/mobile-android-custody-mutation.log and
/tmp/mobile-android-custody-restored.log. Tests apply the draft only inside intentionally rolled-back
transactions in disposable worker databases. They establish local constraint behavior, not populated
live upgrade acceptance, app-role enrollment, Android hardware proof or release readiness. No journal,
shared database, staging schema, publication or deployment changed.
