"""Answers from the chat (Chris, 2026-10-21: "let the agent record answers from the chat for KPI, competency and 360
(the card still works too)"). Since the 3-step check-in (2026-09-22) the journey's step 1 told the agent the card's
Save records everything and "you do NOT record them one by one", while its tools and a free-text line still invited it
to: on staging it answered "Please enter 16 for that result in the table". Now an answer goes in either way:

  * the prompts: KPI, competency and 360 say "either way" and that the agent records what they tell it, never the
    old card-only rule; a several-answer call (items) is offered in the journey only
  * the journey's record_kpi_result: the same write as the table's Save, and a standout (AE / OU) line asks for a
    FILE (the journey's evidence), never the standalone check-in's written example (log_evidence)
  * items: several answers in ONE call for the three answer tools, each through its one-answer writer; a refused
    item is tried once more after the rest (a competency's higher level waits on its lower one)
  * the turn: a batch's reply reaches the model whole (it was cut at 400 characters)
  * the client: a figure recorded since a KPI row was drawn wins over the box's old typing

The model is stubbed (a SCRIPT). Writes, so a fresh copy.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
s = H.Suite("Answers from the chat -- KPI, competency and 360 recorded by the agent too")

CHBM = "CHIN HIN BUILDING MATERIAL (CHBM)"   # mechanism A (5-point) in the fixture
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "..", "app.py")).read()
JS = open(os.path.join(HERE, "..", "static", "journey_chat.js")).read()


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


# ---------------------------------------------------------------------------
s.section("build: one person with KPI lines, competencies and two colleagues to rate")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','evidence','tm','idp','pm')")
    db.execute("UPDATE cycles SET kind='mid_year', half=2, starts_on=NULL WHERE id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
    us = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND job_grade IS NOT NULL "
                    "ORDER BY id LIMIT 4").fetchall()
    ME, OTHER, C1, C2 = us[0], us[1], us[2], us[3]

    def kpi(subj, name, rates, unit=None, method="more"):
        r = dict(zip(("rate1", "rate2", "rate3", "rate4", "rate5"), rates))
        return db.execute(
            "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, "
            "status, business_group, rate1, rate2, rate3, rate4, rate5) "
            "VALUES (?,?,?,?,?,?, 'approved', ?, ?, ?, ?, ?, ?)",
            (CID, subj, name, 50.0, method, unit, CHBM, r["rate1"], r["rate2"], r["rate3"],
             r["rate4"], r["rate5"])).lastrowid

    GP = kpi(ME["id"], "ZZ Gross Profit", (9, 11, 12, 13, 15), "RM (mil)")
    DM = kpi(ME["id"], "ZZ Direct Materials", (53, 46, 42, 38, 32), "%", "less")
    OTHER_KPI = kpi(OTHER["id"], "ZZ Their Line", (1, 2, 3, 4, 5))
    if not db.execute("SELECT 1 FROM pm_bg_config WHERE business_group=?", (CHBM,)).fetchone():
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (CHBM,))

    def skill(code, title, lvl):
        return db.execute(
            "INSERT INTO tc_skills(skill_code, title, level, skill_category, proficiency_description, "
            "ability_items, active) VALUES (?,?,?,?,?,?,1)",
            (code, title, lvl, "Analytics", title + " at level " + str(lvl), "- do the thing")).lastrowid

    def tc_assign(subj, sid, fut):
        return db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, source) "
                          "VALUES (?,?,?,?, 'profile')", (CID, subj, sid, fut)).lastrowid

    PL_LO = tc_assign(ME["id"], skill("ZZCE-PL3", "Planning", 3), 0)
    PL_HI = tc_assign(ME["id"], skill("ZZCE-PL4", "Planning", 4), 1)   # the same competency, one level up
    BUD = tc_assign(ME["id"], skill("ZZCE-BU3", "Budgeting", 3), 0)
    DA_LO = tc_assign(ME["id"], skill("ZZCE-DA3", "Data Analysis", 3), 0)   # both levels unanswered: the chat path
    DA_HI = tc_assign(ME["id"], skill("ZZCE-DA4", "Data Analysis", 4), 1)
    FC_LO = tc_assign(ME["id"], skill("ZZCE-FC3", "Forecasting", 3), 0)     # both unanswered: the card's own writer
    FC_HI = tc_assign(ME["id"], skill("ZZCE-FC4", "Forecasting", 4), 1)
    QA_LO = tc_assign(ME["id"], skill("ZZCE-QA3", "Quality Assurance", 3), 0)  # the card's Save: any pair goes
    QA_HI = tc_assign(ME["id"], skill("ZZCE-QA4", "Quality Assurance", 4), 1)
    RR_LO = tc_assign(ME["id"], skill("ZZCE-RR3", "Risk Review", 3), 0)        # the agent: next_level when named
    RR_HI = tc_assign(ME["id"], skill("ZZCE-RR4", "Risk Review", 4), 1)
    OTHER_TC = tc_assign(OTHER["id"], skill("ZZCE-OT3", "Theirs", 3), 0)

    db.execute("DELETE FROM assignments WHERE cycle_id=? AND assessor_id IN (?,?)", (CID, ME["id"], OTHER["id"]))

    def fb_assign(assessor, subject):
        return db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) "
                          "VALUES (?,?,?, 'peer', 'pending')", (CID, subject["id"], assessor["id"])).lastrowid

    A1 = fb_assign(ME, C1)
    A_OTHER = fb_assign(OTHER, C2)   # someone else's colleague
    STMTS = [r["statement_id"] for r in a.statements_for_grade(db, C1["job_grade"], CID)]
    db.commit()
s.check("the fixture has behaviours at the colleague's grade", len(STMTS) >= 3, len(STMTS))


def with_ctx(uid, fn):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
        return fn(db, u)


def dispatch(stage, tool, args, uid=None):
    return with_ctx(uid or ME["id"], lambda db, u: a._journey_run_stage_tool(
        db, u, CID, stage, {"tool": tool, "args": args}))


def result_of(kid):
    return H.one(a, "SELECT MAX(actual_value) FROM pm_kpi_results WHERE kpi_target_id=?", (kid,))


def tc_answer(aid):
    return H.one(a, "SELECT MAX(sc.answer) FROM tc_scores sc JOIN tc_assessments t ON t.id=sc.assessment_id "
                    "WHERE sc.assignment_id=? AND t.subject_id=?", (aid, ME["id"]))


def safe(r):
    """A tool reply without the colleague's name (the harness copy holds real names: details show ids and counts)."""
    return {k: v for k, v in (r or {}).items() if k != "colleague"}


