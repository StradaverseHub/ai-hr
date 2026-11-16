"""Admin housekeeping and the admin's Talent Box (Chris, 2026-10-10, canvas row J).

  "the admin page should show the overview first instead of 360 since we have expanded our modules. The overview should
   show the summary of each BG and each module progress."
  "admin should have the same talent box view as BGCEO in the admin page."

Home: every landing that sent an admin to the 360 comes to /admin, which shows each business group x each live module
(grouped COUNTs, scoped to the admin), what needs you and what stands out. The Talent Box: Calibration & Talent > Run >
Talent Box, the BG CEO's own box from the same builder, one business unit at a time, read only, scoped by business group
(and a sub-admin's units).

Its own synthetic business group (ZZHT) on the shared suite database, two units: Alpha banded and locked by its BU CEO
and then locked by the BG CEO on the box, Beta banded but not locked. Everything is put back at the end.
"""
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Admin Home and the admin's Talent Box -- each BG by module, the BG CEO's box read only")
BG, CA, CB = "ZZHT Group", "ZZHT Alpha Sdn Bhd", "ZZHT Beta Sdn Bhd"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZHT-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN "
                   "(%s))" % ph, ids)
        for tb in ("pm_kpi_targets", "pm_calibration_adjustments", "calibration_adjustments", "rating_records",
                   "talent_status_history"):
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (tb, ph), ids)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
    db.execute("DELETE FROM pm_calibration_sessions WHERE business_group=?", (BG,))
    db.execute("DELETE FROM calibration_sessions WHERE business_group=?", (BG,))
    db.execute("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZHT-%'")
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    _cleanup(db)   # a run that died half-way
    _ORIG = {"modules": {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=? "
                                                         "AND module_key IN ('calibration','pm','tm')", (CID,))},
             }
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('calibration','pm','tm')", (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, company, kpi=True, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=company, left_at=None,
                 is_demo=0, role="user", admin_bg=None)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        uid = db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
        if kpi:
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                       "business_group, company) VALUES (?,?,?,100,'more','approved',?,?)",
                       (PER, uid, "ZZHT KPI", BG, company))
        return uid
    BOSS = person("ZZHT-CEO", "ZZ HT Group Ceo", CA, bgceo_bg=BG)
    A_ = [person("ZZHT-A%d" % i, "ZZ HT Alpha %d" % i, CA) for i in range(4)]
    B_ = [person("ZZHT-B%d" % i, "ZZ HT Beta %d" % i, CB) for i in range(2)]
    ADM = person("ZZHT-ADM", "ZZ HT Bgadmin", CA, kpi=False, role="admin", admin_bg=BG)
    OTHER = db.execute("SELECT business_group FROM org_units WHERE active=1 AND business_group!=? ORDER BY "
                       "business_group LIMIT 1", (BG,)).fetchone()[0]
    OADM = person("ZZHT-OADM", "ZZ HT Otheradmin", CA, kpi=False, role="admin", admin_bg=OTHER, business_group=OTHER)
    SUB = person("ZZHT-SUB", "ZZ HT Subadmin", CB, kpi=False, role="admin", admin_bg=BG)
    db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (SUB, CB))
    for co in (CA, CB):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, co))
    # a group name left only on closed accounts (production's old demo "Group Office"): one leaver, rated twice
    GONE_BG = "ZZHT Retired Group"
    GHOST = person("ZZHT-GHOST", "ZZ HT Ghost", CA, kpi=False, business_group=GONE_BG, left_at="2026-01-31 00:00:00")
    for rater in A_[:2]:
        db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, submitted_at) "
                   "VALUES (?,?,?, 'peer', 'submitted', CURRENT_TIMESTAMP)", (CID, GHOST, rater))
    # two scorecards in (every line submitted), the rest not
    for sid in A_[:2]:
        t = db.execute("SELECT id FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=?", (sid, PER)).fetchone()[0]
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,100,?,0)",
                   (t, sid))
    # both units banded by their BU CEO on both axes; Alpha locked, and then locked by the BG CEO on the box
    for co, ppl, lock in ((CA, A_, True), (CB, B_, False)):
        ps = a._pm_calib_get_or_create_session(db, PER, "buceo", co, BG, co)
        cs = a._get_or_create_calibration_session(db, CID, "buceo", co, BG, co)
        for sid, pb, qb in zip(ppl, ("ME", "AE", "OU", "BE"), ("Mid", "Mid", "High", "Low")):
            a._pm_calib_upsert_adjustment(db, ps["id"], sid, "", pb, "BU set", BOSS)
            a._calibration_upsert_adjustment(db, cs["id"], sid, "", qb, "BU set", BOSS)
        if lock:
            db.execute("UPDATE pm_calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE id=?", (ps["id"],))
            db.execute("UPDATE calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE id=?", (cs["id"],))
    db.execute("INSERT INTO talent_box_bu_locks(period_id, cycle_id, business_group, company, locked_by) "
               "VALUES (?,?,?,?,?)", (PER, CID, BG, CA, BOSS))
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]
    DBG, DOTHER = a.display_bg(BG), a.display_bg(OTHER)
    LA, LB = a._talent_box_bu_label(BG, CA), a._talent_box_bu_label(BG, CB)


