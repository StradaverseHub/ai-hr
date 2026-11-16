"""A part opens on its start date; with none it isn't open (Chris, 2026-10-19: "one critical bug, under admin, I have yet
set the start date of my modules, but in the user page, it can start the AI+ check in already").

What this suite holds:
  * the rule, in a cycle whose parts open by date (cycles.open_by_date): a part with no start date isn't open, and
    every writer's sentence says so ("The results check-in isn't open yet."); a start date passed opens it, one ahead
    says when, a close passed closes it. A cycle without the flag keeps no dates = open all cycle.
  * the cycle reads "not open yet" while none of its parts has opened, its modules on or not (cycle_awaiting_open),
    never finished; the top bar says when the first part opens
  * people: /review and the journey go to the dashboard; a write through the window gate is refused with the sentence
  * the admin calendar says nothing is open and why; Open now opens a part from now
  * Start sets the flag on every new cycle, and the migration's one-time backfill takes in cycles started since
    2026-10-18 (production's 2026 Year-End)
  * the overall remark's hint asks for the key projects, important initiatives or greatest achievement, at every result
"""
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A part opens on its start date; with none it isn't open")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)

with a.app.app_context():
    db = a.get_db()
    CYC = db.execute("SELECT * FROM cycles WHERE is_active=1").fetchone()
    CID = CYC["id"]
    WIN = [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at, updated_by FROM cycle_windows "
                                        "WHERE cycle_id=?", (CID,))]
    MODS = [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=?",
                                         (CID,))]
    LOG0 = db.execute("SELECT COALESCE(MAX(id), 0) FROM activity_log").fetchone()[0]
    # someone who takes part and has the AI+ journey (it may be the demo flag or the org toggle)
    EMP = db.execute("SELECT id FROM users WHERE role!='admin' AND left_at IS NULL AND employee_id LIKE 'ZZDEMO-%-EMP%' "
                     "ORDER BY id LIMIT 1").fetchone() or db.execute(
        "SELECT id FROM users WHERE role!='admin' AND left_at IS NULL ORDER BY id LIMIT 1").fetchone()
    EMP = EMP[0]


def put_cycle(by_date, awaiting=None):
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET open_by_date=?, awaiting_open=?, starts_on=NULL WHERE id=?",
                  (1 if by_date else None, awaiting, CID))
        d.commit()


def put_window(cell, opens=None, closes=None):
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell=?", (CID, cell))
        if opens or closes:
            d.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                      (CID, cell, opens, closes))
        d.commit()


def no_windows():
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        d.commit()


def ask(fn):
    """fn(db) inside a fresh request, so no per-request cache carries over between checks."""
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def when(days):
    return (a._now_myt() + timedelta(days=days)).strftime("%Y-%m-%d %H:%M")


