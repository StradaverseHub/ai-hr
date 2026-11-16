"""Career Plan: a report who didn't share by their own deadline reads "Didn't submit" and no longer holds the line manager
back (Chris, 2026-11-08, wording "Didn't submit"). A line manager can do nothing on an unshared plan (no on-behalf for Career
Plans), so before this the row read "Not shared yet" forever: the dashboard's Team review step waited for ever and the line
manager's feedback card never appeared.

What this suite holds, on _journey_team_reports(.., "plan_review") and what reads it:
  * the report's own window (idp_self) OPEN: "Not shared yet", not done, no action
  * CLOSED: "Didn't submit", done, no action -- for no plan row at all AND for a draft with goals (a draft is private)
  * CLOSED but a late pass is held, or an open reopen: stays "Not shared yet" (they may still share it)
  * a SHARED plan after the close is unchanged ("Needs your remark", with its action)
  * a person whose user role has no Career Plan is never "Didn't submit" (_behalf_part_closed's idp_self check)
  * the team summary's didnt_submit count, the manager agent's plan data flag (`missed`) and prompt line, the dashboard's
    "All done · N didn't submit" line
  * _feedback_finished(lm) is False before the close and True once the missed plan is the only thing left
Synthetic ZZ9DS-* people only; the windows, rows and modules are put back."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Career Plan: Didn't submit after the report's own deadline")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG, CO = "ZZDS Group", "ZZDS U1"
DIDNT, NOTSH = "Didn't submit", "Not shared yet"
_real = {k: getattr(a, k) for k in ("_review_manages_team", "_journey_team_live_stages", "cycle_row_is_early_year")}


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9DS-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM late_passes WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM submission_reopens WHERE subject_id IN (%s)" % ph, ul)
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
    WIN0 = [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (CID,))]
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL, starts_on=COALESCE(starts_on, '2026-01-01') "
               "WHERE id=?", (CID,))
    for k in ("review", "pm", "tm", "idp"):   # a deleted cycle_modules row must go back: only set what is there, restore below
        if db.execute("SELECT 1 FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k)).fetchone():
            db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key=?", (CID, k))
        else:
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, k))
    YEAR = a.pm_idp_plan_year(a.active_pm_period(db))

    def mk(eid, mgr=None, role_row=True):
        return db.execute(
            "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, department, "
            "job_title, job_grade, manager_id, confirmation_date, years_of_service) "
            "VALUES (?,?,'x','user',?,?,?,'ZZDS Dept','ZZDS Officer','14',?,'2020-01-01',4.0)",
            (eid.lower(), "ZZ DS " + eid[-3:], eid, BG, CO, mgr)).lastrowid

    def plan(uid, status, goals=True):
        pid = db.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status, shared_at) VALUES (?,?,?,?,?)",
                         (YEAR, CID, uid, status, None if status == "draft" else "2026-11-01 00:00:00")).lastrowid
        if goals:
            db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area) VALUES (?,1,'ZZDS goal')", (pid,))

    LM = mk("ZZ9DS-LM")
    NOPLAN = mk("ZZ9DS-NP", mgr=LM)       # never opened a plan
    DRAFT = mk("ZZ9DS-DR", mgr=LM)        # a draft with a goal (private to them)
    SHARED = mk("ZZ9DS-SH", mgr=LM)       # shared, no remark yet
    LATE = mk("ZZ9DS-LT", mgr=LM)         # a draft, holds a late pass
    REOP = mk("ZZ9DS-RP", mgr=LM)         # a draft, holds an open reopen
    LM2 = mk("ZZ9DS-L2")                  # a manager whose ONLY report missed it
    ONLY = mk("ZZ9DS-ON", mgr=LM2)
    plan(DRAFT, "draft")
    plan(SHARED, "shared")
    plan(LATE, "draft")
    plan(REOP, "draft")
    db.execute("INSERT INTO late_passes(cycle_id, user_id, cell, subject_id, until_at, reason) "
               "VALUES (?,?,'idp_self',?,datetime('now','+2 days'),'ZZDS test')", (CID, LATE, LATE))
    db.execute("INSERT INTO submission_reopens(cycle_id, subject_id, part, actor_id, cell, reason) "
               "VALUES (?,?,'idp_self',?,'idp_self','ZZDS test')", (CID, REOP, REOP))
    db.commit()


def setwin(opens, closes):
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='idp_self'", (CID,))
        d.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,'idp_self',?,?)", (CID, opens, closes))
        d.commit()


def stamp(days):
    from datetime import timedelta
    return (a._now_myt() + timedelta(days=days)).strftime("%Y-%m-%d %H:%M")


def rows_for(uid):
    with a.app.test_request_context("/"):
        d = a.get_db()
        u = dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
        return {r["id"]: r for r in a._journey_team_reports(d, u, "plan_review")}


def fin(uid):
    with a.app.test_request_context("/"):
        d = a.get_db()
        return a._feedback_finished(d, dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()), CID, "lm")


a._review_manages_team = lambda db, u: True
a._journey_team_live_stages = lambda st, view=None: [{"key": "plan_review", "short": "Plan review", "module": "idp"}]
a.cycle_row_is_early_year = lambda p: False
try:
    s.section("their window is open: nothing changes")
    setwin(stamp(-5), stamp(5))
    r = rows_for(LM)
    s.check("fixture: the manager's list holds all five", {NOPLAN, DRAFT, SHARED, LATE, REOP} <= set(r), sorted(r))
    s.check("an open window: 'Not shared yet', not done, no action, for every unshared plan",
            all(r[i]["meta"] == NOTSH and not r[i]["done"] and not r[i]["action"] for i in (NOPLAN, DRAFT, LATE, REOP)),
            {i: (r[i]["meta"], r[i]["done"]) for i in (NOPLAN, DRAFT, LATE, REOP)})
    s.check("...the manager is not finished (a line is waiting)", fin(LM) is False and fin(LM2) is False)

    s.section("their window has closed")
    setwin(stamp(-20), stamp(-2))
    r = rows_for(LM)
    s.check("no plan row: 'Didn't submit', done, no action", r[NOPLAN]["meta"] == DIDNT and r[NOPLAN]["done"]
            and not r[NOPLAN]["action"], r[NOPLAN])
    s.check("a draft plan (private, not shared): 'Didn't submit', done, no action", r[DRAFT]["meta"] == DIDNT
            and r[DRAFT]["done"] and not r[DRAFT]["action"], r[DRAFT])
    s.check("a late pass held: still 'Not shared yet', not done", r[LATE]["meta"] == NOTSH and not r[LATE]["done"], r[LATE])
    s.check("an open reopen: still 'Not shared yet', not done", r[REOP]["meta"] == NOTSH and not r[REOP]["done"], r[REOP])
    s.check("a SHARED plan after the close is unchanged: needs the manager's remark, with its action",
            r[SHARED]["meta"] == "Needs your remark" and not r[SHARED]["done"] and r[SHARED]["action"] == "Write your remark",
            r[SHARED])

    s.section("what reads the rows")
    with a.app.test_request_context("/"):
        d = a.get_db()
        u = dict(d.execute("SELECT * FROM users WHERE id=?", (LM,)).fetchone())
        summ = a._journey_team_summary(d, u, "plan_review")["rows"]
        data = a._journey_team_plan_data(d, u, DRAFT, "x")
        data_sh = a._journey_team_plan_data(d, u, SHARED, "x")
        data_lt = a._journey_team_plan_data(d, u, LATE, "x")
        prompt = a._journey_team_stage_task(d, u, "plan_review", DRAFT)
        prompt_sh = a._journey_team_stage_task(d, u, "plan_review", SHARED)
        prompt_lt = a._journey_team_stage_task(d, u, "plan_review", LATE)
        team = a.dash_team_card(d, dict(u), {"st": {"period": None}})
        u2 = dict(d.execute("SELECT * FROM users WHERE id=?", (LM2,)).fetchone())
        team2 = a.dash_team_card(d, u2, {"st": {"period": None}})
        step2 = next(x for x in a.dash_rail(d, u2, None, team2, [])["steps"] if x["name"] == "Team review")
        step1 = next(x for x in a.dash_rail(d, dict(u), None, team, [])["steps"] if x["name"] == "Team review")
    s.check("the team summary rows carry the status", {x["id"]: x["status"] for x in summ}[DRAFT] == DIDNT
            and {x["id"]: x["done"] for x in summ}[DRAFT] is True)
    s.check("the plan data says missed for a draft past the deadline, and not for a shared plan or a held late pass",
            data["missed"] is True and data_sh["missed"] is False and data_lt["missed"] is False,
            (data["missed"], data_sh["missed"], data_lt["missed"]))
    P = lambda x: x[0] if isinstance(x, tuple) else x
    s.check("the manager agent is told the deadline passed and nothing is theirs to do (not for a shared plan or a late pass)",
            "deadline has PASSED" in P(prompt) and "deadline has PASSED" not in P(prompt_sh)
            and "deadline has PASSED" not in P(prompt_lt) and "Group People" in P(prompt), P(prompt)[:200])
    s.check("the dashboard card counts the missed plans in its plan part, and as done",
            next(p for p in team["parts"] if p["key"] == "plan_review")["didnt"]
            == sum(1 for x in summ if x["status"] == DIDNT), [(p["key"], p.get("didnt")) for p in team["parts"]])
    s.check("a manager with someone still waiting does not read 'All done'", not step1["line"].startswith("All done"), step1)
    s.check("a manager whose only report missed: the step is 'All done · 1 didn't submit'",
            step2["state"] == "done" and step2["line"] == "All done · 1 didn't submit", step2)

    s.section("the feedback card: finished once the missed plan is all that is left")
    s.check("the manager with a shared plan still to remark is NOT finished", fin(LM) is False)
    s.check("the manager whose only report missed IS finished", fin(LM2) is True)
    setwin(stamp(-5), stamp(5))
    s.check("...and not before the close", fin(LM2) is False)

    s.section("a person whose role has no Career Plan is never 'Didn't submit'")
    setwin(stamp(-20), stamp(-2))
    with a.app.test_request_context("/"):
        d = a.get_db()
        ok_before = a._behalf_part_closed(d, "idp_self", CID, ONLY)
        real = a.idp_participation
        a.idp_participation = lambda db_, u_, cycle=None: (False, "role")
        try:
            blocked = a._behalf_part_closed(d, "idp_self", CID, ONLY)
        finally:
            a.idp_participation = real
    s.check("closed for a participant: True; without a Career Plan role: False", ok_before is True and blocked is False,
            (ok_before, blocked))

    s.section("falsify the guard")
    real = a._behalf_part_closed
    a._behalf_part_closed = lambda db_, cell, cid, sid: False
    try:
        r = rows_for(LM)
        s.check("with the guard off the row reads 'Not shared yet' again and the manager is held back",
                r[NOPLAN]["meta"] == NOTSH and not r[NOPLAN]["done"] and fin(LM2) is False, r[NOPLAN])
    finally:
        a._behalf_part_closed = real
    s.check("guard restored: 'Didn't submit' is back", rows_for(LM)[NOPLAN]["meta"] == DIDNT and fin(LM2) is True)
finally:
    for k, v in _real.items():
        setattr(a, k, v)
    with a.app.app_context():
        d = a.get_db()
        _cleanup(d)
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for w in WIN0:
            d.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w), ",".join("?" * len(w))), list(w.values()))
        d.execute("UPDATE cycles SET kind=?, half=?, starts_on=?, min_job_grade=? WHERE id=?",
                  (CYC0["kind"], CYC0["half"], CYC0["starts_on"], CYC0["min_job_grade"], CID))
        for k in ("review", "pm", "tm", "idp"):
            if k in MODS0:
                d.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (MODS0[k], CID, k))
            else:
                d.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k))
        d.commit()
sys.exit(s.done())
