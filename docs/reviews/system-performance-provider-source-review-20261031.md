## Page-only selection wording: supplemental technical review — 1 November 2026

Reviewed immutable source `96600d0e4a6ba219f9820f1977458a24991b8f73` against
owner-approved `d17a977f6888911e44e8bb406960a0cf4a4d7944`. This records technical
review and the owner's page-only product decision; it does not renew literal AI
source approvals or grant deployment authority.

The owner selected: “Select only the current page, with clear labelling”. The UI
labels all-page selection “Select all on this page” and explains that only displayed
records are selected. Existing native bulk commands still recheck every request;
the rendered regression verifies exact displayed IDs, clearing old selection on a
page change, section separation and mandatory rejection reasons. Hosted run
41317079408 passed48 selected cases (39 unit/DOM,9 native); its unrelated test-repair
syntax error was corrected and the whole compiler passed in41317411126.

Static import traversal has the same1,142 members. Immutable Git-blob comparisons
confirm exactly six covered files changed: messages/en.json, ms.json, ta.json,
th.json, vi.json and zh.json. Each changes only approvals.bulkSelectAll and adds
approvals.bulkPageScopeHint. The remaining1,136 covered files are byte-identical.
Provider adapters, data selection, transformations, serializers, contract descriptors,
permitted data/purposes and sensitive actions are unchanged. The new generated
closure is `1841f158f2c594bab7903946e009cfac621f4ecc5bb6d40a79430722b7504a66`.

A concrete unapplied proposal changes only the24 existing approved sourceDigest
values from9f74efea6 to1841f158f. Both pending records and all contract IDs, statuses,
reviewers, evidence links and original timestamps remain exact. The proposal is
`/private/tmp/aihr-page-selection-provider-bindings.proposed.ts`; it has not been
applied. The previous explicit fingerprint approval was limited to9f74efea6, so the
native positive-provider controls must continue refusing1841f158f until the owner
answers the supplemental fingerprint-only question. Generated hashes alone do not
renew approval. No real provider call, integration, installation or deployment is
part of this proposal.

---

## Current integrated technical review — 1 November 2026

Reviewed immutable candidate `5a7c830b8bc68952d655495e240f72d092195161` against
accepted source/main `7fe8f8627f3a5ec0067f7dea777f140dd204ca5b`. This is technical
analysis, **not renewed human approval, runtime acceptance or deployment authority**.
The historical31October review below retains its original source identity.

Independent Git-blob import traversal matches both generated manifests: main has
1,141sources/digest`c9c5944d9756718e34b08826b1773339ea7430687209992efd5ab84c2aea177d`;
candidate1,142sources/digest`9f74efea6ae0ee912f602dc263429bf1e238e13ff4ed0cf9d1d83cd0d1e3f8e8`.
Exactly1,116members are unchanged,25change,oneis added;noneare removed.
The24approved literal records remain byte-identical to main and both pending
contracts remain pending. The native exact-source gate correctly refuses the new closure.

Changed covered files are native read/aggregation/approval implementations
(`analytics`, `approvals`, `attendance`, `attendance-workflow`, `claims`, `read`,
`payroll`, `profile`, `employee-master-projection`, `employee-draft`, `leave`,
`workforce-access`, `access-configuration-lock`), ORM/schema setup, Home projections,
HR date formatting, ESS visibility, lifecycle legacy-source handling and six locale
catalogs. The only added dependency is the bounded pool-size parser.

The newest changes retain original decision owners and complete output semantics:
Attendance transports native proofs in bounded parameter batches without capping tasks;
standalone Workforce readers share the existing barrier while writers/borrowed
transactions remain exclusive; Personnel discard joins Access before onboarding's
audit lock; Claims discovers existing native-visible/delegated subjects and tests
pending existence through real Claim RLS. Full decisions, fresh principal checks,
self/company/tenant fences, current grants, audit and original500ms native lock
bounds remain. Indexes and SQL plan changes have separate migration ownership and
qualification; this import closure does not itself certify SQL installation.

Provider adapters, gateway, closed descriptors, governance/policy serializers,
provisional purposes, sensitive action inventory and all model-facing payload shapes
are byte-identical to the accepted base. No new raw person/document field, external
provider operation, numerical model authority or sensitive AI effect is introduced.
These source facts do not substitute for native behavior, release or human approval.

