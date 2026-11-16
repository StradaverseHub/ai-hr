"""Nobody reviews the Executive Chairman's direct reports' competency or Career Plan while his tick for it is off, and their own
submitted competency self-assessment counts (Chris, 2026-11-06: "B: nobody reviews", then "Approve, self counts"). The twin of
the 3 Nov KPI rule (tests/test_chair_nomod.py).

What this suite holds:
  * the rule (_chair_norev_id and its readers _tc_chair_unreviewed / _idp_chair_unreviewed, the batched _..._ids sets and the SQL
    fragments): flag on, chair seated, that tick off, line manager is the chair, who is not them. Unchanged with the tick on, with
    the flag off, with nobody seated and for a report of any other manager
  * the lists: the chair, his delegate, a matrix manager and every other manager list none of his reports' competency or Career
    Plan while the ticks are off, and the chair lists them again with the ticks on (falsified); a manager who reached them by
    another path (a left-out chair's line, a KPI line's approver) is stopped on the subject side
  * every writer refuses, through the real routes (with the CSRF token in the form) and the shared functions and the chat
    tools: competency calls, section and overall remarks, approve, bulk approve, assessing on their behalf; the plan remark, the
    career comment, the approval; and nothing is written. With the tick on the chair writes the same calls again (falsified)
  * SELF COUNTS, read time only: a covered person's SUBMITTED self-assessment is the competency half of their potential (equal
    to what a reviewed one with the same levels gives), is final for the HOD's review, counts in the rating record's approved
    score, the skill map and the Career Plan's technical gaps; a person nobody is exempted for still needs the review (their
    potential is the 360 alone). Nothing is ever stored as 'reviewed': switch the tick back on and the rule follows
  * the counts and words: the leader progress email's competency part leaves them out, admin Progress reads them final (not "with
    manager"), the person page, their own card and record, the sign-off words, the chair settings wording, the KB and Help words
  * population reads stay batched
Synthetic ZZ9NR people only; a fresh_db suite, so Suite.done() puts the scratch copy back."""
import contextlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Nobody reviews the chair's reports' competency or Career Plan; their self-assessment counts")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
os.environ["ONEHR_CHAIR"] = "1"
SU, _BGA, _E = H.actors(a)
SRC = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
BG, CO, DEPT = "ZZ9NR Group", "ZZ9NR Unit", "ZZ9NR Dept"


def run(fn, path="/"):
    """fn(db) in a request of its own (each request has its own per-request caches)."""
    with a.app.test_request_context(path):
        return fn(a.get_db())


def put(key, val):
    def f(d):
        if val is None:
            d.execute("DELETE FROM app_settings WHERE key=?", (key,))
        else:
            d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (key, str(val)))
        d.commit()
    run(f)


def seat(chair, deleg, ticks=()):
    put("exec_chair_id", chair)
    put("exec_chair_delegate_id", deleg)
    put("exec_chair_team", json.dumps({k: (k in ticks) for k in ("moderate", "behalf", "competency", "plan")}))


@contextlib.contextmanager
def rule_off(part):
    """FALSIFY: the rule's one switch (_chair_norev_id) answers 'does not apply' for `part`: every reader goes back to what it was."""
    real = a._chair_norev_id
    a._chair_norev_id = lambda db=None, p="competency": None if p == part else real(db, p)
    try:
        yield
    finally:
        a._chair_norev_id = real


# ---------------------------------------------------------------------------------------------------------- the people
ids = {}
with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL, no_potential=0 WHERE id=?", (CID,))
    db.commit()
    db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_results', "
               "'2000-01-01 00:00', '2099-12-31 23:59')", (CID,))
    PERIOD = dict(a.active_pm_period(db))   # after the cycle became a Year-End: the plan year follows it
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))

    def mk(tag, mgr=None):
        eid = "ZZ9NR-" + tag
        ids[tag] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
            "job_title, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', 'user', ?,?,?,?, 'ZZ Analyst', '14', "
            "'2020-01-01', ?)", (eid.lower(), "ZZ NR " + tag, eid, BG, CO, DEPT, ids.get(mgr))).lastrowid
    mk("CH")            # the Executive Chairman
    mk("DL", "CH")      # his delegate: a report of the chair, as X0007 is of X0003
    mk("R1", "CH")      # the chair's reports: R1 submitted + shared plan, R2 submitted, R3 not submitted
    mk("R2", "CH")
    mk("R3", "CH")
    mk("LM")            # another line manager
    mk("OR", "LM")      # a report of theirs, submitted and shared (the review is theirs)
    mk("RV", "LM")      # a report of theirs, REVIEWED with the same levels (the reference for "equals a reviewed one")
    mk("MX")            # a matrix manager: approves a KPI line of R1
    CH, DL, R1, R2, R3, LMX, OR, RV, MX = (ids[k] for k in ("CH", "DL", "R1", "R2", "R3", "LM", "OR", "RV", "MX"))
    skills = [r[0] for r in db.execute("SELECT id FROM tc_skills ORDER BY id LIMIT 2")]
    ASG = {}
    for who in (R1, R2, R3, DL, OR, RV):
        for sk in skills:
            ASG[(who, sk)] = db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) VALUES (?,?,?)",
                                        (CID, who, sk)).lastrowid
    AID = {w: [ASG[(w, sk)] for sk in skills] for w in (R1, R2, R3, DL, OR, RV)}
    ASSESS = {}
    for who, status in ((R1, "submitted"), (R2, "submitted"), (DL, "submitted"), (OR, "submitted"), (RV, "reviewed"),
                        (R3, "pending")):
        ASSESS[who] = db.execute(
            "INSERT OR REPLACE INTO tc_assessments(cycle_id, subject_id, status, submitted_at, reviewed_at, reviewed_by) "
            "VALUES (?,?,?,%s,%s,?)" % (("datetime('now')" if status != "pending" else "NULL"),
                                        ("datetime('now')" if status == "reviewed" else "NULL")),
            (CID, who, status, LMX if status == "reviewed" else None)).lastrowid
        if status != "pending":
            # the same levels for everyone: the first competency Demonstrate, the second Developing (their own answers)
            for aid, ans in zip(AID[who], ("yes", "no")):
                db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer) VALUES (?,?,?)", (ASSESS[who], aid, ans))
    YR = a.pm_idp_plan_year(PERIOD)
    for who in (R1, DL, OR):
        db.execute("DELETE FROM pm_idp WHERE plan_year=? AND subject_id=?", (YR, who))
        db.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status, shared_at) VALUES (?,?,?,'shared',"
                   "datetime('now'))", (YR, PERIOD["id"], who))

    def line(subject, name, chain_):
        t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company, "
                       "unit, rate1, rate2, rate3, rate4, rate5, status) VALUES (?,?,?,100,'more',?,?,'RM (mil)',1,2,3,4,5,'approved')",
                       (PERIOD["id"], subject, name, BG, CO)).lastrowid
        a._pm_set_moderator(db, t, chain_)
        return t
    LINE_R1 = line(R1, "ZZ NR line R1 (a legacy line that names the matrix manager)", [MX])
    db.commit()


