# Entra integration source review

PR #194 implements cloud and hybrid AD inbound provisioning plus Microsoft login for web and mobile.
The isolated candidate integrates PR #196's shared web idle policy at frozen source
`2dd7fc4d7152e3f91a99b3586be3593edd41136c`; PASSWORD CHANGE remains a separate integration dependency.

## Findings addressed

- HR/configuration changes must preserve an active provisioning lease and its submission phase.
  Expired unknown uploads stay uncertain rather than being blindly replayed. Tests cover employee
  and connector changes during an upload.
- Scheduled offboarding must revisit identities waiting for an explicit HR login binding.
- Confirmed upload receipts transition durably to directory verification. Temporary directory read
  failures and manual retries resume verification without another upload.
- Concurrent Microsoft login must use the transaction's existing database connection rather than
  acquiring another connection while holding the shared pool and identity lock.
- Connector organization codes must match the canonical encrypted HR organization registration.
- Explicit identity binding must verify the winning immutable binding after conflict handling.
- Microsoft HTTP entry points now bound concurrent requests and return retryable rate refusals
  without clearing an existing login flow.
- Shared web activity handling recognizes Microsoft sessions. Their configured idle timeout is
  enforced atomically, expiry is audited once, background reads do not renew activity, older web
  records initialize safely, and native tokens retain their separate lifetime contract.

## Security and data boundaries

The source retains tenant-specific OIDC issuer/audience/nonce/state/signature and PKCE validation,
immutable directory-object bindings, no email-based adoption, encrypted connector secrets, scoped
administration, audited effects, and native proof exchange without bearer tokens in deep links.
Provisioning readiness requires independent verification of the immutable source marker and target
state; hybrid readiness additionally requires Entra synchronization. Uncertain creates require
operator reconciliation. Microsoft and AD privileges remain operator-configured.

The private SQL services have fixed search paths, explicit execution grants and tenant/admin checks;
raw operational tables are denied to the application role. New auth actions are AI handoffs, not
agent-executable access changes. The exact AI source review and unchanged approval scope are recorded
in [the provider review](ai-provider-owner-approval-2026-10.md#technical-source-review--2-november-2026-pr-194-with-shared-idle-policy).
No new provider contract is approved.

Microsoft API contracts checked against [bulkUpload](https://learn.microsoft.com/en-us/graph/api/synchronization-synchronizationjob-post-bulkupload?view=graph-rest-1.0),
[provisioning logs](https://learn.microsoft.com/en-us/graph/api/resources/provisioningobjectsummary?view=graph-rest-1.0)
and [cloud/hybrid provisioning configuration](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/inbound-provisioning-api-configure-app).

## Required evidence and limits

Hosted focused regressions precede the full security/data gate. Release evidence must identify the
frozen aggregate source, controller and actual staging migration baseline, with whole compiler,
production build, all test batches, browser engines, migration checks and independent artifact
verification. Neither a member PR's gate nor a focused pass is aggregate release authority.

Migrations `0898` and `0899` are uninstalled reservations. Recheck the live ordered ledger and
watermark before any installation; preserve applied bytes and the accepted journal prefix.
IT will configure the non-production Entra tenant and hybrid AD environment after source verification.
Live cloud/hybrid provisioning, enterprise conditional access and physical mobile Microsoft login
acceptance remain unverified until that environment is available. No live directory call, privileged
setup, production deployment or store submission is asserted by this source review.

## Complete-gate findings and final contract integration

Original full run [41342509559](https://github.com/StradaverseHub/ai-hr/actions/runs/41342509559)
qualifies only frozen `c6cd46f1cb6715371f27942e5bae51d228b1840d`; its failures remain original evidence.
All application chunks finished before repairs were prepared in a separate worktree. Findings:
missing shared loading boundary, undeclared Entra sidebar row, missing scope explanation,
authentication vocabulary split between web/native, missing Entra dependency ports in existing
HTTP/native fixtures, and four explicit historical source-tail expectations needing the two new
migration identities. Repairs preserve historical prefix hashes, fixed predecessor cuts, retained-data
and authority assertions, and explicitly pin the new SQL bytes.

The final shared provider contract from PR #196 `90346adf0` adds the `active`, `not-enforced` and
`expired` outcomes. Entra registers its enforcing recorder before live-identity fallback; an expired
Microsoft session is removed and audited before fallback runs. Tests exercise the real activity
endpoint with a fresh Microsoft cookie and after its configured idle limit, plus native Microsoft
selection through the shipped screen without submitting a local password.

This integration adds `test/session-activity.test.ts` to the complete test inventory. The existing
cross-source recovery policy requires identical suite/unit inventories and therefore cannot adopt
this aggregate using the original plan. The changed authentication contract and complete-inventory
identity require fresh aggregate qualification, rather than relabelling old artifacts. Failed and
successful original evidence is retained; focused repair passes alone grant no release authority.
