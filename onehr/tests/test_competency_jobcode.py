"""Competency profiles keyed to the job architecture's job codes (Chris, 2026-10-17; plan Phase 1b).

A person with a job code (ja_people role + their live JG) is resolved by it alone: the profile P&R reviewed for that
exact job, or none (unmapped), never a title guess. An architecture profile is planned explicitly: its stored current
rows and stored future rows (the next level, or the next role's new competency) are what the person is assessed on.
Legacy profiles keep working exactly as before. A future row is never read as a current requirement. An architecture
profile is changed in the mapping file, so the admin page's skill picker and Remove refuse it. JG 24/25 have a weight
row. Everything here is synthetic (ZZTC-*) and removed at the end.
"""
import html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Competency by job code -- resolution, explicit current + future plans, the guards")

BG, CO = "ZZTC BG", "ZZTC CO"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZTC-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM tc_assignments WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM ja_people WHERE employee_id LIKE 'ZZTC-%'")
    db.execute("DELETE FROM tc_job_profile_skills WHERE profile_id IN (SELECT id FROM tc_job_profiles WHERE "
               "job_title LIKE 'ZZTC%')")
    db.execute("DELETE FROM tc_job_profiles WHERE job_title LIKE 'ZZTC%'")
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZTC-%'")
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, title, grade, dept="ZZTC Dept"):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ TC " + eid[-1], email=None,
                 job_grade=grade, job_title=title, department=dept, business_group=BG, company=CO, left_at=None,
                 is_demo=0, role="user", manager_id=None, hod_id=None, buceo_bg=None, buceo_company=None,
                 bgceo_bg=None, admin_bg=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    def skill(code, title, level):
        db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, active) "
                   "VALUES (?,?,?,?,?,1)", (code, title, level, "tsc", "ZZTC Cat"))
        return db.execute("SELECT id FROM tc_skills WHERE skill_code=?", (code,)).fetchone()[0]
    SK = {}
    for t in ("Alpha", "Bravo", "Charlie"):
        for lv in (2, 3, 4):
            SK[(t, lv)] = skill("ZZTC-%s-%d" % (t[:3].upper(), lv), "ZZTC " + t, lv)
    SK[("Delta", 3)] = skill("ZZTC-DEL-3", "ZZTC Delta", 3)      # the next role's new competency

    def profile(dept, title, grade, job_code=None, plan_mode=None):
        db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, plan_mode, source, active) "
                   "VALUES (?,?,?,?,?,?,1)", (dept, title, grade, job_code, plan_mode, "test"))
        return db.execute("SELECT id FROM tc_job_profiles WHERE department=? AND job_title=? AND job_grade=?",
                          (dept, title, grade)).fetchone()[0]
    # the architecture's profile for ZZTC-UNIT-A at JG 14: 2 current (Alpha 2, Bravo 2) + 3 future (Alpha 3, Bravo 3,
    # and Delta 3, a new competency with no current pair)
    ARCH = profile("ZZTC Sub", "ZZTC ARCH EXECUTIVE", "14", job_code="ZZTC-UNIT-A-14", plan_mode="explicit")
    for i, (k, fut) in enumerate(((("Alpha", 2), 0), (("Bravo", 2), 0), (("Alpha", 3), 1), (("Bravo", 3), 1),
                                  (("Delta", 3), 1))):
        db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, sort_order, is_future) VALUES (?,?,?,?)",
                   (ARCH, SK[k], i, fut))
    # a legacy profile that shares the arch person's TITLE: the fuzzy steps must never hand it to them
    LEG = profile("ZZTC Dept", "ZZTC LEGACY TITLE", "13")
    db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, sort_order) VALUES (?,?,0)", (LEG, SK[("Charlie", 2)]))
    P = {"arch": mk("ZZTC-A", "ZZTC LEGACY TITLE", 14), "nojob": mk("ZZTC-B", "ZZTC LEGACY TITLE", 15),
         "legacy": mk("ZZTC-C", "ZZTC LEGACY TITLE", 13), "fuzzy": mk("ZZTC-D", "ZZTC LEGACY TITLE", 13, dept="Other"),
         # no architecture row, but the arch profile's exact department + title + grade: it must not be handed over
         "lookalike": mk("ZZTC-E", "ZZTC ARCH EXECUTIVE", 14, dept="ZZTC Sub")}
    db.execute("INSERT INTO ja_people(employee_id, family_code, sub_code, spec_code, unit_code, job_scope, arch_grade, "
               "source) VALUES ('ZZTC-A','ZZF','ZZF-S','ZZTC-SPEC','ZZTC-UNIT-A','ARCH','14','test'),"
               "('ZZTC-B','ZZF','ZZF-S','ZZTC-SPEC','ZZTC-UNIT-A','ARCH','15','test')")
    # one job code holding two job scopes (2026-10-18): a profile each, and three people on the code
    SC1 = profile("ZZTC Sub", "ZZTC SCOPE ONE EXECUTIVE", "14", job_code="ZZTC-UNIT-S-14", plan_mode="explicit")
    db.execute("UPDATE tc_job_profiles SET job_scope='SCOPE ONE' WHERE id=?", (SC1,))
    SC2 = profile("ZZTC Sub", "ZZTC SCOPE TWO EXECUTIVE", "14", job_code="ZZTC-UNIT-S-14", plan_mode="explicit")
    db.execute("UPDATE tc_job_profiles SET job_scope='SCOPE TWO' WHERE id=?", (SC2,))
    for k, eid_, sc in (("s_one", "ZZTC-S1", "scope one"), ("s_two", "ZZTC-S2", "SCOPE TWO"),
                        ("s_other", "ZZTC-S3", "SCOPE THREE")):
        P[k] = mk(eid_, "ZZTC SCOPE TITLE", 14)
        db.execute("INSERT INTO ja_people(employee_id, family_code, sub_code, spec_code, unit_code, job_scope, "
                   "arch_grade, source) VALUES (?, 'ZZF','ZZF-S','ZZTC-SPEC','ZZTC-UNIT-S', ?, '14', 'test')",
                   (eid_, sc))
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def u(k):
    return ctx(lambda d: d.execute("SELECT * FROM users WHERE id=?", (P[k],)).fetchone())


