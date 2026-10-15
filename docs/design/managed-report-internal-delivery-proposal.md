# Proposed ADR: Embedded report delivery through a private Auth broker

Status: Proposed, revised 2026-10-16 after parent review. Central migration reservation: **0552 / journal idx 552 / when 1791900000032**, reserved only; no migration has been written, implemented or approved. No ADR allocated. This replaces the rejected proposal to give the SMTP sender the deployment encryption key. No feasibility or acceptance result is claimed.

Baselines: report parent `20eb1440769ee0bbb72bceccf70c5a6faedc0037`; frozen Auth `ae7236713a3bc4393786c8c5d38140f9d93c4dd0`, read through Git without merging. Approved report scheduling/ADR-0119 retain their isolation boundaries under selected embedded authentication/ADR-0117.

## Context and verified source

Auth `service.ts` Credential includes password hash, totpSecret and recoveryHashes. `crypto.ts` uses the same AUTH_SESSION_KEY for all private records. Giving those records/key to an SMTP sender exposes authentication secrets; nonce-bound SQL cannot narrow them after decryption. That course is rejected.

Auth already owns canonical `readRecord`, `assertActiveCredential` and SMTP `email-state`. The credential owner requires enabled/verified, a password, completed initial password change and enrolled TOTP, then resolves the exact live HR principal. Its notification adapter demonstrates this composition. One encrypted email-state contains active relay, revision and operator drafts; actual Save/Test/receipt/Apply owns activation. Existing `sendSmtp` uses verified implicit TLS, bounded timeouts, explicit envelope and disabled file/URL access; it currently accepts text only.

Report0549 and `createMasterReportDeliveryService` own nonce-bound target, live report/schedule/consent/principal checks, atomic start and durable finish. Queue/claim remain owner-only. Public IPC accepts only operation and occurrence/nonce, never an address/document.

Existing `renderer-peer.py` checks Linux SO_PEERCRED against the installed mail UID before launching a keyless app-role child. Its0600 socket is Accept=yes/MaxConnections=1. `render-process.ts` validates bounded replies and UUID-derived artifact paths. The current sender/installer remains Keycloak-specific; internal SMTP is owned by the already-key-authorized HR application instead.

## Decision

Install a private Auth material broker under the **same existing OS principal as the key-authorized web application**, with an immutable root-installed runtime. Reuse canonical Auth reads, verification and active SMTP selection. It is not a new credential/SMTP/consent owner or scheduler.

Preserve separate sender and renderer UIDs. Sender receives only a verified canonical target, credential-version metadata and the active relay necessary for one attempt. It receives **no AUTH_SESSION_KEY, password hash, MFA/recovery secret, credential ciphertext or operator drafts**. Renderer remains keyless and receives no SMTP or private Auth material.

Reject an in-web-process sender: it changes approved UID/memory boundaries. Retain inactive compatibility adapters without initializing Keycloak or falling back to it in internal mode. All new APIs below are proposals, not existing exports.

## Actors and authority

| Actor | Authority | Excluded material |
|---|---|---|
| Installation operator | Reviewed bundles/UIDs/sockets/config and rollback | Human credentials/MFA in chat/logs |
| Existing minute runner | Good-standing scope and owner-only enqueue/claim | Auth key/SMTP credentials in cron env |
| Broker, existing web OS principal | Existing app-role Auth reads/key; exact nonce-bound report target/start | Migration credentials; arbitrary broker record/enrollment operations |
| Sender aihr-identity-email | Private nonce-bound report finish only; broker-verified target/active relay; renderer access | Direct report target/start, Auth key/store APIs/credential secrets/drafts |
| Renderer aihr-report-renderer | Scoped app-role report reads and bounded artifacts | Key, SMTP/private-mail/migration credentials; broker access |

