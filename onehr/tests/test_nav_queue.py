"""The queue panel in every view (Chris, 2026-10-16: "build it and deploy to both", the "OneHR Queue Panel, Every View"
canvas; the Team list's queue is test_team_queue).

What this suite holds:
  * Mine: the KPI check-in and the Career Plan show the NEXT step with a Go to it, then the rest; done lines, HR's
    lines and what opens later fold away. The 360 and the competency show the colleague / category ON SCREEN with
    Previous / Next; the competency's remark and Save & submit come after every category, never paged
  * Dept: person by person, the reviewed folded away, a line on the submit
  * BU: the departments are the queue (each with whether its HOD's review is in), Show everyone, Find a person, who
    they moved, the lock line
  * BG: business units, the locked folded away; Group: the named batches, ready or calibrating, one lock
  * the page draws each, a bar of one segment an item, the item on screen marked, a key in words
  * /review/nav redraws the panel for what the client has on screen (?focus=), read-only, refusing a part that isn't
    theirs; the client asks once per focus and only for the four kinds that change on the client
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The queue panel in every view")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
ids = lambda xs: [str(x["id"]) for x in xs]  # noqa: E731

# ---------------------------------------------------------------------------
s.section("Mine: the KPI check-in")
KPI = {"kind": "kpi", "items": [
    {"id": "1", "name": "Sales revenue", "tag": "Weight 40%", "done": True, "meta": "AE"},
    {"id": "2", "name": "Gross profit", "tag": "Weight 30%", "done": True, "meta": "ME"},
    {"id": "3", "name": "Group PAT", "tag": "Weight 10%", "done": True, "hr": True, "meta": "Filled by HR"},
    {"id": "4", "name": "Customer visits", "tag": "Weight 20%", "done": False, "meta": "Not entered"},
    {"id": "remark", "name": "Overall remark", "tag": "", "done": False, "meta": "Required"},
    {"id": "confirm", "name": "Save & submit", "tag": "", "done": False, "meta": "Final step"}]}
q = a._mine_queue(KPI)
s.check("the next step is the first line still to do (HR's line is never yours)", q["style"] == "next"
        and q["start"]["id"] == "4" and q["start"]["line"] == "Weight 20% · Not entered", q["start"])
s.check("...then the remark and Save & submit, in order", ids(q["up"]) == ["remark", "confirm"], ids(q["up"]))
s.check("...the done and HR's lines fold away in their own lists",
        [(l_["key"], ids(l_["items"])) for l_ in q["lists"]] == [("done", ["1", "2"]), ("hr", ["3"])], q["lists"])
s.check("...the bar marks the next step; the key says 3 to do, 2 done, 1 by Group People (2026-10-26)",
        [g["here"] for g in q["segs"]].index(True) == 3 and [(k["n"], k["label"]) for k in q["keys"]]
        == [(3, "to do"), (2, "done"), (1, "by Group People")], q["keys"])
qd = a._mine_queue(dict(KPI, items=[dict(it, done=True) for it in KPI["items"]]))
s.check("...all done: no next step, the card says so", qd["start"] is None and qd["summary"] == "Submitted.")

s.section("Mine: the 360 and the competency")
FB = {"kind": "feedback", "focus": 12, "items": [
    {"id": "11", "name": "Person 11", "tag": "Your manager", "done": False, "prog": 4, "total": 10, "meta": "4/10"},
    {"id": "12", "name": "Person 12", "tag": "Peer", "done": False, "prog": 0, "total": 10, "meta": "0/10"},
    {"id": "13", "name": "Person 13", "tag": "Peer", "done": False, "prog": 0, "total": 10, "meta": "0/10"},
    {"id": "14", "name": "Person 14", "tag": "Peer", "done": True, "prog": 10, "total": 10, "meta": "Submitted"}]}
q = a._mine_queue(FB)
s.check("the colleague on screen with Previous / Next; the line says who they are to you and how far",
        q["on"]["id"] == "12" and q["prev"]["id"] == "11" and q["next"]["id"] == "13"
        and q["on"]["line"] == "Peer · 0 of 10", q["on"]["line"])
s.check("...Up next: the others still to assess, from the one after, round to the start",
        ids(q["up"]) == ["13", "11"] and [(l_["key"], ids(l_["items"])) for l_ in q["lists"]] == [("done", ["14"])])
CP = {"kind": "competency", "focus": "Cost", "items": [
    {"id": "Ops", "name": "Ops", "done": False, "prog": 1, "total": 2, "meta": "1 left"},
    {"id": "Cost", "name": "Cost", "done": False, "prog": 1, "total": 3, "meta": "2 left"},
    {"id": "Team", "name": "Team", "done": True, "prog": 2, "total": 2, "meta": "All answered"},
    {"id": "remark", "name": "Overall remark", "done": False, "meta": "Required"},
    {"id": "confirm", "name": "Save & submit", "done": False, "meta": "Final step"}]}
q = a._mine_queue(CP)
s.check("the category on screen; Previous / Next step through the categories only",
        q["on"]["id"] == "Cost" and q["prev"]["id"] == "Ops" and q["next"]["id"] == "Team", (q["prev"], q["next"]))
s.check("...Up next: the categories left, then the remark and Save & submit",
        ids(q["up"]) == ["Ops", "remark", "confirm"], ids(q["up"]))
IDP = {"kind": "career_plan", "items": [
    {"id": "goals", "name": "Development goals", "done": True, "na": True, "meta": "Opens at year-end"},
    {"id": "where", "name": "Where you want to go", "done": True, "na": False, "meta": "[Target role]"},
    {"id": "mobility", "name": "How far you'd move", "done": False, "na": False, "meta": "Not chosen yet"},
    {"id": "share", "name": "Save & share", "done": False, "na": False, "meta": "Final step"}]}
q = a._mine_queue(IDP)
s.check("the Career Plan: the next step, then Save & share; what opens later folds away; the note says sharing locks",
        q["start"]["id"] == "mobility" and ids(q["up"]) == ["share"]
        and [(l_["key"], ids(l_["items"])) for l_ in q["lists"]] == [("done", ["where"]), ("wait", ["goals"])]
        and "locks the plan" in (q["note"] or {}).get("text", ""), (q["start"], q["lists"]))

# ---------------------------------------------------------------------------
s.section("Dept, BU, BG, Group")
_wvt = a._journey_view_tier
PEOPLE = [{"id": "21", "name": "Person 21", "done": False, "meta": "ME", "scope_locked": False, "closed": False},
          {"id": "22", "name": "Person 22", "done": True, "meta": "AE", "scope_locked": False, "closed": False},
          {"id": "23", "name": "Person 23", "done": False, "meta": "BE", "scope_locked": False, "closed": False}]
try:
    a._journey_view_tier = lambda db=None, u=None: "hod"
    with a.app.test_request_context("/"):
        qh = a._calib_queue(a.get_db(), None, "calibration", PEOPLE, focus="23")
        qs = a._calib_queue(a.get_db(), None, "calibration", PEOPLE, focus=None)
    s.check("Dept: the person on screen, the next still to review, the reviewed folded away, the submit line",
            qh["nq_kind"] == "calib-dept" and qh["on"]["id"] == "23" and ids(qh["up"]) == ["21"]
            and [(l_["key"], ids(l_["items"])) for l_ in qh["lists"]] == [("done", ["22"])]
            and qh["note"]["text"].startswith("Not submitted"), (qh["note"], ids(qh["up"])))
    s.check("...nobody on screen: start with the first still to review", qs["on"] is None and qs["start"]["id"] == "21")
    a._journey_view_tier = lambda db=None, u=None: "buceo"
    with a.app.app_context():
        _db = a.get_db()
        rows = _db.execute("SELECT id, department FROM users WHERE role!='admin' AND left_at IS NULL AND "
                           "COALESCE(department,'')!='' ORDER BY department, id LIMIT 40").fetchall()
    BU_P = [{"id": str(r["id"]), "name": "Person %d" % i, "done": False, "meta": "ME", "scope_locked": False,
             "closed": False, "moved": i < 2} for i, r in enumerate(rows)]
    depts = sorted({(r["department"] or "").strip() for r in rows}, key=str.lower)
    with a.app.test_request_context("/"):
        qb = a._calib_queue(a.get_db(), None, "calibration", BU_P, focus=depts[0] if depts else None)
        qe = a._calib_queue(a.get_db(), None, "calibration", BU_P, focus="")
    s.check("BU: the departments are the queue, each counted, the one picked on screen", qb["nq_kind"] == "calib-bu"
            and [g["name"] for g in qb["segs"]] == depts and qb["on"]["id"] == depts[0]
            and sum(int(x["line"].split(" ")[0]) for x in [qb["on"]] + qb["up"] + qb["more"]) == len(BU_P),
            (len(depts), len(BU_P)))
    # an independent read of the same fact: a department's review is in when every HOD over its people locked theirs
    with a.app.app_context():
        _d = a.get_db()
        _cid = a.active_cycle_id(_d)
        _locked = {r[0] for r in _d.execute("SELECT scope_key FROM pm_calibration_sessions WHERE cycle_id=? AND "
                                             "tier='hod' AND locked_at IS NOT NULL", (_cid,))}
        _want = {}
        for r in rows:
            h = _d.execute("SELECT hod_id FROM users WHERE id=?", (r["id"],)).fetchone()[0]
            g = _want.setdefault((r["department"] or "").strip(), set())
            if h:
                g.add(str(h))
    _exp = {d: ("done" if (not hs or hs <= _locked) else "wait") for d, hs in _want.items()}
    _got = {x["id"]: x["state"] for x in [qb["on"]] + qb["up"] + qb["more"]}
    s.check("...each department says whether its HOD's review is in (read again on its own): green for in, grey for "
            "with the HOD", _got == _exp and all(("review in" in x["line"]) == (x["state"] == "done" and bool(_want[x["id"]]))
                                                for x in [qb["on"]] + qb["up"] + qb["more"]),
            (sorted(_got.values()), sorted(_exp.values())))
    # ...and with one department's HODs all locked, it alone turns green (the delta)
    _d0 = depts[0]
    _hs = sorted(_want.get(_d0) or [])
    if _hs:
        with a.app.app_context():
            _d = a.get_db()
            _had = {r[0]: r[1] for r in _d.execute(
                "SELECT scope_key, locked_at FROM pm_calibration_sessions WHERE cycle_id=? AND tier='hod' AND scope_key "
                "IN (%s)" % ",".join("?" * len(_hs)), [_cid] + _hs)}
            for h in _hs:
                if h not in _had:
                    _d.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, "
                               "scope_label) VALUES (?, 'hod', ?, '', 'test_nav_queue')", (_cid, h))
            _d.execute("UPDATE pm_calibration_sessions SET locked_at='2026-10-16 01:00:00' WHERE cycle_id=? AND "
                       "tier='hod' AND scope_key IN (%s)" % ",".join("?" * len(_hs)), [_cid] + _hs)
            _d.commit()
        try:
            with a.app.test_request_context("/"):
                qL = a._calib_queue(a.get_db(), None, "calibration", BU_P, focus=None)
            _gL = {x["id"]: x["state"] for x in [qL["start"]] + qL["up"] + qL["more"] if x}
            s.check("...lock every HOD over one department: it turns 'review in'", _gL.get(_d0) == "done", _gL.get(_d0))
        finally:
            with a.app.app_context():
                _d = a.get_db()
                for h in _hs:
                    if h in _had:
                        _d.execute("UPDATE pm_calibration_sessions SET locked_at=? WHERE cycle_id=? AND tier='hod' AND "
                                   "scope_key=?", (_had[h], _cid, h))
                    else:
                        _d.execute("DELETE FROM pm_calibration_sessions WHERE cycle_id=? AND tier='hod' AND scope_key=? "
                                   "AND scope_label='test_nav_queue'", (_cid, h))
                _d.commit()
    s.check("...Show everyone, Find a person over everyone in the unit, and who they moved",
            qb["show_all"] == {"id": "", "label": "Show everyone"} and len(qb["find"]) == len(BU_P)
            and ids(next(l_ for l_ in qb["lists"] if l_["key"] == "moved")["items"]) == [BU_P[0]["id"], BU_P[1]["id"]]
            and qb["note"]["text"].startswith("Not locked"))
    s.check("...everyone: nobody on screen, start with the first department", qe["on"] is None
            and qe["start"]["id"] == depts[0] and qe["summary_k"].startswith("Everyone"))
finally:
    a._journey_view_tier = _wvt

TB = {"kind": "tbox", "focus": "B", "items": [
    {"id": "A", "name": "Unit A", "done": True, "meta": "40 people · PAT x"},
    {"id": "B", "name": "Unit B", "done": False, "meta": "30 people · PAT y"},
    {"id": "C", "name": "Unit C", "done": False, "meta": "18 people · PAT z"}]}
q = a._tbox_queue(TB)
s.check("BG: the business unit the box shows, the next to lock, the locked folded away, the lock note",
        q["on"]["id"] == "B" and q["prev"]["id"] == "A" and q["next"]["id"] == "C" and ids(q["up"]) == ["C"]
        and [(l_["key"], ids(l_["items"])) for l_ in q["lists"]] == [("done", ["A"])] and "final" in q["note"]["text"])
_wgs = a.dash_group_status
try:
    a.dash_group_status = lambda db, u, cyc: {"units": [
        {"name": "People", "state": "ready", "sub": "14 people · every rating is final"},
        {"name": "Technology", "state": "ready", "sub": "12 people · every rating is final"},
        {"name": "Data", "state": "busy", "sub": "9 people · 6 of 9 ratings final"}]}
    GN = {"kind": "tbox", "items": [{"id": "", "name": "Group X", "done": False, "meta": "35 people"}]}
    with a.app.test_request_context("/?seg=Data"):   # the batch on screen is the Segment pick (2026-11-02; it was ?dept=)
        qg = a._group_queue(a.get_db(), None, GN)
    with a.app.test_request_context("/"):
        qg0 = a._group_queue(a.get_db(), None, GN)
finally:
    a.dash_group_status = _wgs
s.check("Group: the batches are the queue, the one the box filters on screen (from the request's seg)",
        qg["nq_kind"] == "group" and (qg["on"] or {}).get("id") == "Data" and [g["state"] for g in qg["segs"]]
        == ["done", "done", "turn"] and qg["group_name"] == "Group X", [g["state"] for g in qg["segs"]])
s.check("...everyone: start with the first batch; one lock for the group", qg0["on"] is None
        and qg0["start"]["id"] == "People" and "One lock" in qg0["note"]["text"] and qg0["show_all"]["id"] == "")

# ---------------------------------------------------------------------------
s.section("the page")


def render(nav, stage, view="mine", module="tm"):
    live = [{"key": stage, "module": module, "label": stage, "short": "Part", "state": "open", "group": "self"}]
    with a.app.test_request_context("/"):
        return a.render_template("_journey_nav.html", st={"stages": []}, active_stage=stage, live_stages=live,
                                 chat_keys=[stage], nav=dict(nav, queue=nav["queue"]), view=view)


hk = render(dict(KPI, queue=a._mine_queue(KPI)), "account", module="pm")
s.check("the KPI check-in: Next step, the line, Go to it as the KPI's own nav item, Then, Done and Filled by Group People",
        '<p class="rv-nq-k">Next step</p>' in hk and 'class="rv-nav-item rv-nq-start is-go" data-item-id="4" '
        'data-kind="kpi"' in hk and '<p class="rv-nq-k">Then</p>' in hk and 'data-nq-kind="kpi"' in hk
        and '<span class="t">Filled by Group People</span>' in hk and '<span class="t">Done</span>' in hk, hk[:1500])
hf = render(dict(FB, queue=a._mine_queue(FB)), "feedback")
s.check("the 360: On screen with its progress line, Previous / Next as feedback items, the note, Submitted",
        '<p class="rv-nq-k">On screen</p>' in hf and 'class="rv-nq-prog"' in hf
        and 'class="rv-nav-item rv-nq-step is-next" data-item-id="13" data-kind="feedback"' in hf
        and "without your name" in hf and '<span class="t">Submitted</span>' in hf
        and 'data-nq-focus="12"' in hf, hf[:1500])
try:
    a._journey_view_tier = lambda db=None, u=None: "buceo"
    with a.app.test_request_context("/"):
        qb2 = a._calib_queue(a.get_db(), None, "calibration", BU_P, focus=depts[0] if depts else None)
finally:
    a._journey_view_tier = _wvt
hb = render({"kind": "calib", "items": BU_P, "focus": None, "queue": qb2}, "calibration", view="bu", module="cal")
s.check("BU: Find a person (hidden matches as calib items), departments as dept items, Show everyone, the lock line",
        "data-nq-find" in hb and 'class="rv-nq-findlist" hidden' in hb and 'data-kind="calib"' in hb
        and 'data-kind="dept"' in hb and 'class="rv-nav-item rv-nq-all" data-item-id="" data-kind="dept"' in hb
        and "Not locked" in hb and 'data-nq-kind="calib-bu"' in hb)
_bar = re.search(r'<span class="rv-nq-bar"[^>]*>(.*?)</span>', hb, re.S)
s.check("...a segment a department, the one on screen marked", _bar and _bar.group(1).count("<i ") == len(depts)
        and _bar.group(1).count("is-here") == 1)
hg = render({"kind": "tbox", "items": GN["items"], "focus": "", "queue": qg}, "group_calib", view="group", module="cal")
s.check("Group: the group's name, batches as batch items, Show everyone, the one lock",
        'class="rv-nq-sub">Group X<' in hg and 'data-kind="batch"' in hg and "One lock" in hg
        and 'class="rv-nav-item rv-nq-all" data-item-id="" data-kind="batch"' in hg)
s.check("...Data on screen (its line), People and Technology up next", 'title="Data">Data<' in hg
        and hg.find('<p class="rv-nq-k">Up next</p>') < hg.find('title="People">People<'))

# ---------------------------------------------------------------------------
s.section("/review/nav and the client")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    _uni = db.execute("SELECT value FROM app_settings WHERE key='review_unified'").fetchone()
    _rev = db.execute("SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (CID,)).fetchone()
    db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('review_unified','1')")
    db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'review', 1)", (CID,))
    db.commit()
try:
    anon = a.app.test_client().get("/review/nav?stage=account")
    s.check("signed out: the sign-in", anon.status_code in (301, 302), anon.status_code)
    EMP = None
    with a.app.app_context():
        for r in a.get_db().execute("SELECT id FROM users WHERE role!='admin' AND left_at IS NULL ORDER BY id LIMIT 80"):
            with a.app.test_request_context("/"):
                from flask import session as _ss
                _ss["user_id"] = r[0]
                d = a.get_db()
                u = d.execute("SELECT * FROM users WHERE id=?", (r[0],)).fetchone()
                keys = [x["key"] for x in a._journey_live_stages(a.review_state(d, u))]
            if keys:
                EMP, KEY = r[0], keys[0]
                break
    s.check("someone with a live part", EMP is not None)
    if EMP:
        C = H.client_as(a, EMP)
        def _counts():
            with a.app.app_context():
                d = a.get_db()
                return [d.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
                        for t in ("activity_log", "pm_review_chat", "pm_manager_chat", "app_settings")]
        n0 = _counts()
        j = C.get("/review/nav?stage=%s&view=mine&focus=zz" % KEY).get_json() or {}
        s.check("their part: the panel, drawn as a queue", 'class="rv-nav' in (j.get("nav_html") or ""), list(j))
        s.check("...a part that isn't theirs: 404", C.get("/review/nav?stage=nonsense").status_code == 404)
        s.check("...read-only: no row written", _counts() == n0, (n0, _counts()))
finally:
    with a.app.app_context():
        db = a.get_db()
        if _uni is None:
            db.execute("DELETE FROM app_settings WHERE key='review_unified'")
        else:
            db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('review_unified',?)", (_uni[0],))
        if _rev is None:
            db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (CID,))
        else:
            db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'review', ?)",
                       (CID, _rev[0]))
        db.commit()

_js = H.source(a, "static/journey_chat.js")
s.check("the client asks for the panel only for the four kinds that change on the client, once per focus",
        'if (kind === "feedback") return curSubject' in _js and 'if (kind === "competency")' in _js
        and 'if (kind === "calib-dept")' in _js and 'if (kind === "calib-bu") return cal.data ? (cf.dept.length === 1 ? cf.dept[0] : "") : null;'
        in _js and "if (ask === nqAsked) return;" in _js and 'fetch("/review/nav" + q' in _js)
s.check("...after every card redraw and a 360 colleague switch", "nqSync();   // the queue panel follows" in _js
        and "nqSync();                   // ...and the queue panel to them" in _js)
s.check("a department opens the curve's filter, a batch the box's; the BU's old list filter stands aside for the queue",
        'if (kind === "dept") {' in _js and 'if (kind === "batch") { markNavCurrent(el); tbSelectFilter("seg", id ? [id] : []); return; }'
        in _js and 'if (document.querySelector(".rv-nav.is-queue")) return;   // the queue draws' in _js)
s.check("Find a person shows six matches at most, and says when none", "shown < 6" in _js and "data-nq-nomatch" in _js)

_css = H.source(a, "static/style.css")
s.check("the BU CEO's curve: the filter line in the room left on its strip (2026-10-30, was the department row), Show moved "
        "beside the Lock (2026-10-17, was a Moved only chip); the table nearer the curve (Chris, 2026-10-16)",
        ".rv-cal-fline { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; min-height: 34px; }"
        in _css and ".rv-cal-lockbox > .rv-cal-showmoved { flex: none; align-self: center; }" in _css
        and ".rv-cal-movedtg" not in _css
        and ".rv-calib-pin > .rv-cal-status:empty { display: none; }" in _css
        and ".rv-calib-pin > .rv-calib-roster { margin-top: 0; }" in _css)
_tpl = H.source(a, "templates/_journey_nav.html")
s.check("the summary card's button says just 'Start', who it starts with on hover and to a screen reader",
        '<span class="rv-nq-nm">Start</span>' in _tpl and 'aria-label="{{ Q[\'start_label\'] }} {{ Q[\'start\'][\'name\'] }}"'
        in _tpl and "{{ Q['start_label'] }} {{ Q['start']['name'] }}</span>" not in _tpl)

sys.exit(s.done())
