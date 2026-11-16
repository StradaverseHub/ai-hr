"""The admin side panels, phase 1: the person page (Chris, 2026-10-17, canvas "OneHR Admin Side Panels").

The Overview keeps a summary and opens each change beside it: one profile card (job, who they report to, roles,
account) with a button per part, and a panel per part holding the forms the cards had, posting to the same routes
with the same confirmations. Each module opens wide, loaded from its own tab (?tab=<k>&fragment=1), and a save in it
comes back to the Overview with that panel open (_person_back reads `panel`). Also the two bugs he reported: Details'
Edit did nothing (a `hidden` form under `display:grid`), and the Career Plan's Progress rows opened the Overview
(tab=career). Everything here is synthetic (ZZAP-*) and is removed at the end.
"""
import html
import os
import re
import sys

from flask import template_rendered

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The admin side panels -- the person page")

BG, CO, CO2 = "ZZAP BG", "ZZAP CO", "ZZAP CO2"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZAP-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        for t in ("tc_assignments", "tc_assessments", "rating_records", "pm_kpi_targets"):
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (t, ph), ids)
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM buceo_seats WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM pm_calibration_groups WHERE calibrator_id IN (%s)" % ph, ids)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM pm_calibration_groups WHERE name LIKE 'ZZAP%'")
    db.execute("DELETE FROM tc_job_profiles WHERE job_title LIKE 'ZZAP%'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    PAST = db.execute("SELECT id FROM cycles WHERE id!=? ORDER BY id DESC LIMIT 1", (CID,)).fetchone()
    PAST = PAST[0] if PAST else None
    _cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, mgr=None, hod=None, left=None, title="ZZAP Engineer"):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=hod, manager_id=mgr,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO,
                 department="ZZAP Dept", job_title=title, job_grade="16", years_of_service=3, confirmation_date=None,
                 left_at=left, is_demo=0, role="user", admin_bg=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?)", (BG, CO, BG, CO2))
    LM = mk("ZZAP-LM", "ZZ AP Manager", title="ZZAP Lead")
    LM2 = mk("ZZAP-LM2", "ZZ AP Newmanager", title="ZZAP Lead")
    HOD = mk("ZZAP-HOD", "ZZ AP Hodone", title="ZZAP Head")
    HOD2 = mk("ZZAP-HOD2", "ZZ AP Hodtwo", title="ZZAP Head")
    A = mk("ZZAP-A", "ZZ AP Alpha", mgr=LM, hod=HOD)
    B = mk("ZZAP-B", "ZZ AP Bravo")                       # no line manager and no HOD: Needs attention has both
    GONE = mk("ZZAP-GONE", "ZZ AP Gone", mgr=LM, left="2026-01-31 00:00:00")
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]

sup = H.client_as(a, SUP)
LINES = "/admin/users/%d/lines" % A
TABS = ("performance", "competency", "f360", "plan")


def get(url):
    r = sup.get(url)
    return r.status_code, html.unescape(r.get_data(as_text=True))


def post(url, follow=False, **f):
    d = {"csrf_token": "tok"}
    d.update(f)
    return sup.post(url, data=d, follow_redirects=follow)


def panels(b):
    """{key: (the <aside> opening tag, its whole markup)} for every side panel on the page."""
    out = {}
    for m in re.finditer(r'<aside class="adm-panel[^"]*" id="pnl-([\w-]+)"[^>]*>', b):
        end = b.find("</aside>", m.end())
        out[m.group(1)] = (m.group(0), b[m.start():end])
    return out


def autoopen(b):
    return sorted(k for k, (tag, _) in panels(b).items() if "data-panel-autoopen" in tag)


def where(r):
    return r.headers.get("Location", "")


