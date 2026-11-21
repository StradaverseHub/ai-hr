# Contract and Probation Business Partner compatibility

Status: implementation under review; not installed or runtime-qualified. Prepared from combined source 56a33b3eee49a28125eaaed9a7836a308873f417 for the owner-authorized combined staging compatibility work. STAGING owns allocation, integration, qualification and installation.

## Existing responsibility and regression

The accepted shared-builder direction places shared configuration in HR Automation. Native Contract PBP scope still delegates to lifecycle_canonical_pbp_scope/user from 0953, and the current paged intake 6404 and tracker/navigation 6432 also resolve the same rules directly. Board 6103 removed the Onboarding/Offboarding PBP controls and clears lc_v9_config.bpRules. Keeping the old function definitions did not preserve their input. Removing positive fixtures would conceal this incompatibility.

Probation's current 5764 routed-holder owner already prefers its explicitly designated shared BP routing, including multi-holder/group and fallback behavior. Its absent-route legacy adapter and the explicit probation_assign_access scope check remain compatibility consumers. That designated routing precedence must remain unchanged. Older superseded holder definitions are not additional active owners.

## One fact owner, existing authority

Shared Business Partner responsibilities have their own native tenant configuration and immutable revisions. HR Automation > Assignment groups presents the editor. These facts supply existing Contract/Probation business scope; they do not grant an Access role, document signer or Onboarding/Offboarding recipient.

The writer retains the old v9SaveConfig administration boundary: tenant-wide app.is_group_admin(), lifecycle entitlement and actual current tenant principal. Native validation additionally proves the active account and linked Person, current tenant-owned scope IDs and selected actual accounts. Company-scoped HR admin, Contract Configure/Manage Access, shared-group editing or named-route editing do not acquire this authority. Native save owns CAS, strict validation, canonical lock ordering, immutable revisions and audit atomically. Tables are forced-row-secured, with no direct application mutation. Public execution is revoked; only narrow native management ports are granted to the application role. Purpose-role ownership and membership remain unchanged.

The initial owner is empty. No historical configuration, archived membership or previous cleared assignment is automatically restored. An authorized administrator explicitly records reviewed current responsibilities. BP-dependent readers deny safely until configured; the editor explains the missing setup.

## Scope semantics and bounded reads

Rules retain the existing strict shape: a user ID plus optional company, businessGroup and department ID arrays. In this legacy business rule, businessGroup means an actual Business unit UUID matching Assignment.business_unit_id. Generic named-routing Business group choices use parent Company IDs and are not interchangeable. The UI labels this dimension Business unit.

Canonical resolution preserves the existing specificity weights 4/2/1, one distinct highest-match account, ambiguous/no-match denial, current account/Person and subject guards. Existing Contract opt-in assignments narrow the business responsibility and retain date, company/BU and own-person exclusions. Active set-based intake/tracker readers use the same native source; request loops are not introduced.

Full rules and selected account/scope labels are readable only through the exact native management predicate. Non-administrator consumers receive their existing authorized resolution/subject facts, not complete routing configuration. Management search is bounded and set-based for actual accounts, Business units, Companies and Departments; selected labels come from the same saved configuration.

## Qualification

Source review is separate from hosted runtime evidence. Required coverage includes strict app/declaration/whole-test types, native management authority and direct-table denials, CAS and immutable history, current Person/account and foreign-scope negatives, positive/specific/ambiguous/self/expired opt-in behavior, current Probation designated-route precedence, paged 70-company/1,000-employment equivalence, the exact populated Board-baseline restricted-owner upgrade, and affected rendered journeys. Earlier frozen walkthrough/build failures remain attributed to their exact source and are not relabeled. No production deployment follows from this staging repair.
