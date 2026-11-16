"""Profile guards, piece 2 (Chris, 2026-11-08): the Data integrity checks "After a change to someone's details", and the
submitted-360 display fix.

WHY. The guards that run when an admin edits a person's details or imports the roster catch most of what follows a move of
business group, unit, department, grade or title. A script, an old import or a direct edit catches none of it. These checks
list what such a change leaves behind (read only, the super admin's page), so it is found before a review hits it. And a
SUBMITTED 360 rating used to list its subject's LIVE tier's statements with the answers it holds hidden (audit B G8); it now
lists the statements its answers hold.

HOW EACH CHECK IS TESTED (synthetic ZZPD-* people on a fresh scratch database; Suite.done() puts it back):
  * the drift is made by a direct UPDATE / INSERT (that is the path these checks exist for), the check lists that person with
    the right words in its detail, and a clean person, built the same way, is not listed
  * where a rule has an exception (a pending line, a rating line, a guest, a Group People hand-match, a frozen record, a unit
    held as "everyone left", a moderator's line already filled by an admin) the exception person is built too and not listed
  * a person who is out of the page's scope (a leaver, an admin, a demo account) is never listed
  * the checks are one read each: the page's counts, lists and Excel come out of the same rows
  * every check is falsified by hand (see the report that came with the commit): breaking its condition turns this suite red
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Profile guards piece 2: the 'After a change to someone's details' checks and the submitted-360 display")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, EMP = H.actors(a)


def ck(name, cond, detail=""):
    """s.check, showing its detail only when it fails (a long list of people helps nobody on a pass)."""
    return s.check(name, cond, "" if cond else detail)


NEW_KEYS = ["kpi_other_group", "bu_kpi_wrong_setup", "kpi_line_unit_off", "rating_record_stale", "gradeh_kpi_other_unit",
            "calib_pick_off_unit", "leaver_hod", "leaver_seat", "leaver_kpi_moderator", "leaver_gradeh",
            "unit_out_drift", "no_competency_set", "tc_set_off_job", "gradeh_not_on_list",
            "gradeh_list_not_h", "live_360_not_rated", "assessor_not_eligible", "bu_kpi_weight_off_grade",
            "career_target_off_grade"]


def found_list(key, me=None):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = SU["id"]
        d = a.get_db()
        rows, _cap = a.data_check_rows(d, me or SU, a.active_cycle_id(d), a.DATA_CHECKS_BY_KEY[key], cap=False)
        return [(r["eid"], r["detail"]) for r in rows]


def mine(f):
    """What a check found among this suite's own people (the fixture database holds others)."""
    return sorted(e for e in f if str(e).startswith("ZZPD"))


def found(key):
    return dict(found_list(key))


def counts():
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = SU["id"]
        d = a.get_db()
        return {c["key"]: c["count"] for c in a.data_check_counts(d, SU, a.active_cycle_id(d))}


