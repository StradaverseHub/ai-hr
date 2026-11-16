"""The Talent Box limits (Chris, 2026-11-03).

  "if it is enabled, then it will be hard limit, super admin can adjust the % too"   "approve as drawn, when deployed,
  disabled by default"

Two limits on what one unit's Talent Box can change, ONE card in Settings > Calibration, each OFF until the super admin
switches it on (no row = off): how many people may change category, and how many Stars and Super Stars one unit may hold
(per PAT curve, from the curves' own figures). Both are hard on the one writer (`_talent_box_apply`: the page's /move and the
chat's move_person) and on the one lock (`_talent_box_lock` / `_talent_box_lock_bu`).

Its own synthetic business group on the SHARED suite database: three units of 20 on three PAT curves (Alpha normal, Beta
negatively skewed, Gamma positively skewed) with the BU CEO's bands locked in, the BG CEO's box on top, a Group Chief's group
over Delta's ten people. Everything is put back at the end.
"""
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Talent Box limits -- off by default, the settings card, Stars and Super Stars per unit and PAT curve, "
            "hard on the move and the lock")
_real_avail = a.ai_draft.review_agent_available
a.ai_draft.review_agent_available = lambda: True
BG = "ZZTL Group"
CA, CB, CC, CD, CE = ("ZZTL Alpha Sdn Bhd", "ZZTL Beta Sdn Bhd", "ZZTL Gamma Sdn Bhd", "ZZTL Boss Sdn Bhd",
                      "ZZTL Delta Sdn Bhd")
TBK = tuple(a.TB_LIMIT_KEYS) + ("talent_move_cap_enabled", "talent_move_cap_pct")


def scrub(db):
    """Every row this suite's synthetic people and business group own, children first -- also what a run that died half-way
    left behind (the shared suite database keeps it): rows pointing at their user ids, the BG's sessions, locks, PAT figures and
    joins, the Group Chief's group."""
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZTL-%'")]
    for t_, ts_ in (("pm_calibration_adjustments", "pm_calibration_sessions"), ("calibration_adjustments", "calibration_sessions")):
        db.execute("DELETE FROM %s WHERE session_id IN (SELECT id FROM %s WHERE business_group=?)" % (t_, ts_), (BG,))
    db.execute("DELETE FROM pm_calibration_group_members WHERE group_id IN (SELECT id FROM pm_calibration_groups WHERE name LIKE 'ZZTL%')")
    db.execute("DELETE FROM pm_calibration_groups WHERE name LIKE 'ZZTL%'")
    for t_ in ("pm_calibration_sessions", "calibration_sessions"):
        db.execute("DELETE FROM %s WHERE business_group=?" % t_, (BG,))
    for t_ in ("talent_box_bu_locks", "calib_unit_joins", "pm_pbt_achievement"):
        db.execute("DELETE FROM %s WHERE business_group=?" % t_, (BG,))
    if ids:
        ph = ",".join("?" * len(ids))
        for (t_,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall():
            if t_ == "users":
                continue
            for fk in db.execute("PRAGMA foreign_key_list(%s)" % t_).fetchall():
                if fk[2] == "users":
                    db.execute("DELETE FROM %s WHERE %s IN (%s)" % (t_, fk[3], ph), ids)
        for tbl, col in (("talent_status_history", "subject_id"), ("tb_insights", "subject_id")):
            try:
                db.execute("DELETE FROM %s WHERE %s IN (%s)" % (tbl, col, ph), ids)
            except Exception:
                pass
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    scrub(db)   # a run that died half-way
    _ORIG = {"half": db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0],
             "settings": {k: (r[0] if r else None) for k in ("ai_calib", "review_unified") + TBK
                          for r in [db.execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone()]},
             "modules": {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=? "
                                                         "AND module_key IN ('review','calibration','pm','tm')", (CID,))},
             "max": {tb: db.execute("SELECT COALESCE(MAX(id),0) FROM %s" % tb).fetchone()[0]
                     for tb in ("calibration_sessions", "pm_calibration_sessions", "pm_manager_chat",
                                "calibration_adjustments", "pm_calibration_adjustments", "pm_kpi_targets",
                                "activity_log", "pm_calibration_groups")}}
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm')",
               (CID,))
    for k in ("ai_calib", "review_unified"):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k,))
    db.execute("DELETE FROM app_settings WHERE key IN (%s)" % ",".join("?" * len(TBK)), TBK)   # no row at all = the default
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, company, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=company)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        uid = db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group) "
                   "VALUES (?,?,?,100,'more','approved',?)", (PER, uid, "ZZTL KPI", BG))
        return uid
    BOSS = person("ZZTL-CEO", "ZZ TL Group CEO", CD, bgceo_bg=BG)
    GC = person("ZZTL-GC", "ZZ TL Group Chief", CD)
    # Alpha: 4 Stars (two ME/High, an AE/Mid, an OU/Mid), 1 Super Star (AE/High), 15 Solid Core (ME/Mid)
    LAYOUT_A = [("ME", "High")] * 2 + [("AE", "Mid"), ("OU", "Mid"), ("AE", "High")] + [("ME", "Mid")] * 15
    # Beta: 3 Stars (ME/High), 17 Solid Core.  Gamma: 3 Stars, 17 Solid Core.
    LAYOUT_B = [("ME", "High")] * 3 + [("ME", "Mid")] * 17
    A_ = [person("ZZTL-A%02d" % i, "ZZ TL Alpha %d" % i, CA) for i in range(20)]
    B_ = [person("ZZTL-B%02d" % i, "ZZ TL Beta %d" % i, CB) for i in range(20)]
    C_ = [person("ZZTL-C%02d" % i, "ZZ TL Gamma %d" % i, CC) for i in range(20)]
    # Delta: ten people, 3 Stars and 7 Solid Core, all in a Group Chief's group (the BG CEO reads them, the Group Chief moves them)
    E_ = [person("ZZTL-E%02d" % i, "ZZ TL Delta %d" % i, CE) for i in range(10)]
    LAYOUT_E = [("ME", "High")] * 3 + [("ME", "Mid")] * 7
    for co, ids, lay in ((CA, A_, LAYOUT_A), (CB, B_, LAYOUT_B), (CC, C_, LAYOUT_B), (CE, E_, LAYOUT_E)):
        pm_ = a._pm_calib_get_or_create_session(db, PER, "buceo", co, BG, co)
        po_ = a._get_or_create_calibration_session(db, CID, "buceo", co, BG, co)
        for sid, (pb, qb) in zip(ids, lay):
            a._pm_calib_upsert_adjustment(db, pm_["id"], sid, "", pb, "BU set", BOSS)
            a._calibration_upsert_adjustment(db, po_["id"], sid, "", qb, "BU set", BOSS)
        db.execute("UPDATE pm_calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE id=?", (pm_["id"],))
        db.execute("UPDATE calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE id=?", (po_["id"],))
    # the PATs: Alpha 92 (normal), Beta 50 (negatively skewed), Gamma 150 (positively skewed)
    for co, pct in ((CA, 92.0), (CB, 50.0), (CC, 150.0)):
        db.execute("INSERT OR REPLACE INTO pm_pbt_achievement(cycle_id, business_group, company, achievement_pct) "
                   "VALUES (?,?,?,?)", (PER, BG, co, pct))
    # a Group Chief's group over Delta's ten people
    GRP_MEMBERS = E_
    gid = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZTL Chief group', ?)", (GC,)).lastrowid
    for sid in GRP_MEMBERS:
        db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id) VALUES (?,?)", (gid, sid))
    db.commit()


