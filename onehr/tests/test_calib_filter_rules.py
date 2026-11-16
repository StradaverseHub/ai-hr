"""Calibration filter rules: one registry of filterable columns, one rule per filter, one filter line (Chris, 2026-10-30,
canvas "OneHR Calibration Filter Rules": Option 2 for the settings, boards C2 / D2 for the leaders' line).

What this pins:
  * CALIB_FILTERS is the one list: Department, Calibrator, Job grade, Cost centre, Branch, in that order; the first three keep
    the tables they have always used (their saved rows do not move), the roster ones share calib_filter, which the org rename
    carries; a filter added later is one entry
  * Filters at BU level: a row per filter (Filter, Units, Screens, Edit), its rule in a side panel; ONE write route, the super
    admin's, that writes units x screens, refuses anything that is not a unit of the group / a registry key / a screen the
    filter takes / a unit with no values, and audits what it changed with what it was
  * defaults: Department, Job grade, Cost centre and Branch hidden; Calibrator shown where a unit has calibrators
  * the leaders' payloads carry only the chips switched on for the unit and screen, in registry order, each counted within
    the picks before it; the BG CEO's Talent Box narrows by ?cc= / ?branch= and ignores a value the unit does not hold;
    nine or more values flag the search box
  * the client draws ONE line (the old pill rows and their CSS are gone)

Its own synthetic business group on the shared suite database; everything is put back at the end.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Calibration filter rules: the registry, one rule per filter, the filter line")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, EMP = H.actors(a)
C_SU = H.client_as(a, SU["id"])
C_BGA = H.client_as(a, BGA["id"]) if BGA else None
BG, U1, U2, U3 = "ZZCF Group", "ZZCF Cement Sdn Bhd", "ZZCF Paint Sdn Bhd", "ZZCF Empty Sdn Bhd"
DEPT_A, DEPT_B = "ZZCF Sales", "ZZCF Ops"
CCS = ["ZZCF-CC%02d" % i for i in range(1, 11)]   # ten cost centres in U1: the chip gets a search box
BRANCHES = ["ZZCF Ipoh", "ZZCF Klang"]
TOUCHED = ("calib_filter", "calib_dept_filter", "calib_jg_filter", "calib_cal_filter")


def _clean(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZCF-%'")]
    for (g_,) in db.execute("SELECT id FROM calib_bu_groups WHERE business_group=?", (BG,)).fetchall():
        for t_ in ("calib_bu_group_units", "calib_bu_group_people", "calib_bu_group_depts", "calib_bu_group_left"):
            db.execute("DELETE FROM %s WHERE group_id=?" % t_, (g_,))
    db.execute("DELETE FROM calib_bu_groups WHERE business_group=?", (BG,))
    for t in TOUCHED:
        db.execute("DELETE FROM %s WHERE business_group=?" % t, (BG,))
    db.execute("DELETE FROM calib_jg_bands WHERE business_group=?", (BG,))
    if ids:
        ph = ",".join("?" * len(ids))
        for t, c in (("pm_kpi_targets", "subject_id"), ("buceo_seats", "user_id")):
            try:
                db.execute("DELETE FROM %s WHERE %s IN (%s)" % (t, c, ph), ids)
            except Exception:   # noqa: BLE001 -- a table this copy lacks
                pass
        db.execute("UPDATE users SET hod_id=NULL, manager_id=NULL WHERE hod_id IN (%s) OR manager_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM activity_log WHERE action='settings' AND detail LIKE ?", ("Filters at BU level, %s:%%" % BG,))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    _clean(db)
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    _ORIG = {"half": db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0],
             "modules": {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=? "
                                                         "AND module_key IN ('review','calibration','pm','tm')", (CID,))}}
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm')", (CID,))
    for co in (U1, U2, U3):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, co))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, company, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=company, left_at=None,
                 department=DEPT_A, job_grade="13", cost_center=None, work_location=None)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        uid = db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group) "
                   "VALUES (?,?,?,100,'more','approved',?)", (PER, uid, "ZZCF KPI", BG))
        return uid
    BOSS = person("ZZCF-CEO", "ZZ CF Group CEO", U1, bgceo_bg=BG, cost_center=CCS[0], work_location=BRANCHES[0])
    # U1: 12 people over ten cost centres (the CEO holds the first), two with none; two branches, three with none
    P1 = []
    for i in range(12):
        P1.append(person("ZZCF-C%02d" % i, "ZZ CF Cement %02d" % i, U1,
                         department=DEPT_A if i % 2 == 0 else DEPT_B,
                         job_grade=("13", "16", "20")[i % 3],
                         cost_center=None if i >= 10 else CCS[i % 10],
                         work_location=None if i % 4 == 3 else BRANCHES[i % 2]))
    # U2: people, but not one cost centre; branches yes. U3: nobody at all.
    P2 = [person("ZZCF-P%02d" % i, "ZZ CF Paint %02d" % i, U2, work_location=BRANCHES[0]) for i in range(3)]
    db.commit()


def one(sql, *p):
    return H.one(a, sql, p)


def bg_card(extra=""):
    r = C_SU.get("/admin/m/calibration/settings?bfbg=%s%s" % (BG.replace(" ", "+"), extra))
    return r, r.get_data(as_text=True)


def post(client, filt, units=(), screens=(), **extra):
    """One filter's panel form: `units` = the units ticked (the others are sent unticked), `screens` = the screens ticked."""
    d = {"csrf_token": "tok", "bg": BG, "filter": filt}
    for i, co in enumerate(UNITS):
        d["unit_%d" % i] = co
        if co in units:
            d["on_%d" % i] = "1"
    d.update(extra)
    d["screen"] = list(screens)
    return client.post("/admin/settings/calib-filter", data=d)


UNITS = [U1, U2, U3]   # the order the card lists them in (org_units by company name: Cement, Empty, Paint)
UNITS = sorted(UNITS)


def state(key, co, view):
    with a.app.test_request_context("/"):
        return a.calib_filter_on(a.get_db(), BG, key, co, view)


def rows_of(table, **where):
    q = "SELECT COUNT(*) FROM %s WHERE business_group=?" % table
    args = [BG]
    for k, v in where.items():
        q += " AND %s=?" % k
        args.append(v)
    return one(q, *args)


# ---------------------------------------------------------------------------
s.section("the registry: one list, in the leaders' order")
reg = a.CALIB_FILTERS
s.check("Department, Calibrator, Job grade, Cost centre, Branch, in that order",
        [f["key"] for f in reg] == ["dept", "cal", "jg", "cc", "branch"] and a.CALIB_FILTER_KEYS == ("dept", "cal", "jg", "cc", "branch"),
        [f["key"] for f in reg])
s.check("...each names its label, plural, code and screens; Calibrator is the Talent Box's alone",
        all(f["label"] and f["plural"] and f["code"] and f["views"] for f in reg)
        and a.calib_filter_def("cal")["views"] == ("tb",) and all(a.calib_filter_def(k)["views"] == ("bu", "tb")
                                                                   for k in ("dept", "jg", "cc", "branch")))
s.check("...the three that existed keep their own tables; Cost centre and Branch share calib_filter (no table of their own)",
        [f["table"] for f in reg] == ["calib_dept_filter", "calib_cal_filter", "calib_jg_filter", None, None]
        and a.calib_filter_def("cc")["column"] == "cost_center" and a.calib_filter_def("branch")["column"] == "work_location")
s.check("calib_filter exists with its four-part key and the org rename carries it", "calib_filter" in a._ORG_SETTINGS_TABLES
        and one("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='calib_filter'") == 1
        and sorted(r[1] for r in H.rows(a, "PRAGMA table_info(calib_filter)") if r[5]) == sorted(
            ["business_group", "company", "view", "filter_key"]))
s.check("an unknown key is no filter, and shows nowhere", a.calib_filter_def("nope") is None
        and not a.calib_filter_shown(None, BG, [U1], "tb", "nope"))

# ---------------------------------------------------------------------------
s.section("defaults: nothing shown but the Calibrator where a unit has calibrators")
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("Department, Job grade, Cost centre and Branch are hidden everywhere until the super admin switches them on",
            not any(a.calib_filter_shown(db, BG, [U1, U2, U3], v, k) for k in ("dept", "jg", "cc", "branch")
                    for v in ("bu", "tb")) and a.calib_filters_shown(db, BG, [U1], "tb") == [])
    s.check("...the Calibrator too, while the unit has no calibrators", not a.calib_filter_shown(db, BG, [U1], "tb", "cal"))
    gid = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)",
                     (BG, U1, "ZZCF Group A", BOSS)).lastrowid
    db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)",
               (gid, BG, U1, DEPT_B))
    db.commit()
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("...and shown on the Talent Box, not the BU CEO's screen, once it has one",
            a.calib_filter_shown(db, BG, [U1], "tb", "cal") and not a.calib_filter_shown(db, BG, [U1], "bu", "cal")
            and not a.calib_filter_shown(db, BG, [U2], "tb", "cal")
            and [f["key"] for f in a.calib_filters_shown(db, BG, [U1], "tb")] == ["cal"])

