"""A new cycle starts with its modules closed (Chris, 2026-10-18: "open 2026 year end, set the end date to 31 Jan 2027
for now, but don't open the other modules ... If a module is not started, no action is available for users to the AI+
checkin").

What this suite holds (on a COPY of the suite database, because starting a cycle archives the active one):
  * Start stores a row per module, every one closed, and marks the cycle awaiting_open; a restart's seeding can't
    switch anything on or off behind it (a cycle with no rows once read ON, then lost its check-in on the next boot)
  * a started, never-opened cycle is not finished: not wound down, out of the history, the top bar says "Not open yet",
    the record view's next says so, Ask OneHR says nothing is open, the AI+ check-in answers 404, and the Career Plan
    check-in stays as it is between cycles
  * switching on a module for people clears the closed-modules mark, but the cycle stays "not open yet" until a part's
    start date (2026-10-19, test_open_by_date); switching everything off again afterwards is wound down
"""
import os
import re
import shutil
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A new cycle starts with its modules closed -- not open yet, never finished")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _bg, EMP = H.actors(a)

tmp = tempfile.mkdtemp(prefix="onehr-tests-awaiting-")
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


def ctx_for(uid):
    with a.app.test_request_context("/"):
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        ctx = a._dash_context(db, u)
        cyc = a.active_cycle(db)
        return (ctx, cyc, a.cycle_awaiting_open(db, cyc), a.cycle_wound_down(db, cyc), a.nav_cycle_pill(db, cyc),
                a.plan_checkin_open(db, u), a._ask_facts(db, u, ctx)[0])


try:
    C = H.client_as(a, SU["id"])
    s.section("Start")
    r = C.post("/admin/cycles", data={"action": "create", "csrf_token": "tok", "name": "ZZAO 2026 Year-End",
                                      "code": "ZZAO-YE", "confirm_freeze": "1", "source": "empty", "year": "2026",
                                      "half": "2", "starts_on": "2026-10-01T00:00", "ends_on": "2027-01-31T23:59",
                                      "min_job_grade": "12"})
    row = q("SELECT id, is_active, half, awaiting_open, ends_on FROM cycles WHERE code='ZZAO-YE'")
    s.check("a Year-End starts, active, marked not open yet", bool(row) and row[0][1] == 1 and row[0][2] == 2
            and row[0][3] == 1, (r.status_code, row))
    cid = row[0][0] if row else -1
    mods = dict(q("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (cid,)))
    s.check("...with a stored row for every module, every one closed",
            set(mods) == set(a.CYCLE_MODULE_KEYS) and not any(mods.values()), mods)
    with a.app.app_context():
        a._ensure_runtime_schema()   # what every restart runs
    mods2 = dict(q("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (cid,)))
    s.check("...and a restart's seeding changes none of them", mods2 == mods, mods2)
    s.check("the Start page says the modules start closed", "starts with every module closed" in
            C.get("/admin/cycles/home?cycle=%d" % cid, follow_redirects=True).get_data(as_text=True)
            or "starts with every module closed" in str(r.headers), r.headers.get("Location"))

    s.section("Not open yet, never finished")
    ctx, cyc, waiting, wound, pill, plan_open, facts = ctx_for(EMP["id"])
    s.check("the cycle is awaiting open, and not wound down", waiting and not wound, (waiting, wound))
    s.check("the top bar says Not open yet", pill.get("state") == "upcoming" and pill.get("note") == "Not open yet",
            pill)
    s.check("the dashboard is in its not-open state (2026-10-18: its own mode, Where you stand opening Details)",
            ctx["mode"] == "awaiting" and ctx.get("awaiting_open") and ctx.get("awaiting")
            and ctx["awaiting"]["cycle"] == "ZZAO 2026 Year-End", (ctx["mode"], ctx.get("awaiting")))
    s.check("...and the Year-End isn't in their history", not any(
        (r_.get("cycle_id") == cid or r_.get("period_id") == cid) for r_ in ctx["record_all"]))
    s.check("Ask OneHR says nothing in it is open", any("nothing in it is open yet" in ln for ln in facts)
            and not any(("ZZAO 2026 Year-End is open" in ln) for ln in facts), [ln for ln in facts if "CYCLE" in ln])
    s.check("the Career Plan check-in stays as it is between cycles", plan_open is True)
    E = H.client_as(a, EMP["id"])
    s.check("the AI+ check-in has no way in (404)", E.get("/review").status_code == 404)
    body = E.get("/dashboard").get_data(as_text=True)
    hits = sorted(set(m.group(0) for m in re.finditer(r"[^<>]{0,40}(?i:not open yet)[^<>]{0,10}", body)))
    s.check("the employee's dashboard says not open yet, never closed", bool(hits) and "Year-End closed" not in body,
            hits[:4])

    s.section("Opening a module")
    C.post("/admin/cycles", data={"action": "set_modules", "csrf_token": "tok", "cycle_id": str(cid), "module": "pm"})
    s.check("switching Performance on clears the closed-modules mark", q("SELECT awaiting_open FROM cycles WHERE id=?",
                                                                       (cid,))[0][0] is None)
    ctx, cyc, waiting, wound, pill, plan_open, facts = ctx_for(EMP["id"])
    # ...but its parts open by date, and none has a start date yet (Chris, 2026-10-19: "I have yet set the start date
    # of my modules, but in the user page, it can start the AI+ check in already")
    s.check("...yet with no part dated it is still not open (a part opens on its start date)",
            waiting and not wound and pill.get("note") == "Not open yet", pill)
    C.post("/admin/windows", data={"csrf_token": "tok", "cycle": str(cid), "action": "open_now:pm_results"})
    ctx, cyc, waiting, wound, pill, plan_open, facts = ctx_for(EMP["id"])
    s.check("...the results check-in opened from now: the cycle is running, not waiting",
            not waiting and not wound and pill.get("state") == "open", pill)
    C.post("/admin/cycles", data={"action": "set_modules", "csrf_token": "tok", "cycle_id": str(cid)})
    ctx, cyc, waiting, wound, pill, plan_open, facts = ctx_for(EMP["id"])
    s.check("everything off again after opening: finished (wound down), as before", wound and not waiting, pill)
finally:
    a.DB_PATH = real
    shutil.rmtree(tmp, ignore_errors=True)

sys.exit(s.done())
