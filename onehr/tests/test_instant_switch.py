"""The instant switch, piece A -- the person's own review (Chris, 2026-10-29: "Approve, build it").

A MOVE is answered by the SERVER: one fixed line from the person's real progress and the part's live card. No model call.

  * a tap (switch=1 from the page's switchStage) and a typed message that is only a part's name are moves: the right
    line for every part and state, the line stored in pm_review_chat, the card and the page chrome with it
  * the model is NOT called on a move (the agent is made to raise) -- but still is for a question, for a move phrased
    in a way OneHR doesn't recognise, and for the forced follow-up after a Save (an empty message alone is no switch)
  * AI model down: a move to every part, a card filled, Save & submit, a reminder: all with review_agent raising
  * the leave-before-submit reminder: when the part is filled in and not submitted (the pop-up's own readiness), not
    while anything is missing, quiet after "Check it later", a second move counts as later, asked again after a
    change, once more on the closing day (MYT), the 360 names every colleague ready; never between colleagues; none
    for the calibration parts; nothing is written by it
  * the safeguard on a model reply (a list of figures or a text table is replaced by the part's pointer line; one
    figure stays), the KPI row highlight, the widened matcher with ONE source of truth shared to the page, the wait
    (loading line + outline after 0.2 s; working line + outline for "show me"), the prompt and the current design

Every guard is falsified once: the check is re-run with the guard patched out and must then FAIL. Writes, so a fresh copy.
"""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
s = H.Suite("The instant switch -- a move is the server's, with no model; the leave-before-submit reminder")

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "..", "app.py")).read()
JS = open(os.path.join(HERE, "..", "static", "journey_chat.js")).read()
CSS = open(os.path.join(HERE, "..", "static", "style.css")).read()
CHBM = "CHIN HIN BUILDING MATERIAL (CHBM)"


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


# ---------------------------------------------------------------------------
s.section("build: people with two KPIs, three competencies and three colleagues to rate")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','tm','idp','pm')")
    db.execute("UPDATE cycle_modules SET active=0 WHERE module_key='evidence'")   # no file gate on a standout KPI
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
    db.execute("UPDATE cycles SET kind='year_end', half=2, starts_on=NULL, open_by_date=0 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    if not db.execute("SELECT 1 FROM pm_bg_config WHERE business_group=?", (CHBM,)).fetchone():
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (CHBM,))
    GRADE = db.execute("SELECT job_grade FROM users WHERE role!='admin' AND left_at IS NULL AND job_grade IS NOT NULL "
                       "ORDER BY id LIMIT 1").fetchone()[0]

    def mk_user(db_, eid, name, mgr=None):
        return db_.execute(
            "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_title, job_grade, manager_id, confirmation_date, years_of_service) "
            "VALUES (?,?,'x','user',?,?,?,?,?,?,?, '2020-01-01', 4.0)",
            (eid, name, eid, CHBM, "ISW Co", "Sales Operations", "Executive", GRADE, mgr)).lastrowid

    def mk(eid, name, mgr=None):
        return mk_user(db, eid, name, mgr)

    globals()["mk_user"] = mk_user
    COLS = [mk("ISW-C%d" % i, "Test Colleague %s" % n) for i, n in enumerate("ABC")]
    CNAME = {COLS[0]: "Test Colleague A", COLS[1]: "Test Colleague B", COLS[2]: "Test Colleague C"}

    def kpi(subj, name):
        return db.execute(
            "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
            "rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?,50.0,'more','approved',?, 9, 11, 12, 13, 15)",
            (CID, subj, name, CHBM)).lastrowid

    def skill(code, title):
        return db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_category, proficiency_description, "
                          "ability_items, active) VALUES (?,?,3,'Operations',?, '- One\n- Two', 1)",
                          (code, title, title + " at the working level")).lastrowid
    SK = [skill("ISW-SK-%d" % i, t) for i, t in enumerate(("ZZ Planning", "ZZ Costing", "ZZ Forecasting"))]

    def person(eid, name, n_cols=3, mgr=None):
        uid = mk(eid, name, mgr)
        ks = [kpi(uid, "ZZ Switch Revenue"), kpi(uid, "ZZ Switch Margin")]
        tcs = [db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, source) "
                          "VALUES (?,?,?,0,'profile')", (CID, uid, sk)).lastrowid for sk in SK]
        fbs = [db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) "
                          "VALUES (?,?,?,'peer','pending')", (CID, c, uid)).lastrowid for c in COLS[:n_cols]]
        return uid, ks, tcs, fbs

    def seed_chat(uid):   # a started conversation: the first turn of an empty transcript is the welcome, tested elsewhere
        db.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) VALUES (?,?,'agent','Hello.', "
                   "'account')", (uid, CID))

    P1, K1, T1, F1 = person("ISW-P1", "Test Person One")      # the lines, state by state
    P2, K2, T2, F2 = person("ISW-P2", "Test Person Two")      # the reminder
    P3, K3, T3, F3 = person("ISW-P3", "Test Person Three")    # the model down
    P4, K4, T4, F4 = person("ISW-P4", "Test Person Four")     # the closing day
    P5, K5, T5, F5 = person("ISW-P5", "Test Person Five")     # the 360 reminder
    P6, K6, T6, F6 = person("ISW-P6", "Test Person Six")      # the closing day
    MGR, KM, TM_, FM = person("ISW-MG", "Test Manager")
    REP = mk("ISW-RP", "Test Report", MGR)
    kr = kpi(REP, "ZZ Report Line")
    db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (kr, MGR))
    for _u in (P1, P2, P3, P4, P5, P6, MGR):
        seed_chat(_u)
    STMTS = {c: [x["statement_id"] for x in a.statements_for_grade(db, GRADE, CID)] for c in COLS}
    db.commit()
s.check("fixture: the colleagues have behaviours to rate", all(STMTS.values()), {k: len(v) for k, v in STMTS.items()})


def make_person(tag):
    """A fresh person (two KPIs, three competencies, three colleagues, a started chat) -- for a flow that must start clean."""
    with a.app.app_context():
        db = a.get_db()
        uid = mk_user(db, "ISW-%s" % tag, "Test Person %s" % tag)
        ks = [db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                         "business_group, rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?,50.0,'more','approved',?,"
                         "9,11,12,13,15)", (CID, uid, n, CHBM)).lastrowid for n in ("ZZ Switch Revenue", "ZZ Switch Margin")]
        tcs = [db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, source) "
                          "VALUES (?,?,?,0,'profile')", (CID, uid, sk)).lastrowid for sk in SK]
        fbs = [db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) "
                          "VALUES (?,?,?,'peer','pending')", (CID, c, uid)).lastrowid for c in COLS]
        db.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) VALUES (?,?,'agent','Hello.',"
                   "'account')", (uid, CID))
        db.commit()
        return uid, ks, tcs, fbs

# ---- the model: counted; "down" raises -----------------------------------------------------------------------------
CALLS, SCRIPT, MODE, SYSTEMS = [0], [], ["script"], []


def stub(system, messages, timeout=90):
    CALLS[0] += 1
    SYSTEMS.append(system)
    if MODE[0] == "down":
        raise ai_draft.AIDraftError("the model is down")
    return SCRIPT.pop(0) if SCRIPT else {"say": "(the model answered)", "quick_replies": [], "action": None}


_avail0, _agent0 = ai_draft.review_agent_available, ai_draft.review_agent
ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = stub


def turn(c, **form):
    r = post(c, "/review/chat?journey=1", **{k: str(v) for k, v in form.items() if v is not None})
    return (r.get_json() or {}) if r.status_code == 200 else {"_status": r.status_code}


def tap(c, to, frm=None, later=False, subject=None, **more):
    f = {"message": "", "stage": to, "switch": "1"}
    if frm:
        f["from"] = frm
    if later:
        f["later"] = "1"
    if subject is not None:
        f["from_subject"] = subject
    f.update(more)
    return turn(c, **f)


