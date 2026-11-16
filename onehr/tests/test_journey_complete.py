"""The END of the personal review (Chris, 2026-09-28): "once an user completed all PM, TM, and IDP (regardless of
the order), we should have the completion-thank you message for those without direct reports and show them the
final card of all 3 modules in summary. Then for line managers, the agent should offer to start the direct reports'
evaluation, which by answering yes, it will bring the user to the team view."

  * whichever sign-off finishes the last part -- the plan Share, the 360's last colleague -- the SERVER says the
    thank-you and shows the summary card (a page per module), with NO model call
  * a sign-off that leaves a part open is the old "what next?" reply, never the completion
  * a line manager gets the offer; "yes" (or its chip) goes to the team view, "Not now" is answered, and a "yes"
    to anything else is not taken as one
  * asking for the summary once it's all done shows it again; a review finished outside a sign-off gets it once
  * sharing the plan needs the career profile's two answers first (sharing locks them)

Writes, so a fresh copy. The model is stubbed with a sentinel that fails the check if it is ever called.
"""
import json
import re
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
s = H.Suite("Journey completion -- the thank-you, the summary card, and the team hand-off")

CHBM = "CHIN HIN BUILDING MATERIAL (CHBM)"


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


# ---------------------------------------------------------------------------
s.section("build: an employee and a line manager, each with KPI + 360 + competency + a plan to write")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','tm','idp','pm')")
    db.execute("UPDATE cycle_modules SET active=0 WHERE module_key='evidence'")   # no file gate on a standout KPI
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
    # A Year-End results period: results are keyed AND a development plan is authored.
    db.execute("UPDATE cycles SET kind='year_end', half=2 WHERE id=?", (CID,))
    if not db.execute("SELECT 1 FROM pm_bg_config WHERE business_group=?", (CHBM,)).fetchone():
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (CHBM,))
    # Two real colleagues (with a grade, so the 360 has behaviours) to rate, who take part in the 360: a rater's list
    # holds only them (Chris, 2026-10-30: "out means out")
    cols = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND job_grade IS NOT NULL AND "
                      + a.participant_sql("", "tm_rated") + " ORDER BY id LIMIT 3").fetchall()
    COL1, COL2 = cols[0], cols[1]
    GRADE = cols[2]["job_grade"]

    def _mk(eid, name, mgr=None, confirmed=True):
        return db.execute(
            "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_title, job_grade, manager_id, confirmation_date, years_of_service) "
            "VALUES (?,?,'x','user',?,?,?,?,?,?,?,?,?)",
            (eid, name, eid, CHBM, "JC Co", "Sales Operations", "Executive", GRADE, mgr,
             "2020-01-01" if confirmed else None, 4.0 if confirmed else 0.5)).lastrowid
    EMP = _mk("JCT-EMP", "Jo Employee")
    MGR = _mk("JCT-MGR", "Max Manager")
    REP = _mk("JCT-REP", "Ria Report", MGR)

    def kpi(subj):
        return db.execute(
            "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
            "rate1, rate2, rate3, rate4, rate5) VALUES (?,?, 'JC Gross Profit', 100.0, 'more', 'approved', ?, "
            "9, 11, 12, 13, 15)", (CID, subj, CHBM)).lastrowid
    K_EMP, K_MGR, K_REP = kpi(EMP), kpi(MGR), kpi(REP)
    # The manager approves their report's KPI line -- they have a team to review.
    db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (K_REP, MGR))

    def _skill(code, title):
        return db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_category, proficiency_description, "
                          "ability_items, active) VALUES (?,?,3,'Operations',?, '- One\n- Two', 1)",
                          (code, title, title + " at the working level")).lastrowid
    SK1, SK2 = _skill("JCT-SK-1", "Demand Planning"), _skill("JCT-SK-2", "Cost Analysis")

    def tca(subj, sk):
        return db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, source) "
                          "VALUES (?,?,?,0,'profile')", (CID, subj, sk)).lastrowid
    TC = {EMP: (tca(EMP, SK1), tca(EMP, SK2)), MGR: (tca(MGR, SK1), tca(MGR, SK2))}

    def fba(assessor, subj):
        return db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) "
                          "VALUES (?,?,?,'peer','pending')", (CID, subj["id"], assessor)).lastrowid
    FB = {EMP: (fba(EMP, COL1),), MGR: (fba(MGR, COL1), fba(MGR, COL2))}
    STMTS = {c["id"]: [x["statement_id"] for x in a.statements_for_grade(db, c["job_grade"], CID)] for c in (COL1, COL2)}
    # NOT TAKING PART this round (Chris, 2026-09-28): an unconfirmed employee (KPI + competency assigned anyway), an
    # unconfirmed line manager with a report to review, and an unconfirmed rater an admin put on a colleague's 360.
    UNE = _mk("JCT-UNE", "Una Unconfirmed", confirmed=False)
    UNM = _mk("JCT-UNM", "Uma Unconfirmed Manager", confirmed=False)
    UNR = _mk("JCT-UNR", "Uri Unconfirmed Rater", confirmed=False)
    NOA = _mk("JCT-NOA", "Nia Nothing Assigned")               # confirmed, nothing assigned by the admin
    OUT = _mk("JCT-OUT", "Otto Taken Out")                     # confirmed, taken out of the cycle by an admin
    UREP = _mk("JCT-UREP", "Ulf Report", UNM)
    kpi(UNE); tca(UNE, SK1)
    K_UREP = kpi(UREP)
    db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (K_UREP, UNM))
    kpi(UNM)
    fba(UNR, COL2)
    kpi(OUT); tca(OUT, SK1)
    # taken out of the cycle by an admin: no review and no Career Plan (the IDP is everyone's otherwise, 2026-10-19)
    for _o in (OUT, UNM):
        db.execute("INSERT OR REPLACE INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'remove')",
                   (CID, _o))
    db.commit()
s.check("fixture: the colleagues have behaviours to rate", all(STMTS.values()), {k: len(v) for k, v in STMTS.items()})

# The model must never be called on the deterministic paths -- a sentinel fails the check if it is.
_avail0, _agent0 = ai_draft.review_agent_available, ai_draft.review_agent
SCRIPT, SEEN = [], []
ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = lambda system, messages, timeout=90: (SEEN.append(system), SCRIPT.pop(0))[1]