def blabel(co):
    with a.app.test_request_context("/"):
        return a._talent_box_bu_label(BG, co)


def user(uid):
    with a.app.test_request_context("/"):
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def setting(**kw):
    """Put the limits' keys as the test wants them (None deletes the row)."""
    with a.app.test_request_context("/"):
        db = a.get_db()
        for k, v in kw.items():
            if v is None:
                db.execute("DELETE FROM app_settings WHERE key=?", (k,))
            else:
                db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)", (k, v))
        db.commit()


def reset_moves(*ids):
    """Put the BG CEO's / Group Chief's moves back (their tiers' adjustments), so each check starts from the BU CEO's bands."""
    with a.app.test_request_context("/"):
        db = a.get_db()
        for t_, ts_ in (("pm_calibration_adjustments", "pm_calibration_sessions"),
                        ("calibration_adjustments", "calibration_sessions")):
            db.execute("DELETE FROM %s WHERE session_id IN (SELECT id FROM %s WHERE tier IN ('bgceo','group') AND "
                       "(business_group=? OR scope_key=?))" % (t_, ts_), (BG, str(gid)))
        db.commit()


def ctx_and_rows(tier="bgceo", who=BOSS):
    from flask import session as _s
    _s["user_id"] = who
    db = a.get_db()
    kw = {"bg": BG} if tier == "bgceo" else {"group_id": gid}
    ctx = a._talent_box_resolve(db, user(who), tier, **kw)
    return db, ctx, a.talent_box_rows(db, ctx)


def stars(co=None, **cfg):
    """{unit: limits row} of the BG CEO's box with the Stars limit as `cfg` sets it."""
    setting(**cfg)
    with a.app.test_request_context("/review/journey?view=bg"):
        db, ctx, rows = ctx_and_rows()
        return a.tb_star_limits(db, ctx, rows, "bgceo")


def move(uid, **form):
    return (c.post("/talent-box/bg/%s/move" % BG, data=dict({"csrf_token": "tok", "subject_id": str(uid)}, **form),
                   headers={"X-Requested-With": "XMLHttpRequest"}).get_json() or {})


def tool_move(name, **args):
    with a.app.test_request_context("/review/journey?view=bg"):
        from flask import session as _s
        _s["user_id"] = BOSS
        db = a.get_db()
        r = a._tb_run_tool(db, user(BOSS), {"tool": "move_person", "args": dict({"subject": name}, **args)})
        db.commit()
        return r


c = H.client_as(a, BOSS)
SU = H.actors(a)[0]
cs = H.client_as(a, SU["id"])
ON = dict(tb_limit_moves_on="1", tb_limit_moves_pct="10", tb_limit_stars_on="1")
STAR_ON = dict(tb_limit_stars_on="1")

# ---------------------------------------------------------------------------
s.section("off by default: no row means no limit, and a stale talent_move_cap row switches nothing on")
with a.app.test_request_context("/"):
    t0 = a.get_tb_limits()
    gc0 = a.get_talent_move_cap()
s.check("no row at all: both limits off, the moves share 10%, every curve on the curves' own figures",
        not t0["moves_on"] and not t0["stars_on"] and t0["moves_pct"] == 10.0 and gc0 == (False, 10.0)
        and t0["stars"] == {k: v for k, v in a.tb_curve_figures().items()} and not any(t0["stored"].values()), (t0, gc0))
setting(talent_move_cap_enabled="1", talent_move_cap_pct="0.5")   # the old default-on row, as production may still hold
with a.app.test_request_context("/"):
    gc1 = a.get_talent_move_cap()
    t1 = a.get_tb_limits()
s.check("the old stored cap (enabled, 0.5%) is never read: still off, still 10%", gc1 == (False, 10.0) and not t1["moves_on"], gc1)
with a.app.test_request_context("/review/journey?view=bg"):
    db, ctx, rows = ctx_and_rows()
    s.check("...so no unit has a Stars limit", a.tb_star_limits(db, ctx, rows, "bgceo") == {})
    s.check("...and nothing refuses a lock", a.tb_limit_lock_refusal(db, "bgceo", ctx) == "")
r_off_star = move(A_[5], potential_band="High")   # Solid Core -> Star in Alpha, already holding 4 Stars
s.check("with both off a move into Star goes through (Alpha holds 4 Stars, 21% of 20 would be 4) -- and one with the old row "
        "(a category move past its '0.5%') goes through too", r_off_star.get("ok"), r_off_star)
r_off_cat = move(A_[7], performance_band="UA", potential_band="Low")   # a second category move, past that old cap
s.check("...a second category move goes through as well", r_off_cat.get("ok"), r_off_cat)
reset_moves()
setting(talent_move_cap_enabled=None, talent_move_cap_pct=None)
with a.app.test_request_context("/review/journey?view=bg"):
    from flask import session as _s
    _s["user_id"] = BOSS
    db = a.get_db()
    sc = a._journey_talent_box_scope(db, user(BOSS))
    ov_off = a._journey_talent_box_overview(db, user(BOSS), sc, company=CA) or {}
    D_off = a._talent_box_data(db, user(BOSS), "bgceo", sc[2], sc[1], CA)
