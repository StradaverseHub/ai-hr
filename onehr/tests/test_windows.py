"""Open & close dates -- per cycle, per module x role (Chris, 2026-10-02: "admin should have the activation and closing
function to control the cutoff for each role on each module").

WINDOW_CELLS names each module x role; window_closed() is the one check; a before_request gate refuses every dedicated
write route outside its window, and the shared writers the chat's tools reach ask the same check. Blank = open, as
before. Everything here runs on the scratch copy and puts back what it changed.
"""
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Open & close dates -- per module and role, enforced on every write")

with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PERIOD = dict(a.active_pm_period(db))
    _ORIG = {"modules": [tuple(r) for r in db.execute(
                 "SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))],
             "due": (db.execute("SELECT value FROM app_settings WHERE key='dept_review_due'").fetchone() or [None])[0],
             "windows": [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows")]}
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=?", (CID,))   # a module that is off answers 404 first
    db.execute("DELETE FROM cycle_windows")
    db.execute("DELETE FROM app_settings WHERE key='dept_review_due'")
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (SELECT id FROM users WHERE employee_id='ZZWIN-EMP')")
    db.execute("DELETE FROM users WHERE employee_id='ZZWIN-EMP'")
    cols = [c for c in base.keys() if c != "id"]
    v = dict(base, username="zzwin-emp", employee_id="ZZWIN-EMP", full_name="ZZ Window Tester", email=None,
             hod_id=None, manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None,
             confirmation_date="2020-01-01", left_at=None)   # confirmed, so the journey is theirs to fill in
    db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
    EMP = db.execute("SELECT id FROM users WHERE employee_id='ZZWIN-EMP'").fetchone()[0]
    # one KPI line, so the KPI check-in is a real part of their journey (the generated fixture has none for them)
    db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company) "
               "VALUES (?,?,?,?,?,?,?)", (PERIOD["id"], EMP, "ZZWIN KPI", 100, "more", base["business_group"],
                                          base["company"]))
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND (admin_bg IS NULL OR admin_bg='') AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]
    db.commit()
    NOW = a._now_myt()

PAST = (NOW - timedelta(days=1)).strftime("%Y-%m-%d %H:%M")
SOON = (NOW + timedelta(days=1)).strftime("%Y-%m-%d %H:%M")
LATER = (NOW + timedelta(days=9)).strftime("%Y-%m-%d %H:%M")
KEYS = a.WINDOW_KEYS


def setw(cell, opens=None, closes=None):
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                  (CID, cell, opens, closes))
        d.commit()


def clearw():
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("DELETE FROM cycle_windows")
        d.execute("DELETE FROM app_settings WHERE key='dept_review_due'")
        d.commit()


def closed(cell):
    with a.app.test_request_context("/"):
        return a.window_closed(a.get_db(), cell)


def user(uid):
    with a.app.test_request_context("/"):
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


