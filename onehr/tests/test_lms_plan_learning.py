"""AI+ Learning S10: the Career Plan shows each goal's learning, and what's gained beyond it (Chris, 2026-10-22: "Ensure
LMS is linked to the person IDP", "for additional training, a person can gain or access new competency too"; board 1D).

What this suite holds:
  * each goal's learning: a request tied to the goal, or tied to no goal and of the goal's competency family (named, or
    built by its programme); requested, booked, attended, applied with the level the line manager confirmed;
    withdrawn and absent never count; a request tied to another goal doesn't count twice
  * gained: a competency the line manager confirmed at 3 months, one per family at its highest level; beyond the plan
    when no goal of their latest plan builds it
  * the dashboard's Career Plan panel carries both, only while Learning is on
  * the career readers count a gained competency as held at the level confirmed, only while Learning is on
  * "Add to my plan": a goal already reached (the skill at the level, progress Done), once per family, through the
    plan's own editability gate; refused for what isn't gained
Everything here is synthetic (ZZLP / ZZ9LP-) and removed at the end.
"""
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning S10: the Career Plan's learning")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG = "ZZLP Group"
_ENV0 = os.environ.get("ONEHR_LMS")
_GATE0 = a._idp_ctx_or_error


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LP-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLP %'")
    db.execute("DELETE FROM tc_job_profiles WHERE job_title LIKE 'ZZLP %'")
    if ul:
        ph = ",".join("?" * len(ul))
        for t in ("lms_registrations", "lms_coach_chat"):
            db.execute("DELETE FROM %s WHERE user_id IN (%s)" % (t, ph), ul)
        db.execute("DELETE FROM pm_idp WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZLP-%'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, grade="15", mgr=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id) VALUES (?,?, 'x', 'user', ?,?, 'ZZLP U1', "
                      "'ZZLP Sales', 'ZZLP Officer', ?, ?)", (eid.lower(), "ZZ LP " + eid.split("-")[1], eid, BG, grade,
                                                               mgr)).lastrowid


def fam(db, code, title, levels=(3, 4)):
    ids = {}
    for lv in levels:
        ids[lv] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, "
                             "proficiency_description, active) VALUES (?,?,?,?,?,?,1)",
                             ("ZZLP-%s-%d%s-1.0" % (code[:3], lv, code[3:]), title, lv, "tsc", "ZZLP",
                              "%s at L%d." % (title, lv))).lastrowid
    return "ZZLP-%s-%s" % (code[:3], code[3:]), ids


def prog(db, title, key, level):
    pid = db.execute("INSERT INTO lms_programmes(title, kind, status) VALUES (?, 'inhouse', 'published')",
                     (title,)).lastrowid
    db.execute("INSERT INTO lms_programme_competencies(programme_id, comp_key, level, confirmed) VALUES (?,?,?,1)",
               (pid, key, level))
    return pid


def sess(db, pid, day):
    return db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, seats) VALUES "
                      "(?, 'ZZLP run', ?, ?, 10)", (pid, day, day)).lastrowid


def reg(db, uid, sid, pid, status="approved", outcome=None, goal=None, comp=None):
    return db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, outcome, "
                      "goal_id, comp_key) VALUES (?,?,?,?, '[]', ?,?,?)", (uid, sid, pid, status, outcome, goal,
                                                                           comp)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZLP U1')", (BG,))
    K1, S1 = fam(db, "PRC001", "ZZLP Pricing")
    K2, S2 = fam(db, "DAT002", "ZZLP Data")
    K3, S3 = fam(db, "STK003", "ZZLP Stakeholders")
    K4, S4 = fam(db, "EXC004", "ZZLP Excel Analysis")
    M = person(db, "ZZ9LP-M", "18")
    E = person(db, "ZZ9LP-E", "15", mgr=M)
    idp = db.execute("INSERT INTO pm_idp(plan_year, subject_id, status) VALUES (2027, ?, 'shared')", (E,)).lastrowid
    G1, G2, G3 = (db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, skill_id, required_level, have_level) VALUES "
                             "(?,?,?,?,4,3)", (idp, i + 1, t, sk)).lastrowid
                  for i, (t, sk) in enumerate((("ZZLP pricing goal", S1[4]), ("ZZLP data goal", S2[4]),
                                               ("ZZLP stakeholder goal", S3[4]))))
    today = a._today_myt()
    past, soon, later = ((today + timedelta(days=d)).isoformat() for d in (-100, 20, 40))
    P1, P2, P4 = prog(db, "ZZLP Negotiation", K1, 4), prog(db, "ZZLP Data Storytelling", K2, 4), \
        prog(db, "ZZLP Excel for Sales", K4, 3)
    R_APP = reg(db, E, sess(db, P1, past), P1, outcome="attended", goal=G1)
    R_REQ = reg(db, E, sess(db, P1, later), P1, status="pending", goal=G1)
    R_BOOK = reg(db, E, sess(db, P2, soon), P2)                                   # no goal: by its programme's family
    R_WD = reg(db, E, sess(db, P2, later), P2, status="withdrawn")
    R_ABS = reg(db, E, sess(db, P2, past), P2, outcome="absent")
    R_OTHER = reg(db, E, sess(db, P1, soon), P1, goal=G2)                         # tied to another goal
    R_GAIN = reg(db, E, sess(db, P4, past), P4, outcome="attended")
    for r, lv in ((R_APP, 4), (R_GAIN, 3)):
        db.execute("INSERT INTO lms_evaluations(registration_id, kind, due_on, status, mgr_level, mgr_action, "
                   "confirmed_by, confirmed_at) VALUES (?, 'm3', ?, 'confirmed', ?, 'confirm', ?, datetime('now'))",
                   (r, past, lv, M))
    PROF = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, active) VALUES ('ZZLP Sales', "
                      "'ZZLP Analyst', '16', 1)").lastrowid
    db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level) VALUES (?,?,3)", (PROF, S4[3]))
    db.commit()


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


