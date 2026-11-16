"""What you led, and the calibration step on the timeline (Chris, 2026-10-12; the "OneHR Release, What You Led and
Agents" canvas, boards W1-W5 and T1-T2).

The panel lists the people a leader is over, one tab per seat (direct reports, an HOD's department, a BU CEO's unit, a
BG CEO's group). Each row shows what release 1 lets the leader read: their bands up to the leader's own step and "In
calibration" before it, the talent status and final bands after it; the BG CEO, who decides them, at once. Opening a
row shows both bands' movement with each tier's reason. The timeline gains a Calibration step before Results released,
and a leader's release step says it reaches them before their people. Everything here is synthetic (ZZLP-*).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("What you led -- the leader's people, cut at their own step until release 1; the timeline's calibration step")

BG, CO, CO2 = "ZZLP BG", "ZZLP CO", "ZZLP CO2"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZLP-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        for t in ("result_releases", "talent_releases", "report_releases", "leader_releases", "rating_records"):
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (t, ph), ids)
        db.execute("DELETE FROM activity_log WHERE target_user_id IN (%s)" % ph, ids)
    for t in ("pm_calibration_sessions", "calibration_sessions"):
        db.execute("DELETE FROM %s WHERE business_group=?" % t, (BG,))
    if ids:
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    # the BU CEO's and BG CEO's tiers run at Year-End only (Mid-Year is Self, LM and HOD, 2026-10-12)
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.commit()
    _cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(emp_id, name, **kw):
        v = dict(base, username=emp_id.lower(), employee_id=emp_id, full_name=name, email=None, hod_id=None,
                 manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO,
                 department="ZZLP Dept", confirmation_date="2020-01-01", left_at=None, is_demo=0, role="user")
        v.update(kw)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (emp_id,)).fetchone()[0]

    BGCEO = mk("ZZLP-BGCEO", "ZZ Led BG CEO", bgceo_bg=BG, company="")
    BUCEO = mk("ZZLP-BUCEO", "ZZ Led BU CEO", buceo_bg=BG, buceo_company=CO, manager_id=BGCEO)
    HOD = mk("ZZLP-HOD", "ZZ Led HOD", manager_id=BUCEO)
    LM = mk("ZZLP-LM", "ZZ Led Line Manager", hod_id=HOD, manager_id=HOD)
    E1 = mk("ZZLP-E1", "ZZ Led Person One", hod_id=HOD, manager_id=LM)
    E2 = mk("ZZLP-E2", "ZZ Led Person Two", hod_id=HOD, manager_id=LM)
    E3 = mk("ZZLP-E3", "ZZ Led Person Three", company=CO2, department="ZZLP Other", manager_id=BGCEO)
    E4 = mk("ZZLP-E4", "ZZ Led Person Four", hod_id=HOD, manager_id=LM)   # a potential band only, no performance
    PLAIN = mk("ZZLP-PLAIN", "ZZ Led Plain", hod_id=HOD, manager_id=LM, business_group="ZZLP OTHER BG", company="X")
    STRANGER = mk("ZZLP-OTHER", "ZZ Led Stranger", business_group="ZZLP OTHER BG", company="ZZLP OTHER CO")
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]

    def sess(table, tier, key, moves):
        db.execute("INSERT INTO %s(cycle_id, tier, scope_key, business_group, scope_label, locked_at) "
                   "VALUES (?,?,?,?,?,datetime('now'))" % table, (CID, tier, key, BG, "ZZLP"))
        sid = db.execute("SELECT id FROM %s WHERE cycle_id=? AND tier=? AND scope_key=?" % table,
                         (CID, tier, key)).fetchone()[0]
        adj = table.replace("sessions", "adjustments")
        for subj, (orig, band, why) in moves.items():
            db.execute("INSERT INTO %s(session_id, subject_id, original_band, adjusted_band, justification) "
                       "VALUES (?,?,?,?,?)" % adj, (sid, subj, orig, band, why))

    # performance: the HOD sets E1 AE and E2 ME; the BU CEO moves E1 to ME; the BG CEO locks (final)
    sess("pm_calibration_sessions", "hod", str(HOD), {E1: ("", "AE", "ZZLP hod"), E2: ("", "ME", "ZZLP hod 2")})
    sess("pm_calibration_sessions", "buceo", CO, {E1: ("AE", "ME", "ZZLP bu ceo reason")})
    sess("pm_calibration_sessions", "bgceo", BG, {E3: ("", "OU", "ZZLP bg ceo set")})
    sess("calibration_sessions", "hod", str(HOD), {E1: ("", "High", "ZZLP pot"), E2: ("", "Mid", "ZZLP pot 2"),
                                                   E4: ("", "Mid", "ZZLP pot 4")})
    sess("calibration_sessions", "buceo", CO, {})
    sess("calibration_sessions", "bgceo", BG, {E3: ("", "High", "ZZLP bg pot")})
    db.commit()
    a._rating_record_refresh(db, CID, [E1, E2, E3, E4], "test", commit=True)
    # the line manager's own step: the approved rating, as a stored record carries it
    db.execute("UPDATE rating_records SET pm_self_band='OU', pm_mgr_band='AE', pot_self_band='High', pot_raw_band='High' "
               "WHERE cycle_id=? AND subject_id=?", (CID, E1))
    db.commit()


def ctx(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        return fn(d)


def u(uid):
    return ctx(lambda d: dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


def led(c, **q):
    qs = "&".join("%s=%s" % kv for kv in q.items())
    r = c.get("/me/led" + ("?" + qs if qs else ""))
    return r.status_code, (r.get_json() if r.status_code == 200 else None)


def person(rows, pid):
    return next((p for p in rows["people"] if p["id"] == pid), None)


try:
    # -----------------------------------------------------------------------
    s.section("the tabs: one per seat, narrowest first")
    tabs = ctx(lambda d: {k: [t["key"] for t in a._led_tabs(d, u(v))]
                          for k, v in (("lm", LM), ("hod", HOD), ("buceo", BUCEO), ("bgceo", BGCEO), ("emp", E1))})
    s.check("line manager: direct reports; HOD: direct + department; BU CEO: direct + unit; BG CEO: direct + group; "
            "someone who leads nobody: none",
            tabs == {"lm": ["direct"], "hod": ["direct", "dept"], "buceo": ["direct", "bu"],
                     "bgceo": ["direct", "bg"], "emp": []}, tabs)

    # -----------------------------------------------------------------------
    s.section("before release 1: the line manager reads up to their own step")
    lm_c = H.client_as(a, LM)
    code, d = led(lm_c)
    s.check("the line manager's list opens on their widest tab (direct reports), for the active cycle",
            code == 200 and d["tab"] == "direct" and d["cycle"] == CID, code)
    p1 = person(d, E1) if d else None
    s.check("E1 shows the line manager's own band (AE), no talent status, not full, 'In calibration'",
            p1 and p1["pm"] == "AE" and p1["pot"] == "High" and p1["talent"] is None and not p1["full"]
            and p1["rel"] == "In calibration", p1)
    s.check("...and the list says it's before release 1", d and d["state"] == "before" and not d["at_once"],
            d and d["state"])
    s.check("someone in another group the line manager manages still lists (they lead them)",
            person(d, PLAIN) is not None)
    r = lm_c.get("/me/led/%d?cycle=%d" % (E1, CID))
    x = r.get_json() if r.status_code == 200 else None
    pm = next((ax for ax in x["axes"] if ax["kind"] == "pm"), None) if x else None
    s.check("opening E1: the steps after the line manager's are hidden, no final band",
            pm and [st["state"] for st in pm["steps"]][:2] == ["set", "moved"]
            and all(st["state"] == "hidden" for st in pm["steps"][2:]) and pm["final"] is None and not pm["full"], pm)
    s.check("...the line manager's own step is marked as theirs, and the move down says so",
            pm and pm["steps"][1]["you"] and pm["steps"][1]["dir"] == "down", pm and pm["steps"][1])

    # -----------------------------------------------------------------------
    s.section("the BG CEO, who decides them, reads everything at once")
    bg_c = H.client_as(a, BGCEO)
    code, d = led(bg_c)
    s.check("the BG CEO's list opens on the group, says they decided it, with the business unit row",
            code == 200 and d["tab"] == "bg" and d["at_once"] and d["filter"] and d["filter"]["key"] == "company"
            and {i["v"] for i in d["filter"]["items"]} == {CO, CO2}, d and (d["tab"], d["filter"]))
    p3 = person(d, E3) if d else None
    s.check("E3 (set OU / High by the BG CEO) shows the final bands and a talent status",
            p3 and p3["full"] and p3["pm"] == "OU" and p3["pot"] == "High" and p3["talent"], p3)
    s.check("...and says it isn't released to them yet", p3 and p3["rel"] == "Not released yet", p3 and p3["rel"])
    r = bg_c.get("/me/led/%d?cycle=%d" % (E1, CID))
    x = r.get_json()
    pm = next(ax for ax in x["axes"] if ax["kind"] == "pm")
    bu = next((st for st in pm["steps"] if st["step"] == "buceo"), None)
    s.check("opening E1: the whole chain, the BU CEO's move with its reason, the final band",
            pm["full"] and pm["final"] == "ME" and bu and bu["state"] == "moved" and bu["why"] == "ZZLP bu ceo reason",
            pm)

    # -----------------------------------------------------------------------
    s.section("the BU CEO's unit tab has the department row")
    bu_c = H.client_as(a, BUCEO)
    code, d = led(bu_c)
    s.check("the BU CEO's list opens on the unit, with a department row",
            code == 200 and d["tab"] == "bu" and d["filter"] and d["filter"]["key"] == "department", d and d["tab"])
    s.check("...and before release 1 nobody's final shows", d and not any(p["full"] for p in d["people"]))

    # -----------------------------------------------------------------------
    s.section("release 1 opens the whole movement to the line manager, HOD and BU CEO")
    sup = H.client_as(a, SUP)
    sup.post("/admin/talent-release", data={"csrf_token": "tok", "period": CID, "bg": BG, "result": "three",
                                            "action": "release", "to": "leaders", "ids": [E1]})
    code, d = led(lm_c)
    p1 = person(d, E1)
    s.check("the line manager now reads E1's final bands and talent status, 'With you since'",
            p1 and p1["full"] and p1["pm"] == "ME" and p1["talent"] and p1["rel"].startswith("With you since"), p1)
    s.check("...while E2 (not released) is still cut at their step", not person(d, E2)["full"])
    s.check("...so the list reads 'mixed', counting only people with a result (PLAIN has none)",
            d["state"] == "mixed" and d["n_res"] == sum(1 for p_ in d["people"] if not p_["none"]) < len(d["people"]),
            (d["state"], d.get("n_res"), len(d["people"])))
    sup.post("/admin/talent-release", data={"csrf_token": "tok", "period": CID, "bg": BG, "result": "three",
                                            "action": "release", "to": "leaders", "ids": [E4]})
    p4 = person(led(lm_c)[1], E4)
    s.check("someone with a potential band and no performance result: release 1 sends what exists, and the row reads "
            "released (performance '—', not 'in calibration')",
            p4 and p4["full"] and p4["pm"] is None and p4["pot"] == "Mid" and p4["rel"].startswith("With you since"), p4)
    x4 = lm_c.get("/me/led/%d?cycle=%d" % (E4, CID)).get_json()
    pm4 = next(ax for ax in x4["axes"] if ax["kind"] == "pm")
    s.check("...and opening them shows performance as it stands (no 'in calibration' steps, no final band)",
            not any(st["state"] == "hidden" for st in pm4["steps"]) and pm4["final"] is None, pm4)
    x = lm_c.get("/me/led/%d?cycle=%d" % (E1, CID)).get_json()
    pm = next(ax for ax in x["axes"] if ax["kind"] == "pm")
    s.check("opening E1 now shows every step and the final band", pm["full"] and pm["final"] == "ME"
            and not any(st["state"] == "hidden" for st in pm["steps"]), pm)

    # -----------------------------------------------------------------------
    s.section("who can't read it")
    s.check("a stranger can't open someone they don't lead",
            H.client_as(a, STRANGER).get("/me/led/%d?cycle=%d" % (E1, CID)).status_code == 404)
    s.check("the person can't open their own movement", H.client_as(a, E1).get("/me/led/%d" % E1).status_code == 404)
    s.check("someone who leads nobody has no list", H.client_as(a, E3).get("/me/led").status_code == 404)
    s.check("an admin has no list", sup.get("/me/led").status_code == 404)
    s.check("a tab they don't hold falls back to their own", led(lm_c, tab="bg")[1]["tab"] == "direct")
    eps = {r_.endpoint for r_ in a.app.url_map.iter_rules()}
    s.check("both routes exist and sit with the person's own record (no module gate)",
            {"my_led", "my_led_person"} <= eps and {"my_led", "my_led_person"} <= a.MODULE_UNGATED_ENDPOINTS)

    # -----------------------------------------------------------------------
    s.section("the rating record carries a potential band a calibrator set with no 360 (as performance does)")
    rec3 = ctx(lambda d: a._rating_record_row(d, CID, u(E3)))
    s.check("E3's potential, set High by the BG CEO with no 360 score, is in the record as final",
            rec3["pot_final_band"] == "High" and rec3["pot_bgceo_band"] == "High" and rec3["pot_final_source"] == "bgceo",
            {k: rec3.get(k) for k in ("pot_final_band", "pot_bgceo_band", "pot_final_source", "pot_raw_band")})

    s.section("the timeline: Calibration, then Results released")
    ctx(lambda d: (d.execute("UPDATE pm_calibration_sessions SET locked_at=NULL WHERE business_group=? AND tier='bgceo'",
                             (BG,)), d.commit()))
    st_ = ctx(lambda d: a._dash_rail_results(d, u(E2), CID, True, []))
    ctx(lambda d: (d.execute("UPDATE pm_calibration_sessions SET locked_at=datetime('now') WHERE business_group=? "
                             "AND tier='bgceo'", (BG,)), d.commit()))
    s.check("an employee: Calibration (in progress -- the BG CEO hasn't locked) then Results released (not yet)",
            [x_["name"] for x_ in st_] == ["Calibration", "Results released"]
            and st_[0]["state"] == "progress" and st_[1]["state"] == "later" and st_[0]["who"] == "Your results", st_)
    s.check("...naming no band and no tier",
            not any(w in (st_[0]["line"] + st_[1]["line"]) for w in ("ME", "AE", "HOD", "BU CEO", "BG CEO")), st_)
    st3 = ctx(lambda d: a._dash_rail_results(d, u(E3), CID, True, []))
    s.check("someone the BG CEO decided: Calibration done, the release step is where they are",
            st3[0]["state"] == "done" and st3[1].get("here") and st3[1]["state"] == "later", st3)
    stl = ctx(lambda d: a._dash_rail_results(d, u(LM), CID, True, a._led_tabs(d, u(LM))))
    s.check("the line manager after release 1: 'To you', not yet to their team, with See your people",
            stl[1]["word"].startswith("To you") and "your team: not yet" in stl[1]["line"]
            and stl[1].get("act", {}).get("panel") == "led" and stl[0]["who"] == "You and your team", stl)
    steps = ctx(lambda d: a.dash_journey_done(d, u(E3), CID))
    names = [x_["name"] for x_ in steps]
    s.check("the history view's journey has Calibration just before Results released",
            "Calibration" in names and names.index("Calibration") == names.index("Results released") - 1, names)

    # -----------------------------------------------------------------------
    s.section("the page")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    js = open(os.path.join(root, "static", "dashboard.js")).read()
    s.check("the dashboard panel has the What you led view: /me/led, a row per person, the movement on opening",
            "function loadLed(" in js and '"/me/led"' in js and '"/me/led/" + p.id' in js and "is-wide" in js
            and 'kind === "led"' in js)
    tpl = open(os.path.join(root, "templates", "dashboard.html")).read()
    s.check("the timeline draws the in-progress step and its See your people button",
            "state == 'progress'" in tpl and "s.get('act')" in tpl and "s['act']['panel']" in tpl)
    s.check("the What you led card opens the panel", 'data-panel="led"' in tpl and "See your people" in tpl)
finally:
    ctx(lambda d: _cleanup(d))
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
        db.commit()

sys.exit(s.done())
