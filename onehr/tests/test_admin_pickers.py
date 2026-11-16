"""Admin fields are picked, not typed (Chris, 2026-10-19: "for admin page, any field that requires a fill in, like in this
attached calibration group setting, it should run as dropdown for selection to ensure data validation, including adding
employee to the group, and the calibrator creation, should use search function to find from our user pool. Run a full
sweep to look for other similar fields that require input of employee data like ID to follow it").

What this suite holds:
  * no admin template asks for someone's Employee ID in a text box: every person is searched and picked (the hidden
    pick-val carries the ID), the only typed Employee ID being a NEW person's own; no "Paste Employee IDs" box is left
  * no admin form takes a department, job title, family · group or scope as free text: each is a list, with "A new …"
    where a new one makes sense (department, job title, family, category), and none where it can't (Add a profile)
  * the picker is strict (static/admin.js): typed text that isn't a pick stops the form through the browser's own check,
    before OneHR's confirm box; it no longer turns typed text into the value; several people pick as chips
  * the server refuses what no list offers (Edit details, Add a person, Data integrity, a KPI line, the KPI library's
    family and departments, Add a profile) and takes "__new__" + <field>_new, mapped to the list's spelling when it is
    on it after all
  * calibration groups: the calibrator and members are searched and picked (several at once); a leaver is refused as
    calibrator or member; the department comes from a list and matches exactly ("Sales" no longer brings in "Sales
    Admin"); a rule saved before the list keeps matching the old way; "Show them as" is one of the group's names, a new
    one, or their own department
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Admin fields are picked, not typed")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO = "ZZPK Group", "ZZPK U1"
TPL = os.path.join(H.REPO, "templates")


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9PK-%'")]
    gids = [r[0] for r in db.execute("SELECT id FROM pm_calibration_groups WHERE name LIKE 'ZZPK %'")]
    for g_ in gids:
        db.execute("DELETE FROM pm_calibration_group_members WHERE group_id=?", (g_,))
        db.execute("DELETE FROM app_settings WHERE key IN (?, ?)", ("calib_group_rules:%d" % g_,
                                                                   "calib_group_mode:%d" % g_))
        db.execute("DELETE FROM pm_calibration_groups WHERE id=?", (g_,))
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM tc_job_profiles WHERE department LIKE 'ZZPK %'")
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, dept, title="ZZPK Officer", left=False, grade="14"):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, left_at) VALUES (?,?, 'x', 'user', ?,?,?,?,?,?,?)",
                      (eid.lower(), "ZZ PK " + eid[-2:], eid, BG, CO, dept, title, grade,
                       "2026-01-01" if left else None)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    S1 = person(db, "ZZ9PK-S1", "ZZPK Sales")
    S2 = person(db, "ZZ9PK-S2", "ZZPK Sales")
    SA = person(db, "ZZ9PK-SA", "ZZPK Sales Admin")
    LV = person(db, "ZZ9PK-LV", "ZZPK Sales", left=True)
    T = person(db, "ZZ9PK-T1", "ZZPK Sales", title="ZZPK Clerk")
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    db.commit()
SUP = H.client_as(a, SU["id"])


def flashes(r):
    return " ".join(re.findall(r'class="flash[^"]*"[^>]*>(.*?)<', r.get_data(as_text=True), re.S))


def col(uid, c):
    return H.one(a, "SELECT %s FROM users WHERE id=?" % c, (uid,))


def admin_templates():
    out = []
    for root, _d, files in os.walk(TPL):
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), TPL)
            if f.endswith(".html") and (rel.startswith(("admin_", "person/", "settings/", "_")) and
                                        not rel.startswith(("_auth", "_journey", "_review", "_dash"))):
                out.append((rel, open(os.path.join(root, f), encoding="utf-8").read()))
    return out


try:
    s.section("no Employee ID typed into a box")
    T_ALL = admin_templates()
    s.check("the sweep reads the admin templates (%d)" % len(T_ALL), len(T_ALL) > 60, len(T_ALL))
    ID_NAMES = ("calibrator", "matrix_eid", "approver_employee_id", "lm_eid", "hod_eid", "manager_eid", "employee_id",
                "assessor_eid", "ids")
    typed = []
    for rel, src in T_ALL:
        for m in re.finditer(r"<(input|textarea)\b[^>]*\bname=\"(%s)\"[^>]*>" % "|".join(ID_NAMES), src):
            tag = m.group(0)
            if 'type="hidden"' in tag or 'type="checkbox"' in tag:   # a picker's value; a row's tick
                continue
            if rel == "admin_users.html" and m.group(2) == "employee_id":
                continue   # a NEW person's own Employee ID
            if rel == "_signin_help_fields.html" and m.group(2) == "employee_id":
                continue   # the sign-in page's help request: someone who can't sign in types their own
            typed.append("%s: %s" % (rel, tag[:70]))
    s.check("every person is searched and picked (only a new person's own Employee ID is typed)", not typed, typed[:5])
    s.check("no 'e.g. X0008' or 'Paste Employee IDs' box is left",
            not [r for r, src in T_ALL if "e.g. X0008" in src or "Paste Employee IDs" in src])
    for rel, name in (("_gc_panels.html", "calibrator"), ("_gc_panels.html", "ids"),   # the groups' panels (2026-10-22)
                      ("person/_kpi_panels.html", "matrix_eid"),
                      ("admin_performance_exceptions.html", "approver_employee_id")):
        src = open(os.path.join(TPL, rel), encoding="utf-8").read()
        s.check("%s: %s is a picker's hidden value" % (rel, name),
                re.search(r'<input type="hidden" class="pick-val" name="%s"' % name, src) is not None)
    s.check("...adding people to a group picks several at once",
            "data-pick-multi" in open(os.path.join(TPL, "_gc_panels.html"), encoding="utf-8").read())

    s.section("no list value typed free")
    free = []
    for rel, src in T_ALL:
        for m in re.finditer(r"<input\b[^>]*\bname=\"(department|job_title|category|departments|job_grades|segment|"
                             r"dept)\"[^>]*>", src):
            if 'type="hidden"' in m.group(0) or 'type="checkbox"' in m.group(0):
                continue
            free.append("%s: %s" % (rel, m.group(0)[:70]))
    s.check("department, job title, family, scope and batch name are lists everywhere in the admin", not free, free[:6])
    prof = open(os.path.join(TPL, "settings", "_tm_profiles.html"), encoding="utf-8").read()
    s.check("Add a profile offers no 'new' (a profile only matches the roster's own text)", "data-list-nonew" in prof)

    s.section("the picker is strict")
    js = open(os.path.join(H.REPO, "static", "admin.js"), encoding="utf-8").read()
    s.check("an unpicked name stops the form through the browser's own check (the message is set, not blanked)",
            "q.setCustomValidity(msg);" in js and "Choose a person from the list" in js
            and re.search(r"if \(typed && \(multi \|\| !val\.value\)\) msg =", js) is not None)
    s.check("...typed text never becomes the value any more", "val.value = q.value.trim()" not in js)
    s.check("several people pick as chips; 'A new …' shows its field; a list follows its unit",
            "data-pick-multi" in js and "pick-chip" in js and "data-new-input" in js and "data-list-for" in js)

    s.section("the server takes only what a list offers")
    r = SUP.post("/admin/users/%d/lines" % T, data={"csrf_token": "tok", "action": "details_apply", "company": CO,
                                                    "department": "ZZPK Typed Dept", "job_title": "ZZPK Clerk",
                                                    "job_grade": "14"}, follow_redirects=True)
    s.check("Edit details refuses a department no list offers, changing nothing",
            col(T, "department") == "ZZPK Sales" and "Pick a department from the list" in flashes(r), flashes(r)[:120])
    SUP.post("/admin/users/%d/lines" % T, data={"csrf_token": "tok", "action": "details_apply", "company": CO,
                                                "department": "zzpk sales admin", "job_title": "ZZPK Clerk",
                                                "job_grade": "14"})
    s.check("...takes one from the list in any case, saved as the list spells it",
            col(T, "department") == "ZZPK Sales Admin", col(T, "department"))
    SUP.post("/admin/users/%d/lines" % T, data={"csrf_token": "tok", "action": "details_apply", "company": CO,
                                                "department": "__new__", "department_new": "ZZPK  Brand New",
                                                "job_title": "ZZPK Clerk", "job_grade": "14"})
    s.check("...and a new one named through 'A new department…'", col(T, "department") == "ZZPK Brand New",
            col(T, "department"))
    SUP.post("/admin/users/%d/lines" % T, data={"csrf_token": "tok", "action": "details_apply", "company": CO,
                                                "department": "__new__", "department_new": "zzpk sales",
                                                "job_title": "ZZPK Clerk", "job_grade": "14"})
    s.check("...a 'new' one already on the list is the list's", col(T, "department") == "ZZPK Sales",
            col(T, "department"))
    r = SUP.post("/admin/users/%d/lines" % T, data={"csrf_token": "tok", "action": "details_apply", "company": CO,
                                                    "department": "ZZPK Sales", "job_title": "ZZPK Typed Title",
                                                    "job_grade": "14"}, follow_redirects=True)
    s.check("...and a job title no list offers", col(T, "job_title") == "ZZPK Clerk"
            and "Pick a job title from the list" in flashes(r), flashes(r)[:120])
    add = {"csrf_token": "tok", "action": "add_user", "business_group": BG, "company": CO, "manager_eid": "ZZ9PK-S1",
           "hod_eid": "ZZ9PK-S2", "job_grade": "12", "joined_date": "2026-10-01", "employment_type": "Permanent",
           "employee_id": "ZZ9PK-NW", "full_name": "ZZ PK New", "job_title": "ZZPK Officer"}
    r = SUP.post("/admin/users", data=dict(add, department="ZZPK Nowhere"), follow_redirects=True)
    s.check("Add a person refuses a department no list offers (nobody added)",
            H.one(a, "SELECT COUNT(*) FROM users WHERE employee_id='ZZ9PK-NW'") == 0
            and "Pick a department from the list" in flashes(r), flashes(r)[:120])
    SUP.post("/admin/users", data=dict(add, department="ZZPK Sales"))
    s.check("...and adds them with one from the unit's list",
            H.one(a, "SELECT department FROM users WHERE employee_id='ZZ9PK-NW'") == "ZZPK Sales")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET department=NULL WHERE id=?", (S2,))
        db.commit()
    r = SUP.post("/admin/data-integrity/fix", data={"csrf_token": "tok", "check": "no_department", "uid": str(S2),
                                                   "department": "ZZPK Typed"}, follow_redirects=True)
    s.check("Data integrity refuses a typed department", col(S2, "department") is None
            and "Pick a department from the list" in flashes(r), flashes(r)[:120])
    SUP.post("/admin/data-integrity/fix", data={"csrf_token": "tok", "check": "no_department", "uid": str(S2),
                                               "department": "ZZPK Sales"})
    s.check("...and sets one from the list", col(S2, "department") == "ZZPK Sales", col(S2, "department"))
    r = SUP.post("/admin/competency/profiles", data={"csrf_token": "tok", "action": "add_profile",
                                                     "department": "ZZPK Typed", "job_title": "ZZPK Officer",
                                                     "job_grade": "14", "proficiency_level": "3"},
                 follow_redirects=True)
    s.check("Add a profile refuses a department the roster doesn't hold (nothing added)",
            H.one(a, "SELECT COUNT(*) FROM tc_job_profiles WHERE department LIKE 'ZZPK %'") == 0
            and "Pick the department, job title and job grade from the lists" in flashes(r), flashes(r)[:120])
    SUP.post("/admin/competency/profiles", data={"csrf_token": "tok", "action": "add_profile",
                                                 "department": "zzpk sales", "job_title": "ZZPK Officer",
                                                 "job_grade": "14", "proficiency_level": "3"})
    s.check("...and adds one picked from it, in the roster's spelling",
            H.one(a, "SELECT department FROM tc_job_profiles WHERE department LIKE 'ZZPK %'") == "ZZPK Sales")
    with a.app.test_request_context("/"):
        cats = a.kpi_library_lists(a.get_db(), [BG])
        lst = a.kpi_library_lists(a.get_db(), [BG])["depts"].get(BG, [])
    s.check("the KPI library's lists: the group's departments with their units, its grades, the families",
            any(d == "ZZPK Sales" and CO in u for d, u in lst) and "14" in cats["grades"].get(BG, [])
            and isinstance(cats["cats"], list), lst[:3])
    lib = {"csrf_token": "tok", "action": "add", "business_group": BG, "company": "*", "department_mode": "include",
           "tier_n": "0", "kpi_name": "ZZPK Typed scope", "method": "more", "category": ""}
    r = SUP.post("/admin/performance/library", data=dict(lib, departments=["ZZPK Sales", "ZZPK Typed"]),
                 follow_redirects=True)
    s.check("the KPI library refuses a department its group doesn't hold (nothing added)",
            H.one(a, "SELECT COUNT(*) FROM pm_kpi_library WHERE kpi_name='ZZPK Typed scope'") == 0
            and "Pick departments from the list" in flashes(r), flashes(r)[:120])
    SUP.post("/admin/performance/library", data=dict(lib, departments=["ZZPK Sales", "ZZPK Sales Admin"],
                                                    job_grades=["14", "15"]))
    s.check("...and saves ticked departments and grades",
            H.rows(a, "SELECT departments, job_grades FROM pm_kpi_library WHERE kpi_name='ZZPK Typed scope'")
            and tuple(H.rows(a, "SELECT departments, job_grades FROM pm_kpi_library WHERE kpi_name='ZZPK Typed "
                                "scope'")[0]) == ("zzpk sales,zzpk sales admin", "14,15"))
    with a.app.test_request_context("/", method="POST", data={"category": "Nowhere · Typed"}):
        v, new, err = a._admin_list_choice(a.request.form, "category", ["Financial · Profitability"], None,
                                           "family · group", 120)
    s.check("a family no list offers is refused", err and v is None, err)
    with a.app.test_request_context("/", method="POST", data={"category": "__new__", "category_new": "  Ops ·  Flow "}):
        v, new, err = a._admin_list_choice(a.request.form, "category", ["Financial · Profitability"], None,
                                           "family · group", 120)
    s.check("...a new one is taken, its spaces tidied", v == "Ops · Flow" and new and not err, (v, new, err))
    with a.app.test_request_context("/", method="POST", data={"category": "__new__", "category_new": ""}):
        v, new, err = a._admin_list_choice(a.request.form, "category", [], None, "family · group", 120)
    s.check("...'A new …' with nothing typed is refused", err and v is None, err)

    s.section("calibration groups")
    r = SUP.post("/admin/performance/calibration-groups", data={"csrf_token": "tok", "action": "create",
                                                                "name": "ZZPK Leaver group", "calibrator": "ZZ9PK-LV"},
                 follow_redirects=True)
    s.check("a leaver can't be made a calibrator", H.one(a, "SELECT COUNT(*) FROM pm_calibration_groups WHERE "
                                                            "name='ZZPK Leaver group'") == 0)
    SUP.post("/admin/performance/calibration-groups", data={"csrf_token": "tok", "action": "create",
                                                            "name": "ZZPK Group A", "calibrator": "ZZ9PK-S1"})
    GID = H.one(a, "SELECT id FROM pm_calibration_groups WHERE name='ZZPK Group A'")
    s.check("a picked calibrator makes the group", GID is not None)
    SUP.post("/admin/performance/calibration-groups", data={"csrf_token": "tok", "action": "add_member",
                                                            "group_id": str(GID), "employee_id": "ZZ9PK-LV"})
    s.check("a leaver can't be added one at a time either",
            H.one(a, "SELECT COUNT(*) FROM pm_calibration_group_members WHERE group_id=? AND subject_id=?",
                  (GID, LV)) == 0)
    SUP.post("/admin/performance/calibration-groups", data={"csrf_token": "tok", "action": "paste_ids",
                                                            "group_id": str(GID), "ids": "ZZ9PK-T1,ZZ9PK-SA",
                                                            "segment": "__new__", "segment_new": "ZZPK Batch"})
    segs = H.rows(a, "SELECT u.employee_id, gm.segment FROM pm_calibration_group_members gm JOIN users u ON "
                     "u.id=gm.subject_id WHERE gm.group_id=? ORDER BY u.employee_id", (GID,))
    s.check("several picked people join at once, under a new name ('A new name…')",
            [tuple(x) for x in segs] == [("ZZ9PK-SA", "ZZPK Batch"), ("ZZ9PK-T1", "ZZPK Batch")], segs)
    with a.app.test_request_context("/"):
        d = a.get_db()
        exact = {p["id"] for p in a._group_people_matching(d, "zzpk sales", [BG], True)}
        loose = {p["id"] for p in a._group_people_matching(d, "zzpk sales", [BG])}
        opts = a.calib_dept_options(d)
    s.check("a department picked from the list matches exactly (Sales, not Sales Admin; no leaver)",
            SA not in exact and S1 in exact and LV not in exact, sorted(exact))
    s.check("...a rule saved before the list still matches the old way (contains)", SA in loose and S1 in loose)
    s.check("the department list: one name per department, counted per business group",
            any(dn == "ZZPK Sales" and by.get(BG) for dn, by in opts)
            and sum(1 for dn, _b in opts if dn.lower() == "zzpk sales") == 1)
    SUP.post("/admin/performance/calibration-groups", data={"csrf_token": "tok", "action": "add_matching",
                                                            "group_id": str(GID), "dept": "ZZPK Sales", "bg": BG,
                                                            "dept_exact": "1", "follow": "1", "segment": ""})
    with a.app.app_context():
        rules = a.calib_group_rules(GID)["rules"]
    s.check("adding a listed department follows it exactly (the rule says so)",
            any(r_["dept"] == "ZZPK Sales" and r_.get("exact") for r_ in rules), rules)
    pg = SUP.get("/admin/performance/calibration-groups?g=%d&dept=ZZPK+Sales&bg=%s&exact=1" % (GID, BG)) \
        .get_data(as_text=True)
    panel = pg[pg.find('id="group-%d"' % GID):]
    s.check("the panel: a department list with its counts per group, the exact preview",
            'data-dept-pick' in panel and 'name="dept_exact" value="1"' in panel and "data-by=" in panel)
    s.check("...'Show them as' offers the group's names, a new one, or their own department",
            'value="ZZPK Batch"' in panel and 'value="__new__"' in panel and "Their own department" in panel)
    s.check("...people are searched and picked, the calibrator too",
            'data-pick-multi' in panel and re.search(r'class="pick-val" name="calibrator"', pg) is not None)

    s.section("the pages carry their lists")
    pg = SUP.get("/admin/users?view=add").get_data(as_text=True)
    m = re.search(r'<script type="application/json" id="add-dept-map">(.*?)</script>', pg, re.S)
    dm = json.loads(m.group(1)) if m else {}
    s.check("Add a person: the department list by unit, and the grades", any(d[0] == "ZZPK Sales" for d in dm.get(CO, []))
            and re.search(r'<select name="job_grade" id="add-grade"', pg) is not None, list(dm)[:3])
    pg = SUP.get("/admin/users/%d" % T).get_data(as_text=True)
    s.check("Edit details: the department and job title lists follow the unit",
            'id="pp-det-tmap"' in pg and 'data-list-for="#pp-det-unit"' in pg)
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
