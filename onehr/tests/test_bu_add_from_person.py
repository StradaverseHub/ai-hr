"""A BU KPI added from the person page (Chris, 2026-11-07: "i want both way to work ... i can go to the BU KPI to select the
person to add, or I can add her from her KPI page to add BU KPI as her KPI"; canvas "BU KPI from person page", boards A1 to B2).

Way 1 (live since 6 Nov): BU KPI setup's Add block. Way 2 (this suite): the person page's Add a KPI panel, the super admin's alone,
outside an Early Year, until the HOD Department Review starts: it lists the unit's saved BU KPIs the person does not carry, and
posts action=add_bu (bu_setup, weight). One shared per-person check (_bu_add_refusal) and one single-person writer
(_bu_kpi_add_one); the cycle-level rules are _bu_add_cycle_refusal.

What this suite holds:
  * the add: one line linked to the setup (bu_kpi_id) at the unit's target and the given weight, the setup keeps the person
    in carriers_json and leaves no added_w, nobody else's line or the setup's other lines touched, the trail names it, the
    flash says so; the same redo collection as way 1
  * every guard falsified, each refused with NOTHING written (lines, setup JSON and trail all as they were): a role that holds
    the Add right but is not the super admin (403), an Early Year, the Department Review started, at 100%, a weight over the
    room, a weight of 0 / blank / words, a KPI they already carry, a setup of another unit, a setup of another cycle, a person
    outside the unit; and a setup that is not "those who carry it now at their own weight"
  * way 1 still works, and its refusal wording is unchanged (the shared check keeps its exact words)
  * the panel data: the unit's saved setups with their words and why (pickable, 100%, closed, not set up), nothing for a BG
    admin, an Early Year or an add the person already carries; one batched read
  * ADMIN_ACCESS_MAP lists the action as the super admin's, and the page carries the BU block the JS drives
"""
import atexit
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A BU KPI added from the person page (super admin, outside an Early Year)")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, CO2 = "ZZBP Group", "ZZBP Unit", "ZZBP Unit B"
BG2 = "ZZBP Group B"   # the "other unit" lives in ANOTHER business group: since 7 Nov another unit of the SAME group may join as a guest (test_bu_kpi_cross_unit)
U = {}
HERE = os.path.dirname(os.path.abspath(__file__))


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BP-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZBP%'")
    for g_ in (BG, BG2):
        db.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (g_,))
        db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (g_,))
        db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (g_,))
        db.execute("DELETE FROM org_units WHERE business_group=?", (g_,))
    db.execute("DELETE FROM admin_roles WHERE name='ZZBP role'")
    db.commit()


def ln(eid, name):
    r = H.rows(a, "SELECT t.weightage, t.rate1, t.rate5, t.bu_kpi_id, t.bu_prev_json, t.library_id, t.unit FROM pm_kpi_targets t "
                  "JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND u.employee_id=? AND t.kpi_name=?",
               (CID, eid, name))
    return tuple(r[0]) if r else None


def snapshot():
    """Everything an add could write: every line of the group's people, every setup, the trail rows of this feature."""
    lines = H.rows(a, "SELECT u.employee_id, t.kpi_name, t.weightage, t.rate1, t.rate5, t.bu_kpi_id, t.updated_at FROM pm_kpi_targets t "
                      "JOIN users u ON u.id=t.subject_id WHERE u.employee_id LIKE 'ZZ9BP-%' ORDER BY 1, 2")
    setups = H.rows(a, "SELECT id, kpi_name, carriers, carriers_json, weight_mode, updated_at FROM pm_bu_kpis WHERE business_group=? "
                       "ORDER BY id", (BG,))
    trail = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZBP%'")
    return [tuple(x) for x in lines], [tuple(x) for x in setups], trail


def setup_row(name="ZZBP PAT"):
    r = H.rows(a, "SELECT id, carriers_json FROM pm_bu_kpis WHERE business_group IN (?, ?) AND kpi_name=?", (BG, BG2, name))
    return (r[0][0], json.loads(r[0][1] or "{}")) if r else (None, {})


