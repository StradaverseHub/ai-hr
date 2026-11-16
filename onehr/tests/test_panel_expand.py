"""Every admin side panel can take the full width, a calibration group's Remove column stays on screen, and a save made
inside a panel comes back where you were (Chris, 2026-11-04: at larger text sizes Remove was cut off the right edge of the
720px panel, and after Remove the 128-row list reopened at the top).

What this suite holds:
  * the shared `panel` macro renders the Full width toggle on a default, a mid, a wide and a nav panel, once each, with
    aria-pressed="false" and the label "Full width" (falsified: a render with the toggle cut out fails the same check)
  * the calibration groups page renders the members table with `gc-act` on the last header AND on every action cell
    (Remove and Locked alike), one cell per member row
  * the CSS: `.adm-panel.is-max` is the viewport width and beats the per-panel widths; the pinned column is sticky at
    right 0, opaque (a token, never transparent) and the corner cell sits above the others; no literal colour
  * admin.js: localStorage `onehr.panel.max.<key>` and sessionStorage hooks, each inside try/catch, the title/aria text
    "Full width" / "Back to the side", the submit hooks (bubble-phase submit event AND form.submit()), a 2 minute window
  * the rules the lint suites enforce are not broken by the new CSS (colour tokens, rem, no hover underline)
Synthetic (ZZPX-*) on the shared suite database; everything is put back at the end.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Admin panels: Full width toggle, pinned Remove column, scroll kept after a save")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _EMP = H.actors(a)
REPO = H.REPO
BG, CO = "ZZPX Group", "ZZPX Group Sdn Bhd"
CSS = open(os.path.join(REPO, "static", "style.css"), encoding="utf-8").read()
JS = open(os.path.join(REPO, "static", "admin.js"), encoding="utf-8").read()


def _cleanup(db):
    gids = [r[0] for r in db.execute("SELECT id FROM pm_calibration_groups WHERE name LIKE 'ZZPX%'")]
    if gids:
        ph = ",".join("?" * len(gids))
        db.execute("DELETE FROM pm_group_locks WHERE group_id IN (%s)" % ph, gids)
        db.execute("DELETE FROM pm_calibration_group_members WHERE group_id IN (%s)" % ph, gids)
        db.execute("DELETE FROM pm_calibration_groups WHERE id IN (%s)" % ph, gids)
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZPX-%'")
    db.commit()


def rule_bodies(css, selector_re):
    """The declaration blocks of every rule whose selector list matches `selector_re` (a regex on the selector text)."""
    out = []
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        if re.search(selector_re, m.group(1).strip()):
            out.append(m.group(2))
    return out


def declares(css, selector_re, decl_re):
    return any(re.search(decl_re, b) for b in rule_bodies(css, selector_re))


s.section("the panel macro renders the toggle on every shape")
env = a.app.jinja_env
tpl = env.from_string(
    '{% from "_adm_panel.html" import panel %}'
    '{% call panel("t-plain", "Kicker", "A title", "sub") %}<div class="adm-panel-body">x</div>{% endcall %}'
    '{% call panel("t-mid", "Kicker", "A title", "", mid=True) %}<div class="adm-panel-body">x</div>{% endcall %}'
    '{% call panel("t-wide", "Kicker", "A title", "", wide=True) %}<div class="adm-panel-body">x</div>{% endcall %}'
    '{% call panel("t-nav", "Kicker", "A title", "", mid=True, peek=True, nav=True) %}<div class="adm-panel-body">x</div>{% endcall %}')
with a.app.test_request_context("/"):
    out = tpl.render()
panels = re.findall(r'<aside class="adm-panel[^"]*" id="pnl-(t-[a-z]+)".*?</aside>', out, re.S)
s.check("four panels rendered", panels == ["t-plain", "t-mid", "t-wide", "t-nav"], panels)
for blk in re.findall(r'<aside class="adm-panel.*?</aside>', out, re.S):
    k = re.search(r'data-panel="([^"]+)"', blk).group(1)
    btn = re.findall(r"<button[^>]*data-panel-max[^>]*>", blk)
    s.check("%s: exactly one Full width toggle, not pressed, labelled for a screen reader and on hover" % k,
            len(btn) == 1 and 'aria-pressed="false"' in btn[0] and 'aria-label="Full width"' in btn[0]
            and 'title="Full width"' in btn[0], btn)
    head = re.search(r"<header class=\"adm-panel-head\">.*?</header>", blk, re.S).group(0)
    s.check("%s: the toggle sits in the head's top row (with the kicker), not in the body" % k,
            "data-panel-max" in head and "data-panel-max" not in blk.split("</header>", 1)[1])
    s.check("%s: both icons are drawn and the close bezel is still there" % k,
            "adm-max-out" in blk and "adm-max-in" in blk and "data-panel-close" in blk)
nav_blk = re.search(r'<aside class="adm-panel[^"]*" id="pnl-t-nav".*?</aside>', out, re.S).group(0)
s.check("the nav panel keeps Previous and Next before the toggle",
        nav_blk.index("data-panel-prev") < nav_blk.index("data-panel-next") < nav_blk.index("data-panel-max"))
cut = re.sub(r"<button[^>]*data-panel-max.*?</button>", "", out, flags=re.S)
s.check("falsified: with the toggle cut out the check above would fail", cut.count("data-panel-max") == 0 < out.count("data-panel-max"))

s.section("the calibration groups page: the last column is pinned")
G = {}
try:
    with a.app.app_context():
        db = a.get_db()
        _cleanup(db)
        db.execute("INSERT INTO org_units(business_group, company) SELECT ?,? WHERE NOT EXISTS "
                   "(SELECT 1 FROM org_units WHERE business_group=? AND company=?)", (BG, CO, BG, CO))
        uids = []
        for i in range(4):
            uids.append(db.execute(
                "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                "department, job_grade, years_of_service) VALUES (?,?, 'x', 'user', ?, ?, ?, 'ZZPX Dept', '16', 3)",
                ("zzpx-%d" % i, "ZZ PX Person %d" % i, "ZZPX-%d" % i, BG, CO)).lastrowid)
        cal = uids[0]
        G["id"] = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZPX Group A', ?)", (cal,)).lastrowid
        for u in uids[1:]:
            db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id) VALUES (?,?)", (G["id"], u))
        db.commit()
        per = a.active_pm_period(db)

    def page():
        c = H.client_as(a, SU["id"])
        r = c.get("/admin/performance/calibration-groups")
        return r.status_code, r.get_data(as_text=True)

    code, html = page()
    s.check("the groups page loads", code == 200, code)
    tbl = re.search(r'<table class="admin-table" id="calib-group-%d">.*?</table>' % G["id"], html, re.S)
    s.check("the group's members table is on the page", bool(tbl))
    t = tbl.group(0) if tbl else ""
    heads = re.findall(r"<th\b[^>]*>", t.split("</thead>")[0])
    s.check("the table has six header cells and the LAST one is gc-act",
            len(heads) == 6 and 'class="gc-act"' in heads[-1] and sum("gc-act" in h for h in heads) == 1, heads)
    rows = re.findall(r'<tr class="data-row".*?</tr>', t, re.S)
    s.check("one row per member", len(rows) == 3, len(rows))
    s.check("every row's LAST cell is the gc-act cell holding Remove",
            all(re.findall(r"<td\b[^>]*>", r)[-1] == '<td class="gc-act">' and ">Remove</button>" in r for r in rows))
    s.check("no other cell carries gc-act", all(sum("gc-act" in x for x in re.findall(r"<td\b[^>]*>", r)) == 1 for r in rows))

    # a locked member shows Locked, in the same pinned cell
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO pm_group_locks(cycle_id, group_id, subject_id, band) VALUES (?,?,?, 'x')",
                   (per["id"], G["id"], uids[1]))
        db.commit()
    code, html2 = page()
    t2 = re.search(r'<table class="admin-table" id="calib-group-%d">.*?</table>' % G["id"], html2, re.S).group(0)
    rows2 = re.findall(r'<tr class="data-row".*?</tr>', t2, re.S)
    locked = [r for r in rows2 if ">Locked</span>" in r]
    s.check("a locked member's cell says Locked and is still the pinned cell",
            len(locked) >= 1 and all(re.findall(r"<td\b[^>]*>", r)[-1] == '<td class="gc-act">' for r in locked), len(locked))
    s.check("every row of the second render still ends in a gc-act cell",
            len(rows2) == 3 and all(re.findall(r"<td\b[^>]*>", r)[-1] == '<td class="gc-act">' for r in rows2))
    s.check("the page's panel has the toggle too (the group panel is a mid panel)",
            'id="pnl-grp-%d"' % G["id"] in html2 and html2.count("data-panel-max") >= 2)
finally:
    with a.app.app_context():
        _cleanup(a.get_db())

s.section("the CSS")
s.check(".adm-panel.is-max is the viewport width",
        declares(CSS, r"^\.adm-panel\.is-max\b", r"width:\s*100vw"))
s.check("and it beats the per-panel widths (is-mid, is-wide, [data-panel=...]): a higher-specificity selector",
        declares(CSS, r"\.adm-panel\.is-max\[data-panel\]", r"width:\s*100vw"))
s.check("the toggle swaps its icon on aria-pressed", declares(CSS, r"\.adm-panel-max\[aria-pressed=\"true\"\] \.adm-max-in", r"display:\s*block"))
s.check("the pinned column is sticky at right 0, on one line",
        declares(CSS, r"td\.gc-act", r"position:\s*sticky") and declares(CSS, r"td\.gc-act", r"right:\s*0")
        and declares(CSS, r"td\.gc-act", r"white-space:\s*nowrap"))
s.check("its background is a token (opaque in light and dark), never transparent and never a literal colour",
        declares(CSS, r"th\.gc-act, td\.gc-act", r"background:\s*var\(--surface\)")
        and not declares(CSS, r"gc-act", r"background:\s*(transparent|none|#|rgb)"))
s.check("a left divider so scrolled text does not show through", declares(CSS, r"td\.gc-act", r"box-shadow:\s*inset 1px 0 0 var\(--"))
z = {}
for sel, k in (("td.gc-act", "td"), (".table-scroll-capped thead th.gc-act", "th")):
    for b in rule_bodies(CSS, r"^" + re.escape(sel) + r"$"):
        m = re.search(r"z-index:\s*(\d+)", b)
        if m:
            z[k] = int(m.group(1))
head_z = max([int(m.group(1)) for b in rule_bodies(CSS, r"^\.table-scroll-capped thead th$") for m in [re.search(r"z-index:\s*(\d+)", b)] if m] or [0])
s.check("the corner header cell sits above the other sticky headers and the sticky cells",
        z.get("th", 0) > head_z and z.get("th", 0) > z.get("td", 99), (z, head_z))
s.check("the row's hover colour is carried by the pinned cell", declares(CSS, r"tr:hover td\.gc-act", r"background:\s*var\(--"))
s.check("falsified: the same check on CSS with the sticky rule removed fails",
        not declares(CSS.replace("position: sticky; right: 0; white-space: nowrap", ""), r"td\.gc-act", r"position:\s*sticky"))
new_css = CSS[CSS.index("/* Full width / Back to the side"):CSS.index("td.gc-act form")]
s.check("the new CSS has no literal colour and no hover underline",
        not re.search(r"#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|text-decoration:\s*underline", new_css))

s.section("admin.js")
s.check("the choice is kept in localStorage under onehr.panel.max.<key>, read and written inside try/catch",
        "onehr.panel.max." in JS and re.search(r"function maxGet\(k\) \{ try \{.*localStorage.*\} catch", JS)
        and re.search(r"function maxSet\(k, on\) \{ try \{.*localStorage.*\} catch", JS))
s.check("the label flips between Full width and Back to the side (aria-label, title, aria-pressed)",
        "Back to the side" in JS and '"Full width"' in JS and 'setAttribute("aria-pressed"' in JS and 'setAttribute("title"' in JS)
s.check("the remembered choice is applied in open(), which every route to a panel goes through",
        re.search(r"cur = p; opener = from \|\| null;\s*maxApply\(p, maxGet\(key\(p\)\)\);", JS))
s.check("the toggle click is handled and the state saved", "[data-panel-max]" in JS and "maxSet(key(mp), on)" in JS)
s.check("the scroll is kept in sessionStorage, guarded, for 2 minutes",
        "onehr.panel.scroll" in JS and "sessionStorage.setItem" in JS and "SCROLL_MS = 120000" in JS
        and re.search(r"function scrollSave\(f\) \{\s*try \{", JS))
s.check("it saves the panel body's scroll and every .table-scroll's top and left",
        "scrollTop" in JS and "scrollLeft" in JS and 'querySelectorAll(".table-scroll")' in JS)
s.check("it saves only on a POST from inside a panel", re.search(r'\.adm-panel"\);\s*if \(!p \|\| \(f\.getAttribute\("method"\) \|\| "get"\)\.toLowerCase\(\) !== "post"\) return;', JS))
s.check("hook 1: the submit event in the BUBBLE phase, only if nothing stopped it (base.html's data-confirm handler stops "
        "the first, unconfirmed submit in the capture phase; the replay after OK arrives here)",
        re.search(r'document\.addEventListener\("submit", function \(e\) \{ if \(!e\.defaultPrevented\) scrollSave\(e\.target\); \}\);', JS))
s.check("hook 2: form.submit() itself (a prompt box, a date box, the line-manager check send with it: no submit event)",
        "HTMLFormElement.prototype.submit = function" in JS and "scrollSave(this)" in JS)
base = open(os.path.join(REPO, "templates", "base.html"), encoding="utf-8").read()
s.check("the premise holds: base.html replays a confirmed form with requestSubmit and stops the first submit in the capture phase",
        "f.requestSubmit(by)" in base and "e.preventDefault(); e.stopPropagation();" in base and "}, true);" in base)
s.check("it is put back once the same panel opens on the same path (static panels in open(), loaded panels after load())",
        "scrollRestore(p);   // a loaded panel" in JS and "if (cur === p) scrollRestore(p);" in JS
        and "d.path !== location.pathname" in JS and "d.panel !== key(p)" in JS)
s.check("the entry is cleared when used and re-applied after the browser's own #hash jump (load event + a short timeout)",
        'removeItem(SCROLL_KEY)' in JS and 'addEventListener("load"' in JS and "setTimeout(again, 120)" in JS)
s.check("falsified: the pattern for the submit hook does not match a build without it",
        not re.search(r'document\.addEventListener\("submit", function \(e\) \{ if \(!e\.defaultPrevented\) scrollSave', JS.replace("scrollSave(e.target)", "")))

sys.exit(s.done())
