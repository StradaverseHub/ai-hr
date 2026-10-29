# ADR-0162: Group admins control payroll reset and employee removal

Status: Accepted owner request, 29 October 2026. Implementation pending release verification.

The owner requested an in-product toggle after enabling payroll correction actions for one production tenant required a platform database change.

Expose one tenant-wide toggle in Payroll → Settings for `payroll.reset_enabled`. Change that existing setting’s catalog scope from platform to tenant. Only current group admins may save it through `setTenantSetting`, which checks live authority and writes the actor-attributed event atomically. Company admins see the value read-only. No tenant identity or setting key is accepted from the form.

Keep the default and install default false. Preserve every existing tenant override, including platform-written true values. The normal `scripts/seed-catalogs.ts` upsert installs the scope change without rewriting tenant settings; no SQL migration or journal reservation is needed. The deployment must run that catalog seed before serving the new UI.

Both reset and employee removal continue to use this one gate in their entry points, destination pages and services. Turning it off blocks the operations, including direct requests; saving never changes payroll results. Existing permissions, period locks, processed-only rules and removal constraints continue to apply. `payroll.unlock_enabled` remains platform-scoped, and closed payroll is unaffected.

Verify catalog seeding preserves overrides, group-admin on/off persistence and audit events, denied company/employee/revoked-admin writes, tenant isolation, both existing service refusals, and rendered form save/error/read-only behavior. Production deployment requires a separate request after staging acceptance under repository policy.

Rollback: after a group admin writes a customer override, the old platform-scoped catalog cannot be re-seeded silently. Its promotion guard refuses those rows. A rollback must explicitly preserve or resolve the customer decision before changing scope back; do not rewrite provenance implicitly.
