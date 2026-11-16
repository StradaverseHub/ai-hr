"""AI+ Learning, phase 3 slice 1: Learning XP, levels and badges, the Progress tab, and the level a request starts from
(Chris, 2026-10-21: "continue with the rest of the build"; plan OneHR/AI+ LMS/AI+ LMS plan 2026-10-20.md §3.6, canvas
[design canvas link removed] board 4C).

What this suite holds:
  * XP is worked out from the records, never stored: 10 an hour credited when L&D closes the session (attended or part
    of it; absent earns none) and 10 for the day-0 rating, matched against an independent SQL count; closing again
    recounts it; rating twice is refused and adds nothing; no route writes XP
  * the levels: 0 Explorer, 150 Learner (100 to go), 340 Practitioner with 160 to Level 4 Contributor (board 4C's own
    figures), 4000+ Master with nothing to go
  * the Progress tab (dark without ONEHR_LMS): the level, how it was earned, the badges (a family with a programme
    booked or done is "in progress"; the plan's others to start), hours this year and the department's per head
  * the user role's "XP, level and badges" row: off hides the tab (a typed ?tab=progress falls back), the Mine tile and
    the person's row in their line manager's team table; the row sits under AI+ Learning, dark with Learning, seeded on
  * the line manager's Team view lists their people's XP in name order (no ranking); the HOD's Dept view has none
  * a request keeps the competency it builds and the person's level on it as they ask (the 3-month check-in's
    "before"): the goal's family and the assessed level, else the programme's family the person needs; a walk-in too
Everything here is synthetic (ZZLX / ZZ9LX-) and removed at the end.
"""
import json
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning, phase 3: XP, levels, badges and the Progress tab")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG, CO = "ZZLX Group", "ZZLX U1"
_ENV0 = os.environ.get("ONEHR_LMS")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LX-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLX %'")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM lms_registrations WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM lms_attendance WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM lms_interest WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM tc_scores WHERE assessment_id IN (SELECT id FROM tc_assessments WHERE subject_id IN (%s))"
                   % ph, ul)
        db.execute("DELETE FROM tc_assessments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM tc_assignments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_idp_goals WHERE idp_id IN (SELECT id FROM pm_idp WHERE subject_id IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_idp WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL, user_role_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    for (rid,) in db.execute("SELECT id FROM user_roles WHERE name LIKE 'ZZLX %'").fetchall():
        db.execute("DELETE FROM user_role_modules WHERE role_id=?", (rid,))
        db.execute("DELETE FROM user_roles WHERE id=?", (rid,))
    db.execute("DELETE FROM activity_log WHERE detail LIKE '%ZZLX%'")
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZLX-%'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, grade, mgr=None, hod=None, dept="ZZLX Sales"):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, hod_id, confirmation_date) VALUES "
                      "(?,?, 'x', 'user', ?,?,?,?, 'ZZLX Officer', ?,?,?, '2020-01-01')",
                      (eid.lower(), "ZZ LX " + eid.split("-")[1], eid, BG, CO, dept, str(grade), mgr, hod)).lastrowid


