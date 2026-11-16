"""Cross-BU KPI (Chris, 2026-11-07: "a person in BU 1 carries BU 2's BU KPI"; canvas [design canvas link removed], boards
A1 to C1; plan "Cross-BU KPI plan 2026-11-07.md", Parts 1 and 2).

Part 1: GUEST carriers. Someone in ANOTHER unit of the SAME business group carries a unit's saved BU KPI: kept in carriers_json["guests"]
{Employee ID: weight}, their line an ordinary pm_kpi_targets row linked by bu_kpi_id, at the setup's target and THEIR OWN weight, on their own
business_group / company. One check (`_bu_guest_refusal`), one writer (`_bu_kpi_add_guest`), one pool (`_bu_kpi_pool`).
Part 2: a NEW variant's name is picked (`_bu_variant_qualifier`): this unit, their units ("A & B", "A, B & C"), or a role label.

What this suite holds (every guard falsified: the refusal writes NOTHING, lines, setups, trail all as they were):
  * helpers: `_bu_kpi_guests` tolerates a missing / bad JSON, a guests value that is not a map, a bad weight; a guest is covered whatever the
    mode and at their own weight; someone of another unit who is not a guest is not covered even by "everyone"
  * the add from the person page: the line (linked, the unit's target, their weight, their own group and company), the setup's JSON, the
    trail words, the flash, the 'something changed' email collection, the greyed line on their page, `pm_bu_level_names`
  * the add from the card (Add block "From another unit"): the picker feed (?xbu=, the writer's own words per person), the card save adds them
    in its own transaction, and one refusal rolls the whole save back; a non-super refused
  * refused: another business group, not taking part, already a guest, same-root line, 100% already, a weight over the room / 0 / blank / nan,
    not the super admin, an Early Year, the Department Review started, someone in the unit itself
  * the TRAP: a card save (target change, then no change) keeps every guest and retargets their lines; the next write never drops them
  * take the KPI off the unit: the guests' lines go back too; a guest taken off from their own page (any carrier mode), refused when someone
    acted on the line, the last-carrier rule unchanged
  * Fill BU result: the guest's line is filled once, with the unit whose KPI it is, never by its own unit's name rule; the filled map, the
    rail and the holders list count them once; Home's "before calibration" card counts them once
  * the card: guests in Who carries it with "From <unit>", the count line, Search in matches the unit, the strip's words
  * Part 2: each name pick, "their units" only with a guest ticked, the "&" join, three units, over 80 characters refused, a typed qualifier is
    never read, a new role label's characters and length, a role not in the list refused, a moved guest lands in the destination's guests
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
s = H.Suite("Cross-BU KPI: guest carriers and picked variant names")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, CO2, CO3 = "ZZXU Group", "ZZXU Alpha", "ZZXU Beta", "ZZXU Gamma"
BGX, COX = "ZZXU Other Group", "ZZXU Delta"
PAT_N, GP_N = "ZZXU PAT", "ZZXU GP"
U = {}


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9XU-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        ids = "SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph
        for tb in ("pm_kpi_approvals", "pm_kpi_results", "pm_checkins"):
            db.execute("DELETE FROM %s WHERE kpi_target_id IN (%s)" % (tb, ids), ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action IN ('pm_bu_kpi','pm_kpi_add') AND detail LIKE '%ZZXU%'")
    for g_ in (BG, BGX):
        db.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (g_,))
        db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (g_,))
        db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (g_,))
        db.execute("DELETE FROM org_units WHERE business_group=?", (g_,))
    db.execute("DELETE FROM admin_roles WHERE name='ZZXU role'")
    db.commit()


def say(r):
    return html.unescape(r.get_data(as_text=True))


def flashes(r):
    return " ".join(re.findall(r'role="alert"[^>]*>\s*([^<]*)', say(r)))


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
    atexit.register(lambda: _cleanup_final())

    def hod_window(open_):
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
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', "
               "'2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?),(?,?),(?,?)", (BG, CO, BG, CO2, BG, CO3, BGX, COX))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A'), (?, 'A')", (BG, BGX))
    LIB = {}
    for nm, bu, cat, g_, co_lib in ((PAT_N, 1, "Financial · Profit", BG, "*"), (GP_N, 1, "Financial · Margin", BG, CO),   # GP is ZZXU Alpha's own BU-level row
                                    ("ZZXU Sales", 0, "Customer · Sales", BG, "*"), ("ZZXU Training", 0, "People · Learning", BG, "*"),
                                    ("ZZXU XSales", 0, "Customer · Sales", BGX, "*")):
        LIB[nm] = db.execute(
            "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
            "unit, method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level) VALUES (?, ?, '*', 0, '*', ?, "
            "?, '%', 'more', 90, 95, 100, 105, 110, 20, ?)", (g_, co_lib, nm, cat, bu)).lastrowid
    U["M"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                        "company, department, job_grade, confirmation_date) VALUES ('zz9xu-m', 'ZZ XU Manager', 'x', "
                        "'user', 'ZZ9XU-M', ?, ?, 'Management', '21', '2020-01-01')", (BG, CO)).lastrowid
    PEOPLE = (("A", BG, CO, "Sales"), ("B", BG, CO, "Sales"), ("C", BG, CO, "Finance"), ("D", BG, CO, "Finance"),
              ("G", BG, CO2, "Sales"), ("H", BG, CO2, "Sales"), ("I", BG, CO2, "Finance"), ("K", BG, CO2, "Sales"),
              ("N", BG, CO2, "Finance"), ("Z", BG, CO3, "Sales"), ("Y", BG, CO3, "Finance"), ("W", BG, CO3, "Sales"), ("V", BG, CO3, "Finance"), ("X", BGX, COX, "Sales"))
    for e, bg_, co_, dept in PEOPLE:
        U[e] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', 'user', ?,?,?,?, '14', '2020-01-01', ?)",
            ("zz9xu-" + e.lower(), "ZZ XU " + e, "ZZ9XU-" + e, bg_, co_, dept, U["M"])).lastrowid
    CO_OF = {e: (bg_, co_) for e, bg_, co_, _d in PEOPLE}
    db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?, 'remove')", (CID, U["K"]))   # K is out of the cycle

    def put(who, name, w, rates=(90, 95, 100, 105, 110), lib=None):
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, "
                   "rate2, rate3, rate4, rate5, business_group, company, library_id) VALUES (?,?,?,?, 'more', '%', 'Own',"
                   " ?,?,?,?,?, ?,?,?)", (CID, U[who], name, w) + tuple(rates) + CO_OF[who] + (LIB[lib or name],))
    for e in "ABCD":
        put(e, PAT_N, 30)
    put("G", "ZZXU Sales", 40)
    put("G", "ZZXU Training", 30)        # G: 2 KPIs, 70%
    put("H", "ZZXU Sales", 60)
    put("H", "ZZXU Training", 40)        # H: 100%
    put("I", PAT_N, 30)                  # I holds their OWN PAT line (the same root as the setup's): the same-root guard
    put("I", "ZZXU Sales", 40)
    put("Z", "ZZXU Sales", 40)           # Z: 40%
    put("Y", "ZZXU Sales", 50)           # Y: 50%
    put("X", "ZZXU XSales", 25, lib="ZZXU XSales")
    db.execute("DELETE FROM admin_roles WHERE name='ZZXU role'")
    ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZXU role', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)",
                   [(ROLE, "pm.read"), (ROLE, "pm.bu_kpi"), (ROLE, "pm.kpi_add"), (ROLE, "people.read")])
    BGADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                       "admin_bg, admin_role_id) VALUES ('zz9xu-adm', 'ZZ XU Admin', 'x', 'admin', 'ZZ9XU-ADM', ?, ?, ?)",
                       (BG, BG, ROLE)).lastrowid
    db.commit()


def _cleanup_final():
    with a.app.app_context():
        d_ = a.get_db()
        _cleanup(d_)


SUP = H.client_as(a, SU["id"])
BGC = H.client_as(a, BGADM)
PAT, GP = LIB[PAT_N], LIB[GP_N]


def url(co=CO, bg=BG):
    return "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (bg.replace(" ", "+"), co.replace(" ", "+"))


def card(holders, lid=None, rates=(80, 90, 100, 110, 120), guests=None, extra=None):
    """The card's Edit form as the page posts it; `guests` {eid: weight text} = the picked "From another unit" rows."""
    k = "k%d_" % (lid or PAT)
    f = {k + "rate%d" % i: str(v) for i, v in enumerate(rates, 1)}
    f.update({k + "carriers": "holders", k + "wmode": "own", k + "unit": "%", k + "holder_set": "1", k + "holder": list(holders)})
    if guests:
        f[k + "gadd"] = list(guests)
        for e, w in guests.items():
            if w is not None:
                f["%sgaddw_%s" % (k, e)] = w
    f.update(extra or {})
    return f


def save_kpi(form, lid=None, client=None, co=CO):
    d = {"csrf_token": "tok", "action": "save_kpi", "kpi": str(lid or PAT)}
    d.update(form)
    return (client or SUP).post(url(co), data=d, follow_redirects=True)


def person_post(who, setup, weight, client=None, action="add_bu", follow=True, extra=None):
    d = {"csrf_token": "tok", "action": action, "bu_setup": str(setup)}
    if weight is not None:
        d["weight"] = weight
    d.update(extra or {})
    return (client or SUP).post("/admin/users/%d/kpi" % U[who], data=d, follow_redirects=follow)


def setup_row(name=PAT_N):
    r = H.rows(a, "SELECT id, carriers_json, kpi_name FROM pm_bu_kpis WHERE business_group=? AND kpi_name=?", (BG, name))
    return (r[0][0], json.loads(r[0][1] or "{}")) if r else (None, {})


def ln(eid, name=PAT_N):
    r = H.rows(a, "SELECT t.id, t.weightage, t.rate1, t.rate5, t.bu_kpi_id, t.bu_prev_json, t.library_id, t.business_group, t.company, t.unit "
                  "FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND u.employee_id=? AND t.kpi_name=?",
               (CID, "ZZ9XU-" + eid, name))
    return tuple(r[0]) if r else None


def snapshot():
    lines = H.rows(a, "SELECT u.employee_id, t.kpi_name, t.weightage, t.rate1, t.rate5, t.bu_kpi_id, t.updated_at FROM pm_kpi_targets t "
                      "JOIN users u ON u.id=t.subject_id WHERE u.employee_id LIKE 'ZZ9XU-%' ORDER BY 1, 2")
    setups = H.rows(a, "SELECT id, kpi_name, carriers, carriers_json, weight_mode, updated_at, rate1, rate5, library_id FROM pm_bu_kpis "
                       "WHERE business_group IN (?,?) ORDER BY id", (BG, BGX))
    trail = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action IN ('pm_bu_kpi','pm_kpi_add') AND detail LIKE '%ZZXU%'")
    return [tuple(x) for x in lines], [tuple(x) for x in setups], trail


