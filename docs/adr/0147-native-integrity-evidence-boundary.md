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
directory and SecureStore pointer. Android enrollment slots allow 128 KiB; Apple slots allow
256 KiB for a full 64 KiB base64 artifact beside bounded retirement history and context. Missing pointers with existing enrollment slots quarantine the state; they cannot
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


## Versioned key recovery compatibility

V1 key receipts remain Apple-only. V2 recovery has separate mounted keys/key-receipt/revoke routes
and a discriminated public receipt accepting Apple or Android. Android receipts require null Apple
environment and google_key_generation_proof; cross-platform combinations are refused. Neither
receipt exposes vendor key identifiers, public key bytes, encrypted proof or provenance metadata.
V2 recovery grants no enrollment or attendance capability.

V1 inventory filters the platform in the database before the bounded20-row ordering/limit. Exact
receipt lookup applies the same filter. V1 revocation refuses an unsupported platform while holding
the key lock and before mutation, so an output-contract failure cannot follow a successful unsupported
revocation. V2 uses the same own-actor/current-employment and immutable-history owner without that
legacy platform filter. Every mounted recovery route explicitly invokes mobileRoute; shared
operations handle business logic and closed outcomes underneath the authenticated boundary.

Current mobile UI/enrollment journal still uses v1. Mixed-platform database/HTTP fixtures now exercise v1 filtering/refusal and v2 Android
lookup/revocation against the draft custody schema in a disposable worker. They use synthetic custody
rows; actual verified Android enrollment and migration integration remain unfinished. The new Android receipt decoder is tested using synthetic public fixtures,
not an enrolled Android key. This is protocol preparation, not completed Android enrollment rollout.


## Android enrollment custody integration (verification pending)

The Android enrollment owner now composes the existing challenge and Google path/status/policy
verifiers with the shared key table. It snapshots bounded SPKI/certificate bytes before awaiting,
retains proof order/boundaries in immutable retry identity and limits serialized proof to32KiB before
encryption. Existing outcomes reconcile before vendor verification or encryption-key availability,
including revoked receipts. A new proof is checked against the stored canonical digest. P256 public
SPKI equality and current-request verification time are checked before challenge consumption.

The transaction consumes the owned challenge, serializes actor capacity, inserts immutable key/public
metadata/encrypted provenance and appends enrollment audit atomically. Existing active-install and
five-active-key limits apply across platforms. Permanent public-key fingerprint uniqueness prevents
revoked-key adoption under a new challenge. A repeated consumed challenge reconciles its persisted
receipt rather than creating another key. Android uses null Apple environment and counter0.

Schema source types now describe the reserved0636 target. Apple enrollment explicitly validates its
receipt through the unchanged v1 decoder and rejects a non-Apple reconciliation row. Until0636 is
journal-integrated with a centrally allocated timestamp and paired dependencies, these Android writes
are not compatible with the migration-owned predecessor schema. No Android enrollment HTTP route is
mounted. The new tests use a synthetic verifier port and worker-only draft schema; they have not run
at this checkpoint because another chat owns the complete local resource set.

## Native v2 recovery integration (verification pending)

The current mobile key screen requests v2 inventory. Only a404 on that read-only inventory can fall
back to v1, using the strict Apple-only decoder. Other failures and every command retain their
original protocol/outcome. Authentication refresh and live owner checks still apply to both reads.
Android revocation uses v2; Apple revocation retains v1. Both require exact enrollment receipt identity
and a confirmed revocation timestamp. Exact receipt lookup uses v2 with no command downgrade. These
source changes and added transport/screen tests await shared verification resources; no new native
bundle or physical-device acceptance is claimed.


The encrypted Android provenance envelope now also retains the original server-generated enrollment
context alongside the immutable ordered proof. Without this context, a later target-policy change
would prevent reconstructing the original attested digest for audit. The original proof identity is
still bounded32KiB; the complete provenance plaintext is bounded48KiB before AES-GCM/base64url, below
the64KiB ciphertext column bound. This follow-up is unverified pending shared test resources.