def fb_answer(aid, sid):
    return H.one(a, "SELECT MAX(answer) FROM responses WHERE assignment_id=? AND statement_id=?", (aid, sid))


# ---------------------------------------------------------------------------
s.section("the prompts: either way, and the agent records what they tell it")
st = with_ctx(ME["id"], lambda db, u: a.review_state(db, u))
P_KPI = with_ctx(ME["id"], lambda db, u: a._journey_agent_system(db, u, st, "account"))
P_TC = with_ctx(ME["id"], lambda db, u: a._journey_agent_system(db, u, st, "competency"))
P_FB = with_ctx(ME["id"], lambda db, u: a._journey_agent_system(db, u, st, "feedback", A1))
OLD = ("you do NOT record them one by one", "you do NOT record them one at a time", "you do NOT rate them one at a time")
for name, p in (("KPI", P_KPI), ("competency", P_TC), ("360", P_FB)):
    s.check("%s: the old card-only rule is gone" % name, not any(o in p for o in OLD))
    s.check("%s: an answer goes in EITHER way" % name, "goes in EITHER way" in p)
    s.check("%s: never send them to the card for an answer they gave" % name,
            "never send them to the" in p and "already told" in p)
    s.check("%s: several answers in one call are offered (items)" % name, "items: [{" in p)
s.check("KPI: the agent records with record_kpi_result in this reply", "YOU record it with record_kpi_result" in P_KPI)
s.check("KPI: a figure is said back, not asked to be confirmed first",
        "say back the number you recorded" in P_KPI and "confirm the number you understood" not in P_KPI)
s.check("KPI: a changed figure is recorded again; never one changed on its own",
        "record it again" in P_KPI and "never change a keyed number on your own" in P_KPI)
