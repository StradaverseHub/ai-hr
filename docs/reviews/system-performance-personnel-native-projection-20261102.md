# Personnel native projection: qualified private current-actor plan

Private source1c7b1c282940652763dd9d6338eac7a53f62c3c2 /
[41478857295](https://github.com/StradaverseHub/ai-hr/actions/runs/41478857295)
passes all four selected native tests and the whole compiler. At8,192 permitted
records, same-run mean native reads fall8,800.47→482.92ms with the wide interface,
311.40ms with a bounded variant. These are component measurements, not application
integration, rendered-page p95, millions of Personnel records or500-user acceptance.
All public functions stay unchanged; only disposable private helpers implement the
experiment. System Optimization remains outside release admission. No full-load
repeat, provider binding, staging action, migration allocation or deployment.

## Measurements and causal distinctions

Four alternating-order rounds compare the unchanged owner, statement-proof reuse,
reordered subject construction, a proof-gated current-actor path and its bounded
variant. All comparisons assert full JSON equality and independent IDs/counts.

|Permitted records|Unchanged owner|Proof-only wide|Reordered-subject wide|Current-actor wide|Current-actor bounded|
|---|---|---|---|---|---|
|512|561.66ms|171.13ms|149.70ms|36.79ms|58.91ms|
|8,192|8,800.47ms|2,656.23ms|2,295.57ms|482.92ms|311.40ms|

The wide/current-actor plan lowers elapsed time94.51% against the owner in this run;
bounded96.46%. All four wide reads are477.68–489.69ms and bounded306.19–317.09ms,
below the diagnostic1,000ms single-read budget. This does not establish the original
HTTP/browser/500-user threshold. Do not compare percentages across different runs,
fixtures or the older0676 permission model.

A separate8,192-record sample counts8,196→3 principal proofs and8,194→0 repeated
per-record actor-eligibility queries for wide/current-actor. The actor is still
validated by the native proof; the complete target/profile ceiling remains. The
bounded variant retains26 original wrapper/actor checks for its25 wide rows plus
the actual reporting manager. Nested times overlap: they are not additive CPU or
exclusive wall-time attribution.

Configured-profile512-record means are210.85ms proof-only,211.56ms reordered and
87.95ms current-actor. Configured subject construction and the entire typed rule
matcher remain active; there is no duplicate profile precheck. One additional
profile lookup for a deliberately void-person target reflects lookup reordering,
not a second lookup per valid record. PostgreSQL peak757,817,344bytes, zero OOM/cap
events, unchanged standard hosted execution/profile2/JIT/240-second test bound.

## Semantic boundary

The existing zero-argument `principal_snapshot_current` proof includes the removed
per-record eligibility condition for the actual current user/tenant: an existing,
nonarchived account with `login_blocked` false. The inspected account helper uses
`current_date`; no changing wall-clock predicate is assumed constant. A MATERIALIZED
CTE computes the existing STABLE proof for this statement. A CASE gate controls all
calls to the private actor-proven helper with fixed current user/tenant arguments.
There is no caller-supplied `authorized` flag or permission cache between statements.

Only that closed current-actor path can omit the duplicate eligibility query.
**The general recipient matcher keeps its actor check and remains byte-identical.**
Do not replace it with the actor-proven body: configuration callers may evaluate
another recipient, whose eligibility is not proved by the current actor's proof.
The private underlying helper has no APP execute grant; a real APP call refuses42501
and rolls back. Granted test projection/ceiling wrappers bind the actual current
context and enforce the native proof before reaching it.

The subject plan performs the same single profile lookup before subject construction.
Without an assigned profile, the former17-field JSON is only needed to establish
that the employment/person belong to the requested tenant and neither is void.
The new branch checks exactly that validity. For configured profiles, the complete
original subject projection, revision/enable/retire checks and typed rules remain.
Employee, reporting-manager and company/purpose predicates are retained. Runtime
hashes guard the supplied principal, general matcher, subject and projection bodies.
PostgreSQL16 documents the statement-snapshot and repeat-call contract for STABLE
functions ([function volatility](https://www.postgresql.org/docs/16/xfunc-volatility.html));
native mutable-authority/error tests supplement that semantic argument.

All26 projection comparisons and37 null/missing/foreign/void/date matcher cases
pass, along with actual APP role, exact page IDs/order/counts/status facets/filters,
manager hiding, malformed-grant SQL errors, native22012 rollback and recovery.
Later statements of the same physical transaction observe profile changes, new
assignments, role revocation and actor rebinding. The three actual read-only RR
snapshot tests pass. Public definitions/full pg_proc attributes, owners and ACLs
compare unchanged after all private helpers are dropped.

This is a simple fictional organization and a gender-profile configured timing
sample. Full17-field/date/hierarchy/sort-tie/closed-write/transaction-birth and live
installation ownership qualification is still required on the combined current
source. Owner-seeded retained/negative fixtures do not prove hiring or void-command
throughput. The all-equal owner assumption was asserted only in the disposable
fixture; installed privileges, RLS ownership and the final private API are not inferred.

## Ownership, review artifact and exact missing publication

The private experiment uses published7cfcebef22e7b2acfcd7a7ea86de35a5059ef1bd, before
an unrelated incomplete financial migration. Its complete0936, projection section,
read-snapshot wrapper and Access lock owner match published605baf23. The latter fails
migration and compiler prerequisites below. Latest read-only local owner observation
is cleaneaab8f346c5991005b196c77af0e4d5029ad2ea9, but remote still resolves605b.
Its complete0936 and projection section remain identical; other contracts differ.
No foreign WIP/source is copied or independently edited, and no handoff is inferred.

|Absent from published605b|Local introduction, not a cherry-pick instruction|
|---|---|
|0939 `app.access_current_capability_source(text,uuid)` / Workforce operation owners|180c2c0bf371dbfebb46596c93c818fa96b247da|
|`lib/access-action-presentation.ts`|620f6f618d2d911e12d438aa37d8312bdba07fc6|
|`deploy/access/function-action-contract.ts`|d582c3224e027836da246f9fbc6e561d06ba6647|

Later dependent owner commits also exist. These three introductions alone are not a
complete candidate. Adoption needs owner incorporation or an explicit frozen seam
in a complete published candidate, preserving the final private API/owner/ACL boundary.

Prepared privately, not applied:
`/private/tmp/aihr-personnel-current-actor-proposal-20261103.md` and its derivation
receipt `/private/tmp/aihr-personnel-current-actor-proposal-identity-20261103.json`.
The artifact contains the exact tested temporary helper/projection/wrapper logic;
it is not a production migration. Artifact SHA256:
`8d12e5ebc15d464d3ee113cd531b8b07f08bdc3aeb0d48d052b1a09c55181fa2`.
Private helper body SHA256:
`5c6b35385c04bc0d7fb9e58bb31713591f62d77d1d34b272710a7aa3464282b8`.
Private projection body SHA256:
`cda2699e0fad943241413bccfbfa5f588637847a316030eb75f10e40a0c5ae89`.
The earlier, simpler statement-proof-only review patch remains preserved under
`/private/tmp/aihr-personnel-statement-proof-605b.proposed.patch`; it is not relabelled
as the current actor-proven implementation.

## Retained attempts and original failures

|Frozen source / run|Disposition|
|---|---|
|4b2032670 / [41465947112](https://github.com/StradaverseHub/ai-hr/actions/runs/41465947112)|FAIL before native tests: inherited0941 missing helper; compiler FAIL on two missing owner modules.|
|13bff41dd / [41466679502](https://github.com/StradaverseHub/ai-hr/actions/runs/41466679502)|FAIL:240s native timeout after22 comparisons; three inherited snapshot fixtures fail23502 from missing fictional emails. Partial512/4,096 timings show no relevant bounded-only gain.|
|da3b6f40f / [41469030254](https://github.com/StradaverseHub/ai-hr/actions/runs/41469030254)|Overall FAIL: missing test statistics extension. Three repaired-fixture snapshot checks and whole compiler PASS retain their exact source.|
|24cdd317c / [41469752734](https://github.com/StradaverseHub/ai-hr/actions/runs/41469752734)|Native26-case PASS after one-line disposable extension setup.4,096 owner3,215.04→proof-wide919.89ms; earlier compiler evidence not relabelled.|
|fa18aabbe / [41473236653](https://github.com/StradaverseHub/ai-hr/actions/runs/41473236653)|Native26-case PASS;8,192 owner8,307.91→proof-wide2,389.80/bounded2,185.83ms. All exceed1s: budget FAIL despite functional PASS.|
|96a7e260a / [41475782350](https://github.com/StradaverseHub/ai-hr/actions/runs/41475782350)|Four native tests/whole compiler PASS;37 matcher cases added.8,192 proof2,670.45→reordered-wide2,304.90ms, bounded2,083.46ms: budget still FAIL. Configured209.48→210.26ms is within this four-pair sample's noise.|
|1c7b1c282 / [41478857295](https://github.com/StradaverseHub/ai-hr/actions/runs/41478857295)|Four native tests/whole compiler PASS; proof-gated current-actor results and boundaries above. Component only.|

The retained composed reader's65,536-record1s failure (2,212.63ms versus3,642.67ms)
and both original29f500-user failures remain unchanged. Neither private component
nor a workflow's functional PASS becomes capacity acceptance. No new500 pair follows
until an actually integrated frozen candidate has justified gain and all correctness
controls, with original routes, CRUD/processing/browser/audit/rollback/tenant/principal,
resources, thresholds, pacing and timeouts preserved. Both rejected formula plans
stay rejected. No provider-binding/source-consent authority transfers.

## Independent Home diagnosis from retained load evidence

Original29f artifacts retain three loaded Home failures in each profile, each with
nine timeout sections. Loaded initial Home TTFB is41.50–44.65seconds at1s activity,
44.78–50.13seconds at5s. Captured failed Home fetches number48/52, span
2,750.11–2,810.05ms /2,760.51–2,816.72ms and have no captured HTTP-error response.
They are consistent with the unchanged2,800ms client read deadline. Extra request
events lack phase IDs, so not all are assigned exclusively to the three rendered
alerts. The observer and deadline owner match original29f byte-for-byte.

This classifies retained failures; it is not a new load test or exclusive SQL cause.
The slow initial TTFB requires server rendering/auth/admission investigation as well
as card readers. Raising deadlines or suppressing alerts does not establish the
speed target. No app route, original workload, coverage or assertion changes.
