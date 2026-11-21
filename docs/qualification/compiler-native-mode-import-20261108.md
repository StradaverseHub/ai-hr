# Tiny native fixture builtin import correction

Source-only child ofe54ce369f28d2b336a5413c11498fbe340613876.
Run42463255503 completed all terminal jobs with three wrapper cases:2PASS/1FAIL,
zero pending. The19 source controls and9 Python controls passed at that exact
source. The tiny native wrapper failed during module linking BEFORE either of
its two cases could execute: realpathSync was imported from node:path.
Artifact13610398997 ZIP SHA256:
18f659d8600b1d0f254ac18dfa9533eb89c3ab84943c8b0a7f9b59fb5cf3f54e.
No genuine default-Program fixture PASS or full inventory is established there.

The correction moves ONLY realpathSync from the node:path import to node:fs.
The fixture's entire post-import body, helpers, two case intentions, membership,
native modes, expected unsafe API refusal, parent-immutability assertions and
limits remain WHOLE-BYTE unchanged. Post-import body SHA256 remains
64f7fd715e8d9d3dc61a3447c48f4685521c70aa5a904138e260d83f2c722111.
Original complete fixture SHA256:
8ff5aa87208c02163f38e33387e22d1b382c8dfecb8946a21d573a55d4a25155.
The exact inverse is the reverse movement of that import name; static application
of it reproduces the entire original e54 fixture byte-for-byte. Both complete
preimages, including the original active map, remain in the immutable Git parent.
Previous source inverses retain their original scope and are not new receipts.

An AST inventory of ALL six JavaScript/TypeScript files introduced or changed by
the e54 repair audited these eight builtin module surfaces against official
Node22.23.3 primary documentation:

| Module | Actual imported surface | Primary reference |
| --- | --- | --- |
| node:fs | mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync | [Node22.23.3 file system](https://nodejs.org/download/release/v22.23.3/docs/api/fs.html#fsrealpathsyncpath-options) |
| node:path | basename, dirname, join, resolve | [Node22.23.3 path](https://nodejs.org/download/release/v22.23.3/docs/api/path.html) |
| node:os | tmpdir | [Node22.23.3 OS](https://nodejs.org/download/release/v22.23.3/docs/api/os.html#ostmpdir) |
| node:crypto | createHash | [Node22.23.3 crypto](https://nodejs.org/download/release/v22.23.3/docs/api/crypto.html#cryptocreatehashalgorithm-options) |
| node:url | fileURLToPath | [Node22.23.3 URL](https://nodejs.org/download/release/v22.23.3/docs/api/url.html#urlfileurltopathurl-options) |
| node:child_process | spawnSync | [Node22.23.3 child process](https://nodejs.org/download/release/v22.23.3/docs/api/child_process.html#child_processspawnsynccommand-args-options) |
| node:test | default test function | [Node22.23.3 test runner](https://nodejs.org/download/release/v22.23.3/docs/api/test.html) |
| node:assert/strict | default strict assertion interface | [Node22.23.3 assert](https://nodejs.org/download/release/v22.23.3/docs/api/assert.html#strict-assertion-mode) |

The exact pinned runtime must still validate these bindings on HOSTED controls.
No local module-export probe, fixture/model, Program, compiler, application, DB
or provider behavior was run. The unchanged19 source cases already exercised
their own real builtin imports at e54. The unchanged tiny wrapper now must link
the corrected fixture on actual Node22.23.3 and execute BOTH original native
cases with strict2PASS/zero skip/todo/cancel. Its fixture and existing transitive
owners use real builtin modules; no mock, import fallback, source rewrite,
exception masking or count/timeout waiver is added.

The active98-member source declaration retains its EXACT key set. Only the tiny
fixture's component hash changes; sourceRef and explicit predecessor/failure
metadata describe this successor. The prior active-map SHA256 is
935d60dda14b2fc3f7f3c351d13acc5138d779a70a10958d7b7cd4300ab090f0.
This review note is not executable admission source and is not inserted into that
fixed98-member execution map. All actual members still match both checkouts at
runtime. No original map, inverse, source-control result or failure is rewritten
into a success at this new source.

The worker/helper parent-context repair, source19/Python9 intentions, genuine
fixture assertions, original native application selector, strict settlement,
kernel and all resource/clock bounds remain unchanged. No business/model/schema,
AI manifest, approval or provider authority changes. Root plus independent source
review precede upload and the blocked hosted two-case native fixture rerun.
Retain the unaffected e54 source19/Python9 evidence at its actual identity.
Full application metadata rerun remains blocked until the genuine TWO fixture
cases actually pass. Normal adoption and final release gates remain open;
staging and production stay on hold.