sup = H.client_as(a, SUP)
try:
    s.section("Who gets which profile")
    r = {k: ctx(lambda d, k=k: a.tc_profile_for_user(d, u(k))) for k in P}
    s.check("someone with a job code gets the profile reviewed for that exact job",
            r["arch"][0] and r["arch"][0]["id"] == ARCH and r["arch"][1] == "job_code", r["arch"])
    s.check("...and with no profile for their code, none: never the legacy profile sharing their title",
            r["nojob"] == (None, None), r["nojob"])
    s.check("someone with no architecture row still resolves the legacy way", r["legacy"][0]
            and r["legacy"][0]["id"] == LEG and r["legacy"][1] == "roster", r["legacy"])
    s.check("someone with no architecture row is never handed an architecture profile by its title",
            r["lookalike"] == (None, None), r["lookalike"])
    s.check("...the loose title step still works for legacy profiles", r["fuzzy"][0] and r["fuzzy"][0]["id"] == LEG
            and r["fuzzy"][1] in ("title_grade", "title"), r["fuzzy"])
    ctx(lambda d: (d.execute("UPDATE tc_job_profiles SET job_title='ZZTC LEGACY TITLE', job_grade='13', "
                             "department='Elsewhere' WHERE id=?", (ARCH,)), d.commit()))
    fz = ctx(lambda d: a.tc_profile_for_user(d, u("fuzzy")))
    s.check("...but a loose step never lands on an architecture profile, even with the same title and grade",
            fz[0] and fz[0]["id"] == LEG, fz)
    ctx(lambda d: (d.execute("UPDATE tc_job_profiles SET job_title='ZZTC ARCH EXECUTIVE', job_grade='14', "
                             "department='ZZTC Sub' WHERE id=?", (ARCH,)), d.commit()))

    s.section("A job code with a profile per job scope (2026-10-18)")
    rs = {k: ctx(lambda d, k=k: a.tc_profile_for_user(d, u(k))) for k in ("s_one", "s_two", "s_other")}
    s.check("each person gets their own scope's profile, whatever the case of the scope",
            rs["s_one"][0] and rs["s_one"][0]["id"] == SC1 and rs["s_two"][0] and rs["s_two"][0]["id"] == SC2,
            {k: v[0] and v[0]["id"] for k, v in rs.items()})
    s.check("...a scope with no profile of its own gets the code's first (the mapping lists the most-held first)",
            rs["s_other"][0] and rs["s_other"][0]["id"] == SC1, rs["s_other"][0] and rs["s_other"][0]["id"])
    ctx(lambda d: (d.execute("UPDATE tc_job_profiles SET job_scope=NULL WHERE id=?", (SC2,)), d.commit()))
    ro = ctx(lambda d: a.tc_profile_for_user(d, u("s_other")))
    s.check("...or its scope-less profile, which is for anyone on the code", ro[0] and ro[0]["id"] == SC2,
            ro[0] and ro[0]["id"])
    ctx(lambda d: (d.execute("UPDATE tc_job_profiles SET job_scope='SCOPE TWO' WHERE id=?", (SC2,)), d.commit()))

    s.section("The plan: what P&R reviewed, current and future")
    plan = ctx(lambda d: a.tc_profile_plan(d, ARCH))
    by = {sid: (fut, seq) for sid, fut, seq in plan}
    s.check("an explicit profile is assessed on exactly its stored rows: 2 current + 3 future",
            len(plan) == 5 and sum(1 for _s, f, _q in plan if f == 0) == 2 and sum(1 for _s, f, _q in plan if f) == 3,
            plan)
    s.check("...a future level sits beside its current skill (same seq)", by[SK[("Alpha", 3)]][1] == by[SK[("Alpha", 2)]][1]
            and by[SK[("Bravo", 3)]][1] == by[SK[("Bravo", 2)]][1], by)
    s.check("...the next role's new competency follows the current ones", by[SK[("Delta", 3)]] == (1, 2), by)
    lplan = ctx(lambda d: a.tc_profile_plan(d, LEG))
    s.check("a legacy profile is unchanged: its skill now, the same title a level up as the stretch",
            sorted((sid, fut) for sid, fut, _q in lplan) == sorted([(SK[("Charlie", 2)], 0), (SK[("Charlie", 3)], 1)]),
            lplan)
    sm = ctx(lambda d: a.tc_profile_skill_map(d, ARCH))
    s.check("a future row is never read as a current requirement", sm == {"ZZTC Alpha": 2, "ZZTC Bravo": 2}, sm)
    titles = ctx(lambda d: a._profile_skill_titles(d, ARCH))
    s.check("...nor listed as one", titles == ["ZZTC Alpha", "ZZTC Bravo"], titles)

    s.section("The generator assigns the reviewed plan")
    rep = ctx(lambda d: a.tc_generate_assignments(d, d.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone(),
                                                  a.active_cycle(d)["id"], commit=False))
    mine = {e["employee_id"]: e for e in rep["assign"] if (e["employee_id"] or "").startswith("ZZTC-")}
    unm = {e["employee_id"] for e in rep["unmapped"] if (e["employee_id"] or "").startswith("ZZTC-")}
    nopart = {e["employee_id"] for e in rep["not_part"] if (e["employee_id"] or "").startswith("ZZTC-")}
    s.check("the architecture person: their 5 reviewed competencies, by job code (or not taking part this cycle)",
            ("ZZTC-A" in mine and mine["ZZTC-A"]["n_skills"] == 5 and mine["ZZTC-A"]["source"] == "job_code")
            or "ZZTC-A" in nopart, (mine.get("ZZTC-A"), sorted(nopart)))
    s.check("...and the one whose job code has no profile is listed unmapped", "ZZTC-B" in unm or "ZZTC-B" in nopart,
            (sorted(unm), sorted(nopart)))

    s.section("An architecture profile is changed in the mapping file")
    r1 = sup.post("/admin/competency/profiles", data={"csrf_token": "tok", "action": "set_skills", "profile_id": ARCH,
                                                      "skill": [SK[("Charlie", 2)]]}, follow_redirects=True)
    s.check("the skill picker refuses it, and nothing changes", "comes from the job architecture" in html.unescape(
        r1.get_data(as_text=True)) and len(ctx(lambda d: a.tc_profile_plan(d, ARCH))) == 5)
    r2 = sup.post("/admin/competency/profiles", data={"csrf_token": "tok", "action": "remove_profile",
                                                      "profile_id": ARCH}, follow_redirects=True)
    s.check("Remove refuses it (a delete would cascade its skills and routes away)", "deactivate it" in html.unescape(
        r2.get_data(as_text=True)) and H.one(a, "SELECT COUNT(*) FROM tc_job_profiles WHERE id=?", (ARCH,)) == 1)
    sup.post("/admin/competency/profiles", data={"csrf_token": "tok", "action": "toggle_active", "profile_id": ARCH})
    s.check("...deactivating it is fine", H.one(a, "SELECT active FROM tc_job_profiles WHERE id=?", (ARCH,)) == 0)
    sup.post("/admin/competency/profiles", data={"csrf_token": "tok", "action": "remove_profile", "profile_id": LEG})
    s.check("a legacy profile can still be removed", H.one(a, "SELECT COUNT(*) FROM tc_job_profiles WHERE id=?",
                                                          (LEG,)) == 0)

    s.section("Odds and ends")
    s.check("JG 24 and 25 have a weight row (they read as 100:0 before)",
            H.one(a, "SELECT COUNT(*) FROM tc_band_weights WHERE job_grade IN ('24','25')") == 2)
    s.check("one profile a job code and job scope: the old one-a-code index is gone, the code + scope one in place",
            H.one(a, "SELECT COUNT(*) FROM sqlite_master WHERE name='idx_tc_profiles_job_code'") == 0
            and H.one(a, "SELECT COUNT(*) FROM sqlite_master WHERE name='idx_tc_profiles_job_code_scope'") == 1)
    import sqlite3 as _sq

    def _dup(scope):
        try:
            ctx(lambda d: d.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, job_scope, "
                                    "source, active) VALUES ('ZZTC Sub', 'ZZTC DUP', '14', 'ZZTC-UNIT-S-14', ?, "
                                    "'test', 1)", (scope,)))
            return "inserted"
        except _sq.IntegrityError:
            return "refused"
    s.check("...a second profile for the same code and scope is refused", _dup("SCOPE ONE") == "refused")
    import inspect as _insp
    s.check("...and the migration drops the old one-a-code index on a database that still has it (it would refuse a "
            "code's second scope)", 'DROP INDEX IF EXISTS idx_tc_profiles_job_code"' in _insp.getsource(
                a._ensure_runtime_schema))
finally:
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