def ctx(uid, fn):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        db = a.get_db()
        return fn(db, dict(db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


def agent_rows(uid):
    return H.rows(a, "SELECT content, stage, card FROM pm_review_chat WHERE subject_id=? AND cycle_id=? AND role='agent' "
                     "ORDER BY id", (uid, CID))


def rtypes(j):
    return [r.get("type") for r in (j.get("renders") or [])]


def fill_kpis(c, kids, n=None):
    for k in kids[:n]:
        post(c, "/review/kpi/save-all", **{"actual_value_%d" % k: "12"})


def kpi_remark(c):
    post(c, "/review/kpi/remark", remark="I held the numbers on plan through the second half by renegotiating two "
                                         "supplier contracts and tightening the discount rules for the key accounts.")


def comp_answers(c, tcs, n=None, ans="yes"):
    post(c, "/review/competency/save-all", **{"answer_%d" % t: ans for t in tcs[:n]})


def comp_remark(c):
    post(c, "/review/competency/remark", remark="I plan well and keep the forecast honest; costing is where I'm still "
                                               "building depth, especially on landed cost and supplier terms.")


def fb_fill(c, aid, cid_):
    ans = {"answer_%d" % x: "no" for x in STMTS[cid_]}
    ans[sorted(ans)[0]] = "yes"
    return post(c, "/review/feedback/save-all", assignment_id=str(aid), **ans)


def set_status(table, where, val):
    with a.app.app_context():
        a.get_db().execute("UPDATE %s SET status=? WHERE %s" % (table, where), (val,))
        a.get_db().commit()


def falsified(name, patches, probe):
    """The guard is falsified once: with `patches` ({(obj, attr): value}) applied the probe (the same condition the
    real check asserts) must come out FALSE -- the check is able to fail. Everything is put back."""
    saved = {(o, k): getattr(o, k) for (o, k) in patches}
    try:
        for (o, k), v in patches.items():
            setattr(o, k, v)
        held = bool(probe())
    finally:
        for (o, k), v in saved.items():
            setattr(o, k, v)
    s.check("falsified: " + name, not held)


# ===========================================================================
s.section("a TAP is a move: one fixed line + the card, no model (every part, every state)")
E1 = H.client_as(a, P1)
MODE[0] = "down"          # the model raises: any call would turn the line into an apology
n0 = CALLS[0]
j = tap(E1, "competency")
n_comp = len(ctx(P1, lambda db, u: [i for i in a._journey_nav_items_base(db, u, "competency")["items"]
                                    if i["id"] not in ("remark", "confirm")]))
s.check("the competency tab: the fresh line, from the left panel's own count of competencies",
        j.get("say") == ("Here's your Competency Assessment: %d competencies. Rate each one on your card, and ask me "
                         "what any of them means." % n_comp) and n_comp == 3, n_comp)
s.check("...no model call, the part's card with it, and the page chrome (tabs + left panel) for the new part",
        CALLS[0] == n0 and "competency_progress" in rtypes(j) and j.get("stage") == "competency" and j.get("moved") is True
        and j.get("switched") is True and bool(j.get("modtabs_html")) and bool(j.get("nav_html"))
        and (j.get("overview") or {}).get("stage") == "competency", (CALLS[0] - n0, rtypes(j)))
s.check("...the chips are questions (they go to the model)",
        j.get("quick_replies") == ["What do the levels mean?", "Help me write my remark"], j.get("quick_replies"))
rows_ = agent_rows(P1)
s.check("...the line is stored in pm_review_chat like any message, with its card, filed under the new part",
        rows_ and rows_[-1]["content"] == j["say"] and rows_[-1]["stage"] == "competency"
        and "competency_progress" in (rows_[-1]["card"] or ""), len(rows_))

j = tap(E1, "feedback")
first = ctx(P1, lambda db, u: a._feedback_assignments(db, u, CID)[0]["name"])
s.check("the 360 tab: 'Here's your 360 Feedback: 3 colleagues to give feedback on. First up: <the first still to do>.'",
        j.get("say") == "Here's your 360 Feedback: 3 colleagues to give feedback on. First up: %s." % first
        and "feedback_progress" in rtypes(j) and first in (j.get("nav_html") or ""), len(j.get("say") or ""))

j = tap(E1, "account")
s.check("the KPI tab, nothing entered: 'Here's your KPI check-in: 2 KPIs. Enter each result in the table...'",
        j.get("say") == "Here's your KPI check-in: 2 KPIs. Enter each result in the table, and ask me about any KPI as "
                        "you go." and "kpi_progress" in rtypes(j)
        and j.get("quick_replies") == ["Explain my KPIs", "Help me write my remark"], j.get("say"))

fill_kpis(E1, K1, 1)
tap(E1, "competency")
j = tap(E1, "account")
nxt = ctx(P1, lambda db, u: a._switch_pending(db, u, "account")[0])
s.check("some KPIs in: 'Back to your KPI check-in: 1 of 2 results in. Next up: <KPI>.' -- the left panel's count and its "
        "first pending KPI", j.get("say") == "Back to your KPI check-in: 1 of 2 results in. Next up: %s." % nxt
        and "1 of 2 results in" in (j.get("nav_html") or "") and nxt in (j.get("nav_html") or ""), j.get("say"))

fill_kpis(E1, K1)
tap(E1, "competency")
j = tap(E1, "account")
s.check("all results in, no remark: 'All 2 results are in. Add your overall remark, then Save & submit when you're ready.'",
        j.get("say") == "All 2 results are in. Add your overall remark, then Save & submit when you're ready.", j.get("say"))
kpi_remark(E1)
j = turn(E1, message="", stage="account", switch="1")       # no from: a tap with nothing to leave
s.check("...with the remark written the line says so",
        j.get("say") == "All 2 results are in, and your overall remark is written. Save & submit when you're ready.",
        j.get("say"))

comp_answers(E1, T1, 1)
j = tap(E1, "competency")
nxt = ctx(P1, lambda db, u: a._switch_pending(db, u, "competency")[0])
s.check("competency partly rated: 'Back to your Competency Assessment: 1 of 3 rated. Next up: <competency>.'",
        j.get("say") == "Back to your Competency Assessment: 1 of 3 rated. Next up: %s." % nxt
        and "1 of 3 answered" in (j.get("nav_html") or ""), j.get("say"))
comp_answers(E1, T1)
j = tap(E1, "feedback", None)
j = tap(E1, "competency")
s.check("all rated, no remark: 'All 3 are rated. Add your overall remark, then Save & submit when you're ready.'",
        j.get("say") == "All 3 are rated. Add your overall remark, then Save & submit when you're ready.", j.get("say"))

# the 360: some done, all done
set_status("assignments", "id=%d" % F1[0], "submitted")
j = tap(E1, "feedback")
pend = ctx(P1, lambda db, u: [x["name"] for x in a._feedback_assignments(db, u, CID) if x["status"] != "submitted"][0])
s.check("360 some done: 'Back to your 360 Feedback: 1 of 3 colleagues done. Next up: <colleague>.'",
        j.get("say") == "Back to your 360 Feedback: 1 of 3 colleagues done. Next up: %s." % pend, len(j.get("say") or ""))
set_status("assignments", "id IN (%d,%d)" % (F1[1], F1[2]), "submitted")
j = tap(E1, "account")
j = tap(E1, "feedback")
s.check("360 all done: 'All your 360 feedback is in. Thank you.' (the chips are the parts still open)",
        j.get("say") == "All your 360 feedback is in. Thank you." and j.get("quick_replies"), j.get("say"))

# the Career Plan: locked, then its entry, then in progress, then shared
j = tap(E1, "career_plan")
s.check("Career Plan while the KPI check-in and competency are open: the locked line, no move, no model",
        j.get("say") == "Your Career Plan opens once your KPI check-in and Competency Assessment are submitted."
        and j.get("moved") is False and j.get("stage") != "career_plan", (j.get("say"), j.get("stage")))
post(E1, "/review/confirm")
comp_remark(E1)
post(E1, "/review/competency/submit")
j_sub = tap(E1, "account")
s.check("a submitted KPI check-in: 'Your KPI check-in is submitted, so it's read-only now. Here's what you sent.'",
        j_sub.get("say") == "Your KPI check-in is submitted, so it's read-only now. Here's what you sent."
        and "kpi_progress" in rtypes(j_sub), j_sub.get("say"))
j_sub = tap(E1, "competency")
s.check("a submitted competency: 'Your Competency Assessment is submitted, so it's read-only now.'",
        j_sub.get("say") == "Your Competency Assessment is submitted, so it's read-only now.", j_sub.get("say"))
entry = ctx(P1, lambda db, u: a._journey_career_entry(db, u, CID))
j = tap(E1, "career_plan")
if entry is not None:
    s.check("Career Plan not started: unchanged -- the direction box line and card",
            j.get("say") == entry[0] and "career_direction" in rtypes(j), j.get("say"))
else:
    s.note("no candidate roles for this fixture person: the direction box is not drawn, so the in-progress line is checked")
    s.check("Career Plan with no direction box: the step line", (j.get("say") or "").startswith("Back to your Career Plan"),
            j.get("say"))
def _plan(uid, profile=True):
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
_plan(P1, profile=False)
j = tap(E1, "feedback")
j = tap(E1, "career_plan")
steps = ctx(P1, lambda db, u: a._journey_idp_steps(db, u))
cur = next(i for i, x in enumerate(steps) if x.get("current"))
s.check("Career Plan in progress: 'Back to your Career Plan: step X of N, <step name>.' (the panel's own steps)",
        j.get("say") == "Back to your Career Plan: step %d of %d, %s." % (cur + 1, len(steps), steps[cur]["name"]),
        (cur, len(steps)))
ctx(P1, lambda db, u: (a.pm_career_save_field(db, P1, "aspiration_mid", "Regional operations lead"),
                       a.pm_career_save_field(db, P1, "mobility", "same_company")))
post(E1, "/review/ahead/submit")
j = tap(E1, "feedback")
j = tap(E1, "career_plan")
s.check("Career Plan shared: 'Your Career Plan is shared with your line manager, so it's read-only now.'",
        j.get("say") == "Your Career Plan is shared with your line manager, so it's read-only now.", j.get("say"))
s.check("every fixed line: never a band, a score, 'Reopen' or 'HR'",
        not any(re.search(r"\bband\b|\bscore\b|reopen|\bHR\b", r["content"], re.I) for r in agent_rows(P1)
                if r["content"] and r["stage"]), None)

# a part not open yet, and one closed by its deadline
with a.app.app_context():
    a.get_db().execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,NULL)",
                       (CID, "pm_results", "2099-01-05 09:00"))
    a.get_db().commit()
E3 = H.client_as(a, P3)
j = tap(E3, "account")
s.check("a KPI check-in not open yet: 'Your KPI check-in opens on [date]. You can look through your KPIs now...'",
        j.get("say") == "Your KPI check-in opens on 05 Jan 2099, 09:00. You can look through your KPIs now, and ask me how "
                        "it works.", j.get("say"))
with a.app.app_context():
    a.get_db().execute("UPDATE cycle_windows SET opens_at=NULL, closes_at='2020-01-05 09:00' WHERE cell='pm_results' "
                       "AND cycle_id=?", (CID,))
    a.get_db().commit()
j = tap(E3, "account")
s.check("a KPI check-in closed by its deadline: today's window line, then looking through it",
        (j.get("say") or "").startswith("The results check-in closed on 05 Jan 2020, 09:00.")
        and (j.get("say") or "").endswith("You can still look through it."), j.get("say"))
