"""A switched-off module stops its WRITES too, and a refused write makes no row (security tests 1b-01, 1b-02, 1b-07, 2026-10-31).

1b-01  The leaders' chat tools reach the calibration writers through a route classed `review`, so the module gate never saw
       the module whose work they do. The three shared writers now refuse: `_pot_calib_apply` and `_talent_box_apply` with
       Calibration (and the Talent Box's Talent Management) off, `_pm_calib_apply` with Performance off, or with Calibration
       off for every tier above the HOD -- the Mid-Year HOD, who has no calibration, keeps working with it off.
1b-02  The five own-data writers (KPI remark, competency remark and submit, Career Plan save-all and share) are classed
       `review` (phase infrastructure): each asks for its own module (pm, tm, idp).
1b-07  A refused write no longer makes an empty row (`tc_assessments`, `pm_idp`) for someone who does not hold the part,
       and what a CEO, a delegate or a rater sees of their review does not change.

Its own synthetic business group; the suite writes, so it takes a fresh copy (which also puts the cycle's module rows back).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("A switched-off module stops its writes; a refused write makes no row (1b-01, 1b-02, 1b-07)")
a.ai_draft.review_agent_available = lambda: True
BG, CA = "ZZMO Group", "ZZMO Alpha Sdn Bhd"

with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    for k in ("ai_calib", "review_unified"):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, kpi=True, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CA)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        uid = db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
        if kpi:
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group) "
                       "VALUES (?,?,?,100,'more','approved',?)", (PER, uid, "ZZMO KPI", BG))
        return uid
    BUC = person("ZZMO-BUC", "ZZ MO Unit CEO", buceo_bg=BG, buceo_company=CA)
    BGC = person("ZZMO-BGC", "ZZ MO Group CEO", bgceo_bg=BG)
    HODU = person("ZZMO-HOD", "ZZ MO Dept Head")
    P = [person("ZZMO-P%d" % i, "ZZ MO Person %d" % i, hod_id=HODU) for i in range(4)]
    EMP = person("ZZMO-EMP", "ZZ MO Employee")                  # the one whose own writers are tried
    NOPART = person("ZZMO-OUT", "ZZ MO Delegate", kpi=False)    # holds no competency and no plan row: a delegate / rater
    db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_category, active) VALUES ('ZZMO-S1','ZZMO Planning',3,'Analytics',1)")
    SK = db.execute("SELECT id FROM tc_skills WHERE skill_code='ZZMO-S1'").fetchone()[0]
    db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, source) VALUES (?,?,?, 'manual')", (CID, EMP, SK))
    TCA = db.execute("SELECT id FROM tc_assignments WHERE subject_id=?", (EMP,)).fetchone()[0]
    db.commit()
PN = ["ZZ MO Person %d" % i for i in range(4)]
ALL = ("pm", "tm", "idp", "calibration", "review")


def mods(**kw):
    """Switch modules on (True) or off (False) for the cycle: a stored row each, as a started cycle has."""
    with a.app.test_request_context("/"):
        d = a.get_db()
        for k in ALL:
            d.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?) "
                      "ON CONFLICT(cycle_id, module_key) DO UPDATE SET active=excluded.active",
                      (CID, k, 1 if kw.get(k, True) else 0))
        d.commit()


def rows(table, uid, col="subject_id"):
    return H.one(a, "SELECT COUNT(*) FROM %s WHERE %s=?" % (table, col), (uid,))


def run_tool(who, stage, action):
    """The stage's own tool runner, as the chat loop calls it, inside a request for that leader."""
    from flask import session as _fs
    with a.app.test_request_context("/review/chat", method="POST", data={"view": {"calibration": "bu", "calibration_pot": "bu",
                                                                              "talent_box": "bg"}[stage], "stage": stage}):
        _fs["user_id"] = who
        db = a.get_db()
        res = a._journey_team_run_stage_tool(db, a.current_user(), CID, stage, None, action)
        db.commit()
    return res