# ---- the fixture ------------------------------------------------------------------------------------------------------
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    BASE = counts()
    BGN, BGB, BGA = "Northwind Materials", "Beacon Construction", "Atlas Property"
    NB, NL = "Northwind Building Supplies Sdn Bhd", "Northwind Logistics Sdn Bhd"
    BE = "Beacon Engineering Sdn Bhd"
    MADE = {"users": [], "extra": []}

    def mk(eid, bg=BGN, co=NB, grade=14, dept="ZZPD Ops", title="ZZPD Analyst", mgr=None, hod=None, left=None, role="user",
           demo=0):
        uid = db.execute(
            "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, department, "
            "job_title, job_grade, manager_id, hod_id, confirmation_date, years_of_service, joined_date, left_at, is_demo) "
            "VALUES (?,?,'x',?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (eid.lower(), "ZZ PD " + eid, role, eid, bg, co, dept, title, grade, mgr, hod, "2013-12-18", 4.0, "2013-11-18",
             left, demo)).lastrowid
        MADE["users"].append(uid)
        return uid

    def line(uid, name, bg=BGN, co=NB, w=25.0, bu=None, pending=0, rating=0):
        return db.execute(
            "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company, "
            "department, bu_kpi_id, bg_pending, rating_line) VALUES (?,?,?,?,'more',?,?,?,?,?,?)",
            (CID, uid, name, w, bg, co, "ZZPD Ops", bu, pending, rating)).lastrowid

    def setup_row(bg, co, name, carriers="everyone", cj=None, wmode="one", weight=100.0, bands=None):
        return db.execute(
            "INSERT INTO pm_bu_kpis(cycle_id, business_group, company, kpi_name, method, carriers, carriers_json, "
            "weight_mode, weight, bands_json) VALUES (?,?,?,?,'more',?,?,?,?,?)",
            (CID, bg, co, name, carriers, json.dumps(cj) if cj is not None else None, wmode, weight,
             json.dumps(bands) if bands is not None else None)).lastrowid

    def assign(subj, assessor, status="pending", archived=0, reason=None):
        return db.execute(
            "INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, archived, archive_reason) "
            "VALUES (?,?,?,'peer',?,?,?)", (CID, subj, assessor, status, archived, reason)).lastrowid

    def gh_person(uid, eid, appraiser=None, hod1=None, hod2=None, private=0):
        return db.execute(
            "INSERT INTO gradeh_people(cycle_id, employee_id, user_id, route, appraiser_id, hod_user_id, hod2_user_id, "
            "private_company) VALUES (?,?,?,'A',?,?,?,?)", (CID, eid, uid, appraiser, hod1, hod2, private)).lastrowid

    # --- 1. KPI lines on another business group ----------------------------------------------------------------------
    P_BG = mk("ZZPD-BG1")
    P_BG_OK = mk("ZZPD-BG2")
    P_BG_PEND = mk("ZZPD-BG3")
    P_BG_RATING = mk("ZZPD-BG4")
    P_BG_LEFT = mk("ZZPD-BG5", left="2026-10-01")
    line(P_BG, "ZZPD k1", bg=BGB, co=BE)
    line(P_BG, "ZZPD k2", bg=BGB, co=BE)
    line(P_BG_OK, "ZZPD k1")
    line(P_BG_PEND, "ZZPD k1", bg=BGB, co=BE, pending=1)
    line(P_BG_RATING, "ZZPD rating", bg=BGB, co=BE, rating=1)
    line(P_BG_LEFT, "ZZPD k1", bg=BGB, co=BE)

    # --- 2 / 15 / 5. BU KPI setups ----------------------------------------------------------------------------------------
    S_NB = setup_row(BGN, NB, "ZZPD bu one")
    S_NL = setup_row(BGN, NL, "ZZPD bu two")
    S_NL_GUEST = setup_row(BGN, NL, "ZZPD bu guest", cj={"guests": {"ZZPD-W2": 20}})
    S_BE = setup_row(BGB, BE, "ZZPD bu beacon")
    S_GRADE = setup_row(BGN, NB, "ZZPD bu graded", carriers="grade", cj={"min": 12, "max": 16}, wmode="grade", weight=None,
                        bands=[{"min": 12, "max": 14, "w": 30}, {"min": 15, "max": 16, "w": 40}])
    P_W1 = mk("ZZPD-W1")                   # linked to another unit's setup, not a guest
    P_W2 = mk("ZZPD-W2")                   # ... as its guest
    P_W3 = mk("ZZPD-W3")                   # linked to another group's setup
    P_W4 = mk("ZZPD-W4")                   # linked to its own unit's setup
    line(P_W1, "ZZPD bu two", bu=S_NL)
    line(P_W2, "ZZPD bu guest", bu=S_NL_GUEST)
    line(P_W3, "ZZPD bu beacon", bu=S_BE)
    line(P_W4, "ZZPD bu one", bu=S_NB)
    # 3. unlinked line's unit
    P_U1 = mk("ZZPD-U1")
    P_U2 = mk("ZZPD-U2")
    P_U3 = mk("ZZPD-U3")
    line(P_U1, "ZZPD off", co=NL)                # the line says Logistics, the person is in Building Supplies
    line(P_U2, "ZZPD same", co=NB)
    line(P_U3, "ZZPD pending", co=NL, pending=1)
    # 15. weight by grade
    P_G_OK = mk("ZZPD-G1", grade=14)
    P_G_W = mk("ZZPD-G2", grade=14)
    P_G_OUT = mk("ZZPD-G3", grade=18)
    P_G_BAND = mk("ZZPD-G4", grade=15)
    P_G_NL = mk("ZZPD-G5", grade=14, co=NL)                             # on another unit's graded setup, wrong weight
    line(P_G_NL, "ZZPD bu graded", w=25.0, bu=S_GRADE)
    line(P_G_OK, "ZZPD bu graded", w=30.0, bu=S_GRADE)
    line(P_G_W, "ZZPD bu graded", w=25.0, bu=S_GRADE)
    line(P_G_OUT, "ZZPD bu graded", w=30.0, bu=S_GRADE)
    line(P_G_BAND, "ZZPD bu graded", w=40.0, bu=S_GRADE)

    # --- 4. rating records ------------------------------------------------------------------------------------------------
    P_R_OK, P_R_GRADE, P_R_DEPT, P_R_FROZEN = mk("ZZPD-R1"), mk("ZZPD-R2"), mk("ZZPD-R3"), mk("ZZPD-R4")

    def rec(uid, eid, bg=BGN, co=NB, dept="ZZPD Ops", jg="14", title="ZZPD Analyst", frozen=None):
        db.execute("INSERT INTO rating_records(cycle_id, subject_id, employee_id, business_group, company, department, "
                   "job_grade, job_title, frozen_at) VALUES (?,?,?,?,?,?,?,?,?)",
                   (CID, uid, eid, bg, co, dept, jg, title, frozen))
    rec(P_R_OK, "ZZPD-R1")
    rec(P_R_GRADE, "ZZPD-R2", jg="13")
    rec(P_R_DEPT, "ZZPD-R3", dept="Old Dept")
    rec(P_R_FROZEN, "ZZPD-R4", jg="13", frozen="2026-10-01 00:00:00")

    # --- 5. Grade H KPI line on another unit's setup ------------------------------------------------------------------------
    P_H1 = mk("ZZPD-H1", grade="H")
    P_H2 = mk("ZZPD-H2", grade="H")
    P_H3 = mk("ZZPD-H3", grade="H")          # on the list, no appraiser problem, line on its own unit's setup
    GP1, GP2, GP3 = gh_person(P_H1, "ZZPD-H1"), gh_person(P_H2, "ZZPD-H2"), gh_person(P_H3, "ZZPD-H3")
    for gp, setup_id in ((GP1, S_NL), (GP2, S_NB), (GP3, S_NB)):
        db.execute("INSERT INTO gradeh_kpi_lines(cycle_id, person_id, kpi_name, weight, bu_kpi_id) VALUES (?,?,?,?,?)",
                   (CID, gp, "ZZPD gh", 50, setup_id))

    # --- 6. calibration picks -----------------------------------------------------------------------------------------------
    CAL = mk("ZZPD-CAL", grade=18)
    G1 = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id, active) VALUES (?,?,?,?,1)",
                    (BGN, NB, "ZZPD group", CAL)).lastrowid
    db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,'')",
               (G1, BGN, NB))
    db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,'')",
               (G1, BGN, "Held Unit Sdn Bhd"))
    db.execute("INSERT INTO calib_bu_group_left(group_id, business_group, company) VALUES (?,?,?)",
               (G1, BGN, "Left Unit Sdn Bhd"))
    P_C_OK = mk("ZZPD-C1")
    P_C_OFF = mk("ZZPD-C2", co=NL)
    P_C_HELD = mk("ZZPD-C3", co="Held Unit Sdn Bhd")
    P_C_LEFT = mk("ZZPD-C4", co="Left Unit Sdn Bhd")
    P_C_BG = mk("ZZPD-C5", bg=BGB, co=BE)
    P_C_BG2 = mk("ZZPD-C6", bg=BGB, co=NB)                           # another business group, the unit's name unchanged
    for u_ in (P_C_OK, P_C_OFF, P_C_HELD, P_C_LEFT, P_C_BG, P_C_BG2):
        db.execute("INSERT INTO calib_bu_group_people(group_id, business_group, user_id) VALUES (?,?,?)", (G1, BGN, u_))

    # --- 7. leavers on a link --------------------------------------------------------------------------------------------------
    GONE = mk("ZZPD-GONE", grade=19, left="2026-10-05")
    GONE2 = mk("ZZPD-GONE2", grade=19, left="2026-10-06")
    GONE3 = mk("ZZPD-GONE3", grade=19, left="2026-10-07")
    GONE4 = mk("ZZPD-GONE4", grade=19, left="2026-10-08")
    LIVE = mk("ZZPD-LIVE", grade=19)
    P_L_HOD = mk("ZZPD-L1", hod=GONE)
    P_L_OK = mk("ZZPD-L2", hod=LIVE)
    GONE_B = mk("ZZPD-GONEB", bg=BGB, co=BE, grade=19, left="2026-10-09")     # a leaver of ANOTHER group
    P_L_XB = mk("ZZPD-L3", hod=GONE_B)
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BGB, BE, GONE2))
    db.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (BGA, GONE3))
    G2 = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id, active) VALUES (?,?,?,?,1)",
                    (BGA, "Atlas Realty Sdn Bhd", "ZZPD group two", GONE4)).lastrowid
    G3 = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id, active) VALUES (?,?,?,?,0)",
                    (BGA, "Atlas Realty Sdn Bhd", "ZZPD group retired", GONE)).lastrowid     # inactive: not listed
    db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZPD chief group', ?)", (GONE,))
    # KPI moderator left
    P_M1, P_M2, P_M3 = mk("ZZPD-M1"), mk("ZZPD-M2"), mk("ZZPD-M3")
    T_M1, T_M2, T_M3 = line(P_M1, "ZZPD mod", w=10), line(P_M2, "ZZPD mod", w=10), line(P_M3, "ZZPD mod", w=10)
    for t_, ap in ((T_M1, GONE), (T_M2, GONE), (T_M3, LIVE)):
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t_, ap))
    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, admin_filled) VALUES (?,5,1)", (T_M2,))
    # Grade H appraiser / HOD left
    P_HL1, P_HL2 = mk("ZZPD-HL1", grade="H"), mk("ZZPD-HL2", grade="H")
    gh_person(P_HL1, "ZZPD-HL1", appraiser=GONE, hod1=LIVE)
    gh_person(P_HL2, "ZZPD-HL2", appraiser=LIVE, hod1=LIVE)

    # --- 8. HOD in another business group (no longer a problem, 2026-11-09: any person may be HOD across groups) ----------------
    HB = mk("ZZPD-HODB", bg=BGB, co=BE, grade=19)
    P_X1 = mk("ZZPD-X1", hod=HB)
    P_X3 = mk("ZZPD-X3", hod=LIVE)

    # --- 9. left-out units ------------------------------------------------------------------------------------------------------
    OUT_UNIT = "ZZPD Left Out Unit Sdn Bhd"
    db.execute("INSERT INTO cycle_exclusions(cycle_id, business_group, company, department) VALUES (?,?,?,'')",
               (CID, BGA, OUT_UNIT))
    EX_IN = mk("ZZPD-E1", bg=BGA, co=OUT_UNIT)        # moved into the left-out unit, live places
    EX_QUIET = mk("ZZPD-E2", bg=BGA, co=OUT_UNIT)     # in it, nothing live
    EX_RATER = mk("ZZPD-E3")
    EX_S1, EX_R1 = mk("ZZPD-E4"), mk("ZZPD-E5")                      # stale archive: neither is in a left-out unit
    assign(EX_IN, EX_RATER)
    WHY = OUT_UNIT + " isn't taking part in 2026 Mid-Year"
    assign(EX_S1, EX_R1, archived=1, reason=WHY)
    assign(EX_QUIET, EX_RATER, archived=1, reason=WHY)               # right: the subject IS left out; EX_RATER not listed

    # --- 12. Grade H list vs grade -----------------------------------------------------------------------------------------------
    P_N1 = mk("ZZPD-N1", grade="H")                                    # Grade H, not on the list
    P_N2 = mk("ZZPD-N2", grade=14)                                     # on the list, but JG 14
    gh_person(P_N2, "ZZPD-N2")
    P_N3 = mk("ZZPD-N3", grade="H", demo=1)                            # a demo account is never listed

    # --- 13 / 14. not rated / assessor not eligible -----------------------------------------------------------------------------
    db.execute("UPDATE cycles SET min_job_grade=12 WHERE id=?", (CID,))
    P_V1 = mk("ZZPD-V1", grade=11)                                     # below the lowest job grade, rated by someone
    P_V2 = mk("ZZPD-V2", grade="H")                                    # Grade H, rated by someone
    P_V3 = mk("ZZPD-V3", grade=14)                                     # fine
    P_V4 = mk("ZZPD-V4", grade="H")                                    # Grade H assessor, a pending rating
    P_V5 = mk("ZZPD-V5", grade="H")                                    # Grade H assessor, a submitted rating only
    P_V6 = mk("ZZPD-V6", grade=11)                                     # below the lowest grade, a pending rating
    P_V7 = mk("ZZPD-V7", grade=14)
    for subj in (P_V1, P_V2, P_V3):
        assign(subj, P_V7)
    assign(P_V7, P_V4)
    assign(P_V3, P_V5, status="submitted")
    assign(P_V3, P_V6)

    # --- 16. chosen next role ----------------------------------------------------------------------------------------------------
    def prof(title, grade, code=None):
        return db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code) VALUES (?,?,?,?)",
                          ("ZZPD Careers", title, str(grade), code)).lastrowid
    CP = {g_: prof("ZZPD role %d" % g_, g_) for g_ in (14, 15, 16, 17, 18)}
    P_K = {}
    for name, own, target in (("same", 15, 15), ("below", 15, 14), ("plus2", 15, 17), ("plus3", 15, 18), ("plus1", 15, 16)):
        uid = mk("ZZPD-K-" + name, grade=own)
        P_K[name] = uid
        db.execute("INSERT INTO pm_career_profile(subject_id, target_profile_id) VALUES (?,?)", (uid, CP[target]))

    # --- 10 / 11. competency sets ----------------------------------------------------------------------------------------------
    def skill(code, title, level):
        return db.execute("INSERT INTO tc_skills(skill_code, title, level, active) VALUES (?,?,?,1)",
                          (code, title, level)).lastrowid
    SK = {(t, lv): skill("ZZPD-%s-%d" % (t, lv), "ZZPD Skill %s" % t, lv) for t in "ABC" for lv in (3, 4)}
    PROF14 = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade) VALUES ('ZZPD Ops','ZZPD Analyst','14')"
                        ).lastrowid
    for n, t in enumerate("AB"):
        db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order) VALUES (?,?,3,?)",
                   (PROF14, SK[(t, 3)], n))
    WANT = {(SK[("A", 3)], 0), (SK[("B", 3)], 0), (SK[("A", 4)], 1), (SK[("B", 4)], 1)}

    def tc_set(uid, rows, source="profile"):
        for sid, fut in rows:
            db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, seq, source) VALUES (?,?,?,?,0,?)",
                       (CID, uid, sid, fut, source))
    P_T_OK, P_T_LVL, P_T_MIX, P_T_HAND, P_T_NONE, P_T_NOJOB = (mk("ZZPD-T%d" % i) for i in range(1, 7))
    db.execute("UPDATE users SET job_title='ZZPD Unknown Job' WHERE id=?", (P_T_NOJOB,))
    db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade) VALUES ('ZZPD Ops','ZZPD Empty Job','14')")
    P_T_EMPTY = mk("ZZPD-T7", title="ZZPD Empty Job")                 # the job resolves to a profile that lists nothing
    tc_set(P_T_OK, WANT)
    tc_set(P_T_LVL, {(SK[("A", 4)], 0), (SK[("B", 4)], 0)})
    tc_set(P_T_MIX, {(SK[("A", 3)], 0), (SK[("C", 3)], 0)})
    tc_set(P_T_HAND, {(SK[("C", 4)], 0)}, source="admin_profile")
    # the job-code branch of the resolver: a person with a role in the architecture
    db.execute("INSERT INTO ja_people(employee_id, spec_code, unit_code) VALUES ('ZZPD-JC1', 'ZZPD-SP', 'ZZPD-UNIT')")
    PROF_JC = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code) VALUES "
                         "('ZZPD Ops','ZZPD Coded','14','ZZPD-UNIT-14')").lastrowid
    db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order) VALUES (?,?,3,0)",
               (PROF_JC, SK[("C", 3)]))
    P_JC = mk("ZZPD-JC1", title="ZZPD Whatever")
    P_JC15 = mk("ZZPD-JC2", grade=15)                                  # a role, but no job at JG 15: None either way
    db.execute("INSERT INTO ja_people(employee_id, spec_code, unit_code) VALUES ('ZZPD-JC2', 'ZZPD-SP', 'ZZPD-UNIT')")
    db.commit()

