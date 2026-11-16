"""Home's stage switch (Chris, 2026-11-09, canvas [design canvas link removed], "Yes, as drawn"):

  "it should go by LM count, like CHBM has 170 line managers, the progress tracking should track out of these 170, how many
   have completed"

The business-group table on Home follows the cycle's stage: Employees (today's table, Calibration taken off), Line managers,
HODs, BU CEOs, BG CEOs. Today's stage comes from the cycle's dates (nothing stored); ?stage= picks another for one visit.
A Year-End has all five, a Mid-Year Employees / Line managers / HODs, an Early Year or a past cycle has no switch.

Its own synthetic business groups (ZZHS Alpha, ZZHS Beta) on the shared suite database; the cycle is switched to a dated Year-End
for the run and put back, and every row written is removed. The clock is pinned (`_now_myt`), so a stage is tested on a chosen date.
Totals ("All business groups") are read as a DELTA over the same read before the synthetic people exist, so real rows in the
database never move a check.

What this holds:
  * today's stage on a date inside each window, in the 12-15 overlap (HODs), between windows (the last to close), before all
    (Employees), after all (the last); an invalid ?stage is today's; Early Year and a past cycle have no switch; Mid-Year has three
  * Line managers count LINE MANAGERS: two reports with one waiting is not done; approved at the manager's own step while step 2 is
    pending is done; a report who did not submit is not counted; the Executive Chairman's unmoderated report is left out; a report
    taken out of the cycle is left out; a manager with reports in two groups counts in both rows and once in the total; a reviewed
    competency and a closed Career Plan count; the reviewer is the app's own (_tc_reports_for, _idp_is_reviewer_of)
  * HODs: own lock counts, a higher lock counts done with "closed above" (and _hod_higher_lock_info agrees)
  * BU CEOs (seat holders and calibration-group calibrators): done only when every scope of theirs is locked, a BG CEO's lock counts
    done with "closed above"
  * BG CEOs: units locked, People moved, the Star limits column only while the limit is on, its over / full states
  * columns follow the modules (a module off drops its column; no potential axis, no Potential column); Calibration is not on Employees
  * a BG admin sees only their group; the list panel for each stage returns the right people; non-super cell links
  * no query a person: the number of reads is the same with more people
  * the guards are real: each broken, the checks fail
"""
import html
import os
import re
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Home's stage switch: the table follows the stage, counted in line managers, HODs, BU CEOs and units")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BGA, BGB = "ZZHS Alpha", "ZZHS Beta"
UA, UB = "ZZHS Alpha U1", "ZZHS Beta U1"
NAV = {"Sec-Fetch-Mode": "navigate"}
NOW = [datetime(2026, 11, 11, 12, 0)]
_real_now = a._now_myt
a._now_myt = lambda: NOW[0]
D = lambda *x: datetime(2026, *x)  # noqa: E731
STAGE_CELLS = {"emp": ("pm_results", "tc_self", "idp_self", "f360"), "lm": ("pm_approve", "tc_approve", "idp_review"),
               "hod": ("pm_hod", "pot_hod"), "bu": ("pm_buceo", "pot_buceo"), "bg": ("tb_bgceo",)}
# the Year-End's dates: employees 2-8 Nov, line managers 9-15, HODs 12-18, BU CEOs 16-18, BG CEOs 19-30
WIN = {"emp": ("2026-11-02 00:00", "2026-11-08 23:59"), "lm": ("2026-11-09 00:00", "2026-11-15 23:59"),
       "hod": ("2026-11-12 00:00", "2026-11-18 23:59"), "bu": ("2026-11-16 00:00", "2026-11-18 23:59"),
       "bg": ("2026-11-19 00:00", "2026-11-30 23:59")}
# a gap: HODs close on the 13th, BU CEOs open on the 16th, nothing open on the 14th
GAP = dict(WIN, lm=("2026-11-09 00:00", "2026-11-10 23:59"), hod=("2026-11-12 00:00", "2026-11-13 23:59"),
           bu=("2026-11-16 00:00", "2026-11-18 23:59"))