s.check("competency: recorded with set_competency, only what THEY decided",
        "YOU record it with set_competency" in P_TC and "Record only what THEY decided" in P_TC)
s.check("360: recorded with rate_behaviour, about the colleague on screen only",
        "YOU record it with rate_behaviour" in P_FB and "THIS colleague" in P_FB)
# items exist only where the journey dispatches them: the standalone check-in keeps one answer a call
P_STANDALONE = with_ctx(ME["id"], lambda db, u: a._review_agent_system(db, u, st, journey=False))
s.check("the standalone check-in's tools line offers no items (no batch there)",
        "items: [{" not in P_STANDALONE and "record_kpi_result{kpi_id, actual_value}" in P_STANDALONE)

# ---------------------------------------------------------------------------
s.section("KPI: the journey's record_kpi_result writes the table's draft and asks a standout for a FILE")
r = dispatch("account", "record_kpi_result", {"kpi_id": GP, "actual_value": "12"})
s.check("a figure from the chat is recorded (ok, the server's band)", r.get("ok") is True and r.get("band"), r)
s.check("...as the same private DRAFT the table's Save writes",
        result_of(GP) == 12.0
        and H.one(a, "SELECT draft FROM pm_kpi_results WHERE kpi_target_id=?", (GP,)) == 1)
s.check("a Meets line asks for nothing next", "next_step" not in r, r)
s.check("the reply names the line it recorded (the composer's pre-select)", r.get("kpi_id") == GP, r)
r16 = dispatch("account", "record_kpi_result", {"kpi_id": GP, "actual_value": "16"})
s.check("a changed figure records over the draft (16 -> Outstanding)",
        r16.get("ok") is True and result_of(GP) == 16.0 and r16.get("band") == a.PM_LABEL_NAMES.get("OU"), r16)
s.check("...and asks for a supporting FILE for that standout line",
        "FILE" in (r16.get("next_step") or "") and "ZZ Gross Profit" in (r16.get("next_step") or ""), r16)
s.check("...never the standalone's written example (no 'call log_evidence')",
        "call log_evidence" not in (r16.get("next_step") or ""), r16.get("next_step"))
# the relationship: the shared tool, outside the journey, still asks for the written example
std = with_ctx(ME["id"], lambda db, u: a._REVIEW_TOOLS["record_kpi_result"](
    db, u, CID, {"kpi_id": GP, "actual_value": "16"}))
s.check("(the standalone tool still steers to log_evidence -- the journey wrapper is what differs)",
        "log_evidence" in (std.get("next_step") or ""))   # no detail: the hint carries the person's first name
_real_att = a._review_kpi_attachment_ids
a._review_kpi_attachment_ids = lambda db, u: {GP}
try:
    rf = dispatch("account", "record_kpi_result", {"kpi_id": GP, "actual_value": "16"})
finally:
    a._review_kpi_attachment_ids = _real_att
s.check("a standout line that already has its file asks for nothing", rf.get("ok") and "next_step" not in rf, rf)
with a.app.app_context():
    a.get_db().execute("UPDATE cycle_modules SET active=0 WHERE module_key='evidence'")
    a.get_db().commit()
try:
    roff = dispatch("account", "record_kpi_result", {"kpi_id": GP, "actual_value": "16"})
finally:
    with a.app.app_context():
        a.get_db().execute("UPDATE cycle_modules SET active=1 WHERE module_key='evidence'")
        a.get_db().commit()
s.check("with the evidence module off, no file is asked", roff.get("ok") and "next_step" not in roff, roff)
s.check("another person's line is refused, nothing written",
        dispatch("account", "record_kpi_result", {"kpi_id": OTHER_KPI, "actual_value": "3"}).get("ok") is False
        and result_of(OTHER_KPI) is None)

# ---------------------------------------------------------------------------
s.section("KPI: several figures in ONE call")
with a.app.app_context():
    a.get_db().execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (?,?)", (GP, DM))
    a.get_db().commit()
rb = dispatch("account", "record_kpi_result", {"items": [{"kpi_id": GP, "actual_value": "16"},
                                                         {"kpi_id": DM, "actual_value": "41%"}]})
