# Separate native integrity primitives from verified attendance

This refines ADR-0088's platform assumptions using the [platform evidence](../research/mobile-review-2026-10-27/platform-evidence.md).
It does not activate a trust tier, change attendance policy or enable offline acceptance.

The local Expo module owns platform key operations and platform artifacts. A bounded JavaScript
boundary validates their representation and reports `not_verified`. The future server verifier owns
certificate and token validation, app/environment identity, actor/employment/installation binding,
fresh challenges or permits, assertion counters and revocation. The attendance kernel continues to
own punch acceptance. Neither a reported hardware level nor a false mock-location flag proves presence.

There is no extractable JavaScript signing fallback. Missing capability, provider outage, malformed
evidence and obsolete operation ownership remain different outcomes. Account changes invalidate an
operation even if a native callback succeeds later. A deadline does not cancel platform key creation
and must not trigger automatic replacement. Apple identifiers are committed to device-only Keychain
storage before delivery to JavaScript; Android refuses an existing alias. Enrollment must persist its
scope and challenge before key creation. Apple's server-unavailable retry retains the same key and
the same client data hash. Persistence, reinstall and process-kill boundaries still require devices.

Raw clock snapshots stay app-local. Apple's required-reason rules permit elapsed app-event durations,
not exporting raw uptime or boot information. Keep exact nanoseconds as decimal strings and derive an
interval using bracketed readings; do not lose precision through JavaScript numbers. The interval is
unverified evidence, not an accepted timestamp. Wall-clock changes do not establish continuity.
iOS has no boot UUID in this implementation: compare events within one process, and return unknown
after restart. Android may compare a locally available boot counter. Reboot, conflicting markers,
counter discontinuity or missing continuity requires an explicit unknown result.

M04 server verification, native location-source metadata, signed-device acceptance and M05 permit and
adjudication protocols remain required. App Attest assertions can be generated locally, but this does
not make initial attestation or Google verification offline, nor prove the actual device acceptance
matrix. Compilation, syntax checks and port tests establish narrower facts than hardware verification.

Online command binding uses `lib/mobile-clock-integrity.ts` for one versioned positional UTF-8
encoding on both platforms and the server. It covers deployment origin and installation identity,
tenant, actor, employment and enrolled key; the stored challenge ID, nonce and expiry; request ID,
direction, location, accuracy, sampled time and exact attachment digest/length/MIME; and reported app
identity/version and original location-source signals. UUID case is normalized. Missing source signals
stay null, distinct from false. Raw clock snapshots are not fields of this protocol. The attachment
digest covers transmitted bytes before image normalization, matching the existing photo owner's digest.

Hashing is not verification. The future challenge owner must persist an installation identity separately
from the public workplace setup label, generate random one-use challenges, and bind them to authenticated
scope and an enrolled key. The server reconstructs those fields from its records and deployment config,
compares the exact submitted command/attachment, verifies the vendor proof, and atomically consumes the
challenge/counter with the attendance result. An input object cannot establish its own actor, freshness,
key ownership or installation. The new helpers are protocol primitives only; existing v1 clock routes
and live attendance do not yet accept or trust this evidence. Offline permits require a distinct purpose
and protocol, rather than extending the online challenge's lifetime.

The server assertion primitive uses a pinned CBOR decoder with an 8 KiB input cap, finite nesting,
duplicate-key and trailing-byte refusal, exact map/byte fields and disabled semantic conversions.
It checks the supported 37-byte iOS authenticator header, deployment-owned App ID hash, a strictly
increasing unsigned 32-bit counter, and the P-256 DER signature for Apple's nonce construction.
It returns only a proposed next counter. Its public key must already have passed attestation verification;
the caller must reconstruct client data and atomically consume the stored challenge/update the counter
with the result. The helper is server-only and is not wired into v1 routes. Public interoperability
fixtures establish compatibility with that sample, not hardware origin or a verified enrollment.
Unknown authenticator extensions currently require explicit support rather than unparsed acceptance.

