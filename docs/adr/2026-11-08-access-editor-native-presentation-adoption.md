# Adopt the native Access editor presentation boundary

Status: source candidate, not installed or qualified adoption. Production held.
Application base is exact `fe26d003b9750478e4d434cc9dd22b59092ae830`. Qualified
prototype `bbc5857aa111a949d5ad79752ce0bf22d80bc997` is merged normally, preserving
hosted42392922965 (four selected native files PASS). That historical prototype pass
does not qualify the changed production adapter or the numbered migration.

## Ownership and behavior

`readAccessConfigurationEditor` now delegates to the promoted purpose reader in
`core/access-editor-presentation.ts`. Initialized reads use explicit native RR/RO
and return the existing minimized DTO from one coherent state/metadata snapshot.
They do not join Access or History writer locks and do not invoke initialization.
The database purpose projection independently validates current principal/account,
native carrier and actual configure capability. HR role text grants no shortcut.

Only its exact `uninitialized/null/null` row admits the existing initialization
command in a separate ordinary RC transaction, followed by a new RR/RO read. The
adapter captures context/role/grant arrays before awaiting. Missing, duplicate,
unknown or malformed statuses, permission/storage/transport failures and a second
uninitialized result never silently select bootstrap. A42501 at any read or at
initialization maps to the existing `AccessPermissionError('ceiling')`; other errors
remain failures. This also preserves refusal if authority changes between phases.

The command store, preview, CAS/save, native last-administrator/adjudication, audit
rollback, role identities and navigation hint are unchanged. Existing state and
metadata parsers continue validating completeness and minimizing client props.
There is no new application permission, table grant or session authorization cache.

The promoted native application suite replaces the prototype installation suite.
Its setup requires functions from ordinary migrations and never installs/restores
the prototype SQL. The reviewed SQL remains a frozen comparison fixture only.
The old locked editor is retained solely as a test baseline for DTO/refusal parity.
All prior native held Access/History, no-advisory/no-write, carrier/helper/privacy,
concurrent bootstrap, future-undurable/nonbootstrap, delegated/denied/revoked/
archived/forged/foreign, metadata-failure, CAS/last-admin/audit-rollback cases remain.
The native between-phase role-revocation control supplements closed adapter protocol
tests; mock protocol checks do not establish native authorization or performance.

## Required migration and release evidence

Root allocated3103/idx2403/when1793330002703, SHA256
`bb171333ef940c173ac9ca0a647398116dfd8ee8dd87d77c8f59e92b0281fe47`,
in78693d761efdc309cb24f4cf146f55859ede820f; it is normal-merged without SQL edits.
Root owns the shared approved-upgrade identity integration. This child allocates
no ID and changes no applied SQL. The
complete bootstrap predecessor guard and its drift-refusal assertion move to the
actual populated migration rehearsal described in the adjacent qualification plan.
The actual populated native test pins all739 fe26 entries/SQL bytes, refuses the
real append with a deliberately changed cost101 predecessor, verifies full rollback,
restores only that fixture cost and applies3103 normally. It compares all preexisting
function metadata/bodies (only one exact predicate changes), every table row hash,
roles/grants/policies/schemas/sequences/ledger and actual before/after native DTOs.
No assertion is considered covered merely because the native function name exists.

The root-owned append has been reviewed and merged; independent final application/
migration review remains. Run the focused application manifest, actual
populated predecessor/guard rehearsal, complete compiler/build and affected upgrade
selectors. Preserve original prototype evidence without relabeling. Browser Access
initial load/reopen/delegated/refusal and held-writer/loaded acceptance remain separate
required evidence. No staging/production installation or speed claim is made here.