try:
    # -----------------------------------------------------------------------
    s.section("the rule: blank = open; before it opens; after it closes")
    s.check("fourteen cells and Grade H Appraisal's six (2026-10-28), module x role, each with its sentence", len(KEYS) == 20 and len(set(KEYS)) == 20
            and len(KEYS) - len(a.GRADEH_CELL_KEYS) == 14 and all(c[4] for c in a.WINDOW_CELLS), KEYS)
    _ey = [c for c in KEYS if c in a.EARLY_YEAR_CELLS]
    s.check("no dates anywhere: every cell is open (nothing changes until an admin sets a date) -- but KPI setting",
            all(closed(c) is None for c in KEYS if c not in _ey), [c for c in KEYS if c not in _ey and closed(c)])
    s.check("...which is closed outside an Early Year, with the sentence (2026-10-15)", len(_ey) == 2
            and all(closed(c) == a._KPI_SETTING_ELSEWHERE for c in _ey), [closed(c) for c in _ey])
    with a.app.app_context():
        _d = a.get_db()
        _cyc0 = dict(_d.execute("SELECT id, half, kind FROM cycles WHERE is_active=1").fetchone())
        _d.execute("UPDATE cycles SET half=0, kind='early_year' WHERE id=?", (_cyc0["id"],))
        _d.commit()
    _open_ey = [closed(c) for c in _ey]
    with a.app.app_context():
        _d = a.get_db()
        _d.execute("UPDATE cycles SET half=?, kind=? WHERE id=?", (_cyc0["half"], _cyc0["kind"], _cyc0["id"]))
        _d.commit()
    s.check("...and open, with no dates, in an Early Year", _open_ey == [None, None], _open_ey)
    setw("pm_results", opens=SOON)
    _m1 = closed("pm_results")
    setw("pm_results", closes=PAST)
    _m2 = closed("pm_results")
    setw("pm_results", opens=PAST, closes=LATER)
    _m3 = closed("pm_results")
    s.check("before it opens: 'The results check-in opens on <date>.'; after it closes: '... closed on <date>.'; "
            "between the two: open",
            (_m1 or "").startswith("The results check-in opens on ") and (_m2 or "").startswith(
                "The results check-in closed on ") and _m3 is None, (_m1, _m2, _m3))
    with a.app.test_request_context("/"):
        _d = a.get_db()
        _due = a._window_due_disp(_d, "pm_results")
    s.check("...and while open with a closing date ahead, the closing time is on hand to show", bool(_due), _due)
    clearw()
    with a.app.test_request_context("/"):
        _d = a.get_db()
        _d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('dept_review_due', ?)", (PAST,))
        _d.commit()
    _h0 = closed("pm_hod")   # the old Settings deadline is read by nothing now (merged into the calendar, 2026-10-11)
    setw("pm_hod", closes=PAST)
    setw("pot_hod", closes=PAST)
    _h1 = closed("pm_hod")
    setw("pm_hod", closes=LATER)
    _h2 = closed("pm_hod")
    with a.app.test_request_context("/"):
        _h3 = a._hod_review_closed(a.get_db(), "pot", CID, [])
    s.check("the HOD's two cells close on the calendar's own dates only; the old Settings deadline closes nothing",
            _h0 is None and (_h1 or "").startswith("The department review closed on ") and _h2 is None
            and (_h3 or "").startswith("The department review closed on "), (_h0, _h1, _h2, _h3))
    clearw()

    # -----------------------------------------------------------------------
    s.section("every write route is refused outside its window (built from the route map, so none is missed)")
    # Every POST route of these modules is either gated or named here as not a role's write in a window: AI drafts and
    # summaries (no record), the demo resets, previews, unlocks / the super override (admin), the group tier and the
    # PIP / promotion decisions (no cell), the evidence ledger's note, the setting/agent chats (their tools ask).
    _NOT_A_WINDOW = {
        "technical_section_draft_ai", "technical_overall_draft_ai", "technical_review_section_draft_ai",
        "technical_review_overall_draft_ai", "technical_draft_ai", "idp_suggest", "idp_draft_ai",
        "performance_kpi_setting_draft_ai", "performance_kpi_draft_ai", "performance_overall_remark_draft_ai",
        "performance_kpi_justification_draft_ai", "performance_team_member_remark_draft_ai",
        "performance_team_member_preview", "review_team_pm_summary", "review_team_tm_summary", "review_team_tm_360", "review_team_idp_summary",
        "review_team_calib_summary", "review_team_pot_summary", "review_team_tbox_person", "review_team_tbox_insight", "review_team_insights", "review_demo_reset_team", "review_demo_reset_calibration",
        "review_demo_reset_all", "review_demo_mechanism", "review_demo_feedback_reset", "review_team_note",
        "review_team_calib_move", "review_team_calib_fit", "review_team_dept_accept",   # -> the calibration writers
        "calibration_hod_unlock", "calibration_company_unlock", "calibration_bg_unlock", "pm_calibration_hod_unlock",
        "calibration_bugroup_unlock",
        "pm_calibration_buceo_unlock", "pm_calibration_bgceo_unlock", "pm_calibration_group_unlock",
        "pm_calibration_group_adjust", "pm_calibration_group_reset", "pm_calibration_group_lock",
        "pm_calibration_group_lock_people",
        "pm_calibration_override", "pm_calibration_override_clear", "talent_box_group_move", "talent_box_group_tag",
        "talent_box_group_lock",
        "pm_calib_chat", "review_ahead_chat", "review_career_chat", "review_competency_chat",   # chats: tools ask
        # Grade H Appraisal's HOD and BU CEO stages (2026-10-28, pieces 5 and 6): their writers ask window_closed themselves (the
        # calendar's gradeh_hod_pot / gradeh_hod_perf / gradeh_buceo cells, tests/test_gradeh_admin.py), like the chats' tools do
        "calib_gradeh_hod_move", "calib_gradeh_hod_agree", "calib_gradeh_hod_signoff", "calib_gradeh_unit_move",
        "calib_gradeh_unit_signoff",
        # AI+ fit to curve (2 Nov 2026): the fit asks the same gates itself (_gh_cal_hod_stage_gate: the calendar cell and the early-opening
        # rule; gradeh_bu_gate) before it suggests or writes, and each applied move goes through the writer above (tests/test_gradeh_fit.py)
        "calib_gradeh_hod_fit", "calib_gradeh_unit_fit",
        # Talent Box Round 2 (2026-11-15): Suggest reads only; Apply all runs each move through _talent_box_apply, which asks the Talent Box
        # window with the BG CEO's late pass, and the lock-by day (tests/test_tb_round2.py)
        "tb_round_suggest", "tb_round_apply"}
    _prefixes = ("/review/kpi", "/review/competency", "/review/feedback", "/review/career", "/review/ahead",
                 "/review/evidence", "/review/setting/propose", "/review/confirm", "/review/checkin", "/review/team/",
                 "/technical/", "/idp/", "/performance/kpi", "/performance/overall", "/performance/submit",
                 "/performance/setting", "/performance/team", "/performance/calibration", "/calibration/",
                 "/talent-box/", "/rate/")
    _unmapped = sorted({r.endpoint for r in a.app.url_map.iter_rules()
                        if "POST" in (r.methods or ()) and r.rule.startswith(_prefixes)
                        and "/pip/" not in r.rule and "/promotion/" not in r.rule
                        and not a.archived_module_of(r.rule, r.endpoint)   # archived: a bare 404 (2026-10-13)
                        and r.endpoint not in a.WINDOW_ENDPOINT_CELLS and r.endpoint not in _NOT_A_WINDOW
                        and r.endpoint != "review_team_approve_bulk"})
    s.check("every POST route of these modules is gated, or named as not a role's write (a new route can't slip by)",
            not _unmapped, _unmapped)
    for c in KEYS:
        setw(c, closes=PAST)
    cl = H.client_as(a, EMP)
    _miss, _ok = [], 0
    _routes = sorted(a.WINDOW_ENDPOINT_CELLS.items()) + [("review_team_approve_bulk", ["pm_approve"]),
                                                        ("review_team_approve_bulk", ["tc_approve"])]
    _stage = {"pm_approve": "pm_review", "tc_approve": "tm_review"}
    for ep, cells in _routes:
        rule = next(iter(a.app.url_map.iter_rules(ep)))
        args = {k: (1 if "Integer" in type(conv).__name__ else "x") for k, conv in rule._converters.items()}
        with a.app.test_request_context("/"):
            url = a.url_for(ep, **args)
        data = {"csrf_token": "tok"}
        if ep == "review_team_approve_bulk":
            data["stage"] = _stage[cells[0]]
        r = cl.post(url, data=data, headers={"Sec-Fetch-Mode": "cors"})
        j = r.get_json(silent=True) or {}
        want = [closed(c) for c in cells]
        if r.status_code == 409 and j.get("window_closed") and j.get("error") in want:
            _ok += 1
        else:
            _miss.append((ep, r.status_code, j.get("error") or r.get_data(as_text=True)[:80]))
    s.check("all %d mapped routes answer 409 with the sentence when their cell is closed" % len(_routes),
            not _miss and _ok == len(_routes), _miss[:6])
    r = cl.post("/technical/submit", data={"csrf_token": "tok"})
    with cl.session_transaction() as _ss:
        _fl = " ".join(m for _c, m in (_ss.get("_flashes") or []))
        _ss.pop("_flashes", None)
    s.check("a plain form post goes back where it came from with the sentence as a flash, nothing saved",
            r.status_code == 302 and "The competency self-assessment closed on " in _fl, (r.status_code, _fl))
    clearw()
    _over = []
    for ep, cells in _routes:
        rule = next(iter(a.app.url_map.iter_rules(ep)))
        args = {k: (1 if "Integer" in type(conv).__name__ else "x") for k, conv in rule._converters.items()}
        with a.app.test_request_context("/"):
            url = a.url_for(ep, **args)
        data = {"csrf_token": "tok", "stage": _stage.get(cells[0], "")}
        r = cl.post(url, data=data, headers={"Sec-Fetch-Mode": "cors"})
        if (r.get_json(silent=True) or {}).get("window_closed") and not set(cells) <= set(a.EARLY_YEAR_CELLS):
            _over.append(ep)
    s.check("...and with no dates set, none of them is held by a window (the gate never over-reaches; KPI setting "
            "is held outside an Early Year by design)", not _over, _over[:6])
    setw("pm_results", closes=PAST)
    r = cl.post("/review/competency/save-all", data={"csrf_token": "tok"}, headers={"Sec-Fetch-Mode": "cors"})
    s.check("one cell closed holds only its own routes: competency still goes through with the check-in closed",
            not (r.get_json(silent=True) or {}).get("window_closed"), r.get_json(silent=True))
    clearw()

    # -----------------------------------------------------------------------
    s.section("the writers the chat's tools reach ask the same check")
    for c in KEYS:
        setw(c, closes=PAST)
    with a.app.test_request_context("/"):
        d = a.get_db()
        u = user(EMP)
        M = {c: a.window_closed(d, c) for c in KEYS}
        got = {
            "_review_record_one": a._review_record_one(d, u, CID, 0, 1.0) == {"ok": False, "error": M["pm_results"]},
            "_review_tool_checkin": a._review_tool_checkin(d, u, CID, {}) == {"ok": False, "error": M["pm_results"]},
            "_review_do_confirm": a._review_do_confirm(d, u, CID) == (False, M["pm_results"]),
            "_review_tool_set_overall_remark": a._review_tool_set_overall_remark(d, u, CID, {"text": "x"})
            == {"ok": False, "error": M["pm_results"]},
            "_setting_ctx_or_error": a._setting_ctx_or_error(d, u) == (None, {"ok": False, "error": M["pm_setting"]}),
            "_pm_moderate_draft": a._pm_moderate_draft(d, u, 0, "1", None)[1].get("msg") == M["pm_approve"],
            "_pm_moderate_commit": a._pm_moderate_commit(d, u, 0, "", None)[1].get("msg") == M["pm_approve"],
            "_pm_manager_remark_write": a._pm_manager_remark_write(d, u, PERIOD, 0, "x")[1].get("msg")
            == M["pm_approve"],
            "_tc_submit": a._tc_submit(d, CID, u, None) == (False, M["tc_self"]),
            "_tc_tool_set_competency": a._tc_tool_set_competency(d, u, CID, {}) == {"ok": False, "error": M["tc_self"]},
            "_tc_tool_set_overall_note": a._tc_tool_set_overall_note(d, u, CID, {"text": "x"})
            == {"ok": False, "error": M["tc_self"]},
            "_tc_save_competency_note": a._tc_save_competency_note(d, u, CID, 0, "x") == (False, M["tc_self"]),
            "_tc_override_one": a._tc_override_one(d, u, CID, 0, 0, "yes", "")[1].get("msg") == M["tc_approve"],
            "_tc_approve_assessment": a._tc_approve_assessment(d, u, CID, 0)[1].get("msg") == M["tc_approve"],
            "_feedback_open_or_error": a._feedback_open_or_error(d, u) == (None, {"ok": False, "error": M["f360"]}),
            "_idp_ctx_or_error": a._idp_ctx_or_error(d, u, create=True) == (None, {"ok": False, "error": M["idp_self"]}),
            "pm_idp_share": a.pm_idp_share(d, u, PERIOD, None) == (False, [M["idp_self"]]),
            "pm_career_save_field": a.pm_career_save_field(d, 0, "x", "y") == (False, M["idp_self"]),
            "_career_tool_set_direction": a._career_tool_set_direction(d, u, CID, {})
            == {"ok": False, "error": M["idp_self"]},
            "_idp_goal_write": a._idp_goal_write(d, u, PERIOD, 0, "1", "x", "y")[1].get("msg") == M["idp_review"],
            "_idp_plan_comment_write": a._idp_plan_comment_write(d, u, PERIOD, 0, "x")[1].get("msg")
            == M["idp_review"],
            "_idp_career_comment_write": a._idp_career_comment_write(d, u, PERIOD, 0, "x")[1].get("msg")
            == M["idp_review"],
            "_idp_approve_plan": a._idp_approve_plan(d, u, PERIOD, 0)[1].get("msg") == M["idp_review"],
            "_hod_review_closed (pm / pot)": a._hod_review_closed(d, "pm", CID, []) == M["pm_hod"]
            and a._hod_review_closed(d, "pot", CID, []) == M["pot_hod"],
            "window_closed_tier": a.window_closed_tier(d, "buceo", "pot") == M["pot_buceo"]
            and a.window_closed_tier(d, "bgceo", "pm") == M["tb_bgceo"]
            and a.window_closed_tier(d, "buceo", "both") == M["pm_buceo"],
        }
    s.check("every writer refuses with its cell's sentence (%d)" % len(got), all(got.values()),
            [k for k, ok in got.items() if not ok])
    _src = {f: H.source(a, "app.py").split("def %s(" % f, 1)[1][:4600] for f in
            ("_pm_calib_apply", "_pot_calib_apply", "_talent_box_apply")}
    s.check("...and the calibration writers (chat moves, the in-place curve, the department review's keep) ask the "
            "tier's cell; the HOD's goes through _hod_review_closed",
            # each now names its scope (2026-10-31, the late pass: a pass for unit A must not open unit B)
            'window_closed_tier(db, tier, "pm", period["id"], scope=_late_ctx_scopes(ctx))' in _src["_pm_calib_apply"]
            and 'if tier != "hod" else None' in _src["_pm_calib_apply"]
            and 'window_closed_tier(db, tier, "pot", ctx["cycle_id"], scope=_late_ctx_scopes(ctx))' in _src["_pot_calib_apply"]
            and 'if tier != "hod" else None' in _src["_pot_calib_apply"]
            and 'window_closed_tier(db, tier, "both", scope=_late_ctx_scopes(ctx))' in _src["_talent_box_apply"])
    clearw()

    # -----------------------------------------------------------------------
    s.section("the card says it before they type")
    setw("pm_results", closes=PAST)
    setw("pm_approve", closes=PAST)
    with a.app.test_request_context("/review/journey?stage=account"):
        from flask import session as _fs
        _fs["user_id"] = EMP
        d = a.get_db()
        _ov = a._journey_overview(d, user(EMP), "account")
        _note_emp = _ov.get("window_note")
        _note_none = a._journey_window_note(d, user(EMP), "competency")
        _note_team = a._journey_window_note(d, user(EMP), "pm_review")
    s.check("a part's overview carries the closed sentence for its role's cell (the employee's check-in, the line "
            "manager's approval); an open part carries none",
            (_note_emp or "").startswith("The results check-in closed on ") and _note_none is None
            and (_note_team or "").startswith("Results approval closed on "), (_note_emp, _note_none, _note_team))
    _jsw = H.source(a, "static/journey_chat.js")
    _aw = _jsw.split("function applyWindowNote(overview) {", 1)[1].split("\n  }\n", 1)[0]
    s.check("client: the card shows the sentence above its body and greys its save / submit controls by a class (a "
            "body rebuild never brings them back); the KPI Save never says 'saved' when the server refused it",
            "applyWindowNote(overview);" in _jsw and 'rmkEl("div", "rv-window-note")' in _aw
            and 'node.classList.add("rv-win-closed")' in _aw
            and "if (!j || !j.ok) {   // refused (a closed window, a locked check-in)" in _jsw
            and ".rv-win-closed .rv-save-submit" in H.source(a, "static/style.css"))
    # the chat closes too (Chris, 2026-10-02: "when the result check in is closed, the chat should also be disabled")
    import json as _json
    _real_agent, _real_avail = a.ai_draft.review_agent, a.ai_draft.review_agent_available
    a.ai_draft.review_agent_available = lambda: True      # the journey answers "not switched on" with no model
    _calls = []
    a.ai_draft.review_agent = lambda *x, **k: (_calls.append(1), {"say": "MODEL", "quick_replies": [], "action": None})[1]
    try:
        _ce = H.client_as(a, EMP)
        with a.app.test_request_context("/"):
            _d = a.get_db()
            _d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('review_unified','1')")
            _d.commit()
        _ct = _ce.post("/review/chat", data={"csrf_token": "tok", "message": "what should I write for gross profit?",
                                            "journey": "1", "stage": "account"}).get_json() or {}
    finally:
        a.ai_draft.review_agent, a.ai_draft.review_agent_available = _real_agent, _real_avail
        with a.app.test_request_context("/"):
            _d = a.get_db()
            _d.execute("DELETE FROM app_settings WHERE key='review_unified'")
            _d.commit()
    s.check("a message on a closed part gets the closed sentence with no model call, stored nowhere",
            (_ct.get("say") or "").startswith("The results check-in closed on ") and _ct.get("window_closed") is True
            and not _calls and (_ct.get("overview") or {}).get("window_note"), (_ct.get("say"), len(_calls)))
    s.check("client: the box locks while the part on screen is closed (the sentence as placeholder, no chips, no typed "
            "or tapped turn) and unlocks on an open part; a part switch still goes",
            "function setWindowLock(note) {" in _jsw and "setWindowLock(overview.window_note || overview.chat_lock);" in _jsw
            and 'if (winClosed && (explicit === undefined || String(explicit || "").trim())) return;' in _jsw
            and "if (deptDone || winClosed) return;" in _jsw and "send.disabled = composerLocked();" not in _jsw)

    # ...the HOD's department review too (Chris, 2026-10-20: "after deadline no action can be done ... the chat will be
    # disabled, user can just read the past conversation"): its card says it through its own `closed`, so the card's
    # note stays empty and the box's lock (chat_lock) and the turn's refusal carry it
    setw("pm_hod", closes=PAST)
    _real_tier = a._journey_view_tier
    a._journey_view_tier = lambda *x, **k: "hod"
    try:
        with a.app.test_request_context("/review/journey?view=dept"):
            from flask import session as _fs
            _fs["user_id"] = EMP
            d = a.get_db()
            _hod_card = a._journey_window_note(d, user(EMP), "calibration")
            _hod_chat = a._journey_window_note(d, user(EMP), "calibration", chat=True)
            _hod_pot = a._journey_window_note(d, user(EMP), "calibration_pot", chat=True)
    finally:
        a._journey_view_tier = _real_tier
    s.check("an HOD's closed department review: no second note on its card, but the chat box locks on that axis only",
            _hod_card is None and (_hod_chat or "").startswith("The department review closed on ") and _hod_pot is None,
            (_hod_card, _hod_chat, _hod_pot))
    _tsrc = H.source(a, "app.py")
    _tov = _tsrc.split("def _journey_team_overview(", 1)[1].split("\ndef ", 1)[0]
    _tturn = _tsrc.split("def _journey_team_chat_turn(", 1)[1].split("\ndef ", 1)[0]
    s.check("...the manager-side card carries chat_lock, and the manager-side turn refuses with chat=True",
            'ov["chat_lock"] = ov["window_note"] or (_journey_window_note(db, u, ov["stage"], subj, chat=True)' in _tov
            and 'else 0, chat=True)' in _tturn.split("_wn = (_journey_window_note(", 1)[1][:120])

    # ...and every per-part assistant: a closed part gets its sentence, no model call, nothing stored; its page locks
    # the box on load (chat_window_note) and on a refused turn (window_closed in the reply)
    setw("tc_self", closes=PAST)
    setw("idp_self", closes=PAST)
    _PARTS = {"/review/chat": ("review_chat", "pm_results", "pm_review_chat", "review_chat", "review"),
              "/review/setting/chat": ("review_setting_chat", "pm_setting", "pm_setting_chat", "setting_chat",
                                       "review_setting"),
              "/review/competency/chat": ("review_competency_chat", "tc_self", "tc_review_chat", "competency_chat",
                                          "review_competency"),
              "/review/ahead/chat": ("review_ahead_chat", "idp_self", "pm_idp_chat", "ahead_chat", "review_ahead"),
              "/review/career/chat": ("review_career_chat", "idp_self", "pm_career_chat", "career_chat",
                                      "review_career")}
    _lint = {}
    for _url, (_fn, _cell, _tbl, _js, _tpl) in _PARTS.items():
        _body = _tsrc.split("def %s():" % _fn, 1)[1].split("\n@app.route", 1)[0]
        _g = _body.find('_wn = window_closed(db, "%s", subject_id=u["id"])' % _cell)
        _jss = H.source(a, "static/%s.js" % _js)
        _lint[_url] = (0 <= _g < _body.find("INSERT INTO %s" % _tbl) and _g < _body.find("ai_draft.review_agent(")
                       and "window_closed=True, window_note=_wn" in _body
                       and "chat_window_note('%s')" % _cell in H.source(a, "templates/%s.html" % _tpl)
                       and 'root.getAttribute("data-window-closed")' in _jss
                       and "if (j && j.window_closed) lockClosed(j.window_note);" in _jss
                       and 'if (winClosed) { bubble("agent", winClosed); scrollSoon(); return; }' in _jss
                       and "send.disabled = v || !!winClosed;" in _jss)
    s.check("each per-part assistant (%d) asks its part's window before it stores or calls the model, and its page "
            "locks the box" % len(_PARTS), all(_lint.values()), [k for k, v in _lint.items() if not v])
    _real_agent, _real_avail = a.ai_draft.review_agent, a.ai_draft.review_agent_available
    _real_idp = a.get_idp_settings
    a.ai_draft.review_agent_available = lambda: True
    a.get_idp_settings = lambda *x, **k: tuple(True if i == 3 else v for i, v in enumerate(_real_idp(*x, **k)))
    _calls = []
    a.ai_draft.review_agent = lambda *x, **k: (_calls.append(1), {"say": "MODEL", "quick_replies": [], "action": None})[1]
    _got = {}
    try:
        _ce = H.client_as(a, EMP)
        for _url, (_fn, _cell, _tbl, _js, _tpl) in _PARTS.items():
            with a.app.test_request_context("/"):
                _n0 = a.get_db().execute("SELECT COUNT(*) FROM %s WHERE subject_id=?" % _tbl, (EMP,)).fetchone()[0]
            _r = _ce.post(_url, data={"csrf_token": "tok", "message": "ZZWIN still there?"})
            _j = _r.get_json(silent=True) or {}
            with a.app.test_request_context("/"):
                _n1 = a.get_db().execute("SELECT COUNT(*) FROM %s WHERE subject_id=?" % _tbl, (EMP,)).fetchone()[0]
            _got[_url] = (_r.status_code, _j.get("window_closed"), bool(_j.get("window_note")), _n1 - _n0,
                          "overview" in _j)
    finally:
        a.ai_draft.review_agent, a.ai_draft.review_agent_available = _real_agent, _real_avail
        a.get_idp_settings = _real_idp
    _reached = {k: v for k, v in _got.items() if v[1] is True}
    s.check("...and over HTTP: the KPI check-in's, KPI setting's and Career profile's assistants refuse a closed part "
            "with the sentence, no model call, nothing stored, the overview kept (%d reached)" % len(_reached),
            all(k in _reached for k in ("/review/chat", "/review/setting/chat", "/review/career/chat")) and not _calls
            and all(v[2] and v[3] == 0 and v[4] for v in _reached.values()), (_got, len(_calls)))
    with a.app.test_request_context("/"):
        from flask import session as _fs
        _fs["user_id"] = EMP
        _pg_note = a.chat_window_note("pm_results")
        _fs["user_id"] = SUP
    s.check("...the page's note is the person's own closed sentence (blank when open)",
            (_pg_note or "").startswith("The results check-in closed on "), _pg_note)
    clearw()

    # -----------------------------------------------------------------------
    s.section("Admin > Open & close dates")
    sa = H.client_as(a, SUP)
    g0 = sa.get("/admin/windows")
    body = g0.get_data(as_text=True)
    s.check("the super admin's page lists every cell for the active cycle, with dates and a state",
            g0.status_code == 200 and body.count('data-cell="') == 14 and 'name="closes_pm_results"' in body
            and "Open &amp; close dates" in body, g0.status_code)
    s.check("...and nobody else can open it", H.client_as(a, EMP).get("/admin/windows").status_code in (302, 403))
    form = {"csrf_token": "tok", "cycle": str(CID), "action": "save",
            "opens_pm_results": SOON.replace(" ", "T"), "closes_pm_results": LATER.replace(" ", "T")}
    sa.post("/admin/windows", data=form)
    _r = H.rows(a, "SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell='pm_results'", (CID,))
    s.check("Save stores the dates (MYT) and the cell reads 'not open yet'",
            _r and tuple(_r[0]) == (SOON, LATER) and (closed("pm_results") or "").endswith(
                "opens on %s." % a._when_disp(SOON)), _r and tuple(_r[0]))
    sa.post("/admin/windows", data={"csrf_token": "tok", "cycle": str(CID), "action": "save",
                                    "opens_f360": LATER.replace(" ", "T"), "closes_f360": SOON.replace(" ", "T")})
    s.check("a closing time before the opening one is refused, nothing stored",
            not H.rows(a, "SELECT 1 FROM cycle_windows WHERE cell='f360'"))
    sa.post("/admin/windows", data={"csrf_token": "tok", "cycle": str(CID), "action": "close_now:f360"})
    _c = closed("f360")
    sa.post("/admin/windows", data={"csrf_token": "tok", "cycle": str(CID), "action": "open_now:f360"})
    _o = closed("f360")
    _rf = H.rows(a, "SELECT opens_at, closes_at FROM cycle_windows WHERE cell='f360'")
    s.check("Close now closes it at once; Open now opens it and drops the closing time already past",
            (_c or "").startswith("360 feedback closed on ") and _o is None and _rf and _rf[0][1] is None, (_c, _o))
    s.check("every change is in the activity log",
            len(H.rows(a, "SELECT 1 FROM activity_log WHERE action='window' AND user_id=?", (SUP,))) >= 3)
    _base = H.source(a, "templates/base.html")
    s.check("the page is one click away: Cycle > Open & close dates in the admin sidebar (2026-10-10)",
            "_admin_side.html" in _base and any(p_["ep"] == "admin_windows" for t_ in a.ADMIN_SECTION_BY_KEY["cycle"]["tabs"]
                                                for p_ in t_["pages"]))
finally:
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("DELETE FROM cycle_windows")
        for row in _ORIG["windows"]:
            d.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", row)
        for cyc, key, act in _ORIG["modules"]:
            d.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (act, cyc, key))
        if _ORIG["due"] is None:
            d.execute("DELETE FROM app_settings WHERE key='dept_review_due'")
        else:
            d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('dept_review_due', ?)", (_ORIG["due"],))
        d.execute("DELETE FROM activity_log WHERE action='window'")
        d.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (SELECT id FROM users WHERE employee_id='ZZWIN-EMP')")
        d.execute("DELETE FROM users WHERE employee_id='ZZWIN-EMP'")
        d.commit()

sys.exit(s.done())