def say(r):
    return html.unescape(r.get_data(as_text=True))


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    PREV = dict(db.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
    W0 = db.execute("SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'", (CID,)).fetchone()

    def _put_back():
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?",
                       (PREV["kind"], PREV["year"], PREV["half"], PREV["min_job_grade"], CID))
            d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'", (CID,))
            if W0:
                d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', ?, ?)",
                           (CID, W0[0], W0[1]))
            d_.commit()
    atexit.register(_put_back)

    def hod_window(open_):
        """The Department Review still to come (BU KPI setup open) or already started (it reads only)."""
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', ?, ?)",
                       (CID, "2099-11-02 00:00" if open_ else "2000-01-02 00:00", "2099-11-08 23:59" if open_ else "2000-01-09 23:59"))
            d_.commit()

    def kind(k_, half):
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("UPDATE cycles SET kind=?, half=? WHERE id=?", (k_, half, CID))
            d_.commit()
    # a Year-End (not an Early Year) with the Department Review still to come: BU KPI setup is open
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', "
               "'2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?)", (BG, CO, BG2, CO2))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A'), (?, 'A')", (BG, BG2))
    LIB = {}
    for nm, bu, cat in (("ZZBP PAT", 1, "Financial · Profit"), ("ZZBP Revenue", 1, "Financial · Revenue"),
                        ("ZZBP Sales", 0, "Customer · Sales"), ("ZZBP Training", 0, "People · Learning")):
        LIB[nm] = db.execute(
            "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
            "unit, method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, "
            "?, '%', 'more', 90, 95, 100, 105, 110, 20, ?)", (BG, nm, cat, bu)).lastrowid
    U["M"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                        "company, department, job_grade, confirmation_date) VALUES ('zz9bp-m', 'ZZ BP Manager', 'x', "
                        "'user', 'ZZ9BP-M', ?, ?, 'Management', '21', '2020-01-01')", (BG, CO)).lastrowid
    for eid, co, dept in (("ZZ9BP-A", CO, "Sales"), ("ZZ9BP-B", CO, "Sales"), ("ZZ9BP-C", CO, "Finance"),
                          ("ZZ9BP-D", CO, "Finance"), ("ZZ9BP-E", CO, "Sales"), ("ZZ9BP-F", CO2, "Sales"),
                          ("ZZ9BP-G", CO, "Sales")):
        U[eid[-1]] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', 'user', ?,?,?,?, '14', '2020-01-01', ?)",
            (eid.lower(), "ZZ BP " + eid[-1], eid, BG2 if co == CO2 else BG, co, dept, U["M"])).lastrowid

    def put(who, name, w, rates=(90, 95, 100, 105, 110)):
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, "
                   "rate2, rate3, rate4, rate5, business_group, company, library_id) VALUES (?,?,?,?, 'more', '%', 'Own',"
                   " ?,?,?,?,?, ?,?,?)", (CID, U[who], name, w) + tuple(rates) + (
                       BG2 if who == "F" else BG, CO2 if who == "F" else CO, LIB[name]))
    put("A", "ZZBP PAT", 30)
    put("B", "ZZBP PAT", 20)
    put("C", "ZZBP Sales", 40)       # C: 2 KPIs adding up to 70%
    put("C", "ZZBP Training", 30)
    put("E", "ZZBP Sales", 60)       # E: 2 KPIs adding up to 100%
    put("E", "ZZBP Training", 40)
    put("F", "ZZBP Sales", 25)       # the other unit's
    put("G", "ZZBP Sales", 50)       # G: 1 KPI, 50%
    db.execute("DELETE FROM admin_roles WHERE name='ZZBP role'")
    ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZBP role', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)",   # everything a role can hold for this page, but not super
                   [(ROLE, "pm.read"), (ROLE, "pm.bu_kpi"), (ROLE, "pm.kpi_add"), (ROLE, "people.read")])
    BGADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                       "admin_bg, admin_role_id) VALUES ('zz9bp-adm', 'ZZ BP Admin', 'x', 'admin', 'ZZ9BP-ADM', ?, ?, ?)",
                       (BG, BG, ROLE)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
