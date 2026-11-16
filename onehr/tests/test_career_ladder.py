"""Career routes from the job architecture, and the gap a drafted goal answers (2026-10-17, plan Phase 3).

An architecture profile (one with a job code) reads its routes from the architecture itself: the same job at higher
grades (the nearest is the person's next step, kept even when the ladder skips grades), then one route per other job
in the same specialisation, sub-family and family, never a lower grade, with HR's pinned and hidden overrides. A
legacy profile keeps the overlap scan and never sees an architecture profile. The target-role gap says what kind each
gap is (current / future / new) and carries the skill; a drafted goal stores that gap.

Everything is synthetic (ZZ9CL...: ZZ plus a digit, so not a demo account) and removed at the end; the cycle settings
this suite changes are put back.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
import ai_draft  # noqa: E402
s = H.Suite("Career routes from the job architecture, and gaps stored on drafted goals")


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9CL%' OR employee_id LIKE 'ZZQCL%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM pm_idp_goals WHERE idp_id IN (SELECT id FROM pm_idp WHERE subject_id IN (%s))" % ph,
                   ids)
        for t in ("pm_idp", "pm_career_profile", "tc_assignments", "tc_assessments", "pm_ai_draft_usage"):
            col = "user_id" if t == "pm_ai_draft_usage" else "subject_id"
            db.execute("DELETE FROM %s WHERE %s IN (%s)" % (t, col, ph), ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM ja_people WHERE employee_id LIKE 'ZZ9CL%' OR employee_id LIKE 'ZZQCL%'")
    db.execute("DELETE FROM ja_taxonomy WHERE code LIKE 'ZQ%'")
    db.execute("DELETE FROM tc_career_routes WHERE from_profile_id IN (SELECT id FROM tc_job_profiles WHERE "
               "job_title LIKE 'ZZCL %')")
    db.execute("DELETE FROM tc_job_profile_skills WHERE profile_id IN (SELECT id FROM tc_job_profiles WHERE "
               "job_title LIKE 'ZZCL %')")
    db.execute("DELETE FROM tc_job_profile_skills WHERE profile_id IN (SELECT id FROM tc_job_profiles WHERE "
               "job_code LIKE 'EXL-ZQN-%')")
    db.execute("DELETE FROM tc_career_routes WHERE from_profile_id IN (SELECT id FROM tc_job_profiles WHERE "
               "job_code LIKE 'EXL-ZQN-%')")
    db.execute("DELETE FROM tc_job_profiles WHERE job_code LIKE 'EXL-ZQN-%'")
    db.execute("DELETE FROM tc_job_profiles WHERE job_title LIKE 'ZZCL %'")
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZCL-%'")
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    KEEP = {"half": H.one(a, "SELECT half FROM cycles WHERE id=?", (CID,)),
            "mods": {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?",
                                                    (CID,))}}
    SK = {}
    for t in ("S1", "S2", "S3", "S4", "S5", "S6", "S7"):
        for lv in (2, 3, 4, 5):
            SK[(t, lv)] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, active, "
                                     "proficiency_description) VALUES (?,?,?, 'tsc', 1, ?)",
                                     ("ZZCL-%s-%d" % (t, lv), "ZZCL Skill " + t, lv,
                                      "ZZCL meaning of %s at level %d" % (t, lv))).lastrowid
    P = {}

    def prof(jc, skills, lv=3):
        pid = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, plan_mode, "
                         "source, active) VALUES ('ZZCL Sub', ?, ?, ?, 'explicit', 'architecture', 1)",
                         ("ZZCL " + jc, jc.rsplit("-", 1)[1], jc)).lastrowid
        for i, t in enumerate(skills):
            L = lv if not isinstance(t, tuple) else t[1]
            t = t if not isinstance(t, tuple) else t[0]
            db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, "
                       "is_future) VALUES (?,?,?,?,0)", (pid, SK[(t, L)], L, i))
        P[jc] = pid
        return pid
    FIVE = ["S1", "S2", "S3", "S4", "S5"]
    # the person's job ZQF-SUB-01-A: JG 12 (lower), 13 (theirs), 14 (next), 17 (three above: past the cap)
    prof("ZQF-SUB-01-A-12", FIVE)
    prof("ZQF-SUB-01-A-13", FIVE)
    # their own job's future rows: S1 at the next level, and S6, a competency it adds
    for i, (t, L) in enumerate((("S1", 5), ("S6", 4), ("S2", 4))):   # S2 at L4: held at L4 in the fallback check
        db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, is_future) "
                   "VALUES (?,?,?,?,1)", (P["ZQF-SUB-01-A-13"], SK[(t, L)], L, i))
    prof("ZQF-SUB-01-A-14", [(t, 4) for t in FIVE[:4]] + [("S7", 4)])
    prof("ZQF-SUB-01-A-17", [(t, 4) for t in FIVE])
    # the specialisation's other unit B: JG 13 hidden by HR, JG 14 shown instead; little overlap (allowed here)
    prof("ZQF-SUB-01-B-13", ["S1", "S6"])
    prof("ZQF-SUB-01-B-14", ["S1", "S6"])
    # the sub-family's other specialisations: 02 shares 2 of 5 (40%, in), 03 shares 1 (20%, out)
    prof("ZQF-SUB-02-13", ["S1", "S2", "S6"])
    prof("ZQF-SUB-02-14", ["S1", "S2", "S6"])
    prof("ZQF-SUB-03-13", ["S1", "S6", "S7"])
    # the family's other sub-family: OTH-01 shares 3 of 5 (in at 40%), OTH-02 shares 1 (out)
    prof("ZQF-OTH-01-13", ["S1", "S2", "S3"])
    prof("ZQF-OTH-02-13", ["S1", "S6"])
    # a second family route, named after OTH-01 but a better skills match for the person below: it sorts first
    prof("ZQF-OTH-03-13", ["S1", "S2", "S3", "S4"])
    # another family entirely, identical skills: out, unless HR pins it
    prof("ZQG-XXX-01-13", FIVE)
    prof("ZQG-YYY-01-13", FIVE)
    # a sparse ladder: ZQF-SUB-01-C has JG 12 and JG 16 only
    prof("ZQF-SUB-01-C-12", FIVE)
    prof("ZQF-SUB-01-C-16", [(t, 4) for t in FIVE])
    # the recommended next step (2026-10-19): a JG 20 rung of unit A, and two leadership roles one grade above it
    prof("ZQF-SUB-01-A-20", [(t, 5) for t in FIVE])
    prof("EXL-ZQL-01-21", [(t, 5) for t in FIVE])
    prof("EXL-ZQL-02-21", [(t, 5) for t in FIVE[:3]] + [("S6", 5), ("S7", 5)])
    prof("EXL-ZQM-01-22", [(t, 5) for t in FIVE])            # a leadership job two grades above JG 20 (2026-10-19)
    prof("ZQF-SUB-01-A-15", [(t, 4) for t in FIVE])          # their own job two grades up: offered (2026-10-19)
    db.execute("INSERT INTO tc_career_routes(from_profile_id, to_profile_id, kind) VALUES (?,?, 'hidden')",
               (P["ZQF-SUB-01-A-13"], P["ZQF-SUB-01-B-13"]))
    db.execute("INSERT INTO tc_career_routes(from_profile_id, to_profile_id, kind) VALUES (?,?, 'pinned')",
               (P["ZQF-SUB-01-A-13"], P["ZQG-XXX-01-13"]))
    for code, lvl, parent, name in (("ZQF", "family", None, "ZQ Family"), ("ZQF-SUB", "sub", "ZQF", "ZQ Sub"),
                                    ("ZQF-SUB-01", "spec", "ZQF-SUB", "ZQ Spec One"),
                                    ("ZQF-SUB-02", "spec", "ZQF-SUB", "ZQ Spec Two")):
        db.execute("INSERT INTO ja_taxonomy(code, level, parent_code, name) VALUES (?,?,?,?)",
                   (code, lvl, parent, name))
    # a legacy profile (no job code) that shares the person's skills: the overlap scan's world only
    LEG = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, source, active) "
                     "VALUES ('ZZCL Legacy', 'ZZCL Legacy Role', '13', 'test', 1)").lastrowid
    LEG2 = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, source, active) "
                      "VALUES ('ZZCL Legacy', 'ZZCL Legacy Next', '14', 'test', 1)").lastrowid
    for pid in (LEG, LEG2):
        for i, t in enumerate(FIVE):
            db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, sort_order) VALUES (?,?,?)",
                       (pid, SK[(t, 3)], i))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, grade, unit):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ CL " + eid[-1], email=None,
                 job_grade=grade, job_title="ZZCL Title", department="ZZCL Dept", left_at=None, is_demo=0,
                 role="user", manager_id=None, hod_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None,
                 admin_bg=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        db.execute("INSERT INTO ja_people(employee_id, family_code, sub_code, spec_code, unit_code, job_scope, "
                   "arch_grade, source) VALUES (?,?,?,?,?,?,?, 'test')",
                   (eid, "ZQF", "ZQF-SUB", "ZQF-SUB-01", unit, "ZZCL", str(grade)))
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    PA = mk("ZZ9CL-A", 13, "ZQF-SUB-01-A")
    PC = mk("ZZ9CL-C", 12, "ZQF-SUB-01-C")
    PL = mk("ZZ9CL-L", 20, "ZQF-SUB-01-A")   # at the top of the normal ladder
    # demo accounts (ZZ + a letter): one holding a job in the architecture, one not (staging, 2026-10-17)
    PD = mk("ZZQCL-D", 13, "ZQF-SUB-01-A")
    PE = mk("ZZQCL-E", 13, "ZQF-SUB-01-A")
    db.execute("DELETE FROM ja_people WHERE employee_id='ZZQCL-E'")
    DEMO_ROLE = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, source, active) "
                           "VALUES ('ZZCL Demo', 'ZZCL Demo Role', '14', ?, 1)", (a._CAREER_DEMO_SOURCE,)).lastrowid
    db.commit()


def ctx(uid, fn):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        db = a.get_db()
        return fn(db, dict(db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


try:
    s.section("Routes read from the architecture")
    here = ctx(PA, lambda d, u: a.tc_profile_for_user(d, u)[0])
    s.check("the person resolves to their job code's profile", here and here["id"] == P["ZQF-SUB-01-A-13"], here)
    routes = ctx(PA, lambda d, u: a.tc_career_routes_for(d, here, limit=40))
    by = {r["profile"]["job_code"]: r for r in routes}
    s.check("the next grade of their own job is a route, deepening, marked as the next step",
            "ZQF-SUB-01-A-14" in by and by["ZQF-SUB-01-A-14"]["lane"] == "deepen"
            and by["ZQF-SUB-01-A-14"]["next_step"] is True, sorted(by))
    s.check("...and it ranks first (with no assessment to rank on readiness)",
            routes and routes[0]["profile"]["job_code"] in ("ZQF-SUB-01-A-14", "ZQG-XXX-01-13"),
            [r["profile"]["job_code"] for r in routes[:3]])
    s.check("their own job two grades up is a route too (Chris, 2026-10-19: up to two grades), not the next step",
            "ZQF-SUB-01-A-15" in by and by["ZQF-SUB-01-A-15"]["next_step"] is False)
    s.check("...but not one more than two grades up: it would only take a place the card then drops",
            "ZQF-SUB-01-A-17" not in by, sorted(by))
    with a.app.app_context():   # a lateral that outscores them: the same specialisation, every skill shared
        _db = a.get_db()
        _d14 = _db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, plan_mode, source, "
                           "active) VALUES ('ZZCL Sub', 'ZZCL ZQF-SUB-01-D-14', '14', 'ZQF-SUB-01-D-14', 'explicit', "
                           "'architecture', 1)").lastrowid
        for _i, _t in enumerate(FIVE):
            _db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, is_future) "
                        "VALUES (?,?,3,?,0)", (_d14, SK[(_t, 3)], _i))
        _db.commit()
    try:
        _all = ctx(PA, lambda d, u: {r["profile"]["job_code"]: r["score"] for r in a.tc_career_routes_for(d, here, limit=40)})
        _r3 = ctx(PA, lambda d, u: [r["profile"]["job_code"] for r in a.tc_career_routes_for(d, here, limit=3)])
    finally:
        with a.app.app_context():
            a.get_db().execute("DELETE FROM tc_job_profiles WHERE id=?", (_d14,)); a.get_db().commit()
    s.check("the steps up their own job can't be pushed off by a lateral that outscores them (only HR's pin ranks "
            "before them)", _all.get("ZQF-SUB-01-D-14", 0) > _all.get("ZQF-SUB-01-A-15", 9)
            and set(_r3) == {"ZQG-XXX-01-13", "ZQF-SUB-01-A-14", "ZQF-SUB-01-A-15"}, (_r3, _all))
    s.check("never a lower grade, not even of their own job", "ZQF-SUB-01-A-12" not in by)
    s.check("the specialisation's other unit is a route (crossing), whatever the overlap",
            "ZQF-SUB-01-B-14" in by and by["ZQF-SUB-01-B-14"]["lane"] == "cross"
            and by["ZQF-SUB-01-B-14"]["route"] == "same specialisation")
    s.check("...HR's hidden JG 13 is not, and only one grade of that unit is offered",
            "ZQF-SUB-01-B-13" not in by and sum(1 for k in by if k.startswith("ZQF-SUB-01-B-")) == 1)
    s.check("a sub-family sibling sharing 40% is a route; one sharing 20% is not",
            "ZQF-SUB-02-13" in by and "ZQF-SUB-03-13" not in by)
    s.check("...offered once, at its nearest grade", "ZQF-SUB-02-14" not in by)
    s.check("a sibling job more than two grades up is not a lateral route", "ZQF-SUB-01-C-16" not in by)
    s.check("...named by the architecture as a move into another specialisation",
            by.get("ZQF-SUB-02-13", {}).get("track_move") == "ZQ Spec Two", by.get("ZQF-SUB-02-13"))
    s.check("a family sibling sharing 3 of 5 is a route; one sharing 1 is not",
            "ZQF-OTH-01-13" in by and "ZQF-OTH-02-13" not in by)
    s.check("another family is never offered, even with identical skills ...", "ZQG-YYY-01-13" not in by)
    s.check("...unless HR pinned it", "ZQG-XXX-01-13" in by and by["ZQG-XXX-01-13"]["pinned"] is True)
    s.check("a legacy profile never appears in an architecture person's routes",
            not [r for r in routes if not r["profile"].get("job_code")])
    with a.app.app_context():
        d = a.get_db()
        batched = a.tc_profile_skill_maps(d, [P["ZQF-SUB-01-A-14"], P["ZQF-SUB-02-13"]])
        single = {pid: a.tc_profile_skill_map(d, pid) for pid in batched}
    s.check("the batched skill read gives what the per-profile read gives", batched == single, (batched, single))

    s.section("Another job scope of the same job code (2026-10-18)")
    with a.app.app_context():
        d = a.get_db()
        OS = d.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, job_scope, plan_mode, "
                       "source, active) VALUES ('ZZCL Sub', 'ZZCL Other Scope 13', '13', 'ZQF-SUB-01-A-13', "
                       "'OTHER SCOPE', 'explicit', 'architecture', 1)").lastrowid
        for i, t in enumerate(("S1", "S2", "S6")):
            d.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, is_future) "
                      "VALUES (?,?,3,?,0)", (OS, SK[(t, 3)], i))
        d.commit()
    here2 = ctx(PA, lambda d, u: a.tc_profile_for_user(d, u)[0])
    s.check("a person whose scope has no profile of its own keeps the code's scope-less profile",
            here2 and here2["id"] == P["ZQF-SUB-01-A-13"], here2 and here2["id"])
    r2 = {r["profile"]["id"]: r for r in ctx(PA, lambda d, u: a.tc_career_routes_for(d, here2, limit=40))}
    s.check("the same code's other scope is a lateral route at the same grade, never the next step",
            OS in r2 and r2[OS]["route"] == "same specialisation" and r2[OS]["next_step"] is False
            and r2[OS]["lane"] == "cross", r2.get(OS))
    s.check("...and the next step is still the next grade of their own job",
            [k for k, v in r2.items() if v["next_step"]] == [P["ZQF-SUB-01-A-14"]],
            [(v["profile"]["job_code"], v["next_step"]) for v in r2.values()])
    with a.app.app_context():
        a.get_db().execute("DELETE FROM tc_job_profiles WHERE id=?", (OS,))
        a.get_db().commit()

    s.section("The legacy map is unchanged")
    with a.app.test_request_context("/"):
        d = a.get_db()
        lr = a.tc_career_routes_for(d, dict(d.execute("SELECT * FROM tc_job_profiles WHERE id=?",
                                                      (LEG,)).fetchone()), limit=40)
    s.check("a legacy profile still finds legacy routes by overlap", any(r["profile"]["id"] == LEG2 for r in lr), lr)
    s.check("...and never an architecture profile", not [r for r in lr if r["profile"].get("job_code")])

    s.section("The role picker keeps the next step on a ladder that skips grades")
    cand = ctx(PC, lambda d, u: a._career_candidate_roles(d, u))
    s.check("a JG 12 on a ladder whose next grade is JG 16 is still offered it",
            any(r["grade"] == "16" and r["next_step"] for r in cand["roles"]), cand)
    capd = ctx(PA, lambda d, u: a._career_candidate_roles(d, u))
    s.check("...while a role three grades up that is not the next step is capped out",
            not [r for r in capd["roles"] if r["grade"] == "17"] and any(r["next_step"] for r in capd["roles"]),
            [(r["title"], r["grade"]) for r in capd["roles"]])
    s.check("each offered role says where it comes from", all(r.get("route") for r in capd["roles"]), capd["roles"])

    s.section("The gap against the chosen role, by kind")
    with a.app.app_context():
        d = a.get_db()
        a.pm_career_profile_for(d, PA, create=True)
        d.execute("UPDATE pm_career_profile SET target_profile_id=? WHERE subject_id=?", (P["ZQF-SUB-01-A-14"], PA))
        d.commit()
    _was = a.tc_person_skill_self
    # holds S1 at L3 (meets their own job, short of the next role's L4), S2 at L2 (short of their own job's L3),
    # S3-S4 at L4 (met); S7 is new to the next role
    a.tc_person_skill_self = lambda db, sid: ({"ZZCL Skill S1": 3, "ZZCL Skill S2": 2, "ZZCL Skill S3": 4,
                                               "ZZCL Skill S4": 4} if sid == PA else _was(db, sid))
    try:
        tg = ctx(PA, lambda d, u: a._career_target_gap(d, u))
    finally:
        a.tc_person_skill_self = _was
    k = {it["area"]: it for it in tg["items"]}
    s.check("met skills are not gaps", set(k) == {"ZZCL Skill S1", "ZZCL Skill S2", "ZZCL Skill S7"}, sorted(k))
    s.check("their own job's skill, held at their job's level, short of the next role's: future",
            k["ZZCL Skill S1"]["gap_kind"] == "future" and k["ZZCL Skill S1"]["required"] == 4)
    s.check("below what their own job needs: current", k["ZZCL Skill S2"]["gap_kind"] == "current")
    s.check("a competency the next role adds: new", k["ZZCL Skill S7"]["gap_kind"] == "new")
    s.check("...each carries the target role's skill at the level it needs",
            k["ZZCL Skill S1"]["skill_id"] == SK[("S1", 4)] and k["ZZCL Skill S7"]["skill_id"] == SK[("S7", 4)]
            and k["ZZCL Skill S1"]["target_profile_id"] == P["ZQF-SUB-01-A-14"], k)

    s.section("A drafted goal stores the gap it answers")
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
        d.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','idp')", (CID,))
        d.commit()
    saved = (ai_draft.is_configured, ai_draft.draft_idp_actions, ai_draft.draft_career_profile, a.get_idp_settings)
    ai_draft.is_configured = lambda: True
    ai_draft.draft_idp_actions = lambda goals, target=None, timeout=25, self_view=None: [
        {"action_experience": "a stretch task"} for _ in goals]

    def _no_profile(*a_, **k_):
        raise ai_draft.AIDraftError("not in this test")
    ai_draft.draft_career_profile = _no_profile
    _real_settings = saved[3]
    a.get_idp_settings = lambda: tuple(True if i == 3 else v for i, v in enumerate(_real_settings()))
    a.tc_person_skill_self = lambda db, sid: ({"ZZCL Skill S1": 3, "ZZCL Skill S2": 2, "ZZCL Skill S3": 4,
                                               "ZZCL Skill S4": 4} if sid == PA else _was(db, sid))
    try:
        r1 = ctx(PA, lambda d, u: a._career_tool_draft_plan(d, u, CID, {}))
        goals = H.rows(a, "SELECT g.area, g.skill_id, g.required_level, g.have_level, g.target_profile_id, "
                          "g.gap_kind FROM pm_idp_goals g JOIN pm_idp p ON p.id=g.idp_id WHERE p.subject_id=? "
                          "ORDER BY g.seq", (PA,))
        gk = {g[0]: g for g in goals}
        s.check("the draft wrote one goal per gap", r1.get("ok") and set(gk) == set(k), (r1, sorted(gk)))
        s.check("...each storing the skill, both levels, the target role and the kind",
                gk.get("ZZCL Skill S1") and tuple(gk["ZZCL Skill S1"][1:]) == (
                    SK[("S1", 4)], 4, 3, P["ZQF-SUB-01-A-14"], "future")
                and gk["ZZCL Skill S7"][5] == "new" and gk["ZZCL Skill S7"][3] is None
                and gk["ZZCL Skill S2"][5] == "current", goals)
        with a.app.app_context():
            a.get_db().execute("DELETE FROM pm_ai_draft_usage WHERE user_id=?", (PA,))
            a.get_db().commit()
        ctx(PA, lambda d, u: a._career_tool_draft_plan(d, u, CID, {}))
        n2 = H.one(a, "SELECT COUNT(*) FROM pm_idp_goals g JOIN pm_idp p ON p.id=g.idp_id WHERE p.subject_id=?",
                   (PA,))
        s.check("drafting again never writes a second goal for the same gap", n2 == len(goals), (n2, len(goals)))
    finally:
        ai_draft.is_configured, ai_draft.draft_idp_actions, ai_draft.draft_career_profile, a.get_idp_settings = saved
        a.tc_person_skill_self = _was
    s.section("A role that asks nothing more still grows them, and the drafter knows what each level means")
    s.check("the target gap carries what the needed level means",
            k["ZZCL Skill S1"].get("level_meaning") == "ZZCL meaning of S1 at level 4", k["ZZCL Skill S1"])
    a.tc_person_skill_self = lambda db, sid: ({"ZZCL Skill S%d" % i: 4 for i in (1, 2, 3, 4, 5, 7)}
                                              if sid == PA else _was(db, sid))
    try:
        tg2 = ctx(PA, lambda d, u: a._career_target_gap(d, u))
    finally:
        a.tc_person_skill_self = _was
    k2 = {it["area"]: it for it in tg2["items"]}
    s.check("holding everything the next role needs, the gaps come from their own job's next level",
            set(k2) == {"ZZCL Skill S1", "ZZCL Skill S6"} and all(it.get("source") == "own_future"
                                                                  for it in tg2["items"]), tg2["items"])
    s.check("...the next level of a skill they hold is future, a skill their job adds is new",
            k2["ZZCL Skill S1"]["gap_kind"] == "future" and k2["ZZCL Skill S1"]["required"] == 5
            and k2["ZZCL Skill S6"]["gap_kind"] == "new" and k2["ZZCL Skill S1"]["skill_id"] == SK[("S1", 5)], k2)
    s.check("...with the level's meaning and the chosen role still on each",
            k2["ZZCL Skill S1"]["level_meaning"] == "ZZCL meaning of S1 at level 5"
            and k2["ZZCL Skill S6"]["target_profile_id"] == P["ZQF-SUB-01-A-14"], k2)
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM pm_idp_goals WHERE idp_id IN (SELECT id FROM pm_idp WHERE subject_id=?)", (PA,))
        d.execute("DELETE FROM pm_ai_draft_usage WHERE user_id=?", (PA,))
        d.commit()
    seen = []
    saved = (ai_draft.is_configured, ai_draft.draft_idp_actions, ai_draft.draft_career_profile, a.get_idp_settings)
    ai_draft.is_configured = lambda: True
    ai_draft.draft_idp_actions = lambda goals, target=None, timeout=25, self_view=None: (
        seen.append((goals, target)), [{} for _ in goals])[1]
    ai_draft.draft_career_profile = _no_profile
    a.get_idp_settings = lambda: tuple(True if i == 3 else v for i, v in enumerate(_real_settings()))
    a.tc_person_skill_self = lambda db, sid: ({"ZZCL Skill S1": 3, "ZZCL Skill S2": 2, "ZZCL Skill S3": 4,
                                               "ZZCL Skill S4": 4} if sid == PA else _was(db, sid))
    try:
        ctx(PA, lambda d, u: a._career_tool_draft_plan(d, u, CID, {}))
    finally:
        ai_draft.is_configured, ai_draft.draft_idp_actions, ai_draft.draft_career_profile, a.get_idp_settings = saved
        a.tc_person_skill_self = _was
    s.check("the drafter is given what each needed level means",
            seen and all(g.get("level_meaning") for g in seen[0][0]), seen)
    s.check("...and who the person is now, beside the role they chose",
            seen and "they are now ZZCL Title (JG13)" in (seen[0][1] or ""), seen and seen[0][1])
    was_cfg, was_cc = ai_draft._cfg, ai_draft._chat_complete
    users = []
    ai_draft._cfg = lambda: ("https://x", "k", "d", "v")
    ai_draft._chat_complete = lambda system, user, *a_, **k_: (users.append((system, user)), "[]")[1]
    try:
        ai_draft.draft_idp_actions([{"area": "ZZCL Skill S1", "detail": "holds L3, needs L4",
                                     "level_meaning": "Leads the monthly review"}], "Role X")
    finally:
        ai_draft._cfg, ai_draft._chat_complete = was_cfg, was_cc
    s.check("the model's message carries the level's meaning, and the brief asks for actions at that level",
            users and "[what the needed level means: Leads the monthly review]" in users[0][1]
            and "pitch every action at THAT level" in users[0][0] and "%%" not in users[0][0], users)
    s.check("the brief anchors the 70% in one piece of their own unit's work, as big as the level asks (Run D: a slice "
            "under the level lost level fit), and asks the 10% for something applied (Chris, 2026-10-20, after the v3 AI test)",
            users and "ANCHOR the 70% in their own work" in users[0][0] and "never 'end-to-end'" in users[0][0]
            and "The 10% must lead to something APPLIED" in users[0][0]
            and "only lists topics is not enough" in users[0][0]
            and "Keep the piece as big as the needed level" in users[0][0], users and users[0][0][-1100:])
    s.check("...and who they are now names their department and business unit",
            a._career_now_line({"job_title": "Senior Executive, Project Operations", "job_grade": 14,
                                "department": "Project Operations", "company": "ASG"})
            == "Senior Executive, Project Operations (JG14), in the Project Operations department of ASG"
            and a._career_now_line({"job_title": "X", "job_grade": None, "department": "", "company": "C"}) == "X, in C")
    cols = [r[1] for r in H.rows(a, "PRAGMA table_info(pm_idp_goals)")]
    s.check("the goal table carries the gap columns",
            all(c in cols for c in ("skill_id", "required_level", "have_level", "target_profile_id", "gap_kind")))

    s.section("The Career Plan card: each role's skills match, nearest first (option 1, 2026-10-17)")
    # the same answers as above: S1 at L3 (their job's level), S2 at L2 (below it), S3-S4 at L4
    a.tc_person_skill_self = lambda db, sid: ({"ZZCL Skill S1": 3, "ZZCL Skill S2": 2, "ZZCL Skill S3": 4,
                                               "ZZCL Skill S4": 4} if sid == PA else _was(db, sid))
    _was_at = a.tc_person_assessed_titles
    a.tc_person_assessed_titles = lambda db, sid: ({"ZZCL Skill S1", "ZZCL Skill S2", "ZZCL Skill S3",
                                                    "ZZCL Skill S4"} if sid == PA else _was_at(db, sid))
    try:
        cand2 = ctx(PA, lambda d, u: a._career_candidate_roles(d, u))
        shown = ctx(PA, lambda d, u: a._career_tool_show_directions(d, u, CID, {}))
        # assessed only on skills outside their own job (staging's demo people on the old skills): nothing to compare
        a.tc_person_skill_self = lambda db, sid: ({"ZZCL Other": 4} if sid == PA else _was(db, sid))
        a.tc_person_assessed_titles = lambda db, sid: ({"ZZCL Other"} if sid == PA else _was_at(db, sid))
        off_job = ctx(PA, lambda d, u: a._career_candidate_roles(d, u))
        # a "no" on one of their own job's skills is assessed: states show, and that skill is below
        a.tc_person_skill_self = lambda db, sid: ({} if sid == PA else _was(db, sid))
        a.tc_person_assessed_titles = lambda db, sid: ({"ZZCL Skill S2"} if sid == PA else _was_at(db, sid))
        said_no = ctx(PA, lambda d, u: a._career_candidate_roles(d, u))
    finally:
        a.tc_person_skill_self = _was
        a.tc_person_assessed_titles = _was_at
    with a.app.app_context():
        d = a.get_db()
        ass = d.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?, 'submitted')",
                        (CID, PC)).lastrowid
        for i, (t, ans, mgr) in enumerate((("S1", "no", None), ("S2", "yes", None), ("S3", None, None),
                                           ("S4", None, "no"))):
            asg = d.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, seq) VALUES (?,?,?,?)",
                            (CID, PC, SK[(t, 3)], i)).lastrowid
            d.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer, manager_answer) VALUES (?,?,?,?)",
                      (ass, asg, ans, mgr))
        d.commit()
        got = a.tc_person_assessed_titles(d, PC)
        d.execute("DELETE FROM tc_assignments WHERE subject_id=?", (PC,))
        d.execute("DELETE FROM tc_assessments WHERE subject_id=?", (PC,))
        d.commit()
    s.check("assessed = any answer, yes or no, the manager's included; an unanswered draft is not",
            got == {"ZZCL Skill S1", "ZZCL Skill S2", "ZZCL Skill S4"}, got)
    s.check("answers only on skills outside their own job: no state is claimed on any role (the plain list)",
            off_job["roles"] and all(r["skills"] == [] and r["competencies"] for r in off_job["roles"]),
            [(r["title"], len(r["skills"])) for r in off_job["roles"]])
    _sn = {x["title"]: x["state"] for r in said_no["roles"] if r["profile_id"] == P["ZQF-SUB-01-A-14"]
           for x in r["skills"]}
    s.check("...while a \"no\" on their own job's skill counts as assessed: the states show, that skill below",
            _sn.get("ZZCL Skill S2") == "below" and _sn.get("ZZCL Skill S7") == "new", _sn)
    rc = {r["profile_id"]: r for r in cand2["roles"]}
    nxt = rc.get(P["ZQF-SUB-01-A-14"]) or {}
    st = {x["title"]: x for x in nxt.get("skills", [])}
    want = ["ZZCL Skill S1", "ZZCL Skill S2", "ZZCL Skill S3", "ZZCL Skill S4", "ZZCL Skill S7"]
    s.check("a role lists its skills in the profile's order", [x["title"] for x in nxt.get("skills", [])] == want,
            nxt.get("skills"))
    s.check("held at the level the role needs: match",
            st.get("ZZCL Skill S3", {}).get("state") == "match" and st.get("ZZCL Skill S4", {}).get("state") == "match",
            st)
    s.check("their own job's skill, held at their job's level, needed a level up: next, with all three levels",
            st.get("ZZCL Skill S1", {}).get("state") == "next"
            and (st["ZZCL Skill S1"]["have"], st["ZZCL Skill S1"]["own"], st["ZZCL Skill S1"]["need"]) == (3, 3, 4),
            st.get("ZZCL Skill S1"))
    s.check("their own job's skill, held below what their job needs: below",
            st.get("ZZCL Skill S2", {}).get("state") == "below" and st["ZZCL Skill S2"]["own"] == 3
            and st["ZZCL Skill S2"]["have"] == 2, st.get("ZZCL Skill S2"))
    s.check("a skill their job doesn't have: new, with no level of their own job",
            st.get("ZZCL Skill S7", {}).get("state") == "new" and st["ZZCL Skill S7"]["own"] is None
            and st["ZZCL Skill S7"]["have"] is None, st.get("ZZCL Skill S7"))
    s.check("...the card's count: 2 of 5 skills match", (nxt.get("match"), nxt.get("total")) == (2, 5), nxt)
    s.check("...the same states the drafted goals' gap kinds give (next = future, below = current)",
            {t: x["state"] for t, x in st.items() if x["state"] != "match"}
            == {t: {"future": "next", "current": "below", "new": "new"}[it["gap_kind"]] for t, it in k.items()},
            (st, k))
    order = [r["profile_id"] for r in cand2["roles"]]
    expect = [P[x] for x in ("ZQF-SUB-01-A-14", "ZQF-SUB-01-A-15", "ZQF-SUB-01-B-14", "ZQF-SUB-02-13",
                             "ZQF-OTH-03-13", "ZQF-OTH-01-13", "ZQG-XXX-01-13")]
    s.check("nearest first: their job's next grade, then two up, the specialisation, the sub-family, the family, "
            "HR's pick",
            order == expect, [(r["title"], r.get("route"), r.get("match")) for r in cand2["roles"]])
    s.check("...within a route, the better skills match first (OTH-03 holds 3 of 4, OTH-01 2 of 3)",
            rc.get(P["ZQF-OTH-03-13"], {}).get("match") == 3 and rc.get(P["ZQF-OTH-01-13"], {}).get("match") == 2,
            (rc.get(P["ZQF-OTH-03-13"]), rc.get(P["ZQF-OTH-01-13"])))
    sd = (shown or {}).get("render", {}).get("data", {})
    s.check("the card is told the role they already chose, so a replay shows it with its skill tree",
            sd.get("chosen_profile_id") == P["ZQF-SUB-01-A-14"], sd.get("chosen_profile_id"))
    s.check("...and the roles it draws carry their skills", sd.get("roles") and all("skills" in r for r in sd["roles"]))
    sd_c = ctx(PC, lambda d, u: a._career_tool_show_directions(d, u, CID, {}))["render"]["data"]
    s.check("someone who hasn't chosen gets no chosen role", sd_c.get("chosen_profile_id") is None, sd_c)
    hist = ctx(PA, lambda d, u: a._journey_history_response(d, u).get_json())
    s.check("a reload's history tells a replayed card (drawn before the pick) the role chosen now",
            hist.get("career_chosen") == P["ZQF-SUB-01-A-14"], hist.get("career_chosen"))
    s.check("with no competency answers at all, no role claims a state: the card keeps the plain competency list",
            sd_c.get("roles") and all(r["skills"] == [] and r["competencies"] and r["match"] == 0
                                      for r in sd_c["roles"]), sd_c.get("roles"))
    sr = ctx(PA, lambda d, u: a._career_tool_show_routes(d, u, CID, {}))
    srl = (sr.get("render") or {}).get("data", {}).get("lines") or []
    s.check("the career map's chat card names its figure a skills match, never readiness",
            srl and all("skills_match" in x and "readiness" not in x for x in srl), srl[:2])

    s.section("A demo account with a job in the architecture gets the real map (staging, 2026-10-17)")
    with a.app.test_request_context("/"):
        s.check("the harness treats ZZ + a letter as a demo account",
                a.is_demo_account(dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (PD,)).fetchone())))
    cd = ctx(PD, lambda d, u: a._career_candidate_roles(d, u))
    s.check("...holding a job code, the routed map: the next grade of its own job first, tagged",
            cd["source"] == "map" and cd["roles"] and cd["roles"][0]["profile_id"] == P["ZQF-SUB-01-A-14"]
            and cd["roles"][0].get("next_step") and all(r.get("route") for r in cd["roles"]),
            (cd["source"], [(r["title"], r.get("route")) for r in cd["roles"]]))
    ce = ctx(PE, lambda d, u: a._career_candidate_roles(d, u))
    s.check("...without one, the seeded demo roles as before (never the map)",
            ce["source"] == "demo" and any(r["profile_id"] == DEMO_ROLE for r in ce["roles"])
            and not any(r.get("route") for r in ce["roles"]), ce)
    cp = ctx(PA, lambda d, u: a._career_candidate_roles(d, u))
    s.check("...and a real person never sees a seeded demo role", not any(r["profile_id"] == DEMO_ROLE
                                                                          for r in cp["roles"]), cp["roles"])

    s.section("Never \"ready\" for a role (Chris, 2026-10-17), and every new class styled")
    import inspect
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    def _src(p):
        with open(os.path.join(root, p), encoding="utf-8") as fh:
            return fh.read()
    js, cjs, css, tpl = (_src("static/journey_chat.js"), _src("static/career_chat.js"), _src("static/style.css"),
                         _src("templates/idp_career.html"))
    s.check("the role group reads \"Move to the next role\", not \"Move to a different role\"",
            "Move to the next role" in js and "Move to a different role" not in js)
    s.check("the Career Plan's goal count reads 'filled in' (was 'complete', Chris 2026-10-17; reworded 2026-11-04; the progress list too), not ready",
            '" ready' not in js and '" complete · profile "' not in js and '" filled in · profile "' in js
            and js.count('"Career Plan — goals "') == 3 and js.count('" of " + total + " goals filled in"') == 1
            and js.count('" of " + (data.total || 0) + " goals filled in"') == 1
            and '"%d of %d filled in" % (gready, gtot)' in inspect.getsource(a._journey_idp_steps))
    s.check("...and the client hands it to a replayed direction card",
            "careerChosen: j.career_chosen" in js and "chosen_profile_id: locks.careerChosen" in js)
    s.check("a higher grade of their own job past the next one is tagged \"Further up in your job\"",
            '"Further up in your job"' in js and 'r.route === "next grade in this job"' in js)
    s.check("no \"% ready\" / \"How ready\" on a card or the career map",
            "% ready" not in js and "% ready" not in cjs and "How ready" not in cjs and "ready</s>" not in tpl
            and "Ready to step into" not in tpl and "skills match</s>" in tpl)
    s.check("the career agent is told to call its figure a skills match, never ready",
            'never \\"ready\\"' in inspect.getsource(a._career_agent_system))
    start = js.find("function careerDirectionCard(")
    body = js[start:js.find("\n  function ", start + 10)]
    import re as _re
    used = sorted(set(_re.findall(r"rv-dir-[a-z0-9-]*[a-z0-9]", body)))
    missing = [c for c in used if ("." + c) not in css]
    s.check("every rv-dir class the card draws has a style rule", start > 0 and used and not missing, missing)
    s.check("...and every state it marks (four markers, four state texts, the tree's dots)",
            all(x in css for x in (".rv-dir-mk.mk-match", ".rv-dir-mk.mk-next", ".rv-dir-mk.mk-new",
                                   ".rv-dir-mk.mk-below", ".rv-dir-lv.st-below", ".rv-dir-treestate.st-next",
                                   ".rv-dir-treestate.st-below", ".rv-dir-treestate.st-new", ".rv-dir-dot.is-held",
                                   ".rv-dir-dot.is-need", ".rv-dir-dot.is-need-new", ".rv-dir-dot.is-short")))
    s.section("the recommended next step: one grade up (Chris, 2026-10-19: \"by default, everyone should get a +1 job grade\")")
    _ca = ctx(PA, lambda d, u: a._career_candidate_roles(d, u))
    _rec = [r for r in _ca["roles"] if r.get("recommended")]
    s.check("their own job one grade up is the one recommended role, leading the list",
            len(_rec) == 1 and _ca["roles"][0] is _rec[0] and str(_rec[0]["grade"]) == "14" and _rec[0].get("next_step"),
            [(r["title"], r["grade"], r.get("recommended")) for r in _ca["roles"]][:4])
    _cc = ctx(PC, lambda d, u: a._career_candidate_roles(d, u))
    s.check("a ladder with nothing exactly one grade up recommends nothing (its next step, JG 16, still leads)",
            not any(r.get("recommended") for r in _cc["roles"]) and str(_cc["roles"][0]["grade"]) == "16"
            and _cc["roles"][0].get("next_step"), [(r["grade"], r.get("next_step")) for r in _cc["roles"]][:3])
    _cl = ctx(PL, lambda d, u: a._career_candidate_roles(d, u))
    _rl = [r for r in _cl["roles"] if r.get("recommended")]
    s.check("at JG 20 the recommendation is the leadership track one grade up, the better match of the two",
            len(_rl) == 1 and _rl[0]["route"] == "leadership track" and str(_rl[0]["grade"]) == "21"
            and _rl[0]["title"] == "ZZCL EXL-ZQL-01-21" and _cl["roles"][0] is _rl[0],
            [(r["title"], r["grade"], r.get("route"), r.get("recommended")) for r in _cl["roles"]][:4])
    s.check("the recommendation reads as one line: the role and why",
            a._career_rec_line(_rec[0]) == "We recommend ZZCL ZQF-SUB-01-A-14 (JG14), the next grade in your job."
            and "the next grade on the leadership track" in a._career_rec_line(_rl[0]))
    s.check("...and the leadership track two grades up is offered too (JG 22 for a JG 20)",
            any(r["title"] == "ZZCL EXL-ZQM-01-22" and r.get("route") == "leadership track" for r in _cl["roles"]),
            [(r["title"], r["grade"]) for r in _cl["roles"]])
    _tg = ctx(PL, lambda d, u: a._career_target_gap(d, u))
    s.check("with nothing picked, the goals aim at the recommended role", (_tg["target"] or "").startswith(
        "ZZCL EXL-ZQL-01-21"), _tg["target"])
    _ent = ctx(PL, lambda d, u: a._journey_career_entry(d, u, CID))
    s.check("the Career Plan's first line names it", _ent is not None and "We recommend ZZCL EXL-ZQL-01-21 (JG21)"
            in _ent[0] and "It's selected below; look at any role's skill tree, then Confirm" in _ent[0],
            _ent and _ent[0])
    _JS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "journey_chat.js"),
               encoding="utf-8").read()
    s.check("the card tags it Recommended",
            'if (r.recommended) tag.textContent = "Recommended \\u00b7 " + tag.textContent.toLowerCase();' in _JS)

    s.section("Two roles are never a career path: Executive Chairman and Board Advisor To Ec And Bgceo (Chris, 2026-11-05)")
    with a.app.app_context():
        _db = a.get_db()
        _mk = {}
        # the last row SHARES the Chairman's job code (as the real architecture does: EXL-GM-01-23 also holds the Group
        # CEO); the unique index is on (job_code, job_scope), so it has its own scope. Key "SIB" in _mk.
        for _key, _jc, _title, _scope in (
                ("EXL-ZQN-00-22", "EXL-ZQN-00-22", "ZZCL BU CEO role", None),
                ("EXL-ZQN-01-23", "EXL-ZQN-01-23", "Executive Chairman", None),
                ("EXL-ZQN-02-23", "EXL-ZQN-02-23", "  board  ADVISOR to Ec And Bgceo ", None),
                ("EXL-ZQN-03-23", "EXL-ZQN-03-23", "ZZCL Other 23", None),
                ("SIB", "EXL-ZQN-01-23", "ZZCL Group CEO role", "ZZCL Sibling")):
            _pid = _db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, job_scope, "
                               "plan_mode, source, active) VALUES ('ZZCL Sub', ?, ?, ?, ?, 'explicit', "
                               "'architecture', 1)", (_title, _jc.rsplit("-", 1)[1], _jc, _scope)).lastrowid
            for _i, _t in enumerate(FIVE):
                _db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, "
                            "is_future) VALUES (?,?,5,?,0)", (_pid, SK[(_t, 5)], _i))
            _mk[_key] = _pid
        # HR pinned the Executive Chairman for the BU CEO role: a pin must not bring it back
        _db.execute("INSERT INTO tc_career_routes(from_profile_id, to_profile_id, kind) VALUES (?,?, 'pinned')",
                    (_mk["EXL-ZQN-00-22"], _mk["EXL-ZQN-01-23"]))
        _db.execute("INSERT INTO ja_people(employee_id, family_code, sub_code, spec_code, unit_code, job_scope, "
                    "arch_grade, source) VALUES ('ZZ9CL-N', 'EXL', 'EXL-ZQN', 'EXL-ZQN-00', 'EXL-ZQN-00', 'ZZCL', '22', "
                    "'test')")
        _base = dict(_db.execute("SELECT * FROM users WHERE employee_id='ZZ9CL-A'").fetchone())
        _base.pop("id")
        _base.update(username="zz9cl-n", employee_id="ZZ9CL-N", full_name="ZZ CL N", job_grade=22)
        _db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(_base), ",".join("?" * len(_base))),
                    list(_base.values()))
        _db.commit()
        PN = _db.execute("SELECT id FROM users WHERE employee_id='ZZ9CL-N'").fetchone()[0]
    _EC, _BA, _OT = _mk["EXL-ZQN-01-23"], _mk["EXL-ZQN-02-23"], _mk["EXL-ZQN-03-23"]
    _me = ctx(PN, lambda d, u: a.tc_profile_for_user(d, u)[0])
    s.check("the JG 22 person resolves to their architecture profile", _me and _me["id"] == _mk["EXL-ZQN-00-22"], _me)
    _codes = lambda: [r["profile"]["job_code"] for r in ctx(PN, lambda d, u: a.tc_career_routes_for(d, _me, limit=40))]
    _titles = lambda: [r["profile"]["job_title"] for r in ctx(PN, lambda d, u: a.tc_career_routes_for(d, _me, limit=40))]
    _roles = lambda: [r["profile_id"] for r in ctx(PN, lambda d, u: a._career_candidate_roles(d, u))["roles"]]
    _rc = _codes()
    _rt0 = _titles()
    s.check("the Executive Chairman and the Board Advisor are not routes, even with HR's pin on the Chairman; another "
            "JG 23 role still is", "Executive Chairman" not in _rt0 and "  board  ADVISOR to Ec And Bgceo " not in _rt0
            and "EXL-ZQN-02-23" not in _rc and "EXL-ZQN-03-23" in _rc, (_rc, _rt0))
    _rt = _titles()
    s.check("a role that SHARES the Chairman's job code is still a route (the Chairman, by title, is not)",
            "ZZCL Group CEO role" in _rt and "Executive Chairman" not in _rt, _rt)
    _rl = _roles()
    s.check("...nor candidate roles of the Career Plan page and chat", _EC not in _rl and _BA not in _rl and _OT in _rl,
            _rl)
    # set_direction: the chat refuses them by name, accepts the other
    _wc, _cl = a.window_closed, a._career_locked
    a.window_closed = lambda *x, **k: None
    a._career_locked = lambda *x, **k: False
    try:
        _no = ctx(PN, lambda d, u: a._career_tool_set_direction(d, u, CID, {"choice": "Executive Chairman"}))
        _no2 = ctx(PN, lambda d, u: a._career_tool_set_direction(d, u, CID, {"choice": "Board Advisor To Ec And Bgceo"}))
        _ok = ctx(PN, lambda d, u: a._career_tool_set_direction(d, u, CID, {"choice": "ZZCL Other 23"}))
        _tp = H.one(a, "SELECT target_profile_id FROM pm_career_profile WHERE subject_id=?", (PN,))
        s.check("set_direction refuses both by name and accepts the other JG 23 role",
                not _no["ok"] and not _no2["ok"] and _ok["ok"] and _tp == _OT, (_no, _no2, _ok, _tp))
        # falsify: with the guard off the Chairman is offered, pinned or not, and set_direction takes him
        _g = a.tc_not_a_career_route
        a.tc_not_a_career_route = lambda profile: False
        try:
            _fc, _fr = _codes(), _roles()
            _fo = ctx(PN, lambda d, u: a._career_tool_set_direction(d, u, CID, {"choice": "Executive Chairman"}))
        finally:
            a.tc_not_a_career_route = _g
        # falsify the title-only rule: the OLD behaviour (job code OR title) hides the code-sharing sibling
        _old_codes = frozenset({"EXL-GM-01-23", "EXL-GM-02-23", "EXL-ZQN-01-23", "EXL-ZQN-02-23"})
        _g2 = a.tc_not_a_career_route
        a.tc_not_a_career_route = lambda profile: (
            (profile["job_code"] or "").strip().upper() in _old_codes
            or " ".join((profile["job_title"] or "").split()).lower() in a.TC_NOT_A_CAREER_ROUTE_TITLES)
        try:
            _ot = _titles()
        finally:
            a.tc_not_a_career_route = _g2
        s.check("falsified: with the old code-or-title rule the sibling that shares the Chairman's code disappears",
                "ZZCL Group CEO role" not in _ot and "ZZCL Group CEO role" in _titles(), _ot)
        s.check("falsified: without the helper both roles appear in the routes and candidate roles, and the chat "
                "accepts the Chairman", "EXL-ZQN-01-23" in _fc and "EXL-ZQN-02-23" in _fc and _EC in _fr and _BA in _fr
                and _fo["ok"], (_fc, _fo))
    finally:
        a.window_closed, a._career_locked = _wc, _cl
    # the admin role pick takes the same list: the Chairman is not among the picks
    s.check("the admin role pick's list (candidate roles) cannot hold the Chairman", _EC not in _roles())
    # the helper: by title only, case and spaces ignored
    s.check("a job code alone never hides a role: the Group CEO and Group Chief Transformation Officer share the "
            "Chairman's code, the Managing Director the Board Advisor's",
            not a.tc_not_a_career_route({"job_code": "EXL-GM-01-23", "job_title": "Group Chief Executive Officer"})
            and not a.tc_not_a_career_route({"job_code": "EXL-GM-01-23", "job_title": "Group Chief Transformation Officer"})
            and not a.tc_not_a_career_route({"job_code": "EXL-GM-02-23", "job_title": "Managing Director"}))
    s.check("...a title hides it, any case and spacing, and nothing else",
            a.tc_not_a_career_route({"job_code": "EXL-NEW-01-23", "job_title": "EXECUTIVE   chairman"})
            and a.tc_not_a_career_route({"job_code": None, "job_title": "Board Advisor To Ec And Bgceo"})
            and not a.tc_not_a_career_route({"job_code": "EXL-GM-03-23", "job_title": "Executive Chairman's Office Lead"})
            and not a.tc_not_a_career_route({"job_code": None, "job_title": None}))
    # the legacy overlap scan (no job code) skips them too
    with a.app.app_context():
        _db = a.get_db()
        _leg = {}
        for _t in ("ZZCL Legacy Source", "Executive Chairman"):
            _leg[_t] = _db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, source, active) "
                                   "VALUES ('ZZCL Legacy', ?, '14', 'test', 1)", (_t,)).lastrowid
            for _i, _tt in enumerate(FIVE):
                _db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, sort_order) VALUES (?,?,?)",
                            (_leg[_t], SK[(_tt, 3)], _i))
        _db.commit()
    try:
        _src = ctx(PA, lambda d, u: dict(d.execute("SELECT * FROM tc_job_profiles WHERE id=?", (_leg["ZZCL Legacy Source"],))
                                         .fetchone()))
        _lr = lambda: [r["profile"]["id"] for r in ctx(PA, lambda d, u: a.tc_career_routes_for(d, _src, limit=40))]
        _legacy = _lr()
        _g = a.tc_not_a_career_route
        a.tc_not_a_career_route = lambda profile: False
        try:
            _legacy_off = _lr()
        finally:
            a.tc_not_a_career_route = _g
        s.check("the legacy overlap scan skips a profile titled Executive Chairman; without the helper it offers it",
                _leg["Executive Chairman"] not in _legacy and _leg["Executive Chairman"] in _legacy_off,
                (_legacy, _legacy_off))
    finally:
        with a.app.app_context():
            _db = a.get_db()
            for _pid in _leg.values():
                _db.execute("DELETE FROM tc_job_profile_skills WHERE profile_id=?", (_pid,))
                _db.execute("DELETE FROM tc_job_profiles WHERE id=?", (_pid,))
            _db.commit()

finally:
    with a.app.app_context():
        d = a.get_db()
        _cleanup(d)
        d.execute("UPDATE cycles SET half=? WHERE id=?", (KEEP["half"], CID))
        for mk_, act in KEEP["mods"].items():
            d.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (act, CID, mk_))
        d.commit()

sys.exit(s.done())
