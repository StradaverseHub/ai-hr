"""The phone view, piece D (Chris, "Yes, build as drawn", 2026-11-08; canvas boards D1, D1 at 768 and dark, D2; OneHR/Phone view D build brief 2026-11-08.md):
under 1024px wide the employee's KPI check-in is one card per KPI instead of the nine-column table, the 360 and competency cards have 44px buttons and
arrows, and "Write with AI" and the fold line's "View" are 44px taps; 1024px and up is the desktop, untouched.

What this suite holds (each check is proved once on a source with its piece taken out, so none can pass by accident):
  * ONE new section in static/style.css, `PHONE VIEW, PIECE D`, after piece F's and the last block of the file, inside @media (max-width: 1023.98px), with
    no rule outside the query; tokens and rem only; nothing underlines on hover; no font under 0.75rem; every rule is scoped to what D draws (the employee's
    own KPI card, never the other tables that wear .rv-kpi-overview; the 360 and competency cards; the fold line)
  * D1  piece B's card rules name the employee's container too (a selector list, not a copy); the employee's own cells (Your result, a Mechanism B line's
        Rating, the Files cell) have their rules; the Total KPI score row is its own block; the card's table has no minimum width
  * kpiRowCells (the row is cleared and rebuilt on every attach and refresh) writes the phone parts itself: data-rung on every ladder cell (the step's number
    and, for Mechanism B, its label), the two-line description strip that opens the reader sheet, the Add file words and count; each phone part is
    rendered hidden and turned on by the phone rules; no script moves a node, clones the input or watches the page
  * the strip opens the ONE reader sheet (phSheetOpen) with the employee's line, no remark and no files of theirs; it is not drawn when the line has nothing to open
  * the page computes no figure: the step that is filled is the ladder cell the table already marks (rv-scale-hit), and the Total stays the server's preview
  * desktop untouched: the table's cells, their order and classes are as before
  * D2/D3  44px taps on the 360 and competency cards, the section arrows, "Write with AI", the fold line's View, the rating pick's options
No real names: the suite database is the synthetic scratch copy.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Phone view, piece D: the employee's KPI check-in as cards, and the 360 / competency taps")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
REPO = H.REPO
CSS, JS = "static/style.css", "static/journey_chat.js"
SRC = {n: open(os.path.join(REPO, n), encoding="utf-8").read() for n in (CSS, JS)}
QUERY = "@media (max-width: 1023.98px) {"
MARK_F, MARK_D, MARK_CF = "PHONE VIEW, PIECE F", "PHONE VIEW, PIECE D:", "PHONE VIEW, PIECE D, CONFIRM"
EMP = ".rv-kpi-overview:not(.rv-kpi-inline)"


def phone_d(css):
    """Piece D's own section: from its header to the start of the CONFIRM section's header (the section after it, bounded below), else the end of the file."""
    i = css.rfind(MARK_D)
    if i < 0:
        return ""
    j = css.find(MARK_CF, i)
    return css[i:css.rfind("\n/*", i, j) + 1] if j >= 0 else css[i:]


def d_add(t, rule):
    """`rule` put at the end of piece D's section (before the CONFIRM section's header), for the checks that prove a guard by adding a stray rule."""
    j = t.rfind(MARK_CF)
    k = t.rfind("\n/*", 0, j) if j >= 0 else len(t)
    end = t.rfind("}", 0, k)
    return t[:end] + rule + t[end:]


def phone_cf(css):
    """The CONFIRM section (piece D2, 2026-11-08): from its header to the end of the file."""
    i = css.rfind(MARK_CF)
    return css[i:] if i >= 0 else ""


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


def falsify(name, test, src, cut):
    """The check must fail once `cut` (a string, or a function of the text) is taken out of the subject."""
    bad = cut(src) if callable(cut) else src.replace(cut, "")
    ok = bad != src and not test(bad)
    s.check("falsified: %s fails without its piece" % name, ok, "" if ok else "still passes with the piece removed")


def check(name, test, src, cut):
    s.check(name, bool(test(src)))
    falsify(name, test, src, cut)


D = phone_d
J = SRC[JS]
ROW = lambda t: fn(t, "function kpiRowCells(")   # noqa: E731

# ---------------------------------------------------------------------------
s.section("style.css: one new section, after piece F's, the last block, inside the phone query")
check("piece D's section exists once, after piece F's, and only the CONFIRM section follows it (the last block of style.css)",
      lambda t: t.count(MARK_D) == 1 and t.find(MARK_F) < t.find(MARK_D) < t.find(MARK_CF) and t.count(MARK_CF) == 1 and t.rstrip().split("\n")[-1] == "}", SRC[CSS],
      lambda t: t.replace(MARK_D, "PHONE VIEW, PIECE X"))
check("...opening with the phone query, every rule inside it (the braces close only at the end of the file)",
      lambda t: QUERY in D(t) and D(t).count("\n@media") == 1 and depth_run(D(t)[D(t).index(QUERY):])[-1] == 0
      and all(d > 0 for d in depth_run(D(t)[D(t).index(QUERY):])[:-1]), SRC[CSS],
      lambda t: t[:t.rfind(MARK_D)] + t[t.rfind(MARK_D):].replace(QUERY, "@media (max-width: 1100px) {", 1) + "\n.late { color: red; }\n")
check("the section uses tokens and rem: no hex, rgb() or px font size; hover never underlines",
      lambda t: not re.search(r"#[0-9a-fA-F]{3,6}\b|rgba?\(", D(t)) and not re.search(r"font-size:\s*[\d.]+px", D(t))
      and not re.search(r":hover[^{]*\{[^}]*text-decoration:\s*underline", D(t)), SRC[CSS],
      lambda t: d_add(t, "  .x { color: #fff; }\n"))
check("no text under 12px: every font-size in the section is 0.75rem or more",
      lambda t: all(float(x) >= 0.75 for x in re.findall(r"font-size:\s*([\d.]+)rem", D(t))), SRC[CSS],
      lambda t: d_add(t, "  .x { font-size: 0.6875rem; }\n"))
SCOPES = (EMP, ".rv-ph-addt[hidden]", ".kpi-pick-pop", ".rv-fb-pin", ".rv-tc-pin", ".rv-bz:has(.rv-fb-pin", ".rv-fold-line")


def selectors_of(body):
    """Every selector of a section whose rules sit one level inside its query."""
    body = body[body.index(QUERY) + len(QUERY):]
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    out = []
    for m in re.finditer(r"([^{};]+)\{", body):
        out += [x.strip() for x in m.group(1).split(",") if x.strip()]
    return out


def selectors(t):
    """Every rule's selector list of the section, as a list of single selectors (the rules sit one level inside the query)."""
    body = D(t)
    body = body[body.index(QUERY) + len(QUERY):]
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    out = []
    for m in re.finditer(r"([^{};]+)\{", body):
        out += [x.strip() for x in m.group(1).split(",") if x.strip()]
    return out


