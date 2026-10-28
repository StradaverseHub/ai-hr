# Customer deployment acceptance

This checklist replaces the September 2026 survey and accumulated progress narrative. No checkbox or old row count establishes current readiness. The original findings remain recoverable with `git show d8b2bac9705fd8fbc4d3eb500262b19858bf297d:docs/CUSTOMER-DEPLOYMENT-READINESS.md`. Verify each requirement against the exact shipping source and target installation; retain evidence, owner and unresolved limits in the acceptance record.

## Before real employee data

- Use [customer deployment](../deploy/CUSTOMER.md), not the demo seed path. Verify actual target, separate runtime/migration/backup identities, ownership, grants, private environment and startup refusals. No demo identities or business-data seed may reach a customer installation.
- Establish required audit chaining before first data load and verify real new events. Prior unchained events do not become protected retroactively. Preserve immutable audit/erasure policy and accountable decisions.
- Follow [embedded authentication](../deploy/internal-auth/README.md) and ADR-0117, which supersede old WorkOS/Keycloak activation plans. Bootstrap the exact existing/authorized administrator without email-based adoption, preserve internal IDs/grants, complete password/MFA/recovery and prove live revocation, invitations and cross-organization refusals. Check actual provider and demo configuration; source compatibility adapters are not activation evidence.
- Verify trusted app/origin/device TLS and renewal, security headers, scoped public endpoints and fail-closed auth. A frontend certificate does not establish origin trust; a healthy gated demo is not real customer authentication.
- Install off-host backups with explicit retention, schedule, accountable recipient and recovery objectives. Run a real restore with schema/count/ledger/RLS/grant and app-role checks, matching keys/configuration and measured working-login recovery. Implement and rehearse WAL/PITR if objectives require it. Backup script existence or a fixture pass is insufficient.
- Commission monitoring, failure and missing-run alerts, log rotation and verified recipient delivery. Check actual installed cron/timer/service state. Application errors written to stdout may have info priority; priority filtering alone is insufficient. A host must not be its own sole availability monitor.
- Inspect tenant and company isolation through the application role, independent negative tests and real authorized sessions. Validate imports and customer-owned opening balances without treating seeded counts as evidence of real usage.

## Payroll and statutory acceptance

Name the accountable reviewer and required sign-offs. Verify current official statutory sources, exact pack/ruleset versions, saved calculation provenance, multi-cycle and concurrent-employer boundaries, deduction/net-pay protections, reversals and imported-history treatment. A golden calculator test does not prove filing or disbursement acceptance.

Reconcile payslips, bank files, agency outputs, annual/monthly totals and recorded payment/filing state against independent expected values and the real bank/agency process. Preserve drafts/unavailable evidence distinctly from zero or approved. Verify Unicode/row layouts and actual exported artifacts. Enable financial features only after their current policy and sign-off gates pass; historical “built” labels grant no authority.

## Operational release acceptance

Freeze the candidate and authenticate its required tests, type checks, Linux build, migrations and rendered role-based journeys under [CI policy](CI-STAGING-VERIFICATION-POLICY.md). Preserve original failures and validated affected repairs; never manufacture evidence or relabel it onto another source.

Rehearse both a fresh customer installation and a populated upgrade. Verify ordered migration IDs/hashes/timestamps/watermark, explicit data-script effects, exact source/build arrival, service restart/health, installed jobs and rollback compatibility. Recheck actual account/recovery email receipt; configuration save/test is not universal delivery acceptance.

Exercise employee, manager, HR and operator journeys with proper tenant/module/company boundaries, unavailable/history states, permissions, accessibility and supported locales. Test native network/TLS/device behavior separately from browser/component evidence. Agree load, latency, error, resource and recovery thresholds before capacity tests; see [UAT procedure](../deploy/UAT-HOSTING.md).

Confirm support, incident response, backup restoration and credentials/key recovery with named owners. Record each unknown or unmet prerequisite; source implementation is not commissioning. Follow [repository policy](REPOSITORY-AND-ENVIRONMENTS.md): staging acceptance precedes a subsequent explicit owner request for production. Branch alignment, a tag or private package publication is not a live deployment.
