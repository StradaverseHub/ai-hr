#!/usr/bin/env python3
"""Pick the suites a change can affect (suite speed plan 2026-11-06, Change 2). Run through tests/affected.sh.

The change = the working tree (committed + uncommitted + untracked tests/test_*.py) against the merge-base with
origin/feature/staging-environment; `<base>` overrides the base; `--commit <sha>` = that commit's own diff (for replay).
Picks, each with its reason:
  (a) the impact map (~/Library/Caches/onehr-impact/map.json, built daily at 12:00 by tests/impact_map.sh): each changed top-level
      def -> the suites that ran it; a changed module-level name -> every def that reads it -> their suites; a changed
      template -> the suites that loaded it;
  (b) a grep fallback for what the map cannot see: suites whose text names a changed def that is not in the map, a changed
      module-level name, or a changed template / static / other file's basename;
  (c) tests/always_run.txt, the whole-file lint suites;
  (d) changed or new tests/test_*.py themselves.
FULL SUITE instead when the change touches tests/harness.py, tests/run.sh, tests/run_parallel.sh, requirements.txt, the
SCHEMA assignment, _ensure_runtime_schema, or any "core" def (one that >= 60% of the suites run).
Standard library only. `--emit FILE` writes "FULL" or "PICK" and then the suite names, for tests/affected.sh.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import impact_lib  # noqa: E402

BASE_REF = "origin/feature/staging-environment"
FULL_FILES = ("tests/harness.py", "tests/run.sh", "tests/run_parallel.sh", "requirements.txt")
SCHEMA_NAMES = {"SCHEMA"}
SCHEMA_DEFS = {"_ensure_runtime_schema"}
DEFAULT_SECONDS = 5
SKIP_EXT = (".md", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".pdf", ".txt")   # docs and images name nothing a suite runs


def git(*args):
    r = subprocess.run(["git", "-C", REPO] + list(args), capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout if r.returncode == 0 else None


def ranges(base, head, path):
    """(old line ranges removed, new line ranges added) from the -U0 hunks. A pure deletion has no new range: the lines
    it removed are found on the old side."""
    cmd = ["diff", "-U0", "--no-renames", base] + ([head] if head else []) + ["--", path]
    out = git(*cmd) or ""
    old, new = [], []
    for m in re.finditer(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", out, re.M):
        a, b = int(m.group(1)), int(m.group(2)) if m.group(2) is not None else 1
        c, d = int(m.group(3)), int(m.group(4)) if m.group(4) is not None else 1
        if b > 0:
            old.append((a, a + b - 1))
        if d > 0:
            new.append((c, c + d - 1))
    return old, new


def touched(source, rngs):
    """-> (def keys touched, module-level names assigned, {key: node}) for the hunk ranges in this version of a file."""
    tree, defs, nodes = impact_lib.parse(source)
    keys, names = set(), set()
    for lo, hi in rngs:
        keys |= {d.key for d in impact_lib.defs_touching(defs, lo, hi)}
        names |= impact_lib.module_stmt_names(tree, lo, hi)
    return keys, names, nodes


def load_map(path):
    if not os.path.exists(path):
        return None, "map missing: picks are grep + lint only; run tests/impact_map.sh (%s not found)" % path
    try:
        m = json.load(open(path, encoding="utf-8"))
        m["functions"], m["templates"], m["core"]   # noqa: B018 -- the keys must be there
        return m, None
    except (ValueError, KeyError, OSError) as e:
        return None, "map missing: picks are grep + lint only; run tests/impact_map.sh (%s unreadable: %s)" % (path, e)


def map_staleness(mp, funcs, tmap):
    """Judge the map by code, not age. -> (state, behind, hits, ahead_note):
    state "current" (built from the shared branch tip, or nothing it knows changed since), "stale" (a function or template
    it knows changed since; hits lists them) or "unknown" (its commit is not in this repo)."""
    c = str(mp.get("commit") or "").strip()
    tip = (git("rev-parse", "--verify", BASE_REF + "^{commit}") or "").strip()
    if not c or not tip:
        return "unknown", None, [], ""
    full = (git("rev-parse", "--verify", c + "^{commit}") or "").strip()
    if not full:
        return "unknown", None, [], ""
    if full == tip:
        return "current", 0, [], ""
    try:
        behind = int((git("rev-list", "--count", "%s..%s" % (full, tip)) or "0").strip())
    except ValueError:
        behind = 0
    if behind == 0:           # the tip is behind the map's commit: nothing newer than the map on the shared branch
        return "current", 0, [], ""
    hits = []
    for line in (git("diff", "--name-status", "--no-renames", full, tip) or "").splitlines():
        st, _, path = line.partition("\t")
        st = st[:1]
        if path.startswith("templates/"):
            if path[len("templates/"):] in tmap:
                hits.append(path)
            continue
        if not path.endswith(".py") or st == "A":
            continue
        old_src = git("show", "%s:%s" % (full, path)) or ""
        new_src = git("show", "%s:%s" % (tip, path)) if st != "D" else ""
        if st == "D":
            old_r, new_r = [(1, old_src.count("\n") + 1)], []
        else:
            old_r, new_r = ranges(full, tip, path)
        keys, names, nodes_all = set(), set(), {}
        try:
            for src, rg in ((old_src, old_r), (new_src, new_r)):
                if src and rg:
                    k, n, nodes = touched(src, rg)
                    keys |= k
                    names |= n
                    nodes_all.update(nodes)
        except SyntaxError:
            hits.append(path + " (does not parse)")
            continue
        for key in sorted(keys | impact_lib.readers_of(nodes_all, names)):
            if "%s::%s" % (path, key) in funcs:
                hits.append("%s::%s" % (path, key))
    return ("stale" if hits else "current"), behind, hits, ""


def read_times(path):
    t = {}
    try:
        for line in open(path, encoding="utf-8"):
            p = line.rstrip("\n").split("\t")
            if len(p) >= 2 and p[1].isdigit():
                t[p[0]] = int(p[1])
    except OSError:
        pass
    return t


def wall(suites, times, workers=4):
    loads = [0] * workers
    for s in sorted(suites, key=lambda x: -times.get(x, DEFAULT_SECONDS)):
        i = loads.index(min(loads))
        loads[i] += times.get(s, DEFAULT_SECONDS)
    return max(loads)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base", nargs="?")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--commit")
    ap.add_argument("--emit")
    ap.add_argument("--map", default=os.environ.get("ONEHR_IMPACT_MAP") or os.path.expanduser("~/Library/Caches/onehr-impact/map.json"))
    ap.add_argument("--times", default=os.environ.get("ONEHR_SUITE_TIMES") or os.path.expanduser("~/Library/Caches/onehr-tests/suite-times.tsv"))
    a = ap.parse_args()

    # ---- what changed
    head = None
    if a.commit:
        sha = (git("rev-parse", "--verify", a.commit + "^{commit}") or "").strip()
        if not sha:
            raise SystemExit("no such commit: " + a.commit)
        base, head = sha + "^", sha
        label = "commit %s" % sha[:8]
    elif a.base:
        base, label = a.base, "working tree against %s" % a.base
    else:
        base = (git("merge-base", "HEAD", BASE_REF) or "").strip()
        if not base:
            raise SystemExit("no %s to compare with: give a base (tests/affected.sh <base>)" % BASE_REF)
        label = "working tree against the merge-base with %s (%s)" % (BASE_REF, base[:8])
    status = {}
    for line in (git("diff", "--name-status", "--no-renames", base, *([head] if head else [])) or "").splitlines():
        st, _, path = line.partition("\t")
        status[path] = st[0]
    if not head:
        for path in (git("ls-files", "--others", "--exclude-standard") or "").splitlines():
            status.setdefault(path, "A")
    files = sorted(status)

    suites_all = sorted(x[5:-3] for x in os.listdir(HERE) if re.match(r"test_[^/]+\.py$", x))
    suite_set = set(suites_all)
    texts = {}
    for s in suites_all:
        try:
            texts[s] = open(os.path.join(HERE, "test_%s.py" % s), encoding="utf-8", errors="replace").read()
        except OSError:
            texts[s] = ""

    mp, warn = load_map(a.map)
    mapfiles = set((mp or {}).get("files", []))
    funcs = (mp or {}).get("functions", {})
    core = set((mp or {}).get("core", []))
    tmap = (mp or {}).get("templates", {})
    age_note = ""
    if mp:
        age = time.time() - mp.get("built_at_epoch", 0)
        age_note = "map built %s (%s), commit %s, %s suites, %d functions" % (
            mp.get("built_at", "?"), ("%d h old" % (age // 3600)) if age < 2 * 86400 else ("%.1f days old" % (age / 86400)),
            str(mp.get("commit", "?"))[:8], mp.get("suites", "?"), len(funcs))
        state, behind, hits, _ = map_staleness(mp, funcs, tmap)
        if state == "stale":
            shown = ", ".join(h.split("::")[-1] for h in hits[:5]) + (" +%d more" % (len(hits) - 5) if len(hits) > 5 else "")
            warn = ("map is %d commit%s behind %s and %d function(s) or template(s) it knows changed since (%s): "
                    "run tests/impact_map.sh; grep picks are added anyway" % (behind, "" if behind == 1 else "s", BASE_REF, len(hits), shown))
        elif state == "unknown":
            warn = "map's commit %s is not in this repo, so its age in commits is unknown: run tests/impact_map.sh; grep picks are added anyway" % str(mp.get("commit", "?"))[:8]
        elif behind:
            age_note += "; %d commit%s behind the shared branch, but nothing it knows changed: current" % (behind, "" if behind == 1 else "s")

    reasons = {}      # suite -> [reasons]

    def add(suite, why):
        if suite in suite_set:
            r = reasons.setdefault(suite, [])
            if why not in r:
                r.append(why)

    full = []
    changed_defs, changed_names, grep_terms = [], set(), {}   # grep term -> label shown as the reason
    notes = []

    def term(t, label):
        if t and len(t) >= 3:
            grep_terms.setdefault(t, label)

    for path in files:
        st = status[path]
        base_name = os.path.basename(path)
        if path in FULL_FILES:
            full.append("%s changed" % path)
            continue
        if re.match(r"tests/test_[^/]+\.py$", path):
            if st != "D":
                add(base_name[5:-3], "test")
            continue
        if path.endswith(".md"):
            continue
        if path.endswith(".py"):
            new_src = None
            if st != "D":
                if head:
                    new_src = git("show", "%s:%s" % (head, path))
                elif os.path.exists(os.path.join(REPO, path)):
                    new_src = open(os.path.join(REPO, path), encoding="utf-8", errors="replace").read()
            old_src = git("show", "%s:%s" % (base, path)) if st != "A" else None
            old_r, new_r = ranges(base, head, path) if st == "M" else ([], [])
            if st == "A" and new_src:
                new_r = [(1, new_src.count("\n") + 1)]
            if st == "D" and old_src:
                old_r = [(1, old_src.count("\n") + 1)]
            keys, names, nodes_all = set(), set(), {}
            try:
                for src, rg in ((old_src, old_r), (new_src, new_r)):
                    if src and rg:
                        k, n, nodes = touched(src, rg)
                        keys |= k
                        names |= n
                        nodes_all.update(nodes)
            except SyntaxError as e:
                full.append("%s does not parse (%s)" % (path, e.msg))
                continue
            readers = impact_lib.readers_of(nodes_all, names)
            if path == "app.py" and names & SCHEMA_NAMES:
                full.append("the SCHEMA assignment changed")
            if keys & SCHEMA_DEFS:
                full.append("_ensure_runtime_schema changed")
            for key in sorted(keys | readers):
                fk = "%s::%s" % (path, key)
                if fk in core:
                    full.append("core def %s (run by 60%%+ of the suites)" % fk)
                if fk in funcs:
                    why = "map:" + key if key in keys else "map:%s (reads %s)" % (key, "/".join(sorted(names))[:30])
                    for s in funcs[fk]:
                        add(s, why)
                elif key in keys:
                    last = key.split(".")[-1]
                    term(last if len(last) >= 5 else key.split(".")[0], key)
            for n in sorted(names):
                term(n, n)
            changed_defs += ["%s::%s" % (path, k) for k in sorted(keys)]
            changed_names |= names
            if path not in mapfiles and not keys and not names:
                term(os.path.splitext(base_name)[0], base_name)
            continue
        if path.startswith("templates/"):
            rel = path[len("templates/"):]
            for s in tmap.get(rel, []):
                add(s, "tpl:" + rel)
            term(base_name, base_name)
            continue
        if path.endswith(SKIP_EXT):
            continue
        term(base_name, base_name)

    # ---- (b) the grep fallback, one pass over the suites
    if grep_terms:
        rx = re.compile(r"(?<![A-Za-z0-9_])(" + "|".join(re.escape(t) for t in sorted(grep_terms, key=len, reverse=True)) + r")(?![A-Za-z0-9_])")
        for s, body in texts.items():
            for t in sorted(set(m.group(1) for m in rx.finditer(body))):
                add(s, "grep:" + grep_terms[t])

    # ---- (c) the lint suites
    try:
        for line in open(os.path.join(HERE, "always_run.txt"), encoding="utf-8"):
            n = line.strip()
            if n and not n.startswith("#"):
                if n in suite_set:
                    add(n, "lint")
                else:
                    notes.append("always_run.txt names %s, which does not exist" % n)
    except OSError:
        notes.append("tests/always_run.txt is missing: no lint suites added")

    # ---- report
    print("affected.sh: %s; %d file(s) changed" % (label, len(files)))
    if files:
        print("  files: " + ", ".join(files[:8]) + (" (+%d more)" % (len(files) - 8) if len(files) > 8 else ""))
    if changed_defs or changed_names:
        d = ", ".join(x.split("::")[1] for x in changed_defs[:8]) + (" (+%d more)" % (len(changed_defs) - 8) if len(changed_defs) > 8 else "")
        print("  defs (%d): %s" % (len(changed_defs), d or "-"))
        if changed_names:
            print("  module-level names: " + ", ".join(sorted(changed_names)[:8]))
    print("  " + (age_note or "no impact map"))
    if warn:
        print(("  *** " if warn.startswith("map missing") else "  WARNING: ") + warn)
    for n in notes:
        print("  note: " + n)
    times = read_times(a.times)

    def finish(mode, names, line):
        print(line)
        if a.emit:
            with open(a.emit, "w", encoding="utf-8") as h:
                h.write(mode + "\n" + "".join(x + "\n" for x in names))
        return 0

    if full:
        uniq = sorted(set(full))
        print("  FULL SUITE because: " + "; ".join(uniq[:6]) + ("; ..." if len(uniq) > 6 else ""))
        return finish("FULL", [], "result: FULL (%d suites, about %d s of suite time)" % (
            len(suites_all), sum(times.get(s, DEFAULT_SECONDS) for s in suites_all)))
    if not files:
        return finish("PICK", [], "result: nothing changed, nothing to run")
    picks = sorted(reasons)
    secs = sum(times.get(s, DEFAULT_SECONDS) for s in picks)
    kinds = {"map": 0, "grep": 0, "lint": 0, "test": 0}
    for s in picks:
        ks = {r.split(":")[0] for r in reasons[s]}
        kinds["map"] += bool(ks & {"map", "tpl"})
        for k in ("grep", "lint", "test"):
            kinds[k] += k in ks
    print("  picks: %d suites (map/template %d, grep %d, lint %d, changed test %d; a suite can count in several)" % (
        len(picks), kinds["map"], kinds["grep"], kinds["lint"], kinds["test"]))
    for s in picks:
        r = reasons[s]
        rest = [x for x in r if x != "lint"]
        shown = ", ".join(rest[:3]) + (" +%d" % (len(rest) - 3) if len(rest) > 3 else "")
        print("    %-34s %s" % (s, (shown + (" +lint" if "lint" in r and rest else "")) if rest else "lint"))
    return finish("PICK", picks, "result: PICK %d suites, about %d s of suite time, ~%d s at 4 workers" % (
        len(picks), secs, wall(picks, times)))


if __name__ == "__main__":
    sys.exit(main())