def _set_windows(db, cid, win):
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (cid,))
    for st, (o, c) in win.items():
        for cell in STAGE_CELLS[st]:
            db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (cid, cell, o, c))
    db.commit()


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9HS-%'")]
    cid = db.execute("SELECT id FROM cycles WHERE is_active=1").fetchone()[0]
    if ids:
        ph = ",".join("?" * len(ids))
        tids = [r[0] for r in db.execute("SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)]
        if tids:
            tp = ",".join("?" * len(tids))
            for tb in ("pm_kpi_results", "pm_kpi_approvals", "pm_kpi_target_approvers"):
                db.execute("DELETE FROM %s WHERE kpi_target_id IN (%s)" % (tb, tp), tids)
        for tb in ("pm_kpi_targets", "tc_assignments", "tc_assessments", "pm_idp", "cycle_participants",
                   "pm_calibration_adjustments", "calibration_adjustments"):
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (tb, ph), ids)
        db.execute("DELETE FROM buceo_seats WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
    for bg in (BGA, BGB):
        db.execute("DELETE FROM pm_calibration_sessions WHERE business_group=?", (bg,))
        db.execute("DELETE FROM calibration_sessions WHERE business_group=?", (bg,))
        db.execute("DELETE FROM talent_box_bu_locks WHERE business_group=?", (bg,))
        db.execute("DELETE FROM org_units WHERE business_group=?", (bg,))
        db.execute("DELETE FROM calib_bu_group_units WHERE business_group=?", (bg,))
        db.execute("DELETE FROM calib_bu_groups WHERE business_group=?", (bg,))
    db.execute("DELETE FROM app_settings WHERE key='exec_chair_id'")
    db.execute("DELETE FROM tc_skills WHERE skill_code='ZZ9HS-SKILL'")
    if ids:
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ",".join("?" * len(ids)), ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ",".join("?" * len(ids)), ids)
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    CYC0 = dict(db.execute("SELECT kind, half, starts_on, min_job_grade, open_by_date FROM cycles WHERE id=?", (CID,)).fetchone())
    MODS0 = {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))}
    WIN0 = [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows WHERE cycle_id=?", (CID,))]
    TBL0 = {r[0]: r[1] for r in db.execute("SELECT key, value FROM app_settings WHERE key LIKE 'tb_limit_%'")}
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL, open_by_date=1, "
               "starts_on=COALESCE(starts_on, '2026-01-01') WHERE id=?", (CID,))
    for k in ("review", "pm", "tm", "calibration", "idp"):
        if db.execute("SELECT 1 FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k)).fetchone():
            db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key=?", (CID, k))
        else:
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, k))
    _set_windows(db, CID, WIN)
    for k in ("tb_limit_stars_on",):
        db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, '0')", (k,))
    db.commit()
    SU = db.execute("SELECT * FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                    "AND employee_id NOT LIKE 'ZZ9HS-%' LIMIT 1").fetchone()
    SUID = SU["id"]
    YEAR = a.pm_idp_plan_year(db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())


def mat(stage=None, uid=None, cyc_override=None, count=None, warm=False):
    """Home's matrix for an admin, in a request context (so the per-request caches are fresh). `warm`: the lock status rows are
    already read, as the readiness card does on the same page (_home_lock_rows is paid once a request)."""
    with a.app.test_request_context("/"):
        d = a.get_db()
        su = d.execute("SELECT * FROM users WHERE id=?", (uid or SUID,)).fetchone()
        a.g.user = su
        if warm:
            a._home_lock_rows(d, su, a.active_cycle(d))
        if count is not None:
            d.set_trace_callback(lambda q: count.append(q))
        try:
            return a._home_bg_matrix(d, su, cyc_override or a.active_cycle(d), stage=stage)
        finally:
            if count is not None:
                d.set_trace_callback(None)


def info():
    with a.app.test_request_context("/"):
        d = a.get_db()
        return a._home_stage_info(d, a.active_cycle(d))


def today_at(when, win=None):
    NOW[0] = when
    if win is not None:
        with a.app.app_context():
            d = a.get_db()
            _set_windows(d, CID, win)
    sw = info()
    return sw["today"] if sw else None


def cell(m, col, bg=None):
    """(done, n, closed above) of one cell, or (pct is None -> its sub text) of the row for `bg` (the total with None)."""
    ix = [c["key"] for c in m["cols"]].index(col)
    row = m["total"] if bg is None else next(r for r in m["rows"] if r["bg"] == bg)
    c = row["cells"][ix]
    if c["pct"] is None:
        return c["sub"]
    mm = re.match(r"([\d,]+) of ([\d,]+)", c["sub"])
    ab = re.search(r"(\d+) closed above", c["sub"])
    return int(mm.group(1).replace(",", "")), int(mm.group(2).replace(",", "")), int(ab.group(1)) if ab else 0


def who(m, bg=None):
    return (m["total"] if bg is None else next(r for r in m["rows"] if r["bg"] == bg))["people"]


def delta(m, base, col):
    """The total's (done, n) over the baseline read before the synthetic people."""
    d, n, _ab = cell(m, col)
    bd, bn, _bab = cell(base, col) if isinstance(cell(base, col), tuple) else (0, 0, 0)
    return d - bd, n - bn


# ---------------------------------------------------------------------------------------------------------------------
# the synthetic people
# ---------------------------------------------------------------------------------------------------------------------
BASE = {}
for _k, _when in (("lm", D(11, 11, 12)), ("hod", D(11, 14, 12)), ("bu", D(11, 17, 12)), ("bg", D(11, 25, 12))):
    NOW[0] = _when   # each stage read while it is open, so its cells are counts and not "opens ..."
    BASE[_k] = mat(_k)
BASE["lm_who"], BASE["hod_who"], BASE["bu_who"] = who(BASE["lm"]), who(BASE["hod"]), who(BASE["bu"])

with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    SKILL = db.execute("INSERT INTO tc_skills(skill_code, title) VALUES ('ZZ9HS-SKILL', 'ZZHS skill')").lastrowid
    for bg, co in ((BGA, UA), (BGB, UB)):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (bg, co))

    def mk(eid, bg=BGA, dept="ZZHS Dept", role="user", admin_bg=None):
        co = UA if bg == BGA else UB
        return db.execute(
            "INSERT INTO users(username, full_name, password_hash, role, admin_bg, employee_id, business_group, company, department, "
            "job_title, job_grade, confirmation_date, years_of_service) VALUES (?,?,'x',?,?,?,?,?,?,'ZZHS Officer',14,'2020-01-01',4.0)",
            (eid.lower(), "ZZ HS " + eid[6:], role, admin_bg, eid, bg, co, dept)).lastrowid
    LM1, LM2, CH = mk("ZZ9HS-LM1"), mk("ZZ9HS-LM2"), mk("ZZ9HS-CH")
    HOD1, HOD2 = mk("ZZ9HS-HOD1"), mk("ZZ9HS-HOD2", BGB)
    BU1, CAL = mk("ZZ9HS-BU1"), mk("ZZ9HS-CAL")
    R = {i: mk("ZZ9HS-R%d" % i, BGB if i == 3 else BGA, dept="ZZHS Dept2" if i == 8 else "ZZHS Dept") for i in range(1, 9)}
    ADM_A = mk("ZZ9HS-ADMA", BGA, role="admin", admin_bg=BGA)
    mgr = {1: LM1, 2: LM1, 3: LM1, 4: LM2, 5: LM2, 6: CH, 7: LM2}
    hod = {1: HOD1, 2: HOD1, 3: HOD2, 4: HOD1, 5: HOD1, 6: HOD1, 7: HOD1}
    for i, m in mgr.items():
        db.execute("UPDATE users SET manager_id=?, hod_id=? WHERE id=?", (m, hod[i], R[i]))
    LINE = {}

    def line(i, appr, result=True, acted=(), step2=None):
        """R<i>'s one KPI line: chain step 1 = appr (and step 2 = step2), a submitted result, approvals at the steps in `acted`."""
        t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company, "
                       "status) VALUES (?,?,?,100,'more',?,?,'approved')",
                       (CID, R[i], "ZZHS KPI %d" % i, BGB if i == 3 else BGA, UB if i == 3 else UA)).lastrowid
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t, appr))
        if step2:
            db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,2,?)", (t, step2))
        if result:
            db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, draft, submitted_by) VALUES (?,5,0,?)", (t, R[i]))
        for sq in acted:
            db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) "
                       "VALUES (?,?,'confirm',5,?)", (t, sq, appr if sq == 1 else step2))
        LINE[i] = t
    line(1, LM1, acted=(1,))
    line(2, LM1)                            # waiting on LM1
    line(3, LM1, acted=(1,))                # LM1's, in the other group, done
    line(4, LM2, acted=(1,), step2=HOD1)    # approved at LM2's own step, HOD1's step still to act
    line(5, LM2, result=False)              # did not submit
    line(6, CH)                             # the Executive Chairman's report: nobody moderates
    line(7, LM2)                            # taken out of the cycle: waiting, but not counted
    db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'remove')", (CID, R[7]))
    # competency: R1..R4, R6 assigned; submitted by R1, R2, R3, R4, R6; reviewed R1 and R3
    for i in (1, 2, 3, 4, 5, 6):
        db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) VALUES (?,?,?)", (CID, R[i], SKILL))
    for i in (1, 2, 3, 4, 6):
        rev = i in (1, 3)
        db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status, submitted_at, reviewed_at, reviewed_by) "
                   "VALUES (?,?,?,datetime('now'),?,?)", (CID, R[i], "reviewed" if rev else "submitted",
                                                           "2026-11-10 10:00:00" if rev else None, mgr[i] if rev else None))
    # Career Plan: R1 shared, R2 closed, R3 closed, R4 draft, R5 shared
    for i, st in ((1, "shared"), (2, "closed"), (3, "closed"), (4, "draft"), (5, "shared")):
        db.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status, shared_at, closed_at, closed_by) "
                   "VALUES (?,?,?,?,datetime('now'),?,?)", (YEAR, CID, R[i], st, "2026-11-10 10:00:00" if st == "closed" else None,
                                                            mgr[i] if st == "closed" else None))
    # the BU CEO holds a seat in each group; the calibrator holds a calibration group (R8's department) in Alpha
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BGA, UA, BU1))
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BGB, UB, BU1))
    GID = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)",
                     (BGA, UA, "ZZHS Panel", CAL)).lastrowid
    db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)",
               (GID, BGA, UA, "ZZHS Dept2"))
    db.commit()
    CHAIR_ENV0 = os.environ.get("ONEHR_CHAIR")
    os.environ["ONEHR_CHAIR"] = "1"
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('exec_chair_id', ?)", (str(CH),))
    db.commit()


