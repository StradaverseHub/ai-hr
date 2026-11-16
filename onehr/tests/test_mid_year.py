"""Mid-Year is Self, line manager and HOD (Chris, 2026-10-12: "mid year will only have self, LM, and HOD, we do not
carry out calibration for mid year"; "HOD dept review is not a calibration per se"; release 1 still goes to the "LM,
HOD and BU CEO"). And the Talent Box between cycles: the BG CEO's by business unit, the BU CEO's own ("BUCEO should
also see their BU talent box on their dashboard").

What this suite holds:
  * a Mid-Year cycle (half 1) resolves a band through the HOD only: a BU CEO, BG CEO or Group Chief session on it
    never counts (the staging demo seeded some); a Year-End cycle is unchanged
  * a Mid-Year result is final once the HOD's review is submitted, or at the line manager's band with no HOD
  * the talent status at Mid-Year is placed by the HOD's final bands, and released like Year-End (Chris, 2026-10-12)
  * What you led at Mid-Year: the chain ends at the HOD; the BG CEO reads it at once, as at Year-End; the LM, HOD and
    BU CEO after release 1
  * the timeline at Mid-Year has no Calibration step, nor a BG CEO's at all (their Talent Box decides it), and a BG
    CEO's past journey is the running one's steps
  * the AI+ check-in opens the HOD's Department Review at Mid-Year, never a BU CEO / BG CEO seat
  * the Talent Box: the BG CEO's every unit, the BU CEO's own unit only and only once released to leaders; at
    Mid-Year from the HOD's final bands, with no lock
  * the Ask OneHR icon floats: it moves no card

Self-contained: its own group, two cycles and rows, all deleted at the end; the active cycle's half and the settings
it flips are put back.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Mid-Year is Self, LM and HOD; the Talent Box for the BG CEO and the BU CEO")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
a.ai_draft.review_agent_available = lambda: True      # the leader views need a model reachable

BG, CO, CO2 = "ZZMY Group", "ZZMY Unit", "ZZMY Unit Two"
_SETTINGS = ("ai_calib", "review_unified")
ids, cyc = {}, {}

with a.app.test_request_context("/"):
    db = a.get_db()
    ACT = db.execute("SELECT id, half FROM cycles WHERE is_active=1").fetchone()
    _ORIG = {"half": ACT["half"], "settings": {k: (r[0] if r else None) for k in _SETTINGS
                                                for r in [db.execute("SELECT value FROM app_settings WHERE key=?",
                                                                     (k,)).fetchone()]},
             "modules": {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?",
                                                        (ACT["id"],))}}


def sql(q, args=()):
    with a.app.test_request_context("/"):
        db_ = a.get_db()
        r = db_.execute(q, args)
        db_.commit()
        return r.lastrowid


def ctx(uid=None):
    rc = a.app.test_request_context("/dashboard")
    rc.push()
    from flask import session as _ss
    if uid:
        _ss["user_id"] = uid
    return rc, a.get_db()


def user(db, uid):
    return dict(db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


try:
    with a.app.test_request_context("/"):
        db = a.get_db()
        NOW = a._today_myt().year
        db.execute("DELETE FROM cycles WHERE code LIKE 'ZZMY-%'")
        cyc["my"] = db.execute("INSERT INTO cycles(code, name, is_active, year, half, ends_on) VALUES "
                               "('ZZMY-MY', 'ZZMY Mid-Year', 0, ?, 1, ?)", (NOW - 5, "%d-06-30" % (NOW - 5))).lastrowid
        cyc["ye"] = db.execute("INSERT INTO cycles(code, name, is_active, year, half, ends_on) VALUES "
                               "('ZZMY-YE', 'ZZMY Year-End', 0, ?, 2, ?)", (NOW - 5, "%d-12-31" % (NOW - 5))).lastrowid
        cyc["nohalf"] = db.execute("INSERT INTO cycles(code, name, is_active, year, half) VALUES "
                                   "('ZZMY-NH', 'ZZMY No Half', 0, ?, NULL)", (NOW - 5,)).lastrowid
        base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 "
                               "LIMIT 1").fetchone())
        cols = [c for c in base.keys() if c != "id"]

        def person(eid, **over):
            v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ MY " + eid, email=None, hod_id=None,
                     manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO,
                     left_at=None, is_demo=0, role="user", demo_persona=None, demo_switcher=0)
            v.update(over)
            db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                       [v[c] for c in cols])
            return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
        ids["bgceo"] = person("ZZMY-BG", bgceo_bg=BG, company="")
        ids["buceo"] = person("ZZMY-BU", buceo_bg=BG, buceo_company=CO, manager_id=ids["bgceo"])
        # the BU CEO reports to the BG CEO and has a KPI in the Year-End: the BG CEO's team review that cycle
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, "
                   "company) VALUES (?,?,?,?,?,?,?)", (cyc["ye"], ids["buceo"], "ZZMY BU KPI", 100, "more", BG, CO))
        ids["hod"] = person("ZZMY-HOD", manager_id=ids["buceo"])
        ids["lm"] = person("ZZMY-LM", manager_id=ids["hod"], hod_id=ids["hod"])
        ids["e1"] = person("ZZMY-E1", manager_id=ids["lm"], hod_id=ids["hod"])
        ids["e2"] = person("ZZMY-E2", manager_id=ids["lm"])                        # no HOD
        ids["o1"] = person("ZZMY-O1", company=CO2)                                 # another unit
        # a scorecard for each, in the active period, so the HOD has a department to review
        for k in ("lm", "e1"):
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, "
                       "company) VALUES (?,?,?,?,?,?,?)", (ACT["id"], ids[k], "ZZMY KPI", 100, "more", BG, CO))
        # every tier moved E1, on both cycles: HOD ME->AE, BU CEO ->OU, BG CEO ->BE (potential: HOD Mid, BU CEO High)
        for c in (cyc["my"], cyc["ye"]):
            for tier, key, pmb, potb in (("hod", str(ids["hod"]), "AE", "Mid"), ("buceo", CO, "OU", "High"),
                                         ("bgceo", BG, "BE", "Low")):
                for st_, at_, b in (("pm_calibration_sessions", "pm_calibration_adjustments", pmb),
                                    ("calibration_sessions", "calibration_adjustments", potb)):
                    sid_ = db.execute("INSERT INTO %s(cycle_id, tier, scope_key, business_group, scope_label, locked_at) "
                                      "VALUES (?,?,?,?,?,datetime('now'))" % st_, (c, tier, key, BG, "ZZMY")).lastrowid
                    db.execute("INSERT INTO %s(session_id, subject_id, original_band, adjusted_band, justification) "
                               "VALUES (?,?,?,?,?)" % at_, (sid_, ids["e1"], "", b, "ZZMY " + tier))
            db.execute("INSERT INTO talent_releases(cycle_id, subject_id) VALUES (?,?)", (c, ids["e1"]))
            # the BG CEO gave a 360 in both, and (old data) checked in on a KPI of their own at Year-End
            db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, submitted_at) "
                       "VALUES (?,?,?,'peer','submitted',datetime('now'))", (c, ids["e1"], ids["bgceo"]))
        t_ = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                        "business_group, company) VALUES (?,?,'ZZMY BG KPI',100,'more','approved',?,'')",
                        (cyc["ye"], ids["bgceo"], BG)).lastrowid
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft, admin_filled, "
                   "submitted_at) VALUES (?,4,?,0,0,datetime('now'))", (t_, ids["bgceo"]))
        db.commit()

    s.section("which cycle is Mid-Year")
    rc, db = ctx()
    try:
        s.check("half 1 is Mid-Year, half 2 isn't, and a cycle with no half isn't either",
                a.cycle_is_mid_year(db, cyc["my"]) and not a.cycle_is_mid_year(db, cyc["ye"])
                and not a.cycle_is_mid_year(db, cyc["nohalf"]) and not a.cycle_is_mid_year(db, None))
    finally:
        rc.pop()

    s.section("a band resolves through the HOD only at Mid-Year")
    rc, db = ctx()
    try:
        e1, e2 = user(db, ids["e1"]), user(db, ids["e2"])
        pm_my, pm_ye = a.pm_effective_band(db, e1, cyc["my"], "ME"), a.pm_effective_band(db, e1, cyc["ye"], "ME")
        s.check("performance: Mid-Year takes the HOD's AE, never the BU CEO's or BG CEO's", (pm_my["band"],
                pm_my["source"]) == ("AE", "hod"), pm_my)
        s.check("...Year-End still takes the BG CEO's", (pm_ye["band"], pm_ye["source"]) == ("BE", "bgceo"), pm_ye)
        pot_my, pot_ye = a.effective_band(db, e1, cyc["my"]), a.effective_band(db, e1, cyc["ye"])
        s.check("potential: Mid-Year takes the HOD's Mid", (pot_my["band"], pot_my["source"]) == ("Mid", "hod"),
                (pot_my.get("band"), pot_my.get("source")))
        s.check("...Year-End the BG CEO's", (pot_ye["band"], pot_ye["source"]) == ("Low", "bgceo"))
        bands, _p = a._rr_tier_bands(db, cyc["my"], e1, "ME", "pm")
        s.check("the record's tiers: the HOD's only at Mid-Year", bands.get("hod") == "AE" and bands.get("buceo") is None
                and bands.get("bgceo") is None, bands)
        f1 = a.final_result(db, e1, cyc["my"], "pm", ov_map={e1["id"]: {"label": "ME"}})
        s.check("final once the HOD's review is in", f1 and f1["final"] and f1["band"] == "AE" and f1["stage"] == "Final",
                f1)
        f2 = a.final_result(db, e2, cyc["my"], "pm", ov_map={e2["id"]: {"label": "ME"}})
        s.check("someone with no HOD: final at their line manager's band", f2 and f2["final"] and f2["band"] == "ME", f2)
    finally:
        rc.pop()
    sql("UPDATE pm_calibration_sessions SET locked_at=NULL WHERE cycle_id=? AND tier='hod'", (cyc["my"],))
    rc, db = ctx()
    try:
        e1 = user(db, ids["e1"])
        f3 = a.final_result(db, e1, cyc["my"], "pm", ov_map={e1["id"]: {"label": "ME"}})
        s.check("HOD review not submitted: not final, and it says so (no BU CEO, no calibration)",
                f3 and not f3["final"] and f3["band"] == "ME" and "HOD review" in f3["stage"]
                and "calibrat" not in f3["stage"].lower(), f3)
    finally:
        rc.pop()
    sql("UPDATE pm_calibration_sessions SET locked_at=datetime('now') WHERE cycle_id=? AND tier='hod'", (cyc["my"],))

    s.section("the talent status at Mid-Year comes from the HOD's final bands")
    rc, db = ctx()
    try:
        e1 = user(db, ids["e1"])
        # a valid 360 is a fixture of its own: hold the potential band and the overall still, and let the half decide
        # which performance band (the HOD's AE at Mid-Year, the BG CEO's BE at Year-End) places them
        _eb, _ov = a.effective_band, a._dash_overall
        a.effective_band = lambda *_x, **_k: {"band": "High", "score_valid": True, "source": "hod"}
        a._dash_overall = lambda *_x, **_k: {"label": "ME", "value": 3.0, "mechanism": "A"}
        try:
            t_my, t_ye = a.talent_status_for(db, e1, cyc["my"]), a.talent_status_for(db, e1, cyc["ye"])
        finally:
            a.effective_band, a._dash_overall = _eb, _ov
        s.check("Mid-Year: placed by the HOD's performance band (AE), never the BG CEO's",
                t_my and t_my["perf"] == "AE" and t_my["name"] == a.talent_category("AE", "High"), t_my)
        s.check("...Year-End: by the BG CEO's (BE)", t_ye and t_ye["perf"] == "BE", t_ye)
        rec = {"pm_self_band": "ME", "pm_mgr_band": "ME", "pm_hod_band": "AE", "pm_buceo_band": "OU",
               "pm_bgceo_band": "BE", "pm_final_band": "BE", "pm_final_source": "bgceo", "pot_raw_band": "Mid",
               "pot_hod_band": "Mid", "pot_buceo_band": "High", "pot_bgceo_band": "Low", "pot_final_band": "Low",
               "pot_final_source": "bgceo", "f360_valid": 1,
               "tiers_json": json.dumps({"pm": {"hod": {"justification": "h"}, "buceo": {"justification": "b"}}})}
        lead = {"pm": {ids["e1"]}, "pot": {ids["e1"]}, "talent": {ids["e1"]}}
        sm = a._led_summary(dict(rec), "buceo", lead, ids["e1"], True)
        s.check("What you led at Mid-Year: the HOD's bands as final, and the talent status they place",
                sm["pm"] == "AE" and sm["pot"] == "Mid" and sm["full"]
                and (sm["talent"] or {}).get("name") == a.talent_category("AE", "Mid"), sm)
        smy = a._led_summary(dict(rec), "buceo", lead, ids["e1"], False)
        s.check("...at Year-End the same record gives the BG CEO's", (smy["talent"] or {}).get("name")
                == a.talent_category("BE", "Low"), smy["talent"])
        n = a._rr_mid_year(rec)
        s.check("a stored record read as Mid-Year: no tier above the HOD, the final re-derived, the reasons cut",
                n["pm_buceo_band"] is None and n["pm_bgceo_band"] is None and n["pm_final_band"] == "AE"
                and n["pm_final_source"] == "hod" and n["pot_final_band"] == "Mid"
                and "buceo" not in json.loads(n["tiers_json"])["pm"], n)
    finally:
        rc.pop()

    s.section("the chain ends at the HOD; the BG CEO reads it at once, the others after release 1")
    ch = a.band_chain(dict(a._rr_mid_year(rec)), "pm", "buceo", False, True)
    s.check("a BU CEO before release 1: Self, LM, HOD, and no final",
            [x["step"] for x in ch["steps"]] == ["self", "lm", "hod"] and ch["final"] is None and not ch["full"], ch)
    ch = a.band_chain(dict(a._rr_mid_year(rec)), "pm", "buceo", True, True)
    s.check("...after release 1: the HOD's band is the final", ch["full"] and ch["final"] == "AE")
    ch = a.band_chain(dict(a._rr_mid_year(rec)), "pm", "bgceo", False, True)
    s.check("a BG CEO at Mid-Year reads it at once, as at Year-End (Chris, 2026-10-12)",
            ch and ch["full"] and ch["final"] == "AE" and [x["step"] for x in ch["steps"]] == ["self", "lm", "hod"])
    ch = a.band_chain(dict(rec), "pm", "bgceo", False, False)
    s.check("...and at Year-End", ch["full"] and ch["final"] == "BE")
    ch = a.band_chain(dict(a._rr_mid_year(rec)), "pm", "lm", False, True)
    s.check("a line manager before release 1 at Mid-Year: up to their own step, the HOD's hidden",
            [x["state"] for x in ch["steps"]][-1] == "hidden" and ch["final"] is None)
    rc, db = ctx()
    try:
        s.check("sees_at_once: an admin and the BG CEO in both halves; never a BU CEO",
                a.sees_at_once(db, "admin", cyc["my"]) and a.sees_at_once(db, "bgceo", cyc["my"])
                and a.sees_at_once(db, "bgceo", cyc["ye"]) and not a.sees_at_once(db, "buceo", cyc["ye"]))
    finally:
        rc.pop()

    s.section("the timelines: no Calibration step at Mid-Year, none for a BG CEO, and the BG CEO's past = running")
    rc, db = ctx(ids["e1"])
    try:
        e1 = user(db, ids["e1"])
        my_steps = [x["name"] for x in a._dash_rail_results(db, e1, cyc["my"], True, [])]
        ye_steps = [x["name"] for x in a._dash_rail_results(db, e1, cyc["ye"], True, [])]
        s.check("no Calibration step at Mid-Year: the HOD's review leads to the release",
                my_steps == ["Results released"] and ye_steps == ["Calibration", "Results released"], (my_steps, ye_steps))
    finally:
        rc.pop()
    rc, db = ctx(ids["bgceo"])
    try:
        bg = user(db, ids["bgceo"])
        tabs = a._led_tabs(db, bg)
        bg_steps = [x["name"] for x in a._dash_rail_results(db, bg, cyc["ye"], False, tabs)]
        s.check("a BG CEO's running timeline has no 'your people: Calibration' step: their Talent Box decides it",
                bg_steps == ["Results released"], bg_steps)
        s.check("a Year-End their group has no results in shows no Talent Box step (so it never becomes their record)",
                "Talent Box" not in [x["name"] for x in a.dash_journey_done(db, bg, cyc["ye"])])
    finally:
        rc.pop()
    # a stored record for the group (no bands, so the box below doesn't count it): the group had results that cycle
    for c in (cyc["my"], cyc["ye"]):
        sql("INSERT INTO rating_records(cycle_id, subject_id, employee_id, business_group, company, last_event) "
            "VALUES (?,?,?,?,?,'zzmy')", (c, ids["hod"], "ZZMY-HOD", BG, CO))
    rc, db = ctx(ids["bgceo"])
    try:
        bg = user(db, ids["bgceo"])
        my_j = [x["name"] for x in a.dash_journey_done(db, bg, cyc["my"])]
        ye_j = [x["name"] for x in a.dash_journey_done(db, bg, cyc["ye"])]
        s.check("a BG CEO's past Year-End: the running timeline's steps (the 360 they gave, their team -- a direct "
                "report with KPIs, as the running one counts it -- the Talent Box, the release); never their own "
                "check-in, their LM's review or a calibration status",
                ye_j[:3] == ["360 Feedback", "Team review", "Talent Box"] and ye_j[-1] == "Results released"
                and not {"KPI Check-in", "Your review", "Calibration", "Competency"} & set(ye_j), ye_j)
        s.check("...past Mid-Year: the same, without the Talent Box", "360 Feedback" in my_j and "Talent Box" not in my_j
                and not {"KPI Check-in", "Your review", "Calibration"} & set(my_j), my_j)
    finally:
        rc.pop()
    rc, db = ctx(ids["buceo"])
    try:
        bu = user(db, ids["buceo"])
        my_j = [x["name"] for x in a.dash_journey_done(db, bu, cyc["my"])]
        ye_j = [x["name"] for x in a.dash_journey_done(db, bu, cyc["ye"])]
        s.check("a BU CEO's Mid-Year journey has no BU calibration and no Calibration step (Year-End still does)",
                "BU calibration" not in my_j and "Calibration" not in my_j and "BU calibration" in ye_j, (my_j, ye_j))
    finally:
        rc.pop()

    s.section("the Talent Box between cycles: the BG CEO's every unit, the BU CEO's own; Mid-Year from the HOD's bands")
    # E1: LM ME, HOD AE, BG CEO BE (final BE x Low); LM: ME x Mid; O1 (no HOD): OU x High
    for k, co, row in (("e1", CO, ("ME", "AE", "BE", "BE", "bgceo", "Mid", "Mid", "Low", "Low", "bgceo")),
                       ("lm", CO, ("ME", "ME", None, "ME", "hod", "Mid", "Mid", None, "Mid", "hod")),
                       ("o1", CO2, ("OU", None, None, "OU", "raw", "High", None, None, "High", "raw"))):
        for c in (cyc["my"], cyc["ye"]):
            sql("INSERT INTO rating_records(cycle_id, subject_id, employee_id, business_group, company, pm_mgr_band, "
                "pm_hod_band, pm_bgceo_band, pm_final_band, pm_final_source, pot_raw_band, pot_hod_band, pot_bgceo_band, "
                "pot_final_band, pot_final_source, f360_valid, last_event) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'zzmy')",
                (c, ids[k], "ZZMY-" + k, BG, co) + row)
    rc, db = ctx(ids["bgceo"])
    try:
        bx = a.dash_bg_box(db, user(db, ids["bgceo"]), cyc["ye"])
        s.check("BG CEO at Year-End: the whole group, then each unit", bx and bx["scope"] == "bg"
                and [u_["name"] for u_ in bx["units"]] == ["Whole group", CO, CO2] and bx["units"][0]["people"] == 3,
                bx and [(u_["name"], u_["people"]) for u_ in bx["units"]])
        s.check("...as 9 boxes (Chris, 2026-10-13): performance in thirds, each box with its label; E1 (BE x Low, the BG "
                "CEO's) in Low x Low, a PIP/Improvement box",
                [len(r_["cells"]) for r_ in bx["units"][1]["rows"]] == [3, 3, 3]
                and bx["units"][1]["rows"][2]["cells"][0]["n"] == 1
                and bx["units"][1]["rows"][2]["cells"][0]["label"] == "PIP/Improvement"
                and [c_["label"] for c_ in bx["units"][1]["rows"][0]["cells"]] == ["Solid Core", "Star", "Super Star"],
                bx["units"][1]["rows"])
        s.check("...the four totals still count each person's own category",
                sum(k_["n"] for k_ in bx["units"][0]["cats"]) == bx["units"][0]["people"], bx["units"][0]["cats"])
        bm = a.dash_bg_box(db, user(db, ids["bgceo"]), cyc["my"])
        s.check("BG CEO at Mid-Year: the box too, everyone placed at once, from the HOD's final bands (E1 at AE x Mid), "
                "no lock", bm and bm["mid_year"] and bm["units"][0]["people"] == 3 and bm["n_locked"] == 0
                and bm["units"][1]["rows"][1]["cells"][2]["n"] == 1 and bm["units"][1]["rows"][2]["cells"][0]["n"] == 0,
                bm and bm["units"][1]["rows"])
    finally:
        rc.pop()
    rc, db = ctx(ids["buceo"])
    try:
        bx = a.dash_bg_box(db, user(db, ids["buceo"]), cyc["ye"])
        s.check("BU CEO before release 1: their unit only, everyone waiting", bx and bx["scope"] == "bu"
                and [u_["name"] for u_ in bx["units"]] == [CO] and bx["units"][0]["people"] == 0 and bx["waiting"] == 2,
                bx and (bx["units"][0]["people"], bx["waiting"]))
    finally:
        rc.pop()
    sql("INSERT INTO leader_releases(cycle_id, subject_id, kind) VALUES (?,?,'talent')", (cyc["ye"], ids["e1"]))
    rc, db = ctx(ids["buceo"])
    try:
        bx = a.dash_bg_box(db, user(db, ids["buceo"]), cyc["ye"])
        s.check("...after release 1 for one of them: one placed, one waiting, nobody from the other unit",
                bx["units"][0]["people"] == 1 and bx["waiting"] == 1, (bx["units"][0]["people"], bx["waiting"]))
    finally:
        rc.pop()
    tpl = H.source(a, "templates/dashboard.html")
    s.check("the template: the BG CEO's box replaces the results row, the BU CEO's sits under it; Mid-Year names the "
            "HOD's bands instead of a lock", "X and X['scope'] in ('bg', 'group') %}" in tpl   # an elif since the round 2 view
            and "{% if X %}{{ talent_box(X, rec) }}{% endif %}" in tpl and "Your business unit</h2>" in tpl
            and "The HOD's final bands" in tpl)

    s.section("the dashboard's one grid (Chris, 2026-10-13, the canvas)")
    css_ = H.source(a, "static/style.css")
    s.check("13 columns, a two-card row 8 | 5, .is-flip leads with the narrow card (5 | 8)",
            "grid-template-columns: repeat(13, minmax(0, 1fr))" in css_ and ".od-grid > * { grid-column: span 8;" in css_
            and ".od-grid > * + * { grid-column: span 5; }" in css_ and ".od-grid.is-flip > * + * { order: -1; }" in css_)
    s.check("...one column on a narrow screen, nothing reordered", ".od-grid > *, .od-grid > * + * { grid-column: 1 / -1; order: 0; }" in css_)
    s.check("history and tools are two cards on the grid; the box and the units too, their feet on one line",
            'class="od-card od-hist"' in tpl and 'class="od-card od-tools"' in tpl and 'class="od-card od-boxg"' in tpl
            and 'class="od-card od-boxu"' in tpl and ".od-box-foot { margin-top: auto; width: 100%; height: 54px;" in css_
            and ".od-box-cats > div { min-height: 54px;" in css_ and "od-strip" not in tpl)
    s.check("between cycles the business units sit left and the box right, the BU CEO's too (2026-10-16); a BG CEO's "
            "tools left, cycles they led right",
            "{% macro talent_box(X, rec) -%}\n<div class=\"od-grid is-flip\">" in tpl
            and "is-flip' if (mode == 'record' and rec and rec['box']) else '' }}" in tpl
            and "'Cycles you led' if led_cycles" in tpl)
    rc, db = ctx(ids["bgceo"])
    try:
        lc = a.dash_led_cycles(db, user(db, ids["bgceo"]))
        s.check("a BG CEO's history is the cycles they led (from their group's records), Mid-Year with the HOD's bands",
                [c_["name"] for c_ in lc][:2] == ["ZZMY Year-End", "ZZMY Mid-Year"]
                and "Talent Box not locked" in lc[0]["line"] and "The HOD's final bands" in lc[1]["line"]
                and lc[0]["line"].endswith(" in the cycle"), lc)
        bgs = a.dash_bg_status(db, user(db, ids["bgceo"]), dict(db.execute("SELECT * FROM cycles WHERE id=?", (cyc["my"],)).fetchone()))
        s.check("Mid-Year, running: Where the group is counts department reviews in, nothing to lock",
                bgs and bgs["mid_year"] and [u_["word"] for u_ in bgs["units"] if u_["name"] == CO][0].endswith(" in"), bgs)
        s.check("...a unit with no HOD over anyone: the line manager's bands are final, never \"0 of 0 in\"",
                [(u_["state"], u_["word"]) for u_ in bgs["units"] if u_["name"] == CO2] == [("ready", "No HOD review")]
                and [u_["sub"] for u_ in bgs["units"] if u_["name"] == CO2] == ["1 person · the line manager's bands are final"],
                bgs)
    finally:
        rc.pop()
    rc, db = ctx(ids["buceo"])
    try:
        bus = a.dash_bu_status(db, user(db, ids["buceo"]), dict(db.execute("SELECT * FROM cycles WHERE id=?", (cyc["my"],)).fetchone()))
        buy = a.dash_bu_status(db, user(db, ids["buceo"]), dict(db.execute("SELECT * FROM cycles WHERE id=?", (cyc["ye"],)).fetchone()))
        s.check("Mid-Year, running: Where your BU is is one line, department reviews in, final for Mid-Year",
                bus and bus.get("mid_year") and [x["label"] for x in bus["axes"]] == ["Department reviews"]
                and "final for Mid-Year" in bus["axes"][0]["line"], bus and bus["axes"])
        s.check("...Year-End keeps Performance and Potential",
                buy and [x["label"] for x in buy["axes"]] == ["Performance", "Potential"], buy and buy["axes"])
    finally:
        rc.pop()

    s.section("the BU CEO's curve: Department and Moved filters on the chat card (Chris, 2026-10-13)")
    src_ = H.source(a)
    js_ = H.chat_js(a)
    s.check("the card carries each row's place on the curve and the tolerance rule, so a department's curve counts "
            "exactly as the whole unit's", src_.count('"tol_rule": get_calib_rule()') == 2
            and '"on_curve": bool(r.get("current_band"))' in src_ and '"on_curve": bool((r["band_info"]["score_valid"]' in src_)
    s.check("the filter: the department as a chip of the filter line (shown only where the super admin switched it on, "
            "2026-10-17 / 2026-10-30), Show moved beside the Lock, the department's own curve and verdict, "
            "the whole unit as a faint mark, the lock still the whole unit's",
            "function calFilterBar(d)" in js_ and "function calFilterLine(d, rows)" in js_ and 'if (f.key === "dept")' in js_
            and "function calMovedBtn(d)" in js_ and "function calFiltered(d)" in js_
            and "calib-dist-unit" in js_ and "Your lock covers the whole unit." in js_
            and "calibRoster(fd, true)" in js_)
    s.check("...Moved is a band changed from one that came in, as the roster marks it (an HOD setting a band where "
            "nothing came in isn't a move)", "return !!(c && c.moved && (c.own ? r.incoming_band : c.from));" in js_)
    s.check("...the list beside the chat follows it, and keeps it across a refresh",
            ".rv-nav-item[hidden] { display: none; }" in css_ and "function calNavFilter()" in js_ and "calNavFilter();   // a fresh list keeps the BU CEO's filter" in js_)
    s.check("...the tolerance and rounding mirror the server's (calib_tolerance; round half to even)",
            "function calTolerance(rule, n)" in js_ and "function pyRound(x)" in js_)
    import shutil as _sh
    import subprocess as _sp
    if _sh.which("node"):
        _fn = "var pn = function (s) { return s; };\n" + js_[js_.index("  var cf = { key:"):js_.index("  function calFilterBar(d)")]
        _depts = ["Sales", "Ops", "Finance"]
        _cases = []
        for ax, order, target in (("pm", a.PM_BAND_ORDER, {"UA": 5, "BE": 15, "ME": 50, "AE": 20, "OU": 10}),
                                  ("pot", list(a._POT_BANDS), dict(a.CALIBRATION_TARGET))):
            for n_ in (3, 7, 10, 25):
                rows_ = [{"id": i, "department": _depts[i % 3], "current_band": order[(i * 7 + n_) % len(order)],
                          "on_curve": i % 5 != 4, "incoming_band": order[0] if i % 6 == 2 else None,
                          "chain": [{"tier": "HOD", "moved": i % 4 in (0, 1), "from": order[1] if i % 4 == 0 else None},
                                    {"own": True, "moved": i % 3 == 2}]} for i in range(n_)]
                for rule in ({"mode": "people", "people": 1}, {"mode": "people", "people": 2},
                             {"mode": "percent", "pct": 10}, {"mode": "percent", "pct": 15}):
                    for dept in ("", "Sales", "Ops"):
                        for moved in (False, True):
                            _cases.append({"ax": ax, "dept": dept, "moved": moved, "d": {
                                "tier": "buceo", "review": False, "band_order": order, "target": target,
                                "tol_rule": rule, "rows": rows_, "distribution": {}, "total": 0}})
        _js = _fn + "\nconsole.log(JSON.stringify(" + json.dumps(_cases) + ".map(function (c) { cf.dept = c.dept ? [c.dept] : []; "
        _js += "cf.moved = c.moved; var o = calFiltered(c.d); return {ids: o.rows.map(function (r) { return r.id; }), "
        _js += "dist: o.distribution, total: o.total, gaps: o.gaps || null, breaches: o.breaches || null, "
        _js += "tol: o.tolerance == null ? null : o.tolerance}; })));"
        # the script goes in on stdin: as an argument it is over Linux's per-argument limit (CI failed on it)
        _out = json.loads(_sp.run(["node", "-"], input=_js, capture_output=True, text=True, timeout=60).stdout)

        def _mine(c):
            d_ = c["d"]
            rows_ = [r for r in d_["rows"] if (not c["dept"] or r["department"] == c["dept"])
                     and (not c["moved"] or any(x["moved"] and (r["incoming_band"] if x.get("own") else x["from"])
                                                for x in r["chain"]))]
            if not c["dept"]:
                return {"ids": [r["id"] for r in rows_], "dist": {}, "total": 0, "gaps": None, "breaches": None, "tol": None}
            dist = {b: 0 for b in d_["band_order"]}
            for r in d_["rows"]:
                if r["department"] == c["dept"] and r["on_curve"]:
                    dist[r["current_band"]] += 1
            n = sum(dist.values())
            gaps = (a.pm_calibration_target_gaps(dist, d_["target"]) if c["ax"] == "pm"
                    else a.calibration_target_gaps(dist, d_["target"]))
            rule = d_["tol_rule"]
            tol = 0 if not n else (min(rule["people"], n) if rule["mode"] == "people"
                                   else a.talent_move_allowance(n, rule["pct"]))
            return {"ids": [r["id"] for r in rows_], "dist": dist, "total": n, "gaps": gaps,
                    "breaches": {b: g for b, g in gaps.items() if abs(g) > tol}, "tol": tol}
        _bad = [(c["ax"], c["dept"], c["moved"], c["d"]["tol_rule"], o, _mine(c)) for c, o in zip(_cases, _out)
                if o != _mine(c)]
        s.check("the card's department curve (journey_chat.js calFiltered, run in node) is the server's: the same "
                "gaps (pm_calibration_target_gaps / calibration_target_gaps), tolerance and breaches, %d cases"
                % len(_cases), len(_out) == len(_cases) and not _bad, _bad[:2])
    else:
        s.check("SKIP: node isn't installed, so the card's department curve isn't compared here", True)

    s.section("Release results at Mid-Year")
    SU = H.actors(a)[0]
    page = H.client_as(a, SU["id"]).get("/admin/talent-release?period=%d" % cyc["my"]).get_data(as_text=True)
    s.check("all three results, talent status included; the page says Mid-Year ends at the HOD's review",
            'value="talent"' in page and "All three" in page and "Mid-Year ends at" in page)

    s.section("the AI+ check-in: the HOD's Department Review opens at Mid-Year, no other leader seat")
    sql("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm')",
        (ACT["id"],))
    for k in _SETTINGS:
        sql("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k,))
    views = {}
    for half in (1, 2):
        sql("UPDATE cycles SET half=? WHERE id=?", (half, ACT["id"]))
        for who in ("hod", "buceo"):
            rc, db = ctx(ids[who])
            try:
                views[(half, who)] = a._journey_leader_views(db, user(db, ids[who]))
            finally:
                rc.pop()
    sql("UPDATE cycles SET half=? WHERE id=?", (_ORIG["half"], ACT["id"]))
    s.check("Mid-Year: the HOD has the Dept view; the BU CEO has no BU view",
            "dept" in views[(1, "hod")] and "bu" not in views[(1, "buceo")], views)
    s.check("Year-End: both, as before", "dept" in views[(2, "hod")] and "bu" in views[(2, "buceo")], views)
    rc, db = ctx(ids["hod"])
    try:
        st_my, st_ye = {"period": {"half": 1}, "stages": []}, {"period": {"half": 2}, "stages": []}
        s.check("the Dept view's parts are the same at Mid-Year as at Year-End; the BU / BG views have none",
                [x["key"] for x in a._journey_team_live_stages(st_my, "dept")]
                == [x["key"] for x in a._journey_team_live_stages(st_ye, "dept")]
                and a._journey_team_live_stages(st_my, "bu") == [] and a._journey_team_live_stages(st_my, "bg") == [])
    finally:
        rc.pop()
    src = H.source(a)
    js = H.source(a, "static/journey_chat.js")
    s.check("its agent is told Mid-Year ends with it: no BU CEO after", "_DEPT_REVIEW_MY if cycle_is_mid_year(" in src
            and "the review goes to a BU CEO or that anyone can change a band after it" in src)
    s.check("the review's own words say final, not 'to your BU CEO', at Mid-Year",
            js.count("d.mid_year ?") >= 3 and "makes their Mid-Year bands final" in js
            and '"mid_year": cycle_is_mid_year(db, ctx["period"]["id"])' in src)

    s.section("the Ask OneHR icon floats")
    css = H.source(a, "static/style.css")
    s.check("no card is pulled in for it: only room below the last card",
            ".od.has-fab .od-strip" not in css and ".od.has-fab { padding-bottom: 72px; }" in css)

finally:
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("UPDATE cycles SET half=? WHERE id=?", (_ORIG["half"], ACT["id"]))
        for k, v in _ORIG["settings"].items():
            if v is None:
                db.execute("DELETE FROM app_settings WHERE key=?", (k,))
            else:
                db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)", (k, v))
        for m, v in _ORIG["modules"].items():
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, ACT["id"], m))
        uids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZMY-%'")]
        q = ",".join("?" * len(uids)) or "NULL"
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id "
                   "IN (%s))" % q, uids)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % q, uids)
        db.execute("DELETE FROM assignments WHERE assessor_id IN (%s) OR subject_id IN (%s)" % (q, q), uids + uids)
        for c in cyc.values():
            for st_, at_ in (("pm_calibration_sessions", "pm_calibration_adjustments"),
                             ("calibration_sessions", "calibration_adjustments")):
                db.execute("DELETE FROM %s WHERE session_id IN (SELECT id FROM %s WHERE cycle_id=?)" % (at_, st_), (c,))
                db.execute("DELETE FROM %s WHERE cycle_id=?" % st_, (c,))
            for t in ("talent_releases", "leader_releases", "rating_records"):
                db.execute("DELETE FROM %s WHERE cycle_id=?" % t, (c,))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (q, q), uids + uids)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE employee_id LIKE 'ZZMY-%'")
        db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZMY-%'")
        db.execute("DELETE FROM cycles WHERE code LIKE 'ZZMY-%'")
        db.commit()

sys.exit(s.done())
