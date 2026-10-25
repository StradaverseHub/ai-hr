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

Actual cold/warm results remain pending until authenticated run/job/artifact evidence exists. One VM's ordered result includes normal OS/dependency warming and cannot prove a cross-run speedup or complete release timing. Before enabling a durable compiler cache, validate restored state across actual candidates/toolchain/configuration boundaries, retain complete compiler invocation and error refusal, bound restore/save/storage overhead, and authenticate eligible cache provenance. A cached compiler state is never a PASS receipt. Build, migration, complete test coverage, authenticated deployment and verified source/build arrival remain required for the under-ten-minute goal.