## Native Android enrollment operation boundary (unverified)

The native adapter validates a protocol2 active preparation, derives the canonical challenge and
alias with the shared portable encoder and checks the actual app package/build capability. Only a
caller-supplied durable generation-intent commit can precede createAndroidKey. A failed/obsolete/
background commit cannot start generation. StrongBox-only policy requests StrongBox without automatic
downgrade. The adapter has separate create and read operations: read only invokes androidKeyInfo for
the saved alias; creation never replaces, retries, or automatically reads an existing/uncertain key.

Native evidence remains not_verified, including reported hardware-level hints. Artifact bounds match
the server protocol. Ownership and foreground checks surround crypto/storage/native awaits. This is
an internal adapter with a durability contract; it is not a complete journal or a mounted enrollment
flow. The real journal still must persist generation/proof/outcome states, reconcile exact receipts
and retain uncertain aliases. No native SDK/device or Metro export was exercised by this source
change. Six shipped-adapter/bridge tests were added but remain unrun pending test resources.


## Portable Android receipt identity (unverified)

Before Android enrollment rollout, its opaque native-key reference is defined as SHA256 of the
versioned canonical SPKI-base64 reference encoding. Both server and native crypto helpers can
reproduce this reference, then bind it to the original challenge with nativeKeyBindingData. This
avoids implementing ASN.1/elliptic-curve parsing in the mobile receipt journal. Public SPKI reference
parsing verifies no certificate or key; the server still requires the real composed proof verifier
and canonical P256 SPKI equality before registration. The permanent uniqueness fingerprint remains
SHA256 of the uncompressed public EC point, preserving cross-platform duplicate-key refusal.

No Android enrollment records have been deployed by this work. This pre-rollout reference change
requires the new native/server code together; no historical Android key identity is silently
rewritten. Public receipts still omit the reference and raw key. Two additional native hash cases
and a server receipt assertion were added; pending native cases now total8. They remain unverified.


Focused verification now covers the Android enrollment owner, encrypted original-context provenance,
receipt reference and native create/read adapter:26 assertions across run40446194829 and targeted
retry40447866519, plus root and separate native TypeScript. The first hosted run's compiler failed
on React Native ambient types entering through a VM test type import. A test-only boundary repair
resolved it without changing production code or weakening compiler policy. These are focused source
checks with synthetic vendor/native ports; no real Android hardware acceptance, mounted enrollment
flow, complete durable journal, migration integration or release readiness is claimed.

## Enrollment HTTP boundary and concurrent receipt recovery

`createAndroidEnrollmentHttpHandlers` composes the actual enrollment owner with `mobileRoute`, the
shared request budgets and explicit own-employment authorization before configuration access.
The body cannot supply actor, tenant, expected policy or a verifier. Canonical SPKI/certificate
representations and their aggregate proof size are checked before creating buffers or running PKI.
Expected vendor/policy failures become closed refusal/unavailability responses; unexpected failures
remain inside the private HTTP error boundary. Exact accepted proof retries return the same minimal
receipt without re-verifying vendor evidence or requiring receipt-encryption availability.

iPhone and Android use one bounded server-configuration reader. It cancels its owned reader on
request abort/deadline/completion and prevents a late configuration result from starting enrollment.
No request-controlled host or policy becomes configuration authority. Missing configuration remains
distinct from malformed/unavailable configuration. Independent mounted key recovery remains usable
during configuration outages.

There are two separate receipt-reconciliation windows: before proof work, and after observing an
inactive challenge. A competing request can commit between the initial receipt lookup and the
challenge read. Both native enrollment owners therefore recheck the exact actor, original subject,
installation and proof digest before returning a committed receipt in that second window. Challenge
consumption alone is never success. A conflicting proof remains a binding refusal, and an absent
matching key remains unavailable. Neither challenge nor custody history is reopened or rewritten.