# ---- 1. the checks list the drift, the clean person is not listed ------------------------------------------------------------
s.section("1. KPI lines on another business group")
f = found("kpi_other_group")
ck("lists the person with two lines on the old group, with the group named",
        "ZZPD-BG1" in f and "2 KPI line(s) on " + BGB in f["ZZPD-BG1"], f.get("ZZPD-BG1"))
ck("a clean person, a line waiting to be set, a rating line and a leaver are not listed",
        not ({"ZZPD-BG2", "ZZPD-BG3", "ZZPD-BG4", "ZZPD-BG5"} & set(f)), mine(f))

s.section("2. BU KPI line linked to another unit's setup")
f = found("bu_kpi_wrong_setup")
ck("another unit's setup, person not its guest -> listed, the unit named",
        "ZZPD-W1" in f and NL in f["ZZPD-W1"] and "guest" in f["ZZPD-W1"], f.get("ZZPD-W1"))
ck("another business group's setup -> listed, with that group named (not 'not its guest')",
   "ZZPD-W3" in f and "(" + BGB + ")" in f["ZZPD-W3"] and "guest" not in f["ZZPD-W3"], f.get("ZZPD-W3"))
ck("its guest and a person on their own unit's setup are not listed", not ({"ZZPD-W2", "ZZPD-W4"} & set(f)), mine(f))