Occurrence freezes existing owner user, recipient user/employment, report/schedule versions, digest, scope and consent/policy revisions. Live internal subjects derive from exact user bindings; never email lookup. Missing/multiple eligible bindings refuse. Same owner/recipient identity is valid and may be verified once only when the exact locked binding is shared by both roles. No plaintext relay/address becomes occurrence authority. Final authorization must bind each role to its recorded app_user UUID and tenant, exact non-revoked app_external_identity issuer/subject/app_user tuple, current canonical credential subject and verified profile email; a valid credential alone is insufficient.

## Private broker protocol

Proposed fixed socket `/run/aihr-report-auth.sock`: systemd0600, owned by sender UID. Reuse the renderer's **peer-launcher pattern**, not its executable. Root-owned Python validates its own configured web UID against the actual installed web service identity, inherited socket and SO_PEERCRED equal to sender UID, then executes only reviewed broker Node/bundle with an allowlisted environment. Root/app/renderer/unrelated peers are refused; kernel root remains a trusted administrator, not an attacker-isolation claim. Request JSON cannot assert UID, origin, principal, record key, SQL, address, relay, path or workbook.

Strict discriminated schema, request4096 bytes/reply512KiB, bounded DB/runtime timeouts, one active connection, target field/array bounds inherited from MasterRenderContext. Reject unknown/oversized input; never truncate grants. Responses never contain credential secrets, ciphertext, key or operator drafts; only successful BeginSend returns the expressly authorized active relay. Errors/logs contain neither relay secrets nor private Auth material. No TCP/HTTP endpoint or browser action.

```ts
type BrokerRequest =
  | {phase:'status'}
  | {phase:'inspect'; occurrenceId:string; leaseToken:string}
  | {phase:'beginSend'; occurrenceId:string; leaseToken:string; proof:string};
```

- Status: Auth canonical active-relay readiness plus installed broker configuration; reply only `{ok:true,ready:boolean}`. Existing sweep checks readiness before queue/claim, so status must work without a lease. This gives the sender no fixed-record/ciphertext read.
- Inspect: resolve current nonce target, read exact owner/recipient records **inside broker**, verify through Auth; return canonical target, credential versions and opaque inspection proof. No relay secret is needed during rendering.
- BeginSend: re-read/reverify immediately before SMTP; validate proof and lease; atomically start through canonical report owner; commit; then return only `{ok:true,started:true,target,identityRevision,relayRevision,activeRelay}`. Refusal returns no relay. SMTP password is necessarily visible to sender, but Auth credential secrets are not.

Proof uses existing Auth authenticated-encryption owner with a report-specific purpose, short expiry, occurrence/nonce, target digest and exact subjects/credential versions, **without secrets**. It is bounded within request4096, not a durable record or caller authorization flag. Sender cannot forge it; pending/unstarted lease transition defeats replay. Public delivery IPC remains IDs+nonce only; proof exists solely inside this peer-restricted protocol.

Broker derives tenant from durable occurrence and issuer `${configuredOrigin}/auth/${tenantId}`. Root-installed origin is validated canonical HTTPS; never take headers/JSON issuer. Keyless renderer must not call existing internalIssuer because internalConfig also requires the key.

## SQL and canonical owner boundaries

Broker uses existing app-role `readRecord`/`assertActiveCredential`. Decrypted credential structures require Auth-owned bounded validation and remain local. No Auth table SELECT or generic read/write/delete/revoke function is granted to sender. Auth owns any parser/helper extraction; report code does not duplicate identity-state rules. Current `deploy/identity-email/database.ts` grants report_target, start_report and finish_report together. Selected internal installation must instead explicitly **REVOKE report_target and start_report from the existing sender database role**, including retained grants on upgrades, and grant/retain only nonce-bound finish_report for this report path. Creating broker wrappers without revoking old grants leaves a direct start bypass. Do not change unrelated account/workflow-delivery grants or the compatibility installer default. Verify effective role memberships/PUBLIC grants as well as direct grants; a retained inherited target/start capability refuses activation.

Add nonce-bound wrappers analogous to0543's internal notification wrappers:

