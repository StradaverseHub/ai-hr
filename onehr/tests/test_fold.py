"""Folds: "N more" opens in place, Show less at the end of the list closes it (Chris, 2026-10-19: "after clicking the
'12 more' or '+3', it will list down the item, then at the bottom of the list, show button to minimize it, apply to all
screens with this sort of expansion"), and side-by-side cards start level ("the left panel and the content card boxes
are not aligned").

What this suite holds:
  * every <details> in a template whose summary offers "more" is a fold: class "fold" and a Show less
    (data-fold-less) inside it, after its items; the summary hides while it is open; static/fold.js (in every page's
    head) closes it
  * the script-built lists: the calibration "+N more KPIs" toggles to Show less under the list; the journey's other
    "+N more" buttons do already; the Talent Box's two pagers and the dashboard's What you led list fold back to their
    first page
  * the stacked-card gap (.admin-card + .admin-card) is lifted where cards sit side by side
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Folds open in place and close from the end; side-by-side cards start level")
ROOT = H.REPO


def read(rel):
    return open(os.path.join(ROOT, rel), encoding="utf-8").read()


s.section("templates")
found, bad = [], []
for dirpath, _d, files in os.walk(os.path.join(ROOT, "templates")):
    for f in files:
        if not f.endswith(".html"):
            continue
        rel = os.path.relpath(os.path.join(dirpath, f), ROOT)
        src = read(rel)
        for m in re.finditer(r"<details\b([^>]*)>\s*<summary[^>]*>(.*?)</summary>", src, re.S):
            text = re.sub(r"<[^>]+>", " ", m.group(2))
            if not re.search(r"\bmore\b", text, re.I):
                continue
            found.append(rel)
            body = src[m.end():src.find("</details>", m.end())]
            if "fold" not in m.group(1).split('class="', 1)[-1].split('"')[0].split() or "data-fold-less" not in body:
                bad.append("%s: %s" % (rel, " ".join(text.split())[:60]))
s.check("every '... more' fold in a template is a fold with Show less at its end (%d found)" % len(found),
        len(found) >= 5 and not bad, bad)
s.check("...the KPI library's job families and the journey queue among them",
        "templates/admin_kpi_library.html" in found and "templates/_journey_nav.html" in found)
css = read("static/style.css")
s.check("the summary hides while a fold is open", "details.fold[open] > summary { display: none; }" in css)
fj = read("static/fold.js")
s.check("static/fold.js closes it, in every page's head", "[data-fold-less]" in fj and "d.open = false" in fj
        and "filename='fold.js'" in read("templates/base.html").split("</head>")[0])

s.section("script-built lists")
jc = read("static/journey_chat.js")
i = jc.index('" more KPI"')
s.check("the calibration '+N more KPIs' toggles to Show less under the list", 'more.textContent = open ? "Show less"'
        in jc[i:i + 900] and "more.remove()" not in jc[i:i + 900])
sw = jc[jc.index("function swMoreBtn"):]
s.check("...as the journey's other '+N more' buttons already do", '"Show less"' in sw[:600])
s.check("the Talent Box's two pagers fold back to their first page", "tb.dmax = 60; tbPaintPeople" in jc
        and "tb.lmax = 100; tbPaintList" in jc)
s.check("...and the dashboard's What you led list", "led.shown = 50; draw(); });\n        more.appendChild(lb)"
        in read("static/dashboard.js"))

s.section("side-by-side cards")
s.check("the stacked-card gap is lifted where cards sit side by side (the libraries, Notification emails)",
        ".kl-grid > .admin-card, .ne-grid > .admin-card" in css and "margin-top: 0" in css.split(
            ".kl-grid > .admin-card, .ne-grid > .admin-card")[1][:80])

sys.exit(s.done())