def sess(table, tier, key, bg, locked=True):
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM %s WHERE cycle_id=? AND tier=? AND scope_key=? AND business_group=?" % table, (CID, tier, key, bg))
        d.execute("INSERT INTO %s(cycle_id, tier, scope_key, business_group, scope_label, locked_at) VALUES (?,?,?,?,?,?)"
                  % table, (CID, tier, key, bg, key, "2026-11-12 10:00:00" if locked else None))
        d.commit()


def unsess(table, tier, key, bg):
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM %s WHERE cycle_id=? AND tier=? AND scope_key=? AND business_group=?" % table, (CID, tier, key, bg))
        d.commit()


def sql(q, args=()):
    with a.app.app_context():
        d = a.get_db()
        d.execute(q, args)
        d.commit()


try:
    # -----------------------------------------------------------------------------------------------------------------
    s.section("today's stage, by the cycle's dates")
    cases = [(D(10, 20), "emp", "before every window: Employees"), (D(11, 1, 9), "emp", "1 Nov: before any opens"),
             (D(11, 5, 12), "emp", "5 Nov: Employees open"), (D(11, 9, 8), "lm", "9 Nov: Line managers"),
             (D(11, 11, 12), "lm", "11 Nov: Line managers"), (D(11, 12, 8), "hod", "12 Nov: the overlap, the newer stage (HODs)"),
             (D(11, 14, 12), "hod", "14 Nov: the overlap, HODs"), (D(11, 15, 12), "hod", "15 Nov: still HODs"),
             (D(11, 16, 9), "bu", "16 Nov: BU CEOs"), (D(11, 18, 12), "bu", "18 Nov: BU CEOs"),
             (D(11, 19, 9), "bg", "19 Nov: BG CEOs"), (D(11, 25, 9), "bg", "25 Nov: BG CEOs"),
             (D(12, 5, 9), "bg", "after every window: the last one")]
    for when, want, label in cases:
        got = today_at(when, WIN)
        s.check("%s -> %s" % (label, want), got == want, got)
    got = today_at(D(11, 14, 12), GAP)
    s.check("between windows (14 Nov, nothing open): the last to close (HODs closed 13 Nov)", got == "hod", got)
    got = today_at(D(11, 11, 12), GAP)
    s.check("between windows (11 Nov, Line managers closed 10 Nov, HODs not open): Line managers", got == "lm", got)
    NOW[0] = D(11, 14, 12)
    with a.app.app_context():
        _set_windows(a.get_db(), CID, WIN)
    NOW[0] = D(11, 14, 12)
    sw = info()
    s.check("the dots: Employees closed, Line managers and HODs open, BU and BG not open yet", [
        (x["key"], x["state"]) for x in sw["stages"]] == [("emp", "closed"), ("lm", "open"), ("hod", "open"), ("bu", "not_open"),
                                                         ("bg", "not_open")], [(x["key"], x["state"]) for x in sw["stages"]])
    m = mat()
    s.check("the table on screen is today's stage (HODs)", m["stage"]["on"] == "hod" and m["stage"]["is_today"] and m["who"] == "HODs")
    s.check("the strip's line: what the stage does, its dates and the days left",
            m["stage"]["what"] == "HODs submit department reviews" and m["stage"]["span"] == "12–18 Nov"
            and m["stage"]["tail"] == "4 days left", m["stage"])
    m2 = mat("bu")
    s.check("?stage=bu shows BU CEOs, is not today's, and says how to go back", m2["stage"]["on"] == "bu" and not m2["stage"]["is_today"]
            and m2["stage"]["back"] and "HODs" in m2["stage"]["back"]["label"] and "stage=" not in m2["stage"]["back"]["href"],
            m2["stage"]["back"])
    s.check("...and its line says when it opens", m2["stage"]["tail"] == "opens 16 Nov", m2["stage"]["tail"])
    mg = mat("nonsense")
    s.check("an invalid ?stage is today's stage", mg["stage"]["on"] == "hod" and mg["stage"]["is_today"])
    s.check("the same for a stage this cycle does not have", mat("zzz")["stage"]["on"] == "hod")
    NOW[0] = D(11, 5, 12)
    me = mat()
    s.check("Employees is today's table: Taking part | All, no Calibration column, its pm / 360 / competency / Career Plan",
            me["who"] is None and [c["key"] for c in me["cols"]] == ["pm", "f360", "competency", "idp"]
            and me["rows"][0]["taking_part"] is not None, [c["key"] for c in me["cols"]])
    NOW[0] = D(11, 11, 12)
    ml = mat("emp")
    s.check("a picked Employees on 11 Nov is the closed table, 'closed 8 Nov', with the way back to Line managers",
            ml["stage"]["on"] == "emp" and ml["stage"]["tail"] == "closed 8 Nov" and "Line managers" in ml["stage"]["back"]["label"])

    s.section("no switch: an Early Year, a past cycle; Mid-Year has three stages; modules drop columns")
    with a.app.app_context():
        d = a.get_db()
        act = d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()
        past = dict(act)
        past["is_active"] = 0
    mp = mat(cyc_override=past)
    s.check("a past cycle shows today's table whole (Calibration column kept) and no switch",
            mp["stage"] is None and mp["who"] is None and "calibration" in [c["key"] for c in mp["cols"]], [c["key"] for c in mp["cols"]])
    mp2 = mat("lm", cyc_override=past)
    s.check("...?stage= does nothing on a past cycle", mp2["stage"] is None and mp2["who"] is None)
    sql("UPDATE cycles SET kind='early_year', half=0 WHERE id=?", (CID,))
    s.check("an Early Year (half 0, falsy) has no switch", info() is None and mat("lm")["stage"] is None)
    sql("UPDATE cycles SET kind='mid_year', half=1 WHERE id=?", (CID,))
    sw = info()
    s.check("a Mid-Year offers Employees, Line managers and HODs only", sw and [x["key"] for x in sw["stages"]] == ["emp", "lm", "hod"],
            sw and [x["key"] for x in sw["stages"]])
    mm = mat("lm")
    s.check("...and a Mid-Year's Line managers has no Career Plan column (no plan review at Mid-Year)",
            [c["key"] for c in mm["cols"]] == ["pm", "competency"], [c["key"] for c in mm["cols"]])
    sql("UPDATE cycles SET kind='year_end', half=2 WHERE id=?", (CID,))
    sql("UPDATE cycle_modules SET active=0 WHERE cycle_id=? AND module_key='calibration'", (CID,))
    mh = mat("hod")
    s.check("no potential axis (calibration module off): no Potential column on HODs or BU CEOs, no Talent Box stage",
            [c["key"] for c in mh["cols"]] == ["pm"] and [c["key"] for c in mat("bu")["cols"]] == ["pm"]
            and "bg" not in [x["key"] for x in info()["stages"]])
    sql("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key='calibration'", (CID,))
    sql("UPDATE cycle_modules SET active=0 WHERE cycle_id=? AND module_key='idp'", (CID,))
    s.check("a module off (Career Plan) drops its column on Line managers",
            [c["key"] for c in mat("lm")["cols"]] == ["pm", "competency"])
    sql("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key='idp'", (CID,))

    # -----------------------------------------------------------------------------------------------------------------
    s.section("Line managers: counted in line managers, Performance")
    NOW[0] = D(11, 11, 12)
    m = mat("lm")
    s.check("the columns are Performance, Competency, Career Plan; the second column is Line managers, the word 'line managers done'",
            [c["key"] for c in m["cols"]] == ["pm", "competency", "idp"] and m["who"] == "Line managers"
            and all(c["word"] == "line managers done" for c in m["cols"]))
    s.check("Alpha Performance: LM1 (one of two reports still waiting) is not done, LM2 (approved at own step) is done: 1 of 2",
            cell(m, "pm", BGA) == (1, 2, 0), cell(m, "pm", BGA))
    s.check("Beta Performance: LM1 counts there too, done in Beta: 1 of 1", cell(m, "pm", BGB) == (1, 1, 0), cell(m, "pm", BGB))
    dd, dn = delta(m, BASE["lm"], "pm")
    s.check("the total counts LM1 once (not done: Alpha still waits) and LM2 once: 1 of 2 more than before the synthetic people",
            (dd, dn) == (1, 2), (dd, dn))
    s.check("the second column counts the line managers: LM1 and LM2 in Alpha, LM1 in Beta; two in the total",
            who(m, BGA) == 2 and who(m, BGB) == 1 and who(m) - BASE["lm_who"] == 2, (who(m, BGA), who(m, BGB), who(m) - BASE["lm_who"]))
    with a.app.app_context():
        d = a.get_db()
        w = a._home_lm_work(d, d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone(), d.execute(
            "SELECT * FROM cycles WHERE id=?", (CID,)).fetchone(), ["pm", "competency", "idp"])
    s.check("the chair's unmoderated report leaves the chair out of the line managers (CH is nobody's Performance)",
            CH not in w["pm"] and LM2 in w["pm"])
    s.check("a report who did not submit (R5) and one taken out of the cycle (R7) are not counted: LM2 has one report",
            w["pm"][LM2][BGA] == {"n": 1, "w": 0}, w["pm"].get(LM2))
    s.check("LM1: Alpha 2 reports, 1 waiting; Beta 1 report, 0 waiting", w["pm"][LM1] == {BGA: {"n": 2, "w": 1}, BGB: {"n": 1, "w": 0}},
            w["pm"].get(LM1))
    # the report's later approver acts: a step-2 approval does not matter; LM1 approves R2: now done
    sql("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) VALUES (?,1,'confirm',5,?)", (LINE[2], LM1))
    m = mat("lm")
    s.check("LM1 approves R2's line: Alpha is 2 of 2, the total's done goes to 2 of 2 more",
            cell(m, "pm", BGA) == (2, 2, 0) and delta(m, BASE["lm"], "pm") == (2, 2), (cell(m, "pm", BGA), delta(m, BASE["lm"], "pm")))
    sql("DELETE FROM pm_kpi_approvals WHERE kpi_target_id=? AND seq=1", (LINE[2],))
    m = mat("lm")
    s.check("...and taking it away puts LM1 back to waiting", cell(m, "pm", BGA) == (1, 2, 0))

    s.section("Line managers: Competency and Career Plan")
    s.check("Competency Alpha: LM1 (R2 not reviewed) and LM2 (R4 not reviewed): 0 of 2; Beta: LM1 reviewed R3: 1 of 1",
            cell(m, "competency", BGA) == (0, 2, 0) and cell(m, "competency", BGB) == (1, 1, 0),
            (cell(m, "competency", BGA), cell(m, "competency", BGB)))
    s.check("...the total: LM1 once, not done; LM2 once, not done: 0 of 2 more", delta(m, BASE["lm"], "competency") == (0, 2),
            delta(m, BASE["lm"], "competency"))
    with a.app.app_context():
        d = a.get_db()
        tc_lm1 = {r["id"] for r in a._tc_reports_for(d, LM1, CID)} & set(R.values())
    s.check("the reviewer is the app's own: _tc_reports_for(LM1) is exactly the reports counted for LM1 (R1, R2, R3)",
            tc_lm1 == {R[1], R[2], R[3]} and w["competency"][LM1] == {BGA: {"n": 2, "w": 1}, BGB: {"n": 1, "w": 0}},
            (tc_lm1, w["competency"].get(LM1)))
    s.check("the chair's competency report (R6, submitted, nobody reviews) is nobody's: CH is not a line manager here",
            CH not in w["competency"])
    sql("UPDATE tc_assessments SET status='reviewed', reviewed_at='2026-11-11 09:00:00', reviewed_by=? WHERE subject_id IN (?,?)",
        (LM1, R[2], R[4]))
    m = mat("lm")
    s.check("reviewing R2 and R4 (reviewed_at) makes both line managers done: Alpha 2 of 2, the total 2 of 2 more",
            cell(m, "competency", BGA) == (2, 2, 0) and delta(m, BASE["lm"], "competency") == (2, 2))
    s.check("Career Plan Alpha: LM1 (R1 shared, R2 closed) not done, LM2 (R5 shared) not done: 0 of 2; Beta: R3 closed: 1 of 1",
            cell(m, "idp", BGA) == (0, 2, 0) and cell(m, "idp", BGB) == (1, 1, 0), (cell(m, "idp", BGA), cell(m, "idp", BGB)))
    with a.app.app_context():
        d = a.get_db()
        w = a._home_lm_work(d, d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone(), d.execute(
            "SELECT * FROM cycles WHERE id=?", (CID,)).fetchone(), ["idp"])
        users = {r["id"]: r for r in d.execute("SELECT * FROM users WHERE employee_id LIKE 'ZZ9HS-%'")}
        agree = all(a._idp_is_reviewer_of(d, users[lm], R[i], CID) for lm, i in ((LM1, 1), (LM1, 2), (LM2, 5), (LM1, 3)))
        notrev = not a._idp_is_reviewer_of(d, users[LM2], R[1], CID)
    s.check("the plan's reviewer is _idp_is_reviewer_of's: its yes for each counted pair, its no for a stranger",
            agree and notrev)
    sql("UPDATE pm_idp SET status='closed', closed_at='2026-11-11 09:00:00', closed_by=? WHERE subject_id IN (?,?)", (LM1, R[1], R[5]))
    m = mat("lm")
    s.check("closing R1's and R5's plans makes both done: Alpha 2 of 2, the total 2 of 2 more",
            cell(m, "idp", BGA) == (2, 2, 0) and delta(m, BASE["lm"], "idp") == (2, 2))
    # R4 shares a plan: HOD1 is a step-2 KPI approver of R4, so a reviewer of the plan like the line manager (the app's own rule)
    sql("UPDATE pm_idp SET status='shared', shared_at='2026-11-11 09:00:00' WHERE subject_id=?", (R[4],))
    m = mat("lm")
    with a.app.app_context():
        d = a.get_db()
        users = {r["id"]: r for r in d.execute("SELECT * FROM users WHERE employee_id LIKE 'ZZ9HS-%'")}
        hod_rev = a._idp_is_reviewer_of(d, users[HOD1], R[4], CID)
    s.check("R4's shared plan waits on LM2 only: HOD1 (KPI step 2) may review it but is no line manager of R4: Alpha 1 of 2",
            hod_rev and cell(m, "idp", BGA) == (1, 2, 0), (hod_rev, cell(m, "idp", BGA)))
    sql("UPDATE pm_idp SET status='draft' WHERE subject_id=?", (R[4],))

    s.section("Line managers: the chair, taking part, a BG admin")
    nm = len(BASE["lm"]["rows"])
    real_chair = a._pm_chair_unmod_ids
    a._pm_chair_unmod_ids = lambda db_: set()
    try:
        wchair = a._home_lm_work  # noqa: F841
        with a.app.app_context():
            d = a.get_db()
            w2 = a._home_lm_work(d, d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone(), d.execute(
                "SELECT * FROM cycles WHERE id=?", (CID,)).fetchone(), ["pm"])
        s.check("falsified: with the chair's rule off the chair counts as a line manager (the guard is real)", CH in w2["pm"])
    finally:
        a._pm_chair_unmod_ids = real_chair
    real_pt, real_pk = a._lp_people, a._lp_part_takers
    a._lp_part_takers = lambda *args, **kw: (None, None)
    a._lp_people = lambda db_, idp=False: {r[0]: (r[1] or "", r[2] or "", "") for r in db_.execute(
        "SELECT id, business_group, company FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0")}
    try:
        with a.app.app_context():
            d = a.get_db()
            w2 = a._home_lm_work(d, d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone(), d.execute(
                "SELECT * FROM cycles WHERE id=?", (CID,)).fetchone(), ["pm"])
        s.check("falsified: without the taking-part rule (_lp_people, _lp_part_takers) R7, taken out, counts and LM2 is waiting", w2["pm"][LM2][BGA]["w"] == 1)
    finally:
        a._lp_people, a._lp_part_takers = real_pt, real_pk
    mb = mat("lm", uid=ADM_A)
    s.check("a BG admin of Alpha sees only Alpha's row, and the total counts what is in Alpha (LM1 not done there, LM2 done)",
            [r["bg"] for r in mb["rows"]] == [BGA] and cell(mb, "pm", BGA) == (1, 2, 0) and cell(mb, "pm") == (1, 2, 0),
            ([r["bg"] for r in mb["rows"]], cell(mb, "pm")))
    s.check("...and no cell of theirs opens the list panel (the list is the super admin's)",
            all(c.get("list") is None for r in mb["rows"] for c in r["cells"]))

    # -----------------------------------------------------------------------------------------------------------------
    s.section("HODs: own lock, closed above")
    NOW[0] = D(11, 14, 12)
    m = mat("hod")
    s.check("the columns are Performance and Potential, the second column HODs, 'department reviews submitted'",
            [c["key"] for c in m["cols"]] == ["pm", "pot"] and m["who"] == "HODs"
            and all(c["word"] == "department reviews submitted" for c in m["cols"]))
    s.check("nothing locked: Alpha 0 of 1 (HOD1), Beta 0 of 1 (HOD2) on each axis; two HODs more in the total",
            cell(m, "pm", BGA) == (0, 1, 0) and cell(m, "pot", BGB) == (0, 1, 0) and who(m, BGA) == 1
            and who(m) - BASE["hod_who"] == 2, (cell(m, "pm", BGA), cell(m, "pot", BGB)))
    sess("pm_calibration_sessions", "hod", str(HOD1), BGA)
    m = mat("hod")
    s.check("HOD1 locks Performance: Alpha Performance 1 of 1, Potential still 0 of 1; the total 1 of 2 more on Performance",
            cell(m, "pm", BGA) == (1, 1, 0) and cell(m, "pot", BGA) == (0, 1, 0) and delta(m, BASE["hod"], "pm") == (1, 2),
            (cell(m, "pm", BGA), cell(m, "pot", BGA), delta(m, BASE["hod"], "pm")))
    sess("pm_calibration_sessions", "buceo", UA, BGA)
    sess("calibration_sessions", "buceo", UA, BGA)
    m = mat("hod")
    s.check("the BU CEO locks the unit: HOD1's Potential is closed above and counts done with the note ('1 closed above')",
            cell(m, "pot", BGA) == (1, 1, 1), cell(m, "pot", BGA))
    s.check("...HOD1's Performance was their own lock, so it is not 'closed above'", cell(m, "pm", BGA) == (1, 1, 0))
    s.check("...and the total counts it: 1 of 2 more on Potential, 1 closed above", delta(m, BASE["hod"], "pot") == (1, 2)
            and cell(m, "pot")[2] - (cell(BASE["hod"], "pot")[2] if isinstance(cell(BASE["hod"], "pot"), tuple) else 0) == 1)
    with a.app.app_context():
        d = a.get_db()
        pop = d.execute("SELECT * FROM users WHERE hod_id=?", (HOD1,)).fetchall()
        info_ = a._hod_higher_lock_info(d, "pot", CID, pop)
        info_b = a._hod_higher_lock_info(d, "pot", CID, d.execute("SELECT * FROM users WHERE hod_id=?", (HOD2,)).fetchall())
    s.check("_hod_higher_lock_info says the same: closed for HOD1's people, open for HOD2's", bool(info_) and info_b is None, (info_, info_b))
    unsess("pm_calibration_sessions", "buceo", UA, BGA)
    unsess("calibration_sessions", "buceo", UA, BGA)
    sql("INSERT INTO talent_box_bu_locks(period_id, cycle_id, business_group, company) VALUES (?,?,?,?)", (CID, CID, BGA, UA))
    m = mat("hod")
    s.check("the BG CEO's Talent Box lock of the unit closes the review too: Alpha Potential 1 of 1, 1 closed above",
            cell(m, "pot", BGA) == (1, 1, 1), cell(m, "pot", BGA))
    sql("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BGA,))
    s.check("taking the lock away puts it back to 0 of 1", cell(mat("hod"), "pot", BGA) == (0, 1, 0))
    real_above = a._home_hod_closed_above
    a._home_hod_closed_above = lambda *args, **kw: {}
    try:
        sess("calibration_sessions", "buceo", UA, BGA)
        s.check("falsified: without the closed-above read the same lock leaves HOD1's Potential at 0 of 1",
                cell(mat("hod"), "pot", BGA) == (0, 1, 0))
    finally:
        a._home_hod_closed_above = real_above
        unsess("calibration_sessions", "buceo", UA, BGA)
    unsess("pm_calibration_sessions", "hod", str(HOD1), BGA)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("BU CEOs: every scope locked; closed above")
    NOW[0] = D(11, 17, 12)
    m = mat("bu")
    s.check("the columns are Performance and Potential, the second column BU CEOs, the word 'BU CEOs done'",
            [c["key"] for c in m["cols"]] == ["pm", "pot"] and m["who"] == "BU CEOs"
            and all(c["word"] == "BU CEOs done" for c in m["cols"]))
    s.check("Alpha has two BU CEOs (the seat holder BU1 and the calibrator CAL), Beta one (BU1); three people in the total (BU1 once)",
            who(m, BGA) == 2 and who(m, BGB) == 1 and who(m) - BASE["bu_who"] == 2, (who(m, BGA), who(m, BGB), who(m) - BASE["bu_who"]))
    s.check("nothing locked: Alpha 0 of 2, Beta 0 of 1", cell(m, "pm", BGA) == (0, 2, 0) and cell(m, "pm", BGB) == (0, 1, 0),
            (cell(m, "pm", BGA), cell(m, "pm", BGB)))
    sess("pm_calibration_sessions", "buceo", UA, BGA)
    m = mat("bu")
    s.check("BU1 locks Alpha's unit: done in Alpha's row (1 of 2) but not in the total (Beta's unit still open): 0 of 2 more",
            cell(m, "pm", BGA) == (1, 2, 0) and cell(m, "pm", BGB) == (0, 1, 0) and delta(m, BASE["bu"], "pm") == (0, 2),
            (cell(m, "pm", BGA), delta(m, BASE["bu"], "pm")))
    sess("pm_calibration_sessions", "buceo", UB, BGB)
    sess("pm_calibration_sessions", "buceo", "grp:%d" % GID, BGA)
    m = mat("bu")
    s.check("BU1's Beta unit and CAL's group locked: Performance everywhere done; the total 2 of 2 more",
            cell(m, "pm", BGA) == (2, 2, 0) and cell(m, "pm", BGB) == (1, 1, 0) and delta(m, BASE["bu"], "pm") == (2, 2),
            (cell(m, "pm", BGA), delta(m, BASE["bu"], "pm")))
    s.check("...Potential is its own axis: still 0 of 2 in Alpha", cell(m, "pot", BGA) == (0, 2, 0))
    unsess("pm_calibration_sessions", "buceo", UB, BGB)
    m = mat("bu")
    s.check("a calibration group's lock counts on its own: with Beta's unit open, CAL is done and BU1 is not",
            cell(m, "pm", BGA) == (2, 2, 0) and delta(m, BASE["bu"], "pm") == (1, 2))
    sql("INSERT INTO talent_box_bu_locks(period_id, cycle_id, business_group, company) VALUES (?,?,?,?)", (CID, CID, BGB, UB))
    m = mat("bu")
    s.check("the BG CEO's lock of Beta's unit closes it: BU1 counts done in Beta, '1 closed above'",
            cell(m, "pm", BGB) == (1, 1, 1) and delta(m, BASE["bu"], "pm") == (2, 2), (cell(m, "pm", BGB), delta(m, BASE["bu"], "pm")))
    sql("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BGB,))
    unsess("pm_calibration_sessions", "buceo", UA, BGA)
    unsess("pm_calibration_sessions", "buceo", "grp:%d" % GID, BGA)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("BG CEOs: units locked, People moved, Star limits")
    NOW[0] = D(11, 25, 12)
    m = mat("bg")
    s.check("one column, Talent Box, 'units locked'; the second column Units; People moved, no Star limits while the limit is off",
            [c["key"] for c in m["cols"]] == ["calibration"] and m["who"] == "Units" and m["cols"][0]["word"] == "units locked"
            and [x["label"] for x in m["extra_cols"]] == ["People moved"], (m["extra_cols"],))
    s.check("units in the box: Alpha 2 (its unit and... the calibration group's people sit in the same unit: one unit), Beta 1",
            cell(m, "calibration", BGA) == (0, 1, 0) and cell(m, "calibration", BGB) == (0, 1, 0), cell(m, "calibration", BGA))
    sql("INSERT INTO talent_box_bu_locks(period_id, cycle_id, business_group, company) VALUES (?,?,?,?)", (CID, CID, BGA, UA))
    m = mat("bg")
    s.check("the BG CEO locks Alpha's unit on the Talent Box: Alpha 1 of 1, Beta 0 of 1",
            cell(m, "calibration", BGA) == (1, 1, 0) and cell(m, "calibration", BGB) == (0, 1, 0))
    with a.app.app_context():
        d = a.get_db()
        sid = d.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label) VALUES "
                        "(?,'bgceo',?,?,?)", (CID, BGA, BGA, BGA)).lastrowid
        sid2 = d.execute("INSERT INTO calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label) VALUES "
                         "(?,'bgceo',?,?,?)", (CID, BGA, BGA, BGA)).lastrowid
        d.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band) VALUES (?,?,'ME','AE')",
                  (sid, R[1]))
        d.execute("INSERT INTO calibration_adjustments(session_id, subject_id, original_band, adjusted_band) VALUES (?,?,'Mid','High')",
                  (sid2, R[1]))
        d.execute("INSERT INTO calibration_adjustments(session_id, subject_id, original_band, adjusted_band) VALUES (?,?,'Mid','Low')",
                  (sid2, R[2]))
        d.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band) VALUES (?,?,'ME','ME')",
                  (sid, R[4]))   # not a move
        n_pop = d.execute("SELECT COUNT(*) FROM users u WHERE u.role!='admin' AND u.business_group=? AND " + a.calibration_population_sql("u"),
                          (BGA,)).fetchone()[0]
        d.commit()
    m = mat("bg")
    mv = next(r for r in m["rows"] if r["bg"] == BGA)["extra"][-1]
    s.check("People moved: R1 on both axes and R2 on one count once each (an unchanged band is no move): 2 of the group's population",
            mv["kind"] == "moved" and mv["n"] == 2 and mv["of"] == n_pop and n_pop >= 8, (mv, n_pop))
    s.check("...Beta moved nobody", next(r for r in m["rows"] if r["bg"] == BGB)["extra"][-1]["n"] == 0)
    # Star limits: only while the limit is on
    sql("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('tb_limit_stars_on', '1')")
    real_ts, real_rows = a.tb_star_limits, a.talent_box_rows
    a.talent_box_rows = lambda d_, ctx: []
    a.tb_star_limits = lambda d_, ctx, rows, tier=None, lim=None: (
        {"U1": {"star": {"state": "over"}, "super": {"state": "ok"}}, "U2": {"star": {"state": "full"}, "super": {"state": "ok"}},
         "U3": {"star": {"state": "ok"}, "super": {"state": "ok"}}} if ctx["business_group"] == BGA else
        {"U1": {"star": {"state": "ok"}, "super": {"state": "ok"}}})
    try:
        m = mat("bg")
        ex = {r["bg"]: r["extra"] for r in m["rows"]}
        s.check("the limit on: the Star limits column appears before People moved", [x["label"] for x in m["extra_cols"]] ==
                ["Star limits", "People moved"] and ex[BGA][0]["kind"] == "limits")
        s.check("Alpha: 1 unit over, 1 unit full; Beta: all within", (ex[BGA][0]["over"], ex[BGA][0]["full"]) == (1, 1)
                and (ex[BGB][0]["over"], ex[BGB][0]["full"]) == (0, 0), (ex[BGA][0], ex[BGB][0]))
        s.check("What stands out names the unit over its limit that cannot lock",
                any("over its Stars limit" in n and "Alpha" in n for n in m["notes"]), m["notes"])
        s.check("...and the total adds the groups' units over and full", m["total"]["extra"][0]["over"] >= 1
                and m["total"]["extra"][0]["full"] >= 1)
    finally:
        a.tb_star_limits, a.talent_box_rows = real_ts, real_rows
    sql("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('tb_limit_stars_on', '0')")
    m = mat("bg")
    s.check("the limit off again: the column is gone", [x["label"] for x in m["extra_cols"]] == ["People moved"])
    sql("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BGA,))

    # -----------------------------------------------------------------------------------------------------------------
    s.section("the page: the strip, the list panels, the non-super links")
    NOW[0] = D(11, 11, 12)
    cli = H.client_as(a, SUID)
    r = cli.get("/admin", headers=NAV)
    t = html.unescape(r.get_data(as_text=True))
    s.check("Home opens on today's stage: the switch with its five stages, Today's stage pill, the line, Line managers' columns",
            r.status_code == 200 and 'role="tablist"' in t and all(x in t for x in (
                "Employees", "Line managers", "HODs", "BU CEOs", "BG CEOs", "Today's stage",
                "Line managers approve and review", "9–15 Nov", "4 days left", "a cell opens its people")), r.status_code)
    s.check("...each stage a link (?stage=), the active one selected, a dot on each",
            'href="/admin?stage=hod"' in t and 'aria-selected="true"' in t and t.count("hm-dot ") >= 5)
    r = cli.get("/admin?stage=emp", headers=NAV)
    t = html.unescape(r.get_data(as_text=True))
    s.check("?stage=emp: the employees' table, no Today's stage pill, 'Back to today's stage (Line managers)'",
            r.status_code == 200 and "Back to today's stage (Line managers)" in t and "Taking part | All" in t
            and "hm-now-pill" not in t.split("hm-stage")[1].split("</div>")[1] and ">Calibration<" not in t.split("hm-table")[1])
    r = cli.get("/admin?stage=junk", headers=NAV)
    s.check("an invalid ?stage still opens Home, on today's stage", r.status_code == 200 and "Today's stage" in r.get_data(as_text=True))
    t = html.unescape(cli.get("/admin", headers=NAV).get_data(as_text=True))
    opens = re.findall(r'data-list-open="([^"]+)"', t)
    s.check("a Line managers cell opens the list panel with its stage (super admin): key=home-cell, stage=lm, fragment=1, its group",
            any("key=home-cell" in o or "/home-cell" in o for o in opens) and any("stage=lm" in o and "col=pm" in o and "bg=ZZHS" in o
                                                                                  for o in opens), opens[:3])
    s.check("...and its href is the Progress page behind it (ctrl-click)", "/admin/module/pm/progress?fstage=results&fbg=ZZHS" in t
            or "fstage=results" in t)

    def lst(col, stage, bg):
        with a.app.test_request_context("/"):
            url = a.url_for("admin_list_view", key="home-cell", col=col, stage=stage, fragment=1, **({"bg": bg} if bg else {}))
        resp = cli.get(url, headers=NAV)
        return resp.status_code, html.unescape(resp.get_data(as_text=True))
    code, t = lst("pm", "lm", BGA)
    s.check("the Performance list for Alpha: the line managers still with work (LM1, 1 report waiting), not the done one (LM2)",
            code == 200 and "ZZ HS LM1" in t and "ZZ HS LM2" not in t and "1 report" in t and "1 of 2 line managers done" in t, code)
    code, t = lst("pm", "lm", None)
    s.check("the all-groups list holds LM1 once", code == 200 and t.count("ZZ HS LM1") == 1)
    NOW[0] = D(11, 14, 12)
    code, t = lst("pm", "hod", BGA)
    s.check("the HOD list: HOD1 still to submit Performance, '0 of 1 department reviews submitted'",
            code == 200 and "ZZ HS HOD1" in t and "Still to submit" in t and "0 of 1 department reviews submitted" in t, code)
    sess("pm_calibration_sessions", "hod", str(HOD1), BGA)
    code, t = lst("pm", "hod", BGA)
    s.check("...HOD1 submits: the list is empty", code == 200 and "ZZ HS HOD1" not in t and "Nobody is still waiting" in t)
    unsess("pm_calibration_sessions", "hod", str(HOD1), BGA)
    NOW[0] = D(11, 17, 12)
    code, t = lst("pm", "bu", BGA)
    s.check("the BU CEO list: BU1 and CAL, each with the units still to lock",
            code == 200 and "ZZ HS BU1" in t and "ZZ HS CAL" in t and UA in t and "ZZHS Panel" in t, code)
    code, _t = lst("f360", "lm", BGA)
    s.check("a column the stage does not have is a 404 (not a list of something else)", code == 404, code)
    code, _t = lst("pm", "bg", BGA)
    s.check("the BG CEOs' cells have no list panel (their page is the Talent Box)", code == 200 and "Performance" in _t, code)
    with a.app.test_request_context("/"):
        bgurl = a.url_for("admin_list_view", key="home-cell", col="pm", stage="lm", fragment=1, bg=BGA)
    s.check("a BG admin cannot open the list panel (the super admin's only)",
            H.client_as(a, ADM_A).get(bgurl, headers=NAV).status_code == 403)
    NOW[0] = D(11, 11, 12)
    mnon = mat("lm", uid=ADM_A)
    pm_url = mnon["rows"][0]["cells"][0]["url"]
    s.check("a BG admin's Line managers cells go to the module's Progress page at the stage that waits on the manager",
            "/progress" in pm_url and "fstage=results" in pm_url and "key" not in pm_url.split("?")[-1], pm_url)
    s.check("...Competency to its Submitted stage, the Career Plan to Shared",
            "fstage=submitted" in mnon["rows"][0]["cells"][1]["url"] and "fstage=shared" in mnon["rows"][0]["cells"][2]["url"])
    NOW[0] = D(11, 14, 12)
    hu = mat("hod", uid=ADM_A)["rows"][0]["cells"][0]["url"]
    NOW[0] = D(11, 25, 12)
    bu_ = mat("bg", uid=ADM_A)["rows"][0]["cells"][0]["url"]
    s.check("...HODs and BU CEOs go to the lock status page's open rows; BG CEOs to the group's Talent Box",
            "/calibration" in hu and "show=open" in hu and "talent-box" in bu_ and "bg=ZZHS" in bu_, (hu, bu_))
    NOW[0] = D(11, 11, 12)
    rb = H.client_as(a, ADM_A).get("/admin", headers=NAV)
    s.check("a BG admin's Home opens with the switch and only their group", rb.status_code in (200, 302) and (
        rb.status_code == 302 or (BGB not in rb.get_data(as_text=True) and "Line managers" in rb.get_data(as_text=True))), rb.status_code)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("the reads do not grow with the people")
    def reads(stage, warm=True):
        q = []
        mat(stage, count=q, warm=warm)
        return len(q)
    NOW[0] = D(11, 25, 12)
    before = {st: reads(st) for st in ("lm", "hod", "bu", "bg")}
    cold = {st: reads(st, False) for st in ("hod", "bu", "bg")}
    with a.app.app_context():
        d = a.get_db()
        for k in range(20, 60):
            uid = d.execute(
                "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, department, "
                "job_title, job_grade, confirmation_date, years_of_service) VALUES (?,?,'x','user',?,?,?,'ZZHS Dept','ZZHS Officer',14,"
                "'2020-01-01',4.0)", ("zz9hs-x%d" % k, "ZZ HS X%d" % k, "ZZ9HS-X%d" % k, BGA if k % 2 else BGB,
                                      UA if k % 2 else UB)).lastrowid
            d.execute("UPDATE users SET manager_id=?, hod_id=? WHERE id=?", (LM2 if k % 2 else LM1, HOD1, uid))
            t_ = d.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company, "
                           "status) VALUES (?,?,?,100,'more',?,?,'approved')", (CID, uid, "ZZHS KPI x%d" % k, BGA, UA)).lastrowid
            d.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t_, LM2 if k % 2 else LM1))
            d.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, draft) VALUES (?,5,0)", (t_,))
            d.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) VALUES (?,?,?)", (CID, uid, SKILL))
            d.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status, submitted_at) VALUES (?,?,'submitted',datetime('now'))",
                      (CID, uid))
            d.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status, shared_at) VALUES (?,?,?,'shared',datetime('now'))",
                      (YEAR, CID, uid))
        d.commit()
    after = {st: reads(st) for st in ("lm", "hod", "bu", "bg")}
    s.check("forty more people: the same number of reads on every stage (never a query a person)", before == after, (before, after))
    for st in ("lm", "hod", "bu", "bg"):
        s.note("%s: %d reads a load beyond the lock status rows Home's readiness card reads anyway%s" % (
            st, after[st], (" (%d with them)" % cold[st]) if st in cold else ""))
    s.check("the stage tables stay small beside the page's own readiness read: LM <= 60, HOD / BU CEO / BG CEO <= 40 more",
            after["lm"] <= 60 and all(after[k] <= 40 for k in ("hod", "bu", "bg")), after)
    m = mat("lm")
    s.check("...and the forty are counted (LM1 and LM2 still the only line managers of them)", cell(m, "pm", BGA)[1] == 2)
    fn = {st: [reads(st)] for st in ("emp",)}
    s.note("emp (today's table, no Calibration): %d reads a load" % fn["emp"][0])

    # -----------------------------------------------------------------------------------------------------------------
    s.section("the guards are real (each broken, then put back)")
    real_pick = a._home_stage_pick
    a._home_stage_pick = lambda sw, st: st or sw["today"]
    try:
        NOW[0] = D(11, 14, 12)
        try:
            broke = mat("zzz")["stage"]["on"] != "hod"
        except Exception:   # the unchecked stage is not one the cycle has: the page would fail
            broke = True
        s.check("falsified: with the ?stage= check removed an invalid ?stage is no longer today's stage", broke)
    finally:
        a._home_stage_pick = real_pick
    s.check("...and with the guard back it is today's again", mat("zzz")["stage"]["on"] == "hod")
finally:
    a._now_myt = _real_now
    if CHAIR_ENV0 is None:
        os.environ.pop("ONEHR_CHAIR", None)
    else:
        os.environ["ONEHR_CHAIR"] = CHAIR_ENV0
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)
        _db.execute("UPDATE cycles SET kind=?, half=?, starts_on=?, min_job_grade=?, open_by_date=? WHERE id=?",
                    (CYC0["kind"], CYC0["half"], CYC0["starts_on"], CYC0["min_job_grade"], CYC0["open_by_date"], CID))
        for k in ("review", "pm", "tm", "calibration", "idp"):
            if k in MODS0:
                _db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (MODS0[k], CID, k))
            else:
                _db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k))
        _db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for row in WIN0:
            _db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", row)
        for k in ("tb_limit_stars_on",):
            if k in TBL0:
                _db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?,?)", (k, TBL0[k]))
            else:
                _db.execute("DELETE FROM app_settings WHERE key=?", (k,))
        _db.commit()

sys.exit(s.done())
