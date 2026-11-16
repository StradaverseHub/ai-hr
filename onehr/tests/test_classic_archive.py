"""The classic module pages, archived as redirects to the AI+ way (Chris, 2026-10-08: "ensure the old stand alone modules
for pm tm idp and the rest are archived, we will go with the new AI+ way with the AI agent").

What this suite holds:

  * the AI+ review is ON for everyone by default (review_unified, calib_assist); '0' switches it off again, from the
    admin settings, without a deploy
  * a classic page sends a person to its AI+ replacement only when that replacement is really there for them: a model,
    the review on, the AI+ journey on, the part / view live -- else the page is served (the fallback)
  * never a write, never a script's fetch, never an admin
  * a past half's scorecard opens the record panel on the dashboard
  * the endpoints the journey still calls, and the pages with no AI+ version yet, are never redirected

Shares the suite database and puts back what it changes.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Classic pages archived as redirects to the AI+ way")
SU, _BG, EMP = H.actors(a)

with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    _prev_mod = db.execute("SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (CID,)).fetchone()
    _prev_set = {k: (db.execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone() or [None])[0]
                 for k in ("review_unified", "ai_calib")}
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'review', 1) "
               "ON CONFLICT(cycle_id, module_key) DO UPDATE SET active=1", (CID,))
    db.execute("DELETE FROM app_settings WHERE key IN ('review_unified', 'ai_calib')")
    db.commit()
_real_avail = a.ai_draft.review_agent_available
a.ai_draft.review_agent_available = lambda: True


def ctx_user(uid):
    """(db, user row) inside a request as uid."""
    from flask import session as _s
    _s["user_id"] = uid
    db = a.get_db()
    return db, db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


def loc(r):
    return r.headers.get("Location", "") if r.status_code in (301, 302) else ""


try:
    # -------------------------------------------------------------------------
    s.section("the AI+ way is on for everyone by default; '0' switches it off again")
    with a.app.test_request_context("/"):
        db, eu = ctx_user(EMP["id"])
        s.check("the AI+ journey is on for an ordinary (non-ZZ) employee with nothing set", a._review_unified_on(eu))
        s.check("...and the calibration assistant, with a model reachable", a._calib_assist_on(eu))
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', '0'), ('ai_calib', '0')")
        db.commit()
    with a.app.test_request_context("/"):
        db, eu = ctx_user(EMP["id"])
        s.check("review_unified='0' turns it off for them (only ZZ demo accounts keep it; the per-BG pilot is retired)",
                not a._review_unified_on(eu))
        s.check("ai_calib='0' (the one AI store) turns the calibration assistant off", not a._calib_assist_on(eu))
    _r0 = H.client_as(a, EMP["id"]).get("/my-assessments")
    s.check("...and then the classic page is served, not redirected", "/review/journey" not in loc(_r0), _r0.status_code)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM app_settings WHERE key IN ('review_unified', 'ai_calib')")
        db.commit()
    S_ = H.client_as(a, SU["id"])
    S_.post("/admin/settings", data={"csrf_token": "tok", "action": "review_all"})
    with a.app.app_context():
        _v0 = (a.get_db().execute("SELECT value FROM app_settings WHERE key='review_unified'").fetchone() or [None])[0]
    S_.post("/admin/settings", data={"csrf_token": "tok", "action": "review_all", "review_all": "1"})
    with a.app.app_context():
        _v1 = (a.get_db().execute("SELECT value FROM app_settings WHERE key='review_unified'").fetchone() or [None])[0]
        a.get_db().execute("DELETE FROM app_settings WHERE key='review_unified'")
        a.get_db().commit()
    s.check("the admin's 'AI+ review for everyone' switch stores '0' off and '1' on", (_v0, _v1) == ("0", "1"), (_v0, _v1))

    # -------------------------------------------------------------------------
    s.section("a classic page goes to its AI+ replacement, when that is really there for them")
    with a.app.test_request_context("/"):
        db, eu = ctx_user(EMP["id"])
        keys = set(a._journey_chat_stage_keys(a.review_state(db, eu)))
    E = H.client_as(a, EMP["id"])
    r = E.get("/my-assessments")
    if "feedback" in keys:
        s.check("the 360 list -> the journey's 360 part", loc(r).endswith("/review/journey?stage=feedback"), loc(r))
    else:
        s.check("no 360 part for them -> the classic list is served", "/review/journey" not in loc(r), loc(r))
    r = E.get("/technical")
    s.check("the competency page -> the journey's competency part (or the page, with none)",
            loc(r).endswith("/review/journey?stage=competency") if "competency" in keys else "/review/journey" not in loc(r),
            (loc(r), sorted(keys)))
    # the Account menu's "Show me around" is gone (Chris, 2026-10-12), so its tour no longer keeps the classic page
    s.check("the old 'Show me around' tour link goes where the page does",
            ("/review/journey" in loc(E.get("/my-assessments?tour=home", headers={"Sec-Fetch-Mode": "navigate"})))
            == ("feedback" in keys))
    _base = H.source(a, "templates/base.html")
    s.check("...and the Account menu links no tour", "tour='home'" not in _base and "tour='rate'" not in _base
            and "tour='feedback'" not in _base and '>Show me around<' not in _base)
    s.check("a script's fetch is never redirected (only a page load)",
            "/review/journey" not in loc(E.get("/my-assessments", headers={"Sec-Fetch-Mode": "cors"})))
    s.check("...a page load is", ("/review/journey" in loc(E.get("/my-assessments", headers={"Sec-Fetch-Mode": "navigate"})))
            == ("feedback" in keys))
    _w = E.post("/technical/autosave", data={"csrf_token": "tok"})
    s.check("a write is never redirected by it", "/review/journey" not in loc(_w), _w.status_code)
    a.ai_draft.review_agent_available = lambda: False
    try:
        r = H.client_as(a, EMP["id"]).get("/my-assessments")
        s.check("with no model the classic page is the fallback, served as before", "/review/journey" not in loc(r), loc(r))
    finally:
        a.ai_draft.review_agent_available = lambda: True
    r = H.client_as(a, SU["id"]).get("/performance/team")
    s.check("an admin is never sent to the journey", "/review/journey" not in loc(r), loc(r))

    # a manager with a Team view (built here: the generated fixture has no KPI approvers) -> the AI+ team review
    with a.app.app_context():
        db = a.get_db()
        _M = db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                        "company, department, job_title, job_grade) VALUES ('zzca-mgr','ZZCA Manager','x','user',"
                        "'ZZCA-M',?,?,'Ops','Manager',18)", (EMP["business_group"], EMP["company"])).lastrowid
        # confirmed, so the report takes part in Performance: a leader's team is made of who does (2026-10-30)
        _R = db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                        "company, department, job_title, job_grade, manager_id, confirmation_date) VALUES "
                        "('zzca-rep','ZZCA Report','x','user','ZZCA-R',?,?,'Ops','Planner',14,?,'2020-01-01')",
                        (EMP["business_group"], EMP["company"], _M)).lastrowid
        _T = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                        "business_group, company, rate1, rate2, rate3, rate4, rate5) "
                        "VALUES (?,?,'ZZCA Output',100,'more','approved',?,?,1,2,3,4,5)",
                        (a.active_pm_period_id(db), _R, EMP["business_group"], EMP["company"])).lastrowid
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (_T, _M))
        db.commit()
    try:
        with a.app.test_request_context("/"):
            db, mu = ctx_user(_M)
            _team_on = a._review_manages_team(db, mu)
            _mkeys = {x["key"] for x in a._journey_team_live_stages(a.review_state(db, mu), "team")}
        s.check("the manager built here has a Team view with its PM review", _team_on and "pm_review" in _mkeys,
                (_team_on, sorted(_mkeys)))
        M = H.client_as(a, _M)
        s.check("their classic team PM page -> the AI+ team review",
                loc(M.get("/performance/team")).endswith("/review/journey?view=team&stage=pm_review"),
                loc(M.get("/performance/team")))
        s.check("...and one person's classic page -> that person in the AI+ team review",
                "view=team" in loc(M.get("/performance/team/%d" % _R)) and "report=%d" % _R in loc(M.get("/performance/team/%d" % _R)),
                loc(M.get("/performance/team/%d" % _R)))
    finally:
        with a.app.app_context():
            db = a.get_db()
            db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id=?", (_T,))
            db.execute("DELETE FROM pm_kpi_targets WHERE id=?", (_T,))
            db.execute("DELETE FROM users WHERE id IN (?,?)", (_R, _M))
            db.commit()

    # -------------------------------------------------------------------------
    s.section("a past half's scorecard opens the record panel on the dashboard")
    with a.app.app_context():
        db = a.get_db()
        PAST = db.execute("INSERT INTO cycles(code, name, is_active, year, half, ends_on) "
                          "VALUES ('ZZCA-2024-H2', 'ZZCA 2024 Year-End', 0, 2024, 2, '2024-12-31')").lastrowid
        _bg = EMP["business_group"]
        _had_cfg = db.execute("SELECT 1 FROM pm_bg_config WHERE business_group=?", (_bg,)).fetchone()
        if not _had_cfg:
            db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (_bg,))
        _tid = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                          "business_group, company, rate1, rate2, rate3, rate4, rate5) "
                          "VALUES (?,?,'ZZCA Sales',100,'more','approved',?,?,1,2,3,4,5)",
                          (PAST, EMP["id"], _bg, EMP["company"])).lastrowid
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft, admin_filled) "
                   "VALUES (?,4,?,0,1)", (_tid, EMP["id"]))
        db.commit()
    try:
        r = H.client_as(a, EMP["id"]).get("/performance?period=%d" % PAST)
        s.check("/performance?period=<a past half of theirs> -> /dashboard?record=<it>",
                loc(r).endswith("/dashboard?record=%d" % PAST), loc(r))
        _dj = open(os.path.join(H.REPO, "static", "dashboard.js"), encoding="utf-8").read()
        s.check("...where the page opens that cycle's panel", 'get("record")' in _dj and "open(want," in _dj)
        r = H.client_as(a, SU["id"]).get("/performance?period=%d" % PAST)
        s.check("...never for someone it isn't theirs (an admin here)", "/dashboard?record" not in loc(r))
    finally:
        with a.app.app_context():
            db = a.get_db()
            db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (_tid,))
            db.execute("DELETE FROM pm_kpi_targets WHERE id=?", (_tid,))
            db.execute("DELETE FROM cycles WHERE id=?", (PAST,))
            if not _had_cfg:
                db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (_bg,))
            db.commit()

    # -------------------------------------------------------------------------
    s.section("never redirected: what the journey still calls, and the pages with no AI+ version yet")
    _eps = {r.endpoint: r for r in a.app.url_map.iter_rules()}
    s.check("every archived page is a real GET route", all(e in _eps and "GET" in _eps[e].methods
                                                           for e in a._CLASSIC_PAGES),
            [e for e in a._CLASSIC_PAGES if e not in _eps])
    _journey_calls = {"performance_kpi_moderate_draft_autosave", "performance_team_member_remark_autosave",
                      "technical_review_autosave", "technical_review_approve", "idp_career_conversation",
                      "pm_calibration_hod_lock", "pm_calibration_buceo_lock", "calibration_hod_lock",
                      "calibration_company_lock", "talent_box_bgceo_move", "talent_box_bgceo_lock",
                      "performance_summary", "my_report_summary", "evidence_attachment_download"}
    s.check("the endpoints the journey still calls are never archived", not (_journey_calls & a._CLASSIC_PAGES),
            _journey_calls & a._CLASSIC_PAGES)
    _kept = {"performance_kpi_setting_review", "talent_box_group", "evidence_home",
             "my_report", "view_report", "my_profile", "review_setting", "review_history", "dashboard"}
    s.check("...nor the pages with no AI+ version yet (KPI approvals, a calibration group's Talent Box, the ledger, the "
            "reports; promotion and PIP were archived 2026-10-13; a BU CEO's Talent Box joined the archived pages "
            "2026-10-31, test_sec_classic)", not (_kept & a._CLASSIC_PAGES), _kept & a._CLASSIC_PAGES)
finally:
    a.ai_draft.review_agent_available = _real_avail
    with a.app.app_context():
        db = a.get_db()
        if _prev_mod is None:
            db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='review'", (CID,))
        else:
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key='review'", (_prev_mod[0], CID))
        for k, v in _prev_set.items():
            if v is None:
                db.execute("DELETE FROM app_settings WHERE key=?", (k,))
            else:
                db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (k, v))
        db.commit()

sys.exit(s.done())