s.check("both figures land in one call", rb.get("ok") is True and result_of(GP) == 16.0 and result_of(DM) == 41.0, rb)
s.check("...the reply lists each recorded line", len(rb.get("recorded") or []) == 2, rb)
s.check("...a standout among them carries the file ask", "FILE" in (rb.get("next_step") or ""), rb)
s.check("...and its pre-select is the standout still owed a file", rb.get("kpi_id") == GP, rb)
rmix = dispatch("account", "record_kpi_result", {"items": [{"kpi_id": DM, "actual_value": "40"},
                                                           {"kpi_id": OTHER_KPI, "actual_value": "3"}]})
s.check("a refused item doesn't stop the rest: own line recorded, the foreign one refused",
        rmix.get("ok") is True and result_of(DM) == 40.0 and result_of(OTHER_KPI) is None
        and len(rmix.get("refused") or []) == 1 and rmix["refused"][0].get("error"), rmix)
rnone = dispatch("account", "record_kpi_result", {"items": [{"kpi_id": OTHER_KPI, "actual_value": "3"}]})
s.check("when nothing lands the call is not ok and says so", rnone.get("ok") is False and rnone.get("error"), rnone)
s.check("items that aren't a list are refused",
        dispatch("account", "record_kpi_result", {"items": "16"}).get("ok") is False)
rcap = dispatch("account", "record_kpi_result",
                {"items": [{"kpi_id": OTHER_KPI, "actual_value": "1"}] * 60})
s.check("a call takes at most %d items" % a._JOURNEY_BATCH_MAX,
        len(rcap.get("refused") or []) == a._JOURNEY_BATCH_MAX, len(rcap.get("refused") or []))
_gp_before = result_of(GP)
s.check("items work only through the journey's dispatch: the standalone tool refuses them, nothing written",
        with_ctx(ME["id"], lambda db, u: a._REVIEW_TOOLS["record_kpi_result"](
            db, u, CID, {"items": [{"kpi_id": GP, "actual_value": "1"}]})).get("ok") is False
        and result_of(GP) == _gp_before)

# ---------------------------------------------------------------------------
s.section("competency: several answers in one call, a higher level after its lower one")
dispatch("competency", "set_competency", {"assignment_id": PL_LO, "answer": "no"})
s.check("(baseline: the lower level is Developing)", tc_answer(PL_LO) == "no")
s.check("(baseline: from the chat, the next level alone is refused while the current is Developing)",
        dispatch("competency", "set_competency", {"assignment_id": PL_HI, "answer": "yes"}).get("ok") is False
        and tc_answer(PL_HI) is None)
rc = dispatch("competency", "set_competency", {"items": [{"assignment_id": PL_HI, "answer": "yes"},
                                                          {"assignment_id": PL_LO, "answer": "yes"},
                                                          {"assignment_id": BUD, "answer": "Developing"}]})
s.check("'all Demonstrate except budgeting' lands whole, the higher level retried after the lower",
        rc.get("ok") is True and not rc.get("refused")
        and (tc_answer(PL_LO), tc_answer(PL_HI), tc_answer(BUD)) == ("yes", "yes", "no"), rc)
s.check("...the reply lists each with its answer", len(rc.get("recorded") or []) == 3
        and all(x.get("competency") and x.get("answer") for x in rc["recorded"]), rc)
rco = dispatch("competency", "set_competency", {"items": [{"assignment_id": OTHER_TC, "answer": "yes"}]})
s.check("another person's competency is refused", rco.get("ok") is False and tc_answer(OTHER_TC) is None, rco)

s.section("competency from the chat: a higher level waits for its first level (staging probe, 2026-10-21)")
r_hi = dispatch("competency", "set_competency", {"assignment_id": DA_HI, "answer": "yes"})
s.check("the higher level alone is refused while its first level has no answer, nothing written",
        r_hi.get("ok") is False and tc_answer(DA_HI) is None and tc_answer(DA_LO) is None, r_hi)
s.check("...and the refusal names the first level to record instead",
        "assignment_id %d" % DA_LO in (r_hi.get("error") or ""), r_hi.get("error"))