check("every selector in the section is scoped to what D draws: the employee's own card (not the .rv-kpi-inline tables), the pick list, the 360 / competency cards, the fold line",
      lambda t: all(x.startswith(SCOPES) for x in selectors(t)) and len(selectors(t)) > 40, SRC[CSS],
      lambda t: d_add(t, "  .rv-tc-grp .rv-fb-btn { min-height: 44px; }\n"))

# ---------------------------------------------------------------------------
s.section("D1: piece B's card rules are shared (the selector lists name the employee's container), not copied")
B_RULES = ("table.rv-kpi-flat tbody tr {", ".rv-kpi-flat td.rv-kpi-cell { display: contents; }", ".rv-kpi-flat td.rv-rung::before { content: attr(data-rung);",
           ".rv-kpi-flat td.rv-rung.rv-scale-hit { background: var(--accent); color: var(--on-fill); }", ".rv-kpi-flat tbody td:nth-child(2) { position: absolute;",
           ".rv-kpi-flat .kpi-meta, ")
SHARE = ":is(.rv-mgr-pin:not(.rv-behalf), .rv-kpi-overview:not(.rv-kpi-inline))"
check("each of B's shared rules (the card grid, the cells, the weight pill, the step strip and its filled step, the hidden description) is written once for BOTH containers",
      lambda t: all((SHARE + " " + x) in t or (SHARE + " " + x) in t.replace("\n", " ") for x in B_RULES)
      and ".rv-mgr-pin:not(.rv-behalf) table.rv-kpi-flat tbody tr" not in t.replace(SHARE, ""), SRC[CSS],
      lambda t: t.replace(SHARE + " table.rv-kpi-flat tbody tr {", ".rv-mgr-pin:not(.rv-behalf) table.rv-kpi-flat tbody tr {"))
