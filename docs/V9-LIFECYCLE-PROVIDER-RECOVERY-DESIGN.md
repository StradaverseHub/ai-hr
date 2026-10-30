# V9 providing-team recovery proposal

Status: not implemented or applied. Automatic approval review rejected the separate recovery-authority expansion after the owner approved group case actions. The rejected UI/test command did not execute. An earlier uncommitted backend proposal was removed from the candidate and preserved privately for review. Group page and case-action work proceeds separately.

The supplied HTML gives providing teams return/revoke work. Today an employee can declare a device returned, while HR confirms the actual issuing-record recovery. An assigned team member can see the assigned item but has no corresponding recovery confirmation action.

## Proposed permission and behavior

Only the freshly authenticated, active user currently assigned to an item and still in its actual providing group could change that item's operational status. This would grant no HR case access, settlement access, module administration, global HR/IT role or account/group membership. View-only case-page access alone would remain insufficient.

A narrow capability would expose only the assigned item's source pointers and identity needed to reach its issuing owner. Another user, tenant, group, item, closed case or stale revision would fail. The actual case record would remain private.

For Native onboarding holdings, the existing recovery writer would verify the exact open offboarding item, employment/company and original case/request/item IDs, then update its original recovery receipt and history. For physical asset-register holdings, the existing asset return owner would still require existing IT authority; no providing-group permission would bypass that requirement. The owner would recheck the expected company and employee holder after locking the asset.

The offboarding status writer would accept only To do, In progress or Done for that one item. It would not accept arbitrary case patches, HR exceptions, Not needed or Not returned. Done for an issued item would require the actual source recovery to have succeeded in the same transaction. A declared employee return alone would never satisfy this check. Existing recovery facts would prevent reopening unless the issuing owner had first corrected them.

## Required verification

Test actual Native and asset owner changes, unchanged prior issuance/handover/signatures, transactional rollback, source-holder changes, current assignment/group revocation, unrelated item/tenant/employee rejection, stale revisions, direct completion before actual recovery, closed cases, and absence of private HR data. Render employee declaration and team confirmation as distinct actions, with retained errors and no simulated external revocation.
