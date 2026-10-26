# Canonical CI build packet — current version8 source contract

Status: prepared in the isolated performance review branch. Pure/private integrity and typed-helper probes have run; this revised normal workflow has not run a complete release gate, promoted an artifact, or established a new release baseline. Main/live deployment stays disabled.

## Normal build job

The normal alpha/staging build job now invokes the existing canonical System Testing producer through the candidate's installed tsx launcher, pinned to Node20.20.2 on Ubuntu24/Linux x64. It prepares a new immutable record and UUID, runs actual canonical production compilation and its application TypeScript check, requires a fresh BUILD_ID and successful build observation, then packs actual build bytes. Four database URLs remain explicitly closed. Source checkout is shallow because preparation reads only the frozen HEAD blobs.

The mandatory production-build-v1 artifact contains exactly:

- build-provenance.json
- system-testing.json
- successful-build.json
- bytes/build-bundle-files.json
- bytes/build-bundle.tar.gz

The packet is uploaded without ZIP recompression because the bundle is already gzip-compressed. It expires after one day, matching the verifier's maximum witness age. Upload and build failures remain blocking. Existing optional Turbopack cache behavior is retained; normal application TypeScript graph reuse and bounded build capacity are now wired in source; see [normal application cache](NORMAL-NEXT-APPLICATION-CACHE.md). Actual normal execution remains unverified.

A build-only invocation can compile review dispatches and same-repository PR checks admitted by the normal resolution guard. Its output always declares releaseAuthorized:false. The release verifier still requires a complete successful first-attempt normal run controlled by main or alpha; diagnostic, review-controller and PR builds cannot authorize deployment.

## Authenticated operator boundary

Policy aihr-staging-ci/v8 retains the complete independently reconstructed job/test/browser inventory and adds the mandatory build artifact. Only this exact artifact namespace may exceed the existing64MiB JSON artifact ceiling, with a280MiB compressed ZIP limit and256MiB inner archive limit. The optional whole-compiler-state and next-application-state-v1 packets cannot replace either the build or any required test report. Version5 adds the second fixed optional namespace; it does not weaken required coverage.

The operator authenticates the repository/run/controller/job/artifact through GitHub APIs, checks downloaded ZIP length and digest, and uses the existing exact-inventory bounded binary extractor. It then verifies source/controller/runtime/build UUID/BUILD_ID, original successful observation times inside the producing job, every bound record/manifest digest, and the actual archive length/digest. It independently regenerates the canonical System Testing preparation from the unchanged candidate and checks exact preparation bytes plus package/lock hashes. Immediately before any existing operator transfer, fresh API revalidation also reopens local packet bytes and rechecks canonical source.

The source/record binding is asynchronous because it imports the actual candidate's typed helpers. Both operator verification calls await it. Use the installed candidate toolchain, for example node --import tsx .../.github/ci/operator-release.mjs verify CANDIDATE RUN_ID; plain Node20 cannot import these typed helpers.

A resumable source assessment checks any present binary packet's provenance, bytes and producing job, but still requires a fresh build and supplies no additional reusable test unit. A failed or incomplete normal run remains failed/incomplete. Older policy witnesses cannot be relabelled as the current version.

## What remains before build-once deployment

The isolated operator now has a version6-derived build-once installation route, retained by version7. It preserves the original authenticated CI build UUID/observation, uses a fresh private installation grant, validates source/runtime/environment/package/compiled/native inputs, and integrates the existing migration/catalog spine, atomic owned activation, fresh PID/health, full source checksum and ordered migration ledger, with owned cleanup. This source and its private controls have not been executed as a real staging installation. Actual runtime/native/ISR behavior, complete normal CI witness, owner-exclusive window and verified handback remain required. See the current [installation contract](STAGING-ARTIFACT-ACTIVATION.md); do not treat old remote-rebuild notes as the present implementation.

