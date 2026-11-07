# Unified employee-reader verification recovery

Frozen application source: `5510178d8a74dcef5fe117267a81e09db1eb798b`.
This child changes tests/evidence/docs only; no production query, migration,
policy/grant, data semantics, timeout, JIT/work_mem or fixture volume changes.

Review found two verification gaps: the seven selected files omitted existing
regressions, and fixed base/CTE loop assertions measured join shape rather than
bounded work. The focused manifest now includes the full14-selector prior/current
union, plus a new synthetic envelope regression file (15 total). Existing direct
reader abort/count logic still recognizes the tagged first count row; no stale
mock was deleted, broadened or needed source-only adaptation. The only frozen
baseline change is the independently discovered incorrect `./ai-principal` import;
it now resolves to `../../core/ai-principal`. Logic/provenance remain c2-exact.
Repaired byte SHA256 `9e830d169630dca113b96e34f9c05ebd3da13ef3ed2d391c91304e4397e4bffd`
and reconstructed original-source SHA256
`c524f7e7d30ed742e81870da3b6e439faab32061363b3750893a5b5c2076ccbd` are pinned.
Static import-target resolution found78 actual relative imports across13 source/
fixture files, none missing; it does not establish exports/compilation/runtime.

Full sparse EXPLAIN is now saved to `employee-choice-sparse-plan.json` before any
plan counter/output assertion. Its whole-fixture counts, separately real authorized
server-population facts, independent expected members and observed DTO are retained.
The sole50k `employee-choice-unified-plan.json` likewise writes raw plans before
assertions, captures true native whole-fixture counts and each port's authorized
server population outside timed calls. A rejected/malformed plan remains inspectable.

The work helper applies the documented provisional min(1600000,32N) per-node and
min(150000,max(4096,3N)) root shared-hit-plus-read envelopes, using exact base-row
counts across all owned fixture tenants for N. It records all four removed-row
counters and every actual loop. Fixed<=1 base and<=8 CTE loop constraints are
removed; synthetic tests distinguish efficient tiny probes from quadratic/buffer
pathologies. The ADR records rationale, rounding/measurement limits and mandatory
review before further threshold changes. Neither these model tests nor a work
envelope success establish actual speed or correctness without native evidence.

All original native authority, IDs/counts/facets, Unicode semantics, selected
independence, held barriers/security/samePID/noDDL/budgets and all14 whole-port
sub1s targets remain. Original42392436988 failure is retained;7b6 stays unaccepted.
No local app/DB/runtime/compiler/build checks ran. Hosted verification is pending;
no speed or release claim, upload or deployment is made. Production remains held.
