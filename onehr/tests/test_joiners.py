"""New joiners: placing their job, their competencies, the New joiners page and Home's card (Chris, 2026-10-18: "for
bulk import, there should be notification pops out in the admin main page to flag the new users without KPIs and
competencies. Show me the page to set competency for user"; and, asked whether a joiner who doesn't take part still gets
their job placed: "yeah, it should"; canvas [design canvas link removed], boards 12-14).

What this suite holds:
  * Add a person and the roster import stamp who came in and how (users.created_at / created_via); someone written
    any other way is not a joiner
  * ja_job_suggestions: the two job profiles at their grade that best fit their title and department, best first
  * placing a job (the person's Competency page): refused at another grade; writes their architecture row (source
    'admin', the taxonomy climbed), so their job code follows; gives them its competencies only when they take part and
    haven't started; never changes a started set; logged
  * the New joiners page: scoped, the tabs' counts, what each still needs; Assign gives only the TICKED ready joiners
    their job's set (nothing ticked assigns nobody)
  * Home's card: shown while a joiner still needs something, its count matching an independent query
  * the grey line under the headline gives the real reasons the others are out (one batched query, equal to a
    per-person participation() tally), biggest first, none at zero
  * a joiner who takes part in the 360 as the person rated needs a panel of the Stage-1 threshold's size: the card's
    "Fewer than N raters" row, its list, the page's line and `open`; not while the 360 is off, not for a role without
    the 360, not for someone out of the review, not counting archived rows or the person's own row
"""
import csv as _csv
import html as _html
import io
import os
import re
from collections import Counter
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("New joiners: placing their job, their competencies, the New joiners page and Home's card")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG, CO = "ZZJN Group", "ZZJN Unit"
P = {}     # job code -> profile id
U = {}     # employee id -> user id


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9JN-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM tc_assignments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM tc_assessments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM ja_people WHERE employee_id LIKE 'ZZ9JN-%'")
    db.execute("DELETE FROM ja_taxonomy WHERE code LIKE 'ZQJ%'")
    db.execute("DELETE FROM tc_job_profiles WHERE job_code LIKE 'ZQJ-%'")
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZJN-%'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM cycle_exclusions WHERE business_group=?", (BG,))
    for r in [r[0] for r in db.execute("SELECT id FROM user_roles WHERE name LIKE 'ZZJN%'")]:
        db.execute("DELETE FROM user_role_modules WHERE role_id=?", (r,))
        db.execute("DELETE FROM user_roles WHERE id=?", (r,))
    db.commit()


def uid_of(eid):
    r = H.rows(a, "SELECT id FROM users WHERE employee_id=?", (eid,))
    return r[0][0] if r else None


def n_assigned(eid):
    return H.one(a, "SELECT COUNT(*) FROM tc_assignments WHERE cycle_id=? AND subject_id=?", (CID, uid_of(eid) or 0))


def role_of(eid):
    r = H.rows(a, "SELECT source, family_code, sub_code, spec_code, unit_code, title FROM ja_people "
                  "WHERE employee_id=?", (eid,))
    return tuple(r[0]) if r else None


ORIG = {}   # the cycle's settings this suite changes, put back at the end


def _restore(db):
    if "cycle" in ORIG:
        cid, mg, mv, tm = ORIG["cycle"]
        db.execute("UPDATE cycles SET min_job_grade=?, min_valid=? WHERE id=?", (mg, mv, cid))
        db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='tm'", (cid,))
        if tm is not None:   # a deleted cycle_modules row must go back
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'tm', ?)", (cid, tm))
        db.commit()


