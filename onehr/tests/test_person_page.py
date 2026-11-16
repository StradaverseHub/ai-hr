"""The person page, part 1 (Chris, 2026-10-10, canvas row I): one person, everything set for them.

"apart from having the module-driven configuration, we also can have user-driven configuration ... admin can see the
PM, TM, IDP configuration under one roof, so going into the user PM, admin can see the full KPI table and the details
and the control to either add, edit, or delete the KPI ... and route the KPI line approval. And also view the past
history cycle record ... Also setting like, LM, HOD, BUCEO, BGCEO of the employees, and the role setting of the
person."

Part 1 is the Overview (module cards, what needs attention, what changed, who they report to, their roles) and
Performance (the KPI table with add / edit / delete and one moderator per KPI). Every write goes through the module
pages' own helpers, so the checks here also pin that: the import's KPI rules, the Users page's line-manager change
(which now moves the KPI lines nobody has moderated), the Leaders page's HOD plan and checks, the CEO seat helpers.
Everything is synthetic (ZZPP-*) and removed at the end.
"""
import html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The person page -- one person, everything set for them (part 1: Overview, Performance)")

BG, BG2, CO1, CO2 = "ZZPP BG", "ZZPP Other BG", "ZZPP CO1", "ZZPP CO2"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZPP-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM activity_log WHERE id > ? AND (detail LIKE '%ZZPP%' OR detail LIKE '%ZZ PP%')", (LOG0,))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    PAST = db.execute("SELECT id FROM cycles WHERE id!=? ORDER BY id DESC LIMIT 1", (CID,)).fetchone()
    PAST = PAST[0] if PAST else None
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    _cleanup(db)
    _mods = [tuple(r) for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))]
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','pm','tm')", (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, bg=BG, co=CO1, mgr=None, hod=None, left=None, role="user", admin_bg=None, yos=3):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=hod,
                 manager_id=mgr, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=bg, company=co,
                 department="ZZPP Dept", job_title="ZZPP Title", years_of_service=yos, confirmation_date=None,
                 left_at=left, is_demo=0, role=role, admin_bg=admin_bg)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    LM = mk("ZZPP-LM", "ZZ PP Linemanager")
    LM2 = mk("ZZPP-LM2", "ZZ PP Newmanager")
    MX = mk("ZZPP-MX", "ZZ PP Matrix", co=CO2)
    HOD1 = mk("ZZPP-HOD1", "ZZ PP Hodone")
    HOD2 = mk("ZZPP-HOD2", "ZZ PP Hodtwo")
    FAR = mk("ZZPP-FAR", "ZZ PP Elsewhere", bg=BG2, co="ZZPP CO9")
    A = mk("ZZPP-A", "ZZ PP Alpha", mgr=LM, hod=HOD1)
    NEW = mk("ZZPP-NEW", "ZZ PP Newcomer", mgr=LM, yos=0)                 # not confirmed: not taking part
    OTHER_ADM = mk("ZZPP-ADM2", "ZZ PP Otheradmin", bg=BG2, role="admin", admin_bg=BG2)
    BG_ADM = mk("ZZPP-ADM1", "ZZ PP Groupadmin", role="admin", admin_bg=BG)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?),(?,?)",
               (BG, CO1, BG, CO2, BG2, "ZZPP CO9"))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (BG,))
    db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
               "description, unit, method, rate1, rate2, rate3, rate4, rate5, weightage_default) "
               "VALUES (?, '*', '*', 0, '*', 'ZZPP Library KPI', 'Financial', 'from the library', 'RM', 'more', "
               "70, 80, 90, 100, 110, 15)", (BG,))
    LIB = db.execute("SELECT id FROM pm_kpi_library WHERE business_group=?", (BG,)).fetchone()[0]
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def u(uid):
    return ctx(lambda d: dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


def tid(name, sid=None):
    r = H.rows(a, "SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? AND kpi_name=?",
               (CID, sid or A, name))
    return r[0][0] if r else None


def chain(name, sid=None):
    t = tid(name, sid)
    return None if t is None else [r[0] for r in H.rows(
        a, "SELECT approver_id FROM pm_kpi_target_approvers WHERE kpi_target_id=? ORDER BY seq", (t,))]


def logged(action, like=""):
    return H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action=? AND target_user_id=? AND detail LIKE ? AND id>?",
                 (action, A, "%" + like + "%", LOG0))


