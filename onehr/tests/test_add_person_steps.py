"""Add a person in four steps (Chris, 2026-10-18: "instead of add the person button, it should ask whether the admin
wants to go next directly to set KPIs then assign competencies, in the right panel"; the libraries canvas,
[design canvas link removed], boards 15-18).

What this suite holds:
  * step 1 (details) is grouped as the canvas has it and offers "Add, and stop here" or "Add, then set their KPIs";
    the second goes on to their KPIs in the same panel
  * step 2 (KPIs): someone not taking part is offered the cycle (added on Participants, logged) or not; lines come from
    their own library only (business unit KPIs never offered), each with its description (the library's definition
    is not copied onto the line), its scale and weight; all or nothing: a broken scale, a KPI twice, one outside their
    library, or weights not coming to 100% saves nothing; saved lines are moderated by the line manager, logged
  * step 3 (job): placing a job, or assigning their Mapper job's set, through the Competency page's own writers
  * step 4 (done): what's in place, from the data
  * an admin outside their group can't open or post any step; every step's form asks first
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Add a person in four steps: details, KPIs, job and competencies, done")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, BG2 = "ZZAP Group", "ZZAP Unit", "ZZAP Other"
L = {}


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9AP-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM tc_assignments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM ja_people WHERE employee_id LIKE 'ZZ9AP-%'")
    db.execute("DELETE FROM ja_taxonomy WHERE code LIKE 'ZQP%'")
    db.execute("DELETE FROM tc_job_profiles WHERE job_code LIKE 'ZQP-%'")
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZAP-%'")
    db.execute("DELETE FROM pm_kpi_library WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG2))
    db.commit()


def uid_of(eid):
    r = H.rows(a, "SELECT id FROM users WHERE employee_id=?", (eid,))
    return r[0][0] if r else None


def lines_of(uid):
    return H.rows(a, "SELECT kpi_name, weightage, description, library_id, rate1, rate5 FROM pm_kpi_targets "
                     "WHERE cycle_id=? AND subject_id=? ORDER BY id", (CID, uid))


try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        CID = a.active_cycle_id(db)
        KEEP_MG = db.execute("SELECT min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone()[0]
        db.execute("UPDATE cycles SET min_job_grade=NULL WHERE id=?", (CID,))
        LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?)", (BG, CO, BG2, "ZZAP Unit 2"))
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
        for nm, cat, meth, rates, w, bu in (("ZZAP Output", "Operations", "more", (70, 80, 90, 100, 110), 60, 0),
                                            ("ZZAP Rejects", "Quality", "less", (5, 4, 3, 2, 1), 40, 0),
                                            ("ZZAP Unit PAT", "Financial", "more", (1, 2, 3, 4, 5), 20, 1)):
            L[nm] = db.execute(
                "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
                "description, unit, method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level) "
                "VALUES (?, '*', '*', 0, '*', ?, ?, 'the library definition', '%', ?, ?,?,?,?,?, ?, ?)",
                (BG, nm, cat, meth) + rates + (w, bu)).lastrowid
        L["other"] = db.execute(
            "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, method, "
            "rate1, rate2, rate3, rate4, rate5) VALUES (?, '*', '*', 0, '*', 'ZZAP Elsewhere', 'more', 1,2,3,4,5)",
            (BG2,)).lastrowid
        SK = {}
        for t in ("S1", "S2", "S3", "S4", "S5"):
            for lv in (3, 4):
                SK[(t, lv)] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, active) "
                                         "VALUES (?,?,?, 'tsc', 1)", ("ZZAP-%s-%d" % (t, lv), "ZZAP Skill " + t,
                                                                      lv)).lastrowid
        PROF = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, plan_mode, source, "
                          "active) VALUES ('ZZAP Zqvplant', 'Executive, Zqvplant Zqvops', '12', 'ZQP-OPS-01-12', "
                          "'explicit', 'architecture', 1)").lastrowid
        for i, t in enumerate(("S1", "S2", "S3", "S4", "S5")):
            for fut, lv in ((0, 3), (1, 4)):
                db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, "
                           "is_future) VALUES (?,?,?,?,?)", (PROF, SK[(t, lv)], lv, i, fut))
        for code, lvl, parent, name in (("ZQP", "family", None, "ZQP"), ("ZQP-OPS", "sub", "ZQP", "ZQP Ops"),
                                        ("ZQP-OPS-01", "spec", "ZQP-OPS", "ZQP Plant")):
            db.execute("INSERT INTO ja_taxonomy(code, level, parent_code, name) VALUES (?,?,?,?)",
                       (code, lvl, parent, name))
        for eid in ("ZZ9AP-M", "ZZ9AP-H"):
            db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                       "company, department, job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?, "
                       "'ZZAP Zqvplant', '18', '2020-01-01')", (eid.lower(), "ZZ AP " + eid[-1], eid, BG, CO))
        OTHER_ADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, "
                               "business_group, admin_bg) VALUES ('zz9ap-adm', 'ZZ AP Admin', 'x', 'admin', "
                               "'ZZ9AP-ADM', ?, ?)", (BG2, BG2)).lastrowid
        db.commit()
    SUP = H.client_as(a, SU["id"])
    add = {"csrf_token": "tok", "action": "add_user", "business_group": BG, "company": CO, "manager_eid": "ZZ9AP-M",
           "hod_eid": "ZZ9AP-H", "job_grade": "12", "joined_date": "2026-10-01", "employment_type": "Permanent",
           "job_title": "__new__", "job_title_new": "Zqvplant Zqvops Executive",
           "department": "__new__", "department_new": "ZZAP Zqvplant"}   # picked from the lists or named as new (2026-10-19)

    s.section("step 1: details")
    pg = SUP.get("/admin/users?view=add").get_data(as_text=True)
    s.check("grouped as the canvas has it", all(k in pg for k in ('aria-label="Who they are"', 'aria-label="Where they sit"',
                                                                  'aria-label="Their dates"',
                                                                  'aria-label="Who they report to"')))
    s.check("two ways on: stop here, or go on to their KPIs", 'name="then" value="stop"' in pg
            and 'name="then" value="kpis"' in pg and "Add, then set their KPIs" in pg)
    s.check("the panel is the wide one, with the take-part note and the steps", 'id="pnl-add"' in pg
            and "adm-panel is-wide" in pg.split('id="pnl-add"')[0][-200:] and 'id="add-take"' in pg
            and 'class="adm-steps"' in pg)
    r = SUP.post("/admin/users", data=dict(add, employee_id="ZZ9AP-A", full_name="ZZ AP Alpha", confirmation_date="",
                                           then="kpis"))
    A = uid_of("ZZ9AP-A")
    s.check("'Add, then set their KPIs' goes on to their KPIs, in the panel", A and r.status_code == 302
            and "step=kpis" in r.headers["Location"] and ("uid=%d" % A) in r.headers["Location"]
            and "view=add" in r.headers["Location"], r.headers.get("Location"))
    r = SUP.post("/admin/users", data=dict(add, employee_id="ZZ9AP-B", full_name="ZZ AP Bravo",
                                           confirmation_date="2020-01-01", then="stop"))
    B = uid_of("ZZ9AP-B")
    s.check("'Add, and stop here' goes back to the list", B and "step=" not in r.headers["Location"])

    s.section("step 2: their KPIs")
    pg = SUP.get("/admin/users?view=add&step=kpis&uid=%d" % A).get_data(as_text=True)
    s.check("the panel is headed by them, step 2 of 4", "ZZ AP Alpha" in pg and 'aria-current="step"' in pg
            and pg.count("adm-step-n") >= 4)
    s.check("not taking part: offered the cycle or not", 'name="cycle" value="add"' in pg
            and 'name="cycle" value="skip"' in pg)
    lib_json = pg.split('id="wiz-lib">')[1].split("</script>")[0]
    s.check("their library is offered, never a business unit KPI or another group's", "ZZAP Output" in lib_json
            and "ZZAP Rejects" in lib_json and "ZZAP Unit PAT" not in lib_json and "ZZAP Elsewhere" not in lib_json)
    s.check("the form asks first; Skip asks too", 'id="wiz-kpis"' in pg and 'data-confirm="Save these KPI lines' in pg
            and 'value="skip" class="wiz-btn" id="wiz-skip" formnovalidate' in pg)
    js = open(os.path.join(H.REPO, "static", "kpi_scale.js"), encoding="utf-8").read()
    s.check("each line carries the scale check, which scopes to the line and never holds a Skip",
            'class="wiz-line" data-kpi-scale="A"' in pg and "closest('[data-kpi-scale]')" in js
            and "hasAttribute('formnovalidate')" in js)
    gp = SUP.get("/admin/people/add/%d?step=kpis" % A)
    s.check("a GET of the step route goes to the panel on People", gp.status_code == 302
            and "/admin/users" in gp.headers["Location"] and "step=kpis" in gp.headers["Location"])

    def line(lid, w, r1=70, r5=110, desc="their own words", meth="more", mid=(80, 90, 100)):
        return {"lib_id": lid, "weightage": w, "description": desc, "method": meth, "rate 1": r1, "rate 2": mid[0],
                "rate 3": mid[1], "rate 4": mid[2], "rate 5": r5}

    def post_lines(uid, lns, **extra):
        form = {"csrf_token": "tok", "action": "kpis", "then": "save"}
        form.update(extra)
        keys = ("lib_id", "weightage", "description", "method", "rate 1", "rate 2", "rate 3", "rate 4", "rate 5")
        for k in keys:
            form[k] = [str(ln[k]) for ln in lns]
        return SUP.post("/admin/people/add/%d" % uid, data=form, follow_redirects=True)

    out = post_lines(A, [line(L["ZZAP Output"], 100)])
    s.check("not taking part and not added: no lines, told why", lines_of(A) == []
            and "so there are no KPI lines to set" in out.get_data(as_text=True))
    r = SUP.post("/admin/people/add/%d" % A, data={"csrf_token": "tok", "action": "kpis", "then": "skip",
                                                    "cycle": "add"})
    s.check("'Add them to the cycle' then Skip: on Participants, and on to their job", H.one(
        a, "SELECT mode FROM cycle_participants WHERE cycle_id=? AND subject_id=?", (CID, A)) == "add"
        and "step=job" in r.headers["Location"])
    s.check("...logged", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='participant' AND "
                                  "target_user_id=?", (LOG0, A)) == 1)
    out = post_lines(A, [line(L["ZZAP Output"], 60), line(L["ZZAP Rejects"], 30, 5, 1, meth="less", mid=(4, 3, 2))])
    s.check("weights coming to 90%: nothing saved, told why", lines_of(A) == []
            and "come to 90%" in out.get_data(as_text=True))
    post_lines(A, [line(L["ZZAP Output"], 60, mid=(80, 80, 100)),
                   line(L["ZZAP Rejects"], 40, 5, 1, meth="less", mid=(4, 3, 2))])
    s.check("one line's ratings broken (two the same): nothing saved", lines_of(A) == [])
    try:
        out, crashed = post_lines(A, [line(L["ZZAP Output"], 50), line(L["ZZAP Output"], 50)]), None
    except Exception as ex:   # noqa: BLE001 -- without the check, the table's UNIQUE would answer with a 500
        out, crashed = None, ex
    s.check("the same KPI twice: nothing saved, told why", crashed is None and lines_of(A) == []
            and "on the list twice" in out.get_data(as_text=True), crashed)
    post_lines(A, [line(L["ZZAP Output"], 60), line(L["other"], 40)])
    s.check("a KPI outside their library: nothing saved", lines_of(A) == [])
    post_lines(A, [line(L["ZZAP Output"], 60), line(L["ZZAP Unit PAT"], 40, 1, 5, mid=(2, 3, 4))])
    s.check("...nor a business unit KPI (it comes from BU KPI setup)", lines_of(A) == [])
    out = post_lines(A, [line(L["ZZAP Output"], 60, desc="Pieces off line 2"),
                         line(L["ZZAP Rejects"], 40, 5, 1, desc="", meth="less", mid=(4, 3, 2))])
    got = lines_of(A)
    s.check("two lines, weights 100%: saved, from the library", [(g[0], g[1], g[3]) for g in got] == [
        ("ZZAP Output", 60, L["ZZAP Output"]), ("ZZAP Rejects", 40, L["ZZAP Rejects"])], [tuple(g) for g in got])
    s.check("...with the admin's description; the library's definition isn't copied", got[0][2] == "Pieces off line 2"
            and not got[1][2], [g[2] for g in got])
    s.check("...each moderated by their line manager", H.one(
        a, "SELECT COUNT(*) FROM pm_kpi_target_approvers ap JOIN pm_kpi_targets t ON t.id=ap.kpi_target_id "
           "WHERE t.subject_id=? AND ap.approver_id=?", (A, uid_of("ZZ9AP-M"))) == 2)
    s.check("...logged as Add a person's", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND "
                                                    "action='pm_kpi_add' AND target_user_id=? AND detail LIKE "
                                                    "'%(Add a person)%'", (LOG0, A)) == 2)
    s.check("...and on to their job", "Now their job" in out.get_data(as_text=True))
    pg = SUP.get("/admin/users?view=add&step=kpis&uid=%d" % A).get_data(as_text=True)
    s.check("back on the step, the saved lines show as on their scorecard", pg.count("on their scorecard already") == 2
            and 'data-have="100' in pg)

    s.section("step 3: their job")
    pg = SUP.get("/admin/users?view=add&step=job&uid=%d" % A).get_data(as_text=True)
    s.check("not in the Mapper: the best fit is offered, with what it gives", 'name="profile_id" value="%d"' % PROF in pg
            and "Best fit" in pg and "ZZAP Skill S1" in pg)
    s.check("the form asks first", 'id="wiz-job"' in pg and 'data-confirm="Place ZZ AP Alpha' in pg)
    r = SUP.post("/admin/people/add/%d" % A, data={"csrf_token": "tok", "action": "job", "then": "place",
                                                    "profile_id": PROF}, follow_redirects=True)
    s.check("placed, and (taking part) given its 10", H.one(a, "SELECT source FROM ja_people WHERE employee_id="
                                                              "'ZZ9AP-A'") == "admin" and H.one(
        a, "SELECT COUNT(*) FROM tc_assignments WHERE cycle_id=? AND subject_id=?", (CID, A)) == 10)
    s.check("...and on to what's in place", "is set up" in r.get_data(as_text=True))
    with a.app.app_context():   # B is in P&R's Mapper on the same job, and takes part
        a.get_db().execute("INSERT INTO ja_people(employee_id, family_code, sub_code, spec_code, title, source, version) "
                           "VALUES ('ZZ9AP-B', 'ZQP', 'ZQP-OPS', 'ZQP-OPS-01', 'Executive', 'mapper:role', 't')")
        a.get_db().commit()
    pg = SUP.get("/admin/users?view=add&step=job&uid=%d" % B).get_data(as_text=True)
    s.check("in the Mapper: their job is shown, with Assign", "From P&amp;R&#39;s Mapper" in pg or "From P&R's Mapper" in pg)
    s.check("...Assign asks first", 'name="then" value="assign"' in pg and 'data-confirm="Give ZZ AP Bravo' in pg)
    SUP.post("/admin/people/add/%d" % B, data={"csrf_token": "tok", "action": "job", "then": "assign"})
    s.check("...and gives their job's set", H.one(a, "SELECT COUNT(*) FROM tc_assignments WHERE cycle_id=? AND "
                                                     "subject_id=?", (CID, B)) == 10)

    s.section("step 4: what's in place")
    pg = SUP.get("/admin/users?view=add&step=done&uid=%d" % A).get_data(as_text=True)
    s.check("headed 'is set up', the account and leaders", "ZZ AP Alpha is set up" in pg and "Their account" in pg
            and "ZZ AP M" in pg and "ZZ AP H" in pg)
    s.check("taking part (added on Participants)", "Taking part in" in pg and "Added on Participants" in pg)
    s.check("2 KPI lines, weights 100%, the job and 10 competencies", "2 KPI lines, weights 100%" in pg
            and "Their job and 10 competencies" in pg and "ZQP-OPS-01-12" in pg)
    s.check("the 360 panel still to build", "Added the next time panels are built" in pg)

    s.section("scope")
    OA = H.client_as(a, OTHER_ADM)
    s.check("another group's admin can't open a step", OA.get("/admin/users?view=add&step=kpis&uid=%d" % A)
            .status_code == 403)
    n0 = len(lines_of(B))
    r = OA.post("/admin/people/add/%d" % B, data={"csrf_token": "tok", "action": "kpis", "then": "save",
                                                   "lib_id": [str(L["ZZAP Output"])], "weightage": ["100"],
                                                   "description": [""], "method": ["more"], "rate 1": ["70"],
                                                   "rate 2": ["80"], "rate 3": ["90"], "rate 4": ["100"],
                                                   "rate 5": ["110"]})
    s.check("...or post one", r.status_code == 403 and len(lines_of(B)) == n0)
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        try:
            _db.execute("UPDATE cycles SET min_job_grade=? WHERE id=?", (KEEP_MG, CID))
        except NameError:
            pass
        _cleanup(_db)

sys.exit(s.done())
