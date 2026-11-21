# Isolated Rewards audit-floor proof: fixed snapshots and admission order

Status: source work in progress, unnumbered, uninstalled, unexecuted. This note
supersedes the unsafe old-RR limitation in the initial native-policy WIP, not
any qualified source or receipt. Neither this prototype nor a passing floor
experiment authorizes page adoption. Original315, factory a2, pure3 and legacy323
receipts retain their original identities.

## Facts that shape the protocol

The exact315 and qualified d12 `db/client.ts` apply the process-local
`chainArmingDecision` result and GUC before `fn(tx)`, but acquire no audit-chain
advisory lock there. Bank's `assertBankMaintenanceActorTx` acquires native
workforce/Access/profile barriers; subject preparation can lock company and
statutory tuples. `assistant_bank_review_arm` later locks the review tuple and
calls `_domain_event_next(...,true)`. Catalogue's native phase likewise owns its
review tuple before its try-lock audit preimage. Existing try-lock refusal is
intentional protection against waiting in that order. A floor OR in the final
trigger does not establish a safe new early command-admission order.

There are two distinct lock families: `audit-chain:<tenant>` serializes native
chain/preimage ownership, while `payroll-history:<tenant>` protects payroll
correction/calculation snapshots. This proof must not conflate them or rearrange
Access/payroll-history ownership by implication.

PostgreSQL16's key-share/non-key-update path is unsuitable as an assumed stale-RR
safety proof. `heapam.c` can return TM_Ok without waiting when keys are unchanged;
`nodeLockRows.c` raises serialization failure only for TM_Updated. A stronger row
lock would conflict with first-floor UPDATE and could block the first receipt
behind an already-running Bank command. No such solution is accepted here.

A separate PG16 mechanism has a direct source contract: the ON CONFLICT DO NOTHING
executor calls `ExecCheckTIDVisible`, which raises40001 for another transaction's
conflicting tuple invisible to a fixed transaction snapshot. This is a proposed
native proof route, not a claim of measured behavior.

Primary sources:
- [PG16 explicit locking](https://www.postgresql.org/docs/16/explicit-locking.html)
- [PG16 heap key-share implementation](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/access/heap/heapam.c)
- [PG16 row-lock executor](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/executor/nodeLockRows.c)
- [PG16 conflict visibility executor](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/executor/nodeModifyTable.c)
- [PG16 named/deferred constraint timing](https://www.postgresql.org/docs/16/sql-set-constraints.html)
- [PG16 exception subtransaction behavior](https://www.postgresql.org/docs/16/plpgsql-control-structures.html#PLPGSQL-ERROR-TRAPPING)

## Durable floor and fixed-snapshot experiment

An immutable marker has a unique tenant key and records the first real armed
receipt ID, original actor/time and policy version. It is inserted in the SAME
transaction as finalization of that actual armed receipt. It has no content,
actor or tenant FK. A sealed deferred constraint requires the matching immutable
receipt and armed native policy observation before COMMIT. No marker UPDATE,
DELETE, automatic retention or history re-creation is allowed. Receipt metadata
retention is a prerequisite; ordinary data retention cannot discard the floor.

RC observes the immutable marker through its fresh command snapshot. A visible
true marker is sufficient in fixed-snapshot modes too. When an RR/SERIALIZABLE
writer sees no marker, the private owner tries inserting an incomplete marker
using the same unique tenant key inside an exception subtransaction. It ALWAYS
raises its exact private sentinel and rolls that subtransaction back before
returning a false/true probe result. A native40001 is never caught as a benign
probe. The named completeness constraint is temporarily deferred INSIDE that
same rolled-back subtransaction, preserving a caller's previous ALL IMMEDIATE
state. A probe cannot create durable arming or retain a row lock after return.

This permits an already-adjudicated false native frame to finish before first
projection, with the original History ownership preventing projector interleave.
A new writer with an older RR snapshot cannot silently ignore an already committed
marker. If a concurrent first receipt commits after the writer's successful
absent probe, that writer can serialize before the receipt. Native frame custody
remains tenant/root-XID/actual-PID/backend-start bound. Only the new floor bit is
stable; current setting, GUC, canonical history, head, source authorization and
all PRE equality checks remain fresh and unchanged.

Any receipt RR conflict aborts the whole read transaction before a DTO is returned.
No automatic replay of financial commands or invented success occurs. Production
retry/reconciliation policy remains a separate owner-reviewed gate.

## Required real native controls before accepting the experiment

All actors use real physical sessions and fixed budgets: max1 connections,
2s startup,20s SQL,300ms locks, existing30s native cases and owned cancellation/
drain/restoration. Controlled waits use actual PID/start and native lock witnesses.

1. Old RR snapshot, first actual armed receipt COMMIT, platform settingfalse,
   actual new event attempt: native40001 and no event/money mutation. A fresh RR
   writer chains through the committed floor. SERIALIZABLE has the same safe
   refusal requirement, without broad mode restrictions.
2. Two RR writers serialize on the actual audit-chain lock. Absent probes leave
   no marker after each successful unarmed command. No stale false frame can
   be replayed across root XID or backend-start identity.
3. Pause after the actual unique probe inserted its temporary row; start a
   genuine first armed receipt on another session. Native lock evidence binds
   both sessions; release within existing300ms. Receipt COMMIT succeeds only
   after probe rollback, remains atomic, and the command frame stays false.
4. SET CONSTRAINTS ALL IMMEDIATE before/after probe, nested savepoint rollback,
   unrelated native error and failed/uncertain COMMIT cannot commit an incomplete
   probe or fabricate a floor. Direct app/reader/projector writes/APIs refuse.
5. First genuine marker is immutable across later armed receipts, rollback,
   cleanup, disconnected acknowledgment and fresh service restart. Exact receipt
   reconciliation returns metadata only; no silent read replay.
6. Valid three-transaction old-reader-snapshot -> settingfalse -> Bank PRE ->
   receipt COMMIT race: fresh-OR counterexample refuses with unchanged money;
   stable floor frame preserves the real successful Bank effect and canonical
   PRE/effect equality. Repeat for the exact Catalogue native owner.
7. Head/hash advance, current policy changes and real permission revocation
   remain canonical. An unavailable dedicated reader cannot disable the floor
   for independent HR writers.

## Mandatory separate adoption boundary

The floor proof above is not the application write-admission proof. Before any
page/export adoption, define and qualify a native floor-aware canonical command
entry BEFORE the business callback/row locks, covering fresh workers whose JS
cache and entitlement snapshot arefalse. Explicit RR/RO presentation reads must
never enter this write route. A blind change to generic withTenant would also
capture ordinary GETs and is therefore outside this proof.

The command-owner inventory must establish the actual global lock order across
payroll History, Access, audit History and business tuples, including raw/native
writers and processors. Existing Bank/Catalogue try-lock safety cannot simply
be replaced by blocking acquisition after business locks. An early audit-only
lock also cannot be added ahead of all existing Access/History locks until a
real inverse-holder deadlock analysis is complete. The next adoption slice must
choose one canonical native admission owner with current principal checks and
an explicit command carrier; retain strict native fallback refusal for bypassed
carriers rather than treating a JS cache as authority.

Required adoption tests hold actual Bank/company/statutory tuples, audit-chain,
payroll-history and Access locks in the documented orders, start fresh-worker
commands before/after first floor COMMIT, and prove actual completion or exact
safe refusal with no deadlock, partial business mutation, duplicate money/event
or page Busy. First successful receipt, first projection and older overlapping
command linearization must be explicitly bound. Unconverted/unsupported command
carriers remain blockers; this document makes no all-module acceptance claim.