# ---------------------------------------------------------------------------
s.section("the card: a row per filter, its rule in a side panel")
r, html = bg_card()
card = html[html.find('id="bu-filters"'):html.find('id="jg-filter"')]
_head = card[:card.find("adm-set-last")]
s.check("the card is on Calibration & Talent's Settings, its heading shows one 'Per viewer' pill and no 'Per business group'",
        r.status_code == 200 and 'id="bu-filters"' in html and _head.count("Per viewer") == 1
        and "Per business group" not in _head and card[:600].count("Per viewer") == 1, (r.status_code, _head[:300]))
s.check("a row per registry filter: its name, its caps code under it, Units, Screens and an Edit",
        all(('data-cfr-row="%s"' % k) in card and ('data-panel-open="cf-%s"' % k) in card for k in a.CALIB_FILTER_KEYS)
        and "JG · grouped below" in card and "BRANCH · work location" in card and ">CC<" in card
        and "<th>Filter</th><th>Units</th><th>Screens</th>" in card)
s.check("...the tags and Set every unit are gone", "bf-tag" not in html and "Set every unit" not in html
        and "data-bf-all" not in html and "bf-all" not in html)
s.check("...nothing shown yet: Not shown anywhere, and – for the screens (the Calibrator: the unit that has calibrators)",
        card.count("Not shown anywhere") == 4 and "Units with calibrators (1)" in card, card.count("Not shown anywhere"))
s.check("one panel per filter, 560px house panel, titled '<Filter> filter' under '<Group> · Filters at BU level'",
        card.count('class="adm-panel') == 5 and "Cost centre filter" in card and "ZZCF Group · Filters at BU level" in card
        or card.count('<aside class="adm-panel') == 5, card.count("adm-panel"))
s.check("...cost centre and branch say where they read from",
        "From the roster&#39;s cost centre" in card or "From the roster's cost centre" in card)
s.check("...every panel form is a POST with the token in the form, the group and the filter, and OneHR's own confirm box",
        card.count('action="/admin/settings/calib-filter"') == 5 and card.count('name="csrf_token"') >= 5
        and card.count('data-confirm="Nothing has changed for the') == 5 and card.count('data-confirm-ok="Save filter"') == 5
        and 'name="filter" value="cc"' in card and 'name="bg" value="%s"' % BG in card)
s.check("...a row per unit: its checkbox, its name and coverage line ('12 of 13 have one · 10 cost centres'), a link to tick every unit that has one",
        'name="unit_0"' in card and 'name="on_0"' in card and "Tick every unit that has one" in card
        and re.search(r"(\d+) of (\d+) have one · 10 cost centres", card) is not None, "cover" )
s.check("...a unit nobody has a cost centre in is greyed out and says why; a unit with nobody likewise",
        card.count("No one has a cost centre") == 2, card.count("No one has a cost centre"))
cc_panel = card[card.find('data-panel="cf-cc"'):card.find('data-panel="cf-branch"')]
s.check("...it is disabled, so the browser never sends it", len(re.findall(r'name="on_\d"[^>]*disabled', cc_panel)) == 2
        and "2. Which screens" in cc_panel and "BU CEO calibration" in cc_panel and "(also calibration groups)" not in cc_panel   # 2026-11-02: calibrators have their own tab
        and "BG CEO Talent Box" in cc_panel and "3. What leaders will see" in cc_panel, len(re.findall(r'disabled', cc_panel)))
cal_panel = card[card.find('data-panel="cf-cal"'):card.find('data-panel="cf-jg"')]
s.check("the Calibrator's panel offers the Talent Box alone (the BU CEO's screen has none)",
        'data-cfr-screen="tb"' in cal_panel and 'data-cfr-screen="bu"' not in cal_panel and "No calibrators at BU level" in cal_panel)
s.check("Save filter is off until something changes; the script writes the confirm box", "data-cfr-save disabled" in card
        and "calib_filter_rules.js" in card)
rb = C_BGA.get("/admin/m/calibration/settings") if C_BGA else None
s.check("a BG admin reads the card as 'only a super admin changes this' and gets no form", rb is None or (
    rb.status_code == 200 and "Only a super admin changes this" in rb.get_data(as_text=True)
    and "data-cfr-form" not in rb.get_data(as_text=True)), rb and rb.status_code)

# ---------------------------------------------------------------------------
s.section("saving: units x screens, for a new filter")
with a.app.test_request_context("/"):
    log0 = a.get_db().execute("SELECT COUNT(*) FROM activity_log WHERE action='settings' AND detail LIKE ?",
                              ("Filters at BU level, %s:%%" % BG,)).fetchone()[0]
rp = post(C_SU, "cc", units=[U1], screens=["bu", "tb"])
s.check("Cost centre on for Cement, both screens: a calib_filter row per screen, nothing else written",
        rp.status_code == 302 and state("cc", U1, "bu") and state("cc", U1, "tb") and not state("cc", U2, "tb")
        and rows_of("calib_filter", filter_key="cc") == 2 and rows_of("calib_dept_filter") == 0, rp.status_code)
s.check("...back on the same business group's card", "bfbg=" in rp.headers.get("Location", "")
        and rp.headers.get("Location", "").endswith("#bu-filters"), rp.headers.get("Location"))
s.check("...one audit line: who, what, and what it was",
        one("SELECT COUNT(*) FROM activity_log WHERE action='settings' AND detail LIKE ?", "Filters at BU level, %s:%%" % BG) == log0 + 1
        and one("SELECT COUNT(*) FROM activity_log WHERE action='settings' AND detail LIKE ?",
                "Filters at BU level, %s:%%CC shown in the BU CEO view: %s (was hidden)%%" % (BG, U1)) == 1)
r, html = bg_card()
card = html[html.find('id="bu-filters"'):html.find('id="jg-filter"')]
s.check("the card now reads All-but-one: the unit's name, both screens",
        "ZZCF Cement" in card.split('data-cfr-row="cc"')[1].split("</tr>")[0] or "Cement" in card.split('data-cfr-row="cc"')[1].split("</tr>")[0])
rp = post(C_SU, "cc", units=[U1], screens=["tb"])
s.check("saving again with only the Talent Box ticked turns the BU CEO screen off for the ticked unit",
        state("cc", U1, "tb") and not state("cc", U1, "bu") and rows_of("calib_filter", filter_key="cc", shown=1) == 1
        and rows_of("calib_filter", filter_key="cc") == 2)
rp = post(C_SU, "cc", units=[], screens=["tb"])
s.check("an unticked unit goes off on both screens", not state("cc", U1, "tb") and not state("cc", U1, "bu"))
rp = post(C_SU, "branch", units=[U1, U2], screens=["bu"])
s.check("Branch on for two units, BU CEO screen only: its own filter_key, Cost centre untouched",
        state("branch", U1, "bu") and state("branch", U2, "bu") and not state("branch", U1, "tb")
        and rows_of("calib_filter", filter_key="branch", shown=1) == 2 and rows_of("calib_filter", filter_key="cc", shown=1) == 0)
rp0 = rows_of("calib_filter")
rp = post(C_SU, "branch", units=[U1, U2], screens=["bu"])
s.check("saving what is already so writes nothing and says so", rows_of("calib_filter") == rp0 and rp.status_code == 302)

# ---------------------------------------------------------------------------
s.section("the three that existed keep their own tables and their meaning")
with a.app.test_request_context("/"):
    db = a.get_db()
    # what production holds: a saved row from before this change, which a save must read and respect
    db.execute("INSERT INTO calib_dept_filter(business_group, company, view, shown) VALUES (?,?,'bu',1)", (BG, U2))
    db.execute("INSERT INTO calib_jg_filter(business_group, company, view, shown) VALUES (?,?,'tb',1)", (BG, U2))
    db.commit()
r, html = bg_card()
card = html[html.find('id="bu-filters"'):html.find('id="jg-filter"')]
dept_panel = card[card.find('data-panel="cf-dept"'):card.find('data-panel="cf-cal"')]
s.check("a row saved before reads as the unit being on: its box is ticked, its screen ticked",
        re.search(r'name="on_\d"[^>]*checked', dept_panel) is not None and re.search(r'data-cfr-screen="bu"[^>]*checked', dept_panel) is not None)
rp = post(C_SU, "dept", units=[U1], screens=["tb"])
s.check("Department: ticked Cement on the Talent Box, and Paint (on the BU CEO screen before) goes off: calib_dept_filter, as ever",
        state("dept", U1, "tb") and not state("dept", U2, "bu") and rows_of("calib_dept_filter", shown=1) == 1
        and one("SELECT COUNT(*) FROM calib_filter WHERE business_group=? AND filter_key='dept'", BG) == 0
        and rows_of("calib_jg_filter", shown=1) == 1, rp.status_code)
