# Personnel native projection investigation

This is private native-query evidence, not a source integration or release witness.
The retained reader still exceeds its one-second diagnostic read budget at65,536
permitted records (2,212.63ms versus former3,642.67ms); both original500-user
activity profiles remain FAIL. See the [retained reader review](system-performance-personnel-page-review-20261102.md).
No staging mutation, provider binding refresh, migration allocation or deployment.

## Ownership and causal source

Security owns `app.access_workforce_list_rows()` and the underlying subject/principal
policy. Published605baf23cac704409386ae55bbf37f5fd1f66d5b contains the new employee
and reporting-manager data-permission predicates. Read-only observed7f8d942b has an
identical projection section and complete0936 policy; other0938/DB-client contracts
have changed. Latest read-only owner observationef5be2d12295f0228fa53b3ff8faf38b22df1ce2 is clean locally but unpublished: remote remains605b. Its full projection section and complete0936 still match. Other owner work remains untouched; this is not a frozen handoff.

The605b snapshot cannot reach native tests:0941 references the absent
`app.access_current_capability_source` dependency. Its compiler also lacks
`access-action-presentation` and `function-action-contract` modules. These are
inherited snapshot failures, not proof against the query algorithm.

Published ancestor7cfcebef22e7b2acfcd7a7ea86de35a5059ef1bd precedes that unrelated
financial migration. Its complete0936, projection section, DB-client read-snapshot
wrapper and Access lock owner are byte-identical to605b. The private experiment
uses that complete ancestor, not selected migration omissions or foreign WIP.
Complete current-owner compatibility remains outstanding. Actual projection body
SHA256 is guarded at runtime:
`c46bc8f629c6c5f51675548e90bd2a8348feb1dc91f3a72c81d37a25a88db23a`.

All helpers are temporary test-owned functions in a disposable hosted database.
The public definition and full pg_proc attributes are snapshotted and compared
unchanged afterward. Private helpers use the same SQL/STABLE/SECURITY DEFINER/search
path boundary, receive only explicit APP execute rights, and are dropped. No shared
source function, grant, policy or applied SQL file is edited.

## Tested designs

The first design returns typed minimal rows for exact counts/filtering/status and
constructs the original wide JSON only for selected page IDs. It retains the complete
native FROM/JOIN/tenant/void and employee/manager permission predicates. It does not
show a relevant gain on the new permission model: partial matched means512 records
552.12→568.23ms;4,096 records4,372.28→4,270.60ms. It fails its unchanged240-second
qualification bound after22 passing comparisons, so it is not qualified or adopted.

The next design distinguishes that paging change from redundant principal work.
`data_permission_matches` is guarded to have the exact supplied wrapper body:
principal proof AND the complete per-subject matcher. A MATERIALIZED CTE evaluates
the existing zero-argument STABLE principal proof once per calling SQL statement;
every employee and reporting manager still uses the complete unmodified subject
matcher. A later statement creates a fresh proof. No permission result is retained
between statements, transactions, callers or requests.

