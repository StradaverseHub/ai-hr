# Internal report transport implementation and verification boundaries

Source-only implementation on `board16-internal-report-transport`, base `6facd79789ae2b773bbfff056c6804deff47b422`.
Requires Credit's canonical broker union `62c1d4b802bd1bc08506376e5f3ab9e558169fcd`, genuine Auth0543/e5 and
reviewed Report0549/0552. No migration, journal, Auth owner or broker composition is changed here.
No build/type/test/SQL/service/installer/Linux/SMTP execution has been performed for this source.

## One authority chain

Existing minute sweep → IDs+lease-only report IPC → dedicated keyless sender → private Auth broker
inspect → isolated canonical renderer → sender's bounded bytes/hash → broker direct renderer hash and
fresh explicit-Tx Auth/target/start → committed start reply → sender hash check → canonical pure SMTP
leaf → existing nonce-bound finish. Existing queue, consent, report versions and outcome audit remain
sole owners. No caller sends addresses, bytes, URLs, issuer, scope flags, Auth keys or SMTP settings.

`lib/employee-master-delivery-ipc.ts` chooses fixed `/run/aihr-internal-report.sock` only when the actual
server provider is internal. Other providers keep their old socket override/default and external agent.
The new sender serves only `/v1/reports`; it does not initialize Keycloak/settings/workflow adapters.
Existing recovery/invitation/settings/workflow SMTP behavior is unchanged. Internal workflow delivery
continues to use its existing Auth owner; this sender is report-only.

## Exact protocol and finite outcomes

The shared canonical schema is Credit's `lib/internal-auth/report-broker-model.ts`, not a transport fork.
`employeeMasterBrokerRequest(request)` launches only the immutable installed `report-auth-peer.py --client` with a key-, database- and CA-free environment. That bounded helper uses the fixed broker UDS, a strict4096-byte newline-framed request and512KiB canonical reply within a45-second sender deadline. Complete JSON or socket EOF alone is insufficient: Node waits for helper exit0 after exact whole-activation retirement.
Internal public delivery IPC allows240seconds; external retains180seconds.
Phase mismatch, unknown fields, close/error/timeout/partial/oversize response refuse without material.

- Status has no nonce or other field. Reply is only `{available:boolean}`. Sender combines that with
  renderer status. This proves relay/structural availability, never a recipient's eligibility or delivery.
- Inspect has occurrenceId+leaseToken. Canonical target/proof only; no relay. Broker owns exact identity,
  verified credential, consent, watermark and target validation; sender never looks up by address.
- Start has the same IDs, opaque inspectionProof and sender's expected fingerprint constraint. Broker
  fetches the authoritative renderer fingerprint itself; the sender digest is never authority.
  Only committed start returns exact target, manifest and active relay for one attempt.

Finite notEligible finishes skipped; generationFailed/attachmentTooLarge finish failed; explicit busy
or unavailable neither sends nor finishes. A lost/malformed start reply returns transport `unknown`,
with NO SMTP, finish, pending assumption or automatic retry. The durable queue alone decides reclaim:
expired started becomes uncertain. Unknown outcome is not a claim that start did or did not commit.

Sender validates one actual in-memory XLSX using the shared20,000,000-byte limit, fixed MIME and filename
rules. It validates row count0..50000 and exact company IDs; rendering keeps existing RLS/private-field
checks. Fixed UUID-derived O_NOFOLLOW artifact read checks regular file, UID, safe mode, single link and
stable descriptor metadata. Read allocation is bounded to recorded size+1; growth cannot cause an
unbounded readFile allocation. Broker manifest and actualBuffer are compared before SMTP; a mismatch,
changed target or invalid bytes is definite generationFailed even after start, OUTSIDE SMTP uncertainty
classification. Only the pure Auth SMTP leaf constructs the one-recipient envelope and bounded attachment,
with TLS validation/timeouts and file/URL access disabled. No monetary/employee row becomes email text.