rp = post(C_SU, "jg", units=[U1, U2], screens=["bu", "tb"])
s.check("Job grade: the same shape in calib_jg_filter; its bands card is untouched",
        state("jg", U1, "bu") and state("jg", U2, "tb") and rows_of("calib_jg_filter", shown=1) == 4
        and rows_of("calib_jg_bands") == 0 and 'id="jg-filter"' in html)
rp = post(C_SU, "cal", units=[U1], screens=["tb"])
s.check("Calibrator: ticked as it is by default, nothing written", state("cal", U1, "tb") and rows_of("calib_cal_filter") == 0)
rp = post(C_SU, "cal", units=[], screens=["tb"])
s.check("...unticked: an explicit shown=0 row, so the leader's chip goes",
        not state("cal", U1, "tb") and rows_of("calib_cal_filter", shown=0) == 1)
rp = post(C_SU, "cal", units=[U1], screens=["tb"])
s.check("...and ticked again: back to shown", state("cal", U1, "tb") and rows_of("calib_cal_filter", shown=1) == 1)
rp = post(C_SU, "cal", units=[U1], screens=["bu", "tb"])
s.check("the BU CEO screen is refused for the Calibrator: nothing written", rp.status_code == 302 and not state("cal", U1, "bu")
        and rows_of("calib_cal_filter", view="bu") == 0)
with a.app.test_request_context("/"):
    st = a._st_bu_filters(a.get_db(), SU)
s.check("the settings sheet's line names every filter", all(x in st for x in ("DEPT:", "CAL:", "JG:", "CC:", "BRANCH:")), st)

# ---------------------------------------------------------------------------
s.section("refusals: the super admin only, only real units and registry keys, nothing half-written")
before = {t: rows_of(t) for t in TOUCHED}
rb = post(C_BGA, "cc", units=[U1], screens=["bu"]) if C_BGA else None
s.check("a BG admin's save is refused and writes nothing", rb is None or (
    rb.status_code in (302, 403) and {t: rows_of(t) for t in TOUCHED} == before), rb and rb.status_code)
rp = post(C_SU, "cc", units=[U1], screens=["bu"], unit_9="ZZCF Not A Unit", on_9="1")
s.check("a unit that is not the group's refuses the whole save", rp.status_code == 302 and {t: rows_of(t) for t in TOUCHED} == before)
rp = post(C_SU, "nope", units=[U1], screens=["bu"])
s.check("a key that is not in the registry is refused", {t: rows_of(t) for t in TOUCHED} == before)
rp = post(C_SU, "cal", units=[], screens=["bu"])
s.check("a screen the filter does not take is refused (the Calibrator has no BU CEO screen): its Talent Box switch is left as it was",
        state("cal", U1, "tb") and rows_of("calib_cal_filter", view="bu") == 0 and {t: rows_of(t) for t in TOUCHED} == before)
rp = post(C_SU, "cc", units=[U1], screens=["bu", "xx"])
s.check("an unknown screen refuses the whole save, even beside a real one", not state("cc", U1, "bu")
        and {t: rows_of(t) for t in TOUCHED} == before)
rp = post(C_SU, "cc", units=[U1], screens=[])
s.check("a ticked unit with no screen is refused (nothing to show it on)", {t: rows_of(t) for t in TOUCHED} == before)
rp = post(C_SU, "cc", units=[U1, U2], screens=["bu"])
s.check("a unit with no cost centres cannot be switched on: the server refuses the whole save, Cement included",
        not state("cc", U1, "bu") and not state("cc", U2, "bu") and {t: rows_of(t) for t in TOUCHED} == before)
rp = post(C_SU, "cc", units=[U3], screens=["bu"])
s.check("...nor a unit with nobody in it", not state("cc", U3, "bu") and {t: rows_of(t) for t in TOUCHED} == before)
rp = C_SU.post("/admin/settings/calib-filter", data={"csrf_token": "tok", "bg": "ZZCF No Such Group", "filter": "cc"})
s.check("a business group with no units is refused", rp.status_code == 302 and {t: rows_of(t) for t in TOUCHED} == before)
rp = C_SU.post("/admin/settings/calib-filter", data={"filter": "cc", "bg": BG, "unit_0": U1, "on_0": "1", "screen": "bu"})
s.check("no CSRF token, no write (falsifies the guard)", {t: rows_of(t) for t in TOUCHED} == before
        and not state("cc", U1, "bu"), rp.status_code)

# ---------------------------------------------------------------------------
s.section("the BU CEO's card carries only the chips switched on, in registry order")
with a.app.test_request_context("/"):   # a known state: nothing saved, then Department, Cost centre and Branch on for Cement
    db = a.get_db()
    for t in TOUCHED:
        db.execute("DELETE FROM %s WHERE business_group=?" % t, (BG,))
    db.commit()
post(C_SU, "cc", units=[U1], screens=["bu", "tb"])
post(C_SU, "branch", units=[U1], screens=["bu"])
post(C_SU, "dept", units=[U1], screens=["bu", "tb"])
with a.app.test_request_context("/"):
    db = a.get_db()
    pop = db.execute("SELECT * FROM users WHERE business_group=? AND company=? AND role!='admin' ORDER BY id", (BG, U1)).fetchall()
    ctx = {"period": {"id": PER}, "population": pop, "session": None, "overalls": {}, "scope_key": U1, "scope_label": U1,
           "business_group": BG}
    ov = a._pm_calib_assist_overview(db, SU, dict(ctx), "buceo", {"bg": BG, "company": U1})["data"]
    ov2 = a._pm_calib_assist_overview(db, SU, dict(ctx, scope_key=U2, scope_label=U2), "buceo", {"bg": BG, "company": U2})["data"]
    ov_hod = a._pm_calib_assist_overview(db, SU, dict(ctx, scope_key="9001"), "hod", {"hod_id": 9001})["data"]
s.check("Cement: Department, Cost centre and Branch (job grade is off; the Calibrator is the Talent Box's), in that order",
        [f["key"] for f in ov["filters"]] == ["dept", "cc", "branch"]
        and ov["filters"][1] == {"key": "cc", "label": "Cost centre", "chip": "CC", "bare": False, "plural": "cost centres", "proper": False,
                                 "field": "cost_center", "search": 9}, ov["filters"])
s.check("...the chip words ride along: CC for the cost centre, the label for Department and Branch, JG (bare) for Job grade",
        [f["chip"] for f in ov["filters"]] == ["Department", "CC", "Branch"]
        and [f["bare"] for f in ov["filters"]] == [False, False, False]
        and a.calib_filter_chip(a.calib_filter_def("jg")) == "JG" and a.calib_filter_def("jg").get("bare") is True
        and a.calib_filter_chip(a.calib_filter_def("cc")) == "CC"
        and a.calib_filter_chip(a.calib_filter_def("dept")) == "Department", ov["filters"])
s.check("...Paint has none switched on for the BU CEO screen; an HOD's review has no filter line",
        ov2["filters"] == [] and ov_hod["filters"] == [])
s.check("...each person's row carries the roster words the chips narrow by",
        all("cost_center" in p and "work_location" in p for p in ov["rows"])
        and {p["cost_center"] for p in ov["rows"]} >= set(CCS[:9]) | {""}
        and {p["work_location"] for p in ov["rows"]} == set(BRANCHES) | {""})
with a.app.test_request_context("/"):
    db = a.get_db()
SRC = H.source(a, "app.py")
s.check("the potential axis carries the same filters and the same row fields",
        '**(calib_card_filters(db, ctx, key[0]) if tier == "buceo"' in SRC   # 2026-11-02: via calib_card_filters (a calibrator's own set)
        and '"filters": calib_filters_payload(db, bg, units, view)}' in SRC
        and SRC.count("**calib_roster_fields(r[\"user\"]),") == 2)

# ---------------------------------------------------------------------------
s.section("the Talent Box: the chips, their counts within the picks before them, and a pick that narrows")
_avail = a.ai_draft.review_agent_available
a.ai_draft.review_agent_available = lambda: True
with a.app.test_request_context("/"):
    db = a.get_db()
    # place everyone (the box shows people by their bands); the BU CEO locked both axes
    pa = a._pm_calib_get_or_create_session(db, PER, "buceo", U1, BG, "Cement")
    ca = a._get_or_create_calibration_session(db, CID, "buceo", U1, BG, "Cement")
    for sid in P1 + [BOSS]:
        a._pm_calib_upsert_adjustment(db, pa["id"], sid, "", "ME", "BU set", BOSS)
        a._calibration_upsert_adjustment(db, ca["id"], sid, "", "Mid", "BU set", BOSS)
    db.execute("UPDATE pm_calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE id=?", (pa["id"],))
    db.execute("UPDATE calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE id=?", (ca["id"],))
    db.commit()