def ctx(uid, fn):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        db = a.get_db()
        return fn(db, dict(db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


def turn(c, **form):
    q = "/review/chat?journey=1"
    return post(c, q, **{k: (str(v) if v is not None else "") for k, v in form.items()}).get_json() or {}


def do_kpi(c, uid, kid):
    post(c, "/review/kpi/save-all", **{"actual_value_%d" % kid: "12"})
    post(c, "/review/kpi/remark", remark="I held gross profit on plan through the second half by renegotiating "
                                         "two supplier contracts and tightening the discount rules for the key accounts.")
    return post(c, "/review/confirm")


def do_360(c, aid, subj_id):
    ans = {"answer_%d" % x: "no" for x in STMTS[subj_id]}
    ans[sorted(ans)[0]] = "yes"   # one Demonstrate: an ordinary rating, the remark optional
    post(c, "/review/feedback/save-all", assignment_id=str(aid), **ans)
    return post(c, "/review/feedback/submit", assignment_id=str(aid))


def do_comp(c, uid):
    t1, t2 = TC[uid]
    post(c, "/review/competency/save-all", **{"answer_%d" % t1: "yes", "answer_%d" % t2: "no"})
    post(c, "/review/competency/remark", remark="I plan demand well and keep the forecast honest; cost analysis "
                                               "is where I'm still building depth, especially on landed cost.")
    return post(c, "/review/competency/submit")


def do_plan(uid, profile=True):
    def _w(db, u):
        period, _p, _act = a._pm_idp_period(db, u)
        idp = a.pm_idp_for(db, a.pm_idp_plan_year(period), uid, create=True, cycle_id=period["id"])
        db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, action_experience, target_date) "
                   "VALUES (?,1,'Cost analysis depth','Own the landed-cost review for one product line','2027-06-30')",
                   (idp["id"],))
        db.commit()
        if profile:
            a.pm_career_save_field(db, uid, "aspiration_mid", "Regional operations lead")
            a.pm_career_save_field(db, uid, "mobility", "same_company")
    ctx(uid, _w)


# ---------------------------------------------------------------------------
s.section("the employee: KPI, competency, the 360 -- then the plan Share finishes the review")
E = H.client_as(a, EMP)
s.check("precondition: the employee manages nobody", ctx(EMP, lambda db, u: a._review_manages(db, u)) is False)
s.check("the KPI check-in confirms", do_kpi(E, EMP, K_EMP).status_code == 200)
SCRIPT[:] = ["SHOULD NOT RUN"]; SEEN[:] = []
j1 = turn(E, message="", stage="account", after_signoff="confirm")
s.check("a sign-off that leaves parts open is the 'what next' reply -- never the completion",
        "whole review" not in (j1.get("say") or "")
        and not any(r.get("type") == "journey_complete" for r in j1.get("renders") or []), j1.get("say"))
s.check("the competency self-assessment submits", do_comp(E, EMP).status_code == 200)
turn(E, message="", stage="competency", after_signoff="competency_confirm")
s.check("the 360 submits", do_360(E, FB[EMP][0], COL1["id"]).status_code == 200)
SCRIPT[:] = [{"say": "Nice -- your 360 is in. Next is your Career Plan.", "quick_replies": [], "action": None}]
turn(E, message="", stage="feedback", after_signoff="feedback_confirm", after_signoff_id=FB[EMP][0])

# The Career Plan: sharing locks the whole thing, so the profile's two answers come first.
do_plan(EMP, profile=False)
_r0 = post(E, "/review/ahead/submit")
s.check("sharing is refused while where-you-want-to-go / how-far-you'd-move are blank (sharing would lock them)",
        _r0.status_code == 400 and a.PM_IDP_SHARE_PROFILE_ERROR in ((_r0.get_json() or {}).get("error") or ""),
        (_r0.status_code, _r0.get_json()))
ctx(EMP, lambda db, u: (a.pm_career_save_field(db, EMP, "aspiration_mid", "Regional operations lead"),
                        a.pm_career_save_field(db, EMP, "mobility", "same_company")))
s.check("with both answered, the plan shares", post(E, "/review/ahead/submit").status_code == 200)
SCRIPT[:] = ["SHOULD NOT RUN"]; SEEN[:] = []
jd = turn(E, message="", stage="career_plan", after_signoff="idp_confirm")
say = jd.get("say") or ""
cards = jd.get("renders") or []
summ = next((r for r in cards if r.get("type") == "journey_complete"), None)
s.check("the Share that finishes everything gets the completion, with NO model call",
        not SEEN and SCRIPT == ["SHOULD NOT RUN"], (SEEN[:1], SCRIPT))
s.check("...a thank-you: 'That's your whole review done, <name> -- thank you!'",
        say.startswith("That's your whole review done, Jo -- thank you!"), say)
s.check("...which says where each part went",
        "KPI check-in is with your approver" in say and "360 feedback is in" in say
        and "competency self-assessment and career plan are with your manager" in say
        and "summary of all three" in say, say)
s.check("...ONE summary card, and no final card for the plan (it locked in place on its card -- 2026-09-29)",
        not any(r.get("type") == "idp_confirm" for r in cards)
        and sum(1 for r in cards if r.get("type") == "journey_complete") == 1, [r.get("type") for r in cards])
_pg = {p["key"]: p for p in ((summ or {}).get("data") or {}).get("pages") or []}
s.check("the summary has a page per module, in order: PM, TM, IDP",
        [p["key"] for p in ((summ or {}).get("data") or {}).get("pages") or []] == ["pm", "tm", "idp"], list(_pg))
s.check("...every part on it is done", all(pt.get("done") for p in _pg.values() for pt in p["parts"]),
        [(pt["kind"], pt.get("done")) for p in _pg.values() for pt in p["parts"]])
_kp = (_pg.get("pm") or {"parts": [{}]})["parts"][0]
s.check("PM page: the scorecard -- the KPI, its result, the overall and the remark",
        _kp.get("kind") == "kpi" and (_kp.get("scorecard") or {}).get("lines")
        and _kp["scorecard"]["lines"][0]["kpi"] == "JC Gross Profit" and _kp["scorecard"]["lines"][0]["actual"]
        and (_kp["scorecard"].get("overall") or {}).get("value")
        and "renegotiating" in (_kp["scorecard"].get("overall_remark") or ""), _kp)
