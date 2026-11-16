"""Take a person off a BU KPI from their page (Chris, 2026-11-07: "allow remove the person from the BU KPI list"; canvas boards C1, C2).

The super admin's alone, outside an Early Year, until the Department Review starts. `_bu_kpi_remove_one` does exactly what unticking the person
under Who carries it on BU KPI setup does (their Employee ID leaves carriers_json, `_bu_kpi_apply(only=)` puts them off: a line the setup put on
comes off, a line it took over goes back as it was); every refusal is `_bu_remove_refusal`'s and the panel shows the same words.

What this suite holds:
  * the panel: the red button and the words of board C1 (a line the setup put on / a line it took over), the reason and today's text and link
    when it cannot, a BG admin's block exactly as before
  * a taken-off added line is gone, a taken-over line is back as it was (values, no link), the setup lost only them, the others untouched,
    the unit's carry count drops, the trail and flash as the board says
  * the person page's take-off equals the BU page's untick, line for line; a later BU page save keeps them off
  * every guard falsified, each refused with nothing written: a role that is not the super admin (403), a result, a check-in, a moderation,
    the last carrier, the Department Review started, an Early Year, another person's line id, a line that is not a BU KPI, a setup that is
    not "those who carry it now", a line already taken off
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
s = H.Suite("A person taken off a BU KPI from their page (super admin, outside an Early Year)")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, CO2 = "ZZBR Group", "ZZBR Unit", "ZZBR Unit B"
U = {}
HERE = os.path.dirname(os.path.abspath(__file__))


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BR-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZBR%'")
    db.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM admin_roles WHERE name='ZZBR role'")
    db.commit()


def ln(eid, name):
    r = H.rows(a, "SELECT t.weightage, t.rate1, t.rate5, t.bu_kpi_id, t.bu_prev_json, t.library_id, t.unit FROM pm_kpi_targets t "
                  "JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND u.employee_id=? AND t.kpi_name=?",
               (CID, eid, name))
    return tuple(r[0]) if r else None


def snapshot():
    """Everything an add could write: every line of the group's people, every setup, the trail rows of this feature."""
    lines = H.rows(a, "SELECT u.employee_id, t.kpi_name, t.weightage, t.rate1, t.rate5, t.bu_kpi_id, t.updated_at FROM pm_kpi_targets t "
                      "JOIN users u ON u.id=t.subject_id WHERE u.employee_id LIKE 'ZZ9BR-%' ORDER BY 1, 2")
    setups = H.rows(a, "SELECT id, kpi_name, carriers, carriers_json, weight_mode, updated_at FROM pm_bu_kpis WHERE business_group=? "
                       "ORDER BY id", (BG,))
    trail = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZBR%'")
    return [tuple(x) for x in lines], [tuple(x) for x in setups], trail