These handlers remain unmounted. Rollout still requires the actual custody schema, trusted
company/deployment policy assembly, signed-device acceptance and app orchestration. This boundary
does not activate Android clock assertions, offline acceptance or Huawei support.

## App assembly and installation-pointer loss

`openOwnedDeviceEnrollment` assembles the actual platform journal, encrypted native storage, SDK
adapter and normal bearer transport. It fetches current own identity/employments before obtaining
the existing device-only-master-bound installation ID or opening a scoped journal. Missing actor or
an unowned selected employment refuses assembly. Actor generation, company namespace, API origin,
platform, current unlock state and foreground state are checked across asynchronous boundaries.
The supplied unlock predicate must read the current session and be invalidated on unmount or
employment selection change. Handles bind the selected employment; historical receipt recovery
retains the original command subject rather than rewriting it.

Opening exposes no automatic generation, preparation, proof submission or revocation. `begin`
persists explicit intent; `advance` performs the journal's exact-receipt-first recovery; `revoke`
retains the existing durable intent semantics. Android replacement stays an explicit operation
after fresh server-confirmed retirement. A network exception leaves the committed pending stage
available for another owned handle. A missing command endpoint is not downgraded or sent to another
platform's protocol. A cached receipt still cannot authorize attendance.

The transport contracts reserve Apple v1 `integrity/enrollment/begin|complete` and Android v2
`integrity/android/enrollment/begin|complete`. Native transport uses the same bounded-body/deadline,
bearer refresh and scope checks as existing commands. Responses must match the selected platform's
preparation/result schema. No server route is activated by adding these client command mappings.

The installation ID is one existing owner, not a second actor or hardware identity. If its current
master-generation pointer disappears while either platform's enrollment directory remains, refuse
new identity creation: selecting a fresh ID would hide an existing pending journal behind an empty
scope. Empty/corrupt pointer values also refuse. A legacy submission-only installation may initialize
its first enrollment ID. First-install reset still owns master reset and the consequent new ID.
This detects retained enrollment directories; it does not recover an OS backup that lost all local
evidence or implement a pending-enrollment discard/exception protocol.

The assembly is not yet connected to a screen or imported by the app entry graph. A reviewed
capability/rollout owner and explicit user interface remain required before enrollment is offered.
The existing key inventory/revocation screen remains independently available.

## Deployment-owned enrollment rollout and capability discovery

Enrollment and discovery routes are now mounted **in source**, with `mobileRoute` at every exported
method. This supersedes the earlier unmounted-enrollment description, not the signed-clock/offline
limits. Nothing has been deployed or enabled by this source change. The server reader defaults to
disabled when `AIHR_MOBILE_ENROLLMENT_POLICY` is absent/empty. It is a server-only deployment policy,
never an `EXPO_PUBLIC` value, phone header, query, editable tenant preference or alternate identity
store. It controls access to an enrollment pilot; it does not define HR attendance acceptance.

The JSON shape is `{version:1,entries:[...]}`. An empty entries array is also disabled. Each entry
requires `tenantId`, `companyId`, explicit nonempty `actorIds`, and complete platform `settings`
validated by the existing Apple/Android settings schema. There are no wildcard actors or company
fallbacks. Duplicate tenant/company/platform entries or duplicate actor IDs refuse configuration.
The raw value is bounded to256KiB, at most100 entries and1000 actors per entry. Target settings remain
server-owned: expected HTTPS deployment origin, signed app identity/environment or package/signer/
build/hardware/provisioning/patch policy must come from reviewed actual distribution evidence.
The entire policy is validated before selecting an entry; malformed policy never partially enables.

The reader repeats current own-employment authorization and uses the canonical temporal company
proof. An unproven company cannot choose a rollout entry by reading the mutable current-company
column directly. Company-scoped attendance entitlement, receipt-encryption availability and ordinary
application-role storage readiness are prerequisites. Readiness uses system catalogs to detect
missing tables, required RLS/forced-RLS flags, immutable triggers, key read/insert permissions and
installation-function execution. Android additionally requires the validated paired custody
constraint and nullable environment. This is a prerequisite detector, **not** a complete schema,
constraint-body, RLS-policy or migration-semantic certification. The coordinated migration/release
checks remain required; no migration-owner credential is read by a web request.

