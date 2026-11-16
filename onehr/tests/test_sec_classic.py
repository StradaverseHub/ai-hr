"""Security stage 1 of the classic pages' removal (Chris, 2026-10-31: "go ahead and fix all now"; finding 1b-08).

A BU CEO's classic Talent Box counted the BG CEO's FINAL move before any release to leaders (its rows read every locked
tier above the unit). Stage 1:

  * a BU CEO's page navigation to /talent-box or /talent-box/company/<bg>/<company> goes to their AI+ BU calibration
    (Performance when live, else Potential); with no live BU view the page is still served (the fallback)
  * the box itself reads the bands as the BU calibration does (skip bgceo and group), so even the fallback page shows
    nothing above the BU tier before release; the BG CEO's, the Group Chief's boxes are unchanged
  * the six pages no screen links (/me, /performance/department, the two summary JSONs; /review/done and /review/brief
    stay, because review_home sends people there) go to the dashboard
  * a calibrator's group (tier 'bugrp') is no Talent Box scope on /talent-box (it built a broken URL)
  * the admin keeps the page; the move, tag and lock routes stay

Everything here is synthetic (ZZSC-*) and is removed at the end.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Security stage 1: a BU CEO's Talent Box goes to AI+, reads no tier above the unit; the orphan pages go to the dashboard")

BG, OTHER_BG, CO, CO2 = "ZZSC BG", "ZZSC OTHER BG", "ZZSC CO", "ZZSC CO TWO"
NAV = {"Sec-Fetch-Mode": "navigate"}
FETCH = {"Sec-Fetch-Mode": "cors"}


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZSC-%'")]
    for t in ("pm_calibration_sessions", "calibration_sessions"):
        db.execute("DELETE FROM %s WHERE business_group IN (?,?)" % t, (BG, OTHER_BG))
    db.execute("DELETE FROM pm_calibration_groups WHERE name LIKE 'ZZSC %'")
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM pm_calibration_group_members WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM buceo_seats WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    _prev = {
        "half": db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0],
        "review": db.execute("SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key='review'",
                             (CID,)).fetchone(),
        "calibration": db.execute("SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key='calibration'",
                                  (CID,)).fetchone(),
        "unified": (db.execute("SELECT value FROM app_settings WHERE key='review_unified'").fetchone() or [None])[0],
    }
    _cleanup(db)
    # the BU CEO's and BG CEO's tiers run at Year-End only
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    for k in ("review", "calibration"):
        db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, ?, 1) "
                   "ON CONFLICT(cycle_id, module_key) DO UPDATE SET active=1", (CID, k))
    db.execute("DELETE FROM app_settings WHERE key='review_unified'")
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(emp_id, name, **kw):
        v = dict(base, username=emp_id.lower(), employee_id=emp_id, full_name=name, email=None, hod_id=None,
                 manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO,
                 confirmation_date="2020-01-01", left_at=None, is_demo=0, role="user", job_grade=18)
        v.update(kw)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (emp_id,)).fetchone()[0]

    BGCEO = mk("ZZSC-BGCEO", "ZZ Sec BG CEO", bgceo_bg=BG, company="ZZSC BG HQ")
    BUCEO = mk("ZZSC-BUCEO", "ZZ Sec BU CEO", buceo_bg=BG, buceo_company=CO)
    BUCEO2 = mk("ZZSC-BUCEO2", "ZZ Sec BU CEO Other Unit", buceo_bg=BG, buceo_company=CO2, company=CO2)
    GC = mk("ZZSC-GC", "ZZ Sec Group Chief", company="ZZSC GC HQ")
    HOD = mk("ZZSC-HOD", "ZZ Sec HOD")
    LM = mk("ZZSC-LM", "ZZ Sec Line Manager", hod_id=HOD)
    E1 = mk("ZZSC-E1", "ZZ Sec Person One", hod_id=HOD, manager_id=LM)
    E2 = mk("ZZSC-E2", "ZZ Sec Person Two", hod_id=HOD, manager_id=LM)
    E3 = mk("ZZSC-E3", "ZZ Sec Person Three (group, moved)", hod_id=HOD, manager_id=LM)
    E4 = mk("ZZSC-E4", "ZZ Sec Person Four (group, not moved)", hod_id=HOD, manager_id=LM)
    PLAIN = mk("ZZSC-PLAIN", "ZZ Sec Plain Employee")
    SU = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                    "LIMIT 1").fetchone()[0]
    GRP = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZSC Group', ?)", (GC,)).lastrowid
    for e in (E3, E4):
        db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id) VALUES (?,?)", (GRP, e))
    # Performance targets for the people the Performance calibration reads (no targets = no Performance stage)
    PID = a.active_pm_period_id(db)
    for e in (E1, E2, E3, E4):
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                   "business_group, company, rate1, rate2, rate3, rate4, rate5) "
                   "VALUES (?,?,'ZZSC Output',100,'more','approved',?,?,1,2,3,4,5)", (PID, e, BG, CO))

    def sess(table, tier, key, moves, locked=True):
        db.execute("INSERT INTO %s(cycle_id, tier, scope_key, business_group, scope_label, locked_at) "
                   "VALUES (?,?,?,?,?,%s)" % (table, "datetime('now')" if locked else "NULL"),
                   (CID, tier, key, BG, "ZZSC"))
        sid = db.execute("SELECT id FROM %s WHERE cycle_id=? AND tier=? AND scope_key=?" % table,
                         (CID, tier, key)).fetchone()[0]
        adj = table.replace("sessions", "adjustments")
        for subj, (orig, band) in moves.items():
            db.execute("INSERT INTO %s(session_id, subject_id, original_band, adjusted_band, justification) "
                       "VALUES (?,?,?,?,'ZZSC reason')" % adj, (sid, subj, orig, band))
        return sid

    # the HOD sets the first two (AE / High and ME / Mid) and locks; the BU CEO has no move yet (the box shows what comes
    # up to the unit); the BG CEO moves everyone, locked, whatever the BU CEO has done; the Group Chief moves E3, locked
    sess("pm_calibration_sessions", "hod", str(HOD), {E1: ("", "AE"), E2: ("", "ME"), E3: ("", "ME"), E4: ("", "ME")})
    sess("calibration_sessions", "hod", str(HOD), {E1: ("", "High"), E2: ("", "Mid"), E3: ("", "Mid"), E4: ("", "Mid")})
    BG_PM = sess("pm_calibration_sessions", "bgceo", BG, {E1: ("AE", "OU"), E2: ("ME", "OU"), E4: ("ME", "OU")})
    BG_POT = sess("calibration_sessions", "bgceo", BG, {E1: ("High", "High"), E2: ("Mid", "High"), E4: ("Mid", "High")})
    sess("pm_calibration_sessions", "group", str(GRP), {E3: ("ME", "UA")})
    sess("calibration_sessions", "group", str(GRP), {E3: ("Mid", "Low")})
    db.commit()

_real_avail = a.ai_draft.review_agent_available
a.ai_draft.review_agent_available = lambda: True


def ctx(fn, uid=None):
    """fn(db) inside a request, signed in as uid when given."""
    with a.app.test_request_context("/"):
        if uid:
            from flask import session as _s
            _s["user_id"] = uid
        return fn(a.get_db())


def U(uid):
    return ctx(lambda d: d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def box_rows(tier, uid, **kw):
    """The box's rows for a scope, as that person sees them: {employee id: (perf band, pot band, perf source)}."""
    def go(d):
        c = a._talent_box_resolve(d, U(uid), tier, **kw)
        return {r["user"]["employee_id"]: (r["perf_band"], r["pot_band"], r["perf_source"]) for r in a.talent_box_rows(d, c)}
    return ctx(go, uid)