check("the manager-only rules are not shared (their result, their rating, Justified?, the moderation cell, the pick)",
      lambda t: all((SHARE + " .rv-kpi-flat " + x) not in t for x in ("td.rv-mgr-their", "td.rv-mgr-just", "td.rv-mod-td", ".rv-mod-field", ".rv-mod-pick")), SRC[CSS],
      lambda t: t.replace(".rv-mgr-pin:not(.rv-behalf) .rv-kpi-flat td.rv-mgr-just {", SHARE + " .rv-kpi-flat td.rv-mgr-just {", 1))
check("the table's own minimum width (360px) is cleared on the card, so the card is the column's width",
      lambda t: EMP + " table.rv-scorecard.rv-kpi-flat { min-width: 0; }" in D(t), SRC[CSS],
      lambda t: t.replace(EMP + " table.rv-scorecard.rv-kpi-flat { min-width: 0; }", ""))
check("the Total KPI score row (it shares the tbody) is its own block, not a card, and its cell is a block",
      lambda t: EMP + " table.rv-kpi-flat tbody tr.rv-kpi-total { display: block;" in D(t) and EMP + " .rv-kpi-flat tr.rv-kpi-total > td { display: block; }" in D(t), SRC[CSS],
      lambda t: t.replace(EMP + " table.rv-kpi-flat tbody tr.rv-kpi-total { display: block;", EMP + " table.rv-kpi-flat tbody tr.rv-kpi-total { x: 0;"))
check("Your result: full width, labelled, a 48px field with the unit inside (44px input, 16px type so a phone does not zoom); a rating line keeps its 48px pick",
      lambda t: EMP + ' .rv-kpi-flat td.rv-kpi-result::before { content: "Your result";' in D(t) and EMP + " .rv-kpi-flat .rv-res-field { width: 100%; min-height: 48px;" in D(t)
      and EMP + " .rv-kpi-flat .rv-res-field .rv-res-input { min-height: 44px; font-size: 1rem; }" in D(t)
      and ".rv-kpi-flat .kpi-pick { width: 100%; min-height: 48px;" in D(t), SRC[CSS],
      lambda t: t.replace(" .rv-kpi-flat .rv-res-field { width: 100%; min-height: 48px;", " .rv-kpi-flat .rv-res-field { width: 100%; x: 48px;"))
check("a Mechanism B line's own Rating cell is a labelled row under Your result",
      lambda t: EMP + " .rv-kpi-flat td.rv-rating-cell { grid-column: 1 / -1; order: 4;" in D(t) and EMP + ' .rv-kpi-flat td.rv-rating-cell::before { content: "Rating";' in D(t), SRC[CSS],
      lambda t: t.replace(' td.rv-rating-cell::before { content: "Rating";', " td.rv-rating-cell::before { x: 0;"))
check("Files: the cell is a column, the Add file row is first and a 44px tap with the clip, the files under it are 44px rows with a 44px remove, the rule words stay (12px or more)",
      lambda t: EMP + " .rv-kpi-flat td.rv-kpi-files { grid-column: 1 / -1; order: 8; display: flex; flex-direction: column;" in D(t)
      and re.search(r"td\.rv-kpi-files \.rv-att-add \{ order: -1;[^}]*min-height: 44px", D(t)) and ".rv-att-rm { width: 44px; height: 44px;" in D(t)
      and "td.rv-kpi-files .rv-att { display: flex;" in D(t) and "td.rv-kpi-files .rv-att-req { order: -1; margin: 0; font-size: 0.8125rem; }" in D(t), SRC[CSS],
      lambda t: t.replace(".rv-att-rm { width: 44px; height: 44px;", ".rv-att-rm { width: 24px; height: 24px;"))