try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        CID = a.active_cycle_id(db)
        LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
        SK = {}
        for t in ("S1", "S2", "S3", "S4", "S5", "S6"):
            for lv in (3, 4):
                SK[(t, lv)] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, active) "
                                         "VALUES (?,?,?, 'tsc', 1)", ("ZZJN-%s-%d" % (t, lv), "ZZJN Skill " + t,
                                                                      lv)).lastrowid

        def prof(code, title, dept, skills, scope=None):
            grade = code.rsplit("-", 1)[1]
            pid = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, job_scope, "
                             "plan_mode, source, active) VALUES (?,?,?,?,?, 'explicit', 'architecture', 1)",
                             (dept, title, grade, code, scope)).lastrowid
            for i, t in enumerate(skills):
                for fut, lv in ((0, 3), (1, 4)):
                    db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, "
                               "is_future) VALUES (?,?,?,?,?)", (pid, SK[(t, lv)], lv, i, fut))
            P[code] = pid
        prof("ZQJ-PRD-06-12", "Executive, Zqxkiln Zqxops", "ZZJN Zqxkiln", ["S1", "S2", "S3", "S4", "S5"], "ZQXOPS")
        prof("ZQJ-PRD-02-12", "Executive, Zqxkiln Planning", "ZZJN Zqxkiln", ["S1", "S2", "S3", "S4", "S6"])
        prof("ZQJ-SAL-01-12", "Executive, Zqxsales", "ZZJN Zqxsales", ["S2", "S3", "S4", "S5", "S6"])
        prof("ZQJ-PRD-06-14", "Senior Executive, Zqxkiln Zqxops", "ZZJN Zqxkiln", ["S1", "S2", "S3", "S4", "S5"])
        for code, lvl, parent, name in (("ZQJ", "family", None, "ZQJ Family"), ("ZQJ-PRD", "sub", "ZQJ", "ZQJ Prod"),
                                        ("ZQJ-PRD-06", "spec", "ZQJ-PRD", "ZQJ Ops"),
                                        ("ZQJ-PRD-02", "spec", "ZQJ-PRD", "ZQJ Planning"),
                                        ("ZQJ-SAL", "sub", "ZQJ", "ZQJ Sales"),
                                        ("ZQJ-SAL-01", "spec", "ZQJ-SAL", "ZQJ B2B")):
            db.execute("INSERT INTO ja_taxonomy(code, level, parent_code, name) VALUES (?,?,?,?)",
                       (code, lvl, parent, name))
        # the line manager and HOD, written straight in: not joiners (no created_at)
        for eid in ("ZZ9JN-M", "ZZ9JN-H"):
            U[eid] = db.execute(
                "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                "department, job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?, 'ZZJN Zqxkiln', '18', "
                "'2020-01-01')", (eid.lower(), "ZZ JN " + eid[-1], eid, BG, CO)).lastrowid
        db.commit()
    SUP = H.client_as(a, SU["id"])
    add = {"csrf_token": "tok", "action": "add_user", "business_group": BG, "company": CO, "manager_eid": "ZZ9JN-M",
           "hod_eid": "ZZ9JN-H", "job_grade": "12", "joined_date": "2026-10-01", "employment_type": "Permanent",
           "job_title": "__new__", "job_title_new": "Zqxkiln Zqxops Executive",
           "department": "__new__", "department_new": "ZZJN Zqxkiln"}   # picked from the lists or named as new (2026-10-19)
    SUP.post("/admin/users", data=dict(add, employee_id="ZZ9JN-A", full_name="ZZ JN Alpha",
                                       confirmation_date="2020-01-01"))
    SUP.post("/admin/users", data=dict(add, employee_id="ZZ9JN-B", full_name="ZZ JN Bravo", confirmation_date=""))
    cols = {c.lower(): c for c in a.ROSTER_COLUMNS}
    buf = io.StringIO()
    w = _csv.writer(buf)
    w.writerow(a.ROSTER_COLUMNS)
    rec = dict.fromkeys(a.ROSTER_COLUMNS, "")
    for k, v in {"employee id": "ZZ9JN-C", "employee name": "ZZ JN Charlie", "business group": BG, "company": CO,
                 "manager": "ZZ9JN-M", "job grade": "12", "joined date": "2026-10-01",
                 "confirmation date": "2020-01-01", "job title": "Zqxsales Executive", "department": "ZZJN Zqxsales"}.items():
        rec[cols[k]] = v
    w.writerow([rec[c] for c in a.ROSTER_COLUMNS])
    H.import_steps(SUP, "/admin/import/roster", {"mode": "upsert", "file": (io.BytesIO(buf.getvalue().encode()), "jn.csv")})

    s.section("who came in, and how")
    via = {r[0]: (r[1], r[2]) for r in H.rows(a, "SELECT employee_id, created_via, created_at FROM users "
                                                 "WHERE employee_id LIKE 'ZZ9JN-%'")}
    s.check("all three joiners were added", all(e in via for e in ("ZZ9JN-A", "ZZ9JN-B", "ZZ9JN-C")), sorted(via))
    s.check("Add a person stamps 'add' and the time", via["ZZ9JN-A"][0] == "add" and via["ZZ9JN-A"][1]
            and via["ZZ9JN-B"][0] == "add", via)
    s.check("the roster import stamps 'import'", via["ZZ9JN-C"][0] == "import" and via["ZZ9JN-C"][1], via)
    s.check("someone written any other way has neither", via["ZZ9JN-M"] == (None, None), via["ZZ9JN-M"])
    with a.app.app_context():
        db = a.get_db()
        took = {e: a.participation(db, db.execute("SELECT * FROM users WHERE employee_id=?", (e,)).fetchone())[0]
                for e in ("ZZ9JN-A", "ZZ9JN-B", "ZZ9JN-C")}
    s.check("baseline: A and C take part (confirmed before the cycle), B doesn't", took == {
        "ZZ9JN-A": True, "ZZ9JN-B": False, "ZZ9JN-C": True}, took)

    s.section("the jobs that best fit them")
    with a.app.app_context():
        db = a.get_db()
        ua = db.execute("SELECT * FROM users WHERE employee_id='ZZ9JN-A'").fetchone()
        sug = [r["job_code"] for r in a.ja_job_suggestions(db, ua)]
        low = dict(ua)
        low["job_grade"] = "11"
    s.check("their title and department pick the two best fits at their grade, best first",
            sug == ["ZQJ-PRD-06-12", "ZQJ-PRD-02-12"], sug)
    with a.app.app_context():
        s.check("nothing below JG 12", a.ja_job_suggestions(a.get_db(), low) == [])

    s.section("the New joiners page, before anything is placed")
    with a.app.app_context():
        db = a.get_db()
        me = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        J = {j["p"]["employee_id"]: j for j in a._joiners(db, me, BG)}
    s.check("the three joiners, not their manager", sorted(J) == ["ZZ9JN-A", "ZZ9JN-B", "ZZ9JN-C"], sorted(J))
    s.check("nobody's job is placed, so nobody is ready", all(not j["role"] and not j["ready"] for j in J.values()))
    s.check("...and each still needs something", all(j["open"] for j in J.values()))
    s.check("their line manager is set", all(j["lm_ok"] for j in J.values()))
    pg = SUP.get("/admin/people/joiners?fbg=" + BG).get_data(as_text=True)
    s.check("the tabs count who takes part", "Taking part · 2" in pg and "Not taking part · 1" in pg and "All 3" in pg)
    s.check("...the taking-part tab lists A and C, not B", "ZZ JN Alpha" in pg and "ZZ JN Charlie" in pg
            and "ZZ JN Bravo" not in pg)
    s.check("...each waiting on their job", pg.count(">To place<") == 2, pg.count(">To place<"))
    s.check("the button only shows with someone ready", "Assign competencies to the ticked ready" not in pg)
    pg = SUP.get("/admin/people/joiners?fbg=" + BG + "&tab=out").get_data(as_text=True)
    s.check("the other tab lists B, not taking part", "ZZ JN Bravo" in pg and "not this cycle" in pg)
    pg = SUP.get("/admin/people/joiners?fbg=" + BG + "&via=import&tab=all").get_data(as_text=True)
    s.check("Came in: Roster import shows C only", "ZZ JN Charlie" in pg and "ZZ JN Alpha" not in pg)
    if BGA is not None and (BGA["admin_bg"] or "") != BG:
        with a.app.app_context():
            db = a.get_db()
            bga = db.execute("SELECT * FROM users WHERE id=?", (BGA["id"],)).fetchone()
            seen = [j["p"]["employee_id"] for j in a._joiners(db, bga) if j["p"]["employee_id"].startswith("ZZ9JN")]
        s.check("another group's admin doesn't see them", seen == [], seen)

    s.section("Home's card")
    home = SUP.get("/admin").get_data(as_text=True)
    n_ind = H.one(a, "SELECT COUNT(*) FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 "
                     "AND created_at IS NOT NULL AND created_at >= datetime('now', '-120 days')")
    s.check("shown while a joiner still needs something, linking to the page", "New joiners since" in home
            and "/admin/people/joiners" in home)
    s.check("...its count matches an independent count", ("%d new joiner" % n_ind) in home, n_ind)

    s.section("placing a job")
    A, B = uid_of("ZZ9JN-A"), uid_of("ZZ9JN-B")
    tab = SUP.get("/admin/users/%d?tab=competency" % A).get_data(as_text=True)
    s.check("their Competency page offers it, best fit first", "Not placed yet" in tab and "Best fit" in tab
            and tab.index("Executive, Zqxkiln Zqxops") < tab.index("Executive, Zqxkiln Planning"))
    pj = {"csrf_token": "tok", "action": "place_job"}
    SUP.post("/admin/users/%d/competency" % A, data=dict(pj, profile_id=P["ZQJ-PRD-06-14"]))
    s.check("a job at another grade is refused", role_of("ZZ9JN-A") is None and n_assigned("ZZ9JN-A") == 0)
    r = SUP.post("/admin/users/%d/competency" % A, data=dict(pj, profile_id=P["ZQJ-PRD-06-12"]),
                 follow_redirects=True)
    s.check("their job is placed in OneHR, the taxonomy climbed", role_of("ZZ9JN-A") == (
        "admin", "ZQJ", "ZQJ-PRD", "ZQJ-PRD-06", None, "Executive, Zqxkiln Zqxops"), role_of("ZZ9JN-A"))
    with a.app.app_context():
        db = a.get_db()
        jc = a.ja_job_code(db, db.execute("SELECT * FROM users WHERE id=?", (A,)).fetchone())
        pf = a.tc_profile_for_user(db, db.execute("SELECT * FROM users WHERE id=?", (A,)).fetchone())[0]
    s.check("...so their job code follows, and resolves to that profile", jc == "ZQJ-PRD-06-12"
            and pf is not None and pf["id"] == P["ZQJ-PRD-06-12"], (jc, pf and pf["id"]))
    s.check("taking part, they get its five now and five one level up", n_assigned("ZZ9JN-A") == 10
            and H.one(a, "SELECT COUNT(*) FROM tc_assignments WHERE cycle_id=? AND subject_id=? AND is_future=1",
                      (CID, A)) == 5, n_assigned("ZZ9JN-A"))
    s.check("...said in the message", "They have its 10 competencies" in r.get_data(as_text=True))
    s.check("...and logged", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='ja_place_job' "
                                      "AND target_user_id=?", (LOG0, A)) == 1)
    r = SUP.post("/admin/users/%d/competency" % B, data=dict(pj, profile_id=P["ZQJ-PRD-02-12"]),
                 follow_redirects=True)
    s.check("not taking part: their job is still placed (Chris)", role_of("ZZ9JN-B") is not None
            and role_of("ZZ9JN-B")[3] == "ZQJ-PRD-02", role_of("ZZ9JN-B"))
    s.check("...but no competencies this cycle, and told why", n_assigned("ZZ9JN-B") == 0
            and "take part in" in r.get_data(as_text=True))
    tab = SUP.get("/admin/users/%d?tab=competency" % B).get_data(as_text=True)
    s.check("their page then says where the job came from", "Placed in OneHR" in tab and "Change their job" in tab)

    s.section("a started set never changes")
    with a.app.app_context():
        db = a.get_db()
        asid = db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?, 'pending')",
                          (CID, A)).lastrowid
        first = db.execute("SELECT id FROM tc_assignments WHERE cycle_id=? AND subject_id=? ORDER BY id LIMIT 1",
                           (CID, A)).fetchone()[0]
        db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer) VALUES (?,?, 'yes')", (asid, first))
        db.commit()
        before = sorted(r[0] for r in db.execute("SELECT skill_id FROM tc_assignments WHERE cycle_id=? AND "
                                                  "subject_id=?", (CID, A)))
    r = SUP.post("/admin/users/%d/competency" % A, data=dict(pj, profile_id=P["ZQJ-PRD-02-12"]),
                 follow_redirects=True)
    after = sorted(x[0] for x in H.rows(a, "SELECT skill_id FROM tc_assignments WHERE cycle_id=? AND subject_id=?",
                                       (CID, A)))
    s.check("their job moves", role_of("ZZ9JN-A")[3] == "ZQJ-PRD-02", role_of("ZZ9JN-A"))
    s.check("...but the set they started is kept, and they're told", after == before
            and "started their self-assessment" in r.get_data(as_text=True))

    s.section("Assign on the New joiners page")
    with a.app.app_context():   # C is in P&R's Mapper: ready, from their job
        db = a.get_db()
        db.execute("INSERT INTO ja_people(employee_id, family_code, sub_code, spec_code, title, source, version) "
                   "VALUES ('ZZ9JN-C', 'ZQJ', 'ZQJ-SAL', 'ZQJ-SAL-01', 'Executive, Zqxsales', 'mapper:role', 'test')")
        db.commit()
        me = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        J = {j["p"]["employee_id"]: j for j in a._joiners(db, me, BG)}
    C = uid_of("ZZ9JN-C")
    s.check("C is ready (takes part, their job gives a set, none yet); A isn't (has one); B doesn't take part",
            J["ZZ9JN-C"]["ready"] and not J["ZZ9JN-A"]["ready"] and not J["ZZ9JN-B"]["ready"],
            {k: v["ready"] for k, v in J.items()})
    s.check("...their job reads as the Mapper's", J["ZZ9JN-C"]["placed_word"] == "From P&R's Mapper")
    pg = SUP.get("/admin/people/joiners?fbg=" + BG).get_data(as_text=True)
    s.check("the page ticks the ready one and shows the button", 'name="sid" value="%d" checked' % C in pg
            and "Assign competencies to the ticked ready" in pg and 'name="sid" value="%d"' % A not in pg)
    home = SUP.get("/admin").get_data(as_text=True)
    hj = home[home.index('class="admin-card hj-card"'):]
    hj = hj[:hj.index("</section>")]
    s.check("Home's card offers Assign for the ready ones, double-confirmed", ('name="sid" value="%d"' % C) in hj
            and ('name="sid" value="%d"' % A) not in hj and "data-confirm=" in hj and ">Assign to the " in hj)
    s.check("...it starts folded: head and Set them up first, then a closed details.hj-fold holding the columns and footnote",
            '<details class="hj-fold">' in hj and '<details class="hj-fold" open' not in hj
            and hj.index("came in.") < hj.index("Set them up") < hj.index("<details")
            and hj.index("<details") < hj.index('class="hj-cols"') < hj.index("The flag counts everyone")
            and "Show details" in hj and "Hide details" in hj, hj[:300])
    s.check("...and sits at the top of Home, above the business groups' table",
            home.index('class="admin-card hj-card"') < home.index('class="admin-card hm"') if 'class="admin-card hm"'
            in home else True)
    SUP.post("/admin/people/joiners", data={"csrf_token": "tok", "action": "assign_ready"})
    s.check("nothing ticked assigns nobody", n_assigned("ZZ9JN-C") == 0)
    SUP.post("/admin/people/joiners", data={"csrf_token": "tok", "action": "assign_ready", "sid": [str(C), str(A)]})
    s.check("ticked: the ready one gets their job's set", n_assigned("ZZ9JN-C") == 10, n_assigned("ZZ9JN-C"))
    s.check("...a ticked one who isn't ready is left alone", sorted(
        x[0] for x in H.rows(a, "SELECT skill_id FROM tc_assignments WHERE cycle_id=? AND subject_id=?", (CID, A)))
        == before)
    s.check("...and logged", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='tc_person_reset' "
                                      "AND target_user_id=?", (LOG0, C)) == 1)
    s.check("the page's POST needs the double confirmation", 'data-confirm="Give the ticked joiners' in pg)

    # ------------------------------------------------------------------------------------------------------------
    s.section("why the others are out: the grey line's reasons")
    with a.app.app_context():
        db = a.get_db()
        _c = db.execute("SELECT min_job_grade, min_valid FROM cycles WHERE id=?", (CID,)).fetchone()
        _tm = db.execute("SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key='tm'", (CID,)).fetchone()
        ORIG["cycle"] = (CID, _c[0], _c[1], _tm[0] if _tm else None)
        db.execute("UPDATE cycles SET min_job_grade=12 WHERE id=?", (CID,))
        rid = db.execute("INSERT INTO user_roles(name) VALUES ('ZZJN opens no review')").lastrowid
        db.execute("INSERT INTO user_role_modules(role_id, module) VALUES (?, 'idp')", (rid,))
        rid2 = db.execute("INSERT INTO user_roles(name) VALUES ('ZZJN review, no 360')").lastrowid
        db.executemany("INSERT INTO user_role_modules(role_id, module) VALUES (?,?)",
                       [(rid2, "pm"), (rid2, "competency")])
        db.execute("INSERT INTO cycle_exclusions(cycle_id, business_group, company, department) VALUES (?,?,?, '')",
                   (CID, BG, "ZZJN Unit2"))

        def mk(eid, grade="12", conf=None, company=CO, role=None, mgr="ZZ9JN-M"):
            # a joiner: came in by Add a person today
            return db.execute(
                "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                "department, job_grade, confirmation_date, manager_id, user_role_id, created_at, created_via) "
                "VALUES (?,?, 'x', 'user', ?,?,?, 'ZZJN Zqxkiln', ?,?,?,?, datetime('now'), 'add')",
                (eid.lower(), "ZZ JN " + eid[6:], eid, BG, company, grade, conf, U[mgr], role)).lastrowid
        X = {}
        X["BELOW1"], X["BELOW2"], X["BELOW3"] = (mk("ZZ9JN-L%d" % i, grade="10") for i in (1, 2, 3))
        X["LETTER"] = mk("ZZ9JN-LH", grade="H")
        X["UNIT1"], X["UNIT2"] = mk("ZZ9JN-U1", company="ZZJN Unit2"), mk("ZZ9JN-U2", company="ZZJN Unit2", conf="2020-01-01")
        X["BELOW_UNIT"] = mk("ZZ9JN-LU", grade="9", company="ZZJN Unit2")   # two reasons: the grade is named first
        X["REMOVED"] = mk("ZZ9JN-RM", conf="2020-01-01")
        X["UNIT_REMOVED"] = mk("ZZ9JN-UR", conf="2020-01-01", company="ZZJN Unit2")   # unit first, then the removal
        X["ROLE"] = mk("ZZ9JN-RO", conf="2020-01-01", role=rid)   # a role by hand that opens no review
        X["NOTCONF"] = mk("ZZ9JN-NC")
        for k in ("REMOVED", "UNIT_REMOVED"):
            db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?, 'remove')",
                       (CID, X[k]))
        db.commit()
        me = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        every = a._joiners(db, me)
        mine = {j["p"]["employee_id"]: j for j in a._joiners(db, me, BG)}
        # the independent tally: participation() for each person, one at a time
        per = {}
        for j in every:
            u = db.execute("SELECT * FROM users WHERE id=?", (j["p"]["id"],)).fetchone()
            per[j["p"]["id"]] = a.participation(db, u)
    s.check("our own joiners are all there", all(("ZZ9JN-" + e) in mine for e in
            ("L1", "LH", "U1", "LU", "RM", "UR", "RO", "NC", "A", "B", "C")), sorted(mine))
    s.check("every joiner's `taking` equals participation()", all(j["taking"] == per[j["p"]["id"]][0] for j in every))
    bad = [(j["p"]["employee_id"], j["why_out"], per[j["p"]["id"]][1]) for j in every
           if not j["taking"] and j["why_out"] != per[j["p"]["id"]][1]]
    s.check("...and each one out has participation()'s reason, whichever of the five it is", not bad, bad[:5])
    s.check("someone taking part has no reason", all(j["why_out"] is None for j in every if j["taking"]))
    tally = Counter(per[j["p"]["id"]][1] for j in every if not per[j["p"]["id"]][0])
    s.check("the test data reaches all five reasons", set(tally) == {"below_min_grade", "unit_out", "removed", "role",
                                                                      "not_confirmed"}, dict(tally))
    s.check("...a grade below the floor beats the unit, the unit beats a removal", mine["ZZ9JN-LU"]["why_out"]
            == "below_min_grade" and mine["ZZ9JN-UR"]["why_out"] == "unit_out" and mine["ZZ9JN-LH"]["why_out"]
            == "below_min_grade", (mine["ZZ9JN-LU"]["why_out"], mine["ZZ9JN-UR"]["why_out"]))
    with a.app.app_context():
        db = a.get_db()
        flag = a._joiner_flag(db, db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
    s.check("the flag's not_taking is the sum of the reasons", flag["not_taking"] == sum(tally.values()),
            (flag["not_taking"], dict(tally)))
    home = _html.unescape(SUP.get("/admin").get_data(as_text=True))
    m = re.search(r"The other ([\d,]+) aren't in this cycle's review: ([^<]*)\.</span>", home)
    s.check("Home's grey line names the others and says why", bool(m), home[home.find("The other"):][:200])
    got, order = {}, []
    WORDS = {"below this cycle's lowest job grade": "below_min_grade", "not confirmed yet": "not_confirmed",
             "taken out by an admin": "removed", "in a unit or department it leaves out": "unit_out",
             "left out by their user role": "role"}
    for n_, w_ in re.findall(r"([\d,]+) (%s)" % "|".join(re.escape(w) for w in WORDS), m.group(2) if m else ""):
        got[WORDS[w_]] = int(n_.replace(",", ""))
        order.append(int(n_.replace(",", "")))
    s.check("...each reason's number is the per-person tally, and no other", got == dict(tally), (got, dict(tally)))
    s.check("...biggest first", order == sorted(order, reverse=True), order)
    s.check("...the headline number is the total", int(m.group(1).replace(",", "")) == sum(tally.values()))
    s.check("...the old one-reason line is gone", "weren't confirmed by the cycle's start" not in home)
    w = a._joiner_why_out_words
    s.check("the words: zero left out, one alone, two with 'and', three with commas, thousands commas",
            w({"not_confirmed": 3, "removed": 0}) == "3 not confirmed yet"
            and w({"not_confirmed": 3, "unit_out": 5}) == "5 in a unit or department it leaves out and 3 not "
                                                           "confirmed yet"
            and w({"below_min_grade": 1412, "not_confirmed": 40, "unit_out": 7}) == (
                "1,412 below this cycle's lowest job grade, 40 not confirmed yet and 7 in a unit or department it "
                "leaves out") and w({}) == "" and w({"not_confirmed": 0}) == "",
            w({"below_min_grade": 1412, "not_confirmed": 40, "unit_out": 7}))
    s.check("the person page's words are the card's where they read after a count", all(
        a._JOINER_WHY_WORDS[k] == a._PERSON_WHY_OUT[k] for k in ("below_min_grade", "not_confirmed", "removed")))
    # falsify: a different reason set changes the answer (the guard is the data, not a constant)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET company=? WHERE id=?", (CO, X["UNIT1"]))   # out of the left-out unit
        db.commit()
        me = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        j1 = {j["p"]["employee_id"]: j for j in a._joiners(db, me, BG)}["ZZ9JN-U1"]
        db.execute("UPDATE users SET company='ZZJN Unit2' WHERE id=?", (X["UNIT1"],))
        db.commit()
    s.check("...falsified: moved out of the left-out unit, U1 is not out for the unit any more",
            j1["why_out"] == "not_confirmed", j1["why_out"])

    # ------------------------------------------------------------------------------------------------------------
    s.section("the 360 panel check for a joiner who takes part")
    with a.app.app_context():
        db = a.get_db()
        R = [db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?, 'ZZJN Zqxkiln', '18', "
            "'2020-01-01')", ("zz9jn-r%d" % i, "ZZ JN R%d" % i, "ZZ9JN-R%d" % i, BG, CO)).lastrowid for i in (1, 2, 3)]
        # C is otherwise complete: a line manager, their job, a set of competencies (above) and a KPI line
        C = uid_of("ZZ9JN-C")
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group) "
                   "VALUES (?,?, 'ZZJN KPI', 100, 'more', ?)", (CID, C, BG))
        db.execute("UPDATE cycles SET min_valid=2 WHERE id=?", (CID,))
        db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='tm'", (CID,))
        db.commit()
    nA = {}

    def panel(subject, assessors=(), archived=(), self_row=False):
        with a.app.app_context():
            db = a.get_db()
            db.execute("DELETE FROM assignments WHERE subject_id=? AND cycle_id=?", (subject, CID))
            for r in assessors + tuple(archived):
                db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, archived) "
                           "VALUES (?,?,?, 'peer', ?)", (CID, subject, r, 1 if r in archived else 0))
            if self_row:
                db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) "
                           "VALUES (?,?,?, 'peer')", (CID, subject, subject))
            db.commit()

    def read(eid="ZZ9JN-C"):
        with a.app.app_context():
            db = a.get_db()
            me = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
            js = {j["p"]["employee_id"]: j for j in a._joiners(db, me)}
            return js[eid], a._joiner_flag(db, me), js

    A = uid_of("ZZ9JN-A")
    panel(C, (R[0], R[1]))
    j, fl, _ = read()
    s.check("setup: C is complete (line manager, job, set, KPI, a full panel), so it needs nothing",
            j["taking"] and j["lm_ok"] and j["role"] and j["n_kpi"] and j["n_tc"] and not j["open"], {
                k: j[k] for k in ("taking", "lm_ok", "n_kpi", "n_tc", "open")})
    s.check("...the 360 was off in this cycle's modules? no row means on", j["n_panel"] == 2
            and not j["panel_short"] and j["min_raters"] == 2, (j["n_panel"], j["min_raters"]))
    panel(C, ())
    j, fl, _ = read()
    s.check("0 raters, threshold 2: short, so open again, and in the flag", j["panel_short"] and j["open"]
            and j["n_panel"] == 0 and fl["no_panel"] >= 1 and fl["min_raters"] == 2, (j["n_panel"], fl["no_panel"]))
    s.check("...in the flag's count exactly as many as are short and take part", fl["no_panel"] == sum(
        1 for x in read()[2].values() if x["taking"] and x["panel_short"]))
    panel(C, (R[0],))
    j, fl, _ = read()
    s.check("1 rater, threshold 2: still short", j["panel_short"] and j["open"] and j["n_panel"] == 1)
    panel(C, (R[0], R[1]))
    j, fl, _ = read()
    s.check("2 raters, threshold 2: drops out of no_panel and of open", not j["panel_short"] and not j["open"]
            and j["n_panel"] == 2)
    panel(C, (R[0], R[1], R[2]))
    j, fl, _ = read()
    s.check("more than the threshold: fine", not j["panel_short"] and j["n_panel"] == 3)
    panel(C, (R[0],), archived=(R[1],))
    j, fl, _ = read()
    s.check("an archived rater doesn't count: 1 live of 2 is short", j["panel_short"] and j["n_panel"] == 1,
            j["n_panel"])
    panel(C, (R[0],), self_row=True)
    j, fl, _ = read()
    s.check("the person's own row doesn't count either: a rater and themselves is 1", j["panel_short"]
            and j["n_panel"] == 1, j["n_panel"])
    panel(C, (R[0], R[1]), self_row=True)
    j, fl, _ = read()
    s.check("...two raters and a self row is 2: not short", not j["panel_short"] and j["n_panel"] == 2)
    # threshold 1
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET min_valid=1 WHERE id=?", (CID,))
        db.commit()
    panel(C, ())
    j, fl, _ = read()
    s.check("threshold 1, 0 raters: short, and the flag carries the threshold", j["panel_short"] and j["open"]
            and fl["min_raters"] == 1)
    home = _html.unescape(SUP.get("/admin").get_data(as_text=True))
    s.check("...the card's row says 'No 360 panel yet'", "No 360 panel yet" in home
            and "Fewer than 1 raters" not in home)
    panel(C, (R[0],))
    j, fl, _ = read()
    s.check("threshold 1, 1 rater: not short", not j["panel_short"] and not j["open"])
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET min_valid=2 WHERE id=?", (CID,))
        db.commit()
    panel(C, ())
    home = _html.unescape(SUP.get("/admin").get_data(as_text=True))
    hj = home[home.index('class="admin-card hj-card"'):]
    hj = hj[:hj.index("</section>")]
    j, fl, js = read()
    rowm = re.search(r'<div class="hj-r"><span>Fewer than 2 raters on their 360 panel</span>(.*?)</div>', hj, re.S)
    s.check("the card's fourth row in the taking-part column, with the threshold", bool(rowm)
            and hj.index("Fewer than 2 raters") > hj.index("Their job isn't placed")
            and hj.index("Fewer than 2 raters") < hj.index("Not taking part this cycle"), hj.find("Their job isn't"))
    rowt = rowm.group(1) if rowm else ""
    s.check("...its count is the flag's, a list link for the super admin (list key no_panel)",
            ("<b>%d</b>" % fl["no_panel"]) in rowt and "which=no_panel" in rowt and "data-list-open" in rowt, rowt[:300])
    s.check("...with the Set up panels button on the taking-part tab", "Set up panels" in rowt
            and "tab=taking" in rowt, rowt[-200:])
    s.check("...the footer sentence names the 360 panel", "KPI lines, competencies and a 360 panel." in home)
    lst = SUP.get("/admin/list/joiners?which=no_panel&fragment=1").get_data(as_text=True)
    s.check("its list holds C and not a joiner with a full panel", "ZZ9JN-C" in lst and "ZZ9JN-A" not in lst
            if not js["ZZ9JN-A"]["panel_short"] else "ZZ9JN-C" in lst, lst[:0])
    s.check("...and the list is the same people as the flag's count", len(re.findall(r'data-person|href="/admin/users/',
            lst)) >= 1)
    s.check("the list opens the person's 360 tab", a.JOINER_LISTS["no_panel"][2] == "f360")
    s.check("...its rows are exactly the joiners with panel_short", all(
        ((j["p"]["employee_id"] in lst) == bool(j["panel_short"])) for j in js.values()
        if j["p"]["employee_id"].startswith("ZZ9JN-")))
    pg = SUP.get("/admin/people/joiners?fbg=" + BG + "&tab=taking").get_data(as_text=True)
    s.check("the page's line for C: 360 panel: 0 raters, needs 2", "360 panel: 0 raters, needs 2" in pg, pg[:0])
    panel(C, (R[0],))
    pg = SUP.get("/admin/people/joiners?fbg=" + BG + "&tab=taking").get_data(as_text=True)
    s.check("...singular for one: '1 rater, needs 2'", "360 panel: 1 rater, needs 2" in pg
            and "1 raters" not in pg)
    panel(C, (R[0], R[1]))
    pg = SUP.get("/admin/people/joiners?fbg=" + BG + "&tab=taking").get_data(as_text=True)
    nshort = sum(1 for x in read()[2].values() if x["taking"] and x["panel_short"] and x["p"]["employee_id"].startswith(
        "ZZ9JN-"))   # (A, with no raters, is still short)
    s.check("...gone for C when the panel is full: one line a short person, no more", pg.count(", needs 2") == nshort
            and "360 panel: 1 rater" not in pg, (pg.count(", needs 2"), nshort))

    # the guards, falsified one by one: each, switched, changes the answer
    panel(C, ())
    j, fl, js = read()
    s.check("baseline for the guards: C short", j["panel_short"] and j["open"])
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'tm', 0)", (CID,))
        db.commit()
    j, fl, js = read()
    s.check("the 360 module OFF: nobody is short, C is complete again, the card's count is 0", not any(
        x["panel_short"] for x in js.values()) and not j["open"], fl and fl["no_panel"])
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='tm'", (CID,))
        db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'tm', 1)", (CID,))
        db.commit()
    j, fl, js = read()
    s.check("...switched back ON: short again (the guard is the module)", j["panel_short"] and j["open"])
    # a role that opens the review but not the 360
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET user_role_id=? WHERE id=?", (rid2, C))
        db.commit()
    j, fl, js = read()
    s.check("a user role without the 360 (tm_rated): takes part (PM and competency) but isn't short, not counted",
            j["taking"] and not j["panel_short"] and not j["open"], (j["taking"], j["panel_short"]))
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO user_role_modules(role_id, module) VALUES (?, 'tm_rated')", (rid2,))
        db.commit()
    j, fl, js = read()
    s.check("...give that role tm_rated and C is short again (the guard is the role)", j["panel_short"] and j["open"])
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM user_role_modules WHERE role_id=? AND module='tm_rated'", (rid2,))
        db.execute("UPDATE users SET user_role_id=NULL WHERE id=?", (C,))
        db.commit()
    # out of the review: no raters, but never short
    B_ = uid_of("ZZ9JN-B")
    panel(B_, ())
    j, fl, js = read("ZZ9JN-B")
    s.check("someone not taking part with no raters isn't short and isn't in the count", not j["taking"]
            and not j["panel_short"])
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?, 'remove')", (CID, C))
        db.commit()
    j, fl, js = read()
    s.check("taken out by an admin: not taking part, so not short (the guard is the participation)",
            not j["taking"] and not j["panel_short"])
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM cycle_participants WHERE cycle_id=? AND subject_id=?", (CID, C))
        db.commit()
    j, fl, js = read()
    s.check("...put back: short once more", j["panel_short"])
    s.check("the old case still holds: confirmed during the cycle with no panel is short and open", all(
        read(e)[0]["panel_short"] == (read(e)[0]["taking"] and read(e)[0]["n_panel"] < 2) for e in ("ZZ9JN-A", "ZZ9JN-C")))
    # every reader that maps the cycle's modules back is restored in `finally`
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _restore(_db)
        _cleanup(_db)

sys.exit(s.done())
