# ADR-0135 — Configurable access has one effective-permission interpretation

Status: implementation in progress; no permission migration or release yet.

The approved Security plan is not an editable copy of Function Access. The existing grid is a reference over route guards; record authority also lives in SQL, service owners, dated organisation relationships and specialised payroll/onboarding permissions. A role-to-group wrapper alone cannot satisfy individual-deny precedence over the actual operations.

The canonical group/membership/individual-override owner will produce bounded, revisioned effective permission snapshots. Positive grants combine and an explicit matching individual denial wins. Company coverage is evidence from the existing database company resolver, not a new JavaScript hierarchy. Tenant-scoped powers require tenant authority. Unsupported or incompletely bound capabilities refuse rather than appear as working controls.

A protected customer System Administrator and installation operator remain different authorities. The existing operator grant cannot be minted by this feature. Default conversion must demonstrate equivalence for real users and organisation-derived managers; a role name alone does not capture existing authority.

Every exposed capability needs a reviewed binding inventory for page, action, record query, export, background work and applicable SQL. Existing payroll/onboarding owners remain authoritative, with explicit adapters rather than copied permission tables. A signed-in cookie cannot freeze authority: the trusted owner must refresh principal, revision, current login and effective access inside the protected transaction. A stale or forged SessionContext cannot manufacture a grant.

All mutations require fresh actor ceiling and exact expected revision under one tenant access lock; preview and commit use the same resolver. Protect the final active system administrator against concurrent membership removal, denial and account deactivation. Audit bounded identities and permission changes without HR payloads. A preview must also explain access remaining through another group after one grant is removed.

Source inventory and pure access-algebra regression cases are preparation, not executed acceptance. No feature may ship until its complete enforcement bindings, equivalence, revocation, concurrency, audit/recovery, actual role journeys and restricted-owner upgrade are demonstrated. Migration0579 is centrally reserved after Board1's0576/0577 and ESS0578; no0579 SQL is written yet.
