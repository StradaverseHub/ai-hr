"""The Team list as a queue, and "back to the summary" answered in code (Chris, 2026-10-16: "Go with C for the left
panel, build it and deploy to both", the "OneHR Team Review Navigator" canvas; and "when i asked to go back to summary
view, it should respawn the summary view directly").

What this suite holds:
  * _team_queue: the person on screen with Previous / Next (their neighbours in the list's order: yours, waiting,
    done); Up next = the people still yours from the one after them, round to the start, never the person the card
    shows; three shown, the rest under "+N more"; the waiting and the done as lists; in the Team summary nobody is on
    screen and the card starts with the first person still yours; a bar of one segment a person, the one on screen
    marked
  * the navigator knows who is really on screen: the caller's report, else the request's, else the default -- clamped
    to the manager's own people
  * the page: On screen with Previous / Next as ordinary nav items, Up next, "+N more", Waiting and Done that
    open, each keeping open across the panel's refresh (the client restores them by name)
  * "go back to summary view", "Show team summary", or a yes to the agent offering it: the Team summary at once, brought
    down to the reply, with no model call; a question about the summary is still the model's
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The Team list as a queue; back to the summary in code")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"


def it(i, grp):
    return {"id": str(i), "name": "Person %02d" % i, "ini": "P%d" % i, "meta": {"turn": "2 to moderate",
            "wait": "Not submitted yet", "done": "Reviewed"}[grp], "done": grp == "done", "turn": grp == "turn"}


ITEMS = [it(1, "turn"), it(2, "turn"), it(3, "turn"), it(4, "turn"), it(5, "turn"), it(6, "wait"), it(7, "done"),
         it(8, "done")]
ids = lambda xs: [x["id"] for x in xs]  # noqa: E731

# ---------------------------------------------------------------------------
s.section("the queue")
q = a._team_queue(ITEMS, "2", "detail")
s.check("on screen: the focused person, Previous and Next their neighbours",
        q["on"]["id"] == "2" and q["prev"]["id"] == "1" and q["next"]["id"] == "3", (q["on"], q["prev"], q["next"]))
s.check("...Up next: the people still yours from the one after them, round to the start, three then '+N more'",
        ids(q["up"]) == ["3", "4", "5"] and ids(q["more"]) == ["1"], (ids(q["up"]), ids(q["more"])))
s.check("...the waiting and the done as their own lists", ids(q["waiting"]) == ["6"] and ids(q["done"]) == ["7", "8"])
s.check("...a segment a person in the list's order, only the one on screen marked",
        [g["state"] for g in q["segs"]] == ["turn"] * 5 + ["wait", "done", "done"]
        and [g["here"] for g in q["segs"]].count(True) == 1 and q["segs"][1]["here"] and q["n_turn"] == 5)
s.check("...the person on screen is never under Up next", "2" not in ids(q["up"]) + ids(q["more"]))
q6 = a._team_queue(ITEMS, "6", "detail")
s.check("someone still writing on screen: Previous / Next step past them; Up next is everyone still yours",
        q6["prev"]["id"] == "5" and q6["next"]["id"] == "7" and ids(q6["up"]) == ["1", "2", "3"]
        and ids(q6["more"]) == ["4", "5"])
s.check("the first has no Previous, the last no Next",
        a._team_queue(ITEMS, "1", "detail")["prev"] is None and a._team_queue(ITEMS, "8", "detail")["next"] is None)
qs = a._team_queue(ITEMS, "2", "summary")
s.check("the Team summary: nobody on screen, no Previous / Next, the card starts with the first still yours",
        qs["on"] is None and qs["prev"] is None and qs["next"] is None and qs["start"]["id"] == "1"
        and ids(qs["up"]) == ["2", "3", "4"] and ids(qs["more"]) == ["5"] and not any(g["here"] for g in qs["segs"]))
_nt = [it(6, "wait"), it(7, "done")]
s.check("...nobody yours: the card starts with the first not done; everyone done: no start",
        a._team_queue(_nt, None, "summary")["start"]["id"] == "6"
        and a._team_queue([it(7, "done")], None, "summary")["start"] is None)
s.check("a focus that isn't in the list reads as the summary",
        a._team_queue(ITEMS, "99", "detail")["on"] is None and a._team_queue(ITEMS, "99", "detail")["start"]["id"] == "1")

# ---------------------------------------------------------------------------
s.section("who is on screen")
ROWS = [{"id": 21, "name": "Tam Gamma", "done": False, "meta": "To review", "action": "Review competencies"},
        {"id": 22, "name": "Tam Delta", "done": False, "meta": "Not submitted yet", "action": None},
        {"id": 23, "name": "Tam Eps", "done": True, "meta": "Reviewed", "action": None},
        {"id": 24, "name": "Tam Zed", "done": False, "meta": "To review", "action": "Review competencies"}]
LIVE = [{"key": "tm_review", "module": "tm", "group": "team", "label": "TM – Competency Review",
         "short": "Competency Review", "state": "open", "n_open": 2, "n_total": 4, "blocked_on": None, "endpoint": None}]
_wtr = (a._journey_team_reports, a._journey_team_live_stages)
a._journey_team_reports = lambda db, u, k: [dict(r) for r in ROWS]
a._journey_team_live_stages = lambda st, view=None: [dict(x) for x in LIVE]
_U = H.actors(a)[2]
try:
    def nav(path, **kw):
        with a.app.test_request_context(path):
            return a._journey_team_nav_items(a.get_db(), _U, "tm_review", **kw)

    def html(path, **kw):
        with a.app.test_request_context(path):
            return a._journey_nav_html(a.get_db(), _U, {"stages": [], "period": None}, "tm_review", view="team", **kw)

    n1 = nav("/?report=24&mode=detail")
    s.check("the request's report and mode: Tam Zed on screen", n1["focus"] == "24" and n1["mode"] == "detail"
            and n1["queue"]["on"]["name"] == "Tam Zed", (n1["focus"], n1["mode"]))
    n2 = nav("/?report=24&mode=detail", report=21, mode="detail")
    s.check("...the caller's report wins (a turn that moved)", n2["queue"]["on"]["name"] == "Tam Gamma")
    n3 = nav("/?report=999&mode=detail")
    s.check("...a report that isn't theirs is clamped to their own people", n3["focus"] in ("21", "22", "23", "24")
            and n3["focus"] != "999", n3["focus"])
    n4 = nav("/?report=24")
    s.check("...no mode: the Team summary, nobody on screen", n4["mode"] == "summary" and n4["queue"]["on"] is None)
    s.check("each item carries its initials", [x["ini"] for x in n1["items"]] == ["TG", "TZ", "TD", "TE"],
            [x["ini"] for x in n1["items"]])

    h = html("/?report=21&mode=detail")
    s.check("the panel: On screen, the person, Previous disabled at the start, Next to the one after",
            '<p class="rv-nq-k">On screen</p>' in h and 'title="Tam Gamma">Tam Gamma<' in h
            and re.search(r'<button type="button" class="rv-nq-step" disabled>&larr; Previous</button>', h)
            and re.search(r'class="rv-nav-item rv-nq-step is-next" data-item-id="24" data-kind="team"', h), h[:3000])
    _up = h.split('<p class="rv-nq-k">Up next</p>', 1)[-1].split("</div>", 1)[0] if "Up next" in h else ""
    s.check("...Up next lists Tam Zed, not the person on screen",
            'data-item-id="24"' in _up and 'data-item-id="21"' not in _up, _up[:600])
    s.check("...Waiting and Done open, each kept by name across a refresh",
            'details class="rv-nq-list is-wait" data-keep="wait"' in h and 'details class="rv-nq-list is-done" '
            'data-keep="done"' in h and 'rv-nq-row is-wait" data-item-id="22"' in h
            and 'rv-nq-row is-done" data-item-id="23"' in h)
    _bar = re.search(r'<span class="rv-nq-bar"[^>]*>(.*?)</span>', h, re.S)
    s.check("...the bar: one segment a person, the one on screen marked, a key in words",
            _bar and _bar.group(1).count("<i ") == 4 and _bar.group(1).count("is-here") == 1
            and "2 yours" in h and "1 waiting" in h and "1 done" in h and 'class="rv-nav is-queue"' in h)
    s.check("...every person is a nav item the client already opens (Previous / Next / rows)",
            len(re.findall(r'class="rv-nav-item rv-nq-(?:row|step|start)[^"]*" data-item-id="\d+" data-kind="team"', h))
            >= 4)
    hs = html("/?mode=summary")
    s.check("the Team summary: 'Start with' the first still yours, Up next after them",
            '<p class="rv-nq-k">Team summary</p>' in hs and "Start with Tam Gamma" in hs
            and 'class="rv-nav-item rv-nq-start" data-item-id="21"' in hs and "rv-nq-step" not in hs)
    _many = [{"id": 30 + i, "name": "Pat %d" % i, "done": False, "meta": "To review", "action": "Review"}
             for i in range(6)]
    a._journey_team_reports = lambda db, u, k: [dict(r) for r in _many]
    hm = html("/?report=30&mode=detail")
    s.check("more than three still yours: '+2 more' opens the rest, Show less at its end folds it (a fold)",
            "+2 more" in hm and 'details class="rv-nq-more fold" data-keep="more"' in hm and "data-fold-less" in hm)
finally:
    a._journey_team_reports, a._journey_team_live_stages = _wtr

_js = H.source(a, "static/journey_chat.js")
s.check("the client keeps the queue's open lists open across the panel's refresh, by name",
        'oldNav.querySelectorAll("details[data-keep][open]")' in _js
        and 'fresh.querySelectorAll("details[data-keep]")' in _js)
s.check("the moderated rating under the box shows only when it differs from theirs (Chris, 2026-10-16: 'why is there "
        "a duplicated of the 120.AE label?'); a different one shows theirs struck, then the new one",
        "if (!differs && l.report_band != null) return;" in _js
        and _js.index("if (!differs && l.report_band != null) return;") < _js.index('was.classList.add("rv-rating-was")'))
_tpl = H.source(a, "templates/_journey_nav.html")
s.check("every navigator draws its queue first; the old lists stay only as the fallback for one without",
        "{% set Q = nav.get('queue') %}" in _tpl and "{% if done and _split and not _queue %}" in _tpl
        and _tpl.index("  {% if _queue %}\n  {% set on = Q['on'] %}") < _tpl.index("{% elif nav['kind'] == 'tbox' %}"))

# ---------------------------------------------------------------------------
s.section("back to the summary, in code")
yes = ["go back to summary view", "Show team summary", "back to summary", "team summary", "show me the team summary",
       "Open the summary", "back to my team", "Go back to Team summary.", "can you show the team summary?",
       "take me back to the summary please", "switch to team view"]
no = ["summary of Person 01's KPIs", "what's in the summary?", "write a summary", "summarise my team",
      "show me Person 01", "how is my team doing?", "approve all", "show team results"]
s.check("asks for the Team summary match", not [x for x in yes if not a._TEAM_SUMMARY_RE.match(x)],
        [x for x in yes if not a._TEAM_SUMMARY_RE.match(x)])
s.check("...a question about it, or anything else, doesn't", not [x for x in no if a._TEAM_SUMMARY_RE.match(x)],
        [x for x in no if a._TEAM_SUMMARY_RE.match(x)])
_wh = a._manager_chat_history
try:
    a._manager_chat_history = lambda *x, **k: [{"role": "agent", "content": "I can bring up the team summary so you "
                                                "can see where the reviews stand. Shall I open it?"}]
    _off = a._team_summary_offered(None, None, None, None, None)
    a._manager_chat_history = lambda *x, **k: [{"role": "agent", "content": "Here's your team summary."}]
    _not = a._team_summary_offered(None, None, None, None, None)
finally:
    a._manager_chat_history = _wh
s.check("the agent offering the summary as a question is an offer a yes takes; saying it isn't", _off and not _not)

with a.app.test_request_context("/review/journey"):
    db = a.get_db()
    period = a.active_pm_period(db)
    row = db.execute("SELECT DISTINCT a.approver_id AS uid FROM pm_kpi_target_approvers a JOIN pm_kpi_targets t "
                     "ON t.id=a.kpi_target_id JOIN users u ON u.id=a.approver_id WHERE t.cycle_id=? AND u.role!='admin' "
                     "AND u.left_at IS NULL LIMIT 1", (period["id"],)).fetchone() if period else None
    CID = a.active_cycle_id(db)
    _uni = db.execute("SELECT value FROM app_settings WHERE key='review_unified'").fetchone()
    _rev = db.execute("SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (CID,)).fetchone()
MGR = row["uid"] if row else None
if MGR:
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('review_unified','1')")
        db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (CID,))
        _n0 = db.execute("SELECT COUNT(*) FROM pm_manager_chat WHERE reviewer_id=?", (MGR,)).fetchone()[0]
        db.commit()
    CALLS = []
    _av, _ag = a.ai_draft.review_agent_available, a.ai_draft.review_agent
    a.ai_draft.review_agent_available = lambda: True
    a.ai_draft.review_agent = lambda *x, **k: (CALLS.append(1), {"say": "I can bring up the team summary so you can "
                                               "see where the reviews stand. Shall I open it?", "quick_replies": [],
                                               "action": None})[1]
    try:
        C = H.client_as(a, MGR)
        base = {"csrf_token": "tok", "journey": "1", "view": "team", "stage": "pm_review"}
        with a.app.test_request_context("/"):
            from flask import session as _ss
            _ss["user_id"] = MGR
            _mu = a.get_db().execute("SELECT * FROM users WHERE id=?", (MGR,)).fetchone()
            REP = a._journey_active_report(a.get_db(), _mu, "pm_review", None)
        j = C.post("/review/chat", data=dict(base, message="go back to summary view", mode="detail",
                                             report=str(REP))).get_json() or {}
        s.check("'go back to summary view' in a person's view: the Team summary at once",
                j.get("mode") == "summary" and "rows" in (((j.get("overview") or {}).get("data")) or {})
                and {"type": "stage_focus", "stage": "pm_review"} in (j.get("renders") or [])
                and (j.get("say") or "").startswith("Here's your team summary."), (j.get("mode"), j.get("renders"),
                                                                                    j.get("say")))
        s.check("...with no model call, and the panel drawn for the summary", not CALLS
                and '<p class="rv-nq-k">Team summary</p>' in (j.get("nav_html") or ""),
                (len(CALLS), (j.get("nav_html") or "")[:300]))
        j2 = C.post("/review/chat", data=dict(base, message="what does moderating mean?", mode="detail",
                                              report=str(REP))).get_json() or {}
        s.check("a question goes to the model (here it offers the summary)", len(CALLS) == 1
                and j2.get("mode") == "detail", (len(CALLS), j2.get("mode")))
        # the offer as the conversation's last word (a locked person's turn has the server's own reply in its place,
        # whose "Go to" chip a yes rightly takes -- so the offer is set down here, not left to the model's turn)
        with a.app.app_context():
            _dbo = a.get_db()
            _dbo.execute("INSERT INTO pm_manager_chat(reviewer_id, cycle_id, report_id, stage, role, content) VALUES "
                         "(?,?,?,?,'agent',?)", (MGR, a.active_cycle_id(_dbo), REP, "pm_review",
                                                 "I can bring up the team summary so you can see where the reviews "
                                                 "stand. Shall I open it?"))
            _dbo.commit()
        j3 = C.post("/review/chat", data=dict(base, message="yes", mode="detail", report=str(REP))).get_json() or {}
        s.check("...and a yes to that offer takes it, in code", len(CALLS) == 1 and j3.get("mode") == "summary"
                and {"type": "stage_focus", "stage": "pm_review"} in (j3.get("renders") or []),
                (len(CALLS), j3.get("mode"), j3.get("say")))
        with a.app.app_context():
            _saved = a.get_db().execute("SELECT content FROM pm_manager_chat WHERE reviewer_id=? ORDER BY id DESC "
                                        "LIMIT 1", (MGR,)).fetchone()
        s.check("...the reply is kept in the conversation", _saved and _saved[0].startswith("Here's your team summary."))
    finally:
        a.ai_draft.review_agent_available, a.ai_draft.review_agent = _av, _ag
        with a.app.app_context():
            db = a.get_db()
            db.execute("DELETE FROM pm_manager_chat WHERE reviewer_id=? AND id > (SELECT COALESCE(MAX(id), 0) FROM "
                       "(SELECT id FROM pm_manager_chat WHERE reviewer_id=? ORDER BY id LIMIT ?))", (MGR, MGR, _n0))
            if _uni is None:
                db.execute("DELETE FROM app_settings WHERE key='review_unified'")
            else:
                db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('review_unified',?)", (_uni[0],))
            if _rev is not None:
                db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'review', ?)",
                           (CID, _rev[0]))
            db.commit()
else:
    s.check("there is a manager with KPI lines on the suite database", False)

sys.exit(s.done())