`GET /api/mobile/v2/integrity/{ios|android}/capabilities?employmentId=...` reports only understood
enrollment capability, protocol/platform and `offline:false`, or a typed unavailable/refused result.
It issues no challenge and returns no rollout allowlist. Commands use the client-reserved Apple v1
and explicit Android v2 enrollment paths. A valid capability is neither key custody nor attendance
acceptance. Signed-clock routes remain unmounted. Native capability consumption and the explicit
enrollment screen still need connection; the app assembly is not yet in its entry graph.

Both mounted completion routes supply a trusted commit guard. After vendor verification, inside
the same challenge-consumption/custody transaction and actor lock, it repeats own-company proof and
checks the current exact allowlist/target against the original settings. Removed actors/entries or
changed targets refuse, rolling back consumption, key insert and success audit together. No second
pooled transaction or vendor call occurs under that guard. The configuration reader has no cache;
subsequent requests observe a changed environment. Exact already-accepted receipts remain facts,
and independent inventory/lookup/revocation continue during disabled rollout or encryption outages.

Keep the deployment variable unset until the paired migration chain and signed-device acceptance
for the named pilot population are approved. The unjournaled Android draft still cannot be applied
by inventing a timestamp. Source-mounting these default-closed routes does not grant migration,
deployment, store submission or HarmonyOS activation authority.

## Connected device enrollment and receipt-only recovery

The device-key screen now imports the app assembly. iPhone/Android discovery is decoded against
the requested platform; missing endpoints do not downgrade. New setup requires current successful
capability discovery, supported native bridge/recovery methods, readable local state and explicit
confirmation. Initial loading is not empty registration. Refresh errors retain saved content while
withholding new setup controls. Opening the screen never generates a key or uploads a proof.

`reconcile` is a distinct journal operation used by **Check status**. It reads only the saved exact
challenge receipt, then validates its immutable native-key binding before committing recovery.
It may read a known native alias or release acknowledged Apple proof cache; it never prepares a
challenge, generates/attests a key, submits proof or repeats revocation. An absent receipt is not
permission to advance and never clears pending work. Registered keys also reconcile server
revocation without resurrecting historical receipts. Both platforms use the same pending-receipt
helper for this operation and the receipt-first step of explicit continuation.

This recovery stays available when enrollment rollout is disabled. Previous-employment intent may
recover an exact accepted receipt through a current own selector, but cannot continue generation or
upload under a different subject. Revocation continuation remains an explicit confirmed action.
Both platforms require known retirement and a fresh server receipt before explicit replacement;
the iPhone history and storage bounds are described below. Unreadable storage exposes retry/help, never an empty setup
or automatic reset. Cached registration is described as saved state, not verified attendance/location.

The UI checks live capability/local state again when confirmation is accepted. Its operation lineage
increments across account, connection, locale, employment and privacy transitions. A callback from
before lock stays obsolete after unlock, even when the same identity returns. In-flight callbacks
cannot publish into another render/actor or sign out a replacement session. Registered/pending/
revoked outcomes use accessibility alerts. Copy follows the existing English/Malay pipeline; other
locale and physical accessibility acceptance work is still outstanding.

Local Metro entry graphs now include the actual screen, app adapter, both journals and current
transport. This supersedes the earlier unreachable-assembly description. Reachability and synthetic
port tests do not establish signed-device acceptance, activation, store distribution or Huawei NEXT
support. The default-closed deployment policy remains unchanged.


## iPhone replacement preserves original enrollment provenance