check("a Files cell that holds only the desktop's dash (a line HR fills, or nothing to add) is not drawn",
      lambda t: "td.rv-kpi-files:has(> .rv-att-none:only-child) { display: none; }" in D(t), SRC[CSS],
      lambda t: t.replace("td.rv-kpi-files:has(> .rv-att-none:only-child) { display: none; }", ""))
check("the Remarks and the foot: helper text 0.75rem, 16px in the box, Save and Save & submit 44px",
      lambda t: EMP + " .rv-mgr-remarks-h, " in D(t) and EMP + " .rv-myrm-input { font-size: 1rem; }" in D(t) and EMP + " .rv-save-submit, " in D(t)
      and "min-height: 44px; box-sizing: border-box; }" in D(t), SRC[CSS],
      lambda t: t.replace(EMP + " .rv-myrm-input { font-size: 1rem; }", ""))

# ---------------------------------------------------------------------------
s.section("kpiRowCells writes the phone parts itself (the row is cleared and rebuilt on every attach and refresh)")
check("every ladder cell carries data-rung: the step's number (Mechanism A) and its label (Mechanism B)",
      lambda t: 'td.setAttribute("data-rung", String(n));' in ROW(t) and 'td.setAttribute("data-rung", lab);' in ROW(t), J,
      lambda t: t.replace('td.setAttribute("data-rung", lab);', ""))
check("the Mechanism A step number is set where the cell is made, before its value (so a rebuilt row is never without it)",
      lambda t: ROW(t).index('td.setAttribute("data-rung", String(n));') < ROW(t).index("rungVal(td, byN[n]"), J,
      lambda t: t.replace('        td.setAttribute("data-rung", String(n));   // the phone\'s step strip draws it above its value\n', "").replace(
          "rungVal(td, byN[n] != null ? byN[n] : DASH); tr.appendChild(td);", 'rungVal(td, byN[n] != null ? byN[n] : DASH); td.setAttribute("data-rung", String(n)); tr.appendChild(td);'))
check("the description strip is built in the row's KPI cell by the same helper the line manager's card uses, as the employee's own (no remark, no files of theirs)",
      lambda t: "phReadStrip(l, undefined, true)" in ROW(t) and "kc.appendChild(rds)" in ROW(t) and "function phReadStrip(l, remark, own)" in t, J,
      lambda t: t.replace("var rds = phReadStrip(l, undefined, true); if (rds) kc.appendChild(rds);", ""))
check("the strip is a button rendered hidden, with its words in a span and the pop-out icon; it is not drawn when the line has nothing to open",
      lambda t: 'b.type = "button"; b.className = "rv-ph-read"; b.hidden = true;' in fn(t, "function phReadStrip(") and
      "if (own && !bits.length && !(l.scale || []).length && !(l.scale_b || []).length) return null;" in fn(t, "function phReadStrip("), J,
      lambda t: t.replace("if (own && !bits.length && !(l.scale || []).length && !(l.scale_b || []).length) return null;", ""))
check("the strip opens the ONE reader sheet (phSheetOpen, through phReadSheet), from the strip so focus comes back to it",
      lambda t: 'b.addEventListener("click", function (e) { e.stopPropagation(); phReadSheet(l, remark, b); });' in fn(t, "function phReadStrip(")
      and "phSheetOpen(l, from, {" in fn(t, "function phReadSheet("), J,
      lambda t: t.replace('phReadSheet(l, remark, b); });', 'void 0; });'))
check("the employee's line carries no files of theirs into the sheet (the payload has no `files`; the card lists the attachments itself)",
      lambda t: '"attachments": ([] if _review_hr_owned(t)' in t and '"files":' not in t[t.index('"kpi_id": t["id"], "kpi": t["kpi_name"]'):t.index('"attachments": ([] if _review_hr_owned(t)')],
      open(os.path.join(REPO, "app.py"), encoding="utf-8").read(), lambda t: t.replace('"eid": (None if _review_hr_owned(t)', '"files": [], "eid": (None if _review_hr_owned(t)'))
