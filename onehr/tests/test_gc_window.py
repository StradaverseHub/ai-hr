"""A Group Chief's Talent Box follows the BG CEO's Talent Box dates, and neither box shows before it opens (Chris, 2026-11-04).

Two decisions, one cell (tb_bgceo, production 19-30 Nov):
  1. "BG CEO dates": the Group Chief had no date gate at all (their moves, lock, lock-people, reset and the chat's move tool
     worked any time). Their tier now reads tb_bgceo: refused with the BG CEO's own sentence before it opens and after it
     closes, on the page and in the chat. A business group's late pass never opens a Group Chief's group (2026-11-07 reversed the
     rest: a Group Chief group can hold a pass of its own, scope "gc:<id>", tests/test_reopen_days.py). The super
     admin, who may use the same routes, is not held to it.
  2. "hide the view of the module until it is opened": before tb_bgceo opens every person sits on the default band (UA / Low,
     read as PIP / Improvement). A BG CEO and a Group Chief see no box, no people, no bands, no counts, no AI reading of one
     person through any door -- only the window sentence -- until it opens. After it closes the box reads as before.

Synthetic (ZZGW-*) on the shared suite database; the Talent Box window, the cycle and its modules are put back at the end.
"""
import html
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Talent Box -- the Group Chief follows the BG CEO's dates, and both stay hidden until it opens")
_real_avail = a.ai_draft.review_agent_available
a.ai_draft.review_agent_available = lambda: True
BG1 = "ZZGW Alpha Group"
CO1 = BG1 + " Sdn Bhd"
NAMES = ("ZZ GW Alpha One", "ZZ GW Alpha Two", "ZZ GW Alpha Three")


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZGW-%'")]
    gids = [r[0] for r in db.execute("SELECT id FROM pm_calibration_groups WHERE name LIKE 'ZZGW%'")]
    if gids:
        ph = ",".join("?" * len(gids))
        db.execute("DELETE FROM pm_group_locks WHERE group_id IN (%s)" % ph, gids)
        db.execute("DELETE FROM pot_group_locks WHERE group_id IN (%s)" % ph, gids)
        for tbl, adj in (("calibration_sessions", "calibration_adjustments"),
                         ("pm_calibration_sessions", "pm_calibration_adjustments")):
            db.execute("DELETE FROM %s WHERE session_id IN (SELECT id FROM %s WHERE tier='group' AND scope_key IN (%s))"
                       % (adj, tbl, ph), [str(g_) for g_ in gids])
            db.execute("DELETE FROM %s WHERE tier='group' AND scope_key IN (%s)" % (tbl, ph), [str(g_) for g_ in gids])
        db.execute("DELETE FROM talent_box_remarks WHERE business_group IN (%s)" % ph, ["group:%s" % g_ for g_ in gids])
        db.execute("DELETE FROM tb_insights WHERE scope_key IN (%s)" % ph, ["group:%s" % g_ for g_ in gids])
        db.execute("DELETE FROM pm_calibration_group_members WHERE group_id IN (%s)" % ph, gids)
        db.execute("DELETE FROM pm_calibration_groups WHERE id IN (%s)" % ph, gids)
    for tbl, adj in (("calibration_sessions", "calibration_adjustments"),
                     ("pm_calibration_sessions", "pm_calibration_adjustments")):
        db.execute("DELETE FROM %s WHERE session_id IN (SELECT id FROM %s WHERE business_group=?)" % (adj, tbl), (BG1,))
        db.execute("DELETE FROM %s WHERE business_group=?" % tbl, (BG1,))
    db.execute("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BG1,))
    db.execute("DELETE FROM talent_box_remarks WHERE business_group=?", (BG1,))
    db.execute("DELETE FROM tb_insights WHERE scope_key=?", (BG1,))
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM late_passes WHERE user_id IN (%s) OR subject_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM pm_calibration_adjustments WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM calibration_adjustments WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM talent_status_history WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ids)
        for t in ("pm_kpi_approvals", "pm_kpi_results", "pm_kpi_target_approvers"):
            db.execute("DELETE FROM %s WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s))"
                       % (t, ph), ids)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM pm_manager_chat WHERE reviewer_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG1,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG1,))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CID = a.active_cycle_id(db)
    PID = a.active_pm_period(db)["id"]
    _cleanup(db)
    _ORIG = {"cycle": {k: db.execute("SELECT %s FROM cycles WHERE id=?" % k, (CID,)).fetchone()[0]
                       for k in ("half", "open_by_date")},
             "modules": {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=? "
                                                         "AND module_key IN ('review','calibration','pm','tm')", (CID,))},
             "win": [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=? AND cell='tb_bgceo'", (CID,))]}
    db.execute("UPDATE cycles SET half=2, open_by_date=0 WHERE id=?", (CID,))
    for mk_ in ("review", "calibration", "pm", "tm"):
        db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, mk_))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, mgr=None, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=mgr,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG1, company=CO1, department="Finance",
                 years_of_service=3, confirmation_date=None, left_at=None, is_demo=0, role="user", admin_bg=None)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    BGCEO = mk("ZZGW-BGC", "ZZ GW Groupceo", bgceo_bg=BG1, department="Office")
    CHIEF = mk("ZZGW-CFO", "ZZ GW Groupcfo", department="Group Finance")
    LM = mk("ZZGW-LM", "ZZ GW Manager", department="Office")
    A1 = mk("ZZGW-A1", NAMES[0], mgr=LM)
    A2 = mk("ZZGW-A2", NAMES[1], mgr=LM)
    A3 = mk("ZZGW-A3", NAMES[2], mgr=LM)   # in the business group, not in the Group Chief's group
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG1, CO1))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (BG1,))
    for sid, val in ((A1, 100), (A2, 112), (A3, 121)):
        t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, "
                       "rate4, rate5, business_group, company, department) VALUES (?,?, 'ZZGW KPI', 100, 'more', "
                       "80,90,100,110,120, ?,?, 'x')", (PID, sid, BG1, CO1)).lastrowid
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t, LM))
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)",
                   (t, val, sid))
        db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) VALUES "
                   "(?,1,'confirm',?,?)", (t, val, LM))
    GID = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZGW Group Finance', ?)",
                     (CHIEF,)).lastrowid
    for sid in (A1, A2):
        db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id) VALUES (?,?)", (GID, sid))
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]
    NOW = a._now_myt()


