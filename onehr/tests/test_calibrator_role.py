"""The Calibrator (CG) leader role -- 2026-10-26, Chris: "Build the Calibrator (CG) role as drawn on the canvas, super
admin only on Roles & access" ([design canvas link removed]).

A calibrator is a calibration group's calibrator. Roles & access › Leader roles has a column for them (cg.view / cg.move /
cg.fit / cg.lock); the abilities are checked in the group's scope, the BU CEO's (bu.*) in the unit's:
  * switching cg.* off never stops a BU CEO in their unit, and switching bu.* off never stops a calibrator in their group
  * a person who is both obeys each in its own scope
  * the move (classic and potential writers), the lock (the classic route, the potential route, the chat's lock card) and
    the AI fit are all gated the same way
  * People's CG chip and Calibrators filter, the person page's Calibrator line, the Add a calibrator note, the calendar
    cells Ask OneHR shows, Help's seat answer, the KB row
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The Calibrator (CG) role: its own abilities, in its own scope")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG, CO, HQ = "ZZCGR Group", "ZZCGR Unit", "ZZCGR HQ"
OPS, FIN, SAL, TAX = "ZZCGR Ops", "ZZCGR Finance", "ZZCGR Sales", "ZZCGR Tax"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
TPL = open(os.path.join(ROOT, "templates", "admin_leaders.html"), encoding="utf-8").read()
CELLS = ("pm_buceo", "pot_buceo", "tb_bgceo", "pm_hod", "pot_hod")


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9CGR-%'")]
    gids = [r[0] for r in db.execute("SELECT id FROM calib_bu_groups WHERE business_group=?", (BG,))]
    for st, at in (("pm_calibration_sessions", "pm_calibration_adjustments"),
                   ("calibration_sessions", "calibration_adjustments")):
        for (sid,) in db.execute("SELECT id FROM %s WHERE business_group=?" % st, (BG,)).fetchall():
            db.execute("DELETE FROM %s WHERE session_id=?" % at, (sid,))
            db.execute("DELETE FROM %s WHERE id=?" % st, (sid,))
    db.execute("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BG,))
    for g_ in gids:
        for t_ in ("calib_bu_group_depts", "calib_bu_group_units", "calib_bu_group_people"):
            try:
                db.execute("DELETE FROM %s WHERE group_id=?" % t_, (g_,))
            except Exception:   # noqa: BLE001 -- a table this copy lacks
                pass
    for t_ in ("calib_bu_panel_weights", "calib_bu_panel_units"):
        try:
            db.execute("DELETE FROM %s WHERE panel_id IN (SELECT id FROM calib_bu_panels WHERE business_group=?)" % t_, (BG,))
        except Exception:   # noqa: BLE001
            pass
    db.execute("DELETE FROM pm_pbt_achievement WHERE business_group=?", (BG,))
    db.execute("DELETE FROM calib_bu_groups WHERE business_group=?", (BG,))
    try:
        db.execute("DELETE FROM calib_bu_panels WHERE business_group=?", (BG,))
    except Exception:   # noqa: BLE001
        pass
    if ids:
        ph = ",".join("?" * len(ids))
        for t, c in (("pm_kpi_targets", "subject_id"), ("cycle_participants", "subject_id"), ("buceo_seats", "user_id"),
                     ("rating_records", "subject_id"), ("ai_prerun_jobs", "subject_id")):
            try:
                db.execute("DELETE FROM %s WHERE %s IN (%s)" % (t, c, ph), ids)
            except Exception:   # noqa: BLE001
                pass
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("UPDATE users SET hod_id=NULL WHERE hod_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM activity_log WHERE action IN ('bu_group_save','bu_group_remove','bu_panel_save',"
               "'leader_role_access') AND (detail LIKE 'ZZCGR%' OR detail LIKE '%Calibrator (CG)%')")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, co, dept, title="ZZCGR Officer"):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, is_demo) VALUES (?,?, 'x', 'user', ?,?,?,?,?, '15', 0)",
                      (eid.lower(), "ZZ Cgr " + eid[-3:], eid, BG, co, dept, title)).lastrowid


def off(keys):
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM leader_role_access")
        d.executemany("INSERT INTO leader_role_access(role, ability, allowed) VALUES (?,?,0)",
                      [(k.split(".")[0], k) for k in keys])
        d.commit()


def refused(err):
    return bool(err) and "switched off" in str(err)


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    LEADER0 = [tuple(r) for r in db.execute("SELECT role, ability, allowed, updated_by FROM leader_role_access")]
    CID = a.active_cycle_id(db)
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    WIN0 = [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows WHERE cycle_id=? "
                                         "AND cell IN (%s)" % ",".join("?" * len(CELLS)), (CID,) + CELLS)]
    MOD0 = [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=? AND "
                                         "module_key IN ('pm','calibration','review')", (CID,))]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(CELLS)), (CID,) + CELLS)
    for c_ in CELLS:
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                   (CID, c_, "2020-01-01 00:00:00", "2099-12-31 15:59:00"))
    for m_ in ("pm", "calibration", "review"):
        db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, m_))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?), (?,?)", (BG, CO, BG, HQ))
    CEO = person(db, "ZZ9CGR-CEO", CO, OPS, title="Chief Executive Officer")     # BU CEO of CO, and calibrator of Sales
    CFO = person(db, "ZZ9CGR-CFO", HQ, "ZZCGR Group Finance", title="CHIEF FINANCIAL OFFICER")   # calibrator of Finance
    BCEO = person(db, "ZZ9CGR-BCE", HQ, "ZZCGR Group Ops", title="Chief Executive Officer")   # a plain BU CEO of HQ
    O = [person(db, "ZZ9CGR-O%d" % i, CO, OPS) for i in range(1, 4)]
    F = [person(db, "ZZ9CGR-F%d" % i, CO, FIN) for i in range(1, 4)]
    S = [person(db, "ZZ9CGR-S%d" % i, CO, SAL) for i in range(1, 3)]
    T = [person(db, "ZZ9CGR-T%d" % i, CO, TAX) for i in range(1, 3)]
    HS = [person(db, "ZZ9CGR-H%d" % i, HQ, "ZZCGR HQ Sales") for i in range(1, 3)]   # the CEO calibrates these, in HQ
    UNIT = O + F + S + T + [CEO]
    for p_ in UNIT + HS:
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
                   "company) VALUES (?,?,'ZZCGR KPI',100,'more','approved',?,?)", (CID, p_, BG, HQ if p_ in HS else CO))
        db.execute("INSERT OR REPLACE INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'add')", (CID, p_))
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, CEO))
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, HQ, BCEO))
    a._sync_buceo_primary(db, CEO)
    a._sync_buceo_primary(db, BCEO)
    db.commit()
C_SU = H.client_as(a, SU["id"])
C_BGA = H.client_as(a, BGA["id"]) if BGA else None
C_CFO, C_CEO = H.client_as(a, CFO), H.client_as(a, CEO)


def flashes(r):
    return " ".join(re.findall(r'class="flash[^"]*"[^>]*>(.*?)<', r.get_data(as_text=True), re.S))


_avail, _assist = a.ai_draft.review_agent_available, a._calib_assist_on
a.ai_draft.review_agent_available = lambda: True
a._calib_assist_on = lambda u_: True
try:
    s.section("the registry")
    keys = [k for _g, k, _l, _n in a.LEADER_ABILITIES]
    s.check("cg.view / move / fit / lock are leader abilities, in their own group",
            [k for k in keys if k.startswith("cg.")] == ["cg.view", "cg.move", "cg.fit", "cg.lock", "cg.progress"]
            and {g_ for g_, k, _l, _n in a.LEADER_ABILITIES if k.startswith("cg.")} == {"Their calibration group"})
    s.check("the role sits between BU CEO and BG CEO as Calibrator (CG)",
            [r for r, _l in a.LEADER_ROLES] == ["lm", "mx", "hod", "bu", "cg", "bg", "gc"]
            and dict(a.LEADER_ROLES)["cg"] == "Calibrator (CG)")
    s.check("the bugrp tier maps to the cg role, and a group's scope to cg.*",
            a.leader_tier_ability("bugrp", "move") == "cg.move"
            and a.leader_tier_ability("buceo", "move", {"grp": {"id": 1}}) == "cg.move"
            and a.leader_tier_ability("buceo", "move", "grp:4") == "cg.move"
            and a.leader_tier_ability("buceo", "move", ("bg", "co", 3)) == "cg.move"
            and a.leader_tier_ability("buceo", "lock", {"grp": None}) == "bu.lock"
            and a.leader_tier_ability("buceo", "view", ("bg", "co")) == "bu.view"
            and a._bu_tier_ability("Some Unit", "fit") == "bu.fit")

    s.section("fixture: Finance to the CFO, Sales to the BU CEO as a calibrator")
    r1 = C_SU.post("/admin/leaders", data=dict(csrf_token="tok", action="bu_group_save", bg=BG, tab="buceo", company=CO,
                                               name="ZZCGR Finance", group_dept=[FIN], calibrator_id=str(CFO)),
                   follow_redirects=True)
    r2 = C_SU.post("/admin/leaders", data=dict(csrf_token="tok", action="bu_group_save", bg=BG, tab="buceo", company=HQ,
                                               name="ZZCGR Sales", group_dept=["ZZCGR HQ Sales"], calibrator_id=str(CEO)),
                   follow_redirects=True)
    with a.app.app_context():
        db = a.get_db()
        G = {r["name"]: r["id"] for r in db.execute("SELECT id, name FROM calib_bu_groups WHERE business_group=?", (BG,))}
        s.check("fixture: both groups exist", set(G) == {"ZZCGR Finance", "ZZCGR Sales"}, (G, flashes(r1)[:100], flashes(r2)[:100]))
    GF, GS = G.get("ZZCGR Finance"), G.get("ZZCGR Sales")

    def users():
        d = a.get_db()
        return {k: d.execute("SELECT * FROM users WHERE id=?", (v,)).fetchone() for k, v in
                (("ceo", CEO), ("cfo", CFO), ("bce", BCEO))}

    def ctxs():
        """(BU CEO's unit ctx, the CFO's group ctx, the CEO's own Sales-group ctx)."""
        d = a.get_db()
        u = users()
        return (a._pm_calib_resolve(d, u["ceo"], "buceo", bg=BG, company=CO),
                a._pm_calib_resolve(d, u["cfo"], "buceo", bg=BG, company=CO, grp=GF),
                a._pm_calib_resolve(d, u["ceo"], "buceo", bg=BG, company=HQ, grp=GS))

    # ------------------------------------------------------------------ the move
    s.section("the move: cg.move for the group, bu.move for the unit")
    off([])
    with a.app.test_request_context("/", method="GET"):
        db = a.get_db()
        u = users()
        unit, grp_f, grp_s = ctxs()
        _, e_bu = a._pm_calib_apply(db, u["ceo"], unit, "buceo", O[0], "AE", "ZZ reason", dry_run=True)
        _, e_cg = a._pm_calib_apply(db, u["cfo"], grp_f, "buceo", F[0], "AE", "ZZ reason", dry_run=True)
        s.check("everything on: the BU CEO moves in the unit and the calibrator in the group", not e_bu and not e_cg,
                (e_bu, e_cg))
    off(["cg.move"])
    with a.app.test_request_context("/", method="GET"):
        db = a.get_db()
        u = users()
        unit, grp_f, grp_s = ctxs()
        _, e_cg = a._pm_calib_apply(db, u["cfo"], grp_f, "buceo", F[0], "AE", "ZZ reason", dry_run=True)
        _, e_bu = a._pm_calib_apply(db, u["ceo"], unit, "buceo", O[0], "AE", "ZZ reason", dry_run=True)
        s.check("cg.move off: the calibrator's move in their group is refused, saying why", refused(e_cg), e_cg)
        s.check("...while the BU CEO's move in their unit works", not e_bu, e_bu)
        _, e_both_g = a._pm_calib_apply(db, u["ceo"], grp_s, "buceo", HS[0], "AE", "ZZ reason", dry_run=True)
        _, e_both_u = a._pm_calib_apply(db, u["ceo"], unit, "buceo", O[1], "AE", "ZZ reason", dry_run=True)
        s.check("a person who is both: cg.move off stops them in the group only", refused(e_both_g) and not e_both_u,
                (e_both_g, e_both_u))
    off(["bu.move"])
    with a.app.test_request_context("/", method="GET"):
        db = a.get_db()
        u = users()
        unit, grp_f, grp_s = ctxs()
        _, e_cg = a._pm_calib_apply(db, u["cfo"], grp_f, "buceo", F[0], "AE", "ZZ reason", dry_run=True)
        _, e_bu = a._pm_calib_apply(db, u["ceo"], unit, "buceo", O[0], "AE", "ZZ reason", dry_run=True)
        s.check("bu.move off: the BU CEO's move in their unit is refused", refused(e_bu), e_bu)
        s.check("...while the calibrator still moves in their group", not e_cg, e_cg)
        _, e_both_g = a._pm_calib_apply(db, u["ceo"], grp_s, "buceo", HS[0], "AE", "ZZ reason", dry_run=True)
        _, e_both_u = a._pm_calib_apply(db, u["ceo"], unit, "buceo", O[1], "AE", "ZZ reason", dry_run=True)
        s.check("a person who is both: bu.move off stops them in the unit only", refused(e_both_u) and not e_both_g,
                (e_both_u, e_both_g))
        # the potential writer, from a hand-built scope as the existing leader-role suite does
        pg = ("buceo", (BG, CO, GF), {"population": [], "grp": {"id": GF}})
        pu = ("buceo", (BG, CO), {"population": [], "grp": None})
        _, ep_g = a._pot_calib_apply(db, u["cfo"], pg, F[0], "Mid", "ZZ")
        _, ep_u = a._pot_calib_apply(db, u["ceo"], pu, O[0], "Mid", "ZZ")
        s.check("potential: with bu.move off the unit's move is refused and the group's reaches its own checks",
                refused(ep_u) and not refused(ep_g), (ep_u, ep_g))
    off(["cg.move"])
    with a.app.test_request_context("/", method="GET"):
        db = a.get_db()
        u = users()
        _, ep_g = a._pot_calib_apply(db, u["cfo"], pg, F[0], "Mid", "ZZ")
        _, ep_u = a._pot_calib_apply(db, u["ceo"], pu, O[0], "Mid", "ZZ")
        s.check("potential: with cg.move off the group's move is refused and the unit's is not",
                refused(ep_g) and not refused(ep_u), (ep_g, ep_u))

    # ------------------------------------------------------------------ the view
    s.section("the view: cg.view for the group, bu.view for the unit")
    from werkzeug.exceptions import HTTPException

    def resolves(user_key, company=CO, **kw):
        with a.app.test_request_context("/", method="GET"):
            try:
                a._pm_calib_resolve(a.get_db(), users()[user_key], "buceo", bg=BG, company=company, **kw)
                return "ok"
            except HTTPException as e:
                return e.code
    off(["cg.view"])
    s.check("cg.view off: the calibrator can't open their group (403), the BU CEO still opens the unit",
            resolves("cfo", grp=GF) == 403 and resolves("ceo") == "ok")
    s.check("...and a BU CEO who also calibrates is stopped in the group only",
            resolves("ceo", company=HQ, grp=GS) == 403 and resolves("ceo") == "ok")
    off(["bu.view"])
    s.check("bu.view off: the BU CEO can't open the unit, the calibrator still opens the group",
            resolves("ceo") == 403 and resolves("cfo", grp=GF) == "ok")
    off([])

    # ------------------------------------------------------------------ the lock
    s.section("the lock: the classic route, the potential route and the chat's lock card")

    def post(client, path):
        return client.post(path, data={"csrf_token": "tok", "ajax": "1"}).status_code

    with a.app.test_request_context("/"):
        pm_grp = a.url_for("pm_calibration_buceo_lock", bg=BG, company=CO, grp=GF)
        pm_unit = a.url_for("pm_calibration_buceo_lock", bg=BG, company=CO)
        pot_grp = a.url_for("calibration_bugroup_lock", gid=GF)
        pot_unit = a.url_for("calibration_company_lock", bg=BG, company=CO)
    off(["cg.lock"])
    s.check("cg.lock off: the calibrator's classic lock is 403 (performance and potential)",
            post(C_CFO, pm_grp) == 403 and post(C_CFO, pot_grp) == 403,
            (post(C_CFO, pm_grp), post(C_CFO, pot_grp)))
    s.check("...while the BU CEO's lock of the unit is not stopped by it",
            post(C_CEO, pm_unit) != 403 and post(C_CEO, pot_unit) != 403, (post(C_CEO, pm_unit), post(C_CEO, pot_unit)))
    off(["bu.lock"])
    s.check("bu.lock off: the BU CEO's lock is 403 (performance and potential)",
            post(C_CEO, pm_unit) == 403 and post(C_CEO, pot_unit) == 403, (post(C_CEO, pm_unit), post(C_CEO, pot_unit)))
    s.check("...while the calibrator's lock is not stopped by it",
            post(C_CFO, pm_grp) != 403 and post(C_CFO, pot_grp) != 403, (post(C_CFO, pm_grp), post(C_CFO, pot_grp)))
    off(["cg.lock"])
    with a.app.test_request_context("/", method="GET"):
        db = a.get_db()
        u = users()
        unit, grp_f, grp_s = ctxs()
        r_cg = a._calib_tool_prepare_lock(db, u["cfo"], grp_f, "buceo", {"bg": BG, "company": CO, "grp": GF}, {})
        s.check("the chat's lock card (performance) is refused for the calibrator with cg.lock off",
                r_cg.get("ok") is False and refused(r_cg.get("error")), r_cg)
        r_both = a._calib_tool_prepare_lock(db, u["ceo"], grp_s, "buceo", {"bg": BG, "company": HQ, "grp": GS}, {})
        s.check("...and for a BU CEO who also calibrates, in the group", r_both.get("ok") is False and refused(r_both.get("error")))
        try:
            r_bu = a._calib_tool_prepare_lock(db, u["ceo"], unit, "buceo", {"bg": BG, "company": CO}, {})
        except Exception as e:   # noqa: BLE001 -- the card's own build, not the ability
            r_bu = {"ok": True, "exc": repr(e)}
        s.check("...but the BU CEO's own card is not stopped by cg.lock", not refused(r_bu.get("error")), r_bu)
        sc_g = ("buceo", (BG, CO, GF), {"population": [], "grp": {"id": GF}, "session": None})
        r_pot = a._pot_tool_prepare_lock(db, u["cfo"], sc_g, {})
        s.check("the potential lock card follows", r_pot.get("ok") is False and refused(r_pot.get("error")), r_pot)
    off([])

    # ------------------------------------------------------------------ the fit
    s.section("the AI fit: cg.fit for the group, bu.fit for the unit")

    def fit(client):
        r = client.post("/review/team/calib-fit", data={"csrf_token": "tok", "mode": "preview"})
        return r.status_code, (r.get_json(silent=True) or {}).get("error", "")
    off(["cg.fit"])
    st_cg, er_cg = fit(C_CFO)
    st_bu, er_bu = fit(C_CEO)
    s.check("cg.fit off: the pure calibrator's fit is 403 with the reason", st_cg == 403 and "switched off" in er_cg, (st_cg, er_cg))
    off(["bu.fit"])
    st_cg, er_cg = fit(C_CFO)
    st_bu, er_bu = fit(C_CEO)
    s.check("bu.fit off: the calibrator's fit is not stopped", "switched off" not in er_cg and st_cg != 403, (st_cg, er_cg))
    with a.app.test_request_context("/", method="GET"):
        db = a.get_db()
        u = users()
        unit, grp_f, grp_s = ctxs()
        s.check("a person who is both: the route's own scope check picks cg.fit in the group and bu.fit in the unit",
                a._fit_gate_ability(db, u["ceo"]) is None
                and refused(a._calib_fit_scope_off(db, u["ceo"], "buceo", unit))
                and a._calib_fit_scope_off(db, u["ceo"], "buceo", grp_s) is None, "")
        s.check("...and a pure BU CEO / pure calibrator get their own", a._fit_gate_ability(db, u["bce"]) == "bu.fit"
                and a._fit_gate_ability(db, u["cfo"]) == "cg.fit")
    off(["cg.fit"])
    with a.app.test_request_context("/", method="GET"):
        db = a.get_db()
        u = users()
        unit, grp_f, grp_s = ctxs()
        s.check("cg.fit off: a both-person is stopped in the group only",
                refused(a._calib_fit_scope_off(db, u["ceo"], "buceo", grp_s))
                and a._calib_fit_scope_off(db, u["ceo"], "buceo", unit) is None)
    off([])

    # ------------------------------------------------------------------ the tag
    s.section("People: the CG chip and the Calibrators filter")
    pg = C_SU.get("/admin/users", query_string={"q": "ZZ Cgr", "show": "all"}).get_data(as_text=True)

    def row_of(html, tail):
        m = re.search(r"<tr[^>]*>(?:(?!</tr>).)*?ZZ Cgr %s(?:(?!</tr>).)*?</tr>" % tail, html, re.S)
        return m.group(0) if m else ""
    r_cfo, r_ceo, r_bce, r_o = (row_of(pg, t_) for t_ in ("CFO", "CEO", "BCE", "-O1"))
    s.check("the calibrator carries a CG chip naming the group", 'adm-role is-cg" title="Calibrator of ZZCGR Finance"' in r_cfo, r_cfo[-300:])
    s.check("a BU CEO who also calibrates carries BU CEO and CG, CG after BU CEO and before nothing else",
            'is-bu' in r_ceo and 'is-cg' in r_ceo and r_ceo.index("is-bu") < r_ceo.index("is-cg")
            and "Calibrator of ZZCGR Sales" in r_ceo)
    s.check("a plain BU CEO carries no CG chip", "is-bu" in r_bce and "is-cg" not in r_bce, r_bce[-200:])
    s.check("an ordinary person carries none", bool(r_o) and 'class="adm-role ' not in r_o)
    fl = C_SU.get("/admin/users", query_string={"role": "cg", "show": "all", "q": "ZZ Cgr"}).get_data(as_text=True)
    s.check("the Calibrators filter lists the two calibrators and no one else",
            "ZZ Cgr CFO" in fl and "ZZ Cgr CEO" in fl and "ZZ Cgr BCE" not in fl and "ZZ Cgr -O1" not in fl)
    s.check("...with its chip in the Role row", ">Calibrators<" in pg or "Calibrators" in pg)

    s.section("the person page: the Calibrator line")
    want_f = H.one(a, "SELECT COUNT(*) FROM users WHERE business_group=? AND company=? AND department=? AND left_at IS NULL "
                      "AND role!='admin'", (BG, CO, FIN))
    pp = C_SU.get("/admin/users/%d" % CFO).get_data(as_text=True)
    s.check("the calibrator's roles panel reads 'calibrates <group> (N people)'",
            "data-cg-line" in pp and "calibrates ZZCGR Finance (%d people)" % want_f in pp, want_f)
    s.check("...with the super admin's link to Leaders › BU CEOs",
            "Leaders &rsaquo; BU CEOs &rsaquo;" in pp and "tab=buceo" in pp)
    s.check("...in the summary and the header chip", "Calibrator of ZZCGR Finance" in pp and "CG · ZZCGR Finance" in pp)
    s.check("the line is read only: no form in it", "data-cg-line" in pp and
            "<form" not in re.search(r"data-cg-line>.*?</div>", pp, re.S).group(0))
    po = C_SU.get("/admin/users/%d" % O[0]).get_data(as_text=True)
    s.check("someone who calibrates nothing reads 'calibrates no group'", "calibrates no group" in po)

    # ------------------------------------------------------------------ Roles & access
    s.section("Roles & access › Leader roles")
    lr = C_SU.get("/admin/roles", query_string={"tab": "leader"})
    html = lr.get_data(as_text=True)
    s.check("the page opens with the Calibrator (CG) column and the five cg rows",
            lr.status_code == 200 and 'title="Calibrator (CG)">Calibrator<' in html
            and all('name="l_cg.%s"' % k in html for k in ("view", "move", "fit", "lock", "progress")))
    s.check("the intro names the new seat", "calibrating a calibration group" in html and "BU CEOs" in html)
    with a.app.test_request_context("/"):
        cx_ = a._leader_roles_ctx(a.get_db())
    cg_rows = [r_ for g_ in cx_["l_groups"] for r_ in g_["rows"] if r_["key"].startswith("cg.")]
    s.check("the cell rule: a cg row ticks only in the cg column; a bu row has none there",
            all([c["role"] for c in r_["cells"] if c["mine"]] == ["cg"] for r_ in cg_rows) and len(cg_rows) == 5
            and all(not [c for c in r_["cells"] if c["role"] == "cg" and c["mine"]]
                    for g_ in cx_["l_groups"] for r_ in g_["rows"] if r_["key"].startswith("bu.")))
    form = {"csrf_token": "tok", "action": "save"}
    form.update({"l_" + k: "1" for _g, k, _l, _n in a.LEADER_ABILITIES if k != "cg.fit"})
    rp = C_SU.post("/admin/roles?tab=leader", data=form, follow_redirects=True)
    rows_ = [tuple(r) for r in H.rows(a, "SELECT role, ability, allowed FROM leader_role_access")]
    s.check("unticking Fit with AI for the calibrator lands in leader_role_access as role cg", rows_ == [("cg", "cg.fit", 0)],
            (rows_, flashes(rp)[:100]))
    s.check("...and it is audited", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='leader_role_access' AND "
                                              "detail LIKE '%Calibrator (CG): Fit the curve with AI%'") >= 1)
    if C_BGA is not None:
        s.check("a BG admin can't open Roles & access (403) or save it",
                C_BGA.get("/admin/roles", query_string={"tab": "leader"}).status_code in (403, 404, 302)
                and C_BGA.post("/admin/roles?tab=leader", data=form).status_code in (403, 404, 302))
    s.check("an employee can't either", C_CFO.get("/admin/roles", query_string={"tab": "leader"}).status_code in (403, 404, 302))
    s.check("no admin item was added for it (the page stays super only)", "cg." not in " ".join(
        k for k, _l, _g in getattr(a, "ADMIN_ITEMS", [])) if isinstance(getattr(a, "ADMIN_ITEMS", None), (list, tuple))
        and all(len(x) == 3 for x in a.ADMIN_ITEMS) else True)
    off([])

    # ------------------------------------------------------------------ Add a calibrator, the calendar, the guides
    s.section("Add a calibrator, the calendar and the guides")
    s.check("step 3 carries the CG note, the abilities and the BU CEO's window line",
            "data-bp-cg-note" in TPL and 'adm-role is-cg' in TPL and "They become a Calibrator (CG)." in TPL
            and "see the group's curve, move a band, fit with AI, lock the group" in TPL
            and "Taking them off this panel ends the role." in TPL
            and "The calibrators' window is the BU CEO's on the calendar." in TPL)
    with a.app.test_request_context("/"):
        db = a.get_db()
        u = users()
        cells = lambda x: {c[0] for c in a._ask_cells(db, x)}   # noqa: E731
        s.check("_ask_cells: a calibrator gets the BU CEO's window cells",
                {"pm_buceo", "pot_buceo"} <= cells(u["cfo"]) and {"pm_buceo", "pot_buceo"} <= cells(u["bce"]))
        o1 = db.execute("SELECT * FROM users WHERE id=?", (O[0],)).fetchone()
        s.check("...and an ordinary person doesn't", not ({"pm_buceo", "pot_buceo"} & cells(o1)))
        items = a._help_items(["seat_cg"])
        s.check("Help has a CG seat answer", items and "CG" in items[0]["a"], items)
        kb = db.execute("SELECT body FROM kb_entries WHERE slug='bu-calibration-groups'").fetchone()
        s.check("the KB row says calibrators carry the CG tag and have their own switches",
                kb and "carries the CG tag" in kb[0] and "Roles & access" in kb[0], (kb[0][:80] if kb else None))
    src = H.source(a)
    s.check("the fit gate, both fit routes and both lock cards read the scope's ability", all(x in src for x in (
        "_fit_gate_ability(get_db(), u)", "_calib_fit_scope_off(db, u, sc[0], sc[2])",
        "_calib_fit_scope_off(db, u, tier, ctx)", 'leader_tier_ability(tier, "lock", ctx)')))
finally:
    a.ai_draft.review_agent_available, a._calib_assist_on = _avail, _assist
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM leader_role_access")
        db.executemany("INSERT INTO leader_role_access(role, ability, allowed, updated_by) VALUES (?,?,?,?)", LEADER0)
        db.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(CELLS)), (CID,) + CELLS)
        db.executemany("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", WIN0)
        for m_ in ("pm", "calibration", "review"):
            db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, m_))
        db.executemany("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", MOD0)
        db.commit()
        _cleanup(db)
sys.exit(s.done())
