"""The AI+ calibration assistant (performance axis) -- 2026-09-19, Chris.

A talk-to-calibrate agent for a HOD/BUCEO: the model PROPOSES, the server VALIDATES
+ WRITES through _pm_calib_apply (the grid's own path), and the Phase-1 framework
guardrail is the hard gate at lock. The model can never lock.

Tested by building a ctx dict directly (population + supplied overalls), so the tool
LOGIC is exercised without the request-bound _pm_calib_resolve or a seeded finalised
population. Runs under test_request_context so url_for (the lock_url) resolves. This
suite writes, so it takes a fresh copy.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("AI+ calibration assistant (performance axis)")
SU, _BG, _EMP = H.actors(a)
KW = {"hod_id": 9001}


def _adj_count(db):
    return db.execute("SELECT COUNT(*) c FROM pm_calibration_adjustments").fetchone()["c"]


with a.app.test_request_context():
    db = a.get_db()
    CID = a.active_pm_period(db)["id"]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))   # Calibration is Year-End only (2026-09-28)
    db.commit()
    # Three real subjects in one business group = one HOD scope. Overalls are SUPPLIED
    # (what pm_final_overalls would return), so we don't seed a finalised chain.
    pop = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                     "ORDER BY id LIMIT 3").fetchall()
    BG = pop[0]["business_group"] or ""
    A, B, C = pop[0], pop[1], pop[2]
    overalls = {A["id"]: {"label": "OU"}, B["id"]: {"label": "OU"}, C["id"]: {"label": "OU"}}


def fresh_ctx():
    """Rebuilt each call against the CURRENT connection, so a write in one check is
    visible to the next (and it is safe across separate request contexts)."""
    d = a.get_db()
    sess = d.execute(
        "SELECT * FROM pm_calibration_sessions WHERE cycle_id=? AND tier='hod' AND scope_key=?",
        (CID, "9001")).fetchone()
    return {"period": {"id": CID}, "population": pop, "session": sess, "overalls": overalls,
            "scope_key": "9001", "scope_label": "Test Dept", "business_group": BG}


# ---------------------------------------------------------------------------
s.section("_pm_calib_apply -- the shared write path (grid route + move_band)")
with a.app.test_request_context():
    db = a.get_db()
    before = _adj_count(db)
    subj, err = a._pm_calib_apply(db, SU, fresh_ctx(), "hod", A["id"], "ME", "solid year")
    s.check("a valid move writes an adjustment", err is None and _adj_count(db) == before + 1, (err,))
    s.check("...with the band it was set to",
            db.execute("SELECT adjusted_band FROM pm_calibration_adjustments WHERE subject_id=?",
                       (A["id"],)).fetchone()["adjusted_band"] == "ME")
    _, err = a._pm_calib_apply(db, SU, fresh_ctx(), "hod", 99990001, "ME", "x")
    s.check("a subject outside the scope is refused", err is not None)
    _, err = a._pm_calib_apply(db, SU, fresh_ctx(), "hod", B["id"], "ZZZ", "x")
    s.check("an unknown band is refused", err is not None)
    ctx_nofinal = fresh_ctx(); ctx_nofinal["overalls"] = {}
    # 2026-09-29: an HOD or BU CEO may band someone whose score isn't finalised; the BG CEO and a group may not.
    _, err = a._pm_calib_apply(db, SU, ctx_nofinal, "bgceo", B["id"], "ME", "x")
    s.check("a BG CEO still can't band someone whose rating isn't final", err is not None, err)
    _nb = _adj_count(db)
    _subj, err = a._pm_calib_apply(db, SU, ctx_nofinal, "hod", C["id"], "BE", "set before the score was approved")
    _orig = db.execute("SELECT original_band FROM pm_calibration_adjustments WHERE subject_id=?", (C["id"],)).fetchone()
    s.check("...an HOD can: the band is written, with an EMPTY original (nothing came in)",
            err is None and _adj_count(db) == _nb + 1 and _orig is not None and (_orig["original_band"] or "") == "",
            (err, _orig and dict(_orig)))
    db.execute("DELETE FROM pm_calibration_adjustments WHERE subject_id=?", (C["id"],)); db.commit()
    ctx_locked = fresh_ctx()
    ctx_locked["session"] = {"locked_at": "2026-01-01"}
    _, err = a._pm_calib_apply(db, SU, ctx_locked, "hod", B["id"], "ME", "x")
    s.check("a locked scope is refused", err is not None)

_src = H.source(a)
s.check("the grid adjust route uses the shared _pm_calib_apply",
        "_pm_calib_apply(db, u, ctx, tier, subject_id, new_band, justification)" in _src)
s.check("the move_band tool uses the shared _pm_calib_apply",
        '_pm_calib_apply(db, u, ctx, tier, subj["id"], band, justification, dry_run=held)' in _src)

# ---------------------------------------------------------------------------
s.section("_calib_resolve_subject -- name/id -> a person in scope, never outside it")
with a.app.test_request_context():
    ctx = fresh_ctx()
    p, err = a._calib_resolve_subject(ctx, str(A["id"]))
    s.check("a numeric id in scope resolves", bool(p) and p["id"] == A["id"])
    p, err = a._calib_resolve_subject(ctx, "99990001")
    s.check("a numeric id OUTSIDE scope is refused", p is None and bool(err))
    p, err = a._calib_resolve_subject(ctx, A["full_name"])
    s.check("an exact name resolves", bool(p) and p["id"] == A["id"])
    p, err = a._calib_resolve_subject(ctx, "Nobody McNobody")
    s.check("an unknown name is refused", p is None and bool(err))

# ---------------------------------------------------------------------------
s.section("the tools: move_band writes, the read tools write nothing")
with a.app.test_request_context():
    db = a.get_db()
    before = _adj_count(db)
    r0 = a._calib_tool_move_band(db, SU, fresh_ctx(), "hod", KW,
                                 {"subject": B["full_name"], "band": "Above Expectation",
                                  "justification": "stretch delivered"})
    s.check("an HOD's move_band with no save asked for HOLDS: their page gets it, nothing is written (Chris, "
            "2026-10-06: the final save has its confirmation)",
            r0.get("ok") and r0.get("held") and r0.get("band_code") == "AE" and _adj_count(db) == before, r0)
with a.app.test_request_context("/", method="POST",
                                data={"message": "set them to Above Expectation, stretch delivered, and save the band"}):
    db = a.get_db()
    before = _adj_count(db)
    r = a._calib_tool_move_band(db, SU, fresh_ctx(), "hod", KW,
                                {"subject": B["full_name"], "band": "Above Expectation",
                                 "justification": "stretch delivered"})
    s.check("move_band accepts a FULL band label and writes (the save asked for)",
            r.get("ok") and not r.get("held") and _adj_count(db) == before + 1, r)
    s.check("...storing the mapped band code",
            db.execute("SELECT adjusted_band FROM pm_calibration_adjustments WHERE subject_id=?",
                       (B["id"],)).fetchone()["adjusted_band"] == "AE")
    before = _adj_count(db)
    a._calib_tool_show_distribution(db, SU, fresh_ctx(), "hod", KW, {})
    a._calib_tool_suggest_to_framework(db, SU, fresh_ctx(), "hod", KW, {})
    a._calib_tool_explain_person(db, SU, fresh_ctx(), "hod", KW, {"subject": A["full_name"]})
    lock = a._calib_tool_prepare_lock(db, SU, fresh_ctx(), "hod", KW, {})
    s.check("show/suggest/explain/prepare_lock write NOTHING", _adj_count(db) == before)
    s.check("show_distribution returns a render card",
            "render" in a._calib_tool_show_distribution(db, SU, fresh_ctx(), "hod", KW, {}))
    s.check("prepare_lock returns a terminal lock card",
            lock.get("ready") and lock.get("render", {}).get("type") == "calib_lock")
    breaches = a._pm_calib_lock_breaches(db, "hod", fresh_ctx(), fresh_ctx()["session"])
    s.check("prepare_lock's breach message reflects _pm_calib_lock_breaches",
            bool(lock["render"]["data"].get("breach_message")) == bool(breaches), (breaches,))
    s.check("explain_person is subject-scoped (returns THAT person)",
            a._calib_tool_explain_person(db, SU, fresh_ctx(), "hod", KW,
                                         {"subject": A["full_name"]})["person"]["name"] == A["full_name"])
    s.check("explain_person refuses a name not in scope",
            a._calib_tool_explain_person(db, SU, fresh_ctx(), "hod", KW,
                                         {"subject": "Nobody"}).get("ok") is False)

# ---------------------------------------------------------------------------
s.section("the overview -- distribution + roster, rebuilt from state")
with a.app.test_request_context():
    db = a.get_db()
    ov = a._pm_calib_assist_overview(db, SU, fresh_ctx(), "hod", KW)
    d = ov["data"]
    s.check("overview is tagged calib_overview", ov["type"] == "calib_overview")
    s.check("the roster has a row per subject", len(d["rows"]) == 3, len(d["rows"]))
    s.check("a moved subject is flagged adjusted in the roster", any(r["adjusted"] for r in d["rows"]))
    s.check("the lock_url points at the existing lock route",
            "/performance/calibration" in d["lock_url"] and "lock" in d["lock_url"])
    s.check("it carries the distribution + tolerance + breaches",
            "distribution" in d and "tolerance" in d and "breaches" in d)
    _cv = a.pm_curve_for(db, fresh_ctx()["period"]["id"], fresh_ctx()["business_group"], pop[0]["company"])
    s.check("the curve carries the PAT figure that picks it, and whose it is (the unit's own: the group has none since 2026-10-27) -- for the "
            "'BU PAT n%' chip (Chris, 2026-10-05)",
            {k: d["curve"].get(k) for k in ("pct", "entered", "scope")}
            == {"pct": _cv["pct"], "entered": _cv["entered"], "scope": _cv["scope"]}, (d["curve"], _cv))

# ---------------------------------------------------------------------------
s.section("the gate -- model must be reachable; ZZ demo or the global switch")
with a.app.test_request_context():
    db = a.get_db()
    _real_avail = a.ai_draft.review_agent_available
    try:
        a.ai_draft.review_agent_available = lambda: False
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('ai_calib','1')"); db.commit()
        s.check("model unreachable -> OFF even with the flag on", a._calib_assist_on(SU) is False)
        a.ai_draft.review_agent_available = lambda: True
        db.execute("DELETE FROM app_settings WHERE key='ai_calib'"); db.commit()
        # ON by default since the AI+ way went to everyone (2026-10-08); '0' switches it off
        s.check("model on and the flag unset -> ON (the AI+ way, 2026-10-08)", a._calib_assist_on(SU) is True)
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('ai_calib','0')"); db.commit()
        s.check("model on and the flag '0' -> OFF for a normal user", a._calib_assist_on(SU) is False)
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('ai_calib','1')"); db.commit()
        s.check("model on + global flag -> ON", a._calib_assist_on(SU) is True)
        db.execute("DELETE FROM app_settings WHERE key='ai_calib'"); db.commit()
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('ai_calib','0')"); db.commit()
        zz = dict(SU); zz["employee_id"] = "ZZTEST-CALIB"
        s.check("model on + a ZZ demo account -> ON even with the flag off",
                a._calib_assist_on(zz) is True)
    finally:
        a.ai_draft.review_agent_available = _real_avail
        db.execute("DELETE FROM app_settings WHERE key='ai_calib'"); db.commit()

# ---------------------------------------------------------------------------
s.section("wiring: routes classified 'pm' via the /performance prefix; toggle + reset")
with a.app.test_request_context():
    s.check("the assist page route resolves to the pm module",
            a.module_of_request("pm_calib_assist_hod", "/performance/calibration/assist/hod/5") == "pm")
    s.check("the chat route resolves to the pm module",
            a.module_of_request("pm_calib_chat", "/performance/calibration/assist/chat") == "pm")
s.check("the admin toggle branch + the reset-approval hardening are present",
        'action == "calib_assist"' in _src and "DELETE FROM pm_kpi_approvals WHERE kpi_target_id IN" in _src)

# ---------------------------------------------------------------------------
s.section("Calibration in the review journey's leader view -- Dept for an HOD (Chris, 2026-09-25, moved 2026-09-30)")
_real_scope, _real_tiers = a._journey_calib_scope, a.calibration_tier_of
try:
    a._journey_calib_scope = (lambda db_, u_, fresh=False, tier=None:
                              ("hod", KW, fresh_ctx()) if tier in (None, "hod") else None)
    a.calibration_tier_of = lambda db_, u_: [("hod", 9001)]
    with a.app.test_request_context("/review/journey?view=dept"):
        from flask import session as _sess
        db = a.get_db()
        _sess["user_id"] = SU["id"]
        _u = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        _st = {"period": {"half": 2}, "stages": [{"key": k, "group": "team", "state": "open", "short": k, "module": m}
                          for k, m in (("pm_review", "pm"), ("tm_review", "tm"), ("plan_review", "idp"))]}
        _live = [x["key"] for x in a._journey_team_live_stages(_st, "team")]
        s.check("Team is the direct-report reviews only -- calibration moved out of it",
                _live == ["pm_review", "tm_review", "plan_review"], _live)
        _dept = [x["key"] for x in a._journey_team_live_stages(_st, "dept")]
        s.check("...and into the HOD's Dept view", _dept == ["calibration"], _dept)
        s.check("...the request's own view resolves to Dept", a._journey_req_view(db, _u) == "dept"
                and a._journey_leader_views(db, _u) == ["dept"], a._journey_leader_views(db, _u))
        _mt = a._review_manages_team
        a._review_manages_team = lambda db_, u_: False
        try:
            s.check("...which counts as a manager-side view even with no direct reports of their own (the offers "
                    "still work), and the toggle is Mine | Dept", a._review_manages(db, _u)
                    and a._journey_views(db, _u) == ["mine", "dept"], a._journey_views(db, _u))
        finally:
            a._review_manages_team = _mt
        _ov = a._journey_team_overview(db, _u, "calibration", None)
        s.check("its widget is the assistant's: the distribution vs the curve + the roster, returning here on lock",
                _ov["stage"] == "calibration" and "distribution" in (_ov["data"] or {}) and (_ov["data"] or {}).get("rows")
                and "/review/journey" in _ov["data"].get("return_to", ""), _ov)
        _task = a._journey_team_stage_task(db, _u, "calibration", None)
        s.check("its task is the calibration assistant's (framework, roster, move_band, prepare_lock), no repeated guard",
                "CALIBRATION" in _task and "move_band{subject, band, justification}" in _task
                and "prepare_lock{}" in _task and "SCOPE -- stay on task" not in _task)
        _nav = a._journey_team_nav_items(db, _u, "calibration")
        s.check("the navigator lists the people in scope, with where they sit now",
                _nav["kind"] == "calib" and len(_nav["items"]) == 3 and all(it["meta"] for it in _nav["items"]), _nav)
        s.check("...and it is one conversation for the whole scope, not a person at a time",
                a._journey_active_report(db, _u, "calibration", str(A["id"])) is None)
        db.execute("INSERT INTO pm_manager_chat(reviewer_id, cycle_id, report_id, stage, role, content) "
                   "VALUES (?,?,NULL,'calibration','user','Who is over the curve?')", (SU["id"], a.active_cycle_id(db)))
        db.commit()
        s.check("...kept as its own thread", any(m["content"] == "Who is over the curve?" for m in
                a._manager_chat_history(db, _u, a.active_cycle_id(db), None, stage="calibration")))
        before = _adj_count(db)
        _mv = a._journey_team_run_stage_tool(db, _u, a.active_cycle_id(db), "calibration", None,
                                             {"tool": "move_band", "args": {"subject": C["full_name"], "band": "AE",
                                                                             "justification": "Delivered on target only."}})
        s.check("a move through the journey runs the assistant's validated move_band (the grid's own checks) -- an "
                "HOD's holds for their page's Save, nothing written (2026-10-06)",
                _mv.get("ok") and _mv.get("held") and _mv.get("band_code") == "AE" and _adj_count(db) == before, _mv)
        _lk = a._journey_team_run_stage_tool(db, _u, a.active_cycle_id(db), "calibration", None,
                                             {"tool": "prepare_lock", "args": {}})
        s.check("...and prepare_lock shows the Lock card, which comes back to the journey",
                (_lk.get("render") or {}).get("type") == "calib_lock"
                and "/review/journey" in (_lk["render"]["data"].get("return_to") or ""), _lk.get("render", {}).get("type"))
        s.check("inside Dept, a named 'Potential calibration' is no part there when that axis has no scope -- nothing "
                "moves", a._journey_team_stage_pick(_st, "calibration", "Go to Potential calibration") is None)
    with a.app.test_request_context("/x", method="POST", data={"return_to": "/review/journey?view=team&stage=calibration"}):
        s.check("the lock returns to the journey when it came from there", a._pm_calib_back("hod", **KW).startswith("/review/journey"))
    with a.app.test_request_context("/x", method="POST", data={"return_to": "//evil.example/review/journey"}):
        s.check("...never anywhere else", not a._pm_calib_back("hod", **KW).startswith("//"))
finally:
    a._journey_calib_scope, a.calibration_tier_of = _real_scope, _real_tiers
_tpl = open(os.path.join(H.REPO, "templates", "_journey_modtabs.html"), encoding="utf-8").read()
_jsj = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
s.check("the top tabs carry a Calibration module; the page draws its widget, cards and people",
        "('cal', 'DR' if _dept else 'CAL', 'Department Review' if _dept else 'Calibration'," in _tpl
        and "'clipboard-check' if _dept else 'sliders')" in _tpl
        and "function calibWidget(" in _jsj
        and 'card.type === "calib_lock"' in _jsj and '["return_to", d.return_to || ""]' in _jsj
        and 'if (kind === "calib")' in _jsj
        and 'if (stage === "calibration" || stage === "calibration_pot") return calibWidget(data);' in _jsj)

# ---------------------------------------------------------------------------
s.section("person by person first (2026-09-28): self-refusal, the per-person figures, the calibrator's AI insight")
with a.app.test_request_context():
    db = a.get_db()
    me_in_scope = dict(A)
    _, err = a._pm_calib_apply(db, me_in_scope, fresh_ctx(), "hod", A["id"], "AE", "my own")
    s.check("nobody calibrates their own band (the write path refuses it)",
            err is not None and "own band" in err, err)
# the per-person figures on each row, batched
with a.app.test_request_context():
    db = a.get_db()
    ov = a._pm_calib_assist_overview(db, SU, fresh_ctx(), "hod", KW)["data"]
    r0 = ov["rows"][0]
    s.check("each row carries the card's fields: score, own score, who they are, the trail, is_self",
            all(k in r0 for k in ("score", "mechanism", "self_score", "self_band", "department", "job_title",
                                  "job_grade", "trail", "is_self")), sorted(r0.keys()))
_src2 = H.source(a)
s.check("the trail is cut at the calibrator's own seat (below=tier) -- never a higher tier's note",
        'pm_calibration_trails(db, [r["user"] for r in rows], ctx["period"]["id"], below=tier)' in _src2)
# the calibrator's source: every line, and the manager's remark only once every line is locked
with a.app.test_request_context():
    db = a.get_db()
    if not db.execute("SELECT 1 FROM pm_bg_config WHERE business_group='ZZCAL BG'").fetchone():
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES ('ZZCAL BG', 'A')")
    t1 = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                    "business_group, rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?,100,'more','approved',"
                    "'ZZCAL BG',1,2,3,4,5)", (CID, B["id"], "ZZCAL Output")).lastrowid
    # B's other (seeded) lines may sit in a Mechanism-B BG with no threshold -- the known scoring error; the
    # calibrator source scores ALL their lines, so keep B to this one line for the test.
    db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? AND id<>?", (CID, B["id"], t1))
    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)",
               (t1, 4, B["id"]))
    db.execute("INSERT INTO pm_manager_remarks(cycle_id, subject_id, remark, submitted_by) VALUES (?,?,?,?)",
               (CID, B["id"], "Half-written manager thou", SU["id"]))
    db.commit()
    st, _f, words, _x, facts = a._pm_perf_source(db, SU, B["id"], scope="calibrator")
    s.check("the calibrator's source reads the person's lines even though the calibrator approves none of them",
            st == "submitted" and any(r["kpi"] == "ZZCAL Output" for r in facts["rows"]), (st, facts.get("rows")))
    s.check("...and holds the manager's remark back while a line is still open (it autosaves as they type)",
            facts.get("mgr_remarks") == [] and "Half-written" not in words, facts.get("mgr_remarks"))
    s.check("once every line is locked the remark is in, attributed",
            a._pm_manager_remarks_locked(db, CID, B["id"], True)[0]["remark"] == "Half-written manager thou")
    st2, *_rest = a._pm_perf_source(db, SU, B["id"])
    s.check("the approver scope is unchanged (a non-approver sees nothing of theirs)", st2 == "none", st2)
# the route: scope re-derived, never yourself, its own cache
_real_scope = a._journey_calib_scope
a._journey_calib_scope = lambda db, u, fresh=False: ("hod", KW, fresh_ctx())
try:
    cS = H.client_as(a, C["id"])   # a real (non-admin) calibrator: the review pages turn admins away
    with a.app.app_context():
        a.get_db().execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','pm')")
        a.get_db().commit()
    r_in = cS.post("/review/team/calib-summary", data={"csrf_token": "tok", "report": B["id"]})
    j_in = r_in.get_json() or {}
    s.check("a person in your scope gets an insight (plain when the model is off)",
            r_in.status_code == 200 and j_in.get("ok") and j_in.get("summary"), (r_in.status_code, j_in))
    s.check("...cached per SCOPE in pm_calib_summaries, never the approver cache",
            H.one(a, "SELECT COUNT(*) FROM pm_calib_summaries WHERE subject_id=? AND tier='hod' AND scope_key='9001'",
                  (B["id"],)) == 1
            and H.one(a, "SELECT COUNT(*) FROM pm_perf_summaries WHERE subject_id=?", (B["id"],)) == 0)
    _kt = j_in.get("kpi_table") or {}
    s.check("...and carries their KPI table the way their line manager saw it (2026-10-06): every line with its weight "
            "and rating scale, their figure and rung, the overall by their own results",
            [l["kpi"] for l in _kt.get("lines") or []] == ["ZZCAL Output"]
            and _kt["lines"][0]["weight"] == 100 and len(_kt["lines"][0]["scale"]) == 5
            and _kt["lines"][0]["report_value"] == 4 and _kt["lines"][0]["report_n"] == 4
            and _kt["lines"][0]["mod_value"] is None and (_kt.get("overall_self") or {}).get("value") is not None
            and _kt.get("overall_mod") is None, _kt)
    r_out = cS.post("/review/team/calib-summary", data={"csrf_token": "tok", "report": 99990001})
    s.check("someone outside your scope is refused (404)", r_out.status_code == 404, r_out.status_code)
    cA = H.client_as(a, A["id"])
    r_self = cA.post("/review/team/calib-summary", data={"csrf_token": "tok", "report": A["id"]})
    s.check("...and so is your own record", r_self.status_code == 404, r_self.status_code)
finally:
    a._journey_calib_scope = _real_scope
# the KPI table moderated (2026-10-06): their own figure and rung beside the moderated ones, the final score moderated;
# a line HR filled is marked as HR's (rolled back after, so the checks below see B as before)
with a.app.test_request_context():
    db = a.get_db()
    db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, adjusted_value, justification, "
               "acted_by) VALUES (?,1,'adjust',4,3,'ZZCAL moderated',?)", (t1, SU["id"]))
    t_hr = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                      "business_group, rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?,0,'more','approved',"
                      "'ZZCAL BG',1,2,3,4,5)", (CID, B["id"], "ZZCAL PAT")).lastrowid
    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft, admin_filled) "
               "VALUES (?,?,?,0,1)", (t_hr, 3, SU["id"]))
    kt = a._calib_kpi_table(db, B["id"], CID) or {}
    lm = {l["kpi"]: l for l in kt.get("lines") or []}
    o = lm.get("ZZCAL Output") or {}
    s.check("a moderated line carries both sides: their 4 on rung 4, the moderated 3 on rung 3, and the final score is "
            "the moderated one",
            o.get("report_value") == 4 and o.get("report_n") == 4 and o.get("mod_value") == 3 and o.get("mod_n") == 3
            and o.get("mod_band") and (kt.get("overall_mod") or {}).get("value") is not None, (o, kt.get("overall_mod")))
    s.check("...and a line HR filled is marked as HR's, never the person's", (lm.get("ZZCAL PAT") or {}).get("hr") is True
            and o.get("hr") is False, lm)
    db.rollback()
    db.execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id=?", (t1,))
    db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (t_hr,))
    db.execute("DELETE FROM pm_kpi_targets WHERE id=?", (t_hr,))
    db.commit()
_jsk = H.source(a, "static/journey_chat.js")
_kt0 = _jsk.find("function calKpiTable("); _ktj = _jsk[_kt0:_jsk.find("\n  // Their evidence, as a table", _kt0)]
s.check("client: the person page's KPI table is the line manager's -- weight, the rating scale ladder (their rung struck, "
        "the moderated one lit), their result -> the moderated one, Justified? per KPI, and the final score under it",
        "pmLadderCells(tr, l)" in _ktj and ">Weight</th>" in _ktj and "Justified?</th>" in _ktj
        and '"Final score"' in _ktj and '→ moderated"' in _ktj
        and "kt: j.kpi_table || null" in _jsk and "rest.appendChild(calKpiTable(kt, d))" in _jsk
        and ".rv-cal-kt .rv-rung-head { width: 40px; }" in H.source(a, "static/style.css"))
# the calibrator can open a KPI supporting file of someone in their scope -- shared, KPI-linked only
with a.app.test_request_context():
    db = a.get_db()
    ev = db.execute("INSERT INTO pm_evidence(subject_id, author_id, author_role, kind, occurred_on, state) "
                    "VALUES (?,?, 'self', 'recognition', date('now'), 'shared')", (B["id"], B["id"])).lastrowid
    db.execute("INSERT INTO pm_evidence_links(evidence_id, target_kind, target_ref) VALUES (?, 'kpi', ?)",
               (ev, str(t1)))
    db.commit()
    row = a.evidence_get(db, ev)
    _real_cv = a.calibration_can_view_subject
    a.calibration_can_view_subject = lambda db, viewer, uid: viewer["id"] == 777001
    try:
        s.check("a calibrator whose scope holds them can open it",
                a.evidence_can_view({"id": 777001}, row) is True)
        s.check("...someone else still can't", a.evidence_can_view({"id": 777002}, row) is False)
        db.execute("UPDATE pm_evidence SET state='draft' WHERE id=?", (ev,)); db.commit()
        s.check("...and a DRAFT item stays private even to the calibrator",
                a.evidence_can_view({"id": 777001}, a.evidence_get(db, ev)) is False)
    finally:
        a.calibration_can_view_subject = _real_cv
# the client
_jsc = "".join(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", f_), encoding="utf-8").read() + "\n"
               for f_ in ("journey_chat.js", "calib_shared.js"))   # the curve box moved to the shared module (2026-10-30)
_cw0 = _jsc.find("function calibWidget("); _cw = _jsc[_cw0:_jsc.find("\n  }\n", _cw0)]
_fm0 = _jsc.find("function calSheetMode("); _fm = _jsc[_fm0:_jsc.find("\n  }\n", _fm0)]
s.check("client: the calibration card opens on the CURVE (2026-09-30); person by person -- only when asked "
        "(?phase=people, Open on their row) -- is a sheet beside the curve folded into a live column (2026-10-09, "
        "in place of the dimmed curve of 2026-10-08), no side strips",
        'cal.phase = _ph === "people" ? "people" : "curve";' in _jsc
        and 'if (cal.phase === "people" && rows.length) return calSheetMode(d, box);' in _cw
        and "bezelWrap(" not in _cw and "bezelWrap(" not in _fm
        and "body.appendChild(sheetLayer(r.name, calPersonPane(d, r), sheetClose));" in _fm
        and "body.appendChild(calFold(d, r));" in _fm and _fm.index("calFold(d, r)") < _fm.index("sheetLayer(")
        and "calFoldMode" not in _jsc and "function calUnderView(" not in _jsc and "rv-sheet-veil" not in _jsc)
s.check("client: the insight is fetched one person at a time from the calibrator route -- the person on screen and the "
        "next one AHEAD of the background prefetch, everyone readable queued in the background on the curve",
        '"/review/team/calib-summary"' in _jsc and "queueCalSummary(r.id, axis, true)" in _fm
        and "queueCalSummary(nx.id, axis, true)" in _fm and "calPrefetchAll(d)" in _cw and "calPrefetchAll(d)" in _fm
        and "if (front) calSumQueue.unshift(k); else calSumQueue.push(k);" in _jsc
        and 'var ok = axis === "potential" ? r.valid : (r.finalised || r.awaiting_lm);' in _jsc)
s.check("client: the background queue stops when they leave the calibration (the Talent Box's person page uses it "
        "too, 2026-10-05)",
        'if (!(isMgr && (curStage === "calibration" || curStage === "calibration_pot" || curStage === "talent_box"))) {\n'
        '      calSumQueue = []; return; }' in _jsc)
s.check("client: every calibration request says which view it comes from (so a leader view reaches its own scope)",
        _jsc.count('f.append("view", curView)') >= 5)
s.check("client: the navigator pages the card to that person, no chat turn",
        "if (calGoTo(id)) { markNavCurrent(el); return; }" in _jsc)
s.check("client: a move refreshes the card in place (it used to go stale) -- on the curve keeping the roster's scroll",
        'if (stage === "calibration" || stage === "calibration_pot") { if (cal.phase === "curve" && calLive()) '
        'calRedrawCurve(data); else swapStageBody(calibWidget(data)); return; }' in _jsc)
s.check("prompt: the assistant talks about the curve first, person by person when asked",
        "THE CURVE FIRST" in _src2 and "PERSON BY PERSON FIRST" not in _src2)
# THE UI AUDIT (2026-09-29; Chris: "this doesn't even pass the basic UI read flow"): one column, read top to bottom --
# who + their rating -> the verdict and ONE reason -> their evidence (a table) -> their remark -> what to check. The
# name once, no band control on the card (bands move on the curve), a title bar with the way on.
_pc0 = _jsc.find("function calPersonCard("); _pc = _jsc[_pc0:_jsc.find("\n  function calTitleBar(", _pc0)]
s.check("client: the person card itself has NO band control (no select, no move sentence, no 'Ask about <name>') -- the "
        "BU CEO's band is a bar pinned under their page since 2026-10-07 (calCurveBar), never inside the card",
        _pc0 > 0 and "<select" not in _pc and 'createElement("select")' not in _pc and "sendTurn(" not in _pc
        and "Ask about" not in _pc)
s.check("client: the person card reads top to bottom -- the name (an h3, said once), the rating, then the verdict block, "
        "then the rest (evidence, remark, steps); no two-column grid anywhere",
        'createElement("h3")' in _pc and _pc.find('"rv-cal-rating"') < _pc.find('"rv-cal-verdict"') < _pc.find('"rv-cal-rest"')
        and "rv-psc-grid" not in _jsc and "function pmSummaryCompact(" not in _jsc)
_sp0 = _jsc.find("function calSumPaint("); _sp = _jsc[_sp0:_jsc.find("\n  function calTarget(", _sp0)]
s.check("client: the verdict sits with its question, its pill and the CASE paragraph for performance (2026-10-05: "
        "'similar like potential calibration'), potential's own read; then the evidence table, their remark, the steps "
        "-- in that order (2026-10-05: what they, their line manager and the HOD wrote, summarised, now sits in the "
        "verdict block itself, before the evidence)",
        '"Are their results justified by evidence?"' in _sp and "verdictPill(d.verdict)" in _sp
        and "(pot ? d.read : (d.paragraph || d.read)) || d.verdict_why" in _sp
        and _sp.find("calRemarksPart(card._calRow") < _sp.find("calKpiTable(kt, d)") < _sp.find("calEvidenceTable(d)")
        < _sp.find("calSteps(d.discuss"))
_fp = _jsc[_jsc.find("function calFitPerson("):_jsc.find("var calFitTimer = null;")]
_css_sp = H.source(a, "static/style.css")
s.check("client: one person's page scrolls INSIDE the card (2026-10-05: 'expand the spacing and make it scrollable') -- "
        "beside the fold (2026-10-07) the fold and the page share one body sized to the room the chat has, after every "
        "paint and on resize; the page scrolls between its header and its pinned decision, an HOD's too",
        "function calFitPerson()" in _jsc and 'else if (cal.phase === "people") calFitPerson();' in _jsc
        and "calFitPerson();" in _jsc.split("var calFitTimer = null;", 1)[1][:600]
        and 'body = node.querySelector(".rv-cal-sbody")' in _fp and 'body.classList.add("is-fixed");' in _fp
        and "cal.data.review" not in _fp and "rv-cal-noscroll" not in _fp and "card.tabIndex = 0;" in _jsc
        and ".rv-cal-people .rv-cal-person { gap: 16px;" in _css_sp and "overflow-y: auto;" in _css_sp
        and ".rv-cal-people .rv-cal-person > * { flex: none; }" in _css_sp)
_room = _jsc[_jsc.find("var calRoomTimer = null"):][:700]
s.check("client: the page refits when the chat's own room changes with no window resize -- chips arriving with a "
        "person's page once hid an HOD's Your review bar (Chris, 2026-10-21); a refit only, the scroll stays theirs",
        "new ResizeObserver(function () {" in _room and ".observe(log);" in _room
        and "if (log.clientHeight === calRoomH) return;" in _room
        and 'if (cal.phase === "people") calFitPerson();' in _room
        and 'else if (cal.phase === "curve") calFitRoster();' in _room and "scrollTop" not in _room, _room[:120])
_cbar =_jsc[_jsc.find("function calCurveBar(d, r) {"):_jsc.find("function calPageKey(dir, from) {")]
_fcv = _jsc[_jsc.find("function calFoldCurve(d, key) {"):_jsc.find("function calPersonPane(d, r) {")]
s.check("client: the BU CEO's band is back on their page (Chris, 2026-10-07: 'with this, we can apply the band dropdown "
        "back for BUCEO') -- the curve's own select pinned under the page, saving at once (calMove) with the remark "
        "beside it, read only once locked; where they sit on the curve is in the column beside their page -- a bar per "
        "band against its expected share, theirs ringed, the verdict in one line (2026-10-09)",
        'sel.addEventListener("change", function () { calMove(r, sel); });' in _cbar and "calRemarkBtn(r, sel, false)" in _cbar
        and "if (d.locked || r.super_override) {" in _cbar and '"rv-cal-status rv-cal-pbar-st"' in _cbar
        and '"rv-cal-fcrow" + (b === key ? " is-here" : "")' in _fcv and '"Within the curve."' in _fcv
        and "hd.appendChild(calPager(d));" in _jsc and "calSheetContext" not in _jsc
        and ".rv-stage-card:has(.rv-calib-pin.rv-tc-pin) { width: 100%; }" in _css_sp)
s.check("client: the evidence is a table (KPI | Result | Target | Band | File | Justified?), the three most at risk "
        "first and the rest behind one button; justification is a glyph + a word, not a colour alone",
        "<th>KPI</th><th>Result</th><th>Target</th><th>Band</th><th>File</th>" in _jsc
        and "if (idx >= 3)" in _jsc and '" more KPI"' in _jsc and 'JUST_GLYPH = { yes: "\u2713"' in _jsc)
s.check("client: the whole remark and their KPI notes are one real button away (a pop-out that gives focus back)",
        '"Read the remarks in full"' in _jsc and "returnFocus: b" in _jsc and "opts.returnFocus.focus()" in _jsc)
_cw1 = _jsc.find("function calTitleBar("); _tb = _jsc[_cw1:_jsc.find("\n  function calToCurve(", _cw1)]
s.check("client: ONE title bar -- 'Performance Calibration' (or Potential), the same in both views (2026-10-07: a person's "
        "page opens beside the fold, 'n of N' is its pager's); no Curve | Person by person toggle (2026-10-07: a name "
        "opens their page beside the fold, its bezel returns); no old 'Skip to the curve'",
        'function calTitle(d) { return (d && d.axis === "potential") ? "Potential Calibration" : "Performance Calibration"; }'
        in _jsc and 'rmkEl("span", "rv-cal-title", calTitle(d))' in _tb and 'if (phase === "people")' not in _tb
        and '"Person " + (i + 1)' not in _tb and 'rmkEl("span", "rv-tbox-pgn", (nb.k + 1) + " of " + nb.list.length)' in _jsc
        and "calViewToggle" not in _jsc and '"Person by person"]' not in _jsc and "function calTitleBar(d) {" in _jsc
        and "rv-cal-viewseg" not in H.source(a, "static/style.css")
        and '"Skip to the curve"' not in _jsc and "Back to person by person" not in _jsc
        and "sectionNav(" not in _cw and '"Calibration" + (d.scope_label' not in _cw)
s.check("client: on the curve, a performance calibration (not an HOD's department review) shows the PAT that picks it, "
        "the BU's, with the curve's name, in one chip in place of the second line",
        'd.axis !== "potential" && !d.review && d.curve && "entered" in d.curve' in _tb
        and '"rv-cal-pat"' in _tb and '"BU " + tbPat(d.curve.pct)' in _tb
        and '"PAT not entered"' in _tb)
s.check("client: the calibration card is never machine-translated (band codes and tier headers are not words)",
        'box.setAttribute("translate", "no");' in _cw and "rv-calib-pin notranslate" in _cw)
_pg = _jsc[_jsc.find("function calPager(d) {"):_jsc.find("function calCurveBar(d, r) {")]
s.check("client: a person's page has a pager -- 'Previous person' / 'Next person', 'n of N' through the list they came "
        "from (the summary's order, or its band filter), the ends stop; the arrow keys page it (never from a tab, never "
        "with the remark box open) and the sheet's bezel returns (no back button since 2026-10-08)",
        'b.title = dir === "prev" ? "Previous person · ←" : "Next person · →";' in _pg and "if (!to) b.disabled = true;" in _pg
        and 'calOpenPerson(to.id, ".rv-cal-pgbtn.is-" + dir)' in _pg
        and 'if (calPageKey(e.key === "ArrowLeft" ? "prev" : "next", t)) { e.preventDefault(); return; }' in _jsc
        and "if (!calLive() || cal.phase !== \"people\" || calRmkPop || sheetClosing || !log) return false;" in _jsc
        and "function calPageList(d)" in _jsc and "drFilter[curStage]" in _jsc[_jsc.find("function calPageList(d)"):_jsc.find("function calNeighbours(d)")]
        and 'bz.addEventListener("click", function () { onClose("bezel"); });' in _jsc
        and 'if (kind === "cal") {\n        if (calLive() && cal.phase === "people") {' in _jsc and "\n          calToCurve();\n" in _jsc
        and "ppback" not in _jsc)
s.check("client: the chips follow the page and never carry a name (the name is on the card once); a part move the "
        "server offered is kept",
        "function calChips(" in _jsc and '"Ask about this person"' in _jsc and '"Next person"' in _jsc
        and "if (calLive()) { cal.serverChips = (j && j.quick_replies) || []; cal.serverChipsFor = calPersonOnScreen();"
        in _jsc)
s.check("client: after a page change the card's top comes to the chat's top, the navigator marks who is on screen, "
        "and one status line says where they are (the card itself is not a live region)",
        "calAnchorPending" in _jsc and 'node.setAttribute("aria-live", "off")' in _jsc
        and 'data-kind="calib"][data-item-id="' in _jsc and '"Person " + (cal.i + 1) + " of "' in _jsc)
_ro0 = _jsc.find("function calibRoster("); _ro = _jsc[_ro0:_jsc.find("\n  // The calibrator's AI insight", _ro0)]
s.check("client: the curve's roster follows the calibration page's columns -- Justified?, Self, LM (, HOD) and this "
        "tier's band as a compact band-code select; a change SAVES IN PLACE (no chat turn); Open pages the card",
        ">Justified?</th>" in _ro and '"rv-cal-chh' in _ro and "(r.chain || []).forEach(" in _ro
        and 'createElement("select")' in _ro and "calMove(r, sel)" in _ro and "calOpenPerson(r.id)" in _ro
        and 'sendTurn("Move "' not in _ro and 'sel.classList.add("is-default")' in _ro
        and 'sband.appendChild(calMark("late", calLateText(r.late, r.current_band, "you", true)))' in _ro
        and 'oband.appendChild(calMark("late", calLateText(r.late, r.current_band, "you", false)))' in _ro
        and 'calMark("late", calLateText({ now: c.late, who: "LM" }, c.band, "the HOD", live && !d.locked))' in _ro
        and "score now final" not in _jsc)
_css_ro = H.source(a, "static/style.css")
s.check("client: the curve's roster says each thing on ONE line (Chris, 2026-10-06: 'This table just look very "
        "cluttered') -- no word under a pill (360 only, LM now, moved, your own, UA by default are marks or the select's "
        "outline, their words on hover); their key is an (i) in the header's empty corner, never a line under the table, "
        "and has no UA by default ('remove the label UA by default so the table can extend'); their own row says who "
        "sets their band, never an empty ringed pill ('what is this dash referring to?'); the name and its department "
        "line cut with an ellipsis, the full words on hover",
        '"rv-cal-tag' not in _ro and "potBasisMark(pc, pc, r)" not in _ro and "\\u270e" not in _ro
        and 'pin.appendChild(calMark("basis"' in _ro
        and 'sel.classList.add("is-moved")' in _ro and "function calKey(used)" in _jsc
        and 'var tha = tbl.querySelector("th.rv-cal-tha"); if (tha) tha.appendChild(key);' in _ro
        and "calLegend" not in _jsc and "rv-cal-legend" not in _css_ro and "UA by default" not in
            _jsc[_jsc.find("var CAL_KEY = ["):_jsc.find("function calKey(used)")]
        and '"Set by " + above' in _ro and 'r.is_self ? "" : "rv-cal-ring"' in _ro
        and "nmEl.title = r.name" in _ro and "ps.title = sub" in _ro
        and ".rv-calib-roster .rv-cal-pname, .rv-calib-roster .rv-cal-psub { white-space: nowrap; overflow: hidden; "
            "text-overflow: ellipsis; }" in _css_ro
        and ".rv-cal-cband > .rv-cal-mk.is-late" in _css_ro)
_ap0 = _jsc.find("function calAfterPaint("); _apb = _jsc[_ap0:_jsc.find("\n  }\n", _ap0)]
s.check("client: the person last read on their page is marked on the curve and brought into view on the way back -- "
        "both parts, per part (Chris, 2026-10-06: 'when i finished reading the detailed report and go back to the curve "
        "view, I can easily spot the one'); a band change keeps the scroll (once, from a page only)",
        "var calLastRead = {}, calPrevPhase = null;" in _jsc and "calLastRead[curStage] = id;" in _apb
        and 'if (cal.phase === "curve" && calPrevPhase === "people") calShowLastRead(node);' in _apb
        and 'tr.classList.add("is-lastread"); tr.setAttribute("aria-current", "true");' in _ro
        and "function calShowLastRead(node)" in _jsc
        and H.cv(".rv-calib-roster .rv-cal-table tr.is-lastread td { background: #eef3ff; }") in _css_ro)
_cmr = _jsc.split("function calMarkRow(id) {", 1)[1].split("\n  }\n", 1)[0] if "function calMarkRow(id) {" in _jsc else ""
s.check("client: the row you're working on is the one marked (Chris, 2026-10-07, after the Talent Box's Move: 'apply the "
        "same for dept review and BUCEO calibration') -- the band select you're on or change, a remark you open, a tick in "
        "the department review -- in place (no redraw), the mark leaving the row it was on",
        "calLastRead[curStage] = String(id);" in _cmr and 'tr.classList.remove("is-lastread")' in _cmr
        and 'tr.classList.add("is-lastread"); tr.setAttribute("aria-current", "true");' in _cmr
        and "swapStageBody" not in _cmr and "calibWidget" not in _cmr
        and 'sel.addEventListener("focus", function () { calMarkRow(r.id); });' in _ro
        and 'sel.addEventListener("change", function () { calMarkRow(r.id); calMove(r, sel); });' in _ro
        and "calMarkRow(r.id);   // the row whose remark is open" in _jsc
        and 'cb.addEventListener("change", function () { calMarkRow(r.id); calReviewTick(cb); calReviewPaintBulk(); });'
        in _jsc)
# the movement, from which band (Chris, 2026-10-07: "apply the highlight for selected person, and the movement for both
# dept review and buceo calibration")
_chm = a._pm_calib_chain({"user": {"id": 1}, "overall": {"label": "ME"}, "current_band": "AE", "adjusted": True,
                          "incoming_band": "AE"}, "buceo", {}, [{"tier": "hod", "band": "AE", "from": "ME"}])
_chk = a._pm_calib_chain({"user": {"id": 1}, "overall": {"label": "ME"}, "current_band": "ME", "adjusted": False,
                          "incoming_band": "ME"}, "buceo", {}, [{"tier": "hod", "band": "ME", "from": "ME"}])
_chp = a._pot_calib_chain({"self_band": "Mid", "lm_band": "Mid", "current_band": "High", "adjusted": False,
                           "incoming_band": "High",
                           "tier_slots": [{"tier": "HOD", "band": "High", "changed": True, "from": "Mid"}]}, "buceo")
s.check("server: the HOD's step on the BU CEO's curve carries the band it moved FROM (performance and potential); a "
        "kept band carries none",
        _chm[2].get("moved") is True and _chm[2].get("from") == "ME" and _chk[2].get("from") is None
        and _chp[2].get("moved") is True and _chp[2].get("from") == "Mid"
        and '"own": is_own, "changed": changed,\n                          "from": eff})' in _src2.split(
            "def attach_tier_chain(", 1)[1].split("\ndef ", 1)[0], (_chm, _chk, _chp))
s.check("client: no '↑ from' line under a band anywhere -- the curve or the department review, performance or potential "
        "(Chris, 2026-10-07: 'check for both dept review and BUCEO calibration (both performance and potential) view on "
        "the \u2191 from line'); the review's changed band says the move on hover",
        "calFromLine" not in _jsc and "rv-cal-from" not in _jsc and "rv-cal-from" not in _css_ro
        and 'chp.title = "You moved them from " + was + " to " + band;' in _jsc)
# a band the HOD KEPT comes through as their band on both axes -- a pill, not a dash (potential used to send None)
_chk2 = a._pot_calib_chain({"self_band": "Mid", "lm_band": "Mid", "current_band": "Mid", "adjusted": False,
                            "incoming_band": "Mid", "hod_band": "Mid",
                            "tier_slots": [{"tier": "HOD", "band": "Mid", "changed": False, "from": "Mid"}]}, "buceo")
_chn = a._pot_calib_chain({"self_band": "Mid", "lm_band": "Mid", "current_band": "Mid", "adjusted": False,
                           "incoming_band": "Mid",
                           "tier_slots": [{"tier": "HOD", "band": "Mid", "changed": False, "from": "Mid"}]}, "buceo")
s.check("server: a band the HOD kept comes through on BOTH axes (performance did; potential sent nothing, so it showed "
        "as a dash) -- and nothing when the HOD recorded nothing",
        _chk[2]["band"] == "ME" and _chk[2]["moved"] is False
        and _chk2[2]["band"] == "Mid" and _chk2[2]["moved"] is False and _chn[2]["band"] is None
        and 'r["hod_band"] = ha["adjusted_band"] if ha else None' in _src2.split(
            "def attach_tier_chain(", 1)[1].split("\ndef ", 1)[0], (_chk[2], _chk2[2], _chn[2]))
_cht = _jsc.split("function calHodTitle(d, c) {", 1)[1].split("\n  }\n", 1)[0] if "function calHodTitle(" in _jsc else ""
s.check("client: the curve's table has no 'from' line under a band (Chris, 2026-10-07: 'we dont need the label for the "
        "first row HOD from BE, since we are showing the self, lm') -- and every HOD band is a colour pill, kept or moved "
        "('why is 02, 03, and 04 HOD band in plain text instead of the colour box?'); a dash only when the HOD recorded "
        "nothing; kept / moved from / set on hover",
        "calFromLine(" not in _ro and 'if (c.tier === "HOD" && !c.band) {' in _ro
        and 'var cpl = calChainPill(c.band); crow.appendChild(cpl);' in _ro
        and 'if (c.tier === "HOD") cpl.title = calHodTitle(d, c);' in _ro
        and "The HOD kept the line manager's band: " in _cht and '"The HOD moved them from " + nm(c.from)' in _cht
        and "(nothing final came in)" in _cht)
_rbtn = _jsc[_jsc.find("function calRemarkBtn("):_jsc.find("function calRemarkClose(")]
s.check("client: the BU CEO's curve shows no HOD remark (Chris, 2026-10-06: 'BUCEO can open the detailed individual page "
        "to read, or refer to the AI summary'), and the calibrator's own remark button is a pen -- never the AI insight's "
        "speech bubble ('the AI summary and the BUCEO remark icon share the same icon, which is confusing')",
        "c.note" not in _ro and "calNoteMark" not in _jsc and '"HOD\'s remark: "' not in _ro
        and "b.innerHTML = ICON.pen;" in _rbtn and "ICON.note" not in _rbtn
        and "pen: icon(" in _jsc and "b.innerHTML = ICON.spark + '<span class=\"rv-rmk-dot\"" in _jsc)
_mv0 = _jsc.find("function calMove("); _mv = _jsc[_mv0:_jsc.find("\n  function calFitRoster(", _mv0)]
s.check("client: a band change posts to the in-place move route and redraws the curve keeping the roster's scroll",
        '"/review/team/calib-move"' in _mv and "calRedrawCurve(j.overview.data)" in _mv
        and "calMoveChain = calMoveChain.then(" in _mv and "delete calPending[r.id]" in _mv)
_rd0 = _jsc.find("function calRedrawCurve("); _rd = _jsc[_rd0:_jsc.find("\n  function calStatus(", _rd0)]
s.check("client (review): moves go one at a time and EVERY reply is handled (a refusal always said); a redraw caps the "
        "roster BEFORE restoring its scroll, keeps pending choices, and refocuses the person just changed",
        "calFitRoster();   // cap first" in _rd and _rd.find("calFitRoster();") < _rd.find("ro2.scrollTop = top")
        and "calPending" in _rd and "calFocusPerson" in _rd and "var keep = ro.scrollTop;" in _jsc
        and "ro.scrollTop = keep;" in _jsc and "seq !== calMoveSeq" not in _jsc)
s.check("client (review): someone UA only BY DEFAULT shows a placeholder '(UA)', so picking UA is a real change that "
        "saves; an older stored card with no chain still shows a Band column",
        'o0.textContent = r.band_default ? "(UA)" : "—"' in _ro and "!pending && b === r.current_band" in _ro
        and "an older stored card: no chain, so one Band column" in _ro)
s.check("client (review): the fit is one dialog at a time, waits for band changes still saving, and can't be closed "
        "mid-Apply; its late reply never swaps another part's chrome; focus returns on the LIVE card",
        "calFitBusy" in _jsc and 'document.querySelector(".rv-fit-modal")' in _jsc and "calMoveChain.then(function ()" in _jsc
        and 'if (e.key === "Escape" && !applying) close();' in _jsc and "cancel.disabled = true" in _jsc
        and "if (curStage !== stage || !calLive()) return;   // they've gone to another part" in _jsc
        and 'stageCard.node.querySelector(".rv-cal-fitbtn")' in _jsc)
s.check("client (review): the strict-lock note's id is unique per render, and the Lock chip says why instead of "
        "clicking a disabled button",
        '"rv-cal-lockwhy-" + (++calLockSeq)' in _jsc and 'aria-describedby", whyId' in _jsc
        and "if (b && b.disabled) {" in _jsc)
s.check("client: the roster fills the room the chat has left (adaptive to the screen), never fewer than 3 rows, "
        "and re-fits on resize",
        "function calFitRoster(" in _jsc and "Math.max(Math.round(hh + 3 * rh), Math.floor(avail))" in _jsc
        and 'window.addEventListener("resize"' in _jsc)
s.check("client: the AI fit suggestion previews the moves and why, and writes only on Apply",
        '"/review/team/calib-fit"' in _jsc and 'f.append("mode", "preview")' in _jsc and 'f.append("mode", "apply")' in _jsc
        and '"Fit the curve with AI"' in _jsc)
_lf0 = _jsc.find("function calLockForm("); _lf = _jsc[_lf0:_jsc.find("\n  }\n", _lf0)]
s.check("client: the curve ends with Back and the lock card's own form (the existing lock route, the confirm dialog), "
        "coming back to the curve; strict and off the curve -> the Lock is disabled with the reason",
        "calLockForm(d)" in _cw and 'f.action = d.lock_url' in _lf and 'd.return_to_curve' in _lf
        and "if (off && strict) {\n          yes.disabled = true;" in _lf and "if (off && !strict)" in _lf)
s.check("client: off the curve with the rule allowing it, the ONLY lock asks for the reason (a plain submit would be "
        "refused by the server) -- on the curve and on the chat's lock card",
        'yes.classList.add("calib-override-btn"); yes.textContent = "Lock with a reason…"' in _lf
        and 'yes.classList.add("calib-override-btn"); yes.textContent = "Lock with a reason\\u2026"' in _jsc
        and '"Lock with override' not in _jsc)
s.check("client: an empty curve says so (never 'within 0 people'), and the potential lock notes who has no band",
        '"No one is on the curve yet — set their bands below."' in _jsc and "d.n_unbanded" in _jsc
        and "calLockLeft(d)" in _lf)
s.check("client (Chris, 2026-09-29): no notes under the curve -- the room goes to the roster; the strict reason rides on "
        "the disabled Lock (tooltip + a screen-reader line the Lock chip reads); who is UA by default / unbanded is said "
        "in the lock confirmation and the reason dialog",
        "rv-cal-locknotes" not in _jsc and "yes.title = why" in _lf and 'rmkEl("span", "rv-sr", why)' in _lf
        and 'Your tier above can then roll it up." + (left.length ? " " + left.join(" ") : "")' in _lf
        and 'yes.setAttribute("data-override-msg"' in _lf
        and "still UA by default — set their band" not in _jsc)
s.check("client: the roster is sized BEFORE the card is anchored, and a window resize keeps the whole curve in view",
        _jsc.find('if (cal.phase === "curve") calFitRoster();   // size the roster FIRST')
        < _jsc.find("if (calAnchorPending && log) {") and "keep the whole curve in view" in _jsc)
s.check("client: 'moved' only when the band differs from what came in; a first band says 'set' (the select's outline, its "
        "words on hover, 2026-10-06)",
        '(r.adjusted && r.current_band !== r.incoming_band)' in _jsc
        and 'r.incoming_band ? "You moved them from " + r.incoming_band : "You set their band (nothing final came in)"' in _jsc)
s.check("server: the potential curve counts who still has no band", '"n_unbanded"' in _src2)
_css = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
s.check("css: the chat's calibration card is never capped and nothing in it shrinks (the roster was crushed to 1px); "
        "the standalone assistant keeps its pinned cap",
        ".rv-tc-pin.rv-calib-pin { max-height: none; overflow: visible; }" in _css
        and ".rv-tc-pin.rv-calib-pin > * { flex: none; }" in _css
        and ".rv-calib-pin { max-height: 46vh; overflow: auto; }" in _css)
s.check("css: one type scale (18 name / 15 title / 14 body / 13 secondary / 12 table heads), a white card, "
        "--muted defined",
        ".rv-cal-name { margin: 0; font-size: 1.125rem;" in _css and ".rv-cal-title { font-size: 0.9375rem;" in _css
        and H.cvp(".rv-stage-card:has(.rv-calib-pin) { background: #fff;") in _css and H.tok("muted") == "#5f6678")
# the pure helpers, run (not just read): a target carries its direction and unit; a grade reads "Grade H"
import subprocess as _sp_
_fn = lambda name: _jsc[_jsc.find("function %s(" % name):_jsc.find("\n  }\n", _jsc.find("function %s(" % name)) + 4]
_node = ("var DASH='—';" + _fn("calTarget") + _fn("calGrade") +
         "console.log(JSON.stringify([calTarget({target:'12.72',unit:'RM (mil)',direction:'higher'}),"
         "calTarget({target:'42',unit:'%',direction:'lower'}), calTarget({target:null}), calGrade('JGH'), "
         "calGrade('H'), calGrade(15), calGrade('')]));")
try:
    _out = json.loads(_sp_.run(["node", "-e", _node], capture_output=True, text=True, timeout=20).stdout)
except Exception as _e:
    _out = str(_e)
s.check("client (run in node): a target carries its direction (\u2265 12.72 -- a long unit stays with the Result beside "
        "it, so the KPI name keeps its room -- and \u2264 42%); a grade reads Grade H / Grade 15",
        _out == ["\u2265 12.72", "\u2264 42%", "\u2014", "Grade H", "Grade H", "Grade 15", None], _out)

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
_lt0 = _jsc.find("function calLateText("); _lt = _jsc[_lt0:_jsc.find("\n  function calLateTag(", _lt0)]
_lc0 = _jsc.find("function calReviewHodCell("); _lc = _jsc[_lc0:_jsc.find("\n  }\n", _lc0)]
s.check("client: the late flag never tells a tier whose review is submitted to change its band (Chris, 2026-10-02: "
        "'HOD shouldn't be able to change the band anymore') -- the HOD's cell and the person's page pass the review's "
        "state -- and an HOD's saved person is final before the submit too (2026-10-06: 'once it is saved, we should "
        "not allow change anymore'), so it never says to change it there",
        '"Your band stands; your review is submitted."' in _lt and '"Your band stands; change it if you agree."'
        in _lt and '"Your band stands: you saved it."' in _lt
        and 'calLateTag(r.late, band, "you", !d.locked && !d.closed && "saved")' in _lc
        and 'calLateText(r.late, r.current_band, "you", !d.locked && !d.closed && (review ? "saved" : true))' in _jsc)
s.section("the curve, worked in place (Chris, 2026-09-29): UA by default, direct bands, the AI fit, the move route")
_ov = lambda lab, val: {"label": lab, "value": val, "mechanism": "A"}
with a.app.test_request_context():
    db = a.get_db()
    db.execute("DELETE FROM pm_calibration_adjustments"); db.commit()
    _c1 = fresh_ctx(); _c1["overalls"] = {A["id"]: _ov("OU", 4.6), B["id"]: _ov("OU", 4.5)}   # C not finalised
    _inc = a._pm_calib_incoming_fn(db, "hod", CID)
    _rows = a._pm_calibration_rows(db, pop, CID, _c1["overalls"], None, _inc, default_ua=True)
    _rc = next(r for r in _rows if r["user"]["id"] == C["id"])
    s.check("no finalised score and no band decided -> UA BY DEFAULT on an HOD curve, and it counts",
            _rc["current_band"] == "UA" and _rc["band_default"] and not _rc["finalised"]
            and a.pm_band_distribution(_rows)["UA"] == 1, (_rc["current_band"], _rc["band_default"]))
    _rows_bg = a._pm_calibration_rows(db, pop, CID, _c1["overalls"], None, a._pm_calib_incoming_fn(db, "bgceo", CID))
    s.check("...but not at the BG CEO tier (no default, not counted)",
            next(r for r in _rows_bg if r["user"]["id"] == C["id"])["current_band"] is None)
    # a band set before their score was approved, whose score is final now -> the calibrated band stands, flagged
    a._pm_calib_apply(db, SU, _c1, "hod", C["id"], "BE", "set before approval")
    _c2 = fresh_ctx(); _c2["overalls"] = {**_c1["overalls"], C["id"]: _ov("ME", 3.2)}
    _rows2 = a._pm_calibration_rows(db, pop, CID, _c2["overalls"], _c2["session"], _inc, default_ua=True)
    _rc2 = next(r for r in _rows2 if r["user"]["id"] == C["id"])
    s.check("a band set before their score was approved stays (BE), and is flagged: the LM's ME came in after it was "
            "set (Chris, 2026-10-02: entry stays open, the higher band supersedes, the tier that decided is told)",
            _rc2["current_band"] == "BE" and _rc2["late"] == {"now": "ME", "was": "", "who": "LM"}
            and _rc2["came_in"] == "" and not _rc2["band_default"], dict(band=_rc2["current_band"], late=_rc2["late"]))
    # they look again and save (BE stands, with a remark): they have seen the ME, so the flag clears; the first
    # original ('' -- nothing final) is kept for the band-move rule
    _, _e_again = a._pm_calib_apply(db, SU, _c2, "hod", C["id"], "BE", "looked again: BE stands")
    s.check("...an HOD can't save them again: a saved person is final (2026-10-06), so the flag stays and says so",
            _e_again and "can't be changed now" in _e_again, _e_again)
    # the re-save mechanic below is the BU CEO's now (they can save again); checked through this HOD fixture scope
    # with the saved-once rule stepped aside
    _real_saved = a._hod_saved_already
    a._hod_saved_already = lambda *x, **k: False
    a._pm_calib_apply(db, SU, _c2, "hod", C["id"], "BE", "looked again: BE stands")
    a._hod_saved_already = _real_saved
    _c2b = fresh_ctx(); _c2b["overalls"] = _c2["overalls"]
    _rc3 = next(r for r in a._pm_calibration_rows(db, pop, CID, _c2b["overalls"], _c2b["session"], _inc,
                                                  default_ua=True) if r["user"]["id"] == C["id"])
    _adj3 = db.execute("SELECT original_band, seen_band FROM pm_calibration_adjustments WHERE subject_id=?",
                       (C["id"],)).fetchone()
    s.check("...saving it again clears the flag: what they saw (seen_band) moves to ME, the first original stays ''",
            _rc3["late"] is None and _rc3["came_in"] == "ME" and _rc3["current_band"] == "BE"
            and tuple(_adj3) == ("", "ME"), (_rc3["late"], _rc3["came_in"], tuple(_adj3)))
    # a later result that AGREES with the band set is no flag; an older row with no seen_band reads its original
    s.check("...a later result that agrees is no flag; a row from before seen_band falls back to its original",
            a._calib_late({"original_band": "", "seen_band": "", "adjusted_band": "ME"}, "ME", "ME") is None
            and a._calib_late({"original_band": "AE", "seen_band": None}, "AE", "ME") is None
            and a._calib_late({"original_band": "AE", "seen_band": None}, "OU", "ME", "hod")
            == {"now": "OU", "was": "AE", "who": "HOD"}
            and a._calib_late(None, "OU", "ME") is None and a._calib_late({"original_band": ""}, None, "ME") is None)
    db.execute("DELETE FROM pm_calibration_adjustments"); db.commit()
    # THE AI FIT: three people all Outstanding on a normal curve -> the fewest adjacent moves, weakest case first
    _c3 = fresh_ctx(); _c3["overalls"] = {A["id"]: _ov("OU", 4.6), B["id"]: _ov("OU", 4.5), C["id"]: _ov("OU", 4.4)}
    db.execute("DELETE FROM pm_calib_summaries WHERE scope_key='9001'"); db.commit()   # nothing else to go on
    _n0 = _adj_count(db)
    _fit = a._pm_calib_fit_moves(db, SU, _c3, "hod")
    _ord = list(a.PM_BAND_ORDER)
    s.check("the fit suggests moves, each one person's, down the curve, and writes NOTHING (a preview)",
            _fit["moves"] and len({m["id"] for m in _fit["moves"]}) == len(_fit["moves"])
            and all(_ord.index(m["to"]) < _ord.index(m["from"]) for m in _fit["moves"]) and _adj_count(db) == _n0, _fit)
    s.check("...with nothing else to go on, the LOWEST score in the band moves down first; the top score stays; and the "
            "moves bring the curve within the rule (+-1 person)",
            _fit["moves"][0]["id"] == C["id"] and _fit["moves"][0]["from"] == "OU"
            and A["id"] not in {m["id"] for m in _fit["moves"]} and _fit["within_after"], (_fit["moves"], _fit["within_after"]))
    s.check("...and each move says why (score + evidence)",
            all(m["reasons"] and ("score" in m["reasons"][0].lower()) for m in _fit["moves"]), _fit["moves"][0]["reasons"])
    # the evidence decides a close call: B (4.5) not justified, C (4.4) well justified -> B moves down first
    for _sid, _v in ((B["id"], "not_justified"), (C["id"], "well_justified")):
        db.execute("INSERT OR REPLACE INTO pm_calib_summaries(subject_id, cycle_id, tier, scope_key, fingerprint, "
                   "summary, source, data) VALUES (?,?,?,?,?,?,?,?)",
                   (_sid, CID, "hod", "9001", "t", "t", "ai", json.dumps({"verdict": _v})))
    db.commit()
    _fit2 = a._pm_calib_fit_moves(db, SU, _c3, "hod")
    s.check("the EVIDENCE decides a close call: the unjustified 4.5 moves down before the well-justified 4.4",
            _fit2["moves"][0]["id"] == B["id"] and "not justified" in " ".join(_fit2["moves"][0]["reasons"]),
            _fit2["moves"][0])
    db.execute("DELETE FROM pm_calib_summaries WHERE scope_key='9001'"); db.commit()
    # someone the calibrator RAISED above their manager-approved band has the weakest case to stay there: B approved at
    # AE (3.9, well justified: case 4.4) and raised to OU, C approved OU (4.2, not justified: case 4.2) -- on score +
    # evidence alone C would go first; B goes back first because the calibrator put them above where their manager did
    _c4 = fresh_ctx(); _c4["overalls"] = {A["id"]: _ov("OU", 4.6), B["id"]: _ov("AE", 3.9), C["id"]: _ov("OU", 4.2)}
    for _sid, _v in ((B["id"], "well_justified"), (C["id"], "not_justified")):
        db.execute("INSERT OR REPLACE INTO pm_calib_summaries(subject_id, cycle_id, tier, scope_key, fingerprint, "
                   "summary, source, data) VALUES (?,?,?,?,?,?,?,?)",
                   (_sid, CID, "hod", "9001", "t", "t", "ai", json.dumps({"verdict": _v})))
    a._pm_calib_apply(db, SU, _c4, "hod", B["id"], "OU", "raised in the room")
    db.commit()
    _fit4 = a._pm_calib_fit_moves(db, SU, fresh_ctx() | {"overalls": _c4["overalls"]}, "hod")
    s.check("the fit moves someone raised ABOVE their approved band back first (it weighs where the manager put them)",
            _fit4["moves"] and _fit4["moves"][0]["id"] == B["id"] and _fit4["moves"][0]["from"] == "OU"
            and C["id"] not in {m["id"] for m in _fit4["moves"][:1]}
            and any("above their manager-approved band" in x for x in _fit4["moves"][0]["reasons"]), _fit4["moves"][:1])
    s.check("...and the reason shows the score to one decimal", "(3.9)" in " ".join(_fit4["moves"][0]["reasons"])
            if _fit4["moves"] else False, _fit4["moves"][:1])
    db.execute("DELETE FROM pm_calib_summaries WHERE scope_key='9001'")
    db.execute("DELETE FROM pm_calibration_adjustments"); db.commit()
    # REVIEW FIXES (2026-09-29, adversarial review of the curve):
    # (a) a super override outranks the tier, so the fit never picks that person (a move would change nothing)
    _ss = a._pm_calib_get_or_create_session(db, CID, "super", a.PM_SUPER_SCOPE_KEY, BG, "Super-admin overrides")
    a._pm_calib_upsert_adjustment(db, _ss["id"], C["id"], "OU", "OU", "kept by the super admin", SU["id"])
    db.commit()
    _fit5 = a._pm_calib_fit_moves(db, SU, _c3, "hod")
    s.check("(review) the fit never moves someone held by a super override",
            _fit5["moves"] and C["id"] not in {m["id"] for m in _fit5["moves"]}, _fit5["moves"])
    db.execute("DELETE FROM pm_calibration_adjustments WHERE session_id=?", (_ss["id"],))
    db.execute("DELETE FROM pm_calibration_sessions WHERE id=?", (_ss["id"],)); db.commit()
    # (b) a Mechanism-B SELF score keeps its mechanism, so it's ranked as a % (not as a 60-point rating)
    _real_self = a._rr_pm_self
    a._rr_pm_self = lambda db_, cid_, sid_: ({"value": 60.0, "mechanism": "B", "label": "UA"}, 1, 1)
    try:
        _c6 = fresh_ctx(); _c6["overalls"] = {A["id"]: _ov("OU", 4.6), B["id"]: _ov("OU", 4.5)}
        _pp = a._pm_calib_fit_people(db, SU, _c6, "hod", a._pm_calib_assist_rows(db, _c6, "hod"))
    finally:
        a._rr_pm_self = _real_self
    _pc = next((q for q in _pp if q["id"] == C["id"]), None)
    s.check("(review) a self-scored Mechanism-B person is ranked as Mechanism B",
            _pc and _pc["basis"] == "self" and _pc["mech"] == "B", _pc)
    # (c) the calibrator's own row is never UA by default (they can't band themselves)
    _rows_self = a._pm_calibration_rows(db, pop, CID, _c6["overalls"], None, a._pm_calib_incoming_fn(db, "hod", CID),
                                        default_ua=True, self_id=C["id"])
    _rcs = next(r for r in _rows_self if r["user"]["id"] == C["id"])
    s.check("(review) the calibrator's own unfinalised row is NOT counted as UA by default",
            not _rcs["band_default"] and _rcs["current_band"] is None, (_rcs["band_default"], _rcs["current_band"]))
    # (d) a band a lower tier set directly counts at the tier above, which may therefore calibrate it
    _c7 = fresh_ctx(); _c7["overalls"] = {A["id"]: _ov("OU", 4.6), B["id"]: _ov("OU", 4.5)}   # C not finalised
    _, _e0 = a._pm_calib_apply(db, SU, _c7, "bgceo", C["id"], "ME", "x")
    _bs = a._pm_calib_get_or_create_session(db, CID, "buceo", C["company"] or "", BG, "BU")
    a._pm_calib_upsert_adjustment(db, _bs["id"], C["id"], "", "BE", "set directly by the BU CEO", SU["id"])
    db.execute("UPDATE pm_calibration_sessions SET locked_at=datetime('now') WHERE id=?", (_bs["id"],)); db.commit()
    _, _e1 = a._pm_calib_apply(db, SU, _c7, "bgceo", C["id"], "ME", "x")
    s.check("(review) the BG CEO can't calibrate someone with no score and no band -- but CAN once a lower tier set "
            "their band directly", _e0 and not _e1, (_e0, _e1))
    db.execute("DELETE FROM pm_calibration_adjustments WHERE session_id IN "
               "(SELECT id FROM pm_calibration_sessions WHERE (tier='bgceo' AND scope_key='9001') OR id=?)", (_bs["id"],))
    db.execute("DELETE FROM pm_calibration_sessions WHERE (tier='bgceo' AND scope_key='9001') OR id=?", (_bs["id"],))
    db.commit()
_rsn = a._pm_calib_fit_reasons({"score": 3.4, "mech": "A", "basis": "self", "default": True, "self_label": "ME",
                                 "files": 0, "words": 0, "verdict": None, "why_flag": None, "off": 0},
                                "up", "Unacceptable", [])
s.check("(staging probe) someone UA only by default is moved for where their OWN score reads, not their rank among "
        "the defaults; no '--' in the copy",
        _rsn[0] == "Counted as Unacceptable only by default — their own score, 3.4 (not approved yet), reads "
                   "Meet Expectation" and not any("--" in x for x in _rsn), _rsn)
_src_fit = H.source(a)
s.check("(review) the fit counts only files the calibrator could open (shared, the person's own review evidence)",
        "AND e.state='shared' AND e.author_id=t.subject_id" in _src_fit)
s.check("(review) the Talent Box lets a HOD / BU CEO band someone not yet final, and any tier move a band set directly",
        'if not row["overall"] and not row["perf_band"] and tier not in _CALIB_AXIS_TIERS:' in _src_fit
        and "their band on the Performance Calibration curve" in _src_fit)
# the in-place move route + the fit's Apply, as a real HOD login would call them
_real_js2 = a._journey_calib_scope
try:
    _ovs = {A["id"]: _ov("OU", 4.6), B["id"]: _ov("OU", 4.5), C["id"]: _ov("OU", 4.4)}

    def _stub_scope(db_, u_, fresh=False):
        c = fresh_ctx(); c["overalls"] = dict(_ovs); return ("hod", KW, c)
    a._journey_calib_scope = _stub_scope
    with a.app.app_context():
        _d = a.get_db()
        _d.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','pm')")
        _d.execute("DELETE FROM pm_calibration_adjustments"); _d.commit()
    _login = _EMP["id"]
    _cl = H.client_as(a, _login)
    with a.app.test_request_context():
        a._pm_calib_apply(a.get_db(), dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (_login,)).fetchone()),
                          _stub_scope(None, None)[2], "hod", B["id"], "OU", "a reason given in the chat")
        a.get_db().commit()
    _r0 = _cl.post("/review/team/calib-move", data={"csrf_token": "tok", "stage": "calibration",
                                                    "subject": str(B["id"]), "band": "AE"}).get_json() or {}
    s.check("the in-place move route refuses an HOD's second save (a saved person is final, 2026-10-06)",
            _r0.get("ok") is False and "can't be changed now" in (_r0.get("error") or ""), _r0)
    # the route's own mechanics (a refreshed curve; a move with no new reason keeps the one given) are the BU CEO's
    # now; checked through this HOD fixture scope with the saved-once rule stepped aside
    _real_saved = a._hod_saved_already
    a._hod_saved_already = lambda *x, **k: False
    try:
        _r = _cl.post("/review/team/calib-move", data={"csrf_token": "tok", "stage": "calibration",
                                                       "subject": str(B["id"]), "band": "AE"})
    finally:
        a._hod_saved_already = _real_saved
    _j = _r.get_json() or {}
    with a.app.app_context():
        _row = a.get_db().execute("SELECT adjusted_band, justification FROM pm_calibration_adjustments WHERE subject_id=?",
                                  (B["id"],)).fetchone()
    s.check("the in-place move route saves the band (no chat turn) and returns the refreshed curve",
            _r.status_code == 200 and _j.get("ok") and _row and _row["adjusted_band"] == "AE"
            and (_j.get("overview") or {}).get("stage") == "calibration" and "nav_html" in _j, (_r.status_code, _j.get("error")))
    s.check("...and keeps the reason already given (a band change without a new one never blanks it)",
            _row and _row["justification"] == "a reason given in the chat", _row and dict(_row))
    _bad = _cl.post("/review/team/calib-move", data={"csrf_token": "tok", "stage": "calibration",
                                                     "subject": "99990001", "band": "AE"}).get_json() or {}
    s.check("...someone outside the scope is refused", _bad.get("ok") is False, _bad)
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_calibration_adjustments"); a.get_db().commit()
    # An HOD does a department review, not a calibration (Chris, 2026-09-30): no curve, so no curve fit
    _hv = _cl.post("/review/team/calib-fit", data={"csrf_token": "tok", "mode": "preview"}).get_json() or {}
    s.check("the fit is refused in an HOD's department review (no curve to fit)",
            _hv.get("ok") is False and "no curve" in (_hv.get("error") or ""), _hv)
    # ...the fit is a BU CEO's: the same scope, read at the BU CEO's seat
    def _stub_scope(db_, u_, fresh=False):
        c = fresh_ctx(); c["overalls"] = dict(_ovs); return ("buceo", {"bg": "ZZTESTBG", "company": "ZZTESTCO"}, c)
    a._journey_calib_scope = _stub_scope
    _pv = _cl.post("/review/team/calib-fit", data={"csrf_token": "tok", "mode": "preview"}).get_json() or {}
    _ap = _cl.post("/review/team/calib-fit", data={"csrf_token": "tok", "mode": "apply",
                                                   "moves": json.dumps(_pv.get("moves") or [])}).get_json() or {}
    with a.app.app_context():
        _nadj = a.get_db().execute("SELECT COUNT(*) c FROM pm_calibration_adjustments").fetchone()["c"]
        _fnotes = [r["justification"] for r in a.get_db().execute("SELECT justification FROM pm_calibration_adjustments")]
    s.check("the fit route previews, then Apply writes exactly the moves shown (each through the one write path)",
            _pv.get("ok") and _pv.get("moves") and _ap.get("ok") and _ap.get("applied") == len(_pv["moves"])
            and _nadj == len(_pv["moves"]), (_pv.get("moves") and len(_pv["moves"]), _ap.get("applied"), _nadj))
    s.check("...and leaves every remark empty for the BU CEO to write (no AI words saved as theirs, 2026-10-06), "
            "though the preview gave its reasons", _fnotes and all(not (n or "").strip() for n in _fnotes)
            and all(m.get("reasons") for m in _pv.get("moves") or []), _fnotes[:3])
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_calibration_adjustments"); a.get_db().commit()
    # (review) a crafted 'reasons' value is coerced, never a 500 half-way through the writes
    _cr = _cl.post("/review/team/calib-fit", data={"csrf_token": "tok", "mode": "apply", "moves": json.dumps(
        [{"id": B["id"], "from": "OU", "to": "AE", "reasons": [1, {"x": 2}]},
         {"id": C["id"], "from": "OU", "to": "AE", "reasons": 5}])})
    s.check("(review) Apply with crafted reasons answers normally (no 500) and writes both moves",
            _cr.status_code == 200 and (_cr.get_json() or {}).get("applied") == 2, (_cr.status_code, _cr.get_json()))
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_calibration_adjustments")
        a.get_db().execute("DELETE FROM pm_calibration_sessions WHERE tier='buceo' AND scope_key=?", (str(KW.get("hod_id", "9001")),))
        a.get_db().commit()
finally:
    a._journey_calib_scope = _real_js2

s.section("a band set before the score is final counts downstream; the UA default never leaves the curve")
with a.app.test_request_context():
    db = a.get_db()
    # two people with a HOD and NO finalised overall this cycle: X gets a band set directly at a LOCKED HOD session,
    # Y gets nothing (on the curve Y is "UA by default" -- that must never be stored or reach Talent Box / the record)
    _cand = [u_ for u_ in db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND hod_id IS NOT NULL "
                                     "ORDER BY id LIMIT 400").fetchall()
             if not a._dash_overall(db, u_["id"], CID)]
    s.check("fixture: two people with a HOD and no finalised score exist", len(_cand) >= 2, len(_cand))
    if len(_cand) >= 2:
        X, Y = _cand[0], _cand[1]
        db.execute("INSERT OR IGNORE INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label) "
                   "VALUES (?, 'hod', ?, ?, 'test')", (CID, str(X["hod_id"]), X["business_group"] or ""))
        _sid = db.execute("SELECT id FROM pm_calibration_sessions WHERE cycle_id=? AND tier='hod' AND scope_key=?",
                          (CID, str(X["hod_id"]))).fetchone()["id"]
        db.execute("DELETE FROM pm_calibration_adjustments WHERE subject_id IN (?, ?)", (X["id"], Y["id"]))
        db.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band, "
                   "justification) VALUES (?, ?, '', 'BE', 'set before the score was final')", (_sid, X["id"]))
        db.execute("UPDATE pm_calibration_sessions SET locked_at=datetime('now') WHERE id=?", (_sid,))
        db.commit()
        # a talent status needs BOTH axes: give each a valid potential band so this is about the performance axis only
        _real_eb = a.effective_band
        a.effective_band = lambda db_, subj_, cid_: {"band": "Mid", "score_valid": True}
        try:
            _tx = a.talent_status_for(db, X, CID, released_only=False)
            _ty = a.talent_status_for(db, Y, CID, released_only=False)
        finally:
            a.effective_band = _real_eb
        s.check("Talent Box reads the directly-set band (BE) for someone with no finalised score",
                (_tx or {}).get("perf") == "BE", _tx)
        s.check("...and places someone with no score and no band NOWHERE (UA by default stays on the curve)",
                _ty is None, _ty)
        try:
            _rx = a._rating_record_row(db, CID, X)
            _ry = a._rating_record_row(db, CID, Y)
        except Exception as _e:
            _rx = _ry = {"error": repr(_e)}
        s.check("the rating record's final performance band is the directly-set BE",
                _rx.get("pm_final_band") == "BE" and _rx.get("pm_final_source") == "hod", {k: _rx.get(k) for k in
                ("pm_final_band", "pm_final_source", "error")})
        s.check("...and none for the person with neither", _ry.get("pm_final_band") in (None, ""),
                {k: _ry.get(k) for k in ("pm_final_band", "pm_final_source", "error")})
        db.execute("DELETE FROM pm_calibration_adjustments WHERE session_id=?", (_sid,))
        db.execute("DELETE FROM pm_calibration_sessions WHERE id=?", (_sid,))
        db.commit()

s.section("the dashboard's AI+ Calibration card opens the chat's Calibration tabs (Chris, 2026-09-29)")
_LEADER = dict(A)   # a non-admin login (the super admin never gets the employee dashboard)
_real_js, _real_ps, _real_tiers2 = a._journey_calib_scope, a._pot_calib_scope, a.calibration_tier_of


def _calib_card(pm=True, pot=True, unified=True, review_on=True, half=2, as_tier="buceo"):
    """dash_cards' calibration card for _LEADER (a BU CEO here: an HOD's is the AI+ Dept Review card since
    2026-09-30), with the two chat scopes stubbed on / off and the gates set."""
    _key = 9001 if as_tier == "hod" else (BG, "ZZTESTCO")
    _kw = KW if as_tier == "hod" else {"bg": BG, "company": "ZZTESTCO"}
    a.calibration_tier_of = lambda db_, u_: [(as_tier, _key)] if u_ and u_["id"] == _LEADER["id"] else []
    a._journey_calib_scope = ((lambda db_, u_, fresh=False, tier=None: (as_tier, _kw, fresh_ctx())
                               if tier in (None, as_tier) else None) if pm else (lambda *x, **k: None))
    a._pot_calib_scope = ((lambda db_, u_, fresh=False, tier=None: (as_tier, _key, {"population": pop, "session": None})
                           if tier in (None, as_tier) else None) if pot else (lambda *x, **k: None))
    with a.app.test_request_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET half=? WHERE id=?", (half, CID))
        d.execute("UPDATE cycle_modules SET active=? WHERE module_key='review'", (1 if review_on else 0,))
        if unified:
            d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('review_unified','1')")
        else:   # off for them: the org switch off (the AI+ way is on for everyone by default, 2026-10-08)
            d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('review_unified','0')")
        d.commit()
    with a.app.test_request_context("/dashboard"):
        from flask import session as _sess
        _sess["user_id"] = _LEADER["id"]
        d = a.get_db()
        grid_pm, grid_pot = a.url_for("pm_calibration_home"), a.url_for("calibration_home")
        doors = [{"name": "Performance Calibration", "url": grid_pm, "pending": 2, "module": "pm", "group": "calibration"},
                 {"name": "360 Potential Calibration", "url": grid_pot, "pending": 0, "module": "calibration",
                  "group": "calibration"},
                 {"name": "Talent Box Calibration", "url": a.url_for("talent_box_home"), "pending": 0, "module": "tm",
                  "group": "calibration"}]
        card = next(c for c in a.dash_cards(d, _LEADER, None, doors, []) if c["key"] == "calibration")
        return card, {p["label"]: p["url"] for p in card["pending"]}, grid_pm, grid_pot


try:
    _card, _pend, _gpm, _gpot = _calib_card()
    _chat_pm = "/review/journey?view=bu&stage=calibration"
    _chat_pot = "/review/journey?view=bu&stage=calibration_pot"
    s.check("with both chat tabs open, the card opens the chat's Performance calibration tab",
            _card["url"] == _chat_pm, _card["url"])
    s.check("...and the popout's two calibration doors open the chat tabs; Talent Box keeps its page",
            _pend["Performance Calibration"] == _chat_pm and _pend["360 Potential Calibration"] == _chat_pot
            and "/talent-box" in _pend["Talent Box Calibration"], _pend)
    s.check("...the counts are unchanged ('2 to calibrate')", _card["sub"] == "2 to calibrate", _card["sub"])
    _card, _pend, _gpm, _gpot = _calib_card(pm=False)
    s.check("no Performance chat tab -> the card opens the chat's Potential tab, and the Performance door keeps "
            "the grid",
            _card["url"] == _chat_pot and _pend["Performance Calibration"] == _gpm, (_card["url"], _pend))
    for _lbl, _kw in (("the unified journey off for them", {"unified": False}),
                      ("the review phase off", {"review_on": False}),
                      ("a Mid-Year cycle (calibration is Year-End only)", {"half": 1}),
                      ("no calibration scope in the chat", {"pm": False, "pot": False})):
        _card, _pend, _gpm, _gpot = _calib_card(**_kw)
        s.check("%s -> the card and its doors keep the grid pages (never a link that 404s)" % _lbl,
                _card["url"] == _gpm and _pend["Performance Calibration"] == _gpm
                and _pend["360 Potential Calibration"] == _gpot, (_card["url"], _pend))
    _card, _pend, _gpm, _gpot = _calib_card(as_tier="hod")
    s.check("an HOD's Dept view is never a Calibration door (it's the AI+ Dept Review card's): the doors keep the grid",
            _pend["Performance Calibration"] == _gpm and _pend["360 Potential Calibration"] == _gpot, _pend)
    with a.app.test_request_context("/dashboard"):
        s.check("an admin never gets chat links", a.dash_calib_chat_urls(a.get_db(), SU) == {})
finally:
    a._journey_calib_scope, a._pot_calib_scope, a.calibration_tier_of = _real_js, _real_ps, _real_tiers2
    with a.app.test_request_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
        d.execute("DELETE FROM app_settings WHERE key='review_unified'")
        d.commit()

# ---------------------------------------------------------------------------
s.section("a BG CEO calibrates on the Talent Box only (Chris, 2026-09-29)")
with a.app.test_request_context("/dashboard"):
    d = a.get_db()
    _plain = dict(d.execute("SELECT * FROM users u WHERE role!='admin' AND left_at IS NULL AND business_group=? "
                            "AND NOT EXISTS (SELECT 1 FROM users x WHERE x.hod_id=u.id) ORDER BY id LIMIT 1",
                            (BG,)).fetchone())
    _hodr = d.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND id IN "
                      "(SELECT hod_id FROM users WHERE hod_id IS NOT NULL AND role!='admin') ORDER BY id LIMIT 1").fetchone()
    _bgc = dict(_plain, bgceo_bg=BG, buceo_bg=None, buceo_company=None)   # a BG CEO and nothing else
    s.check("fixture: the BG CEO login holds the bgceo tier only",
            [t for t, _k in a.calibration_tier_of(d, _bgc)] == ["bgceo"], a.calibration_tier_of(d, _bgc))
    _kids = [c["name"] for c in a._hub_calibration_children(d, _bgc)]
    s.check("a BG CEO's calibration doors are the Talent Box alone (no Performance / 360 Potential pages)",
            _kids == ["Talent Box Calibration"], _kids)
    s.check("...and neither separate axis counts as pending for them (the Talent Box counts it)",
            a._pm_calibration_pending_count(d, _bgc) == 0 and a._calibration_pending_count(d, _bgc) == 0)
    _card = next((c for c in a.dash_cards(d, _bgc, None, a.dash_leadership(d, _bgc), []) if c["key"] == "calibration"),
                 None)
    s.check("the dashboard card opens the Talent Box and lists no Performance / Potential door",
            _card and "/talent-box" in (_card["url"] or "")
            and not any(p["label"] in ("Performance Calibration", "360 Potential Calibration") for p in _card["pending"]),
            _card)
    if _hodr:
        _both = dict(_hodr, bgceo_bg=BG)   # an HOD who is also a BG CEO keeps their HOD calibration
        _kb = [c["name"] for c in a._hub_calibration_children(d, _both)]
        s.check("an HOD who is also a BG CEO keeps Performance + 360 Potential (for the HOD scope) and the Talent Box",
                _kb == ["Performance Calibration", "360 Potential Calibration", "Talent Box Calibration"], _kb)
        _hod_only = dict(_hodr, bgceo_bg=None)
        s.check("...and their counts are the HOD scope's alone (the BG CEO scope isn't added)",
                a._pm_calibration_pending_count(d, _both) == a._pm_calibration_pending_count(d, _hod_only)
                and a._calibration_pending_count(d, _both) == a._calibration_pending_count(d, _hod_only))
_real_on = a._calib_assist_on
try:
    a._calib_assist_on = lambda u_: True
    with a.app.test_request_context("/"):
        d = a.get_db()
        _co = d.execute("SELECT company FROM users WHERE business_group=? AND company IS NOT NULL AND role!='admin' "
                        "GROUP BY company ORDER BY COUNT(*) DESC LIMIT 1", (BG,)).fetchone()
        s.check("the chat's Potential tab is not offered to a BG CEO", a._pot_calib_scope(d, _bgc, fresh=True) is None)
        if _co:
            _bu = dict(_plain, bgceo_bg=None, buceo_bg=BG, buceo_company=_co["company"])
            _ps = a._pot_calib_scope(d, _bu, fresh=True)
            s.check("...while the same login as a BU CEO of that business group does get it (the check can pass)",
                    bool(_ps) and _ps[0] == "buceo", _ps and _ps[0])
finally:
    a._calib_assist_on = _real_on


s.section("the justification weighs the line manager's remark and moderation (Chris, 2026-09-29)")
with a.app.test_request_context("/"):
    d = a.get_db()
    if not d.execute("SELECT 1 FROM pm_bg_config WHERE business_group='ZZCAL BG'").fetchone():
        d.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES ('ZZCAL BG', 'A')")
    _mgr = d.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                     "confirmation_date) VALUES ('zzmodmgr','ZZ Mod Manager','x','user','ZZTEST-MODMGR','ZZCAL BG',"
                     "'2022-01-01')").lastrowid
    _sub = d.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                     "manager_id, confirmation_date) VALUES ('zzmodsub','ZZ Mod Person','x','user','ZZTEST-MODSUB',"
                     "'ZZCAL BG',?,'2022-01-01')", (_mgr,)).lastrowid
    _t = d.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
                   "rate1, rate2, rate3, rate4, rate5) VALUES (?,?,'ZZMOD Output',100,'more','approved','ZZCAL BG',"
                   "10,20,30,40,50)", (CID, _sub)).lastrowid
    d.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,44,?,0)", (_t, _sub))
    d.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (_t, _mgr))
    d.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, adjusted_value, justification, "
              "acted_by) VALUES (?,1,'adjust',44,33,'Output counted a returned batch twice.',?)", (_t, _mgr))
    d.execute("INSERT INTO pm_kpi_moderation_drafts(kpi_target_id, approver_id, adjusted_value, justification) "
              "VALUES (?,?,22,'SECRET DRAFT THINKING')", (_t, _mgr))
    d.execute("INSERT INTO pm_manager_remarks(cycle_id, subject_id, remark, submitted_by) VALUES (?,?,?,?)",
              (CID, _sub, "Solid delivery, but the batch count needed fixing before I could sign it off.", _mgr))
    d.commit()
    _st, _first, _words, _extra, _facts = a._pm_perf_source(d, SU, _sub, scope="calibrator")
    _r = (_facts.get("rows") or [{}])[0]
    s.check("a calibrator's source carries the line manager's committed moderation on a LOCKED line: who, from, to, why",
            _r.get("moderation") and _r["moderation"][0]["by"] == "ZZ Mod Manager"
            and _r["moderation"][0]["to"] == 33 and _r["moderation"][0]["why"] == "Output counted a returned batch twice."
            and _r.get("mod_value") == 33, _r.get("moderation"))
    s.check("...and the manager's overall remark (every line is locked)",
            [m["author"] for m in _facts.get("mgr_remarks") or []] == ["ZZ Mod Manager"], _facts.get("mgr_remarks"))
    s.check("...in the words the insight is fingerprinted on, and the moderator's name in the grounding names",
            "moderated ZZMOD Output from 44 to 33 -- their reason: Output counted a returned batch twice" in _words
            and "ZZ Mod Manager" in _extra)
    s.check("never the approver's private moderation DRAFT", "SECRET DRAFT" not in _words
            and "SECRET" not in json.dumps(_facts, default=str))
    _case = a._pm_perf_case_text(_facts, {})
    s.check("the case file says it: THEIR LINE MANAGER'S MODERATION (name) from -> to, where it lands, and the fenced reason",
            "THEIR LINE MANAGER'S MODERATION (ZZ Mod Manager): moved the result from 44 to 33" in _case
            and "Their reason: <<<Output counted a returned batch twice.>>>" in _case
            and "THEIR LINE MANAGER'S OVERALL REMARK (ZZ Mod Manager)" in _case)
    _, _, _w2, _, _f2 = a._pm_perf_source(d, {"id": _mgr}, _sub)
    s.check("the line manager's OWN (approver) view is unchanged -- no moderation block of their own work",
            not (_f2.get("rows") or [{}])[0].get("moderation"), (_f2.get("rows") or [{}])[0].get("moderation"))
    d.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,2,?)", (_t, SU["id"]))
    d.commit()
    _, _, _w3, _, _f3 = a._pm_perf_source(d, SU, _sub, scope="calibrator")
    s.check("a line still in moderation (a later approver hasn't acted) carries no moderation and no manager remark",
            not _f3["rows"][0].get("moderation") and not _f3.get("mgr_remarks") and "returned batch" not in _w3)
    d.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id=? AND seq=2", (_t,))
    d.commit()
    # the floor: a moderated line is judged as the manager left it
    _rr = dict(_r, _texts={})
    _k = {"kpi": "ZZMOD Output", "evidence": "none", "group": "well", "band": "ME"}
    _code, _why = a._pm_perf_justify_kpi(_k, _rr, "")
    s.check("moderated DOWN, no file: never better than partly, and it says so (the reason is on the card, not here)",
            _code == "partly" and "their manager moderated it down to 33" in _why and "no reason" not in _why, (_code, _why))
    _rr2 = dict(_rr, moderation=[dict(_r["moderation"][0], why="")])
    _code2, _why2 = a._pm_perf_justify_kpi(_k, _rr2, "")
    s.check("...with no reason given: still partly (the card line and the next step say there was no reason)",
            _code2 == "partly" and "moderated it down to 33" in _why2, (_code2, _why2))
    _rr3 = dict(_rr, file_list=[{"id": 1, "name": "f"}], _texts={1: {"status": "ok", "text": "Output this half: 33 units"}})
    _code3, _why3 = a._pm_perf_justify_kpi(dict(_k, evidence="not_found"), _rr3, "")
    s.check("...a file that shows the MODERATED figure backs the result as it now stands",
            _code3 == "yes" and "the file shows that figure" in _why3, (_code3, _why3))
    _rr4 = dict(_rr, file_list=[{"id": 1, "name": "f"}], _texts={1: {"status": "ok", "text": "Output this half: 44 units"}})
    _code4, _why4 = a._pm_perf_justify_kpi(dict(_k, evidence="found"), _rr4, "")
    s.check("...a file that shows THEIR figure when the manager moved it down: partly -- worth asking why",
            _code4 == "partly" and "the file shows their figure, but" in _why4, (_code4, _why4))
    _up = dict(_rr, mod_value=55, mod_band="OU", moderation=[dict(_r["moderation"][0], to=55, to_res="55")])
    _code5, _why5 = a._pm_perf_justify_kpi(_k, _up, "")
    s.check("moderated UP to a strong result with no file: judged as moderated (the manager's reason is the explanation, "
            "so partly, not better), and the move is named as the manager's",
            _code5 == "partly" and "moderated it up to 55" in _why5 and "no file backs it" in _why5, (_code5, _why5))
    _kent = a._pm_perf_kpi_entry(_r, "", "none", "")
    s.check("the KPI entry the card reads carries the moderation (by, from, to, why) and which way",
            _kent["mod_dir"] == "down" and _kent["moderation"][0]["by"] == "ZZ Mod Manager"
            and _kent["moderation"][0]["to"] == "33" and _kent["moderation"][0]["why"], _kent)
    # an ON-target result (not a strong one -- those can never be upgraded) that the manager moved down: the one case
    # the model may otherwise upgrade (no file, the context in words the server can't see)
    _rme = dict(_r, value=33, result="33", band="ME", rating=3, mod_value=25, mod_result="25", mod_band="BE",
                moderation=[dict(_r["moderation"][0], from_=33, to=25, from_res="33", to_res="25")])
    _fme = dict(_facts, rows=[_rme], reviewer_kind="calibrator", _texts={})
    _kpis = [dict(a._pm_perf_kpi_entry(_rme, "", "none", ""), _rid=_r["id"])]
    _v, _vw, _steps = a._pm_perf_apply_insight(_kpis, _fme["rows"], _fme, model={
        "kpis": {_r["id"]: {"justified": "yes", "why": "Their manager's reason makes the result sound."}}})
    s.check("the model can't talk a result the manager moved DOWN up to justified (an on-target line, the one it "
            "could otherwise upgrade)", _kpis[0]["justified"] == "partly", _kpis[0])
    _fx = dict(_facts, reviewer_kind="calibrator", _texts={})
    _fx2 = dict(_fx, rows=[dict(_facts["rows"][0], moderation=[dict(_r["moderation"][0], why="")])])
    _k2 = [dict(a._pm_perf_kpi_entry(_fx2["rows"][0], "", "none", ""), _rid=_r["id"])]
    _v2, _vw2, _st2 = a._pm_perf_apply_insight(_k2, _fx2["rows"], _fx2)
    s.check("a calibrator's next step asks their manager about a moderation with no reason",
            any("Ask their manager why ZZMOD Output was moderated down" in x for x in _st2), _st2)
    _pdata = a._pm_perf_data(_facts, "plain", a._pm_perf_plain(_first, _fx, {}))
    s.check("the stored insight carries the manager's remark for the card, and the plain summary says what they did",
            _pdata["mgr_remarks"] and "Their line manager (ZZ Mod Manager) moderated ZZMOD Output from 44 to 33"
            in _pdata["paragraph"] and "Their line manager's remark (ZZ Mod Manager)" in _pdata["paragraph"],
            _pdata.get("paragraph"))
    # ---- the CASE (2026-10-05: "provide sufficient justification and evidence from the person, LM, and/or HOD to prove
    # the person's performance score, instead of now it is just stating the facts")
    _fct = dict(_fx, trail=[{"tier": "hod", "label": "HOD", "by": "ZZ Some HOD", "from": "ME", "band": "ME",
                             "note": "Kept: the batch fix was the right call."}])
    _case_p = a._pm_perf_plain(_first, _fct, {})["paragraph"]
    s.check("a calibrator's plain summary is the case too: the bottom line first, then what doesn't hold up, their "
            "words, their line manager's moderation and remark, and what the HOD decided and why",
            any(_case_p.startswith(b) for b in a._PERF_CASE_BOTTOM.values()) and "What doesn't:" in _case_p
            and _case_p.count("overall remark") == 1
            and "Their line manager (ZZ Mod Manager) moderated ZZMOD Output from 44 to 33" in _case_p
            and "The HOD kept them at Meet Expectation, noting \u201cKept: the batch fix was the right call\u201d." in _case_p
            and _case_p.find("What doesn't:") < _case_p.find("Their line manager (") < _case_p.find("The HOD kept"), _case_p)
    _case_r = a._pm_perf_plain(_first, dict(_fct, remark="I counted every unit we shipped this half."), {})["paragraph"]
    s.check("...with their remark, it says what they say, before their manager's view",
            "They say: \u201cI counted every unit we shipped this half\u201d." in _case_r
            and _case_r.find("They say:") < _case_r.find("Their line manager ("), _case_r)
    _mgr_p = a._pm_perf_plain(_first, dict(_facts, reviewer_kind="manager", _texts={}), {})["paragraph"]
    s.check("...the line manager's own plain summary is unchanged (no case, no bottom line)",
            not any(_mgr_p.startswith(b) for b in a._PERF_CASE_BOTTOM.values()), _mgr_p)
    _rows0 = _facts["rows"]
    s.check("the case may report what a reviewer DID -- 'the HOD moved their rating down', 'their manager's moderation "
            "lowered the rating' -- (the advice check refused it)",
            a._pm_perf_claim_error("The HOD moved their rating down after the department review.", _rows0) is None
            and a._pm_perf_claim_error("Their manager's moderation lowered the rating.", _rows0) is None, (
                a._pm_perf_claim_error("The HOD moved their rating down after the department review.", _rows0),
                a._pm_perf_claim_error("Their manager's moderation lowered the rating.", _rows0)))
    s.check("...but advice is still refused, from anyone ('supports a higher rating', 'should be raised', 'worth "
            "raising the rating')",
            all(a._pm_perf_claim_error(t, _rows0) == "talks about moving the rating" for t in (
                "The evidence supports a higher rating.",
                "Their manager moderated it, so the rating should be raised.",
                "It is worth raising the rating.")),
            [a._pm_perf_claim_error(t, _rows0) for t in ("The evidence supports a higher rating.",
                                                         "Their manager moderated it, so the rating should be raised.",
                                                         "It is worth raising the rating.")])
    _cb = a._pm_perf_case_bottom
    s.check("the case's bottom line says the verdict that stands (Luna probe, 2026-10-05: 3 of 8 opened 'only partly "
            "backed' under a Not justified pill) -- the opening clause is replaced, the rest kept as written",
            _cb("The results as they stand are only partly backed. The report shows RM 17.2 mil.", "not_justified")
            == "The evidence doesn't bear out their results as they stand. The report shows RM 17.2 mil."
            and _cb("Their results are only partly supported as they stand: the report shows 15.4.", "not_justified")
            == "The evidence doesn't bear out their results as they stand: the report shows 15.4."
            and _cb("The evidence does not bear out their results. Rest.", "well_justified")
            == "The evidence bears out their results. Rest.",
            [_cb("The results as they stand are only partly backed. The report shows RM 17.2 mil.", "not_justified")])
    s.check("...and leaves an opening that already agrees, or says no degree at all, alone",
            _cb("The results are not well justified: the report shows 14.3.", "not_justified")
            == "The results are not well justified: the report shows 14.3."
            and _cb("The evidence doesn't fully bear out their results: one file is missing.", "partly_justified")
            == "The evidence doesn't fully bear out their results: one file is missing."
            and _cb("Gross Profit is above target at 12.9. Rest.", "partly_justified")
            == "Gross Profit is above target at 12.9. Rest.")
    _src_case = H.source(a)
    s.check("...the case has room (160 words for a calibrator, 110 for a line manager) and every calibrator insight is "
            "rebuilt for it", 'chk(obj.get("paragraph"), 160 if facts.get("reviewer_kind") == "calibrator" else 110)'
            in _src_case and '"v9calib\\n"' in _src_case
            and 'if facts.get("reviewer_kind") == "calibrator":\n        paragraph = _pm_perf_case_bottom(paragraph, verdict)'
            in _src_case)
    # grounding: a cause taken from the MANAGER's words is theirs, not invented
    _rev = "Output counted a returned batch twice."
    s.check("a cause only the MANAGER gave stands when the sentence says it's theirs ...",
            a._pm_perf_claim_error("Their manager moderated it because of a returned batch.", _facts["rows"],
                                   own_words="", reviewer_words=_rev) is None)
    s.check("...never as the person's own defence (2026-09-29 review), and a cause nobody gave is still refused",
            a._pm_perf_claim_error("They came in lower because of a returned batch.", _facts["rows"],
                                   own_words="", reviewer_words=_rev)
            and a._pm_perf_claim_error("Their manager moderated it because of a warehouse flood.", _facts["rows"],
                                       own_words="", reviewer_words=_rev))
    s.check("...wired: the insight keeps two pools -- their words, and the reviewers' (never the AI fit's own notes)",
            'reviewer_words=rev' in _src2 and '[m.get("why") or "" for r in rows for m in r.get("moderation") or []]' in _src2
            and "Moved to fit the calibration curve|Set on their own results" in _src2)
    s.check("a file verdict may cite the moderated figure", a._pm_perf_is_keyed_or_target(33.0, _r))
    _ct = a._pm_perf_case_text(dict(_facts, trail=[{"label": "HOD", "by": "ZZ Some HOD", "from": "AE", "band": "ME",
                                                     "note": "Kept to the curve."}]), {})
    s.check("a tier above reads HOW IT REACHED YOU: where the lower tier placed them, who, and its note (plain words, "
            "never a band name -- and never worded as moving the rating, which the advice check refuses)",
            "HOW IT REACHED YOU: the HOD (ZZ Some HOD) placed them at on target overall (it came in at above target "
            "overall). Their note: <<<Kept to the curve.>>>" in _ct
            and not a._PERF_ADVICE_RE.search(_ct.split("HOW IT REACHED YOU")[1].split("\n")[0]))
    # ---- the review's findings (2026-09-29)
    _upr = dict(_r, value=14, result="14", band="BE", rating=2, target_raw=30, mod_value=55, mod_result="55",
                mod_band="OU", moderation=[dict(_r["moderation"][0], to=55, to_res="55", why="Strong push on key accounts.")])
    _fu = dict(_facts, rows=[_upr], reviewer_kind="calibrator", _texts={})
    _ku = [dict(a._pm_perf_kpi_entry(_upr, "", "none", ""), _rid=_r["id"])]
    a._pm_perf_apply_insight(_ku, _fu["rows"], _fu, model={"kpis": {_r["id"]: {"justified": "yes", "why": "Fine."}}})
    s.check("the model can't upgrade ANY moderated line -- here one raised to a strong result with no file (their own "
            "figure below target used to slip the strong-result guard)", _ku[0]["justified"] == "partly", _ku[0])
    _upr2 = dict(_upr, moderation=[dict(_upr["moderation"][0], why="")])
    _ku2 = [dict(a._pm_perf_kpi_entry(_upr2, "", "none", ""), _rid=_r["id"])]
    _, _, _ust = a._pm_perf_apply_insight(_ku2, [_upr2], dict(_fu, rows=[_upr2]))
    s.check("...and a raise with no reason: the step asks their manager why (never 'evidence behind a below-target result')",
            any("Ask their manager why ZZMOD Output was moderated up" in x for x in _ust)
            and not any("below target" in x for x in _ust), _ust)
    _fmod = dict(_r, file_list=[{"id": 9, "name": "f"}])
    _txm = {9: {"status": "ok", "text": "Output this half: 33 units"}}
    s.check("a file showing the MODERATED figure backs the result as it stands: 'supports' holds, the plain check says so",
            a._pm_perf_evidence(_fmod, _txm, "supports", "")[0] == "supports"
            and a._pm_perf_evidence(_fmod, _txm, plain=True) == ("found", "The moderated figure (33) appears in the file."),
            (a._pm_perf_evidence(_fmod, _txm, "supports", ""), a._pm_perf_evidence(_fmod, _txm, plain=True)))
    _rows_dir = [dict(_r, kpi="ZZMOD Output", value=25, target_raw=30, direction="higher is better", band="BE",
                      moderation=[], mod_value=None)]
    s.check("no blanket exemption: a sentence that merely mentions moderation (or 'moderately') no longer lets a false "
            "direction claim through",
            a._pm_perf_claim_error("ZZMOD Output beat its target, while the rest was moderated.", _rows_dir)
            and a._pm_perf_claim_error("ZZMOD Output was moderately strong this half.", _rows_dir))
    _rows_dir2 = [dict(_r, kpi="ZZMOD Output", value=44, target_raw=40, band="AE", mod_value=33, mod_band="BE",
                       direction="higher is better")]
    s.check("...while a direction word true of the MODERATED figure is fine ('lowered to 33, below target')",
            a._pm_perf_claim_error("Their manager lowered ZZMOD Output to 33, below target.", _rows_dir2) is None,
            a._pm_perf_claim_error("Their manager lowered ZZMOD Output to 33, below target.", _rows_dir2))
    d.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,2,?)", (_t, SU["id"]))
    d.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, adjusted_value, acted_by) "
              "VALUES (?,2,'adjust',33,33,?)", (_t, SU["id"]))
    d.commit()
    _, _, _, _, _f7 = a._pm_perf_source(d, SU, _sub, scope="calibrator")
    s.check("a same-value 'adjust' (the figure received, typed back in) is no moderation",
            [m["to"] for m in _f7["rows"][0]["moderation"]] == [33], _f7["rows"][0]["moderation"])
    d.execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id=? AND seq=2", (_t,))
    d.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id=? AND seq=2", (_t,))
    d.execute("INSERT INTO pm_manager_remarks(cycle_id, subject_id, remark, submitted_by) VALUES (?,?,?,?)",
              (CID, _sub, "OTIF looks inflated, check the Q3 file.", SU["id"]))
    d.commit()
    _rm = a._pm_manager_remarks_locked(d, CID, _sub, True)
    s.check("each approver's remark carries who they are to the person -- the line manager first, a co-approver as "
            "'Approver' (never headed 'line manager')",
            [(m["author"], m["role"]) for m in _rm][0] == ("ZZ Mod Manager", "Line manager")
            and _rm[1]["role"] == "Approver", _rm)
    _ctr = a._pm_perf_case_text(dict(_facts, mgr_remarks=_rm), {})
    s.check("...and the case file labels them the same way", "THEIR LINE MANAGER'S OVERALL REMARK (ZZ Mod Manager)" in _ctr
            and "ANOTHER APPROVER'S OVERALL REMARK" in _ctr)
    d.execute("DELETE FROM pm_manager_remarks WHERE subject_id=? AND submitted_by=?", (_sub, SU["id"]))
    d.commit()
    s.check("the calibrator fingerprint moves when a confirm-only line locks (locked + approvers are in it)",
            'r.get("locked"), r.get("approvers")] if calib else []' in _src2)
    # ---- the GPT-6 Luna probe on the seeded staging unit (2026-09-30): the insight fell back to plain 3 times in 4
    _fin = a._summary_grounding_error("The H2 report was signed off by Finance.", "", "The Finance-signed report backs it.",
                                      a._PERF_SUMMARY_VOCAB, a._PERF_SUMMARY_STARTERS, "perf_summary", ratio=0.4, floor=6)
    s.check("a hyphenated compound whose parts are in the source passes mid-sentence ('the Finance-signed report')",
            _fin is None, _fin)
    _rn = [dict(_r, kpi="ZZMOD Output", _evidence="none")]
    s.check("'their manager confirmed / says it matches' is the manager's view, not a file backing the result ...",
            a._pm_perf_claim_error("Their manager confirmed ZZMOD Output as entered.", _rn, kpi=_rn[0]) is None
            and a._pm_perf_claim_error("Their manager says ZZMOD Output matches monthly reviews.", _rn, kpi=_rn[0]) is None)
    s.check("...while a clause that says a FILE backs it is still checked",
            a._pm_perf_claim_error("The file confirms ZZMOD Output.", _rn, kpi=_rn[0])
            and a._pm_perf_claim_error("Their manager's report confirms ZZMOD Output.", _rn, kpi=_rn[0]))
    _fth = dict(_r, file_list=[{"id": 8, "name": "f"}])
    _txt = {8: {"status": "ok", "text": "Output this half: 44 units"}}
    s.check("a moved-down line whose file shows THEIR figure, not the manager's: the model's 'contradicts' holds (the "
            "prompt's own rule -- judge the file against the figure as it stands)",
            a._pm_perf_evidence(_fth, _txt, "contradicts", "")[0] == "contradicts",
            a._pm_perf_evidence(_fth, _txt, "contradicts", ""))
    _kc = dict(a._pm_perf_kpi_entry(_fth, "", "contradicts", ""), _rid=_r["id"])
    _fc = dict(_facts, rows=[dict(_fth)], reviewer_kind="calibrator", _texts=_txt)
    _, _, _stc = a._pm_perf_apply_insight([_kc], _fc["rows"], _fc)
    s.check("...judged partly ('the file shows their figure, but ...'), and the step asks their manager -- never "
            "'the file doesn't match their result'",
            _kc["justified"] == "partly" and "the file shows their figure, but" in _kc["justified_why"]
            and any("Ask their manager why ZZMOD Output was moderated down" in x for x in _stc)
            and not any("doesn't match their result" in x for x in _stc), (_kc, _stc))
    s.check("the case file says a plain approval as 'approved' (the model echoed 'confirmed', which read as a file claim)",
            "approved the result as entered" in _src2 and "confirmed the result as entered" not in _src2)
    # the AI fit
    _mg = a._pm_calib_fit_manager(d, CID, _sub)
    s.check("the fit reads the manager's view: the line moderated down (with its reason) and their remark",
            _mg["down"] and _mg["down"][0]["kpi"] == "ZZMOD Output" and _mg["down"][0]["from"] == "44"
            and _mg["down"][0]["to"] == "33" and "batch count" in _mg["remark"], _mg)
    _p = {"score": 3.0, "mech": "A", "basis": "approved", "band": "ME", "approved": "ME", "J": 0.5, "D": 0.5,
          "files": 0, "words": 0, "verdict": None, "mod_down": _mg["down"], "mod_up": [], "mgr_remark": _mg["remark"],
          "M": -0.2}
    _rs = a._pm_calib_fit_reasons(_p, "down", "Meet Expectation", [_p])
    s.check("...and its reasons say so -- the moderation, which way, its reason; the manager's remark",
            any("their line manager moderated ZZMOD Output down (44 → 33): Output counted a returned batch" in x for x in _rs)
            and any(x.startswith("their line manager's remark: “Solid delivery") for x in _rs) and len(_rs) <= 6, _rs)
    _q = dict(_p, M=0.0)
    s.check("...a line moderated DOWN weakens their case in the band (so they move down before an equal peer)",
            a._pm_calib_fit_case([dict(_p)], "ME")[0]["case"] < a._pm_calib_fit_case([_q], "ME")[0]["case"])
    s.check("the AI fit writes no note of its own (Chris, 2026-10-06: 'it shouldn't populate the remark and leave it "
            "for the BUCEO to fill'): its reasons are in the preview only",
            "_calib_fit_note(reasons)" not in H.source(a)
            and 'note = _calib_existing_note(db, "pm", (tier, kw, ctx), sid)   # never the AI\'s words' in H.source(a)
            and 'note = _calib_existing_note(db, "pot", sc, sid)\n' in H.source(a))
    d.execute("DELETE FROM pm_kpi_targets WHERE id=?", (_t,))
    d.execute("DELETE FROM pm_manager_remarks WHERE subject_id=?", (_sub,))
    d.execute("DELETE FROM users WHERE id IN (?,?)", (_sub, _mgr))
    d.commit()

# the potential insight: what the line manager's competency review CHANGED, and why
_real = (a.subject_result, a.subject_report_context, a._calib_tc_evidence, a.feedback_overall_remarks)
try:
    a.subject_result = lambda db, s_, c_: {"score_valid": True, "submitted": 5, "min_valid": 4}
    a.subject_report_context = lambda db, s_, c_: {"agreement": [{"name": "Decisive Execution", "description": "d",
                                                                   "statements": [{"yes": 4, "total": 5}], "comments": []}]}
    a._calib_tc_evidence = lambda db, s_, c_: {"status": "reviewed", "overall_remark": "", "manager_overall_remark":
                                               "Strong on cost; not yet leading planning across sites.", "groups": [
        {"name": "Operations", "n_yes": 1, "n_total": 2, "manager_remark": "My call on the next level here.", "rows": [
            {"title": "Production Planning", "moderated": True, "effective": "no", "is_future": 1,
             "manager_remark": "Not yet at the next level."},
            {"title": "Inventory Management", "moderated": False, "effective": "yes", "manager_remark": ""}]}]}
    a.feedback_overall_remarks = lambda db, sid, cid: []
    with a.app.test_request_context("/"):
        _st, _fp, _srcp, _xp, _fp2 = a._pot_summary_source(a.get_db(), {"id": 1, "full_name": "ZZ Pot Person",
                                                                          "job_grade": 13}, CID)
    s.check("potential: the insight's source names what the line manager's review moved (at which LEVEL), and their notes",
            "their line manager's review moved Production Planning (next level) to still developing" in _srcp
            and "their line manager's note on Production Planning (next level): <<<Not yet at the next level.>>>" in _srcp
            and "their line manager's note on Operations" in _srcp
            and "Their line manager's competency remark" in _srcp, _srcp)
    s.check("...the plain summary says it too", "On review, their line manager moved Production Planning (next level) to "
            "still developing." in a._pot_summary_plain(_fp, _fp2), a._pot_summary_plain(_fp, _fp2))
    _ok = ("Raters see them strong on Decisive Execution; their line manager's review moved Production Planning (next "
           "level) to still developing, noting it is not yet at the next level.")
    s.check("...and an insight that attributes it to the line manager's review passes the checks",
            a._pot_summary_error(_srcp, _xp, _ok) is None, a._pot_summary_error(_srcp, _xp, _ok))
    s.check("...while 'their line manager said' (a 360 relationship) is still refused",
            a._pot_summary_error(_srcp, _xp, "Their line manager said they plan well.") is not None)
finally:
    a.subject_result, a.subject_report_context, a._calib_tc_evidence, a.feedback_overall_remarks = _real
import importlib as _il
_ad = _il.import_module("ai_draft")
s.check("prompts: the performance assessment weighs the reviewers' views; the potential one allows the competency review",
        "THEIR LINE MANAGER'S MODERATION" in _ad._PERF_ASSESS_SYSTEM and "HOW IT REACHED YOU" in _ad._PERF_ASSESS_SYSTEM
        and "The COMPETENCY review is different from the 360" in _ad._POT_SUMMARY_SYSTEM
        and (_ad._PERF_ASSESS_SYSTEM % "X"))
_ce0 = _jsc.find("function calEvidenceTable("); _ce = _jsc[_ce0:_jsc.find("\n  var VERDICT_BAND_NAME", _ce0)]
_pre = H.source(a)[H.source(a).find("def _pm_remark_entries("):H.source(a).find("_POT_REMARKS_VOCAB = (")]
s.check("the remarks list: the approvers' remarks EACH under its own author and role (a co-approver's view is never "
        "headed 'line manager'), each moderation reason under its KPI with its from -> to; client: each moderation in "
        "the evidence table -- who, the short reason, the whole one on hover; the moderated figure in the Result cell",
        '("Their line manager" if lm else "Approver") + " — " + m["author"]' in _pre
        and '"Their line manager\'s overall remark" if lm else "Another approver\'s overall remark"' in _pre
        and '"Moderation — " + (m.get("by") or "their line manager")' in _pre
        and '"Moderated by "' in _ce and '" — no reason given"' in _ce
        and "(m.why_short || m.why)" in _ce and "ml.title = m.why" in _ce and 'rmkEl("span", "rv-cal-now", k.mod_result)' in _ce)
s.check("client: every remark in full is one click away, each under its owner, a move as its tag",
        'name: x.who + (x.on ? " — on " + x.on : ""), text: x.text, tag: x.move || ""' in _jsc)
s.check("client (review): the chat's lock card says who locks unrated and carries the reason-dialog message, from the same "
        "helper the curve's lock uses",
        _jsc.count("calLockLeft(d)") >= 2 and _jsc.count("CAL_OVERRIDE_MSG +") >= 2)
# the arrival paint moved out of the pump into calSumLanded (2026-10-09: the one read lands through it too)
_pu0 = _jsc.find("function calSumLanded("); _pu = _jsc[_pu0:_jsc.find("\n  }\n", _pu0)]
s.check("client (review): the insight-arrival re-anchor runs only for the person ON SCREEN, only when it painted, only "
        "downward, and never after they scrolled away",
        "onScreen" in _pu and "painted" in _pu and "calAnchorTop" in _pu and "dy > 0" in _pu
        and "var onScreen = front && cal.data" in _pu and "calSumLanded(k, true);" in _jsc
        and "calAnchorTop = log.scrollTop" in _jsc)

s.section("the performance person page (2026-10-05): how the rating got here; the HOD's remark whole and named")
with a.app.test_request_context():
    db = a.get_db()
    _h0 = db.execute("SELECT hod_id FROM users WHERE id=?", (A["id"],)).fetchone()["hod_id"]
    db.execute("UPDATE users SET hod_id=? WHERE id=?", (B["id"], A["id"]))
    db.execute("INSERT OR IGNORE INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label) "
               "VALUES (?, 'hod', ?, ?, 'test')", (CID, str(B["id"]), BG))
    _hs = db.execute("SELECT id FROM pm_calibration_sessions WHERE cycle_id=? AND tier='hod' AND scope_key=?",
                     (CID, str(B["id"]))).fetchone()["id"]
    _long = "Kept the line manager's view and moved them down a band: " + "steady delivery, thin evidence, " * 12
    db.execute("DELETE FROM pm_calibration_adjustments WHERE session_id=? AND subject_id=?", (_hs, A["id"]))
    db.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band, "
               "justification) VALUES (?, ?, 'AE', 'ME', ?)", (_hs, A["id"], _long))
    db.execute("UPDATE pm_calibration_sessions SET locked_at=datetime('now') WHERE id=?", (_hs,))
    db.commit()
    try:
        _c = fresh_ctx()
        _c["population"] = [db.execute("SELECT * FROM users WHERE id=?", (x["id"],)).fetchone() for x in pop]
        _ovb = a._pm_calib_assist_overview(db, SU, _c, "buceo", {"bg": BG, "company": "ZZTESTCO"})["data"]
        _ra = next(x for x in _ovb["rows"] if x["id"] == A["id"])
        _ovh = a._pm_calib_assist_overview(db, SU, fresh_ctx(), "hod", KW)["data"]
        _rh = next(x for x in _ovh["rows"] if x["id"] == A["id"])
        _pe_bu = a._pm_remark_entries(db, SU, A["id"], "buceo")
        _pe_hod = a._pm_remark_entries(db, SU, A["id"], "hod")
        _real_ai = (a.ai_draft.is_configured, a.ai_draft.summarise_remarks)
        _seen = {}
        a.ai_draft.is_configured = lambda: True
        a.ai_draft.summarise_remarks = lambda first, src, reviewer=None, timeout=20, about="potential": (
            _seen.update(about=about, src=src) or "The HOD moved them from Above Expectation to Meet Expectation, "
            "noting steady delivery and thin evidence.")
        try:
            db.execute("DELETE FROM pm_remark_summaries WHERE subject_id=?", (A["id"],)); db.commit()
            _ps = a._pot_remarks_summary_for(db, A["id"], CID, "buceo", _pe_bu, generate=True, axis="pm")
            _say_adv = "The HOD kept them; they should be Outstanding."
            a.ai_draft.summarise_remarks = lambda first, src, reviewer=None, timeout=20, about="potential": _say_adv
            db.execute("DELETE FROM pm_remark_summaries WHERE subject_id=?", (A["id"],)); db.commit()
            _ps_adv = a._pot_remarks_summary_for(db, A["id"], CID, "buceo", _pe_bu, generate=True, axis="pm")
            _pcached = db.execute("SELECT COUNT(*) c FROM pm_remark_summaries WHERE subject_id=? AND tier='buceo'",
                                  (A["id"],)).fetchone()["c"]
        finally:
            a.ai_draft.is_configured, a.ai_draft.summarise_remarks = _real_ai
            db.execute("DELETE FROM pm_remark_summaries WHERE subject_id=?", (A["id"],)); db.commit()
    finally:
        db.execute("DELETE FROM pm_calibration_adjustments WHERE session_id=?", (_hs,))
        db.execute("DELETE FROM pm_calibration_sessions WHERE id=?", (_hs,))
        db.execute("UPDATE users SET hod_id=? WHERE id=?", (_h0, A["id"]))
        db.commit()
_tr = (_ra.get("trail") or [{}])[0]
s.check("a BU CEO's row carries the HOD's move with their remark WHOLE (it was cut at 300 characters) and their name",
        _tr.get("label") == "HOD" and _tr.get("note") == _long.strip() and len(_long) > 300
        and _tr.get("by") == B["full_name"] and (_tr.get("from"), _tr.get("band")) == ("AE", "ME"),
        {k: (v if k != "note" else len(v or "")) for k, v in _tr.items()})
s.check("...and an HOD's own page has no such row (their remark is theirs)", not (_rh.get("trail") or []), _rh.get("trail"))
_ph = [e for e in _pe_bu if e["role"] == "hod"]
s.check("the performance remarks list (2026-10-05): a BU CEO gets the HOD's remark with their move, labelled for the model; "
        "an HOD never gets their own back",
        len(_ph) == 1 and _ph[0]["move"] == "moved AE → ME" and _ph[0]["text"] == _long.strip()
        and _ph[0]["src"] == "The HOD's remark when they moved them from Above Expectation to Meet Expectation"
        and _ph[0]["who"] == "HOD — " + B["full_name"] and not any(e["role"] == "hod" for e in _pe_hod),
        _ph and {k: v for k, v in _ph[0].items() if k != "text"})
s.check("its AI summary is the performance one (the prompt about KPI results), cached per tier in pm_remark_summaries",
        _ps["source"] == "ai" and _seen.get("about") == "performance" and "<<<" in _seen.get("src", "")
        and _pcached == 1, (_ps, _seen.get("about"), _pcached))
_fw = a._remarks_figure_words("Gross profit at RM 14.3 mil; 5 reads Outstanding; 4.5 reads; 2 files")
_tents = [{"role": "self", "who": "Their overall remark", "on": None, "move": None, "src": "Their own overall remark",
           "text": "Gross profit reached RM 14.3 mil after I moved 2 plants onto the new contract."},
          {"role": "hod", "who": "HOD", "on": None, "move": "set OU", "src": "The HOD's remark when they set them at Outstanding",
           "text": "Set on their own results: 5 reads Outstanding."}]
with a.app.test_request_context():
    db = a.get_db()
    _real_ai2 = (a.ai_draft.is_configured, a.ai_draft.summarise_remarks)
    a.ai_draft.is_configured = lambda: True
    a.ai_draft.summarise_remarks = lambda first, src, reviewer=None, timeout=20, about="potential": (
        "They stress gross profit of RM 14.3 million after moving two plants onto the new contract, as their KPI notes "
        "say; the HOD set them at Outstanding, noting five reads Outstanding on their own results.")
    try:
        db.execute("DELETE FROM pm_remark_summaries WHERE subject_id=?", (A["id"],)); db.commit()
        _pf = a._pot_remarks_summary_for(db, A["id"], CID, "buceo", _tents, generate=True, axis="pm")
    finally:
        a.ai_draft.is_configured, a.ai_draft.summarise_remarks = _real_ai2
        db.execute("DELETE FROM pm_remark_summaries WHERE subject_id=?", (A["id"],)); db.commit()
s.check("the same figures written another way are the remarks' own (GPT-6 Luna, 2026-10-05: 'mil' read 'million', '5' "
        "read 'five', 'KPI' -- 6 of 8 faithful summaries were refused on these)",
        _fw == ["million", "five", "two"] and _pf["source"] == "ai", (_fw, _pf))
s.check("...and one that says what the rating should be falls back to the remarks themselves",
        _ps_adv["source"] == "plain" and "The HOD (moved AE → ME) wrote:" in _ps_adv["summary"], _ps_adv)
_jsp = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "journey_chat.js"),
            encoding="utf-8").read()
s.check("client: the performance card shows how the rating got here in the potential breakdown's box -- self, line "
        "manager, the tier below with who, your move -- instead of the amber lines",
        "function perfJourney(d, r, review)" in _jsp
        and "card.appendChild(pot ? potJourney(d, r, review) : perfJourney(d, r, review));" in _jsp
        and "journeyMoves(box, d, r, review);" in _jsp and "hodInRemarks" not in _jsp
        and 'deltas.push({ t: t.label + (kept ? " kept "' not in _jsp
        and '"Not approved by their line manager yet. These are their own submitted results."' not in _jsp
        and 'deltas.push({ t: "Self-rated "' not in _jsp)
s.check("client: the justification block carries the AI summary of what they, their line manager and the HOD wrote, "
        "and every remark in full one click away (2026-10-05: 'the AI summary for performance should be included in "
        "this justification as well')",
        "function calRemarksPart(r, pot, hodSeat, buSeat)" in _jsp and "perfRemarks" not in _jsp and "calRemark(" not in _jsp
        and 'fetch(pot ? "/review/team/pot-summary" : "/review/team/calib-summary",' in _jsp
        and "card._calRow = r; card._hodSeat = d.tier !== \"hod\";" in _jsp
        and 'b.textContent = "Read the remarks in full";' in _jsp)

sys.exit(s.done())