s.section("3. KPI line carries a different unit")
f = found("kpi_line_unit_off")
ck("an unlinked line on another unit -> listed, both units named",
        "ZZPD-U1" in f and NL in f["ZZPD-U1"] and NB in f["ZZPD-U1"], f.get("ZZPD-U1"))
ck("a line on the person's unit and a line waiting to be set are not listed", not ({"ZZPD-U2", "ZZPD-U3"} & set(f)), mine(f))
ck("a line on another BUSINESS GROUP is the other check's, not this one's", "ZZPD-BG1" not in f)

s.section("4. Rating record differs")
f = found("rating_record_stale")
ck("the grade that moved is named, with the record's old grade", "ZZPD-R2" in f and "grade 13" in f["ZZPD-R2"], f.get("ZZPD-R2"))
ck("the department that moved is named", "ZZPD-R3" in f and "department Old Dept" in f["ZZPD-R3"], f.get("ZZPD-R3"))
ck("a record that agrees and a FROZEN record are not listed", not ({"ZZPD-R1", "ZZPD-R4"} & set(f)), mine(f))
ck("no trailing separator in the detail", all(not v.rstrip().endswith(";") for v in f.values()), list(f.values()))

s.section("5. Grade H KPI line on another unit's setup")
f = found("gradeh_kpi_other_unit")
ck("line on another unit's setup -> listed, that unit named", "ZZPD-H1" in f and NL in f["ZZPD-H1"], f.get("ZZPD-H1"))
ck("lines on the person's own unit are not listed", not ({"ZZPD-H2", "ZZPD-H3"} & set(f)), mine(f))

