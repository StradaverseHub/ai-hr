"""The phone view, piece B (Chris, "ok, apply the new changes and proceed", 2026-11-07; canvas v16 boards B1, B2 and the HOD column of C4; OneHR/Phone
view B build brief 2026-11-07.md): under 1024px wide the line manager's Team review (the rows, one person's KPI cards, the reader sheet) and the
HOD's Department Review (the header, the tally, the rows, one person's page, the pinned feet) have their phone layout; 1024px and up is the
desktop, untouched.

What this suite holds (each check is proved once on a source with the piece taken out, so none can pass by accident):
  * ONE new section after piece A's, `PHONE VIEW, PIECE B`, the last block of static/style.css, inside @media (max-width: 1023.98px), with no rule
    outside the query; tokens and rem only; nothing underlines on hover
  * the phone parts are drawn into the SAME markup, each hidden until the phone section shows it (so a desktop draws nothing new), and the script
    asks window.onehrIsPhone(), never a width of its own
  * the phone parts call the SAME writers: the phone Approve is approveSelected, the row's > is teamSelectReport, the band buttons set the page's
    own select and fire its change, Undo / Save are the page's own, the pager is calPager, the axis switch presses the part switch; none of the phone
    helpers posts anything itself
  * the page never works out a figure: the strip of steps is the ladder cells the table already marks, the pinned overall reads the server's bar
  * the reader sheet is built from today's description pop-out (parseRatings, meta) and its rating steps, the person's remark and file(s), and
    closes four ways with focus in and back
  * the pinned bars use the confirm box (approveSelected, pmConfirmLockAll and calReviewSave open it)
  * no how-to sentence is drawn on a phone
  * the Team summary rows carry who each person is (one batched read), and the words that named "the table" now fit both screens
No real names: the suite database is the synthetic scratch copy.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Phone view, piece B: line manager's Team review and the HOD's Department Review")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

SRC = {n: H.source(a, n) for n in ("static/style.css", "static/journey_chat.js", "static/kpi_line.js", "static/move_in.js", "app.py")}
QUERY = "@media (max-width: 1023.98px) {"
MARK_A = "PHONE VIEW, PIECE A"
MARK_B = "PHONE VIEW, PIECE B"
MARK_C = "PHONE VIEW, PIECE C"


def phone_b(css):
    """Piece B's section: from its marker to the start of piece C's section (phone view, piece C, 2026-11-07, which follows it)."""
    i = css.rfind(MARK_B)
    if i < 0:
        return ""
    j = css.find("/* ===== " + MARK_C, i)
    return css[i:j] if j >= 0 else css[i:]


def fn(src, head):
    """The text of one function of the chat script, from its `function name(` line to the next function at the same indent."""
    i = src.find(head)
    if i < 0:
        return ""
    m = re.search(r"\n  function \w+\(", src[i + len(head):])
    return src[i:i + len(head) + (m.start() if m else len(src))]


def fn_py(src, head):
    i = src.find(head)
    return src[i:src.find("\n\n\n", i)] if i >= 0 else ""


def depth_run(text):
    """Brace depth after each brace of the text (the section's comments hold none)."""
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


P = lambda S: phone_b(S["static/style.css"])  # noqa: E731
CSS, JS, KL = "static/style.css", "static/journey_chat.js", "static/kpi_line.js"

# ---------------------------------------------------------------------------
s.section("one new section, after piece A's, inside the phone query")
check("piece B's section exists once, after piece A's (piece C's, when it is there, follows it), and the file still ends with a closed block",
      lambda S: S[CSS].count(MARK_B) == 1 and S[CSS].find(MARK_A) < S[CSS].find(MARK_B) and S[CSS].rstrip().split("\n")[-1] == "}",
      CSS, lambda t: t.replace(MARK_B, "PHONE VIEW, PIECE X"))
check("...opening with the same query as piece A, and every rule of it inside that query (the braces close only at the end of the file)",
      lambda S: QUERY in P(S) and P(S).count("\n@media") == 1 and depth_run(P(S)[P(S).index(QUERY):])[-1] == 0
      and all(d > 0 for d in depth_run(P(S)[P(S).index(QUERY):])[:-1]),
      CSS, lambda t: t[:t.rfind(MARK_B)] + t[t.rfind(MARK_B):].replace(QUERY, "@media (max-width: 1100px) {", 1) + "\n.late { color: red; }\n")
check("the section uses tokens and rem: no hex, rgb() or px font size; hover never underlines",
      lambda S: not re.search(r"#[0-9a-fA-F]{3,6}\b|rgba?\(", P(S)) and not re.search(r"font-size:\s*[\d.]+px", P(S))
      and not re.search(r":hover[^{]*\{[^}]*text-decoration:\s*underline", P(S)),
      CSS, lambda t: t.replace("/* ===== " + MARK_C, "@media (max-width: 1023.98px) { .x { color: #fff; } }\n/* ===== " + MARK_C, 1) if MARK_C in t else t + "\n@media (max-width: 1023.98px) { .x { color: #fff; } }")
check("a piece of the phone drawing carries the hidden attribute until the section turns it on (the desktop draws nothing new)",
      lambda S: all(k in S[JS] for k in ('phh.hidden = true', 'pje.hidden = true', 'php.hidden = true', 'td.className = "rv-ph-go"; td.hidden = true',
                                        'phb.hidden = true', 'phn.hidden = true', 'b.className = "rv-ph-read"; b.hidden = true', 'phs.hidden = true',
                                        'w.hidden = true; w.setAttribute("role", "group")', 'phtk.hidden = true', 'pgbar.hidden = true', 'phb.hidden = true; phb.setAttribute("role", "group")'))
      and all(("%s[hidden]" % c) in P(S) for c in ("rv-ph-read", "rv-ph-pill", "rv-ph-go", "rv-ph-approve", "rv-ph-axis", "rv-ph-bands", "rv-ph-pgbar")),
      JS, 'pje.hidden = true; ')
check("the script asks the helper, never a width of its own, and a window crossing the line draws the open department review again",
      lambda S: "function onPhone() { return typeof window.onehrIsPhone" in S[JS]
      and not re.search(r"innerWidth\s*[<>]=?\s*10\d\d|matchMedia\([\"']\(max-width: 10", S[JS] + S[KL])
      and 'window.onehrOnPhoneChange(function () {\n    if (calLive() && cal.data && !sheetClosing)' in S[JS],
      JS, "function onPhone() { return typeof window.onehrIsPhone")

# ---------------------------------------------------------------------------
s.section("the phone parts call today's writers, and post nothing of their own")
check("the phone Approve is approveSelected, with the desktop button's own argument (so the same confirm box and the same route)",
      lambda S: 'phb.addEventListener("click", function () { approveSelected(stage, ab); });' in S[JS],
      JS, 'phb.addEventListener("click", function () { approveSelected(stage, ab); });')
check("the row's > opens the person exactly as a tap on the row does (teamSelectReport), and the count follows the ticks",
      lambda S: 'teamSelectReport(r.id, "detail")' in fn(S[JS], "function phGoCell(") and "pb.textContent = n ? \"Approve \" + n : \"Approve\"" in fn(S[JS], "function updateApproveCount("),
      JS, 'pb.textContent = n ? "Approve " + n : "Approve"')
check("the band buttons set the page's own select and fire its change; Undo puts the select back; Save is the page's own .rv-dr-psave (no second writer)",
      lambda S: 'sel.value = bd; sel.dispatchEvent(new Event("change", { bubbles: true }));' in S[JS]
      and 'phUndo.addEventListener("click", function () { sel.value = phInit; sel.dispatchEvent(new Event("change"' in S[JS]
      and S[JS].count('btn.className = "rv-confirm-yes rv-cal-lock rv-dr-psave"') == 1,
      JS, 'sel.value = bd; sel.dispatchEvent(new Event("change", { bubbles: true }));')
check("the person page's pager bar is the desktop's own pager (calPager) and its back is sheetClose; the axis switch presses the part switch",
      lambda S: "pgbar.appendChild(pgb); pgbar.appendChild(calPager(d));" in S[JS] and 'sheetClose("bezel")' in S[JS]
      and '.rv-nav .rv-nav-switch-opt[data-stage="' in fn(S[JS], "function phAxisSwitch(") and "opt.click()" in fn(S[JS], "function phAxisSwitch("),
      JS, "pgbar.appendChild(pgb); pgbar.appendChild(calPager(d));")
check("none of the phone helpers posts anything: no fetch( in them",
      lambda S: all("fetch(" not in fn(S[JS], h) for h in ("function phJob(", "function phGoCell(", "function phReadStrip(", "function phReadSheet(", "function phFootWire(",
                                                           "function phAxisSwitch(", "function phMoveEl(", "function phTagsCell(", "function phRemarkFold("))
      and "fetch(" not in fn(S[JS], "function phSheetOpen("),
      JS, lambda t: t.replace("function phGoCell(r) {", "function phGoCell(r) { fetch('/x');"))
check("the movement line and the pinned counts are read off the row and the page's own bar: nothing is scored on the page",
      lambda S: not re.search(r"Math\.|fmtScore|pm_score|\.score\b", fn(S[JS], "function phMoveEl(") + fn(S[JS], "function phFootWire(")),
      JS, lambda t: t.replace("function phMoveEl(r, d) {", "function phMoveEl(r, d) { var q = Math.round(1);"))
check("the pinned overall reads the server's overall bar (the figure pmModovFill writes) and counts the figures typed",
      lambda S: '.rv-mgr-modov .rv-kpi-bar-val' in fn(S[JS], "function phFootWire(") and '.rv-mod-val[data-kid]' in fn(S[JS], "function phFootWire("),
      JS, ".rv-mgr-modov .rv-kpi-bar-val")
check("the strip of steps is the ladder cells the table already marks: each rung cell carries its step number and the marks are pmLadderMark's",
      lambda S: 'c.setAttribute("data-rung", String(n))' in S[JS] and "pmLadderMark(c, n, l.report_n, l.mod_n, l.report_band, l.mod_band)" in S[JS]
      and "td.rv-rung.rv-scale-hit" in P(S) and "td.rv-rung.rv-scale-was" in P(S) and "td.rv-rung::before { content: attr(data-rung)" in P(S),
      JS, 'c.setAttribute("data-rung", String(n));')
check("their rating beside their result (Mech A) is the server's rating of their own figure (report_band, report_n), not worked out",
      lambda S: 'mgrPill(l.report_band, "Rating " + (l.report_n != null ? l.report_n : fmtScore(l.report_rating)))' in S[JS],
      JS, 'mgrPill(l.report_band, "Rating " + (l.report_n != null ? l.report_n : fmtScore(l.report_rating)))')

# ---------------------------------------------------------------------------
s.section("the pinned bars use the confirm box")
check("Approve N, Confirm & lock and the Department Review's Save each open the app's own dialog before anything is written",
      lambda S: "openConfirm(" in fn(S[JS], "function approveSelected(") and "openConfirm(" in fn(S[JS], "function pmConfirmLockAll(")
      and "openConfirm(" in fn(S[JS], "function calReviewSave(") and 'lb.className = "rv-confirm-yes rv-mod-lockall"' in S[JS] and ".rv-mgr-pin .rv-mod-lockall" in P(S),
      JS, lambda t: t.replace("openConfirm(spec);\n  }", "spec.onConfirm();\n  }", 1))
check("the feet are pinned (sticky) inside the chat's log, and the card around them does not scroll by itself",
      lambda S: ".rv-mgr-pin > .rv-sum-foot { position: sticky;" in P(S) and ".rv-cal-review .rv-cal-foot.rv-dr-foot { position: sticky;" in P(S)
      and ".rv-msg:has(.rv-mgr-pin), .rv-msg:has(.rv-cal-review) { overflow: visible; }" in P(S),
      CSS, ".rv-msg:has(.rv-mgr-pin), .rv-msg:has(.rv-cal-review) { overflow: visible; }")

# ---------------------------------------------------------------------------
s.section("the reader sheet is built from today's description pop-out")
check("it reads the description the pop-out reads (parseRatings, the full meta line), and adds the steps, their remark and their file(s)",
      lambda S: all(k in fn(S[JS], "function phSheetOpen(") for k in ("K.parseRatings(l.detail", "K.meta(l, true)", '"What it measures"', '"How it\'s scored"',
                                                                      '"Rating steps"', '"Their remark"', "opts.files")),
      JS, 'sec("How it\'s scored")')
check("the card's strip is one 44px tap that opens it with the steps from the line's own scale, the person's remark and their files",
      lambda S: "phSheetOpen(l, from, { weight: l.weight, steps: steps, remark: remark, files: files })" in S[JS]
      and "(l.scale || []).forEach" in fn(S[JS], "function phReadSheet(") and ".rv-ph-read[hidden] { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px" in P(S),
      JS, "phSheetOpen(l, from, { weight: l.weight, steps: steps, remark: remark, files: files })")
check("it closes four ways (x, Close, Esc, the dim), takes focus in and gives it back, keeps Tab inside, and the page behind stays still",
      lambda S: all(k in fn(S[JS], "function phSheetOpen(") for k in (
          'x.addEventListener("click", close); cb.addEventListener("click", close);', 'scrim.addEventListener("click", function (e) { if (e.target === scrim) close(); });',
          'if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }', "x.focus();", "fromEl.focus()", 'e.key === "Tab"', 'root.style.overflow = "hidden"')),
      JS, 'scrim.addEventListener("click", function (e) { if (e.target === scrim) close(); });')
check("the sheet rises from the bottom over the top bar (above the To do sheet's layer), at most the screen's height less 48px",
      lambda S: ".kpi-rsheet-scrim { position: fixed; inset: 0; z-index: 910;" in P(S) and "max-height: calc(100dvh - 48px)" in P(S) and "border-radius: 20px 20px 0 0" in P(S),
      CSS, ".kpi-rsheet-scrim { position: fixed; inset: 0; z-index: 910;")

# ---------------------------------------------------------------------------
s.section("the Department Review: header, tally, rows and one person's page")
check("the header stacks (title, count, the full-width switch); the tally is 3 x 2 tiles of at least 56px; Not final leads with its full words in the title",
      lambda S: ".rv-cal-review .rv-cal-titlebar { flex-direction: column;" in P(S) and "grid-template-columns: repeat(3, minmax(0, 1fr)) !important" in P(S)
      and "min-height: 56px" in P(S) and 'rv-dr-tlabel rv-ph-short", "Not final"' in S[JS] and 'x.title + ": " + x.count' in S[JS],
      CSS, ".rv-cal-review .rv-cal-titlebar { flex-direction: column;")
check("a row is the tick, the name with the job beside it, the movement (LM -> you), then the chip and the tags; its > is the row's Review button",
      lambda S: 'grid-template-areas: "tick person person go" "tick move move go" "tick chip tags go"' in P(S)
      and 'm.appendChild(document.createTextNode(" \\u2192 you "))' in fn(S[JS], "function phMoveEl(")
      and "phTagsCell(r, d, pot)" in S[JS] and ".rv-cal-review .rv-cal-link::after" in P(S),
      CSS, 'grid-template-areas: "tick person person go" "tick move move go" "tick chip tags go"')
check("the tags on the third line are today's own (Newly confirmed, LM on their behalf, Transferred, No KPI lines / No 360), by the same conditions",
      lambda S: all(k in fn(S[JS], "function phTagsCell(") for k in ("newlyTag()", "behalfTag()", "transferTag(r)", "nodataTag(r.nodata)", "r.newly", "r.behalf_lm", "r.nodata")),
      JS, "behalfTag()")
check("one person's page fills the phone (a fixed layer), the list's column is not drawn, and the page and the card scroll as one with the pager bar and the decision pinned",
      lambda S: ".rv-cal-review .rv-sheet-layer { position: fixed; inset: 0; left: 0; z-index: 905; }" in P(S) and ".rv-cal-review .rv-fold { display: none; }" in P(S)
      and ".rv-ph-pgbar[hidden] { position: sticky; top: 0;" in P(S) and ".rv-cal-review .rv-dr-decide.rv-dr-bar { position: sticky; bottom: 0;" in P(S),
      CSS, ".rv-cal-review .rv-fold { display: none; }")
check("the page's room is not sized by script on a phone (the fit functions leave it to the flow)",
      lambda S: "if (onPhone()) { ro.style.maxHeight = \"\"; return; }" in fn(S[JS], "function calFitRoster(") and "if (onPhone()) { body.style.height = \"\"" in fn(S[JS], "function calFitPerson("),
      JS, 'if (onPhone()) { ro.style.maxHeight = ""; return; }')
check("Remark is a folded details on a phone, after the KPIs; the KPIs are a list (name, weight, result, the rating's pill)",
      lambda S: 'document.createElement("details"); det.className = "rv-ph-remark"' in fn(S[JS], "function phRemarkFold(") and ".rv-cal-review .rv-ph-remark { order: 99;" in P(S)
      and 'krt.className = "rv-ph-krate"' in S[JS] and 'content: "Their KPIs"' in P(S),
      JS, 'det.className = "rv-ph-remark"')
check("the page's pinned decision is five 44px band buttons (the line manager's outlined, yours filled), then Undo and Save",
      lambda S: "repeat(5, minmax(0, 1fr))" in P(S) and ".rv-ph-bands button.is-was { box-shadow: inset 0 0 0 1.5px var(--accent-line); }" in P(S)
      and ".rv-ph-bands button.is-on { background: var(--accent);" in P(S) and "b.classList.toggle(\"is-on\", c === sel.value); b.classList.toggle(\"is-was\", c === came);" in S[JS],
      JS, 'b.classList.toggle("is-was", c === came)')

# ---------------------------------------------------------------------------
s.section("the Team summary and one person's cards")
check("a row is the tick, the name, the job line, the server's own status in a pill and the AI read in words; the foot says how many are ticked",
      lambda S: ".rv-mgr-sumtable tbody tr { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto 44px;" in P(S) and 'rv-ph-pill" + (r.done' in S[JS]
      and "var phs = r.status ||" in S[JS] and '"None selected"' in S[JS] and ".rv-mgr-sumtable td.rv-rmk-cell .rv-rmk-btn { display: none; }" in P(S),
      CSS, ".rv-mgr-sumtable td.rv-rmk-cell .rv-rmk-btn { display: none; }")
check("the header reads 'Your team's KPI reviews' over 'N of M done · Next up: <name>' from the rows' own data",
      lambda S: "\"Your team's \" + (stage === \"pm_review\" ? \"KPI reviews\"" in S[JS] and "\" of \" + rows.length + \" done\"" in S[JS] and '\\u00b7 Next up: "' in S[JS],
      JS, '" of " + rows.length + " done')
check("a KPI card is the table's own cells laid out (name and weight, the strip, their result and rating side by side, Your figure full width, the steps)",
      lambda S: all(k in P(S) for k in ('td.rv-mgr-their::before { content: "Their result"; }', 'td.rv-mgr-their + td::before { content: "Their rating"; }',
                                         'td.rv-mod-td::before { content: "Your figure";', "grid-template-columns: repeat(60, minmax(0, 1fr))", "tr:has(> td.rv-rung:nth-child(7))")),
      CSS, 'td.rv-mod-td::before { content: "Your figure";')
check("Confirm & lock is pinned with the running overall and how many figures are changed; its message stays above it",
      lambda S: 'phs = rmkEl("span", "rv-ph-sum")' in S[JS] and "phFootWire(box, phs);" in S[JS] and ".rv-sum-foot .rv-lock-msg { order: -1;" in P(S),
      JS, "phFootWire(box, phs);")
check("a Group-People-only or on-their-behalf card keeps today's table (the cards are for the moderation table only)",
      lambda S: ":is(.rv-mgr-pin:not(.rv-behalf), .rv-kpi-overview:not(.rv-kpi-inline)) table.rv-kpi-flat tbody tr {" in P(S),   # piece D (2026-11-08): the employee's own card shares the rules
      CSS, ":not(.rv-behalf), .rv-kpi-overview:not(.rv-kpi-inline)) table.rv-kpi-flat tbody tr {")

# ---------------------------------------------------------------------------
s.section("no how-to sentence is drawn on a phone")
HOWTO = ("Tick the people", "tap again", "N more below", "stands unless", "Pick where", "Tick everyone", "Click the box")
_phone_text = "".join(fn(SRC[JS], h) for h in ("function phJob(", "function phGoCell(", "function phReadStrip(", "function phReadSheet(", "function phFootWire(",
                                                  "function phAxisSwitch(", "function phMoveEl(", "function phTagsCell(", "function phRemarkFold("))
_phone_text += fn(SRC[JS], "function phSheetOpen(") + "".join(re.findall(r'content:\s*"([^"]*)"', phone_b(SRC[CSS])))
s.check("the phone helpers, the sheet and the section's generated text carry none of the instruction lines", not any(h.lower() in _phone_text.lower() for h in HOWTO), _phone_text[:80])
check("a status sentence on the person's page drops its instruction on a phone ('... counted as UA by default. Set their band below.') and keeps its fact",
      lambda S: 'phHow(empty)' in S[JS] and 'phHow(o.t)' in S[JS] and "[Ss]et their band (below|in this review|" in fn(S[JS], "function phHow(")
      and "if (!onPhone()) return t;" in fn(S[JS], "function phHow("),
      JS, 'rmkEl("p", "rv-cal-empty", phHow(empty))')
s.check("...and the Department Review's hint ('Tick the people ...') is hidden on a phone, where its count stands in",
        ".rv-cal-review .rv-cal-foot.rv-dr-foot > .rv-dr-hint { display: none; }" in phone_b(SRC[CSS]))
falsify("the how-to scan", lambda S: not any(h.lower() in (fn(S[JS], "function phGoCell(")).lower() for h in HOWTO), JS, lambda t: t.replace("function phGoCell(r) {", "function phGoCell(r) { var how = 'Tick the people';"))

# ---------------------------------------------------------------------------
s.section("floors the section draws")
check("taps are 44px: the tick, the row's >, the strip, the band buttons, the pager arrows, the back, the tally tiles, the foot buttons",
      lambda S: all(k in P(S) for k in ("flex: none; width: 44px; height: 44px;", ".rv-ph-gobtn { width: 44px; height: 44px;", "min-height: 44px; box-sizing: border-box; padding: 6px 10px",
                                         ".rv-ph-bands button { min-height: 44px;", ".rv-ph-pgbar .rv-cal-pgbtn { width: 44px; height: 44px;", ".rv-ph-back { display: inline-flex; align-items: center; gap: 4px; min-height: 44px;",
                                         "min-height: 56px; padding: 8px 10px", "min-height: 48px; padding: 0 22px")),
      CSS, ".rv-ph-bands button { min-height: 44px;")
check("no font size in the section is under 12px at Standard (rem 0.75 and up)",
      lambda S: all(float(m) >= 0.75 for m in re.findall(r"font-size:\s*([\d.]+)rem", P(S))),
      CSS, lambda t: t.replace("/* ===== " + MARK_C, "@media (max-width: 1023.98px) { .x { font-size: 0.7rem; } }\n/* ===== " + MARK_C, 1) if MARK_C in t else t + "\n@media (max-width: 1023.98px) { .x { font-size: 0.7rem; } }")

# ---------------------------------------------------------------------------
s.section("the Team summary carries who each person is; the words fit both screens")
check("one batched read gives each row its title, department and grade (display only)",
      lambda S: "def _team_row_people(db, ids):" in S["app.py"] and "WHERE id IN (%s)" in fn_py(S["app.py"], "def _team_row_people(") and "_team_row_people(db, [r[\"id\"] for r in rows])" in S["app.py"],
      "app.py", "_who = _team_row_people(db, [r[\"id\"] for r in rows])")


with a.app.app_context():
    _db = a.get_db()
    _ppl = a._team_row_people(_db, [r["id"] for r in _db.execute("SELECT id FROM users LIMIT 5").fetchall()])
s.check("_team_row_people returns title, department and grade for each id asked, and nothing for none",
        bool(_ppl) and all(set(v) == {"job_title", "department", "job_grade"} for v in _ppl.values()) and a._team_row_people(_db, []) == {}, list(_ppl.items())[:1])
check("the left panel and the agents no longer say 'the table' for the Team and Department screens; Help's bulk answer names the button 'Approve'",
      lambda S: "Everyone is in the table" not in S["app.py"] and S["app.py"].count("Everyone is in the summary. Or go one at a time:") == 2
      and "Tick the people who are ready and press Approve; it locks" in S["app.py"] and "brings the department summary, with its Save button" in S["app.py"]
      and "the department summary comes down with its Save button" in S["app.py"],
      "app.py", "Everyone is in the summary. Or go one at a time:")

sys.exit(s.done())