s.check("the card's data carries no limits key when both are off (the payload is what it was; the cap flag off, nothing keyed per unit)",
        "limits" not in ov_off and ov_off.get("cap_on") is False and not D_off["limit_units"]
        and D_off["cap_view"] is None, (ov_off.get("limits"), ov_off.get("cap_on")))
_html_off = cs.get("/talent-box/bg/%s" % BG).get_data(as_text=True)
s.check("...and the classic page draws no Limits line and no chip",
        'class="tbox-limits"' not in _html_off and "tbox-limchip" not in _html_off and "Reference guideline" in _html_off)
with a.app.test_request_context("/review/journey?view=bg"):
    from flask import session as _s
    _s["user_id"] = BOSS
    _sys_off = a._talent_box_system(a.get_db(), user(BOSS))
s.check("...the agent's brief holds no limits line while both are off", "LIMITS Group People set" not in _sys_off)
_js = H.chat_js(a)
s.check("client: every limit helper draws nothing without d.limits (so the box looks as it always did)",
        "function tbLimitsLine(d) {\n    var L = d && d.limits;\n    if (!L" in _js
        and "if (!st) return null;" in _js and 'if (!st || (cat !== "Star" && cat !== "Super Star")) return "";' in _js
        and "if (!d.limits) return;" in _js)

# ---------------------------------------------------------------------------
s.section("the curves' own figures and the allowance rule")
figs = a.tb_curve_figures()
s.check("the curves' figures, computed from the performance curve x the potential curve (15-70-15): Normal 2.25 / 21, "
        "Negatively skewed 0.75 / 12.5, Positively skewed 5.25 / 33.5",
        figs["normal"] == {"super": 2.25, "star": 21.0} and figs["negative"] == {"super": 0.75, "star": 12.5}
        and figs["positive"] == {"super": 5.25, "star": 33.5}, figs)
_keep_curve = dict(a.PM_DIST_CURVES["normal"])
a.PM_DIST_CURVES["normal"] = {"UA": 0, "BE": 0, "ME": 50, "AE": 30, "OU": 20}   # falsify: not typed in, read from the curves
f2 = a.tb_curve_figures()["normal"]
a.PM_DIST_CURVES["normal"] = _keep_curve
s.check("...computed, not typed: a different curve gives different figures (50% ME, 50% AE+OU: Super 7.5, Star 7.5 + 35)",
        f2 == {"super": 7.5, "star": 42.5} and a.tb_curve_figures()["normal"] == {"super": 2.25, "star": 21.0}, f2)
al = a.talent_move_allowance
s.check("allowance: half-up (86 x 10% = 8.6 -> 9; 86 x 21% = 18.06 -> 18; 86 x 2.25% = 1.935 -> 2; 10 x 25% = 2.5 -> 3; "
        "15 x 10% = 1.5 -> 2)", (al(86, 10), al(86, 21), al(86, 2.25), al(10, 25), al(15, 10)) == (9, 18, 2, 3, 2),
        (al(86, 10), al(86, 21), al(86, 2.25), al(10, 25), al(15, 10)))
s.check("...never below one for a unit with anyone in it (3 x 10% = 0.3; 1 x 0.01%) and none for an empty unit",
        (al(3, 10), al(1, 0.01), al(0, 50), al(-1, 50)) == (1, 1, 0, 0), (al(3, 10), al(1, 0.01), al(0, 50)))

# ---------------------------------------------------------------------------
s.section("Stars and Super Stars: each unit on its own PAT curve, over the whole scope")
st = stars(**STAR_ON)
A, B, Cc, D_ = st.get(CA) or {}, st.get(CB) or {}, st.get(CC) or {}, st.get(CD) or {}
s.check("Alpha (PAT 92): the normal curve, 4 Stars of 4 allowed (21% of 20 = 4.2) and 1 Super Star of 1 (2.25% = 0.45, never below "
        "one) -- both at their limit, so full",
        A.get("curve_key") == "normal" and A.get("curve") == "Normal" and A["headcount"] == 20
        and (A["star"]["n"], A["star"]["max"], A["star"]["state"]) == (4, 4, "full")
        and (A["super"]["n"], A["super"]["max"], A["super"]["state"]) == (1, 1, "full"), A)
s.check("Beta (PAT 50): the negatively skewed curve, 3 Stars of 3 (12.5% of 20 = 2.5 half-up -> 3), 0 Super Stars of 1 (0.75% "
        "-> 0.15, floor one)",
        B.get("curve_key") == "negative" and (B["star"]["n"], B["star"]["max"], B["star"]["state"]) == (3, 3, "full")
        and (B["super"]["n"], B["super"]["max"], B["super"]["state"]) == (0, 1, "ok"), B)
s.check("Gamma (PAT 150): the positively skewed curve, 3 Stars of 7 (33.5% of 20 = 6.7), 0 Super Stars of 1 (5.25% = 1.05): "
        "room in both",
        Cc.get("curve_key") == "positive" and (Cc["star"]["n"], Cc["star"]["max"], Cc["star"]["state"]) == (3, 7, "ok")
        and (Cc["super"]["n"], Cc["super"]["max"]) == (0, 1), Cc)
s.check("the Group CEO's own unit (two people, one of them the chief): no PAT entered, so the normal curve; at least one place "
        "each, none held", D_.get("curve_key") == "normal" and D_["headcount"] == 2 and D_["star"]["max"] == 1
        and D_["star"]["n"] == 0, D_)
s.check("each unit says its name as the box does", A.get("label") == blabel(CA), A.get("label"))
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("UPDATE pm_pbt_achievement SET achievement_pct=150 WHERE business_group=? AND company=?", (BG, CA))
    db.commit()
