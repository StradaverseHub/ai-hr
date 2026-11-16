"""Mechanism B's achievement % (Chris, 2026-11-01, the Signature scale audit, tier T4).

What this suite holds:
  * a score is never below 0%: lower is better used to go negative once the actual passed 2 x target (Signature's FCO
    resubmission rate, threshold 15, target 5: 12.5 scored -50%)
  * a NEGATIVE target (a loss; Signature Manufacturing PAT, more, threshold -1200, target -343, excellence 0) reads
    the other way round: -343 = 100%, break-even = 200%, -686 = 0%, a worse loss floors at 0, and the zero-gate stays
  * a positive target scores EXACTLY as before wherever the old value was 0 or more (a grid, both methods, both variants,
    multiple 0 / 100 / 200)
  * pm_scale_error refuses an excellence whose cap scores under 100% (and nothing else new)
  * the three JS previews (the journey chat, My KPIs, the manager's team-member page) and the as-you-type check
    (kpi_scale.js) give what the server gives, run in node on the real source
  * every guard falsified: the same function with the guard cut out gives the old, wrong answer
Self-contained: no database rows are written.
"""
import inspect
import json
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Mechanism B achievement % -- never below 0, a negative target reads the other way, excellence at or beyond target")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE, EXC = a.pm_pct_mechanism_b_base, a.pm_pct_mechanism_b_excellence


def near(x, y):
    return abs(x - y) < 1e-6


# The code as it was before this change, kept here as the reference for "positive targets score exactly as before".
def old_base(actual, method, threshold, target, multiple):
    if method == "more":
        if actual <= threshold:
            return 0.0
        raw = actual / target * 100
    else:
        if actual >= threshold:
            return 0.0
        raw = (1 + (1 - actual / target)) * 100
    if raw <= 100:
        return raw
    return 100 + (raw - 100) * (multiple / 100)


def old_exc(actual, method, threshold, target, excellence):
    if method == "more":
        if actual <= threshold:
            return 0.0
        raw = actual / target * 100
        cap = excellence / target * 100
    else:
        if actual >= threshold:
            return 0.0
        raw = (1 + (1 - actual / target)) * 100
        cap = (1 + (1 - excellence / target)) * 100
    return min(raw, cap)


# ----------------------------------------------------------------------------------------------------------------
s.section("never below 0%: lower is better, a threshold above 2 x target")
s.check("FCO resubmission rate (less, thr 15, tgt 5, exc 2): 12.5 scores 0, it was -50",
        EXC(12.5, "less", 15, 5, 2) == 0.0 and near(old_exc(12.5, "less", 15, 5, 2), -50.0))
s.check("...10 is exactly 2 x target: 0; 14.9 floors at 0; 5 = 100; 2 = the cap 160",
        EXC(10, "less", 15, 5, 2) == 0.0 and EXC(14.9, "less", 15, 5, 2) == 0.0 and near(EXC(5, "less", 15, 5, 2), 100)
        and near(EXC(2, "less", 15, 5, 2), 160))
s.check("...15 (the threshold itself) is still the zero-gate", EXC(15, "less", 15, 5, 2) == 0.0)
s.check("LTI (less, thr 6, tgt 1, exc 0): 5.9 was far below 0, now 0; 1 = 100; 0 = 200",
        old_exc(5.9, "less", 6, 1, 0) < -300 and EXC(5.9, "less", 6, 1, 0) == 0.0 and near(EXC(1, "less", 6, 1, 0), 100)
        and near(EXC(0, "less", 6, 1, 0), 200))
s.check("the base variant floors too (less, thr 15, tgt 5, multiple 100): 12.5 -> 0",
        BASE(12.5, "less", 15, 5, 100) == 0.0 and old_base(12.5, "less", 15, 5, 100) < 0)
s.check("a floored score is a plain 0.0, never -0.0", str(BASE(12.5, "less", 15, 5, 0)) == "0.0"
        and str(EXC(10, "less", 15, 5, 2)) == "0.0")

