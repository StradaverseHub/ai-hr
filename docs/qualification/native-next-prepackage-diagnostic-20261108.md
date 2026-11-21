# Closed actual Next prepackage diagnostics

Status: **NOT RUN**; diagnostic source child of `7f73f33823e408c3fdaa8d348ccece86883278ff`. This deliberately retains all existing assertions, private exception redaction, 480-second fixture envelope, cleanup budget, resource admission, API/build/source binding and runtime isolation. No deployment or release authority.

Commissioning run 42418472291 is terminal failure: exact source/controller 7f73, sole unit `db-ef098640eeb0a97b`, one failed native assertion, zero skipped, 35.09 seconds. Resolve/plan, canonical build job 128541984833 and protected pre-package setup completed; the selected native profile did not pass. The actual report has only `actual-host-and-sealed-input-preflight`, `failureType=AssertionError`, `ownedRuntimeCleaned=true`, `actualNextBootVerified=false` and `fullApplicationJourneysVerified=false`. It never reached package preparation, dependency probe or a Next start. Its caught failing interval is `fixture_directories()` or `install_helpers()`; arbitrary exception text remains redacted, so the exact old failed guard is **not observed**.

API-authenticated source/controller/run/job and ZIP digests were independently checked. Retained artifacts:

| Artifact | ID | API-verified ZIP SHA256 |
| --- | --- | --- |
| Native unit | 13593036343 | `7f0eb1fca16042a5332d779cfdc64189030c941d5f0a40cc68e0ed82ad2d86cd` |
| Commission summary | 13592967798 | `472629b5c7e5615120cf8660ff139f1fcbca596f2f6021bc582438e348ee1dec` |
| Complete plan | 13592920948 | `7fad8301f27babc9acab5d5c76688bbda75fe0e1b32900b7c82a500360a68a2e` |
| Same-run canonical build | 13592877256 | `65b208a225cf0a434f1bab0fe421914d8483b44d2e6720811e61fa21138de32c` |

Build ID `y4am-2dnxlUAFZgUkNZFW` and producer's archive/manifest/provenance IDs match the native report. A passing build is not boot acceptance. Original four-file/117 source controls and 920 controller assertions retain their original run identities.

This child adds only fixed public subphases and closed guard codes around those two fixture preparation functions. A failed original condition still raises. Unknown stage/code or code in the wrong phase refuses before modifying evidence; no exception message, environment value, path or caller input is reflected. Existing top-level arbitrary exception/child-output redaction stays intact. The five stdlib models prove this diagnostic boundary, including the actual directory function's unchanged synthetic loaded-slice refusal. They do not execute root, systemd, package copying, Node, a database or Next. Hosted source selector: `test/runtime-next-prepackage-diagnostic.test.ts`.

A source-proven defect is separately identified: the existing directory guard expects every unit, including a slice, to have `LoadState=not-found`. In pinned systemd v255, [slice_load](https://raw.githubusercontent.com/systemd/systemd/v255/src/core/slice.c) calls the fragment loader with `fragment_required=false`, and [unit_load_fragment_and_dropin](https://raw.githubusercontent.com/systemd/systemd/v255/src/core/unit.c) marks an otherwise missing slice loaded. Therefore the guard can refuse a clean implicit slice. This is a strong inference for the old interval, **not an artifact-confirmed old cause**. The diagnostic child intentionally does not relax that guard.

Root requested a separate proper slice-absence successor before any new native commission: prove no fragment/drop-in/transient/active cgroup/foreign occupants or associated service units, retain strict absent service guards and exclusive root-owned unit-file creation. Do not spend a known-failing diagnostic-only build. Freeze/review this child first, then review that bounded successor and qualify the actual new source/build through the existing strict transport. No old compiled packet, failure, boot result or cleanup receipt is relabeled. No local tests, application, compiler, build, database or native runtime executed.