SK = {}
with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    TODAY = a._today_myt()
    D = lambda n: (TODAY + timedelta(days=n)).isoformat()   # noqa: E731
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    for num, title, levels in ((1, "ZZLX Pricing", (3, 4, 5)), (2, "ZZLX Negotiation", (3, 4)),
                               (3, "ZZLX Stakeholders", (3, 4))):
        for lv in levels:
            SK[(num, lv)] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, "
                                       "proficiency_description, active) VALUES (?,?,?, 'tsc', 'ZZLX Cat', ?, 1)",
                                       ("ZZLX-AAA-%d%03d-1.0" % (lv, num), title, lv, "%s at L%d" % (title, lv))).lastrowid
    K1, K2, K3 = "ZZLX-AAA-001", "ZZLX-AAA-002", "ZZLX-AAA-003"
    HOD = person(db, "ZZ9LX-HOD", 20)
    MGR = person(db, "ZZ9LX-MGR", 17, hod=HOD)
    E1 = person(db, "ZZ9LX-E1", 15, MGR, HOD)      # came both days, rated it; a plan on Pricing and Stakeholders
    E2 = person(db, "ZZ9LX-E2", 15, MGR, HOD)      # came one day of two
    E3 = person(db, "ZZ9LX-E3", 15, MGR, HOD)      # absent
    E4 = person(db, "ZZ9LX-E4", 15, MGR, HOD)      # registers now: the level they start from
    E5 = person(db, "ZZ9LX-E5", 15, None, None, dept="ZZLX Other")   # walk-in, nobody's
    cyc = db.execute("SELECT id FROM cycles ORDER BY id DESC LIMIT 1").fetchone()[0]

    def plan(uid, goals):
        pid = db.execute("INSERT INTO pm_idp(plan_year, subject_id, status) VALUES (?, ?, 'shared')",
                         (TODAY.year, uid)).lastrowid
        out = []
        for i, (num, req, have) in enumerate(goals):
            out.append(db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, skill_id, required_level, have_level, "
                                  "gap_kind) VALUES (?,?,?,?,?,?, 'current')",
                                  (pid, i + 1, "ZZLX goal %d" % num, SK[(num, req)], req, have)).lastrowid)
        return out
    plan(E1, [(1, 4, 3), (3, 4, None)])
    G4 = plan(E4, [(1, 4, 3)])[0]
    # E4's latest assessment: they demonstrated Pricing at L4 already (the assessment wins over the goal's "have")
    asg = db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future) VALUES (?,?,?,0)",
                     (cyc, E4, SK[(1, 4)])).lastrowid
    ass = db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?, 'submitted')",
                     (cyc, E4)).lastrowid
    db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer) VALUES (?,?, 'yes')", (ass, asg))
    P = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, hrdc_claimable) VALUES "
                   "('ZZLX Negotiation for Margin', 'inhouse', 'published', 14, 2, 1)").lastrowid
    db.execute("INSERT INTO lms_programme_competencies(programme_id, comp_key, level, confirmed) VALUES (?,?,4,1)",
               (P, K1))
    S_PAST = db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, venue) VALUES "
                        "(?, 'Run 1', ?, ?, 'ZZLX Room')", (P, D(-10), D(-9))).lastrowid
    S_NEXT = db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, venue, reg_cutoff) VALUES "
                        "(?, 'Run 2', ?, ?, 'ZZLX Room', ?)", (P, D(45), D(46), D(40))).lastrowid
    R = {}
    for uid in (E1, E2, E3):
        R[uid] = db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, "
                            "hrdc_claimable) VALUES (?,?,?, 'approved', '[]', 1)", (uid, S_PAST, P)).lastrowid
    for uid, days in ((E1, (D(-10), D(-9))), (E2, (D(-10),))):
        for d_ in days:
            db.execute("INSERT INTO lms_attendance(session_id, on_date, user_id, method) VALUES (?,?,?, 'qr')",
                       (S_PAST, d_, uid))
    db.commit()


def post(c, url, data, **kw):
    d = {"csrf_token": "tok"}
    d.update(data)
    return c.post(url, data=d, **kw)


def one(sql, args=()):
    return H.one(a, sql, args)


def xp_sql(uid):
    """An independent count of the same rule: 10 per credited hour, rounded, on requests they came to; 10 a rating."""
    hrs = one("SELECT COALESCE(SUM(CAST(ROUND(10 * hours) AS INTEGER)), 0) FROM lms_registrations WHERE user_id=? AND "
              "status='approved' AND outcome IN ('attended','partial')", (uid,))
    rt = one("SELECT COUNT(*) FROM lms_ratings x JOIN lms_registrations r ON r.id=x.registration_id WHERE r.user_id=?",
             (uid,))
    return hrs + 10 * rt


def xp_of(uid):
    with a.app.test_request_context():
        return a.lms_xp(a.get_db(), [uid])[uid]


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


