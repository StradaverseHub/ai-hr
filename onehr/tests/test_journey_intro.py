"""The welcome, a line at a time (Chris, 2026-10-22: "get the agent to first talk one dialogue by one dialogue, start with
introduction and what it does, next message talks about the navigation and button, lastly what OneHR Agent can assist
... and also notice them please use the Help function on the top right account drop-down to report any issue ... only
then offer would you like to start with your 2026 year-end KPI check-in? ... if user responses and interacts with the
agent, it should stop the automated message and reply to user inquiry").

  * the first turn of an empty transcript is the welcome's four fixed lines, with no model call and nothing stored
  * each line is stored as the page shows it (/review/intro/seen), its text worked out on the server, never twice
  * a message in the middle (intro_next) is answered by the agent, which then offers to carry on (fixed chips, and the
    offer said even when the model leaves it out); "carry on" plays the rest and "skip" goes to the offer, no model
  * a reload in the middle plays the rest (intro_left); a Mid-Year welcome has no Career Plan
  * the page: lines at reading pace, typing pauses them, any turn stops them, the card after the last line

The model is stubbed (a SCRIPT). Writes, so a fresh copy, put back at the end.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
s = H.Suite("The welcome -- OneHR Agent, a line at a time, stopped by a message")
HERE = os.path.dirname(os.path.abspath(__file__))
JS = open(os.path.join(HERE, "..", "static", "journey_chat.js")).read()
CHBM = "CHIN HIN BUILDING MATERIAL (CHBM)"


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','evidence','tm','idp','pm')",
               (CID,))
    db.execute("UPDATE cycles SET kind='mid_year', half=2, starts_on=NULL WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
    ME = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND job_grade IS NOT NULL "
                    "ORDER BY id LIMIT 1").fetchone()
    for name, rates in (("ZZ Intro GP", (9, 11, 12, 13, 15)), ("ZZ Intro DM", (1, 2, 3, 4, 5))):
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                   "business_group, rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?,50,'more','approved',?,?,?,?,?,?)",
                   (CID, ME["id"], name, CHBM) + rates)
    if not db.execute("SELECT 1 FROM pm_bg_config WHERE business_group=?", (CHBM,)).fetchone():
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (CHBM,))
    db.execute("DELETE FROM pm_review_chat WHERE subject_id=?", (ME["id"],))
    db.commit()

SCRIPT, SYSTEMS = [], []


def stub_agent(system, messages, timeout=90):
    SYSTEMS.append(system)   # every model call is counted; an unexpected one answers and the counts catch it
    return SCRIPT.pop(0) if SCRIPT else {"say": "(the model answered)", "quick_replies": [], "action": None}


def rows():
    return H.one(a, "SELECT COUNT(*) FROM pm_review_chat WHERE subject_id=? AND cycle_id=?", (ME["id"], CID))


def reset():
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_review_chat WHERE subject_id=?", (ME["id"],))
        a.get_db().commit()


def steps_for(half=2):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = ME["id"]
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (ME["id"],)).fetchone())
        st = a.review_state(db, u)
        return a._journey_intro_steps(db, u, st, a._journey_active_stage(st, "account"))


_avail, _agent = ai_draft.review_agent_available, ai_draft.review_agent
ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = stub_agent
try:
    E = H.client_as(a, ME["id"])
    s.section("the first turn is the welcome's four lines, no model, nothing stored")
    SCRIPT[:] = []
    n0 = len(SYSTEMS)
    j = post(E, "/review/chat?journey=1", message="", stage="account").get_json() or {}
    st4 = j.get("intro") or []
    s.check("four lines come back, with nothing said in one piece", len(st4) == 4 and not j.get("say"), len(st4))
    s.check("...with no model call", len(SYSTEMS) == n0)
    s.check("...and nothing stored yet (each line is stored as it is shown)", rows() == 0, rows())
    s.check("...and the part's overview, for the card after the last line",
            (j.get("overview") or {}).get("stage") == "account")
    t1, t2, t3, t4 = [x.get("say") or "" for x in st4] + [""] * (4 - len(st4))
    s.check("line 1: OneHR Agent introduces itself and what it does", "I'm OneHR Agent" in t1 and "assistant" in t1
            and "part by part" in t1)
    s.check("line 2: the way round the page and its buttons",
            "tabs at the top" in t2 and "panel on the left" in t2 and "Save & submit" in t2
            and "Nothing is submitted until you confirm" in t2)
    s.check("line 3: what it can help with, and Help in the account menu at the top right for a problem",
            "Here's how I can help" in t3 and "Help in the account menu at the top right" in t3)
    s.check("line 4: where to start, the KPI check-in first and recommended, then 360 and competency",
            "Where would you like to start?" in t4 and "I'd suggest your KPI check-in first." in t4
            and (st4[3].get("quick_replies") if len(st4) == 4 else None)
            == ["KPI check-in (recommended)", "360 feedback", "Competency"], st4[3].get("quick_replies") if st4 else None)
    s.check("...and the card waits for the pick (hold_card on the last line only)",
            st4[3].get("hold_card") is True and not any(x.get("hold_card") for x in st4[:3]))
    s.check("only the last line has chips", all(not x.get("quick_replies") for x in st4[:3]))
    s.check("a Year-End welcome names the Career Plan", "Career Plan" in t4 and "development plan" in t1)

    s.section("each line is stored as it is shown, its text the server's")
    r0 = post(E, "/review/intro/seen", step="0", stage="account").get_json() or {}
    s.check("line 0 stored, as written", r0.get("stored") is True and rows() == 1
            and H.one(a, "SELECT content FROM pm_review_chat WHERE subject_id=? ORDER BY id DESC LIMIT 1",
                      (ME["id"],)) == t1)
    r0b = post(E, "/review/intro/seen", step="0", stage="account").get_json() or {}
    s.check("...never twice", r0b.get("stored") is False and rows() == 1)
    s.check("a line out of range is refused",
            post(E, "/review/intro/seen", step="9", stage="account").status_code == 400 and rows() == 1)
    _route = open(os.path.join(HERE, "..", "app.py")).read().split("def review_intro_seen")[1].split("\ndef ")[0]
    s.check("the page can't send the text (the route reads only the line's number and the part)",
            sorted(set(__import__("re").findall(r'request\.form\.get\("(\w+)"', _route))) == ["stage", "step"])

    s.section("a message in the middle: the agent answers, then offers to carry on")
    n1 = len(SYSTEMS)
    SCRIPT[:] = [{"say": "Hi! Good to meet you.", "quick_replies": ["Tell me more"], "action": None}]
    ji = post(E, "/review/chat?journey=1", message="Hi", stage="account", intro_next="1").get_json() or {}
    s.check("the model answered it, told they spoke during the welcome and what's still to come",
            len(SYSTEMS) == n1 + 1 and "THEY SPOKE DURING YOUR WELCOME" in SYSTEMS[-1]
            and "finding their way round the page" in SYSTEMS[-1])
    s.check("...and the reply offers to carry on even though the model didn't",
            "Shall I carry on with my introduction?" in (ji.get("say") or ""), ji.get("say"))
    s.check("...with the two fixed chips", ji.get("quick_replies") == [a._INTRO_CARRY_ON, a._INTRO_SKIP],
            ji.get("quick_replies"))
    SCRIPT[:] = []
    n2 = len(SYSTEMS)
    jc = post(E, "/review/chat?journey=1", message=a._INTRO_CARRY_ON, stage="account").get_json() or {}
    s.check("'Carry on' plays the rest from the next line, with no model call",
            [x["say"] for x in jc.get("intro") or []] == [t2, t3, t4] and jc.get("intro_from") == 1
            and len(SYSTEMS) == n2, jc.get("intro_from"))

    reset()
    post(E, "/review/intro/seen", step="0", stage="account")
    SCRIPT[:] = [{"say": "Sure. Shall I carry on with my introduction?", "quick_replies": [], "action": None}]
    post(E, "/review/chat?journey=1", message="what is this page?", stage="account", intro_next="1")
    SCRIPT[:] = []
    js_ = post(E, "/review/chat?journey=1", message=a._INTRO_SKIP, stage="account").get_json() or {}
    s.check("'Skip the intro' goes straight to the offer", [x["say"] for x in js_.get("intro") or []] == [t4]
            and js_.get("intro_from") == 3)
    s.check("...a reply that already asked keeps its own words (no doubled question)",
            H.one(a, "SELECT COUNT(*) FROM pm_review_chat WHERE subject_id=? AND content LIKE "
                     "'%carry on with my introduction?%carry on with my introduction?%'", (ME["id"],)) == 0)

    reset()
    post(E, "/review/intro/seen", step="0", stage="account")
    SCRIPT[:] = [{"say": "Hi, good to have you here. Shall I finish the quick introduction, or would you rather go "
                         "straight into your KPI check-in?", "quick_replies": [], "action": None}]
    jo = post(E, "/review/chat?journey=1", message="Hi", stage="account", intro_next="1").get_json() or {}
    s.check("...nor when it asks in its own words (the dev model's 'finish the quick introduction')",
            "carry on with my introduction" not in (jo.get("say") or "") and "introduction" in (jo.get("say") or "")
            and jo.get("quick_replies") == [a._INTRO_CARRY_ON, a._INTRO_SKIP], jo.get("say"))

    reset()
    post(E, "/review/intro/seen", step="0", stage="account")
    SCRIPT[:] = [{"say": "Of course.", "quick_replies": [], "action": None}]
    n3 = len(SYSTEMS)
    jy = post(E, "/review/chat?journey=1", message="yes", stage="account").get_json() or {}
    s.check("a 'yes' that isn't answering the offer is an ordinary turn (the model answers it)",
            not jy.get("intro") and len(SYSTEMS) == n3 + 1 and "THEY SPOKE DURING YOUR WELCOME" not in SYSTEMS[-1])

    s.section("a reload in the middle plays the rest; a finished welcome never comes back")
    reset()
    post(E, "/review/intro/seen", step="0", stage="account")
    post(E, "/review/intro/seen", step="1", stage="account")
    jh = E.get("/review/chat/history?journey=1&stage=account").get_json() or {}
    s.check("the history hands the rest to play (from line 2)",
            (jh.get("intro_left") or {}).get("from") == 2
            and [x["say"] for x in (jh.get("intro_left") or {}).get("steps") or []] == [t3, t4], jh.get("intro_left"))
    with a.app.app_context():
        a.get_db().execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) "
                           "VALUES (?,?,'user','hello',?)", (ME["id"], CID, "account"))
        a.get_db().commit()
    jh2 = E.get("/review/chat/history?journey=1&stage=account").get_json() or {}
    s.check("...not once they've said something since", not jh2.get("intro_left"))
    reset()
    for i in range(4):
        post(E, "/review/intro/seen", step=str(i), stage="account")
    jh3 = E.get("/review/chat/history?journey=1&stage=account").get_json() or {}
    SCRIPT[:] = [{"say": "Back to your KPIs.", "quick_replies": [], "action": None}]
    jn = post(E, "/review/chat?journey=1", message="", stage="account").get_json() or {}
    s.check("once the offer is made the welcome is done: nothing to resume, no second welcome",
            not jh3.get("intro_left") and not jn.get("intro"))

    s.section("the pick from the last line opens that part's card, no model call")
    def offered():
        reset()
        for i in range(4):
            post(E, "/review/intro/seen", step=str(i), stage="account")
    offered()
    jh4 = E.get("/review/chat/history?journey=1&stage=account").get_json() or {}
    s.check("a reload while the offer waits holds the card back (intro_hold)", jh4.get("intro_hold") is True)
    for chip, stage in (("KPI check-in (recommended)", "account"), ("360 feedback", "feedback"),
                        ("Competency", "competency")):
        offered()
        n5, r5 = len(SYSTEMS), rows()
        jp = post(E, "/review/chat?journey=1", message=chip, stage="account").get_json() or {}
        s.check("'%s' opens %s with its card, a fixed line and no model call" % (chip, stage),
                jp.get("stage") == stage and (jp.get("overview") or {}).get("stage") == stage
                and jp.get("say") == a._INTRO_START_SAY[stage] and jp.get("moved") is True
                and len(SYSTEMS) == n5 and rows() == r5 + 2, (jp.get("stage"), jp.get("say")))
        jh5 = E.get("/review/chat/history?journey=1&stage=" + stage).get_json() or {}
        s.check("...and the card is no longer held", not jh5.get("intro_hold"))
        _ms = [m for m in jh5.get("messages") or [] if m.get("role") == "agent"]
        s.check("...and on a reload the welcome's lines are marked (the card goes under the pick's line)",
                [bool(m.get("intro")) for m in _ms] == [True] * 4 + [False], [bool(m.get("intro")) for m in _ms])
    offered()
    post(E, "/review/chat?journey=1", message="KPI check-in (recommended)", stage="account")
    SCRIPT[:] = [{"say": "Sure.", "quick_replies": [], "action": None}]
    n6 = len(SYSTEMS)
    jq = post(E, "/review/chat?journey=1", message="KPI check-in (recommended)", stage="account").get_json() or {}
    s.check("once a part is picked the chip's words are an ordinary turn (the model answers)",
            len(SYSTEMS) == n6 + 1 and jq.get("say") != a._INTRO_START_SAY["account"] and not jq.get("intro_hold"))

    s.section("Chris's run (2026-10-22): interrupt, carry on, ask after the offer, then pick -- no card until the pick")
    reset()
    post(E, "/review/intro/seen", step="0", stage="account")
    post(E, "/review/intro/seen", step="1", stage="account")
    SCRIPT[:] = [{"say": "Hi! Shall I carry on with the introduction, or would you like to start your KPI check-in?",
                  "quick_replies": [], "action": None}]
    jx = post(E, "/review/chat?journey=1", message="hi", stage="account", intro_next="2").get_json() or {}
    s.check("the reply to an interruption holds the card (intro_hold) and offers to carry on",
            jx.get("intro_hold") is True and jx.get("quick_replies") == [a._INTRO_CARRY_ON, a._INTRO_SKIP]
            and not any((r or {}).get("type") in a._WIDGET_FOCUS_TYPES for r in jx.get("renders") or []))
    jhx = E.get("/review/chat/history?journey=1&stage=account").get_json() or {}
    s.check("...and so does a reload in the middle of it", jhx.get("intro_hold") is True)
    jc2 = post(E, "/review/chat?journey=1", message=a._INTRO_CARRY_ON, stage="account").get_json() or {}
    s.check("'Carry on' plays the rest", (jc2.get("intro_from") == 2))
    post(E, "/review/intro/seen", step="2", stage="account")
    post(E, "/review/intro/seen", step="3", stage="account")
    SCRIPT[:] = [{"say": "A KPI is a key performance indicator. Tell me your result and I'll put it on your card below.",
                  "quick_replies": ["Tell me more"], "action": None}]
    jw = post(E, "/review/chat?journey=1", message="what is a KPI?", stage="account").get_json() or {}
    s.check("a question after the offer is answered by the model, still with no card, and the start chips come back",
            jw.get("intro_hold") is True
            and jw.get("quick_replies") == ["KPI check-in (recommended)", "360 feedback", "Competency"]
            and not any((r or {}).get("type") in a._WIDGET_FOCUS_TYPES for r in jw.get("renders") or []),
            (jw.get("quick_replies"), jw.get("renders")))
    n7 = len(SYSTEMS)
    jk = post(E, "/review/chat?journey=1", message="KPI check-in (recommended)", stage="account").get_json() or {}
    s.check("then KPI check-in opens it, with the card brought to the pick's line (it may be up already), no model",
            jk.get("stage") == "account" and jk.get("say") == a._INTRO_START_SAY["account"] and len(SYSTEMS) == n7
            and any((r or {}).get("type") == "kpi_progress" for r in jk.get("renders") or [])
            and not jk.get("intro_hold"), jk.get("renders"))
    jhk = E.get("/review/chat/history?journey=1&stage=account").get_json() or {}
    _mk = jhk.get("messages") or []
    s.check("a reload after the pick: no hold, everything before the pick marked as the welcome, the pick's line not",
            not jhk.get("intro_hold") and _mk and all(m.get("intro") for m in _mk[:-1]) and not _mk[-1].get("intro")
            and any((c or {}).get("type") == "kpi_progress" for c in _mk[-1].get("card") or []))

    reset()
    for i in range(4):
        post(E, "/review/intro/seen", step=str(i), stage="account")
    n8 = len(SYSTEMS)
    jn2 = post(E, "/review/chat?journey=1", message="let's do my competency", stage="account").get_json() or {}
    s.check("while it holds, a part named outright is the pick too (no model)",
            jn2.get("stage") == "competency" and jn2.get("say") == a._INTRO_START_SAY["competency"]
            and len(SYSTEMS) == n8, (jn2.get("stage"), jn2.get("say")))
    s.section("Chris's run (2026-10-22): 'hi, go to my kpi' in the middle of the welcome is the pick")
    for said, want in (("hi, go to my kpi", "account"), ("can you open my competency please", "competency"),
                       ("Hello! Take me to the 360 feedback", "feedback"), ("start with KPI", "account"),
                       ("hi there, can we do the kpi part first", "account"), ("hi, kpi check-in", "account")):
        reset()
        post(E, "/review/intro/seen", step="0", stage="account")
        n9 = len(SYSTEMS)
        jg = post(E, "/review/chat?journey=1", message=said, stage="account", intro_next="1").get_json() or {}
        s.check("'%s' opens %s, no model" % (said, want),
                jg.get("stage") == want and jg.get("say") == a._INTRO_START_SAY[want] and len(SYSTEMS) == n9,
                (jg.get("stage"), jg.get("say")))
    for said in ("what is a kpi?", "how do I start my 360?", "go"):
        reset()
        post(E, "/review/intro/seen", step="0", stage="account")
        SCRIPT[:] = [{"say": "Happy to explain.", "quick_replies": [], "action": None}]
        n10 = len(SYSTEMS)
        jq2 = post(E, "/review/chat?journey=1", message=said, stage="account", intro_next="1").get_json() or {}
        s.check("'%s' is not a pick: the model answers, told no card is on screen, and the card stays held" % said,
                len(SYSTEMS) == n10 + 1 and "NO PART IS OPEN YET" in SYSTEMS[-1] and jq2.get("intro_hold") is True,
                jq2.get("say"))
    reset()
    for i in range(4):
        post(E, "/review/intro/seen", step=str(i), stage="account")
    post(E, "/review/chat?journey=1", message="KPI check-in (recommended)", stage="account")
    SCRIPT[:] = [{"say": "Sure.", "quick_replies": [], "action": None}]
    post(E, "/review/chat?journey=1", message="what is a KPI?", stage="account")
    s.check("once a part is picked the model isn't told no part is open", "NO PART IS OPEN YET" not in SYSTEMS[-1])

    reset()
    for i in range(4):
        post(E, "/review/intro/seen", step=str(i), stage="account")
    SCRIPT[:] = [{"say": "Here's your 360 feedback.", "quick_replies": [], "action": None}]
    jt = post(E, "/review/chat?journey=1", message="", stage="feedback").get_json() or {}
    jht = E.get("/review/chat/history?journey=1&stage=feedback").get_json() or {}
    s.check("a tab clicked instead ends the hold: its card shows", not jt.get("intro_hold")
            and not jht.get("intro_hold"))
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = ME["id"]
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (ME["id"],)).fetchone())
        st = a.review_state(db, u)
        st_done = dict(st, stages=[dict(x, state=a.REVIEW_STATE_DONE) if x["key"] == "account" else x
                                   for x in st["stages"]])
        keys = [k for k, _ in a._journey_intro_starts(st_done)]
    s.check("a part already done isn't offered", "account" not in keys and "feedback" in keys, keys)

    s.section("a Mid-Year welcome")
    with a.app.app_context():
        a.get_db().execute("UPDATE cycles SET half=1 WHERE id=?", (CID,))
        a.get_db().commit()
    mid = steps_for()
    s.check("names PM and TM only, and no Career Plan",
            len(mid) == 4 and "Individual Development Plan" not in mid[1]["say"]
            and "Career Plan" not in " ".join(x["say"] for x in mid) and "Mid-Year" in mid[3]["say"])
    with a.app.app_context():
        a.get_db().execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
        a.get_db().commit()
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _avail, _agent

s.section("the page: reading pace, typing pauses, any turn stops, the card after the last line")
s.check("the lines play one at a time with typing dots, and each is stored as it shows",
        "function introPlay(" in JS and "rv-typing-dots" in JS and '"/review/intro/seen"' in JS)
s.check("the pause between lines follows the line's length (reading time)", "function introReadMs(" in JS
        and "introNext(introReadMs(step.say))" in JS)
s.check("typing in the box pauses them", 'input.addEventListener("input", introTyping)' in JS)
s.check("any turn stops them, and a message says where", "var introCut = introStop();" in JS
        and 'if (introCut != null && msg) f.append("intro_next", introCut);' in JS)
s.check("the part's card comes after the last line, unless it waits for the pick",
        "if (j && j.intro) { refreshBanner(j.overview); introPlay(" in JS
        and "if (ov !== undefined && !step.hold_card) refreshStage(ov);" in JS
        and "if (!startPart && !j.intro_hold)" in JS
        and 'm.role === "agent" && !m.intro && !j.intro_hold' in JS
        and "!shownSnaps[prevStage] && runReal)" in JS and "if (!m.intro) runReal = true;" in JS
        and "else if (j && j.intro_hold) refreshBanner(j.overview);" in JS)
s.check("the four lines take about 12 s (50 ms a word, 1.5-4 s a line, 0.5 s of dots)",
        "Math.min(4000, Math.max(1500, words * 50 + 300))" in JS and "intro.timer = setTimeout(introShow, 500);" in JS)
s.check("a reload in the middle goes on from where it was", "j.intro_left" in JS)

H.restore_db()
sys.exit(s.done())
