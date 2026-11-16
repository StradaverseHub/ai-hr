"""Calibration panels: calibrators first, shared people by weights -- 2026-10-26, Chris.

  "the first step should be setting up the calibrator for BU group, once this is defined, only go to next step to set up
   the group for these calibrator and how the ratio work ... (each calibrator needs to have min one person, same person
   can be assign to more than one calibrator) ... if calibrator A and B takes the finance, then there will be option for
   this finance group to set the weightage between calibrator A and B. And for BGCEO talent profile view, it should show
   for the calibrated band, (calibrator name, weigh, final band); e.g. ... ME (average of Calibrator A (50%) - ME, and
   Calibrator B (50%) - AE"
  Canvas Tswrw7q9HMAVj8ZfFRKRVT. Access: the super admin's (leaders.calib_groups, ticked for no role).

What it holds:
  * the blend: each band as its place, weighted, rounded, exactly halfway the LOWER band; one band in, that one;
    equal default weights adding up to 100
  * the save: every rule (a name, units of this BG, the curve one of them, calibrators who are active, each with
    somebody, departments and names from the units ticked, weights 1-99 adding up to 100, one panel a department and a
    person, a lone calibrator keeps the old group's two rules) refused with nothing written; a BG admin can't
  * step 3's preview: the server's own plan of the form (singles, shared sets, default and given weights), or its error
  * who calibrates whom: a name wins over the department; one person under several calibrators; each calibrator's
    population; the BU CEO's leaves them all out and reads them, tagged with every calibrator and their weights
  * the bands, end to end through the real routes: nothing counts until locked; one lock, that band; all locked, the
    weighted blend (ME and AE at 50:50 = ME; OU, AE, ME at 20:20:60 = AE); a calibrator who locked without moving
    someone counts the band that came in; pm_effective_band, the rating record and the band trail agree; the HOD
    review closes on any calibrator's lock; the potential axis blends the same way
  * what each sees: the calibrator's row carries the others' weights and bands and the BU level they make; the BG CEO's
    person view lists each calibrator, weight and band and the band they make
  * after a lock only the name changes; a panel with moves can't be removed, a fresh one can (its people go back);
    the BU CEO can be one of several calibrators; several calibrators can take a whole unit, one can't
  * the picker narrows to the units ticked; the page: + Add a calibrator, each panel a line with its shared weights;
    an old group without a panel becomes a panel of one on the migration
"""
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Calibration panels: calibrators first, shared by weights")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG, U1, U2, U3 = "ZZBUP Group", "ZZBUP Living", "ZZBUP Trading", "ZZBUP Bedding"
OTHER_BG = "ZZBUP Elsewhere"
SN, FIN, HR, OPS = "ZZBUP Sales North", "ZZBUP Finance", "ZZBUP HR", "ZZBUP Ops"
TS, LOG, PROD = "ZZBUP Sales", "ZZBUP Logistics", "ZZBUP Production"
CELLS = ("pm_buceo", "pot_buceo", "tb_bgceo", "pm_hod", "pot_hod")
PB = None


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BUP-%'")]
    for st, at in (("pm_calibration_sessions", "pm_calibration_adjustments"),
                   ("calibration_sessions", "calibration_adjustments")):
        for (sid,) in db.execute("SELECT id FROM %s WHERE business_group IN (?,?)" % st, (BG, OTHER_BG)).fetchall():
            db.execute("DELETE FROM %s WHERE session_id=?" % at, (sid,))
            db.execute("DELETE FROM %s WHERE id=?" % st, (sid,))
    db.execute("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BG,))
    for (g_,) in db.execute("SELECT id FROM calib_bu_groups WHERE business_group IN (?,?)", (BG, OTHER_BG)).fetchall():
        for t_ in ("calib_bu_group_units", "calib_bu_group_people", "calib_bu_group_depts", "calib_bu_group_left"):
            db.execute("DELETE FROM %s WHERE group_id=?" % t_, (g_,))
    db.execute("DELETE FROM calib_bu_groups WHERE business_group IN (?,?)", (BG, OTHER_BG))
    for (p_,) in db.execute("SELECT id FROM calib_bu_panels WHERE business_group IN (?,?)", (BG, OTHER_BG)).fetchall():
        db.execute("DELETE FROM calib_bu_panel_units WHERE panel_id=?", (p_,))
        db.execute("DELETE FROM calib_bu_panel_weights WHERE panel_id=?", (p_,))
    db.execute("DELETE FROM calib_bu_panels WHERE business_group IN (?,?)", (BG, OTHER_BG))
    db.execute("DELETE FROM pm_pbt_achievement WHERE business_group=?", (BG,))
    db.execute("DELETE FROM calib_dept_filter WHERE business_group IN (?,?)", (BG, OTHER_BG))
    db.execute("DELETE FROM calib_jg_filter WHERE business_group IN (?,?)", (BG, OTHER_BG))
    try:
        db.execute("DELETE FROM calib_cal_filter WHERE business_group IN (?,?)", (BG, OTHER_BG))
    except Exception:   # noqa: BLE001 -- before the migration made it
        pass
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
        db.execute("UPDATE users SET manager_id=NULL WHERE manager_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM activity_log WHERE action IN ('bu_panel_save','bu_panel_remove','bu_group_save',"
               "'bu_group_remove') AND detail LIKE 'ZZBUP%'")
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, OTHER_BG))
    db.commit()


def person(db, eid, co, dept, title="ZZBUP Officer", bg=BG, left=False, name=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, left_at, is_demo) VALUES (?,?, 'x', 'user', ?,?,?,?,?, '15', ?, 0)",
                      (eid.lower(), name or ("ZZ Bup " + eid.split("-", 1)[1]), eid, bg, co, dept, title,
                       "2026-01-01" if left else None)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    PB = a.PM_BAND_ORDER
    CID = a.active_cycle_id(db)
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    WIN0 = [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows WHERE cycle_id=? "
                                         "AND cell IN (%s)" % ",".join("?" * len(CELLS)), (CID,) + CELLS)]
    MOD0 = [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=? AND "
                                         "module_key IN ('pm','calibration','review','tm')", (CID,))]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))   # the BU level is the Year-End's
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(CELLS)), (CID,) + CELLS)
    for c_ in CELLS:
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                   (CID, c_, "2020-01-01 00:00:00", "2099-12-31 15:59:00"))
    for m_ in ("pm", "calibration", "review", "tm"):
        db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, m_))
    for co in (U1, U2, U3):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, co))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (OTHER_BG, "ZZBUP Far Unit"))
    CEO1 = person(db, "ZZ9BUP-CEO1", U1, "ZZBUP Mgmt", title="Chief Executive Officer")
    CEO2 = person(db, "ZZ9BUP-CEO2", U2, "ZZBUP Mgmt", title="Chief Executive Officer")
    CEO3 = person(db, "ZZ9BUP-CEO3", U3, "ZZBUP Mgmt", title="Chief Executive Officer")
    A = person(db, "ZZ9BUP-A", U1, "ZZBUP Sales Mgmt", title="Head of Sales", name="ZZ Bup Alpha")
    B = person(db, "ZZ9BUP-B", U2, "ZZBUP Sales Mgmt", title="Head of Sales Trading", name="ZZ Bup Bravo")
    C = person(db, "ZZ9BUP-C", U1, "ZZBUP Finance Mgmt", title="CHIEF FINANCIAL OFFICER", name="ZZ Bup Charlie")
    D = person(db, "ZZ9BUP-D", U3, "ZZBUP Mgmt", title="Head of Production", name="ZZ Bup Delta")
    LEFT = person(db, "ZZ9BUP-LFT", U1, "ZZBUP Sales Mgmt", left=True)
    FAR = person(db, "ZZ9BUP-FAR", "ZZBUP Far Unit", "ZZBUP Far", bg=OTHER_BG)
    SN1, SN2, SN3 = (person(db, "ZZ9BUP-SN%d" % i, U1, SN) for i in (1, 2, 3))
    F1, F2 = (person(db, "ZZ9BUP-F%d" % i, U1, FIN) for i in (1, 2))
    H1, H2 = (person(db, "ZZ9BUP-H%d" % i, U1, HR) for i in (1, 2))
    O1, O2 = (person(db, "ZZ9BUP-O%d" % i, U1, OPS) for i in (1, 2))
    TS1, TS2 = (person(db, "ZZ9BUP-TS%d" % i, U2, TS) for i in (1, 2))
    TF1 = person(db, "ZZ9BUP-TF1", U2, FIN)
    L1 = person(db, "ZZ9BUP-L1", U2, LOG)
    P1, P2 = (person(db, "ZZ9BUP-P%d" % i, U3, PROD) for i in (1, 2))
    HRHOD = person(db, "ZZ9BUP-HRHOD", U1, "ZZBUP HR Mgmt", title="Head of HR")
    BGC = person(db, "ZZ9BUP-BGC", U1, "ZZBUP Group Mgmt", title="Group Chief Executive Officer", name="ZZ Bup Boss")
    db.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (BG, BGC))
    for p_ in (H1, H2):
        db.execute("UPDATE users SET hod_id=? WHERE id=?", (HRHOD, p_))
    PEOPLE = [SN1, SN2, SN3, F1, F2, H1, H2, O1, O2, TS1, TS2, TF1, L1, P1, P2]
    for p_ in PEOPLE + [CEO1, CEO2, CEO3, A, B, C, D]:
        co_ = db.execute("SELECT company FROM users WHERE id=?", (p_,)).fetchone()[0]
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
                   "company) VALUES (?,?,'ZZBUP KPI',100,'more','approved',?,?)", (CID, p_, BG, co_))
        db.execute("INSERT OR REPLACE INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'add')", (CID, p_))
    for co, ceo in ((U1, CEO1), (U2, CEO2), (U3, CEO3)):
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, co, ceo))
        a._sync_buceo_primary(db, ceo)
    db.commit()
