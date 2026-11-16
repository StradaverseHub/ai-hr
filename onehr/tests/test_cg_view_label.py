"""CG Calibration -- 2026-10-26, Chris: "For calibrator, on their AI+ check-in for calibration, name it as CG Calibration
rather than BU Calibration ... Only those tagged as BUCEO will see BU naming when it goes to AI+ Calibration."

The view KEY stays "bu"; its short name and title are per login (`_view_short` / `_view_title`, Help's `_help_view_label`):
  * a login with a calibration group and no BU CEO seat reads CG / "CG Calibration"
  * a BU CEO, and a BU CEO who also calibrates a group, keep BU / "Business unit calibration"
  * the page's view list, Ask OneHR's view lines and Help's label follow
"""
import os
import html
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A pure calibrator reads CG Calibration; a BU CEO keeps BU")
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


_avail, _assist = a.ai_draft.review_agent_available, a._calib_assist_on
a.ai_draft.review_agent_available = lambda: True   # the leader views need a reachable model, and the assistant on
a._calib_assist_on = lambda u_: True
try:
    r = C_SU.post("/admin/leaders", data=dict(csrf_token="tok", action="bu_group_save", bg=BG, tab="buceo", company=CO,
                                              name="ZZBUG Finance", group_dept=[FIN], calibrator_id=str(CFO)),
                  follow_redirects=True)
    with a.app.app_context():
        db = a.get_db()
        gid = H.one(a, "SELECT id FROM calib_bu_groups WHERE business_group=?", (BG,))
        s.check("fixture: the group exists with the CFO as calibrator", bool(gid), flashes(r)[:120])
        tiers = a.calibration_tier_of(db, a.get_user(CFO) if hasattr(a, "get_user") else db.execute(
            "SELECT * FROM users WHERE id=?", (CFO,)).fetchone())
        s.check("fixture: the CFO holds only the group tier", [t for t, _k in tiers] == ["bugrp"], tiers)
        U_CFO = db.execute("SELECT * FROM users WHERE id=?", (CFO,)).fetchone()
        U_CEO = db.execute("SELECT * FROM users WHERE id=?", (CEO,)).fetchone()
        s.section("the helpers")
        s.check("a pure calibrator: short CG, title CG Calibration",
                (a._view_short(db, U_CFO, "bu"), a._view_title(db, U_CFO, "bu")) == ("CG", "CG Calibration"),
                (a._view_short(db, U_CFO, "bu"), a._view_title(db, U_CFO, "bu")))
        s.check("...only for the bu view (dept / bg keep their words)",
                a._view_short(db, U_CFO, "bg") == "BG" and a._view_title(db, U_CFO, "dept") == "Department Review")
        s.check("a BU CEO: BU / Business unit calibration",
                (a._view_short(db, U_CEO, "bu"), a._view_title(db, U_CEO, "bu")) == ("BU", "Business unit calibration"))
        s.check("Help's label follows: CG for the calibrator, BU for the BU CEO",
                a._help_view_label(db, U_CFO, "bu") == "CG" and a._help_view_label(db, U_CEO, "bu") == "BU")
        # the same person with a BU CEO seat as well keeps BU
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, HQ, CFO))
        db.commit()
        U_CFO2 = db.execute("SELECT * FROM users WHERE id=?", (CFO,)).fetchone()
        tt = sorted(t for t, _k in a.calibration_tier_of(db, U_CFO2))
        s.check("fixture: now a BU CEO and a calibrator", tt == ["buceo", "bugrp"], tt)
        s.check("a BU CEO who also calibrates keeps BU",
                (a._view_short(db, U_CFO2, "bu"), a._view_title(db, U_CFO2, "bu")) == ("BU", "Business unit calibration"))
        s.check("...and Help's label is BU", a._help_view_label(db, U_CFO2, "bu") == "BU")
        db.execute("DELETE FROM buceo_seats WHERE user_id=? AND company=?", (CFO, HQ))
        db.commit()
    s.section("over HTTP: Help and the page, for the calibrator and the BU CEO")
    q = {"ep": "review_journey", "view": "bu", "stage": "calibration"}
    hc_ = C_CFO.get("/help/answers", query_string=q).get_json() or {}
    hb_ = C_CEO.get("/help/answers", query_string=q).get_json() or {}
    s.check("Help's heading and where-line say CG for the calibrator", str(hc_.get("label", "")).startswith("CG · ")
            and "CG" in str(hc_.get("where", "")) and "BU" not in str(hc_.get("where", "")), (hc_.get("label"), hc_.get("where")))
    s.check("...and BU for the BU CEO", str(hb_.get("label", "")).startswith("BU · "), hb_.get("label"))
    pg_c = C_CFO.get("/review/journey?view=bu").get_data(as_text=True)
    pg_b = C_CEO.get("/review/journey?view=bu").get_data(as_text=True)
    s.check("the calibrator's page carries the CG view (short and title), key still bu",
            'href="/review/journey?view=bu"' in pg_c and 'title="CG Calibration">CG</a>' in pg_c
            and 'Business unit calibration' not in pg_c, (len(pg_c), pg_c.count("CG")))
    s.check("the BU CEO's page carries BU / Business unit calibration",
            'title="Business unit calibration">BU</a>' in pg_b and "CG Calibration" not in pg_b, len(pg_b))
    s.section("the page")
    src = H.source(a)
    s.check("the views list the page gets goes through the per-login helpers",
            '"short": _view_short(db, u, v), "title": _view_title(db, u, v)' in src
            and '"short": _VIEW_SHORT[v]' not in src)
finally:
    a.ai_draft.review_agent_available, a._calib_assist_on = _avail, _assist
    with a.app.app_context():
        _cleanup(a.get_db())
sys.exit(s.done())
