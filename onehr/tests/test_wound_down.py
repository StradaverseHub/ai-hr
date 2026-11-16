"""A wound-down active cycle reads as a finished one on the dashboard (Chris, 2026-10-15: production "should set it out
to show the 2026 mid year look").

Production's only cycle, 2026 Mid-Year, is still the ACTIVE cycle (the Year-End doesn't exist yet), its 360 is done and
its check-in is switched off. The record view skipped an active cycle unless something of it was released to the person,
so everyone saw "Your record starts here". cycle_wound_down(): an active cycle that has started, with its AI+ check-in
(`review`), Performance (`pm`) and Career Plan (`idp`) all off -- only its 360's reports left -- counts as finished -- its history row, the record view, What you led, plan check-ins -- and
no cycle reads as open (Where you stand, Ask OneHR's calendar).

What this suite holds:
  * started + check-in, Performance and Career Plan off = wound down; any of them on, or not started yet, = not (a
    running cycle is untouched -- with only the check-in off, people still work on the classic pages)
  * the person's row is not "open"; the history and the record view take the cycle with only a released 360
  * the dashboard context reads no open cycle, plan check-ins open, Ask OneHR says no cycle is open
  * with the check-in on again, everything is as before

Synthetic (ZZWD-*) on the shared suite database; the cycle's module switch, start date and the seeded rows are put back.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Wound-down cycle -- an active cycle with its check-in off reads as finished on the dashboard")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZWD-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM report_releases WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    _cleanup(db)
    CID = a.active_cycle_id(db)
    cyc0 = dict(db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())
    mod0 = {k: db.execute("SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k)).fetchone()
            for k in ("review", "pm", "idp")}
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]
    v = dict(base, username="ZZWD-01", employee_id="ZZWD-01", full_name="ZZWD Person", email=None, manager_id=None,
             hod_id=None, left_at=None, role="user", admin_bg=None)
    db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
    ME = db.execute("SELECT id FROM users WHERE employee_id='ZZWD-01'").fetchone()[0]
    db.execute("INSERT INTO report_releases(cycle_id, subject_id) VALUES (?,?)", (CID, ME))   # a released 360 only
    db.execute("UPDATE cycles SET starts_on='2026-01-01' WHERE id=?", (CID,))   # started
    db.commit()


def set_mods(**on):
    with a.app.test_request_context("/"):
        db = a.get_db()
        for k, v in on.items():
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, ?, ?) "
                       "ON CONFLICT(cycle_id, module_key) DO UPDATE SET active=excluded.active", (CID, k, 1 if v else 0))
        db.commit()


def look():
    with a.app.test_request_context("/"):
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (ME,)).fetchone()
        cyc = db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()
        row = a._dash_record_row(db, u, cyc, cyc)
        ctx = a._dash_context(db, u)
        facts, _ = a._ask_facts(db, u, ctx)
        return {"wound": a.cycle_wound_down(db, cyc), "open": row["open"], "has": row["has_anything"],
                "mode": ctx["mode"], "last": ((ctx.get("rec") or {}).get("last") or {}).get("cycle_id"),
                "hist": [r.get("cycle_id") for r in ctx["record_all"]], "cycle": ctx["cycle"],
                "checkin": a.plan_checkin_open(db, u), "facts": "\n".join(facts),
                "led_id": a._wound_down_id(db)}


try:
    s.section("The check-in on: a running cycle, as before")
    set_mods(review=True, pm=True, idp=True)
    on = look()
    s.check("not wound down", on["wound"] is False and on["led_id"] == -1)
    s.check("its row is open", on["open"] is True)
    s.check("...so it is not in the history (only a 360 released, not a result)", CID not in on["hist"], on["hist"])

    s.section("Only the check-in off: still running (the classic pages)")
    set_mods(review=False)
    part = look()
    s.check("check-in off but Performance on: not wound down", part["wound"] is False and part["open"] is True)
    set_mods(pm=False)
    s.check("...nor with the Career Plan still on", look()["wound"] is False)

    s.section("Check-in, Performance and Career Plan off, started: wound down")
    set_mods(idp=False)
    off = look()
    s.check("wound down", off["wound"] is True and off["led_id"] == CID)
    s.check("its row is not open, and holds something (the released 360)", off["open"] is False and off["has"] is True)
    s.check("the history lists it", CID in off["hist"], off["hist"])
    s.check("the dashboard shows the record view, anchored on it", off["mode"] == "record" and off["last"] == CID,
            (off["mode"], off["last"]))
    s.check("no cycle reads as open", off["cycle"] is None)
    s.check("plan check-ins are open (between cycles)", off["checkin"] is True)
    s.check("Ask OneHR says no cycle is open, with no calendar",
            "no cycle is open" in off["facts"] and "THE CYCLE CALENDAR" not in off["facts"])

    s.section("Not started yet: never wound down")
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("UPDATE cycles SET starts_on='2099-01-01' WHERE id=?", (CID,))
        db.commit()
        s.check("a cycle that hasn't opened isn't wound down, even with the check-in off",
                a.cycle_wound_down(db, db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()) is False)
        s.check("an archived (not active) cycle isn't 'wound down' (it is simply past)",
                a.cycle_wound_down(db, dict(cyc0, is_active=0)) is False)
finally:
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("UPDATE cycles SET starts_on=? WHERE id=?", (cyc0["starts_on"], CID))
        for k, row in mod0.items():
            if row is None:
                db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k))
            else:
                db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (row[0], CID, k))
        db.commit()
        _cleanup(db)

sys.exit(s.done())
