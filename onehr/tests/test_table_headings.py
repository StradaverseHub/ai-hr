"""Admin table headings stay on one line (Chris, 2026-10-23: "shorten it to like W for Weight, so the header stay
thinnest possible, check for other table with such instance too", then "can we also cover those inside a closed side
panel?"). A sweep of every admin page and side panel at 1280 found 25 tables whose headings wrapped and none in panels;
headings now don't wrap, and the six tables that would then overflow say a heading shorter, the full words on hover.

What this suite holds:
  * the one-line rule for admin tables' headings, and the tighter padding of the 8-column stage and report tables
  * HEAD_SHORT: a short heading carries its full words as the heading's title (the on-screen report, the assessor
    extremes, the curves)
  * a heading whose only words are for a screen reader gets no column menu (the "O P E N" fix), and the list panel's
    Open column has none
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Admin table headings: one line, a short word with the full words on hover")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
C = H.client_as(a, SU["id"])
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
css = open(os.path.join(ROOT, "static", "style.css"), encoding="utf-8").read()
js = open(os.path.join(ROOT, "static", "admin.js"), encoding="utf-8").read()

s.section("the rule")
s.check("admin tables' headings don't wrap", ".adm-main table thead th, .adm-main table thead th .cm-label { white-space: "
        "nowrap; }" in css)
s.check("the 8-column stage and report tables take less side padding", ".adm-stage-table th, .adm-stage-table td, "
        ".rptv-table th, .rptv-table td { padding-left: 8px; padding-right: 8px; }" in css)
s.check("a heading with only screen-reader words gets no column menu", 'seen.querySelectorAll(".sr-only")' in js
        and "if (!txt(seen) ||" in js)

s.section("short headings say their full words")
s.check("HEAD_SHORT is the templates' one list", a.app.jinja_env.globals.get("head_short") is a.HEAD_SHORT
        and a.HEAD_SHORT.get("No competencies") == "Unassigned")
rp = C.get("/admin/reports/all/tc-status").get_data(as_text=True)
s.check("the on-screen report: Unassigned and With LM, the full words on hover", 'title="No competencies">Unassigned</th>'
        in rp and 'title="With manager">With LM</th>' in rp)
ex = C.get("/admin/assessor-extremes").get_data(as_text=True)
s.check("the assessor extremes: ID, Employee ID on hover", '<th title="Employee ID" data-full="Employee ID">ID</th>' in ex)
cv = open(os.path.join(ROOT, "templates", "admin_pat_ref.html"), encoding="utf-8").read()
s.check("the reference curves: band codes, their names on hover", 'title="{{ label_names[b] }}">{{ b }}</th>' in cv)
lp = open(os.path.join(ROOT, "templates", "_people_list_panel.html"), encoding="utf-8").read()
s.check("the list panel's Open column has no heading words", '<th aria-label="Open"></th>' in lp
        and '<span class="sr-only">Open</span>' not in lp)

sys.exit(s.done())