st2 = stars()
s.check("falsified: the curve follows the unit's PAT -- Alpha at PAT 150 is on the positively skewed curve and may hold 7 Stars",
        st2[CA]["curve_key"] == "positive" and st2[CA]["star"]["max"] == 7 and st2[CA]["star"]["state"] == "ok", st2[CA])
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("UPDATE pm_pbt_achievement SET achievement_pct=92 WHERE business_group=? AND company=?", (BG, CA))
    db.commit()
st3 = stars(tb_limit_stars=json.dumps({"normal": {"super": 10, "star": 30}}))
s.check("a figure the super admin changed rules over the curves' own: Normal at Star 30% / Super Star 10% gives Alpha 6 Stars "
        "and 2 Super Stars; the other curves stay on theirs",
        st3[CA]["star"]["max"] == 6 and st3[CA]["super"]["max"] == 2 and st3[CB]["star"]["max"] == 3, (st3[CA], st3[CB]["star"]))
setting(tb_limit_stars=None)
# units calibrated together count as ONE unit (the joined population), on the one curve the join follows
with a.app.test_request_context("/"):
    db = a.get_db()
    for co in (CB, CC):
        db.execute("INSERT OR REPLACE INTO calib_unit_joins(cycle_id, business_group, company, lead, curve_of) VALUES (?,?,?,?,?)",
                   (CID, BG, co, CB, CC))
    db.commit()
st4 = stars()
J = st4.get(CB) or {}
s.check("units calibrated together count as one unit under their lead: Beta + Gamma are 40 people with 6 Stars, on the curve "
        "the join follows (Gamma's PAT 150: positively skewed, 33.5% of 40 = 13.4 -> 13), and Gamma has no unit of its own",
        CC not in st4 and J.get("headcount") == 40 and J["star"]["n"] == 6 and J["star"]["max"] == 13
        and J["curve_key"] == "positive", J)
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("DELETE FROM calib_unit_joins WHERE business_group=?", (BG,))
    db.commit()
with a.app.test_request_context("/review/journey?view=group"):
    db, ctx, rows = ctx_and_rows("group", GC)
    stg = a.tb_star_limits(db, ctx, rows, "group")
s.check("a Group Chief's group is ONE unit, on the normal curve (no PAT of its own): 10 people with 3 Stars -> 2 allowed "
        "(21% = 2.1) is over by one; 1 Super Star-less group may hold 1",
        list(stg) == [""] and stg[""]["headcount"] == 10 and stg[""]["curve_key"] == "normal"
        and (stg[""]["star"]["n"], stg[""]["star"]["max"], stg[""]["star"]["state"]) == (3, 2, "over")
        and stg[""]["label"] == "ZZTL Chief group" and stg[""]["super"]["max"] == 1, stg)
with a.app.test_request_context("/review/journey?view=bg"):
    db, ctx, rows = ctx_and_rows()
    s.check("the super admin's own tier and the Executive Chairman's boxes are never limited (no unit, no refusal)",
            a.tb_star_limits(db, ctx, rows, "super") == {} and a.tb_star_limits(db, ctx, rows, "chair") == {}
            and a.tb_limit_lock_refusal(db, "super", ctx) == "" and a.tb_limit_lock_refusal(db, "chair", ctx) == "")
    _narrow = [r for r in rows if r["user"]["company"] == CA][:6]
    s.check("measured over the WHOLE scope, never the filtered view: six of Alpha's rows alone would be a 6-person unit "
            "with one Star allowed, but the count is Alpha's 20",
            a.tb_star_limits(db, ctx, rows, "bgceo")[CA]["headcount"] == 20 and a.tb_star_limits(db, ctx, _narrow, "bgceo")[CA]["headcount"] == 6)

# ---------------------------------------------------------------------------
s.section("a move into a full Star or Super Star is refused (the page's /move and the chat's move_person); out and inside are free")
setting(**STAR_ON)
r1 = move(A_[5], potential_band="High")   # ME/Mid -> ME/High: Solid Core -> Star
s.check("Solid Core -> Star in Alpha (4 of 4) is refused with the board's words, naming the unit, the figures and the curve",
        r1.get("ok") is False and r1.get("error") == "Star is full in %s: 4 of 4 (21%% on the Normal curve). Move a Star out first, "
        "or ask Group People to raise the limit." % blabel(CA), r1)
r2 = move(A_[5], performance_band="AE", potential_band="High")   # -> Super Star (1 of 1)
s.check("Solid Core -> Super Star (1 of 1) is refused the same way: 'Super Star is full ... Move a Super Star out first'",
        r2.get("ok") is False and r2.get("error", "").startswith("Super Star is full in ")
        and "1 of 1 (2.25% on the Normal curve). Move a Super Star out first, or ask Group People to raise the limit." in r2["error"], r2)
r3 = tool_move("ZZ TL Alpha 5", potential_band="High")
r4 = tool_move("ZZ TL Alpha 5", performance_band="OU", potential_band="High")
s.check("the chat's move_person goes through the same writer, so it is refused too (Star and Super Star)",
        r3.get("ok") is False and "Star is full in" in (r3.get("error") or "") and r4.get("ok") is False
        and "Super Star is full in" in (r4.get("error") or ""), (r3, r4))
s.check("...and nothing was written by a refused move", a.talent_box_rows is not None and H.one(
    a, "SELECT COUNT(*) FROM calibration_adjustments ca JOIN calibration_sessions cs ON cs.id=ca.session_id "
       "WHERE cs.tier='bgceo' AND cs.business_group=?", (BG,)) == 0)
rgam = move(C_[10], potential_band="High")   # Gamma holds 3 of 7: room
s.check("falsified: Gamma (3 of 7 Stars) takes someone in -- the limit is per unit", rgam.get("ok"), rgam)
reset_moves()
r_in = move(A_[0], potential_band="Mid")   # a Star (ME/High) -> Solid Core (ME/Mid): out
s.check("a move OUT of Star is free", r_in.get("ok"), r_in)
r_in2 = move(A_[5], potential_band="High")   # now 3 of 4: in
s.check("...and frees its place: Alpha is at 3 of 4, so someone moves in; then it is full again",
        r_in2.get("ok") and move(A_[6], potential_band="High").get("ok") is False, r_in2)