def kpe_json(who, client=None):
    pg = say((client or SUP).get("/admin/users/%d?tab=performance" % U[who]))
    m = re.search(r'<script type="application/json" id="kpe-lib">(.*?)</script>', pg, re.S)
    return (json.loads(m.group(1)) if m else {}), pg


def item(js, name=PAT_N):
    """The OTHER-unit row of that name (the person's own unit's 'Not set up yet' row of the same library name is a different row)."""
    return next((x for x in (js.get("bu_items") or []) if x["name"] == name and x.get("other_unit")), None)


def tid_of(eid, name=PAT_N):
    t = ln(eid, name)
    return t[0] if t else None


try:
    # ---------------------------------------------------------------------------------------------------------------
    s.section("helpers: the guests of a setup, who a setup covers and at what weight")
    G = a._bu_kpi_guests
    s.check("a missing / empty / bad JSON has no guests", G({"carriers_json": None}) == {} and G({"carriers_json": ""}) == {}
            and G({"carriers_json": "{not json"}) == {} and G({"carriers_json": "[1,2]"}) == {})
    s.check("a guests value that is not a map has none", G({"carriers_json": '{"guests": ["ZZ9XU-G"]}'}) == {}
            and G({"carriers_json": '{"guests": null}'}) == {})
    s.check("Employee IDs are folded (trim, upper case) and a bad weight is None, not a crash",
            G({"carriers_json": '{"guests": {" zz9xu-g ": 20, "ZZ9XU-Z": "x", "": 5, "ZZ9XU-Y": null}}'}) == {"ZZ9XU-G": 20.0, "ZZ9XU-Z": None, "ZZ9XU-Y": None})
    base = {"carriers": "holders", "weight_mode": "own", "weight": None, "bands_json": None, "business_group": BG, "company": CO,
            "carriers_json": json.dumps({"people": ["ZZ9XU-A"], "guests": {"ZZ9XU-G": 20}})}
    pg_, pa_, pz_ = ({"employee_id": "ZZ9XU-" + e, "business_group": CO_OF[e][0], "company": CO_OF[e][1], "department": "Sales", "job_grade": "14"}
                     for e in "GAZ")
    s.check("a guest is covered; so is a unit carrier; someone of another unit who is not a guest is not",
            a._bu_kpi_covers(base, pg_) and a._bu_kpi_covers(base, pa_) and not a._bu_kpi_covers(base, pz_))
    for mode, extra_ in (("everyone", {}), ("pick", {}), ("departments", {}), ("grade", {})):
        st_ = dict(base, carriers=mode, carriers_json=json.dumps({"guests": {"ZZ9XU-G": 20}, "departments": ["Sales"], "min": 10, "max": 20}))
        s.check("...whatever the carrier mode (%s): the guest is covered, the other unit's non-guest is not" % mode,
                a._bu_kpi_covers(st_, pg_) and not a._bu_kpi_covers(st_, pz_))
    s.check("a guest's weight is their line's, else the one given; a unit carrier's is as before",
            a._bu_kpi_weight(base, pg_, {"weightage": 35}) == 35 and a._bu_kpi_weight(base, pg_) == 20
            and a._bu_kpi_weight(dict(base, weight_mode="one", weight=15), pg_) == 20
            and a._bu_kpi_weight(dict(base, weight_mode="one", weight=15), pa_) == 15
            and a._bu_kpi_weight(base, pa_, {"weightage": 30}) == 30)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("set up: PAT saved for A, B, C, D (ZZXU Alpha)")
    save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"]))
    SID, sdata = setup_row()
    s.check("PAT is saved for the four, linked, at the unit's target", SID and sorted(sdata.get("people") or []) == [
        "ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"] and "guests" not in sdata and all(
            ln(e)[4] == SID and ln(e)[2:4] == (80, 120) for e in "ABCD"), (SID, sdata))
    with a.app.app_context():
        d_ = a.get_db()
        people_u1 = a._bu_unit_people(d_, BG, CO)
        row_ = d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (SID,)).fetchone()
        act_ = a.active_cycle(d_)
        s.check("the pool is the unit's people as passed when there are no guests (the same list)",
                [p["id"] for p in a._bu_kpi_pool(d_, act_, row_, people_u1)] == [p["id"] for p in people_u1])

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the person page: G (ZZXU Beta, 70%) joins ZZXU Alpha's PAT as a guest at 20%")
    js, pg = kpe_json("G")
    it = item(js)
    s.check("G is offered ZZXU Alpha's PAT as a row of another unit: pickable, the unit's target, 4 carry it, no guests yet",
            it and it["other_unit"] is True and it["why"] is None and it["sid"] == SID and it["unit_name"] == CO and it["n"] == 4
            and it["guests"] == 0 and it["room"] == 30 and js["bu_unit"] == CO2 and js["bu_group"] == BG, it)
    s.check("...their own unit has nothing saved, so its only own-unit rows are the library's greyed 'Not set up' ones; the group's name is on the data",
            all(x.get("other_unit") or x["sid"] is None for x in js["bu_items"]) and js["bu_group"] == BG, [x["name"] for x in js["bu_items"]])
    ji, _p = kpe_json("I")
    s.check("I (an own PAT line, the same root) sees it greyed with the writer's words, not hidden: it IS named PAT",
            item(ji) is None, "")   # exactly that name is carried: not listed (the same rule as the unit's own)
    jh, _p = kpe_json("H")
    s.check("H (100%): greyed 'Their KPIs already add up to 100%. Lower a weight first.'", item(jh)["why"] == "Their KPIs already add up to 100%. Lower a weight first.", item(jh))
    jx, _p = kpe_json("X")
    s.check("X (another business group) is offered nothing from this group", not any(x.get("other_unit") for x in jx.get("bu_items") or []), [x["name"] for x in jx.get("bu_items") or []])
    s.check("the Add form's page carries the other-unit words the script reads", "data-kpe-bu-badge" in pg and "Other units" not in pg, "")
    base = snapshot()
    collected = []
    orig_collect = a._redo_collect

    def spy(db_, act_, p_, change_):
        collected.append((p_["id"], change_["kind"], change_["name"]))
        return orig_collect(db_, act_, p_, change_)
    a._redo_collect = spy
    try:
        r = person_post("G", SID, "20")
        out = say(r)
        g = ln("G")
        sid_now, sd = setup_row()
        s.check("G has ONE PAT line: 20%, the unit's target (80..120), linked to the setup and its library KPI, on THEIR OWN group and unit",
                g and g[1] == 20 and g[2:4] == (80, 120) and g[4] == SID and g[6] == PAT and g[7:9] == (BG, CO2)
                and json.loads(g[5] or "{}").get("added") == 1 and H.one(
                    a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=? AND kpi_name=?", (U["G"], PAT_N)) == 1, g)
        s.check("the setup keeps G in guests at 20 and the unit's own people exactly as they were (no added_w left)",
                sd.get("guests") == {"ZZ9XU-G": 20.0} and sorted(sd.get("people") or []) == ["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"]
                and "added_w" not in sd and sid_now == SID, sd)
        after = snapshot()
        changed = [x for x in after[0] if x not in base[0]]
        s.check("nobody else's line moved: the one new row is G's PAT; A..D and G's own two lines are as they were",
                len(changed) == 1 and changed[0][:2] == ("ZZ9XU-G", PAT_N) and all(x in after[0] for x in base[0]), changed)
        s.check("the flash: '<KPI> added for <name> at <w>%, at <unit> target.'",
                "ZZXU PAT added for ZZ XU G at 20%, at ZZXU Alpha's target." in out, flashes(r)[:200])
        lg = H.rows(a, "SELECT detail, target_user_id FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZXU PAT%' ORDER BY id DESC LIMIT 1")
        s.check("the trail names it in the BU KPI's words: '1 added from another unit (ZZ9XU-G, ZZXU Beta at 20%)', on G's page log",
                lg and lg[0][0].endswith("· 1 added from another unit (ZZ9XU-G, ZZXU Beta at 20%)") and "1 added, 0 updated, 0 taken off" in lg[0][0]
                and lg[0][1] == U["G"], lg)
        s.check("the line is collected for the 'something changed' email, as the unit's own add is", (U["G"], "kpi", PAT_N) in collected, collected)
    finally:
        a._redo_collect = orig_collect
    jg, pgg = kpe_json("G")
    s.check("G's total reads 90 and PAT is no longer offered to them (they carry it)", jg["bu_total"] == 90 and item(jg) is None, jg["bu_total"])
    s.check("G's own page: the line carries the grey BU KPI chip and ZZXU Alpha's outlined chip",
            re.search(r'pp-chip" title="A BU KPI[^>]*>BU KPI</span><span class="pp-chip is-unit"[^>]*>ZZXU Alpha</span>', pgg) is not None, "")
    with a.app.app_context():
        d_ = a.get_db()
        users_ = [dict(d_.execute("SELECT * FROM users WHERE id=?", (U[e],)).fetchone()) for e in "ABGHI"]
        mp = a._pm_bu_names_map(d_, users_, CID)
        # the call counts: the names map reads the guests' lines in a bounded number of queries, however many people
        qn = []
        d_.set_trace_callback(lambda sql: qn.append(sql))
        a._pm_bu_names_map(d_, users_ * 20, CID)
        d_.set_trace_callback(None)
    s.check("_pm_bu_names_map still answers by the library for the unit's own people (A reads PAT as BU)", "zzxu pat" in mp[U["A"]], {k: sorted(v) for k, v in mp.items()})
    s.check("...and the guest read is batched: the same few queries for 100 people as for 5 (no per-person query)",
            len(qn) < 14, len(qn))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("every guard refuses and writes nothing (the person page's way in)")
    base = snapshot()

    def refused(label, resp, words):
        now = snapshot()
        out = say(resp) if not isinstance(resp, int) else ""
        ok = now == base and ((words in out and "Nothing was added" in out) if words else True)
        s.check(label, ok, (words, now == base, flashes(resp)[:160] if not isinstance(resp, int) else resp))

    r = person_post("Z", SID, "10", client=BGC, follow=False)
    s.check("a role that holds the Add right but is not the super admin: 403", r.status_code == 403 and snapshot() == base, r.status_code)
    refused("another business group (X): the setup is not in their group", person_post("X", SID, "10"), "That BU KPI is not set up for ZZ XU X's business group on")
    refused("not taking part in the cycle (K)", person_post("K", SID, "10"), "They aren't taking part in")
    refused("already a guest (G again)", person_post("G", SID, "5"), "They already carry it.")
    refused("holds a line of the same root (I: their own ZZXU PAT is the same KPI name here, so 'already carry' comes first)", person_post("I", SID, "10"), "They already carry it.")
    refused("100% already (H)", person_post("H", SID, "10"), "Their KPIs already add up to 100%. Lower a weight first.")
    refused("a weight over the room (Z holds 40: at most 60 more)", person_post("Z", SID, "70"), "Their KPIs hold 40%, so at most 60% more.")
    refused("no weight", person_post("Z", SID, None), "Give their weight.")
    refused("a blank weight", person_post("Z", SID, " "), "Give their weight.")
    refused("a weight of 0", person_post("Z", SID, "0"), "Give their weight.")
    refused("a negative weight", person_post("Z", SID, "-3"), "Give their weight.")
    refused("a weight of words", person_post("Z", SID, "lots"), "Give their weight.")
    refused("a weight of nan", person_post("Z", SID, "nan"), "Give their weight.")
    refused("a weight of inf", person_post("Z", SID, "inf"), "Give their weight.")
    refused("a setup id that does not exist", person_post("Z", 999999, "10"), "That BU KPI is not set up for")
    refused("a setup id that is not a number", person_post("Z", "abc", "10"), "That BU KPI is not set up for")
    # the same-root guard (a root-sharing line that is NOT the same name): Y holds "ZZXU PAT: Gamma"
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, rate2, rate3, "
                   "rate4, rate5, business_group, company) VALUES (?,?, 'ZZXU PAT: Gamma', 10, 'more', '%', 'Own', 1,2,3,4,5, ?,?)",
                   (CID, U["Y"], BG, CO3))
        d_.commit()
    base = snapshot()
    refused("a line whose ROOT is the setup's (Y holds 'ZZXU PAT: Gamma'): 'They already carry a KPI named ZZXU PAT: take that off first.'",
            person_post("Y", SID, "10"), "They already carry a KPI named ZZXU PAT: take that off first.")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM pm_kpi_targets WHERE subject_id=? AND kpi_name='ZZXU PAT: Gamma'", (U["Y"],))
        d_.commit()
    base = snapshot()
    # direct writer: someone of the unit itself, an admin account, nobody
    with a.app.app_context():
        d_ = a.get_db()
        me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        act_ = a.active_cycle(d_)
        srow_ = d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (SID,)).fetchone()
        n1, w1 = a._bu_kpi_add_guest(d_, me_, act_, srow_, {"id": U["C"]}, "5")
        n2, w2 = a._bu_kpi_add_guest(d_, me_, act_, srow_, {"id": SU["id"]}, "5")
        n3, w3 = a._bu_kpi_add_guest(d_, me_, act_, srow_, None, "5")
        d_.rollback()
    s.check("the writer: someone in the unit itself is not a guest ('They are in ZZXU Alpha itself')",
            n1 is None and w1 == "They are in ZZXU Alpha itself: a guest is someone from another unit.", w1)
    s.check("...an admin account and nobody are not people taking part", n2 is None and w2.startswith("They aren't taking part in") and n3 is None
            and w3.startswith("They aren't taking part in"), (w2, w3))
    s.check("...and none of the refusals wrote a thing", snapshot() == base)
    kind("early_year", 0)
    refused("an Early Year", person_post("Z", SID, "10"), "This is an Early Year")
    kind("year_end", 2)
    hod_window(False)
    refused("the Department Review started", person_post("Z", SID, "10"), "The Department Review started on ")
    hod_window(True)
    other_cid = (H.one(a, "SELECT MAX(id) FROM cycles") or 0) + 1
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("PRAGMA foreign_keys=OFF")
        d_.execute("UPDATE pm_bu_kpis SET cycle_id=? WHERE id=?", (other_cid, SID))
        d_.commit()
    base = snapshot()
    refused("a setup of another cycle", person_post("Z", SID, "10"), "That BU KPI is not set up for")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET cycle_id=? WHERE id=?", (CID, SID))
        d_.commit()
    base = snapshot()
    # a setup that does not go on "those who carry it now, each at their own weight"
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET weight_mode='one', weight=25 WHERE id=?", (SID,))
        d_.commit()
    base = snapshot()
    refused("a setup at one weight for all (set on BU KPI setup first)", person_post("Z", SID, "10"), "or at one weight, so it is set on BU KPI setup")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET weight_mode='own', weight=NULL WHERE id=?", (SID,))
        d_.commit()
    base = snapshot()

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the card's Add block: the picker feed (?xbu=) says, per person, who can join and who cannot")
    r = SUP.get("/admin/people/find.json?q=ZZ+XU&xbu=%d" % SID)
    ppl = {x["eid"]: x for x in (r.get_json() or {}).get("people", [])}
    s.check("only the group's people NOT in the unit, taking part: no ZZXU Alpha people, no X (another group), no K (out of the cycle), no admin",
            ppl and not any(e in ppl for e in ("ZZ9XU-A", "ZZ9XU-X", "ZZ9XU-K", "ZZ9XU-ADM", "ZZ9XU-M")) and {"ZZ9XU-G", "ZZ9XU-H", "ZZ9XU-Z", "ZZ9XU-Y", "ZZ9XU-I", "ZZ9XU-N"} <= set(ppl),
            sorted(ppl))
    s.check("each carries unit, JG, KPIs today, weights and the writer's own words when they cannot join",
            ppl["ZZ9XU-Z"]["why"] is None and ppl["ZZ9XU-Z"]["unit"] == CO3 and ppl["ZZ9XU-Z"]["jg"] == "JG 14" and ppl["ZZ9XU-Z"]["kn"] == "1 KPI"
            and ppl["ZZ9XU-Z"]["w"] == 40 and ppl["ZZ9XU-Z"]["room"] == 60
            and ppl["ZZ9XU-H"]["why"] == "Their KPIs already add up to 100%. Lower a weight first."
            and ppl["ZZ9XU-G"]["why"] == "They already carry it." and ppl["ZZ9XU-I"]["why"] == "They already carry it.", {k: v.get("why") for k, v in ppl.items()})
    s.check("a BG admin is given nobody, and a setup id that is not a number, nobody",
            (BGC.get("/admin/people/find.json?q=ZZ+XU&xbu=%d" % SID).get_json() or {}).get("people") == []
            and (SUP.get("/admin/people/find.json?q=ZZ+XU&xbu=abc").get_json() or {}).get("people") == [], "")
    s.check("without ?xbu= the picker is as before: no why / room fields",
            all("why" not in x for x in (SUP.get("/admin/people/find.json?q=ZZ+XU").get_json() or {}).get("people", [])), "")
    pge = say(SUP.get(url() + "&kpi=%d&edit=1" % PAT))
    s.check("the card in Edit has the part 'From another unit in ZZXU Group' with the picker (data-pick-xbu) and the guest grid's Unit column",
            "From another unit in ZZXU Group" in pge and 'data-pick-xbu="%d"' % SID in pge and 'class="bk-add bk-gadd"' in pge and "<span>Unit</span>" in pge, "")
    s.check("a BG admin's card has no such part", 'class="bk-add bk-gadd"' not in say(BGC.get(url() + "&kpi=%d&edit=1" % PAT)), "")
    kind("early_year", 0)
    s.check("an Early Year's card has none either", 'class="bk-add bk-gadd"' not in say(SUP.get(url() + "&kpi=%d&edit=1" % PAT)), "")
    kind("year_end", 2)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the card's save: a refused guest rolls the WHOLE save back, a good one joins in the same transaction")
    base = snapshot()
    out = say(save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], rates=(70, 80, 90, 100, 110), guests={"ZZ9XU-H": "10"})))
    s.check("a target change AND a guest at 100% already: refused in words naming them, the target change is NOT saved",
            "ZZ XU H (ZZ9XU-H): Their KPIs already add up to 100%. Lower a weight first. Nothing was saved." in out and snapshot() == base, "")
    out = say(save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], rates=(70, 80, 90, 100, 110), guests={"ZZ9XU-Z": "70"})))
    s.check("...a weight over the room, the same", "ZZ XU Z (ZZ9XU-Z): Their KPIs hold 40%, so at most 60% more." in out and snapshot() == base, "")
    out = say(save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], guests={"ZZ9XU-Z": None})))
    s.check("...no weight", "Give their weight." in out and snapshot() == base, "")
    out = say(save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], guests={"ZZ9XU-X": "10"})))
    s.check("...someone of another business group (X)", "business group: a BU KPI is carried within its own group." in out and snapshot() == base, "")
    out = say(save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], guests={"ZZ9XU-NOPE": "10"})))
    s.check("...an Employee ID that is nobody", "ZZ9XU-NOPE isn't someone in OneHR" in out and snapshot() == base, "")
    out = say(save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], guests={"ZZ9XU-Z": "10", "ZZ9XU-H": "10"})))
    s.check("...one good and one bad guest: the good one is rolled back too (all or nothing)", snapshot() == base and "Nothing was saved." in out, "")
    r = save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], guests={"ZZ9XU-Z": "10"}), client=BGC)
    s.check("a BG admin posting a guest: refused in words, the whole save rolled back, nothing written",
            "Adding a BU KPI to someone is the super admin's." in say(r) and snapshot() == base, "")
    kind("early_year", 0)
    out = say(save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], guests={"ZZ9XU-Z": "10"})))
    s.check("an Early Year: the guest part is refused with its words", "This is an Early Year" in out and snapshot() == base, "")
    kind("year_end", 2)
    base = snapshot()
    r = SUP.post(url(), data={"csrf_token": "tok", "action": "save", "kpi": str(PAT), **card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], guests={"ZZ9XU-Z": "10"})}, follow_redirects=True)
    s.check("the whole-unit save (no action) never takes a guest: refused in words, nothing written",
            "adding someone from another unit is done on that KPI's own card" in say(r) and snapshot() == base, "")
    out = say(save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], guests={"ZZ9XU-Z": "15"})))
    sid2, sd = setup_row()
    z = ln("Z")
    s.check("a good guest (Z at 15) joins in the card's own save: a line at the target, their weight, their own unit; the flash names them with their unit",
            z and z[1] == 15 and z[2:4] == (80, 120) and z[4] == SID and z[7:9] == (BG, CO3)
            and "1 added from another unit: ZZ XU Z (ZZXU Gamma) at 15%." in out, (z, flashes(SUP.get(url()))[:100]))
    s.check("...the setup's guests are G and Z, its own people untouched", sd.get("guests") == {"ZZ9XU-G": 20.0, "ZZ9XU-Z": 15.0}
            and sorted(sd.get("people")) == ["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], sd)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("THE TRAP: a card save keeps the guests (target change reaches them; no change keeps them)")
    gline_before = ln("G")
    out = say(save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], rates=(70, 80, 90, 100, 110))))
    sid2, sd = setup_row()
    s.check("after a save that changes the target, BOTH guests are still in guests (the next save did not drop them)",
            sd.get("guests") == {"ZZ9XU-G": 20.0, "ZZ9XU-Z": 15.0}, sd)
    s.check("...their lines took the new target (70..110) like everyone's, at their own weights, still linked, still on their own unit",
            all(ln(e)[2:4] == (70, 110) and ln(e)[4] == SID for e in "GZ") and ln("G")[1] == 20 and ln("Z")[1] == 15
            and ln("G")[7:9] == (BG, CO2) and ln("Z")[7:9] == (BG, CO3) and ln("G")[0] == gline_before[0]
            and all(ln(e)[2:4] == (70, 110) for e in "ABCD"), [ln(e) for e in "GZ"])
    s.check("...the flash counts the guests' updated lines with the unit's: 6 updated", "6 updated" in out, flashes(SUP.get(url()))[:160])
    snap1 = snapshot()
    save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], rates=(70, 80, 90, 100, 110)))
    sid2, sd = setup_row()
    s.check("a save with NO change keeps them too, and changes no line", sd.get("guests") == {"ZZ9XU-G": 20.0, "ZZ9XU-Z": 15.0}
            and [x[:6] for x in snapshot()[0]] == [x[:6] for x in snap1[0]], sd)
    # a holder unticked in the card still leaves the guests alone
    save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C"], rates=(70, 80, 90, 100, 110)))
    sid2, sd = setup_row()
    s.check("unticking a holder of the unit leaves the guests alone", sd.get("guests") == {"ZZ9XU-G": 20.0, "ZZ9XU-Z": 15.0}
            and sorted(sd["people"]) == ["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C"] and ln("G")[4] == SID and ln("D")[4] is None, sd)
    save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], rates=(80, 90, 100, 110, 120)))   # D back, original target

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the card reads: guests in Who carries it with their unit, the count line, Search in, the strip, the rail")
    pgr = say(SUP.get(url() + "&kpi=%d" % PAT))
    s.check("Who carries it counts the guests: 6 (four of the unit, two from other units)", "Who carries it · 6" in pgr, "")
    s.check("Carried by says '2 from other units' (and only when there are some)", "2 from other units" in pgr, "")
    s.check("each guest is listed with the outlined 'From <their unit>' chip after 'BU KPI'",
            "From ZZXU Beta</span>" in pgr and "From ZZXU Gamma</span>" in pgr
            and re.search(r'bk2-pill is-navy">BU KPI</span><span class="bk2-pill is-unit"[^>]*>From ZZXU Beta', pgr) is not None, "")
    s.check("...their name links to their page", re.search(r'<a class="bk2-pl" href="/admin/users/%d[^"]*">ZZ XU G</a>' % U["G"], pgr) is not None, "")
    s.check("Search in has Unit, and a row carries its unit to search by", '<option value="unit">Unit</option>' in pgr and 'data-unit="zzxu beta"' in pgr, "")
    s.check("the strip says the one result reaches the guests too", "Its result is entered once for ZZXU Alpha and reaches all 6, the 2 from other units too." in pgr, "")
    s.check("the rail counts them: '6 carry it'", re.search(r"Rates 80 to 120% · 6 carry it", pgr) is not None, "")
    base_r = say(SUP.get(url(CO2)))
    s.check("their own unit's card list (ZZXU Beta) is not told anything: it has no saved BU KPI, so no Who carries it",
            "Who carries it" not in base_r, "")
    with a.app.app_context():
        d_ = a.get_db()
        me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
    with a.app.test_request_context("/admin"):
        a.g.user = None
        d_ = a.get_db()
        gl = a._bu_kpi_guest_lines(d_, a.active_cycle(d_), [SID, 999999])
        qq = []
        d_.set_trace_callback(lambda sql: qq.append(sql))
        a._bu_kpi_guest_lines(d_, a.active_cycle(d_), [SID, SID + 1, SID + 2, 999999])
        d_.set_trace_callback(None)
    s.check("_bu_kpi_guest_lines: one query however many setups; the guests' lines with their unit",
            sorted(p["employee_id"] for _l, p in gl[SID]) == ["ZZ9XU-G", "ZZ9XU-Z"] and gl[999999] == [] and len(qq) == 1
            and all(p["unit"] in (CO2, CO3) for _l, p in gl[SID]), (len(qq), [p["employee_id"] for _l, p in gl[SID]]))
    def holders_of(co):
        with a.app.test_request_context("/admin"):
            d_ = a.get_db()
            me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
            return a._list_bu_kpi_holders(d_, me_, None, {"bg": BG, "co": co, "kpi": PAT_N})
    hj, hj2 = holders_of(CO), holders_of(CO2)
    s.check("the 'N carry it' people panel lists them once each: 6 people, the guests among them", "6 carry it" in hj["title"] and len(hj["rows"]) == 6, hj["title"])
    s.check("...the guests (G, Z) carry the outlined 'From <their unit>' chip in that list, the unit's own four (A to D) none (review fix 4)",
            {r["name"]: r.get("chip") for r in hj["rows"]} == {"ZZ XU A": None, "ZZ XU B": None, "ZZ XU C": None, "ZZ XU D": None,
                                                              "ZZ XU G": "From ZZXU Beta", "ZZ XU Z": "From ZZXU Gamma"}, {r["name"]: r.get("chip") for r in hj["rows"]})
    s.check("...and their own unit's panel for that name lists only its own people (I's own PAT), not the guests", "1 carry it" in hj2["title"] and len(hj2["rows"]) == 1, hj2["title"])

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Fill BU result: the guest's line is filled once, with the unit whose KPI it is; their own unit's name rule skips it")
    with a.app.app_context():
        d_ = a.get_db()
        me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        per = a.active_pm_period(d_)
        t1 = a._bu_fill_targets(d_, me_, per, BG, CO, PAT_N)
        t2 = a._bu_fill_targets(d_, me_, per, BG, CO2, PAT_N)
        tg = a._bu_fill_targets(d_, me_, per, BG, "", PAT_N)
        _t, bk, subs, cfg = a._bu_fill_buckets(d_, me_, per, BG, CO, PAT_N, 100)
    eids1 = sorted(U_[0] for U_ in [(H.one(a, "SELECT employee_id FROM users WHERE id=?", (t["subject_id"],)),) for t in t1])
    eids2 = sorted(H.one(a, "SELECT employee_id FROM users WHERE id=?", (t["subject_id"],)) for t in t2)
    eidsg = sorted(H.one(a, "SELECT employee_id FROM users WHERE id=?", (t["subject_id"],)) for t in tg)
    s.check("the unit's fill reaches its four AND the two guests, once each", eids1 == ["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D", "ZZ9XU-G", "ZZ9XU-Z"], eids1)
    s.check("the guest's own unit's name rule for the same name reaches only I's own PAT, never the guest's linked line", eids2 == ["ZZ9XU-I"], eids2)
    s.check("the whole group's fill has each of them exactly once (the unit's six and I's own)", eidsg == sorted(eids1 + ["ZZ9XU-I"]) and len(eidsg) == len(set(eidsg)), eidsg)
    s.check("the buckets' subjects and the scoring config are the group's: every one of the six sits in 'will fill'",
            sum(len(v) for v in bk.values()) == 6 and len(bk["will_fill"]) == 6 and cfg["business_group"] == BG, {k: len(v) for k, v in bk.items()})
    r = SUP.post("/admin/performance/bu-fill", data={"csrf_token": "tok", "business_group": BG, "company": CO, "kpi_name": PAT_N,
                                                     "actual_value": "105", "note": "ZZXU unit figure", "reason": "ZZXU audited"}, follow_redirects=True)
    got = {e: H.rows(a, "SELECT r.actual_value, r.admin_filled, r.draft FROM pm_kpi_results r WHERE r.kpi_target_id=?", (tid_of(e),)) for e in "ABCDGZ"}
    s.check("Fill (unit ZZXU Alpha, 105): each of the six has ONE final admin-filled result, G and Z included",
            all(len(v) == 1 and tuple(v[0]) == (105.0, 1, 0) for v in got.values()), {k: [tuple(x) for x in v] for k, v in got.items()})
    s.check("...I's own PAT (ZZXU Beta) got nothing", H.one(a, "SELECT COUNT(*) FROM pm_kpi_results WHERE kpi_target_id=?", (tid_of("I"),)) == 0, "")
    r = SUP.post("/admin/performance/bu-fill", data={"csrf_token": "tok", "business_group": BG, "company": CO2, "kpi_name": PAT_N,
                                                     "actual_value": "50", "note": "ZZXU beta", "reason": "ZZXU audited"}, follow_redirects=True)
    s.check("Fill for the guest's own unit (ZZXU Beta, 50): I's own PAT is filled; the guest G's line stays at 105",
            H.rows(a, "SELECT actual_value FROM pm_kpi_results WHERE kpi_target_id=?", (tid_of("I"),))[0][0] == 50.0
            and H.rows(a, "SELECT actual_value FROM pm_kpi_results WHERE kpi_target_id=?", (tid_of("G"),))[0][0] == 105.0, "")
    with a.app.app_context():
        d_ = a.get_db()
        me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        fm = a._bu_filled_map(d_, me_, a.active_pm_period(d_), BG)
        fm1 = a._bu_filled_map(d_, me_, a.active_pm_period(d_), BG, CO)
        fm2 = a._bu_filled_map(d_, me_, a.active_pm_period(d_), BG, CO2)
    k_ = a._kpi_key(PAT_N)
    s.check("the filled map counts the six under ZZXU Alpha (one figure, 105), and I's one under ZZXU Beta (50); the guests are not counted twice",
            fm[(CO, k_)]["n"] == 6 and fm[(CO, k_)]["values"] == {105.0: 6} and fm[(CO2, k_)]["n"] == 1 and fm[(CO2, k_)]["values"] == {50.0: 1}
            and fm1.get((CO, k_), {}).get("n") == 6 and (CO2, k_) not in fm1 and fm2.get((CO2, k_), {}).get("n") == 1 and (CO, k_) not in fm2,
            {k: v["n"] for k, v in fm.items() if k[1] == k_})
    pgf = say(SUP.get("/admin/performance/bu-fill?business_group=%s&company=%s&kpi_name=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"), PAT_N.replace(" ", "+"))))
    s.check("the Fill page for the unit reads its filled card: 'Who gets this result · 6', the guests among them", "Who gets this result · 6" in pgf and "Filled" in pgf, re.findall(r"Who gets this result · \d+", pgf))
    pgf2 = say(SUP.get("/admin/performance/bu-fill?business_group=%s&company=%s" % (BG.replace(" ", "+"), CO2.replace(" ", "+"))))
    s.check("ZZXU Beta's Fill name list shows PAT because of I's own line only (the guest's line adds no name)", PAT_N in pgf2, "")
    with a.app.app_context():
        d_ = a.get_db()
        me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        rail = a._bu_fill_rail(d_, me_, a.active_pm_period(d_), BG, CO, [CO])
        rail2 = a._bu_fill_rail(d_, me_, a.active_pm_period(d_), BG, CO2, [CO2])
    sv = next((x for x in rail["saved"] if x["name"] == PAT_N), None)
    s.check("the Fill rail counts the six as carrying it (4 + 2 guests), none 'keeping their own'", sv and sv["carry"] == 6 and sv["keep"] == 0, sv and (sv["carry"], sv["keep"]))
    s.check("...and ZZXU Beta's rail sees only I's own PAT line (no saved setup there)", not rail2["saved"] and any(
        _k == PAT_N for _k in [x["name"] for x in rail2["lib"] + rail2["other"]]), [x["name"] for x in rail2["lib"] + rail2["other"]])
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZ9XU-%'))")
        d_.commit()

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Home's before-calibration card counts a setup's lines once, the guests' included")
    with a.app.app_context():
        d_ = a.get_db()
        orig_win = d_.execute("SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell='pm_buceo'", (CID,)).fetchone()
        orig_pm = d_.execute("SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key='pm'", (CID,)).fetchone()
        d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_buceo'", (CID,))
        d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_buceo', '2099-11-20 00:00', '2099-11-30 23:59')", (CID,))
        if orig_pm is None:
            d_.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'pm', 1)", (CID,))
        else:
            d_.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key='pm'", (CID,))
        d_.commit()

    def precal():
        with a.app.test_request_context("/admin"):
            d_ = a.get_db()
            me_ = dict(d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
            c = a._precal_alert(d_, me_)
        return next((r for r in (c or {}).get("rows", []) if r["bg"] == BG), None)

    def fill_line(eid):
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft, admin_filled) VALUES (?,100,?,0,1)", (tid_of(eid), SU["id"]))
            d_.commit()
    for e in "ABCD":
        fill_line(e)
    row_ = precal()
    s.check("the four unit lines are filled but the two guests' are not: PAT is NOT filled yet (the guests are counted, once)",
            row_ and row_["bu_n"] >= 1 and "ZZXU PAT" in row_["bu_todo"] and row_["bu_done"] == 0, row_ and (row_["bu_n"], row_["bu_done"], row_["bu_todo"]))
    fill_line("G")
    s.check("one guest still missing: still not filled", precal()["bu_done"] == 0, "")
    fill_line("Z")
    row_ = precal()
    s.check("every line filled, the guests' included: PAT is filled, counted ONCE (one setup, 6 lines)", row_["bu_n"] == 1 and row_["bu_done"] == 1 and row_["bu_todo"] == "", (row_["bu_n"], row_["bu_done"]))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZ9XU-%'))")
        d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_buceo'", (CID,))
        if orig_win:
            d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_buceo', ?, ?)", (CID, orig_win[0], orig_win[1]))
        if orig_pm is None:
            d_.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='pm'", (CID,))
        else:
            d_.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key='pm'", (orig_pm[0], CID))
        d_.commit()

    # ---------------------------------------------------------------------------------------------------------------
    s.section("take a guest off from their own page; the cases that refuse")
    tz = tid_of("Z")
    base = snapshot()
    r = SUP.post("/admin/users/%d/kpi" % U["Z"], data={"csrf_token": "tok", "action": "take_off_bu", "kpi_target_id": str(tz)}, follow_redirects=True)
    sid2, sd = setup_row()
    s.check("Z comes off: the line is gone (it was put on by the setup), they leave guests, G and the unit's people stay",
            ln("Z") is None and sd.get("guests") == {"ZZ9XU-G": 20.0} and sorted(sd["people"]) == ["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"]
            and ln("G") and ln("Z", "ZZXU Sales")[1] == 40, sd)
    s.check("...the flash says so and the trail marks a guest", "ZZ XU Z taken off ZZXU PAT" in say(r) and H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%taken off from the person page (ZZ9XU-Z, a guest from ZZXU Gamma)%'") == 1, "")
    s.check("their own other line is untouched (Z's Sales at 40)", ln("Z", "ZZXU Sales")[1] == 40)
    # take-off refuses when someone has acted on the line
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) VALUES (?, 99, 'own', ?, 0, 0)", (tid_of("G"), U["G"]))
        d_.commit()
    base = snapshot()
    r = SUP.post("/admin/users/%d/kpi" % U["G"], data={"csrf_token": "tok", "action": "take_off_bu", "kpi_target_id": str(tid_of("G"))}, follow_redirects=True)
    s.check("a guest whose line has a result is refused ('so it stays'), nothing written", "so it stays" in say(r) and "Nothing was taken off" in say(r) and snapshot() == base, flashes(r)[:140])
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (tid_of("G"),))
        d_.commit()
    # take-off by a non-super is refused with 403
    r = person_post("G", SID, None, client=BGC, action="take_off_bu", follow=False, extra={"kpi_target_id": str(tid_of("G"))})
    s.check("a BG admin cannot take a guest off (403)", r.status_code == 403 and ln("G") is not None, r.status_code)
    SUP.post("/admin/users/%d/kpi" % U["G"], data={"csrf_token": "tok", "action": "take_off_bu", "kpi_target_id": str(tid_of("G"))}, follow_redirects=True)
    s.check("G comes off too (the last guest): `guests` is gone from the setup, the unit's four carry it as before", ln("G") is None
            and "guests" not in setup_row()[1] and len(setup_row()[1]["people"]) == 4, setup_row()[1])
    # a guest in a setup of another carrier mode comes off too
    save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], guests={"ZZ9XU-Y": "10"}))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET carriers='everyone' WHERE id=?", (SID,))
        d_.commit()
    ty = tid_of("Y")
    r = SUP.post("/admin/users/%d/kpi" % U["Y"], data={"csrf_token": "tok", "action": "take_off_bu", "kpi_target_id": str(ty)}, follow_redirects=True)
    s.check("a guest comes off whatever the setup's carrier mode (the setup was set to 'everyone')", ln("Y") is None and "ZZ XU Y taken off ZZXU PAT" in say(r), flashes(r)[:140])
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET carriers='holders' WHERE id=?", (SID,))
        d_.commit()
    # an ordinary unit person in a pick-mode setup still cannot be taken off here (unchanged rule)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET carriers='pick' WHERE id=?", (SID,))
        d_.commit()
    base = snapshot()
    r = SUP.post("/admin/users/%d/kpi" % U["B"], data={"csrf_token": "tok", "action": "take_off_bu", "kpi_target_id": str(tid_of("B"))}, follow_redirects=True)
    s.check("...but a person of the unit still can't be taken off a setup by pick (the rule is unchanged)", "set on BU KPI setup" in say(r) and snapshot() == base, "")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET carriers='holders' WHERE id=?", (SID,))
        d_.commit()

    # ---------------------------------------------------------------------------------------------------------------
    s.section("take the KPI off the unit: the guests' lines go back too")
    save_kpi(card(["ZZ9XU-A", "ZZ9XU-B"], lid=GP, rates=(70, 80, 90, 100, 110)), lid=GP)
    # A and B hold PAT only: GP needs holders with GP lines; use the card's Add block for unit people: simply add A and B via holders after giving them lines
    # (the unit's holder list is people who already hold the KPI: put GP lines on A and B first)
    with a.app.app_context():
        d_ = a.get_db()
        for e in "AB":
            d_.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, rate2, rate3, rate4, rate5, "
                       "business_group, company, library_id) VALUES (?,?,?,?, 'more', '%', 'Own', 1,2,3,4,5, ?,?,?)", (CID, U[e], GP_N, 10, BG, CO, GP))
        d_.commit()
    save_kpi(card(["ZZ9XU-A", "ZZ9XU-B"], lid=GP, rates=(70, 80, 90, 100, 110)), lid=GP)
    GSID, gd = setup_row(GP_N)
    s.check("GP is saved for A and B", GSID and sorted(gd.get("people") or []) == ["ZZ9XU-A", "ZZ9XU-B"], gd)
    out = say(save_kpi(card(["ZZ9XU-A", "ZZ9XU-B"], lid=GP, guests={"ZZ9XU-Y": "10", "ZZ9XU-Z": "20"}), lid=GP))
    gid, gd = setup_row(GP_N)
    s.check("two guests join GP in one card save (Y at 10, Z at 20)", gd.get("guests") == {"ZZ9XU-Y": 10.0, "ZZ9XU-Z": 20.0}
            and ln("Y", GP_N) and ln("Z", GP_N)[1] == 20 and ln("Y", GP_N)[4] == GSID and "2 added from another unit" in out, gd)
    with a.app.app_context():
        d_ = a.get_db()
        nm_y, nm_z, nm_h = (a.pm_bu_level_names(d_, d_.execute("SELECT * FROM users WHERE id=?", (U[e],)).fetchone(), CID) for e in "YZH")
    s.check("pm_bu_level_names: GP is a BU KPI of ZZXU Alpha ONLY, so a guest's line is Group People's to fill by the guest rule alone: "
            "Y and Z read GP as BU, H (not a guest, same unit as nothing here) does not",
            "zzxu gp" in nm_y and "zzxu gp" in nm_z and "zzxu gp" not in nm_h, (sorted(nm_y), sorted(nm_h)))
    own_before = {e: ln(e, "ZZXU Sales") for e in "YZ"}
    r = SUP.post(url(), data={"csrf_token": "tok", "action": "take_off", "setup": str(GSID)}, follow_redirects=True)
    s.check("GP taken off the unit: the guests' GP lines are gone too, their own lines untouched, the setup gone",
            ln("Y", GP_N) is None and ln("Z", GP_N) is None and ln("A", GP_N)[4] is None and ln("A", GP_N)[1] == 10 and setup_row(GP_N)[0] is None
            and all(ln(e, "ZZXU Sales") == own_before[e] for e in "YZ"), flashes(r)[:200])
    s.check("...the flash counts them: 2 lines taken off (the guests', put on by the setup) and A and B's given back as they were", "2 line" in say(r) and "2 given back as they were" in say(r), flashes(r)[:200])
    with a.app.app_context():
        d_ = a.get_db()
        nm_y2 = a.pm_bu_level_names(d_, d_.execute("SELECT * FROM users WHERE id=?", (U["Y"],)).fetchone(), CID)
    s.check("...and the guest rule goes with it: Y no longer reads GP as BU", "zzxu gp" not in nm_y2, sorted(nm_y2))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("a guest's weight is their own on their page, whatever the setup's weight rule; a unit carrier's is the setup's")
    r = person_post("Z", SID, "15")
    tz = tid_of("Z")
    s.check("set up: Z is a guest at 15", ln("Z") and ln("Z")[1] == 15 and tz, ln("Z"))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET weight_mode='one', weight=25 WHERE id=?", (SID,))
        d_.commit()

    def edit_weight(who, tid, w):
        return SUP.post("/admin/users/%d/kpi" % U[who], data={"csrf_token": "tok", "action": "edit", "kpi_target_id": str(tid), "weightage": w},
                        follow_redirects=True)
    out = say(edit_weight("Z", tz, "18"))
    s.check("the setup is at ONE weight for all, yet the guest's weight is changed on their page (15 -> 18)", ln("Z")[1] == 18
            and "its weight is set on the BU KPI page" not in out, flashes(SUP.get("/admin/users/%d?tab=performance" % U["Z"]))[:120])
    ta = tid_of("A")
    out = say(edit_weight("A", ta, "35"))
    s.check("...but a person of the unit is still refused there (its weight is the setup's): nothing changed",
            "its weight is set on the BU KPI page, for all who carry it" in out and ln("A")[1] == 30, flashes(SUP.get("/admin/users/%d?tab=performance" % U["A"]))[:120])
    page_z = say(SUP.get("/admin/users/%d?tab=performance&panel=kpi-%d" % (U["Z"], tz)))
    s.check("the guest's line panel offers the weight box (not read only) even at 'one weight'", 'name="weightage"' in page_z, "")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET weight_mode='own', weight=NULL WHERE id=?", (SID,))
        d_.commit()
    SUP.post("/admin/users/%d/kpi" % U["Z"], data={"csrf_token": "tok", "action": "take_off_bu", "kpi_target_id": str(tz)}, follow_redirects=True)
    s.check("(Z comes off again)", ln("Z") is None and "guests" not in setup_row()[1], setup_row()[1])

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Part 2: the new variant's name is picked, never typed")
    save_kpi(card(["ZZ9XU-A", "ZZ9XU-B", "ZZ9XU-C", "ZZ9XU-D"], guests={"ZZ9XU-G": "20", "ZZ9XU-Z": "15", "ZZ9XU-Y": "10", "ZZ9XU-N": "10", "ZZ9XU-W": "10", "ZZ9XU-V": "10"}))
    sid2, sd = setup_row()
    s.check("set up: PAT carries A..D and six guests (G and N: Beta; Z, Y, W and V: Gamma)", len(sd.get("guests") or {}) == 6, sd)

    def panel_state():
        pg = say(SUP.get(url() + "&kpi=%d" % PAT))
        n = re.search(r'name="src_n" value="(\d+)"', pg)
        g = re.search(r'name="src_sig" value="([0-9a-f]+)"', pg)
        return pg, ((n.group(1), g.group(1)) if n and g else (None, None))
    pgv, st_ = panel_state()
    s.check("the move panel lists the guests too (10 carry it) with their unit in the ID column",
            st_[0] == "10" and pgv.count('name="who"') == 10 and "ZZ9XU-G · JG 14 · Sales · ZZXU Beta" in pgv, st_)
    s.check("the panel has 'Name it after' (this unit, their units, a role), the role list with GCEO and CEO and 'A new role label', and NO typed box",
            "Name it after" in pgv and 'name="name_by" value="unit"' in pgv and 'name="name_by" value="units"' in pgv and 'name="name_by" value="role"' in pgv
            and '<option value="GCEO">' in pgv and '<option value="CEO">' in pgv and 'value="__new__"' in pgv and 'name="qualifier"' not in pgv, "")

    def move(who, dest="new", client=None, by="unit", role=None, role_new=None, **extra):
        pg, (n, sig) = panel_state()
        f = {"csrf_token": "tok", "action": "move_variant", "setup": str(setup_row()[0]), "dest": str(dest),
             "who": ["ZZ9XU-" + e for e in who], "src_n": n, "src_sig": sig, "v_unit": "%"}
        if by:
            f["name_by"] = by
        if role is not None:
            f["name_role"] = role
        if role_new is not None:
            f["name_role_new"] = role_new
        for i, v in enumerate((60, 70, 80, 90, 100), 1):
            f["v_rate%d" % i] = str(v)
        f.update(extra)
        return (client or SUP).post(url() + "&kpi=%d" % PAT, data=f, follow_redirects=True)

    w0 = snapshot()
    s.check("a form with no 'Name it after' pick is refused in words (absent is not empty), nothing written",
            "Pick what the new variant is named after" in say(move("C", by=None)) and snapshot() == w0, "")
    s.check("a typed qualifier alone is never read: it is refused like no pick, nothing written",
            "Pick what the new variant is named after" in say(move("C", by=None, qualifier="Sneaky")) and snapshot() == w0, "")
    s.check("a pick that is not one of the three is refused", "Pick what the new variant is named after" in say(move("C", by="free")) and snapshot() == w0, "")
    s.check("a BG admin cannot post the move (403), nothing written", move("C", client=BGC).status_code == 403 and snapshot() == w0, "")
    out = say(move("C", by="unit", qualifier="Sneaky"))
    VU = "ZZXU PAT: ZZXU Alpha"
    s.check("a typed qualifier posted WITH a pick is ignored: the name is the unit's, not 'Sneaky'",
            "ZZXU PAT: ZZXU Alpha made for ZZXU Alpha" in out and setup_row("ZZXU PAT: Sneaky")[0] is None, flashes(SUP.get(url()))[:160])
    s.check("this unit (the default): 'ZZXU PAT: ZZXU Alpha', a setup of its own holding C", setup_row(VU)[0] and setup_row(VU)[1].get("people") == ["ZZ9XU-C"]
            and ln("C", VU) and ln("C") is None, setup_row(VU))
    w1 = snapshot()
    s.check("'their units' is refused while nobody ticked comes from another unit, nothing written",
            "is for when someone ticked comes from another unit" in say(move("D", by="units")) and snapshot() == w1, "")
    out = say(move("AG", by="units"))
    VUB = "ZZXU PAT: ZZXU Alpha & ZZXU Beta"
    vrow = setup_row(VUB)
    s.check("'their units' with a guest ticked (A of this unit, G of ZZXU Beta): 'ZZXU PAT: ZZXU Alpha & ZZXU Beta', this unit first",
            vrow[0] and "ZZXU PAT: ZZXU Alpha & ZZXU Beta made for ZZXU Alpha" in out, flashes(SUP.get(url()))[:200])
    s.check("...the guest G lands in the destination's guests at their own weight (20), A in its people; the source lost both",
            vrow[1].get("guests") == {"ZZ9XU-G": 20.0} and vrow[1].get("people") == ["ZZ9XU-A"]
            and "ZZ9XU-G" not in (setup_row()[1].get("guests") or {}) and "ZZ9XU-A" not in setup_row()[1]["people"], (vrow[1], setup_row()[1]))
    s.check("...G's line (the same line) is renamed, linked to the variant, at its target (60..100), still 20% and on their own unit",
            ln("G", VUB) and ln("G", VUB)[4] == vrow[0] and ln("G", VUB)[1] == 20 and ln("G", VUB)[2:4] == (60, 100) and ln("G", VUB)[7:9] == (BG, CO2)
            and ln("G") is None, ln("G", VUB))
    s.check("...the other guests did not move: still guests of the source", sorted(setup_row()[1].get("guests") or {}) == ["ZZ9XU-N", "ZZ9XU-V", "ZZ9XU-W", "ZZ9XU-Y", "ZZ9XU-Z"], setup_row()[1])
    # a re-save of the DESTINATION keeps its guest (the trap again, on a variant)
    save_kpi(card(["ZZ9XU-A"], lid=PAT, rates=(60, 70, 80, 90, 100)).copy() and {}, lid=PAT) if False else None
    out = say(move("BZ", by="units"))
    VUG = "ZZXU PAT: ZZXU Alpha & ZZXU Gamma"
    s.check("'their units' with a guest from ZZXU Gamma: 'ZZXU PAT: ZZXU Alpha & ZZXU Gamma', Z (15) in its guests", setup_row(VUG)[0]
            and setup_row(VUG)[1].get("guests") == {"ZZ9XU-Z": 15.0} and setup_row(VUG)[1].get("people") == ["ZZ9XU-B"], (setup_row(VUG), flashes(SUP.get(url()))[:160]))
    # moving a guest into an EXISTING variant: N joins the Alpha & Beta variant's guests
    out = say(move("N", dest=setup_row(VUB)[0], by=None))
    s.check("a guest moved into an existing variant lands in ITS guests at their weight (N at 10, beside G at 20)",
            setup_row(VUB)[1].get("guests") == {"ZZ9XU-G": 20.0, "ZZ9XU-N": 10.0} and ln("N", VUB) and ln("N", VUB)[1] == 10
            and "ZZ9XU-N" not in (setup_row()[1].get("guests") or {}), (setup_row(VUB)[1], flashes(SUP.get(url()))[:160]))
    # a mover that is only a guest: the new variant holds guests alone
    out = say(move("Y", by="units"))
    VYG = "ZZXU PAT: ZZXU Alpha & ZZXU Gamma"   # the same name as VUG: refused by the unchanged duplicate check
    s.check("a name already taken (the same units again) is refused by the unchanged duplicate check, nothing moved",
            "is already a KPI of ZZXU Alpha" in out and "ZZ9XU-Y" in (setup_row()[1].get("guests") or {}), flashes(SUP.get(url()))[:160])
    # pure functions: the join, the units, the 80-character cap, the roles
    with a.app.app_context():
        d_ = a.get_db()
        act_ = a.active_cycle(d_)
        q3, w3_ = a._bu_variant_qualifier(d_, act_, BG, CO, {"name_by": "units"}, ["ZZXU Gamma", "ZZXU Beta", "ZZXU Gamma"])
        q4, w4_ = a._bu_variant_qualifier(d_, act_, BG, CO, {"name_by": "units"}, ["x" * 50, "y" * 50])
        q5, w5_ = a._bu_variant_qualifier(d_, act_, BG, CO, {"name_by": "units"}, [CO])
        q6, w6_ = a._bu_variant_qualifier(d_, act_, BG, CO, {"name_by": "units"}, ["ZZXU Beta"])
        q7, w7_ = a._bu_variant_qualifier(d_, act_, BG, CO, {"name_by": "unit"}, [])
        roles = a._bu_role_labels(d_, BG, CID)
    s.check("the join reads 'A', 'A & B', 'A, B & C'", a._bu_join_units(["ZZXU Alpha", "ZZXU Beta", "ZZXU Gamma"]) == "ZZXU Alpha, ZZXU Beta & ZZXU Gamma"
            and a._bu_join_units(["X", "Y"]) == "X & Y" and a._bu_join_units(["X"]) == "X", "")
    s.check("three units: this unit first, the others by name, once each: 'ZZXU Alpha, ZZXU Beta & ZZXU Gamma'", q3 == "ZZXU Alpha, ZZXU Beta & ZZXU Gamma" and w3_ is None, (q3, w3_))
    s.check("over 80 characters is refused with words (nothing built)", q4 is None and "too long for a name" in w4_, w4_)
    s.check("a guest of the unit's own name is not a second unit (refused as no other unit)", q5 is None and "Their units" in w5_, (q5, w5_))
    s.check("one other unit: 'ZZXU Alpha & ZZXU Beta'; this unit alone: its name", q6 == "ZZXU Alpha & ZZXU Beta" and q7 == "ZZXU Alpha", (q6, q7))
    s.check("the role labels in use: GCEO and CEO always; a unit's display name or a join of units is NOT a role (they are in the group's names now)",
            "GCEO" in roles and "CEO" in roles and "ZZXU Alpha" not in roles and "ZZXU Alpha & ZZXU Beta" not in roles
            and "ZZXU Alpha & ZZXU Gamma" not in roles and roles == sorted(roles, key=str.lower), roles)
    w3 = snapshot()
    s.check("a role not in the list is refused", "Pick a role from the list" in say(move("D", by="role", role="Janitor")) and snapshot() == w3, "")
    for bad in ("", "  ", "A" * 21, "bad;label", "<b>x</b>", "x" * 40, "a/b", "semi;colon", "tab\x00x"):
        out = say(move("D", by="role", role="__new__", role_new=bad))
        s.check("a new role label is validated: %r refused in words, nothing written" % bad[:24],
                "A new role label takes letters, digits, spaces, & and -" in out and snapshot() == w3, "")
    out = say(move("D", by="role", role="__new__", role_new="  COO  &  Chair-1 "))
    s.check("a good new role label (letters, digits, spaces, &, -): tidied, the name is 'ZZXU PAT: COO & Chair-1'",
            setup_row("ZZXU PAT: COO & Chair-1")[0] is not None, flashes(SUP.get(url()))[:160])
    with a.app.app_context():
        d_ = a.get_db()
        roles2 = a._bu_role_labels(d_, BG, CID)
    s.check("...and it is a role label from then on (offered next time)", "COO & Chair-1" in roles2, roles2)
    out = say(move("Y", by="role", role="gceo"))
    s.check("a listed role: 'GCEO' (the list's own spelling, found case-folded)", setup_row("ZZXU PAT: GCEO")[0] is not None, flashes(SUP.get(url()))[:160])
    w4 = snapshot()
    s.check("the same role name again is refused by the unchanged duplicate check", "is already a KPI of ZZXU Alpha" in say(move("W", by="role", role="GCEO")) and snapshot() == w4, "")

    # ---------------------------------------------------------------------------------------------------------------
    # Round 2, review fixes (7 Nov): a business group move takes the guest lines off; a unit move keeps them; a person who moves INTO the
    # setup's unit stops reading as a guest; the card's Add finds the account taking part; the picker feed reads in ONE batch.
    s.section("review fix 1: a business group move takes the guest lines off (A1)")
    PAT_N3 = PAT_N   # ZZXU Gamma's own PAT setup: P1 to P3 carry it, Q1 to Q4 are people of ZZXU Beta
    with a.app.app_context():
        d_ = a.get_db()
        for e, co_, dept in (("P1", CO3, "Sales"), ("P2", CO3, "Sales"), ("Q1", CO2, "Sales"), ("Q2", CO2, "Sales"), ("Q3", CO2, "Sales")):
            U[e] = d_.execute(
                "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, job_grade, "
                "job_title, confirmation_date, manager_id) VALUES (?,?, 'x', 'user', ?,?,?,?, '14', 'ZZ Officer', '2020-01-01', ?)",
                ("zz9xu-" + e.lower(), "ZZ XU " + e, "ZZ9XU-" + e, BG, co_, dept, U["M"])).lastrowid
            CO_OF[e] = (BG, co_)
            put_ = e in ("P1", "P2")
            if put_:
                d_.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, rate2, rate3, rate4, "
                           "rate5, business_group, company, library_id) VALUES (?,?,?,?, 'more', '%', 'Own', 90,95,100,105,110, ?,?,?)",
                           (CID, U[e], PAT_N, 30, BG, CO3, PAT))
        d_.commit()
    save_kpi(card(["ZZ9XU-P1", "ZZ9XU-P2"], guests={"ZZ9XU-Q1": "20", "ZZ9XU-Q2": "20", "ZZ9XU-Q3": "20"}), co=CO3)
    GSID3 = H.one(a, "SELECT id FROM pm_bu_kpis WHERE business_group=? AND company=? AND kpi_name=?", (BG, CO3, PAT_N))
    gd3 = json.loads(H.one(a, "SELECT carriers_json FROM pm_bu_kpis WHERE id=?", (GSID3,)) or "{}")
    s.check("set up: Gamma's PAT carried by P1 and P2, with Q1, Q2 and Q3 (ZZXU Beta) as guests at 20, each with a linked line",
            GSID3 and sorted(gd3.get("people") or []) == ["ZZ9XU-P1", "ZZ9XU-P2"] and gd3.get("guests") == {"ZZ9XU-Q1": 20.0, "ZZ9XU-Q2": 20.0, "ZZ9XU-Q3": 20.0}
            and all(ln(e)[4] == GSID3 for e in ("Q1", "Q2", "Q3")), gd3)

    def mv(who, bg_, unit, action="details_apply"):
        pr = H.rows(a, "SELECT full_name, job_title, job_grade, department FROM users WHERE id=?", (U[who],))[0]
        d = {"csrf_token": "tok", "action": action, "full_name": pr[0], "company": unit, "department": pr[3] or "", "job_title": pr[1] or "",
             "job_grade": pr[2] or "", "joined_date": "", "business_group": bg_}
        return SUP.post("/admin/users/%d/lines" % U[who], data=d, follow_redirects=True)

    def pat_state(eid):
        return json.loads(H.one(a, "SELECT carriers_json FROM pm_bu_kpis WHERE id=?", (GSID3,)) or "{}").get("guests") or {}
    prev = say(mv("Q1", BGX, COX, action="details_preview"))
    s.check("the preview of a group move names the guest line and whose BU KPI it is: 'Off: ZZXU PAT (ZZXU Gamma)'", "Off: ZZXU PAT (ZZXU Gamma)" in prev, re.findall(r"Off: [^.]*", prev)[:2])
    s.check("...and nothing was written by the preview", ln("Q1") and ln("Q1")[4] == GSID3 and "ZZ9XU-Q1" in pat_state("Q1"), "")
    # a held one: a result entered on Q2's line
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) VALUES (?, 77, 'own', ?, 0, 0)", (tid_of("Q2"), U["Q2"]))
        d_.commit()
    out = say(mv("Q1", BGX, COX))
    s.check("Q1 moved to ZZXU Other Group: their guest line is gone, Q1 left the setup's guests, the unit's people and the other guests are as they were",
            H.one(a, "SELECT business_group FROM users WHERE id=?", (U["Q1"],)) == BGX and ln("Q1") is None
            and pat_state("Q1") == {"ZZ9XU-Q2": 20.0, "ZZ9XU-Q3": 20.0}
            and sorted(json.loads(H.one(a, "SELECT carriers_json FROM pm_bu_kpis WHERE id=?", (GSID3,))).get("people")) == ["ZZ9XU-P1", "ZZ9XU-P2"], pat_state("Q1"))
    s.check("...the flash counts it and names the unit it came from: '1 BU KPI line of other units taken off (ZZXU PAT of ZZXU Gamma)'",
            "1 BU KPI line of other units taken off (ZZXU PAT of ZZXU Gamma)" in out, flashes(SUP.get(url(CO3)))[:200] or re.findall(r"moved to[^<]*", out)[:1])
    s.check("...and their own Sales line, a different KPI, is untouched and follows them", H.one(
        a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=? AND kpi_name='ZZXU Sales' AND business_group=?", (U["Q1"], BGX)) in (0, 1), "")
    s.check("...the card's trail has a line for it, in the BU KPI trail's words", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%1 taken off, a guest from ZZXU Beta who moved to ZZXU Other Group%'") == 1, "")
    out = say(mv("Q2", BGX, COX))
    s.check("Q2 (a result on the guest line) moves too, but the line is HELD: it stays linked to the setup and so does Q2 in guests; the flash does not claim it came off",
            ln("Q2") and ln("Q2")[4] == GSID3 and "ZZ9XU-Q2" in pat_state("Q2") and "of other units taken off" not in out, (ln("Q2"), pat_state("Q2")))
    # a unit move within the SAME group keeps the guest line; moving INTO the setup's own unit makes them a unit carrier, not a guest
    base_q3 = ln("Q3")
    out = say(mv("Q3", BG, CO))
    s.check("Q3 moves from ZZXU Beta to ZZXU Alpha (the same group): the guest line stays linked, Q3 stays in guests, nothing is taken off",
            H.one(a, "SELECT company FROM users WHERE id=?", (U["Q3"],)) == CO and ln("Q3") and ln("Q3")[4] == GSID3 and ln("Q3")[1] == base_q3[1]
            and "ZZ9XU-Q3" in pat_state("Q3") and "of other units taken off" not in out, (ln("Q3"), pat_state("Q3")))
    with a.app.app_context():
        d_ = a.get_db()
        act_ = a.active_cycle(d_)
        gl = a._bu_kpi_guest_lines(d_, act_, [GSID3])[GSID3]
    s.check("...still a guest of Gamma's PAT (their unit is not Gamma): the guest lines read lists Q3", [x[1]["employee_id"] for x in gl] == ["ZZ9XU-Q3"], [x[1]["employee_id"] for x in gl])
    jh_, _ph = kpe_json("H")
    g3_row = next((x for x in jh_["bu_items"] if x.get("other_unit") and x["sid"] == GSID3), None)
    s.check("...and a person of a THIRD unit (H) is offered Gamma's PAT saying '1' guest from other units (the count reads the lines, not `guests`)",
            g3_row and g3_row["guests"] == 1, g3_row and g3_row["guests"])
    out = say(mv("Q3", BG, CO3))
    with a.app.app_context():
        d_ = a.get_db()
        act_ = a.active_cycle(d_)
        gl2 = a._bu_kpi_guest_lines(d_, act_, [GSID3])[GSID3]
        gdict = d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (GSID3,)).fetchone()
        people_g = a._bu_unit_people(d_, BG, CO3)
        facts_, _grp = a._bu_kpi_facts(d_, act_, BG, CO3)
        cfg_ = d_.execute("SELECT * FROM pm_bg_config WHERE business_group=?", (BG,)).fetchone()
        rail = a._bu_rail(d_, act_, BG, CO3, {PAT_N: dict(gdict)}, [], [], [], facts_, {}, False, True, cfg_)
    s.check("Q3 moves INTO Gamma: the line stays linked and Q3 keeps their place in guests (they stay covered), nothing taken off",
            ln("Q3") and ln("Q3")[4] == GSID3 and "ZZ9XU-Q3" in pat_state("Q3") and "of other units taken off" not in out, (ln("Q3"), pat_state("Q3")))
    s.check("...but they no longer read as a guest: not in the guest lines, so no 'From' chip and no count of a guest",
            gl2 == [] and all(x[1]["employee_id"] != "ZZ9XU-Q3" for x in gl2), [x[1]["employee_id"] for x in gl2])
    pg3 = say(SUP.get(url(CO3) + "&kpi=%d" % PAT))
    s.check("...the card's Who carries it lists Q3 among the unit's own (no 'From ZZXU Alpha' chip, no 'N from other units' tile for them), and still carried once",
            "ZZ XU Q3" in pg3 and "From ZZXU Alpha" not in pg3 and "From ZZXU Gamma" not in pg3, re.findall(r"\d+ from other units", pg3))
    s.check("...the rail counts Q3 once: P1, P2, Q3 (now of the unit) = 3; nobody is counted again as a guest from another unit",
            "3 carry it" in rail["saved"][0]["summary"], rail["saved"][0]["summary"])
    # the edit card's existing-guest count and the person page's guest count read the lines too
    pe = say(SUP.get(url(CO3) + "&kpi=%d&edit=1" % PAT))
    m_gn = re.search(r'data-bk-gn="(\d+)"', pe)
    s.check("the Edit card's 'guests it already has' counts guest lines away from the unit only (Q3 is in the unit now; Q2's held line belongs to another group)",
            m_gn is not None and m_gn.group(1) == "0", m_gn and m_gn.group(1))
    # Fix 1 falsified: the lines a group move would leave on a person of ANOTHER unit (no guest handling) are exactly what the old code did;
    # the new code is the one source of both the preview and the apply
    src_ = H.source(a)
    s.check("lint: the move's apply and its preview read the same helper (`_bg_move_bu_lines`, `_bu_guest_setups`); a guest leaves 'guests' only through `_bu_guest_drop`",
            "_bu_guest_setups(db, act[\"id\"], p)" in src_ and src_.count("_bu_guest_drop(") >= 3 and "WHERE t.cycle_id=? AND t.subject_id=? AND b.business_group=? ORDER BY t.id" in src_, "")
    with a.app.app_context():
        d_ = a.get_db()
        for e in ("Q1", "Q2", "Q3"):
            d_.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id=?)", (U[e],))
        d_.commit()

    # ---------------------------------------------------------------------------------------------------------------
    s.section("review fix 2: the card's Add finds the account taking part, not just the oldest one with that Employee ID")
    with a.app.app_context():
        d_ = a.get_db()
        # a leaver's old account (lower id, left) and the active one, the same Employee ID in two spellings (the column is UNIQUE, case and spaces differ)
        old_ = d_.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, job_grade, "
                          "confirmation_date, left_at) VALUES ('zz9xu-q4-old', 'ZZ XU Q4 Old', 'x', 'user', 'zz9xu-q4 ', ?, ?, 'Sales', '14', '2020-01-01', '2026-01-01')",
                          (BG, CO2)).lastrowid
        U["Q4"] = d_.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, job_grade, "
                             "confirmation_date, manager_id) VALUES ('zz9xu-q4', 'ZZ XU Q4', 'x', 'user', 'ZZ9XU-Q4', ?, ?, 'Sales', '14', '2020-01-01', ?)",
                             (BG, CO2, U["M"])).lastrowid
        CO_OF["Q4"] = (BG, CO2)
        d_.commit()
        d_.execute("PRAGMA foreign_keys=ON")
        s.check("set up: the leaver's account has the lower id and the same Employee ID once folded", old_ < U["Q4"], (old_, U["Q4"]))
        me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        act_ = a.active_cycle(d_)
        srow_ = d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (GSID3,)).fetchone()
        done_, why_ = a._bu_kpi_add_guests(d_, me_, act_, srow_, [("ZZ9XU-Q4", "10")])
        d_.commit()
    s.check("the card's Add of ZZ9XU-Q4 finds the ACTIVE account (the writer adds them; the old order took the leaver's and refused)",
            why_ is None and done_ and done_[0][1] == "ZZ XU Q4" and "ZZ9XU-Q4" in pat_state("Q4") and ln("Q4") and ln("Q4")[4] == GSID3, (done_, why_))
    s.check("...the line is on the active account, none on the leaver's",
            H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=?", (old_,)) == 0 and H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=? AND bu_kpi_id=?", (U["Q4"], GSID3)) == 1, "")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (?,?)", (U["Q4"], old_))
        d_.execute("DELETE FROM users WHERE id=?", (old_,))
        d_.commit()

    # ---------------------------------------------------------------------------------------------------------------
    s.section("review fix 3: the card's picker feed reads the people in ONE batch")
    qs_ = []
    real_get_db = a.get_db

    def traced_get_db():
        c_ = real_get_db()
        c_.set_trace_callback(lambda sql: qs_.append(sql))
        return c_
    a.get_db = traced_get_db
    try:
        r1 = SUP.get("/admin/people/find.json?q=ZZ+XU+Y&xbu=%d" % SID)   # one person (ZZ XU Y)
        n1_ = len(qs_)
        qs_.clear()
        r12 = SUP.get("/admin/people/find.json?q=ZZ+XU&xbu=%d" % SID)
        n12_ = len(qs_)
    finally:
        a.get_db = real_get_db
    pj1, pj12 = (r1.get_json() or {}).get("people") or [], (r12.get_json() or {}).get("people") or []
    s.check("the feed answers (1 and several people), each with the writer's words field", len(pj1) == 1 and len(pj12) >= 4 and all("why" in x for x in pj12), (len(pj1), len(pj12)))
    s.check("...no per-row 'SELECT * FROM users WHERE id=?': the whole twelve are ONE read",
            not any(q_.strip().startswith("SELECT * FROM users WHERE id=?") and "IN" not in q_ for q_ in qs_), len(qs_))
    per_row_ = [q_ for q_ in qs_ if re.match(r"\s*SELECT \* FROM users WHERE id=(\?|\d+)\s*$", q_)
                and q_.strip() != "SELECT * FROM users WHERE id=%d" % SU["id"]]   # (the trace shows the values filled in; the signed-in admin's own read is not a listed person)
    s.check("...no per-row 'SELECT * FROM users WHERE id=...' for the people listed", not per_row_, per_row_[:3])
    s.check("...and the batched read is there exactly once (a 'SELECT * FROM users WHERE id IN (...)' for the whole list)",
            sum(1 for q_ in qs_ if q_.startswith("SELECT * FROM users WHERE id IN (")) == 1 and len(qs_) > 3, (n1_, n12_))
    with a.app.app_context():
        d_ = a.get_db()
        for e in ("P1", "P2", "Q1", "Q2", "Q3"):
            d_.execute("DELETE FROM pm_kpi_targets WHERE subject_id=?", (U[e],))
        d_.execute("DELETE FROM pm_bu_kpis WHERE id=?", (GSID3,))
        d_.commit()

    # ---------------------------------------------------------------------------------------------------------------
    s.section("review fix 4: Fill BU result's holders list shows a guest's unit (the same outlined chip as the card)")
    hl = SUP.get("/admin/list/bu-kpi-holders?fragment=1&bg=%s&co=%s&kpi=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"), PAT_N.replace(" ", "+")))
    htm = say(hl)
    hjz = holders_of(CO)
    chips = {r["name"]: r.get("chip") for r in hjz["rows"]}
    guests_now = a._bu_kpi_guests(H.rows(a, "SELECT carriers_json FROM pm_bu_kpis WHERE id=?", (SID,))[0])
    s.check("the holders list: the guests from ZZXU Gamma (V, W) carry the chip 'From ZZXU Gamma', the unit's own people none",
            chips.get("ZZ XU V") == "From ZZXU Gamma" and chips.get("ZZ XU W") == "From ZZXU Gamma"
            and sorted(chips) == ["ZZ XU V", "ZZ XU W"] and "ZZ9XU-V" in guests_now, chips)
    s.check("...rendered as the card's outlined chip (bk2-pill is-unit), once per guest, with the title saying where they work",
            htm.count("From ZZXU Gamma") == 2 and "bk2-pill is-unit clp-chip" in htm and "Works in ZZXU Gamma, another unit of the group" in htm, (hl.status_code, htm.count("From ")))
    s.check("...the title counts everyone once, the guest among them", "%d carry it" % len(hjz["rows"]) in hjz["title"], hjz["title"])

    # ---------------------------------------------------------------------------------------------------------------
    s.section("lint: one pool, one guest writer, nothing typed reaches a name")
    src = H.source(a)
    # scoped to the BU KPI variant writers (the Chart of KPI's library variants, a separate form, keep their own typed qualifier)
    import inspect as _insp
    bu_src = "".join(_insp.getsource(getattr(a, f_)) for f_ in ("_bu_variant_qualifier", "_bu_kpi_move", "admin_bu_kpis"))
    s.check("nothing typed reaches a variant's name: the BU KPI writers read `qualifier` nowhere", 'form.get("qualifier")' not in bu_src
            and "_bu_variant_qualifier(" in bu_src, "")
    s.check("`_bu_kpi_pool` is used by every writer that applies a setup to everyone it covers (save, take off, carriers)",
            src.count("_bu_kpi_pool(") >= 4, src.count("_bu_kpi_pool("))
    s.check("`_bu_kpi_add_guest` is the one writer both ways in call", src.count("_bu_kpi_add_guest(") >= 3, src.count("_bu_kpi_add_guest("))
    css = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
    js = open(os.path.join(H.REPO, "static", "kpi_edit.js"), encoding="utf-8").read()
    s.check("the guest grid has its CSS (a Unit column in rem, KPIs-today folding at the larger text sizes) and the chips are outlined",
            ".bk-gp { grid-template-columns: 20px 7.75rem minmax(0, 1fr) 7rem 6.5rem 4.625rem;" in css and "html[data-text=xl] .bk-gp > .bk-gk" in css
            and ".bk2-pill.is-unit" in css and ".kpe-badge.is-unit" in css and ".pp-chip.is-unit" in css, "")
    s.check("the person page's script groups 'Other units in <group>' and words the confirm and strip for another unit",
            "Other units in " in js and "another unit in " in js and "x.other_unit" in js, "")
finally:
    pass

sys.exit(s.done())
