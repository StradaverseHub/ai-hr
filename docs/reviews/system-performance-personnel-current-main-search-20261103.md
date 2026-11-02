# Personnel initial search population: current-main candidate

## Measured problem and candidate

The current-main Personnel listing awaits `listWorkforcePickOptions(session, scopeIds)`
and serializes its whole population into the search island before the user types.
This is additional work beyond the qualified rows/total/facet projection.

Original baseline/regression `278d954ac18d230d8d1363d0d9f258fcdc553e3d` /
[41491955974](https://github.com/StradaverseHub/ai-hr/actions/runs/41491955974)
uses the existing application with16,384 visible and seven foreign fictional records.
Actual APP role and exact whole-list length pass. The read takes472.31ms and the
five switcher fields serialize to2,842,625bytes. The test then fails only the intended
missing bounded-reader assertion. This original failure is retained at
`/private/tmp/aihr-personnel-search-red-278d-attempt1`.

Candidate `c27ce14f69aea76576f198e5bcc50666136551e6` on
`codex/performance-personnel-main-search-20261103` builds on qualified app
`3eab8c7b8e9d435597f2d2c46d0a085cc043878d` (fresh-main base dfbcf85b1).
[41492832404](https://github.com/StradaverseHub/ai-hr/actions/runs/41492832404)
passes all184 affected checks across15 files and the whole compiler. Its matched
query-cost regression remains below; this functional success is not speed acceptance.

The list no longer reads or sends the whole search population at opening. On typed
input, a200ms debounce calls a no-store endpoint with the current session and current
top-bar/authorized Workforce company intersection. At most eight results cross the
response boundary, using the existing partial-name/folded-code ranking. The route
returns only employmentId/name/employeeCode/company/department, ignores supplied
company IDs and rejects oversized input or denied actors. Native projection and
locks still enforce authority; search does not grant profile access.

The shared island retains local mode for profile callers and their existing data
uses. URL navigation, selected tab and unsaved-edit guards are preserved. Changed
query aborts the obsolete request and hides prior results; a retyped earlier query
must fetch again. Loading, no matches and failure are distinct; failure copy exists
in all six locales. No authorization/result cache spans requests.

After every planned c27c job finished, follow-up `b95f5feabd5f34fcff5e915cbd2bc77d02f675a1`
removes a duplicate identical response reset and keys the listing search island to
current scope IDs, clearing state on a company-scope change. It also materializes
name/code normalization once per authorized candidate within the existing statement.
It changes no ranking branch, grant, native function, SQL migration or lock.
[41494579818](https://github.com/StradaverseHub/ai-hr/actions/runs/41494579818)
passes61 affected checks across the five search files plus the fresh whole compiler.
Original c27c successes and negative timing remain separately pinned.

## Final matched bounded-query decision

Fixture-only `1c0d1f52e9a19169a487fe1233f82e0da9678381` /
[41496602245](https://github.com/StradaverseHub/ai-hr/actions/runs/41496602245)
finishes SUCCESS. Application code is byte-identical to b95f; only the retained native
benchmark changes. The b95f whole-compiler receipt stays on its exact source.
No compiler or unrelated184 checks are blindly repeated/relabelled.

The direct comparison uses a frozen c27c unmaterialized query reference, copied into
test-only code with the same Drizzle fields, rank branches, purpose function, cap and
Access lock. Its only filter is the nonempty company-ID predicate; the shared filter
builder reduces to that exact predicate for these inputs. This is an equivalent
company-only test reference, not a claim of executing an old module byte-for-byte.
Both forms independently equal the original client matcher's exact authorized result.

|Round/order|Unmaterialized bounded reference|Normalized bounded query|
|---|---:|---:|
|0 / reference first|466.78ms|439.37ms|
|1 / normalized first|467.01ms|442.17ms|
|2 / reference first|482.21ms|441.64ms|
|3 / normalized first|467.56ms|456.25ms|

Means **470.89→444.86ms (5.53% lower)**, all four pairs improve; keep the normalized
form. This is a modest native query gain on this fixture, not a whole-page or500-user
percentage. The same run's full-list reader averages443.55ms versus444.18ms for
bounded reads in a separate four-pair block: approximately equal reader cost, while
only the bounded query also ranks the search. No absolute times are compared between
runners. Earlier negative c27c/b95f comparisons remain below.

Native cap8, independent exact-code identity, original ranked matches, empty/foreign
scope, literal wildcard and length controls all pass. Whole initial search population
is removed; typed search returns1,389bytes versus2,842,625bytes for the old full dataset
(99.951% less raw JSON in this fixture). These are serialized data sizes, not measured
compressed HTTP wire bytes. The primary page's other data/render work is not timed.

No app/public SQL/lock/resource/timeout changes in the final probe. Standard hosted
runner/PostgreSQL profile2/JITon/240s test bound; peak745,869,312bytes, zero OOM/cap
events. Source manifests remain exactly b95f. Artifact
`/private/tmp/aihr-personnel-search-direct-1c0d-attempt1`; summary
`/private/tmp/aihr-personnel-search-direct-result-20261103.json`.

## Verification boundaries

The retained-volume test compares exact ranked matches with the original local
matcher, checks independent exact-code identity, cap8, empty and foreign scope,
literal wildcard text and invalid length. Four alternating-order reads compare
whole-list work with bounded search at the same cardinality/resources. Result metrics
for c27c show full-list238.51ms versus bounded270.68ms mean: **13.49% slower query**.
The response falls2,842,625→1,389bytes (99.951% less raw JSON) and the initial full
search population is removed, but this is not a native query speed gain. Four
paired full/bounded reads are227.32/237.53,233.27/276.25,240.45/241.69 and
252.98/327.25ms. All native/UI/route controls pass. PostgreSQL peak1,380,757,504bytes,
zero OOM/cap events. Private artifact `/private/tmp/aihr-personnel-search-c27c-attempt1`
and summary `/private/tmp/aihr-personnel-search-c27c-result-20261103.json` retain it.

The normalized-query follow-up means are full-list318.67ms versus bounded342.55ms
(7.49% more elapsed reader time); its four pairs are317.47/324.96,318.16/370.33,
318.34/345.51 and320.72/329.39ms. The full-list reference excludes subsequent client
matching: it is not an end-to-end search latency comparison. These results from a
different runner cannot establish an improvement over c27c's bounded query. The final direct
same-run bounded comparison above, rather than this cross-run observation, qualifies
the normalization decision.
Private artifact `/private/tmp/aihr-personnel-search-normalized-b95f-attempt1` and
summary `/private/tmp/aihr-personnel-search-normalized-result-20261103.json` retain it.
PostgreSQL peak1,454,960,640bytes, no OOM/cap events; eight-result response remains
1,389bytes. This does not measure rendered-page TTFB, native hiring/import/CRUD or
500-user capacity. No stronger claim follows from a bounded response alone: the
underlying native query may still scale with retained records.

Passed coverage includes native Workforce grant revocation and ranking, endpoint
scope/no-store/field minimization, stale responses/no request on empty opening,
list wiring, existing projection parity, shared matcher and unsaved-edit navigation.
No application tests, compiler or runtime run locally. Standard GitHub Actions only;
existing resource profile and240-second native test bound remain unchanged.

Database client, lock owner, native database function definitions/migrations, session/authentication and human provider
binding registry are unchanged. Only the two task-authorized generated manifests
are refreshed: provider b5f4eeb6c47f16cf8ed7f327b2e3fe5c997266c0f575eab29111ecf98cc8d17b,
module766f3e8a0da65cb5f1e8e622573f4abac684002e93508297be463de2d6dd0a69 on c27c.
The b95f follow-up digests are provider1255e889257f187095190df6c35822c4a2be2dbf3400c1c1e03ff2104fd98639
and module792495453274e9f87c3ef03251e9983fd9d4406cd3687240c570b95a2ab7dffe.
Static checks pass. No human binding/provider access approval is implied.

Fresh published security still resolves605baf23, missing
`app.access_current_capability_source(text,uuid)`, `lib/access-action-presentation.ts`
and `deploy/access/function-action-contract.ts`. No foreign local source is adopted.
The private native optimization is not integrated. Both original500 profiles remain
failed; no retries or workload/timeout/target/resource changes. System Optimization
remains outside staging/release admission. No deployment or lease action.