reset_moves()
r_in3 = move(A_[2], performance_band="OU")   # AE/Mid (Star) -> OU/Mid (Star): inside the category, Alpha is full
r_in4 = move(A_[1], performance_band="AE", potential_band="Mid")   # ME/High (Star) -> AE/Mid (Star): another Star box
s.check("a move inside a category is free even when it is full (AE/Mid -> OU/Mid; ME/High -> AE/Mid, both Star)",
        r_in3.get("ok") and r_in4.get("ok"), (r_in3, r_in4))
reset_moves()
r_sup = move(A_[4], performance_band="OU")   # AE/High (Super Star) -> OU/High (Super Star)
r_sup2 = move(A_[4], potential_band="Mid")   # Super Star -> Star (AE/Mid): into Star, which is full (4 of 4)
s.check("Super Star -> Super Star is free; Super Star -> Star counts against Star's limit (4 of 4: refused)",
        r_sup.get("ok") and r_sup2.get("ok") is False and "Star is full in" in (r_sup2.get("error") or ""), (r_sup, r_sup2))
reset_moves()
setting(tb_limit_stars_on="0")
r_free = move(A_[5], potential_band="High")
s.check("falsified: with the Stars switch off the same move goes through", r_free.get("ok"), r_free)
reset_moves()
cg = H.client_as(a, GC)
setting(**STAR_ON)
rg = cg.post("/talent-box/group/%d/move" % gid, data={"csrf_token": "tok", "subject_id": str(E_[6]), "potential_band": "High"},
             headers={"X-Requested-With": "XMLHttpRequest"}).get_json() or {}
s.check("a Group Chief's move into Star is refused for their group as one unit: 'Star is over its limit in ZZTL Chief group: "
        "3 of 2 (21% on the Normal curve)'",
        rg.get("ok") is False and rg.get("error", "").startswith("Star is over its limit in ZZTL Chief group: 3 of 2 (21% on the Normal curve).")
        and "ask Group People to raise the limit" in rg["error"], rg)
rgo = cg.post("/talent-box/group/%d/move" % gid, data={"csrf_token": "tok", "subject_id": str(E_[0]), "potential_band": "Mid"},
              headers={"X-Requested-With": "XMLHttpRequest"}).get_json() or {}
s.check("...and a move out of it is free for them", rgo.get("ok"), rgo)
reset_moves()

# ---------------------------------------------------------------------------
s.section("the moves limit: still enforced, now on the new keys, per unit")
setting(tb_limit_stars_on="0", tb_limit_moves_on="1", tb_limit_moves_pct="10")
m1 = move(A_[7], performance_band="UA", potential_band="Low")   # Solid Core -> PIP: category move 1 of 2 (10% of 20)
m2 = move(A_[8], performance_band="UA", potential_band="Low")   # 2 of 2
m3 = move(A_[9], performance_band="UA", potential_band="Low")   # 3: refused
s.check("10% of 20 is 2 category moves: the third is refused, naming the unit, the count, the share and the way on",
        m1.get("ok") and m2.get("ok") and m3.get("ok") is False
        and m3["error"].startswith("Movement cap reached for %s: 2 of 2 allowed (10%% of 20)." % blabel(CA))
        and m3["error"].endswith("or ask Group People to raise the limit."), (m1, m2, m3))
m4 = move(A_[7], performance_band="ME", potential_band="Mid")   # back to where they started: frees one
s.check("a move back to where someone started is free", m4.get("ok"), m4)
m5 = move(A_[9], potential_band="Mid", performance_band="BE")   # ME/Mid -> BE/Mid is PIP: a category move again, now 2 of 2? (A_[8] only)
s.check("...and gives the place back (1 of 2 used again), so the next category move goes through", m5.get("ok"), m5)
m6 = move(A_[10], performance_band="AE")   # ME/Mid -> AE/Mid is Star: stars off here, but moves are used up (2 of 2): refused
s.check("a move inside a category costs nothing: Alpha 12 (ME -> AE inside Solid Core? no, Star) is a category move and is refused "
        "with the moves used up", m6.get("ok") is False and "Movement cap reached" in m6.get("error", ""), m6)
m7 = move(A_[11], performance_band="BE")   # ME/Mid -> BE/Mid is PIP: a category move, refused
m8 = move(A_[11], potential_band="Low")   # ME/Mid -> ME/Low: Solid Core -> Solid Core, inside the category: free
s.check("...while a rating correction inside Solid Core (ME/Mid -> ME/Low) is always free", m8.get("ok"), (m7, m8))
reset_moves()
setting(tb_limit_moves_on=None)
mfree = [move(A_[i], performance_band="UA", potential_band="Low").get("ok") for i in (12, 13, 14)]
s.check("falsified: with the moves switch off (no row) the same category moves all go through", all(mfree), mfree)
reset_moves()

# ---------------------------------------------------------------------------
s.section("a unit over its Stars or Super Stars limit can't be locked (no override); at or under it can")
setting(tb_limit_stars_on="1", tb_limit_moves_on=None)
with a.app.test_request_context("/review/journey?view=bg"):
    db, ctx, rows = ctx_and_rows()
    _ok_at = a.tb_limit_lock_refusal(db, "bgceo", ctx, [CA, CB, CC, CD])
    _delta = a.tb_limit_lock_refusal(db, "bgceo", ctx)
s.check("every unit at or under its limit (Alpha 4 of 4, Beta 3 of 3, Gamma 3 of 7): nothing refuses a lock", _ok_at == "", _ok_at)
s.check("...while Delta (3 Stars against 2 allowed, in the Group Chief's group) is over, and a whole-scope check names it",
        _delta.startswith("%s can't be locked yet: 3 Stars, 1 over its limit of 2. Move 1 person out of Star, then lock." % blabel(CE)),
        _delta)
setting(tb_limit_stars=json.dumps({"normal": {"super": 2.25, "star": 10}}))   # Alpha: 10% of 20 -> 2 Stars allowed, holds 4
lock_url = "/talent-box/bg/%s/lock" % BG
l1 = c.post(lock_url, data={"csrf_token": "tok", "ajax": "1", "company": CA, "override_reason": "please"}).get_json() or {}
s.check("Alpha is 2 over its limit of 2: its lock is refused in the board's words, and an override reason does not unlock it",
        l1.get("ok") is False and l1.get("error") == "%s can't be locked yet: 4 Stars, 2 over its limit of 2. Move 2 people out of Star, "
        "then lock." % blabel(CA), l1)
