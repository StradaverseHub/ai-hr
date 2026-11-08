# Isolated Python caller preserves the controller source

Source-only child of frozen35c080cf29c5705750095d00815593ea4c3cb9c5. Production
remains held. No local application, compiler, build or runtime checks, upload or
installation ran. Independent review and hosted execution remain pending.

## Separate original failures and successful evidence

The first run42399283683 atdba4 failed the extractor's incomplete private fixture
dependency closure. Keep that original failure and its806 integrity/57 bundle
passes. Reviewed35c adds only the missing runtime_inventory.py sibling to the two
private CLI clone builders.

The recovery42400138826 checked out exact35c as source/controller. Its integrity
806/806 and entire byte-transport step passed: staging11, lease2, release42,
bundle57, extractor12, activation9, focused-extractor12 and repair-extractor12.
Frozen candidate resolution passed. The subsequent complete inventory planner
refused `CI requires a clean candidate`; later jobs were skipped. The failed run
did not log the actual dirty paths, so no particular observed filename is claimed.
Neither original failed workflow is relabelled as passing.

## Actual caller defect and prepared causal comparison

The new bundle import case invokes the repository source with Python-I. That mode
ignores the caller's PYTHONDONTWRITEBYTECODE flag, and build-bundle imports its fixed
runtime_inventory.py sibling. A child can therefore write bytecode in the frozen
controller despite passing its import assertion. The repair retains-I and adds-B
to that actual source-side child. It compares exact Git porcelain status before
and after, including every untracked path; existing foreign status is preserved.
There is no clean-only baseline assumption, generated-file ignore or deletion.

The same case also prepares two fresh private copies of the exact existing bundle
and sibling bytes. It strips caller bytecode/cache environment variables, runs one
copy with-I and the other with-I-B, and requires both to import the real fixed
inventory while an unrelated CWD/hostile PYTHONPATH shadow would throw if loaded.
The unprotected private copy must create the inventory's .pyc cache; the protected
copy must create no cache. The real controller status must remain exactly unchanged
after both private probes. This demonstrates susceptibility in owned temporary
fixtures; it does not invent the prior run's missing path observations.

All57 existing bundle cases remain, with stronger assertions inside the one existing
import case. No production loader, inventory, cache policy, strict clean guard,
workflow, source identity, capacity, budget or release authority changes.

## Affected-check manifest for hosted recovery

```json
{
  "releaseAuthorized": false,
  "failedArea": "controller-only complete inventory refused a dirty source",
  "changedCheck": ".github/ci/build-bundle.test.py",
  "commands": ["PYTHONDONTWRITEBYTECODE=1 python3 .github/ci/build-bundle.test.py"],
  "requiredFollowup": "Actual controller-only resolve/inventory route with the strict clean guard unchanged"
}
```

The hosted bundle check must execute all57 cases, including actual protected source
import, both private causal probes and exact before/after controller status. The
actual resolve/inventory route is still required to establish complete topology;
a focused success alone cannot qualify that route or the application/runtime.