SMTP ambiguity is uncertain with one attempt; explicit rejection maps to existing failed classification.
Lost finish acknowledgement does not reclassify a successful SMTP attempt or invoke another send.
Existing renderer-owned remove/expiry/budget and single-report handler remain; sender cannot unlink files.

## Linux actors and lifecycle

- Sender: existing `aihr-identity-email` UID, service primary group report-files. Root0600 environment
  includes only finish-role DB, canonical public origin/provider and renderer UID. No Auth key, credential
  records, provider management secret, generic Auth/target/start EXECUTE or HR/Auth table/column authority.
- Broker: exact existing deployed web UID/GID, not a guessed new principal. Unit-only SupplementaryGroups
  report-clients; no global web membership in client/artifact groups. Root0600 broker environment supplies
  the already-authorized key and app-role DB. It is the existing key authority boundary, not a new owner.
- Renderer: separate UID, keyless app-role DB and canonical origin; no SMTP/Auth key/private sender DB.
  Internal resolver calls the0552 internal render wrapper. External issuer/default behavior is retained.
  Renderer DB role shares the app role; SQL alone does not distinguish these OS processes. Fixed code,
  closed phases, lack of key and OS isolation are the accepted boundary, not separate DB grants.

Internal renderer socket is0660, mail owner and dedicated report-clients group. Broker can authorize only;
mail retains render/status/remove. External installed copy remains0600/mail-only by default. Broker socket
is0600/mail owner. Python supervisor reads actual SO_PEERCRED and accepts ONLY that positive mail UID,
never root/self/renderer/unknown/spoofed JSON identity. It allowlists child environment and trusted peer
fields, caps input/output, kills/waits the child process group on timeout/error and emits no partial reply.

Supervisor buffers the complete reply and waits broker Node exit0 after canonical pool.end. The supervisor still carries its initial Auth key, so its socket EOF is not sufficient retirement evidence. It sends a strict safe transport envelope plus one read-only cgroup directory descriptor through SCM_RIGHTS; canonical business JSON/schema remain unchanged. The keyless client validates the live descriptor against the cgroup-v2 mount device, root ownership/read-only mode, exact dispatch-slice broker-unit path and its systemd InvocationID/ControlGroup. Already-deleted, foreign, extra, missing or truncated descriptors refuse. An ACK pins the live activation before the supervisor may exit.

After EOF the client requires that same kernel cgroup to become empty and the exact activation to be inactive/failed, or demonstrably collected/not-found. A previously validated inode collected after the ACK qualifies only through its deleted kernel descriptor plus unit not-found; an arbitrary missing path or new invocation cannot qualify. Cgroup events, systemd queries and total retirement wait are bounded; inaccessible/ambiguous state refuses without a timing/PID fallback. Only then does it print canonical JSON, exit0 and allow Node to start MIME/TLS/SMTP. The helper has no Auth/store/relay authority and remains in the sender's existing combined slice. A self-pidfd would miss surviving unit descendants and is not used as whole-unit proof. This is source implementation, not observed Linux retirement or peak-memory evidence.

Sender and broker each have192MiB per-unit caps AND share `aihrmanagedmail-dispatch.slice`192MiB combined.
That nested slice belongs to existing outer `aihrmanagedmail.slice`768MiB; renderer is512MiB sibling.
Both internal Node heaps are96MiB. Missing legacy Keycloak/vault paths are optional inaccessible
paths in the internal installed copy, so no legacy base installation is assumed. This follows the
[systemd upstream execution documentation](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml):
a minus prefix ignores a missing path; existing paths remain inaccessible. Actual installed behavior is unrun. Actual combined RSS,20MB workbook/MIME peaks, startup latency, pressure,
OOM, crash and throughput are UNKNOWN until measured on Linux. Limits have not been raised to hide failure.

A compromised sender necessarily holds usable active SMTP relay material for one attempt and can misuse
it outside this protocol; hash comparison does not restrain a malicious sender with that credential.
Root/web-key compromise remains trusted-boundary compromise. Final checks/start/commit/reply/SMTP are
separate steps. State can change after locks/checks release; no atomic revocation-through-SMTP claim.

