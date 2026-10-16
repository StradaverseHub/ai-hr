# Internal managed-report broker composition

This source implements the application portion reviewed alongside0552. It is not a deployed service
or Linux/MFA/SMTP acceptance receipt. Sender, root peer adapter, supervisor, units and installer are
separately owned;0552 is integrated only into the isolated Auth/Board preview union.

## Closed protocol

The key-free shared leaf is `lib/internal-auth/report-broker-model.ts`:

- `{phase:'status'}` returns exactly `{available:boolean}` or a finite unavailable failure. It reads
  only canonical active-relay structure in an explicit transaction. It does not promise recipient
  eligibility, rendered-report access, SMTP delivery or human receipt.
- `{phase:'inspect',occurrenceId,leaseToken}` returns `{ok:true,phase:'inspect',target,inspectionProof}`.
- `{phase:'start',occurrenceId,leaseToken,inspectionProof,expectedArtifact}` returns
  `{ok:true,phase:'start',target,artifact,relay}` only after committed started and closed pool.
- Failures are `{ok:false,reason}` where reason is `notEligible`, `busy`, `unavailable`,
  `generationFailed` or `attachmentTooLarge`. No SQL/Error.message/private value is reflected.

Requests reject extra properties and are limited to4096 bytes. Replies are limited to512KiB. Target
is the existing strict MasterRenderContext plus its authorized recipient subject/email. Artifact is
only the shared SHA256/byte-length/XLSX-MIME DTO. Relay is the canonical active SMTP projection;
credentials, ciphertext, drafts, record keys, arbitrary paths and operator settings never leave.
`expectedArtifact` is a sender constraint, never authority to select a file or approve its bytes.

Inspection uses canonical Auth AES256-GCM with distinct AAD purpose `managed-report-inspection-v1`.
Its bounded strict payload includes version/purpose/canonical origin, occurrence+lease, issued/expiry,
target digest, accessStamp, separate owner/recipient issuer+subject+user+nullable Person+binding-created
instant+credential-version tuples, and active relay revision. Maximum lifetime60seconds and the
original nonce lease cap; proof is reopened at the last check after renderer/lock time. It contains no
password, factor, relay secret or final authority flag. The same owner/recipient remains two logical
roles. JSON digests sort object keys and preserve ordered arrays. Replay is refused by the durable
pending→started owner, rather than a second proof-consumption ledger. No unused final proof is minted.

## One final transaction

`lib/internal-auth/report-broker.ts` owns composition over an explicit transaction adapter. Start
opens the proof, calls the renderer's existing direct authorize/hash API and checks the independently
fetched manifest against the expected fingerprint **before BEGIN**. It never holds DB locks over RPC.
Then one READ COMMITTED/read-write transaction runs:

1. Verify actual ai_hr_app is non-super/non-BYPASS, owns no table/schema and has no memberships or
   role/database/replication privileges. Set5second statement timeout and250ms lock timeout.
2.0552 lock_context derives/locks canonical occurrence/report/schedule, exact identities/liveness,
   grants, consent/policy and fixed Auth credential/email-state rows. No caller identity/GUC flag
   replaces that proof. SQL owns lock ordering and finite bounded refusal.
3. Canonical readRecord(tx,derived credential key,true), new additive pure parseCredential and unchanged
   assertActiveCredential(tx,credential) validate both roles. Exact subject/issuer/tenant/user must agree;
   recipient verified credential email must match the current target. Owner email is not a recipient.
4. Canonical readActiveRelayTx(tx,true) selects active only; exact inspected relay revision, separate
   identity revisions, target digest and renderer accessStamp must still agree. No singleton/nested
   session, mail-state or withTenant read is used.
5.0552 start repeats current canonical target validation and atomically pins its fetched artifact.
   Every finite refusal throws inside the transaction adapter and rolls back. Unexpected storage or
   AEAD-record tamper errors propagate to the closed process failure boundary. Response schema is
   validated before commit; only committed started permits the active-relay response.

