"""The conversational AHEAD (IDP) agent -- the development plan (2026-09-04). Same
contract as the competency / setting / check-in agents: the MODEL converses and
proposes; these tools VALIDATE and perform every write, and the agent can NEVER
share the plan -- that is the employee's explicit Share click. The real model is
never called here; the agent turn is stubbed.

The load-bearing assertion in this file is that the /idp PAGE and the CHAT read one
gate (pm_idp_share_validate), so they cannot disagree about whether a plan is ready.

Writes (pm_idp / pm_idp_goals), so a fresh copy.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
s = H.Suite("Development-plan agent -- tools validate & write, the model only proposes")
SU, _BG, _EMP = H.actors(a)


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


# ---------------------------------------------------------------------------
s.section("build: a Year-End (authoring) period and two subjects with plans")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','idp')")
    # A plan is AUTHORED at Year-End (pm_idp_is_authoring), so put the active cycle
    # there -- otherwise every write path is correctly closed and nothing is testable.
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    us = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                    "ORDER BY id LIMIT 2").fetchall()
    SUBJ, OTHER = dict(us[0]), dict(us[1])
    db.commit()
with a.app.test_request_context("/"):
    db = a.get_db()
    # pm_viewed_period() reads request.args, so every IDP context read in this
    # suite runs inside a request context -- the same one the routes give it.
    period, _p, _act = a._pm_idp_period(db, SUBJ)
    PLAN_YEAR = a.pm_idp_plan_year(period)
    # The other person's plan, so a forged goal_id has something real to point at.
    other_idp = a.pm_idp_for(db, PLAN_YEAR, OTHER["id"], create=True, cycle_id=period["id"])
    OTHER_GOAL = db.execute(
        "INSERT INTO pm_idp_goals(idp_id, seq, area) VALUES (?,1,'Their own goal')",
        (other_idp["id"],)).lastrowid
    db.commit()
s.check("the period is an authoring one", a.pm_idp_is_authoring(period) is True)
s.check("...so a real account can edit", a.pm_idp_can_edit(None, True) is True)


def tool(name, args, uid=None):
    uid = uid or SUBJ["id"]
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return a._idp_run_tool(db, dict(u), CID, {"tool": name, "args": args})


def my_idp():
    with a.app.app_context():
        return a.pm_idp_for(a.get_db(), PLAN_YEAR, SUBJ["id"], create=False)


def goals():
    idp = my_idp()
    return idp["goals"] if idp else []


def status():
    return H.one(a, "SELECT status FROM pm_idp WHERE plan_year=? AND subject_id=?",
                 (PLAN_YEAR, SUBJ["id"]))


def goal_count():
    return len(goals())


# ---------------------------------------------------------------------------
s.section("add_goal -- names the area, respects the ceiling")
r = tool("add_goal", {"area": "Stakeholder influence"})
s.check("ok", r.get("ok") is True, r)
G1 = r.get("goal_id")
s.check("...the goal landed on the plan", goal_count() == 1, goal_count())
s.check("...with the area written", (goals()[0]["area"] or "") == "Stakeholder influence")
s.check("...and marked as coming from the chat", goals()[0]["source"] == "chat")
s.check("an empty area is refused", tool("add_goal", {"area": "  "}).get("ok") is False)
s.check("...and wrote nothing", goal_count() == 1)

# ---------------------------------------------------------------------------
s.section("set_goal_field -- whitelisted fields, own plan only")
r = tool("set_goal_field", {"goal_id": G1, "field": "action_experience",
                            "value": "Lead the Q3 supplier negotiation end to end"})
s.check("the on-the-job action saves", r.get("ok") is True, r)
s.check("...and is readable back",
        "supplier negotiation" in (goals()[0]["action_experience"] or ""))
s.check("an unknown field is refused",
        tool("set_goal_field", {"goal_id": G1, "field": "status", "value": "done"}).get("ok") is False)
s.check("a column that is NOT a plan field is refused (no SQL reaching the table)",
        tool("set_goal_field", {"goal_id": G1, "field": "manager_comment",
                                "value": "sneaky"}).get("ok") is False)
s.check("...and the manager's column really is untouched",
        H.one(a, "SELECT COUNT(*) FROM pm_idp_goals WHERE manager_comment IS NOT NULL") == 0)
s.check("an empty value is refused",
        tool("set_goal_field", {"goal_id": G1, "field": "area", "value": ""}).get("ok") is False)
s.check("a made-up goal_id is refused",
        tool("set_goal_field", {"goal_id": 999999, "field": "area", "value": "x"}).get("ok") is False)
s.check("ANOTHER PERSON's goal is refused -- scoped to this plan, not to the posted id",
        tool("set_goal_field", {"goal_id": OTHER_GOAL, "field": "area",
                                "value": "hijacked"}).get("ok") is False)
s.check("...and their goal is untouched",
        H.one(a, "SELECT area FROM pm_idp_goals WHERE id=?", (OTHER_GOAL,)) == "Their own goal")
s.check("a non-numeric goal_id is refused",
        tool("set_goal_field", {"goal_id": "abc", "field": "area", "value": "x"}).get("ok") is False)

# ---------------------------------------------------------------------------
s.section("the read-only tools write nothing")
_snap = H.one(a, "SELECT COUNT(*) FROM pm_idp_goals")
rg = tool("show_gaps", {})
s.check("show_gaps renders a card", rg.get("ok") is True
        and rg.get("render", {}).get("type") == "idp_gaps", rg)
rp = tool("show_plan", {})
s.check("show_plan renders a card", rp.get("ok") is True
        and rp.get("render", {}).get("type") == "idp_plan", rp)
s.check("...neither wrote anything", H.one(a, "SELECT COUNT(*) FROM pm_idp_goals") == _snap)

# ---------------------------------------------------------------------------
s.section("prepare_submit -- render-only, and blocked until the plan is complete")
with a.app.app_context():
    a.set_idp_settings("any", 2, 6, True)     # demand two goals, one action each
pp = tool("prepare_submit", {})
s.check("blocked while the plan is short of the minimum",
        pp.get("ok") is False and "not ready" in (pp.get("error") or ""), pp)
s.check("...and it WROTE NOTHING", status() == "draft" and goal_count() == 1)

# THE POINT OF THE EXTRACTION: the page and the chat read ONE gate.
E = H.client_as(a, SUBJ["id"])
r_page = post(E, "/idp/submit")
s.check("the /idp page refuses the same plan", status() == "draft", status())
with a.app.app_context():
    errs, _filled = a.pm_idp_share_validate(my_idp())
s.check("...and the chat's refusal names the SAME problems the gate does",
        all(e.split(":")[0][:20] in (pp.get("error") or "") or e[:20] in (pp.get("error") or "")
            for e in errs[:1]), (errs, pp.get("error")))
s.check("the shared gate reports at least one error here", len(errs) >= 1, errs)

r = tool("add_goal", {"area": "Financial literacy"})
G2 = r.get("goal_id")
tool("set_goal_field", {"goal_id": G2, "field": "action_education",
                        "value": "Finish the CFO-office finance-for-non-finance course"})
with a.app.app_context():
    errs2, _f2 = a.pm_idp_share_validate(my_idp())
s.check("with two complete goals the shared gate is clean", errs2 == [], errs2)
# SHARING LOCKS THE PROFILE TOO (2026-09-28), so a plan shared with "where you want to go" / "how far you'd move"
# still blank could never be finished -- those two answers come first, on every share path.
with a.app.app_context():
    _db0 = a.get_db()
    _db0.execute("UPDATE pm_career_profile SET mobility=NULL, aspiration_now=NULL, aspiration_mid=NULL, "
                 "aspiration_long=NULL WHERE subject_id=?", (SUBJ["id"],))
    _db0.commit()
_pp0 = tool("prepare_submit", {})
s.check("with the goals complete but the career profile blank, prepare_submit refuses (sharing would lock it blank)",
        _pp0.get("ok") is False and a.PM_IDP_SHARE_PROFILE_ERROR in (_pp0.get("error") or ""), _pp0)
_r0 = post(E, "/review/ahead/submit")
s.check("...and the Share route refuses it too, leaving the plan in draft",
        _r0.status_code == 400 and status() == "draft", (_r0.status_code, status()))
with a.app.app_context():
    _okm = a.pm_career_save_field(a.get_db(), SUBJ["id"], "aspiration_mid", "Regional finance lead")
    _okb = a.pm_career_save_field(a.get_db(), SUBJ["id"], "mobility", "same_company")
s.check("...where they want to go and how far they'd move are saved first", _okm[0] and _okb[0], (_okm, _okb))
_snap2 = goal_count()
pp2 = tool("prepare_submit", {})
s.check("prepare_submit is ready and renders the Share card",
        pp2.get("ok") is True and pp2.get("ready") is True
        and pp2.get("render", {}).get("type") == "idp_confirm", pp2)
s.check("...and STILL wrote nothing", status() == "draft" and goal_count() == _snap2)

# ---------------------------------------------------------------------------
s.section("the human Share is the only share")
s.check("no tool can share",
        not any(k for k in a._IDP_TOOLS if "share" in k or k == "submit"), list(a._IDP_TOOLS))
rok = post(E, "/review/ahead/submit")
j = rok.get_json()
s.check("a complete plan shares", rok.status_code == 200 and j.get("submitted") is True, j)
s.check("...status flipped to 'shared'", status() == "shared")
# Sharing LOCKS the plan (Chris, 2026-09-28: "lock the career plan once user agrees and click the final submit
# button") -- goals AND the career profile that goes with it.
_lk = tool("set_goal_field", {"goal_id": G2, "field": "target_date", "value": "2027-06-30"})
s.check("...and sharing LOCKS it: a goal edit is refused, and says it is shared and locked",
        _lk.get("ok") is False and "locked" in (_lk.get("error") or ""), _lk)
with a.app.app_context():
    _okp, _errp = a.pm_career_save_field(a.get_db(), SUBJ["id"], "aspiration_long", "A new line after sharing")
s.check("...the career profile is locked with it (the one profile write path refuses)",
        _okp is False and "locked" in (_errp or ""), (_okp, _errp))
with a.app.test_request_context("/"):
    _cpd = a._career_plan_overview_data(a.get_db(), dict(a.get_db().execute(
        "SELECT * FROM users WHERE id=?", (SUBJ["id"],)).fetchone()))
s.check("...and the Career Plan widget's payload says locked", _cpd.get("locked") is True, _cpd.get("locked"))
_rs2 = post(E, "/review/ahead/submit")
# A second Share (a double Confirm in the pop-up, 2026-09-29) is harmless: ok, already, and the locked Career Plan
# payload to lock the card from -- it never re-shares or changes anything.
_rs2j = _rs2.get_json() or {}
s.check("...sharing again is harmless: ok + already, the plan stays shared and locked",
        _rs2.status_code == 200 and _rs2j.get("already") is True
        and (_rs2j.get("career_plan") or {}).get("locked") is True, (_rs2.status_code, _rs2j.get("already")))

# Sharing checks only the goals (review, 2026-09-25): with "where you want to go" / "how far you'd move" still open,
# the server's post-share reply points to them -- never "that's everything in your review done".
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("UPDATE pm_career_profile SET mobility=NULL, aspiration_now=NULL, aspiration_mid=NULL, "
               "aspiration_long=NULL WHERE subject_id=?", (SUBJ["id"],))
    db.commit()
    _u = dict(db.execute("SELECT * FROM users WHERE id=?", (SUBJ["id"],)).fetchone())
    _st = a.review_state(db, _u)
    _cp = next((x for x in a._journey_live_stages(_st) if x["key"] == "career_plan"), None)
    _say, _qr = a._journey_after_signoff_reply(db, _u, _st, "career_plan",
                                               {"type": "idp_confirm",
                                                "done": "Done -- your development plan is shared with your manager."})
s.check("after a share with the profile still open, the reply names what's left in the Career Plan (not 'all done')",
        _cp is not None and _cp["state"] == a.REVIEW_STATE_OPEN and "To finish your Career Plan" in _say
        and "How far you'd move" in _say and "everything in your review" not in _say and _qr == [],
        (_cp and _cp["state"], _say, _qr))
# A plan that is short must be refused by the ROUTE too, not only by the card.
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE pm_idp SET status='draft' WHERE plan_year=? AND subject_id=?",
               (PLAN_YEAR, SUBJ["id"]))
    db.execute("DELETE FROM pm_idp_goals WHERE id=?", (G2,))
    db.commit()
rbad = post(E, "/review/ahead/submit")
s.check("the Share route refuses an incomplete plan itself", rbad.status_code == 400, rbad.status_code)
s.check("...and left it in draft", status() == "draft")
with a.app.app_context():
    a.set_idp_settings("any", 1, 6, True)     # back to the defaults for the rest
    # the profile is filled in again (the check above blanked it), so the later shares aren't refused on it
    a.pm_career_save_field(a.get_db(), SUBJ["id"], "aspiration_mid", "Regional finance lead")
    a.pm_career_save_field(a.get_db(), SUBJ["id"], "mobility", "same_company")

# ---------------------------------------------------------------------------
s.section("DEMO ONLY -- a ZZ account stays editable outside the authoring period")
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE users SET employee_id='ZZIDPDEMO-1' WHERE id=?", (OTHER["id"],))
    db.commit()
    zz = dict(db.execute("SELECT * FROM users WHERE id=?", (OTHER["id"],)).fetchone())
s.check("a ZZ demo account is editable even outside the authoring window",
        a._idp_self_editable(zz, None, False) is True)
s.check("a REAL account is NOT editable outside it",
        a._idp_self_editable(SUBJ, None, False) is False)
s.check("...and a real CLOSED plan is not editable even inside it",
        a._idp_self_editable(SUBJ, {"status": "closed"}, True) is False)
s.check("...a real SHARED plan is locked inside the window too (2026-09-28)",
        a._idp_self_editable(SUBJ, {"status": "shared"}, True) is False)
s.check("...and the ZZ override skips the window, never the lock: a ZZ shared plan is locked",
        a._idp_self_editable(zz, {"status": "shared"}, False) is False
        and a._idp_self_editable(zz, {"status": "draft"}, False) is True)
s.check("...a tool works on the ZZ account with authoring off",
        tool("set_goal_field", {"goal_id": OTHER_GOAL, "field": "area",
                                "value": "Their own goal, edited"},
             uid=OTHER["id"]).get("ok") is True)

# ---------------------------------------------------------------------------
s.section("the AI switch -- IDP has its own, and the page must not strand anyone")
with a.app.app_context():
    _real_avail = ai_draft.review_agent_available
    ai_draft.review_agent_available = lambda: True
    try:
        a.set_idp_settings("any", 1, 6, False)      # IDP's own AI checkbox OFF
        s.check("with IDP's own AI switch off the agent is not ready",
                a._idp_agent_ready() is False)
        a.set_idp_settings("any", 1, 6, True)
        s.check("...and on again it is", a._idp_agent_ready() is True)
    finally:
        ai_draft.review_agent_available = _real_avail
    a.set_idp_settings("any", 1, 6, False)
E2 = H.client_as(a, SUBJ["id"])
rr = E2.get("/review/ahead")
s.check("the chat page REDIRECTS to /idp rather than rendering a dead chat",
        rr.status_code in (301, 302) and "/idp" in rr.headers.get("Location", ""),
        (rr.status_code, rr.headers.get("Location")))
with a.app.app_context():
    a.set_idp_settings("any", 1, 6, True)

# ...and with both switches on the page renders the chat shell itself.
_avail0 = ai_draft.review_agent_available
ai_draft.review_agent_available = lambda: True
# the standalone chat is what someone gets when the AI+ way is OFF for them (it is on for everyone by default since
# 2026-10-08, and then this page goes to the journey's Career Plan) -- so switch it off for this section
with a.app.app_context():
    _ru0 = (a.get_db().execute("SELECT value FROM app_settings WHERE key='review_unified'").fetchone() or [None])[0]
    a.get_db().execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', '0')")
    a.get_db().commit()
try:
    rp = H.client_as(a, SUBJ["id"]).get("/review/ahead")
    body = rp.get_data(as_text=True)
    s.check("with the assistant on, the chat page renders", rp.status_code == 200, rp.status_code)
    s.check("...wired to its own client and endpoints",
            "ahead_chat.js" in body and "/review/ahead/chat" in body
            and "/review/ahead/submit" in body)
finally:
    ai_draft.review_agent_available = _avail0
    with a.app.app_context():
        if _ru0 is None:
            a.get_db().execute("DELETE FROM app_settings WHERE key='review_unified'")
        else:
            a.get_db().execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', ?)", (_ru0,))
        a.get_db().commit()

# ---------------------------------------------------------------------------
s.section("the agent loop -- a stubbed model proposes, the server executes")
_avail, _agent = ai_draft.review_agent_available, ai_draft.review_agent
SCRIPT = []


def stub_agent(system, messages, timeout=90):
    return SCRIPT.pop(0)


ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = stub_agent
try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_idp_chat WHERE subject_id=?", (SUBJ["id"],))
        db.commit()
    E = H.client_as(a, SUBJ["id"])
    SCRIPT[:] = [
        {"say": "Adding that.", "quick_replies": [],
         "action": {"tool": "add_goal", "args": {"area": "Coaching my team"}}},
        {"say": "Added — what could you do on the job for it?",
         "quick_replies": ["Lead a project", "Mentor someone"], "action": None},
    ]
    resp = post(E, "/review/ahead/chat", message="I want to get better at coaching").get_json()
    s.check("the loop ran the tool then returned the final say",
            resp.get("say", "").startswith("Added"), resp)
    s.check("...the proposed goal actually landed",
            any((g["area"] or "") == "Coaching my team" for g in goals()))
    s.check("...a live plan overview comes back",
            resp.get("overview") and resp["overview"]["total"] >= 1, resp.get("overview"))
    s.check("...and a fresh rail for the live update", "rail_html" in resp)
    s.check("the transcript persisted to pm_idp_chat",
            H.one(a, "SELECT COUNT(*) FROM pm_idp_chat WHERE subject_id=?", (SUBJ["id"],)) >= 2)

    # The overview FOCUS follows the first unfinished goal, so the widget can track
    # the conversation rather than making the person page to it.
    with a.app.test_request_context("/"):
        ov = a._idp_overview(a.get_db(), SUBJ)["data"]
    _unready = [g for g in ov["goals"] if not g["ready"]]
    s.check("the focus is the first unfinished goal",
            (not _unready) or ov["focus_goal_id"] == _unready[0]["goal_id"],
            (ov.get("focus_goal_id"), [g["goal_id"] for g in _unready]))

    # A Share card is TERMINAL: two prepare_submit turns must yield ONE card, not two.
    # Finish the goal the agent just added first -- an incomplete plan makes
    # prepare_submit refuse (correctly), which is a different code path.
    _coach = next(g for g in goals() if (g["area"] or "") == "Coaching my team")
    tool("set_goal_field", {"goal_id": _coach["id"], "field": "action_exposure",
                            "value": "Sit in on Aida's coaching conversations"})
    with a.app.app_context():
        s.check("the plan is complete before the terminal-card check",
                a.pm_idp_share_validate(my_idp())[0] == [],
                a.pm_idp_share_validate(my_idp())[0])
    SCRIPT[:] = [
        {"say": "Ready to share.", "quick_replies": [],
         "action": {"tool": "prepare_submit", "args": {}}},
        {"say": "Ready again.", "quick_replies": [],
         "action": {"tool": "prepare_submit", "args": {}}},
    ]
    rs = post(E, "/review/ahead/chat", message="share it").get_json()
    _cards = [x for x in (rs.get("renders") or []) if x.get("type") == "idp_confirm"]
    s.check("prepare_submit renders EXACTLY ONE card (no duplicate stacking)",
            len(_cards) == 1, len(_cards))
    s.check("...the second prepare_submit turn was never consumed (the loop broke)",
            len(SCRIPT) == 1, len(SCRIPT))
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _avail, _agent

# ---------------------------------------------------------------------------
s.section("degradation -- no model reachable, an honest reply not a broken chat")
E = H.client_as(a, SUBJ["id"])
resp = post(E, "/review/ahead/chat", message="hi").get_json()
s.check("with no model configured the chat degrades honestly (done=True)",
        resp.get("done") is True and "isn't switched on" in resp.get("say", ""), resp)
# ABSENT IS NOT EMPTY. Found in preview QC: a degraded turn returned no overview
# key, the client read that as "nothing to show" and wiped the pinned plan and the
# floating card off the screen on a transient model error. Every exit from the
# chat route now carries an overview, so the widget survives a hiccup.
s.check("...and a degraded turn STILL carries an overview", "overview" in resp, list(resp))
_avail1, _agent1 = ai_draft.review_agent_available, ai_draft.review_agent


def _boom(system, messages, timeout=90):
    raise ai_draft.AIDraftError("simulated transient failure")


ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = _boom
try:
    rerr = post(H.client_as(a, SUBJ["id"]), "/review/ahead/chat", message="hi").get_json()
    s.check("a model ERROR mid-conversation says so", "lost the thread" in rerr.get("say", ""), rerr)
    s.check("...and STILL carries an overview, so the widget is not wiped",
            "overview" in rerr, list(rerr))
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _avail1, _agent1
# The client half of the same guard.
_js = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                        "static", "ahead_chat.js"), encoding="utf-8").read()
s.check("the client ignores an ABSENT overview rather than clearing on it",
        "if (data === undefined) return;" in _js)

sys.exit(s.done())