def setup_row(name="ZZBR PAT"):
    r = H.rows(a, "SELECT id, carriers_json FROM pm_bu_kpis WHERE business_group=? AND kpi_name=?", (BG, name))
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
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?)", (BG, CO, BG, CO2))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    LIB = {}
    for nm, bu, cat in (("ZZBR PAT", 1, "Financial · Profit"), ("ZZBR Solo", 1, "Financial · Solo"),
                        ("ZZBR Sales", 0, "Customer · Sales"), ("ZZBR Training", 0, "People · Learning")):
        LIB[nm] = db.execute(
            "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
            "unit, method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, "
            "?, '%', 'more', 90, 95, 100, 105, 110, 20, ?)", (BG, nm, cat, bu)).lastrowid
    U["M"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                        "company, department, job_grade, confirmation_date) VALUES ('zz9bp-m', 'ZZ BR Manager', 'x', "
                        "'user', 'ZZ9BR-M', ?, ?, 'Management', '21', '2020-01-01')", (BG, CO)).lastrowid
    for eid, co, dept in (("ZZ9BR-A", CO, "Sales"), ("ZZ9BR-B", CO, "Sales"), ("ZZ9BR-C", CO, "Finance"),
                          ("ZZ9BR-D", CO, "Finance"), ("ZZ9BR-E", CO, "Sales"), ("ZZ9BR-F", CO2, "Sales"),
                          ("ZZ9BR-G", CO, "Sales"), ("ZZ9BR-S", CO, "Sales")):
        U[eid[-1]] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', 'user', ?,?,?,?, '14', '2020-01-01', ?)",
            (eid.lower(), "ZZ BR " + eid[-1], eid, BG, co, dept, U["M"])).lastrowid

    def put(who, name, w, rates=(90, 95, 100, 105, 110)):
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, "
                   "rate2, rate3, rate4, rate5, business_group, company, library_id) VALUES (?,?,?,?, 'more', '%', 'Own',"
                   " ?,?,?,?,?, ?,?,?)", (CID, U[who], name, w) + tuple(rates) + (
                       BG, CO2 if who == "F" else CO, LIB[name]))
    put("A", "ZZBR PAT", 30)
    put("B", "ZZBR PAT", 20)
    put("C", "ZZBR Sales", 40)       # C: 2 KPIs adding up to 70%
    put("C", "ZZBR Training", 30)
    put("E", "ZZBR Sales", 60)       # E: 2 KPIs adding up to 100%
    put("E", "ZZBR Training", 40)
    put("F", "ZZBR Sales", 25)       # the other unit's
    put("G", "ZZBR Sales", 50)       # G: 1 KPI, 50%
    put("S", "ZZBR Solo", 20, rates=(1, 2, 3, 4, 5))   # S: the only carrier of Solo
    db.execute("DELETE FROM admin_roles WHERE name='ZZBR role'")
    ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZBR role', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)",   # everything a role can hold for this page, but not super
                   [(ROLE, "pm.read"), (ROLE, "pm.bu_kpi"), (ROLE, "pm.kpi_add"), (ROLE, "people.read")])
    BGADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                       "admin_bg, admin_role_id) VALUES ('zz9bp-adm', 'ZZ BR Admin', 'x', 'admin', 'ZZ9BR-ADM', ?, ?, ?)",
                       (BG, BG, ROLE)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
# what the AI pre-run was asked to work out ahead (2026-11-08): every _prerun_on_event call, the real one still running
SEEN = []
_REAL_PRERUN = a._prerun_on_event
a._prerun_on_event = lambda db_, cid_, ids_, ev_: (SEEN.append((ev_, tuple(sorted(ids_)))), _REAL_PRERUN(db_, cid_, ids_, ev_))[1]
BGC = H.client_as(a, BGADM)
PAT, SOLO = LIB["ZZBR PAT"], LIB["ZZBR Solo"]
URL = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
URL2 = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG.replace(" ", "+"), CO2.replace(" ", "+"))


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


def item(js, name="ZZBR PAT"):
    return next((x for x in (js.get("bu_items") or []) if x["name"] == name), None)




def tid_of(eid, name):
    r = H.rows(a, "SELECT t.id FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND u.employee_id=? AND t.kpi_name=?",
               (CID, eid, name))
    return r[0][0] if r else None


def full_line(eid, name):
    r = H.rows(a, "SELECT t.weightage, t.method, t.unit, t.category, t.rate1, t.rate2, t.rate3, t.rate4, t.rate5, t.bu_kpi_id, t.bu_prev_json, "
                  "t.library_id FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND u.employee_id=? AND t.kpi_name=?",
               (CID, eid, name))
    return tuple(r[0]) if r else None


def take_off(who, tid, client=None, follow=True, action="take_off_bu"):
    return (client or SUP).post("/admin/users/%d/kpi" % U[who], data={"csrf_token": "tok", "action": action, "kpi_target_id": str(tid)},
                                follow_redirects=follow)


def panel_html(who, tid, client=None):
    pg = say((client or SUP).get("/admin/users/%d?tab=performance" % U[who]))
    i = pg.find('id="kpe-bout-%d"' % tid)
    j = pg.find("Performance \u00b7 Edit KPI")
    k = "kpi-%d" % tid
    return pg


