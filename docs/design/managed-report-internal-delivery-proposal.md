# Proposed ADR: Embedded-authentication report delivery with an isolated sender

Status: Proposed, 2026-10-16. No ADR number or migration number allocated. Parent review and Auth-owner coordination are required before implementation. This document is source design, not an installation or acceptance receipt.

Reviewed baselines: report parent `20eb1440769ee0bbb72bceccf70c5a6faedc0037`; Auth frozen `ae7236713a3bc4393786c8c5d38140f9d93c4dd0`, read through Git without merging. This proposal completes approved Employee Master report scheduling under the owner's selected embedded authentication direction (ADR-0117). It retains the renderer and delivery boundaries of ADR-0119.

## Context and verified source facts

- Auth owns organization → tenant → credential subject → exact external-identity binding → existing application user → grants/person/employments. `lib/internal-auth/bootstrap.ts` selects an exact existing administrator UUID, preserves grants, and never links by email.
- Auth `lib/internal-auth/mail.ts` owns one encrypted `email-state` record containing active relay, revision and operator drafts. Save/Test/receipt/Apply is the authority for SMTP activation. `sendSmtp` uses implicit TLS, verified certificates, bounded timeouts, a fixed envelope, and disabled file/URL access.
- Auth `lib/internal-auth/store.ts` reads ciphertext through `app.internal_auth_read`. `crypto.ts` decrypts using `AUTH_SESSION_KEY`, with the exact record key as authenticated purpose. The same deployment key encrypts SMTP state, password hashes, MFA secrets and other private authentication records.
- `assertActiveCredential` requires enabled, verified credentials with a password, completed initial password change and enrolled TOTP, then resolves the exact active HR principal. The shared notification adapter uses this owner today.
- Report migration0549 owns the nonce-bound occurrence target, current report/schedule/consent/principal checks, atomic start and durable finish. Queue/claim remain migration-owner operations. The report factory already checks before and after rendering and never accepts an address or workbook in IPC.
- The current installed sender is Keycloak-specific: mandatory provider client secrets, provider HTTP lookups, private vault relay, global issuer and a unit requiring `aihr-keycloak.service`. Its report renderer is a different UID using only the unprivileged app database role. Sender192MiB, renderer512MiB and aggregate768MiB are explicit configured boundaries, with runtime evidence still required.
- The current consent action in frozen Auth still obtains an identity only for Keycloak. Internal report opt-in cannot pass that action until it uses the canonical provider session.

## Decision proposed

Keep the existing occurrence queue and `createMasterReportDeliveryService`. Add an explicit internal-mode adapter in the separately installed sender. It uses the existing encrypted SMTP owner, not a second SMTP configuration or consent ledger. The renderer remains a separate UID, receives only validated occurrence/lease requests, and receives no deployment encryption key, SMTP credentials, migration credential or private-sender database credential.

Reject an in-web-process report sender: it changes the approved UID and memory boundaries. Retain the inactive Keycloak adapter as compatibility code; selecting internal mode must not initialize it, contact its provider or silently fall back to it.

All API names below are **proposed**, not present exports. No generic private-auth read grant is proposed.

## Actors, authority and stored graph

| Actor | Authority | Must not receive |
|---|---|---|
| Installation operator | Installs reviewed units/runtime, supplies the existing deployment key, selects exact DB and HTTPS origin | Human login/MFA secrets in logs or chat |
| Existing minute runner | Canonical good-standing scope, enqueue/claim under its existing owner connection | SMTP or deployment key in its cron environment |
| Private sender UID `aihr-identity-email` | ID/nonce-bound delivery, bounded authentication material, active SMTP transport | Migration connection, direct HR-table access, generic authentication-store reads/writes |
| Renderer UID `aihr-report-renderer` | Nonce-bound scoped report reads through `ai_hr_app`, bounded artifact creation/removal | `AUTH_SESSION_KEY`, SMTP/private-mail credentials, arbitrary paths/subjects |
| Report owner and recipient | Existing live user/person/employment/grant and sharing rules | Authority inferred from matching email |
| Recipient | Explicit report-category consent tied to exact identity and employment | Implicit workflow-email consent reuse |

The durable occurrence continues to freeze report owner user, recipient user/employment, report version, schedule revision/digest, authorized companies and exact consent/policy revisions. Neither addresses nor SMTP passwords become occurrence authority. Authentication subjects come from the live, exact internal-issuer bindings of these users. Missing or multiple eligible bindings refuse; there is no first-match or email lookup.

## Narrow SQL material boundary