with a.app.app_context():
    a.get_db().execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    a.get_db().commit()

# ===========================================================================
s.section("a TYPED part name is the same move; asking still goes to the model")
E3 = H.client_as(a, P3)
MODE[0] = "down"
PICKS = [("go to my competency", "competency"), ("switch to competency", "competency"), ("360 please", "feedback"),
         ("back to my KPI", "account"), ("go back to the KPI check-in", "account"), ("bring me to my 360", "feedback"),
         ("jump to competency", "competency"), ("let's start with 360", "feedback"), ("can we do competency", "competency"),
         ("show me my competency", "competency"), ("Competency Assessment", "competency"), ("KPI", "account")]
ok_all, bad = True, []
for text, want in PICKS:
    cur = {"account": "competency", "feedback": "competency", "competency": "feedback"}[want]
    n0 = CALLS[0]
    jj = turn(E3, message=text, stage=cur)
    good = (CALLS[0] == n0 and jj.get("stage") == want and jj.get("moved") is True and jj.get("switched") is True
            and bool(jj.get("say")) and "model" not in (jj.get("say") or "").lower() and jj.get("_status") is None)
    if not good:
        ok_all = False
        bad.append(text)
s.check("typed moves (switch to, back to, go back to, bring me to, jump to, let's start with, can we do, show me my, a "
        "bare name) are answered by the server: right part, moved, no model call", ok_all, bad)
last = agent_rows(P3)[-1]
s.check("...the typed words are stored as the person's, the server's line as the agent's, under the new part",
        last["stage"] == "account", last["stage"])
mrows = H.rows(a, "SELECT role, content FROM pm_review_chat WHERE subject_id=? AND role='user' ORDER BY id DESC LIMIT 1",
               (P3,))
s.check("...the user's message is stored", mrows and mrows[0]["content"] == "KPI", mrows)

n0 = CALLS[0]
j = turn(E3, message="KPI", stage="account")
s.check("naming the part they are ON: 'You're on your KPI check-in. Next up: ...' -- fixed, no model, not a move",
        j.get("say", "").startswith("You're on your KPI check-in. Next up: ") and j.get("moved") is False
        and CALLS[0] == n0 and "kpi_progress" in rtypes(j), j.get("say"))

MODE[0] = "script"
for text in ("what is my target?", "show me my KPI detail", "go to my KPI and explain my rating", "show me my KPI 2",
             "tell me about my career plan", "switch to competency and tell me what level I am"):
    n0 = CALLS[0]
    SCRIPT[:] = [{"say": "Here it is.", "quick_replies": [], "action": None}]
    turn(E3, message=text, stage="account")
    s.check("asking goes to the model: %r" % text, CALLS[0] == n0 + 1, CALLS[0] - n0)
# a move phrased in a way OneHR does not recognise goes to the model, which still moves them
n0 = CALLS[0]
SCRIPT[:] = [{"say": "Moving you to your competency.", "quick_replies": [], "action": {"tool": "go_to_stage",
                                                                                          "args": {"stage": "competency"}}},
             {"say": "You're on your competency now.", "quick_replies": [], "action": None}]
j = turn(E3, message="could you perhaps hop across to the competency stuff", stage="account")
s.check("a move OneHR doesn't recognise goes to the model, which still moves them (go_to_stage)",
        CALLS[0] > n0 and j.get("stage") == "competency" and j.get("moved") is True, (CALLS[0] - n0, j.get("stage")))

n0 = CALLS[0]
SCRIPT[:] = [{"say": "(model)", "quick_replies": [], "action": None}]
j = turn(E3, message="", stage="competency")
s.check("the forced follow-up (an empty message, no switch=1) is NOT a switch: the model answers it",
        CALLS[0] == n0 + 1 and j.get("say") == "(model)" and not j.get("switched"), CALLS[0] - n0)
SCRIPT[:] = [{"say": "(model)", "quick_replies": [], "action": None}]
n0 = CALLS[0]
j = turn(E3, message="", stage="competency", after_save=T3[0])
s.check("...nor is the one after a Save (after_save)", CALLS[0] == n0 + 1 and not j.get("switched"), CALLS[0] - n0)
falsified("a tap without switch=1 (the old client) reaches the model -- the flag is what makes it a move",
          {}, lambda: (lambda n: (SCRIPT.__setitem__(slice(None), [{"say": "(model)", "quick_replies": [], "action": None}]),
                                  turn(E3, message="", stage="competency", frm="account"), CALLS[0] == n)[2])(CALLS[0]))
n0 = CALLS[0]
falsified("typed picks answered by the server (with _journey_stage_pick blind, the model is called)",
          {(a, "_journey_stage_pick"): lambda *x, **k: None},
          lambda: (lambda n: (turn(E3, message="go to my competency", stage="account"), CALLS[0] == n)[1])(CALLS[0]))
falsified("the widened matcher (with the old lead, 'switch to competency' is no pick)",
          {(a, "_JOURNEY_PICK_LEAD_RE"): re.compile(
              r"^(?:(?:ok(?:ay)?|sure|yes|yeah|great|cool)\s+)?(?:(?:let'?s|lets)\s+(?:do|go\s+to|start|move\s+(?:on\s+)?to|"
              r"begin)|go\s+to|take\s+me\s+to|move\s+(?:on\s+)?to|open|start(?:\s+with)?|begin(?:\s+with)?|"
              r"continue\s+(?:with|to)|on\s+to|onto|next\s*:?|i'?d\s+like\s+to\s+do|i\s+want\s+to\s+do|do)?\s*"
              r"(?:the|my)?\s*", re.I)},
          lambda: ctx(P3, lambda db, u: a._journey_stage_pick(a.review_state(db, u), "account",
                                                            "switch to competency")) == "competency")

st3 = ctx(P3, lambda db, u: a.review_state(db, u))
cap = ctx(P3, lambda db, u: a._journey_stage_pick(a.review_state(db, u), "account", "go to " + "competency " * 6))
s.check("the 60-character cap and the whole-message rule hold ('show me my competency details' is no pick)",
        cap is None and ctx(P3, lambda db, u: a._journey_stage_pick(a.review_state(db, u), "account",
                                                                   "show me my competency details")) is None
        and ctx(P3, lambda db, u: a._journey_stage_pick(a.review_state(db, u), "account", "show me my 360")) == "feedback")

# ===========================================================================
s.section("AI model down: move to every part, fill a card, Save & submit -- all with review_agent raising")
E3 = H.client_as(a, P3)
MODE[0] = "down"
n0 = CALLS[0]
got = {}
for st_ in ("feedback", "competency", "account", "feedback", "account"):
    jj = tap(E3, st_)
    got[st_ + str(len(got))] = (jj.get("stage") == st_ and jj.get("switched") is True
                                and "lost the thread" not in (jj.get("say") or ""))
s.check("a tap to every part answers while the model is down (no apology, the part's own line and card)",
        all(got.values()) and CALLS[0] == n0, got)
r_save = post(E3, "/review/kpi/save-all", **{"actual_value_%d" % k: "12" for k in K3})
s.check("the KPI card fills and saves (the card's own route, no model)", r_save.status_code == 200
        and all(H.one(a, "SELECT COUNT(*) FROM pm_kpi_results WHERE kpi_target_id=?", (k,)) >= 1 for k in K3),
        r_save.status_code)
kpi_remark(E3)
pv = E3.get("/review/signoff/preview?stage=account").get_json() or {}
s.check("Save & submit: the pop-up's preview is ready", pv.get("ok") and pv.get("ready") is True, pv.get("blockers"))
rc = post(E3, "/review/confirm")
s.check("...Confirm submits (the card's route, no model) and locks the check-in",
        rc.status_code == 200 and ctx(P3, lambda db, u: a.pm_review_locked(db, P3, CID)), rc.status_code)
n_fu = CALLS[0]
jf = turn(E3, message="", stage="account", after_signoff="confirm")
s.check("...and the follow-up after the submit, with the model down, says it is done -- never 'I lost the thread'",
        jf.get("say") and "lost the thread" not in jf["say"] and "submitted" in jf["say"].lower(), jf.get("say"))
comp_answers(E3, T3)
comp_remark(E3)
j = tap(E3, "feedback", "competency")
s.check("a competency filled in but not submitted holds the move with the reminder, model down",
        j.get("stay") is True and rtypes(j) == ["switch_reminder"], rtypes(j))
j = tap(E3, "feedback", "competency", later=True)
s.check("...and 'Check it later' moves, model down", j.get("stage") == "feedback" and j.get("moved") is True, j.get("stage"))
pv = E3.get("/review/signoff/preview?stage=competency").get_json() or {}
rs = post(E3, "/review/competency/submit")
s.check("...and Save & submit of the competency works too (preview ready, Confirm submits), model down",
        pv.get("ready") is True and rs.status_code == 200, (pv.get("ready"), rs.status_code))
s.check("the model was not called at all -- not for a move, a fill, a reminder, a submit or the follow-up after it "
        "(the server says 'done' itself)", CALLS[0] == n0, CALLS[0] - n0)

# ===========================================================================
s.section("the leave-before-submit reminder")
MODE[0] = "down"
E2 = H.client_as(a, P2)
comp_answers(E2, T2)
j = tap(E2, "account", "competency")
s.check("competency answered but no remark yet (the pop-up's own gate): no reminder, the move happens",
        j.get("stage") == "account" and "switch_reminder" not in rtypes(j), rtypes(j))
