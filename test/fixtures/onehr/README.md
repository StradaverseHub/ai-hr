# Source parity fixtures

`source-golden.json` is derived from the user-supplied full OneHR source package, commit `a644fd6` on `feature/staging-environment`. Its `source` metadata records the actual `app.py` SHA256. The sibling `SHA256SUMS` manifest was checked before extraction (349 matches).

Extraction parsed Python's AST and compiled only four pure function definitions: `pm_rating_mechanism_a`, `pm_pct_mechanism_b_base`, `pm_pct_mechanism_b_excellence`, and `talent_category`, with the literal talent table and `TALENT_PIP` constant. It did not import Flask, execute module initialization, open a database or use source credentials.

The 156 numeric cases cover both KPI directions, exact and adjacent thresholds, below/above-target values, zero and enlarged excess multipliers, and excellence caps. All 15 person-level performance × potential cells are included. These preserve source behavior; they do not establish that the organization's live catalogue/configuration equals the defaults in source. In particular, less-is-better excellence arithmetic is explicitly unverified in the source interview notes.

The native tests add workflow state, normalized weights, missing-component behavior, calibration precedence, Malaysia window boundaries, identity/access revocation, anonymous releases, immutable evidence/results and the Rewards classification boundary. Source database schemas and source employee records are not test fixtures or an import contract.