### Owner-authorized binding refresh — 1 November 2026,22:04MYT

The repository owner answered the exact24-binding fingerprint-refresh question:
“Approve the fingerprint refresh; don’t deploy”. The authorized scope is this reviewed
closure`9f74efea6ae0ee912f602dc263429bf1e238e13ff4ed0cf9d1d83cd0d1e3f8e8` only.
Apply only the24 existing approved sourceDigest values; retain every contract ID,
status, reviewer, evidence link and original human timestamp, and both pending records.
The module-agent manifest is regenerated because it covers the approval registry.
This is not a new permitted dataset, purpose, provider contract, sensitive action,
provisional approval upgrade or deployment authorization.

Original source-bound positive-provider control41311496352 on integratede45181a80
remains FAIL;163othercases passed there. The newly authorized refresh needs its own
hosted positive/refusal regression evidence and complete exact-candidate release
qualification. No real provider call is needed for those synthetic checks.

---

# Performance changes: protected-provider source review

Technical review of `f256f8f34f95673153353aa7303b754fd1d78075`, 31 October2026 MYT.
This is agent source analysis, not human approval, independent specialist certification,
installed acceptance or deployment authority. Literal approval records remain unchanged.

## Exact source identity

The original approved closure at `b717b29cc39f538a61113133a9452ba242e4bef2` has997 files
and digest `568bbdb994d30852f16df845110d804167e35eab18e7b049c0dc21e785644b06`.
The reviewed closure has998 files and digest
`c1c073ea81f8f90c3d70d2794aca562470ffd74252ec38066e3ef8a55193cc41`.
Independent immutable Git-blob traversal agrees with the generated import closure:
976 files are byte-identical,21 existing files change and one dependency is added.

## Reviewed changes

| Area | Source changes and boundary |
| --- | --- |
| Native reads | Claims SQL paging, counted shell preview, batched employment decision authority, payroll paging/counts, Master projection indexes and count-only analytics. Full owner APIs and native RLS/decision guards remain; these are not new provider fields. |
| Shared transactions | Remove unused eager ORM relational setup; bounded pool setting defaults to10. Warm audit setup uses only the existing one-way armed marker; first-arm/concurrent-arm handling and transaction-local identity remain. |
| Native policy | Sealed Workforce read takes a shared lock on the existing key. Configuration writers retain exclusive locks. Profile candidate reads retain native reader/RLS and nonempty locked decision checks. ESS visibility is computed once per call, without cross-call policy caching. |
| Lifecycle | Narrow task/mention source reads and count joiners in SQL, retaining the canonical per-row interpreter. The reviewed repair uses `coalesce` so absent legacy task status/state preserves the original JavaScript owner semantics. Explicit unknown source dates remain unknown; only absent source properties inherit local dates. |
| Presentation | Reuse immutable MYT formatters. Six locale catalogs each add the employee-search failure label. Schema adds the Claims history-order index; no new data column is added. |
| Added dependency | `lib/db-pool-size.ts`: validates the operator setting, defaults to10, accepts only integers1–40. It carries no person or provider data. |

No provider adapter, gateway, protected-contract descriptor, privacy serializer,
support threshold, outgoing system/payload shape, raw prose/document/image capability,
Formula authority or sensitive AI effect changes in this closure comparison.
Native data selection/authorization changes still require their actual hosted behavior
evidence; identical outgoing contract source alone does not establish runtime acceptance.
SQL migrations retain their separate allocation/ledger/rehearsal holds.

## Binding disposition

The existing registry has24 approved finite contracts bound to the old digest and two
pending contracts. The current generated fingerprint deliberately makes the old approval
bindings stale. The native source-owned gate must keep refusing those stale bindings.

A prepared, **unapplied** proposal changes only the24 approved `sourceDigest` values
to the reviewed digest. It preserves every contract ID, status, reviewer, evidence link
and original human timestamp; both pending records remain byte-identical.
The recorded owner approval is exact-source-bound, so this document does not itself
renew it. Authorized fingerprint-refresh confirmation is required before applying that
proposal and validating the protected-provider positive paths. No real provider call is
needed for the subsequent synthetic regression checks.

The complete source/run ledger and remaining capacity failures are recorded in
[the system performance audit](../SYSTEM-PERFORMANCE-AUDIT.md).
