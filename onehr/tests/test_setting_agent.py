"""The conversational KPI-SETTING agent (2026-09-03). Same contract as the check-in
agent: the MODEL converses and proposes; these tools VALIDATE and perform every
write, enforce the 100%-weight rule and per-line completeness, and the agent can
NEVER propose the set for approval -- that is the human's Submit click. The real
model is never called here; the agent turn (and draft_kpi_set) are stubbed.

Writes (draft KPI targets), so a fresh copy.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
s = H.Suite("Setting agent -- tools validate & write, the model only proposes")
SU, _BG, _EMP = H.actors(a)

CHBM = "ZZ-SET-BG"   # a private BG for this fixture, mechanism A


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


# ---------------------------------------------------------------------------
s.section("build: a subject in the SETTING period with an eligible library")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','pm')")
    # KPI setting runs in an Early Year only (2026-10-15): the suite's cycle is one while it runs, then goes back
    _prev_cyc = dict(db.execute("SELECT kind, year, half FROM cycles WHERE id=?", (CID,)).fetchone())
    db.execute("UPDATE cycles SET kind='early_year', year=2027, half=0 WHERE id=?", (CID,))

    def _put_cycle_back():
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("UPDATE cycles SET kind=?, year=?, half=? WHERE id=?",
                       (_prev_cyc["kind"], _prev_cyc["year"], _prev_cyc["half"], CID))
            d_.commit()
    import atexit
    atexit.register(_put_cycle_back)
    us = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                    "ORDER BY id LIMIT 2").fetchall()
    SUBJ, OTHER = us[0], us[1]
    # Put both subjects in the fixture BG so the library resolves for them, and give
    # the subject a manager so an approver chain resolves on propose.
    for uid in (SUBJ["id"], OTHER["id"]):
        db.execute("UPDATE users SET business_group=?, company='ZZCo', department='ZZDept', "
                   "job_grade='G14' WHERE id=?", (CHBM, uid))
    db.execute("UPDATE users SET manager_id=? WHERE id=?", (SU["id"], SUBJ["id"]))
    # A clean slate: no targets yet -> editable setting period.
    for uid in (SUBJ["id"], OTHER["id"]):
        db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (CID, uid))
    if not db.execute("SELECT 1 FROM pm_bg_config WHERE business_group=?", (CHBM,)).fetchone():
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (CHBM,))

    def lib(name, cat, method, base, spread, wd):
        return db.execute(
            "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, "
            "kpi_name, category, description, unit, method, rate3, target, weightage_default, "
            "spread_json, active) VALUES (?, '*', '*', 0, '*', ?, ?, ?, '%', ?, ?, ?, ?, ?, 1)",
            (CHBM, name, cat, name + " detail", method, base, base, wd, spread)).lastrowid

    ASC = '{"rate":[80,90,100,110,120]}'
    DESC = '{"rate":[120,110,100,90,80]}'
    L_REV = lib("ZZ Lib Revenue", "Financial", "more", 100.0, ASC, 40.0)
    L_COST = lib("ZZ Lib Cost", "Financial", "less", 50.0, DESC, 30.0)
    L_SAFE = lib("ZZ Lib Safety", "Operational", "more", 100.0, ASC, 30.0)
    db.commit()


def tool(name, args, uid=None):
    uid = uid or SUBJ["id"]
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return a._setting_run_tool(db, dict(u), CID, {"tool": name, "args": args})


def status_of(kpi_name):
    return H.one(a, "SELECT status FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? "
                    "AND kpi_name=?", (CID, SUBJ["id"], kpi_name))


def target_id(kpi_name):
    return H.one(a, "SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? "
                    "AND kpi_name=?", (CID, SUBJ["id"], kpi_name))


def has_target(kpi_name):
    return H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? "
                    "AND kpi_name=?", (CID, SUBJ["id"], kpi_name)) > 0


with a.app.test_request_context("/"):
    from flask import session as _sess
    _sess["user_id"] = SUBJ["id"]
    _db = a.get_db()
    _u = _db.execute("SELECT * FROM users WHERE id=?", (SUBJ["id"],)).fetchone()
    _libn = len(a.pm_library_for_person(_db, dict(_u), 0))
s.check("the eligible library resolves for the subject (>=3 rows)", _libn >= 3, _libn)

# ---------------------------------------------------------------------------
s.section("add_kpi -- eligible only, writes a DRAFT row")
r = tool("add_kpi", {"library_id": L_REV})
s.check("ok", r.get("ok") is True, r)
s.check("...it names the KPI added", r.get("added") == "ZZ Lib Revenue", r)
s.check("a draft target row was written", status_of("ZZ Lib Revenue") == "draft")
# the library fixtures above still carry old figures, a weight and a spread: the add must ignore every one
s.check("...with no weight yet (0 reads as not set), never the library's old default", target_id("ZZ Lib Revenue") is not None
        and H.one(a, "SELECT weightage FROM pm_kpi_targets WHERE id=?",
                  (target_id("ZZ Lib Revenue"),)) == 0)
s.check("...and every figure blank, number_source 'blank' (nothing from the library, no spread)",
        tuple(H.rows(a, "SELECT rate1, rate3, rate5, threshold, target, multiple, excellence "
                        "FROM pm_kpi_targets WHERE id=?", (target_id("ZZ Lib Revenue"),))[0]) == (None,) * 7
        and H.one(a, "SELECT number_source FROM pm_kpi_targets WHERE id=?", (target_id("ZZ Lib Revenue"),)) == "blank")
s.check("a library id NOT in the eligible set is refused",
        tool("add_kpi", {"library_id": 999999}).get("ok") is False)
s.check("adding the same KPI twice is refused (already on the scorecard)",
        tool("add_kpi", {"library_id": L_REV}).get("ok") is False)

# ---------------------------------------------------------------------------
s.section("set_weight / remove -- own editable lines only")
s.check("set_weight on an own draft line works",
        tool("set_weight", {"kpi_id": target_id("ZZ Lib Revenue"), "weight": "55"}).get("ok") is True)
s.check("...the weight was written", H.one(a, "SELECT weightage FROM pm_kpi_targets WHERE id=?",
                                           (target_id("ZZ Lib Revenue"),)) == 55.0)
s.check("a weight outside 0-100 is refused",
        tool("set_weight", {"kpi_id": target_id("ZZ Lib Revenue"), "weight": "150"}).get("ok") is False)
# Build OTHER's own line to prove cross-subject refusal.
with a.app.app_context():
    db = a.get_db()
    OT = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
                    "status, business_group) VALUES (?,?,?,?, 'more', 'draft', ?)",
                    (CID, OTHER["id"], "ZZ Not Yours", 50.0, CHBM)).lastrowid
    db.commit()
s.check("set_weight on ANOTHER person's line is refused",
        tool("set_weight", {"kpi_id": OT, "weight": "20"}).get("ok") is False)
s.check("remove_kpi on an own draft line works",
        tool("remove_kpi", {"kpi_id": target_id("ZZ Lib Revenue")}).get("ok") is True)
s.check("...the row is gone", not has_target("ZZ Lib Revenue"))

# ---------------------------------------------------------------------------
s.section("set_target sets the target only (nothing derives the other points); set_number is mechanism-scoped")
tool("add_kpi", {"library_id": L_REV})
RID = target_id("ZZ Lib Revenue")
s.check("set_target sets the target",
        tool("set_target", {"kpi_id": RID, "base": "200"}).get("ok") is True
        and H.one(a, "SELECT target FROM pm_kpi_targets WHERE id=?", (RID,)) == 200.0)
s.check("...and derives nothing: no other point of the scale is written",
        tuple(H.rows(a, "SELECT rate1, rate2, rate3, rate4, rate5 FROM pm_kpi_targets WHERE id=?", (RID,))[0]) == (None,) * 5)
s.check("set_number accepts a Mechanism-A field (rate1)",
        tool("set_number", {"kpi_id": RID, "field": "rate1", "value": "150"}).get("ok") is True)
s.check("set_number REFUSES a Mechanism-B field on an A line (threshold)",
        tool("set_number", {"kpi_id": RID, "field": "threshold", "value": "10"}).get("ok") is False)
# A % line: the model echoes the unit ("42%"), as the results chat once failed to save "41%" (2026-10-19).
_unit_was = H.one(a, "SELECT unit FROM pm_kpi_targets WHERE id=?", (RID,))
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE pm_kpi_targets SET unit='%' WHERE id=?", (RID,))
    db.commit()
s.check("set_target takes '200%' on a % line (the same target as 200)",
        tool("set_target", {"kpi_id": RID, "base": "200%"}).get("ok") is True
        and H.one(a, "SELECT target FROM pm_kpi_targets WHERE id=?", (RID,)) == 200.0)
s.check("set_number takes '150%' on a % line",
        tool("set_number", {"kpi_id": RID, "field": "rate1", "value": "150%"}).get("ok") is True
        and H.one(a, "SELECT rate1 FROM pm_kpi_targets WHERE id=?", (RID,)) == 150.0)
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE pm_kpi_targets SET unit='RM' WHERE id=?", (RID,))
    db.commit()
_e = tool("set_number", {"kpi_id": RID, "field": "rate1", "value": "151%"})
s.check("set_number refuses '151%' on an RM line, telling the model to pass the bare number",
        _e.get("ok") is False and "bare number" in (_e.get("error") or ""), _e)
s.check("set_target refuses '210%' on an RM line",
        tool("set_target", {"kpi_id": RID, "base": "210%"}).get("ok") is False
        and H.one(a, "SELECT target FROM pm_kpi_targets WHERE id=?", (RID,)) == 200.0)
s.check("set_target still refuses 0", tool("set_target", {"kpi_id": RID, "base": "0"}).get("ok") is False)
with a.app.app_context():   # put it back
    db = a.get_db()
    db.execute("UPDATE pm_kpi_targets SET unit=? WHERE id=?", (_unit_was, RID))
    db.commit()

# ---------------------------------------------------------------------------
s.section("suggest_set -- reuses draft_kpi_set, weights normalised to 100 server-side")
_draft = ai_draft.draft_kpi_set
try:
    # Stub the model to pick two library KPIs with lopsided weights; the server
    # re-normalises to total exactly 100.
    ai_draft.draft_kpi_set = lambda *args, **kw: (
        '[{"id":%d,"weightage":30},{"id":%d,"weightage":10}]' % (L_REV, L_SAFE))
    r = tool("suggest_set", {})
    s.check("suggest_set replaced the draft set", r.get("ok") is True and r.get("suggested") == 2, r)
    tot = H.one(a, "SELECT ROUND(SUM(weightage),2) FROM pm_kpi_targets WHERE cycle_id=? "
                   "AND subject_id=? AND status='draft'", (CID, SUBJ["id"]))
    s.check("...the weights total exactly 100 (normalised server-side)", tot == 100.0, tot)
finally:
    ai_draft.draft_kpi_set = _draft

# ---------------------------------------------------------------------------
s.section("show_library -- a browsable card of the eligible KPI library")
_before = H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?",
                (CID, SUBJ["id"]))
rl = tool("show_library", {})
s.check("show_library returns a setting_library render",
        rl.get("render", {}).get("type") == "setting_library", rl)
_libnames = [x["name"] for x in rl["render"]["data"]["lines"]]
s.check("...it lists the person's eligible library KPIs (>=3)", len(_libnames) >= 3, _libnames)
s.check("...each row carries a library_id to add by",
        all("library_id" in x for x in rl["render"]["data"]["lines"]), rl["render"]["data"]["lines"][:1])
s.check("show_library WROTE NOTHING (read-only)",
        H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?",
              (CID, SUBJ["id"])) == _before, _before)

# ---------------------------------------------------------------------------
s.section("prepare_propose -- WRITES NOTHING, blocks until the set is ready")
# The suggested set (Revenue + Safety, normalised to 100) starts with blank figures: the person sets every point
# (the library holds no ladder), so prepare_propose first refuses, naming the missing scale, then is ready once typed.
_pp0 = tool("prepare_propose", {})
s.check("prepare_propose refuses while the scale is blank, saying what is missing",
        _pp0.get("ok") is False and "Rate 1" in (_pp0.get("error") or ""), _pp0)
for _n in ("ZZ Lib Revenue", "ZZ Lib Safety"):
    for _i, _v in enumerate(("10", "20", "30", "40", "50"), start=1):
        tool("set_number", {"kpi_id": target_id(_n), "field": "rate%d" % _i, "value": _v})
with a.app.app_context():
    snap = [dict(r) for r in a.get_db().execute(
        "SELECT id, status FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?",
        (CID, SUBJ["id"])).fetchall()]
pp = tool("prepare_propose", {})
s.check("prepare_propose is ready when weights=100 and lines complete",
        pp.get("ok") is True and pp.get("ready") is True, pp)
s.check("...it returns a setting_confirm render", pp.get("render", {}).get("type") == "setting_confirm", pp)
s.check("...the card names the approver", pp["render"]["data"].get("approver"), pp["render"]["data"])
with a.app.app_context():
    after = [dict(r) for r in a.get_db().execute(
        "SELECT id, status FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?",
        (CID, SUBJ["id"])).fetchall()]
s.check("prepare_propose WROTE NOTHING (all still draft)",
        after == snap and all(r["status"] == "draft" for r in after), after)
# Now knock a weight off 100 and confirm it blocks with a plain reason.
tool("set_weight", {"kpi_id": target_id("ZZ Lib Revenue"), "weight": "10"})
pp2 = tool("prepare_propose", {})
s.check("prepare_propose blocks when weights != 100", pp2.get("ok") is False
        and "100" in (pp2.get("error") or ""), pp2)
tool("set_weight", {"kpi_id": target_id("ZZ Lib Revenue"), "weight": "75"})

# ---------------------------------------------------------------------------
s.section("the human Submit -- POST /review/setting/propose is the ONLY propose")
E = H.client_as(a, SUBJ["id"])
# incomplete set first: blank a target number -> 400.
with a.app.app_context():
    a.get_db().execute("UPDATE pm_kpi_targets SET rate3=NULL WHERE cycle_id=? AND subject_id=? "
                       "AND kpi_name='ZZ Lib Safety'", (CID, SUBJ["id"]))
    a.get_db().commit()
r400 = post(E, "/review/setting/propose")
s.check("an incomplete set is refused with 400", r400.status_code == 400, r400.status_code)
s.check("...nothing was proposed", status_of("ZZ Lib Safety") == "draft")
# repair it, then submit for real.
with a.app.app_context():
    a.get_db().execute("UPDATE pm_kpi_targets SET rate3=30 WHERE cycle_id=? AND subject_id=? "
                       "AND kpi_name='ZZ Lib Safety'", (CID, SUBJ["id"]))
    a.get_db().commit()
rok = post(E, "/review/setting/propose")
j = rok.get_json()
s.check("a complete 100% set proposes", rok.status_code == 200 and j.get("proposed") is True, j)
s.check("...every line flipped to proposed",
        status_of("ZZ Lib Revenue") == "proposed" and status_of("ZZ Lib Safety") == "proposed")
s.check("...an approver chain was written",
        H.one(a, "SELECT COUNT(*) FROM pm_kpi_target_approvers WHERE kpi_target_id=?",
              (target_id("ZZ Lib Revenue"),)) >= 1)

# ---------------------------------------------------------------------------
s.section("once proposed, the tools refuse (it is with the approver)")
s.check("add_kpi is refused when the set is proposed",
        tool("add_kpi", {"library_id": L_COST}).get("ok") is False)
s.check("set_weight is refused when the set is proposed",
        tool("set_weight", {"kpi_id": target_id("ZZ Lib Revenue"), "weight": "60"}).get("ok") is False)

# ---------------------------------------------------------------------------
s.section("the agent loop -- a stubbed model proposes, the server executes")
_avail, _agent = ai_draft.review_agent_available, ai_draft.review_agent
SCRIPT = []


def stub_agent(system, messages, timeout=90):
    return SCRIPT.pop(0)


ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = stub_agent
try:
    # Reset the subject back to an editable, empty scorecard.
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (CID, SUBJ["id"]))
        db.execute("DELETE FROM pm_setting_chat WHERE subject_id=?", (SUBJ["id"],))
        db.commit()
    E = H.client_as(a, SUBJ["id"])
    SCRIPT[:] = [
        {"say": "Adding Revenue.", "quick_replies": [],
         "action": {"tool": "add_kpi", "args": {"library_id": L_REV}}},
        {"say": "Done — Revenue is on your scorecard. What weight?",
         "quick_replies": ["40", "50", "type it", "Skip"], "action": None},
    ]
    resp = post(E, "/review/setting/chat", message="add revenue").get_json()
    s.check("the loop ran the tool then returned the final say",
            resp.get("say", "").startswith("Done"), resp)
    s.check("...the proposed add actually landed (server executed it)",
            status_of("ZZ Lib Revenue") == "draft")
    s.check("...a live setting overview comes back", resp.get("overview")
            and len(resp["overview"]["lines"]) == 1, resp.get("overview"))
    s.check("...with the running weight total", "total_weight" in (resp.get("overview") or {}))
    s.check("...and a fresh rail for the live update", "rail_html" in resp)
    s.check("the transcript persisted to pm_setting_chat",
            H.one(a, "SELECT COUNT(*) FROM pm_setting_chat WHERE subject_id=?", (SUBJ["id"],)) >= 2)
    _qr = resp.get("quick_replies") or []
    s.check("bare-number weight chips are stripped", not any(
        re.match(r"^\s*[-+]?[\d.,]+\s*%?\s*$", str(q)) for q in _qr), _qr)
    s.check("...the 'type it' chip is stripped too", not any(
        re.search(r"type it", str(q), re.I) for q in _qr), _qr)
    s.check("...but action chips (Skip) survive", "Skip" in _qr, _qr)
    # A propose card is TERMINAL: a model that re-calls prepare_propose every turn must
    # NOT stack duplicate cards (Chris saw five). Make the set ready (one KPI at 100%,
    # its scale typed: nothing is pre-filled now), feed TWO prepare_propose turns, and assert only ONE card
    # comes back and the second turn was never consumed (the loop broke).
    with a.app.app_context():
        a.get_db().execute("UPDATE pm_kpi_targets SET weightage=100, rate1=10, rate2=20, rate3=30, "
                           "rate4=40, rate5=50 WHERE cycle_id=? AND subject_id=? AND kpi_name='ZZ Lib Revenue'", (CID, SUBJ["id"]))
        a.get_db().commit()
    SCRIPT[:] = [
        {"say": "Ready to submit.", "quick_replies": [], "action": {"tool": "prepare_propose", "args": {}}},
        {"say": "Ready again.", "quick_replies": [], "action": {"tool": "prepare_propose", "args": {}}},
    ]
    rp = post(E, "/review/setting/chat", message="finalize the scorecard").get_json()
    _cards = [x for x in (rp.get("renders") or []) if x.get("type") == "setting_confirm"]
    s.check("prepare_propose renders EXACTLY ONE card (no duplicate stacking)", len(_cards) == 1, len(_cards))
    s.check("...the second prepare_propose turn was never consumed (the loop broke)", len(SCRIPT) == 1, len(SCRIPT))
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _avail, _agent

# ---------------------------------------------------------------------------
s.section("DEMO ONLY -- a ZZ account's AGREED scorecard stays editable for testing")
# So a tester can exercise the setting chat without first rewinding an approved
# account. Gated on is_demo_account (a demo server + "ZZ" and a letter; real ZZ IDs are digits),
# and a pure read (the rows keep status 'approved' until a deliberate propose).
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE users SET employee_id='ZZDEMO-SETTEST' WHERE id=?", (OTHER["id"],))
    db.execute("DELETE FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=?", (OTHER["id"], CID))
    db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
               "status, business_group, rate1, rate2, rate3, rate4, rate5) "
               "VALUES (?,?,?,?, 'more', 'approved', ?, 80, 90, 100, 110, 120)",
               (CID, OTHER["id"], "ZZ Agreed KPI", 100.0, CHBM))
    db.commit()
    zz = dict(db.execute("SELECT * FROM users WHERE id=?", (OTHER["id"],)).fetchone())
    with a.app.test_request_context("/"):
        from flask import session as _s
        _s["user_id"] = OTHER["id"]
        ctx_zz = a._pm_setting_context(a.get_db(), zz)
s.check("a ZZ demo account's agreed scorecard is EDITABLE", ctx_zz["editable"] is True, ctx_zz["editable"])
s.check("...its agreed rows are folded into the working set",
        len(ctx_zz["mine"]) == 1 and ctx_zz["mine"][0]["kpi_name"] == "ZZ Agreed KPI",
        [t["kpi_name"] for t in ctx_zz["mine"]])
s.check("...the rows KEEP status 'approved' (pure read, no write)",
        ctx_zz["mine"][0]["status"] == "approved", ctx_zz["mine"][0]["status"])
r = tool("set_weight", {"kpi_id": ctx_zz["mine"][0]["id"], "weight": "80"}, uid=OTHER["id"])
s.check("...a tool can edit an agreed line on a ZZ account", r.get("ok") is True, r)
# A REAL (non-ZZ) account's agreed scorecard is NOT editable -- the lock holds.
with a.app.app_context():
    db = a.get_db()
    real = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                      "AND employee_id NOT LIKE 'ZZ%' AND id NOT IN (?, ?) LIMIT 1",
                      (SUBJ["id"], OTHER["id"])).fetchone()
    db.execute("UPDATE users SET business_group=? WHERE id=?", (CHBM, real["id"]))
    db.execute("DELETE FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=?", (real["id"], CID))
    db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
               "status, business_group, rate1, rate2, rate3, rate4, rate5) "
               "VALUES (?,?,?,?, 'more', 'approved', ?, 80, 90, 100, 110, 120)",
               (CID, real["id"], "Real Agreed KPI", 100.0, CHBM))
    db.commit()
    realu = dict(db.execute("SELECT * FROM users WHERE id=?", (real["id"],)).fetchone())
    with a.app.test_request_context("/"):
        from flask import session as _s
        _s["user_id"] = real["id"]
        ctx_real = a._pm_setting_context(a.get_db(), realu)
s.check("a REAL account's agreed scorecard is NOT editable (the lock holds)",
        ctx_real["editable"] is False, ctx_real["editable"])
s.check("...its agreed rows are NOT folded into the working set (mine empty)",
        ctx_real["mine"] == [], [t["kpi_name"] for t in ctx_real["mine"]])

# ---------------------------------------------------------------------------
s.section("degradation -- no model reachable, an honest reply not a broken chat")
E = H.client_as(a, SUBJ["id"])
resp = post(E, "/review/setting/chat", message="hi").get_json()
s.check("with no model configured the chat degrades honestly (done=True)",
        resp.get("done") is True and "isn't switched on" in resp.get("say", ""), resp)
# ABSENT is not EMPTY: a degraded turn must still carry an overview so the client
# doesn't wipe the pinned scorecard (the bug fixed for IDP, now fixed here too).
s.check("...a degraded turn STILL carries an overview", "overview" in resp, list(resp))
_avail_g, _agent_g = ai_draft.review_agent_available, ai_draft.review_agent


def _boom(system, messages, timeout=90):
    raise ai_draft.AIDraftError("simulated transient failure")


ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = _boom
try:
    rerr = post(H.client_as(a, SUBJ["id"]), "/review/setting/chat", message="hi").get_json()
    s.check("a model ERROR mid-conversation still carries an overview (widget not wiped)",
            "overview" in rerr, list(rerr))
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _avail_g, _agent_g
_js = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                        "static", "setting_chat.js"), encoding="utf-8").read()
s.check("the client ignores an ABSENT overview rather than clearing on it",
        "if (data === undefined) return;" in _js)

sys.exit(s.done())
