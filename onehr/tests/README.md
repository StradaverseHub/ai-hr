> **Reference copy.** The synthetic-data seeder (`seed_staging.py`), `seed/`, the deploy and ship tooling and the suites that
> tested them were removed from this copy, so `harness.py` cannot build its fixture here and many suites will not run as they are.
> The remaining suites are kept as documentation of the rules the code enforces.

# Tests

```sh
tests/run.sh              # every suite
tests/run.sh timezone     # one suite, by name
```

First run builds a virtualenv and a scratch copy of the database under
`/private/tmp/onehr-tests/` (`/tmp` on Linux). Later runs reuse them.
**13 suites, 510 checks, about 20 seconds from nothing.**

Every run prints which database it is measuring against, because that is not
always the same one:

```
[harness] running against the repo's leadership360.db
[harness] running against the generated synthetic fixture
```

`test_fresh_install.py` is the one suite that does **not** need
`leadership360.db`: it builds a database from nothing, which is the whole point
of it. Every other suite copies the real one, and that is exactly why none of
them could catch a migration that only fails on a virgin database — see below.

## Why these live in the repo

They used to live in `/private/tmp`. macOS cleaned it twice in two days and took
the virtualenv, the scratch database and four of the five suites with it — and
the second time it did not clean tidily: it stripped the venv's `pyvenv.cfg` and
most of its `.py` files while leaving the directories, so `import flask` failed
with *unknown location* rather than a clean `ModuleNotFoundError`.

A suite that vanished is not a passing suite. `run.sh` now rebuilds a missing or
damaged virtualenv on its own, so the next cleanup costs a rebuild rather than a
rewrite.

## The safety rule

**A test never touches the live database.** `harness.setup()` copies
`leadership360.db` into the scratch directory and repoints the app at the copy;
every suite then asserts `onehr-tests` appears in `app.DB_PATH` before doing
anything. If that assertion ever fires, stop — do not relax the check.

Nothing here ships. Both deploy paths use an explicit **allowlist** of files
(`app.py templates static …`), and `tests` is in neither, so this directory
cannot reach a VM.

## The login shim

Driving a page in a browser needs a session, and we do not type passwords into
the login form to preview. `harness.py` splices a path-guarded shortcut into the
**scratch copy** of `app.py` — never the repo's — which refuses unless it can see
the scratch marker in its own `APP_DIR`. Keeping it in the harness rather than
pasting it into each suite means it is reviewable in one place, and
`grep -rn __scratch_login app.py` in the repo stays empty.

## The suites

| Suite | Covers | Commit |
|---|---|---|
| `test_timezone.py` | store UTC, display MYT; the 00:00–08:00 window | `bd675e2` |
| `test_module_gate.py` | a switched-off module refuses, not just hides | `f72c126` |
| `test_panel_build.py` | the bulk panel build is strictly additive | `1b15c25` |
| `test_data_integrity.py` | 17 checks, each count re-derived independently | `278839a` |
| `test_phase0.py` | the six Phase 0 repairs | `7430e62` |
| `test_evidence.py` | the evidence ledger: append-only, authorship, reversibility | `c7220c0` |
| `test_fresh_install.py` | a brand-new environment can start | `e72456c` |
| `test_demo_seed.py` | the demo corpus loads on a migrated database **and can be seen** | `ae544a6` |
| `test_technical_progress.py` | the competency progress count ignores orphaned scores | `2367555` |
| `test_review_repairs.py` | absent is not empty — the partial-write defects Phase C would trigger | `df38274` |
| `test_review.py` | the guided review: one definition of done, zero writes from a read surface, and the waiting split | `a6f7487` |
| `test_ai_review.py` | Phase D: the AI is decoration — identical fallback three ways, and it writes nothing | (this round) |
| `test_why.py` | Phase B step 1: cited evidence reaches the calibration room, subject-scoped and batched | (this round) |

**Four of the first five are reconstructions.** Only `test_phase0.py` survived the
cleanup; the others were rewritten from their commits' own record of what they
asserted. They cover the same invariants and pass, but they are not byte-for-byte
the originals, and a few incidental assertions will have been lost.

## Where the database comes from

`leadership360.db` and `seed/*.db` are gitignored because they hold real employee
PII. That is what kept these suites off CI: there was no database to run against,
and committing a fixture would have meant a second dataset to keep in step plus a
PII surface every time somebody refreshed it.

So the fixture is **generated, never committed**. `harness.build_fixture()` lays
down `app.SCHEMA`, migrates it, and runs **`seed_staging.py`** — which was already
exactly the right tool: committed, entirely synthetic by design, offline (it reads
only `seed/framework.json`, also committed), and idempotent.

| | |
|---|---|
| 298 users | 1 super admin, 4 BG-scoped, 24 letter-grade (JG H) |
| 3 business groups, 18 departments | HOD → managers → ICs |
| 2 cycles, 224 statements | 1,380 assignments, 38,640 responses, 228 releases |
| **7 of the 17 data-integrity checks fire** | on deliberate edge cases, not by accident |