Add an additive migration after the centrally reviewed prerequisites. Do not edit frozen0543/0549 or self-allocate a number. Use owner-created `SECURITY DEFINER` functions with `search_path=pg_catalog,public,pg_temp`, explicit PUBLIC revocation and named grants. Preserve FORCE/RLS and restricted-owner behavior of existing report functions; do not grant custom-GUC SET privileges.

Proposed functions:

1. `identity_email.internal_report_target(occurrence_id uuid, lease_token uuid, origin text) RETURNS jsonb`. Resolve the tenant from the current pending, unexpired, unstarted lease. Construct issuer as `origin || '/auth/' || tenant_id`; delegate the full eligibility decision to existing `report_target`. `origin` is fixed root-installed public configuration, never an IPC/form field. Reuse the same canonical HTTPS-origin validation in installation/source; no arbitrary issuer request is accepted.
2. `identity_email.internal_report_auth_material(occurrence_id uuid, lease_token uuid, origin text, lock_material boolean) RETURNS jsonb`. After the same target checks, return only the two exact bound `credential:<subject>` ciphertexts, their authenticated record keys, exact principal/binding metadata and the single `email-state` ciphertext. Subjects/record keys cannot be supplied by a caller. Require unique internal owner and recipient bindings, exact tenant and active principal; owner and recipient may legitimately be the same identity. Enforce record-size limits, row expiry and deterministic ordering. For the final attempt lock the occurrence first, then distinct authentication record keys in sorted order with `FOR SHARE`; no HR-business values or unrelated credentials are returned.
3. `identity_email.internal_report_start(occurrence_id uuid, lease_token uuid, origin text, target jsonb) RETURNS boolean`. Recompute the tenant-derived issuer and delegate to existing `start_report` in the same transaction as final material verification. Existing target equality, report/schedule/consent checks and atomic pending→started transition remain authoritative. This accepts no `verified`/`authorized` flag.
4. `app.employee_master_internal_render_context(occurrence_id uuid, lease_token uuid, origin text) RETURNS jsonb`. Return only the existing keyless render context, deriving issuer through the target wrapper and stripping sender-only identity/material. Grant only this context seam to `ai_hr_app`; never grant material access to that role because of the renderer requirement.
5. `identity_email.internal_report_relay_state() RETURNS text`. A deliberate fixed-record status exception: return only the bounded `email-state` ciphertext to the private mail login, with no arguments or arbitrary record selector. The existing sweep checks readiness **before** queue/claim (`core/employee-master-delivery.ts:16–18`), so requiring a nonce for status would introduce a bootstrap cycle or change unavailable-relay scheduling semantics. The sender decodes this one record through the Auth owner and returns only `{version:1,ready:boolean}` to IPC. All credential reads and final send material remain nonce-bound. An unavailable relay must keep the current pre-queue refusal behavior. A status call cannot retrieve a credential, a subject, a draft or SMTP config through IPC.

Grant the four private functions only to the existing restricted mail login through the private installer; retain queue/claim as owner-only. The material/status functions internally read `app_internal_auth_record` as their owner; the mail login gets no table SELECT and no EXECUTE on `app.internal_auth_read`, write, delete or revoke. Existing finish can be reused without a provider parameter. A SQL test must prove the narrow gate itself with a valid app/mail-role context, not merely observe unrelated RLS refusal.

The lock option belongs to this private SQL function only, not public delivery IPC. Source review must reconcile its lock order with Auth writes and existing start/finish before runtime concurrency tests. Do not hold this transaction during workbook generation or network SMTP.

## Canonical Auth-owned decoding and verification

Auth owns the following proposed reusable seams; the report adapter must not reimplement their rules:

- Factor the credential's active-state predicate from `assertActiveCredential` into a shared server-only owner helper. The existing function retains its canonical principal lookup/default behavior. A bounded sender helper applies that same predicate to the decrypted exact material plus the SQL-proven binding/principal, requiring subject, tenant, issuer and user equality. Recipient credential email must equal the current report target email; both identities must be verified and fully enrolled. No caller-provided role or principal is sufficient.
- Decode material with the existing `decryptRecord` and exact record key. Validate the complete bounded credential structure and relay state; malformed, expired, missing, disabled, must-change or unenrolled records refuse. Do not interpret a generic TypeScript cast as runtime validation.
- Factor the SMTP message/transport implementation from `mail.ts` into an Auth-owned server leaf that does not import the app DB singleton or web-session APIs. Keep existing text/recovery/invitation callers unchanged. Extend the typed internal message with a single bounded in-memory XLSX attachment and deterministic message ID. Preserve filename/content-type/byte-size limits, one recipient, explicit envelope, TLS validation and disabled file/URL access. The report orchestrator supplies the canonical target and renderer output; no public IPC accepts this message type.
- A sender helper decodes the existing `email-state`, selects only its active relay and returns its revision. It does not activate a draft, choose a different relay, echo credentials or persist a parallel SMTP state.