The additive Credential parser is a new structural leaf, not an extraction or new authentication
policy. It bounds types/strings/arrays using generous bounds covering current canonical writers.
Existing readers/signatures and assertActiveCredential behavior stay unchanged. It does not verify
passwords/TOTP again, mutate factors, default flags, widen grants or bypass enrollment.

## Isolated child contract

Entry: `deploy/identity-email/report-auth-broker.ts`; installed invocation uses the existing pinned
Node20 + tsx runtime. One stdin request, one complete stdout reply, then exit; no listening socket,
SMTP, server/session context or imported application singleton. Supervisor must validate socket EOF
and child exit0 before forwarding any reply. Lost/partial response cannot authorize MIME/SMTP.

Trusted root supervisor supplies only selected installed app environment: `AUTH_PROVIDER=internal`,
canonical `AUTH_PUBLIC_ORIGIN`, private `AUTH_SESSION_KEY`, unprivileged `DATABASE_URL`, `NODE_ENV`,
`TZ`, and kernel-derived `REPORT_AUTH_BROKER_UID`, `REPORT_AUTH_BROKER_PEER_UID`,
`REPORT_AUTH_BROKER_MAIL_UID`. Broker UID must equal getuid; kernel peer must equal selected mail UID
and differ from broker UID. No migration/private-sender/provider secret is accepted. The root-owned
supervisor/installer additionally binds the discovered actual web service UID/config; these child
checks alone do not attest the provenance of environment values or root installation.

The entry owns one postgres pool (`max:1`, bounded connection/idle/lifetime); every request transaction
also has an independent5second hard process deadline, and the child has a34second watchdog. Supervisor
owns its35second child/45second unit deadlines. A hard exit closes the OS connection; an uncommitted
transaction rolls back. A committed start with lost response remains started/uncertain, never a retry.
Pool.end completes **before** any relay-bearing JSON is written. No pool lives in a module singleton.

The sender must retain only finish_report for this path and revoke old target/start grants, including
inherited/PUBLIC capabilities. Shared ai_hr_app SQL cannot distinguish broker from a compromised app
holding a live nonce: UID/DAC/key and trusted executable separation are separate mandatory boundaries.
The unavoidable send interval begins at each relevant last check. Some accessStamp inputs are not
locked; final source-stamp equality does not promise atomic revocation through commit/IPC/SMTP.

## Verification prepared, not executed

`test/report-auth-broker.test.ts` uses real AEAD/canonical read/credential/relay leaves over captured
SQL to test closed variants, exact roles, tamper/domain/nonce/expiry, changed revisions and target,
renderer-before-BEGIN, fingerprint constraints, rollback/no-relay refusal, status minimality and the
runtime import graph. This is orchestration evidence only, not proof of PostgreSQL behavior.

`test/report-auth-broker-db.test.ts` requires actual Auth543+0552 journal union. It uses canonical
hire/report/schedule/consent, programmatic Auth enrollment/password/MFA and canonical settings
save/test/apply owners. Session acquisition and accepted SMTP test/receipt are fictional test adapters;
renderer response is the only broker dependency substituted. It checks separate identities, actual
pin/replay, live consent/binding/contact/archive/relay changes, pre-BEGIN fingerprint refusal and real
transaction rollback after start. It does not fabricate an Auth definer, ciphertext, active flag or
private role authority, and does not claim a human enrollment or actual SMTP provider receipt.

All new test sources are unrun. Semantic TypeScript, real PostgreSQL owner/concurrency behavior,
process EOF/UID/DAC/timeout/pool-close behavior, memory budgets, actual renderer RPC, installer grants,
Linux Node20, real human MFA/consent and SMTP attachment acceptance remain unverified. Existing0552
SQL tests cover additional row/advisory contention; their runtime result is a separate prerequisite.
