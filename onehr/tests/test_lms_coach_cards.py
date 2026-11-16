"""AI+ Learning, the redesign's second slice (Chris, 2026-10-22: "go with the redesign", then "continue with 17B and the
rest of the redesign"; LMS canvas board 17B).

What this suite holds:
  * a month of the calendar as a card in the coach's conversation: the calendar's own rule (only runs open to them,
    nothing in draft), their plan's marked, the month's runs counted in OneHR's words; "show me November" answered in
    code with no model, a longer question left to the model (which can ask for show_month); the arrows redraw it and
    keep nothing
  * a programme as a card: format, days and hours, what it builds for them, the run to register for; nothing to
    register for where it isn't open to them; none for a draft; under the model's answer after programme_facts, but not
    on the programme's own page; a run tapped on the month card opens it in code, kept as a turn
  * a card on their page: show_card only for something on it (on_this_page), with Go to it in its tab
  * the check-in's own address opens its card in the Apply tab (a sent 3-month one with Change it), and every save and
    dashboard row lands on its card
Everything here is synthetic (ZZLK / ZZ9LK-) and removed at the end.
"""
import html
import json
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: the coach's cards in the shell (17B)")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG = "ZZLK Group"
_ENV0 = os.environ.get("ONEHR_LMS")
_TURN0, _AVAIL0 = a.ai_draft.lms_coach_turn, a.ai_draft.review_agent_available


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LK-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLK %'")
    if ul:
        ph = ",".join("?" * len(ul))
        for t in ("lms_coach_chat", "lms_interest", "lms_registrations"):
            db.execute("DELETE FROM %s WHERE user_id IN (%s)" % (t, ph), ul)
        db.execute("DELETE FROM pm_idp WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZLK-%'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, grade="15", mgr=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id) VALUES (?,?, 'x', 'user', ?,?, 'ZZLK U1', "
                      "'ZZLK Sales', 'ZZLK Officer', ?, ?)", (eid.lower(), "ZZ LK " + eid.split("-")[1], eid, BG, grade,
                                                               mgr)).lastrowid


def prog(db, title, key, level, status="published", aud=None):
    pid = db.execute("INSERT INTO lms_programmes(title, kind, status, description, audience_json, days, hours) VALUES "
                     "(?, 'inhouse', ?, 'ZZLK about it.', ?, 1, 7)", (title, status, aud)).lastrowid
    db.execute("INSERT INTO lms_programme_competencies(programme_id, comp_key, level, confirmed) VALUES (?,?,?,1)",
               (pid, key, level))
    return pid


def sess(db, pid, day, seats=10):
    return db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, start_time, end_time, venue, "
                      "seats) VALUES (?, 'ZZLK run', ?, ?, '09:00', '17:00', 'ZZLK Room', ?)", (pid, day, day, seats)).lastrowid


def came(db, uid, sid, pid):
    return db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, outcome, "
                      "hours) VALUES (?,?,?, 'approved', '[]', 'attended', 7)", (uid, sid, pid)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZLK U1')", (BG,))
    for lv in (3, 4):
        db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, proficiency_description, "
                   "active) VALUES (?,?,?,?,?,?,1)", ("ZZLK-PRC-%d001-1.0" % lv, "ZZLK Pricing", lv, "tsc", "ZZLK",
                                                      "ZZLK Pricing at L%d." % lv))
    K = "ZZLK-PRC-001"
    M = person(db, "ZZ9LK-M", "18")
    E = person(db, "ZZ9LK-E", "15", mgr=M)
    idp = db.execute("INSERT INTO pm_idp(plan_year, subject_id, status) VALUES (2027, ?, 'shared')", (E,)).lastrowid
    sk4 = db.execute("SELECT id FROM tc_skills WHERE skill_code='ZZLK-PRC-4001-1.0'").fetchone()[0]
    db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, skill_id, required_level, have_level, gap_kind) VALUES "
               "(?, 1, 'ZZLK goal', ?, 4, 3, 'current')", (idp, sk4))
    today = a._today_myt()
    P1 = prog(db, "ZZLK Negotiation", K, 4)
    P3 = prog(db, "ZZLK Senior Pricing", K, 4, aud='{"grade_min": 20}')
    P4 = prog(db, "ZZLK Draft Course", K, 3, status="draft")
    D1, D3, D4 = (today + timedelta(days=20)), (today + timedelta(days=21)), (today + timedelta(days=22))
    S1, S3, S4 = sess(db, P1, D1.isoformat()), sess(db, P3, D3.isoformat()), sess(db, P4, D4.isoformat())
    R0 = came(db, E, sess(db, P1, (today - timedelta(days=20)).isoformat()), P1)        # to rate
    R1 = came(db, E, sess(db, P1, (today - timedelta(days=40)).isoformat()), P1)        # its 1-month check-in open
    R3 = came(db, E, sess(db, P1, (today - timedelta(days=100)).isoformat()), P1)       # its 3-month check-in open
    db.commit()
