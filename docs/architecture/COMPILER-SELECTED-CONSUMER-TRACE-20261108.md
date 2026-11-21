# Selected consumer trace: development diagnostic only

## Decision and evidence

Use a closed `compiler-consumer-trace` intent in the existing 25-input diagnostics workflow to measure consumers **7, 8 and 9** of exact source `f2b1ae1a9af20bdb30f28ed9b537aa08994dfc10`. This is not a compiler replacement, complete-suite check, release witness or application change. The parent controller is `4a42389a0e43a6140e242712dc3088981effc435`.

Original run **42414030213**, controller `7106fb2fdc74e0faa2d28ee653fc1da3055cca29`, failed its shared compiler budget. Its actual inventory contains 8,823 ordered roots, 11,268 resolved files, 224 ambient files and seven resolution-only leaves. Producer (254.694 s), owned declarations (17.481 s), both API negative programs (51.765 s / 7.073 s) and consumers 0–7 passed at their original source/run identities. Consumer 7 took 117.064 s and 3,621,252 KiB sampled RSS. Consumer 8 received SIGTERM after 80.343 s with 80.003 s budget remaining and produced no native JSON; consumer 9 was blocked. Aggregate elapsed was 720.340 s. This establishes neither an OOM nor a type error in consumer 8. No per-file trace exists in that run, and no last-file causal attribution is justified.

Consumer 7 has 400 roots / 465 source closure (308 `.ts`, 92 `.tsx`); 8 has 400 / 456 (all `.tsx`); 9 has 291 / 311 (282 `.tsx`, nine `.mts`). File ranges identify measurement partitions, not guilty files. A fresh producer plus owned declarations and the three untraced consumers is estimated near 624 s from the old timings. Tracing overhead may still exhaust 720 s; that remains an honest incomplete outcome.

## Exact scope and limits

The new controller builds a **fresh checked producer and fresh native owned declarations** before the three selected consumers. There is no authenticated cross-run declaration import route, so no cache or earlier artifact is reused. Inventory and plan must exactly match the original f2 byte hashes:

| Artifact | SHA-256 |
| --- | --- |
| `inventory.json` | `803a319b3af6409a251a009fa2cf76f9fb0fa1a5f7fe758025bb4a5c9250a6a8` |
| `plan.json` | `33143b33eec77708f21da2eaa979a5df2aea68b74589e3b1f6274c6773de032e` |

The original native graph, source bytes, resolution edges, SCC membership, ambient/module augmentation order, 400-root packing, 600-source closure bound, declaration emission, owned declaration semantics and receiver/source-fallback refusals remain enforced. The fixed selection cannot accept caller indices, paths, another source, compiler transport or a cache. Consumers 0–6 and both API negative programs are explicitly **omitted diagnostic work**, not new passes. Their successful original receipts remain bound to run 42414030213.

Node 22.23.3, TypeScript 5.9.3, standard Ubuntu 24.04 / four CPU / approximately 16 GiB RAM, 12,288 MiB child heap, 120-second inventory budget, **720-second shared compiler budget including trace creation and type-dump finalization**, 20-minute job, 512 MiB individual artifact, 1 GiB aggregate artifact, log and free-space limits are unchanged. Artifact-only streaming interpretation has a separate bounded 120-second allowance after the compiler stops; it never runs TypeScript/application code and does not add compiler time.

`complete` can describe only this fixed diagnostic schedule. `completeSuite`, `ordinaryCompilerQualified` and `releaseAuthorized` remain **false**, including on complete selected measurements. Ordinary compiler/configuration, release checks, application tests and deployments remain separate.

## Native trace boundary

The installed package was inspected as source at `node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/typescript.js`, with SHA-256 `3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675` (exact actual run API hash). The matching `_tsc.js` hash is `e8f349eabd48486bdb2bf9dc1a00c89d58297270c54b745838879e2859194419`. The worker checks the API hash before using its exported internal tracing entrypoints. No compiler bytes or flags are patched.

For each fixed consumer, tracing starts immediately before the existing semantic checker and stops in its `finally` block. Program construction, native diagnostic call/order and checks are unchanged. Native source `B`/`E` events and sampled relation/type events come from TypeScript itself. Cumulative per-Program type, symbol, instantiation and relation-cache counts are captured after semantics and before trace type-display finalization; they are not invented per-file counters. A thrown check is preserved if finalization also fails. External termination can leave raw trace bytes and no `types.json`; no result is manufactured for that case.

The streaming analyzer records SHA-256 over exact raw bytes, including readable partial tails; non-object/unsafe/oversized inputs refuse. Completed source spans and sampled hot spans are inclusive and may overlap, so their totals must not be added as disjoint wall time. Only bounded native source/target/type IDs are resolved from the native type dump. Original file IDs are joined through the actual inventory and native declaration map. An emitted declaration location maps to its original **file owner only**; its line remains the declaration's native line. Missing dumps, unresolved IDs, mismatched/open frames and unregistered paths stay explicit. A last open file is never a causal conclusion, and sampled relation events are not every instantiation.

The analyzer executes no source, imports no compiler and makes no network calls. Limits include 2 MiB lines, five million records, 20,000 file entries, 1,024 nested source frames, 64 sampled hot spans, 32 instantiation signals, 200 displayed source owners and 16 MiB output, within the original aggregate artifact cap. Its interpretation is not a provenance witness; the actual GitHub repository/workflow/controller/source/run/attempt/artifact digests still require independent verification.

## Qualification required

Freeze and independently review controller code, the fixed dispatch request and source footprint. Then run the four focused controller suites through the existing strict native TAP wrapper and the isolated hosted trace intent. Pure models cover exact source/selection, other-job exclusion, unsafe paths/links/hardlinks, incomplete arrays/raw SHA, native compact type formatting, malformed records, open frames and fixed native tracing wiring. These models are not actual compiler execution.

Inspect actual resource termination, source/controller cleanliness, inventory and plan hashes, native phase JSON, raw trace hashes, missing type dumps and source-bound duration/ID results before proposing a source repair. Preserve original failure and valid original receipts. No source change should be justified merely by a last trace record or a source range.