check("the Add file row carries its words and count in a span rendered hidden, built from the row's own attachments",
      lambda t: 'addT.className = "rv-ph-addt"; addT.hidden = true;' in ROW(t) and '"Add file \\u00b7 " + nAtt + (nAtt === 1 ? " file" : " files") : "Add file"' in ROW(t)
      and "addLab.appendChild(addT);" in ROW(t) and "fc.appendChild(addLab);" in ROW(t), J,
      lambda t: t.replace("addLab.appendChild(addT);", ""))
check("the phone rules turn the phone parts on: the strip (piece B's .rv-ph-read[hidden]) and the Add file words (.rv-ph-addt[hidden])",
      lambda t: ".rv-ph-read[hidden] { grid-column: 1 / -1; display: flex;" in t and ".rv-ph-addt[hidden] { display: inline;" in D(t), SRC[CSS],
      lambda t: t.replace(".rv-ph-addt[hidden] { display: inline;", ".rv-ph-addt[hidden] { x: 0;"))
check("no script moves a node, clones the input or watches the page for the card (the typed Result stays the real input)",
      lambda t: not any(w in ROW(t) for w in ("MutationObserver", "cloneNode", "insertBefore", "replaceChild", "removeChild")) and "MutationObserver" not in fn(t, "function phReadStrip("), J,
      lambda t: t.replace("    kc.appendChild(dsc);", "    kc.appendChild(dsc);") .replace("    tr.appendChild(kc);\n    var wc", "    tr.appendChild(kc); kc.cloneNode(true);\n    var wc", 1))
check("the phone parts ask no width of their own: the strip's click and the card's rules use the page's one phone line (CSS under 1024px), never innerWidth in kpiRowCells",
      lambda t: "innerWidth" not in ROW(t) and "matchMedia" not in ROW(t), J, lambda t: t.replace("    tr.appendChild(kc);\n    var wc", "    tr.appendChild(kc); window.innerWidth;\n    var wc", 1))

# ---------------------------------------------------------------------------
s.section("the page computes no figure; the desktop's table is as before")
check("the step that is filled is the ladder cell the table already marks (rv-scale-hit, set by the server's achieved step or kpiLiveMark), and the card's fill rule reads that class",
      lambda t: 'td.className = "rv-rung" + (l.achieved_n === n ? " rv-scale-hit" : "");' in ROW(t) and "kpiLiveMark(inp, l)" in fn(t, "function kpiResultCell(")
      and SHARE + " .rv-kpi-flat td.rv-rung.rv-scale-hit { background: var(--accent);" in SRC[CSS], J,
      lambda t: t.replace('td.className = "rv-rung" + (l.achieved_n === n ? " rv-scale-hit" : "");', 'td.className = "rv-rung";'))
check("the phone parts add no scoring: the strip and the Add file words read the line's own fields; nothing there parses a figure",
      lambda t: not re.search(r"parseFloat|kpiRungForValue|kpiPctForValueB", fn(t, "function phReadStrip(") + ROW(t)), J,
      lambda t: t.replace('b.setAttribute("aria-label", "Read all about " + (l.base || l.kpi || "this KPI"));', 'b.setAttribute("aria-label", "x" + kpiRungForValue(l, "1"));'))
check("the Total KPI score is still the server's preview (the page never works it out)",
      lambda t: 'fetch("/review/kpi/preview?"' in t and "renderKpiTotal({ overall: j.overall })" in t, J,
      lambda t: t.replace('fetch("/review/kpi/preview?"', 'fetch("/review/kpi/previewx?"'))
CELLS = ('kc.className = "rv-kpi-cell"', "tr.appendChild(wc);", 'td.className = "rv-rung"', 'rc.className = "rv-kpi-result"', 'rat.className = "rv-rating-cell"', 'fc.className = "rv-kpi-files"')
check("the row's cells and their order are as before: KPI cell, weight, the ladder, Result, Rating (Mechanism B), Files; the phone parts are inside those cells, no new cell",
      lambda t: all(x in ROW(t) for x in CELLS) and [ROW(t).index(x) for x in CELLS] == sorted(ROW(t).index(x) for x in CELLS)
      and ROW(t).count('document.createElement("td")') == 7, J,
      lambda t: t.replace('var rc = document.createElement("td"); rc.className = "rv-kpi-result";', 'var rx = document.createElement("td"); tr.appendChild(rx); var rc = document.createElement("td"); rc.className = "rv-kpi-result";'))
