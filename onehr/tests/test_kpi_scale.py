"""The KPI scale check (Chris, 2026-10-18: "if the kpi is higher is better, the setting should be in increment order and
no 2 rating should share the same value, second for the threshold/target mechanism, the target should never be 0 as it
won't be able to calculate the achievement").

What this suite holds:
  * the rule (pm_scale_error): 5-point rating rises strictly when higher is better, falls strictly when lower is
    better, no two equal; Achievement %'s target is never 0 and its threshold sits on the right side of the target;
    a missing value is left to the caller's own completeness check
  * every writer asks it: the shared import / person-page validator (_pm_kpi_values), the KPI import (all or
    nothing), the person page's add and edit, the KPI library's form, and the KPI-setting chat's propose gate and
    line check (pm_ladder_monotonic is strict now)
  * the screens check as you type with the same words (kpi_scale.js on every page; the forms opt in)
Self-contained: its own business groups, people and KPI lines, deleted at the end.
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("KPI scale check -- ratings in order, none the same; a target is never 0")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BGA_, BGB_ = "ZZKS Group A", "ZZKS Group B"
CO = "ZZKS Unit"
CFG_A = {"mechanism": "A", "variant": None, "business_group": BGA_}
CFG_B = {"mechanism": "B", "variant": "excellence", "business_group": BGB_}
E = a.pm_scale_error
ids = {}


def _cleanup(db):
    db.execute("DELETE FROM pm_kpi_library WHERE business_group IN (?,?)", (BGA_, BGB_))
    db.execute("DELETE FROM pm_rating_bands WHERE business_group IN (?,?)", (BGA_, BGB_))
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?)", (BGA_, BGB_))
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZKS-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE "
                   "subject_id IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BGA_, BGB_))
    db.commit()


def rates(*v):
    return {"rate%d" % (i + 1): x for i, x in enumerate(v)}


# ----------------------------------------------------------------------------------------------------------------
s.section("the rule")
s.check("higher is better, rising: fine", E(CFG_A, "more", rates(10, 20, 30, 40, 50)) is None)
s.check("...two the same: refused, saying which", "Rate 3 can't be the same as Rate 2" in (E(CFG_A, "more", rates(
    10, 20, 20, 40, 50)) or ""))
s.check("...falling: refused", "Rate 2 must be higher than Rate 1" in (E(CFG_A, "more", rates(50, 40, 30, 20, 10)) or ""))
s.check("lower is better, falling: fine", E(CFG_A, "less", rates(5, 4, 3, 2, 1)) is None)
s.check("...rising: refused", "Rate 2 must be lower than Rate 1" in (E(CFG_A, "less", rates(1, 2, 3, 4, 5)) or ""))
s.check("...two the same: refused", "can't be the same" in (E(CFG_A, "less", rates(5, 4, 4, 2, 1)) or ""))
s.check("a missing rating is the caller's check, not this one", E(CFG_A, "more", rates(10, None, 30, 40, 50)) is None)
s.check("the KPI's name leads the message when given", (E(CFG_A, "more", rates(1, 1, 2, 3, 4), "Sales") or "")
        .startswith("'Sales': "))
B = lambda th, tg: {"threshold": th, "target": tg}  # noqa: E731
s.check("Achievement %: a target of 0 is refused", "target can't be 0" in (E(CFG_B, "more", B(0, 0)) or ""))
s.check("...for lower is better too", "target can't be 0" in (E(CFG_B, "less", B(5, 0)) or ""))
s.check("higher is better: the threshold below the target", E(CFG_B, "more", B(80, 100)) is None
        and "below the target" in (E(CFG_B, "more", B(100, 100)) or "")
        and "below the target" in (E(CFG_B, "more", B(120, 100)) or ""))
s.check("lower is better: the threshold above the target", E(CFG_B, "less", B(120, 100)) is None
        and "above the target" in (E(CFG_B, "less", B(80, 100)) or ""))
s.check("no target yet: the caller's check", E(CFG_B, "more", B(80, None)) is None)

# ----------------------------------------------------------------------------------------------------------------
s.section("the shared validator, and the setting chat")
rec = {"weightage": "20", "method": "More", "rate 1": "10", "rate 2": "20", "rate 3": "20", "rate 4": "40",
       "rate 5": "50"}
v, err = a._pm_kpi_values(rec, CFG_A, "ZZKS Sales")
s.check("_pm_kpi_values refuses two equal ratings (the import and the person page read it)", v is None
        and "can't be the same" in (err or ""), err)
v, err = a._pm_kpi_values(dict(rec, **{"rate 3": "30"}), CFG_A, "ZZKS Sales")
s.check("...and takes the same line in order", v is not None and err is None, err)
v, err = a._pm_kpi_values({"weightage": "20", "method": "More", "threshold": "0", "target": "0",
                           "excellence": "120"}, CFG_B, "ZZKS Margin")
s.check("...refuses an Achievement % target of 0", v is None and "target can't be 0" in (err or ""), err)
s.check("pm_ladder_monotonic is strict now (an equal pair fails the setting chat's line check)",
        a.pm_ladder_monotonic(dict(rates(1, 2, 2, 3, 4)), "more") is False
        and a.pm_ladder_monotonic(dict(rates(1, 2, 3, 4, 5)), "more") is True)
line = lambda **k: dict({"kpi_name": "ZZKS Line", "weightage": 100, "method": "more", "threshold": 80, "target": 0,  # noqa
                         "excellence": 120, **rates(None, None, None, None, None)}, **k)
ok, errs, _w = a._pm_setting_validate({"mine": [line()], "cfg": CFG_B})
s.check("the setting chat's propose gate refuses a 0 target", ok is False and any("target can't be 0" in e for e in errs),
        errs)
ok, errs, _w = a._pm_setting_validate({"mine": [line(target=100)], "cfg": CFG_B})
s.check("...and passes it with a real target", ok is True, errs)
ok, errs, _w = a._pm_setting_validate({"mine": [line(**rates(10, 20, 20, 40, 50))], "cfg": CFG_A})
s.check("...refuses equal ratings, in the shared words", ok is False and any("can't be the same" in e for e in errs),
        errs)
s.check("the setting chat's line check refuses a 0 target", a._setting_line_complete(line(), CFG_B) is False
        and a._setting_line_complete(line(target=100), CFG_B) is True)

# ----------------------------------------------------------------------------------------------------------------
try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        for bg in (BGA_, BGB_):
            db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (bg, CO))
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (BGA_,))
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'excellence')", (BGB_,))

        def mk(eid, bg, mgr=None):
            return db.execute(
                "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                "department, job_title, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', 'user', ?,?,?, "
                "'ZZ Dept', 'ZZ Analyst', '16', '2020-01-01', ?)", (eid.lower(), "ZZ KS " + eid[5:], eid, bg, CO, mgr)
            ).lastrowid
        for bg_, nm_ in ((BGA_, "ZZKS Units"), (BGB_, "ZZKS Margin")):   # an Add picks a library KPI (2026-10-30)
            ids["lib " + nm_] = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, "
                                           "job_grade, kpi_name, unit, method, active) VALUES (?, '*', '*', 0, '*', ?, "
                                           "'%', 'more', 1)", (bg_, nm_)).lastrowid
        ids["m"] = mk("ZZKS-M", BGA_)
        ids["a"] = mk("ZZKS-A", BGA_, ids["m"])
        ids["b"] = mk("ZZKS-B", BGB_, ids["m"])
        CID = a.active_cycle(db)["id"]
        db.commit()
    SUP = H.client_as(a, SU["id"])

    def n(uid):
        return H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (CID, uid))

    s.section("the person page and the import")
    base = {"csrf_token": "tok", "action": "add", "weightage": "20", "method": "more", "moderator": "lm"}
    r = SUP.post("/admin/users/%d/kpi" % ids["a"], data=dict(base, kpi="ZZKS Units", library_id=str(ids["lib ZZKS Units"]), **{
        "rate 1": "10", "rate 2": "20", "rate 3": "20", "rate 4": "40", "rate 5": "50"}), follow_redirects=True)
    s.check("the person page refuses equal ratings and says why", n(ids["a"]) == 0
            and "Rate 3 can&#39;t be the same as Rate 2" in r.get_data(as_text=True))
    SUP.post("/admin/users/%d/kpi" % ids["a"], data=dict(base, kpi="ZZKS Units", library_id=str(ids["lib ZZKS Units"]), **{
        "rate 1": "10", "rate 2": "20", "rate 3": "30", "rate 4": "40", "rate 5": "50"}))
    s.check("...and adds the line in order", n(ids["a"]) == 1)
    tid = H.one(a, "SELECT id FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=?", (ids["a"], CID))
    SUP.post("/admin/users/%d/kpi" % ids["a"], data=dict(base, action="edit", kpi_target_id=tid, kpi="ZZKS Units", **{
        "rate 1": "50", "rate 2": "40", "rate 3": "30", "rate 4": "20", "rate 5": "10"}))
    s.check("...an edit that turns it upside down is refused", H.one(
        a, "SELECT rate1 FROM pm_kpi_targets WHERE id=?", (tid,)) == 10)
    SUP.post("/admin/users/%d/kpi" % ids["b"], data=dict(base, kpi="ZZKS Margin", library_id=str(ids["lib ZZKS Margin"]), threshold="80", target="0",
                                                         excellence="120"))
    s.check("the person page refuses an Achievement % target of 0", n(ids["b"]) == 0)
    csv = ("Employee ID,KPI,Weightage,Method,Rate 1,Rate 2,Rate 3,Rate 4,Rate 5,Matrix manager ID\n"
           "ZZKS-A,ZZKS Quality,30,More,1,2,3,4,5,\n"
           "ZZKS-A,ZZKS Speed,30,Less,1,2,3,4,5,\n")
    r = H.import_steps(SUP, "/admin/performance/import", {"file": (io.BytesIO(csv.encode()), "k.csv")})
    s.check("the KPI import refuses the file over one upside-down line, and imports nothing", n(ids["a"]) == 1
            and "A scale out of order" in r.get_data(as_text=True))   # step 2 names it, nothing goes on

    s.section("the KPI library")
    lib0 = H.one(a, "SELECT COUNT(*) FROM pm_kpi_library WHERE business_group=?", (BGA_,))
    form = {"csrf_token": "tok", "action": "add", "business_group": BGA_, "company": "", "department": "",
            "tier_n": "0", "job_grade": "", "kpi_name": "ZZKS Library KPI", "method": "more", "weightage_default": "10",
            "rate1": "10", "rate2": "10", "rate3": "30", "rate4": "40", "rate5": "50"}
    SUP.post("/admin/performance/library", data=form, follow_redirects=True)
    # the library holds no numbers (Chris, 2026-11-02): a scale posted to its form is not read, so there is no scale
    # to be out of order and nothing to refuse; the row goes in with every number column empty
    s.check("its form takes the KPI and ignores a posted scale (two equal ratings are not an error there)", H.one(
        a, "SELECT COUNT(*) FROM pm_kpi_library WHERE business_group=?", (BGA_,)) == lib0 + 1 and H.one(
        a, "SELECT COUNT(*) FROM pm_kpi_library WHERE business_group=? AND kpi_name='ZZKS Library KPI' AND rate1 IS NULL "
           "AND rate2 IS NULL AND weightage_default IS NULL AND spread_json IS NULL", (BGA_,)) == 1)

    libcsv = ("Business Group,Company,Department,Tier,Job Grade,KPI,Method,Rate 1,Rate 2,Rate 3,Rate 4,Rate 5\n"
              "%s,,,,,Quartzline Throughput Index,Less,1,2,3,4,5\n" % BGA_)
    r = H.import_steps(SUP, "/admin/performance/library/import", {"file": (io.BytesIO(libcsv.encode()), "lib.csv")})
    s.check("its import takes an upside-down legacy row and writes no numbers: the scale columns are ignored", H.one(
        a, "SELECT COUNT(*) FROM pm_kpi_library WHERE business_group=? AND kpi_name='Quartzline Throughput Index' AND rate1 IS NULL "
           "AND rate5 IS NULL AND weightage_default IS NULL AND spread_json IS NULL", (BGA_,)) == 1)

    s.section("as you type")
    pg = SUP.get("/admin/users/%d?tab=performance" % ids["a"]).get_data(as_text=True)
    s.check("the person page's add and edit forms opt in to the check", pg.count('data-kpi-scale="A"') >= 2)
    full = SUP.get("/admin/users/%d" % ids["a"]).get_data(as_text=True)
    s.check("every page loads the check", "/static/kpi_scale.js" in full)
    js = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "kpi_scale.js")).read()
    s.check("...in the server's own words", all(w in js for w in (
        "can't be the same as Rate", "must be higher than Rate", "must be lower than Rate",
        "The target can't be 0: achievement is worked out against the target.",
        "The threshold must be below the target: higher is better.",
        "The threshold must be above the target: lower is better.")))
    lp = SUP.get("/admin/performance/library?panel=add&addbg=%s" % BGA_).get_data(as_text=True)
    s.check("the library's own form carries no scale at all: the library holds no targets (Chris, 2026-10-18)",
            'name="kpi_name"' in lp and 'name="rate1"' not in lp and 'name="threshold"' not in lp)
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
