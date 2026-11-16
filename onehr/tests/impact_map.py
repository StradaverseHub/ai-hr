#!/usr/bin/env python3
"""Build the impact map from one coverage pass of every suite (suite speed plan, Change 2; run by tests/impact_map.sh).

Input: the directory tests/run.sh filled when ONEHR_IMPACT_DIR was set:
    <dir>/cov/<suite>        one coverage.py data file per suite process
    <dir>/tpl/<suite>.txt    the templates that suite loaded (tests/harness.py's hook)
Output (JSON, written atomically; the previous one kept as map.prev.json):
    {ref, commit, built_at, built_at_epoch, suites, suite_names,
     functions: {"app.py::name": [suites]}, templates: {"name.html": [suites]}, core: ["app.py::name", ...], files: [...]}
Keyed by repo-relative file + top-level def name (methods "Class.method"), never line numbers. Function and suite names
only: no personal data. Each scratch source file is parsed ONCE (the first trial re-parsed it per suite: 10 min).
Needs coverage.py (the test venv has it; impact_map.sh installs it there). Exit 3 = too few suites reported, nothing written.
"""
import argparse
import collections
import glob
import hashlib
import json
import os
import re
import shutil
import sys
import time
from bisect import bisect_left

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import impact_lib  # noqa: E402

MYT_OFFSET = 8 * 3600
CORE_FRACTION = 0.6


def build(impact_dir, suite_total, ref, commit, min_fraction):
    import coverage  # noqa: PLC0415
    cov_files = sorted(f for f in glob.glob(os.path.join(impact_dir, "cov", "*"))
                       if not os.path.basename(f).startswith(".") and not f.endswith("-journal"))
    reported = [os.path.basename(f) for f in cov_files]
    print("coverage files: %d of %d suites" % (len(reported), suite_total))
    if suite_total and len(reported) < min_fraction * suite_total:
        print("TOO FEW suites reported coverage (%d of %d, need %.0f%%): the map is not replaced"
              % (len(reported), suite_total, min_fraction * 100))
        return None, 3

    parsed = {}      # basename -> (defs sorted by start, mappable keys)   (parsed once per file)
    pathhash = {}    # scratch path -> content hash, to notice workers whose copy differs
    funcs = collections.defaultdict(set)
    for f in cov_files:
        suite = os.path.basename(f)
        d = coverage.CoverageData(basename=f)
        d.read()
        for p in d.measured_files():
            m = re.search(r"/harness/([A-Za-z0-9_]+\.py)$", p)
            if not m or not os.path.exists(p):
                continue
            name = m.group(1)
            if name not in parsed:
                src = open(p, encoding="utf-8").read()
                pathhash[p] = hashlib.md5(src.encode()).hexdigest()
                _tree, defs, nodes = impact_lib.parse(src)
                parsed[name] = ([x for x in defs if impact_lib.def_is_mappable(x, nodes)], pathhash[p])
            lines = sorted(d.lines(p) or [])
            if not lines:
                continue
            for df in parsed[name][0]:
                i = bisect_left(lines, df.body)
                if i < len(lines) and lines[i] <= df.end:
                    funcs[name + "::" + df.key].add(suite)
    if not parsed:
        print("no scratch source files were found (cleaned already?): the map is not replaced")
        return None, 3

    tpls = collections.defaultdict(set)
    for t in glob.glob(os.path.join(impact_dir, "tpl", "*.txt")):
        suite = os.path.basename(t)[:-4]
        for line in open(t, encoding="utf-8"):
            if line.strip():
                tpls[line.strip()].add(suite)

    n = len(reported)
    core = sorted(k for k, v in funcs.items() if n and len(v) >= CORE_FRACTION * n)
    now = int(time.time())
    out = {
        "ref": ref, "commit": commit,
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S+08:00", time.gmtime(now + MYT_OFFSET)),
        "built_at_epoch": now,
        "suites": n, "suite_names": reported,
        "files": sorted(parsed),
        "functions": {k: sorted(v) for k, v in sorted(funcs.items())},
        "templates": {k: sorted(v) for k, v in sorted(tpls.items())},
        "core": core,
    }
    return out, 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--impact-dir", required=True)
    ap.add_argument("--suites", type=int, required=True, help="how many suites there are (test_*.py)")
    ap.add_argument("--ref", default="")
    ap.add_argument("--commit", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-fraction", type=float, default=0.97)
    a = ap.parse_args()
    out, rc = build(a.impact_dir, a.suites, a.ref, a.commit, a.min_fraction)
    if out is None:
        return rc
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    tmp = a.out + ".%d.tmp" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as h:
        json.dump(out, h)
    if os.path.exists(a.out):
        prev = os.path.join(os.path.dirname(a.out), "map.prev.json")
        shutil.copy2(a.out, prev)   # a copy, so the live map is never missing
    os.replace(tmp, a.out)
    print("map: %d suites, %d functions, %d templates, %d core defs, written to %s"
          % (out["suites"], len(out["functions"]), len(out["templates"]), len(out["core"]), a.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
