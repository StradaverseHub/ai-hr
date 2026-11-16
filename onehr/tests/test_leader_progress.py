"""The leader progress email (Chris, 2026-10-19: "For the reminder for the leaders, BUCEO we will show reminder of the
department submission statistics in the reminder, controllable by super admin to decide when and frequency to send,
similarly for BGCEO with the BU submission statistics (how many submitted, how many not yet, percentage)"; canvas
[design canvas link removed], "for BUCEO go with option B, for BGCEO can we have same view with KPI
and Competency side by side in one table").

What this suite holds (a made-up group of synthetic people, put back at the end):
  * the counts, each against an independent per-person read: the KPI check-in by pm_review_locked (an HR fill is never
    the person's sign-off), the competency self-assessment and its review, the Career Plan, 360 ratings by the rater
  * the leaders: a BU CEO with two units gets a section each, a BG CEO their group by unit; rows furthest behind
    first; totals add up; a unit everyone finished is left out (and kept when the rule is off)
  * the email: one table with a column per open part, the place names and percentages, never a person's name; a part
    dated ahead says when it opens; the footer says why they get it
  * the rules and the words: what the form may save, what it refuses; the schedule (weekly, every N days, the
    reminder's days), due now once a day, and the job's turn (off, due, already sent)
  * the send queues one email per leader with something to report, in the outbox, and writes the run
  * the page: the super admin's, a BG admin's (their own leaders only, refused a change), the preview, the tabs
  * HODs (Chris, 2026-10-30): a section a department they head, a row a line manager's team (the official name, never
    the display name), finished teams in one line, the ten furthest behind as rows and the rest as one "N more teams"
    row, the total over everything; and one email a person, from the highest role ticked (BG CEO, BU CEO, Calibrator,
    HOD)
  * the overlap note (Chris, 2026-10-30, canvas board 8): a grey box under the opening of an HOD's email while their
    Department Review and a line managers' part are both open (not when every team has the line managers' parts
    complete), and of a BU CEO's or Calibrator's while their calibration and the HODs' Department Review are both open
    and some department in their email has an HOD who isn't them; its date, its words (editable, old templates keep
    working, plural for several units) and that the preview, the test and the send carry the same one
"""
import html as _html
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The leader progress email: BU CEOs by department, BG CEOs by business unit")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
assert not a.mailer.is_configured(), "the harness must not send email"
SU, _BGA, _E = H.actors(a)
BG, U1, U2 = "ZZLP Group", "ZZLP Alpha", "ZZLP Beta"
BG2, U3, U4 = "ZZLP Group Two", "ZZLP Gamma", "ZZLP Delta"   # the HOD and role-rank people: a group of their own
KEYS = ("leader_progress_rules", "leader_progress_template", "leader_progress_last")


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LP-%'")]
    db.execute("DELETE FROM calib_bu_groups WHERE business_group IN (?,?)", (BG, BG2))
    if ul:
        ph = ",".join("?" * len(ul))
        for sql in ("DELETE FROM email_outbox WHERE user_id IN (%s)", "DELETE FROM notifications WHERE user_id IN (%s)",
                    "DELETE FROM buceo_seats WHERE user_id IN (%s)", "DELETE FROM admin_companies WHERE admin_id IN (%s)",
                    "DELETE FROM activity_log WHERE user_id IN (%s)", "DELETE FROM users WHERE id IN (%s)"):
            db.execute(sql % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM tc_skills WHERE skill_code='ZZ9LP-SKILL'")
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CYC = db.execute("SELECT * FROM cycles WHERE is_active=1").fetchone()
    CID = CYC["id"]
    SAVED = {k: db.execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone() for k in KEYS}
    TPLS = H.stash_email_templates(db)
    WIN = [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows WHERE cycle_id=? "
                                        "AND cell='tc_self'", (CID,))]
    NOTE_CELLS = ("pm_approve", "tc_approve", "pm_hod", "pot_hod", "pm_buceo", "pot_buceo")   # the overlap note's windows
    WIN2 = [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows WHERE cycle_id=? "
                                         "AND cell IN (%s)" % ",".join("?" * len(NOTE_CELLS)), (CID,) + NOTE_CELLS)]
    MODS = [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=? AND "
                                         "module_key IN ('pm','tm','calibration')", (CID,))]
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    OUT0 = db.execute("SELECT COALESCE(MAX(id),0) FROM email_outbox").fetchone()[0]
    SKILL = (db.execute("SELECT id FROM tc_skills ORDER BY id LIMIT 1").fetchone() or [None])[0]
    if SKILL is None:   # the synthetic fixture (a checkout with no real database) has no skills: make one, taken out below
        SKILL = db.execute("INSERT INTO tc_skills(skill_code, title) VALUES ('ZZ9LP-SKILL', 'ZZ9LP skill')").lastrowid
    for bg_, co in ((BG, U1), (BG, U2), (BG2, U3), (BG2, U4)):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (bg_, co))
    ID = {}

    def person(key, co, dept, part=True, grade=14):
        ID[key] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_grade, years_of_service, email) VALUES (?,?,'x','user',?,?,?,?,?,?,?)",
            ("zz9lp-" + key.lower(), "ZZ LP Person " + key, "ZZ9LP-" + key, BG, co, dept, grade, 3 if part else 0,
             "zz9lp-%s@example.test" % key.lower())).lastrowid
    for k, co, dept in (("A1", U1, "Sales"), ("A2", U1, "Sales"), ("A3", U1, "Sales"), ("A4", U1, "Production"),
                        ("A5", U1, "Production"), ("B1", U2, "Finance"), ("B2", U2, "Finance")):
        person(k, co, dept)
    person("L1", U1, "Leadership", part=False, grade=21)   # the BU CEO of both units, not taking part themselves
    person("L2", U2, "Leadership", part=False, grade=23)   # the BG CEO
    db.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (BG, ID["L2"]))
    for co in (U1, U2):
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, co, ID["L1"]))

    def kpi(key, result=None, admin=0):
        t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, "
                       "status) VALUES (?,?,?,100,'more',?,'approved')", (CID, ID[key], "ZZLP KPI " + key, BG)).lastrowid
        if result is not None:
            db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, draft, admin_filled) VALUES (?,10,?,?)",
                       (t, result, admin))
    kpi("A1", 0)
    db.execute("INSERT INTO pm_review_session(subject_id, cycle_id, locked_at) VALUES (?,?,datetime('now'))",
               (ID["A1"], CID))                             # signed off
    kpi("A2", 1)                                            # a draft
    kpi("A3", 0, admin=1)                                   # only HR's fill: never their sign-off
    kpi("A4", 0)                                            # every own row submitted (the older way)
    for k in ("B1", "B2"):
        kpi(k, 0)
        db.execute("INSERT INTO pm_review_session(subject_id, cycle_id, locked_at) VALUES (?,?,datetime('now'))",
                   (ID[k], CID))
    for k, sub, rev in (("A1", 1, 1), ("A2", 0, 0), ("A4", 1, 0), ("B1", 1, 1), ("B2", 1, 1)):
        db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) VALUES (?,?,?)", (CID, ID[k], SKILL))
        db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status, submitted_at, reviewed_at) VALUES "
                   "(?,?,?,?,?)", (CID, ID[k], "reviewed" if rev else "submitted" if sub else "pending",
                                   "2026-10-01 00:00" if sub else None, "2026-10-02 00:00" if rev else None))
    YEAR = a.pm_idp_plan_year(CYC)
    db.execute("INSERT INTO pm_idp(plan_year, subject_id, status) VALUES (?,?,'shared')", (YEAR, ID["A1"]))
    db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) VALUES "
               "(?,?,?,'peer','submitted')", (CID, ID["B1"], ID["A2"]))
    db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) VALUES "
               "(?,?,?,'peer','pending')", (CID, ID["B2"], ID["A2"]))
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                     "admin_bg) VALUES ('zz9lp-bga','ZZ LP Groupadmin','x','admin','ZZ9LP-BGA',?,?)", (BG, BG)).lastrowid
    # ---- the HODs (2026-10-30): a made-up group of their own, so the figures above stay as they were.
    # HD1 heads ZZLP Ops: 14 line managers with two people each (teams 1-3 finished both parts, teams 4-14 not) and two
    # people with no line manager. HD2 heads ZZLP Legal (one team, finished) and ZZLP Tax (two teams, one finished).
    # X1 is a BG CEO and a BU CEO; X2 a BU CEO who also calibrates; X3 a calibrator who has people as their HOD.
    # The line managers' names are HRIS capitals with a different display name: the email cases the official one.
    SEED = {}   # person key -> (kpi done, competency done), for the independent read

    def hp(key, bg, co, dept, hod=None, mgr=None, kpi_done=None, tc_done=None, name=None, display=None, part=True,
           grade=14, **extra):
        ID[key] = db.execute(
            "INSERT INTO users (username, full_name, display_name, password_hash, role, employee_id, business_group, "
            "company, department, job_grade, years_of_service, email, hod_id, manager_id) VALUES "
            "(?,?,?,'x','user',?,?,?,?,?,?,?,?,?)",
            ("zz9lp-" + key.lower(), name or "ZZ LP Person " + key, display, "ZZ9LP-" + key, bg, co, dept, grade,
             3 if part else 0, "zz9lp-%s@example.test" % key.lower(), ID.get(hod) if hod else None,
             ID.get(mgr) if mgr else None)).lastrowid
        if kpi_done is not None:
            t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
                           "business_group, status) VALUES (?,?,?,100,'more',?,'approved')",
                           (CID, ID[key], "ZZLP KPI " + key, bg)).lastrowid
            db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, draft, admin_filled) VALUES (?,10,?,0)",
                       (t, 0 if kpi_done else 1))
        if tc_done is not None:
            db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) VALUES (?,?,?)", (CID, ID[key], SKILL))
            db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status, submitted_at) VALUES (?,?,?,?)",
                       (CID, ID[key], "submitted" if tc_done else "pending", "2026-10-01 00:00" if tc_done else None))
        SEED[key] = (kpi_done, tc_done)
    hp("HD1", BG2, U3, "ZZLP Heads", part=False, grade=21, name="ZZ LP Head One", display="ZZ Chief One")
    hp("HD2", BG2, U3, "ZZLP Heads", part=False, grade=21, name="ZZ LP Head Two")
    TEAMS = {}   # n -> (kpi people done, competency people done) of the two people in team n
    for n in range(1, 15):
        hp("LM%02d" % n, BG2, U3, "ZZLP Ops", part=False, grade=18, name="ZZLP MANAGER %02d" % n,
           display="ZZ Nick %02d" % n)
        TEAMS[n] = (2, 2) if n <= 3 else (n % 3, n % 2)
        for who, i in (("a", 0), ("b", 1)):
            hp("P%02d%s" % (n, who), BG2, U3, "ZZLP Ops", hod="HD1", mgr="LM%02d" % n,
               kpi_done=1 if i < TEAMS[n][0] else 0, tc_done=1 if i < TEAMS[n][1] else 0)
    for who in ("a", "b"):   # no line manager on file: nothing submitted
        hp("Q01" + who, BG2, U3, "ZZLP Ops", hod="HD1", kpi_done=0, tc_done=0)
    hp("LMR", BG2, U3, "ZZLP Legal", part=False, grade=18, name="ZZLP MANAGER LEGAL")
    hp("LMT1", BG2, U3, "ZZLP Tax", part=False, grade=18, name="ZZLP MANAGER TAXONE")
    hp("LMT2", BG2, U3, "ZZLP Tax", part=False, grade=18, name="ZZLP MANAGER TAXTWO")
    for who in ("a", "b"):
        hp("R1" + who, BG2, U3, "ZZLP Legal", hod="HD2", mgr="LMR", kpi_done=1, tc_done=1)
        hp("T1" + who, BG2, U3, "ZZLP Tax", hod="HD2", mgr="LMT1", kpi_done=0, tc_done=0)
        hp("T2" + who, BG2, U3, "ZZLP Tax", hod="HD2", mgr="LMT2", kpi_done=1, tc_done=1)
    hp("X1", BG2, U3, "ZZLP Heads", part=False, grade=23)         # BG CEO and BU CEO
    db.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (BG2, ID["X1"]))
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG2, U3, ID["X1"]))
    hp("X2", BG2, U4, "ZZLP Heads", part=False, grade=22)         # BU CEO who also calibrates
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG2, U4, ID["X2"]))
    G_X2 = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)",
                      (BG2, U4, "ZZLP X2 group", ID["X2"])).lastrowid
    for who in ("a", "b"):   # a unit whose only department is headed by its own BU CEO (the overlap note's guard)
        hp("Y1" + who, BG2, U4, "ZZLP Yard", hod="X2", kpi_done=0, tc_done=0)
    hp("X3", BG2, U3, "ZZLP Heads", part=False, grade=22)         # a calibrator who also has people as their HOD
    G_X3 = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)",
                      (BG2, U3, "ZZLP X3 group", ID["X3"])).lastrowid
    for who in ("a", "b"):
        hp("S1" + who, BG2, U3, "ZZLP Sales", hod="X3", kpi_done=0, tc_done=0)
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='tc_self'", (CID,))
    db.commit()


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