s.section("6. Calibration pick no longer in the group's units")
f = found("calib_pick_off_unit")
ck("moved to another unit of the group's business group -> listed", "ZZPD-C2" in f and "ZZPD group" in f["ZZPD-C2"], f.get("ZZPD-C2"))
ck("moved to another business group -> listed, even where the unit's name is the same",
   "ZZPD-C5" in f and "ZZPD-C6" in f, mine(f))
ck("in the home unit, in a unit the group holds, and in a unit held as 'everyone left' -> not listed",
        not ({"ZZPD-C1", "ZZPD-C3", "ZZPD-C4"} & set(f)), mine(f))

s.section("7. A leader who has left")
f = found("leaver_hod")
ck("a person whose HOD left -> listed with the HOD's name and date", "ZZPD-L1" in f and "left 2026-10-05" in f["ZZPD-L1"], f.get("ZZPD-L1"))
ck("a person with a current HOD is not listed", "ZZPD-L2" not in f)
roles = found_list("leaver_seat")
ck("BU CEO seat held by a leaver", any(e == "ZZPD-GONE2" and "BU CEO of " + BE in d for e, d in roles), roles)
ck("BG CEO held by a leaver", any(e == "ZZPD-GONE3" and "BG CEO of " + BGA in d for e, d in roles), roles)
ck("an active BU calibration group's calibrator who left", any(e == "ZZPD-GONE4" and "ZZPD group two" in d for e, d in roles), roles)
ck("a Group Chief calibrator who left", any(e == "ZZPD-GONE" and "Group Chief calibrator" in d for e, d in roles), roles)
ck("a RETIRED BU group's calibrator is not listed for it", not any(e == "ZZPD-GONE" and "retired" in d for e, d in roles), roles)
ck("a current leader is never listed", not any(e == "ZZPD-LIVE" for e, _d in roles))
f = found("leaver_kpi_moderator")
ck("a line whose moderator left -> listed", "ZZPD-M1" in f and "1 line(s)" in f["ZZPD-M1"], f.get("ZZPD-M1"))
ck("a line an admin filled in, and a line with a current moderator, are not listed", not ({"ZZPD-M2", "ZZPD-M3"} & set(f)), mine(f))
f = found("leaver_gradeh")
ck("a Grade H person whose appraiser left -> listed, role named", "ZZPD-HL1" in f and "appraiser" in f["ZZPD-HL1"], f.get("ZZPD-HL1"))
ck("a Grade H person with current leaders is not listed", "ZZPD-HL2" not in f)

s.section("8. HOD in another business group is no longer a data check")
ck("the detector is gone from the registry (an HOD may head people in another group since 2026-11-09)",
   "hod_other_group" not in a.DATA_CHECKS_BY_KEY and "hod_other_group" not in {c_["key"] for c_ in a.DATA_CHECKS})
# the fixture still holds the case the detector used to list, so a check that stops firing is not a check that lost its data
with a.app.app_context():
    _d = a.get_db()
    _x1 = _d.execute("SELECT h.business_group hb, u.business_group ub FROM users u JOIN users h ON h.id=u.hod_id "
                     "WHERE u.employee_id='ZZPD-X1'").fetchone()
ck("(fixture) ZZPD-X1's HOD is in another business group: the case the detector used to list is still in the data",
   _x1 and _x1["hb"] != _x1["ub"])
ck("a person whose HOD LEFT, in another group too, is still the leaver check's", "ZZPD-L3" in found("leaver_hod"), mine(found("leaver_hod")))

s.section("9. Left-out units")
f = found("unit_out_drift")
ck("someone in a left-out unit with live 360 places -> listed with the count",
        "ZZPD-E1" in f and "1 live 360 place" in f["ZZPD-E1"], f.get("ZZPD-E1"))
ck("someone in a left-out unit with nothing live is not listed", "ZZPD-E2" not in f, mine(f))
ck("the colleague rating them is not listed for it", "ZZPD-E3" not in f, mine(f))
ck("places archived for a left-out unit, neither person in one now -> both listed",
        {"ZZPD-E4", "ZZPD-E5"} <= set(f) and "archived for a left-out unit" in f["ZZPD-E4"], mine(f))

s.section("10. No competency set / 11. Set differs from the job")
f = found("no_competency_set")
ck("a person whose job resolves and who has no set -> listed, the profile named",
        "ZZPD-T5" in f and "Zzpd Analyst" in f["ZZPD-T5"].title() and "4 competencies" in f["ZZPD-T5"], f.get("ZZPD-T5"))
ck("a person with a set, a person whose job resolves to nothing and one whose profile lists no competency are not listed",
   not ({"ZZPD-T1", "ZZPD-T6", "ZZPD-T7"} & set(f)), mine(f))
f = found("tc_set_off_job")
ck("a set at the wrong level reads 'set at L4, job asks L3'", "ZZPD-T2" in f and "set at L4, job asks L3" == f["ZZPD-T2"], f.get("ZZPD-T2"))
ck("a set of other competencies reads 'N of M differ'", "ZZPD-T3" in f and "differ" in f["ZZPD-T3"], f.get("ZZPD-T3"))
ck("a set that matches, and one Group People matched by hand, are not listed", not ({"ZZPD-T1", "ZZPD-T4"} & set(f)), mine(f))
ck("someone with no set is the other check's, not this one's", "ZZPD-T5" not in f)
# the batched resolver is tc_profile_for_user's own rule (every branch), over many people
with a.app.app_context():
    d = a.get_db()
    ppl = d.execute("SELECT * FROM users WHERE id IN (%s) OR id <= 60" % ",".join(str(x) for x in MADE["users"])).fetchall()
    batched = a._tc_profiles_for_people(d, ppl)
    same = [u["id"] for u in ppl if ((a.tc_profile_for_user(d, u)[0] or {}).get("id")) == ((batched[u["id"]] or {}).get("id"))]
    ck("_tc_profiles_for_people agrees with tc_profile_for_user on %d people (roster, title, job code, nothing)" % len(ppl),
            len(same) == len(ppl), [u["employee_id"] for u in ppl if u["id"] not in same][:5])
    ck("...and those include a person on the job-code branch and a role with no job at their grade",
            (batched[P_JC] or {}).get("id") == PROF_JC and batched[P_JC15] is None and (batched[P_T_OK] or {}).get("id") == PROF14)