# ---------------------------------------------------------------------------
s.section("1b-01 the calibration writers: Calibration off")
mods()
n0 = rows("pm_calibration_adjustments", P[0])
ok1 = run_tool(BUC, "calibration", {"tool": "move_band", "args": {"subject": PN[0], "band": "AE"}})
s.check("control, every module on: the BU CEO's performance move writes",
        ok1.get("ok") and rows("pm_calibration_adjustments", P[0]) == n0 + 1, ok1)
mods(calibration=False)
n1 = rows("pm_calibration_adjustments", P[1])
r = run_tool(BUC, "calibration", {"tool": "move_band", "args": {"subject": PN[1], "band": "AE"}})
s.check("Calibration off: the BU CEO's performance move is refused, in words, and writes nothing",
        r.get("ok") is False and "Calibration isn't running this cycle" in (r.get("error") or "")
        and rows("pm_calibration_adjustments", P[1]) == n1, r)
n2 = rows("calibration_adjustments", P[1])


def scope_then(who, kind):
    """The leader's scope as it is with every module on (the chat opens its part from it), for a writer to be handed after
    a module is switched off -- the writers must not lean on the scope having said no."""
    from flask import session as _fs
    mods()
    with a.app.test_request_context("/review/chat", method="POST", data={"view": "bu", "stage": "calibration_pot"}):
        _fs["user_id"] = who
        d = a.get_db()
        u_ = a.current_user()
        return (a._pot_calib_scope(d, u_, fresh=True) if kind == "pot" else a._journey_talent_box_scope(d, u_, fresh=True))


SC_POT = scope_then(BUC, "pot")
mods(calibration=False)
with a.app.test_request_context("/"):
    from flask import session as _fs
    _fs["user_id"] = BUC
    d = a.get_db()
    sub, err = a._pot_calib_apply(d, a.current_user(), SC_POT, P[1], "High", "")
s.check("Calibration off: the potential writer refuses (even handed a scope), in words, and writes nothing",
        sub is None and "Calibration isn't running this cycle" in (err or "") and rows("calibration_adjustments", P[1]) == n2, err)
r = run_tool(BUC, "calibration_pot", {"tool": "move_band", "args": {"subject": PN[1], "band": "High"}})
s.check("...and through the chat's tool runner the move does not happen either", r.get("ok") is False
        and rows("calibration_adjustments", P[1]) == n2, r)
n3 = rows("pm_calibration_adjustments", P[2])
SC_TB = scope_then(BGC, "tb")
mods(calibration=False)
with a.app.test_request_context("/"):
    from flask import session as _fs
    _fs["user_id"] = BGC
    d = a.get_db()
    ok_, msg_ = a._talent_box_apply(d, a.current_user(), SC_TB[0], SC_TB[2], P[2], "AE", "", "")
s.check("Calibration off: the Talent Box writer refuses and writes nothing",
        ok_ is False and "isn't running this cycle" in (msg_ or "") and rows("pm_calibration_adjustments", P[2]) == n3, msg_)
r = run_tool(BGC, "talent_box", {"tool": "move_person", "args": {"subject": PN[2], "performance_band": "AE"}})
s.check("...and through the chat's tool runner too", r.get("ok") is False and rows("pm_calibration_adjustments", P[2]) == n3, r)
# the HOD's department review: Performance's, with no calibration at Mid-Year -- it keeps working with Calibration off
with a.app.test_request_context("/"):
    from flask import session as _fs
    _fs["user_id"] = HODU
    db = a.get_db()
    sc = a._journey_calib_scope(db, a.current_user(), fresh=True)
    sub, err = a._pm_calib_apply(db, a.current_user(), sc[2], "hod", P[3], "AE", "they carried the launch", dry_run=True)
