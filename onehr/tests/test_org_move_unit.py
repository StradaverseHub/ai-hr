"""Moving a business unit to another business group (Org structure; Chris, 2026-11-06, "Yes, build it").

One shared function, _org_move_unit(db, company, old_bg, new_bg, me, apply=False): the preview (GET /admin/org/move-preview) calls it
with apply=False and writes nothing; the POST (action=move_company) with apply=True, one transaction. What this suite holds:
  * the classification: every table with a company column is in _ORG_MOVE_MOVES or _ORG_MOVE_LEFT (a new table fails until it is)
  * the preview writes nothing (a digest of every table the move touches, before and after, function and route)
  * refusals, server-side: a BG admin's preview and POST are 403, a POST without CSRF, the same group, a missing / inactive target,
    a clash with an active unit and with a removed one, a unit-scoped settings table already under the new group, a unit admin whose
    only unit it is; each leaves nothing behind
  * the move: people (leavers too, admins not), the BU CEO seat and the buceo_* columns (triggers quiet, no seat lost or duplicated),
    unit settings, open-cycle records (closed-cycle ones stay), BU-tier sessions, the calibration group inside the unit moves whole and
    the one spanning another unit stays (its unit rows left, its picked moved people removed), band rules left behind, the unit admin's
    grant ends, the old BG CEO's per-person moves on the moved people go, KPI lines wait to be set when the framework differs,
    org_unit_moves gets its row, the audit row holds counts and no names
  * rollback: a forced IntegrityError leaves org_units, users and the rest as they were ("Nothing was changed")
  * imports follow the move: _unit_canonical (old -> new, back -> original with no loop, unknown unchanged), the roster check files an
    old-pair row under the new group, Reactivate too
  * moving back restores people and settings, and the band rules left behind are in force again
Self-contained (fresh_db: the scratch database is put back at the end).
"""
import hashlib
import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Moving a business unit to another business group")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
SRC, DST, SAME, CLA, REM, GONE, THIRD = ("ZZMV Source Group", "ZZMV Target Group", "ZZMV Same Scale Group", "ZZMV Clash Group",
                                         "ZZMV Removed Group", "ZZMV Gone Group", "ZZMV Third Group")
X, Y, Z = "ZZMV UNIT X SDN BHD", "ZZMV UNIT Y SDN BHD", "ZZMV UNIT Z SDN BHD"
PRE = "ZZMV-"
ids = {}
CY = {}


def q1(sql, args=()):
    return H.one(a, sql, args)


def digest(db):
    """Every row of every table a move can touch, hashed: a preview or a refused move must leave it exactly as it found it."""
    out = {}
    tabs = sorted(a._ORG_MOVE_MOVES | a._ORG_MOVE_LEFT | {"org_units", "activity_log", "calib_bu_group_people", "calibration_sessions",
                                                          "pm_calibration_sessions", "calibration_adjustments",
                                                          "pm_calibration_adjustments", "late_passes"})
    have = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for t in [t for t in tabs if t in have]:
        out[t] = hashlib.sha256("".join(sorted(repr(tuple(r)) for r in db.execute('SELECT * FROM "%s"' % t).fetchall())).encode()).hexdigest()
    out["users"] = hashlib.sha256(repr([tuple(r) for r in db.execute(
        "SELECT id, business_group, company, buceo_bg, buceo_company, left_at, admin_bg FROM users ORDER BY id").fetchall()]).encode()).hexdigest()
    return out


def same(x, y, ignore=("activity_log",)):
    """Two digests are equal in every table but the audit log (a page view is logged there; a move's own row is checked on its own)."""
    return {k: v for k, v in x.items() if k not in ignore} == {k: v for k, v in y.items() if k not in ignore}


def differs(x, y):
    return sorted(k for k in x if x[k] != y.get(k))


