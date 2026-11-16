"""The quiet KPI table (Chris, 2026-10-22: "make our KPI table remain the simple look, but more simplistic modern"; he
picked option A of canvas "OneHR KPI Table Refresh", [design canvas link removed], then "can you also
match up with the LM view, HOD view, and the CEO view", then "go ahead").

What this suite holds:
  * one look on the three journey tables that carry .rv-kpi-flat: the employee's check-in, the line manager's
    moderation, the calibrators' person sheet (the HOD's, BU CEO's and BG CEO's)
  * the name stands alone (no Focus tag); a quiet line under it says the Focus, which way is better and a unit-wide
    line's note (onehrKpiLine.meta); the sign-off scorecard and every other table keep the tag
  * the line manager's and the person sheet's payloads carry the direction, in the check-in's own words
  * a rating-scale value sits in a span, so the landed step reads as a pill and their struck step as a dashed one; the
    live glow follows the span
  * the unit inside the result box and the moderate box; Filled / Set by HR as soft pills; the attach button a square
  * the total, the line manager's overall and the final score as a footer bar; the line manager's moderated overall
    keeps updating live through one filler

Source checks and the direction helper; nothing is written.
"""
import inspect
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The quiet KPI table: the check-in, the line manager's moderation, the person sheet")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
JS = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
KL = open(os.path.join(H.REPO, "static", "kpi_line.js"), encoding="utf-8").read()
CSS = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()


def fn(src, name):
    i = src.find("function %s(" % name)
    return src[i:src.index("\n  function ", i + 10)] if i >= 0 else ""


s.section("1. The name and the quiet line under it")
s.check("onehrKpiLine.name takes {tag: false}: the Focus stays out of the name",
        "name: function (el, l, full, opts)" in KL and "if (hasParts && !(opts && opts.tag === false))" in KL)
s.check("onehrKpiLine.meta: the Focus, which way is better, a unit-wide line's note, joined by a middle dot",
        "meta: function (l, full)" in KL and "bits.push(l.focus)" in KL and "bits.push(l.direction)" in KL
        and "the whole unit's figure" in KL and 'm.className = "kpi-meta"' in KL)
for f_, what in (("kpiRowCells", "the check-in"), ("pmKpiRow", "the moderation"), ("calKpiTable", "the person sheet")):
    b = fn(JS, f_)
    s.check("%s: the plain name, then the quiet line" % what, "kpiNameFlat(" in b and "kpiMetaEl(" in b
            and b.find("kpiNameFlat(") < b.find("kpiMetaEl(") < b.find("kpiDescEl("))
s.check("...the sign-off scorecard keeps the Focus tag", "kpiNameEl(" in fn(JS, "scorecardTable")
        and "kpiNameFlat(" not in fn(JS, "scorecardTable"))

s.section("2. The direction in every payload the three tables read")
s.check("_kpi_direction_say: the check-in's own words, empty without a method",
        a._kpi_direction_say({"method": "more"}) == "higher is better"
        and a._kpi_direction_say({"method": "less"}) == "lower is better" and a._kpi_direction_say({}) == "")
s.check("the line manager's moderation lines carry it", '"direction": _kpi_direction_plain(t)'
        in inspect.getsource(a._journey_team_pm_data))
s.check("...and the person sheet's", '"direction": _kpi_direction_plain(t)' in inspect.getsource(a._calib_kpi_table))
s.check("...and the check-in's (as it always has)", '"direction": "higher is better" if t["method"] == "more"'
        in inspect.getsource(a._review_kpi_lines))

s.section("3. The rating scale")
s.check("a value sits in a span (rungVal), on the check-in and on the ladder the moderation and the sheet share",
        "function rungVal(td, v)" in JS and "rungVal(td, byN[n] != null ? byN[n] : DASH)" in fn(JS, "kpiRowCells")
        and "rungVal(c, byN[n] != null ? byN[n] : DASH)" in fn(JS, "pmLadderCells"))
s.check("...the marks stay on the cell, so the live re-mark and the glow still find it",
        'c.className = "rv-rung"' in fn(JS, "pmLadderMark") and "querySelectorAll(\".rv-rung\")" in fn(JS, "kpiLiveMark"))
s.check("the landed step is a band-tinted pill, their struck step a dashed one, the glow on the pill",
        all(('.rv-kpi-flat .rv-scale-hit[data-band="%s"] .rv-rung-v' % b) in CSS for b in ("UA", "BE", "ME", "AE", "OU"))
        and ".rv-kpi-flat .rv-scale-was .rv-rung-v" in CSS and ".rv-kpi-flat .rv-scale-live .rv-rung-v" in CSS
        and ".rv-kpi-flat .rv-rung.rv-scale-hit, .rv-kpi-flat .rv-rung.rv-scale-was { background: none;" in CSS)

s.section("4. Boxes, pills and the button")
mi = fn(JS, "pmModerateInput")
s.check("the moderate box holds its unit, as the check-in's result box does",
        'fld.className = "rv-mod-field"' in mi and "fld.appendChild(val)" in mi and 'un.className = "rv-res-unit"' in mi
        and ".rv-kpi-flat .rv-res-field, .rv-kpi-flat .rv-mod-field {" in CSS)
s.check("...one border on the box, none on the input inside it",
        ".rv-kpi-flat .rv-res-field .rv-res-input, .rv-kpi-flat .rv-mod-field .rv-mod-val { flex: 1;" in CSS
        and "border: 0;" in CSS[CSS.find(".rv-kpi-flat .rv-res-field .rv-res-input, "):][:260])
s.check("Filled by HR and Set by HR are soft pills; the attach button a 36px square",
        ".rv-kpi-flat .rv-res-hr, .rv-kpi-flat .rv-cal-kt-hr {" in CSS and "font-style: normal" in CSS
        and ".rv-kpi-flat .rv-att-add { justify-content: center; width: 36px; height: 36px;" in CSS)
s.check("the headings: small, sentence case, no rule under them",
        ".rv-kpi-flat thead th { text-transform: none; letter-spacing: 0; font-size: 0.75rem;" in CSS)

s.section("5. The footer bar")
pm = fn(JS, "pmReviewWidget")
s.check("the line manager's overall: Overall, theirs -> moderated, the moderated score and its pill",
        'f.className = "rv-mgr-foot rv-kpi-bar"' in pm and '"Overall"' in pm and '" \\u2192 moderated"' in pm
        and "pmModovFill(modov," in pm)
s.check("...and the live update goes through the same filler", "if (ov) pmModovFill(ov, j.mine_preview.value, "
        "j.mine_preview.label);" in fn(JS, "pmModerateDraft"))
s.check("...out of 5 on the ladder only", 'pmCtx && pmCtx.mechA ? " / 5" : ""' in JS)
s.check("the total and the final score: one bar, the label left, the rest right",
        ".rv-kpi-flat .rv-kpi-total-row, .rv-kpi-bar {" in CSS
        and ".rv-kpi-flat .rv-kpi-total-lbl, .rv-kpi-bar-lbl { margin-right: auto;" in CSS)

sys.exit(s.done())
