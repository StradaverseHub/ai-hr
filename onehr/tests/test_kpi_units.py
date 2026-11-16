"""KPI units: one standard, suggested as figures are typed (Chris, 2026-10-18: "if the target is more than a million, it
goes automatically to RM (mil); perhaps not just to financial number, but also apply to other metrics too ... the system
will auto suggest and ask user to set the unit during the KPI setting time"; the libraries canvas board 23). His calls:
money in RM, RM ('000), RM (mil), RM (bil); counts and volumes with ('000) and (mil); the lines in use tidied,
rehearsed first.

What this suite holds:
  * the standard list and its scales; every spelling in use maps to its standard (case and spaces ignored, the longer
    "No. of days" / "% of Budget VS Actual" forms by rule); anything else is kept as typed
  * the suggestion: the step where the target is at least 1 and under a thousand, up or down, never for a unit off the
    scales; figures moved in decimal arithmetic (0.35 down a step is 350, not 350.00000000000006)
  * every writer stores the standard spelling: the person page, Add a person, the KPI import's row check, the library
    (form, import, proposal), BU KPI setup, the setting chat's inserts, the carry-in; a person's earlier figures come
    into a new KPI line in the library's step
  * a line with a result or check-in keeps its step (an admin edit that moves it is refused, told why)
  * the setting chat: the card's line carries its unit and the offer; Use moves the line and its figures through the
    agent's own set_unit writer; the agent is told the rule and the tool; a unit off the list is refused
  * the tidy (_kpi_unit_tidy and tools/tidy_kpi_units.py): on a copy, the active cycle's lines, the library and BU KPI
    setups put in the standard and moved a step where the target says so; a line acted on keeps its step; other cycles
    untouched; every change logged with what it was; a second run finds nothing; the dry run writes nothing
  * the picker on every form where a KPI is set, and the script's rule matching the server's
"""
import importlib.util
import json
import os
import shutil
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("KPI units: one standard, suggested as figures are typed")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO = "ZZKU Group", "ZZKU Unit"
ROOT = H.REPO


def read(rel):
    return open(os.path.join(ROOT, rel), encoding="utf-8").read()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9KU-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM cycles WHERE code='ZZKU-PRIOR'")
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


LADDER = {"rate 1": "12000000", "rate 2": "14000000", "rate 3": "15900000", "rate 4": "17000000", "rate 5": "19000000"}

with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    _prev_cyc = dict(db.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
    _prev_mods = {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?",
                                                  (CID,))}
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    LIB = {}
    for nm, unit, r3 in (("ZZKU Sales revenue", "RM", None), ("ZZKU Defects", "No.", None),
                         ("ZZKU Group revenue", "RM", 15900000.0)):
        LIB[nm] = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, "
                             "kpi_name, description, unit, method, rate3, active) VALUES (?, '*', '*', 0, '*', ?, "
                             "'definition', ?, 'more', ?, 1)", (BG, nm, unit, r3)).lastrowid
    M = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                   "department, job_grade, confirmation_date) VALUES ('zz9ku-m', 'ZZ KU M', 'x', 'user', 'ZZ9KU-M', "
                   "?,?, 'ZZKU Dept', '20', '2020-01-01')", (BG, CO)).lastrowid
    P = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                   "department, job_grade, confirmation_date, manager_id) VALUES ('zz9ku-p', 'ZZ KU P', 'x', 'user', "
                   "'ZZ9KU-P', ?,?, 'ZZKU Dept', '14', '2020-01-01', ?)", (BG, CO, M)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
URL = "/admin/users/%d/kpi" % P


def add(**kw):
    d = {"csrf_token": "tok", "action": "add", "kpi": "ZZKU Sales revenue", "weightage": "20", "method": "more",
         "moderator": "lm", **LADDER}
    d.update(kw)
    d.setdefault("library_id", str(LIB[d["kpi"]]))   # an Add picks a library KPI (2026-10-30)
    return SUP.post(URL, data=d, follow_redirects=True)


def line(name):
    r = H.rows(a, "SELECT id, unit, rate1, rate3, rate5 FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? AND "
                  "kpi_name=?", (CID, P, name))
    return r[0] if r else None