try:
    with a.app.app_context():
        d = a.get_db()
        for k in a.CYCLE_PEOPLE_MODULES:   # every module for people on: the bug was modules on, no dates set
            d.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1) ON CONFLICT(cycle_id, "
                      "module_key) DO UPDATE SET active=1", (CID, k))
        d.commit()
    no_windows()

    s.section("the rule")
    put_cycle(True)
    s.check("a cycle that opens by date: a part with no start date isn't open",
            ask(lambda d: a.window_state(d, "pm_results")) == "not_open")
    msg = ask(lambda d: a.window_closed(d, "pm_results"))
    s.check("...and every writer's sentence says so, with no empty date", msg == "The results check-in isn't open yet.",
            msg)
    put_window("pm_results", opens=when(-1))
    s.check("a start date passed opens it", ask(lambda d: a.window_state(d, "pm_results")) == "open"
            and ask(lambda d: a.window_closed(d, "pm_results")) is None)
    put_window("pm_results", opens=when(3))
    msg = ask(lambda d: a.window_closed(d, "pm_results"))
    s.check("one ahead: not open, and the sentence says when", ask(lambda d: a.window_state(d, "pm_results"))
            == "not_open" and msg and " opens on " in msg, msg)
    put_window("pm_results", closes=when(-1))
    s.check("no start date but a close passed (Close now): closed, not 'not open yet'",
            ask(lambda d: a.window_state(d, "pm_results")) == "closed")
    no_windows()
    put_cycle(False)
    s.check("a cycle without the flag keeps no dates = open all cycle",
            ask(lambda d: a.window_state(d, "pm_results")) == "open"
            and ask(lambda d: a.window_closed(d, "pm_results")) is None)

    s.section("the cycle reads not open yet")
    put_cycle(True)
    cyc = lambda d: d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()  # noqa: E731
    s.check("modules on, no part dated: waiting to open (cycle_awaiting_open)",
            ask(lambda d: a.cycle_awaiting_open(d, cyc(d))))
    s.check("...never read as finished", not ask(lambda d: a.cycle_wound_down(d, cyc(d))))

    def mods(on):
        with a.app.app_context():
            d = a.get_db()
            for k in ("review", "pm", "idp"):
                d.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (on, CID, k))
            d.commit()
    mods(0)
    s.check("...not even with the check-in, Performance and the plan off, while no part has opened",
            not ask(lambda d: a.cycle_wound_down(d, cyc(d))) and ask(lambda d: a.cycle_awaiting_open(d, cyc(d))))
    mods(1)
    pill = ask(lambda d: a.nav_cycle_pill(d, cyc(d)))
    s.check("...and the top bar says 'Not open yet'", pill["note"] == "Not open yet" and pill["state"] == "upcoming",
            pill)
    put_window("tc_self", opens=when(5))
    first = a._parse_when(when(5))
    pill = ask(lambda d: a.nav_cycle_pill(d, cyc(d)))
    s.check("a first part dated ahead: the top bar says when it opens",
            pill["note"] == "Opens %d %s" % (first.day, first.strftime("%b %Y")), pill)
    put_window("pm_results", opens=when(-1))
    s.check("once a part has opened, the cycle is running", not ask(lambda d: a.cycle_awaiting_open(d, cyc(d))))
    no_windows()
    put_cycle(False)
    s.check("a cycle without the flag never waits on dates", not ask(lambda d: a.cycle_awaiting_open(d, cyc(d))))

    s.section("people")
    put_cycle(True)
    E = H.client_as(a, EMP)
    with a.app.test_request_context("/"):
        dash = a.url_for("dashboard")
    for path in ("/review", "/review/journey"):
        r = E.get(path)
        loc = r.headers.get("Location", "")
        s.check("%s goes to the dashboard" % path, r.status_code == 302 and loc.endswith(dash), (r.status_code, loc))
    r = E.post("/review/kpi/remark", data={"csrf_token": "tok", "remark": "x"})
    j = r.get_json(silent=True) or {}
    s.check("a write through the window gate is refused, with the sentence", r.status_code == 409
            and j.get("window_closed") and "isn't open yet" in (j.get("error") or ""), (r.status_code, j))
    put_window("pm_results", opens=when(-1))
    r = E.get("/review")
    s.check("...and once a part has opened, /review no longer turns them away",
            not (r.status_code == 302 and r.headers.get("Location", "").endswith(dash)),
            (r.status_code, r.headers.get("Location")))
    no_windows()

    s.section("the admin calendar")
    SUP = H.client_as(a, SU["id"])
    pg = SUP.get("/admin/cycle?cycle=%d" % CID).get_data(as_text=True)
    s.check("it says nothing is open, and why", "is open yet</h2>" in pg and "Each part opens on its start date" in pg
            and "Not open: no start date" in pg and "No start date: not open" in pg)
    s.check("...never 'open now' or 'open all cycle'", "parts are open now" not in pg and "open all cycle" not in pg)
    s.check("Edit all dates says the same", "A part with no opening date stays closed." in SUP.get(
        "/admin/windows?cycle=%d" % CID).get_data(as_text=True))
    SUP.post("/admin/windows", data={"csrf_token": "tok", "cycle": str(CID), "action": "open_now:pm_results"})
    s.check("Open now opens a part from now", ask(lambda d: a.window_state(d, "pm_results", CID)) == "open")
    no_windows()
    put_cycle(False)
    pg = SUP.get("/admin/cycle?cycle=%d" % CID).get_data(as_text=True)
    s.check("a cycle without the flag still says its parts are open now", "parts are open now" in pg
            and "Open, no dates" in pg)

    s.section("Start and the backfill")
    src = H.source(a)
    ins = re.search(r'"INSERT INTO cycles\(code, name, ends_on, starts_on, is_active, year, half, kind, min_job_grade, "'
                    r'\s*"no_potential, awaiting_open, open_by_date\) VALUES \(\?,\?,\?,\?,1,\?,\?,\?,\?,\?,\?,1\)"', src)
    s.check("Start sets the flag on every new cycle", bool(ins))
    mig = src[src.index('if ccols and "open_by_date" not in ccols:'):][:300]
    s.check("the migration adds the column, and backfills the cycles started since 2026-10-18, once",
            'ALTER TABLE cycles ADD COLUMN open_by_date INTEGER' in mig
            and "UPDATE cycles SET open_by_date=1 WHERE created_at >= '2026-10-18'" in mig)
    s.check("...and a fresh database has it in SCHEMA", "    open_by_date INTEGER\n);" in src)

    s.section("the overall remark's hint")
    js = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
    blk = js[js.index("var KPI_RM_ALSO"):js.index("var KPI_RM_COVER")]
    s.check("it asks for the key projects, important initiatives or greatest achievement",
            "Also highlight your key projects, important initiatives or greatest achievement" in blk)
    s.check("...at every result (strong, meets, below)", len(re.findall(r'" \+ KPI_RM_ALSO', blk)) == 3)
finally:
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET open_by_date=?, awaiting_open=?, starts_on=? WHERE id=?",
                  (a._row_get(CYC, "open_by_date"), a._row_get(CYC, "awaiting_open"), CYC["starts_on"], CID))
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        d.executemany("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at, updated_by) VALUES (?,?,?,?,?)",
                      WIN)
        d.execute("DELETE FROM cycle_modules WHERE cycle_id=?", (CID,))
        d.executemany("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", MODS)
        d.execute("DELETE FROM activity_log WHERE id>? AND action='window'", (LOG0,))
        d.commit()

sys.exit(s.done())