tap(E2, "competency", "account")
comp_remark(E2)
tcs0 = H.one(a, "SELECT COUNT(*) FROM tc_scores sc JOIN tc_assessments t ON t.id=sc.assessment_id WHERE t.subject_id=?", (P2,))
st0 = H.one(a, "SELECT status FROM tc_assessments WHERE subject_id=? AND cycle_id=?", (P2, CID))
pm0 = H.one(a, "SELECT COUNT(*) FROM pm_review_chat WHERE subject_id=?", (P2,))
n0 = CALLS[0]
j = tap(E2, "account", "competency")
pv = ctx(P2, lambda db, u: a._signoff_preview(db, u, CID, "competency"))
s.check("filled in and not submitted (the pop-up's readiness is true): the move is HELD once -- the fixed line, a card, "
        "no model", pv["ready"] is True and j.get("stay") is True and j.get("stage") == "competency"
        and j.get("moved") is False and rtypes(j) == ["switch_reminder"] and CALLS[0] == n0,
        (pv["ready"], j.get("stay"), rtypes(j)))
LINE = ("Before you go: your Competency Assessment is all filled in but not submitted yet. I'd submit it now so it reaches "
        "your line manager. If you'd like to look it over again first, it will wait for you here.")
s.check("...the line is the table's, word for word", j.get("say") == LINE, j.get("say"))
d = (j.get("renders") or [{}])[0].get("data") or {}
s.check("...the card carries both buttons' targets: Save & submit [part], Check it later, go to [new part]",
        d.get("part") == "Competency Assessment" and d.get("to_part") == "KPI check-in" and d.get("stage") == "competency"
        and d.get("to_stage") == "account", d)
s.check("...the held turn is stored (the line, with its card) and writes nothing else: no score, no status change",
        H.one(a, "SELECT COUNT(*) FROM tc_scores sc JOIN tc_assessments t ON t.id=sc.assessment_id WHERE t.subject_id=?",
              (P2,)) == tcs0
        and H.one(a, "SELECT status FROM tc_assessments WHERE subject_id=? AND cycle_id=?", (P2, CID)) == st0
        and H.one(a, "SELECT COUNT(*) FROM pm_review_chat WHERE subject_id=?", (P2,)) == pm0 + 1)
with E2.session_transaction() as sess:
    held = (sess.get("instant_switch") or {}).get("held")
s.check("...the state is in the Flask session only: a fingerprint of the part's saved answers, no schema change",
        bool(held) and "competency" in held and len(held["competency"]) == 16, held)
s.check("the card's Save & submit only opens the existing pop-up (openSignoff); the page never submits from the card",
        'yes.addEventListener("click", function () { openSignoff(d.stage, d.aid); });' in JS)

# a second move while the reminder is up counts as "Check it later"
j = tap(E2, "feedback", "competency")
s.check("a SECOND move while the reminder is up counts as 'Check it later': it moves at once", j.get("stage") == "feedback"
        and j.get("moved") is True and "switch_reminder" not in rtypes(j), (j.get("stage"), rtypes(j)))
tap(E2, "competency", "feedback")
j = tap(E2, "account", "competency")
s.check("...and that part is quiet afterwards (same answers: no second reminder)", j.get("stage") == "account", rtypes(j))
# asked again after a change
tap(E2, "competency", "account")
comp_answers(E2, T2[:1], ans="no")
j = tap(E2, "account", "competency")
s.check("asked again after something changes in that part and they leave again", j.get("stay") is True, rtypes(j))
j = tap(E2, "account", "competency", later=True)
s.check("'Check it later, go to KPI check-in' (later=1) moves at once", j.get("stage") == "account", j.get("stage"))

# a typed move leaving a part is held too; the second typed move counts as later
E4 = H.client_as(a, P4)
comp_answers(E4, T4)
comp_remark(E4)
j = turn(E4, message="go to my KPI", stage="competency")
s.check("a TYPED move leaving a filled-in part is held too (the typed words are filed under the part left)",
        j.get("stay") is True and rtypes(j) == ["switch_reminder"]
        and H.rows(a, "SELECT stage FROM pm_review_chat WHERE subject_id=? AND role='user' ORDER BY id DESC LIMIT 1",
                   (P4,))[0]["stage"] == "competency", rtypes(j))
j = turn(E4, message="go to my 360", stage="competency")
s.check("...a second typed move counts as later", j.get("stage") == "feedback" and j.get("moved") is True, j.get("stage"))

# the 360: one reminder naming every ready colleague
E5 = H.client_as(a, P5)
for c_, aid in zip(COLS[:2], F5[:2]):
    fb_fill(E5, aid, c_)
j = tap(E5, "competency", "feedback")
s.check("the 360: colleagues A and B ready, not yet C -- ONE reminder naming every ready colleague, none else",
        j.get("stay") is True and "Test Colleague A and Test Colleague B" in (j.get("say") or "")
        and "Test Colleague C" not in (j.get("say") or "") and j["say"].startswith("Before you go: your feedback for "),
        len(j.get("say") or ""))
dd = (j.get("renders") or [{}])[0].get("data") or {}
s.check("...its Save & submit opens the first ready colleague", dd.get("aid") == F5[0]
        and dd.get("names") == ["Test Colleague A", "Test Colleague B"], dd.get("aid"))
j = tap(E5, "competency", "feedback", later=True)
s.check("'Check it later, go to Competency' moves at once", j.get("stage") == "competency", j.get("stage"))
tap(E5, "feedback", "competency")
j = tap(E5, "competency", "feedback")
s.check("...and the 360 is quiet after that (nothing changed)", j.get("stage") == "competency"
        and "switch_reminder" not in rtypes(j), rtypes(j))
fb_fill(E5, F5[2], COLS[2])
tap(E5, "feedback", "competency")
j = tap(E5, "competency", "feedback")
s.check("...asked again once something changes (C is now filled in too): the reminder names all three",
        j.get("stay") is True and all(CNAME[c] in (j.get("say") or "") for c in COLS), len(j.get("say") or ""))
s.check("never between colleagues: the colleague switch is client-side and sends no turn (fbSelectPeer has no sendTurn)",
        "sendTurn(" not in re.search(r"function fbSelectPeer\(.*?\n  }\n", JS, re.S).group(0))
s.check("...and a same-part tap is no move (from == stage): no reminder",
        "switch_reminder" not in rtypes(tap(E5, "feedback", "feedback")))

# the closing day
E6c = H.client_as(a, P6)
comp_answers(E6c, T6)
comp_remark(E6c)
tap(E6c, "account", "competency", later=True)        # seen once and put off: quiet
tap(E6c, "competency", "account")
j = tap(E6c, "account", "competency")
s.check("(before the closing day) a part put off is quiet", j.get("stage") == "account", rtypes(j))
with a.app.app_context():
    a.get_db().execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,NULL,?)",
                       (CID, "tc_self", a._today_myt().strftime("%Y-%m-%d") + " 23:59"))
    a.get_db().commit()
tap(E6c, "competency", "account")
j = tap(E6c, "account", "competency")
s.check("on the part's closing day (MYT), still not submitted: asked once more even though nothing changed",
        j.get("stay") is True and rtypes(j) == ["switch_reminder"], rtypes(j))
tap(E6c, "feedback", "competency", later=True)
tap(E6c, "competency", "feedback")
j = tap(E6c, "account", "competency")
s.check("...and only once that day", j.get("stage") == "account" and "switch_reminder" not in rtypes(j), rtypes(j))

# a line manager gets it too; the team view and the calibration parts never
EM = H.client_as(a, MGR)
comp_answers(EM, TM_)
comp_remark(EM)
j = tap(EM, "account", "competency")
s.check("a line manager in their own review gets the reminder like staff", j.get("stay") is True, rtypes(j))
s.check("none for the calibration parts (HOD, BU CEO / calibrator, BG CEO, Group Chief): only the person's own four parts "
        "and the line manager's three (piece B) can ever be held",
        all(ctx(MGR, lambda db, u, k=k: a._switch_leave_check(db, u, CID, k, later=lv)) is None
            for k in ("calibration", "calibration_pot", "talent_box", "group_calib") for lv in (False, True)))
MODE[0] = "down"

# ---- falsify every reminder guard: patched out, the same probe must come out wrong ----
def _held_for(uid, tcs, remark=True, answered=True, frm="competency", to="account"):
    """Fresh person state -> does leaving `frm` for `to` come back as the reminder?"""
    c = H.client_as(a, uid)
    return "switch_reminder" in rtypes(tap(c, to, frm))


falsified("readiness: a half-filled part is held when the pop-up's readiness is ignored (P1's competency, answered, no "
          "remark yet, would be held)",
          {(a, "_switch_ready"): lambda db, u, cid, stage: {"names": [], "aid": None, "fp": "x"}},
          lambda: not _held_for(P4, T4, frm="account", to="competency"))
s.check("(the guard it falsifies) a part that is NOT ready is never held",
        not _held_for(P4, T4, frm="account", to="competency"))
falsified("quiet after Check it later: with the session's memory gone, the part is held again",
          {(a, "_switch_state"): lambda cid: {"cid": cid, "later": {}, "held": {}, "day": {}}},
          lambda: not _held_for(P6, T6))
falsified("a second move counts as later: with the held mark forgotten, a second move would be held again",
          {(a, "_switch_state"): lambda cid: {"cid": cid, "later": {}, "held": {}, "day": {}}},
          lambda: "switch_reminder" not in rtypes(tap(H.client_as(a, P4), "account", "competency")))
with a.app.app_context():   # the closing-day window of the check above comes off: the next flows are ordinary days
    a.get_db().execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    a.get_db().commit()


def flow_change(uid, tcs):
    """Filled in, put off with Check it later, one answer changed, left again: is it asked again?"""
    c = H.client_as(a, uid)
    comp_answers(c, tcs)
    comp_remark(c)
    tap(c, "account", "competency", later=True)
    tap(c, "competency", "account")
    comp_answers(c, tcs[:1], ans="no")
    return "switch_reminder" in rtypes(tap(c, "account", "competency"))


