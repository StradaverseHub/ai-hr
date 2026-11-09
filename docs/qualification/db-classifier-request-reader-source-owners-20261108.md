# Classifier request Reader design: source owners

Design only. Companion: [proposed decision](db-classifier-request-reader-design-20261108.md).
Base `2e9a1e244558a493959fea95af187c2ddfae6f86`; no implementation or admission.
Fresh origin/main and origin/alpha both29d9edcbc4368be871688e9fdf35347676a7841c.
Root selected the isolated correctness base; no integration merge is made.

| Actual2e9 source | SHA256 | Owner boundary |
| --- | --- | --- |
| `scripts/gate-db-classify.ts` | `3ea38a9643463dc23bf7e5c65dc5386e5e7e33ef2e22f5f7d09f5c3da924dfb2` | Only prospective runtime edit: local full Reader memo inside classifyRequest |
| `test/r417-gate-db-classify.test.ts` | `3e98f97f697900c55784ff2de4c898314e6899fbd1cded922469c4fba0d6282b` | Original28 intentions retained |
| `test/gate-db-classify-cycle-regression.test.ts` | `842dfd47a4305bb170c7cc53d3a104b1b613844ade12ff97a642a1aedc535ac0` | Original4 cycle/order intentions retained |
| `test/gate-db-classify-graph.test.ts` | `b8b076969d51701e9d9b81d67274e36ab0bc2277dea8df886fbb089eaec028ec` | Existing6 graph/API intentions retained |
| `scripts/gate-affected-plan.ts` | `7657391794e4809367e71fd58cda57c4f5f5b858c8d766f12e121516e31c1e56` | Actual batch API filesystem Reader |
| `scripts/gate-impact-run.ts` | `e6fea5e51bde3d383f75ba1bd83c9008a243831ef5c2ec4f506b310f7d0ed715` | Actual batch API filesystem Reader and closed-port route |
| `scripts/gate-phase-reuse-evidence.ts` | `742184465c305538108c35e0688f4f3610d3f125340553353bc60e4e83c212e5` | Separate committed/current immutable text-map requests |
| `scripts/gate-impact.ts` | `334966d457a9a5779e28472c58b0cdfd6165f98ef7036a02d0ccb4b8fff1f983` | Standalone resolveSpecifier API must retain current behavior |
| `.github/ci/plan.mjs` | `c8579a354b03654e453f83990561255f28217110ee1d6a14d3e19510830d2952` | Native/tsx/full stdin/output16MiB/15s SIGTERM unchanged |
| `.github/ci/owned-process.py` | `cb1a2cc2879267f8834dc11ea0e1c52f8326b0bd4e45dcd94ccf2ac43463f28c` | Qualifiedcb1 group/settlement ownership unchanged |
| `scripts/gate-chunked.sh` | `05db1c2cd7ce3e58e557f87df5f7ed429261b1b35d68d1788ce0cc38cea6ca5b` | Actual GATE_NODB_PROOF complete partition on fixed closed DB URLs |
| `vitest.nodb.config.ts` | `594bae2433c451ae3a1f83139fe4cce0fbe8415c751e374dcf4359814a2f429d` | Actual no-global-DB setup course; no selector exemption |
| `docs/qualification/db-classifier-complete-graph-20261108.md` | `39c08a3c86a89625719a482c6776bcf9fe263c802a22a2331fc76c360aff539f` | Immutable correctness contract and per-request snapshot assumption |
| `docs/qualification/db-classifier-complete-graph-source-20261108.json` | `6882b57797f80039b5542ae905d0cb9472b8cef014f2faafd388791ded0af848` | Historical source map must stay immutable |
| `docs/qualification/db-classifier-complete-graph-inverse-20261108.json` | `7c99b900d3ca8528b5adae5e418b5111ac96c76e2f7886b64f43cb5d64c0d244` | Whole correctness predecessor inverse stays immutable |

Current frozen2e9 complete tracked test count: **3629**.
Canonical JSON digest `424bcbdb433cd98d00c681891afd07fb4988bde79a6fc8307b469782266d9b4b`.
Complete LF stdin digest `8d7b248ab8036cb29604ec0c72cc6a4f723b1c78c1a7a4903bb606d9f5a4d52d`.
These are Git inventory/static hash facts, not classification results. Final
coherent source/new tests require reconstructing the full actual inventory.
Some historical classifier/config comments name r417-nodb-closed-port.test.ts,
which is absent on this source. Actual whole-partition closed-port execution
must use the existing real gate course, not an assumed selector or comment.

## Independent original-source profiler (not on this base)

Exact corrected source `69f6fed9008bdf8053b7691a75c8f6032e807f16`.
This separate3630-path owner profiles originalcc; do not relabel its map or
single-root-loop course onto2e9 or a future whole-request successor.

| Actual69f source | SHA256 | Boundary |
| --- | --- | --- |
| `.github/ci/diagnostics/db-classifier-timeout-profile.mjs` | `48e592e6ef38d63b571aebda4dfe05e89d049e64999b70380a19884a505cd229` | Original per-root shared-map profile; B/C needs ONE whole batch request |
| `.github/ci/diagnostics/db-classifier-timeout.py` | `15622c581f71b91c093d3476476e68c7f3716c541874788fd9b14ffadf14306d` | Pinned original kernel/clock/sampler/cleanup; future successor needs review |
| `test/gate-db-classifier-timeout-diagnostic.test.ts` | `7ac84e6cbeaa0cafd54b255ac51ef0deba62d8aa4f72efb1403360e0323a73e3` | Canonical absolute invocation and actual causal assertions |
| `docs/qualification/db-classifier-profile-absolute-invocation-source-20261108.json` | `b346d4ce7c4e6268a013c3b0473f9ce4e1900d1b03d63e517350bf8388bce093` | Original-profile28-member source map; no B/C admission |

Original failing run42463469685 artifact13610462764 ZIP:
`ce0d0c95efbbb8fdd8bfe55acdeb60d49c5334dd70668785ddb7629a7ca9c9b3`.
Inventory complete, baseline15s deadline/owned cleanup, profile exited1 before progress.
Root authenticated corrected69f controls2PASS at42464134878, artifact13610951323 ZIP
`9feaffff689a450445a178da2c9769df6326344801500336207efbee25f98816`.
Corrected native causal run42464762896 dispatched; counters remain PENDING.
Passing source controls do not establish profiling or performance.

## Future finite source slice, only after measurement and root approval

- scripts/gate-db-classify.ts: private per-request full string/null memo, no other runtime edit.
- New actual Reader-count/request-mutation controls; all existing38 bodies retained, actual new count determined after implementation.
- Complete whole2e9 inverse/current map and reviewed source record; no historical record rewrite.
- Separately reviewed fixed full-suite B/C snapshot/graph witness and native15s CLI owner if needed; no arbitrary command/callback broker.

Root owns final source selection, coherent b6/normal compiler convergence, complete
old/new verdict/reason/graph review, all DB→NoDB whole closed-port proof and exact
current source rebinding. No policy/clock/heap/timeout allocation is proposed.
No repository module/test/model/compiler/native/DB/provider behavior ran locally.
Neither document authorizes implementation, upload, adoption or release.
