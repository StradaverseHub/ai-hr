The web Operator console creates customers and manages their activation links. Existing-tenant module changes, usage reporting and tenant lifecycle operations currently use controlled installation tools. They are not additional buttons in the customer HR administration screens.

## Module changes

Before changing an existing tenant's modules, confirm the tenant/company scope, commercial agreement, dependencies and intended activation/deactivation. The module-change runner processes recorded requests and writes the entitlement, seed outcome and audit event together.

Billable activation requires the corresponding subscription line. Core modules are always included and do not take ordinary per-tenant grants. Deactivation checks for work that would be stranded; the recorded disposition must address the reported blockers before it proceeds. Do not work around a refusal by directly editing entitlement rows or changing an unrelated HR role.

After the runner finishes, verify the request outcome, resulting entitlement and the intended user's available workflow. A pending request is not an active module. A module entitlement also does not grant a person the company or function permissions needed to use it.

## Usage reporting

The installation usage report uses the separate read-only platform connection. It must not substitute an application or database-owner connection for that reporting role. Inspect each tenant's last capture date and the report's missing-capture warnings before interpreting totals. Running a report is not proof that daily capture is scheduled or that historical usage can be reconstructed.

## Suspension and reinstatement

The dunning tool reports proposed actions by default. Applying suspension makes the tenant read-only for ordinary work and records the suspension window. Billing status and tenant standing are related but different records; do not manually toggle status to simulate the workflow.

Reinstatement is an explicit operation for a suspended tenant. Its report explains the suspension window and replay plan. Applying reinstatement does not automatically run every missed sweep; the maintainer must review and execute the indicated follow-up. Leave accrual and expiry do not have identical catch-up behavior.

Refresh system guides after a tenant is reinstated, since documentation refresh skips tenants outside good standing.

## Closure

Closure is a separate decision with distinct requester/approver identities and retention checks. The closure tool is report-only unless explicitly applied. Closure starts the retention period; it is not immediate data deletion, and the reinstatement tool does not reverse a closed tenant.

For any of these operations, keep the approved request, target tenant, before/after state and runner outcome available to the responsible installation maintainer. The Operator role alone does not confer database-owner or platform credentials.
