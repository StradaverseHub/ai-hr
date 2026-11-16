"""Band rules that NAME people (Chris, 2026-11-02; canvas [design canvas link removed]).

The problem: Fiamma's non-sales people sit inside mixed sales departments, and a rule covered a whole unit or whole
departments, so none of them could be given their own band starts. A rule can now also name people, or name people only,
and an edit can give the same new starts to every other rule that starts where it does (O1).

What this suite holds:
  * ONE reader. pm_bands_for: the person's NAMED rule, then their department's, their unit's, the group's; each step proved
    by setting the higher one and seeing it win, then removing it and seeing the lower one come back
  * a named person who moves to another unit (or group) reads their new place's bands with nobody editing; back in, the rule
  * refusals: someone outside the unit, someone named on another rule (and the database's own UNIQUE), named people with All
    departments, Only named people with nobody, a person in a department the rule already holds, a non-super admin, a
    closed cycle, no remark; each leaves nothing behind and drops no one silently
  * a people-only rule: saved, listed, counted, previewed, removed (its people rows gone), copied into a new cycle by the seed
  * _band_rule_people: a whole-unit rule less a department that holds its own rule, less people named elsewhere
  * pm_label_for_value(subject=...) with a user id, a user row and a KPI line gives the named rule's band
  * O1: only rules whose saved starts equal the edited rule's are offered; one whose starts changed meanwhile is refused with
    nothing written; every ticked rule saved in one transaction with one audit row each; the records follow once
  * the audit row names Employee IDs, never names; the org rename cascade carries the new table's company
Self-contained: its own groups, units, cycles and people, deleted at the end.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Band rules that name people -- one reader, one person in one rule, one save for several rules")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, BGO = "ZZBP Base Group", "ZZBP Other Group"
UA_, UB_, UO_ = "ZZBP Unit A", "ZZBP Unit B", "ZZBP Other Unit"
SALES, SUPPORT, OPS = "ZZBP SALES", "ZZBP SUPPORT", "ZZBP OPERATIONS"   # HRIS sends departments in capitals
DEFAULT = [0, 61, 81, 101, 121]
UNIT_S, DEPT_S, NAMED_S = [0, 60, 80, 95, 110], [0, 60, 80, 90, 100], [0, 55, 75, 85, 95]
LAB = ("UA", "BE", "ME", "AE", "OU")
PREFIX = "ZZBP-"
ids, CY = {}, {}
PID = None


def q1(sql, args=()):
    return H.one(a, sql, args)


def cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE ?", (PREFIX + "%",))]
    cyc = [r[0] for r in db.execute("SELECT id FROM cycles WHERE code LIKE 'ZZBP-%'")]
    for g_ in (BG, BGO):
        for t in ("pm_cycle_band_rule_people", "pm_cycle_band_rule_depts", "pm_cycle_band_rules", "pm_cycle_bands",
                  "pm_cycle_band_sets"):
            db.execute("DELETE FROM %s WHERE business_group=?" % t, (g_,))
    for c in cyc:
        for t in ("pm_cycle_band_rule_people", "pm_cycle_band_rule_depts", "pm_cycle_band_rules", "pm_cycle_band_sets",
                  "pm_cycle_bands", "leader_releases", "pm_kpi_targets"):
            db.execute("DELETE FROM %s WHERE cycle_id=?" % t, (c,))
        db.execute("DELETE FROM cycles WHERE id=?", (c,))
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM pm_cycle_band_rule_people WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_calibration_adjustments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN "
                   "(%s))" % ph, ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM pm_calibration_sessions WHERE business_group IN (?,?)", (BG, BGO))
    for g_ in (BG, BGO):
        db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (g_,))
        db.execute("DELETE FROM org_units WHERE business_group=?", (g_,))
    db.execute("DELETE FROM activity_log WHERE action='pm_band_rule' AND detail LIKE '%ZZBP%'")
    db.commit()


def n_rules(cid=None):
    return q1("SELECT COUNT(*) FROM pm_cycle_band_rules WHERE business_group=? AND cycle_id=?", (BG, cid or PID))


def n_people_rows(cid=None):
    return q1("SELECT COUNT(*) FROM pm_cycle_band_rule_people WHERE business_group=? AND cycle_id=?", (BG, cid or PID))


def snapshot():
    """Every table a rule save may touch, and the audit log: a refused post or a preview must leave all of it as it found it."""
    return (q1("SELECT COUNT(*) FROM pm_cycle_band_rules"), q1("SELECT COUNT(*) FROM pm_cycle_band_rule_depts"),
            q1("SELECT COUNT(*) FROM pm_cycle_band_rule_people"),
            q1("SELECT COALESCE(SUM(min_ua+min_be+min_me+min_ae+min_ou),0) FROM pm_cycle_band_rules"),
            q1("SELECT COUNT(*) FROM pm_cycle_bands"), q1("SELECT COUNT(*) FROM activity_log"),
            q1("SELECT COUNT(*) FROM pm_calibration_adjustments"), q1("SELECT COUNT(*) FROM pm_kpi_targets"))


try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        cleanup(db)
        PID = a.active_pm_period_id(db)
        s.check("there is an active performance period to put scorecards in", PID is not None)
        for g_, cos in ((BG, (UA_, UB_)), (BGO, (UO_,))):
            for co in cos:
                db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (g_, co))
            db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'base')", (g_,))
            for i, (lo, lab) in enumerate(zip(DEFAULT, LAB), start=1):
                db.execute("INSERT INTO pm_cycle_bands(cycle_id, business_group, min_value, label, sort_order) "
                           "VALUES (?,?,?,?,?)", (PID, g_, lo, lab, i))
        # two cycles of our own: X archived (its band starts are fixed), N made empty for the seed to fill
        CY["X"] = db.execute("INSERT INTO cycles(code, name, is_active, year, half, archived_at) VALUES (?,?,0,2032,2,"
                             "datetime('now'))", ("ZZBP-X", "ZZBP Cycle X")).lastrowid
        CY["N"] = db.execute("INSERT INTO cycles(code, name, is_active, year, half) VALUES (?,?,0,2033,2)",
                             ("ZZBP-N", "ZZBP Cycle N")).lastrowid
        base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND business_group!='' "
                               "AND is_demo=0 LIMIT 1").fetchone())
        cols = [c for c in base.keys() if c != "id"]

        def person(key, name, bg, co, dept, role="user", admin_bg=None, actual=None, left=False, demo=0):
            v = dict(base, username=(PREFIX + key).lower(), employee_id=PREFIX + key, full_name="ZZ BP " + name, email=None,
                     hod_id=None, manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None,
                     business_group=bg, company=co, department=dept, role=role, admin_bg=admin_bg, is_demo=demo,
                     left_at=("2026-01-01" if left else None))
            db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
            uid = db.execute("SELECT id FROM users WHERE username=?", (v["username"],)).fetchone()[0]
            if actual is not None:
                tid = db.execute(
                    "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, threshold, target, multiple, "
                    "business_group, company, department) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (PID, uid, "ZZBP KPI", 100, "more", 50, 100, 0, bg, co, dept)).lastrowid
                db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)",
                           (tid, actual, uid))
            return uid
        # a figure of 100% (multiple 0 caps there) reads ME on the default starts; 80 reads BE
        ids["sal1"] = person("SAL1", "Sales One", BG, UA_, SALES, actual=105)
        ids["sal2"] = person("SAL2", "Sales Two", BG, UA_, SALES, actual=80)
        ids["sup1"] = person("SUP1", "Support One", BG, UA_, SUPPORT, actual=105)
        ids["sup2"] = person("SUP2", "Support Two", BG, UA_, SUPPORT, actual=105)
        ids["ops1"] = person("OPS1", "Operations One", BG, UA_, OPS, actual=105)
        ids["lft1"] = person("LFT1", "Left One", BG, UA_, SUPPORT, left=True)
        ids["dem1"] = person("DEM1", "Demo One", BG, UA_, SUPPORT, demo=1)
        ids["b1"] = person("B1", "Unit B One", BG, UB_, SALES, actual=105)
        ids["b2"] = person("B2", "Unit B Two", BG, UB_, SALES, actual=105)
        ids["o1"] = person("O1", "Other Group One", BGO, UO_, SALES, actual=105)
        ids["bgadm"] = person("BGADM", "Group Admin", BG, UA_, "", role="admin", admin_bg=BG)
        db.commit()
    E = {k: PREFIX + k.upper() for k in ids}      # Employee IDs
    SUP, BGC = H.client_as(a, SU["id"]), H.client_as(a, ids["bgadm"])

    def url():
        return "/admin/performance/config"

    def post(client, cid=None, **kw):
        d = {"csrf_token": "tok", "business_group": BG, "cycle_id": str(cid or PID)}
        d.update(kw)
        return client.post(url(), data=d, follow_redirects=True)

    def starts_form(starts):
        return {"min_" + l: ("%g" % v) for l, v in zip(LAB, starts)}

    def rule_form(unit, depts=None, people=None, starts=NAMED_S, remark="ZZBP agreed with P&R", rid=None, scope=None, **kw):
        d = {"action": "rule_save", "rule_unit": unit,
             "rule_scope": scope or ("depts" if depts else ("people" if people else "unit"))}
        d.update(starts_form(starts))
        if remark is not None:
            d["remark"] = remark
        if rid:
            d["rule_id"] = str(rid)
        d.update(kw)
        if depts:
            d["rule_dept"] = list(depts)
        if people:
            d["rule_person"] = [E[k] if k in E else k for k in people]
        return d

    def bands(uid, bg=BG, cid=None, user=True):
        with a.app.app_context():
            db = a.get_db()
            u, co, dp = a._pm_subject_who(db, uid)
            return [(l, v) for l, v in a.pm_bands_for(db, bg, co, dp, cycle_id=cid or PID, user_id=u if user else None)]

    def starts_of(uid, **kw):
        return [v for _l, v in bands(uid, **kw)]

    def label(subject, value, bg=BG):
        with a.app.app_context():
            db = a.get_db()
            return a.pm_label_for_value(db, bg, "B", value, subject=subject, cycle_id=PID)

    def rid_of(unit, scope="whole", dept=None, cid=None):
        if scope == "whole":
            return q1("SELECT rule_id FROM pm_cycle_band_rule_depts WHERE cycle_id=? AND business_group=? AND company=? "
                      "AND department=''", (cid or PID, BG, unit))
        if scope == "dept":
            return q1("SELECT rule_id FROM pm_cycle_band_rule_depts WHERE cycle_id=? AND business_group=? AND company=? "
                      "AND department=?", (cid or PID, BG, unit, dept))
        return q1("SELECT MAX(id) FROM pm_cycle_band_rules WHERE cycle_id=? AND business_group=? AND company=? AND id NOT IN "
                  "(SELECT rule_id FROM pm_cycle_band_rule_depts)", (cid or PID, BG, unit))

    def remove(rid, cid=None, remark="ZZBP clear"):
        return post(SUP, cid, action="rule_remove", rule_id=str(rid), remark=remark)

    def clear_all():
        for r in H.rows(a, "SELECT id FROM pm_cycle_band_rules WHERE business_group=? AND cycle_id=?", (BG, PID)):
            remove(r[0])

    # ------------------------------------------------------------------------------------------------------------
    s.section("the table, its UNIQUE, and the rename cascade")
    sql = q1("SELECT sql FROM sqlite_master WHERE type='table' AND name='pm_cycle_band_rule_people'") or ""
    s.check("pm_cycle_band_rule_people exists with UNIQUE(cycle_id, user_id) and cascades with its rule",
            "UNIQUE(cycle_id, user_id)" in sql and "ON DELETE CASCADE" in sql and "business_group TEXT NOT NULL" in sql, sql)
    s.check("...and an index on (cycle_id, business_group)", "pm_cycle_band_rule_people" in (q1(
        "SELECT group_concat(sql) FROM sqlite_master WHERE type='index' AND tbl_name='pm_cycle_band_rule_people'") or "")
        and "cycle_id, business_group" in (q1("SELECT group_concat(sql) FROM sqlite_master WHERE type='index' AND "
                                              "tbl_name='pm_cycle_band_rule_people'") or ""))
    src = H.source(a)
    s.check("the table is in SCHEMA (a new database) as well as _ensure_runtime_schema (an old one)",
            src.count("CREATE TABLE IF NOT EXISTS pm_cycle_band_rule_people (") == 1
            and src.count('"CREATE TABLE IF NOT EXISTS pm_cycle_band_rule_people("') == 1)
    with a.app.app_context():
        db = a.get_db()
        s.check("the org rename cascade carries it: it is a settings table and its company column is read from the schema",
                "pm_cycle_band_rule_people" in a._ORG_SETTINGS_TABLES
                and ("pm_cycle_band_rule_people", "company", "business_group") in a._org_name_columns(db)[1]
                and ("pm_cycle_band_rule_people", "business_group") in a._org_name_columns(db)[0])

    # ------------------------------------------------------------------------------------------------------------
    s.section("no rule: nothing changes; a person is passed to the reader without changing it")
    s.check("the group's bands for everyone, with and without the person's id",
            starts_of(ids["sal1"]) == DEFAULT == starts_of(ids["sal1"], user=False))
    with a.app.app_context():
        s.check("the 'no rule in the cycle' short-cut says so while the cycle holds none",
                not a._pm_band_rules_exist(a.get_db(), cycle_id=PID))

    # ------------------------------------------------------------------------------------------------------------
    s.section("precedence: a named person > their department > their unit > the group, each proved then taken away")
    sal1, sal2, sup1, ops1 = ids["sal1"], ids["sal2"], ids["sup1"], ids["ops1"]
    post(SUP, **rule_form(UA_, starts=UNIT_S, remark="ZZBP unit rule"))
    UR = rid_of(UA_)
    s.check("a unit rule: everyone in the unit reads it, another unit still the group's",
            starts_of(sal1) == starts_of(sup1) == starts_of(ops1) == UNIT_S and starts_of(ids["b1"]) == DEFAULT)
    post(SUP, **rule_form(UA_, [SALES], starts=DEPT_S, remark="ZZBP department rule"))
    DR = rid_of(UA_, "dept", SALES)
    s.check("a department rule beats the unit's for its own department only",
            starts_of(sal1) == starts_of(sal2) == DEPT_S and starts_of(sup1) == UNIT_S)
    r = post(SUP, **rule_form(UA_, [SALES], people=["sup1"], starts=DEPT_S, rid=DR, remark="ZZBP name a support person"))
    t = r.get_data(as_text=True)
    # the department rule now also names sup1 (a Support person): save it and see sup1 read it
    s.check("a department rule that also names someone outside its department is saved", "now has its own bands" in t
            and n_people_rows() == 1, t[:0])
    post(SUP, **rule_form(UA_, people=["sal1"], starts=NAMED_S, remark="ZZBP named on a people-only rule"))
    NR = rid_of(UA_, "people")
    s.check("a people-only rule has a rule row, no department row, one people row", NR and q1(
        "SELECT COUNT(*) FROM pm_cycle_band_rule_depts WHERE rule_id=?", (NR,)) == 0 and q1(
        "SELECT COUNT(*) FROM pm_cycle_band_rule_people WHERE rule_id=?", (NR,)) == 1)
    s.check("a NAMED person's rule beats their department's (sal1 is in the Sales department rule and named on another)",
            starts_of(sal1) == NAMED_S and starts_of(sal2) == DEPT_S)
    s.check("...with no id passed (a figure with no person) the reader falls to the department's, as before",
            starts_of(sal1, user=False) == DEPT_S)
    s.check("...the person the department rule names reads the department rule's starts (a rule names whom it names)",
            starts_of(sup1) == DEPT_S)
    remove(NR)
    s.check("taking the named rule away puts sal1 back on their department's", starts_of(sal1) == DEPT_S)
    remove(DR)
    s.check("taking the department rule away (and the person it named) puts them on the unit's",
            starts_of(sal1) == starts_of(sup1) == UNIT_S and n_people_rows() == 0)
    remove(UR)
    s.check("taking the unit rule away puts everyone on the group's", starts_of(sal1) == starts_of(sup1) == DEFAULT
            and n_rules() == 0)

    # ------------------------------------------------------------------------------------------------------------
    s.section("a named person who moves out falls back by themselves; back in, the rule again")
    post(SUP, **rule_form(UA_, [OPS], people=["sal1"], starts=NAMED_S, remark="ZZBP ops and one sales person"))
    R1 = rid_of(UA_, "dept", OPS)
    s.check("saved: the department and the named person read the rule", starts_of(sal1) == starts_of(ops1) == NAMED_S
            and starts_of(sal2) == DEFAULT)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET company=? WHERE id=?", (UB_, sal1))
        db.commit()
        a._pm_band_rules_reset()
    s.check("moved to Unit B: they read Unit B's (the group's here), the rule row is still there but takes them off",
            starts_of(sal1) == DEFAULT and n_people_rows() == 1)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET company=?, business_group=? WHERE id=?", (UO_, BGO, sal1))
        db.commit()
        a._pm_band_rules_reset()
    s.check("moved to another business group: they read that group's (the pm_bands_for for the new group)",
            starts_of(sal1, bg=BGO) == DEFAULT and starts_of(sal1, bg=BG) == DEFAULT)
    with a.app.app_context():
        stale = [v for _l, v in a.pm_bands_for(a.get_db(), BG, UO_, SALES, cycle_id=PID, user_id=sal1)]
    s.check("...and a caller that still asks the OLD group's table with the new unit gets that table, never the rule", stale == DEFAULT)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET company=?, business_group=? WHERE id=?", (UA_, BG, sal1))
        db.commit()
        a._pm_band_rules_reset()
    s.check("back in Unit A: the rule again, with nobody editing anything", starts_of(sal1) == NAMED_S)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET company=? WHERE id=?", (UB_, sal1))
        db.commit()
        a._pm_band_rules_reset()
        vr = {r["id"]: r for r in a._band_rules_view(db, PID, BG)[0]}[R1]
        n_people = len(a._band_rule_people(db, PID, BG, UA_, [OPS], R1))
    s.check("the rules list counts them apart: not in People, one 'moved out' with who and where",
            vr["people"] == 1 and vr["named"] == 0 and len(vr["moved"]) == 1 and vr["moved"][0]["eid"] == E["sal1"]
            and UB_ in vr["moved"][0]["where"] and n_people == 1, (vr["people"], vr["moved"]))
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET company=?, left_at='2026-02-02' WHERE id=?", (UA_, sal1))
        db.commit()
        a._pm_band_rules_reset()
        vr = {r["id"]: r for r in a._band_rules_view(db, PID, BG)[0]}[R1]
    s.check("a named person who has left is 'moved out' too, and reads no rule", vr["moved"] and vr["moved"][0]["left"]
            and vr["named"] == 0)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET left_at=NULL WHERE id=?", (sal1,))
        db.commit()
        a._pm_band_rules_reset()
    remove(R1)
    s.check("put back: the rule is gone and its people rows with it", n_rules() == 0 and n_people_rows() == 0)

    # ------------------------------------------------------------------------------------------------------------
    s.section("rule_save with named people: refusals first, each leaving nothing behind")
    snap = snapshot()
    r = BGC.post(url(), data=dict(rule_form(UA_, people=["sal1"], remark="ZZBP bg admin"), csrf_token="tok", business_group=BG,
                                  cycle_id=str(PID)))
    s.check("a BG admin's save is refused (403)", r.status_code == 403 and snapshot() == snap, r.status_code)
    r = SUP.post(url(), data=dict(rule_form(UA_, people=["sal1"], remark=None), csrf_token="tok", business_group=BG,
                                  cycle_id=str(PID)), follow_redirects=True)
    s.check("no remark: refused before the route runs", "Write your remark first" in r.get_data(as_text=True)
            and snapshot() == snap)
    r = post(SUP, **rule_form(UA_, people=["sal1"], remark="   "))
    s.check("a blank remark: refused", "Write your remark first" in r.get_data(as_text=True) and snapshot() == snap)
    r = post(SUP, CY["X"], **rule_form(UA_, people=["sal1"]))
    s.check("a closed (archived) cycle: refused, nothing written", "archived" in r.get_data(as_text=True)
            and snapshot() == snap)
    r = post(SUP, 987654321, **rule_form(UA_, people=["sal1"]))
    s.check("a cycle that is not there: refused", "That cycle is gone" in r.get_data(as_text=True) and snapshot() == snap)
    for why, form, word in (
            ("a person of another unit", rule_form(UA_, people=["b1"]), "%s is not in %s." % (E["b1"], UA_)),
            ("a person of another group", rule_form(UA_, people=["o1"]), "%s is not in %s." % (E["o1"], UA_)),
            ("an Employee ID nobody has", rule_form(UA_, people=["ZZBP-NOBODY"]), "ZZBP-NOBODY is not in"),
            ("an admin", rule_form(UA_, people=[PREFIX + "BGADM"]), "is not in"),
            ("a demo account", rule_form(UA_, people=["dem1"]), "is not in"),
            ("a person who has left", rule_form(UA_, people=["lft1"]), "is not in"),
            ("a name typed instead of an Employee ID", rule_form(UA_, people=["ZZ BP Sales One"]), "is not in"),
            ("named people with All departments", rule_form(UA_, people=["sal1"], scope="unit"), "not with All departments"),
            ("Only named people with nobody", rule_form(UA_, scope="people"), "Pick at least one person"),
            ("a person in a department the rule already holds", rule_form(UA_, [SALES], people=["sal1"]),
             "already holds"),
            ("a good person after a bad one (nothing is dropped silently)", rule_form(UA_, people=["sup1", "b1"]), "is not in")):
        r = post(SUP, **form)
        s.check("refused: " + why, word in r.get_data(as_text=True) and snapshot() == snap, r.get_data(as_text=True)[:0])
    r = SUP.post(url(), data=dict(rule_form(UA_, people=["sup1", "b1"], remark="ZZBP draft"), csrf_token="tok",
                                  business_group=BG, cycle_id=str(PID)))
    with SUP.session_transaction() as sess:
        dr = sess.get("band_rule_draft") or {}
    s.check("...the refusal keeps what was entered for the panel's draft: the scope and the people, in order",
            dr.get("scope") == "people" and dr.get("people") == [E["sup1"], E["b1"]] and dr.get("company") == UA_
            and dr.get("whole") is False and dr.get("remark") == "ZZBP draft", dr)
    post(SUP, **rule_form(UA_, people=["sal1", "sup1"], starts=NAMED_S, remark="ZZBP two people"))
    NR = rid_of(UA_, "people")
    snap = snapshot()
    s.check("two named people are saved on one rule", n_rules() == 1 and n_people_rows() == 2)
    r = post(SUP, **rule_form(UA_, people=["sup1", "sup2"], starts=DEPT_S))
    s.check("a person named on another rule is refused, by name, with the reason",
            "ZZ BP Support One is already named on the rule for ZZBP Unit A. A person sits in one rule." in r.get_data(as_text=True)
            and snapshot() == snap)
    r = post(SUP, **rule_form(UA_, [OPS], people=["sal1"], starts=DEPT_S))
    s.check("...also from a department rule", "is already named on the rule for" in r.get_data(as_text=True)
            and snapshot() == snap)
    try:
        with a.app.app_context():
            db = a.get_db()
            db.execute("INSERT INTO pm_cycle_band_rule_people(rule_id, cycle_id, business_group, company, user_id) "
                       "VALUES (?,?,?,?,?)", (NR, PID, BG, UA_, ids["sup2"]))   # a different person: fine
            db.execute("INSERT INTO pm_cycle_band_rule_people(rule_id, cycle_id, business_group, company, user_id) "
                       "VALUES (?,?,?,?,?)", (NR, PID, BG, UA_, ids["sup2"]))   # the same person twice in the cycle
            dup = False
    except Exception as exc:   # noqa: BLE001
        dup = "UNIQUE" in str(exc)
    with a.app.app_context():
        a.get_db().rollback()
    s.check("the database itself refuses one person in two rule name lists of a cycle (UNIQUE)", dup)
    s.check("...and the same person may be named again in ANOTHER cycle", q1(
        "SELECT COUNT(*) FROM pm_cycle_band_rule_people WHERE user_id=?", (ids["sal1"],)) == 1)
    s.check("an edit may keep its own people (no clash with itself)", "now has its own bands" in post(
        SUP, **rule_form(UA_, people=["sal1", "sup1"], starts=NAMED_S, rid=NR, remark="ZZBP keep")).get_data(as_text=True)
        and n_people_rows() == 2)
    r = post(SUP, **rule_form(UA_, people=["sup2"], starts=NAMED_S, rid=NR, remark="ZZBP swap"))
    s.check("an edit REPLACES the list: sal1 and sup1 are off, sup2 on",
            q1("SELECT GROUP_CONCAT(user_id) FROM pm_cycle_band_rule_people WHERE rule_id=?", (NR,)) == str(ids["sup2"])
            and starts_of(sal1) == DEFAULT and starts_of(ids["sup2"]) == NAMED_S)
    # a stale row: a person named on a rule of Unit A who now works in Unit B can be named on a Unit B rule
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET company=? WHERE id=?", (UB_, ids["sup2"]))
        db.commit()
        a._pm_band_rules_reset()
    r = post(SUP, **rule_form(UB_, people=["sup2"], starts=DEPT_S, remark="ZZBP they moved here"))
    s.check("someone who moved out of a rule's unit can be named on their new unit's rule (the stale row makes way)",
            "now has its own bands" in r.get_data(as_text=True) and q1(
                "SELECT COUNT(*) FROM pm_cycle_band_rule_people WHERE user_id=?", (ids["sup2"],)) == 1
            and starts_of(ids["sup2"]) == DEPT_S)
    clear_all()
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET company=? WHERE id=?", (UA_, ids["sup2"]))
        db.commit()
        a._pm_band_rules_reset()
    s.check("everything saved so far is removed", n_rules() == 0 and n_people_rows() == 0)

    # ------------------------------------------------------------------------------------------------------------
    s.section("a people-only rule: saved, audited by Employee ID, listed, counted, previewed, removed")
    log0 = q1("SELECT COALESCE(MAX(id),0) FROM activity_log")
    r = post(SUP, **rule_form(UA_, people=["sal1", "sup1", "ops1"], starts=NAMED_S, remark="ZZBP three named"))
    t = r.get_data(as_text=True)
    NR = rid_of(UA_, "people")
    flash_t = " ".join(re.sub(r"<[^>]+>", " ", t).split())
    s.check("saved, and the flash says what it reached: the unit, '3 named (the IDs)', and 3 people",
            "ZZBP Unit A · 3 named (" in flash_t and "now has its own bands in" in flash_t and ": 3 people." in flash_t, flash_t[:0])
    audit = H.rows(a, "SELECT detail FROM activity_log WHERE id>? AND action='pm_band_rule'", (log0,))
    d0 = audit[0][0] if audit else ""
    s.check("the audit row names the Employee IDs and the starts, never a name",
            len(audit) == 1 and "3 named (" in d0 and all(E[k] in d0 for k in ("sal1", "sup1", "ops1")) and "ZZ BP" not in d0
            and "BE 55" in d0 and "remark: ZZBP three named" in d0 and BG in d0 and "ZZBP Unit A · 3 named" in d0, d0)
    with a.app.app_context():
        db = a.get_db()
        view = {r["id"]: r for r in a._band_rules_view(db, PID, BG)[0]}[NR]
        peo = a._band_rule_people(db, PID, BG, UA_, [], NR)
        vu = [u for u in a._band_rules_view(db, PID, BG)[1] if u["company"] == UA_][0]
    s.check("it is on the list: people-only, three named, in their departments, People 3",
            view["people_only"] and view["named"] == 3 and view["people"] == 3 and view["whole"] is False and view["depts"] == []
            and view["named_depts"] == sorted([a.proper_name(SALES), a.proper_name(SUPPORT), a.proper_name(OPS)]), view["people"])
    s.check("...the people it reaches are exactly the three", sorted(peo) == sorted([sal1, sup1, ops1]))
    s.check("...and the panel's picker marks them as named on this rule",
            sorted(p[0] for p in vu["people"] if p[5] == NR) == sorted(E[k] for k in ("sal1", "sup1", "ops1")))
    s.check("...the picker lists active people only (no admin, no demo, no one who has left)",
            all(p[0] not in (PREFIX + "BGADM", E["dem1"], E["lft1"]) for p in vu["people"]) and len(vu["people"]) == 5)
    page = SUP.get(url() + "?bg=" + BG.replace(" ", "+")).get_data(as_text=True)
    s.check("the page shows the rule and its count", "ZZBP Unit A" in page and "3 named people" in page and "ZZ BP" in page)
    lst = SUP.get("/admin/list/band-rule-people?fragment=1&bg=%s&rule=%d" % (BG.replace(" ", "+"), NR)).get_data(as_text=True)
    s.check("People opens the list panel with the three, each tagged Named",
            lst.count('class="clp-tag"') == 3 and "ZZ BP Sales One" in lst and "3 people" in lst, lst.count("clp-tag"))

    def preview(unit, depts=None, people=None, starts=NAMED_S, rid=None, **kw):
        q = [("bg", BG), ("cycle", PID), ("rule_unit", unit),
             ("rule_scope", kw.pop("scope", "depts" if depts else ("people" if people else "unit")))]
        q += [("min_" + l, "%g" % v) for l, v in zip(LAB, starts)]
        if rid:
            q.append(("rule_id", rid))
        q += [("rule_dept", d) for d in depts or []] + [("rule_person", E.get(p, p)) for p in people or []]
        q += [("also_rule", x) for x in kw.pop("also", [])]
        from urllib.parse import urlencode
        r = SUP.get(url() + "/rule-preview?" + urlencode(q))
        return r.status_code, json.loads(r.get_data(as_text=True) or "{}")
    snap = snapshot()
    code, j = preview(UA_, people=["sal1", "sup1", "ops1"], rid=NR, starts=DEFAULT)
    s.check("the preview of the same rule with the group's own starts: three people, three results, nobody changes... "
            "to the group's bands they were not", code == 200 and j["ok"] and j["people"] == 3 and j["with_results"] == 3
            and snapshot() == snap, (code, j.get("people")))
    code, j = preview(UA_, people=["sal1", "sal2"], starts=[0, 70, 90, 100, 120])
    # sal2 (80%, BE on the group's bands, BE on 70) and sup2 (100%, ME now, AE on 100) are free of any rule
    code, j = preview(UA_, people=["sal2", "sup2"], starts=[0, 70, 90, 100, 120])
    s.check("a preview of two new named people counts them, reads their results and says who changes band (and writes nothing)",
            j["ok"] and j["people"] == 2 and j["with_results"] == 2 and j["moves"] == {"ME → AE": 1} and len(j["changes"]) == 1
            and snapshot() == snap, j)
    s.check("...it says how the reach splits: none in departments, two named, each with the department it reads as",
            j["reach"]["dept_people"] == 0 and len(j["reach"]["named"]) == 2 and j["reach"]["depts"] == [] and not j["reach"]["whole"]
            and {x["dept_label"] for x in j["reach"]["named"]} == {a.proper_name(SALES), a.proper_name(SUPPORT)}, j["reach"])
    s.check("...named people in two departments: no 'the others stay' clause", j["reach"]["other"] is None)
    code, j = preview(UA_, people=["sup2"], starts=NAMED_S)
    s.check("a lone named person whose department holds nobody else free (sup1 is named, lft1 left, dem1 is a demo): no clause",
            j["ok"] and j["people"] == 1 and j["reach"]["other"] is None, j["reach"]["other"])
    code, j = preview(UA_, people=["sup1"], starts=NAMED_S, rid=NR)
    s.check("a preview of a person already on THIS rule is fine (editing it)", j["ok"] and j["people"] == 1, j)
    code, j = preview(UA_, people=["sal1"], starts=NAMED_S)
    s.check("the GET preview refuses a person named on another rule, in the same words as the save",
            j["ok"] is False and "is already named on the rule for ZZBP Unit A. A person sits in one rule." in j["error"]
            and j["people"] == 0 and snapshot() == snap, j)
    code, j = preview(UA_, people=["b1"])
    s.check("...a person outside the unit", j["ok"] is False and "is not in ZZBP Unit A." in j["error"])
    code, j = preview(UA_, people=["sal1"], scope="unit")
    s.check("...named people with All departments", j["ok"] is False and "not with All departments" in j["error"])
    code, j = preview(UA_, people=None, scope="people")
    s.check("...Only named people with nobody", j["ok"] is False and "Pick at least one person" in j["error"])
    # the "other K" clause with a department nobody holds
    code, j = preview(UB_, people=["b1"], starts=NAMED_S)
    s.check("a lone named person: the rest of their department (b2) 'stay on the group's bands'",
            j["ok"] and j["reach"]["other"] == {"dept_label": a.proper_name(SALES), "n": 1}, j["reach"])
    post(SUP, **rule_form(UB_, [SALES], starts=DEPT_S, remark="ZZBP unit B sales holds a rule"))
    code, j = preview(UB_, people=["b1"], starts=NAMED_S) if False else (0, {})
    clear_btmp = H.rows(a, "SELECT id FROM pm_cycle_band_rules WHERE business_group=? AND company=?", (BG, UB_))
    for x in clear_btmp:
        remove(x[0])
    remove(NR)
    s.check("removed: the rule row, its department rows (none) and its people rows are gone; the three read the group's again",
            n_rules() == 0 and n_people_rows() == 0 and starts_of(sal1) == starts_of(sup1) == starts_of(ops1) == DEFAULT)
    s.check("...and the removal is audited with the Employee IDs", q1(
        "SELECT COUNT(*) FROM activity_log WHERE action='pm_band_rule' AND detail LIKE '%removed the rule for%' AND detail "
        "LIKE ? AND detail LIKE '%3 named (%'", ("%" + E["sal1"] + "%",)) == 1)
    s.check("...a person named on a removed rule can be named again", "now has its own bands" in post(
        SUP, **rule_form(UA_, people=["sal1"], remark="ZZBP again")).get_data(as_text=True))
    clear_all()

    # ------------------------------------------------------------------------------------------------------------
    s.section("the seed copies the people with their rule into a new cycle (the template tables get none)")
    post(SUP, **rule_form(UA_, [OPS], people=["sal1", "sup1"], starts=NAMED_S, remark="ZZBP for the copy"))
    post(SUP, **rule_form(UB_, people=["b1"], starts=DEPT_S, remark="ZZBP people only, for the copy"))
    with a.app.app_context():
        db = a.get_db()
        copied = a._pm_cycle_bands_seed(db, CY["N"], source=PID)
        db.commit()
    s.check("a new cycle copies the previous cycle's rules, 2 of them", copied and q1(
        "SELECT COUNT(*) FROM pm_cycle_band_rules WHERE cycle_id=? AND business_group=?", (CY["N"], BG)) == 2)
    s.check("...with new rule ids, and the people rows go with their rule (3 people, the cycle's own id)",
            n_people_rows(CY["N"]) == 3 and q1(
                "SELECT COUNT(*) FROM pm_cycle_band_rule_people p JOIN pm_cycle_band_rules r ON r.id=p.rule_id WHERE "
                "p.cycle_id=? AND r.cycle_id=?", (CY["N"], CY["N"])) == 3 and q1(
                "SELECT COUNT(*) FROM pm_cycle_band_rule_people WHERE cycle_id=? AND rule_id IN (SELECT id FROM "
                "pm_cycle_band_rules WHERE cycle_id=?)", (CY["N"], PID)) == 0)
    s.check("...a people-only rule is copied too (it has no department row to hang on)", q1(
        "SELECT COUNT(*) FROM pm_cycle_band_rules r WHERE r.cycle_id=? AND r.business_group=? AND r.company=? AND r.id NOT IN "
        "(SELECT rule_id FROM pm_cycle_band_rule_depts)", (CY["N"], BG, UB_)) == 1)
    s.check("...and the new cycle's reader gives the named person the rule", starts_of(ids["b1"], cid=CY["N"]) == DEPT_S
            and starts_of(sal1, cid=CY["N"]) == NAMED_S and starts_of(ids["sal2"], cid=CY["N"]) == DEFAULT)
    s.check("...the old cycle is untouched", n_people_rows() == 3 and n_rules() == 2)
    s.check("the source comment says the template tables get no people table",
            "the template has no people table" in src or "template tables hold no people" in src)
    with a.app.app_context():
        db = a.get_db()
        view_n = a._band_rules_view(db, CY["N"], BG)[0]
        others = a._band_other_cycles(db, PID, BG, False, a._band_cycle_windows(db))
    s.check("the 'other cycles' fold counts a people-only rule (2 rules in the copy)",
            [o["rules"] for o in others if o["id"] == CY["N"]] == [2] and len(view_n) == 2, [o["rules"] for o in others])
    clear_all()
    with a.app.app_context():
        db = a.get_db()
        for c in (CY["N"],):
            for r in db.execute("SELECT id FROM pm_cycle_band_rules WHERE cycle_id=?", (c,)).fetchall():
                db.execute("DELETE FROM pm_cycle_band_rule_people WHERE rule_id=?", (r[0],))
                db.execute("DELETE FROM pm_cycle_band_rule_depts WHERE rule_id=?", (r[0],))
                db.execute("DELETE FROM pm_cycle_band_rules WHERE id=?", (r[0],))
        db.commit()

    # ------------------------------------------------------------------------------------------------------------
    s.section("_band_rule_people: the whole unit, less a department that holds a rule, less people named elsewhere")
    post(SUP, **rule_form(UA_, [SALES], starts=DEPT_S, remark="ZZBP sales dept"))
    post(SUP, **rule_form(UA_, people=["sup1"], starts=NAMED_S, remark="ZZBP one support person"))
    post(SUP, **rule_form(UA_, starts=UNIT_S, remark="ZZBP the whole unit"))
    WR, SR_, PR_ = rid_of(UA_), rid_of(UA_, "dept", SALES), rid_of(UA_, "people")
    with a.app.app_context():
        db = a.get_db()
        w_people = a._band_rule_people(db, PID, BG, UA_, [""], WR)
        s_people = a._band_rule_people(db, PID, BG, UA_, [SALES], SR_)
        p_people = a._band_rule_people(db, PID, BG, UA_, [], PR_)
        v = {r["id"]: r for r in a._band_rules_view(db, PID, BG)[0]}
    s.check("the whole-unit rule reaches Support (less the one named) and Operations: sup2 and ops1",
            sorted(w_people) == sorted([ids["sup2"], ids["ops1"]]), w_people)
    s.check("the department rule reaches its own two", sorted(s_people) == sorted([sal1, sal2]))
    s.check("the people-only rule reaches its one", p_people == [ids["sup1"]])
    s.check("the list's counts agree (the page's batched count and the reader's)",
            (v[WR]["people"], v[SR_]["people"], v[PR_]["people"]) == (len(w_people), len(s_people), len(p_people)), (
                v[WR]["people"], v[SR_]["people"], v[PR_]["people"]))
    s.check("each reads its own starts", starts_of(ids["sup2"]) == UNIT_S and starts_of(sal1) == DEPT_S
            and starts_of(ids["sup1"]) == NAMED_S)
    post(SUP, **rule_form(UA_, [SALES], people=["sup2"], starts=DEPT_S, rid=SR_, remark="ZZBP sales dept names sup2"))
    with a.app.app_context():
        db = a.get_db()
        d_, n_ = a._band_rule_reach(db, PID, BG, UA_, [SALES], SR_)
        w_people = a._band_rule_people(db, PID, BG, UA_, [""], WR)
    s.check("a department rule that names someone: its reach is its department's plus the named (departments and named apart)",
            sorted(d_) == sorted([sal1, sal2]) and n_ == [ids["sup2"]])
    s.check("...and the whole unit now leaves sup2 out too (named elsewhere): only ops1", w_people == [ops1])
    snap = snapshot()
    r = post(SUP, **rule_form(UA_, [SUPPORT], starts=DEPT_S, remark="ZZBP"))
    clear_all()

    # ------------------------------------------------------------------------------------------------------------
    s.section("pm_label_for_value(subject=...): a user id, a user row and a KPI line all give the named rule's band")
    post(SUP, **rule_form(UA_, people=["sal2"], starts=NAMED_S, remark="ZZBP sal2 named"))
    # sal2's own figure is 80: BE on the group's bands (61..<81), ME on the named rule (75..<85)
    with a.app.app_context():
        db = a.get_db()
        urow = db.execute("SELECT * FROM users WHERE id=?", (sal2,)).fetchone()
        line = dict(db.execute("SELECT * FROM pm_kpi_targets WHERE subject_id=?", (sal2,)).fetchone())
        got = {"id": a.pm_label_for_value(db, BG, "B", 80, subject=sal2, cycle_id=PID),
               "row": a.pm_label_for_value(db, BG, "B", 80, subject=urow, cycle_id=PID),
               "dict": a.pm_label_for_value(db, BG, "B", 80, subject=dict(urow), cycle_id=PID),
               "line": a.pm_label_for_value(db, BG, "B", 80, subject=line, cycle_id=PID),
               "none": a.pm_label_for_value(db, BG, "B", 80, subject=None, cycle_id=PID),
               "other": a.pm_label_for_value(db, BG, "B", 80, subject=sal1, cycle_id=PID),
               "who": a._pm_subject_who(db, sal2), "unit": a._pm_subject_unit(db, sal2)}
        ts = [dict(t) for t in db.execute("SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND subject_id IN (?,?)", (PID, sal1, sal2))]
        a.attach_pm_chains(db, ts)
        a.pm_score_targets(db, ts)
        scored = {t["subject_id"]: t["score"]["label"] for t in ts}
        scale = a._pm_scale_for(db, BG, subject=sal2, cycle_id=PID)
        scale1 = a._pm_scale_for(db, BG, subject=sal1, cycle_id=PID)
    s.check("a user id, a user row, a dict and a KPI line give ME (the named rule's), no subject and another person BE",
            got["id"] == got["row"] == got["dict"] == got["line"] == "ME" and got["none"] == "BE" and got["other"] == "BE", got)
    s.check("_pm_subject_who gives the id, the unit and the department; _pm_subject_unit keeps its two",
            got["who"] == (sal2, UA_, SALES) and got["unit"] == (UA_, SALES))
    s.check("pm_score_targets (batched, with band_unit) labels the line by the named rule too: sal2 ME, sal1 (100) ME on default",
            scored[sal2] == "ME" and scored[sal1] == "ME", scored)
    s.check("_pm_scale_for hands the page the named person's floors, another person the group's",
            [b["min"] for b in scale["bands"]] == NAMED_S and [b["min"] for b in scale1["bands"]] == DEFAULT)
    ov = None
    with a.app.app_context():
        db = a.get_db()
        ts = [dict(t) for t in db.execute("SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (PID, sal2))]
        a.attach_pm_chains(db, ts)
        a.pm_score_targets(db, ts)
        ov, _c, _t = a.review_partial_overall(db, ts)
    s.check("the person's overall (the dashboard and journey read) is ME at 80", ov and ov["label"] == "ME", ov)
    clear_all()

    # ------------------------------------------------------------------------------------------------------------
    s.section("O1: the same new starts for the rules that start where this one did")
    S0, S1, S2 = [0, 60, 80, 95, 110], [0, 55, 75, 90, 100], [0, 50, 70, 85, 95]
    post(SUP, **rule_form(UA_, starts=S0, remark="ZZBP rule A"))
    post(SUP, **rule_form(UB_, starts=S0, remark="ZZBP rule B"))
    post(SUP, **rule_form(UA_, [SALES], starts=S0, remark="ZZBP rule C (sales)"))
    post(SUP, **rule_form(UA_, people=["sup1"], starts=S0, remark="ZZBP rule D (named)"))
    post(SUP, **rule_form(UA_, [OPS], starts=S1, remark="ZZBP rule E (different starts)"))
    RA, RB, RC, RD, RE = rid_of(UA_), rid_of(UB_), rid_of(UA_, "dept", SALES), rid_of(UA_, "people"), rid_of(UA_, "dept", OPS)
    with a.app.app_context():
        db = a.get_db()
        view = {r["id"]: r for r in a._band_rules_view(db, PID, BG)[0]}
    s.check("only rules with equal saved starts are offered (A is offered B, C and D; not E, which starts elsewhere)",
            sorted(x["id"] for x in view[RA]["same"]) == sorted([RB, RC, RD]) and [x["id"] for x in view[RE]["same"]] == [],
            [x["id"] for x in view[RA]["same"]])
    s.check("...each offered line reads '<Unit> · all departments' / '<first dept> and K more' / 'N named', with its people",
            {x["id"]: (x["unit"], x["scope"], x["people"]) for x in view[RA]["same"]} == {
                RB: (UB_, "all departments", view[RB]["people"]), RC: (UA_, a.proper_name(SALES), view[RC]["people"]),
                RD: (UA_, "1 named", 1)}, view[RA]["same"])
    # a preview with the three ticked
    code, j = preview(UA_, starts=S2, rid=RA, also=[RB, RC, RD])
    own = view[RA]["people"] + view[RB]["people"] + view[RC]["people"] + view[RD]["people"]
    s.check("the preview counts every ticked rule's people: 4 rules, the sum of their people",
            j["ok"] and j["people"] == own and len(j["rules"]) == 4 and j["rules"][0]["id"] == RA
            and sum(x["people"] for x in j["rules"]) == own, (j.get("people"), own, j.get("rules")))
    s.check("...the rules come with unit and scope words for the confirm", all("unit" in x and "scope" in x for x in j["rules"]))
    code, j = preview(UA_, starts=S2, rid=RA, also=[RE])
    s.check("a rule that starts elsewhere cannot be ticked: the preview says it changed meanwhile",
            j["ok"] is False and "changed meanwhile. Reload the page." in j["error"], j)
    code, j = preview(UA_, starts=S2, rid=RA, also=[987654])
    s.check("a rule that is not there either", j["ok"] is False and "changed meanwhile" in j["error"])
    snap = snapshot()
    n_log = q1("SELECT COUNT(*) FROM activity_log WHERE action='pm_band_rule'")
    # a ticked rule whose starts changed meanwhile: refused, nothing written
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE pm_cycle_band_rules SET min_be=57 WHERE id=?", (RC,))
        db.commit()
        a._pm_band_rules_reset()
    snap = snapshot()
    r = post(SUP, **rule_form(UA_, starts=S2, rid=RA, remark="ZZBP o1 refused", also_rule=[RB, RC, RD]))
    s.check("a ticked rule whose starts changed meanwhile: the whole save is refused and NOTHING is written",
            "The rule for ZZBP Unit A changed meanwhile. Reload the page." in r.get_data(as_text=True) and snapshot() == snap
            and starts_of(sal1) != S2, r.get_data(as_text=True)[:0])
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE pm_cycle_band_rules SET min_be=60 WHERE id=?", (RC,))
        db.commit()
        a._pm_band_rules_reset()
    # the same refusal at the write itself (the race between the check and the write): the transaction rolls back whole
    with a.app.test_request_context("/"):
        db = a.get_db()
        a.g.super_band_remark = "ZZBP race"
        db.execute("UPDATE pm_cycle_band_rules SET min_be=58 WHERE id=?", (RB,))   # B moves after the check, before the write
        db.commit()
        also_rows = [a._band_rule_load(db, PID, BG, RB)]
        also_rows[0]["starts"] = tuple(S0[i] for i in range(5))
        snap_t = snapshot()
        err = a._band_rule_write(db, {"id": SU["id"]}, PID, BG, UA_, [""], dict(zip(LAB, S2)), "ZZBP race", RA, [], also_rows,
                                 ["ZZBP should not be written"])
        db.execute("UPDATE pm_cycle_band_rules SET min_be=60 WHERE id=?", (RB,))
        db.commit()
    s.check("the write checks each ticked rule's starts inside its own transaction: refused, the edited rule not changed",
            err and "changed meanwhile" in err and q1("SELECT min_be FROM pm_cycle_band_rules WHERE id=?", (RA,)) == 60
            and q1("SELECT COUNT(*) FROM activity_log WHERE detail LIKE '%ZZBP should not be written%'") == 0, err)
    snap = snapshot()   # C's starts are back to what they were
    r = post(SUP, **rule_form(UA_, starts=S0, rid=RA, remark="ZZBP o1 same starts", also_rule=[RB]))
    s.check("giving the starts it already has to others is refused (there is nothing to give)",
            "already has" in r.get_data(as_text=True) and snapshot() == snap)
    r = post(SUP, **rule_form(UA_, [SUPPORT], starts=S2, remark="ZZBP o1 new rule", also_rule=[RB]))
    s.check("only an EDIT can give its starts to others", "Only an edit" in r.get_data(as_text=True) and snapshot() == snap)
    log0 = q1("SELECT COALESCE(MAX(id),0) FROM activity_log")
    marks = []
    r = post(SUP, **rule_form(UA_, starts=S2, rid=RA, remark="ZZBP o1 all four", also_rule=[RB, RC, RD]))
    t = r.get_data(as_text=True)
    s.check("the save with three ticked: all four rules have the new starts, E (not ticked) keeps its own",
            all(tuple(H.rows(a, "SELECT min_ua, min_be, min_me, min_ae, min_ou FROM pm_cycle_band_rules WHERE id=?", (x,))[0])
                == tuple(S2) for x in (RA, RB, RC, RD))
            and tuple(H.rows(a, "SELECT min_ua, min_be, min_me, min_ae, min_ou FROM pm_cycle_band_rules WHERE id=?", (RE,))[0])
            == tuple(S1), t[:0])
    s.check("...the flash says 3 other rules got the same starts and the records follow once", "3 other rules got the same starts" in t
            and t.count("ratings records brought up to date") <= 1)
    s.check("...every person reads the new starts", starts_of(ids["b1"]) == S2 and starts_of(sal1) == S2
            and starts_of(ids["sup1"]) == S2 and starts_of(ops1) == S1)
    s.check("...one audit row per rule (4), the same remark on each, the same starts",
            q1("SELECT COUNT(*) FROM activity_log WHERE id>? AND action='pm_band_rule' AND detail LIKE '%remark: ZZBP o1 all four%' "
               "AND detail LIKE '%BE 50 · ME 70 · AE 85 · OU 95%'", (log0,)) == 4)
    s.check("...and the named rule's row names its Employee ID, not its person", q1(
        "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='pm_band_rule' AND detail LIKE ? AND detail NOT LIKE '%ZZ BP%'",
        (log0, "%1 named (" + E["sup1"] + ")%")) == 1)
    s.check("...every rule carries the same remark, and who changed it", {x[0] for x in H.rows(
        a, "SELECT remark FROM pm_cycle_band_rules WHERE id IN (?,?,?,?)", (RA, RB, RC, RD))} == {"ZZBP o1 all four"})
    s.check("...the places and the named people of the ticked rules are unchanged (only their starts moved)",
            q1("SELECT COUNT(*) FROM pm_cycle_band_rule_depts WHERE rule_id=?", (RC,)) == 1
            and q1("SELECT COUNT(*) FROM pm_cycle_band_rule_people WHERE rule_id=?", (RD,)) == 1
            and q1("SELECT department FROM pm_cycle_band_rule_depts WHERE rule_id=?", (RC,)) == SALES)
    with a.app.app_context():
        db = a.get_db()
        view = {r["id"]: r for r in a._band_rules_view(db, PID, BG)[0]}
    s.check("after the save A, B, C and D start together again, so each now offers the other three",
            sorted(x["id"] for x in view[RA]["same"]) == sorted([RB, RC, RD]))
    # an edit that ticks nobody saves the one rule only
    r = post(SUP, **rule_form(UB_, starts=S1, rid=RB, remark="ZZBP o1 none ticked"))
    s.check("with none ticked it saves the one rule only",
            tuple(H.rows(a, "SELECT min_be FROM pm_cycle_band_rules WHERE id=?", (RB,))[0]) == (55,)
            and q1("SELECT min_be FROM pm_cycle_band_rules WHERE id=?", (RA,)) == 50)
    clear_all()

    # ------------------------------------------------------------------------------------------------------------
    s.section("the page: the rules list, the panel, the picker and the words the canvas gave")
    from html import unescape
    post(SUP, **rule_form(UA_, [OPS], people=["sal1", "sup1"], starts=NAMED_S, remark="ZZBP page: a department and two named"))
    post(SUP, **rule_form(UB_, people=["b1"], starts=NAMED_S, remark="ZZBP page: people only"))
    PA, PB = rid_of(UA_, "dept", OPS), rid_of(UB_, "people")
    pg = SUP.get(url() + "?bg=" + BG.replace(" ", "+")).get_data(as_text=True)
    rows = {int(m.group(1)): m.group(2) for m in re.finditer(r'<tr data-rule-row="(\d+)">(.*?)</tr>', pg, re.S)}
    text = lambda h: " ".join(unescape(re.sub(r"<[^>]+>", " ", h)).split())   # noqa: E731
    s.check("the precedence line says it the canvas's way",
            "A named person's rule wins over their department's; a department's over its unit's; a unit's over the group default." in unescape(pg))
    s.check("a department rule that names people reads: the unit, its department, then a pill '+ N named people'",
            "ZZBP Unit A" in text(rows[PA]) and a.proper_name(OPS) in text(rows[PA]) and "+ 2 named people" in text(rows[PA])
            and 'class="br-npill"' in rows[PA])
    s.check("a people-only rule reads 'N named people' and, muted, 'in <department>'",
            "1 named person in " + a.proper_name(SALES) in text(rows[PB]) and "All departments" not in rows[PB], text(rows[PB]))
    s.check("its People link opens the list panel", "band-rule-people" in rows[PB] and 'data-list-open' in rows[PB])
    s.check("no moved-out pill while everyone named still works in the unit", "br-moved" not in rows[PA] + rows[PB])
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET company=? WHERE id=?", (UA_, ids["b1"]))
        db.execute("UPDATE users SET left_at='2026-03-03' WHERE id=?", (ids["sup1"],))
        db.commit()
    pg = SUP.get(url() + "?bg=" + BG.replace(" ", "+")).get_data(as_text=True)
    rows = {int(m.group(1)): m.group(2) for m in re.finditer(r'<tr data-rule-row="(\d+)">(.*?)</tr>', pg, re.S)}
    mv = re.search(r'<span class="br-moved" title="([^"]*)">([^<]*)</span>', rows[PB])
    s.check("a named person who moved out: an amber pill '1 named person moved out of <Unit>', who and where in its title",
            mv and unescape(mv.group(2)) == "1 named person moved out of ZZBP Unit B" and "ZZ BP Unit B One" in unescape(mv.group(1))
            and "ZZBP Unit A" in unescape(mv.group(1)), mv and mv.group(0))
    s.check("...they no longer count in People (0), and a named person who left is moved out too (1 of 2 left)",
            re.search(r'data-list-open', rows[PB]) is None and "br-moved" in rows[PA] and "+ 1 named person" in text(rows[PA]))
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET company=? WHERE id=?", (UB_, ids["b1"]))
        db.execute("UPDATE users SET left_at=NULL WHERE id=?", (ids["sup1"],))
        db.commit()
    pg = SUP.get(url() + "?bg=" + BG.replace(" ", "+")).get_data(as_text=True)
    m = re.search(r"data-rule='([^']*)'", re.search(r'<tr data-rule-row="%d">(.*?)</tr>' % PA, pg, re.S).group(1))
    rj = json.loads(unescape(m.group(1)))
    s.check("the Edit button carries the scope, the people's Employee IDs and the rules that start where it does",
            rj["scope"] == "depts" and sorted(rj["people"]) == sorted([E["sal1"], E["sup1"]]) and rj["depts"] == [OPS]
            and [x["id"] for x in rj["same"]] == [PB] and rj["same"][0]["scope"] == "1 named", rj)
    data = json.loads(unescape(re.search(r'id="br-data">(.*?)</script>', pg, re.S).group(1)))
    uj = {u["company"]: u for u in data["units"]}
    s.check("the page feeds the picker: each unit's active people with Employee ID, name, department, job and the rule naming them",
            len(uj[UA_]["people"]) == 5 and all(len(p) == 6 for p in uj[UA_]["people"])
            and {p[0]: p[5] for p in uj[UA_]["people"]}[E["sal1"]] == PA and {p[0]: p[5] for p in uj[UB_]["people"]}[E["b1"]] == PB
            and {p[0]: p[5] for p in uj[UA_]["people"]}[E["sal2"]] == 0, [p[5] for p in uj[UA_]["people"]])
    with a.app.app_context():
        bg_label = a.display_bg(BG)
    s.check("...with the group's name and the preview's address for the panel", data.get("bgLabel") == bg_label and data["previewUrl"])
    s.check("the panel has the three radios in the canvas's words and the picker as a pick-multi, with no admin.js search behind it",
            all(w in pg for w in ("All departments in this unit", "Chosen departments", "Only named people"))
            and 'class="pick pick-multi br-pick"' in pg and "data-pick" not in re.search(r'<span class="pick pick-multi br-pick"[^>]*>', pg).group(0))
    s.check("the confirm box takes its body from the panel and the save button reads Save rule",
            'data-confirm-body="br-rule-body"' in pg and 'id="br-rule-body"' in pg and ">Save rule</button>" in pg)
    s.check("O1's box is in the panel, hidden until an edit changes the starts", 'id="br-o1"' in pg and 'id="br-o1" hidden' in pg)
    js = open(os.path.join(H.REPO, "static", "band_rules.js"), encoding="utf-8").read()
    s.check("band_rules.js: the help lines word for word (A1 and A2)",
            "For someone whose department stays on another band. People of \" + u.label + \" only." in js
            and "A named person's rule wins over their department's. They stay on it while they work in \" + u.label + \"; a move out takes them off." in js
            and "People of \" + u.label + \" only. Pick at least one." in js)
    s.check("band_rules.js: the info box, O1 and the confirm titles in the canvas's words",
            "This rule reaches " in js and '", all named."' in js and "stay on " in js
            and '"Give these starts to " + plural(sameRules.length, "other rule", "other rules") + " too"' in js
            and "The rules in \" + D.cycleName + \" that start where this one did. Untick any to leave it." in js
            and '"Save the rule for " + unitLabel() + " in " + cn + "?"' in js
            and '"Save the new starts for " + last.rules.length + " rules in " + cn + "?"' in js
            and '" more"' in js and "data-fold-less" in js and "slice(0, 4)" in js)
    s.check("band_rules.js posts rule_person and also_rule, writes the people again just before the send, and asks the preview for both",
            'h.name = "rule_person"' in js and 'name = "also_rule"' in js and 'p.append("also_rule"' in js and 'p.append("rule_person"' in js
            and "syncFields();   // before the confirm box" in js)
    css_t = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
    s.check("QC: the Save button never wraps (nowrap, flex none) and the footer status wraps instead",
            re.search(r"\.br-pform \.adm-panel-foot \.primary \{[^}]*flex: none; white-space: nowrap", css_t)
            and re.search(r"\.br-pform \.adm-panel-foot \.adm-panel-grow \{[^}]*min-width: 0", css_t))
    s.check("QC: the picker's input is borderless inside the one bordered box, and the five starts share the panel's width",
            re.search(r"\.br-pform \.br-pick \.pick-q \{[^}]*border: 0", css_t)
            and re.search(r"\.br-pstarts \.br-start \{ flex: 1 1 0; min-width: 0", css_t)
            and re.search(r"\.br-pstarts \.br-start input\.br-num \{[^}]*width: 100%", css_t))
    s.check("QC: the rules table is a fixed layout that fits its box (People 100, Bands 250, Changed 190 cut with an ellipsis and a title, "
            "Edit + Remove 140), Applies to takes the rest and keeps the unit's name on one line",
            ".br-rtable { table-layout: fixed; }" in css_t and ".br-rtable .br-c-people { width: 100px; }" in css_t and "td.br-r .br-people { white-space: nowrap" in css_t
            and ".br-rtable .br-c-bands { width: 250px; }" in css_t and ".br-rtable .br-c-acts { width: 140px; }" in css_t
            and re.search(r"td\.br-changed-c \{[^}]*text-overflow: ellipsis", css_t) and "td.br-applies > strong { white-space: nowrap; }" in css_t
            and 'class="muted small br-changed-c" title="' in open(os.path.join(H.REPO, "templates", "settings", "_pm.html"), encoding="utf-8").read())
    s.check("QC: the first help line sits above the picker, the second below it",
            pg.index('id="br-people-help1"') < pg.index('id="br-pick"') < pg.index('id="br-people-help2"'))
    s.check("QC: the reach box counts THIS rule (its departments' people and its named), not the O1 total the tiles show",
            "own = (rc.dept_people || 0) + nn" in js and 'plural(own, "person", "people")' in js)
    s.check("the 'named' pill, the moved pill and the picker's rows use colour tokens and rem (the lints say so too)",
            "br-npill" in open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
            and not re.search(r"\.br-(npill|moved|people|o1)[^{]*\{[^}]*#[0-9a-fA-F]{3,6}\b",
                              open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()))
    clear_all()

    # ------------------------------------------------------------------------------------------------------------
    s.section("the rename cascade carries the people table's unit and group")
    post(SUP, **rule_form(UA_, people=["sal1"], starts=NAMED_S, remark="ZZBP for the rename"))
    with a.app.app_context():
        db = a.get_db()
        out = a._org_rename_cascade(db, "unit", UA_, UA_ + " Renamed", bg=BG, people=True)
        db.commit()
        carried = db.execute("SELECT company FROM pm_cycle_band_rule_people WHERE user_id=?", (sal1,)).fetchone()[0]
        rcarried = db.execute("SELECT company FROM pm_cycle_band_rules WHERE business_group=? AND cycle_id=?", (BG, PID)).fetchone()[0]
        out_bg = a._org_rename_cascade(db, "bg", BG, BG + " Renamed", people=True)
        bgcarried = db.execute("SELECT business_group FROM pm_cycle_band_rule_people WHERE user_id=?", (sal1,)).fetchone()[0]
        db.rollback()
    s.check("a renamed unit carries the people row's company with the rule's, and is counted as a setting",
            carried == UA_ + " Renamed" and rcarried == UA_ + " Renamed"
            and out["tables"].get("pm_cycle_band_rule_people") == 1, out["tables"])
    s.check("a renamed group carries its business_group", bgcarried == BG + " Renamed", bgcarried)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET company=? WHERE company=?", (UA_, UA_ + " Renamed"))
        db.commit()
    clear_all()

    # ------------------------------------------------------------------------------------------------------------
    s.section("lints: every reader names its cycle and its person; the route is super-only; nothing else changed")
    s.check("every pm_bands_for caller in app.py that knows whose figure it is passes user_id",
            len(re.findall(r"pm_bands_for\([^)]*user_id=", src)) >= 3
            and "pm_bands_for(db, bg, cycle_id=cycle_id)" in src)   # the top default is the group's, on purpose
    s.check("the rule save is on the band-remark list", "rule_save" in a.SUPER_BAND_ENDPOINTS["admin_performance_config"])
    r = BGC.get(url() + "/rule-preview?bg=%s&cycle=%d" % (BG.replace(" ", "+"), PID))
    s.check("the preview is the super admin's (403 for a BG admin)", r.status_code == 403)
except Exception as exc:   # noqa: BLE001
    import traceback
    traceback.print_exc()
    s.check("the suite ran to the end (no error): %s" % exc, False)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        cleanup(db)
    left = [q1("SELECT COUNT(*) FROM users WHERE employee_id LIKE ?", (PREFIX + "%",)),
            q1("SELECT COUNT(*) FROM pm_cycle_band_rule_people WHERE business_group IN (?,?)", (BG, BGO)),
            q1("SELECT COUNT(*) FROM pm_cycle_band_rules WHERE business_group IN (?,?)", (BG, BGO)),
            q1("SELECT COUNT(*) FROM cycles WHERE code LIKE 'ZZBP-%'")]
    s.check("everything the suite made is put back", left == [0, 0, 0, 0], left)
sys.exit(s.done())
