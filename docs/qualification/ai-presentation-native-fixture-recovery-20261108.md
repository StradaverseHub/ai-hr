# Recover the AI presentation fixtures without changing approval authority

Source-only child of `ea98af7e3b45f7d3f9db776b72c1ed5d2343ca73`.
Original hosted run `42403840579` remains **failed**: DB142 passed/16 failed,
pure15 passed and Linux build passed. Its native presentation file passed10/13;
provider readiness passed5/18. Retain every original outcome/source identity.
No application, native SQL, compiler flags, deadline, literal approval, pending
contract, provider transport or live environment is changed by this recovery.

## Actual native failures and bounded correction

The two held-Access legacy checks lasted31.215s and30.741s against Vitest's unchanged
30-second case budget. Their real application carriers did not have the assumed
300ms lock timeout or20-second statement timeout. The new presentation read itself
was not the timed-out legacy exclusive call. The relink fixture failed PostgreSQL
23502: `person.primary_email` was omitted from a required native column.

Only `heldBarrier` now scopes a `withTenant` spy around the actual captured native
owner. It passes the same real transaction, context and isolation options; installs
and verifies `SET LOCAL lock_timeout='300ms'` and `statement_timeout='20s'` before
the actual service callback. It does not mock a transaction, lock, permission check,
query result or failure. Capturing the original owner once prevents nested/global
spy recursion. An owned AbortSignal is composed with any incoming read signal.
Every exit releases the real holder and restores the spy. `afterEach` cancels and
drains any outstanding holder lifecycle before the next fixture can start.
Cancellation releases the held lock; it does not pretend to cancel an already
executing PostgreSQL statement. The native statement budget remains the fallback.
The relink person receives a unique fictional `example.invalid` primary email.
Existing old-barrier refusal, zero-effects, scope and principal assertions remain.

## Actual provider-readiness refusal remains a gate

Both fixed synthetic contracts retain literal approval digest
`261d6298b853a76e91fbc494d64d14099cdbca115cafdd47932828daef8f463a`.
The actual ea98 generated transform digest is
`e9e422d54fd2762d18b5289b8824a740410c44c8271627a7d28c7cf24c87cfd5`.
`assertProviderDataContractReviewed` requires exact equality and therefore refuses
with `AiPrivacyGateError(reason='unreviewed')`. `generateDraft`/`converse` execute
that guard before governed admission and transport. The public readiness owner
catches this as `probe_failed`; its positive tests observe zero transport/model
runs instead of their expected actual synthetic outcomes.

Two separate native diagnostic cases prepare an actual persisted candidate,
issued snapshot, strict evaluation root and canonical private echo/tools task,
then invoke the real gateway. They assert the exact unreviewed refusal, zero
before-call observations, zero observed HTTP requests, and unchanged zero native
model runs/readiness receipts. Node diagnostics channels observe HTTP without
mocking reviews, gateway, admission or transport. No synthetic spend certificate
or disclosure authorization is installed. Temporary crypto configuration is
fictional fixture material, not an authorization switch.

These negative diagnostics **do not repair or replace** the13 positive readiness
failures. The original readiness file, all literal approval/provenance bytes and
the two pending contracts remain unchanged. Positive readiness capability cannot
qualify until a separately authorized exact-source disclosure binding exists.
Do not relabel a narrow recovery pass as those13 passing or all AI work complete.

The recovery manifest selects the repaired13-case presentation file plus the two
diagnostic cases. All15 are prepared, unrun here. Existing valid unrelated evidence
remains at its original identity. Root and independent review precede standard
hosted verification. No local app/DB/runtime/compiler/build checks, provider/network
calls, upload, staging installation or production operation occurred.