s.section("12. Grade H list and grade, both ways")
f = found("gradeh_not_on_list")
ck("a Grade H person not on the list -> listed", "ZZPD-N1" in f, mine(f))
ck("Grade H people ON the list and a demo account are not listed", not ({"ZZPD-H1", "ZZPD-HL1", "ZZPD-N3"} & set(f)), mine(f))
f = found("gradeh_list_not_h")
ck("someone on the list whose grade is 14 -> listed, the grade named", "ZZPD-N2" in f and "14" in f["ZZPD-N2"], f.get("ZZPD-N2"))
ck("Grade H people on the list are not listed", not ({"ZZPD-H1", "ZZPD-H2"} & set(f)), mine(f))
with a.app.app_context():
    d = a.get_db()
    OTHER = d.execute("SELECT id FROM cycles WHERE id!=? ORDER BY id LIMIT 1", (CID,)).fetchone()[0]
    d.execute("UPDATE gradeh_people SET cycle_id=? WHERE cycle_id=?", (OTHER, CID))      # no list for this cycle
    d.commit()
ck("with no Grade H list loaded for the cycle, 'not on the list' says nothing (everyone would be)",
        found("gradeh_not_on_list") == {})
with a.app.app_context():
    d = a.get_db()
    d.execute("UPDATE gradeh_people SET cycle_id=? WHERE cycle_id=?", (CID, OTHER))
    d.commit()

s.section("13. Live 360 for someone not rated / 14. Assessor not eligible")
f = found("live_360_not_rated")
ck("below the lowest job grade, still rated -> listed", "ZZPD-V1" in f and "below the lowest job grade" in f["ZZPD-V1"], f.get("ZZPD-V1"))
ck("Grade H, still rated -> listed", "ZZPD-V2" in f and "Grade H" in f["ZZPD-V2"], f.get("ZZPD-V2"))
ck("a person who takes part is not listed", "ZZPD-V3" not in f)
ck("someone in a left-out unit is the unit check's, not this one's", "ZZPD-E1" not in f, mine(f))
f = found("assessor_not_eligible")
ck("a Grade H assessor with a pending rating -> listed", "ZZPD-V4" in f and "Grade H" in f["ZZPD-V4"], f.get("ZZPD-V4"))
ck("below the lowest job grade with a pending rating -> listed", "ZZPD-V6" in f and "JG 11" in f["ZZPD-V6"], f.get("ZZPD-V6"))
with a.app.app_context():
    d = a.get_db()
    d.execute("UPDATE cycles SET min_job_grade=NULL WHERE id=?", (CID,))
    d.commit()
f_nomin = found("assessor_not_eligible")
ck("with no lowest job grade set, a Grade H assessor is still listed and a JG 11 one is not",
   "ZZPD-V4" in f_nomin and "ZZPD-V6" not in f_nomin, mine(f_nomin))
with a.app.app_context():
    d = a.get_db()
    d.execute("UPDATE cycles SET min_job_grade=12 WHERE id=?", (CID,))
    d.commit()
ck("a Grade H assessor whose rating is SUBMITTED is not listed, nor is an eligible one", not ({"ZZPD-V5", "ZZPD-V7"} & set(f)), mine(f))

s.section("15. BU KPI weight against the grade")
f = found("bu_kpi_weight_off_grade")
ck("a weight that is not the band's -> listed with both weights", "ZZPD-G2" in f and "weight 25" in f["ZZPD-G2"] and "is 30" in f["ZZPD-G2"], f.get("ZZPD-G2"))
ck("a grade outside the setup's range -> listed", "ZZPD-G3" in f and "outside" in f["ZZPD-G3"], f.get("ZZPD-G3"))
ck("the right weight in each band is not listed", not ({"ZZPD-G1", "ZZPD-G4"} & set(f)), mine(f))
ck("a line on another unit's setup is the link check's, not this one's",
   "ZZPD-G5" not in f and "ZZPD-G5" in found("bu_kpi_wrong_setup"), mine(f))

s.section("16. Chosen next role out of band")
f = found("career_target_off_grade")
ck("a role at their grade (a lateral pick, valid) -> NOT listed", "ZZPD-K-same" not in f, mine(f))
ck("a role below their grade -> listed", "ZZPD-K-below" in f, mine(f))
ck("a role three grades above -> listed", "ZZPD-K-plus3" in f, mine(f))
ck("one and two grades above are not listed", not ({"ZZPD-K-plus1", "ZZPD-K-plus2"} & set(f)), mine(f))

s.section("scope: leavers, admins and demo accounts are never findings; the page's counts, list and Excel agree")
c_all = counts()
for key in NEW_KEYS:
    n_list = len(found_list(key))
    ck("%s: the landing count is the list's row count" % key, c_all[key] == n_list, (c_all[key], n_list))
with a.app.test_request_context("/"):
    from flask import session
    session["user_id"] = SU["id"]
    d = a.get_db()
    names = [r["eid"] for key in NEW_KEYS if key != "leaver_seat" for r in
             a.data_check_rows(d, SU, a.active_cycle_id(d), a.DATA_CHECKS_BY_KEY[key], cap=False)[0]]
    bad = d.execute("SELECT employee_id FROM users WHERE employee_id IN (%s) AND (left_at IS NOT NULL OR role='admin' OR is_demo=1)"
                    % ",".join("?" * len(set(names))), sorted(set(names))).fetchall() if names else []
ck("no check lists a leaver, an admin or a demo account (the seat check lists leavers by design)", not bad, [r[0] for r in bad])
SUP = H.client_as(a, SU["id"])
r = SUP.get("/admin/data-integrity")
body = r.get_data(as_text=True)
ck("the landing page loads, with the group heading and every new check named",
        r.status_code == 200 and "After a change to someone" in body and
        all(a.DATA_CHECKS_BY_KEY[k]["label"][:28] in body for k in NEW_KEYS),
        [k for k in NEW_KEYS if a.DATA_CHECKS_BY_KEY[k]["label"][:28] not in body])