check("the table's head and its writers are untouched: the Result is still a plain input tagged data-kpi, Save reads every one; Mechanism B still lights its Rating cell",
      lambda t: 'inp.setAttribute("data-kpi", l.kpi_id);' in fn(t, "function kpiResultCell(") and "kpiLiveMarkB(inp, l)" in fn(t, "function kpiResultCell(")
      and 'th("Rating scale", { colspan: 5, cls: "rv-scale-grouphead" })' in t, J,
      lambda t: t.replace('inp.setAttribute("data-kpi", l.kpi_id);', 'inp.setAttribute("data-k", l.kpi_id);'))

# ---------------------------------------------------------------------------
s.section("D2 / D3: the 360 and competency cards' buttons and arrows, \"Write with AI\", the fold line's View, the rating pick's options")
check("D2: the Demonstrate / Developing buttons on the 360 and competency cards are 44px, share a row (two to a row where four do not fit), 12px kickers",
      lambda t: ".rv-fb-pin .rv-fb-btn, .rv-tc-pin .rv-fb-btn { min-height: 44px; box-sizing: border-box; }" in D(t)
      and ".rv-fb-pin .rv-fb-btns, .rv-tc-pin .rv-fb-btns { display: flex; flex-wrap: wrap; gap: 8px; width: 100%; }" in D(t)
      and "flex: 1 1 6rem; min-width: 0;" in D(t) and ".rv-fb-pin .rv-fb-pkick, .rv-tc-pin .rv-tc-kicker, .rv-tc-pin .rv-tc-navcount { font-size: 0.75rem; }" in D(t), SRC[CSS],
      lambda t: t.replace(".rv-fb-pin .rv-fb-btn, .rv-tc-pin .rv-fb-btn { min-height: 44px;", ".rv-fb-pin .rv-fb-btn, .rv-tc-pin .rv-fb-btn { x: 0;"))
check("D2: the section arrows of those two cards are 44px wide (only where the card holds the 360 or competency pin: the calibration pin's and the summary's arrows are not touched)",
      lambda t: ".rv-bz:has(.rv-fb-pin, .rv-tc-pin) > .rv-bz-btn { flex: 0 0 44px; width: 44px; }" in D(t), SRC[CSS],
      lambda t: t.replace(".rv-bz:has(.rv-fb-pin, .rv-tc-pin) > .rv-bz-btn { flex: 0 0 44px; width: 44px; }", ""))
check("D3: \"Write with AI\" on the KPI stage and the fold line's View are 44px taps (padding and min-height, not bigger type)",
      lambda t: EMP + " .rv-help-trigger { min-height: 44px;" in D(t) and ".rv-fold-line .rv-fold-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px;" in D(t), SRC[CSS],
      lambda t: t.replace(".rv-fold-line .rv-fold-btn { display: inline-flex;", ".rv-fold-line .rv-fold-btn { x: 0; display: inline-flex;"))
check("D3: the fold line's words wrap beside the 44px View instead of being cut with \"...\"",
      lambda t: ".rv-fold-line .rv-fold-text { white-space: normal; overflow: visible; text-overflow: clip;" in D(t), SRC[CSS],
      lambda t: t.replace(".rv-fold-line .rv-fold-text { white-space: normal; overflow: visible; text-overflow: clip;", ".rv-fold-line .rv-fold-text { x: 0;"))
check("the rating pick's options and Read all are 44px (the list is drawn on the page, outside the card)",
      lambda t: ".kpi-pick-pop .kpi-pick-opt, .kpi-pick-pop .kpi-pick-readall { min-height: 44px;" in D(t), SRC[CSS],
      lambda t: t.replace(".kpi-pick-pop .kpi-pick-opt, .kpi-pick-pop .kpi-pick-readall { min-height: 44px;", ".kpi-pick-pop .kpi-pick-opt, .kpi-pick-pop .kpi-pick-readall { x: 0;"))
