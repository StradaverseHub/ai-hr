"""A Group Chief's dashboard -- the BG CEO's, for the calibration group they call.

Chris, 2026-10-14, on the demo Group Chief's dashboard: "why the group chief view only with the talent box calibration?
What about the team review? result release? and 360 feedback", then "to confirm, if the history will show the talent box
display like the BGCEO view?". A Group Chief is like the BG CEO (2026-10-13): no review of their own. So, as for the BG
CEO: the rail ends with Results released (no Calibration step -- their Talent Box decides it); "Where your group is"
replaces Where you stand, batch by batch; between cycles the history is their group's Talent Box, everyone then each
batch, with "Cycles you led"; What you led's panel has a tab for the group, filtered by batch. And a Group Chief with
direct reports gets the Team review, and one who rates colleagues gets the 360 -- the same code as everyone else.

Synthetic (ZZGD-*) on the shared suite database; everything is put back at the end.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Group Chief dashboard -- where the group is, results released, the history Talent Box, team and 360")
_real_avail = a.ai_draft.review_agent_available
a.ai_draft.review_agent_available = lambda: True
BG1, BG2 = "ZZGD Alpha Group", "ZZGD Beta Group"
CO1, CO2 = BG1 + " Sdn Bhd", BG2 + " Sdn Bhd"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZGD-%'")]
    gids = [r[0] for r in db.execute("SELECT id FROM pm_calibration_groups WHERE name LIKE 'ZZGD%'")]
    cyc = [r[0] for r in db.execute("SELECT id FROM cycles WHERE code LIKE 'ZZGD-%'")]
    if gids:
        ph = ",".join("?" * len(gids))
        db.execute("DELETE FROM pm_group_locks WHERE group_id IN (%s)" % ph, gids)
        db.execute("DELETE FROM pot_group_locks WHERE group_id IN (%s)" % ph, gids)
        db.execute("DELETE FROM pm_calibration_sessions WHERE tier='group' AND scope_key IN (%s)" % ph,
                   [str(g_) for g_ in gids])
        db.execute("DELETE FROM calibration_sessions WHERE tier='group' AND scope_key IN (%s)" % ph,
                   [str(g_) for g_ in gids])
        db.execute("DELETE FROM pm_calibration_group_members WHERE group_id IN (%s)" % ph, gids)
        db.execute("DELETE FROM pm_calibration_groups WHERE id IN (%s)" % ph, gids)
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM result_releases WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        for t in ("pm_kpi_approvals", "pm_kpi_results", "pm_kpi_target_approvers"):
            db.execute("DELETE FROM %s WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s))"
                       % (t, ph), ids)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    if cyc:
        ph = ",".join("?" * len(cyc))
        db.execute("DELETE FROM rating_records WHERE cycle_id IN (%s)" % ph, cyc)
        db.execute("DELETE FROM cycles WHERE id IN (%s)" % ph, cyc)
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?)", (BG1, BG2))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG1, BG2))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CID = a.active_cycle_id(db)
    PID = a.active_pm_period(db)["id"]
    _cleanup(db)
    _ORIG = {"half": db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0],
             "modules": {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=? "
                                                         "AND module_key IN ('review','calibration','pm','tm')",
                                                         (CID,))}}
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm')",
               (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, bg, co, dept, mgr=None, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=mgr,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=bg, company=co, department=dept,
                 years_of_service=3, confirmation_date=None, left_at=None, is_demo=0, role="user", admin_bg=None)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    CHIEF = mk("ZZGD-GC", "ZZ GD Groupchief", BG1, "", "Group Office")
    LM = mk("ZZGD-LM", "ZZ GD Manager", BG1, CO1, "Office")
    A1 = mk("ZZGD-A1", "ZZ GD Alpha One", BG1, CO1, "Quality", mgr=LM)
    A2 = mk("ZZGD-A2", "ZZ GD Alpha Two", BG1, CO1, "Quality", mgr=LM)
    B1 = mk("ZZGD-B1", "ZZ GD Beta One", BG2, CO2, "Assurance", mgr=LM)
    NF = mk("ZZGD-N1", "ZZ GD Not Final", BG2, CO2, "Assurance", mgr=LM)
    REP = mk("ZZGD-R1", "ZZ GD Direct Report", BG1, CO1, "Group Office", mgr=CHIEF)
    BGCEO = mk("ZZGD-BG", "ZZ GD Bgceo", BG1, CO1, "Office", bgceo_bg=BG1)
    EMP = mk("ZZGD-E1", "ZZ GD Plain", BG1, CO1, "Office", mgr=LM)
    for bg, co in ((BG1, CO1), (BG2, CO2)):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (bg, co))
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (bg,))

    def kpi(sid, val, approver, final):
        u_ = db.execute("SELECT business_group, company FROM users WHERE id=?", (sid,)).fetchone()
        t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, "
                       "rate3, rate4, rate5, business_group, company, department, status) VALUES (?,?, 'ZZGD KPI', 100, "
                       "'more', 80,90,100,110,120, ?,?, 'x', 'approved')", (PID, sid, u_[0], u_[1])).lastrowid
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t, approver))
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)",
                   (t, val, sid))
        if final:
            db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) VALUES "
                       "(?,1,'confirm',?,?)", (t, val, approver))
    for sid, val, final in ((A1, 100, True), (A2, 112, True), (B1, 121, True), (NF, 100, False)):
        kpi(sid, val, LM, final)
    kpi(REP, 105, CHIEF, False)   # their direct report's results, waiting on the Group Chief to moderate
    GID = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZGD Group Quality', ?)",
                     (CHIEF,)).lastrowid
    for sid, seg in ((A1, "Quality Ops"), (A2, "Quality Ops"), (B1, None), (NF, None)):
        db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id, segment) VALUES (?,?,?)",
                   (GID, sid, seg))
    db.commit()
    gc = db.execute("SELECT * FROM users WHERE id=?", (CHIEF,)).fetchone()

    # --- What you led's tabs: the group ---------------------------------------------------------------------------
    tabs = a._led_tabs(db, gc)
    gt = next((t for t in tabs if t["key"] == "group"), None)
    s.check("a Group Chief's people have a tab: their calibration group, named", bool(gt)
            and gt["label"] == "ZZGD Group Quality" and gt["n"] == 4, tabs)
    s.check("...and their direct reports a tab of their own", any(t["key"] == "direct" and t["n"] == 1 for t in tabs))
    s.check("batches: the name the super admin gave it, else the department",
            a._gc_batches(db, [GID]) == {A1: "Quality Ops", A2: "Quality Ops", B1: "Assurance", NF: "Assurance"},
            a._gc_batches(db, [GID]))
    bgu = db.execute("SELECT * FROM users WHERE id=?", (BGCEO,)).fetchone()
    s.check("a BG CEO's tabs are unchanged (business group last, no group tab)",
            [t["key"] for t in a._led_tabs(db, bgu)][-1:] == ["bg"]
            and not any(t["key"] == "group" for t in a._led_tabs(db, bgu)))
    emp = db.execute("SELECT * FROM users WHERE id=?", (EMP,)).fetchone()
    s.check("someone who calls no group has no group tab", not any(t["key"] == "group" for t in a._led_tabs(db, emp)))

with a.app.test_request_context("/dashboard"):
    db = a.get_db()
    gc = db.execute("SELECT * FROM users WHERE id=?", (CHIEF,)).fetchone()
    ctx = a._dash_context(db, gc)
    s.check("the running dashboard", ctx["mode"] == "running", ctx["mode"])
    steps = (ctx["rail"] or {}).get("steps") or []
    names = [(x["who"], x["name"]) for x in steps]
    s.check("the rail: their Talent Box", ("You lead", "Talent Box") in names, names)
    s.check("the rail ends with Results released, from Group People", names[-1:] == [("Group People", "Results released")], names)
    rel = steps[-1] if steps else {}
    s.check("...said as the BG CEO's: after their Talent Box", "after your Talent Box" in (rel.get("line") or ""), rel)
    s.check("no Calibration step: their Talent Box decides it", ("All results", "Calibration") not in names
            and not any(n == "Calibration" for _w, n in names), names)
    s.check("the rail: a Group Chief with a direct report gets the Team review", ("Your team", "Team review") in names,
            names)
    s.check("...and the team card", bool(ctx["team"]))
    G = ctx["bg_status"]
    s.check("Where your group is replaces Where you stand", bool(G) and G["scope"] == "group"
            and G["name"] == "ZZGD Group Quality", G)
    by = {x["name"]: x for x in (G or {}).get("units") or []}
    s.check("one row per batch", set(by) == {"Quality Ops", "Assurance"}, list(by))
    s.check("a batch with every rating final is ready to lock", by.get("Quality Ops", {}).get("state") == "ready",
            by.get("Quality Ops"))
    s.check("a batch with a rating not final is calibrating, with how many are in",
            by.get("Assurance", {}).get("state") == "busy" and "1 of 2 ratings final" in by["Assurance"]["sub"],
            by.get("Assurance"))
    s.check("...the counts", G and G["ready"] == 1 and G["total"] == 2 and G["locked"] == 0, G)
    html = a.render_template("dashboard.html", **dict(ctx, ask={"available": False, "suggestions": [], "first_name": "",
                                                               "cycle": None}))
    s.check("rendered: Where your group is, by batch", "Where your group is" in html and "Quality Ops" in html
            and "Batch &middot; ratings" in html)
    s.check("rendered: no Where you stand", "Where you stand" not in html)
    s.check("rendered: Results released on the rail", "Results released" in html)

with a.app.test_request_context("/"):
    db = a.get_db()
    # a lock on the batch: the Group Chief's calls on both of Quality Ops, one by one
    for sid, band in ((A1, "ME"), (A2, "AE")):
        db.execute("INSERT INTO pm_group_locks(cycle_id, group_id, subject_id, band, locked_by) VALUES (?,?,?,?,?)",
                   (PID, GID, sid, band, CHIEF))
    db.commit()
with a.app.test_request_context("/dashboard"):
    db = a.get_db()
    gc = db.execute("SELECT * FROM users WHERE id=?", (CHIEF,)).fetchone()
    G = a.dash_group_status(db, gc, a.active_cycle(db))
    qo = next((x for x in G["units"] if x["name"] == "Quality Ops"), {})
    s.check("a batch whose calls are all locked reads locked", qo.get("state") == "locked"
            and qo["word"].startswith("Locked"), qo)
    s.check("a BG CEO keeps their own card (no group card for them)",
            a.dash_group_status(db, db.execute("SELECT * FROM users WHERE id=?", (BGCEO,)).fetchone(),
                                a.active_cycle(db)) is None)
    s.check("someone who calls no group: no group card",
            a.dash_group_status(db, db.execute("SELECT * FROM users WHERE id=?", (EMP,)).fetchone(),
                                a.active_cycle(db)) is None)

# --- 360: a Group Chief who rates a colleague has the 360 ----------------------------------------------------------
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) VALUES "
               "(?,?,?, 'line_manager', 'pending')", (CID, REP, CHIEF))
    db.commit()
with a.app.test_request_context("/dashboard"):
    db = a.get_db()
    gc = db.execute("SELECT * FROM users WHERE id=?", (CHIEF,)).fetchone()
    ctx = a._dash_context(db, gc)
    parts = [p["key"] for m_ in (ctx["panel"] or {}).get("modules") or [] for p in m_["parts"]]
    s.check("a Group Chief who rates a colleague gets the 360 (and only it of their own)", parts == ["feedback"], parts)
    names = [(x["who"], x["name"]) for x in (ctx["rail"] or {}).get("steps") or []]
    s.check("...on the rail, first", names[:1] and names[0][0] == "You", names)
    s.check("...and the Mine view for it", "mine" in a._journey_views(db, gc), a._journey_views(db, gc))

# --- between cycles: the history is their group's Talent Box ------------------------------------------------------
with a.app.test_request_context("/"):
    db = a.get_db()
    YE = db.execute("INSERT INTO cycles(code, name, ends_on, is_active, year, half) VALUES "
                    "('ZZGD-YE', 'ZZGD 2001 Year-End', '2001-12-31', 0, 2001, 2)").lastrowid
    MY = db.execute("INSERT INTO cycles(code, name, ends_on, is_active, year, half) VALUES "
                    "('ZZGD-MY', 'ZZGD 2001 Mid-Year', '2001-06-30', 0, 2001, 1)").lastrowid
    for cyc_, rows in ((YE, ((A1, "BE", "Low"), (A2, "ME", "Mid"), (B1, "OU", "High"))),
                       (MY, ((A1, "ME", "Mid"), (A2, "ME", "Mid"), (B1, "AE", "High")))):
        for sid, pm_, pot_ in rows:
            x = db.execute("SELECT * FROM users WHERE id=?", (sid,)).fetchone()
            db.execute("INSERT INTO rating_records(cycle_id, subject_id, employee_id, full_name, business_group, company, "
                       "department, pm_final_band, pm_final_source, pm_hod_band, pot_final_band, pot_final_source, "
                       "pot_hod_band) VALUES (?,?,?,?,?,?,?,?, 'hod', ?, ?, 'hod', ?)",
                       (cyc_, sid, x["employee_id"], x["full_name"], x["business_group"], x["company"],
                        x["department"], pm_, pm_, pot_, pot_))
    # the Group Chief locked their call on A1 in that Year-End: BE -> ME (the box is as they locked it)
    db.execute("INSERT INTO pm_group_locks(cycle_id, group_id, subject_id, band, locked_by, locked_at) VALUES "
               "(?,?,?, 'ME', ?, '2001-12-20 04:00:00')", (YE, GID, A1, CHIEF))
    db.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, locked_at) "
               "VALUES (?, 'group', ?, ?, 'ZZGD Group Quality', '2001-12-21 04:00:00')", (YE, str(GID), BG1))
    db.commit()
with a.app.test_request_context("/dashboard"):
    db = a.get_db()
    gc = db.execute("SELECT * FROM users WHERE id=?", (CHIEF,)).fetchone()
    X = a.dash_group_box(db, gc, YE)
    s.check("the history Talent Box: their group's, everyone then each batch", bool(X) and X["scope"] == "group"
            and [x["name"] for x in X["units"]] == ["Everyone", "Assurance", "Quality Ops"], X and X["units"])
    allu = X["units"][0] if X else {}
    s.check("everyone placed", allu.get("people") == 3, allu)
    # rows run potential High, Mid, Low; columns performance Low (UA, BE), Mid (ME), High (AE, OU)
    s.check("the box as they locked it: A1's locked call (ME, Low: Solid Core) over the record's BE (PIP)",
            allu and allu["rows"][2]["cells"][1]["n"] == 1 and allu["rows"][2]["cells"][0]["n"] == 0
            and allu["rows"][0]["cells"][2]["n"] == 1 and allu["rows"][1]["cells"][1]["n"] == 1, allu and allu["rows"])
    s.check("locked: the whole group's lock", allu.get("locked") and X["n_locked"] == 2, X)
    XM = a.dash_group_box(db, gc, MY)
    s.check("at Mid-Year: the HOD's final bands, no lock", bool(XM) and XM["mid_year"] and not XM["units"][0]["locked"],
            XM)
    s.check("a BG CEO keeps their own box", a.dash_group_box(db, db.execute("SELECT * FROM users WHERE id=?",
                                                                            (BGCEO,)).fetchone(), YE) is None)
    lc = a.dash_led_cycles(db, gc, {YE, MY})
    s.check("Cycles you led: both, newest first", [c["name"] for c in lc] == ["ZZGD 2001 Year-End", "ZZGD 2001 Mid-Year"],
            lc)
    s.check("...the Year-End with their lock", lc and lc[0]["line"].startswith("Talent Box locked")
            and "3 in the cycle" in lc[0]["line"], lc)
    s.check("...the Mid-Year with the HOD's final bands", len(lc) > 1 and lc[1]["line"].startswith("The HOD's final"),
            lc)
    st = a.dash_journey_done(db, gc, YE)
    s.check("their journey through that Year-End: the Talent Box, locked, then the release",
            [(x["name"], x["word"]) for x in st][:1] == [("Talent Box", "Locked")]
            and st[-1]["name"] == "Results released", st)
    s.check("...not yet to their people -- never 'to you first' (they read it at once)",
            st[-1]["line"] == "to your people", st[-1])
    s.check("...no review of their own in it", not any(x["who"] == "You" and x["name"] in
                                                         ("KPI Check-in", "Competency", "Career Plan") for x in st), st)
    rv = a.dash_record_view(db, gc, [], None, as_of={"upto": {MY}, "next": None})
    s.check("after a Mid-Year with nothing of their own: the record is that cycle (they read it at once)",
            (rv["last"] or {}).get("cycle_id") == MY and rv["box"] and rv["box"]["scope"] == "group", rv["last"])
    s.check("...with See your people (their group and their direct report)", bool(rv["led"])
            and rv["led"]["people"] == 5 and rv["led"]["at_once"], rv["led"])
    rv = a.dash_record_view(db, gc, [], None, as_of={"upto": {YE, MY}, "next": None})
    ctx = a._dash_context(db, gc)
    ctx.update(mode="record", rec=rv, rail=None, bg_status=None, led_cycles=a.dash_led_cycles(db, gc, {YE, MY}),
               ask={"available": False, "suggestions": [], "first_name": "", "cycle": None})
    html = a.render_template("dashboard.html", **ctx)
    s.check("rendered: the group's Talent Box, units on the left", "ZZGD Group Quality" in html
            and "The Talent Box &middot; Everyone" in html and "od-grid is-flip" in html)
    s.check("rendered: a batch to pick, and Cycles you led", "Quality Ops" in html and "Cycles you led" in html)
    s.check("rendered: not the employee's own cards", "Your record starts here" not in html
            and "Your Career Plan" not in html)

# --- the people panel: the group's tab, filtered by batch ---------------------------------------------------------
c = a.app.test_client()
with c.session_transaction() as ss_:
    ss_["user_id"] = CHIEF
r = c.get("/me/led?cycle=%d&tab=group" % YE)
s.check("What you led opens the group's tab", r.status_code == 200, r.status_code)
j = r.get_json() or {}
s.check("...its people", sorted(p_["name"] for p_ in j.get("people", [])) ==
        sorted(["ZZ GD Alpha One", "ZZ GD Alpha Two", "ZZ GD Beta One", "ZZ GD Not Final"]), j.get("people"))
s.check("...filtered by batch", (j.get("filter") or {}).get("key") == "batch"
        and [x["v"] for x in j["filter"]["items"]] == ["Assurance", "Quality Ops"], j.get("filter"))
s.check("...read at once, as the BG CEO reads theirs", j.get("at_once") is True, j.get("at_once"))
r = c.get("/me/led/%d?cycle=%d" % (A1, YE))
s.check("one person's movement opens for the Group Chief", r.status_code == 200, r.status_code)

with a.app.test_request_context("/"):
    db = a.get_db()
    _cleanup(db)
    db.execute("UPDATE cycles SET half=? WHERE id=?", (_ORIG["half"], CID))
    for k, v in _ORIG["modules"].items():
        db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, CID, k))
    db.commit()
a.ai_draft.review_agent_available = _real_avail
sys.exit(s.done())
