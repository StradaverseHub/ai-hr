"""A KPI's definition is generic (Chris, 2026-10-19: "the definition should be generic and serve to explain what the KPI
does and what it measures, perhaps we can use like X% or X amount to substitute the metric").

What this suite holds:
  * the rule: a percentage, a comparison with a number, an RM amount or a number of days / hours / units in a
    definition is a target and is refused, said back in full ('≥20%', 'RM2mil'); X%, RM X, and names with digits
    (ISO 9001, 5S) are fine
  * every place a definition is written refuses one: the library's form, a BG admin's proposal (a new KPI and a
    definition change) and the library import
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A KPI definition says what is measured, never the target")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG = "ZZDF Group"
LIB = "/admin/performance/library"


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9DF-%'")]
    db.execute("DELETE FROM pm_library_requests WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action='pm_kpi_library' AND detail LIKE '%ZZDF%'")
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'U1')", (BG,))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, description, "
               "unit, method) VALUES (?, '*', '*', 0, '*', 'ZZDF Collection rate', 'Cash collected against amounts due', "
               "'%', 'more')", (BG,))
    BA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                    "VALUES ('zz9df-bga', 'ZZ DF Groupadmin', 'x', 'admin', 'ZZ9DF-BGA', ?, ?)", (BG, BG)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
BAC = H.client_as(a, BA)


def n_lib(name):
    return H.one(a, "SELECT COUNT(*) FROM pm_kpi_library WHERE business_group=? AND kpi_name=?", (BG, name))


try:
    s.section("the rule")
    F = a.kpi_def_figure
    targets = {"Achieve ≥20% of project proposal submissions selected": "≥20%",
               "Achieve RM2mil revenue from telemarketing": "RM2mil",
               "Monetary loss per sale <= 0.2%": "<= 0.2%", "Submit within 4 working days": "4 working days",
               "Aged coil usage (20K/ month)": "20K", "Revenue of RM 1,250,000": "RM 1,250,000"}
    s.check("a target in a definition is found, said in full", all(F(t) == f for t, f in targets.items()),
            {t: F(t) for t in targets})
    s.check("...X%, RM X and names with digits are fine", all(F(t) is None for t in (
        "Percentage of proposals selected, against a target of X%", "RM X of revenue from telemarketing",
        "Achieve ISO 9001 certification", "5S audit score across the plant", "COVID-19 compliance", "", None)))

    s.section("every writer refuses one")
    base = {"csrf_token": "tok", "action": "add", "business_group": BG, "company": "*", "department_mode": "any",
            "tier_n": "0", "method": "more"}
    r = SUP.post(LIB, data=dict(base, kpi_name="ZZDF Proposals selected",
                                description="Achieve ≥20% of proposals selected"), follow_redirects=True)
    s.check("the library's form, told why", n_lib("ZZDF Proposals selected") == 0
            and "it says &#39;≥20%&#39;" in r.get_data(as_text=True))
    SUP.post(LIB, data=dict(base, kpi_name="ZZDF Proposals selected",
                            description="Percentage of proposals selected or specified in the bill of quantities"))
    s.check("...a generic one saves", n_lib("ZZDF Proposals selected") == 1)
    BAC.post("/admin/performance/library/propose", data={
        "csrf_token": "tok", "kind": "new_kpi", "scope": "bg", "name": "ZZDF Telemarketing revenue", "method": "more",
        "definition": "Achieve RM2mil revenue from telemarketing", "unit": "RM", "reason": "Sales carry it"})
    s.check("a BG admin's proposed new KPI", H.one(
        a, "SELECT COUNT(*) FROM pm_library_requests WHERE business_group=? AND payload_json LIKE '%Telemarketing%'",
        (BG,)) == 0)
    BAC.post("/admin/performance/library/propose", data={
        "csrf_token": "tok", "kind": "change_def", "kpi": "zzdf collection rate",
        "definition": "Collect 95% of amounts due", "reason": "Clearer"})
    s.check("...and a proposed definition change", H.one(
        a, "SELECT COUNT(*) FROM pm_library_requests WHERE business_group=? AND kind='change_def'", (BG,)) == 0)
    csv_ = ("Business Group,Company,Department,Tier,Job Grade,KPI,KPI Description,Method,Rate 1,Rate 2,Rate 3,Rate 4,"
            "Rate 5\n%s,,,,,ZZDF Imported,Reach 30 days DSO,More,1,2,3,4,5\n" % BG)
    r = H.import_steps(SUP, "/admin/performance/library/import", {"file": (io.BytesIO(csv_.encode()), "lib.csv")})
    s.check("the library import, told why", n_lib("ZZDF Imported") == 0
            and "A figure in the definition" in r.get_data(as_text=True))   # step 2 names the kind; the rule's words are in its download
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
