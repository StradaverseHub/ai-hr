"""Leader roles (Roles & access › Leader roles, Chris 2026-10-20: "include the leader role like LM, HOD, BUCEO, BGCEO and
what they can access onto"). A leader role comes from a seat; the super admin switches what each seat may do, for
every leader in it. No row = on, as before.

  * the registry: every ability belongs to a seat that exists; every route the gate names is real
  * the super admin saves the switches (super only, in the audit log); everything starts on
  * a switched-off ability stops the shared writers whichever way they're reached (a page, the bulk route, the chat):
    moderation (line manager vs matrix manager), competency review, the Career Plan close, a calibration move
  * a switched-off view: the calibration resolver refuses it, the journey drops the view, the dashboard card goes
  * the gate's own routes: a page goes to the dashboard, a journey write gets 403 JSON
  * an admin is never stopped by a seat switch
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from werkzeug.exceptions import HTTPException  # noqa: E402

a = H.setup()
s = H.Suite("Leader role access: what each seat may do, switched by the super admin")
assert H.SCRATCH_MARKER in a.DB_PATH
SU, BGA, _E = H.actors(a)
SUP = H.client_as(a, SU["id"])


def ctx(fn, path="/", method="GET"):
    with a.app.test_request_context(path, method=method):
        return fn(a.get_db())


def off(keys):
    def f(d):
        d.execute("DELETE FROM leader_role_access")
        d.executemany("INSERT INTO leader_role_access(role, ability, allowed) VALUES (?,?,0)",
                      [(k.split(".")[0], k, ) for k in keys])
        d.commit()
    ctx(f)


with a.app.app_context():
    db = a.get_db()
    SAVED = [tuple(r) for r in db.execute("SELECT role, ability, allowed FROM leader_role_access")]
    db.execute("DELETE FROM leader_role_access")
    # a line manager with a report, and an HOD, from the harness's own people
    LM = db.execute("SELECT m.* FROM users m JOIN users r ON r.manager_id=m.id WHERE m.role!='admin' AND m.left_at IS NULL "
                    "AND r.left_at IS NULL LIMIT 1").fetchone()
    REP = db.execute("SELECT * FROM users WHERE manager_id=? AND left_at IS NULL LIMIT 1", (LM["id"],)).fetchone()
    OTHER = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND id NOT IN (?,?) "
                       "AND COALESCE(manager_id,0)!=? LIMIT 1", (LM["id"], REP["id"], LM["id"])).fetchone()
    HOD = db.execute("SELECT h.* FROM users h WHERE h.role!='admin' AND h.left_at IS NULL AND EXISTS (SELECT 1 FROM "
                     "users x WHERE x.hod_id=h.id AND x.left_at IS NULL) LIMIT 1").fetchone()
    db.commit()


def u(uid):
    return ctx(lambda d: d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


try:
    s.section("the registry")
    roles = {r for r, _l in a.LEADER_ROLES}
    s.check("every ability belongs to a seat that exists", all(k.split(".")[0] in roles for _g, k, _l, _n in a.LEADER_ABILITIES))
    s.check("every route the gate names is a real route, and its ability is in the registry",
            all(ep in a.app.view_functions and ab in a.LEADER_ABILITY_LABEL for ep, ab in a.LEADER_ENDPOINTS.items()))
    s.check("every calibration tier maps to its seat", set(a.LEADER_TIER_ROLE) == {"hod", "buceo", "bugrp", "bgceo", "group"})
    s.check("everything starts on", ctx(lambda d: a._leader_off(d)) == set()
            and ctx(lambda d: a.leader_can(LM, "lm.moderate", d)))

    s.section("the super admin saves the switches")
    s.check("a BG admin can't (403)", H.client_as(a, BGA["id"]).post("/admin/roles?tab=leader", data={
        "csrf_token": "tok", "action": "save"}).status_code == 403)
    form = {"csrf_token": "tok", "action": "save"}
    form.update({"l_" + k: "1" for _g, k, _l, _n in a.LEADER_ABILITIES if k != "lm.moderate"})
    r = SUP.post("/admin/roles?tab=leader", data=form)
    s.check("unticking one switches it off, for every leader in that seat", r.status_code == 302
            and ctx(lambda d: a._leader_off(d)) == {"lm.moderate"})
    s.check("...in the audit log", "− Line manager: Moderate their reports' KPI results" in ctx(lambda d: (d.execute(
        "SELECT detail FROM activity_log WHERE action='leader_role_access' ORDER BY id DESC LIMIT 1").fetchone() or [""])[0]))
    pg = SUP.get("/admin/roles?tab=leader").get_data(as_text=True)
    s.check("the tab shows every seat and ability, the switched-off one unticked",
            all(lbl in pg for _r, lbl in a.LEADER_ROLES) and 'name="l_lm.moderate" value="1" ' in pg
            and 'name="l_lm.moderate" value="1" checked' not in pg)

    s.section("a switched-off ability stops the shared writer")
    period = ctx(lambda d: a.active_pm_period(d))
    res = ctx(lambda d: a._pm_manager_remark_write(d, LM, period, REP["id"], "ZZ leader test remark"))
    s.check("the line manager's moderation (their report remark) is refused, saying why",
            res[0] is None and res[1].get("reason") == "closed" and "switched off" in (res[1].get("msg") or ""), res)
    s.check("...a KPI line on someone they don't manage is a matrix manager's: that ability is still on",
            ctx(lambda d: a._pm_mod_ability(d, LM, OTHER["id"])) == "mx.moderate"
            and ctx(lambda d: a.leader_ability_off(d, LM, "mx.moderate")) is None)
    off(["lm.competency", "lm.plan", "hod.move", "hod.view", "bu.view", "bu.fit"])
    res = ctx(lambda d: a._tc_override_one(d, LM, a.active_cycle_id(d), REP["id"], 0, "3", ""))
    s.check("a competency review is refused", res[0] is None and res[1].get("reason") == "closed", res)
    res = ctx(lambda d: a._idp_plan_comment_write(d, LM, period, REP["id"], "ZZ"))
    s.check("a Career Plan remark is refused", res[0] is None and res[1].get("reason") == "closed", res)
    res = ctx(lambda d: a._pm_calib_apply(d, HOD or LM, {"population": [], "session": None, "period": period}, "hod",
                                          0, "ME", "ZZ"))
    s.check("an HOD's calibration move is refused, before anything else", res[0] is None and "switched off" in res[1], res)
    res = ctx(lambda d: a._pot_calib_apply(d, HOD or LM, ("hod", "k", {"population": []}), 0, "Mid", "ZZ"))
    s.check("...and on the potential axis", res[0] is None and "switched off" in res[1], res)
    s.check("an admin is never stopped by a seat switch", ctx(lambda d: a.leader_can(SU, "hod.move", d)))

    s.section("a switched-off view")
    def resolve(d):
        try:
            a._pm_calib_resolve(d, HOD or LM, "hod", hod_id=(HOD or LM)["id"])
            return "resolved"
        except HTTPException as e:
            return e.code
    s.check("the calibration resolver refuses the HOD's Department Review (403)", ctx(resolve) == 403)
    if HOD:
        s.check("...the journey drops the Dept view", "dept" not in ctx(lambda d: a._journey_leader_views(d, HOD)))
        s.check("...and the dashboard's Department Review card goes", ctx(lambda d: a.dash_dept_review(d, HOD)) is None)
    s.check("the BU CEO's dashboard card goes when their curve is switched off", ctx(
        lambda d: a.dash_bu_status(d, LM, a.active_cycle(d))) is None)

    s.section("the gate's own routes")
    hc = H.client_as(a, (HOD or LM)["id"])
    r = hc.get("/performance/department")
    s.check("a switched-off page goes to the dashboard", r.status_code == 302 and "/dashboard" in r.headers.get(
        "Location", ""), (r.status_code, r.headers.get("Location")))
    r = hc.post("/review/team/calib-fit", data={"csrf_token": "tok", "mode": "preview"})
    s.check("a journey write gets 403 JSON with the reason", r.status_code == 403 and r.is_json
            and "switched off" in (r.get_json() or {}).get("error", ""), r.status_code)
    s.check("the super admin's own page still opens", SUP.get("/performance/department").status_code != 403)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM leader_role_access")
        db.executemany("INSERT INTO leader_role_access(role, ability, allowed) VALUES (?,?,?)", SAVED)
        db.execute("DELETE FROM activity_log WHERE action='leader_role_access' AND detail LIKE '%Line manager%'")
        db.commit()

sys.exit(s.done())