Explicit iPhone replacement freshly reconciles the exact immutable server receipt through a current
own-employment selector. A cached revocation alone cannot authorize replacement. Active, missing,
unavailable or mismatched receipts preserve the existing state. After confirmed revocation, one
atomic journal commit archives the original subject, context, key binding and receipt and writes the
new request intent before any challenge preparation or native key operation. Lost acknowledgements
recover that committed intent; they cannot start a different key. SDK private keys are not deleted.

Legacy Apple journal versions1/2 remain readable and unchanged until explicit retirement. Version3
requires one to fifteen revoked predecessors plus a current key or pending intent. It rejects duplicate
request/challenge/native/key identities, foreign context and tampered bindings. Every subsequent
transition retains history, including revocation intent and receipt. Full history refuses further
replacement without eviction. Fifteen predecessors plus the current key match the native Apple
proof store's sixteen total records; this is an application bound, not an Apple provider quota.
Other actor scopes can consume installation capacity earlier.

Apple encrypted plaintext slots now allow256 KiB; Android remains128 KiB and submission journals
remain64 KiB. The shared sealed-storage constructor admits at most256 KiB, while each caller keeps
its own smaller limit. Existing purpose-separated AAD, pointers, legacy serialization and64 MiB
installation quota remain unchanged. A maximum-size proof beside fifteen retired contexts survives
restart and resumes exact submission without another one-use SDK attestation in synthetic tests.
This does not establish physical-device attestation, current device integrity or attendance presence.


## Android online command transaction and attendance carrier

The Android command owner now loads an actor/tenant/app-installation-owned, unrevoked Android
custody row under a key lock. It requires the Google key-generation proof kind, nullable environment
and an authenticated encrypted enrollment provenance record. Original origin, actor, tenant,
installation, enrollment subject/challenge and SPKI must match custody. The original canonical
Android target must equal the trusted settings supplied to this service, including signer digests
and patch/security requirements. A changed target requires reenrollment; incomplete minimal metadata
is not reinterpreted as satisfying a changed policy. Secret availability is checked explicitly before
decryption, including after the encryption module has cached its derived key.

The server reconstructs canonical command bytes from the actual command and exact photo bytes,
client-reported source facts, stored challenge and owned key. The challenge binding additionally
includes the exact legacy device credential, without publishing that credential. A real P-256 ECDSA
signature is checked using the stored SPKI. Android has no Apple assertion counter; one-use challenge
consumption is the replay owner, and different valid ECDSA signatures are not separate commands.
Photo and signature buffers are copied before asynchronous work.

One transaction consumes the challenge, locks/rechecks the key, checks the signature, invokes the
attendance writer and appends proof/audit links. Database time and own-employment eligibility are
checked after waiting and again after callback work. A callback must use the supplied transaction
and checked command snapshot; network calls and nested transactions are prohibited. Failure rolls
back consumption, tentative attendance, receipt and audit together. The carrier invokes the existing
attendance owner, retaining registered-device, photo, geofence, correction and attendance rules.
An already-consumed challenge recovers only a capture linked to the same challenge and actor; it
cannot replay the writer or adopt an unrelated legacy receipt. Receipt recovery does not require
new proof verification and remains usable after key revocation or secret unavailability.

The audit distinguishes `command_signature` from `google_key_generation_proof` and has no Apple
counter, device trust tier or verified-location claim. Historical key-generation evidence plus a
valid signature does not establish current boot/app state, current vendor revocation, Play licensing,
GPS authenticity or physical presence. Current vendor evidence and trust/review policy remain
activation work. Public Android clock handlers, discovery, commit-time rollout revalidation and
native journal/clock-screen orchestration are not yet connected; both platform clock routes remain
unmounted. Enrollment configuration must not be treated as clock activation permission.


## Shared signed-clock HTTP parsing and transactional configuration veto

The separate signed-clock HTTP factory now supports Apple v1 assertions and Android v2 ECDSA
signatures. The existing unmounted Apple factory delegates its clock operations to that owner.
Apple wire requests/preparations require iOS evidence; Android uses distinct signature/preparation
contracts requiring Android evidence and protocol2. No proof or platform substitution is accepted.

