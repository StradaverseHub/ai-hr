# Legacy WorkOS cutover reference

WorkOS cutover is no longer the approved installation direction. [ADR-0117](adr/0117-embedded-hr-authentication.md) replaces ADR-0098's Keycloak direction with embedded HR login, MFA and recovery. Use [the internal-auth installation guide](../deploy/internal-auth/README.md).

WorkOS remains a compatibility adapter in source, including its SDK and legacy subject column. That does not mean a deployment uses it. Inspect provider selection, middleware/session resolution and private installation configuration before changing authentication. Preserve app-user IDs, person links, grants, invitations and audit history; never bind identities solely by email. Authentication failure must not fall back to demo access.

The previous runbook mixed historical demo state, installation-specific identifiers and superseded WorkOS activation steps. Recover it only for an explicitly scoped legacy installation investigation:

```sh
git show d8b2bac9705fd8fbc4d3eb500262b19858bf297d:docs/WORKOS-CUTOVER.md
```

No provider activation or retirement is performed by this documentation change.