try:
    s.section("the standard")
    N = a.kpi_unit_normalise
    cases = [("RM(Mil)", "RM (mil)"), ("RM (MIL)", "RM (mil)"), ("RM (M)", "RM (mil)"), ("rm (billion)", "RM (bil)"),
             ("RM(K)", "RM ('000)"), ("RM", "RM"), ("RM/m3", "RM per m³"), ("RM/MT", "RM per tonne"),
             ("#", "Number"), ("Nos.", "Number"), ("No of SOP", "Number"), ("# of Agents", "Number"),
             ("m3", "m³"), ("MT", "Tonnes"), ("Mt/Worker", "Tonnes per worker"),
             ("Day(s)", "Days"), ("No. of Days", "Days"), ("No of working day", "Working days"), ("hr", "Hours"),
             ("months", "Months"), ("DD", "Date"), ("RATING", "Rating"), ("Rating (1-5)", "Rating"),
             ("SCORE", "Score"), ("Cases/month (Average)", "Cases per month"), ("Number of incident", "Incidents"),
             ("% of Budget VS Actual", "%"), ("Percentage", "%"), ("multiplier", "Ratio (x)")]
    bad = [(raw, N(raw), want) for raw, want in cases if N(raw) != want]
    s.check("every spelling in use maps to its standard (%d checked)" % len(cases), not bad, bad)
    s.check("...a unit off the list is kept as typed, its spaces tidied", N("  LTIFR ") == "LTIFR"
            and N("Level / %") == "Level / %" and N("Transactional") == "Transactional")
    s.check("...nothing is nothing, and a long one is cut to the column's size", N("") is None and N(None) is None
            and len(N("x" * 80)) == a.KPI_UNIT_MAX)
    s.check("each standard unit is its own spelling", all(N(u) == u for u in a.KPI_UNITS))
    s.check("money steps RM, RM ('000), RM (mil), RM (bil); counts and volumes ('000) and (mil)",
            a.KPI_UNIT_SCALES["RM"] == ("RM", "RM ('000)", "RM (mil)", "RM (bil)")
            and all(len(a.KPI_UNIT_SCALES[f]) == 3 for f in ("Number", "m³", "Tonnes", "Units", "Pieces"))
            and all(u in a.KPI_UNITS for us in a.KPI_UNIT_SCALES.values() for u in us))

    s.section("the suggestion")
    G = a.kpi_unit_suggest
    g = G("RM", {"rate3": 15900000})
    s.check("RM in the millions -> RM (mil): 15,900,000 becomes 15.9", g and g["unit"] == "RM (mil)" and g["steps"] == 2
            and g["now"] == 15.9, g)
    g = G("RM (mil)", {"target": 0.35})
    s.check("...and down: RM (mil) under one -> RM ('000), 0.35 becomes 350 exactly", g and g["unit"] == "RM ('000)"
            and g["now"] == 350.0 and repr(g["now"]) == "350.0", g)
    s.check("from a thousand: RM 1,000 -> RM ('000); RM 999 stays", (G("RM", {"rate3": 1000}) or {}).get("unit") ==
            "RM ('000)" and G("RM", {"rate3": 999}) is None)
    s.check("a billion -> RM (bil); counts too (1,500 -> Number ('000), 61,500 m³ -> 61.5 m³ ('000))",
            (G("RM", {"target": 2e9}) or {}).get("unit") == "RM (bil)" and (G("Number", {"rate3": 1500}) or {}).get(
                "now") == 1.5 and (G("m³", {"rate3": 61500}) or {}).get("unit") == "m³ ('000)")
    s.check("never for a unit off the scales (%, days, a rate per m³, one typed), nor a target of 0 or none",
            all(G(u, {"rate3": 5e6}) is None for u in ("%", "Days", "RM per m³", "LTIFR", None))
            and G("RM", {"rate3": 0}) is None and G("RM", {}) is None)
    s.check("Rate 3 is the figure judged (Mechanism A), else the target (B)",
            G("RM", {"rate3": 500, "target": 5e6}) is None and (G("RM", {"rate3": None, "target": 5e6}) or {}).get(
                "unit") == "RM (mil)")
    sh = a.kpi_unit_shift
    s.check("figures move by their decimal digits", sh(15900000, 2) == 15.9 and sh(6712345, 2) == 6.712345
            and sh(0.35, -1) == 350.0 and sh(None, 2) is None)
    s.check("moving between steps of one scale only", a.kpi_unit_steps_between("RM", "RM (mil)") == 2
            and a.kpi_unit_steps_between("RM (mil)", "RM ('000)") == -1 and a.kpi_unit_steps_between("RM", "%") is None
            and a.kpi_unit_steps_between("RM", "RM") is None)

    s.section("every writer stores the standard")
    with a.app.app_context():
        cfg = a.get_db().execute("SELECT * FROM pm_bg_config WHERE business_group=?", (BG,)).fetchone()
    v, err = a._pm_kpi_values({"kpi": "x", "weightage": "10", "method": "more", "unit of measure": "RM(Mil)",
                               "rate 1": "1", "rate 2": "2", "rate 3": "3", "rate 4": "4", "rate 5": "5"}, cfg, "x")
    s.check("the KPI import's row check (and so the person page, Add a person, BU KPI setup)",
            not err and v["unit"] == "RM (mil)", (v, err))
    with a.app.app_context():   # the unit is the library row's, in whatever spelling the library holds it
        for nm, unit in (("ZZKU Spelled", "RM(Mil)"), ("ZZKU Off list", "LTIFR")):
            LIB[nm] = a.get_db().execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, "
                                         "job_grade, kpi_name, description, unit, method, active) VALUES (?, '*', "
                                         "'*', 0, '*', ?, 'definition', ?, 'more', 1)", (BG, nm, unit)).lastrowid
        a.get_db().commit()
    def add_lib_unit(**kw):   # an Add that leaves the unit alone: it starts as the library's (the panel's select does the same)
        d = dict(kw)
        return SUP.post(URL, data={"csrf_token": "tok", "action": "add", "kpi": d["kpi"], "weightage": "20",
                                   "method": "more", "moderator": "lm", **LADDER, **d,
                                   "library_id": str(LIB[d["kpi"]])}, follow_redirects=True)
    add_lib_unit(kpi="ZZKU Spelled", **{"rate 1": "12", "rate 2": "14", "rate 3": "15.9", "rate 4": "17", "rate 5": "19"})
    add_lib_unit(kpi="ZZKU Off list")
    s.check("the person page: the library's unit stored as its standard, one off the list as it is (the unit starts as the library's)",
            (line("ZZKU Spelled") or [None, None])[1] == "RM (mil)"
            and (line("ZZKU Off list") or [None, None])[1] == "LTIFR")
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_kpi_targets WHERE subject_id=?", (P,))
        a.get_db().commit()
    add(kpi="ZZKU Spelled", unit="rm(k)", **{"rate 1": "12", "rate 2": "14", "rate 3": "15.9", "rate 4": "17", "rate 5": "19"})
    s.check("...and a unit picked on the panel is the line's own, in the standard's spelling (2026-11-04: method and unit are "
            "this line's; the library row is untouched)",
            (line("ZZKU Spelled") or [None, None])[1] == "RM ('000)"
            and H.one(a, "SELECT unit FROM pm_kpi_library WHERE id=?", (LIB["ZZKU Spelled"],)) == "RM(Mil)")
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_kpi_targets WHERE subject_id=?", (P,))
        a.get_db().commit()
    form = {"csrf_token": "tok", "action": "kpis", "then": "save", "lib_id": [str(LIB["ZZKU Sales revenue"]),
                                                                              str(LIB["ZZKU Defects"])],
            "focus": ["", ""], "unit": ["rm(k)", ""], "weightage": ["60", "40"], "description": ["", ""],
            "method": ["more", "more"]}
    for i in range(1, 6):
        form["rate %d" % i] = [str(i), str(i)]
    SUP.post("/admin/people/add/%d" % P, data=form)
    s.check("Add a person: the unit picked per line, else the library's, each in the standard's spelling",
            (line("ZZKU Sales revenue") or [None, None])[1] == "RM ('000)"
            and (line("ZZKU Defects") or [None, None])[1] == "Number",
            H.rows(a, "SELECT kpi_name, unit FROM pm_kpi_targets WHERE subject_id=?", (P,)))
    src = H.source(a)
    s.check("the library's form, import and proposal store the standard",
            'unit = kpi_unit_normalise(request.form.get("unit"))' in src
            and '"unit": kpi_unit_normalise(request.form.get("unit")), "bu_level"' in src
            and src.count('"unit": kpi_unit_normalise(_pick(rec, "unit of measure", "unit"))') == 2)
    s.check("BU KPI setup: the unit picked on its card, else the library's", 'kpi_unit_normalise(form.get(k + "unit") '
            'or lib["unit"])' in src)
    s.check("every insert from a library row stores the standard (no raw library unit left)",
            'lib["unit"], lib["method"]' not in src and src.count('kpi_unit_normalise(lib["unit"]), lib["method"]') == 4)
    s.check("the carry-in reads its unit as the standard spells it", 'vals["unit"] = kpi_unit_normalise(vals["unit"])'
            in src)

    s.section("their earlier figures come into a new line in the library's step")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE pm_kpi_library SET unit='RM (mil)' WHERE id=?", (LIB["ZZKU Sales revenue"],))
        PRI = db.execute("INSERT INTO cycles(name, code, year, half, kind, is_active) VALUES ('ZZKU prior', "
                         "'ZZKU-PRIOR', 2020, 2, 'year_end', 0)").lastrowid
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, unit, method, rate1, rate2, "
                   "rate3, rate4, rate5, business_group, company, status) VALUES (?,?, 'ZZKU Sales revenue', 20, 'RM', "
                   "'more', 12000000, 14000000, 15900000, 17000000, 19000000, ?,?, 'approved')", (PRI, P, BG, CO))
        db.commit()
        u = db.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone()
        lib = db.execute("SELECT * FROM pm_kpi_library WHERE id=?", (LIB["ZZKU Sales revenue"],)).fetchone()
        per = dict(db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())
        nums, how = a.pm_default_numbers(db, u, per, lib, cfg)
        hint = a.pm_last_figures(db, P, "ZZKU Sales revenue", "RM (mil)", per)
    s.check("a new line starts blank: nothing is copied in, the library's or last period's (Chris, 2026-11-02)",
            how == "blank" and all(v is None for v in nums.values()), (how, nums))
    s.check("last period's 15,900,000 RM reads 15.9 as the hint when the KPI is now in RM (mil)",
            hint and hint["rate3"] == 15.9 and hint["rate1"] == 12.0, hint)

    s.section("a line with a result keeps its step")
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=?", (P, CID))
        db.commit()
    with a.app.app_context():   # a library KPI of the same name in RM (mil): the line can be re-pointed to it
        LIB["ZZKU Sales mil"] = a.get_db().execute(
            "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, description, "
            "unit, method, active) VALUES (?, '*', '*', 0, '*', 'ZZKU Sales mil', 'definition', 'RM (mil)', 'more', 1)",
            (BG,)).lastrowid
        a.get_db().commit()
    with a.app.app_context():   # the library KPI is in RM again (an earlier section stepped its figures to RM (mil))
        a.get_db().execute("UPDATE pm_kpi_library SET unit='RM' WHERE id=?", (LIB["ZZKU Sales revenue"],))
        a.get_db().commit()
    add(kpi="ZZKU Sales revenue")
    tid = line("ZZKU Sales revenue")[0]
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?, 16000000, "
                   "?, 1)", (tid, P))
        db.commit()
    edit = {"csrf_token": "tok", "action": "edit", "kpi_target_id": tid, "kpi": "ZZKU Sales revenue",
            "library_id": str(LIB["ZZKU Sales mil"]),
            "weightage": "20", "method": "more", "moderator": "lm", "rate 1": "12", "rate 2": "14", "rate 3": "15.9",
            "rate 4": "17", "rate 5": "19"}
    r = SUP.post(URL, data=edit, follow_redirects=True).get_data(as_text=True)
    s.check("an admin re-pointing it to a library KPI in RM (mil) is refused, told why", line("ZZKU Sales revenue")[1] == "RM"
            and "already has a result entered in RM" in r and "a million times too big" in r)
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (tid,))
        a.get_db().commit()
    SUP.post(URL, data=edit)
    s.check("...without a result the same re-point saves (the line follows the library KPI's unit)",
            H.rows(a, "SELECT unit, rate1, library_id FROM pm_kpi_targets WHERE id=?", (tid,))[0][:] ==
            ("RM (mil)", 12.0, LIB["ZZKU Sales mil"]))

    s.section("the setting chat")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET kind='early_year', year=2027, half=0, min_job_grade=NULL WHERE id=?", (CID,))
        db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','pm')", (CID,))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=?", (P, CID))
        STID = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, unit, method, rate1, "
                          "rate2, rate3, rate4, rate5, business_group, company, status, library_id, created_by) VALUES "
                          "(?,?, 'ZZKU Group revenue', 100, 'RM', 'more', 12000000, 14000000, 15900000, 17000000, "
                          "19000000, ?,?, 'draft', ?, ?)", (CID, P, BG, CO, LIB["ZZKU Group revenue"], P)).lastrowid
        db.commit()
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = P
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (P,)).fetchone())
        ov = a._setting_overview(db, u)
        ln = next((x for x in (ov or {}).get("data", {}).get("lines", []) if x["kpi_id"] == STID), {})
        system = a._setting_agent_system(db, u, a._pm_setting_context(db, u))
        refused = a._setting_run_tool(db, u, CID, {"tool": "set_unit", "args": {"kpi_id": STID, "unit": "furlongs"}})
    off = ln.get("unit_offer") or {}
    s.check("the card's line carries its unit and the offer, in the card's words", ln.get("unit") == "RM"
            and off.get("unit") == "RM (mil)" and off.get("was") == "15,900,000" and off.get("now") == "15.9"
            and off.get("words") == "These figures are in the millions.", ln)
    s.check("the agent sees the unit and the better one, the rule, and the tool", '"better_unit": "RM (mil)"' in system
            and "only on their yes call set_unit(kpi_id, unit)" in system and "set_unit{kpi_id, unit}" in system)
    s.check("a unit off the list is refused", refused.get("ok") is False and "must be one of" in refused.get("error", ""))
    PC = H.client_as(a, P)
    j = PC.post("/review/setting/unit", data={"csrf_token": "tok", "kpi_id": STID, "unit": "RM (mil)"}).get_json() or {}
    got = H.rows(a, "SELECT unit, rate1, rate3, rate5 FROM pm_kpi_targets WHERE id=?", (STID,))[0]
    s.check("Use: the line moves to RM (mil) and every figure with it", j.get("ok") and tuple(got) == ("RM (mil)", 12.0,
                                                                                                     15.9, 19.0),
            (j.get("error"), tuple(got)))
    nl = next((x for x in (j.get("overview") or {}).get("lines", []) if x["kpi_id"] == STID), {})
    s.check("...the card comes back with the new unit and no offer", nl.get("unit") == "RM (mil)"
            and not nl.get("unit_offer"))
    j2 = H.client_as(a, M).post("/review/setting/unit", data={"csrf_token": "tok", "kpi_id": STID,
                                                              "unit": "RM"}).get_json() or {}
    s.check("...only on their own line", not j2.get("ok") and H.one(a, "SELECT unit FROM pm_kpi_targets WHERE id=?",
                                                                    (STID,)) == "RM (mil)")
    s.check("the route is a review write (the module gate)", a.MODULE_ENDPOINTS.get("review_setting_unit") == "review")
    s.check("...in the setting window's cell", "review_setting_unit" in a._WINDOW_ENDPOINTS["pm_setting"])

    s.section("the tidy, on a copy")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?",
                   (_prev_cyc["kind"], _prev_cyc["year"], _prev_cyc["half"], _prev_cyc["min_job_grade"], CID))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=?", (P, CID))
        T = {}
        for nm, unit, rates in (("a big RM", "RM", (12e6, 14e6, 15.9e6, 17e6, 19e6)),
                                ("b small mil", "RM(Mil)", (0.2, 0.3, 0.35, 0.4, 0.5)),
                                ("c volume", "m3", (50000, 55000, 61500, 65000, 70000)),
                                ("d percent", "%", (80, 90, 100, 110, 120)),
                                ("e days", "No. of days", (9, 7, 5, 4, 3)),
                                ("f typed", "LTIFR", (5, 4, 3, 2, 1)),
                                ("g acted", "RM", (12e6, 14e6, 15.9e6, 17e6, 19e6))):
            T[nm] = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, unit, method, "
                               "rate1, rate2, rate3, rate4, rate5, business_group, company, status) VALUES (?,?,?, 10, "
                               "?, 'more', ?,?,?,?,?, ?,?, 'approved')", (CID, P, "ZZKU " + nm, unit, *rates, BG, CO)
                               ).lastrowid
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?, 1, ?, 1)",
                   (T["g acted"], P))
        db.commit()
    base_log = H.one(a, "SELECT COUNT(*) FROM pm_kpi_unit_tidy_log")
    tmp = tempfile.mkdtemp(prefix="onehr-tests-units-")
    try:
        cp = os.path.join(tmp, "copy.db")
        src_db, dst_db = sqlite3.connect(a.DB_PATH), sqlite3.connect(cp)
        src_db.backup(dst_db)
        src_db.close()
        dst_db.close()
        c = sqlite3.connect(cp)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        dry = a._kpi_unit_tidy(c, CID, SU["id"], apply=False)
        s.check("a dry run writes nothing", not dry["applied"] and c.execute(
            "SELECT unit FROM pm_kpi_targets WHERE id=?", (T["a big RM"],)).fetchone()[0] == "RM"
            and c.execute("SELECT COUNT(*) FROM pm_kpi_unit_tidy_log").fetchone()[0] == base_log)
        res = a._kpi_unit_tidy(c, CID, SU["id"], apply=True)
        c.commit()

        def got_(nm):
            return tuple(c.execute("SELECT unit, rate1, rate3 FROM pm_kpi_targets WHERE id=?", (T[nm],)).fetchone())
        s.check("RM in the millions -> RM (mil), every figure moved", got_("a big RM") == ("RM (mil)", 12.0, 15.9))
        s.check("RM(Mil) under one -> RM ('000): 0.35 -> 350", got_("b small mil") == ("RM ('000)", 200.0, 350.0))
        s.check("61,500 m3 -> 61.5 m³ ('000)", got_("c volume") == ("m³ ('000)", 50.0, 61.5))
        s.check("% stays; 'No. of days' spelled Days; a typed unit kept", got_("d percent")[0] == "%"
                and got_("e days") == ("Days", 9.0, 5.0) and got_("f typed")[0] == "LTIFR")
        s.check("a line with a result keeps its step", got_("g acted") == ("RM", 12e6, 15.9e6)
                and res["line"]["acted_on_kept_step"] >= 1)
        s.check("the line in another cycle is left as it was", c.execute(
            "SELECT unit, rate3 FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (PRI, P)).fetchone()[:] ==
            ("RM", 15900000.0))
        lg = c.execute("SELECT old_unit, new_unit, steps, old_figures_json FROM pm_kpi_unit_tidy_log WHERE kind='line' "
                       "AND row_id=?", (T["a big RM"],)).fetchone()
        s.check("every change logged with the unit and figures before it", lg and lg[0] == "RM" and lg[1] == "RM (mil)"
                and lg[2] == 2 and json.loads(lg[3])["rate3"] == 15900000.0)
        s.check("the library too, the spelling only: 'No.' spelled Number; RM stays RM and its figures are never read or "
                "rescaled",
                c.execute("SELECT unit FROM pm_kpi_library WHERE id=?", (LIB["ZZKU Defects"],)).fetchone()[0] ==
                "Number" and tuple(c.execute("SELECT unit, rate3 FROM pm_kpi_library WHERE id=?",
                                             (LIB["ZZKU Group revenue"],)).fetchone()) == ("RM", 15900000.0))
        s.check("one activity row says what was done", c.execute(
            "SELECT COUNT(*) FROM activity_log WHERE action='pm_unit_tidy' AND detail LIKE ?",
            ("%" + res["run_id"] + "%",)).fetchone()[0] == 1)
        again = a._kpi_unit_tidy(c, CID, SU["id"], apply=False)
        s.check("a second run finds nothing to do", again["changed"] == 0, again["changed"])
        c.close()

        s.section("the tool")
        spec = importlib.util.spec_from_file_location("tidy_kpi_units", os.path.join(ROOT, "tools", "tidy_kpi_units.py"))
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
        said = []
        ok = tool.run(a, SU["username"], apply=False, out=said.append)
        txt = "\n".join(said)
        s.check("its dry run tidies a throwaway copy and reports it: nothing written here", ok and "DRY RUN" in txt
                and "a second run would change 0" in txt and H.one(a, "SELECT unit FROM pm_kpi_targets WHERE id=?",
                                                                   (T["a big RM"],)) == "RM", txt[-400:])
        said = []
        s.check("...it refuses anyone but a super admin", not tool.run(a, "zz9ku-p", out=said.append)
                and "REFUSED" in "\n".join(said))
        cp2 = os.path.join(tmp, "apply.db")
        src_db, dst_db = sqlite3.connect(a.DB_PATH), sqlite3.connect(cp2)
        src_db.backup(dst_db)
        src_db.close()
        dst_db.close()
        real = a.DB_PATH
        a.DB_PATH = cp2
        try:
            said = []
            ok = tool.run(a, SU["username"], apply=True, out=said.append)
        finally:
            a.DB_PATH = real
        c = sqlite3.connect(cp2)
        s.check("--apply backs up first (integrity checked), then writes", ok and "WRITTEN" in "\n".join(said)
                and any(f.startswith("apply.db.pre-unit-tidy-") for f in os.listdir(tmp))
                and c.execute("SELECT unit FROM pm_kpi_targets WHERE id=?", (T["a big RM"],)).fetchone()[0] ==
                "RM (mil)")
        c.close()
        s.check("...this suite's database was never touched", H.one(a, "SELECT COUNT(*) FROM pm_kpi_unit_tidy_log") ==
                base_log)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    s.section("the picker wherever a KPI is set")
    for f, what in (("templates/_kpi_form.html", "the library's form"),
                    ("templates/admin_kpi_library.html", "the library's proposal"),
                    ("templates/admin_add_steps.html", "Add a person's lines"),
                    ("templates/admin_bu_kpis.html", "BU KPI setup")):
        t = read(f)
        s.check("%s uses it (%s)" % (what, f), "unit_select(" in t and '_kpi_unit.html" import unit_select with context'
                in t and 'name="unit"' not in t.replace('name="{{ name }}"', ""))
    tab = SUP.get("/admin/users/%d?tab=performance" % P).get_data(as_text=True)
    s.check("the person page's KPI panel picks a line's unit from the standard list in its own select (2026-11-04: the unit "
            "starts as the library's and is this line's own): not the shared picker (no 'Other', no step suggestion), and never "
            "typed",
            'data-kpi-unit' not in tab and '<optgroup label="Money">' in tab and 'data-kpe-sel="unit"' in tab
            and 'data-kpe-o="unit"' not in tab and "ku-other" not in tab
            and "unit_select(" not in read("templates/person/_kpi_panels.html"))
    s.check("...the script is on every page, in the head", "filename='kpi_units.js'" in read("templates/base.html")
            .split("</head>")[0])
    ku = read("static/kpi_units.js")
    s.check("the script's rule is the server's: the step where the target is 1 to under a thousand, Rate 3 else the "
            "target, decimal moves", "base >= Math.pow(1000, i)" in ku and "field(scope, 'rate3')" in ku
            and "field(scope, 'target')" in ku and "'e' + ((p[1] ? Number(p[1]) : 0) - 3 * d)" in ku)
    s.check("...nothing changes without a click; text only, never markup", "accept(sc)" in ku and "innerHTML" not in ku
            and "textContent" in ku)
    sc = read("static/setting_chat.js")
    s.check("the setting card: its unit in the line's meta, the offers in a strip under its header posting to the route",
            "[l.unit, l.direction, l.category]" in sc and "function unitOffer(l)" in sc and "fetch(unitUrl" in sc
            and "pin.appendChild(offers)" in sc and "data-unit-url" in read("templates/review_setting.html"))
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _db.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?",
                    (_prev_cyc["kind"], _prev_cyc["year"], _prev_cyc["half"], _prev_cyc["min_job_grade"], CID))
        for k, v in _prev_mods.items():
            _db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, CID, k))
        _cleanup(_db)

sys.exit(s.done())
