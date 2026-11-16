#!/bin/sh
# Run the OneHR suites. Rebuilds the virtualenv and the scratch copy if they
# are missing, which is the whole point of the tests living in the repo: the
# next /private/tmp cleanup costs a rebuild, not a rewrite.
#
#   tests/run.sh              every suite
#   tests/run.sh timezone     one suite, by name (matches test_<name>.py)
#   tests/run.sh a b c        these suites, in this order (tests/run_parallel.sh gives each batch its list)
#   tests/run.sh --prepare    build the virtualenv only
#   tests/run.sh --claim <claimdir> <listfile>
#                             (6 Nov 2026, Chris's go on the suite speed plan, Change 1A) tests/run_parallel.sh's worker
#                             mode: walk <listfile> (suite names, one a line, in the order to try), claim each with an
#                             atomic `mkdir <claimdir>/<suite>` (the one worker that wins it runs it, the rest skip it),
#                             and stop when nothing is left. Each suite is run exactly as in the normal loop; besides
#                             the usual output it appends `suite<TAB>seconds<TAB>exit code` to <scratch>/times.tsv and
#                             the suite name to <scratch>/order.txt (the order this worker ran: a failure is replayed
#                             with `tests/run.sh a b c`).
#   ONEHR_TEST_VENV=<dir>     use this virtualenv (the parallel batches share one)
#   ONEHR_TEST_PYTHON=<path>  build the virtualenv with this interpreter (e.g. python3.11) and install requirements.txt
#                             exactly (the production pins). It gets its own venv-py<X.Y> beside the default one, so
#                             the default venv other runs use is never touched. Unset = /usr/bin/python3, as before.
#
#   ONEHR_IMPACT_DIR=<dir>    (6 Nov 2026, suite speed plan Change 2) coverage mode, used only by tests/impact_map.sh: each
#                             suite runs under coverage.py, `python -m coverage run --data-file=<dir>/cov/<suite>
#                             --context=<suite> --include='*/harness/*.py' <suite file>`, which records which functions of the
#                             scratch app (and its linked modules) the suite reaches; the harness also writes the templates
#                             it loads to <dir>/tpl/<suite>.txt. Unset = a plain `python <suite file>`, exactly as before.
#                             A suite that starts its own app in a subprocess is measured only in its own process, so what
#                             the subprocess runs is NOT covered: accepted (tests/affected.sh adds grep picks for it).
#
# Never touches the live database. Every suite asserts it is pointed at a
# scratch copy before it does anything.
#
# TWO THINGS THIS SCRIPT GETS RIGHT ON PURPOSE, having got both wrong once:
#   - the repo path contains spaces, so every expansion is quoted and the
#     suite list is walked with `find -print0`, never word-split;
#   - the suite's exit status is captured from PYTHON, not from the tail of a
#     pipeline. Piping to grep hands you grep's status, so a suite that failed
#     to start reported ALL SUITES PASSED.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(dirname "$HERE")
# The real repo's git dir, for the one suite check that reads git history (test_demo_seed's negative control). A ship runs
# the suites on a clean `git archive` copy with no .git, so ship.sh exports it; a local run gets it here when unset
# (6 Nov 2026). Empty = no git reachable: that check is noted as skipped, never passed.
if [ -z "${ONEHR_SOURCE_GIT:-}" ] && [ -e "$REPO/.git" ]; then
  _gc=$(git -C "$REPO" rev-parse --git-common-dir 2>/dev/null || true)
  if [ -n "$_gc" ]; then
    case "$_gc" in /*) ;; *) _gc="$REPO/$_gc" ;; esac
    ONEHR_SOURCE_GIT=$(cd "$_gc" 2>/dev/null && pwd || true)
  fi
fi
[ -z "${ONEHR_SOURCE_GIT:-}" ] || export ONEHR_SOURCE_GIT
# Must match harness.py's own choice: /private/tmp on macOS, /tmp elsewhere.
# Linux has no /private and a CI runner cannot create one.
TMPBASE=/private/tmp
[ -d "$TMPBASE" ] || TMPBASE=/tmp
SCRATCH="$TMPBASE/onehr-tests/$(basename "$REPO")"
# tests/run_parallel.sh derives the same default (keep the two in step).
if [ -n "${ONEHR_TEST_PYTHON:-}" ]; then
  PYVER=$("$ONEHR_TEST_PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
  VENV="${ONEHR_TEST_VENV:-$SCRATCH/venv-py$PYVER}"
else
  VENV="${ONEHR_TEST_VENV:-$SCRATCH/venv}"
fi
PY="$VENV/bin/python"

build_venv() {
  rm -rf "$VENV"
  if [ -n "${ONEHR_TEST_PYTHON:-}" ]; then
    "$ONEHR_TEST_PYTHON" -m venv "$VENV"
    "$VENV/bin/pip" install -q --disable-pip-version-check -r "$REPO/requirements.txt"
    return
  fi
  /usr/bin/python3 -m venv "$VENV"
  # reportlab at requirements.txt's pin: 5.1.0 (2026-10-22) refuses this Mac's Python 3.9 at import, and an unpinned
  # install took every suite down with it
  "$VENV/bin/pip" install -q --disable-pip-version-check Flask openpyxl "reportlab==5.0.0" "pypdf==6.21.4"
}

# Run one suite file, output to $2; the exit status is python's own (never a pipeline's).
run_one() {
  if [ -n "${ONEHR_IMPACT_DIR:-}" ]; then
    mkdir -p "$ONEHR_IMPACT_DIR/cov" "$ONEHR_IMPACT_DIR/tpl"
    _n=$(basename "$1" .py); _n=${_n#test_}
    "$PY" -m coverage run --data-file="$ONEHR_IMPACT_DIR/cov/$_n" --context="$_n" --include='*/harness/*.py' "$1" >"$2" 2>&1
  else
    "$PY" "$1" >"$2" 2>&1
  fi
}

mkdir -p "$SCRATCH"
if [ ! -x "$PY" ]; then
  echo "building the virtualenv (first run, or /tmp was cleaned)..."
  build_venv
elif ! "$PY" -c "import flask, openpyxl, reportlab, pypdf${ONEHR_TEST_PYTHON:+, PIL}" 2>/dev/null; then
  # A cleanup can strip a venv's .py files while leaving the directories, which
  # fails as "unknown location" rather than a clean ModuleNotFoundError.
  echo "virtualenv is damaged; rebuilding..."
  build_venv
fi

[ "${1:-}" = "--prepare" ] && exit 0

if [ "${1:-}" = "--claim" ]; then
  [ $# -eq 3 ] || { echo "usage: run.sh --claim <claimdir> <listfile>"; exit 2; }
  CLAIMDIR=$2
  [ -d "$CLAIMDIR" ] || { echo "no claim directory '$CLAIMDIR'"; exit 2; }
  [ -f "$3" ] || { echo "no suite list '$3'"; exit 2; }
  # read the list up front (not with `while read <file`), so no suite can eat the list from stdin
  CLAIMLIST=$(cat "$3")
  rc=0
  passed=0
  failed=0
  OUT="$SCRATCH/last-run.log"
  : > "$OUT"
  : > "$SCRATCH/times.tsv"
  : > "$SCRATCH/order.txt"
  OLDIFS=$IFS
  IFS='
'
  for name in $CLAIMLIST; do
    IFS=$OLDIFS
    # the claim: mkdir is atomic, so of all the workers asking for this suite exactly one gets it
    if mkdir "$CLAIMDIR/$name" 2>/dev/null; then
      suite="$HERE/test_$name.py"
      echo "$name" >> "$SCRATCH/order.txt"
      t0=$(date +%s)
      src=0
      if [ -f "$suite" ]; then
        # the status comes from python itself, never from a pipeline
        run_one "$suite" "$SCRATCH/one.log" || src=$?
      else
        echo "no suite named '$name'" > "$SCRATCH/one.log"; src=2
      fi
      if [ "$src" -eq 0 ]; then
        passed=$((passed + 1))
      else
        failed=$((failed + 1)); rc=1
        echo "SUITE FAILED: $(basename "$suite")" >> "$SCRATCH/one.log"
      fi
      printf '%s\t%s\t%s\n' "$name" "$(( $(date +%s) - t0 ))" "$src" >> "$SCRATCH/times.tsv"
      grep -v 'DeprecationWarning\|warnings.warn' "$SCRATCH/one.log" || true
      cat "$SCRATCH/one.log" >> "$OUT"
    fi
    IFS='
'
  done
  IFS=$OLDIFS
  echo
  echo "---------------------------------------------"
  if [ "$rc" -eq 0 ]; then
    echo "ALL SUITES PASSED  ($passed suite(s))"
  else
    echo "SUITES FAILED  ($failed failed, $passed passed)"
    echo "full output: $OUT"
  fi
  exit "$rc"
fi

if [ $# -gt 0 ]; then
  for name in "$@"; do
    [ -f "$HERE/test_$name.py" ] || { echo "no suite named '$name'"; exit 2; }
  done
  LIST=$(for name in "$@"; do printf '%s\n' "$HERE/test_$name.py"; done)
else
  LIST=$(find "$HERE" -maxdepth 1 -name 'test_*.py' | sort)
fi

rc=0
passed=0
failed=0
OUT="$SCRATCH/last-run.log"
: > "$OUT"
# Newline-separated, so a path containing spaces survives the loop.
OLDIFS=$IFS
IFS='
'
for suite in $LIST; do
  IFS=$OLDIFS
  if run_one "$suite" "$SCRATCH/one.log"; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1)); rc=1
    echo "SUITE FAILED: $(basename "$suite")" >> "$SCRATCH/one.log"
  fi
  grep -v 'DeprecationWarning\|warnings.warn' "$SCRATCH/one.log" || true
  cat "$SCRATCH/one.log" >> "$OUT"
  IFS='
'
done
IFS=$OLDIFS

echo
echo "---------------------------------------------"
if [ "$rc" -eq 0 ]; then
  echo "ALL SUITES PASSED  ($passed suite(s))"
else
  echo "SUITES FAILED  ($failed failed, $passed passed)"
  echo "full output: $OUT"
fi
exit "$rc"
