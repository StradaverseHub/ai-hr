# Canonical CI build packet — version 4 source integration

Status: prepared in the isolated performance review branch. Pure/private integrity and typed-helper probes have run; this revised normal workflow has not run a complete release gate, promoted an artifact, or established a new release baseline. Main/live deployment stays disabled.

## Normal build job

The normal alpha/staging build job now invokes the existing canonical System Testing producer through the candidate's installed tsx launcher, pinned to Node20.20.2 on Ubuntu24/Linux x64. It prepares a new immutable record and UUID, runs actual canonical production compilation and its application TypeScript check, requires a fresh BUILD_ID and successful build observation, then packs actual build bytes. Four database URLs remain explicitly closed. Source checkout is shallow because preparation reads only the frozen HEAD blobs.

The mandatory production-build-v1 artifact contains exactly:

- build-provenance.json
- system-testing.json
- successful-build.json
- bytes/build-bundle-files.json
- bytes/build-bundle.tar.gz

The packet is uploaded without ZIP recompression because the bundle is already gzip-compressed. It expires after one day, matching the verifier's maximum witness age. Upload and build failures remain blocking. Existing optional Turbopack cache behavior is retained; normal application TypeScript graph reuse and bounded build capacity are separate unfinished integrations.

A build-only invocation can compile review dispatches and same-repository PR checks admitted by the normal resolution guard. Its output always declares releaseAuthorized:false. The release verifier still requires a complete successful first-attempt normal run controlled by main or alpha; diagnostic, review-controller and PR builds cannot authorize deployment.

## Authenticated operator boundary

Policy aihr-staging-ci/v4 retains the complete independently reconstructed job/test/browser inventory and adds the mandatory build artifact. Only this exact artifact namespace may exceed the existing64MiB JSON artifact ceiling, with a280MiB compressed ZIP limit and256MiB inner archive limit. The optional whole-compiler-state packet cannot replace either the build or any required test report.

The operator authenticates the repository/run/controller/job/artifact through GitHub APIs, checks downloaded ZIP length and digest, and uses the existing exact-inventory bounded binary extractor. It then verifies source/controller/runtime/build UUID/BUILD_ID, original successful observation times inside the producing job, every bound record/manifest digest, and the actual archive length/digest. It independently regenerates the canonical System Testing preparation from the unchanged candidate and checks exact preparation bytes plus package/lock hashes. Immediately before any existing operator transfer, fresh API revalidation also reopens local packet bytes and rechecks canonical source.

The source/record binding is asynchronous because it imports the actual candidate's typed helpers. Both operator verification calls await it. Use the installed candidate toolchain, for example node --import tsx .../.github/ci/operator-release.mjs verify CANDIDATE RUN_ID; plain Node20 cannot import these typed helpers.

A resumable source assessment checks any present binary packet's provenance, bytes and producing job, but still requires a fresh build and supplies no additional reusable test unit. A failed or incomplete normal run remains failed/incomplete. Version3 witnesses cannot be relabelled version4.

## What remains before build-once deployment

This change does not install build bytes on staging. The existing operator still uses the remote canonical build path, so duplicate compilation remains until the promotion spine is implemented and verified. Archive member safety, recipient dependency/package-tree equality, compiled five-value System Testing identity, current staging runtime/environment, and native/runtime compatibility must be checked at installation.

Preserve audit/auth preflights, migrations, catalog and backfill work, knowledge seeding, restart, health, source checksum and migration-ledger arrival checks. The legacy candidate pending-announcement helper still swallows failures; harden that boundary before operator adoption. Do not enable the prototype operator on this source revision without its required full validation and the actual runtime owner's handback.

The earlier independently verified build-byte transport and application cache experiments remain component evidence at their original commits; none is relabelled as execution of this revision. No additional GitHub job or Mac application runtime was launched for this source integration. The complete under600second release goal remains unfinished.

## Source verification checkpoint

The exact updated resolve-controller command passed191 private controller checks. The existing fake-transport operator probes passed5, the tiny typed-source binding probe passed1 and the bounded ZIP extractor probes passed6. These are203 integrity/protocol checks, not application cases or a full release gate. YAML parsed successfully; structural comparison changed only resolution checks, controller checks and the normal build job. Test/browser/compiler/migration/receipt/deployment-hold jobs, triggers and permissions remain identical. The first packet probe had2 failures caused by the macOS temporary-path alias; the fixture now canonicalizes its owned path without relaxing the verifier, and the current checks pass.