try:
    # ---------------------------------------------------------------------------------------------------------------
    s.section("set up: PAT saved for A and B, who held their own PAT line first (taken over); C and D added from their page; Solo for S alone")
    own_a, own_b = full_line("ZZ9BR-A", "ZZBR PAT"), full_line("ZZ9BR-B", "ZZBR PAT")
    save_kpi(card(holders=["ZZ9BR-A", "ZZ9BR-B"]))
    SID, sdata = setup_row()
    save_kpi(card(holders=["ZZ9BR-S"], rates=(1, 2, 3, 4, 5), lid=SOLO), lid=SOLO)
    SOLO_SID, _sd = setup_row("ZZBR Solo")
    for who, w in (("C", "30"), ("D", "50")):
        person_post(who, SID, w)
    sid_, sdata = setup_row()
    s.check("A and B are taken over (linked, unit's target, what they held kept to give back); C and D are added (linked, marked added)",
            full_line("ZZ9BR-A", "ZZBR PAT")[9] == SID and json.loads(full_line("ZZ9BR-A", "ZZBR PAT")[10]).get("rate1") == 90
            and json.loads(full_line("ZZ9BR-C", "ZZBR PAT")[10]) == {"added": 1} and full_line("ZZ9BR-D", "ZZBR PAT")[0] == 50
            and sorted(sdata["people"]) == ["ZZ9BR-A", "ZZ9BR-B", "ZZ9BR-C", "ZZ9BR-D"], sdata)
    TA, TB, TC, TD = [tid_of("ZZ9BR-" + x, "ZZBR PAT") for x in "ABCD"]
    TS = tid_of("ZZ9BR-S", "ZZBR Solo")

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the panel (board C1): the red button and its words, or the reason and today's text")
    pgc = panel_html("C", TC)
    s.check("an added line (C): the button and 'the line comes off their KPIs ... stays for the other 3. Asks again first.'",
            'id="kpe-bout-%d"' % TC in pgc and "Take off this BU KPI" in pgc and "Takes them off this BU KPI:" in pgc
            and "the line comes off their KPIs. ZZBR Unit's BU KPI stays for the other 3. Asks again first." in pgc, "")
    s.check("...the confirm (board C2): danger tone, 'Take off', the words with the cycle and the unit",
            'data-confirm-tone="danger" data-confirm-ok="Take off"' in pgc
            and "Take ZZ BR C off ZZBR PAT? Their line comes off their " in pgc and "BU KPI stays for the other 3. Their other weights are not re-balanced for you." in pgc, "")
    pga = panel_html("A", TA)
    s.check("a taken-over line (A): 'their own line goes back as it was before the BU KPI' in the panel and the confirm",
            "their own line goes back as it was before the BU KPI. ZZBR Unit's BU KPI stays for the other 3." in pga
            and "Their own line goes back as it was before the BU KPI; ZZBR Unit's BU KPI stays for the other 3." in pga, "")
    pgs = panel_html("S", TS)
    s.check("the only carrier (S): no button; the reason on top; today's text and link stay",
            'id="kpe-bout-%d"' % TS not in pgs and "They're the only one who carries it: take the KPI off on BU KPI setup." in pgs
            and "happens on the BU KPI page too: untick them under Who carries it." in pgs and "Take them off on the BU KPI page" in pgs, "")
    bgp = panel_html("C", TC, client=BGC)
    s.check("a BG admin sees exactly today's block: no button, no reason line",
            'id="kpe-bout-' not in bgp and "Take off this BU KPI" not in bgp, "")
    # a line with a result: the reason shows instead of the button
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) VALUES (?, 97, 'x', ?, 0, 0)", (TB, U["B"]))
        d_.commit()
    pgb = panel_html("B", TB)
    s.check("a line with a result (B): 'Their line has a result, a check-in or a moderation, so it stays.' and no button",
            "Their line has a result, a check-in or a moderation, so it stays." in pgb and 'id="kpe-bout-%d"' % TB not in pgb, "")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (TB,))
        d_.commit()

    # ---------------------------------------------------------------------------------------------------------------
    s.section("every guard refuses, and nothing is written")
    base = snapshot()

    def refused(label, resp, expect):
        out = say(resp)
        s.check(label, snapshot() == base and expect in out and "Nothing was taken off" in out, (expect, snapshot() == base, out[-200:]))
    r = take_off("C", TC, client=BGC, follow=False)
    s.check("a role that holds the Add right but is not the super admin is refused (403), nothing written", r.status_code == 403 and snapshot() == base, r.status_code)
    r = take_off("C", TC, action="take_off_bu_x", follow=False)
    s.check("a made-up action is a 400", r.status_code == 400 and snapshot() == base, r.status_code)
    refused("another person's line id (A's line posted on C's page)", take_off("C", TA), "That line is not on a BU KPI of their unit.")
    refused("a line that is not a BU KPI (C's own Sales line)", take_off("C", tid_of("ZZ9BR-C", "ZZBR Sales")), "That line is not on a BU KPI of")
    refused("a line id that does not exist", take_off("C", 99999999), "That line is not on a BU KPI of")
    refused("the last carrier (S, Solo)", take_off("S", TS), "They're the only one who carries it: take the KPI off on BU KPI setup.")
    # acted-on lines: a result, a check-in, a moderation each
    for label, sql, args in (
            ("a result", "INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) VALUES (?, 97, 'x', ?, 0, 0)", (TC, U["C"])),
            ("a check-in", "INSERT INTO pm_checkins(kpi_target_id, answer, answered_by) VALUES (?, 'on_track', ?)", (TC, U["C"])),
            ("a moderation", "INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) VALUES (?,1,'confirm',97,?)", (TC, U["M"]))):
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute(sql, args)
            d_.commit()
        base = snapshot()
        refused("a line with %s stays" % label, take_off("C", TC), "Their line has a result, a check-in or a moderation, so it stays.")
        with a.app.app_context():
            d_ = a.get_db()
            for t_ in ("pm_kpi_results", "pm_checkins", "pm_kpi_approvals"):
                d_.execute("DELETE FROM %s WHERE kpi_target_id=?" % t_, (TC,))
            d_.commit()
        base = snapshot()
    kind("early_year", 0)
    refused("in an Early Year it is refused", take_off("C", TC), "This is an Early Year")
    kind("year_end", 2)
    hod_window(False)
    refused("once the Department Review has started it is refused with the date words", take_off("C", TC), "so BU KPIs read only.")
    hod_window(True)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET carriers='departments' WHERE id=?", (SID,))
        d_.commit()
    base = snapshot()
    refused("a setup that goes on by department is refused", take_off("C", TC), "so taking someone off is set on BU KPI setup")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET carriers='holders' WHERE id=?", (SID,))
        d_.commit()
    base = snapshot()
    pgc = panel_html("C", TC)
    s.check("falsified: with every guard cleared the panel offers the button again and the same post is NOT refused (next section)",
            'id="kpe-bout-%d"' % TC in pgc, "")

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the super admin takes C off (a line the BU KPI put on): the line is gone, only C leaves the setup")
    before = snapshot()
    with a.app.app_context():   # C has a rating record already (a sign-off, or a Capture): the take-off must rebuild it
        a._rating_record_refresh(a.get_db(), CID, [U["C"]], "seed_zz", SU["id"], commit=True)
    del SEEN[:]
    out = say(take_off("C", TC))
    s.check("the take-off asks the AI pre-run once to work C's insights out ahead (kpi_edit)",
            SEEN == [("kpi_edit", (U["C"],))], SEEN)
    _rc = H.rows(a, "SELECT last_event, last_event_by FROM rating_records WHERE cycle_id=? AND subject_id=?", (CID, U["C"]))
    s.check("...and C's rating record was rebuilt by it (event kpi_edit, the admin's id)",
            _rc and tuple(_rc[0]) == ("kpi_edit", SU["id"]), _rc)
    with a.app.app_context():
        a.get_db().execute("DELETE FROM rating_records WHERE cycle_id=? AND subject_id=?", (CID, U["C"]))
        a.get_db().commit()
    sid_, sdata = setup_row()
    s.check("C has no PAT line; their own Sales and Training lines are untouched", tid_of("ZZ9BR-C", "ZZBR PAT") is None
            and ln("ZZ9BR-C", "ZZBR Sales")[0] == 40 and H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=?", (U["C"],)) == 2, "")
    s.check("the setup lost only C: A, B and D stay, no added_w", sorted(sdata["people"]) == ["ZZ9BR-A", "ZZ9BR-B", "ZZ9BR-D"] and "added_w" not in sdata, sdata)
    s.check("A, B and D's lines are exactly as they were",
            all(x in snapshot()[0] for x in before[0] if x[0] != "ZZ9BR-C"), "")
    s.check("the flash: '<name> taken off <KPI>: the line came off.'", "ZZ BR C taken off ZZBR PAT: the line came off." in out, "")
    with a.app.app_context():
        db = a.get_db()
        fx, _g = a._bu_kpi_facts(db, a.active_cycle(db), BG, CO)
    s.check("BU KPI setup counts them at once: 3 carry it", fx["zzbr pat"]["n"] == 3 and "ZZ9BR-C" not in fx["zzbr pat"]["eids"], fx["zzbr pat"]["n"])
    lg = H.rows(a, "SELECT detail, target_user_id FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%taken off from the person page%' ORDER BY id DESC LIMIT 1")
    s.check("the trail: '... 1 taken off from the person page (ZZ9BR-C)', on C's page log",
            lg and lg[0][0].endswith("\u00b7 1 taken off from the person page (ZZ9BR-C)") and "(0 added, 0 updated, 1 taken off)" in lg[0][0] and lg[0][1] == U["C"], lg)
    out = say(take_off("C", TC))
    s.check("a second take-off of the same line is refused (it is gone)", "Nothing was taken off" in out and sorted(setup_row()[1]["people"]) == ["ZZ9BR-A", "ZZ9BR-B", "ZZ9BR-D"], "")

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the super admin takes A off (a line the BU KPI took over): it goes back as it was")
    out = say(take_off("A", TA))
    la = full_line("ZZ9BR-A", "ZZBR PAT")
    s.check("A's line still exists, back to what they held: weight, rates, method, unit, category, library link; no BU link, nothing kept",
            la is not None and la[:12] == own_a[:12] and la[9] is None and la[10] is None, (la, own_a))
    s.check("the flash says their own line is back; the setup lost only A", "ZZ BR A taken off ZZBR PAT: their own line is back as it was." in out
            and sorted(setup_row()[1]["people"]) == ["ZZ9BR-B", "ZZ9BR-D"], setup_row()[1])
    lg = H.rows(a, "SELECT detail FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%taken off from the person page (ZZ9BR-A)%' LIMIT 1")
    s.check("...and the trail counts it as given back, not taken off", lg and "(0 added, 0 updated, 0 taken off, 1 given back as they were)" in lg[0][0], lg)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the same as unticking them on BU KPI setup, line for line; a BU page save keeps them off")
    # D (added) and B (taken over) are unticked on the BU page; compare with what the person page left for C and A
    save_kpi(card(holders=["ZZ9BR-B"]))
    s.check("D unticked on the BU page: gone, like C's take-off", tid_of("ZZ9BR-D", "ZZBR PAT") is None)
    save_kpi(card(holders=["ZZ9BR-B"]))
    s.check("a BU page save with the holders list keeps C (gone) and A (their own) off the setup",
            sorted(setup_row()[1]["people"]) == ["ZZ9BR-B"] and tid_of("ZZ9BR-C", "ZZBR PAT") is None
            and full_line("ZZ9BR-A", "ZZBR PAT")[9] is None and full_line("ZZ9BR-A", "ZZBR PAT")[:12] == own_a[:12], setup_row()[1])
    # B taken off through the BU page's own untick (the last carrier there is refused by the BU page, so add one back first)
    person_post("C", SID, "30")
    save_kpi(card(holders=["ZZ9BR-C"]))
    lb = full_line("ZZ9BR-B", "ZZBR PAT")
    s.check("B unticked on the BU page goes back as it was: the same state A's take-off left (values back, no link, nothing kept)",
            lb is not None and lb[:12] == own_b[:12] and lb[9] is None and lb[10] is None, (lb, own_b))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the shared words and the access map")
    with a.app.app_context():
        db = a.get_db()
        act = a.active_cycle(db)
        su_row = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        bg_row = db.execute("SELECT * FROM users WHERE id=?", (BGADM,)).fetchone()
        srow = db.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (SID,)).fetchone()
        pC = db.execute("SELECT * FROM users WHERE employee_id='ZZ9BR-C'").fetchone()
        tC = db.execute("SELECT * FROM pm_kpi_targets WHERE subject_id=? AND kpi_name='ZZBR PAT'", (pC["id"],)).fetchone()
        rr = a._bu_remove_refusal
        s.check("_bu_remove_refusal: a BG admin is refused first, then the cycle, then the line", rr(db, bg_row, act, srow, dict(tC), pC) == "Adding a BU KPI to someone is the super admin's."
                and rr(db, su_row, act, srow, None, pC) == "That line is not on a BU KPI of their unit.", "")
        s.check("...the only carrier of a one-person setup is refused with the shared words (C is the last carrier now)",
                rr(db, su_row, act, srow, dict(tC), pC) == "They're the only one who carries it: take the KPI off on BU KPI setup.", rr(db, su_row, act, srow, dict(tC), pC))
    amap = a.ADMIN_ACCESS_MAP["admin_person_kpi"]
    s.check("ADMIN_ACCESS_MAP: take_off_bu is the super admin's alone, beside add_bu; the rest keep their items",
            amap["map"]["take_off_bu"] == "super" and amap["map"]["add_bu"] == "super" and "add" in amap["map"], amap["map"])
finally:
    _put_back()
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
