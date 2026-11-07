# Access editor presentation under the canonical native owner

Status: isolated source candidate, not installed or qualified. Production held.

The real installation catalogue identifies `ai_hr_owner` as the NOSUPERUSER,
NOBYPASSRLS owner of `app.access_install_defaults(uuid,uuid)` and FORCE-RLS
`public.access_configuration`. The bootstrap body is still exactly
`3b4bd83bfef3d84a3af43885256e2187` (MD5). The uninstalled3103 guard's literal
`postgres` owner would refuse this valid predecessor. Changing an installation's
owners or weakening that guard would obscure the actual authority contract.

The appended3211 candidate derives the owner from the fixed native
`public.access_configuration` relation. Before any DDL it requires that owner to
be the current migration executor, the owner of fixed `public.app_user`, and the
owner of fixed `app` schema. The bootstrap's owner must be exactly this same
native identity. Function-only, relation-only and schema-only owner drift
refuses55000. This does not let a caller choose an owner or obtain SET ROLE.

Every remaining3103 predecessor guard is byte-equivalent: full original body,
ABI, argument/result names and types, language, namespace, SECURITY DEFINER,
settings, volatility, strictness, leakproof/parallel flags, cost/rows/support and
exact owner-only non-grantable EXECUTE ACL. Static inverse reconstruction of the
new header, declaration, canonical-owner predicate and one owner comparison
produces the complete original3103 bytes. No applied SQL is edited.

The private eligibility helper, factored bootstrap and RR/RO projection bodies
are unchanged from3103. The canonical bootstrap retains its Access barrier,
idempotence, default groups and grants, revision, recovery checks and durable
initialization event. The pure initialized projection checks current native
principal and `access.configure`; legitimate uninitialized status uses the same
actual durable bootstrap predicate. The helper remains unavailable to PUBLIC and
`ai_hr_app`; only the minimized existing editor DTO crosses the service boundary.
Commands, preview/CAS, history, money and exported service contracts are unchanged.

## Native owner component proof

The new test constructs the exact original739-migration component predecessor in
a unique disposable DB, then transfers only that DB's fixed public/app objects
originally owned by postgres to a unique restricted LOGIN. The DB is already owned
by that LOGIN. App schema, tables/views/sequences, enums/domains and functions are
transferred by exact captured native object identities; extension and special
owners are preserved. There is no `REASSIGN OWNED`, shared DB/tablespace mutation,
new business grant, RLS disable, FORCE-RLS waiver or superuser application caller.
The actual native `acting_as_owner()` owner policy must work under FORCE RLS.

Complete captured catalogues compare owners and exploded ACL grantor/grantee
identities after normalizing only the deliberate old/new owner substitution.
Native rewrite nodes normalize only their exact `:checkAsUser <ownerOID>` field;
other node bytes remain exact. Extension owners are additionally compared raw.
Policies, triggers, constraints, columns/column ACLs, types, indexes, rules,
defaults, native sequence parameters/last values, dependencies, DB-scoped shared
dependencies, default privileges, security
labels and shared role memberships are retained. Physical statistics/frozen-XID
counters are excluded from semantic relation comparison; RLS/FORCE, ACL and other
schema metadata are not. Every actual public/app table's ordered complete JSON
rows/count/digest must survive transfer. Shared role definitions and memberships
must also be unchanged by predecessor replay. After3211 only the two named new
functions and their exact object-rooted dependencies may be added, and only the
reviewed bootstrap predicate body changes on an existing object.

Proof then uses the real `ai_hr_app` LOGIN and `withTenant` through a fixture DB
adapter, plus the actual restricted native LOGIN, without fake transactions or
permission mocks. A canonical `setCompensation` command creates a nonempty salary
record whose full native rows must remain unchanged. Existing commands produce
nonempty memberships, delegation and three independent history operations. New
and frozen locked editor DTOs must agree. Held Access and History writers must
remain held while the new reader completes without an advisory lock, and the old
reader must still fail against the held Access barrier. Fresh denial, archive,
foreign tenant, role revocation between presentation and initialization, private
helper and SET ROLE refusal, RR write refusal, and concurrent bootstrap retain
native authorization, exactly-one initialization event and original IDs.

The locked postgres3.4.9 driver
(`mainwt/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/index.js`,
`parseOptions`) forwards the validated APP URL startup options to the native
connection. Actual settings are independently asserted on both LOGINs.
All native, APP, constructor and cleanup connections use20s statements and300ms
locks. The single300s native case owns construction, queries, full restoration and
unique DB/role drop before its first microtask; timeout interrupts sockets, drains
the owned operation through `onTestFinished`, and poisons any successor on abort or
cleanup uncertainty. Three deferred pure models verify construction cancellation,
restoration drain and refused successors. Pure models are not native proof.

## Integration gates

This candidate does not edit the migration journal or allocation ledger. Root owns
replacement of the uninstalled3103 suffix with3211 and the final source manifest.
The new native file already calls authenticated `admitSingletonTest` before any
fixture work. It is NOT YET REGISTERED at this isolated base: the existing
`controlled-database-v1` registry/controller integration and independent review
must happen before any hosted invocation; unknown profiles fail closed.

The739 component is explicitly not the installed stage706/707 lineage. Final
native-owner rehearsal of the entire actual installed prefix, fresh/populated
migration recovery and schema-owner parity remain separate required root gates.
No component result will be labeled proof of that complete lineage, zero Busy,
all-module speed, staging acceptance or release authorization.
