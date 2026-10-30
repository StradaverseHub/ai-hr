# ADR-0114 — Deterministic test selection and release learning

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- Date: 2026-10-14
- Status: Accepted by the owner: follow Anthropic's test-impact approach and learn from every release.
- Supersedes ADR-0094's blanket full-gate rule for product logic. Its full runner and legacy receipts remain valid.

The previous classifier sent every core/lib/action change through roughly forty minutes of tests,
including an error-message repair whose focused tests already passed. A commit identifies the code;
it does not describe which tests that code affects. We keep exact-commit evidence while selecting work
from dependencies, risk and observed failures.

`bash scripts/gate.sh` is the default entry point. `--plan-only` explains the selection, `--full`
requests broad regression, and `--shadow` runs the full suite while retaining the proposed selection.
The old full and presentational runners remain available for compatibility.

A real-repository shadow measurement exposed all-to-all facade edges: a clock-message edit selected
799 of 803 DB files. Diagnostic-only edits with unchanged initialization now resolve named exports
through pure re-export facades. Explicit destructuring of literal dynamic loads is resolved the same way as named imports.
Namespace/non-destructured consumers, uncertain readers and functional edits
retain broad module reach. The current shadow check selects 364 of 804 DB files and retains the historically failing
clock accuracy test. Facades retain every transitive initialization owner; computed names, decorators,
tagged expressions, getters/coercion/iteration and other setup effects prevent unsafe narrowing.
Five initialization regressions failed on the old selector before passing with this rule.
Source-reading uncertainty remains a deliberately broad fallback.

The deterministic selector parses static imports, re-exports, literal dynamic loads, mocks and the
server-only test alias. It follows old and new edges so removals retain their consumers. It adds
source-reading and uncertain-load consumers, changed tests, repository guards, tenant/access invariants
and tests associated with earlier failures. An uncertainty broadens coverage; a changed module with
unresolved reach or no executable consumer requires full verification. This is deliberately conservative.

The collector retains UTF-8 source containing null characters; a raw null in a valid test fixture
is not evidence that the file is binary. An independent contract compares every tracked code file
with the collected input. This caught the real people-filter test omission after the full runner had
correctly counted all 1,349 files. The embedded-null CLI fixture verifies both full and selected runs.

Risk categories are:

- Low: established presentation/doc changes, or an AST-equivalent edit limited to comments, formatting
  or Error diagnostic strings. Other literals and control flow remain significant.
- Moderate: product logic with resolved executable test consumers and no protected high-risk owner.
- High: database/schema/migrations, identity/security roots, financial calculation owners, jurisdiction
  code, test setup, dependency/configuration, gate/release/deployment machinery, and test removal.
- Unknown: unsupported ownership/file types, unresolved changed imports or missing executable coverage.

High and unknown changes run the full suite. Selected DB tests are bounded to 64 files per rebuilt
cluster; no-DB tests use a closed database port. Both lock slots and the shared database lock are held.
The runner counts every requested file, writes FAIL before beginning a new attempt, refuses a changing
candidate, and issues PASS only after complete successful coverage. Browser checks accompany interface
changes. Type checking, the production build, outcome walkthroughs and migration rehearsals still apply.

The official release still runs the complete repository TypeScript check locally. The production
build uses `tsconfig.build.json`, which inherits the same strict compiler options and checks all
application code while excluding development-only tests, CLI scripts and tooling configurations.
Imported dependencies remain included by TypeScript. Development uses the original full configuration.
Next's type-checking failure behavior remains enabled. The reduced root set and a deliberate type
error are verified; production runtime improvement is measured separately from test selection.

A completed full candidate can be retained as the baseline for a subsequent small repair before
release. Its full receipt must cover an ancestor between production and the candidate, with complete
counts and the same environment. The repair receives a new exact-commit selected receipt. Release
recomputes the plan against the current production source and validates the full witness, environment,
policy, complete test list and browser count. Missing, stale, altered or broadened evidence refuses.
There is no arbitrary override or manually fabricated receipt.

A fresh full baseline is required initially and at the next gate after seven days or ten released
versions. This is an event-driven refresh, not a claim that a nightly job exists. Changes to the selector
itself require full validation; policy-version changes are explicit.

Every completed gate saves immutable observations in `~/.aihr-gate-state/impact-learning`, overridable with
`AIHR_IMPACT_STATE_DIR`. Every successful official deployment build saves a release record locally and
mirrors it to `/var/tmp/aihr-deploy/impact-learning` on the server, outside rsync's source tree. Records
contain commit/build identities, environment hashes, module hashes, dependencies, risks/reasons,
selected tests, failures, timings and explained classification transitions. They contain no HR rows,
credentials, source contents or raw environment values. The build record explicitly does not claim the
separately performed service restart was verified.

Release classifications cover the complete production-to-candidate diff, even when verification
reused an undeployed full candidate and checked only its final repair. The deployed baseline and
explicit scope uncertainties are saved; unavailable classification never discards a verified build
record or silently claims complete impact knowledge.

Mirrors preserve the original immutable timestamp, classifications and transitions verbatim.
Out-of-order retries retain the newest source observation rather than treating receive time as release
time; duplicate delivery is idempotent, and conflicting bytes for the same record refuse.

Unknown classifications remain saved. New executable coverage or resolved dependencies can establish
a known category on a later release; a passing run alone does not lower risk. Historical failures only
add tests. `pnpm gate:learning` shows the latest accumulated classification evidence. Corrupt/unavailable
learning data forces broad verification. A mirror failure is reported after the successful build;
a durable local outbox is retried by the next official release rather than misreporting the build as failed.

Initial validation includes executable selection fixtures, adversarial receipt cases, persistent
unknown-to-known transitions, historical failure selection and a one-time full gate. Runtime and
selection size are measured, not promised. The source-reading fallback is intentionally broad until
more precise evidence supports narrowing it.

References: Anthropic, [test-impact analysis](https://claude.com/ko/resources/articles/agentic-coding-is-straining-ci-heres-how-we-scaled-test-impact-analysis-at-anthropic),
14 September 2026; [risk-tiered development safeguards](https://claude.com/resources/articles/how-anthropic-secures-its-ai-native-software-development-lifecycle),
21 July 2026. These support the approach; our policy and thresholds are local engineering decisions.

## Owner clarification — 30 October 2026

The owner reaffirmed that recovery after a complete frozen gate runs only failed areas and checks invalidated by the repair. Valid successful evidence is retained. A single failure does not justify restarting the complete gate. Let all planned chunks finish, preserve the failed run, and identify any source/controller/runtime/coverage invalidation explicitly before expanding recovery scope.

The CI-specific adoption gap is recorded in [CI recovery policy](../CI-STAGING-VERIFICATION-POLICY.md#owner-recovery-decision--30-october-2026): existing resume assessors are not release receipts, and the current operator accepts only a successful single whole witness. The owner decision must be implemented through authenticated, independently verified recovery; it is not permission to fabricate receipts or relabel failed evidence. Older blanket fresh-whole-run recovery guidance is superseded by this clarification.
