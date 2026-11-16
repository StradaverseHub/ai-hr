"""AI+ Learning: nominating, redrawn (2026-10-23, LMS canvas section 18, boards 18A and 18B; Chris: "go ahead with
section 19, then 18"). Today's bare form (who and a session) becomes the runs that fit a line manager's team; an HOD's
round lists first the people each run builds a need for and folds the rest under a search.

What this suite holds:
  * the line manager's runs: each open run with whom in the team it fits (a shared Career Plan goal or an assessed gap
    its competencies build), seats left, who already has a place; the best-fitting run first and picked
  * a draft Career Plan is the person's own: it never makes a fit, here or in a round (lms_person_needs shared_only)
  * the pick list: those it fits, then those it's open to, then outside its audience (allowed with a reason), then those
    already on it (not tickable); nominating several at once, the line manager's own step given; outside the audience
    refused without a reason, taken with one
  * the opening line says where to start, worked out in code
  * the HOD's round: suggested first with why, the rest folded with a search; a draft plan doesn't suggest
Everything here is synthetic (ZZLN / ZZ9LN-) and removed at the end.
"""
import html
import json
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: nominating, redrawn")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG, CO, OBG = "ZZLN Group", "ZZLN U1", "ZZLN Other"
_ENV0 = os.environ.get("ONEHR_LMS")
TODAY = a._today_myt()