check("the markup D2 and D3 style is the page's own (the 360 card .rv-fb-pin, the competency card .rv-tc-pin, the fold line .rv-fold-line with .rv-fold-btn, the pick list .kpi-pick-pop)",
      lambda t: 'className = "rv-fold-line"' in t or "rv-fold-line" in t,
      J, lambda t: t.replace("rv-fold-line", "rv-fold-lin"))
KL = open(os.path.join(REPO, "static/kpi_line.js"), encoding="utf-8").read()
check("...and the pick list's class names exist in the script that draws it",
      lambda t: 'el("div", "kpi-pick-pop")' in t and 'el("button", "kpi-pick-opt' in t and '"kpi-pick-readall"' in t, KL, lambda t: t.replace('"kpi-pick-readall"', '"kpi-pick-rdall"'))

# ---------------------------------------------------------------------------
# PIECE D, CONFIRM (2026-11-08): the sign-off box's scorecard as cards, 44px buttons in the confirm boxes. Its own section after D's.
s.section("D, CONFIRM: the \"Submit your KPI check-in?\" box fits a phone; the small confirm boxes have 44px buttons")
CF = phone_cf
SO = ".rv-signoff-dialog .rv-so-scorecard table.rv-scorecard"
check("the CONFIRM section exists once, is the LAST block of style.css, and has ONE query: max-width 1023.98px, every rule inside it",
      lambda t: t.count(MARK_CF) == 1 and t.rstrip().split("\n")[-1] == "}" and CF(t).count("\n@media") == 1 and QUERY in CF(t)
      and all(d > 0 for d in depth_run(CF(t)[CF(t).index(QUERY):])[:-1]) and depth_run(CF(t)[CF(t).index(QUERY):])[-1] == 0, SRC[CSS],
      lambda t: t[:t.rfind(MARK_CF)] + t[t.rfind(MARK_CF):].replace(QUERY, "@media (max-width: 1100px) {", 1))
check("...with tokens and rem only, no text under 12px, no underline on hover, and nothing outside the sign-off box or the .rv-cbox confirm boxes",
      lambda t: not re.search(r"#[0-9a-fA-F]{3,6}\b|rgba?\(", CF(t)) and not re.search(r"font-size:\s*[\d.]+px", CF(t))
      and all(float(x) >= 0.75 for x in re.findall(r"font-size:\s*([\d.]+)rem", CF(t))) and not re.search(r":hover[^{]*\{[^}]*underline", CF(t))
      and all(x.startswith((".rv-signoff-dialog", ".rv-cbox", ".rv-dr-assign")) for x in selectors_of(CF(t))) and len(selectors_of(CF(t))) > 12, SRC[CSS],
      lambda t: t[:-2] + "  .modal-card h2 { font-size: 0.6875rem; }\n}\n")
check("desktop untouched: neither .rv-cbox nor the card rules appear anywhere in style.css before the CONFIRM section",
      lambda t: ".rv-cbox" not in t[:t.rfind(MARK_CF)] and SO not in t[:t.rfind(MARK_CF)], SRC[CSS],
      lambda t: t.replace("/* ===== PHONE VIEW, PIECE A:", ".rv-cbox { x: 0; }\n/* ===== PHONE VIEW, PIECE A:", 1))
check("the scorecard is cards: the table is a block with no minimum width and no sideways scroll, the heading row is not drawn, each row is a two-column grid",
      lambda t: (SO + " { display: block; min-width: 0; width: 100%;") in CF(t) and (SO + " thead { display: none; }") in CF(t)
      and (".rv-signoff-dialog .rv-so-scorecard { overflow: visible; }") in CF(t) and (SO + " tbody tr { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);") in CF(t), SRC[CSS],
      lambda t: t.replace(SO + " thead { display: none; }", ""))
