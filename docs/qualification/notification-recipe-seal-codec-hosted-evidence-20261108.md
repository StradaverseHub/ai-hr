# Hosted notification recipe byte-codec proof

Frozen source `7041e59d487b211875d82c4c455bc805720dd4df` passed the two
reviewed selectors in hosted run `42433732041`, attempt1, controller
`b7c0393aa3c7606a33dd15103426e5c535324065`. Independent API/download verification
matched artifact13598264710, ZIP SHA-256
`ea91d2511eabf53ea015ee138d996b646e04cfcf8349dc8f97df3dcc75e4a2da`.
Actual Vitest results contain all5 pure and3 native assertions, zero failed,
pending or todo assertions. Exact candidate identity and selected-file coverage
were checked in focused.json and both actual result files.

The hosted native vectors used actual PostgreSQL app LOGIN, repeatable-read /
read-only transactions and the fixed bounded built-in-only SELECT. Every
positive compared the complete encoded bytes and digest against Node, including
the full ordered66 canonical rows. Observed vectors:

| API | Recipes | Bytes | SHA-256 |
| --- | --- | --- | --- |
|2 literal|1|72|b26d5009d5527dfd780532f47f1809935e6f8660167ea3755882f7467204ed4a|
|2 complete|66|6213|2d70b80e3603a95ee4e81fe01f6f168f5556516be9a0a38568cd67d95ef5d891|
|3 complete|66|6213|b9518d01166a37215bb1fe41e109e67b8f516b83b8b2eded11ef7c86e38248dd|

All three native cases completed in approximately49ms,31ms and325ms. Those are
codec fixture durations, not application page latency. Unicode/C ordering,
metadata/guard distinctions, malformed and oversized direct native inputs and
unknown API versions also passed. Existing case, startup, SQL, lock, connection
and encoded-size bounds were retained.

This establishes the codec at the named source. It does not install a protected
native recipe seal, resolve opaque catalogue metadata, grant a worker profile,
close the direct-LOGIN authority gap, adopt the family into application traffic
or qualify the combined architecture. Those remain separate work. No staging
or production deployment occurred; production remains held.