s.check("...and nothing was locked", H.one(a, "SELECT COUNT(*) FROM talent_box_bu_locks WHERE business_group=?", (BG,)) == 0)
l2 = c.post(lock_url, data={"csrf_token": "tok", "ajax": "1"}).get_json() or {}
s.check("the whole-business-group lock (no unit picked) is refused the same way, for the unit that is over",
        l2.get("ok") is False and "can't be locked yet: 4 Stars, 2 over its limit of 2" in (l2.get("error") or ""), l2)
setting(tb_limit_stars=json.dumps({"normal": {"super": 0.01, "star": 10}}))   # Super Star: 0.01% -> 1 allowed (floor), holds 1: fine
with a.app.test_request_context("/review/journey?view=bg"):
    db, ctx, rows = ctx_and_rows()
    _only_one = a.tb_limit_lock_refusal(db, "bgceo", ctx, [CA])
s.check("a Super Star count at its floor of one is under the limit (1 of 1): only Stars refuse", "Super Star" not in _only_one, _only_one)
for i in (0, 1):   # two Stars out: 2 of 2
    move(A_[i], potential_band="Mid")
with a.app.test_request_context("/review/journey?view=bg"):
    db, ctx, rows = ctx_and_rows()
    _ready = a.tb_limit_lock_refusal(db, "bgceo", ctx, [CA])
s.check("move 2 out and Alpha is at its limit (2 of 2): nothing refuses its lock", _ready == "", _ready)
l3 = c.post(lock_url, data={"csrf_token": "tok", "ajax": "1", "company": CA}).get_json() or {}
s.check("...and it locks (the BG CEO's unit lock, ajax)", l3.get("ok") and H.one(
    a, "SELECT COUNT(*) FROM talent_box_bu_locks WHERE business_group=? AND company=?", (BG, CA)) == 1, l3)
setting(tb_limit_stars=None, tb_limit_stars_on="0")
l4 = c.post(lock_url, data={"csrf_token": "tok", "ajax": "1", "company": CB}).get_json() or {}
s.check("falsified: with the Stars switch off the lock never asks about them (Beta locks)", l4.get("ok"), l4)

# ---------------------------------------------------------------------------
s.section("the card and the agents read the limits (the unit on screen, the server's own words)")
setting(**ON)
reset_moves()
with a.app.test_request_context("/review/journey?view=bg"):
    from flask import session as _s
    _s["user_id"] = BOSS
    db = a.get_db()
    sc = a._journey_talent_box_scope(db, user(BOSS))
    ovG = a._journey_talent_box_overview(db, user(BOSS), sc, company=CC) or {}
    ovB = a._journey_talent_box_overview(db, user(BOSS), sc, company=CB) or {}
LG, LB = ovG.get("limits") or {}, ovB.get("limits") or {}
s.check("Gamma on screen: moves 0 of 2 used (10% of 20), Super Stars 0 of 1, Stars 3 of 7 -- nothing full, the positively skewed "
        "curve",
        LG.get("moves", {}).get("used") == 0 and LG["moves"]["cap"] == 2 and LG["star"]["n"] == 3 and LG["star"]["max"] == 7
        and LG["super"]["max"] == 1 and LG["curve"] == "Positively skewed" and not LG["full"] and not LG["msg"], LG)
s.check("Beta on screen: Stars 3 of 3 FULL, the server's words for it in msg, and Star named in full",
        LB.get("full") == {"Star": "full"} and LB["msg"]["Star"].startswith("Star is full in ")
        and LB["star"]["state"] == "full" and LB["curve"] == "Negatively skewed", LB)
s.check("every box's person carries the category the client reads to tell a move inside a category from a move in",
        all("category" in p for c_ in ovB.get("cells") or [] for p in c_["people"]))
with a.app.test_request_context("/review/journey?view=bg&company=" + CB.replace(" ", "+")):
    from flask import session as _s
    _s["user_id"] = BOSS
    sysB = a._talent_box_system(a.get_db(), user(BOSS))   # Beta on screen
s.check("the BG CEO's agent is told: the unit's limits, FULL marked, never to propose a move into a full category, to say the "
        "refusal's way on, and that it can't change a limit",
        bool("LIMITS Group People set for this unit" in sysB and "Stars 3 of 3 -- FULL" in sysB
             and "NEVER propose or attempt a move INTO a full category" in sysB and "ask Group People to raise the limit" in sysB
             and "you can't change a limit" in sysB), sysB[-900:])
with a.app.test_request_context("/review/journey?view=bg"):
    from flask import session as _s
    _s["user_id"] = BOSS
    db = a.get_db()
    tshow = a._tb_run_tool(db, user(BOSS), {"tool": "show_box", "args": {}})
s.check("show_box hands the model the limits now, short (a tool result is cut at 400 characters)",
        len(tshow.get("limits_now", "")) < 400 and "category moves used" in tshow.get("limits_now", ""), tshow)
# the Group Chief's card
with a.app.test_request_context("/review/journey?view=group"):
    from flask import session as _s
    _s["user_id"] = GC
    db = a.get_db()
    scg = a._journey_talent_box_scope(db, user(GC))
    ovg = a._journey_talent_box_overview(db, user(GC), scg) or {}
    sysg = a._talent_box_system(db, user(GC))
Lg = ovg.get("limits") or {}
s.check("the Group Chief's card carries the group as ONE unit: Stars 3 of 2 over by one, the red words; their agent is told too",
        Lg.get("unit") == "ZZTL Chief group" and Lg["star"]["state"] == "over" and Lg["star"]["over"] == 1
        and Lg["full"].get("Star") == "over" and "Star is over its limit in ZZTL Chief group" in Lg["msg"]["Star"]
        and "Stars 3 of 2 -- OVER by 1" in sysg, Lg)
