"""The Career Plan's COMPLETION counts cover only people in the cycle's review (Chris, 2026-11-06: "Take it out entirely from
our completion calculation for non-participants").

What this suite holds:
  * idp_count_sql = in the review (participant_sql) AND their role opens the Career Plan (idp_participant_sql). A confirmed
    person in the review is counted; one taken out of the cycle, one not confirmed yet (Basic role) and a Grade H person are
    NOT -- though each still HAS a plan (idp_participant_sql / idp_participation are unchanged).
  * every completion reader follows it: _mod_scope_users(idp=True), _lp_people(idp=True) and the leader progress strips
    (lp_counts), the admin Progress page (chips, rows, the Excel), Reports > Plan progress, the Overview page's by-group row
    and the two Overview list panels (_list_idp_plans, _list_idp_checkins), Home's Career Plan cell and its list
  * the person who is not counted can still open and write their plan through its real route: it is not taken away
  * what is NOT a completion count keeps the wide rule: the plan reminder's recipients
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Career Plan completion counts only people in the review")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG, CO = "ZZIC Group", "ZZIC U1"
NAV = {"Sec-Fetch-Mode": "navigate"}


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9IC-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM pm_idp_checkins WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_idp WHERE subject_id IN (%s)" % ph, ul)   # goals go with it (ON DELETE CASCADE)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    CYC0 = dict(db.execute("SELECT kind, half, starts_on, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
    MODS0 = {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))}
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL, starts_on=COALESCE(starts_on, '2026-01-01') "
               "WHERE id=?", (CID,))
    for k in ("review", "pm", "tm", "idp"):   # a deleted cycle_modules row must go back: only set what is there, restore below
        if db.execute("SELECT 1 FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k)).fetchone():
            db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key=?", (CID, k))
        else:
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, k))
    YEAR = a.pm_idp_plan_year(a.active_pm_period(db))

    def mk(eid, confirmed=True, grade="14", mgr=None):
        return db.execute(
            "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, department, "
            "job_title, job_grade, manager_id, confirmation_date, years_of_service) "
            "VALUES (?,?,'x','user',?,?,?,'ZZIC Dept','ZZIC Officer',?,?,?,?)",
            (eid.lower(), "ZZ IC " + eid[-3:], eid, BG, CO, grade, mgr, "2020-01-01" if confirmed else None,
             4.0 if confirmed else 0.5)).lastrowid
    LM = mk("ZZ9IC-LM")                                  # a confirmed line manager: in the review, no plan of their own here
    IN = mk("ZZ9IC-IN", mgr=LM)                          # confirmed, in the review, a SHARED plan: counted
    IN2 = mk("ZZ9IC-I2", mgr=LM)                         # confirmed, in the review, a DRAFT plan: counted, not done
    OUT = mk("ZZ9IC-OU", mgr=LM)                         # confirmed, taken out of the cycle, a draft plan: not counted
    UN = mk("ZZ9IC-UN", confirmed=False, mgr=LM)         # not confirmed (Basic role), a draft plan: not counted
    GH = mk("ZZ9IC-GH", grade="H", mgr=LM)               # Grade H, a draft plan: not counted
    db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'remove')", (CID, OUT))
    for uid, st in ((IN, "shared"), (IN2, "draft"), (OUT, "draft"), (UN, "draft"), (GH, "shared")):
        pid = db.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status, shared_at) VALUES (?,?,?,?,?)",
                         (YEAR, CID, uid, st, None if st == "draft" else "2026-11-01 00:00:00")).lastrowid
        gid = db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area) VALUES (?,1,'ZZIC goal')", (pid,)).lastrowid
        db.execute("INSERT INTO pm_idp_checkins(goal_id, subject_id, status, note) VALUES (?,?,'on_track','ZZIC')", (gid, uid))
    db.commit()
    SU = db.execute("SELECT * FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL LIMIT 1").fetchone()
    SUID = SU["id"]
    COUNTED, NOT_COUNTED = {IN, IN2}, {OUT, UN, GH}
    ALLP = COUNTED | NOT_COUNTED


def name_of(uid):
    return "ZZ IC " + H.one(a, "SELECT employee_id FROM users WHERE id=?", (uid,))[-3:]


def page(path):
    r = H.client_as(a, SUID).get(path, headers=NAV)
    return r.status_code, r.get_data(as_text=True)


try:
    s.section("the rule")
    with a.app.test_request_context("/"):
        d = a.get_db()
        ph = ",".join("?" * len(ALLP))
        ids = list(ALLP)
        has_plan = {r[0] for r in d.execute("SELECT id FROM users WHERE id IN (%s) AND %s" % (ph, a.idp_participant_sql()), ids)}
        in_rev = {r[0] for r in d.execute("SELECT id FROM users WHERE id IN (%s) AND %s" % (ph, a.participant_sql()), ids)}
        counted = {r[0] for r in d.execute("SELECT id FROM users WHERE id IN (%s) AND %s" % (ph, a.idp_count_sql()), ids)}
        counted_p = {r[0] for r in d.execute("SELECT u.id FROM users u WHERE u.id IN (%s) AND %s" % (ph, a.idp_count_sql("u")), ids)}
    s.check("fixture: all five have a plan (idp_participant_sql is unchanged: taken out, unconfirmed and Grade H keep one)",
            has_plan == ALLP, sorted(has_plan))
    s.check("fixture: only the two confirmed, untaken people are in the review", in_rev == COUNTED, sorted(in_rev))
    s.check("idp_count_sql counts exactly the review's people who have a plan -- not the take-out, the unconfirmed or Grade H",
            counted == COUNTED == in_rev & has_plan, sorted(counted))
    s.check("...with a table prefix too", counted_p == COUNTED, sorted(counted_p))

    s.section("the plan is not taken away")
    with a.app.test_request_context("/"):
        d = a.get_db()
        mirror = {x: a.idp_participation(d, d.execute("SELECT * FROM users WHERE id=?", (x,)).fetchone())[0] for x in NOT_COUNTED}
    s.check("idp_participation (the Python mirror of who has a plan) is still True for the uncounted three",
            all(mirror.values()), mirror)
    for who, uid in (("taken out", OUT), ("not confirmed", UN)):
        before = H.one(a, "SELECT COUNT(*) FROM pm_idp_goals g JOIN pm_idp i ON i.id=g.idp_id WHERE i.subject_id=?", (uid,))
        rr = H.client_as(a, uid).post("/idp/autosave", data={"csrf_token": "tok", "action": "add", "area": "ZZIC more %s" % uid})
        j = rr.get_json(silent=True) or {}
        after = H.one(a, "SELECT COUNT(*) FROM pm_idp_goals g JOIN pm_idp i ON i.id=g.idp_id WHERE i.subject_id=?", (uid,))
        s.check("someone %s still writes a goal through the real route (/idp/autosave)" % who,
                rr.status_code == 200 and j.get("ok") is True and after == before + 1, (rr.status_code, j, before, after))
        pg = H.client_as(a, uid).get("/idp", headers=NAV)
        s.check("...and their plan page still opens", pg.status_code == 200, pg.status_code)

    s.section("the readers")
    with a.app.test_request_context("/"):
        d = a.get_db()
        su = d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone()
        spine = set(a._mod_scope_users(d, su, BG, idp=True))
        lp_idp = {i for i in a._lp_people(d, idp=True)} & ALLP
        lp = a.lp_counts(d, a.active_cycle(d), ["idp_self"])
        key = (BG, CO, "ZZIC Dept")
        users, state, _n = a._mod_collect(d, su, a._module_view("idp"), BG)
    s.check("_mod_scope_users(idp=True): the two in the review, none of the three outside it",
            COUNTED <= spine and not NOT_COUNTED & spine, sorted(spine & ALLP))
    s.check("_lp_people(idp=True) (the leaders' panel and email): the same two",
            lp_idp == COUNTED, sorted(lp_idp))
    s.check("lp_counts: the unit's Career Plan column counts the two in the review plus the manager (3), one of them done",
            lp.get("idp_self", {}).get(key) == [3, 1], lp.get("idp_self", {}).get(key))
    s.check("the module's own read (_mod_collect, behind Progress, its Excel and the list panel) holds the two, never the three",
            COUNTED <= set(users) and not NOT_COUNTED & set(users) and COUNTED <= set(state), sorted(set(users) & ALLP))

    code, html_ = page("/admin/module/idp/progress?q=ZZ+IC")
    code0, html0 = page("/admin/module/idp/progress")
    chip = re.search(r'<i class="adm-dot"[^>]*></i>Everyone<span>([\d,]+)</span>', html0)
    with a.app.test_request_context("/"):
        d = a.get_db()
        _tot = len(a._mod_scope_users(d, d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone(), idp=True))
    s.check("Progress (the page): the Everyone chip equals the review-only spine (%d), which holds LM, IN, IN2 of the fixture" % _tot,
            code0 == 200 and chip and int(chip.group(1).replace(",", "")) == _tot and {LM, IN, IN2} <= set(spine) | {LM}, (code0, chip and chip.group(1), _tot))
    s.check("...searching 'ZZ IC' lists the two in the review and none of the three outside it",
            code == 200 and all(name_of(x) in html_ for x in COUNTED) and not any(name_of(x) in html_ for x in NOT_COUNTED), code)
    rx = H.client_as(a, SUID).get("/admin/module/idp/progress.xlsx?fbg=" + BG.replace(" ", "+"), headers=NAV)
    s.check("Progress' Excel opens", rx.status_code == 200, rx.status_code)
    rp = H.client_as(a, SUID).get("/admin/export/idp-progress.xlsx?fbg=" + BG.replace(" ", "+"), headers=NAV)
    s.check("Reports > Plan progress (the same read) opens", rp.status_code == 200, rp.status_code)
    try:
        import io
        import openpyxl
        for lbl, resp in (("Progress' Excel", rx), ("Plan progress", rp)):
            wb = openpyxl.load_workbook(io.BytesIO(resp.get_data()))
            cells = {str(c.value) for ws in wb.worksheets for row in ws.iter_rows() for c in row if c.value is not None}
            s.check("%s lists the two in the review and not the three outside it" % lbl,
                    all(name_of(x) in cells for x in COUNTED) and not any(name_of(x) in cells for x in NOT_COUNTED))
    except ImportError:
        s.check("openpyxl present to read the Excel files", False, "openpyxl missing")

    s.section("the Overview and its panels")
    with a.app.test_request_context("/"):
        d = a.get_db()
        su = d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone()
        a.g.user = su
        plans = a._list_idp_plans(d, su, CID, {"fbg": BG})
        shared = a._list_idp_plans(d, su, CID, {"fbg": BG, "which": "shared"})
        closed = a._list_idp_plans(d, su, CID, {"fbg": BG, "which": "closed"})
        chk = a._list_idp_checkins(d, su, CID, {})
    plan_text = repr(plans["rows"])
    s.check("_list_idp_plans: the two in the review (title says 2), none of the three outside it",
            "· 2" in plans["title"] and all(name_of(x) in plan_text for x in COUNTED) and not any(name_of(x) in plan_text for x in NOT_COUNTED),
            plans["title"])
    s.check("...Shared with a manager lists the one shared plan in the review", "· 1" in shared["title"], shared["title"])
    with a.app.test_request_context("/"):
        d = a.get_db()
        su = d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone()
        a.g.user = su
        sub_all = a._list_idp_plans(d, su, CID, {})["sub"]
        chk_text = repr(chk["rows"])
    s.check("_list_idp_plans' sub text says the people are those in the review", "in the review" in sub_all, sub_all)
    s.check("_list_idp_checkins: the check-ins of the review's people only",
            all(name_of(x) in chk_text for x in COUNTED) and not any(name_of(x) in chk_text for x in NOT_COUNTED), chk["title"])
    code, ov = page("/admin/m/idp")
    row = re.search(r"<tr><td>[^<]*ZZIC[^<]*</td>(.*?)</tr>", ov, re.I | re.S)
    nums = [int(x.replace(",", "")) for x in re.findall(r">\s*([\d,]+)\s*(?:</a>|<span|</td>)", row.group(1))] if row else None
    s.check("Overview page: opens, and the group's row reads people 3 (LM, IN, IN2), started 2, shared 1, closed 0, not started 1 "
            "(the three outside the review left out)",
            code == 200 and nums == [3, 2, 1, 0, 1], (code, nums))

    s.section("Home's Career Plan cell")
    with a.app.test_request_context("/"):
        d = a.get_db()
        su = d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone()
        a.g.user = su
        cyc = a.active_cycle(d)
        mat = a._home_bg_matrix(d, su, cyc)
        lst = a._list_home_cell(d, su, CID, {"col": "idp", "bg": BG})
    cell = None
    for r in mat["rows"]:
        if r["bg"] == BG:
            for c_, col in zip(mat["cols"], r["cells"]):
                if c_["key"] == "idp":
                    cell = col
    s.check("Home's matrix: the group's Career Plan cell counts 3 people (LM, IN, IN2), 1 plan shared",
            cell is not None and cell.get("sub", "").startswith("1 of 3"), cell)
    ltext = repr(lst["rows"])
    s.check("...and its list holds the same people: the review's, not the three outside it",
            all(name_of(x) in ltext for x in COUNTED) and not any(name_of(x) in ltext for x in NOT_COUNTED), lst["title"])

    s.section("what is not a count keeps the wide rule")
    with a.app.test_request_context("/"):
        d = a.get_db()
        remind = {r[0] for r in d.execute("SELECT id FROM users WHERE id IN (%s) AND %s" % (ph, a.idp_participant_sql()), ids)}
    s.check("the plan reminder's population (idp_participant_sql) still holds all five: they are still asked to write a plan",
            remind == ALLP, sorted(remind))
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)
        _db.execute("UPDATE cycles SET kind=?, half=?, starts_on=?, min_job_grade=? WHERE id=?",
                    (CYC0["kind"], CYC0["half"], CYC0["starts_on"], CYC0["min_job_grade"], CID))
        for k in ("review", "pm", "tm", "idp"):
            if k in MODS0:
                _db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (MODS0[k], CID, k))
            else:
                _db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k))
        _db.commit()

sys.exit(s.done())