U7, _k7, T7, _f7 = make_person("P7")
s.check("(the guard it falsifies) a change in a part that was put off is asked about again", flow_change(U7, T7))
U8, _k8, T8, _f8 = make_person("P8")
falsified("the fingerprint: with a constant one, a change in the part is never noticed",
          {(a, "_switch_ready"): (lambda orig: (lambda db, u, cid, stage: dict(orig(db, u, cid, stage) or {}, fp="same")
                                                if orig(db, u, cid, stage) else None))(a._switch_ready)},
          lambda: flow_change(U8, T8))


def flow_closing(uid, tcs):
    c = H.client_as(a, uid)
    comp_answers(c, tcs)
    comp_remark(c)
    tap(c, "account", "competency", later=True)         # put off on an ordinary day
    with a.app.app_context():
        a.get_db().execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,NULL,?)",
                           (CID, "tc_self", a._today_myt().strftime("%Y-%m-%d") + " 23:59"))
        a.get_db().commit()
    tap(c, "competency", "account")
    held = "switch_reminder" in rtypes(tap(c, "account", "competency"))
    with a.app.app_context():
        a.get_db().execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        a.get_db().commit()
    return held


with a.app.app_context():
    a.get_db().execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    a.get_db().commit()
U9, _k9, T9, _f9 = make_person("P9")
falsified("the closing-day arm: with it off, a part put off is never asked about again on its closing day",
          {(a, "_switch_closing_day"): lambda *x: False}, lambda: flow_closing(U9, T9))
U10, _k10, T10, F10 = make_person("P10")
c10 = H.client_as(a, U10)
for c_, aid in zip(COLS, F10):
    fb_fill(c10, aid, c_)
falsified("the 360 names every ready colleague: truncated to the first, the check on all three fails",
          {(a, "_switch_ready"): (lambda orig: (lambda db, u, cid, stage: (lambda r: dict(r, names=r["names"][:1])
                                                                         if r and r.get("names") else r)(
              orig(db, u, cid, stage))))(a._switch_ready)},
          lambda: all(CNAME[x] in (tap(c10, "competency", "feedback").get("say") or "") for x in COLS))
falsified("the calibration parts are never held: with _SIGNOFF_STAGES widened to them and readiness faked, they would be",
          {(a, "_SIGNOFF_STAGES"): a._SIGNOFF_STAGES + ("calibration",),
           (a, "_switch_ready"): lambda db, u, cid, stage: {"names": [], "aid": None, "fp": "z"}},
          lambda: ctx(MGR, lambda db, u: a._switch_leave_check(db, u, CID, "calibration")) is None)

# ===========================================================================
s.section("PIECE B -- the line manager's parts: a move is the server's, from the team's real progress")
TXT = ("I held this on plan through the second half by renegotiating two supplier contracts and tightening the "
       "discount rules for the key accounts.")


def make_team(tag, plan=True):
    """A line manager with two reports who have submitted their KPI check-in and competency (and the first, a shared plan)."""
    with a.app.app_context():
        db = a.get_db()
        mgr = mk_user(db, "ISW-TM%s" % tag, "Test Manager %s" % tag)
        reps = []
        for i in (1, 2):
            r_ = mk_user(db, "ISW-TR%s%d" % (tag, i), "Test Report %s%d" % (tag, i), mgr)
            k_ = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                            "business_group, rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?,100.0,'more','approved',?,"
                            "9,11,12,13,15)", (CID, r_, "ZZ Line %s%d" % (tag, i), CHBM)).lastrowid
            db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (k_, mgr))
            tcs = [db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, source) "
                              "VALUES (?,?,?,0,'profile')", (CID, r_, sk)).lastrowid for sk in SK[:2]]
            db.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) VALUES (?,?,'agent',"
                       "'Hello.','account')", (r_, CID))
            reps.append((r_, k_, tcs))
        db.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) VALUES (?,?,'agent','Hello.',"
                   "'account')", (mgr, CID))
        db.commit()
    for r_, k_, tcs in reps:
        c = H.client_as(a, r_)
        post(c, "/review/kpi/save-all", **{"actual_value_%d" % k_: "12"})
        kpi_remark(c)
        post(c, "/review/confirm")
        comp_answers(c, tcs)
        comp_remark(c)
        post(c, "/review/competency/submit")
    if plan:
        _plan(reps[0][0])
        post(H.client_as(a, reps[0][0]), "/review/ahead/submit")
    return {"mgr": mgr, "reps": reps, "c": H.client_as(a, mgr)}


def team_turn(T, stage, **more):
    f = {"message": "", "stage": stage, "view": "team", "mode": "summary"}
    f.update(more)
    return turn(T["c"], **f)


def team_tap(T, to, frm=None, later=False, **more):
    f = {"switch": "1"}
    if frm:
        f["from"] = frm
    if later:
        f["later"] = "1"
    f.update(more)
    return team_turn(T, to, **f)


def ready_pm(T, i=0, value="13"):
    r_, k_, _t = T["reps"][i]
    post(T["c"], "/performance/kpi/%d/moderate-draft-autosave" % k_, adjusted_value=value)
    ctx(T["mgr"], lambda db, u: a._pm_manager_remark_write(db, u, a.active_pm_period(db), r_, TXT))


def ready_tm(T, i=0):
    r_, _k, tcs = T["reps"][i]
    post(T["c"], "/technical/team/%d/autosave" % r_, assignment_id=str(tcs[0]), manager_answer="no")
    ctx(T["mgr"], lambda db, u: a._tc_manager_remark_write(db, u, CID, r_, TXT))


def ready_plan(T):
    r_ = T["reps"][0][0]
    post(T["c"], "/review/team/idp-remark", report=str(r_), remark=TXT)


MODE[0] = "down"
TA = make_team("A")
rows_pm = ctx(TA["mgr"], lambda db, u: a._journey_team_reports(db, u, "pm_review"))
n0 = CALLS[0]
j = team_tap(TA, "pm_review")
nm_next = next(r["name"] for r in rows_pm if not r["done"] and r.get("action"))
s.check("a tab move to the KPI reviews: 'Your team's KPI reviews: x of n done. Next up: <name>.' from the team's own list, "
        "no model", j.get("say") == "Your team's KPI reviews: %d of %d done. Next up: %s."
        % (sum(1 for r in rows_pm if r["done"]), len(rows_pm), nm_next) and CALLS[0] == n0
        and j.get("moved") is True and j.get("switched") is True and "stage_focus" in rtypes(j)
        and nm_next in (j.get("nav_html") or ""), CALLS[0] - n0)
rowt = agent_rows_t = H.rows(a, "SELECT content, stage FROM pm_manager_chat WHERE reviewer_id=? AND role='agent' ORDER BY id DESC "
                                 "LIMIT 1", (TA["mgr"],))
s.check("...the line is stored like any manager message, under the new part", rowt and rowt[0]["content"] == j["say"]
        and rowt[0]["stage"] == "pm_review", rowt)
rows_tm = ctx(TA["mgr"], lambda db, u: a._journey_team_reports(db, u, "tm_review"))
j = team_tap(TA, "tm_review", "pm_review")
s.check("the competency reviews: 'Your team's competency reviews: x of n done. Next up: <name>.'",
        j.get("say") == "Your team's competency reviews: 0 of %d done. Next up: %s." % (
            len(rows_tm), next(r["name"] for r in rows_tm if r.get("action"))) and CALLS[0] == n0, j.get("say"))
j = team_tap(TA, "plan_review", "tm_review")
s.check("the plan reviews say it too (the first plan is the only one shared, and it still needs the remark)",
        (j.get("say") or "").startswith("Your team's Career Plan reviews: 0 of 2 done.") and CALLS[0] == n0, j.get("say"))
j = team_turn(TA, "tm_review", message="go to pm")
s.check("a typed pure part name ('go to pm') moves too, through the team's own matcher, no model",
        j.get("stage") == "pm_review" and j.get("moved") is True and j.get("switched") is True and CALLS[0] == n0,
        (j.get("stage"), CALLS[0] - n0))
s.check("the typed words are stored as the manager's",
        H.rows(a, "SELECT content, stage FROM pm_manager_chat WHERE reviewer_id=? AND role='user' ORDER BY id DESC LIMIT 1",
               (TA["mgr"],))[0]["content"] == "go to pm")
s.check("moving between direct reports stays client-side: teamSelectReport sends no chat turn",
        "sendTurn(" not in re.search(r"function teamSelectReport\(.*?\n  }\n", JS, re.S).group(0))
# the part's first opening (a new report's thread): the fixed line too
r2 = TA["reps"][1][0]
n0 = CALLS[0]
j = team_turn(TA, "tm_review", mode="detail", report=str(r2))
s.check("the first opening of a part (nothing said in its thread yet) is the fixed line, no model",
        (j.get("say") or "").startswith("Your team's competency reviews:") and CALLS[0] == n0 and j.get("switched") is True,
        (j.get("say"), CALLS[0] - n0))
MODE[0] = "script"
n0 = CALLS[0]
SCRIPT[:] = [{"say": "(model)", "quick_replies": [], "action": None}]
j = team_turn(TA, "pm_review", message="how is my team doing overall?")
s.check("a question on a team part still goes to the model", CALLS[0] == n0 + 1 and j.get("say") == "(model)", CALLS[0] - n0)
SCRIPT[:] = [{"say": "(model)", "quick_replies": [], "action": None}]
n0 = CALLS[0]
j = team_turn(TA, "pm_review")
s.check("...and an empty forced turn after it (not a first opening, no switch=1) is the model's, not a switch",
        CALLS[0] == n0 + 1 and not j.get("switched"), CALLS[0] - n0)