The material SQL returns ciphertext, not plaintext. It cannot filter encrypted `email-state` down to the active relay: the existing single record also contains operator drafts. The sender necessarily decrypts that bounded record and discards drafts without logging them. Claiming an active-only ciphertext read would be false. Splitting active SMTP into a separately encrypted canonical record would require a coordinated Auth storage transition; it is not part of this minimal proposal.

## Delivery lifecycle and fresh checks

1. Existing owner sweep queues/claims; IPC remains exactly `{op:'sendReport', occurrenceId, leaseToken}` or status. No caller address, origin, user context, subject, attachment, arbitrary path or key.
2. Internal sender resolves canonical target and bounded material. Auth verifies both exact credentials and current bindings. Readiness means usable current active SMTP and installation configuration; a status request must not receive authentication ciphertext.
3. Existing isolated renderer generates the real workbook under the recipient's scoped read snapshot and report version. Access-stamp checks remain before and after generation. Artifact naming, budget, expiry and renderer-owned removal remain unchanged.
4. Sender reauthorizes through the renderer. Immediately before SMTP, open a short transaction: lock current occurrence/material, decrypt fresh ciphertext, reapply Auth's shared credential checks, require unchanged selected target/identity and credential versions, select the fresh active SMTP revision, then call canonical internal start. If identity changed, finish skipped/recipientChanged; unavailable or invalid relay cannot manufacture a successful send.
5. Commit started before SMTP. Use the freshly resolved relay in memory for exactly one bounded send. No transaction spans the SMTP call. There is an unavoidable interval after commit in which an administrator may change credentials/consent/SMTP; this is not an atomic guarantee against changes after the final start boundary. Do not claim otherwise. The existing Keycloak check/start design also cannot atomically transact with its provider.
6. Existing finish records sent/failed/uncertain. A started crash/expired lease stays uncertain and never automatically re-sends. Pending expired leases may acquire a new nonce. Removal requires actual successful acknowledgement plus owned-path absence in the acceptance runner. SMTP failure classification remains the canonical report/notification owner, including accepted-DATA/lost-ACK uncertainty.

For active relay changes during generation, the final read uses the current activated relay; there is no silent fallback to an earlier draft/vault relay. Freeze that final revision in private attempt evidence without password/config copies. This is transport provenance, not a new SMTP configuration owner. Relay revision persistence may require a small optional occurrence/audit field, to be reserved centrally with the additive migration.

## Deployment key authority and unavoidable trade-offs

`AUTH_SESSION_KEY` must be supplied to the private sender through a root-owned0600 environment/credential file outside the candidate, matching the web installation's current key. It must never enter the minute runner, renderer environment, IPC, SQL, logs, bundles or fixture manifest. Root installs the file; systemd injects it only into the selected sender. The sender unit remains unprivileged, with immutable runtime, inaccessible web/private installation paths except required systemd-injected values, and existing192MiB budget. Renderer denies both the key environment variable and private config paths and remains512MiB; aggregate slice remains768MiB.

This deliberately expands the deployment-key trusted boundary from the HR application to the private SMTP sender. That key can decrypt any correctly obtained authentication ciphertext; it is not an SMTP-only or per-recipient key. Narrow SQL limits what the sender's login can retrieve but cannot reduce the cryptographic authority of the key, undo plaintext already held by a compromised process, or protect against root. Do not broadly grant generic store reads to make imports convenient.

The sender's material reader is read-only. Its SQL grants cannot alter passwords/MFA or create a session, and it receives no generic auth-write function. Key rotation/restore must update both web and sender through the existing controlled Auth process and revoke/restart as required; changing only one environment variable is invalid. A sender compromise requires deployment-key and SMTP compromise response, not just rotating its database password.

## Consent and installation changes

- Change report/workflow preference actions to obtain `currentProviderSession()` and pass only its verified server identity to the existing consent owner. Keep demo identity unverified and report consent default off. Test actual internal session opt-in, exact employment selection, stale/profile-email binding, disabled account and unrelated subject refusals.
- Internal installer must require explicit `AUTH_PROVIDER=internal`, validated origin/key, named restricted mail DB and separate `ai_hr_app` renderer URL. It must not require/create Keycloak services, clients, realms or vault state. Preserve compatibility installers/defaults unchanged.
- Reuse existing sender/renderer UIDs, sockets, peer validation, artifact group, immutable bundle staging, memory limits, rollback and isolation probe. Use a dedicated root-private `/etc/aihr/` internal sender/renderer configuration; renderer receives only public origin/provider mode and app-role DB. Adapt unit dependencies to PostgreSQL without Keycloak **only for this explicit internal installation**. Do not reset dependencies or migrate an existing installation implicitly.
- No new scheduler: the existing provision-runner job and good-standing checks remain the delivery source. No second queue, consent table, recipient directory, SMTP settings UI or key authority registry.
- Add the sender key/config denial to the actual Linux probe. Prove the renderer cannot read the file through DAC/mount namespace and cannot see the key in its environment; a missing variable alone is insufficient isolation evidence.