# what the AI pre-run was asked to work out ahead (2026-11-08): every _prerun_on_event call, the real one still running
SEEN = []
_REAL_PRERUN = a._prerun_on_event
a._prerun_on_event = lambda db_, cid_, ids_, ev_: (SEEN.append((ev_, tuple(sorted(ids_)))), _REAL_PRERUN(db_, cid_, ids_, ev_))[1]
BGC = H.client_as(a, BGADM)
PAT, REV = LIB["ZZBP PAT"], LIB["ZZBP Revenue"]
URL = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
URL2 = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG2.replace(" ", "+"), CO2.replace(" ", "+"))


def card(holders=None, adds=None, rates=(80, 90, 100, 110, 120), lid=None):
    k = "k%d_" % (lid or PAT)
    f = {k + "rate%d" % i: str(v) for i, v in enumerate(rates, 1)}
    f.update({k + "carriers": "holders", k + "wmode": "own", k + "unit": "%"})
    if holders is not None:
        f[k + "holder_set"] = "1"
        f[k + "holder"] = list(holders)
    if adds:
        f[k + "addp"] = list(adds)
        for e, w in adds.items():
            if w is not None:
                f[k + "addw_" + e] = w
    return f


def save_kpi(form, url=URL, lid=None, client=None):
    d = {"csrf_token": "tok", "action": "save_kpi", "kpi": str(lid or PAT)}
    d.update(form)
    return (client or SUP).post(url, data=d, follow_redirects=True)


def person_post(who, setup, weight, client=None, action="add_bu", follow=True, extra=None):
    d = {"csrf_token": "tok", "action": action, "bu_setup": str(setup)}
    if weight is not None:
        d["weight"] = weight
    d.update(extra or {})
    return (client or SUP).post("/admin/users/%d/kpi" % U[who], data=d, follow_redirects=follow)


def kpe_json(who, client=None):
    pg = say((client or SUP).get("/admin/users/%d?tab=performance" % U[who]))
    m = re.search(r'<script type="application/json" id="kpe-lib">(.*?)</script>', pg, re.S)
    return (json.loads(m.group(1)) if m else {}), pg


def item(js, name="ZZBP PAT"):
    return next((x for x in (js.get("bu_items") or []) if x["name"] == name), None)


