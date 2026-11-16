"""The conversational CAREER (IDP) agent -- the career profile (2026-09-04). Same
contract as the plan / competency / setting / check-in agents: the MODEL converses
and proposes; these tools VALIDATE and perform every write.

The structural difference this file exists to pin down: there is NO SUBMIT. The
profile has no status column and no approval gate by design, so there must be no
prepare_* tool, no `ready` card and no submit route -- the completion predicate is
pm_career_is_complete() and nothing ever locks.

Also asserts the ONE write path: pm_career_save_field() is what the page's autosave,
the check-in agent's save_career and this agent's set_field all go through, so the
same answer cannot be stored two different ways depending on the surface.

Writes (pm_career_profile), so a fresh copy.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
s = H.Suite("Career agent -- a living document, no submit anywhere")
SU, _BG, _EMP = H.actors(a)


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


# ---------------------------------------------------------------------------
s.section("build")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','idp')")
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))   # the Career Plan is Year-End only (2026-09-28)
    us = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                    "ORDER BY id LIMIT 2").fetchall()
    SUBJ, OTHER = dict(us[0]), dict(us[1])
    db.commit()


def tool(name, args, uid=None):
    uid = uid or SUBJ["id"]
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return a._career_run_tool(db, dict(u), CID, {"tool": name, "args": args})


def field(name, uid=None):
    return H.one(a, "SELECT %s FROM pm_career_profile WHERE subject_id=?" % name,
                 (uid or SUBJ["id"],))


def complete():
    with a.app.app_context():
        return a.pm_career_is_complete(a.get_db(), SUBJ["id"])


# ---------------------------------------------------------------------------
s.section("set_field -- free text saved as given, mobility from a controlled list")
r = tool("set_field", {"field": "aspiration_mid", "value": "Lead a regional finance team"})
s.check("a free-text horizon saves", r.get("ok") is True, r)
s.check("...stored verbatim", field("aspiration_mid") == "Lead a regional finance team")
s.check("...and the row was created on demand",
        H.one(a, "SELECT COUNT(*) FROM pm_career_profile WHERE subject_id=?", (SUBJ["id"],)) == 1)

s.check("an unknown field is refused",
        tool("set_field", {"field": "salary", "value": "more"}).get("ok") is False)
s.check("a column that exists but is NOT a profile field is refused",
        tool("set_field", {"field": "manager_comment", "value": "sneaky"}).get("ok") is False)
s.check("...and the manager's column is untouched",
        H.one(a, "SELECT COUNT(*) FROM pm_career_profile WHERE manager_comment IS NOT NULL") == 0)
s.check("an empty value is refused",
        tool("set_field", {"field": "strengths", "value": "  "}).get("ok") is False)

s.check("free-text mobility is REFUSED -- it is the one countable field",
        tool("set_field", {"field": "mobility", "value": "anywhere really"}).get("ok") is False)
s.check("...and nothing was written", field("mobility") is None)
rm = tool("set_field", {"field": "mobility", "value": "within_bg"})
s.check("a valid mobility key saves", rm.get("ok") is True, rm)
s.check("...stored as the key, not the label", field("mobility") == "within_bg")

# ---------------------------------------------------------------------------
s.section("completion is the module's own predicate, and nothing locks")
s.check("mobility + one aspiration makes it complete", complete() is True)
s.check("...and the tool reports it back to the model", rm.get("complete") is True)
s.check("a COMPLETE profile is still editable -- it is a living document",
        tool("set_field", {"field": "aspiration_long",
                           "value": "Run a business unit"}).get("ok") is True)
_cols = [r[1] for r in H.rows(a, "PRAGMA table_info(pm_career_profile)")]
s.check("there is no status column to lock, and none to submit into",
        "status" not in _cols and "submitted_at" not in _cols, _cols)

# ---------------------------------------------------------------------------
s.section("THE POINT: no submit exists anywhere on this stage")
s.check("no tool can submit, share or propose",
        not [k for k in a._CAREER_TOOLS
             if any(w in k for w in ("submit", "share", "propose", "confirm"))],
        list(a._CAREER_TOOLS))
s.check("no tool returns a terminal `ready` card",
        not any((tool(k, {}) or {}).get("ready") for k in a._CAREER_TOOLS if k.startswith("show")))
_eps = [r.endpoint for r in a.app.url_map.iter_rules() if str(r.rule).startswith("/review/career")]
s.check("no /review/career submit route exists",
        not [e for e in _eps if "submit" in e], _eps)
E = H.client_as(a, SUBJ["id"])
s.check("...and the URL simply is not there", E.post("/review/career/submit",
                                                     data={"csrf_token": "tok"}).status_code == 404)

# ---------------------------------------------------------------------------
s.section("ONE write path -- the page, the check-in agent and this agent agree")
# pm_career_save_field is the shared authority. The check-in agent's save_career
# tool and the profile page's autosave both route through it, so a value written
# from any surface lands identically. This is what closed the 2000 vs 4000 cap split.
long_text = "x" * 5000
tool("set_field", {"field": "preferences", "value": long_text})
via_tool = field("preferences")
post(E, "/idp/career/autosave", field="preferences", value=long_text)
via_page = field("preferences")
s.check("the agent and the page store the SAME thing for the same input",
        via_tool == via_page, (len(via_tool or ""), len(via_page or "")))
s.check("...capped at the page's 4000, not the tool's old 2000", len(via_page) == 4000,
        len(via_page or ""))
s.check("the page still refuses an unknown field",
        post(E, "/idp/career/autosave", field="nope", value="x").status_code == 400)
s.check("the page still refuses a bad mobility value",
        post(E, "/idp/career/autosave", field="mobility", value="anywhere").status_code == 400)

# ---------------------------------------------------------------------------
s.section("the read-only tools")
_snap = field("aspiration_mid")
rp = tool("show_profile", {})
s.check("show_profile renders a card", rp.get("ok") is True
        and rp.get("render", {}).get("type") == "career_profile", rp)
s.check("...and wrote nothing", field("aspiration_mid") == _snap)
rr = tool("show_routes", {})
s.check("show_routes answers (a card, or an honest refusal with no job profile)",
        rr.get("ok") is True or "job profile" in (rr.get("error") or ""), rr)

# ---------------------------------------------------------------------------
s.section("the overview follows the conversation")
with a.app.test_request_context("/"):
    ov = a._career_overview(a.get_db(), SUBJ)["data"]
s.check("three sections", [x["key"] for x in ov["sections"]]
        == ["aspirations", "mobility", "strengths"], [x["key"] for x in ov["sections"]])
s.check("mobility shows its LABEL, not the stored key",
        any(it["value"] == "Open to another company in my BG"
            for sec in ov["sections"] for it in sec["items"] if it["field"] == "mobility"),
        [it for sec in ov["sections"] for it in sec["items"] if it["field"] == "mobility"])
s.check("...and offers the controlled choices for the widget",
        any(it["choices"] for sec in ov["sections"] for it in sec["items"]
            if it["field"] == "mobility"))
_un = [(sec["key"], it["field"]) for sec in ov["sections"] for it in sec["items"]
       if not it["answered"]]
s.check("the focus is the first unanswered field",
        (not _un) or (ov["focus_section"], ov["focus_field"]) == _un[0],
        (ov.get("focus_section"), ov.get("focus_field"), _un[:1]))

# ---------------------------------------------------------------------------
s.section("the page renders, and degrades to the profile page when AI is off")
_avail0 = ai_draft.review_agent_available
ai_draft.review_agent_available = lambda: True
# the standalone chat is what someone gets when the AI+ way is OFF for them (it is on for everyone by default since
# 2026-10-08, and then this page goes to the journey's Career Plan) -- so switch it off for this section
with a.app.app_context():
    _ru0 = (a.get_db().execute("SELECT value FROM app_settings WHERE key='review_unified'").fetchone() or [None])[0]
    a.get_db().execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', '0')")
    a.get_db().commit()
try:
    with a.app.app_context():
        a.set_idp_settings("any", 1, 6, True)
    rp2 = H.client_as(a, SUBJ["id"]).get("/review/career")
    body = rp2.get_data(as_text=True)
    s.check("with the assistant on, the chat page renders", rp2.status_code == 200, rp2.status_code)
    s.check("...wired to its own client", "career_chat.js" in body and "/review/career/chat" in body)
    s.check("...and carries NO submit url", "data-submit-url" not in body)
    with a.app.app_context():
        a.set_idp_settings("any", 1, 6, False)
    rp3 = H.client_as(a, SUBJ["id"]).get("/review/career")
    s.check("with IDP's own AI switch off it redirects to the profile page",
            rp3.status_code in (301, 302) and "/idp/career" in rp3.headers.get("Location", ""),
            (rp3.status_code, rp3.headers.get("Location")))
finally:
    ai_draft.review_agent_available = _avail0
    with a.app.app_context():
        if _ru0 is None:
            a.get_db().execute("DELETE FROM app_settings WHERE key='review_unified'")
        else:
            a.get_db().execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', ?)", (_ru0,))
        a.get_db().commit()
    with a.app.app_context():
        a.set_idp_settings("any", 1, 6, True)

# ---------------------------------------------------------------------------
s.section("the agent loop -- a stubbed model proposes, the server executes")
_avail, _agent = ai_draft.review_agent_available, ai_draft.review_agent
SCRIPT = []


def stub_agent(system, messages, timeout=90):
    return SCRIPT.pop(0)


ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = stub_agent
try:
    E = H.client_as(a, SUBJ["id"])
    SCRIPT[:] = [
        {"say": "Noting that.", "quick_replies": [],
         "action": {"tool": "set_field",
                    "args": {"field": "mentor", "value": "Our group financial controller"}}},
        {"say": "Good — that's someone worth learning from.",
         "quick_replies": ["Tell me more", "Next"], "action": None},
    ]
    resp = post(E, "/review/career/chat", message="I'd like to learn from the GFC").get_json()
    s.check("the loop ran the tool then returned the final say",
            resp.get("say", "").startswith("Good"), resp)
    s.check("...the proposed answer actually landed",
            field("mentor") == "Our group financial controller")
    s.check("...a live profile overview comes back",
            resp.get("overview") and resp["overview"]["total"] > 0, resp.get("overview"))
    s.check("...and a fresh rail for the live update", "rail_html" in resp)
    s.check("the transcript persisted to pm_career_chat",
            H.one(a, "SELECT COUNT(*) FROM pm_career_chat WHERE subject_id=?", (SUBJ["id"],)) >= 2)
    s.check("...in its OWN table, not the plan's",
            H.one(a, "SELECT COUNT(*) FROM pm_idp_chat WHERE subject_id=?", (SUBJ["id"],)) == 0)

    # A refused tool comes back to the model as an error it can relay, not a 500.
    SCRIPT[:] = [
        {"say": "Saving.", "quick_replies": [],
         "action": {"tool": "set_field", "args": {"field": "mobility", "value": "wherever"}}},
        {"say": "Which of these fits best?",
         "quick_replies": ["Happy where I am"], "action": None},
    ]
    r2 = post(E, "/review/career/chat", message="anywhere").get_json()
    s.check("a refused write is relayed, not raised",
            r2.get("say", "").startswith("Which"), r2)
    s.check("...and mobility kept its earlier valid value", field("mobility") == "within_bg")
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _avail, _agent

# ---------------------------------------------------------------------------
s.section("DEMO ONLY -- the ONE ZZ reset empties the profile without deleting the row")
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE users SET employee_id='ZZCARDEMO-1' WHERE id=?", (SUBJ["id"],))
    db.commit()
Z = H.client_as(a, SUBJ["id"])
# The five per-stage demo resets collapsed into one review_demo_reset_all (2026-09-05).
post(Z, "/review/demo/reset-all")
s.check("every field is cleared", field("aspiration_mid") is None and field("mobility") is None)
s.check("...the row itself survives (nothing left dangling)",
        H.one(a, "SELECT COUNT(*) FROM pm_career_profile WHERE subject_id=?", (SUBJ["id"],)) == 1)
s.check("...the conversation is cleared too",
        H.one(a, "SELECT COUNT(*) FROM pm_career_chat WHERE subject_id=?", (SUBJ["id"],)) == 0)
s.check("...and the stage is no longer complete", complete() is False)
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE users SET employee_id='REAL-1' WHERE id=?", (SUBJ["id"],))
    db.commit()
s.check("a NON-ZZ account cannot reach the reset at all",
        H.client_as(a, SUBJ["id"]).post("/review/demo/reset-all",
                                        data={"csrf_token": "tok"}).status_code == 404)

# ---------------------------------------------------------------------------
s.section("degradation -- no model reachable, an honest reply not a broken chat")
E = H.client_as(a, SUBJ["id"])
resp = post(E, "/review/career/chat", message="hi").get_json()
s.check("with no model configured the chat degrades honestly (done=True)",
        resp.get("done") is True and "isn't switched on" in resp.get("say", ""), resp)
# ABSENT IS NOT EMPTY -- see the same pair of checks in test_idp_agent.py.
s.check("...and a degraded turn STILL carries an overview", "overview" in resp, list(resp))
_avail1, _agent1 = ai_draft.review_agent_available, ai_draft.review_agent


def _boom(system, messages, timeout=90):
    raise ai_draft.AIDraftError("simulated transient failure")


ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = _boom
try:
    rerr = post(H.client_as(a, SUBJ["id"]), "/review/career/chat", message="hi").get_json()
    s.check("a model ERROR mid-conversation says so", "lost the thread" in rerr.get("say", ""), rerr)
    s.check("...and STILL carries an overview, so the widget is not wiped",
            "overview" in rerr, list(rerr))
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _avail1, _agent1
_js = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                        "static", "career_chat.js"), encoding="utf-8").read()
s.check("the client ignores an ABSENT overview rather than clearing on it",
        "if (data === undefined) return;" in _js)

# ---------------------------------------------------------------------------
s.section("AI-assisted onboarding: real-roles-only direction + whole-plan draft (2026-09-14)")
s.check("show_directions / set_direction / draft_plan are wired into career_plan",
        all(k in a._JOURNEY_STAGE_TOOLS["career_plan"]
            for k in ("show_directions", "set_direction", "draft_plan")),
        list(a._JOURNEY_STAGE_TOOLS["career_plan"]))

ZBG = "ZZ Career Test BG"
# The demo career ladder must come from the JOB ARCHITECTURE (tc_job_profiles tagged
# _CAREER_DEMO_SOURCE), never a hardcoded or AI list. Seed a small Sales-Operations ladder
# + cross-function roles INTO the architecture with real required skills, then assert the ZZ
# picker reads THOSE profiles.
with a.app.app_context():
    db = a.get_db()

    def _mk(eid, title, grade, dept="Sales Operations"):
        return db.execute(
            "INSERT INTO users(username, full_name, password_hash, role, employee_id, "
            "business_group, company, department, job_title, job_grade) "
            "VALUES (?,?,'x','user',?,?,?,?,?,?)",
            (eid, eid, eid, ZBG, "ZZ Co", dept, title, grade)).lastrowid
    ZEMP = _mk("ZZCT-EMP", "Assistant Manager", 15)   # JG15 persona, dept Sales Operations
    ZLOW = _mk("ZZCT-LOW", "Junior Executive", 14)    # a grade lower -> the JG17 role caps out

    def _skill(code, title):
        return db.execute("INSERT INTO tc_skills(skill_code, title, level, active) "
                          "VALUES (?,?,3,1)", (code, title)).lastrowid
    SK1 = _skill("ZZC-SK-1", "Demand Planning")
    SK2 = _skill("ZZC-SK-2", "Commercial Negotiation")
    SK3 = _skill("ZZC-SK-3", "Customer Account Management")

    def _prof(dept, title, grade, skills):
        pid = db.execute(
            "INSERT INTO tc_job_profiles(department, job_title, job_grade, source, active) "
            "VALUES (?,?,?,?,1)", (dept, title, grade, a._CAREER_DEMO_SOURCE)).lastrowid
        for i, sk in enumerate(skills):
            db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, sort_order) "
                       "VALUES (?,?,?)", (pid, sk, i))
        return pid
    _prof("Sales Operations", "Assistant Manager", "15", [SK1])              # own role -> excluded
    P_MGR = _prof("Sales Operations", "Manager, Sales Operations", "16", [SK1, SK2])   # grow +1
    _prof("Sales Operations", "Senior Manager, Sales Operations", "17", [SK1, SK2])    # grow +2
    _prof("Commercial Planning", "Manager, Commercial Planning", "16", [SK1])          # switch +1
    _prof("Customer Service", "Customer Service Manager", "16", [SK3])                 # switch +1
    _prof("Sales Operations", "General Manager, Sales", "19", [SK2])                   # +4 -> capped out
    db.commit()


def with_ctx_career(uid, fn):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
        return fn(db, u)


def jtool(name, args, uid):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return a._journey_run_stage_tool(db, dict(u), CID, "career_plan",
                                         {"tool": name, "args": args})


# --- the roles come from the architecture: real profile_id, real competencies, capped +/-2 ---
with a.app.app_context():
    db = a.get_db()
    zemp = db.execute("SELECT * FROM users WHERE id=?", (ZEMP,)).fetchone()
    zlow = db.execute("SELECT * FROM users WHERE id=?", (ZLOW,)).fetchone()
    cand = a._career_candidate_roles(db, dict(zemp))
    cand_low = a._career_candidate_roles(db, dict(zlow))
    subj_cand = a._career_candidate_roles(db, SUBJ)
    demo_ids = {r["id"] for r in db.execute(
        "SELECT id FROM tc_job_profiles WHERE source=?", (a._CAREER_DEMO_SOURCE,))}
    mgr_comps = a._profile_skill_titles(db, P_MGR)
_lane = {r["title"]: r["lane"] for r in cand["roles"]}
s.check("a ZZ account's roles ALL come from the job architecture (real profile_id, source demo)",
        cand["source"] == "demo" and len(cand["roles"]) >= 3
        and all(r.get("profile_id") in demo_ids for r in cand["roles"]), cand)
s.check("...capped to within 2 grades of JG15 (JG16-17; the JG19 role dropped)",
        all(16 <= a._jg_rank(r["grade"]) <= 17 for r in cand["roles"])
        and "General Manager, Sales" not in _lane, cand)
s.check("...Column 2 is the profile's REAL required competencies (no AI, no summary)",
        any(r["title"] == "Manager, Sales Operations"
            and r.get("competencies") == mgr_comps and not r.get("summary")
            for r in cand["roles"]), mgr_comps)
s.check("...lane = grow within the person's own department, switch across functions",
        _lane.get("Manager, Sales Operations") == "grow"
        and _lane.get("Customer Service Manager") == "switch", _lane)
s.check("from a grade lower (JG14) the JG17 role is capped out",
        cand_low["roles"] and "Senior Manager, Sales Operations"
        not in {r["title"] for r in cand_low["roles"]}, cand_low)
s.check("a real account with no job profile has NO candidate roles (never invented)",
        subj_cand["roles"] == [] and subj_cand["source"] == "none", subj_cand)

rd = jtool("show_directions", {}, ZEMP)
s.check("show_directions renders the architecture roles + source, each with a real profile_id",
        rd.get("render", {}).get("type") == "career_direction"
        and rd["render"]["data"]["source"] == "demo"
        and all(r.get("profile_id") in demo_ids for r in rd["render"]["data"]["roles"]), rd)
s.check("...no AI on the card: no `ai` flag, Column 2 carries real competencies",
        all("ai" not in r and (r.get("competencies") or []) for r in rd["render"]["data"]["roles"]),
        rd["render"]["data"]["roles"][:1])

with a.app.test_request_context("/"):
    from flask import session as _ts
    _ts["user_id"] = ZEMP
    _db = a.get_db()
    _zu = _db.execute("SELECT * FROM users WHERE id=?", (ZEMP,)).fetchone()
    # The auto-draft opener is only promised when a draft can run -- switch the model on for this prompt.
    _wic = ai_draft.is_configured
    ai_draft.is_configured = lambda: True
    try:
        task = a._journey_career_plan_task(_db, dict(_zu))
    finally:
        ai_draft.is_configured = _wic
    task_nodraft = a._journey_career_plan_task(_db, dict(_zu))
s.check("the task prompt drives the section arc + explains the auto-draft opener",
        "CAREER PATH" in task and "DEVELOPMENT GAPS" in task and "CAREER PROFILE" in task
        and "AUTO-DRAFT" in task, None)
s.check("...and with no model configured it promises no auto-draft (builds the three items with them)",
        "AUTO-DRAFT" not in task_nodraft and "do NOT promise to auto-draft" in task_nodraft, None)
s.check("...names the architecture candidate roles and forbids inventing one",
        "Manager, Sales Operations" in task and "NEVER" in task and "not in that list" in task, None)
# 2026-09-18 (Chris): the plan's Share is a SIGN-OFF -- once complete, offer prepare_submit and
# gently invite the Share; do not just say "all done"; never force it; deferrable.
_tl = task.lower()
s.check("career plan: building/saving is framed as NOT finishing (share is the sign-off)",
        "building or saving the plan is not the same as finishing it" in _tl
        and "next step is prepare_submit()" in _tl, None)
s.check("career plan: the Share is offered (not just 'all done'), gentle and deferrable",
        "do not just say 'all done' without offering the share" in _tl
        and "never force it" in _tl and "come back to it later" in _tl, None)

# --- then the writes ---
rs = jtool("set_direction", {"choice": "Manager, Sales Operations"}, ZEMP)
s.check("set_direction accepts a REAL architecture role", rs.get("ok") is True, rs)
s.check("...and stores its target_profile_id (a real architecture row), not free text",
        field("target_profile_id", ZEMP) == P_MGR, field("target_profile_id", ZEMP))
s.check("set_direction REFUSES a role not in the architecture (no invented role can be stored)",
        jtool("set_direction", {"choice": "Chief of Everything"}, ZEMP).get("ok") is False)
s.check("set_direction REFUSES an out-of-band role (the 2-grade cap flows to the pick)",
        jtool("set_direction",
              {"choice": "Senior Manager, Sales Operations"}, ZLOW).get("ok") is False)
s.check("set_direction 'explore' is allowed and names no role",
        jtool("set_direction", {"choice": "explore"}, ZEMP).get("direction") == "explore")

# ---------------------------------------------------------------------------
s.section("career direction: grade cap unit, has_direction gate, AI Column-2 (Chris, 2026-09-17)")
_roles = [{"title": "A", "grade": 15}, {"title": "B", "grade": 16}, {"title": "C", "grade": 17},
          {"title": "D", "grade": 18}, {"title": "E", "grade": 14}]
s.check("_career_cap_grades keeps roles within +2 grades (drops >2 up and any below)",
        sorted(r["grade"] for r in a._career_cap_grades(_roles, 15)) == [15, 16, 17],
        a._career_cap_grades(_roles, 15))
s.check("_career_cap_grades is a no-op when the current grade is unknown",
        len(a._career_cap_grades(_roles, None)) == len(_roles))

# has_direction on the career overview: False until a direction/aspiration is set (use OTHER,
# untouched by the earlier set_field tests).
with a.app.test_request_context("/"):
    from flask import session as _hs
    _hs["user_id"] = OTHER["id"]
    _hdb = a.get_db()
    _hu = dict(_hdb.execute("SELECT * FROM users WHERE id=?", (OTHER["id"],)).fetchone())
    _ov0 = a._career_overview(_hdb, _hu)["data"]
s.check("has_direction is False before any direction is chosen", _ov0.get("has_direction") is False, _ov0)
with a.app.app_context():
    a.pm_career_save_field(a.get_db(), OTHER["id"], "aspiration_mid", "Grow toward Senior Executive (JG15)")
with a.app.test_request_context("/"):
    from flask import session as _hs2
    _hs2["user_id"] = OTHER["id"]
    _hdb2 = a.get_db()
    _hu2 = dict(_hdb2.execute("SELECT * FROM users WHERE id=?", (OTHER["id"],)).fetchone())
    _ov1 = a._career_overview(_hdb2, _hu2)["data"]
s.check("has_direction is True once an aspiration/target is set", _ov1.get("has_direction") is True, _ov1)

# THE GUARDRAIL (Chris, 2026-09-17): no AI-suggested/drafted role. show_directions must NEVER
# call the AI brief model, and Column 2 must be the roles' REAL required competencies even with
# the model OFF -- never "AI summary unavailable".
_wascfg2 = ai_draft.is_configured
_wasbrief = ai_draft.career_role_briefs
_briefcalls = []


def _brief_spy(*args, **kw):
    _briefcalls.append(1)
    raise ai_draft.AIDraftError("should not be called")


ai_draft.is_configured = lambda: False
ai_draft.career_role_briefs = _brief_spy
try:
    _sd = jtool("show_directions", {}, ZEMP)
finally:
    ai_draft.is_configured = _wascfg2
    ai_draft.career_role_briefs = _wasbrief
s.check("show_directions does NOT call the AI brief model at all", not _briefcalls, _briefcalls)
s.check("...and Column 2 is still real competencies with the model off (never 'unavailable')",
        _sd.get("render", {}).get("type") == "career_direction"
        and all((r.get("competencies") or []) and not r.get("ai")
                for r in _sd["render"]["data"]["roles"]), _sd["render"]["data"]["roles"][:1])
s.check("show_directions carries `locked` (finalised) so the client greys the card only then",
        "locked" in _sd["render"]["data"] and _sd["render"]["data"]["locked"] is False)

# ---------------------------------------------------------------------------
s.section("dev goals come from the target-role proficiency gap (Chris, 2026-09-17)")
with a.app.app_context():
    db = a.get_db()

    def _sk(code, title, level):
        return db.execute("INSERT INTO tc_skills(skill_code, title, level, active) VALUES (?,?,?,1)",
                          (code, title, level)).lastrowid
    GA3 = _sk("ZZGAP-A3", "Gap Skill Alpha", 3)
    _sk("ZZGAP-A4", "Gap Skill Alpha", 4)          # same title, deeper level exists
    GB3 = _sk("ZZGAP-B3", "Gap Skill Beta", 3)
    # A target role in the architecture: Alpha needed at L4 (person holds L3 -> STRETCH),
    # Beta needed at L3 (person doesn't hold it -> MISSING).
    PT = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, source, active) "
                    "VALUES ('Sales Operations','Gap Test Manager','16',?,1)",
                    (a._CAREER_DEMO_SOURCE,)).lastrowid
    db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order) "
               "VALUES (?,?,4,0)", (PT, GA3))
    db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order) "
               "VALUES (?,?,3,1)", (PT, GB3))
    ZG = db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, "
                    "business_group, company, department, job_title, job_grade) "
                    "VALUES (?,?,'x','user',?,?,?,?,?,?)",
                    ("ZZGAP-EMP", "ZZ Gap Emp", "ZZGAP-EMP", "ZZ BG", "ZZ Co",
                     "Sales Operations", "Assistant Manager", 15)).lastrowid
    # The person's competency SELF-assessment: demonstrated Alpha at L3, submitted (NOT reviewed).
    _assid = db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status) "
                        "VALUES (?,?, 'submitted')", (CID, ZG)).lastrowid
    _aaid = db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) VALUES (?,?,?)",
                       (CID, ZG, GA3)).lastrowid
    db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer) VALUES (?,?, 'yes')",
               (_assid, _aaid))
    db.commit()

with a.app.app_context():
    _selfmap = a.tc_person_skill_self(a.get_db(), ZG)
s.check("tc_person_skill_self reads the person's OWN (submitted, not-reviewed) answers",
        _selfmap.get("Gap Skill Alpha") == 3, _selfmap)

with a.app.app_context():
    a.pm_career_profile_for(a.get_db(), ZG, create=True)
    a.get_db().execute("UPDATE pm_career_profile SET target_profile_id=? WHERE subject_id=?", (PT, ZG))
    a.get_db().commit()
with a.app.test_request_context("/"):
    from flask import session as _gs
    _gs["user_id"] = ZG
    _gdb = a.get_db()
    _gu = dict(_gdb.execute("SELECT * FROM users WHERE id=?", (ZG,)).fetchone())
    gap = a._career_target_gap(_gdb, _gu)
_byarea = {it["area"]: it for it in gap["items"]}
s.check("the target gap has one item per stretch/missing skill (met excluded)",
        set(_byarea) == {"Gap Skill Alpha", "Gap Skill Beta"}, gap)
s.check("Alpha is a STRETCH: held at L3, the role needs L4",
        _byarea["Gap Skill Alpha"]["kind"] == "stretch"
        and _byarea["Gap Skill Alpha"]["required"] == 4
        and _byarea["Gap Skill Alpha"]["have"] == 3, _byarea.get("Gap Skill Alpha"))
s.check("Beta is MISSING: needed by the role, not held today",
        _byarea["Gap Skill Beta"]["kind"] == "missing"
        and _byarea["Gap Skill Beta"]["have"] is None, _byarea.get("Gap Skill Beta"))

rg = jtool("show_gaps", {}, ZG)
s.check("show_gaps surfaces the target-role gap (idp_gaps render, 2 items)",
        rg.get("render", {}).get("type") == "idp_gaps"
        and len(rg["render"]["data"]["items"]) == 2, rg)

# draft_plan: goals come from the gap -- areas ARE the skills (deterministic), AI only the 70:20:10.
_wascfg3 = ai_draft.is_configured
_wasact = ai_draft.draft_idp_actions
ai_draft.is_configured = lambda: True
_seen_sv = []
ai_draft.draft_idp_actions = lambda goals, target=None, timeout=25, self_view=None: (
    _seen_sv.append(self_view), [
        {"action_experience": "stretch task", "action_exposure": "learn from a peer",
         "action_education": "a short course"} for _ in goals])[1]
# The competency self-assessment remark (strengths + development areas) is carried into the IDP AI draft
# (Chris, 2026-09-24): give ZG one, and check the draft call receives it.
_ZG_REMARK = "Strong at planning the weekly schedule; still developing my costing and budget analysis."
with a.app.app_context():
    _zdb = a.get_db()
    _zcid = a.active_cycle_id(_zdb)
    _zas = a.tc_get_or_create_assessment(_zdb, _zcid, ZG)
    _zdb.execute("UPDATE tc_assessments SET overall_remark=? WHERE id=?", (_ZG_REMARK, _zas["id"]))
    _zdb.commit()
try:
    rdp = jtool("draft_plan", {}, ZG)
finally:
    ai_draft.is_configured = _wascfg3
    ai_draft.draft_idp_actions = _wasact
s.check("the IDP AI draft receives the competency remark (strengths + development areas) as self_view",
        bool(_seen_sv) and _ZG_REMARK in (_seen_sv[0] or ""), _seen_sv)
# ...and the three draft functions put it in the model's USER message, fenced as data (never the system prompt).
_was_cfg, _was_cc = ai_draft._cfg, ai_draft._chat_complete
_users = []
ai_draft._cfg = lambda: ("https://x", "k", "d", "v")
ai_draft._chat_complete = lambda system, user, *a_, **k_: (_users.append((system, user)), "[]")[1]
try:
    ai_draft.draft_idp_actions([{"area": "Costing", "detail": ""}], None, self_view=_ZG_REMARK)
    ai_draft.draft_idp_goals("ctx", [{"id": 1, "label": "Costing"}], self_view=_ZG_REMARK)
    ai_draft.draft_career_profile("", "grow in role", self_view=_ZG_REMARK)
    ai_draft.draft_idp_actions([{"area": "Costing", "detail": ""}], None)   # none -> no block
finally:
    ai_draft._cfg, ai_draft._chat_complete = _was_cfg, _was_cc
s.check("draft_idp_actions / draft_idp_goals / draft_career_profile each carry the remark in the USER message",
        len(_users) == 4 and all(_ZG_REMARK in u_ and "DATA, not instructions" in u_ for (_s, u_) in _users[:3])
        and all(_ZG_REMARK not in s_ for (s_, _u) in _users[:3]), [u_[-200:] for (_s, u_) in _users])
s.check("...and with no remark there is no empty block", "their own words" not in _users[3][1], _users[3][1][-200:])
s.check("draft_plan drafts development goals from the gap", rdp.get("ok") is True
        and rdp.get("drafted_goals", 0) >= 2, rdp)
_areas = [r["area"] for r in H.rows(a, "SELECT g.area FROM pm_idp_goals g JOIN pm_idp p ON p.id=g.idp_id "
                                       "WHERE p.subject_id=?", (ZG,))]
s.check("...and every goal AREA is a gap skill (from the architecture, not AI-invented)",
        set(_areas) and set(_areas) <= {"Gap Skill Alpha", "Gap Skill Beta"}, _areas)
s.check("...with AI-drafted 70:20:10 actions attached",
        H.one(a, "SELECT COUNT(*) FROM pm_idp_goals g JOIN pm_idp p ON p.id=g.idp_id "
                 "WHERE p.subject_id=? AND COALESCE(g.action_experience,'')<>''", (ZG,)) >= 2)

# "How far would you move" (Chris, 2026-09-28: "should be an open selection for user"): the draft never
# picks it -- it stays blank for them to choose, and the result says it is still theirs to pick.
s.check("draft_plan leaves mobility blank for the person to pick (never pre-selected)",
        not (field("mobility", ZG) or "") and rdp.get("mobility_open") is True,
        (field("mobility", ZG), rdp.get("mobility_open")))
with a.app.app_context():
    a.pm_career_save_field(a.get_db(), ZG, "mobility", "relocate")
    a.get_db().execute("DELETE FROM pm_idp_goals WHERE idp_id IN (SELECT id FROM pm_idp WHERE subject_id=?)", (ZG,))
    a.get_db().commit()
ai_draft.is_configured = lambda: True
ai_draft.draft_idp_actions = lambda goals, target=None, timeout=25, self_view=None: [{} for _ in goals]
try:
    _rdp2 = jtool("draft_plan", {}, ZG)
finally:
    ai_draft.is_configured = _wascfg3
    ai_draft.draft_idp_actions = _wasact
s.check("...and never touches a mobility the person already chose",
        field("mobility", ZG) == "relocate" and _rdp2.get("mobility_open") is False,
        (field("mobility", ZG), _rdp2.get("mobility_open")))

# "Use all the previously answered sections" (Chris, 2026-09-24): the draft's self-view also carries the
# KPI check-in -- each KPI's result + rating and their own overall remark (the 360 rates others: left out).
_wasov0 = a._review_kpi_overview
a._review_kpi_overview = lambda db, u: {"type": "kpi_overview", "data": {"lines": [
    {"kpi": "Gross Profit", "kpi_id": 9101, "result": 16.0, "band_code": "OU", "band": "Outstanding"},
    {"kpi": "Not keyed", "kpi_id": 9103, "result": None, "band_code": None, "band": None},
]}}
with a.app.app_context():
    _kdb = a.get_db()
    _kdb.execute("INSERT OR REPLACE INTO pm_overall_remarks(cycle_id, subject_id, remark, draft) VALUES (?,?,?,1)",
                 (a.active_cycle_id(_kdb), ZG, "I rebuilt supplier terms and lifted gross profit."))
    _kdb.commit()
try:
    _sv = with_ctx_career(ZG, lambda db, u: a._idp_self_view(db, u))
finally:
    a._review_kpi_overview = _wasov0
s.check("the draft's self-view carries the competency remark AND the KPI check-in (results + remark)",
        _ZG_REMARK in _sv and "Gross Profit -- Outstanding" in _sv and "Not keyed" not in _sv
        and "I rebuilt supplier terms" in _sv, _sv)

# --- performance signal: weak KPIs (below Meets) also become goals (Chris, 2026-09-17) ---
_wasov = a._review_kpi_overview
a._review_kpi_overview = lambda db, u: {"type": "kpi_overview", "data": {"lines": [
    {"kpi": "Gross Profit", "kpi_id": 9101, "band_code": "BE", "band": "Below Expectation"},
    {"kpi": "Deliveries", "kpi_id": 9102, "band_code": "OU", "band": "Outstanding"},
    {"kpi": "Not keyed", "kpi_id": 9103, "band_code": None, "band": None},
]}}
try:
    with a.app.test_request_context("/"):
        from flask import session as _ps
        _ps["user_id"] = ZG
        _pdb = a.get_db()
        _pu = dict(_pdb.execute("SELECT * FROM users WHERE id=?", (ZG,)).fetchone())
        perf = a._career_perf_gap_items(_pdb, _pu)
    s.check("_career_perf_gap_items returns ONLY weak KPIs (UA/BE), tagged performance",
            [it["area"] for it in perf] == ["Gross Profit"] and perf[0]["kind"] == "performance", perf)
    # draft_plan now BLENDS the competency gap + weak-KPI performance goals. Clear ZG's earlier goals.
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_idp_goals WHERE idp_id IN "
                           "(SELECT id FROM pm_idp WHERE subject_id=?)", (ZG,))
        a.get_db().commit()
    ai_draft.is_configured = lambda: True
    ai_draft.draft_idp_actions = lambda goals, target=None, timeout=25, self_view=None: [{} for _ in goals]
    try:
        jtool("draft_plan", {}, ZG)
    finally:
        ai_draft.is_configured = _wascfg3
        ai_draft.draft_idp_actions = _wasact
    _areas2 = [r["area"] for r in H.rows(a, "SELECT g.area FROM pm_idp_goals g JOIN pm_idp p ON p.id=g.idp_id "
                                            "WHERE p.subject_id=?", (ZG,))]
    s.check("draft_plan blends competency-gap goals AND a weak-KPI performance goal",
            "Gross Profit" in _areas2
            and any(x in _areas2 for x in ("Gap Skill Alpha", "Gap Skill Beta")), _areas2)
finally:
    a._review_kpi_overview = _wasov

# ---------------------------------------------------------------------------
s.section("Career Plan entry: the direction box FIRST, one fixed line, no model (Chris, 2026-09-24)")
with a.app.app_context():
    _edb = a.get_db()
    # confirmed: only confirmed employees have their own review to do (2026-09-28)
    ZEN = _edb.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, "
                       "business_group, company, department, job_title, job_grade, confirmation_date) "
                       "VALUES ('ZZCT-ENTRY','ZZCT-ENTRY','x','user','ZZCT-ENTRY',?, 'ZZ Co', "
                       "'Sales Operations', 'Assistant Manager', 15, '2020-01-01')", (ZBG,)).lastrowid
    _edb.commit()
_wcd0 = a._career_can_draft
a._career_can_draft = lambda db, u: True
try:
    _ce0 = with_ctx_career(ZEN, lambda db, u: a._journey_career_entry(db, u, CID))
finally:
    a._career_can_draft = _wcd0
s.check("an empty plan -> the fixed line + the career_direction card (real architecture roles)",
        bool(_ce0) and _ce0[0] == a._CAREER_ENTRY_SAY and _ce0[1]["type"] == "career_direction"
        and len(_ce0[1]["data"]["roles"]) >= 3, _ce0)
with a.app.app_context():
    a.pm_career_profile_for(a.get_db(), ZEN, create=True)
    a.get_db().execute("UPDATE pm_career_profile SET target_profile_id=? WHERE subject_id=?", (P_MGR, ZEN))
    a.get_db().commit()
s.check("a direction saved earlier with the plan still EMPTY still starts at the direction box",
        bool(with_ctx_career(ZEN, lambda db, u: a._journey_career_entry(db, u, CID))))
with a.app.app_context():
    a.pm_career_save_field(a.get_db(), ZEN, "strengths", "Planning and supplier relationships")
s.check("a field the journey no longer asks for (strengths) doesn't count -- still the direction box first",
        bool(with_ctx_career(ZEN, lambda db, u: a._journey_career_entry(db, u, CID))))
with a.app.app_context():
    a.pm_career_save_field(a.get_db(), ZEN, "aspiration_long", "Run a regional sales team")
s.check("once one of the three items has something in it, entry is the normal turn (None)",
        with_ctx_career(ZEN, lambda db, u: a._journey_career_entry(db, u, CID)) is None)
s.check("a person with no roles to pick from gets the normal turn (None), never an empty box",
        with_ctx_career(SUBJ["id"], lambda db, u: a._journey_career_entry(db, u, CID)) is None)
_ce_src = H.source(a)
s.check("the journey turn runs the entry on a part-name pick or a switch's empty turn, before the model",
        'if active_stage == "career_plan" and (picked_stage or not msg or _journey_names_stage(st, msg, "career_plan")):'
        in _ce_src
        and "_journey_career_entry(db, u, cid)" in _ce_src)
# The model moves them there itself ("proceed" to "shall we start your Career Plan?") -- the entry comes too
# (Chris, 2026-09-28: "when i asked to proceed to career plan, it didn't spawn the role card for selection till I
# pick 'Explore'").
with a.app.app_context():
    _edb = a.get_db()
    ZEN2 = _edb.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, "
                        "business_group, company, department, job_title, job_grade, confirmation_date) "
                        "VALUES ('ZZCT-MOVE','ZZCT-MOVE','x','user','ZZCT-MOVE',?, 'ZZ Co', "
                        "'Sales Operations', 'Assistant Manager', 15, '2020-01-01')", (ZBG,)).lastrowid
    _peer = _edb.execute("SELECT id FROM users WHERE role!='admin' AND left_at IS NULL AND id NOT IN (?,?) LIMIT 1",
                         (ZEN, ZEN2)).fetchone()[0]
    # an open 360 (it never locks the Career Plan) -- so they start on the 360 and move
    _edb.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) "
                 "VALUES (?,?,?,'peer','pending')", (CID, _peer, ZEN2))
    _edb.commit()
_avm, _agm, _wcd1 = ai_draft.review_agent_available, ai_draft.review_agent, a._career_can_draft
_mv_script = [{"say": "Moving on.", "quick_replies": [], "action": {"tool": "go_to_stage", "args": {"stage": "career_plan"}}},
              {"say": "Let's start your Career Plan: pick a role in the direction box just below, or choose explore.",
               "quick_replies": ["Explore"], "action": None}]
ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = lambda system, messages, timeout=90: (_mv_script.pop(0) if _mv_script else
                                                                {"say": "ok", "quick_replies": [], "action": None})
a._career_can_draft = lambda db, u: True
try:
    _EM = H.client_as(a, ZEN2)
    with a.app.app_context():
        a.get_db().execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) VALUES "
                           "(?,?,'agent','Next up is your Career Plan -- shall we start?','feedback')", (ZEN2, CID))
        a.get_db().commit()
    _mv = post(_EM, "/review/chat?journey=1", message="proceed", stage="feedback").get_json() or {}
finally:
    ai_draft.review_agent_available, ai_draft.review_agent, a._career_can_draft = _avm, _agm, _wcd1
s.check("moved into an empty Career Plan by the agent: the 'where would you like to head?' box comes with it",
        _mv.get("stage") == "career_plan" and _mv.get("moved")
        and [r.get("type") for r in (_mv.get("renders") or [])] == ["career_direction"]
        and _mv.get("say") == a._CAREER_ENTRY_SAY, (_mv.get("stage"), _mv.get("renders"), _mv.get("say")))
# Already ON the empty Career Plan and naming it ("Let's do my Career Plan"): the same box, no model (2026-10-24: on
# Luna, 1 run in 3 answered "the direction box should be on screen" with no box drawn)
_calls = []
ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = lambda system, messages, timeout=90: (_calls.append(1) or
                                                                {"say": "The direction box should be on screen.",
                                                                 "quick_replies": [], "action": None})
a._career_can_draft = lambda db, u: True
try:
    _on = post(_EM, "/review/chat?journey=1", message="Let's do my Career Plan.", stage="career_plan").get_json() or {}
    _calls_after_name = list(_calls)
    _on2 = post(_EM, "/review/chat?journey=1", message="What's a 70:20:10 plan?", stage="career_plan").get_json() or {}
finally:
    ai_draft.review_agent_available, ai_draft.review_agent, a._career_can_draft = _avm, _agm, _wcd1
s.check("on the empty Career Plan, a message naming it brings the box itself, with no model call",
        [r.get("type") for r in (_on.get("renders") or [])] == ["career_direction"]
        and _on.get("say") == a._CAREER_ENTRY_SAY and _calls_after_name == [],
        ([r.get("type") for r in (_on.get("renders") or [])], _on.get("say"), _calls_after_name))
s.check("...while a question on it still goes to the model", _calls == [1], _calls)
s.check("the reply after a pick names what the draft filled (goals, the longer-term line, mobility)",
        "a line on where you're heading longer term" in _ce_src and "how far you'd move" in _ce_src)

# ---------------------------------------------------------------------------
s.section("the journey Career Plan is THREE items (Chris, 2026-09-24)")
_jov = with_ctx_career(ZEN, lambda db, u: a._career_overview(db, u, journey=True)["data"])
s.check("the journey profile is two pages: next move + longer term, then mobility",
        [x["key"] for x in _jov["sections"]] == ["aspirations", "mobility"]
        and [it["field"] for it in _jov["sections"][0]["items"]] == ["aspiration_mid", "aspiration_long"]
        and [it["field"] for it in _jov["sections"][1]["items"]] == ["mobility"]
        and _jov["total"] == 3, _jov["sections"])
s.check("...labelled 'Where you want to go' (Your next move / Longer term) and 'How far you'd move'",
        _jov["sections"][0]["label"] == "Where you want to go"
        and [it["label"] for it in _jov["sections"][0]["items"]] == ["Your next move", "Longer term"]
        and _jov["sections"][1]["label"] == "How far you'd move", _jov["sections"])
s.check("the standalone career chat keeps every field (journey=False is unchanged)",
        len(with_ctx_career(ZEN, lambda db, u: a._career_overview(db, u)["data"])["sections"]) == 3)
_st3 = with_ctx_career(ZEN, lambda db, u: a._journey_idp_steps(db, u))
s.check("three steps + the sign-off: Goals -> Direction -> Mobility -> Share; Direction done, Goals current",
        [x["key"] for x in _st3] == ["goals", "where", "mobility", "share"]
        and not _st3[0]["done"] and _st3[0].get("current") and _st3[1]["done"] and not _st3[2]["done"]
        and not _st3[3]["done"] and _st3[3]["meta"] == "Final step", _st3)
_nav3 = with_ctx_career(ZEN, lambda db, u: a._journey_nav_items(db, u, "career_plan"))
s.check("the navigator lists exactly those three items + Save & share (not the nine it had)",
        [x["id"] for x in _nav3["items"]] == ["goals", "where", "mobility", "share"]
        and [x["name"] for x in _nav3["items"]] == ["Development goals", "Where you want to go", "How far you'd move",
                                                     "Save & share"], _nav3)
_z3 = with_ctx_career(ZEN, lambda db, u: a._journey_modtabs_html(db, u, a.review_state(db, u), "career_plan"))
s.check("the expanded IDP banner steps through the same three + Share",
        all(w in _z3 for w in (">Goals<", ">Direction<", ">Mobility<", ">Share<")), _z3[-800:])
# set_direction records the pick as the next move, so "Where you want to go" shows it and the profile's
# done rule (an aspiration + mobility) is met by what's on screen.
_rsd = jtool("set_direction", {"choice": "Manager, Sales Operations"}, ZEN)
s.check("picking a role writes it as the next move (aspiration_mid = the role)",
        _rsd.get("ok") and field("aspiration_mid", ZEN) == "Manager, Sales Operations (JG16)",
        field("aspiration_mid", ZEN))
# The journey's profile writes stay inside the three items.
_bad = jtool("set_field", {"field": "strengths", "value": "Great at planning"}, ZEN)
_ok = jtool("set_field", {"field": "aspiration_long", "value": "Lead the regional sales function"}, ZEN)
s.check("in the journey, set_field refuses a field outside the three (strengths) -- nothing written",
        _bad.get("ok") is False and field("strengths", ZEN) == "Planning and supplier relationships", _bad)
s.check("...and accepts one of the three (aspiration_long)",
        _ok.get("ok") is True and field("aspiration_long", ZEN) == "Lead the regional sales function", _ok)
# The draft fills only what the three items show: never the next move (the pick) or hidden fields.
with a.app.app_context():
    _d3 = a.get_db()
    ZD3 = _d3.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                      "company, department, job_title, job_grade, confirmation_date) VALUES ('ZZCT-D3','ZZCT-D3','x',"
                      "'user','ZZCT-D3',?, 'ZZ Co', 'Sales Operations', 'Assistant Manager', 15, '2020-01-01')",
                      (ZBG,)).lastrowid
    _d3.commit()
jtool("set_direction", {"choice": "Manager, Sales Operations"}, ZD3)
_w3 = (ai_draft.is_configured, ai_draft.draft_idp_actions, ai_draft.draft_career_profile)
ai_draft.is_configured = lambda: True
ai_draft.draft_idp_actions = lambda goals, target=None, timeout=25, self_view=None: [{} for _ in goals]
ai_draft.draft_career_profile = lambda *a_, **k_: json.dumps({
    "aspiration_now": "AI now", "aspiration_mid": "AI mid", "aspiration_long": "AI long", "strengths": "AI strengths"})
try:
    _rd3 = jtool("draft_plan", {}, ZD3)
finally:
    ai_draft.is_configured, ai_draft.draft_idp_actions, ai_draft.draft_career_profile = _w3
s.check("the draft writes the longer-term line and keeps the picked role as the next move",
        field("aspiration_long", ZD3) == "AI long" and field("aspiration_mid", ZD3) == "Manager, Sales Operations (JG16)",
        (field("aspiration_long", ZD3), field("aspiration_mid", ZD3)))
s.check("...and never fills a field the journey no longer shows (right now, strengths)",
        not field("aspiration_now", ZD3) and not field("strengths", ZD3), (field("aspiration_now", ZD3), field("strengths", ZD3)))
s.check("...and mobility is left for them to pick (the draft fills goals + the longer-term line only)",
        not (field("mobility", ZD3) or "") and _rd3.get("drafted_profile_fields") == 1, _rd3)
# A Save isn't a chat turn, so the save response carries the navigator + banner (they show the three items).
_svc = H.client_as(a, ZD3)
_svr = _svc.post("/review/career/save-all", data={"csrf_token": "tok", "mobility": "relocate"}).get_json() or {}
s.check("a Career Plan Save returns the refreshed navigator + banner (Mobility now done there)",
        "nav_html" in _svr and "modtabs_html" in _svr and "Open to relocating" in (_svr.get("nav_html") or "")
        and ">Mobility<" in (_svr.get("modtabs_html") or ""), {k: (v[:120] if isinstance(v, str) else v) for k, v in _svr.items() if k != "overview"})
_cjs3 = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "journey_chat.js"), encoding="utf-8").read()
s.check("...and the client swaps them in after the Save", "swapChrome(last);" in _cjs3)

# ---------------------------------------------------------------------------
s.section("review fixes: the three-item Career Plan (2026-09-24 adversarial review)")
# A re-pick never replaces a longer-term line the person wrote themselves.
with a.app.app_context():
    a.pm_career_save_field(a.get_db(), ZD3, "aspiration_long", "Run my own plant by 2031")
    a.get_db().execute("DELETE FROM pm_idp_goals WHERE idp_id IN (SELECT id FROM pm_idp WHERE subject_id=?)", (ZD3,))
    a.get_db().commit()
ai_draft.is_configured = lambda: True
ai_draft.draft_idp_actions = lambda goals, target=None, timeout=25, self_view=None: [{} for _ in goals]
ai_draft.draft_career_profile = lambda *a_, **k_: json.dumps({"aspiration_long": "AI long again"})
try:
    jtool("draft_plan", {}, ZD3)
finally:
    ai_draft.is_configured, ai_draft.draft_idp_actions, ai_draft.draft_career_profile = _w3
s.check("a re-pick keeps the person's own longer-term line (the draft writes it only when blank)",
        field("aspiration_long", ZD3) == "Run my own plant by 2031", field("aspiration_long", ZD3))
_src_r = H.source(a)
_d0 = _src_r.find("def _career_tool_draft_plan"); _d1 = _src_r.find("\ndef ", _d0 + 1)
_dp = _src_r[_d0:_d1]
s.check("the draft never writes mobility (it is the person's own pick)",
        '"mobility"' not in _dp.replace('prof.get("mobility")', "") and "same_company" not in _dp, _dp[-600:])
# The pick rule matches only the card's phrasing; a refused pick goes to the model, not a tool error.
s.check("the pick rule matches the card's 'I'd like to aim for <role>'",
        bool(a._JOURNEY_AIM_RE.search("I'd like to aim for Manager, Sales Operations (JG16)")))
s.check("...but not a longer-term answer that happens to say 'aim for'",
        not a._JOURNEY_AIM_RE.search("Longer term I aim for a regional director role")
        and not a._JOURNEY_AIM_RE.search("I'd claim for travel"))
s.check("...and a choice that isn't one of their roles falls through to the model",
        'if sd.get("ok") and sd.get("direction") == "role":' in _src_r
        and "That role isn't in your options -- pick one of the listed roles." not in _src_r)
# save_career on the journey KPI stage stays inside the three items, like set_field.
_sc_bad = with_ctx_career(ZD3, lambda db, u: a._journey_run_stage_tool(
    db, u, CID, "account", {"tool": "save_career", "args": {"field": "mentor", "value": "Aisha"}}))
s.check("on the KPI stage, save_career refuses a field outside the three (mentor)",
        _sc_bad.get("ok") is False and not field("mentor", ZD3), _sc_bad)
# Outside the authoring window with no goals, Goals is not a to-do: not current, not pending.
_wov = a._career_plan_overview_data
a._career_plan_overview_data = lambda db, u: {"plan": {"editable": False, "total": 0, "ready": 0, "goals": []},
                                             "career": {"sections": [], "answered": 0, "total": 3}}
try:
    _na = with_ctx_career(ZEN, lambda db, u: a._journey_idp_steps(db, u))
    _nan = with_ctx_career(ZEN, lambda db, u: a._journey_nav_items(db, u, "career_plan"))
finally:
    a._career_plan_overview_data = _wov
s.check("goals not open yet: the Goals step is 'Opens at year-end', never the current step -- and no Share step",
        _na[0].get("na") and not _na[0].get("current") and _na[0]["meta"] == "Opens at year-end"
        and "share" not in [x["key"] for x in _na], _na)
s.check("...and the navigator keeps it out of 'pending'", _nan["items"][0]["done"] is True, _nan["items"][0])
# Direction also counts a "Right now" answered on the classic page (it agrees with pm_career_is_complete).
with a.app.app_context():
    _rn = a.get_db().execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                             "company, department, job_title, job_grade) VALUES ('ZZCT-RN','ZZCT-RN','x','user',"
                             "'ZZCT-RN',?, 'ZZ Co', 'Sales Operations', 'Assistant Manager', 15)", (ZBG,)).lastrowid
    a.get_db().commit()
    a.pm_career_save_field(a.get_db(), _rn, "aspiration_now", "Lead my shift team")
_rns = with_ctx_career(_rn, lambda db, u: a._journey_idp_steps(db, u))
s.check("a 'Right now' answer from the classic page counts for 'Where you want to go'",
        _rns[1]["done"] and _rns[1]["meta"] == "Lead my shift team", _rns[1])
# Never promise an auto-draft that can't happen.
_wcd = a._career_can_draft
a._career_can_draft = lambda db, u: False
try:
    _ce_nd = with_ctx_career(_rn, lambda db, u: a._journey_career_entry(db, u, CID))
finally:
    a._career_can_draft = _wcd
s.check("with no draft possible, the entry line promises no draft",
        bool(_ce_nd) and _ce_nd[0] == a._CAREER_ENTRY_SAY_NODRAFT and "draft" not in _ce_nd[0].lower(), _ce_nd)
s.check("the opener promises the auto-draft only when a draft can run (the IDP switch, not the ai_on function)",
        "if not has_content and draft_ok and role_names:" in _src_r
        and "draft_ok = bool(editable and _ai_on and ai_draft.is_configured())" in _src_r)
# Client: Save posts only what the person changed; a turn whose data changed rebuilds the widget.
s.check("Save posts only changed profile fields / changed goal fields (a new card sends everything)",
        "if (cpDirty(el)) pf.append(" in _cjs3 and "return el && (!gid || cpDirty(el));" in _cjs3)
s.check("a turn whose overview changed rebuilds the widget, keeping unsaved edits",
        "cpRefreshFromServer(data);" in _cjs3 and 'getAttribute("data-sig") === cpSig(data)' in _cjs3
        and "if (k && keep[k] !== undefined) el.value = keep[k];" in _cjs3)
s.check("a navigator jump brings the card into view (its old place retired)",
        "flashStageCard({ now: true, change: function () { showCareerSection(stageCard.body); } });" in _cjs3)
s.check("the manager views keep the classic labels (they match the plain summary)",
        _cjs3.count('["In 1-3 years", career.aspiration_mid]') == 2)
s.check("a Career Plan navigator item jumps the widget to its page (no chat turn) once it's open",
        "var cpPage = { goals: 0, where: 1, mobility: 2 }[id];" in _cjs3)

# The deterministic career-pick -> auto-draft block lives in the journey turn (no model, no gaps card).
_appsrc = H.source(a)
s.check("picking a direction auto-drafts server-side (deterministic, not model-driven)",
        "_JOURNEY_AIM_RE" in _appsrc
        and "_career_tool_set_direction(db, u, cid, {\"choice\":" in _appsrc
        and "_career_tool_draft_plan(db, u, cid, {})" in _appsrc)

# client + css wiring
_cjs = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "journey_chat.js"), encoding="utf-8").read()
# each group is a horizontal carousel of clickable role cards (no arrow button); the whole card
# fires the "aim for" turn; the chat scrolls to the START of the agent's reply.
s.check("the WHOLE role card selects it (role=button), Confirm sends the aim-for turn, no arrow button",
        'row.setAttribute("role", "button")' in _cjs
        and 'sendTurn("I\'d like to aim for " + lbl)' in _cjs
        and '"rv-dir-pick"' not in _cjs)   # the old arrow pick button className (not rv-dir-picked)
# a card SELECTS, Confirm (bottom right) picks (Chris, 2026-10-22: "make the next role selection a select instead of
# a trigger to pick, so user can browse around the role and view the skill tree below it, add a button on the bottom
# right as confirm")
_ccss_all = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "style.css"),
                 encoding="utf-8").read()
_cd = _cjs[_cjs.find("function careerDirectionCard("):]
_cd = _cd[:_cd.find("\n  function ", 10)]
s.check("a role card only selects: lit, aria-pressed, its skill tree below, no turn sent",
        'row.addEventListener("click", function () { select(row, r, lbl); });' in _cd
        and "function select(row, r, lbl)" in _cd and 'row.setAttribute("aria-pressed", "true");' in _cd
        and "showTree(r, false);" in _cd)
s.check("...the turn goes only from Confirm, which locks the card",
        _cd.count("sendTurn(\"I'd like to aim for \" + lbl)") == 1 and "function confirmPick()" in _cd
        and "goBtn.addEventListener(\"click\", confirmPick);" in _cd and "lockCard(sel.row, sel.r);" in _cd)
s.check("...Confirm sits bottom right, naming the selected role, waiting while nothing new is selected",
        'go.className = "rv-dir-go"' in _cd and 'goBtn.className = "rv-dir-confirm"' in _cd
        and "goBtn.disabled = !sel || done || picked || !!d.locked;" in _cd
        and "Select a role to see its skill tree" in _cd)
s.check("no Explore button: browsing is the exploring, the chat takes 'help me decide' (Chris, 2026-10-22)",
        "Explore \u2014 help me decide" not in _cd and "Help me explore my options" not in _cjs
        and "rv-dir-opt" not in _cjs and "rv-dir-opt" not in _ccss_all)
s.check("...the recommended role starts selected (its tree on show); a replayed aim starts as Confirmed",
        "roles.filter(function (r) { return r.recommended; })[0]" in _cd and "confirmedId = chosenRole.profile_id" in _cd)
s.check("each group is a horizontal strip with slim L/R nav (thin bezel)",
        "rv-dir-strip" in _cjs and "function dirNav" in _cjs and "rv-dir-nav" in _cjs)
s.check("the card shows REAL competencies and NO 'AI-suggested' tag anywhere",
        "rv-dir-complabel" in _cjs and "AI-suggested" not in _cjs and "r.ai" not in _cjs)
# Direction FIRST (Chris, 2026-09-24): an empty plan shows only the direction box -- a direction saved
# earlier no longer opens the widget; content (the draft after a pick) or beginning this entry does.
s.check("the widget waits for content or a begin (not a stale has_direction); cp.started resets only on a real entry",
        "if (!cp.started && careerPlanEmpty(data)) return null;" in _cjs
        and "data.career.has_direction" not in _cjs
        and 'if (stageCard.stage !== "career_plan") cp.started = false;' in _cjs)
s.check("...only a direction pick or a build-it-myself answer begins it (a question keeps the box first)",
        "aim for" in _cjs and "start fresh|from scratch|myself|build it" in _cjs)
s.check("the direction card greys on pick + on replay only when finalised (d.locked), redo stays open",
        "function lockCard" in _cjs and "rv-dir-picked" in _cjs and "d.locked" in _cjs)
_ccss = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "style.css"), encoding="utf-8").read()
s.check("the picked-card grey-out + chosen-role highlight have CSS",
        ".rv-dir.rv-dir-picked" in _ccss and ".rv-dir-chosen" in _ccss)
s.check("Confirm is bottom right and navy; a skill's tag is a pill on the right edge (Chris, 2026-10-22)",
        ".rv-dir .rv-dir-go { margin-left: auto;" in _ccss and ".rv-dir .rv-dir-confirm {" in _ccss
        and H.cv("background: var(--navy, #252a59); color: #fff;") in _ccss
        and ".rv-dir .rv-dir-lv { flex: none; margin-left: auto;" in _ccss and "border-radius: 999px;" in _ccss
        and ".rv-dir .rv-dir-sk { flex: 1 1 auto;" in _ccss)
s.check("the role strip scrolls horizontally with a slim nav bezel",
        ".rv-dir .rv-dir-strip {" in _ccss and "overflow-x: auto" in _ccss
        and ".rv-dir .rv-dir-nav {" in _ccss and "width: 22px" in _ccss)
s.check("the whole card is clickable with a hover background (no green-tick pick)",
        H.cv(".rv-dir .rv-dir-item:hover { background: #f4f6fb; }").split(";")[0] in _ccss
        and "cursor: pointer" in _ccss and ".rv-dir-pick {" not in _ccss)   # old pick-button rule gone
s.check("the turn handler scrolls to the START of the agent reply, not the bottom",
        "function scrollTurnAnchor" in _cjs and "scrollTurnAnchor(anchor)" in _cjs)

# ---------------------------------------------------------------------------
# Chris, 2026-09-28: "to our career plan, after i click 'save career plan' ... it did nothing, and we should provide a
# final page view for career page as well". The widget's Save sends one turn; the server answers it (no model call).
s.section("Career Plan: Save -> the card + Save & share (or what's left), with no model call")


def _saved(uid):
    return with_ctx_career(uid, lambda db, u: a._journey_career_saved(db, u, CID, "I've saved my career plan."))


with a.app.app_context():
    _cdb = a.get_db()
    _cdb.execute("UPDATE pm_career_profile SET mobility=NULL, aspiration_now=NULL, aspiration_mid=NULL, "
                 "aspiration_long=NULL WHERE subject_id=?", (ZEMP,))
    _cdb.commit()
_sv0 = _saved(ZEMP)
s.check("profile not filled -> 'saved' + exactly what's still to fill in, no card",
        _sv0 and _sv0.get("render") is None and "To finish it, fill in" in _sv0.get("say", "")
        and "tap Save career plan" in _sv0.get("say", ""), _sv0)
jtool("set_field", {"field": "aspiration_mid", "value": "Customer Service Manager"}, ZEMP)
jtool("set_field", {"field": "mobility", "value": "same_company"}, ZEMP)
_g = jtool("add_goal", {"area": "Lead a cross-site service review"}, ZEMP)
if _g.get("goal_id"):
    jtool("set_goal_field", {"goal_id": _g["goal_id"], "field": "action_experience",
                             "value": "Run the monthly service review for both sites"}, ZEMP)
    jtool("set_goal_field", {"goal_id": _g["goal_id"], "field": "target_date", "value": "2027-06-30"}, ZEMP)
_ready = with_ctx_career(ZEMP, lambda db, u: a._idp_tool_prepare_submit(db, u, CID, {}))
_sv1 = _saved(ZEMP)
s.check("precondition: the test plan is ready to share (so the final-view branch below really runs)",
        bool(_ready.get("ready")), _ready)
if _ready.get("ready"):
    # ONE card per part (2026-09-29): no final page view -- the plan card comes to the reply and the line points to its
    # Save & share; the pop-up's summary (the preview) carries the goals AND the career profile.
    _r1 = (_sv1 or {}).get("render") or {}
    s.check("everything in -> the plan card comes to the reply (no final page view any more)",
            _r1.get("type") == "stage_focus" and _r1.get("stage") == "career_plan", _sv1)
    s.check("...and says so: Save & share on the card, confirmed in the pop-up",
            "Save & share" in (_sv1 or {}).get("say", "") and "pop-up" in (_sv1 or {}).get("say", ""),
            (_sv1 or {}).get("say"))
    _pv1 = with_ctx_career(ZEMP, lambda db, u: a._signoff_preview(db, u, CID, "career_plan"))
    _d1 = ((_pv1 or {}).get("card") or {}).get("data") or {}
    s.check("the pop-up's summary (preview) is ready and carries the goals AND the career profile",
            _pv1.get("ready") and (_pv1.get("card") or {}).get("type") == "idp_confirm" and _d1.get("goals")
            and [x.get("label") for x in ((_d1.get("career") or {}).get("sections") or [])]
            == ["Where you want to go", "How far you'd move"], _pv1)
else:
    s.check("with the goals not ready, Save names them as what's left", "development goals" in (_sv1 or {}).get("say", ""),
            (_ready, _sv1))
s.check("the Share tool's card carries the career profile too (the same final page view)",
        not _ready.get("ready") or bool(((_ready.get("render") or {}).get("data") or {}).get("career")))
_real_idps = a.get_idp_settings
def _g(gid, seq, area="", **acts):
    g = {"id": gid, "seq": seq, "area": area}
    g.update({f: acts.get(f, "") for f in a.PM_IDP_ACTION_FIELDS})
    return g
_idp_cases = []
try:
    for _rule in ("any", "all"):
        a.get_idp_settings = lambda _r=_rule: (_r, 1, 3, True)
        for _goals in ([], [_g(11, 1, "", action_experience="Lead the Q3 stock count")],
                       [_g(12, 2, "Negotiation")],
                       [_g(13, 3, "Costing", **{f: "x" for f in a.PM_IDP_ACTION_FIELDS})]):
            _plan = {"goals": _goals}
            _items = with_ctx_career(ZEMP, lambda db, u: a._idp_share_todo(db, u, _plan))
            _goal_items = [t for t in _items if (t.get("go") or {}).get("kind") in ("cp_goal", "cp_page")]
            _idp_cases.append((_rule, [g["id"] for g in _goals], bool(a.pm_idp_share_validate(_plan)[0]),
                               bool(_goal_items), [(t["go"].get("id"), t["go"].get("field")) for t in _goal_items]))
finally:
    a.get_idp_settings = _real_idps
s.check("the pop-up's Career Plan items follow the share gate exactly: a plan it refuses has goal items to go to, a plan "
        "it accepts has none (both action rules)", all(c[2] == c[3] for c in _idp_cases), _idp_cases)
_by = {(c[0], tuple(c[1])): c[4] for c in _idp_cases}
s.check("...each goal item lands on the field that's missing: the area, the first action (any), every missing action "
        "(all)", _by[("any", (11,))] == [(11, "area")] and _by[("any", (12,))] == [(12, "action_experience")]
        and _by[("all", (12,))] == [(12, f) for f in a.PM_IDP_ACTION_FIELDS], _by)
s.check("...and a missing direction / mobility goes to that field on its page",
        with_ctx_career(ZEMP, lambda db, u: [t["go"]["field"] for t in a._idp_share_todo(db, u, {"goals": []})
                                              if t["go"]["kind"] == "cp_field"])
        == [f for f, gap in (("aspiration_mid", not with_ctx_career(ZEMP, lambda db, u: any(
            (db.execute("SELECT aspiration_now, aspiration_mid, aspiration_long FROM pm_career_profile WHERE subject_id=?",
                        (u["id"],)).fetchone() or ["", "", ""])[i] or "" for i in range(3)))),
                             ("mobility", not with_ctx_career(ZEMP, lambda db, u: bool(((db.execute(
                                 "SELECT mobility FROM pm_career_profile WHERE subject_id=?", (u["id"],)).fetchone()
                                 or [""])[0] or "").strip())))) if gap])
s.check("any other message is not this path", with_ctx_career(ZEMP, lambda db, u: a._journey_career_saved(
    db, u, CID, "what's a good development goal")) is None)
_cjs2 = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "journey_chat.js"),
             encoding="utf-8").read()
_scp0 = _cjs2.find("function saveCareerPlan("); _scp = _cjs2[_scp0:_cjs2.find("\n  }\n", _scp0)]
s.check("client: Save career plan sends ONE turn (no dead-end 'Saved your career plan.' bubble)",
        'sendTurn("I\'ve saved my career plan.");' in _scp and '"Saved your career plan."' not in _scp)
s.check("client: the pop-up's summary pages goals / where you want to go / how far you'd move (side strips)",
        "function careerFinalView(d)" in _cjs2 and 'name: "Development goals"' in _cjs2
        and 'if (c && c.type === "idp_confirm") return careerFinalView(d);' in _cjs2
        and 'saveSubmitBtn("career_plan", "Save & share")' in _cjs2 and 'card.type === "career_summary"' in _cjs2)
s.check("server: the post-Save step is wired before the model on the Career Plan",
        'active_stage == "career_plan":\n        _boxdone = _journey_career_saved(db, u, cid, msg)'
        in __import__("inspect").getsource(a._journey_chat_turn))

# ---------------------------------------------------------------------------
s.section("Career Plan opens on page 1; how far you'd move is the person's pick (2026-09-28)")
_jt_src = __import__("inspect").getsource(a._journey_chat_turn)
s.check("the post-draft reply asks them to pick how far they'd move, never says it was set for them",
        "pick how far you'd move on the last page" in _jt_src and "set how far you'd move" not in _jt_src)
_cpt = __import__("inspect").getsource(a._journey_career_plan_task)
s.check("the agent is told mobility is their choice (never pick or suggest one)",
        "never pick or " in _cpt and "suggest one for them" in _cpt and "and their mobility -- all editable" not in _cpt)
_cjs5 = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "journey_chat.js"),
             encoding="utf-8").read()
_esc0 = _cjs5.find("function ensureStageCard("); _esc = _cjs5[_esc0:_cjs5.find("var body = buildStageBody", _esc0)]
s.check("client: entering the Career Plan opens page 1 (the first development goal), not the first profile page",
        "cp.section = 0; cp.manual = false;" in _esc and "focusCareerSection" not in _cjs5)
_fct0 = _cjs5.find("function focusCareerTarget("); _fct = _cjs5[_fct0:_cjs5.find("\n  }\n", _fct0)]
s.check("client: the follow target is a profile page only while a field there is UNANSWERED",
        "career.focus_field && career.focus_section" in _fct and "return { key: null, page: 0 };" in _fct)
s.check("client: the card follows only when what the conversation is on changes (never pulled off the page)",
        "ft.key && ft.key !== cp.key && ft.page !== cp.section" in _cjs5 and "cp.key = ft.key;" in _cjs5)

_wascfg = ai_draft.is_configured
ai_draft.is_configured = lambda: False
try:
    s.check("draft_plan with AI off returns a clean error (fresh path still works)",
            jtool("draft_plan", {}, ZEMP).get("ok") is False)
finally:
    ai_draft.is_configured = _wascfg

sys.exit(s.done())
