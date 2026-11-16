"""The phone view, piece F (Chris, "Yes, build as drawn", 2026-11-08; canvas boards F1 to F7; OneHR/Phone view F build brief 2026-11-08.md): under 1024px wide the
leader windows' top bar, AI chips, roster rows, Talent Box names, Profile and Learning, the Grade H taps and the BU CEO's read-only rows have their phone
polish; 1024px and up is the desktop, untouched.

What this suite holds (each check is proved once on a source with its piece taken out, so none can pass by accident):
  * ONE new section in static/style.css, `PHONE VIEW, PIECE F`, after piece E's and the last block of the file, inside @media (max-width: 1023.98px), with no
    rule outside the query; tokens and rem only; nothing underlines on hover; no text under 12px
  * F1  the date chip never shrinks; a long title is rendered in its forms (full, short, and shorter for the larger text sizes) from the template, the full words
        in `title`, the phone rules show one; no script swaps text
  * F2  the chips that repeat a foot button carry data-act (HOD Save, BU CEO / calibrator Lock this calibration) and the phone rules do not draw them while the foot
        has the button; the rest sit in one sideways row, 44px, with a fade set by a class a small resize-aware check sets (never per keystroke); the composer's
        leftover offset is cleared
  * F3  roster names wrap to two lines at most; F4 Talent Box names are 44px; F5 Profile and Learning carry the bar's arrow and the page's name from the template
        and the floating Back is not drawn there (never on an admin page); F5b Learning's four buttons are a two-column grid and the first reads "Find" with the
        full words kept in title and aria-label
  * F6  the Grade H list's View / status links, filters and small text, and the HOD calibration's agree tick, in their own marked phone blocks (light only)
  * F7  the BU CEO's read-only rows, the group band and the warning strip
No real names: the suite database is the synthetic scratch copy.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Phone view, piece F: leader windows polish, Profile and Learning, Grade H taps, the BU CEO's read-only rows")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, EMP = H.actors(a)
REPO = H.REPO
CSS, GCSS, LCSS, JS, TPL_BASE, TPL_SET, TPL_LN = ("static/style.css", "static/gradeh_calib.css", "static/gradeh_lm.css", "static/journey_chat.js", "templates/base.html",
                                                  "templates/settings.html", "templates/learning/shell.html")
SRC = {n: open(os.path.join(REPO, n), encoding="utf-8").read() for n in (CSS, GCSS, LCSS, JS, TPL_BASE, TPL_SET, TPL_LN)}
QUERY = "@media (max-width: 1023.98px) {"
MARK_E, MARK_F = "PHONE VIEW, PIECE E", "PHONE VIEW, PIECE F"


def phone_f(css):
    i = css.rfind(MARK_F)
    j = css.find("\n/* ===== PHONE VIEW, PIECE D", i) if i >= 0 else -1   # piece D's section follows (2026-11-08): F's ends where D's header begins
    return (css[i:j] if j >= 0 else css[i:]) if i >= 0 else ""


def block_after(css, mark):
    i = css.rfind(mark)
    return css[i:] if i >= 0 else ""


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


# ---------------------------------------------------------------------------
s.section("style.css: one new section, after piece E's, the last block, inside the phone query")
F = phone_f
check("piece F's section exists once, after piece E's, and is the LAST block of style.css",
      lambda t: t.count(MARK_F) == 1 and t.find(MARK_E) < t.find(MARK_F) and t.rstrip().split("\n")[-1] == "}", SRC[CSS],
      lambda t: t.replace(MARK_F, "PHONE VIEW, PIECE X"))
check("...opening with the phone query, every rule inside it (the braces close only at the end of the file)",
      lambda t: QUERY in F(t) and F(t).count("\n@media") == 1 and depth_run(F(t)[F(t).index(QUERY):])[-1] == 0
      and all(d > 0 for d in depth_run(F(t)[F(t).index(QUERY):])[:-1]), SRC[CSS],
      lambda t: t[:t.rfind(MARK_F)] + t[t.rfind(MARK_F):].replace(QUERY, "@media (max-width: 1100px) {", 1) + "\n.late { color: red; }\n")
check("the section uses tokens and rem: no hex, rgb() or px font size; hover never underlines",
      lambda t: not re.search(r"#[0-9a-fA-F]{3,6}\b|rgba?\(", F(t)) and not re.search(r"font-size:\s*[\d.]+px", F(t))
      and not re.search(r":hover[^{]*\{[^}]*text-decoration:\s*underline", F(t)), SRC[CSS],
      lambda t: t.replace("\n/* ===== PHONE VIEW, PIECE D", "\n@media (max-width: 1023.98px) { .x { color: #fff; } }\n/* ===== PHONE VIEW, PIECE D", 1))

# ---------------------------------------------------------------------------
s.section("F1: the bar's date chip never shrinks; a long title has its forms, rendered from the template")
check("the chip and the date never shrink (flex: none); the title takes the rest and may shrink",
      lambda t: ".tb-a .tb-cycle { flex: none; }" in F(t) and ".tb-a .tb-cs[hidden] { flex: none;" in F(t) and ".tb-a .tb-ttl[hidden] { flex: 0 1 auto; min-width: 0; }" in F(t),
      SRC[CSS], lambda t: t.replace(".tb-a .tb-cycle { flex: none; }", ".tb-a .tb-cycle { x: 0; }"))
check("the full words go visually hidden (still read) while the short form shows; the shorter form shows at the large and extra large text sizes only",
      lambda t: ".tb-a .tb-ttl .tb-ttl-f { position: absolute;" in F(t) and ".tb-a .tb-ttl .tb-ttl-s[hidden] { display: inline; }" in F(t)
      and "html:is([data-text=l], [data-text=xl]) .tb-a .tb-ttl .tb-ttl-x[hidden] { display: inline; }" in F(t), SRC[CSS],
      lambda t: t.replace(".tb-a .tb-ttl .tb-ttl-s[hidden] { display: inline; }", ".tb-a .tb-ttl .tb-ttl-s { x: 0; }"))

SNIP = re.search(r"\{% set _ttl = .*?\{% endif %\}</span>", SRC[TPL_BASE], re.S).group(0)


def render_title(t, ttl):
    src = t.replace("\n", " ")
    return a.app.jinja_env.from_string(src).render(view="x", _vt=ttl)


for full, short, xs in (("Business unit calibration", "BU calibration", "BU calibration"), ("Business group Talent Box", "BG Talent Box", "BG Talent Box"),
                        ("Your leaders' Talent Box", "Leaders' Talent Box", "Leaders' box"), ("Department Review", "Department Review", "Dept Review"),
                        ("Group Talent Box", "Group Talent Box", "Group box")):
    html = render_title(SNIP, full)
    ok = (('title="%s"' % full.replace("'", "&#39;")) in html and ('<span class="tb-ttl-f">%s</span>' % full.replace("'", "&#39;")) in html
          and ('<span class="tb-ttl-s" aria-hidden="true" hidden>%s</span>' % short.replace("'", "&#39;")) in html
          and ('<span class="tb-ttl-x" aria-hidden="true" hidden>%s</span>' % xs.replace("'", "&#39;")) in html)
    s.check("%s: full title in title and in a visually hidden span, short %r and shorter %r rendered hidden" % (full, short, xs), ok, html)
s.check("a title with no short form (My check-in) is the plain text, as before", render_title(SNIP, "Team Review").count("tb-ttl-") == 0
        and ">Team Review</span>" in render_title(SNIP, "Team Review"))
falsify("the title forms", lambda t: '<span class="tb-ttl-s" aria-hidden="true" hidden>BU calibration</span>' in render_title(t, "Business unit calibration"), SNIP,
        lambda t: t.replace("'BU calibration', 'BU calibration'", "'BU calibr', 'BU calibr'"))
check("no script swaps a title: journey_chat.js never writes .tb-ttl",
      lambda t: "tb-ttl" not in t, SRC[JS], lambda t: t + "\ndocument.querySelector('.tb-ttl').textContent = 'x';")

# ---------------------------------------------------------------------------
s.section("F2: the chips that repeat a foot button are marked; the rest are one sideways row")
JSX = SRC[JS]
check("the HOD's Save chip and the BU CEO's / calibrator's Lock chip carry the foot's action",
      lambda t: 'out.push({ label: "Save", act: "save",' in t and 'out.push({ label: "Lock this calibration", act: "lock",' in t
      and 'if (c.act) b.setAttribute("data-act", c.act);' in t, JSX, lambda t: t.replace('act: "lock",', ""))
check("the phone rules do not draw a marked chip while the foot has its button (Save: .rv-dr-save; Lock: .rv-cal-lockform .rv-cal-lock)",
      lambda t: '#rv-chat:has(.rv-cal-foot .rv-dr-save) #rv-chat-quick .rv-chip[data-act="save"]' in F(t)
      and '#rv-chat:has(.rv-cal-foot .rv-cal-lockform .rv-cal-lock) #rv-chat-quick .rv-chip[data-act="lock"],' in F(t)
      and '.rv-chip[data-act="approve-plan"] { display: none; }' in F(t), SRC[CSS],
      lambda t: t.replace('.rv-chip[data-act="approve-plan"] { display: none; }', '.rv-chip[data-act="approve-plan"] { x: 0; }'))
check("the line manager's confirm chips (Lock it, Approve the review, Approve the plan) are marked with their foot button's action and hidden while that button is on the page",
      lambda t: 'var FOOT_CHIP_ACT = { "Lock it": "lock-kpi", "Approve the review": "approve-review", "Approve the plan": "approve-plan" };' in t
      and 'if (FOOT_CHIP_ACT[t]) b.setAttribute("data-act", FOOT_CHIP_ACT[t]);' in t, JSX, lambda t: t.replace('if (FOOT_CHIP_ACT[t]) b.setAttribute("data-act", FOOT_CHIP_ACT[t]);', ""))
check("...each to its foot button's own class (Confirm & lock .rv-mod-lockall, Confirm & lock review .rv-mod-go, Approve plan .rv-idp-approve)",
      lambda t: all(x in F(t) for x in ('#rv-chat:has(.rv-sum-foot .rv-mod-lockall) #rv-chat-quick .rv-chip[data-act="lock-kpi"]',
                                        '#rv-chat:has(.rv-sum-foot .rv-mod-go:not(.rv-idp-approve)) #rv-chat-quick .rv-chip[data-act="approve-review"]',
                                        '#rv-chat:has(.rv-idp-foot .rv-idp-approve) #rv-chat-quick .rv-chip[data-act="approve-plan"]')), SRC[CSS],
      lambda t: t.replace('#rv-chat:has(.rv-sum-foot .rv-mod-lockall) #rv-chat-quick .rv-chip[data-act="lock-kpi"]', '#rv-chat:has(.rv-sum-foot .rv-mod-lockallx) #rv-chat-quick .rv-chip[data-act="lock-kpi"]'))
check("the other chips: one row, no wrap, scrolling sideways inside itself, 44px, the fade a class, the page's scroll chaining stopped",
      lambda t: "#rv-chat-quick { flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; max-height: none;" in F(t) and "#rv-chat-quick .rv-chip { flex: none; min-height: 44px;" in F(t)
      and "#rv-chat-quick.rv-quick-more { -webkit-mask-image:" in F(t) and "overscroll-behavior-x: contain" in F(t), SRC[CSS],
      lambda t: t.replace("#rv-chat-quick { flex-wrap: nowrap;", "#rv-chat-quick { flex-wrap: wrap;"))
check("the fade class is set by a small check run when chips are painted, when the row scrolls and when the window resizes, only on a phone, never per keystroke",
      lambda t: 'quick.classList.toggle("rv-quick-more", onPhone() && quick.scrollWidth - quick.scrollLeft - quick.clientWidth > 2);' in t
      and 'quick.addEventListener("scroll", phQuickFade, { passive: true }); window.addEventListener("resize", phQuickFade);' in t
      and t.count("phQuickFade();") == 2 and "keyup" not in t.split("function phQuickFade")[1].split("function ")[0], JSX,
      lambda t: t.replace('window.addEventListener("resize", phQuickFade);', ""))
check("the composer's leftover top / bottom offset (from the older sticky bar) is cleared, so it never sits over the chips",
      lambda t: "#rv-chat-form.rv-composer { top: auto; bottom: auto; }" in F(t), SRC[CSS],
      lambda t: t.replace("#rv-chat-form.rv-composer { top: auto; bottom: auto; }", ""))

# ---------------------------------------------------------------------------
s.section("F3, F4: roster names, Talent Box names")
check("a roster name wraps to two lines at most (a line clamp), the job or unit under it, wrapping too",
      lambda t: "-webkit-line-clamp: 2" in F(t) and ".rv-cal-review .rv-cal-pname," in F(t) and ".rv-calib-pin .rv-calib-roster-tbl.is-curve .rv-cal-pname {" in F(t)
      and "flex-direction: column; align-items: flex-start;" in F(t) and ".rv-ph-job[hidden]" in F(t), SRC[CSS],
      lambda t: t.replace("-webkit-line-clamp: 2", "-webkit-line-clamp: 1"))
check("a Talent Box name is a 44px tap; its group label's text is 12px",
      lambda t: "button.rv-tbox-pname { display: flex; align-items: center; min-height: 44px;" in F(t) and "#rv-chat .rv-tbox-grp { font-size: 0.75rem; }" in F(t), SRC[CSS],
      lambda t: t.replace("button.rv-tbox-pname { display: flex; align-items: center; min-height: 44px;", "button.rv-tbox-pname { display: flex; align-items: center; min-height: 0;"))

# ---------------------------------------------------------------------------
s.section("F5, F5b: Profile and Learning")
check("the floating Back is not drawn while the bar holds the arrow, and never on an admin page",
      lambda t: "body:has(.tb-a .tb-back) .fab-back:not(.is-admin) { display: none; }" in F(t), SRC[CSS],
      lambda t: t.replace("body:has(.tb-a .tb-back) .fab-back:not(.is-admin) { display: none; }", ""))
check("the bar's arrow takes the page's name from the template (tb_title), stays off an admin bar, and steps back as the floating button does",
      lambda t: "{% elif tb_title is defined and tb_title and not nav_is_admin %}" in t and 'data-fab-back aria-label="Go back to the previous page" hidden>' in t
      and "document.querySelector('.tb-back[data-fab-back]')" in t and "bar.addEventListener('click', step);" in t, SRC[TPL_BASE],
      lambda t: t.replace("bar.addEventListener('click', step);", ""))
check("Profile and Learning set their bar title (Learning's arrow goes to the Dashboard, as its Back does)",
      lambda t: "{% set tb_title = 'Profile' %}" in t, SRC[TPL_SET], lambda t: t.replace("{% set tb_title = 'Profile' %}", ""))
check("Learning sets its title and its arrow's way", lambda t: "{% set tb_title = 'Learning' %}" in t and "{% set tb_back_href = url_for('dashboard') %}" in t, SRC[TPL_LN],
      lambda t: t.replace("{% set tb_title = 'Learning' %}", ""))
emp_prof = H.client_as(a, EMP["id"]).get("/profile")
ph = emp_prof.get_data(as_text=True)
s.check("Profile (a staff login): the bar holds the arrow and the name 'Profile' (hidden until the phone rules show them); the floating Back is still rendered",
        emp_prof.status_code == 200 and re.search(r'<a class="tb-back" href="[^"]*" data-fab-back aria-label="Go back to the previous page" hidden>', ph)
        and '<span class="tb-ttl" hidden title="Profile">Profile</span>' in ph and 'id="floating-back"' in ph, emp_prof.status_code)
falsify("the Profile bar", lambda t: '<span class="tb-ttl" hidden title="Profile">Profile</span>' in t, ph, lambda t: t.replace('title="Profile">Profile</span>', 'title="Profile">Prof</span>'))
adm_prof = H.client_as(a, SU["id"]).get("/profile")
s.check("Profile (a super admin): no arrow, no title in the bar (the admin pages keep their floating Back)",
        adm_prof.status_code in (200, 302) and "data-fab-back" not in adm_prof.get_data(as_text=True), adm_prof.status_code)
check("Learning's four buttons: a two-column grid, 44px, the icon beside the words, a label may wrap",
      lambda t: ".ln-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }" in F(t) and "min-height: 44px; box-sizing: border-box; padding: 6px 12px;" in F(t)
      and ".ln-tabs .ln-tab-l { min-width: 0; overflow-wrap: anywhere;" in F(t), SRC[CSS],
      lambda t: t.replace(".ln-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }", ".ln-tabs { display: flex; }"))
check("the first button renders 'Find' for a phone beside 'Find and register', the full words in title and aria-label of the button; the phone rules show 'Find' and hide the full",
      lambda t: '<span class="ln-tab-f">{{ t.label }}</span><span class="ln-tab-s" aria-hidden="true" hidden>Find</span>' in t
      and "{% if t.label == 'Find and register' %} title=\"{{ t.label }}\" aria-label=\"{{ t.label }}\"{% endif %}" in t, SRC[TPL_LN],
      lambda t: t.replace(' aria-label="{{ t.label }}"{% endif %}', "{% endif %}"))
check("...and the phone section hides the full label and shows the short one", lambda t: ".ln-tab-l .ln-tab-f { display: none; }" in F(t) and ".ln-tab-l .ln-tab-s[hidden] { display: inline; }" in F(t),
      SRC[CSS], lambda t: t.replace(".ln-tab-l .ln-tab-f { display: none; }", ""))
check("the small taps the canvas left: Chairman's row arrows and BU chips, Profile's name box and Save, Learning's switch, calendar link, chips and Send",
      lambda t: all(x in F(t) for x in ("#rv-chat .rv-tbox-busnav { width: 44px; height: 44px; }", "#rv-chat .rv-tbox-bu { min-height: 44px;", "#st-name { min-height: 44px;", ".st-save, .st-link { min-height: 44px; }",
                                        ".ln-vs a { display: flex;", ".ln-frame-h a.btn-link {", ".ln-chip { min-height: 44px;", ".ln-send { width: 44px; height: 44px; }", ".ln-comp input { height: 44px; }", "#rv-modtabs a.rv-mt-step { min-height: 44px; }")), SRC[CSS],
      lambda t: t.replace(".ln-send { width: 44px; height: 44px; }", ""))

# ---------------------------------------------------------------------------
s.section("F6: Grade H, in each file's own marked phone block (these files stay light)")
GL, GC = SRC[LCSS], SRC[GCSS]
check("gradeh_lm.css: the last block is piece F's, inside the phone query: View / status links 44px with a negative margin, filters 44px, small text 12px, all keyed on #ghl-page",
      lambda t: MARK_F in t and QUERY in block_after(t, MARK_F) and t.rstrip().endswith("}")
      and "#ghl-page .ghl-table a.ghl-link { display: inline-flex; align-items: center; min-height: 44px;" in block_after(t, MARK_F) and "margin: -14px -8px;" in block_after(t, MARK_F)
      and "#ghl-page a.ghl-pill { height: auto; min-height: 44px;" in block_after(t, MARK_F) and "font-size: 0.75rem" in block_after(t, MARK_F)
      and all(l.strip().startswith("#ghl-page") for l in block_after(t, MARK_F).split("\n") if l.startswith("  #") or l.startswith("  .")), GL,
      lambda t: t.replace("min-height: 44px; box-sizing: border-box; padding: 0 8px; margin: -14px -8px;", "padding: 0 8px;"))
check("gradeh_calib.css: piece E's block is followed by piece F's: the agree tick's input is a transparent 44x44 target and the 22px box is drawn on the cell (checked, disabled, focus)",
      lambda t: t.find(MARK_E) < t.find(MARK_F) and QUERY in block_after(t, MARK_F) and t.rstrip().endswith("}")
      and "#ghc-page .ghc-table td.c-tick input { position: absolute; inset: 0; width: 44px; height: 44px; margin: 0; opacity: 0;" in block_after(t, MARK_F)
      and "td.c-tick:has(input:checked)::after" in block_after(t, MARK_F) and "td.c-tick:has(input:disabled)::before" in block_after(t, MARK_F)
      and "td.c-tick:has(input:focus-visible)::before" in block_after(t, MARK_F)
      and all(l.strip().startswith("#ghc-page") for l in block_after(t, MARK_F).split("\n") if l.startswith("  #") or l.startswith("  .")), GC,
      lambda t: t.replace("width: 44px; height: 44px; margin: 0; opacity: 0;", "width: 22px; height: 22px; margin: 0;"))
check("the tick's input is still a real checkbox named agree in the page (a label, a form, a disabled state)",
      lambda t: 'type="checkbox" name="agree"' in t and 'aria-label="Agree with {{ r.name }}"' in t,
      open(os.path.join(REPO, "templates/gradeh_calib.html"), encoding="utf-8").read(), lambda t: t.replace('name="agree"', 'name="agr"'))

# ---------------------------------------------------------------------------
s.section("F7: the BU CEO's list: read-only rows, the group band, the warning strip")
check("a read-only row lays its cells in its own single column (the live rows' grid area is cleared: the tag was drawn first as a cut-off chip above the name)",
      lambda t: ".rv-calib-pin .rv-calib-roster-tbl.is-curve tbody tr.is-other { grid-template-columns: minmax(0, 1fr); gap: 4px; }" in F(t)
      and "tbody tr.is-other > td { grid-area: auto; grid-column: 1; width: auto; }" in F(t) and ".rv-cal-bytag { max-width: 100%; white-space: normal;" in F(t), SRC[CSS],
      lambda t: t.replace("tbody tr.is-other > td { grid-area: auto; grid-column: 1; width: auto; }", ""))
check("the group band ('Calibrated by their BU group') is a block row, so it takes the full width",
      lambda t: ".rv-calib-pin .rv-calib-roster-tbl.is-curve tr.rv-cal-otherhead { display: block; }" in F(t), SRC[CSS],
      lambda t: t.replace("tr.rv-cal-otherhead { display: block; }", "tr.rv-cal-otherhead { x: 0; }"))
check("the warning strip is a grid: the lead wraps, the names stay one line the widget fits, the button on the right; no ellipsis on the lead",
      lambda t: '"ico lead more" "ico names more"' in F(t) and ".rv-ph-openstrip .rv-cal-openstrip-lead { grid-area: lead; overflow: visible; text-overflow: clip; white-space: normal;" in F(t),
      SRC[CSS], lambda t: t.replace("grid-area: lead; overflow: visible; text-overflow: clip; white-space: normal;", "grid-area: lead;"))

sys.exit(s.done())
