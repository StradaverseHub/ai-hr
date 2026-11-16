"""The synthetic world the Grade H email suites share (test_email_skips, test_gradeh_leader_email): a Year-End cycle with Grade H
on (production's dates, 9 Nov 2026), two units, their HODs, line managers and Grade H people, the leaders' ready-made tools
(a clock, windows, settings, sign-offs), and the writes that put everything back. Nothing real: every account is ZZGM-*.

    W = world(a, db_connect)   # after os.environ["ONEHR_GRADEH"] = "1" and H.setup(fresh_db=True)
    W.restore()                # in a finally: puts back what the world changed

People (Grade H; all with a work email):
  unit A (W.CO):   BU CEO B1 (a seat); HOD H1 with 6 people (S1-S3 under line manager M1, S4-S6 under M2); HOD H3 with S7, S8 (under M3),
                   both stages signed off (so H3 gets nothing); one non-Grade-H person X1 reporting to H1 (never counted)
  unit B (W.CO2):  BU CEO B2 (a seat); HOD H2 with S9, S10, S11 (under M4)
S1-S3 have an appraisal submitted (and S1 acknowledged); S4-S6 have not; S7, S8 are done; S9-S11 are submitted, not acknowledged.
Production's Grade H calendar (Nov 2026): KPI 2-10, acknowledge 9-20, line managers 6-18, HOD 12-21, BU CEO 19-23, and the main review's.
"""
import json
import os
import sqlite3
from datetime import datetime, timedelta
from types import SimpleNamespace

PFX, BG = "ZZGM-", "ZZGM Group"
CO, CO2 = "ZZGM Unit A", "ZZGM Unit B"
UTCF = "%Y-%m-%d %H:%M:%S"


def utc(day, hh, mm=0, month=11):
    """A MYT date-time (2026) as the stored UTC string."""
    return (datetime(2026, month, day, hh, mm) - timedelta(hours=8)).strftime(UTCF)


