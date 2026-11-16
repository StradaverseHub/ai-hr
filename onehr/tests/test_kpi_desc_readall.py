"""A clamped KPI description always has a way to read the rest (Chris, 2026-11-04: the admin person page's KPI tables and
the calibration KPI report cut a description at 2 lines with no Read all).

What this suite holds:
  * no template draws a clamped `kpi-desc` element without `data-kpi-read` (the hook static/kpi_line.js enhances into the
    same Read all the check-in has); the old `kpi-desc-static` class (no way to read on) is gone
  * kpi_line.js has ONE cut-check (`cut`) used by desc() and by enhance(), and enhance runs at load and on fragments
  * the guard is falsified: a planted bad line is caught
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A clamped KPI description always has Read all")
ROOT = H.REPO


def read(rel):
    return open(os.path.join(ROOT, rel), encoding="utf-8").read()


TAG = re.compile(r"<[a-zA-Z][^<>]*?\bclass=\"([^\"]*)\"[^<>]*>", re.S)


def offenders(src):
    """tags whose class list holds the token kpi-desc but whose attributes lack data-kpi-read"""
    bad = []
    for m in re.finditer(r"<[a-zA-Z][^>]*>", src, re.S):
        tag = m.group(0)
        c = re.search(r"\bclass=\"([^\"]*)\"", tag)
        if c and "kpi-desc" in c.group(1).split() and "data-kpi-read" not in tag:
            bad.append(tag[:80])
    return bad


s.section("templates")
bad, seen = [], []
for dirpath, _d, files in os.walk(os.path.join(ROOT, "templates")):
    for f in files:
        if f.endswith(".html"):
            rel = os.path.relpath(os.path.join(dirpath, f), ROOT)
            src = read(rel)
            if re.search(r"class=\"[^\"]*\bkpi-desc\b", src):
                seen.append(rel)
            bad += ["%s: %s" % (rel, t) for t in offenders(src)]
s.check("no template draws a clamped kpi-desc without data-kpi-read", not bad, bad)
s.check("...and the two tables that used to lack it use the hook",
        "templates/person/_performance.html" in seen and "templates/_calib_report_kpi.html" in seen, seen)
css = read("static/style.css")
s.check("the no-way-to-read class kpi-desc-static is gone", "kpi-desc-static" not in css
        and not any("kpi-desc-static" in read(r) for r in seen))

s.section("the one cut-check")
kl = read("static/kpi_line.js")
s.check("desc() and enhance() both wrap through cut()",
        kl.count("onehrKpiLine.cut(") + kl.count("K.cut(") >= 2 and "enhance: function (root)" in kl
        and "d.scrollHeight > d.clientHeight + 1" in kl and kl.count("d.scrollHeight > d.clientHeight + 1") == 1)
s.check("enhance runs once per element, at load and for fragments fetched later",
        "data-kpi-read-done" in kl and "MutationObserver" in kl and "DOMContentLoaded" in kl)

s.section("falsify the guard")
planted = '<div class="rv-kpi-desc kpi-desc kpi-desc-static">x</div>'
s.check("a planted clamped description with no hook is caught", len(offenders(planted)) == 1)
s.check("...and the hooked one passes", offenders(planted.replace("kpi-desc-static", "kpi-desc-x").replace(
    'class="rv-kpi-desc kpi-desc', 'data-kpi-read class="rv-kpi-desc kpi-desc')) == [])

sys.exit(s.done())
