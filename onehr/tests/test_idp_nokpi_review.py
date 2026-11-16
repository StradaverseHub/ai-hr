"""The line manager remarks on and approves the Career Plan of a report with no KPI line between them (the 2026-10-24
developer handoff, 12.2). Since Chris's 2026-10-19 "all employees should be able to get access to and fill in the IDP",
_idp_review_subject_ids lists a line manager's direct reports who write a plan, KPI line or not, and the IDP pages open
with _idp_is_reviewer_of; but the two writers, _idp_plan_comment_write and _idp_approve_plan, gated on the KPI approver
chain alone, so the remark and Approve plan answered 403 for exactly the people the review lists. Help's team_nokpi
promises it works.

What this suite holds, for reports with no pm_kpi_targets row:
  * the Team card's remark box (/review/team/idp-remark) and Approve plan (/idp/team/<id>/career-conversation, fetch);
  * the classic page's comment form and Approve plan (no fetch header: a redirect);
  * the manager agent's comment_plan and close_plan tools;
  * another line manager's report is still refused on every one of those doors, its plan untouched;
  * Help's quick answer still says yes.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Career Plan review: a report with no KPI line is the line manager's to remark on and approve")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG, CO = "ZZNK Group", "ZZNK U1"
FETCH = {"X-Requested-With": "fetch"}
REMARK = "A clear plan: the costing goal builds on a strength, and I'll give them the budget work to practise on."


def post(client, url, headers=None, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form, headers=headers or {})


def plan_row(sid):
    with a.app.app_context():
        r = a.get_db().execute("SELECT status, manager_comment FROM pm_idp WHERE plan_year=? AND subject_id=?",
                               (YR, sid)).fetchone()
        return (r["status"], r["manager_comment"]) if r else None


with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    # a Year-End with the review on and the plan review open (no dates: open all cycle)
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=12, open_by_date=0, "
               "starts_on=COALESCE(starts_on, '2026-01-01') WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='idp_review'", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','evidence','pm','tm','idp')",
               (CID,))
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', '1')")
    db.commit()
    PERIOD = dict(a.active_pm_period(db))
    YR = a.pm_idp_plan_year(PERIOD)

    def mk(eid, mgr=None, confirmed=True):
        return db.execute(
            "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_title, job_grade, manager_id, confirmation_date, years_of_service) "
            "VALUES (?,?,'x','user',?,?,?,'ZZNK Dept','ZZNK Officer','14',?,?,?)",
            (eid.lower(), "ZZ NK " + eid[-2:], eid, BG, CO, mgr, "2020-01-01" if confirmed else None,
             4.0 if confirmed else 0.5)).lastrowid
    LM = mk("ZZ9NK-LM")                     # a line manager who approves no KPI line
    CARD = mk("ZZ9NK-CA", mgr=LM)           # confirmed, taking part, no KPI line: the card's doors
    CLASSIC = mk("ZZ9NK-CL", mgr=LM, confirmed=False)   # not confirmed (so no KPI line): the classic page's doors
    AGENT = mk("ZZ9NK-AG", mgr=LM)          # the agent's tools
    OTHER = mk("ZZ9NK-OT")                  # another line manager
    THEIRS = mk("ZZ9NK-TH", mgr=OTHER)      # their report, no KPI line either
    for sid in (CARD, CLASSIC, AGENT, THEIRS):
        db.execute("DELETE FROM pm_idp WHERE plan_year=? AND subject_id=?", (YR, sid))
        iid = db.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status, shared_at) "
                         "VALUES (?,?,?,'shared',datetime('now'))", (YR, CID, sid)).lastrowid
        db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, action_experience, target_date) "
                   "VALUES (?,1,'Cost Analysis','Build the quarterly breakdown','2027-06-30')", (iid,))
    db.commit()
    LMU = dict(db.execute("SELECT * FROM users WHERE id=?", (LM,)).fetchone())
    OTU = dict(db.execute("SELECT * FROM users WHERE id=?", (OTHER,)).fetchone())

s.section("the case: reports with no KPI line, whom the review lists for their line manager")
with a.app.test_request_context("/"):
    db = a.get_db()
    n_kpi = db.execute("SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id IN (?,?,?,?)",
                       (CARD, CLASSIC, AGENT, THEIRS)).fetchone()[0]
    s.check("none of the four has a KPI line, so no approver chain reaches them", n_kpi == 0, n_kpi)
    s.check("...and the line manager approves none of them",
            not any(a._pm_is_approver_of(db, LMU, x, CID) for x in (CARD, CLASSIC, AGENT)))
    subj = a._idp_review_subject_ids(db, LMU, CID)
    s.check("the review lists the line manager's three, not the other manager's report",
            {CARD, CLASSIC, AGENT} <= set(subj) and THEIRS not in subj, subj)
    s.check("_idp_is_reviewer_of agrees: theirs yes, the other report no",
            all(a._idp_is_reviewer_of(db, LMU, x, CID) for x in (CARD, CLASSIC, AGENT))
            and not a._idp_is_reviewer_of(db, LMU, THEIRS, CID))
    s.check("the line manager owns each plan's one remark", all(a._idp_remark_owner(db, x) == LM
                                                                for x in (CARD, CLASSIC, AGENT)))
    s.check("the plan review window is open", a.window_closed(db, "idp_review", subject_id=CARD) is None)

s.section("the Team card: the remark box, then Approve plan")
C = H.client_as(a, LM)
r = post(C, "/review/team/idp-remark", report=str(CARD), remark=REMARK)
s.check("the remark saves (200, ok), not 403", r.status_code == 200 and (r.get_json() or {}).get("ok") is True,
        (r.status_code, (r.get_json() or {}).get("ok"), (r.get_json() or {}).get("error")))
s.check("...and is on the plan", plan_row(CARD) == ("shared", REMARK), plan_row(CARD))
with a.app.test_request_context("/"):
    s.check("...the card offers Approve plan now", a._journey_team_plan_data(a.get_db(), LMU, CARD, "R")["can_approve"])
r = post(C, "/idp/team/%d/career-conversation" % CARD, headers=FETCH)
s.check("Approve plan closes it (JSON ok), not 403", r.status_code == 200 and (r.get_json() or {}).get("ok") is True,
        (r.status_code, r.get_json()))
s.check("...the plan is closed with the remark kept", plan_row(CARD) == ("closed", REMARK), plan_row(CARD))
s.check("...logged as the plan's close by the line manager, 'approved'",
        H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='idp_close' AND target_user_id=? AND user_id=? "
                 "AND detail=?", (CARD, LM, "%s: approved" % YR)) == 1)

s.section("the classic page: the comment form, then Approve plan")
r = post(C, "/idp/team/%d/review" % CLASSIC, comment=REMARK)
s.check("the comment saves and redirects back to the plan, not 403",
        r.status_code in (302, 303) and "/idp/team/%d" % CLASSIC in r.headers.get("Location", ""),
        (r.status_code, r.headers.get("Location")))
s.check("...and is on the plan", plan_row(CLASSIC) == ("shared", REMARK), plan_row(CLASSIC))
r = post(C, "/idp/team/%d/career-conversation" % CLASSIC)
s.check("the classic Approve plan (no fetch header) closes it and redirects, not 403",
        r.status_code in (302, 303) and plan_row(CLASSIC) == ("closed", REMARK), (r.status_code, plan_row(CLASSIC)))

s.section("the manager agent: comment_plan, then close_plan")
with a.app.test_request_context("/"):
    db = a.get_db()
    out = a._mgr_tool_comment_plan(db, LMU, None, AGENT, {"comment": REMARK})
    s.check("comment_plan saves the overall remark", out.get("ok") is True and plan_row(AGENT) == ("shared", REMARK), out)
    out = a._mgr_tool_close_plan(db, LMU, None, AGENT, {})
    s.check("close_plan approves it", out.get("ok") is True and plan_row(AGENT) == ("closed", REMARK), out)

s.section("another line manager's report is still refused, on every door")
before = plan_row(THEIRS)
r = post(C, "/review/team/idp-remark", report=str(THEIRS), remark=REMARK)
s.check("the card's remark box: refused", r.status_code in (403, 404) and not (r.get_json() or {}).get("ok"),
        r.status_code)
r = post(C, "/idp/team/%d/career-conversation" % THEIRS, headers=FETCH)
s.check("the card's Approve plan: 403", r.status_code == 403, r.status_code)
r = post(C, "/idp/team/%d/review" % THEIRS, comment=REMARK)
s.check("the classic comment form: 403", r.status_code == 403, r.status_code)
r = post(C, "/idp/team/%d/career-conversation" % THEIRS)
s.check("the classic Approve plan: 403", r.status_code == 403, r.status_code)
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("the writers themselves refuse it (forbidden)",
            (a._idp_plan_comment_write(db, LMU, PERIOD, THEIRS, REMARK)[1] or {}).get("reason") == "forbidden"
            and (a._idp_approve_plan(db, LMU, PERIOD, THEIRS)[1] or {}).get("reason") == "forbidden")
    s.check("the agent's close_plan refuses it", a._mgr_tool_close_plan(db, LMU, None, THEIRS, {}).get("ok") is False)
s.check("...and their plan is as it was: shared, no remark", plan_row(THEIRS) == before == ("shared", None),
        (before, plan_row(THEIRS)))

s.section("their own line manager may (the same rule from the other side)")
C2 = H.client_as(a, OTHER)
r = post(C2, "/review/team/idp-remark", report=str(THEIRS), remark=REMARK)
s.check("the other line manager saves the remark on their own report", r.status_code == 200, r.status_code)
r = post(C2, "/idp/team/%d/career-conversation" % THEIRS, headers=FETCH)
s.check("...and approves it", r.status_code == 200 and plan_row(THEIRS) == ("closed", REMARK),
        (r.status_code, plan_row(THEIRS)))
r = post(C2, "/review/team/idp-remark", report=str(CARD), remark="Not mine to write.")
s.check("...but not the first line manager's report", r.status_code in (403, 404), r.status_code)

s.section("Help's quick answer")
q = a.HELP_QA.get("team_nokpi")
s.check("team_nokpi still says the line manager reviews it either way", q and q[1].startswith("Yes.")
        and "either way" in q[1], q)

sys.exit(s.done())