C_B = H.client_as(a, BOSS)
HQ = "/review/chat/history?journey=1&view=bg&stage=talent_box&company=" + U1.replace(" ", "+")


def tbox(q=""):
    return ((C_B.get(HQ + q).get_json() or {}).get("overview") or {}).get("data") or {}


def ids_of(d):
    return {p["id"] for c in d.get("cells") or [] for p in c["people"]} | {u["id"] for u in d.get("unplaced") or []}


def chip(d, key):
    return next((f for f in d.get("filters") or [] if f["key"] == key), None)


d0 = tbox()
s.check("the unit's whole box: 13 people (the CEO and twelve); chips for Department, Calibrator, Cost centre (job grade and "
        "branch's Talent Box switch are off) in registry order",
        len(ids_of(d0)) == 13 and [f["key"] for f in d0.get("filters") or []] == ["dept", "cal", "cc"],
        ([f["key"] for f in d0.get("filters") or []], len(ids_of(d0))))
cc0 = chip(d0, "cc") or {}
s.check("Cost centre: its ten values with their counts, 'Not set on the roster' for the two without one, the search flag at "
        "nine or more values",
        len(cc0.get("options") or []) == 10 and cc0.get("not_set") == 2 and cc0.get("search") is True
        and cc0.get("all") == 13 and sum(o["n"] for o in cc0["options"]) + cc0["not_set"] == 13
        and next(o["n"] for o in cc0["options"] if o["key"] == CCS[0]) == 2, cc0 and (cc0.get("not_set"), cc0.get("all")))
s.check("...the first chips' words: Department has two values, Calibrator is Everyone / BU CEO / its group",
        len((chip(d0, "dept") or {}).get("options") or []) == 2 and {o["key"] for o in (chip(d0, "cal") or {}).get("options") or []}
        <= {"ceo", "grp:%d" % gid})
d1 = tbox("&cc=" + CCS[0])
s.check("picking a cost centre narrows the box to its people (the CEO and the first), the counts and both curves follow, the lock "
        "stays the whole unit's",
        d1.get("placed") == 2 and len(ids_of(d1)) == 2 and chip(d1, "cc")["value"] == CCS[0]
        and (d1.get("perf_curve") or {}).get("total") == 2 and d1.get("bu_people") == 13 and d1.get("lock_company") == U1
        and d1.get("show_n") == 2 and d1.get("show_m") == 13, (d1.get("placed"), d1.get("show_n"), d1.get("show_m")))
dn = tbox("&cc=" + a.CALIB_NOT_SET)
s.check("'Not set on the roster' is an explicit pick: exactly the two without a cost centre",
        len(ids_of(dn)) == 2 and chip(dn, "cc")["value"] == a.CALIB_NOT_SET and chip(dn, "cc")["value_label"] == "Not set",
        len(ids_of(dn)))
dx = tbox("&cc=ZZCF-NO-SUCH-CC")
s.check("a value the unit does not hold (or a crafted one) is ignored: the whole unit", len(ids_of(dx)) == 13
        and chip(dx, "cc")["value"] == "", len(ids_of(dx)))
dsq = tbox("&cc=" + CCS[0].replace("-", "%2D") + "%27%3B+DROP+TABLE+users%3B--")
s.check("...a crafted string is just text that matches nothing", len(ids_of(dsq)) == 13)
dd = tbox("&dept=" + DEPT_A.replace(" ", "+") + "&cc=" + CCS[1])
dd_n = len(ids_of(dd))
s.check("the chips count within the picks before them: Cost centre after Department lists only that department's values",
        chip(dd, "dept")["value"] == DEPT_A
        and sum(o["n"] for o in chip(dd, "cc")["options"]) + chip(dd, "cc")["not_set"] == chip(dd, "cc")["all"]
        and chip(dd, "cc")["earlier"] == [DEPT_A], (chip(dd, "cc") or {}).get("earlier"))
s.check("...a cost centre nobody in that department holds is dropped, as a department nobody holds is",
        chip(dd, "cc")["value"] in ("", CCS[1]) and (chip(dd, "cc")["value"] == "") == (CCS[1] not in {
            o["key"] for o in chip(dd, "cc")["options"]}) and dd_n >= 1)
# Branch on for the Talent Box too: it counts within the cost centre picked
post(C_SU, "branch", units=[U1], screens=["bu", "tb"])
db1 = tbox("&dept=" + DEPT_B.replace(" ", "+"))
bch = chip(db1, "branch") or {}
s.check("Branch (on for the Talent Box now) comes last and counts within the picks before it: Ops's six, three on Klang, three "
        "with none",
        [f["key"] for f in db1.get("filters") or []] == ["dept", "cc", "branch"]   # the group holds all of Ops: no choice to make
        and bch.get("all") == 6 and [(o["key"], o["n"]) for o in bch.get("options") or []] == [(BRANCHES[1], 3)]
        and bch.get("not_set") == 3 and bch.get("earlier") == [DEPT_B],
        (bch and (bch.get("all"), bch.get("options"), bch.get("not_set"), bch.get("earlier")), [f["key"] for f in db1.get("filters") or []]))
dbp = tbox("&branch=" + BRANCHES[0].replace(" ", "+"))
s.check("a branch narrows by its people", 0 < len(ids_of(dbp)) < 13 and chip(dbp, "branch")["value"] == BRANCHES[0]
        and all(p in ids_of(d0) for p in ids_of(dbp)))
dboth = tbox("&cc=%s&branch=%s" % (CCS[0], BRANCHES[0].replace(" ", "+")))
s.check("the two picks narrow together (the people who pass both)", ids_of(dboth) <= ids_of(d1) & ids_of(dbp), len(ids_of(dboth)))

# ---- several values in one filter (Chris, 2026-10-30, canvas board E): a person matches ANY ticked value of a filter, the
# filters combine, a value the unit lacks drops out of the list while the good ones stay
s.section("several values in one filter: any of them within a filter, all the filters together (canvas board E)")
d_c1 = tbox("&cc=" + CCS[1])
d_cc2 = tbox("&cc=%s&cc=%s" % (CCS[0], CCS[1]))
cc2 = chip(d_cc2, "cc") or {}
s.check("two cost centres narrow the box to the UNION of their people (each alone is smaller), the counts follow",
        ids_of(d_cc2) == ids_of(d1) | ids_of(d_c1) and len(ids_of(d_cc2)) > len(ids_of(d1)) and len(ids_of(d_cc2)) > len(ids_of(d_c1))
        and d_cc2.get("show_n") == len(ids_of(d_cc2)) and d_cc2.get("show_m") == 13
        and (d_cc2.get("perf_curve") or {}).get("total") == len(ids_of(d_cc2)), (len(ids_of(d_cc2)), len(ids_of(d1)), len(ids_of(d_c1))))
s.check("...the chip carries every value (values / value_labels in step), `value` stays the first, the 'earlier' foot of the "
        "chips after it names '2 cost centres'",
        cc2.get("values") == [CCS[0], CCS[1]] and cc2.get("value_labels") == [CCS[0], CCS[1]] and cc2.get("value") == CCS[0]
        and cc2.get("value_label") == CCS[0] and (d_cc2.get("picks") or {}).get("cc") == [CCS[0], CCS[1]],
        (cc2.get("values"), cc2.get("value_labels"), d_cc2.get("picks")))
s.check("falsified: ONE cost centre is the same list with one item (the single-value URL still works) and narrows to just those people",
        (chip(d1, "cc") or {}).get("values") == [CCS[0]] and ids_of(d1) < ids_of(d_cc2) and (d1.get("picks") or {}).get("cc") == [CCS[0]])
d_bog = tbox("&cc=%s&cc=ZZCF-NO-SUCH-CC&cc=%s&cc=%s" % (CCS[0], CCS[1], CCS[0]))
s.check("a bogus value among good ones is dropped (and a repeat is counted once): the good two stay, the box is the union",
        (chip(d_bog, "cc") or {}).get("values") == [CCS[0], CCS[1]] and ids_of(d_bog) == ids_of(d_cc2), (chip(d_bog, "cc") or {}).get("values"))
s.check("falsified: only bogus values are all dropped, the whole unit",
        len(ids_of(tbox("&cc=ZZCF-NO-SUCH-CC&cc=ZZCF-NO-SUCH-2"))) == 13 and (chip(tbox("&cc=ZZCF-NO-SUCH-CC&cc=ZZCF-NO-SUCH-2"), "cc") or {}).get("values") == [])
d_ns = tbox("&cc=%s&cc=%s" % (CCS[0], a.CALIB_NOT_SET))
s.check("'Not set on the roster' is tickable like a value: one cost centre or none = their union",
        ids_of(d_ns) == ids_of(d1) | ids_of(dn) and (chip(d_ns, "cc") or {}).get("values") == [CCS[0], a.CALIB_NOT_SET]
        and (chip(d_ns, "cc") or {}).get("value_labels") == [CCS[0], "Not set"], (chip(d_ns, "cc") or {}).get("value_labels"))
