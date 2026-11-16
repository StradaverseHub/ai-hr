# Shared permission compatibility proposal

Not applied. Automatic review rejected replacing shared authorization functions across modules without specific scope approval.

The proposed patch restores Offboarding branches overwritten when Contract migrations follow Resignation. It changes no role, permission, grant or existing Probation/Contract predicate. Each existing function is retained byte-for-byte except one added branch copied exactly from the already reviewed Resignation migration. There are no GRANT/REVOKE statements in this proposal.

- Configure Offboarding: existing signed-in tenant group administrator AND native Offboarding access (5784).
- Read Offboarding runs: existing native resignation journey access (5783).
- Execute Offboarding steps: existing protected resignation runtime intent (5783).

The default remains deny. Contract execution continues to require its held accepted kernel event, and Contract run reads still require Case View. Probation guards remain unchanged. This is a candidate-local compatibility repair, not deployment authorization. Required checks include all three modules, denied actors, forged runtime intents, cross-company/tenant access and existing shared store/email regressions.