sup = H.client_as(a, SUP)
KPI = "/admin/users/%d/kpi" % A
LINES = "/admin/users/%d/lines" % A


def libid(name):
    """The library row of a KPI name in this group (made when there is none): every KPI an admin adds is picked from the
    library now (2026-10-30), so a test that adds one by name picks (or first makes) its library row."""
    def go(d):
        r = d.execute("SELECT id FROM pm_kpi_library WHERE business_group=? AND kpi_name=?", (BG, name)).fetchone()
        if r:
            return r[0]
        cur = d.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, "
                        "category, description, unit, method, bu_level) VALUES (?, '*', '*', 0, '*', ?, 'Financial', "
                        "'from the library', '%', 'more', 0)", (BG, name))
        d.commit()
        return cur.lastrowid
    return ctx(go)


def kpi(action, **f):
    d = {"csrf_token": "tok", "action": action}
    d.update(f)
    if action == "add" and "library_id" not in d and d.get("kpi"):
        d["library_id"] = str(libid(d["kpi"]))
    return sup.post(KPI, data=d, follow_redirects=True)


def page(tab="overview", extra=""):
    r = sup.get("/admin/users/%d?tab=%s%s" % (A, tab, extra))
    return r.status_code, html.unescape(r.get_data(as_text=True))


RATES = {"rate 1": "80", "rate 2": "90", "rate 3": "100", "rate 4": "110", "rate 5": "120"}

