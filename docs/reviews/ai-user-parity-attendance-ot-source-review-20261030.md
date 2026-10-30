# OT native source/proof review — 30 October 2026

Reviewed source: `de646e88f2e8ba0545ac9826045b9eb540bc392a` and its preserved contract base. Scope is the unmounted native OT owner/evidence foundation plus provisional0753, not a completed Assistant action. PR127 remains `ce0ace24ed0957d9f1655b8a6e25c13d352edfe8` and is unchanged.

## Findings and repairs

| Finding | Risk | Repair |
| --- | --- | --- |
| P2: receipt subject comparison could evaluate to CHECK UNKNOWN for NULL | NULL kind/id could evade the new kind's receipt binding in pending or completed rows | Only0753's new branch now requires explicit non-null kind and ID before employment equality. Six actual migrated negative variants cover each field/both in pending/completed states and require23514. Existing predicates and SQL bytes remain untouched. |
| P2: selected recordedAt was read back from the saved map and checked only as valid/not later than updatedAt | A BEFORE trigger could rewrite it to an older valid value and still pass | The native owner captures its generated full-map JSONB digest, actor and update time BEFORE INSERT. It compares RETURNING immediately and reread persistence before audit. The separate OT witness retains that expected writer binding; SQL checks the entire actual map/stamp against it. A real BEFORE-trigger fixture demonstrates the older rewrite through a default-owner control transaction, then requires the reviewed owner to refuse and roll back. |
| P2: manual display facts were not independently bound to the authenticated manual map | A forged native event could carry an authentic stored adjustment but false manual display values |0753 verifies before/after manual projections, full map-key coverage and allowed row keys. OT domain rows verify manual/Auto display consistency; the typed review rejects extra after rows. A forged display-only native event and a typed extra-row case are negative fixtures. |

The display repair deliberately preserves a valid native behavior: an unselected stored manual bucket can predate a native day-kind/rate change. Original metadata stays unchanged; only newly selected manual buckets bind the current native row. A real day-kind/Auto-reset fixture guards that distinction.

The writer-map digest covers only manual minute/provenance facts already carried by the existing native audit, not salary or financial evidence. Native financial row hashes remain identity-only; financial contents still pass through the native reader. Stable previews bind the normalized full proposed manual map and retain all unselected provenance. Per-execution selected timestamps and their derived writer proof do not become pretend stable timestamps; actual persistence is independently checked against the real generation for each write.

## Review disposition and planned verification

Known findings have source repairs and authored regressions. The repaired checkpoint is submitted for independent follow-up source disposition before CI candidate freeze. No test/compiler/SQL replay result is asserted by this document. There is no new registry/browser/native-form/route/UI mount, and no deployment or accepted-ledger claim.

Planned focused groups, each with whole-repository typecheck true on standard public ubuntu24.04:

1. Native owners: new OT effects (30 intended cases), native transaction seam, existing day owner regressions and schedule effect/proof regressions. The private validation extraction and new opt-in branch justify checking these defaults and schedule paths.
2. Existing custody compatibility: current schedule-group custody, schedule correction custody and their eleven-role-per-action Attendance partition.0753 extends shared ledger constraints/index predicates while preserving all predecessor branches.
3. New OT contract/migration-source guards, pack drift and native capability inventory. The OT action remains unmounted; these checks must not relabel it as implemented.

Let every planned frozen-candidate job finish before any repair; preserve original failures and actual successful evidence SHAs, rerunning only failed/invalidated areas. No local tests, collection, compiler, builds, DB or dev server are used. The exact candidate/controller/artifacts and actual case counts belong in the phase status after hosted execution.