Both paths retain mobile bearer admission/shared budgets, explicit own-subject selection, no-store
responses and private error codes. Multipart bodies are limited to3 MiB, with only command/photo
fields, one instance of each and at most2 MiB per permitted JPEG/PNG attachment. The command field
has an independent16 KiB UTF-8 bound before JSON parsing; photo allowance does not grant megabytes
of JSON parsing. Exact photo bytes reach the canonical owner; phone-supplied digest, actor, tenant,
settings, verifier, trust or accepted-state fields are refused. Proof encodings are canonical base64
and bounded separately (Apple8192 bytes; Android72 bytes).

Clock preparation and completion are unavailable without a trusted transaction-aware commit guard.
The Apple factory omits its clock feature when no guard is supplied. During completion, both platform
core owners call the guard inside the same transaction after tentative attendance work, before final
own-subject/time checks and proof audit. A policy veto rolls back attendance/capture, challenge,
Apple counter and audit together. Request cancellation is checked before and after the guard.
Already-consumed exact receipts remain recovery observations and never invoke the writer again.

The guard must use the supplied transaction and the clock policy owner. It must not open a pooled
configuration read while those locks are held. The HTTP layer verifies guard presence and invokes
it; that does not certify the supplied guard's policy semantics. Enrollment permission is not clock
activation permission. A dedicated clock rollout/configuration/discovery owner, native journal/UI
orchestration and explicit treatment of legacy clock channels are still required before activation.
No new clock route is mounted by these factories. Current device/Play/vendor evidence and trust or
review policy remain separate from command-signature acceptance.

The owner has deferred Huawei work for now and prioritized Android and iPhone. That changes the
work order, not the evidence bar: full native builds and physical-device acceptance remain required.

## Current Android evidence policy boundary

`AndroidClockIntegrityPolicy` now defines deployment-owned, explicit requirements for the current
Google verdict: device versus strong device labels, licensed versus any evaluated licensing,
bounded token age/future skew, and separate rules for reported mock, simulation and accessory flags.
It has no defaults, wildcard allowances or missing-provider success mode. Missing/invalid settings,
policy or credentials make the operation unavailable before a Google call. No policy is activated
by defining this schema; enrollment permission remains separate from clock rollout permission.

`createAndroidClockIntegrityVerifier` composes the existing fixed-endpoint, bounded standard-token
decoder instead of accepting a phone-supplied decoded verdict. Google must bind the actual canonical
command hash, package, every signer and build first. The policy then requires recognized app/device
evidence, selected licensing and freshness, and the configured source-signal rules. Basic, virtual or
strong-only labels without the device label do not satisfy the required device baseline. Unknown
vendor labels remain unavailable. Licensing unevaluated and a required-but-unavailable source flag
remain unavailable; unlicensed or reported source flags have distinct refusals where the selected
policy disallows them. Explicitly tolerated unavailable/allowed source facts remain intact.

The alternative of treating a historical enrolled key or client `false` flag as current assurance is
rejected. Google evidence describes its documented app/device/account checks, not authenticated GPS
or attendance. A successful result is **eligible** for this evidence policy only. It explicitly
records `locationVerification: not_verified` and `keyVerification: not_evaluated`. Its assessment
binds the exact canonical command hash, parsed configuration digest and parsed policy digest,
requested/checked times and checked labels, retaining source flags without manufacturing false.
Inputs are copied before asynchronous vendor work; no raw integrity/access token is returned or
persisted, and no automatic token retry/cache is introduced.

This module performs no database work, signature/key validation, challenge consumption, attendance
write, trust-tier assignment or HR adjudication. Network verification must occur outside database
locks; the acceptance transaction must revalidate ownership, signature, challenge/time, revocation
and exact command/configuration/policy bindings before one authoritative write. A serializable
assessment is not a bearer permission. The transaction integration described below enforces this
boundary; clock routing, native orchestration, legacy-channel policy and signed-device verification
remain required before activation.

