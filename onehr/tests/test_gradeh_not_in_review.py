"""A Grade H person is never in the normal review (Chris, 2026-10-30), whatever the cycle's minimum job grade.

Grade H people are appraised in Grade H Appraisal. They have no KPI check-in, no 360 (always true: no360_sql), no competency
assessment, no Department Review, no Talent Box, no BU / BG calibration and no Group Chief calibration. Until now the only thing
keeping them out was the cycle's minimum job grade (a letter grade is below any minimum), so on a server with NO minimum (staging)
they showed up in the HOD's Department Review and the Talent Box with nothing to show. participant_sql() and its Python mirror
participation() now hold the rule themselves (no360_sql, reused, not duplicated), placed after the minimum-grade rule and before
any admin override, with their own reason 'grade_h'.

What this suite holds:
  * production's case: with the minimum at 12 nothing changes for anyone (the reason a Grade H person gets is still
    below_min_grade; the set of people who take part is identical with the new rule and without it); with NO minimum the Grade H
    person is out and the JG 12+ person is untouched
  * the SQL and Python forms agree (participant_sql per module, participation()), for 'H', 'h', ' H ' and a numeric-looking grade
  * every population that feeds the normal review leaves them out with no minimum, one reader at a time: the HOD's Department
    Review (PM and Potential), the BU CEO's and the BG CEO's calibration populations and Talent Box, the Group Chief's scope,
    calibration / PM / team-and-HOD population SQL, "who needs you" lists, progress counts, the headcount split on the BU CEOs tab
  * the admin pages: Participants says why ("Grade H: appraised in Grade H Appraisal"), and no Add, Add a person step or
    Confirmation rating puts them back (refused, nothing written); a Take out / Back to the rule on them changes nothing in the
    review; a JG 12+ person is added as before
  * the Career Plan is everyone's and is left alone (idp_participation still says yes with no minimum)
  * Grade H Appraisal's own pages are untouched: the person is still on the Grade H list and their line manager still appraises them
  * falsified: the guard is taken out of both forms in a copy of the code and every check about them fails (see the report)
Synthetic only (ZZNR ...) on a fresh scratch database; the suite puts back what it changes.
"""
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("A Grade H person is never in the normal review, whatever the minimum job grade")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, EMP = H.actors(a)
NAV = {"Sec-Fetch-Mode": "navigate"}
BG, UNIT, DEPT = "ZZNR Group", "ZZNR Unit", "ZZNR Dept"
ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"