This relies on the declared STABLE/read-only contract of the supplied SQL owners,
not an IMMUTABLE or application permission cache. PostgreSQL16 documents that STABLE
calls use the calling query's snapshot and can be evaluated once for identical
arguments ([function volatility](https://www.postgresql.org/docs/16/xfunc-volatility.html)).
Native revocation/rebinding/error controls must still pass before accepting the
transformation. Neither design is adopted merely from this semantic argument.

The comparison includes the original wide owner, the full-width statement-proof
variant, and the typed/bounded variant with that same proof. Full-width comparison
isolates proof factoring from paging. Alternating execution order, exact returned
JSON, independent page IDs/totals/status counts and native nested-call counters
separate evidence from a source-only theory. Nested execution times overlap and
must not be summed as CPU or exclusive wall time.

## Frozen attempts and recovery

|Candidate / run|Outcome|
|---|---|
|4b2032670 / [41465947112](https://github.com/StradaverseHub/ai-hr/actions/runs/41465947112)|FAIL before native tests: inherited0941 missing helper; whole compiler FAIL on two inherited missing modules.|
|13bff41dd / [41466679502](https://github.com/StradaverseHub/ai-hr/actions/runs/41466679502)|FAIL: prototype240s timeout; partial timings above. Three inherited snapshot tests fail setup23502 because fictional people omit required emails. Public function unchanged/helpers dropped.|
|da3b6f40f / [41469030254](https://github.com/StradaverseHub/ai-hr/actions/runs/41469030254)|Three snapshot tests PASS after fictional-email-only fixture repair. Native prototype FAIL on missing test statistics extension; whole compiler PASS. Overall workflow remains FAIL; partial readings are not qualification.|
|24cdd317c / [41469752734](https://github.com/StradaverseHub/ai-hr/actions/runs/41469752734)|PASS: all26 native comparison cases, same-transaction profile/role/actor freshness, rollback/error recovery, unchanged public definition/attributes and private helper removal. Sole diff fromda3b is disposable statistics-extension initialization; compiler/three snapshot passes retain their exactda3b source.|

The native test keeps all original cases within the same240-second bound: repeated
scope/transition controls use512 retained records before the4,096 timed population.
No case or assertion is removed. Additional controls cover actual APP role,
reporting-manager hiding, archived/foreign principals, actor rebinding, profile and
role revocation on later statements of the same physical transaction, malformed
grants, native22012 rollback and subsequent recovery. Exact name/company sorting,
filters, pages, counts, un-narrowed status facets and real foreign/empty scopes remain.
This is still a simple fictional organization, not every hierarchy/profile/date
combination, million-record acceptance or a500-user concurrency test.

Standard hosted runner, existing PostgreSQL profile2/caps, JIT on and original test
bounds remain unchanged. The native-only recovery retains the three unaffected
snapshot passes and leaves the planned frozen compiler undisturbed. Compiler and
native receipts are never relabelled to another source or promoted to release proof.

## Qualified component result

All native controls finish within the unchanged bound. Same-run four-pair alternating
means, in milliseconds:

|Permitted records|Unchanged wide owner|Statement-proof wide variant|Statement-proof bounded variant|
|---|---|---|---|
|512|406.45|121.17|135.32|
|4,096|3,215.04|919.89|859.68|

At4,096 the wide variant reduces elapsed time71.39%; bounded73.26%. All four wide
reads are915.82–924.04ms and bounded853.02–866.35ms. These are native single-reader
observations on this policy snapshot, not page p95, concurrency or million-record
acceptance. Do not compare their percentages to the older0676/retained-reader model.

An independently separated4,096-record read records4,099 nested principal-proof
queries for the unchanged owner,3 for the full-width variant and31 for bounded.
Data-match-wrapper queries are4,097/0/26 respectively, including the one actual
manager. The complete underlying subject matcher remains active in every design.
This identifies repeated proof/wrapper work as a relevant bottleneck; it does not
allocate all saved wall time to one function or turn nested SQL time into CPU.
PostgreSQL peak630,054,912bytes, no cap/OOM events. Original resource budgets remain.

The simpler full-width change is prepared for review: existing public signature and
wide projection remain, with a statement-local principal CTE and exact expansion of
the guarded wrapper at the existing employee/manager predicates. The extra bounded
interface is not adopted merely for its smaller additional component gain. Both
still require broader scale and current-source integration qualification; building
all wide rows remains O(permitted workforce). The old65,536-record reader failure
and original two500-user failures remain unchanged.

Prepared privately, **not applied**:
`/private/tmp/aihr-personnel-statement-proof-605b.proposed.patch`.
Patch SHA256:
`19b52384747df70322a0ec0c65f72b893bade2effdcb0c214474d1281fc98fd1`.
Proposed body SHA256:
`4b3e4609c75a4bd6674ac271f12f9deb0f11019003e7c7df8c372c7e7f019f65`.
Derivation receipt:
`/private/tmp/aihr-personnel-statement-proof-605b.proposal-identity.json`.
The patch reproduces the tested full-width transformation from the guarded original
body, changing no declaration/owner/ACL or other0938 statement. No migration is
allocated and no source-bound provider approval is changed.

## Adoption boundary

No new full500 pair follows an incomplete or unqualified prototype. A demonstrated
relevant gain with complete native controls can support a review-only proposal;
the owner must supply a complete published frozen integration seam or incorporate
the exact change. The current published605b still lacks the0939 helper and the two
compiler modules above; local unpublished ownership work is not borrowed. Verify
that the installed projection owner can execute the private subject matcher under
its existing ACL; broad APP execute grants are not part of this proposal. Current full profile/field/date/void/refusal and protected-write/birth/snapshot
contracts still need qualification on that combined source, including populated
upgrade checks, duplicate sort-name boundaries and broader organization/date shapes. Applied SQL identity and allocation rules remain in force. Original
load resources, thresholds, pacing, coverage and timeouts stay fixed. Both rejected
formula alternatives remain rejected; no provider-binding approval transfers.
