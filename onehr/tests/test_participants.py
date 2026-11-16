"""Who takes part in a cycle's own review (Chris, 2026-10-02: "admin can add people to the current active cycle").

The rule (participant_sql / participation), since Roles & access (Chris, 2026-10-20): their user role opens it -- Full
once their confirmation date has come, straight into a running cycle ("they will go to the year end cycle straight");
Basic until then; while the rollout switch is on, more than a year's service still counts -- unless an admin took them
out; or added by an admin. The review populations, the KPI import, the competency generator, the panel
build and the progress pages all read it; rating colleagues does not. Everything here is synthetic (ZZPT-*) and is
removed at the end.
"""
import html
import io
import re
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Participants -- confirmed before the cycle opened, or added by an admin")

BG, CO = "ZZPT BG", "ZZPT CO"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZPT-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        for t in ("cycle_participants", "pm_kpi_targets", "tc_assignments"):
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (t, ph), ids)
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM activity_log WHERE target_user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    OPENED = CYC["starts_on"] or (CYC["created_at"] or "")[:10]
    _cleanup(db)
    # over a year's service counts only while the super admin's rollout switch is on (Roles & access, 2026-10-20):
    # on for this suite's service case, put back after
    _svc = db.execute("SELECT value FROM app_settings WHERE key=?", (a.UROLE_SERVICE_KEY,)).fetchone()
    _svc = _svc[0] if _svc else None
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, '1')", (a.UROLE_SERVICE_KEY,))
    _rev = [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=?",
                                         (CID,))]
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','pm','tm')", (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, yos=0, cd=None, left=None):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None,
                 manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO,
                 years_of_service=yos, confirmation_date=cd, left_at=left, is_demo=0, role="user")
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    A = mk("ZZPT-A", "ZZ Part Service", yos=3)                       # over a year's service
    B = mk("ZZPT-B", "ZZ Part Dated", cd="2000-01-01")               # confirmed long before the cycle opened
    C = mk("ZZPT-C", "ZZ Part Late", cd="2099-01-01")                # a confirmation date still to come: Basic
    # confirmed after the cycle opened, on a day that has come: Full, straight into the running cycle (2026-10-20)
    F = mk("ZZPT-F", "ZZ Part Midcycle", cd=a._today_myt().isoformat())
    D = mk("ZZPT-D", "ZZ Part Unconfirmed")                          # not confirmed
    E = mk("ZZPT-E", "ZZ Part Leaver", yos=5, left="2026-01-01")     # left
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]


