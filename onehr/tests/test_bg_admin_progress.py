"""The BG admins' daily status email (Chris, 2026-10-30, canvas [design canvas link removed] boards
6 and 7): each group-wide BG admin gets their group by business unit -- the BG CEO's table -- every day at the super
admin's time, at the addresses on their admin account's notification emails, from the day AFTER a part opens, while it is
open. Its own rules (app_settings 'bg_admin_progress_rules'), its own words (the lp_bgadmin template).

What this suite holds (a made-up group of synthetic people and admins, all put back at the end):
  * who: a group-wide BG admin yes; the super admin, an L&D admin, a unit admin, a whole-company role's admin, a demo
    admin and a left admin no -- and each guard falsified (take it away and the account is in)
  * where: every address on the account's notification emails, one email each; none -> nothing, logged and counted
  * what: the BG CEO's table for that group (the same sections, the same table HTML), the counts against what was seeded;
    every unit complete -> no email
  * the day-after rule (bga_live_parts): a part that opened today is not a column and alone sends nothing; opened
    yesterday and open -> a column; closed, or not open yet -> none; a part with no open date that is open has been
    open all along
  * when: the rules checked on read, the form's refusals, before the send time no, the grace hours, once a day (the
    _last key written before sending), off, no email on a server with no mail set up, the job through the mailer stub
  * the words: the lp_bgadmin template kind, the default words, the legacy fallback, the made-up sample
  * the page: the card, Save (audited), the test to the super admin's own notification emails only
"""
import html as _html
import os
import re
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The BG admins' daily status email")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
assert not a.mailer.is_configured(), "the harness must not send email"
SU, _BGA0, _E = H.actors(a)
BG, UA, UB = "ZZBGA Group", "ZZBGA Alpha", "ZZBGA Beta"
BG2, UC = "ZZBGA Group Two", "ZZBGA Gamma"   # every person finished: nothing to report
KEYS = ("bg_admin_progress_rules", "bg_admin_progress_last", "leader_progress_rules", "leader_progress_template",
        "leader_progress_last")
_real = (a.mailer.is_configured, a.mailer.send_mail, a.mailer.config_status, a.OUTBOX_ASYNC, a.bga_admins,
         a.mailer.get_token)
SENT = []


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BGA-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        for sql in ("DELETE FROM email_outbox WHERE user_id IN (%s)", "DELETE FROM notifications WHERE user_id IN (%s)",
                    "DELETE FROM admin_notify_emails WHERE user_id IN (%s)",
                    "DELETE FROM admin_companies WHERE admin_id IN (%s)",
                    "DELETE FROM activity_log WHERE user_id IN (%s)", "DELETE FROM users WHERE id IN (%s)"):
            db.execute(sql % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM tc_skills WHERE skill_code='ZZ9BGA-SKILL'")
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CYC = db.execute("SELECT * FROM cycles WHERE is_active=1").fetchone()
    CID = CYC["id"]
    OBD = CYC["open_by_date"]
    SAVED = {k: db.execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone() for k in KEYS}
    TPLS = H.stash_email_templates(db)
    WIN = [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (CID,))]
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    OUT0 = db.execute("SELECT COALESCE(MAX(id),0) FROM email_outbox").fetchone()[0]
    NOTE0 = db.execute("SELECT COALESCE(MAX(id),0) FROM notifications").fetchone()[0]
    SKILL = (db.execute("SELECT id FROM tc_skills ORDER BY id LIMIT 1").fetchone() or [None])[0]
    if SKILL is None:   # the synthetic fixture has no skills: make one, taken out below
        SKILL = db.execute("INSERT INTO tc_skills(skill_code, title) VALUES ('ZZ9BGA-SKILL', 'ZZ9BGA skill')").lastrowid
    for bg_, co in ((BG, UA), (BG, UB), (BG2, UC)):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (bg_, co))
    ID = {}

    def person(key, bg, co, dept, kpi_done, tc_done):
        ID[key] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_grade, years_of_service, email) VALUES (?,?,'x','user',?,?,?,?,14,3,?)",
            ("zz9bga-" + key.lower(), "ZZ BGA Person " + key, "ZZ9BGA-" + key, bg, co, dept,
             "zz9bga-%s@example.test" % key.lower())).lastrowid
        t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, "
                       "status) VALUES (?,?,?,100,'more',?,'approved')", (CID, ID[key], "ZZBGA KPI " + key, bg)).lastrowid
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, draft, admin_filled) VALUES (?,10,?,0)",
                   (t, 0 if kpi_done else 1))
        if kpi_done:
            db.execute("INSERT INTO pm_review_session(subject_id, cycle_id, locked_at) VALUES (?,?,datetime('now'))",
                       (ID[key], CID))
        db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) VALUES (?,?,?)", (CID, ID[key], SKILL))
        db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status, submitted_at) VALUES (?,?,?,?)",
                   (CID, ID[key], "submitted" if tc_done else "pending", "2026-10-01 00:00" if tc_done else None))
    # ZZBGA Group: Alpha has 3 people (2 finished both parts), Beta 2 (both finished): 4 of 5 in each part
    for k, co, dept, kd, td in (("A1", UA, "Sales", 1, 1), ("A2", UA, "Sales", 1, 1), ("A3", UA, "Sales", 0, 0),
                                ("B1", UB, "Finance", 1, 1), ("B2", UB, "Finance", 1, 1)):
        person(k, BG, co, dept, kd, td)
    person("C1", BG2, UC, "Ops", 1, 1)
    person("C2", BG2, UC, "Ops", 1, 1)
    # the BG CEO of ZZBGA Group: the table the BG admin gets is theirs
    ID["CEO"] = db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, years_of_service, email, bgceo_bg) VALUES ('zz9bga-ceo','ZZ BGA Chief','x','user','ZZ9BGA-CEO',?,?,"
        "'Leadership',23,0,'zz9bga-ceo@example.test',?)", (BG, UA, BG)).lastrowid

    def admin(key, admin_bg, left=False, demo=0, notify=()):
        ID[key] = db.execute(
            "INSERT INTO users (username, full_name, display_name, password_hash, role, employee_id, business_group, "
            "admin_bg, is_demo, left_at) VALUES (?,?,?,'x','admin',?,?,?,?,?)",
            ("zz9bga-" + key.lower(), "ZZ BGA Admin " + key, "Zed " + key, "ZZ9BGA-" + key, admin_bg or None,
             admin_bg, demo, "2026-09-01" if left else None)).lastrowid
        for n_ in notify:
            db.execute("INSERT INTO admin_notify_emails(user_id, email) VALUES (?,?)", (ID[key], n_))
    admin("BGA1", BG, notify=("zz9bga-1@example.test", "zz9bga-1b@example.test"))   # two addresses
    admin("BGA2", BG)                                                                # none
    admin("BGA3", BG2, notify=("zz9bga-3@example.test",))                            # everything finished
    admin("SUP2", "", notify=("zz9bga-sup2@example.test",))                          # a second super admin
    admin("LND", a.LMS_ADMIN_BG, notify=("zz9bga-lnd@example.test",))
    admin("UNIT", BG, notify=("zz9bga-unit@example.test",))
    db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (ID["UNIT"], UA))
    admin("LEFT", BG, left=True, notify=("zz9bga-left@example.test",))
    admin("CO", a.ADMIN_COMPANY_SCOPE, notify=("zz9bga-co@example.test",))
    admin("DEMO", BG, demo=1, notify=("zz9bga-demo@example.test",))
    db.commit()


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def setwin(spec, open_by_date=1):
    """The cycle's windows exactly as `spec` says ({cell: (opens, closes)}), and whether parts open by date."""
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for cell, (o, c) in spec.items():
            d.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell, o, c))
        d.execute("UPDATE cycles SET open_by_date=? WHERE id=?", (open_by_date, CID))
        d.commit()