## Explicit installation prerequisites and commands (NOT RUN)

Use only a reviewed disposable Linux/systemd host for first acceptance, named fictional database and TLS
SMTP sink. The [staged Linux fixture](managed-report-acceptance.md) now targets genuine internal-mode human
enrollment/SMTP setup. Its source adaptation supplies no execution or acceptance claim.

1. Parent integrates real Auth0543/e5, broker62c and this transport plus0552 journal union. Run full types,
   focused tests and migration/restricted-role/concurrency rehearsal under coordinated locks. Broker files
   are absent from this branch until union: do not create stubs or fake Auth schemas to make it build.
2. Have a real active systemd web unit with fixed non-root User/Group and internal provider. Canonical
   Auth bootstrap, password change, actual human TOTP and existing SMTP Save/Test/receipt/Apply are separate
   required setup. This installer creates no Auth credential, approval, consent, schedule or mail.
3. Provision a separate LOGIN aihr_identity_email with strong private password and CONNECT to the exact
   application database, no memberships/ownership/HR/Auth privileges. All privileged grant checks/mutation/rollback use the separately supplied, authenticated owner URL
   through one explicit max1 driver pool, never runuser/psql or a default Unix-socket cluster. Before
   any grant mutation, it proves exact database, report table, identity_email schema and all three
   touched function owners on that endpoint. No migration URL is taken from the web environment.
4. Supply a reviewed root-owned supported Node22.13+ or24LTS binary. Builder bundles targetnode22, no
   import.meta or top-level await. Existing external Node binary is not replaced. No download occurs. If the actual running web has NODE_EXTRA_CA_CERTS, installer requires its
   root-owned regular single-link source and every ancestor to be non-writable and non-symlink. A bounded
  256KiB/256-certificate bundle is parsed in full using X509Certificate; private keys, other PEM blocks
  and unparsed material refuse. Only that public material is copied to root-owned runtime CA and
  sender NODE_EXTRA_CA_CERTS. No caller CA override, TLS disable or broker key propagation is allowed.
5. In the clean reviewed candidate root, run only after explicit resource handoff:

   pnpm exec tsx deploy/identity-email/build-internal-reports.ts

   Review printed installer/component SHA256 values. Copy the generated self-contained installer and
   Node binary to trusted root-owned paths. Set root-private AIHR_INTERNAL_REPORT_WEB_UNIT to the actual
   unit, AIHR_INTERNAL_REPORT_NODE to that reviewed root-owned binary and
   AIHR_INTERNAL_REPORT_SENDER_DATABASE_URL and AIHR_INTERNAL_REPORT_RUNNER_DATABASE_URL from a private
   operator environment; never print their values. Runner URL must be the genuine existing owner of
   public.custom_report_occurrence on that same exact database, supplied separately, never derived
   from the web configuration. Installer writes root0600 key-free runner.env with canonical quoting parsed as data by the root launcher.

   /path/to/reviewed/node /path/to/internal-report-upgrade.cjs --install-internal-reports

Installer proves actual loaded/active unit, non-root fixed User/Group/MainPID, `/proc` UID+cgroup and
unchanged PID; takes key/origin/app DB solely from that running web process environment. It does not source
caller/build-tree files or accept key overrides. Running web must not hold migration authority. This is
an installation snapshot: controlled Auth key rotation requires corresponding reviewed broker config
refresh; changing a key independently is not supported and will make decryption refuse.

All runtime/config ancestors are trusted/root-owned, no symlink/writable parent accepted. Bundles are
hash-checked, fixed filename set, staged atomically; root-private backup contains prior files. Existing
renderer/artifact identities are checked; no global web group additions. Installer selects same exact
local DB and app role, verifies non-ownership/non-membership, revokes direct sender target/start then
checks effective PUBLIC/inherited/Auth wrappers and table/column access. Forbidden effective grants
REFUSE installation; it does not broadly revoke global PUBLIC privileges or unrelated workflow grants.
Rollback restores captured old files, prior socket activation/enabled state and old direct external
report target/start grants; newly added finish/schema grants are removed when absent before installation. New dedicated system users/groups and empty state/config directories
may remain after a refused installation; no existing data is removed. Root must inspect before retry.

