"""The dashboard's two states and the Career Plan check-ins (Chris, 2026-10-10, on the "OneHR Dashboard States"
canvas): "drop the fallback links, point them to the AI+ journey, technically outside the active cycle, the personal
dashboard should serve as the past record viewer, and when active cycle kicks in, the timeline progress and pending
items will appear, if not the timeline will just show past cycle completion journey"; "here for the IDP, we can make
it with check in ability, where user can check in the progress and update the status along the year"; "add the
table"; "drop those three"; "For BUCEO, under the active cycle, instead of showing where you stand, we should show the
BU status on performance and potential whether they are ready to lock"; "the action button should have consistent
width"; "make this a cycle year dropdown list instead of showing all ... Same for the career plan".

What this suite holds:

  * pm_idp_checkins: one dated row per check-in, written by the panel's route and by the classic progress route
  * POST /me/plan/checkin: their OWN shared plan only -- another person's goal 404s, a draft or a plan closed unshared
    409s, a bad status 400s, an admin 404s; it answers with the panel, its history newest first (an APPROVED plan takes
    them through its year: test_plan_checkin_approved)
  * the state: running while a cycle is open for them on the AI+ check-in and something is ahead of them, else record
  * the record view: the last cycle's journey with what happened and when, from the rows each step writes; what a
    leader led, with their scope's released final performance counted (released only)
  * a BU CEO's Where your BU is: each axis locked / ready (every department review in) / not ready, never a wait
  * the dashboard links only the AI+ journey and review; the client's dropdowns and check-in; one button width

Shares the suite database and removes everything it adds.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Dashboard states -- the record between cycles, AI+ links only, plan check-ins")
SU, _BG, _EMP = H.actors(a)
BG, CO = "ZZDS Group", "ZZDS Co"

with a.app.app_context():
    db = a.get_db()
    for _cid in [r[0] for r in db.execute("SELECT id FROM cycles WHERE code LIKE 'ZZDS-%'")]:
        db.execute("DELETE FROM pm_calibration_adjustments WHERE session_id IN (SELECT id FROM pm_calibration_sessions "
                   "WHERE cycle_id=?)", (_cid,))
        db.execute("DELETE FROM calibration_adjustments WHERE session_id IN (SELECT id FROM calibration_sessions "
                   "WHERE cycle_id=?)", (_cid,))
        db.execute("DELETE FROM talent_box_bu_locks WHERE cycle_id=?", (_cid,))
        db.execute("DELETE FROM pm_calibration_sessions WHERE cycle_id=?", (_cid,))
        db.execute("DELETE FROM calibration_sessions WHERE cycle_id=?", (_cid,))
    _old = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZDS-%'")]
    for _uid in _old:
        db.execute("DELETE FROM pm_idp_checkins WHERE subject_id=?", (_uid,))
        db.execute("DELETE FROM pm_idp_goals WHERE idp_id IN (SELECT id FROM pm_idp WHERE subject_id=?)", (_uid,))
        db.execute("DELETE FROM pm_idp WHERE subject_id=?", (_uid,))
        for t_ in ("result_releases", "talent_releases", "tc_assessments"):
            db.execute("DELETE FROM %s WHERE subject_id=?" % t_, (_uid,))
        db.execute("DELETE FROM assignments WHERE assessor_id=? OR subject_id=?", (_uid, _uid))
        db.execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id=?)",
                   (_uid,))
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id=?)",
                   (_uid,))
        db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN "
                   "(SELECT id FROM pm_kpi_targets WHERE subject_id=?)", (_uid,))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id=?", (_uid,))
        for t_ in ("pm_calibration_adjustments", "calibration_adjustments"):
            db.execute("DELETE FROM %s WHERE subject_id=? OR adjusted_by=?" % t_, (_uid, _uid))
    if _old:   # they point at each other (manager, HOD): one statement, so the check runs once at its end
        db.execute("DELETE FROM users WHERE id IN (%s)" % ",".join("?" * len(_old)), _old)
    db.execute("DELETE FROM cycles WHERE code LIKE 'ZZDS-%'")
    db.commit()
    NOW = a._today_myt().year
    C_DONE = db.execute("INSERT INTO cycles(code, name, is_active, year, half, ends_on) VALUES ('ZZDS-DONE', ?, 0, ?, 2, ?)",
                        ("ZZDS %d Year-End" % (NOW - 1), NOW - 1, "%d-12-31" % (NOW - 1))).lastrowid
    C_YE = db.execute("INSERT INTO cycles(code, name, is_active, year, half, ends_on) VALUES ('ZZDS-YE', ?, 0, ?, 2, ?)",
                      ("ZZDS %d Year-End" % NOW, NOW, "%d-12-31" % NOW)).lastrowid
    C_MY = db.execute("INSERT INTO cycles(code, name, is_active, year, half, ends_on) VALUES ('ZZDS-MY', ?, 0, ?, 1, ?)",
                      ("ZZDS %d Mid-Year" % NOW, NOW, "%d-06-30" % NOW)).lastrowid

    def person(n, **kw):
        cols = {"username": "zzds-%d" % n, "full_name": "ZZDS Person%d Lim" % n, "password_hash": "x", "role": "user",
                "employee_id": "ZZDS-%d" % n, "business_group": BG, "company": CO, "department": "ZZDS Dept %d" % n,
                "job_title": "Planner", "job_grade": 14, "years_of_service": 3}
        cols.update(kw)
        return db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                          tuple(cols.values())).lastrowid
    MGR = person(1, department="ZZDS Operations")
    SUBJ = person(2, manager_id=MGR, hod_id=MGR)
    OTHER = person(3)
    BUC = person(4, buceo_bg=BG, buceo_company=CO)
    BGC = person(5, bgceo_bg=BG)
    # SUBJ in the closed cycle: KPI results in, a 360 given (1 of 2), competency reviewed, the next year's plan shared,
    # their line manager's approval, the release
    T1 = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
                    "company, rate1, rate2, rate3, rate4, rate5) VALUES (?,?,'ZZDS Output',100,'more','approved',?,?,1,2,3,4,5)",
                    (C_DONE, SUBJ, BG, CO)).lastrowid
    db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (T1, MGR))
    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft, admin_filled, submitted_at) "
               "VALUES (?,4,?,0,0,?)", (T1, SUBJ, "%d-12-04 03:00:00" % (NOW - 1)))
    db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, acted_by, acted_at) VALUES (?,1,'confirm',?,?)",
               (T1, MGR, "%d-12-11 03:00:00" % (NOW - 1)))
    db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, submitted_at) "
               "VALUES (?,?,?,'peer','submitted',?)", (C_DONE, OTHER, SUBJ, "%d-11-20 03:00:00" % (NOW - 1)))
    db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) VALUES (?,?,?,'peer','pending')",
               (C_DONE, MGR, SUBJ))
    db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status, submitted_at, reviewed_at) VALUES (?,?,'reviewed',?,?)",
               (C_DONE, SUBJ, "%d-11-27 03:00:00" % (NOW - 1), "%d-12-05 03:00:00" % (NOW - 1)))
    IDP = db.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status, shared_at) VALUES (?,?,?,'shared',?)",
                     (NOW, C_DONE, SUBJ, "%d-12-14 03:00:00" % (NOW - 1))).lastrowid
    G1 = db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, action_experience) VALUES (?,1,'ZZDS Running a P&L',"
                    "'Shadow the budget cycle')", (IDP,)).lastrowid
    G2 = db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area) VALUES (?,2,'ZZDS Difficult conversations')", (IDP,)).lastrowid
    IDP_D = db.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status) VALUES (?,?,?,'draft')",
                       (NOW + 1, C_YE, SUBJ)).lastrowid
    GD = db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area) VALUES (?,1,'ZZDS Draft goal')", (IDP_D,)).lastrowid
    IDP_C = db.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status) VALUES (?,?,?,'closed')",
                       (NOW - 1, C_DONE, SUBJ)).lastrowid
    GC = db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area) VALUES (?,1,'ZZDS Closed goal')", (IDP_C,)).lastrowid
    db.execute("INSERT INTO result_releases(cycle_id, subject_id, kind, released_at) VALUES (?,?,'pm',?)",
               (C_DONE, SUBJ, "%d-01-15 03:00:00" % NOW))
    # MGR led: their team review (the approval above) and their department review, submitted
    db.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, locked_at) "
               "VALUES (?,'hod',?,?,'ZZDS dept',?)", (C_DONE, str(MGR), BG, "%d-12-15 03:00:00" % (NOW - 1)))
    db.commit()

E = H.client_as(a, SUBJ)
O = H.client_as(a, OTHER)


def cycle_not_started():
    """Plan check-ins open between cycles only (Chris, 2026-10-12). The harness's active cycle is open, so the check-in
    checks run with it not started yet; restore_cycle() puts it back (the teardown does too)."""
    with a.app.app_context():
        db_ = a.get_db()
        act = db_.execute("SELECT id, starts_on FROM cycles WHERE is_active=1").fetchone()
        if act:
            db_.execute("UPDATE cycles SET starts_on='2999-01-01 09:00' WHERE id=?", (act["id"],))
            db_.commit()
        return (act["id"], act["starts_on"]) if act else None


def restore_cycle(saved):
    if saved:
        with a.app.app_context():
            db_ = a.get_db()
            db_.execute("UPDATE cycles SET starts_on=? WHERE id=?", (saved[1], saved[0]))
            db_.commit()


_ACT = None
with a.app.app_context():
    _r = a.get_db().execute("SELECT id, starts_on FROM cycles WHERE is_active=1").fetchone()
    _ACT = (_r["id"], _r["starts_on"]) if _r else None


def ctx_user(uid):
    """A request context signed in as uid, for the helpers that build url_for links."""
    rc = a.app.test_request_context("/dashboard")
    rc.push()
    from flask import session as _ss
    _ss["user_id"] = uid
    db_ = a.get_db()
    return rc, db_, dict(db_.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


# ---------------------------------------------------------------------------
s.section("the check-in table: one dated row per check-in")
with a.app.app_context():
    db = a.get_db()
    cols = [r[1] for r in db.execute("PRAGMA table_info(pm_idp_checkins)")]
    idx = [r[1] for r in db.execute("PRAGMA index_list(pm_idp_checkins)")]
s.check("pm_idp_checkins holds the goal, the person, the status, the note and when",
        {"goal_id", "subject_id", "status", "note", "created_at"} <= set(cols) and "idx_pm_idp_checkins" in idx, cols)
_src = H.source(a)
s.check("a new table starts from each goal's latest progress, so nobody's last check-in disappears",
        "INSERT INTO pm_idp_checkins(goal_id, subject_id, status, note, created_at)" in _src
        and "COALESCE(g.progress_at, i.updated_at, i.shared_at, i.created_at" in _src)
s.check("the classic progress route logs its check-in too, so the history is whole whichever way it came",
        _src.count("_idp_checkin_record(db, goal_id, u[\"id\"])") == 2)

# ---------------------------------------------------------------------------
s.section("POST /me/plan/checkin: their own shared plan only, between cycles")
_paused = cycle_not_started()
r = E.post("/me/plan/checkin", data={"csrf_token": "tok", "goal_id": G1, "status": "in_progress",
                                     "note": "ZZDS shadowed the Q3 budget cycle"})
j = r.get_json() or {}
pg = ((j.get("panel") or {}).get("plan") or {}).get("goals") or []
g1 = next((g for g in pg if g.get("id") == G1), {})
s.check("a check-in on their own shared plan saves, and answers with the panel", r.status_code == 200 and j.get("ok")
        and (j.get("panel") or {}).get("year") == NOW, (r.status_code, j.get("error")))
s.check("...the goal now reads In progress, with the check-in at the top of its history",
        g1.get("status") == "in_progress" and (g1.get("checkins") or [{}])[0].get("label") == "In progress"
        and (g1.get("checkins") or [{}])[0].get("note") == "ZZDS shadowed the Q3 budget cycle", g1)
r2 = E.post("/me/plan/checkin", data={"csrf_token": "tok", "goal_id": G1, "status": "done", "note": ""})
g1b = next((g for g in (((r2.get_json() or {}).get("panel") or {}).get("plan") or {}).get("goals", []) if g["id"] == G1), {})
with a.app.app_context():
    db = a.get_db()
    n_rows = db.execute("SELECT COUNT(*) FROM pm_idp_checkins WHERE goal_id=?", (G1,)).fetchone()[0]
    gl = db.execute("SELECT progress_status, progress_note FROM pm_idp_goals WHERE id=?", (G1,)).fetchone()
s.check("a second check-in adds a row (history, newest first) and the goal keeps the latest",
        n_rows == 2 and [c["label"] for c in g1b.get("checkins", [])] == ["Done", "In progress"]
        and gl["progress_status"] == "done" and gl["progress_note"] is None, (n_rows, gl and tuple(gl)))
pl = ((r2.get_json() or {}).get("panel") or {}).get("plan") or {}
s.check("...the plan says it can take check-ins and when the last one was",
        pl.get("can_checkin") is True and bool(pl.get("last_checkin")), (pl.get("can_checkin"), pl.get("last_checkin")))
_bad = E.post("/me/plan/checkin", data={"csrf_token": "tok", "goal_id": G1, "status": "nearly"})
s.check("an unknown status is refused (400)", _bad.status_code == 400)
_spoof = O.post("/me/plan/checkin", data={"csrf_token": "tok", "goal_id": G1, "status": "dropped"})
with a.app.app_context():
    n_after = a.get_db().execute("SELECT COUNT(*) FROM pm_idp_checkins WHERE goal_id=?", (G1,)).fetchone()[0]
s.check("SELF-SCOPED: another person's goal 404s and writes nothing", _spoof.status_code == 404 and n_after == 2,
        (_spoof.status_code, n_after))
s.check("a draft plan isn't agreed yet: 409", E.post("/me/plan/checkin", data={"csrf_token": "tok", "goal_id": GD,
                                                                                "status": "in_progress"}).status_code == 409)
s.check("last year's plan, closed without being shared, is history: 409", E.post("/me/plan/checkin", data={"csrf_token": "tok", "goal_id": GC,
                                                                           "status": "done"}).status_code == 409)
s.check("an admin has no plan: 404", H.client_as(a, SU["id"]).post("/me/plan/checkin", data={
    "csrf_token": "tok", "goal_id": G1, "status": "done"}).status_code == 404)
s.check("a crafted goal id 404s", E.post("/me/plan/checkin", data={"csrf_token": "tok", "goal_id": 99999999,
                                                                    "status": "done"}).status_code == 404)
s.check("the route is the plan module's (classified, so switching Development plans off closes it)",
        a.MODULE_ENDPOINTS.get("my_plan_checkin") == "idp")
_pp = E.get("/me/plan?year=%d" % NOW).get_json() or {}
s.check("the plan panel names the statuses a check-in can pick, and each goal carries its id and status",
        [p_["key"] for p_ in _pp.get("progress", [])] == list(a.PM_IDP_PROGRESS_KEYS)
        and all("id" in g and "status" in g and "checkins" in g for g in (_pp.get("plan") or {}).get("goals", [])))
_pd = E.get("/me/plan?year=%d" % (NOW + 1)).get_json() or {}
s.check("...a draft plan takes no check-ins", (_pd.get("plan") or {}).get("can_checkin") is False)
restore_cycle(_paused)

s.section("while a cycle runs, the plan is read-only (Chris, 2026-10-12: check-ins only \"during the off cycle\")")
with a.app.app_context():
    _n0 = a.get_db().execute("SELECT COUNT(*) FROM pm_idp_checkins WHERE goal_id=?", (G1,)).fetchone()[0]
_run = E.post("/me/plan/checkin", data={"csrf_token": "tok", "goal_id": G1, "status": "in_progress", "note": "x"})
with a.app.app_context():
    _n1 = a.get_db().execute("SELECT COUNT(*) FROM pm_idp_checkins WHERE goal_id=?", (G1,)).fetchone()[0]
s.check("a check-in while the cycle runs is refused (409) and writes nothing",
        _run.status_code == 409 and _n1 == _n0 and "between cycles" in ((_run.get_json() or {}).get("error") or ""),
        (_run.status_code, _n0, _n1))
_pr = (E.get("/me/plan?year=%d" % NOW).get_json() or {}).get("plan") or {}
s.check("...the panel's plan takes none and says they are paused (no Check in button)",
        _pr.get("can_checkin") is False and _pr.get("checkin_paused") is True, (_pr.get("can_checkin"), _pr.get("checkin_paused")))
s.check("...the classic progress route refuses one too",
        H.source(a).count("if not plan_checkin_open(db, u):") == 2)
rc, db, su = ctx_user(SUBJ)
try:
    _pc = a.dash_plan_card(db, su)
    s.check("...and the plan card says check-ins open between cycles",
            _pc and not _pc["can_checkin"] and _pc["checkin_paused"], _pc and (_pc["can_checkin"], _pc["checkin_paused"]))
    s.check("...unless their results in it are released: that is between cycles for them (the record view)",
            a.plan_checkin_open(db, su) is False)
    db.execute("INSERT INTO result_releases(cycle_id, subject_id, kind, released_at) VALUES (?,?,'pot',datetime('now'))",
               (_ACT[0], SUBJ))
    _open_rel = a.plan_checkin_open(db, su)
    db.execute("DELETE FROM result_releases WHERE cycle_id=? AND subject_id=?", (_ACT[0], SUBJ))
    db.commit()
    s.check("...released -> open", _open_rel is True)
finally:
    rc.pop()
_js0 = H.source(a, "static/dashboard.js")
s.check("a cycle's record panel shows the plan only: no way into the plan panel or its check-ins from it",
        "all years, check in" not in _js0
        and "loadPlan(" not in _js0[_js0.find("function renderPresent"):_js0.find("function showList")]
        and "pl.checkin_paused" in _js0, None)

# ---------------------------------------------------------------------------
s.section("the state: running while something of an open cycle is ahead of them, else the record")
rc, db, su = ctx_user(SUBJ)
try:
    cyc_open = {"id": C_DONE, "starts_on": None, "name": "x"}
    cyc_later = {"id": C_YE, "starts_on": "2999-01-01 09:00", "name": "x"}
    P_, ACT, NOACT = {"title": "x"}, {"acts": [{"title": "x"}]}, {"acts": []}
    s.check("no AI+ check-in for them (no panel) -> record", a.dash_mode(db, su, None, ACT, cyc_open) == "record")
    s.check("a cycle that hasn't opened yet -> record", a.dash_mode(db, su, P_, ACT, cyc_later) == "record")
    s.check("their results released and nothing waiting on them -> record",
            a.dash_mode(db, su, P_, NOACT, cyc_open) == "record")
    s.check("results released but something still waits on them -> running",
            a.dash_mode(db, su, P_, ACT, cyc_open) == "running")
    so = dict(db.execute("SELECT * FROM users WHERE id=?", (OTHER,)).fetchone())
    s.check("an open cycle with nothing released to them -> running", a.dash_mode(db, so, P_, NOACT, cyc_open) == "running")
finally:
    rc.pop()

# ---------------------------------------------------------------------------
s.section("the record view: the last cycle's journey, what happened at each step and when")
rc, db, su = ctx_user(SUBJ)
try:
    st = a.dash_journey_done(db, su, C_DONE)
    names = [x["name"] for x in st]
    by = {x["name"]: x for x in st}
    s.check("their steps in order: own parts, the line manager's review, the release",
            names == ["KPI Check-in", "360 Feedback", "Competency", "Career Plan", "Your review", "Results released"], names)
    s.check("...each says what happened and when, from the rows each step writes",
            by["KPI Check-in"]["word"] == "Submitted" and by["KPI Check-in"]["when"] == "4 Dec %d" % (NOW - 1)
            and by["360 Feedback"]["count"] == "1 of 2" and by["Competency"]["word"] == "Reviewed"
            and by["Career Plan"]["count"] == "%d plan" % NOW and by["Your review"]["word"] == "Approved"
            and by["Results released"]["when"] == "15 Jan %d" % NOW, [(x["name"], x["word"], x["line"]) for x in st])
    s.check("...never a calibrating tier's name or a band on the employee's own journey",
            not any(x["who"] in ("You lead",) for x in st) and "HOD" not in str(st) and "BU CEO" not in str(st))
    so = dict(db.execute("SELECT * FROM users WHERE id=?", (OTHER,)).fetchone())
    s.check("a cycle that holds nothing of theirs has no journey", a.dash_journey_done(db, so, C_DONE) == [])
    _paused = cycle_not_started()
    a.g.pop("_active_cycle", None)   # cached per request
    pc = a.dash_plan_card(db, su)
    restore_cycle(_paused)
    a.g.pop("_active_cycle", None)
    s.check("this year's plan for the record view: its goals, where each is, the last check-in",
            pc and pc["year"] == NOW and pc["can_checkin"] and [g["area"] for g in pc["goals"]][:2]
            == ["ZZDS Running a P&L", "ZZDS Difficult conversations"] and pc["goals"][0]["label"] == "Done"
            and pc["goals"][1]["last"] == "no check-in yet", pc)
finally:
    rc.pop()
rc, db, mu = ctx_user(MGR)
try:
    st = a.dash_journey_done(db, mu, C_DONE)
    by = {x["name"]: x for x in st}
    s.check("a leader's journey adds what they led: their team review and their department review, with when",
            by.get("Team review", {}).get("word") == "Done" and by["Team review"]["count"] == "1 person"
            and by.get("Department review", {}).get("word") == "Submitted"
            and by["Department review"]["when"] == "15 Dec %d" % (NOW - 1), [(x["name"], x["line"]) for x in st])
    led = a.dash_led(db, mu, C_DONE, st)
    s.check("What you led lists them, and how many of their team checked in on their plans this quarter",
            led and {"k": "Team review · 1 person", "v": "Done 11 Dec %d" % (NOW - 1)} in led["rows"]
            and any(r_["k"] == "Your team's plans checked in this quarter" and r_["v"] == "1 of 1" for r_ in led["rows"]),
            led and led["rows"])
finally:
    rc.pop()
_orig, _orig_r = a.final_result, a.released_final_band
try:
    # the calibrated final band, whether or not HR has released it: nothing here is released
    a.final_result = lambda db_, p_, cid_, kind_, ov_map=None: ({"band": {OTHER: "AE", SUBJ: "ME"}[p_["id"]]}
                                                                  if p_["id"] in (OTHER, SUBJ) else None)
    a.released_final_band = lambda db_, p_, cid_, kind_: None
    with a.app.app_context():
        db = a.get_db()
        ppl = [dict(r_) for r_ in db.execute("SELECT * FROM users WHERE id IN (?,?,?)", (SUBJ, OTHER, MGR))]
        t_ = a._dash_band_tally(db, ppl, C_DONE)
        a.final_result = lambda db_, p_, cid_, kind_, ov_map=None: None
        t0 = a._dash_band_tally(db, ppl, C_DONE)
finally:
    a.final_result, a.released_final_band = _orig, _orig_r
s.check("a leader's scope is counted from the CALIBRATED final bands, released or not (Chris, 2026-10-10: only the "
        "employee waits for HR) -- 2 of 3 have a band here, counts and %",
        t_ and t_["total"] == 2 and {b["band"]: b["n"] for b in t_["bands"]} == {"UA": 0, "BE": 0, "ME": 1, "AE": 1, "OU": 0}
        and {b["band"]: b["pct"] for b in t_["bands"]}["AE"] == 50 and t0 is None, (t_, t0))

# ---------------------------------------------------------------------------
s.section("a BU CEO's Where your BU is: each axis locked, ready or not -- never a wait")
rc, db, bu = ctx_user(BUC)
try:
    cy = dict(db.execute("SELECT * FROM cycles WHERE id=?", (C_YE,)).fetchone())
    b0 = a.dash_bu_status(db, bu, cy)
    s.check("with no department review in: both axes 'Not ready to lock', saying they can lock without them",
            b0 and [x["state"] for x in b0["axes"]] == ["waiting", "waiting"] and b0["n_depts"] == 1
            and "you can lock without them" in b0["axes"][0]["line"] and b0["depts"][0]["pm"] is None, b0)
    db.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, locked_at) "
               "VALUES (?,'hod',?,?,'d',datetime('now'))", (C_YE, str(MGR), BG))
    db.execute("INSERT INTO calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, locked_at) "
               "VALUES (?,'buceo',?,?,'b',datetime('now'))", (C_YE, CO, BG))
    b1 = a.dash_bu_status(db, bu, cy)
    s.check("every department review in -> 'Ready to lock'; the BU's own lock -> 'Locked <date>'",
            [x["state"] for x in b1["axes"]] == ["ready", "locked"] and b1["axes"][1]["word"].startswith("Locked ")
            and b1["depts"][0]["pm"], [x["word"] for x in b1["axes"]])
    bmy = a.dash_bu_status(db, bu, dict(db.execute("SELECT * FROM cycles WHERE id=?", (C_MY,)).fetchone()))
    s.check("at Mid-Year there's no BU calibration: Where your BU is counts the department reviews in (Chris, 2026-10-13)",
            bmy and bmy.get("mid_year") and [x["label"] for x in bmy["axes"]] == ["Department reviews"], bmy and bmy["axes"])
    s.check("...and nobody but a BU CEO gets it", a.dash_bu_status(db, dict(
        db.execute("SELECT * FROM users WHERE id=?", (SUBJ,)).fetchone()), cy) is None)
    db.rollback()
finally:
    rc.pop()

# ---------------------------------------------------------------------------
s.section("BU CEO and BG CEO between cycles; someone not in this cycle's own review (boards H, I, K, L-N)")
with a.app.app_context():
    db = a.get_db()
    db.execute("INSERT INTO calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, locked_at) "
               "VALUES (?,'buceo',?,?,'b',?)", (C_DONE, CO, BG, "%d-12-22 03:00:00" % (NOW - 1)))
    # the BG CEO's lock made every band final: one row per person on the BG tier (what _tb_pin_bands writes)
    S_PM = db.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, locked_at) "
                      "VALUES (?,'bgceo',?,?,'g',?)", (C_DONE, BG, BG, "%d-01-08 03:00:00" % NOW)).lastrowid
    S_POT = db.execute("INSERT INTO calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, locked_at) "
                       "VALUES (?,'bgceo',?,?,'g',?)", (C_DONE, BG, BG, "%d-01-08 03:00:00" % NOW)).lastrowid
    for uid_, pm_, pot_ in ((SUBJ, "AE", "High"), (OTHER, "ME", "Mid"), (MGR, "BE", "Low")):
        db.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band, "
                   "justification, adjusted_by, seen_band, pinned) VALUES (?,?,?,?,'',?,?,'x')", (S_PM, uid_, pm_, pm_, BGC, pm_))
        db.execute("INSERT INTO calibration_adjustments(session_id, subject_id, original_band, adjusted_band, "
                   "justification, adjusted_by, seen_band, pinned) VALUES (?,?,?,?,'',?,?,'x')", (S_POT, uid_, pot_, pot_, BGC, pot_))
    db.execute("INSERT INTO talent_box_bu_locks(period_id, cycle_id, business_group, company, locked_at) VALUES (?,?,?,?,?)",
               (C_DONE, C_DONE, BG, CO, "%d-01-06 03:00:00" % NOW))
    db.commit()
rc, db, bgu = ctx_user(BGC)
try:
    box = a.dash_bg_box(db, bgu, C_DONE)
    whole = box and box["units"][0]
    s.check("a BG CEO's Talent Box reads the bands their lock made final: the whole group first, then each business unit",
            box and [x["name"] for x in box["units"]] == ["Whole group", CO] and whole["people"] == 3
            and box["n_locked"] == 1 and box["units"][1]["locked"] == "6 Jan %d" % NOW, box and [x["name"] for x in box["units"]])
    g = {(r_["pot"], b): c["n"] for r_ in whole["rows"] for b, c in zip(("Low", "Mid", "High"), r_["cells"])}
    cats = {c["name"]: c["n"] for c in whole["cats"]}
    s.check("...each person in their box (performance x potential), each box in its category",
            g[("High", "High")] == 1 and g[("Mid", "Mid")] == 1 and g[("Low", "Low")] == 1 and sum(g.values()) == 3
            and cats == {"Super Star": 1, "Star": 0, "Solid Core": 1, "PIP/Improvement": 1}, cats)
    s.check("...nothing for a cycle they locked no box in", a.dash_bg_box(db, bgu, C_MY) is None)
    bst = a.dash_journey_done(db, bgu, C_DONE)
    s.check("a BG CEO's journey: the Talent Box they locked, then when their group's results went out (they have none)",
            [x["name"] for x in bst] == ["Talent Box", "Results released"] and bst[-1]["count"] == "to your group"
            and bst[-1]["when"] == "15 Jan %d" % NOW, [(x["name"], x["line"]) for x in bst])
    lc = a.dash_led_cycles(db, bgu)
    s.check("the cycles they led, for a history with no rows of their own",
            lc and lc[0]["name"] == "ZZDS %d Year-End" % (NOW - 1) and "1 business unit" in lc[0]["line"], lc)
    cy = dict(db.execute("SELECT * FROM cycles WHERE id=?", (C_YE,)).fetchone())
    g0 = a.dash_bg_status(db, bgu, cy)
    s.check("Where the group is (running): a business unit is calibrating until its BU CEO locks both axes",
            g0 and g0["units"][0]["name"] == CO and g0["units"][0]["state"] == "busy" and g0["ready"] == 0, g0)
    for t_ in ("pm_calibration_sessions", "calibration_sessions"):
        db.execute("INSERT INTO %s(cycle_id, tier, scope_key, business_group, scope_label, locked_at) VALUES "
                   "(?,'buceo',?,?,'b',datetime('now'))" % t_, (C_YE, CO, BG))
    g1 = a.dash_bg_status(db, bgu, cy)
    db.execute("INSERT INTO talent_box_bu_locks(period_id, cycle_id, business_group, company, locked_at) VALUES "
               "(?,?,?,?,datetime('now'))", (C_YE, C_YE, BG, CO))
    g2 = a.dash_bg_status(db, bgu, cy)
    s.check("...ready to lock once both are locked, and Locked once the Talent Box is",
            g1["units"][0]["state"] == "ready" and g1["ready"] == 1 and g2["units"][0]["state"] == "locked"
            and g2["units"][0]["word"].startswith("Locked "), (g1["units"][0]["word"], g2["units"][0]["word"]))
    gmy = a.dash_bg_status(db, bgu, dict(db.execute("SELECT * FROM cycles WHERE id=?", (C_MY,)).fetchone()))
    s.check("...at Mid-Year it counts department reviews in, nothing to lock; for anyone but a BG CEO, there's nothing",
            gmy and gmy["mid_year"] and gmy["units"][0]["word"].endswith(" in") and gmy["locked"] == 0
            and a.dash_bg_status(db, dict(db.execute("SELECT * FROM users WHERE id=?", (SUBJ,)).fetchone()), cy) is None,
            gmy)
    db.rollback()
    # someone not in this cycle's own review
    yday = {"id": C_YE, "name": "ZZDS %d Year-End" % NOW, "starts_on": "%d-07-01" % NOW, "created_at": None}
    st_out = {"participant": False}
    nu = dict(db.execute("SELECT * FROM users WHERE id=?", (MGR,)).fetchone())
    nu.update(joined_date="%d-09-01" % NOW, confirmation_date=None)
    team_ = {"people": 5, "turn": 3, "parts": [{"turn": [{"name": "a"}, {"name": "b"}, {"name": "c"}],
                                                 "wait": [{"name": "d"}], "name": "KPI review"}], "url": "/review/journey?view=team"}
    ni = a.dash_not_in(db, nu, st_out, yday, team_, [], None)
    s.check("not in this cycle's own review: why (joined after it opened), and their team's state",
            ni and ni["why"] == "you joined after it opened" and ni["team"] == {"people": 5, "turn": 3, "wait": 1, "done": 1}
            and "Your team's review · 5 people" in ni["yours"], ni)
    nu.update(joined_date=None, confirmation_date="%d-08-15" % NOW)
    s.check("...confirmed after it opened says so", a.dash_not_in(db, nu, st_out, yday, None, [], None)["why"]
            == "you were confirmed after it opened")
    nu.update(confirmation_date=None, years_of_service=0.4)
    s.check("...not confirmed yet: on probation", a.dash_not_in(db, nu, st_out, yday, None, [], None)["why"]
            == "you're still on probation")
    s.check("...nothing for a participant, or for a BG CEO (their part is always the team and the Talent Box)",
            a.dash_not_in(db, nu, {"participant": True}, yday, None, [], None) is None
            and a.dash_not_in(db, bgu, st_out, yday, None, [], None) is None)
    rl = a.dash_rail(db, nu, None, team_ | {"parts": [{"name": "KPI review", "turn": [{"name": "a"}], "wait": [],
                                                        "url": "/review/journey?view=team"}]}, [], ni)
    s.check("...their rail starts with 'Your own review: not this cycle', ends with their team's results, and the "
            "count leaves the first out", rl and rl["steps"][0]["name"] == "Your own review"
            and rl["steps"][0]["word"] == "Not this cycle" and rl["steps"][-1]["name"] == "Your team's results"
            and rl["total"] == len(rl["steps"]) - 1, rl and [(x["name"], x["state"]) for x in rl["steps"]])
finally:
    rc.pop()
_orig_b, _orig_t = a.final_result, a.talent_status_for
_asked = []
try:
    _fb = {"pm": {SUBJ: "AE", OTHER: "ME"}, "pot": {SUBJ: "High"}}
    a.final_result = lambda db_, p_, cid_, kind_, ov_map=None: ({"band": _fb[kind_][p_["id"]]}
                                                                  if p_["id"] in _fb[kind_] else None)

    def _ts(db_, p_, cid_, released_only=True):
        _asked.append(released_only)
        return {"name": "Super Star", "slug": "super-star"} if (p_["id"] == SUBJ and not released_only) else None
    a.talent_status_for = _ts
    rc, db, buu = ctx_user(BUC)
    try:
        # the results wait for HR's release to leaders (Chris, 2026-10-12, replacing the 2026-10-10 rule)
        led0 = a.dash_led(db, buu, C_DONE, a.dash_journey_done(db, buu, C_DONE))
        for _sid in (SUBJ, OTHER):
            for _k in ("pm", "pot", "talent"):
                db.execute("INSERT OR IGNORE INTO leader_releases(cycle_id, subject_id, kind) VALUES (?,?,?)",
                           (C_DONE, _sid, _k))
        db.commit()
        led = a.dash_led(db, buu, C_DONE, a.dash_journey_done(db, buu, C_DONE))
        db.execute("DELETE FROM leader_releases WHERE cycle_id=? AND subject_id IN (?,?)", (C_DONE, SUBJ, OTHER))
        db.commit()
    finally:
        rc.pop()
finally:
    a.final_result, a.talent_status_for = _orig_b, _orig_t
s.check("a BU CEO's What you led, before HR releases the results to leaders: nothing counted, all waiting",
        led0 and led0["tiles"] and led0["tally"]["total"] == 0 and led0["tally"]["waiting"] == 2
        and led0["tally"]["gated"] and led0["pot"]["waiting"] == 1 and not led0["talent"],
        led0 and (led0["tally"], led0["pot"], led0["talent"]))
s.check("...once released to leaders: tiles with the department reviews in, performance and potential on their own "
        "rows, and the talent statuses (board H)",
        led and led["tiles"] and led["rows"][0] == {"k": "Department reviews", "v": "1 of 1 in"}
        and led["tally"]["total"] == 2 and led["pot"]["total"] == 1
        and {b["band"]: b["n"] for b in led["pot"]["bands"]} == {"Low": 0, "Mid": 0, "High": 1}
        and led["talent"] == [{"name": "Super Star", "n": 1}] and _asked and not any(_asked), (led, _asked[:3]))
s.check("...and the card counts their people, and how many are released to them (2026-10-12, board W1)",
        led0 and led and led0["people"] >= 2 and led["with_you"] >= led0["with_you"] + 2 and not led["at_once"],
        led0 and led and (led0["people"], led0["with_you"], led["with_you"]))
with a.app.app_context():
    db = a.get_db()
    CID2 = a.active_cycle_id(db)
    _prev2 = db.execute("SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (CID2,)).fetchone()
    db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'review', 0)", (CID2,))
    db.commit()
try:
    bhtml = H.client_as(a, BGC).get("/dashboard").get_data(as_text=True)
finally:
    with a.app.app_context():
        db = a.get_db()
        if _prev2 is None:
            db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (CID2,))
        else:
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key='review'", (_prev2[0], CID2))
        db.commit()
s.check("a BG CEO's record page: business units first, each a button that shows its Talent Box (board I)",
        'class="od-card od-boxu"' in bhtml and 'class="od-card od-boxg"' in bhtml and 'data-unit="all"' in bhtml
        and 'data-unit="u0"' in bhtml
        and 'data-unit-box="u0"' in bhtml and "Your business units" in bhtml and "Cycles you led" in bhtml, None)
_tpl2 = open(os.path.join(H.REPO, "templates", "dashboard.html"), encoding="utf-8").read()
_js2 = open(os.path.join(H.REPO, "static", "dashboard.js"), encoding="utf-8").read()
s.check("the page draws Where the group is, the not-in-this-cycle card, and the BU CEO's two tally rows; the client "
        "switches the box per business unit",
        "{% elif bg_status %}" in _tpl2 and "{% elif not_in %}" in _tpl2 and "{% set Q = rec['led']['pot'] %}" in _tpl2
        and 'document.querySelectorAll(".od-box-u[data-unit]")' in _js2
        and 'g.hidden = g.getAttribute("data-unit-box") !== k' in _js2)

# ---------------------------------------------------------------------------
s.section("the page: the record between cycles, and only AI+ links")
with a.app.test_request_context("/"):
    _ai = a._dash_ai_url
    s.check("an AI+ link is the review or its journey -- never a classic page",
            _ai("/review") and _ai("/review/journey?stage=account") and _ai("/review/setting")
            and not _ai("/reviewer") and not _ai("/performance") and not _ai("/calibration/hod/3")
            and not _ai("/promotion-nomination") and not _ai(""))
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    _prev = db.execute("SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (CID,)).fetchone()
    db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'review', 0)", (CID,))
    db.commit()
try:
    html_run = E.get("/dashboard").get_data(as_text=True)   # the record view while a cycle still runs company-wide
    _paused = cycle_not_started()
    html = E.get("/dashboard").get_data(as_text=True)
    mhtml = H.client_as(a, MGR).get("/dashboard").get_data(as_text=True)
finally:
    restore_cycle(_paused)
    with a.app.app_context():
        db = a.get_db()
        if _prev is None:
            db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (CID,))
        else:
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key='review'", (_prev[0], CID))
        db.commit()
s.check("with no AI+ check-in open, the page is the record: the last cycle's journey, its results, this year's plan",
        "od-rail is-past" in html and ("ZZDS %d Year-End: your journey through it" % (NOW - 1)) in html
        and 'class="od-card od-res"' in html and ("This year: your %d plan" % NOW) in html
        and 'class="od-card od-here' not in html, None)
s.check("...each step opens that cycle's record in the panel; the plan's button opens the Career Plan panel",
        'class="od-sn od-snb" data-record="%d"' % C_DONE in html
        and ('data-panel="plan" data-arg="%d"' % NOW) in html and "Check in on your plan" in html)
s.check("...while a cycle still runs, the plan card says check-ins open between cycles, and only opens the plan",
        "Check-ins open between cycles." in html_run and "Check in on your plan" not in html_run
        and ('data-panel="plan" data-arg="%d"' % NOW) in html_run)
s.check("...and the AI read of the cycle is asked for once, when it isn't cached",
        ('data-snap-url="/me/record/%d/snapshot"' % C_DONE) in html)
s.check("a leader's record shows What you led, with their plan as one line under their results",
        'class="od-card od-led"' in mhtml and "Department review" in mhtml and "your journey through it, and what you led"
        in mhtml, (re.findall(r'<h2 id="od-rail-h">([^<]+)', mhtml), 'od-card od-here' in mhtml, 'od-led' in mhtml))
s.check("...and its See your people button opens their people in the panel (2026-10-12, canvas board W1)",
        'data-panel="led"' in mhtml and "See your people" in mhtml)
_classic_found = []
for _h in (html, mhtml):
    _body = _h[_h.find('class="od"'):]
    _classic_found += [x for x in re.findall(r'href="([^"#]+)"', _body) if not (x == "/review" or x.startswith("/review/")
                                                                             or x.startswith("/review?")
                                                                             or x.startswith("mailto:"))]   # Help's address
s.check("LINK AUDIT (record view): nothing on either page opens a classic page", not _classic_found, _classic_found)
s.check("no fallback to-do list and no team doors anywhere on the template",
        "od-todo" not in open(os.path.join(H.REPO, "templates", "dashboard.html"), encoding="utf-8").read()
        and "team_doors" not in open(os.path.join(H.REPO, "templates", "dashboard.html"), encoding="utf-8").read())

# ---------------------------------------------------------------------------
s.section("the client: dropdowns, the check-in, one button width")
_js = open(os.path.join(H.REPO, "static", "dashboard.js"), encoding="utf-8").read()
_css = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
s.check("the year / cycle pick is one dropdown (grouped by year for the 360, which steps newer / older too)",
        "function picker(label, items, stepper)" in _js and 'picker("Plan year"' in _js and 'picker("Cycle"' in _js
        and "group: c.year" in _js and "pills(" not in _js and ".od-pill" not in _css)
s.check("...Escape closes an open dropdown before it closes the panel, and a click outside closes it",
        _js.index("if (menuOpen) { e.preventDefault(); closeMenu(true); return; }") < _js.index("e.preventDefault(); close(); return;")
        and "!menuOpen.menu.contains(e.target)" in _js)
s.check("a check-in posts to /me/plan/checkin and redraws from the answer; person-written text set as text",
        'fetch("/me/plan/checkin"' in _js and "renderPlan(x.j.panel)" in _js and ".innerHTML = c.note" not in _js
        and 'el("span", "n", c.note || "")' in _js)
s.check("the record view asks for the AI read only when it isn't cached", ".od-snap[data-load='1']" in _js)
_tpl = open(os.path.join(H.REPO, "templates", "dashboard.html"), encoding="utf-8").read()
s.check("the BU card lists every department, scrolling inside the card (Chris: 'if there are more departments, we "
        "should do interscroll'), long names cut with the full name on hover",
        '"depts": depts,' in _src and 'class="od-bu-body"' in _tpl and 'title="{{ d[\'name\'] }}"' in _tpl
        and ".od-bu-body { max-height: 128px; overflow-y: auto; overflow-x: hidden; }" in _css and "od-bu-more" not in _tpl)
s.check("...a scrolling list never scrolls sideways, and scrollbars everywhere are thin and quiet (Chris, 2026-10-16: 'use "
        "more modern minimalistic scroll')",
        H.cv("* { scrollbar-width: thin; scrollbar-color: #c9cede transparent; }") in _css
        and "*::-webkit-scrollbar { width: 6px; height: 6px; }" in _css
        and H.cv("*::-webkit-scrollbar-thumb { background: #c9cede; border-radius: 999px; }") in _css)
s.check("every button in Your next step's rows is the same width, so their edges line up (Chris: 'consistent width'; "
        "the calmer view, 2026-10-16, makes them as wide as one shared minimum rather than 280px)",
        ".od-nrow .od-btn-ai, .od-nrow .od-btn-nv { flex: none; min-height: 30px; min-width: 212px;" in _css
        and ".od-act .od-btn-ai { min-height: 38px; flex: 0 0 280px" not in _css)
s.check("no 'You lead' calibration doors under Your tools: What needs you opens the leader view, which holds both parts "
        "(Chris, 2026-10-11: 'for BUCEO view, why is there a Your Lead under the Your tools box?')",
        "lead_doors" not in _src and "lead_doors" not in _tpl and "od-tool-list" not in _tpl and ".od-tgrp" not in _css)
s.check("the results card's two buttons are the same width, side by side or stacked",
        ".od-res-acts .od-btn-nv { flex: 0 0 212px; box-sizing: border-box; }" in _css)
s.check("...the check-in summary under them too, the same width (Chris, 2026-10-11: 'your AI check-in summary "
        "box width should match with review with AI')",
        ".od-calm .od-ln .od-btn-ai { flex: none; min-height: 30px; min-width: 212px;" in _css
        and "here['summary']['url'] }}\">" in _tpl
        and "' is-outline' }} is-sm\" href=\"{{ here['summary']" not in _tpl)

# ---------------------------------------------------------------------------
s.section("a person with two seats: the highest seat's dashboard, and nothing says 'your BG CEO' to the BG CEO")
# Chris, 2026-10-22: "even a BGCEO is also a BUCEO for 2 BUs, the dsahboard view will stay as BGCEO". The cards are
# stubbed to sentinels so the check is the choice itself, read through the real _dash_context.
_stubs = {k: getattr(a, k) for k in ("dash_mode", "cycle_awaiting_open", "dash_bg_status", "dash_group_status",
                                     "dash_bu_status")}
_BG_CARD, _BU_CARD = {"scope": "bg", "units": [], "sentinel": "bg"}, {"units": [], "sentinel": "bu"}
try:
    a.dash_mode = lambda *x, **k: "running"
    a.cycle_awaiting_open = lambda *x, **k: False
    a.dash_group_status = lambda *x, **k: None
    a.dash_bu_status = lambda *x, **k: _BU_CARD
    a.dash_bg_status = lambda *x, **k: _BG_CARD          # a BG CEO who also holds a BU CEO seat
    rc, db_, u_ = ctx_user(MGR)
    try:
        _both = a._dash_context(db_, u_)
    finally:
        rc.pop()
    a.dash_bg_status = lambda *x, **k: None              # a BU CEO and nothing above
    rc, db_, u_ = ctx_user(MGR)
    try:
        _bu_only = a._dash_context(db_, u_)
    finally:
        rc.pop()
finally:
    for k, v in _stubs.items():
        setattr(a, k, v)
s.check("a BG CEO who is also a BU CEO gets the BG CEO's card only (it covers every unit in their group)",
        (_both.get("bg_status") or {}).get("sentinel") == "bg" and _both.get("bu_status") is None,
        (_both.get("bg_status"), _both.get("bu_status")))
s.check("...while a BU CEO with nothing above keeps 'Where your BU is'",
        (_bu_only.get("bu_status") or {}).get("sentinel") == "bu" and _bu_only.get("bg_status") is None,
        (_bu_only.get("bg_status"), _bu_only.get("bu_status")))
_dsrc = H.source(a)
_dsrc = _dsrc[_dsrc.index("def _dash_context("):][:12000]
s.check("...and between cycles the learning picker follows the same seat (a BU picker only without a BG one)",
        '"buceo" in tiers and leader_can(u, "bu.view", db) and not _bg_ok' in _dsrc)
with a.app.app_context():
    db = a.get_db()
    _self = {"id": 0, "bgceo_bg": BG, "buceo_bg": BG, "buceo_company": CO}
    _other = {"id": 0, "bgceo_bg": "ZZDS Another Group", "buceo_bg": BG, "buceo_company": CO}
    _plain = {"id": 0, "bgceo_bg": None, "buceo_bg": BG, "buceo_company": CO}
    s.check("a BU CEO whose unit sits in the group they are BG CEO of reads 'your Talent Box', never 'your BG CEO'; "
            "anyone else keeps 'your BG CEO'",
            a._bu_ceo_is_bg_ceo(db, _self) and not a._bu_ceo_is_bg_ceo(db, _other) and not a._bu_ceo_is_bg_ceo(db, _plain)
            and a._calib_done_say(db, _self) == a._CALIB_DONE_SAY_SELF and "your BG CEO" not in a._CALIB_DONE_SAY_SELF
            and a._calib_done_say(db, _plain) == a._CALIB_DONE_SAY)

with a.app.app_context():
    db = a.get_db()
    for _uid in (SUBJ, OTHER, MGR, BUC, BGC):
        db.execute("DELETE FROM pm_idp_checkins WHERE subject_id=?", (_uid,))
        db.execute("DELETE FROM pm_idp_goals WHERE idp_id IN (SELECT id FROM pm_idp WHERE subject_id=?)", (_uid,))
        db.execute("DELETE FROM pm_idp WHERE subject_id=?", (_uid,))
        for t_ in ("result_releases", "talent_releases", "tc_assessments"):
            db.execute("DELETE FROM %s WHERE subject_id=?" % t_, (_uid,))
        db.execute("DELETE FROM assignments WHERE assessor_id=? OR subject_id=?", (_uid, _uid))
        db.execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id=?)",
                   (_uid,))
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id=?)",
                   (_uid,))
        db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN "
                   "(SELECT id FROM pm_kpi_targets WHERE subject_id=?)", (_uid,))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id=?", (_uid,))
        db.execute("DELETE FROM record_snapshots WHERE subject_id=?", (_uid,))
    for _cid in (C_DONE, C_YE, C_MY):
        db.execute("DELETE FROM pm_calibration_adjustments WHERE session_id IN (SELECT id FROM pm_calibration_sessions "
                   "WHERE cycle_id=?)", (_cid,))
        db.execute("DELETE FROM calibration_adjustments WHERE session_id IN (SELECT id FROM calibration_sessions "
                   "WHERE cycle_id=?)", (_cid,))
        db.execute("DELETE FROM talent_box_bu_locks WHERE cycle_id=?", (_cid,))
        db.execute("DELETE FROM pm_calibration_sessions WHERE cycle_id=?", (_cid,))
        db.execute("DELETE FROM calibration_sessions WHERE cycle_id=?", (_cid,))
    db.execute("DELETE FROM users WHERE id IN (?,?,?,?,?)", (SUBJ, OTHER, MGR, BUC, BGC))
    if _ACT:
        db.execute("UPDATE cycles SET starts_on=? WHERE id=?", (_ACT[1], _ACT[0]))
    db.execute("DELETE FROM cycles WHERE id IN (?,?,?)", (C_DONE, C_YE, C_MY))
    db.commit()

sys.exit(s.done())