**The repo's own database still wins when it exists**, so a developer's run is
unchanged. The fixture is built once and cached at `SCRATCH/fixture.db`; nine
suites must not pay for nine builds. Two builds produce identical row counts.

Two things this got wrong once, both worth keeping in mind:

- **`seed_staging.py` is COPIED into the build directory, never symlinked.**
  Python sets `sys.path[0]` from the script's *resolved* path, so a symlink puts
  the repo on `sys.path`, imports the repo's `app.py`, and seeds into the
  developer's own `leadership360.db`. Same reason `app.py` is copied.
- **The scratch base is `/private/tmp` on macOS and `/tmp` elsewhere.** Linux has
  no `/private` and a CI runner cannot create one, so a hardcoded path fails at
  `mkdir` before a single test runs. The safety assertion keys on the *marker*,
  not the base.

## The one suite that starts from nothing

Every suite but one begins by copying a database that already evolved through the
real migration history, where each `CREATE TABLE IF NOT EXISTS` is a no-op. That
makes a whole class of fault invisible: `_ensure_runtime_schema()` aborted on a
virgin database for months — meaning a brand-new environment could not start —
and 190 passing checks said nothing about it.

`test_fresh_install.py` AST-parses `SCHEMA` out of `app.py` **without importing
it** (the import is what fails), lays it down, then imports the app so the
migration runs. Two details are load-bearing:

- **Each bootstrap runs in a subprocess.** A migration only runs on the *first*
  import, so a second bootstrap in the same interpreter silently reuses the first
  module and proves nothing.
- **It asserts a second boot rebuilds nothing** — the entire `sqlite_master` dump
  must be identical before and after. That is the general form of the fault, not
  a patch on the one table that had it.

## Exit status is not the test

`test_demo_seed.py` earns its own note, because the bug it guards against is one
a green run hides.

The demo corpus was written against `pm_periods`, which the merge folded into
`cycles` and dropped. The obvious repair -- rename the table and the column -- is
**worse than the failure it replaces**: it exits 0 with no errors and a clean
`foreign_key_check`, while parking every KPI target on a second, inactive cycle
that `active_pm_period()` never resolves and `require_active_cycle()` treats as
closed. Loud failure became silent success.

So the suite asserts **reachability**, not exit status: the seeded rows must hang
off the cycle the application actually resolves, and the demo employee's
`/performance` page must render their own KPI lines. It carries a **negative
control** that reconstructs the naive repair from the `pre-seed-rebuild-2026-08-28`
tag and asserts it FAILS those checks -- so the suite cannot quietly go green on
that mistake later.

## Three conventions worth keeping

**Assert the relationship, not the number.** These run against the repo's local
`leadership360.db`, which is older than staging. A check that hard-codes *210
subjects with two line managers* breaks on a different copy and proves nothing
about the code. Re-derive the expected value with an independently written
query instead — which is also the only honest way to test a diagnostic, where the
real risk is a **wrong check**.

**Measure the delta, not the absolute.** The data already carries rule breaches
from earlier builds and imports — letter-grade subjects with a non-line-manager
assessor, subjects with two line managers, people over the peer cap. Asserting
absolute zero fails on data the code under test never touched and hides the real
claim, which is *does not make it worse*.

**A test must be able to REACH the line it is about.** `test_review_repairs.py`'s
first version posted to `/performance/submit-all` with no KPI line to submit, so
the route bailed at *"Nothing to submit"* long before the code under test — and
every check passed with the fix reverted. It now builds a real approved target
and asserts `draft` flips to 0, which is the proof the route got there. Falsify
every repair: if reverting it does not fail the suite, the suite is not testing it.

**Measure the vacuity; do not hide it.** `test_data_integrity` reports how many
of its 17 checks returned a non-zero count and names the ones that did not, with a
floor. A check that inspects nothing is indistinguishable from one that passed —
`all()` of an empty sequence is True — so "7 of 17 exercised" is a number on the
screen that cannot silently drop. A floor rather than an equality, because a real
database exercises more than the fixture and improving the fixture must not mean
editing the test.

**Record a baseline before asserting a change.** Several routes answer 302 or 403
on their own merits against a stale database, so "still 404" reads as a pass.
Record first, then assert *changed* where intended and *unchanged* everywhere
else.

## Two traps these suites have already hit

- **Every write needs the CSRF token in the form, not just the session.** Without
  it the app answers `400` with an empty body long before whatever gate the test
  meant to exercise, and the test passes having proven nothing.
- **A GET-only route answers `405` from Flask's routing, before any gate runs.**
  Probing writes needs endpoints that genuinely accept POST — see `WRITE` in
  `test_module_gate.py`.

And one the runner itself hit: piping a suite to `grep` hands you **grep's** exit
status, so `run.sh` reported *ALL SUITES PASSED* while every suite failed to
start. It captures Python's status directly now.