d_cb = tbox("&cc=%s&cc=%s&branch=%s" % (CCS[0], CCS[1], BRANCHES[0].replace(" ", "+")))
s.check("filters combine: two cost centres AND a branch = the people who are in either cost centre and in that branch",
        ids_of(d_cb) == ids_of(d_cc2) & ids_of(dbp) and 0 < len(ids_of(d_cb)) < len(ids_of(d_cc2)), (len(ids_of(d_cb)), len(ids_of(d_cc2)), len(ids_of(dbp))))
d_br2 = tbox("&branch=%s&branch=%s" % (BRANCHES[0].replace(" ", "+"), BRANCHES[1].replace(" ", "+")))
s.check("two branches = the union of the two, and the Branch chip counts within the cost centres before it",
        ids_of(d_br2) == ids_of(dbp) | ids_of(tbox("&branch=" + BRANCHES[1].replace(" ", "+"))) and len(ids_of(d_br2)) > len(ids_of(dbp)),
        (len(ids_of(d_br2)), len(ids_of(dbp))))
d_dd = tbox("&dept=%s&dept=%s&cc=%s" % (DEPT_A.replace(" ", "+"), DEPT_B.replace(" ", "+"), CCS[0]))
cc_dd = chip(d_dd, "cc") or {}
s.check("counts within the earlier picks: after two departments the Cost centre chip counts within them and its foot names '2 departments'",
        (chip(d_dd, "dept") or {}).get("values") == [DEPT_A, DEPT_B] and cc_dd.get("earlier") == ["2 departments"]
        and cc_dd.get("all") == 13 and d_dd.get("dept") == "" and ids_of(d_dd) == ids_of(d1),
        (cc_dd.get("earlier"), cc_dd.get("all"), d_dd.get("dept")))
d_dp1 = tbox("&dept=" + DEPT_A.replace(" ", "+"))
s.check("falsified: ONE department keeps `dept` (the title bar's word) and the foot names it; two departments leave `dept` empty",
        d_dp1.get("dept") == DEPT_A and (chip(tbox("&dept=%s&cc=%s" % (DEPT_A.replace(" ", "+"), CCS[0])), "cc") or {}).get("earlier") in ([DEPT_A], None))
d_cal2 = tbox("&cal=ceo&cal=grp:%d" % gid)
d_cal_a, d_cal_b = tbox("&cal=ceo"), tbox("&cal=grp:%d" % gid)
cal_chip = chip(d0, "cal") or {}
s.check("the Calibrator takes several too: the union of their people (a person in two groups is counted once); each option carries its people (ids) for the list's count",
        ids_of(d_cal2) == ids_of(d_cal_a) | ids_of(d_cal_b) and all(isinstance(o.get("ids"), list) for o in cal_chip.get("options") or [])
        and len(ids_of(d_cal2)) <= 13, (len(ids_of(d_cal2)), len(ids_of(d_cal_a)), len(ids_of(d_cal_b))))
with a.app.test_request_context("/?cc=%s&cc=%s&cc=%s" % ("  A  ", "A", "B" * 200)):
    _pl = a._pick_list(a.request.args.getlist("cc"))
with a.app.test_request_context("/", method="POST", data={"cc": ["x1", "x2"], "dept": "solo"}):
    _post_x = a._journey_talent_box_extra("cc", U1)
    _post_d = a._pick_list(a.request.values.getlist("dept"))
s.check("the readers take repeated params: query string and form alike; trimmed, de-duplicated, cut at 120 characters; a lone value is a one-item list",
        _pl == ["A", "B" * 120] and _post_x == ["x1", "x2"] and _post_d == ["solo"] and a._pick_list("one") == ["one"]
        and a._pick_list(None) == [] and a._pick_list(["", "  "]) == [] and len(a._pick_list([str(i) for i in range(500)])) == 40,
        (_pl, _post_x, _post_d))
with a.app.test_request_context("/?cc=" + CCS[0]):   # the admin's copy passes its company: never the chat's pick
    from flask import session as _ss
    _ss["user_id"] = BOSS
    db = a.get_db()
    _boss = db.execute("SELECT * FROM users WHERE id=?", (BOSS,)).fetchone()
    _adm = a._journey_talent_box_overview(db, dict(_boss), sc=a._journey_talent_box_scope(db, _boss), company=U1)
s.check("the admin's copy shows the whole unit whatever the request says", _adm and chip(_adm, "cc")["value"] == ""
        and _adm.get("placed") == 13, _adm and _adm.get("placed"))
# nothing to choose between: no chip
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("UPDATE users SET cost_center=? WHERE business_group=? AND company=?", (CCS[0], BG, U1))
    db.commit()
dflat = tbox()
s.check("one value and nobody without it: nothing to choose between, no chip", chip(dflat, "cc") is None)
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("UPDATE users SET cost_center=NULL WHERE business_group=? AND company=? AND id IN (%s)" % ",".join(
        "?" * 3), [BG, U1] + P1[:3])
    db.commit()
dtwo = tbox()
s.check("...but one value and some without it is a choice (the value and Not set)", (chip(dtwo, "cc") or {}).get("not_set") == 3
        and len(chip(dtwo, "cc")["options"]) == 1, chip(dtwo, "cc"))
# switch it off: a pick counts for nothing
post(C_SU, "cc", units=[], screens=["tb"])
doff = tbox("&cc=" + CCS[0])
s.check("switched off for the Talent Box: no chip, and a pick asked for is ignored (the whole unit)",
        chip(doff, "cc") is None and len(ids_of(doff)) == 13, len(ids_of(doff)))

# ---------------------------------------------------------------------------
s.section("the admin's Talent Box carries EVERY filter the unit has values for, whatever the Settings rules say (canvas board D)")
import json as _json
import urllib.parse as _up


def admin_tb(extra="", client=None):
    """What admin_talent_box hands the builder: (route status, page text, the line's data, the cells' data)."""
    r = (client or C_SU).get("/admin/calibration/talent-box?bg=%s&company=%s%s" % (_up.quote(BG), _up.quote(U1), extra))
    picks = {k: v[0] for k, v in _up.parse_qs(extra.lstrip("&")).items()}
    with a.app.test_request_context("/"):
        db = a.get_db()
        su = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        ctx = a._talent_box_resolve(db, su, "bgceo", admin_view=True, bg=BG)
        d = a._journey_talent_box_overview(db, su, ("bgceo", {"bg": BG}, ctx), company=U1, all_filters=True, picks=picks)
    return r, r.get_data(as_text=True), d, d


def fkeys(fl):
    return [f["key"] for f in (fl or {}).get("filters") or []]


# rules: Department ON, Calibrator ON (default), Cost centre OFF, Job grade OFF, Branch ON (set above)
post(C_SU, "cc", units=[], screens=["bu", "tb"])
post(C_SU, "jg", units=[], screens=["bu", "tb"])
post(C_SU, "dept", units=[], screens=["bu", "tb"])
post(C_SU, "cal", units=[], screens=["tb"])
post(C_SU, "branch", units=[], screens=["bu", "tb"])
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("UPDATE users SET cost_center=? WHERE business_group=? AND company=? AND id IN (%s)" % ",".join("?" * 6),
               [CCS[0], BG, U1] + P1[:6])
    db.execute("UPDATE users SET cost_center=? WHERE business_group=? AND company=? AND id IN (%s)" % ",".join("?" * 6),
               [CCS[1], BG, U1] + P1[6:12])
    db.commit()
d_ldr = tbox()
r_a, h_a, fl_a, pl_a = admin_tb()
s.check("every rule OFF: the leader's payload has no chips, the admin's page still draws the unit's filters, in registry order",
        r_a.status_code == 200 and d_ldr.get("filters") == [] and fl_a and fkeys(fl_a) == [k for k in a.CALIB_FILTER_KEYS if k in fkeys(fl_a)]
        and {"dept", "jg", "cc", "branch"} <= set(fkeys(fl_a)), (r_a.status_code, d_ldr.get("filters"), fkeys(fl_a)))
post(C_SU, "cc", units=[U1], screens=["bu", "tb"])
d_on = tbox()
s.check("falsified: switching the Cost centre rule ON gives the leader the chip, and the admin's line is the same either way",
        "cc" in [f["key"] for f in d_on.get("filters") or []] and "cc" in fkeys(admin_tb()[2]))
post(C_SU, "cc", units=[], screens=["bu", "tb"])
cc_ids_all = {p["id"] for c in pl_a["cells"] for p in c["people"]}
r_b, h_b, fl_b, pl_b = admin_tb("&cc=" + _up.quote(CCS[0]))
ids_b = {p["id"] for c in pl_b["cells"] for p in c["people"]}
want_b = {uid for uid in P1 + [BOSS] if one("SELECT cost_center FROM users WHERE id=?", uid) == CCS[0]}
s.check("?cc= narrows the grid, the cells' sum, the people and the 'Showing N of M' to that cost centre's people",
        ids_b and ids_b <= cc_ids_all and ids_b <= want_b and pl_b["placed"] == sum(c["n"] for c in pl_b["cells"]) == len(ids_b)
        and fl_b["show_n"] == len(ids_b)
        and fl_b["show_m"] == fl_a["show_m"] and len(ids_b) < len(cc_ids_all)
        and next(f for f in fl_b["filters"] if f["key"] == "cc")["value"] == CCS[0], (len(ids_b), len(want_b), fl_b["show_n"]))
