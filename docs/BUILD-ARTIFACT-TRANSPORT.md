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
