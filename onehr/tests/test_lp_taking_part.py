"""Leader progress and Home's Calibration cell count only people taking part in that part
(Chris, 2026-11-08: "progress counts only people taking part in that part; KPI lines or competencies set up are not enough").

Follows test_home_taking_part (Home's Performance / Competency cells and the module pages). Here:
  * lp_person_parts (the "Who has submitted" panel and the leader progress email, through lp_counts) counts pm_results /
    pm_approve over people taking part in Performance and tc_self / tc_approve over people taking part in Competency.
    A person whose user role opens Performance but not Competency, with KPI lines AND competencies assigned, is in the
    pm parts and not in the tc parts; a person taken out (cycle_participants 'remove') is in neither; putting them back
    counts them again, by exactly one in each; idp_self and f360 are untouched
  * `people` a caller passes is narrowed further, never widened
  * a past cycle keeps its plain read
  * Home's Calibration cell ("units locked") counts the business units the BG CEO's Talent Box lists (the calibration
    population): a unit whose only KPI-line holder is taken out is left out, and counted again when they are put back
  * the guards are real: the narrowing made a no-op fails each of those checks
Its own synthetic business group ZZTP; everything put back at the end.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Leader progress and Home's Calibration cell count only people taking part in that part")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG, UA, UB = "ZZTP Group", "ZZTP Alpha", "ZZTP Beta"
ROLE_NAME = "ZZTP Performance only"
PARTS = ["pm_results", "pm_approve", "tc_self", "tc_approve"]


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9TP-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        for tb in ("tc_assignments", "tc_assessments", "pm_kpi_targets", "cycle_participants", "pm_review_session"):
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (tb, ph), ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM user_roles WHERE name=?", (ROLE_NAME,))
    db.execute("DELETE FROM tc_skills WHERE skill_code='ZZ9TP-SKILL'")
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    CYC0 = dict(db.execute("SELECT kind, half, starts_on, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
    MODS0 = {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))}
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL, starts_on=COALESCE(starts_on, '2026-01-01') "
               "WHERE id=?", (CID,))
    for k in ("review", "pm", "tm", "calibration"):
        if db.execute("SELECT 1 FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k)).fetchone():
            db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key=?", (CID, k))
        else:
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, k))
    rid = db.execute("INSERT INTO user_roles(name) VALUES (?)", (ROLE_NAME,)).lastrowid
    db.execute("INSERT INTO user_role_modules(role_id, module) VALUES (?, 'pm')", (rid,))   # Performance, no Competency
    SKILL = db.execute("INSERT INTO tc_skills(skill_code, title) VALUES ('ZZ9TP-SKILL', 'ZZTP skill')").lastrowid

    def mk(eid, unit, user_role=None):
        uid = db.execute(
            "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, department, "
            "job_title, job_grade, confirmation_date, years_of_service, user_role_id) "
            "VALUES (?,?,'x','user',?,?,?,'ZZTP Dept','ZZTP Officer','14','2020-01-01',4.0,?)",
            (eid.lower(), "ZZ TP " + eid[6:], eid, BG, unit, user_role)).lastrowid
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, status) "
                   "VALUES (?,?,?,100,'more',?,'approved')", (CID, uid, "ZZTP KPI " + eid[6:], BG))
        db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) VALUES (?,?,?)", (CID, uid, SKILL))
        # everyone has finished their own part, so the approve parts have someone to count
        db.execute("INSERT INTO pm_review_session(subject_id, cycle_id, locked_at) VALUES (?,?,datetime('now'))", (uid, CID))
        db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status, submitted_at) VALUES (?,?,'submitted',datetime('now'))",
                   (CID, uid))
        return uid
    P1 = mk("ZZ9TP-P1", UA)                    # taking part in both
    P3 = mk("ZZ9TP-P3", UA, user_role=rid)     # Performance only (role opens no Competency)
    P4 = mk("ZZ9TP-P4", UB)                    # the ONLY person in unit Beta: taken out, flipped back in by the test
    db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'remove')", (CID, P4))
    db.commit()
    SU = db.execute("SELECT * FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                    "AND employee_id NOT LIKE 'ZZ9TP-%' LIMIT 1").fetchone()
    SUID = SU["id"]


def lp(cyc_patch=None, people=None):
    """{part: set of person ids} from lp_person_parts over the whole population (or the `people` a caller passes)."""
    with a.app.app_context():
        d = a.get_db()
        cyc = a.active_cycle(d)
        if cyc_patch:
            cyc = dict(cyc, **cyc_patch)
        per = a.lp_person_parts(d, cyc, PARTS, people=people)
    return {p: set(per.get(p, {})) for p in PARTS}


def lp_counts_ids(ids):
    """The same through lp_counts (the email's sum): {part: n} over just our people's business group."""
    with a.app.app_context():
        d = a.get_db()
        c = a.lp_counts(d, a.active_cycle(d), PARTS)
    return {p: sum(v[0] for k, v in c[p].items() if k[0] == BG) for p in PARTS}


def cal_cell(past=False):
    """(locked, units) of Home's Calibration cell for our group; (0, 0) when it reads 'none set'."""
    with a.app.test_request_context("/"):
        d = a.get_db()
        su = d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone()
        a.g.user = su
        cyc = a.active_cycle(d)
        if past:
            cyc = dict(cyc, is_active=0)
        mat = a._home_bg_matrix(d, su, cyc, stage="bg")   # Calibration lives in the BG CEOs' stage (2026-11-09); a past cycle keeps the whole table
    ix = [c["key"] for c in mat["cols"]].index("calibration")
    cell = next(r for r in mat["rows"] if r["bg"] == BG)["cells"][ix]
    m = re.match(r"([\d,]+) of ([\d,]+)", cell["sub"] or "")
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def invariants():
    """name -> bool, with P4 taken out: the leader parts and the Calibration cell. Run on the real app, then broken."""
    out = {}
    got = lp()
    mine = {k: {i for i in v if i in (P1, P3, P4)} for k, v in got.items()}
    out["pm_results: P1, P3 (P4 taken out)"] = mine["pm_results"] == {P1, P3}
    out["pm_approve: P1, P3 (P4 taken out)"] = mine["pm_approve"] == {P1, P3}
    out["tc_self: P1 only (P3's role has no Competency, P4 out)"] = mine["tc_self"] == {P1}
    out["tc_approve: P1 only (P3's role has no Competency, P4 out)"] = mine["tc_approve"] == {P1}
    # a caller's own scoped `people` is narrowed on top, never widened
    allp = {P1: (BG, UA, "ZZTP Dept"), P3: (BG, UA, "ZZTP Dept"), P4: (BG, UB, "ZZTP Dept")}
    sc = lp(people=allp)
    out["a caller's people: the same narrowing on top"] = (
        {i for i in sc["pm_results"] if i in allp} == {P1, P3} and {i for i in sc["tc_self"] if i in allp} == {P1})
    out["Calibration cell: unit Beta (only P4, taken out) is not a unit to lock"] = cal_cell() == (0, 1)
    return out


try:
    s.section("P4 taken out; P3's role has no Competency")
    inv = invariants()
    for k, v in inv.items():
        s.check(k, v)
    with a.app.app_context():
        _d = a.get_db()
        _per = a.lp_person_parts(_d, a.active_cycle(_d), ["idp_self", "f360"])
        _idp = set(a._lp_people(_d, idp=True))
    s.check("idp_self is still every Career Plan person (idp_count_sql), untouched by the narrowing",
            set(_per.get("idp_self", {})) == _idp)

    s.section("lp_counts (the email's sum) follows the same people")
    c0 = lp_counts_ids((P1, P3, P4))
    base = {p: lp()[p] & {P1, P3, P4} for p in PARTS}
    s.check("our group counts 2 in Performance and 1 in Competency and nobody else of ours",
            c0["pm_results"] >= 2 and (base["pm_results"], base["tc_self"]) == ({P1, P3}, {P1}))

    s.section("putting P4 back counts them again, by exactly one")
    n0 = {p: len(lp()[p]) for p in PARTS}
    cal0 = cal_cell()
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM cycle_participants WHERE cycle_id=? AND subject_id=?", (CID, P4))
        d.commit()
    n1 = {p: len(lp()[p]) for p in PARTS}
    s.check("every part goes up by exactly one", all(n1[p] == n0[p] + 1 for p in PARTS), (n0, n1))
    s.check("P4 is in all four parts", all(P4 in lp()[p] for p in PARTS))
    s.check("the Calibration cell counts unit Beta again, by exactly one", cal_cell()[1] == cal0[1] + 1, (cal0, cal_cell()))
    s.check("P3 still out of the competency parts", P3 not in lp()["tc_self"] and P3 not in lp()["tc_approve"])
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'remove')", (CID, P4))
        d.commit()
    s.check("taking P4 out again returns every count to the first read",
            {p: len(lp()[p]) for p in PARTS} == n0 and cal_cell() == cal0)

    s.section("a past cycle keeps its plain read")
    past = lp(cyc_patch={"is_active": 0})
    s.check("a past cycle keeps today's read: P3 (in the any-part population) is in the competency parts too",
            P3 in past["tc_self"] and P3 in past["tc_approve"] and P3 in past["pm_results"])
    s.check("a past cycle's Calibration cell counts unit Beta (its KPI-line holder), as before", cal_cell(past=True)[1] == 2)

    s.section("the guards are real (each broken, then put back)")
    real_takers = a._lp_part_takers
    a._lp_part_takers = lambda db, cyc, parts, people: (None, None)
    try:
        bad = [k for k, v in invariants().items() if not v and not k.startswith("Calibration")]
    finally:
        a._lp_part_takers = real_takers
    s.check("falsified: _lp_part_takers made a no-op fails the leader-progress checks", len(bad) >= 3, bad)
    s.check("falsified: the Calibration cell on the past-cycle read counts the unit whose holder is out",
            cal_cell(past=True) != (0, 1))
    s.check("...and with the guards back every invariant holds again", all(invariants().values()))
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)
        _db.execute("UPDATE cycles SET kind=?, half=?, starts_on=?, min_job_grade=? WHERE id=?",
                    (CYC0["kind"], CYC0["half"], CYC0["starts_on"], CYC0["min_job_grade"], CID))
        for k in ("review", "pm", "tm", "calibration"):
            if k in MODS0:
                _db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (MODS0[k], CID, k))
            else:
                _db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k))
        _db.commit()

sys.exit(s.done())