try:
    s.section("dark without ONEHR_LMS")
    env(None)
    C1 = H.client_as(a, E1)
    s.check("the Progress tab is a 404", C1.get("/learning/panel?tab=progress").status_code == 404)
    s.check("...and the XP row isn't in the user-role rows", "lms.xp" not in [m[0] for m in a.urole_modules_shown()])
    env("1")

    s.section("XP from the records")
    with a.app.test_request_context():
        ok, msg = a.lms_close_session(a.get_db(), SU, S_PAST)
    s.check("L&D closes the session", ok, msg)
    s.check("before any rating: E1 came both days, 14 h -> 140 XP", xp_of(E1)["total"] == 140 == xp_sql(E1),
            (xp_of(E1)["total"], xp_sql(E1)))
    r = post(C1, "/learning/rate/%d" % R[E1], {"relevant": 5, "clear": 4, "apply": 5, "overall": 5})
    s.check("E1 rates it", r.status_code in (302, 303) and one("SELECT COUNT(*) FROM lms_ratings WHERE registration_id=?",
                                                                  (R[E1],)) == 1)
    x1 = xp_of(E1)
    s.check("...+10 for the rating: 150, as an independent count", x1["total"] == 150 == xp_sql(E1), x1["total"])
    s.check("...one row for the programme: 14 h and the rating", len(x1["rows"]) == 1 and x1["rows"][0]["xp"] == 150 and
            [w for w, _x in x1["rows"][0]["parts"]] == ["14 h", "rating"], x1["rows"])
    s.check("E2 came one day of two: 7 h -> 70", xp_of(E2)["total"] == 70 == xp_sql(E2), xp_of(E2)["total"])
    s.check("E3 was absent: nothing", xp_of(E3)["total"] == 0 == xp_sql(E3) and xp_of(E3)["rows"] == [])
    post(C1, "/learning/rate/%d" % R[E1], {"relevant": 5, "clear": 5, "apply": 5, "overall": 5})
    s.check("rating twice is refused and adds nothing", one("SELECT COUNT(*) FROM lms_ratings WHERE registration_id=?",
                                                            (R[E1],)) == 1 and xp_of(E1)["total"] == 150)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM lms_attendance WHERE session_id=? AND user_id=? AND on_date=?", (S_PAST, E1, D(-9)))
        db.commit()
    with a.app.test_request_context():
        a.lms_close_session(a.get_db(), SU, S_PAST)
    s.check("closing again recounts it: one day now -> 70 + 10", xp_of(E1)["total"] == 80 == xp_sql(E1),
            xp_of(E1)["total"])
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO lms_attendance(session_id, on_date, user_id, method) VALUES (?,?,?, 'qr')",
                   (S_PAST, D(-9), E1))
        db.commit()
    with a.app.test_request_context():
        a.lms_close_session(a.get_db(), SU, S_PAST)
    s.check("...and back to 150 when the day is put back", xp_of(E1)["total"] == 150)
    writes = [r_.rule for r_ in a.app.url_map.iter_rules() if "xp" in r_.rule.lower() and "POST" in (r_.methods or ())]
    s.check("no route writes XP", writes == [], writes)
    s.check("there's no XP table to write to (it is computed)",
            one("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE '%xp%'") == 0)

    s.section("levels")
    L = a.lms_xp_level
    s.check("0: Level 1, Explorer", (L(0)["level"], L(0)["name"]) == (1, "Explorer"))
    s.check("150: Level 2, Learner, 100 to Level 3", (L(150)["level"], L(150)["name"], L(150)["to_next"], L(150)["next"])
            == (2, "Learner", 100, 3))
    s.check("340: Practitioner, 160 to Level 4, Contributor (board 4C)",
            (L(340)["name"], L(340)["to_next"], L(340)["next_name"]) == ("Practitioner", 160, "Contributor"))
    s.check("4000 and over: Level 10, Master, nothing to go", (L(4500)["level"], L(4500)["name"], L(4500)["to_next"],
                                                               L(4500)["next"]) == (10, "Master", 0, None))
    lad = [x["name"] if x else None for x in L(340)["ladder"]]
    s.check("the ladder: the first, theirs and either side, a gap, the last", lad ==
            ["Explorer", "Learner", "Practitioner", "Contributor", "Specialist", None, "Master"], lad)

    s.section("the Progress tab")
    r = C1.get("/learning/panel?tab=progress")
    html = r.get_json()["html"] if r.status_code == 200 else ""
    s.check("it renders", r.status_code == 200 and "lm-xp" in html, r.status_code)
    s.check("...Level 2, Learner, 150 XP, 100 to Level 3", "Level 2, Learner" in html and "150 XP" in html and
            "100 to Level 3, Practitioner" in html)
    s.check("...how it was earned: the programme, its hours and the rating", "ZZLX Negotiation for Margin · 14 h · rating"
            in html and "+150" in html)
    s.check("...Pricing in progress (the programme builds it), Stakeholders still to start",
            re.search(r'is-progress"><span class="lm-medal" aria-hidden="true">L4</span><span>ZZLX Pricing', html) and
            re.search(r'is-todo"><span class="lm-medal" aria-hidden="true">L4</span><span>ZZLX Stakeholders', html), html[-1500:])
    s.check("...their hours this year, HRDC-claimable", "14 h this year · 14 h HRDC-claimable" in html)
    s.check("...their department's hours per head", "of learning per head" in html)
    per = one("SELECT ROUND(COALESCE(SUM(r.hours), 0) * 1.0 / (SELECT COUNT(*) FROM users WHERE department='ZZLX Sales' "
              "AND company=? AND left_at IS NULL AND role!='admin'), 1) FROM lms_registrations r JOIN users u ON "
              "u.id=r.user_id WHERE u.department='ZZLX Sales' AND u.company=?", (CO, CO))
    s.check("...the per-head figure matches an independent count", ("%g h of learning per head" % per) in html, per)
    s.check("...who sees it, and that it is never in a rating", "Seen by you and your line manager" in html and
            "never part of your performance or potential rating" in html)
    s.check("the tab is offered", 'data-lm-tab="progress"' in C1.get("/learning/panel?tab=plan").get_json()["html"])
    mine = C1.get("/learning").get_data(as_text=True)
    s.check("Mine's Progress tab: the Level 2 tile and the XP card", 'data-tab="progress"' in mine and
            re.search(r'id="ln-panel-progress".*?Level 2', mine, re.S) is not None)
    s.check("the dashboard opens the Learning panel on ?tab=", 'openPanel("learning", q.get("tab"), null)' in
            open(os.path.join(REPO, "static", "dashboard.js")).read())

    s.section("the line manager's Team view; the HOD's Dept view")
    CM = H.client_as(a, MGR)
    team = CM.get("/learning?view=team").get_data(as_text=True)
    s.check("the Team view lists each one's XP", "Your team's learning XP" in team and "ZZ LX E1" in team and
            "2 · Learner" in team)
    order = [m.group(1) for m in re.finditer(r"<tr><td>(ZZ LX E\d)</td><td>\d+ · ", team)]
    s.check("...in name order, not ranked by XP", order == sorted(order) and len(order) == 4, order)
    s.check("...and says it isn't a ranking", "it isn't a ranking" in team)
    CH = H.client_as(a, HOD)
    dept = CH.get("/learning?view=dept").get_data(as_text=True)
    s.check("the HOD's Dept view has no XP table", "learning XP" not in dept)

    s.section("the user role: XP, level and badges")
    s.check("a row under AI+ Learning", "lms.xp" in a.UROLE_MODULE_KEYS and a.UROLE_PARENT.get("lms.xp") == "lms"
            and "lms.xp" in [m[0] for m in a.urole_modules_shown()])
    s.check("on for Full and Basic by default", "lms.xp" in a.UROLE_DEFAULTS["full"] and "lms.xp" in a.UROLE_DEFAULTS["basic"])
    s.check("seeded once onto every role that has Learning", one("SELECT COUNT(*) FROM app_settings WHERE "
                                                                  "key='user_roles_seeded_lms_subs'") == 1 and
            one("SELECT COUNT(*) FROM user_role_modules m WHERE m.module='lms' AND NOT EXISTS (SELECT 1 FROM "
                "user_role_modules x WHERE x.role_id=m.role_id AND x.module='lms.xp')") == 0)
    SUC = H.client_as(a, SU["id"])
    roles = SUC.get("/admin/roles?tab=user").get_data(as_text=True)
    s.check("the matrix indents it, 'counts only with AI+ Learning on'",
            re.search(r'rl-urow is-sub"[^>]*data-umod="lms.xp"', roles) and "counts only with AI+ Learning on" in roles)
    with a.app.app_context():
        db = a.get_db()
        rr = db.execute("INSERT INTO user_roles(name) VALUES ('ZZLX no XP')").lastrowid
        db.executemany("INSERT INTO user_role_modules(role_id, module) VALUES (?,?)",
                       [(rr, m_) for m_ in ("idp", "lms", "results")])
        db.execute("UPDATE users SET user_role_id=? WHERE id=?", (rr, E1))
        db.commit()
    C1 = H.client_as(a, E1)
    s.check("off: no Progress tab", 'data-lm-tab="progress"' not in C1.get("/learning/panel?tab=plan").get_json()["html"])
    d_ = C1.get("/learning/panel?tab=progress").get_json()
    s.check("...a typed ?tab=progress falls back to For your plan", "lm-xp" not in d_["html"] and
            'data-lm-tab="plan" aria-pressed="true"' in d_["html"])
    mine = C1.get("/learning").get_data(as_text=True)
    s.check("...no XP tile, no '+10 XP' on the rating", "ls-tile-xp" not in mine and "+10 XP" not in mine)
    team = CM.get("/learning?view=team").get_data(as_text=True)
    s.check("...and their line manager's table leaves them out", "ZZ LX E1</td>" not in team and "ZZ LX E2</td>" in team)
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO user_role_modules(role_id, module) VALUES (?, 'lms.xp')", (rr,))
        db.execute("DELETE FROM user_role_modules WHERE role_id=? AND module='lms'", (rr,))
        db.commit()
    C1 = H.client_as(a, E1)
    s.check("ticked but with AI+ Learning off it counts for nothing", (C1.get("/learning/panel?tab=progress").status_code
                                                                       in (403, 404)) or
            "lm-xp" not in (C1.get("/learning/panel?tab=progress").get_json() or {}).get("html", ""))
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET user_role_id=NULL WHERE id=?", (E1,))
        db.commit()

    s.section("the level a request starts from")
    C4 = H.client_as(a, E4)
    r = post(C4, "/learning/register", {"session": S_NEXT, "goal_id": G4})
    reg4 = (H.rows(a, "SELECT * FROM lms_registrations WHERE user_id=? AND session_id=?", (E4, S_NEXT)) or [None])[0]
    s.check("a request for a goal keeps the goal's family", reg4 is not None and reg4["pre_comp"] == K1,
            dict(reg4) if reg4 else r.status_code)
    s.check("...and the assessed level (L4), not the goal's own (L3)", reg4 is not None and reg4["pre_level"] == 4)
    with a.app.test_request_context():
        db = a.get_db()
        ok, _m, rid2 = a.lms_register(db, a._lms_user(db, E2), S_NEXT, nomination="manager", nominator=MGR)
        r2 = db.execute("SELECT pre_comp, pre_level FROM lms_registrations WHERE id=?", (rid2,)).fetchone()
    s.check("a nomination with no goal: the programme's family (no plan, no assessment: no level)",
            ok and r2["pre_comp"] == K1 and r2["pre_level"] is None, dict(r2) if r2 else None)
    with a.app.test_request_context():
        db = a.get_db()
        ok, _m = a.lms_confirm_walkin(db, SU, S_PAST, E5)
        rw = db.execute("SELECT pre_comp FROM lms_registrations WHERE user_id=? AND session_id=?", (E5, S_PAST)).fetchone()
    s.check("a walk-in L&D confirms keeps it too", ok and rw and rw["pre_comp"] == K1)
    cols = [r_[1] for r_ in a.sqlite3.connect(a.DB_PATH).execute("PRAGMA table_info(lms_registrations)")]
    s.check("the columns are on the table (and the schema text holds them)", "pre_comp" in cols and "pre_level" in cols
            and "pre_level INTEGER" in a._LMS_DDL and "pre_level INTEGER" in a.SCHEMA)
finally:
    env(_ENV0)
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
sys.exit(s.done())