s.check("Developing on the higher level isn't held back (only Demonstrate waits)",
        dispatch("competency", "set_competency", {"assignment_id": DA_HI, "answer": "no"}).get("ok") is True
        and tc_answer(DA_HI) == "no" and tc_answer(DA_LO) is None)
rfull = dispatch("competency", "set_competency", {"items": [{"assignment_id": DA_HI, "answer": "yes"},
                                                             {"assignment_id": DA_LO, "answer": "yes"}]})
s.check("'I fully demonstrate it': both levels in one call land, the higher after the first",
        rfull.get("ok") is True and not rfull.get("refused")
        and (tc_answer(DA_LO), tc_answer(DA_HI)) == ("yes", "yes"), rfull)
rcard = with_ctx(ME["id"], lambda db, u: a._tc_tool_set_competency(db, u, CID, {"assignment_id": FC_HI, "answer": "yes"}))
s.check("the card's own writer is unchanged: it still takes the higher level alone",
        rcard.get("ok") is True and tc_answer(FC_HI) == "yes" and tc_answer(FC_LO) is None, rcard)
s.section("the next level Demonstrate over a Developing current one is theirs to give (Chris, 2026-10-21)")
Ec = H.client_as(a, ME["id"])
rsv = post(Ec, "/review/competency/save-all", **{"answer_%d" % QA_LO: "no", "answer_%d" % QA_HI: "yes"}).get_json() or {}
s.check("the card's Save takes current Developing + next Demonstrate, with no error",
        rsv.get("ok") is True and not rsv.get("errors")
        and (tc_answer(QA_LO), tc_answer(QA_HI)) == ("no", "yes"), {k: rsv.get(k) for k in ("ok", "errors")})
r_nn = dispatch("competency", "set_competency", {"assignment_id": RR_LO, "answer": "no"})
r_ag = dispatch("competency", "set_competency", {"assignment_id": RR_HI, "answer": "yes"})
s.check("from the chat, the next level over a Developing current one needs next_level: refused without it",
        r_nn.get("ok") is True and r_ag.get("ok") is False and tc_answer(RR_HI) is None
        and "next_level=true" in (r_ag.get("error") or "") and "assignment_id %d" % RR_LO in (r_ag.get("error") or "")
        and "Developing" in (r_ag.get("error") or ""), r_ag)
r_ok = dispatch("competency", "set_competency", {"assignment_id": RR_HI, "answer": "yes", "next_level": True})
s.check("...and recorded with next_level: true, the current level left Developing",
        r_ok.get("ok") is True and (tc_answer(RR_LO), tc_answer(RR_HI)) == ("no", "yes"), r_ok)
with a.app.app_context():
    a.get_db().execute("DELETE FROM tc_scores WHERE assignment_id IN (?,?)", (RR_LO, RR_HI))
    a.get_db().commit()
r_b = dispatch("competency", "set_competency", {"items": [
    {"assignment_id": RR_HI, "answer": "yes", "next_level": "true"}, {"assignment_id": RR_LO, "answer": "no"}]})
s.check("'I have the next level but not the current': both in one call, next_level on the next",
        r_b.get("ok") is True and not r_b.get("refused") and (tc_answer(RR_LO), tc_answer(RR_HI)) == ("no", "yes"), r_b)
s.check("the prompt tells the agent the pair is theirs to give, and about next_level",
        "demonstrate the NEXT level while still developing the current one" in P_TC and "next_level" in P_TC)
SRC_W = SRC[SRC.find("def _tc_tool_set_competency("):SRC.find("def _tc_agent_set_competency(")]
s.check("the shared writer (the card's Save) holds no level rule any more",
        "is_future=1" not in SRC_W and "lo_ans" not in SRC_W)

s.check("the prompt: a first answer goes on the LOWER level, both in one call when they fully demonstrate it",
        "first answer for a competency named without its level goes on the LOWER one" in P_TC
        and "both in one call (items) when they say they fully demonstrate it" in P_TC)

# ---------------------------------------------------------------------------
s.section("360: several behaviours for the colleague on screen in one call")
rf3 = dispatch("feedback", "rate_behaviour", {"assignment_id": A1, "items": [
    {"statement_id": STMTS[0], "answer": "yes"}, {"statement_id": STMTS[1], "answer": "yes"},
    {"statement_id": STMTS[2], "answer": "no"}]})
