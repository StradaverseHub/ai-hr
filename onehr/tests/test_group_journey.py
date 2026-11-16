"""The Group Chief's Talent Box calibration and the BG CEO's group tags.

A Group Chief (pm_calibration_groups.calibrator_id) gets a Group view in the review journey at Year-End: one part, the
Talent Box calibration -- the BG CEO's own card (Chris, 2026-10-13: "for the group chief AI+calibration, it should follow
the same look as the BGCEO talent box calibration, and it should also be called as talent box calibration for Group
Chief") for their calibration group as ONE unit ("loop all selected department or individual for the group chief under
one 'BU' for Group Chief calibration"): the 9-box, the group's departments in one row, the BG CEO's side beside each
person, a move through the group box's own route, and one Lock for the whole group -- their call on everyone, both axes,
to the super admin's Final bands. A Group Chief has no review of their own, like a BG CEO (Chris, 2026-10-13). The
classic group page sends its Group Chief here; the super admin keeps it. In a BG CEO's Talent Box, everyone in a Group
Chief's scope carries a tag: the scope, the Group Chief's call and lock, the final band.

Synthetic (ZZGJ-*) on the shared suite database; everything is put back at the end.
"""
import html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Group view -- the Group Chief's Talent Box calibration, one Lock, the BG CEO's tags")
_real_avail = a.ai_draft.review_agent_available
a.ai_draft.review_agent_available = lambda: True
BG1, BG2 = "ZZGJ Alpha Group", "ZZGJ Beta Group"
CO1, CO1B, CO2 = BG1 + " Sdn Bhd", BG1 + " Two Sdn Bhd", BG2 + " Sdn Bhd"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZGJ-%'")]
    gids = [r[0] for r in db.execute("SELECT id FROM pm_calibration_groups WHERE name LIKE 'ZZGJ%'")]
    if gids:
        ph = ",".join("?" * len(gids))
        db.execute("DELETE FROM pm_group_locks WHERE group_id IN (%s)" % ph, gids)
        db.execute("DELETE FROM pot_group_locks WHERE group_id IN (%s)" % ph, gids)
        db.execute("DELETE FROM calibration_adjustments WHERE session_id IN (SELECT id FROM calibration_sessions "
                   "WHERE tier='group' AND scope_key IN (%s))" % ph, [str(g_) for g_ in gids])
        db.execute("DELETE FROM calibration_sessions WHERE tier='group' AND scope_key IN (%s)" % ph,
                   [str(g_) for g_ in gids])
        db.execute("DELETE FROM talent_box_remarks WHERE business_group IN (%s)" % ph, ["group:%s" % g_ for g_ in gids])
        db.execute("DELETE FROM tb_insights WHERE scope_key IN (%s)" % ph, ["group:%s" % g_ for g_ in gids])
        db.execute("DELETE FROM pm_calibration_adjustments WHERE session_id IN (SELECT id FROM pm_calibration_sessions "
                   "WHERE tier='group' AND scope_key IN (%s))" % ph, [str(g_) for g_ in gids])
        db.execute("DELETE FROM pm_calibration_sessions WHERE tier='group' AND scope_key IN (%s)" % ph,
                   [str(g_) for g_ in gids])
        db.execute("DELETE FROM app_settings WHERE key IN (%s)" % ph, ["calib_group_mode:%s" % g_ for g_ in gids])
        db.execute("DELETE FROM pm_calibration_group_members WHERE group_id IN (%s)" % ph, gids)
        db.execute("DELETE FROM pm_calibration_groups WHERE id IN (%s)" % ph, gids)
    if ids:
        ph = ",".join("?" * len(ids))
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
    db.execute("DELETE FROM pm_calibration_sessions WHERE business_group IN (?,?)", (BG1, BG2))
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
                                                         "AND module_key IN ('review','calibration','pm')", (CID,))}}
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','calibration','pm')",
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

    CHIEF = mk("ZZGJ-CFO", "ZZ GJ Groupcfo", BG1, CO1, "Group Finance")
    LM = mk("ZZGJ-LM", "ZZ GJ Manager", BG1, CO1, "Office")
    A1 = mk("ZZGJ-A1", "ZZ GJ Alpha One", BG1, CO1, "Finance", mgr=LM)
    A2 = mk("ZZGJ-A2", "ZZ GJ Alpha Two", BG1, CO1, "Finance", mgr=LM)
    A3 = mk("ZZGJ-A3", "ZZ GJ Alpha Three", BG1, CO1B, "Finance", mgr=LM)
    B1 = mk("ZZGJ-B1", "ZZ GJ Beta One", BG2, CO2, "Accounts", mgr=LM)
    NOTFIN = mk("ZZGJ-N1", "ZZ GJ Not Final", BG2, CO2, "Accounts", mgr=LM)
    for bg, co in ((BG1, CO1), (BG1, CO1B), (BG2, CO2)):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (bg, co))
    for bg in (BG1, BG2):
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (bg,))
    for sid, val, final in ((A1, 100, True), (A2, 112, True), (A3, 100, True), (B1, 121, True), (NOTFIN, 100, False)):
        u_ = db.execute("SELECT business_group, company FROM users WHERE id=?", (sid,)).fetchone()
        t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, "
                       "rate3, rate4, rate5, business_group, company, department) VALUES (?,?, 'ZZGJ KPI', 100, 'more', "
                       "80,90,100,110,120, ?,?, 'x')", (PID, sid, u_[0], u_[1])).lastrowid
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t, LM))
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)",
                   (t, val, sid))
        if final:
            db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) VALUES "
                       "(?,1,'confirm',?,?)", (t, val, LM))
    GID = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZGJ Group Finance', ?)",
                     (CHIEF,)).lastrowid
    for sid in (A1, A2, A3, B1, NOTFIN):
        db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id) VALUES (?,?)", (GID, sid))
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]


