# WP2 — runtime tier enforcement (R17)

Rechecked against integration base `b5758c54c431765461d84235ad19c72ad71cf578`, after fetching matching main/alpha on 29 October 2026.

- Verified still open: `AGENT_ACTION_TIER_CEILING` had no runtime consumer; only the inventory test read it.
- Added a fail-closed runtime guard for unknown entries, Handoff entries, above-ceiling execution and scheduled actors reaching human command services. Prepare and confirm custody boundaries call it before IO; existing permission, subject, digest, receipt and transaction checks remain in place.
- One exported never-Automatic category constant drives the policy type and runtime refusal. Every declared action is category-classified; type checking validates each literal category/ceiling pair. No current entry gains Automatic authority.
- Focused checks: `test/agent-action-tier-guard.test.ts` and `test/agent-capability-inventory.test.ts`, 11 tests passed. They include both real generic service boundaries refusing before a transaction, unknown/Handoff refusal, Approve vs Confirm, malformed policy, and forged Automatic sensitive categories. Initial invocation failed setup because the new checkout lacked test URLs; the successful no-DB run used closed-port URLs.
- Already fixed at this base: none of R17.
- Remaining: a future Automatic executor must call the exported runtime guard. No such executor is introduced. Generic per-entry role-matrix work remains WP8 and is outside this run.

Exact-candidate gate evidence is recorded in the PR after freezing the commit. No UI changes, screenshots or live provider checks apply. Staging installation/acceptance and deployments are not performed. No migration is required. Next package: WP4 (R9).

## Combined release re-verification

The release integration rechecked the merged principal, own/assigned and HR-prepared action families. Seven added IDs are category-classified; generic assigned prepare/confirm paths call the same human-reviewed tier guard before IO. No scheduled actor gains model spend or authority. Original package findings and receipts above retain their original base; combined verification is recorded separately on the release PR.
