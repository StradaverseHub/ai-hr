# Shared native process kernel: mechanical extraction only

Exact parent: `c73c8e15400890e5dfcb0d32d178929a5522ab5c`.
No normal-CI adapter, registry, workflow, profile, policy allocation, application,
database or deployment behavior is introduced in this checkpoint.

The source-private `.github/ci/owned-process.py` owns the single unchanged
WNOWAIT/pidfd/subreaper/session implementation and `append_event`. It has no CLI,
request parser, mode selector, command registry, source admission or release
acceptance. `supervise(argv, seconds, event, ...)` remains a private library API:
only reviewed closed actual-context adapters may select production commands.
This is process lifetime ownership, not an arbitrary-code sandbox or authority
boundary for untrusted Python callers.

The original focused CLI loads its fixed source sibling through an explicit
`spec_from_file_location` path. It does not import through PYTHONPATH or accept
a module path from environment/request data. Its complete request, fixed command
map, three selection identities, stage budgets, first-step anchor, 1170s job
admission, file clock/ACK, evidence and mandatory-stop semantics remain exact.

The archived extraction record binds the full original c73 supervisor SHA-256
`bb81ee3b98e0f45c2c4d560f336d52387aa02a47bc0129af97d3b8b55167f1d4`.
Replacing the one exact loader block with the shared `REASONS`/helper span
reconstructs every original byte, including all original imports, constants,
functions, CLI guards and ordering. The extracted span is also independently
hashed. This inverse protects a mechanical refactor; it is not native evidence.

All original 12 Linux/budget/closed-entry controls remain. The real child edge
fault now patches `module._owned_process.os.execvpe`, the actual globals used by
the extracted function, while the CLI event failure still patches the actual
CLI event callback. Two additional controls prove the full original inverse,
fixed sibling/function-global identity, closed definition/import surface and
pre-fork refusal through the actual shared globals. The wrapper requires all14
tests, original20s child timeout/30s wrapper/1MiB output cap and zero skips.

No producer or consumer is qualified merely because it imports the library.
After independent source review, the existing hosted Linux wrapper must pass
before a future catalogue/compiler/normal lifecycle adapter adopts it. Every
future adapter still needs its own genuine authenticated context, command/source
binding, budget and cleanup evidence. No normal mode manufactures focused or
GitHub flags. Root owns any later operational integration and policy reservation.

Only static Git/source/hash/AST inspection has occurred locally. No test,
process-control fixture, application, compiler, database or build has run here.
Production remains held; staging remains behind all six architecture gates.