1. `app.internal_auth_report_target(id uuid,token uuid,origin text) RETURNS jsonb`: derive tenant/internal issuer; delegate full decision to existing identity_email.report_target.
2. `app.internal_auth_report_start(id uuid,token uuid,origin text,target jsonb) RETURNS boolean`: derive issuer; delegate existing target equality and transition to start_report. No verified/authorized bypass flag.
3. `app.employee_master_internal_render_context(id uuid,token uuid,origin text) RETURNS jsonb`: same target, stripped of sender-only identity/email; no proof/relay/credential/key.

These wrappers use app role, as0543 notification target/start do. Renderer shares that DB role: **SQL cannot distinguish these OS processes**. Its fixed executable/protocol/environment prevent broker/start requests, and it lacks key/proof. Existing app/key compromise remains a trusted-boundary compromise under ADR-0117; do not claim process-specific DB grants or protection from a compromised app holding a valid lease. Test actual action/HTTP refusal as well as SQL scopes.

Final verification requires a nonce-derived owner helper and **one explicit bounded transaction**, not optional locks around an earlier credential read. Derive both actors and their exact external-identity tuples from the authorized occurrence, lock the actual binding rows, and re-read/recheck issuer, subject, app_user, tenant, revocation and principal/profile-email state under those locks before canonical start. Lock and re-read the matching credential records and active email-state through canonical Auth owners in that same transaction. Removing, revoking or reassigning an identity between inspect and beginSend must refuse; checking credential version alone does not prove the external binding is unchanged. Caller cannot select subjects/record keys; return no ciphertext and expose no generic Auth-lock API or sender grant.

The exact acquisition order is an implementation prerequisite requiring a source audit of report occurrence/schedule/consent locks, Auth advisory locks and record writes, external-identity rebind/revoke, app_user/login and Personnel-email mutations. Publish one ordered lock map shared by all affected writers; do not simply assert occurrence-first then sorted records is safe. If a conflicting existing writer order cannot be reconciled within canonical owners, stop at that concrete design gap rather than add a second owner or weaken the recheck. Required concurrency controls cover owner and recipient independently, same-actor deduplication, binding removal/rebind and credential/relay updates, with bounded lock/statement/transaction timeouts. The transaction commits or rolls back and releases every connection on each response/error/disconnect path. No transaction or DB lock spans rendering, artifact transfer or SMTP.

Use central reservation **0552 / idx 552 / when 1791900000032** for a proposed additive migration after0543/0546/0549: explicit safe search_path, PUBLIC revocations, exact grants including removal of retained sender report target/start grants, preserved RLS/FORCE/restricted-owner behavior, no custom-GUC privilege broadening. Reservation is neither SQL implementation nor approval; do not edit frozen prerequisites, journal entries or allocate locally. No new credential/SMTP/consent/queue table. Optional retained relay/identity revision audit fields belong in this reviewed migration and contain no secrets/config copies.

## SMTP extension

Auth owns extraction of pure bounded credential validation, message/transport and active-relay shape-validation leaves as needed. They must import neither the app DB singleton nor web-session/Next code and must perform no connection, environment-loading or background work at import time. The broker composes canonical explicit-transaction reads with those leaves; no second credential/SMTP owner. Runtime Auth configuration/key injection belongs to the broker composition, not the sender or a supposedly pure validator. Preserve existing text/recovery/invitation callers/defaults. Add one bounded in-memory XLSX attachment and deterministic message ID: exact MIME/filename/size, one recipient/envelope, TLS validation/timeouts and file/URL access disabled. Sender constructs it from broker target and validated renderer bytes; no IPC accepts address/workbook bytes.

Auth's active-relay selector reads/validates email-state **inside broker** and returns only relayRevision/activeRelay. Operator drafts never leave. No draft activation/fallback or second SMTP state. Use the latest activated relay at final start; revision metadata is provenance, not separate authority.

## Lifecycle and unavoidable send interval