## Disposable acceptance adaptation

Retain fixed disposable DB/fictional addresses, root marker/hash/candidate guards, actual TLS sink, watchdog, owned cleanup, actual installed service execution and no production mutation. Remove Keycloak prerequisites/provider HTTP mutation cases; do not mock an internal provider.

Prepare canonical tenant/person/employment/login/grant facts first and output exact administrator UUIDs. Invoke existing `scripts/internal-auth-bootstrap.ts` or interactive `deploy/internal-auth/bootstrap.sh` for owner and recipient in one fixed fictional organization; only the owner is an installation operator. Password input remains private stdin/interactive and outside receipts. Wait for both actual `/login` initial-password/MFA journeys. Validate the resulting exact encrypted credentials through the canonical Auth helper, not fixture-created `emailVerified` flags, direct store writes or generated test OTPs.

Start the local TLS sink and use the actual enrolled owner's `/admin/settings/email` Save/Test/receipt/Apply path. Keep the key in a separate root-private Auth configuration; do not enlarge the existing DB-only cron `runner.env`. Add explicit internal-mode marker/bundle expectations. Auth documents supported Node22.13+ or24LTS for this release; update/review fixture and service runtime requirements rather than claiming the old Node20-only receipt covers it.

Replace provider-account revocation with real canonical credential/binding changes in the disposable graph, including disable, must-change/uncompleted MFA, version changes and wrong-tenant issuer. Use an Auth-owned controlled fixture seam or operator UI; no business/auth table manipulation masquerades as accepted behavior. Run actual attachment, post-generation permission/consent/identity revocation, temporary failure, lost ACK, process kill, pending reclaim, no automatic started retry, expiry/budget/size, measured cgroup peaks and two real cron ticks. Keep actual weekly/monthly builder UI and broader role/localization acceptance separate.

The named DB bootstrap still hardcodes `ai_hr`; a reviewed narrow database-selection extension remains necessary, preserving its default and safe identifier/password handling. No usable dedicated Linux VM exists yet. ARM Linux proof remains distinct from production x86_64/runtime evidence.

## Ownership, migration and implementation plan

| Work | Proposed owner |
|---|---|
| Shared credential active-state/material validation, relay decoder, pure SMTP attachment extension, key rotation guidance | Auth owner; default callers preserved |
| Nonce-bound SQL wrappers/grants and private sender internal adapter | Report owner, reviewed jointly with Auth |
| Keyless renderer context mode, explicit internal installer/units/probe and acceptance runner | Report owner |
| Canonical provider-session consent action and internal-session regressions | Parent/Auth coordinated narrow change |
| Migration number/journal, ADR number, runtime version, final integration/release | Parent, centrally reserved |
| Named DB bootstrap/wrapper | Separately reviewed installation scope; no edit yet |

No authentication tables or replacement mail settings tables are needed. One centrally allocated additive migration is required for nonce-bound helpers and any optional revision-only attempt evidence. It depends on0543,0546 and0549. Normal Keycloak defaults and unrelated enrollment paths must remain unchanged. Restricted migration-owner DDL rehearsal, exact grants/negative direct-SQL controls, wrong nonce/tenant/lease tests, concurrent revocation/start, unchanged positive delivery and actual Linux UID/memory/SMTP acceptance are mandatory. Source tests alone do not establish those outcomes.

## Decisions to close before coding

1. Parent/Auth acceptance of the sender holding the existing deployment key and the bounded whole `email-state` ciphertext (including encrypted drafts), with the fixed-record status read exception needed before queue/claim. This is the minimal design's explicit trusted-boundary expansion.
2. Auth's exact shared verification/SMTP leaf APIs and controlled disposable credential-revocation seam; proposed names above are not implementation claims.
3. Central additive migration/ADR reservation and whether relay revision gets a typed retained attempt field.
4. Supported integrated runtime selection and reviewed explicit internal-mode installer paths/unit override strategy. No VM, installation, key handling or cutover occurs from this proposal.

No source implementation, migration, tests, bundle, VM, SMTP or acceptance run has been performed for this proposal.