s.check("three behaviours land in one call",
        rf3.get("ok") is True and [fb_answer(A1, x) for x in STMTS[:3]] == ["yes", "yes", "no"], safe(rf3))
s.check("...the reply carries the card's progress (answered of total)",
        rf3.get("answered") == 3 and rf3.get("total") == len(STMTS), safe(rf3))
rbad = dispatch("feedback", "rate_behaviour", {"assignment_id": A1, "items": [
    {"statement_id": STMTS[3] if len(STMTS) > 3 else STMTS[0], "answer": "yes"},
    {"statement_id": 999999, "answer": "yes"}]})
s.check("a behaviour not on this colleague's list is refused, the rest recorded",
        rbad.get("ok") is True and len(rbad.get("refused") or []) == 1, safe(rbad))
rother = dispatch("feedback", "rate_behaviour", {"assignment_id": A_OTHER, "items": [
    {"statement_id": STMTS[0], "answer": "yes"}]})
s.check("someone else's colleague can't be rated", rother.get("ok") is False
        and fb_answer(A_OTHER, STMTS[0]) is None, safe(rother))

# ---------------------------------------------------------------------------
s.section("the turn: a batch's reply reaches the model whole")
SCRIPT, SEEN = [], []


def stub_agent(system, messages, timeout=90):
    SEEN.append([dict(m) for m in messages])
    return SCRIPT.pop(0)


_real_avail, _real_agent = ai_draft.review_agent_available, ai_draft.review_agent
ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = stub_agent
try:
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (?,?)", (GP, DM))
        a.get_db().commit()
    E = H.client_as(a, ME["id"])
    many = [{"kpi_id": OTHER_KPI, "actual_value": str(i)} for i in range(8)]
    SCRIPT[:] = [
        {"say": "Recording both.", "quick_replies": [],
         "action": {"tool": "record_kpi_result", "args": {"items": [{"kpi_id": GP, "actual_value": "12"},
                                                                    {"kpi_id": DM, "actual_value": "41"}] + many}}},
        {"say": "Recorded 12 RM (mil) for Gross Profit and 41% for Direct Materials.", "quick_replies": [],
         "action": None},
    ]
    rt = post(E, "/review/chat?journey=1", message="gross profit closed at 12 mil and direct materials 41%",
              stage="account").get_json()
    s.check("the turn recorded both figures from one message", result_of(GP) == 12.0 and result_of(DM) == 41.0,
            (rt or {}).get("say"))
    s.check("...and its overview carries them for the table",
            {l.get("kpi_id"): l.get("result") for l in ((rt.get("overview") or {}).get("data") or {}).get("lines", [])
             }.get(GP) == "12", (rt.get("overview") or {}).get("stage"))   # the table's own formatted figure
    _tool_msgs = [m for m in (SEEN[-1] if SEEN else []) if m.get("role") == "tool"]
    _feed = _tool_msgs[-1]["content"] if _tool_msgs else ""
    s.check("the batch reply the model read is longer than the old 400-character cut", len(_feed) > 400, len(_feed))
    try:
        _parsed = json.loads(_feed)
    except ValueError:
        _parsed = None
    s.check("...and whole: it parses, with every refused item and both recorded lines",
            bool(_parsed) and len(_parsed.get("refused") or []) == len(many)
            and len(_parsed.get("recorded") or []) == 2, _feed[-120:])
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _real_avail, _real_agent

# ---------------------------------------------------------------------------
s.section("the client: a figure recorded since the row was drawn wins over the box's old typing")
_r0 = JS.find("function refreshKpiRows")
_r1 = JS.find("\n  function ", _r0 + 1)
_RK = JS[_r0:_r1]
s.check("refreshKpiRows knows a figure recorded since the row was drawn",
        'var recordedNow = l.result != null && String(l.result) !== prevOrig;' in _RK)
s.check("...and never carries the old typing over it", "!recordedNow &&" in _RK)

# This suite changes the cycle (kind, half, start), switches modules and review_unified on, and adds people's KPI lines,
# competencies and 360 panels: put the scratch copy back for the next suite in its batch (tests/run_parallel.sh).
H.restore_db()
sys.exit(s.done())