try:
    # -----------------------------------------------------------------------
    s.section("who may open it")
    code, b = page()
    s.check("a super admin opens a person's page", code == 200 and "ZZ PP Alpha" in b and "Who they report to" in b,
            code)
    s.check("...and it sits under People in the sidebar", 'class="pp"' in b and "People" in b)
    s.check("an admin login has no person page", sup.get("/admin/users/%d" % SUP).status_code == 404)
    s.check("a BG admin of another group can't open it",
            H.client_as(a, OTHER_ADM).get("/admin/users/%d" % A).status_code == 403)
    s.check("an employee can't", H.client_as(a, LM).get("/admin/users/%d" % A).status_code in (302, 403, 404))
    users = html.unescape(sup.get("/admin/users?q=ZZPP-A").get_data(as_text=True))
    s.check("the Users list links each name to the person page", 'href="/admin/users/%d"' % A in users)

    # -----------------------------------------------------------------------
    s.section("the Overview")
    s.check("who they report to: line manager and HOD by name", "ZZ PP Linemanager" in b and "ZZ PP Hodone" in b)
    s.check("what needs attention: no KPIs yet, and no BU CEO / BG CEO for their unit and group",
            "No KPIs this cycle" in b and "%s has no BU CEO" % CO1 in b and "has no BG CEO" in b)
    s.check("the module cards are there", all(x in b for x in ("Performance", "Competency", "360 Feedback",
                                                               "Career Plan")))
    s.check("their roles: no direct reports", "no direct reports" in b)
    _c, lmb = 0, sup.get("/admin/users/%d" % LM).get_data(as_text=True)
    s.check("the line manager's own page says who reports to them", "LM of 2" in lmb and "2 direct reports" in lmb)

    # -----------------------------------------------------------------------
    s.section("Performance: add a KPI")
    r = kpi("add", kpi="ZZPP Revenue", weightage="40", method="more", moderator="lm", **RATES)
    s.check("their own KPI is added, agreed, to the line manager",
            "added" in html.unescape(r.get_data(as_text=True)) and chain("ZZPP Revenue") == [LM]
            and H.one(a, "SELECT status FROM pm_kpi_targets WHERE id=?", (tid("ZZPP Revenue"),)) == "approved")
    s.check("...and the trail says so", logged("pm_kpi_add", "ZZPP Revenue") == 1)
    r = kpi("add", kpi="ZZPP Milestones", weightage="25", method="more", moderator="matrix", matrix_eid="ZZPP-MX",
            **RATES)
    s.check("a KPI for the matrix manager goes to them alone", chain("ZZPP Milestones") == [MX])
    r = kpi("add", library_id=str(LIB), moderator="lm")
    s.check("a library KPI gives no figures or weight: with none typed the add is refused (the library holds no numbers)",
            tid("ZZPP Library KPI") is None)
    r = kpi("add", library_id=str(LIB), moderator="lm", weightage="15", **RATES)
    t = tid("ZZPP Library KPI")
    row = H.rows(a, "SELECT weightage, rate1, rate5, unit, library_id FROM pm_kpi_targets WHERE id=?", (t,)) if t else []
    s.check("a library KPI fills its name, unit and direction; the weight and figures are the admin's own typing, never the library's",
            row and row[0][0] == 15.0 and row[0][1] != 70.0 and row[0][3] == "RM" and row[0][4] == LIB, row and tuple(row[0]))
    r = kpi("add", kpi="ZZPP Revenue", weightage="10", method="more", moderator="lm", **RATES)
    s.check("a second KPI with the same name is refused", "already has a KPI called" in html.unescape(r.get_data(as_text=True)))
    r = kpi("add", kpi="ZZPP Self", weightage="10", method="more", moderator="matrix", matrix_eid="ZZPP-A", **RATES)
    s.check("they can't moderate their own KPI", "their own matrix manager" in html.unescape(r.get_data(as_text=True))
            and tid("ZZPP Self") is None)
    r = kpi("add", kpi="ZZPP Bad", weightage="0", method="more", moderator="lm", **RATES)
    s.check("the import's rules apply (a zero weight)", "must be a positive number" in html.unescape(r.get_data(as_text=True))
            and tid("ZZPP Bad") is None)
    r = kpi("add", kpi="ZZPP NoRates", weightage="10", method="more", moderator="lm")
    s.check("...and the group's scoring (Rate 1-5)", "needs Rate 1-5" in html.unescape(r.get_data(as_text=True)))
    r = sup.post("/admin/users/%d/kpi" % NEW, data={"csrf_token": "tok", "action": "add", "kpi": "ZZPP X",
                                                     "weightage": "10", "method": "more", "moderator": "lm", **RATES},
                 follow_redirects=True)
    s.check("someone not taking part gets no KPI", "isn't taking part" in html.unescape(r.get_data(as_text=True))
            and tid("ZZPP X", NEW) is None)

    code, b = page("performance")
    s.check("the table shows each KPI and who moderates it",
            "ZZPP Milestones" in b and 'title="Matrix manager">Matrix</span> ZZ PP Matrix' in b
            and 'title="Line manager">LM</span> ZZ PP Linemanager' in b)
    s.check("the flow strip counts what waits on each moderator", "Moderation · 0 of 3 done" in b
            and "2 with the line manager" in b and "1 with a matrix manager" in b)
    s.check("the weights read 80%, not 100", "80%" in b and "pp-bad" in b)

    def perf_card():
        _c, ov = page()
        return ov[ov.index("<b>Performance</b>"):ov.index("<b>Competency</b>")]

    def comp_card():
        _c, ov = page()
        return ov[ov.index("<b>Competency</b>"):ov.index("<b>360 Feedback</b>")]

    rows0, summ0 = ctx(lambda d: a._person_kpis(d, d.execute("SELECT * FROM users WHERE id=?", (A,)).fetchone(), CID,
                                                True))
    pc = perf_card()
    s.check("nobody has submitted: the card says it waits on the employee, not the line manager",
            "Waiting: the employee \u00b7 0 of %d submitted" % summ0["n"] in pc and "on the line manager" not in pc
            and summ0["n"] == len(rows0) and all(r["word"] == "Not submitted yet" for r in rows0)
            and summ0["wait_lm"] > 0, (summ0["n"], summ0.get("wait_text")))

    # BU KPI chip (2026-10-29): a unit-wide line Group People fills is marked, and is not the employee's or the LM's
    ctx(lambda d: (d.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, "
                             "category, description, unit, method, rate1, rate2, rate3, rate4, rate5, weightage_default, "
                             "bu_level) VALUES (?, '*', '*', 0, '*', 'ZZPP BU Profit', 'Financial', 'unit-wide', 'RM', "
                             "'more', 1, 2, 3, 4, 5, 5, 0)", (BG,)), d.commit()))
    # a BU-level KPI can't be added on the person page any more (it comes from the BU KPI page): the line is made as a
    # plain one, then the library row is marked BU-level, which is how the page tells a BU line by name
    kpi("add", kpi="ZZPP BU Profit", weightage="5", method="more", moderator="lm", **RATES)
    ctx(lambda d: (d.execute("UPDATE pm_kpi_library SET bu_level=1 WHERE business_group=? AND kpi_name='ZZPP BU Profit'",
                             (BG,)), d.commit()))
    code, b = page("performance")
    rows_, summ_ = ctx(lambda d: a._person_kpis(d, d.execute("SELECT * FROM users WHERE id=?", (A,)).fetchone(), CID, True))
    byname = {r["name"]: r for r in rows_}
    bu_r, own_r = byname.get("ZZPP BU Profit"), byname.get("ZZPP Revenue")
    s.check("a BU-level line is flagged bu, routed to Group People and waits on them",
            bu_r and bu_r["bu"] is True and bu_r["route"] == "bu" and bu_r["word"] == "Group People fills"
            and bu_r["state"] == "wait", bu_r and (bu_r["bu"], bu_r["route"], bu_r["word"]))
    s.check("a personal line is not a BU line and keeps its line manager route",
            own_r and own_r["bu"] is False and own_r["route"] == "lm", own_r and (own_r["bu"], own_r["route"]))
    s.check("the BU line counts as submitted and waits on no moderator",
            summ_["submitted"] >= 1 and summ_["wait_lm"] == sum(1 for r in rows_ if r["route"] == "lm"))
    s.check("the page shows the BU KPI chip once, on the BU line only, and 'Group People fills' in both cells",
            b.count('class="pp-chip" title="A BU KPI') == 1 and b.count("Group People fills") >= 2
            and b.index("ZZPP BU Profit") < b.index("BU KPI</span>")
            and "ZZPP Revenue</b></span>" in b)
    ctx(lambda d: (d.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets "
                             "WHERE subject_id=? AND kpi_name='ZZPP BU Profit')", (A,)),
                   d.execute("DELETE FROM pm_kpi_targets WHERE subject_id=? AND kpi_name='ZZPP BU Profit'", (A,)),
                   d.execute("DELETE FROM pm_kpi_library WHERE business_group=? AND kpi_name='ZZPP BU Profit'", (BG,)),
                   d.commit()))
    code, b = page("performance")
    s.check("...and with it gone the chip is gone", "BU KPI</span>" not in b)
    # a field named "method" shadows form.method in the browser, so the page-wide CSRF stamp skipped these forms
    # and Save answered "Session expired" (found in browser QC): the forms carry their own token, and the stamp reads
    # the attribute
    import re as _re
    forms = _re.findall(r"<form[^>]*admin_person_kpi|<form method=\"post\" action=\"/admin/users/%d/kpi\"[^>]*>(.*?)</form>" % A,
                        b, _re.S)
    edit_add = [f for f in forms if 'name="method"' in f]
    s.check("every KPI form with a Method field carries its own CSRF token",
            edit_add and all('name="csrf_token"' in f for f in edit_add), len(edit_add))
    base = open(os.path.join(H.HARNESS, "templates", "base.html"), encoding="utf-8").read()
    s.check("...and the page-wide stamp reads the method attribute, not the shadowable property",
            "f.getAttribute('method')" in base and "if (f.method !== 'post')" not in base)

    # -----------------------------------------------------------------------
    s.section("Performance: edit, re-route, lock, delete")
    t = tid("ZZPP Revenue")
    ctx(lambda d: (d.execute("INSERT INTO pm_kpi_moderation_drafts(kpi_target_id, approver_id, adjusted_value) "
                             "VALUES (?,?,?)", (t, LM, 99)), d.commit()) if t else None)
    r = kpi("edit", kpi_target_id=str(t), kpi="ZZPP Revenue", weightage="45", method="more", moderator="matrix",
            matrix_eid="ZZPP-MX", **RATES)
    s.check("an edit saves the new weight and moves it to the matrix manager",
            H.one(a, "SELECT weightage FROM pm_kpi_targets WHERE id=?", (t,)) == 45.0 and chain("ZZPP Revenue") == [MX])
    s.check("...the line manager's draft on it is dropped, since it can't follow the line",
            H.one(a, "SELECT COUNT(*) FROM pm_kpi_moderation_drafts WHERE kpi_target_id=?", (t,)) == 0)
    s.check("...and the trail names what changed", logged("pm_kpi_edit", "weightage") == 1
            and logged("pm_kpi_edit", "matrix manager") == 1)
    r = kpi("edit", kpi_target_id=str(t), kpi="ZZPP Revenue", weightage="45", method="more", moderator="lm", **RATES)
    s.check("...and back to the line manager", chain("ZZPP Revenue") == [LM])
    tm = tid("ZZPP Milestones")
    ctx(lambda d: (d.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) "
                             "VALUES (?,?,?,0)", (tm, 95, A)),
                   d.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) "
                             "VALUES (?,1,'confirm',95,?)", (tm, MX)), d.commit()))
    r = kpi("edit", kpi_target_id=str(tm), kpi="ZZPP Milestones", weightage="5", method="more", moderator="lm",
            **RATES)
    s.check("a moderated KPI can't be edited", "is locked" in html.unescape(r.get_data(as_text=True))
            and H.one(a, "SELECT weightage FROM pm_kpi_targets WHERE id=?", (tm,)) == 25.0 and chain("ZZPP Milestones") == [MX])
    r = kpi("delete", kpi_target_id=str(tm), reason="test")
    s.check("...nor deleted", tid("ZZPP Milestones") is not None)
    code, b = page("performance")
    s.check("...and the table shows it locked: View, which opens the read-only panel, no Edit",
            'data-panel-open="kpi-%d">View</a>' % tm in b and 'id="kpi-%d"' % tm in b
            and 'data-panel-open="kpi-%d">Edit</a>' % tm not in b and "Locked:" in b
            and 'name="kpi_target_id" value="%d"' % tm not in b)
    tl = tid("ZZPP Library KPI")
    ctx(lambda d: (d.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) "
                             "VALUES (?,?,?,0)", (tl, 80, A)), d.commit()))
    rows1, summ1 = ctx(lambda d: a._person_kpis(d, d.execute("SELECT * FROM users WHERE id=?", (A,)).fetchone(), CID,
                                                True))
    e1 = sum(1 for r in rows1 if r["word"] == "Not submitted yet")
    l1 = sum(1 for r in rows1 if r["state"] != "done" and r["route"] == "lm" and r["word"] != "Not submitted yet")
    pc = perf_card()
    s.check("once a line has a result the card counts the employee's and the line manager's separately",
            e1 >= 1 and l1 >= 1 and e1 < summ1["n"]
            and "Waiting: %d not submitted \u00b7 %d on the line manager" % (e1, l1) in pc
            and "the employee" not in pc and summ1.get("wait_text") == "Waiting: %d not submitted \u00b7 %d on the line manager" % (e1, l1),
            (e1, l1, summ1.get("wait_text")))
    s.check("...and wait_lm still counts by route (the line manager panel's own number)",
            summ1["wait_lm"] == sum(1 for r in rows1 if r["state"] != "done" and r["route"] == "lm")
            and summ1["wait_lm"] > l1)
    r = kpi("delete", kpi_target_id=str(tl))
    s.check("deleting a KPI they entered a result on needs a reason", "Give a reason" in html.unescape(r.get_data(as_text=True))
            and tid("ZZPP Library KPI") is not None)
    r = kpi("delete", kpi_target_id=str(tl), reason="ZZPP wrong KPI for their role")
    s.check("...with one it goes, and the trail keeps the reason", tid("ZZPP Library KPI") is None
            and logged("pm_kpi_delete", "wrong KPI for their role") == 1)
    other = ctx(lambda d: d.execute("SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND subject_id NOT IN "
                                    "(SELECT id FROM users WHERE employee_id LIKE 'ZZPP-%') LIMIT 1", (CID,)).fetchone())
    if other:
        r = sup.post(KPI, data={"csrf_token": "tok", "action": "delete", "kpi_target_id": other[0], "reason": "x"})
        s.check("a KPI that isn't theirs can't be reached through their page", r.status_code == 404
                and H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE id=?", (other[0],)) == 1, r.status_code)
    r = sup.post(KPI, data={"csrf_token": "tok", "action": "promote"})
    s.check("an unknown action is refused", r.status_code == 400)

    # -----------------------------------------------------------------------
    s.section("the line manager: preview, then what moves")
    kpi("add", kpi="ZZPP Quality", weightage="10", method="more", moderator="lm", **RATES)
    before = (chain("ZZPP Revenue"), chain("ZZPP Quality"), chain("ZZPP Milestones"))
    # "panels as filed" (Chris, 2026-10-29/30): the OLD line manager sits on the 360 panel as line_manager, and a change of
    # line manager must leave that row exactly as it is: not relabelled, not removed, and the new one not added
    ctx(lambda d: (d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) "
                             "VALUES (?,?,?,'line_manager')", (CID, A, LM)), d.commit()))
    def panel_rows():
        return ctx(lambda d: [tuple(r_) for r_ in d.execute(
            "SELECT assessor_id, relationship, archived FROM assignments WHERE cycle_id=? AND subject_id=? "
            "ORDER BY assessor_id, relationship", (CID, A))])
    panel0 = panel_rows()
    s.check("(fixture: the old line manager is on their panel as line manager)", panel0 == [(LM, "line_manager", 0)], panel0)
    r = sup.post(LINES, data={"csrf_token": "tok", "action": "lm_preview", "lm_eid": "ZZPP-LM2"})
    b = html.unescape(r.get_data(as_text=True))
    s.check("the preview says the 360 panel stays as filed: no Keep / Take-off choice, no disposition radio",
            r.status_code == 200 and "Stays as filed" in b and 'type="radio" name="disposition"' not in b
            and "Take them off" not in b and "Keep them, as a matrix manager" not in b
            and panel_rows() == panel0, (r.status_code, "Stays as filed" in b, 'type="radio" name="disposition"' in b, "Take them off" in b,
                                           "Keep them, as a matrix manager" in b, panel_rows() == panel0))
    s.check("the preview names the KPIs that move, and writes nothing",
            r.status_code == 200 and "KPIs that move to them" in b and "ZZPP Revenue, ZZPP Quality" in b
            and u(A)["manager_id"] == LM and (chain("ZZPP Revenue"), chain("ZZPP Quality"),
                                              chain("ZZPP Milestones")) == before)
    r = sup.post(LINES, data={"csrf_token": "tok", "action": "lm_apply", "lm_eid": "ZZPP-LM2",
                              "disposition": "remove"}, follow_redirects=True)   # a stale form's field is ignored
    s.check("Apply makes them the line manager", u(A)["manager_id"] == LM2
            and "2 KPI line(s) nobody had moderated now go to them" in html.unescape(r.get_data(as_text=True)))
    s.check("...the KPIs that waited on the old one move", chain("ZZPP Revenue") == [LM2]
            and chain("ZZPP Quality") == [LM2])
    s.check("...a moderated, matrix-routed KPI stays", chain("ZZPP Milestones") == [MX])
    s.check("...their 360 panel is exactly as filed: the old line manager's row untouched, the new one not added",
            panel_rows() == panel0 and H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND subject_id=? "
                                                "AND assessor_id=?", (CID, A, LM2)) == 0, panel_rows())
    s.check("...and the flash has no 'not on the panel' sentence", "They aren't on" not in html.unescape(r.get_data(as_text=True)))
    s.check("...and the trail has it", logged("set_manager", "ZZ PP Newmanager") == 1)
    code, b = page("performance")
    s.check("a moderated KPI keeps its moderator's name with no LM / Matrix tag (it is history, not routing)",
            "ZZ PP Matrix" in b and 'title="Matrix manager">Matrix</span> ZZ PP Matrix' not in b
            and "with a matrix manager" not in b)
    r = sup.post(LINES, data={"csrf_token": "tok", "action": "lm_preview", "lm_eid": "ZZPP-A"}, follow_redirects=True)
    s.check("nobody is their own line manager", "can't be their own line manager" in html.unescape(r.get_data(as_text=True)))
    # Data integrity's line-manager fix works the same way: manager_id moves, the panel stays as filed
    r = sup.post("/admin/data-integrity/fix", data={"csrf_token": "tok", "check": "no_manager", "uid": str(A),
                                                    "lm_eid": "ZZPP-MX"})
    s.check("Data integrity's fix changes the line manager and leaves the 360 panel as filed",
            r.status_code == 302 and u(A)["manager_id"] == MX and panel_rows() == panel0
            and H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND subject_id=? AND assessor_id=?",
                      (CID, A, MX)) == 0, (u(A)["manager_id"], panel_rows()))
    ctx(lambda d: (d.execute("UPDATE users SET manager_id=? WHERE id=?", (LM2, A)), d.commit()))   # back for what follows
    # the Users page's own Change line manager is gone (the review, 2026-10-10, canvas K4): the person page owns it
    _lm0 = u(A)["manager_id"]
    sup.post("/admin/users", data={"csrf_token": "tok", "action": "set_manager", "user_id": A, "manager_eid": "ZZPP-LM",
                                   "disposition": "reassign"})
    s.check("the Users page no longer changes a line manager (only the person page, with its checks)",
            _lm0 != LM and u(A)["manager_id"] == _lm0, (_lm0, u(A)["manager_id"]))

    # -----------------------------------------------------------------------
    s.section("the HOD: the Leaders page's plan and checks, for one person")
    r = sup.post(LINES, data={"csrf_token": "tok", "action": "hod_preview", "hod_eid": "ZZPP-HOD2"})
    b = html.unescape(r.get_data(as_text=True))
    s.check("the preview shows the change and writes nothing", r.status_code == 200 and "ZZ PP Hodone" in b
            and "Make ZZ PP Hodtwo their HOD" in b and u(A)["hod_id"] == HOD1)
    fp = ctx(lambda d: a._hod_person_plan(d, u(SUP), u(HOD2), u(A)))
    r = sup.post(LINES, data={"csrf_token": "tok", "action": "hod_apply", "hod_eid": "ZZPP-HOD2", "uid": A,
                              "fingerprint": "stale", "ack": "1"})
    s.check("a stale preview is refused", u(A)["hod_id"] == HOD1 and "Something changed" in html.unescape(r.get_data(as_text=True)))
    data = {"csrf_token": "tok", "action": "hod_apply", "hod_eid": "ZZPP-HOD2", "uid": A, "fingerprint": fp["fingerprint"]}
    if fp["warnings"]:
        r = sup.post(LINES, data=data)
        s.check("its warnings need ticking", u(A)["hod_id"] == HOD1 and "Tick the box" in html.unescape(r.get_data(as_text=True)))
        data["ack"] = "1"
    if fp["blockers"]:
        data["override_reason"] = "ZZPP test"
    r = sup.post(LINES, data=data, follow_redirects=True)
    s.check("Apply changes their HOD, for them only", u(A)["hod_id"] == HOD2 and u(NEW)["hod_id"] is None,
            html.unescape(r.get_data(as_text=True))[:0])
    s.check("...logged the Leaders page's way", logged("hod_assign", "ZZ PP Hodtwo") == 1)
    r = sup.post(LINES, data={"csrf_token": "tok", "action": "hod_preview", "hod_eid": "ZZPP-FAR"},
                 follow_redirects=True)
    pg_far = html.unescape(r.get_data(as_text=True))
    s.check("an HOD from another business group is previewed for the super admin, not refused (any person may be HOD across "
            "groups; test_hod_cross_bg covers every path), and the preview writes nothing",
            "but not business groups" not in pg_far and "Make ZZ PP Elsewhere their HOD" in pg_far
            and u(A)["hod_id"] == HOD2 and u(FAR)["business_group"] != u(A)["business_group"], pg_far[:0])

    # -----------------------------------------------------------------------
    s.section("their roles: the CEO seats, super admin only")
    r = sup.post(LINES, data={"csrf_token": "tok", "action": "set_buceo", "company": CO2}, follow_redirects=True)
    s.check("a super admin makes them BU CEO of a unit", u(A)["buceo_company"] == CO2 and u(A)["buceo_bg"] == BG)
    code, b = page()
    s.check("...their page says so", "BU CEO · %s" % a.proper_name(CO2) in b)
    sup.post(LINES, data={"csrf_token": "tok", "action": "clear_buceo"})
    s.check("...and Remove clears it", u(A)["buceo_company"] is None)
    _su, BGA, _e = H.actors(a)
    bga_bg = BGA["admin_bg"] if BGA else None
    bgc = H.client_as(a, BG_ADM)
    s.check("(their own BG admin can open the page)", bgc.get("/admin/users/%d" % A).status_code == 200)
    r = bgc.post(LINES, data={"csrf_token": "tok", "action": "set_bgceo", "target_bg": BG})
    s.check("...but can't make them its BG CEO: view only (Chris, 2026-10-19)", r.status_code == 403
            and u(A)["bgceo_bg"] is None, r.status_code)
    sup.post(LINES, data={"csrf_token": "tok", "action": "set_bgceo", "target_bg": BG})
    s.check("the super admin makes them BG CEO", u(A)["bgceo_bg"] == BG)
    sup.post(LINES, data={"csrf_token": "tok", "action": "clear_bgceo"})
    s.check("...and takes it away again", u(A)["bgceo_bg"] is None)
    r = H.client_as(a, OTHER_ADM).post(LINES, data={"csrf_token": "tok", "action": "set_bgceo", "target_bg": BG})
    s.check("an admin of another group can't reach them at all", r.status_code == 403 and u(A)["bgceo_bg"] is None)

    # -----------------------------------------------------------------------
    s.section("the Competency card: not started vs none")
    s.check("no competencies assigned: 'No self-assessment this cycle'",
            "No self-assessment this cycle" in comp_card() and "not started yet" not in comp_card())
    ctx(lambda d: (d.execute("INSERT INTO tc_skills(skill_code, title, level) VALUES ('ZZPP-SK-1', 'ZZPP Skill', 3)"),
                   d.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future) "
                             "SELECT ?, ?, id, 0 FROM tc_skills WHERE skill_code='ZZPP-SK-1'", (CID, A)), d.commit()))
    cc = comp_card()
    s.check("competencies assigned, self-assessment never opened: 'Self-assessment not started yet'",
            H.one(a, "SELECT COUNT(*) FROM tc_assessments WHERE cycle_id=? AND subject_id=?", (CID, A)) == 0
            and "Self-assessment not started yet" in cc and "No self-assessment this cycle" not in cc, cc)
    ctx(lambda d: (d.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?,'pending')",
                             (CID, A)), d.commit()))
    cc = comp_card()
    s.check("once the self-assessment is open, the 'not submitted yet' line takes over",
            "Self-assessment not submitted yet" in cc and "not started yet" not in cc, cc)
    ctx(lambda d: (d.execute("DELETE FROM tc_assessments WHERE cycle_id=? AND subject_id=?", (CID, A)),
                   d.execute("DELETE FROM tc_assignments WHERE subject_id=?", (A,)),
                   d.execute("DELETE FROM tc_skills WHERE skill_code='ZZPP-SK-1'"), d.commit()))

    # -----------------------------------------------------------------------
    s.section("a past cycle is read-only")
    if PAST:
        code, b = page("performance", "&cycle=%d" % PAST)
        s.check("a past cycle reads as read-only, with no add / edit", code == 200 and "a past cycle: read-only" in b
                and 'value="add"' not in b and 'value="edit"' not in b)
    r = sup.get("/admin/users/%d?tab=nonsense" % A)
    s.check("an unknown tab falls back to the Overview", r.status_code == 200 and "Who they report to" in
            html.unescape(r.get_data(as_text=True)))
finally:
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        db.execute("DELETE FROM tc_skills WHERE skill_code='ZZPP-SK-1'")
        for k, act in _mods:
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (act, CID, k))
        db.commit()

sys.exit(s.done())