for key in NEW_KEYS:
    r = SUP.get("/admin/data-integrity", query_string={"check": key})
    ck("%s: the drill-down loads" % key, r.status_code == 200)
r = SUP.get("/admin/data-integrity", query_string={"check": "kpi_other_group", "format": "csv"})
csv_text = H.as_csv_text(r)
ck("a check's Excel carries the row and no more", r.status_code == 200 and "ZZPD-BG1" in csv_text and "ZZPD-BG2" not in csv_text)
r = SUP.get("/admin/list/check", query_string={"check": "bu_kpi_wrong_setup", "fragment": 1})
ck("the list panel opens a Python check's people too (the count on the tile and the panel come from the same rows)",
   r.status_code == 200 and "ZZ PD ZZPD-W1" in r.get_data(as_text=True) and "ZZPD-W2" not in r.get_data(as_text=True), r.status_code)
r = SUP.get("/admin/export/data-integrity.xlsx")
ck("the all-checks workbook still builds with the new sheets", r.status_code == 200 and len(r.data) > 2000, r.status_code)

s.section("a Python check is one read, not one per person")
with a.app.test_request_context("/"):
    from flask import session
    session["user_id"] = SU["id"]
    d = a.get_db()
    n_q = []
    d.set_trace_callback(lambda sql: n_q.append(sql))
    t0 = time.time()
    a._dc_py_tc_set_off_job(d, CID)
    a._dc_py_no_competency_set(d, CID)
    a._dc_py_bu_kpi_weight(d, CID)
    a._dc_py_bu_kpi_wrong_setup(d, CID)
    el = time.time() - t0
    d.set_trace_callback(None)
n_people = H.one(a, "SELECT COUNT(*) FROM users")
ck("the four Python checks run %d statements over %d people (a read per person would be hundreds)" % (len(n_q), n_people),
        len(n_q) < 60, len(n_q))

s.section("the page loads fast on the whole harness database")
t0 = time.time()
r = SUP.get("/admin/data-integrity")
el_page = time.time() - t0
ck("the landing page loads in %.2fs (all %d checks)" % (el_page, len(a.DATA_CHECKS)), r.status_code == 200 and el_page < 3.0, el_page)
slow = []
with a.app.test_request_context("/"):
    from flask import session
    session["user_id"] = SU["id"]
    d = a.get_db()
    base = a._data_check_params(d, CID)
    for chk in a.DATA_CHECKS:
        t1 = time.time()
        sql, extra = a._data_check_sql(chk, SU, count_only=True)
        d.execute(sql, dict(base, **extra, **a._data_check_args(d, chk, CID))).fetchone()
        slow.append((time.time() - t1, chk["key"]))
slow.sort(reverse=True)
s.note("slowest checks: " + ", ".join("%s %.3fs" % (k, t_) for t_, k in slow[:3]))