Preserve audit/auth preflights, migrations, catalog and backfill work, knowledge seeding, restart, health, source checksum and migration-ledger arrival checks. The [CI staging transport](STAGING-ARTIFACT-ACTIVATION.md) now requires an actually written pending marker; the legacy generic helper keeps its bootstrap fallback. Exclusive target ownership and full operator validation remain required. Do not enable the prototype operator on this source revision without its required full validation and the actual runtime owner's handback.

The earlier independently verified build-byte transport and application cache experiments remain component evidence at their original commits; none is relabelled as execution of this revision. No additional GitHub job or Mac application runtime was launched for this source integration. The complete under600second release goal remains unfinished.

## Source verification checkpoint

The prior version4 resolve-controller command passed191 private controller checks. The existing fake-transport operator probes passed5, the tiny typed-source binding probe passed1 and the bounded ZIP extractor probes passed6. These are203 integrity/protocol checks, not application cases or a full release gate. YAML parsed successfully; structural comparison changed only resolution checks, controller checks and the normal build job. Test/browser/compiler/migration/receipt/deployment-hold jobs, triggers and permissions remain identical. The first packet probe had2 failures caused by the macOS temporary-path alias; the fixture now canonicalizes its owned path without relaxing the verifier, and the current checks pass.

## Overlap artifact byte transport with CI (v14 prepared path)

`prefetch-ci.mjs` observes the exact same-repository normal-workflow run and stages immutable artifact ZIP bytes while jobs execute. It does not extract artifacts, issue a receipt, accept release evidence, move branches, access staging or cancel CI. Incomplete and failed runs remain incomplete/failed. Each snapshot checks run/controller/repository/workflow/attempt, bounded allowed artifact names and byte metadata, provenance, and that previously observed artifact IDs/digests/sizes have not changed or disappeared. A review-branch byte cache still cannot authorize a release.

From the clean frozen controller, with the clean frozen candidate and existing baseline, start byte staging after the single authorized dispatch:

```sh
AIHR_CI_CLASSIFIER_RUNTIME=native node /ABSOLUTE/CONTROLLER/.github/ci/prefetch-ci.mjs \
  /ABSOLUTE/CANDIDATE RUN_ID BASELINE_SHA /ABSOLUTE/NEW_PRIVATE_CACHE
```

The cache parent must exist; the command creates a new private directory. It checks every ten seconds and stops its own observer after 45 minutes without cancelling the CI run. Failed observations/transfers retain private raw evidence; they are never accepted as complete coverage. Artifact transfer is bounded to four children and 120 seconds each. Reuse a successful cache only after the CI run is terminal, using the normal official adapter:

```sh
AIHR_CI_PREFETCH_DIR=/ABSOLUTE/PRIVATE_CACHE node --import tsx \
  /ABSOLUTE/CONTROLLER/.github/ci/operator-release.mjs verify /ABSOLUTE/CANDIDATE RUN_ID
```

Use the existing authorized `deploy` mode only with the exclusive runtime window and all normal installation prerequisites satisfied. The release verifier first re-authenticates the final successful run, complete jobs and complete artifacts through the API. It treats the cache as untrusted bytes, checks private real directory/file ownership and exact final API digest/size, and copies authentic bytes into a separate private evidence directory without hardlinks. Missing cache entries download normally; corrupt or redirected entries refuse rather than silently substituting another result. Existing strict extraction, independently reconstructed full coverage, build/source/runtime binding, alpha guard, prelaunch revalidation and final source/build/ledger/health/cleanup checks all remain mandatory. No cached API snapshot is release authority.

The transport regression reproduced an unnecessary second transfer on the previous implementation, then passed with zero transfers on the new reuse path. An actual source-bound v13 inventory of 55 artifacts was freshly authenticated through the API and reused from its original prefetch cache with zero network transfers; private local copying took 327 ms, followed by all 55 digest reads. This is transport evidence only, not an executed v14 complete release or an end-to-end ten-minute result. The two full-file test partitions likewise require a fresh final full-policy witness before deployment.
