# Initialized Access editor presentation prototype

Source-only proposal based on `89d060c9046b239634a012cc4d13d914f3ec80c3`.
No numbered migration is reserved, no historical SQL bytes or application route are
changed, and no local app/DB/runtime/compiler/build check has run. Production held.

`test/prototypes/access-editor-presentation.sql` is installed only by the native
hosted test into its verified loopback worker database. Before any DDL, it pins the
complete canonical `access_install_defaults(uuid,uuid)` identity, argument/result
metadata, language, owner, exact ACL, settings, volatility/security/strictness,
parallel/cost/row/support flags and exact predecessor body. The frozen predecessor
prosrc SHA256 is `e0021fafd029ed723bfb97e7af52c80595eefd4188b887f6fcf70248b8a9ba2c`.
Any mismatch refuses; nothing infers equivalence from a function name alone.

The exact actual durable-administrator eligibility predicate is factored into one
private `_access_bootstrap_eligible(t,u)` helper. It uses native active/unblocked,
recovery-available login and real super-admin or tenant-wide HR role rows. The
installer changes only its predicate call; its first Access lock, initialized
idempotence, groups/grants/revision, recovery assertion and initialization event
remain. New helper execution is withheld from PUBLIC and the application role.

`app.access_editor_presentation_v1()` requires native RR/RO, current tenant/login,
live unblocked account and `principal_snapshot_current()`. An initialized tenant
additionally needs the actual current `access.configure` owner; role text is not a
shortcut. State and metadata are returned in the same snapshot through the existing
restricted projections. An uninitialized tenant returns exactly the typed
`uninitialized/null/null` row only for the same canonical eligible bootstrap actor.
Other actors/carriers refuse. The read function never writes or takes an advisory
lock. In particular, a SQL/storage42501 is not an uninitialized status.

The test-only TypeScript adapter validates the closed one-row discriminant and uses
the existing state/metadata parsers and exact editor minimization. Only explicit
native uninitialized enters the existing RC initialization command; a new RR/RO
transaction then rereads state. Missing/malformed rows or exceptions do not select
bootstrap. Neither the command store, preview, CAS nor production page is changed.

Prepared native proof covers:

- Exact initialized DTO parity against the old native editor, nonempty six-group/
  login state, held actual Access and audit-chain writers, no audit/data changes,
  no acquired advisory lock, native app role/RR/RO and actual write refusal.
- Changed predecessor metadata refusal, private helper refusal and invalid carriers.
- Legitimate uninitialized HR/super-admins produced by archived-role assignment then
  unarchive, without deleting configuration or disabling constraints; explicit status
  creates nothing. Concurrent bootstrap yields one initialization event, preserves
  role IDs and rereads a fresh snapshot. Employee/manager/company HR and an active
  future-undurable administrator cannot initialize or obtain metadata.
- Delegated native configure capability without an HR role, current individual denial,
  actual role revocation, archived account, forged grant and foreign-tenant refusal.
- Native metadata storage failure while Access is held never falls back to bootstrap.
- Real command CAS refusal, raw native last-administrator refusal and native audit
  failure rollback under the factored bootstrap owner.

All installed prototype functions are scoped to the owned disposable database;
cleanup restores and compares the exact original installer definition/metadata and
removes only functions this test installed. Temporary native fault fixtures restore
their owners in finally. Existing20s statement/300ms lock/30s case bounds apply to
controlled barrier work; no deadline increase or RLS disabling is introduced.

Use the adjacent focused manifest and hosted compiler/build after review. Results
are pending. No browser/API route uses this prototype, so it does not establish
rendered-editor or staging acceptance. Before adoption root must review/allocate
additive SQL, qualify populated predecessors/provisioning/recovery and integrate the
real page adapter, then run authenticated browser preflight and loaded acceptance.
The broader all-module barrier audit remains at its separate frozen checkpoint.