1. Existing sweep checks broker/sender/renderer readiness, queues and claims. Sender obtains broker target/proof and keeps only bounded per-attempt metadata.
2. Existing renderer creates workbook under scoped reads/version/access stamp; sender reauthorizes. Artifact names, budget, expiry, read-only sender access and renderer-owned cleanup remain.
3. BeginSend opens the bounded explicit transaction using the audited lock order: lock current job and exact owner/recipient external bindings plus canonical material; decrypt locally; recheck Auth credential/principal state, exact tenant/issuer/subject/user binding and recipient email against target, unchanged inspected target/credential versions and fresh consent/report/permission checks; choose active SMTP; canonical start; commit. All relevant reads use this transaction; no hidden singleton query may silently escape it.
4. Only after commit return active relay to sender for one attempt; existing private finish records outcome. Discard relay/proof; never log/persist them.
5. The unavoidable check-to-send interval begins at the **last relevant final check**, not only after committed start: checks, canonical start, commit, broker response transfer and SMTP are distinct steps. State held by appropriate row locks stays stable only until those locks release; any relevant state not protected by an effective lock can race immediately after its own check. Document those per-state boundaries honestly. Credentials/consent/relay may change before or during SMTP once their protection ends; SMTP is not transactional. Do not claim atomic revocation or a zero-length pre-commit race without a proven lock contract.
6. Lost broker reply after start, sender crash, DATA/lost ACK and uncertain finish retain durable started/uncertain and **never automatically re-send**. Broker connection failure cannot prove start did not occur. Pending expired jobs may get a new nonce. Adapt existing boolean start callback with per-attempt relay populated only by successful BeginSend; a lost reply must not be turned into an unstarted failure/retry.

Before-start proof/identity mismatch skips with existing concrete reason; unavailable broker/relay does not invent sent/failed acknowledgement. The factory currently accepts boolean start only: extend that internal dependency outcome to distinguish started, busy, unavailable, notEligible and recipientChanged, retaining existing finish rules and compatibility-adapter behavior. Do not collapse an explicit proof refusal into busy/pending and silently retry it with a new proof. A transport error whose start state is unknown retains durable-state authority. Preserve canonical SMTP rejection/temporary/uncertain classification.

## Installation, key and memory

Only broker uses the web principal's existing app-role DB and origin/key, through root-owned0600 config outside source and systemd injection. Installation must discover and explicitly bind the actual deployed web systemd unit, its effective non-root UID/GID (including resolved numeric identities), runtime, and authoritative private configuration source. The existing installer's AIHR_APP_USER/default ubuntu is not proof of the deployed web principal. Refuse absent/ambiguous units, root web execution, mismatched UID/config, or a source/build-tree environment fallback; do not create a guessed new key-authorized user. Probe must verify the broker runs as that exact UID and reads the intended origin/key/app-role configuration without returning secret values. Bundles/runtime are immutable/root-owned. Key never enters sender/renderer/runner, IPC, SQL, manifest, bundle or logs. This adds a process within the **already-key-authorized OS boundary**, not a new key-authorized principal. Same-UID app compromise/root remain trusted-boundary compromises.

Prove sender cannot read broker config/process environment and renderer cannot read config/key/socket through DAC and mount namespace. Use explicit allowlisted launcher environment and private config paths. Sender still holds usable SMTP credentials during its attempt; compromised sender misuse of those credentials is a residual trusted-transport risk, not an Auth-secret leak.

Keep outer aihrmanagedmail.slice768MiB. Proposed child **aihrmanagedmail-dispatch.slice192MiB contains sender AND broker combined**; renderer remains sibling512MiB. Giving each192MiB and calling384MiB compliant is wrong. One broker connection, minimal imports and prompt expiration reduce cost. Actual Node startup, sender+broker+20MB attachment peak, pressure/OOM and throughput are UNKNOWN until measured. Do not silently raise limits or charge broker to unrelated web budget.