# ----------------------------------------------------------------------------------------------------------------
s.section("a negative target (a loss): Signature Manufacturing PAT, more, threshold -1200, target -343, excellence 0")
P = lambda x: EXC(x, "more", -1200, -343, 0)   # noqa: E731
s.check("-343 (on target) = 100%", near(P(-343), 100))
s.check("0 (break-even) = 200%, the excellence cap", near(P(0), 200))
s.check("a profit of 500 is held at the cap, 200%", near(P(500), 200))
s.check("-686 (twice the target loss) = 0%", near(P(-686), 0))
s.check("-1000 floors at 0 (the formula says -91%)", P(-1000) == 0.0)
s.check("-1200 and worse: the zero-gate", P(-1200) == 0.0 and P(-1212) == 0.0)
s.check("a better result never scores less than a worse one (-1100 .. 0, step 50)",
        all(P(x) <= P(x + 50) + 1e-9 for x in range(-1100, 0, 50)))
s.check("the old code gave PAT nothing: every loss scored 0 (the cap -0%), on-target -343 and break-even alike, and a profit below 0",
        all(abs(old_exc(x, "more", -1200, -343, 0)) < 1e-9 for x in (-1100, -686, -343, -100, 0)) and old_exc(400, "more", -1200, -343, 0) < 0)
s.check("...and, ratio only, it read the loss the wrong way round: a worse -1000 scored above -343 (291 vs 100)",
        near(old_base(-1000, "more", -1200, -343, 100), 1000 / 343 * 100) and near(old_base(-343, "more", -1200, -343, 100), 100))
s.check("the base variant reads it the same way (more, thr -1200, tgt -343, multiple 100): 0 = 200%, -343 = 100%",
        near(BASE(0, "more", -1200, -343, 100), 200) and near(BASE(-343, "more", -1200, -343, 100), 100)
        and near(BASE(0, "more", -1200, -343, 0), 100))
s.section("a negative target, lower is better (the plain ratio)")
s.check("less, thr -2, tgt -5, exc -10: -5 = 100%, -10 = 200%, -8 = 160%, -2 is the gate",
        near(EXC(-5, "less", -2, -5, -10), 100) and near(EXC(-10, "less", -2, -5, -10), 200)
        and near(EXC(-8, "less", -2, -5, -10), 160) and EXC(-2, "less", -2, -5, -10) == 0.0
        and near(EXC(-20, "less", -2, -5, -10), 200))
s.check("...and the base variant, multiple 100: -10 = 200%", near(BASE(-10, "less", -2, -5, 100), 200))

# ----------------------------------------------------------------------------------------------------------------
s.section("a positive target scores exactly as before wherever the old value was 0 or more")
grid = {"more": [(-5, 10, 12), (0, 10, 12), (50, 100, 120), (80, 100, 150), (1, 5, 5), (10, 100, 100)],
        "less": [(15, 5, 2), (6, 1, 0), (40, 12, 4), (30, 8, 4), (200, 100, 50), (120, 100, 100)]}
same = diff = floored = checked = 0
bad_pts = []
for method, trips in grid.items():
    for thr, tgt, exc in trips:
        lo, hi = (thr, tgt * 3) if method == "more" else (-tgt, thr)
        for k in range(0, 61):
            x = round(lo + (hi - lo) * k / 60.0, 4)
            for mult in (0, 100, 200):
                n, o = BASE(x, method, thr, tgt, mult), old_base(x, method, thr, tgt, mult)
                checked += 1
                if o >= 0:
                    same += (n == o)
                    if n != o:
                        bad_pts.append(("base", method, thr, tgt, mult, x, n, o))
                else:
                    floored += (n == 0.0)
                    diff += 1
            n, o = EXC(x, method, thr, tgt, exc), old_exc(x, method, thr, tgt, exc)
            checked += 1
            if o >= 0:
                same += (n == o)
                if n != o:
                    bad_pts.append(("exc", method, thr, tgt, exc, x, n, o))
            else:
                floored += (n == 0.0)
                diff += 1
