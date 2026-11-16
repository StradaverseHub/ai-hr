"""Home's before-calibration card (Chris, 2026-10-29, canvas as drawn): the super admin's countdown to the BU CEOs'
performance calibration, and, per business group, which BU KPI results and which units' PAT are still missing.

What this suite holds:
  * super admin only: a BG admin gets no card and its markup is not on their Home
  * the states, set by Cycle > Calendar's 'pm_buceo' dates around now: no date, amber (more than PRECAL_DUE_DAYS out),
    red (that many or fewer), open, ready (everything in, before it opens), and none once it has closed, once it has
    opened with everything in, in an Early Year, or with Performance off
  * the counts follow the data: a PAT figure enters one unit; a BU KPI is filled only when EVERY line carrying it has a
    final admin-filled result (a partial fill, a draft and a non-admin result do not count); an old business-group PAT
    row (company '') is never read; a unit the cycle leaves out is not counted
Its own synthetic business group (ZZPC) on the shared suite database; every other unit is left out of the cycle for the
run so the counts are the suite's own, and everything is put back at the end.
"""
import html
import os
import sys
from datetime import timedelta
from urllib.parse import quote_plus

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Home's before-calibration card: who sees it, its states, and its counts")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG = "ZZPC Group"
CO_A, CO_B, CO_C, CO_X = "ZZPC Alpha", "ZZPC Beta", "ZZPC Gamma", "ZZPC Out"
CELL = "pm_buceo"
KP, KG, KR, KX = "ZZPC PAT", "ZZPC GP", "ZZPC Revenue", "ZZPC Hidden"
ADDED_OUT = []        # cycle_exclusions rows this run added (ids), put back at the end
ORIG = {}
CID = None


def W(sql, args=()):
    with a.app.app_context():
        db = a.get_db()
        cur = db.execute(sql, args)
        db.commit()
        return cur.lastrowid


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZPC-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id "
                   "IN (%s))" % ph, ids)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_pbt_achievement WHERE business_group=?", (BG,))
    db.execute("DELETE FROM cycle_exclusions WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def card(uid=None):
    with a.app.test_request_context("/admin"):
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (uid or SU["id"],)).fetchone())
        return a._precal_alert(db, u)


def mine(c):
    return next((r for r in (c or {}).get("rows", []) if r["bg"] == BG), None)


def window(opens=None, closes=None):
    """Set (or clear, with both None) the BU CEO performance calibration dates; MYT wall-clock text."""
    f = lambda d: d.strftime("%Y-%m-%d %H:%M") if d else None   # noqa: E731
    W("DELETE FROM cycle_windows WHERE cycle_id=? AND cell=?", (CID, CELL))
    if opens or closes:
        W("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
          (CID, CELL, f(opens), f(closes)))


def fill(t, admin=1, draft=0):
    W("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft, admin_filled) VALUES (?,100,?,?,?)",
      (t, SU["id"], draft, admin))


