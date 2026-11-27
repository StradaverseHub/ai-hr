# ADR-0132 — Group navigation by module and job

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

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
employee-visible under People. Profile Changes appears under People HR using the
server's actual HR-administrator capability, independently of the older partner
administration rail. Its assigned-principal service and RLS retain decision authority.
Attendance participants likewise receive only the Approval Items destination from
their existing actionable task read; this never sets the manager/team capabilities.

## Amendment — 2026-11-26: two administration sections (board 8fa0a31d)

Shared administration is now two independent sections pinned to the end of the
rail: System Configuration (gear) and Security Center (shield). Each lists its
pages directly; no dropdown inside a section repeats the section's name. Security
Center lists Security & Permissions, Password Policy, Function Access, Users,
Create a Login Manually and Invite a User, in that order
(`SECURITY_MENU_ORDER` in `lib/security-center-navigation.ts`). Its overview
page is no longer a menu row: it stays a route with its guard and Back links, is
the section's breadcrumb landing and a "Go to" entry, and is offered only when the
viewer may open it and sees at least one Security Center page. In the collapsed
icon rail each section is one trigger that opens its pages beside the rail.
Monolith headings stay icon-less. Placement (area `system` for all these routes),
page guards, capabilities and audiences are unchanged; each viewer sees the same
destinations as before less the duplicate overview row. Its coverage binding
`shell.securityCenter` is retired with the row.

### Amendment — 2026-11-27: two module rows with fly-outs, not sections (board 8fa0a31d revision 2)

The reporter rejected the two section headings above. System Configuration (gear)
and Security Center (shield) are now two ordinary module rows, in one unlabelled
group pinned to the end of the rail under the selected workspace's modules (Ops or
Strat alike). Each is a single trigger that opens its own fly-out panel exactly as
Payroll does in that theme: Atelier and Classic (expanded and the collapsed icon
rail) open the shared fly-out panel, one at a time, with its close button and
Escape; Monolith lists the pages inline as it does Payroll's; the phone drawers use
the same rows. Neither row has a module landing link, so the trigger is never split
into a link and a toggle, and each stays a module even with one visible page; a row
with no visible page is omitted. There is no section heading named System
Configuration or Security Center. Security Center's fly-out order is Security &
Permissions, Password Policy, Users, Function Access, Create a Login Manually,
Invite a User (`SECURITY_MENU_ORDER`); System Configuration keeps its existing
order. The overview's breadcrumb landing and "Go to" entry move from the section to
the module row's breadcrumb-only `landingHref`, with the same admission. Placement,
guards, capabilities, audiences and coverage ids are unchanged; each viewer sees
the same destinations as before this revision.

## Verification boundary

Source work, authored regressions and a clean diff do not prove the rendered
experience or permissions. No runtime verification has run in this source phase.
The release still requires existing destination/audience parity, deep-link and
keyboard checks, all supported roles and entitlements, six locales, Classic and
Monolith and collapsed-rail viewport measurements, runtime diagnostics, and the
classifier-required full release gate/build. No source-only checkpoint authorizes
publication or a board completion claim.
