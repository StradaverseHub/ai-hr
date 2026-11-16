"""Leader views in the review journey -- Mine | Team | Dept | BU | BG (Chris, 2026-09-30).

  "For HOD account, add Dept next to Team, move the calibration in and remove from Team. Similarly, add BU for BUCEO
   access, and add BG for BGCEO access, move calibration to this new toggle view."

Each leader view is ONE calibration tier of the login's own, re-validated on every request (a crafted ?view= is the
Mine view). The calibration routes resolve the scope from the view the request came from, so someone who is both an
HOD and a BU CEO calibrates each scope in its own tab, with its own thread and its own demo Reset. Team keeps the
direct-report reviews only.

Its own synthetic unit: an HOD (who is also made the BU CEO of that unit) over a handful of people, so nothing
depends on the suite database's roster. It runs on the SHARED suite database WITHOUT a fresh copy and puts back
everything it changed at the end: the suites after it (test_manager_agent / test_manager_journey) lean on state the
earlier suites leave behind, and a fresh copy here wiped it (found on a clean-archive run).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Leader views -- Dept / BU / BG hold calibration; Team the direct-report reviews")
_real_avail = a.ai_draft.review_agent_available
a.ai_draft.review_agent_available = lambda: True      # _calib_assist_on needs a model reachable
# This fixture makes the BU CEO the HOD of people inside their own unit. Since 2026-10-30 a calibrator holds no HOD role at
# all (_hod_review_holders; tests/test_ceo_hod.py holds that rule), so this suite switches the rule off (nobody is a
# calibrator for it) to keep exercising the Department Review itself.
a._hod_review_holders = lambda db: set()

with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    # what this suite changes, so it can put it all back (see the docstring)
    _ORIG = {"half": db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0],
             "settings": {k: (r[0] if r else None) for k in ("ai_calib", "review_unified")
                          for r in [db.execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone()]},
             "modules": {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=? AND "
                                                         "module_key IN ('review','calibration','pm','tm')", (CID,))},
             "max": {tb: db.execute("SELECT COALESCE(MAX(id),0) FROM %s" % tb).fetchone()[0]
                     for tb in ("calibration_sessions", "pm_calibration_sessions", "pm_manager_chat",
                                "calibration_adjustments")}}
    # a run that died half-way leaves its unit behind; clear it first so the next run starts clean
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZLV-%' OR employee_id='LV-REAL'")
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))   # calibration is Year-End only
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','calibration','pm','tm')")
    for k in ("ai_calib", "review_unified"):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND business_group!='' "
                           "AND company!='' LIMIT 1").fetchone())
    BG, CO = base["business_group"], base["company"]
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
    LEAD = person("ZZLV-LEAD", "ZZ LV Lead")                  # the HOD, made the BU CEO of the same unit below
    ONLYHOD = person("ZZLV-HOD2", "ZZ LV Hod Only")           # an HOD with no direct reports and no BU
    PEOPLE = [person("ZZLV-P%d" % i, "ZZ LV Person %d" % i, hod_id=LEAD) for i in range(4)]
    OTHER = person("ZZLV-O1", "ZZ LV Other", hod_id=ONLYHOD)
    db.execute("UPDATE users SET buceo_bg=?, buceo_company=? WHERE id=?", (BG, CO, LEAD))
    db.commit()


def user(uid):
    with a.app.test_request_context("/"):
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def views_of(uid, qs=""):
    with a.app.test_request_context("/review/journey" + qs):
        from flask import session as _s
        _s["user_id"] = uid
        db = a.get_db()
        u = user(uid)
        return a._journey_views(db, u), a._journey_req_view(db, u)


# ---------------------------------------------------------------------------
s.section("who sees which tab")
v_lead, _ = views_of(LEAD)
s.check("an HOD who is also a BU CEO sees BOTH leader views (the chat used to reach only their first scope)",
        "dept" in v_lead and "bu" in v_lead and v_lead[0] == "mine", v_lead)
v_hod, _ = views_of(ONLYHOD)
s.check("an HOD with no direct reports gets Mine | Dept -- no Team (calibration left Team)", v_hod == ["mine", "dept"],
        v_hod)
v_emp, _ = views_of(PEOPLE[0])
s.check("an employee gets Mine only", v_emp == ["mine"], v_emp)
_, rv = views_of(ONLYHOD, "?view=bu")
s.check("a crafted ?view=bu from someone who is not a BU CEO is the Mine view", rv == "mine", rv)
_, rv = views_of(LEAD, "?view=bu")
s.check("...and ?view=bu from the BU CEO is the BU view", rv == "bu", rv)
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("UPDATE cycles SET half=1 WHERE id=?", (CID,)); db.commit()
v_mid, _ = views_of(LEAD)
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,)); db.commit()
# Mid-Year is Self, LM and HOD (Chris, 2026-10-12: "HOD dept review is not a calibration per se"): the HOD's Department
# Review opens at Mid-Year too; the BU / BG / Group seats stay Year-End only
s.check("Mid-Year: the HOD's Department Review only, no BU / BG view", "dept" in v_mid and "bu" not in v_mid
        and "bg" not in v_mid, v_mid)

s.section("the page: the toggle, the view, the parts")
c = H.client_as(a, LEAD)
html = c.get("/review/journey?view=dept").get_data(as_text=True)
s.check("the toggle carries Dept and BU with their full names, Dept active",
        ">Dept<" in html and ">BU<" in html and 'title="Department Review"' in html
        and 'title="Business unit calibration"' in html and 'data-view="dept"' in html, html.count("rv-viewtabs"))
s.check("...and the Dept view's parts are calibration only (no PM / TM / IDP review)",
        'data-active-stage="calibration' in html and 'data-active-stage="pm_review"' not in html)
html_b = c.get("/review/journey?view=bu").get_data(as_text=True)
s.check("the BU view is its own page", 'data-view="bu"' in html_b)
html_x = H.client_as(a, ONLYHOD).get("/review/journey?view=bu").get_data(as_text=True)
s.check("...someone without it lands on Mine", 'data-view="mine"' in html_x and ">BU<" not in html_x)
with a.app.test_request_context("/review/journey?view=team"):
    from flask import session as _s
    _s["user_id"] = LEAD
    db = a.get_db()
    st = a.review_state(db, user(LEAD))
    team = [x["key"] for x in a._journey_team_live_stages(st, "team")]
    dept = [x["key"] for x in a._journey_team_live_stages(st, "dept")]
s.check("Team carries no calibration part", not any(k.startswith("calibration") or k == "talent_box" for k in team),
        team)
s.check("...Dept carries the HOD's calibration", dept and all(k.startswith("calibration") for k in dept), dept)
rd = c.get("/review/journey?view=team&stage=calibration_pot")
s.check("an old ?view=team&stage=calibration link goes to the leader view that has it",
        rd.status_code in (301, 302) and "view=dept" in rd.headers.get("Location", ""), rd.headers.get("Location"))

# ---------------------------------------------------------------------------
s.section("per-view scope: the same move from Dept writes the HOD session, from BU the BU session")


def sess_rows(tier, subject):
    return H.one(a, "SELECT COUNT(*) FROM calibration_adjustments ca JOIN calibration_sessions cs ON cs.id=ca.session_id "
                    "WHERE cs.cycle_id=? AND cs.tier=? AND ca.subject_id=?", (CID, tier, subject))


X = PEOPLE[1]
r1 = c.post("/review/team/calib-move", data={"csrf_token": "tok", "stage": "calibration_pot", "subject": str(X),
                                             "band": "High", "view": "dept",
                                             # a department review's band change carries the HOD's remark (2026-09-30)
                                             "justification": "Moved in the department review"}).get_json() or {}
s.check("a potential move from Dept lands in the HOD's session", r1.get("ok") and sess_rows("hod", X) == 1
        and sess_rows("buceo", X) == 0, (r1.get("error"), sess_rows("hod", X), sess_rows("buceo", X)))
r2 = c.post("/review/team/calib-move", data={"csrf_token": "tok", "stage": "calibration_pot", "subject": str(X),
                                             "band": "Low", "view": "bu"}).get_json() or {}
s.check("...and the same move from BU lands in the BU CEO's session, the HOD's untouched",
        r2.get("ok") and sess_rows("buceo", X) == 1 and sess_rows("hod", X) == 1, (r2.get("error"),))
r3 = H.client_as(a, ONLYHOD).post("/review/team/calib-move", data={"csrf_token": "tok", "stage": "calibration_pot",
                                                                    "subject": str(X), "band": "Low",
                                                                    "view": "bu"}).get_json() or {}
s.check("a crafted view=bu from someone who isn't that BU CEO reaches nothing of theirs",
        not r3.get("ok") and sess_rows("buceo", X) == 1, r3)
with a.app.test_request_context("/review/journey?view=bu"):
    from flask import session as _s
    _s["user_id"] = LEAD
    db = a.get_db()
    psc = a._pot_calib_scope(db, user(LEAD), fresh=True)
s.check("the scope resolver reads the request's view (BU -> the buceo scope)", psc and psc[0] == "buceo",
        psc and psc[0])

s.section("one thread per leader view")
o1 = c.post("/review/chat", data={"csrf_token": "tok", "message": "", "journey": "1", "view": "dept",
                                  "stage": "calibration_pot", "mode": "summary"}).get_json() or {}
o2 = c.post("/review/chat", data={"csrf_token": "tok", "message": "", "journey": "1", "view": "bu",
                                  "stage": "calibration_pot", "mode": "summary"}).get_json() or {}
# Dept is an HOD's DEPARTMENT REVIEW (2026-09-30): its own fixed opener, no curve; BU stays curve-first
s.check("the opener: Dept is the department review's fixed line (no curve), BU the curve-first one",
        "Department Review" in (o1.get("say") or "") and "curve" not in (o1.get("say") or "")
        and "on the curve" in (o2.get("say") or "") and "Open a name on the roster" in (o2.get("say") or ""),
        (o1.get("say"), o2.get("say")))
scopes = [r[0] for r in H.rows(a, "SELECT scope FROM pm_manager_chat WHERE reviewer_id=? AND stage='calibration_pot' "
                                  "ORDER BY id", (LEAD,))]
s.check("...each row tagged with its view's tier", scopes == ["hod", "buceo"], scopes)
h1 = c.get("/review/chat/history?journey=1&view=dept&stage=calibration_pot").get_json() or {}
h2 = c.get("/review/chat/history?journey=1&view=bu&stage=calibration_pot").get_json() or {}
s.check("...and each view replays only its own thread",
        len(h1.get("messages") or []) == 1 and len(h2.get("messages") or []) == 1
        and h1.get("view") == "dept" and h2.get("view") == "bu", (len(h1.get("messages") or []),
                                                                  len(h2.get("messages") or [])))

# ---------------------------------------------------------------------------
s.section("the demo Reset follows the view")
page_bu = c.get("/review/journey?view=bu").get_data(as_text=True)
s.check("in a leader view the button reads 'Reset calibration' and posts that view",
        "Reset calibration" in page_bu and "/review/demo/reset-calibration" in page_bu
        and 'name="view" value="bu"' in page_bu)
with a.app.test_request_context("/"):
    db = a.get_db()
    a._demo_reset_team(db, user(LEAD), CID)
    db.commit()
s.check("the TEAM reset leaves calibration alone (moves and threads)",
        sess_rows("hod", X) == 1 and sess_rows("buceo", X) == 1
        and H.one(a, "SELECT COUNT(*) FROM pm_manager_chat WHERE reviewer_id=? AND stage='calibration_pot'", (LEAD,)) == 2)
rr = c.post("/review/demo/reset-calibration", data={"csrf_token": "tok", "view": "bu"})
s.check("the BU view's reset clears the BU CEO's moves and BU thread only",
        rr.status_code in (301, 302) and "view=bu" in rr.headers.get("Location", "")
        and sess_rows("buceo", X) == 0 and sess_rows("hod", X) == 1
        and [r[0] for r in H.rows(a, "SELECT scope FROM pm_manager_chat WHERE reviewer_id=? AND stage='calibration_pot'",
                                  (LEAD,))] == ["hod"], (rr.status_code, sess_rows("buceo", X), sess_rows("hod", X)))
rx = H.client_as(a, ONLYHOD).post("/review/demo/reset-calibration", data={"csrf_token": "tok", "view": "bu"})
s.check("...a view the login doesn't hold is a 404 (never a reset of someone else's tier)", rx.status_code == 404,
        rx.status_code)
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("UPDATE users SET employee_id='LV-REAL' WHERE id=?", (LEAD,)); db.commit()
rz = c.post("/review/demo/reset-calibration", data={"csrf_token": "tok", "view": "dept"})
s.check("...and a real (non-ZZ) login gets a 404", rz.status_code == 404 and sess_rows("hod", X) == 1, rz.status_code)
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("UPDATE users SET employee_id='ZZLV-LEAD' WHERE id=?", (LEAD,)); db.commit()

# ---------------------------------------------------------------------------
s.section("the dashboard and the Mine-side hand-offs point at the leader view")
with a.app.test_request_context("/dashboard"):
    from flask import session as _s
    _s["user_id"] = ONLYHOD
    db = a.get_db()
    urls = a.dash_calib_chat_urls(db, user(ONLYHOD))
    dcard = a.dash_dept_review(db, user(ONLYHOD))
    st = a.review_state(db, user(ONLYHOD))
    turl = a._journey_team_url(st)
# an HOD's is the AI+ Dept Review card now (2026-09-30), not a Calibration door
s.check("an HOD-only login: no Calibration chat door, and the AI+ Dept Review card opens the Dept view",
        not urls and dcard and "view=dept" in dcard["url"]
        and all("view=dept" in p["url"] for p in dcard["pending"]), (urls, dcard))
s.check("'take me to my team review' for an HOD with no team goes to Dept", "view=dept" in turl, turl)
with a.app.test_request_context("/dashboard"):
    from flask import session as _s
    _s["user_id"] = LEAD
    db = a.get_db()
    import urllib.parse as _up
    urls_l = a.dash_calib_chat_urls(db, user(LEAD))
    st_l = a.review_state(db, user(LEAD))
    _first = a._journey_leader_views(db, user(LEAD))
    _parts = {w: [x["key"] for x in a._journey_team_live_stages(st_l, w)] for w in _first}
    _ok = []
    for _url in urls_l.values():
        _q = dict(_up.parse_qsl(_up.urlparse(_url).query))
        # the first NON-Dept view holding it: Dept is the AI+ Dept Review card's (2026-09-30)
        _want = next((w for w in _first if w != "dept" and _q.get("stage") in _parts[w]), None)
        _ok.append(_q.get("view") == _want and _want is not None)
s.check("...an HOD who is also a BU CEO: each Calibration door opens the first leader view holding it, never Dept",
        urls_l and all(_ok), (urls_l, _parts))

s.section("a BG CEO: Team and BG, no Mine (Chris, 2026-10-05)")
with a.app.test_request_context("/"):
    db = a.get_db()
    BGC = person("ZZLV-BGC", "ZZ LV BG CEO", bgceo_bg=BG)
    db.commit()
v_bgc, rv_bgc = views_of(BGC)
_, rv_mine = views_of(BGC, "?view=mine")
s.check("a BG CEO with no team and nothing owed sees BG only, and lands on it (a crafted ?view=mine too)",
        v_bgc == ["bg"] and rv_bgc == "bg" and rv_mine == "bg", (v_bgc, rv_bgc, rv_mine))
with a.app.test_request_context("/"):
    db = a.get_db()
    _stb = a.review_state(db, user(BGC))
s.check("...their own KPI, competency and plan aren't asked of them (not a participant in their own review)",
        _stb.get("participant") is False, _stb.get("participant"))
html_g = H.client_as(a, BGC).get("/review/journey").get_data(as_text=True)
s.check("...the page opens on the BG view with no Mine tab", 'data-view="bg"' in html_g and ">Mine<" not in html_g
        and ">BG<" in html_g, html_g.count("rv-viewtabs"))
with a.app.test_request_context("/"):   # a colleague's 360 still waits on them: Mine is where it's given
    db = a.get_db()
    db.execute("INSERT INTO assignments(subject_id, assessor_id, cycle_id, relationship, status) "
               "VALUES (?, ?, ?, 'peer', 'pending')", (PEOPLE[2], BGC, CID))
    db.commit()
v_owe, rv_owe = views_of(BGC)
with a.app.test_request_context("/"):   # ...given: Mine stays, for their 360 (Chris, 2026-10-12)
    db = a.get_db()
    db.execute("UPDATE assignments SET status='submitted' WHERE assessor_id=? AND cycle_id=?", (BGC, CID))
    db.commit()
v_given, rv_given = views_of(BGC)
_, rv_given_tab = views_of(BGC, "?view=mine")
html_given = H.client_as(a, BGC).get("/review/journey").get_data(as_text=True)
with a.app.test_request_context("/review/chat/history?journey=1&stage=feedback"):   # the Mine page's own request
    from flask import session as _s2
    _s2["user_id"] = BGC
    rv_hist = a._journey_req_view(a.get_db(), user(BGC))
with a.app.test_request_context("/"):   # ...then a direct report with competencies: Team
    db = a.get_db()
    _sk = db.execute("SELECT id FROM tc_skills LIMIT 1").fetchone()
    db.execute("UPDATE users SET manager_id=? WHERE id=?", (BGC, PEOPLE[3]))
    if _sk:
        db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future) VALUES (?,?,?,0)",
                   (CID, PEOPLE[3], _sk["id"]))
    db.commit()
v_team, rv_team = views_of(BGC)
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("DELETE FROM assignments WHERE assessor_id=? AND cycle_id=?", (BGC, CID))
    db.execute("DELETE FROM tc_assignments WHERE cycle_id=? AND subject_id=?", (CID, PEOPLE[3]))
    db.execute("UPDATE users SET manager_id=NULL WHERE id=?", (PEOPLE[3],))
    db.execute("DELETE FROM users WHERE id=?", (BGC,))
    db.commit()
s.check("...a 360 still waiting on them: Mine (their 360 only) and BG, opening on Mine",
        v_owe == ["mine", "bg"] and rv_owe == "mine", (v_owe, rv_owe))
s.check("...their 360 given: Mine stays for it (Chris, 2026-10-12), and they open on BG",
        v_given == ["mine", "bg"] and rv_given == "bg", (v_given, rv_given))
s.check("...but the Mine page's own requests (no view) stay on Mine, never the BG box", rv_hist == "mine", rv_hist)
s.check("...and their Mine tab opens Mine: it carries ?view=mine, since the bare page lands them on BG (Chris, 2026-10-13: "
        "\"the demo BGCEO Mine tab cannot be opened\")", rv_given_tab == "mine"
        and 'href="/review/journey?view=mine"' in html_given and 'title="My Review">Mine</a>' in html_given,
        (rv_given_tab, html_given.count("view=mine")))
s.check("...and with direct reports to review it's Mine, Team and BG, opening on Team",
        v_team == ["mine", "team", "bg"] and rv_team == "team", (v_team, rv_team))
s.check("an HOD and a BU CEO keep their Mine", v_lead[0] == "mine" and v_hod[0] == "mine", (v_lead, v_hod))
_h_own = a.dash_here({"complete": True, "own": True, "button": "See your AI check-in summary", "url": "/x"}, None, [])
_h_360 = a.dash_here({"complete": True, "own": False, "button": "See your 360 feedback", "url": "/x"}, None, [])
s.check("the dashboard: someone whose only part is their 360 (a BG CEO) reads 'Your 360 feedback is done', never "
        "'Your own check-in is done' (Chris, 2026-10-12)",
        _h_own["done"] == "Your own check-in is done" and _h_360["done"] == "Your 360 feedback is done"
        and _h_360["summary"]["button"] == "See your 360 feedback", (_h_own["done"], _h_360["done"]))
_src_d = H.source(a)
s.check("...the panel decides it from review_state's participant",
        'own = bool(st.get("participant", True))' in _src_d and '"See your 360 feedback")' in _src_d)

s.section("source guards")
_src = H.source(a)
s.check("the view is validated against the login's own views before anything reads it",
        "v = want if (want in _VIEW_SHORT and want in views) else (" in _src
        and "views = _journey_views(db, u) if u else [\"mine\"]" in _src)
s.check("the view is cached on the REQUEST, never flask.g (a request inside an app context shares its g)",
        "request._get_current_object()" in _src and "_onehr_cache" in _src and 'g._jview' not in _src)

a.ai_draft.review_agent_available = _real_avail
with a.app.test_request_context("/"):   # put the shared suite database back as this suite found it
    db = a.get_db()
    for tb, mx in _ORIG["max"].items():
        db.execute("DELETE FROM %s WHERE id>?" % tb, (mx,))
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZLV-%' OR employee_id='LV-REAL'")
    db.execute("UPDATE cycles SET half=? WHERE id=?", (_ORIG["half"], CID))
    for k, v in _ORIG["settings"].items():
        if v is None:
            db.execute("DELETE FROM app_settings WHERE key=?", (k,))
        else:
            db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)", (k, v))
    for k, v in _ORIG["modules"].items():
        db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, CID, k))
    db.commit()
sys.exit(s.done())
