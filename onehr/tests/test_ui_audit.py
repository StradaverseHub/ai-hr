"""The admin UI redundancy audit (2026-10-17, `OneHR/UI Redundancy Audit 2026-10-17.md`): Chris asked why the person
page's Performance panel had two "+ Add a KPI", and how many redundancies like it the admin holds. His call: "Remove
the 20, fix the 7". Each removal is checked against what stays (the control that already does the same), and each of
the seven bugs on the route that had it. Everything changed here is synthetic (ZZUA-*) and is removed at the end.
"""
import html
import os
import re
import sys

from flask import template_rendered

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The admin UI audit -- 20 redundant controls gone, 7 bugs fixed")

BG, CO = "ZZUA BG", "ZZUA CO"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZUA-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CID = a.active_cycle(db)["id"]
    PAST = db.execute("SELECT id, name FROM cycles WHERE id!=? ORDER BY id DESC LIMIT 1", (CID,)).fetchone()
    _cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, mgr=None):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=mgr,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO,
                 department="ZZUA Dept", job_title="ZZUA Engineer", job_grade="16", years_of_service=3,
                 confirmation_date=None, left_at=None, is_demo=0, role="user", admin_bg=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    LM = mk("ZZUA-LM", "ZZ UA Manager")
    A = mk("ZZUA-A", "ZZ UA Alpha", mgr=LM)
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]
    U = {k: a.url_for(*v[:1], **v[1]) for k, v in {
        "progress_idp": ("admin_module_progress", {"key": "idp"}),
        "idp_overview": ("admin_idp_overview", {}),
        "audit": ("admin_audit_log", {"q": "ZZUA-A"}),
    }.items()}

sup = H.client_as(a, SUP)


def get(url, c=None):
    r = (c or sup).get(url)
    return r.status_code, html.unescape(r.get_data(as_text=True))


def rendered(url, c=None):
    """(status, body, the context of the last template rendered)."""
    got = []

    def rec(sender, template, context, **kw):
        got.append(context)
    template_rendered.connect(rec, a.app)
    try:
        code, b = get(url, c)
    finally:
        template_rendered.disconnect(rec, a.app)
    return code, b, (got[-1] if got else {})


def src(rel):
    return open(os.path.join(ROOT, rel), encoding="utf-8").read()