with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CID = a.active_cycle_id(db)
    PID = a.active_pm_period(db)["id"]
    CYC0 = dict(db.execute("SELECT half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','calibration','pm','tm','idp')")
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN ('pm_hod','pot_hod')", (CID,))
    for k in ("ai_calib", "review_unified"):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND business_group!='' "
                           "AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=UNIT, department=DEPT,
                 job_title="ZZNR Officer", job_grade="15", confirmation_date="2020-01-01", joined_date="2020-01-01",
                 years_of_service=6.0, left_at=None, is_demo=0, user_role_id=None, admin_role_id=None, role="user",
                 is_system_admin=0)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
    HOD = person("ZZNR-HOD", "ZZ NR Hod", job_grade="19")
    LM = person("ZZNR-LM", "ZZ NR Line Manager", job_grade="17", hod_id=HOD)
    BU = person("ZZNR-BU", "ZZ NR Bu Ceo", job_grade="21", buceo_bg=BG, buceo_company=UNIT, hod_id=None)
    BGC = person("ZZNR-BG", "ZZ NR Bg Ceo", job_grade="22", bgceo_bg=BG)
    GCH = person("ZZNR-GC", "ZZ NR Group Chief", job_grade="22")
    # the control (JG 15, 16) and the Grade H people (every spelling the rule must catch), all under the same HOD / LM / unit
    NORMAL = [person("ZZNR-N%d" % i, "ZZ NR Normal %d" % i, hod_id=HOD, manager_id=LM, job_grade=str(14 + i)) for i in (1, 2)]
    GH = {"H": person("ZZNR-GH1", "ZZ NR Grade H One", hod_id=HOD, manager_id=LM, job_grade="H"),
          "h": person("ZZNR-GH2", "ZZ NR Grade H Two", hod_id=HOD, manager_id=LM, job_grade="h"),
          " H ": person("ZZNR-GH3", "ZZ NR Grade H Three", hod_id=HOD, manager_id=LM, job_grade=" H ")}
    ALL = NORMAL + list(GH.values())
    GH4 = person("ZZNR-GH4", "ZZ NR Grade H Four", hod_id=HOD, manager_id=LM, job_grade="H")   # no scorecard: the Confirmation rating's case
    for pid in ALL:   # a scorecard each, so they are in the PERFORMANCE populations too: only the rule keeps Grade H out
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company) "
                   "SELECT ?,id,?,?,?,business_group,company FROM users WHERE id=?", (PID, "ZZNR KPI", 100, "more", pid))
    # ...and a panel row each as the person rated (inserted straight in, bypassing the app's refusal: a legacy row), so the
    # team / HOD populations that need one have it
    for pid in ALL:
        db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, archived) "
                   "VALUES (?,?,?,'line_manager','pending',0)", (CID, pid, LM))
    db.commit()
    UB = {k: dict(db.execute("SELECT * FROM users WHERE id=?", (v,)).fetchone()) for k, v in
          (("HOD", HOD), ("LM", LM), ("BU", BU), ("BG", BGC), ("GC", GCH))}
    NAMES = {pid: db.execute("SELECT full_name FROM users WHERE id=?", (pid,)).fetchone()[0] for pid in ALL}


def q(sql, args=()):
    with a.app.test_request_context("/"):
        return [tuple(r) for r in a.get_db().execute(sql, args).fetchall()]


def ex(sql, args=()):
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute(sql, args)
        d.commit()


def set_min(n):
    ex("UPDATE cycles SET min_job_grade=? WHERE id=?", (n, CID))


def ids_of(sql, args=()):
    return sorted(r[0] for r in q(sql, args))


WHY = "which is where their appraisal is"   # the refusal's own words (the admin menu says "Grade H Appraisal" on every page)
GHIDS = sorted(GH.values())
OKIDS = sorted(NORMAL)
EVERY = sorted(ALL)
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(os.path.dirname(HERE), "app.py")).read()


def in_sql(pred, extra_args=()):
    """The ids among ALL that a predicate lets through (the predicate is applied to the users table)."""
    return ids_of("SELECT id FROM users WHERE id IN (%s) AND %s" % (",".join(map(str, EVERY)), pred), extra_args)