_page = cs.get("/talent-box/bg/%s?company=%s" % (BG, CB.replace(" ", "+"))).get_data(as_text=True)
_lim_html = _page.split('class="tbox-limits"', 1)[1].split("</div>", 1)[0] if 'class="tbox-limits"' in _page else ""
s.check("the classic page draws the Limits line in plain markup (Beta: Stars 3 of 3 with the Full chip, Negatively skewed curve), "
        "with the Full chip on the Star cells",
        "<b>3 of 3</b>" in _lim_html and 'class="tbox-limchip is-full"' in _lim_html
        and "Negatively skewed curve" in _lim_html and "<b>0 of 2</b>" in _lim_html
        and 'class="tbox-limchip is-full">Full</span>' in _page.split('class="tbox-wrap"', 1)[-1], _lim_html[:300])
ask_lines = None
with a.app.test_request_context("/"):
    db = a.get_db()
    ask_lines = a._ask_facts.__code__.co_consts
s.check("Ask OneHR's guide gets the limits fact: where it is, what a refusal means, never who is in Star or Super Star",
        any("Talent Box limits: Group People limit" in str(x) for x in ask_lines)
        and any("Never say who is in Star or Super Star" in str(x) for x in ask_lines))
s.check("Help has the quick answer on the BG CEO's and the Group Chief's Talent Box lists: Why can't I move someone into Star? "
        "(in Group People's words, never HR or super admin)",
        "bg_limits" in a.HELP_QA and a.HELP_QA["bg_limits"][0] == "Why can't I move someone into Star?"
        and "bg_limits" in a.HELP_LISTS["bg"][1] and "bg_limits" in a.HELP_LISTS["group"][1]
        and len(a.HELP_LISTS["bg"][1]) <= a.HELP_LIST_MAX and len(a.HELP_LISTS["group"][1]) <= a.HELP_LIST_MAX
        and "Group People" in a.HELP_QA["bg_limits"][1] and not re.search(r"\bHR\b|super admin|Reopen", a.HELP_QA["bg_limits"][1]))

# ---------------------------------------------------------------------------
s.section("the settings card: one Save, a required remark, every field checked, super admin only")
setting(**{k: None for k in TBK})
reset_moves()
with a.app.test_request_context("/"):
    from flask import session as _s
    db = a.get_db()
    _s["user_id"] = SU["id"]
    row0 = a._st_tb_limits(db, SU)
secs = [x for x in a.ADMIN_SETTINGS["calibration"]["sections"] if x["id"] == "tb-limits"]
s.check("the section: id tb-limits, 'Talent Box limits', scope global, gate super, card tb_limits; no 'move-cap' section is left",
        len(secs) == 1 and secs[0]["title"] == "Talent Box limits" and secs[0]["scope"] == "global" and secs[0]["gate"] == "super"
        and secs[0]["card"] == "tb_limits" and not any(x["id"] == "move-cap" for x in a.ADMIN_SETTINGS["calibration"]["sections"]),
        secs)
s.check("the All settings row reads 'Off' with no row", row0 == "Off", row0)
page = cs.get("/admin/m/calibration/settings").get_data(as_text=True)
s.check("the page: 'Talent Box limits' in the index with Global, the card with its two parts, both switches off",
        'href="#tb-limits"' in page and "1 &middot; MOVES" in page and "2 &middot; STARS AND SUPER STARS" in page
        and re.search(r'name="tb_moves_on" value="1"\s*id=', page) and re.search(r'name="tb_stars_on" value="1"\s*id=', page)
        and "Limit how many people move category" in page and "Limit Stars and Super Stars" in page
        and "Use the curves' figures" in page and "Share of the unit's people" in page, None)
s.check("...the table: one row per PAT curve with its range and the curves' own figures, nothing marked Changed",
        all(w in page for w in ("Negatively skewed", "PAT under 70%", "PAT 70 to 130%", "Positively skewed", "PAT over 130%"))
        and "0.75% &middot; 12.5%" in page and "2.25% &middot; 21%" in page and "5.25% &middot; 33.5%" in page
        and not re.search(r'tbl-chg" (?!hidden)', page))
FORM = {"csrf_token": "tok", "action": "tb_limits", "tb_moves_on": "1", "tb_moves_pct": "12", "tb_stars_on": "1",
        "tb_negative_super": "0.75", "tb_negative_star": "12.5", "tb_normal_super": "2.25", "tb_normal_star": "21",
        "tb_positive_super": "5.25", "tb_positive_star": "30", "remark": "Agreed at the group calibration meeting, 3 Nov"}


def stored():
    with a.app.test_request_context("/"):
        return {k: r[0] for k in a.TB_LIMIT_KEYS for r in [a.get_db().execute(
            "SELECT value FROM app_settings WHERE key=?", (k,)).fetchone()] if r}


def post(form, client=cs, **drop):
    f = {k: v for k, v in form.items() if k not in drop}
    return client.post("/admin/settings", data=f, follow_redirects=True)


nr = post({k: v for k, v in FORM.items() if k != "remark"})
s.check("no remark, nothing changes (the remark is required, server side)", stored() == {} and "remark" in html.unescape(
    nr.get_data(as_text=True)).lower(), stored())
bads = [("moves share not a number", {"tb_moves_pct": "abc"}, "Moves: the share of the unit's people must be a number."),
        ("moves share 0", {"tb_moves_pct": "0"}, "Moves: the share of the unit's people must be above 0 and at most 100."),
        ("moves share over 100", {"tb_moves_pct": "100.5"}, "Moves: the share of the unit's people must be above 0 and at most 100."),
        ("moves share negative", {"tb_moves_pct": "-3"}, "Moves: the share of the unit's people must be above 0 and at most 100."),
        ("moves share 3 decimals", {"tb_moves_pct": "10.555"}, "Moves: the share of the unit's people can have at most 2 decimal places."),
        ("moves share blank", {"tb_moves_pct": ""}, "Moves: the share of the unit's people must be a number."),
        ("moves share NaN", {"tb_moves_pct": "nan"}, "Moves: the share of the unit's people must be above 0 and at most 100."),
        ("negative Super Star text", {"tb_negative_super": "x"}, "Negatively skewed: the Super Star share must be a number."),
        ("normal Star 0", {"tb_normal_star": "0"}, "Normal: the Star share must be above 0 and at most 100."),
        ("positive Super Star 101", {"tb_positive_super": "101"}, "Positively skewed: the Super Star share must be above 0 and at most 100."),
        ("positive Star 3 decimals", {"tb_positive_star": "33.501"}, "Positively skewed: the Star share can have at most 2 decimal places."),
        ("normal Super Star blank", {"tb_normal_super": ""}, "Normal: the Super Star share must be a number."),
        ("a missing field", {"tb_negative_star": None}, "Negatively skewed: the Star share must be a number.")]