falsified("team tap answered by the server only with switch=1 (the old client's empty turn reaches the model)", {},
          lambda: (lambda n: (SCRIPT.__setitem__(slice(None), [{"say": "(model)", "quick_replies": [], "action": None}]),
                              team_turn(TA, "tm_review", **{"from": "pm_review"}), CALLS[0] == n)[2])(CALLS[0]))
falsified("typed team picks answered by the server (with _journey_team_stage_pick blind, the model is called)",
          {(a, "_journey_team_stage_pick"): lambda *x, **k: None},
          lambda: (lambda n: (team_turn(TA, "pm_review", message="go to tm"), CALLS[0] == n)[1])(CALLS[0]))
MODE[0] = "down"

# ---- the reminder -------------------------------------------------------------------------------------------------
s.section("PIECE B -- the line manager's reminder: reports entered but not approved")
TB = make_team("B")
j = team_tap(TB, "tm_review", "pm_review")
s.check("nothing entered yet (no moderation saved): no reminder, the move happens", j.get("stage") == "tm_review"
        and "switch_reminder" not in rtypes(j), rtypes(j))
r1, k1, _tc = TB["reps"][0]
post(TB["c"], "/performance/kpi/%d/moderate-draft-autosave" % k1, adjusted_value="13")
pm_ready0 = ctx(TB["mgr"], lambda db, u: a._switch_ready_team(db, u, CID, "pm_review"))
j = team_tap(TB, "tm_review", "pm_review")
s.check("a moderation saved but the lock's own remark gate (_pm_remark_missing) still open: not ready, no reminder",
        pm_ready0 is None and "switch_reminder" not in rtypes(j), (pm_ready0, rtypes(j)))
ctx(TB["mgr"], lambda db, u: a._pm_manager_remark_write(db, u, a.active_pm_period(db), r1, TXT))
appr0 = H.one(a, "SELECT COUNT(*) FROM pm_kpi_approvals")
n0 = CALLS[0]
j = team_tap(TB, "tm_review", "pm_review")
d = (j.get("renders") or [{}])[0].get("data") or {}
nm1 = "Test Report B1"
s.check("entry complete (a draft on every line, the remark in) and not locked: the move is HELD once -- fixed line, a card, "
        "no model", j.get("stay") is True and j.get("stage") == "pm_review" and j.get("moved") is False
        and rtypes(j) == ["switch_reminder"] and CALLS[0] == n0 and d.get("team") is True and d.get("names") == [nm1]
        and d.get("aid") == r1, (rtypes(j), d))
s.check("...the line names them: 'Before you go: your KPI review for <name> is filled in but not locked yet. I'd lock it "
        "now. ...'", j.get("say") == "Before you go: your KPI review for %s is filled in but not locked yet. I'd lock it "
        "now. If you'd like to look it over again first, it will wait for you here." % nm1, len(j.get("say") or ""))
s.check("...the card carries both buttons: Lock <name> (opens the existing lock) and Check them later, go to <part>",
        d.get("verb") == "Lock" and d.get("to_part") and d.get("to_stage") == "tm_review", d)
s.check("...nothing is locked or written by the reminder", H.one(a, "SELECT COUNT(*) FROM pm_kpi_approvals") == appr0)
j = team_tap(TB, "plan_review", "pm_review")
s.check("a SECOND move while it is up counts as 'Check them later': it moves at once",
        j.get("stage") == "plan_review" and "switch_reminder" not in rtypes(j), rtypes(j))
team_tap(TB, "pm_review", "plan_review")
j = team_tap(TB, "tm_review", "pm_review")
s.check("...and the part is quiet after (nothing changed)", j.get("stage") == "tm_review", rtypes(j))
post(TB["c"], "/performance/kpi/%d/moderate-draft-autosave" % k1, adjusted_value="14")
team_tap(TB, "pm_review", "tm_review")
j = team_tap(TB, "tm_review", "pm_review")
s.check("asked again after something changes in that part (the moderation) and leaving again", j.get("stay") is True,
        rtypes(j))
j = team_tap(TB, "tm_review", "pm_review", later=True)
s.check("'Check them later, go to <part>' (later=1) moves at once", j.get("stage") == "tm_review", j.get("stage"))
# naming every report that is ready
r2_, k2, _tc2 = TB["reps"][1]
post(TB["c"], "/performance/kpi/%d/moderate-draft-autosave" % k2, adjusted_value="13")
ctx(TB["mgr"], lambda db, u: a._pm_manager_remark_write(db, u, a.active_pm_period(db), r2_, TXT))
team_tap(TB, "pm_review", "tm_review")
j = team_tap(TB, "tm_review", "pm_review")
s.check("two reports ready: ONE reminder naming both ('<A> and <B>')", j.get("stay") is True
        and "Test Report B1 and Test Report B2" in (j.get("say") or "") and "are filled in but not locked" in j["say"],
        len(j.get("say") or ""))
s.check("a report moved between inside the part is no move: same-part tap, no reminder",
        "switch_reminder" not in rtypes(team_tap(TB, "pm_review", "pm_review")))
# the competency review and the plan: their own gates
TC_ = make_team("C")
r1c, _k, tcs_c = TC_["reps"][0]
post(TC_["c"], "/technical/team/%d/autosave" % r1c, assignment_id=str(tcs_c[0]), manager_answer="no")
need = ctx(TC_["mgr"], lambda db, u: a._tc_approve_assessment(db, u, CID, r1c))[1]
rd = ctx(TC_["mgr"], lambda db, u: a._switch_ready_team(db, u, CID, "tm_review"))
s.check("competency: an override that moves their potential without the remark is NOT ready -- the approve itself refuses "
        "it (the same gate)", rd is None and (need or {}).get("reason") == "needs_remark", (rd, need))
ctx(TC_["mgr"], lambda db, u: a._tc_manager_remark_write(db, u, CID, r1c, TXT))
rd = ctx(TC_["mgr"], lambda db, u: a._switch_ready_team(db, u, CID, "tm_review"))
j = team_tap(TC_, "pm_review", "tm_review")
s.check("competency: override + remark is ready, and held", rd and rd["ids"] == [r1c] and j.get("stay") is True
        and (j.get("say") or "").startswith("Before you go: your competency review for Test Report C1 is filled in but "
                                            "not approved yet. I'd approve it now."), rtypes(j))
s.check("...and the card's own approve accepts it (parity: ready means the lock goes through)",
        ctx(TC_["mgr"], lambda db, u: a._tc_approve_assessment(db, u, CID, r1c))[1] is None)
TD = make_team("D")
j = team_tap(TD, "pm_review", "plan_review")
s.check("plan: shared but their remark not written: no reminder (the row's own action is 'Write your remark')",
        j.get("stage") == "pm_review" and "switch_reminder" not in rtypes(j), rtypes(j))
ready_plan(TD)
j = team_tap(TD, "pm_review", "plan_review")
s.check("plan: remark written (the row says 'Approve the plan'): held; the line says approve",
        j.get("stay") is True and (j.get("say") or "").startswith("Before you go: your plan review for Test Report D1 is "
                                                                  "filled in but not approved yet. I'd approve it now."),
        rtypes(j))
# the closing day
TE = make_team("E")
ready_pm(TE)
team_tap(TE, "tm_review", "pm_review", later=True)
team_tap(TE, "pm_review", "tm_review")
j = team_tap(TE, "tm_review", "pm_review")
s.check("(before its closing day) a part put off is quiet", j.get("stage") == "tm_review", rtypes(j))
with a.app.app_context():
    a.get_db().execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,NULL,?)",
                       (CID, "pm_approve", a._today_myt().strftime("%Y-%m-%d") + " 23:59"))
    a.get_db().commit()
team_tap(TE, "pm_review", "tm_review")
j = team_tap(TE, "tm_review", "pm_review")
s.check("on the closing day (MYT), still not locked: asked once more", j.get("stay") is True, rtypes(j))
team_tap(TE, "tm_review", "pm_review", later=True)
team_tap(TE, "pm_review", "tm_review")
j = team_tap(TE, "tm_review", "pm_review")
s.check("...and only once that day", j.get("stage") == "tm_review", rtypes(j))
with a.app.app_context():
    a.get_db().execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    a.get_db().commit()

# falsify the team reminder's guards
TF = make_team("F")
falsified("readiness: with it ignored a part with nothing entered would be held",
          {(a, "_switch_ready_team"): lambda db, u, cid, stage: {"names": ["x"], "ids": [1], "aid": 1, "fp": "q"}},
          lambda: "switch_reminder" not in rtypes(team_tap(TF, "tm_review", "pm_review")))
ready_pm(TF)
falsified("quiet after Check them later: with the session memory gone, the part is held again",
          {(a, "_switch_state"): lambda cid: {"cid": cid, "later": {}, "held": {}, "day": {}}},
          lambda: (lambda: (team_tap(TF, "tm_review", "pm_review", later=True),
                            "switch_reminder" not in rtypes(team_tap(TF, "tm_review", "pm_review")))[1])())
TG = make_team("G")
r1g, k1g, _ = TG["reps"][0]
r2g, k2g, _ = TG["reps"][1]
ready_pm(TG, 0)
ready_pm(TG, 1)
falsified("naming every ready report: truncated to the first, the two-name line fails",
          {(a, "_switch_ready_team"): (lambda orig: (lambda db, u, cid, stage: (lambda r: dict(r, names=r["names"][:1])
                                                                              if r else r)(orig(db, u, cid, stage))))(
              a._switch_ready_team)},
          lambda: "Test Report G1 and Test Report G2" in (team_tap(TG, "tm_review", "pm_review").get("say") or ""))
