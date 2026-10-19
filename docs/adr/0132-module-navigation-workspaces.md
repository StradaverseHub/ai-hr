# ADR-0132 — Group navigation by module and job

- Date: 2026-10-19
- Status: Direction accepted in approved board item 7de1a0d7; source implementation and verification pending.
- Scope: Navigation presentation. No page permission, record, calculation or workflow authority changes.

## Decision

Ops groups operational modules; Strata groups Performance, Talent, Development,
Rewards and Workforce Insights. Each module groups its visible destinations by
Mine, Team, HR and Configuration. Shared work and references remain available
outside the workspace selection; shared administration has a System Configuration
gear. Inbox groups existing Tasks, Approval Items and entitlement-gated My Testing
without creating another task or approval owner.

`lib/navigation-workspaces.ts` is the sole owner of placement and route-to-workspace
resolution. The renderer receives the existing permission-filtered destinations.
Changing workspace never changes company scope, roles, commercial entitlements or
the page's independent authorization. Modules and empty workspaces are hidden
after filtering. A single visible module destination links directly to that page.

The old pack audience tags and sidebar audience inventory are retained as a
compatibility boundary for their existing visibility rules, not as rendering
placement. New destinations need an explicit placement in the taxonomy and their
proper existing/new audience and module guards. An inventory guard requires every
current destination to have a placement. Unknown rows remain reachable outside
the workspace instead of disappearing; their missing placement fails that guard.

The same authorized graph feeds Classic, Monolith and Current. Longest matching
path, query specificity and explicit owned subpaths select one current destination.
An explicit direct destination wins a tie with an older umbrella-owned path.
Navigating resets workspace overrides; selecting another workspace alone does not
navigate or grant access. Tasks and approvals retain their accessible count labels.

The existing focused Performance workspace shell is preserved: Classic and Current
use the journey's own navigator and dashboard return instead of the global sidebar
on `/performance/workspace`, including its Talent and Development query variants.
Monolith retains its global rail there. Route-owner coverage alone therefore does
not establish visible Ops/Strata selection on those focused screens; acceptance
must inspect their actual entry and return journeys in each theme.

The approved change removes the employee Mobile App preview menu entry, while
retaining its route for existing links and placing the administrative entry under
System Configuration. Locations moves into Attendance Configuration. Personnel
Management remains administrator-only under People HR; Team Directory stays
employee-visible under People. The Profile Changes owner may later add its guarded
queue to People HR without adding another approval authority.

## Verification boundary

Source work, authored regressions and a clean diff do not prove the rendered
experience or permissions. No runtime verification has run in this source phase.
The release still requires existing destination/audience parity, deep-link and
keyboard checks, all supported roles and entitlements, six locales, Classic and
Monolith and collapsed-rail viewport measurements, runtime diagnostics, and the
classifier-required full release gate/build. No source-only checkpoint authorizes
publication or a board completion claim.
