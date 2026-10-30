# Canonical CI build packet — current version16 source contract

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

Policy aihr-staging-ci/v17 retains the complete independently reconstructed job/test/browser inventory and adds the mandatory build artifact. Only this exact artifact namespace may exceed the existing64MiB JSON artifact ceiling, with an unchanged280MiB compressed ZIP limit and272MiB inner archive limit. The optional whole-compiler-state and next-application-state-v1 packets cannot replace either the build or any required test report. Version5 adds the second fixed optional namespace; it does not weaken required coverage.

Current build manifest and provenance are format2 and carry the exact closed capacityProfile `{profileVersion:3,archiveMaxBytes:285212672,zipMaxBytes:293601280}`. The inspected packet and new installation grant build preserve that identity; remote unpack, native consumer and active compiled-byte inventory must agree. Only the compressed archive cap rises. Individual payload file256MiB, external package32MiB, manifest16MiB, total unpacked2GiB and40000 entries remain fixed. The independent prepared System Testing and successful-observation records remain format1. The separate PostgreSQL resource profileVersion2 remains unchanged. Entire old build profile2 and mixed new-version/old-cap manifests refuse; retained old baseline records are opaque immutable recovery evidence, never current decoder fallbacks.

Producer finalization, packet inspection and extraction require the ACTUAL aggregate size of the five serialized regular members at most280MiB; extraction checks declared totals and cumulative streamed bytes. Separately, authenticate and bound the ACTUAL outer ZIP at280MiB through metadata/download/readback/extraction. A272MiB archive plus maximum-sized metadata is not assumed to fit the wrapper. Missing/mixed profile, old format, over-bound or inconsistent bytes refuse; no fallback or omitted payload is allowed. The finite profile3 archive suballocation does not prove actual metadata or outer ZIP fit. A real complete hosted producer and independently authenticated fresh-VM native/static consumer must establish those measurements; that transport observation cannot substitute for a full-policy witness, database health or authenticated rendered application acceptance.

This v16 capacity revision is source work pending actual hosted qualification. The original gzip9 diagnostic41107852301 failed its256MiB archive bound at272659334 bytes and skipped its consumer. Preserve that failure. Require a fresh complete real producer and different-VM native/rendered consumer, then ordinary full authenticated qualification. The v15 PostgreSQL profile2 and all other release safeguards are unchanged.

Old installed baseline manifests/grants are preserved verbatim, not decoded by new admission. Existing status/profile/ledger/build-ID and retained-directory inode fences establish baseline preservation; the new candidate's packet/grant selects its own records. No legacy reader or compatibility adapter is needed or accepted on the normal path.

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


## Refuse an invalid staging profile before CI evidence transfer

Run the read-only profile probe before submitting an end-to-end release benchmark, and before retrying an installation after authentication or environment changes:

```sh
AIHR_SSH_CONFIG=/ABSOLUTE/PRIVATE_SSH_CONFIG node \
  /ABSOLUTE/CONTROLLER/.github/ci/staging-preflight.mjs /ABSOLUTE/CLEAN_CANDIDATE
```

It sends the exact clean candidate's `customerEnvironmentErrors` function to the pinned deployment toolchain. The remote command uses the same shell-sourced production environment and default demo/customer predicate as `deploy.sh`. It reports only profile, checker identity, toolchain and validation errors; it does not disclose configuration values, query the database, install, migrate, restart, write deployment state or change configuration. The operator runs it before archive verification/download and repeats it during prelaunch revalidation. A configuration fingerprint still remains mandatory: unchanged configuration and valid deployment configuration are separate checks.

The October authentication activation established successful internal sign-in but did not upgrade the web service from Node20 or satisfy customer-install preflight. Development identity defaults and an unset audit-chain flag also remained. The later SMTP attempt correctly refused at this preflight; its passing CI and original Node20 native build remain labelled at their real origins. They cannot be relabelled as a supported Node22/24 customer runtime. Resolve the actual environment/runtime prerequisites through a coordinated, recoverable, version-matched release before retrying. Keep the failed attempt, original artifacts and recovery proof. Do not bypass customer checks, turn demo access back on or restart a mismatched native packet.


## Prepared customer-compatible target: Node 22.23.3

The v14 source prepares an exact Linux x64 Node 22.23.3 / ABI127 / glibc2.39 / Next16.3.8 build and installation contract. The current server is still Node20.20.2/ABI115; these source changes do not install a runtime, change systemd/environment, authorize a cutover, migrate data or make staging ready. Native build, cache context, recipient checks and service executable checks all pin the new tuple; legacy Node20 packets and application compiler graphs cannot be relabelled as Node22 proof. Unit tests already use the Node22 family, but a real canonical Node22 build and a fresh recipient native/render check remain separate required observations. Diagnostic transport proof cannot replace a full-policy release witness.

Before any server cutover, prepare a coordinated upgrade with an explicitly bounded runtime window, preserved source/build/environment/unit/key/database backups, exact installed target-runtime bytes, and a fresh matched original CI build. Remove development identity defaults and enable audit chaining through the actual customer configuration procedure while preserving origin, session keys, identities, grants and applied migration history. The old service/build and failed SMTP attempt remain independent retained evidence. Ordinary Node22 installers deliberately refuse a still-Node20 service: a runtime transition needs a separately reviewed transition/recovery procedure, not edits to provenance or weakened service checks. The prior approval to restore the old baseline does not authorize this future runtime/configuration change. Main/live deployment remains disabled.