def D(n):
    return (TODAY + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LN-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLN %'")
    db.execute("DELETE FROM lms_rounds WHERE title LIKE 'ZZLN %'")
    if ul:
        ph = ",".join("?" * len(ul))
        for t in ("lms_registrations", "lms_coach_chat", "email_outbox", "lms_sent"):
            db.execute("DELETE FROM %s WHERE user_id IN (%s)" % (t, ph), ul)
        db.execute("DELETE FROM pm_idp WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZLN-%'")
    db.execute("DELETE FROM org_units WHERE business_group IN (?, ?)", (BG, OBG))
    db.commit()


def person(db, eid, mgr=None, hod=None, bg=BG, co=CO):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, hod_id, confirmation_date, email) VALUES "
                      "(?,?, 'x', 'user', ?,?,?, 'ZZLN Sales', 'ZZLN Officer', '15', ?, ?, '2020-01-01', ?)",
                      (eid.lower(), "ZZ LN " + eid.split("-")[1], eid, bg, co, mgr, hod,
                       eid.lower() + "@zzln.invalid")).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZLN O1')", (OBG,))
    SK = {lv: db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, "
                         "proficiency_description, active) VALUES (?, 'ZZLN Negotiation', ?, 'tsc', 'ZZLN', ?, 1)",
                         ("ZZLN-NEG-%d001-1.0" % lv, lv, "ZZLN Negotiation at L%d." % lv)).lastrowid for lv in (2, 3)}
    K = "ZZLN-NEG-001"
    HOD = person(db, "ZZ9LN-HOD")
    MGR = person(db, "ZZ9LN-MGR", hod=HOD)
    E1, E2, E3, E5 = (person(db, "ZZ9LN-E%d" % i, MGR, HOD) for i in (1, 2, 3, 5))
    E4 = person(db, "ZZ9LN-E4", MGR, HOD, bg=OBG, co="ZZLN O1")
    for uid, st in ((E1, "shared"), (E2, "draft")):
        idp = db.execute("INSERT INTO pm_idp(plan_year, subject_id, status) VALUES (2027, ?, ?)", (uid, st)).lastrowid
        db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, skill_id, required_level, have_level) VALUES "
                   "(?, 1, 'ZZLN negotiation goal', ?, 3, 2)", (idp, SK[3]))
    aud = json.dumps({"grade_min": None, "grade_max": None, "bgs": [BG], "companies": []})
    P = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, audience_json) VALUES "
                   "('ZZLN Negotiation for Margin', 'inhouse', 'published', 7, 1, ?)", (aud,)).lastrowid
    db.execute("INSERT INTO lms_programme_competencies(programme_id, comp_key, level, confirmed) VALUES (?,?,3,1)",
               (P, K))
    P2 = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days) VALUES "
                    "('ZZLN Excel Basics', 'inhouse', 'published', 7, 1)").lastrowid
    S = db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, start_time, end_time, venue, seats) "
                   "VALUES (?,?,?, '09:00', '17:00', 'ZZLN Room', 6)", (P, D(40), D(40))).lastrowid
    S2 = db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, start_time, end_time, venue, seats) "
                    "VALUES (?,?,?, '09:00', '17:00', 'ZZLN Room', 6)", (P2, D(35), D(35))).lastrowid
    db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json) VALUES "
               "(?,?,?, 'approved', '[]')", (E3, S, P))
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def u_(uid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def call(fn, *args, **kw):
    with a.app.test_request_context():
        return fn(a.get_db(), *args, **kw)


def body(r):
    return html.unescape(r.get_data(as_text=True))


try:
    os.environ["ONEHR_LMS"] = "1"
    CM, CH = H.client_as(a, MGR), H.client_as(a, HOD)
    team = [u_(x) for x in (E1, E2, E3, E4, E5)]

    s.section("a draft plan is the person's own")
    with a.app.app_context():
        d0 = a.get_db()
        s.check("their own needs read their draft", any(n["key"] == K for n in a.lms_person_needs(d0, u_(E2))))
        s.check("...someone else's view doesn't", not any(n["key"] == K for n in
                                                           a.lms_person_needs(d0, u_(E2), shared_only=True)))
        s.check("...a shared plan reads for both", any(n["key"] == K for n in
                                                       a.lms_person_needs(d0, u_(E1), shared_only=True)))

    s.section("the line manager's runs")
    nom = call(a.lms_team_runs, u_(MGR), team)
    ours = [r for r in nom["runs"] if r["s"]["id"] in (S, S2)]
    s.check("the run that fits someone comes first, and is the one picked", ours and ours[0]["s"]["id"] == S and
            nom["pick"] and nom["pick"]["s"]["id"] == S, [r["s"]["title"] for r in ours])
    run = ours[0]
    kinds = {x["id"]: x["kind"] for x in run["people"]}
    s.check("E1 fits (a shared Career Plan goal), with why", kinds[E1] == "fits" and run["fits"][0]["why"] ==
            "Career Plan goal: ZZLN Negotiation, L2 to L3", run["fits"])
    s.check("...E2's draft makes no fit: open to them", kinds[E2] == "open")
    s.check("...E3 already has a place; E4 is outside its audience", kinds[E3] == "has" and kinds[E4] == "outside")
    s.check("...seats left counted", run["left"] == 5)
    order = [x["kind"] for x in run["people"]]
    s.check("the pick list: fits, open, outside, then those on it", order == sorted(
        order, key=lambda k: {"fits": 0, "open": 1, "outside": 2, "has": 3}[k]), order)
    pg = body(CM.get("/learning?view=team&tab=plans"))
    s.check("Team › Their learning: the runs that fit your team", "Runs that fit your team" in pg and
            "Fits 1 in your team" in pg and "Career Plan goal: ZZLN Negotiation, L2 to L3" in pg and "5 left of 6" in pg)
    s.check("...who has a place, and Details / Nominate on each", "ZZ LN E3 has a place or a request." in pg and
            "Nominate…" in pg)
    s.check("...the pick list for the best fit, those on it not tickable", "Nominate for ZZLN Negotiation for Margin" in pg
            and 'value="%d:%d" disabled' % (S, E3) in pg and "Outside audience" in pg)
    s.check("...E2's draft goal never shows", "ZZ LN E2" in pg and pg.count("Career Plan goal: ZZLN Negotiation") == 2,
            pg.count("Career Plan goal: ZZLN Negotiation"))
    pg2 = body(CM.get("/learning?view=team&tab=plans&nom=%d" % S2))
    s.check("another run's Nominate… picks it", "Nominate for ZZLN Excel Basics" in pg2)
    s.check("the opening says where to start", "ZZLN Negotiation for Margin fits one person and still has seats" in
            a._lms_nom_opening(nom), a._lms_nom_opening(nom))

    s.section("nominating from it")
    r = CM.post("/learning/nominate", data={"csrf_token": "tok", "pick": ["%d:%d" % (S, E1), "%d:%d" % (S, E5)],
                                            "why": "ZZLN: both quote for the dealer tenders"})
    s.check("two at once, the line manager's step given", one(
        "SELECT COUNT(*) FROM lms_registrations WHERE session_id=? AND user_id IN (?,?) AND nomination='manager'",
        (S, E1, E5)) == 2)
    CM.post("/learning/nominate", data={"csrf_token": "tok", "pick": "%d:%d" % (S, E4), "why": ""})
    s.check("outside the audience without a reason: refused", not one(
        "SELECT COUNT(*) FROM lms_registrations WHERE session_id=? AND user_id=?", (S, E4)))
    CM.post("/learning/nominate", data={"csrf_token": "tok", "pick": "%d:%d" % (S, E4),
                                        "why": "ZZLN: runs the other group's dealer desk"})
    s.check("...with one: taken, marked outside its audience", one(
        "SELECT off_audience FROM lms_registrations WHERE session_id=? AND user_id=?", (S, E4)) == 1)

    s.section("the HOD's round")
    with a.app.app_context():
        d0 = a.get_db()
        RD = d0.execute("INSERT INTO lms_rounds(title, closes_on) VALUES ('ZZLN Q1 round', ?)", (D(10),)).lastrowid
        d0.execute("INSERT INTO lms_round_sessions(round_id, session_id) VALUES (?,?)", (RD, S2))
        d0.execute("INSERT INTO lms_round_sessions(round_id, session_id) VALUES (?,?)", (RD, S))
        d0.commit()
    rounds = [rd for rd in call(a.lms_rounds_for_hod, u_(HOD)) if rd["r"]["id"] == RD]
    x = [x for x in rounds[0]["sessions"] if x["s"]["id"] == S][0]
    s.check("a run's suggested: who it builds a need for, with why", [p["id"] for p in x["fits"]] == [E1] and
            x["fits"][0]["why"] == "Career Plan goal: ZZLN Negotiation, L2 to L3")
    s.check("...a draft plan doesn't suggest", E2 in [p["id"] for p in x["rest"]])
    pg = body(CH.get("/learning?view=dept&tab=dept"))
    s.check("Dept: each run folds, suggested first, the rest under a search", "ZZLN Q1 round" in pg and
            "Suggested · 1 it builds a need for" in pg and "Find someone else in your department" in pg and
            "data-filter-list" in pg)
finally:
    if _ENV0 is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = _ENV0
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