s.check("...but the HOD's department review (Performance's) still passes with Calibration off", err is None and sub, err)
mods(calibration=False, pm=False)
with a.app.test_request_context("/"):
    from flask import session as _fs
    _fs["user_id"] = HODU
    db = a.get_db()
    sc = a._journey_calib_scope(db, a.current_user(), fresh=True)
    sub, err = a._pm_calib_apply(db, a.current_user(), sc[2], "hod", P[3], "AE", "they carried the launch", dry_run=True)
s.check("Performance off: even the HOD's performance move is refused", sub is None and "Performance isn't running" in (err or ""), err)
mods(tm=False)
with a.app.test_request_context("/"):
    from flask import session as _fs
    _fs["user_id"] = BGC
    d = a.get_db()
    ok_, msg_ = a._talent_box_apply(d, a.current_user(), SC_TB[0], SC_TB[2], P[2], "AE", "", "")
s.check("Talent Management off: the Talent Box writer refuses", ok_ is False and "isn't running" in (msg_ or ""), msg_)
mods()
r = run_tool(BGC, "talent_box", {"tool": "move_person", "args": {"subject": PN[2], "performance_band": "AE"}})
s.check("...and with everything back on it writes again", r.get("ok") and rows("pm_calibration_adjustments", P[2]) == n3 + 1, r)

s.section("1b-01 end to end: the chat route, model forced, asked in words")
_real = a.ai_draft.review_agent
cb = H.client_as(a, BUC)
try:
    a.ai_draft.review_agent = lambda system, history: (
        {"say": "ok", "quick_replies": [], "action": None} if history and history[-1].get("role") == "tool" else
        {"say": "Moving.", "quick_replies": [], "action": {"tool": "move_band", "args": {"subject": PN[1], "band": "OU"}}})
    mods(calibration=False)
    n = rows("pm_calibration_adjustments", P[1])
    cb.post("/review/chat", data={"csrf_token": "tok", "message": "Move %s to OU" % PN[1], "journey": "1", "view": "bu",
                                  "stage": "calibration"})
    s.check("Calibration off, asked outright: the chat writes nothing", rows("pm_calibration_adjustments", P[1]) == n)
    mods()
    cb.post("/review/chat", data={"csrf_token": "tok", "message": "Move %s to OU" % PN[1], "journey": "1", "view": "bu",
                                  "stage": "calibration"})
    s.check("...and with it on, the same turn writes", rows("pm_calibration_adjustments", P[1]) == n + 1)
finally:
    a.ai_draft.review_agent = _real

# ---------------------------------------------------------------------------
s.section("1b-02 the five own-data writers ask for their module")
ce = H.client_as(a, EMP)
FORMS = [
    ("pm", "/review/kpi/remark", {"remark": "My year was good"}, lambda: rows("pm_overall_remarks", EMP)),
    ("tm", "/review/competency/remark", {"remark": "My strengths"}, lambda: H.one(
        a, "SELECT COUNT(*) FROM tc_assessments WHERE subject_id=? AND COALESCE(overall_remark,'')!=''", (EMP,))),
    ("tm", "/review/competency/submit", {}, lambda: rows("tc_assessments", EMP)),
    ("idp", "/review/ahead/save-all", {"g_count": "1", "g0_id": "", "g0_area": "ZZMO leadership"},
     lambda: H.one(a, "SELECT COUNT(*) FROM pm_idp_goals g JOIN pm_idp i ON i.id=g.idp_id WHERE i.subject_id=?", (EMP,))),
    ("idp", "/review/ahead/submit", {}, lambda: rows("pm_idp", EMP)),
]
for mod, url, data, count in FORMS:
    mods(**{mod: False})
    before = count()
    r = ce.post(url, data=dict(data, csrf_token="tok"))
    s.check("%s off: POST %s answers 404 and writes nothing" % (mod, url), r.status_code == 404 and count() == before,
            (r.status_code, before, count()))
    mods()
    r2 = ce.post(url, data=dict(data, csrf_token="tok"))
    s.check("control, %s on: the same POST reaches its writer (not 404)" % mod, r2.status_code != 404, r2.status_code)
