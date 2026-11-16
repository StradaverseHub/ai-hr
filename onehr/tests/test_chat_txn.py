"""No database transaction is held across a model call in the journey chat turn (Chris's rule: never hold a SQLite write
transaction across a model call or a network wait; 7 Nov 2026: three `database is locked` tracebacks in _journey_chat_turn).

The model is stubbed. Each stub call asserts the request's connection has no open transaction (`db.in_transaction` False),
and the stub is driven through every stage the fixture reaches: the KPI check-in (account), the 360 (feedback), the
competency self-assessment and the Career Plan, each turn proposing a WRITING tool first (so the NEXT model call comes
after a write) and then speaking.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
s = H.Suite("Journey chat turn -- no open transaction across a model call")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

CHBM = "CHIN HIN BUILDING MATERIAL (CHBM)"


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


s.section("build: one employee with a KPI, a competency, a colleague to rate")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','tm','idp','pm')")
    db.execute("UPDATE cycle_modules SET active=0 WHERE module_key='evidence'")
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
    db.execute("UPDATE cycles SET kind='year_end', half=2 WHERE id=?", (CID,))
    if not db.execute("SELECT 1 FROM pm_bg_config WHERE business_group=?", (CHBM,)).fetchone():
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (CHBM,))
    col = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND job_grade IS NOT NULL AND "
                     + a.participant_sql("", "tm_rated") + " ORDER BY id LIMIT 1").fetchone()
    EMP = db.execute(
        "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, "
        "department, job_title, job_grade, confirmation_date, years_of_service) "
        "VALUES ('TXN-EMP','Tess Employee','x','user','TXN-EMP',?,'TXN Co','Sales Operations','Executive',?,'2020-01-01',4.0)",
        (CHBM, col["job_grade"])).lastrowid
    KPI = db.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
        "rate1, rate2, rate3, rate4, rate5) VALUES (?,?, 'TXN Gross Profit', 100.0, 'more', 'approved', ?, "
        "9, 11, 12, 13, 15)", (CID, EMP, CHBM)).lastrowid
    SK = [db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_category, proficiency_description, "
                     "ability_items, active) VALUES (?,?,3,'Operations',?, '- One\n- Two', 1)",
                     (c, t, t + " at the working level")).lastrowid
          for c, t in (("TXN-SK-1", "Demand Planning"), ("TXN-SK-2", "Cost Analysis"))]
    TC = [db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, source) "
                     "VALUES (?,?,?,0,'profile')", (CID, EMP, k)).lastrowid for k in SK]
    FBA = db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) "
                     "VALUES (?,?,?,'peer','pending')", (CID, col["id"], EMP)).lastrowid
    STMT = [x["statement_id"] for x in a.statements_for_grade(db, col["job_grade"], CID)]
    db.commit()
s.check("fixture: the colleague has behaviours to rate", bool(STMT), len(STMT))

CALLS = []     # one entry per model call: (what asked, whether the request's connection had a transaction open)
SCRIPT = []


def stub(system, messages, timeout=90):
    CALLS.append(("agent", a.get_db().in_transaction))
    return SCRIPT.pop(0)


_orig = {k: getattr(ai_draft, k) for k in ("review_agent", "review_agent_available", "is_configured", "draft_idp_actions",
                                          "draft_idp_goals", "draft_career_profile")}
ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = stub
E = H.client_as(a, EMP)


def drive(stage, script, msg="ok"):
    CALLS[:] = []
    SCRIPT[:] = list(script)
    return post(E, "/review/chat?journey=1", message=msg, stage=stage).get_json() or {}


def say(t):
    return {"say": t, "quick_replies": [], "action": None}


def act(tool, **args):
    return {"say": "On it.", "quick_replies": [], "action": {"tool": tool, "args": args}}


def clean(label, calls, want):
    s.check("%s: %d model call(s), none with a transaction open" % (label, want),
            len(calls) == want and not any(c[1] for c in calls), calls)


try:
    s.section("each stage: the model is called with no transaction open, before and after a write")
    r = drive("account", [act("record_kpi_result", kpi_id=KPI, actual_value="12"), say("Recorded.")])
    s.check("account: the write landed (so the second call really followed one)",
            H.one(a, "SELECT COUNT(*) FROM pm_kpi_results WHERE kpi_target_id=?", (KPI,)) == 1, r.get("say"))
    clean("account (KPI check-in), a KPI figure written between two calls", CALLS, 2)
    r = drive("feedback", [act("rate_behaviour", assignment_id=FBA, statement_id=STMT[0], answer="yes"), say("Noted.")])
    s.check("feedback: the write landed", H.one(a, "SELECT answer FROM responses WHERE assignment_id=? AND statement_id=?",
                                               (FBA, STMT[0])) == "yes", r.get("say"))
    clean("feedback (360), a rating written between two calls", CALLS, 2)
    r = drive("competency", [act("set_competency", assignment_id=TC[0], answer="no"), say("Noted.")])
    s.check("competency: the write landed", H.one(a, "SELECT COUNT(*) FROM tc_scores WHERE assignment_id=?", (TC[0],)) == 1,
            r.get("say"))
    clean("competency, an answer written between two calls", CALLS, 2)

    s.section("a message with no tool, and the person's own words saved as their remark")
    r = drive("account", [say("Thanks -- what was the figure?")], msg="Can you remind me what happens next?")
    clean("account, a plain reply", CALLS, 1)
    drive("account", [act("save_remark"), say("Saved.")],
          msg="Held gross profit on plan through the second half by renegotiating two supplier contracts and tightening "
              "discount rules for the key accounts, which kept our margin steady all year long.")
    s.check("the remark is stored from their own words (the writer committed before anything else)",
            H.one(a, "SELECT COUNT(*) FROM pm_review_chat WHERE subject_id=? AND role='user'", (EMP,)) >= 2
            and not any(c[1] for c in CALLS), CALLS)

    s.section("the Career Plan opens once the KPI check-in and the competency part are submitted")
    post(E, "/review/kpi/save-all", **{"actual_value_%d" % KPI: "12"})
    post(E, "/review/kpi/remark", remark="I held gross profit on plan through the second half by renegotiating "
                                         "two supplier contracts and tightening the discount rules for the key accounts.")
    s.check("the KPI check-in is submitted", post(E, "/review/confirm").status_code == 200)
    post(E, "/review/competency/save-all", **{"answer_%d" % TC[0]: "yes", "answer_%d" % TC[1]: "no"})
    post(E, "/review/competency/remark", remark="I plan demand well and keep the forecast honest; cost analysis "
                                               "is where I'm still building depth, especially on landed cost.")
    s.check("the competency part is submitted", post(E, "/review/competency/submit").status_code == 200)
    for tool, args in (("set_field", dict(field="aspiration_mid", value="Regional operations lead")),
                       ("set_field", dict(field="mobility", value="same_company")),
                       ("add_goal", dict(area="Cost analysis depth"))):
        r = drive("career_plan", [act(tool, **args), say("Noted.")])
        s.check("career_plan: the turn ran on the Career Plan", r.get("stage") == "career_plan", r.get("stage"))
        clean("career_plan, %s written between two calls" % tool, CALLS, 2)
    s.check("career_plan: the writes landed (aspiration_mid, mobility, a goal)",
            H.one(a, "SELECT COUNT(*) FROM pm_career_profile WHERE subject_id=? AND aspiration_mid IS NOT NULL "
                     "AND mobility IS NOT NULL", (EMP,)) == 1
            and H.one(a, "SELECT COUNT(*) FROM pm_idp_goals g JOIN pm_idp i ON i.id=g.idp_id WHERE i.subject_id=?", (EMP,)) >= 1)

    s.section("draft_plan makes its own model call inside the tool: none with a transaction open either")
    ai_draft.is_configured = lambda: True
    ai_draft.draft_idp_actions = lambda *a_, **k_: (CALLS.append(("actions", a.get_db().in_transaction)), [])[1]
    ai_draft.draft_idp_goals = lambda *a_, **k_: (CALLS.append(("goals", a.get_db().in_transaction)), "[]")[1]
    ai_draft.draft_career_profile = lambda *a_, **k_: (CALLS.append(("profile", a.get_db().in_transaction)), "{}")[1]
    drive("career_plan", [act("draft_plan"), say("Noted.")])
    s.check("draft_plan reached its drafting call(s), and the connection had no transaction open at any model call",
            any(c[0] in ("actions", "goals", "profile") for c in CALLS) and not any(c[1] for c in CALLS), CALLS)

    # every tool of every stage, straight through the journey's dispatcher, leaves no transaction open (the next model
    # call in the loop follows a tool)
    s.section("every tool of every stage leaves the connection with no transaction open")
    def leaks():
        left, ran = [], 0
        with a.app.test_request_context("/"):
            from flask import session
            session["user_id"] = EMP
            db = a.get_db()
            u = dict(db.execute("SELECT * FROM users WHERE id=?", (EMP,)).fetchone())
            for st_key, reg in a._JOURNEY_STAGE_TOOLS.items():
                for tool in sorted(reg):
                    a._journey_run_stage_tool(db, u, CID, st_key, {"tool": tool, "args": {}})
                    ran += 1
                    if db.in_transaction:
                        left.append((st_key, tool))
                        db.rollback()
        return left, ran
    left, ran = leaks()
    s.check("%d stage tools run with empty arguments, none leaving a transaction open" % ran, ran > 30 and not left, left)
    # falsified: a tool that writes and does not commit is caught by the same sweep
    a._JOURNEY_STAGE_TOOLS["feedback"]["__leak"] = lambda db, u, cid, args: (
        db.execute("UPDATE responses SET answer=answer WHERE assignment_id=?", (FBA,)), {"ok": True})[1]
    try:
        bad, _n = leaks()
    finally:
        del a._JOURNEY_STAGE_TOOLS["feedback"]["__leak"]
    s.check("the sweep itself catches a tool that writes and leaves its transaction open", ("feedback", "__leak") in bad, bad)
finally:
    for k, v in _orig.items():
        setattr(ai_draft, k, v)

sys.exit(s.done())
