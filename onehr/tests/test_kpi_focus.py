"""The KPI library redesign, part 3: a KPI line's Focus and Description (Chris, 2026-10-18: "let user to be able to
describe their KPI in details during the setting phase"; the library keeps a short definition, no longer copied onto
the line; a Focus says what a line is about when the same KPI is held more than once).

What this suite holds:
  * a line's name is the KPI then " · " and its Focus; the same KPI twice with two Focuses is two lines, the same one
    twice is refused; a BU-level KPI takes no Focus; a Focus is a few words
  * the person page's add and edit (the KPI box holds the KPI, the Focus box its Focus); Add a person's KPI step;
    the KPI targets import's Focus column
  * the setting chat no longer copies the library's definition onto a line
  * a name merged as a variant comes into the next cycle as the KPI with its qualifier as the Focus
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A KPI line's Focus and Description")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO = "ZZKF Group", "ZZKF Unit"


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9KF-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM cycles WHERE code='ZZKF-NEXT'")
    db.execute("DELETE FROM pm_kpi_aliases WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def lines(uid):
    return {r[0]: r[1] for r in H.rows(a, "SELECT kpi_name, focus FROM pm_kpi_targets WHERE cycle_id=? AND "
                                          "subject_id=?", (CID, uid))}


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    LIB = {}
    for nm, bu in (("ZZKF Brand awareness", 0), ("ZZKF Unit PAT", 1)):
        LIB[nm] = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, "
                             "kpi_name, description, unit, method, bu_level) VALUES (?, '*', '*', 0, '*', ?, "
                             "'the library definition', '%', 'more', ?)", (BG, nm, bu)).lastrowid
    M = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                   "job_grade, confirmation_date) VALUES ('zz9kf-m', 'ZZ KF M', 'x', 'user', 'ZZ9KF-M', ?,?, '20', "
                   "'2020-01-01')", (BG, CO)).lastrowid
    P = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                   "job_grade, confirmation_date, manager_id) VALUES ('zz9kf-p', 'ZZ KF P', 'x', 'user', 'ZZ9KF-P', "
                   "?,?, '14', '2020-01-01', ?)", (BG, CO, M)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
URL = "/admin/users/%d/kpi" % P


def add(**kw):
    d = {"csrf_token": "tok", "action": "add", "kpi": "ZZKF Brand awareness", "weightage": "20", "method": "more",
         "library_id": str(LIB["ZZKF Brand awareness"]),
         "rate 1": "1", "rate 2": "2", "rate 3": "3", "rate 4": "4", "rate 5": "5", "moderator": "lm"}
    d.update(kw)
    return SUP.post(URL, data=d, follow_redirects=True)


try:
    s.section("the rule")
    s.check("the name is the KPI, then its Focus", a.kpi_line_name("Brand awareness", "  Elba ") ==
            "Brand awareness · Elba" and a.kpi_line_name("Brand awareness", "") == "Brand awareness")
    s.check("...and the KPI reads back from it", a.kpi_line_base("Brand awareness · Elba", "Elba") == "Brand awareness")

    s.section("the person page")
    add(focus="Elba")
    add(focus="Aurora")
    got = lines(P)
    s.check("the same KPI with two Focuses is two lines", got.get("ZZKF Brand awareness · Elba") == "Elba"
            and got.get("ZZKF Brand awareness · Aurora") == "Aurora", got)
    r = add(focus="Elba")
    s.check("the same KPI and Focus twice is refused", len(lines(P)) == 2
            and "already has a KPI called" in r.get_data(as_text=True))
    r = add(kpi="ZZKF Unit PAT", focus="Plant 2", library_id=str(LIB["ZZKF Unit PAT"]))
    s.check("a BU-level KPI can't be added here at all (it comes from the BU KPI page)",
            not any("Unit PAT" in k for k in lines(P)) and "BU KPI" in r.get_data(as_text=True))
    # a line whose KPI is BU-level by name still takes no Focus: make it as a plain one, then mark the library row BU-level
    with a.app.app_context():
        a.get_db().execute("UPDATE pm_kpi_library SET bu_level=0 WHERE id=?", (LIB["ZZKF Unit PAT"],))
        a.get_db().commit()
    add(kpi="ZZKF Unit PAT", library_id=str(LIB["ZZKF Unit PAT"]))
    with a.app.app_context():
        a.get_db().execute("UPDATE pm_kpi_library SET bu_level=1 WHERE id=?", (LIB["ZZKF Unit PAT"],))
        a.get_db().commit()
    pat = H.one(a, "SELECT id FROM pm_kpi_targets WHERE subject_id=? AND kpi_name='ZZKF Unit PAT'", (P,))
    r = SUP.post(URL, data={"csrf_token": "tok", "action": "edit", "kpi_target_id": pat, "kpi": "ZZKF Unit PAT",
                            "focus": "Plant 2", "weightage": "20", "method": "more", "rate 1": "1", "rate 2": "2",
                            "rate 3": "3", "rate 4": "4", "rate 5": "5", "moderator": "lm"}, follow_redirects=True)
    s.check("a BU-level KPI takes no Focus (told why)", "takes no Focus" in r.get_data(as_text=True)
            and H.one(a, "SELECT focus FROM pm_kpi_targets WHERE id=?", (pat,)) in (None, ""))
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_kpi_targets WHERE id=?", (pat,))
        a.get_db().commit()
    add(focus="x" * 61)
    s.check("a Focus is a few words", len(lines(P)) == 2)
    tab = SUP.get("/admin/users/%d?tab=performance" % P).get_data(as_text=True)
    s.check("its edit form holds the KPI in the KPI box and the Focus in its own", 'name="kpi" value="ZZKF Brand '
            'awareness"' in tab and 'name="focus" maxlength="60" value="Elba"' in tab)
    tid = H.one(a, "SELECT id FROM pm_kpi_targets WHERE subject_id=? AND focus='Aurora'", (P,))
    SUP.post(URL, data={"csrf_token": "tok", "action": "edit", "kpi_target_id": tid, "kpi": "ZZKF Brand awareness",
                        "focus": "Aurora Kids", "weightage": "20", "method": "more", "rate 1": "1", "rate 2": "2",
                        "rate 3": "3", "rate 4": "4", "rate 5": "5", "moderator": "lm"})
    s.check("an edit to the Focus renames the line", H.rows(a, "SELECT kpi_name, focus FROM pm_kpi_targets WHERE id=?",
                                                          (tid,))[0][:] == ("ZZKF Brand awareness · Aurora Kids",
                                                                            "Aurora Kids"))

    s.section("Add a person's KPI step and the import")
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_kpi_targets WHERE subject_id=?", (P,))
        a.get_db().commit()
    form = {"csrf_token": "tok", "action": "kpis", "then": "save", "lib_id": [str(LIB["ZZKF Brand awareness"])] * 2,
            "focus": ["North", "South"], "weightage": ["60", "40"], "description": ["their words", ""],
            "method": ["more", "more"]}
    for i in range(1, 6):
        form["rate %d" % i] = [str(i), str(i)]
    SUP.post("/admin/people/add/%d" % P, data=form)
    got = lines(P)
    s.check("Add a person: the same library KPI twice, each with its Focus", got == {
        "ZZKF Brand awareness · North": "North", "ZZKF Brand awareness · South": "South"}, got)
    s.check("...the library's definition isn't copied onto the line", H.one(
        a, "SELECT description FROM pm_kpi_targets WHERE subject_id=? AND focus='South'", (P,)) is None)
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_kpi_targets WHERE subject_id=?", (P,))
        a.get_db().commit()
    csv = ("Employee ID,KPI,Focus,Weightage,Method,Rate 1,Rate 2,Rate 3,Rate 4,Rate 5\n"
           "ZZ9KF-P,ZZKF Brand awareness,East,50,More,1,2,3,4,5\n"
           "ZZ9KF-P,ZZKF Brand awareness,West,50,More,1,2,3,4,5\n")
    r = H.import_steps(SUP, "/admin/performance/import", {"file": (io.BytesIO(csv.encode()), "f.csv")})
    got = lines(P)
    s.check("the import's Focus column: two lines of one KPI", got == {"ZZKF Brand awareness · East": "East",
                                                                      "ZZKF Brand awareness · West": "West"}, got)
    tpl = H.as_csv_text(SUP.get("/admin/performance/import/template.csv"))
    s.check("...and its template carries the column", tpl.splitlines()[0].startswith("Employee ID,KPI,Focus,"))

    s.section("the setting chat")
    src = H.source(a)
    seg = src.split("def _setting_tool_add_kpi", 1)[1].split("def _setting_tool_remove_kpi", 1)[0]
    s.check("its add no longer copies the library's definition onto the line", 'lib["category"], None,' in seg
            and 'lib["description"]' not in seg)

    s.section("a merged variant in the next cycle")
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id=?", (P,))
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, "
                   "rate4, rate5, business_group, company, status) VALUES (?,?, 'ZZKF Channel: A tier', 100, 'more', "
                   "1,2,3,4,5, ?,?, 'approved')", (CID, P, BG, CO))
        db.execute("INSERT INTO pm_kpi_aliases(business_group, alias_key, alias_name, into_key, into_name, kind, "
                   "qualifier) VALUES (?, 'zzkf channel: a tier', 'ZZKF Channel: A tier', 'zzkf channel', "
                   "'ZZKF Channel', 'variant', 'A tier')", (BG,))
        NEXT = db.execute("INSERT INTO cycles(name, code, is_active) VALUES ('ZZKF next', 'ZZKF-NEXT', 0)").lastrowid
        a._pm_carry_kpis(db, CID, NEXT, SU["id"])
        db.commit()
    got = {r[0]: r[1] for r in H.rows(a, "SELECT kpi_name, focus FROM pm_kpi_targets WHERE cycle_id=? AND "
                                         "subject_id=?", (NEXT, P))}
    s.check("it comes in as the KPI, its qualifier the Focus", got == {"ZZKF Channel · A tier": "A tier"}, got)
    s.check("...and the old cycle keeps its name", "ZZKF Channel: A tier" in lines(P))
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