EID = {}
with a.app.app_context():
    for uid in (A, B, C, D, CEO1, CEO3, LEFT, FAR, SN3, H1, F1, TS1, P1):
        EID[uid] = H.one(a, "SELECT employee_id FROM users WHERE id=?", (uid,))
C_SU = H.client_as(a, SU["id"])
C_BGA = H.client_as(a, BGA["id"]) if BGA else None
C_A, C_B, C_C = H.client_as(a, A), H.client_as(a, B), H.client_as(a, C)


def flashes(r):
    return html.unescape(" ".join(re.findall(r'class="flash[^"]*"[^>]*>(.*?)<', r.get_data(as_text=True), re.S)))


def form(name="ZZBUP Sales and shared", units=(U1, U2), curve=U1, cals=None, depts=None, people=None, weights=None,
         panel_id=None, action="bu_panel_save"):
    """The panel form as the page posts it: Employee IDs for the calibrators and names, unit||department ticks, and a
    w:<eid+eid>:<eid> box per shared calibrator."""
    cals = cals if cals is not None else [A, B, C]
    d = {"csrf_token": "tok", "action": action, "bg": BG, "tab": "buceo", "name": name,
         "panel_unit": list(units), "curve_of": curve, "cal_eids": ",".join(EID[c] for c in cals)}
    for c, ds in (depts or {}).items():
        d["dept_" + EID[c]] = ["%s||%s" % pd for pd in ds]
    for c, ps in (people or {}).items():
        d["people_" + EID[c]] = ",".join(EID[x] for x in ps)
    for key, ws in (weights or {}).items():
        combo = "+".join(sorted(EID[c] for c in key))
        for c, w in ws.items():
            d["w:%s:%s" % (combo, EID[c])] = str(w)
    if panel_id:
        d["panel_id"] = str(panel_id)
    return d


def post(client, data, follow=True):
    return client.post("/admin/leaders", data=data, follow_redirects=follow)


def panels():
    return H.rows(a, "SELECT id, name, active FROM calib_bu_panels WHERE business_group=? ORDER BY id", (BG,))


def cal_rows(pid):
    return H.rows(a, "SELECT id, calibrator_id, active FROM calib_bu_groups WHERE panel_id=? ORDER BY id", (pid,))