try:
    # -----------------------------------------------------------------------
    s.section("The Overview: one profile card, a panel per part")
    code, b = get("/admin/users/%d" % A)
    P = panels(b)
    s.check("the page opens with one profile card: job, who they report to, roles, account",
            code == 200 and 'class="admin-card pp-card pp-prof"' in b and all(
                'id="%s"' % k in b for k in ("details", "lines", "roles", "account")), code)
    s.check("...still headed \"Who they report to\", naming their line manager and HOD",
            "Who they report to" in b and "ZZ AP Manager" in b and "ZZ AP Hodone" in b)
    # ...plus the AI+ conversation's, which the super admin alone gets (2026-10-20; test_conversation_access)
    s.check("a panel for each part, and one for each module", set(P) == {"details", "lm", "hod", "roles", "account"}
            | set(TABS) | {"conversation", "urole", "emailoff", "insight"}, sorted(P))   # emailoff: Reminder emails (2026-11-01); insight: a person's AI insight (2026-11-06, the super admin or a role with the item)
    s.check("every panel starts closed (hidden) when nothing asked for one",
            all(re.search(r"\shidden>$", tag) for tag, _ in P.values()) and autoopen(b) == [], autoopen(b))
    s.check("each part's button opens its panel",
            all('data-panel-open="%s"' % k in b for k in ("details", "lm", "hod", "roles", "account")))
    s.check("each module's Open opens its wide panel, and keeps its tab link for a new tab",
            all(re.search(r'href="/admin/users/%d\?tab=%s" data-panel-open="%s"' % (A, k, k), b) for k in TABS)
            and all('adm-panel is-wide' in P[k][0] for k in TABS))
    s.check("a module panel loads its own tab, alone (fragment=1)",
            all(re.search(r'data-panel-src="/admin/users/%d\?[^"]*tab=%s[^"]*"' % (A, k), P[k][0])
                and "fragment=1" in P[k][0] for k in TABS))
    s.check("each panel is a labelled dialog with the close bezel",
            all('role="dialog"' in tag and 'aria-labelledby="pnl-%s-h"' % k in tag and 'data-panel-close' in body
                for k, (tag, body) in P.items()))

    s.section("Bug 1: Details' Edit did nothing")
    gs = b.find('<div class="pp-grid" data-panel-home=')
    grid = b[gs:b.find('<aside class="adm-panel')] if gs >= 0 else ""
    s.check("the panels' address is the person page (a preview renders at its POST route, which a refresh can't GET)",
            'data-panel-home="/admin/users/%d"' % A in b)
    s.check("nothing on the Overview's cards is held back by a hidden attribute (display rules beat [hidden])",
            grid and not re.search(r"<[a-z]+[^>]*\shidden[\s>]", grid),
            re.findall(r"<[a-z]+[^>]*\shidden[\s>]", grid)[:2])
    s.check("Edit opens the Job details panel, which holds the edit form (Details preview)",
            'data-panel-open="details"' in grid and 'value="details_preview"' in P["details"][1]
            and 'value="details_preview"' not in grid)
    css = open(os.path.join(ROOT, "static", "style.css"), encoding="utf-8").read()
    s.check("and the stylesheet guards [hidden] on the panel, its dim and the outlined button",
            re.search(r"\.adm-panel\[hidden\][^{]*\.adm-panel-scrim\[hidden\][^{]*\.btn-link\[hidden\][^{]*\{\s*"
                      r"display:\s*none", css) is not None)

    s.section("A preview comes back with its panel open")
    r = post(LINES, action="details_preview", company=CO2, department="__new__", department_new="ZZAP Moved",
             job_title="__new__", job_title_new="ZZAP Engineer", job_grade="16")
    b = html.unescape(r.get_data(as_text=True))
    s.check("the Details preview opens the Job details panel on the change, writing nothing",
            r.status_code == 200 and autoopen(b) == ["details"] and 'value="details_apply"' in panels(b)["details"][1]
            and "What this changes" in b and H.one(a, "SELECT company FROM users WHERE id=?", (A,)) == CO,
            autoopen(b))
    r = post(LINES, action="lm_preview", lm_eid="ZZAP-LM2")
    b = html.unescape(r.get_data(as_text=True))
    s.check("the line manager preview opens its panel on the plan",
            r.status_code == 200 and autoopen(b) == ["lm"] and 'value="lm_apply"' in panels(b)["lm"][1]
            and "Make ZZ AP Newmanager their line manager" in b, autoopen(b))
    s.check("...its Apply is the panel's one solid button, tied to the plan form",
            'form="pp-lm-apply"' in panels(b)["lm"][1] and 'id="pp-lm-apply"' in panels(b)["lm"][1])
    r = post(LINES, action="hod_preview", hod_eid="ZZAP-HOD2")
    b = html.unescape(r.get_data(as_text=True))
    s.check("the HOD preview opens its panel on the plan", r.status_code == 200 and autoopen(b) == ["hod"]
            and "Make ZZ AP Hodtwo their HOD" in panels(b)["hod"][1], autoopen(b))
    code, b = get("/admin/users/%d?panel=roles" % A)
    s.check("?panel=<part> opens that panel (a link, a refresh, Back)", autoopen(b) == ["roles"], autoopen(b))
    code, b = get("/admin/users/%d?panel=competency" % A)
    s.check("...and a module's", autoopen(b) == ["competency"], autoopen(b))
    code, b = get("/admin/users/%d?panel=nosuch" % A)
    s.check("...an unknown one opens nothing", code == 200 and autoopen(b) == [], autoopen(b))

    s.section("A module's tab, alone, for its panel")
    for k in TABS:
        code, b = get("/admin/users/%d?tab=%s&fragment=1" % (A, k))
        s.check("%s: the tab's own content, without the page around it" % k,
                code == 200 and b.lstrip().startswith('<div class="pp pp-in-panel"') and "<html" not in b
                and 'class="pp-tabs"' not in b and "<aside" not in b, (code, b[:60]))
    code, b = get("/admin/users/%d?tab=history&fragment=1" % A)
    s.check("History loads alone too (for a list's panel: Progress › Calibration, Final bands)",
            code == 200 and b.lstrip().startswith('<div class="pp pp-in-panel"') and "<html" not in b, (code, b[:60]))
    code, b = get("/admin/users/%d?tab=overview&fragment=1" % A)
    s.check("the Overview alone is the person in brief (the People list's panel), never the page with its panels",
            code == 200 and 'class="pp-sum"' in b and "<html" not in b and "<aside" not in b
            and 'method="post"' not in b, (code, b[:60]))
    s.check("...each change in it opens on their page, in that part's panel",
            all('href="/admin/users/%d?panel=%s"' % (A, k) in b for k in ("details", "lm", "hod", "roles", "account",
                                                                          "performance", "competency", "f360", "plan")))
    s.check("...and it is headed by who they are (data-name / data-sub head a list's panel)",
            'data-name="ZZ AP Alpha"' in b and 'data-sub="ZZAP-A · JG 16' in b)
    # the Job card carries the Confirmation date, as the full page's does (Chris: the list's panel; 2026-11-01)
    s.check("the person in brief shows the Job card's Confirmation date: over a year's service, no date: 'counted'",
            "Confirmation date" in b and "Counted as confirmed: over a year" in b, "")

    def _conf(date, yos):
        with a.app.test_request_context("/"):
            d = a.get_db()
            d.execute("UPDATE users SET confirmation_date=?, years_of_service=? WHERE id=?", (date, yos, A))
            d.commit()
    try:
        _conf("2020-02-03", 3)
        code, b2 = get("/admin/users/%d?tab=overview&fragment=1" % A)
        s.check("...a dated confirmation shows the day, and no 'counted' line",
                "3 Feb 2020" in b2 and "Counted as confirmed" not in b2, "")
        _conf(None, None)
        code, b3 = get("/admin/users/%d?tab=overview&fragment=1" % A)
        s.check("...no date and under a year: 'Not confirmed yet'",
                "Not confirmed yet" in b3 and "Counted as confirmed" not in b3, "")
    finally:
        _conf(None, 3)
    if PAST:
        code, b = get("/admin/users/%d?cycle=%d" % (A, PAST))
        P = panels(b)
        s.check("a past cycle: no part can be changed (no Details, line manager or HOD panel)",
                code == 200 and not {"details", "lm", "hod"} & set(P), sorted(P))
        s.check("...and each module panel loads that cycle's tab",
                all("cycle=%d" % PAST in P[k][0] for k in TABS if k in P) and set(TABS) <= set(P))
    code, b = get("/admin/users/%d" % GONE)
    s.check("someone who has left: no Details panel (their job isn't edited)", code == 200
            and "details" not in panels(b) and 'data-panel-open="details"' not in b)

    s.section("A save comes back to where the admin was")
    r = post("/admin/users/%d/competency" % A, action="reset", panel="competency")
    s.check("a module panel's save returns to the Overview with that panel open",
            "panel=competency" in where(r) and "tab=" not in where(r), where(r))
    r = post("/admin/users/%d/competency" % A, action="reset")
    s.check("...the same save from the tab page returns to the tab, as before",
            "tab=competency" in where(r) and "panel=" not in where(r), where(r))
    r = post("/admin/users/%d/competency" % A, action="reset", panel="nosuch")
    s.check("...an unknown panel is ignored", "tab=competency" in where(r) and "panel=" not in where(r), where(r))
    r = post(LINES, action="lm_preview", lm_eid="ZZAP-A", panel="lm")
    s.check("a failed step returns with its panel open, to put it right",
            "panel=lm" in where(r), where(r))
    r = post(LINES, action="lm_apply", lm_eid="ZZAP-LM2", disposition="reassign", panel="lm")
    s.check("a step that worked closes its panel", "panel=" not in where(r)
            and H.one(a, "SELECT manager_id FROM users WHERE id=?", (A,)) == LM2, where(r))
    r = post(LINES, action="set_buceo", company=CO2, panel="roles")
    seat = H.one(a, "SELECT COUNT(*) FROM buceo_seats WHERE user_id=? AND company=?", (A, CO2))
    s.check("the Roles panel stays open after a change that worked (seats are set one after another)",
            "panel=roles" in where(r) and seat == 1, (where(r), seat))
    post(LINES, action="clear_buceo", company=CO2, panel="roles")
    s.check("...and the seat is given back", H.one(a, "SELECT COUNT(*) FROM buceo_seats WHERE user_id=?", (A,)) == 0)
    code, b = get("/admin/users/%d" % A)
    s.check("the account's actions come back to the Account panel",
            'name="next" value="/admin/users/%d?panel=account"' % A in panels(b)["account"][1])
    r = post("/admin/users", action="set_email", user_id=A, email="zzap.alpha@example.invalid",
             next="/admin/users/%d?panel=account" % A)
    s.check("...and the Users page's action does return there", where(r).endswith("/admin/users/%d?panel=account" % A)
            and H.one(a, "SELECT email FROM users WHERE id=?", (A,)) == "zzap.alpha@example.invalid", where(r))

    s.section("Needs attention opens the panel that fixes it")
    with a.app.test_request_context("/"):
        npan = a._person_need_panel
        s.check("no line manager -> the line manager panel; no HOD -> the HOD panel",
                npan("#lines", "No line manager") == "lm" and npan("#lines", "No HOD, so no department review") == "hod")
        s.check("a module link on this page -> that module's panel; anything else stays a link",
                npan("/admin/users/5?tab=performance#add", "No KPIs") == "performance"
                and npan("/admin/users/5?tab=f360", "panel") == "f360"
                and npan("/admin/participants?bg=X", "Not taking part") == ""
                and npan("/admin/leaders?tab=buceo", "no BU CEO") == "")
    code, b = get("/admin/users/%d" % B)
    need = b[b.find('aria-label="Needs attention"'):b.find('aria-label="What changed"')]
    s.check("...on the page: Bravo's two missing leaders each open their panel",
            'href="#lines" data-panel-open="lm"' in need and 'href="#lines" data-panel-open="hod"' in need)

    s.section("Bug 2: the Career Plan's Progress rows opened the Overview")
    seen = []

    def _rec(sender, template, context, **extra):
        if template.name == "admin_module_progress.html":
            seen.append(context.get("person_tab"))
    template_rendered.connect(_rec, a.app)
    try:
        for key in ("pm", "competency", "idp"):
            sup.get("/admin/module/%s/progress" % key)
    finally:
        template_rendered.disconnect(_rec, a.app)
    s.check("each module's Progress links a row to that person's own tab (the Career Plan's is plan)",
            len(seen) == 3 and all(t in dict(a.PERSON_TABS) for t in seen) and seen[2] == "plan", seen)

    s.section("Phase 2: a person opened from a list, the list staying live")
    with a.app.test_request_context("/"):
        _db = a.get_db()
        _mods0 = {r[0]: r[1] for r in _db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))}
        _db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('pm','tm','idp','calibration')",
                    (CID,))
        _db.commit()
    try:
        want = {"pm": "performance", "competency": "competency", "calibration": "history", "idp": "plan"}
        hits = []
        for mk, tb in want.items():
            code, b = get("/admin/module/%s/progress?q=ZZAP-A" % mk)
            if 'id="module-progress-table"' not in b:
                continue
            hits.append(mk)
            pp_ = panels(b).get("person")
            s.check("Progress › %s: the name and Open load their %s into the list's peeking panel" % (mk, tb),
                    code == 200 and pp_ is not None and "data-panel-peek" in pp_[0] and "is-mid" in pp_[0]
                    and b.count('href="/admin/users/%d?tab=%s" data-person-open="%d"' % (A, tb, A)) == 2
                    and "data-panel-prev" in pp_[1] and "data-panel-next" in pp_[1], (code, mk))
        s.check("...reached on Performance and Competency at least (the checks above ran)",
                "pm" in hits and "competency" in hits, hits)
        code, b = get("/admin/users?q=ZZAP-A")
        P = panels(b)
        s.check("People: the name and Open load the person in brief beside the list",
                code == 200 and "person" in P and b.count('href="/admin/users/%d" data-person-open="%d"' % (A, A)) == 2)
        s.check("...and Add a person is a panel over the list (its form, its confirm, the people pickers)",
                "add" in P and 'value="add_user"' in P["add"][1] and "data-confirm=" in P["add"][1]
                and 'name="manager_eid"' in P["add"][1] and 'data-panel-open="add"' in b and autoopen(b) == [])
        code, b = get("/admin/users?view=add")
        s.check("...?view=add (and a failed add, which comes back there) opens it on the list",
                code == 200 and autoopen(b) == ["add"] and 'id="pnl-person"' in b)
        code, b = get("/admin/subjects?scope=all&q=ZZAP-A")
        s.check("360 People: a name loads their panel and the feedback they give beside the list",
                code == 200 and 'id="pnl-person"' in b
                and 'href="/admin/users/%d?tab=f360" data-person-open="%d"' % (A, A) in b)
        code, b = get("/admin/calibration/final-bands")
        s.check("Final bands: the list's panel is there for a name's whole trail (History)",
                code == 200 and 'id="pnl-person"' in b)
    finally:
        with a.app.test_request_context("/"):
            _db = a.get_db()
            for k_, v_ in _mods0.items():
                _db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v_, CID, k_))
            _db.commit()
    back = "/admin/module/competency/progress?q=ZZAP&panel=person&pp=%d" % A
    r = post("/admin/users/%d/competency" % A, action="reset", panel="person", panel_back=back)
    s.check("a save in a list's panel goes back to that list with the person's panel open", where(r).endswith(back),
            where(r))
    for bad in ("//evil.example/admin/?panel=person", "https://evil.example/admin/?panel=person",
                "/admin/module/competency/progress?q=ZZAP", "/dashboard?panel=person"):
        r = post("/admin/users/%d/competency" % A, action="reset", panel="person", panel_back=bad)
        s.check("...an address that isn't an admin page here with the panel is ignored: %s" % bad,
                "tab=competency" in where(r) and "evil" not in where(r), where(r))
    js2 = open(os.path.join(ROOT, "static", "admin.js"), encoding="utf-8").read()
    s.check("admin.js: a row's data-person-open fills the one person panel, ?panel=person&pp=<id>, Previous / Next",
            "[data-person-open]" in js2 and 'setUrl("person", id)' in js2 and 'hidden(f, "panel_back", back)' in js2
            and "[data-panel-prev], [data-panel-next]" in js2 and "is-peek-row" in js2)

    s.section("Phase 3: a row's settings in its side panel")
    code, b = get("/admin/org")
    P = panels(b)
    slug = lambda x: re.sub(r"[^A-Za-z0-9]+", "-", x).strip("-").lower()
    kg, ku = "org-" + slug(BG), "org-%s-%s" % (slug(BG), slug(CO))
    s.check("Org structure: the group's and each unit's row Edit opens its own panel",
            code == 200 and 'data-panel-open="%s"' % kg in b and 'data-panel-open="%s"' % ku in b and kg in P and ku in P)
    s.check("...a unit's panel: rename, display name, who leads it, its departments, its people, and remove",
            all(x in P[ku][1] for x in ('value="rename_company"', 'value="set_company_display"', "Who leads it",
                                        "ZZAP Dept", 'value="remove_company"', "Open its"))
            and "data-confirm=" in P[ku][1] and "data-prompt=" in P[ku][1])
    s.check("...a group's panel adds a business unit; Add a business group is a panel too, the row menus gone",
            'value="add_company"' in P[kg][1] and "org-add-bg" in P and 'class="org-menu"' not in b
            and 'data-org-open' not in b)
    s.check("...its leader links to that seat's panel on Leaders",
            'panel=bu-%s' % slug(CO) in P[ku][1] and 'tab=buceo' in P[ku][1])

    with a.app.test_request_context("/"):
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZAP Group', ?)", (LM,))
        GID = _db.execute("SELECT id FROM pm_calibration_groups WHERE name='ZZAP Group'").fetchone()[0]
        _db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id) VALUES (?,?)", (GID, A))
        _db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, proficiency_level, source) "
                    "VALUES ('ZZAP Dept', 'ZZAP Engineer', '16', 3, 'manual')")
        PID = _db.execute("SELECT id FROM tc_job_profiles WHERE job_title='ZZAP Engineer'").fetchone()[0]
        _db.commit()
    code, b = get("/admin/performance/calibration-groups")
    P = panels(b)
    gk = "grp-%d" % GID
    s.check("Calibration groups: a summary row per group, Manage opening its panel",
            code == 200 and 'class="admin-table no-auto-table gc-sum"' in b and 'data-panel-open="%s"' % gk in b
            and gk in P and "grp-new" in P)
    s.check("...the panel holds the group's tools, its people and Delete (in the red box), as its card had them",
            all(x in P[gk][1] for x in ('value="set_mode"', 'data-pick-multi', 'value="paste_ids"',
                                        'id="calib-group-%d"' % GID, 'value="delete"', 'id="group-%d"' % GID,
                                        "adm-danger")))
    s.check("...a count or a refresh preview opens it on load, and closing drops what opened it",
            'data-panel-params="g dept gbg refresh"' in P[gk][0]
            and autoopen(get("/admin/performance/calibration-groups?refresh=%d" % GID)[1]) == [gk]
            and autoopen(get("/admin/performance/calibration-groups?g=%d&dept=ZZAP" % GID)[1]) == [gk]
            and autoopen(b) == [])
    r = post("/admin/performance/calibration-groups", action="remove_member", group_id=GID, subject_id=A)
    s.check("...a change in it lands on #group-<id> (which opens the panel again)",
            where(r).endswith("/admin/performance/calibration-groups#group-%d" % GID), where(r))

    r = post("/admin/leaders", action="set_buceo", bg=BG, tab="buceo", company=CO, person_id=LM)
    code, b = get("/admin/leaders?bg=%s&tab=buceo" % BG.replace(" ", "+"))
    P = panels(b)
    bk = "bu-" + slug(CO)
    s.check("Leaders › BU CEOs: a unit's Change opens its panel: who holds it, the picker, Make BU CEO",
            code == 200 and 'data-panel-open="%s"' % bk in b and bk in P and 'value="set_buceo"' in P[bk][1]
            and 'class="ld-pick"' in P[bk][1] and "ZZ AP Manager" in P[bk][1])
    s.check("...Remove sits in the panel's red box, its form apart (one form can't hold another)",
            'form="ld-clr-%s"' % bk in P[bk][1] and 'id="ld-clr-%s"' % bk in P[bk][1] and 'value="clear_buceo"' in b
            and 'class="admin-form ld-inline"' not in b)
    code, b = get("/admin/leaders?bg=%s&tab=buceo&panel=%s" % (BG.replace(" ", "+"), bk))
    s.check("...Org structure's link (?panel=bu-<unit>) lands on it", code == 200 and bk in panels(b))
    code, b = get("/admin/leaders?bg=%s&tab=bgceo" % BG.replace(" ", "+"))
    P = panels(b)
    s.check("Leaders › BG CEOs: the group's Change opens its panel", "bg-" + slug(BG) in P
            and 'value="set_bgceo"' in P["bg-" + slug(BG)][1])
    s.check("...with no business group row: its table lists every group (Chris, 2026-10-20)", "ld-bgrow" not in b
            and "Who heads each business group" in b)
    code, b = get("/admin/leaders?bg=%s&tab=hod" % BG.replace(" ", "+"))
    s.check("...the HODs and BU CEOs keep it", "ld-bgrow" in b and "ld-bgrow" in get(
        "/admin/leaders?bg=%s&tab=buceo" % BG.replace(" ", "+"))[1])
    dv = re.search(r'name="dept" value="(%s[^"]*)"' % re.escape(CO + "||"), b)
    r = post("/admin/leaders", follow=False, action="hod_preview", bg=BG, tab="hod", hod_id=HOD2, scope="bu", company=CO,
             dept=dv.group(1) if dv else "")
    b = html.unescape(r.get_data(as_text=True))
    s.check("Leaders › HOD: the preview opens in its panel on the page, Make HOD its button",
            dv is not None and r.status_code == 200 and autoopen(b) == ["ld-plan"]
            and 'value="hod_apply"' in panels(b)["ld-plan"][1] and ">Make HOD</button>" in panels(b)["ld-plan"][1],
            (dv and dv.group(1), r.status_code))

    with a.app.test_request_context("/"):
        _db = a.get_db()
        _cols = [c_[1] for c_ in _db.execute("PRAGMA table_info(users)") if c_[1] != "id"]
        _base = dict(_db.execute("SELECT * FROM users WHERE id=?", (A,)).fetchone())
        _v = dict(_base, username="zzap-subadmin", employee_id="ZZAP-SUB", full_name="ZZ AP Subadmin", role="admin",
                  admin_bg=BG, manager_id=None, hod_id=None)
        _db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(_cols), ",".join("?" * len(_cols))),
                    [_v[c_] for c_ in _cols])
        SUBA = _db.execute("SELECT id FROM users WHERE employee_id='ZZAP-SUB'").fetchone()[0]
        _db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (SUBA, CO))
        _db.commit()
    code, b = get("/admin/admins")
    P = panels(b)
    ak = "adm-%d" % SUBA
    # since Roles & access (2026-10-20) the super admin sets a unit admin's role, group and units in one Role form
    s.check("Admins: a unit admin's Manage opens their panel: their role (with group and units), password, remove",
            code == 200 and 'data-panel-open="%s"' % ak in b and ak in P
            and all(x in P[ak][1] for x in ("admin/admins/%d/role" % SUBA, 'name="companies"', 'form="adm-pw-%d"' % SUBA,
                                            'form="adm-rm-%d"' % SUBA, "adm-danger")))
    s.check("...their password and remove forms keep their prompt and confirm; Add an admin is a panel",
            re.search(r'id="adm-pw-%d"[^>]*data-prompt=' % SUBA, b) is not None
            and re.search(r'id="adm-rm-%d"[^>]*data-confirm=' % SUBA, b) is not None and "adm-new" in P
            and 'class="adm-inline-edit"' not in b)

    code, b = get("/admin/competency/profiles")
    s.check("Job profiles: Add a profile is a panel; a row's Edit reloads with ?profile=", code == 200
            and "prof-new" in panels(b) and 'value="add_profile"' in panels(b)["prof-new"][1]
            and 'href="/admin/competency/profiles?profile=%d"' % PID in b and autoopen(b) == [])
    code, b = get("/admin/competency/profiles?profile=%d" % PID)
    P = panels(b)
    pk = "prof-%d" % PID
    s.check("...which opens that profile's panel: its competencies, Deactivate, and Remove in the red box",
            code == 200 and autoopen(b) == [pk] and 'data-panel-params="profile"' in P[pk][0]
            and 'form="prof-toggle"' in P[pk][1] and 'form="prof-remove"' in P[pk][1]
            and re.search(r'id="prof-remove"[^>]*data-confirm=', b) is not None, autoopen(b))
    js3 = open(os.path.join(ROOT, "static", "admin.js"), encoding="utf-8").read()
    s.check("admin.js: a closing panel drops its own parameters and a #id inside it; a #id inside a panel opens it",
            'getAttribute("data-panel-params")' in js3 and 'drop.contains(t)' in js3
            and 'tg.closest(".adm-panel[data-panel]")' in js3)

    s.section("The panel's script and styles")
    js = open(os.path.join(ROOT, "static", "admin.js"), encoding="utf-8").read()
    blk = js[js.find("The admin side panel"):]
    s.check("admin.js opens from data-panel-open and ?panel=, and closes on the bezel, the dim and Esc",
            "[data-panel-open]" in blk and 'q.get("panel")' in blk and "[data-panel-close]" in blk
            and "scrim.addEventListener(\"click\"" in blk and '"Escape"' in blk)
    s.check("...Esc leaves the panel alone while OneHR's own confirm box, a column menu or a picker's list is open",
            re.search(r'POPUPS = "\.modal-overlay, \.col-menu:not\(\[hidden\]\), \.pick-list:not\(\[hidden\]\)', blk)
            is not None and 'document.querySelector(POPUPS)) return;' in blk and "}, true);" in blk)
    s.check("...and a table's column menu (on <body>) stays live over a modal panel",
            'el.classList.contains("col-menu")) return;' in blk)
    s.check("...the page behind goes inert, and focus returns to the button that opened it",
            "inert = true" in blk and "opener.focus" in blk)
    s.check("...a loaded tab's POST forms carry panel=<key>, and its own scripts run",
            'hidden(f, "panel", k)' in blk and 'createElement("script")' in blk and 'set("fragment", "1")' in blk)
    ad = blk[blk.find("function adopt"):blk.find("document.addEventListener", blk.find("function adopt"))]
    s.check("...and the session token, which base.html stamps only on the forms there at load",
            'meta[name="csrf-token"]' in ad and 't.name = "csrf_token"' in ad)
    code, b = get("/admin/users/%d?tab=competency&fragment=1" % A)
    s.check("...(the fragment's own forms carry none, so the script must)", code == 200
            and 'method="post"' in b and 'name="csrf_token"' not in b)
    s.check("styles: 560px, 880px wide, under the top bar, sliding (still under reduced motion)",
            "width: min(560px, 100vw)" in css and ".adm-panel.is-wide { width: min(880px, 100vw)" in css
            and re.search(r"prefers-reduced-motion: reduce\) \{ \.adm-panel, \.adm-panel-scrim", css) is not None)
finally:
    with a.app.test_request_context("/"):
        _cleanup(a.get_db())

sys.exit(s.done())