def world(a, db_path):
    db = sqlite3.connect(db_path, timeout=5.0)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    W = SimpleNamespace(a=a, db=db, U={}, P={}, CO=CO, CO2=CO2, BG=BG, PFX=PFX, utc=utc)
    now0 = a._now_myt

    def run(fn):
        with a.app.test_request_context("/", base_url=a.app_base_url()):
            d = a.get_db()
            r = fn(d)
            d.commit()
            return r
    W.run = run
    W.CID = run(lambda d: a.active_cycle_id(d))
    cyc0 = db.execute("SELECT half, open_by_date FROM cycles WHERE id=?", (W.CID,)).fetchone()
    mods0 = [dict(r) for r in db.execute("SELECT * FROM cycle_modules WHERE cycle_id=?", (W.CID,))]
    wins0 = [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (W.CID,))]
    st0 = {r["key"]: r["value"] for r in db.execute("SELECT * FROM app_settings WHERE key LIKE 'gradeh%' OR key LIKE 'reminder%' OR "
                                                    "key LIKE 'leader_progress%' OR key LIKE 'bg_admin_progress%' OR "
                                                    "key LIKE 'ready_notice%' OR key LIKE 'email_wave%'")}

    def urow(k):
        return db.execute("SELECT * FROM users WHERE id=?", (W.U[k],)).fetchone()

    def mk(k, grade="H", mgr=None, hod=None, co=CO, dept="ZZGM Dept", email="auto"):
        em = (PFX + k).lower() + "@zzgm.example" if email == "auto" else email
        W.U[k] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
            "job_grade, job_title, manager_id, hod_id, email, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?,?,?, 'Driver', ?,?,?, "
            "'2020-01-01')", ((PFX + k).lower(), "ZZ GP " + k, PFX + k, BG, co, dept, grade, mgr, hod, em)).lastrowid
        return W.U[k]

    def person(k, appraiser=None, submitted=True, ack=None, lm_at=None, route="B"):
        pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, appraiser_id, language, language_set_at) "
                         "VALUES (?,?,?,?,?, 'en', datetime('now'))", (W.CID, PFX + k, W.U[k], route, appraiser)).lastrowid
        W.P[k] = pid
        db.execute("INSERT INTO gradeh_appraisals (cycle_id, person_id, lm_submitted_at, perf_band, pot_band, acknowledged_at) "
                   "VALUES (?,?,?,?,?,?)", (W.CID, pid, (lm_at or utc(10, 10)) if submitted else None, "ME" if submitted else None,
                                           "Mid" if submitted else None, ack))
        return pid

    def set_window(cell, opens, closes):
        db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                   (W.CID, cell, opens, closes))
        db.commit()

    def win(cell, o, c, month=11):
        set_window(cell, "2026-%02d-%02d 00:00" % (month, o), "2026-%02d-%02d 23:59" % (month, c))

    def calendar(main=True):
        """Production's calendar for Nov 2026: Grade H's six cells, and (main) the main review's."""
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (W.CID,))
        for cell, o, c in (("gradeh_kpi", 2, 10), ("gradeh_ack", 9, 20), ("gradeh_lm", 6, 18), ("gradeh_hod_pot", 12, 21),
                           ("gradeh_hod_perf", 12, 21), ("gradeh_buceo", 19, 23)):
            win(cell, o, c)
        if main:
            for cell, o, c in (("pm_results", 2, 8), ("tc_self", 2, 8), ("pm_approve", 9, 15), ("pm_hod", 12, 18),
                               ("pm_buceo", 16, 18), ("tb_bgceo", 19, 30)):
                win(cell, o, c)
        db.commit()

    def setting(key, value):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES (?,?)", (key, str(value)))
        db.commit()

    def unset(*keys):
        for k in keys:
            db.execute("DELETE FROM app_settings WHERE key=?", (k,))
        db.commit()

    def gsetting(name, value):
        run(lambda d: a.gradeh_set_setting(d, name, value, None))

    def rem_settings(days=(2, 1), on_open=True, every=0, send="09:00", enabled=True):
        for k_, v_ in (("reminder_days_before", json.dumps(list(days))), ("reminder_on_open", "1" if on_open else "0"),
                       ("reminder_every_days", str(every)), ("reminder_auto_enabled", "1" if enabled else "0"),
                       ("reminder_send_time", send)):
            db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES (?,?)", (k_, v_))
        db.execute("DELETE FROM app_settings WHERE key IN ('reminder_every_from','reminder_every_to','reminder_auto_last',"
                   "'gradeh_staff_last','gradeh_prog_last','gradeh_ready_last')")
        db.commit()

    def clock(day, hh=9, mm=30, month=11):
        a._now_myt = lambda: datetime(2026, month, day, hh, mm)

    def clock_back():
        a._now_myt = now0

    def sign(hod, stage, at):
        db.execute("INSERT OR IGNORE INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by, signed_at) VALUES (?,?,?,?,?,?)",
                   (W.CID, "hod", stage, str(W.U[hod]), W.U[hod], at))
        db.commit()

    def bu_sign(unit, by, at=None):
        db.execute("INSERT OR IGNORE INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by, signed_at) VALUES (?,?,?,?,?,?)",
                   (W.CID, "buceo", "all", unit, W.U[by], at or utc(20, 10)))
        db.commit()

    def ack(keys, at):
        for k in keys:
            db.execute("UPDATE gradeh_appraisals SET acknowledged_at=? WHERE person_id=?", (at, W.P[k]))
        db.commit()

    def submit(keys, at=None):
        for k in keys:
            db.execute("UPDATE gradeh_appraisals SET lm_submitted_at=?, perf_band='ME', pot_band='Mid' WHERE person_id=?", (at or utc(10, 10), W.P[k]))
        db.commit()

    def unack():
        db.execute("UPDATE gradeh_appraisals SET acknowledged_at=NULL, deemed_at=NULL WHERE cycle_id=?", (W.CID,))
        db.execute("UPDATE gradeh_appraisals SET acknowledged_at=? WHERE person_id=?", (utc(10, 12), W.P["S1"]))
        for k in ("S4", "S5", "S6"):   # these three have no appraisal submitted yet (so nothing to acknowledge)
            db.execute("UPDATE gradeh_appraisals SET lm_submitted_at=NULL, perf_band=NULL, pot_band=NULL WHERE person_id=?", (W.P[k],))
        db.commit()

    def reset_world():
        """The people as the world starts: S1 acknowledged, no sign-off by H1, H2 or either BU CEO; H3 signed both stages."""
        unack()
        db.execute("DELETE FROM gradeh_signoffs WHERE cycle_id=?", (W.CID,))
        db.execute("DELETE FROM gradeh_releases WHERE cycle_id=?", (W.CID,))
        db.execute("DELETE FROM ready_notices WHERE cycle_id=?", (W.CID,))
        db.execute("DELETE FROM email_optouts WHERE user_id IN (SELECT id FROM users WHERE employee_id LIKE ?)", (PFX + "%",))
        db.execute("DELETE FROM email_skips")
        db.execute("DELETE FROM email_outbox")
        db.execute("DELETE FROM notifications")
        db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%fallback%' OR key='gradeh_reminders_enabled'")
        db.commit()
        sign("H3", "pot", utc(8, 10))
        sign("H3", "perf", utc(8, 11))

    def module(on):
        db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (W.CID,))
        db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', ?)", (W.CID, 1 if on else 0))
        db.commit()

    def outbox(kind=None, user=None):
        q, args = "SELECT * FROM email_outbox WHERE 1=1", []
        if kind:
            q += " AND kind=?"
            args.append(kind)
        if user:
            q += " AND user_id=?"
            args.append(W.U[user])
        return db.execute(q + " ORDER BY id", args).fetchall()

    def optout(k, kind, until=None):
        db.execute("INSERT INTO email_optouts(user_id, kind, until, reason, set_by) VALUES (?,?,?,?,?)",
                   (W.U[k], kind, until, "ZZ test", None))
        db.commit()

    for name, fn in (("urow", urow), ("mk", mk), ("person", person), ("set_window", set_window), ("win", win), ("calendar", calendar),
                     ("setting", setting), ("unset", unset), ("gsetting", gsetting), ("rem_settings", rem_settings), ("clock", clock),
                     ("clock_back", clock_back), ("sign", sign), ("bu_sign", bu_sign), ("ack", ack), ("reset_world", reset_world),
                     ("module", module), ("outbox", outbox), ("optout", optout), ("submit", submit)):
        setattr(W, name, fn)

    # --- the world --------------------------------------------------------------------------------------------------------------
    db.execute("UPDATE cycles SET half=2, open_by_date=1 WHERE id=?", (W.CID,))
    module(True)
    for c_ in (CO, CO2):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, c_))
    db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%' OR key LIKE 'leader_progress%' OR key LIKE 'bg_admin_progress%' "
               "OR key LIKE 'ready_notice%'")
    calendar()
    db.commit()
    gsetting("gradeh_deemed_on", False)   # no deemed deadline: nobody counts as acknowledged until they (or their line manager) say so
    db.execute("DELETE FROM email_skips")
    for k_, g_, hod_ in (("M1", "15", None), ("M2", "15", None), ("M3", "15", None), ("M4", "15", None)):
        mk(k_, g_)
    mk("B1", "21", dept="ZZGM Division")
    mk("H1", "19", hod=W.U["B1"], dept="ZZGM Dept One")
    mk("H3", "19", hod=W.U["B1"], dept="ZZGM Dept Two")
    for k_, mgr, dept in (("S1", "M1", "ZZGM Dept One"), ("S2", "M1", "ZZGM Dept One"), ("S3", "M1", "ZZGM Dept One"),
                          ("S4", "M2", "ZZGM Dept One"), ("S5", "M2", "ZZGM Dept One"), ("S6", "M2", "ZZGM Dept One")):
        mk(k_, mgr=W.U[mgr], hod=W.U["H1"], dept=dept)
    for k_ in ("S7", "S8"):
        mk(k_, mgr=W.U["M3"], hod=W.U["H3"], dept="ZZGM Dept Two")
    mk("X1", "12", mgr=W.U["M1"], hod=W.U["H1"], dept="ZZGM Dept One")   # not on the Grade H list
    mk("B2", "21", co=CO2, dept="ZZGM Division B")
    mk("H2", "19", hod=W.U["B2"], co=CO2, dept="ZZGM Dept Three")
    for k_ in ("S9", "S10", "S11"):
        mk(k_, mgr=W.U["M4"], hod=W.U["H2"], co=CO2, dept="ZZGM Dept Three")
    for k_, ap, sub in (("S1", "M1", True), ("S2", "M1", True), ("S3", "M1", True), ("S4", "M2", False), ("S5", "M2", False),
                        ("S6", "M2", False), ("S7", "M3", True), ("S8", "M3", True), ("S9", "M4", True), ("S10", "M4", True),
                        ("S11", "M4", True)):
        person(k_, appraiser=W.U[ap], submitted=sub)
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, W.U["B1"]))
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO2, W.U["B2"]))
    db.commit()
    reset_world()
    rem_settings()

    def restore():
        clock_back()
        db.execute("UPDATE cycles SET half=?, open_by_date=? WHERE id=?", (cyc0["half"], cyc0["open_by_date"], W.CID))
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (W.CID,))
        for w_ in wins0:
            db.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w_), ",".join("?" * len(w_))), list(w_.values()))
        db.execute("DELETE FROM cycle_modules WHERE cycle_id=?", (W.CID,))
        for m_ in mods0:
            db.execute("INSERT INTO cycle_modules(%s) VALUES (%s)" % (",".join(m_), ",".join("?" * len(m_))), list(m_.values()))
        db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh%' OR key LIKE 'reminder%' OR key LIKE 'leader_progress%' OR "
                   "key LIKE 'bg_admin_progress%' OR key LIKE 'ready_notice%' OR key LIKE 'email_wave%'")
        for k_, v_ in st0.items():
            db.execute("INSERT INTO app_settings(key,value) VALUES (?,?)", (k_, v_))
        db.execute("DELETE FROM email_outbox")
        db.execute("DELETE FROM email_skips")
        db.execute("DELETE FROM ready_notices WHERE cycle_id=?", (W.CID,))
        db.execute("DELETE FROM leader_role_access WHERE ability LIKE '%.gradeh'")
        db.commit()
    W.restore = restore
    return W