Enrollment key proofs use a code-pinned Apple root and maintained bounded ASN.1/PKI parsers. They check
ordered certificate signatures and a PKIX path at server time, P-256 public-key identity, certificate
nonce, app/environment, zero initial counter, credential ID and matching COSE coordinates. A key proof
is distinct from metadata-complete enrollment: legacy proofs retain unavailable distribution/build
metadata, and the strict enrollment check refuses that state. Neither helper assigns a trust tier,
persists ownership, consumes a challenge or verifies the separate fraud receipt/current revocation.
The PKI/ASN.1 v4 dependencies require Node 20.19+ or 22.12+; actual release runtime compatibility must
be verified before rollout. No public API route currently imports this enrollment primitive.

The current Apple validation-guide sample is not a complete positive protocol witness: its certificate
nonce matches raw example-challenge bytes, while the documented algorithm and our native bridge use a
32-byte challenge hash. Keep that sample as a refusal case; never try alternate hash constructions to
pass it. The captured production/development fixtures validate key proofs at their historical issuance
times and lack modern metadata. Metadata-complete positive acceptance still needs a valid signed sample
from the supported device/build population. Missing evidence cannot become verified by fixture editing.

The Play standard-token boundary sends an opaque token only to Google's fixed HTTPS decode endpoint,
using a deployment-owned scoped access-token provider. It never accepts a phone-supplied decoded JSON
verdict. A single deadline covers credential acquisition, response headers and a bounded response body;
redirects and automatic retries are disabled. A late credential result cannot start a decode after timeout.
The server compares the canonical command hash, challenge window, request/package identity, all signer
digests and the allowed/claimed version before retaining vendor signals. Token time must fall after
server challenge issuance, before expiry, and no more than 30 seconds ahead of the checked server time.
This bounded online check does not authenticate an earlier offline location or claimed device wall time.

Recognition, licensing and device labels stay separate facts. Unknown labels grant no known assurance;
cleared/unevaluated verdicts remain unavailable. A decoded verdict alone establishes neither Keystore
private-key possession nor actor/employment ownership, and does not accept attendance. The future owner
must reconcile receipts before decoding again and persist command/challenge outcomes atomically: Google
may have consumed a token when a response is lost. No credentials are loaded and no endpoint is activated
by the primitive itself. Live service-account/project/distribution acceptance remains required.

## Recovering one-use Apple enrollment artifacts

The native Apple owner now records an immutable key/client-data-hash intent before invoking DeviceCheck.
It commits a successful artifact before resolving JavaScript, through a dedicated unlocked/device-only,
non-synchronizing Keychain service. Repeating the same completed key/hash reads those original bytes
without another vendor operation. A different hash for an existing key refuses. An interrupted or
unknown operation remains requested; it cannot silently become another attestation attempt. Only an
explicitly recognized `DCError.serverUnavailable` result records retryable state for a later explicit
same-key/same-hash call.

An artifact returned by DeviceCheck but not yet stored remains with the bounded live native owner.
Recovery reads first retry that storage commit. A lost storage reply can recover a committed artifact
after restart; an actual crash before artifact persistence remains uncertain. These states are reported
separately from absent, retryable and completed. Operation-generation tokens prevent a duplicate old
callback from replacing a newer retry or resolving it twice. The JavaScript bridge validates the
bounded canonical artifact, repeats operation-owner checks and continues to label all evidence
`not_verified`. Missing older-binary methods remain explicitly unsupported.

The mechanism reserves at most four active/uncommitted native operations and admits at most sixteen
persisted cache records. Unresolved evidence is never evicted to admit another key. Records are capped
at 90 KiB, including a permitted 64 KiB artifact and bounded metadata; JSON encoding disables slash
escaping so worst-case valid base64 remains within that cap. The iOS pod source glob includes the new
helper. Android exposes an explicit unsupported recovery method, with no signing fallback.