def ctx(fn, uid=None, path="/"):
    with a.app.test_request_context(path):
        if uid:
            a.session["user_id"] = uid
        return fn(a.get_db())


def exe(sql, args=()):
    def f(d):
        d.execute(sql, args)
        d.commit()
    ctx(f)


def one(sql, args=()):
    return H.one(a, sql, args)


def fmt(days):
    return (NOW + timedelta(days=days)).strftime("%Y-%m-%d %H:%M")


def window(opens_days, closes_days):
    exe("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'tb_bgceo', ?, ?)",
        (CID, fmt(opens_days), fmt(closes_days)))


NOT_OPEN = (10, 20)    # opens in 10 days
OPEN = (-1, 20)
CLOSED = (-20, -1)

ids3 = (A1, A2, A3)
PH3 = ",".join("?" * 3)


def snap():
    """Everything a Talent Box write leaves behind, for the three people and the group."""
    return (one("SELECT COUNT(*) FROM pm_calibration_adjustments WHERE subject_id IN (%s)" % PH3, ids3),
            one("SELECT COUNT(*) FROM calibration_adjustments WHERE subject_id IN (%s)" % PH3, ids3),
            one("SELECT COUNT(*) FROM pm_group_locks WHERE group_id=?", (GID,)),
            one("SELECT COUNT(*) FROM pot_group_locks WHERE group_id=?", (GID,)),
            one("SELECT COUNT(*) FROM pm_calibration_sessions WHERE locked_at IS NOT NULL AND "
                "((tier='group' AND scope_key=?) OR (tier='bgceo' AND scope_key=?))", (str(GID), BG1)),
            one("SELECT COUNT(*) FROM calibration_sessions WHERE locked_at IS NOT NULL AND "
                "((tier='group' AND scope_key=?) OR (tier='bgceo' AND scope_key=?))", (str(GID), BG1)))


cfo, ceo, sup = H.client_as(a, CHIEF), H.client_as(a, BGCEO), H.client_as(a, SUP)
NAV = {"Sec-Fetch-Mode": "navigate"}
FETCH = {"Sec-Fetch-Mode": "cors"}
XHR = {"X-Requested-With": "XMLHttpRequest"}
GV = "/review/journey?view=group&stage=group_calib"
BV = "/review/journey?view=bg&stage=talent_box"
BANDS = ("UA", "BE", "ME", "AE", "OU")


def has_box(body):
    """True when a reply carries a person or a band of the box."""
    b = html.unescape(body)
    return any(n in b for n in NAMES) or "ZZGW" in b and ("performance_band" in b or '"perf"' in b)


def refused(r):
    j = r.get_json(silent=True) or {}
    return r.status_code in (400, 409) and j.get("ok") is False


def say(r):
    return ((r.get_json(silent=True) or {}).get("error") or "")


def overview(uid, stage, view):
    return ctx(lambda d: a._journey_team_overview(d, a.current_user(), stage, None, "summary"), uid,
               "/review/journey?view=%s&stage=%s" % (view, stage))


def box_data(uid, stage, view):
    return (overview(uid, stage, view) or {}).get("data")


def turn(client, stage, view, msg=""):
    return client.post("/review/chat", data={"csrf_token": "tok", "message": msg, "journey": "1", "view": view,
                                             "stage": stage, "mode": "summary"}).get_json() or {}


