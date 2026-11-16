"""The lowest job grade taking part in a cycle (Chris, 2026-10-14: "configurable by super admin on the user selection,
just that for this year end, we are opening it to JG12 and above").

cycles.min_job_grade, NULL = everyone. Below it -- and every letter grade, and a grade that isn't a number -- takes no
part at all: no review of their own, never rated, never rates others. An admin can't add them back. Everything here is
synthetic (ZZMG-*) and is removed at the end; the active cycle's minimum is put back as it was. The cycle-start check
runs on a COPY of the suite database, because starting a cycle archives the active one.
"""
import os
import shutil
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Minimum job grade -- per cycle, set by the super admin, below it takes no part at all")
SU, BGA, EMP = H.actors(a)
BG, CO = "ZZMG BG", "ZZMG CO"
# employee id suffix -> job grade as stored (an int, digit text, a letter, a prefixed form, blank)
GRADES = {"14": 14, "12": 12, "12T": "12", "11": 11, "11T": "11", "H": "H", "G12": "G12", "NONE": None}
ABOVE = {"ZZMG-14", "ZZMG-12", "ZZMG-12T"}
BELOW = {"ZZMG-11", "ZZMG-11T", "ZZMG-H", "ZZMG-G12", "ZZMG-NONE"}


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZMG-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM activity_log WHERE target_user_id IN (%s)" % ph, ids)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    CYC = dict(a.active_cycle(db))
    CID, MG0 = CYC["id"], CYC.get("min_job_grade")
    _cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]
    ID = {}
    for suf, jg in GRADES.items():
        eid = "ZZMG-" + suf
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ Grade " + suf, email=None, hod_id=None,
                 manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO,
                 department="ZZMG Dept", years_of_service=3, confirmation_date="2000-01-01", left_at=None, is_demo=0,
                 role="user", job_grade=jg)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        ID[eid] = db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    db.commit()


def set_min(v):
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET min_job_grade=? WHERE id=?", (v, CID))
        d.commit()


def sql_set(pred):
    with a.app.app_context():
        return {r[0] for r in a.get_db().execute(
            "SELECT employee_id FROM users WHERE employee_id LIKE 'ZZMG-%%' AND %s" % pred)}


def py_set():
    with a.app.app_context():
        d = a.get_db()
        cyc = a.active_cycle(d)
        return {r["employee_id"] for r in d.execute("SELECT * FROM users WHERE employee_id LIKE 'ZZMG-%'")
                if a.participation(d, r, cyc)[0]}


