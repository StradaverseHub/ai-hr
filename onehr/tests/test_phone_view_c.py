"""The phone view, piece C (Chris, "ok, apply the new changes and proceed", 2026-11-07; canvas v16 boards C1, C2, C3 and the BU CEO / BG CEO columns of C4;
OneHR/Phone view C build brief 2026-11-07.md): under 1024px wide the BU CEO's (and a calibrator's) calibration curve, the BG CEO's (and the Group Chief's)
Talent Box with its business-unit drop-down, the Move sheet, and the two leaders' person pages have their phone layout; 1024px and up is the desktop, untouched.

What this suite holds (each check is proved once on a source with the piece taken out, so none can pass by accident):
  * ONE new section after piece B's, `PHONE VIEW, PIECE C`, the last block of static/style.css, inside @media (max-width: 1023.98px), with no rule outside
    the query; tokens and rem only; nothing underlines on hover; no text under 12px at Standard
  * the phone parts are drawn into the SAME markup, each hidden until the phone section shows it (a desktop draws nothing new), or, for a sheet that opens
    on a tap, drawn for a phone when it opens; the script asks window.onehrIsPhone(), never a width of its own, and redraws on window.onehrOnPhoneChange
  * the phone branches call the SAME writers: Save on the BU CEO's page is calMove on the page's own select, the BU drop-down's pick is tbSelectCompany, the
    Move sheet is tbMovePanel (the pop-out's own function) and its save is tbPostMove, the lock is the one lock form; none of the phone helpers posts anything
  * the page never works out a band, category, limit or curve figure: the gap chip and the line under "Your band" are the server's own gap and count, the mini
    3 x 3 is the server's cells, the drop-down's head count and locks are the server's
  * the BU drop-down lists every business unit of today's data (the overview's companies, each with its head count as the left panel gives it)
  * no how-to sentence is drawn on a phone
  * no past talent status reaches the leaders' person pages (the phone page draws none, and the data the BG CEO's page reads carries none)
No real names: the suite database is the synthetic scratch copy.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Phone view, piece C: BU curve, Talent Box, Move sheet and leader person pages")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

SRC = {n: H.source(a, n) for n in ("static/style.css", "static/journey_chat.js", "static/calib_shared.js", "static/move_in.js", "app.py")}
QUERY = "@media (max-width: 1023.98px) {"
MARK_A, MARK_B, MARK_C = "PHONE VIEW, PIECE A", "PHONE VIEW, PIECE B", "PHONE VIEW, PIECE C"
CSS, JS, CS = "static/style.css", "static/journey_chat.js", "static/calib_shared.js"


def phone_c(css):
    i = css.rfind(MARK_C)
    j = css.find("\n/* ===== PHONE VIEW, PIECE E", i) if i >= 0 else -1   # piece E's section follows (2026-11-08): C's ends where E's header begins
    return css[i:j] if i >= 0 and j > 0 else (css[i:] if i >= 0 else "")


def fn(src, head):
    """The text of one function of the chat script, from its `function name(` line to the next function at the same indent."""
    i = src.find(head)
    if i < 0:
        return ""
    m = re.search(r"\n  function \w+\(", src[i + len(head):])
    return src[i:i + len(head) + (m.start() if m else len(src))]


def depth_run(text):
    d, out = 0, []
    for ch in text:
        if ch == "{":
            d += 1
        elif ch == "}":
            d -= 1
            out.append(d)
    return out or [0]


def falsify(name, test, file, cut):
    """The check must fail once `cut` (a string, or a function of the text) is taken out of `file`."""
    src = dict(SRC)
    src[file] = cut(src[file]) if callable(cut) else src[file].replace(cut, "")
    ok = not test(src)
    s.check("falsified: %s fails without its piece" % name, ok, "" if ok else "still passes with %r removed" % (cut if isinstance(cut, str) else "..."))


def check(name, test, file=None, cut=None):
    s.check(name, test(SRC))
    if file:
        falsify(name, test, file, cut)


def _before_e(t, extra):
    """Plant a violation at the end of piece C's section (piece E's section follows it since 2026-11-08)."""
    j = t.find("\n/* ===== PHONE VIEW, PIECE E")
    return t + extra if j < 0 else t[:j] + extra + t[j:]


P = lambda S: phone_c(S[CSS])  # noqa: E731

# ---------------------------------------------------------------------------
s.section("one new section, after piece B's, inside the phone query")
check("piece C's section exists once, after piece B's, and is the LAST block of style.css",
      lambda S: S[CSS].count(MARK_C) == 1 and S[CSS].find(MARK_A) < S[CSS].find(MARK_B) < S[CSS].find(MARK_C) and S[CSS].rstrip().split("\n")[-1] == "}",
      CSS, lambda t: t.replace(MARK_C, "PHONE VIEW, PIECE X"))
check("...opening with the same query as pieces A and B, and every rule of it inside that query (the braces close only at the end of the file)",
      lambda S: QUERY in P(S) and P(S).count("\n@media") == 1 and depth_run(P(S)[P(S).index(QUERY):])[-1] == 0
      and all(d > 0 for d in depth_run(P(S)[P(S).index(QUERY):])[:-1]),
      CSS, lambda t: t[:t.rfind(MARK_C)] + t[t.rfind(MARK_C):].replace(QUERY, "@media (max-width: 1100px) {", 1) + "\n.late { color: red; }\n")
check("the section uses tokens and rem: no hex, rgb() or px font size; hover never underlines",
      lambda S: not re.search(r"#[0-9a-fA-F]{3,6}\b|rgba?\(", P(S)) and not re.search(r"font-size:\s*[\d.]+px", P(S))
      and not re.search(r":hover[^{]*\{[^}]*text-decoration:\s*underline", P(S)),
      CSS, lambda t: _before_e(t, "\n@media (max-width: 1023.98px) { .x { color: #fff; } }"))
check("no font size in the section is under 12px at Standard (rem 0.75 and up)",
      lambda S: all(float(m) >= 0.75 for m in re.findall(r"font-size:\s*([\d.]+)rem", P(S))),
      CSS, lambda t: _before_e(t, "\n@media (max-width: 1023.98px) { .x { font-size: 0.7rem; } }"))
check("every colour token the section reads is one the stylesheet defines",
      lambda S: all(re.search(re.escape(v) + r"\s*:", S[CSS][:S[CSS].rfind(MARK_C)]) for v in set(re.findall(r"var\((--[a-z0-9-]+)", P(S)))),
      CSS, lambda t: _before_e(t, "\n@media (max-width: 1023.98px) { .x { color: var(--no-such-token); } }"))
check("a phone part of the drawing carries the hidden attribute until the section turns it on (the desktop draws nothing new)",
      lambda S: all(k in S[JS] for k in ('phCount.hidden = true', 'b.className = "rv-ph-budrop"; b.hidden = true', 'both.className = "rv-ph-bothcurves"; both.hidden = true',
                                        'phb.hidden = true', 'phLine.hidden = true', 'phFoot.hidden = true'))
      and 'gc.hidden = true' in S[CS]
      and all(("%s[hidden]" % c) in P(S) for c in ("rv-ph-tbcount", "rv-ph-budrop", "rv-ph-bothcurves", "rv-ph-bandline", "rv-ph-pfoot", "rv-ph-gap")),
      JS, 'phCount.hidden = true; ')
check("the script asks the helper, never a width of its own; a window crossing the line draws the open curve and the open Talent Box again",
      lambda S: "function onPhone() { return typeof window.onehrIsPhone" in S[JS]
      and not re.search(r"innerWidth\s*[<>]=?\s*10\d\d|matchMedia\([\"']\(max-width: 10", S[JS] + S[CS])
      and 'if (calLive() && cal.data && !sheetClosing) { sheetEnter = false; swapStageBody(calibWidget(cal.data)); }' in S[JS]
      and "if (tbLive() && tb.data && !sheetClosing && tb.open == null) { sheetEnter = false; swapStageBody(talentBoxWidget(tb.data)); tbFit(); }" in S[JS],
      JS, "if (tbLive() && tb.data && !sheetClosing && tb.open == null) {")
check("the rooms are not sized by script on a phone: the Talent Box's fit leaves the card its own height and does not drag the page",
      lambda S: "if (!wrapped && !onPhone())" in fn(S[JS], "function tbFit()") and "(!onPhone() && cr.bottom > lr.bottom + 1)" in fn(S[JS], "function tbFit()"),
      JS, "if (!wrapped && !onPhone())")

# ---------------------------------------------------------------------------
s.section("the phone branches call today's writers, and post nothing of their own")
check("Save on the BU CEO's page is calMove on the page's own select (the roster's writer); a band button only sets that select, and Undo puts it back",
      lambda S: 'if (busy || sel.disabled || !sel.value || sel.value === phInit) return; calMove(r, sel); });' in fn(S[JS], "function calCurveBar(")
      and "x.addEventListener(\"click\", function () { if (sel.disabled) return; sel.value = bd; phPaint(); });" in S[JS]
      and 'phUndo.addEventListener("click", function () { sel.value = phInit; phPaint(); });' in S[JS]
      and fn(S[JS], "function calCurveBar(").count("calMove(") == 2 and 'phSave.className = "rv-confirm-yes rv-cal-lock rv-ph-psave"' in S[JS],
      JS, 'phSave.addEventListener("click", function () { if (busy || sel.disabled || !sel.value || sel.value === phInit) return; calMove(r, sel); });')
check("the business unit drop-down's pick is tbSelectCompany, the pills' own switch (and the one on screen changes nothing)",
      lambda S: "if (!on) tbSelectCompany(c.key);" in fn(S[JS], "function phBuSheet(") and "tbSelectCompany(c.key)" in fn(S[JS], "function talentBoxWidget("),
      JS, "if (!on) tbSelectCompany(c.key);")
check("Move on a phone is the pop-out's own panel (tbMovePanel, drawn 'sheet') and its own save (tbPostMove); the sheet cannot be closed while a move is being saved",
      lambda S: 'host.appendChild(tbMovePanel(d, p, "sheet"));' in fn(S[JS], "function tbStartMoveSheet(") and "canClose: function () { return !tb.saving; }" in fn(S[JS], "function tbStartMoveSheet(")
      and "tbPostMove(d, p, np, nq, (tb.why || \"\").trim())" in fn(S[JS], "function tbMovePanel(") and fn(S[JS], "function tbMovePanel(").count("tbPostMove(") == 1
      and "if (onPhone()) { tbStartMoveSheet(p); return; }" in fn(S[JS], "function tbStartMove("),
      JS, 'host.appendChild(tbMovePanel(d, p, "sheet"));')
check("a refusal (a limit, themselves, a lock) is the panel's own error line, in the sheet; the pinned button names the move, and the reason rule is today's (d.need_reason)",
      lambda S: 'var err = rmkEl("p", "rv-tbox-err", tb.mvErr || "")' in fn(S[JS], "function tbMovePanel(") and "fail((j && j.error)" in fn(S[JS], "function tbMovePanel(")
      and "d.need_reason && !(tb.why" in fn(S[JS], "function tbMovePanel(") and '"Move to "' in fn(S[JS], "function tbMovePanel("),
      JS, 'var err = rmkEl("p", "rv-tbox-err", tb.mvErr || "")')
check("a category in a full or over unit is not offered as a target in the sheet either (the server's own `full` list), with its words in the title",
      lambda S: "tbLimitFull(d, p, cat)" in fn(S[JS], "function tbMovePanel(") and "d.limits.msg[cat]" in fn(S[JS], "function tbMovePanel("),
      JS, "tbLimitFull(d, p, cat)")
check("Lock and Show moved are the card's own (calLockForm, tbLockForm, the Show moved buttons): the section only pins their foot; no phone code builds a lock form",
      lambda S: ".rv-calib-pin:not(.rv-cal-review) > .rv-cal-foot { position: sticky;" in P(S) and ".rv-tbox:not(.is-person) > .rv-cal-foot.rv-tbox-foot { position: sticky;" in P(S)
      and all("data-confirm" not in fn(S[JS], h) and "action" not in fn(S[JS], h) for h in ("function phBuDrop(", "function phBuSheet(", "function phCurvesSheet(", "function tbStartMoveSheet(", "function phSheet(")),
      CSS, ".rv-calib-pin:not(.rv-cal-review) > .rv-cal-foot { position: sticky;")
check("none of the phone helpers posts anything: no fetch( and no FormData in them",
      lambda S: all("fetch(" not in fn(S[JS], h) and "FormData" not in fn(S[JS], h) for h in (
          "function phBuDrop(", "function phBuSheet(", "function phCurvesSheet(", "function phSheet(", "function tbStartMoveSheet(", "function phMiniGrid(", "function phTbSummary(",
          "function tbPaintPhoneList(", "function phAxisSwitch(", "function phMoveEl(", "function phTagsCell(")) and "fetch(" not in fn(S[CS], "function gapWords(") ,
      JS, lambda t: t.replace("function phBuDrop(d) {", "function phBuDrop(d) { fetch('/x');"))
check("the pager bars are the desktop's own pagers (calPager, tbPager) and the back is sheetClose; the axis switch is piece B's, pressing the part switch",
      lambda S: "pgbar.appendChild(pgb); pgbar.appendChild(calPager(d));" in S[JS] and "pgbar.appendChild(tbPager(nb, true))" in S[JS] and S[JS].count('sheetClose("bezel")') >= 2
      and "if (!d.review) tb.appendChild(phAxisSwitch(d));" in fn(S[JS], "function calTitleBar("),
      JS, "pgbar.appendChild(tbPager(nb, true))")
check("Their page is the person page's own tabs (tbShowTab), and Move on it is the grid's own button (tbRowActions) opening the same sheet",
      lambda S: 'tp.addEventListener("click", function () { tbShowTab("perf"); });' in S[JS] and "var mvw = tbRowActions(d, p, true);" in S[JS],
      JS, 'tbShowTab("perf"); });')

# ---------------------------------------------------------------------------
s.section("the page works out no band, category, limit or curve figure")
check("the gap chip is the server's own gap (expected minus now) with its sign turned, its words from the same two figures; the line under 'Your band' reads the server's distribution and gaps",
      lambda S: "var more = -gap, exp = n + gap;" in fn(S[CS], "function gapWords(") and "(d.distribution || {})[b]" in fn(S[CS], "function bandLine(") and "(d.gaps || {})[b]" in fn(S[CS], "function bandLine(")
      and not re.search(r"Math\.|d\.target|\.total \*|/ 100", fn(S[CS], "function gapWords(") + fn(S[CS], "function bandLine(")),
      CS, "var more = -gap, exp = n + gap;")
check("the chip says 'As expected' for no gap, and a small group (counts only) shows the server's dash",
      lambda S: '"As expected"' in fn(S[CS], "function gapWords(") and "if (!total || d.small)" in fn(S[CS], "function gapWords(") and "if (!b || !d.total || d.small) return \"\";" in fn(S[CS], "function bandLine("),
      CS, "if (!total || d.small)")
check("the mini 3 x 3 is the server's cells and columns (tbCellOf, tbCol); the Summary page's journeys are the Performance and Potential tabs' own rows (perfJourney, potJourney)",
      lambda S: "tbCellOf(d, k)" in fn(S[JS], "function phMiniGrid(") and "tbKeyOf(d, p.id)" in fn(S[JS], "function phMiniGrid(") and "x[2](part.d, part.r, false)" in fn(S[JS], "function phTbSummary(")
      and "[\"Performance\", f.perf, perfJourney], [\"Potential\", f.pot, potJourney]" in fn(S[JS], "function phTbSummary(")
      and not re.search(r"Math\.|tbPctOf|calScore\(", fn(S[JS], "function phMiniGrid(") + fn(S[JS], "function phTbSummary(")),
      JS, 'tbKeyOf(d, p.id)')
check("the curves sheet draws the two curves the server sent (d.perf_curve, d.pot_curve) with the shared curve box",
      lambda S: '[["Performance", d.perf_curve], ["Potential", d.pot_curve]]' in fn(S[JS], "function phCurvesSheet(") and "calibDistBox(cv, { compact: true, phone: true })" in fn(S[JS], "function phCurvesSheet("),
      JS, '[["Performance", d.perf_curve], ["Potential", d.pot_curve]]')
check("the drop-down shows the server's head count and lock for each unit (c.n, c.tb_locked), the order and the words 'BU 1 of N'",
      lambda S: "c.n != null" in fn(S[JS], "function phBuSheet(") and "c.tb_locked" in fn(S[JS], "function phBuSheet(") and '"BU " + (cur ? cos.indexOf(cur) + 1 : 1) + " of "' in fn(S[JS], "function phBuDrop("),
      JS, "c.tb_locked")
check("the roster's movement line reads the chain the server sent: the tier below's band that came in, and 'you' once moved",
      lambda S: "(r.chain || []).filter(function (c) { return !c.own; })" in fn(S[JS], "function phMoveEl(") and "r.adjusted && r.current_band !== r.incoming_band" in fn(S[JS], "function phMoveEl("),
      JS, "(r.chain || []).filter(function (c) { return !c.own; })")

# ---------------------------------------------------------------------------
s.section("the business unit drop-down lists every business unit of today's data")
check("it draws one row for each of the overview's companies (all of them when nothing is typed) and the one on screen is ticked",
      lambda S: "cos.filter(function (c) { return !q ||" in fn(S[JS], "function phBuSheet(") and "shown.forEach(function (c) {" in fn(S[JS], "function phBuSheet(")
      and "var cos = d.companies || [], wrap" in fn(S[JS], "function phBuSheet(") and 'r.setAttribute("aria-current", "true")' in fn(S[JS], "function phBuSheet("),
      JS, "var cos = d.companies || [], wrap")
check("the overview gives each unit its head count (the left panel's own figure) in one pass over the population",
      lambda S: '"n": _tb_unit_heads.get(c, 0)' in S["app.py"] and "_tb_unit_heads[_p[\"company\"] or \"\"] = " in S["app.py"],
      "app.py", '"n": _tb_unit_heads.get(c, 0)')
# (the overview itself needs a running cycle with a Talent Box scope, which the bare fixture has not: its live reading, the drop-down's rows, their head counts
#  and locks, was checked on the QC copy, QC/phone-c-build-2026-11-07/measurements.md; here the page's drawing and the payload's code are held)
check("the overview gives each unit's row what the drop-down shows (its label, its lock and its head count), unit by unit in the box's own order",
      lambda S: '"companies": [{"key": c, "label": _talent_box_bu_label(bg, c), "locked": c not in pend, "tb_locked": tbl(c),' in S["app.py"]
      and "for c in D[\"all_companies\"]]" in S["app.py"],
      "app.py", '"tb_locked": tbl(c),')

# ---------------------------------------------------------------------------
s.section("the roster, the pinned feet and the pages are laid out by the section")
check("a roster row is the name with the job beside it, the movement, then the chip and the tags, and a 44px >",
      lambda S: 'grid-template-areas: "person person go" "move move go" "chip tags go"' in P(S) and ".rv-calib-roster-tbl.is-curve .rv-cal-link::after" in P(S)
      and "phTagsCell(r, d, pot)" in S[JS] and "(review || phCurve)" in S[JS],
      CSS, 'grid-template-areas: "person person go" "move move go" "chip tags go"')
check("each band is two lines: the name with 'n . %' on the right, then an 8px bar with the expected share as its tick and the gap chip at the bar's right; no verdict box, no 'Expected' text",
      lambda S: "height: 8px" in P(S) and ".rv-calib-dist.is-ph .calib-dist-pct .rv-cal-soft { display: none; }" in P(S) and ".rv-calib-dist.is-ph .calib-dist-gap { display: none; }" in P(S)
      and ".rv-calib-verdict, .rv-calib-pin .rv-cal-pickhint, .rv-calib-dist.is-ph .rv-calib-verdict { display: none; }" in P(S)
      and 'box.className = "rv-calib-dist" + (opts && opts.phone ? " is-ph" : "")' in S[CS],
      CSS, ".rv-calib-dist.is-ph .calib-dist-gap { display: none; }")
check("the filter strip scrolls sideways inside itself with the chips only: no label, no count, chips 44px, the chip words in full",
      lambda S: ".rv-calib-pin .rv-cal-flbl, .rv-calib-pin .rv-cal-fcount { display: none; }" in P(S) and ".rv-tbox .rv-cal-flbl, .rv-tbox .rv-cal-fcount { display: none; }" in P(S)
      and "overflow-x: auto" in P(S) and ".rv-cal-fline.is-tight .rv-cal-t-long" in P(S),
      CSS, ".rv-tbox .rv-cal-flbl, .rv-tbox .rv-cal-fcount { display: none; }")
check("the header stacks: the title, the Performance | Potential switch (piece B's), then the PAT pill, which may wrap so 'PAT not entered' is never cut; the caption is not drawn",
      lambda S: ".rv-calib-pin:not(.rv-cal-review) .rv-cal-titlebar { flex-direction: column;" in P(S) and "> .rv-cal-count { display: none; }" in P(S) and "white-space: normal; overflow: visible; text-overflow: clip;" in P(S),
      CSS, ".rv-calib-pin:not(.rv-cal-review) .rv-cal-titlebar { flex-direction: column;")
check("the Talent Box grid stays 3 x 3 with counts only (no initials, no moved count); PIP/Improvement reads 'PIP' with the full words in the cell's title",
      lambda S: ".rv-tbox-cellh .rv-tbox-mv, .rv-tbox-faces { display: none; }" in P(S)
      and 'ce = rmkEl("span", "rv-tbox-cat", onPhone() ? tbShortCat(cat) : cat);' in fn(S[JS], "function tbCell(") and "if (onPhone()) ce.title = cat;" in fn(S[JS], "function tbCell("),
      JS, 'onPhone() ? tbShortCat(cat) : cat')
check("the two axis buttons are one 'See both curves' link; the BU row of pills gives way to the drop-down (only the one after it)",
      lambda S: ".rv-tbox-axbtn.is-y, .rv-tbox-xaxis { display: none; }" in P(S) and ".rv-ph-budrop[hidden] + .rv-tbox-busrow { display: none; }" in P(S)
      and 'both.textContent = "See both curves"' in S[JS],
      CSS, ".rv-ph-budrop[hidden] + .rv-tbox-busrow { display: none; }")
check("a picked box lists its people under the grid (the body stacks); a row is the name, 'band . potential . department', today's tags, and a 44px Move",
      lambda S: ".rv-tbox-body { flex-direction: column;" in P(S) and ".rv-tbox-mvbtn { min-height: 44px;" in P(S) and ".rv-tbox-prow > .rv-tbox-insbtn" in P(S)
      and 'onPhone() && !d.group && !tb.cl) ? "" : (p.bu || p.company)' in S[JS],
      CSS, ".rv-tbox-body { flex-direction: column;")
check("the list view is the same people rows grouped by category in place of the table, with a search; it is the phone's own branch (the table stays for a desktop and for the Chairman's boxes)",
      lambda S: "onPhone() && !tb.ro && !tb.cl" in fn(S[JS], "function tbListView(") and "TB_CATS.forEach(function (cat) {" in fn(S[JS], "function tbPaintPhoneList(")
      and "tbPersonRow(d, p)" in fn(S[JS], "function tbPaintPhoneList(") and 'wrap.classList.contains("rv-ph-list")' in fn(S[JS], "function tbPaintList("),
      JS, "TB_CATS.forEach(function (cat) {")
check("the sheet is B's reader sheet drawing (the same classes), over the top bar, closing with the x, Esc and the dim, taking focus in and back, Tab kept inside",
      lambda S: all(k in fn(S[JS], "function phSheet(") for k in ('"kpi-rsheet-scrim"', 'x.addEventListener("click", function () { if (cfg.canClose && !cfg.canClose()) return; if (!asked(false)) close(); });', 'if (e.key === "Escape")', 'e.key === "Tab"',
                                                                   'scrim.addEventListener("click", function (e) { if (e.target === scrim) { if (cfg.canClose && !cfg.canClose()) return; if (!asked(false)) close(); } });', "back.focus(", 'root.style.overflow = "hidden"')),
      JS, 'if (e.key === "Escape")')
check("the Move sheet is full height with a 44px-wide row head, 72px cells (the category in full, its performance column under it, 'Now here'), the band as two buttons, and the move pinned",
      lambda S: ".kpi-rsheet.is-full { height: calc(100dvh - 24px);" in P(S) and "grid-template-columns: 44px repeat(3, minmax(0, 1fr))" in P(S) and "min-height: 72px; padding: 6px 4px" in P(S)
      and '"Now here"' in fn(S[JS], "function tbMovePanel(") and 'c.label + " perf."' in fn(S[JS], "function tbMovePanel(") and ".rv-ph-bseg { display: grid; grid-template-columns: repeat(2" in P(S)
      and ".rv-tbox-move.is-sheet .rv-tbox-save { flex: 2 1 0; min-height: 48px;" in P(S),
      CSS, "min-height: 72px; padding: 6px 4px")
check("where the column holds two bands (AE or OU) the choice is two buttons with each band's name; the picked band is the page's own tb.pick",
      lambda S: "bandChoice = bands;" in fn(S[JS], "function tbMovePanel(") and 'tb.pick = bd; tbRepaintMove(\'.rv-ph-bseg button[data-band="' in fn(S[JS], "function tbMovePanel("),
      JS, "bandChoice = bands;")
check("one person's page fills the phone (a fixed layer over everything, the column not drawn), for both leaders, with the pager bar and the decision or the foot pinned",
      lambda S: ".rv-cal-sheetmode:not(.rv-cal-review) .rv-sheet-layer { position: fixed; inset: 0; left: 0; z-index: 905; }" in P(S)
      and ".rv-tbox.is-person .rv-sheet-layer { position: fixed; inset: 0; left: 0; z-index: 905; }" in P(S) and ".rv-cal-sheetmode:not(.rv-cal-review) .rv-cal-pbar { position: sticky; bottom: 0;" in P(S)
      and ".rv-tbox-pp.is-ph > .rv-ph-tbfoot { position: sticky; bottom: 0;" in P(S),
      CSS, ".rv-tbox.is-person .rv-sheet-layer { position: fixed; inset: 0; left: 0; z-index: 905; }")
check("the BU CEO's page: the pager says '< Curve', 'Your band' is five 44px buttons with the HOD's band outlined, the line is the server's count, then Undo and Save",
      lambda S: 'rmkEl("span", null, review ? "Department" : "Curve")' in S[JS] and "CAL.bandLine(d, sel.value || r.current_band)" in fn(S[JS], "function calCurveBar(")
      and 'b.classList.toggle("is-was", c === came)' in fn(S[JS], "function calCurveBar(") and ".rv-ph-pfoot .rv-ph-psave { flex: 2 1 0; width: auto; min-height: 48px; }" in P(S),
      JS, "CAL.bandLine(d, sel.value || r.current_band)")
check("the BG CEO's page: '< Talent Box', '2 of 9 . Star', the mini 3 x 3, Performance and Potential journeys, the AI insight, Remark folded, and 'Their page' and Move pinned",
      lambda S: 'rmkEl("span", null, "Talent Box")' in S[JS] and 'tbShortCat(nb.cell.label)' in fn(S[JS], "function tbPager(") and 'rdet.className = "rv-ph-remark"' in fn(S[JS], "function tbSummarySection(")
      and ".rv-tbp-phone .rv-tbp-cards { display: none; }" in P(S) and 'tp.textContent = "Their page"' in S[JS],
      JS, 'rdet.className = "rv-ph-remark"')

# ---------------------------------------------------------------------------
s.section("no how-to sentence is drawn on a phone")
HOWTO = ("Your team vs the expected spread", "Pick where", "Pick the box they should sit in", "Tap ", "Click it again to show everyone", "FILTER", "Click the box")
_nocomment = lambda t: re.sub(r"//[^\n]*", "", t)   # what is drawn, not what the comments say
_phone_text = "".join(_nocomment(fn(SRC[JS], h)) for h in ("function phBuDrop(", "function phBuSheet(", "function phCurvesSheet(", "function phSheet(", "function tbStartMoveSheet(", "function phMiniGrid(",
                                                  "function phTbSummary(", "function tbPaintPhoneList("))
_phone_text += _nocomment(fn(SRC[CS], "function gapWords(") + fn(SRC[CS], "function bandLine(")) + "".join(re.findall(r'content:\s*"([^"]*)"', phone_c(SRC[CSS])))
s.check("the phone helpers, the sheets and the section's generated text carry none of the instruction lines", not any(h in _phone_text for h in HOWTO), _phone_text[:80])
check("the caption under the curve's title, the verdict box, the 'Showing X only ... click again' hint and the filter label are not drawn; the Move sheet draws no 'Pick the box' hint",
      lambda S: "> .rv-cal-count { display: none; }" in P(S) and ".rv-calib-verdict" in P(S) and ".rv-cal-pickhint" in P(S) and "display: none; }" in P(S)
      and "if (!tcell && !sheet) side.appendChild(rmkEl(\"p\", \"rv-tbox-mvhint\"" in S[JS],
      JS, 'if (!tcell && !sheet) side.appendChild(rmkEl("p", "rv-tbox-mvhint"')
check("a status sentence on a person's page drops its instruction on a phone for every leader's page ('... counted as UA by default. Set their band on the calibration curve.')",
      lambda S: "on the calibration curve|with Move on this page" in fn(S[JS], "function phHow(") and "if (!onPhone()) return t;" in fn(S[JS], "function phHow("),
      JS, "on the calibration curve|with Move on this page")

# ---------------------------------------------------------------------------
s.section("past talent status never reaches the leaders' person pages")
_phone_page = "".join(fn(SRC[JS], h) for h in ("function phMiniGrid(", "function phTbSummary(", "function tbPersonPage(", "function tbSummarySection(", "function tbPager(", "function calCurveBar("))
s.check("the phone person-page functions read no past talent field (past_talent, talent_status, a Record tab)",
        not re.search(r"past_talent|talent_status|pastTalent|Talent status|chairRecordSection", _phone_page), _phone_page[:60])
check("the Record tab (talent status for the last three Year-Ends) stays his alone (the Chairman's page), and the phone page is not drawn for it",
      lambda S: "(tb.cl ? TBP_TABS.concat([[\"rec\", \"Record\"]]) : TBP_TABS)" in fn(S[JS], "function tbPersonPage(") and "phone = onPhone() && !tb.cl" in fn(S[JS], "function tbPersonPage("),
      JS, "phone = onPhone() && !tb.cl")
sys.exit(s.done())