try:
    s.section("the cell: the Group Chief reads the BG CEO's dates, no new cell")
    s.check("the group tier is on both axes' cell map, and it is the Talent Box's cell",
            a._WINDOW_TIER_PM.get("group") == "tb_bgceo" and a._WINDOW_TIER_POT.get("group") == "tb_bgceo")
    s.check("no cell of its own: the calendar rows are unchanged", [c[0] for c in a.WINDOW_CELLS if "group" in c[0]] == [])

    # =======================================================================
    s.section("not open yet (19 Nov): every Group Chief write refused with the BG CEO's sentence, nothing written")
    window(*NOT_OPEN)
    before = snap()
    sentence = ctx(lambda d: a.window_closed(d, "tb_bgceo"))
    s.check("the BG CEO's sentence says when it opens", sentence and "opens" in sentence and "Talent Box" in sentence,
            sentence)
    mv = {"csrf_token": "tok", "ajax": "1", "subject_id": A1, "performance_band": "AE", "potential_band": "", "justification": ""}
    r = cfo.post("/talent-box/group/%d/move" % GID, data=mv, headers=XHR)
    s.check("the Talent Box move route refuses", refused(r) and sentence == say(r), (r.status_code, say(r)))
    r = cfo.post("/performance/calibration/group/%d/adjust" % GID, data={"csrf_token": "tok", "ajax": "1", "subject_id": A1,
                                                                         "adjusted_band": "AE"})
    s.check("the performance adjust route refuses", refused(r) and sentence == say(r), (r.status_code, say(r)))
    r = cfo.post("/performance/calibration/group/%d/reset" % GID, data={"csrf_token": "tok", "ajax": "1"})
    s.check("the reset route refuses", refused(r) and sentence == say(r), (r.status_code, say(r)))
    r = cfo.post("/performance/calibration/group/%d/lock" % GID, data={"csrf_token": "tok", "ajax": "1"})
    s.check("the performance lock route refuses", refused(r) and sentence == say(r), (r.status_code, say(r)))
    r = cfo.post("/performance/calibration/group/%d/lock-people" % GID, data={"csrf_token": "tok", "ajax": "1", "sid": [A1, A2]})
    s.check("lock-people refuses", refused(r) and sentence == say(r), (r.status_code, say(r)))
    r = cfo.post("/talent-box/group/%d/lock" % GID, data={"csrf_token": "tok", "ajax": "1"})
    s.check("the whole group's Lock refuses", refused(r) and sentence == say(r), (r.status_code, say(r)))
    s.check("...and nothing was written: no band, no lock, no session locked", snap() == before, (before, snap()))
    # the writers themselves (the request gate is the first line, these are the second): a late pass, a chat, any caller
    GCTX = lambda d: a._talent_box_resolve(d, a.current_user(), "group", group_id=GID)   # noqa: E731
    ok_msg = ctx(lambda d: a._talent_box_apply(d, a.current_user(), "group", GCTX(d), A1, "AE", "", ""), CHIEF,
                 "/talent-box/group/%d" % GID)
    s.check("_talent_box_apply (the page's and the chat's one writer) refuses with the sentence",
            ok_msg[0] is False and ok_msg[1] == sentence, ok_msg)
    s.check("window_closed_tier for the group tier says the same on either axis",
            all(ctx(lambda d, ax=ax: a.window_closed_tier(d, "group", ax), CHIEF) == sentence for ax in ("pm", "pot", "both")))
    pm_apply = ctx(lambda d: a._pm_calib_apply(d, a.current_user(), a._pm_calib_resolve(d, a.current_user(), "group", group_id=GID),
                                               "group", A1, "AE", ""), CHIEF, "/performance/calibration/group/%d" % GID)
    s.check("_pm_calib_apply (the performance writer, and the chat's move_band) refuses", pm_apply[1] == sentence, pm_apply)
    gl = ctx(lambda d: a.group_lock_people(d, a.current_user(), a._pm_calib_resolve(d, a.current_user(), "group", group_id=GID),
                                           GID, [A1]), CHIEF, "/performance/calibration/group/%d" % GID)
    s.check("group_lock_people (every Group Chief lock) refuses by itself", gl == ([], [sentence]) and snap() == before, gl)
    tool = ctx(lambda d: a._journey_team_run_stage_tool(d, a.current_user(), CID, "group_calib", None,
                                                       {"tool": "move_person", "args": {"subject": NAMES[0], "performance_band": "OU"}}),
               CHIEF, GV)
    s.check("the chat's move_person tool refuses with the sentence", tool.get("ok") is False and sentence in (tool.get("error") or ""),
            tool)
    s.check("the Group view's card note and the chat box lock carry the sentence",
            ctx(lambda d: a._journey_window_note(d, a.current_user(), "group_calib"), CHIEF, GV) == sentence
            and ctx(lambda d: a._journey_window_note(d, a.current_user(), "group_calib", chat=True), CHIEF, GV) == sentence)
    s.check("a BG CEO late pass for the business group is not what opens it for them: not open is its own (no pass applies)",
            ctx(lambda d: a._journey_window_note(d, a.current_user(), "talent_box"), BGCEO, BV) == sentence)

    s.section("not open yet: the BG CEO's own writes still refused (unchanged)")
    r = ceo.post("/talent-box/bg/%s/move" % BG1, data=mv, headers=XHR)
    s.check("the BG CEO's move refuses with the same sentence", refused(r) and sentence == say(r), (r.status_code, say(r)))
    bctx = lambda d: a._talent_box_resolve(d, a.current_user(), "bgceo", bg=BG1)   # noqa: E731
    bm = ctx(lambda d: a._talent_box_apply(d, a.current_user(), "bgceo", bctx(d), A1, "AE", "", ""), BGCEO, "/talent-box/bg/x")
    s.check("_talent_box_apply for the BG CEO refuses too", bm[0] is False and bm[1] == sentence, bm)

    # =======================================================================
    s.section("hidden until it opens: every door, for the Group Chief and for the BG CEO")
    GET_DOORS = {
        CHIEF: ["/talent-box/group/%d" % GID, "/talent-box/group/%d/pip" % GID, "/talent-box/group/%d/promotion" % GID,
                "/performance/calibration/group/%d" % GID],
        BGCEO: ["/talent-box/bg/%s" % BG1, "/talent-box/bg/%s/pip" % BG1, "/talent-box/bg/%s/promotion" % BG1,
                "/performance/calibration/bg/%s" % BG1, "/calibration/bg"]}
    cli = {CHIEF: cfo, BGCEO: ceo}
    for uid, paths in GET_DOORS.items():
        who = "Group Chief" if uid == CHIEF else "BG CEO"
        for p in paths:
            rf = cli[uid].get(p, headers=FETCH)
            rn = cli[uid].get(p, headers=NAV)
            archived = p.endswith(("/pip", "/promotion"))   # the PIP / promotion lists were archived 2026-10-13: a redirect first
            s.check("%s: a fetch of %s gets the sentence and no one" % (who, p),
                    (rf.status_code == 409 and sentence == say(rf) or (archived and rf.status_code in (302, 404)))
                    and not has_box(rf.get_data(as_text=True)), (rf.status_code, rf.get_data(as_text=True)[:100]))
            s.check("%s: opening %s as a page shows no box (a redirect, never the page)" % (who, p),
                    rn.status_code == 302 and not has_box(rn.get_data(as_text=True)), rn.status_code)
    # the journey
    for uid, stage, view, label in ((CHIEF, "group_calib", "group", "Group Chief"), (BGCEO, "talent_box", "bg", "BG CEO")):
        ov = overview(uid, stage, view)
        s.check("%s: the card's data is empty, the note is the sentence, the chat box locks" % label,
                ov.get("data") is None and ov.get("window_note") == sentence and ov.get("chat_lock") == sentence, ov)
        nav = ctx(lambda d: a._journey_team_nav_items(d, a.current_user(), stage), uid, "/review/journey?view=%s&stage=%s" % (view, stage))
        s.check("%s: the left panel lists no unit or person and says when it opens" % label,
                nav["items"] == [] and nav.get("queue") is None and (nav.get("opens") or "").startswith("Opens"), nav)
        views = ctx(lambda d: a._journey_leader_views(d, a.current_user()), uid)
        s.check("%s: the tab stays (the view and its stage exist)" % label, view in views, views)
        h = cli[uid].get("/review/chat/history?journey=1&view=%s&stage=%s&mode=summary" % (view, stage))
        hj = h.get_json() or {}
        s.check("%s: the history endpoint holds no box" % label, h.status_code == 200
                and (hj.get("overview") or {}).get("data") is None and not has_box(h.get_data(as_text=True)), h.status_code)
        s.check("%s: the left panel HTML holds no one" % label, not has_box(hj.get("nav_html") or ""))
    # an old line of the chat that holds head-counts is not replayed
    exe("INSERT INTO pm_manager_chat(reviewer_id, cycle_id, report_id, stage, role, content, scope) VALUES (?,?,NULL,'group_calib','agent',"
        "'Here is your Talent Box for ZZGW Group Finance: 2 people placed.',?)",
        (CHIEF, CID, ctx(lambda d: a._mchat_scope("group_calib"), CHIEF, GV)))
    hj = cfo.get("/review/chat/history?journey=1&view=group&stage=group_calib&mode=summary").get_json() or {}
    s.check("an earlier chat line that held head-counts is not replayed", hj.get("messages") == [], hj.get("messages"))
    # the chat turn
    for uid, stage, view, label in ((CHIEF, "group_calib", "group", "Group Chief"), (BGCEO, "talent_box", "bg", "BG CEO")):
        for msg in ("", "show me the box", "who is on UA?", "lock the talent box"):
            j = turn(cli[uid], stage, view, msg)
            body = str(j)
            s.check("%s: the chat turn %r answers with the sentence only, no box, nothing stored" % (label, msg),
                    j.get("ok") and j.get("say") == sentence and (j.get("overview") or {}).get("data") is None
                    and not has_box(body) and one("SELECT COUNT(*) FROM pm_manager_chat WHERE reviewer_id=? AND stage=? "
                                                  "AND role='user'", (uid, stage)) == 0, (msg, j.get("say")))
    # person-level fetches
    for uid, view, label in ((CHIEF, "group", "Group Chief"), (BGCEO, "bg", "BG CEO")):
        for ep, extra in (("tbox-person", {}), ("tbox-insight", {}), ("tbox-remark", {"remark": "Strong year."}),
                          ("calib-summary", {"report": A1}), ("pot-summary", {"report": A1}),
                          ("insights", {"kind": "perf", "ids": str(A1)})):
            data = dict({"csrf_token": "tok", "person": A1, "view": view}, **extra)
            r = cli[uid].post("/review/team/" + ep, data=data)
            s.check("%s: /review/team/%s answers the sentence, no reading" % (label, ep),
                    r.status_code == 409 and sentence == say(r) and not has_box(r.get_data(as_text=True)), r.status_code)
    s.check("no AI reading or remark was stored", one("SELECT COUNT(*) FROM tb_insights WHERE subject_id IN (%s)" % PH3, ids3) == 0
            and one("SELECT COUNT(*) FROM talent_box_remarks WHERE subject_id IN (%s)" % PH3, ids3) == 0)
    # the tools
    for uid, stage in ((CHIEF, "group_calib"), (BGCEO, "talent_box")):
        for act in ({"tool": "show_box"}, {"tool": "explain_person", "args": {"subject": NAMES[0]}},
                    {"tool": "open_person", "args": {"subject": NAMES[0]}}, {"tool": "past_talent", "args": {"subject": NAMES[0]}}):
            r = ctx(lambda d: a._journey_team_run_stage_tool(d, a.current_user(), CID, stage, None, act), uid, GV)
            s.check("the chat's %s tool for %s reads nothing and says when" % (act["tool"], stage),
                    r.get("ok") is False and sentence in (r.get("error") or "") and NAMES[0] not in str(r), r)
    # the person reports behind the box
    can = lambda who, subj: ctx(lambda d: a.calibration_can_view_subject(d, a.current_user(), subj), who)   # noqa: E731
    s.check("the BG CEO and the Group Chief may not open a person's calibration reports yet",
            can(BGCEO, A1) is False and can(CHIEF, A1) is False and can(BGCEO, A3) is False)
    s.check("...nor by the report routes", cfo.get("/calibration/subject/%d/kpi-report" % A1).status_code == 403
            and ceo.get("/calibration/subject/%d/potential-report" % A3).status_code == 403)
    s.check("the super admin can", can(SUP, A1) is True)
    # the stage and the dashboard keep their face, with no head-count
    st = ctx(lambda d: a._journey_group_stage(), CHIEF, GV)
    s.check("the Group Chief's stage stays, with no head-count of the group", st and st["key"] == "group_calib"
            and st["n_total"] == 1 and st["n_open"] == 1, st)
    card = ctx(lambda d: a.dash_group_calib(d, a.current_user()), CHIEF, "/dashboard")
    s.check("the Group Chief's dashboard card says when it opens and lists nothing pending", card
            and card["sub"].startswith("Opens") and card["pending"] == [], card)
    s.check("the BG CEO's pending counts are none while it is not open",
            ctx(lambda d: a._talent_box_pending_count(d, a.current_user()), BGCEO) == 0)
    s.check("the classic chooser shows no head-count for the BG CEO's or the group's scope",
            ctx(lambda d: a._tb_hidden_msg(d, a.current_user()), BGCEO) == sentence)
    s.check("the background pre-run still reads the scope (nothing shows)",
            ctx(lambda d: a._journey_talent_box_scope(d, a.current_user(), tier="group", exists=True), CHIEF, GV)
            and ctx(lambda d: a._journey_talent_box_scope(d, a.current_user(), tier="bgceo", exists=True), BGCEO, BV))

    s.section("not affected while it is not open: the super admin, the admin Talent Box, a stranger")
    r = sup.get("/talent-box/group/%d" % GID, headers=NAV)
    s.check("the super admin opens the group's box page and sees it", r.status_code == 200
            and any(n in html.unescape(r.get_data(as_text=True)) for n in NAMES), r.status_code)
    r = sup.get("/talent-box/bg/%s" % BG1, headers=FETCH)
    s.check("...and the BG CEO's", r.status_code == 200 and NAMES[0] in html.unescape(r.get_data(as_text=True)), r.status_code)
    r = sup.get("/admin/calibration/talent-box?bg=%s" % BG1.replace(" ", "+"), headers=NAV)
    s.check("the admin's read-only Talent Box is not held back", r.status_code == 200, r.status_code)
    s.check("the super admin's own box scope, read as a Group Chief's, is not hidden",
            ctx(lambda d: a._tb_hidden_msg(d, a.current_user()), SUP) is None
            and ctx(lambda d: a.window_closed_tier(d, "group", "both"), SUP) is None)
    r = sup.post("/talent-box/group/%d/move" % GID, data=dict(mv, justification="Super admin's own call", remark="Group People's own call on the group."),
                 headers=XHR)
    s.check("the super admin may still move on the group's route (shared with the Group Chief): not held to their window",
            (r.get_json() or {}).get("ok"), (r.status_code, r.get_data(as_text=True)[:120]))
    exe("DELETE FROM pm_calibration_adjustments WHERE subject_id=?", (A1,))
    exe("DELETE FROM calibration_adjustments WHERE subject_id=?", (A1,))
    # a stranger keeps the route's own 403
    r = H.client_as(a, A3).get("/talent-box/bg/%s" % BG1, headers=FETCH)
    s.check("someone who is neither seat keeps the route's own 403 (the gate says nothing to them)", r.status_code == 403,
            r.status_code)

    # =======================================================================
    s.section("falsify the guards: each one removed, the suite's own check would fail")
    saved_pm, saved_pot = a._WINDOW_TIER_PM.pop("group"), a._WINDOW_TIER_POT.pop("group")
    gone = ctx(lambda d: a.window_closed_tier(d, "group", "both"), CHIEF)
    a._WINDOW_TIER_PM["group"], a._WINDOW_TIER_POT["group"] = saved_pm, saved_pot
    s.check("FALSIFIED: without the 'group' key the Group Chief is let through (so the refusals above are that key's)",
            gone is None, gone)
    _real_hidden = a._tb_hidden_msg
    a._tb_hidden_msg = lambda db, u=None: None
    leaked = box_data(CHIEF, "group_calib", "group")
    leaked_h = cfo.get("/review/chat/history?journey=1&view=group&stage=group_calib&mode=summary").get_json() or {}
    leaked_r = can(CHIEF, A1)
    a._tb_hidden_msg = _real_hidden
    s.check("FALSIFIED: without _tb_hidden_msg the box, its history line and the reports all read (so the hiding is that one function)",
            bool(leaked) and bool(leaked_h.get("messages")) and leaked_r is True,
            (bool(leaked), bool(leaked_h.get("messages")), leaked_r))
    _real_eps = a._TB_HIDE_ENDPOINTS
    a._TB_HIDE_ENDPOINTS = frozenset()
    open_page = ceo.get("/talent-box/bg/%s" % BG1, headers=FETCH)
    a._TB_HIDE_ENDPOINTS = _real_eps
    s.check("FALSIFIED: without the request gate the classic box page renders for the BG CEO (so the gate is what hides it)",
            open_page.status_code == 200 and NAMES[0] in html.unescape(open_page.get_data(as_text=True)), open_page.status_code)
    s.check("the same page, with the gate back, is hidden again", ceo.get("/talent-box/bg/%s" % BG1, headers=FETCH).status_code == 409)

    # =======================================================================
    s.section("open (19-30 Nov): the Group Chief moves and locks, the BG CEO moves, the box renders")
    window(*OPEN)
    s.check("no sentence, no hiding", ctx(lambda d: a.window_closed(d, "tb_bgceo")) is None
            and ctx(lambda d: a._tb_hidden_msg(d, a.current_user()), CHIEF) is None)
    d_ = box_data(CHIEF, "group_calib", "group")
    s.check("the Group Chief's box renders with the group's people, a band each",
            d_ and d_.get("axis") == "talent_box" and {p["id"] for c in d_["cells"] for p in c["people"]} == {A1, A2}, bool(d_))
    d_ = box_data(BGCEO, "talent_box", "bg")
    s.check("the BG CEO's box renders with the business group's people",
            d_ and {A1, A2, A3} <= {p["id"] for c in d_["cells"] for p in c["people"]}, bool(d_))
    nav = ctx(lambda d: a._journey_team_nav_items(d, a.current_user(), "group_calib"), CHIEF, GV)
    s.check("the left panel lists the group again, with no 'opens'", nav["items"] and not nav.get("opens"), nav)
    s.check("the stage counts the group again", ctx(lambda d: a._journey_group_stage(), CHIEF, GV)["n_total"] == 2)
    for p in ("/talent-box/group/%d" % GID, "/performance/calibration/group/%d" % GID):
        r = cfo.get(p, headers=FETCH)
        s.check("the classic page %s renders for the Group Chief" % p, r.status_code == 200
                and NAMES[0] in html.unescape(r.get_data(as_text=True)), r.status_code)
    s.check("the BG CEO's classic page renders", ceo.get("/talent-box/bg/%s" % BG1, headers=FETCH).status_code == 200)
    s.check("a person's reports open for them", can(CHIEF, A1) is True and can(BGCEO, A3) is True)
    j = turn(cfo, "group_calib", "group", "")
    s.check("the opener is the box's own, not the sentence", j.get("ok") and j.get("say") != sentence
            and (j.get("overview") or {}).get("data"), (j.get("say") or "")[:80])
    r = cfo.post("/talent-box/group/%d/move" % GID, data=mv, headers=XHR)
    s.check("the Group Chief's move saves", (r.get_json() or {}).get("ok"), (r.status_code, r.get_data(as_text=True)[:120]))
    s.check("...as the group's call", one("SELECT COUNT(*) FROM pm_calibration_adjustments a JOIN pm_calibration_sessions c ON "
                                         "c.id=a.session_id WHERE c.tier='group' AND c.scope_key=? AND a.subject_id=?",
                                         (str(GID), A1)) == 1)
    r = cfo.post("/performance/calibration/group/%d/lock-people" % GID, data={"csrf_token": "tok", "ajax": "1", "sid": [A2]})
    s.check("lock-people locks (JSON)", (r.get_json() or {}).get("ok") and one(
        "SELECT COUNT(*) FROM pm_group_locks WHERE group_id=? AND subject_id=?", (GID, A2)) == 1, r.get_data(as_text=True)[:140])
    r = ceo.post("/talent-box/bg/%s/move" % BG1, data=dict(mv, subject_id=A3, performance_band="ME"), headers=XHR)
    s.check("the BG CEO's move saves, as before", (r.get_json() or {}).get("ok"), (r.status_code, r.get_data(as_text=True)[:120]))
    r = cfo.post("/talent-box/group/%d/lock" % GID, data={"csrf_token": "tok", "ajax": "1"})
    s.check("the Group Chief's Lock locks the whole group", (r.get_json() or {}).get("ok") and one(
        "SELECT COUNT(*) FROM pm_group_locks WHERE group_id=?", (GID,)) == 2, r.get_data(as_text=True)[:140])
    exe("DELETE FROM pm_group_locks WHERE group_id=?", (GID,))
    exe("DELETE FROM pot_group_locks WHERE group_id=?", (GID,))
    exe("UPDATE pm_calibration_sessions SET locked_at=NULL, locked_by=NULL WHERE tier='group' AND scope_key=?", (str(GID),))
    exe("UPDATE calibration_sessions SET locked_at=NULL, locked_by=NULL WHERE tier='group' AND scope_key=?", (str(GID),))

    # =======================================================================
    s.section("closed (after 30 Nov): refused with 'closed', the box still reads, a business group's late pass opens no Group Chief's box")
    window(*CLOSED)
    closed_s = ctx(lambda d: a.window_closed(d, "tb_bgceo"))
    s.check("the sentence says it closed", closed_s and "closed" in closed_s, closed_s)
    before = snap()
    r = cfo.post("/talent-box/group/%d/move" % GID, data=dict(mv, subject_id=A2), headers=XHR)
    s.check("the Group Chief's move is refused 'closed' (page route)", refused(r) and closed_s == say(r), (r.status_code, say(r)))
    gm = ctx(lambda d: a._talent_box_apply(d, a.current_user(), "group", GCTX(d), A2, "AE", "", ""), CHIEF,
             "/talent-box/group/%d" % GID)
    s.check("...and in _talent_box_apply", gm[0] is False and gm[1] == closed_s, gm)
    tool = ctx(lambda d: a._journey_team_run_stage_tool(d, a.current_user(), CID, "group_calib", None,
                                                       {"tool": "move_person", "args": {"subject": NAMES[1], "performance_band": "OU"}}),
               CHIEF, GV)
    s.check("...and in the chat's move tool (it reaches the same writer)", tool.get("ok") is False
            and closed_s in (tool.get("error") or ""), tool)
    s.check("the card's note says closed and the chat box locks", ctx(
        lambda d: a._journey_window_note(d, a.current_user(), "group_calib", chat=True), CHIEF, GV) == closed_s)
    s.check("not hidden: it reads after the deadline", ctx(lambda d: a._tb_hidden_msg(d, a.current_user()), CHIEF) is None
            and bool(box_data(CHIEF, "group_calib", "group")) and bool(box_data(BGCEO, "talent_box", "bg")))
    r = cfo.get("/talent-box/group/%d" % GID, headers=FETCH)
    s.check("...the classic page renders read only", r.status_code == 200 and NAMES[0] in html.unescape(r.get_data(as_text=True)),
            r.status_code)
    j = turn(cfo, "group_calib", "group", "show me the box")
    s.check("...and the chat answers closed, not hidden", j.get("say", "").startswith(closed_s), j.get("say"))
    # late passes: a BG CEO's, for a business group
    exe("INSERT INTO late_passes(cycle_id, user_id, cell, scope_key, tier, business_group, until_at, reason) "
        "VALUES (?,?, 'tb_bgceo', ?, 'bgceo', ?, datetime('now','+3 days'), 'ZZGW pass')", (CID, BGCEO, BG1, BG1))
    s.check("the BG CEO's own pass for their business group reopens THEIR box (unchanged)",
            ctx(lambda d: a.window_closed_tier(d, "bgceo", "both", scope=[BG1]), BGCEO) is None
            and ctx(lambda d: a.window_closed_tier(d, "bgceo", "both", scope=[BG1]), CHIEF) == closed_s)
    exe("INSERT INTO late_passes(cycle_id, user_id, cell, scope_key, tier, business_group, until_at, reason) "
        "VALUES (?,?, 'tb_bgceo', ?, 'bgceo', ?, datetime('now','+3 days'), 'ZZGW pass')", (CID, CHIEF, BG1, BG1))
    exe("INSERT INTO late_passes(cycle_id, user_id, cell, scope_key, tier, business_group, until_at, reason) "
        "VALUES (?,?, 'tb_bgceo', ?, 'group', ?, datetime('now','+3 days'), 'ZZGW pass')", (CID, CHIEF, str(GID), BG1))
    # (reversed by Chris, 2026-11-07: a Group Chief group CAN hold a pass of its own, scope "gc:<group id>", tests/test_reopen_days.py;
    # what stays true here is that a business group's pass, or one keyed by the bare group id, opens no Group Chief's group)
    s.check("a pass for the business group, and one keyed by the bare group id (no 'gc:'), hold no Group Chief's group open: refused "
            "for every scope a writer asks (the page-level read with no scope asks 'any pass', as for every tier)",
            all(ctx(lambda d, sc=sc: a.window_closed_tier(d, "group", "both", scope=sc), CHIEF) == closed_s
                for sc in ([BG1], [str(GID)], [BG1, str(GID)], [])))
    s.check("...while the pass is real, for the cell, with any scope (this is what the scope must beat)",
            ctx(lambda d: a.window_closed(d, "tb_bgceo", scope=None), CHIEF) is None
            and ctx(lambda d: a.window_closed(d, "tb_bgceo", scope=[BG1]), CHIEF) is None)
    r = cfo.post("/talent-box/group/%d/move" % GID, data=dict(mv, subject_id=A2), headers=XHR)
    s.check("the request gate lets a holder of such a pass through (it asks with no scope), the WRITER refuses 'closed'",
            r.get_json() and r.get_json().get("ok") is False and closed_s in say(r) and snap() == before, (r.status_code, say(r)))
    r = cfo.post("/performance/calibration/group/%d/lock-people" % GID, data={"csrf_token": "tok", "ajax": "1", "sid": [A2]})
    s.check("lock-people, with such a pass, is refused by its own check", (r.get_json() or {}).get("ok") is False
            and closed_s in say(r) and snap() == before, r.get_data(as_text=True)[:140])
    r = cfo.post("/talent-box/group/%d/lock" % GID, data={"csrf_token": "tok", "ajax": "1"})
    s.check("the whole-group Lock, with such a pass, is refused too", (r.get_json() or {}).get("ok") is False
            and snap() == before, r.get_data(as_text=True)[:140])
    r = cfo.post("/performance/calibration/group/%d/reset" % GID, data={"csrf_token": "tok", "ajax": "1"})
    s.check("so is the reset", snap() == before)
    s.check("...and the chat note never offers the Group Chief a pass's amber line",
            ctx(lambda d: a._late_note_for(d, a.current_user(), "group_calib", 0), CHIEF, GV) is None)
    exe("DELETE FROM late_passes WHERE reason='ZZGW pass'")
    s.check("the BG CEO, before the pass, is refused 'closed' (unchanged)",
            ctx(lambda d: a.window_closed_tier(d, "bgceo", "both", scope=[BG1]), BGCEO) == closed_s)

    # =======================================================================
    s.section("the dashboard cards: nothing of the Talent Box until it opens, then as before (Chris 4 Nov)")
    for t_ in ("pm_calibration_sessions", "calibration_sessions"):   # the BU CEO locked both calibrations (cleaned with BG1)
        exe("INSERT INTO %s(cycle_id, tier, scope_key, business_group, scope_label, locked_at) VALUES "
            "(?,'buceo',?,?,'ZZGW unit',datetime('now'))" % t_, (CID, CO1, BG1))

    def cards():
        cyc_ = ctx(lambda d: dict(d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()))
        return (ctx(lambda d: a.dash_group_status(d, a.current_user(), cyc_), CHIEF),
                ctx(lambda d: a.dash_bg_status(d, a.current_user(), cyc_), BGCEO))

    def page(client):
        return html.unescape(client.get("/dashboard", headers=NAV).get_data(as_text=True))
    PILLS = ("Ready to lock", "Calibrating", "every rating is final", "calibration locked", "2 people", "ready")
    window(*NOT_OPEN)
    opens_word = ctx(lambda d: a._lead_say(*a._lead_window(d, None, ["tb_bgceo"], CID)))
    g_, b_ = cards()
    s.check("not open: both cards carry only the window line, no rows and no counts",
            opens_word.startswith("Opens ") and all(c and c["hidden"] == opens_word and c["units"] == [] and c["total"] == 0
                                                  and c["ready"] == 0 and c["locked"] == 0 for c in (g_, b_)), (g_, b_))
    for who, cl, cname in (("Group Chief", cfo, "group"), ("BG CEO", ceo, "bg")):
        body = page(cl)
        k = body.find("Where your group is" if cname == "group" else "Where the group is")
        card = body[k:k + 6000] if k >= 0 else ""
        s.check("not open: %s's dashboard has the card with the window line, and no unit or batch, count or pill" % who,
                k >= 0 and opens_word in card and CO1 not in card and "Finance" not in card.split("</section>")[0]
                and not any(w in card.split("</section>")[0] for w in PILLS), (k, card[:300]))
    window(*OPEN)
    g_, b_ = cards()
    s.check("open: both cards are as before, 'Ready to lock' and counted",
            not g_.get("hidden") and not b_.get("hidden") and g_["units"][0]["word"] == "Ready to lock"
            and g_["ready"] == 1 and b_["units"][0]["word"] == "Ready to lock" and b_["ready"] == 1, (g_, b_))
    s.check("open: the dashboard draws the rows", "Ready to lock" in page(cfo) and "Ready to lock" in page(ceo))
    window(*CLOSED)
    g_, b_ = cards()
    s.check("closed: as before", not g_.get("hidden") and not b_.get("hidden")
            and g_["units"][0]["word"] == "Ready to lock" and b_["units"][0]["word"] == "Ready to lock", (g_, b_))
    exe("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='tb_bgceo'", (CID,))
    g_, b_ = cards()
    s.check("no start date: 'Not open yet' (or as before if the cycle's own rule opens it)",
            (g_.get("hidden") or "Open") == (b_.get("hidden") or "Open") and g_.get("hidden") in (None, "Not open yet"),
            (g_.get("hidden"), b_.get("hidden")))
    window(*NOT_OPEN)
    _real_lw = a._lead_window
    a._lead_window = lambda *x, **k: ("open", None)
    g_, b_ = cards()
    leak = page(cfo)
    a._lead_window = _real_lw
    s.check("FALSIFIED: without the window read both cards show their rows and 'Ready to lock' (so the guard is that read)",
            g_["units"] and b_["units"] and g_["units"][0]["word"] == "Ready to lock" and "Ready to lock" in leak,
            (g_, b_))
    s.check("the guard is back", cards()[0].get("hidden") == opens_word)
finally:
    a.ai_draft.review_agent_available = _real_avail
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='tb_bgceo'", (CID,))
        for w in _ORIG["win"]:
            db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                       (CID, w["cell"], w["opens_at"], w["closes_at"]))
        db.execute("UPDATE cycles SET half=?, open_by_date=? WHERE id=?",
                   (_ORIG["cycle"]["half"], _ORIG["cycle"]["open_by_date"], CID))
        for k, v in _ORIG["modules"].items():
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, CID, k))
        db.commit()

sys.exit(s.done())