These records establish local recovery state only. They provide no certificate verification, actor
authorization, attendance acceptance or trusted time. The encrypted journal below adds JavaScript
recovery and server-receipt reconciliation. Receipt-driven cleanup replaces completed proof bytes with a
released binding tombstone; it never makes the key attestable again. Released tombstones still count
toward the sixteen-record bound. This bound is not a retention policy or a completed retirement lifecycle. Full iOS framework/signed-device/OS Keychain and process-loss
acceptance remain required; host model execution does not establish them.

## Encrypted enrollment journal

One journal belongs to the approved connection namespace, API origin, actual login actor and client app
installation UUID. An unresolved enrollment additionally retains its original employment and request.
It cannot be adopted by another employment or overwritten by a newly generated request. A completed
key keeps historical enrollment provenance; it is not a current permission or verified-presence claim.

The owner serializes all instances/generations for that scope in the JavaScript runtime and reads the
committed snapshot afresh for each operation. It persists requested, prepared, key-requested, key-ready,
attestation-requested and proof-ready transitions before their corresponding external operation. It
validates the server context, canonical hash and deterministic alias against current scope before key
generation, refreshes the same immutable context before resuming irreversible work, and refuses changed
nonce/target material. An older native binary without proof recovery and a known unsupported app build
cannot start key generation. Context freshness comes from the server, not the phone's claimed clock.

A key-requested interruption reads the original native alias; a missing reference requires recovery
instead of generating another key. Attestation-requested interruptions read the native cache. Only
recorded retryable state permits an explicit later same-key/hash call. Requested/unknown/absent recovery
state cannot trigger another one-use operation. Known vendor outage, temporary native unavailability,
missing references and unsupported capability remain distinct. Ownership is rechecked around every
await, including failed requests, so obsolete results cannot be adopted by another login/connection.

The exact artifact is committed before first transmission. Before resending it, the owner looks up an
own-key receipt by its original challenge, independently of the bounded display inventory. A matching
receipt, including a revoked one, resolves the journal without another enrollment/configuration request.
An absent result is only a read observation: a concurrent completion may still commit. It never permits
key regeneration or repeating an uncertain one-use attestation. Only the same saved bytes/intent may
be resent to the authoritative enrollment owner. Proof is cleared from this journal only by the durable
receipt transition. A failed local receipt commit retains proof; no automatic replacement or replay occurs.

Storage reuses the existing native AES-GCM master/installation quota, with purpose-separated AAD,
directory and SecureStore pointer. Enrollment slots allow 128 KiB for a full 64 KiB base64 artifact and
bounded context. Missing pointers with existing enrollment slots quarantine the state; they cannot
create an empty enrollment beside an uncertain native key. Missing/corrupt selected slots never fall
back to an older one. The established clock/leave slot format, purpose and bounds remain unchanged.
An app-installation UUID is committed in device-only SecureStore under the master generation; the
existing first-install reset changes that generation and clears these encrypted files.

The server receipt additionally carries an enrollment-specific SHA-256 digest of the canonical tuple
`["aihr.native-key-binding", 1, challengeId, vendorKeyId]`. The native owner checks this against its
retained SDK reference before committing the receipt or releasing native proof bytes. The digest is
scoped to this enrollment; it does not expose the SDK reference or assert physical presence. Key IDs,
hashes and proof encodings reject trailing whitespace rather than normalizing signed material.

Only after the matching receipt commits does the owner request native proof release. Known cleanup
unavailability leaves the committed receipt authoritative and retries cleanup on a later owned read.
Native release accepts only a completed matching key/hash, persists a released tombstone and refuses
in-flight or uncertain work. A released cache without a recoverable server receipt requires recovery;
it cannot initiate another attestation.

Verified first-install bootstrap invokes native alias/proof-service cleanup before replacing the AES
master and encrypted journals. Native cleanup must acknowledge success, or explicitly be unsupported
on an older/missing binary or Android; malformed/failed acknowledgements stop bootstrap before its
installation marker is created. Active or uncommitted native work blocks reset. Partial cleanup is
retryable while bootstrap remains incomplete. Ordinary logout does not invoke this reset. This deletes
local alias/cache metadata, not backend key registrations or the opaque DeviceCheck private key.
An older binary's reinstall followed by an upgrade can leave native state outside this marker's reset;
upgrade/reinstall/device acceptance and an explicit retirement owner are still required before activation.