def as_user(uid, path="/", fn=None):
    with a.app.test_request_context(path):
        a.session["user_id"] = uid
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
        return fn(db, u)


cfo = H.client_as(a, CHIEF)
NAV = {"Sec-Fetch-Mode": "navigate"}
XHR = {"X-Requested-With": "XMLHttpRequest"}
GV = "/review/journey?view=group&stage=group_calib"


def box(path=GV):
    return as_user(CHIEF, path, lambda db, u: a._journey_team_overview(db, u, "group_calib", None, "summary"))["data"]


def people(d):
    return {p["id"]: p for c in d["cells"] for p in c["people"]}


try:
    # -----------------------------------------------------------------------
    s.section("the Group view: a Group Chief's own part, called Talent Box calibration")
    views = as_user(CHIEF, "/review/journey", lambda db, u: a._journey_views(db, u))
    s.check("a Group Chief at Year-End has the Group view", "group" in views, views)
    s.check("...and no Mine: like a BG CEO, no review of their own (Chris, 2026-10-13)", "mine" not in views, views)
    s.check("their own KPI, competency and plan aren't asked of them",
            as_user(CHIEF, "/", lambda db, u: a.review_state(db, u)).get("participant") is False
            and as_user(CHIEF, "/", lambda db, u: a._review_bg_leader(db, u)))
    s.check("someone in the scope has no Group view, and keeps their own review",
            "group" not in as_user(A1, "/review/journey", lambda db, u: a._journey_views(db, u))
            and as_user(A1, "/", lambda db, u: a.review_state(db, u)).get("participant") is not False)
    st = as_user(CHIEF, GV, lambda db, u: a._journey_team_live_stages(a.review_state(db, u), "group"))
    s.check("its one part is the Talent Box calibration, open", [x["key"] for x in st] == ["group_calib"]
            and st[0]["label"] == "Talent Box calibration" and st[0]["short"] == "Talent Box"
            and st[0]["state"] == a.REVIEW_STATE_OPEN, st)
    r = cfo.get(GV, headers=NAV)
    b = html.unescape(r.get_data(as_text=True))
    s.check("the journey opens on it, with a Group toggle", r.status_code == 200 and ">Group<" in b, r.status_code)
    nav = as_user(CHIEF, GV, lambda db, u: a._journey_team_nav_items(db, u, "group_calib"))
    s.check("the left panel is the Talent Box's, with the group as its one unit",
            nav["kind"] == "tbox" and [i["name"] for i in nav["items"]] == ["ZZGJ Group Finance"]
            and nav["items"][0]["meta"] == "5 people" and not nav["items"][0]["done"], nav)
    op = as_user(CHIEF, GV, lambda db, u: (a._tb_use_group(), a._talent_box_opener(db, u))[1])
    s.check("its first line is the Talent Box's, for the group", op.startswith(
        "Here's your Talent Box for ZZGJ Group Finance: 5 people placed") and "super admin" in op, op)

    s.section("the box: the BG CEO's card, the group as one unit")
    d = box()
    by = people(d)
    s.check("the Talent Box's data, for the group", d["axis"] == "talent_box" and d["group"] is True
            and d["tier"] == "group" and d["company_label"] == "ZZGJ Group Finance" and d["placed"] == 5, d.get("axis"))
    s.check("everyone in the group is on the 9-box (the not-final one too, on their own entry)",
            set(by) == {A1, A2, A3, B1, NOTFIN} and by[NOTFIN]["perf_src"] in ("self", "default"),
            (set(by), by.get(NOTFIN, {}).get("perf_src")))
    s.check("one unit: no business units to pick, no PAT", len(d["companies"]) == 1 and d["pat"] is None
            and d["n_bu"] == 1, d["companies"])
    s.check("the Segment chip (the department pills until 2026-11-02) is the group's own batches: here its departments",
            [(x["key"], x["n"]) for x in next(f for f in d["filters"] if f["key"] == "seg")["options"]]
            == [("Accounts", 2), ("Finance", 3)], d["filters"])
    s.check("each person carries their business group, and the BG CEO's side of them",
            "Beta" in (by[B1]["bg_label"] or "") and by[A2]["bgc_perf"] == "AE" and by[B1]["bgc_perf"] == "OU"
            and by[A2]["perf"] == "AE", (by[A2].get("bgc_perf"), by[B1].get("bgc_perf")))
    s.check("it moves and locks through the group box's own routes",
            d["move_url"].endswith("/talent-box/group/%d/move" % GID)
            and d["lock_url"].endswith("/talent-box/group/%d/lock" % GID) and d["bu_people"] == 5)
    s.check("how the two calls combine, said on the box", d["mode_word"] == "After the BG CEO")
    hj = cfo.get("/review/chat/history?journey=1&stage=group_calib&view=group&mode=summary").get_json() or {}
    hd = (hj.get("overview") or {}).get("data") or {}
    s.check("the card refreshes from the history endpoint", (hj.get("overview") or {}).get("stage") == "group_calib"
            and hd.get("group") and hd.get("placed") == 5, hj.get("stage"))
    hj = cfo.get("/review/chat/history?journey=1&stage=group_calib&view=group&mode=summary&seg=Finance").get_json() or {}
    hd = (hj.get("overview") or {}).get("data") or {}
    s.check("a segment narrows the box; the lock still covers the whole group",
            (hd.get("picks") or {}).get("seg") == ["Finance"] and hd.get("placed") == 3 and hd.get("bu_people") == 5, hd.get("placed"))
    s.check("a segment that isn't the group's is ignored",
            ((((cfo.get("/review/chat/history?journey=1&stage=group_calib&view=group&mode=summary&seg=Nope")
                .get_json() or {}).get("overview") or {}).get("data") or {}).get("placed")) == 5)

    s.section("the agent: the Talent Box's tools, on the group")
    task = as_user(CHIEF, GV, lambda db, u: a._journey_team_stage_task(db, u, "group_calib", None))
    s.check("its task names the group, how the calls combine, the one lock and the super admin",
            "ZZGJ Group Finance" in task and "After the BG CEO" in task and "whole group" in task
            and "super admin" in task, task[:200])
    run = lambda act: as_user(CHIEF, GV, lambda db, u: a._journey_team_run_stage_tool(db, u, CID, "group_calib", None,
                                                                                       act))
    r1 = run({"tool": "show_business_unit", "args": {"name": "anything"}})
    s.check("there are no business units to switch to", r1.get("ok") is False and "one group" in r1.get("error", ""), r1)
    r2 = run({"tool": "prepare_lock", "args": {}})
    s.check("prepare_lock brings the box (never locks)", r2.get("ok") and (r2.get("render") or {}).get("data", {})
            .get("stage") == "group_calib", r2)
    r3 = run({"tool": "move_person", "args": {"subject": "ZZ GJ Alpha One", "performance_band": "OU",
                                              "justification": "Led the close two weeks early"}})
    s.check("move_person moves through the box's own rules", r3.get("ok"), r3)
    # 4-06 follow-up (2026-10-31): the earlier-ask path reads the Group Chief's scope for the subject AND everyone else in it
    _sp = as_user(CHIEF, GV, lambda db, u: a._team_move_subject_and_people(
        db, u, "group_calib", {"tool": "move_person", "args": {"subject": "ZZ GJ Alpha One"}}))
    s.check("the group scope gives the subject and the whole group's people (the name check's population)",
            _sp[0] and _sp[0]["full_name"] == "ZZ GJ Alpha One" and len(_sp[1]) >= 2
            and any(p["id"] == _sp[0]["id"] for p in _sp[1]) and all(p["full_name"] for p in _sp[1]), (_sp[0], len(_sp[1])))

    s.section("a move from the box")
    r = cfo.post("/talent-box/group/%d/move" % GID, data={"csrf_token": "tok", "subject_id": A2,
                 "performance_band": "ME", "potential_band": "", "justification": ""}, headers=XHR)
    s.check("a move saves through the group box's route (JSON)", (r.get_json() or {}).get("ok"),
            r.get_data(as_text=True)[:160])
    by = people(box())
    s.check("...and the box shows their call, with the BG CEO's side beside it",
            by[A2]["perf"] == "ME" and by[A2]["moved"] and by[A2]["perf_src"] == "group" and by[A2]["bgc_perf"] == "AE"
            and by[A1]["perf"] == "OU", (by[A2]["perf"], by[A2]["bgc_perf"], by[A1]["perf"]))

    s.section("the person page and the insight, on the group")
    j = cfo.post("/review/team/tbox-person", data={"csrf_token": "tok", "person": A1, "view": "group"}).get_json() or {}
    s.check("someone in the group: their page opens", j.get("ok") and j.get("name") == "ZZ GJ Alpha One", j)
    r = cfo.post("/review/team/tbox-person", data={"csrf_token": "tok", "person": LM, "view": "group"})
    s.check("someone outside it: 404", r.status_code == 404, r.status_code)
    j = cfo.post("/review/team/tbox-insight", data={"csrf_token": "tok", "person": B1, "view": "group"}).get_json() or {}
    s.check("the short insight reads on the group", j.get("ok") and j.get("data"), j)
    s.check("...kept on the group, never on the business group the BG CEO's is on",
            [tuple(r) for r in H.rows(a, "SELECT scope_key FROM tb_insights WHERE subject_id=?", (B1,))]
            == [("group:%d" % GID,)])
    j = cfo.post("/review/team/tbox-remark", data={"csrf_token": "tok", "person": B1, "view": "group",
                                                   "remark": "Strong close on the regional accounts."}).get_json() or {}
    s.check("their own remark saves, on the group", j.get("ok") and [tuple(r) for r in H.rows(
        a, "SELECT business_group FROM talent_box_remarks WHERE subject_id=?", (B1,))] == [("group:%d" % GID,)], j)

    s.section("one Lock: the whole group, both axes, a call on everyone")
    r = cfo.post("/talent-box/group/%d/lock" % GID, data={"csrf_token": "tok", "ajax": "1",
                                                          "return_to": "/review/journey?view=group&stage=group_calib"})
    s.check("the Lock locks (JSON, no banner)", (r.get_json() or {}).get("ok"), r.get_data(as_text=True)[:160])
    locks = dict(H.rows(a, "SELECT subject_id, band FROM pm_group_locks WHERE group_id=?", (GID,)))
    s.check("a call on everyone with a final rating: their move, else the band that came up (kept)",
            locks == {A1: "OU", A2: "ME", A3: "ME", B1: "OU"}, locks)
    s.check("both of the group's sessions are locked", all(H.rows(
        a, "SELECT locked_at FROM %s WHERE tier='group' AND scope_key=?" % t, (str(GID),))[0][0]
        for t in ("pm_calibration_sessions", "calibration_sessions")))
    d = box()
    s.check("the box reads locked; the part is done", d["both_locked"] and d["bu_locked"] and as_user(
        CHIEF, GV, lambda db, u: a._journey_team_live_stages(a.review_state(db, u), "group"))[0]["state"]
        == a.REVIEW_STATE_DONE)
    say = as_user(CHIEF, GV, lambda db, u: (a._tb_use_group(), a._talent_box_after_lock(db, u))[1])[0]
    s.check("the line after the lock says it's with the super admin", say.startswith("Done") and "super admin" in say,
            say)
    r = cfo.post("/talent-box/group/%d/move" % GID, data={"csrf_token": "tok", "subject_id": A3,
                 "performance_band": "BE", "potential_band": "", "justification": ""}, headers=XHR)
    s.check("nobody can be moved after", (r.get_json() or {}).get("ok") is False)
    rows, _m = as_user(SUP, "/", lambda db, u: a._final_bands_rows(db, a.active_pm_period(db), GID))
    fb = {x["p"]["id"]: x for x in rows}
    s.check("Final bands has the Group Chief's call on everyone with a final rating",
            fb[A2]["chief"] == "ME" and fb[A3]["chief"] == "ME" and fb[A1]["chief"] == "OU" and fb[B1]["chief"] == "OU"
            and fb[NOTFIN]["chief"] is None, {k: v["chief"] for k, v in fb.items()})
    j = cfo.post("/review/team/tbox-remark", data={"csrf_token": "tok", "person": B1, "view": "group",
                                                   "remark": "Changed my mind."})
    s.check("their remark can't change once locked", j.status_code == 409, j.status_code)

    s.section("the classic group page: the Group Chief goes to the chat, the super admin keeps it")
    r = cfo.get("/performance/calibration/group/%d" % GID, headers=NAV)
    s.check("the Group Chief's page load opens the Group view", r.status_code == 302
            and "view=group" in r.headers.get("Location", "") and "stage=group_calib" in r.headers.get("Location", ""),
            (r.status_code, r.headers.get("Location")))
    s.check("...the super admin keeps the page", H.client_as(a, SUP).get("/performance/calibration/group/%d" % GID,
                                                                        headers=NAV).status_code == 200)

    s.section("the dashboard names it")
    card = as_user(CHIEF, "/dashboard", lambda db, u: a.dash_group_calib(db, u))
    s.check("the Group Chief's card is the AI+ Talent Box", card and card["name"] == "AI+ Talent Box"
            and card["sub"] == "Locked", card)

    s.section("the BG CEO's Talent Box: group members tagged")
    tags = as_user(SUP, "/", lambda db, u: a._tb_group_tags(db, PID))
    s.check("each member carries the scope, the Group Chief and their locked call",
            tags.get(A2, {}).get("name") == "ZZGJ Group Finance" and tags[A2]["chief"] == "ZZ GJ Groupcfo"
            and tags[A2]["call"] == "ME" and tags[A2]["locked"])
    # the split since 2026-10-22: After the BG CEO is the Group Chief's whole call, so the BG CEO reads them only
    s.check("...and how the two calls combine: the split", tags[A2]["mode"] == "Group Chief 100 : BG CEO 0"
            and tags[A2]["ro"] is True)
    s.check("someone outside every scope has no tag", LM not in tags)

    s.section("client")
    _js = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "journey_chat.js"),
               encoding="utf-8").read()
    _twg = _js[_js.index("function talentBoxWidget(d) {"):_js.index("function tbPersonMode(d)")]
    s.check("the Group part draws the Talent Box", 'if (stage === "group_calib") return data && data.axis === '
            '"talent_box" ? talentBoxWidget(data) : groupWidget(data);' in _js
            and "function tbStage(s) { return s === \"talent_box\" || s === \"group_calib\"; }" in _js)
    s.check("no business-unit row on a Group Chief's box; its filter line (Segment first) shows anyway",
            "if (!d.group) { box.appendChild(phBuDrop(d)); box.appendChild(brow); }" in _twg and "tbDeptRow" not in _js
            and "if (!list.length || (!d.company && !d.group && !d.chair)) return null;" in _js)
    s.check("one Lock for the whole group, asking first, posting quietly", "function tbGroupLockForm(d)" in _js
            and "if (d.group) return tbGroupLockForm(d);" in _js
            and "tbLockQuietly(f);" in _js[_js.index("function tbGroupLockForm"):_js.index("function calibLockCard")])
    s.check("Show moved beside the Lock on a Group Chief's box too (Chris, 2026-10-13)",
            "if (!d || (!d.company && !d.group)) return null;" in _js[_js.index("function tbMovedBtn"):])
    s.check("the BG CEO's side beside a person, when it differs", "function tbBgcText(d, p)" in _js
            and "var bgt = tbBgcText(d, p);" in _js and "var pbg = tbBgcText(d, p);" in _js)
    s.check("the BG CEO's box tags a group member by its name line", "if (p.grp) {" in _js
            and '"rv-tbox-grp"' in _js)
finally:
    a.ai_draft.review_agent_available = _real_avail
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        db.execute("UPDATE cycles SET half=? WHERE id=?", (_ORIG["half"], CID))
        for k, v in _ORIG["modules"].items():
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, CID, k))
        db.commit()

sys.exit(s.done())