try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        AC = a.active_cycle_id(db)
        s.check("there is an active cycle", AC is not None)
        # ---- the lint: every table with a company column is classified ----
        s.section("Classification")
        company_tables = set()
        for (t,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall():
            cols = [r[1] for r in db.execute('PRAGMA table_info("%s")' % t)]
            if "company" in cols or "buceo_company" in cols:
                company_tables.add(t)
        company_tables.discard("org_units")   # the move updates it itself
        unclassified = company_tables - a._ORG_MOVE_MOVES - a._ORG_MOVE_LEFT
        s.check("every table with a company column is in _ORG_MOVE_MOVES or _ORG_MOVE_LEFT", not unclassified, sorted(unclassified))
        s.check("the two sets share no table", not (a._ORG_MOVE_MOVES & a._ORG_MOVE_LEFT), sorted(a._ORG_MOVE_MOVES & a._ORG_MOVE_LEFT))
        OTHER_BRANCH = {"org_ext_ids"}   # Chart of KPI's table: named here, present only where that branch is merged (the code skips an absent table)
        s.check("no table is named that does not exist (but a table of another branch)", not ((a._ORG_MOVE_MOVES | a._ORG_MOVE_LEFT) - company_tables - OTHER_BRANCH),
                sorted((a._ORG_MOVE_MOVES | a._ORG_MOVE_LEFT) - company_tables - OTHER_BRANCH))
        bgc, unitc, _sc, _lb = a._org_name_columns(db)
        s.check("what the rename cascade reads as unit columns is all classified", {t for t, _c, _g in unitc} <= (a._ORG_MOVE_MOVES | a._ORG_MOVE_LEFT))

        # ---- the world ----
        for g_, cos, mech in ((SRC, (X, Y), "A"), (DST, (Z,), "B"), (SAME, (Z,), "A"), (CLA, (X,), "A")):
            for co in cos:
                db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (g_, co))
            db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?,?,?)",
                       (g_, mech, "base" if mech == "B" else None))
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (REM, "ZZMV UNIT W SDN BHD"))
        db.execute("INSERT INTO org_units(business_group, company, active) VALUES (?,?,0)", (REM, X))
        db.execute("INSERT INTO org_units(business_group, company, active) VALUES (?,?,0)", (GONE, Z))
        CY["X"] = db.execute("INSERT INTO cycles(code, name, is_active, year, half, archived_at) VALUES (?,?,0,2031,2,datetime('now'))",
                             ("ZZMV-X", "ZZMV Closed Cycle")).lastrowid
        base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND business_group!='' AND is_demo=0 "
                               "LIMIT 1").fetchone())
        cols = [c for c in base.keys() if c != "id"]

        def person(key, name, bg, co, dept, role="user", admin_bg=None, left=False, hod=None, mgr=None):
            v = dict(base, username=(PRE + key).lower(), employee_id=PRE + key, full_name="ZZ MV " + name, email=None,
                     hod_id=hod, manager_id=mgr, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=bg, company=co,
                     department=dept, role=role, admin_bg=admin_bg, is_demo=0, left_at=("2026-01-01" if left else None))
            db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
            return db.execute("SELECT id FROM users WHERE username=?", (v["username"],)).fetchone()[0]
        ids["y1"] = person("Y1", "Unit Y One", SRC, Y, "OPS")
        ids["y2"] = person("Y2", "Unit Y Two", SRC, Y, "OPS")
        ids["x1"] = person("X1", "Unit X One", SRC, X, "SALES", hod=ids["y1"], mgr=ids["y1"])
        ids["x2"] = person("X2", "Unit X Two", SRC, X, "SALES", hod=ids["y1"])
        ids["x3"] = person("X3", "Unit X Three", SRC, X, "FINANCE")
        ids["xl"] = person("XL", "Unit X Leaver", SRC, X, "SALES", left=True)
        ids["adm_in"] = person("ADMIN", "Admin In X", SRC, X, "", role="admin", admin_bg=SRC)   # an admin account: left out
        ids["uadm"] = person("UADM", "Unit Admin", "", "", "", role="admin", admin_bg=SRC)
        ids["bgadm"] = person("BGADM", "Group Admin", "", "", "", role="admin", admin_bg=SRC)
        ids["dadm"] = person("DADM", "Target Group Admin", "", "", "", role="admin", admin_bg=DST)
        ids["z1"] = person("Z1", "Unit Z One", DST, Z, "OPS")
        # a unit of the SAME NAME in a third group, whose person has a line still waiting on another group's scale (CLA works KPIs out
        # as SAME does): the move of X must leave it alone
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (THIRD, X))
        ids["t1"] = person("T1", "Third Group Unit X One", THIRD, X, "SALES")
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, rate5, "
                   "business_group, company, department, bg_pending) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)",
                   (AC, ids["t1"], "ZZMV KPI T", 100, "more", 1, 2, 3, 4, 5, CLA, X, "SALES"))
        # the unit admin holds X and Y
        db.executemany("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)",
                       [(ids["uadm"], X), (ids["uadm"], Y)])
        # a BU CEO seat in the unit (through the seat table, as the app writes it) and one more seat of the same person elsewhere
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (SRC, X, ids["x1"]))
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (SRC, Y, ids["x1"]))
        db.execute("UPDATE users SET buceo_bg=?, buceo_company=? WHERE id=?", (SRC, X, ids["x1"]))
        # KPI lines (this cycle and a closed one), rating records, BU KPI lines, settings
        for cid in (AC, CY["X"]):
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, rate5, "
                       "business_group, company, department) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (cid, ids["x2"], "ZZMV KPI", 100, "more", 1, 2, 3, 4, 5, SRC, X, "SALES"))
            db.execute("INSERT INTO rating_records(cycle_id, subject_id, employee_id, full_name, business_group, company) VALUES (?,?,?,?,?,?)",
                       (cid, ids["x2"], PRE + "X2", "ZZ MV Unit X Two", SRC, X))
            db.execute("INSERT INTO cycle_exclusions(cycle_id, business_group, company, department) VALUES (?,?,?,?)", (cid, SRC, X, "FINANCE"))
            db.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, kpi_name, method) VALUES (?,?,?,?,?)",
                       (cid, SRC, X, "ZZMV BU KPI", "more"))
        db.execute("INSERT INTO calib_dept_filter(business_group, company, view, shown) VALUES (?,?,?,1)", (SRC, X, "hod"))
        db.execute("INSERT INTO pm_positions(business_group, company, department, title) VALUES (?,?,?,?)", (SRC, X, "SALES", "ZZMV Head"))
        # band rules written for the old group: left behind
        rid = db.execute("INSERT INTO pm_band_rules(business_group, company, min_ua, min_be, min_me, min_ae, min_ou) VALUES (?,?,0,60,80,90,100)",
                         (SRC, X)).lastrowid
        db.execute("INSERT INTO pm_band_rule_depts(rule_id, business_group, company, department) VALUES (?,?,?,'')", (rid, SRC, X))
        crid = db.execute("INSERT INTO pm_cycle_band_rules(cycle_id, business_group, company, min_ua, min_be, min_me, min_ae, min_ou) "
                          "VALUES (?,?,?,0,60,80,90,100)", (AC, SRC, X)).lastrowid
        db.execute("INSERT INTO pm_cycle_band_rule_depts(rule_id, cycle_id, business_group, company, department) VALUES (?,?,?,?,'SALES')",
                   (crid, AC, SRC, X))
        # BU-tier sessions (this cycle and the closed one), and the old BG CEO's sessions with per-person moves
        for sess, adj in (("calibration_sessions", "calibration_adjustments"), ("pm_calibration_sessions", "pm_calibration_adjustments")):
            for cid in (AC, CY["X"]):
                db.execute("INSERT INTO %s(cycle_id, tier, scope_key, business_group, scope_label) VALUES (?,'buceo',?,?,?)" % sess,
                           (cid, X, SRC, X))
            sid = db.execute("INSERT INTO %s(cycle_id, tier, scope_key, business_group, scope_label) VALUES (?,'bgceo',?,?,?)" % sess,
                             (AC, SRC, SRC, SRC)).lastrowid
            for who in ("x2", "y1"):   # x2 is moved, y1 stays
                db.execute("INSERT INTO %s(session_id, subject_id, original_band, adjusted_band) VALUES (?,?,?,?)" % adj,
                           (sid, ids[who], "ME", "AE"))
        # calibration groups: one wholly inside the unit, one spanning X and Y (with people picked by name and an 'everyone left' rule)
        gin = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)",
                         (SRC, X, "ZZMV Inside group", ids["y2"])).lastrowid
        db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)", (gin, SRC, X, "SALES"))
        db.execute("INSERT INTO calib_bu_group_people(group_id, business_group, user_id) VALUES (?,?,?)", (gin, SRC, ids["x2"]))
        gsp = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)",
                         (SRC, X, "ZZMV Spanning group", ids["y2"])).lastrowid
        db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)", (gsp, SRC, X, "FINANCE"))
        db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)", (gsp, SRC, Y, "OPS"))
        db.execute("INSERT INTO calib_bu_group_left(group_id, business_group, company) VALUES (?,?,?)", (gsp, SRC, X))
        db.execute("INSERT INTO calib_bu_group_people(group_id, business_group, user_id) VALUES (?,?,?)", (gsp, SRC, ids["x3"]))
        db.execute("INSERT INTO calib_bu_group_people(group_id, business_group, user_id) VALUES (?,?,?)", (gsp, SRC, ids["y1"]))
        # panels: P1 holds only this unit (it moves whole, with its calibrator group); P2 holds X and Y (it stays, and its group with it)
        p1 = db.execute("INSERT INTO calib_bu_panels(business_group, company, name) VALUES (?,?,?)", (SRC, X, "ZZMV Panel inside")).lastrowid
        db.execute("INSERT INTO calib_bu_panel_units(panel_id, business_group, company) VALUES (?,?,?)", (p1, SRC, X))
        gp1 = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id, panel_id) VALUES (?,?,?,?,?)",
                         (SRC, X, "ZZMV Panel group inside", ids["y2"], p1)).lastrowid
        db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)", (gp1, SRC, X, "SALES"))
        p2 = db.execute("INSERT INTO calib_bu_panels(business_group, company, name) VALUES (?,?,?)", (SRC, X, "ZZMV Panel spanning")).lastrowid
        for co in (X, Y):
            db.execute("INSERT INTO calib_bu_panel_units(panel_id, business_group, company) VALUES (?,?,?)", (p2, SRC, co))
        gp2 = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id, panel_id) VALUES (?,?,?,?,?)",
                         (SRC, X, "ZZMV Panel group spanning", ids["y2"], p2)).lastrowid
        db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)", (gp2, SRC, X, "SALES"))
        # a group with one unit only: moving its last unit leaves it with a (group, '') row so it stays on Org structure
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (GONE + " Lone", "ZZMV UNIT L SDN BHD"))
        # a join of X with Y, led by X
        for co in (X, Y):
            db.execute("INSERT INTO calib_unit_joins(cycle_id, business_group, company, lead, curve_of) VALUES (?,?,?,?,?)", (AC, SRC, co, X, X))
        db.commit()
        # the BG CEO's lock of the unit this cycle (the old group's decision: stays under the old group)
        db.execute("INSERT INTO talent_box_bu_locks(period_id, cycle_id, business_group, company) VALUES (?,?,?,?)", (AC, AC, SRC, X))
        db.commit()
    SUP, BGC = H.client_as(a, SU["id"]), H.client_as(a, ids["bgadm"])
    me = dict(SU)

    def plan_of(old, new, company=X, apply=False):
        with a.app.app_context():
            return a._org_move_unit(a.get_db(), company, old, new, me, apply=apply)

    def snap():
        with a.app.app_context():
            return digest(a.get_db())

    def n_of(sql, args=()):
        return q1(sql, args)

    # ---- the preview writes nothing; the route ----
    s.section("Preview")
    d0 = snap()
    pl = plan_of(SRC, DST)
    s.check("the preview has no refusal", pl["refusal"] is None, pl["refusal"])
    s.check("the preview counts the people (3 active) and 1 leaver", pl["people"] == 3 and pl["leavers"] == 1, (pl["people"], pl["leavers"]))
    s.check("the preview did not apply", not pl["applied"] and same(snap(), d0), differs(snap(), d0))
    r = SUP.get("/admin/org/move-preview", query_string={"business_group": SRC, "company": X, "to": DST})
    html = r.get_data(as_text=True)
    s.check("the preview route answers 200 with the fragment", r.status_code == 200 and "Goes with it" in html and "Let go" in html)
    s.check("the preview names the unit admin whose grant ends", "ZZ MV Unit Admin" in html and "Ends" in html)
    s.check("it says what stays as filed and the move button counts the people", "Stays as filed" in html and "Move 3 people" in html)
    s.check("the KPI sentence appears (the two groups' frameworks differ) and the Talent Box sentence",
            "1 to 5 scale" in html and "Achievement %" in html and "BG CEO Talent Box" in html)
    s.check("the fragment's form carries its own CSRF token and is confirmed",
            'name="csrf_token"' in html and 'data-confirm="' in html and 'data-confirm-title="Move this business unit?"' in html
            and 'data-confirm-ok="Move"' in html and 'value="move_company"' in html and "is-danger" not in html)
    s.check("it lists the band rules as Dropped and the spanning group as Leaves", "Dropped" in html and "Leaves" in html)
    s.check("the route (GET) wrote nothing", same(snap(), d0), differs(snap(), d0))
    s.check("it flags the spanning group that follows this unit's PAT curve, and the join the unit leads",
            "PAT curve: set another on Leaders" in html and "leads the join" in html)
    s.check("it says, as information, whose HOD sits in the old group", "HOD sits in" in html)
    s.check("the BG CEO moves by the old group's BG CEO are counted (2 rows, both axes)", "2 removed" in html)
    r = SUP.get("/admin/org/move-preview", query_string={"business_group": SRC, "company": X, "to": SAME})
    s.check("no KPI sentence when both groups work KPIs out the same way", r.status_code == 200
            and "worked out again" not in r.get_data(as_text=True) and "need their figures set again" not in r.get_data(as_text=True))
    s.check("an unauthenticated GET goes to sign-in (the route probe)", a.app.test_client().get("/admin/org/move-preview").status_code in (301, 302))

    # ---- access ----
    s.section("Access")
    r = BGC.get("/admin/org/move-preview", query_string={"business_group": SRC, "company": X, "to": DST})
    s.check("a BG admin's preview is 403", r.status_code == 403, r.status_code)
    r = BGC.post("/admin/org", data={"csrf_token": "tok", "action": "move_company", "business_group": SRC, "company": X, "to_bg": DST})
    s.check("a BG admin's POST is 403", r.status_code == 403, r.status_code)
    r = SUP.post("/admin/org", data={"action": "move_company", "business_group": SRC, "company": X, "to_bg": DST})
    s.check("a POST without the CSRF token is refused (400)", r.status_code == 400, r.status_code)
    s.check("neither moved anything", same(snap(), d0), differs(snap(), d0))
    s.check("the route is in no admin role (the access map says super)", a.ADMIN_ACCESS_MAP.get("admin_org") == "super")

    # ---- refusals ----
    s.section("Refusals")
    def refused(new, company=X, old=SRC, fragment=None):
        p = plan_of(old, new, company)
        return p["refusal"]
    for label, new, frag in (("the same group", SRC, "already in"), ("a missing target", "ZZMV Nowhere Group", "isn't an active business group"),
                             ("an inactive target (its units all removed)", GONE, "isn't an active business group"),
                             ("no target picked", "", "Pick a business group")):
        w = refused(new)
        s.check("refuses %s" % label, bool(w) and frag in w, w)
    w = refused(CLA)
    with a.app.app_context():
        want = "%s already has a business unit called %s. Rename one of them first, then move it." % (a.display_bg(CLA), a.proper_name(X))
    s.check("refuses a clash with an ACTIVE unit of the same name, in the brief's words", w == want, w)
    w = refused(REM)
    s.check("refuses a clash with a REMOVED unit and says so", bool(w) and "(removed, but still on record)" in w and "Rename one of them first" in w, w)
    w = refused(DST, company="ZZMV No Such Unit")
    s.check("refuses a unit that is not in the old group", bool(w) and "isn't an active unit" in w, w)
    with a.app.app_context():   # a unit-scoped settings table already under (new group, unit)
        d_ = a.get_db()
        d_.execute("INSERT INTO calib_dept_filter(business_group, company, view, shown) VALUES (?,?,?,1)", (DST, X, "hod"))
        d_.commit()
    w = refused(DST)
    s.check("refuses when a unit-scoped settings table already holds rows under the new group", bool(w) and "calib_dept_filter" in w, w)
    with a.app.app_context():
        d_ = a.get_db(); d_.execute("DELETE FROM calib_dept_filter WHERE business_group=?", (DST,)); d_.commit()
    w = refused(DST)
    s.check("with that gone the move is allowed again", w is None, w)
    # the sole unit admin: ending the grant would make them admin of the whole old group
    with a.app.app_context():
        d_ = a.get_db(); d_.execute("DELETE FROM admin_companies WHERE admin_id=? AND company=?", (ids["uadm"], Y)); d_.commit()
    w = refused(DST)
    s.check("refuses when X is a unit admin's ONLY unit (they would be left with the whole group)",
            bool(w) and "ZZ MV Unit Admin" in w and "admin of all of" in w, w)
    with a.app.app_context():
        d_ = a.get_db(); d_.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (ids["uadm"], Y)); d_.commit()
    s.check("the refused plans wrote nothing", same(snap(), d0), differs(snap(), d0))
    r = SUP.get("/admin/org/move-preview", query_string={"business_group": SRC, "company": X, "to": CLA})
    s.check("the route answers a refusal with 409 and the words", r.status_code == 409 and "already has a business unit" in r.get_data(as_text=True))
    r = SUP.post("/admin/org", data={"csrf_token": "tok", "action": "move_company", "business_group": SRC, "company": X, "to_bg": CLA},
                 follow_redirects=True)
    s.check("a refused POST flashes 'Not moved' and changes nothing", "Not moved" in r.get_data(as_text=True) and same(snap(), d0), differs(snap(), d0))

    d0 = snap()

    # ---- rollback ----
    s.section("Rollback")
    with a.app.app_context():   # a seat already under (new group, unit) with no org row: the seat UPDATE collides with its primary key
        d_ = a.get_db()
        d_.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (DST, X, ids["y2"]))
        d_.commit()
    d1 = snap()
    users_before = n_of("SELECT group_concat(business_group || '|' || company, ';') FROM (SELECT business_group, company FROM users WHERE company=? ORDER BY id)", (X,))
    p = plan_of(SRC, DST, apply=True)
    s.check("a forced IntegrityError refuses with 'Nothing was changed'", bool(p["refusal"]) and "Nothing was changed" in p["refusal"], p["refusal"])
    s.check("org_units, users and every other table are as they were",
            same(snap(), d1) and n_of("SELECT business_group FROM org_units WHERE company=? AND business_group IN (?,?)", (X, SRC, DST)) == SRC
            and n_of("SELECT group_concat(business_group || '|' || company, ';') FROM (SELECT business_group, company FROM users WHERE company=? ORDER BY id)", (X,)) == users_before)
    s.check("no audit row was written for the refused move", n_of("SELECT COUNT(*) FROM activity_log WHERE action='org_move_unit'") == 0)
    s.check("no move was recorded", n_of("SELECT COUNT(*) FROM org_unit_moves WHERE company=?", (X,)) == 0)
    with a.app.app_context():
        d_ = a.get_db(); d_.execute("DELETE FROM buceo_seats WHERE business_group=?", (DST,)); d_.commit()

    d2 = snap()
    # any other failure (not only an IntegrityError) leaves nothing half-moved either, and the exception goes on. Read on the SAME
    # connection, before anything could close it (a closed connection drops an open transaction by itself).
    orig_refresh = a._rating_record_refresh
    def boom(*args, **kw):
        raise RuntimeError("forced")
    raised, still = None, None
    with a.app.app_context():
        d_ = a.get_db()
        a._rating_record_refresh = boom
        try:
            a._org_move_unit(d_, X, SRC, DST, me, apply=True)
        except RuntimeError as e:
            raised = e
        finally:
            a._rating_record_refresh = orig_refresh
        still = (d_.execute("SELECT business_group FROM org_units WHERE company=? AND business_group IN (?,?)", (X, SRC, DST)).fetchone()[0],
                 d_.execute("SELECT COUNT(*) FROM users WHERE business_group=? AND company=?", (DST, X)).fetchone()[0],
                 d_.in_transaction)
    s.check("a RuntimeError inside the move propagates", raised is not None and str(raised) == "forced", raised)
    s.check("and the connection is rolled back at once: org_units and users as they were, no transaction left open", still == (SRC, 0, False), still)
    s.check("nothing else changed, no move recorded, no audit row", same(snap(), d2), differs(snap(), d2))

    # ---- the move ----
    s.section("The move")
    with a.app.app_context():
        d_ = a.get_db()
        seats_before = d_.execute("SELECT COUNT(*) FROM buceo_seats").fetchone()[0]
        rr_closed_before = d_.execute("SELECT business_group FROM rating_records WHERE cycle_id=?", (CY["X"],)).fetchone()[0]
        n_users_total = d_.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    r = SUP.post("/admin/org", data={"csrf_token": "tok", "action": "move_company", "business_group": SRC, "company": X, "to_bg": DST})
    s.check("the POST redirects to the unit's row under its new group",
            r.status_code == 302 and r.headers["Location"].endswith("#co-%s-%s" % (a._org_anchor_slug(DST), a._org_anchor_slug(X))), r.headers.get("Location"))
    pg = SUP.get("/admin/org").get_data(as_text=True)
    s.check("the page says it in board 4's words", "went with it." in pg and "unit admin" in pg and "Moved " in pg and "ZZMV Spanning group" in pg)
    with a.app.app_context():
        d = a.get_db()
        x = lambda sql, args=(): d.execute(sql, args).fetchone()[0]   # noqa: E731
        s.check("org_units: the row is under the new group, active, with its id", x("SELECT COUNT(*) FROM org_units WHERE business_group=? AND company=? AND active=1", (DST, X)) == 1
                and x("SELECT COUNT(*) FROM org_units WHERE business_group=? AND company=?", (SRC, X)) == 0)
        s.check("the old group keeps its other unit", x("SELECT COUNT(*) FROM org_units WHERE business_group=? AND company=? AND active=1", (SRC, Y)) == 1)
        s.check("people move, leavers too", x("SELECT COUNT(*) FROM users WHERE business_group=? AND company=?", (DST, X)) == 4
                and x("SELECT business_group FROM users WHERE id=?", (ids["xl"],)) == DST)
        s.check("the admin account in the unit does not move", x("SELECT business_group FROM users WHERE id=?", (ids["adm_in"],)) == SRC)
        s.check("nobody was added or lost", x("SELECT COUNT(*) FROM users") == n_users_total)
        s.check("Unit Y's people stay", x("SELECT COUNT(*) FROM users WHERE business_group=? AND company=?", (SRC, Y)) == 2)
        s.check("the seat moved and none was lost or duplicated", x("SELECT COUNT(*) FROM buceo_seats") == seats_before
                and x("SELECT user_id FROM buceo_seats WHERE business_group=? AND company=?", (DST, X)) == ids["x1"]
                and x("SELECT COUNT(*) FROM buceo_seats WHERE business_group=? AND company=?", (SRC, X)) == 0
                and x("SELECT user_id FROM buceo_seats WHERE business_group=? AND company=?", (SRC, Y)) == ids["x1"])
        row = d.execute("SELECT buceo_bg, buceo_company FROM users WHERE id=?", (ids["x1"],)).fetchone()
        first = d.execute("SELECT business_group, company FROM buceo_seats WHERE user_id=? ORDER BY business_group, company LIMIT 1", (ids["x1"],)).fetchone()
        s.check("the buceo_* columns follow the seat (the person's first seat), the triggers added nothing", tuple(row) == tuple(first)
                and x("SELECT COUNT(*) FROM buceo_seats WHERE user_id=?", (ids["x1"],)) == 2)
        s.check("open-cycle records move: KPI line, rating record, exclusion, BU KPI line",
                x("SELECT business_group FROM rating_records WHERE cycle_id=? AND subject_id=?", (AC, ids["x2"])) == DST
                and x("SELECT business_group FROM cycle_exclusions WHERE cycle_id=?", (AC,)) == DST
                and x("SELECT business_group FROM pm_bu_kpis WHERE cycle_id=?", (AC,)) == DST)
        s.check("a closed cycle's records stay under the old group",
                x("SELECT business_group FROM rating_records WHERE cycle_id=?", (CY["X"],)) == rr_closed_before == SRC
                and x("SELECT business_group FROM cycle_exclusions WHERE cycle_id=?", (CY["X"],)) == SRC
                and x("SELECT business_group FROM pm_bu_kpis WHERE cycle_id=?", (CY["X"],)) == SRC
                and x("SELECT business_group FROM pm_kpi_targets WHERE cycle_id=?", (CY["X"],)) == SRC
                and x("SELECT business_group FROM calibration_sessions WHERE cycle_id=? AND tier='buceo'", (CY["X"],)) == SRC)
        s.check("the frameworks differ, so the open-cycle KPI line waits to be set (bg_pending) and keeps the old scale meanwhile",
                x("SELECT bg_pending FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (AC, ids["x2"])) == 1
                and x("SELECT business_group FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (AC, ids["x2"])) == SRC)
        s.check("unit settings move (filter, positions)", x("SELECT business_group FROM calib_dept_filter WHERE company=?", (X,)) == DST
                and x("SELECT business_group FROM pm_positions WHERE company=?", (X,)) == DST)
        s.check("BU-tier session rows move for the open cycle (both axes)",
                x("SELECT COUNT(*) FROM calibration_sessions WHERE cycle_id=? AND tier='buceo' AND scope_key=? AND business_group=?", (AC, X, DST)) == 1
                and x("SELECT COUNT(*) FROM pm_calibration_sessions WHERE cycle_id=? AND tier='buceo' AND scope_key=? AND business_group=?", (AC, X, DST)) == 1)
        s.check("the group wholly inside the unit moved whole (group, unit rows, picks)",
                x("SELECT business_group FROM calib_bu_groups WHERE name='ZZMV Inside group'") == DST
                and x("SELECT business_group FROM calib_bu_group_units WHERE group_id=?", (gin,)) == DST
                and x("SELECT business_group FROM calib_bu_group_people WHERE group_id=?", (gin,)) == DST)
        gsp = x("SELECT id FROM calib_bu_groups WHERE name='ZZMV Spanning group'")
        s.check("the spanning group stays in the old group, keeping its other unit",
                x("SELECT business_group FROM calib_bu_groups WHERE id=?", (gsp,)) == SRC
                and x("SELECT COUNT(*) FROM calib_bu_group_units WHERE group_id=? AND company=? AND business_group=?", (gsp, Y, SRC)) == 1)
        s.check("its rows for this unit are left behind (inert)", x("SELECT COUNT(*) FROM calib_bu_group_units WHERE group_id=? AND company=? AND business_group=?", (gsp, X, SRC)) == 1
                and x("SELECT COUNT(*) FROM calib_bu_group_left WHERE group_id=? AND company=?", (gsp, X)) == 1)
        s.check("its picked moved person is removed; the person who stays keeps their pick",
                x("SELECT COUNT(*) FROM calib_bu_group_people WHERE group_id=? AND user_id=?", (gsp, ids["x3"])) == 0
                and x("SELECT COUNT(*) FROM calib_bu_group_people WHERE group_id=? AND user_id=?", (gsp, ids["y1"])) == 1)
        s.check("the old group's band rules are left, not deleted",
                x("SELECT COUNT(*) FROM pm_band_rules WHERE business_group=? AND company=?", (SRC, X)) == 1
                and x("SELECT COUNT(*) FROM pm_cycle_band_rules WHERE business_group=? AND company=?", (SRC, X)) == 1
                and x("SELECT COUNT(*) FROM pm_band_rule_depts WHERE business_group=? AND company=?", (SRC, X)) == 1)
        s.check("the BG CEO's lock of the unit is the old group's decision: left under the old group",
                x("SELECT COUNT(*) FROM talent_box_bu_locks WHERE business_group=? AND company=?", (SRC, X)) == 1)
        s.check("a panel wholly inside the unit moves whole with its calibrator group; one that spans another unit stays, group and all",
                x("SELECT business_group FROM calib_bu_panels WHERE name='ZZMV Panel inside'") == DST
                and x("SELECT business_group FROM calib_bu_panel_units WHERE panel_id=(SELECT id FROM calib_bu_panels WHERE name='ZZMV Panel inside')") == DST
                and x("SELECT business_group FROM calib_bu_groups WHERE name='ZZMV Panel group inside'") == DST
                and x("SELECT business_group FROM calib_bu_panels WHERE name='ZZMV Panel spanning'") == SRC
                and x("SELECT business_group FROM calib_bu_groups WHERE name='ZZMV Panel group spanning'") == SRC)
        s.check("the join row of the unit stays in the old group", x("SELECT COUNT(*) FROM calib_unit_joins WHERE business_group=? AND company=?", (SRC, X)) == 1)
        s.check("the unit admin's grant on it ended; their other unit stays",
                x("SELECT COUNT(*) FROM admin_companies WHERE admin_id=? AND company=?", (ids["uadm"], X)) == 0
                and x("SELECT COUNT(*) FROM admin_companies WHERE admin_id=? AND company=?", (ids["uadm"], Y)) == 1)
        s.check("the old BG CEO's per-person moves on the moved person are gone (both axes); the stayer's remain",
                x("SELECT COUNT(*) FROM calibration_adjustments WHERE subject_id=?", (ids["x2"],)) == 0
                and x("SELECT COUNT(*) FROM pm_calibration_adjustments WHERE subject_id=?", (ids["x2"],)) == 0
                and x("SELECT COUNT(*) FROM calibration_adjustments WHERE subject_id=?", (ids["y1"],)) == 1)
        s.check("org_unit_moves got its row", x("SELECT COUNT(*) FROM org_unit_moves WHERE company=? AND from_bg=? AND to_bg=? AND moved_by=?", (X, SRC, DST, SU["id"])) == 1)
        audit = d.execute("SELECT detail FROM activity_log WHERE action='org_move_unit' ORDER BY id DESC LIMIT 1").fetchone()[0]
        s.check("the audit row holds counts, the unit and the groups", all(w in audit for w in (X, SRC, DST, "people 3", "users 4", "admin_grants_ended 1")), audit)
        names = [r[0] for r in d.execute("SELECT full_name FROM users WHERE employee_id LIKE ?", (PRE + "%",))]
        s.check("the audit row names no one", not any(n in audit for n in names) and "ZZ MV" not in audit, audit)
    # the unit appears under its new group on the page, and the lookups agree
    s.check("the unit's page row sits under the new group", ('id="co-%s-%s"' % (a._org_anchor_slug(DST), a._org_anchor_slug(X))) in pg)

    # ---- a group's last unit leaves: the group stays on Org structure ----
    s.section("The last unit of a group")
    LONE = GONE + " Lone"
    with a.app.app_context():
        p = a._org_move_unit(a.get_db(), "ZZMV UNIT L SDN BHD", LONE, DST, me, apply=True)
        d = a.get_db()
        s.check("the lone unit moved", p["refusal"] is None and d.execute("SELECT COUNT(*) FROM org_units WHERE business_group=? AND company=? AND active=1", (DST, "ZZMV UNIT L SDN BHD")).fetchone()[0] == 1, p["refusal"])
        s.check("the emptied group keeps a (group, '') row and is still a business group", d.execute("SELECT active FROM org_units WHERE business_group=? AND company=''", (LONE,)).fetchone()[0] == 1 and LONE in a.org_bgs(d))
        s.check("the target group has no placeholder row (it has a real unit)", d.execute("SELECT COUNT(*) FROM org_units WHERE business_group=? AND company=''", (DST,)).fetchone()[0] == 0)

    # ---- imports ----
    s.section("Imports follow the move")
    with a.app.app_context():
        d = a.get_db()
        s.check("_unit_canonical maps the old pair to the new group", a._unit_canonical(d, SRC, X) == DST)
        s.check("an active pair is unchanged", a._unit_canonical(d, DST, X) == DST)
        s.check("an unknown pair is unchanged", a._unit_canonical(d, SRC, "ZZMV Unknown Unit") == SRC and a._unit_canonical(d, "ZZMV Nobody", X) == "ZZMV Nobody")
        s.check("a blank unit or group is unchanged", a._unit_canonical(d, SRC, "") == SRC and a._unit_canonical(d, "", X) == "")
        s.check("a unit still in its old group keeps it (Y never moved)", a._unit_canonical(d, SRC, Y) == SRC)
        recs = [{"employee id": PRE + "X2", "employee name": "ZZ MV Unit X Two", "business group": SRC, "company": X, "department": "SALES"}]
        chk = a._roster_check(d, me, recs, False)
        s.check("a roster row naming the OLD pair is filed under the new group (no 'isn't a unit' error)",
                not chk["errors"] and chk["valid"] and chk["valid"][0]["bg"] == DST, chk["errors"])
        s.check("it is reported as information", chk["moved_rows"] and chk["moved_rows"][0]["to"] == DST and chk["moved_rows"][0]["from"] == SRC)
        ch = a._rimp_changes(d, me, chk, {})
        words = repr(ch)
        s.check("the Changes step says so", "Filed under a unit's new group" in words and "moved from" in words, words[:300])
        recs2 = [{"employee id": PRE + "X2", "employee name": "ZZ MV Unit X Two", "business group": DST, "company": X, "department": "SALES"}]
        chk2 = a._roster_check(d, me, recs2, False)
        s.check("once HR's file names the new group it matches directly", not chk2["errors"] and not chk2["moved_rows"] and chk2["valid"][0]["bg"] == DST)
        # Reactivate: a leaver kept under the old pair (loaded before the move) comes back under the new group
        lv = person_id = None
        d.execute("UPDATE users SET business_group=?, left_at='2026-01-01' WHERE id=?", (SRC, ids["xl"]))
        d.commit()
        a._reactivate_user(d, AC, ids["xl"])
        d.commit()
        s.check("Reactivate files a leaver kept under the old pair under the new group",
                d.execute("SELECT business_group FROM users WHERE id=?", (ids["xl"],)).fetchone()[0] == DST)

    # ---- moving back ----
    s.section("Moving back")
    p = plan_of(DST, SRC)
    s.check("the way back has no refusal (left-behind rows of the unit are not a clash)", p["refusal"] is None, p["refusal"])
    r = SUP.post("/admin/org", data={"csrf_token": "tok", "action": "move_company", "business_group": DST, "company": X, "to_bg": SRC})
    s.check("the move back is accepted", r.status_code == 302)
    with a.app.app_context():
        d = a.get_db()
        x = lambda sql, args=(): d.execute(sql, args).fetchone()[0]   # noqa: E731
        s.check("people and the seat are back", x("SELECT COUNT(*) FROM users WHERE business_group=? AND company=?", (SRC, X)) == 5
                and x("SELECT COUNT(*) FROM buceo_seats WHERE business_group=? AND company=?", (SRC, X)) == 1
                and x("SELECT COUNT(*) FROM buceo_seats") == seats_before)
        s.check("settings, records and the whole group are back", x("SELECT business_group FROM cycle_exclusions WHERE cycle_id=?", (AC,)) == SRC
                and x("SELECT business_group FROM pm_positions WHERE company=?", (X,)) == SRC
                and x("SELECT business_group FROM calib_bu_groups WHERE name='ZZMV Inside group'") == SRC)
        s.check("the band rules left behind are in force again under the old group",
                x("SELECT COUNT(*) FROM pm_band_rules WHERE business_group=? AND company=?", (SRC, X)) == 1
                and a._pm_band_rules_exist(d, cycle_id=AC))
        s.check("the unit's org row is back under the old group, active", x("SELECT COUNT(*) FROM org_units WHERE business_group=? AND company=? AND active=1", (SRC, X)) == 1)
        s.check("after a move back _unit_canonical maps both to the original and does not loop",
                a._unit_canonical(d, SRC, X) == SRC and a._unit_canonical(d, DST, X) == SRC)
        s.check("two moves are on record", x("SELECT COUNT(*) FROM org_unit_moves WHERE company=?", (X,)) == 2)

    # ---- the move into a group that scores the same way: lines follow, nothing waits ----
    s.section("Same framework")
    r = SUP.post("/admin/org", data={"csrf_token": "tok", "action": "move_company", "business_group": SRC, "company": X, "to_bg": SAME})
    with a.app.app_context():
        d = a.get_db()
        s.check("the lines follow the unit and none waits",
                d.execute("SELECT business_group, bg_pending FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (AC, ids["x2"])).fetchone()[:] == (SAME, 0))
    with a.app.app_context():
        d = a.get_db()
        s.check("a same-named unit's pending line in a third group (on a scale the new group also uses) is left alone",
                tuple(d.execute("SELECT business_group, bg_pending FROM pm_kpi_targets WHERE subject_id=?", (ids["t1"],)).fetchone()) == (CLA, 1))
    # a chain: SRC -> SAME -> and the old name still resolves to where the unit is now
    with a.app.app_context():
        s.check("a chain of moves resolves to where the unit is now", a._unit_canonical(a.get_db(), SRC, X) == SAME)

    # ---- the lint on the access map / route classification ----
    s.section("Route classification")
    rule = [r_ for r_ in a.app.url_map.iter_rules() if r_.endpoint == "admin_org_move_preview"]
    s.check("the preview route exists, GET only", len(rule) == 1 and "GET" in rule[0].methods and "POST" not in rule[0].methods)
    s.check("module gating never owns /admin/*", a.module_of_request("admin_org_move_preview", "/admin/org/move-preview") is None)
finally:
    pass

sys.exit(s.done())
