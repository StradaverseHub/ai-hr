"""The Executive Chairman's "Your leaders" tab is greyed until the BG CEO's Talent Box opens (Chris, 2026-11-04: "the same greyed /
disabled treatment as the other leader tabs, not hidden"). Dark behind ONEHR_CHAIR=1.

One rule: his tab (view chairlead) follows the tb_bgceo window cell like the BG and Group tabs (_VIEW_OPEN_CELLS), so the tab shows,
greyed, with "Opens <date>" on hover. Once that window has opened -- or closed -- the box behaves exactly as it always did. His
Group view (chairgrp) and Mine are never greyed.

What this suite holds, with tb_bgceo ahead of now:
  * the tab is LISTED (not hidden) and greyed: a span, aria-disabled, "Opens <date>" as its title; Group is still a live link
  * ?view=chairlead serves nothing of his box: no name, no band, no count; the history fetch for it carries no box
  * every write is REFUSED with the one sentence and writes nothing: move / place, lock, record (no chair_calls / chair_locks row,
    no audit line), and every reader that would show his leaders (the box state, the card's data, the navigator, the AI insight's
    scope, the dashboard step, Ask OneHR's answer, Help's list) says the sentence or the greyed treatment, never a count, a name
    or a link into a usable box
  * the super admin's own page on his box is unaffected
and once the window has opened, or closed: the same calls work. Every guard is FALSIFIED: with the helper forced to "open" the
refused calls are accepted, so the checks see the guard.

Synthetic ZZ9CG people only; a fresh_db suite, so Suite.done() puts the scratch copy back (the windows it sets are also put back)."""
import json
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Executive Chairman: his Your leaders tab is greyed until the BG CEO Talent Box opens")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
os.environ.pop("ONEHR_CHAIR", None)
SU, _BGA0, _E = H.actors(a)


def run(fn, path="/"):
    with a.app.test_request_context(path):
        return fn(a.get_db())


def sql(q, args=()):
    def f(d):
        d.execute(q, args)
        d.commit()
    run(f)


def put(key, val):
    if val is None:
        sql("DELETE FROM app_settings WHERE key=?", (key,))
    else:
        sql("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (key, str(val)))


BG1, BG2 = "ZZ9CG BG ONE", "ZZ9CG BG TWO"
CA, CC = "ZZ9CG ONE A", "ZZ9CG TWO C"
ids = {}
with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    ORIG_WINDOWS = [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=? AND cell='tb_bgceo'", (CID,))]
    db.execute("UPDATE cycles SET half=2, kind='year_end', no_potential=NULL, min_job_grade=NULL, open_by_date=0 WHERE id=?", (CID,))
    for mk_ in ("pm", "tm", "idp", "calibration", "evidence", "review"):
        db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, mk_))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base if c != "id"]

    def mk(tag, bg, co, mgr=None, **kw):
        eid = "ZZ9CG-" + tag
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ CG " + tag, display_name=None, email=None,
                 hod_id=None, manager_id=ids.get(mgr), buceo_bg=None, buceo_company=None, bgceo_bg=None,
                 confirmation_date="2020-01-01", left_at=None, role="user", is_demo=0, user_role_id=None, job_grade="22",
                 business_group=bg, company=co, department="ZZ Dept " + tag[:1], job_title="CHIEF " + tag, years_of_service=9)
        v.update(kw)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v.get(c) for c in cols])
        ids[tag] = db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    mk("CH", BG1, CA)                                  # the Executive Chairman
    mk("BC1", BG1, CA, "CH", bgceo_bg=BG1)             # his two BG CEOs: in his box, not placed (No KPI / No 360)
    mk("BC2", BG2, CC, "CH", bgceo_bg=BG2)
    mk("STF", BG1, CA, "BC1")
    db.commit()
CH, BC1, BC2, STF = (ids[k] for k in ("CH", "BC1", "BC2", "STF"))
CHC, SUP = (H.client_as(a, x) for x in (CH, SU["id"]))
MOVE, LOCK, RECORD = ("/review/chair/leaders/" + x for x in ("move", "lock", "record"))
HIST = "/review/chat/history?journey=1&view=chairlead&stage=chair_leaders&mode=summary"
NAMES = ["ZZ CG BC1", "ZZ CG BC2", "ZZ9CG-BC1", "ZZ9CG-BC2"]
NOW = run(lambda d: a._now_myt())
_real_window, _real_open = a.window_closed, a.cycle_is_open
a.window_closed = lambda *x, **k: None      # the writers' own window gates are not what this suite is about
a.cycle_is_open = lambda *x, **k: True