This interpretation follows Google's [verdict reference](https://developer.android.com/google/play/integrity/verdicts)
and [standard-request flow](https://developer.android.com/google/play/integrity/standard).
Focused synthetic-transport verification and guard-removal evidence are recorded in the platform
research appendix; they do not constitute Google production provisioning or device certification.


## Current Android evidence joins the attendance transaction

`createAndroidVerifiedClockService` composes the existing key-signature owner, current Google
standard-token verifier and canonical attendance writer. Its configuration and explicit policy are
snapshots from trusted server assembly. A mandatory deployment transaction guard must re-read the
current clock rollout/settings using the supplied transaction. The factory does not implement that
rollout owner or activate a route; a synthetic no-op test guard proves neither deployment readiness
nor policy revocation semantics.

An active challenge first receives a scoped, read-only ownership/key/provenance/signature precheck.
Google verification then runs outside challenge/key row locks. Consumption repeats authorization,
key revocation and provenance, signature and challenge freshness under its existing transaction
locks. Current evidence must bind the reconstructed command and exact configuration/policy digests.
Database wall-clock checks enforce token age and future skew before attendance work and again after
tentative writes and the deployment guard. Cancellation or any veto rolls back attendance,
consumption and audit together. The signature-only primitive remains internal and is not evidence
of current device eligibility.

Concurrent retries may receive a cleared Google verdict after another request committed. The error
path re-reads the exact owned challenge and permits only its already-consumed receipt observation;
it cannot turn a failed vendor check into fresh attendance. Exact committed receipt recovery also
survives later key revocation or provider/secret outage, subject to current own-employment access.
The audit retains historical key/signature evidence separately from the current Google assessment.
Neither Google eligibility nor an enrolled signing key authenticates GPS or proves physical presence.

At checkpoint `8e76913c7d11c3d33eeb0ca6078d2cdb2f6e4797`, the existing standard GitHub Actions
focused workflow passed the five selected files (45 cases) and whole-root TypeScript check. This is
focused development evidence, not a full release gate, actual vendor provisioning, tenant activation
or signed physical-device acceptance. Detailed scope and adversarial verification belong in the
platform evidence appendix.


## Current Android evidence at the signed-clock HTTP boundary

The unmounted Android signed-clock factory now requires `AndroidClockConfiguration`, a strict
server-owned pair of enrollment settings and explicit current-integrity policy. Bare enrollment
settings no longer configure Android clocking. The transaction guard receives the complete parsed
pair, so a policy change during Google verification must be checked alongside a settings change.
Apple retains its existing App Attest configuration and v1 contract. This supersedes the historical
signature-only Android HTTP assembly described above; the primitive remains internal.

Android completion accepts one separate `playIntegrityToken` multipart text field, bounded to
1–32768 printable ASCII bytes. It rejects missing, duplicate, file-valued or malformed tokens before
configuration/vendor work. Tokens are not embedded in command JSON, whose independent 16384 UTF-8
byte limit remains unchanged. The existing 3 MiB streamed body, 2 MiB JPEG/PNG photo and canonical
signature bounds remain. Begin and Apple requests reject the extra token field. A phone may not
supply a configuration, decoded verdict, authority field or vendor endpoint.

Trusted assembly supplies a Google access-token provider and optional bounded transport deadline.
A fresh Android challenge is unavailable without that provider. Completion composes
`createAndroidVerifiedClockService` with the authenticated subject, reconstructed server context,
exact attachment bytes, mandatory transaction guard and request cancellation. It never falls back
to the historical signature-only writer after unavailable or refused evidence. Exact already
committed receipt observation remains possible during provider outage while a valid server clock
configuration and current own-employment access remain. The dedicated receipt/discovery behavior
for missing clock rollout remains separate activation work.

The response contract adds optional, bounded `integrityReason` enums to existing refused/unavailable
envelopes. It distinguishes current evidence failures without exposing raw Google responses,
access/integrity tokens or private configuration. Accepted responses retain the minimal authoritative
clock receipt; neither receipt nor client flags claim authenticated GPS. Evidence remains in the
separate audit assessment. The existing mobile admission/budget/authentication wrapper applies.

Frozen checkpoint `c9e72e803167a392d3080b7ad90d1d6e05178112` passed ten affected suites (132 cases),
Next type generation and whole-root TypeScript in standard GitHub Actions. Independent hosted
removal probes verified the current-service dispatch and token-field guard. Results are detailed in
the platform evidence appendix. No route or tenant setting was activated. Dedicated rollout and
legacy-channel policy, Google/Apple provisioning, native durable clock orchestration, physical-device
acceptance and the full release gate remain required.


## Separate signed-clock rollout and unsigned-channel policy

`AIHR_MOBILE_CLOCK_POLICY` is a new deployment-owned clock policy, independent of
`AIHR_MOBILE_ENROLLMENT_POLICY`. It has no default activation. Its strict version-1 document is
bounded to 256 KiB and 100 entries, with one entry per tenant/company, an explicit unique actor list
(maximum 1000 per entry), explicit iOS/Android deployment slots (nullable to disable each), and a
mandatory `legacySelfService` choice. At least one platform must be configured. Android deployment
contains its settings/current-policy pair plus a bounded decimal cloud project number; iOS contains
its existing App Attest settings. The project number is public SDK configuration, not a credential
or a claim of Google readiness. No request body or mutable current-company column selects a policy.

`readMobileClockDeployment` and `readMobileClockConfiguration` resolve the temporal own-company
proof through the existing employment owner, check attendance entitlement and reuse the enrollment
owner's ordinary-role storage readiness check. Missing receipt encryption, disabled custody triggers,
missing Android prerequisites or cancellation refuse readiness. The metadata check does not replace
migration semantic/release acceptance. No migration credentials or schema writes are used.
`assertMobileClockCommit` repeats the temporal company/actor/platform selection and exact parsed
settings/current-policy comparison after vendor work, using the supplied acceptance transaction;
it never opens a second pooled transaction under held locks. Removed rollout, actor exclusion,
changed configuration/policy or missing encryption veto tentative attendance and proof consumption.

Each entry explicitly chooses `allow_unverified` or `require_signed` for its selected actors in the
proven company. This is a partial rollout unless every intended actor is listed; unlisted actors do
not gain signed-clock permission and retain established self-service behavior. `allow_unverified`
never grants integrity assurance. For `require_signed`, the shared employee-capture writer refuses
new unsigned web AND native-mobile captures before the canonical punch writer and rechecks the
choice after tentative writes. A DTO field cannot select the internal signed transaction seam.
The signed carrier remains responsible for proof verification and the mandatory deployment guard.
An already accepted exact command can still return its original receipt subject to existing
validation; dedicated receipt lookups remain independent. Privileged corrections/imports are
separate audited workflows, not new self-service capture channels. The older exported clock-in/out
server actions currently only authenticate and redirect and do not write another punch.

Absence of the clock-policy environment variable preserves established channels and leaves signed
clocking unconfigured. A present malformed/oversized policy cannot silently restore unsigned
clocking: fresh writes fail with a typed availability outcome. Project-number refinements validate
syntax and length before `BigInt`, including whitespace rejection; malformed configuration cannot
escape as a raw conversion exception. Web returns a private/no-store 403 `integrityRequired` for
a signed-only refusal; mobile returns its existing no-store refused envelope with
`integrity_required`. Web copy exists in all six current catalogues; the native app adds the message
to its existing English/Malay table. Known configuration faults return generic 503 responses;
unknown failures retain the existing private failure handling. Native language completion remains
part of the broader plan.

This code does not set a deployment policy, supply Google credentials, mount signed clock routes
or advertise clock capability. Native durable signing/upload/recovery, explicit discovery and
vendor assembly, physical iPhone/Android acceptance and the full release gate remain necessary
before activation. Focused hosted evidence and independent guard removals are recorded below in
the platform research appendix.