s.check("...and the writers that took the control posts actually wrote (the guard is the only difference)",
        rows("pm_overall_remarks", EMP) == 1 and FORMS[3][3]() == 1 and FORMS[1][3]() == 1)
# the typed paths the chat shares with those routes
mods(tm=False)
with a.app.test_request_context("/"):
    from flask import session as _fs
    _fs["user_id"] = EMP
    ok_, err_ = a._tc_do_submit(a.get_db(), a.current_user(), CID)
s.check("the typed competency submit asks too (_tc_do_submit)", ok_ is False and "isn't running" in (err_ or ""), err_)
mods(idp=False)
with a.app.test_request_context("/"):
    from flask import session as _fs
    _fs["user_id"] = EMP
    ok_, err_ = a._idp_do_share(a.get_db(), a.current_user())
s.check("...and the typed plan share (_idp_do_share)", ok_ is False and "isn't running" in (err_ or ""), err_)
mods()

# ---------------------------------------------------------------------------
s.section("1b-07 a refused write makes no row, and what the person sees of their review does not change")


def seen(uid):
    from flask import session as _fs
    with a.app.test_request_context("/review/journey"):
        _fs["user_id"] = uid
        d = a.get_db()
        st = a.review_state(d, a.current_user())
        return json.dumps([(x["key"], x["state"], x.get("n_open"), x.get("n_total")) for x in st["stages"]], default=str)


ct = H.client_as(a, NOPART)
before = (rows("tc_assessments", NOPART), rows("pm_idp", NOPART), seen(NOPART))
r1 = ct.post("/technical/autosave", data={"csrf_token": "tok", "assignment_id": str(TCA), "answer": "yes"})
r2 = ct.post("/review/competency/submit", data={"csrf_token": "tok"})
r3 = ct.post("/idp/autosave", data={"csrf_token": "tok", "action": "field", "goal_id": "999999", "field": "area", "value": "x"})
after = (rows("tc_assessments", NOPART), rows("pm_idp", NOPART), seen(NOPART))
s.check("/technical/autosave on someone else's competency: 403, no tc_assessments row", r1.status_code == 403 and after[0] == before[0] == 0,
        (r1.status_code, before[0], after[0]))
s.check("/review/competency/submit for someone with no competencies: 400, no tc_assessments row", r2.status_code == 400
        and after[0] == 0, (r2.status_code, after[0]))
s.check("/idp/autosave on a goal that is not theirs: 403, no pm_idp row", r3.status_code == 403 and after[1] == before[1] == 0,
        (r3.status_code, before[1], after[1]))
s.check("...and their review (the stages, their states and counts) is exactly as before", before[2] == after[2], (before[2], after[2]))
# the controls: the person who DOES hold the part still gets their row on a real write
n_t = rows("tc_assessments", EMP)
ce.post("/technical/autosave", data={"csrf_token": "tok", "assignment_id": str(TCA), "answer": "yes"})
s.check("control: the person who holds the competency still gets their row on a real answer (kept)", rows("tc_assessments", EMP) >= 1
        and H.one(a, "SELECT COUNT(*) FROM tc_scores sc JOIN tc_assessments t ON t.id=sc.assessment_id WHERE t.subject_id=?", (EMP,)) == 1)
ce.post("/idp/autosave", data={"csrf_token": "tok", "action": "add", "area": "ZZMO"})
s.check("control: a plan row is still made by an add", rows("pm_idp", EMP) == 1)
s.check("a goal edit on a plan that is not there is refused with no row either (the plan row only an add makes)",
        ct.post("/idp/autosave", data={"csrf_token": "tok", "action": "remove", "goal_id": "1"}).status_code == 403
        and rows("pm_idp", NOPART) == 0)

sys.exit(s.done())