_tm = {pt["kind"]: pt for pt in (_pg.get("tm") or {"parts": []})["parts"]}
s.check("TM page: the 360 colleague with their tally, and the competency tally + remark",
        [c["name"] for c in (_tm.get("feedback") or {}).get("colleagues") or []] == [COL1["full_name"]]
        and (_tm["feedback"]["colleagues"][0]["demonstrated"], _tm["feedback"]["colleagues"][0]["developing"])
        == (1, len(STMTS[COL1["id"]]) - 1)
        and (_tm.get("competency") or {}).get("demonstrate") == 1 and _tm["competency"].get("developing") == 1
        and _tm["competency"].get("development_areas") == ["Cost Analysis"]
        and "forecast honest" in _tm["competency"].get("remark", ""), _tm)
_ip = (_pg.get("idp") or {"parts": [{}]})["parts"][0]
s.check("IDP page: the goal, where they want to go and how far they'd move",
        [g["area"] for g in _ip.get("goals") or []] == ["Cost analysis depth"]
        and any(it.get("value") == "Regional operations lead"
                for sec in ((_ip.get("career") or {}).get("sections") or []) for it in sec.get("items") or []),
        _ip)
s.check("an employee with no direct reports: no team offer and no chips",
        a._JOURNEY_TEAM_OFFER not in say and a._JOURNEY_CALIB_OFFER not in say and jd.get("quick_replies") == [],
        (say, jd.get("quick_replies")))
_h = E.get("/review/chat/history?journey=1&stage=career_plan").get_json() or {}
_hc = [c for m in _h.get("messages") or [] for c in (m.get("card") or []) if isinstance(c, dict)]
s.check("a reload replays the summary card", any(c.get("type") == "journey_complete" for c in _hc),
        [c.get("type") for c in _hc])
with a.app.app_context():
    _db9 = a.get_db()
    _r9 = _db9.execute("SELECT id, card FROM pm_review_chat WHERE subject_id=? AND card LIKE '%journey_complete%' "
                       "ORDER BY id DESC LIMIT 1", (EMP,)).fetchone()
    _c9 = json.loads(_r9["card"])
    for c in _c9:
        if c.get("type") == "journey_complete":
            c["data"].pop("title", None)          # a card stored before the title existed
    _db9.execute("UPDATE pm_review_chat SET card=? WHERE id=?", (json.dumps(_c9), _r9["id"])); _db9.commit()
_h9 = E.get("/review/chat/history?journey=1&stage=career_plan").get_json() or {}
s.check("...and an older stored summary card (no title) replays with the cycle title filled in",
        any(c.get("type") == "journey_complete" and re.match(r"^Your \d{4} Year-End Check-in$", (c.get("data") or {}).get("title") or "")
            for m in _h9.get("messages") or [] for c in (m.get("card") or []) if isinstance(c, dict)))

s.section("a replayed summary card locks the box only while the review is STILL complete (history says review_complete)")
_hrc = E.get("/review/chat/history?journey=1&stage=career_plan").get_json() or {}
s.check("with every live part done, the history says review_complete true (and the card is in the transcript)",
        _hrc.get("review_complete") is True
        and any(c.get("type") == "journey_complete" for m in _hrc.get("messages") or [] for c in (m.get("card") or [])
                if isinstance(c, dict)), _hrc.get("review_complete"))
with a.app.app_context():
    _dbr = a.get_db()
    _ta = _dbr.execute("SELECT id, status FROM tc_assessments WHERE cycle_id=? AND subject_id=?", (CID, EMP)).fetchone()
    _dbr.execute("UPDATE tc_assessments SET status='pending' WHERE id=?", (_ta["id"],)); _dbr.commit()   # a part opens again
_hro = E.get("/review/chat/history?journey=1&stage=career_plan").get_json() or {}
s.check("a part open again after the card (a Reopen, a late addition): the card is still replayed, review_complete is false",
        _hro.get("review_complete") is False
        and any(c.get("type") == "journey_complete" for m in _hro.get("messages") or [] for c in (m.get("card") or [])
                if isinstance(c, dict)), _hro.get("review_complete"))
with a.app.app_context():
    _dbr = a.get_db()
    _dbr.execute("UPDATE tc_assessments SET status=? WHERE id=?", (_ta["status"], _ta["id"])); _dbr.commit()
s.check("...put back: complete again", (E.get("/review/chat/history?journey=1&stage=career_plan").get_json() or {})
        .get("review_complete") is True)
_JSRC = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
_jc = _JSRC[_JSRC.index('card.type === "journey_complete"'):][:700]
s.check("client: the journey_complete branch calls markReviewDone() only for a live card or locks.reviewComplete",
        re.search(r"if \(!replay \|\| locks\.reviewComplete\) markReviewDone\(\)", _jc) is not None
        and _jc.count("markReviewDone()") == 1, _jc[:300])
s.check("client: the history renderCard call passes reviewComplete from the history JSON",
        "reviewComplete: j.review_complete" in _JSRC)

s.section("the chat closes once it's all done: the page rests on the summary card, titled for the cycle")
s.check("the card is titled for the cycle -- 'Your <year> Year-End Check-in'",
        re.match(r"^Your \d{4} Year-End Check-in$", ((summ or {}).get("data") or {}).get("title") or ""),
        ((summ or {}).get("data") or {}).get("title"))
with a.app.app_context():
    _n0 = a.get_db().execute("SELECT COUNT(*) FROM pm_review_chat WHERE subject_id=?", (EMP,)).fetchone()[0]
SCRIPT[:] = ["SHOULD NOT RUN"]; SEEN[:] = []
js = turn(E, message="anything else for me?", stage="career_plan")
s.check("a message after that gets one fixed line -- no model, no card, flagged complete (the page locks the input)",
        js.get("say") == a._JOURNEY_DONE_LINE and js.get("review_complete") is True and not js.get("renders")
        and not SEEN, js.get("say"))
_je = turn(E, message="", stage="feedback")
s.check("...a part switch (an empty turn) says nothing and changes nothing", _je.get("say") == "" and _je.get("review_complete"))
with a.app.app_context():
    _n1 = a.get_db().execute("SELECT COUNT(*) FROM pm_review_chat WHERE subject_id=?", (EMP,)).fetchone()[0]
s.check("...and nothing is added under the summary card for someone with no team", _n1 == _n0, (_n0, _n1))
jy = turn(E, message="yes", stage="career_plan")
s.check("an employee's 'yes' is never a trip to the team view", not jy.get("goto"), jy.get("goto"))

s.section("a review finished outside a sign-off (or before the completion existed) gets it once, after the reply")
with a.app.app_context():
    a.get_db().execute("UPDATE pm_review_chat SET card=NULL WHERE subject_id=? AND card LIKE '%journey_complete%'",
                       (EMP,))
    a.get_db().commit()
