# Complete the private CLI fixture dependency closure

Source-only recovery from exact `dba4bac1e8961ab3ee37c53a8d1c21a07faf4689`.
Production remains held. No behavior test, compiler, build, upload or installation
ran locally; this checkpoint requires independent review and hosted verification.

## Original evidence and actual failure

Hosted run42399283683, resolve job128483352874 checked out the exactdba4 controller;
the controller-only expected/controller guard passed. CI integrity passed806/806,
and the existing build-bundle suite passed57/57. Retain those original successes.
The transport extractor suite then ran12 cases:11 passed and1 failed. The workflow
remains failed; no result is relabelled onto this recovery.

`test_real_cli_does_not_dirty_controller_with_local_import_bytecode` cloned the
original/current extractor and current build-bundle.py into a private directory.
The bundle now imports its fixed sibling runtime_inventory.py. That omitted fixture
dependency raised FileNotFoundError in the original clone, before the bytecode
comparison. The run did not reach resolve.mjs or inventory reconstruction; later
jobs were skipped. The same incomplete clone exists in the helper-cleanliness
fixture, which did not execute in this run. That second gap is static evidence,
not an additional observed failure.

## Narrow repair and preserved controls

Both private clone builders now copy the exact existing runtime_inventory.py bytes
beside the bundle. The transport comparison still uses the pinned original
extractor source2b22122911aa3e2e5ea9c5175c5bc24144742ef7 and the unchanged current
extractor. It still removes caller PYTHONDONTWRITEBYTECODE/PYTHONPYCACHEPREFIX,
requires both real subprocesses to succeed and expects original/current bytecode
observations[true,false]. No bytecode ignore or caller flag substitutes for the
current entrypoint's own behavior. Helper cleanliness still uses real private Git
repositories, both readers, actual caller Python settings, the Usage check and
exact clean status before/after. Every existing refusal/capacity assertion remains.

The production inventory, loader, extractor, caches, runtime, workflow, trust and
frozen original bytes are unchanged. Exact source hashes retained fromdba4:

| Existing input | SHA256 |
| --- | --- |
| runtime_inventory.py | b4207c2e82ee07692f4fd3814b2d5ab7f5d86a9b7471139c2ed56e4f2e86563d |
| build-bundle.py | 2045da6a701e96d926fae02f915727902d898bf98d011bfc6e3ae8cffc15ca6e |
| fixtures/build-extractor-bytecode-original.json | 71cee39e8949a8a8c1efce8cf32330953759a8bb6cee53907fedc7580ed91add |

## Affected-check manifest for hosted recovery

```json
{
  "scope": "fixture dependency closure only; not release evidence",
  "releaseAuthorized": false,
  "failedArea": ".github/ci/build-transport-extract.test.py",
  "staticallyAffectedArea": ".github/ci/build-helper-cleanliness.test.py",
  "commands": [
    "PYTHONDONTWRITEBYTECODE=1 python3 .github/ci/build-transport-extract.test.py",
    "PYTHONDONTWRITEBYTECODE=1 python3 .github/ci/build-helper-cleanliness.test.py"
  ],
  "subsequentVerification": "Complete the actual controller-only resolve/inventory route after review; preserve all planned original failures and unaffected evidence."
}
```

The failed extractor file must execute all12 existing cases, including both actual
original/current CLI subprocesses. The helper file must execute its existing case
with both reader subtests. Later transport controls skipped by shell failure and
the actual controller-only inventory remain required at their original boundaries;
these two targeted commands alone cannot qualify the whole workflow or runtime.