def with_u(fn):
    with a.app.test_request_context():
        db = a.get_db()
        return fn(db, a._lms_user(db, E))


try:
    env("1")
    s.section("each goal's learning")
    L = with_u(lambda db, u: a.lms_goal_learning(db, E, [G1, G2, G3]))
    st = {g: [(x["title"], x["state"]) for x in L.get(g, [])] for g in (G1, G2, G3)}
    s.check("tied to the goal: asked for, and applied with the level confirmed",
            st[G1] == [("ZZLP Negotiation", "requested"), ("ZZLP Negotiation", "applied")]
            and L[G1][1]["level"] == 4, st[G1])
    s.check("tied to no goal: counts for the goal its programme builds (booked)", ("ZZLP Data Storytelling", "booked")
            in st[G2], st[G2])
    s.check("...withdrawn and absent never count", len([x for x in st[G2] if x[0] == "ZZLP Data Storytelling"]) == 1)
    s.check("...a request tied to another goal counts there, once", ("ZZLP Negotiation", "booked") in st[G2] and
            all(x[1] != "booked" for x in st[G1]), (st[G1], st[G2]))
    s.check("a goal with nothing: no lines", st[G3] == [])

    s.section("gained")
    gained = with_u(lambda db, u: a.lms_gained(db, u))
    gk = {g["key"]: g for g in gained}
    s.check("what their line manager confirmed, at the level confirmed", gk.get(K4, {}).get("level") == 3 and
            gk.get(K1, {}).get("level") == 4, gained)
    s.check("...beyond the plan when no goal builds it", gk[K4]["in_plan"] is False and gk[K1]["in_plan"] is True)
    CE = H.client_as(a, E)
    d = CE.get("/me/plan?year=2027").get_json()
    goals = {g["id"]: g for g in (d.get("plan") or {}).get("goals", [])}
    s.check("the Career Plan panel: each goal's learning", d.get("learning_on") and
            [x["state"] for x in goals[G1]["learning"]] == ["requested", "applied"] and goals[G3]["learning"] == []
            and d["find_url"] == "/learning?tab=find", d.get("learning_on"))
    s.check("...gained beyond the plan only, nothing to add to a shared plan", [g["key"] for g in d["gained"]] == [K4]
            and d["gained_add"] is False, d.get("gained"))

    s.section("the roles a gained competency counts in")
    hv = with_u(lambda db, u: a.lms_gained_have(db, E))
    s.check("held at the level confirmed, in the plan or beyond it", hv == {"ZZLP Excel Analysis": 3, "ZZLP Pricing": 4}, hv)
    roles = with_u(lambda db, u: a._career_role_skills(db, u, None, [{"profile_id": PROF}]))
    s.check("...the role's skill matches on it", roles[0]["skills"] and roles[0]["skills"][0]["state"] == "match"
            and roles[0]["match"] == 1, roles)

    s.section("Add to my plan")
    with a.app.app_context():
        db = a.get_db()
        draft = db.execute("INSERT INTO pm_idp(plan_year, subject_id, status) VALUES (2028, ?, 'draft')", (E,)).lastrowid
        db.commit()
    a._idp_ctx_or_error = lambda db, u, create=False: ({"idp": a.pm_idp_for(db, 2028, u["id"])}, None)
    ok, msg = with_u(lambda db, u: a.lms_gained_add(db, u, K4))
    row = with_u(lambda db, u: dict(db.execute("SELECT area, skill_id, required_level, have_level, progress_status, "
                                               "source FROM pm_idp_goals WHERE idp_id=?", (draft,)).fetchone() or {}))
    s.check("a goal already reached: the skill at the level confirmed, Done", ok and row.get("skill_id") == S4[3] and
            row.get("required_level") == 3 and row.get("progress_status") == "done" and row.get("source") == "learning",
            (ok, msg, row))
    ok2, msg2 = with_u(lambda db, u: a.lms_gained_add(db, u, K4))
    s.check("...once per family", not ok2 and "already" in msg2, msg2)
    ok3, msg3 = with_u(lambda db, u: a.lms_gained_add(db, u, K3))
    s.check("...only what they gained", not ok3 and "gained" in msg3, msg3)
    a._idp_ctx_or_error = lambda db, u, create=False: (None, {"ok": False, "error": "locked"})
    ok4, msg4 = with_u(lambda db, u: a.lms_gained_add(db, u, K1))
    s.check("...through the plan's own gate", not ok4 and "next year's plan" in msg4, msg4)
    a._idp_ctx_or_error = _GATE0

    s.section("only while Learning is on")
    env(None)
    d = CE.get("/me/plan?year=2027").get_json()
    s.check("the panel: no learning, nothing gained", not d.get("learning_on") and "gained" not in d and
            "learning" not in ((d.get("plan") or {}).get("goals") or [{}])[0])
    s.check("the roles: held only as answered", with_u(lambda db, u: a.lms_gained_have(db, E)) == {})
    s.check("Add to my plan is dark", CE.post("/learning/gained", data={"csrf_token": "tok", "key": K4}).status_code == 404)
finally:
    a._idp_ctx_or_error = _GATE0
    env(_ENV0)
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
