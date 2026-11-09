# Bind serialized traffic actors to their native tenant facts

Status: source authored, unrun. Parent: `6b2a1fcec5c1ff2c015705ec8cbb3bf3f71e4b5d`. This corrects the existing development workload fixture; it does not add a native adapter or qualify browser/load behavior.

The fixture created users in each known tenant but omitted tenantId from its serialized traffic actor record. The existing navigation fixture reader correctly requires that field to match its tenant creator. Each users.push now includes only the missing `tenantId: b.tenantId`. Existing IDs, actor order, role and scope allocation, sessions, grants, company/employment/person joins, canonical business commands and financial/audit/authentication writers remain unchanged.

Before writing the private fixture, a bounded check verifies all 500 selected traffic actors. Independent expected tenancy and company come from the original two tenant/five-company creator records; the actor index fixes its name, employee code and role. The check requires unique indices/user/person/employment IDs, exact two tenants and ten companies, 250 actors per tenant, 50 per company, and the unchanged 460 employee/20 manager/18 company-HR/two group-HR lanes. It compares every stored native user, employment, person and company tuple with those expected creator facts. Expected tenancy is never inferred from returned rows.

One fixed owner.client SELECT supplies exactly the 500 known user/employment ID pairs to jsonb_to_recordset and uses LEFT joins, so a missing or mismatched native row cannot disappear. Native grants are selected by app_user_id without a tenant predicate, retaining foreign and duplicate grants as failures. A five-row per-user limit is an overflow sentinel: the largest legitimate grant set is four, so truncation cannot produce any valid expected set. Every tenant/role/company triple and its multiplicity must match, with exactly 544 grants overall. Only fixed boolean assertions inspect private tuples; public actor-tenancy.json contains aggregate counts and no IDs, names, sessions or credentials. Unselected seed administrators and the legal no-login Rewards prerequisite remain permitted; no global table is required to have exactly 500 rows.

The existing owner client and transaction policy remain unchanged. Source db/client.ts sets only max for this client, with default 10; the harness owner, CI PostgreSQL configuration and migration source do not establish a finite statement_timeout for this direct SELECT. The existing fixture subprocess budget remains 600000ms under system-runner. Effective server/session SQL timeout and selected physical plan are unobserved, not assumed or enlarged. Source UUID primary keys support the four identity joins and role_assignment_user_idx supports the selected-user grant lookup; source index presence is not a measured plan or latency result.

The old four navigation fixture tests remain whole. One additional pure projection case verifies both tenant cohorts, cross-tenant roster exclusion and refusal of absent or swapped tenant IDs for actors 0 and 250. It executes no fixture or native SQL and cannot establish native persistence. Hosted validation of the actual 500-actor construction remains required before browser preflight.

Current source closure has the same runtime vertices/import edges; only the fixture owner changes. The new SELECT adds one syntactic database site, not evidence of an executed native statement. The prior extraction record and all older qualification records remain immutable and source-bound. The new compact overlay stores whole actual parent Git identities and bounded inverse coordinates; current source/disclosure binding remains open until coherent integration. Root and a different peer must fully review the frozen candidate before publication or hosted verification.

The separate native union, Org Explorer extra-employment, driver pool/cleanup/sampler/Chromium environment and same-artifact admission work remains open. No workload execution, repository imports/tests/compiler/build, database/native command, remote operation, source upload or dispatch occurred while preparing this change. Staging and production remain held.

The whole-system fictional workload also needs the prepared Rewards plan and
its one additional employment. Seed that employment in tenant 0, company 2,
after the retained Payroll runs close. Its hire date equals the Rewards
snapshot date, so it is present in the current dated roster and outside the
historical Payroll periods. Verify the stored person and employment, including
the absence of a login and a payslip, before writing the private fixture.

The 500 traffic actors stay in their existing independent population. Org
Explorer expects 251 people in tenant 0 and 250 in tenant 1. Company 2 in
tenant 0 contains 51 people, including the known Rewards employment. The
company 0 scope still contains 50. The workflow preflight keeps its existing
Rewards fixture and the claims workload keeps its existing fixture. This
source change requires hosted fixture and browser verification. Org Explorer
must show the exact Rewards member in a rendered search result and refuse
that search after narrowing to another company. The fixture member check
returns a boolean witness and reports a fixed refusal on a mismatch.