def _page_text(body, at):
    t = re.sub(r"\s+", " ", re.sub(r"<script.*?</script>|<[^>]+>", " ", body, flags=re.S))
    return t[max(0, t.find(at)):][:600]


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def u(uid):
    return ctx(lambda d: dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


def why(uid):
    return ctx(lambda d: a.participation(d, u(uid)))


def in_sql(uid):
    return ctx(lambda d: d.execute("SELECT 1 FROM users WHERE id=? AND " + a.participant_sql(), (uid,))
               .fetchone() is not None)


def setp(uid, mode):
    def f(d):
        if mode is None:
            d.execute("DELETE FROM cycle_participants WHERE cycle_id=? AND subject_id=?", (CID, uid))
        else:
            d.execute("INSERT OR REPLACE INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,?)",
                      (CID, uid, mode))
        d.commit()
    ctx(f)


try:
    # -----------------------------------------------------------------------
    s.section("the rule, and its SQL and Python agree")
    s.check("(the active cycle has an opening date to compare against)", bool(OPENED), OPENED)
    got = {k: why(v) for k, v in (("A", A), ("B", B), ("C", C), ("D", D), ("E", E), ("F", F))}
    s.check("over a year's service (the switch on), confirmed before it opened, or confirmed during it on a day that "
            "has come: taking part; a date still to come, not confirmed, or left: not",
            got["A"] == (True, "confirmed") and got["B"] == (True, "confirmed") and got["F"] == (True, "confirmed")
            and got["C"] == (False, "not_confirmed") and got["D"] == (False, "not_confirmed")
            and got["E"] == (False, "left"), got)
    s.check("participant_sql says the same for all six",
            [in_sql(x) for x in (A, B, C, D, E, F)] == [True, True, False, False, False, True],
            [in_sql(x) for x in (A, B, C, D, E, F)])

    s.section("an admin adds, takes out, and clears")
    setp(C, "add")
    setp(A, "remove")
    s.check("added: taking part; taken out: not -- both in SQL and Python",
            why(C) == (True, "added") and why(A) == (False, "removed") and in_sql(C) and not in_sql(A),
            (why(C), why(A)))
    setp(E, "add")
    s.check("a leaver stays out even when added", why(E) == (False, "left") and not in_sql(E))
    s.check("the calibration population follows it (added in, taken out out)",
            ctx(lambda d: {r[0] for r in d.execute(
                "SELECT id FROM users WHERE business_group=? AND " + a.calibration_population_sql(), (BG,))})
            == {B, C, F})
    s.check("so does the journey's own rule (review_state's participant flag)",
            ctx(lambda d: a.review_state(d, u(C))["participant"]) is True
            and ctx(lambda d: a.review_state(d, u(A))["participant"]) is False)
    s.check("and the progress pages count only people taking part",
            ctx(lambda d: set(a._mod_scope_users(d, {"role": "admin", "admin_bg": None, "id": SUP}, BG)))
            == {B, C, F})
    setp(A, None)
    setp(C, None)
    setp(E, None)
    s.check("cleared: back on the confirmation rule", why(A)[0] and not why(C)[0])

    # -----------------------------------------------------------------------
    s.section("the dashboard card: nothing of their own to do")
    rs = ctx(lambda d: a.dash_review_summary(d, u(D)))
    # the Career Plan is everyone's (Chris, 2026-10-19): someone not confirmed has it, and nothing else of their own
    _plan = {"ahead", "career"}
    s.check("someone not confirmed has none of their PM / TM parts on the card, only their Career Plan",
            rs is not None and not any(x["key"] in set(a._REVIEW_OWN_KEYS) - _plan for x in rs["stages"])
            and {x["key"] for x in rs["stages"]} == _plan and not rs["not_required"],
            rs and [x["key"] for x in rs["stages"]])

    ctx(lambda d: (d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) "
                             "VALUES (?,?,?,?,?)", (CID, B, D, "peer", "pending")), d.commit()))
    rs = ctx(lambda d: a.dash_review_summary(d, u(D)))
    s.check("...and a 360 they owe a colleague stays on it beside the plan (rating others never needed it)",
            rs and not rs["not_required"] and {x["key"] for x in rs["stages"]} == _plan | {"feedback"},
            rs and [(x["key"], x.get("n_total")) for x in rs["stages"]])

    # -----------------------------------------------------------------------
    s.section("the competency generator and the panel build leave them out")
    me = ctx(lambda d: dict(d.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone()))
    rep = ctx(lambda d: a.tc_generate_assignments(d, me, CID, commit=False))
    np_ids = {x["id"] for x in rep["not_part"]}
    s.check("the generator lists C and D as not taking part, and never plans them",
            {C, D} <= np_ids and A not in np_ids
            and not any(x["id"] in (C, D) for k in ("assign", "started", "empty", "unmapped") for x in rep[k]))
    plan = ctx(lambda d: a._panel_build_plan(d, me, CID, "missing", bg=BG))
    s.check("the panel build considers only the three taking part in this business group (F confirmed mid-cycle)",
            plan["in_scope"] == 3, plan["in_scope"])
    setp(C, "add")
    plan = ctx(lambda d: a._panel_build_plan(d, me, CID, "missing", bg=BG))
    s.check("...four once C is added", plan["in_scope"] == 4, plan["in_scope"])
    setp(C, None)

    # -----------------------------------------------------------------------
    s.section("the KPI import skips and names them")
    sup = H.client_as(a, SUP)
    csv = "Employee ID,KPI,Weightage,Method\nZZPT-D,ZZPT KPI,100,More\n"
    r = sup.post("/admin/performance/import", data={"csrf_token": "tok", "preview": "1",
                                                     "file": (io.BytesIO(csv.encode()), "kpi.csv")},
                 content_type="multipart/form-data", follow_redirects=True)
    body = r.get_data(as_text=True)
    s.check("the quality step names ZZPT-D as not taking part", r.status_code == 200
            and "ZZPT-D: 1 row skipped" in html.unescape(body) and "person isn't taking part" in html.unescape(body),
            (r.status_code, _page_text(body, "Importing into")))
    r = sup.post("/admin/performance/import", data={"csrf_token": "tok",
                                                    "file": (io.BytesIO(csv.encode()), "kpi.csv")},
                 content_type="multipart/form-data")
    s.check("the import writes nothing for them", r.status_code == 302 and ctx(lambda d: d.execute(
        "SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=?", (D,)).fetchone()[0]) == 0, r.status_code)

    # -----------------------------------------------------------------------
    s.section("the admin page")
    emp = H.client_as(a, A)
    s.check("an employee can't open it", emp.get("/admin/participants").status_code in (302, 403, 404))
    r = sup.get("/admin/participants?bg=%s" % BG)
    body = r.get_data(as_text=True)
    s.check("it lists who isn't taking part, and why", r.status_code == 200 and "ZZ Part Late" in body
            and "ZZ Part Unconfirmed" in body and "not confirmed yet" in body.lower()
            and "ZZ Part Service" not in body, r.status_code)
    r = sup.post("/admin/participants", data={"csrf_token": "tok", "action": "add", "ids": [C, D], "bg": BG})
    s.check("Add puts them in the cycle, and it's logged", r.status_code == 302 and why(C) == (True, "added")
            and why(D) == (True, "added") and ctx(lambda d: d.execute(
                "SELECT COUNT(*) FROM activity_log WHERE action='participant' AND target_user_id IN (?,?)",
                (C, D)).fetchone()[0]) == 2)
    r = sup.post("/admin/participants", data={"csrf_token": "tok", "action": "clear", "ids": [C, D], "bg": BG})
    s.check("Back to the rule clears it", not why(C)[0] and not why(D)[0])
    r = sup.post("/admin/participants", data={"csrf_token": "tok", "action": "promote", "ids": [C]})
    s.check("an unknown action is refused", r.status_code == 400, r.status_code)
    _su, BGA, _e = H.actors(a)
    if BGA and BGA["admin_bg"] != BG:
        r = H.client_as(a, BGA["id"]).post("/admin/participants",
                                            data={"csrf_token": "tok", "action": "add", "ids": [C]})
        s.check("a BG admin can't change someone outside their business groups", r.status_code == 403,
                r.status_code)

    s.section("rating colleagues never needed it")
    src = H.source(a)
    seg = src[src.index('if not key.startswith("pick_"):'):src.index('if not key.startswith("pick_"):') + 2000]
    s.check("the bulk 'Add suggested' no longer refuses an unconfirmed (active) assessor",
            "is_confirmed_row" not in seg and 'arow["left_at"]' in seg)
    _n, bad = H.every_template_compiles(a)
    s.check("every template compiles", not bad, bad)
finally:
    def _fin(d):
        _cleanup(d)
        if _svc is None:
            d.execute("DELETE FROM app_settings WHERE key=?", (a.UROLE_SERVICE_KEY,))
        else:
            d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (a.UROLE_SERVICE_KEY, _svc))
        for cyc_id, key, act in _rev:
            d.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (act, cyc_id, key))
        d.commit()
    ctx(_fin)

sys.exit(s.done())