s.check("it's due now (all done, not shown) -- but never beside a LIVE sign-off card still waiting for a click",
        ctx(EMP, lambda db, u: (a._journey_completion_due(db, u, CID, a.review_state(db, u)),
                                a._journey_completion_due(db, u, CID, a.review_state(db, u),
                                                          [{"type": "idp_confirm", "data": {}}]),
                                a._journey_completion_due(db, u, CID, a.review_state(db, u),
                                                          [{"type": "idp_confirm", "data": {"submitted": True}}])))
        == (True, False, True))
SCRIPT[:] = [{"say": "You're welcome.", "quick_replies": [], "action": None}]; SEEN[:] = []
jm = turn(E, message="thanks", stage="career_plan")
s.check("the model's reply stands, then the thank-you and the summary card follow",
        (jm.get("say") or "").startswith("You're welcome.") and "whole review done" in (jm.get("say") or "")
        and any(r.get("type") == "journey_complete" for r in jm.get("renders") or []), jm.get("say"))
SCRIPT[:] = [{"say": "Anytime.", "quick_replies": [], "action": None}]
jm2 = turn(E, message="thanks again", stage="career_plan")
s.check("...only once: after that the chat is closed (the fixed line, no model, no second card)",
        jm2.get("say") == a._JOURNEY_DONE_LINE and SCRIPT == [{"say": "Anytime.", "quick_replies": [], "action": None}]
        and not any(r.get("type") == "journey_complete" for r in jm2.get("renders") or []), jm2.get("say"))

s.section("a second completion: an early card, a part submitted AFTER it, and the review done again -> due again, once")
_due = lambda: ctx(EMP, lambda db, u: a._journey_completion_due(db, u, CID, a.review_state(db, u)))
s.check("no new submission since the card: not due (shown once per real completion)", _due() is False)
with a.app.app_context():
    _d = a.get_db()
    _ta = _d.execute("SELECT submitted_at, reviewed_at FROM tc_assessments WHERE cycle_id=? AND subject_id=?",
                     (CID, EMP)).fetchone()
    _cardat = _d.execute("SELECT MAX(created_at) FROM pm_review_chat WHERE subject_id=? AND cycle_id=? "
                         "AND card LIKE '%journey_complete%'", (EMP, CID)).fetchone()[0]
    _later = "2099-01-01 00:00:00"
    _d.execute("UPDATE tc_assessments SET submitted_at=?, reviewed_at=NULL WHERE cycle_id=? AND subject_id=?",
               (_later, CID, EMP))
    _d.commit()
s.check("a part (the competency) submitted later than the shown card: the completion is due again", _due() is True)
_late_st = ctx(EMP, lambda db, u: a._journey_review_complete(a.review_state(db, u)))
s.check("...while the review is complete (the guard still needs it) and a live sign-off card still blocks it",
        _late_st is True and ctx(EMP, lambda db, u: a._journey_completion_due(
            db, u, CID, a.review_state(db, u), [{"type": "idp_confirm", "data": {}}])) is False)
with a.app.app_context():
    _d = a.get_db()
    _d.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, card, created_at) "
               "VALUES (?,?,'agent','done',?, '2099-01-02 00:00:00')",
               (EMP, CID, json.dumps([{"type": "journey_complete", "data": {}}])))
    _d.commit()
s.check("the second card shown: not due again", _due() is False)
with a.app.app_context():
    _d = a.get_db()
    _d.execute("DELETE FROM pm_review_chat WHERE subject_id=? AND created_at='2099-01-02 00:00:00'", (EMP,))
    _d.execute("UPDATE tc_assessments SET submitted_at=?, reviewed_at=? WHERE cycle_id=? AND subject_id=?",
               (_ta["submitted_at"], _ta["reviewed_at"], CID, EMP))
    _d.commit()
s.check("put back: not due", _due() is False)
# the manager's review is not the person's submission (reviewed_at is the manager's; submitted_at the person's)
with a.app.app_context():
    _d = a.get_db()
    _d.execute("UPDATE tc_assessments SET reviewed_at='2099-03-01 00:00:00' WHERE cycle_id=? AND subject_id=?",
               (CID, EMP))
    _d.commit()
s.check("a manager reviewing the competency after the card (reviewed_at later, submitted_at earlier): NOT due",
        _due() is False)
with a.app.app_context():
    _d = a.get_db()
    _d.execute("UPDATE tc_assessments SET reviewed_at=? WHERE cycle_id=? AND subject_id=?",
               (_ta["reviewed_at"], CID, EMP))
    _d.commit()
s.check("put back after the manager's review: not due", _due() is False)

# ---------------------------------------------------------------------------
s.section("the line manager: plan shared early, the 360's LAST colleague finishes it -> the team offer")
M = H.client_as(a, MGR)
s.check("precondition: the manager has a team", ctx(MGR, lambda db, u: a._review_manages(db, u)) is True)
# Their report has submitted results, so the PM team review has someone waiting on them.
with a.app.app_context():
    a.get_db().execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, draft, submitted_by) VALUES (?,12,0,?)",
                       (K_REP, REP))
    a.get_db().commit()
s.check("...with a report waiting, the offer says so",
        ctx(MGR, lambda db, u: a._journey_team_offer(a.review_state(db, u))) == a._JOURNEY_TEAM_OFFER)
do_kpi(M, MGR, K_MGR)
do_comp(M, MGR)
do_plan(MGR)
s.check("the manager's plan shares", post(M, "/review/ahead/submit").status_code == 200)
do_360(M, FB[MGR][0], COL1["id"])
s.check("one colleague left: not complete yet", ctx(MGR, lambda db, u: a._journey_review_complete(a.review_state(db, u)))
        is False)
s.check("the LAST colleague submits", do_360(M, FB[MGR][1], COL2["id"]).status_code == 200)
SCRIPT[:] = ["SHOULD NOT RUN"]; SEEN[:] = []
jmg = turn(M, message="", stage="feedback", after_signoff="feedback_confirm", after_signoff_id=FB[MGR][1])
msay = jmg.get("say") or ""
s.check("the 360's last colleague finishes the review: the completion, with NO model call (it used to be the model's)",
        not SEEN and msay.startswith("That's your whole review done, Max -- thank you!"), (SEEN[:1], msay))
s.check("...the summary card, and no final card for the colleague (their card locked in place -- 2026-09-29)",
        any(r.get("type") == "journey_complete" for r in jmg.get("renders") or [])
        and not any(r.get("type") == "feedback_confirm" for r in jmg.get("renders") or []),
        [r.get("type") for r in jmg.get("renders") or []])
