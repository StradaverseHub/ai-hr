# Movement Import catalogue presentation

Status: source proposal; native, build and release qualification pending.

The active Movement Import template POST was taking the exclusive Access command
lock and, for each catalogue, the Workforce write barrier. It returns reference
values only. Preview and commit own subsequent canonical authorization, catalogue
fingerprints, protected dependencies, monetary state and audit effects.

## Decision

Read catalogue, template and active type presentation in one enforced REPEATABLE
READ / READ ONLY transaction. Capture identity, roles and grants before the first
await and verify that exact current native login/principal in the transaction.
The company catalogue retains both Workforce view and maintain capabilities plus
the existing native administrative company predicate. Types retain their existing
administrative audience, now checked against the actual current login.

A private shared catalogue-facts function keeps the existing queries, order,
fields, reference ceilings and type/control/reason projection. The command wrapper
still takes exactly its original view/maintain barriers before using those facts.
No command accepts a presentation result as authority. No migration, table, RLS,
permission grant, calculation, command fingerprint or audit contract changes.
The legacy subject-filled download owner remains a command-barrier owner pending
separate dependency analysis; it is not the current template POST.

An already admitted coherent snapshot may finish after a concurrent permission
change; a change committed before admission governs the next read. This is the
same presentation contract as other module reads. False native authority refuses;
storage failures propagate, with no command bootstrap or empty-result fallback.

## Verification

The new app-role tests require nonempty native employee/department/type catalogue
facts, compare complete results while independent Access, History, Workforce
policy-generation and Movement Type writers remain held, and check actual
repeatable-read/read-only mode, absence of advisory locks and unchanged audit
facts. They also test each current Workforce denial independently, supplied-context
mutation, foreign-company refusal, actual role drift and archived login refusal.
Existing import canonical parity, reference/type/permission, race, history,
classification, route and rendered component suites remain part of the focused
manifest. Do not claim throughput or whole-page improvement from source review:
Linux build, common complete compiler, real template browser outcome and final
loaded native ingress checks establish separate claims.