F = "%Y-%m-%d %H:%M"
NOW = a._now_myt()
TODAY = NOW.date()
YEST = (NOW - timedelta(days=1)).strftime("%Y-%m-%d") + " 00:00"
OPEN_TODAY = TODAY.strftime("%Y-%m-%d") + " 00:00"
LATER = (NOW + timedelta(days=10)).strftime(F)
TOMORROW = (NOW + timedelta(days=1)).strftime("%Y-%m-%d") + " 00:00"
PAST = (NOW - timedelta(days=3)).strftime("%Y-%m-%d") + " 00:00"
BOTH = ["pm_results", "tc_self"]
LIVE = lambda rules, today=None: ctx(lambda d: [p[0][0] for p in a.bga_live_parts(   # noqa: E731
    d, a.active_cycle(d), rules, today)])
SET = lambda k: ctx(lambda d: a._setting(k))   # noqa: E731
DBG = lambda bg: ctx(lambda d: a.display_bg(bg))   # noqa: E731
DCO = lambda bg, co: ctx(lambda d: a.display_company(bg, co))   # noqa: E731
ZZ = lambda d: [u for u in _real[4](d) if (u["employee_id"] or "").startswith("ZZ9BGA-")]   # noqa: E731

try:
    s.section("who gets it: a group-wide BG admin")
    ids = ctx(lambda d: {u["id"]: u for u in a.bga_admins(d)})
    s.check("a group-wide BG admin is in, with or without notification emails", ID["BGA1"] in ids and ID["BGA2"] in ids
            and ID["BGA3"] in ids)
    for key, why in (("SUP2", "the super admin (no group)"), ("LND", "the L&D admin"), ("UNIT", "a unit admin"),
                     ("LEFT", "an admin who has left"), ("CO", "a whole-company role's admin"), ("DEMO", "a demo admin")):
        s.check("...%s is out" % why, ID[key] not in ids)
    s.check("...and so is the real super admin", SU["id"] not in ids)

    def flip(sql, args, key):   # falsify a guard: take it away and the account is in
        with a.app.app_context():
            d = a.get_db()
            d.execute(sql, args)
            d.commit()
        return ID[key] in ctx(lambda d_: {u["id"] for u in a.bga_admins(d_)})
    s.check("falsified: a unit admin with no unit rows IS a BG admin", flip(
        "DELETE FROM admin_companies WHERE admin_id=?", (ID["UNIT"],), "UNIT"))
    with a.app.app_context():
        a.get_db().execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (ID["UNIT"], UA))
        a.get_db().commit()
    s.check("falsified: an L&D admin pointed at a group IS one", flip(
        "UPDATE users SET admin_bg=? WHERE id=?", (BG, ID["LND"]), "LND"))
    flip("UPDATE users SET admin_bg=? WHERE id=?", (a.LMS_ADMIN_BG, ID["LND"]), "LND")
    s.check("falsified: an admin who has not left IS one", flip("UPDATE users SET left_at=NULL WHERE id=?", (ID["LEFT"],), "LEFT"))
    flip("UPDATE users SET left_at='2026-09-01' WHERE id=?", (ID["LEFT"],), "LEFT")
    s.check("falsified: a demo flag off IS one", flip("UPDATE users SET is_demo=0 WHERE id=?", (ID["DEMO"],), "DEMO"))
    flip("UPDATE users SET is_demo=1 WHERE id=?", (ID["DEMO"],), "DEMO")
    s.check("...put back: the guards hold again", all(ID[k] not in ctx(lambda d: {u["id"] for u in a.bga_admins(d)})
                                                    for k in ("LND", "UNIT", "LEFT", "DEMO")))

    s.section("the day-after rule: a part is a column from the day after its window opens, while it is open")
    setwin({"pm_results": (YEST, LATER), "tc_self": (OPEN_TODAY, LATER), "idp_self": (PAST, YEST),
            "f360": (TOMORROW, LATER)})
    every = dict(a.BGA_DEFAULT_RULES, parts=["pm_results", "tc_self", "idp_self", "f360"])
    s.check("opened yesterday and open: a column", "pm_results" in LIVE(every))
    s.check("opened today: not a column", "tc_self" not in LIVE(every), LIVE(every))
    s.check("...falsified: the day after, it is", "tc_self" in LIVE(every, TODAY + timedelta(days=1)))
    s.check("closed: none", "idp_self" not in LIVE(every))
    s.check("not open yet: none, even on the day after", "f360" not in LIVE(every)
            and "f360" not in LIVE(every, TODAY))
    s.check("only the open-before-today part is counted", LIVE(every) == ["pm_results"], LIVE(every))
    setwin({"pm_results": (TODAY.strftime("%Y-%m-%d"), LATER), "tc_self": (YEST[:10], LATER)})   # a date with no time
    s.check("an open date without a time is that day's start: today is still not a column", LIVE(
        dict(every, parts=BOTH)) == ["tc_self"], LIVE(dict(every, parts=BOTH)))
    # the example: employee parts open 2 Nov -> columns from 3 Nov; line managers' parts open 9 Nov -> from 10 Nov
    setwin({"pm_results": ("2026-11-02 00:00", "2026-11-08 23:59"), "pm_approve": ("2026-11-09 00:00", "2026-11-15 23:59")})
    _clock = (a._now_myt, a._today_myt)

    def on_day(y, m, dd):
        a._now_myt = lambda: datetime(y, m, dd, 10, 0)
        a._today_myt = lambda: datetime(y, m, dd).date()
        try:
            return ctx(lambda d: [p[0][0] for p in a.bga_live_parts(d, a.active_cycle(d), dict(every, parts=[
                "pm_results", "pm_approve", "tc_self"]))])
        finally:
            a._now_myt, a._today_myt = _clock
    s.check("the example: the employee parts open Mon 2 Nov, so no column that day, a column on Tue 3 Nov",
            on_day(2026, 11, 2) == [] and on_day(2026, 11, 3) == ["pm_results"], (on_day(2026, 11, 2), on_day(2026, 11, 3)))
    s.check("...the line managers' parts open Mon 9 Nov (the employees' have closed): no column that day, theirs on Tue 10 Nov",
            on_day(2026, 11, 9) == [] and on_day(2026, 11, 10) == ["pm_approve"],
            (on_day(2026, 11, 9), on_day(2026, 11, 10)))
    setwin({"pm_results": (YEST, LATER)}, open_by_date=0)   # tc_self has no window and parts are not dated: open all along
    s.check("a part with no open date that is open has been open all along", "tc_self" in LIVE(dict(every, parts=BOTH)),
            LIVE(dict(every, parts=BOTH)))
    setwin({"pm_results": (YEST, LATER)}, open_by_date=1)
    s.check("...falsified: in a cycle whose parts open by date it isn't open at all", "tc_self" not in LIVE(
        dict(every, parts=BOTH)))
    only_today = dict(every, parts=["tc_self"])
    setwin({"tc_self": (OPEN_TODAY, LATER)})
    s.check("a part that opened today, alone, sends nothing: no admin built", ctx(lambda d: a.bga_build(
        d, a.active_cycle(d), only_today)) == ([], []))

    s.section("the rules and the form")
    from werkzeug.datastructures import MultiDict
    s.check("defaults: off, 09:00, all six parts", ctx(lambda d: a.bga_rules()) == {
        "enabled": False, "send_time": "09:00", "parts": [p[0] for p in a.LP_PARTS]} and len(a.LP_PARTS) == 6)
    r, errs = ctx(lambda d: a.bga_rules_from(MultiDict({"enabled": "on", "send_time": "10:30", "part": ["pm_results", "f360"]})))
    s.check("a good form saves what it says", not errs and r == {"enabled": True, "send_time": "10:30",
                                                                 "parts": ["pm_results", "f360"]}, (r, errs))
    for bad, why in ((MultiDict({"send_time": "25:00", "part": ["f360"]}), "HH:MM"), (MultiDict({"send_time": "09:00"}),
                                                                                     "at least one thing")):
        _r, e = ctx(lambda d: a.bga_rules_from(bad))
        s.check("...refuses: %s" % why, any(why in x for x in e), e)
    s.check("...a time between the timer's runs moves to the next (the app's rule)", ctx(lambda d: a.bga_rules_from(
        MultiDict({"send_time": "09:07", "part": ["f360"]})))[0]["send_time"] == "09:15")
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('bg_admin_progress_rules', ?)",
                  ('{"enabled": "yes", "send_time": "99:99", "parts": ["nonsense", "f360"]}',))
        d.commit()
    junk = ctx(lambda d: a.bga_rules())
    s.check("a hand-edited setting can't break it: each value checked", junk == {
        "enabled": False, "send_time": "09:00", "parts": ["f360"]}, junk)
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('bg_admin_progress_rules', ?)", ("[1, 2]",))
        d.commit()
    s.check("...even one that isn't an object", ctx(lambda d: a.bga_rules())["enabled"] is False)
    with a.app.app_context():
        a.get_db().execute("DELETE FROM app_settings WHERE key='bg_admin_progress_rules'")
        a.get_db().commit()

    s.section("the table is the BG CEO's, and the counts are what was seeded")
    setwin({"pm_results": (YEST, LATER), "tc_self": (YEST, LATER)})
    two = dict(a.BGA_DEFAULT_RULES, parts=BOTH)
    a.bga_admins = lambda d: ZZ(d)
    built, live = ctx(lambda d: a.bga_build(d, a.active_cycle(d), two))
    by = {b["user"]["id"]: b for b in built}
    s.check("the ZZ BG admins are built: BGA1, BGA2 and BGA3 only", sorted(by) == sorted((ID["BGA1"], ID["BGA2"], ID["BGA3"])),
            sorted(by))
    sec = by[ID["BGA1"]]["sections"]
    s.check("a group with units behind: one section for the group, its business units as rows, furthest behind first",
            len(sec) == 1 and sec[0]["name"] == DBG(BG) and [r_["name"] for r_ in sec[0]["rows"]] == [
                DCO(BG, UA), DCO(BG, UB)], [(x["name"], [r_["name"] for r_ in x["rows"]]) for x in sec])
    rowA, rowB = sec[0]["rows"]
    s.check("...Alpha: 2 of 3 in both parts", [(c["n"], c["done"]) for c in rowA["cells"]] == [(3, 2), (3, 2)], rowA["cells"])
    s.check("...Beta: 2 of 2 in both parts", [(c["n"], c["done"]) for c in rowB["cells"]] == [(2, 2), (2, 2)], rowB["cells"])
    s.check("...the group total is 4 of 5 in both parts", [(c["n"], c["done"]) for c in sec[0]["total"]] == [(5, 4), (5, 4)])
    ceo_built = ctx(lambda d: a.lp_build(d, a.active_cycle(d), dict(a.lp_rules(), parts=BOTH), only=("bgceo", ID["CEO"])))
    ceo_secs = ceo_built[0][0]["sections"]
    s.check("the BG CEO's own sections for the group are the same, to the cell", ceo_secs == sec, (ceo_secs, sec))
    with a.app.test_request_context("/"):
        d = a.get_db()
        cy = a.active_cycle(d)
        ceo_u = d.execute("SELECT * FROM users WHERE id=?", (ID["CEO"],)).fetchone()
        bga_u = d.execute("SELECT * FROM users WHERE id=?", (ID["BGA1"],)).fetchone()
        sub_a, body_a = a.bga_mail(d, bga_u, sec, live, cy, two)
        sub_c, body_c = a.lp_mail(d, "bgceo", ceo_u, ceo_secs, ceo_built[1], [], cy)
    table = a._lp_table_html(sec[0], live, "Business unit")
    s.check("...and the leader email's table HTML is in the BG admin's email, byte for byte, as in the BG CEO's",
            table in body_a and table in body_c and "Business unit" in _html.unescape(body_a))
    s.check("the BG admin's email names no person counted", not re.search(r"ZZ BGA Person", body_a))
    s.check("...says it is theirs: Hi, the heading, the default opening, the portal button and the footer",
            "Hi Zed BGA1," in body_a and "Your group&#x27;s submission status" in body_a.replace("'", "&#x27;")
            and "This is the same view your BG CEO gets." in body_a and "Open the admin portal" in body_a
            and (a.app_base_url() + "/admin") in body_a, None)
    s.check("...the subject is the default: the group, then the date and time", sub_a.startswith(
        "%s: business units' submission status, " % DBG(BG)) and re.search(r"\d\d:\d\d$", sub_a), sub_a)
    s.check("...and a BG CEO's email is not changed by it (their button, their words)", "Open AI+ OneHR" in body_c
            and "Open the admin portal" not in body_c and "Your group" in body_c)
    s.check("never the word HR", " HR " not in _html.unescape(body_a) and "HRBP" not in body_a)
    on_rules = dict(two, enabled=True, send_time="08:45")
    body_on = ctx(lambda d: a.bga_mail(d, d.execute("SELECT * FROM users WHERE id=?", (ID["BGA1"],)).fetchone(), sec, live,
                                       a.active_cycle(d), on_rules))[1]
    s.check("the footer, when it is on, says why and when", "You get this because this address is on the notification "
            "emails of a OneHR admin account for %s." % DBG(BG) in _html.unescape(body_on)
            and "It goes out every day at 08:45 from the day after a part opens, while it is open." in _html.unescape(body_on))

    s.section("every unit complete: no email")
    s.check("the group whose people all finished has no section left", by[ID["BGA3"]]["sections"] == [])

    s.section("the send: one email an address, none without one, none for a finished group")
    with a.app.test_request_context("/"):
        d = a.get_db()
        t = a.bga_send(d, a.active_cycle(d), "test run", actor_id=SU["id"], rules=two)
        q = d.execute("SELECT to_email, kind, user_id, subject FROM email_outbox WHERE id>? ORDER BY id", (OUT0,)).fetchall()
        skipped = d.execute("SELECT user_id, status, detail FROM notifications WHERE id>? AND kind=? AND status='skipped'",
                            (NOTE0, a.BGA_KIND)).fetchall()
    s.check("tally: 3 admins, 1 emailed (2 addresses), 1 nothing to report, 1 no notification email", t == {
        "admins": 3, "emailed": 1, "addresses": 2, "nothing": 1, "no_email": 1}, t)
    s.check("one outbox row per address on BGA1's account, as a BG admin progress email", sorted(r_[0] for r_ in q) == [
        "zz9bga-1@example.test", "zz9bga-1b@example.test"] and all(r_[1] == "bg_admin_progress"
                                                                    and r_[2] == ID["BGA1"] for r_ in q), [tuple(r_) for r_ in q])
    s.check("...nothing for the admin with no address, nor the one whose group is finished", not any(
        r_[2] in (ID["BGA2"], ID["BGA3"]) for r_ in q))
    # since 2026-11-03 an admin with nothing to report is logged too (Email › Sent names them in its panel)
    s.check("the admin with no notification email is logged as skipped, and counted; the one with nothing to report too",
            sorted((r_[0], r_[2]) for r_ in skipped) == sorted([(ID["BGA2"], "no notification email"),
                                                                (ID["BGA3"], "nothing to report")]), [tuple(r_) for r_ in skipped])
    s.check("the run is written for the audit", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='bg_admin_progress_run' AND detail LIKE 'test run | "
        "3 BG admins | 1 emailed | 1 nothing to report | 1 no notification email | batch bga-%'", (LOG0,)) == 1)
    s.check("...with plain words for the activity list", a.ACTION_LABELS.get("bg_admin_progress_run") ==
            "Sent BG admin progress emails" and a.ACTION_LABELS.get("bg_admin_progress_schedule") ==
            "Changed the BG admin progress schedule")
    with a.app.test_request_context("/"):
        d = a.get_db()
        n0 = d.execute("SELECT COUNT(*) FROM email_outbox").fetchone()[0]
        a.bga_send(d, a.active_cycle(d), "dry", rules=two, live=False)
        s.check("a dry run queues nothing", d.execute("SELECT COUNT(*) FROM email_outbox").fetchone()[0] == n0)

    s.section("when it goes out")
    at = dict(on_rules, send_time="09:00")

    def due(now):
        return ctx(lambda d: a.lp_due_now(d, at, now, last_key=a.BGA_LAST_KEY, what="the BG admin status email"))
    day = datetime(TODAY.year, TODAY.month, TODAY.day)
    with a.app.app_context():
        a.get_db().execute("DELETE FROM app_settings WHERE key='bg_admin_progress_last'")
        a.get_db().commit()
    s.check("due at its time", due(day.replace(hour=9, minute=0))[0])
    s.check("...not before it, and the words say the BG admin email", not due(day.replace(hour=8, minute=59))[0]
            and "BG admin status email goes at 09:00" in due(day.replace(hour=8, minute=59))[1])
    s.check("...within the grace hours, not after", due(day.replace(hour=11, minute=59))[0]
            and not due(day.replace(hour=12, minute=1))[0])
    with a.app.app_context():
        a.get_db().execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('bg_admin_progress_last', ?)",
                           (TODAY.isoformat(),))
        a.get_db().commit()
    s.check("...once a day: not again after it has gone", due(day.replace(hour=9, minute=30)) == (False, "Already sent today."))
    with a.app.app_context():
        a.get_db().execute("DELETE FROM app_settings WHERE key='leader_progress_last'")
        a.get_db().commit()
    s.check("...and the leader email's own key is separate: that day is still free for it", ctx(lambda d: a.lp_due_now(
        d, at, day.replace(hour=9, minute=30))) == (True, ""))
    with a.app.app_context():
        a.get_db().execute("DELETE FROM app_settings WHERE key='bg_admin_progress_last'")
        a.get_db().commit()

    s.section("the job's turn")
    setwin({"pm_results": (YEST, LATER), "tc_self": (YEST, LATER)})
    now = a._now_myt()
    now = now.replace(minute=now.minute - now.minute % 15, second=0, microsecond=0)

    def save_rules(rules):
        with a.app.app_context():
            d = a.get_db()
            d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('bg_admin_progress_rules', ?)",
                      (a.json.dumps(rules),))
            d.commit()
    save_rules(dict(two, enabled=False, send_time=now.strftime("%H:%M")))
    s.check("off says so, and writes nothing", ctx(lambda d: a.bga_auto(d, a.active_cycle(d))) ==
            "BG admin status emails are off." and SET("bg_admin_progress_last") is None)
    save_rules(dict(two, enabled=True, send_time=now.strftime("%H:%M")))
    said = ctx(lambda d: a.bga_auto(d, a.active_cycle(d)))
    s.check("on and due, no mail set up here: marked for today first, then no email", "isn't set up" in said
            and SET("bg_admin_progress_last") == TODAY.isoformat()
            and H.one(a, "SELECT COUNT(*) FROM email_outbox WHERE id>? AND kind='bg_admin_progress'", (OUT0,)) == 2, said)
    with a.app.app_context():   # the earlier send's two rows stay as the baseline
        a.get_db().execute("DELETE FROM email_outbox WHERE id>? AND kind='bg_admin_progress'", (OUT0,))
        a.get_db().execute("DELETE FROM app_settings WHERE key='bg_admin_progress_last'")
        a.get_db().commit()
    a.mailer.is_configured = lambda: True
    a.mailer.config_status = lambda: {"configured": True}
    a.mailer.send_mail = lambda to, subject, body, **kw: SENT.append((to, subject, body))
    a.OUTBOX_ASYNC = False
    a.mailer.get_token = lambda: "tok"
    said = ctx(lambda d: a.bga_auto(d, a.active_cycle(d)))
    s.check("with mail set up it sends through the mailer, to BGA1's two addresses only", sorted(x[0] for x in SENT) == [
        "zz9bga-1@example.test", "zz9bga-1b@example.test"] and "1 emailed" in said, (said, [x[0] for x in SENT]))
    s.check("...each logged as sent", H.one(a, "SELECT COUNT(*) FROM notifications WHERE id>? AND kind='bg_admin_progress' "
                                              "AND status='sent' AND user_id=?", (NOTE0, ID["BGA1"])) == 2)
    s.check("...the same email as the build makes", all(x[2] == SENT[0][2] and "ZZBGA Group" in x[1] for x in SENT)
            and table in SENT[0][2])
    n_sent = len(SENT)
    s.check("a second run today doesn't send again", ctx(lambda d: a.bga_auto(d, a.active_cycle(d))) == "Already sent today."
            and len(SENT) == n_sent)
    with a.app.app_context():
        a.get_db().execute("DELETE FROM app_settings WHERE key='bg_admin_progress_last'")
        a.get_db().commit()
    setwin({"pm_results": (OPEN_TODAY, LATER), "tc_self": (OPEN_TODAY, LATER)})
    said = ctx(lambda d: a.bga_auto(d, a.active_cycle(d)))
    s.check("every part opened today: nothing goes, and the day is not used up", "nothing goes out today" in said
            and len(SENT) == n_sent and SET("bg_admin_progress_last") is None, said)
    setwin({"pm_results": (YEST, LATER), "tc_self": (YEST, LATER)})
    save_rules(dict(two, enabled=True, send_time=(now + timedelta(hours=-4)).strftime("%H:%M") if now.hour >= 4 else "00:00"))
    # (only checked when the clock leaves room for it: four hours after the time is past the grace)
    if now.hour >= 4:
        s.check("more than the grace hours after the time: it waits for the next day", "More than" in ctx(
            lambda d: a.bga_auto(d, a.active_cycle(d))) and len(SENT) == n_sent)
    src = open(os.path.join(H.REPO, "send_reminders.py"), encoding="utf-8").read()
    s.check("the server's job gives it a turn right after the leaders', wrapped so a failure doesn't stop the run",
            re.search(r"appmod\.lp_auto\(db, cyc\)\)\s*\n(.*\n){0,3}\s*try:\s*\n\s*print\(appmod\.bga_auto\(db, cyc\)\)\s*\n"
                      r"\s*except Exception", src) is not None)
    a.mailer.is_configured, a.mailer.send_mail, a.mailer.config_status, a.OUTBOX_ASYNC = _real[:4]
    a.mailer.get_token = _real[5]

    s.section("the words: a template kind like the others")
    ks = [x["key"] for x in a.EMAIL_TPL_KINDS]
    k = a.EMAIL_TPL_KIND.get("lp_bgadmin")
    s.check("lp_bgadmin is an email kind after lp_hod, with the approved title, name and table line", bool(k)
            and ks.index("lp_bgadmin") == ks.index("lp_hod") + 1 and k["title"] == "Leader progress · BG admins"
            and k["who"] == "BG admins: their group, by business unit" and k["first"] == "BG admin progress"
            and k["page"] == "admin_reminders_leaders" and k["fields"] == a.LP_TPL_FIELDS
            and k["lists"] == "OneHR adds the table: each business unit, the share submitted, how many have and how many not yet.", k)
    T = a.LP_TPL_DEFAULT["bgadmin"]
    s.check("the default words are the approved ones", T == {
        "subject": "{scope}: business units' submission status, {as_at}", "heading": "Your group's submission status",
        "greeting": "Hi {display_name},", "button": "Open the admin portal",
        "opening": "Here is where {scope} stands in the {cycle} check-in, as at {as_at}. The business units furthest behind "
                   "come first. This is the same view your BG CEO gets.",
        "closing": "Who is still to submit is in the admin portal, under each module's progress."}, T)
    s.check("...read like the others: no template yet, the default words", ctx(lambda d: a.email_tpl_words("lp_bgadmin")) == T
            and ctx(lambda d: a.lp_template("bgadmin")) == T and a._email_tpl_default("lp_bgadmin") == T)
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('leader_progress_template', ?)",
                  (a.json.dumps({"bgadmin": {"subject": "ZZBGA older {scope}"}}),))
        d.commit()
    legacy = ctx(lambda d: a._email_tpl_legacy("lp_bgadmin"))
    with a.app.app_context():
        a.get_db().execute("DELETE FROM app_settings WHERE key='leader_progress_template'")
        a.get_db().commit()
    s.check("the older saved words reach it too (key 'bgadmin')", legacy["subject"] == "ZZBGA older {scope}"
            and legacy["heading"] == T["heading"])
    with a.app.test_request_context("/"):
        d = a.get_db()
        me_ = d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        sub_s, body_s = a.email_tpl_sample(d, "lp_bgadmin", T, me_)
    t_s = _html.unescape(body_s)
    s.check("its sample is made-up: Sample unit A and B, no real name, the BG admin's words and portal button",
            "Sample unit A" in t_s and "Sample unit B" in t_s and "Your group's submission status" in t_s
            and "Open the admin portal" in t_s and "ZZ BGA" not in t_s
            and sub_s.startswith("Sample group: business units' submission status, "), sub_s)
    ME = H.client_as(a, SU["id"])
    pgE = ME.get("/admin/emails?email=lp_bgadmin").get_data(as_text=True)
    s.check("Email › Emails and templates lists it under Cycle reviews and opens it", "Leader progress · BG admins" in pgE
            and "BG admin progress" in pgE and pgE.index("Leader progress · HODs") < pgE.index("Leader progress · BG admins")
            < pgE.index("Results to leaders"), None)
    with a.app.app_context():
        a.get_db().execute("DELETE FROM app_settings WHERE key='bg_admin_progress_rules'")
        a.get_db().commit()
    with a.app.test_request_context("/"):
        d = a.get_db()
        s.check("when it goes: off by default, then its rule", "Off" in a.email_tpl_when(d, "lp_bgadmin"))
    save_rules(dict(two, enabled=True, send_time="08:45"))
    s.check("...on: every day at its time, from the day after a part opens", ctx(lambda d: a.email_tpl_when(d, "lp_bgadmin")) ==
            "Every day at 08:45, from the day after a part opens, while it is open")
    pgS = ME.get("/admin/email").get_data(as_text=True)
    s.check("Email › Schedule's top card has its row for it, with its own switch and Set it up on #bga", 'data-eml-row="bga"' in pgS
            and "BG admin status" in pgS and 'href="/admin/reminders/leaders#bga"' in pgS)   # (2026-11-09: one card, a row an email)
    s.check("the settings sheet lists it", "bg_admin_progress" in H.source(a) and '"BG admin status email"' in H.source(a))

    s.section("the page: the card, Save, and the test to the super admin's own notification emails")
    with a.app.app_context():
        a.get_db().execute("DELETE FROM app_settings WHERE key='bg_admin_progress_rules'")
        a.get_db().commit()
    a.bga_admins = _real[4]
    ov = ctx(lambda d: a.bga_overview(d, a.active_cycle(d)))
    pg = ME.get("/admin/reminders/leaders").get_data(as_text=True)
    pg_t = _html.unescape(pg)
    s.check("the super admin's page has the card in the canvas's words, after the leaders' cards", all(x in pg_t for x in (
        "BG admins: daily status", "Each BG admin gets their group by business unit, the same table as the BG CEO's, at the "
        "addresses on their account's notification emails.", "Send it on its own", "Every day at",
        "From the day after a part opens, while it is open.", "What it counts", "Send a test to me"))
        and pg_t.index("BG admins: daily status") > pg_t.index("Preview as"), [x for x in (
            "BG admins: daily status", "Send it on its own", "Every day at", "What it counts", "Send a test to me") if x not in pg_t])
    s.check("...with the counts: N BG admins · N groups and the ones with no notification email", (
        "%d BG admins · %d groups" % (ov["admins"], ov["groups"])) in pg and ("With no notification email: %d" % ov["no_email"]) in pg
        and ov["admins"] >= 3 and ov["no_email"] >= 1, ov)
    card = pg.split('id="bga"')[1].split('id="sent"')[0]
    s.check("...all six parts are ticks in its own form", card.count('name="part"') == 6 and 'id="bga-rules"' in card)
    s.check("...and its Save is double-confirmed (data-confirm)", re.search(r'id="bga-rules"[^>]*\n?[^>]*data-confirm=', pg)
            is not None)
    r = ME.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "bga_save", "enabled": "on",
                                                   "send_time": "08:30", "part": ["pm_results", "tc_self", "f360"]})
    got = ctx(lambda d: a.bga_rules())
    s.check("Save: the super admin's rules are stored", r.status_code == 302 and got == {
        "enabled": True, "send_time": "08:30", "parts": ["pm_results", "tc_self", "f360"]}, got)
    s.check("...written in the audit log in plain words", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='bg_admin_progress_schedule' AND detail LIKE "
        "'on=True, every day at 08:30%'", (LOG0,)) == 1)
    ME.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "bga_save", "send_time": "08:30"})
    s.check("...a save with no part ticked is refused and changes nothing", ctx(lambda d: a.bga_rules()) == got)
    ME.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "bga_save", "send_time": "99:00", "part": ["f360"]})
    s.check("...so is a bad time", ctx(lambda d: a.bga_rules()) == got)
    ME.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "bga_save", "send_time": "08:30",
                                              "part": ["f360"]})
    s.check("...unticking Send it on its own turns it off", ctx(lambda d: a.bga_rules())["enabled"] is False)
    BGAC = H.client_as(a, ID["BGA1"])
    r = BGAC.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "bga_save", "enabled": "on",
                                                     "send_time": "07:00", "part": ["f360"]})
    s.check("a BG admin can't change it: the Email menu is the super admin's", r.status_code == 403
            and ctx(lambda d: a.bga_rules())["send_time"] == "08:30")
    # the test
    SENT.clear()
    a.mailer.send_mail = lambda to, subject, body, **kw: SENT.append((to, subject, body))
    a.mailer.config_status = lambda: {"configured": False}
    ME.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "bga_test"})
    s.check("the test on a server with no mail sends none", SENT == [])
    a.mailer.config_status = lambda: {"configured": True}
    own = ctx(lambda d: a.admin_notify_addresses(d, SU["id"]))
    with a.app.app_context():
        a.get_db().execute("DELETE FROM admin_notify_emails WHERE user_id=?", (SU["id"],))
        a.get_db().commit()
    t_ = ME.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "bga_test"}, follow_redirects=True).get_data(as_text=True)
    s.check("...with no notification email on the super admin's own account it sends none and says why", SENT == []
            and "no notification email on your account" in t_)
    with a.app.app_context():
        a.get_db().execute("INSERT INTO admin_notify_emails(user_id, email) VALUES (?,?)", (SU["id"], "zz9bga-me@example.test"))
        a.get_db().commit()
    t_ = ME.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "bga_test"}, follow_redirects=True).get_data(as_text=True)
    s.check("with one: a made-up sample goes to that address only, [Test] first, no real unit or person", len(SENT) == 1
            and SENT[0][0] == "zz9bga-me@example.test" and SENT[0][1].startswith("[Test] Sample group: business units")
            and "Sample unit A" in SENT[0][2] and "ZZ BGA" not in SENT[0][2] and "Test sent to zz9bga-me@example.test" in t_, [x[:2] for x in SENT])
    s.check("...and logged as a test of this email", H.one(a, "SELECT COUNT(*) FROM notifications WHERE id>? AND "
                                                           "kind='bg_admin_progress' AND to_email='zz9bga-me@example.test'", (NOTE0,)) == 1)
    r = BGAC.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "bga_test"})
    s.check("...a BG admin can't send it", r.status_code == 403 and len(SENT) == 1)
    with a.app.app_context():   # put the super admin's own notification emails back
        d = a.get_db()
        d.execute("DELETE FROM admin_notify_emails WHERE user_id=?", (SU["id"],))
        for e_ in own:
            d.execute("INSERT INTO admin_notify_emails(user_id, email) VALUES (?,?)", (SU["id"], e_))
        d.commit()
finally:
    a.mailer.is_configured, a.mailer.send_mail, a.mailer.config_status, a.OUTBOX_ASYNC, a.bga_admins, a.mailer.get_token = _real
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for w in WIN:
            _db.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w), ",".join("?" * len(w))), list(w.values()))
        _db.execute("UPDATE cycles SET open_by_date=? WHERE id=?", (OBD, CID))
        _db.execute("DELETE FROM email_outbox WHERE id>?", (OUT0,))
        _db.execute("DELETE FROM notifications WHERE id>? AND (kind='bg_admin_progress' OR user_id IN (SELECT id FROM users "
                    "WHERE employee_id LIKE 'ZZ9BGA-%'))", (NOTE0,))
        _db.execute("DELETE FROM activity_log WHERE id>? AND action LIKE 'bg_admin_progress%'", (LOG0,))
        for k_, v in SAVED.items():
            _db.execute("DELETE FROM app_settings WHERE key=?", (k_,))
            if v is not None:
                _db.execute("INSERT INTO app_settings(key,value) VALUES (?,?)", (k_, v[0]))
        _db.commit()
        H.restore_email_templates(_db, TPLS)
        _cleanup(_db)

sys.exit(s.done())
