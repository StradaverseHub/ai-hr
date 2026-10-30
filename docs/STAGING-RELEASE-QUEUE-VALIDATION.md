# Staging queue validation — 30 October 2026

Scope: queue/controller commissioning and a small-batch coordination rehearsal. This record is not
an application gate receipt, human staging acceptance or production deployment authorization.

## Hosted controller and release checks

Compiled implementation `1348e326084f967fa45554a535615a49e56728af` retains the coordinator bytes tested at
`4949a340429313838f4d11537accb3565302a06c`. The installed coordinator SHA256 is
`660242698d48f7475efb01b81cedadc11a05c358edf755862ed0a40f2bab4af5`.

[Controller run41000324963](https://github.com/StradaverseHub/ai-hr/actions/runs/41000324963) passed
460 existing controller controls, 11 native queue tests, two JS lease tests, 40 publisher tests,
the isolated two-session/two-member pilot and existing build-byte/extraction/activation controls.
Queue tests use real SQLite transactions, competing processes, stale epochs, immutable tickets,
dependencies, risk/batch limits, baseline movement, private-file refusals, explicit recovery and
kernel locking. An orphan command retains the operation lock after its launcher exits.

[Controller run41000962512](https://github.com/StradaverseHub/ai-hr/actions/runs/41000962512) passed
against the bytecode-suppression repair. Original failures remain at their producing runs:

- [40999775397](https://github.com/StradaverseHub/ai-hr/actions/runs/40999775397): `queue.py` shadowed
  Python's standard queue module. The CLI was renamed; admission assertions were retained.
- [40999778110](https://github.com/StradaverseHub/ai-hr/actions/runs/40999778110): old release fixtures
  lacked lease credentials. Its whole-repository compiler passed. The fixtures now commission the
  actual coordinator in private state and retain original build/death/provenance/board assertions.
- [41000330114](https://github.com/StradaverseHub/ai-hr/actions/runs/41000330114): all 67 selected
  assertions passed, but the final clean-candidate check refused generated Python bytecode. Entry
  points suppress bytecode generation and fixture subprocesses use Python's `-B`. The verifier and
  source-cleanliness requirement were preserved. The compiler also caught an overly narrow inferred path literal in the imported pending-marker helper. Its explicit string parameter types now match its existing absolute-path runtime checks; target-binding and marker validation are unchanged.

The repaired legacy release area passed all45 cases and the final clean-candidate check in
[41000965485](https://github.com/StradaverseHub/ai-hr/actions/runs/41000965485). The corrected helper
boundary, selected gate checks and whole-repository compiler passed at exact1348e3260 in
[41001552999](https://github.com/StradaverseHub/ai-hr/actions/runs/41001552999). Unaffected evidence
retains its original identity. A complete normal release witness is still required before installing
a new application candidate; these component results are not combined into a fabricated full PASS.

## Live shared-queue rehearsal

The coordinator was installed outside application source under existing private staging operator
access. Commissioning independently observed the healthy existing source and build:

- Source: `c4fad43c1d67d69125a3f37e7549a5a8a7053362`.
- Build: `VfUxmTWXfRkorcxhM-0Yn`.

Two independent CLI session identities, labelled Codex and Claude, submitted two documentation
commits already contained in that installed history. The real CLI verified both members/base against
a clean isolated Git view before preparing the batch. These labels prove the shared process protocol;
they are not a claim that two different model engines performed an application acceptance.

Batch `0aead6bd-c7a7-4b9a-88e2-deeb6dba8fa5`, epoch1, demonstrated:

1. Both session processes read the same staging-host queue.
2. Exactly one claimed the batch; the other was refused.
3. Status omitted the private lease token.
4. A real guarded command held the kernel operation lock; concurrent abort/handback refused.
5. After that owned command completed, explicit pre-mutation abort released the lease.
6. Independent readback found no active lease, with the tickets, terminal batch and audit retained.

The batch records `failed` because it was deliberately aborted before mutation; its audit reason
identifies the coordination rehearsal. It was not relabelled as an installed or accepted release.
No application source, build, service or database was changed, and no human acceptance was claimed.
Private original requests, credential and rehearsal observations remain in the controller's ignored
`.improve/queue-pilot/`; credentials are excluded from source, status and public Actions artifacts.

## Rollout boundary

Coordinator commissioning and this rehearsal do not prove a new batched application installation.
Publish the reviewed client/instruction changes through normal history-preserving integration,
complete the exact-candidate release checks, and install guarded server entry points within the
existing release/acceptance authority before claiming all supported sessions enforce the protocol.
An old checkout does not inherit new enforcement automatically. The existing Board candidate's human
acceptance window is preserved unless the owner explicitly authorizes replacement. Production remains
separate. Follow [the protocol](STAGING-RELEASE-QUEUE.md) and query current source/target state.