DEPTS = {A: [(U1, SN), (U1, FIN), (U1, HR)], B: [(U2, TS), (U1, HR)], C: [(U1, FIN), (U2, FIN), (U1, HR)]}
NAMED = {B: [SN3]}
_real_breaches = a._pm_calib_lock_breaches
try:
    # ------------------------------------------------------------------ the blend
    s.section("the blend: each band as its place, weighted, rounded; exactly halfway the lower band")
    s.check("ME and AE at 50:50 = ME (Chris's example: halfway takes the lower)",
            a.bu_blend_n([("ME", 50), ("AE", 50)], PB) == "ME" and a.bu_blend_n([("AE", 50), ("ME", 50)], PB) == "ME")
    s.check("OU, AE and ME at 20:20:60 = AE ((5x20 + 4x20 + 3x60) / 100 = 3.6)",
            a.bu_blend_n([("OU", 20), ("AE", 20), ("ME", 60)], PB) == "AE")
    s.check("rounded to the nearer band: OU 70 / BE 30 = AE (4.4), UA 25 / OU 75 = AE (4.0)",
            a.bu_blend_n([("OU", 70), ("BE", 30)], PB) == "AE" and a.bu_blend_n([("UA", 25), ("OU", 75)], PB) == "AE")
    s.check("one band in: that one, whatever its weight", a.bu_blend_n([(None, 60), ("BE", 40)], PB) == "BE"
            and a.bu_blend_n([("OU", 20)], PB) == "OU" and a.bu_blend_n([(None, 50)], PB) is None)
    s.check("the potential's three bands the same way: Mid and High at 50:50 = Mid, Low 20 / High 80 = High",
            a.bu_blend_n([("Mid", 50), ("High", 50)], ["Low", "Mid", "High"]) == "Mid"
            and a.bu_blend_n([("Low", 20), ("High", 80)], ["Low", "Mid", "High"]) == "High")
    s.check("equal default weights add up to 100: 50/50, 34/33/33",
            list(a.bu_equal_weights([7, 3]).values()) == [50, 50] and a.bu_equal_weights([1, 2, 3]) == {1: 34, 2: 33, 3: 33})

    # ------------------------------------------------------------------ who may set one up
    s.section("only the super admin sets a panel up")
    with a.app.app_context():
        _m = a.ADMIN_ACCESS_MAP["admin_leaders"]["map"]
        s.check("the three actions sit on leaders.calib_groups on the access map, as the old group's did",
                all(_m.get(k) == _m["bu_group_save"] for k in ("bu_panel_save", "bu_panel_remove", "bu_panel_preview"))
                and "leaders.calib_groups" in str(_m["bu_group_save"]), {k: _m.get(k) for k in ("bu_panel_save",)})
    if C_BGA:
        with a.app.app_context():
            db = a.get_db()
            BGA0 = db.execute("SELECT admin_bg FROM users WHERE id=?", (BGA["id"],)).fetchone()[0]
            db.execute("UPDATE users SET admin_bg=? WHERE id=?", (BG, BGA["id"]))
            db.commit()
        rb = post(C_BGA, form(depts=DEPTS, people=NAMED))
        s.check("a BG admin's save writes nothing", not panels(), (rb.status_code, flashes(rb)[:120]))
        with a.app.app_context():
            db = a.get_db()
            db.execute("UPDATE users SET admin_bg=? WHERE id=?", (BGA0, BGA["id"]))
            db.commit()

    # ------------------------------------------------------------------ every rule of the save
    s.section("every rule of the save refuses with nothing written")
    cases = [
        ("a name", form(name="", depts=DEPTS, people=NAMED), "Name the panel"),
        ("at least one unit", form(units=(), depts=DEPTS, people=NAMED), "at least one business unit"),
        ("units of this business group only", form(units=(U1, "ZZBUP Far Unit"), depts=DEPTS, people=NAMED),
         "Pick the business units"),
        ("the curve one of the units ticked", form(curve=U3, depts=DEPTS, people=NAMED), "whose PAT curve"),
        ("at least one calibrator", form(cals=[], depts={}), "at least one calibrator"),
        ("a calibrator who is active", form(cals=[A, LEFT], depts={A: DEPTS[A], LEFT: [(U1, OPS)]}), "isn't anyone active"),
        ("each calibrator with somebody", form(cals=[A, B], depts={A: DEPTS[A]}), "has nobody yet"),
        ("departments from the units ticked", form(units=(U1,), cals=[A], depts={A: [(U2, TS)]}),
         "departments from the units ticked"),
        ("people by name from the units ticked", form(units=(U1,), cals=[A], depts={A: [(U1, SN)]},
                                                     people={A: [TS1]}), "people by name from the units ticked"),
        ("weights adding up to 100", form(depts=DEPTS, people=NAMED, weights={(A, C): {A: 30, C: 30}}), "add up to 60"),
        ("no weight of 0", form(depts=DEPTS, people=NAMED, weights={(A, C): {A: 0, C: 100}}), "weight from 1 to 99"),
        ("a lone calibrator isn't the BU CEO of their own people", form(units=(U1,), cals=[CEO1], depts={CEO1: [(U1, OPS)]}),
         "is the BU CEO of"),
        ("a lone calibrator leaves the BU CEO a department", form(units=(U3,), curve=U3, cals=[D],
                                                                depts={D: [(U3, PROD), (U3, "ZZBUP Mgmt")]}),
         "Leave at least one department"),
    ]
    for what, data, msg in cases:
        r = post(C_SU, data)
        s.check("...%s" % what, not panels() and msg in flashes(r), flashes(r)[:160])

    # ------------------------------------------------------------------ step 3's preview
    s.section("step 3: the server's own plan of the form, nothing written")
    pr = C_SU.post("/admin/leaders", data=form(depts=DEPTS, people=NAMED, action="bu_panel_preview"))
    pj = pr.get_json() or {}
    combos = {tuple(sorted(x_["eid"] for x_ in c_["cals"])): c_ for c_ in pj.get("combos", [])}
    singles = {x_["eid"]: x_["n"] for x_ in pj.get("single", [])}
    s.check("10 people, 4 shared, nothing written", pj.get("ok") and pj.get("total") == 10 and pj.get("shared") == 4
            and not panels(), pj)
    s.check("each calibrator alone: Alpha 2 (Sales North but the one named), Bravo 3 (Trading Sales + the one named), "
            "Charlie 1 (Trading Finance)", singles == {EID[A]: 2, EID[B]: 3, EID[C]: 1}, singles)
    ac, abc = combos.get(tuple(sorted((EID[A], EID[C])))), combos.get(tuple(sorted((EID[A], EID[B], EID[C]))))
    s.check("Finance shared by Alpha and Charlie, 2 people, 50 : 50 by default",
            ac and ac["n"] == 2 and ac["weights"] == {EID[A]: 50, EID[C]: 50} and "Finance" in ac["where"], ac)
    s.check("HR shared by all three, 2 people, 34 : 33 : 33 by default",
            abc and abc["n"] == 2 and sorted(abc["weights"].values()) == [33, 33, 34], abc)
    pr2 = C_SU.post("/admin/leaders", data=form(name="", depts=DEPTS, people=NAMED, action="bu_panel_preview"))
    s.check("...and a form that doesn't work comes back with the reason", (pr2.get_json() or {}).get("ok") is False
            and "Name the panel" in (pr2.get_json() or {}).get("error", ""), pr2.get_json())

    # ------------------------------------------------------------------ the save
    s.section("the save: the panel, a calibrator row each, its units and the weights")
    W = {(A, B, C): {A: 20, B: 20, C: 60}}
    r = post(C_SU, form(name="  ZZBUP   Sales and shared ", depts=DEPTS, people=NAMED, weights=W))
    P = panels()
    PID = P[0][0] if P else None
    CR = cal_rows(PID) if PID else []
    GID = {r_[1]: r_[0] for r_ in CR}
    s.check("one panel, its name tidied; one calibrator row each, in the panel", len(P) == 1
            and P[0][1] == "ZZBUP Sales and shared" and sorted(GID) == sorted([A, B, C]), (P, CR, flashes(r)[:200]))
    s.check("...its units and its curve", sorted(r_[0] for r_ in H.rows(
        a, "SELECT company FROM calib_bu_panel_units WHERE panel_id=?", (PID,))) == sorted([U1, U2])
        and H.one(a, "SELECT company FROM calib_bu_panels WHERE id=?", (PID,)) == U1)
    wrows = {(r_[0], r_[1]): r_[2] for r_ in H.rows(
        a, "SELECT combo, group_id, weight FROM calib_bu_panel_weights WHERE panel_id=?", (PID,))}
    combo3 = a.bu_combo([GID[A], GID[B], GID[C]])
    combo2 = a.bu_combo([GID[A], GID[C]])
    s.check("the weights saved by calibrator row: 20 : 20 : 60 for HR's set, 50 : 50 for Finance's",
            wrows.get((combo3, GID[A])) == 20 and wrows.get((combo3, GID[B])) == 20 and wrows.get((combo3, GID[C])) == 60
            and wrows.get((combo2, GID[A])) == 50 and wrows.get((combo2, GID[C])) == 50, wrows)
    s.check("...written to the audit trail with each calibrator and the shared weights", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='bu_panel_save' AND detail LIKE 'ZZBUP%Sales and shared%' "
           "AND detail LIKE '%20%60%'") == 1)

    # ------------------------------------------------------------------ who calibrates whom
    s.section("who calibrates whom: a name wins over the department; several calibrators share a person")
    with a.app.test_request_context("/"):
        db = a.get_db()
        U = {x: db.execute("SELECT * FROM users WHERE id=?", (x,)).fetchone() for x in PEOPLE}
        cal_of = lambda x: sorted(g_["calibrator_id"] for g_ in a.bu_groups_of_person(db, U[x]))  # noqa: E731
        s.check("Sales North is Alpha's; the one named under Bravo is Bravo's alone", cal_of(SN1) == [A]
                and cal_of(SN3) == [B], (cal_of(SN1), cal_of(SN3)))
        s.check("Finance: Alpha and Charlie; HR: all three; Trading Finance: Charlie; Ops and Logistics: their BU CEO's",
                cal_of(F1) == sorted([A, C]) and cal_of(H1) == sorted([A, B, C]) and cal_of(TF1) == [C]
                and cal_of(O1) == [] and cal_of(L1) == [])
        s.check("...also for a row read without its department", sorted(g_["calibrator_id"] for g_ in a.bu_groups_of_person(
            db, {"id": F1, "business_group": BG, "company": U1})) == sorted([A, C]))
        s.check("a person's BU-level keys: one per calibrator; shared only where several",
                sorted(a.bu_scope_keys(db, U[H1])) == sorted("grp:%d" % GID[x] for x in (A, B, C))
                and a.bu_scope_keys(db, U[O1]) == [U1] and a.bu_shared(db, U[F1]) and not a.bu_shared(db, U[SN1]))
        wh = a.bu_weights_for(db, a.bu_groups_of_person(db, U[H1]))
        s.check("the weights a person's band takes: HR 20 : 20 : 60, Finance 50 : 50, Sales North 100",
                wh == {GID[A]: 20, GID[B]: 20, GID[C]: 60}
                and a.bu_weights_for(db, a.bu_groups_of_person(db, U[F1])) == {GID[A]: 50, GID[C]: 50}
                and a.bu_weights_for(db, a.bu_groups_of_person(db, U[SN1])) == {GID[A]: 100}, wh)
        ua, ub = (db.execute("SELECT * FROM users WHERE id=?", (x,)).fetchone() for x in (A, B))
        s.check("each calibrator leads their own people at BU level, no one else's (Bravo is HR's second calibrator)",
                a.leader_role_of(db, ub, U[H1]) == "buceo" and a.leader_role_of(db, ub, U[F1]) != "buceo"
                and a.leader_role_of(db, ua, U[H1]) == "buceo"
                and a.calibration_can_view_subject(db, ub, H1) and not a.calibration_can_view_subject(db, ub, F1))
        seats = {(t_, k_, h_) for t_, k_, h_ in a._prerun_seats(db, H1)}
        s.check("...and each one's AI reading of a shared person is worked out ahead (a pre-run seat each)",
                {("buceo", "grp:%d" % GID[x], x) for x in (A, B, C)} <= seats, sorted(seats))
    with a.app.test_request_context("/", method="GET"):
        db = a.get_db()
        users = {x: db.execute("SELECT * FROM users WHERE id=?", (x,)).fetchone() for x in (A, B, C, CEO1)}
        pops = {}
        for x in (A, B, C):
            ctx_ = a._pm_calib_resolve(db, users[x], "buceo", bg=BG, company=U1, grp=GID[x])
            pops[x] = {p_["id"] for p_ in ctx_["population"]}
        s.check("each calibrator's roster: Alpha's Sales North (not the one named), Finance and HR; Bravo's Trading "
                "Sales, HR and the one named; Charlie's Finance in both units and HR",
                pops[A] == {SN1, SN2, F1, F2, H1, H2} and pops[B] == {SN3, TS1, TS2, H1, H2}
                and pops[C] == {F1, F2, H1, H2, TF1}, {k: sorted(v) for k, v in pops.items()})
        cx = a._pm_calib_resolve(db, users[CEO1], "buceo", bg=BG, company=U1)
        ov = a._pm_calib_assist_overview(db, users[CEO1], cx, "buceo", {"bg": BG, "company": U1})["data"]
        oth = {o_["id"]: o_ for o_ in ov["others"]}
        s.check("the BU CEO's own roster leaves every panel person out", not ({p_["id"] for p_ in cx["population"]}
                & {SN1, SN2, SN3, F1, F2, H1, H2}) and {O1, O2} <= {p_["id"] for p_ in cx["population"]})
        s.check("...who ride along read only, each tagged with every calibrator, the weights on hover",
                {SN1, SN3, F1, H1} <= set(oth) and oth[H1]["by"] == "ZBA + ZBB + CFO" and "(20%)" in oth[H1]["by_title"]
                and "(60%)" in oth[H1]["by_title"] and oth[SN1]["by_title"].endswith("Head of Sales")
                and oth[SN1]["by"] == "ZBA"
                and not any(o_["movable"] for o_ in ov["others"]), (oth.get(H1, {}).get("by"),
                                                                     oth.get(H1, {}).get("by_title")))
        _, err = a._pm_calib_apply(db, users[CEO1], cx, "buceo", H1, "AE", "ZZ reason", dry_run=True)
        s.check("...and the BU CEO can't move them", err is not None, err)
        gx = a._pm_calib_resolve(db, users[B], "buceo", bg=BG, company=U1, grp=GID[B])
        _, errb = a._pm_calib_apply(db, users[B], gx, "buceo", F1, "AE", "ZZ reason", dry_run=True)
        s.check("...nor a calibrator someone who isn't theirs", errb is not None, errb)
        note = a._bu_group_prompt_note(db, a._pm_calib_resolve(db, users[A], "buceo", bg=BG, company=U1, grp=GID[A]),
                                       "buceo")
        s.check("the calibrator's agent is told it's a panel, never the BU CEO, and that some people are shared by weight",
                note and "CALIBRATION PANEL" in note and "never the BU CEO" in note and "weighted" in note, note)

    # ------------------------------------------------------------------ the bands, end to end
    s.section("the bands through the real routes: nothing counts until locked; the locked ones, weighted")
    a._pm_calib_lock_breaches = lambda *x_, **k_: {}   # the curve rule isn't what's tested here

    def move(client, gid, who, band):
        return client.post("/performance/calibration/company/%s/%s/adjust?grp=%d" % (BG, U1, gid),
                           data={"csrf_token": "tok", "subject_id": str(who), "adjusted_band": band,
                                 "justification": "ZZBUP %s" % band})

    def lock(client, gid):
        return client.post("/performance/calibration/company/%s/%s/lock?grp=%d" % (BG, U1, gid),
                           data={"csrf_token": "tok", "override_reason": "ZZBUP test"})

    def eb(x, raw="BE"):
        with a.app.test_request_context("/"):
            db = a.get_db()
            return a.pm_effective_band(db, db.execute("SELECT * FROM users WHERE id=?", (x,)).fetchone(), CID, raw)

    move(C_A, GID[A], F1, "ME")
    move(C_C, GID[C], F1, "AE")
    for who_c, gid_, band in ((C_A, GID[A], "OU"), (C_B, GID[B], "AE"), (C_C, GID[C], "ME")):
        move(who_c, gid_, H1, band)
    move(C_A, GID[A], H2, "OU")
    move(C_C, GID[C], H2, "OU")   # Bravo leaves H2 as they came in
    moved = {r_[0]: r_[1] for r_ in H.rows(
        a, "SELECT s.scope_key, a.adjusted_band FROM pm_calibration_adjustments a JOIN pm_calibration_sessions s ON "
           "s.id=a.session_id WHERE s.cycle_id=? AND a.subject_id=?", (CID, H1))}
    s.check("each calibrator's move lands on their own session", moved == {"grp:%d" % GID[A]: "OU",
            "grp:%d" % GID[B]: "AE", "grp:%d" % GID[C]: "ME"}, moved)
    s.check("nothing counts until a calibrator locks", (eb(F1) or {}).get("source") != "buceo"
            and (eb(H1) or {}).get("source") != "buceo", (eb(F1), eb(H1)))
    with a.app.test_request_context("/"):
        db = a.get_db()
        hpop = db.execute("SELECT * FROM users WHERE id IN (?,?)", (H1, H2)).fetchall()
        s.check("HR's department review is open while no calibrator has locked", a._hod_review_closed(
            db, "pm", CID, hpop) is None, a._hod_review_closed(db, "pm", CID, hpop))
    with a.app.test_request_context("/"):
        db = a.get_db()
        uf1 = db.execute("SELECT * FROM users WHERE id=?", (F1,)).fetchone()
        s.check("...nor in the band's journey: no calibrator rows, no average", a.bu_level_trail(db, "pm", CID, uf1,
                came_in="BE") == [], a.bu_level_trail(db, "pm", CID, uf1, came_in="BE"))
    lock(C_C, GID[C])
    s.check("Charlie locks first: Finance's band is Charlie's alone for now (AE)", (eb(F1) or {}).get("band") == "AE"
            and eb(F1).get("source") == "buceo", eb(F1))
    with a.app.test_request_context("/"):
        db = a.get_db()
        uf1 = db.execute("SELECT * FROM users WHERE id=?", (F1,)).fetchone()
        tl = a.bu_level_trail(db, "pm", CID, uf1, came_in="BE")
        s.check("...and the journey: Charlie (50%) AE, then the average so far, waiting on Alpha",
                [(t_["label"], t_["band"]) for t_ in tl] == [("BU level · ZZ Bup Charlie (50%)", "AE"),
                                                           ("Calibration average", "AE")]
                and tl[0].get("cal") and tl[-1].get("avg") and tl[-1]["waiting"] == ["ZZ Bup Alpha"], tl)
    with a.app.test_request_context("/"):
        db = a.get_db()
        hpop = db.execute("SELECT * FROM users WHERE id IN (?,?)", (H1, H2)).fetchall()
        msg = a._hod_review_closed(db, "pm", CID, hpop)
        s.check("...and HR's department review closes on that lock (HR's third calibrator), naming a calibrator",
                msg and "a calibrator" in msg, msg)
    lock(C_A, GID[A])
    s.check("Alpha locks: Finance is ME and AE at 50 : 50 = ME, the lower (Chris's example)",
            (eb(F1) or {}).get("band") == "ME", eb(F1))
    lock(C_B, GID[B])
    s.check("all three locked: HR is OU, AE, ME at 20 : 20 : 60 = AE", (eb(H1) or {}).get("band") == "AE", eb(H1))
    s.check("a calibrator who locked without moving someone counts the band that came in: OU, BE (came in), OU = AE "
            "((5x20 + 2x20 + 5x60) / 100 = 4.4; leaving them out would make it OU)",
            (eb(H2, raw="BE") or {}).get("band") == "AE", eb(H2, raw="BE"))
    s.check("...and nobody moved at all: the band that came in", (eb(F2, raw="AE") or {}).get("band") == "AE",
            eb(F2, raw="AE"))
    with a.app.test_request_context("/"):
        db = a.get_db()
        uh1 = db.execute("SELECT * FROM users WHERE id=?", (H1,)).fetchone()
        rb, prov = a._rr_tier_bands(db, CID, uh1, "BE", "pm")
        s.check("the rating record carries the same BU-level band", rb.get("buceo") == "AE", rb)
        tr = a.pm_calibration_trails(db, [uh1], CID).get(H1, [])
        bu_tr = [t_ for t_ in tr if t_["tier"] == "buceo"]
        s.check("the band trail names each calibrator with their weight, then their average (Chris: \"Calibrator A, "
                "Calibrator B, Average of Calibration band\")", [(t_["label"], t_["band"]) for t_ in bu_tr]
                == [("BU level · ZZ Bup Alpha (20%)", "OU"), ("BU level · ZZ Bup Bravo (20%)", "AE"),
                    ("BU level · ZZ Bup Charlie (60%)", "ME"), ("Calibration average", "AE")]
                and [bool(t_.get("cal")) for t_ in bu_tr] == [True, True, True, False] and bu_tr[-1].get("avg")
                and bu_tr[-1]["waiting"] == [], bu_tr)
        uh2_ = db.execute("SELECT * FROM users WHERE id=?", (H2,)).fetchone()
        t2 = a.bu_level_trail(db, "pm", CID, uh2_, came_in="BE")
        s.check("...a calibrator who kept the band that came in reads it, kept (from = band): OU, BE, OU, average AE",
                [(t_["band"], t_["from"]) for t_ in t2] == [("OU", "BE"), ("BE", "BE"), ("OU", "BE"), ("AE", "BE")], t2)
        view = a.bu_parts_view(db, "pm", CID, uh1, raw_band="BE")
        s.check("the BG CEO's person view: each calibrator, weight and band, and the band they make (AE)",
                view and view["band"] == "AE" and [(p_["who"], p_["weight"], p_["band"]) for p_ in view["parts"]]
                == [("ZZ Bup Alpha", 20, "OU"), ("ZZ Bup Bravo", 20, "AE"), ("ZZ Bup Charlie", 60, "ME")]
                and not view["waiting"], view)
        uh2 = db.execute("SELECT * FROM users WHERE id=?", (H2,)).fetchone()
        v2 = a.bu_parts_view(db, "pm", CID, uh2, raw_band="BE")
        s.check("...a calibrator who kept the band that came in shows it, marked kept", v2 and v2["parts"][1]["kept"]
                and v2["parts"][1]["band"] == "BE" and v2["band"] == "AE", v2)
        ux = db.execute("SELECT * FROM users WHERE id=?", (A,)).fetchone()
        gxa = a._pm_calib_resolve(db, ux, "buceo", bg=BG, company=U1, grp=GID[A])
        gov = a._pm_calib_assist_overview(db, ux, gxa, "buceo", {"bg": BG, "company": U1, "grp": GID[A]})["data"]
        rh1 = next((r_ for r_ in gov["rows"] if r_["id"] == H1), {})
        co = rh1.get("co") or {}
        s.check("the calibrator's row: their own weight, the others' weights and bands, and the BU level they make",
                co.get("mine") == 20 and sorted((o_["weight"], o_["band"], o_["locked"]) for o_ in co.get("others", []))
                == [(20, "AE", True), (60, "ME", True)] and co.get("level") == "AE", co)
        s.check("...and someone only they calibrate has no shared line", not next(
            (r_ for r_ in gov["rows"] if r_["id"] == SN1), {}).get("co"))

    # ------------------------------------------------------------------ the potential axis
    s.section("the potential axis blends the same way")
    with a.app.test_request_context("/"):
        db = a.get_db()
        for x, band in ((A, "High"), (B, "Mid"), (C, "Mid")):
            sid = a._get_or_create_calibration_session(db, CID, "buceo", "grp:%d" % GID[x], BG, U1)["id"]
            a._calibration_upsert_adjustment(db, sid, H1, "", band, "ZZBUP pot", x)
            db.execute("UPDATE calibration_sessions SET locked_at=datetime('now'), locked_by=? WHERE id=?", (x, sid))
        db.commit()
        uh1 = db.execute("SELECT * FROM users WHERE id=?", (H1,)).fetchone()
        sh = a.bu_panel_call(db, "pot", CID, uh1)
        s.check("High, Mid, Mid at 20 : 20 : 60 = Mid ((3x20 + 2x20 + 2x60) / 100 = 2.2)", sh and sh[0] == "Mid", sh)
        if a.cycle_has_potential(db, CID):
            s.check("...and effective_band reads it", a.effective_band(db, uh1, CID).get("band") == "Mid"
                    and a.effective_band(db, uh1, CID).get("source") == "buceo", a.effective_band(db, uh1, CID))

    # ------------------------------------------------------------------ the BG CEO's page and the AI, calibrators first
    s.section("the BG CEO: Calibrator A, Calibrator B, the average on the person's page; the AI reads them first")
    with a.app.test_request_context("/"):
        db = a.get_db()
        ubg = db.execute("SELECT * FROM users WHERE id=?", (BGC,)).fetchone()
        uh1 = db.execute("SELECT * FROM users WHERE id=?", (H1,)).fetchone()
        ctx = a._talent_box_resolve(db, ubg, "bgceo", bg=BG)
        tb = ("bgceo", {"bg": BG}, ctx)
        s.check("H1 is on the BG CEO's Talent Box", any(p_["id"] == H1 for p_ in ctx["population"]))
        fr = a._tbox_person_frame(db, ubg, tb, uh1)
        pb, qb = (fr["perf"]["r"] or {}).get("bucal") or {}, (fr["pot"]["r"] or {}).get("bucal") or {}
        s.check("their page's performance: each calibrator, weight and band, and the band they make (AE)",
                pb.get("band") == "AE" and [(x_["who"], x_["weight"], x_["band"], x_["locked"]) for x_ in pb["parts"]]
                == [("ZZ Bup Alpha", 20, "OU", True), ("ZZ Bup Bravo", 20, "AE", True), ("ZZ Bup Charlie", 60, "ME", True)],
                pb)
        s.check("...and its potential the same way (High, Mid, Mid = Mid)", qb.get("band") == "Mid" and
                [(x_["weight"], x_["band"]) for x_ in qb["parts"]] == [(20, "High"), (20, "Mid"), (60, "Mid")], qb)
        ptr = (fr["perf"]["r"] or {}).get("trail") or []
        s.check("...the journey's own rows carry the calibrators and the average, flagged, so the page draws them once",
                [(t_.get("tier"), bool(t_.get("cal")), bool(t_.get("avg"))) for t_ in ptr if t_.get("tier") == "buceo"]
                == [("buceo", True, False)] * 3 + [("buceo", False, True)]
                and all(t_.get("by") for t_ in ptr if t_.get("cal")), ptr)
        qtr = [t_ for t_ in (fr["pot"]["r"] or {}).get("trail") or [] if t_.get("tier") == "buceo"]
        s.check("...on the potential tab too: each calibrator who locked, then the average (Mid)",
                [(bool(t_.get("cal")), t_["band"]) for t_ in qtr] == [(True, "High"), (True, "Mid"), (True, "Mid"),
                                                                       (False, "Mid")] and qtr[-1].get("avg"), qtr)
        s.check("...someone only one calibrator has carries no calibrator rows", not (a._tbox_person_frame(
            db, ubg, tb, db.execute("SELECT * FROM users WHERE id=?", (SN1,)).fetchone())["perf"]["r"] or {}).get("bucal"))
        rows_ = a.talent_box_rows(db, dict(ctx, population=[uh1]))
        st_ = a._tb_band_trails(db, ctx, rows_).get(H1, {}).get("perf") or []
        cal_ = [x_ for x_ in st_ if x_[0] in ("cal", "avg")]
        s.check("the box's hover trail: each calibrator by tag and weight, then the average (the band the box shows)",
                [x_[0] for x_ in cal_] == ["cal", "cal", "cal", "avg"] and [x_[1] for x_ in cal_] == ["OU", "AE", "ME", "AE"]
                and [x_[3].rsplit(" ", 1)[-1] for x_ in cal_] == ["20%", "20%", "60%", "Average"]
                and not any(x_[0] == "buceo" for x_ in st_), st_)
        built = a._tb_insight_case(db, ubg, tb, uh1)
        src_ = built[0] if built else ""
        i_bu = src_.find("BU-LEVEL CALIBRATION, PERFORMANCE")
        s.check("the AI insight's case opens with the calibrators: each one's call and weight, then the weighted result",
                0 <= i_bu < src_.find("BU-LEVEL CALIBRATION, POTENTIAL") and "ZZ Bup Alpha, Head of Sales (20% of the call)"
                in src_ and "ZZ Bup Charlie" in src_ and "weighted, they put them at ahead of target overall" in src_
                and "from their BU-level calibrators' weighted call" in src_ and "BU CEO's calibration" not in src_,
                src_[:900])
        s.check("...before their KPI results and anything else written", all(
            i_bu < src_.find(k_) for k_ in ("KPI RESULTS", "360", "DEVELOPMENT PLAN") if src_.find(k_) >= 0)
            and i_bu < src_.find("DEVELOPMENT PLAN"), src_[:600])
        s.check("...with each calibrator's words, attributed to them, never to a BU CEO",
                "ZZ Bup Alpha (BU-level calibrator, 20% of the call) wrote on their performance: <<<ZZBUP OU>>>" in src_
                and "The BU CEO wrote" not in src_ and src_.count("<<<ZZBUP OU>>>") == 1, src_[:1400])
        s.check("...and the plain reading names them first", a._tb_insight_plain(built[1])["insight"].startswith(
            "Calibrated at BU level by ZZ Bup Alpha, ZZ Bup Bravo and ZZ Bup Charlie"), a._tb_insight_plain(built[1]))
        ptrail = a._pm_perf_trail(db, H1, "bgceo")
        case_ = a._pm_perf_case_text({"rows": [], "trail": ptrail, "remark": ""}, {})
        case_ = case_ if isinstance(case_, str) else "\n".join(case_)
        s.check("the performance insight's case: the calibrators and the weighted band before their own remark",
                0 <= case_.find("BU LEVEL, ONE OF SEVERAL CALIBRATORS: ZZ Bup Alpha, 20% of the call")
                < case_.find("BU LEVEL, WEIGHTED") < case_.find("THEIR OVERALL REMARK")
                and "HOW IT REACHED YOU: the BU level" not in case_, case_[:900])
        plain_ = a._pm_perf_case_plain({"trail": ptrail, "remark": "ZZ my year"}, [], "justified", "")
        s.check("...and its plain reading the same, first among the views", 0 <= plain_.find(
            "Their BU-level calibrator ZZ Bup Alpha (20% of the call)") < plain_.find("Weighted, their BU-level") 
            < plain_.find("They say"), plain_)
    # the BU level row as the calibrator filter, in place of the department row (Chris, 2026-10-26: "can the BU
    # calibrator becomes the filter here, substituting the department filter")
    s.section("the Talent Box's BU level row filters by calibrator, in place of the department row")
    _avail = a.ai_draft.review_agent_available
    a.ai_draft.review_agent_available = lambda: True
    try:
        with a.app.app_context():
            db = a.get_db()
            db.execute("INSERT OR REPLACE INTO calib_dept_filter(business_group, company, view, shown) VALUES (?,?,'tb',1)",
                       (BG, U1))
            db.commit()
        C_BG = H.client_as(a, BGC)

        def tbox(q=""):
            r_ = C_BG.get("/review/chat/history?journey=1&view=bg&stage=talent_box&company=%s%s"
                          % (U1.replace(" ", "+"), q))
            return ((r_.get_json() or {}).get("overview") or {}).get("data") or {}

        def ids(d_):
            return {p_["id"] for x_ in d_.get("cells") or [] for p_ in x_["people"]} | {
                u_["id"] for u_ in d_.get("unplaced") or []}
        d0 = tbox()
        lv = {x_["key"]: x_ for x_ in d0.get("bu_level") or []}
        want = {"grp:%d" % GID[A]: {SN1, SN2, F1, F2, H1, H2}, "grp:%d" % GID[B]: {SN3, H1, H2},
                "grp:%d" % GID[C]: {F1, F2, H1, H2}}
        s.check("the row is the filter: the BU CEO and each calibrator, keyed, each with the people they calibrate here",
                d0.get("cal_filter") is True and set(lv) == set(want) | {"ceo"}
                and all(lv[k_]["n"] == len(v_) for k_, v_ in want.items()), {k_: x_.get("n") for k_, x_ in lv.items()})
        s.check("...and the DEPT row shows too where the super admin switched it on (canvas A: both together)",
                d0.get("dept_filter") is True and {x_["key"] for x_ in d0.get("depts") or []} >= {SN, FIN, HR, OPS}
                and d0.get("cal_all") == len(ids(d0)), (d0.get("dept_filter"), len(d0.get("depts") or [])))
        everyone = ids(d0)
        for k_, v_ in want.items():
            dk = tbox("&cal=" + k_)
            s.check("picking %s shows exactly their people (a shared person under each of theirs)" % k_,
                    dk.get("cal") == k_ and ids(dk) == v_ and dk.get("bu_people") == d0.get("bu_people")
                    and dk.get("lock_company") == U1, (dk.get("cal"), sorted(ids(dk)), sorted(v_)))
        dc = tbox("&cal=ceo")
        s.check("picking the BU CEO shows the people nobody else calibrates: the rest of the unit",
                dc.get("cal") == "ceo" and ids(dc) == everyone - set().union(*want.values())
                and {O1, O2} <= ids(dc) and lv["ceo"]["n"] == len(ids(dc)), sorted(ids(dc)))
        dx = tbox("&cal=grp:99999999")
        s.check("a calibrator who isn't the unit's is ignored: the whole unit", dx.get("cal") == "" and ids(dx) == everyone,
                (dx.get("cal"), len(ids(dx))))
        dfin = tbox("&dept=" + FIN.replace(" ", "+"))
        lf = {x_["key"]: x_["n"] for x_ in dfin.get("bu_level") or []}
        s.check("CAL counts within the department picked: Finance is Alpha's 2 and Charlie's 2, nobody else's",
                dfin.get("dept") == FIN and dfin.get("cal_all") == 2 and lf.get("grp:%d" % GID[A]) == 2
                and lf.get("grp:%d" % GID[C]) == 2 and not lf.get("grp:%d" % GID[B]) and not lf.get("ceo"), lf)
        dfa = tbox("&dept=%s&cal=grp:%d" % (FIN.replace(" ", "+"), GID[A]))
        s.check("...and the two picks narrow together: Alpha's people in Finance", dfa.get("cal") == "grp:%d" % GID[A]
                and ids(dfa) == {F1, F2}, sorted(ids(dfa)))
        dfb = tbox("&dept=%s&cal=grp:%d" % (FIN.replace(" ", "+"), GID[B]))
        s.check("...a calibrator with nobody in the department picked is no pick: the whole department",
                dfb.get("cal") == "" and ids(dfb) == {F1, F2}, (dfb.get("cal"), sorted(ids(dfb))))
        with a.app.app_context():
            db = a.get_db()
            db.execute("INSERT OR REPLACE INTO calib_cal_filter(business_group, company, view, shown) VALUES (?,?,'tb',0)",
                       (BG, U1))
            db.commit()
        doff = tbox("&cal=grp:%d" % GID[A])
        s.check("the super admin's off switch hides the CAL row, and a pick then counts for nothing (the lock line returns)",
                doff.get("cal_filter") is False and doff.get("cal") == "" and ids(doff) == everyone
                and len(doff.get("bu_level") or []) == 4, (doff.get("cal_filter"), doff.get("cal")))
        with a.app.app_context():
            db = a.get_db()
            db.execute("DELETE FROM calib_cal_filter WHERE business_group=?", (BG,))
            db.commit()
        s.check("Help names the Calibrator filter first on the BG CEO's Talent Box", "tb_cal" in a.HELP_QA
                and "Calibrator filter" in a.HELP_QA["tb_cal"][0])
    finally:
        a.ai_draft.review_agent_available = _avail
        with a.app.app_context():
            db = a.get_db()
            db.execute("DELETE FROM calib_dept_filter WHERE business_group=?", (BG,))
            db.commit()

    # the super admin's card (Chris, 2026-10-26: "go with A, Talent Box only for now, build it"; since 2026-10-30 one rule per
    # filter, saved by units x screens): Department, Calibrator and Job grade per unit and screen
    s.section("Filters at BU level: Department, Calibrator and Job grade per unit and screen, the super admin's")
    with a.app.app_context():
        db = a.get_db()
        units_ = sorted({U1, U2, U3})
    pg = C_SU.get("/admin/m/calibration/settings?bfbg=" + BG.replace(" ", "+"))
    html_ = pg.get_data(as_text=True)
    i_u3 = units_.index(U3)
    s.check("the card is on Calibration & Talent's Settings, a row per filter, in place of the Department card",
            pg.status_code == 200 and 'id="bu-filters"' in html_ and 'data-cfr-row="dept"' in html_ and 'data-cfr-row="cal"' in html_
            and 'data-cfr-row="jg"' in html_ and "Save filter" in html_ and "data-bf-all" not in html_
            and 'id="dept-filter"' not in html_ and 'id="jg-filter"' in html_
            and 'data-confirm-title="Save the Department filter?"' in html_, pg.status_code)
    cal_p = html_[html_.find('data-panel="cf-cal"'):html_.find('data-panel="cf-jg"')]
    s.check("the Calibrator's panel offers the Talent Box alone, its unit ticked where it has calibrators and the one with none "
            "greyed out with the reason",
            'data-cfr-screen="tb"' in cal_p and 'data-cfr-screen="bu"' not in cal_p
            and re.search(r'name="on_%d"[^>]*checked' % units_.index(U1), cal_p) is not None
            and re.search(r'name="on_%d"[^>]*disabled' % i_u3, cal_p) is not None and "No calibrators at BU level" in cal_p, i_u3)
    s.check("...and the JG card keeps the grouping only (its unit switches moved here)",
            html_.count('name="unit_') == 5 * len(units_), html_.count('name="unit_'))

    def bf_post(client, key, ticked, screens):
        d_ = {"csrf_token": "tok", "bg": BG, "filter": key, "screen": list(screens)}
        for i_, co_ in enumerate(units_):
            d_["unit_%d" % i_] = co_
            if co_ in ticked:
                d_["on_%d" % i_] = "1"
        return client.post("/admin/settings/calib-filter", data=d_)
    # Department on Living's Talent Box and Bedding's BU CEO view (one save per screen set), Job grade on Living's Talent Box,
    # the Calibrator off on Living's Talent Box
    bf_post(C_SU, "dept", {U1}, ["tb"])
    bf_post(C_SU, "jg", {U1}, ["tb"])
    r_ = bf_post(C_SU, "cal", {U2}, ["tb"])
    with a.app.app_context():
        db = a.get_db()
        dm, jm, cm = a.calib_dept_filter_map(db, BG), a.calib_jg_filter_map(db, BG), a.calib_cal_filter_map(db, BG)
        sh = a.calib_cal_filter_shown
        s.check("Save writes what changed: DEPT and JG on Living's Talent Box, CAL off there",
                dm.get((U1, "tb")) is True and jm.get((U1, "tb")) is True and cm.get((U1, "tb")) is False
                and not sh(db, BG, [U1], "tb") and sh(db, BG, [U2], "tb"), (dm, jm, cm))
        s.check("...CAL is never written for a unit with no calibrators, nor for the BU CEO view",
                (U3, "tb") not in cm and not any(v_ == "bu" for (_c, v_) in cm), cm)
        s.check("...the audit line names each change, and the settings sheet reads it",
                H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='settings' AND detail LIKE ?",
                      ("Filters at BU level, %s:%%CAL hidden in the Talent Box: %s%%" % (BG, U1),)) >= 1
                and "off in 1 unit" in a._st_bu_filters(db, SU), a._st_bu_filters(db, SU))
    rb_ = bf_post(C_BGA, "cal", {U1}, ["tb"]) if C_BGA else None
    with a.app.app_context():
        s.check("a BG admin can't save it (the super admin's)", rb_ is None or (
            rb_.status_code in (302, 403) and a.calib_cal_filter_map(a.get_db(), BG).get((U1, "tb")) is False),
            rb_.status_code if rb_ else None)
    bf_post(C_SU, "cal", {U1, U2}, ["tb"])
    bf_post(C_SU, "dept", set(), ["bu", "tb"])
    bf_post(C_SU, "jg", set(), ["bu", "tb"])
    with a.app.app_context():
        db = a.get_db()
        s.check("...and switched back: CAL on, DEPT and JG off again", a.calib_cal_filter_shown(db, BG, [U1], "tb")
                and not a.calib_dept_filter_map(db, BG).get((U1, "tb")) and not a.calib_jg_filter_map(db, BG).get((U1, "tb")))
        db.execute("DELETE FROM calib_cal_filter WHERE business_group=?", (BG,))
        db.execute("DELETE FROM calib_dept_filter WHERE business_group=?", (BG,))
        db.execute("DELETE FROM calib_jg_filter WHERE business_group=?", (BG,))
        db.commit()
    s.check("the org rename carries the CAL setting with its unit", "calib_cal_filter" in a._ORG_SETTINGS_TABLES)
    _jc = open(os.path.join(os.path.dirname(a.__file__), "static", "journey_chat.js")).read()
    s.check("the page sends the pick and draws it as a chip of the filter line: &cal=, the chat's cal, no row of pills",
            'TB_FKEYS = ["seg", "gbg", "dept", "cal", "jg", "cc", "branch"]' in _jc and "tbPicksForm(f);" in _jc
            and "var frow = tbFilterLine(d);" in _jc and "function tbSelectFilter(key, vals)" in _jc
            and "function tbCalRow(" not in _jc)
    s.check("the page draws them: r.bucal's parts and \"Calibration average\" in the journey, the trail's label",
            "r.bucal && (r.bucal.parts || []).length > 1" in _jc and '"Calibration average"' in _jc
            and "s[3] || TB_TRAIL_WHO[k]" in _jc and "!(bc && (t.cal || t.avg))" in _jc)

    # ------------------------------------------------------------------ after a lock, only the name
    s.section("once a calibrator has locked, only the panel's name and tag can change; a panel with moves stays")
    r = post(C_SU, form(depts=DEPTS, people=NAMED, weights={(A, B, C): {A: 40, B: 20, C: 40}}, panel_id=PID))
    s.check("new weights are refused, naming the lock", wrows == {(r_[0], r_[1]): r_[2] for r_ in H.rows(
        a, "SELECT combo, group_id, weight FROM calib_bu_panel_weights WHERE panel_id=?", (PID,))}
        and "only its name and tag can change" in flashes(r), flashes(r)[:160])
    r = post(C_SU, form(depts={A: DEPTS[A], B: DEPTS[B], C: DEPTS[C][:2]}, people=NAMED, weights=W, panel_id=PID))
    s.check("...and so is taking HR off Charlie", "only its name and tag can change" in flashes(r), flashes(r)[:160])
    r = post(C_SU, form(name="ZZBUP Sales and shared services", depts=DEPTS, people=NAMED, weights=W, panel_id=PID))
    s.check("a rename alone goes", H.one(a, "SELECT name FROM calib_bu_panels WHERE id=?", (PID,))
            == "ZZBUP Sales and shared services", flashes(r)[:160])
    r = post(C_SU, {"csrf_token": "tok", "action": "bu_panel_remove", "bg": BG, "tab": "buceo", "panel_id": str(PID)})
    s.check("the panel can't be removed once its calibrators moved and locked", H.one(
        a, "SELECT active FROM calib_bu_panels WHERE id=?", (PID,)) == 1 and flashes(r), flashes(r)[:160])

    # ------------------------------------------------------------------ one panel a person and a department
    s.section("a department and a person sit in one panel; several calibrators can take a whole unit, one can't")
    r = post(C_SU, form(name="ZZBUP Second", units=(U1, U3), curve=U3, cals=[D], depts={D: [(U1, FIN)]}))
    s.check("a department already in a panel is refused", len(panels()) == 1
            and "a department sits in one panel" in flashes(r), flashes(r)[:160])
    r = post(C_SU, form(name="ZZBUP Second", units=(U1, U3), curve=U3, cals=[D], depts={D: [(U3, PROD)]},
                        people={D: [H1]}))
    s.check("...and so is a person already in one", len(panels()) == 1 and "a person sits in one panel" in flashes(r),
            flashes(r)[:160])
    r = post(C_SU, form(name="ZZBUP Bedding", units=(U3,), curve=U3, cals=[D, CEO3],
                        depts={D: [(U3, PROD), (U3, "ZZBUP Mgmt")], CEO3: [(U3, PROD)]}))
    P2 = [p_ for p_ in panels() if p_[1] == "ZZBUP Bedding"]
    PID2 = P2[0][0] if P2 else None
    s.check("two calibrators, the unit's BU CEO one of them, can take every department of a unit (no BU CEO left)",
            PID2 and len(cal_rows(PID2)) == 2, flashes(r)[:160])
    with a.app.test_request_context("/"):
        db = a.get_db()
        up1 = db.execute("SELECT * FROM users WHERE id=?", (P1,)).fetchone()
        s.check("...their shared people at 50 : 50 by default", sorted(a.bu_weights_for(
            db, a.bu_groups_of_person(db, up1)).values()) == [50, 50])
    r = post(C_SU, {"csrf_token": "tok", "action": "bu_panel_remove", "bg": BG, "tab": "buceo", "panel_id": str(PID2)})
    with a.app.test_request_context("/"):
        db = a.get_db()
        up1 = db.execute("SELECT * FROM users WHERE id=?", (P1,)).fetchone()
        s.check("a panel nobody has moved anyone in goes, its people back with their BU CEO",
                H.one(a, "SELECT active FROM calib_bu_panels WHERE id=?", (PID2,)) == 0
                and not a.bu_groups_of_person(db, up1) and a.bu_scope_key(db, up1) == U3
                and H.one(a, "SELECT COUNT(*) FROM calib_bu_groups WHERE panel_id=? AND active=1", (PID2,)) == 0,
                flashes(r)[:160])
    s.check("...written to the audit trail", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='bu_panel_remove' "
                                                      "AND detail LIKE 'ZZBUP%Bedding%'") == 1)

    # ------------------------------------------------------------------ the picker, the page
    s.section("the picker narrows to the units ticked; the page")
    fj = C_SU.get("/admin/people/find.json?q=ZZ+Bup&bg=%s&units=%s" % (BG, U2)).get_json() or {}
    s.check("the calibrator search finds only the units ticked", fj.get("people") and all(
        p_["unit"] == U2 for p_ in fj["people"]) and any(p_["eid"] == EID[B] for p_ in fj["people"]),
        [p_["unit"] for p_ in fj.get("people", [])])
    fj2 = C_SU.get("/admin/people/find.json?q=ZZ+Bup&bg=%s" % BG).get_json() or {}
    s.check("...and the whole business group without it", {p_["unit"] for p_ in fj2.get("people", [])} > {U2})
    pg = C_SU.get("/admin/leaders?bg=%s&tab=buceo" % BG).get_data(as_text=True)
    line = re.search(r'id="bu-panel-%d".*?</tr>' % PID, pg, re.S)
    s.check("+ Add a calibrator at the BU CEOs title's right end", "+ Add a calibrator" in pg[
        pg.find('class="ld-bu-head"'):][:400])
    s.check("the panel is a line: its calibrators with their people, the shared weights, locked",
            line and "ZZ Bup Alpha" in line.group(0) and "ZZ Bup Bravo" in line.group(0) and ">CFO</span>" in line.group(0)
            and "Shared:" in line.group(0) and "20 : " in line.group(0) and "60" in line.group(0)
            and "Locked by a calibrator" in line.group(0), line.group(0)[:600] if line else None)
    mp = pg[pg.find('data-panel="bp-%d"' % PID):]
    s.check("its Manage panel: the three steps, its calibrators to start from, the weights saved, double-confirmed",
            'data-bp-form' in mp and 'data-bp-dot="3"' in mp and '"eid": "%s"' % EID[A] in mp
            and re.search(r'<form method="post" class="adm-panel-form bp-form" data-bp-form data-confirm="', mp) is not None
            and "bu_panel.js" in pg)
    init = re.search(r'<script type="application/json" data-bp-init>(.*?)</script>', mp, re.S)
    ij = json.loads(init.group(1)) if init else {}
    k3 = "+".join(sorted((EID[A], EID[B], EID[C])))
    s.check("...its starting point: each calibrator's departments and people, and HR's 20 : 20 : 60",
            ij.get("weights", {}).get(k3) == {EID[A]: 20, EID[B]: 20, EID[C]: 60}
            and any(c_["eid"] == EID[B] and c_["people_init"] for c_ in ij.get("cals", [])), ij)

    # ------------------------------------------------------------------ the migration
    s.section("an old group without a panel becomes a panel of one on the migration")
    with a.app.app_context():
        db = a.get_db()
        lg = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id, split, created_by) "
                        "VALUES (?,?,?,?,50,?)", (BG, U2, "ZZBUP Legacy", CEO2, SU["id"])).lastrowid
        db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)",
                   (lg, BG, U2, LOG))
        db.commit()
    a._ensure_runtime_schema()
    lp = H.one(a, "SELECT panel_id FROM calib_bu_groups WHERE id=?", (lg,))
    s.check("its panel: the same name, unit and curve, its split back to 100", lp and H.one(
        a, "SELECT name || '|' || company FROM calib_bu_panels WHERE id=?", (lp,)) == "ZZBUP Legacy|%s" % U2
        and H.one(a, "SELECT split FROM calib_bu_groups WHERE id=?", (lg,)) == 100
        and [r_[0] for r_ in H.rows(a, "SELECT company FROM calib_bu_panel_units WHERE panel_id=?", (lp,))] == [U2])
    a._ensure_runtime_schema()
    s.check("...once: a second run makes no second panel", H.one(
        a, "SELECT COUNT(*) FROM calib_bu_panels WHERE name='ZZBUP Legacy'") == 1)
finally:
    a._pm_calib_lock_breaches = _real_breaches
    with a.app.app_context():
        db = a.get_db()
        _cleanup(db)
        db.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(CELLS)),
                   (CID,) + CELLS)
        db.executemany("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", WIN0)
        db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN ('pm','calibration','review','tm')",
                   (CID,))
        db.executemany("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", MOD0)
        db.commit()

sys.exit(s.done())
