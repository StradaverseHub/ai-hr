# V9 providing-team recovery boundary

Status: owner explicitly approved scoped team recovery on 30 October 2026. Implemented in the unallocated candidate with focused database and component verification; complete affected regression passed 135 tests and both recovery journeys passed again after the final account-check lock ordering change; six capability-inventory checks passed. The local compiler exhausted its default 4 GiB heap, so current type verification remains outstanding. Release sequencing remains held under the separate owner instruction in MOBILE; this approval grants no deployment or real-account access.

The supplied HTML gives providing teams return/revoke work. An employee declaration remains separate from an actual issuing-record recovery. The approved implementation adds a confirmation action for the currently assigned providing-team member.

## Permission and behavior

Only the freshly authenticated, active user currently assigned to an item and still in its actual providing group may change that item's operational status. This grants no HR case access, settlement access, module administration, global HR/IT role or account/group membership. View-only case-page access alone remains insufficient.

A narrow capability exposes only the assigned item's source pointers and identity needed to reach its issuing owner. Another user, tenant, group, item, closed case or stale revision fails. The actual case record remains private.

For Native onboarding holdings, the existing recovery writer verifies the exact open offboarding item, employment/company and original case/request/item IDs, then updates its original recovery receipt and history. For physical asset-register holdings, the existing asset return owner still requires existing IT authority; no providing-group permission bypasses that requirement. The owner rechecks the expected company and employee holder after locking the asset.

The offboarding status writer accepts only To do, In progress or Done for that one item. It does not accept arbitrary case patches, HR exceptions, Not needed or Not returned. Done for an issued item requires the actual source recovery to have succeeded in the same transaction. A declared employee return alone never satisfies this check. Existing recovery facts prevent reopening unless the issuing owner had first corrected them.

## Required verification

Test actual Native and asset owner changes, unchanged prior issuance/handover/signatures, transactional rollback, source-holder changes, current assignment/group revocation, unrelated item/tenant/employee rejection, stale revisions, direct completion before actual recovery, closed cases, and absence of private HR data. Render employee declaration and team confirmation as distinct actions, with retained errors and no simulated external revocation.