try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        CID = a.active_cycle_id(db)
        PER = a.active_pm_period(db)["id"]
        ORIG["half"] = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0]
        ORIG["pm"] = db.execute("SELECT active FROM cycle_modules WHERE cycle_id=? AND module_key='pm'", (CID,)).fetchone()
        ORIG["win"] = db.execute("SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell=?",
                                 (CID, CELL)).fetchone()
        db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
        if ORIG["pm"] is None:
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'pm', 1)", (CID,))
        else:
            db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key='pm'", (CID,))
        # every other unit is left out for the run, so the card counts the suite's units only
        have = {(r[0], r[1]) for r in db.execute("SELECT business_group, company FROM cycle_exclusions WHERE cycle_id=? "
                                                 "AND department=''", (CID,))}
        for bg, co in db.execute("SELECT DISTINCT business_group, company FROM users WHERE COALESCE(business_group,'')!='' "
                                 "AND COALESCE(company,'')!='' AND business_group!=?", (BG,)).fetchall():
            if (bg, co) not in have:
                ADDED_OUT.append(db.execute("INSERT INTO cycle_exclusions(cycle_id, business_group, company) "
                                            "VALUES (?,?,?)", (CID, bg, co)).lastrowid)
        for co in (CO_A, CO_B, CO_C, CO_X):
            db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, co))
        U = {}

        def person(eid, co, role="user", admin_bg=None):
            U[eid] = db.execute(
                "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                "department, job_grade, confirmation_date, admin_bg) VALUES (?,?, 'x', ?,?,?,?, 'ZZPC Dept', '18', "
                "'2020-01-01', ?)", (eid.lower(), "ZZ PC " + eid[-3:], role, eid, BG, co, admin_bg)).lastrowid
        person("ZZPC-A1", CO_A)
        person("ZZPC-A2", CO_A)
        person("ZZPC-B1", CO_B)
        person("ZZPC-C1", CO_C)
        person("ZZPC-X1", CO_X)
        person("ZZPC-ADM", CO_A, role="admin", admin_bg=BG)

        def bu(co, name):
            return db.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, kpi_name, method) "
                              "VALUES (?,?,?,?, 'more')", (PER, BG, co, name)).lastrowid

        def line(eid, co, name, bid):
            return db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                              "business_group, company, bu_kpi_id) VALUES (?,?,?,50,'more','approved',?,?,?)",
                              (PER, U[eid], name, BG, co, bid)).lastrowid
        b_p, b_g, b_r, b_x = bu(CO_A, KP), bu(CO_A, KG), bu(CO_B, KR), bu(CO_X, KX)
        T = {"p1": line("ZZPC-A1", CO_A, KP, b_p), "p2": line("ZZPC-A2", CO_A, KP, b_p),
             "g1": line("ZZPC-A1", CO_A, KG, b_g), "r1": line("ZZPC-B1", CO_B, KR, b_r),
             "x1": line("ZZPC-X1", CO_X, KX, b_x)}
        db.execute("INSERT INTO cycle_exclusions(cycle_id, business_group, company) VALUES (?,?,?)", (CID, BG, CO_X))
        db.commit()
    now = a._now_myt()
    with a.app.app_context():
        DA, DB, DC, DX = (a.display_company(BG, c) for c in (CO_A, CO_B, CO_C, CO_X))
        DBG = a.display_bg(BG)

    # -----------------------------------------------------------------------
    s.section("the suite's people take part, and the one left-out unit does not")
    with a.app.app_context():
        db = a.get_db()
        part = {r[0] for r in db.execute("SELECT employee_id FROM users u WHERE employee_id LIKE 'ZZPC-%' AND "
                                         + a.participant_sql("u"))}
    s.check("the in-cycle units' people take part (the set-up is sound)",
            {"ZZPC-A1", "ZZPC-A2", "ZZPC-B1", "ZZPC-C1"} <= part, sorted(part))
    s.check("the left-out unit's person does not", "ZZPC-X1" not in part, sorted(part))

    # -----------------------------------------------------------------------
    s.section("the counts follow the data")
    window(now + timedelta(days=30))
    c0 = card()
    r0 = mine(c0)
    s.check("a card for the suite's group", r0 is not None, c0)
    s.check("three units take part (Alpha, Beta, Gamma); the left-out one is not counted",
            r0 and r0["pat_n"] == 3, r0)
    s.check("...and its BU KPI is named nowhere, nor its PAT",
            r0 and DX not in (r0["bu_todo"] + r0["pat_todo"]) and KX not in r0["bu_todo"], r0)
    s.check("three BU KPIs are carried in the in-cycle units (the left-out unit's one is not counted)",
            r0 and r0["bu_n"] == 3 and r0["bu_done"] == 0, r0)
    s.check("nothing entered yet: every taking-part unit is still to enter",
            r0 and r0["pat_done"] == 0 and all(d in r0["pat_todo"] for d in (DA, DB, DC)), r0)
    s.check("a unit with no BU KPI is counted as such (Gamma carries none)", c0["no_bu"] == 1, c0["no_bu"])
    s.check("the sub-line names the unit and the KPI", "%s · %s" % (DA, KP) in r0["bu_todo"], r0["bu_todo"])
    s.check("the column heads add up the rows", c0["bu_head"] == "0 of 3 filled" and c0["pat_head"]
            == "0 of 3 units entered", (c0["bu_head"], c0["pat_head"]))

    fill(T["p1"])
    r = mine(card())
    s.check("one of a KPI's two lines filled is NOT filled (every line must be)", r["bu_done"] == 0
            and "%s · %s" % (DA, KP) in r["bu_todo"], r)
    fill(T["p2"])
    r = mine(card())
    s.check("both lines filled: that KPI is filled, one more done", r["bu_done"] == 1 and r["bu_n"] == 3, r)
    s.check("...and it leaves the 'To fill' line while the others stay",
            "%s · %s" % (DA, KP) not in r["bu_todo"] and "%s · %s" % (DA, KG) in r["bu_todo"]
            and "%s · %s" % (DB, KR) in r["bu_todo"], r["bu_todo"])
    fill(T["g1"], admin=1, draft=1)
    s.check("an admin-filled DRAFT does not count", mine(card())["bu_done"] == 1)
    fill(T["r1"], admin=0)
    s.check("a result the line's owner entered (not admin-filled) does not count", mine(card())["bu_done"] == 1)
    W("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (?,?)", (T["g1"], T["r1"]))
    fill(T["g1"])
    fill(T["r1"])
    r = mine(card())
    s.check("filling the rest leaves nothing to fill", r["bu_done"] == r["bu_n"] == 3 and r["bu_todo"] == "", r)

    W("INSERT INTO pm_pbt_achievement(cycle_id, business_group, company, achievement_pct) VALUES (?,?,?,95)",
      (PER, BG, CO_A))
    r = mine(card())
    s.check("a PAT figure enters that unit: one more entered", r["pat_done"] == 1, r)
    s.check("...and it leaves 'To enter', the others stay", DA not in r["pat_todo"] and DB in r["pat_todo"]
            and DC in r["pat_todo"], r["pat_todo"])
    W("INSERT INTO pm_pbt_achievement(cycle_id, business_group, company, achievement_pct) VALUES (?,?,'',95)",
      (PER, BG))
    s.check("an old business-group PAT row (no unit) is never read", mine(card())["pat_done"] == 1)
    W("INSERT INTO pm_pbt_achievement(cycle_id, business_group, company, achievement_pct) VALUES (?,?,?,90)",
      (PER, BG, CO_X))
    s.check("a PAT figure for the left-out unit is not counted either", mine(card())["pat_done"] == 1
            and mine(card())["pat_n"] == 3)
    W("DELETE FROM cycle_exclusions WHERE cycle_id=? AND business_group=? AND company=?", (CID, BG, CO_X))
    r = mine(card())
    s.check("take the exclusion away and that unit counts (its BU KPI and its PAT): the exclusion was what left it out",
            r["pat_n"] == 4 and r["bu_n"] == 4 and r["pat_done"] == 2, r)
    W("INSERT INTO cycle_exclusions(cycle_id, business_group, company) VALUES (?,?,?)", (CID, BG, CO_X))
    W("DELETE FROM pm_pbt_achievement WHERE business_group=? AND company IN (?,?)", (BG, "", CO_X))

    # -----------------------------------------------------------------------
    s.section("who sees it")
    sup, bga = H.client_as(a, SU["id"]), H.client_as(a, U["ZZPC-ADM"])
    window(now + timedelta(days=30))
    W("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (T["r1"],))   # one BU KPI to fill again
    r = sup.get("/admin")
    body = html.unescape(r.get_data(as_text=True))
    s.check("the super admin's Home carries the card", r.status_code == 200 and 'aria-label="Before calibration"' in body,
            r.status_code)
    s.check("...with the group and the unit still to enter named", DBG in body and "To enter:" in body)
    pc = body[body.index('aria-label="Before calibration"'):]
    pc = pc[:pc.index("</section>")]
    s.check("...it starts folded: the columns and footnote sit in a closed details.hj-fold, the head before it",
            '<details class="hj-fold">' in pc and "<details class=\"hj-fold\" open" not in pc
            and pc.index('class="hj-head"') < pc.index("<details") < pc.index('class="hj-cols"')
            and pc.index("Counts the units taking part") > pc.index("<details")
            and "Show details" in pc and "Hide details" in pc, pc[:300])
    s.check("...Fill BU KPI opens that group's Fill page", "business_group=" + quote_plus(BG) in body
            and "Fill BU KPI" in body)
    s.check("...Enter PAT opens PAT Ref for that group", "fbg=" + quote_plus(BG) in body and "Enter PAT" in body)
    s.check("...and ends with the count line", "Counts the units taking part in" in body
            and "The card leaves Home once every BU KPI result" in body)
    fill(T["r1"])
    r = bga.get("/admin")
    body = html.unescape(r.get_data(as_text=True))
    s.check("a BG admin's Home has no card", r.status_code == 200 and 'aria-label="Before calibration"' not in body
            and "Before calibration" not in body, r.status_code)
    s.check("...and the function gives them nothing", card(U["ZZPC-ADM"]) is None)

    # -----------------------------------------------------------------------
    s.section("the states, by the BU CEO performance calibration dates")
    window()
    c = card()
    s.check("no opening date: amber 'Needs you', pointing at Cycle > Calendar",
            c and c["chip"] == "Needs you" and not c["due"] and c["when_link"] and "no opening date" in c["when"], c)
    r = sup.get("/admin")
    body = html.unescape(r.get_data(as_text=True))
    s.check("...on the page, with the calendar link", "has no opening date yet" in body and "/admin/windows" in body)
    window(now + timedelta(days=18))
    c = card()
    s.check("18 days out: amber, said as 'in 18 days'", c and c["chip"] == "Needs you" and not c["due"]
            and "in 18 days" in c["when"], c)
    window(now + timedelta(days=a.PRECAL_DUE_DAYS + 1))
    c = card()
    s.check("one day past the lead time: still amber", c and not c["due"] and c["chip_cls"] == "jn-wait", c)
    window(now + timedelta(days=a.PRECAL_DUE_DAYS))
    c = card()
    s.check("exactly the lead time out: red, 'Due in %d days'" % a.PRECAL_DUE_DAYS,
            c and c["due"] and c["chip_cls"] == "pc-due" and c["chip"] == "Due in %d days" % a.PRECAL_DUE_DAYS, c)
    r = sup.get("/admin")
    body = html.unescape(r.get_data(as_text=True))
    s.check("...the page carries the red edge", "pc-card is-due" in body and 'class="pc-due"' in body)
    window(now + timedelta(days=1))
    s.check("one day out: singular", card()["chip"] == "Due in 1 day", card()["chip"])
    eod = now.replace(hour=23, minute=59, second=0, microsecond=0)
    if eod > now:
        window(eod)
        s.check("opens later today: 'Due today'", card()["chip"] == "Due today", card()["chip"])
    window(now - timedelta(days=1), now + timedelta(days=2))
    c = card()
    s.check("opened, closes in two days, something missing: red 'Calibration is open'",
            c and c["due"] and c["chip"] == "Calibration is open" and c["chip_cls"] == "pc-due"
            and "opened" in c["when"] and " · closes %s" % (now + timedelta(days=2)).strftime("%-d %b") in c["when"]
            and "calibrating against the Normal curve" in c["lead"], c)
    window(now - timedelta(days=1))
    c = card()
    s.check("opened with no close date: still red, and no 'closes' in the words", c and c["chip"] == "Calibration is open"
            and "closes" not in c["when"], c)
    window(now - timedelta(days=3), now - timedelta(days=1))
    s.check("closed: no card, whatever is missing", card() is None)
    window(now + timedelta(days=18))

    s.section("ready, and gone")
    for co in (CO_B, CO_C):
        W("INSERT INTO pm_pbt_achievement(cycle_id, business_group, company, achievement_pct) VALUES (?,?,?,100)",
          (PER, BG, co))
    c = card()
    s.check("everything in, before it opens: the one-line ready card", c and c["ready"] and not c["missing"]
            and c["lead"] == "Every BU KPI result and every unit's PAT is in.", c)
    r = sup.get("/admin")
    body = html.unescape(r.get_data(as_text=True))
    s.check("...on the page it is the ready line, with no table", "Ready for calibration" in body
            and "To enter:" not in body and "pc-line" in body)
    window(now - timedelta(days=1), now + timedelta(days=2))
    s.check("everything in once it has opened: no card", card() is None)
    window(now + timedelta(days=18))
    W("DELETE FROM pm_pbt_achievement WHERE business_group=? AND company=?", (BG, CO_C))
    c = card()
    s.check("one PAT taken away and it is back (not ready)", c and not c["ready"] and c["missing"], c)
    W("INSERT INTO pm_pbt_achievement(cycle_id, business_group, company, achievement_pct) VALUES (?,?,?,100)",
      (PER, BG, CO_C))

    s.section("when there is no card")
    W("UPDATE cycles SET half=0 WHERE id=?", (CID,))
    s.check("an Early Year: none (half 0 is falsy, compared, not tested)", card() is None)
    W("UPDATE cycles SET half=1 WHERE id=?", (CID,))
    s.check("a Mid-Year shows it", card() is not None)
    W("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    s.check("a Year-End shows it", card() is not None)
    W("UPDATE cycle_modules SET active=0 WHERE cycle_id=? AND module_key='pm'", (CID,))
    s.check("Performance off for the cycle: none", card() is None)
    W("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key='pm'", (CID,))
    s.check("...and back on, it is back", card() is not None)
    W("UPDATE cycles SET is_active=0 WHERE id=?", (CID,))
    s.check("no active cycle: none", card() is None)
    W("UPDATE cycles SET is_active=1 WHERE id=?", (CID,))

    s.section("reads only")
    cnt = ("SELECT (SELECT COUNT(*) FROM pm_kpi_results)+(SELECT COUNT(*) FROM pm_pbt_achievement)"
           "+(SELECT COUNT(*) FROM cycle_windows)+(SELECT COUNT(*) FROM activity_log)")
    n0 = H.one(a, cnt)
    card()
    sup.get("/admin")
    n1 = H.one(a, cnt)
    s.check("building and showing the card writes nothing", n0 == n1, (n0, n1))
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        if ADDED_OUT:
            db.execute("DELETE FROM cycle_exclusions WHERE id IN (%s)" % ",".join("?" * len(ADDED_OUT)), ADDED_OUT)
        if ORIG:
            db.execute("UPDATE cycles SET half=?, is_active=1 WHERE id=?", (ORIG["half"], CID))
            if ORIG["pm"] is None:
                db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='pm'", (CID,))
            else:
                db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key='pm'",
                           (ORIG["pm"][0], CID))
            db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell=?", (CID, CELL))
            if ORIG["win"] is not None:
                db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                           (CID, CELL, ORIG["win"][0], ORIG["win"][1]))
        db.commit()
sys.exit(s.done())