try:
    s.section("the rule: SQL and Python agree, letter grades and text forms are below it")
    set_min(None)
    everyone = ABOVE | BELOW
    # (2026-10-30) a Grade H person (ZZMG-H) is never in the normal review, minimum or not: the one letter grade the rule drops by name
    everyone_in = everyone - {"ZZMG-H"}
    s.check("no minimum: everyone confirmed takes part (SQL), except the Grade H person, who is appraised in Grade H Appraisal",
            sql_set(a.participant_sql()) == everyone_in, sorted(everyone_in - sql_set(a.participant_sql())))
    s.check("...and in Python", py_set() == everyone_in)
    s.check("...and NOT min_grade_sql finds nobody", sql_set("NOT " + a.min_grade_sql()) == set())
    set_min(12)
    s.check("JG 12: only 12 and above take part (SQL)", sql_set(a.participant_sql()) == ABOVE,
            sorted(sql_set(a.participant_sql())))
    s.check("...Python mirrors it exactly", py_set() == ABOVE, sorted(py_set()))
    s.check("...digit text '12' counts as 12, 'G12' / 'H' / blank are below",
            "ZZMG-12T" in sql_set(a.participant_sql()) and not ({"ZZMG-G12", "ZZMG-H", "ZZMG-NONE"}
                                                              & sql_set(a.participant_sql())))
    s.check("NOT min_grade_sql finds every one below, letter grades and blanks included",
            sql_set("NOT " + a.min_grade_sql()) == BELOW, sorted(sql_set("NOT " + a.min_grade_sql())))
    s.check("below it can't rate others either (assessor_eligible_sql)", sql_set(a.assessor_eligible_sql()) == ABOVE,
            sorted(sql_set(a.assessor_eligible_sql())))
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?, 'add')",
                  (CID, ID["ZZMG-H"]))
        d.commit()
        hrow = d.execute("SELECT * FROM users WHERE id=?", (ID["ZZMG-H"],)).fetchone()
        why = a.participation(d, hrow, a.active_cycle(d))
    s.check("an admin's add doesn't bring them back (Python)", why == (False, "below_min_grade"), why)
    s.check("...nor SQL", "ZZMG-H" not in sql_set(a.participant_sql()))
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM cycle_participants WHERE subject_id=?", (ID["ZZMG-H"],))
        d.commit()

    s.section("Participants page: the super admin sets it; below it is counted, and can't be added")
    S = H.client_as(a, SU["id"])
    r = S.post("/admin/participants", data={"csrf_token": "tok", "action": "min_grade", "min_job_grade": "13"})
    with a.app.app_context():
        d = a.get_db()
        got = d.execute("SELECT min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone()[0]
        logged = d.execute("SELECT COUNT(*) FROM activity_log WHERE action='participant_min_grade' AND detail LIKE "
                           "'%12 -> 13%'").fetchone()[0]
    s.check("a super admin sets 13: stored on the active cycle, logged with old and new", r.status_code in (302, 303)
            and got == 13 and logged >= 1, (r.status_code, got, logged))
    r = S.post("/admin/participants", data={"csrf_token": "tok", "action": "min_grade", "min_job_grade": "G12"})
    s.check("'G12' is refused and nothing changes", H.one(a, "SELECT min_job_grade FROM cycles WHERE id=?", (CID,))
            == 13)
    r = S.post("/admin/participants", data={"csrf_token": "tok", "action": "min_grade", "min_job_grade": ""})
    s.check("blank clears it (everyone)", H.one(a, "SELECT min_job_grade FROM cycles WHERE id=?", (CID,)) is None)
    if BGA:
        B = H.client_as(a, BGA["id"])
        r = B.post("/admin/participants", data={"csrf_token": "tok", "action": "min_grade", "min_job_grade": "12"})
        s.check("a BG admin can't set it (403), nothing changes", r.status_code == 403 and H.one(
            a, "SELECT min_job_grade FROM cycles WHERE id=?", (CID,)) is None, r.status_code)
    S.post("/admin/participants", data={"csrf_token": "tok", "action": "min_grade", "min_job_grade": "12"})
    s.check("(set back to 12)", H.one(a, "SELECT min_job_grade FROM cycles WHERE id=?", (CID,)) == 12)
    body = S.get("/admin/participants?q=ZZMG&show=out").get_data(as_text=True)
    s.check("'Not taking part' doesn't list people below it", not any(e + "<" in body or e + " " in body
                                                                     for e in BELOW), body.count("ZZMG-"))
    body = S.get("/admin/participants?q=ZZMG&show=below").get_data(as_text=True)
    s.check("'Below JG 12' lists every one of them", all(e in body for e in BELOW) and "Below JG 12" in body)
    s.check("...the page states the minimum", "Only JG 12 and above take part" in body
            and "Lowest job grade taking part" in body)
    r = S.post("/admin/participants", data={"csrf_token": "tok", "action": "add", "ids": [str(ID["ZZMG-11"])]})
    s.check("adding someone below it is refused: no row written", H.one(
        a, "SELECT COUNT(*) FROM cycle_participants WHERE subject_id=?", (ID["ZZMG-11"],)) == 0)
    if BGA:
        body = H.client_as(a, BGA["id"]).get("/admin/participants").get_data(as_text=True)
        s.check("a BG admin reads the minimum but gets no form to change it", "Lowest job grade taking part" in body
                and 'name="min_job_grade"' not in body)

    s.section("panels: below it is never added, never built")
    _g = S.get("/admin/subjects/%d/panel" % ID["ZZMG-14"])
    s.check("(the panel route exists -- its GET goes to their 360 tab -- so a refusal below isn't a 404)",
            _g.status_code == 302 and "tab=f360" in (_g.headers.get("Location") or ""), _g.status_code)
    r = S.post("/admin/subjects/%d/panel" % ID["ZZMG-14"], data={"csrf_token": "tok", "action": "add",
                                                         "assessor_eid": "ZZMG-11", "relationship": "peer"})
    s.check("adding a JG 11 assessor by Employee ID is refused", H.one(
        a, "SELECT COUNT(*) FROM assignments WHERE subject_id=? AND assessor_id=?", (ID["ZZMG-14"], ID["ZZMG-11"]))
        == 0)
    r = S.post("/admin/subjects/%d/panel" % ID["ZZMG-H"], data={"csrf_token": "tok", "action": "add",
                                                        "assessor_eid": "ZZMG-14", "relationship": "peer"})
    s.check("...and a panel FOR someone below it", H.one(
        a, "SELECT COUNT(*) FROM assignments WHERE subject_id=?", (ID["ZZMG-H"],)) == 0)
    r = S.post("/admin/subjects/%d/panel" % ID["ZZMG-14"], data={"csrf_token": "tok", "action": "add",
                                                         "assessor_eid": "ZZMG-12", "relationship": "peer"})
    s.check("(a JG 12 assessor IS added -- the route works)", H.one(
        a, "SELECT COUNT(*) FROM assignments WHERE subject_id=? AND assessor_id=?", (ID["ZZMG-14"], ID["ZZMG-12"]))
        == 1)
    r = S.post("/admin/subjects/%d/panel" % ID["ZZMG-14"], data={"csrf_token": "tok", "action": "add_suggested",
                                                         "pick_%d" % ID["ZZMG-11T"]: "1",
                                                         "rel_%d" % ID["ZZMG-11T"]: "peer"})
    s.check("bulk Add suggested skips them", H.one(
        a, "SELECT COUNT(*) FROM assignments WHERE subject_id=? AND assessor_id=?", (ID["ZZMG-14"], ID["ZZMG-11T"]))
        == 0)
    with a.app.app_context():
        people = a._bpdb.load_people(a.get_db(), 12)
    zz = {e for e in people if e.startswith("ZZMG-")}
    s.check("the bulk build's roster leaves them out entirely", zz == ABOVE, sorted(zz))
    with a.app.app_context():
        people = a._bpdb.load_people(a.get_db(), None)
    s.check("...and with no minimum, keeps them (all but Grade H, which is on no 360 whatever the floor: 2026-10-28)",
            {e for e in people if e.startswith("ZZMG-")} == ABOVE | (BELOW - {"ZZMG-H"}))

    s.section("data integrity: a leader below it, over someone taking part")
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE users SET manager_id=?, hod_id=? WHERE id=?", (ID["ZZMG-11"], ID["ZZMG-H"], ID["ZZMG-14"]))
        d.execute("UPDATE users SET manager_id=?, hod_id=? WHERE id=?", (ID["ZZMG-12"], ID["ZZMG-12"],
                                                                        ID["ZZMG-12T"]))
        d.execute("UPDATE users SET manager_id=?, hod_id=? WHERE id=?", (ID["ZZMG-11"], ID["ZZMG-11"], ID["ZZMG-H"]))
        d.commit()

    def flagged(key):
        with a.app.app_context():
            sql = a.DATA_CHECKS_BY_KEY[key]["sql"]
            return {r[0] for r in a.get_db().execute("SELECT eid FROM (%s) WHERE eid LIKE 'ZZMG-%%'" % sql)}
    s.check("line manager below it: flagged", flagged("lm_below_min") == {"ZZMG-14"}, sorted(flagged("lm_below_min")))
    s.check("HOD below it (a letter grade): flagged", flagged("hod_below_min") == {"ZZMG-14"},
            sorted(flagged("hod_below_min")))
    s.check("...never someone who isn't taking part (ZZMG-H reports to JG 11 too)",
            "ZZMG-H" not in flagged("lm_below_min") | flagged("hod_below_min"))
    s.check("the line-manager one can be fixed in place", "lm_below_min" in a.DATA_FIX_LM)
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = SU["id"]
        counts = {c["key"]: c["count"] for c in a.data_check_counts(a.get_db(), a.get_db().execute(
            "SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone(), CID)}
    s.check("both show on the data integrity page", counts.get("lm_below_min", 0) >= 1
            and counts.get("hod_below_min", 0) >= 1, (counts.get("lm_below_min"), counts.get("hod_below_min")))
    set_min(None)
    s.check("no minimum: neither check finds anyone", not flagged("lm_below_min") and not flagged("hod_below_min"))
    set_min(12)

    s.section("starting a cycle: the field, the minimum stored, a cloned panel drops anyone below it")
    body = S.get("/admin/cycles").get_data(as_text=True)
    s.check("the Start form asks for the lowest job grade", 'name="min_job_grade"' in body)
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?, 'peer')",
                  (CID, ID["ZZMG-12"], ID["ZZMG-11"]))   # (inserted directly: the route refuses it now)
        d.commit()
    tmp = tempfile.mkdtemp(prefix="onehr-tests-mingrade-")
    real = a.DB_PATH
    try:
        cp = os.path.join(tmp, "copy.db")
        src = sqlite3.connect(real)
        dst = sqlite3.connect(cp)
        src.backup(dst)
        src.close()
        dst.close()
        a.DB_PATH = cp
        assert "onehr-tests" in a.DB_PATH
        C = H.client_as(a, SU["id"])
        r = C.post("/admin/cycles", data={"action": "create", "csrf_token": "tok", "name": "ZZMG Year-End",
                                          "code": "ZZMG-YE", "confirm_freeze": "1", "source": "clone:%d" % CID,
                                          "year": "2026", "half": "2", "min_job_grade": "abc"})
        c2 = sqlite3.connect(cp)
        s.check("a non-number is refused, no cycle started", c2.execute(
            "SELECT COUNT(*) FROM cycles WHERE code='ZZMG-YE'").fetchone()[0] == 0)
        r = C.post("/admin/cycles", data={"action": "create", "csrf_token": "tok", "name": "ZZMG Year-End",
                                          "code": "ZZMG-YE", "confirm_freeze": "1", "source": "clone:%d" % CID,
                                          "year": "2026", "half": "2", "min_job_grade": "12"})
        new = c2.execute("SELECT id, min_job_grade, is_active FROM cycles WHERE code='ZZMG-YE'").fetchone()
        s.check("the new cycle carries JG 12, active", new and new[1] == 12 and new[2] == 1, new)
        if new:
            pairs = {(x[0], x[1]) for x in c2.execute(
                "SELECT su.employee_id, ass.employee_id FROM assignments a JOIN users su ON su.id=a.subject_id "
                "JOIN users ass ON ass.id=a.assessor_id WHERE a.cycle_id=? AND su.employee_id LIKE 'ZZMG-%'",
                (new[0],))}
            s.check("the clone carries 14 <- 12 and drops 12 <- 11", ("ZZMG-14", "ZZMG-12") in pairs
                    and ("ZZMG-12", "ZZMG-11") not in pairs, sorted(pairs))
        c2.close()
    finally:
        a.DB_PATH = real
        shutil.rmtree(tmp, ignore_errors=True)
finally:
    with a.app.app_context():
        d = a.get_db()
        _cleanup(d)
        d.execute("UPDATE cycles SET min_job_grade=? WHERE id=?", (MG0, CID))
        d.execute("DELETE FROM activity_log WHERE action='participant_min_grade' AND detail LIKE '%%-> %%' AND "
                  "user_id=?", (SU["id"],))
        d.commit()
sys.exit(s.done())
