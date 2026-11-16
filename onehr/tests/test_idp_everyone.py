"""The Career Plan is everyone's (Chris, 2026-10-19: "currently we disable unconfirmed staff to be part of PM and TM ...
what about IDP? all employees should be able to get access to and fill in the IDP"; his pick: keep the JG 12 floor).

What this suite holds:
  * idp_participant_sql and idp_participation agree: active and at the cycle's minimum grade has a plan, confirmed or
    not (not confirmed, confirmed after the cycle opened, added) -- and taken out of the cycle too (Chris, 2026-11-03:
    "those not participating should all get to be 360 rater and IDP"), whether by Participants' Take out or by the
    confirmation question's "Not this cycle"; a leaver, someone below the minimum grade or in a unit the cycle leaves
    out has none. PM and TM keep participant_sql's confirmation and take-out rule.
  * a person taken out still rates colleagues on the 360 (assessor_eligible_sql, rater_task_sql, their journey's 360)
    and writes a Career Plan through its real route
  * review_state carries both flags; someone not confirmed has a Career Plan in the journey and nothing else of their
    own, and the plan is never held back for a check-in or competency that isn't theirs
  * the dashboard lists their plan (the mini-rail, the not-in-this-review card) and the review landing opens it
  * their line manager reviews it even with no KPI line between them: the Team view's IDP review appears, lists them,
    the IDP pages let the manager in (and nobody else), and the manager owns the plan's one remark
  * the counts: since Chris 2026-11-06 the admin's Career Plan progress and the leader email's Career Plan column count only
    people in the review (idp_count_sql); the plan itself stays theirs (test_idp_completion.py)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The Career Plan is everyone's")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG, CO, CO2 = "ZZIE Group", "ZZIE U1", "ZZIE U2"   # CO2: a unit the cycle leaves out


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9IE-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        for t, c in (("pm_kpi_target_approvers", "kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN "
                                                 "(%s))" % ph), ("pm_kpi_targets", "subject_id IN (%s)" % ph),
                     ("cycle_participants", "subject_id IN (%s)" % ph), ("cycle_confirm_choices", "subject_id IN (%s)" % ph),
                     ("assignments", "subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph)),
                     ("pm_idp", "subject_id IN (%s)" % ph)):
            db.execute("DELETE FROM %s WHERE %s" % (t, c), ul + (ul if t == "assignments" else []))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_career_profile WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM cycle_exclusions WHERE company=?", (CO2,))
    db.execute("DELETE FROM tc_job_profiles WHERE department='ZZIE Dept'")
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZIE-%'")
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    CYC0 = dict(db.execute("SELECT kind, half, starts_on, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
    MODS0 = {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))}
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=12, starts_on=COALESCE(starts_on, "
               "'2026-01-01') WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','pm','tm','idp')", (CID,))
    OPEN = db.execute("SELECT starts_on FROM cycles WHERE id=?", (CID,)).fetchone()[0]

    def mk(eid, confirmed=True, grade="14", mgr=None, left=False, conf_date=None, company=CO):
        return db.execute(
            "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_title, job_grade, manager_id, confirmation_date, years_of_service, left_at) "
            "VALUES (?,?,'x','user',?,?,?,'ZZIE Dept','ZZIE Officer',?,?,?,?,?)",
            (eid.lower(), "ZZ IE " + eid[-3:], eid, BG, company, grade, mgr,
             conf_date or ("2020-01-01" if confirmed else None), 4.0 if confirmed else 0.5,
             "2026-01-01" if left else None)).lastrowid
    LM = mk("ZZ9IE-LM")                                   # confirmed line manager, approves no KPI line
    UN = mk("ZZ9IE-UN", confirmed=False, mgr=LM)          # not confirmed: no KPI, no competency
    LATE = mk("ZZ9IE-LT", confirmed=False, mgr=LM, conf_date="2099-01-01")   # confirmed after the cycle opened
    CF = mk("ZZ9IE-CF", mgr=LM)                           # confirmed, taking part
    OUT = mk("ZZ9IE-OU", mgr=LM)                          # taken out by an admin
    ADD = mk("ZZ9IE-AD", confirmed=False, mgr=LM)         # not confirmed, added by an admin
    LOW = mk("ZZ9IE-LO", confirmed=False, grade="10", mgr=LM)   # below the minimum grade
    LEFT = mk("ZZ9IE-LF", confirmed=False, mgr=LM, left=True)   # a leaver
    OTHER = mk("ZZ9IE-OT")                                # someone else's manager
    TK = mk("ZZ9IE-TK", mgr=LM)                           # taken out through Participants' Take out (the real route, below)
    NC = mk("ZZ9IE-NC", confirmed=False, mgr=LM, conf_date="2026-10-20")   # "Not this cycle" when confirmed (the shared writer, below)
    OUTU = mk("ZZ9IE-UO", mgr=LM, company=CO2)            # in a unit the cycle leaves out
    db.execute("INSERT INTO cycle_exclusions(cycle_id, business_group, company, department) VALUES (?,?,?, '')", (CID, BG, CO2))
    # a KPI line set for them anyway, as an import can: it isn't theirs to check in, so it must not hold the plan back
    db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
               "rate1, rate2, rate3, rate4, rate5) VALUES (?,?, 'ZZIE Output', 100, 'more', 'approved', ?, 1,2,3,4,5)",
               (CID, UN, BG))
    db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'remove')", (CID, OUT))
    db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'add')", (CID, ADD))
    db.commit()
    SUPID = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                       "LIMIT 1").fetchone()[0]
# the two ways an admin takes someone out of the cycle, through their real writers: Participants' Take out (a post to its route)
# and the confirmation question's "Not this cycle" (_confirm_cycle_choice, the one writer the person page, Add a person and the
# roster import share)
_rt = H.client_as(a, SUPID).post("/admin/participants", data={"csrf_token": "tok", "action": "remove", "ids": [str(TK)]})
with a.app.test_request_context("/"):
    _d = a.get_db()
    _res = a._confirm_cycle_choice(_d, dict(_d.execute("SELECT * FROM users WHERE id=?", (SUPID,)).fetchone()), a.active_cycle(_d),
                                   NC, "2026-10-20", "out", "person")
    _d.commit()
ALL = {"un": UN, "late": LATE, "cf": CF, "out": OUT, "add": ADD, "low": LOW, "left": LEFT, "tk": TK, "nc": NC, "unit": OUTU}


def ctx(uid, fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        u = d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        a.g.user = u
        return fn(d, u)


try:
    s.section("who has a plan")
    with a.app.test_request_context("/"):
        d = a.get_db()
        ph = ",".join("?" * len(ALL))
        sql_idp = {r[0] for r in d.execute("SELECT id FROM users WHERE id IN (%s) AND %s" % (ph, a.idp_participant_sql()),
                                          list(ALL.values()))}
        sql_rev = {r[0] for r in d.execute("SELECT id FROM users WHERE id IN (%s) AND %s" % (ph, a.participant_sql()),
                                          list(ALL.values()))}
        py_idp = {v for v in ALL.values()
                  if a.idp_participation(d, d.execute("SELECT * FROM users WHERE id=?", (v,)).fetchone())[0]}
    s.check("fixture: Take out (the route) and Not this cycle (the writer) each wrote a take-out row",
            _rt.status_code in (200, 302) and _res[1] is None and all(H.one(
                a, "SELECT mode FROM cycle_participants WHERE cycle_id=? AND subject_id=?", (CID, x)) == "remove"
                for x in (OUT, TK, NC)))
    s.check("a plan: not confirmed, confirmed after the cycle opened, confirmed, added -- and taken out, by any of the three ways",
            sql_idp == {UN, LATE, CF, ADD, OUT, TK, NC}, sorted(k for k, v in ALL.items() if v in sql_idp))
    s.check("...none for someone below the minimum grade, gone or in a unit the cycle leaves out",
            not ({LOW, LEFT, OUTU} & sql_idp), sorted(k for k, v in ALL.items() if v in sql_idp))
    s.check("the Python mirror agrees with the SQL", py_idp == sql_idp, sorted(k for k, v in ALL.items() if v in py_idp))
    s.check("PM and TM keep the confirmation rule (only the confirmed and the added take part): a take-out has no review of its own",
            sql_rev == {CF, ADD}, sorted(k for k, v in ALL.items() if v in sql_rev))
    with a.app.test_request_context("/"):
        d = a.get_db()
        _u = lambda v: d.execute("SELECT * FROM users WHERE id=?", (v,)).fetchone()   # noqa: E731
        _part = [a.participation(d, _u(v)) for v in (OUT, TK, NC)]
        _plan = [a.idp_participation(d, _u(v)) for v in (OUT, TK, NC)]
        _ctl = [a.idp_participation(d, _u(v)) for v in (LOW, LEFT, OUTU)]
    s.check("...and the Python mirror says so: taken out is not taking part, yet has a plan (why stays 'removed')",
            _part == [(False, "removed")] * 3 and _plan == [(True, "removed")] * 3, (_part, _plan))
    s.check("...the controls keep their reasons: below the grade, a leaver, a left-out unit",
            _ctl == [(False, "below_min_grade"), (False, "left"), (False, "unit_out")], _ctl)

    s.section("the journey of someone not confirmed")
    st = ctx(UN, lambda d, u: a.review_state(d, u))
    s.check("review_state: no review of their own, a plan of their own", st["participant"] is False
            and st["idp_participant"] is True)
    parts = [x["key"] for x in a._journey_live_stages(st) if x["key"] != "feedback"]
    s.check("their journey is the Career Plan only", parts == ["career_plan"], parts)
    cp = next(x for x in a._journey_live_stages(st) if x["key"] == "career_plan")
    s.check("...open, never held for a check-in or competency that isn't theirs",
            cp["state"] == a.REVIEW_STATE_OPEN and not cp.get("locked") and not a._journey_idp_locked(st), cp)
    s.check("...so they aren't told 'not required this round'", not a._journey_not_required(st))
    for _who, _id in (("taken out (Take out)", TK), ("taken out (a direct row)", OUT), ("Not this cycle", NC)):
        st_out = ctx(_id, lambda d, u: a.review_state(d, u))
        _cp = next((x for x in a._journey_live_stages(st_out) if x["key"] == "career_plan"), {})
        s.check("someone %s has no review of their own and a Career Plan, open and never held back, in their journey" % _who,
                st_out["participant"] is False and st_out["idp_participant"] is True and _cp.get("state") == a.REVIEW_STATE_OPEN
                and not _cp.get("locked") and not a._journey_idp_locked(st_out) and not a._journey_not_required(st_out),
                (st_out["participant"], st_out["idp_participant"], _cp))
    st_low = ctx(LOW, lambda d, u: a.review_state(d, u))
    s.check("control: below the minimum grade has no plan in their journey",
            "career_plan" not in [x["key"] for x in a._journey_live_stages(st_low)] and st_low["idp_participant"] is False)
    st_cf = ctx(CF, lambda d, u: a.review_state(d, u))
    s.check("a confirmed person's plan still waits on their own check-in and competency where they have them",
            a._journey_idp_locked({"participant": True, "stages": [{"group": "self", "key": "checkin",
                                                                     "state": a.REVIEW_STATE_OPEN}]})
            and st_cf["participant"] is True)

    s.section("the dashboard")
    summ = ctx(UN, lambda d, u: a.dash_review_summary(d, u))
    s.check("the mini-rail lists their plan", summ and {x["key"] for x in summ["stages"]} >= {"ahead"}
            and not summ["not_required"], summ and [x["key"] for x in summ["stages"]])
    panel = ctx(UN, lambda d, u: a.dash_review_panel(d, u, a.dash_review_summary(d, u)))
    keys = [p["key"] for m in (panel or {}).get("modules") or [] for p in m["parts"]]
    s.check("Your next step has the Career Plan", "career_plan" in keys and not panel["not_required"], keys)
    ni = ctx(UN, lambda d, u: a.dash_not_in(d, u, a.review_state(d, u), a.active_cycle(d), None, [], panel))
    s.check("the not-in-this-review card says their plan is still theirs", ni and ni["plan"]
            and ni["yours"] and ni["yours"][0].startswith("Your Career Plan"), ni)
    r = H.client_as(a, UN).get("/review")
    s.check("the review landing opens the journey or their plan, never 'done'",
            r.status_code == 302 and "/review/done" not in r.headers.get("Location", ""), r.headers.get("Location"))
    with a.app.app_context():   # the per-stage chats (the AI+ journey switched off): the landing opens their plan
        _d = a.get_db()
        _u0 = _d.execute("SELECT value FROM app_settings WHERE key='review_unified'").fetchone()
        _d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', '0')")
        _d.commit()
    try:
        r = H.client_as(a, UN).get("/review")
    finally:
        with a.app.app_context():
            _d = a.get_db()
            if _u0 is None:
                _d.execute("DELETE FROM app_settings WHERE key='review_unified'")
            else:
                _d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', ?)", (_u0[0],))
            _d.commit()
    s.check("...with the AI+ journey off, the landing opens their plan's own chat",
            r.status_code == 302 and "/review/ahead" in r.headers.get("Location", ""), r.headers.get("Location"))

    s.section("their line manager reviews it")
    st_lm = ctx(LM, lambda d, u: a.review_state(d, u))
    s.check("the IDP review is in the manager's review, though they approve no KPI line",
            {"plan_review", "career_review"} <= {x["key"] for x in st_lm["stages"]})
    team = ctx(LM, lambda d, u: [x["id"] for x in a._journey_team_reports(d, u, "plan_review")])
    s.check("...listing everyone of theirs with a plan, and nobody without one",
            {UN, LATE, CF, ADD, OUT, TK, NC} <= set(team) and not ({LOW, LEFT, OUTU} & set(team)), team)
    s.check("...the KPI team list is unchanged (no KPI line, nobody there)",
            ctx(LM, lambda d, u: a._journey_team_reports(d, u, "pm_review")) == [])
    s.check("the manager may open the plan; someone else's manager may not",
            ctx(LM, lambda d, u: a._idp_is_reviewer_of(d, u, UN, CID))
            and not ctx(OTHER, lambda d, u: a._idp_is_reviewer_of(d, u, UN, CID)))
    s.check("...and they may for someone taken out of the cycle (the plan is still theirs), not for one in a left-out unit",
            all(ctx(LM, lambda d, u, x=x: a._idp_is_reviewer_of(d, u, x, CID)) for x in (OUT, TK, NC))
            and not ctx(LM, lambda d, u: a._idp_is_reviewer_of(d, u, OUTU, CID)))
    s.check("the line manager owns the plan's one remark", ctx(LM, lambda d, u: a._idp_remark_owner(d, UN)) == LM)
    gl, go = H.client_as(a, LM).get("/idp/team/%d" % UN), H.client_as(a, OTHER).get("/idp/team/%d" % UN)
    s.check("the IDP review page opens for the manager, not for anyone else", gl.status_code in (200, 302)
            and (gl.status_code == 200 or "/idp/team/" in gl.headers.get("Location", "") or
                 "review/journey" in gl.headers.get("Location", ""))
            and (go.status_code in (403, 404) or "/idp/team/%d" % UN not in go.headers.get("Location", "")),
            (gl.status_code, gl.headers.get("Location"), go.status_code, go.headers.get("Location")))

    s.section("goals for someone with no self-assessment (Chris, 2026-10-19: their job's levels as baseline)")
    with a.app.app_context():
        d = a.get_db()
        sk = {t: d.execute("INSERT INTO tc_skills(skill_code, title, level, skill_category, active) VALUES (?,?,3,"
                           "'Ops',1)", ("ZZIE-" + t, "ZZIE " + t)).lastrowid for t in ("Alpha", "Beta", "Gamma", "Delta")}

        def prof(title, grade, rows):
            pid = d.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, proficiency_level, source, "
                            "active) VALUES ('ZZIE Dept', ?, ?, 3, 'manual', 1)", (title, grade)).lastrowid
            for t, lvl, fut in rows:
                d.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, is_future) "
                          "VALUES (?,?,?,?)", (pid, sk[t], lvl, fut))
            return pid
        # their own job: Alpha 3, Beta 3 (and Delta at 4 as its next step); the role they pick: Alpha 4, Beta 3, Gamma 3
        P_OWN = prof("ZZIE Officer", "14", [("Alpha", 3, 0), ("Beta", 3, 0), ("Delta", 4, 1)])
        P_TGT = prof("ZZIE Senior Officer", "15", [("Alpha", 4, 0), ("Beta", 3, 0), ("Gamma", 3, 0)])
        P_SAME = prof("ZZIE Officer II", "15", [("Alpha", 3, 0), ("Beta", 3, 0)])
        a.pm_career_profile_for(d, UN, create=True)
        d.execute("UPDATE pm_career_profile SET target_profile_id=? WHERE subject_id=?", (P_TGT, UN))
        d.commit()
    tg = ctx(UN, lambda d, u: a._career_target_gap(d, u))
    by = {it["area"]: it for it in tg["items"]}
    s.check("no self-assessment: goals only where the role asks more (Alpha 3 -> 4) or adds one (Gamma); none for Beta,"
            " which their job already asks", set(by) == {"ZZIE Alpha", "ZZIE Gamma"}, sorted(by))
    s.check("...worded from their job, not 'not demonstrated'", "Your current job asks ZZIE Alpha at level 3; this role "
            "needs level 4." == by.get("ZZIE Alpha", {}).get("detail") and "is new for this role" in
            by.get("ZZIE Gamma", {}).get("detail", "") and not any("demonstrated" in it["detail"] for it in tg["items"]),
            [it["detail"] for it in tg["items"]])
    s.check("...of the right kinds: Alpha their job's skill at the next level, Gamma new",
            by.get("ZZIE Alpha", {}).get("gap_kind") == "future" and by.get("ZZIE Gamma", {}).get("gap_kind") == "new"
            and all(it.get("basis") == "job" for it in tg["items"]))
    with a.app.app_context():
        a.get_db().execute("UPDATE pm_career_profile SET target_profile_id=? WHERE subject_id=?", (P_SAME, UN))
        a.get_db().commit()
    tg2 = ctx(UN, lambda d, u: a._career_target_gap(d, u))
    s.check("a role asking nothing more still grows them: their own job's next step (Delta, level 4)",
            [it["area"] for it in tg2["items"]] == ["ZZIE Delta"] and tg2["items"][0]["source"] == "own_future",
            [(it["area"], it.get("source")) for it in tg2["items"]])
    with a.app.app_context():   # CF answered: "no" on Alpha -- their own answers decide, never the baseline
        d = a.get_db()
        _as = d.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?,'submitted')",
                        (CID, CF)).lastrowid
        _ag = d.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, source) VALUES "
                        "(?,?,?,0,'profile')", (CID, CF, sk["Alpha"])).lastrowid
        d.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer) VALUES (?,?,'no')", (_as, _ag))
        a.pm_career_profile_for(d, CF, create=True)
        d.execute("UPDATE pm_career_profile SET target_profile_id=? WHERE subject_id=?", (P_TGT, CF))
        d.commit()
    tgc = ctx(CF, lambda d, u: a._career_target_gap(d, u))
    s.check("someone who has answered keeps their own answers: every role competency they haven't shown is a goal "
            "(Beta too), in the 'not demonstrated' words", ctx(CF, lambda d, u: a.tc_has_self_assessment(d, u["id"]))
            and {it["area"] for it in tgc["items"]} == {"ZZIE Alpha", "ZZIE Beta", "ZZIE Gamma"}
            and all("isn't demonstrated yet" in it["detail"] and not it.get("basis") for it in tgc["items"]),
            [(it["area"], it["detail"]) for it in tgc["items"]])
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM tc_assessments WHERE id=?", (_as,))
        d.execute("DELETE FROM tc_assignments WHERE id=?", (_ag,))
        d.commit()

    s.section("taken out of the cycle: still a 360 rater, and a Career Plan through its real route (Chris, 2026-11-03)")
    with a.app.app_context():   # each of them is on CF's panel as a peer: CF takes part in the 360, so CF's raters have a task
        d = a.get_db()
        for _x in (OUT, TK, NC, LOW, LEFT, OUTU):
            d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?, 'peer')", (CID, CF, _x))
        d.commit()
    with a.app.test_request_context("/"):
        d = a.get_db()
        ph = ",".join("?" * len(ALL))
        elig = {r[0] for r in d.execute("SELECT id FROM users WHERE id IN (%s) AND %s" % (ph, a.assessor_eligible_sql()),
                                        list(ALL.values()))}
        tasks = {x: d.execute("SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND assessor_id=? AND archived=0 AND "
                              + a.rater_task_sql("assignments"), (CID, x)).fetchone()[0] for x in ALL.values()}
        rated_by = {x: d.execute("SELECT COUNT(*) FROM users WHERE id=? AND %s" % a.participant_sql("users", "tm_rated"), (x,)).fetchone()[0]
                    for x in (OUT, TK, NC, CF)}
    s.check("who may rate colleagues: the take-outs may, like everyone else at the grade (not below it, not gone, not in a left-out unit)",
            {OUT, TK, NC} <= elig and not ({LOW, LEFT, OUTU} & elig), sorted(k for k, v in ALL.items() if v in elig))
    s.check("...and they are not themselves rated: a take-out takes no part in the 360 about them (CF, taking part, is)",
            rated_by == {OUT: 0, TK: 0, NC: 0, CF: 1}, rated_by)
    s.check("...so the colleague they rate is a task of theirs, in the rater predicate every rater's list ANDs in",
            all(tasks[x] == 1 for x in (OUT, TK, NC)), tasks)
    for _who, _id in (("taken out by Take out", TK), ("taken out directly", OUT), ("Not this cycle", NC)):
        st_r = ctx(_id, lambda d, u: a.review_state(d, u))
        fb = next((x for x in st_r["stages"] if x["key"] == "feedback"), {})
        mine = ctx(_id, lambda d, u: [x["subject_id"] for x in a._feedback_assignments(d, u, CID)])
        s.check("someone %s rates CF in their journey's 360 and My assessments" % _who,
                fb.get("n_total") == 1 and mine == [CF], (fb.get("n_total"), mine))
    def goals_of(uid):
        return H.one(a, "SELECT COUNT(*) FROM pm_idp_goals g JOIN pm_idp i ON i.id=g.idp_id WHERE i.subject_id=?", (uid,))
    for _who, _id in (("Take out", TK), ("a direct take-out row", OUT), ("Not this cycle", NC)):
        rr = H.client_as(a, _id).post("/idp/autosave", data={"csrf_token": "tok", "action": "add", "area": "ZZIE %s goal" % _who})
        j = rr.get_json(silent=True) or {}
        s.check("someone taken out by %s writes a Career Plan goal through its POST route (/idp/autosave)" % _who,
                rr.status_code == 200 and j.get("ok") is True and goals_of(_id) == 1, (rr.status_code, j))
    page = H.client_as(a, NC).get("/idp")
    s.check("...and their plan page opens with the goal in it", page.status_code == 200
            and "ZZIE Not this cycle goal" in page.get_data(as_text=True), page.status_code)
    sm = ctx(NC, lambda d, u: a.dash_review_summary(d, u))
    s.check("the dashboard's mini-rail lists the plan of someone taken out, and does not say 'not required'",
            sm and "ahead" in {x["key"] for x in sm["stages"]} and not sm["not_required"], sm and [x["key"] for x in sm["stages"]])

    s.section("the counts")
    with a.app.test_request_context("/"):
        d = a.get_db()
        sup = d.execute("SELECT * FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                        "LIMIT 1").fetchone()
        idp_users = a._mod_scope_users(d, sup, BG, idp=True)
        rev_users = a._mod_scope_users(d, sup, BG)
        lp = a.lp_counts(d, a.active_cycle(d), ["idp_self", "pm_results"])
    # Chris 2026-11-06 ("take it out entirely from our completion calculation for non-participants"): the Career Plan's COUNTS
    # (admin Progress, the leader email's column) now cover only people in the review whose role opens it. Having a plan is
    # unchanged -- the "who has a plan" section above and the autosave checks hold that. test_idp_completion.py holds the rest.
    s.check("the admin's Career Plan progress counts only people in the review (CF, ADD), like the other modules: an unconfirmed or "
            "taken-out person keeps a plan but is not counted",
            set(idp_users) >= {CF, ADD} and not ({UN, LATE, OUT, TK, NC} & set(idp_users)) and not ({UN, LATE, OUT, TK, NC} & set(rev_users)))
    key = (BG, CO, "ZZIE Dept")
    # here: only the confirmed and the added with a plan (CF, ADD) plus the two confirmed managers (LM, OTHER) in the same department
    s.check("the leader email's Career Plan column counts the people in the review here (4), not the five with a plan outside it",
            lp.get("idp_self", {}).get(key, [0])[0] == len((sql_idp & sql_rev) | {LM, OTHER}) == 4, lp.get("idp_self", {}).get(key))
    s.check("...and its headcount of people taking part is the same four",
            lp["_people"].get(key) == len(sql_rev | {LM, OTHER}) == 4, lp["_people"].get(key))
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)
        _db.execute("UPDATE cycles SET kind=?, half=?, starts_on=?, min_job_grade=? WHERE id=?",
                    (CYC0["kind"], CYC0["half"], CYC0["starts_on"], CYC0["min_job_grade"], CID))
        for k_, v_ in MODS0.items():
            _db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v_, CID, k_))
        _db.commit()

sys.exit(s.done())
