# ADR-0140: Operator customer workspace

Decision: 25 October 2026 (Asia/Kuala_Lumpur).

The installation operator has its own shell and customer metadata APIs. An operator session enters
`/operator`; customer HR navigation, employee search, company switching and employee account shortcuts
are absent. The root layout selects this shell before querying customer work queues. The operator
role does not imply customer administration, and customer administrators cannot invoke the metadata APIs.

The operator can rename a customer account and manage tenant-wide optional module access. An account
rename changes `tenant.name`, with a recorded actor and before/after event; it does not rename customer
companies. The encrypted internal authentication namespace remains the login authority. Creation
records the chosen code as provisioning intent, reserves it against other active requests, and creates
both existing authentication indexes inside the tenant provisioning transaction before activation.
Existing namespaces are read from their current indexes, including customers created before this UI.
Codes are normalized, reserved installation names are refused, and no UI operation reassigns a code.
Other authentication providers retain their existing creation flow.

Module changes reuse `module_change_request`, `subscription_line`, the canonical activation hooks and
the owner-role module runner. The installed provisioning tick also processes one module request, so
an operator intent does not depend on a second undocumented timer. One pending change per customer
and a shared tenant advisory lock serialize changes. The worker rechecks prerequisites, dependents
and unfinished-work decisions at execution. Preview and execution consume the same SQL count helper.
Only aggregate work counts are exposed to the operator; individual employee or payroll records are not.

A billable activation requires an explicit agreement reference and records the commercial line; this
is not a pricing, invoice or payment engine. Disabling retains data, configuration, earned obligations
and the change history. Re-enabling uses existing idempotent activators. Core modules are fixed.
Company-specific grants are displayed and explicitly refused by this tenant-wide editor rather than
silently broadened or removed. Their contract editing remains an installation task.

The worker keeps schema-owner credentials outside the web process. Internal customer provisioning
requires the same protected authentication origin and encryption key as the application; missing
configuration fails creation instead of reporting a usable customer. Deploy the additive migration
and compatible worker together, verify private worker configuration, and preserve existing data.
No deployment or environment change follows merely from committing this code.
