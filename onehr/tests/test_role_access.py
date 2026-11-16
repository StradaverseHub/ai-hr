"""Admin role access, Chris's decisions of 2026-10-18.

  * "all scoring related rule goes to super admin only": the scoring method and the achievement % cut-offs are saved by
    the super admin only; a BG admin reads their group's, with no form, and a post is refused
  * "for setting up the user profile, assigning kpi and competency, no reason is needed and admins can do it anytime
    before the result release for the said cycle": an admin adds KPI lines and competencies with no reason until the
    person's result goes out (to their leaders or to them); then the person page, the KPI import and the competency
    generator leave them as they are. A performance release locks the KPI lines, a potential release the competencies,
    a talent release both
  * "retire hard delete": the People page's remove_user is refused with a bare 404 and deletes nothing

(BU CEO seats are in test_seat_rules; the reason on Fill BU result is in test_kpi_routing.)
Self-contained: its own business group, unit, admins and people, deleted at the end.
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Admin role access -- scoring is the super admin's, set-up open until release, no hard delete")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO = "ZZRA Role Group", "ZZRA Role Unit"
ids = {}


def _cleanup(db):
    # the group's scoring first: a saved method names who saved it (updated_by)
    db.execute("DELETE FROM pm_cycle_bands WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_cycle_band_sets WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZRA-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        for t in ("result_releases", "leader_releases", "talent_releases"):
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (t, ph), ul)
        db.execute("DELETE FROM tc_assignments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE "
                   "subject_id IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))   # the KPI lines' library rows
    db.execute("DELETE FROM activity_log WHERE detail LIKE '%ZZRA P&R agreed%'")   # a crashed run's band remark
    db.commit()


def q1(sql, args=()):
    return H.one(a, sql, args)


try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        CID = a.active_cycle(db)["id"]
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))

        def mk(eid, role="user", admin_bg=None, mgr=None):
            return db.execute(
                "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                "department, job_title, job_grade, confirmation_date, admin_bg, manager_id) "
                "VALUES (?,?, 'x', ?, ?, ?, ?, 'ZZ Dept', 'ZZRA Analyst', '16', '2020-01-01', ?, ?)",
                (eid.lower(), "ZZ RA " + eid[5:], role, eid, BG, CO, admin_bg, mgr)).lastrowid
        ids["bgadm"] = mk("ZZRA-BGADM", "admin", admin_bg=BG)
        ids["subadm"] = mk("ZZRA-SUBADM", "admin", admin_bg=BG)
        db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (ids["subadm"], CO))
        ids["m1"] = mk("ZZRA-M1")
        ids["p1"] = mk("ZZRA-P1", mgr=ids["m1"])
        ids["p2"] = mk("ZZRA-P2", mgr=ids["m1"])
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'excellence')", (BG,))
        for i, (lo, hi, lab) in enumerate(((0, 60, "UA"), (60, 80, "BE"), (80, 100, "ME"), (100, 120, "AE"),
                                           (120, None, "OU")), start=1):
            db.execute("INSERT INTO pm_cycle_bands(cycle_id, business_group, min_value, label, sort_order) "
                       "VALUES (?,?,?,?,?)", (CID, BG, lo, lab, i))
        # three DIFFERENT competencies: two levels of one can't both be current (_tc_add_level_problem, 2026-11-07)
        SKILLS, _fams = [], set()
        for r in db.execute("SELECT id, skill_code, title FROM tc_skills WHERE active=1 ORDER BY id"):
            k = a.tc_comp_key(r["skill_code"], r["title"])
            if k not in _fams:
                _fams.add(k)
                SKILLS.append(r["id"])
            if len(SKILLS) == 3:
                break
        db.commit()
    BGC, SUB, SUP = H.client_as(a, ids["bgadm"]), H.client_as(a, ids["subadm"]), H.client_as(a, SU["id"])
    P1 = ids["p1"]

    # ------------------------------------------------------------------------------------------------------------
    s.section("scoring rules are the super admin's")
    pg = BGC.get("/admin/performance/config").get_data(as_text=True)
    s.check("a BG admin reads their group's scoring, marked read only, with no form",
            "Read only for you" in pg and "Achievement %, capped at excellence" in pg
            and 'value="set_mechanism"' not in pg and 'value="set_bands"' not in pg)
    s.check("...and sees the cut-offs as they stand (the starts, read only)", 'data-start="OU">120</span>' in pg
            and 'data-start="BE">60</span>' in pg and 'name="min_' not in pg)
    r = BGC.post("/admin/performance/config", data={"csrf_token": "tok", "action": "set_mechanism",
                                                    "business_group": BG, "mechanism": "A"})
    s.check("a BG admin's change of method is refused", r.status_code == 403
            and q1("SELECT mechanism FROM pm_bg_config WHERE business_group=?", (BG,)) == "B", r.status_code)
    bands = {"min_%s" % k: v for k, v in (("UA", "0"), ("BE", "50"), ("ME", "70"), ("AE", "90"), ("OU", "110"))}
    bands["cycle_id"] = str(CID)   # band starts are per cycle (2026-10-29): a save names its cycle
    r = BGC.post("/admin/performance/config", data=dict(bands, csrf_token="tok", action="set_bands", business_group=BG))
    s.check("...so is a change of cut-offs", r.status_code == 403
            and q1("SELECT min_value FROM pm_cycle_bands WHERE business_group=? AND label='BE'", (BG,)) == 60,
            r.status_code)
    r = SUB.post("/admin/performance/config", data={"csrf_token": "tok", "action": "set_mechanism",
                                                    "business_group": BG, "mechanism": "A"})
    s.check("...and a unit admin's", r.status_code == 403, r.status_code)
    pg = SUP.get("/admin/performance/config").get_data(as_text=True)
    s.check("the super admin has the forms", 'value="set_mechanism"' in pg and "Read only for you" not in pg)
    SUP.post("/admin/performance/config", data=dict(bands, csrf_token="tok", action="set_bands", business_group=BG))
    s.check("...but not without the remark a band-moving rule needs (2026-10-18)",
            q1("SELECT min_value FROM pm_cycle_bands WHERE business_group=? AND label='BE'", (BG,)) == 60)
    SUP.post("/admin/performance/config", data=dict(bands, csrf_token="tok", action="set_bands", business_group=BG,
                                                    remark="ZZRA P&R agreed the new cut-offs"))
    s.check("...and saves the cut-offs with it, the remark in the audit row",
            q1("SELECT min_value FROM pm_cycle_bands WHERE business_group=? AND label='BE'", (BG,)) == 50
            and q1("SELECT COUNT(*) FROM activity_log WHERE action='pm_rating_bands' AND detail LIKE ?",
                   ("%" + BG + "%remark: ZZRA P&R agreed the new cut-offs%",)) == 1)

    # ------------------------------------------------------------------------------------------------------------
    s.section("KPI lines: open until the performance result goes out, no reason asked")

    def add_kpi(client, name, uid=P1):
        with a.app.app_context():   # an Add picks a library KPI (2026-10-30): this name's row, made when there is none
            db = a.get_db()
            r_ = db.execute("SELECT id FROM pm_kpi_library WHERE business_group=? AND kpi_name=?", (BG, name)).fetchone()
            lid_ = r_[0] if r_ else db.execute(
                "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, unit, "
                "method, active) VALUES (?, '*', '*', 0, '*', ?, '%', 'more', 1)", (BG, name)).lastrowid
            db.commit()
        return client.post("/admin/users/%d/kpi" % uid, data={
            "csrf_token": "tok", "action": "add", "kpi": name, "library_id": str(lid_), "weightage": "20", "method": "more",
            "threshold": "80", "target": "100", "excellence": "120", "moderator": "lm"})

    def n_kpi(uid=P1):
        return q1("SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (CID, uid))
    add_kpi(SUP, "ZZRA Sales")
    s.check("the super admin adds a KPI line with no reason", n_kpi() == 1, n_kpi())
    r = BGC.post("/admin/users/%d/kpi" % P1, data={"csrf_token": "tok", "action": "add", "kpi": "ZZRA Refused",
                                                     "weightage": "10", "method": "more"})
    s.check("a BG admin can't add one: view only (Chris, 2026-10-19)", r.status_code == 403 and n_kpi() == 1)
    tid = q1("SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? AND kpi_name='ZZRA Sales'", (CID, P1))
    SUP.post("/admin/users/%d/kpi" % P1, data={"csrf_token": "tok", "action": "edit", "kpi_target_id": tid,
                                               "kpi": "ZZRA Sales", "weightage": "30", "method": "more",
                                               "threshold": "80", "target": "100", "excellence": "120",
                                               "moderator": "lm"})
    s.check("...and edits it with no reason", q1("SELECT weightage FROM pm_kpi_targets WHERE id=?", (tid,)) == 30)

    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pot')", (CID, P1))
        db.commit()
    add_kpi(SUP, "ZZRA Margin")
    s.check("a potential release alone leaves the KPI lines open", n_kpi() == 2, n_kpi())

    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO leader_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pm')", (CID, P1))
        db.commit()
    add_kpi(SUP, "ZZRA Late")
    s.check("once the performance result goes to the leaders, no line is added", n_kpi() == 2, n_kpi())
    SUP.post("/admin/users/%d/kpi" % P1, data={"csrf_token": "tok", "action": "edit", "kpi_target_id": tid,
                                               "kpi": "ZZRA Sales", "weightage": "40", "method": "more",
                                               "threshold": "80", "target": "100", "excellence": "120",
                                               "moderator": "lm"})
    s.check("...none edited", q1("SELECT weightage FROM pm_kpi_targets WHERE id=?", (tid,)) == 30)
    SUP.post("/admin/users/%d/kpi" % P1, data={"csrf_token": "tok", "action": "delete", "kpi_target_id": tid})
    s.check("...none deleted", n_kpi() == 2)
    add_kpi(SUP, "ZZRA Late")
    s.check("...not even by the super admin", n_kpi() == 2)
    pg = SUP.get("/admin/users/%d?tab=performance" % P1).get_data(as_text=True)
    s.check("the person page says the lines are final and offers no add or edit",
            "These KPI lines are final" in pg and 'value="add"' not in pg and 'value="edit"' not in pg
            and ">Edit</a>" not in pg and "+ Add a KPI" not in pg and ">View</a>" in pg)

    csv = ("Employee ID,KPI,Weightage,Method,Threshold,Target,Excellence,Matrix manager ID\n"
           "ZZRA-P1,ZZRA Imported,20,More,80,100,120,\n")
    r = H.import_steps(SUP, "/admin/performance/import", {"file": (io.BytesIO(csv.encode()), "k.csv")})
    s.check("the KPI import refuses a released person's lines and imports nothing",
            "A result already released" in r.get_data(as_text=True) and n_kpi() == 2)
    csv2 = csv.replace("ZZRA-P1", "ZZRA-P2")
    H.import_steps(SUP, "/admin/performance/import", {"file": (io.BytesIO(csv2.encode()), "k.csv")})
    s.check("...while someone not released imports as before", n_kpi(ids["p2"]) == 1, n_kpi(ids["p2"]))

    # ------------------------------------------------------------------------------------------------------------
    s.section("competencies: open until the potential result goes out")

    def n_tc(uid):
        return q1("SELECT COUNT(*) FROM tc_assignments WHERE cycle_id=? AND subject_id=?", (CID, uid))
    P2 = ids["p2"]
    SUP.post("/admin/users/%d/competency" % P2, data={"csrf_token": "tok", "action": "add", "skill_id": SKILLS[0]})
    s.check("the super admin adds a competency with no reason", n_tc(P2) == 1, n_tc(P2))
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO leader_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pm')", (CID, P2))
        db.commit()
    SUP.post("/admin/users/%d/competency" % P2, data={"csrf_token": "tok", "action": "add", "skill_id": SKILLS[1]})
    s.check("a performance release alone leaves the competencies open", n_tc(P2) == 2, n_tc(P2))
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO leader_releases(cycle_id, subject_id, kind) VALUES (?,?, 'talent')", (CID, P2))
        db.commit()
    SUP.post("/admin/users/%d/competency" % P2, data={"csrf_token": "tok", "action": "add", "skill_id": SKILLS[2]})
    s.check("a talent release locks them (it carries both results)", n_tc(P2) == 2, n_tc(P2))
    SUP.post("/admin/users/%d/competency" % P1, data={"csrf_token": "tok", "action": "add", "skill_id": SKILLS[0]})
    s.check("so does a potential release to the person", n_tc(P1) == 0, n_tc(P1))
    pg = SUP.get("/admin/users/%d?tab=competency&fragment=1" % P1).get_data(as_text=True)
    s.check("the person page says the list is final and offers no change",
            "This list is final" in pg and 'value="reset"' not in pg)
    add_kpi(SUP, "ZZRA Late", uid=P2)
    s.check("...and a talent release locks the KPI lines too", n_kpi(P2) == 1, n_kpi(P2))

    # the generator, on a stand-in profile so this unit's people resolve (its own code is unchanged)
    with a.app.test_request_context("/"):
        db = a.get_db()
        me = db.execute("SELECT * FROM users WHERE id=?", (ids["bgadm"],)).fetchone()
        real_for, real_plan = a.tc_profile_for_user, a.tc_profile_plan
        a.tc_profile_for_user = lambda db_, u, *x, **k: ({"id": -7, "job_title": "ZZRA stand-in"}, "test")
        a.tc_profile_plan = lambda db_, pid: [(SKILLS[0], 0, 1)]
        try:
            rep = a.tc_generate_assignments(db, me, CID, commit=False)
        finally:
            a.tc_profile_for_user, a.tc_profile_plan = real_for, real_plan
        rel = {e["id"] for e in rep["released"]}
        asg = {e["id"] for e in rep["assign"]}
    s.check("the generator leaves a person whose potential result is out as they are", P1 in rel and P1 not in asg,
            (sorted(rel), sorted(asg)))
    s.check("...and still assigns someone whose result isn't out", ids["m1"] in asg, sorted(asg))

    # ------------------------------------------------------------------------------------------------------------
    s.section("the hard delete is retired")
    for who, c, code in (("a BG admin", BGC, 403), ("the super admin", SUP, 404)):
        r = c.post("/admin/users", data={"csrf_token": "tok", "action": "remove_user", "user_id": ids["p2"]})
        s.check("%s's remove_user is refused (%d: view only / retired) and deletes nothing" % (who, code),
                r.status_code == code
                and q1("SELECT COUNT(*) FROM users WHERE id=?", (ids["p2"],)) == 1
                and n_tc(P2) == 2, r.status_code)
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
