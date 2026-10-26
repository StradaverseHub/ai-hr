# Whole-project incremental compiler diagnostic

The first standard-runner attendance pilot, [40222366600](https://github.com/StradaverseHub/ai-hr/actions/runs/40222366600), spent 315.28 seconds in whole-repository TypeScript and reached 6,959,464 KiB maximum RSS. It passed. This makes compiler state a measured candidate for improvement; it does not establish that caching will solve the complete release-time target.

TypeScript's [incremental option](https://www.typescriptlang.org/tsconfig/incremental.html) stores the project graph, and [tsBuildInfoFile](https://www.typescriptlang.org/tsconfig/tsBuildInfoFile.html) selects the state file. Our tsconfig already enables incremental compilation. A fresh runner has no retained state. Existing default compiler and release jobs remain unchanged; this diagnostic does not enable an Actions cache or reuse any compiler PASS.

## Bounded experiment

The existing `alpha-staging-diagnostics` workflow has a default-off `compiler_probe`. Enable only that probe: set `nodb_probe`, `layout_probe`, `statutory_probe`, `plan_probe` and `instrument_copies` false. It resolves the exact company candidate, installs the same complete web/tooling/native dependencies on a standard Ubuntu 24 runner, generates real Next route types and invokes the whole compiler under the existing 8 GiB heap/owned-swap wrapper. Job timeout is twenty minutes. Every command has a ten-minute bound and bounded termination of only its newly owned process group. Queue, setup, wrapper cleanup and artifact upload are part of actual run timing and cost.

The diagnostic uses the actual installed TypeScript CLI, the same strict `tsconfig.json`, `--noEmit`, plain extended diagnostics and a fresh private explicit tsBuildInfoFile. It does not exclude application, test or tooling files. It runs these ordered phases on one VM:

1. Cold compiler state, exact clean candidate; require actual exit zero and positive file count.
2. Warm state, unchanged source; require actual exit zero and the same file count.
3. Add two owned valid TypeScript roots, including an importing consumer; require zero exit and exactly two additional files.
4. Change only the dependency's exported type, keeping the consumer bytes unchanged; require a real compiler diagnostic exit and exactly one TS2322 in that consumer.
5. Restore the dependency and add an invalid new root; require a real diagnostic exit and exactly one TS2322 in that new root. The previous consumer error must be gone.
6. Remove all owned fixture roots and compile again; require zero exit, original file count and exact clean candidate restoration.

Unexpected errors, global diagnostics, missing counts, signal exits, timeouts or memory failures cannot count as successful negative controls. All actual exits, elapsed times, complete file counts, per-phase state size/digest and raw `/usr/bin/time -v` logs are retained. The state file itself is deleted, and cleanup/clean-source status are explicit. An interrupted or missing report is incomplete. Hosted runner teardown is a separate fallback for an abruptly cancelled parent; it is not a successful diagnostic report.

The result is labelled `WHOLE_PROJECT_INCREMENTAL_DIAGNOSTIC_NOT_RELEASE_EVIDENCE` with `releaseAuthorized: false`. The error controls intentionally introduce temporary source; their successful refusal is not a clean-candidate gate receipt. No app tests, build, database, deployment, branch advancement, live restart or peer signal is performed. AI dev 2's release stays local and keeps the Mac resource window.

## Validation and next boundary

Four tiny controller groups passed locally: actual-zero/file-inventory refusal, exact owned diagnostic/error-exit refusal, tiny owned Node success/nonzero/timeout handling, and non-runner refusal before source access. They do not execute TypeScript. Shell/YAML and isolated workflow-structure checks cover the opt-in wiring separately.

[Run 40225338537](https://github.com/StradaverseHub/ai-hr/actions/runs/40225338537) completed successfully on exact `fe9e3c1ae94c174bdc495ef5aff6017dd402724e`. Root authenticated run, candidate, workflow, attempt, complete job inventory and artifact digest, then independently validated every raw phase and configuration/lockfile hashes against the committed source. The full original project contains 7,046 compiler files and 986,602 TypeScript lines.

| Phase | Elapsed | Files | Actual exit |
| --- | --- | --- | --- |
| Cold state | 364.240s | 7,046 | 0 |
| Warm unchanged source | 26.643s | 7,046 | 0 |
| Add valid dependency and consumer | 15.845s | 7,048 | 0 |
| Change dependency; unchanged consumer refuses | 15.824s | 7,048 | 2, exact consumer TS2322 |
| Restore dependency; new invalid root refuses | 15.990s | 7,049 | 2, exact new-root TS2322 |
| Remove fixtures; restored original source | 15.958s | 7,046 | 0 |

Warm compiler elapsed was 92.69% lower in this ordered experiment; maximum RSS fell from 6,849,064 to 2,615,700 KiB (61.81% lower). Major page faults fell from 124,835 to 860. Both introduced-error controls actually failed for the intended reason. Reported source/fixture/state cleanup passed; cache bytes were deleted, so the retained digest is metadata rather than a state file we can rehash later.

Complete dispatch-to-last-job elapsed was 610s (10m10s) and summed occupied runner time was 604s (10.07 runner-minutes). The diagnostic intentionally ran six compiler phases; these numbers are not deployment timing or authoritative billing. Authenticated raw logs, independent review and cost report are retained under `scratchpad/compiler-incremental-20261026/` in the performance worktree. No durable cache was enabled and no application/build/deployment evidence was produced.

 One VM's ordered result includes normal OS/dependency warming and cannot prove a cross-run speedup or complete release timing. Before enabling a durable compiler cache, validate restored state across actual candidates/toolchain/configuration boundaries, retain complete compiler invocation and error refusal, bound restore/save/storage overhead, and authenticate eligible cache provenance. A cached compiler state is never a PASS receipt. Build, migration, complete test coverage, authenticated deployment and verified source/build arrival remain required for the under-ten-minute goal.

## Cross-VM state transport diagnostic

The default-off `compiler_transport_probe` is now wired into `alpha-staging-diagnostics.yml`. It first runs twelve lightweight controller/private-filesystem/fake-cleanup checks, then uses two separate standard Ubuntu24 VMs at the same normal checkout path. This is still a diagnostic, not a persistent cache or release receipt.

The producer installs complete web/tooling/mobile dependencies, generates actual Next route types and runs the full strict compiler once. A bounded five-member JSON artifact contains raw TypeScript build-info bytes, authenticated identity/completion metadata, the original actual command/log and explicit owned-swap cleanup. The identity binds the frozen source/controller/run, first attempt, Node22.23.3/TypeScript/Next/Linux/x64, all configuration/lockfiles, actual compiler implementation bytes, invocation flags, generated types and mobile dependency inputs. The artifact upload is eligible only after the producer job succeeds. Its compressed size is limited to96MiB, individual state to64MiB, and age to24hours.

The consumer authenticates the real GitHub run/job/artifact metadata, original ZIP digest and raw compiler evidence, and requires a different runner name/boot identity at the same absolute source path. It restores the state into a new private `.next/cache/compiler-transport` directory, then actually runs the full compiler. It checks original file-count equality, adds two valid dependency/consumer roots, changes only the dependency and requires the unchanged consumer's exactTS2322, restores that dependency and requires a new invalid root's exactTS2322, then removes its fixtures and runs the restored complete project again. No timeout, signal, unrelated diagnostic or missing count is accepted. Source/controller cleanliness, owned cache removal and swap removal are recorded separately.

If only the reader/consumer fails, explicit `compiler_origin_*` inputs can reuse the authenticated successful original producer. Original source/controller/run remain distinct from the new executing controller. The source is never relabelled, the cold compiler is not repeated automatically, and unrelated probes remain disabled. Both commands keep the normal bounded4GiB swap/8GiB heap and20GiB storage guard; the prototype cleanup fails closed rather than unlink an active/unobserved swap file. Five local fake-command checks exercise the actual cleanup function without any real swap, compiler or privileged operation.

This proves portability only at a matching normal compiler path and exact candidate/toolchain/configuration. It does not establish arbitrary path relocation, compatible changed-candidate reuse, persistent Actions-cache eligibility or complete release timing. The original same-VM state was deleted. The real cross-VM run below is now independently verified. Queue, checkout, SDK cleanup, dependency installation, type generation, restore, compiler commands, negative controls, cleanup and uploads all remain visible in run timing. All application tests/build/migrations/deployment and verified staging arrival are separate required claims.

## Verified two-VM result — 26 October 2026 MYT

[Run40243921832](https://github.com/StradaverseHub/ai-hr/actions/runs/40243921832) succeeded on exact source/controller `067301b3596a2f6c2f483265edf6a6015e34698c`, Node22.23.3/TypeScript5.9.3/Next16.3.8/Linuxx64. Root independently authenticated the complete run/job/artifact identities and archive bytes, recomputed configuration/invocation/mobile hashes against Git, inspected the original raw compiler logs/build-info graph, and checked different VM boot/name at the same absolute checkout path. The graph has7,059 files, including actual test/application/core/pack/mobile roots; no compiler scope was narrowed.

| Actual phase | Elapsed | Files | Actual process exit | Maximum RSS KiB |
| --- | --- | --- | --- | --- |
| Cold producer | 398.075s | 7,059 | 0 | 6,953,208 |
| Restored state, fresh VM | 18.769s | 7,059 | 0 | 2,630,860 |
| Add valid dependency/consumer | 22.269s | 7,061 | 0 | 2,637,688 |
| Change dependency; unchanged consumer refuses | 18.802s | 7,061 | 2, exact consumer TS2322 | 2,637,428 |
| New invalid root refuses | 18.882s | 7,062 | 2, exact new-root TS2322 | 2,638,536 |
| Remove fixtures, restored full source | 18.415s | 7,059 | 0 | 2,634,028 |

Original state is1,405,616 bytes (1.34MiB), SHA256 `9605f3aa257bd45aa1eb26d57074c53794661d346ed0c797bf0b12ed21b5c98e`. Authenticated API/download/extraction/state verification took2.963s. The restored full compiler was95.29% faster than this run's cold producer; including that restoration took21.732s. This is an actual separate-VM same-candidate measurement, not the earlier same-VM OS-warming result or a generic changed-candidate speed guarantee.

Producer artifact12617977681: ZIP SHA256 `e631a892d9e1826c691475ba9a5f761e3e9e865fbdf57ffc253352ed7e65c8d8`,395,595 bytes. Consumer evidence artifact12618084338: ZIP SHA256 `ad2fffc92d17fbdb4f6566a86a9b2a0d3b469867be77475eabc38e355e74ef19`,1,197,314 bytes. Both exact source/controller Git states were clean; owned fixture/cache and the separately checked bounded swap file were removed. The original successful cold compiler ran once; there was no retry or failed consumer in this experiment.

The entire intentionally sequential experiment took873.329s from the recorded pre-dispatch submission to last-job completion (GitHub-created-to-last-job872s), including setup and all five consumer compiler invocations. Summed occupied runner time was864s/14.40minutes, not authoritative billing; independent post-run review is separate. Producer job606s included183s toolchain setup, of which SDK cleanup152.794s and mobile installation14s. Consumer job245s included127s setup, SDK cleanup92.116s and mobile installation20s. Package installation was not the dominant setup cost in this run.

Raw archives, logs, authenticated metadata, original producer graph, independent review and submission endpoints are retained in the isolated performance worktree under `scratchpad/compiler-transport-20261026/run-40243921832/`. This does not enable persistent compiler caching, issue a new full-PASS baseline, run application tests/build/migrations or deploy staging. Compatible changed-candidate cache policy, actual Next application-compiler cache, validated capacity-aware setup and normal authenticated artifact promotion remain required before a complete representative release can establish the under600s goal. Main/live deployment stays disabled.

## Compatible-candidate and capacity trial

A new default-off `compiler_compatible_probe` consumer reuses the successful original run40243921832 artifact; it never launches another cold producer. The current candidate/controller remains distinct from that immutable original source/controller/run. The typed `scripts/ci-compiler-cache-policy.ts` guard requires GitHub-authenticated bounded ancestor comparison, complete changed-file membership, identical compiler binaries/runtime/flags/configuration/lockfiles/generated types/mobile inputs and exact invocation digests. Resource-only shell bytes may differ, while actual compiler options and binary/input digests must remain identical. Ineligible state cannot become a cached PASS.

This bounded trial adds exactly that new typed policy root to the real candidate. Before the first restored compiler invocation it appends one owned string-versus-number error to that new root, requires the exact actualTS2322 and diagnostic exit with the added file counted, then restores the precise original Git bytes. The full compiler must subsequently pass the changed candidate with one additional file, followed by the existing actual transitive/new-root refusal and final full-source restoration checks. Original compiler evidence is never relabelled as execution on the child. A successful trial still cannot issue test/release evidence or prove arbitrary changed-candidate speed.

Its explicit `bounded-compiler-diagnostic` capacity scope accepts only the actual company/manual review workflow, compatible consumer purpose and all four closed database URLs. It skips fixed SDK deletion when at least12GiB is free before dependencies; before creating the same bounded4GiB owned swap it requires8GiB free, leaving4GiB for finite compiler-state/log/evidence writes. Every compiler phase records actual filesystem samples and refuses less than2GiB remaining after swap reservation. Ordinary compiler/build/release profiles retain legacy cleanup and the20GiB compiler guard. All source/cache/fixture/owned-swap cleanup remains mandatory. Pure numeric/scope and actual fake-command preparation/cleanup checks cover the guards without a real Mac compiler, swap or database.

The actual changed-candidate runtime and reduced-capacity results are independently verified below. No persistent cache or normal release workflow is enabled by this source. Any failing unexecuted phase must be investigated; the successful original cold compiler remains reusable rather than rerun automatically.

## Verified changed-candidate and bounded-capacity result — 26 October 2026 MYT

[Run40245915232](https://github.com/StradaverseHub/ai-hr/actions/runs/40245915232) succeeded on exact new candidate/controller `bf3868aa857e20deb3ea0a1afe8571caa7aff74b`. It reused the same original source/controller067301b3596a2f6c2f483265edf6a6015e34698c/run40243921832/artifact12617977681. No cold producer was rerun. Root independently authenticated both origins, original and consumer archive bytes, the actual ancestor comparison and complete changed-file membership, all semantic compiler inputs, every raw compiler count/exit/diagnostic and owned cleanup.

| Actual phase | Elapsed | Complete files | Actual exit |
| --- | --- | --- | --- |
| First restored compiler; new candidate root deliberately invalid | 22.004s | 7,060 | 2, exact policy-root TS2322 |
| Restore that root; complete clean changed candidate | 21.473s | 7,060 | 0 |
| Add valid dependency and consumer | 20.318s | 7,062 | 0 |
| Change dependency; unchanged consumer refuses | 20.017s | 7,062 | 2, exact consumer TS2322 |
| Restore dependency; new invalid root refuses | 18.656s | 7,063 | 2, exact new-root TS2322 |
| Remove fixtures; full changed source restored | 20.062s | 7,060 | 0 |

The first restored command genuinely discovered the newly added typed root and refused its introduced error. The21.473s clean pass follows that explicit first-refusal control; do not describe it as the first unchanged-source invocation on a fresh VM. The original7,059-file source and the changed7,060-file candidate remain separately identified. Authenticated restoration/applicability verification took4.376s. Both source and controller remained at the new exact commit after all owned source changes were restored.

Actual SDK preparation took2.229s and performed no SDK deletion. Source-volume free space was12,860,996KiB before that step and12,860,984KiB afterward. The same actual4GiB owned swap was reserved under the8GiB pre-swap guard, then stopped/removed; the original system swap remained outside our ownership. Twelve per-phase before/after samples retained at least7,221,878,784 bytes (6.73GiB) free after swap reservation. This is sampled headroom, not an exact continuous disk peak. Source/cache/fixtures/tracked-control/swap cleanup all passed. Ordinary compiler/build/test profiles still retain their existing guards; do not extend this compiler-only result to builds or databases.

Recorded pre-dispatch submission through last-job completion was208.952925s (3m29s), including queue/setup/authentication, six actual compiler commands, cleanup and upload. GitHub-created-to-last-job208s, occupied runner time202s/3.367minutes, not authoritative billing. Consumer artifact12618253888 is1,220,068 bytes, ZIP SHA256 `57cd659428ed6279fd8f203eeb94e784555f8bd871f543a0ece9fab16813077a`. Independent raw evidence and source snapshots are in `scratchpad/compiler-compatible-20261026/run-40245915232/`. All21 pure controller/resource boundary groups also passed on the actual Linux resolve job.

This verifies one real descendant with an additional typed root and its error/repair controls, under the explicit unchanged compiler/configuration/dependency/type-generation boundaries. It does not establish performance for arbitrary candidate changes or enable a persistent Actions cache. Normal compiler-cache integration, cold fallback/invalidation, actual Next build cache/promotion and complete required release coverage/arrival remain unfinished.