This connects tested model/native-storage ports, not a UI or live API transport. Voluntary recovery and
retirement controls, authenticated app orchestration, registered-key use, supported route rollout and
real signed-device termination/restore/Keychain acceptance remain release work.


## Explicit key revocation recovery

A registered native journal exposes explicit revocation through the existing actor-owned server key
service. It first commits a version 2 `revocation: requested` snapshot containing the unchanged key
provenance. Until resolved, status is `revocation_pending`; beginning or advancing enrollment cannot
replace it or represent it as an active local key. Reading status does not replay revocation. Older
version 1 snapshots remain readable; older binaries refuse the new pending format rather than silently
interpreting it as empty. Enrollment and revocation continue to share the same serialized scope owner.

An explicit later retry sends only the original key ID to the idempotent server owner, using the
currently selected own employment for authorization. This selector does not rewrite the key's original
enrollment employment. A matching receipt must preserve every immutable enrollment field and carry a
non-null server revocation timestamp. Refused, unavailable, malformed, mismatched or obsolete replies
cannot clear intent. Failed or ambiguous receipt writes re-read the secure pointer on the next owned
operation. Only a durable matching revoked receipt returns the journal to version 1 with revoked
history preserved. No replacement key, SDK private-key deletion or attendance-journal mutation occurs.

The server repeats own-employment eligibility after both its actor advisory lock and key row lock,
before returning an existing receipt or writing revocation. The initial authorization observation may
be stale after either wait. This enforces the existing active-own-employment requirement at that
boundary; it is not a claim that every concurrent employment change is serialized with key services.
UI orchestration, retirement/replacement capacity and signed-device acceptance remain activation work.


## Mounted key recovery boundary

The source tree now mounts `GET /api/mobile/v1/integrity/keys` and
`POST /api/mobile/v1/integrity/revoke`, plus `POST /api/mobile/v1/integrity/key-receipt` for exact
challenge receipt recovery. These authenticated recovery routes expose only the existing
own-key inventory and idempotent revocation service. They use the shared bearer-only route owner,
source/actor admission, no-store responses, private diagnostics and strict bounded request reader.
An explicit, unique own-employment selector is required. Tenant/actor/app-verification authority is
never accepted from a query, header or body. Attendance entitlement and database RLS remain enforced.

Inventory/revocation and their common minimal receipt mapper live in `core/mobile-integrity-key.ts`,
behind the narrow attendance recovery facade. They do not import enrollment/assertion owners or the
optional PKI stack. Neither vendor settings nor vendor-receipt encryption availability is needed to
list or revoke an already registered key. A failed verifier module must not remove that recovery path.
The existing combined integrity handler factory delegates recovery to this same owner; there is no
second revocation writer. Existing enrollment imports retain their compatibility re-exports.

Enrollment and signed-clock handlers remain unmounted. Company presentation configuration is not an
attendance-security policy owner. Configured pilot scope, supported versions/devices, honest fallback
and human exception handling still need their reviewed rollout owner. The two mounted source routes
are not a deployed release, migration application, attestation check or physical-presence guarantee.
No migration filename/index/timestamp was allocated by this wiring change.


## Mobile account key review

Me links to a protected integrity-key screen. It first obtains own employments, requires the selected
employment to remain in that inventory, and reads the bounded actor-owned key list through the shared
mobile API client. A direct signed-out route redirects before mounting private reads. Loading, empty,
refused/unavailable, older-server 404 and retained stale content remain distinct. The screen uses the
existing tenant theme/components and explicit selectable key references; it does not invent phone
names or hardware identity from proof metadata. Destructive controls announce their key reference.

The user confirms a specific reference in the native destructive dialog before a POST. Duplicate taps
share an in-flight owner. Auth generation, connection namespace, language, employment remount and
component lifetime checks stop obsolete confirmations/replies before mutation or side effects. The
shared transport separately rechecks ownership around authentication/refresh and requires foreground
visibility for writes. A success must contain the same immutable key receipt and a real revocation
timestamp; mismatches remain unconfirmed. Known revoked status cannot be undone by retained stale UI.

