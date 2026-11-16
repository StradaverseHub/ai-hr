"""User roles (Roles & access, Chris 2026-10-20): what each kind of employee can use for themselves.

  * Full and Basic are built in: Full opens everything; Basic rates colleagues, writes a Career Plan, uses AI+ Learning
  * a person is Basic until the super admin's confirmation date has come, then Full by itself -- straight into a
    running cycle; while the rollout switch is on, more than a year's service still counts; a role given by hand wins
  * the SQL (urole_allows_sql, participant_sql, idp_participant_sql, assessor_eligible_sql) and the Python
    (urole_modules_of, participation) agree, person by person and module by module
  * a part the role doesn't open is off in the journey, and its own pages and writes are shut (_urole_gate)
  * results and the 360 report follow the role; the release email skips someone whose role shows no results
  * the super admin creates a role, ticks what it opens, gives it by hand, retires it; nobody else can
  * the years-of-service switch: the list it moves (Excel), switching it off moves them to Basic, in the audit log
  * confirming someone is the super admin's: a BG admin is refused, and their Add a person has no confirmation date
  * someone confirmed during the running cycle shows on New joiners, to set up
Everything here is synthetic (ZZUR-*) and removed at the end.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("User roles: Basic until confirmed, then Full; roles the super admin creates")
assert H.SCRATCH_MARKER in a.DB_PATH
SU, BGA, _E = H.actors(a)
BG, CO = "ZZUR BG", "ZZUR CO"
ROLE = "ZZUR Intern"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZUR-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE target_user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    rid = [r[0] for r in db.execute("SELECT id FROM user_roles WHERE name LIKE 'ZZUR%'")]
    for r in rid:
        db.execute("DELETE FROM user_role_modules WHERE role_id=?", (r,))
        db.execute("DELETE FROM user_roles WHERE id=?", (r,))
    db.execute("DELETE FROM activity_log WHERE action LIKE 'user_role%' AND detail LIKE '%ZZUR%'")
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    _cleanup(db)
    CYC = dict(a.active_cycle(db))
    OPENED = CYC["starts_on"] or (CYC["created_at"] or "")[:10]
    SVC0 = db.execute("SELECT value FROM app_settings WHERE key=?", (a.UROLE_SERVICE_KEY,)).fetchone()
    SVC0 = SVC0[0] if SVC0 else None
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, '1')", (a.UROLE_SERVICE_KEY,))
    _mods = [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=?",
                                          (CYC["id"],))]
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','pm','tm','idp')",
               (CYC["id"],))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]
    TODAY = a._today_myt().isoformat()

    def mk(eid, name, yos=0, cd=None):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO, years_of_service=yos,
                 confirmation_date=cd, left_at=None, is_demo=0, role="user", user_role_id=None, job_grade="14")
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    FULL = mk("ZZUR-FULL", "ZZ Role Confirmed", cd="2001-01-01")
    LATE = mk("ZZUR-LATE", "ZZ Role Future", cd="2099-01-01")
    SVC = mk("ZZUR-SVC", "ZZ Role Service", yos=3)
    BASIC = mk("ZZUR-BASIC", "ZZ Role Unconfirmed")
    MID = mk("ZZUR-MID", "ZZ Role Midcycle", cd=TODAY)
    db.commit()
    FULL_ID = db.execute("SELECT id FROM user_roles WHERE builtin='full'").fetchone()[0]
    BASIC_ID = db.execute("SELECT id FROM user_roles WHERE builtin='basic'").fetchone()[0]

SUP, BAC = H.client_as(a, SU["id"]), H.client_as(a, BGA["id"])
PEOPLE = {"FULL": FULL, "LATE": LATE, "SVC": SVC, "BASIC": BASIC, "MID": MID}


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def row(uid):
    return ctx(lambda d: d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def mods(uid):
    return ctx(lambda d: a.urole_modules_of(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone(), d))


def sql_has(uid, pred):
    return ctx(lambda d: d.execute("SELECT 1 FROM users WHERE id=? AND " + pred, (uid,)).fetchone() is not None)


def setting(v):
    def f(d):
        d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (a.UROLE_SERVICE_KEY, v))
        d.commit()
    ctx(f)


try:
    s.section("the rollout ran once: over a year's service, no date -> confirmed that day; then service stops counting")
    with a.app.app_context():
        _d = a.get_db()
        _done = _d.execute("SELECT value FROM app_settings WHERE key='urole_rollout_done'").fetchone()
        _rec = _d.execute("SELECT value FROM app_settings WHERE key='urole_rollout_confirmed'").fetchone()
        _left = _d.execute("SELECT COUNT(*) FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE("
                           "years_of_service, 0) > 1 AND (confirmation_date IS NULL OR trim(confirmation_date)='') "
                           "AND employee_id NOT LIKE 'ZZUR-%'").fetchone()[0]
    s.check("it ran, and kept the list it confirmed (to undo by hand)", _done is not None and _rec is not None)
    s.check("...nobody from before is left with over a year's service and no date", _left == 0, _left)

    with a.app.app_context():
        _d = a.get_db()
        _nc = lambda: {j["p"]["id"] for j in a._joiners(_d, _d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()) if j["newly_confirmed"]}
        _in = MID in _nc()
        _d.execute("UPDATE app_settings SET value=? WHERE key='urole_rollout_confirmed'", (json.dumps(
            dict(json.loads(_rec[0]), ids=json.loads(_rec[0])["ids"] + [MID])),))
        _out = MID not in _nc() and MID not in {j["p"]["id"] for j in a._joiners(_d, _d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())}
        _d.execute("UPDATE app_settings SET value=? WHERE key='urole_rollout_confirmed'", (_rec[0],))
        _d.commit()
    s.check("someone confirmed today shows on New joiners as newly confirmed", _in)
    s.check("...but not when the rollout dated them (they were taking part already)", _out)

    s.section("Full and Basic are built in, with what Chris named")
    s.check("Full opens everything", ctx(lambda d: a._urole_map(d)["mods"][FULL_ID]) == set(a.UROLE_MODULE_KEYS))
    s.check("Basic rates colleagues, writes a Career Plan, uses AI+ Learning, sees their released results on the "
            "dashboard -- no KPI check-in, own 360 or competency",
            ctx(lambda d: a._urole_map(d)["mods"][BASIC_ID]) == {"tm_rate", "idp", "lms", "results", "gradeh"} |
            set(a.UROLE_SELF_KEYS) | set(a.UROLE_LMS_SUBS))   # ...their own learning on the dashboard too (2026-10-20,
    # on by default), and Learning's own parts (XP and badges, 2026-10-21)

    s.section("who is which, and SQL and Python agree")
    want = {"FULL": a.UROLE_DEFAULTS["full"], "LATE": a.UROLE_DEFAULTS["basic"], "SVC": a.UROLE_DEFAULTS["full"],
            "BASIC": a.UROLE_DEFAULTS["basic"], "MID": a.UROLE_DEFAULTS["full"]}
    got = {k: mods(v) for k, v in PEOPLE.items()}
    s.check("confirmed, or confirmed today (mid-cycle), or over a year's service while the switch is on: Full; a date "
            "still to come, or none: Basic", got == want, {k: sorted(v) for k, v in got.items()})
    bad = [(k, m) for k, v in PEOPLE.items() for m in a.UROLE_MODULE_KEYS
           if sql_has(v, a.urole_allows_sql(m)) != (m in got[k])]
    s.check("urole_allows_sql agrees with the Python, person by person and module by module", not bad, bad[:5])
    s.check("taking part (participant_sql): Full in, Basic out -- the one confirmed mid-cycle in too",
            [sql_has(PEOPLE[k], a.participant_sql()) for k in ("FULL", "LATE", "SVC", "BASIC", "MID")]
            == [True, False, True, False, True])
    s.check("...and participation() says the same, with why",
            [ctx(lambda d, k=k: a.participation(d, row(PEOPLE[k]))) for k in ("FULL", "BASIC", "MID")]
            == [(True, "confirmed"), (False, "not_confirmed"), (True, "confirmed")])
    s.check("everyone writes a Career Plan (Basic opens it)",
            all(sql_has(v, a.idp_participant_sql()) for v in PEOPLE.values()))
    s.check("...and everyone may rate colleagues", all(sql_has(v, a.assessor_eligible_sql()) for v in PEOPLE.values()))

    s.section("the journey: a part the role doesn't open is off")
    st = ctx(lambda d: a.review_state(d, row(BASIC)))
    stg = {x["key"]: x["state"] for x in st["stages"]}
    s.check("Basic's KPI check-in and competency are off; their Career Plan and the 360 they give are not",
            stg.get("account", a.REVIEW_STATE_OFF) == a.REVIEW_STATE_OFF
            and stg.get("competency", a.REVIEW_STATE_OFF) == a.REVIEW_STATE_OFF
            and not st["participant"] and st["idp_participant"], stg)
    E = H.client_as(a, BASIC)
    r = E.get("/performance")
    s.check("their own Performance page goes to the dashboard, saying why", r.status_code == 302
            and "/dashboard" in r.headers.get("Location", ""), (r.status_code, r.headers.get("Location")))
    s.check("...a write to it gets a bare 404", E.post("/performance/submit-all", data={"csrf_token": "tok"}
                                                        ).status_code == 404)
    s.check("...their competency page too", E.get("/technical").status_code == 302)
    s.check("...but not their Career Plan (Basic opens it)", E.get("/idp").status_code != 404
            and "/dashboard" not in (E.get("/idp").headers.get("Location") or ""))
    s.check("every page the gate names is a real route", not [ep for ep in a.UROLE_ENDPOINTS
                                                              if ep not in a.app.view_functions])

    s.section("results and the 360 report follow the role")
    s.check("Basic has no 360 report (they aren't rated)", ctx(lambda d: a._report_cycles(d, row(BASIC)) == []))

    s.section("the super admin creates a role, ticks it, gives it by hand")
    s.check("a BG admin can't open User roles (403)", BAC.get("/admin/roles?tab=user").status_code == 403)
    r = SUP.post("/admin/roles?tab=user", data={"csrf_token": "tok", "action": "add_role", "name": ROLE})
    RID = ctx(lambda d: (d.execute("SELECT id FROM user_roles WHERE name=?", (ROLE,)).fetchone() or [None])[0])
    s.check("it's added, opening what Basic opens", RID and ctx(lambda d: a._urole_map(d)["mods"].get(RID))
            == a.UROLE_DEFAULTS["basic"])
    _lms_t = os.environ.get("ONEHR_LMS")
    os.environ["ONEHR_LMS"] = "1"   # the AI+ Learning row is there to untick only where Learning is on
    SUP.post("/admin/roles?tab=user", data={"csrf_token": "tok", "action": "save", "roles_shown": str(RID),
                                            "u_%d" % RID: ["pm", "idp", "tm_rate"]})
    if _lms_t is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = _lms_t
    # ...and the My Appraisal row (Grade H, 2026-10-28) is not shown while ONEHR_GRADEH is off, so it keeps its tick
    s.check("ticking it: Performance on, AI+ Learning off", ctx(lambda d: a._urole_map(d)["mods"].get(RID))
            == {"pm", "idp", "tm_rate", "gradeh"})
    s.check("...in the audit log", "+ Performance" in ctx(lambda d: (d.execute(
        "SELECT detail FROM activity_log WHERE action='user_role_access' ORDER BY id DESC LIMIT 1").fetchone() or [""])[0]))
    s.check("a BG admin can't give a role by hand (403)", BAC.post("/admin/users/%d/user-role" % BASIC, data={
        "csrf_token": "tok", "user_role_id": str(RID)}).status_code == 403)
    SUP.post("/admin/users/%d/user-role" % BASIC, data={"csrf_token": "tok", "user_role_id": str(RID)})
    s.check("the super admin can: they hold it, take part in PM, and why says so",
            row(BASIC)["user_role_id"] == RID and sql_has(BASIC, a.participant_sql(module="pm"))
            and ctx(lambda d: a.participation(d, row(BASIC))) == (True, "role"))
    s.check("...not in competency (the role doesn't open it)", not sql_has(BASIC, a.participant_sql(module="competency")))
    s.check("...and confirming them doesn't move them: a role by hand holds",
            ctx(lambda d: a.urole_of(dict(row(BASIC), confirmation_date="2001-01-01"), d)) == (RID, "hand"))
    r = SUP.post("/admin/roles?tab=user", data={"csrf_token": "tok", "action": "retire", "role_id": str(RID)})
    s.check("a role someone holds can't be retired", ctx(lambda d: d.execute(
        "SELECT retired_at FROM user_roles WHERE id=?", (RID,)).fetchone()[0]) is None)
    SUP.post("/admin/users/%d/user-role" % BASIC, data={"csrf_token": "tok", "user_role_id": ""})
    s.check("Automatic puts them back: Basic again", row(BASIC)["user_role_id"] is None
            and mods(BASIC) == a.UROLE_DEFAULTS["basic"])
    SUP.post("/admin/roles?tab=user", data={"csrf_token": "tok", "action": "retire", "role_id": str(RID)})
    s.check("...then it can be retired", ctx(lambda d: d.execute("SELECT retired_at FROM user_roles WHERE id=?",
                                                                  (RID,)).fetchone()[0]) is not None)

    s.section("AI+ Learning stays dark where it's off (production, Chris 2026-10-20: not rolled out yet)")
    _lms0 = os.environ.get("ONEHR_LMS")
    try:
        os.environ.pop("ONEHR_LMS", None)
        pu = SUP.get("/admin/roles?tab=user").get_data(as_text=True)
        pa = SUP.get("/admin/roles").get_data(as_text=True)
        s.check("off: User roles has no AI+ Learning row, and no card says it opens it",
                'data-umod="lms"' not in pu and "AI+ Learning" not in pu, 'data-umod="lms"' in pu)
        s.check("off: Admin roles has no L&D admin card", "L&amp;D admin" not in pa)
        keep = sorted(a.UROLE_DEFAULTS["basic"] - {"lms"})
        SUP.post("/admin/roles?tab=user", data={"csrf_token": "tok", "action": "save", "roles_shown": str(BASIC_ID),
                                                "u_%d" % BASIC_ID: keep})
        s.check("off: saving the matrix keeps the hidden row's tick (Basic still opens AI+ Learning)",
                ctx(lambda d: a._urole_map(d)["mods"][BASIC_ID]) == a.UROLE_DEFAULTS["basic"])
        s.check("off: a Basic person's Learning page is still a 404 (the dark gate wins)",
                H.client_as(a, BASIC).get("/learning").status_code == 404)
        os.environ["ONEHR_LMS"] = "1"
        pu = SUP.get("/admin/roles?tab=user").get_data(as_text=True)
        s.check("on: the row and the L&D admin card are there", 'data-umod="lms"' in pu
                and "L&amp;D admin" in SUP.get("/admin/roles").get_data(as_text=True))
    finally:
        if _lms0 is None:
            os.environ.pop("ONEHR_LMS", None)
        else:
            os.environ["ONEHR_LMS"] = _lms0

    s.section("the years-of-service switch")
    pg = SUP.get("/admin/roles?tab=user").get_data(as_text=True)
    s.check("while it's on, the page says how many are Full on service alone (the list is on Reports, 4 Nov 2026)",
            "Years of service still count" in pg and "/admin/roles/service-list.xlsx" not in pg)   # its Excel moved to Reports (4 Nov 2026)
    r = SUP.get("/admin/roles/service-list.xlsx")
    s.check("the list is an Excel file, the super admin's only", r.status_code == 200 and r.data[:2] == b"PK"
            and BAC.get("/admin/roles/service-list.xlsx").status_code == 403)
    SUP.post("/admin/roles?tab=user", data={"csrf_token": "tok", "action": "service", "value": "0"})
    s.check("switched off: over a year's service with no date is Basic now", mods(SVC) == a.UROLE_DEFAULTS["basic"]
            and not sql_has(SVC, a.participant_sql()))
    s.check("...in the audit log, with how many it moved", "no longer count" in ctx(lambda d: (d.execute(
        "SELECT detail FROM activity_log WHERE action='user_role_service' ORDER BY id DESC LIMIT 1").fetchone() or [""])[0]))
    s.check("...and the page no longer asks", "Years of service still count" not in SUP.get(
        "/admin/roles?tab=user").get_data(as_text=True))

    s.section("confirming someone is the super admin's")
    r = BAC.post("/admin/users", data={"csrf_token": "tok", "action": "set_confirmed", "user_id": str(LATE),
                                       "confirmation_date": TODAY})
    s.check("a BG admin is refused (403)", r.status_code == 403 and row(LATE)["confirmation_date"] == "2099-01-01")
    # while a cycle is active the date also carries the answer to "add them to it or not" (the confirmation cut-off, 2 Nov 2026)
    SUP.post("/admin/users", data={"csrf_token": "tok", "action": "set_confirmed", "user_id": str(LATE),
                                   "confirmation_date": TODAY, "cycle_choice": "add"})
    s.check("the super admin confirms them today: Full at once, and taking part", row(LATE)["confirmation_date"] == TODAY
            and mods(LATE) == a.UROLE_DEFAULTS["full"] and sql_has(LATE, a.participant_sql()))
    s.check("a BG admin's Add a person has no confirmation date or user role",
            'name="confirmation_date"' not in BAC.get("/admin/users?view=add").get_data(as_text=True)
            and 'name="user_role_id"' not in BAC.get("/admin/users?view=add").get_data(as_text=True))
    s.check("...the super admin's has both", 'name="confirmation_date"' in SUP.get("/admin/users?view=add").get_data(
        as_text=True) and 'name="user_role_id"' in SUP.get("/admin/users?view=add").get_data(as_text=True))
    pp = SUP.get("/admin/users/%d" % BASIC).get_data(as_text=True)
    s.check("the person page names their user role, and the super admin can change it",
            "User role" in pp and "Basic" in pp and 'data-panel-open="urole"' in pp and "pnl-urole" in pp)
    s.check("...a BG admin's person page has no Change for it, and no Mark confirmed",
            'data-panel-open="urole"' not in BAC.get("/admin/users/%d" % BASIC).get_data(as_text=True)
            and "Mark confirmed" not in BAC.get("/admin/users/%d" % BASIC).get_data(as_text=True)
            if BGA["admin_bg"] == BG else True)

    s.section("confirmed during the running cycle: on New joiners, to set up")
    if OPENED and OPENED < TODAY:
        js = ctx(lambda d: {j["p"]["id"]: j for j in a._joiners(d, row(SU["id"]))})
        s.check("the person confirmed today is listed, marked confirmed during the cycle",
                MID in js and js[MID]["newly_confirmed"] == TODAY, sorted(js)[:5])
        s.check("...someone confirmed long before is not", FULL not in js)
    else:
        s.check("(the cycle opened today or later: nothing to list yet)", True)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        if SVC0 is None:
            db.execute("DELETE FROM app_settings WHERE key=?", (a.UROLE_SERVICE_KEY,))
        else:
            db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (a.UROLE_SERVICE_KEY, SVC0))
        for cid, mk_, act in _mods:
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (act, cid, mk_))
        db.commit()

sys.exit(s.done())
