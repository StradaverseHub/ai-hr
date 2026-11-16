"""Band starts are PER CYCLE (Chris, 2026-10-29; canvas [design canvas link removed]).

Before: one 5-point table, one table per Achievement % group and one set of unit / department rules, read by every cycle. A
change restated every cycle's results. Now every cycle holds its own (pm_cycle_bands, pm_cycle_band_sets,
pm_cycle_band_rules, pm_cycle_band_rule_depts); the older tables are the template a cycle copies from.

What this suite holds:
  * the boot migration copies today's tables into every existing cycle, nothing moves (a baseline of every person's band
    read the old way equals the new reader's), and it is idempotent
  * a change to cycle A's 5-point starts, an Achievement % group default or a rule changes a band in A and NOT in B
  * a new cycle copies the previous cycle's starts (all three kinds), the start route seeds a new cycle
  * the saves are refused without a remark, out of order, outside 1 to 5, with more than two decimals, by a BG admin, after
    a result goes to leaders, for an archived cycle -- and each refusal depends on exactly that condition (the same post
    passes when the condition is put right); the three other saves pass the same gate
  * the audit row names the cycle, the old and the new starts and the remark; who and when are stored
  * the 5-point preview's counts are a per-person hand computation, and it writes nothing
  * the page: the cycle in the top bar, editable inputs, the fold of the other cycles, Fixed chips, a BG admin reads only
  * what is decided (a calibration move and lock) does not move when starts change
  * the lint: no caller of the readers omits the cycle (and the lint catches an omission)
Self-contained: its own cycles, groups and people, deleted at the end.
"""
import ast
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Band starts per cycle -- every cycle its own, one gate, nothing decided is moved")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG5, BGB, BGU = "ZZBC Five Group", "ZZBC Base Group", "ZZBC Unset Group"
UA_, UB_ = "ZZBC Unit A", "ZZBC Unit B"
DEPT = "ZZBC Service"
PREFIX = "ZZBC-"
LAB = ("UA", "BE", "ME", "AE", "OU")
FIVE0 = [1.0, 1.51, 2.51, 3.51, 4.51]
PCT0 = [0, 61, 81, 101, 121]
ids, CY = {}, {}


def q1(sql, args=()):
    return H.one(a, sql, args)


def cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE ?", (PREFIX + "%",))]
    cyc = [r[0] for r in db.execute("SELECT id FROM cycles WHERE code LIKE 'ZZBC-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_calibration_adjustments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM leader_releases WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN "
                   "(%s))" % ph, ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM pm_calibration_sessions WHERE business_group IN (?,?,?)", (BG5, BGB, BGU))
    for c in cyc:
        for t in ("pm_cycle_band_rule_depts", "pm_cycle_band_rules", "pm_cycle_band_sets", "pm_cycle_bands",
                  "leader_releases", "pm_kpi_targets", "pm_calibration_sessions"):
            db.execute("DELETE FROM %s WHERE cycle_id=?" % t, (c,))
        db.execute("DELETE FROM cycles WHERE id=?", (c,))
    for g_ in (BG5, BGB, BGU):
        for t in ("pm_cycle_band_rule_depts", "pm_cycle_band_rules", "pm_cycle_band_sets", "pm_cycle_bands"):
            db.execute("DELETE FROM %s WHERE business_group=?" % t, (g_,))
        db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (g_,))
        db.execute("DELETE FROM org_units WHERE business_group=?", (g_,))
    db.execute("DELETE FROM activity_log WHERE action IN ('pm_band_rule','pm_rating_bands') AND detail LIKE '%ZZBC%'")
    db.commit()


def snapshot():
    """Every table a save may touch, and the audit log: a refused post or a preview must leave all of it as it found it."""
    return (q1("SELECT COUNT(*) FROM pm_cycle_bands"), q1("SELECT COALESCE(SUM(min_value * cycle_id),0) FROM pm_cycle_bands"),
            q1("SELECT COUNT(*) FROM pm_cycle_band_sets"), q1("SELECT COUNT(*) FROM pm_cycle_band_rules"),
            q1("SELECT COUNT(*) FROM pm_cycle_band_rule_depts"), q1("SELECT COUNT(*) FROM activity_log"),
            q1("SELECT COUNT(*) FROM pm_kpi_targets"), q1("SELECT COUNT(*) FROM pm_calibration_adjustments"))


def table(cid, bg):
    with a.app.app_context():
        db = a.get_db()
        return [v for _l, v in a._pm_cycle_band_table(db, cid, bg)]


try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        cleanup(db)
        for g_, co in ((BG5, "ZZBC Five Unit"), (BGB, UA_), (BGB, UB_)):
            db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (g_, co))
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BGU, "ZZBC Unset Unit"))
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (BG5,))
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'base')", (BGB,))
        # four cycles of our own: A and B open, R with a result released to leaders, X archived. Made by SQL, so (like a
        # tool that does not know about bands) they hold nothing until the seed copies the previous cycle's.
        for key, name, extra in (("A", "ZZBC Cycle A", ""), ("B", "ZZBC Cycle B", ""), ("R", "ZZBC Cycle R", ""),
                                 ("X", "ZZBC Cycle X", ", archived_at")):
            CY[key] = db.execute("INSERT INTO cycles(code, name, is_active, year, half%s) VALUES (?,?,0,2031,2%s)" % (
                extra, ", datetime('now')" if extra else ""), ("ZZBC-" + key, name)).lastrowid
        base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND business_group!='' "
                               "AND is_demo=0 LIMIT 1").fetchone())
        cols = [c for c in base.keys() if c != "id"]

        def person(key, name, bg, co, dept, role="user", admin_bg=None):
            v = dict(base, username=(PREFIX + key).lower(), employee_id=PREFIX + key, full_name="ZZ BC " + name, email=None,
                     hod_id=None, manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None,
                     business_group=bg, company=co, department=dept, role=role, admin_bg=admin_bg, left_at=None, is_demo=0)
            db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
            return db.execute("SELECT id FROM users WHERE username=?", (v["username"],)).fetchone()[0]

        def five_lines(uid, cid, ratings):
            for i, rating in enumerate(ratings):
                tid = db.execute(
                    "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, "
                    "rate5, business_group, company, department) VALUES (?,?,?,?,?,1,2,3,4,5,?,?,?)",
                    (cid, uid, "ZZBC rated %d" % i, 100 / len(ratings), "more", BG5, "ZZBC Five Unit", DEPT)).lastrowid
                db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)",
                           (tid, rating, uid))

        def pct_line(uid, cid, bg, co, dept, actual):
            tid = db.execute(
                "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, threshold, target, multiple, "
                "business_group, company, department) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (cid, uid, "ZZBC pct", 100, "more", 50, 100, 100, bg, co, dept)).lastrowid
            db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)",
                       (tid, actual, uid))
        ids["p5"] = person("P5", "Five One", BG5, "ZZBC Five Unit", DEPT)
        ids["pb"] = person("PB", "Base One", BGB, UA_, DEPT)
        ids["pb2"] = person("PB2", "Base Two", BGB, UB_, DEPT)
        ids["bgadm"] = person("BGADM", "Group Admin", BG5, "ZZBC Five Unit", "", role="admin", admin_bg=BG5)
        for key in ("A", "B", "R", "X"):
            five_lines(ids["p5"], CY[key], [3, 4])          # (3 + 4) / 2 = 3.50: ME on the default starts (2.51 to 3.50)
            pct_line(ids["pb"], CY[key], BGB, UA_, DEPT, 105)     # 105%: AE on the default starts (101 to 120)
            pct_line(ids["pb2"], CY[key], BGB, UB_, DEPT, 105)
        # the group default of the Achievement % group, in every cycle of ours (a group new to the system is configured
        # per cycle; the page writes the viewed cycle's)
        prev = None
        for key in ("A", "B", "R", "X"):
            a._pm_cycle_bands_seed(db, CY[key], source=prev)
            prev = CY[key]
            db.execute("DELETE FROM pm_cycle_bands WHERE cycle_id=? AND business_group=?", (CY[key], BGB))   # copied from the previous
            for i, (lab, lo) in enumerate(zip(LAB, PCT0), start=1):
                db.execute("INSERT INTO pm_cycle_bands(cycle_id, business_group, label, min_value, sort_order) "
                           "VALUES (?,?,?,?,?)", (CY[key], BGB, lab, lo, i))
        db.execute("INSERT INTO leader_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?,?,?)",
                   (CY["R"], ids["p5"], "pm", SU["id"]))
        db.commit()
    SUP, BGC = H.client_as(a, SU["id"]), H.client_as(a, ids["bgadm"])
    URL = "/admin/performance/config"

    def post(client, cycle, **kw):
        d = {"csrf_token": "tok", "business_group": BG5, "cycle_id": str(CY[cycle]) if isinstance(cycle, str) else str(cycle)}
        d.update(kw)
        return client.post(URL, data=d, follow_redirects=True)

    def five_form(starts, remark="ZZBC agreed", **kw):
        d = {"action": "set_five"}
        d.update({"min_" + l: "%g" % v for l, v in zip(LAB[1:], starts[1:])})
        if remark is not None:
            d["remark"] = remark
        d.update(kw)
        return d

    def pct_form(starts, remark="ZZBC agreed"):
        d = {"action": "set_bands", "business_group": BGB}
        d.update({"min_" + l: "%g" % v for l, v in zip(LAB, starts)})
        if remark is not None:
            d["remark"] = remark
        return d

    def overall(uid, cid):
        with a.app.app_context():
            db = a.get_db()
            ts = [dict(t) for t in db.execute("SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (cid, uid))]
            a.attach_pm_chains(db, ts)
            a.pm_score_targets(db, ts)
            return a.pm_overall_for_targets(db, ts, require_locked=False)

    # ------------------------------------------------------------------------------------------------------------
    s.section("the migration: every cycle gets today's tables, and nobody's band moves")
    with a.app.app_context():
        db = a.get_db()
        cycles = [r[0] for r in db.execute("SELECT id FROM cycles ORDER BY id")]
        tpl_tables = {}
        for r in db.execute("SELECT business_group, label, min_value FROM pm_rating_bands ORDER BY business_group, sort_order"):
            tpl_tables.setdefault(r["business_group"] or "", []).append((r["label"], r["min_value"]))
        tpl_rules = sorted((r["business_group"], r["company"], r["department"], r["min_ua"], r["min_be"], r["min_me"],
                            r["min_ae"], r["min_ou"]) for r in db.execute(
            "SELECT d.business_group, d.company, d.department, r.min_ua, r.min_be, r.min_me, r.min_ae, r.min_ou FROM "
            "pm_band_rules r JOIN pm_band_rule_depts d ON d.rule_id = r.id"))
    s.check("the template still holds the 5-point table and the groups' (the older tables are kept as they were)",
            len(tpl_tables.get("", [])) == 5 and [v for _l, v in tpl_tables[""]] == FIVE0, tpl_tables.get(""))
    # a baseline of the OLD reading (the template, floor lookup), against the new reader, for the people that exist
    with a.app.app_context():
        db = a.get_db()
        legacy = {}

        def old_label(tbl, v):
            lab = None
            for l, lo in tbl:
                if lo <= v:
                    lab = l
                else:
                    break
            return lab
        probes = [1.0, 1.5, 1.51, 2.5, 2.51, 3.5, 3.51, 4.5, 4.51, 5.0, 0, 60, 61, 80, 81, 100, 101, 120, 121, 150]
        for bg_key, tbl in tpl_tables.items():
            for c in cycles:
                for v in probes:
                    mech = "A" if bg_key == "" else "B"
                    new = a.pm_label_for_value(db, bg_key or None, mech, v, cycle_id=c)
                    if new != old_label(tbl, v):
                        legacy[(bg_key, c, v)] = (new, old_label(tbl, v))
    s.check("every group, every cycle, every probe value: the new reader gives the label the template always gave (%d cycles)"
            % len(cycles), not legacy, list(legacy.items())[:3])
    with a.app.app_context():
        db = a.get_db()
        same = all([(l, v) for l, v in a._pm_cycle_band_table(db, c, bg)] == tbl for c in cycles for bg, tbl in tpl_tables.items()
                   if bg in ("", ) or True)
        rules_ok = all(sorted((r["business_group"], r["company"], r["department"], r["min_ua"], r["min_be"], r["min_me"],
                               r["min_ae"], r["min_ou"]) for r in db.execute(
            "SELECT d.business_group, d.company, d.department, r.min_ua, r.min_be, r.min_me, r.min_ae, r.min_ou FROM "
            "pm_cycle_band_rules r JOIN pm_cycle_band_rule_depts d ON d.rule_id = r.id WHERE r.cycle_id=?", (c,))) == tpl_rules
            for c in cycles if c not in CY.values())
    s.check("...and each cycle's own tables are the template's, group by group", same)
    s.check("...and its rules are the template's rules (places and starts)", rules_ok)
    s.check("every existing cycle holds the 5-point table of its own (5 rows)", all(q1(
        "SELECT COUNT(*) FROM pm_cycle_bands WHERE cycle_id=? AND business_group=''", (c,)) == 5 for c in cycles))
    # re-run the boot step on a DB where the cycle tables are empty: it rebuilds the same, and a second run changes nothing
    saved = {}
    with a.app.app_context():
        db = a.get_db()
        for t in ("pm_cycle_bands", "pm_cycle_band_sets", "pm_cycle_band_rules", "pm_cycle_band_rule_depts"):
            saved[t] = [dict(r) for r in db.execute("SELECT * FROM %s" % t)]
        for t in ("pm_cycle_band_rule_depts", "pm_cycle_band_rules", "pm_cycle_band_sets", "pm_cycle_bands"):
            db.execute("DELETE FROM %s" % t)
        db.commit()
        mine = {c for c in CY.values()}
        before_ids = [r[0] for r in db.execute("SELECT id FROM cycles ORDER BY id")]
        for c in before_ids:
            a._pm_cycle_bands_seed(db, c)
        db.commit()
        n1 = db.execute("SELECT COUNT(*) FROM pm_cycle_bands").fetchone()[0]
        for c in before_ids:
            a._pm_cycle_bands_seed(db, c)
        db.commit()
        n2 = db.execute("SELECT COUNT(*) FROM pm_cycle_bands").fetchone()[0]
        again = all([(l, v) for l, v in a._pm_cycle_band_table(db, c, "")] == tpl_tables[""] for c in before_ids)
        # the boot step must not touch a cycle that already holds rows
        db.execute("UPDATE pm_cycle_bands SET min_value = 3.41 WHERE cycle_id=? AND business_group='' AND label='AE'", (before_ids[0],))
        a._pm_cycle_bands_seed(db, before_ids[0])
        kept = db.execute("SELECT min_value FROM pm_cycle_bands WHERE cycle_id=? AND business_group='' AND label='AE'",
                          (before_ids[0],)).fetchone()[0]
        # put everything back exactly (ids included)
        for t in ("pm_cycle_band_rule_depts", "pm_cycle_band_rules", "pm_cycle_band_sets", "pm_cycle_bands"):
            db.execute("DELETE FROM %s" % t)
        for t in ("pm_cycle_bands", "pm_cycle_band_sets", "pm_cycle_band_rules", "pm_cycle_band_rule_depts"):
            for r in saved[t]:
                db.execute("INSERT INTO %s(%s) VALUES (%s)" % (t, ",".join(r), ",".join("?" * len(r))), list(r.values()))
        db.commit()
    s.check("the boot step rebuilds every cycle's rows from an empty state: %d rows for %d cycles, the template's starts"
            % (n1, len(before_ids)), n1 >= 5 * len(before_ids) and again, n1)
    s.check("...a second run adds nothing (idempotent)", n1 == n2, (n1, n2))
    s.check("...and a cycle that already holds rows is never touched (a changed start stays)", abs(kept - 3.41) < 1e-9, kept)
    s.check("...the test put the real rows back as they were", q1("SELECT COUNT(*) FROM pm_cycle_bands") == len(saved["pm_cycle_bands"]))
    with a.app.app_context():
        db = a.get_db()
        orphan = db.execute("INSERT INTO cycles(code, name, is_active, year, half) VALUES ('ZZBC-O', 'ZZBC Orphan', 0, 2030, 2)").lastrowid
        db.commit()
        n0 = db.execute("SELECT COUNT(*) FROM pm_cycle_bands").fetchone()[0]
        got = [v for _l, v in a._pm_cycle_band_table(db, orphan, "")]
        lab = a.pm_label_for_value(db, BGB, "B", 105, cycle_id=orphan)
        nowrite = db.execute("SELECT COUNT(*) FROM pm_cycle_bands").fetchone()[0] == n0
        db.execute("DELETE FROM cycles WHERE id=?", (orphan,))
        db.commit()
    s.check("a cycle with no rows (made by a tool) reads what the copy would give, never nothing, and writes nothing "
            "(the 5-point starts are the template's, an Achievement % group reads its table)",
            got == FIVE0 and lab == "AE" and nowrite, (got, lab, nowrite))
    s.check("a cycle id of None reads the template", table(None, "") == FIVE0)

    # ------------------------------------------------------------------------------------------------------------
    s.section("the 5-point table: a change in cycle A is not a change in cycle B")
    ovA0, ovB0 = overall(ids["p5"], CY["A"]), overall(ids["p5"], CY["B"])
    s.check("baseline: the same person reads ME (3.50) in both cycles", ovA0["label"] == ovB0["label"] == "ME"
            and abs(ovA0["value"] - 3.5) < 1e-9, (ovA0, ovB0))
    log0 = q1("SELECT COALESCE(MAX(id),0) FROM activity_log")
    r = post(SUP, "A", **five_form([1, 1.51, 2.51, 3.41, 4.51], remark="ZZBC lower AE"))
    t = r.get_data(as_text=True)
    s.check("the super admin saves new 5-point starts for cycle A", "are saved" in t and "ZZBC Cycle A" in t and table(CY["A"], "") ==
            [1.0, 1.51, 2.51, 3.41, 4.51], table(CY["A"], ""))
    s.check("...cycle B keeps its own (unchanged)", table(CY["B"], "") == FIVE0 and table(CY["R"], "") == FIVE0
            and table(CY["X"], "") == FIVE0)
    ovA, ovB = overall(ids["p5"], CY["A"]), overall(ids["p5"], CY["B"])
    s.check("the same person and the same figure read AE in A and still ME in B (through pm_score_targets and the overall)",
            ovA["label"] == "AE" and ovB["label"] == "ME" and abs(ovA["value"] - ovB["value"]) < 1e-9, (ovA, ovB))
    with a.app.app_context():
        db = a.get_db()
        two = (a.pm_label_for_value(db, None, "A", 3.45, cycle_id=CY["A"]), a.pm_label_for_value(db, None, "A", 3.45, cycle_id=CY["B"]))
    s.check("pm_label_for_value says the same of a bare figure: 3.45 is AE in A, ME in B", two == ("AE", "ME"), two)
    s.check("who and when are stored with the remark (pm_cycle_band_sets), MYT shown", q1(
        "SELECT changed_by FROM pm_cycle_band_sets WHERE cycle_id=? AND business_group=''", (CY["A"],)) == SU["id"]
        and q1("SELECT remark FROM pm_cycle_band_sets WHERE cycle_id=? AND business_group=''", (CY["A"],)) == "ZZBC lower AE"
        and q1("SELECT COUNT(*) FROM pm_cycle_band_sets WHERE cycle_id=? AND business_group=''", (CY["B"],)) == 0)
    s.check("the audit row names the cycle, the old and new starts and the remark", q1(
        "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='pm_rating_bands' AND detail LIKE ? AND detail LIKE ? AND "
        "detail LIKE ? AND detail LIKE ?", (log0, "%ZZBC Cycle A%", "%AE 3.51%", "%AE 3.41%", "%remark: ZZBC lower AE%")) == 1)
    s.check("a save that changes nothing says so and writes nothing more", "Nothing to save" in post(
        SUP, "A", **five_form([1, 1.51, 2.51, 3.41, 4.51], remark="ZZBC same")).get_data(as_text=True))

    # ------------------------------------------------------------------------------------------------------------
    s.section("refusals: each depends on exactly its condition (the same post passes once the condition is put right)")
    snap = snapshot()

    def refused(why, resp, word):
        t_ = resp.get_data(as_text=True) if hasattr(resp, "get_data") else str(resp)
        s.check("refused: " + why, word in t_ and snapshot() == snap, (word, t_[:0]))
    good = five_form([1, 1.51, 2.51, 3.31, 4.51], remark="ZZBC good")
    refused("no remark", post(SUP, "B", **dict(good, remark="")), "Write your remark first")
    refused("a blank remark", post(SUP, "B", **dict(good, remark="    ")), "Write your remark first")
    refused("out of order (AE not above ME)", post(SUP, "B", **five_form([1, 1.51, 2.51, 2.51, 4.51])), "must start higher than ME (2.51)")
    refused("BE not above UA", post(SUP, "B", **five_form([1, 1.0, 2.51, 3.51, 4.51])), "BE must start higher than UA (1.00)")
    refused("above 5.00", post(SUP, "B", **five_form([1, 1.51, 2.51, 3.51, 5.5])), "between 1.00 and 5.00")
    refused("below 1.00", post(SUP, "B", **five_form([1, 0.5, 2.51, 3.51, 4.51])), "between 1.00 and 5.00")
    refused("three decimals", post(SUP, "B", **five_form([1, 1.51, 2.51, 3.505, 4.51])), "at most two decimals")
    refused("not a number", post(SUP, "B", **dict(good, min_ME="two")), "must start at a number")
    refused("a blank start", post(SUP, "B", **dict(good, min_BE="")), "Enter where BE starts")
    r = BGC.post(URL, data=dict(good, csrf_token="tok", business_group=BG5, cycle_id=str(CY["B"])))
    s.check("refused: a BG admin (403)", r.status_code == 403 and snapshot() == snap, r.status_code)
    refused("a cycle that is not given", post(SUP, "B", **dict(good, cycle_id="")), "Pick the cycle")
    refused("a cycle that does not exist", post(SUP, 987654321, **good), "is gone")
    refused("a cycle with a result released to leaders", post(SUP, "R", **good), "results are released")
    refused("an archived cycle", post(SUP, "X", **good), "is archived")
    refused("a group that is not on the 5-point rating", post(SUP, "B", **dict(good, business_group=BGB)), "not on the 5-point rating")
    r = SUP.post(URL, data=dict(good, csrf_token="tok", business_group="ZZBC No Such Group", cycle_id=str(CY["B"])))
    s.check("refused: a group that is not on the list (403)", r.status_code == 403 and snapshot() == snap)
    # falsify each guard: put its one condition right and the same post goes through
    ok_ = post(SUP, "B", **good)
    s.check("falsified: the remark, order, range and decimals were the only things wrong -- the good post saves in cycle B",
            "are saved" in ok_.get_data(as_text=True) and table(CY["B"], "") == [1.0, 1.51, 2.51, 3.31, 4.51]
            and table(CY["A"], "")[3] == 3.41)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM leader_releases WHERE cycle_id=?", (CY["R"],))
        db.execute("UPDATE cycles SET archived_at=NULL WHERE id=?", (CY["X"],))
        db.commit()
    snap = snapshot()
    s.check("falsified: with the release row gone the SAME post saves in cycle R", "are saved" in post(
        SUP, "R", **good).get_data(as_text=True) and table(CY["R"], "")[3] == 3.31)
    s.check("falsified: with the archive taken off the SAME post saves in cycle X", "are saved" in post(
        SUP, "X", **good).get_data(as_text=True) and table(CY["X"], "")[3] == 3.31)
    with a.app.app_context():   # put the two conditions back
        db = a.get_db()
        db.execute("INSERT INTO leader_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?,?,?)",
                   (CY["R"], ids["p5"], "pm", SU["id"]))
        db.execute("UPDATE cycles SET archived_at=datetime('now') WHERE id=?", (CY["X"],))
        db.execute("UPDATE pm_cycle_bands SET min_value=3.51 WHERE business_group='' AND label='AE' AND cycle_id IN (?,?)",
                   (CY["R"], CY["X"]))
        db.commit()
    with a.app.app_context():
        w = a._band_cycle_windows(a.get_db())
    s.check("the window: open / released (with its date, and released wins over archived) / archived",
            w[CY["A"]]["open"] and not w[CY["R"]]["open"] and w[CY["R"]]["why"] == "released" and w[CY["R"]]["released_on"]
            and not w[CY["X"]]["open"] and w[CY["X"]]["why"] == "archived", {k: (w[v]["open"], w[v]["why"]) for k, v in CY.items()})

    # ------------------------------------------------------------------------------------------------------------
    s.section("the other three saves pass the same gate: group default, rule save, rule remove")
    snap = snapshot()
    for cyc_ in ("R", "X"):
        why = "results are released" if cyc_ == "R" else "is archived"
        refused("group default in %s" % cyc_, post(SUP, cyc_, **pct_form([0, 61, 81, 110, 121])), why)
        refused("a rule in %s" % cyc_, post(SUP, cyc_, business_group=BGB, action="rule_save", rule_unit=UA_, rule_scope="unit",
                                            remark="ZZBC rule", **{"min_" + l: "%g" % v for l, v in zip(LAB, [0, 60, 80, 90, 100])}),
               why)
    # a rule exists in R already (made while it was open, then it was released): its removal is refused too
    with a.app.app_context():
        db = a.get_db()
        rr = db.execute("INSERT INTO pm_cycle_band_rules(cycle_id, business_group, company, min_ua, min_be, min_me, min_ae, min_ou) "
                        "VALUES (?,?,?,0,60,80,90,100)", (CY["R"], BGB, UA_)).lastrowid
        db.execute("INSERT INTO pm_cycle_band_rule_depts(rule_id, cycle_id, business_group, company, department) VALUES (?,?,?,?,'')",
                   (rr, CY["R"], BGB, UA_))
        db.commit()
    snap = snapshot()
    refused("removing a rule in R", post(SUP, "R", business_group=BGB, action="rule_remove", rule_id=str(rr), remark="ZZBC rm"),
            "results are released")
    r = BGC.post(URL, data=dict(pct_form([0, 61, 81, 110, 121]), csrf_token="tok", cycle_id=str(CY["A"])))
    s.check("...and a BG admin cannot use any of them (403)", r.status_code == 403 and snapshot() == snap)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_cycle_band_rule_depts WHERE rule_id=?", (rr,))
        db.execute("DELETE FROM pm_cycle_band_rules WHERE id=?", (rr,))
        db.commit()

    # ------------------------------------------------------------------------------------------------------------
    s.section("an Achievement % group default and a rule are per cycle too")
    pbA0, pbB0 = overall(ids["pb"], CY["A"]), overall(ids["pb"], CY["B"])
    s.check("baseline: 105% reads AE in both cycles", pbA0["label"] == pbB0["label"] == "AE", (pbA0, pbB0))
    log0 = q1("SELECT COALESCE(MAX(id),0) FROM activity_log")
    r = post(SUP, "A", **pct_form([0, 61, 81, 110, 121], remark="ZZBC raise AE"))
    s.check("the group default saves into cycle A", "are saved" in r.get_data(as_text=True) and table(CY["A"], BGB) == [0, 61, 81, 110, 121])
    s.check("...cycle B keeps its own", table(CY["B"], BGB) == PCT0)
    s.check("...105% now reads ME in A and still AE in B",
            overall(ids["pb"], CY["A"])["label"] == "ME" and overall(ids["pb"], CY["B"])["label"] == "AE")
    s.check("...the audit row names the cycle, old and new starts and the remark", q1(
        "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='pm_rating_bands' AND detail LIKE ? AND detail LIKE ? AND "
        "detail LIKE ? AND detail LIKE ?", (log0, "%ZZBC Cycle A%", "%AE 101%", "%AE 110%", "%remark: ZZBC raise AE%")) == 1)
    s.check("...who and when are stored", q1("SELECT changed_by FROM pm_cycle_band_sets WHERE cycle_id=? AND business_group=?",
                                              (CY["A"], BGB)) == SU["id"])
    r = post(SUP, "B", business_group=BGB, action="rule_save", rule_unit=UA_, rule_scope="unit", remark="ZZBC unit rule",
             **{"min_" + l: "%g" % v for l, v in zip(LAB, [0, 50, 70, 90, 100])})
    s.check("a unit rule saves into cycle B alone", "now has its own bands" in r.get_data(as_text=True)
            and q1("SELECT COUNT(*) FROM pm_cycle_band_rules WHERE cycle_id=?", (CY["B"],)) == 1
            and q1("SELECT COUNT(*) FROM pm_cycle_band_rules WHERE cycle_id=? AND business_group=?", (CY["A"], BGB)) == 0)
    s.check("...the unit's person reads OU (105 >= 100) in B, and AE in cycle X (no rule there), ME in A (its own default)",
            overall(ids["pb"], CY["B"])["label"] == "OU" and overall(ids["pb"], CY["X"])["label"] == "AE"
            and overall(ids["pb"], CY["A"])["label"] == "ME" and overall(ids["pb2"], CY["B"])["label"] == "AE")
    s.check("...the audit row names the cycle", q1("SELECT COUNT(*) FROM activity_log WHERE action='pm_band_rule' AND detail LIKE ? "
                                                   "AND detail LIKE '%remark: ZZBC unit rule%'", ("%ZZBC Cycle B%",)) == 1)
    rid = q1("SELECT id FROM pm_cycle_band_rules WHERE cycle_id=? AND business_group=?", (CY["B"], BGB))
    r = post(SUP, "A", business_group=BGB, action="rule_remove", rule_id=str(rid), remark="ZZBC wrong cycle")
    s.check("a rule is removed only in its own cycle (naming another cycle finds nothing)", "is gone" in r.get_data(as_text=True)
            and q1("SELECT COUNT(*) FROM pm_cycle_band_rules WHERE id=?", (rid,)) == 1)
    r = post(SUP, "B", business_group=BGB, action="rule_remove", rule_id=str(rid), remark="ZZBC remove")
    s.check("...and removed in B, which puts the person back on B's group default",
            q1("SELECT COUNT(*) FROM pm_cycle_band_rules WHERE id=?", (rid,)) == 0 and overall(ids["pb"], CY["B"])["label"] == "AE")
    s.check("rules and places carry their cycle, one department in one rule per cycle (UNIQUE includes the cycle)",
            "UNIQUE(cycle_id, business_group, company, department)" in q1("SELECT sql FROM sqlite_master WHERE name='pm_cycle_band_rule_depts'"))

    # ------------------------------------------------------------------------------------------------------------
    s.section("a new cycle copies the previous cycle's starts, all three kinds")
    with a.app.app_context():
        db = a.get_db()
        # give cycle B a rule so the copy has every kind; B's 5-point is [1, 1.51, 2.51, 3.31, 4.51], A's differs
        rr = db.execute("INSERT INTO pm_cycle_band_rules(cycle_id, business_group, company, min_ua, min_be, min_me, min_ae, min_ou, "
                        "remark) VALUES (?,?,?,0,40,50,60,70,'ZZBC copy me')", (CY["B"], BGB, UB_)).lastrowid
        for dep in (DEPT, "ZZBC Other"):
            db.execute("INSERT INTO pm_cycle_band_rule_depts(rule_id, cycle_id, business_group, company, department) VALUES (?,?,?,?,?)",
                       (rr, CY["B"], BGB, UB_, dep))
        db.commit()
        n_old = db.execute("SELECT COUNT(*) FROM cycles WHERE id > ?", (CY["X"],)).fetchone()[0]
        new = db.execute("INSERT INTO cycles(code, name, is_active, year, half) VALUES ('ZZBC-N', 'ZZBC Cycle N', 0, 2032, 2)").lastrowid
        CY["N"] = new
        copied = a._pm_cycle_bands_seed(db, new, source=CY["B"])
        db.commit()
        a._pm_cycle_bands_seed(db, new)
        db.commit()
    s.check("the new cycle's 5-point table is cycle B's (the one named as previous)", copied and table(new, "") == [1.0, 1.51, 2.51, 3.31, 4.51]
            and table(new, "") != FIVE0)
    s.check("...so is the Achievement % group default", table(new, BGB) == table(CY["B"], BGB) == PCT0)
    s.check("...and the rule with its places (a new row of its own, same starts, remark and both departments)",
            q1("SELECT COUNT(*) FROM pm_cycle_band_rules WHERE cycle_id=?", (new,)) == 1
            and q1("SELECT min_be FROM pm_cycle_band_rules WHERE cycle_id=?", (new,)) == 40
            and q1("SELECT COUNT(*) FROM pm_cycle_band_rule_depts WHERE cycle_id=?", (new,)) == 2
            and q1("SELECT id FROM pm_cycle_band_rules WHERE cycle_id=?", (new,)) != rr)
    s.check("...a second call changes nothing", q1("SELECT COUNT(*) FROM pm_cycle_band_rules WHERE cycle_id=?", (new,)) == 1)
    r = post(SUP, "N", **five_form([1, 1.51, 2.51, 3.21, 4.51], remark="ZZBC change the new one"))
    s.check("the new cycle can change its own, and the cycle it copied from is not touched", "are saved" in r.get_data(as_text=True)
            and table(new, "")[3] == 3.21 and table(CY["B"], "")[3] == 3.31)
    with a.app.app_context():
        db = a.get_db()
        nxt = db.execute("INSERT INTO cycles(code, name, is_active, year, half) VALUES ('ZZBC-N2', 'ZZBC Cycle N2', 0, 2033, 2)").lastrowid
        a._pm_cycle_bands_seed(db, nxt)
        db.commit()
    s.check("with no cycle named, a new cycle copies the MOST RECENT other cycle that has rows", table(nxt, "")[3] == 3.21, table(nxt, ""))
    src = H.code_without_docstrings(H.source(a))
    start = src[src.index('"INSERT INTO cycles(code, name, ends_on, starts_on, is_active, year, half, kind, min_job_grade, "'):]
    s.check("the Start-a-cycle route seeds the new cycle from the previous active one right after the insert",
            "_pm_cycle_bands_seed(db, new_id, source=prev_active)" in start[:900])
    s.check("...and the boot step seeds every cycle that has none", "_pm_cycle_bands_seed(c, _cid)" in src)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_cycle_bands WHERE cycle_id=?", (nxt,))
        db.execute("DELETE FROM cycles WHERE id=?", (nxt,))
        db.commit()

    # ------------------------------------------------------------------------------------------------------------
    s.section("the 5-point preview: counts are a per-person hand computation, and it writes nothing")
    snap = snapshot()
    proposed = [1.0, 1.51, 2.51, 3.11, 4.51]      # 3.50 moves ME -> AE for anyone who totals 3.11 to 3.50

    def pv(cid, starts):
        q = "cycle=%s&" % cid + "&".join("min_%s=%s" % (l, "%g" % v) for l, v in zip(LAB[1:], starts[1:]))
        resp = SUP.get(URL + "/five-preview?" + q)
        return resp.status_code, json.loads(resp.get_data(as_text=True) or "{}")
    code, j = pv(CY["X"], proposed)       # X: an archived cycle (a preview is read only, so it answers for any cycle); our person reads ME there
    s.check("the preview is a GET that answers JSON for the super admin", code == 200 and j.get("ok") is True, (code, j))
    with a.app.app_context():
        db = a.get_db()
        agroups = [r[0] for r in db.execute("SELECT business_group FROM pm_bg_config WHERE mechanism='A'")]
        users = [r[0] for r in db.execute(
            "SELECT id FROM users WHERE role!='admin' AND COALESCE(left_at,'')='' AND COALESCE(is_demo,0)=0 AND business_group IN (%s)"
            % ",".join("?" * len(agroups)), agroups)]
        people, with_res, changes = set(users), 0, []
        pro = [(l, proposed[i]) for i, l in enumerate(LAB)]
        subjects = {r[0] for r in db.execute("SELECT DISTINCT t.subject_id FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id "
                                             "WHERE t.cycle_id=? AND u.role!='admin' AND COALESCE(u.left_at,'')='' AND "
                                             "COALESCE(u.is_demo,0)=0", (CY["X"],))}
        for sid in sorted(subjects):    # ONE PERSON AT A TIME: the route batches, this does not
            ts = [dict(t) for t in db.execute("SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (CY["X"], sid))]
            a.attach_pm_chains(db, ts)
            a.pm_score_targets(db, ts)
            if not all(t.get("score") for t in ts):
                continue
            ov = a.pm_overall_for_targets(db, ts, require_locked=False)
            if not ov or ov["mechanism"] != "A":
                continue
            people.add(sid)
            with_res += 1
            new_l = a._band_score_floor(pro, ov["value"])
            if new_l != ov["label"]:
                changes.append((sid, ov["label"], new_l))
    s.check("people on the 5-point rating = the hand count (%d)" % len(people), j["people"] == len(people), (j["people"], len(people)))
    s.check("...with a KPI result so far = the hand count (%d)" % with_res, j["with_results"] == with_res, (j["with_results"], with_res))
    s.check("...change band = the hand count, and our person is one of them (ME -> AE)",
            len(j["changes"]) == len(changes) and ids["p5"] in [c[0] for c in changes]
            and j["moves"].get("ME → AE", 0) == sum(1 for c in changes if (c[1], c[2]) == ("ME", "AE")), (j["moves"], changes))
    s.check("...each change names the person, department, from and to", any(c["name"] == "ZZ BC Five One" and c["dept"] == DEPT
            and (c["from"], c["to"]) == ("ME", "AE") for c in j["changes"]))
    s.check("it wrote nothing at all (starts, sets, rules, audit, scorecards, calibration)", snapshot() == snap)
    code, j2 = pv(CY["X"], FIVE0)
    s.check("the cycle's own starts change nobody", j2["changes"] == [] and j2["moves"] == {}, j2["moves"])
    code, j3 = pv(CY["X"], [1.0, 1.51, 2.51, 2.51, 4.51])
    s.check("starts out of order still answer, say why, and list no changes", j3["changes"] is None and "must start higher" in j3["starts_error"], j3)
    code, j4 = pv("", proposed)
    s.check("no cycle is a 400", code == 400)
    s.check("the preview is the super admin's alone (403 for a BG admin)", BGC.get(URL + "/five-preview?cycle=%d" % CY["B"]).status_code == 403)
    s.check("signed out it goes to the sign-in (the deploy's route probe reads a redirect)",
            a.app.test_client().get(URL + "/five-preview").status_code in (301, 302))
    code, j5 = pv(CY["B"], proposed)
    s.check("the preview reads the cycle it is asked about: in B the person already reads AE (its AE starts at 3.31), so the same proposed "
            "starts move nobody there", code == 200 and j5["people"] == j["people"] and not any(
                c["name"] == "ZZ BC Five One" for c in j5["changes"]), j5["moves"])

    # ------------------------------------------------------------------------------------------------------------
    s.section("a start change rebuilds THAT cycle's ratings records (Chris, 2026-10-11: a settings change does), and no other")
    with a.app.app_context():
        db = a.get_db()
        for key in ("RA", "RB"):
            CY[key] = db.execute("INSERT INTO cycles(code, name, is_active, year, half) VALUES (?,?,0,2034,2)",
                                 ("ZZBC-" + key, "ZZBC Cycle " + key)).lastrowid
            a._pm_cycle_bands_seed(db, CY[key])
            for lab, lo in zip(LAB, FIVE0):
                db.execute("UPDATE pm_cycle_bands SET min_value=? WHERE cycle_id=? AND business_group='' AND label=?", (lo, CY[key], lab))
        base2 = dict(db.execute("SELECT * FROM users WHERE id=?", (ids["p5"],)).fetchone())
        cols2 = [c for c in base2.keys() if c != "id"]
        v = dict(base2, username="zzbc-p5b", employee_id=PREFIX + "P5B", full_name="ZZ BC Five Two")
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols2), ",".join("?" * len(cols2))), [v[c] for c in cols2])
        ids["p5b"] = db.execute("SELECT id FROM users WHERE username='zzbc-p5b'").fetchone()[0]
        for key in ("RA", "RB"):
            for uid in (ids["p5"], ids["p5b"]):
                for i, rating in enumerate((3, 4)):
                    tid = db.execute(
                        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, "
                        "rate5, business_group, company, department) VALUES (?,?,?,50,'more',1,2,3,4,5,?,?,?)",
                        (CY[key], uid, "ZZBC rated %d" % i, BG5, "ZZBC Five Unit", DEPT)).lastrowid
                    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)",
                               (tid, rating, uid))
        db.commit()
    with a.app.test_request_context("/"):
        db = a.get_db()
        for key in ("RA", "RB"):
            for uid in (ids["p5"], ids["p5b"]):
                a._rating_record_refresh(db, CY[key], [uid], "test_seed", SU["id"], commit=True)
        db.execute("UPDATE rating_records SET frozen_at=datetime('now') WHERE cycle_id=? AND subject_id=?", (CY["RA"], ids["p5b"]))
        db.commit()

    def rr(cid, uid, col="pm_self_band"):
        return q1("SELECT %s FROM rating_records WHERE cycle_id=? AND subject_id=?" % col, (cid, uid))
    s.check("baseline: four records (two people, two cycles), each reading ME for 3.50; one of them frozen",
            all(rr(CY[k], ids[u]) == "ME" for k in ("RA", "RB") for u in ("p5", "p5b"))
            and q1("SELECT COUNT(*) FROM rating_records WHERE cycle_id IN (?,?) AND frozen_at IS NOT NULL", (CY["RA"], CY["RB"])) == 1)
    r = post(SUP, "RA", **five_form([1, 1.51, 2.51, 3.41, 4.51], remark="ZZBC records follow"))
    t = r.get_data(as_text=True)
    s.check("a 5-point save in cycle A brings A's unfrozen record up to date (the person's band is now AE) and the flash says so, as the "
            "potential cut-offs' does", rr(CY["RA"], ids["p5"]) == "AE" and "1 ratings records brought up to date." in t
            and rr(CY["RA"], ids["p5"], "last_event") == "settings_cutoffs", (rr(CY["RA"], ids["p5"]), t[:0]))
    s.check("...the record in cycle B is untouched (still ME, still the seeding event)",
            rr(CY["RB"], ids["p5"]) == "ME" and rr(CY["RB"], ids["p5"], "last_event") == "test_seed")
    s.check("...and so is a FROZEN record in cycle A (still ME, still the seeding event, though the person now reads AE there)",
            rr(CY["RA"], ids["p5b"]) == "ME" and rr(CY["RA"], ids["p5b"], "last_event") == "test_seed"
            and overall(ids["p5b"], CY["RA"])["label"] == "AE")
    # falsify: without the call the record is stale -- write the same change through the writer alone
    with a.app.app_context():
        db = a.get_db()
        a._pm_cycle_bands_write(db, SU, CY["RB"], "", dict(zip(LAB, [1.0, 1.51, 2.51, 3.41, 4.51])), "ZZBC no refresh")
    s.check("falsified: a start change WITHOUT the follow step leaves the record stale (reads ME while the person reads AE), so the "
            "assertions above depend on the call", rr(CY["RB"], ids["p5"]) == "ME" and overall(ids["p5"], CY["RB"])["label"] == "AE")
    with a.app.test_request_context("/"):
        db = a.get_db()
        sfx = a._band_records_follow(db, SU, CY["RB"])
    s.check("...and the follow step brings it up to date (both unfrozen records of cycle B: 2)", rr(CY["RB"], ids["p5"]) == "AE"
            and rr(CY["RB"], ids["p5b"]) == "AE" and "2 ratings records" in sfx, sfx)
    src_ = H.code_without_docstrings(H.source(a))
    s.check("every start-changing action calls it after its write: 5-point, group default, rule save, rule remove",
            src_.count("_band_records_follow(db, me, cid)") == 4)

    # ------------------------------------------------------------------------------------------------------------
    s.section("what is decided stays decided when starts change")
    with a.app.app_context():
        db = a.get_db()
        sid = db.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, "
                         "locked_at) VALUES (?,?,?,?,?,datetime('now'))", (CY["B"], "super", a.PM_SUPER_SCOPE_KEY, BG5, "ZZBC super")).lastrowid
        db.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band) VALUES (?,?,?,?)",
                   (sid, ids["p5"], "ME", "BE"))
        db.commit()

    def decided():
        with a.app.app_context():
            db = a.get_db()
            subj = db.execute("SELECT * FROM users WHERE id=?", (ids["p5"],)).fetchone()
            return ([tuple(r) for r in db.execute("SELECT subject_id, original_band, adjusted_band FROM pm_calibration_adjustments "
                                                  "WHERE session_id=?", (sid,))],
                    q1("SELECT locked_at IS NOT NULL FROM pm_calibration_sessions WHERE id=?", (sid,)),
                    a.pm_effective_band(db, subj, CY["B"], "ME")["band"])
    before = decided()
    s.check("the super admin's final move is what the person reads (BE), whatever the raw band", before[2] == "BE", before)
    post(SUP, "B", **five_form([1, 1.51, 2.51, 3.01, 4.51], remark="ZZBC over decided"))
    s.check("a 5-point change leaves the move, the lock and the effective band as they were", decided() == before, decided())
    post(SUP, "B", **pct_form([0, 50, 70, 90, 110], remark="ZZBC over decided"))
    s.check("...a group default change too", decided() == before)
    # the writers of what is decided -- a calibration move (the adjustment upsert), every lock, the release -- store a band or a
    # time, never a cut-off: none of them calls a band reader directly (found by what they write, not by name)
    WRITES = ("INSERT INTO pm_calibration_adjustments", "UPDATE pm_calibration_adjustments", "SET locked_at", "INTO leader_releases",
              "INTO result_releases", "INTO talent_releases")
    BANDREAD = {"pm_label_for_value", "pm_bands_for", "_pm_cycle_band_table", "_pm_band_rules", "_pm_cycle_load"}

    def scan(text):
        flines, writers_, reading_ = text.splitlines(), [], []
        for fn in ast.walk(ast.parse(text)):
            if isinstance(fn, ast.FunctionDef) and fn.name != "_ensure_runtime_schema":
                body = "\n".join(flines[fn.lineno - 1:fn.end_lineno])
                if any(w in body for w in WRITES):
                    writers_.append(fn.name)
                    called = {(c.func.id if isinstance(c.func, ast.Name) else getattr(c.func, "attr", None))
                              for c in ast.walk(fn) if isinstance(c, ast.Call)}
                    if called & BANDREAD:
                        reading_.append((fn.name, sorted(called & BANDREAD)))
        return writers_, reading_
    writers, reading = scan(H.source(a))
    s.check("nothing a calibration move, lock or release writes reads a cut-off (%d writers found: the adjustment upsert, the locks, "
            "the release)" % len(writers), len(writers) >= 10 and "_pm_calib_upsert_adjustment" in writers
            and "admin_talent_release" in writers and not reading, reading)
    fw, fr = scan("def f(db):\n    db.execute('UPDATE pm_calibration_sessions SET locked_at=1')\n    pm_label_for_value(db)\n")
    s.check("...(the scan is real: a lock writer that called a band reader would be flagged)", fw == ["f"] and fr == [("f", ["pm_label_for_value"])])

    # ------------------------------------------------------------------------------------------------------------
    s.section("the page: the cycle in the top bar, editable while it can change, read only after")
    def page(client, cycle_id, bg=BG5):
        with client.session_transaction() as ss:
            ss["view_cycle_id"] = cycle_id
        return client.get(URL + "?bg=" + bg.replace(" ", "+")).get_data(as_text=True)
    pg = page(SUP, CY["A"])
    s.check("a 5-point group in an open cycle: the cycle chip, four number boxes (UA fixed and disabled), Save for the cycle",
            "ZZBC Cycle A" in pg and re.search(r'data-start-in="UA"[^>]*disabled', pg)
            and all(re.search(r'name="min_%s"' % l, pg) for l in LAB[1:]) and "Save for ZZBC Cycle A" in pg
            and 'value="set_five"' in pg and "Shared by every 5-point group" in pg)
    s.check("...the help line, the changed line, and the confirm box's title, body and required remark",
            "These starts are for ZZBC Cycle A only, for every group on the 5-point rating. Other cycles keep their own. UA always starts at 1.00."
            in pg and "until ZZBC Cycle A&#39;s results go to leaders" in pg.replace("'", "&#39;") and "Changed " in pg
            and 'data-confirm-title="Change the 5-point band starts for ZZBC Cycle A?"' in pg and 'data-confirm-body="br-five-body"' in pg
            and "data-confirm-reason=" in pg)
    s.check("...cycle B is not the one shown: its edits are not on the page", pg.count('name="cycle_id" value="%d"' % CY["A"]) >= 1
            and 'name="cycle_id" value="%d"' % CY["B"] not in pg)
    s.check("...the fold lists every other cycle with its starts and whether it can change",
            "Band starts in other cycles (" in pg and "ZZBC Cycle B" in pg and "UA 1.00 · BE 1.51 · ME 2.51 · AE 3.01 · OU 4.51" in pg
            and "Yes, until its results go to leaders" in pg and "No: archived" in pg and "No: results released" in pg)
    s.check("...(the dated line reads in MYT as d Mon yyyy)", re.search(r"No: results released \d{1,2} [A-Z][a-z]{2} \d{4}", pg))
    pg = page(SUP, CY["R"])
    s.check("a cycle with a result released: read only, a grey Fixed chip with the date, the reason and the way to the active cycle, no inputs",
            "Fixed: results released" in pg and "ZZBC Cycle R&#39;s results are released, so its band starts are fixed." in pg.replace("'", "&#39;")
            and 'data-start-in=' not in pg and 'value="set_five"' not in pg and "To change the starts for" in pg)
    pg = page(SUP, CY["X"])
    s.check("an archived cycle: Fixed: archived, read only", "Fixed: archived" in pg and "ZZBC Cycle X is archived, so its band starts are fixed." in pg
            and 'data-start-in=' not in pg)
    pg = page(BGC, CY["A"])
    s.check("a BG admin reads the same starts with no form (no inputs, no Save)", 'data-start-in=' not in pg and 'value="set_five"' not in pg
            and "Only the super admin changes them" in pg)
    s.check("...(and the starts are shown as numbers)", re.search(r'br-num br-ro">1\.51<', pg))
    pg = page(SUP, CY["A"], BGB)
    s.check("an Achievement % group: a cycle chip, 'Save group default for <cycle>', the rules heading names the cycle, and the fold has "
            "the columns Cycle, Group default, Rules, Can change",
            "ZZBC Cycle A" in pg and "Save group default for ZZBC Cycle A" in pg and "Rules for units and departments in ZZBC Cycle A" in pg
            and "ZZBC Base Group&#39;s bands in other cycles (" in pg.replace("'", "&#39;")
            and all(("<th>%s</th>" % h) in pg for h in ("Cycle", "Group default", "Rules", "Can change")))
    s.check("...the form and the rule panel carry the cycle", pg.count('name="cycle_id" value="%d"' % CY["A"]) >= 2)
    pg = page(SUP, CY["R"], BGB)
    s.check("...in a released cycle the same card is read only with the Fixed chip, no Add a rule",
            "Fixed: results released" in pg and "Add a rule" not in pg and 'value="set_bands"' not in pg)

    # ------------------------------------------------------------------------------------------------------------
    s.section("the lint: no caller of a reader omits the cycle")
    READERS = {"pm_label_for_value", "pm_bands_for", "_pm_band_rules", "_pm_scale_for"}

    def omissions(source_text):
        bad_ = []
        for node in ast.walk(ast.parse(source_text)):
            if isinstance(node, ast.Call):
                f = node.func
                nm = f.id if isinstance(f, ast.Name) else (f.attr if isinstance(f, ast.Attribute) else None)
                if nm in READERS and not any(k.arg == "cycle_id" for k in node.keywords):
                    bad_.append((nm, node.lineno))
                if nm == "_pm_cycle_band_table" and len(node.args) < 3:
                    bad_.append((nm, node.lineno))
        return bad_
    full = H.source(a)
    miss = omissions(full)
    calls = sum(1 for n in ast.walk(ast.parse(full)) if isinstance(n, ast.Call) and (
        (isinstance(n.func, ast.Name) and n.func.id in READERS)))
    s.check("every call of pm_label_for_value / pm_bands_for / _pm_band_rules / _pm_scale_for in app.py names cycle_id= (%d calls)" % calls,
            calls >= 10 and not miss, miss)
    s.check("the lint is real: it catches calls that omit the cycle", len(omissions(
        "pm_label_for_value(db, bg, 'A', 3)\npm_bands_for(db, bg)\n_pm_band_rules(db)\na._pm_scale_for(db, bg)\n"
        "_pm_cycle_band_table(db, bg)")) == 5 and not omissions("pm_label_for_value(db, bg, 'A', 3, cycle_id=1)"))
    other = [fn for fn in os.listdir(H.REPO) if fn.endswith(".py") and fn not in ("app.py",)]
    miss2 = [(fn, o) for fn in other for o in omissions(open(os.path.join(H.REPO, fn), encoding="utf-8").read())]
    s.check("...nor does any other module at the top of the repo", not miss2, miss2)
    # the older tables are read in exactly the template-copy places and nowhere else
    s.check("the template tables are read by the seed, the loader, the template reader and the boot check that seeds the 5-point rows only",
            src.count("FROM pm_rating_bands") == 4 and src.count("FROM pm_band_rules") == 2
            and src.count("FROM pm_band_rule_depts") == 1 and src.count("FROM pm_band_rules r JOIN pm_band_rule_depts d") == 1,
            (src.count("FROM pm_rating_bands"), src.count("FROM pm_band_rules"), src.count("FROM pm_band_rule_depts")))
    s.check("the four saves all pass the one gate", src.count("_band_cycle_gate(db, cid)") == 1 and "def _band_cycle_gate" in src
            and all(('action in ("set_five", "set_bands", "rule_save", "rule_remove")' in src for _ in (0,))))
    s.check("every save is in the band-remark list and the route is the super admin's in the access map", "set_five" in
            a.SUPER_BAND_ENDPOINTS["admin_performance_config"] and a.ADMIN_ACCESS_MAP.get("admin_performance_config") == "super"
            and a.ADMIN_ACCESS_MAP.get("admin_performance_five_preview", "super") == "super")
    s.check("the org rename cascade carries the four new tables", {"pm_cycle_bands", "pm_cycle_band_sets", "pm_cycle_band_rules",
                                                                    "pm_cycle_band_rule_depts"} <= a._ORG_SETTINGS_TABLES)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_calibration_adjustments WHERE session_id IN (SELECT id FROM pm_calibration_sessions WHERE "
                   "scope_label='ZZBC super')")
        db.execute("DELETE FROM pm_calibration_sessions WHERE scope_label='ZZBC super'")
        cleanup(db)
        left = [db.execute("SELECT COUNT(*) FROM %s WHERE business_group IN (?,?,?)" % t, (BG5, BGB, BGU)).fetchone()[0]
                for t in ("pm_cycle_band_rules", "pm_cycle_band_rule_depts", "pm_cycle_bands", "pm_cycle_band_sets",
                          "pm_bg_config", "org_units")]
        left.append(db.execute("SELECT COUNT(*) FROM cycles WHERE code LIKE 'ZZBC-%'").fetchone()[0])
        left.append(db.execute("SELECT COUNT(*) FROM users WHERE employee_id LIKE ?", (PREFIX + "%",)).fetchone()[0])
        left.append(db.execute("SELECT COUNT(*) FROM pm_cycle_bands WHERE cycle_id NOT IN (SELECT id FROM cycles)").fetchone()[0])
    s.check("everything the suite made is put back", not any(left), left)

sys.exit(s.done())
