# WP3: ranked build list from recorded process work

Scope: R15, rechecked against matching canonical main/alpha `fa487eddc07f20907bf6a341e9f442b1363c9215`.
This records source reconciliation and the acceptance contract; exact-commit CI and installation status
belong on the package PR.

## Already implemented and preserved

PR #34 merged outcome measurement, `measure(tx, process, from, to)`, `agentBacklogByTier()` and the
coverage panel. `core/process-assessment.ts` already ranks seven process baselines by staff actions
per 30 days. Its source queries own grouping, employee/staff distinction, rework, window and RLS.
No causal headcount saving or entry-specific action frequency exists in those records.

## Remaining gap and implementation

At this base the closed inventory contains 729 backlog entry points in 149 files, rather than the
review's historical approximate 250 total capabilities. The existing tier function returns counts,
not rows. WP3 derives the complete entry list from that same inventory, retaining every tier ceiling.
Reviewed links associate applicable entry points with their actual ADR-0131 case processes. Every
other entry receives an explicit `outside_baseline` classification and null measures. Payroll,
performance, configuration, imports, asset/requisition work and onboarding-v3 must not borrow nearby
leave/profile/lifecycle volumes. Expanding their measurement is future work.

The group-HR build list ranks by process staff actions per 30 days, distinct linked people, then a
stable source/entry identity. Shared entry points use the busiest measured linked process; they do
not add overlapping people or claim this entry's own frequency. The unchanged assessment counting
rules own the baseline. Distinct PERSON identifiers are counted in its same case query; an unknown
subject makes the people figure unknown. Zero recorded work remains distinct from missing measurement.
The page and complete JSON export use one group-only service with fresh calling authority,
entitlements and database scope checks. The page explicitly paginates 50 rows; the export is complete,
ordered, metadata/counts only, and private/non-cacheable. Company HR keeps its scoped assessment
without this group build list. The list grants no authority and executes no capability.

## Acceptance checks

- `test/agent-build-list.test.ts`: independent fixture with two people and six recorded staff actions;
  reconciliation to the canonical assessment; nonempty foreign-tenant isolation; company/employee
  refusal; archived administrator refusal; stale module snapshot replaced with current availability;
  six-locale desktop/mobile renders from the actual fixture service view.
- `test/agent-backlog-ranking.test.ts`: complete unique inventory/tier reconciliation; reviewed process
  links; staff-volume/people/tie ordering; no double-counted shared people; measured zero versus unknown;
  unrelated payroll/import/performance entries remain unmeasured; module-off versus unlinked states.
- `test/agent-build-list-export.test.ts`: complete ordered export beyond the display page; no client
  tenant/company authority; private response headers; forbidden company read; storage failures propagate.
- Existing process-assessment and outcome-measurement suites remain regression checks. The complete
  frozen-candidate GitHub Actions gate is separately required.

No migration, new action, import feature, autonomy change or model call is introduced. Screenshots are
rendered service fixtures, not an authenticated installation journey. Production counts, real workload
representativeness, staff minutes, savings and production installation remain unverified.