6. Installer prepares, but DOES NOT ACTIVATE, the report-only tick. Use the separate reviewed
   [scheduling handoff](managed-report-scheduling-handoff.md): prove the deployed default guard,
   review the full scheduler inventory, pause/drain legacy processes and publish the exact owned cron
   file before active admission. Existing user crontabs/Node20 remain unchanged. The root launcher
   parses only the root0600 closed env as data, clears supplementary groups and drops to the existing
   cron owner's UID/base GID before loading application code. No owner URL enters argv or logs.
   The default process remains key-bearing for its other jobs; only its report stage is suppressed.
   No installation, process/cron drain or real Linux acceptance is established by this source.

7. Explicit post-install probe, still no SMTP/report rows:

   sudo /usr/bin/python3 -I /usr/local/lib/aihr-identity-email/verify-internal-report-isolation.py --web-unit actual-web.service

This probes real UID/socket/DAC boundaries, source-declared memory/slice limits and fresh owned artifact
read-only access. It does not prove actual rendered nonce authorization, broker pool-close/exit ordering,
peak memory, hidden process environment denial, crash/no-retry or SMTP outcomes. Those require separate
controlled actual-provider fixtures and two real cron ticks. No production activation is implied.

## Required verification, all UNRUN here

Full tsc; six focused files employee-master-internal-{transport,broker-client,install}.test.ts and
employee-master-report-bytes.test.ts, employee-master-internal-ca.test.ts and
employee-master-internal-grant-owner.test.ts; existing managed-delivery/artifact/single-handler/SMTP tests;
Credit broker/Auth tests; real0552 restricted role/concurrency/compatibility tests. Source guards are
cross-file checks, not Linux runtime evidence. Linux acceptance must cover caller spoofing/unknown fields,
root/self/foreign peers, missing/revoked/stale identities/consent/watermark, relay Apply races, artifact
hash/length/type mismatch, exact actual attachment, lost/partial start reply, process crash/expired-start
no-retry, actual effective grants/DAC, cleanup acknowledgement+absence, combined192/outer768 peaks and
installation rollback. Preserve fixture-vs-human evidence and ARM-vs-production x86 runtime distinction.

## Endpoint regression correction

The first installer source962 used TCP probes but local psql without an explicit host for privileged
grants/checks. A different default Unix cluster with the same database/port could have been changed,
leaving the actual sender endpoint unsafe. That implementation is replaced before execution. The
privileged path now uses the explicit, separately supplied runner-owner URL for proof, mutation,
effective privilege checks and rollback; no local psql exists. URL equality with the canonical app
endpoint and exact touched-object ownership are mandatory. This is the reviewed explicit-authenticated-
endpoint course, not a claim that a normal app role can read PostgreSQL cluster system identifiers.
Focused injected-connection tests cover wrong endpoint refusal before connect, proof-before-mutation,
all operations/rollback on the same selected owner and guaranteed pool cleanup. Actual database and
privileged installation regressions remain UNRUN and required.

Retirement acceptance still requires a held real broker activation: complete JSON/EOF while that cgroup is populated must produce no SMTP connection. Record exact invocation/cgroup retirement and the local sink's first TCP accept on one monotonic clock, and prove retirement precedes the first connect. Exercise descriptor/metadata drift, invocation reuse, unavailable systemd/cgroup state, partial/lost start replies, deadlines and no automatic resend. The root isolation probe now checks a pinned, genuinely key-bearing web process from the actual sender and renderer proc-mount namespaces with their real UID/GID/groups captured from the pinned process status, never the reusable account's passwd GID. Mixed/nonreproducible IDs or credential changes across the probe refuse; denial must coexist with root-confirmed target lifetime. It emits no key/environment bytes. Actual probe execution remains unrun.