A lost reply retains the reference on the screen and allows a safe status read or explicit retry of
the same key ID. Opening/reopening the screen performs authenticated reads, never mutation replay.
A fresh server inventory reconciles remote revocation after restart. This account-management screen
can revoke a key from another installation; it does not resume an enrollment, replace a key or mutate
local attendance/enrollment journals. The separate local enrollment owner's durable revocation state
remains for a native key workflow that invokes it. Cached native enrollment receipts never establish
current server authorization; every later signed-clock operation must still check current revocation.

The flow changes key authorization, not existing attendance or the login session. Server revocation
and audit retain their atomic owner. There is no GPS-presence claim, offline approval or completed
SDK-key retirement. Signed-device visual, screen-reader, small/large-screen and lifecycle acceptance,
four additional mobile locales and the complete frozen-candidate release gate remain unfinished.


## Exact receipt lookup during rollout changes

A twenty-entry display bound cannot own enrollment reconciliation. An accepted revoked key may be
older than the entire current display window, while the original encrypted enrollment still needs its
receipt. The exact recovery endpoint accepts only `originChallengeId` in a 256-byte JSON body and an
explicit own-employment query selector. It returns the same minimal receipt or an explicit null under
`key_receipt`. The actor, tenant and active own employment are independently resolved/checked; a peer
or another tenant cannot retrieve the receipt. The existing unique origin-challenge index supplies the
lookup key. No proof upload, caller digest, vendor verifier or rollout configuration is consulted.

The native journal uses this lookup before configuration refresh or irreversible work. Matching still
requires the original challenge/app/environment/proof kind and native key binding; a historical receipt
cannot upgrade assurance or resurrect a revoked key. The exact endpoint is a read of history, not key
enrollment, attendance acceptance or a promise that a null cannot later become a receipt. Older-server,
unavailable and malformed lookup results must preserve pending work rather than become empty state.
The human-facing inventory remains bounded and retains its existing scope and history wording.


## Android key-description boundary

The server-only Android decoder accepts bounded DER contents of the KeyDescription extension, OID
1.3.6.1.4.1.11129.2.1.17. It enforces canonical definite lengths, primitive encodings, integer bounds,
ordered unique authorization tags and SET members, bounded nodes/depth/bytes, known schema/version
pairs and version-specific interpreted fields. App package versions preserve unsigned 64-bit decimal
values. Software and hardware authorization lists remain separate. Absent evidence stays absent;
unlocked/unverified boot or software security levels cannot become hardware assurance by parsing.

Its output is explicitly `verification: not_verified`. It reports presence/lengths rather than device
identifier values, boot keys or boot hashes. Uninterpreted authorization tags retain their numeric IDs
without values; downstream validation must decide whether a combination is acceptable. This decoder
is not a certificate verifier, chain selector, app authorization policy or key enrollment service.

Before use, the chain owner must validate trusted roots, path constraints, validity/expiration rules,
certificate revocation, the correct root-nearest attestation/provisioning extension and the exact
attested public key. It must compare a server-owned scoped challenge and app signing identity, enforce
appropriate key properties and boot/security requirements, then persist unique actor-owned custody.
A caller-selected leaf extension is not authority: a malicious child can append its own extension.
Play Integrity remains separate evidence and does not retroactively verify GPS or key custody.