def box_counts(tier, uid, **kw):
    def go(d):
        c = a._talent_box_resolve(d, U(uid), tier, **kw)
        D = a._talent_box_data(d, U(uid), tier, c, kw)
        return (D["cat_counts"], D["col_counts"], D["row_counts"])
    return ctx(go, uid)


def set_bg_tier(pm_band, pot_band):
    """Change ONLY the BG CEO tier's bands for E1 (the 1b-08 differential)."""
    ctx(lambda d: (d.execute("UPDATE pm_calibration_adjustments SET adjusted_band=? WHERE session_id=? AND subject_id=?",
                             (pm_band, BG_PM, E1)),
                   d.execute("UPDATE calibration_adjustments SET adjusted_band=? WHERE session_id=? AND subject_id=?",
                             (pot_band, BG_POT, E1)), d.commit()))


def loc(r):
    return r.headers.get("Location", "") if r.status_code in (301, 302) else ""


BU_URL = "/talent-box/company/%s/%s" % (BG, CO)
try:
    # -------------------------------------------------------------------------
    s.section("fixture: the BU CEO's unit, a BG CEO, a Group Chief, and their locked calls")
    s.check("the BU CEO holds the unit and the BG CEO the group", ctx(lambda d: (
        [t for t, _k in a.calibration_tier_of(d, U(BUCEO))], [t for t, _k in a.calibration_tier_of(d, U(BGCEO))]))
        == (["buceo"], ["bgceo"]), ctx(lambda d: a.calibration_tier_of(d, U(BUCEO))))
    _r = box_rows("buceo", BUCEO, bg=BG, company=CO)
    s.check("the unit's box holds the four people (and the unit's other fixture logins)",
            {"ZZSC-E1", "ZZSC-E2", "ZZSC-E3", "ZZSC-E4"} <= set(_r), sorted(_r))

    # -------------------------------------------------------------------------
    s.section("1b-08: the BG CEO's tier no longer moves the BU CEO's box (a differential)")
    set_bg_tier("OU", "High")
    bu_a, bu_cnt_a = box_rows("buceo", BUCEO, bg=BG, company=CO), box_counts("buceo", BUCEO, bg=BG, company=CO)
    bg_a = box_rows("bgceo", BGCEO, bg=BG)
    set_bg_tier("UA", "Low")   # ONLY the BG CEO tier's bands for one person change
    bu_b, bu_cnt_b = box_rows("buceo", BUCEO, bg=BG, company=CO), box_counts("buceo", BUCEO, bg=BG, company=CO)
    bg_b = box_rows("bgceo", BGCEO, bg=BG)
    s.check("the BU CEO's rows are the same after the BG CEO's tier changes", bu_a == bu_b, (bu_a, bu_b))
    s.check("...and so are their cell, column and row counts", bu_cnt_a == bu_cnt_b, (bu_cnt_a, bu_cnt_b))
    s.check("the BU CEO's person sits where the HOD's call left them (AE / High), the HOD's source, not the BG CEO's",
            bu_a["ZZSC-E1"][:2] == ("AE", "High") and bu_a["ZZSC-E1"][2] == "hod", bu_a["ZZSC-E1"])
    s.check("...and the Group Chief's call on a person of the unit doesn't reach it either (E3: the HOD's ME / Mid)",
            bu_a["ZZSC-E3"][:2] == ("ME", "Mid") and bu_a["ZZSC-E3"][2] == "hod", bu_a["ZZSC-E3"])
    # falsify the guard: the same rows read the OLD way (no skip) do move with the BG CEO's tier, so the differential detects it
    def old_way(d):
        c = a._talent_box_resolve(d, U(BUCEO), "buceo", bg=BG, company=CO)
        c.pop("skip_tiers", None)
        return {r["user"]["employee_id"]: (r["perf_band"], r["pot_band"]) for r in a.talent_box_rows(d, c)}
    set_bg_tier("OU", "High")
    _old_a = ctx(old_way, BUCEO)
    set_bg_tier("UA", "Low")
    _old_b = ctx(old_way, BUCEO)
    s.check("falsified: without the skip the same two states give different rows (the old code's leak)",
            _old_a["ZZSC-E1"] != _old_b["ZZSC-E1"], (_old_a["ZZSC-E1"], _old_b["ZZSC-E1"]))
    s.check("the unit's ctx says what it skips, and only for the BU scope", ctx(lambda d: (
        a._talent_box_resolve(d, U(BUCEO), "buceo", bg=BG, company=CO).get("skip_tiers"),
        a._talent_box_resolve(d, U(BGCEO), "bgceo", bg=BG).get("skip_tiers"),
        a._talent_box_resolve(d, U(GC), "group", group_id=GRP).get("skip_tiers")), BUCEO) == (("bgceo", "group"), None, None))
    pg = H.client_as(a, BUCEO).get(BU_URL, headers=FETCH)
    s.check("the page itself (a script's fetch, as the redirect leaves it) is served for the unit's BU CEO",
            pg.status_code == 200, pg.status_code)

    # -------------------------------------------------------------------------
    s.section("controls: the BG CEO's and the Group Chief's boxes are unchanged")
    s.check("the BG CEO's box still moves with their own tier (E1 at OU, then UA)",
            bg_a["ZZSC-E1"][0] == "OU" and bg_b["ZZSC-E1"][0] == "UA", (bg_a["ZZSC-E1"], bg_b["ZZSC-E1"]))
    s.check("...and still takes the Group Chief's locked call above it (E3 at UA, from the group)",
            bg_a["ZZSC-E3"][0] == "UA" and bg_a["ZZSC-E3"][2] == "group", bg_a["ZZSC-E3"])
    set_bg_tier("OU", "High")
    gr_a = box_rows("group", GC, group_id=GRP)
    s.check("the Group Chief's box takes their own move (E3 at UA) and the BG CEO's locked call for who they didn't move "
            "(E4 at OU, from the BG CEO)",
            gr_a["ZZSC-E3"][0] == "UA" and gr_a["ZZSC-E4"][:1] == ("OU",) and gr_a["ZZSC-E4"][2] == "bgceo", gr_a)
    set_bg_tier("UA", "Low")
    s.check("...and the BG CEO's tier still moves a group's box where the group has no move of its own (E4 is the BG CEO's)",
            box_rows("group", GC, group_id=GRP)["ZZSC-E4"][0] == "OU", box_rows("group", GC, group_id=GRP)["ZZSC-E4"])

    # -------------------------------------------------------------------------
    s.section("a BU CEO's Talent Box goes to their BU calibration when it is live")
    B = H.client_as(a, BUCEO)
    with a.app.test_request_context("/"):
        from flask import session as _s
        _s["user_id"] = BUCEO
        d = a.get_db()
        _views = a._journey_leader_views(d, U(BUCEO))
        _live = [x["key"] for x in a._journey_team_live_stages(a.review_state(d, U(BUCEO)), "bu")]
    s.check("fixture: the BU view is live for them with both axes", "bu" in _views and _live == ["calibration", "calibration_pot"],
            (_views, _live))
    r = B.get(BU_URL, headers=NAV)
    s.check("/talent-box/company/<bg>/<company> -> the BU view's Performance calibration, on that unit",
            loc(r).startswith("/review/journey?") and "view=bu" in loc(r) and "stage=calibration&" in loc(r) + "&"
            and "bu_unit=" in loc(r), (r.status_code, loc(r)))
    r = B.get("/talent-box", headers=NAV)
    s.check("/talent-box -> the same, without a stop at the page",
            loc(r).endswith("/review/journey?view=bu&stage=calibration"), (r.status_code, loc(r)))
    s.check("a script's fetch of the page is never redirected", loc(B.get(BU_URL, headers=FETCH)) == "")
    # Performance not live (no KPI targets in the unit) -> Potential
    ctx(lambda d: (d.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (?,?,?,?)", (E1, E2, E3, E4)), d.commit()))
    r = B.get(BU_URL, headers=NAV)
    s.check("with no Performance calibration live the Potential one: stage=calibration_pot",
            "view=bu" in loc(r) and "stage=calibration_pot" in loc(r), (r.status_code, loc(r)))
    r = B.get("/talent-box", headers=NAV)
    s.check("...from /talent-box too", loc(r).endswith("/review/journey?view=bu&stage=calibration_pot"), loc(r))
    ctx(lambda d: (d.executemany(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, company, "
        "rate1, rate2, rate3, rate4, rate5) VALUES (?,?,'ZZSC Output',100,'more','approved',?,?,1,2,3,4,5)",
        [(PID, e, BG, CO) for e in (E1, E2, E3, E4)]), d.commit()))

    # -------------------------------------------------------------------------
    s.section("with no live BU view the page is served (the fallback), the classic way")
    fallbacks = []

    def served(label, setup, undo):
        setup()
        try:
            r1 = H.client_as(a, BUCEO).get(BU_URL, headers=NAV)
            r2 = H.client_as(a, BUCEO).get("/talent-box", headers=NAV)
            fallbacks.append((label, r1.status_code, loc(r1), r2.status_code, loc(r2)))
            s.check("%s -> the unit's Talent Box page is served, not redirected" % label,
                    r1.status_code == 200 and "/review/journey" not in loc(r1), (r1.status_code, loc(r1)))
            s.check("...and /talent-box goes on to it (its one-scope redirect), not to the journey",
                    r2.status_code == 302 and loc(r2).endswith(BU_URL.replace(" ", "%20"))
                    and "/review/journey" not in loc(r2),
                    (r2.status_code, loc(r2)))
        finally:
            undo()

    served("Mid-Year (no BU tier)", lambda: ctx(lambda d: (d.execute("UPDATE cycles SET half=1 WHERE id=?", (CID,)), d.commit())),
           lambda: ctx(lambda d: (d.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,)), d.commit())))
    served("the review module off", lambda: ctx(lambda d: (d.execute(
        "UPDATE cycle_modules SET active=0 WHERE cycle_id=? AND module_key='review'", (CID,)), d.commit())),
        lambda: ctx(lambda d: (d.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key='review'",
                                         (CID,)), d.commit())))
    # a ZZ + letter login is a demo account, which keeps the AI+ journey whatever the org switch says (_review_demo_user):
    # the switch is stood in for here
    _real_unified = a._review_unified_on

    def unified_off():
        a._review_unified_on = lambda u_: False

    def unified_back():
        a._review_unified_on = _real_unified
    served("the org's AI+ switch off", unified_off, unified_back)

    def no_model():
        a.ai_draft.review_agent_available = lambda: False

    def model_back():
        a.ai_draft.review_agent_available = lambda: True
    served("no model reachable", no_model, model_back)
    served("the potential and performance parts both gone (no calibration module, no targets)", lambda: ctx(lambda d: (
        d.execute("UPDATE cycle_modules SET active=0 WHERE cycle_id=? AND module_key='calibration'", (CID,)),
        d.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (?,?,?,?)", (E1, E2, E3, E4)), d.commit())),
        lambda: ctx(lambda d: (
            d.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key='calibration'", (CID,)),
            d.executemany(
                "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
                "company, rate1, rate2, rate3, rate4, rate5) VALUES (?,?,'ZZSC Output',100,'more','approved',?,?,1,2,3,4,5)",
                [(PID, e, BG, CO) for e in (E1, E2, E3, E4)]), d.commit())))

    # -------------------------------------------------------------------------
    s.section("who else: the admin keeps the page; another unit's BU CEO and a Group Chief are not sent to the journey")
    r = H.client_as(a, SU).get(BU_URL, headers=NAV)
    s.check("the super admin still gets the page", r.status_code == 200 and "/review/journey" not in loc(r), (r.status_code, loc(r)))
    r = H.client_as(a, BUCEO2).get(BU_URL, headers=NAV)
    s.check("a BU CEO of ANOTHER unit gets the page's own 403, never the journey", r.status_code == 403, (r.status_code, loc(r)))
    r = H.client_as(a, PLAIN).get(BU_URL, headers=NAV)
    s.check("someone with no seat gets the page's own 403", r.status_code == 403, (r.status_code, loc(r)))
    r = H.client_as(a, GC).get("/talent-box/group/%d" % GRP, headers=NAV)
    s.check("the Group Chief's own Talent Box page is untouched (no AI+ version of it is routed here)", r.status_code == 200,
            (r.status_code, loc(r)))
    r = H.client_as(a, GC).get("/talent-box", headers=NAV)
    s.check("...and /talent-box still takes a Group Chief to their group's box", r.status_code == 302 and loc(r).endswith(
        "/talent-box/group/%d" % GRP), (r.status_code, loc(r)))
    # a person who is both a BU CEO and a Group Chief: the page's chooser stays (it holds the group's box too)
    ctx(lambda d: (d.execute("UPDATE pm_calibration_groups SET calibrator_id=? WHERE id=?", (BUCEO, GRP)), d.commit()))
    try:
        r = B.get("/talent-box", headers=NAV)
        s.check("a BU CEO who is also a Group Chief keeps the chooser page (the group's box is not hidden behind the unit)",
                r.status_code == 200 and "/review/journey" not in loc(r), (r.status_code, loc(r)))
        s.check("...whose unit door still reaches the BU calibration", loc(B.get(BU_URL, headers=NAV)).startswith(
            "/review/journey?view=bu"))
    finally:
        ctx(lambda d: (d.execute("UPDATE pm_calibration_groups SET calibrator_id=? WHERE id=?", (GC, GRP)), d.commit()))

    # -------------------------------------------------------------------------
    s.section("what the journey posts to stays: the BU box's move, tag and lock routes are not archived")
    eps = {r.endpoint for r in a.app.url_map.iter_rules()}
    keep = {"talent_box_buceo_move", "talent_box_buceo_tag", "talent_box_buceo_lock", "pm_calibration_buceo_lock",
            "calibration_company_lock", "talent_box_bgceo_move", "talent_box_bgceo_lock", "talent_box_group_move",
            "talent_box_group_lock"}
    s.check("the routes exist and none is in the archived set", keep <= eps and not (keep & a._CLASSIC_PAGES),
            (keep - eps, keep & a._CLASSIC_PAGES))
    s.check("only the pages (GET) of the unit's box and its entry joined the archived set",
            {"talent_box_buceo", "talent_box_home"} <= a._CLASSIC_PAGES and "talent_box_group" not in a._CLASSIC_PAGES)
    r = B.post(BU_URL + "/lock", data={"csrf_token": "tok"})
    s.check("a write is never redirected by the gate (the lock answers for itself)", "/review/journey" not in loc(r), (r.status_code, loc(r)))

    # -------------------------------------------------------------------------
    s.section("a calibrator's group is no Talent Box scope on /talent-box (it built a broken URL)")
    CG = ctx(lambda d: d.execute("SELECT id FROM users WHERE employee_id='ZZSC-PLAIN'").fetchone()[0])
    _real_tiers = a.calibration_tier_of
    a.calibration_tier_of = lambda d, u: [("bugrp", (BG, CO, 77))] if u and u["id"] == CG else _real_tiers(d, u)
    try:
        r = H.client_as(a, CG).get("/talent-box", headers=FETCH)
        s.check("a 'bugrp' tier alone: no scope, the page's own 403 (not a 500 from a tuple in a URL)", r.status_code == 403,
                r.status_code)
    finally:
        a.calibration_tier_of = _real_tiers

    # -------------------------------------------------------------------------
    s.section("the orphan pages go to the dashboard")
    E = H.client_as(a, PLAIN)
    for url in ("/me", "/performance/summary?period=%d" % PID, "/my-report/summary?cycle=%d" % CID):
        r = E.get(url, headers=NAV)
        s.check("%s -> /dashboard" % url.split("?")[0], r.status_code == 302 and loc(r).endswith("/dashboard"),
                (r.status_code, loc(r)))
    r = H.client_as(a, HOD).get("/performance/department", headers=NAV)
    s.check("/performance/department (an HOD) -> /dashboard", r.status_code == 302 and loc(r).endswith("/dashboard"),
            (r.status_code, loc(r)))
    r = H.client_as(a, SU).get("/me", headers=NAV)
    s.check("an admin's /me still goes to their Home", r.status_code == 302 and loc(r).rstrip("/").endswith("/admin"),
            (r.status_code, loc(r)))
    with a.app.test_request_context("/"):
        from flask import url_for as _uf
        _built = [_uf(ep) for ep in ("my_profile", "performance_summary", "my_report_summary", "performance_department_view")]
    s.check("the route names still build their URLs", _built == ["/me", "/performance/summary", "/my-report/summary",
                                                                "/performance/department"], _built)
    # no screen links or fetches them: only these four names, nowhere in a template or script
    import re
    _hits = []
    for root in ("templates", "static"):
        for dp, _dn, fn in os.walk(os.path.join(H.REPO, root)):
            for f in fn:
                if not f.endswith((".html", ".js")):
                    continue
                txt = open(os.path.join(dp, f), encoding="utf-8", errors="ignore").read()
                for pat in (r"url_for\(['\"](my_profile|performance_summary|my_report_summary|performance_department_view)['\"]",
                            r"['\"]/(performance/summary|my-report/summary|performance/department)\b"):
                    for m in re.finditer(pat, txt):
                        _hits.append((f, m.group(0)))
    s.check("no template or script links or fetches them, bar the retired page's own template (my_profile.html)",
            all(f == "my_profile.html" for f, _m in _hits), _hits)

    # /review/done and /review/brief stay: review_home sends people with nothing live there (the unified path too)
    _src = H.source(a)
    s.check("/review/done is still where /review sends someone with no live part, the unified journey included",
            _src.count('url_for("review_done")') >= 3, _src.count('url_for("review_done")'))
    s.check("...and the done page is where the brief is fetched, so neither is an orphan",
            "url_for('review_brief')" in H.source(a, "templates/review_done.html"))
    _rd = H.client_as(a, PLAIN).get("/review/done", headers=NAV)
    s.check("/review/done answers as before (the page, not a redirect)", _rd.status_code == 200
            and "Nothing waiting on you" in _rd.get_data(as_text=True), (_rd.status_code, loc(_rd)))
finally:
    a.ai_draft.review_agent_available = _real_avail
    with a.app.app_context():
        db = a.get_db()
        _cleanup(db)
        db.execute("UPDATE cycles SET half=? WHERE id=?", (_prev["half"], CID))
        for k in ("review", "calibration"):
            if _prev[k] is None:
                db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k))
            else:
                db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (_prev[k][0], CID, k))
        if _prev["unified"] is None:
            db.execute("DELETE FROM app_settings WHERE key='review_unified'")
        else:
            db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', ?)", (_prev["unified"],))
        db.commit()

sys.exit(s.done())