try:
    # ---------------------------------------------------------------------------------------------------------------
    s.section("set up: PAT saved for A and B (way 1); Revenue is BU-level in the library but not set up for the unit")
    save_kpi(card(holders=["ZZ9BP-A", "ZZ9BP-B"]))
    SID, sdata = setup_row()
    s.check("PAT is saved for A and B, linked, at the unit's target",
            SID and sorted(sdata.get("people") or []) == ["ZZ9BP-A", "ZZ9BP-B"] and ln("ZZ9BP-A", "ZZBP PAT")[:4] == (30, 80, 120, SID)
            and ln("ZZ9BP-B", "ZZBP PAT")[:4] == (20, 80, 120, SID), (SID, sdata))
    # a setup of ANOTHER unit: F carries Sales... a BU setup for CO2 is made through its own page (F holds a line of its name)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, "
                   "method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level) VALUES (?, ?, '*', 0, '*', "
                   "'ZZBP Other', 'Financial · Other', '%', 'more', 1,2,3,4,5, 10, 1)", (BG2, CO2))
        d_.commit()
    OTH = H.one(a, "SELECT id FROM pm_kpi_library WHERE business_group=? AND kpi_name='ZZBP Other'", (BG2,))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, rate2, rate3, "
                   "rate4, rate5, business_group, company, library_id) VALUES (?,?, 'ZZBP Other', 10, 'more', '%', 'Own', 1,2,3,4,5, "
                   "?,?,?)", (CID, U["F"], BG2, CO2, OTH))
        d_.commit()
    save_kpi(card(holders=["ZZ9BP-F"], lid=OTH), url=URL2.replace("fbu=", "fbu="), lid=OTH)
    OSID, _od = setup_row("ZZBP Other")
    s.check("a setup of the OTHER unit exists for the wrong-unit guard", OSID and OSID != SID, OSID)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("panel data: the super admin, outside an Early Year, gets the unit's BU KPIs as rows (boards A1 and B1)")
    js, pg = kpe_json("C")
    it = item(js)
    s.check("C (70%) is offered PAT as a row: pickable, the unit's target, 2 carry it, 30 left",
            it and it["why"] is None and it["sid"] == SID and it["n"] == 2 and it["room"] == 30 and it["family"] == "Financial · Profit"
            and it["method"] == "more" and it["unit"] == "%" and it["target"] == "80 / 90 / 100 / 110 / 120 %"
            and it["short"] == "Rates 80 to 120%" and js["bu_total"] == 70 and js["bu_unit"] == CO, it)
    s.check("...with the BU KPI setup address on that KPI in Edit",
            it["url"] == "/admin/performance/bu-kpis?fbg=ZZBP+Group&fbu=ZZBP+Unit&kpi=%d&edit=1" % PAT, it["url"])
    rv = item(js, "ZZBP Revenue")
    s.check("Revenue (BU-level in the library, not set up for the unit) is a greyed row that says so, with the way to set it",
            rv and rv["sid"] is None and rv["why"] == "Not set up for ZZBP Unit yet: its target is set there first."
            and rv["url"] == "/admin/performance/bu-kpis?fbg=ZZBP+Group&fbu=ZZBP+Unit&kpi=%d&edit=1" % REV, rv)
    s.check("the library results beside them are still only the non-BU KPIs, and the plain-text list `bu` is kept",
            [x["name"] for x in js["items"]] == ["ZZBP Sales", "ZZBP Training"] and sorted(js["bu"]) == ["ZZBP PAT", "ZZBP Revenue"], js["items"])
    s.check("the Add form carries the BU block, the setup box and the action box the JS drives",
            "data-kpe-bu" in pg and "data-kpe-busetup" in pg and "data-kpe-action" in pg and 'name="weight"' in pg
            and "data-kpe-cyc=" in pg and "The unit's · read only" in pg, "")
    jse, _pge = kpe_json("E")
    s.check("E (100%): PAT is greyed with the words the save gives", item(jse)["why"] == "Their KPIs already add up to 100%. Lower a weight first.", item(jse))
    jsa, _pga = kpe_json("A")
    s.check("A carries PAT already: it is not listed (Revenue still is)", item(jsa) is None and item(jsa, "ZZBP Revenue") is not None,
            [x["name"] for x in jsa["bu_items"]])
    jsd, _pgd = kpe_json("D")
    s.check("D (no KPIs, 0%): 100 left", item(jsd)["room"] == 100 and item(jsd)["why"] is None and jsd["bu_total"] == 0, item(jsd))
    with a.app.app_context():
        db = a.get_db()
        cyc = a.active_cycle(db)
        pc = db.execute("SELECT * FROM users WHERE employee_id='ZZ9BP-C'").fetchone()
        libr = [dict(r) for r in db.execute("SELECT * FROM pm_kpi_library WHERE business_group=? AND active=1 AND company IN ('*', ?)",
                                            (BG, CO))]
        cfg = db.execute("SELECT * FROM pm_bg_config WHERE business_group=?", (BG,)).fetchone()
    with a.app.test_request_context():
        k_oth = a._kpe_library(a.get_db(), pc, cyc, libr, sup=False, cfg=cfg)
    s.check("a BG or unit admin gets no BU rows at all (today's text, `bu` and no link)", "bu_items" not in k_oth and k_oth["bu_url"] == ""
            and sorted(k_oth["bu"]) == ["ZZBP PAT", "ZZBP Revenue"], (k_oth["bu"], k_oth["bu_url"], k_oth.keys()))
    kind("early_year", 0)
    jey, _pgey = kpe_json("C")
    s.check("in an Early Year even the super admin gets today's text, no BU rows", "bu_items" not in jey and jey["bu_url"], jey.keys())
    kind("year_end", 2)
    hod_window(False)
    jcl, _pgcl = kpe_json("C")
    s.check("once the Department Review has started, PAT is greyed with the date words (BU KPIs read only)",
            item(jcl)["why"] and item(jcl)["why"].startswith("The Department Review started on ") and item(jcl)["why"].endswith("so BU KPIs read only.")
            , item(jcl))
    hod_window(True)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("every guard refuses, and nothing is written")
    base = snapshot()

    def refused(label, resp_or_status, expect=None):
        now = snapshot()
        if isinstance(resp_or_status, int):
            ok = now == base
        else:
            out = say(resp_or_status)
            ok = now == base and (expect in out) and "Nothing was added" in out
        s.check(label, ok, (expect, base == now))

    r = person_post("C", SID, "10", client=BGC, follow=False)
    s.check("a role that holds the Add right but is not the super admin is refused (403)", r.status_code == 403, r.status_code)
    refused("...and nothing was written", 403)
    refused("over the room: C holds 70, so 40 is refused with the room left", person_post("C", SID, "40"),
            "Their KPIs hold 70%, so at most 30% more.")
    refused("no weight is refused", person_post("C", SID, None), "Give their weight.")
    refused("a blank weight is refused", person_post("C", SID, " "), "Give their weight.")
    refused("a weight of 0 is refused", person_post("C", SID, "0"), "Give their weight.")
    refused("a weight of words is refused", person_post("C", SID, "lots"), "Give their weight.")
    refused("a negative weight is refused", person_post("C", SID, "-5"), "Give their weight.")
    refused("a weight that is not a number (nan) is refused", person_post("C", SID, "nan"), "Give their weight.")
    refused("someone already at 100% is refused", person_post("E", SID, "10"), "Their KPIs already add up to 100%. Lower a weight first.")
    refused("someone who already carries it is refused", person_post("A", SID, "10"), "They already carry it.")
    refused("a setup of another BUSINESS GROUP is refused (another unit of the same group is a guest, test_bu_kpi_cross_unit)", person_post("C", OSID, "10"),
            "That BU KPI is not set up for ZZ BP C's business group on")
    refused("a setup id that does not exist is refused", person_post("C", 999999, "10"), "That BU KPI is not set up for")
    refused("a setup id that is not a number is refused", person_post("C", "abc", "10"), "That BU KPI is not set up for")
    # the person is in another unit than the setup's: F posting PAT of CO
    refused("a person of another unit posting this unit's setup is refused", person_post("F", SID, "10"), "That BU KPI is not set up for")
    # a setup of another cycle: move the row to another cycle id for the moment
    other_cid = (H.one(a, "SELECT MAX(id) FROM cycles") or 0) + 1
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("PRAGMA foreign_keys=OFF")
        d_.execute("UPDATE pm_bu_kpis SET cycle_id=? WHERE id=?", (other_cid, SID))
        d_.commit()
    base = snapshot()
    refused("a setup of another cycle is refused", person_post("C", SID, "10"), "That BU KPI is not set up for")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET cycle_id=? WHERE id=?", (CID, SID))
        d_.commit()
    base = snapshot()
    kind("early_year", 0)
    refused("in an Early Year it is refused (there a BU KPI goes on by department, grade or everyone)", person_post("C", SID, "10"),
            "This is an Early Year")
    kind("year_end", 2)
    hod_window(False)
    refused("once the Department Review has started it is refused with the date words", person_post("C", SID, "10"),
            "so BU KPIs read only.")
    hod_window(True)
    # a setup saved "by department" (an Early Year save) is refused: it is not "those who carry it now at their own weight"
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET carriers='departments' WHERE id=?", (SID,))
        d_.commit()
    base = snapshot()
    refused("a setup that goes on by department is refused", person_post("C", SID, "10"), "it is set on BU KPI setup")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET carriers='holders', weight_mode='one', weight=10 WHERE id=?", (SID,))
        d_.commit()
    base = snapshot()
    refused("a setup at one weight for all is refused (the weight given would be ignored)", person_post("C", SID, "10"),
            "it is set on BU KPI setup")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET weight_mode='own', weight=NULL WHERE id=?", (SID,))
        d_.commit()
    base = snapshot()
    r = person_post("C", SID, "10", action="add_bu_x", follow=False)
    s.check("a made-up action name is a 400, not an add", r.status_code == 400 and snapshot() == base, r.status_code)
    # every guard above is falsified below: the same post, made good, goes on (the refusals were the guards, not a broken form)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the shared check, called directly: both ways give the same refusal for the same fault")
    f = a._bu_add_refusal
    s.check("the card's words (the Employee ID speaks)",
            f("E1", False, False, 0, "10") == "E1 isn't one of the people taking part in this unit."
            and f("E1", True, True, 0, "10") == "E1 carries it already."
            and f("E1", True, False, 100, "10") == "E1 already adds up to 100%."
            and f("E1", True, False, 0, "") == "give E1's weight."
            and f("E1", True, False, 70, "40") == "E1 holds 70%, so at most 30% more."
            and f("E1", True, False, 70, "30") is None and f("E1", True, False, 0, "100") is None)
    s.check("the person page's words (they speak) for the same faults",
            f("E1", False, False, 0, "10", person=True) == "They aren't one of the people taking part in this unit."
            and f("E1", True, True, 0, "10", person=True) == "They already carry it."
            and f("E1", True, False, 100, "10", person=True) == "Their KPIs already add up to 100%. Lower a weight first."
            and f("E1", True, False, 0, "0", person=True) == "Give their weight."
            and f("E1", True, False, 70, "40", person=True) == "Their KPIs hold 70%, so at most 30% more."
            and f("E1", True, False, 70, None, person=True) is None, "")
    s.check("the weight rules: inf, -inf, nan, words and 0 are all 'no weight'; 100 on an empty scorecard is fine",
            all(f("E", True, False, 0, w_) == "give E's weight." for w_ in ("inf", "-inf", "nan", "x", "0", "-1", ""))
            and f("E", True, False, 0, "100") is None and f("E", True, False, 0, "100.001") is None
            and f("E", True, False, 0, "100.1") == "E holds 0%, so at most 100% more.")
    with a.app.app_context():
        db = a.get_db()
        act = a.active_cycle(db)
        srow = db.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (SID,)).fetchone()
        su_row = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        bg_row = db.execute("SELECT * FROM users WHERE id=?", (BGADM,)).fetchone()
        cr = a._bu_add_cycle_refusal
        s.check("the cycle rules: none for the super admin now; a BG admin is refused", cr(db, su_row, act, srow) is None
                and cr(db, bg_row, act, srow) == "Adding a BU KPI to someone is the super admin's.", cr(db, su_row, act, srow))
        s.check("...and no setup is refused", cr(db, su_row, act, None) == "That BU KPI is not set up on the active cycle.")

    # ---------------------------------------------------------------------------------------------------------------
    s.section("way 1 still works, in its own words")
    out = say(save_kpi(card(["ZZ9BP-A", "ZZ9BP-B"], {"ZZ9BP-E": "10"})))
    s.check("an add at 100% on the BU page: 'ZZ9BP-E already adds up to 100%.' (the card's exact words)",
            "'ZZBP PAT': ZZ9BP-E already adds up to 100%." in out and "Nothing was saved" in out and ln("ZZ9BP-E", "ZZBP PAT") is None, out[-300:])
    out = say(save_kpi(card(["ZZ9BP-A", "ZZ9BP-B"], {"ZZ9BP-C": "40"})))
    s.check("...over the room: 'ZZ9BP-C holds 70%, so at most 30% more.'", "'ZZBP PAT': ZZ9BP-C holds 70%, so at most 30% more." in out, "")
    out = say(save_kpi(card(["ZZ9BP-A", "ZZ9BP-B"], {"ZZ9BP-C": None})))
    s.check("...no weight: 'give ZZ9BP-C's weight.'", "'ZZBP PAT': give ZZ9BP-C's weight." in out, "")
    out = say(save_kpi(card(["ZZ9BP-A", "ZZ9BP-B"], {"ZZ9BP-F": "10"})))
    s.check("...another unit's person and a holder", "'ZZBP PAT': ZZ9BP-F isn't one of the people taking part in this unit." in out
            and "'ZZBP PAT': ZZ9BP-A carries it already." in say(save_kpi(card(["ZZ9BP-A", "ZZ9BP-B"], {"ZZ9BP-A": "10"}))), "")
    # way 1 adds G at 25: the redo collection is the same call as way 2's (recorded below)
    collected = []
    orig_collect = a._redo_collect

    def spy(db_, act_, p_, change_):
        collected.append((p_["id"], change_["kind"], change_["name"]))
        return orig_collect(db_, act_, p_, change_)
    a._redo_collect = spy
    try:
        out = say(save_kpi(card(["ZZ9BP-A", "ZZ9BP-B"], {"ZZ9BP-G": "25"})))
        g = ln("ZZ9BP-G", "ZZBP PAT")
        s.check("way 1 adds G at 25, linked to the setup", g and g[0] == 25 and g[3] == SID and "1 line added" in out, g)
        s.check("...and collects the new line for the 'something changed' email, for G", (U["G"], "kpi", "ZZBP PAT") in collected, collected)
        collected.clear()
        # remove G again so the person-page add for G can be compared: take G off by unticking
        save_kpi(card(["ZZ9BP-A", "ZZ9BP-B"]))
        s.check("...G unticked: their line is gone again", ln("ZZ9BP-G", "ZZBP PAT") is None)
        collected.clear()

        # -----------------------------------------------------------------------------------------------------------
        s.section("the add from the person page: C (70%) takes PAT at 30")
        before_lines = snapshot()[0]
        with a.app.app_context():   # C has a rating record already (a sign-off, or a Capture): the add must rebuild it
            a._rating_record_refresh(a.get_db(), CID, [U["C"]], "seed_zz", SU["id"], commit=True)
        del SEEN[:]
        out = say(person_post("C", SID, "30"))
        s.check("the add asks the AI pre-run once to work C's insights out ahead (kpi_edit), and a refused add asked nothing",
                SEEN == [("kpi_edit", (U["C"],))], SEEN)
        s.check("...and C's rating record was rebuilt by it (event kpi_edit, the admin's id)",
                H.rows(a, "SELECT last_event, last_event_by FROM rating_records WHERE cycle_id=? AND subject_id=?", (CID, U["C"]))
                and tuple(H.rows(a, "SELECT last_event, last_event_by FROM rating_records WHERE cycle_id=? AND subject_id=?",
                                 (CID, U["C"]))[0]) == ("kpi_edit", SU["id"]))
        with a.app.app_context():
            a.get_db().execute("DELETE FROM rating_records WHERE cycle_id=? AND subject_id=?", (CID, U["C"]))
            a.get_db().commit()
        c = ln("ZZ9BP-C", "ZZBP PAT")
        sid_now, sdata = setup_row()
        s.check("C has one PAT line: 30%, at the unit's target (80..120), linked to the setup and its library KPI, marked as added by the setup",
                c and c[0] == 30 and c[1:3] == (80, 120) and c[3] == SID and c[5] == PAT and c[6] == "%"
                and json.loads(c[4] or "{}").get("added") == 1 and H.one(
                    a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=? AND kpi_name='ZZBP PAT'", (U["C"],)) == 1, c)
        s.check("the setup keeps C among its carriers and leaves no added_w behind",
                sorted(sdata.get("people") or []) == ["ZZ9BP-A", "ZZ9BP-B", "ZZ9BP-C"] and "added_w" not in sdata and sid_now == SID, sdata)
        after_lines = snapshot()[0]
        changed = [x for x in after_lines if x not in before_lines]
        s.check("nobody else's line moved: the only new row is C's PAT (A, B, and C's own two lines are as they were)",
                len(changed) == 1 and changed[0][:2] == ("ZZ9BP-C", "ZZBP PAT") and all(x in after_lines for x in before_lines), changed)
        s.check("C's own two lines are untouched", ln("ZZ9BP-C", "ZZBP Sales")[0] == 40 and ln("ZZ9BP-C", "ZZBP Training")[0] == 30)
        s.check("the flash: '<KPI> added for <name> at <w>%, at <unit> target.'",
                "ZZBP PAT added for ZZ BP C at 30%, at ZZBP Unit's target." in out, re.findall(r"flash[^<]*<[^>]*>[^<]*", out)[:2])
        lg = H.rows(a, "SELECT detail, target_user_id FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZBP PAT%' "
                       "ORDER BY id DESC LIMIT 1")
        s.check("the trail line is the BU KPI's own words, ends '1 added from the person page (ZZ9BP-C at 30%)', and is on C's page log",
                lg and lg[0][0].endswith("· 1 added from the person page (ZZ9BP-C at 30%)") and "1 added, 0 updated, 0 taken off" in lg[0][0]
                and lg[0][1] == U["C"], lg)
        s.check("the redo collection is the way-1 call: C's new line is collected for the 'something changed' email",
                (U["C"], "kpi", "ZZBP PAT") in collected, collected)
        s.check("the person's total now reads 100 and the panel data drops PAT for C (they carry it); Revenue stays greyed",
                kpe_json("C")[0]["bu_total"] == 100 and item(kpe_json("C")[0]) is None, "")
        # BU KPI setup counts them at once
        with a.app.app_context():
            db = a.get_db()
            fx, _grp = a._bu_kpi_facts(db, a.active_cycle(db), BG, CO)
        s.check("BU KPI setup counts C at once: 3 carry it, C among them", fx["zzbp pat"]["n"] == 3 and "ZZ9BP-C" in fx["zzbp pat"]["eids"], fx.get("zzbp pat", {}).get("n"))
    finally:
        a._redo_collect = orig_collect

    # ---------------------------------------------------------------------------------------------------------------
    s.section("a second add to the same person is refused; the weight edge: exactly what is left is accepted")
    base = snapshot()
    refused("C again: they carry it now", person_post("C", SID, "5"), "They already carry it.")
    out = say(person_post("D", SID, "100"))
    d = ln("ZZ9BP-D", "ZZBP PAT")
    s.check("D (no KPIs) takes all 100 (the whole room is allowed)", d and d[0] == 100 and d[3] == SID, d)
    save_kpi(card(["ZZ9BP-A", "ZZ9BP-B", "ZZ9BP-C", "ZZ9BP-D"], rates=(70, 85, 100, 115, 130)))
    s.check("...C and D keep 30 and 100, with the new target", ln("ZZ9BP-C", "ZZBP PAT")[:3] == (30, 70, 130)
            and ln("ZZ9BP-D", "ZZBP PAT")[:3] == (100, 70, 130), (ln("ZZ9BP-C", "ZZBP PAT"), ln("ZZ9BP-D", "ZZBP PAT")))
    out = say(save_kpi(card(["ZZ9BP-A", "ZZ9BP-B"], rates=(70, 85, 100, 115, 130))))
    s.check("unticked on the BU page, the added lines come off (nothing was given back as it wasn't there)",
            ln("ZZ9BP-C", "ZZBP PAT") is None and ln("ZZ9BP-D", "ZZBP PAT") is None and ln("ZZ9BP-C", "ZZBP Sales")[0] == 40, out[:200])

    # ---------------------------------------------------------------------------------------------------------------
    s.section("one batched read, the access map and the page's script")
    with a.app.test_request_context():
        db = a.get_db()
        cyc = a.active_cycle(db)
        pg_ = db.execute("SELECT * FROM users WHERE employee_id='ZZ9BP-G'").fetchone()
        libr = [dict(r) for r in db.execute("SELECT * FROM pm_kpi_library WHERE business_group=? AND active=1 AND company IN ('*', ?)",
                                            (BG, CO))]
        cfg = db.execute("SELECT * FROM pm_bg_config WHERE business_group=?", (BG,)).fetchone()
        seen = []
        db.set_trace_callback(seen.append)
        k_sup = a._kpe_library(db, pg_, cyc, libr, sup=True, cfg=cfg)
        db.set_trace_callback(None)
    q = [x for x in seen if "FROM pm_bu_kpis" in x and "ORDER BY kpi_name" in x]
    c_ = [x for x in seen if "bu_kpi_id IN" in x and "GROUP BY" in x]
    s.check("the unit's setups are ONE query and who carries them ONE grouped query, however many setups there are", len(q) == 1 and len(c_) == 1,
            (len(q), len(c_)))
    amap = a.ADMIN_ACCESS_MAP["admin_person_kpi"]
    s.check("ADMIN_ACCESS_MAP: add_bu is the super admin's alone, the other three actions keep their items",
            amap["map"]["add_bu"] == "super" and "add" in amap["map"] and "edit" in amap["map"] and "delete" in amap["map"], amap["map"])
    js_src = open(os.path.join(HERE, "..", "static", "kpi_edit.js")).read()
    s.check("the script posts add_bu through the same form, with the weight box only and the confirm words of board A3",
            'actIn.value = "add_bu"' in js_src and "Group People fills its result. They see it at once; their other weights are not re-balanced for you." in js_src
            and "At most " in js_src and "their KPIs hold " in js_src, "")
finally:
    _put_back()
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
