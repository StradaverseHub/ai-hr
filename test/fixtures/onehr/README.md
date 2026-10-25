# Source parity fixtures

`source-golden.json` is derived from the user-supplied full OneHR source package, commit `a644fd6` on `feature/staging-environment`. Its `source` metadata records the actual `app.py` SHA256. The sibling `SHA256SUMS` manifest was checked before extraction (349 matches).

Extraction parsed Python's AST and compiled only four pure function definitions: `pm_rating_mechanism_a`, `pm_pct_mechanism_b_base`, `pm_pct_mechanism_b_excellence`, and `talent_category`, with the literal talent table and `TALENT_PIP` constant. It did not import Flask, execute module initialization, open a database or use source credentials.

The 156 numeric cases cover both KPI directions, exact and adjacent thresholds, below/above-target values, zero and enlarged excess multipliers, and excellence caps. All 15 person-level performance × potential cells are included. These preserve source behavior; they do not establish that the organization's live catalogue/configuration equals the defaults in source. In particular, less-is-better excellence arithmetic is explicitly unverified in the source interview notes.

The native tests add workflow state, normalized weights, missing-component behavior, calibration precedence, Malaysia window boundaries, identity/access revocation, anonymous releases, immutable evidence/results and the Rewards classification boundary. Source database schemas and source employee records are not test fixtures or an import contract.

The literal `_RR_EXPORT_HEADER` list was also extracted without running the application. The workbook contract preserves its 43 columns in order and verifies real XLSX sheets, score units, partial KPI coverage, formula-safe names and leading-zero employee codes. The SQL snapshot scorer has a differential check against the same 156 numeric cases; prepared tests are not evidence of execution.

## Re-derivation against OneHR 6e0a14e (2026-10-25, ADR-0140 M02)

`source-drift-6e0a14e.json` records a re-derivation against the 24 Oct 2026 package (OneHR `6e0a14e`, checksums
verified 667/667). The extractor parsed both `app.py` files with Python's AST only; the application was never imported
or started. The four pure scoring/talent functions and their literal tables were compiled one definition at a time
into an isolated namespace (referenced functions bound to stubs that raise), then called with the exact inputs of
`source-golden.json`: all 156 scoring cases and all 15 talent cases give identical results. The source parity
fixtures therefore remain valid for 6e0a14e for those functions.

Other named source functions were compared by normalized AST. Unchanged: `_jg_rank`, `_pm_parse_idp_goals`,
`_lc_first`, `_rewrite_grounding_error`. Changed (each characterized in the record): the rating-record export
header (one added column, 43 → 44), `_career_cap_grades` (next-step roles), `calib_suggest` (optional potential
band order; performance arithmetic unchanged), `reminder_reasons` (refactored into a delegate; not re-derived) and
`_tb_band_trails` (BU calibration-group scope). These are 6e0a14e behaviour deltas awaiting Chin Hin's business
confirmation; the native code and the a644fd6 fixtures are deliberately unchanged until then.

Fixtures whose metadata does not name a source function cannot be re-verified mechanically and keep their a644fd6
provenance: ask-guard, calibration-curve (helpers unnamed), calibration-fit, competency-insight, idp-fit, insight
(helpers named, not re-executed), potential-insight, potential-source, record-cycle, record-figures, record-present,
record-trend, talent-idp-steps, talent-insight, talent-list (JavaScript helpers), talent-move, talent-polish,
talent-strength, written-remarks.
