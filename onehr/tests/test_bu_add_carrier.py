"""BU KPI setup: the super admin adds someone who doesn't carry the KPI yet, outside an Early Year (Chris, 2026-11-06: "allow
it, for super admin access, this is for super admin to do maintenance work and add in KPI for those who didn't have it yet";
canvas [design canvas link removed] board A1).

What this suite holds:
  * the Add block on the edit card: the super admin's alone, outside an Early Year alone, listing only the unit's people
    taking part who do not carry the KPI and whose KPIs add up to under 100%, each with what they hold today, the weight
    box saying how much room is left; the ones at 100% counted, not listed; the wording the board gives; one batched read
  * the save (the per-KPI save and the whole-unit save): the added person gets a new line at the unit's target and the weight
    given, linked to the setup; the others keep their weights; a re-save keeps it (their own weight); unticked, the line goes;
    the trail names who was added at what weight; the weight given is not left on the setup
  * every guard falsified: over 100, no weight / 0 / text, a person already at 100%, a person outside the unit, a current
    holder, a post from a BG admin, a post in an Early Year, a post that is not "those who carry it now" -- each refused, and
    nothing written
  * the person page's Add a KPI: the BU-level names the library list leaves out, and the BU KPI setup link for the super admin
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
s = H.Suite("BU KPI setup: the super admin adds new carriers outside an Early Year")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, CO2 = "ZZAC Group", "ZZAC Unit", "ZZAC Unit B"
U = {}


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9AC-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZAC%'")
    db.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM admin_roles WHERE name='ZZAC role'")
    db.commit()


def ln(eid, name):
    r = H.rows(a, "SELECT t.weightage, t.rate1, t.rate5, t.bu_kpi_id, t.bu_prev_json, t.library_id, t.unit FROM pm_kpi_targets t "
                  "JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND u.employee_id=? AND t.kpi_name=?",
               (CID, eid, name))
    return tuple(r[0]) if r else None


def n_lines(name="ZZAC PAT"):
    return H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND "
                    "u.employee_id LIKE 'ZZ9AC-%' AND t.kpi_name=?", (CID, name))


def setup_row():
    r = H.rows(a, "SELECT id, carriers_json FROM pm_bu_kpis WHERE business_group=? AND kpi_name='ZZAC PAT'", (BG,))
    return (r[0][0], json.loads(r[0][1] or "{}")) if r else (None, {})


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    PREV = dict(db.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
    W0 = db.execute("SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'",
                    (CID,)).fetchone()

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
    # a Year-End (not an Early Year) with the Department Review still to come: BU KPI setup is open
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', "
               "'2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?)", (BG, CO, BG, CO2))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    LIB = {}
    for nm, bu, cat in (("ZZAC PAT", 1, "Financial · Profitability"), ("ZZAC Sales", 0, "Customer · Sales"),
                        ("ZZAC Training", 0, "People · Learning")):
        LIB[nm] = db.execute(
            "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
            "unit, method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, "
            "?, '%', 'more', 90, 95, 100, 105, 110, 20, ?)", (BG, nm, cat, bu)).lastrowid
    U["M"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                        "company, department, job_grade, confirmation_date) VALUES ('zz9ac-m', 'ZZ AC Manager', 'x', "
                        "'user', 'ZZ9AC-M', ?, ?, 'Management', '21', '2020-01-01')", (BG, CO)).lastrowid
    for eid, co, dept in (("ZZ9AC-A", CO, "Sales"), ("ZZ9AC-B", CO, "Sales"), ("ZZ9AC-C", CO, "Finance"),
                          ("ZZ9AC-D", CO, "Finance"), ("ZZ9AC-E", CO, "Sales"), ("ZZ9AC-F", CO2, "Sales")):
        U[eid[-1]] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', 'user', ?,?,?,?, '14', '2020-01-01', ?)",
            (eid.lower(), "ZZ AC " + eid[-1], eid, BG, co, dept, U["M"])).lastrowid

    def put(who, name, w, rates=(90, 95, 100, 105, 110)):
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, "
                   "rate2, rate3, rate4, rate5, business_group, company, library_id) VALUES (?,?,?,?, 'more', '%', 'Own',"
                   " ?,?,?,?,?, ?,?,?)", (CID, U[who], name, w) + tuple(rates) + (
                       BG, CO2 if who == "F" else CO, LIB[name]))
    put("A", "ZZAC PAT", 30)
    put("B", "ZZAC PAT", 20)
    put("D", "ZZAC Sales", 40)       # D: 2 KPIs adding up to 70%
    put("D", "ZZAC Training", 30)
    put("E", "ZZAC Sales", 60)       # E: 2 KPIs adding up to 100%
    put("E", "ZZAC Training", 40)
    put("F", "ZZAC Sales", 25)       # the other unit's: never in this unit's list
    db.execute("DELETE FROM admin_roles WHERE name='ZZAC role'")
    ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZAC role', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)",   # BU KPI setup is theirs to use
                   [(ROLE, "pm.read"), (ROLE, "pm.bu_kpi")])
    BGADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                       "admin_bg, admin_role_id) VALUES ('zz9ac-adm', 'ZZ AC Admin', 'x', 'admin', 'ZZ9AC-ADM', ?, ?, ?)",
                       (BG, BG, ROLE)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
BGC = H.client_as(a, BGADM)
PAT = LIB["ZZAC PAT"]
URL = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
EDIT = URL + "&kpi=%d&edit=1" % PAT


def say(r):
    return html.unescape(r.get_data(as_text=True))


def card(holders=None, adds=None, carriers="holders", wmode="own", rates=(80, 90, 100, 110, 120)):
    """The PAT card as the page posts it. holders: the Employee IDs ticked (None = no list posted); adds: {eid: weight text}."""
    k = "k%d_" % PAT
    f = {k + "rate%d" % i: str(v) for i, v in enumerate(rates, 1)}
    f[k + "carriers"] = carriers
    f[k + "wmode"] = wmode
    f[k + "unit"] = "%"
    if holders is not None:
        f[k + "holder_set"] = "1"
        f[k + "holder"] = list(holders)
    if adds:
        f[k + "addp"] = list(adds)
        for e, w in adds.items():
            if w is not None:
                f[k + "addw_" + e] = w
    return f


def save_kpi(form, client=None):
    d = {"csrf_token": "tok", "action": "save_kpi", "kpi": str(PAT)}
    d.update(form)
    return (client or SUP).post(URL, data=d, follow_redirects=True)


def save_all(form, client=None):
    d = {"csrf_token": "tok", "action": "save", "kpi": [str(PAT)]}
    d.update(form)
    return (client or SUP).post(URL, data=d, follow_redirects=True)


try:
    # ---------------------------------------------------------------------------------------------------------------
    s.section("set up: PAT saved for A and B, who carry it; nobody else has a line")
    out = save_kpi(card(holders=["ZZ9AC-A", "ZZ9AC-B"]))
    sid, sdata = setup_row()
    s.check("PAT saved for the two who carry it, at the unit's target, each keeping their weight",
            ln("ZZ9AC-A", "ZZAC PAT")[:3] == (30, 80, 120) and ln("ZZ9AC-B", "ZZAC PAT")[:3] == (20, 80, 120)
            and sid and sorted(sdata.get("people") or []) == ["ZZ9AC-A", "ZZ9AC-B"], (sid, sdata))
    s.check("...C, D, E and the manager have no PAT line", all(ln("ZZ9AC-" + x, "ZZAC PAT") is None for x in "CDEM"))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the page: the Add block is the super admin's, outside an Early Year, on the edit card")
    pg = say(SUP.get(EDIT))
    s.check("the super admin's edit card has the block with its heading and the Super admin chip",
            'class="bk-add"' in pg and "Add someone who doesn't carry it yet" in pg
            and re.search(r'class="pp-chip bk-add-chip">Super admin<', pg), "no block")
    s.check("...and the board's words: who is listed, what the weight does",
            "People in ZZAC Unit taking part in" in pg and "whose KPIs don't add up to 100% yet. Give each a weight: it goes on "
            "their new line, and it can't take them over 100%." in pg)
    blk = pg.split("data-bk-add>")[1].split("data-bk-alive")[0] if "data-bk-add>" in pg else ""
    s.check("it lists C (0 KPIs, 0%), D (2 KPIs, 70%) and the manager; not A or B (they carry it), E (100%) or F (another unit)",
            "ZZ AC C</label>" in blk and "ZZ AC D</label>" in blk and "ZZ AC Manager</label>" in blk
            and "ZZ AC A</label>" not in blk and "ZZ AC B</label>" not in blk and "ZZ AC E</label>" not in blk
            and "ZZ AC F</label>" not in blk, re.findall(r"ZZ AC \w+</label>", blk))
    s.check("...each with what they hold today, the Employee ID and grade, and how much room is left",
            "0 KPIs · 0%" in blk and "2 KPIs · 70%" in blk and "ZZ9AC-D · JG 14 · Finance" in blk
            and 'placeholder="≤ 100"' in blk and 'placeholder="≤ 30"' in blk)
    s.check("...the weight boxes are off until the row is ticked, named k<id>_addw_<eid>; the tick is k<id>_addp",
            'name="k%d_addw_ZZ9AC-D"' % PAT in blk and 'name="k%d_addp" value="ZZ9AC-D"' % PAT in blk
            and re.search(r'name="k%d_addw_ZZ9AC-D"[^>]*disabled' % PAT, blk) is not None)
    s.check("...the ones at 100% are counted, not listed",
            "1 other in the unit already adds up to 100% and isn't listed." in blk, blk[-400:])
    s.check("the muted line under the pills, the Weight note and the what-saving-does note carry the new words",
            "Everyone, a department or a grade is for an Early Year, where KPIs are set. In " in pg
            and "you can add, below, someone whose KPIs don't add up to 100% yet." in pg
            and "Someone you add takes the weight you gave them above." in pg
            and "Someone added gets a new line at the unit's target and the weight you gave." in pg
            and "Putting it on someone new is for an Early Year" not in pg)
    s.check("the live line and the Save confirm are written by the page (hidden until someone is ticked)",
            'data-bk-alive hidden' in pg and "added: " in pg and "data-bk-arow" in pg)

    s.section("...and nobody else's: read view, a BG admin, an Early Year")
    s.check("the read view has no Add block", 'class="bk-add"' not in say(SUP.get(URL + "&kpi=%d" % PAT)))
    bp = say(BGC.get(EDIT))
    s.check("a BG admin's edit card is today's: no block, the old muted line", 'class="bk-add"' not in bp
            and "Putting it on someone new is for an Early Year" in bp and "Someone added gets a new line" not in bp)
    with a.app.app_context():
        a.get_db().execute("UPDATE cycles SET kind='early_year', half=0 WHERE id=?", (CID,))
        a.get_db().commit()
    ey = say(SUP.get(EDIT))
    s.check("in an Early Year the super admin's card has no block either", 'class="bk-add"' not in ey
            and "Someone added gets a new line" not in ey)
    out = say(save_kpi(card(holders=["ZZ9AC-A", "ZZ9AC-B"], adds={"ZZ9AC-C": "30"})))
    s.check("...and an add posted in an Early Year is refused, nothing written", ln("ZZ9AC-C", "ZZAC PAT") is None
            and "adding someone who doesn't carry it yet is the super admin's, outside an Early Year" in out
            and "Nothing was saved" in out, out[-300:])
    with a.app.app_context():
        a.get_db().execute("UPDATE cycles SET kind='year_end', half=2 WHERE id=?", (CID,))
        a.get_db().commit()

    # ---------------------------------------------------------------------------------------------------------------
    s.section("one batched read of what the people hold")
    with a.app.app_context():
        db = a.get_db()
        act = a.active_cycle(db)
        people = a._bu_unit_people(db, BG, CO)
        seen = []
        db.set_trace_callback(seen.append)
        pool = a._bu_kpi_add_pool(db, act, people, {"ZZ9AC-A", "ZZ9AC-B"})
        db.set_trace_callback(None)
    q = [x for x in seen if "pm_kpi_targets" in x]
    s.check("ONE query over pm_kpi_targets for the whole unit, grouped by person", len(q) == 1 and "GROUP BY subject_id" in q[0],
            q)
    byeid = {r["eid"]: r for r in pool["rows"]}
    s.check("...the pool: C 0 / 0, D 2 / 70 with 30 room, the manager 0 / 0; E left out (counted)",
            (byeid["ZZ9AC-C"]["n"], byeid["ZZ9AC-C"]["w"]) == (0, 0) and (byeid["ZZ9AC-D"]["n"], byeid["ZZ9AC-D"]["w"],
                                                                         byeid["ZZ9AC-D"]["room"]) == (2, 70, 30)
            and "ZZ9AC-E" not in byeid and "ZZ9AC-A" not in byeid and pool["full"] == 1, pool)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("every guard refuses, and nothing is written")
    base = (n_lines(), setup_row()[1].get("people"))

    def refused(label, form, expect, client=None, path=save_kpi):
        out = say(path(form, client))
        ok = (expect in out and "Nothing was saved" in out and n_lines() == base[0] == 2
              and setup_row()[1].get("people") == base[1] and all(ln("ZZ9AC-" + x, "ZZAC PAT") is None for x in "CDEM")
              and "added_w" not in setup_row()[1])
        s.check(label, ok, (expect, out[out.find("flash") - 5:][:260] if "flash" in out else out[-260:]))
    hold = ["ZZ9AC-A", "ZZ9AC-B"]
    refused("over 100: D holds 70, so 40 more is refused with the room left", card(hold, {"ZZ9AC-D": "40"}),
            "'ZZAC PAT': ZZ9AC-D holds 70%, so at most 30% more.")
    refused("no weight given is refused", card(hold, {"ZZ9AC-C": None}), "'ZZAC PAT': give ZZ9AC-C's weight.")
    refused("a weight of 0 is refused", card(hold, {"ZZ9AC-C": "0"}), "'ZZAC PAT': give ZZ9AC-C's weight.")
    refused("a weight of words is refused", card(hold, {"ZZ9AC-C": "lots"}), "'ZZAC PAT': give ZZ9AC-C's weight.")
    refused("a negative weight is refused", card(hold, {"ZZ9AC-C": "-5"}), "'ZZAC PAT': give ZZ9AC-C's weight.")
    refused("someone already at 100% is refused", card(hold, {"ZZ9AC-E": "10"}),
            "'ZZAC PAT': ZZ9AC-E already adds up to 100%.")
    refused("someone from another unit is refused", card(hold, {"ZZ9AC-F": "10"}),
            "'ZZAC PAT': ZZ9AC-F isn't one of the people taking part in this unit.")
    refused("someone who is not on the system at all is refused", card(hold, {"ZZ9AC-NOPE": "10"}),
            "'ZZAC PAT': ZZ9AC-NOPE isn't one of the people taking part in this unit.")
    refused("a current holder posted as an add is refused", card(hold, {"ZZ9AC-A": "10"}),
            "'ZZAC PAT': ZZ9AC-A carries it already.")
    refused("one good add beside a bad one refuses both (all or nothing)", card(hold, {"ZZ9AC-C": "30", "ZZ9AC-E": "10"}),
            "ZZ9AC-E already adds up to 100%.")
    refused("an add posted with 'Everyone' is refused (the add goes only with those who carry it now)",
            card(hold, {"ZZ9AC-C": "30"}, carriers="everyone"), "outside an Early Year a BU KPI goes only on those who carry it now")
    refused("the whole-unit save refuses the same way", card(hold, {"ZZ9AC-D": "40"}),
            "'ZZAC PAT': ZZ9AC-D holds 70%, so at most 30% more.", path=save_all)
    # a BG admin: even a perfectly good add is refused, server-side, and nothing is written
    refused("a BG admin's post with a good add is refused", card(hold, {"ZZ9AC-C": "30"}),
            "adding someone who doesn't carry it yet is the super admin's", client=BGC)
    refused("...on the whole-unit save too", card(hold, {"ZZ9AC-C": "30"}),
            "adding someone who doesn't carry it yet is the super admin's", client=BGC, path=save_all)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the super admin adds C, who has no KPIs, at 30")
    out = say(save_kpi(card(hold, {"ZZ9AC-C": "30"})))
    c = ln("ZZ9AC-C", "ZZAC PAT")
    sid, sdata = setup_row()
    s.check("C has a PAT line at 30, linked to the setup, at the unit's target and unit", c and c[0] == 30 and c[3] == sid
            and c[1:3] == (80, 120) and c[6] == "%", c)
    s.check("...it carries the library link and was marked as added by the setup (so unticking removes it)", c[5] == PAT
            and json.loads(c[4] or "{}").get("added") == 1, c)
    s.check("...A and B keep 30 and 20; nobody else got a line", ln("ZZ9AC-A", "ZZAC PAT")[0] == 30
            and ln("ZZ9AC-B", "ZZAC PAT")[0] == 20 and all(ln("ZZ9AC-" + x, "ZZAC PAT") is None for x in "DEM"))
    s.check("...the setup lists C among its carriers, and the weight given is not left on it",
            sorted(sdata.get("people") or []) == ["ZZ9AC-A", "ZZ9AC-B", "ZZ9AC-C"] and "added_w" not in sdata, sdata)
    s.check("...the page says one line was added", "1 line added" in out, out[:200])
    lg = H.rows(a, "SELECT detail FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZAC PAT%' ORDER BY id DESC LIMIT 1")
    s.check("...the trail names who was added at what weight", lg and "1 added who did not carry it (ZZ9AC-C at 30%)" in lg[0][0], lg[0][0] if lg else None)
    pg = say(SUP.get(EDIT))
    blk = pg.split("data-bk-add>")[1].split("data-bk-alive")[0]
    s.check("the page now: C is a holder (in the holders' list, ticked), no longer on the Add list",
            ">ZZ AC C</span>" in pg and "ZZ AC C</label>" not in blk and 'value="ZZ9AC-C" checked' in pg, "")

    s.section("a re-save keeps the weight (their own); unticked, the added line goes")
    save_kpi(card(holders=["ZZ9AC-A", "ZZ9AC-B", "ZZ9AC-C"]))
    s.check("saved again with C ticked: still 30, still linked", ln("ZZ9AC-C", "ZZAC PAT")[0] == 30
            and ln("ZZ9AC-C", "ZZAC PAT")[3] == sid)
    save_kpi(card(holders=["ZZ9AC-A", "ZZ9AC-B", "ZZ9AC-C"], rates=(70, 85, 100, 115, 130)))
    s.check("a new target reaches the added line, its weight stays 30", ln("ZZ9AC-C", "ZZAC PAT")[:3] == (30, 70, 130),
            ln("ZZ9AC-C", "ZZAC PAT"))
    out = say(save_kpi(card(holders=["ZZ9AC-A", "ZZ9AC-B"], rates=(70, 85, 100, 115, 130))))
    s.check("C unticked: their line is taken off (never given back as something it wasn't)", ln("ZZ9AC-C", "ZZAC PAT") is None
            and ln("ZZ9AC-A", "ZZAC PAT")[0] == 30 and "1 taken off" in out, out[:200])
    s.check("...C has no KPI line of any name again", H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=?",
                                                              (U["C"],)) == 0)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the whole-unit save adds too: D (70%) at the 30 that fills them; two at once")
    out = say(save_all(card(hold, {"ZZ9AC-D": "30", "ZZ9AC-C": "25.5"}, rates=(70, 85, 100, 115, 130))))
    d, c = ln("ZZ9AC-D", "ZZAC PAT"), ln("ZZ9AC-C", "ZZAC PAT")
    s.check("D at 30 (their KPIs now add up to exactly 100%) and C at 25.5, both linked", d and c and d[0] == 30 and c[0] == 25.5
            and d[3] == c[3] == sid, (d, c))
    s.check("...D's own two lines were not touched", ln("ZZ9AC-D", "ZZAC Sales")[0] == 40 and ln("ZZ9AC-D", "ZZAC Training")[0] == 30)
    lg = H.rows(a, "SELECT detail FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZAC PAT%' ORDER BY id DESC LIMIT 1")
    s.check("...the trail names both", lg and "2 added who did not carry it (ZZ9AC-C at 25.5%, ZZ9AC-D at 30%)" in lg[0][0],
            lg[0][0] if lg else None)
    pg = say(SUP.get(EDIT))
    blk = pg.split("data-bk-add>")[1].split("data-bk-alive")[0]
    s.check("D now carries it (a holder, ticked), so the Add list drops them; E is still the one left out at 100%",
            "ZZ AC D</label>" not in blk and 'value="ZZ9AC-D" checked' in pg
            and "1 other in the unit already adds up to 100% and isn't listed." in blk, blk[-300:])
    out = say(save_kpi(card(holders=["ZZ9AC-A", "ZZ9AC-B"], rates=(70, 85, 100, 115, 130))))
    s.check("both unticked: both added lines go, D's own lines stay", ln("ZZ9AC-D", "ZZAC PAT") is None
            and ln("ZZ9AC-C", "ZZAC PAT") is None and ln("ZZ9AC-D", "ZZAC Sales")[0] == 40 and n_lines() == 2, out[:200])
    s.check("A and B were never disturbed", ln("ZZ9AC-A", "ZZAC PAT")[:2] == (30, 70) and ln("ZZ9AC-B", "ZZAC PAT")[:2] == (20, 70))

    s.section("a weight is not read from a stale setup: the person page's Add a person step still sees no leftover")
    with a.app.app_context():
        db = a.get_db()
        row = db.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (sid,)).fetchone()
        # the same setup with a weight sitting in added_w, and no line: what the apply reads, and nothing else
        stale = dict(row)
        stale["carriers_json"] = json.dumps({"people": ["ZZ9AC-A"], "added_w": {"ZZ9AC-C": 12}})
        pc = db.execute("SELECT * FROM users WHERE employee_id='ZZ9AC-C'").fetchone()
        pa = db.execute("SELECT * FROM users WHERE employee_id='ZZ9AC-A'").fetchone()
        w_new = a._bu_kpi_weight(stale, pc)
        w_line = a._bu_kpi_weight(stale, pc, {"weightage": 44})
        w_none = a._bu_kpi_weight(stale, pa)
        w_saved = a._bu_kpi_weight(row, pc)
    s.check("_bu_kpi_weight(own): the line's weight when there is one; the added weight when there is not; else None",
            w_new == 12 and w_line == 44 and w_none is None and w_saved is None, (w_new, w_line, w_none, w_saved))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the person page: Add a KPI says where a BU KPI is put on")
    with a.app.test_request_context():
        db = a.get_db()
        cyc = a.active_cycle(db)
        pc = db.execute("SELECT * FROM users WHERE employee_id='ZZ9AC-C'").fetchone()
        libr = [dict(r) for r in db.execute("SELECT * FROM pm_kpi_library WHERE business_group=? AND active=1", (BG,))]
        k_sup = a._kpe_library(db, pc, cyc, libr, sup=True)
        k_oth = a._kpe_library(db, pc, cyc, libr)
    s.check("the library list leaves the BU-level KPI out and returns its name", [x["name"] for x in k_sup["items"]] ==
            ["ZZAC Sales", "ZZAC Training"] and k_sup["bu"] == ["ZZAC PAT"], k_sup)
    s.check("...the super admin gets the BU KPI setup address for the person's group and unit; others get none",
            k_sup["bu_url"].startswith("/admin/performance/bu-kpis?") and "fbg=ZZAC+Group" in k_sup["bu_url"]
            and "fbu=ZZAC+Unit" in k_sup["bu_url"] and k_oth["bu_url"] == "" and k_oth["bu"] == ["ZZAC PAT"], (k_sup, k_oth))
    pp = say(SUP.get("/admin/users/%d?tab=performance" % U["C"]))
    m = re.search(r'<script type="application/json" id="kpe-lib">(.*?)</script>', pp, re.S)
    lj = json.loads(m.group(1)) if m else {}
    s.check("the person page carries both in its library data", lj.get("bu") == ["ZZAC PAT"]
            and "/admin/performance/bu-kpis?" in (lj.get("bu_url") or ""), lj.get("bu"))
    js = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "kpi_edit.js")).read()
    s.check("the Add a KPI search shows the row under the 'No library KPI matches' line, with the link only for the super admin",
            "kpe-li-bu" in js and "is a BU KPI: its target is the unit's, so it's put on from BU KPI setup." in js
            and "put on by the super admin from BU KPI setup." in js and "Open BU KPI setup ›" in js
            and js.index("kpe-li-none") < js.index("kpe-li-bu") and 'target = "_blank"' in js)
finally:
    _put_back()
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