r_d, h_d, fl_d, pl_d = admin_tb("&cc=ZZCF-NO-SUCH&dept=ZZ-NO-DEPT&jg=99&cal=grp:0&branch=%27%3Bdrop")
s.check("falsified: bogus values for every param are dropped (the whole unit), nothing picked, no Clear",
        r_d.status_code == 200 and {p["id"] for c in pl_d["cells"] for p in c["people"]} == cc_ids_all
        and not any(f["value"] for f in fl_d["filters"]))
r_e, h_e, fl_e, pl_e = admin_tb("&dept=" + _up.quote(DEPT_B))
ids_e = {p["id"] for c in pl_e["cells"] for p in c["people"]}
s.check("a department narrows the cells, the unplaced and the counts (one builder: the same as the leader's)",
        ids_e and ids_e < cc_ids_all and all(p["dept"] == DEPT_B for c in pl_e["cells"] for p in c["people"])
        and all((u.get("dept") or "") == DEPT_B for u in pl_e["unplaced"]) and fl_e["show_n"] == len(ids_e) + len(pl_e["unplaced"]))
if C_BGA is not None and BGA["admin_bg"] not in (None, "", BG):
    r_f, h_f, fl_f, pl_f = admin_tb(client=C_BGA)
    s.check("a BG admin of another group cannot read this group's box (the page falls to their own group: none of its people)",
            U1 not in h_f and "ZZCF-" not in h_f, r_f.status_code)

# ---------------------------------------------------------------------------
s.section("a column added to the registry is ONE entry: coverage, has-values, the settings row and the leaders' payloads follow")
_REG0, _KEYS0 = a.CALIB_FILTERS, a.CALIB_FILTER_KEYS
EMP = {"key": "emp", "label": "Employment type", "plural": "employment types", "code": "EMP", "note": "", "views": ("bu", "tb"),
       "table": None, "default": False, "column": "employment_type", "proper": False,
       "sub": "From the roster's employment type", "noun": "employment type"}
with a.app.test_request_context("/"):   # Cement: two types and some blank; Paint: nobody has one
    db = a.get_db()
    db.execute("DELETE FROM calib_filter WHERE business_group=?", (BG,))
    for t in ("calib_dept_filter", "calib_jg_filter", "calib_cal_filter"):
        db.execute("DELETE FROM %s WHERE business_group=?" % t, (BG,))
    # everyone in the group starts with none (person() copies a real row's, BOSS included), then P1 gets theirs
    db.execute("UPDATE users SET employment_type=NULL WHERE business_group=?", (BG,))
    for i, uid in enumerate(P1):
        db.execute("UPDATE users SET employment_type=? WHERE id=?", (None if i >= 9 else ("Permanent", "Contract")[i % 2], uid))
    db.commit()
try:
    a.CALIB_FILTERS = a.CALIB_FILTERS + (EMP,)
    a.CALIB_FILTER_KEYS = tuple(f["key"] for f in a.CALIB_FILTERS)
    with a.app.test_request_context("/"):
        db = a.get_db()
        cov = a.calib_filter_coverage(db, BG)
        ctx_ = a._bu_filters_ctx(db, BG)
        st_ = a._st_bu_filters(db, SU)
    s.check("coverage counts the new column per unit (have, distinct): Cement 9 of 13, two types; Paint none",
            cov[U1]["emp"] == (9, 2) and cov[U2]["emp"] == (0, 0), (cov[U1].get("emp"), cov[U2].get("emp")))
    s.check("has_values: true where someone has one, false where nobody does (and still false for a key nobody knows)",
            a.calib_filter_has_values("emp", cov[U1], 0) and not a.calib_filter_has_values("emp", cov[U2], 0)
            and not a.calib_filter_has_values("zzz", cov[U1], 0))
    row = next((f for f in ctx_["filters"] if f["key"] == "emp"), None) or {}
    r1 = next((r for r in row.get("rows", []) if r["company"] == U1), {})
    r2 = next((r for r in row.get("rows", []) if r["company"] == U2), {})
    s.check("the settings row and its panel rows: '9 of 13 have one · 2 employment types'; Paint disabled, 'No one has an employment type'",
            row.get("label") == "Employment type" and row.get("code_line") == "EMP" and r1.get("cover") == "9 of 13 have one · 2 employment types"
            and r2.get("disabled") and r2.get("reason") == "No one has an employment type", (r1, r2))
    s.check("...and the sheet's line names it", "EMP:" in st_, st_)
    r, html = bg_card()
    s.check("the card draws its row and panel with no template change", 'data-cfr-row="emp"' in html and 'data-panel="cf-emp"' in html
            and "Employment type filter" in html)
    rp = post(C_SU, "emp", units=[U1], screens=["bu", "tb"])
    with a.app.test_request_context("/"):
        db = a.get_db()
        on_ = a.calib_filter_on(db, BG, "emp", U1, "tb") and a.calib_filter_on(db, BG, "emp", U1, "bu")
        pop = db.execute("SELECT * FROM users WHERE business_group=? AND company=? AND role!='admin' ORDER BY id", (BG, U1)).fetchall()
        ctx = {"period": {"id": PER}, "population": pop, "session": None, "overalls": {}, "scope_key": U1, "scope_label": U1,
               "business_group": BG}
        ov = a._pm_calib_assist_overview(db, SU, dict(ctx), "buceo", {"bg": BG, "company": U1})["data"]
    s.check("saving it writes calib_filter under its own key (the route needed no change)", rp.status_code == 302 and on_
            and rows_of("calib_filter", filter_key="emp", shown=1) == 2)
    s.check("the BU CEO's card: the chip spec names its field and every row carries it",
            [f["key"] for f in ov["filters"]] == ["emp"] and ov["filters"][0]["field"] == "employment_type"
            and {p["employment_type"] for p in ov["rows"]} == {"Permanent", "Contract", ""}, ov["filters"])
    with a.app.test_request_context("/"):
        db = a.get_db()
        pa = a._pm_calib_get_or_create_session(db, PER, "buceo", U1, BG, "Cement")
        ca = a._get_or_create_calibration_session(db, CID, "buceo", U1, BG, "Cement")
        for sid in P1 + [BOSS]:
            a._pm_calib_upsert_adjustment(db, pa["id"], sid, "", "ME", "BU set", BOSS)
            a._calibration_upsert_adjustment(db, ca["id"], sid, "", "Mid", "BU set", BOSS)
        db.execute("UPDATE pm_calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE id=?", (pa["id"],))
        db.execute("UPDATE calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE id=?", (ca["id"],))
        db.commit()
    _a0 = a.ai_draft.review_agent_available
    a.ai_draft.review_agent_available = lambda: True
    dt = tbox("&emp=Contract")
    dt0 = tbox()
    a.ai_draft.review_agent_available = _a0
    ch = chip(dt0, "emp") or {}
    s.check("the Talent Box: the chip appears with its values and 'Not set' counted, and ?emp= (the registry key) narrows the box",
            [(o["key"], o["n"]) for o in ch.get("options") or []] == [("Contract", 4), ("Permanent", 5)] and ch.get("not_set") == 4
            and len(ids_of(dt)) == 4 and (chip(dt, "emp") or {}).get("value") == "Contract",
            (ch.get("options"), ch.get("not_set"), len(ids_of(dt))))
finally:
    a.CALIB_FILTERS, a.CALIB_FILTER_KEYS = _REG0, _KEYS0
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("DELETE FROM calib_filter WHERE business_group=?", (BG,))
        db.execute("UPDATE users SET employment_type=NULL WHERE business_group=?", (BG,))
        db.commit()
s.check("the registry is put back", [f["key"] for f in a.CALIB_FILTERS] == ["dept", "cal", "jg", "cc", "branch"])

# ---------------------------------------------------------------------------
s.section("the client draws ONE filter line; the old rows and their CSS are gone")
JS = H.chat_js(a)
_fc = JS[JS.index("function flChip("):JS.index("function flOpen(")]
s.check("the client's chip prefix reads c.chip (a bare value starting with it shows alone), the tight form chip || label, the hover keeps the full label",
        'c.bare && vt.indexOf(c.chip + " ") === 0 ? "" : c.chip + ": "' in _fc and 'c.chip || c.label' in _fc
        and "b.title = c.label" in _fc and JS.count("chip: f.chip || f.label, bare: !!f.bare,") == 2)