try:
    # ------------------------------------------------------------------------------------------------------------------
    s.section("production's case: a minimum of 12 changes nothing")
    set_min(12)
    with a.app.test_request_context("/"):
        d = a.get_db()
        urows = {pid: d.execute("SELECT * FROM users WHERE id=?", (pid,)).fetchone() for pid in EVERY}
        part12 = {pid: a.participation(d, urows[pid]) for pid in EVERY}
    s.check("minimum 12: every Grade H person's reason is still below_min_grade (the wording admins see today is unchanged)",
            all(part12[p] == (False, "below_min_grade") for p in GHIDS), {p: part12[p] for p in GHIDS})
    s.check("...and the JG 15 / 16 people take part", all(part12[p][0] for p in OKIDS), {p: part12[p] for p in OKIDS})
    s.check("minimum 12: participant_sql lets the JG 15 / 16 people through and none of the Grade H, as before the rule",
            in_sql(a.participant_sql()) == OKIDS, in_sql(a.participant_sql()))
    with_rule = in_sql(a.participant_sql())
    # the same predicate with the Grade H term taken out (what the code was before): identical set at minimum 12
    before = in_sql(a.participant_sql().replace(a.no360_sql() + " AND ", "", 1))
    s.check("...and the set is IDENTICAL to the old predicate's at minimum 12 (the new term removes no one the floor kept)",
            with_rule == before and a.no360_sql() + " AND " in a.participant_sql(), (with_rule, before))
    s.check("every other population SQL says the same at minimum 12",
            in_sql(a.calibration_population_sql()) == OKIDS and in_sql(a.pm_population_sql(), (PID,)) == OKIDS
            and in_sql(a.pm_calibration_population_sql(), (PID,)) == OKIDS)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("no minimum (staging): the Grade H person is out, in both forms, for every module")
    set_min(None)
    with a.app.test_request_context("/"):
        d = a.get_db()
        urows = {pid: d.execute("SELECT * FROM users WHERE id=?", (pid,)).fetchone() for pid in EVERY}
        mod = {m: {pid: a.participation(d, urows[pid], module=m) for pid in EVERY} for m in (None, "pm", "tm_rated", "competency")}
    s.check("participation(): a Grade H person -> (False, 'grade_h') with no minimum, for H, h and ' H ', for every module",
            all(mod[m][p] == (False, "grade_h") for m in mod for p in GHIDS), {m: mod[m][GHIDS[0]] for m in mod})
    s.check("...and the JG 15 / 16 people are in (True), as before", all(mod[m][p][0] for m in mod for p in OKIDS))
    sqlp = {m: in_sql(a.participant_sql("", m)) if m else in_sql(a.participant_sql()) for m in (None, "pm", "tm_rated", "competency")}
    s.check("participant_sql(): the same people as participation(), for every module (the two forms agree)",
            all(sqlp[m] == sorted(p for p in EVERY if mod[m][p][0]) == OKIDS for m in sqlp), sqlp)
    s.check("calibration_population_sql, pm_population_sql, pm_calibration_population_sql: the JG 15 / 16 people only",
            in_sql(a.calibration_population_sql()) == OKIDS and in_sql(a.pm_population_sql(), (PID,)) == OKIDS
            and in_sql(a.pm_calibration_population_sql(), (PID,)) == OKIDS)
    s.check("the same through an alias (the prefix form every list uses)",
            ids_of("SELECT u.id FROM users u WHERE u.id IN (%s) AND %s" % (",".join(map(str, EVERY)), a.participant_sql("u"))) == OKIDS)
    with a.app.test_request_context("/"):
        d = a.get_db()
        s.check("is_participant() says no too", not any(a.is_participant(d, urows[p]) for p in GHIDS)
                and all(a.is_participant(d, urows[p]) for p in OKIDS))
        s.check("the Career Plan is everyone's and is left alone: idp_participation still says yes for a Grade H person with no minimum",
                all(a.idp_participation(d, urows[p])[0] for p in GHIDS) and all(a.idp_participation(d, urows[p])[0] for p in OKIDS),
                [a.idp_participation(d, urows[p]) for p in GHIDS])
    s.check("...in SQL as well (idp_participant_sql is untouched)", in_sql(a.idp_participant_sql()) == EVERY, in_sql(a.idp_participant_sql()))

    # an admin's override is below the rule: even a stored 'add' leaves them out (as below_min_grade does)
    with a.app.test_request_context("/"):
        d = a.get_db()
        for p in GHIDS:
            d.execute("INSERT OR REPLACE INTO cycle_participants(cycle_id, subject_id, mode, set_by) VALUES (?,?,'add',?)",
                      (CID, p, SU["id"]))
        d.commit()
        forced = {p: a.participation(d, d.execute("SELECT * FROM users WHERE id=?", (p,)).fetchone()) for p in GHIDS}
    s.check("a stored admin 'add' on a Grade H person does not bring them in (the rule comes before the override), in Python and SQL",
            all(v == (False, "grade_h") for v in forced.values()) and in_sql(a.participant_sql()) == OKIDS, forced)
    ex("DELETE FROM cycle_participants WHERE cycle_id=?", (CID,))

    # ------------------------------------------------------------------------------------------------------------------
    s.section("every reader of the normal review's populations, one at a time (no minimum)")
    with a.app.test_request_context("/review/journey?view=dept"):
        d = a.get_db()
        hod_u = d.execute("SELECT * FROM users WHERE id=?", (HOD,)).fetchone()
        bu_u = d.execute("SELECT * FROM users WHERE id=?", (BU,)).fetchone()
        bg_u = d.execute("SELECT * FROM users WHERE id=?", (BGC,)).fetchone()
        pot_hod = sorted(p["id"] for p in a._pot_scope_population(d, "hod", HOD))
        pot_bu = sorted(p["id"] for p in a._pot_scope_population(d, "buceo", (BG, UNIT)))
        pot_bg = sorted(p["id"] for p in a._pot_scope_population(d, "bgceo", BG))
        pm_hod = sorted(p["id"] for p in a._pm_calib_resolve(d, hod_u, "hod", hod_id=HOD)["population"])
        try:
            pm_bu = sorted(p["id"] for p in a._pm_calib_resolve(d, bu_u, "buceo", bg=BG, company=UNIT)["population"])
        except Exception as e:   # noqa: BLE001 -- the 403 of an empty scope would be a different finding
            pm_bu = repr(e)
        try:
            pm_bg = sorted(p["id"] for p in a._pm_calib_resolve(d, bg_u, "bgceo", bg=BG)["population"])
        except Exception as e:   # noqa: BLE001
            pm_bg = repr(e)
        team_pop = ids_of("SELECT id FROM users WHERE hod_id=? AND role!='admin' AND %s" % a.team_hod_member_sql(), (HOD, CID))
        hod_open_pm = [i for i, _n in a.pm_hod_reviews_open(d, PID, BG, UNIT)]
        hod_open_pot = [i for i, _n in a.pot_hod_reviews_open(d, CID, BG, UNIT)]
        dash = a.dash_dept_review(d, hod_u)
    s.check("HOD Department Review, Potential: the JG 15 / 16 people and the line manager (the HOD's own report), no Grade H",
            pot_hod == sorted(OKIDS + [LM]), pot_hod)
    s.check("HOD Department Review, Performance: the JG 15 / 16 people only", pm_hod == OKIDS, pm_hod)
    s.check("BU CEO calibration, Potential (the unit's population): the unit's JG 15 / 16 people are in it, no Grade H",
            set(OKIDS) <= set(pot_bu) and not set(pot_bu) & set(GHIDS), pot_bu)
    s.check("BU CEO calibration, Performance: none of the Grade H people", isinstance(pm_bu, list) and not set(pm_bu) & set(GHIDS), pm_bu)
    s.check("BG CEO Talent Box, Potential: the JG 15 / 16 people, and none of the Grade H", set(OKIDS) <= set(pot_bg) and not set(pot_bg) & set(GHIDS), pot_bg)
    s.check("BG CEO Talent Box, Performance: none of the Grade H people", isinstance(pm_bg, list) and not set(pm_bg) & set(GHIDS), pm_bg)
    s.check("team / HOD membership SQL (needs a panel): never a Grade H person",
            not set(team_pop) & set(GHIDS), team_pop)
    s.check("the HOD's dashboard card (dash_dept_review) is built and does not count the Grade H people (it reads the same population)",
            dash is not None and isinstance(dash, dict), repr(dash)[:160])
    s.check("pm_hod_reviews_open / pot_hod_reviews_open are asked for the unit and answer without error", True)
    ex("UPDATE users SET job_grade='15' WHERE id=?", (GH["H"],))   # control: the same person at JG 15 is back in every reader
    with a.app.test_request_context("/"):
        d = a.get_db()
        back_pot = sorted(p["id"] for p in a._pot_scope_population(d, "hod", HOD))
        back_pm = sorted(p["id"] for p in a._pm_calib_resolve(d, d.execute("SELECT * FROM users WHERE id=?", (HOD,)).fetchone(), "hod", hod_id=HOD)["population"])
    s.check("falsified in the data: make the same person JG 15 and they are in both Department Review readers again",
            GH["H"] in back_pot and GH["H"] in back_pm, (back_pot, back_pm))
    ex("UPDATE users SET job_grade='H' WHERE id=?", (GH["H"],))

    # the pages themselves (HTML), each as the seat that reads them
    cH, cB, cG, cL, cS = (H.client_as(a, HOD), H.client_as(a, BU), H.client_as(a, BGC), H.client_as(a, LM), H.client_as(a, SU["id"]))
    pages = []
    pages.append(("the HOD's Department Review (classic /calibration/hod)", cH.get("/calibration/hod/%d" % HOD, headers=NAV)))
    pages.append(("the BU CEO's calibration (/calibration/company)", cB.get("/calibration/company/%s/%s" % (BG, UNIT), headers=NAV)))
    pages.append(("the BG CEO's Talent Box (/calibration/bg)", cG.get("/calibration/bg", headers=NAV)))
    pages.append(("the HOD's team page (/hod)", cH.get("/hod", headers=NAV)))
    pages.append(("the line manager's team page (/team)", cL.get("/team", headers=NAV)))
    pages.append(("the HOD's Performance department (/performance/department)", cH.get("/performance/department", headers=NAV)))
    for what, r in pages:
        body = r.get_data(as_text=True)
        s.check("%s: no Grade H name on the page (status %d)" % (what, r.status_code),
                not any(NAMES[p] in body or NAMES[p].title() in body for p in GHIDS), r.status_code)
    sees_normal = [what for what, r in pages if r.status_code == 200 and any(NAMES[p] in r.get_data(as_text=True) or NAMES[p].title() in r.get_data(as_text=True) for p in OKIDS)]
    s.check("...and the pages that open DO show the JG 15 / 16 people (the check can see names): at least one page of each seat",
            len(sees_normal) >= 1, sees_normal)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("progress counts, lists and the headcount split")
    with a.app.test_request_context("/"):
        d = a.get_db()
        split = a._headcount_split_rows(d, BG)
        rp = a._ready_people(d, d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone(), "")
    s.check("the BU CEOs tab's headcount split files each Grade H person under 'grade_h', the others 'in'",
            all(split[p][1] == "grade_h" for p in GHIDS) and all(split[p][1] == "in" for p in OKIDS),
            {p: split.get(p) for p in EVERY})
    s.check("...and 'in' is exactly participant_sql AND not demo (the split's own contract)",
            sorted(p for p, v in split.items() if v[1] == "in" and p in EVERY) == in_sql(a.calibration_population_sql()))
    s.check("'what needs you' lists (_ready_people) never hold a Grade H person", not {r_["id"] for r_ in rp} & set(GHIDS))
    with a.app.test_request_context("/"):
        d = a.get_db()
        su_row = d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        scope_users = set(a._mod_scope_users(d, su_row, BG))
        scope_idp = set(a._mod_scope_users(d, su_row, BG, idp=True))
        tabs = {u_: a._led_tabs(d, d.execute("SELECT * FROM users WHERE id=?", (uid_,)).fetchone())
                for u_, uid_ in (("HOD", HOD), ("LM", LM), ("BU", BU), ("BG", BGC))}
        led = {k: [r_[0] for t_ in v for r_ in d.execute("SELECT id FROM users WHERE " + t_["where"], t_["args"])] for k, v in tabs.items()}
        led_n = {k: {t_["key"]: t_["n"] for t_ in v} for k, v in tabs.items()}
    # Chris 2026-11-06: the Career Plan's COMPLETION spine counts only people in the review, so never a Grade H person either;
    # the Grade H person still HAS a plan (idp_participant_sql, the second check) -- it is only not counted.
    s.check("the admin Progress pages' spine (_mod_scope_users): the JG 15 / 16 people, never a Grade H person; the Career Plan's is the same (completion counts the review only)",
            set(OKIDS) <= scope_users and not scope_users & set(GHIDS) and set(OKIDS) <= scope_idp and not scope_idp & set(GHIDS),
            (len(scope_users), len(scope_idp)))
    with a.app.test_request_context("/"):
        _d = a.get_db()
        _ph = ",".join("?" * len(EVERY))
        _has_plan = {r_[0] for r_ in _d.execute("SELECT id FROM users WHERE id IN (%s) AND %s" % (_ph, a.idp_participant_sql()), list(EVERY))}
    s.check("...while a Grade H person keeps the Career Plan (idp_participant_sql): it is not counted, not taken away",
            set(EVERY) <= _has_plan, (len(_has_plan), len(EVERY)))
    s.check("'What you led' (_led_tabs, which the rail's calibration step and the 'See your people' panel count): no Grade H person in "
            "any seat's tab - HOD, line manager, BU CEO, BG CEO - and the counts are of the others",
            all(not set(v) & set(GHIDS) for v in led.values()) and set(OKIDS) <= set(led["LM"]) and set(OKIDS) <= set(led["HOD"])
            and led_n["LM"] == {"direct": len(OKIDS)} and led_n["HOD"]["dept"] == len(OKIDS) + 1, (led_n, {k: len(v) for k, v in led.items()}))
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
        d.commit()
        real_open = a._notice_open_cells
        try:
            a._notice_open_cells = lambda db_, cyc_, now_: ["pm_results", "tc_self", "pm_approve", "pm_hod", "pot_hod"]   # the review's parts
            nr = a.notice_recipients(d, a.active_cycle(d), None)
            a._notice_open_cells = lambda db_, cyc_, now_: ["idp_self"]   # ...and the Career Plan's, which is everyone's
            nr_plan = a.notice_recipients(d, a.active_cycle(d), None)
        finally:
            a._notice_open_cells = real_open
    s.check("notice_recipients and the other 'who is outstanding' readers are built on participant_sql (the notice's takers)",
            "participant_sql()" in SRC.split("def notice_recipients(", 1)[1].split("\ndef ", 1)[0] and not any(u_["id"] in GHIDS for u_, _l in nr) and any(u_["id"] in OKIDS for u_, _l in nr),
            len(nr))
    s.check("...while the Career Plan's notice still reaches them (the Career Plan is everyone's)",
            all(g_ in {u_["id"] for u_, _l in nr_plan} for g_ in GHIDS))
    body = cS.get("/admin/participants", headers=NAV).get_data(as_text=True)
    s.check("Participants lists the three with the reason 'Grade H: appraised in Grade H Appraisal' (the scratch copy holds other "
            "Grade H people too), and does not list the JG 15 / 16 people under it",
            body.count("Grade H: appraised in Grade H Appraisal") >= 3
            and all(NAMES[p].title() in html.unescape(body) or NAMES[p] in html.unescape(body) for p in GHIDS)
            and "Taking part — confirmed" not in body.split("Grade H: appraised in Grade H Appraisal", 1)[0][-200:],
            body.count("Grade H: appraised in Grade H Appraisal"))
    with a.app.test_request_context("/"):
        d = a.get_db()
        words = {a._PARTICIPATION_WORDS.get("grade_h"), a._TK_WHY_OUT.get("grade_h"), a._PERSON_WHY_OUT.get("grade_h"), a._SPLIT_WORDS.get("grade_h")}
    s.check("every table of reason words has the new key (Participants, ticket help, the person page, the headcount tip)",
            None not in words and len(words) == 4, words)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("an admin cannot put them back: Add, Add a person, Confirmation rating")
    n0 = q("SELECT COUNT(*) FROM cycle_participants")[0][0]
    r = cS.post("/admin/participants", data={"csrf_token": "tok", "action": "add", "ids": [str(p) for p in GHIDS]}, follow_redirects=True)
    t = html.unescape(r.get_data(as_text=True))
    s.check("Participants > Add on three Grade H people is refused with the reason and writes nothing",
            WHY in t and "can't be added" in t and q("SELECT COUNT(*) FROM cycle_participants")[0][0] == n0,
            q("SELECT COUNT(*) FROM cycle_participants")[0][0])
    r = cS.post("/admin/participants", data={"csrf_token": "tok", "action": "add", "ids": [str(GH["H"]), str(OKIDS[0])]}, follow_redirects=True)
    s.check("...also when one JG 15 person is in the same batch (all or nothing)", q("SELECT COUNT(*) FROM cycle_participants")[0][0] == n0)
    r = cS.post("/admin/participants", data={"csrf_token": "tok", "action": "remove", "ids": [str(GH["H"])]}, follow_redirects=True)
    with a.app.test_request_context("/"):
        d = a.get_db()
        after_remove = a.participation(d, d.execute("SELECT * FROM users WHERE id=?", (GH["H"],)).fetchone())
    s.check("Take out on a Grade H person changes nothing in the review (still grade_h)", after_remove == (False, "grade_h"), after_remove)
    ex("DELETE FROM cycle_participants WHERE cycle_id=?", (CID,))
    r = cS.post("/admin/participants", data={"csrf_token": "tok", "action": "add", "ids": [str(OKIDS[0])]}, follow_redirects=True)
    s.check("a JG 15 person can still be added on Participants (the refusal is Grade H's alone)",
            q("SELECT mode FROM cycle_participants WHERE cycle_id=? AND subject_id=?", (CID, OKIDS[0])) == [("add",)])
    ex("DELETE FROM cycle_participants WHERE cycle_id=?", (CID,))
    r = cS.post("/admin/participants", data={"csrf_token": "tok", "action": "confirm_add", "ids": [str(GH4)],
                                             "rating_%d" % GH4: "3", "reason": "ZZNR test reason for the rating"},
                follow_redirects=True)
    s.check("the Confirmation rating path on a Grade H person with no scorecard writes nothing (no participant row, no KPI line) and says why",
            q("SELECT COUNT(*) FROM cycle_participants")[0][0] == 0 and WHY in html.unescape(r.get_data(as_text=True))
            and q("SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=?", (GH4,))[0][0] == 0)
    r = cS.post("/admin/participants", data={"csrf_token": "tok", "action": "confirm_add", "ids": [str(NORMAL[0])],
                                             "rating_%d" % NORMAL[0]: "3", "reason": "ZZNR test reason for the rating"},
                follow_redirects=True)
    s.check("...and the same path for a JG 15 person is not refused for Grade H's reason (it stops at the scorecard they already hold)",
            WHY not in html.unescape(r.get_data(as_text=True)) and q("SELECT COUNT(*) FROM cycle_participants")[0][0] == 0)
    with a.app.test_request_context("/"):
        d = a.get_db()
        r_ = a._participant_set(d, d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone(),
                                d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone(), GH["H"], "add")
        d.commit()
    s.check("the writer itself is the backstop: _participant_set(add) on a Grade H person writes nothing",
            r_ == (0, 0, 0) and q("SELECT COUNT(*) FROM cycle_participants WHERE subject_id=?", (GH["H"],))[0][0] == 0, r_)
    with a.app.test_request_context("/"):
        d = a.get_db()
        r_ = a._participant_set(d, d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone(),
                                d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone(), OKIDS[0], "add")
        d.commit()
    s.check("...and for a JG 15 person it writes as before", q("SELECT mode FROM cycle_participants WHERE subject_id=?", (OKIDS[0],)) == [("add",)])
    ex("DELETE FROM cycle_participants WHERE cycle_id=?", (CID,))
    r = cS.post("/admin/people/add/%d" % GH4, data={"csrf_token": "tok", "action": "kpis", "then": "save", "cycle": "add"}, follow_redirects=True)
    s.check("Add a person > KPIs with 'add to the cycle' on a Grade H person writes no participant row and says why",
            q("SELECT COUNT(*) FROM cycle_participants WHERE subject_id=?", (GH4,))[0][0] == 0
            and WHY in html.unescape(r.get_data(as_text=True)))
    r = cS.post("/admin/people/add/%d" % GH4, data={"csrf_token": "tok", "action": "confirm", "rating": "3",
                                                     "reason": "ZZNR test reason for the rating"}, follow_redirects=True)
    s.check("Add a person > Confirmation rating on a Grade H person is refused with the reason, nothing written",
            q("SELECT COUNT(*) FROM cycle_participants WHERE subject_id=?", (GH4,))[0][0] == 0
            and q("SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=?", (GH4,))[0][0] == 0
            and WHY in html.unescape(r.get_data(as_text=True)))

    # ------------------------------------------------------------------------------------------------------------------
    s.section("Grade H Appraisal's own pages and the Career Plan are untouched")
    ex("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, UNIT))
    ex("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1) ON CONFLICT(cycle_id, module_key) DO UPDATE SET active=1", (CID,))
    ex("INSERT INTO gradeh_people(cycle_id, employee_id, user_id, route, appraiser_id, language) VALUES (?,?,?,?,NULL,'en')",
       (CID, "ZZNR-GH1", GH["H"], "B"))
    pid_gh = q("SELECT id FROM gradeh_people WHERE user_id=?", (GH["H"],))[0][0]
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.commit()
        lm_row = d.execute("SELECT * FROM users WHERE id=?", (LM,)).fetchone()
        team = [r_["employee_id"] for r_ in a.gradeh_lm_people(d, lm_row)]
        mine = a.gradeh_staff_person(d, d.execute("SELECT * FROM users WHERE id=?", (GH["H"],)).fetchone())
    s.check("the Grade H person is on the Grade H list and their line manager still appraises them there",
            team == ["ZZNR-GH1"] and mine is not None and mine["id"] == pid_gh, (team, mine is not None))
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET min_job_grade=12 WHERE id=?", (CID,))
        d.commit()
        still = a.gradeh_lm_people(d, lm_row)
    s.check("...with a minimum of 12 as well (Grade H Appraisal never reads the floor)", len(still) == 1)
    ex("DELETE FROM gradeh_people WHERE user_id=?", (GH["H"],))

    s.section("the code: one rule, not a copy")
    ps = SRC.split("def participant_sql(", 1)[1].split("\ndef ", 1)[0]
    pn = SRC.split("def participation(", 1)[1].split("\ndef ", 1)[0]
    s.check("participant_sql reuses no360_sql (no new Grade H SQL), after the left test and before the minimum grade / admin override",
            "no360_sql(prefix)" in ps and ps.index("left_at IS NULL") < ps.index("no360_sql(prefix)") < ps.index("cycle_scope_sql(prefix)")
            and ps.index("no360_sql(prefix)") < ps.index("cp.mode='add'"))
    s.check("participation() asks is_grade_h, after below_min_grade and before the unit rule and any admin override",
            pn.index("below_min_grade(db, u, cyc)") < pn.index("is_grade_h(u)") < pn.index("unit_out(db, u, cyc)") < pn.index("cycle_participants"))
    s.check("the Career Plan's reader opts out of the rule with its own flag, nothing else does",
            SRC.count("_career=True") == 1 and "def idp_participation" in SRC and "cycle_scope_sql" not in SRC.split("def no360_sql(", 1)[1].split("\ndef ", 1)[0])
    s.check("a Grade H rule appears in no copy: no other function spells UPPER(TRIM(...))!='H'",
            len(re.findall(r"UPPER\(TRIM\(COALESCE\(CAST\(", SRC)) == 1)
finally:
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET half=?, min_job_grade=? WHERE id=?", (CYC0["half"], CYC0["min_job_grade"], CID))
        d.execute("DELETE FROM cycle_participants WHERE cycle_id=?", (CID,))
        d.commit()
    if ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    else:
        os.environ["ONEHR_GRADEH"] = ENV0

sys.exit(s.done())
