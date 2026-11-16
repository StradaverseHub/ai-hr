"""AI+ Learning in what the agents and the first sign-in know (2026-10-23; OneHR's rule: "Every new feature or module
updates what the agents and the first sign-in know").

What this suite holds:
  * Get Help on Learning's pages: its own quick answers by view (Mine by the open tab, Team, Their learning, Dept, the
    calendar, a programme, the clock-in pages); "why can't I approve" only for a leader with something switched off;
    Learning off, the pages fall back to OneHR's list
  * Ask OneHR's ways into Learning, answered in code: a leader's team or department, nominating, the calendar, the
    check-ins, registering; the dashboard's Learning panel otherwise; none of it where Learning is off
  * the KB: three conceptual rows, found by both agents' searches only where Learning is on
  * the first sign-in tour stops at the dashboard's Learning card, which only Learning draws
Everything here is synthetic (ZZLG / ZZ9LG-) and removed at the end.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning in Help, Ask OneHR, the KB and the tour")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG = "ZZLG Group"
_ENV0 = os.environ.get("ONEHR_LMS")
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LG-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.commit()


def person(db, eid, mgr=None, hod=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, hod_id, confirmation_date) VALUES "
                      "(?,?, 'x', 'user', ?,?, 'ZZLG U1', 'ZZLG Sales', 'ZZLG Officer', '15', ?, ?, '2020-01-01')",
                      (eid.lower(), "ZZ LG " + eid.split("-")[1], eid, BG, mgr, hod)).lastrowid


with a.app.app_context():
    db = a.get_db()
    _cleanup(db)
    SAVED = [tuple(r) for r in db.execute("SELECT role, ability, allowed FROM leader_role_access")]
    db.execute("DELETE FROM leader_role_access")
    HOD = person(db, "ZZ9LG-HOD")
    M = person(db, "ZZ9LG-M", hod=HOD)
    E = person(db, "ZZ9LG-E", M, HOD)
    db.commit()


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


def u_(uid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def help_(uid, ep, view="", stage=""):
    with a.app.test_request_context():
        r = a.help_answers(a.get_db(), u_(uid), ep, view, stage)
    return r["label"], [i["key"] for i in r["items"]], r.get("where")


def ask(msg, ctx):
    with a.app.test_request_context():
        return a._ask_intent(msg, ctx)


def off(keys):
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM leader_role_access")
        d.executemany("INSERT INTO leader_role_access(role, ability, allowed) VALUES (?,?,0)",
                      [(k.split(".")[0], k) for k in keys])
        d.commit()


LM_CTX = {"learn": {"card": {"tabs": [{"key": "team"}, {"key": "mine"}]}}, "tool_cards": [{"key": "learning"}]}
HOD_CTX = {"learn": {"card": {"tabs": [{"key": "dept"}, {"key": "mine"}]}}, "tool_cards": [{"key": "learning"}]}
EMP_CTX = {"learn": {"card": {"tabs": [], "single": {}}}, "tool_cards": [{"key": "learning"}]}

try:
    s.section("Get Help on Learning's pages")
    env("1")
    lab, keys, where = help_(E, "learning_home", "mine", "find")
    s.check("Mine, Find and register: Learning's own list, signing up first", lab == "AI+ Learning"
            and keys[0] == "learn_find" and where == "AI+ Learning · Mine", (lab, keys))
    s.check("Mine, Apply it: the check-ins first", help_(E, "learning_home", "mine", "apply")[1][0] == "learn_checkin")
    lab, keys, where = help_(M, "learning_home", "team", "team")
    s.check("Team: the line manager's answers, approving first", keys[0] == "lt_approve" and "lt_confirm" in keys
            and where == "AI+ Learning · Team", keys)
    s.check("...\"why can't I\" only once something is switched off for their seat", "lt_off" not in keys)
    off(["lm.learn_approve"])
    s.check("...and then it is", "lt_off" in help_(M, "learning_home", "team", "team")[1])
    off([])
    s.check("Their learning: nominating first", help_(M, "learning_home", "team", "plans")[1][0] == "lt_nominate")
    s.check("Dept: the HOD's, the rounds first", help_(HOD, "learning_home", "dept", "dept")[1][0] == "ld_round")
    lab, keys, where = help_(E, "learning_home")
    s.check("the calendar (no view sent): what's open to them first", keys[0] == "learn_open"
            and where == "AI+ Learning · Calendar", keys)
    s.check("a programme's page: what the coach can do first", help_(E, "learning_programme")[1][0] == "learn_coach")
    s.check("the clock-in page after a scan: clocking first", help_(E, "learning_checkin")[1][0] == "learn_clock")
    every = [k for key in ("learn_mine", "learn_apply", "learn_team", "learn_plans", "learn_dept", "learn_cal",
                           "learn_prog") for k in a.HELP_LISTS[key][1]]
    s.check("every Learning answer is written, at most five a list", all(k in a.HELP_QA for k in every) and all(
        len(a.HELP_LISTS[k][1]) <= a.HELP_LIST_MAX for k in ("learn_mine", "learn_team", "learn_dept")))
    r = H.client_as(a, M).get("/help/answers?ep=learning_home&view=team&stage=team").get_json()
    s.check("...and that's what the Help panel loads", r and r["label"] == "AI+ Learning"
            and r["items"][0]["key"] == "lt_approve", r and r.get("label"))
    env(None)
    s.check("Learning off: its pages fall back to OneHR's list", help_(E, "learning_home", "mine", "find")[0] == "OneHR")
    env("1")

    s.section("Ask OneHR's ways into Learning")
    h = ask("Open my team's learning", LM_CTX)
    s.check("a line manager: their team's learning, under Team", h and h["cards"][0]["href"] ==
            "/learning?view=team&tab=team" and "Team" in h["say"], h)
    h = ask("approve my team's training", LM_CTX)
    s.check("...approving goes there too", h and h["cards"][0]["href"] == "/learning?view=team&tab=team", h)
    h = ask("nominate someone for training", LM_CTX)
    s.check("...nominating: Their learning's form", h and h["cards"][0]["href"] ==
            "/learning?view=team&tab=plans#nominate", h)
    h = ask("open my department's training", HOD_CTX)
    s.check("an HOD: Dept", h and h["cards"][0]["href"] == "/learning?view=dept&tab=dept", h)
    h = ask("approve training", EMP_CTX)
    s.check("someone who leads no one: never a team or department page", not h or all(
        "view=team" not in (c.get("href") or "") and "view=dept" not in (c.get("href") or "") for c in h["cards"]), h)
    h = ask("training calendar", EMP_CTX)
    s.check("the calendar", h and h["cards"][0]["href"] == "/learning?view=calendar", h)
    h = ask("where are my learning check-ins", EMP_CTX)
    s.check("the check-ins: Apply it", h and h["cards"][0]["href"] == "/learning?tab=apply", h)
    h = ask("register for a course", EMP_CTX)
    s.check("registering: Find and register", h and h["cards"][0]["href"] == "/learning?tab=find", h)
    h = ask("open my learning", EMP_CTX)
    s.check("otherwise the dashboard's Learning panel, and AI+ Learning beside it", h and h["cards"][0]["panel"] ==
            "learning" and h["cards"][1]["href"] == "/learning" and h["mark"] == "learning", h)
    h = ask("how do I nominate someone for training", LM_CTX)
    s.check("...asked how, not where: the model answers, with the KB", h is None, h)
    h = ask("when does my 360 report come out", EMP_CTX)
    s.check("a question that isn't a way somewhere is still the model's", h is None, h)
    env(None)
    h = ask("training calendar", EMP_CTX)
    s.check("Learning off: none of it", not h or "learning" not in str(h).lower(), h)
    env("1")

    s.section("the KB")
    with a.app.app_context():
        db = a.get_db()
        rows = {r["slug"]: r for r in db.execute("SELECT slug, title, body FROM kb_entries WHERE slug IN (?,?,?)",
                                                 a._KB_LMS_SLUGS)}
        s.check("three Learning rows, seeded", set(rows) == set(a._KB_LMS_SLUGS))
        s.check("...conceptual: no figures, ids or tool names, and never a rating",
                all(not re.search(r"\d|_|tool", r["body"]) for r in rows.values())
                and all("never" in r["body"] for r in rows.values()))
        s.check("...and never 'reopen'", not any(re.search(r"reopen", r["body"], re.I) for r in rows.values()))
        g_on = [x["title"] for x in a._ask_guide(db, "how do I register for training")]
        kb_on = [x["title"] for x in a._journey_tool_search_kb(db, {"query": "nominate training round hod"})["guidance"]]
        env(None)
        g_off = [x["title"] for x in a._ask_guide(db, "how do I register for training")]
        kb_off = [x["title"] for x in a._journey_tool_search_kb(db, {"query": "nominate training round hod"})["guidance"]]
        env("1")
    titles = {r["title"] for r in rows.values()}
    s.check("Ask OneHR's guide finds them where Learning is on", rows["ai-learning"]["title"] in g_on, g_on)
    s.check("...the AI+ check-in agent's search too", rows["learning-for-leaders"]["title"] in kb_on, kb_on)
    s.check("Learning off: neither ever reads them", not (titles & set(g_off)) and not (titles & set(kb_off)),
            (g_off, kb_off))

    s.section("the first sign-in tour")
    js = open(os.path.join(ROOT, "static", "onboarding.js"), encoding="utf-8").read()
    i_l, i_h = js.find('sel: [".od-learn"]'), js.find('sel: [".od-hist", ".od-tools"]')
    s.check("it stops at the Learning card, before history and tools", 0 < i_l < i_h)
    dash = open(os.path.join(ROOT, "templates", "dashboard.html"), encoding="utf-8").read()
    s.check("...which only Learning draws (a stop with nothing on the page is skipped)",
            'class="od-card od-learn' in dash and "stops.length" in js and ".filter(function (s) { return s.nodes.length; })"
            in js)
    sh = open(os.path.join(ROOT, "static", "learning_shell.js"), encoding="utf-8").read()
    s.check("the shell tells Get Help its view and open tab", "window.ohHelpCtx = function () {" in sh and
            'return { view: view || "mine", stage: on ? on.getAttribute("data-tab") : "" };' in sh)
finally:
    env(_ENV0)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM leader_role_access")
        db.executemany("INSERT INTO leader_role_access(role, ability, allowed) VALUES (?,?,?)", SAVED)
        db.commit()
        _cleanup(db)

sys.exit(s.done())