MON = D1.isoformat()[:7]


def one(sql, args=()):
    return H.one(a, sql, args)


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


SCRIPT, CALLS = [], []


def fake_turn(system, messages, timeout=25):
    CALLS.append({"system": system, "messages": [dict(m) for m in messages]})
    return SCRIPT.pop(0) if SCRIPT else {"say": "Anything else?", "quick_replies": [], "action": None}


def ask(client, msg, page="calendar"):
    del CALLS[:]
    return client.post("/learning/coach", data={"csrf_token": "tok", "page": page, "message": msg}).get_json() or {}


def tool(name, **args):
    return {"say": "", "quick_replies": [], "action": {"tool": name, "args": args}}


def chats():
    return one("SELECT COUNT(*) FROM lms_coach_chat WHERE user_id=?", (E,))


def with_u(fn):
    with a.app.test_request_context():
        db = a.get_db()
        return fn(db, dict(db.execute("SELECT * FROM users WHERE id=?", (E,)).fetchone()))


def sids(card):
    return {ev["sid"] for w in card["weeks"] for d in w for ev in d["ev"]} | {ev["sid"] for ev in card["list"]}


try:
    env("1")
    a.ai_draft.lms_coach_turn = fake_turn
    a.ai_draft.review_agent_available = lambda: True
    _PER0 = a.LMS_COACH_PER_MIN
    a.LMS_COACH_PER_MIN = 1000
    CE, CM = H.client_as(a, E), H.client_as(a, M)

    s.section("a month of the calendar, as a card")
    c = with_u(lambda db, u: a.lms_coach_month(db, u, MON))
    day = next((d for w in c["weeks"] for d in w if d["in"] and d["d"] == D1.day), None)
    s.check("the calendar's own grid: their run on its day, marked as their plan's", day and
            [(e["sid"], e["st"]) for e in day["ev"]] == [(S1, "plan")], day)
    s.check("...only runs open to them: not another grade's, nothing in draft", S1 in sids(c) and not ({S3, S4} & sids(c))
            and not ({S3, S4} & sids(with_u(lambda db, u: a.lms_coach_month(db, u, D3.isoformat()[:7])))))
    s.check("...the month's runs counted in OneHR's words, with the full calendar's address",
            c["n"] == 1 and c["n_plan"] == 1 and a._lms_month_say(c).startswith("Here's %s: one run open to you" % c["label"])
            and c["url"] == "/learning?view=calendar&m=%s" % MON, (c["n"], c["url"]))
    r = ask(CE, "Show me %s" % D1.strftime("%B"))
    s.check("'show me November' is answered in code, no model", r.get("cards") and r["cards"][0]["kind"] == "month" and
            r["cards"][0]["m"] == MON and not CALLS, (r.get("say"), len(CALLS)))
    r = ask(CE, "open the calendar")
    s.check("...'open the calendar' is this month", r.get("cards") and r["cards"][0]["m"] == today.isoformat()[:7]
            and not CALLS)
    r = ask(CE, "Show me %s courses on pricing" % D1.strftime("%B"))
    s.check("...a longer question goes to the model", len(CALLS) == 1 and not r.get("cards"), r)
    SCRIPT[:] = [tool("show_month", month=MON)]
    r = ask(CE, "what's coming up around then?")
    s.check("the model asks for a month; OneHR draws it and says what's in it", r.get("cards") and
            r["cards"][0]["kind"] == "month" and r["cards"][0]["m"] == MON and r["say"].startswith("Here's"), r.get("say"))
    n0 = chats()
    g = CE.get("/learning/coach?page=calendar&month=%s" % D3.isoformat()[:7]).get_json()
    s.check("the arrows redraw a month in place and keep nothing", g and g["card"]["kind"] == "month" and chats() == n0,
            g and g["card"]["m"])

    s.section("a programme, as a card")
    pc = with_u(lambda db, u: a.lms_coach_programme_card(db, u, P1))
    s.check("its format, days and hours, what it builds for them, the run to register for",
            pc and pc["kicker"].startswith("Programme · ") and "1 day · 7 h" in pc["chips"] and
            pc["builds"] == "Builds your goal · L4" and pc["register"] == "/learning/register?session=%d" % S1 and
            pc["register_label"] == "Register for ZZLK run" and pc["seats"] == "10 seats left", pc and pc["run"])
    p3 = with_u(lambda db, u: a.lms_coach_programme_card(db, u, P3))
    s.check("...not open to their grade: shown, nothing to register for", p3 and not p3["open_to_you"] and
            p3["register"] is None, p3 and p3["register"])
    s.check("...none for a draft", with_u(lambda db, u: a.lms_coach_programme_card(db, u, P4)) is None)
    SCRIPT[:] = [tool("programme_facts", programme_id=P1),
                 {"say": "It builds L4 in pricing, your goal.", "quick_replies": [], "action": None}]
    r = ask(CE, "tell me about ZZLK Negotiation, is it worth it?")
    s.check("after programme_facts: the model's answer, its card under it", r.get("say") == "It builds L4 in pricing, "
            "your goal." and [x["kind"] for x in r.get("cards") or []] == ["programme"] and r["cards"][0]["pid"] == P1,
            r.get("say"))
    SCRIPT[:] = [tool("programme_facts", programme_id=P1),
                 {"say": "It builds L4 in pricing.", "quick_replies": [], "action": None}]
    r = ask(CE, "is it worth it?", page="prog:%d" % P1)
    s.check("...not on the programme's own page", r.get("say") == "It builds L4 in pricing." and not r.get("cards"),
            r.get("say"))
    n0 = chats()
    del CALLS[:]
    r = CE.post("/learning/coach", data={"csrf_token": "tok", "page": "calendar", "show": "prog:%d:%d" % (P1, S1)}).get_json()
    s.check("a run tapped on the month card opens its programme in code, kept as a turn", r and r["cards"][0]["pid"] == P1
            and not CALLS and chats() == n0 + 2 and one("SELECT content FROM lms_coach_chat WHERE user_id=? AND "
                                                        "role='user' ORDER BY id DESC LIMIT 1", (E,)) ==
            "Open ZZLK Negotiation", r and r.get("say"))
    r = CE.post("/learning/coach", data={"csrf_token": "tok", "page": "calendar", "show": "prog:%d" % P4}).get_json()
    s.check("...a draft doesn't open", r and not r["cards"] and "isn't open" in r["say"], r)
    with a.app.test_request_context():
        db = a.get_db()
        ok_, _m, _rid = a.lms_register(db, a._lms_user(db, E), S1, None, "ZZLK reason")
    pc = with_u(lambda db, u: a.lms_coach_programme_card(db, u, P1, S1))
    s.check("...once they hold a place: that run as theirs, nothing to register for", ok_ and pc["mine"] and
            pc["register"] is None and pc["run"].startswith("ZZLK run · "), pc and (pc["mine"], pc["register"]))

    s.section("a card on their page")
    ask(CE, "what do I need to do?", page="mine")
    s.check("the coach is told what's on their page, by id", CALLS and ('"id": "rate-%d"' % R0) in CALLS[0]["system"]
            and '"id": "check-%d-m1"' % R1 in CALLS[0]["system"])
    SCRIPT[:] = [tool("show_card", id="rate-%d" % R0)]
    r = ask(CE, "where do I rate it?", page="mine")
    gc = (r.get("cards") or [{}])[0]
    s.check("show_card: Go to it, in its tab", gc.get("kind") == "goto" and gc["anchor"] == "rate-%d" % R0 and
            gc["url"] == "/learning?view=mine&tab=apply#rate-%d" % R0 and gc["where"] == "Apply it" and
            r["say"].startswith("It's under Apply it"), r)
    SCRIPT[:] = [tool("show_card", id="rate-999999"), {"say": "I can't find that one.", "quick_replies": [], "action": None}]
    r = ask(CE, "show me my other rating", page="mine")
    s.check("...only something on their page", not r.get("cards") and r.get("say") == "I can't find that one." and
            "nothing by that id" in CALLS[-1]["messages"][-1]["content"], r)

    s.section("the check-in opens in the shell")
    loc = CE.get("/learning/eval/%d/m1" % R1).headers.get("Location", "")
    s.check("its own address opens its card in the Apply tab", loc.endswith("/learning?tab=apply#check-%d-m1" % R1), loc)
    pg = html.unescape(CE.get("/learning?tab=apply").get_data(as_text=True))
    s.check("...where the card is, with its writer", 'id="check-%d-m1"' % R1 in pg and
            'action="/learning/eval/%d/m1"' % R1 in pg)
    r = CE.post("/learning/eval/%d/m1" % R1, data={"csrf_token": "tok", "used": "I held the walk-away price on two quotes."})
    s.check("...saving lands on the check-ins", "tab=apply" in r.headers.get("Location", "") and
            r.headers["Location"].endswith("#checkins"), r.headers.get("Location"))
    CE.post("/learning/eval/%d/m3" % R3, data={"csrf_token": "tok", "changed": "I set the dealers' price band myself now.",
                                              "example": "Checked the margin on every quote.", "level": "4"})
    loc = CE.get("/learning/eval/%d/m3" % R3).headers.get("Location", "")
    s.check("a sent 3-month check-in: its address opens Change it", loc.endswith("#change-%d" % R3), loc)
    pg = html.unescape(CE.get("/learning?tab=apply").get_data(as_text=True))
    s.check("...Change it holds the form, their level picked", 'id="change-%d"' % R3 in pg and
            'action="/learning/eval/%d/m3"' % R3 in pg and 'value="4" checked' in pg and "You picked L4" in pg)
    s.check("the rating's save lands on Apply", "tab=apply" in CE.post("/learning/rate/%d" % R0, data={"csrf_token": "tok"})
            .headers.get("Location", ""))

    s.section("the dashboard's rows go to their card")
    with a.app.test_request_context():
        db = a.get_db()
        acts = a.dash_learning(a.get_db(), a._lms_user(db, E))["acts"]
        macts = a.dash_learning(a.get_db(), a._lms_user(db, M))["acts"]
    rate = next((x for x in acts if x["title"].startswith("Rate ")), None)
    s.check("Rate it: its card in Apply", rate and rate["url"] == "/learning?view=mine&tab=apply#rate-%d" % R0, rate)
    eid = one("SELECT id FROM lms_evaluations WHERE registration_id=? AND kind='m3'", (R3,))
    conf = next((x for x in macts if x["button"] == "Confirm"), None)
    s.check("Confirm: the line manager's card for it, in Your team", conf and
            conf["url"] == "/learning?view=team&tab=team#conf-%d" % eid, conf)
    tg = html.unescape(CM.get(conf["url"] if conf else "/learning?view=team").get_data(as_text=True))
    s.check("...which is on that page", 'id="conf-%d"' % eid in tg)

    s.section("the Find tab's coach")
    g = CE.get("/learning/coach?page=calendar").get_json()
    s.check("its opening offers this month", g and g["opening"]["quick_replies"][0] == "Show me %s" % today.strftime("%B"))
    js = open(os.path.join(os.path.dirname(a.__file__), "static", "learning_coach.js")).read()
    s.check("the month, programme and Go to it cards are drawn by one builder both pages share",
            "build: buildCard" in js and all(k in js for k in ('"month"', '"programme"', '"goto"')))
finally:
    a.ai_draft.lms_coach_turn, a.ai_draft.review_agent_available = _TURN0, _AVAIL0
    a.LMS_COACH_PER_MIN = 6
    env(_ENV0)
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