s.check("...and the offer to start their direct reports' evaluation, with its two chips",
        msay.endswith(a._JOURNEY_TEAM_OFFER) and jmg.get("quick_replies") == a._JOURNEY_TEAM_OFFER_CHIPS,
        (msay, jmg.get("quick_replies")))

s.section("answering the offer: yes -> the team view; not now -> answered; neither needs the model")
SCRIPT[:] = ["SHOULD NOT RUN"]; SEEN[:] = []
jyes = turn(M, message="yes", stage="feedback")
s.check("'yes' goes to the team view, no model call",
        (jyes.get("goto") or "").startswith("/review/journey?") and "view=team" in (jyes.get("goto") or "")
        and not SEEN, jyes)
_tv = M.get(jyes.get("goto") or "/review/journey?view=team")
s.check("...and the team view opens", _tv.status_code == 200 and 'data-view="team"' in _tv.get_data(as_text=True),
        _tv.status_code)
SCRIPT[:] = ["SHOULD NOT RUN"]; SEEN[:] = []
turn(M, message="what's next?", stage="feedback")   # the offer again (the summary + offer)
jlater = turn(M, message="Not now", stage="feedback")
s.check("'Not now' is answered (the team review waits), no move, no model call",
        jlater.get("say") == a._JOURNEY_TEAM_LATER and not jlater.get("goto") and not SEEN, jlater)
turn(M, message="what's next?", stage="feedback")
jchip = turn(M, message="Yes, start my team review", stage="feedback")
s.check("the chip 'Yes, start my team review' goes too", "view=team" in (jchip.get("goto") or ""), jchip.get("goto"))
turn(M, message="what's next?", stage="feedback")
s.check("'ok thanks' after the offer is an acknowledgement, not a yes",
        ctx(MGR, lambda db, u: a._journey_team_offer_answer(db, u, CID, "ok thanks")) is None)
s.check("...'sure' and 'yes please' are a yes",
        ctx(MGR, lambda db, u: (a._journey_team_offer_answer(db, u, CID, "sure"),
                                a._journey_team_offer_answer(db, u, CID, "yes please"))) == ("yes", "yes"))
with a.app.app_context():
    a.get_db().execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) "
                       "VALUES (?,?,'agent','Your remark is saved. Anything else on your 360?','feedback')", (MGR, CID))
    a.get_db().commit()
s.check("a 'yes' to anything else is not taken as a yes to the team review",
        ctx(MGR, lambda db, u: a._journey_team_offer_answer(db, u, CID, "yes")) is None)

s.section("the review's cases: a 'yes' to anything but the offer, and picking a 360 colleague, stay in Mine")
s.check("'Let's start with my direct report' (a 360 colleague) is not a request for the team view",
        not a._JOURNEY_TEAM_START_RE.search("Let's start with my direct report")
        and not a._JOURNEY_TEAM_START_RE.search("begin with the team")
        and a._JOURNEY_TEAM_START_RE.search("Yes, start my team review")
        and a._JOURNEY_TEAM_START_RE.search("start my direct reports' evaluation"))
with a.app.app_context():
    a.get_db().execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) VALUES (?,?,'agent',?,"
                       "'account')", (MGR, CID, 'Here\'s a draft: "My team closed the gap" -- want me to save it?'))
    a.get_db().commit()
s.check("a 'yes please' to a remark draft that mentions 'my team' is not a yes to the team review",
        ctx(MGR, lambda db, u: a._journey_team_offer_answer(db, u, CID, "yes please")) is None)
with a.app.app_context():
    a.get_db().execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, quick_replies, stage) "
                       "VALUES (?,?,'agent','Well done! Want to look at your team now?',?, 'account')",
                       (MGR, CID, json.dumps(["Go to Team review"])))
    a.get_db().commit()
s.check("the model's own offer (with the 'Go to Team review' chip) is answered -- but only once their review is done",
        ctx(MGR, lambda db, u: (a._journey_team_offer_answer(db, u, CID, "yes", True),
                                a._journey_team_offer_answer(db, u, CID, "yes", False))) == ("yes", None))
s.check("the summary shortcut fires on a request, not on a question about the summary",
        a._JOURNEY_SUMMARY_RE.search("show my summary") and a._JOURNEY_SUMMARY_RE.search("Can I see my review summary?")
        and not a._JOURNEY_SUMMARY_RE.search("Can you explain the summary of my KPI results?")
        and not a._JOURNEY_SUMMARY_RE.search("What have I done wrong on my competency?"))
with a.app.app_context():
    _db2 = a.get_db()
    TMM = _db2.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                       "job_grade, confirmation_date) VALUES ('JCT-TMM','Tom TM Manager','x','user','JCT-TMM',?,?,"
                       "'2020-01-01')", (CHBM, GRADE)).lastrowid
    TMR = _db2.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                       "job_grade, confirmation_date, manager_id) VALUES ('JCT-TMR','Tia TM Report','x','user',"
                       "'JCT-TMR',?,?,'2020-01-01',?)", (CHBM, GRADE, TMM)).lastrowid
    _db2.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, source) VALUES (?,?,?,0,'profile')",
                 (CID, TMR, SK1))
    _db2.commit()
s.check("a line manager whose reports have competencies (no KPI approver role) has the Team view -- so the offer",
        ctx(TMM, lambda db, u: a._review_manages(db, u)) is True)
with a.app.app_context():
    _db3 = a.get_db()
    PLU = _db3.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                       "job_grade, confirmation_date) VALUES ('JCT-PLU','Pat Plan','x','user','JCT-PLU',?,?,"
                       "'2020-01-01')", (CHBM, GRADE)).lastrowid
    _db3.commit()


def _shared_blank(db, u):
    period, _p, _act = a._pm_idp_period(db, u)
    idp = a.pm_idp_for(db, a.pm_idp_plan_year(period), u["id"], create=True, cycle_id=period["id"])
    db.execute("UPDATE pm_idp SET status='shared' WHERE id=?", (idp["id"],)); db.commit()
    before = a._career_locked(db, u)
    ok1 = a.pm_career_save_field(db, u["id"], "aspiration_mid", "Area sales lead")[0]
    ok2 = a.pm_career_save_field(db, u["id"], "mobility", "same_company")[0]
    return before, ok1, ok2, a._career_locked(db, u)