s.check("no positive-target point whose old value was >= 0 changed (%d points checked)" % checked, not bad_pts, str(bad_pts[:3]))
s.check("every point whose old value was below 0 now scores 0 (%d of them)" % diff, diff > 0 and floored == diff)

# ----------------------------------------------------------------------------------------------------------------
s.section("pm_scale_error: the excellence sits at or beyond the target")
CFG_X = {"mechanism": "B", "variant": "excellence", "business_group": "ZZ"}
CFG_M = {"mechanism": "B", "variant": "base", "business_group": "ZZ"}
E = a.pm_scale_error


def B(thr, tgt, exc, **k):
    return dict(threshold=thr, target=tgt, excellence=exc, **k)


s.check("more, target 100, excellence 120 / 100: fine", E(CFG_X, "more", B(80, 100, 120)) is None
        and E(CFG_X, "more", B(80, 100, 100)) is None)
s.check("more, excellence 90 under the target 100: refused, in the plain voice",
        "excellence must be at or beyond the target" in (E(CFG_X, "more", B(80, 100, 90)) or "")
        and "higher is better" in (E(CFG_X, "more", B(80, 100, 90)) or ""))
s.check("less, target 5, excellence 2 fine; excellence 7 refused, saying lower is better",
        E(CFG_X, "less", B(15, 5, 2)) is None and "lower is better" in (E(CFG_X, "less", B(15, 5, 7)) or ""))
s.check("a negative target: PAT (-1200 / -343 / 0) is fine; an excellence of -400 (worse than -343) is refused",
        E(CFG_X, "more", B(-1200, -343, 0)) is None and "excellence must be at or beyond" in
        (E(CFG_X, "more", B(-1200, -343, -400)) or ""))
s.check("the message names the KPI like the others", (E(CFG_X, "more", B(80, 100, 90), "Margin") or "").startswith("'Margin': "))
s.check("no excellence yet: the caller's own completeness check (None)", E(CFG_X, "more", B(80, 100, None)) is None)
s.check("a base-variant group is not asked for an excellence", E(CFG_M, "more", B(80, 100, 90)) is None)
s.check("nothing else new: a Mechanism A group and the earlier messages are as they were",
        E({"mechanism": "A", "variant": None}, "more", {"rate%d" % i: i for i in range(1, 6)}) is None
        and "target can't be 0" in (E(CFG_X, "more", B(80, 0, 120)) or "")
        and "below the target" in (E(CFG_X, "more", B(100, 100, 120)) or ""))
import sqlite3
db = sqlite3.connect(":memory:")
db.row_factory = sqlite3.Row
row = db.execute("SELECT 80.0 AS threshold, 100.0 AS target, 90.0 AS excellence").fetchone()
s.check("...a row with an excellence under the target is refused", "excellence must be at or beyond" in (E(CFG_X, "more", row) or ""))
row2 = db.execute("SELECT 80.0 AS threshold, 100.0 AS target").fetchone()
s.check("...a row with no excellence column is left alone", E(CFG_X, "more", row2) is None)

# ----------------------------------------------------------------------------------------------------------------
s.section("falsified: each guard cut out gives the old, wrong answer (so these checks can fail)")


def mutate(fn, old_text, new_text):
    src = inspect.getsource(fn)
    assert old_text in src, "mutation target is gone: " + old_text
    ns = dict(vars(a))
    exec(compile(src.replace(old_text, new_text), "mutant", "exec"), ns)
    return ns[fn.__name__]


