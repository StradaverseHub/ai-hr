"""Calibration groups at BU level -- 2026-10-22, Chris.

  "a BU has 10 depts, 2 is calibrated by CFO, and 8 by BUCEO, or even certain scenario 2 by CFO, 3 by COO, and rest by
   BUCEO. so we should enable admin to be able to name this new group and assign to the respective C-suite"
  Canvas Fsbpy9BAzFmtYJ97B6fp3p: "go with 2A, 3A, 4A" -- a group sits inside one unit (2A), follows the unit's PAT curve
  on its own with the same rule and its own lock (3A), and the BU CEO sees its people read only, tagged (4A). Access:
  "Super admin only" -- leaders.calib_groups, ticked for no role.

What it holds:
  * the super admin names a group, ticks some of a unit's departments and picks its calibrator; a BG admin can't; the
    writer refuses a department of another unit, a department already in a group, every department of the unit, the
    unit's own BU CEO, a leaver, a duplicate name; a unit with a group can't be joined to another
  * every band reader resolves a grouped person's BU tier through the group ("grp:<id>"), anyone else through the unit;
    the calibrator holds the BU tier for the group's people only
  * the BU CEO's scope leaves the group's people out (they ride along read only, tagged with the calibrator), the
    calibrator's scope is the group's people only; a move by the wrong one is refused, a lock is the scope's own
  * the HOD's department review closes on the group's lock; the BG CEO's pending list waits on the group too; the Talent
    Box tags a grouped person with the calibrator and says who has locked at BU level; Lock status lists the group
  * once anyone has moved someone in its departments (or locked) this cycle, a group's departments stay where they are
  * the page: Leaders › BU CEOs shows each unit's groups to every admin who reads Leaders, the panels only to the super
    admin, every form double-confirmed
"""
import os
import html
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Calibration groups at BU level: some departments, another calibrator")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG, CO, HQ = "ZZBUG Group", "ZZBUG Unit", "ZZBUG HQ"
U2, U3 = "ZZBUG Unit2", "ZZBUG Unit3"   # the cross-unit group's units (2026-10-22)
OPS, FIN, SAL, TAX = "ZZBUG Ops", "ZZBUG Finance", "ZZBUG Sales", "ZZBUG Tax"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
JS = open(os.path.join(ROOT, "static", "journey_chat.js"), encoding="utf-8").read()
TPL = open(os.path.join(ROOT, "templates", "admin_leaders.html"), encoding="utf-8").read()
CELLS = ("pm_buceo", "pot_buceo", "tb_bgceo", "pm_hod", "pot_hod")


def _cleanup(db):
    for (gc_,) in db.execute("SELECT id FROM pm_calibration_groups WHERE name LIKE 'ZZBUG %'").fetchall():
        db.execute("DELETE FROM pm_calibration_group_members WHERE group_id=?", (gc_,))
        db.execute("DELETE FROM app_settings WHERE key IN (?,?)", ("calib_group_mode:%d" % gc_, "calib_group_rules:%d" % gc_))
        for t_ in ("pm_group_locks", "pot_group_locks"):
            db.execute("DELETE FROM %s WHERE group_id=?" % t_, (gc_,))
        db.execute("DELETE FROM pm_calibration_groups WHERE id=?", (gc_,))
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BUG-%'")]
    gids = [r[0] for r in db.execute("SELECT id FROM calib_bu_groups WHERE business_group=?", (BG,))]
    for st, at in (("pm_calibration_sessions", "pm_calibration_adjustments"),
                   ("calibration_sessions", "calibration_adjustments")):
        for (sid,) in db.execute("SELECT id FROM %s WHERE business_group=?" % st, (BG,)).fetchall():
            db.execute("DELETE FROM %s WHERE session_id=?" % at, (sid,))
            db.execute("DELETE FROM %s WHERE id=?" % st, (sid,))
    db.execute("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BG,))
    for g_ in gids:
        db.execute("DELETE FROM calib_bu_group_depts WHERE group_id=?", (g_,))
        db.execute("DELETE FROM calib_bu_group_units WHERE group_id=?", (g_,))
        db.execute("DELETE FROM calib_bu_group_people WHERE group_id=?", (g_,))
    db.execute("DELETE FROM pm_pbt_achievement WHERE business_group=?", (BG,))
    db.execute("DELETE FROM calib_bu_groups WHERE business_group=?", (BG,))
    for (p_,) in db.execute("SELECT id FROM calib_bu_panels WHERE business_group=?", (BG,)).fetchall():
        db.execute("DELETE FROM calib_bu_panel_units WHERE panel_id=?", (p_,))
        db.execute("DELETE FROM calib_bu_panel_weights WHERE panel_id=?", (p_,))
    db.execute("DELETE FROM calib_bu_panels WHERE business_group=?", (BG,))
    if ids:
        ph = ",".join("?" * len(ids))
        for t, c in (("pm_kpi_targets", "subject_id"), ("cycle_participants", "subject_id"), ("buceo_seats", "user_id"),
                     ("rating_records", "subject_id"), ("ai_prerun_jobs", "subject_id")):
            try:
                db.execute("DELETE FROM %s WHERE %s IN (%s)" % (t, c, ph), ids)
            except Exception:   # noqa: BLE001 -- a table this copy lacks
                pass
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("UPDATE users SET hod_id=NULL WHERE hod_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM activity_log WHERE action IN ('bu_group_save','bu_group_remove') AND detail LIKE 'ZZBUG%'")
    db.execute("DELETE FROM activity_log WHERE action IN ('pm_calibration_unlock','calibration_unlock',"
               "'pm_calib_group_unlock') AND detail LIKE '%ZZBUG%'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, co, dept, title="ZZBUG Officer", left=False):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, left_at, is_demo) VALUES (?,?, 'x', 'user', ?,?,?,?,?, '15', ?, 0)",
                      (eid.lower(), "ZZ Bug " + eid[-3:], eid, BG, co, dept, title,
                       "2026-01-01" if left else None)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    WIN0 = [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows WHERE cycle_id=? "
                                         "AND cell IN (%s)" % ",".join("?" * len(CELLS)), (CID,) + CELLS)]
    MOD0 = [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=? AND "
                                         "module_key IN ('pm','calibration','review')", (CID,))]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))   # the BU level is the Year-End's
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(CELLS)), (CID,) + CELLS)
    for c_ in CELLS:
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                   (CID, c_, "2020-01-01 00:00:00", "2099-12-31 15:59:00"))
    for m_ in ("pm", "calibration", "review"):
        db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, m_))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?), (?,?)", (BG, CO, BG, HQ))
    CEO = person(db, "ZZ9BUG-CEO", CO, OPS, title="Chief Executive Officer")
    CFO = person(db, "ZZ9BUG-CFO", HQ, "ZZBUG Group Finance", title="CHIEF FINANCIAL OFFICER")
    COO = person(db, "ZZ9BUG-COO", HQ, "ZZBUG Group Ops", title="Group Chief Operating Officer")
    LEFT = person(db, "ZZ9BUG-LFT", HQ, "ZZBUG Group Ops", left=True)
    O = [person(db, "ZZ9BUG-O%d" % i, CO, OPS) for i in range(1, 4)]
    F = [person(db, "ZZ9BUG-F%d" % i, CO, FIN) for i in range(1, 4)]
    S = [person(db, "ZZ9BUG-S%d" % i, CO, SAL) for i in range(1, 3)]
    T = [person(db, "ZZ9BUG-T%d" % i, CO, TAX) for i in range(1, 3)]
    HOD = person(db, "ZZ9BUG-HOD", CO, FIN, title="Head of Finance")
    for p_ in F:
        db.execute("UPDATE users SET hod_id=? WHERE id=?", (HOD, p_))
    UNIT = O + F + S + T + [HOD, CEO]
    for p_ in UNIT:
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
                   "company) VALUES (?,?,'ZZBUG KPI',100,'more','approved',?,?)", (CID, p_, BG, CO))
        db.execute("INSERT OR REPLACE INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'add')", (CID, p_))
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, CEO))
    a._sync_buceo_primary(db, CEO)
    db.commit()
C_SU = H.client_as(a, SU["id"])
C_BGA = H.client_as(a, BGA["id"]) if BGA else None
C_CEO, C_CFO = H.client_as(a, CEO), H.client_as(a, CFO)


