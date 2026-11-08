# Rewards configuration list and coverage share one presentation snapshot

Status: source candidate; native execution and application acceptance pending.
Base: 6f8b3098b985802e6255395c45d547d2e27e1d24, the reviewed current-main/common-read merge.

The configuration page previously read its unit list and coverage in separate transactions.
The private list projector also returned every visible upload marker in the tenant before
using markers only for unit IDs already returned by its authorized list query.

The pack service now owns `rewardConfigurationListView`. It captures the context, company
IDs and four URL filters, performs the same native `reward_access_observe(NULL)` WRITE,
then uses the existing `withModulePresentationRead(ctx,'rewards')` owner for list, the
unchanged equality filters and coverage of filtered nonterminal reviews. It returns the
complete list for filter options, the filtered list and the existing missing-role counts.
The public `listRewardUnits` retains its RC supplied-Tx contract and observation omission
for those callers. Its ordinary observation delegates to the same private WRITE helper.

The upload marker SELECT keeps its tenant condition, RLS and exact pending expression
`current_version=0 OR checked_version IS DISTINCT FROM current_version`, adding only an
ID predicate from the authorized rows. Empty results still return before that query.
DTO fields, ordering, nullable counts and holder names, dates, cancellation and shared
policy provenance remain the same. Financial calculation and all upload writers are whole.

The page retains scope/whole-group setup, setup choices and memberships before the facade.
Shared-policy choices remain after the snapshot under their existing owner. Their current
`reward_policy_for_new_unit` is a command/consumption helper with an exclusive Access lock
and `FOR SHARE`; moving it into RR/RO would be incorrect. The application lacks an equivalent
pure policy-body owner with the same per-company authority. That future work needs a
separate installed-catalogue and native-authority review; this candidate adds no SQL.

The audit WRITE and snapshot are separate transactions. A failed observation blocks the
snapshot. A later projection failure leaves an already committed native observation intact.
Only presentation after that committed prephase can overlap a held configuration writer;
this change makes no wait-free claim for the audit or earlier page setup reads. Snapshot
facts may finish at their admitted authority point. Each next call rechecks native current
identity, grants, fresh Rewards entitlement and RLS. Results confer no effect/provider power.
Commands and native audit owners retain their current revalidation and lock barriers.

The 20-line common adapter, current Performance STOP conditional, all four explicit upload
DML owners, native grants/RLS, migration SQL/journal and AI RC owners remain byte exact.
The new facade is inside the pack service: no low-level Tx export or new adapter is added.
The existing `rewardRulesChoices` caller of `listRewardUnits` is included in affected review.
AI administration has no new purpose or module gate in this candidate.

The native fixture includes nine cases:

- Full frozen predecessor list DTO and coverage equality, all four filters, duplicate/empty
  scopes, complete IDs/options and independent count/date/privacy facts; actual application
  LOGIN/session role and enforced RR/RO, with sequential audit/presentation transactions.
- Retained cancellation metadata and exclusion of terminal reviews from coverage.
- Actual native suspension observation once, including an empty selection, durable after
  an actual later division-by-zero storage failure; no synthetic native audit event.
- Actual read-only storage refusal of the audit WRITE before any snapshot opens.
- Existing supplied-Tx RC admission and omitted audit, with RR/RO still refused by that seam.
- Native upload doer/checker/refresh states, absent/zero/current checked markers, and View as
  projection equality with unchanged command refusal.
- Fresh module/grant/login checks, foreign IDs, seatless null counts and special-context
  refusal. Stale contexts are retained across actual authority decreases.
- Real canonical Access and AI writer locks acquired after the observation committed and
  the snapshot admitted; old snapshot completes, then the committed grant decrease refuses
  the next call. Both actual lock identities are inspected while still held.
- A fictional historical population of 1,000 other-company upload reviews, constructed by
  a bound owner with all native triggers active. Old/new DTO equal, old/new upload rows
  measured independently, unchanged projection query count and one active statement.

The old list projector is frozen in a test helper from the actual base Git bytes. Only its
exported name and relocated type import change. Coverage and pure date/route owners are
unchanged dependencies. The source proof verifies this inverse, both production whole-file
inverses, every inherited DOM case body and the unchanged owner bindings. The existing DOM
mock is wired to the new facade without changing any existing assertion or expected render.

Native tests will run only through standard hosted Actions after root and independent full
source review. No repository behavior has run locally. A row-return reduction is a proposed
boundedness improvement; there is no measured elapsed-time claim, full Rewards qualification,
staging acceptance, provider approval renewal or production authorization.

## Native Rules choice consumer coverage

The same nine native cases now exercise the actual ordinary `rewardRulesChoices` consumer
inside the existing bounded-predicate/RC case. An independent application-role native SELECT
joins the seeded review/cycle/company and checks `reward_capability(id,'rules.view')`; its
IDs must equal the known nonempty seeded unit ID before comparing the complete choice DTO.
This test-only child preserves every earlier assertion, case name and budget. Product owners,
SQL/journal and all other source remain whole. Native execution is still pending review.
