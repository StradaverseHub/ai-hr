# Next build byte transport

This component is part of the under-ten-minute release work. It packages and verifies build bytes; it does not authorize a release, replace compiler/test evidence, change a deployment or prove a service is active. The existing staging build remains mandatory until a complete versioned promotion path is validated.

## Observed build structure

A read-only inventory of the completed local Darwin build found 12,109 regular production files totalling 698,289,468 bytes after excluding the root cache and development output. There were two external runtime aliases: Sharp 0.35.5 and Fontkit 1.9.0. Copying the original links would retain the builder's dependency paths. This inventory establishes format compatibility only; it is not a Linux artifact, compressed size measurement or runtime proof.

`.github/ci/build-bundle.py` now provides two byte operations:

```text
python3 .github/ci/build-bundle.py pack SOURCE NEW_OUTPUT_DIRECTORY
python3 .github/ci/build-bundle.py unpack ARCHIVE MANIFEST NEW_PRIVATE_DESTINATION RUNTIME_SOURCE
```

Packing reads `SOURCE/.next`, omits only its root `cache` and `dev` trees, preserves other production files and directories, and records every regular file's path, size, mode and SHA-256 digest. It binds BUILD_ID and the compressed archive bytes. Package aliases are represented as metadata rather than archived links. Their package name, version, package.json and complete bounded package-tree digests are recorded. Both known packages must be present; arbitrary links, environment files and unsupported dependency output refuse packaging.

The receiver checks the complete canonical manifest and compressed bytes, then parses bounded raw USTAR headers before reading member bodies. It refuses PAX/long-name extensions, traversal, duplicate/missing files, links, devices, unexpected metadata, changed contents, truncation and trailing data. It reconstructs aliases only after matching the runtime installation's actual package bytes and verifies them again after extraction. Builder paths are not reused for aliases.

Both operations require new output directories. The receiver uses a new private staging directory and removes only that newly created directory on failure. It never overwrites an existing build or changes a service. The limits are 40,000 files/directories, 2 GiB unpacked data, 256 MiB per file and per compressed bundle, a 16 MiB manifest and 32 MiB per directly aliased package. A build outside these bounds refuses; these are not permission to omit required runtime files.

## Checks and limits

Nineteen private filesystem tests passed, including complete round-trip bytes, compatible hardlinked package-store inputs, changed package code with unchanged package.json, existing-output preservation, corruption, missing/duplicate files, unsafe tar members, gzip extension/trailing-data refusal and malformed manifests. The resolve job runs these small Python checks alongside its existing integrity checks. No Next compiler, application test, database, network or real deployment runs in those fixtures.

The format records Darwin or Linux as byte provenance. A Darwin byte bundle is not eligible for staging promotion; the future CI/release verifier must separately require the selected Linux architecture, exact supported Node/runtime and target context. This primitive does not authenticate its manifest against GitHub, evaluate application configuration or authorize arbitrary caller-supplied build bytes.

Before replacing the remote build, connect the following complete path: derive the actual target compile context and a unique owned System Testing preparation; run the frozen candidate's canonical production builder on the compatible Linux runner; package its actual successful observation and bytes; authenticate workflow/run/job/attempt/controller/source and artifact digests against GitHub; independently verify the target's current environment, installed source and dependencies; install into the staged release and prove runtime behavior. Retain audit preflights, migrations, catalog work, restart, health, source/build arrival and all required testing. In particular, verify the real Sharp and Fontkit paths, including the existing Chinese payslip rendering requirement. The current bytes-only implementation establishes none of those missing claims.

## Canonical producer, pending Linux execution

`.github/ci/build-production.mjs` connects the byte bundle to the existing candidate-owned System Testing builder. It prepares and privately publishes a fresh UUID record, calls `runTestingProductionBuild` without its fake-child test seam, checks the actual successful observation against the preparation and fresh BUILD_ID, then packages the resulting bytes and records raw preparation/observation plus their digests. Source/controller cleanliness and immutable preparation/observation bytes are checked again after packaging. It records candidate, controller, repository, workflow, run/attempt, runtime and dependency-file hashes. Its output explicitly has `releaseAuthorized: false`.

A read-only staging probe on 25 October found Linux x64, Node 20.20.2, ABI 115, glibc 2.39 and Next 16.3.8. The producer currently refuses any other tuple. It also refuses inherited or production-dotenv `NEXT_PUBLIC_*` and Server Actions key overrides; the probed staging environment file had none. A target/runtime or public compile configuration change needs deliberate review and corresponding integration, rather than silently promoting a different configuration. This narrow check does not prove all build-time environment dependencies have been assessed.

Four pure guard groups passed for runtime/environment mismatches, candidate/controller/repository/workflow/attempt context, preparation/observation/build identity and stale/future/invalid timestamps. These checks do not execute the canonical producer, compiler or packer together. No Linux producer execution, uploaded build artifact, independent authenticated promotion, start/render proof or actual deployment through this new path has occurred. The existing required build job and remote build are unchanged. The producer is not enabled as an alternate release path; the resolve job only runs its small guard tests.

Remaining integration must version the artifact/verification policy, authenticate all required GitHub evidence and producer output, revalidate current target context and dependencies, transfer and stage verified bytes, preserve migration/audit/catalog/restart/health/source-arrival requirements, and verify the complete Linux runtime including Sharp and Chinese Fontkit rendering. The existing JSON-only extractor and 64 MiB artifact policy still reject this binary output. Do not bypass those boundaries or treat self-reported GitHub environment fields as authentication.
