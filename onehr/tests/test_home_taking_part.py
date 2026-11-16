"""Home's Performance and Competency cells, and the module Progress pages, count only people taking part in THAT part
(Chris, 2026-11-08: "progress counts only people taking part in that part; KPI lines or competencies set up are not enough").

Found on CHGB: Competency read "45 of 90 self-assessed" while 53 people took part, because the cell counted everyone with
competencies assigned. Now Home's cell, its list panel (one helper, _home_cell_taking_sql) and the module pages
(_mod_scope_users(module=...)) share one rule: participant_sql for that part, in the active cycle.

What this suite holds (its own synthetic business group ZZHP, everything put back at the end):
  * a person with KPI lines and competencies who is taken out (cycle_participants 'remove') is left out of the Home cell's
    denominator and of the cell's list, for Performance and for Competency; putting them back counts them again, by exactly one
  * a person whose user role opens Performance but not Competency is in Performance and out of Competency: on Home, in the
    list and on the Competency module page (the Performance page keeps them)
  * a Grade H person with both is in neither
  * a past cycle keeps its plain read (the helper returns nothing for a cycle that is not the active one)
  * the cell's n equals its list's count, and the Competency page's people equal the cell's n
  * the guards are real: the helper made a no-op, and _mod_scope_users made to ignore `module`, each fail the checks
"""
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Home and module progress count only people taking part in that part")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG = "ZZHP Group"
NAV = {"Sec-Fetch-Mode": "navigate"}
ROLE_NAME = "ZZHP Performance only"


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9HP-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        for tb in ("tc_assignments", "tc_assessments", "pm_kpi_targets", "cycle_participants"):
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (tb, ph), ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM user_roles WHERE name=?", (ROLE_NAME,))
    db.execute("DELETE FROM tc_skills WHERE skill_code='ZZ9HP-SKILL'")
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
    for k in ("review", "pm", "tm"):
        if db.execute("SELECT 1 FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k)).fetchone():
            db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key=?", (CID, k))
        else:
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, k))
    rid = db.execute("INSERT INTO user_roles(name) VALUES (?)", (ROLE_NAME,)).lastrowid
    db.execute("INSERT INTO user_role_modules(role_id, module) VALUES (?, 'pm')", (rid,))   # Performance, no Competency
    SKILL = db.execute("INSERT INTO tc_skills(skill_code, title) VALUES ('ZZ9HP-SKILL', 'ZZHP skill')").lastrowid

    def mk(eid, grade="14", user_role=None):
        uid = db.execute(
            "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, department, "
            "job_title, job_grade, confirmation_date, years_of_service, user_role_id) "
            "VALUES (?,?,'x','user',?,?,?,'ZZHP Dept','ZZHP Officer',?,'2020-01-01',4.0,?)",
            (eid.lower(), "ZZ HP " + eid[6:], eid, BG, BG + " U1", grade, user_role)).lastrowid
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, status) "
                   "VALUES (?,?,?,100,'more',?,'approved')", (CID, uid, "ZZHP KPI " + eid[6:], BG))
        db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) VALUES (?,?,?)", (CID, uid, SKILL))
        return uid
    P1, P2 = mk("ZZ9HP-P1"), mk("ZZ9HP-P2")     # taking part in both
    P3 = mk("ZZ9HP-P3", user_role=rid)           # Performance only (role opens no Competency)
    P4 = mk("ZZ9HP-P4")                          # taken out, flipped back in by the test
    P5 = mk("ZZ9HP-P5", grade="H")               # Grade H: in neither
    db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'remove')", (CID, P4))
    db.commit()
    SU = db.execute("SELECT * FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                    "AND employee_id NOT LIKE 'ZZ9HP-%' LIMIT 1").fetchone()
    SUID = SU["id"]


def home_cell(col):
    """(done, n) of Home's cell for BG ZZHP; (0, 0) when it reads 'none set'."""
    with a.app.test_request_context("/"):
        d = a.get_db()
        su = d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone()
        a.g.user = su
        mat = a._home_bg_matrix(d, su, a.active_cycle(d))
    ix = [c["key"] for c in mat["cols"]].index(col)
    cell = next(r for r in mat["rows"] if r["bg"] == BG)["cells"][ix]
    m = re.match(r"([\d,]+) of ([\d,]+)", cell["sub"] or "")
    return (int(m.group(1).replace(",", "")), int(m.group(2).replace(",", ""))) if m else (0, 0)


def home_list(col):
    """(count in the title's 'of N', the names listed) for the cell's list panel, over HTTP, as the super admin."""
    with a.app.test_request_context("/"):
        url = a.url_for("admin_list_view", key="home-cell", col=col, fragment=1, bg=BG)
    r = H.client_as(a, SUID).get(url, headers=NAV)
    t = html.unescape(r.get_data(as_text=True))
    m = re.search(r"of ([\d,]+) (?:self-assessed|scorecards submitted)", t)
    return r.status_code, (int(m.group(1).replace(",", "")) if m else None), set(re.findall(r"ZZ HP P\d", t))


def page_people(mod_key):
    """The ZZHP people on a module's Progress data (_mod_collect), and the page itself opening."""
    with a.app.test_request_context("/"):
        d = a.get_db()
        su = d.execute("SELECT * FROM users WHERE id=?", (SUID,)).fetchone()
        a.g.user = su
        users, _st, _note = a._mod_collect(d, su, a._module_view(mod_key), BG)
    code = H.client_as(a, SUID).get("/admin/module/%s/progress?fbg=%s" % (mod_key, BG.replace(" ", "+")), headers=NAV).status_code
    return {u["employee_id"] for u in users.values()}, code


def invariants():
    """name -> bool: Home's cells, their lists and the module pages, with P4 taken out. Run on the real app, then broken."""
    out = {}
    pm_done, pm_n = home_cell("pm")
    tc_done, tc_n = home_cell("competency")
    out["Performance cell: P1, P2, P3 only (P4 taken out, P5 Grade H)"] = pm_n == 3
    out["Competency cell: P1, P2 only (P3 has no Competency, P4 out, P5 Grade H)"] = tc_n == 2
    for col, n, want in (("pm", pm_n, {"ZZ HP P1", "ZZ HP P2", "ZZ HP P3"}), ("competency", tc_n, {"ZZ HP P1", "ZZ HP P2"})):
        code, cnt, names = home_list(col)
        out["%s list opens, its count is the cell's n" % col] = code == 200 and cnt == n
        out["%s list holds exactly the taking-part people" % col] = names == want
    ppl_tc, c_tc = page_people("competency")
    ppl_pm, c_pm = page_people("pm")
    out["Competency page: P1, P2 (its people = the cell's n)"] = (
        c_tc == 200 and {e for e in ppl_tc if e.startswith("ZZ9HP-")} == {"ZZ9HP-P1", "ZZ9HP-P2"} and len(
            {e for e in ppl_tc if e.startswith("ZZ9HP-")}) == tc_n)
    out["Performance page keeps P3 (taking part in Performance), not P4 / P5"] = (
        c_pm == 200 and {e for e in ppl_pm if e.startswith("ZZ9HP-")} == {"ZZ9HP-P1", "ZZ9HP-P2", "ZZ9HP-P3"})
    return out


try:
    s.section("P4 taken out: left out of both cells, both lists and the Competency page")
    inv = invariants()
    for k, v in inv.items():
        s.check(k, v)

    s.section("putting P4 back counts them again, by exactly one")
    pm0, tc0 = home_cell("pm")[1], home_cell("competency")[1]
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM cycle_participants WHERE cycle_id=? AND subject_id=?", (CID, P4))
        d.commit()
    pm1, tc1 = home_cell("pm")[1], home_cell("competency")[1]
    s.check("Performance n goes up by exactly one", pm1 == pm0 + 1, (pm0, pm1))
    s.check("Competency n goes up by exactly one", tc1 == tc0 + 1, (tc0, tc1))
    _c, _cnt, names_pm = home_list("pm")
    _c, _cnt, names_tc = home_list("competency")
    s.check("both lists now hold P4", "ZZ HP P4" in names_pm and "ZZ HP P4" in names_tc)
    s.check("the Competency page holds P4 again", "ZZ9HP-P4" in page_people("competency")[0])
    s.check("P3 stays out of Competency and P5 out of both, whoever is taken in",
            "ZZ HP P3" not in names_tc and "ZZ HP P5" not in names_pm | names_tc)
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'remove')", (CID, P4))
        d.commit()
    s.check("taking P4 out again returns both cells to the first read", (home_cell("pm")[1], home_cell("competency")[1]) == (pm0, tc0))

    s.section("a past cycle keeps its plain read")
    with a.app.app_context():
        d = a.get_db()
        act = d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()
        past = dict(act)
        past["is_active"] = 0
        s.check("the helper adds nothing for a cycle that is not the active one",
                a._home_cell_taking_sql("pm", past) == "" and a._home_cell_taking_sql("competency", past) == ""
                and a._home_cell_taking_sql("pm", None) == "")
        s.check("...and for the active one adds the part's own participant_sql, nothing for other columns",
                a._home_cell_taking_sql("pm", act) == " AND " + a.participant_sql("u", "pm")
                and a._home_cell_taking_sql("competency", act) == " AND " + a.participant_sql("u", "competency")
                and a._home_cell_taking_sql("idp", act) == "" and a._home_cell_taking_sql("f360", act) == "")

    s.section("the guards are real (each broken, then put back)")
    real_helper, real_scope = a._home_cell_taking_sql, a._mod_scope_users
    for name, attr, fn in (
            ("the helper made a no-op", "_home_cell_taking_sql", lambda col, cyc: ""),
            ("_mod_scope_users ignoring `module`", "_mod_scope_users",
             lambda *args, **kw: real_scope(*args, **{k: v for k, v in kw.items() if k != "module"}))):
        old = getattr(a, attr)
        setattr(a, attr, fn)
        try:
            bad = [k for k, v in invariants().items() if not v]
        finally:
            setattr(a, attr, old)
        s.check("falsified: %s makes the checks fail" % name, bool(bad), bad[:2])
    s.check("...and with the guards back every invariant holds again", all(invariants().values()))
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)
        _db.execute("UPDATE cycles SET kind=?, half=?, starts_on=?, min_job_grade=? WHERE id=?",
                    (CYC0["kind"], CYC0["half"], CYC0["starts_on"], CYC0["min_job_grade"], CID))
        for k in ("review", "pm", "tm"):
            if k in MODS0:
                _db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (MODS0[k], CID, k))
            else:
                _db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key=?", (CID, k))
        _db.commit()

sys.exit(s.done())