def flashes(r):
    return " ".join(re.findall(r'class="flash[^"]*"[^>]*>(.*?)<', r.get_data(as_text=True), re.S))


def save(client, follow=True, **kw):
    data = dict(csrf_token="tok", action="bu_group_save", bg=BG, tab="buceo", company=CO)
    data.update(kw)
    return client.post("/admin/leaders", data=data, follow_redirects=follow)


def groups():
    return H.rows(a, "SELECT id, name, calibrator_id, active FROM calib_bu_groups WHERE business_group=? ORDER BY id",
                  (BG,))


def depts_of(gid):
    return sorted(r[0] for r in H.rows(a, "SELECT department FROM calib_bu_group_units WHERE group_id=?", (gid,)))


def pairs_of(gid):
    return sorted(tuple(r) for r in H.rows(a, "SELECT company, department FROM calib_bu_group_units WHERE group_id=?",
                                           (gid,)))


_real_breaches = a._pm_calib_lock_breaches
try:
    # ------------------------------------------------------------------ the admin page and the writer
    s.section("the super admin sets a group up on Leaders › BU CEOs; nobody else can")
    s.check("leaders.calib_groups is on Roles & access, and no preset carries it (ticked for no role)",
            "leaders.calib_groups" in a.ADMIN_ITEM_KEYS and "leaders.calib_groups" in a.ADMIN_ITEMS_EXPLICIT)
    _src = H.source(a)
    s.check("both actions are mapped to it on the access map",
            'bu_group_save=_it("leaders.calib_groups"), bu_group_remove=_it("leaders.calib_groups")' in _src)
    if C_BGA:
        with a.app.app_context():
            db = a.get_db()
            BGA0 = db.execute("SELECT admin_bg FROM users WHERE id=?", (BGA["id"],)).fetchone()[0]
            db.execute("UPDATE users SET admin_bg=? WHERE id=?", (BG, BGA["id"]))
            db.commit()
        rb = save(C_BGA, name="ZZBUG Finance", group_dept=[FIN], calibrator_id=str(CFO))
        s.check("a BG admin's save changes nothing (the access map or the writer refuses it)", not groups(),
                (rb.status_code, flashes(rb)[:120]))
        pg_b = C_BGA.get("/admin/leaders?bg=%s&tab=buceo" % BG).get_data(as_text=True)
        s.check("...and their page has no panel forms or Add a calibrator", 'data-panel-open="bp-' not in pg_b
                and "calibration panel" in pg_b.lower() and "+ Add a calibrator" not in pg_b, len(pg_b))
    r = save(C_SU, name="", group_dept=[FIN], calibrator_id=str(CFO))
    s.check("a group needs a name", not groups() and "Name the group" in flashes(r), flashes(r)[:120])
    r = save(C_SU, name="ZZBUG Finance", group_dept=[], calibrator_id=str(CFO))
    s.check("...and a department or a person", not groups() and "Tick at least one department" in flashes(r),
            flashes(r)[:120])
    r = save(C_SU, name="ZZBUG Finance", group_dept=["ZZBUG Group Finance"], calibrator_id=str(CFO))
    s.check("...of this unit (a department of another unit is refused)", not groups()
            and "Pick the departments from the business group" in flashes(r), flashes(r)[:120])
    r = save(C_SU, name="ZZBUG Finance", group_dept=[OPS, FIN, SAL, TAX], calibrator_id=str(CFO))
    s.check("...never every department (the BU CEO keeps some; to hand it all over, change the BU CEO)", not groups()
            and "Leave at least one department" in flashes(r), flashes(r)[:120])
    r = save(C_SU, name="ZZBUG Finance", group_dept=[FIN], calibrator_id=str(CEO))
    s.check("the unit's own BU CEO isn't a calibrator of its group", not groups() and "is the BU CEO of" in flashes(r),
            flashes(r)[:120])
    r = save(C_SU, name="ZZBUG Finance", group_dept=[FIN], calibrator_id=str(LEFT))
    s.check("...nor someone who has left", not groups() and "Pick the calibrator" in flashes(r), flashes(r)[:120])
    r = save(C_SU, name="ZZBUG Finance", group_dept=[FIN], calibrator_id="")
    s.check("...and a calibrator is required", not groups(), flashes(r)[:120])
    r = save(C_SU, name="  ZZBUG   Finance ", group_dept=[FIN, " %s " % FIN], calibrator_id=str(CFO))
    G = groups()
    GID = G[0][0] if G else None
    s.check("the super admin's save makes the group: its name tidied, its department once, the CFO its calibrator",
            len(G) == 1 and G[0][1] == "ZZBUG Finance" and G[0][2] == CFO and depts_of(GID) == [FIN], (G, flashes(r)))
    s.check("...written to the audit trail", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='bu_group_save' "
                                                       "AND target_user_id=?", (CFO,)) >= 1)
    r = save(C_SU, name="zzbug finance", group_dept=[TAX], calibrator_id=str(COO))
    s.check("a second group can't take the same name", len(groups()) == 1 and "called" in flashes(r), flashes(r)[:120])
    r = save(C_SU, name="ZZBUG Tax", group_dept=[FIN, TAX], calibrator_id=str(COO))
    s.check("...nor a department already in a group", len(groups()) == 1 and "in ZZBUG Finance already" in flashes(r),
            flashes(r)[:120])
    r = save(C_SU, name="ZZBUG Tax", group_dept=[TAX], calibrator_id=str(COO))
    G = groups()
    GID2 = G[1][0] if len(G) > 1 else None
    s.check("...while another department and the COO make a second group (2 by the CFO, 2 by the COO, the rest the "
            "BU CEO's)", len(G) == 2 and depts_of(GID2) == [TAX] and G[1][2] == COO, G)
    pg = C_SU.get("/admin/leaders?bg=%s&tab=buceo" % BG).get_data(as_text=True)
    PID = H.one(a, "SELECT panel_id FROM calib_bu_groups WHERE id=?", (GID,))
    _ub = re.search(r'<tr class="data-row[^"]*" data-bu="ZZBUG Unit".*?(?=<tr class="data-row|<tr class="no-filter-match)', pg, re.S)
    _ub = _ub.group(0) if _ub else ""
    s.check("each one-calibrator group is a panel over one unit, so a sub-row under that unit, never a unit of its own, "
            "and not in the panels' block: its calibrator and tag, whose PAT, Manage (2026-10-27; Chris: \"an add button to "
            "the right end of the BUCEOs ... a temporary BG\")",
            PID and _ub.count('class="ld-subrow"') == 2 and 'class="ld-grp-body"' not in pg
            and 'data-panel-open="bp-%d"' % PID in _ub and "ZZBUG Finance" in _ub
            and "Curve: ZZBUG Unit's PAT</span>" in _ub and "ZZ Bug CFO" in _ub and ">CFO</span>" in _ub
            and "ZZBUG Tax" in _ub and "Calibration panel" in _ub and 'data-bu="ZZBUG Finance"' not in pg, len(_ub))
    _head = pg[pg.find('class="ld-bu-head"'):][:400]
    s.check("...+ Add a calibrator sits at the right end of the BU CEOs title", "+ Add a calibrator" in _head
            and 'data-panel-open="bp-new"' in _head)
    _urow = re.search(r'data-bu="ZZBUG Unit".*?</tr>', pg, re.S)
    s.check("...each group's line says how many sit in it (the unit's People no longer lists them)", _urow is not None
            and "4 in ZZBUG Finance" not in _urow.group(0) and re.search(r"ZZBUG Finance.*?<td>4</td>", _ub, re.S)
            and re.search(r"ZZBUG Tax.*?<td>2</td>", _ub, re.S))
    _new = pg[pg.find('data-panel="bp-new"'):] if 'data-panel="bp-new"' in pg else ""
    s.check("...and the Add panel: the units to tick, the calibrators picked from this BG, whose curve, the departments "
            "of each unit for step 2 (the taken ones marked), no split", _new and 'name="panel_unit" value="%s"' % CO in _new
            and 'name="cal_eids"' in _new and 'data-pick-bg="%s"' % BG in _new and 'name="curve_of"' in _new
            and '"%s||%s": "ZZBUG Finance"' % (CO, FIN) in _new and SAL in pg[pg.find('id="bp-units"'):][:4000]
            and 'name="split"' not in pg)
    _pforms = [f_ for f_ in re.findall(r'<form method="post"[^>]*>', pg) if "bu_panel" in pg[pg.find(f_):pg.find(f_) + 600]]
    s.check("every panel form asks before it writes (OneHR's own confirm box)",
            len(_pforms) >= 2 and all("data-confirm" in f_ for f_ in _pforms), len(_pforms))
    with a.app.app_context():
        db = a.get_db()
        s.check("a unit with a group can't be joined to another for the cycle",
                a._join_unit_state(db, CID, BG, CO)[0] is False)

    # ------------------------------------------------------------------ who holds the BU tier for whom
    s.section("a grouped person's BU tier is the group's; everyone else's is the unit's")
    with a.app.test_request_context("/"):
        db = a.get_db()
        uf, uo = (db.execute("SELECT * FROM users WHERE id=?", (x,)).fetchone() for x in (F[0], O[0]))
        s.check("bu_scope_key: the group's key for Finance, the unit for Ops",
                a.bu_scope_key(db, uf) == "grp:%d" % GID and a.bu_scope_key(db, uo) == CO)
        s.check("...also for a row read without its department",
                a.bu_scope_key(db, {"id": F[0], "business_group": BG, "company": CO}) == "grp:%d" % GID)
        cfo, ceo = (db.execute("SELECT * FROM users WHERE id=?", (x,)).fetchone() for x in (CFO, CEO))
        tiers = a.calibration_tier_of(db, cfo)
        s.check("the CFO holds the group as a BU-level scope", ("bugrp", (BG, CO, GID)) in tiers, tiers)
        s.check("...and is the BU tier for Finance's people, not for Ops'",
                a.leader_role_of(db, cfo, uf) == "buceo" and a.leader_role_of(db, cfo, uo) != "buceo")
        s.check("the BU CEO keeps Ops' people", a.leader_role_of(db, ceo, uo) == "buceo")

    # ------------------------------------------------------------------ the scopes
    s.section("the BU CEO calibrates the rest, the CFO the group; each one's moves and lock are their own")
    with a.app.test_request_context("/", method="GET"):
        db = a.get_db()
        ceo = db.execute("SELECT * FROM users WHERE id=?", (CEO,)).fetchone()
        cfo = db.execute("SELECT * FROM users WHERE id=?", (CFO,)).fetchone()
        cx = a._pm_calib_resolve(db, ceo, "buceo", bg=BG, company=CO)
        pop = {p["id"] for p in cx["population"]}
        oth = {p["id"] for p in cx["others"]}
        s.check("the BU CEO's population leaves Finance and Tax out", not (pop & set(F + T)) and set(O + S) <= pop,
                (len(pop), len(pop & set(F + T))))
        s.check("...who ride along as the grouped people", oth == set(F + [HOD]) | set(T), sorted(oth))
        gx = a._pm_calib_resolve(db, cfo, "buceo", bg=BG, company=CO, grp=GID)
        s.check("the CFO's population is Finance's people only", {p["id"] for p in gx["population"]} == set(F + [HOD])
                and gx["scope_key"] == "grp:%d" % GID and not gx["others"])
        try:
            a._pm_calib_resolve(db, cfo, "buceo", bg=BG, company=CO)
            s.check("the CFO can't open the unit's own calibration", False)
        except Exception as e:   # noqa: BLE001
            s.check("the CFO can't open the unit's own calibration", getattr(e, "code", None) == 403, repr(e))
        try:
            a._pm_calib_resolve(db, ceo, "buceo", bg=BG, company=CO, grp=GID)
            s.check("...nor the BU CEO the CFO's group", False)
        except Exception as e:   # noqa: BLE001
            s.check("...nor the BU CEO the CFO's group", getattr(e, "code", None) == 403, repr(e))
        _, err = a._pm_calib_apply(db, ceo, cx, "buceo", F[0], "AE", "ZZ reason", dry_run=True)
        s.check("the BU CEO's move on a Finance person is refused", err is not None, err)
        _, err = a._pm_calib_apply(db, cfo, gx, "buceo", O[0], "AE", "ZZ reason", dry_run=True)
        s.check("...and the CFO's on an Ops person", err is not None, err)
        ov = a._pm_calib_assist_overview(db, ceo, cx, "buceo", {"bg": BG, "company": CO})["data"]
        s.check("the BU CEO's card: the curve's rows are theirs, the grouped people read only with the calibrator's tag",
                {r_["id"] for r_ in ov["rows"]} == pop and {r_["id"] for r_ in ov["others"]} == oth
                and {r_["by"] for r_ in ov["others"]} == {"CFO", "COO"} and all(r_["other"] for r_ in ov["others"]))
        s.check("...each other row's journey stops below this tier (Self, LM, HOD), the own column left for the tag",
                all([c_["tier"] for c_ in r_["chain"]] == ["Self", "LM", "HOD"] for r_ in ov["others"]),
                [c_["tier"] for c_ in (ov["others"][0]["chain"] if ov["others"] else [])])
        s.check("...and the curve counts only the BU CEO's own rows", ov["total"] == sum(
            1 for r_ in ov["rows"] if r_["on_curve"]), (ov["total"], len(pop)))
        gov = a._pm_calib_assist_overview(db, cfo, gx, "buceo", {"bg": BG, "company": CO, "grp": GID})["data"]
        s.check("the CFO's card has the group's people and the unit's curve", {r_["id"] for r_ in gov["rows"]}
                == set(F + [HOD]) and not gov["others"] and gov["group"] and gov["curve"]["label"] == ov["curve"]["label"])
        s.check("...and its lock posts with the group", "grp=%d" % GID in gov["lock_url"], gov["lock_url"])
        s.check("...its own column headed BU level, never BU CEO (the BU CEO's stays BU CEO)",
                gov["rows"] and gov["rows"][0]["chain"][-1]["tier"] == "BU level"
                and ov["rows"][0]["chain"][-1]["tier"] == "BU CEO")
        _note = a._bu_group_prompt_note(db, gx, "buceo")
        s.check("the CFO's agent is told it's a calibration panel, never the BU CEO",
                _note and "CALIBRATION PANEL" in _note and "never the BU CEO" in _note)
        _note2 = a._bu_group_prompt_note(db, cx, "buceo")
        s.check("...and the BU CEO's who the greyed rows are", _note2 and "reads their bands only" in _note2 and "CFO" in _note2.upper())
    # the potential side
    with a.app.test_request_context("/"):
        db = a.get_db()
        pp = a._pot_scope_population(db, "buceo", (BG, CO))
        pg_ = a._pot_scope_population(db, "buceo", (BG, CO, GID))
        s.check("potential: the BU CEO's population leaves the groups out, the group's is Finance only",
                not ({p_["id"] for p_ in pp} & set(F + T)) and {p_["id"] for p_ in pg_} == set(F + [HOD]))
        sc = a._pot_calib_sc(db, CID, "buceo", (BG, CO, GID), pg_)
        s.check("...its scope key is the group's", sc[2]["scope_key"] == "grp:%d" % GID and sc[2]["grp"]["id"] == GID)

    # ------------------------------------------------------------------ a move, the lock, the readers
    s.section("the CFO moves and locks; every reader takes the group's band; the HOD review closes with it")
    mv = C_CFO.post("/performance/calibration/company/%s/%s/adjust?grp=%d" % (BG, CO, GID),
                    data={"csrf_token": "tok", "subject_id": str(F[0]), "adjusted_band": "OU",
                          "justification": "ZZBUG led the audit"})
    adj = H.one(a, "SELECT a.adjusted_band FROM pm_calibration_adjustments a JOIN pm_calibration_sessions s ON "
                   "s.id=a.session_id WHERE s.cycle_id=? AND s.tier='buceo' AND s.scope_key=? AND a.subject_id=?",
                (CID, "grp:%d" % GID, F[0]))
    s.check("the CFO's move lands on the group's own session", adj == "OU", (mv.status_code, adj))
    mvx = C_CEO.post("/performance/calibration/company/%s/%s/adjust" % (BG, CO),
                     data={"csrf_token": "tok", "subject_id": str(F[1]), "adjusted_band": "BE",
                           "justification": "ZZBUG not theirs"})
    s.check("the BU CEO's post on a Finance person writes nothing", H.one(
        a, "SELECT COUNT(*) FROM pm_calibration_adjustments a JOIN pm_calibration_sessions s ON s.id=a.session_id "
           "WHERE s.business_group=? AND a.subject_id=?", (BG, F[1])) == 0, mvx.status_code)
    r = save(C_SU, name="ZZBUG Finance", group_id=str(GID), group_dept=[SAL], calibrator_id=str(CFO))
    s.check("once the CFO has moved someone in Finance, Finance stays in the group (taking it out is refused)",
            depts_of(GID) == [FIN] and "already moved" in flashes(r), flashes(r)[:140])
    r = C_SU.post("/admin/leaders", data=dict(csrf_token="tok", action="bu_group_remove", bg=BG, tab="buceo",
                                               company=CO, group_id=str(GID)), follow_redirects=True)
    s.check("...and the group can't be removed", H.one(a, "SELECT active FROM calib_bu_groups WHERE id=?", (GID,)) == 1
            and "already moved" in flashes(r), flashes(r)[:140])
    r = save(C_SU, name="ZZBUG Finance & Accounts", group_id=str(GID), group_dept=[FIN], calibrator_id=str(CFO))
    s.check("...while renaming it still works (the calibrator and name aren't the departments)",
            H.one(a, "SELECT name FROM calib_bu_groups WHERE id=?", (GID,)) == "ZZBUG Finance & Accounts", flashes(r)[:120])
    with a.app.app_context():
        db = a.get_db()
        pend0 = [x[0] for x in a.pm_calibration_pending_children(db, CID, "bgceo", BG)]
    # the BU CEO locks their part; the unit still waits on the groups (the curve rule isn't what's tested here)
    a._pm_calib_lock_breaches = lambda *x_, **k_: {}
    lk = C_CEO.post("/performance/calibration/company/%s/%s/lock" % (BG, CO),
                    data={"csrf_token": "tok", "override_reason": "ZZBUG test"})
    with a.app.app_context():
        db = a.get_db()
        pend1 = [x[0] for x in a.pm_calibration_pending_children(db, CID, "bgceo", BG)]
        unit_locked = db.execute("SELECT locked_at FROM pm_calibration_sessions WHERE cycle_id=? AND tier='buceo' AND "
                                 "scope_key=?", (CID, CO)).fetchone()
    s.check("the BU CEO's lock is the unit's own", unit_locked and unit_locked[0], lk.status_code)
    s.check("the BG CEO's list still waits on the unit while a group is open", CO in pend0 and CO in pend1,
            (pend0, pend1))
    with a.app.test_request_context("/"):
        db = a.get_db()
        fpop = db.execute("SELECT * FROM users WHERE id IN (?,?,?)", tuple(F)).fetchall()
        s.check("Finance's HOD review is still open after the BU CEO's lock (it's the group's)",
                a._hod_review_closed(db, "pm", CID, fpop) is None, a._hod_review_closed(db, "pm", CID, fpop))
    lk2 = C_CFO.post("/performance/calibration/company/%s/%s/lock?grp=%d" % (BG, CO, GID),
                     data={"csrf_token": "tok", "override_reason": "ZZBUG test"})
    with a.app.test_request_context("/"):
        db = a.get_db()
        glock = db.execute("SELECT locked_at FROM pm_calibration_sessions WHERE cycle_id=? AND tier='buceo' AND "
                           "scope_key=?", (CID, "grp:%d" % GID)).fetchone()
        s.check("the CFO locks the group on its own", glock and glock[0], lk2.status_code)
        fpop = db.execute("SELECT * FROM users WHERE id IN (?,?,?)", tuple(F)).fetchall()
        msg = a._hod_review_closed(db, "pm", CID, fpop)
        s.check("...which closes Finance's HOD review, naming the group", msg and "ZZBUG Finance" in msg, msg)
        uf = db.execute("SELECT * FROM users WHERE id=?", (F[0],)).fetchone()
        eb = a.pm_effective_band(db, uf, CID, "ME")
        s.check("pm_effective_band reads the CFO's locked move", (eb or {}).get("band") == "OU", eb)
        tr = a.pm_calibration_trails(db, [uf], CID).get(F[0], [])
        s.check("...and the band trail shows it at the BU tier", any(t_.get("band") == "OU" for t_ in tr), tr)
        pend2 = [x[0] for x in a.pm_calibration_pending_children(db, CID, "bgceo", BG)]
        s.check("the BG CEO's list still waits on the COO's group (Tax has people, unlocked)", CO in pend2, pend2)
        keys = a.bu_unit_scope_keys(db, CID, BG, CO, "pm")
        s.check("...the unit's BU-level scopes are the BU CEO's and each group's", set(keys) == {
            CO, "grp:%d" % GID, "grp:%d" % GID2}, keys)
        rows_ = a._calib_lock_scopes(db, db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone(),
                                     db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())
        mine = [r_ for r_ in rows_ if r_["tier"] == "buceo" and r_["bg"] == BG]
        s.check("Lock status lists the unit and each group, with the group's calibrator and people",
                any(r_.get("group_id") == GID and r_["n"] == 4 and r_["role"] == "Calibrator" and r_["pm"]
                    for r_ in mine) and any(r_["scope"] == CO and r_["n"] == len(set(O + S + [CEO])) for r_ in mine),
                [(r_["scope"], r_["n"], r_["role"]) for r_ in mine])

    # ------------------------------------------------------------------ potential: the classic pages and the locks
    s.section("potential: the BU CEO's own pages leave the group out; the group locks through its own route")
    pv = C_CEO.post("/calibration/company/%s/%s/adjust" % (BG, CO),
                    data={"csrf_token": "tok", "subject_id": str(F[2]), "adjusted_band": "High",
                          "justification": "ZZBUG not theirs"})
    s.check("the BU CEO's potential page refuses a Finance person", H.one(
        a, "SELECT COUNT(*) FROM calibration_adjustments a JOIN calibration_sessions s ON s.id=a.session_id WHERE "
           "s.business_group=? AND a.subject_id=?", (BG, F[2])) == 0, pv.status_code)
    _real_pb, _real_sc = a._pot_calib_lock_breaches, a._calib_scope_scored
    a._pot_calib_lock_breaches = lambda *x_, **k_: {}
    a._calib_scope_scored = lambda *x_, **k_: True
    try:
        no = C_CEO.post("/calibration/bu-group/%d/lock" % GID, data={"csrf_token": "tok"})
        s.check("the BU CEO can't lock the CFO's group", no.status_code == 403, no.status_code)
        gl = C_CFO.post("/calibration/bu-group/%d/lock" % GID, data={"csrf_token": "tok"})
        ul = C_CEO.post("/calibration/company/%s/%s/lock" % (BG, CO), data={"csrf_token": "tok"})
    finally:
        a._pot_calib_lock_breaches, a._calib_scope_scored = _real_pb, _real_sc
    s.check("the CFO's potential lock is the group's", H.one(
        a, "SELECT locked_at FROM calibration_sessions WHERE cycle_id=? AND tier='buceo' AND scope_key=?",
        (CID, "grp:%d" % GID)) is not None, gl.status_code)
    s.check("...and the BU CEO's the unit's", H.one(
        a, "SELECT locked_at FROM calibration_sessions WHERE cycle_id=? AND tier='buceo' AND scope_key=?",
        (CID, CO)) is not None, ul.status_code)

    # ------------------------------------------------------------------ the Talent Box
    s.section("the BG CEO's Talent Box: the unit whole, each grouped person tagged, who has locked at BU level")
    with a.app.test_request_context("/"):
        db = a.get_db()
        ctx_tb = {"period": {"id": CID}, "cycle_id": CID}
        lv = a._tb_bu_level(db, ctx_tb, BG, CO)
        s.check("the BU level line: the BU CEO and the CFO locked, the COO not yet", [(x["who"], x["locked"]) for x in lv]
                == [("BU CEO", True), ("CFO", True), ("COO", False)], lv)
        s.check("...and a unit with no group has none", a._tb_bu_level(db, ctx_tb, BG, HQ) == [])
        by = a.bu_group_by(db, a.bu_group(db, GID))
        s.check("the calibrator's tag is the C-suite initials of their title (CFO from CHIEF FINANCIAL OFFICER; COO from "
                "Group Chief Operating Officer)", by["by"] == "CFO" and a.bu_group_by(db, a.bu_group(db, GID2))["by"]
                == "COO" and "ZZ Bug CFO" in by["by_title"], by)
    src = H.source(a)
    s.check("each Talent Box person carries the tag (bugrp), drawn on the name line and the list row",
            '"bugrp": None if grp else bugrp_of(r["user"])' in src and "if (p.bugrp && !tagBelow) ln.appendChild(tbByTag(p));"
            in JS and "if (p.bugrp) sub.appendChild(tbByTag(p));" in JS and '"bu_level": _tb_bu_level(' in src)
    s.check("the lock's confirm names who hasn't locked at BU level", "Not everyone at BU level has locked yet" in JS)
    s.check("the BU CEO's roster draws the grouped rows after their own, never under a filter: read only at 100 : 0, "
            "their own band (and both calls) when the split shares it",
            "!calFilterOn(d)) ? (d.others || []) : []" in JS and '"Calibrated by their BU group' in JS
            and 'tr.className = "is-other"' in JS and "if (o.movable && live && !d.locked)" in JS
            and "calCoText(o.by || \"Group\", o.cal_band, o.bu_level)" in JS)
    s.check("a calibrator's pills read Your groups (or Your calibrations beside units)", '"Your groups"' in JS
            and '"Your calibrations"' in JS)

    # ------------------------------------------------------------------ Help and the KB
    s.section("Help, the KB and the agents know it")
    s.check("Help has an answer for the BU CEO and one for the calibrator",
            "greyed out" in a.HELP_QA["bu_grp"][0] and "only some people" in a.HELP_QA["bu_grp_cal"][0])
    with a.app.app_context():
        db = a.get_db()
        kb = db.execute("SELECT body FROM kb_entries WHERE slug='bu-calibration-groups'").fetchone()
    s.check("the KB has the entry, conceptual (no ids or thresholds)", kb is not None and "calibrator" in kb[0]
            and not re.search(r"grp:|\d", kb[0]))
    _avail, _assist = a.ai_draft.review_agent_available, a._calib_assist_on
    a.ai_draft.review_agent_available = lambda: True   # the leader views need a reachable model, and the assistant on
    a._calib_assist_on = lambda u_: True               # (another suite may have left the platform's AI switch off)
    try:
        hj = C_CFO.get("/help/answers", query_string={"ep": "review_journey", "view": "bu", "stage": "calibration"}
                       ).get_json()
        hc = C_CEO.get("/help/answers", query_string={"ep": "review_journey", "view": "bu", "stage": "calibration"}
                       ).get_json()
    finally:
        a.ai_draft.review_agent_available, a._calib_assist_on = _avail, _assist
    s.check("the calibrator's Help in the BU view opens on their answer",
            hj and (hj.get("items") or [{}])[0].get("key") == "bu_grp_cal", (hj or {}).get("items"))
    s.check("...and the BU CEO's on theirs", hc and (hc.get("items") or [{}])[0].get("key") == "bu_grp",
            (hc or {}).get("items"))

    # ------------------------------------------------------------------ removing a group before anything moved
    s.section("a group nobody has started on can be removed; its departments go back to the BU CEO")
    rm = lambda: C_SU.post("/admin/leaders", data=dict(csrf_token="tok", action="bu_group_remove", bg=BG, tab="buceo",
                                                        company=CO, group_id=str(GID2)), follow_redirects=True)
    r = rm()
    s.check("not while the unit's BU CEO has locked (its people would join a locked calibration)",
            H.one(a, "SELECT active FROM calib_bu_groups WHERE id=?", (GID2,)) == 1 and "locked" in flashes(r),
            flashes(r)[:140])
    C_SU.post("/performance/calibration/company/%s/%s/unlock" % (BG, CO), data={"csrf_token": "tok",
                                                                               "remark": "ZZBUG test unlock"})
    C_SU.post("/calibration/company/%s/%s/unlock" % (BG, CO), data={"csrf_token": "tok", "remark": "ZZBUG test unlock"})
    s.check("(the super admin unlocks the unit, both axes, with a remark)", H.one(
        a, "SELECT COUNT(*) FROM pm_calibration_sessions WHERE cycle_id=? AND tier='buceo' AND scope_key=? AND "
           "locked_at IS NOT NULL", (CID, CO)) == 0 and H.one(
        a, "SELECT COUNT(*) FROM calibration_sessions WHERE cycle_id=? AND tier='buceo' AND scope_key=? AND "
           "locked_at IS NOT NULL", (CID, CO)) == 0)
    r = rm()
    s.check("the COO's group is retired (kept as a row, never deleted)",
            H.one(a, "SELECT active FROM calib_bu_groups WHERE id=?", (GID2,)) == 0, flashes(r)[:120])
    with a.app.test_request_context("/"):
        db = a.get_db()
        ut = db.execute("SELECT * FROM users WHERE id=?", (T[0],)).fetchone()
        s.check("...and Tax's people are the unit's again", a.bu_scope_key(db, ut) == CO)

    # ------------------------------------------------------------------ across units (Chris, 2026-10-22)
    s.section("a group across units of one business group, following one unit's PAT (Chris: \"can we do cross BU "
              "grouping?\"; picks: within one BG, one unit's PAT the admin picks)")
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?), (?,?)", (BG, U2, BG, U3))
        X2 = [person(db, "ZZ9BUG-X2%d" % i, U2, FIN) for i in range(1, 3)] + [person(db, "ZZ9BUG-Y2O", U2, OPS)]
        X3 = [person(db, "ZZ9BUG-X3%d" % i, U3, FIN) for i in range(1, 3)] + [person(db, "ZZ9BUG-Y3O", U3, OPS)]
        CEO2 = person(db, "ZZ9BUG-CE2", U2, OPS, title="Chief Executive Officer")
        for p_ in X2 + X3 + [CEO2]:
            co_ = U2 if p_ in X2 + [CEO2] else U3
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                       "business_group, company) VALUES (?,?,'ZZBUG KPI',100,'more','approved',?,?)", (CID, p_, BG, co_))
            db.execute("INSERT OR REPLACE INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'add')",
                       (CID, p_))
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, U2, CEO2))
        a._sync_buceo_primary(db, CEO2)
        db.execute("INSERT INTO pm_pbt_achievement(cycle_id, business_group, company, achievement_pct) VALUES "
                   "(?,?,?,60), (?,?,?,140)", (CID, BG, U2, CID, BG, U3))
        db.commit()
    xs = lambda **kw: C_SU.post("/admin/leaders", data=dict(dict(csrf_token="tok", action="bu_group_save", bg=BG,
                                                                tab="buceo", name="ZZBUG Group Finance",
                                                                calibrator_id=str(CFO)), **kw), follow_redirects=True)
    n0 = len(groups())
    r = xs(group_dept=["%s||%s" % (U2, FIN), "%s||%s" % (U3, FIN)])
    s.check("two units ticked: the admin must pick whose PAT the curve follows", len(groups()) == n0
            and "whose PAT curve" in flashes(r), flashes(r)[:120])
    r = xs(group_dept=["%s||%s" % (U2, FIN), "%s||%s" % (U3, FIN)], curve_of=CO)
    s.check("...one of the units ticked, never another", len(groups()) == n0 and "whose PAT curve" in flashes(r))
    r = xs(group_dept=["%s||%s" % (U2, FIN), "%s||%s" % (U2, OPS), "%s||%s" % (U3, FIN)], curve_of=U3)
    s.check("each unit keeps at least one department for its BU CEO", len(groups()) == n0
            and "Leave at least one department of ZZBUG Unit2" in flashes(r), flashes(r)[:140])
    r = xs(group_dept=["%s||%s" % (U2, FIN), "%s||%s" % (U3, FIN)], curve_of=U3)
    GX = next((g_[0] for g_ in groups() if g_[1] == "ZZBUG Group Finance"), None)
    s.check("the cross-unit group is made: Finance in both units, its curve U3's",
            GX and pairs_of(GX) == sorted([(U2, FIN), (U3, FIN)])
            and H.one(a, "SELECT company FROM calib_bu_groups WHERE id=?", (GX,)) == U3, flashes(r)[:140])
    with a.app.test_request_context("/"):
        db = a.get_db()
        pf2, po2 = (db.execute("SELECT * FROM users WHERE id=?", (x,)).fetchone() for x in (X2[0], X2[2]))
        s.check("a U2 Finance person's BU tier is the group's; U2 Ops stays with its BU CEO",
                a.bu_scope_key(db, pf2) == "grp:%d" % GX and a.bu_scope_key(db, po2) == U2)
        cfo = db.execute("SELECT * FROM users WHERE id=?", (CFO,)).fetchone()
        ce2 = db.execute("SELECT * FROM users WHERE id=?", (CEO2,)).fetchone()
        gx = a._pm_calib_resolve(db, cfo, "buceo", bg=BG, company=U3, grp=GX)
        s.check("the calibrator's scope is Finance from both units", {p_["id"] for p_ in gx["population"]}
                == {X2[0], X2[1], X3[0], X3[1]}, len(gx["population"]))
        cv = a.pm_curve_for_scope(db, gx)
        s.check("...on one curve: U3's PAT, said so", cv.get("follows") == U3 and cv["label"].startswith("Follows")
                and cv["pct"] == 140 and cv["key"] == a.pm_curve_for(db, CID, BG, U3)["key"], cv.get("label"))
        c2 = a._pm_calib_resolve(db, ce2, "buceo", bg=BG, company=U2)
        s.check("U2's BU CEO keeps U2's Ops and reads its Finance people, read only",
                {p_["id"] for p_ in c2["population"]} >= {X2[2]} and not ({p_["id"] for p_ in c2["population"]}
                                                                         & set(X2[:2]))
                and {p_["id"] for p_ in c2["others"]} == set(X2[:2]))
        rows_ = a._calib_lock_scopes(db, db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone(),
                                     db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())
        gr = [r_ for r_ in rows_ if r_.get("group_id") == GX]
        s.check("Lock status: the group once, both units, its 4 people", len(gr) == 1 and gr[0]["n"] == 4
                and sorted(gr[0]["companies"]) == [U2, U3], [(r_["scope"], r_["n"]) for r_ in gr])
        u2row = next((r_ for r_ in rows_ if r_["tier"] == "buceo" and r_["scope"] == U2), None)
        s.check("...and U2's own row counts only what its BU CEO calibrates", u2row and u2row["n"] == 2,
                u2row and u2row["n"])
        pend = [x[0] for x in a.pm_calibration_pending_children(db, CID, "bgceo", BG)]
        s.check("the BG CEO's list waits on both units while the group is open", U2 in pend and U3 in pend, pend)
        # the BG CEO locks U2 on the Talent Box: U2's Finance people freeze, U3's stay open, the group isn't closed
        db.execute("INSERT INTO talent_box_bu_locks(period_id, cycle_id, business_group, company) VALUES (?,?,?,?)",
                   (CID, CID, BG, U2))
        db.commit()
        _, e2 = a._pm_calib_apply(db, cfo, gx, "buceo", X2[0], "AE", "ZZ reason", dry_run=True)
        _, e3 = a._pm_calib_apply(db, cfo, gx, "buceo", X3[0], "AE", "ZZ reason", dry_run=True)
        s.check("one unit locked by the BG CEO: its people in the group can't be moved, the other unit's can",
                e2 is not None and e3 is None, (e2, e3))
        s.check("...and the group isn't closed until every unit it reaches is",
                a._bg_closed(db, "pm", CID, BG, "grp:%d" % GX) is None)
        db.execute("INSERT INTO talent_box_bu_locks(period_id, cycle_id, business_group, company) VALUES (?,?,?,?)",
                   (CID, CID, BG, U3))
        db.commit()
        s.check("...then it is", a._bg_closed(db, "pm", CID, BG, "grp:%d" % GX) is not None)
        db.execute("DELETE FROM talent_box_bu_locks WHERE business_group=? AND company IN (?,?)", (BG, U2, U3))
        db.commit()
    pg = C_SU.get("/admin/leaders?bg=%s&tab=buceo" % BG).get_data(as_text=True)
    PX = H.one(a, "SELECT panel_id FROM calib_bu_groups WHERE id=?", (GX,))
    _gl = re.search(r'id="bu-panel-%d".*?</tr>' % (PX or 0), pg, re.S)
    s.check("Leaders shows the group once, as a panel line: both units, the curve U3's",
            pg.count('id="bu-panel-%d"' % (PX or 0)) == 1 and _gl is not None and "ZZBUG Unit2" in _gl.group(0)
            and "ZZBUG Unit3" in _gl.group(0) and "Curve: ZZBUG Unit3's PAT" in _gl.group(0))
    r = xs(group_id=str(GX), group_dept=["%s||%s" % (U3, FIN)], curve_of=U3)
    s.check("nobody moved anyone yet, so U2's Finance can go back to its BU CEO", pairs_of(GX) == [(U3, FIN)],
            flashes(r)[:140])

    # ------------------------------------------------------------------ picked by name (Chris, 2026-10-22)
    s.section("people picked by name: this business group's only, one group each (Chris: \"add the pick by name feature "
              "too to the BU group\", \"only ... the person under this Business group\")")
    eid = lambda uid: H.one(a, "SELECT employee_id FROM users WHERE id=?", (uid,))
    outsider = H.one(a, "SELECT employee_id FROM users WHERE business_group!=? AND role!='admin' AND left_at IS NULL "
                        "AND COALESCE(is_demo,0)=0 AND employee_id IS NOT NULL LIMIT 1", (BG,))
    r = xs(group_id=str(GX), group_dept=["%s||%s" % (U3, FIN)], curve_of=U3, group_people=outsider or "")
    s.check("someone from another business group is refused", outsider and pairs_of(GX) == [(U3, FIN)]
            and not H.rows(a, "SELECT 1 FROM calib_bu_group_people WHERE group_id=?", (GX,))
            and "only its own people" in flashes(r), flashes(r)[:140])
    r = xs(group_id=str(GX), group_dept=["%s||%s" % (U3, FIN)], curve_of=U3, group_people=eid(F[1]))
    s.check("...and so is someone whose department sits in another group", not H.rows(
        a, "SELECT 1 FROM calib_bu_group_people WHERE group_id=?", (GX,)) and "in ZZBUG Finance" in flashes(r),
        flashes(r)[:140])
    r = xs(group_id=str(GX), group_dept=["%s||%s" % (U3, FIN)], curve_of=U3, group_people=eid(S[0]))
    with a.app.test_request_context("/"):
        db = a.get_db()
        us0 = db.execute("SELECT * FROM users WHERE id=?", (S[0],)).fetchone()
        s.check("a Sales person of the first unit picked by name joins the group, whatever their department",
                [r_[0] for r_ in H.rows(a, "SELECT user_id FROM calib_bu_group_people WHERE group_id=?", (GX,))] == [S[0]]
                and a.bu_scope_key(db, us0) == "grp:%d" % GX
                and CO in a.bu_group(db, GX)["units"], flashes(r)[:140])
        us1 = db.execute("SELECT * FROM users WHERE id=?", (S[1],)).fetchone()
        s.check("...their colleague in the same department stays with the BU CEO", a.bu_scope_key(db, us1) == CO)
        pl = a._pm_calib_resolve(db, db.execute("SELECT * FROM users WHERE id=?", (CFO,)).fetchone(), "buceo",
                                 bg=BG, company=U3, grp=GX)
        s.check("...and the calibrator's population takes them", S[0] in {p_["id"] for p_ in pl["population"]})

    # ------------------------------------------------------------------ the split is retired (2026-10-26)
    s.section("the split with the BU CEO is retired (Chris, 2026-10-26: calibrators first, shared by weights): a split "
              "posted is ignored, the BU CEO reads; a tie now takes the lower band (test_bu_panels has the panels)")
    PB = a.PM_BAND_ORDER
    s.check("the blend: each band as its place, weighted, rounded", a.bu_blend("OU", "ME", 50, PB) == "AE"
            and a.bu_blend("OU", "BE", 70, PB) == "AE" and a.bu_blend("UA", "OU", 75, PB) == "BE")
    s.check("...exactly halfway takes the lower band (Chris: \"ME (average of ... ME, and ... AE\")",
            a.bu_blend("ME", "AE", 50, PB) == "ME" and a.bu_blend("AE", "ME", 50, PB) == "ME"
            and a.bu_blend("Low", "Mid", 50, ["Low", "Mid", "High"]) == "Low")
    s.check("...one call in: that one", a.bu_blend(None, "ME", 50, PB) == "ME" and a.bu_blend("AE", None, 50, PB) == "AE")
    r = xs(group_id=str(GX), group_dept=["%s||%s" % (U3, FIN)], curve_of=U3, group_people=eid(S[0]), split="50")
    with a.app.test_request_context("/"):
        db = a.get_db()
        ceo = db.execute("SELECT * FROM users WHERE id=?", (CEO,)).fetchone()
        cx = a._pm_calib_resolve(db, ceo, "buceo", bg=BG, company=CO)
        _, e50 = a._pm_calib_apply(db, ceo, cx, "buceo", S[0], "OU", "ZZ reason", dry_run=True)
        o0 = next((o_ for o_ in a._pm_calib_assist_overview(db, ceo, cx, "buceo", {"bg": BG, "company": CO})["data"][
            "others"] if o_["id"] == S[0]), {})
    s.check("a split posted is ignored: stored 100, the BU CEO can't band the picked person, their row read only",
            H.one(a, "SELECT split FROM calib_bu_groups WHERE id=?", (GX,)) == 100 and e50 is not None
            and o0 and not o0.get("movable"), (flashes(r)[:120], e50, o0.get("movable")))

    # ------------------------------------------------------------------ the Group Chief, on BG CEOs (Chris, 2026-10-22)
    s.section("the Group Chief's set up on Leaders › BG CEOs: a temporary BG line, its panels, the split, the BG CEO "
              "reads at 100 : 0")
    gcr = C_SU.post("/admin/performance/calibration-groups", data={"csrf_token": "tok", "action": "create",
                                                                   "name": "ZZBUG GC Group", "calibrator": eid(COO),
                                                                   "return_bg": BG})
    GC = H.one(a, "SELECT id FROM pm_calibration_groups WHERE name='ZZBUG GC Group'")
    s.check("made from BG CEOs, it comes back there with its panel open", GC and "/admin/leaders" in (
        gcr.headers.get("Location") or "") and "tab=bgceo" in gcr.headers.get("Location", "")
        and gcr.headers.get("Location", "").endswith("#group-%d" % GC), gcr.headers.get("Location"))
    C_SU.post("/admin/performance/calibration-groups", data={"csrf_token": "tok", "action": "paste_ids",
                                                              "group_id": str(GC), "ids": eid(O[0]), "return_bg": BG})
    pgb = C_SU.get("/admin/leaders?bg=%s&tab=bgceo" % BG).get_data(as_text=True)
    _gl = re.search(r'id="gc-group-%d".*?</tr>' % GC, pgb, re.S)
    s.check("BG CEOs lists it as a line, never a business group: Group Chief, 1 person, the split, Manage",
            _gl is not None and "Group Chief group" in _gl.group(0) and "1 person" in _gl.group(0)
            and "Split Group Chief 100 : BG CEO 0" in _gl.group(0) and 'data-panel-open="grp-%d"' % GC in _gl.group(0))
    s.check("...+ Add a Group Chief group at the title's right end, and the group's panel with the split",
            "+ Add a Group Chief group" in pgb[pgb.find('class="ld-bu-head"'):][:400] and 'id="group-%d"' % GC in pgb
            and 'name="chief_share"' in pgb and 'name="return_bg" value="%s"' % BG in pgb)
    with a.app.test_request_context("/"):
        db = a.get_db()
        su = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        bx = a._pm_calib_resolve(db, su, "bgceo", bg=BG)
        _, eg = a._pm_calib_apply(db, su, bx, "bgceo", O[0], "AE", "ZZ reason", dry_run=True)
        s.check("at 100 : 0 the BG CEO's tier can't move the Group Chief's person", eg and "Group Chief" in eg, eg)
    C_SU.post("/admin/performance/calibration-groups", data={"csrf_token": "tok", "action": "set_mode",
                                                              "group_id": str(GC), "chief_share": "60",
                                                              "remark": "ZZBUG split", "return_bg": BG})
    with a.app.test_request_context("/"):
        db = a.get_db()
        m = a.calib_group_mode(GC)
        s.check("the split saved as the Group Chief's share: 60 : 40, a blend", m["mode"] == "blend" and m["chief"] == 60
                and a.gc_chief_share(m) == 60, m)
        su = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        bx = a._pm_calib_apply  # noqa
        _, eg2 = a._pm_calib_apply(db, su, a._pm_calib_resolve(db, su, "bgceo", bg=BG), "bgceo", O[0], "AE",
                                   "ZZ reason", dry_run=True)
        s.check("...and then the BG CEO can band them too (both count)", eg2 is None or "Group Chief" not in eg2, eg2)

    # ------------------------------------------------------------------ the super admin's Unlock (Chris, 2026-10-23)
    s.section("Unlock for the groups, the super admin's only: a BU group's two axes (its panel, Lock status), a Group "
              "Chief group whole")

    def _lock_bu(gid, pm=True, pot=True):
        with a.app.test_request_context("/"):
            db = a.get_db()
            key, lab = "grp:%d" % gid, "ZZBUG lock"
            if pm:
                ss = a._pm_calib_get_or_create_session(db, CID, "buceo", key, BG, lab)
                db.execute("UPDATE pm_calibration_sessions SET locked_at=datetime('now'), locked_by=? WHERE id=?",
                           (SU["id"], ss["id"]))
            if pot:
                ss = a._get_or_create_calibration_session(db, CID, "buceo", key, BG, lab)
                db.execute("UPDATE calibration_sessions SET locked_at=datetime('now'), locked_by=? WHERE id=?",
                           (SU["id"], ss["id"]))
            db.commit()

    def _bu_locked(gid):
        return (H.one(a, "SELECT COUNT(*) FROM pm_calibration_sessions WHERE cycle_id=? AND tier='buceo' AND scope_key=? "
                         "AND locked_at IS NOT NULL", (CID, "grp:%d" % gid)),
                H.one(a, "SELECT COUNT(*) FROM calibration_sessions WHERE cycle_id=? AND tier='buceo' AND scope_key=? "
                         "AND locked_at IS NOT NULL", (CID, "grp:%d" % gid)))

    _lock_bu(GID)
    s.check("(the CFO's group locked on both axes)", _bu_locked(GID) == (1, 1), _bu_locked(GID))
    pgu = C_SU.get("/admin/leaders?bg=%s&tab=buceo" % BG).get_data(as_text=True)
    _pn = pgu[pgu.find('data-panel="grp-%d"' % GID):] if 'data-panel="grp-%d"' % GID in pgu else pgu
    s.check("the group's panel lists its locks this cycle, ONE Unlock for both axes (2026-11-07), 'Unlocks together' on the other",
            "Locks this cycle" in pgu and 'form="ld-grp-un-%d"' % GID in pgu and 'id="ld-grp-un-%d"' % GID in pgu
            and 'form="ld-grp-unpm-%d"' % GID not in pgu and 'form="ld-grp-unpot-%d"' % GID not in pgu
            and "Unlock both" in pgu and "Unlocks together" in pgu)
    _f = re.search(r'<form[^>]*id="ld-grp-un-%d"[^>]*>' % GID, pgu, re.S)
    s.check("...each double-confirmed with the super admin's remark, back to the panel",
            _f is not None and "data-confirm=" in _f.group(0) and "data-confirm-reason" in _f.group(0)
            and ("grp=%d" % GID) in _f.group(0), _f.group(0)[:200] if _f else None)
    s.check("...and every Unlock in the templates sits behind the super admin's check",
            TPL.count("{% if nav_is_super %}{% for c in p.cals %}{% set U = unlock_box(") == 1
            and "if nav_is_super else none" in TPL and 'form="ld-grp-un-{{ c.gid }}"' in TPL)
    back = "/admin/leaders?tab=buceo&bg=%s&panel=grp-%d" % (BG, GID)
    r = C_SU.post("/performance/calibration/company/%s/%s/unlock?grp=%d" % (BG, CO, GID),
                  data={"csrf_token": "tok", "next": back})
    s.check("no remark, no unlock", _bu_locked(GID) == (1, 1), r.status_code)
    r = C_CFO.post("/performance/calibration/company/%s/%s/unlock?grp=%d" % (BG, CO, GID),
                   data={"csrf_token": "tok", "next": back, "remark": "ZZBUG"})
    r2 = C_CFO.post("/calibration/bu-group/%d/unlock" % GID, data={"csrf_token": "tok", "next": back, "remark": "ZZBUG"})
    s.check("the calibrator can't unlock their own group, either axis", r.status_code == 403 and r2.status_code == 403
            and _bu_locked(GID) == (1, 1), (r.status_code, r2.status_code))
    r = C_SU.post("/performance/calibration/company/%s/%s/unlock?grp=%d" % (BG, CO, GID),
                  data={"csrf_token": "tok", "next": back, "remark": "ZZBUG unlock both"})
    s.check("the super admin unlocks BOTH axes with one remark (2026-11-07: one Unlock), back to the group's panel",
            _bu_locked(GID) == (0, 0) and "panel=grp-%d" % GID in r.headers.get("Location", "")
            and "/admin/leaders" in r.headers.get("Location", ""), (r.status_code, r.headers.get("Location")))
    _lock_bu(GID)
    r = C_SU.post("/calibration/bu-group/%d/unlock" % GID,
                  data={"csrf_token": "tok", "next": back, "remark": "ZZBUG unlock from the potential URL"})
    s.check("...the potential URL is the same unlock: both axes", _bu_locked(GID) == (0, 0)
            and "/admin/leaders" in r.headers.get("Location", ""), (r.status_code, r.headers.get("Location")))
    s.check("...each written to the audit trail with the remark", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE user_id=? AND action IN ('calibration_unlock_both') "
           "AND detail LIKE '%ZZBUG unlock%'", (SU["id"],)) == 2)
    _lock_bu(GID)
    r = C_SU.post("/calibration/bu-group/%d/unlock" % GID,
                  data={"csrf_token": "tok", "next": "https://example.com/x", "remark": "ZZBUG off-site"})
    s.check("a next that isn't an admin page goes to Lock status", r.headers.get("Location", "").endswith(
        "/admin/calibration/locks"), r.headers.get("Location"))
    pgu2 = C_SU.get("/admin/leaders?bg=%s&tab=buceo" % BG).get_data(as_text=True)
    s.check("unlocked, the panel reads Open on both and offers no Unlock", 'id="ld-grp-un-%d"' % GID not in pgu2)
    _lock_bu(GID, pot=False)
    pls = C_SU.get("/admin/calibration/locks?bg=%s" % BG).get_data(as_text=True)
    _gname = html.escape(H.one(a, "SELECT name FROM calib_bu_groups WHERE id=?", (GID,)), quote=False)
    _row = re.search(r'<th scope="row">' + re.escape(_gname) + r'<.*?</tr>', pls, re.S)
    s.check("Lock status: the group's locked performance has the Unlock, its open potential none",
            _row is not None and _row.group(0).count('class="adm-lock-un"') == 1
            and ("grp=%d" % GID) in _row.group(0) and "data-confirm-reason" in _row.group(0),
            _row.group(0)[:300] if _row else None)
    r = C_SU.post("/performance/calibration/company/%s/%s/unlock?grp=%d" % (BG, CO, GID),
                  data={"csrf_token": "tok", "next": "/admin/calibration/locks?bg=%s" % BG.replace(" ", "+"),
                        "remark": "ZZBUG unlock from lock status"})
    s.check("...and it unlocks back to Lock status", _bu_locked(GID) == (0, 0)
            and "/admin/calibration/locks" in r.headers.get("Location", ""), r.headers.get("Location"))

    def _gc_state():
        return (H.one(a, "SELECT COUNT(*) FROM pm_calibration_sessions WHERE cycle_id=? AND tier='group' AND scope_key=? "
                         "AND locked_at IS NOT NULL", (CID, str(GC))),
                H.one(a, "SELECT COUNT(*) FROM calibration_sessions WHERE cycle_id=? AND tier='group' AND scope_key=? "
                         "AND locked_at IS NOT NULL", (CID, str(GC))),
                H.one(a, "SELECT COUNT(*) FROM pm_group_locks WHERE cycle_id=? AND group_id=?", (CID, GC)),
                H.one(a, "SELECT COUNT(*) FROM pot_group_locks WHERE cycle_id=? AND group_id=?", (CID, GC)))

    with a.app.test_request_context("/"):
        db = a.get_db()
        ps = a._pm_calib_get_or_create_session(db, CID, "group", str(GC), BG, "ZZBUG GC Group")
        qs = a._get_or_create_calibration_session(db, CID, "group", str(GC), BG, "ZZBUG GC Group")
        db.execute("UPDATE pm_calibration_sessions SET locked_at=datetime('now'), locked_by=? WHERE id=?", (COO, ps["id"]))
        db.execute("UPDATE calibration_sessions SET locked_at=datetime('now'), locked_by=? WHERE id=?", (COO, qs["id"]))
        db.execute("INSERT INTO pm_group_locks(cycle_id, group_id, subject_id, band, locked_by) VALUES (?,?,?,?,?)",
                   (CID, GC, O[0], "ME", COO))
        db.execute("INSERT INTO pot_group_locks(cycle_id, group_id, subject_id, band, locked_by) VALUES (?,?,?,?,?)",
                   (CID, GC, O[0], "Mid", COO))
        db.commit()
    s.check("(the Group Chief's group locked: both axes, and one person one by one)", _gc_state() == (1, 1, 1, 1),
            _gc_state())
    pgb2 = C_SU.get("/admin/leaders?bg=%s&tab=bgceo" % BG).get_data(as_text=True)
    _gp = pgb2[pgb2.find('id="group-%d"' % GC):]
    _gp = _gp[:_gp.find("</footer>")]
    s.check("its panel on BG CEOs lists the locks and the person, with Unlock the group",
            "Locks this cycle" in _gp and "1 person locked" in _gp and "Unlock the group" in _gp
            and 'name="action" value="unlock"' in _gp, len(_gp))
    gcu = "/admin/performance/calibration-groups"
    C_SU.post(gcu, data={"csrf_token": "tok", "action": "unlock", "group_id": str(GC), "return_bg": BG})
    s.check("no remark, no unlock", _gc_state() == (1, 1, 1, 1), _gc_state())
    rg = C_SU.post(gcu, data={"csrf_token": "tok", "action": "unlock", "group_id": str(GC), "return_bg": BG,
                              "remark": "ZZBUG GC unlock"})
    s.check("the super admin unlocks it whole: both axes and the one-by-one locks, back to its panel",
            _gc_state() == (0, 0, 0, 0) and rg.headers.get("Location", "").endswith("#group-%d" % GC)
            and "tab=bgceo" in rg.headers.get("Location", ""), (_gc_state(), rg.headers.get("Location")))
    s.check("...the Group Chief's call stays as they left it", H.one(
        a, "SELECT COUNT(*) FROM pm_calibration_sessions WHERE cycle_id=? AND tier='group' AND scope_key=?",
        (CID, str(GC))) == 1)
    s.check("...written to the audit trail with the remark", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE user_id=? AND action='pm_calib_group_unlock' AND detail LIKE "
           "'ZZBUG GC Group: unlocked (performance, potential, 1 person locked one by one)%ZZBUG GC unlock%'",
        (SU["id"],)) == 1)
    rg2 = C_SU.post(gcu, data={"csrf_token": "tok", "action": "unlock", "group_id": str(GC), "return_bg": BG,
                               "remark": "ZZBUG again"}, follow_redirects=True)
    s.check("unlocking an open group says so", "ZZBUG GC Group isn't locked" in html.unescape(flashes(rg2)),
            flashes(rg2)[-120:])
    s.check("a BU CEO can't reach it", C_CEO.post(gcu, data={"csrf_token": "tok", "action": "unlock",
                                                              "group_id": str(GC), "remark": "x"}).status_code in (302, 403)
            and _gc_state() == (0, 0, 0, 0))
finally:
    a._pm_calib_lock_breaches = _real_breaches
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        db.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(CELLS)),
                   (CID,) + CELLS)
        db.executemany("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", WIN0)
        db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN ('pm','calibration','review')", (CID,))
        db.executemany("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", MOD0)
        if C_BGA:
            db.execute("UPDATE users SET admin_bg=? WHERE id=?", (BGA0, BGA["id"]))
        db.commit()

sys.exit(s.done())