Explicit internal installer reuses named sender/renderer identities/sockets, root staging/digest/atomic rollback, peer patterns, artifact group and probe, but requires no Keycloak clients/services/vaults. Preserve compatibility installer defaults. Broker service runs as explicitly reviewed actual web OS principal; sender owns its socket. PostgreSQL/private socket dependencies replace Keycloak only in selected internal installation. Runtime and activation strategy remain reviewed decisions; status proves actual broker/renderer/active relay.

## Consent, enrollment and acceptance

Use canonical currentProviderSession() in preferences: frozen Auth's Keycloak-only conditional passes null internally. Retain verified server identity, report-only default-off consent and exact user/employment/binding/profile-email/policy revisions. No browser verification flag.

Prepare fixed fictional canonical HR graph; expose exact administrator UUIDs. Use existing root-only scripts/internal-auth-bootstrap.ts or interactive deploy/internal-auth/bootstrap.sh for both actors; only owner gets installation SMTP authority. Human privately enters/changes passwords, enrolls authenticator, proves real OTP and retains recovery codes. No generated fixture MFA or direct Auth-record mutation stands in for actual acceptance.

Actual owner `/admin/settings/email` Save/Test/receipt/Apply uses real local TLS sink; no Keycloak. Preserve fixed disposable DB/addresses, marker/hashes, clean candidate, CA trust, watchdog/owned cleanup and existing cron. Keep key separate from DB-only cron env. Auth supports Node22.13+/24LTS; explicitly reconcile old Node20 fixture/runtime claims.

Required evidence:

- Real UDS sender positive; root/app/renderer/foreign peer, spoofed UID, unknown/oversized/arbitrary record/address/origin/path, stale nonce/proof refused. Responses/errors contain no credential/ciphertext/key/drafts.
- Actual roles and nonce controls: wrong tenant/lease, expired/replayed start, unchanged positive, sender generic Auth reads/writes refused; sender direct report target/start denied even after upgrade from retained old grants, finish limited to its nonce/status contract; migration owner/grants/FORCE rehearsal.
- Canonical credential disabled/must-change/MFA-incomplete/wrong issuer/binding/version and post-generation revocation; independently locked owner/recipient external-identity revoke/rebind races, shared-actor case, audited writer lock order and bounded lifecycle/cleanup; current relay revision; internal actual-session consent; both principals verified.
- Actual web-unit UID/config binding and pure Auth import boundaries; installed key/socket/config denial; measured **combined192MiB** and aggregate768MiB, crash/lost broker ACK/lost SMTP ACK/no automatic retry, artifact expiry/budget/removal acknowledgement plus owned-path absence, two real cron ticks.
- Actual login/MFA/SMTP receipt, report scheduling/save/reopen/exports. Broader required locales/themes/roles remain separately visible.

No usable dedicated VM exists. Named-DB bootstrap still hardcodes ai_hr and needs separately reviewed default-preserving selection. ARM Linux proof is separate from production x86_64/runtime proof. No VM/install/download/secret handling or runtime execution is authorized by this proposal.

## Ownership and decisions before coding

| Scope | Coordinated owner |
|---|---|
| Auth parsing/verification, relay selector/proof and pure SMTP attachment leaf | Auth, preserving defaults |
| Broker protocol/launcher, report adapter/renderer mode, installer/probe/fixture | Report, joint Auth review |
| Nonce SQL/locks/grants and optional revision audit | Report, reserved 0552 / idx 552 / when 1791900000032; not implemented or approved |
| Provider-session consent action/regressions | Parent/Auth |
| ADR/migration/runtime/integration/gate/release | Parent |

Before coding, close exact pure Auth APIs, proof/BeginSend contract, audited cross-owner lock order and same-transaction identity rechecks, effective sender target/start revocation, real web-unit UID/config binding, bounded DB lifecycle, retained revision audit, supported runtime and broker activation strategy. These are design requirements, not demonstrated feasibility. Central 0552 reservation confers no implementation approval. No code/SQL, ADR allocation, migration, test, bundle, VM, SMTP or acceptance run has occurred for this revision.