Primary references: [Android server verification](https://developer.android.com/privacy-and-security/security-key-attestation),
[AOSP schema](https://source.android.com/docs/security/features/keystore/attestation), and the
[official verifier](https://github.com/android/keyattestation). Pinned public certificate/expected-value
fixtures derive from upstream revision34652d3df68b8d6887a6670b00eb0856090dae6d under Apache-2.0, with
exact SHA-256 and Git blob hashes in their provenance manifest. Fixture parsing is not a current
Google-root, revocation or signed-device acceptance witness. Chain verification remains unfinished.


## Android revocation status observation

The server-only revocation reader contacts only Google's fixed HTTPS status endpoint, without app
credentials, certificates, serials or caller-selected URLs in the request. Its input must be canonical
lowercase unpadded hex serials from the server-validated path, bounded to eight distinct twenty-byte
serials. It checks every supplied serial; a published revoked or suspended status refuses regardless
of an entry's expiry annotation. No app/key/attendance acceptance follows from a missing status entry.

The entire request/body has a deadline, with explicit caller cancellation and ignored late completion.
The reader caps actual wire bytes at4MiB and entry inventory at20,000, validates the published closed
schema and rejects duplicate decoded JSON member names, including escaped aliases. Invalid, oversized,
unknown-status and unavailable responses do not become an empty passing list. Expected errors expose
closed reasons, not vendor comments, certificate serials or raw network failures.

There is no cache or automatic retry in this initial owner. Every invocation obtains a new HTTP
observation; no previous passing result survives an outage. Date/Age metadata and elapsed body time
must fit the server-owned maximum observation age (default1hour, configurable up to24hours); future or
backwards time refuses. This bounds the observation's age, not Google's compromise-publication delay.
A production cache/shared fetch owner must preserve those semantics and Google's Cache-Control policy
before activation at scale; this implementation does not claim that per-call fetching is a completed
quota/availability design. Transport success authenticates the fixed HTTPS response only, not its
relation to a validated certificate path. Chain selection, trust roots, expiration exceptions,
app/key-property verification and persistent Android custody remain unfinished.

Sources: [Google status schema and verification guidance](https://developer.android.com/privacy-and-security/security-key-attestation#certificate_revocation_status_list)
and [official status endpoint](https://android.googleapis.com/attestation/status). Tests replace the
HTTPS transport and do not call Google. No endpoint, native SDK or attendance writer invokes this
reader yet.


## Android signed-path assembly

The optional server verifier now composes signed-path checks, the bounded KeyDescription decoder and
current status observation. Google roots were captured from the official root endpoint on27October2026;
their DER and SPKI SHA256 pins are stored with provenance. Trust follows a pinned root public key,
never a root supplied solely by the phone. Presented roots must be self-issued/self-signed; every
ordered child signature/name link is checked. The complete bounded path is structurally checked by
PKIjs with an explicit per-call WebCrypto engine. Duplicate certificates/extensions, unknown critical
extensions, non-leaf attestation extensions and unexpected provisioning placement refuse.

Supported profiles currently match captured four-certificate factory chains under the factory root
and five-certificate RKP chains through Google's DroidCA2 intermediate. Unknown shapes refuse as
unsupported; they do not degrade to an unverified passing key. The target must be a non-CA P256 key,
and its exact SPKI must match the submitted key. Exact expected server-owned challenge bytes must match
the signed extension. The generic checker bounds those bytes to1–128; the future enrollment protocol
must continue requiring its specific32-byte canonical challenge hash.

RKP issuer validity is checked before and after status lookup. Future factory issuers also refuse;
the documented factory-expiration exception does not extend RKP keys. Device-chosen target validity
is not a server-time witness. PKI structural validation uses a mutually valid historical instant when
factory expiry or device target dates require it; every RKP issuer must independently remain valid at
the current server observation. Profiles without a common structural-check instant remain unsupported.
This is an explicit compatibility limit, not full equivalence to Google's recommended Kotlin verifier.
Root trust-anchor expiration is not used as an issuer-time policy. The factory exception remains
visible in the result. No boot, security-level or app-identity value is upgraded by path verification.

After signature/path/challenge checks, all path serials including the presented root are sent only to
the server-owned status reader. Revoked/suspended or incomplete/unavailable/cancelled status refuses;
checked observation timestamps and certificate count must match the current operation. Caller-owned
buffers are copied before asynchronous work. The result labels path/status evidence only; decoded
fields retain their separate unverified-policy status. It neither registers a key nor creates an
attendance record. App signer/package/build, generated-key purpose/digest/origin/boot/security policy,
unique custody, enrollment challenge consumption and Android clock signatures still require their
canonical integration. Real Google-status, modern distribution, quota/cache and signed-device
acceptance remain open. No Android integrity HTTP route is activated by this owner.

Google's official verifier sources were inspected at revision34652d3df68b8d6887a6670b00eb0856090dae6d,
including its Android-specific path profiles and validity behavior. The custom boundary must retain
differential/negative coverage before release; a generic PKIX pass alone is not sufficient.


## Android app and generated-key policy

The composed optional proof owner now validates server-owned package/signer/build expectations after
chain/status verification. It requires exactly the configured package (shared-UID packages are not
adopted), an allowed version and every reported signing certificate digest in the configured rotation
allowlist. Software and hardware authorization lists are not merged. The required hardware facts are
EC/P256/256-bit, generated origin, sign purpose (verify may also be present), and SHA256 only. Software
substitution or conflicting duplicate key properties refuses. Both attestation and key security levels
must be the same configured hardware level; software is never an accepted fallback.

Locked verified boot with expected32-byte boot-key/hash evidence is required. Only digest lengths are
retained, never identifier bytes. Deployment settings explicitly provide nullable OS/patch minima;
null means no additional minimum, not an invented universal safe age. Reported patch formats are
validated, and a software/absent value cannot substitute for a configured hardware minimum. These are
key-generation-time facts, not a current boot, app-license, live-GPS or attendance authorization claim.

RKP issuer organization must identify TEE or StrongBox. When provisioning entity metadata is present,
it must agree with that signed issuer and with both description security levels. Present lost-device
true refuses. Older captured provisioning maps lack entity and lost-device fields; these remain
unavailable, not false. The policy must explicitly select `allow_legacy` or
`require_entity_and_lost_device`. The latter refuses missing metadata. Results preserve reported versus
unavailable metadata so a caller cannot invent checks. Unknown optional provisioning map keys are
bounded but not persisted; known fields, duplicate CBOR keys, trailing data and nesting are validated.

The result exposes minimal app/build/security/patch/provisioning evidence plus public key, never raw
identity, signer list or full decoded authorization metadata. It does not consume a challenge, persist
Android ownership, register a replacement key, enable routes or accept attendance. Enrollment must
supply a fresh canonical32-byte scoped challenge and consume/persist proof atomically with unique key
custody; clocking requires its own signature and current revocation/permission checks. Rollout settings,
Play composition and real signed-build/device/distribution acceptance remain unfinished.


## Android online command-signature primitive

The optional server checker verifies SHA256withECDSA over the exact UTF8 positional online-clock
encoding. It does not sign/verify an already hashed digest or raw multipart/JSON object encoding. The
stored public key must be a verified public P256 key; private/RSA/other-curve keys refuse. Signature
encoding is bounded DER with exactly two positive minimal integers in the P256 scalar range, no
truncation, trailing bytes or alternate P1363 interpretation. Server-owned package and build allowlist
must match the Android evidence before the signature can pass. The complete canonical scope,
challenge, command/photo and client-source fields remain bound; null stays distinct from false.

This primitive does not retrieve or authorize a key, prove location, check challenge issuance/expiry,
consume a permit, advance an App Attest counter or create attendance. Android has no equivalent
assertion counter in this signature. The transaction owner must load scoped current custody, enforce
revocation/own employment and atomically consume the challenge with its authoritative command/receipt.
It must reconstruct actual photo digest/size/MIME and canonical context rather than trust submitted
hashes or authority. ECDSA has multiple valid signatures for the same message; signature bytes are
never an idempotency key. Stable command identity and challenge consumption own replay prevention.

A public-only synthetic OpenJDK JCA vector exercises the same secp256r1/SHA256withECDSA API as the
Android module, with an independent positional message encoder. The private key exists only inside
the generator process; fixtures retain public SPKI/signature/message and generator hash. This is
cross-runtime encoding evidence, not Android Keystore, device, attestation or non-exportability proof.
No Android clock route or attendance writer invokes the primitive yet.


## Native Android canonical signing adapter

The mobile adapter now encodes the validated online-clock context as exact canonical UTF8 and base64
for the existing `signAndroidCommand` bridge method. It signs bytes, not a double-hashed value. It
checks Android Keystore capability and exact app/version/build consistency before selecting the saved
alias. Invalid aliases, malformed/cross-platform contexts, unavailable modules and native failure
results cannot cause key generation or a JavaScript fallback. Native evidence remains `not_verified`.

The caller supplies a live scope owner (auth generation, actor/connection/employment and view lifetime)
and a live foreground/privacy predicate. These are checked before signing and after native success or
failure. Background/obsolete callbacks cannot publish a signature as a current action. The bridge
still owns its bounded deadline and artifact validation; a timeout never automatically retries. Input
is schema-copied and serialized before the asynchronous native call. The caller must persist the exact
command/signature and its challenge before upload. No API request, receipt, registration or attendance
mutation occurs here; no screen or clock controller invokes this adapter yet.

Tests execute the shipped adapter and bridge with a synthetic P256 native-signing port and the real
server signature checker. They verify byte identity, non-ASCII UTF8, capability mismatch, aliases,
foreground/owner changes, unavailable/invalid/malformed/timeouts and no retry. This establishes the
code boundary, not Android Keystore availability, non-exportability, signing dialogs, hardware or
signed-device lifecycle behavior. Those remain native acceptance work.


## Android enrollment context and challenge ownership

Android enrollment has a separate portable target/context and positional UTF8 encoding. The digest
binds API origin, server installation, tenant, actor, employment, app installation, request, challenge,
nonce, issuance/expiry and every configured package/signer/build/hardware/provisioning/patch policy
requirement. Policy sets are copied, deduplicated and sorted. The server reconstructs scope from the
authenticated owner and stored challenge; the strict input accepts only employment/request/app-install
references. Client context and client hashes do not supply server authority.

The Android challenge owner uses the shared actor admission/TTL/recovery transaction and a distinct
Android binding domain. Configuration changes cannot adopt the original request under new policy.
Concurrent retries and reads retain the original context, digest and alias, including consumed state.
Cross-actor, cross-tenant, administrator and archived-owner reads are refused. Four pending challenges
prevent new issuance while exact recovery remains available. Challenge issuance creates no key and
provides no attestation verdict. The portable Expo digest adapter rechecks its live owner after both
successful and failed digest operations.

The Android policy schema is shared by the portable context and server evidence matcher; patch-date
validation still comes from the same non-null field validators. No public enrollment route, native
key-generation controller or key registration transaction invokes this new owner yet. Custody needs
the separately reserved append-only migration and proof/transaction integration before release.


## Android custody extension draft

The exclusive0636/idx634 reservation extends mobile_integrity_key rather than introducing another
key inventory. The draft pairs Android platform with google_key_generation_proof, null Apple
environment, counter0 and non-null object provenance. Apple rows retain their required environment,
minimum app identifier length and Apple proof kinds/metadata requirement. Android has no monotonic
App Attest counter; command replay prevention must use the immutable command/challenge transaction.
The encrypted receipt column remains required and is intended for the bounded original certificate
proof, not private key material. Enrollment must define and enforce its serialized proof size before
encryption and persist the verified metadata; a schema object check alone verifies no vendor claim.

The draft preserves RLS definitions/enforcement, ACLs, unique indexes and immutable-history trigger.
Rehearsal compares those database definitions before/after, verifies positive Android/Apple inserts,
checks malformed platform/proof/environment/counter/metadata combinations and exercises revocation
without resurrection. Every rehearsal intentionally rolls back the schema extension and rows.
The draft has no journal entry pending a centrally assigned final timestamp and dependency freeze.
It is not part of an applied migration chain and cannot be released in this state. Source schema,
public receipt compatibility, Android enrollment and clock transactions still need integration;
existing protocol-v1 Apple receipt consumers must not be silently fed unsupported Android variants.