m_floor = mutate(a.pm_pct_mechanism_b_base, "if raw <= 0:", "if False:")
s.check("without the base floor, 12.5 scores -50", near(m_floor(12.5, "less", 15, 5, 0), -50.0))
m_floor_x = mutate(a.pm_pct_mechanism_b_excellence, "return out if out > 0 else 0.0", "return out")
s.check("without the excellence floor, 12.5 scores -50 and PAT -1000 scores -91", near(m_floor_x(12.5, "less", 15, 5, 2), -50.0)
        and m_floor_x(-1000, "more", -1200, -343, 0) < -90)
m_flip = mutate(a.pm_pct_b_transform, '(method != "more") != (target < 0)', '(method != "more")')
ns_flip = dict(vars(a))
ns_flip["pm_pct_b_transform"] = m_flip
exec(compile(inspect.getsource(a.pm_pct_mechanism_b_excellence), "mutant", "exec"), ns_flip)
s.check("without the negative-target flip, PAT on target scores 0 (not 100) and break-even scores 0 (not 200)",
        near(ns_flip["pm_pct_mechanism_b_excellence"](-343, "more", -1200, -343, 0), 0)
        and near(ns_flip["pm_pct_mechanism_b_excellence"](0, "more", -1200, -343, 0), 0))
m_err = mutate(a.pm_scale_error, 'if cfg["variant"] == "excellence":', "if False:")
s.check("without the excellence guard, excellence 90 under target 100 is accepted", m_err(CFG_X, "more", B(80, 100, 90)) is None)
s.check("...and the real function refuses it", E(CFG_X, "more", B(80, 100, 90)) is not None)

# ----------------------------------------------------------------------------------------------------------------
s.section("the JS previews give what the server gives (node, the real source)")
node = shutil.which("node")


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def slice_(src, start, end):
    i = src.index(start)
    return src[i:src.index(end, i)]


CASES = []   # (method, thr, tgt, mult, exc, x)
for method, thr, tgt, mult, exc in [("more", -1200, -343, None, 0), ("less", 15, 5, None, 2), ("less", 6, 1, None, 0),
                                    ("more", 80, 100, None, 120), ("less", -2, -5, None, -10),
                                    ("more", 80, 100, 100, None), ("less", 15, 5, 100, None), ("more", -1200, -343, 100, None),
                                    ("less", 120, 100, 200, None), ("more", 50, 100, 0, None)]:
    lo, hi = min(thr, tgt * 3, 0), max(thr, tgt * 3, tgt * -1, 20)
    for k in range(0, 41):
        CASES.append((method, thr, tgt, mult, exc, round(lo + (hi - lo) * k / 40.0, 3)))


def py_pct(c):
    method, thr, tgt, mult, exc, x = c
    return EXC(x, method, thr, tgt, exc) if exc is not None else BASE(x, method, thr, tgt, mult or 0)


if not node:
    s.check("node is available to run the previews", False)