for why, over, msg in bads:
    f = {k: v for k, v in dict(FORM, **over).items() if v is not None}
    rr = post(f)
    s.check("refused, naming the field, nothing saved: %s" % why,
            stored() == {} and msg in html.unescape(rr.get_data(as_text=True)), (stored(), msg))
# who may save
for who, nm in ((BOSS, "a BG CEO"), (H.actors(a)[1]["id"] if H.actors(a)[1] else None, "a BG admin")):
    if who is None:
        continue
    cw = H.client_as(a, who)
    rr = cw.post("/admin/settings", data=FORM)
    s.check("%s cannot save it (super admin only)" % nm, rr.status_code in (302, 401, 403) and stored() == {}, (rr.status_code, stored()))
ok = post(FORM)
sv = stored()
s.check("a valid save with a remark writes the five keys (one JSON for the curves), moves 12%, the Positively skewed Star at 30",
        sv.get("tb_limit_moves_on") == "1" and sv.get("tb_limit_moves_pct") == "12" and sv.get("tb_limit_stars_on") == "1"
        and json.loads(sv["tb_limit_stars"])["positive"] == {"super": 5.25, "star": 30.0}
        and json.loads(sv["tb_limit_stars"])["normal"] == {"super": 2.25, "star": 21.0}, sv)
with a.app.test_request_context("/"):
    t5 = a.get_tb_limits()
    gc5 = a.get_talent_move_cap()
s.check("...and the readers see it: moves on at 12%, Stars on, the Positively skewed Star changed (stored), the others the curves'",
        t5["moves_on"] and t5["moves_pct"] == 12.0 and t5["stars_on"] and t5["stars"]["positive"]["star"] == 30.0
        and t5["stored"]["positive"] and gc5 == (True, 12.0), t5)
alog = H.rows(a, "SELECT detail FROM activity_log WHERE action='settings' AND detail LIKE 'Talent Box limits:%' ORDER BY id DESC")
s.check("the audit line says what changed, old -> new, with the remark",
        alog and "moves on, 12% of each unit (was off)" in alog[0][0] and "Stars and Super Stars on (was off)" in alog[0][0]
        and "Positively skewed: Super Star 5.25% (was 5.25%) · Star 30% (was 33.5%)" in alog[0][0]
        and "remark: Agreed at the group calibration meeting, 3 Nov" in alog[0][0], alog[0][0] if alog else None)
same = post(FORM)
s.check("saving the same figures again changes nothing and writes no new audit line",
        "already set that way" in same.get_data(as_text=True) and len(H.rows(
            a, "SELECT 1 FROM activity_log WHERE action='settings' AND detail LIKE 'Talent Box limits:%'")) == len(alog))
page2 = cs.get("/admin/m/calibration/settings").get_data(as_text=True)
s.check("the card now reads On, with the changed figure marked Changed (outlined) and its 'Last changed' on the head",
        re.search(r'name="tb_moves_on" value="1" checked', page2) and 'value="30" data-curve-val="33.5"' in page2
        and re.search(r'class="is-changed"', page2) and re.search(r"Changed [^<]+ by ", page2), None)
with a.app.test_request_context("/"):
    from flask import session as _s
    db = a.get_db()
    _s["user_id"] = SU["id"]
    row1 = a._st_tb_limits(db, SU)
    sec_last = [x for x in a._settings_view(db, SU, "calibration") if x["id"] == "tb-limits"][0]["last"]
s.check("the All settings row reads 'Moves 12% per unit · Stars and Super Stars on', and the card has its last change (the "
        "existing _srow log mechanism)", row1 == "Moves 12% per unit · Stars and Super Stars on" and sec_last, (row1, sec_last))
off_all = {k: v for k, v in FORM.items() if k not in ("tb_moves_on", "tb_stars_on")}
post(off_all)
with a.app.test_request_context("/"):
    from flask import session as _s
    db = a.get_db()
    _s["user_id"] = SU["id"]
    row2 = a._st_tb_limits(db, SU)
s.check("a save with both switches off turns both off (the figures stay): the All settings row reads 'Off' again",
        row2 == "Off" and stored().get("tb_limit_moves_on") == "0", (row2, stored()))
s.check("the retired pieces are gone: no TALENT_MOVE_CAP_PAUSED, no 'talent_cap' action, no 'move-cap' card id",
        not hasattr(a, "TALENT_MOVE_CAP_PAUSED") and 'action == "talent_cap"' not in H.source(a) and 'id="move-cap"' not in page2)
s.check("access: admin_settings is the super admin's in ADMIN_ACCESS_MAP and 'tb_limits' is a remark-gated action",
        a.ADMIN_ACCESS_MAP.get("admin_settings") == "super" and "tb_limits" in a.SUPER_BAND_ENDPOINTS["admin_settings"])
_tpl = open(os.path.join(H.REPO, "templates/settings/cards/_tb_limits.html"), encoding="utf-8").read()
s.check("the confirm box: title 'Save the Talent Box limits?', the card's list of old -> new built as they edit, and the remark",
        'data-confirm-title="Save the Talent Box limits?"' in _tpl and "data-confirm-list" in _tpl
        and "super_remark_attrs()" in _tpl and "Use the curves' figures" in _tpl and "(was " in _tpl)

# ---------------------------------------------------------------------------
a.ai_draft.review_agent_available = _real_avail
with a.app.test_request_context("/"):   # put the shared suite database back as this suite found it
    db = a.get_db()
    scrub(db)
    for tb, mx in _ORIG["max"].items():
        db.execute("DELETE FROM %s WHERE id>?" % tb, (mx,))
    db.execute("UPDATE cycles SET half=? WHERE id=?", (_ORIG["half"], CID))
    for k, v in _ORIG["settings"].items():
        if v is None:
            db.execute("DELETE FROM app_settings WHERE key=?", (k,))
        else:
            db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)", (k, v))
    for k, v in _ORIG["modules"].items():
        db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, CID, k))
    db.commit()
sys.exit(s.done())