TH = make_team("H")
ready_pm(TH)
falsified("a change is noticed: with a constant fingerprint it is not",
          {(a, "_switch_ready_team"): (lambda orig: (lambda db, u, cid, stage: dict(orig(db, u, cid, stage) or {}, fp="k")
                                                    if orig(db, u, cid, stage) else None))(a._switch_ready_team)},
          lambda: (lambda: (team_tap(TH, "tm_review", "pm_review", later=True),
                            post(TH["c"], "/performance/kpi/%d/moderate-draft-autosave" % TH["reps"][0][1],
                                 adjusted_value="14.5"),
                            "switch_reminder" in rtypes(team_tap(TH, "tm_review", "pm_review")))[2])())

# ---- the leader views ---------------------------------------------------------------------------------------------
s.section("PIECE B -- the leader views: a calibration part come back to by tab opens with the fixed line; never a reminder")
with a.app.app_context():
    db = a.get_db()
    for c_ in ("tb_bgceo", "pm_buceo", "pot_buceo", "pm_hod", "pot_hod"):
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell=?", (CID, c_))
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                   (CID, c_, "2020-01-01 00:00:00", "2099-12-31 15:59:00"))
    for m_ in ("pm", "calibration", "review", "tm"):
        db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, m_))
    BGC = mk_user(db, "ISW-BGC", "Test Group Chief")
    db.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (CHBM, BGC))
    db.commit()
CBG = H.client_as(a, BGC)


def bg_turn(**more):
    f = {"message": "", "stage": "talent_box", "view": "bg", "mode": "summary"}
    f.update(more)
    return turn(CBG, **f)


MODE[0] = "down"
n0 = CALLS[0]
j0 = bg_turn()
s.check("the BG CEO's first opening of the Talent Box is the fixed opener (as before)",
        j0.get("stage") == "talent_box" and bool(j0.get("say")) and CALLS[0] == n0, (j0.get("stage"), j0.get("say")))
j1 = bg_turn(**{"switch": "1", "from": "talent_box"})
s.check("coming BACK to the Talent Box by tab (it has history now) gets the fixed opener too, no model",
        j1.get("stage") == "talent_box" and bool(j1.get("say")) and CALLS[0] == n0 and "switch_reminder" not in rtypes(j1)
        and not j1.get("stay"), (j1.get("say"), CALLS[0] - n0))
MODE[0] = "script"
SCRIPT[:] = [{"say": "(model)", "quick_replies": [], "action": None}]
n0 = CALLS[0]
j2 = bg_turn()
s.check("...whereas the same empty turn without switch=1 is the model's (the flag is what makes it a move)",
        CALLS[0] == n0 + 1, CALLS[0] - n0)
MODE[0] = "down"
falsified("a calibration part never holds: with the line manager's parts widened to it and readiness faked, it would",
          {(a, "_TEAM_LM_PARTS"): a._TEAM_LM_PARTS + ("talent_box",),
           (a, "_switch_ready_team"): lambda db, u, cid, stage: {"names": ["x"], "ids": [1], "aid": 1, "fp": "z"}},
          lambda: ctx(BGC, lambda db, u: a._switch_leave_check(db, u, CID, "talent_box")) is None)
s.check("(the guard it falsifies) the BG CEO is never held leaving the Talent Box, even with readiness faked only by "
        "the part list being the line manager's three",
        ctx(BGC, lambda db, u: a._switch_leave_check(db, u, CID, "talent_box")) is None)
s.check("(guard) the calibration parts are never in the reminder's list",
        not set(a._TEAM_LM_PARTS) & {"calibration", "calibration_pot", "talent_box", "group_calib"})

# ---- the reply safeguard on the team turn ---------------------------------------------------------------------------
s.section("PIECE B -- the reply safeguard on the team turn")
MODE[0] = "script"
TS = make_team("S")
tbl_t = "| KPI | Result |\n| ZZ Line S1 | 12 |\n| ZZ Line S2 | 13 |"
SCRIPT[:] = [{"say": tbl_t, "quick_replies": [], "action": None}]
j = team_turn(TS, "pm_review", message="summarise their results", mode="detail", report=str(TS["reps"][0][0]))
s.check("a table drawn in text on the manager's KPI part is replaced: 'Here's their KPI table, just below.' + the table",
        j.get("say") == "Here's their KPI table, just below." and "stage_focus" in rtypes(j), j.get("say"))
SCRIPT[:] = [{"say": "Their ZZ Planning 3 and ZZ Costing 2 are rated.", "quick_replies": [], "action": None}]
j = team_turn(TS, "tm_review", message="how are they rated?", mode="detail", report=str(TS["reps"][0][0]))
s.check("two competencies' figures listed on the competency part: 'Here's their competency table, just below.'",
        j.get("say") == "Here's their competency table, just below.", j.get("say"))
SCRIPT[:] = [{"say": "Their ZZ Planning is rated 3.", "quick_replies": [], "action": None}]
j = team_turn(TS, "tm_review", message="how is planning?", mode="detail", report=str(TS["reps"][0][0]))
s.check("one figure asked for directly stands", j.get("say") == "Their ZZ Planning is rated 3.", j.get("say"))
falsified("the team safeguard (guard off: the text table stands)", {(a, "_reply_lists_figures"): lambda *x: False},
          lambda: (lambda: (SCRIPT.__setitem__(slice(None), [{"say": tbl_t, "quick_replies": [], "action": None}]),
                            team_turn(TS, "pm_review", message="summarise their results", mode="detail",
                                      report=str(TS["reps"][0][0])).get("say") == "Here's their KPI table, just below.")[1])())
MODE[0] = "down"

# ---- the waiting display and the view tabs ------------------------------------------------------------------------
s.section("PIECE B -- the waiting display for the team views, and the view tabs")
s.check("a team tab move waits 200 ms then shows 'Loading your <part>…' + the outline: the team parts have labels and "
        "outlines", all(k in JS.split("var STAGE_LABELS")[1].split("};")[0] for k in (
            "pm_review", "tm_review", "plan_review", "calibration", "talent_box")) and "if (extra && extra.switch) moveTo = curStage;" in JS
        and all(k + ": " in JS.split("var SKEL_ROWS")[1].split("};")[0] for k in ("pm_review", "tm_review", "plan_review")))
vt = open(os.path.join(HERE, "..", "templates", "_review_viewtabs.html")).read()
s.check("the view tabs (Mine / Team / Dept / BU / BG / Group) are plain links: a page load, never a chat turn -- a view "
        "that is opened the first time ends in the part's opener, which is now the server's for the line manager's parts "
        "and the calibration parts", 'href="{{ url_for(\'review_journey\', view=v.key) }}"' in vt and "sendTurn" not in vt)
s.check("a part landed on in the employee view starts with switch=1 (the server's line, no model)",
        'else if (startPart) sendTurn("", true, { "switch": "1" });' in JS)

# ===========================================================================
s.section("the safeguard on a model reply (one function, reusable by the team turn)")
NAMES = ["zz switch revenue", "zz switch margin"]
lst = "Your Revenue result is ZZ Switch Revenue: 12, and ZZ Switch Margin: 40."
tbl = "| KPI | Result |\n| ZZ Switch Revenue | 12 |\n| ZZ Switch Margin | 40 |"
bul = "- first 1\n- second 2\n- third 3"
one = "Your target for ZZ Switch Revenue is 12 million."
s.check("a reply listing two KPIs' figures is caught", a._reply_lists_figures(lst, NAMES))
s.check("a text table (2+ lines with a pipe) is caught", a._reply_lists_figures(tbl, NAMES))
s.check("3+ list lines carrying figures are caught", a._reply_lists_figures(bul, NAMES))
s.check("ONE figure asked for directly is kept", not a._reply_lists_figures(one, NAMES))
s.check("two KPI names with no figures are kept", not a._reply_lists_figures(
    "Your KPIs are ZZ Switch Revenue and ZZ Switch Margin.", NAMES))
MODE[0] = "script"
E6 = H.client_as(a, MGR)
SCRIPT[:] = [{"say": lst, "quick_replies": [], "action": None}]
j = turn(E6, message="tell me about my two kpis", stage="account")
s.check("through the route: a reply listing figures becomes 'Here's your KPI table, just below.' and the KPI card comes "
        "with it", j.get("say") == "Here's your KPI table, just below." and "kpi_progress" in rtypes(j), j.get("say"))
SCRIPT[:] = [{"say": one, "quick_replies": [], "action": None}]
j = turn(E6, message="what is my revenue target?", stage="account")
s.check("through the route: a one-figure answer stands", j.get("say") == one, j.get("say"))
SCRIPT[:] = [{"say": tbl, "quick_replies": [], "action": None}]
j = turn(E6, message="give me a summary", stage="account")
s.check("through the route: a table drawn in text is replaced", j.get("say") == "Here's your KPI table, just below.",
        j.get("say"))
SCRIPT[:] = [{"say": "Here is each: ZZ Planning 3, ZZ Costing 2.", "quick_replies": [], "action": None}]
j = turn(E6, message="tell me about my competencies", stage="competency")
s.check("...on the competency part the pointer says 'competency card'",
        j.get("say") == "Here's your competency card, just below." and "competency_progress" in rtypes(j), j.get("say"))
falsified("lists replaced (guard off: the listing stands)", {(a, "_reply_lists_figures"): lambda *x: False},
          lambda: (lambda: (SCRIPT.__setitem__(slice(None), [{"say": lst, "quick_replies": [], "action": None}]),
                            turn(E6, message="tell me about my two kpis", stage="account").get("say")
                            == "Here's your KPI table, just below.")[1])())
falsified("one figure kept (guard too eager: the sentence would be replaced)", {(a, "_reply_lists_figures"): lambda *x: True},
          lambda: (lambda: (SCRIPT.__setitem__(slice(None), [{"say": one, "quick_replies": [], "action": None}]),
                            turn(E6, message="what is my revenue target?", stage="account").get("say") == one)[1])())

