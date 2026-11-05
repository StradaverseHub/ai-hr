# Probation module configuration and versioned organisation mapping

Status: source candidate; approved setup authority direction, mapping activation pending inventory review.

The owner approved replacing named preparer nomination with a tenant-level Probation module permission on 4 November 2026, and explicitly chose existing current named administrators plus the System Administrators access group as its initial holders. Inbox participation and canonical PBP/People Ops membership do not grant configuration authority.

`probation.module` owns all six configuration tabs across every entitled active company. Access Settings owns its grants and denials. Historical preparer rows remain evidence; new preparer nomination is retired. In tenants whose Access Settings is not initialized, explicit initial-holder overrides remain dormant until normal initialization; initialization is not silently performed by this change.

Module users can request company activation after approving the exact current rehearsal and supplying an installation verification reference. The existing no-login installation owner processes the request through the complete cutover adjudicator, including current authority, company entitlement, source/calendar/message-plan equality, original PDF validation and installation receipt. Activation, imports, finalization and completion status share one transaction/savepoint. Failure records a generic audited terminal state and leaves failed effects rolled back. Pending, Completed and Failed are distinct UI states.

The proposed organisation vocabulary is Personnel Business Unit → Probation Business group, and Company → Probation Business unit. Department and the case starting-grade snapshot retain their owners. Each new source/definition pins its mapping version. Existing untagged definitions remain legacy-v1; retained UUIDs are never reinterpreted, and signed merge snapshots are never rewritten. Canonical PBP scope continues to use its original company and Personnel Business Unit identities.

Mapping activation is dormant and owner-only pending review of a current inventory. The 4 November staging inventory was delivered as attachment `9618a885-c516-4f5f-b9af-9e3341b00afa` on feedback `30187150-46eb-4856-9500-490c7c14035f`, revision2. It covers that board tenant only, not a separately inspected production installation. No mapping register row, migration or live configuration was applied during implementation.

The tracker keeps its full columns and counted clickable tiles. Names are suggested only from visible case facts; the query is a bounded literal case-insensitive substring match, not an unrestricted Personnel search. Cascading facets are derived before pagination. Screen and export share the same query parser and drop the retired PBP/state dropdown parameters.
