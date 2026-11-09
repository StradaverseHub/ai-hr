# Establish an empty native fixture receipt stream before serving

Run42386794616 on555029eaa passed typed credential inspection of the inactive
worker without starting it, unsafe environment/release refusals, zero cold-worker
business traffic, all90 exactly-once POST receipts, concurrent admission, upload
headers and WebSocket echo. It then failed in the lost-response assertion because
worker2 had not received any POST and had never created writes.jsonl. A healthy
admitted worker receiving no POST during that scheduling interval is valid.
The paired deterministic run42386801328 passed. Retain both original outcomes.

The fictional backend now establishes its empty, readable, append-only receipt
file before it serves. Restarts preserve the existing stream. Failure to open it
fails backend startup. Request writes require the existing file; no missing-file
or permission error is silently interpreted as zero effects. The cold-worker
assertion now independently reads an empty stream, and both post-admission checks
must read both real streams. The lost-response proof still requires the actual502
and exactly one persisted receipt across both workers; no count/timeout weakens.

Only fixture/test documentation changes. The production controller, proxy,
credential/profile/drain checks and application source stay byte-identical.
Rerun the sole native fixture with its reviewed controller; deterministic protocol
and compiler/build evidence remain unchanged. This is not actual Next or host
installation qualification. Production held.