# ===========================================================================
s.section("'Show me my KPI 2': the card opens at that row, highlighted")
ids = ctx(MGR, lambda db, u: [l["kpi_id"] for l in a._review_kpi_overview(db, u)["data"]["lines"]])
SCRIPT[:] = [{"say": "Here is that one.", "quick_replies": [], "action": None}]
j = turn(E6, message="show me my KPI 2", stage="account")
kp = next((r for r in (j.get("renders") or []) if r.get("type") == "kpi_progress"), {})
s.check("'show me my KPI 2' brings the KPI card with the second line's id", kp.get("kpi_id") == ids[1], kp)
SCRIPT[:] = [{"say": "Here is that one.", "quick_replies": [], "action": None}]
j = turn(E6, message="show me ZZ Switch Margin KPI", stage="account")
kp = next((r for r in (j.get("renders") or []) if r.get("type") == "kpi_progress"), {})
s.check("...and so does naming it ('ZZ Switch Margin')", kp.get("kpi_id") == ids[1], kp)
SCRIPT[:] = [{"say": "Here they are.", "quick_replies": [], "action": None}]
j = turn(E6, message="show me the kpi table for ZZ Switch Margin and ZZ Switch Revenue", stage="account")
kp = next((r for r in (j.get("renders") or []) if r.get("type") == "kpi_progress"), {})
s.check("...two KPIs named: the card, no highlight", kp.get("type") == "kpi_progress" and "kpi_id" not in kp, kp)
falsified("highlight (the KPI lookup off: no kpi_id)", {(a, "_kpi_named_id"): lambda *x: None},
          lambda: (lambda: (SCRIPT.__setitem__(slice(None), [{"say": "x", "quick_replies": [], "action": None}]),
                            next((r for r in (turn(E6, message="show me my KPI 2", stage="account").get("renders") or [])
                                  if r.get("type") == "kpi_progress"), {}).get("kpi_id") == ids[1])[1])())
def _steer_for(text):
    SCRIPT[:] = [{"say": "x", "quick_replies": [], "action": None}]
    n = len(SYSTEMS)
    turn(E6, message=text, stage="account")
    return SYSTEMS[-1] if len(SYSTEMS) > n else ""


names_ = ctx(MGR, lambda db, u: [l["kpi"] for l in a._review_kpi_overview(db, u)["data"]["lines"]])
s.check("the model is told which KPI 'KPI 2' is, so its words and the highlight agree",
        "THEY MEAN KPI 2: %s (the 2nd line of their card)" % names_[1] in _steer_for("show me my KPI 2"))
s.check("...and for a KPI named in words", "THEY MEAN KPI 2: %s" % names_[1] in _steer_for("show me ZZ Switch Margin KPI"))
s.check("...none when two are named, or none", "THEY MEAN KPI" not in _steer_for("show me ZZ Switch Margin and ZZ Switch Revenue KPIs")
        and "THEY MEAN KPI" not in _steer_for("what is my target?"))
falsified("the steer (with the lookup off the model is not told)", {(a, "_kpi_named_id"): lambda *x: None},
          lambda: "THEY MEAN KPI 2" in _steer_for("show me my KPI 2"))
s.check("the page highlights the row (a navy ring and tint, never red) and fades it",
        "function highlightKpiRow" in JS and "tr.rv-kpi-hl" in CSS and "rv-kpi-hl" in JS
        and not re.search(r"tr\.rv-kpi-hl[^}]*(?:#d61923|red)", CSS, re.I))

# ===========================================================================
s.section("the matcher is one source of truth, shared with the page")
page = H.client_as(a, P2).get("/review/journey?stage=account")
html = page.get_data(as_text=True)
m = re.search(r"data-pick='([^']*)'", html)
spec = json.loads(m.group(1).replace("&#39;", "'").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")) \
    if m else {}
s.check("the journey page carries the server's pick patterns and part names (data-pick)",
        bool(spec) and spec.get("lead") == a._JOURNEY_PICK_LEAD_RE.pattern and spec.get("tail") ==
        a._JOURNEY_PICK_TAIL_RE.pattern and spec.get("show") == a._WIDGET_SHOW_RE.pattern
        and "account" in spec.get("names", {}) and "competency" in spec["names"], list(spec)[:6])
# run the PAGE's own predictors in node against the server's answer for a list of messages
msgs = ["go to my competency", "switch to competency", "360 please", "back to my KPI", "let's start with 360",
        "can we do competency", "show me my 360", "show me my KPI detail", "go to my KPI and explain my rating",
        "what is my target?", "Career Plan", "bring me to my kpi", "jump to idp", "tell me about my career plan",
        "ok, career plan please", "Competency Assessment", "go back to competency", "show me the competency table",
        "see my kpis", "hello", "x" * 70]
start = JS.index("var pickSpec = null;")
end = JS.index("// The person's OWN KPIs")
js_src = ("var curStage='account';\n" + JS[start:end].replace('root.getAttribute("data-pick") || "null"', "SPEC")
          + "\nvar out={};MSGS.forEach(function(m){out[m]=[predictPick(m),predictSee(m)];});console.log(JSON.stringify(out));")
node = subprocess.run(["node", "-e", "var SPEC=%s;var MSGS=%s;var root={getAttribute:function(){return SPEC;}};%s" %
                       (json.dumps(json.dumps(spec)), json.dumps(msgs), js_src)], capture_output=True, text=True)
try:
    jsout = json.loads(node.stdout)
except ValueError:
    jsout = {}
st_ = ctx(P2, lambda db, u: a.review_state(db, u))
agree, diffs = True, []
for mm in msgs:
    py_pick = next((k for k in spec.get("names", {}) if a._journey_names_stage(st_, mm, k)), None)
    py_see = a._widget_asked(mm) and bool(a._WIDGET_SHOW_RE.search(mm.replace("’", "'")))
    js_pick, js_see = (jsout.get(mm) or [None, None])
    if js_pick != py_pick:
        agree = False
        diffs.append((mm[:30], "pick", js_pick, py_pick))
    if bool(js_see) != bool(py_see and not py_pick) and not (py_pick and js_see is None):
        # see is only asked when it is not a pick
        if not py_pick:
            agree = False
            diffs.append((mm[:30], "see", js_see, py_see))
s.check("the page's predictors (run in node) agree with the server's on %d messages" % len(msgs), agree and bool(jsout), diffs)

# ===========================================================================
s.section("the wait: loading line + outline after 0.2 s for a move; working line + outline for 'show me'")
s.check("a move waits 200 ms before it shows 'Loading your [part]…' (no flicker)",
        "setTimeout(function () { waitTimer = null; showWait(mvLabel, moveTo); }, 200)" in JS
        and '"Loading your " + STAGE_LABELS[moveTo] + "…"' in JS)
s.check("a message that asks to SEE a part shows the working line at once, with that card's outline",
        "else showWait(loadingLabel(!!msg), seeOf);" in JS and "seeOf = predictSee(msg)" in JS)
s.check("any other question: the working line alone (no outline)", "function showWait(label, stage)" in JS
        and "if (stage) { skel = skeletonFor(stage)" in JS)
s.check("the outline and the waiting line go together when the reply lands (or fails)",
        JS.count("endWait();") >= 2 and "if (skel) { skel.remove(); skel = null; }" in JS)
s.check("the outline respects prefers-reduced-motion", "@media (prefers-reduced-motion: reduce) { .rv-skel-bar { animation: none; } }"
        in CSS)
_forced = re.findall(r'sendTurn\(""\s*,\s*true(?:\s*,\s*(\{[^}]*\}|sx))?\)', JS)
s.check("only switchStage and the part-landed-on start send switch=1; every forced follow-up (after a Save, a submit, an attach) is none: it carries "
        "after_save / after_signoff / after_attach", JS.count('{ "switch": "1" }') == 2
        and all(("after_" in x) or x in ("", "sx") or x == '{ "switch": "1" }' for x in _forced)
        and "switch" not in "".join(x for x in _forced if "after_" in x), _forced)
s.check("a tap that is the way to a submit (openSignoff) sends no reminder (quiet)",
        'switchStage(stage, { quiet: true });' in JS)
s.check("the team and leader views send the switch too (piece B), with from_report for the part being left",
        "if (isMgr && leavingReport != null) sx.from_report = leavingReport;" in JS)

# ===========================================================================
s.section("the agent's knowledge and the current design")
sys_ = ctx(P2, lambda db, u: a._journey_agent_system(db, u, a.review_state(db, u), "account"))
s.check("the journey prompt says the switch line is the system's and never to list figures",
        "SWITCH LINES ARE THE SYSTEM'S" in sys_ and "never list several KPIs' or competencies' figures" in sys_)
s.check("a pick no longer injects '(moving on)' for the model (the server answers it)",
        "tell the model it has moved, exactly as a go_to_stage it ran itself would" not in SRC
        and "A part picked by name is answered above by the server" in SRC)
_cdp = os.path.join(HERE, "..", "..", "CURRENT-DESIGN.md")   # outside the repo: a shard's clean copy has none
if os.path.exists(_cdp):
    cd = open(_cdp).read()
    s.check("CURRENT-DESIGN.md 3.3 draws the loading line + outline, the reminder card and the row highlight",
            "Loading your" in cd and "Before you go" in cd and "rv-kpi-hl" in cd and "instant switch" in cd.lower())
else:
    s.note("CURRENT-DESIGN.md is outside this copy of the repo: its 3.3 update is checked where it exists")

# ---- put back what the suite changed (a fresh copy is restored by Suite.done()) ----
ai_draft.review_agent_available, ai_draft.review_agent = _avail0, _agent0
sys.exit(s.done())