def user(uid):
    return run(lambda d: dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


CHR, DLR, R1R, R2R, R3R, LMR, ORR, RVR, MXR = (user(x) for x in (CH, DL, R1, R2, R3, LMX, OR, RV, MX))
SUP = H.client_as(a, SU["id"])
# deterministic windows: the suite asks who may act, never whether a date has come
_real_window, _real_open, _real_behalf = a.window_closed, a.cycle_is_open, a._behalf_part_closed
a.window_closed = lambda *x, **k: None
a.cycle_is_open = lambda *x, **k: True
a._behalf_part_closed = lambda *x, **k: True   # R3 did not submit and their self-assessment has closed
COVERED = {R1, R2, R3, DL}
ALL_NR = {R1, R2, R3, DL, OR, RV}


def tc_ids(who, cid=None):
    return {r["id"] for r in run(lambda d: a._tc_reports_for(d, who, cid or CID))}


def idp_ids(who):
    return set(run(lambda d: a._idp_review_subject_ids(d, user(who), PERIOD["id"])))


def status_of(who):
    return H.one(a, "SELECT status FROM tc_assessments WHERE subject_id=? AND cycle_id=?", (who, CID))


def written():
    """Everything a review writes, as one comparable value."""
    return (H.rows(a, "SELECT assessment_id, assignment_id, manager_answer, manager_remark FROM tc_scores ORDER BY id"),
            H.rows(a, "SELECT id, status, manager_overall_remark, reviewed_by FROM tc_assessments ORDER BY id"),
            H.rows(a, "SELECT id, status, manager_comment, closed_by FROM pm_idp ORDER BY id"),
            H.rows(a, "SELECT id, manager_comment FROM pm_idp_goals ORDER BY id"))


BEFORE = written()
try:
    # ------------------------------------------------------------------------------------------------------------ the rule
    s.section("the rule: the chair's direct reports, the tick off")
    seat(CH, DL, ticks=())
    s.check("the chair's reports are covered for competency and for the Career Plan: a report, the delegate (a report too), a "
            "report who did not submit",
            all(run(lambda d, x=x: a._tc_chair_unreviewed(d, x)) and run(lambda d, x=x: a._idp_chair_unreviewed(d, x))
                for x in COVERED))
    s.check("...another manager's report, a matrix manager and the chair himself are not",
            not any(run(lambda d, x=x: a._tc_chair_unreviewed(d, x)) or run(lambda d, x=x: a._idp_chair_unreviewed(d, x))
                    for x in (OR, RV, MX, CH, LMX)))
    s.check("...the batched sets agree, in one read each", run(lambda d: a._tc_chair_unreviewed_ids(d)) == COVERED
            and run(lambda d: a._idp_chair_unreviewed_ids(d)) == COVERED)
    frag = run(lambda d: a._tc_chair_unreviewed_sql(d, "u"))
    s.check("...and the SQL fragment leaves exactly them out", frag == " AND COALESCE(u.manager_id, 0) != %d" % CH
            and {r[0] for r in H.rows(a, "SELECT u.id FROM users u WHERE u.employee_id LIKE 'ZZ9NR-%%'" + frag)}
            == {CH, LMX, OR, RV, MX})
    for tick, other in (("competency", "plan"), ("plan", "competency")):
        seat(CH, DL, ticks=(tick,))
        s.check("the two ticks are independent: with %s on, %s is still covered and %s is not" % (tick, other, tick),
                run(lambda d: a._chair_norev_ids(d, other)) == COVERED and run(lambda d: a._chair_norev_ids(d, tick)) == set())
    seat(CH, DL, ticks=("competency", "plan"))
    s.check("FALSIFY: with both ticks on nobody is covered (the rule is off)",
            run(lambda d: a._tc_chair_unreviewed_ids(d)) == set() and run(lambda d: a._idp_chair_unreviewed_ids(d)) == set()
            and run(lambda d: a._tc_chair_unreviewed_sql(d, "u")) == "" and not run(lambda d: a._tc_chair_unreviewed(d, R1)))
    seat(None, DL, ticks=())
    s.check("nobody seated: nobody is covered", run(lambda d: a._tc_chair_unreviewed_ids(d)) == set()
            and not run(lambda d: a._idp_chair_unreviewed(d, R1)))
    seat(CH, DL, ticks=())
    os.environ.pop("ONEHR_CHAIR", None)
    s.check("the flag off: nobody is covered, whatever is stored", run(lambda d: a._tc_chair_unreviewed_ids(d)) == set()
            and run(lambda d: a._idp_chair_unreviewed_ids(d)) == set() and not run(lambda d: a._tc_chair_unreviewed(d, R1)))
    os.environ["ONEHR_CHAIR"] = "1"
    with rule_off("competency"):
        s.check("FALSIFY: with the competency switch off the same calls say nobody is covered (the test sees the rule)",
                run(lambda d: a._tc_chair_unreviewed_ids(d)) == set() and not run(lambda d: a._tc_chair_unreviewed(d, R1))
                and run(lambda d: a._idp_chair_unreviewed_ids(d)) == COVERED)

    # ------------------------------------------------------------------------------------------------------------ the lists
    s.section("the lists: nobody lists them while the ticks are off; the chair does again with them on")
    seat(CH, DL, ticks=())
    s.check("the chair, his delegate, the matrix manager, another manager and the super admin list none of the chair's reports "
            "for competency review",
            all(not (tc_ids(w) & COVERED) for w in (CH, DL, MX, LMX, SU["id"])))
    s.check("...another manager still lists their own reports", tc_ids(LMX) == {OR, RV})
    s.check("...and for the Career Plan review (the matrix manager's KPI line included)",
            all(not (idp_ids(w) & COVERED) for w in (CH, DL, MX, LMX)) and idp_ids(LMX) >= {OR}
            and R1 in run(lambda d: a._pm_approver_subject_ids(d, MXR, PERIOD["id"])))
    s.check("...so the Team flags: no competency team, no plans to review, for the chair and the delegate",
            all(run(lambda d, w=w: a._hub_tc_flags(d, w, CID))[1] is False for w in (CHR, DLR))
            and not run(lambda d: a._idp_lm_has_plans(d, CHR)) and not run(lambda d: a._idp_lm_has_plans(d, DLR))
            and run(lambda d: a._tc_team_mids(d, CH)) == [] and run(lambda d: a._tc_team_mids(d, DL)) == [DL]
            and run(lambda d: a._hub_tc_flags(d, LMR, CID))[1] is True and run(lambda d: a._idp_lm_has_plans(d, LMR)))
    for w, label in ((CH, "chair"), (DL, "delegate")):
        with a.app.test_request_context("/"):
            a.session["user_id"] = w
            nav = a.inject_user()
        s.check("...and the nav's competency Team view is gone for the %s" % label, nav.get("nav_is_tc_manager") is False)
    pr = lambda who, subj: run(lambda d: a._idp_is_reviewer_of(d, who, subj, PERIOD["id"]))
    s.check("nobody is the reviewer of R1's plan: not the chair, the delegate, the other manager, nor the matrix manager who "
            "approves one of R1's KPI lines", not any(pr(w, R1) for w in (CHR, DLR, LMR, MXR)))
    s.check("...while the other manager still reviews their own report's plan", pr(LMR, OR) and not pr(MXR, OR))
    # the left-out-chair side door: a manager who would reach the chair's reports through _cycle_review_managers
    real_crm = a._cycle_review_managers
    a._cycle_review_managers = lambda db, m, part=None: [CH] if m == DL else real_crm(db, m, part)
    s.check("a manager who would reach the chair's line by another path (a left-out chair's reports go one level up) is stopped "
            "on the subject side: competency and plan",
            tc_ids(DL) == set() and idp_ids(DL) & {R1, R2, R3} == set() and not pr(DLR, R1))
    real_norev = a._chair_norev_sql
    a._chair_norev_sql = lambda db, part, alias="u": ""
    s.check("FALSIFY: without the subject-side fragment the same path reaches the chair's reports (the test sees it)",
            {R1, R2, R3} <= tc_ids(DL) and {R1, R2, R3} <= idp_ids(DL))
    a._chair_norev_sql = real_norev
    a._cycle_review_managers = real_crm
    # the chair's own drop and the delegate's lack of a stand-in, asked of the function directly
    s.check("the chair's own drop stands, and the delegate takes nothing over (no extra manager, for either part)",
            run(lambda d: a._chair_team_adjust(d, CH, "competency")) == (True, [])
            and run(lambda d: a._chair_team_adjust(d, CH, "plan")) == (True, [])
            and run(lambda d: a._chair_team_adjust(d, DL, "competency")) == (False, [])
            and run(lambda d: a._chair_team_adjust(d, DL, "plan")) == (False, [])
            and run(lambda d: a._chair_team_adjust(d, LMX, "competency")) == (False, [])
            and run(lambda d: a._cycle_review_managers(d, CH, "competency")) == []
            and run(lambda d: a._cycle_review_managers(d, CH, "plan")) == []
            and run(lambda d: a._cycle_review_managers(d, DL, "competency")) == [DL])
    # the subject side on its own: even if a manager list still held the chair (the drop switched off), his reports stay out
    real_adj = a._chair_team_adjust
    a._chair_team_adjust = lambda db, uid, part: (False, [])
    real_mids = a._tc_team_mids
    a._tc_team_mids = lambda db, uid: [CH]
    with a.app.test_request_context("/"):
        a.session["user_id"] = CH
        nav_sub = a.inject_user()
    s.check("the subject-side fragment alone keeps them out of every list, even with the chair's drop switched off: competency list, "
            "Team flag, nav, plan list, plan reviewer, plans-to-review",
            tc_ids(CH) == set() and run(lambda d: a._hub_tc_flags(d, CHR, CID))[1] is False
            and nav_sub.get("nav_is_tc_manager") is False and idp_ids(CH) & COVERED == set() and not pr(CHR, R1)
            and not run(lambda d: a._idp_lm_has_plans(d, CHR)))
    a._chair_team_adjust, a._tc_team_mids = real_adj, real_mids
    seat(CH, DL, ticks=("competency", "plan"))
    s.check("FALSIFY: with both ticks on the chair lists his reports again (competency and plan), and the delegate still does not",
            tc_ids(CH) == {R1, R2, R3, DL} and idp_ids(CH) >= {R1, DL} and tc_ids(DL) == set() and idp_ids(DL) & {R1, R2, R3} == set()
            and run(lambda d: a._hub_tc_flags(d, CHR, CID))[1] is True and run(lambda d: a._idp_lm_has_plans(d, CHR))
            and pr(CHR, R1) and not pr(DLR, R1))
    s.check("FALSIFY: ...and the matrix manager reaches R1's plan through the KPI line again (the exclusion was the rule's)",
            pr(MXR, R1) and R1 in idp_ids(MX))
    seat(CH, DL, ticks=())

    # ------------------------------------------------------------------------------------------------------------ the writers
    s.section("every writer refuses: the shared functions, the chat tools, the real routes (CSRF token in the form)")
    T = lambda who: (H.client_as(a, who))
    # the shared competency writers
    for label, who in (("the delegate", DLR), ("another manager", LMR), ("the matrix manager", MXR), ("the chair", CHR)):
        res = run(lambda d: a._tc_override_one(d, who, CID, R1, AID[R1][0], "yes", ""))
        s.check("%s: a competency call on R1 is refused (nothing written)" % label,
                res[0] is None and res[1]["reason"] in ("forbidden", "closed"), res)
    res = run(lambda d: a._tc_approve_assessment(d, DLR, CID, R1))
    s.check("the delegate's approve is refused", res[0] is None and res[1]["reason"] == "forbidden", res)
    res = run(lambda d: a._tc_manager_remark_write(d, DLR, CID, R1, "ZZ remark"))
    s.check("...so is the overall remark", res[0] is None and res[1]["reason"] == "forbidden", res)
    # assessing on their behalf (R3 did not submit; their self-assessment closed): nobody
    s.check("assessing R3 on their behalf: the shared gate says they are not someone whose competency you review, for the "
            "delegate, another manager and the chair",
            all("aren't someone whose competency you review" in (run(lambda d, w=w: a._tc_behalf_state(d, w, CID, R3)) or "")
                for w in (DLR, LMR, MXR))
            and run(lambda d: a._tc_behalf_state(d, CHR, CID, R3)) is not None)
    res = run(lambda d: a._tc_override_one(d, DLR, CID, R3, AID[R3][0], "yes", ""))
    s.check("...and the delegate's behalf call is refused (nothing written)", res[0] is None and res[1]["reason"] == "forbidden", res)
    res = run(lambda d: a._tc_approve_assessment(d, DLR, CID, R3))
    s.check("...so is the behalf lock", res[0] is None and res[1]["reason"] == "forbidden", res)
    # the Career Plan's writers
    for label, who in (("the delegate", DLR), ("another manager", LMR), ("the matrix manager (a KPI line's approver)", MXR),
                       ("the chair", CHR)):
        r1_ = run(lambda d: a._idp_plan_comment_write(d, who, PERIOD, R1, "ZZ plan remark"))
        r2_ = run(lambda d: a._idp_career_comment_write(d, who, PERIOD, R1, "ZZ career"))
        r3_ = run(lambda d: a._idp_approve_plan(d, who, PERIOD, R1))
        s.check("%s: the plan remark, the career comment and the approval on R1's plan are refused" % label,
                all(r[0] is None and r[1]["reason"] in ("forbidden", "closed") for r in (r1_, r2_, r3_)), (r1_, r2_, r3_))
    gate = run(lambda d: a._idp_manager_gate(d, MXR, R1, PERIOD))
    s.check("...the one manager gate (_idp_manager_gate) says forbidden for the KPI approver", gate[0] is None and gate[1][1] == 403, gate)
    # the chat tools
    tools = [("set a competency", lambda d, w: a._mgr_tool_set_competency(d, w, CID, R1, {"assignment_id": AID[R1][0], "answer": "demonstrate"})),
             ("approve the competencies", lambda d, w: a._mgr_tool_approve_competencies(d, w, CID, R1, {})),
             ("write the competency remark", lambda d, w: a._mgr_tool_set_competency_remark(d, w, CID, R1, {"remark": "ZZ"})),
             ("comment the plan", lambda d, w: a._mgr_tool_comment_plan(d, w, CID, R1, {"comment": "ZZ plan words"})),
             ("comment the career", lambda d, w: a._mgr_tool_comment_career(d, w, CID, R1, {"comment": "ZZ"})),
             ("close the plan", lambda d, w: a._mgr_tool_close_plan(d, w, CID, R1, {"comment": "ZZ"}))]
    for label, fn in tools:
        s.check("the manager agent's tool to %s refuses the delegate and the KPI approver" % label,
                all(run(lambda d, w=w: fn(d, w)).get("ok") is False for w in (DLR, MXR)),
                [run(lambda d, w=w: fn(d, w)) for w in (DLR, MXR)])
    # the real routes, with the CSRF token in the form
    def post(who, path, **form):
        form.setdefault("csrf_token", "tok")
        return T(who).post(path, data=form)
    routes = [("/technical/team/%d/autosave" % R1, {"assignment_id": AID[R1][0], "answer": "yes"}),
              ("/technical/team/%d/approve" % R1, {}),
              ("/technical/team/%d/overall-autosave" % R1, {"manager_remark": "ZZ remark"}),
              ("/technical/team/%d/section-autosave" % R1, {"category": "x", "manager_remark": "ZZ"}),
              ("/idp/team/%d/review" % R1, {"comment": "ZZ plan remark"}),
              ("/idp/team/%d/career-comment" % R1, {"comment": "ZZ"}),
              ("/idp/team/%d/career-conversation" % R1, {"comment": "ZZ", "conversation": "ZZ"})]
    for path, form in routes:
        codes = {lbl: post(w, path, **form).status_code for lbl, w in (("delegate", DL), ("manager", LMX), ("matrix", MX))}
        s.check("POST %s is refused for the delegate, another manager and the KPI approver (403)" % path,
                set(codes.values()) == {403}, codes)
    r = T(LMX).post("/review/team/approve-bulk", data={"csrf_token": "tok", "stage": "tm_review", "report_ids": [R1, OR]})
    res_ = {x["report_id"]: x for x in (r.get_json() or {}).get("results", [])}
    s.check("the bulk approve (another manager, who has a team) names R1 as not theirs, and tries only their own report",
            r.status_code == 200 and res_.get(R1, {}).get("error") == "not yours" and res_.get(OR, {}).get("error") != "not yours",
            (r.status_code, res_))
    s.check("...and the delegate has no Team view to approve from (404)",
            T(DL).post("/review/team/approve-bulk", data={"csrf_token": "tok", "stage": "tm_review", "report_ids": [R1]}).status_code
            == 404)
    run(lambda d: (d.execute("UPDATE tc_assessments SET status='submitted', reviewed_at=NULL, reviewed_by=NULL WHERE subject_id=?",
                             (OR,)), d.commit()))   # (OR's own review went through: put it back)
    s.check("nothing was written by any of it", written() == BEFORE)
    s.check("...and no assessment was ever stored as reviewed by the rule (R1, R2, R3, the delegate: as they were)",
            [status_of(x) for x in (R1, R2, R3, DL)] == ["submitted", "submitted", "pending", "submitted"])
    # FALSIFY: the chair with his ticks on writes the same calls
    seat(CH, DL, ticks=("competency", "plan", "behalf"))
    res = run(lambda d: a._tc_override_one(d, CHR, CID, R1, AID[R1][0], "yes", "ZZ call"))
    s.check("FALSIFY: with Review their competency on the chair's call on R1 is written", res[0] and res[0].get("ok"), res)
    res = run(lambda d: a._idp_plan_comment_write(d, CHR, PERIOD, R1, "ZZ chair plan remark"))
    s.check("FALSIFY: with Career Plan on the chair's plan remark is written", res[0] == {"ok": True}, res)
    s.check("FALSIFY: with Behalf on the behalf gate opens for the chair on R3 (nobody else's)",
            run(lambda d: a._tc_behalf_state(d, CHR, CID, R3)) is None
            and run(lambda d: a._tc_behalf_state(d, DLR, CID, R3)) is not None)
    r = T(CH).post("/review/team/approve-bulk", data={"csrf_token": "tok", "stage": "tm_review", "report_ids": [R2]})
    res_ = {x["report_id"]: x for x in (r.get_json() or {}).get("results", [])}
    s.check("FALSIFY: ...and the chair's bulk approve reaches R2 (approved, not 'not yours')",
            r.status_code == 200 and res_.get(R2, {}).get("error") != "not yours" and res_.get(R2, {}).get("approved") is True,
            (r.status_code, res_))
    run(lambda d: (d.execute("UPDATE tc_assessments SET status='submitted', reviewed_at=NULL, reviewed_by=NULL WHERE subject_id=?",
                             (R2,)), d.commit()))
    r = post(CH, "/technical/team/%d/overall-autosave" % R1, manager_remark="ZZ chair overall")
    s.check("FALSIFY: ...and so is his overall remark through the real route", r.status_code == 200, r.status_code)
    run(lambda d: (d.execute("UPDATE tc_scores SET manager_answer=NULL, manager_remark=NULL"), d.execute(
        "UPDATE tc_assessments SET manager_overall_remark=NULL"), d.execute("UPDATE pm_idp SET manager_comment=NULL"), d.commit()))
    seat(CH, DL, ticks=())
    s.check("put back: nothing of the falsification is left", written() == BEFORE)

    # ------------------------------------------------------------------------------------------------------------ self counts
    s.section("self counts: a covered person's submitted self-assessment stands in for a review, at read time")
    # a 360 average for the potential: the arithmetic is the same for a covered person and a reviewed one with the same levels
    AVG = 10.0
    comb = lambda subj: run(lambda d: a.combined_potential(d, user(subj), CID, AVG))
    c_cov, c_rv, c_orr = comb(R1), comb(RV), comb(OR)
    s.check("R1 (covered, submitted) has the competency half in their potential: a combined result, not the 360 alone",
            c_cov["source"] == "combined" and c_cov["pts_tech"] is not None and c_cov["max_tech"], c_cov)
    s.check("...equal to what a REVIEWED assessment with the same levels gives (score, share, parts, weights)",
            all(c_cov[k] == c_rv[k] for k in ("score", "max", "pct", "band_score", "pts_tech", "max_tech", "pct_tech", "c_tech",
                                               "c_360", "w_360", "w_tech", "self_score", "tech_self"))
            and c_cov["source"] == c_rv["source"] == "combined", (c_cov, c_rv))
    s.check("a NOT covered person (OR: submitted, their own manager has not reviewed) is the 360 alone, as before",
            c_orr["source"] == "360_only" and c_orr["score"] == AVG and c_orr["pts_tech"] is None, c_orr)
    s.check("tc_reviewed_score: a covered submitted one counts (self figure = approved figure), an uncovered one does not",
            run(lambda d: a.tc_reviewed_score(d, R1, CID))[1] is not None
            and run(lambda d: a.tc_reviewed_score(d, R1, CID)) == run(lambda d: a.tc_reviewed_score(d, RV, CID))
            and run(lambda d: a.tc_reviewed_score(d, OR, CID)) == (None, None, None)
            and run(lambda d: a.tc_reviewed_score(d, R3, CID)) == (None, None, None))
    s.check("R3 did not submit: no competency figure (as today), the 360 alone",
            comb(R3)["source"] == "360_only" and comb(R3)["pts_tech"] is None)
    comp = run(lambda d: a._pot_review_comp(d, CID, [R1, R2, R3, OR, RV]))
    s.check("the HOD's potential review: a covered submitted one is final, an uncovered one and a draft are not",
            a._pot_review_final(True, comp[R1]) and a._pot_review_final(True, comp[R2]) and a._pot_review_final(True, comp[RV])
            and not a._pot_review_final(True, comp[OR]) and not a._pot_review_final(True, comp[R3])
            and not a._pot_review_final(False, comp[R1]), comp)
    s.check("...and the status the calibration chat reads says 'reviewed' for them (the Self/LM columns follow)",
            comp[R1][0] == "reviewed" and comp[OR][0] == "submitted", comp)
    ev = run(lambda d: a._calib_tc_evidence(d, user(R1), CID))
    ev_o = run(lambda d: a._calib_tc_evidence(d, user(OR), CID))
    s.check("the calibration room's competency evidence reads R1 as final (their own answers, flagged) and OR as still to review",
            ev["status"] == "reviewed" and ev["nobody"] and ev["score"] is not None and ev["groups"]
            and ev_o["status"] == "submitted" and not ev_o["nobody"] and ev_o["score"] is None, (ev["status"], ev_o["status"]))
    plain = a._pot_summary_plain("Ava", {"valid": True, "raters": 3, "strong": [], "dev": [], "tc_status": ev["status"],
                                         "tc_nobody": ev["nobody"]})
    plain_o = a._pot_summary_plain("Ava", {"valid": True, "raters": 3, "strong": [], "dev": [], "tc_status": ev_o["status"],
                                           "tc_nobody": ev_o["nobody"]})
    s.check("the insight's summary says nobody reviews R1's (not 'not reviewed yet, so it doesn't count') and still says it for OR",
            "nobody reviews it" in plain and "doesn't count" not in plain and "doesn't count" in plain_o, (plain, plain_o))
    skm = lambda w: run(lambda d: a.tc_person_skill_map(d, w))
    s.check("the skill map counts the covered person's demonstrated competency and not an uncovered unreviewed one's",
            len(skm(R1)) == 1 and skm(R1) == skm(RV) and skm(OR) == {} and skm(R3) == {}, (skm(R1), skm(RV), skm(OR)))
    s.check("the rating record's approved score is R1's (status stays 'submitted' as stored)", (lambda row: row is not None)(
        run(lambda d: (a._rating_record_refresh(d, CID, [R1, OR], "norev_test"), d.commit(),
                       d.execute("SELECT tc_status, tc_approved_score, tc_self_score FROM rating_records WHERE cycle_id=? "
                                 "AND subject_id=?", (CID, R1)).fetchone())[2])))
    rr = {w: run(lambda d, w=w: d.execute("SELECT tc_status, tc_approved_score, tc_self_score, tc_max FROM rating_records "
                                          "WHERE cycle_id=? AND subject_id=?", (CID, w)).fetchone()) for w in (R1, OR)}
    s.check("...approved = self for R1 (a figure), none for OR; the stored status is still 'submitted' for both",
            rr[R1] and rr[R1]["tc_approved_score"] is not None and rr[R1]["tc_approved_score"] == rr[R1]["tc_self_score"]
            and rr[R1]["tc_status"] == "submitted" and rr[OR] and rr[OR]["tc_approved_score"] is None
            and rr[OR]["tc_status"] == "submitted", {k: dict(v) if v else v for k, v in rr.items()})
    seat(CH, DL, ticks=("competency",))
    c_on = comb(R1)
    comp_on = run(lambda d: a._pot_review_comp(d, CID, [R1]))
    s.check("FALSIFY: with Review their competency back on R1 needs the chair's review again: the 360 alone, not final, not in "
            "the skill map, no approved score, and nothing was ever stored as reviewed",
            c_on["source"] == "360_only" and not a._pot_review_final(True, comp_on[R1]) and skm(R1) == {}
            and run(lambda d: a.tc_reviewed_score(d, R1, CID)) == (None, None, None) and status_of(R1) == "submitted"
            and not ev_o["nobody"], (c_on["source"], comp_on))
    seat(CH, DL, ticks=())
    s.check("...and switched off again it follows at once", comb(R1)["source"] == "combined")
    ids_in = [R1, R2, R3, OR, RV, DL]
    q = {"n": 0}
    with a.app.test_request_context("/"):
        d = a.get_db()
        a._pot_review_comp(d, CID, ids_in[:1])   # warm the per-request caches first
        d.set_trace_callback(lambda sql: q.__setitem__("n", q["n"] + 1) if sql.lstrip().upper().startswith("SELECT") else None)
        a._pot_review_comp(d, CID, ids_in[:2])
        n2 = q["n"]; q["n"] = 0
        a._pot_review_comp(d, CID, ids_in)
        n6 = q["n"]
        d.set_trace_callback(None)
    s.check("population reads stay batched: the HOD review's competency read costs the same for 2 people as for 6",
            n2 == n6 and n6 <= 4, (n2, n6))

    # ------------------------------------------------------------------------------------------------------------ counts and words
    s.section("counts and words: they never read as waiting on the manager")
    cyc = run(lambda d: dict(d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()))
    people = {x: ("k", "k", "k") for x in ALL_NR}
    lp = run(lambda d: a.lp_person_parts(d, cyc, ["tc_approve", "tc_self"], people=people))
    s.check("the leader progress email's competency review part leaves the chair's reports out and keeps the others",
            set(lp["tc_approve"]) == {OR, RV} and lp["tc_approve"][OR][1] == 0 and lp["tc_approve"][RV][1] == 1, lp["tc_approve"])
    s.check("...while their own submission (tc_self) still counts them, done",
            lp["tc_self"][R1][1] == 1 and lp["tc_self"][R2][1] == 1 and lp["tc_self"][R3][1] == 0, lp["tc_self"])
    seat(CH, DL, ticks=("competency",))
    lp_on = run(lambda d: a.lp_person_parts(d, cyc, ["tc_approve"], people=people))
    s.check("FALSIFY: with the tick on they are counted as waiting for the chair again", {R1, R2, DL} <= set(lp_on["tc_approve"]),
            lp_on["tc_approve"])
    seat(CH, DL, ticks=())
    me = SU
    tcs, _e = run(lambda d: a._mod_tc_state(d, me, ALL_NR))
    s.check("admin Progress, Competency: R1 reads final (Submitted, final / complete), OR still reads With manager",
            tcs[R1]["stage"] == "complete" and tcs[R1]["state"] == "done" and "final" in tcs[R1]["label"].lower()
            and "nobody reviews" in tcs[R1]["detail"] and tcs[OR]["stage"] == "submitted" and tcs[OR]["label"] == "With manager"
            and tcs[R3]["stage"] != "complete" and tcs[RV]["stage"] == "complete" and tcs[RV]["label"] == "Reviewed",
            {k: (v["stage"], v["label"]) for k, v in tcs.items()})
    idps, _e = run(lambda d: a._mod_idp_state(d, me, ALL_NR))
    s.check("admin Progress, Career Plan: a covered shared plan reads as done, final (not 'the manager hasn't closed it'); "
            "another manager's reads as shared",
            idps[R1]["stage"] == "complete" and idps[R1]["state"] == "done" and "final" in idps[R1]["label"].lower()
            and idps[OR]["stage"] == "shared" and idps[OR]["state"] == "active", {k: (v["stage"], v["label"]) for k, v in idps.items()})
    seat(CH, DL, ticks=("competency", "plan"))
    tcs_on, _e = run(lambda d: a._mod_tc_state(d, me, ALL_NR))
    idps_on, _e = run(lambda d: a._mod_idp_state(d, me, ALL_NR))
    s.check("FALSIFY: with the ticks on R1 reads With manager / Shared with manager again",
            tcs_on[R1]["stage"] == "submitted" and idps_on[R1]["stage"] == "shared")
    seat(CH, DL, ticks=())
    s.check("the stage descriptions say 'final where nobody reviews'", "final where nobody reviews" in dict(
        (k, d) for k, _l, d, _c in a.TC_MOD_STAGES)["complete"] and "final where nobody reviews" in dict(
        (k, d) for k, _l, d, _c in a.IDP_MOD_STAGES)["complete"])
    # the person pages
    mods = run(lambda d: a._person_modules(d, user(R1), cyc))
    mods_o = run(lambda d: a._person_modules(d, user(OR), cyc))
    s.check("the person page's cards: R1's competency and plan read final, OR's do not",
            mods["tc_nobody"] and mods["idp_nobody"] and not mods_o["tc_nobody"] and not mods_o["idp_nobody"], (mods, mods_o))
    tpl_o = open(os.path.join(H.REPO, "templates/person/_overview.html"), encoding="utf-8").read()
    tpl_s = open(os.path.join(H.REPO, "templates/person/_summary.html"), encoding="utf-8").read()
    s.check("...the two templates word it ('nobody reviews it'), before the 'their manager to review' branch",
            tpl_o.index("mods.tc_nobody") < tpl_o.index("their manager to review")
            and tpl_s.index("mods.tc_nobody") < tpl_s.index("their manager to review")
            and "mods.idp_nobody" in tpl_o and "mods.idp_nobody" in tpl_s)
    pg = SUP.get("/admin/users/%d" % R1)
    html = pg.get_data(as_text=True)
    s.check("the real person page (R1) shows the final words, not 'their manager to review'", pg.status_code == 200
            and "nobody reviews it" in html and "their manager to review" not in html, pg.status_code)
    html_o = SUP.get("/admin/users/%d" % OR).get_data(as_text=True)
    s.check("...and OR's page still says their manager reviews", "their manager to review" in html_o and "nobody reviews it" not in html_o)
    # the employee's own card and record
    standing = run(lambda d: a.dash_standing(d, user(R1), PERIOD, cyc, asked=True))
    comp_card = [x for x in standing if x.get("key") == "competency"]
    s.check("R1's own card: Competency reads a final, reviewed-shaped state ('N of M demonstrated', nobody reviews it), never "
            "'With your manager'", comp_card and comp_card[0].get("pending") is None and "demonstrated" in (comp_card[0].get("text") or "")
            and "Nobody reviews it" in (comp_card[0].get("note") or ""), comp_card)
    standing_o = run(lambda d: a.dash_standing(d, user(OR), PERIOD, cyc, asked=True))
    comp_o = [x for x in standing_o if x.get("key") == "competency"]
    s.check("...and OR's still reads With your manager", comp_o and comp_o[0].get("pending") == "With your manager", comp_o)
    rec = run(lambda d: a._record_present(d, user(R1)))
    rec_o = run(lambda d: a._record_present(d, user(OR)))
    s.check("R1's record: the competency is final (not 'with your line manager'), the plan is 'Shared' with no pending remark; OR's "
            "is not", rec["competency"]["final"] and not rec["competency"]["reviewed"] and rec["plan"]["final"]
            and rec["plan"]["lm_pending"] is False and rec["plan"]["status_label"] == "Shared"
            and not rec_o["competency"]["final"] and rec_o["plan"]["lm_pending"] is True, (rec["competency"].get("final"), rec["plan"]))
    txt = a._record_present_plain(rec)
    txt_o = a._record_present_plain(rec_o)
    s.check("...and the plain read says it ('submitted, and your own answers count') while OR's says with your line manager",
            "own answers count" in txt and "with your line manager" not in txt.split("Your 360")[0].split("Your competency")[1]
            and "with your line manager" in txt_o, (txt, txt_o))
    js = open(os.path.join(H.REPO, "static/dashboard.js"), encoding="utf-8").read()
    s.check("the dashboard script words it ('nobody reviews it'; the plan 'shared, final'; the pending remark line only when "
            "lm_pending, which a covered plan never sets)", "c.final" in js and "pl.final" in js and "pl.lm_pending" in js)
    nb = lambda w, k: run(lambda d: a._signoff_nobody(d, w, k))
    s.check("...the sign-off is final wording for R1 (competency and plan), the usual for OR and for the KPI check-in",
            nb(R1R, "competency_confirm") and nb(R1R, "idp_confirm") and nb(R1R, "competency") and nb(R1R, "career_plan")
            and not nb(ORR, "competency_confirm") and not nb(ORR, "idp_confirm") and not nb(R1R, "confirm"))
    lab, say = a._signoff_meta("competency_confirm", None, True)
    lab2, say2 = a._signoff_meta("competency_confirm", None, False)
    s.check("...'Done' for R1 says nobody reviews it, OR's says it goes to the manager",
            "Nobody reviews it" in say and "manager" not in say and "submitted to your manager" in say2)
    s.check("...and the 'already submitted' line follows",
            "manager" not in run(lambda d: a._signoff_already(d, R1R, "competency_confirm"))
            and "manager" in run(lambda d: a._signoff_already(d, ORR, "competency_confirm")))
    # the chair settings wording
    notes = {k: n for k, _l, n in a.CHAIR_TEAM_TICKS}
    s.check("the chair settings' notes say nobody does it (competency: self-assessment counts; plan: final once shared; behalf: "
            "nobody assesses)", notes["behalf"] == "off: nobody assesses for them" and "nobody reviews" in notes["competency"]
            and "self-assessment counts" in notes["competency"] and "final once they share" in notes["plan"])
    m1 = run(lambda d: a.leader_ability_off(d, CHR, "lm.competency"))
    m2 = run(lambda d: a.leader_ability_off(d, CHR, "lm.plan"))
    m3 = run(lambda d: a.leader_ability_off(d, CHR, "lm.behalf"))
    s.check("his refusals: nobody does it for him, no delegate named; the competency one says the self-assessment counts, the plan "
            "one says it is final once shared",
            all("nobody does it for you" in m and "delegate" not in m for m in (m1, m2, m3))
            and "self-assessment counts" in m1 and "final once they share it" in m2, (m1, m2, m3))
    page = SUP.get("/admin/leaders/chair").get_data(as_text=True)
    s.check("the chair settings page: no delegate word at all, no 'Nobody stands in yet'; it says nobody reviews them",
            "reviewed by" not in page and "Nobody stands in yet" not in page and "goes to the delegate" not in page
            and "nobody reviews that part for them" in page and "off: nobody assesses for them" in page
            and "delegate" not in page.lower(), "")   # (6 Nov: the delegate picker and its paragraph are gone; the lede and the tick notes say it)
    save = SUP.post("/admin/leaders/chair", data={"csrf_token": "tok", "action": "save", "team_posted": "1", "team": ["moderate"]},
                    follow_redirects=True)
    log = H.rows(a, "SELECT detail FROM activity_log WHERE action='exec_chair_team' ORDER BY id DESC LIMIT 1")
    s.check("the audit text says nobody stands in and that the self-assessment counts / a shared plan is final",
            log and "nobody stands in" in log[0][0] and "self-assessment counts" in log[0][0] and "go to the delegate" not in log[0][0],
            log)
    seat(CH, DL, ticks=())
    kb_live = "\n".join(l for l in SRC.splitlines() if "LIKE" not in l and "%Your delegate looks after" not in l)
    s.check("no KB body, Help answer or prompt still says the delegate looks after the chair's reports' competency or plan",
            "delegate looks after their competency review" not in kb_live and "Your delegate looks after" not in kb_live
            and "his delegate looks after their competency" not in kb_live)
    s.check("...the KB row is reworded once, keyed on the old sentence (an admin's edit is left alone)",
            "%Your delegate looks after their competency review%" in SRC
            and "While your ticks for them are off, nobody reviews" in a._KB_CHAIR_VIEW_BODY
            and "While your ticks for them are off, nobody reviews" in a.HELP_QA["chair_360"][1])
    s.check("no new def shadows another in app.py (a later def silently wins)", all(
        len(re.findall(r"^def %s\(" % n, SRC, re.M)) == 1 for n in (
            "_chair_norev_id", "_chair_norev_subject", "_chair_norev_ids", "_chair_norev_sql", "_tc_chair_unreviewed",
            "_tc_chair_unreviewed_ids", "_tc_chair_unreviewed_sql", "_idp_chair_unreviewed", "_idp_chair_unreviewed_ids",
            "_idp_chair_unreviewed_sql", "_tc_status_eff", "_tc_done_sql", "_signoff_nobody", "_signoff_already")))
    s.check("the stale stand-in code is gone: no caller reads a delegate's extra team any more",
            "no_self" not in SRC and "_chair_team_adjust(db, uid, \"competency\")[1]" not in SRC)

    # ------------------------------------------------------------------------------------------------------------ flag off
    s.section("flag off: nothing changes")
    os.environ.pop("ONEHR_CHAIR", None)
    s.check("every list is today's: the chair lists his own reports, the delegate nothing extra, plans too",
            tc_ids(CH) == {R1, R2, R3, DL} and tc_ids(DL) == set() and R1 in idp_ids(CH) and pr(CHR, R1) and not pr(DLR, R1)
            and comb(R1)["source"] == "360_only" and run(lambda d: a.tc_reviewed_score(d, R1, CID)) == (None, None, None))
    os.environ["ONEHR_CHAIR"] = "1"
finally:
    os.environ.pop("ONEHR_CHAIR", None)
    a.window_closed, a.cycle_is_open, a._behalf_part_closed = _real_window, _real_open, _real_behalf

sys.exit(s.done())
