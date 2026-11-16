"""The QC sweep's fixes (Chris, 2026-10-24: "run a thorough test and review on our user (all personas) and admin pages
... see if there are any issues or gaps", then "go ahead and fix them").

What this suite holds:
  * the top bar's pill says the person's OWN deadline, the soonest-closing part of theirs that is open ("Your check-in
    closes 8 Nov", "Your team's reviews close 15 Nov"), and only the cycle's name to someone with nothing open; it read
    the cycle's end for everyone ("Check-in open until 31 Jan"); Ask OneHR's greeting says the same
  * a line manager whose people write a Career Plan has the Team view at Year-End (43 on production had plans to review
    and no Team tab), never at Mid-Year
  * the 360 rules card never prints "the full panel (None)" with No maximum
  * a side panel written between two admin cards keeps their gap (Participants' units card touched its filters)
  * the check-in saves card answers, typed results and a remark still being typed on the way out (they were lost on
    the Dashboard button): a link waits for the save, the tab's close sends it with keepalive
"""
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The QC sweep's fixes: own deadline, the Team tab for plans, the rules sentence, the gap, saves on leaving")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    CYC0 = dict(db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())
    WIN0 = [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (CID,))]
    MOD0 = [dict(r) for r in db.execute("SELECT * FROM cycle_modules WHERE cycle_id=?", (CID,))]
    SET0 = {r[0]: r[1] for r in db.execute("SELECT key, value FROM app_settings WHERE key IN ('panel_size')")}
    db.execute("UPDATE cycles SET half=2, kind='year_end', open_by_date=1, starts_on='2026-01-01', ends_on='2027-01-31', "
               "min_job_grade=12 WHERE id=?", (CID,))
    # someone with nothing of their own: below the floor, leading, seated and rating no one (their grade put back after)
    NONE_ROW = db.execute(
        "SELECT id, job_grade FROM users u WHERE role!='admin' AND left_at IS NULL AND COALESCE(bgceo_bg,'')='' "
        "AND NOT EXISTS (SELECT 1 FROM users r WHERE (r.manager_id=u.id OR r.hod_id=u.id) AND r.left_at IS NULL) "
        "AND NOT EXISTS (SELECT 1 FROM buceo_seats b WHERE b.user_id=u.id) "
        "AND NOT EXISTS (SELECT 1 FROM calib_bu_groups g WHERE g.calibrator_id=u.id) "
        "AND NOT EXISTS (SELECT 1 FROM pm_calibration_groups g WHERE g.calibrator_id=u.id) "
        "AND NOT EXISTS (SELECT 1 FROM assignments x WHERE x.assessor_id=u.id AND x.cycle_id=?) ORDER BY id LIMIT 1",
        (CID,)).fetchone()
    if NONE_ROW:
        db.execute("UPDATE users SET job_grade='5' WHERE id=?", (NONE_ROW[0],))
    for k in a.CYCLE_MODULE_KEYS:
        db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, k))
    db.commit()
    NOW = a._now_myt()


def day(d):
    return (NOW + timedelta(days=d)).strftime("%Y-%m-%d")


def windows(**cells):
    """cell=(opens in days, closes in days); every other cell undated."""
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for cell, (o, c) in cells.items():
            d.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                      (CID, cell, day(o) + " 00:00", day(c) + " 23:59"))
        d.commit()


def pill(uid=None):
    with a.app.test_request_context("/"):
        d = a.get_db()
        u = d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone() if uid else None
        return a.nav_cycle_pill(d, a.active_cycle(d), u)


def dmon(n):
    t = NOW + timedelta(days=n)
    return "%d %s" % (t.day, t.strftime("%b"))