CSS = H.source(a, "static/style.css")
ADM = H.source(a, "static/calib_filter_rules.js")


def fn(name, src=JS):
    i = src.find("function %s(" % name)
    return src[i:src.find("\n  }\n", i)] if i >= 0 else ""


s.check("one builder for both screens: a chip is a button with aria-expanded, its list a listbox of options, Esc and outside "
        "click close it, the arrow keys move",
        'b.setAttribute("aria-haspopup", "listbox"); b.setAttribute("aria-expanded", "false");' in JS
        and 'list.setAttribute("role", "listbox")' in JS and 'r.setAttribute("role", "option")' in JS
        and 'e.key === "Escape"' in fn("flOpen") and 'e.key === "ArrowDown"' in fn("flOpen")
        and 'document.addEventListener("mousedown", onDoc, true)' in fn("flOpen"))
s.check("...the line reads Filter, the chips, Showing N of M and Clear only once something is picked",
        '"Filter"' in fn("flLine") and '"Showing " + cfg.showN + " of " + cfg.showM' in fn("flLine")
        and "if (cfg.picked) {" in fn("flLine") and '"Clear"' in fn("flLine"))
s.check("...a search box from nine values, 'Not set on the roster', and the 'Counted within' foot",
        "if (c.search) {" in fn("flOpen") and '"Not set on the roster"' in fn("flOpen") and '"Counted within "' in fn("flOpen"))
s.check("BU CEO: the strip holds the joined-units row (kept) and the line; a pick narrows the roster and the curve",
        "var line = calFilterLine(d, rows);" in fn("calFilterBar") and 'grPillRow("BU"' in fn("calFilterBar")
        and 'grPillRow("Dept"' not in JS and 'grPillRow("JG"' not in JS
        and "&& calInX(d, r)" in fn("calFiltered") + fn("calMovedBtn") and "calXPicked(d)" in fn("calFiltered"))
s.check("Talent Box: the BU pill row stays; the line goes under it; a pick re-reads the box server-side with cc and branch riding along",
        "var frow = tbFilterLine(d);" in JS and "function tbSelectFilter(key, vals)" in JS
        and 'TB_FKEYS = ["seg", "gbg", "dept", "cal", "jg", "cc", "branch"]' in JS   # a Group Chief's Segment and Business group joined (2026-11-02)
        and 'out += "&" + tbParam(k) + "=" + encodeURIComponent(v)' in JS
        and "(tb[k] || []).forEach(function (v) { f.append(tbParam(k), v); })" in JS and "tbPicksForm(f);" in JS
        and "tb.company = co; TB_FKEYS.forEach(function (k) { tb[k] = []; });" in JS)
s.check("focus returns to the chip of the live card, looked up inside its own body, never page-wide (one live widget)",
        "function flFocus(key)" in JS and "var root = stageCard.body || stageCard.node;" in fn("flFocus")
        and "document.querySelector('.rv-cal-chip" not in JS and "document.querySelector(\".rv-cal-chip" not in JS
        and JS.count("flFocus(key)") >= 3)
s.check("the retired builders are gone (a Group Chief's batch pills too, 2026-11-02: Segment is the first chip of their line)",
        "function tbCalRow(" not in JS and "function tbJgRow(" not in JS and "function tbSelectJg(" not in JS
        and "function tbSelectCal(" not in JS and "function tbDeptRow(d)" not in JS and "var drow = d.group" not in JS
        and "function tbSelectDept(" not in JS)

# ---------------------------------------------------------------------------
s.section("the client: several values in one filter, ticked then applied (canvas board E; ships after the freeze)")
import json as _js
import shutil as _sh
import subprocess as _sp
SH = H.source(a, "static/calib_shared.js")
_fo, _fch, _fl = fn("flOpen", SH), fn("flChip", SH), fn("flLine", SH)
s.check("the list is a multi-select listbox: aria-multiselectable, a tick box on every row (the 'All' row included), rows are options with aria-selected",
        'list.setAttribute("aria-multiselectable", "true")' in _fo and 'rmkEl("span", "rv-cal-opt-box")' in _fo
        and 'r.setAttribute("role", "option")' in _fo and 'r.classList.toggle("is-on", on); r.setAttribute("aria-selected", on ? "true" : "false");' in _fo
        and "if (!o.all)" not in _fo)
s.check("ticking applies as it is made (Chris, 2026-10-31): a row's click toggles and waits FL_WAIT, then one onPick, and none when the set equals what is applied",
        'r.addEventListener("click", function () { toggle(o.key); });' in _fo and _fo.count("onPick(") == 1
        and "var FL_WAIT = 250;" in SH and "timer = setTimeout(flush, FL_WAIT)" in _fo and "ctx.onPick(ctx.c.key, keys);" in _fo
        and "was.indexOf(k) >= 0" in _fo and "paint(); later();" in _fo and 'clr.addEventListener("click", function () { pend = {}; paint(); later(); });' in _fo
        and "if (ctx.live)" in _fo)
s.check("the foot says '<n> picked . <m> people' (None picked with none) and has Clear (unticks and applies) and Done (no Apply button)",
        '" picked" : "None picked"' in _fo and '(m === 1 ? " person" : " people")' in _fo and 'rmkEl("button", "rv-cal-pop-clear", "Clear")' in _fo
        and 'rmkEl("button", "rv-cal-pop-apply", "Done")' in _fo and '"Apply"' not in _fo)
s.check("Esc, Tab, an outside click and Done close the list and hand a pending pick on first (nothing ticked is undone); Space ticks, Enter is Done, arrows move; the search only hides rows",
        'if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); flClose(true); return; }' in _fo
        and 'if (e.key === "Tab") { flClose(false); return; }' in _fo and 'e.key === " " && i >= 0' in _fo and 'done(); }   // Enter is Done' in _fo
        and "var onDoc = function (e) { if (!pop.contains(e.target) && !ctx.chip.contains(e.target)) flClose(false); };" in _fo
        and "if (!drop) p.flush();" in fn("flClose", SH) and "o.hidden = !!t &&" in _fo and "pend" not in _fo[_fo.index("q.addEventListener"):])
s.check("the list follows its chip: a capture-phase scroll listener (the list's own scroll ignored) places it again and closes it once the chip is out of sight; the redrawn chip adopts it; flFocus leaves an open list alone; the Talent Box's newest read wins",
        'document.addEventListener("scroll", onScroll, { capture: true, passive: true })' in _fo and "pop.contains(e.target)" in _fo
        and "flChipVisible(ctx.chip)" in _fo and 'document.removeEventListener("scroll", p.onScroll, true)' in fn("flClose", SH)
        and "flPop.adopt(c, onPick);" in _fch and "if (CAL.flIsOpen(key)) return;" in fn("flFocus")
        and "mine !== tbRefreshSeq" in JS and "var mine = ++tbRefreshSeq;" in JS)
s.check("the admin's Talent Box reloads the page on a pick, so its line is not live: the ticks go on when the list closes",
        "live: false" in H.source(a, "static/admin_talent_box.js") and "cfg.live" in fn("flLine", SH))
s.check("the chip: one value as before ('CC: North - Sales', a bare 'JG 12-14'), two or more '<chip>: <n> picked' with the count, every value in the hover",
        'vals.length + " picked"' in _fch and 'c.chip + ": "' in _fch and "flCountOf(c)" in _fch
        and 'b.title = c.label + (vals.length ? ": " + vals.map(' in _fch and '.join(", ")' in _fch)
s.check("the BU CEO's card keeps arrays (cf.dept / jg / cc / branch), narrows by ANY value of a filter and AND across filters, and the TB state is arrays sent as repeated params",
        "var cf = { key: \"\", dept: [], moved: false, unit: \"\", jg: [], cc: [], branch: []" in JS.replace("'", '"')
        or 'dept: [], moved: false, unit: "", jg: [], cc: [], branch: [], band: "" }' in JS)
for sel in (".rv-cal-opt-box {", ".rv-cal-pop-act {", ".rv-cal-pop-apply {", ".rv-cal-pop-clear {"):
    s.check("CSS has " + sel, sel in H.source(a, "static/style.css"))
