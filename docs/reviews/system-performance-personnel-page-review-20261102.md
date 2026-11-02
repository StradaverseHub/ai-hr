# Personnel list performance repair

The Personnel list now obtains its employee rows, exact pager total and status-card
counts from one caller-scoped SQL statement. A materialized CTE evaluates the
existing authorized Workforce projection once; its three consumers reuse that
statement-local result. This removes two repeated full projections and two separate
transaction admissions. It creates no persistent permission or employee-data cache.

The existing query builders still own search, company, department, employment type,
lifecycle and derived-status filters. The status cards keep their un-narrowed bucket
semantics, the pager remains exact, and selected row ordering and pagination remain.
Draft pinning, photos, exports, employee creation and navigation destinations are
unchanged. The previously prepared bounded remote employee chooser remains in the
candidate; the installed staging source still uses the whole-list chooser.

## Source and evidence

Owned branch: `codex/performance-personnel-page-20261102`.
Baseline seam341b04ae02506d70daeb6f2c68e96890796b1353 /
[41449936703](https://github.com/StradaverseHub/ai-hr/actions/runs/41449936703)
fails only the intended projection-count assertion:3 observed versus1 required.
All row, ordering, total, status-facet, empty-scope and foreign-tenant controls pass
before that assertion. The original failure is retained.

Application repairbb8a2bfdff0d7e9c8a215a115ab3c98750ecc01d /
[41450897584](https://github.com/StradaverseHub/ai-hr/actions/runs/41450897584)
passes72 native database checks and65 other/DOM checks over13 files, plus the fresh
whole-repository compiler. The actual native projection count is1 and the initial
512-visible-record read measures165.06ms, versus264.84ms in the original red.
Those separate-run readings alone are not used as a system speed percentage.

Test-only435006109cd827b48c80cedd77ca816734d78946 /
[41453113143](https://github.com/StradaverseHub/ai-hr/actions/runs/41453113143)
passes a same-run comparison with alternating execution order:

|Round|Order|Former read|Composed read|
|---|---|---|---|
|1|Former then composed|193.48ms|90.62ms|
|2|Composed then former|195.70ms|91.03ms|
|3|Former then composed|197.68ms|91.51ms|
|4|Composed then former|187.71ms|93.16ms|

Means are193.64ms and91.58ms:52.71% lower elapsed time for this native data-read
fixture. All comparisons assert exact results. This is not a full-page, HTTP,
500-user or million-Personnel-record acceptance claim. The fixture has512 visible
employments and7 in another tenant. The existing million-row stress fixtures concern
Claims and Attendance, not a million Personnel records.

The owned primary draft retains these commits as01923d599/eedd5a4ce/bfa1883ef.
Its tracked tree atbfa1883ef equals tested435006109. Test/controller receipts retain
their original identities; no receipt is relabelled into a release witness.

## Permission and source boundaries

The implementation calls the existing `app.access_workforce_list_rows()` projection
under the original Access read barrier. It neither reads raw Personnel tables nor
changes a SQL function, RLS policy, migration, grant, provider contract or literal
provider approval. One-statement reuse respects the projection's STABLE contract.
The security owner's newer0938 projection, including its subject and manager data
permission restrictions, is not replaced. Those restrictions remain with that native
owner when integrated. Current-source compatibility and release qualification still
apply to that future combined candidate.

Generated source manifests are9efe0514d61b3be4e5ce6c6ad80909e69ec3135b134b347be3722843bca5af80
(provider,1152 files) andbff56517e96a7909de9f6fc1c7ab91545a9d3bc0bf5db1128e27455aeaf68699
(module,456 files). Both canonical checks pass using the existing human approval to
regenerate these same metadata files for this task. Literal bindings are unchanged;
provider egress remains blocked for this source.

## Live observation and remaining work

Read-only staging checks verify its release-state source and on-disk build agree;
the actual Workforce projection body hash matches0676. The service is active under
Node22.23.3. A short metadata sample shows no active database wait at that moment;
this cannot exclude intermittent contention. No employee records or credentials
were exported. Private operational details remain in the private task checkpoint.

The user completed sign-in in the diagnostic Chrome tab. Personnel subsequently
renders the list and controls. Read-only pagination and Claims/Personnel navigation
complete without captured console errors. Browser automation envelopes include
extension overhead and are not treated as server TTFB or page-load percentiles.
The connected read-only browser API does not expose Performance entries/network
request timings, so no unsupported browser timing claim is made. One unauthenticated
public sign-in GET separately confirms a short network/TLS/TTFB sample; it does not
measure authenticated Personnel.

This removes repeated work, but still evaluates the permitted Workforce projection
once for exact page/facet counts. It is not proof of bounded cost at millions of
employments. Further filter/paging pushdown needs a compatible native owner contract,
including the new data-permission rules; no overlapping SQL has been allocated.

Both most recent whole-system500-user profiles remain FAIL. This Personnel source
has not been deployed or used to claim either target accepted. System Optimization
remains outside release admission. No staging queue, lease, migration or deployment
action follows this review.
