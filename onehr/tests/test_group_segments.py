"""A Group Chief's group: each batch of people named, the names as the Talent Box's filter, and Refresh from departments
(Chris, 2026-10-13: "the filter should consist of the department or group of people being added to the pool, e,g,
People, Technology, Data ... named by the admin when selecting the individuals to be added"; and "2. yes" to a group
following its departments, after a preview).

What this suite holds:
  * adding by department or by Employee ID takes a name ("Show them as"); someone already in the group moves to it; a
    department added with "keep following" is stored as a rule
  * the Group Chief's Talent Box filters by those names (else the person's department); a pick narrows the box
  * a name can be renamed, a rule dropped
  * Refresh: who joins (matching, in no other group, not taken out by hand), who leaves (added by department and no
    longer in it, or gone), who stays (added by Employee ID; a locked call); Apply changes exactly what was shown
  * once the group's calls are locked, Refresh is closed

Synthetic (ZZGS-*) on the shared suite database; everything is put back at the end.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Group batches -- named on the groups page, the Group Chief's filter, Refresh from departments")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
_real_avail = a.ai_draft.review_agent_available
a.ai_draft.review_agent_available = lambda: True
BG, CO = "ZZGS Group", "ZZGS Group Sdn Bhd"
T, D_, X = "ZZGS Tech", "ZZGS Data", "ZZGS Finance"
ids = {}


def _cleanup(db):
    gids = [r[0] for r in db.execute("SELECT id FROM pm_calibration_groups WHERE name LIKE 'ZZGS%'")]
    if gids:
        ph = ",".join("?" * len(gids))
        for t in ("pm_group_locks", "pot_group_locks", "pm_calibration_group_members"):
            db.execute("DELETE FROM %s WHERE group_id IN (%s)" % (t, ph), gids)
        db.execute("DELETE FROM pm_calibration_sessions WHERE tier='group' AND scope_key IN (%s)" % ph,
                   [str(g) for g in gids])
        db.execute("DELETE FROM app_settings WHERE key IN (%s)" % ph, ["calib_group_rules:%s" % g for g in gids])
        db.execute("DELETE FROM pm_calibration_groups WHERE id IN (%s)" % ph, gids)
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZGS-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        for t in ("pm_kpi_approvals", "pm_kpi_results", "pm_kpi_target_approvers"):
            db.execute("DELETE FROM %s WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s))"
                       % (t, ph), ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE detail LIKE 'ZZGS%'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.commit()


def rules(gid):
    with a.app.app_context():
        return a.calib_group_rules(gid)


def members(gid):
    return {r[0]: (r[1], r[2]) for r in H.rows(a, "SELECT subject_id, segment, source FROM pm_calibration_group_members "
                                                   "WHERE group_id=?", (gid,))}


try:
    with a.app.app_context():
        db = a.get_db()
        _cleanup(db)
        CID = a.active_cycle_id(db)
        PID = a.active_pm_period_id(db)
        _mods = {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=? AND "
                                                "module_key IN ('review','pm','tm','calibration')", (CID,))}
        for k in ("review", "pm", "tm", "calibration"):
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1) ON CONFLICT(cycle_id, "
                       "module_key) DO UPDATE SET active=1", (CID, k))
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (BG,))

        def mk(eid, dept):
            uid = db.execute(
                "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                "department, job_grade, years_of_service) VALUES (?,?, 'x', 'user', ?, ?, ?, ?, '16', 3)",
                (eid.lower(), "ZZ GS " + eid[5:], eid, BG, CO, dept)).lastrowid
            t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, rate1, "
                           "rate2, rate3, rate4, rate5, business_group, company) VALUES (?,?, 'ZZGS KPI', 100, 'more', "
                           "'approved', 80,90,100,110,120, ?,?)", (PID, uid, BG, CO)).lastrowid
            db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,100,?,0)",
                       (t, uid))
            return uid
        ids["chief"] = mk("ZZGS-CHIEF", "Group Office")
        for k in ("t1", "t2", "t3"):
            ids[k] = mk("ZZGS-" + k.upper(), T)
        for k in ("d1", "d2"):
            ids[k] = mk("ZZGS-" + k.upper(), D_)
        ids["x1"] = mk("ZZGS-X1", X)
        GID = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZGS Tech Office', ?)",
                         (ids["chief"],)).lastrowid
        db.commit()
    S = H.client_as(a, SU["id"])
    P = "/admin/performance/calibration-groups"

    s.section("naming a batch as it's added")
    S.post(P, data={"csrf_token": "tok", "action": "add_matching", "group_id": GID, "dept": T, "bg": BG,
                    "segment": "Technology", "follow": "1"})
    m = members(GID)
    s.check("added by department, shown as Technology, marked as by department",
            {ids[k] for k in ("t1", "t2", "t3")} <= set(m) and m[ids["t1"]] == ("Technology", "dept"), m)
    s.check("...and the group now follows that department", rules(GID)["rules"] ==
            [{"dept": T, "bgs": [BG], "segment": "Technology", "exact": False}], rules(GID))   # no list flag: "contains"
    S.post(P, data={"csrf_token": "tok", "action": "paste_ids", "group_id": GID, "ids": "ZZGS-D1 ZZGS-D2",
                    "segment": "Data"})
    m = members(GID)
    s.check("added by Employee ID, shown as Data, marked as by person", m[ids["d1"]] == ("Data", "person"), m)
    S.post(P, data={"csrf_token": "tok", "action": "add_member", "group_id": GID, "employee_id": "ZZGS-X1"})
    s.check("a name left blank: they show under their own department", members(GID)[ids["x1"]][0] is None)
    S.post(P, data={"csrf_token": "tok", "action": "paste_ids", "group_id": GID, "ids": "ZZGS-T3", "segment": "Data"})
    s.check("someone already in the group moves to the name given", members(GID)[ids["t3"]][0] == "Data")
    pg = S.get(P).get_data(as_text=True)
    s.check("the page shows the names, the department followed, and Refresh",
            "Shown on the Group Chief" in pg and "Technology <b>2</b>" in pg and "Data <b>3</b>" in pg
            and "Refresh from departments" in pg and "Shown as" in pg)

    s.section("the Group Chief's Talent Box filters by them")
    GV = "/review/journey?view=group&stage=group_calib"

    def box(path=GV):
        with a.app.test_request_context(path):
            a.session["user_id"] = ids["chief"]
            db = a.get_db()
            u = dict(db.execute("SELECT * FROM users WHERE id=?", (ids["chief"],)).fetchone())
            return (a._journey_team_overview(db, u, "group_calib", None, "summary") or {}).get("data") or {}
    d = box()
    seg = next((f for f in d.get("filters") or [] if f["key"] == "seg"), {})
    s.check("the Segment chip (the batch pills until 2026-11-02): the names, and a department for anyone without one",
            sorted((x["key"], x["n"]) for x in seg.get("options") or []) == [("Data", 3), ("Technology", 2), (X, 1)],
            seg.get("options"))
    d = box(GV + "&seg=Technology")
    s.check("a pick narrows the box to that batch; the lock still covers everyone",
            (d.get("picks") or {}).get("seg") == ["Technology"] and d.get("placed") == 2 and d.get("bu_people") == 6,
            (d.get("placed"), d.get("bu_people")))
    S.post(P, data={"csrf_token": "tok", "action": "rename_segment", "group_id": GID, "old": "Data",
                    "new": "Data & Analytics"})
    s.check("a name can be renamed, for everyone under it", members(GID)[ids["d2"]][0] == "Data & Analytics"
            and members(GID)[ids["t3"]][0] == "Data & Analytics")

    s.section("Refresh from departments")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET department=? WHERE id=?", (X, ids["t1"]))   # moved out of Tech
        ids["t4"] = mk("ZZGS-T4", T)                                          # a new joiner in Tech
        ids["t5"] = mk("ZZGS-T5", T)
        db.commit()
    S.post(P, data={"csrf_token": "tok", "action": "add_member", "group_id": GID, "employee_id": "ZZGS-T5"})
    S.post(P, data={"csrf_token": "tok", "action": "remove_member", "group_id": GID, "subject_id": ids["t5"]})
    with a.app.app_context():
        plan = a._group_refresh_plan(a.get_db(), GID)
    s.check("who joins: the new joiner in Tech, shown as Technology",
            [(x["id"], x["segment"]) for x in plan["join"]] == [(ids["t4"], "Technology")], plan["join"])
    s.check("who leaves: the one added by department who moved out, with where they are now",
            [x["id"] for x in plan["leave"]] == [ids["t1"]] and X in plan["leave"][0]["why"], plan["leave"])
    s.check("someone taken out by hand isn't added back; people added by ID stay",
            plan["out"] == 1 and ids["t5"] not in [x["id"] for x in plan["join"]]
            and ids["t3"] not in [x["id"] for x in plan["leave"]])
    pg = S.get(P + "?refresh=%d" % GID).get_data(as_text=True)
    s.check("the preview names them and offers Apply", "If you refresh now" in pg and "1 join" in pg
            and "1 leave" in pg and "Apply: 1 join, 1 leave" in pg)
    LOGQ = "SELECT COUNT(*) FROM activity_log WHERE action='pm_calib_group_refresh' AND detail LIKE 'ZZGS Tech Office%'"
    log0 = H.one(a, LOGQ)
    S.post(P, data={"csrf_token": "tok", "action": "refresh", "group_id": GID, "fingerprint": "stale"})
    s.check("Apply with an old preview changes nothing", ids["t4"] not in members(GID) and ids["t1"] in members(GID))
    S.post(P, data={"csrf_token": "tok", "action": "refresh", "group_id": GID, "fingerprint": plan["fingerprint"]})
    m = members(GID)
    s.check("Apply: exactly what the preview showed", ids["t4"] in m and m[ids["t4"]] == ("Technology", "dept")
            and ids["t1"] not in m, m)
    s.check("...logged, once", H.one(a, LOGQ) == log0 + 1, (log0, H.one(a, LOGQ)))

    s.section("a locked call stays; a locked group can't be refreshed")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET department=? WHERE id=?", (X, ids["t2"]))
        db.execute("INSERT INTO pm_group_locks(cycle_id, group_id, subject_id, band, locked_by) VALUES (?,?,?,'ME',?)",
                   (PID, GID, ids["t2"], ids["chief"]))
        db.commit()
        plan = a._group_refresh_plan(db, GID)
    s.check("someone whose call is locked stays, said so", [x["id"] for x in plan["held"]] == [ids["t2"]]
            and not plan["leave"], plan)
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, "
                   "locked_at) VALUES (?, 'group', ?, ?, 'ZZGS', datetime('now'))", (PID, str(GID), BG))
        db.commit()
        fp = a._group_refresh_plan(db, GID)["fingerprint"]
    S.post(P, data={"csrf_token": "tok", "action": "refresh", "group_id": GID, "fingerprint": fp})
    s.check("once the group's calls are locked, Refresh is refused", H.one(a, LOGQ) == log0 + 1
            and ids["t2"] in members(GID))
    s.check("...and the page says it's closed", "Refresh is closed" in S.get(P).get_data(as_text=True))
    S.post(P, data={"csrf_token": "tok", "action": "drop_rule", "group_id": GID, "rule": 0})
    s.check("a rule can be dropped; its people stay", rules(GID)["rules"] == [] and ids["t4"] in members(GID))
finally:
    a.ai_draft.review_agent_available = _real_avail
    with a.app.app_context():
        db = a.get_db()
        _cleanup(db)
        for k, v in _mods.items():
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, CID, k))
        db.commit()

sys.exit(s.done())