s.check("a plan shared before the share gate with a blank profile can still be finished, then it locks",
        ctx(PLU, _shared_blank) == (False, True, True, True), ctx(PLU, lambda db, u: a._career_locked(db, u)))

JS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "journey_chat.js"),
          encoding="utf-8").read()
s.section("demo Reset follows the view: Mine resets their own review, Team only what they did as a reviewer")
with a.app.app_context():
    db = a.get_db()

    def _zz(eid, mgr=None):
        return db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                          "job_grade, confirmation_date, manager_id) VALUES (?,?,'x','user',?,?,?,'2020-01-01',?)",
                          (eid, eid, eid, CHBM, GRADE, mgr)).lastrowid
    ZHOD = _zz("ZZJCT-HOD")
    ZM = _zz("ZZJCT-MGR", ZHOD)
    ZR = _zz("ZZJCT-REP", ZM)
    NR = _mk("JCT-NR", "Nora Real Report", ZM)          # a non-demo report: never touched by a demo reset
    KZM, KZR, KNR = kpi(ZM), kpi(ZR), kpi(NR)
    db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (KZM, ZHOD))
    for k in (KZR, KNR):
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (k, ZM))
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,2,?)", (k, ZHOD))
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, draft, submitted_by) VALUES (?,12,0,?)",
                   (k, ZR if k == KZR else NR))
        db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, acted_by) VALUES (?,1,'confirm',?)", (k, ZM))
        db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, acted_by) VALUES (?,2,'confirm',?)",
                   (k, ZHOD))
    db.execute("INSERT INTO pm_manager_remarks(cycle_id, subject_id, remark, submitted_by) VALUES (?,?,?,?)",
               (CID, ZR, "Strong half, the numbers are backed.", ZM))
    db.execute("INSERT INTO pm_manager_remarks(cycle_id, subject_id, remark, submitted_by) VALUES (?,?,?,?)",
               (CID, NR, "A real manager remark.", ZM))
    _zt = tca(ZR, SK1)
    _za = db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status, reviewed_by, reviewed_at, "
                     "manager_overall_remark) VALUES (?,?,'reviewed',?,datetime('now'),'Agreed.')", (CID, ZR, ZM)).lastrowid
    db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer, manager_answer, manager_remark) "
               "VALUES (?,?,'yes','no','Not yet')", (_za, _zt))
    db.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content) VALUES (?,?,'user','my own words')",
               (ZM, CID))
    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, draft, submitted_by) VALUES (?,13,0,?)", (KZM, ZM))
    db.commit()
ZMC = H.client_as(a, ZM)
_mine_pg = ZMC.get("/review/journey").get_data(as_text=True)
_team_pg = ZMC.get("/review/journey?view=team").get_data(as_text=True)
s.check("the demo bar's Reset is 'Reset' under Mine and 'Reset team' under Team, each to its own route",
        "/review/demo/reset-all" in _mine_pg and ">Reset<" in _mine_pg
        and "/review/demo/reset-team" in _team_pg and ">Reset team<" in _team_pg)
_zr_pg = H.client_as(a, ZR).get("/review/journey?view=team").get_data(as_text=True)
s.check("...someone with no team left on ?view=team (e.g. after a persona switch) sees Mine, and plain 'Reset'",
        'data-view="mine"' in _zr_pg and ">Reset<" in _zr_pg and ">Reset team<" not in _zr_pg)
_rt = post(ZMC, "/review/demo/reset-team")
_cnt = lambda sql, args: H.one(a, sql, args)
s.check("Reset team goes back to the team view", _rt.status_code in (302, 303) and "view=team" in _rt.headers.get("Location", ""),
        (_rt.status_code, _rt.headers.get("Location")))
s.check("...their approvals (and the later tier's, built on theirs) on the demo report's line are gone",
        _cnt("SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=?", (KZR,)) == 0)
s.check("...their remark on the demo report is gone, and the report's own submission stays",
        _cnt("SELECT COUNT(*) FROM pm_manager_remarks WHERE subject_id=? AND submitted_by=?", (ZR, ZM)) == 0
        and _cnt("SELECT draft FROM pm_kpi_results WHERE kpi_target_id=?", (KZR,)) == 0)
s.check("...the competency review goes back to 'submitted' with their calls cleared, the employee's answer kept",
        _cnt("SELECT status FROM tc_assessments WHERE id=?", (_za,)) == "submitted"
        and _cnt("SELECT manager_answer FROM tc_scores WHERE assessment_id=?", (_za,)) is None
        and _cnt("SELECT answer FROM tc_scores WHERE assessment_id=?", (_za,)) == "yes")
s.check("...a NON-demo report is never touched (approvals and remark stay)",
        _cnt("SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=?", (KNR,)) == 2
        and _cnt("SELECT COUNT(*) FROM pm_manager_remarks WHERE subject_id=?", (NR,)) == 1)
s.check("...and their OWN review is left alone (the Team reset is only the team)",
        _cnt("SELECT COUNT(*) FROM pm_review_chat WHERE subject_id=?", (ZM,)) == 1
        and _cnt("SELECT COUNT(*) FROM pm_kpi_results WHERE kpi_target_id=?", (KZM,)) == 1)
post(ZMC, "/review/demo/reset-all")
s.check("the Mine Reset rewinds their own review (their result is gone)...",
        _cnt("SELECT COUNT(*) FROM pm_kpi_results WHERE kpi_target_id=?", (KZM,)) == 0
        and _cnt("SELECT COUNT(*) FROM pm_review_chat WHERE subject_id=?", (ZM,)) == 0)
s.check("...but keeps the approver chain on their own KPI lines, so their check-in still reaches their HOD",
        _cnt("SELECT COUNT(*) FROM pm_kpi_target_approvers WHERE kpi_target_id=? AND approver_id=?", (KZM, ZHOD)) == 1)
s.check("a non-demo account is refused the team reset", post(H.client_as(a, EMP), "/review/demo/reset-team").status_code == 404)
s.check("the fill-in card is never greyed behind a final card any more (one card per part: no signoffActive, "
        "no Edit -- 2026-09-29)", "signoffActive" not in JS and "function editFromCard(" not in JS)

s.section("the rules underneath")
_mk_st = lambda *states: {"stages": [{"key": k, "group": "self", "state": st_, "short": k, "module": "x",
                                      "n_open": 0, "n_total": 1}
                                     for k, st_ in zip(("account", "feedback", "competency"), states)]}