# ---- the display fix: a submitted 360 rating shows the statements its answers hold ----------------------------------------------
s.section("A submitted 360 rating lists the statements its answers hold, not its subject's live tier")
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','tm','pm','idp')")
    db.execute("UPDATE cycles SET kind='mid_year', starts_on=NULL, tiers_json=NULL, min_job_grade=NULL WHERE id=?", (CID,))
    db.commit()
    ST = {tn: [r[0] for r in db.execute("SELECT id FROM cycle_statements WHERE cycle_id=? AND tier_n=? ORDER BY id", (CID, tn))]
          for tn in (1, 2)}
    TXT = {tn: {r[0] for r in db.execute("SELECT text FROM cycle_statements WHERE cycle_id=? AND tier_n=?", (CID, tn))}
           for tn in (1, 2)}
    SUBJ = mk("ZZPD-DS1", grade=14, mgr=LIVE)         # tier 1 now; moved to tier 2 below
    SUBJ2 = mk("ZZPD-DS2", grade=14, mgr=LIVE)
    RATER = mk("ZZPD-DR1", grade=16)
    RATER2 = mk("ZZPD-DR2", grade=16)
    db.commit()
    A_SUB = db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, submitted_at) "
                       "VALUES (?,?,?,'peer','submitted','2026-11-01 09:00:00')", (CID, SUBJ, RATER)).lastrowid
    A_PEND = db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) "
                        "VALUES (?,?,?,'peer','pending')", (CID, SUBJ, RATER2)).lastrowid
    for k, sid in enumerate(ST[1]):
        db.execute("INSERT INTO responses(assignment_id, statement_id, answer) VALUES (?,?,?)",
                   (A_SUB, sid, "yes" if k % 2 == 0 else "no"))
    db.commit()
    SCORE_BEFORE = a.assignment_score(db, A_SUB)
    # the subject moves to tier 2 (JG 14 -> 15) by a direct edit: the 360 tier guard leaves a SUBMITTED rating as it is
    db.execute("UPDATE users SET job_grade=15 WHERE id=?", (SUBJ,))
    db.commit()
    with a.app.test_request_context("/"):
        d = a.get_db()
        grade = 15
        sub_p = a._feedback_principles(d, A_SUB, grade, CID)
        ids_sub = [st["statement_id"] for p in sub_p for st in p["statements"]]
        answered = [st for p in sub_p for st in p["statements"] if st["answer"] is not None]
        ck("the helper reads the tier the answers hold (tier 1) for a subject now in tier 2",
                a._fb_assignment_tier(d, A_SUB) == 1 and a._cycle_tier_n(d, grade, CID) == 2)
        ck("a SUBMITTED rating lists tier 1's statements, every one with its answer",
                ids_sub == [x for x in ST[1] if x in set(ids_sub)] and set(ids_sub) == set(ST[1]) and len(answered) == len(ST[1]),
                (len(ids_sub), len(ST[1]), len(answered)))
        pend_p = a._feedback_principles(d, A_PEND, grade, CID)
        ids_pend = {st["statement_id"] for p in pend_p for st in p["statements"]}
        ck("a PENDING rating of the same subject lists tier 2's statements (the 360 tier guard's rule)",
                ids_pend == set(ST[2]), (len(ids_pend), len(ST[2])))
        ck("its score is not touched", a.assignment_score(d, A_SUB) == SCORE_BEFORE, (a.assignment_score(d, A_SUB), SCORE_BEFORE))
        # a rating holding rows of both tiers answers with the tier holding most answers (days before the tier guard)
        A_MIX = d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, submitted_at) "
                          "VALUES (?,?,?,'peer','submitted','2026-11-01 09:00:00')", (CID, SUBJ2, RATER)).lastrowid
        for k, sid in enumerate(ST[1][:6]):
            d.execute("INSERT INTO responses(assignment_id, statement_id, answer) VALUES (?,?,'yes')", (A_MIX, sid))
        for sid in ST[2][:2]:
            d.execute("INSERT INTO responses(assignment_id, statement_id, answer) VALUES (?,?,'no')", (A_MIX, sid))
        d.commit()
        ck("a rating holding both tiers' rows answers with the tier holding the most answers (tier 1: 6 against 2)",
           a._fb_assignment_tier(d, A_MIX) == 1 and a._fb_assignment_tier(d, A_SUB) == 1, a._fb_assignment_tier(d, A_MIX))
        # a submitted rating that holds no rows falls back to the live tier
        A_EMPTY = d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, submitted_at) "
                            "VALUES (?,?,?,'peer','submitted','2026-11-01 09:00:00')", (CID, SUBJ2, RATER2)).lastrowid
        d.commit()
        ck("a submitted rating with no rows lists the live tier's statements",
                {x["statement_id"] for x in a._fb_statements_for_rating(d, A_EMPTY, 14, CID)} == set(ST[1]))
        # statement_agreement: the tallies of what was submitted at tier 1 show
        agree, n_sub = a.statement_agreement(d, d.execute("SELECT * FROM users WHERE id=?", (SUBJ,)).fetchone(), CID)
        tot = sum(st["total"] for g_ in agree for st in g_["statements"])
        texts = {st["text"] for g_ in agree for st in g_["statements"]}
        ck("the agreement listing shows tier 1's statements and the answers tallied on them",
                n_sub == 1 and tot == len(ST[1]) and texts == TXT[1], (n_sub, tot, len(texts)))
    # the pages
    r = SUP.get("/admin/subjects/%d/responses/%d" % (SUBJ, A_SUB))
    body = r.get_data(as_text=True)
    only1 = sorted(TXT[1] - TXT[2])
    only2 = sorted(TXT[2] - TXT[1])
    import html as _html
    def has(t):
        return _html.escape(t) in body or t in body
    ck("the admin view of the submitted rating shows tier 1's wording, none of tier 2's",
            r.status_code == 200 and bool(only1) and all(has(t) for t in only1[:3]) and not any(has(t) for t in only2[:3]),
            (r.status_code, len(only1), len(only2)))
    RC = H.client_as(a, RATER)
    r = RC.get("/rate/%d" % SUBJ)
    body = r.get_data(as_text=True)
    ck("the rater's locked view of the submitted rating shows tier 1's wording, none of tier 2's",
            r.status_code == 200 and all(has(t) for t in only1[:3]) and not any(has(t) for t in only2[:3]), r.status_code)
    r = H.client_as(a, RATER2).get("/rate/%d" % SUBJ)
    body = r.get_data(as_text=True)
    ck("the PENDING rating's page shows tier 2's wording",
            r.status_code == 200 and all(has(t) for t in only2[:3]) and not any(has(t) for t in only1[:3]), r.status_code)

if os.environ.get("ONEHR_PD_KEEP") == "1":   # browser QC: keep the drift (with ONEHR_TEST_KEEP_DB=1) to look at the page
    sys.exit(s.done())

# ---- everything put back -----------------------------------------------------------------------------------------------------------------
s.section("put back: removing what this suite made takes every check back to where it started")
with a.app.app_context():
    d = a.get_db()
    ids = ",".join(str(x) for x in MADE["users"])
    d.execute("UPDATE cycles SET min_job_grade=NULL WHERE id=?", (CID,))
    d.execute("DELETE FROM responses WHERE assignment_id IN (SELECT id FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s))" % (ids, ids))
    d.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ids, ids))
    for sql in ("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s))",
                "DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s))",
                "DELETE FROM gradeh_kpi_lines WHERE person_id IN (SELECT id FROM gradeh_people WHERE employee_id LIKE 'ZZPD-%%')",
                "DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)", "DELETE FROM rating_records WHERE subject_id IN (%s)",
                "DELETE FROM tc_assignments WHERE subject_id IN (%s)", "DELETE FROM pm_career_profile WHERE subject_id IN (%s)",
                "DELETE FROM calib_bu_group_people WHERE user_id IN (%s)"):
        d.execute(sql % ids if "%s" in sql else sql)
    for sql in ("DELETE FROM gradeh_people WHERE employee_id LIKE 'ZZPD-%'", "DELETE FROM pm_bu_kpis WHERE kpi_name LIKE 'ZZPD%'",
                "DELETE FROM calib_bu_groups WHERE name LIKE 'ZZPD%'", "DELETE FROM pm_calibration_groups WHERE name LIKE 'ZZPD%'",
                "DELETE FROM buceo_seats WHERE user_id IN (%s)" % ids, "DELETE FROM cycle_exclusions WHERE business_group='%s' "
                "AND company='%s'" % (BGA, OUT_UNIT), "DELETE FROM ja_people WHERE employee_id LIKE 'ZZPD-%'",
                "DELETE FROM tc_job_profile_skills WHERE profile_id IN (SELECT id FROM tc_job_profiles WHERE department LIKE 'ZZPD%')",
                "DELETE FROM tc_job_profiles WHERE department LIKE 'ZZPD%'", "DELETE FROM tc_skills WHERE skill_code LIKE 'ZZPD-%'",
                "UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ids, "DELETE FROM users WHERE id IN (%s)" % ids):
        d.execute(sql)
    d.commit()
AFTER = counts()
ck("every new check is back to its starting count", all(AFTER[k] == BASE[k] for k in NEW_KEYS),
        {k: (BASE[k], AFTER[k]) for k in NEW_KEYS if AFTER[k] != BASE[k]})

sys.exit(s.done())
