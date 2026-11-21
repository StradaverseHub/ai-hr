# Immutable key-name capture boundary

Exact successor of 80a564ef2258613bc8b9489dcc6a3ac709442a34, preserving that
unpublished/unrun candidate and all its historical source records. Root and the
independent Compiler review identified one P2: Python's dictionary keys view has
a `.mapping` attribute that exposes the underlying dictionary through a read-only
mapping proxy. Passing `values.keys()` therefore supplied access to environment
VALUES despite the fixed callback only using names. No actual value egress was
observed. This correction closes a capability boundary; it changes no environment
admission rule. [Python 3.12 dictionary-view documentation](https://docs.python.org/3.12/library/stdtypes.html#dictionary-view-objects)
documents the mapping attribute.

The sole runtime change is `tuple(values)` instead of `values.keys()` at the
private capture seam. The original strict parser has already produced a plain
dictionary of string keys. The tuple copies those immutable names from the SAME
parsed dictionary and carries no live dictionary view or mapping access. There is
no new environment/proc read and no values-map argument. Existing native source,
invocation, process-before/after, custody, count and one-second checks remain.

The existing same-read control now requires an exact tuple, string-only entries,
no `.mapping`, no fictional private value and refusal of item assignment. It
retains the seven exact modeled reads, one environ read, two custody checks and
six native hooks, including changed-process denial. A discriminating historical
counterexample binds the actual complete 80a parent source/hash, inspects its AST
for the old `values.keys()` argument, then uses only Python's built-in view on
fictional data to demonstrate `.mapping` value access. It does not execute the
old repository module. A tuple remains unchanged when the fictional dictionary
later gains an entry. All 37 original control intentions remain; there is no new
test case or wrapper-count/child-budget change.

Three source-history controls prepend the new COMPLETE four-file 80a inverse
before the immutable nine-file 4d inverse and earlier terminal/phase/environment/
CPU/cleanup chains. The new inverse binds complete actual Git preimages, hashes
and descending edits for the runtime owner and all three changed model files.
The old nine-file inverse, every older inverse/map and the approved design files
remain whole unchanged. The current source map retains all 85 inherited bindings,
overrides the four current files and adds the immutable parent map, new inverse
and this record: 88 current bindings. Historical records remain historical.

Prepared controls stay environment37 / host21 / failure22 / profile16 plus the
existing one native host component. All other 80a runtime/helper/receiver/native
component/TS/wrapper owners are byte-exact. In particular, the original v1
environment packet/validator/receiver, v1 phase codec, terminal latch and entire
NextRuntime class including guard620 are unchanged. The full-helper14-row versus
component-six-hook distinction and all false release/readiness flags remain.
Maximum four hashes, terminal1024 bytes, 15 messages / 18432 bytes, journal64 /
131072 bytes, observer1s and model-child10s remain unchanged. No pool, process,
command, signal, resource, provider, permission, policy or migration change.

Local verification is source-only: Git, byte/hash/inverse checks and Python AST
syntax parsing. No repository imports, models, tests, native operations or build
ran locally. Root and independent FULL review precede any upload/hosted check.
The original full4d run42469026005 remains FAILED; the unknown actual key/name/
origin remains UNKNOWN. Source correctness does not confer native qualification,
Next readiness, staging or production authority. After affected hosted controls
and the existing native component qualify, the mandatory new same-run build/full
Next attempt remains required. No allowlist remedy or guard620 relaxation is
authorized by this correction.