try:
    with a.app.test_request_context("/"):
        d = a.get_db()
        users = d.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL ORDER BY id").fetchall()
        cyc = a.active_cycle(d)
        # someone in the check-in (KPI and competency) who leads no one, sits on no seat and rates nobody this cycle
        EMP = next((u["id"] for u in users if a.participation(d, u, cyc, module="pm")[0]
                    and a.participation(d, u, cyc, module="competency")[0]
                    and a._pill_my_cells(d, u, cyc) == {"pm_results", "tc_self", "idp_self"}), None)
        # a line manager in the check-in themselves
        LM = next((u["id"] for u in users if a.participation(d, u, cyc, module="pm")[0]
                   and {"pm_results", "pm_approve"} <= a._pill_my_cells(d, u, cyc)), None)
        NONE = NONE_ROW[0] if NONE_ROW and not a._pill_my_cells(
            d, d.execute("SELECT * FROM users WHERE id=?", (NONE_ROW[0],)).fetchone(), cyc) else None

    s.section("the pill says the person's own deadline")
    s.check("there is someone in the check-in, a line manager and someone with nothing of theirs",
            bool(EMP and LM and NONE), (EMP, LM, NONE))
    windows(pm_results=(-2, 6), tc_self=(-2, 3), idp_self=(-2, 10), pm_approve=(7, 12))
    p = pill(EMP)
    s.check("their check-in's soonest-closing open part: 'Your check-in closes %s'" % dmon(3),
            p["note"] == "Your check-in closes %s" % dmon(3) and p["state"] == "open", p)
    windows(pm_results=(-2, 6), tc_self=(-2, 9), idp_self=(-2, 10))
    s.check("...the next one when that moves later (%s)" % dmon(6), pill(EMP)["note"] == "Your check-in closes %s" % dmon(6),
            pill(EMP))
    windows(pm_results=(-2, 6), pm_approve=(-1, 2))
    s.check("a line manager whose team's reviews close first: 'Your team's reviews close %s'" % dmon(2),
            pill(LM)["note"] == "Your team's reviews close %s" % dmon(2), pill(LM))
    s.check("...the employee with no team still reads their check-in", pill(EMP)["note"] == "Your check-in closes %s"
            % dmon(6), pill(EMP))
    windows(pm_results=(-9, -1), tc_self=(-9, -1), idp_self=(-9, -1), pm_approve=(-1, 2))
    s.check("once their own parts have closed, the employee's pill is the cycle's name alone", pill(EMP)["note"] == "",
            pill(EMP))
    s.check("someone with nothing of theirs in the cycle: the name alone", pill(NONE)["note"] == "", pill(NONE))
    s.check("...never the cycle's end date for anyone", "31 Jan" not in (pill(EMP)["note"] + pill(LM)["note"]))
    s.check("without a person (no one signed in), no note", pill(None)["note"] == "")
    with a.app.test_request_context("/"):
        lead = a._ask_intro({"mode": "running", "welcome": {"first_name": "Ana"}}, {"note": "Your check-in closes 8 Nov",
                                                                                     "name": "2026 Year-End"})["lead"]
        lead0 = a._ask_intro({"mode": "running", "welcome": {"first_name": "Ana"}}, {"note": "", "name": "2026 Year-End"})["lead"]
    s.check("Ask OneHR's greeting says the same", lead == "Hi Ana. Your check-in closes 8 Nov.", lead)
    s.check("...and to someone with nothing open: nothing needs them", lead0 == "Hi Ana. Nothing in the 2026 Year-End needs "
            "you right now.", lead0)
    page = H.client_as(a, NONE).get("/dashboard").get_data(as_text=True)
    s.check("the top bar shows the name with no dangling separator", "tb-cycle-sep" not in page and "tb-cycle" in page)
    src = open(os.path.join(REPO, "app.py"), encoding="utf-8").read()
    s.check("the old 'open until' / 'was due' cycle-end wording is gone from the pill",
            "%s open until %d %s" not in src and "%s was due %d %s\" % (what" not in src)

    s.section("a line manager whose people write a Career Plan has the Team view")
    windows(pm_results=(-2, 6), idp_self=(-2, 6), idp_review=(-1, 9))
    with a.app.test_request_context("/review/journey"):
        d = a.get_db()
        cid = a.active_cycle_id(d)
        plan_only = None
        for m in d.execute("SELECT DISTINCT m.* FROM users m JOIN users r ON r.manager_id=m.id AND r.left_at IS NULL "
                           "WHERE m.left_at IS NULL AND m.role!='admin' ORDER BY m.id"):
            if (a._idp_lm_has_plans(d, m) and not a._pm_manages_anyone(d, m)
                    and not a._hub_tc_flags(d, m, cid)[1]):
                plan_only = m
                break
        s.check("there is a line manager with plans to review and no KPI line or competency of theirs to review",
                plan_only is not None)
        s.check("...at Year-End they have a Team view", plan_only is not None and a._review_manages_team(d, plan_only)
                and "team" in a._journey_views(d, plan_only))
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET half=1, kind='mid_year' WHERE id=?", (CID,))
        d.commit()
    with a.app.test_request_context("/review/journey"):
        d = a.get_db()
        s.check("...never at Mid-Year (the plan review is Year-End only)", plan_only is not None
                and not a._review_manages_team(d, plan_only))
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET half=2, kind='year_end' WHERE id=?", (CID,))
        d.commit()

    s.section("the 360 rules card with No maximum")
    SUC = H.client_as(a, SU["id"])
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('panel_size', 'none')")
        d.commit()
    pg = SUC.get("/admin/m/f360/settings").get_data(as_text=True)
    s.check("no '(None)' in the sentence; it says everyone on the panel", "full panel (None)" not in pg
            and "everyone on the person" in pg)
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('panel_size', '4')")
        d.commit()
    pg = SUC.get("/admin/m/f360/settings").get_data(as_text=True)
    s.check("...with a number, the number", "full panel (4)" in pg)

    s.section("a side panel between two admin cards keeps their gap")
    css = open(os.path.join(REPO, "static", "style.css"), encoding="utf-8").read()
    s.check("the stacked-card gap passes over a side panel", ".admin-card + aside.adm-panel + .admin-card { margin-top: 16px; }"
            in css)
    pp = SUC.get("/admin/participants").get_data(as_text=True)
    m = re.search(r'class="admin-card pt-units".*?</section>\s*(<aside class="adm-panel[^"]*"[^>]*>).*?</aside>\s*'
                  r'<section class="admin-card adm-filters"', pp, re.S)
    s.check("...as on Participants for the super admin: units card, the Leave-out panel, the filters card", bool(m))

    s.section("the check-in saves on the way out")
    js = open(os.path.join(REPO, "static", "journey_chat.js"), encoding="utf-8").read()
    blk = js[js.index("function leaveSaves()"):js.index('window.addEventListener("pagehide"') + 80]
    s.check("card answers and typed results go through Save's own routes", all(r in blk for r in (
        "/review/kpi/save-all", "/review/competency/save-all", "/review/feedback/save-all", "/review/kpi/remark", "o.url")))
    s.check("...a link waits for them (capture phase, before the move veil), at most 4 s",
            "}, true);" in blk and "e.preventDefault(); e.stopPropagation();" in blk and "4000" in blk)
    s.check("...the tab's close sends them with keepalive", 'addEventListener("pagehide"' in blk
            and "keepalive: !!keepalive" in blk)
    s.check("...and nothing is submitted (no submit or sign-off route in it)",
            not re.search(r"/submit|signoff|/confirm", blk))
finally:
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET half=?, kind=?, open_by_date=?, starts_on=?, ends_on=?, min_job_grade=? WHERE id=?",
                  (CYC0["half"], CYC0["kind"], CYC0["open_by_date"], CYC0["starts_on"], CYC0["ends_on"],
                   CYC0["min_job_grade"], CID))
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for w in WIN0:
            d.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (", ".join(w), ",".join("?" * len(w))), list(w.values()))
        d.execute("DELETE FROM cycle_modules WHERE cycle_id=?", (CID,))
        for m_ in MOD0:
            d.execute("INSERT INTO cycle_modules(%s) VALUES (%s)" % (", ".join(m_), ",".join("?" * len(m_))),
                      list(m_.values()))
        if NONE_ROW:
            d.execute("UPDATE users SET job_grade=? WHERE id=?", (NONE_ROW[1], NONE_ROW[0]))
        d.execute("DELETE FROM app_settings WHERE key='panel_size'")
        for k, v in SET0.items():
            d.execute("INSERT INTO app_settings(key, value) VALUES (?,?)", (k, v))
        d.commit()

sys.exit(s.done())