s.check("complete = nothing open or waiting AND something done",
        a._journey_review_complete(_mk_st("done", "done", "done")) is True
        and a._journey_review_complete(_mk_st("done", "open", "done")) is False
        and a._journey_review_complete(_mk_st("done", "waiting", "done")) is False
        and a._journey_review_complete(_mk_st("later", "later", "later")) is False
        and a._journey_review_complete(_mk_st("done", "later", "done")) is True)
s.check("the Team chip and the completion read the SAME rule",
        a._journey_mine_all_done(_mk_st("done", "waiting", "done")) is False)
s.check("client: the summary card has its own renderer, drawn read-only",
        'card.type === "journey_complete"' in JS and "function journeyCompleteCard(" in JS
        and "rv-confirm-done rv-jc" in JS)
s.check("...and it never recedes the board (there is no sign-off card to recede behind any more)",
        "function isSignoffCard(" not in JS and "rv-confirm-done rv-jc" in JS)
s.check("...the team hand-off follows the server's goto", "window.location.href = j.goto" in JS)
_jcc = JS[JS.find("function journeyCompleteCard("):JS.find("function jcRemark(")]
s.check("client: the card's header is the cycle title with a completed tick",
        "d.title" in _jcc and "rv-jc-tick" in _jcc and "Your review — complete" not in JS)
s.check("client: showing the summary closes the chat -- the input locks, typing and part switches stop, chips still go",
        "markReviewDone()" in JS[JS.find('card.type === "journey_complete"'):JS.find('card.type === "journey_complete"') + 500]
        and "if (composerLocked() && (fromInput || !String(explicit" in JS
        and "lastSummary.scrollIntoView" in JS
        and "if (j && j.review_complete) markReviewDone();" in JS
        and "send.disabled = false;" not in JS)
s.check("client: once complete, a top tab pages the summary to that module and swaps the side panels -- no chat turn",
        "wrap._jcGo = function (key)" in JS and "function showCompletedModule(stage)" in JS
        and "if (composerLocked()) { showCompletedModule(stageEl.getAttribute(\"data-stage\")); return; }" in JS
        and "sendTurn" not in JS[JS.find("function showCompletedModule("):JS.find("// Bring the summary card's top")])
s.check("...a navigator item adds nothing, and a reload never appends a live board under the summary",
        # (an HOD's wrapped-up department review still opens a person's page from the navigator, 2026-10-02)
        'if (composerLocked() && !(deptDone && itemEl.getAttribute("data-kind") === "calib")) {\n'
        "        closeSwitchMenus(); closeDrawer(); showSummary(); return;" in JS
        and "if ((msgs.length || j.dept_wrapup || j.calib_done) && !activeShown && !composerLocked()) ensureStageCard(j.overview);" in JS)

s.section("Mid-Year: the review is PM and TM only -- no Career Plan, no IDP or Calibration in the team view")
with a.app.app_context():
    a.get_db().execute("UPDATE cycles SET half=1, kind='mid_year' WHERE id=?", (CID,))
    a.get_db().commit()
_mst = ctx(EMP, lambda db, u: a.review_state(db, u))
s.check("the Career Plan is not a part of a Mid-Year review",
        [x["key"] for x in a._journey_live_stages(_mst)] == ["account", "feedback", "competency"],
        [x["key"] for x in a._journey_live_stages(_mst)])
_msum = ctx(EMP, lambda db, u: a._journey_summary_card(db, u, CID))
s.check("...so the summary is two pages, PM and TM", [p["key"] for p in _msum["data"]["pages"]] == ["pm", "tm"],
        [p["key"] for p in _msum["data"]["pages"]])
_msay = ctx(EMP, lambda db, u: a._journey_completion(db, u, CID)[0])
s.check("...and says 'a summary of both', never the career plan", "summary of both" in _msay and "career plan" not in _msay,
        _msay)
_mts = ctx(MGR, lambda db, u: [x["key"] for x in a._journey_team_live_stages(a.review_state(db, u))])
s.check("the manager's Mid-Year team view has no IDP plan review and no Calibration",
        "plan_review" not in _mts and not any(k.startswith("calibration") for k in _mts), _mts)
_mh = M.get("/review/journey").get_data(as_text=True)
_mtabs = _mh.split('class="rv-modtabs"', 1)[1][:6000] if 'class="rv-modtabs"' in _mh else ""
s.check("...and the page draws the PM and TM tabs but no IDP tab",
        "Performance Management" in _mtabs and "Talent Management" in _mtabs
        and "Individual Development Plan" not in _mtabs, _mtabs[:300])
with a.app.app_context():
    a.get_db().execute("UPDATE cycles SET half=2, kind='year_end' WHERE id=?", (CID,))
    a.get_db().commit()

s.section("not confirmed: the Career Plan only (Chris, 2026-10-19: the IDP is everyone's)")
SCRIPT[:] = ["SHOULD NOT RUN"]; SEEN[:] = []
_ust = ctx(UNE, lambda db, u: a.review_state(db, u))
_ue = [x["key"] for x in a._journey_live_stages(_ust)]
s.check("an unconfirmed employee has their Career Plan and none of their other own parts (though a KPI and a "
        "competency exist)", [k for k in _ue if k != "feedback"] == ["career_plan"]
        and not a._journey_not_required(_ust), _ue)
_ucp = next((x for x in a._journey_live_stages(_ust) if x["key"] == "career_plan"), {})
s.check("...and the plan isn't held back for a check-in and a competency that aren't theirs",
        not a._journey_idp_locked(_ust) and _ucp.get("state") == a.REVIEW_STATE_OPEN and not _ucp.get("locked"), _ucp)
s.check("...their review state says so: no review of their own, a plan of their own",
        _ust["participant"] is False and _ust["idp_participant"] is True)

s.section("taken out of the cycle at Year-End: no review of their own, but the Career Plan stays (Chris, 2026-11-03)")
_ust = ctx(OUT, lambda db, u: a.review_state(db, u))
_ue = [x["key"] for x in a._journey_live_stages(_ust)]
s.check("someone an admin took out has none of their own review parts (a KPI and a competency exist) but their Career Plan, "
        "so they are not told 'not required'",
        not {"account", "checkin", "competency"} & set(_ue) and "career_plan" in _ue and not a._journey_not_required(_ust), _ue)
s.check("...their review state says so: no review of their own, a plan of their own",
        _ust["participant"] is False and _ust["idp_participant"] is True)
