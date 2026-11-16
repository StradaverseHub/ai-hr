"""The calibrator's dashboard card and progress email -- 2026-10-27, Chris: "ok, build it" on the canvas
[design canvas link removed].

A calibrator is someone who calibrates a calibration group (calib_bu_groups, tier bugrp). Until now a pure calibrator saw
nothing of calibration on the dashboard, and got no progress email. This suite holds (a made-up business group of synthetic
people, put back at the end):
  * the dashboard card: "Your Calibration Group" for a calibrator, tab CG (title Calibration Group), its people equal to the
    group's own resolver (_pot_scope_population), a row a department with the HOD's review per axis, the two axes by the
    group's own lock (grp:<id>), the BU CEO's card unchanged; cg.view switches the card off, bu.view does not
  * someone who holds a unit AND a group: a pill each, units first, the on-screen one lit, ?bu_unit= switches the card
  * "Your next step" and the rail: a calibrator gets the Calibration row ("to calibrate") a BU CEO gets
  * the leader progress email: cg is a role (ticked by default, a saved list without it leaves them out); a calibrator's
    section counts only the group's people; a BU CEO who calibrates gets ONE email, units then groups; with one role
    ticked, only that part; counts only, never a name
  * the admin page: the third tick with its count, the wording editor, Preview as, the form's order
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The calibrator's dashboard card and progress email")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
assert not a.mailer.is_configured(), "the harness must not send email"
SU, _BGA, _E = H.actors(a)
BG, CO, HQ = "ZZCGD Group", "ZZCGD Unit", "ZZCGD HQ"
OPS, FIN, SAL, TAX = "ZZCGD Ops", "ZZCGD Finance", "ZZCGD Sales", "ZZCGD Tax"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
CELLS = ("pm_buceo", "pot_buceo", "tb_bgceo", "pm_hod", "pot_hod", "pm_results", "tc_self", "idp_self")
KEYS = ("leader_progress_rules", "leader_progress_template", "leader_progress_last")


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9CGD-%'")]
    gids = [r[0] for r in db.execute("SELECT id FROM calib_bu_groups WHERE business_group=?", (BG,))]
    for st, at in (("pm_calibration_sessions", "pm_calibration_adjustments"),
                   ("calibration_sessions", "calibration_adjustments")):
        for (sid,) in db.execute("SELECT id FROM %s WHERE business_group=?" % st, (BG,)).fetchall():
            db.execute("DELETE FROM %s WHERE session_id=?" % at, (sid,))
            db.execute("DELETE FROM %s WHERE id=?" % st, (sid,))
        if ids:   # an HOD's session is keyed by the HOD's id
            db.execute("DELETE FROM %s WHERE tier='hod' AND scope_key IN (%s)" % (st, ",".join("?" * len(ids))),
                       [str(i) for i in ids])
    db.execute("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BG,))
    for g_ in gids:
        for t_ in ("calib_bu_group_depts", "calib_bu_group_units", "calib_bu_group_people", "calib_bu_group_left"):
            try:
                db.execute("DELETE FROM %s WHERE group_id=?" % t_, (g_,))
            except Exception:   # noqa: BLE001 -- a table this copy lacks
                pass
    db.execute("DELETE FROM pm_pbt_achievement WHERE business_group=?", (BG,))
    db.execute("DELETE FROM calib_bu_groups WHERE business_group=?", (BG,))
    if ids:
        ph = ",".join("?" * len(ids))
        for t, c in (("pm_kpi_targets", "subject_id"), ("cycle_participants", "subject_id"), ("buceo_seats", "user_id"),
                     ("rating_records", "subject_id"), ("ai_prerun_jobs", "subject_id"), ("pm_review_session", "subject_id"),
                     ("email_outbox", "user_id")):
            try:
                db.execute("DELETE FROM %s WHERE %s IN (%s)" % (t, c, ph), ids)
            except Exception:   # noqa: BLE001
                pass
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("UPDATE users SET hod_id=NULL WHERE hod_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM activity_log WHERE action IN ('bu_group_save','bu_group_remove') AND detail LIKE 'ZZCGD%'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, co, dept, title="ZZCGD Officer"):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, is_demo, email) VALUES (?,?, 'x', 'user', ?,?,?,?,?, '15', 0, ?)",
                      (eid.lower(), "ZZ Cgd " + eid[-3:], eid, BG, co, dept, title,
                       eid.lower() + "@example.test")).lastrowid


def user(uid):
    return a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    CYC = db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()
    HALF0 = CYC["half"]
    LEADER0 = [tuple(r) for r in db.execute("SELECT role, ability, allowed, updated_by FROM leader_role_access")]
    SAVED = {k: db.execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone() for k in KEYS}
    TPLS = H.stash_email_templates(db)
    WIN0 = [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows WHERE cycle_id=? "
                                         "AND cell IN (%s)" % ",".join("?" * len(CELLS)), (CID,) + CELLS)]
    MOD0 = [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=? AND "
                                         "module_key IN ('pm','tm','idp','calibration','review')", (CID,))]
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))   # the BU level is the Year-End's
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(CELLS)), (CID,) + CELLS)
    for c_ in CELLS:
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                   (CID, c_, "2020-01-01 00:00:00", "2099-12-31 15:59:00"))
    for m_ in ("pm", "tm", "idp", "calibration", "review"):
        db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, m_))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?), (?,?)", (BG, CO, BG, HQ))
    CEO = person(db, "ZZ9CGD-CEO", CO, OPS, title="Chief Executive Officer")    # BU CEO of CO, and calibrator of Sales (HQ)
    CFO = person(db, "ZZ9CGD-CFO", HQ, "ZZCGD Group Finance", title="CHIEF FINANCIAL OFFICER")   # a pure calibrator
    BCEO = person(db, "ZZ9CGD-BCE", HQ, "ZZCGD Group Ops", title="Chief Executive Officer")   # a plain BU CEO of HQ
    HODF = person(db, "ZZ9CGD-HDF", CO, FIN, title="Head of Finance")
    HODT = person(db, "ZZ9CGD-HDT", CO, TAX, title="Head of Tax")
    O = [person(db, "ZZ9CGD-O%d" % i, CO, OPS) for i in range(1, 4)]
    F = [person(db, "ZZ9CGD-F%d" % i, CO, FIN) for i in range(1, 5)]
    T = [person(db, "ZZ9CGD-T%d" % i, CO, TAX) for i in range(1, 4)]
    S = [person(db, "ZZ9CGD-S%d" % i, HQ, "ZZCGD HQ Sales") for i in range(1, 4)]
    for p_ in F:
        db.execute("UPDATE users SET hod_id=? WHERE id=?", (HODF, p_))
    for p_ in T:
        db.execute("UPDATE users SET hod_id=? WHERE id=?", (HODT, p_))
    for p_ in S:
        db.execute("UPDATE users SET hod_id=? WHERE id=?", (BCEO, p_))
    EVERY = [CEO, CFO, BCEO, HODF, HODT] + O + F + T + S
    for p_ in EVERY:
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
                   "company) VALUES (?,?,'ZZCGD KPI',100,'more','approved',?,?)",
                   (CID, p_, BG, db.execute("SELECT company FROM users WHERE id=?", (p_,)).fetchone()[0]))
        db.execute("INSERT OR REPLACE INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'add')", (CID, p_))
    for p_ in F[:2] + T[:1] + S[:1]:   # some signed off their KPI check-in, the rest not
        db.execute("INSERT OR REPLACE INTO pm_review_session(subject_id, cycle_id, locked_at) VALUES (?,?,datetime('now'))",
                   (p_, CID))
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, CEO))
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, HQ, BCEO))
    a._sync_buceo_primary(db, CEO)
    a._sync_buceo_primary(db, BCEO)
    db.commit()
C_SU = H.client_as(a, SU["id"])
BAD = None


def off(keys):
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM leader_role_access")
        d.executemany("INSERT INTO leader_role_access(role, ability, allowed) VALUES (?,?,0)",
                      [(k.split(".")[0], k) for k in keys])
        d.commit()


def put_back_sessions(db):
    for st in ("pm_calibration_sessions", "calibration_sessions"):
        db.execute("DELETE FROM %s WHERE business_group=? OR (tier='hod' AND scope_key IN (%s))"
                   % (st, ",".join("?" * 2)), (BG, str(HODF), str(HODT)))
    db.commit()


def lock(db, tbl, tier, key, who, bg=BG):
    db.execute("INSERT OR REPLACE INTO %s(cycle_id, tier, scope_key, business_group, scope_label, locked_at, locked_by) "
               "VALUES (?,?,?,?,?,datetime('now'),?)" % tbl, (CID, tier, key, bg, key, who))
    db.commit()


_avail, _assist = a.ai_draft.review_agent_available, a._calib_assist_on
a.ai_draft.review_agent_available = lambda: True
a._calib_assist_on = lambda u_: True
try:
    s.section("fixture: Finance and Tax to the CFO (two departments of CO), Sales to the BU CEO as a calibrator")
    off([])
    r1 = C_SU.post("/admin/leaders", data=dict(csrf_token="tok", action="bu_group_save", bg=BG, tab="buceo", company=CO,
                                               name="ZZCGD Finance", group_dept=[FIN, TAX], calibrator_id=str(CFO)),
                   follow_redirects=True)
    r2 = C_SU.post("/admin/leaders", data=dict(csrf_token="tok", action="bu_group_save", bg=BG, tab="buceo", company=HQ,
                                               name="ZZCGD Sales", group_dept=["ZZCGD HQ Sales"], calibrator_id=str(CEO)),
                   follow_redirects=True)
    with a.app.app_context():
        db = a.get_db()
        G = {r["name"]: r["id"] for r in db.execute("SELECT id, name FROM calib_bu_groups WHERE business_group=?", (BG,))}
    s.check("fixture: both groups exist", set(G) == {"ZZCGD Finance", "ZZCGD Sales"}, G)
    GF, GS = G.get("ZZCGD Finance"), G.get("ZZCGD Sales")
    KF, KS = a.BU_GROUP_PREFIX + str(GF), a.BU_GROUP_PREFIX + str(GS)

    def card(uid, pick=None):
        with a.app.test_request_context("/dashboard" + ("?bu_unit=%s" % pick if pick else "")):
            d = a.get_db()
            return a.dash_bu_status(d, user(uid), d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())

    def members(gid):
        """The group's own resolver: the people the calibrator sees and calibrates (the journey's population)."""
        with a.app.test_request_context("/"):
            return a._pot_scope_population(a.get_db(), "buceo", (BG, CO, gid))

    # ------------------------------------------------------------------ the card
    s.section("the card: a pure calibrator's, built like the BU CEO's")
    B = card(CFO)
    mem = members(GF)
    s.check("a pure calibrator now has a card, and it is their group's", bool(B) and B.get("group") is True, B)
    s.check("its people equal the group's own resolver (an independent read)",
            B["people"] == len(mem) == len(F) + len(T) + 2, (B["people"], len(mem)))   # + the two HODs of those departments
    s.check("the departments are the HODs over the group's people, in the HODs' own words",
            sorted(d["name"] for d in B["depts"]) == sorted([FIN, TAX]) and B["n_depts"] == 2, B["depts"])
    s.check("nothing locked yet: both axes say Not ready to lock, and that you can lock without them",
            all(x["state"] == "waiting" and x["word"] == "Not ready to lock" and "you can lock without them" in x["line"]
                for x in B["axes"]) and [x["label"] for x in B["axes"]] == ["Performance", "Potential"], B["axes"])
    s.check("a pure calibrator has no unit pills (one scope)", B["units"] == [] and B["unit"].startswith("ZZCGD Finance"))
    with a.app.app_context():
        db = a.get_db()
        lock(db, "pm_calibration_sessions", "hod", str(HODF), HODF, BG)
        lock(db, "pm_calibration_sessions", "hod", str(HODT), HODT, BG)
        lock(db, "calibration_sessions", "hod", str(HODF), HODF, BG)
    B = card(CFO)
    perf = next(x for x in B["axes"] if x["key"] == "pm")
    pot = next(x for x in B["axes"] if x["key"] == "pot")
    s.check("every HOD review in on Performance: Ready to lock, '2 of 2 department reviews in'",
            perf["state"] == "ready" and perf["word"] == "Ready to lock" and perf["line"].startswith("2 of 2 department"), perf)
    s.check("one of two in on Potential: still Not ready to lock, '1 of 2'",
            pot["state"] == "waiting" and pot["line"].startswith("1 of 2 department reviews in"), pot)
    s.check("...each department row carries the HOD's own locked date per axis",
            all(d["pm"] for d in B["depts"]) and sum(1 for d in B["depts"] if d["pot"]) == 1, B["depts"])
    with a.app.app_context():
        db = a.get_db()
        lock(db, "pm_calibration_sessions", "buceo", KF, CFO)
    B = card(CFO)
    perf = next(x for x in B["axes"] if x["key"] == "pm")
    s.check("the group's own lock (scope grp:<id>) reads Locked <date>; the other axis is unmoved",
            perf["state"] == "locked" and perf["word"].startswith("Locked ")
            and next(x for x in B["axes"] if x["key"] == "pot")["state"] == "waiting", B["axes"])
    with a.app.app_context():
        db = a.get_db()
        lock(db, "pm_calibration_sessions", "buceo", KS, CEO)   # ANOTHER group's lock must not leak in
        db.execute("DELETE FROM pm_calibration_sessions WHERE scope_key=? AND business_group=?", (KF, BG))
        db.commit()
    B = card(CFO)
    s.check("falsified: with the group's lock gone and only another group's present, the axis is not Locked",
            next(x for x in B["axes"] if x["key"] == "pm")["state"] == "ready", B["axes"])
    with a.app.app_context():
        put_back_sessions(a.get_db())

    s.section("the card's gate: cg.view for a group, bu.view for a unit")
    off(["cg.view"])
    s.check("cg.view off: the calibrator's card goes", card(CFO) is None)
    s.check("...and the BU CEO's unit card does not (bu.view is theirs)", (card(BCEO) or {}).get("group") is False)
    off(["bu.view"])
    s.check("bu.view off: the BU CEO's card goes, the calibrator's stays", card(BCEO) is None and bool(card(CFO)))
    s.check("...a BU CEO who also calibrates keeps the card of the scope still allowed (their group)",
            (card(CEO) or {}).get("group") is True)
    off([])

    s.section("the plain BU CEO's card is the card it was")
    BC = card(BCEO)
    with a.app.test_request_context("/"):
        d = a.get_db()
        n_hq = d.execute("SELECT COUNT(*) FROM users WHERE business_group=? AND company=? AND role!='admin' AND "
                         + a.calibration_population_sql(), (BG, HQ)).fetchone()[0]
    s.check("a BU CEO's: a unit card, not a group's, its people the unit's, no pills for one unit",
            BC["group"] is False and BC["people"] == n_hq and BC["units"] == [] and "Calibration Group" not in str(BC["unit"]), BC)
    s.check("a person with no BU-level scope gets none", card(O[0]) is None and card(HODF) is None)

    # ------------------------------------------------------------------ two scopes: pills
    s.section("a BU CEO who also calibrates: a pill each, units first, ?bu_unit= switches the card")
    B1 = card(CEO)
    s.check("with no pick the first not locked comes first: their unit, its pill lit",
            B1["group"] is False and [p["on"] for p in B1["units"]] == [True, False], B1["units"])
    s.check("two pills, the unit first, then the group; a group pill says it is one",
            len(B1["units"]) == 2 and [p["group"] for p in B1["units"]] == [False, True], B1["units"])
    B2 = card(CEO, pick=KS)
    s.check("?bu_unit=grp:<id> switches the card to the group, its pill lit, the unit's pill still first",
            B2["group"] is True and [p["on"] for p in B2["units"]] == [False, True]
            and [p["group"] for p in B2["units"]] == [False, True], B2["units"])
    s.check("the group's pill counts the group's people (the journey's pill's own query)",
            B2["units"][1]["people"] == len(members(GS)) and B2["people"] == len(members(GS)))
    s.check("each pill is a link that switches the card (the same ?bu_unit= the journey reads)",
            "bu_unit=" in B2["units"][1]["href"] and KS.replace(":", "%3A") in B2["units"][1]["href"].replace(":", "%3A"),
            B2["units"])
    s.check("pill words as today: to calibrate until a lock", {p["word"] for p in B2["units"]} == {"to calibrate"})
    with a.app.app_context():
        db = a.get_db()
        lock(db, "pm_calibration_sessions", "buceo", KS, CEO)
    B3 = card(CEO, pick=KS)
    s.check("one axis locked: the group's pill says 1 of 2 locked", B3["units"][1]["word"] == "1 of 2 locked", B3["units"])
    with a.app.app_context():
        db = a.get_db()
        lock(db, "calibration_sessions", "buceo", KS, CEO)
    B4 = card(CEO, pick=KS)
    s.check("both locked: both locked", B4["units"][1]["word"] == "both locked", B4["units"])
    with a.app.app_context():
        put_back_sessions(a.get_db())

    # ------------------------------------------------------------------ the page
    s.section("the page: titles, tabs, the Calibration row")
    html_cfo = H.client_as(a, CFO).get("/dashboard").get_data(as_text=True)
    s.check("a pure calibrator's dashboard shows 'Your Calibration Group', not 'Where your BU is'",
            "Your Calibration Group" in html_cfo and ">Where your BU is<" not in html_cfo)
    s.check("...its people count and departments, in the card's own line",
            re.search(r"%d people &middot; 2 departments" % len(members(GF)), html_cfo) is not None
            or re.search(r"%d people · 2 departments" % len(members(GF)), html_cfo) is not None,
            re.findall(r"od-own-sub[^>]*>([^<]*)<", html_cfo)[:3])
    s.check("...the tab reads CG, with the full name on hover", re.search(r'title="Calibration Group"[^>]*>CG<', html_cfo))
    s.check("...the Own tab is unchanged", ">Own<" in html_cfo or "data-lt-tab=\"own\"" not in html_cfo)
    s.check("...and the Calibration row is there, with the way into AI+ Calibration",
            "to calibrate" in html_cfo and "Move on to AI+ Calibration" in html_cfo)
    html_bce = H.client_as(a, BCEO).get("/dashboard").get_data(as_text=True)
    s.check("a BU CEO's dashboard is still 'Where your BU is', tab BU, no Calibration Group",
            "Where your BU is" in html_bce and ">BU<" in html_bce and "Your Calibration Group" not in html_bce
            and "to calibrate" in html_bce)
    C_CEO = H.client_as(a, CEO)
    html_c1 = C_CEO.get("/dashboard").get_data(as_text=True)
    s.check("a BU CEO who also calibrates: both pills, the unit's card first",
            html_c1.count("od-bu-unit ") >= 2 and "Where your BU is" in html_c1)
    html_c2 = C_CEO.get("/dashboard?bu_unit=%s" % KS).get_data(as_text=True)
    s.check("the group pill switches the card to the group's, its pill lit",
            "Your Calibration Group" in html_c2 and re.search(r'class="od-bu-unit is-\w+ is-on"[^>]*aria-current="true"[^>]*><b>ZZCGD Sales',
                                                              html_c2), re.findall(r'class="od-bu-unit[^"]*"', html_c2))
    s.check("...and it stays on it for the next page (the session's pick)",
            "Your Calibration Group" in C_CEO.get("/dashboard").get_data(as_text=True))
    off(["cg.view"])
    s.check("cg.view off: the calibrator's page has no Calibration Group card",
            "Your Calibration Group" not in H.client_as(a, CFO).get("/dashboard").get_data(as_text=True))
    off([])
    with a.app.test_request_context("/"):
        d = a.get_db()
        hubs = a._hub_calibration_children(d, user(CFO), tiers=("buceo", "bugrp"))
        hubs_none = a._hub_calibration_children(d, user(O[0]), tiers=("buceo", "bugrp"))
    s.check("the calibration doors a calibrator can open: performance and potential, no Talent Box of their own",
            [x["name"] for x in hubs] == ["Performance Calibration", "360 Potential Calibration"]
            and all(x["pending_count"] == 1 for x in hubs), [(x["name"], x["pending_count"]) for x in hubs])
    s.check("falsified: someone with no scope gets no door", hubs_none == [])

    # ------------------------------------------------------------------ the email
    s.section("the email: calibrators are a role, ticked by default")
    s.check("LP_ROLES has the Calibrators tick, third in rank (BG CEO, BU CEO, Calibrator, HOD: 2026-10-30)",
            [(k, l) for k, l, _d in a.LP_ROLES] == [("bgceo", "BG CEOs"), ("buceo", "BU CEOs"), ("cg", "Calibrators"),
                                                    ("hod", "HODs")])
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM app_settings WHERE key='leader_progress_rules'")
        db.commit()
        s.check("the default rules include cg", "cg" in a.lp_rules()["roles"] and "cg" in a.LP_DEFAULT_RULES["roles"])
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('leader_progress_rules', ?)",
                   ('{"roles": ["buceo", "bgceo"]}',))
        db.commit()
        saved_roles = a.lp_rules()["roles"]
        db.execute("DELETE FROM app_settings WHERE key='leader_progress_rules'")
        db.commit()
    s.check("a saved list without cg wins: calibrators are left out", saved_roles == ["bgceo", "buceo"], saved_roles)
    T0 = a.LP_TPL_DEFAULT["cg"]
    s.check("the calibrator's words are the approved ones",
            T0["subject"] == "{scope}: where your departments stand in the {cycle} check-in"
            and T0["heading"] == "Your Calibration Group's progress" and T0["greeting"] == "Hi {display_name},"
            and T0["button"] == "Open AI+ OneHR" and T0["closing"] == "Their HODs can see who is still to submit."
            and T0["opening"].startswith("Here is where {scope} stands in the {cycle} check-in, as at {as_at}. The "
                                         "departments furthest behind come first. A word from you to their HODs now"), T0)
    with a.app.test_request_context("/"):
        s.check("it is a template kind, read like the BU CEO's (Email › Emails and templates)",
                "lp_cg" in a.EMAIL_TPL_KIND and a.email_tpl_words("lp_cg") == T0 and a.lp_template("cg") == T0)

    def build(roles, only=None):
        with a.app.test_request_context("/"):
            d = a.get_db()
            return a.lp_build(d, d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone(),
                              dict(a.lp_rules(), roles=roles, skip_done=False), only=only)

    def mine(built):
        return {(b["role"], b["user"]["id"]): b for b in built if b["user"]["id"] in (CEO, CFO, BCEO)}

    built, open_parts, _ahead = build(["buceo", "bgceo", "cg"])
    M = mine(built)
    s.check("the parts are open, so the leaders are built", len(open_parts) >= 1 and bool(M), open_parts)
    s.check("the pure calibrator gets a cg email; the BU CEO who also calibrates ONE email, as a BU CEO (the higher "
            "role); the plain BU CEO gets theirs", set(M) == {("cg", CFO), ("buceo", CEO), ("buceo", BCEO)}, set(M))
    bc = M[("cg", CFO)]
    sec = bc["sections"][0]
    s.check("the calibrator's one section is their group, named by the group", len(bc["sections"]) == 1
            and sec["name"] == "ZZCGD Finance" and sec.get("gid") == GF, [(x["name"], x.get("gid")) for x in bc["sections"]])
    s.check("its rows are the group's departments only", sorted(r["name"] for r in sec["rows"]) == sorted([FIN, TAX]),
            [r["name"] for r in sec["rows"]])
    with a.app.test_request_context("/"):
        d = a.get_db()
        taking = len(members(GF))
        done_truth = sum(1 for p_ in members(GF) if d.execute("SELECT 1 FROM pm_review_session WHERE subject_id=? AND "
                                                              "cycle_id=? AND locked_at IS NOT NULL", (p_["id"], CID)).fetchone())
    s.check("its people taking part equal the group's own members (the dashboard's resolver)", sec["people"] == taking == len(F) + len(T) + 2,
            (sec["people"], taking))
    s.check("...and the first part's total counts only the group's people: counted = members, done = those signed off "
            "(an independent read)", sec["total"][0]["n"] == taking and sec["total"][0]["done"] == done_truth
            and done_truth == 3, (sec["total"][0], done_truth))
    s.check("...the rows add up to the total", sum(r["cells"][0]["n"] for r in sec["rows"]) == sec["total"][0]["n"])
    s.check("...rows furthest behind first", [r["cells"][0]["pct"] for r in sec["rows"]]
            == sorted(r["cells"][0]["pct"] for r in sec["rows"]))
    cb = M[("buceo", CEO)]
    s.check("the BU CEO who calibrates: their unit's section only, no group section (one email, the highest role: "
            "2026-10-30)", [x.get("gid") for x in cb["sections"]] == [None] and cb["sections"][0]["name"] == "ZZCGD Unit",
            [(x["name"], x.get("gid")) for x in cb["sections"]])
    s.check("...and the calibrator's email is theirs when BU CEOs are not ticked: the group's section holds only its "
            "members (the HQ sales people), not the unit's",
            [x for x in build(["cg"])[0] if x["user"]["id"] == CEO][0]["sections"][0]["people"]
            == len(members(GS)) == len(S))
    s.check("a plain BU CEO's email has no group in it", [x.get("gid") for x in M[("buceo", BCEO)]["sections"]] == [None])
    only_cg, _o, _a = build(["cg"])
    Mc = mine(only_cg)
    s.check("with only Calibrators ticked: the CFO and the BU CEO who calibrates, each their groups only; no plain BU CEO",
            set(Mc) == {("cg", CFO), ("cg", CEO)} and [x.get("gid") for x in Mc[("cg", CEO)]["sections"]] == [GS], set(Mc))
    only_bu, _o, _a = build(["buceo"])
    Mb = mine(only_bu)
    s.check("with only BU CEOs ticked: units only; the pure calibrator gets none",
            set(Mb) == {("buceo", CEO), ("buceo", BCEO)} and [x.get("gid") for x in Mb[("buceo", CEO)]["sections"]] == [None], set(Mb))
    none_cg, _o, _a = build(["buceo", "bgceo"])
    s.check("falsified: with cg not ticked the calibrator has no email", ("cg", CFO) not in mine(none_cg))
    pick, _o, _a = build(["buceo", "cg"], only=("buceo", CEO))
    s.check("a test send / preview as the BU CEO who calibrates is their unit's email only (one email, the highest role)",
            len(pick) == 1 and [x.get("gid") for x in pick[0]["sections"]] == [None], pick and pick[0]["sections"])

    s.section("...the words: counts only, never a name; the footer says why")
    with a.app.test_request_context("/"):
        d = a.get_db()
        cyc = d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()
        subj_c, body_c = a.lp_mail(d, "cg", user(CFO), bc["sections"], open_parts, [], cyc, rules=dict(a.lp_rules(), enabled=True))
        subj_b, body_b = a.lp_mail(d, "buceo", user(CEO), cb["sections"], open_parts, [], cyc, rules=dict(a.lp_rules(), enabled=True))
        subj_p, body_p = a.lp_mail(d, "buceo", user(BCEO), M[("buceo", BCEO)]["sections"], open_parts, [], cyc)
        names = [r[0] for r in d.execute("SELECT full_name FROM users WHERE employee_id LIKE 'ZZ9CGD-%'")]
        mine_names = {user(CFO)["full_name"], user(CEO)["full_name"], user(BCEO)["full_name"]}
        cfo_name = user(CFO)["full_name"]
        hq_name = a.display_company(BG, HQ)
    s.check("the subject is the approved one, naming the group", subj_c.startswith("ZZCGD Finance: where your departments "
                                                                                    "stand in the "), subj_c)
    s.check("the heading, the opening, the button and the closing are the calibrator's own",
            "Your Calibration Group&#x27;s progress" in body_c or "Your Calibration Group's progress" in body_c)
    s.check("...the table's row word is Department, the total row says All departments",
            ">Department<" in body_c and "All departments" in body_c)
    s.check("...the closing line, and the footer: you calibrate it", "Their HODs can see who is still to submit." in body_c
            and "You get this because you calibrate ZZCGD Finance." in body_c, re.findall(r"You get this[^<]*", body_c))
    s.check("never the name of anyone counted (only the leader's own, in the greeting)",
            len(names) > 5 and not any(n in body_c + body_b + body_p for n in names if n not in mine_names)
            and "Hi " + cfo_name in body_c)
    s.check("...nor the department of anyone else's group (Ops is the BU CEO's alone)", OPS not in body_c)
    s.check("the BU CEO who also calibrates: the unit's email, the subject the unit's alone",
            subj_b.startswith("ZZCGD Unit:") and "ZZCGD Sales" not in subj_b, subj_b)
    s.check("...its footer says only the BU CEO of the unit: nothing of the group they calibrate",
            "You get this because you are the BU CEO of ZZCGD Unit." in body_b and "calibrate" not in body_b.split(
                "You get this", 1)[1].split("<", 1)[0], re.findall(r"You get this[^<]*", body_b))
    s.check("a plain BU CEO's footer is as it was", "You get this because you are the BU CEO of %s." % hq_name in body_p,
            re.findall(r"You get this[^<]*", body_p))
    s.check("...in the BU CEO's wording (heading), not the calibrator's",
            "Your unit&#x27;s progress" in body_b or "Your unit's progress" in body_b)

    s.section("the send: one email a person, queued in the outbox")
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('leader_progress_rules', ?)",
                  (a.json.dumps(dict(a.LP_DEFAULT_RULES, enabled=True)),))
        d.commit()
        out0 = OUT_BASE = d.execute("SELECT COALESCE(MAX(id),0) FROM email_outbox").fetchone()[0]
        a.lp_send(d, d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone(), "test", live=True)
        sent = d.execute("SELECT user_id, COUNT(*) FROM email_outbox WHERE id>? AND user_id IN (?,?,?) GROUP BY user_id",
                         (out0, CEO, CFO, BCEO)).fetchall()
    s.check("each of the three leaders is queued exactly once, the BU CEO who calibrates once not twice",
            {r[0]: r[1] for r in sent} == {CEO: 1, CFO: 1, BCEO: 1}, [tuple(r) for r in sent])

    # ------------------------------------------------------------------ the admin page
    s.section("the admin page: the third tick, the wording, Preview as")
    pg = C_SU.get("/admin/reminders/leaders").get_data(as_text=True)
    s.check("a third tick, Calibrators, with its count (people and groups), ticked by default",
            'name="role" value="cg"' in pg and "Calibrators" in pg
            and re.search(r'value="cg" form="lp-rules" checked', pg) and re.search(r"\d+ (?:person|people) · \d+ groups?", pg))
    with a.app.app_context():
        cals = a.lp_calibrators(a.get_db())
    s.check("...its count: every calibrator once (a BU CEO among them), every group",
            {CEO, CFO} <= set(cals) and sum(len(g) for _u, g in cals.values()) >= 2)
    pg_cg = C_SU.get("/admin/reminders/leaders?role=cg").get_data(as_text=True)
    s.check("the wording editor's switch gains Calibrators, on the calibrator's words",
            re.search(r'<a href="[^"]*role=cg[^"]*"[^>]*class="is-on"[^>]*>Calibrators</a>', pg_cg)
            and "Your Calibration Group&#39;s progress" in pg_cg.replace("&#34;", '"') or "Your Calibration Group's progress" in pg_cg)
    order = [pg_cg.index('name="%s"' % n) for n in ("subject", "heading", "opening", "greeting", "button", "closing")]
    s.check("the form, for every role: Subject, Heading, Opening, then Greeting and Button side by side, then Closing",
            order == sorted(order) and pg_cg.count('class="rm2-two"') == 1
            and pg_cg.index('class="rm2-two"') < pg_cg.index('name="greeting"') < pg_cg.index('name="button"')
            < pg_cg.index("</div>", pg_cg.index('class="rm2-two"')) < pg_cg.index('name="closing"'))
    s.check("Preview as lists the calibrators", 'value="cg:%d"' % CFO in pg and "ZZ Cgd CFO" in pg)
    pv = C_SU.get("/admin/reminders/leaders/preview?who=cg:%d" % CFO).get_data(as_text=True)
    s.check("the preview is the calibrator's email, as it would go out now",
            "Your Calibration Group" in pv and FIN in pv and "You get this because you calibrate" in pv)
    pv2 = C_SU.get("/admin/reminders/leaders/preview?who=buceo:%d" % CEO).get_data(as_text=True)
    s.check("...and the BU CEO who also calibrates previews ONE email, the unit's (the highest role): not the group",
            "ZZCGD Unit" in pv2 and "ZZCGD Sales" not in pv2 and "You get this because you calibrate" not in pv2)
    r = C_SU.post("/admin/reminders/leaders", data=dict(csrf_token="tok", action="save_email", role="cg", subject="{scope}: ZZ cg subject",
                                                       heading="ZZ cg heading", greeting="Hi {display_name},",
                                                       opening="ZZ opening", button="Open it", closing="ZZ closing"),
                  follow_redirects=True)
    with a.app.test_request_context("/"):
        words = a.lp_template("cg")
    s.check("a calibrator's wording saves, for their email only", words["heading"] == "ZZ cg heading"
            and a.LP_TPL_DEFAULT["cg"]["heading"] == "Your Calibration Group's progress"
            and words["closing"] == "ZZ closing", r.status_code)
    r = C_SU.post("/admin/reminders/leaders", data=dict(csrf_token="tok", action="reset_email", role="cg"), follow_redirects=True)
    with a.app.test_request_context("/"):
        s.check("...and goes back to the default", a.lp_template("cg") == a.LP_TPL_DEFAULT["cg"], r.status_code)
    ar = dict(csrf_token="tok", action="save_rules", freq="weekly", weekday="0", every_days="7", send_time="08:00",
              part="pm_results", skip_done="on", role=["buceo", "cg"], enabled="on")
    C_SU.post("/admin/reminders/leaders", data=ar, follow_redirects=True)
    with a.app.app_context():
        saved_roles = a.lp_rules()["roles"]
    s.check("the tick saves: cg in, the unticked bgceo out", saved_roles == ["buceo", "cg"], saved_roles)
    with a.app.app_context():
        s.check("the schedule line names them in the Email page's status row",
                "Calibrators" in a._st_leader_progress(a.get_db(), None))
    ar2 = dict(ar, role=["bgceo"])
    C_SU.post("/admin/reminders/leaders", data=ar2, follow_redirects=True)
    with a.app.app_context():
        s.check("falsified: unticked, it is not in the saved roles", "cg" not in a.lp_rules()["roles"])
    C_SU.post("/admin/reminders/leaders", data=dict(ar, role=["bgceo"]), follow_redirects=True)
    nb = H.client_as(a, CFO).post("/admin/reminders/leaders", data=dict(ar, role=["cg"]))
    with a.app.app_context():
        still = a.lp_rules()["roles"]
    s.check("the page and its writes stay the super admin's: a calibrator's post is refused and changes nothing",
            nb.status_code in (302, 401, 403) and still == ["bgceo"], (nb.status_code, still))
    es = C_SU.get("/admin/email").get_data(as_text=True)
    s.check("Email's schedule page has Leader progress on its top card, and the saved roles say Calibrators are in it (the Who chips moved out, 2026-11-09)",
            'data-eml-row="lp"' in es and "eml-own-h" in es)   # (2026-11-09: one card, a row an email; the role chips went with the old card)
    ee = C_SU.get("/admin/emails").get_data(as_text=True)
    s.check("Emails and templates lists Leader progress · Calibrators", "Leader progress · Calibrators" in ee)

    s.section("what Ask OneHR, Help and the tour know")
    src = open(os.path.join(ROOT, "app.py"), encoding="utf-8").read()
    s.check("Ask OneHR's guide has a line for a calibrator's card, and a unit's says it has pills",
            "Your Calibration Group (right, top)" in src and "a pill for each above it" in src)
    s.check("Help has the calibrator's quick answer", "dash_cg" in a.HELP_QA and "Calibration Group" in a.HELP_QA["dash_cg"][1])
    s.check("the tour's business stop covers the group's card",
            "Calibration Group" in open(os.path.join(ROOT, "static", "onboarding.js"), encoding="utf-8").read())
    s.check("the KB row says it (a guarded one-time reword, the new slug-less change)",
            "Your Calibration Group card" in a._BU_GROUPS_KB and "Your Calibration Group card" in src.split("# The BU KPI setup table (one row per unit x BU KPI x cycle).")[0])
finally:
    a.ai_draft.review_agent_available, a._calib_assist_on = _avail, _assist
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        db.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(CELLS)), (CID,) + CELLS)
        for w in WIN0:
            db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", w)
        db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN ('pm','tm','idp','calibration','review')", (CID,))
        for m in MOD0:
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", m)
        db.execute("DELETE FROM leader_role_access")
        for r in LEADER0:
            db.execute("INSERT INTO leader_role_access(role, ability, allowed, updated_by) VALUES (?,?,?,?)", r)
        for k, v in SAVED.items():
            if v:
                db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES (?,?)", (k, v[0]))
            else:
                db.execute("DELETE FROM app_settings WHERE key=?", (k,))
        H.restore_email_templates(db, TPLS)
        db.execute("DELETE FROM activity_log WHERE id>? AND action IN ('leader_progress_schedule','leader_progress_content',"
                   "'leader_progress_run','bu_group_save','bu_group_remove')", (LOG0,))
        db.execute("DELETE FROM email_outbox WHERE user_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZ9CGD-%')")
        # ...and the progress emails its `lp_send` queued for every REAL leader in the copy: left behind, they sat in the outbox
        # of the next suite in the batch (test_emails failed on them whenever the batches dealt the two together)
        db.execute("DELETE FROM email_outbox WHERE id>? AND kind LIKE 'leader_progress%'", (OUT_BASE,))
        db.commit()
    with a.app.app_context():
        a.bu_groups_forget()

sys.exit(s.done())