if _sh.which("node"):
    def _node(src):
        o = _sp.run(["node", "-"], input=src, capture_output=True, text=True, timeout=60)
        return _js.loads(o.stdout) if o.returncode == 0 and o.stdout.strip() else ("err", (o.stderr or o.stdout)[:400])
    _pre = "var window = { onehrProper: function (s) { return String(s).toUpperCase(); } };\n" + SH + "\nvar C = window.OneHRCalib;\n"
    _cc = {"label": "Cost centre", "plural": "cost centres", "proper": False, "all": 20, "notSet": 2,
           "options": [{"key": "a", "label": "A", "n": 8}, {"key": "b", "label": "B", "n": 3}, {"key": "c", "label": "C", "n": 7}]}
    _cal = {"label": "Calibrator", "plural": "calibrators", "all": 10, "notSet": 0,
            "options": [{"key": "ceo", "label": "BU CEO", "n": 6, "ids": [1, 2, 3, 4, 5, 6]}, {"key": "g1", "label": "G", "n": 4, "ids": [4, 5, 6, 7]}]}
    got = _node(_pre + "console.log(JSON.stringify([" + ",".join([
        "C.flMatchN(%s, [])" % _js.dumps(_cc), "C.flMatchN(%s, ['a','b'])" % _js.dumps(_cc),
        "C.flMatchN(%s, ['a','~none'])" % _js.dumps(_cc), "C.flMatchN(%s, ['ceo','g1'])" % _js.dumps(_cal),
        "C.flMatchN(%s, ['g1'])" % _js.dumps(_cal),
        "C.pickWords(Object.assign({values: ['a'], valueLabels: ['A']}, %s))" % _js.dumps(_cc),
        "C.pickWords(Object.assign({values: ['a','b']}, %s))" % _js.dumps(_cc),
        "C.pickWords(Object.assign({values: ['~none']}, %s))" % _js.dumps(_cc),
        "C.pickWords(Object.assign({values: []}, %s))" % _js.dumps(_cc),
        "C.pickWords(Object.assign({}, %s, {proper: true, values: ['a'], valueLabels: ['north']}))" % _js.dumps(_cc),
        "C.chipFromServer({key:'cc',label:'Cost centre',value:'a',value_label:'A',options:[],plural:'x'}).values",
        "C.chipFromServer({key:'cc',label:'Cost centre',values:['a','b'],value_labels:['A','B'],value:'a',options:[],plural:'x'}).valueLabels"]) + "]));")
    s.check("the client counts what ticks hold (node): none = all, values add up, 'Not set' adds the unset, a calibrator's people are united; pickWords says one value, '2 cost centres', 'no cost centre', nothing",
            got == [20, 11, 10, 7, 4, "A", "2 cost centres", "no cost centre", "", "NORTH", ["a"], ["A", "B"]], got)
    s.check("falsified: two calibrators sharing people are NOT 6 + 4 = 10 (the people are counted once, 7)", got[3] == 7 and got[3] != 10)
    # the BU CEO's card: ANY value within a filter, AND across (calFiltered, run in node on the real source)
    _cfsrc = JS[JS.index("  var cf = { key:"):JS.index("  function calFilterBar(d)")]
    rows_ = [{"id": i, "department": ["Sales", "Ops", "Fin"][i % 3], "cost_center": ["A", "B", "C", ""][i % 4], "current_band": "ME",
              "on_curve": True, "chain": []} for i in range(24)]
    d_ = {"tier": "buceo", "review": False, "band_order": ["UA", "BE", "ME", "AE", "OU"], "target": {"ME": 100}, "tol_rule": {"mode": "people", "people": 1},
          "rows": rows_, "distribution": {}, "total": 0,
          "filters": [{"key": "dept", "label": "Department", "plural": "departments"},
                      {"key": "cc", "label": "Cost centre", "plural": "cost centres", "field": "cost_center"}]}
    cases = [{"dept": [], "cc": ["A", "B"]}, {"dept": [], "cc": ["A", "~none"]}, {"dept": ["Sales", "Ops"], "cc": []},
             {"dept": ["Sales", "Ops"], "cc": ["A", "B"]}, {"dept": [], "cc": ["A"]}, {"dept": [], "cc": []}]
    got = _node("var FL_NOTSET = '~none'; var pn = function (s) { return s; };\n" + _cfsrc + "\nconsole.log(JSON.stringify(" + _js.dumps(cases)
                + ".map(function (c) { cf.dept = c.dept; cf.cc = c.cc; var o = calFiltered(" + _js.dumps(d_)
                + "); return {ids: o.rows.map(function (r) { return r.id; }), total: o.total, label: o.dept || ''}; })));")
    def _want(c):
        ids = [r["id"] for r in rows_ if (not c["dept"] or r["department"] in c["dept"])
               and (not c["cc"] or any((r["cost_center"] == v) if v != "~none" else r["cost_center"] == "" for v in c["cc"]))]
        return ids
    s.check("the BU CEO's card (node): two cost centres = the union, with 'Not set' too, two departments = the union, department AND cost centre = the intersection; the curve counts the same people",
            isinstance(got, list) and all(g["ids"] == _want(c) for g, c in zip(got, cases))
            and all(g["total"] == len(g["ids"]) for g in got[:5]) and got[0]["label"] == "2 cost centres" and got[2]["label"] == "2 departments"
            and got[3]["label"] == "2 departments \u00b7 2 cost centres" and got[4]["label"] == "A", got if not isinstance(got, list) else
            [(g["label"], len(g["ids"]), len(_want(c))) for g, c in zip(got, cases)])
    s.check("falsified: nothing picked is everyone and no label (the card is not narrowed)", isinstance(got, list) and len(got[5]["ids"]) == 24 and got[5]["label"] == "")
else:
    s.check("SKIP: node isn't installed, so the client's counting isn't run here", True)
for sel in (".rv-cal-chip {", ".rv-cal-pop {", ".rv-cal-opt {", ".rv-cal-fline {", ".rv-tbox-filter {", ".cfr-table", ".cfr-pform"):
    s.check("CSS has %s" % sel, sel in CSS)
s.check("...the old tag table, its pop-up and the pill rows' CSS are gone",
        ".bf-tag" not in CSS and ".bf-all-table" not in CSS and ".rv-tbox-calrow" not in CSS
        and not os.path.exists(os.path.join(H.REPO, "templates", "settings", "cards", "_bu_filters_all.html")))
s.check("chip measures: 28px high, pill, 12px 600; picked navy; open 1.5px ring; the list 300px wide with 12px radius and the house shadow",
        "min-height: 28px; padding: 0 10px 0 12px; border-radius: 999px;" in CSS and "font-size: 0.75rem; font-weight: 600" in CSS
        and H.cv(".rv-cal-chip.is-picked { background: var(--navy, #252A59); }").split(";")[0] + ";" in CSS
        and H.cv("box-shadow: 0 0 0 3px rgba(37, 42, 89, .12)") in CSS
        and "width: 300px;" in CSS and H.cv("box-shadow: 0 12px 32px rgba(31, 35, 48, .16)") in CSS and ".rv-cal-opt[hidden] { display: none; }" in CSS)
s.check("the rule panel's script keeps Save off until something changes and writes the confirm box's list",
        "save.disabled = !n || noScreen;" in ADM and 'form.setAttribute("data-confirm-list"' in ADM
        and 'form.setAttribute("data-confirm"' in ADM)

# ---------------------------------------------------------------------------
s.section("Help and Ask OneHR know it (the workspace rule of 2026-10-22)")
qa = a.HELP_QA["bu_dept"]
s.check("one fixed answer: filter by department, grade, cost centre or branch, and a filter only narrows the view",
        "cost centre" in qa[0] and "Filter line" in qa[1] and "only narrows" in qa[1] and "no band, lock or move changes" in qa[1]
        and "bg_filter" in a.HELP_QA and "bg_filter" in a.HELP_LISTS["bg"][1] and "newly" in a.HELP_LISTS["bg"][1] and len(a.HELP_LISTS["bg"][1]) <= a.HELP_LIST_MAX
        and "only narrows" in a.HELP_QA["bg_filter"][1])
s.check("...the Calibrator's answer calls it a filter, not a row", "CAL row" not in a.HELP_QA["tb_cal"][0]
        and "Calibrator" in a.HELP_QA["tb_cal"][0])
s.check("Ask OneHR's guide says where the line is and that it only narrows (for a BU CEO and a BG CEO)",
        "one Filter line narrows who you see" in SRC and "no band, lock or move changes" in SRC)
s.check("the KB row no longer calls it the CAL row; a guarded one-time UPDATE rewords the live row",
        "the CAL row names each calibrator" not in a._BU_GROUPS_KB and "Calibrator chip on the Filter line" in a._BU_GROUPS_KB
        and "'%the CAL row names each calibrator%'" in SRC)

a.ai_draft.review_agent_available = _avail

# ---------------------------------------------------------------------------
# put everything back
with a.app.test_request_context("/"):
    db = a.get_db()
    for sess, t in (("pm_calibration_sessions", "pm_calibration_adjustments"), ("calibration_sessions", "calibration_adjustments")):
        for (sid,) in db.execute("SELECT id FROM %s WHERE business_group=?" % sess, (BG,)).fetchall():
            db.execute("DELETE FROM %s WHERE session_id=?" % t, (sid,))
            db.execute("DELETE FROM %s WHERE id=?" % sess, (sid,))
    db.execute("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BG,))
    _clean(db)
    db.execute("UPDATE cycles SET half=? WHERE id=?", (_ORIG["half"], CID))
    for k, v in _ORIG["modules"].items():
        db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, CID, k))
    db.commit()

sys.exit(s.done())
