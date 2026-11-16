"""Group calibration: a Group Chief across business groups, the super admin decides (Chris, 2026-10-10, canvas row G).

"CHGB Group CFO will calibrate the result of all the finance across all BGs"; how the two calls combine is the super
admin's (replace / after / a blend like 50:50), and "the final scoring goes to the super admin for decision ... with
full audit trail"; "Super admin would have the ability to choose the user list". A scope is a calibration group (its
calibrator is the Group Chief, one scope per person); the people list is built by department name across business
groups, pasted IDs, or one by one; the mode only SUGGESTS; the final band is the super tier's, with a reason whenever it
isn't the suggestion. Everything here is synthetic (ZZGC-*) and is removed at the end.
"""
import html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Group calibration -- the Group Chief's scope, the combine mode, the super admin's final band")

BG1, BG2 = "ZZGC BG1", "ZZGC BG2"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZGC-%'")]
    gids = [r[0] for r in db.execute("SELECT id FROM pm_calibration_groups WHERE name LIKE 'ZZGC%'")]
    if gids:
        ph = ",".join("?" * len(gids))
        db.execute("DELETE FROM pm_group_locks WHERE group_id IN (%s)" % ph, gids)
        db.execute("DELETE FROM pm_calibration_sessions WHERE tier='group' AND scope_key IN (%s)" % ph,
                   [str(g_) for g_ in gids])
        db.execute("DELETE FROM app_settings WHERE key IN (%s)" % ph, ["calib_group_mode:%s" % g_ for g_ in gids])
        db.execute("DELETE FROM pm_calibration_groups WHERE id IN (%s)" % ph, gids)
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM pm_calibration_adjustments WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM pm_calibration_sessions WHERE tier='bgceo' AND scope_key IN (?,?)", (BG1, BG2))
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?)", (BG1, BG2))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG1, BG2))
    db.execute("DELETE FROM activity_log WHERE detail LIKE '%ZZGC%' AND id > ?", (LOG0,))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    PER = dict(a.active_pm_period(db))
    PID = PER["id"]
    # a Group Chief calibrates at Year-End only (Mid-Year is Self, LM and HOD, 2026-10-12): run on a Year-End cycle
    HALF0 = PER["half"]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (PID,))
    db.commit()
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    _cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, bg, dept, mgr=None, role="user", admin_bg=None):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=mgr,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=bg, company=bg + " CO",
                 department=dept, years_of_service=3, confirmation_date=None, left_at=None, is_demo=0, role=role,
                 admin_bg=admin_bg)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    CHIEF = mk("ZZGC-CFO", "ZZ GC Groupcfo", BG1, "Group Finance")
    LM = mk("ZZGC-LM", "ZZ GC Manager", BG1, "Office")
    F1 = mk("ZZGC-F1", "ZZ GC Fin One", BG1, "Finance", mgr=LM)
    F2 = mk("ZZGC-F2", "ZZ GC Fin Two", BG2, "finance & tax", mgr=LM)
    F3 = mk("ZZGC-F3", "ZZ GC Accounts", BG2, "Accounts", mgr=LM)
    S1 = mk("ZZGC-S1", "ZZ GC Sales", BG1, "Sales", mgr=LM)
    BGADM = mk("ZZGC-ADM", "ZZ GC Bgadmin", BG1, "HR", role="admin", admin_bg=BG1)
    for bg in (BG1, BG2):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (bg, bg + " CO"))
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (bg,))
    # a final, moderated scorecard each: one KPI, result 100 = rate 3 = ME
    for sid in (F1, F2, F3, S1):
        bg = db.execute("SELECT business_group FROM users WHERE id=?", (sid,)).fetchone()[0]
        t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, "
                       "rate3, rate4, rate5, business_group, company, department) VALUES (?,?, 'ZZGC KPI', 100, "
                       "'more', 80,90,100,110,120, ?,?, 'x')", (PID, sid, bg, bg + " CO")).lastrowid
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t, LM))
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,100,?,0)",
                   (t, sid))
        db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) VALUES "
                   "(?,1,'confirm',100,?)", (t, LM))
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def u(uid):
    return ctx(lambda d: dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


sup = H.client_as(a, SUP)
GROUPS = "/admin/performance/calibration-groups"
FINAL = "/admin/calibration/final-bands"


REMARK = "ZZGC agreed at the group calibration"


def post(url, remark=REMARK, **f):
    # the super admin's band actions carry their remark (2026-10-18); remark=None posts without one
    d = {"csrf_token": "tok"}
    if remark is not None:
        d["remark"] = remark
    d.update(f)
    r = sup.post(url, data=d, follow_redirects=True)
    return r.status_code, html.unescape(r.get_data(as_text=True))


def members(gid):
    return {r[0] for r in H.rows(a, "SELECT subject_id FROM pm_calibration_group_members WHERE group_id=?", (gid,))}


try:
    # -----------------------------------------------------------------------
    s.section("the suggestion, by mode")
    sug = lambda b, c, m: a.calib_suggest(b, c, m)   # noqa: E731
    s.check("after / replace: the Group Chief's call", sug("AE", "ME", {"mode": "after", "bg": 50, "chief": 50})[0] == "ME"
            and sug("AE", "ME", {"mode": "replace", "bg": 50, "chief": 50})[0] == "ME")
    s.check("...and the BG CEO's while the Group Chief hasn't called it",
            sug("AE", None, {"mode": "after", "bg": 50, "chief": 50})[0] == "AE")
    s.check("blend 50:50 between ME and AE is a tie the super admin picks",
            sug("AE", "ME", {"mode": "blend", "bg": 50, "chief": 50})[:2] == (None, "ME or AE"))
    s.check("blend 30:70 between BE and AE leans to the Group Chief: ME",
            sug("BE", "AE", {"mode": "blend", "bg": 30, "chief": 70})[0] == "ME")
    s.check("both agree: that band", sug("ME", "ME", {"mode": "blend", "bg": 50, "chief": 50})[0] == "ME")

    # -----------------------------------------------------------------------
    s.section("the super admin builds the scope")
    code, b = post(GROUPS, action="create", name="ZZGC Group Finance", calibrator="ZZGC-CFO")
    GID = H.one(a, "SELECT id FROM pm_calibration_groups WHERE name='ZZGC Group Finance'")
    s.check("a scope with its Group Chief", GID is not None and "ZZGC Group Finance created" in b)
    r = sup.get(GROUPS + "?g=%d&dept=finance&bg=%s&bg=%s" % (GID, BG1, BG2))
    b = html.unescape(r.get_data(as_text=True))
    s.check("counting the matching first: 'finance' in either group's department names is 3 (the CFO too), "
            "nothing written", "<b>3</b> to add" in b and members(GID) == set(), b.count("to add"))
    post(GROUPS, action="add_matching", group_id=GID, dept="finance", bg=[BG1, BG2])
    s.check("Add the matching puts them in, across business groups", members(GID) == {CHIEF, F1, F2},
            members(GID))
    code, b = post(GROUPS, action="paste_ids", group_id=GID, ids="ZZGC-F3, ZZGC-NOBODY")
    s.check("pasted Employee IDs are added, an unknown one named", F3 in members(GID) and "ZZGC-NOBODY" in b)

    # nobody sets their own band (_calib_self_msg): 'finance' matched the CFO, so the Group Chief sits in their own
    # group; their box's move refuses their own row, as the BG CEO's does (handoff 2026-10-24 12.2)
    def _grows(sid):
        return [H.one(a, "SELECT COUNT(*) FROM %s_adjustments ca JOIN %s_sessions cs ON cs.id=ca.session_id WHERE "
                         "cs.tier='group' AND cs.scope_key=? AND ca.subject_id=?" % (t, t), (str(GID), sid))
                for t in ("pm_calibration", "calibration")]
    _cfo0 = H.client_as(a, CHIEF)
    _gmv = lambda sid: _cfo0.post("/talent-box/group/%d/move" % GID, headers={"X-Requested-With": "XMLHttpRequest"},  # noqa: E731
                                  data={"csrf_token": "tok", "subject_id": str(sid), "performance_band": "OU",
                                        "potential_band": "High"})
    _gs, _go = _gmv(CHIEF), _gmv(F3)
    s.check("the Group Chief can't move themselves on their group's Talent Box: refused in the words of their part, "
            "nothing written", CHIEF in members(GID) and _gs.status_code == 400
            and (_gs.get_json() or {}).get("error") == a._calib_self_msg("group") and _grows(CHIEF) == [0, 0],
            (_gs.status_code, _gs.get_json(), _grows(CHIEF)))
    s.check("...while they move the rest of their group", _go.status_code == 200 and (_go.get_json() or {}).get("ok")
            and _grows(F3) == [1, 1], (_go.status_code, _go.get_json(), _grows(F3)))

    def _put_back_f3(d):   # F3 is never moved below (locked as it came in)
        for t in ("pm_calibration", "calibration"):
            d.execute("DELETE FROM %s_adjustments WHERE subject_id=? AND session_id IN (SELECT id FROM %s_sessions "
                      "WHERE tier='group' AND scope_key=?)" % (t, t), (F3, str(GID)))
        d.commit()
    ctx(_put_back_f3)
    post(GROUPS, action="create", name="ZZGC Other", calibrator="ZZGC-LM")
    G2 = H.one(a, "SELECT id FROM pm_calibration_groups WHERE name='ZZGC Other'")
    code, b = post(GROUPS, action="paste_ids", group_id=G2, ids="ZZGC-F1 ZZGC-S1")
    s.check("one scope per person: someone already in a scope is left there",
            F1 not in members(G2) and S1 in members(G2) and "1 already sit in another scope" in b, b[:0])
    code, b = post(GROUPS, action="set_mode", group_id=GID, mode="blend", bg_weight="0")
    s.check("a blend needs both shares", "between 1 and 99" in b and ctx(lambda d: a.calib_group_mode(GID))["mode"]
            == "after")
    post(GROUPS, action="set_mode", group_id=GID, mode="blend", bg_weight="50")
    s.check("the mode is saved, and shown", ctx(lambda d: a.calib_group_mode(GID)) == {"mode": "blend", "bg": 50,
                                                                                        "chief": 50}
            and "Both count, BG CEO 50 : Group Chief 50" in html.unescape(sup.get(GROUPS).get_data(as_text=True)))
    s.check("...and logged", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_calib_group_mode' AND "
                                      "detail LIKE 'ZZGC Group Finance%'") == 1)

    # -----------------------------------------------------------------------
    s.section("Final bands: both calls, the suggestion, the super admin's decision")

    def calls(d):
        bgs = a._pm_calib_get_or_create_session(d, PID, "bgceo", BG1, BG1, BG1)
        d.execute("UPDATE pm_calibration_sessions SET locked_at=datetime('now') WHERE id=?", (bgs["id"],))
        a._pm_calib_upsert_adjustment(d, bgs["id"], F1, "ME", "AE", "strong year", SUP, seen_band="ME")
        gs = a._pm_calib_get_or_create_session(d, PID, "group", str(GID), BG1, "ZZGC Group Finance")
        a._pm_calib_upsert_adjustment(d, gs["id"], F1, "AE", "ME", "close was late", CHIEF, seen_band="AE")
        d.commit()
    ctx(calls)
    r = sup.get(FINAL + "?g=%d" % GID)
    b = html.unescape(r.get_data(as_text=True))
    s.check("the queue opens for the super admin, with the scope's mode", r.status_code == 200
            and "Both count, BG CEO 50 : Group Chief 50" in b, r.status_code)
    rows = ctx(lambda d: a._final_bands_rows(d, a.active_pm_period(d), GID)[0])
    by = {x["p"]["id"]: x for x in rows}
    s.check("F1: the Group Chief's call is a draft until they lock it -- no suggestion, nothing to accept",
            by[F1]["chief"] is None and by[F1]["draft"] == "ME" and by[F1]["sug"] is None and not by[F1]["agreed"]
            and "hasn't locked" in by[F1]["why"], (by[F1]["chief"], by[F1]["draft"], by[F1]["why"]))
    s.check("F2: no Group Chief call at all, so they wait on the Group Chief",
            by[F2]["chief"] is None and by[F2]["sug"] is None and not by[F2]["agreed"]
            and by[F2]["why"] == "waits on the Group Chief", by[F2]["why"])
    s.check("someone not in the scope isn't in the queue", S1 not in by)

    # -----------------------------------------------------------------------
    s.section("the Group Chief locks the ticked people, or a department (canvas G2)")
    cfo = H.client_as(a, CHIEF)
    GP = "/performance/calibration/group/%d" % GID
    b = html.unescape(cfo.get(GP).get_data(as_text=True))
    s.check("their page has the lock panel, each department of each business group, and the BG CEO's call beside theirs",
            "Lock your calls" in b and "Finance, %s" % a.proper_name(BG1) in b and "finance & tax, %s" % a.proper_name(BG2) in b
            and "BG CEO's call:" in b and 'name="sid" value="%d"' % F1 in b, b[:0])
    r = cfo.post(GP + "/lock-people", data={"csrf_token": "tok", "sid": [F1, S1]}, follow_redirects=True)
    gl = H.rows(a, "SELECT subject_id, band, locked_by FROM pm_group_locks WHERE group_id=?", (GID,))
    s.check("Lock the ticked locks F1 at their call (ME); someone outside the scope is ignored",
            [tuple(x) for x in gl] == [(F1, "ME", CHIEF)], [tuple(x) for x in gl])
    s.check("...logged", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_group_lock' AND user_id=? AND "
                                  "id > ?", (CHIEF, LOG0)) == 1)
    b = html.unescape(cfo.get(GP).get_data(as_text=True))
    s.check("...their row now reads Locked, with no band to change and no tick box",
            "Locked ✓" in b and 'name="sid" value="%d"' % F1 not in b)
    cfo.post(GP + "/adjust", data={"csrf_token": "tok", "subject_id": F1, "adjusted_band": "OU", "justification": "x"})
    _f1 = lambda: H.one(a, "SELECT (SELECT ca.adjusted_band FROM pm_calibration_adjustments ca JOIN "   # noqa: E731
                           "pm_calibration_sessions cs ON cs.id=ca.session_id WHERE cs.tier='group' AND cs.scope_key=? "
                           "AND ca.subject_id=?)", (str(GID), F1))
    s.check("a locked call can't be moved", _f1() == "ME", _f1())
    cfo.post(GP + "/reset", data={"csrf_token": "tok"})
    s.check("...nor reset: Reset all keeps the locked calls", _f1() == "ME", _f1())
    s.check("someone else can't lock in this scope", H.client_as(a, S1).post(
        GP + "/lock-people", data={"csrf_token": "tok", "sid": F2}).status_code == 403)
    s.check("in a blend, the locked call only suggests: F1's band is still the BG CEO's",
            ctx(lambda d: a.pm_effective_band(d, u(F1), PID, "ME"))["band"] == "AE")
    post(GROUPS, remark=None, action="set_mode", group_id=GID, mode="after")
    s.check("changing the mode needs the remark (it changes F1's band at once)",
            ctx(lambda d: a.pm_effective_band(d, u(F1), PID, "ME"))["band"] == "AE")
    post(GROUPS, action="set_mode", group_id=GID, mode="after")
    e_after = ctx(lambda d: a.pm_effective_band(d, u(F1), PID, "ME"))
    s.check("with the Group Chief after the BG CEO, the locked call counts (without locking the whole group)",
            e_after["band"] == "ME" and e_after["source"] == "group", e_after)
    s.check("...and the ratings record agrees", ctx(lambda d: a._rr_tier_bands(d, PID, u(F1), "ME", "pm")[0]["group"])
            == "ME")
    post(GROUPS, action="set_mode", group_id=GID, mode="blend", bg_weight="50")
    rows = ctx(lambda d: a._final_bands_rows(d, a.active_pm_period(d), GID)[0])
    by = {x["p"]["id"]: x for x in rows}
    s.check("F1 on Final bands: BG CEO AE, Group Chief ME locked, 50:50 is a tie", by[F1]["bg"] == "AE"
            and by[F1]["chief"] == "ME" and by[F1]["tie"] == "ME or AE", (by[F1]["bg"], by[F1]["chief"], by[F1]["tie"]))
    code, b = post(FINAL, remark=None, action="decide", g=GID, subject_id=F1, band="AE")
    s.check("a final band needs the super admin's remark", "Write your remark first" in b
            and ctx(lambda d: a.pm_effective_band(d, u(F1), PID, "ME"))["source"] != "super")
    post(FINAL, remark="ZZGC the BG CEO saw the full year", action="decide", g=GID, subject_id=F1, band="AE")
    fin = ctx(lambda d: a.pm_effective_band(d, u(F1), PID, "ME"))
    s.check("with one it's the final band, above every tier", fin["band"] == "AE" and fin["source"] == "super", fin)
    s.check("...in the audit trail with its remark", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_calibration_override' AND target_user_id=? AND "
           "detail LIKE '%the BG CEO saw the full year%'", (F1,)) == 1)
    s.check("...and on the band row", H.one(
        a, "SELECT ca.justification FROM pm_calibration_adjustments ca JOIN pm_calibration_sessions cs ON "
           "cs.id=ca.session_id WHERE cs.tier='super' AND ca.subject_id=?", (F1,)) == "ZZGC the BG CEO saw the full year")
    def f2_call(d):
        gs = a._pm_calib_get_or_create_session(d, PID, "group", str(GID), BG1, "ZZGC Group Finance")
        a._pm_calib_upsert_adjustment(d, gs["id"], F2, "ME", "OU", "led the audit", CHIEF, seen_band="ME")
        d.commit()
    ctx(f2_call)
    cfo.post(GP + "/lock-people", data={"csrf_token": "tok", "dept": "Finance", "dept_bg": BG2})
    s.check("a department is matched with its business group: Finance of the other group locks nobody",
            H.one(a, "SELECT COUNT(*) FROM pm_group_locks WHERE group_id=?", (GID,)) == 1)
    cfo.post(GP + "/lock-people", data={"csrf_token": "tok", "dept": "finance & tax", "dept_bg": BG2})
    s.check("Lock a department locks that department of that business group only (F2 at OU, not F3)",
            {x[0]: x[1] for x in H.rows(a, "SELECT subject_id, band FROM pm_group_locks WHERE group_id=?", (GID,))}
            == {F1: "ME", F2: "OU"})
    r2 = {x["p"]["id"]: x for x in ctx(lambda d: a._final_bands_rows(d, a.active_pm_period(d), GID)[0])}
    s.check("F2 now: BG CEO ME, Group Chief OU; 50:50 suggests AE, but the calls disagree, so it isn't 'agreed'",
            r2[F2]["sug"] == "AE" and not r2[F2]["agreed"], (r2[F2]["sug"], r2[F2]["agreed"]))
    cfo.post(GP + "/lock-people", data={"csrf_token": "tok", "dept": "Accounts", "dept_bg": BG2})
    s.check("F3, never moved, is locked as it came in (ME), written as a kept call",
            H.one(a, "SELECT band FROM pm_group_locks WHERE group_id=? AND subject_id=?", (GID, F3)) == "ME"
            and H.one(a, "SELECT ca.justification FROM pm_calibration_adjustments ca JOIN pm_calibration_sessions cs "
                         "ON cs.id=ca.session_id WHERE cs.tier='group' AND cs.scope_key=? AND ca.subject_id=?",
                      (str(GID), F3)) == "Kept as it came in")
    code, b = post(FINAL, action="accept_agreed", g=GID)
    s.check("Accept the clear suggestions decides only the agreed (F3; the CFO has no scorecard, so no row)",
            ctx(lambda d: a.pm_effective_band(d, u(F3), PID, "ME"))["source"] == "super"
            and ctx(lambda d: a.pm_effective_band(d, u(F2), PID, "ME"))["source"] != "super"
            and "1 final band accepted" in b, b[b.find("final band"):][:60])
    post(FINAL, action="decide", g=GID, subject_id=F2, band="AE")
    s.check("...F2 takes the super admin's own decision (accepting the suggestion, with the remark)",
            ctx(lambda d: a.pm_effective_band(d, u(F2), PID, "ME"))["band"] == "AE")
    csv = H.as_csv_text(sup.get(FINAL + "?g=%d&format=csv" % GID))
    s.check("the queue downloads as CSV with each decision, reason and the Group Chief's lock", "ZZGC-F1" in csv
            and "AE" in csv and "the BG CEO saw the full year" in csv and "Group Chief locked (MYT)" in csv)
    post(FINAL, remark=None, action="clear", g=GID, subject_id=F1)
    s.check("Clear needs the remark too", ctx(lambda d: a.pm_effective_band(d, u(F1), PID, "ME"))["source"] == "super")
    post(FINAL, action="clear", g=GID, subject_id=F1)
    s.check("Clear takes F1 back to the calibrated band",
            ctx(lambda d: a.pm_effective_band(d, u(F1), PID, "ME"))["source"] != "super")
    post(FINAL, remark=None, action="reopen", g=GID, subject_id=F1)
    s.check("Reopen needs the remark too", H.one(
        a, "SELECT COUNT(*) FROM pm_group_locks WHERE group_id=? AND subject_id=?", (GID, F1)) == 1)
    post(FINAL, action="reopen", g=GID, subject_id=F1)
    s.check("Reopen for the Group Chief lifts F1's lock, logged with the remark", H.one(
        a, "SELECT COUNT(*) FROM pm_group_locks WHERE group_id=? AND subject_id=?", (GID, F1)) == 0 and H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_group_reopen' AND target_user_id=? AND detail LIKE ?",
        (F1, "%remark: " + REMARK + "%")) == 1)
    cfo.post(GP + "/adjust", data={"csrf_token": "tok", "subject_id": F1, "adjusted_band": "AE", "justification": ""})
    s.check("...so the Group Chief can call F1 again", _f1() == "AE", _f1())
    s.check("...and it is a draft on Final bands until they lock it again", ctx(
        lambda d: {x["p"]["id"]: x for x in a._final_bands_rows(d, a.active_pm_period(d), GID)[0]})[F1]["draft"] == "AE")
    r = sup.post("/performance/calibration/override", data={"csrf_token": "tok", "subject_id": F1,
                                                            "adjusted_band": "OU", "justification": ""},
                 headers={"X-Requested-With": "XMLHttpRequest"})
    s.check("the calibration override needs the remark (JSON 400 to the page, nothing written)",
            r.status_code == 400 and ctx(lambda d: a.pm_effective_band(d, u(F1), PID, "ME"))["band"] != "OU",
            r.status_code)
    r = sup.post("/performance/calibration/override", data={"csrf_token": "tok", "subject_id": F1,
                                                            "adjusted_band": "OU", "remark": REMARK})
    s.check("the calibration override still writes the same super tier (one write path)",
            ctx(lambda d: a.pm_effective_band(d, u(F1), PID, "ME"))["band"] == "OU")
    s.check("...its remark the override's note", H.one(
        a, "SELECT ca.justification FROM pm_calibration_adjustments ca JOIN pm_calibration_sessions cs ON "
           "cs.id=ca.session_id WHERE cs.tier='super' AND ca.subject_id=?", (F1,)) == REMARK)

    # -----------------------------------------------------------------------
    s.section("only the super admin")
    bga = H.client_as(a, BGADM)
    s.check("a BG admin can't open Final bands", bga.get(FINAL).status_code == 403)
    s.check("...nor decide a band", bga.post(FINAL, data={"csrf_token": "tok", "action": "decide", "g": GID,
                                                          "subject_id": F3, "band": "OU"}).status_code == 403)
    s.check("...nor lock for the Group Chief", bga.post("/performance/calibration/group/%d/lock-people" % GID, data={
        "csrf_token": "tok", "sid": F3}).status_code == 403)
    s.check("...nor change a scope", bga.post(GROUPS, data={"csrf_token": "tok", "action": "add_matching",
                                                            "group_id": GID, "dept": "sales"}).status_code == 403)
    r = sup.post(FINAL, data={"csrf_token": "tok", "action": "promote", "g": GID})
    s.check("an unknown action is refused", r.status_code == 400)
finally:
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        db.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, PID))
        db.commit()

sys.exit(s.done())
