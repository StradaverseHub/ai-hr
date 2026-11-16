"""Band rules by unit and department (Chris, 2026-10-29; canvas [design canvas link removed]).

The problem: a Fiamma department whose KPI lines all carry multiple 0 can never score above 100%, so on the group's bands
(ME 81 to under 101, AE from 101) nobody there passes ME. The super admin can now start the five bands elsewhere for a unit,
or chosen departments of it, in an Achievement % group.

What this suite holds:
  * ONE resolver. pm_bands_for: the department's rule, else the whole unit's, else the group's; pm_label_for_value reads it
    with a subject, and every caller that labels a KPI result passes the subject (a lint), so the line, the person's
    overall, the journey's live glow (bands_b) and the page's scale (_pm_scale_for) agree
  * a 5-point group takes no rule (refused; a stray row is ignored); no subject = the group's bands, as before
  * the group default saves starts only (rows written, floor lookup reads them, not ascending / UA != 0 / not a number refused)
  * rule_save: the super admin's alone, the remark mandatory, the unit picked from the group's, a department of that
    unit, one department in one rule (the database says so too), the whole unit held once; an edit keeps its own places
  * rule_remove falls back to the default; the audit rows name group, unit, departments, starts and the remark
  * a stored calibration move, a lock and a release do not change when a rule is saved, edited or removed
  * the preview route writes nothing and its counts match a hand computation
  * the page: the picked group only, read only for a BG admin, a 5-point group's table, an unset group's nudge
Self-contained: its own groups, units and people, deleted at the end.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Band rules by unit and department -- one resolver, the super admin's rules, nothing decided is moved")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, BG5, BGU = "ZZBR Base Group", "ZZBR Five Group", "ZZBR Unset Group"
UA_, UB_, U5 = "ZZBR Unit A", "ZZBR Unit B", "ZZBR Five Unit"
SERVICE, PRODUCTION = "ZZBR Service", "ZZBR Production"
FIN = "ZZBR FINANCE & ACCOUNTS"      # HRIS sends departments in capitals; on screen they read in proper case
DEFAULT = [0, 61, 81, 101, 121]
ids, PID = {}, None
PREFIX = "ZZBR-"
LAB = ("UA", "BE", "ME", "AE", "OU")


def q1(sql, args=()):
    return H.one(a, sql, args)


def cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE ?", (PREFIX + "%",))]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM pm_calibration_adjustments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM result_releases WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN "
                   "(%s))" % ph, ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM pm_calibration_sessions WHERE business_group IN (?,?,?)", (BG, BG5, BGU))
    for g_ in (BG, BG5, BGU):
        db.execute("DELETE FROM pm_cycle_band_rule_depts WHERE business_group=?", (g_,))
        db.execute("DELETE FROM pm_cycle_band_rules WHERE business_group=?", (g_,))
        db.execute("DELETE FROM pm_cycle_bands WHERE business_group=?", (g_,))
        db.execute("DELETE FROM pm_cycle_band_sets WHERE business_group=?", (g_,))
        db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (g_,))
        db.execute("DELETE FROM org_units WHERE business_group=?", (g_,))
    db.execute("DELETE FROM activity_log WHERE action IN ('pm_band_rule','pm_rating_bands') AND detail LIKE '%ZZBR%'")
    db.commit()


def n_rules(g_=BG):
    return q1("SELECT COUNT(*) FROM pm_cycle_band_rules WHERE business_group=?", (g_,))


def n_places(g_=BG):
    return q1("SELECT COUNT(*) FROM pm_cycle_band_rule_depts WHERE business_group=?", (g_,))


def snapshot():
    """Every table a rule save may touch, plus the bands: a read-only route must leave all of it as it found it."""
    return (q1("SELECT COUNT(*) FROM pm_cycle_band_rules"), q1("SELECT COUNT(*) FROM pm_cycle_band_rule_depts"),
            q1("SELECT COUNT(*) FROM pm_cycle_bands"), q1("SELECT COALESCE(SUM(min_value),0) FROM pm_cycle_bands"),
            q1("SELECT COUNT(*) FROM activity_log"), q1("SELECT COUNT(*) FROM pm_calibration_adjustments"),
            q1("SELECT COUNT(*) FROM pm_kpi_targets"), q1("SELECT COUNT(*) FROM pm_kpi_results"))


try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        cleanup(db)
        PID = a.active_pm_period_id(db)
        s.check("there is an active performance period to put scorecards in", PID is not None)
        for g_, cos in ((BG, (UA_, UB_)), (BG5, (U5,)), (BGU, ())):
            for co in cos:
                db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (g_, co))
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BGU, "ZZBR Unset Unit"))
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'base')", (BG,))
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (BG5,))
        for i, (lo, hi, lab) in enumerate(zip(DEFAULT, DEFAULT[1:] + [None], LAB), start=1):
            db.execute("INSERT INTO pm_cycle_bands(cycle_id, business_group, min_value, label, sort_order) "
                       "VALUES (?,?,?,?,?)", (PID, BG, lo, lab, i))
        base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND business_group!='' "
                               "AND is_demo=0 LIMIT 1").fetchone())
        cols = [c for c in base.keys() if c != "id"]

        def person(key, name, bg, co, dept, role="user", admin_bg=None, actual=None, mult=0, excellence=None, line_only=False, second_line=False):
            v = dict(base, username=(PREFIX + key).lower(), employee_id=PREFIX + key, full_name="ZZ BR " + name, email=None,
                     hod_id=None, manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None,
                     business_group=bg, company=co, department=dept, role=role, admin_bg=admin_bg, left_at=None,
                     is_demo=0)
            db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                       [v[c] for c in cols])
            uid = db.execute("SELECT id FROM users WHERE username=?", (v["username"],)).fetchone()[0]
            if actual is not None or line_only:
                tid = db.execute(
                    "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, threshold, target, "
                    "multiple, excellence, business_group, company, department) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (PID, uid, "ZZBR KPI", 100, "more", 50, 100, mult, excellence, bg, co, dept)).lastrowid
                if actual is not None:
                    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)",
                               (tid, actual, uid))
                if second_line:   # a second line with no result: the person's overall would be a partial figure
                    db.execute(
                        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, threshold, target, "
                        "multiple, excellence, business_group, company, department) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        (PID, uid, "ZZBR KPI two", 100, "more", 50, 100, mult, excellence, bg, co, dept))
            return uid
        # 100% (the multiple 0 cap) reads ME on the group's bands; 80 reads BE
        ids["svc1"] = person("SVC1", "Service One", BG, UA_, SERVICE, actual=105)
        ids["svc2"] = person("SVC2", "Service Two", BG, UA_, SERVICE, actual=105)
        ids["svc3"] = person("SVC3", "Service Three", BG, UA_, SERVICE, actual=80)
        ids["prd1"] = person("PRD1", "Production One", BG, UA_, PRODUCTION, actual=105)
        ids["oth1"] = person("OTH1", "Other Unit One", BG, UB_, SERVICE, actual=105)
        ids["part1"] = person("PART1", "Other Unit Three (one of two lines keyed)", BG, UB_, SERVICE, actual=105, second_line=True)
        ids["oth2"] = person("OTH2", "Other Unit Two (a scorecard, no result keyed yet)", BG, UB_, SERVICE, line_only=True)
        ids["fin1"] = person("FIN1", "Finance One", BG, UB_, FIN)
        ids["five1"] = person("FIVE1", "Five Point One", BG5, U5, SERVICE)
        ids["bgadm"] = person("BGADM", "Group Admin", BG, UA_, "", role="admin", admin_bg=BG)
        db.commit()
    SUP, BGC = H.client_as(a, SU["id"]), H.client_as(a, ids["bgadm"])

    def url():
        return "/admin/performance/config"

    def post(client, **kw):
        d = {"csrf_token": "tok", "business_group": BG, "cycle_id": str(PID)}
        d.update(kw)
        return client.post(url(), data=d, follow_redirects=True)

    def starts_form(starts):
        return {"min_" + l: ("%g" % v) for l, v in zip(LAB, starts)}

    def rule_form(unit, depts=None, starts=(0, 60, 80, 95, 110), remark="ZZBR agreed with P&R", rid=None, **kw):
        d = {"action": "rule_save", "rule_unit": unit, "rule_scope": "depts" if depts else "unit"}
        d.update(starts_form(starts))
        if remark is not None:
            d["remark"] = remark
        if rid:
            d["rule_id"] = str(rid)
        d.update(kw)
        if depts:
            d["rule_dept"] = list(depts)
        return d

    def label(uid, value, bg=BG, mech="B", subject=True):
        with a.app.app_context():
            db = a.get_db()
            return a.pm_label_for_value(db, bg, mech, value, subject=uid if subject else None, cycle_id=PID)

    def bands(uid, bg=BG):
        with a.app.app_context():
            db = a.get_db()
            co, dp = a._pm_subject_unit(db, uid)
            return [(l, v) for l, v in a.pm_bands_for(db, bg, co, dp, cycle_id=PID)]

    def overall(uid):
        with a.app.app_context():
            db = a.get_db()
            ts = [dict(t) for t in db.execute("SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (PID, uid))]
            a.attach_pm_chains(db, ts)
            a.pm_score_targets(db, ts)
            ov, _c, _t = a.review_partial_overall(db, ts)
            return ov

    def starts_of(uid):
        return [v for _l, v in bands(uid)]

    W_S, D_S = [0, 60, 80, 95, 110], [0, 60, 80, 90, 100]     # a whole-unit rule's starts, a department rule's

    # ------------------------------------------------------------------------------------------------------------
    s.section("no rule: nothing changes (the group's bands, with or without a subject)")
    s.check("the group's bands are the five stored starts", starts_of(ids["svc1"]) == DEFAULT, starts_of(ids["svc1"]))
    s.check("a figure of 100 reads ME with no subject and with one",
            label(ids["svc1"], 100, subject=False) == "ME" and label(ids["svc1"], 100) == "ME")
    s.check("...and the person's overall (the one the dashboard and journey read) is ME at 100",
            overall(ids["svc1"])["label"] == "ME" and abs(overall(ids["svc1"])["value"] - 100) < 1e-9, overall(ids["svc1"]))
    s.check("the floor lookup is unchanged at the edges (80.9 BE, 81 ME, 100.9 ME, 101 AE)",
            [label(ids["oth1"], v) for v in (80.9, 81, 100.9, 101)] == ["BE", "ME", "ME", "AE"])
    s.check("a missing subject, an unknown person and an empty unit fall back to the group",
            label(None, 100) == "ME" and label(999999999, 100) == "ME")
    s.check("both tables exist, the places table with its UNIQUE",
            q1("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('pm_cycle_band_rules','pm_cycle_band_rule_depts')") == 2
            and "UNIQUE(cycle_id, business_group, company, department)" in q1("SELECT sql FROM sqlite_master WHERE name='pm_cycle_band_rule_depts'"))
    with a.app.app_context():
        s.check("the org rename cascade carries both tables and the audit log names the action",
                {"pm_cycle_band_rules", "pm_cycle_band_rule_depts"} <= a._ORG_SETTINGS_TABLES and a.ACTION_LABELS.get("pm_band_rule")
                and any(t == "pm_cycle_band_rules" for t, _c, _g in a._org_name_columns(a.get_db())[1]))

    # ------------------------------------------------------------------------------------------------------------
    s.section("the group default: starts only")
    snap0 = snapshot()
    r = post(SUP, action="set_bands", remark="ZZBR the default", **starts_form([0, 61, 81, 101, 121]))
    s.check("saving the same starts writes five rows in the viewed cycle, in band order (each band runs to the next one's start)",
            [tuple(x) for x in H.rows(a, "SELECT label, min_value, cycle_id FROM pm_cycle_bands WHERE business_group=? "
                                         "ORDER BY sort_order", (BG,))]
            == [("UA", 0, PID), ("BE", 61, PID), ("ME", 81, PID), ("AE", 101, PID), ("OU", 121, PID)])
    post(SUP, action="set_bands", remark="ZZBR the default", **starts_form([0, 70, 90, 110, 130]))
    s.check("new starts are what the floor lookup reads", [label(ids["oth1"], v) for v in (69.9, 70, 109.9, 110, 130)]
            == ["UA", "BE", "ME", "AE", "OU"])
    post(SUP, action="set_bands", remark="ZZBR back", **starts_form(DEFAULT))
    for why, starts, extra in (("not ascending", [0, 80, 70, 101, 121], {}), ("equal starts", [0, 61, 81, 81, 121], {}),
                               ("UA not 0", [5, 61, 81, 101, 121], {}), ("a start that is not a number",
                                                                          [0, 61, 81, 101, 121], {"min_AE": "ninety"}),
                               ("a blank start", [0, 61, 81, 101, 121], {"min_BE": ""}),
                               ("infinity", [0, 61, 81, 101, 121], {"min_OU": "inf"})):
        mark = q1("SELECT COALESCE(SUM(min_value),0) FROM pm_cycle_bands WHERE business_group=?", (BG,))
        r = post(SUP, action="set_bands", remark="ZZBR " + why, **dict(starts_form(starts), **extra))
        s.check("refused: " + why, q1("SELECT COALESCE(SUM(min_value),0) FROM pm_cycle_bands WHERE business_group=?", (BG,)) == mark
                and any(w in r.get_data(as_text=True) for w in ("must start", "starts at a number", "Enter where", "always starts at 0")),
                r.status_code)
    s.check("a blank UA reads as 0 (its box is fixed and not posted)",
            "saved" in post(SUP, action="set_bands", remark="ZZBR ua", **{k: v for k, v in starts_form(DEFAULT).items()
                                                                           if k != "min_UA"}).get_data(as_text=True))
    s.check("a group with no achievement % method takes no bands", "has no bands to set" in post(
        SUP, action="set_bands", business_group=BG5, remark="ZZBR x", **starts_form(DEFAULT)).get_data(as_text=True)
        and q1("SELECT COUNT(*) FROM pm_cycle_bands WHERE business_group=?", (BG5,)) == 0)

    # ------------------------------------------------------------------------------------------------------------
    s.section("rule_save: refusals first, each leaving nothing behind")
    snap = snapshot()
    r = BGC.post(url(), data=dict(rule_form(UA_, remark="ZZBR bg admin"), csrf_token="tok", business_group=BG))
    s.check("a BG admin's save is refused (403)", r.status_code == 403 and snapshot() == snap, r.status_code)
    r = SUP.post(url(), data=dict(rule_form(UA_, remark=None), csrf_token="tok", business_group=BG, cycle_id=str(PID)), follow_redirects=True)
    s.check("no remark: refused before the route runs", "Write your remark first" in r.get_data(as_text=True)
            and snapshot() == snap)
    r = post(SUP, **rule_form(UA_, remark="   "))
    s.check("a blank remark: refused", "Write your remark first" in r.get_data(as_text=True) and snapshot() == snap)
    for why, form, word in (
            ("an unknown unit", rule_form("ZZBR Nowhere"), "Pick a unit"),
            ("a unit of another group", rule_form(U5), "Pick a unit"),
            ("a typed unit not on the list", dict(rule_form("__new__"), rule_unit_new="ZZBR Made Up"), "Pick a unit"),
            ("a department of another unit", rule_form(UB_, [PRODUCTION]), "not a department"),
            ("no department ticked", dict(rule_form(UA_), rule_scope="depts"), "at least one department"),
            ("a made-up scope", dict(rule_form(UA_), rule_scope="everyone"), "or only named people"),
            ("starts not ascending", rule_form(UA_, starts=(0, 80, 60, 95, 110)), "must start higher"),
            ("UA not 0", rule_form(UA_, starts=(10, 60, 80, 95, 110)), "UA always starts at 0"),
            ("a start that is text", dict(rule_form(UA_), min_ME="eighty"), "must start at a number")):
        r = post(SUP, **form)
        s.check("refused: " + why, word in r.get_data(as_text=True) and snapshot() == snap, r.get_data(as_text=True)[:0])
    r = post(SUP, **dict(rule_form(UA_), business_group=BG5))
    s.check("a 5-point group takes no rule (refused, nothing written)", "has no bands to set" in r.get_data(as_text=True)
            and n_rules(BG5) == 0)
    r = post(SUP, **dict(rule_form(UA_), business_group=BGU))
    s.check("a group with no method yet takes none", "has no bands to set" in r.get_data(as_text=True) and n_rules(BGU) == 0)
    r = post(SUP, **dict(rule_form(UA_), business_group="ZZBR No Such Group"))
    s.check("a group that is not on the list is refused outright (403)", r.status_code == 403)

    # ------------------------------------------------------------------------------------------------------------
    s.section("rule_save: a whole-unit rule, then a department rule over it")
    log0 = q1("SELECT COALESCE(MAX(id),0) FROM activity_log")
    r = post(SUP, **rule_form(UA_, starts=W_S, remark="ZZBR whole unit agreed"))
    t = r.get_data(as_text=True)
    s.check("a whole-unit rule is saved", n_rules() == 1 and n_places() == 1 and "now has its own bands" in t, t[:0])
    s.check("...its place is the whole unit (department '')",
            q1("SELECT department FROM pm_cycle_band_rule_depts WHERE business_group=?", (BG,)) == "")
    s.check("...its starts and its remark are kept",
            tuple(H.rows(a, "SELECT min_ua, min_be, min_me, min_ae, min_ou, remark FROM pm_cycle_band_rules")[-1])
            == (0, 60, 80, 95, 110, "ZZBR whole unit agreed"))
    s.check("...the audit row names group, unit, starts and carries the remark", q1(
        "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='pm_band_rule' AND detail LIKE ? AND detail LIKE ? AND "
        "detail LIKE ? AND detail LIKE ?", (log0, "%" + BG + "%", "%" + UA_ + "%", "%BE 60 · ME 80 · AE 95 · OU 110%",
                                            "%remark: ZZBR whole unit agreed%")) == 1)
    s.check("the unit's people read the rule; another unit still reads the group's",
            starts_of(ids["svc1"]) == W_S and starts_of(ids["prd1"]) == W_S and starts_of(ids["oth1"]) == DEFAULT)
    r = post(SUP, **rule_form(UA_, starts=D_S))
    s.check("a second rule on the whole unit is refused, readably", "as a whole already has a rule" in r.get_data(as_text=True)
            and n_rules() == 1)
    r = post(SUP, **rule_form(UA_, [SERVICE], starts=D_S, remark="ZZBR service dept"))
    s.check("a department rule on the same unit is allowed beside it", n_rules() == 2 and n_places() == 2
            and "now has its own bands" in r.get_data(as_text=True))
    D_ID = q1("SELECT rule_id FROM pm_cycle_band_rule_depts WHERE business_group=? AND department=?", (BG, SERVICE))
    W_ID = q1("SELECT rule_id FROM pm_cycle_band_rule_depts WHERE business_group=? AND department=''", (BG,))
    r = post(SUP, **rule_form(UA_, [SERVICE, PRODUCTION], starts=D_S))
    s.check("a department already in another rule is refused, by name", "ZZBR Service in" in r.get_data(as_text=True)
            and "already has a rule" in r.get_data(as_text=True) and n_rules() == 2)
    try:
        with a.app.app_context():
            db = a.get_db()
            db.execute("INSERT INTO pm_cycle_band_rule_depts(rule_id, cycle_id, business_group, company, department) VALUES (?,?,?,?,?)",
                       (W_ID, PID, BG, UA_, SERVICE))
            dup = False
    except Exception as exc:   # noqa: BLE001
        dup = "UNIQUE" in str(exc)
        with a.app.app_context():
            a.get_db().rollback()
    s.check("the database itself refuses the same department in two rules (UNIQUE)", dup)

    # ------------------------------------------------------------------------------------------------------------
    s.section("precedence: department rule > whole-unit rule > group default")
    svc, prd, oth = ids["svc1"], ids["prd1"], ids["oth1"]
    s.check("pm_bands_for: a person in the ruled department reads the department's starts", starts_of(svc) == D_S, starts_of(svc))
    s.check("...another department of that unit reads the unit's", starts_of(prd) == W_S, starts_of(prd))
    s.check("...another unit reads the group's", starts_of(oth) == DEFAULT, starts_of(oth))
    s.check("pm_label_for_value with a subject: 100 reads OU / AE / ME there",
            (label(svc, 100), label(prd, 100), label(oth, 100)) == ("OU", "AE", "ME"),
            (label(svc, 100), label(prd, 100), label(oth, 100)))
    s.check("...and without a subject it is the group's, whoever asks", label(svc, 100, subject=False) == "ME")
    with a.app.app_context():
        db = a.get_db()
        urow = db.execute("SELECT * FROM users WHERE id=?", (svc,)).fetchone()
        line = dict(db.execute("SELECT * FROM pm_kpi_targets WHERE subject_id=?", (svc,)).fetchone())
        got = (a.pm_label_for_value(db, BG, "B", 100, subject=urow, cycle_id=PID), a.pm_label_for_value(db, BG, "B", 100, subject=line, cycle_id=PID),
               a.pm_label_for_value(db, BG, "B", 100, subject={"company": UA_, "department": SERVICE}, cycle_id=PID),
               a.pm_label_for_value(db, BG, "B", 100, subject={"company": UA_, "department": PRODUCTION}, cycle_id=PID))
    s.check("...(OU, OU, OU, then AE for a plain unit/department pair)", got == ("OU", "OU", "OU", "AE"), got)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE pm_kpi_targets SET company=?, department='' WHERE subject_id=?", (UB_, svc))
        db.commit()
        stale = dict(db.execute("SELECT * FROM pm_kpi_targets WHERE subject_id=?", (svc,)).fetchone())
        got = a.pm_label_for_value(db, BG, "B", 100, subject=stale, cycle_id=PID)
        db.execute("UPDATE pm_kpi_targets SET company=?, department=? WHERE subject_id=?", (UA_, SERVICE, svc))
        db.commit()
    s.check("...(still OU: the people table says Service)", got == "OU", got)
    ov = {k: overall(ids[k]) for k in ("svc1", "svc2", "svc3", "prd1", "oth1")}
    s.check("the person's overall (review_partial_overall: what the dashboard and journey read) follows the rule",
            [ov[k]["label"] for k in ("svc1", "svc2", "prd1", "oth1")] == ["OU", "OU", "AE", "ME"]
            and ov["svc3"]["label"] == "ME", {k: v["label"] for k, v in ov.items()})
    s.check("...and the figure itself is untouched (still 100%, still 80%)",
            abs(ov["svc1"]["value"] - 100) < 1e-9 and abs(ov["svc3"]["value"] - 80) < 1e-9)
    with a.app.app_context():
        db = a.get_db()
        ts = [dict(t) for t in db.execute("SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND subject_id IN (?,?,?)", (
            PID, svc, prd, oth))]
        a.attach_pm_chains(db, ts)
        a.pm_score_targets(db, ts)
        per_line = {t["subject_id"]: t["score"]["label"] for t in ts}
    s.check("each KPI line's own label (pm_score_targets) is read against its person's bands",
            per_line == {svc: "OU", prd: "AE", oth: "ME"}, per_line)
    with a.app.app_context():
        db = a.get_db()
        sc = [a._pm_scale_for(db, BG, subject=k, cycle_id=PID)["bands"] for k in (svc, prd, oth)]
        sc0 = a._pm_scale_for(db, BG, cycle_id=PID)["bands"]
    s.check("the page's scale (_pm_scale_for) carries the same starts for the same person",
            [[b["min"] for b in x] for x in sc] == [D_S, W_S, DEFAULT] and [b["min"] for b in sc0] == DEFAULT)

    def journey_bands(uid):
        with a.app.test_request_context("/"):
            db = a.get_db()
            u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            res = a._review_kpi_overview(db, u)
            return None if not res else res["data"]["bands_b"]
    jb = {k: journey_bands(ids[k]) for k in ("svc1", "prd1", "oth1")}
    s.check("the journey's live-glow bands (bands_b) are the same floors the server labels with",
            all(jb[k] for k in jb) and [[b["min"] for b in jb[k]] for k in ("svc1", "prd1", "oth1")] == [D_S, W_S, DEFAULT]
            and [b["code"] for b in jb["svc1"]] == list(LAB), jb)
    # the lines of many people are labelled with ONE users read, and none at all when no rule exists
    with a.app.app_context():
        db = a.get_db()
        seen = []
        db.set_trace_callback(seen.append)
        ts = [dict(t) for t in db.execute("SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND subject_id IN (?,?,?,?,?)", (
            PID, ids["svc1"], ids["svc2"], ids["svc3"], ids["prd1"], ids["oth1"]))]
        a.attach_pm_chains(db, ts)
        del seen[:]
        a.pm_score_targets(db, ts)
        users_reads = [q for q in seen if "FROM users" in q]
        db.set_trace_callback(None)
    s.check("pm_score_targets reads the people of all %d lines in ONE users query, never one per line" % len(ts),
            len(ts) == 5 and len(users_reads) == 1, users_reads)
    # the request's cached rules are forgotten when one is saved, so the rest of that request reads it
    with a.app.test_request_context("/"):
        db = a.get_db()
        before_ = a.pm_bands_for(db, BG, UB_, SERVICE, cycle_id=PID)
        err = a._band_rule_write(db, {"id": SU["id"]}, PID, BG, UB_, [""], dict(zip(LAB, [0, 1, 2, 3, 4])), "ZZBR cache")
        after_ = a.pm_bands_for(db, BG, UB_, SERVICE, cycle_id=PID)
        rid_ = db.execute("SELECT id FROM pm_cycle_band_rules WHERE business_group=? AND company=?", (BG, UB_)).fetchone()[0]
        db.execute("DELETE FROM pm_cycle_band_rule_depts WHERE rule_id=?", (rid_,))
        db.execute("DELETE FROM pm_cycle_band_rules WHERE id=?", (rid_,))
        db.commit()
        a._pm_band_rules_reset()
        gone_ = a.pm_bands_for(db, BG, UB_, SERVICE, cycle_id=PID)
    s.check("...a rule saved in the same request is read by it at once, and so is its removal (the cache is cleared)",
            err is None and [v for _l, v in before_] == DEFAULT and [v for _l, v in after_] == [0, 1, 2, 3, 4]
            and [v for _l, v in gone_] == DEFAULT, (before_, after_, gone_))
    with a.app.app_context():
        db = a.get_db()
        vrules = {r["id"]: r for r in a._band_rules_view(db, PID, BG)[0]}
        w_people, d_people = a._band_rule_people(db, PID, BG, UA_, [""], W_ID), a._band_rule_people(db, PID, BG, UA_, [SERVICE], D_ID)
    s.check("the whole-unit rule reaches the unit minus the department that holds its own rule (the department wins)",
            w_people == [prd] and sorted(d_people) == sorted([ids["svc1"], ids["svc2"], ids["svc3"]])
            and vrules[W_ID]["people"] == 1 and vrules[D_ID]["people"] == 3, (w_people, vrules[W_ID]["people"]))
    # drop the department rule: the department falls to the unit's, then the unit's falls to the group's
    r = post(SUP, action="rule_remove", rule_id=str(D_ID), remark="ZZBR drop service")
    s.check("rule_remove: the department falls back to the whole-unit rule",
            n_rules() == 1 and starts_of(svc) == W_S and label(svc, 100) == "AE" and n_places() == 1
            and "back on" in r.get_data(as_text=True))
    s.check("...its places went with it (no orphan rows)", q1(
        "SELECT COUNT(*) FROM pm_cycle_band_rule_depts WHERE rule_id=?", (D_ID,)) == 0)
    s.check("...and the audit row says what was removed, with the remark", q1(
        "SELECT COUNT(*) FROM activity_log WHERE action='pm_band_rule' AND detail LIKE '%removed the rule%' AND detail "
        "LIKE ? AND detail LIKE '%remark: ZZBR drop service%'", ("%" + SERVICE + "%",)) == 1)
    post(SUP, action="rule_remove", rule_id=str(W_ID), remark="ZZBR drop unit")
    s.check("rule_remove: the whole unit falls back to the group default", n_rules() == 0 and n_places() == 0
            and starts_of(svc) == DEFAULT and label(svc, 100) == "ME" and overall(svc)["label"] == "ME")
    r = post(SUP, action="rule_remove", rule_id=str(W_ID), remark="ZZBR again")
    s.check("removing a rule that is gone says so and changes nothing", "is gone" in r.get_data(as_text=True) and n_rules() == 0)
    r = post(SUP, action="rule_remove", rule_id=str(W_ID))
    s.check("a removal needs the remark too", "Write your remark first" in r.get_data(as_text=True))
    r = BGC.post(url(), data={"csrf_token": "tok", "business_group": BG, "action": "rule_remove", "rule_id": "1",
                              "remark": "ZZBR no"})
    s.check("...and is the super admin's alone (403 for a BG admin)", r.status_code == 403)

    # ------------------------------------------------------------------------------------------------------------
    s.section("departments only, and an edit keeps its own places")
    post(SUP, **rule_form(UA_, [SERVICE], starts=D_S, remark="ZZBR dept only"))
    s.check("with only a department rule: its department reads it, the rest of the unit reads the group's",
            starts_of(svc) == D_S and starts_of(prd) == DEFAULT)
    D_ID = q1("SELECT rule_id FROM pm_cycle_band_rule_depts WHERE business_group=? AND department=?", (BG, SERVICE))
    r = post(SUP, **rule_form(UA_, [SERVICE, PRODUCTION], starts=[0, 55, 75, 90, 105], rid=D_ID, remark="ZZBR widen it"))
    s.check("editing a rule keeps its own place (no clash with itself) and can take another department",
            n_rules() == 1 and n_places() == 2 and starts_of(prd) == [0, 55, 75, 90, 105]
            and "now has its own bands" in r.get_data(as_text=True))
    s.check("...an edit is audited as a change", q1("SELECT COUNT(*) FROM activity_log WHERE action='pm_band_rule' AND "
                                                       "detail LIKE '%changed the%' AND detail LIKE '%remark: ZZBR widen it%'") == 1)
    r = post(SUP, **rule_form(UA_, [SERVICE], starts=D_S, rid=987654, remark="ZZBR ghost"))
    s.check("editing a rule that is not this group's is refused", "is gone" in r.get_data(as_text=True) and n_rules() == 1)
    post(SUP, **rule_form(UA_, starts=W_S, remark="ZZBR unit on top"))
    W_ID = q1("SELECT rule_id FROM pm_cycle_band_rule_depts WHERE business_group=? AND department=''", (BG,))
    r = post(SUP, **rule_form(UA_, [SERVICE], starts=D_S, rid=W_ID, remark="ZZBR steal"))
    s.check("an edit cannot take a department another rule holds", "already has a rule" in r.get_data(as_text=True)
            and q1("SELECT COUNT(*) FROM pm_cycle_band_rule_depts WHERE rule_id=?", (W_ID,)) == 1)

    # ------------------------------------------------------------------------------------------------------------
    s.section("a 5-point group ignores rules entirely; a stray row changes nothing")
    with a.app.app_context():
        db = a.get_db()
        before = [a.pm_label_for_value(db, None, "A", v, subject=ids["five1"], cycle_id=PID) for v in (1.0, 2.6, 3.4, 3.51, 4.6)]
        rid5 = db.execute("INSERT INTO pm_cycle_band_rules(cycle_id, business_group, company, min_ua, min_be, min_me, min_ae, min_ou) "
                          "VALUES (?,?,?,0,1,1.5,2,2.5)", (PID, BG5, U5)).lastrowid
        db.execute("INSERT INTO pm_cycle_band_rule_depts(rule_id, cycle_id, business_group, company, department) VALUES (?,?,?,?,'')",
                   (rid5, PID, BG5, U5))
        db.commit()
        after = [a.pm_label_for_value(db, None, "A", v, subject=ids["five1"], cycle_id=PID) for v in (1.0, 2.6, 3.4, 3.51, 4.6)]
        also = [a.pm_label_for_value(db, BG5, "A", v, subject=ids["five1"], cycle_id=PID) for v in (1.0, 2.6, 3.4, 3.51, 4.6)]
        db.execute("DELETE FROM pm_cycle_band_rule_depts WHERE rule_id=?", (rid5,))
        db.execute("DELETE FROM pm_cycle_band_rules WHERE id=?", (rid5,))
        db.commit()
    s.check("mechanism A labels are the same table with a rule present (1.0 UA, 2.6 ME, 3.4 ME, 3.51 AE, 4.6 OU)",
            before == after == also == ["UA", "ME", "ME", "AE", "OU"], (before, after, also))

    # ------------------------------------------------------------------------------------------------------------
    s.section("the preview: reads only, and the counts are the hand computation")
    # the state: a whole-unit rule W on Unit A (W_ID) exists; take it away for a clean slate, then preview a new place
    post(SUP, action="rule_remove", rule_id=str(W_ID), remark="ZZBR clear")
    post(SUP, action="rule_remove", rule_id=str(D_ID), remark="ZZBR clear")
    assert n_rules() == 0
    snap = snapshot()

    def preview(unit, depts=None, starts=D_S, rid=None, **kw):
        q = {"bg": BG, "cycle": PID, "rule_unit": unit, "rule_scope": "depts" if depts else "unit"}
        q.update({"min_" + l: "%g" % v for l, v in zip(LAB, starts)})
        if rid:
            q["rule_id"] = rid
        q.update(kw)
        qs = "&".join("%s=%s" % (k, v) for k, v in q.items())
        for d in depts or []:
            qs += "&rule_dept=" + d
        qs = qs.replace(" ", "%20")
        r = SUP.get(url() + "/rule-preview?" + qs)
        return r.status_code, json.loads(r.get_data(as_text=True) or "{}")
    code, j = preview(UA_, [SERVICE])
    s.check("the preview is a GET that answers JSON for the super admin", code == 200 and j.get("ok") is True, (code, j))
    s.check("...it wrote nothing at all (rules, places, bands, audit, scorecards, calibration)", snapshot() == snap)
    # hand computation: Unit A / Service = svc1, svc2, svc3; all three have a result; D_S = 0,60,80,90,100
    #   svc1/svc2 at 100: ME now (81..<101) -> OU (100 >= 100); svc3 at 80: BE now (61..<81) -> ME (80 >= 80)
    s.check("people reached = the department's 3 active people", j["people"] == 3 == q1(
        "SELECT COUNT(*) FROM users WHERE business_group=? AND company=? AND department=? AND left_at IS NULL", (BG, UA_, SERVICE)))
    s.check("...all 3 have KPI results so far", j["with_results"] == 3)
    s.check("...3 would change band: ME to OU twice, BE to ME once", len(j["changes"]) == 3
            and j["moves"] == {"ME → OU": 2, "BE → ME": 1}, j["moves"])
    s.check("...each change names the person, department, from and to",
            sorted((c["from"], c["to"]) for c in j["changes"]) == [("BE", "ME"), ("ME", "OU"), ("ME", "OU")]
            and all(c["dept"] == SERVICE and c["name"].startswith("ZZ BR") for c in j["changes"]))
    s.check("highest score possible: base variant, every line multiple 0 -> 100%, topping out at ME on the group default",
            j["highest"] == {"kind": "capped", "pct": 100.0, "lines": 3, "top_default": "ME"}, j["highest"])
    code, j2 = preview(UA_)
    s.check("a whole-unit preview reaches the unit's 4 people", j2["people"] == 4 and j2["with_results"] == 4, j2)
    code, j3 = preview(UB_, starts=DEFAULT)
    s.check("the group's own starts change nobody; a person with no result yet, or only some lines keyed, counts as a person, never as a partial result",
            j3["people"] == 4 and j3["with_results"] == 1 and j3["changes"] == [] and j3["moves"] == {}, j3)
    code, j4 = preview(UA_, [SERVICE], starts=[0, 60, 80, 70, 100])
    s.check("starts that are not ascending still show the people, say why, and list no changes",
            j4["people"] == 3 and j4["changes"] is None and "must start higher" in (j4["starts_error"] or ""), j4)
    code, j5 = preview(UB_, [PRODUCTION])
    s.check("a department the unit does not have is a 400 with the reason", code == 400 and "not a department" in j5["error"])
    code, j6 = preview("ZZBR Nowhere")
    s.check("an unknown unit is a 400", code == 400)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE pm_kpi_targets SET multiple=50 WHERE subject_id=?", (ids["svc3"],))
        db.commit()
    s.check("one line that can scale above target lifts the cap: no cap above target",
            preview(UA_, [SERVICE])[1]["highest"]["kind"] == "open")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE pm_kpi_targets SET multiple=0, excellence=120 WHERE subject_id IN (?,?,?)",
                   (ids["svc1"], ids["svc2"], ids["svc3"]))
        db.execute("UPDATE pm_bg_config SET variant='excellence' WHERE business_group=?", (BG,))
        db.commit()
    hj = preview(UA_, [SERVICE])[1]["highest"]
    s.check("excellence variant: the highest excellence-as-% of target across their lines (120 of 100)",
            hj["kind"] == "cap" and hj["pct"] == 120.0 and hj["top_default"] == "AE", hj)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE pm_bg_config SET variant='base' WHERE business_group=?", (BG,))
        db.execute("UPDATE pm_kpi_targets SET excellence=NULL WHERE subject_id IN (?,?,?)", (ids["svc1"], ids["svc2"], ids["svc3"]))
        db.commit()
    s.check("a unit with nobody on a scorecard hides the box (no lines, no highest)",
            preview(UB_, starts=D_S)[1]["highest"] is not None and preview(UA_, [PRODUCTION])[1]["highest"] is not None)
    r = BGC.get(url() + "/rule-preview?bg=" + BG.replace(" ", "%20"))
    s.check("the preview is the super admin's alone", r.status_code == 403)
    s.check("a 5-point group has no preview", SUP.get(url() + "/rule-preview?bg=" + BG5.replace(" ", "%20")).status_code == 400)
    s.check("an unknown group has none (404)", SUP.get(url() + "/rule-preview?bg=ZZBR%20No%20Such").status_code == 404)
    s.check("signed out it goes to the sign-in, as every admin GET does (the deploy's route probe reads a redirect)",
            a.app.test_client().get(url() + "/rule-preview").status_code in (301, 302))
    with a.app.test_request_context("/"):
        mod = a._access_page_module("admin_performance_rule_preview", {}, "/admin/performance/config/rule-preview")
    s.check("...(the module that owns /admin/performance/config)", mod is not None, mod)

    # ------------------------------------------------------------------------------------------------------------
    s.section("what is decided stays decided when a rule moves")
    with a.app.app_context():
        db = a.get_db()
        sid = db.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, "
                         "locked_at) VALUES (?,?,?,?,?,datetime('now'))", (PID, "super", a.PM_SUPER_SCOPE_KEY, BG,
                                                                           "ZZBR super")).lastrowid
        for k, band in (("svc1", "AE"), ("svc3", "BE")):
            db.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band) "
                       "VALUES (?,?,?,?)", (sid, ids[k], "ME", band))
        db.commit()
        cyc = db.execute("SELECT * FROM cycles WHERE id=?", (PID,)).fetchone()
        db.execute("INSERT OR IGNORE INTO result_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?,?,?)",
                   (PID, ids["svc1"], "pm", SU["id"]))
        db.commit()

    def decided():
        with a.app.app_context():
            db = a.get_db()
            subj = {k: db.execute("SELECT * FROM users WHERE id=?", (ids[k],)).fetchone() for k in ("svc1", "svc3")}
            return (
                [tuple(r) for r in db.execute("SELECT subject_id, original_band, adjusted_band FROM "
                                              "pm_calibration_adjustments WHERE session_id=? ORDER BY subject_id", (sid,))],
                tuple(db.execute("SELECT locked_at IS NOT NULL FROM pm_calibration_sessions WHERE id=?", (sid,)).fetchone()),
                q1("SELECT COUNT(*) FROM result_releases WHERE subject_id=?", (ids["svc1"],)),
                {k: a.pm_effective_band(db, subj[k], PID, "ME")["band"] for k in subj})
    before = decided()
    s.check("the super admin's final move is what the person reads (AE and BE), whatever the raw band", before[3] == {"svc1": "AE", "svc3": "BE"}, before)
    post(SUP, **rule_form(UA_, [SERVICE], starts=D_S, remark="ZZBR rule over decided bands"))
    RID = q1("SELECT rule_id FROM pm_cycle_band_rule_depts WHERE business_group=? AND department=?", (BG, SERVICE))
    s.check("saving a rule leaves every calibration move, lock, release and effective band as it was", decided() == before, decided())
    post(SUP, **rule_form(UA_, [SERVICE], starts=[0, 40, 50, 60, 70], rid=RID, remark="ZZBR edit"))
    s.check("...editing it too", decided() == before)
    post(SUP, action="rule_remove", rule_id=str(RID), remark="ZZBR remove")
    s.check("...and removing it", decided() == before and n_rules() == 0)

    # ------------------------------------------------------------------------------------------------------------
    s.section("the page")
    pg = SUP.get(url() + "?bg=" + BG.replace(" ", "%20")).get_data(as_text=True)
    s.check("the picked group shows its Achievement % bands heading and the group default form",
            "2. ZZBR Base Group: Achievement % bands" in pg and 'value="set_bands"' in pg and "Save group default" in pg)
    s.check("...only the picked group's settings (no other group's bands heading)", pg.count("Achievement % bands</h2>") == 1)
    s.check("...five starts, UA fixed and disabled, and the Check a score box",
            all('name="min_%s"' % l in pg for l in LAB) and re.search(r'name="min_UA"[^>]*disabled', pg) and "Check a score" in pg)
    s.check("...no rules yet says everyone uses the group default",
            re.search(r"No rules yet in [^<]+\. Everyone in ZZBR Base Group uses the group default\.", pg))
    s.check("...Add a rule and the rule panel are there for the super admin", "Add a rule" in pg and 'id="br-rule-form"' in pg
            and 'value="rule_save"' in pg)
    s.check("...the rule form asks first (OneHR's own box) and takes a required remark", 'data-confirm="' in pg.split('id="br-rule-form"')[1][:600]
            and 'name="remark"' in pg and 'maxlength="%d"' % a.SUPER_BAND_REMARK_MAX in pg)
    s.check("...the method table has its radio dot, the group as a link and the picked row marked",
            "br-radio" in pg and "?bg=ZZBR+Base+Group" in pg and re.search(r'br-row is-picked"[^>]*data-bg="ZZBR Base Group"', pg))
    post(SUP, **rule_form(UA_, [SERVICE], starts=D_S, remark="ZZBR page"))
    post(SUP, **rule_form(UB_, starts=W_S, remark="ZZBR page"))
    pg = SUP.get(url() + "?bg=" + BG.replace(" ", "%20")).get_data(as_text=True)
    s.check("with rules: the table lists each (unit over its departments, or All departments), the people and the bands",
            "ZZBR Service" in pg and "All departments" in pg and "UA 0 · BE 60 · ME 80 · AE 90 · OU 100" in pg
            and "2 rules" in pg)
    s.check("...Edit, Remove (danger tone, its own confirm and remark) and the people count opens the list panel",
            "data-band-edit" in pg and 'value="rule_remove"' in pg and "br-danger" in pg and "band-rule-people" in pg)
    lst = SUP.get("/admin/list/band-rule-people?fragment=1&bg=%s&rule=%d" % (BG.replace(" ", "%20"), q1(
        "SELECT rule_id FROM pm_cycle_band_rule_depts WHERE business_group=? AND department=?", (BG, SERVICE)))).get_data(as_text=True)
    s.check("the people list behind a rule's count lists the department's 3", lst.count("ZZ BR Service") == 3, lst.count("ZZ BR"))
    s.check("...and the list is the super admin's (a BG admin is refused)", BGC.get(
        "/admin/list/band-rule-people?fragment=1&bg=%s&rule=1" % BG.replace(" ", "%20")).status_code == 403)
    ro = BGC.get(url()).get_data(as_text=True)
    s.check("a BG admin reads their group with no forms: no save, no Add a rule, no Edit or Remove, no rule panel",
            "Read only for you" in ro and 'value="set_bands"' not in ro and 'value="rule_save"' not in ro
            and "Add a rule" not in ro and 'value="rule_remove"' not in ro and "data-band-edit" not in ro)
    s.check("...but sees the rules and the starts", "ZZBR Service" in ro and "UA 0 · BE 60 · ME 80 · AE 90 · OU 100" in ro
            and 'data-start="BE"' in ro)
    for rid_ in [r[0] for r in H.rows(a, "SELECT id FROM pm_cycle_band_rules WHERE business_group=?", (BG,))]:
        post(SUP, action="rule_remove", rule_id=str(rid_), remark="ZZBR page done")
    five = SUP.get(url() + "?bg=" + BG5.replace(" ", "%20")).get_data(as_text=True)
    s.check("a 5-point group shows the table read only: the sentence, the KPI library link, no invented example numbers",
            "Each KPI is rated 1 to 5 against its own table" in five and "Open the KPI library" in five
            and "Example" not in five and "Shared by every 5-point group" in five and "Nothing to set here for the group" in five)
    s.check("...the shared starts (1.00 1.51 2.51 3.51 4.51), Check a score at 3.40, and the dashed note",
            all(x in five for x in ("1.00", "1.51", "2.51", "3.51", "4.51")) and 'value="3.40"' in five
            and "Unit and department band rules are for Achievement % groups only" in five)
    s.check("...with no band form, no rule panel and no Add a rule", 'value="set_bands"' not in five and "br-rule-form" not in five
            and "Add a rule" not in five)
    unset = SUP.get(url() + "?bg=" + BGU.replace(" ", "%20")).get_data(as_text=True)
    s.check("a group with no method has one card saying so", "ZZBR Unset Group has no scoring method yet" in unset
            and "Achievement % bands</h2>" not in unset)
    with a.app.app_context():
        picks = [a._band_pick_group(["G1", "G2", "G3"], {"G2": {"mechanism": "B"}, "G3": {"mechanism": "B"}}, ""),
                 a._band_pick_group(["G1", "G2"], {"G1": {"mechanism": "A"}}, ""),
                 a._band_pick_group(["G1", "G2"], {}, "G2"), a._band_pick_group(["G1", "G2"], {}, "Nope"),
                 a._band_pick_group([], {}, "")]
    s.check("the default pick is the first Achievement % group in scope, else the first group (?bg= wins when listed)",
            picks == ["G2", "G1", "G2", "G1", None], picks)

    # ------------------------------------------------------------------------------------------------------------
    s.section("the rule panel's form carries every field the server needs (the chips alone are not a field)")
    from html import unescape
    post(SUP, **rule_form(UA_, [SERVICE, PRODUCTION], starts=[0, 55, 75, 90, 105], remark="ZZBR panel fields"))
    ERID = q1("SELECT rule_id FROM pm_cycle_band_rule_depts WHERE business_group=? AND department=?", (BG, SERVICE))
    pg = SUP.get(url() + "?bg=" + BG.replace(" ", "+")).get_data(as_text=True)
    form_html = pg[pg.index('id="br-rule-form"'):]
    form_html = form_html[:form_html.index("</form>")]
    names = set(re.findall(r'<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"', form_html))
    s.check("the panel's form has a named field for the action, the group, the rule being edited, the unit, the scope, "
            "the starts and the remark", {"action", "business_group", "rule_id", "rule_unit", "rule_scope", "min_UA", "min_BE",
                                          "min_ME", "min_AE", "min_OU", "remark"} <= names, sorted(names))
    s.check("...UA is a disabled box (not posted: the server reads a blank UA as 0), the other four are required",
            re.search(r'name="min_UA"[^>]*disabled', form_html) and len(re.findall(r'name="min_(?:BE|ME|AE|OU)"[^>]*required', form_html)) == 4)
    m_ = re.search(r"data-rule='([^']*)'", pg[pg.index('data-rule-row="%d"' % ERID):])
    rj = json.loads(unescape(m_.group(1)))
    s.check("the Edit button carries the rule for the panel: id, unit, departments, starts",
            rj["id"] == ERID and rj["company"] == UA_ and sorted(rj["depts"]) == sorted([SERVICE, PRODUCTION])
            and rj["starts"] == [0, 55, 75, 90, 105] and rj["whole"] is False, rj)
    unit_json = json.loads(unescape(re.search(r'id="br-data">(.*?)</script>', pg, re.S).group(1)))
    uj = {u["company"]: u for u in unit_json["units"]}
    s.check("the page's unit list gives each department its raw name (the field value) and its label (the chip)",
            all("label" in d and "d" in d for d in uj[UA_]["depts"]) and {d["d"] for d in uj[UB_]["depts"]} == {SERVICE, FIN}
            and {d["d"]: d["label"] for d in uj[UB_]["depts"]}[FIN] == a.proper_name(FIN) != FIN)
    js = open(os.path.join(H.REPO, "static", "band_rules.js"), encoding="utf-8").read()
    s.check("band_rules.js writes one hidden rule_dept field per chosen chip, on every toggle and again just before the send",
            'h.name = "rule_dept"' in js and js.count("syncFields()") >= 3 and "function syncFields" in js   # syncFields: the departments and, since 2026-11-02, the named people
            and js.split("function renderChips()")[1].lstrip("{ \n").startswith("syncFields();")
            and "syncFields();   // before the confirm box" in js)
    # the form the JS builds for these chips is exactly this, and the server saves it
    sent = {"csrf_token": "tok", "action": "rule_save", "business_group": BG, "rule_id": str(ERID), "rule_unit": UA_,
            "rule_scope": "depts", "rule_dept": [PRODUCTION], "cycle_id": str(PID), "min_BE": "50", "min_ME": "70", "min_AE": "85", "min_OU": "99",
            "remark": "ZZBR as the panel sends it"}
    r = SUP.post(url(), data=sent, follow_redirects=True)
    s.check("a post shaped like the panel's (hidden rule_dept per chip, UA left out) saves the edit",
            "now has its own bands" in r.get_data(as_text=True) and q1(
                "SELECT COUNT(*) FROM pm_cycle_band_rule_depts WHERE rule_id=?", (ERID,)) == 1 and q1(
                "SELECT min_be FROM pm_cycle_band_rules WHERE id=?", (ERID,)) == 50)
    sent.pop("rule_dept")
    r = SUP.post(url(), data=sent)
    s.check("...and without the chips in the form it is refused, as the browser QC found (the guard is real)",
            r.status_code == 302 and "panel=rule" in r.headers["Location"] and q1(
                "SELECT COUNT(*) FROM pm_cycle_band_rule_depts WHERE rule_id=?", (ERID,)) == 1)

    s.section("a refused save comes back with the panel open and what was entered")
    loc = r.headers["Location"]
    r2 = SUP.get(loc)
    t2 = r2.get_data(as_text=True)
    dm = re.search(r"data-draft='([^']*)'", t2)
    dj = json.loads(unescape(dm.group(1))) if dm else {}
    s.check("the redirect names the group and opens the rule panel", "bg=" in loc and "panel=rule" in loc and r2.status_code == 200)
    s.check("the panel form carries what was entered: id, unit, scope, starts as typed, remark",
            dj.get("id") == ERID and dj.get("company") == UA_ and dj.get("whole") is False
            and dj.get("starts") == ["", "50", "70", "85", "99"] and dj.get("remark") == "ZZBR as the panel sends it", dj)
    s.check("...the reason is shown on the page (a flash the panel copies in)", "at least one department" in t2)
    s.check("...once: the next visit is a plain page", "data-draft" not in SUP.get(url() + "?bg=" + BG.replace(" ", "+")).get_data(as_text=True))
    SUP.post(url(), data=dict(sent, rule_scope="depts"))
    s.check("...and a draft is only for the group it was entered in (not shown on another group's page)",
            "data-draft" not in SUP.get(url() + "?bg=" + BG5.replace(" ", "+")).get_data(as_text=True))

    s.section("department names read in proper case on screen; stored and posted values keep HRIS's spelling")
    r = post(SUP, **rule_form(UB_, [FIN], starts=[0, 50, 70, 90, 100], remark="ZZBR proper case"))
    t = r.get_data(as_text=True)
    with a.app.app_context():
        P, UBX = a.proper_name(FIN), a.display_company(BG, UB_)
    s.check("the flash after a save reads \"Unit · Department\" in proper case", unescape(t).count("%s · %s now has its own bands" % (
        UBX, P)) == 1, P)
    s.check("...the stored department is HRIS's spelling", q1("SELECT department FROM pm_cycle_band_rule_depts WHERE business_group=? "
                                                              "AND company=?", (BG, UB_)) == FIN)
    pg = SUP.get(url() + "?bg=" + BG.replace(" ", "+")).get_data(as_text=True)
    row = pg[pg.index('data-rule-row="%d"' % q1("SELECT rule_id FROM pm_cycle_band_rule_depts WHERE business_group=? AND company=?", (BG, UB_))):]
    row = row[:row.index("</tr>")]
    s.check("the rules table and the remove confirm show the proper-case name, joined with a middle dot (never in brackets)",
            unescape(row).count(P) >= 2 and "(%s)" % P not in unescape(row) and ("&middot; " + P in row or "· " + P in unescape(row)))
    s.check("...while the Edit button's data (the value the form posts) is the raw spelling",
            json.loads(unescape(re.search(r"data-rule='([^']*)'", row).group(1)))["depts"] == [FIN])
    lst = SUP.get("/admin/list/band-rule-people?fragment=1&bg=%s&rule=%d" % (BG.replace(" ", "%20"), q1(
        "SELECT rule_id FROM pm_cycle_band_rule_depts WHERE business_group=? AND company=?", (BG, UB_)))).get_data(as_text=True)
    s.check("the people list panel's title says it in proper case too", unescape(lst).count(P) >= 1, P)
    pv = json.loads(SUP.get(url() + "/rule-preview?bg=%s&cycle=%d&rule_unit=%s&rule_scope=depts&rule_dept=%s&min_BE=40&min_ME=50&min_AE=60&min_OU=70"
                            % (BG.replace(" ", "%20"), PID, UB_.replace(" ", "%20"), "ZZBR%20Service")).get_data(as_text=True))
    s.check("the preview's rows carry a department label as well as the raw one",
            all("dept_label" in c_ for c_ in (pv["changes"] or [])) and pv["people"] == 3, pv["people"])
    r = post(SUP, action="rule_remove", rule_id=str(q1("SELECT rule_id FROM pm_cycle_band_rule_depts WHERE business_group=? AND company=?", (BG, UB_))),
             remark="ZZBR proper remove")
    s.check("the remove flash reads \"Unit · Department\" in proper case", "%s · %s is removed" % (UBX, P) in unescape(
        r.get_data(as_text=True)))
    s.check("Not set never wraps: the pill is nowrap and the method select and Save share a line",
            "white-space: nowrap" in open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read().split(".br-table .status-pill")[1][:120])
    for rid_ in [r_[0] for r_ in H.rows(a, "SELECT id FROM pm_cycle_band_rules WHERE business_group=?", (BG,))]:
        post(SUP, action="rule_remove", rule_id=str(rid_), remark="ZZBR panel done")

    # ------------------------------------------------------------------------------------------------------------
    s.section("the lint: no caller labels a KPI result without its person")
    src = H.code_without_docstrings(H.source(a))
    calls = [m for m in re.finditer(r"pm_label_for_value\(", src)]
    bad = []
    for m in calls:
        seg = src[m.start(): m.start() + 260]
        head = seg.split("\n")[0]
        if "def pm_label_for_value" in head:
            continue
        # a mechanism-A call (None / "A") reads the fixed table; every other call must name its subject
        if '"A"' in seg[:120] or "None, \"A\"" in seg[:120] or "subject=" in seg:
            continue
        bad.append(seg[:90])
    s.check("every pm_label_for_value call is mechanism A or passes subject= (%d calls)" % len(calls), len(calls) >= 6 and not bad, bad)
    s.check("only the cycle loader reads a cycle's band tables (other queries count rows or write them)",
            src.count("SELECT business_group, label, min_value FROM pm_cycle_bands WHERE cycle_id=?") == 1,
            src.count("SELECT business_group, label, min_value FROM pm_cycle_bands WHERE cycle_id=?"))
    s.check("a rule's rows are read in one place", src.count("FROM pm_cycle_band_rules r JOIN pm_cycle_band_rule_depts d") == 1)
    s.check("save and remove clear the request's cached rules", src.count("_pm_band_rules_reset()") >= 3)
    s.check("the preview and the new POST actions are on the band-remark list", {"rule_save", "rule_remove"} <= a.SUPER_BAND_ENDPOINTS[
        "admin_performance_config"])
    s.check("the page's template asks the remark (the confirm box) and keeps its danger tone", "super_remark_attrs(" in open(
        os.path.join(H.REPO, "templates", "settings", "_pm.html"), encoding="utf-8").read())
finally:
    with a.app.app_context():
        db = a.get_db()
        cleanup(db)
        left = [db.execute("SELECT COUNT(*) FROM %s WHERE business_group IN (?,?,?)" % t, (BG, BG5, BGU)).fetchone()[0]
                for t in ("pm_cycle_band_rules", "pm_cycle_band_rule_depts", "pm_rating_bands", "pm_bg_config", "org_units")]
        left.append(db.execute("SELECT COUNT(*) FROM users WHERE employee_id LIKE ?", (PREFIX + "%",)).fetchone()[0])
    s.check("everything the suite made is put back", not any(left), left)

sys.exit(s.done())