def page(cl, url):
    r = cl.get(url)
    return r.status_code, html.unescape(r.get_data(as_text=True))


def payload(body):
    m = re.search(r'<script type="application/json" id="atb-data">(.*?)</script>', body, re.S)
    return json.loads(m.group(1)) if m else None


def matrix_as(uid, stage="emp"):
    """Home's matrix; the employees' stage by default (the table these checks were written on). Since the stage switch
    (2026-11-09) Calibration is the BG CEOs' stage (stage="bg")."""
    with a.app.test_request_context("/admin"):
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
        return a._home_bg_matrix(db, u, a.viewed_cycle(db), stage=stage)


sup, bga, oadm, sub = (H.client_as(a, x) for x in (SUP, ADM, OADM, SUB))
TB = "/admin/calibration/talent-box"
try:
    # -----------------------------------------------------------------------
    s.section("Home first: every landing that sent an admin to the 360 comes to Home")
    for url in ("/dashboard", "/my-assessments", "/my-report", "/me"):
        r = sup.get(url)
        s.check("%s sends an admin to Home, not the 360" % url, r.status_code in (301, 302)
                and r.headers.get("Location", "").rstrip("/").endswith("/admin"), (r.status_code, r.headers.get("Location")))
    r = sup.get("/admin/cycle/select?cycle=%d" % CID)
    s.check("switching the cycle you view lands on Home too", r.headers.get("Location", "").endswith("/admin"),
            r.headers.get("Location"))
    s.check("the 360's own Overview is still there, in its section", sup.get("/admin/360").status_code == 200)

    # -----------------------------------------------------------------------
    s.section("Home: each business group, each live module")
    code, b = page(sup, "/admin")
    s.check("Home opens with the grid, a row per business group and a total", code == 200
            and "Where each business group is, module by module" in b and "All business groups" in b
            and DBG in b, code)
    m = matrix_as(SUP)
    row = next((r for r in m["rows"] if r["bg"] == BG), None)
    keys = [c["key"] for c in m["cols"]]
    pm = row["cells"][keys.index("pm")] if row and "pm" in keys else None
    s.check("Performance: 2 of 7 scorecards submitted (every line), as the database says",
            pm and pm["pct"] == 28 and pm["sub"] == "2 of 7 scorecards submitted", pm)
    s.check("...and the cell opens Performance progress for that business group",
            pm and pm["url"] and "/admin/module/pm/progress" in pm["url"] and "fbg=" in pm["url"], pm and pm["url"])
    # a part whose window hasn't opened says when it opens, even with a scorecard already in (Chris, 2026-10-30: the super
    # admin fills BU KPI results before Performance opens, and CHBM read "0% . 3 of 541 scorecards submitted")
    with a.app.test_request_context("/"):
        db = a.get_db()
        _w0 = [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows WHERE "
                                            "cycle_id=? AND cell='pm_results'", (CID,))]
        _then, _now_ = a._now_myt() + a.timedelta(days=9), a._now_myt() - a.timedelta(days=9)
        _put = lambda o: (db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_results'", (CID,)),  # noqa
                          db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                                     (CID, "pm_results", o.strftime("%Y-%m-%d %H:%M"), None)), db.commit())
        _put(_then)
    try:
        mw = matrix_as(SUP)
        rw = next((r for r in mw["rows"] if r["bg"] == BG), None)
        pw = rw["cells"][keys.index("pm")] if rw else None
        s.check("Performance not open yet: the cell says when it opens, though 2 scorecards are already in",
                pw and pw["pct"] is None and pw["url"] is None
                and pw["sub"] == "opens " + a._st_day(_then.strftime("%Y-%m-%d %H:%M")), pw)
        tw = mw["total"]["cells"][keys.index("pm")]
        s.check("...and so does the All row, whatever the groups hold", tw["pct"] is None and tw["sub"].startswith("opens "), tw)
        s.check("...and it is left out of what stands out (not a figure)", not any("Performance" in n_ for n_ in mw["notes"]),
                mw["notes"])
        with a.app.test_request_context("/"):
            db = a.get_db()
            _put(_now_)
        mo = matrix_as(SUP)
        po = next(r for r in mo["rows"] if r["bg"] == BG)["cells"][keys.index("pm")]
        s.check("...from the opening day it shows the percentage again", po["pct"] == 28 and po["sub"].startswith("2 of 7"), po)
    finally:
        with a.app.test_request_context("/"):
            db = a.get_db()
            db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_results'", (CID,))
            for r_ in _w0:
                db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", r_)
            db.commit()
    # Calibration moved to the BG CEOs' stage (Chris, 2026-11-09): the Employees view has no such column, the stage has it
    s.check("the Employees view has no Calibration column (it lives in the BG CEOs' stage)", "calibration" not in keys, keys)
    with a.app.test_request_context("/"):
        _d = a.get_db()
        _c0 = dict(_d.execute("SELECT kind, half FROM cycles WHERE id=?", (CID,)).fetchone())
        _d.execute("UPDATE cycles SET kind='year_end', half=2 WHERE id=?", (CID,))
        _d.commit()
    try:
        mbg = matrix_as(SUP, stage="bg")
    finally:
        with a.app.test_request_context("/"):
            _d = a.get_db()
            _d.execute("UPDATE cycles SET kind=?, half=? WHERE id=?", (_c0["kind"], _c0["half"], CID))
            _d.commit()
    brow = next((r for r in mbg["rows"] if r["bg"] == BG), None)
    cal = brow["cells"][0] if brow and mbg["cols"] and mbg["cols"][0]["key"] == "calibration" else None
    s.check("Calibration (BG CEOs' stage): 1 of 2 units locked by the BG CEO, opening the admin's Talent Box",
            cal and cal["sub"] == "1 of 2 units locked" and cal["pct"] == 50 and TB in (cal["url"] or ""), cal)
    s.check("people counts only real, current people (not the admins)", row and row["people"] == 7, row and row["people"])
    tot = m["total"]
    s.check("the total row adds every business group's numbers",
            tot["people"] == sum(r["people"] for r in m["rows"]), (tot["people"], sum(r["people"] for r in m["rows"])))
    mb = matrix_as(ADM)
    s.check("a BG admin sees their own business group only", [r["bg"] for r in mb["rows"]] == [BG],
            [r["bg"] for r in mb["rows"]])
    code, b = page(bga, "/admin")
    s.check("...with no total row and no other group on the page", code == 200 and "All business groups" not in b
            and ">%s<" % DOTHER not in b)
    ms = matrix_as(SUB)
    rs = next((r for r in ms["rows"] if r["bg"] == BG), None)
    s.check("a sub-admin's numbers count their own units only (Beta: 2 people)", rs and rs["people"] == 2,
            rs and rs["people"])
    s.check("the old module cards are gone (the grid's total row says it)", "adm-home-card" not in b)
    s.check("what stands out is said in words", isinstance(m["notes"], list))
    # a name left only on closed accounts gets no row (Chris, 2026-10-17: Group Office with 0 people, no settings)
    s.check("a group name left only on closed accounts gets no row of its own",
            GONE_BG not in [r["bg"] for r in m["rows"]], [r["bg"] for r in m["rows"]])
    if "f360" in keys:
        fi = keys.index("f360")
        # "out means out" for admin progress counts (2026-10-31): a leaver is not taking part in the 360, so the ghost's
        # two submitted ratings are no longer in the grid (they were, as "its leaver's ratings still count", before)
        with a.app.test_request_context("/"):
            _all = H.one(a, "SELECT COUNT(*) FROM assignments a JOIN users u ON u.id=a.subject_id WHERE a.cycle_id=? "
                            "AND a.archived=0 AND COALESCE(u.business_group,'')!=''", (CID,))
            _taking = H.one(a, "SELECT COUNT(*) FROM assignments a JOIN users u ON u.id=a.subject_id WHERE a.cycle_id=? "
                               "AND a.archived=0 AND COALESCE(u.business_group,'')!='' AND " + a.rater_task_sql("a"),
                            (CID,))
            # Chris 2026-11-06: the 360 cell counts RATERS: live people owing at least one rating of someone taking part
            _raters = H.one(a, "SELECT COUNT(DISTINCT a.assessor_id) FROM assignments a JOIN users u ON u.id=a.assessor_id "
                               "WHERE a.cycle_id=? AND a.archived=0 AND u.role!='admin' AND u.left_at IS NULL AND "
                               "COALESCE(u.is_demo,0)=0 AND COALESCE(u.business_group,'')!='' AND " + a.rater_task_sql("a"),
                            (CID,))
        _sub = m["total"]["cells"][fi]["sub"] or ""
        s.check("...its leaver's ratings are left out of the total (only colleagues taking part in the 360 count)",
                _sub.split(" of ")[1].split(" ")[0].replace(",", "") == str(_raters) and _all - _taking >= 2,
                (_sub, _all, _taking, _raters))
        s.check("...so the line under the table has no 360 part to name for the retired group",
                "ratings in" not in m["gone_note"] and GONE_BG not in m["gone_note"], m["gone_note"])
        code, b = page(sup, "/admin")
        s.check("...and the retired group is not on the page, as a row or a footnote", GONE_BG not in b)
    else:
        s.check("360 Feedback is on for the grid (the ghost checks need it)", False, keys)

    # -----------------------------------------------------------------------
    s.section("the admin's Talent Box: the BG CEO's box, read only")
    s.check("it is under Calibration & Talent > Run", any(
        p_["ep"] == "admin_talent_box" for t in a.ADMIN_SECTION_BY_KEY["calibration"]["tabs"] if t["key"] == "run"
        for p_ in t["pages"]))
    code, b = page(sup, TB + "?bg=" + BG)
    s.check("it opens on the next unit the BG CEO has to do (Beta; Alpha is locked)", code == 200
            and re.search(r'class="rv-tbox-bu is-on"[^>]*aria-current="true"[^>]*>%s' % re.escape(LB), b)
            is not None, code)
    code, b = page(sup, TB + "?bg=%s&company=%s" % (BG, CA))
    pl = payload(b)
    with a.app.test_request_context("/"):   # as the BG CEO, signed in
        a.session["user_id"] = BOSS
        db = a.get_db()
        boss = dict(db.execute("SELECT * FROM users WHERE id=?", (BOSS,)).fetchone())
        ctx = a._talent_box_resolve(db, boss, "bgceo", bg=BG)
        D = a._talent_box_data(db, boss, "bgceo", ctx, {"bg": BG}, CA)
        theirs = {"%s|%s" % k: len(v) for k, v in D["cells"].items()}
    mine = {c["key"]: c["n"] for c in (pl or {}).get("cells", [])}
    s.check("every box holds what the BG CEO's own box holds for Alpha (its 4, and the BG CEO who sits there)",
            pl and mine == theirs and sum(mine.values()) == 5,
            (mine, theirs))
    s.check("...says the unit is locked, and by whom", "Locked by ZZ HT Group Ceo" in b)
    s.check("...each name opens their person page", "/admin/users/%d" % A_[0] in json.dumps(pl))
    with a.app.test_request_context("/"):
        mv, lk = a.url_for("talent_box_bgceo_move", bg=BG), a.url_for("talent_box_bgceo_lock", bg=BG)
    s.check("read only: nothing on it moves or locks", mv not in b and lk not in b and 'method="post"' not in b.split(
        'id="atb"')[-1])
    code, b = page(bga, TB + "?bg=" + OTHER)
    s.check("a BG admin reads their own business group's box, whatever they ask for", code == 200
            and LB in b and payload(b) is not None)
    code, b = page(oadm, TB + "?bg=" + BG)
    s.check("an admin of another business group never sees this one", code == 200 and "ZZ HT Alpha" not in b
            and "ZZ HT Beta" not in b)
    code, b = page(sub, TB + "?bg=%s&company=%s" % (BG, CA))
    s.check("a sub-admin sees their own units only (Beta), even asking for Alpha", code == 200
            and "ZZ HT Beta" in b and "ZZ HT Alpha" not in b and LA not in b)
    s.check("someone who isn't an admin can't open it", H.client_as(a, BOSS).get(TB).status_code in (302, 403))

    # -----------------------------------------------------------------------
    s.section("the admin's Talent Box is the BG CEO's card, read only, with both curves (Chris, 2026-10-30, canvas board F)")
    code, b = page(sup, TB + "?bg=%s&company=%s" % (BG, CA))
    card = b[b.index('id="atb"'):b.index("</section>", b.index('id="atb"'))]   # the BG CEO's card alone (the page has global forms)
    s.check("the BG CEO's card classes: title bar with Grid | List, BU row with PAT pills, the Filter line, the 3x3 (nine cells, row heads, column "
            "feet, both axis buttons), the people panel, the list, the foot",
            all(c in card for c in ("rv-cal-titlebar rv-tbox-titlebar", "Talent Box Calibration", "rv-tbox-views", "rv-tbox-busrow",
                                    'class="rv-tbox-filter" id="atb-filter"', 'class="rv-tbox-grid"', "rv-tbox-drawer", "rv-tbox-listwrap",
                                    "rv-cal-foot rv-tbox-foot", "rv-tbox-showmoved"))
            and card.count('class="rv-tbox-cell"') == 9 and card.count('class="rv-tbox-rowh"') == 3 and card.count('class="rv-tbox-colf"') == 3
            and 'rv-tbox-axbtn is-y' in card and 'rv-tbox-axbtn is-x' in card and card.count("rv-tbox-pat") >= 1, code)
    s.check("...the old admin box is gone: no .atb-grid / cell / people / chips, no Business unit or Department row of the kit (the Business group row stays)",
            not any(c in b for c in ('class="atb-grid"', "atb-cell", "atb-people", "atb-chip", "atb-toggle", "atb-box", 'class="atb-list"'))
            and re.findall(r'class="adm-frow-lbl">([^<]*)<', b) == ["Business group"], re.findall(r'class="adm-frow-lbl">([^<]*)<', b))
    s.check("...a cell is the BG CEO's: category, count, share, faces; Super Star carries data-cat=super-star (the navy fill)",
            'data-cat="super-star"' in card and 'data-cat="solid-core"' in card and "rv-tbox-big" in card and "rv-tbox-faces" in card)
    pl = payload(b)
    s.check("the Filter line, the people panel, the list and the curves are drawn from the one JSON with the shared code (calib_shared.js before "
            "admin_talent_box.js); the chat's journey_chat.js is NOT loaded here",
            "calib_shared.js" in b and "admin_talent_box.js" in b and b.index("calib_shared.js") < b.index("admin_talent_box.js")
            and "journey_chat.js" not in b and pl and "filters" in pl and "perf_curve" in pl and "pot_curve" in pl)
    s.check("read only: no Move, no Lock (no button, no form, no lock route), the foot says the lock state instead (Alpha is locked by the BG CEO)",
            not any(c in card for c in ("rv-tbox-mvbtn", "rv-cal-lock", "Lock Talent Box", "<form", ">Move<", "data-move"))
            and re.search(r'class="atb-lockpill"[^>]*>Locked by ZZ HT Group Ceo \u00b7 \d{1,2} \w{3} \d{4}<', card) is not None,
            ([c for c in ("rv-tbox-mvbtn", "rv-cal-lock", "Lock Talent Box", "<form", ">Move<", "data-move") if c in card],
             re.findall(r'atb-lockpill[^>]*>([^<]*)<', card)))
    s.check("...the unit pills carry each unit's PAT, and a padlock on the one the BG CEO locked (Alpha), none on Beta",
            re.search(r'<a class="rv-tbox-bu is-on"[^>]*>%s<span class="rv-tbox-bulock is-mine">' % re.escape(LA), card) is not None
            and re.search(r'<a class="rv-tbox-bu"[^>]*>%s<span class="rv-tbox-pat">' % re.escape(LB), card) is not None
            and 'rv-tbox-pat">PAT ' in card, re.findall(r'<a class="rv-tbox-bu[^>]*>[^<]*(?:<span[^>]*>)*', card)[:2])
    code, bB = page(sup, TB + "?bg=%s&company=%s" % (BG, CB))
    s.check("...and an unlocked unit says so: 'Not locked yet: the BG CEO is still placing'", "Not locked yet: the BG CEO is still placing" in bB
            and "Locked by" not in bB[bB.index('id="atb"'):])
    perf, pot = pl["perf_curve"], pl["pot_curve"]
    s.check("both curves are in view: Performance distribution (5 bands against the curve the PAT sets) and Potential distribution (Low / Mid / High "
            "against 15-70-15), each a card, each counting exactly the people on the grid",
            "Performance distribution" in b and "Potential distribution" in b and 'id="atb-curve-perf"' in b and 'id="atb-curve-pot"' in b
            and len(perf["band_order"]) == 5 and len(pot["band_order"]) == 3 and pot["curve"]["label"] == "15-70-15"
            and perf["total"] == pot["total"] == pl["placed"] == sum(c["n"] for c in pl["cells"]) == 5
            and sum(perf["distribution"].values()) == 5 and sum(pot["distribution"].values()) == 5, (perf["total"], pot["total"], pl["placed"]))
    # the curve rows are the BG CEO's own: the shared calibDistBox, run on this payload in a stub DOM
    import shutil as _sh
    import subprocess as _sp
    SH = H.source(a, "static/calib_shared.js")
    if _sh.which("node"):
        stub = ("function mk(t){var e={tag:t,children:[],className:'',style:{},attrs:{},classList:{add:function(c){e.className+=' '+c;}},"
                "appendChild:function(c){e.children.push(c);return c;},setAttribute:function(k,v){e.attrs[k]=v;},addEventListener:function(){}};return e;}\n"
                "var document={createElement:mk,createTextNode:function(t){return {text:t};},createElementNS:mk,querySelector:function(){return null;}};\n"
                "var window={onehrProper:function(s){return s;}};\n")
        def rows_of(cv, byb=True):
            js = stub + SH + "\nvar b=window.OneHRCalib.calibDistBox(%s,{compact:true,noVerdict:true,byBreach:%s});" % (json.dumps(cv), "true" if byb else "false")
            js += ("console.log(JSON.stringify({rows:b.children.filter(function(c){return /calib-dist-row/.test(c.className);}).length,"
                   "verdict:b.children.some(function(c){return /rv-calib-verdict/.test(c.className);}),"
                   "gaps:b.children.filter(function(c){return /calib-dist-row/.test(c.className);}).map(function(r){return r.children[3].className;})}));")
            o = _sp.run(["node", "-"], input=js, capture_output=True, text=True, timeout=60)
            return json.loads(o.stdout) if o.returncode == 0 and o.stdout.strip() else ("err", o.stderr[:300])
        rp, rq = rows_of(perf), rows_of(pot)
        s.check("...the shared curve box draws 5 rows for performance and 3 for potential, without the verdict line (the cards draw rows alone)",
                isinstance(rp, dict) and rp["rows"] == 5 and rq["rows"] == 3 and not rp["verdict"] and not rq["verdict"], (rp, rq))
        s.check("...a gap is amber (is-short) only for a band outside the tolerance (byBreach), grey otherwise",
                isinstance(rp, dict) and any("is-short" in g for g in rp["gaps"])
                and all(("is-short" in g) == (band in perf["breaches"]) for g, band in zip(rp["gaps"], perf["band_order"])), (rp["gaps"], perf["breaches"]))
        # falsified: take a band inside the tolerance and short of its curve: the BG CEO's own tone is amber for any shortfall, the card's is grey
        perf2 = dict(perf, gaps=dict(perf["gaps"], UA=1), breaches={})
        s.check("falsified: a band short by one but inside the tolerance is grey on the card (byBreach) and amber in the BG CEO's own dialog tone",
                rows_of(perf2)["gaps"][0] == "calib-dist-gap is-onTarget" and rows_of(perf2, False)["gaps"][0] == "calib-dist-gap is-short",
                (rows_of(perf2)["gaps"][0], rows_of(perf2, False)["gaps"][0]))
        # the initials on the faces and the share Jinja prints are the client's (tbInitials / tbPctOf)
        names = ["ZZ HT Group Ceo", "ZZ Demo Report 12 (CHBM)", "Single", "  ", "1234 5678", "ab", "Dr. Who Ever"]
        o = _sp.run(["node", "-"], input="""function tbInitials(name) { var w = String(name || "").trim().split(/\\s+/).filter(function (x) { return /^[A-Za-z]/.test(x); });
          if (!w.length) return "?"; return (w[0].charAt(0) + (w.length > 1 ? w[w.length - 1].charAt(0) : "")).toUpperCase(); }
          console.log(JSON.stringify([%s].map(tbInitials)));
          var out = []; for (var tot = 1; tot <= 60; tot++) for (var n = 0; n <= tot; n++) out.push(Math.round(n / tot * 100));
          console.log(JSON.stringify(out));""" % ",".join(json.dumps(x) for x in names), capture_output=True, text=True, timeout=60)
        js_ini, js_pct = [json.loads(x) for x in o.stdout.strip().splitlines()]
        pct_of = lambda n, tot: int(float(n) / tot * 100 + 0.5) if tot else 0   # the page's own function (admin_talent_box)
        s.check("the faces' initials (_tb_initials) and the shares the page prints (Math.round(n / total * 100)) are the client's, for every n of 1..60 totals",
                [a._tb_initials(x) for x in names] == js_ini and [pct_of(n, t) for t in range(1, 61) for n in range(t + 1)] == js_pct,
                ([a._tb_initials(x) for x in names], js_ini))
    # -----------------------------------------------------------------------
    s.section("the picks: every filter the unit has, several values in one, the grid and both curves following together")
    with a.app.test_request_context("/"):
        db = a.get_db()
        for i, uid in enumerate(A_):
            db.execute("UPDATE users SET cost_center=?, department=? WHERE id=?", (("ZZHT-CC1", "ZZHT-CC1", "ZZHT-CC2", None)[i],
                                                                                   "ZZHT Sales" if i < 2 else "ZZHT Ops", uid))
        db.execute("UPDATE users SET cost_center='ZZHT-CC3', department='ZZHT Ops' WHERE id=?", (BOSS,))
        db.commit()
    U = TB + "?bg=%s&company=%s" % (BG, CA)

    def pick(q=""):
        code, bb = page(sup, U + q)
        pp = payload(bb)
        return pp, bb

    def ids_of(pp):
        return {x["id"] for c in pp["cells"] for x in c["people"]}
    p0, _b0 = pick()
    ccf = next((f for f in p0["filters"] if f["key"] == "cc"), None)
    s.check("with every rule off the page still has the filter chips the unit has values for (Department, Cost centre ...), counted within the picks before them",
            ccf is not None and [o["key"] for o in ccf["options"]] == ["ZZHT-CC1", "ZZHT-CC2", "ZZHT-CC3"] and ccf["not_set"] == 1
            and {f["key"] for f in p0["filters"]} >= {"dept", "cc"}, p0["filters"] and [f["key"] for f in p0["filters"]])
    p1, _b1 = pick("&cc=ZZHT-CC1")
    s.check("one cost centre narrows the grid's sum, the placed count, 'Showing N of M' and BOTH curves' totals equally",
            len(ids_of(p1)) == 2 and p1["placed"] == sum(c["n"] for c in p1["cells"]) == 2 and p1["show_n"] == 2 and p1["show_m"] == 5
            and p1["perf_curve"]["total"] == p1["pot_curve"]["total"] == 2
            and sum(p1["perf_curve"]["distribution"].values()) == sum(p1["pot_curve"]["distribution"].values()) == 2, (p1["placed"], p1["show_n"]))
    p2, _b2 = pick("&cc=ZZHT-CC1&cc=ZZHT-CC2")
    s.check("two cost centres = the union (3 people), the chip says both, the picks ride in the JSON, grid and curves agree",
            len(ids_of(p2)) == 3 and ids_of(p2) == ids_of(p1) | ids_of(pick("&cc=ZZHT-CC2")[0]) and p2["placed"] == p2["perf_curve"]["total"]
            == p2["pot_curve"]["total"] == 3 and next(f for f in p2["filters"] if f["key"] == "cc")["values"] == ["ZZHT-CC1", "ZZHT-CC2"]
            and p2["picks"]["cc"] == ["ZZHT-CC1", "ZZHT-CC2"], p2["picks"])
    p3, _b3 = pick("&cc=ZZHT-CC1&cc=NO-SUCH&cc=ZZHT-CC2")
    s.check("a bogus value among good ones is dropped, the good ones stay", ids_of(p3) == ids_of(p2)
            and next(f for f in p3["filters"] if f["key"] == "cc")["values"] == ["ZZHT-CC1", "ZZHT-CC2"])
    p4, _b4 = pick("&cc=NO-SUCH&dept=NO-DEPT&jg=99&cal=grp:0")
    s.check("falsified: only bogus values (every param) are all dropped: the whole unit, nothing picked", len(ids_of(p4)) == 5
            and not any(f["values"] for f in p4["filters"]) and p4["show_n"] == 5)
    p5, _b5 = pick("&dept=ZZHT+Sales&cc=ZZHT-CC1&cc=ZZHT-CC2")
    s.check("filters combine: department AND cost centres = the intersection (the two in Sales and CC1/CC2), the cost-centre chip counts within the department",
            ids_of(p5) == ids_of(p1) and next(f for f in p5["filters"] if f["key"] == "cc")["earlier"] == ["ZZHT Sales"], len(ids_of(p5)))
    p6, _b6 = pick("&dept=ZZHT+Sales&dept=ZZHT+Ops")
    s.check("two departments = both (everyone), the title's word is '2 departments' (dept stays empty: the chips carry them)",
            len(ids_of(p6)) == 5 and p6["dept"] == "" and next(f for f in p6["filters"] if f["key"] == "dept")["values"] == ["ZZHT Sales", "ZZHT Ops"])
    pills_ = re.findall(r'<a class="rv-tbox-bu(?: is-on)?" href="([^"]*)"', _b1)
    s.check("a unit pill goes to that unit with the business group alone: the picks (a unit has its own values) are not carried over",
            len(pills_) == 2 and all("bg=" in h_ and "company=" in h_ and "cc=" not in h_ for h_ in pills_), pills_)
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("UPDATE users SET cost_center=NULL WHERE id IN (%s)" % ",".join("?" * (len(A_) + 1)), A_ + [BOSS])
        db.commit()
    AJS = H.source(a, "static/admin_talent_box.js")
    AJS = re.sub(r"(?m)\s//[^\n]*$", "", re.sub(r"/\*.*?\*/", "", AJS, flags=re.S))   # the code, not its comments
    s.check("the admin script is read only and runs the BG CEO's own shared code: the Filter line, the curve rows and the curve dialog come from OneHRCalib; "
            "a pick reloads the page with repeated params; no network call, no Move, no Lock, no insight",
            "CAL.flLine(" in AJS and "CAL.calibDistBox(" in AJS and "CAL.curveDialog(" in AJS and "CAL.chipFromServer" in AJS
            and "q.delete(key); vals.forEach(function (v) { q.append(key, v); });" in AJS
            # Talent Box Round 2 (2026-11-15): the one place this card writes is the super admin's admin Round 2, behind D.r2.editable (ED); every
            # network call and the Move button sit in that block, and a row draws its Move only `if (ED)`
            and not any(x in AJS for x in ("new XMLHttpRequest", "Lock Talent", "tbMove", "insight"))
            and "fetch(" not in AJS.split("function limState(")[0] and "rv-tbox-mvbtn" not in AJS.split("function limState(")[0]
            and "if (ED) acts.appendChild(moveBtn(p))" in AJS and "ED = !!(R && R.editable)" in AJS, "")
    s.check("falsified: the chat's closure is not what draws it (no talentBoxWidget / stageCard in the admin script)", "talentBoxWidget" not in AJS and "stageCard" not in AJS)
finally:
    with a.app.test_request_context("/"):   # put the shared suite database back as this suite found it
        db = a.get_db()
        _cleanup(db)
        for k, v in _ORIG["modules"].items():
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, CID, k))
        db.commit()
sys.exit(s.done())