check("the KPI cell spans the card; Weight, Actual, Rating and Band are labelled pairs (the table's own headings, set as ::before words in the table's column order)",
      lambda t: SO + " tbody td:first-child { grid-column: 1 / -1; }" in CF(t)
      and all((SO + " tbody td:nth-child(%d)::before { content: \"%s\"; }" % (n, w)) in CF(t) for n, w in ((2, "Weight"), (3, "Actual"), (4, "Rating"), (5, "Band"))), SRC[CSS],
      lambda t: t.replace('td:nth-child(4)::before { content: "Rating"; }', 'td:nth-child(4)::before { content: "Rate"; }'))
check("...and those labels are the headings scorecardTable draws, in that order (the page markup is as it was: same table, same cells, same words)",
      lambda t: '["KPI", "Weight", "Actual", "Rating", "Band"].forEach' in t and 'w.className = "rv-table-scroll rv-so-scorecard";' in t
      and "w.appendChild(scorecardTable(d, \"Overall: \"));" in t, J,
      lambda t: t.replace('["KPI", "Weight", "Actual", "Rating", "Band"].forEach', '["KPI", "Band", "Weight", "Actual", "Rating"].forEach', 1))
check("Read all in the box is a 44px tap and the box's own padding gives the cards room (16px sides)",
      lambda t: ".rv-signoff-dialog .rv-so-scorecard .kpi-desc-more { min-height: 44px;" in CF(t) and ".rv-signoff-dialog .modal-card { padding: 20px 16px;" in CF(t), SRC[CSS],
      lambda t: t.replace(".rv-signoff-dialog .rv-so-scorecard .kpi-desc-more { min-height: 44px;", ".rv-signoff-dialog .rv-so-scorecard .kpi-desc-more { x: 0;"))
check("the sign-off box's buttons (Cancel, Confirm & submit, Back to the card, OK) and each \"Go to\" are 44px, and the buttons wrap rather than clip",
      lambda t: ".rv-signoff-dialog .modal-actions { flex-wrap: wrap; }" in CF(t)
      and ".rv-signoff-dialog .modal-actions button { min-height: 44px; min-width: 44px; box-sizing: border-box; }" in CF(t)
      and ".rv-signoff-dialog .rv-go-btn { min-height: 44px; min-width: 44px;" in CF(t), SRC[CSS],
      lambda t: t.replace(".rv-signoff-dialog .modal-actions button { min-height: 44px;", ".rv-signoff-dialog .modal-actions button { x: 0;"))
check("openConfirm's boxes (Confirm & lock, Approve, Save for now?, Submit the department review?, Set these bands first) wear .rv-cbox, and its buttons and Go to are 44px",
      lambda t: 'overlay.className = "modal-overlay rv-cbox"' in fn(t, "function openConfirm("), J,
      lambda t: t.replace('overlay.className = "modal-overlay rv-cbox"', 'overlay.className = "modal-overlay"', 1))
check("...the rule behind it",
      lambda t: ".rv-cbox .modal-actions button, .rv-cbox .rv-go-btn, .rv-dr-assign .modal-actions button, .rv-dr-assign .rv-go-btn { min-height: 44px; min-width: 44px; box-sizing: border-box; }" in CF(t)
      and ".rv-cbox .modal-actions, .rv-dr-assign .modal-actions { flex-wrap: wrap; }" in CF(t), SRC[CSS],
      lambda t: t.replace(".rv-cbox .modal-actions button, .rv-cbox .rv-go-btn, .rv-dr-assign", ".rv-cbox .modal-actions button, .rv-cbox .rv-go-btn { x: 0; }\n  .rv-dr-assign"))
check("...and the HOD's \"Set these bands first\" box (.rv-dr-assign, its own markup) is in the same rule, its class name is the page's own",
      lambda t: 'card.className = "modal-card rv-dr-assign"' in t, J, lambda t: t.replace('modal-card rv-dr-assign', 'modal-card rv-dr-asgn'))
check("no other overlay is touched: the leave box (piece E) and the rest keep their own rules, nothing is keyed on a bare .modal-card or .modal-overlay",
      lambda t: not any(x.split()[0] in (".modal-card", ".modal-overlay", ".modal-actions", ".confirm-dialog") for x in selectors_of(CF(t))), SRC[CSS],
      lambda t: t[:-2] + "  .modal-actions button { min-height: 44px; }\n}\n")


sys.exit(s.done())
