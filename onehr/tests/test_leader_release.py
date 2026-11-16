"""Release to leaders -- two result releases (Chris, 2026-10-12: "super admin will have two set of result release, one is
to the LM first, and second is to the employee. LM will see the full band because the justification is for them to talk
to the employee first on the final calibrated result, but employee can only see the final calibrated result and never
the movement"; then "for HOD and BUCEO, yes they only see after super admin release to the leader (including LM)").

Release 1 (leader_releases) lets the person's line manager, HOD and BU CEO read the final result with its whole movement;
release 2 (result_releases / talent_releases) lets the person see the final result. The BG CEO sees the final at once.
An employee release always implies a leader release. Everything here is synthetic (ZZLR-*) and is removed at the end.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Release to leaders -- line manager, HOD and BU CEO wait for release 1; the person for release 2")

BG, CO = "ZZLR BG", "ZZLR CO"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZLR-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        for t in ("result_releases", "talent_releases", "report_releases", "leader_releases"):
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
                 confirmation_date="2020-01-01", left_at=None, is_demo=0, role="user")
        v.update(kw)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (emp_id,)).fetchone()[0]

    BGCEO = mk("ZZLR-BGCEO", "ZZ Leader BG CEO", bgceo_bg=BG)
    BUCEO = mk("ZZLR-BUCEO", "ZZ Leader BU CEO", buceo_bg=BG, buceo_company=CO)
    HOD = mk("ZZLR-HOD", "ZZ Leader HOD")
    LM = mk("ZZLR-LM", "ZZ Leader Line Manager", hod_id=HOD)
    EMP = mk("ZZLR-EMP", "ZZ Leader Person", hod_id=HOD, manager_id=LM)
    EMP2 = mk("ZZLR-EMP2", "ZZ Leader Second", hod_id=HOD, manager_id=LM)
    NONE = mk("ZZLR-NONE", "ZZ Leader Nobody", hod_id=HOD, manager_id=LM)
    STRANGER = mk("ZZLR-OTHER", "ZZ Leader Stranger", business_group="ZZLR OTHER BG", company="ZZLR OTHER CO")
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]

    def sess(table, tier, key, moves, locked=True):
        db.execute("INSERT INTO %s(cycle_id, tier, scope_key, business_group, scope_label, locked_at) "
                   "VALUES (?,?,?,?,?,%s)" % (table, "datetime('now')" if locked else "NULL"),
                   (CID, tier, key, BG, "ZZLR"))
        sid = db.execute("SELECT id FROM %s WHERE cycle_id=? AND tier=? AND scope_key=?" % table,
                         (CID, tier, key)).fetchone()[0]
        adj = table.replace("sessions", "adjustments")
        for subj, (orig, band, why) in moves.items():
            db.execute("INSERT INTO %s(session_id, subject_id, original_band, adjusted_band, justification) "
                       "VALUES (?,?,?,?,?)" % adj, (sid, subj, orig, band, why))
        return sid

    # performance: the HOD sets AE (no approved score), the BU CEO locks without touching them, the BG CEO moves them
    # to ME -- final ME. The second person: the HOD sets ME, final once the BG CEO locked.
    sess("pm_calibration_sessions", "hod", str(HOD), {EMP: ("", "AE", "ZZLR hod reason"),
                                                      EMP2: ("", "ME", "ZZLR hod reason 2")})
    sess("pm_calibration_sessions", "buceo", CO, {})
    BGS = sess("pm_calibration_sessions", "bgceo", BG, {EMP: ("AE", "ME", "ZZLR bg ceo reason")}, locked=False)
    sess("calibration_sessions", "hod", str(HOD), {EMP: ("", "High", "ZZLR pot reason"),
                                                   EMP2: ("", "Mid", "ZZLR pot reason 2")})
    db.commit()


def ctx(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        return fn(d)


def u(uid):
    return ctx(lambda d: dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


def post(c, **form):
    form.setdefault("csrf_token", "tok")
    return c.post("/admin/talent-release", data=form)


def lead_rows(sid, kind=None):
    return ctx(lambda d: d.execute("SELECT COUNT(*) FROM leader_releases WHERE cycle_id=? AND subject_id=?"
                                   + (" AND kind=?" if kind else ""),
                                   [CID, sid] + ([kind] if kind else [])).fetchone()[0])


def emp_rows(sid, kind="pm"):
    return ctx(lambda d: d.execute("SELECT COUNT(*) FROM result_releases WHERE cycle_id=? AND subject_id=? AND kind=?",
                                   (CID, sid, kind)).fetchone()[0])


try:
    # -----------------------------------------------------------------------
    s.section("who leads whom")
    roles = ctx(lambda d: {k: a.leader_role_of(d, u(v), u(EMP)) for k, v in
                           (("lm", LM), ("hod", HOD), ("buceo", BUCEO), ("bgceo", BGCEO), ("stranger", STRANGER),
                            ("self", EMP), ("admin", SUP))})
    s.check("line manager, HOD, BU CEO, BG CEO and an admin each lead the person; a stranger and the person don't",
            roles == {"lm": "lm", "hod": "hod", "buceo": "buceo", "bgceo": "bgceo", "stranger": None, "self": None,
                      "admin": "admin"}, roles)

    # -----------------------------------------------------------------------
    s.section("calibration progress, for the timeline")
    p0 = ctx(lambda d: a.calibration_progress(d, u(EMP), CID))
    s.check("bands in, the BG CEO not locked yet: being calibrated, nothing released",
            p0 == {"state": "calibrating", "leaders": False, "released": False}, p0)
    s.check("someone with no band yet: not started",
            ctx(lambda d: a.calibration_progress(d, u(NONE), CID))["state"] == "not_started")
    ctx(lambda d: (d.execute("UPDATE pm_calibration_sessions SET locked_at=datetime('now') WHERE id=?", (BGS,)),
                   d.execute("INSERT INTO calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, "
                             "locked_at) VALUES (?, 'bgceo', ?, ?, 'ZZLR', datetime('now'))", (CID, BG, BG)),
                   d.commit()))
    p1 = ctx(lambda d: a.calibration_progress(d, u(EMP), CID))
    s.check("once the BG CEO locks both axes: calibration done, still not released",
            p1 == {"state": "done", "leaders": False, "released": False}, p1)

    # -----------------------------------------------------------------------
    s.section("before release 1: only the BG CEO (and an admin) see the final result")
    seen = ctx(lambda d: {k: a.leader_sees_final(d, u(v), u(EMP), CID, "pm") for k, v in
                          (("lm", LM), ("hod", HOD), ("buceo", BUCEO), ("bgceo", BGCEO), ("stranger", STRANGER))})
    s.check("line manager, HOD and BU CEO wait; the BG CEO sees it; a stranger never",
            seen == {"lm": False, "hod": False, "buceo": False, "bgceo": True, "stranger": False}, seen)
    rec = ctx(lambda d: a._rating_record_row(d, CID, u(EMP)))
    ch_lm = a.band_chain(rec, "pm", "lm", False)
    vis = [(x["step"], x["state"]) for x in ch_lm["steps"]]
    s.check("the line manager's chain stops at their own step, the rest 'in calibration', no final band",
            vis[:2] == [("self", "none"), ("lm", "none")] and all(st == "hidden" for _k, st in vis[2:])
            and ch_lm["final"] is None and not ch_lm["full"], vis)
    ch_hod = a.band_chain(rec, "pm", "hod", False)
    s.check("the HOD's runs to their own step (they set AE), then hidden",
            [(x["step"], x["band"], x["state"]) for x in ch_hod["steps"][:3]]
            == [("self", None, "none"), ("lm", None, "none"), ("hod", "AE", "set")]
            and ch_hod["steps"][3]["state"] == "hidden" and ch_hod["final"] is None, ch_hod)
    ch_bu = a.band_chain(rec, "pm", "buceo", False)
    s.check("the BU CEO's runs to theirs (kept AE), the BG CEO's step hidden",
            [(x["step"], x["state"]) for x in ch_bu["steps"]][3:] == [("buceo", "kept"), ("bgceo", "hidden")], ch_bu)
    ch_bg = a.band_chain(rec, "pm", "bgceo", False)
    s.check("the BG CEO reads the whole chain and the final band, with each tier's reason",
            ch_bg["full"] and ch_bg["final"] == "ME"
            and [(x["step"], x["band"], x["state"]) for x in ch_bg["steps"]][2:]
            == [("hod", "AE", "set"), ("buceo", "AE", "kept"), ("bgceo", "ME", "moved")]
            and ch_bg["steps"][4]["why"] == "ZZLR bg ceo reason", ch_bg)
    s.check("someone who doesn't lead them reads nothing", a.band_chain(rec, "pm", None, True) is None)
    s.check("a hidden step never hints a Group Chief or HR decision exists",
            all(x["step"] not in ("group", "super") for x in a.band_chain(
                dict(rec, pm_group_band="OU"), "pm", "lm", False)["steps"]))
    tally = ctx(lambda d: a._dash_band_tally(d, [u(EMP), u(EMP2)], CID, viewer=u(HOD)))
    s.check("the HOD's What you led counts nobody yet: both wait for HR",
            tally and tally["total"] == 0 and tally["waiting"] == 2 and tally["gated"], tally)
    s.check("...while without a gated viewer (the BG CEO) both count",
            ctx(lambda d: a._dash_band_tally(d, [u(EMP), u(EMP2)], CID))["total"] == 2)
    bi = ctx(lambda d: a._report_band_info(d, u(EMP), CID, {"band": "Mid"}, viewer=u(LM)))
    s.check("the line manager opening their 360 report sees no potential band yet", bi["band"] is None, bi)
    bi = ctx(lambda d: a._report_band_info(d, u(EMP), CID, {"band": "Mid"}, viewer=u(BGCEO)))
    s.check("...the BG CEO sees the final one", bi["band"] == "High", bi)

    # -----------------------------------------------------------------------
    s.section("release 1: to leaders")
    sup = H.client_as(a, SUP)
    r = post(sup, period=CID, result="all", action="release", to="nobody", ids=[EMP])
    s.check("an unknown audience is refused", r.status_code == 400, r.status_code)
    r = post(sup, period=CID, bg=BG, result="all", action="release", to="leaders", ids=[EMP])
    s.check("releasing to leaders writes leader rows for each result that resolves, and none for the person",
            r.status_code == 302 and lead_rows(EMP, "pm") == 1 and lead_rows(EMP, "pot") == 1
            and emp_rows(EMP, "pm") == 0 and emp_rows(EMP, "pot") == 0, (lead_rows(EMP), emp_rows(EMP)))
    s.check("...logged as a release to leaders", ctx(lambda d: d.execute(
        "SELECT COUNT(*) FROM activity_log WHERE action='leader_release' AND target_user_id=?",
        (EMP,)).fetchone()[0]) >= 2 and "leader_release" in a.ACTION_LABELS)
    seen = ctx(lambda d: {k: a.leader_sees_final(d, u(v), u(EMP), CID, "pm") for k, v in
                          (("lm", LM), ("hod", HOD), ("buceo", BUCEO), ("stranger", STRANGER))})
    s.check("now the line manager, HOD and BU CEO see it; a stranger still doesn't",
            seen == {"lm": True, "hod": True, "buceo": True, "stranger": False}, seen)
    s.check("...and the person still sees nothing final",
            ctx(lambda d: a.released_final_band(d, u(EMP), CID, "pm")) is None)
    ch_lm = a.band_chain(rec, "pm", "lm", True)
    s.check("the line manager's chain is now whole, with the final band",
            ch_lm["full"] and ch_lm["final"] == "ME" and not any(x["state"] == "hidden" for x in ch_lm["steps"]))
    tally = ctx(lambda d: a._dash_band_tally(d, [u(EMP), u(EMP2)], CID, viewer=u(HOD)))
    s.check("the HOD's What you led counts the released one, the other still waiting",
            tally["total"] == 1 and tally["waiting"] == 1, tally)
    bi = ctx(lambda d: a._report_band_info(d, u(EMP), CID, {"band": "Mid"}, viewer=u(LM)))
    s.check("the line manager's view of their 360 report now shows the final potential band", bi["band"] == "High", bi)
    p2 = ctx(lambda d: a.calibration_progress(d, u(EMP), CID))
    s.check("the timeline knows it's with the leaders", p2["leaders"] and not p2["released"], p2)

    # -----------------------------------------------------------------------
    s.section("release 2: to employees, only after release 1")
    r = post(sup, period=CID, result="pm", action="release", to="employees", ids=[EMP2])
    s.check("releasing to employees before leaders releases nothing", emp_rows(EMP2) == 0 and lead_rows(EMP2) == 0)
    r = post(sup, period=CID, result="pm", action="release", to="employees", ids=[EMP])
    s.check("after release 1 it goes through: the person sees their final band",
            emp_rows(EMP) == 1 and ctx(lambda d: a.released_final_band(d, u(EMP), CID, "pm")) == "ME")
    s.check("the timeline knows it's released",
            ctx(lambda d: a.calibration_progress(d, u(EMP), CID))["released"])

    # -----------------------------------------------------------------------
    s.section("revoking follows the same order")
    post(sup, period=CID, result="pm", action="revoke", to="leaders", ids=[EMP])
    s.check("revoking from leaders while the person has it is refused (both rows stay)",
            lead_rows(EMP, "pm") == 1 and emp_rows(EMP) == 1)
    post(sup, period=CID, result="pm", action="revoke", to="employees", ids=[EMP])
    post(sup, period=CID, result="pm", action="revoke", to="leaders", ids=[EMP])
    s.check("revoke from the person, then from leaders: both gone",
            lead_rows(EMP, "pm") == 0 and emp_rows(EMP) == 0)

    # -----------------------------------------------------------------------
    s.section("a form that names no audience releases to both at once, as the one-step page did")
    post(sup, period=CID, result="pm", action="release", ids=[EMP2])
    s.check("both rows written", lead_rows(EMP2, "pm") == 1 and emp_rows(EMP2) == 1)
    post(sup, period=CID, result="pm", action="revoke", ids=[EMP2])
    s.check("and revoked from both", lead_rows(EMP2, "pm") == 0 and emp_rows(EMP2) == 0)

    # -----------------------------------------------------------------------
    s.section("every employee release counts as a leader release (kept true at boot)")
    ctx(lambda d: (d.execute("INSERT INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pot')",
                             (CID, EMP2)), d.commit()))
    ctx(lambda d: a._ensure_runtime_schema())
    s.check("a release recorded without its leader row gets one", lead_rows(EMP2, "pot") == 1)

    # -----------------------------------------------------------------------
    s.section("the BU CEO's curves never show a later BG CEO or Group Chief call")
    inc = ctx(lambda d: a._pm_calib_incoming_fn(d, "buceo", CID)(u(EMP), None))
    s.check("performance: the BU CEO's curve reads AE (what came from below), not the BG CEO's ME",
            inc["band"] == "AE" and ctx(lambda d: a.pm_effective_band(d, u(EMP), CID, None))["band"] == "ME", inc)
    src = open(a.__file__).read()
    s.check("potential: the BU CEO's band function skips the BG CEO's and a Group Chief's tiers",
            'effective_band(d_, p_, c_, skip_tiers=("bgceo", "group")))' in src)
    s.check("...and that skip reads what came from below",
            ctx(lambda d: a.effective_band(d, u(EMP), CID, skip_tiers=("bgceo", "group")))["band"] == "High")

    # -----------------------------------------------------------------------
    s.section("the potential Self step is on the rating record")
    cols_ = ctx(lambda d: [r[1] for r in d.execute("PRAGMA table_info(rating_records)")])
    s.check("rating_records has pot_self_band", "pot_self_band" in cols_)
    rec_p = {"pot_self_band": "Mid", "pot_raw_band": "Mid", "pot_hod_band": "High", "pot_buceo_band": "High",
             "pot_bgceo_band": "High", "pot_final_band": "High",
             "tiers_json": json.dumps({"pot": {"hod": {"justification": "ZZLR pot reason"}}})}
    chp = a.band_chain(rec_p, "pot", "buceo", True)
    s.check("the potential chain reads Self -> line manager -> HOD (moved, with why) -> BU CEO -> BG CEO",
            [(x["step"], x["state"]) for x in chp["steps"]]
            == [("self", "set"), ("lm", "kept"), ("hod", "moved"), ("buceo", "kept"), ("bgceo", "kept")]
            and chp["steps"][2]["why"] == "ZZLR pot reason" and chp["final"] == "High", chp)

    # -----------------------------------------------------------------------
    s.section("the release page in two steps (canvas boards R1-R2)")

    def rr_rows(ids):
        def f(d):
            per, cyc = a.talent_period_cycle(d, CID)
            return {r["u"]["id"]: r for r in a._result_release_rows(d, per, cyc, [u(i) for i in ids])}
        return ctx(f)
    rows_ = rr_rows([EMP, EMP2])
    r1 = rows_.get(EMP)
    s.check("each row names who release 1 goes to: line manager, HOD and BU CEO",
            r1 and r1["leaders"] == {"lm": "ZZ Leader Line Manager", "hod": "ZZ Leader HOD", "buceo": "ZZ Leader BU CEO"},
            r1 and r1["leaders"])
    s.check("...and when each result went to them (potential is with them, performance isn't)",
            r1 and r1["pot"]["leaders_at"] and not r1["pm"]["leaders_at"], r1 and (r1["pm"], r1["pot"]))
    s.check("...so the person reads 'ready for leaders' (a final band not with them) and 'with leaders' (one is)",
            r1 and r1["ready"] and r1["with_leaders"] and not r1["lead_all"] and not r1["to_emp"], r1)
    r2 = rows_.get(EMP2)
    s.check("...and a result still in calibration can still go to leaders (the dialog warns): lead_open",
            r1 and r1["lead_open"], r1 and r1["lead_open"])
    tpl0 = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "templates",
                             "admin_talent_release.html")).read()
    s.check("...the page's step 1 sends any result not yet with the leaders, final or not (the old page's rule)",
            "if (!l) out.lead = true;" in tpl0 and "if (!l && st === 'final') out.lead" not in tpl0
            and "r['lead_open']" in tpl0)
    s.check("released to the person counts as with their leaders too (step 2 rests on step 1)",
            r2 and r2["pot"]["released_at"] and r2["pot"]["leaders_at"], r2 and r2["pot"])
    rep_before = ctx(lambda d: d.execute("SELECT COUNT(*) FROM report_releases WHERE subject_id=?", (EMP,)).fetchone()[0])
    post(sup, period=CID, bg=BG, result="three", action="release", to="leaders", ids=[EMP])
    s.check("'All three' sends performance, potential and talent status to the leaders, never the 360 report",
            lead_rows(EMP, "pm") == 1 and lead_rows(EMP, "pot") == 1
            and ctx(lambda d: d.execute("SELECT COUNT(*) FROM report_releases WHERE subject_id=?",
                                        (EMP,)).fetchone()[0]) == rep_before)
    s.check("an unknown result is still refused", post(sup, period=CID, result="four", action="release",
                                                       to="leaders", ids=[EMP]).status_code == 400)
    b = sup.get("/admin/talent-release?period=%d&bg=%s" % (CID, BG)).get_data(as_text=True)
    s.check("the page shows the two steps in order and the Show filters, with the leaders' names for the dialog",
            b.find("To leaders") < b.find("To employees") and "Ready for leaders" in b and "With leaders" in b
            and 'data-lm="ZZ Leader Line Manager"' in b and 'data-buceo="ZZ Leader BU CEO"' in b)
    tpl = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "templates",
                            "admin_talent_release.html")).read()
    s.check("its bulk buttons and the Revoke menu are there, and the page uses no browser dialog",
            'id="rr-b1"' in b and 'id="rr-b2"' in b and 'data-rr-revoke="employees"' in b
            and not any(x in tpl for x in ("confirm(", "alert(", "prompt(")))
    b = sup.get("/admin/talent-release?period=%d&bg=%s&status=with_leaders" % (CID, BG)).get_data(as_text=True)
    s.check("Show 'With leaders' lists the person whose results are with their leaders, not the one with nothing",
            "ZZ Leader Person" in b and "ZZ Leader Nobody" not in b)
finally:
    ctx(lambda d: _cleanup(d))
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
        db.commit()

sys.exit(s.done())
