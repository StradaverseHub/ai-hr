"""The old KPI-setting chat is only for a scorecard still being built (Chris, 2026-10-13: "This is not the right
interface for the user page, revert back to our previous confirmed design").

What sent the Employee persona there: the Group Chief demo persona has no KPI scorecard, so its KPI setting is open and
/review lands it on the standalone KPI-setting chat (/review/setting); switching persona then returned to that same
page, and the page opened for the Employee although their scorecard is approved.

What this suite holds:
  * on the AI+ check-in, /review/setting sends anyone whose scorecard is agreed (or with the approver) to /review, and
    still opens for someone whose scorecard is being built
  * a persona switch made on a per-stage review page lands on the new persona's own /review; the journey, the dashboard
    and other pages are kept
  * the classic KPI-setting page goes to the AI+ check-in once the scorecard is agreed, never the KPI-setting chat

Self-contained: seeds its own demo personas and KPI lines, and deletes them at the end.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The KPI-setting chat only while a scorecard is being built")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

BG = "ZZ Setting Landing BG"
ids = {}
_real_avail = a.ai_draft.review_agent_available
a.ai_draft.review_agent_available = lambda: True


def loc(r):
    return r.headers.get("Location", "") if r.status_code in (301, 302) else ""


try:
    with a.app.app_context():
        db = a.get_db()
        CID = a.active_cycle_id(db)
        PID = a.active_pm_period_id(db)
        # KPI setting runs in an Early Year only (2026-10-15): this suite's cycle is one while it runs
        _prev_cyc = dict(db.execute("SELECT half, kind FROM cycles WHERE id=?", (CID,)).fetchone())
        db.execute("UPDATE cycles SET half=0, kind='early_year' WHERE id=?", (CID,))
        _prev_mod = {k: db.execute("SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key=?",
                                   (CID, k)).fetchone() for k in ("review", "pm")}
        for k in ("review", "pm"):
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, ?, 1) "
                       "ON CONFLICT(cycle_id, module_key) DO UPDATE SET active=1", (CID, k))

        def mk(persona, switcher=0):
            return db.execute(
                "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                "department, job_grade, confirmation_date, demo_persona, demo_switcher) VALUES "
                "(?,?, 'x', 'user', ?, ?, 'ZZ SL Co', 'ZZ SL Dept', '14', '2020-01-01', ?, ?)",
                ("ZZSL-" + persona, "ZZ SL " + persona.title(), "ZZSL-" + persona, BG, persona, switcher)).lastrowid
        ids["emp"] = mk("employee", 1)
        ids["gc"] = mk("groupchief")
        for n in ("ZZSL Output", "ZZSL Quality"):
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                       "business_group, company, rate1, rate2, rate3, rate4, rate5) "
                       "VALUES (?,?,?,50,'more','approved',?,'ZZ SL Co',1,2,3,4,5)", (PID, ids["emp"], n, BG))
        db.commit()

    with a.app.test_request_context("/"):
        db = a.get_db()
        st_e = a.review_state(db, db.execute("SELECT * FROM users WHERE id=?", (ids["emp"],)).fetchone())
        st_g = a.review_state(db, db.execute("SELECT * FROM users WHERE id=?", (ids["gc"],)).fetchone())
        ag = lambda st: next((x["state"] for x in st["stages"] if x["key"] == "agree"), None)  # noqa: E731
        s.check("the employee's KPI setting is done (approved scorecard)", ag(st_e) == a.REVIEW_STATE_DONE, ag(st_e))
        s.check("the persona with no scorecard has its KPI setting open", ag(st_g) == a.REVIEW_STATE_OPEN, ag(st_g))

    s.section("/review/setting only while the scorecard is being built")
    E = H.client_as(a, ids["emp"])
    r = E.get("/review/setting")
    s.check("an approved scorecard: /review/setting sends them to /review", r.status_code == 302 and
            loc(r).endswith("/review"), (r.status_code, loc(r)))
    s.check("...and /review never takes them back to the KPI-setting chat",
            "/review/setting" not in loc(E.get("/review")))
    G = H.client_as(a, ids["gc"])
    r = G.get("/review/setting")
    s.check("a scorecard still being built: the KPI-setting chat opens", r.status_code == 200, r.status_code)

    s.section("a persona switch from a per-stage review page lands on the new persona's own review")
    with E.session_transaction() as ss:
        ss["demo_as"] = ids["gc"]
    for nxt, want in (("/review/setting", "/review"), ("/review/account", "/review"),
                      ("/review/journey?view=team&stage=pm_review", "/review/journey?view=team&stage=pm_review"),
                      ("/dashboard", "/dashboard"), ("/review", "/review")):
        r = E.post("/demo/switch", data={"csrf_token": "tok", "persona": "employee", "next": nxt})
        s.check("switching from %s lands on %s" % (nxt, want), r.status_code == 302 and loc(r).endswith(want),
                (r.status_code, loc(r)))
    with E.session_transaction() as ss:
        ss.pop("demo_as", None)

    s.section("the classic KPI-setting page goes to the check-in once the scorecard is agreed")
    r = E.get("/performance/setting", headers={"Sec-Fetch-Mode": "navigate"})
    s.check("approved scorecard: the classic page doesn't open the KPI-setting chat",
            "/review/setting" not in loc(r), (r.status_code, loc(r)))
    r = G.get("/performance/setting", headers={"Sec-Fetch-Mode": "navigate"})
    s.check("a scorecard being built: the classic page still opens the KPI-setting chat",
            loc(r).endswith("/review/setting"), (r.status_code, loc(r)))
finally:
    a.ai_draft.review_agent_available = _real_avail
    with a.app.app_context():
        db = a.get_db()
        if ids:
            ph = ",".join("?" * len(ids))
            db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, list(ids.values()))
            db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph),
                       list(ids.values()) * 2)
            db.execute("DELETE FROM users WHERE id IN (%s)" % ph, list(ids.values()))
        db.execute("UPDATE cycles SET half=?, kind=? WHERE id=?", (_prev_cyc["half"], _prev_cyc["kind"], CID))
        for k, v in _prev_mod.items():
            if v is None:
                db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k))
            else:
                db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v[0], CID, k))
        db.commit()
sys.exit(s.done())