try:
    # -----------------------------------------------------------------------
    s.section("The 20 removals: each control goes, what does the same stays")
    code, b = get("/admin/users/%d?tab=performance" % A)
    s.check("1. the person's Performance tab has one \"+ Add a KPI\", the form's own toggle",
            code == 200 and b.count("+ Add a KPI") == 1 and 'id="add"' in b and "pp-add-btn" not in b, code)
    s.check("...and it sits above the KPI list, where the button was",
            0 <= b.find('id="add"') < b.find('class="admin-card pp-kpis"'))
    s.check("...the empty list points up to it", "Add one above" in b or "No KPIs" not in b)
    code, b = get("/admin/talent-release")
    s.check("2. Release results: the footer's Select all shown is gone (the header checkbox stays)",
            code == 200 and "rr-selall" not in b and "rr-selall" not in src("templates/admin_talent_release.html"),
            code)
    t = src("templates/admin_pm_calibration_groups.html") + src("templates/_gc_panels.html")   # its panels (2026-10-22)
    s.check("3. a calibration group's mode hint names Final bands without a second link (the footer links it)",
            "decides it on Final bands." in t and "admin_final_bands', g=g['id']) }}\">Final bands</a>." not in t)
    s.check("20. ...and the groups page has no Settings crumb under the lit Settings tab",
            "adm-crumb" not in t)
    t = src("templates/admin_panel_build.html")
    s.check("4. Panels: no inline Clear panels link beside the mode switch's own",
            "url_for('admin_clear_panels') }}\">Clear panels</a>" not in t and "use Clear panels, above" in t)
    code, b = get("/admin/reports")
    s.check("5. Results analysis: the Leadership Principle report button beside its subnav pill is gone",
            code == 200 and "Leadership Principle report &rarr;" not in b and "Leadership Principle report →" not in b,
            code)
    code, b = get(U["idp_overview"])
    s.check("6. Career Plan › Overview: no \"Progress, person by person\" (the Run tab is that page)",
            code == 200 and "Progress, person by person" not in b, code)
    code, b = get("/admin/assessor-extremes")
    s.check("7. Rater extremes: no Show everyone beside the business group row's All pill",
            code == 200 and "Show everyone" not in b
            and "Show everyone" not in src("templates/admin_assessor_extremes.html"), code)
    code, b = get("/admin/reports/all")
    s.check("8. the Reports hub: no 360 PDF row that only opened Results analysis",
            code == 200 and "Pick a business group and its units" not in b and "/admin/export/report.pdf" not in b
            and 'href="/admin/reports"' in b, code)
    s.check("...and the registry no longer lists it", not any(r[3] == "admin_export_report_pdf" for r in a.ADMIN_REPORTS))
    s.check("9. Panel rules' text no longer links to All cycles (its footer does)",
            "href=\"{{ url_for('admin_cycles')" not in src("templates/settings/cards/_rules.html"))
    s.check("10. Tiers' text no longer links to the Framework (the Framework card does)",
            "url_for('admin_framework')" not in src("templates/settings/cards/_tiers.html"))
    t = src("templates/admin_kpi_library.html")
    s.check("11. an empty KPI library names Bulk import rather than linking it a second time",
            "import them in bulk</a>" not in t and t.count("url_for('admin_kpi_library_import')") == 1)
    t = src("templates/admin_cycle_home.html")
    s.check("12. the Calendar: no Edit all dates / Set all the dates links below the mode switch",
            "Edit all dates &rsaquo;</a>" not in t and "Set all the dates &rsaquo;</a>" not in t)
    code, b = get("/admin/activity")
    s.check("13. Usage: the footer no longer links the Audit log (its tab does)",
            code == 200 and "the Audit log tab" in b and 'Who changed what, and when: the <a' not in b, code)
    t = src("templates/admin_cycles.html")
    s.check("14. All cycles: the lede names the Calendar without a link", "on its Calendar.</p>" in t)
    code, b = get("/admin/users?view=inactivate")
    s.check("15. Mark several as left: no \"‹ Users\" under the Users tab", code == 200 and "‹ Users" not in b, code)
    t = src("templates/admin_person.html")
    s.check("16. a person's past cycle: no Back to the current cycle beside the cycle picker",
            "Back to the current cycle" not in t and "Pick the current cycle above" in t)
    t = src("templates/admin_subject_detail.html")
    s.check("17. a person's 360 results: no Their panel button; the crumb names their page",
            "Their panel &rsaquo;" not in t and "their panel and answers" in t)
    code, b = get("/admin/module/pm")
    s.check("18. a module's Overview: no \"Progress, person by person\" beside the Run tab",
            code == 200 and "Progress, person by person" not in b, code)
    code, b = get("/admin/data-integrity?check=no_department")
    s.check("19 + bug 6. a check that fixes in place: no Open Users, and To fix says how to fix it here",
            code == 200 and "Open Users" not in b and "set the department in a person's row below" in b, code)
    code, b = get("/admin/data-integrity?check=no_manager")
    s.check("...the line-manager checks too", code == 200 and "Open Users" not in b
            and "set the line manager in a person's row below" in b, code)
    other = next((c["key"] for c in a.DATA_CHECKS if c["key"] not in a.DATA_FIX_LM + a.DATA_FIX_DEPT
                  and c.get("fix_ep") == "admin_users"), None)
    if other:
        code, b = get("/admin/data-integrity?check=%s" % other)
        s.check("...while a check fixed elsewhere keeps its Open button (%s)" % other,
                code == 200 and "Open Users" in b, code)

    # -----------------------------------------------------------------------
    s.section("Bug 1: the pages follow the top bar's cycle")
    if PAST:
        past = H.client_as(a, SUP)
        with past.session_transaction() as ss:
            ss["view_cycle_id"] = PAST["id"]
        code, b = get("/admin/users/%d" % A, past)
        s.check("the person page opens on the top bar's past cycle, read-only",
                code == 200 and "a past cycle: read-only" in b and PAST["name"] in b, code)
        code, b = get("/admin/users/%d" % A)
        s.check("...and on the active cycle when the top bar is on it", code == 200 and "a past cycle: read-only" not in b)
        code, b = get("/admin/users/%d?cycle=%d" % (A, CID), past)
        s.check("...its own picker still wins", code == 200 and "a past cycle: read-only" not in b)
        code, b, ctx = rendered("/admin/cycle", past)
        s.check("the Calendar opens on the top bar's cycle", code == 200 and ctx.get("cyc") is not None
                and ctx["cyc"]["id"] == PAST["id"], code)
        code, b, ctx = rendered("/admin/windows", past)
        s.check("Edit all dates opens on it too", code == 200 and ctx.get("cyc") is not None
                and ctx["cyc"]["id"] == PAST["id"], code)
        code, b, ctx = rendered("/admin/cycle")
        s.check("...both on the active cycle by default", code == 200 and ctx.get("cyc") is not None
                and ctx["cyc"]["id"] == CID, code)
        code, b, ctx = rendered("/admin/talent-release", past)
        per = ctx.get("period")
        s.check("Release results keeps the cycle it releases and says the top bar names another",
                code == 200 and per is not None and per["id"] != PAST["id"] and "rr2-topnote" in b
                and "this page releases" in b, code)
        code, b = get("/admin/talent-release")
        s.check("...and says nothing when the two agree", code == 200 and "rr2-topnote" not in b)
        s.check("a save on Edit all dates never takes its cycle from the session",
                'viewed_cycle_id(db) if request.method == "GET" else None' in src("app.py"))

    # -----------------------------------------------------------------------
    s.section("Bugs 2-5 and 7")
    js = src("static/admin.js")
    s.check("2. a panel opener's #id reaches the panel (Needs attention's Add a KPI opens the add form)",
            "from.hash" in js and "load(p, p.getAttribute(\"data-panel-src\"), hs)" in js
            and "else if (hs) reveal(slotOf(p), hs);" in js)
    s.check("...that row now opens the page's own Add panel (?panel=kpi-add, 2026-10-30), not the Performance panel",
            '"No KPIs this cycle", perf + "&panel=kpi-add", "Add a KPI"' in src("app.py")
            and 'if "panel=kpi-" in h:' in src("app.py"))
    code, b = get("/admin/users/%d" % A)
    s.check("3. The full trail opens this person's audit trail", code == 200 and U["audit"] in b, code)
    with a.app.test_request_context("/"):
        dbx = a.get_db()
        me = dbx.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone()
        a.g.user = me
        m = a._home_bg_matrix(dbx, me, a.active_cycle(dbx))
    ix = next((i for i, c in enumerate(m["cols"]) if c["key"] == "idp"), None)
    urls = [(r["bg"], r["cells"][ix]["url"]) for r in m["rows"] if ix is not None and r["cells"][ix]["url"]]
    if ix is None or not urls:
        s.check("4. Home's Career Plan column: a group's cell opens that group's progress (no live cell to check: "
                "the link is read from the code)",
                'return url_for("admin_module_progress", key="idp", **({"fbg": bg} if sup and bg else {}))'
                in src("app.py"))
    else:
        s.check("4. Home's Career Plan column: each group's cell opens that group's progress",
                all(u_.startswith(U["progress_idp"]) and "fbg=" in u_ for _bg, u_ in urls), urls[:3])
    code, b = get("/admin/windows")
    s.check("5. Edit all dates' Change it on Edit cycle opens Edit cycle", code == 200 and "#adm-cyc-edit\"" in b, code)
    s.check("...the Calendar opens its Edit cycle box on that address",
            'if (location.hash === "#adm-cyc-edit") show(true);' in src("templates/admin_cycle_home.html"))
    code, b = get("/admin/competency/profiles")
    s.check("7. Assign competencies' crumb says where it sits (Run), not Settings › Job profiles",
            code == 200 and "Run › Assign competencies" in b and "Settings</a> › Job profiles" not in b, code)
finally:
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
