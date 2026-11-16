"""Admin Home flags what blocks a cycle before it opens (Chris, 2026-10-18: "flag inside the admin page on the KPI lines
without approver or user without line manager assigned").

What this suite holds (on a COPY of the suite database, because starting a cycle archives the active one):
  * Foundation always carries "Everyone taking part has a line manager", counting the people taking part whose line
    manager is on file and still here, and opening the Data integrity list to fix the rest
  * while a cycle is started with its modules closed, Performance's set-up steps show -- "Every KPI line has a
    moderator" among them, opening Exceptions -- but not the step that waits on employees; Home lists both flags
  * once Performance opens (switched on and its results check-in dated), its steps are as before; switched off after opening, they go (off means off)
"""
import os
import shutil
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Admin Home flags people with no line manager and KPI lines with no moderator, before a cycle opens")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _bg, _emp = H.actors(a)

tmp = tempfile.mkdtemp(prefix="onehr-tests-flags-")
real = a.DB_PATH
cp = os.path.join(tmp, "copy.db")
src = sqlite3.connect(real)
dst = sqlite3.connect(cp)
src.backup(dst)
src.close()
dst.close()
a.DB_PATH = cp
assert "onehr-tests" in a.DB_PATH


def q(sql, args=()):
    c = sqlite3.connect(cp)
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def do(sql, args=()):
    c = sqlite3.connect(cp)
    try:
        c.execute(sql, args)
        c.commit()
    finally:
        c.close()


def readiness():
    with a.app.test_request_context("/"):
        from flask import session as _s
        _s["user_id"] = SU["id"]
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        groups, _d, _t = a._cycle_readiness(db, u, a.active_cycle(db))
    return {g["label"]: {x["label"]: x for x in g["steps"]} for g in groups}


try:
    C = H.client_as(a, SU["id"])
    C.post("/admin/cycles", data={"action": "create", "csrf_token": "tok", "name": "ZZRF 2026 Year-End", "code": "ZZRF-YE",
                                  "confirm_freeze": "1", "source": "empty", "year": "2026", "half": "2",
                                  "starts_on": "2026-10-01T00:00", "min_job_grade": "12"})
    CID = q("SELECT id FROM cycles WHERE code='ZZRF-YE'")[0][0]
    with a.app.app_context():
        db = a.get_db()
        base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
        cols = [c for c in base.keys() if c != "id"]
        v = dict(base, username="zzrf-a", employee_id="ZZRF-A", full_name="Person ZZRF-A", email=None, hod_id=None,
                 manager_id=None, left_at=None, role="user", admin_bg=None, years_of_service=3, job_grade=13, is_demo=0)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        db.commit()
    UID = q("SELECT id FROM users WHERE employee_id='ZZRF-A'")[0][0]
    do("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, rate5, "
       "business_group) VALUES (?,?,'ZZRF Sales',100,'more',1,2,3,4,5,?)", (CID, UID, base["business_group"]))

    s.section("Started, nothing open")
    r0 = readiness()
    lm = r0.get("Foundation", {}).get("Everyone taking part has a line manager")
    s.check("Foundation flags the people taking part with no line manager, opening the Data integrity list",
            lm is not None and lm["state"] not in ("done", "waiting") and lm["n"] < lm["of"] and "check=no_manager" in (lm["url"] or ""),
            lm)
    pm = r0.get("Performance") or {}
    mod = pm.get("Every KPI line has a moderator")
    s.check("Performance's set-up shows before it opens, flagging the KPI line with no moderator (opening Exceptions)",
            mod is not None and mod["state"] not in ("done", "waiting") and mod["n"] < mod["of"]
            and "/admin/performance/exceptions" in (mod["url"] or ""), (sorted(pm), mod))
    s.check("...but not the step that waits on employees", "Results submitted" not in pm, sorted(pm))
    home = C.get("/admin").get_data(as_text=True)
    s.check("Home lists both flags", "Everyone taking part has a line manager" in home
            and "Every KPI line has a moderator" in home)

    s.section("A line manager set")
    lm_before = (lm["n"], lm["of"])
    mgr = q("SELECT id FROM users WHERE role!='admin' AND left_at IS NULL AND id!=? LIMIT 1", (UID,))[0][0]
    do("UPDATE users SET manager_id=? WHERE id=?", (mgr, UID))
    lm1 = readiness()["Foundation"]["Everyone taking part has a line manager"]
    s.check("the person with a line manager now counts (one more of the same people)",
            (lm1["n"], lm1["of"]) == (lm_before[0] + 1, lm_before[1]), (lm_before, (lm1["n"], lm1["of"])))
    do("UPDATE users SET manager_id=? WHERE id=?", (UID, UID))
    lm2 = readiness()["Foundation"]["Everyone taking part has a line manager"]
    s.check("...a person recorded as their own manager does not", lm2["n"] == lm_before[0], (lm2["n"], lm_before))

    s.section("Once Performance opens, and if it is switched off again")
    C.post("/admin/cycles", data={"action": "set_modules", "csrf_token": "tok", "cycle_id": str(CID), "module": "pm"})
    s.check("switched on with no part dated: still set-up only (a part opens on its start date, 2026-10-19)",
            "Results submitted" not in (readiness().get("Performance") or {}))
    C.post("/admin/windows", data={"csrf_token": "tok", "cycle": str(CID), "action": "open_now:pm_results"})
    pm_on = readiness().get("Performance") or {}
    s.check("open: its steps as before, the employees' step back", "Results submitted" in pm_on
            and "Every KPI line has a moderator" in pm_on, sorted(pm_on))
    C.post("/admin/cycles", data={"action": "set_modules", "csrf_token": "tok", "cycle_id": str(CID), "module": "tm"})
    s.check("switched off after opening: off means off, no Performance steps", "Performance" not in readiness())
finally:
    a.DB_PATH = real
    shutil.rmtree(tmp, ignore_errors=True)

sys.exit(s.done())
