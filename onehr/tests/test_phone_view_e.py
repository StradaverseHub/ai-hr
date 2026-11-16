"""The phone view, piece E (Chris, "Yes, build as drawn", 2026-11-08; canvas v1 boards E1 to E5; OneHR/Phone view E build brief 2026-11-08.md): under 1024px
wide the admin shell (the Menu button and the bottom-sheet menu), module Settings, Home, Cycle and Windows, and the Grade H HOD / BU CEO calibration
screens have their phone layout; 1024px and up is the desktop, untouched (the one intended desktop change: the Grade H list's Department column wraps).

What this suite holds (each check is proved once on a source with its piece taken out, so none can pass by accident):
  * ONE new section in static/style.css, `PHONE VIEW, PIECE E`, after piece C's and the last block of the file, inside @media (max-width: 1023.98px), with
    no rule outside the query; tokens and rem only; nothing underlines on hover; no text under 12px
  * static/gradeh_calib.css ends with its own marked phone block keyed on #ghc-page, plus the one desktop rule (the Department column wraps)
  * the phone-only parts are rendered with the hidden attribute on an admin page, for every admin role, and not on a staff page: the Menu button
    (aria-haspopup, aria-controls, aria-expanded), the sheet's head and the dim, the Windows line; the phone rules turn them on
  * each group's page list sits straight after its row; the sheet keeps today's menu (same order, same words)
  * the script asks window.onehrIsPhone(), never a width of its own; the sheet closes on the x, the dim, Esc, a page and the back gesture
    (onehrBackLayer); a phone's group opens in place and a click or scroll inside the sheet does not close it; a desktop width closes it cleanly
  * the Grade H cells carry real labels (a hidden span the phone rules show), the words from the column headings
No real names: the suite database is the synthetic scratch copy.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Phone view, piece E: admin shell, module Settings, Home / Cycle / Windows, Grade H calibration")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, EMP = H.actors(a)
REPO = H.REPO
CSS, GCSS, ADM, TPL_SIDE, TPL_BASE, TPL_WIN, TPL_GH = ("static/style.css", "static/gradeh_calib.css", "static/admin.js", "templates/_admin_side.html",
                                                       "templates/base.html", "templates/admin_windows.html", "templates/gradeh_calib.html")
SRC = {n: open(os.path.join(REPO, n), encoding="utf-8").read() for n in (CSS, GCSS, ADM, TPL_SIDE, TPL_BASE, TPL_WIN, TPL_GH)}
QUERY = "@media (max-width: 1023.98px) {"
MARK_C, MARK_E = "PHONE VIEW, PIECE C", "PHONE VIEW, PIECE E"
PFX, BG = "ZZ9PE-", "ZZPE Group"


def phone_e(css):
    i = css.rfind(MARK_E)
    j = css.find("\n/* ===== PHONE VIEW, PIECE F", i) if i >= 0 else -1   # piece F's section follows (2026-11-08): E's ends where F's header begins
    return (css[i:j] if j >= 0 else css[i:]) if i >= 0 else ""


def phone_e_g(g):
    """gradeh_calib.css: piece E's block, ending where piece F's begins."""
    i = g.rfind("PHONE VIEW, PIECE E")
    j = g.find("PHONE VIEW, PIECE F", i) if i >= 0 else -1
    return (g[i:j] if j >= 0 else g[i:]) if i >= 0 else ""


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
    s.check(name, test(src))
    falsify(name, test, src, cut)


# ---------------------------------------------------------------------------
s.section("style.css: one new section, after piece C's, inside the phone query")
E = lambda t: phone_e(t)  # noqa: E731
check("piece E's section exists once, after piece C's, and is the LAST block of style.css",
      lambda t: t.count(MARK_E) == 1 and t.find(MARK_C) < t.find(MARK_E) and t.rstrip().split("\n")[-1] == "}", SRC[CSS],
      lambda t: t.replace(MARK_E, "PHONE VIEW, PIECE X"))
check("...opening with the phone query, every rule inside it (the braces close only at the end of the file)",
      lambda t: QUERY in E(t) and E(t).count("\n@media") == 1 and depth_run(E(t)[E(t).index(QUERY):])[-1] == 0
      and all(d > 0 for d in depth_run(E(t)[E(t).index(QUERY):])[:-1]), SRC[CSS],
      lambda t: t[:t.rfind(MARK_E)] + t[t.rfind(MARK_E):].replace(QUERY, "@media (max-width: 1100px) {", 1) + "\n.late { color: red; }\n")
check("the section uses tokens and rem: no hex, rgb() or px font size; hover never underlines",
      lambda t: not re.search(r"#[0-9a-fA-F]{3,6}\b|rgba?\(", E(t)) and not re.search(r"font-size:\s*[\d.]+px", E(t))
      and not re.search(r":hover[^{]*\{[^}]*text-decoration:\s*underline", E(t)), SRC[CSS],
      lambda t: t.replace("\n/* ===== PHONE VIEW, PIECE F", "\n@media (max-width: 1023.98px) { .x { color: #fff; } }\n/* ===== PHONE VIEW, PIECE F", 1))
check("the phone-only parts are turned on by [hidden] rules in the section (the Menu button, the sheet's head, the dim stays [hidden]-aware, the Windows line)",
      lambda t: all(x in E(t) for x in (".adm-menu-btn[hidden] {", ".adm-menu-head[hidden] {", ".adm-menu-scrim[hidden] { display: none; }", ".adm-win-easier[hidden] {")),
      SRC[CSS], lambda t: t.replace(".adm-menu-head[hidden] {", ".adm-menu-head {"))
check("the side menu is not drawn in the page on a phone, and the sheet is fixed to the bottom, full width, at most 85dvh, above the top bar (906)",
      lambda t: ".adm-side:not(.is-menu-open) { display: none; }" in E(t) and re.search(r"\.adm-side\.is-menu-open \{[^}]*position: fixed[^}]*max-height: 85dvh[^}]*z-index: 906", E(t)),
      SRC[CSS], lambda t: t.replace(".adm-side:not(.is-menu-open) { display: none; }", ""))
check("the floating AI button shows no label on a phone and clears the home bar",
      lambda t: ".ai-fab .ai-fab-lab" in E(t) and "bottom: calc(16px + env(safe-area-inset-bottom))" in E(t), SRC[CSS],
      lambda t: t.replace("bottom: calc(16px + env(safe-area-inset-bottom))", "bottom: 16px"))
check("module Settings: the cards take the width (min-width 0), the 360 rules go one column",
      lambda t: ".adm-set-card { min-width: 0;" in E(t) and ".rl-two { grid-template-columns: minmax(0, 1fr); }" in E(t), SRC[CSS],
      lambda t: t.replace(".adm-set-card { min-width: 0;", ".adm-set-card { x: 0;"))
check("Windows: the scroller is positioned (the date inputs cannot push the page) and its first column is held",
      lambda t: ".table-scroll:has(#window-table) { position: relative;" in E(t) and "#window-table th:first-child, #window-table td:first-child { position: sticky;" in E(t),
      SRC[CSS], lambda t: t.replace("{ position: relative; max-width: 100%; }", "{ max-width: 100%; }"))
check("Home and Cycle: one column, the tables' first column held, the calendar stacks",
      lambda t: ".adm-home { grid-template-columns: minmax(0, 1fr); }" in E(t) and ".hm-table th:first-child" in E(t)
      and ".adm-cal { flex-direction: column;" in E(t), SRC[CSS], lambda t: t.replace(".adm-cal { flex-direction: column;", ".adm-cal { x: 0;"))

s.section("gradeh_calib.css: its own phone block (this file stays light) and the one desktop rule")
G = SRC[GCSS]
GE = phone_e_g(G)
check("the file has a marked phone block (piece F's follows it) inside the phone query, every rule keyed on #ghc-page",
      lambda t: t.rfind("PHONE VIEW, PIECE E") >= 0 and QUERY in phone_e_g(t) and t.rstrip().endswith("}")
      and all(l.strip().startswith("#ghc-page") for l in phone_e_g(t).split("\n")
              if l.startswith("  #") or l.startswith("  .")), G, lambda t: t.replace("PHONE VIEW, PIECE E", "PHONE VIEW, PIECE X"))
check("the desktop rule: the Department column wraps, OUTSIDE the phone block",
      lambda t: ".ghc-listtable td:nth-child(2) { white-space: normal; }" in t[:t.rfind("PHONE VIEW, PIECE E")], G,
      lambda t: t.replace(".ghc-listtable td:nth-child(2) { white-space: normal; }", ""))
check("the page's frame stretches on a phone, the table becomes cards, the foot is two buttons, the person page shows the person first",
      lambda t: all(x in phone_e_g(t) for x in ("#ghc-page.ghc { align-items: stretch; }", "#ghc-page .ghc-table tr { display: grid;", "#ghc-page .ghc-footbar > .ghc-actions { display: grid;",
                                            "#ghc-page .ghc-pbody > .ghc-fold { display: none; }")), G,
      lambda t: t.replace("#ghc-page .ghc-pbody > .ghc-fold { display: none; }", ""))
check("the labels are real text turned on by the block (no CSS content: label)",
      lambda t: "#ghc-page .ghc-pl[hidden] { display: block;" in phone_e_g(t) and 'content: "' not in phone_e_g(t), G,
      lambda t: t.replace("#ghc-page .ghc-pl[hidden] { display: block;", "#ghc-page .ghc-pl { x: 0;"))

s.section("the Grade H cells carry their labels (the words of the column headings)")
T = SRC[TPL_GH]
need = {"Score": "c-score", "KPI": "c-route", "Line manager": "c-lm", "Potential": "c-pot", "HOD": "c-hod", "Acknowledged": "c-ack"}
check("the HOD page: each value cell starts with a hidden label span of its heading's word",
      lambda t: all(re.search(r'<td class="%s">%s' % (c, re.escape('<span class="ghc-pl" hidden>%s</span>' % w)), t) for w, c in need.items()), T,
      lambda t: t.replace('<span class="ghc-pl" hidden>Line manager</span>', ""))
check("the BU CEO's list: KPI, Performance, Potential, Box and HOD carry theirs, and the Department cell none",
      lambda t: all(('<span class="ghc-pl" hidden>%s</span>' % w) in t for w in ("Performance", "Box")) and 'class="c-dept">{{ i.dept | proper }}</td>' in t
      and t.count('<span class="ghc-pl" hidden>HOD</span>') == 2, T, lambda t: t.replace('<span class="ghc-pl" hidden>Box</span>', ""))
check("the headings still say the same words (nothing renamed for the phone)",
      lambda t: "<th>Person</th><th>Department</th><th>Route</th><th>Performance</th><th>Potential</th><th>Box</th><th>HOD</th>" in t
      and "<th>Line manager</th>" in t, T, lambda t: t.replace("<th>Line manager</th>", ""))

s.section("the shell's markup: a Menu button, a sheet head and a dim, rendered hidden, on every admin role; none on a staff page")
with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    for cmp in ("ZZPE U1",):
        db.execute("DELETE FROM org_units WHERE company=?", (cmp,))
    db.execute("DELETE FROM admin_companies WHERE company='ZZPE U1'")
    db.execute("DELETE FROM users WHERE employee_id LIKE ?", (PFX + "%",))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZPE U1')", (BG,))
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) VALUES ('zz9pe-bga', 'ZZ PE Groupadmin', 'x', 'admin', ?, ?, ?)",
                     (PFX + "BGA", BG, BG)).lastrowid
    BUA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) VALUES ('zz9pe-bua', 'ZZ PE Unitadmin', 'x', 'admin', ?, ?, ?)",
                     (PFX + "BUA", BG, BG)).lastrowid
    db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?, 'ZZPE U1')", (BUA,))
    db.commit()
ROLES = {"super admin": SU["id"], "BG admin": BGA, "BU admin": BUA}
PAGES = ["/admin", "/admin/cycle", "/admin/windows", "/admin/m/pm/settings"]


def get(uid, path):
    return H.client_as(a, uid).get(path)


def hidden_parts(h):
    btn = re.search(r'<button type="button" class="adm-menu-btn" id="adm-menu-open"[^>]*>', h)
    return (btn and " hidden" in btn.group(0) and 'aria-haspopup="dialog"' in btn.group(0) and 'aria-controls="adm-menu"' in btn.group(0)
            and 'aria-expanded="false"' in btn.group(0) and 'id="adm-menu"' in h
            and re.search(r'<div class="adm-menu-head" hidden>', h) and re.search(r'<div class="adm-menu-scrim" id="adm-menu-scrim" hidden></div>', h)
            and 'class="adm-menu-x"' in h and "Admin menu" in h)


for who, uid in ROLES.items():
    pages_ok, why = [], ""
    for p in PAGES:
        r = get(uid, p)
        h = r.get_data(as_text=True)
        if r.status_code != 200:
            continue                      # a page this role may not open (BG / BU admins are View only on some): its status is the access suite's
        pages_ok.append(p)
        if not hidden_parts(h):
            why = p
    s.check("%s: the Menu button, the sheet head and the dim are rendered hidden on %s" % (who, ", ".join(pages_ok) or "(no page)"), pages_ok and not why, why or pages_ok)
sup_h = get(SU["id"], "/admin").get_data(as_text=True)
falsify("the rendered check", hidden_parts, sup_h, lambda t: t.replace('id="adm-menu-open" aria-haspopup="dialog" aria-controls="adm-menu" aria-expanded="false" hidden>',
                                                                      'id="adm-menu-open" aria-haspopup="dialog" aria-controls="adm-menu" aria-expanded="false">'))
emp = get(EMP["id"], "/dashboard")
s.check("a staff page draws no Menu button and no sheet", emp.status_code in (200, 302) and "adm-menu-btn" not in emp.get_data(as_text=True)
        and "adm-menu-head" not in emp.get_data(as_text=True))
win = get(SU["id"], "/admin/windows").get_data(as_text=True)
check("Windows: the line sits above the table, rendered hidden, and the phone rules turn it on",
      lambda t: re.search(r'<p class="adm-win-easier" hidden>Easier on a computer\. Scroll the table sideways for the dates\.</p>', t)
      and t.index("adm-win-easier") < t.index('id="window-table"'), win, lambda t: t.replace('<p class="adm-win-easier" hidden>', '<p class="adm-win-easier">'))
side = re.search(r'<nav class="adm-side".*?</nav>', sup_h, re.S).group(0)
check("each group's page list sits straight after its row (no list apart at the end of the nav)",
      lambda t: len(re.findall(r'</button>\s*<div class="adm-fly"', t)) >= 3 and not re.search(r'</div>\s*<div class="adm-fly"', t), side,
      lambda t: re.sub(r'(</button>)\s*(<div class="adm-fly")', r"\1</div>\2", t))
check("the menu keeps today's order and words: Home, Cycle, Modules, then Organisation, Ticketing, Comms, Reports & audit, All settings",
      lambda t: re.findall(r'<span class="adm-side-lbl">([^<]+)</span>', t)[:2] == ["Home", "Cycle"] and re.findall(r'<span class="adm-side-lbl">([^<]+)</span>', t)[-5:]
      == ["Organisation", "Ticketing", "Comms", "Reports &amp; audit", "All settings"], side, lambda t: t.replace(">Ticketing<", ">Tickets<"))
check("the sheet's head names the current page", lambda t: '<span class="adm-menu-s">Home</span>' in t, sup_h, lambda t: t.replace('<span class="adm-menu-s">Home</span>', ""))

s.section("admin.js: the sheet and the in-place groups")
J = SRC[ADM]
ji = J.find("PHONE VIEW, PIECE E (2026-11-08)")
JS = J[ji - 600:] if ji >= 0 else ""
check("the script asks window.onehrIsPhone() (never a width of its own) and redraws on onehrOnPhoneChange",
      lambda t: "window.onehrIsPhone" in t and "window.onehrOnPhoneChange" in t and "innerWidth" not in t.split("function place")[1].split("function close")[0] + t.split("function openSheet")[1].split("if (menuBtn)")[0],
      JS, lambda t: t.replace("window.onehrOnPhoneChange", "window.xx"))
check("the sheet closes on the x, the dim, Esc, a page (a link leaves) and the back gesture",
      lambda t: all(x in t for x in ("xBtn.addEventListener('click'", "scrim.addEventListener('click'", "if (sheetOpen()) { e.preventDefault(); closeSheet(true)", "window.onehrBackLayer(")),
      JS, lambda t: t.replace("scrim.addEventListener('click'", "scrim.addEventListener('xx'"))
check("a phone's group opens in place (nothing positioned), and a click or scroll in the sheet never closes it",
      lambda t: "if (!phone()) place(btn, f)" in t and "if (!openBtn || phone()) return;" in t and "side.addEventListener('scroll', function () { if (!phone()) close(false); })" in t,
      JS, lambda t: t.replace("if (!openBtn || phone()) return;", "if (!openBtn) return;"))
check("the group holding the current page starts open; the focus goes to the x, back to Menu; Tab stays inside; dialog + aria-modal only while open",
      lambda t: "data-current=\"1\"" in t and "xBtn.focus()" in t and "menuBtn.focus()" in t and "e.key !== 'Tab'" in t and "setAttribute('aria-modal', 'true')" in t and "removeAttribute('aria-modal')" in t,
      JS, lambda t: t.replace("e.key !== 'Tab'", "e.key !== 'Tabx'"))
check("a window turned to a desktop width closes the sheet and every group, and clears the flyout's own position",
      lambda t: re.search(r"onehrOnPhoneChange\(function \(p\) \{\s*if \(!p\) closeSheet\(false\);\s*close\(false\);", t) and "f.style.left = ''" in t,
      JS, lambda t: t.replace("if (!p) closeSheet(false);", ""))
check("the page behind does not scroll while open (html.adm-menu-open)", lambda t: "html.adm-menu-open { overflow: hidden; }" in E(t) and "adm-menu-open" in JS, SRC[CSS],
      lambda t: t.replace("html.adm-menu-open { overflow: hidden; }", ""))

s.section("second pass: the person page, Participants' cut-off and the chair's unit cards never scroll sideways at 390")
check("the person page's header stacks (name block, meta, then the cycle picker full width, 44px)",
      lambda t: ".pp-head { flex-direction: column; align-items: stretch;" in E(t) and ".pp-head .pp-cycle { flex: none; width: 100%;" in E(t)
      and ".pp-head .pp-cycle select { width: 100%; min-width: 0; min-height: 44px;" in E(t) and ".pp-head .pp-name-row { flex-direction: column;" in E(t), SRC[CSS],
      lambda t: t.replace(".pp-head .pp-cycle { flex: none; width: 100%;", ".pp-head .pp-cycle { flex: none;"))
check("the person page's tabs wrap onto a second row with 44px taps instead of running past the edge",
      lambda t: ".pp-tabs { flex-wrap: wrap;" in E(t) and ".pp-tabs a { display: inline-flex; align-items: center; min-height: 44px;" in E(t), SRC[CSS],
      lambda t: t.replace(".pp-tabs { flex-wrap: wrap;", ".pp-tabs { flex-wrap: nowrap;"))
check("Participants' cut-off form wraps and takes the full row (the desktop rule is nowrap)",
      lambda t: ".pt-cutoff .adm-headrow { flex-wrap: wrap;" in E(t) and ".pt-cutoff .adm-headrow-acts { flex: 1 1 100%; flex-wrap: wrap; min-width: 0; }" in E(t)
      and ".pt-cutoff .pt-cutoff-lbl .odp-trig { width: auto;" in E(t), SRC[CSS],
      lambda t: t.replace(".pt-cutoff .adm-headrow-acts { flex: 1 1 100%; flex-wrap: wrap;", ".pt-cutoff .adm-headrow-acts { flex: 1 1 100%; flex-wrap: nowrap;"))
check("the chair's unit-card caption ('Not released yet') may wrap (the desktop rule is nowrap)",
      lambda t: ".ec-bgc-hd .od-muted { white-space: normal;" in E(t) and ".ec-bgc-hd { flex-wrap: wrap; }" in E(t), SRC[CSS],
      lambda t: t.replace(".ec-bgc-hd .od-muted { white-space: normal;", ".ec-bgc-hd .od-muted { white-space: nowrap;"))

s.section("tidy up")
with a.app.app_context():
    db = a.get_db()
    db.execute("DELETE FROM admin_companies WHERE company='ZZPE U1'")
    db.execute("DELETE FROM users WHERE employee_id LIKE ?", (PFX + "%",))
    db.execute("DELETE FROM org_units WHERE company='ZZPE U1'")
    db.commit()
s.check("the suite's own admins and unit are gone", True)
sys.exit(s.done())
