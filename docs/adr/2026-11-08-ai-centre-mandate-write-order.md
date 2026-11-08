# AI Centre mandate control: native write order

**Status:** Proposed; source candidate, native execution pending dual review.
**Date:** 2026-11-08
**Deciders:** Repository owner and independent source reviewer.

## Context

The canonical 3200 row trigger locks `NEW.tenant_id` only after PostgreSQL has
chosen/locked the row. The stop setter already takes Access then AI before its
upsert; the manager-policy setter and directly granted application INSERT/UPDATE
also reach that row trigger. Their competing row/advisory order can deadlock.
A statement lock on the bound tenant alone would still allow a foreign NEW tenant
to reach the canonical AI lock before RLS WITH CHECK rejects it.

The two actual production write owners are `setMandateStopSwitch` and
`setManagerRevocationPolicy` in `core/mandates/mandates.ts`. The tracked source has
no additional initialization/seed/agent/worker INSERT/UPDATE owner. Both setters
can initialize the row; existing native defaults and version semantics remain
owned by 0924/0926 and `app.teras_bump_version()`.

A metadata-only Repeatable Read/Read Only staging observation at
2026-11-08T13:50:05.841Z pinned the actual 709 ledger, both original triggers,
three policies, table grants/RLS, actual version/lock definitions and native owner.
Its SHA256 is `85839b9104bc187ebc8c3bc3535e85af11b26a6d6855f50a799ad2a579d5f277`.
The earlier ten function bindings and ledger are unchanged from the prior audit.
This observation grants no installation or deployment authority.

## Decision

Append the already reserved `3501_ai_centre_mandate_write_order`, index2801,
when1793330003101. Preserve every predecessor SQL byte and journal tuple.
Guard the actual native table ACL/RLS, both original function definitions/body/ABI/
owner/config/private ACL, exact policies and original enabled trigger definitions.
Refuse unknown same-table user triggers, reserved names or guarded drift with55000.

A private **invoker BEFORE STATEMENT** INSERT/UPDATE trigger validates the bound
tenant and takes exclusive Access then AI primitive locks before any row.
A private **invoker BEFORE ROW** trigger named before `aaa_ai_centre_control_lock`
checks INSERT NEW and UPDATE OLD+NEW against that same tenant and denies42501
before a foreign NEW tenant can reach the canonical row lock function.
Neither trigger duplicates human/admin/agent authorization or calls the running
assertion: stopped-to-running resume must remain possible. Original row functions,
triggers, ACL, RLS, defaults, version rules and audit decisions stay unchanged.
New functions have owner-only EXECUTE. No role or production data is synthesized.

Owner maintenance INSERT/UPDATE explicitly binds one target tenant in the actual
owner LOGIN transaction. Missing/malformed bindings and cross-tenant rows refuse.
This bounded course preserves owner authority without inventing a human principal.
Owner DELETE/TRUNCATE and test tenant-CASCADE custody remain unchanged.

## Options and consequences

An application-only ordering change leaves directly granted raw native writes
unprotected. Replacing the canonical row lock does not move it before row choice.
Disabling locks or using the running assertion would weaken admission or prevent
resume. The guarded statement-plus-row append covers all current write courses
while preserving existing owners; it serializes control writes per tenant.

## Verification and remaining work

The new native upgrade fixture uses actual archived 0180/0212 bytes, an isolated
historical709 database and the already reviewed per-kind owner constructor.
Its separate real non-super owner LOGIN has the actual nine flags and three
memberships. No extra CREATEROLE/BYPASSRLS or SET ROLE positive substitute is used.
It checks a genuine final-guard refusal rolling back all38 pending entries, then
honest positive stock709→746 and746→747 phases, populated rows/actual ledger,
original native catalogue identity, seventeen independent rollback-only DDL drifts,
bound/unbound owner writes and defaults/no-op versions. Four real foreign-lock
courses cover INSERT/tenant-changing UPDATE in both transaction-start orders;
42501 must arrive while the foreign AI holder remains locked, with no foreign
wait/acquisition. Original RLS denial remains separately asserted.

The ordinary native file calls the unchanged product setters. One course holds a
real raw UPDATE; the other holds the actual audit-table INSERT effect barrier
after the real stop setter has locked and changed its row. Both observe actual
Access-key waits/blocker PIDs, settle every promise and compare exact rows,
generations, foreign tenant and audit payloads. Native current-principal/RLS,
stale-generation refusal, stop/resume, policy initialization and rollback remain
asserted. No guards or effect bodies are patched.

The upgrade case declares300s, four max1 pools/connections, one extra real owner
LOGIN pool, five-second lock/pool-close bounds, ten-second statements, bounded
observers and exact database/role absence cleanup. Ordinary cases use existing
native pools, no new pool, at most four simultaneous fixture connections and60s
per case. Partial receipts are component-only and become complete only after
assertions. The old3500 fixture retains its exact owned746 input boundary and all
its original assertions; its earlier evidence is not relabeled onto this source.

Local verification is Git/hash/source/external AST only. Standard hosted Actions,
root plus independent FULL source review and explicit execution are still pending.
The 3500 component evidence joins29 at8c22/run42485943511,23 unaffected at0b15/
run42484550879 and7 source-owner cases at7e491/run42483981970; these are distinct
source/run identities, not one59-case run. No generated AI manifest, provider
approval, release certificate, staging deployment or production authority renews.