ALL = list(a.LP_PART)
mine = lambda d: {k: v for k, v in d.items() if k[0] == BG}   # noqa: E731

try:
    s.section("the counts, against a per-person read")
    c = ctx(lambda d: a.lp_counts(d, a.active_cycle(d), ALL))

    def truth_pm(d):
        out = {}
        for k in ("A1", "A2", "A3", "A4", "B1", "B2"):
            u = d.execute("SELECT company, department FROM users WHERE id=?", (ID[k],)).fetchone()
            a_ = out.setdefault((BG, u[0], u[1]), [0, 0])
            a_[0] += 1
            a_[1] += 1 if a.pm_review_locked(d, ID[k], CID) else 0
        return out
    s.check("KPI check-in: people with a KPI line, done by pm_review_locked", mine(c["pm_results"]) == ctx(truth_pm),
            (mine(c["pm_results"]), ctx(truth_pm)))
    s.check("...so HR's fill alone isn't a sign-off (Sales: 1 of 3), and the older all-submitted way is",
            c["pm_results"][(BG, U1, "Sales")] == [3, 1] and c["pm_results"][(BG, U1, "Production")] == [1, 1])
    s.check("...someone with no KPI line isn't counted (Production holds two people, one counted)",
            c["_people"][(BG, U1, "Production")] == 2)
    tc = ctx(lambda d: {(BG, r[0], r[1]): [r[2], r[3]] for r in d.execute(
        "SELECT u.company, u.department, COUNT(*), SUM(s.submitted_at IS NOT NULL) FROM users u JOIN tc_assessments s "
        "ON s.subject_id=u.id AND s.cycle_id=? WHERE u.employee_id LIKE 'ZZ9LP-%' AND u.business_group=? GROUP BY 1, 2",
        (CID, BG))})
    s.check("competency: people assigned, done = submitted", mine(c["tc_self"]) == tc, (mine(c["tc_self"]), tc))
    s.check("competency review: those submitted, done = reviewed", mine(c["tc_approve"]) == {
        (BG, U1, "Sales"): [1, 1], (BG, U1, "Production"): [1, 0], (BG, U2, "Finance"): [2, 2]}, mine(c["tc_approve"]))
    fin = ctx(lambda d: a.pm_final_overalls(d, CID, [ID[k] for k in ("A1", "A4", "B1", "B2")]))
    s.check("KPI moderation: those submitted, done by pm_final_overalls", sum(v[0] for v in mine(c["pm_approve"])
                                                                              .values()) == 4
            and sum(v[1] for v in mine(c["pm_approve"]).values()) == sum(1 for v in fin.values() if v))
    # Chris 2026-11-06: the Career Plan's COUNT covers only people in the review (idp_count_sql). The two leaders not confirmed yet
    # still write a plan (2026-10-19) but are no longer counted, so the Leadership places drop out of the column.
    s.check("Career Plan: people in the review with a plan, done = shared (the unconfirmed leaders keep a plan, uncounted)", mine(c["idp_self"]) == {
        (BG, U1, "Sales"): [3, 1], (BG, U1, "Production"): [2, 0], (BG, U2, "Finance"): [2, 0]}, mine(c["idp_self"]))
    s.check("360: ratings owed, by the rater's place", mine(c["f360"]) == {(BG, U1, "Sales"): [2, 1]}, mine(c["f360"]))
    s.check("leaders not taking part aren't counted", (BG, U1, "Leadership") not in c["_people"])

    s.section("the leaders and their tables")
    leaders = ctx(lambda d: [x for x in a.lp_leaders(d, ["buceo", "bgceo"]) if x[1]["id"] in (ID["L1"], ID["L2"])])
    s.check("the BU CEO once, with both units; the BG CEO with the group (grouped by role, BG CEOs first)",
            [(r, u["id"], sc) for r, u, sc in leaders] == [("bgceo", ID["L2"], [(BG, None)]),
                                                           ("buceo", ID["L1"], [(BG, U1), (BG, U2)])])
    two = [(a.LP_PART["pm_results"], None), (a.LP_PART["tc_self"], None)]
    secs, left = ctx(lambda d: a.lp_sections("buceo", [(BG, U1), (BG, U2)], c, two, skip_done=True))
    s.check("a unit everyone finished is left out", left == 1 and [x["name"] for x in secs] == [U1], (left, secs))
    rows = secs[0]["rows"]
    s.check("...rows furthest behind first, each cell its share, floored",
            [r["name"] for r in rows] == ["Sales", "Production"] and rows[0]["cells"][0]["pct"] == 33
            and rows[0]["cells"][1]["pct"] == 50 and rows[1]["cells"][0]["pct"] == 100, rows)
    s.check("...the total adds the rows up", [(t["done"], t["n"]) for t in secs[0]["total"]] ==
            [(sum(r["cells"][i]["done"] for r in rows), sum(r["cells"][i]["n"] for r in rows)) for i in (0, 1)])
    s.check("...and each row says how many take part there", [r["people"] for r in rows] == [3, 2])
    secs2, left2 = ctx(lambda d: a.lp_sections("buceo", [(BG, U1), (BG, U2)], c, two, skip_done=False))
    s.check("with the rule off, the finished unit stays", left2 == 0 and len(secs2) == 2)
    bsecs, _l = ctx(lambda d: a.lp_sections("bgceo", [(BG, None)], c, two))
    s.check("the BG CEO's rows are the business units", [r["name"] for r in bsecs[0]["rows"]] == [U1, U2]
            and bsecs[0]["rows"][1]["cells"][0]["pct"] == 100)

    s.section("the email")
    with a.app.test_request_context("/"):
        d = a.get_db()
        L1 = d.execute("SELECT * FROM users WHERE id=?", (ID["L1"],)).fetchone()
        subj, body = a.lp_mail(d, "buceo", L1, secs2, two, [], a.active_cycle(d), rules=dict(a.lp_rules(), enabled=True))
        ahead = [(a.LP_PART["idp_self"], a._parse_when("2026-12-01 09:00"))]
        _s1, body1 = a.lp_mail(d, "buceo", L1, secs, two, ahead, a.active_cycle(d))
    s.check("the subject names the units", subj.startswith(U1 + " and " + U2 + ":"), subj)
    s.check("one table a unit, a column per part, the place names and shares", body.count("All departments") == 2
            and "KPI check-in" in body and "Competency" in body and ">33%<" in body and "Sales" in body)
    s.check("never the name of anyone counted (only the leader's own, in the greeting)",
            not re.search(r"ZZ LP Person [AB]", body + body1) and "Hi ZZ LP Person L1," in body)
    s.check("two units: the heading says units'", "Your units&#x27; progress" in body or "Your units' progress" in body)
    s.check("a part dated ahead says when it opens", "Career Plan</b> opens Tue 1 Dec" in body1)
    with a.app.test_request_context("/"):
        d = a.get_db()
        big = [{"name": "Department %d" % i, "people": 30, "cells": [a._lp_cell(30, i % 30) for _ in range(3)]}
               for i in range(40)]
        three = [(a.LP_PART[k], None) for k in a.LP_OWN_PARTS]
        _sb, bbody = a.lp_mail(d, "buceo", L1, [{"name": U1, "rows": big, "people": 1200,
                                                  "total": [a._lp_cell(1200, 500)] * 3}], three, [], a.active_cycle(d))
    s.check("a big unit (40 departments, three parts) stays under Gmail's 102 KB clip (%d KB)" % (len(bbody) // 1024),
            len(bbody) < 95 * 1024)
    s.check("the footer says why they get it, and when it goes out", "the BU CEO of %s and %s" % (U1, U2) in body
            and "every week, on Monday" in body)

    s.section("the rules and the words")
    from werkzeug.datastructures import MultiDict
    ok = {"enabled": "on", "freq": "every", "every_days": "3", "send_time": "10:30", "role": ["buceo"],
          "part": ["pm_results", "f360"], "skip_done": "on"}
    r, errs = ctx(lambda d: a.lp_rules_from(MultiDict(ok)))
    s.check("a good form saves what it says", not errs and r["freq"] == "every" and r["every_days"] == 3
            and r["roles"] == ["buceo"] and r["parts"] == ["pm_results", "f360"] and r["send_time"] == "10:30")
    r2, errs2 = ctx(lambda d: a.lp_rules_from(MultiDict(dict(ok, role=["hod", "buceo"]))))
    s.check("...HODs can be ticked, kept in rank order", not errs2 and r2["roles"] == ["buceo", "hod"], r2["roles"])
    s.check("...HODs are in the default rules", "hod" in a.LP_DEFAULT_RULES["roles"])
    for bad, why in ((dict(ok, role=[]), "Tick who gets it"), (dict(ok, part=[]), "at least one thing"),
                     (dict(ok, every_days="0"), "Every 1 to"), (dict(ok, send_time="25:00"), "HH:MM"),
                     (dict(ok, freq="hourly"), "how often")):
        _r, e = ctx(lambda d: a.lp_rules_from(MultiDict(bad)))
        s.check("...refuses: %s" % why, any(why in x for x in e), e)
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('leader_progress_rules', ?)",
                  ('{"enabled": "yes", "freq": "hourly", "weekday": 9, "send_time": "99:99", "parts": ["nonsense"]}',))
        d.commit()
        junk = a.lp_rules()
    s.check("a hand-edited setting can't break it: each value checked", junk["enabled"] is False
            and junk["freq"] == "weekly" and junk["weekday"] == 0 and junk["send_time"] == "09:00"
            and junk["parts"] == [])
    t, e = ctx(lambda d: a.lp_template_from(MultiDict({"subject": "{scope} {nope}"}), "buceo"))
    s.check("the words: a placeholder OneHR doesn't fill is refused", any("{nope}" in x for x in e))
    t, e = ctx(lambda d: a.lp_template_from(MultiDict({"heading": ""}), "bgceo"))
    s.check("...a required one sent empty is refused", any("Heading" in x for x in e))
    t, e = ctx(lambda d: a.lp_template_from(MultiDict({"closing": "x" * 301}), "bgceo"))
    s.check("...over its ceiling is refused, not trimmed", any("under 300" in x for x in e))
    t, e = ctx(lambda d: a.lp_template_from(MultiDict({"button": "See it"}), "bgceo"))
    s.check("...and a field not sent stays as it is", not e and t["button"] == "See it"
            and t["heading"] == a.LP_TPL_DEFAULT["bgceo"]["heading"])

    s.section("when it goes out")
    with a.app.test_request_context("/"):
        d = a.get_db()
        cy = a.active_cycle(d)
        today = a._today_myt()
        wk = dict(a.lp_rules(), enabled=True, freq="weekly", weekday=today.weekday(), roles=["buceo"])
        s.check("weekly: its own day only", a.lp_send_day(d, cy, today, wk)
                and not a.lp_send_day(d, cy, today + timedelta(days=1), wk))
        ev = dict(wk, freq="every", every_days=3, since=today.isoformat())
        s.check("every 3 days from the day it's saved", a.lp_send_day(d, cy, today, ev)
                and a.lp_send_day(d, cy, today + timedelta(days=3), ev)
                and not a.lp_send_day(d, cy, today + timedelta(days=2), ev))
        # the send time is a quarter hour (the timer's runs, 2026-10-21): the last one at or before now
        now = a._now_myt()
        now = now.replace(minute=now.minute - now.minute % 15, second=0, microsecond=0)
        at = dict(wk, send_time=now.strftime("%H:%M"))
        d.execute("DELETE FROM app_settings WHERE key='leader_progress_last'")
        d.commit()
        s.check("due at its time", a.lp_due_now(d, at, now)[0])
        # one minute before today's send time (the old check used just before midnight, which in the evening sits
        # inside the grace hours of yesterday's send and read as due: a test that failed after about 21:00 MYT)
        s.check("...not before it", not a.lp_due_now(d, at, now - timedelta(minutes=1))[0])
        s.check("...not more than the grace hours after", not a.lp_due_now(d, at, now + timedelta(hours=4))[0])
        s.check("off: no next send", a.lp_next_send(d, cy, dict(wk, enabled=False)) is None)
        nxt = a.lp_next_send(d, cy, dict(wk, weekday=(today.weekday() + 2) % 7))
        # a send day with a part counted (lp_sends_on): the first one by the rules read here, from the real windows
        _wk2 = dict(wk, weekday=(today.weekday() + 2) % 7)
        _want = next((today + timedelta(days=i) for i in range(62) if a.lp_sends_on(d, cy, _wk2, today + timedelta(days=i), today)), None)
        s.check("...on: the next send day (one a part is counted on)", (nxt.date() if nxt else None) == _want, (nxt, _want))
        _real_c = a.lp_counted_on
        a.lp_counted_on = lambda *x, **k: [a.LP_PARTS[0]]
        try:
            nxt2 = a.lp_next_send(d, cy, _wk2)
        finally:
            a.lp_counted_on = _real_c
        s.check("...with a part counted every day it is the weekday two days on", nxt2 and nxt2.date() == today + timedelta(days=2), nxt2)
        d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('leader_progress_rules', ?)",
                  (a.json.dumps(at),))
        d.commit()
        a.lp_counted_on = lambda *x, **k: [a.LP_PARTS[0]]   # a part counted today (the job's turn now stops on a day with none)
        try:
            said = a.lp_auto(d, cy)
            s.check("the job's turn: due, marked sent for today first, then no email here",
                    "isn't set up" in said and a._setting("leader_progress_last") == today.isoformat(), said)
            s.check("...and a second run today doesn't send again", a.lp_auto(d, cy) == "Already sent today.")
        finally:
            a.lp_counted_on = _real_c
        d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('leader_progress_rules', ?)",
                  (a.json.dumps(dict(at, enabled=False)),))
        d.commit()
        s.check("...off says so", a.lp_auto(d, cy) == "Leader progress emails are off.")
    src = open(os.path.join(H.REPO, "send_reminders.py"), encoding="utf-8").read()
    s.check("the server's reminder job gives it its turn, sending before it exits",
            "appmod.lp_auto(db, cyc)" in src and "appmod.OUTBOX_ASYNC = False" in src)

    s.section("the send")
    real = a.lp_leaders
    a.lp_leaders = lambda d, roles: [x for x in real(d, roles) if x[1]["id"] in (ID["L1"], ID["L2"])]
    try:
        with a.app.test_request_context("/"):
            d = a.get_db()
            d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('leader_progress_rules', ?)",
                      (a.json.dumps(dict(a.LP_DEFAULT_RULES, parts=["pm_results", "tc_self"])),))
            d.commit()
            t = a.lp_send(d, a.active_cycle(d), "test run", actor_id=SU["id"])
            q = d.execute("SELECT to_email, kind, subject FROM email_outbox WHERE id>? ORDER BY id", (OUT0,)).fetchall()
    finally:
        a.lp_leaders = real
    s.check("one email queued per leader with something to report", t["leaders"] == 2 and t["emailed"] == 2
            and sorted(r[0] for r in q) == ["zz9lp-l1@example.test", "zz9lp-l2@example.test"], (t, [tuple(r) for r in q]))
    s.check("...in the outbox, as a leader progress email", all(r[1] == "leader_progress" for r in q))
    s.check("...and the run is written for the Sent list", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='leader_progress_run' AND detail LIKE 'test run%'",
        (LOG0,)) == 1)


    s.section("HODs: a section a department, a row a line manager's team")
    two = [(a.LP_PART["pm_results"], None), (a.LP_PART["tc_self"], None)]
    team_label = lambda n: a._em_case("ZZLP MANAGER %02d" % n) + "'s team"   # noqa: E731
    s.check("LP_ROLES: the four roles in rank order, the words approved", a.LP_ROLES == (
        ("bgceo", "BG CEOs", "Their group, by business unit."),
        ("buceo", "BU CEOs", "Their unit, by department. Each of their units gets its own section."),
        ("cg", "Calibrators", "Their Calibration Group, by department."),
        ("hod", "HODs", "Their department, by line manager's team. Each department they head gets its own section.")))
    s.check("_lp_who takes an HOD", a._lp_who("hod:%d" % ID["HD1"]) == ("hod", ID["HD1"]) and a._lp_who("nope:1") is None)

    def hod_secs(hid, skip_done=True, parts=two):
        def f(d):
            cc = a.lp_counts(d, a.active_cycle(d), [p[0] for p, _c in parts])
            lead = [x for x in a.lp_leaders(d, ["hod"]) if x[1]["id"] == hid]
            if not lead:
                return None
            cc["_hodteams"], cc["_mgr"] = a.lp_hod_teams(d, cc, [hid])
            return a.lp_sections("hod", lead[0][2], cc, parts, skip_done)
        return ctx(f)
    lead1 = ctx(lambda d: [x for x in a.lp_leaders(d, ["hod"]) if x[1]["id"] == ID["HD1"]])
    s.check("an HOD is an entry, with a scope a department they head (their people's place)",
            len(lead1) == 1 and lead1[0][0] == "hod" and lead1[0][2] == [(BG2, U3, None, "ZZLP Ops", ID["HD1"])], lead1)
    secs1, left1 = hod_secs(ID["HD1"])
    sec1 = secs1[0]
    # the independent read: every open team's two shares, from what was seeded
    open_t = {n: (TEAMS[n][0] * 100 // 2, TEAMS[n][1] * 100 // 2) for n in range(4, 15)}
    want = sorted([(v[0], v[1], team_label(n).lower(), team_label(n)) for n, v in open_t.items()] +
                  [(0, 0, "no line manager on file", "No line manager on file")])
    s.check("one section for the one department, named by it", len(secs1) == 1 and left1 == 0
            and sec1["name"] == "ZZLP Ops" and sec1.get("hod"), [x["name"] for x in secs1])
    rows1 = sec1["rows"]
    s.check("12 teams have something left: the 10 furthest behind are rows, then ONE more row (LP_HOD_ROWS = 10)",
            a.LP_HOD_ROWS == 10 and len(rows1) == 11 and rows1[-1].get("more") and not any(r.get("more") for r in rows1[:-1]),
            [r["name"] for r in rows1])
    s.check("...in the order furthest behind first, by the first part then the next (no line manager: 0 / 0 leads)",
            [r["name"] for r in rows1[:-1]] == [w[3] for w in want[:10]] and rows1[0]["name"] == "No line manager on file",
            ([r["name"] for r in rows1[:-1]], [w[3] for w in want[:10]]))
    s.check("...each row's share is its team's own (the seeded figure)", all(
        r["cells"][0]["pct"] == w[0] and r["cells"][1]["pct"] == w[1] and r["people"] == 2
        for r, w in zip(rows1[:-1], want[:10])))
    rest = want[10:]
    more = rows1[-1]
    s.check("...the summary row says how many teams: 'N more teams', its figures the SUM of those teams, people too",
            more["name"] == "%d more teams" % len(rest) == "2 more teams"
            and more["cells"][0]["n"] == 2 * len(rest) and more["people"] == 2 * len(rest)
            and more["cells"][0]["done"] == sum(TEAMS[n][0] for n in range(4, 15) if team_label(n) in
                                                [w[3] for w in rest])
            and more["cells"][1]["done"] == sum(TEAMS[n][1] for n in range(4, 15) if team_label(n) in
                                                [w[3] for w in rest]), more)
    s.check("the teams that finished every part (1 to 3) are not rows: they are listed, by their line manager's name",
            not any(team_label(n) in [r["name"] for r in rows1] for n in (1, 2, 3))
            and sec1["finished"] == [a._em_case("ZZLP MANAGER %02d" % n) for n in (1, 2, 3)], sec1["finished"])
    # the total is everything: finished teams, the ten rows and the summary
    all_ops = [k for k in SEED if (k.startswith("P") and k[1:3].isdigit()) or k.startswith("Q01")]
    s.check("the total row counts EVERY team, finished ones too (30 people, the seeded done counts)",
            sec1["total"][0]["n"] == len(all_ops) == 30 and sec1["people"] == 30
            and sec1["total"][0]["done"] == sum(SEED[k][0] for k in all_ops)
            and sec1["total"][1]["done"] == sum(SEED[k][1] for k in all_ops), sec1["total"])
    fin_n = 2 * len(sec1["finished"])
    s.check("...so rows + the summary + the finished teams add up to the total",
            sum(r["cells"][0]["n"] for r in rows1) + fin_n == sec1["total"][0]["n"]
            and sum(r["cells"][0]["done"] for r in rows1) + fin_n == sec1["total"][0]["done"])
    # falsify the cap: lower it and the summary row changes
    real_rows = a.LP_HOD_ROWS
    a.LP_HOD_ROWS = 12
    try:
        s12, _l = hod_secs(ID["HD1"])
    finally:
        a.LP_HOD_ROWS = real_rows
    s.check("falsified: with the cap at 12 every open team is a row and there is no summary row",
            len(s12[0]["rows"]) == 12 and not any(r.get("more") for r in s12[0]["rows"]))

    s.section("...a department with few teams, and the guards")
    secs2, left2 = hod_secs(ID["HD2"])
    s.check("a department where every team finished is left out (skip_done), the other kept",
            left2 == 1 and [x["name"] for x in secs2] == ["ZZLP Tax"], (left2, [x["name"] for x in secs2]))
    tax = secs2[0]
    s.check("...Tax: one team left is a row, the finished team is listed; no summary row with so few",
            [r["name"] for r in tax["rows"]] == [a._em_case("ZZLP MANAGER TAXONE") + "'s team"]
            and tax["finished"] == [a._em_case("ZZLP MANAGER TAXTWO")] and not any(r.get("more") for r in tax["rows"]))
    s.check("...the total still counts the finished team (4 people, 2 done)",
            tax["total"][0]["n"] == 4 and tax["total"][0]["done"] == 2 and tax["people"] == 4, tax["total"])
    secs2f, left2f = hod_secs(ID["HD2"], skip_done=False)
    s.check("with the rule off the finished department stays, its rows empty and its team in the line",
            left2f == 0 and [x["name"] for x in secs2f] == ["ZZLP Legal", "ZZLP Tax"]
            and secs2f[0]["rows"] == [] and len(secs2f[0]["finished"]) == 1)
    s.check("a team with no line manager on file is its own team, never lumped with a named one",
            "No line manager on file" in [r["name"] for r in rows1])

    s.section("...the email")
    with a.app.test_request_context("/"):
        d = a.get_db()
        cyc_ = a.active_cycle(d)
        hd1 = d.execute("SELECT * FROM users WHERE id=?", (ID["HD1"],)).fetchone()
        hd2 = d.execute("SELECT * FROM users WHERE id=?", (ID["HD2"],)).fetchone()
        rules_on = dict(a.lp_rules(), enabled=True)
        subj1, body1h = a.lp_mail(d, "hod", hd1, secs1, two, [], cyc_, rules=rules_on)
        subj2, body2h = a.lp_mail(d, "hod", hd2, secs2f, two, [], cyc_, rules=rules_on)
        subj3, body3h = a.lp_mail(d, "hod", hd2, secs2, two, [], cyc_, rules=rules_on)
    t1, t2, t3 = _html.unescape(body1h), _html.unescape(body2h), _html.unescape(body3h)
    T = a.LP_TPL_DEFAULT["hod"]
    s.check("the words are the approved ones", T["subject"] == "{scope}: where your teams stand in the {cycle} check-in"
            and T["heading"] == "Your department's progress" and T["greeting"] == "Hi {display_name},"
            and T["button"] == "Open AI+ OneHR"
            and T["closing"] == "Open AI+ OneHR to see who is still to submit in your department."
            and T["opening"] == "Here is where {scope} stands in the {cycle} check-in, as at {as_at}. The teams "
                                "furthest behind come first. A word from you to their line managers now keeps your "
                                "Department Review on time.", T)
    s.check("the subject names the department; one department: the singular heading; the footer says they head it",
            subj1.startswith("ZZLP Ops: where your teams stand in the ") and "Your department's progress" in t1
            and "You get this because you head ZZLP Ops. It goes out every week" in t1, (subj1, re.findall(r"You get this[^<]*", t1)))
    s.check("the table's first column is the line manager's team; the total row says Whole department",
            "Line manager's team" in t1 and "Whole department" in t1 and "All departments" not in t1)
    s.check("rows are labelled by the line manager's OFFICIAL name, cased as the other emails case it (never the display "
            "name)", team_label(6) in t1 and "ZZ Nick" not in t1 and "ZZLP MANAGER" not in t1)
    s.check("...ten rows: the 'No line manager on file' team and nine line managers' teams",
            "No line manager on file" in t1 and len(re.findall(r"Zzlp Manager \d\d's team", t1)) == 9, re.findall(r"Zzlp Manager \d\d's team", t1))
    s.check("the finished teams go in one line under the table",
            "3 teams have finished every part: Zzlp Manager 01's, Zzlp Manager 02's and Zzlp Manager 03's." in t1)
    s.check("the summary row: '2 more teams', plain (no bars) on the soft shade", "2 more teams" in t1)
    rws = body1h.split('<tr><td valign="top"')   # a table row (the bars hold rows of their own)
    seg = [x for x in rws if "2 more teams" in x][0]
    row5 = [x for x in rws if "No line manager on file" in x][0]
    s.check("...its cells carry no bar and the shade #f7f8fb; a team's row has its bars and no shade",
            "oh-track" not in seg and "#f7f8fb" in seg and "oh-track" in row5 and "#f7f8fb" not in row5)
    s.check("...with the number taking part", "4 taking part" in _html.unescape(seg))
    s.check("counts only: no staff member's name anywhere (only line managers', as labels, and the HOD's in the greeting)",
            not re.search(r"ZZ LP Person", t1 + t2 + t3) and "Hi ZZ Chief One," in t1)
    s.check("two departments (rule off): the plural heading and a section each, the scope joins both",
            "Your departments' progress" in t2 and subj2.startswith("ZZLP Legal and ZZLP Tax:")
            and "you head ZZLP Legal and ZZLP Tax." in t2, subj2)
    s.check("a single finished team reads singular: '1 team has finished every part: A's team.'",
            "1 team has finished every part: Zzlp Manager Legal's team." in t2
            and "1 team has finished every part: Zzlp Manager Taxtwo's team." in t2, re.findall(r"\d teams? ha[^<]*", t2))
    s.check("...the line is only where a team finished: one section here, one line", t3.count("finished every part") == 1)
    sx = hod_secs(ID["X3"])
    s.check("a calibrator who has people as their HOD has no HOD section", sx is None, sx)

    s.section("one email a person, from the highest role ticked")
    ALLR = ["bgceo", "buceo", "cg", "hod"]
    pick = lambda roles, uid: ctx(lambda d: [(r, [sc for sc in sc_]) for r, u, sc_ in a.lp_leaders(d, roles)   # noqa: E731
                                              if u["id"] == ID[uid]])
    one = lambda roles, uid: (lambda x: x[0][0] if len(x) == 1 else x)(pick(roles, uid))   # noqa: E731
    s.check("a BG CEO who is also a BU CEO gets ONE email, the BG CEO's (it was two)",
            pick(ALLR, "X1") == [("bgceo", [(BG2, None)])], pick(ALLR, "X1"))
    s.check("...with the BG CEO unticked they fall to the BU CEO email", pick(["buceo", "cg", "hod"], "X1")
            == [("buceo", [(BG2, U3)])])
    s.check("...with only BG CEOs ticked, the BG CEO's; with neither, none", one(["bgceo"], "X1") == "bgceo"
            and pick(["cg", "hod"], "X1") == [])
    s.check("a BU CEO who also calibrates: ONE email, the BU CEO's, their unit and no group", pick(ALLR, "X2")
            == [("buceo", [(BG2, U4)])], pick(ALLR, "X2"))
    s.check("...with BU CEOs unticked they get the calibrator's, their group",
            pick(["bgceo", "cg", "hod"], "X2") == [("cg", [(BG2, U4, G_X2)])], pick(["bgceo", "cg", "hod"], "X2"))
    s.check("a calibrator who has people as their HOD: the calibrator's email, never an HOD one",
            one(ALLR, "X3") == "cg" and pick(["hod"], "X3") == [], (pick(ALLR, "X3"), pick(["hod"], "X3")))
    with a.app.app_context():
        _d = a.get_db()
        _d.execute("DELETE FROM calib_bu_groups WHERE id=?", (G_X3,))   # falsify: no longer a calibrator
        _d.commit()
    try:
        s.check("falsified: once they calibrate nobody they are an HOD, with Sales as their department",
                pick(["hod"], "X3") == [("hod", [(BG2, U3, None, "ZZLP Sales", ID["X3"])])], pick(["hod"], "X3"))
        sx3 = hod_secs(ID["X3"], skip_done=False)
        s.check("...whose only team has done nothing: a row, no finished line in their table",
                sx3 and sx3[0][0]["finished"] == [] and len(sx3[0][0]["rows"]) == 1
                and sx3[0][0]["rows"][0]["name"] == "No line manager on file"
                and "finished every part" not in a._lp_table_html(sx3[0][0], two, "Line manager's team"), sx3)
    finally:
        with a.app.app_context():
            _d = a.get_db()
            G_X3 = _d.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES "
                              "(?,?,?,?)", (BG2, U3, "ZZLP X3 group", ID["X3"])).lastrowid
            _d.commit()
    allp = ctx(lambda d: a.lp_leaders(d, ALLR))
    ids_ = [u["id"] for _r, u, _s in allp]
    s.check("across everyone: a person is in the list once", len(ids_) == len(set(ids_)))
    with a.app.test_request_context("/"):
        d = a.get_db()
        built, open_, _ah = a.lp_build(d, a.active_cycle(d), dict(a.lp_rules(), roles=ALLR, parts=["pm_results", "tc_self"],
                                                                  skip_done=False))
    by_id = {}
    for b in built:
        by_id.setdefault(b["user"]["id"], []).append(b["role"])
    s.check("the build makes one email for each of them: X1 bgceo, X2 buceo with no group section, X3 cg, HD1 hod",
            by_id.get(ID["X1"]) == ["bgceo"] and by_id.get(ID["X2"]) == ["buceo"] and by_id.get(ID["X3"]) == ["cg"]
            and by_id.get(ID["HD1"]) == ["hod"] and all(len(v) == 1 for v in by_id.values()), by_id.get(ID["X2"]))
    x2 = [b for b in built if b["user"]["id"] == ID["X2"]][0]
    s.check("...and the BU CEO who calibrates has no calibration group section in theirs",
            not any(sx_.get("gid") for sx_ in x2["sections"]), [(x["name"], x.get("gid")) for x in x2["sections"]])
    hd1_b = [b for b in built if b["user"]["id"] == ID["HD1"]][0]
    s.check("...an HOD's built sections are their department's, the same as the direct read",
            [x["name"] for x in hd1_b["sections"]] == ["ZZLP Ops"] and hd1_b["sections"][0]["total"][0]["n"] == 30)

    s.section("the Executive Chairman gets no leader progress email, in any role (Chris, 2026-10-31); the delegate still does")
    def _chair_set(cid, did):
        with a.app.app_context():
            _d = a.get_db()
            _d.execute("DELETE FROM app_settings WHERE key IN ('exec_chair_id','exec_chair_delegate_id')")
            if cid:
                _d.execute("INSERT INTO app_settings(key, value) VALUES ('exec_chair_id', ?)", (str(cid),))
            if did:
                _d.execute("INSERT INTO app_settings(key, value) VALUES ('exec_chair_delegate_id', ?)", (str(did),))
            _d.commit()
    def _built_ids():
        with a.app.test_request_context("/"):
            _d = a.get_db()
            _b, _o, _ah = a.lp_build(_d, a.active_cycle(_d), dict(a.lp_rules(), roles=ALLR, parts=["pm_results", "tc_self"],
                                                                  skip_done=False))
        return {b["user"]["id"] for b in _b}
    _env0 = os.environ.get("ONEHR_CHAIR")
    try:
        for who, nm in (("X3", "a calibrator"), ("X2", "a BU CEO"), ("HD1", "an HOD")):
            os.environ["ONEHR_CHAIR"] = "1"
            _chair_set(ID[who], ID["X1"])
            led = {u["id"] for _r, u, _s in ctx(lambda d: a.lp_leaders(d, ALLR))}
            s.check("chair seat on %s: lp_leaders leaves them out, the delegate (a BG CEO) stays in" % nm,
                    ID[who] not in led and ID["X1"] in led, (ID[who] in led, ID["X1"] in led))
            bid = _built_ids()
            s.check("...and lp_build makes no email for them, but still one for the delegate",
                    ID[who] not in bid and ID["X1"] in bid, (ID[who] in bid, ID["X1"] in bid))
            _chair_set(None, None)
            led = {u["id"] for _r, u, _s in ctx(lambda d: a.lp_leaders(d, ALLR))}
            s.check("...seat cleared: they come back", ID[who] in led and ID["X1"] in led)
            os.environ["ONEHR_CHAIR"] = "1"
            _chair_set(ID[who], None)
            os.environ.pop("ONEHR_CHAIR", None)
            led = {u["id"] for _r, u, _s in ctx(lambda d: a.lp_leaders(d, ALLR))}
            s.check("...flag off with the seat still set: nothing changes, they are in", ID[who] in led)
    finally:
        _chair_set(None, None)
        if _env0 is None:
            os.environ.pop("ONEHR_CHAIR", None)
        else:
            os.environ["ONEHR_CHAIR"] = _env0

    s.section("the HODs' email as a template")
    with a.app.test_request_context("/"):
        d = a.get_db()
        k = a.EMAIL_TPL_KIND.get("lp_hod")
        ks = [x["key"] for x in a.EMAIL_TPL_KINDS]
        s.check("lp_hod is an email kind after lp_bgceo, with its words and the table line",
                bool(k) and ks.index("lp_hod") == ks.index("lp_bgceo") + 1 and k["role"] == "hod"
                and k["title"] == "Leader progress · HODs" and k["first"] == "HOD progress"
                and k["who"] == "HODs: their department, by line manager's team" and "up to 10 teams" in k["lists"], k)
        s.check("...read like the others: no template yet, the default words", a.email_tpl_words("lp_hod") == T
                and a.lp_template("hod") == T and a._email_tpl_default("lp_hod") == T)
        d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('leader_progress_template', ?)",
                  (a.json.dumps({"hod": {"subject": "ZZLP older {scope}"}}),))
        d.commit()
        legacy = a._email_tpl_legacy("lp_hod")
        d.execute("DELETE FROM app_settings WHERE key='leader_progress_template'")
        d.commit()
        s.check("the older saved words reach it too (key 'hod')", legacy["subject"] == "ZZLP older {scope}"
                and legacy["heading"] == T["heading"])
        me_ = d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        sub_s, body_s = a.email_tpl_sample(d, "lp_hod", T, me_)
    t_s = _html.unescape(body_s)
    s.check("its sample is made-up: three line managers' teams (labels, no names), Whole department, the HOD's words",
            "Line manager A's team" in t_s and "Line manager C's team" in t_s and "Whole department" in t_s
            and "Line manager's team" in t_s and "Your department's progress" in t_s
            and sub_s.startswith("Sample department: where your teams stand"), sub_s)
    SUP0 = H.client_as(a, SU["id"])
    pgE = SUP0.get("/admin/emails?email=lp_hod").get_data(as_text=True)
    s.check("Email › Emails and templates lists it and opens it", "Leader progress · HODs" in pgE and "HOD progress" in pgE)
    pgS = SUP0.get("/admin/email").get_data(as_text=True)
    s.check("...and Email › Schedule's top card has its Leader progress row (the who-chips moved out of it, 2026-11-09)",
            'data-eml-row="lp"' in pgS and "Leader progress" in pgS)
    with a.app.test_request_context("/"):
        d = a.get_db()
        for roles_, want_ in ((["bgceo"], "Off: it goes only with Send now"), (["hod"], "every week")):
            d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('leader_progress_rules', ?)",
                      (a.json.dumps(dict(a.LP_DEFAULT_RULES, enabled=True, roles=roles_)),))
            d.commit()
            s.check("when it goes follows the HODs' tick (%s)" % roles_[0], want_ in a.email_tpl_when(d, "lp_hod"),
                    a.email_tpl_when(d, "lp_hod"))

    s.section("the overlap note: line managers still reviewing (HODs), HODs still on their Department Reviews (BU CEOs, Calibrators)")
    from werkzeug.datastructures import MultiDict  # noqa: F811
    NOTE_TODAY = a._today_myt()
    day = lambda n: a._em_day(NOTE_TODAY + timedelta(days=n))   # noqa: E731
    HEAD_HOD = "Line managers are still reviewing their teams, until %s."
    HEAD_CAL = "HODs are still on their Department Reviews, until %s."
    ADV_HOD = ("We recommend you start your Department Review once every line manager in your department has completed "
               "their team review.")
    ADV_CAL = "We recommend you start your BU calibration once every HOD in your %s has completed their Department Review."

    def set_win(open_=None, ahead=()):
        """Each of the note's six windows: those in `open_` ({cell: days until it closes, None = no closing date}) open
        now, those in `ahead` open tomorrow, every other one closed yesterday (a cell with no row would read as open)."""
        open_ = open_ or {}
        now_ = a._now_myt()
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(NOTE_CELLS)),
                       (CID,) + NOTE_CELLS)
            for c_ in NOTE_CELLS:
                if c_ in open_:
                    o_, cl_ = now_ - timedelta(days=2), (None if open_[c_] is None else
                                                         (now_ + timedelta(days=open_[c_])).strftime("%Y-%m-%d 23:59"))
                elif c_ in ahead:
                    o_, cl_ = now_ + timedelta(days=1), (now_ + timedelta(days=20)).strftime("%Y-%m-%d 23:59")
                else:
                    o_, cl_ = now_ - timedelta(days=20), (now_ - timedelta(days=1)).strftime("%Y-%m-%d 23:59")
                d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                           (CID, c_, o_.strftime("%Y-%m-%d %H:%M"), cl_))
            d_.commit()

    def set_mods(off=()):
        with a.app.app_context():
            d_ = a.get_db()
            for m_ in ("pm", "tm", "calibration"):
                d_.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)",
                           (CID, m_, 0 if m_ in off else 1))
            d_.commit()

    def restore_win():
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(NOTE_CELLS)),
                       (CID,) + NOTE_CELLS)
            d_.executemany("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", WIN2)
            d_.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN ('pm','tm','calibration')", (CID,))
            d_.executemany("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", MODS)
            d_.commit()

    def sql(q, *args):
        with a.app.app_context():
            a.get_db().execute(q, args)
            a.get_db().commit()

    def mail_of(role, uid, parts=("pm_results",), skip_done=False, lp_leaders_only=True):
        """(built entry, the email's text unescaped, its html) of one leader's email as the build makes it."""
        with a.app.test_request_context("/"):
            d_ = a.get_db()
            cy_ = a.active_cycle(d_)
            rules_ = dict(a.LP_DEFAULT_RULES, parts=list(parts), skip_done=skip_done)
            built_, op_, ah_ = a.lp_build(d_, cy_, rules_, only=(role, ID[uid]))
            if not built_:
                return None, "", ""
            b_ = built_[0]
            _sj, body_ = a.lp_mail(d_, b_["role"], b_["user"], b_["sections"], op_, ah_, cy_, rules=rules_, note=b_["note"])
        return b_, _html.unescape(body_), body_
    box = lambda t: '<td class="oh-t" style="padding:10px 14px' in t   # noqa: E731

    HALF0 = CYC["half"]
    with a.app.test_request_context("/"):
        s.check("a Mid-Year cycle has no BU calibration, so the BU CEO and Calibrator notes can't show in one (and the HOD "
                "one can)", HALF0 is not None and str(HALF0) == "1" and not {"pm_buceo", "pot_buceo"} &
                set(a._cycle_cells_used(a.active_cycle(a.get_db()))) and {"pm_hod", "pm_approve"} <=
                set(a._cycle_cells_used(a.active_cycle(a.get_db()))), (HALF0, a._cycle_cells_used(CYC)))
    set_mods()
    with a.app.app_context():   # the saved rules the preview, the test and the send all read
        _d = a.get_db()
        _d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('leader_progress_rules', ?)",
                   (a.json.dumps(dict(a.LP_DEFAULT_RULES, parts=["pm_results"], skip_done=False)),))
        _d.commit()
    try:
        # ---- HODs
        set_win({"pm_hod": 3, "pot_hod": 5, "pm_approve": 6, "tc_approve": 9})
        b, t_, h_ = mail_of("hod", "HD1")
        s.check("HOD: their Department Review and a line managers' part open: the note, the LATER line managers' close date",
                b and b["note"] == {"lm_closes": day(9)} and (HEAD_HOD % day(9)) in t_ and ADV_HOD in t_, b and b["note"])
        s.check("...bold first line, then the advice, in the grey box (#f4f5f9, 8px radius), just under the opening, "
                "above the table",
                "<b>%s</b>" % (HEAD_HOD % day(9)) in h_ and "#f4f5f9" in h_ and "border-radius:8px" in h_
                and t_.index("Here is where") < t_.index("Line managers are still reviewing")
                < t_.index("Line manager's team"), t_[:900])
        s.check("...never the word Reopen", "reopen" not in t_.lower())
        b2, t2_, _h = mail_of("hod", "HD1", parts=("pm_results", "pm_approve", "tc_approve"))
        s.check("...with the line managers' parts as columns and teams still to complete: the note stays",
                b2["note"] and HEAD_HOD % day(9) in t2_, b2["note"])
        set_win({"pm_hod": 3, "pm_approve": 6, "tc_approve": 2})
        b, t_, _h = mail_of("hod", "HD1")
        s.check("the close date is the later of the open cells (KPI moderation, 6 days, over the competency review, 2)",
                b["note"] == {"lm_closes": day(6)}, b["note"])
        set_win({"pm_hod": 3, "pm_approve": 6, "tc_approve": 2}, ahead=())
        set_win({"pm_hod": 3, "pm_approve": None})
        b, t_, _h = mail_of("hod", "HD1")
        s.check("an open part with no closing date: 'until further notice', not a blank",
                b["note"] == {"lm_closes": "further notice"} and "until further notice." in t_, b["note"])
        set_win({"pm_hod": 3, "pot_hod": 5})
        b, t_, _h = mail_of("hod", "HD1")
        s.check("only the HOD's Department Review open: no note", b and b["note"] is None and "reviewing their teams" not in t_)
        set_win({"pm_approve": 6, "tc_approve": 9})
        b, t_, _h = mail_of("hod", "HD1")
        s.check("only the line managers' parts open: no note", b and b["note"] is None and "reviewing their teams" not in t_)
        set_win({"pm_hod": 3, "pm_approve": 6}, ahead=("tc_approve", "pot_hod"))
        b, t_, _h = mail_of("hod", "HD1")
        s.check("...a part that opens tomorrow isn't open; the two that are open are enough", b["note"] == {
            "lm_closes": day(6)}, b["note"])
        set_win({"pm_hod": 3}, ahead=("pm_approve", "tc_approve"))
        b, t_, _h = mail_of("hod", "HD1")
        s.check("the line managers' parts open tomorrow only: no note yet", b["note"] is None)
        set_win({"pm_hod": 3, "pm_approve": 6})
        set_mods(off=("pm",))
        b, t_, _h = mail_of("hod", "HD1", parts=("pm_results",))
        s.check("falsified: the Performance module off takes both windows with it (pm_hod, pm_approve): no note",
                b is None or b["note"] is None, b and b["note"])
        set_mods()
        b, t_, _h = mail_of("hod", "HD1")
        s.check("...and on again, the note is back", b["note"] == {"lm_closes": day(6)}, b["note"])
        # the line managers' parts complete in every team of every section
        set_win({"pm_hod": 3, "tc_approve": 9})
        with a.app.app_context():
            _d = a.get_db()
            _d.execute("UPDATE tc_assessments SET reviewed_at='2026-10-03 00:00' WHERE cycle_id=? AND subject_id IN (%s)"
                       % ",".join("?" * 4), (CID,) + tuple(ID[k] for k in ("R1a", "R1b", "T2a", "T2b")))
            _d.commit()
        b, t_, _h = mail_of("hod", "HD2", parts=("pm_results", "tc_approve"))
        cells = [[c["n"] for c in sec["total"]] for sec in b["sections"]]
        s.check("HOD: the line managers' part is a column and every team in both departments has it complete: no note",
                b["note"] is None and [sec["total"][1]["n"] for sec in b["sections"]] == [2, 2] and all(
                    c["n"] == c["done"] for sec in b["sections"] for c in sec["total"][1:]) and "reviewing their teams"
                not in t_, (cells, b["note"]))
        b, t_, _h = mail_of("hod", "HD2", parts=("pm_results", "tc_approve"), skip_done=True)
        s.check("...the same with finished departments left out of the email", b["note"] is None)
        b, t_, _h = mail_of("hod", "HD2", parts=("pm_results",))
        s.check("...but with the line managers' parts NOT among its columns, the open window alone gives the note",
                b["note"] == {"lm_closes": day(9)}, b["note"])
        with a.app.app_context():
            _d = a.get_db()
            _d.execute("UPDATE tc_assessments SET reviewed_at=NULL WHERE cycle_id=? AND subject_id=?", (CID, ID["T2a"]))
            _d.commit()
        b, t_, _h = mail_of("hod", "HD2", parts=("pm_results", "tc_approve"))
        s.check("falsified: one team left to review (T2a un-reviewed) and the note comes back",
                b["note"] == {"lm_closes": day(9)}, b["note"])
        b, t_, _h = mail_of("hod", "HD1", parts=("pm_results", "tc_approve"))
        s.check("...and HD1, whose teams have not been reviewed, has it", b["note"] == {"lm_closes": day(9)})

        # ---- BU CEOs
        set_win({"pm_buceo": 4, "pm_hod": 3, "pot_hod": 7})
        b, t_, h_ = mail_of("buceo", "X1")
        s.check("in this Mid-Year cycle (no BU calibration) a BU CEO gets no note, though the windows are dated",
                b and b["note"] is None and "still on their Department" not in t_, b and b["note"])
        sql("UPDATE cycles SET half=2 WHERE id=?", CID)   # a Year-End cycle uses the calibration cells; put back below
        with a.app.test_request_context("/"):
            s.check("...a Year-End cycle uses all six", all(c_ in a._cycle_cells_used(a.active_cycle(a.get_db()))
                                                            for c_ in NOTE_CELLS))
        b, t_, h_ = mail_of("buceo", "X1")
        s.check("BU CEO: calibration and the HODs' Department Review open, another person heads a department in the unit: "
                "the note, the LATER HOD close date, 'unit'",
                b and b["note"] == {"hod_closes": day(7), "scope_noun": "unit"} and (HEAD_CAL % day(7)) in t_
                and (ADV_CAL % "unit") in t_ and "#f4f5f9" in h_ and t_.index("Here is where") < t_.index(
                    "HODs are still on their") < t_.index("Department"), b and b["note"])
        s.check("...no mention of Reopen; the table still follows", "reopen" not in t_.lower() and "All departments" in t_)
        set_win({"pm_buceo": 4})
        b, t_, _h = mail_of("buceo", "X1")
        s.check("only their calibration open: no note", b["note"] is None and "still on their Department" not in t_)
        set_win({"pm_hod": 3, "pot_hod": 7})
        b, t_, _h = mail_of("buceo", "X1")
        s.check("only the HODs' Department Review open: no note", b["note"] is None)
        set_win({"pot_buceo": 8, "pot_hod": 3})
        b, t_, _h = mail_of("buceo", "X1")
        s.check("...the potential cells count as well as the KPI ones (pot_buceo and pot_hod)",
                b["note"] == {"hod_closes": day(3), "scope_noun": "unit"}, b["note"])
        set_mods(off=("calibration",))
        b, t_, _h = mail_of("buceo", "X1")
        s.check("falsified: the calibration module off takes pot_buceo and pot_hod with it: no note", b["note"] is None)
        set_mods()
        set_win({"pm_buceo": 4, "pm_hod": 3, "pot_hod": 7})
        b, t_, _h = mail_of("buceo", "X2")
        s.check("a BU CEO whose unit's only department (Yard) is headed by themself: no note (a BU CEO seat is no HOD)",
                b and b["sections"] and b["note"] is None and "still on their Department" not in t_, b and b["sections"])
        real_hods = a._hod_ids_with_review
        a._hod_ids_with_review = lambda d, ids: [i for i in ids if i]   # falsified: pretend a seat holder is an HOD
        try:
            b, t_, _h = mail_of("buceo", "X2")
        finally:
            a._hod_ids_with_review = real_hods
        s.check("...and were they one, the leader's own department still gives no note (they are not 'another person')",
                b["note"] is None)
        sql("UPDATE users SET hod_id=? WHERE id IN (?,?)", ID["X3"], ID["Y1a"], ID["Y1b"])
        b, t_, _h = mail_of("buceo", "X2")
        s.check("a unit whose department is headed by another calibrator (no Department Review, so no HOD to wait on): no note",
                b and b["sections"] and b["note"] is None, b and b["note"])
        sql("UPDATE users SET hod_id=NULL WHERE id IN (?,?)", ID["Y1a"], ID["Y1b"])
        b, t_, _h = mail_of("buceo", "X2")
        s.check("a unit with no HOD at all (nobody's hod_id): no note", b["note"] is None)
        sql("UPDATE users SET hod_id=? WHERE id=?", ID["HD1"], ID["Y1b"])
        sql("UPDATE users SET hod_id=? WHERE id=?", ID["X2"], ID["Y1a"])
        b, t_, _h = mail_of("buceo", "X2")
        s.check("...one department headed by themself and another by a real HOD (HD1): the note", b["note"] == {
            "hod_closes": day(7), "scope_noun": "unit"}, b["note"])
        sql("UPDATE users SET hod_id=? WHERE id IN (?,?)", ID["X2"], ID["Y1a"], ID["Y1b"])
        # several units
        sql("UPDATE users SET hod_id=? WHERE id IN (?,?)", ID["HD1"], ID["A1"], ID["B1"])
        b, t_, _h = mail_of("buceo", "L1")
        s.check("BU CEO with several units: the plural, 'in your units'", len(b["sections"]) == 2 and b["note"] == {
            "hod_closes": day(7), "scope_noun": "units"} and (ADV_CAL % "units") in t_, b["note"])
        b, t_, _h = mail_of("buceo", "L1", skip_done=True)
        s.check("...one unit left out as finished: singular again, from the units the email shows",
                len(b["sections"]) == 1 and b["note"]["scope_noun"] == "unit" and (ADV_CAL % "unit") in t_, b["note"])
        sql("UPDATE users SET hod_id=NULL WHERE id IN (?,?)", ID["A1"], ID["B1"])
        b, t_, _h = mail_of("buceo", "L1")
        s.check("...and no HOD anywhere in their units: no note", b["note"] is None)

        # ---- Calibrators
        G_X3b = None
        with a.app.app_context():
            _d = a.get_db()
            for k in ("P01a", "P01b"):
                _d.execute("INSERT INTO calib_bu_group_people(group_id, business_group, user_id) VALUES (?,?,?)",
                           (G_X3, BG2, ID[k]))
            _d.commit()
        b, t_, h_ = mail_of("cg", "X3")
        s.check("Calibrator: their Calibration Group has people with an HOD (HD1): the note with the Calibration Group "
                "variant of the words",
                b and b["role"] == "cg" and b["note"] == {"hod_closes": day(7), "scope_noun": "Calibration Group"}
                and (HEAD_CAL % day(7)) in t_ and (ADV_CAL % "Calibration Group") in t_ and "BU CEO" not in t_.split(
                    "Here is where")[0], b and (b["role"], b["note"]))
        set_win({"pm_hod": 3})
        b, t_, _h = mail_of("cg", "X3")
        s.check("...only the HODs' review open: no note", b["note"] is None)
        set_win({"pm_buceo": 4, "pm_hod": 3, "pot_hod": 7})
        with a.app.app_context():
            _d = a.get_db()
            G_X3b = _d.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES "
                               "(?,?,?,?)", (BG2, U3, "ZZLP X3 group b", ID["X3"])).lastrowid
            _d.execute("INSERT INTO calib_bu_group_people(group_id, business_group, user_id) VALUES (?,?,?)",
                       (G_X3b, BG2, ID["P02a"]))
            _d.commit()
        b, t_, _h = mail_of("cg", "X3")
        s.check("a Calibrator with several groups: 'Calibration Groups'", len(b["sections"]) == 2 and b["note"] == {
            "hod_closes": day(7), "scope_noun": "Calibration Groups"} and (ADV_CAL % "Calibration Groups") in t_, b["note"])
        with a.app.app_context():   # the groups' people are now only those headed by the calibrator themself
            _d = a.get_db()
            _d.execute("DELETE FROM calib_bu_group_people WHERE user_id IN (?,?,?)", (ID["P01a"], ID["P01b"], ID["P02a"]))
            for k in ("S1a", "S1b"):
                _d.execute("INSERT INTO calib_bu_group_people(group_id, business_group, user_id) VALUES (?,?,?)",
                           (G_X3, BG2, ID[k]))
            _d.commit()
        b, t_, _h = mail_of("cg", "X3")
        s.check("a group whose people are all headed by the calibrator themself (no HOD to wait on): no note",
                b and b["sections"] and b["note"] is None and "still on their Department" not in t_,
                b and ([x["name"] for x in b["sections"]], b["note"]))
        with a.app.app_context():
            _d = a.get_db()
            _d.execute("DELETE FROM calib_bu_group_people WHERE group_id=?", (G_X3,))
            _d.execute("DELETE FROM calib_bu_groups WHERE id=?", (G_X3b,))
            for k in ("P01a", "P01b"):
                _d.execute("INSERT INTO calib_bu_group_people(group_id, business_group, user_id) VALUES (?,?,?)",
                           (G_X3, BG2, ID[k]))
            _d.commit()

        # ---- the words: fields, editable, older templates, no other role
        K = a.EMAIL_TPL_KIND
        has = lambda key: {f[0] for f in K[key]["fields"]} >= {"note_head", "note"}   # noqa: E731
        s.check("template fields: lp_hod, lp_buceo and lp_cg have the note's two; lp_bgceo and lp_bgadmin don't",
                has("lp_hod") and has("lp_buceo") and has("lp_cg") and not has("lp_bgceo") and not has("lp_bgadmin")
                and K["lp_bgadmin"]["fields"] == a.LP_TPL_FIELDS and K["lp_bgceo"]["fields"] == a.LP_TPL_FIELDS
                and "note" not in a.LP_TPL_DEFAULT["bgceo"] and "note" not in a.LP_TPL_DEFAULT["bgadmin"])
        s.check("...the note is a paragraph (multiline) and its placeholders are its own",
                "note" in K["lp_hod"]["multiline"] and "lm_closes" in K["lp_hod"]["placeholders"]
                and "hod_closes" not in K["lp_hod"]["placeholders"] and "hod_closes" in K["lp_cg"]["placeholders"]
                and "scope_noun" in K["lp_buceo"]["placeholders"] and "lm_closes" not in K["lp_buceo"]["placeholders"]
                and "lm_closes" not in K["lp_bgceo"]["placeholders"])
        s.check("the default words are the approved ones", a.LP_TPL_DEFAULT["hod"]["note_head"] == "Line managers are "
                "still reviewing their teams, until {lm_closes}." and a.LP_TPL_DEFAULT["hod"]["note"] == ADV_HOD
                and a.LP_TPL_DEFAULT["buceo"]["note_head"] == "HODs are still on their Department Reviews, until "
                "{hod_closes}." and a.LP_TPL_DEFAULT["buceo"]["note"] == ADV_CAL % "{scope_noun}"
                and a.LP_TPL_DEFAULT["cg"]["note"] == ADV_CAL % "{scope_noun}")
        t_, e_ = ctx(lambda d: a.lp_template_from(MultiDict({"note": "Wait until {hod_closes}"}), "hod"))
        s.check("the form: {hod_closes} isn't the HOD's to use (refused, naming what is)", any("{hod_closes}" in x
                and "{lm_closes}" in x for x in e_), e_)
        t_, e_ = ctx(lambda d: a.lp_template_from(MultiDict({"note_head": "Until {lm_closes}"}), "buceo"))
        s.check("...nor {lm_closes} the BU CEO's", any("{lm_closes}" in x for x in e_), e_)
        t_, e_ = ctx(lambda d: a.lp_template_from(MultiDict({"note_head": "Until {hod_closes}", "note": "In {scope_noun}"}), "cg"))
        s.check("...but each its own", not e_ and t_["note_head"] == "Until {hod_closes}" and t_["note"] == "In {scope_noun}", e_)
        t_, e_ = ctx(lambda d: a.lp_template_from(MultiDict({"note": "x" * 401}), "hod"))
        s.check("...over its ceiling is refused, not trimmed", any("under 400" in x for x in e_), e_)
        t_, e_ = ctx(lambda d: a.lp_template_from(MultiDict({"note": "Nope", "note_head": "Nope"}), "bgceo"))
        s.check("the BG CEO's form ignores them: the words stay theirs, with no note", not e_ and "note" not in t_)

        SUPN = H.client_as(a, SU["id"])
        pg_h = SUPN.get("/admin/reminders/leaders?role=hod").get_data(as_text=True)
        pg_g = SUPN.get("/admin/reminders/leaders?role=bgceo").get_data(as_text=True)
        s.check("the leader progress page: the note's two fields for HODs, BU CEOs and Calibrators, none for BG CEOs",
                'name="note_head"' in pg_h and 'name="note"' in pg_h and 'name="note_head"' not in pg_g
                and 'name="note"' not in pg_g and "{lm_closes}" in pg_h and "{hod_closes}" not in pg_h
                and all('name="note_head"' in SUPN.get("/admin/reminders/leaders?role=%s" % r_).get_data(as_text=True)
                        for r_ in ("buceo", "cg")))
        pe_h = SUPN.get("/admin/emails?email=lp_hod").get_data(as_text=True)
        pe_g = SUPN.get("/admin/emails?email=lp_bgceo").get_data(as_text=True)
        s.check("Email › Emails and templates: the same", "Note: advice" in pe_h and "Note: advice" not in pe_g)
        SUPN.post("/admin/reminders/leaders", data={
            "csrf_token": "tok", "action": "save_email", "role": "hod", "note_head": "ZZLP head {lm_closes} for {first_name}",
            "note": "ZZLP advice, closing {lm_closes}."})
        set_win({"pm_hod": 3, "pm_approve": 6, "tc_approve": 9})
        b, t_, _h = mail_of("hod", "HD1")
        s.check("the words are editable: a saved template's note reaches the email, its placeholders filled",
                ctx(lambda d: a.lp_template("hod"))["note_head"] == "ZZLP head {lm_closes} for {first_name}"
                and "ZZLP head %s for Zz" % day(9) in t_ and "ZZLP advice, closing %s." % day(9) in t_
                and "reviewing their teams" not in t_, re.findall(r"ZZLP[^\n]{0,100}|Line managers are[^\n]{0,80}", t_)[:4])
        s.check("...and only the HODs' template changed",
                ctx(lambda d: a.lp_template("buceo"))["note_head"] == a.LP_TPL_DEFAULT["buceo"]["note_head"])
        SUPN.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "save_email", "role": "hod",
                                                    "note_head": "", "note": ""})
        b, t_, h_ = mail_of("hod", "HD1")
        s.check("both lines emptied: no box at all, the rest of the email as it was", b["note"] and
                "Line managers are still" not in t_ and "ZZLP head" not in t_ and "ZZLP advice" not in t_
                and "Whole department" in t_ and "#f4f5f9" not in h_)
        SUPN.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "reset_email", "role": "hod"})
        s.check("Back to the default puts the note's words back", ctx(lambda d: a.lp_template("hod")) == a.LP_TPL_DEFAULT["hod"])
        # an older saved template: only the six fields it was made with
        with a.app.app_context():
            _d = a.get_db()
            row = a.email_tpl_today(_d, "lp_hod", SU["id"])
            _d.execute("UPDATE email_templates SET words=? WHERE id=?",
                       (a.json.dumps({"subject": "ZZLP old {scope}", "heading": "ZZLP old heading", "greeting": "Hi,",
                                      "opening": "ZZLP old opening", "button": "Go", "closing": "Bye"}), row["id"]))
            _d.commit()
        b, t_, _h = mail_of("hod", "HD1")
        s.check("an older template (saved before the fields existed) still renders, the note in OneHR's own words",
                "ZZLP old heading" in t_ and "ZZLP old opening" in t_ and (HEAD_HOD % day(9)) in t_ and ADV_HOD in t_,
                t_[:600])
        legacy_ = ctx(lambda d: a.email_tpl_words("lp_hod"))
        s.check("...as the words in use: the missing fields read the defaults", legacy_["note"] == ADV_HOD
                and legacy_["subject"] == "ZZLP old {scope}")
        with a.app.test_request_context("/"):   # a caller handing lp_mail a template with no note fields at all
            d = a.get_db()
            hd1u = d.execute("SELECT * FROM users WHERE id=?", (ID["HD1"],)).fetchone()
            bld = a.lp_build(d, a.active_cycle(d), dict(a.LP_DEFAULT_RULES, parts=["pm_results"], skip_done=False),
                             only=("hod", ID["HD1"]))[0][0]
            _s, bare = a.lp_mail(d, "hod", hd1u, bld["sections"], [(a.LP_PART["pm_results"], None)], [],
                                 a.active_cycle(d), tpl={k: v for k, v in a.LP_TPL_DEFAULT["hod"].items()
                                                         if k not in ("note", "note_head")}, note=bld["note"])
        s.check("...and lp_mail given a template without the note's fields uses OneHR's words", (HEAD_HOD % day(9)) in
                _html.unescape(bare))
        with a.app.app_context():
            _d = a.get_db()
            _d.execute("DELETE FROM email_templates")
            _d.execute("DELETE FROM app_settings WHERE key='leader_progress_template'")
            _d.commit()

        # ---- the preview, the test send and the real send carry the same note
        pv = _html.unescape(SUPN.get("/admin/reminders/leaders/preview?who=hod:%d" % ID["HD1"]).get_data(as_text=True))
        pv_c = _html.unescape(SUPN.get("/admin/reminders/leaders/preview?who=buceo:%d" % ID["X1"]).get_data(as_text=True))
        want_h, want_c = HEAD_HOD % day(9), HEAD_CAL % day(7)
        set_win({"pm_hod": 3, "pm_approve": 6, "tc_approve": 9})
        pv = _html.unescape(SUPN.get("/admin/reminders/leaders/preview?who=hod:%d" % ID["HD1"]).get_data(as_text=True))
        s.check("the page's preview shows the HOD's note", want_h in pv and ADV_HOD in pv, pv[:300])
        set_win({"pm_buceo": 4, "pm_hod": 3, "pot_hod": 7})
        pv_c = _html.unescape(SUPN.get("/admin/reminders/leaders/preview?who=buceo:%d" % ID["X1"]).get_data(as_text=True))
        s.check("...and the BU CEO's", want_c in pv_c and (ADV_CAL % "unit") in pv_c, pv_c[:300])
        real_mail = (a.mailer.is_configured, a.mailer.send_mail, a.mailer.config_status, a.OUTBOX_ASYNC, a.mailer.get_token)
        SENT = []
        a.mailer.is_configured = lambda: True
        a.mailer.config_status = lambda: {"configured": True}
        a.mailer.send_mail = lambda to, subject, body, **kw: SENT.append((to, subject, body))
        a.OUTBOX_ASYNC = False
        a.mailer.get_token = lambda: "tok"
        try:
            set_win({"pm_hod": 3, "pm_approve": 6, "tc_approve": 9})
            SUPN.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "test", "who": "hod:%d" % ID["HD1"],
                                                        "test_to": "me@zzlp.invalid"})
            s.check("the test send carries the same note", len(SENT) == 1 and want_h in _html.unescape(SENT[0][2])
                    and ADV_HOD in _html.unescape(SENT[0][2]), [x[0] for x in SENT])
            real_leaders = a.lp_leaders
            a.lp_leaders = lambda d, roles: [x for x in real_leaders(d, roles) if x[1]["id"] == ID["HD1"]]
            try:
                with a.app.test_request_context("/"):
                    d = a.get_db()
                    d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('leader_progress_rules', ?)",
                              (a.json.dumps(dict(a.LP_DEFAULT_RULES, parts=["pm_results"], roles=["hod"])),))
                    d.commit()
                    a.lp_send(d, a.active_cycle(d), "note run", actor_id=SU["id"])
                    sent_body = d.execute("SELECT body FROM email_outbox WHERE id>? AND user_id=? ORDER BY id DESC",
                                          (OUT0, ID["HD1"])).fetchone()
            finally:
                a.lp_leaders = real_leaders
            s.check("the real send (the outbox row) carries the same note", sent_body and want_h in _html.unescape(
                sent_body[0]) and ADV_HOD in _html.unescape(sent_body[0]))
        finally:
            a.mailer.is_configured, a.mailer.send_mail, a.mailer.config_status, a.OUTBOX_ASYNC, a.mailer.get_token = real_mail
        # the sample on Email › Emails and templates shows the words the admin is editing
        with a.app.test_request_context("/"):
            d = a.get_db()
            me_ = d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
            samples = {k_: _html.unescape(a.email_tpl_sample(d, k_, a.email_tpl_words(k_), me_)[1])
                       for k_ in ("lp_hod", "lp_buceo", "lp_cg", "lp_bgceo", "lp_bgadmin")}
        s.check("the template preview shows a made-up note for the three roles and none for the other two",
                "Line managers are still reviewing their teams, until" in samples["lp_hod"]
                and "HODs are still on their Department Reviews, until" in samples["lp_buceo"]
                and "in your Calibration Group has" in samples["lp_cg"] and "in your unit has" in samples["lp_buceo"]
                and "still reviewing" not in samples["lp_bgceo"] and "still on their Department" not in samples["lp_bgadmin"]
                and not re.search(r"\{(lm_closes|hod_closes|scope_noun)\}", samples["lp_hod"] + samples["lp_buceo"] + samples["lp_cg"]))
        # BG CEOs never get it, whatever is open
        set_win({"pm_buceo": 4, "pm_hod": 3, "pot_hod": 7, "pm_approve": 6})
        b, t_, _h = mail_of("bgceo", "X1")
        s.check("a BG CEO's email never has the note, though everything is open", b and b["note"] is None
                and "still on their Department" not in t_ and "reviewing their teams" not in t_)
        outdir = os.environ.get("LP_NOTE_RENDER_DIR")   # for a look at the two emails with their note (not a check)
        if outdir:
            os.makedirs(outdir, exist_ok=True)
            set_win({"pm_hod": 3, "pot_hod": 5, "pm_approve": 6, "tc_approve": 9})
            open(os.path.join(outdir, "hod-email-with-note.html"), "w", encoding="utf-8").write(mail_of("hod", "HD1")[2])
            set_win({"pm_buceo": 4, "pm_hod": 3, "pot_hod": 7})
            open(os.path.join(outdir, "bu-ceo-email-with-note.html"), "w", encoding="utf-8").write(mail_of("buceo", "X1")[2])
    finally:
        restore_win()
        sql("UPDATE cycles SET half=? WHERE id=?", HALF0, CID)

    s.section("the page")
    SUP, BAC = H.client_as(a, SU["id"]), H.client_as(a, BGA)
    pg = SUP.get("/admin/reminders/leaders").get_data(as_text=True)
    s.check("the super admin's page: the cards and the tabs", all(x in pg for x in (
        "When it goes out", "Who gets it", "What it counts", "The email", "Preview as", "Leader progress",
        "Everyone's reminder")) and 'name="part"' in pg)
    s.check("the reminder page has the tabs too", "Leader progress" in SUP.get("/admin/reminders").get_data(as_text=True))
    s.check("a BG admin can't open it: the whole Email menu is the super admin's (Chris, 2026-10-24)",
            BAC.get("/admin/reminders/leaders").status_code == 403
            and BAC.get("/admin/reminders/leaders/preview?who=bgceo:%d" % ID["L2"]).status_code == 403)
    s.check("...and can't change it", BAC.post("/admin/reminders/leaders", data={
        "csrf_token": "tok", "action": "save_rules", "freq": "weekly", "send_time": "09:00"}).status_code == 403)
    prev = SUP.get("/admin/reminders/leaders/preview?who=bgceo:%d" % ID["L2"]).get_data(as_text=True)
    s.check("the preview: the BG CEO's email as it would go out", "Your group&#x27;s progress" in prev
            or "Your group's progress" in prev, prev[:300])
    prevh = SUP.get("/admin/reminders/leaders/preview?who=hod:%d" % ID["HD1"]).get_data(as_text=True)
    s.check("the preview as an HOD: their email as it would go out (subject bar, the teams, the line)",
            "ZZLP Ops: where your teams stand" in prevh and "Whole department" in prevh
            and "have finished every part" in _html.unescape(prevh), prevh[:300])
    s.check("the page: HODs are a tick, with the rank line under the rows and a count in departments",
            'name="role" value="hod"' in pg and "One email a person, from the highest role ticked: BG CEO, then BU CEO, "
            "then Calibrator, then HOD." in pg and re.search(r"\d+ (?:person|people) · \d+ departments?", pg)
            and "<optgroup label=\"HODs\">" in pg and 'value="hod:%d"' % ID["HD1"] in pg)
    s.check("...the tabs for the words include HODs, on the HOD's words", 'href="/admin/reminders/leaders?role=hod#email"' in pg
            and "Your department&#39;s progress" in SUP.get("/admin/reminders/leaders?role=hod").get_data(as_text=True)
            .replace("&#34;", '"'))
    SUP.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "save_email", "role": "hod",
                                               "subject": "ZZLP hod subject {scope}"})
    s.check("...saves the HODs' words alone", ctx(lambda d: a.lp_template("hod"))["subject"] == "ZZLP hod subject {scope}"
            and ctx(lambda d: a.lp_template("buceo")) == a.LP_TPL_DEFAULT["buceo"])
    SUP.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "reset_email", "role": "hod"})
    s.check("...and puts them back", ctx(lambda d: a.lp_template("hod")) == a.LP_TPL_DEFAULT["hod"])
    other = H.one(a, "SELECT MIN(user_id) FROM buceo_seats WHERE business_group!=?", (BG,))
    s.check("there is a BU CEO outside their group to try", bool(other))
    s.check("...a BG admin can't preview any leader", BAC.get(
        "/admin/reminders/leaders/preview?who=buceo:%d" % (other or 0)).status_code == 403)
    s.check("...while the super admin can", "No leader with that seat" not in SUP.get(
        "/admin/reminders/leaders/preview?who=buceo:%d" % (other or 0)).get_data(as_text=True))
    r = SUP.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "save_rules", "freq": "weekly",
                                                   "weekday": "2", "send_time": "08:15", "role": ["bgceo"],
                                                   "part": ["tc_self"], "enabled": "on"})
    got = ctx(lambda d: a.lp_rules())
    s.check("the super admin saves the schedule", r.status_code == 302 and got["weekday"] == 2
            and got["roles"] == ["bgceo"] and got["parts"] == ["tc_self"] and got["send_time"] == "08:15")
    s.check("...written in the audit log", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND "
                                                   "action='leader_progress_schedule'", (LOG0,)) == 1)
    SUP.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "save_email", "role": "bgceo",
                                               "subject": "ZZLP subject {scope}"})
    s.check("...saves one role's words, the other's untouched", ctx(lambda d: a.lp_template("bgceo"))["subject"]
            == "ZZLP subject {scope}" and ctx(lambda d: a.lp_template("buceo")) == a.LP_TPL_DEFAULT["buceo"])
    SUP.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "reset_email", "role": "bgceo"})
    s.check("...and puts them back to the default", ctx(lambda d: a.lp_template("bgceo")) == a.LP_TPL_DEFAULT["bgceo"])
    n0 = H.one(a, "SELECT COUNT(*) FROM email_outbox")
    SUP.post("/admin/reminders/leaders", data={"csrf_token": "tok", "action": "send_now"})
    s.check("Send now on a server with no email: nothing queued", H.one(a, "SELECT COUNT(*) FROM email_outbox") == n0)
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at) VALUES (?, 'tc_self', ?)",
                  (CID, (a._now_myt() + timedelta(days=5)).strftime("%Y-%m-%d %H:%M")))
        d.commit()
    with a.app.test_request_context("/"):
        d = a.get_db()
        op, ah = a.lp_live_parts(d, a.active_cycle(d), dict(a.lp_rules(), parts=["pm_results", "tc_self"]))
    s.check("a part dated ahead isn't a column; it waits with its day", [p[0] for p, _c in op] == ["pm_results"]
            and [p[0] for p, _o in ah] == ["tc_self"], (op, ah))

    s.section("the day-after rule (Chris 2026-11-02): a part counts from the day AFTER its window opens, never the day it opens")
    from datetime import datetime  # noqa: E402
    with a.app.app_context():
        _d = a.get_db()
        PM_WIN = [tuple(r) for r in _d.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows WHERE cycle_id=? "
                                               "AND cell='pm_results'", (CID,))]
        OBD = _d.execute("SELECT open_by_date FROM cycles WHERE id=?", (CID,)).fetchone()[0]

    def setwin(spec):   # the windows exactly as spec says, dated parts open by date
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
            for cell, (o_, c_) in spec.items():
                d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell, o_, c_))
            d_.execute("UPDATE cycles SET open_by_date=1 WHERE id=?", (CID,))
            d_.commit()

    def live(parts, today=None):
        return ctx(lambda d_: tuple([p[0] for p, _c in r_] for r_ in a.lp_live_parts(
            d_, a.active_cycle(d_), dict(a.lp_rules(), parts=parts), today)))

    _F = "%Y-%m-%d %H:%M"
    _now = a._now_myt()
    _today = _now.date()
    _yest = (_now - timedelta(days=1)).strftime("%Y-%m-%d") + " 00:00"
    _open_today = _today.strftime("%Y-%m-%d") + " 00:00"
    _later = (_now + timedelta(days=10)).strftime(_F)
    _real_leaders = a.lp_leaders
    _real_cfg = a.mailer.is_configured
    _sent_rules = lambda **kw: dict(a.LP_DEFAULT_RULES, **kw)   # noqa: E731
    _clock = (a._now_myt, a._today_myt)
    a.lp_leaders = lambda d_, roles: [x for x in _real_leaders(d_, roles) if x[1]["id"] in (ID["L1"], ID["L2"])]

    def on_day(y, m, dd, fn):
        a._now_myt = lambda: datetime(y, m, dd, 10, 0)
        a._today_myt = lambda: datetime(y, m, dd).date()
        try:
            return fn()
        finally:
            a._now_myt, a._today_myt = _clock
    try:
        setwin({"pm_results": (_open_today, _later)})
        op, ah = live(["pm_results"])
        s.check("a part that opens today is not counted", op == [], (op, ah))
        s.check("...nor listed as coming up (it is open, not in the future)", ah == [], (op, ah))
        s.check("...the next day it is counted", live(["pm_results"], _today + timedelta(days=1))[0] == ["pm_results"])
        _o0 = H.one(a, "SELECT COUNT(*) FROM email_outbox")
        _l0 = H.one(a, "SELECT COALESCE(MAX(id),0) FROM activity_log")
        with a.app.test_request_context("/"):
            d = a.get_db()
            b_, o_, ah_ = a.lp_build(d, a.active_cycle(d), _sent_rules(parts=["pm_results"]))
            t_ = a.lp_send(d, a.active_cycle(d), "opening day", actor_id=SU["id"], rules=_sent_rules(parts=["pm_results"]))
        s.check("a send day with nothing counted builds no leaders and queues no email", b_ == [] and o_ == [] and ah_ == []
                and t_["leaders"] == 0 and t_["emailed"] == 0 and H.one(a, "SELECT COUNT(*) FROM email_outbox") == _o0, t_)
        s.check("...the run row says nothing it counts is open", "nothing it counts is open" in (H.one(
            a, "SELECT detail FROM activity_log WHERE id>? AND action='leader_progress_run' ORDER BY id DESC LIMIT 1", (_l0,)) or ""))
        # the job's turn on such a day sends nothing and records nothing (a holiday mark set ahead survives)
        a.mailer.is_configured = lambda: True
        _q = a._now_myt()
        _qh = _q.replace(minute=_q.minute - _q.minute % 15).strftime("%H:%M")
        try:
            with a.app.test_request_context("/"):
                d = a.get_db()
                _wk = _sent_rules(parts=["pm_results"], enabled=True, freq="every", every_days=1,
                                  since=_today.isoformat(), send_time=_qh)
                d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('leader_progress_rules', ?)", (a.json.dumps(_wk),))
                d.execute("DELETE FROM app_settings WHERE key='leader_progress_last'")
                d.commit()
                said = a.lp_auto(d, a.active_cycle(d))
                again = a.lp_auto(d, a.active_cycle(d))
                last = a._setting("leader_progress_last")
        finally:
            a.mailer.is_configured = _real_cfg
        s.check("the job's turn on that day (9 Nov: Chris, 2026-11-09): nothing counted, so nobody is emailed and the day is NOT recorded",
                "nothing goes out today" in said and " emailed" not in said and last is None and again == said, (said, last, again))
        s.check("the admin page says so", "From the day after a part opens, while it is open." in SUP.get(
            "/admin/reminders/leaders").get_data(as_text=True))
        s.check("...and shows the part as opening today, counted from tomorrow", "Opens today, counted from tomorrow" in SUP.get(
            "/admin/reminders/leaders").get_data(as_text=True))

        setwin({"pm_results": (_yest, _later)})
        s.check("a part that opened yesterday is counted", live(["pm_results"])[0] == ["pm_results"])
        setwin({"pm_results": (None, _later)})
        with a.app.app_context():   # parts open by date would not open an undated part: a cycle that does not, does
            a.get_db().execute("UPDATE cycles SET open_by_date=0 WHERE id=?", (CID,))
            a.get_db().commit()
        s.check("a part with no open date, open, stays counted", live(["pm_results"])[0] == ["pm_results"], live(["pm_results"]))
        setwin({"pm_results": (_yest, _later), "pm_approve": (_open_today, _later)})
        s.check("mixed: the employee part open since yesterday counts, the line managers' part opening today does not",
                live(["pm_results", "pm_approve"])[0] == ["pm_results"], live(["pm_results", "pm_approve"]))
        s.check("...and tomorrow both do", live(["pm_results", "pm_approve"], _today + timedelta(days=1))[0]
                == ["pm_results", "pm_approve"])
        # one schedule, every day 3-15 Nov: employee parts open 2 Nov, line managers' parts 9 Nov
        setwin({"pm_results": ("2026-11-02 00:00", "2026-11-08 23:59"), "pm_approve": ("2026-11-09 00:00", "2026-11-15 23:59")})
        both = ["pm_results", "pm_approve"]
        days = {dd: on_day(2026, 11, dd, lambda: live(both)[0]) for dd in range(2, 16)}
        s.check("2 Nov (opening day): nothing", days[2] == [], days[2])
        s.check("3-8 Nov count the employee part", all(days[dd] == ["pm_results"] for dd in range(3, 9)), days)
        s.check("9 Nov counts nothing", days[9] == [], days[9])
        s.check("10-15 Nov count the line managers' part", all(days[dd] == ["pm_approve"] for dd in range(10, 16)), days)

        def built_on(dd):
            def f():
                with a.app.test_request_context("/"):
                    d = a.get_db()
                    return a.lp_build(d, a.active_cycle(d), _sent_rules(parts=both))[0]
            return on_day(2026, 11, dd, f)
        s.check("9 Nov builds no leader, so nobody is emailed that day", built_on(9) == [])
        s.check("...while 3 Nov and 10 Nov do build leaders", built_on(3) != [] and built_on(10) != [])
    finally:
        a.lp_leaders = _real_leaders
        a.mailer.is_configured = _real_cfg
        a._now_myt, a._today_myt = _clock
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN ('pm_results','pm_approve','tc_approve','tc_self')", (CID,))
            d_.executemany("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", PM_WIN)
            d_.execute("UPDATE cycles SET open_by_date=? WHERE id=?", (OBD, CID))
            d_.commit()
    s.check("the settings sheet lists it", "leader_progress" in H.source(a) and '"Leader progress email"' in H.source(a))
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='tc_self'", (CID,))
        _db.executemany("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", WIN)
        _db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(NOTE_CELLS)),
                    (CID,) + NOTE_CELLS)
        _db.executemany("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", WIN2)
        _db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key IN ('pm','tm','calibration')", (CID,))
        _db.executemany("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", MODS)
        _db.execute("UPDATE cycles SET half=? WHERE id=?", (CYC["half"], CID))
        _db.execute("DELETE FROM email_outbox WHERE id>?", (OUT0,))
        _db.execute("DELETE FROM activity_log WHERE id>? AND action LIKE 'leader_progress%'", (LOG0,))
        for k, v in SAVED.items():
            _db.execute("DELETE FROM app_settings WHERE key=?", (k,))
            if v is not None:
                _db.execute("INSERT INTO app_settings(key,value) VALUES (?,?)", (k, v[0]))
        _db.commit()
        H.restore_email_templates(_db, TPLS)
        _cleanup(_db)

sys.exit(s.done())