else:
    cases_js = json.dumps(CASES)
    # My KPIs and the manager's team-member page: computeMechanismB(actual, method, threshold, target, multiple, excellence)
    for rel in ("templates/performance_my.html", "templates/performance_team_member.html"):
        fn = slice_(read(rel), "function computeMechanismB(", "function csrfToken(")
        prog = fn + "\nvar C=%s;console.log(JSON.stringify(C.map(function(c){return computeMechanismB(c[5],c[0],c[1],c[2],c[3]===null?0:c[3],c[4]);})));" % cases_js
        r = subprocess.run([node, "-e", prog], capture_output=True, text=True, timeout=30)
        try:
            got = json.loads(r.stdout)
        except Exception:
            got = []
        ok = len(got) == len(CASES) and all(near(g, py_pct(c)) for g, c in zip(got, CASES))
        s.check("%s: computeMechanismB equals the server on %d points" % (rel.split("/")[-1], len(CASES)), ok, r.stdout[:200] + r.stderr[:300])
        s.check("...and never returns below 0", ok and min(got) >= 0)
    # the journey chat: kpiPctForValueB(line, rawString) with the scale_b rows
    fn = slice_(read("static/journey_chat.js"), "function kpiPctForValueB(", "// Band code for a Mech-B")
    prog = fn + ("\nvar C=%s;console.log(JSON.stringify(C.map(function(c){var sb=[{label:'Threshold',raw:c[1]},{label:'Target',raw:c[2]}];"
                 "if(c[4]!==null)sb.push({label:'Excellence',raw:c[4]});else sb.push({label:'Multiplier',raw:c[3]});"
                 "return kpiPctForValueB({method:c[0],scale_b:sb},String(c[5]));})));") % cases_js
    r = subprocess.run([node, "-e", prog], capture_output=True, text=True, timeout=30)
    try:
        got = json.loads(r.stdout)
    except Exception:
        got = []
    s.check("journey_chat.js: kpiPctForValueB equals the server on %d points" % len(CASES),
            len(got) == len(CASES) and all(g is not None and near(g, py_pct(c)) for g, c in zip(got, CASES)), r.stdout[:200] + r.stderr[:300])
    # falsified: the old JS (no flip, no floor) differs on the PAT and floor points
    fn_old = fn.replace('(l.method !== "more") !== (target < 0)', '(l.method !== "more")').replace("return out > 0 ? out : 0;", "return out;")
    prog_old = prog.replace(fn, fn_old)
    r2 = subprocess.run([node, "-e", prog_old], capture_output=True, text=True, timeout=30)
    try:
        got2 = json.loads(r2.stdout)
    except Exception:
        got2 = []
    s.check("falsified: the old JS (no flip, no floor) disagrees with the server on some points",
            len(got2) == len(CASES) and any(not near(g, py_pct(c)) for g, c in zip(got2, CASES)))
    # kpi_scale.js: problem(form) on a stub form
    ks = read("static/kpi_scale.js")
    body = slice_(ks, "  function num(el) {", "  function check(f) {")
    stub = ("var window={};var document={addEventListener:function(){}};"
            "function mkForm(method,vals){var els={};Object.keys(vals).forEach(function(k){els[k]={value:String(vals[k])};});"
            "els.method={value:method};return {getAttribute:function(){return 'B';},"
            "querySelector:function(sel){var m=/name=\"([^\"]+)\"/.exec(sel);return m&&els[m[1]]?els[m[1]]:null;}};}\n")
    prog = stub + body + ("\nvar out=[];function t(m,v){var p=problem(mkForm(m,v));out.push(p?p[1]:null);}"
                          "t('more',{threshold:80,target:100,excellence:120});t('more',{threshold:80,target:100,excellence:90});"
                          "t('less',{threshold:15,target:5,excellence:7});t('more',{threshold:-1200,target:-343,excellence:0});"
                          "t('more',{threshold:-1200,target:-343,excellence:-400});t('more',{threshold:80,target:100});"
                          "console.log(JSON.stringify(out));")
    r = subprocess.run([node, "-e", prog], capture_output=True, text=True, timeout=30)
    try:
        o = json.loads(r.stdout)
    except Exception:
        o = []
    want = [E(CFG_X, "more", B(80, 100, 120)), E(CFG_X, "more", B(80, 100, 90)), E(CFG_X, "less", B(15, 5, 7)),
            E(CFG_X, "more", B(-1200, -343, 0)), E(CFG_X, "more", B(-1200, -343, -400)), None]
    s.check("kpi_scale.js says the same, in the same words, as pm_scale_error on six scales",
            len(o) == 6 and o == want, "%s | %s" % (o, want))
    prog_old = prog.replace("if (cap < 100 - 1e-9)", "if (false)")
    r3 = subprocess.run([node, "-e", prog_old], capture_output=True, text=True, timeout=30)
    s.check("falsified: with the JS guard cut out, the excellence-90 scale is let through", r3.stdout.strip() != r.stdout.strip()
            and json.loads(r3.stdout)[1] is None)

sys.exit(s.done())