def stamp(dt):
    return dt.strftime("%Y-%m-%d %H:%M")


def setwin(opens, closes):
    sql("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, "tb_bgceo", opens, closes))


def user(uid):
    return run(lambda d: d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def off(view="chairlead", uid=None):
    return run(lambda d: a._view_not_open(d, user(uid or CH), view))


def not_open():
    return run(lambda d: a._chairlead_not_open(d, user(CH)))


def j(r):
    return json.loads(r.get_data(as_text=True))


def n_rows(tbl):
    return H.one(a, "SELECT COUNT(*) FROM %s WHERE cycle_id=?" % tbl, (CID,))


def n_log():
    return H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action IN ('chair_move','chair_lock')")


def move(tag, perf="", pot="", why=""):
    return CHC.post(MOVE, data={"csrf_token": "tok", "subject_id": str(ids[tag]), "performance_band": perf,
                                "potential_band": pot, "justification": why})


def ask(msg):
    r = CHC.post("/ask", data={"csrf_token": "tok", "message": msg})
    return r.status_code, (r.get_json() or {})


def tab_row():
    return CHC.get("/review/journey").get_data(as_text=True)


def has_names(text):
    return any(n in text for n in NAMES)


try:
    put("exec_chair_id", CH)
    put("exec_chair_delegate_id", None)
    put("exec_chair_team", None)
    os.environ["ONEHR_CHAIR"] = "1"
    real_avail, real_agent = a.ai_draft.review_agent_available, a.ai_draft.review_agent
    a.ai_draft.review_agent = lambda *x, **k: {"say": "Hello.", "quick_replies": []}
    a.ai_draft.review_agent_available = lambda: True
    opens_dt = NOW + timedelta(days=5)
    DISP = a._when_disp(stamp(opens_dt))
    SENTENCE = "Your leaders' Talent Box opens on %s." % DISP
    HOVER = "Opens " + DISP

    # ------------------------------------------------------------------------------------------------ before it opens
    s.section("tb_bgceo ahead of now: the tab is listed, greyed, with the date; nothing of his box is served")
    setwin(stamp(opens_dt), stamp(NOW + timedelta(days=30)))
    s.check("the tab is LISTED for him (greyed, not hidden)", a.CHAIRL_VIEW in run(lambda d: a._journey_leader_views(d, user(CH))))
    s.check("its hover text is 'Opens <date>' (the same helper as the BG and Group tabs)", off() == HOVER, off())
    s.check("his Group view and Mine are never greyed", off("chairgrp") is None and off("mine") is None, (off("chairgrp"), off("mine")))
    s.check("the sentence for a refused door names the date as the app writes it", not_open() == SENTENCE, not_open())
    row = tab_row()
    s.check("the tab row: Leaders is a span, aria-disabled, the date in its title, no link into ?view=chairlead",
            re.search(r'rv-vt-off"[^>]*aria-disabled="true"[^>]*title="%s"[^>]*>Leaders</span>' % re.escape(HOVER), row)
            and "view=chairlead" not in row, re.findall(r"rv-vt-off[^<]*<", row)[:3])
    s.check("...while his Group tab is still a live link", 'href="/review/journey?view=chairgrp"' in row.replace("&amp;", "&"))
    lands = run(lambda d: a._journey_req_view(d, user(CH)), "/review/journey?view=chairlead")
    s.check("?view=chairlead is a view he does not hold yet: it lands on another view, never his box", lands != a.CHAIRL_VIEW, lands)
    S_raw = run(lambda d: a._chairlead_state_raw(d, user(CH)))
    s.check("(the fixture) the box has leaders in it: it is the greying that holds them back", S_raw and len(S_raw["people"]) >= 2)
    s.check("his box state is None (no reader gets a person, a band or a count)", run(lambda d: a._chairlead_state(d, user(CH))) is None)
    s.check("the card's data, the navigator and the stage's scope are all empty", run(lambda d: a._chairlead_payload(d, user(CH))) is None
            and run(lambda d: a._chairlead_nav_items(d, user(CH)))["items"] == []
            and run(lambda d: a._journey_talent_box_scope(d, user(CH), tier="chair")) is None
            and run(lambda d: a._journey_talent_box_scope(d, user(CH), tier="chair", exists=True)) is None)
    r = CHC.get(HIST)
    body = r.get_data(as_text=True)
    ov = (j(r).get("overview") or {}) if r.status_code == 200 and body.lstrip().startswith("{") else {}
    s.check("the history fetch for his view carries no box: no data, no name", not has_names(body) and not (ov.get("data") or {}).get("chairlead"),
            (r.status_code, body[:120]))

    s.section("every write is refused with the sentence and writes nothing")
    r = move("BC1", "AE", "Mid")
    s.check("move / place: refused (400) with the sentence", r.status_code == 400 and j(r)["error"] == SENTENCE, (r.status_code, r.get_data(as_text=True)[:80]))
    r = move("BC2", "AE", "Mid", why="a remark")
    s.check("...with a remark too, and for the second leader", r.status_code == 400 and j(r)["error"] == SENTENCE)
    r = CHC.post(LOCK, data={"csrf_token": "tok"})
    s.check("lock: refused (400) with the sentence", r.status_code == 400 and j(r)["error"] == SENTENCE, r.status_code)
    r = CHC.post(RECORD, data={"csrf_token": "tok", "person": str(BC1)})
    s.check("record: refused (400) with the sentence, no years", r.status_code == 400 and j(r)["error"] == SENTENCE
            and "years" not in j(r), r.status_code)
    s.check("nothing was written: no chair_calls, no chair_locks, no audit line", n_rows("chair_calls") == 0 and n_rows("chair_locks") == 0
            and n_log() == 0)
    r = CHC.post(RECORD, data={"csrf_token": "tok", "person": str(STF)})
    s.check("(a crafted person is still refused: the same sentence first, nothing about who is in the box)",
            r.status_code == 400 and j(r)["error"] == SENTENCE)

    s.section("every reader: the dashboard step, Ask OneHR, Help, the first sign-in's words")
    step = run(lambda d: a._chair_leaders_step(d, user(CH)))
    s.check("the dashboard step: no link, 'Opens <date>', state later, no head-count", step["url"] is None and step["state"] == "later"
            and step["line"].startswith("Opens ") and "placed" not in step["line"] and step.get("not_open") == SENTENCE, step)
    dash = run(lambda d: a._chair_dash(d, user(CH)))
    s.check("his dashboard data carries that step, no link", dash["steps"][1]["url"] is None and dash["steps"][1]["state"] == "later")
    dh = CHC.get("/dashboard").get_data(as_text=True)
    s.check("the dashboard page: the step shows the opening line, with no link into view=chairlead and no 'n of m placed'",
            "view=chairlead" not in dh and "chair_leaders" not in dh and not re.search(r"\d+ of \d+ placed", dh)
            and re.search(r'data-chair-step="leaders".*?Opens ', dh, re.S) is not None,
            ("view=chairlead" in dh, "chair_leaders" in dh, re.findall(r"\d+ of \d+ placed", dh), [dh[m.start() - 80:m.end() + 40] for m in re.finditer("chair_leaders|view=chairlead", dh)][:2]))
    code, ja = ask("Take me to my leaders' Talent Box")
    s.check("Ask OneHR: the sentence and that it opens with the BG CEO Talent Box, no card, no link, no model",
            code == 200 and SENTENCE in ja.get("say", "") and "BG CEO Talent Box" in ja.get("say", "")
            and "chairlead" not in json.dumps(ja) and not has_names(json.dumps(ja)), (code, ja.get("say")))
    sugg = run(lambda d: a._ask_facts(d, user(CH), dict(a._dash_context(d, user(CH)), chair=a._chair_dash(d, user(CH)))))
    s.check("Ask's facts give no link into his leaders' box while it is greyed", "view=chairlead" not in json.dumps(sugg))
    hl = run(lambda d: a.help_answers(d, user(CH), "review_journey", "chairlead", "chair_leaders"))
    s.check("Help: the greyed tab is not a view he is on: not the leaders' list", "leaders' Talent Box" not in hl["label"], hl["label"])
    seat = a.HELP_QA["seat_chair_lead"][1]
    s.check("Help's seat answer for the Leaders tab says it is greyed until the BG CEO Talent Box opens",
            "greyed" in seat and "BG CEO Talent Box" in seat, seat)
    ONB = open(os.path.join(H.REPO, "static", "onboarding.js"), encoding="utf-8").read()
    s.check("the words: the KB body, the tour and the agent's brief say it opens with the BG CEO Talent Box, never from the start "
            "of the Year-End", "open from the start of the Year-End" not in a._KB_CHAIR_LEADERS_BODY
            and "greyed" in a._KB_CHAIR_LEADERS_BODY and "BG CEO Talent Box" in ONB and "opens with the BG CEO Talent Box" in a._CHAIR_MINE_BRIEF)
    kb = H.one(a, "SELECT body FROM kb_entries WHERE slug='chairman-leaders-talent-box'")
    s.check("the KB row says it stays greyed until the BG CEO Talent Box opens (the guarded UPDATE ran)",
            kb and "greyed" in kb and "open from the start of the Year-End" not in kb, (kb or "")[-200:])

    s.section("the super admin's own page on his box is unaffected")
    pg = run(lambda d: a._chair_box_page(d, CH))
    s.check("the admin card still counts who is in his box (the raw state, not the greyed one)", pg["n_now"] == len(S_raw["people"]), pg["n_now"])
    r = SUP.get("/admin/leaders/chair")
    s.check("...and the page opens for the super admin", r.status_code == 200)

    # ------------------------------------------------------------------------------------------------ falsified
    s.section("falsified: with the guard forced to 'open' the same calls are accepted")
    real_no = a._chairlead_not_open
    try:
        a._chairlead_not_open = lambda db_, u_: None
        a._req_cache().clear()
        r = move("BC1", "AE", "Mid")
        s.check("move goes through without the guard (so the refusal above is the guard's)", r.status_code == 200 and j(r)["ok"], r.status_code)
        s.check("...and it wrote a chair_calls row", n_rows("chair_calls") > 0)
        s.check("...and his box state is there without it", run(lambda d: a._chairlead_state(d, user(CH))) is not None)
    finally:
        a._chairlead_not_open = real_no
    sql("DELETE FROM chair_calls WHERE cycle_id=?", (CID,))
    sql("DELETE FROM activity_log WHERE action='chair_move'")
    s.check("...put back: refused again, nothing written", move("BC1", "AE", "Mid").status_code == 400 and n_rows("chair_calls") == 0)
    a._view_open_raw_real = a._view_open_raw
    try:
        a._view_open_raw = lambda db_, u_, v_: None if v_ == a.CHAIRL_VIEW else a._view_open_raw_real(db_, u_, v_)
        a._req_cache().clear()
        s.check("falsified: with the tab rule saying 'usable' the tab is a live link again", off() is None
                and "view=chairlead" in tab_row())
    finally:
        a._view_open_raw = a._view_open_raw_real

    # ------------------------------------------------------------------------------------------------ open
    s.section("once the window has opened the box behaves exactly as today")
    setwin(stamp(NOW - timedelta(days=1)), stamp(NOW + timedelta(days=10)))
    s.check("the tab is usable and the sentence is gone", off() is None and not_open() is None and off("chairgrp") is None)
    row = tab_row()
    s.check("the tab row: Leaders is a live link, no greyed span for it", 'view=chairlead' in row and not re.search(
        r'rv-vt-off[^>]*>Leaders</span>', row))
    s.check("?view=chairlead is his box", run(lambda d: a._journey_req_view(d, user(CH)), "/review/journey?view=chairlead") == a.CHAIRL_VIEW)
    S = run(lambda d: a._chairlead_state(d, user(CH)))
    s.check("his box state is there, with both leaders", S is not None and {BC1, BC2} <= set(S["by_id"]))
    pay = j(CHC.get(HIST))["overview"]["data"]
    s.check("the history fetch carries his box", pay and pay["chairlead"] and pay["n_all"] >= 2, pay and pay.get("count_text"))
    step = run(lambda d: a._chair_leaders_step(d, user(CH)))
    s.check("the dashboard step is a link with the count again", step["url"] and "view=chairlead" in step["url"]
            and re.search(r"\d+ of \d+ placed", step["line"]) and step["state"] == "turn", step)
    s.check("the dashboard page links to it again", "view=chairlead" in CHC.get("/dashboard").get_data(as_text=True).replace("&amp;", "&"))
    code, ja = ask("Take me to my leaders' Talent Box")
    s.check("Ask OneHR gives the way in again", code == 200 and any("chairlead" in (c_.get("href") or "") for c_ in ja.get("cards") or []),
            (code, ja.get("say")))
    s.check("Help's seat list for his tab is his again", "leaders' Talent Box" in run(
        lambda d: a.help_answers(d, user(CH), "review_journey", "chairlead", "chair_leaders"))["label"])
    r = move("BC1", "AE", "Mid")
    s.check("move / place works", r.status_code == 200 and j(r)["ok"] and n_rows("chair_calls") == 2, (r.status_code, r.get_data(as_text=True)[:80]))
    r = CHC.post(RECORD, data={"csrf_token": "tok", "person": str(BC1)})
    s.check("record works", r.status_code == 200 and j(r)["ok"], r.status_code)
    r = CHC.post(LOCK, data={"csrf_token": "tok"})
    s.check("the lock is refused for the usual reason (a leader not placed), not the greying", r.status_code == 400
            and "not placed yet" in j(r)["error"] and "opens on" not in j(r)["error"], j(r))
    s.check("...place the second, then lock: final", move("BC2", "AE", "Mid").status_code == 200
            and CHC.post(LOCK, data={"csrf_token": "tok"}).status_code == 200 and n_rows("chair_locks") == 4)
    sql("DELETE FROM chair_locks WHERE cycle_id=?", (CID,))
    sql("DELETE FROM chair_calls WHERE cycle_id=?", (CID,))
    sql("DELETE FROM activity_log WHERE action IN ('chair_move','chair_lock')")

    # ------------------------------------------------------------------------------------------------ closed
    s.section("after the window has closed the box stays as it was: usable")
    setwin(stamp(NOW - timedelta(days=10)), stamp(NOW - timedelta(days=1)))
    s.check("closed: tab usable, no sentence, his box state is there", off() is None and not_open() is None
            and run(lambda d: a._chairlead_state(d, user(CH))) is not None)
    s.check("closed: a move still goes through (his box runs on until results are released)", move("BC1", "AE", "Mid").status_code == 200)
    sql("DELETE FROM chair_calls WHERE cycle_id=?", (CID,))
    sql("DELETE FROM activity_log WHERE action='chair_move'")

    # ------------------------------------------------------------------------------------------------ no date / module off / not Year-End
    s.section("no date on a by-date cycle, the module off, and outside a Year-End")
    sql("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='tb_bgceo'", (CID,))
    sql("UPDATE cycles SET open_by_date=1 WHERE id=?", (CID,))
    s.check("a by-date cycle with no date: 'Not open yet' on the tab, and the sentence has no date", off() == "Not open yet"
            and not_open() == "Your leaders' Talent Box isn't open yet.", (off(), not_open()))
    s.check("...every write says it too", move("BC1", "AE", "Mid").status_code == 400 and n_rows("chair_calls") == 0)
    sql("UPDATE cycles SET open_by_date=0 WHERE id=?", (CID,))
    s.check("no window rows on a cycle that opens all cycle: usable", off() is None and not_open() is None)
    setwin(stamp(opens_dt), stamp(NOW + timedelta(days=30)))
    sql("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,0)", (CID, "calibration"))
    s.check("the Talent Box's module off for the cycle: the cell is ignored, the tab usable", off() is None and not_open() is None, off())
    sql("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, "calibration"))
    s.check("...on again: greyed", off() == HOVER)
    sql("UPDATE cycles SET half=1, kind='mid_year' WHERE id=?", (CID,))
    s.check("outside a Year-End there is no box to grey: no sentence (the box's own 'runs at Year-End')", not_open() is None
            and a.CHAIRL_VIEW not in run(lambda d: a._journey_leader_views(d, user(CH))))
    sql("UPDATE cycles SET half=2, kind='year_end' WHERE id=?", (CID,))
finally:
    a.window_closed, a.cycle_is_open = _real_window, _real_open
    sql("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='tb_bgceo'", (CID,))
    for w in ORIG_WINDOWS:
        sql("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
            (CID, w["cell"], w["opens_at"], w["closes_at"]))
    a.ai_draft.review_agent_available, a.ai_draft.review_agent = real_avail, real_agent
    os.environ.pop("ONEHR_CHAIR", None)

sys.exit(s.done())