_ocp = next((x for x in a._journey_live_stages(_ust) if x["key"] == "career_plan"), {})
s.check("...and the plan isn't held back for a check-in and a competency that aren't theirs",
        not a._journey_idp_locked(_ust) and _ocp.get("state") == a.REVIEW_STATE_OPEN and not _ocp.get("locked"), _ocp)
UE = H.client_as(a, OUT)
SCRIPT[:] = [{"say": "Let's start your Career Plan.", "quick_replies": [], "action": None}]; SEEN[:] = []
_oc = turn(UE, message="", stage="career_plan")
s.check("a turn on the Career Plan reaches the plan, not the 'not required' answer",
        _oc.get("say") != a._JOURNEY_NOT_REQUIRED and not _oc.get("not_required") and _oc.get("stage") == "career_plan",
        (_oc.get("say"), _oc.get("stage"), _oc.get("not_required")))
do_plan(OUT)
_os = post(UE, "/review/ahead/submit")
s.check("they share their Career Plan through its real POST route",
        _os.status_code == 200 and _cnt("SELECT COUNT(*) FROM pm_idp WHERE subject_id=? AND status IN ('shared','closed')", (OUT,)) == 1,
        (_os.status_code, _os.get_json()))
SCRIPT[:] = ["SHOULD NOT RUN"]; SEEN[:] = []

s.section("taken out of the cycle at Mid-Year (no Career Plan then): the same answer under Mine, whichever module; the team view still works")
with a.app.app_context():
    a.get_db().execute("UPDATE cycles SET half=1, kind='mid_year' WHERE id=?", (CID,)); a.get_db().commit()
_ust = ctx(OUT, lambda db, u: a.review_state(db, u))
_ue = [x["key"] for x in a._journey_live_stages(_ust)]
s.check("someone an admin took out has none of their own parts (a KPI and a competency exist); the Career Plan is Year-End's",
        not {"account", "checkin", "competency", "career_plan"} & set(_ue) and a._journey_not_required(_ust), _ue)
with a.app.app_context():
    _n0 = a.get_db().execute("SELECT COUNT(*) c FROM pm_review_chat WHERE subject_id=? AND role='agent'", (OUT,)).fetchone()["c"]
_ans = [turn(UE, message="", stage=stg) for stg in ("account", "feedback", "competency", "career_plan", "pm")]
s.check("whichever module they pick, the answer is 'not required this round' + Group People, no model",
        all(j.get("say") == a._JOURNEY_NOT_REQUIRED and j.get("not_required") for j in _ans) and not SEEN,
        [j.get("say") for j in _ans][:2])
s.check("...someone who manages nobody gets no team offer", all(j.get("quick_replies") == [] for j in _ans))
_q = turn(UE, message="why can't I do my KPIs?", stage="account")
s.check("...a question gets the same answer, never the model", _q.get("say") == a._JOURNEY_NOT_REQUIRED and not SEEN)
with a.app.app_context():
    _nrows = a.get_db().execute("SELECT COUNT(*) c FROM pm_review_chat WHERE subject_id=? AND role='agent'",
                                (OUT,)).fetchone()["c"] - _n0
s.check("...repeated tab clicks don't stack copies of the answer (one per question asked)", _nrows == 2, _nrows)
_pg = UE.get("/review/journey")
_pgt = _pg.get_data(as_text=True)
s.check("the Mine page opens, with the module tabs marked 'not required this round'",
        _pg.status_code == 200 and _pgt.count("not required this round") >= 3 and 'data-stage="pm"' in _pgt,
        (_pg.status_code, _pgt.count("not required this round")))
with a.app.app_context():
    a.get_db().execute("UPDATE cycles SET half=2, kind='year_end' WHERE id=?", (CID,)); a.get_db().commit()
s.check("at Year-End a confirmed employee always has their Career Plan (the IDP is everyone's), so they take part",
        not ctx(NOA, lambda db, u: a._journey_not_required(a.review_state(db, u))))
with a.app.app_context():
    a.get_db().execute("UPDATE cycles SET half=1, kind='mid_year' WHERE id=?", (CID,)); a.get_db().commit()
s.check("...at Mid-Year a confirmed employee with nothing assigned by the admin gets the same answer",
        turn(H.client_as(a, NOA), message="", stage="account").get("say") == a._JOURNEY_NOT_REQUIRED and not SEEN)
with a.app.app_context():
    a.get_db().execute("UPDATE cycles SET half=2, kind='year_end' WHERE id=?", (CID,)); a.get_db().commit()
_ur = [x["key"] for x in a._journey_live_stages(ctx(UNR, lambda db, u: a.review_state(db, u)))]
s.check("an unconfirmed rater an admin put on a colleague's 360 still has that 360 to give, and their Career Plan",
        _ur == ["feedback", "career_plan"], _ur)
UM = H.client_as(a, UNM)
s.check("a line manager taken out of the cycle still has the team view",
        ctx(UNM, lambda db, u: a._review_manages(db, u)) is True)
_umk = [x["key"] for x in a._journey_live_stages(ctx(UNM, lambda db, u: a.review_state(db, u)))]
s.check("...and at Year-End their Career Plan too: a take-out leaves the plan (Chris, 2026-11-03)", "career_plan" in _umk
        and not {"account", "checkin", "competency"} & set(_umk), _umk)
with a.app.app_context():   # at Mid-Year there is no Career Plan, so a taken-out manager has nothing of their own under Mine
    a.get_db().execute("UPDATE cycles SET half=1, kind='mid_year' WHERE id=?", (CID,)); a.get_db().commit()
_um = turn(UM, message="", stage="account")
s.check("...at Mid-Year Mine says not required, then offers the team review with the two chips",
        (_um.get("say") or "").startswith(a._JOURNEY_NOT_REQUIRED) and a._JOURNEY_NOT_REQUIRED_TEAM in (_um.get("say") or "")
        and _um.get("quick_replies") == a._JOURNEY_TEAM_OFFER_CHIPS and not SEEN, _um.get("say"))
_umy = turn(UM, message="yes", stage="account")
s.check("...and 'yes' goes to the team view, which opens", "view=team" in (_umy.get("goto") or "")
        and 'data-view="team"' in UM.get(_umy.get("goto") or "/review/journey?view=team").get_data(as_text=True),
        _umy.get("goto"))

with a.app.app_context():
    a.get_db().execute("UPDATE cycles SET half=2, kind='year_end' WHERE id=?", (CID,)); a.get_db().commit()
ai_draft.review_agent_available, ai_draft.review_agent = _avail0, _agent0
sys.exit(s.done())
