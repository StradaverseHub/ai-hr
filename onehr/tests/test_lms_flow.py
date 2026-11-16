"""AI+ Learning, phase 2 (Chris, 2026-10-20: "go ahead and build phase 2 on staging"; plan OneHR/AI+ LMS/AI+ LMS plan
2026-10-20.md, canvas [design canvas link removed]).

What this suite holds:
  * dark unless ONEHR_LMS=1: the space, the clock-in and every L&D admin page are 404s
  * a registration: the chain resolved for the person (a missing line manager skipped and said so), the line manager
    approves or returns (a remark needed), only the approver named at the step, then, past the step's working-day
    clock, whom it escalates to; the waiting list when the session is full, and the next one up when a place frees
    (withdrawn, returned, cancelled); the 30-day cut-off, the audience, no second request
  * an external request: line manager > People Partner > the L&D admin above the cost the chain sets; the People
    Partner step is an L&D admin's (Chris, 2026-10-20: "L&D admins only"): the person's own BG admin reads it, can't act
  * the chain is the L&D admin's to set; a request keeps the chain it started with
  * the L&D admin: group-wide, Learning only (every other admin page goes to Learning, a write elsewhere is refused);
    the super admin adds and closes them
  * the QR: a 6-digit code per 30-second window (now or one window ago, never older), clock-in by QR or typed code,
    a walk-in flagged, a scan before signing in held in a signed cookie and resumed after it
  * the day: a manual mark needs a reason, the T3's ticks against the clock-ins (who signed but didn't clock in, who
    clocked in but didn't sign, walk-ins), the scan's type checked, the printed T3 pre-filled
  * closing: attended / part of it / absent from the clock-ins, hours for the days they came; then the day-0 rating,
    once, by someone who came
  * nominations: a line manager's own step approved by nominating; an HOD's in an open round, their own people only
  * the pages render, and every POST form on them is double-confirmed
Everything here is synthetic (ZZLF / ZZ9LF-) and removed at the end.
"""
import html
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning, phase 2: register, approve, clock in, close")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG, CO = "ZZLF Group", "ZZLF U1"
_ENV0 = os.environ.get("ONEHR_LMS")


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LF-%' OR username LIKE 'zzlf-%'")]
    db.execute("DELETE FROM lms_rounds WHERE title LIKE 'ZZLF %'")
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLF %'")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM lms_registrations WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM lms_attendance WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_idp_goals WHERE idp_id IN (SELECT id FROM pm_idp WHERE subject_id IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_idp WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE detail LIKE '%ZZLF%'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, grade, mgr=None, hod=None, bg=BG):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, hod_id) VALUES (?,?, 'x', 'user', ?,?,?,?,?,?,?,?)",
                      (eid.lower(), "ZZ LF " + eid.split("-")[1], eid, bg, CO, "ZZLF Sales", "ZZLF Officer", str(grade), mgr,
                       hod)).lastrowid


TODAY = None
with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    _CHAINS0 = db.execute("SELECT value FROM app_settings WHERE key='lms_chains'").fetchone()
    db.execute("DELETE FROM app_settings WHERE key='lms_chains'")       # the defaults, put back at the end
    TODAY = a._today_myt()
    T = TODAY.isoformat()
    D = lambda n: (TODAY + timedelta(days=n)).isoformat()   # noqa: E731
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    HOD = person(db, "ZZ9LF-HOD", 20)
    MGR = person(db, "ZZ9LF-MGR", 17, hod=HOD)
    E1, E2, E3, E4 = (person(db, "ZZ9LF-E%d" % i, 15, MGR, HOD) for i in range(1, 5))
    EN = person(db, "ZZ9LF-ENM", 15, None, HOD)            # no line manager on record
    EO = person(db, "ZZ9LF-EOT", 15, None, None)           # nobody's: not MGR's, not HOD's
    PP = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                    "('zzlf-pp', 'ZZ LF People Partner', 'x', 'admin', ?)", (BG,)).lastrowid
    LND = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzlf-lnd', 'ZZ LF L&D', 'x', 'admin', ?)", (a.LMS_ADMIN_BG,)).lastrowid

    def prog(title, kind="inhouse", cost=0, hours=14, days=2, aud=None):
        return db.execute("INSERT INTO lms_programmes(title, kind, status, cost_per_pax, hours, days, audience_json, "
                          "hrdc_claimable) VALUES (?,?, 'published', ?,?,?,?, 1)",
                          (title, kind, cost, hours, days, json.dumps(aud) if aud else None)).lastrowid

    def sess(pid, a_, b_, seats=None, cut=None, st="09:00", en="17:00"):
        return db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, start_time, end_time, "
                          "venue, seats, reg_cutoff) VALUES (?, 'Run 1', ?,?,?,?, 'ZZLF Room', ?,?)",
                          (pid, a_, b_, st, en, seats, cut)).lastrowid
    P1 = prog("ZZLF Negotiation")
    S1 = sess(P1, D(40), D(41), seats=2, cut=D(10))          # two places
    S2 = sess(prog("ZZLF Negotiation B"), D(60), D(61), cut=D(30))   # plenty of room (one run a programme, 2026-10-23)
    S_CUT = sess(P1, D(20), D(20), cut=D(-1))                # registration closed yesterday
    PS = prog("ZZLF Senior Only", aud={"grade_min": 18})
    S_SEN = sess(PS, D(50), D(50), cut=D(20))
    P3 = prog("ZZLF Clock-in Day", hours=7, days=1)
    S3 = sess(P3, T, T, st="00:00", en="23:59")              # today, open all day
    P4 = prog("ZZLF Two Days", hours=14, days=2)
    S4 = sess(P4, D(-1), T, st="00:00", en="23:59")          # yesterday and today
    db.commit()


def post(c, url, data, **kw):
    d = {"csrf_token": "tok"}
    d.update(data)
    return c.post(url, data=d, **kw)


def one(sql, args=()):
    return H.one(a, sql, args)


def reg_of(uid, sid=None, ext=False):
    with a.app.app_context():
        db = a.get_db()
        r = db.execute("SELECT id FROM lms_registrations WHERE user_id=? AND %s ORDER BY id DESC LIMIT 1" % (
            "session_id IS NULL" if ext else "session_id=?"), (uid,) if ext else (uid, sid)).fetchone()
        return a._lms_reg(db, r[0]) if r else None


def confirmed_forms(html):
    forms = re.findall(r"<form\b[^>]*>", html)
    # the account menu's Log out is a POST form (security test 2-14), not an action that asks first
    posts = [f for f in forms if re.search(r'method="post"', f, re.I) and 'action="/logout"' not in f]
    return posts, [f for f in posts if "data-confirm" not in f and "data-prompt" not in f]


C_SU, C_LND, C_PP = (H.client_as(a, x) for x in (SU["id"], LND, PP))
C1, C2, C3, C4, CN, CM, CH, CO_ = (H.client_as(a, x) for x in (E1, E2, E3, E4, EN, MGR, HOD, EO))
C_BG = H.client_as(a, BGA["id"]) if BGA and BGA["admin_bg"] != BG else None
try:
    s.section("dark unless ONEHR_LMS=1")
    os.environ.pop("ONEHR_LMS", None)
    s.check("the space is a 404", C1.get("/learning").status_code == 404)
    s.check("...registering too", post(C1, "/learning/register", {"session": S2}).status_code == 404)
    s.check("...and the clock-in", C1.get("/learning/in/%d" % S3).status_code == 404)
    s.check("an L&D admin gets 404 from Learning and from the rest of the admin area",
            C_LND.get("/admin/learning/sessions").status_code == 404 and C_LND.get("/admin").status_code == 404)
    s.check("nothing was written", one("SELECT COUNT(*) FROM lms_registrations WHERE user_id=?", (E1,)) == 0)
    # the access page is Roles & access since 2026-10-20 (the L&D admin's fixed card)
    s.check("...and the access page says nothing of Learning", "<b>Learning:</b>" not in
            C_SU.get("/admin/roles").get_data(as_text=True))
    os.environ["ONEHR_LMS"] = "1"
    s.check("on: the access page says who runs Learning and what a BG admin may do there (the standing rule, 2026-10-20)",
            "<b>Learning:</b> run by the super admin and the L&amp;D admins" in
            C_SU.get("/admin/roles").get_data(as_text=True))

    s.section("the registry")
    s.check("the staff routes are never cycle-gated", {"learning_home", "learning_register", "learning_request",
            "learning_mine_act", "learning_decide", "learning_nominate", "learning_checkin", "learning_rate",
            "learning_ics"} <= a.MODULE_UNGATED_ENDPOINTS)
    s.check("the admin writes are Learning's own ('lms'): the super admin's or an L&D admin's, approving included",
            a.ADMIN_ACCESS_MAP.get("admin_learning_session") == "lms"
            and a.ADMIN_ACCESS_MAP.get("admin_learning_settings") == "lms"
            and a.ADMIN_ACCESS_MAP.get("admin_learning_requests") == "lms")
    import inspect
    s.check("the clock-in is open to someone still on their first sign-in",
            "learning_checkin" in inspect.getsource(a._onboarding_gate))

    s.section("registering: the chain, the line manager, returning")
    r = post(C1, "/learning/register", {"session": S1, "why": "ZZLF for my quotes"})
    g1 = reg_of(E1, S1)
    s.check("a request is made, waiting on the line manager", r.status_code == 302 and g1 and g1["status"] == "pending"
            and g1["level"] == 0 and g1["chain"][0]["role"] == "lm" and g1["chain"][0]["approver"] == MGR, g1 and g1["chain"])
    s.check("...its clock started today, due 3 working days on",
            g1["level_since"][:10] == T and a._lms_level_due(g1) == a._lms_workdays(TODAY, 3))
    s.check("working days skip the weekend (Fri + 3 = Wed)", a._lms_workdays(date(2026, 10, 23), 3) == date(2026, 10, 28))
    s.check("a second request for the same session is refused",
            post(C1, "/learning/register", {"session": S1}).status_code == 302
            and one("SELECT COUNT(*) FROM lms_registrations WHERE user_id=? AND session_id=?", (E1, S1)) == 1)
    post(C2, "/learning/decide/%d" % g1["id"], {"action": "approve"})
    s.check("a colleague can't approve it", reg_of(E1, S1)["status"] == "pending")
    post(CH, "/learning/decide/%d" % g1["id"], {"action": "approve"})
    s.check("...nor the HOD while it's in its clock", reg_of(E1, S1)["status"] == "pending")
    home_m = CM.get("/learning?view=team").get_data(as_text=True)
    s.check("the line manager sees it waiting in Team", "ZZ LF E1" in home_m and "Waiting on you" in home_m)
    post(CM, "/learning/decide/%d" % g1["id"], {"action": "approve"})
    g1 = reg_of(E1, S1)
    s.check("the line manager approves: confirmed (in-house is one step)", g1["status"] == "approved"
            and g1["chain"][0]["state"] == "approved" and g1["chain"][0]["by"] == MGR, g1["status"])
    s.check("...and the approval is logged", one("SELECT COUNT(*) FROM lms_approvals WHERE registration_id=? AND "
                                                 "action='approved' AND actor_id=?", (g1["id"], MGR)) == 1)

    post(C2, "/learning/register", {"session": S1})
    g2 = reg_of(E2, S1)
    post(CM, "/learning/decide/%d" % g2["id"], {"action": "return", "remark": ""})
    s.check("returning needs a remark", reg_of(E2, S1)["status"] == "pending", reg_of(E2, S1)["status"])
    post(CM, "/learning/decide/%d" % g2["id"], {"action": "return", "remark": "ZZLF next quarter is better"})
    g2 = reg_of(E2, S1)
    s.check("returned with the remark the person reads", g2["status"] == "returned" and g2["remark"] ==
            "ZZLF next quarter is better" and "next quarter is better" in C2.get("/learning").get_data(as_text=True))
    post(C2, "/learning/mine/%d" % g2["id"], {"action": "resend"})
    g2 = reg_of(E2, S1)
    s.check("sent again, it starts its chain again", g2["status"] == "pending" and g2["level"] == 0
            and g2["chain"][0]["state"] == "waiting" and not g2["remark"], g2["status"])
    post(CM, "/learning/decide/%d" % g2["id"], {"action": "approve"})
    s.check("...and is approved: both places taken", reg_of(E2, S1)["status"] == "approved"
            and one("SELECT COUNT(*) FROM lms_registrations WHERE session_id=? AND status='approved'", (S1,)) == 2)

    s.section("the waiting list")
    post(C3, "/learning/register", {"session": S1})
    g3 = reg_of(E3, S1)
    s.check("a full session puts the next request on the waiting list", g3["status"] == "waitlisted", g3["status"])
    s.check("...where the space shows its place", "place 1" in C3.get("/learning").get_data(as_text=True))
    post(C1, "/learning/mine/%d" % g1["id"], {"action": "withdraw"})
    s.check("a withdrawal needs a reason (2026-10-22)", reg_of(E1, S1)["status"] != "withdrawn")
    post(C1, "/learning/mine/%d" % g1["id"], {"action": "withdraw", "why_kind": "clash",
                                              "why": "ZZLF year-end stock count those days"})
    s.check("a withdrawal frees the place", reg_of(E1, S1)["status"] == "withdrawn")
    g3 = reg_of(E3, S1)
    s.check("...and the first on the list moves up, its chain starting", g3["status"] == "pending"
            and g3["chain"][0]["approver"] == MGR, g3["status"])
    post(C4, "/learning/register", {"session": S1})
    s.check("the place is held while it's waiting for approval (the next one waits)",
            reg_of(E4, S1)["status"] == "waitlisted")
    post(CM, "/learning/decide/%d" % g3["id"], {"action": "return", "remark": "ZZLF not this one"})
    s.check("a return frees it too: the next one moves up", reg_of(E4, S1)["status"] == "pending")

    s.section("cut-off, audience, a missing line manager")
    post(C1, "/learning/register", {"session": S_CUT})
    s.check("registration is refused after its cut-off", reg_of(E1, S_CUT) is None)
    s.check("...and the page says when it closed",
            "Registration closed" in C1.get("/learning/register?session=%d" % S_CUT).get_data(as_text=True))
    post(C1, "/learning/register", {"session": S_SEN})
    s.check("a programme outside their audience is refused", reg_of(E1, S_SEN) is None)
    post(CN, "/learning/register", {"session": S2})
    gn = reg_of(EN, S2)
    s.check("no line manager on record: their HOD decides it, and the step says so (Chris, 2026-10-23)",
            gn and gn["status"] == "pending" and gn["chain"][0]["role"] == "hod"
            and "no line manager on record: their HOD decides" in gn["chain"][0]["note"], gn and gn["chain"])

    s.section("escalation, past the clock")
    post(C2, "/learning/register", {"session": S2})
    g2b = reg_of(E2, S2)
    with a.app.app_context():
        db = a.get_db()
        s.check("the HOD can't act while it's in its clock", a.lms_actor_role(db, db.execute(
            "SELECT * FROM users WHERE id=?", (HOD,)).fetchone(), g2b) is None)
        db.execute("UPDATE lms_registrations SET level_since=? WHERE id=?", (D(-10), g2b["id"]))
        db.commit()
    dept = CH.get("/learning?view=dept").get_data(as_text=True)
    s.check("past it, the HOD sees it in Dept, marked as passed to them", "ZZ LF E2" in dept and "Passed to you" in dept)
    post(CH, "/learning/decide/%d" % g2b["id"], {"action": "approve", "view": "dept"})
    g2b = reg_of(E2, S2)
    s.check("...and approves it, the step noting the escalation", g2b["status"] == "approved"
            and g2b["chain"][0]["by"] == HOD and "escalated" in g2b["chain"][0]["note"], g2b["chain"])

    s.section("an external course: line manager > People Partner > L&D above the cost")
    base = {"ext_title": "ZZLF Credit Risk", "ext_provider": "ZZLF Institute", "ext_starts_on": D(30),
            "ext_ends_on": D(31), "ext_hours": "14", "why": "ZZLF for the credit desk"}
    post(C1, "/learning/request", dict(base, cost=""))
    s.check("a cost is required", reg_of(E1, ext=True) is None)
    post(C1, "/learning/request", dict(base, cost="2000", hrdc_claimable="1"))
    gx = reg_of(E1, ext=True)
    s.check("over RM 1,500: three steps, line manager first", gx and [x["role"] for x in gx["chain"]] ==
            ["lm", "pp", "lnd"] and gx["status"] == "pending" and gx["level"] == 0, gx and gx["chain"])
    post(CM, "/learning/decide/%d" % gx["id"], {"action": "approve"})
    s.check("the line manager approves: it moves to the People Partner", reg_of(E1, ext=True)["level"] == 1)
    if C_BG:
        post(C_BG, "/admin/learning/requests", {"action": "approve", "registration_id": gx["id"]})
        s.check("another group's admin can't act on it", reg_of(E1, ext=True)["level"] == 1)
    pg = C_PP.get("/admin/learning/requests").get_data(as_text=True)
    s.check("the person's own BG admin reads it moving, with nothing waiting on them", "ZZLF Credit Risk" in pg
            and "Waiting on you · 0" in pg)
    r = post(C_PP, "/admin/learning/requests", {"action": "approve", "registration_id": gx["id"]})
    s.check("...and can't take the People Partner step: it's an L&D admin's (Chris, 2026-10-20)",
            r.status_code == 403 and reg_of(E1, ext=True)["level"] == 1, r.status_code)
    with a.app.app_context():
        db = a.get_db()
        s.check("...nor could they through the step logic itself", a.lms_actor_role(db, db.execute(
            "SELECT * FROM users WHERE id=?", (PP,)).fetchone(), reg_of(E1, ext=True)) is None)
    pg = C_LND.get("/admin/learning/requests").get_data(as_text=True)
    s.check("the L&D admin sees it waiting on them", "ZZLF Credit Risk" in pg and "Waiting on you · 1" in pg)
    post(C_LND, "/admin/learning/requests", {"action": "approve", "registration_id": gx["id"]})
    s.check("...approves the People Partner step: it moves to the L&D step", reg_of(E1, ext=True)["level"] == 2)
    post(C_LND, "/admin/learning/requests", {"action": "approve", "registration_id": gx["id"]})
    s.check("the L&D admin approves: confirmed", reg_of(E1, ext=True)["status"] == "approved")
    post(C2, "/learning/request", dict(base, cost="800"))
    s.check("under the cost, L&D's step isn't in the chain",
            [x["role"] for x in reg_of(E2, ext=True)["chain"]] == ["lm", "pp"])

    s.section("the chain is the L&D admin's to set")
    r = post(C_LND, "/admin/learning/settings", {"action": "chain", "kind": "inhouse", "role_0": "lm", "days_0": "2",
                                                  "esc_0": "hod", "role_1": "hod", "days_1": "3", "esc_1": "",
                                                  "hod_counts": "1"})
    with a.app.app_context():
        ch = a.lms_chains(a.get_db())["inhouse"]
    s.check("saved: line manager then HOD", r.status_code == 302 and [x["role"] for x in ch["levels"]] == ["lm", "hod"]
            and ch["levels"][0]["days"] == 2, ch)
    s.check("...in the audit log", one("SELECT COUNT(*) FROM activity_log WHERE action='lms_chain' AND user_id=?",
                                       (LND,)) >= 1)
    s.check("a request already sent keeps the chain it started with", len(reg_of(E2, S2)["chain"]) == 1)
    post(C3, "/learning/register", {"session": S2})
    s.check("a new one follows the new chain", [x["role"] for x in reg_of(E3, S2)["chain"]] == ["lm", "hod"])
    if C_BG:
        post(C_BG, "/admin/learning/settings", {"action": "chain", "kind": "inhouse", "role_0": "hod"})
        with a.app.app_context():
            s.check("a BG admin can't change it", [x["role"] for x in a.lms_chains(a.get_db())["inhouse"]["levels"]]
                    == ["lm", "hod"])
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM app_settings WHERE key='lms_chains'")
        db.commit()

    s.section("nominations")
    r = post(CM, "/learning/nominate", {"session_id": S2, "user_id": E4})
    g4 = reg_of(E4, S2)
    s.check("a line manager's nomination approves their own step (in-house: confirmed)",
            g4 and g4["status"] == "approved" and g4["nomination"] == "manager" and g4["nominated_by"] == MGR)
    post(CM, "/learning/nominate", {"session_id": S2, "user_id": EO})
    s.check("...never someone they don't manage", reg_of(EO, S2) is None)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE lms_registrations SET status='withdrawn' WHERE user_id IN (?,?,?,?) AND session_id=?",
                   (E1, E2, E3, E4, S2))
        db.commit()
    r = post(C_LND, "/admin/learning/rounds", {"action": "create", "title": "ZZLF Q1 round", "closes_on": D(7),
                                               "session_ids": [str(S2)]})
    rid = one("SELECT id FROM lms_rounds WHERE title='ZZLF Q1 round'")
    s.check("the L&D admin opens a round", r.status_code == 302 and rid)
    dept = CH.get("/learning?view=dept").get_data(as_text=True)
    s.check("the HOD sees it with their people to tick", "ZZLF Q1 round" in dept and 'value="%d:%d"' % (S2, E1) in dept)
    post(CH, "/learning/nominate", {"round_id": rid, "pick": ["%d:%d" % (S2, E1), "%d:%d" % (S2, EO)]})
    g = reg_of(E1, S2)
    s.check("the HOD nominates their own: in-house, confirmed, marked as the HOD's", g and g["nomination"] == "hod"
            and g["status"] == "approved" and g["round_id"] == rid and g["chain"][0]["state"] == "approved")
    s.check("...never someone outside their department", reg_of(EO, S2) is None)
    rp = C_LND.get("/admin/learning/rounds").get_data(as_text=True)
    s.check("the rounds page counts the HODs who nominated", "ZZLF Q1 round" in rp and "1 of 1" in rp)
    post(C_LND, "/admin/learning/rounds", {"action": "close", "round_id": rid})
    post(CH, "/learning/nominate", {"round_id": rid, "pick": ["%d:%d" % (S2, E2)]})
    s.check("a closed round takes no more", reg_of(E2, S2)["status"] == "withdrawn")

    s.section("the L&D admin: Learning only")
    r = C_LND.get("/admin")
    s.check("an L&D admin's other admin pages go to Learning", r.status_code == 302 and "/admin/learning" in
            r.headers.get("Location", ""), r.status_code)
    s.check("...People too", C_LND.get("/admin/people").status_code == 302)
    s.check("...and a write elsewhere is refused", post(C_LND, "/admin/admins", {"action": "add"}).status_code == 403)
    s.check("Learning's pages open", all(C_LND.get(u_).status_code == 200 for u_ in (
        "/admin/learning/needs", "/admin/learning/programmes", "/admin/learning/sessions", "/admin/learning/requests",
        "/admin/learning/rounds", "/admin/learning/settings")))
    pg = C_LND.get("/admin/learning/rounds").get_data(as_text=True)
    s.check("...as someone who changes them: not view only, no access grid (the page's script would strip the buttons)",
            "data-adm-viewonly" not in pg and "data-adm-access" not in pg and "View only." not in pg)
    s.check("...and the menu holds Learning only", ">Learning<" in pg and "Leaders and admins" not in pg
            and "/admin/people" not in pg)
    j = C_LND.get("/admin/people/find.json?q=ZZ%20LF").get_json() or {}
    s.check("the people search finds anyone in the group (they pick who to add or mark in)",
            any(x.get("eid") == "ZZ9LF-E1" for x in j.get("people") or []), str(j)[:200])
    s.check("an L&D admin isn't a super admin and sees nobody's records", not a.is_super(
        H.rows(a, "SELECT * FROM users WHERE id=?", (LND,))[0]))
    post(C_LND, "/admin/learning/settings", {"action": "lnd_add", "username": "zzlf-lnd2", "password": "zzlf-pass-1",
                                             "full_name": "ZZLF Two"})
    s.check("only the super admin adds an L&D admin", one("SELECT COUNT(*) FROM users WHERE username='zzlf-lnd2'") == 0)
    post(C_SU, "/admin/learning/settings", {"action": "lnd_add", "username": "zzlf-lnd2", "password": "zzlf-pass-1",
                                            "full_name": "ZZLF Two"})
    s.check("...and they're an L&D admin", one("SELECT admin_bg FROM users WHERE username='zzlf-lnd2'") == a.LMS_ADMIN_BG)
    nid = one("SELECT id FROM users WHERE username='zzlf-lnd2'")
    post(C_SU, "/admin/learning/settings", {"action": "lnd_close", "user_id": nid})
    s.check("...closed by the super admin, never deleted", one("SELECT left_at IS NOT NULL FROM users WHERE id=?", (nid,)) == 1)

    s.section("the QR code")
    with a.app.app_context():
        db = a.get_db()
        sec = a._lms_qr_secret(db, S3)
        code, left = a.lms_code_now(db, S3)
        w = int(time.time()) // a.LMS_QR_SECONDS
        s.check("a 6-digit code, 1-30 seconds left", re.fullmatch(r"\d{6}", code) and 1 <= left <= 30, (code, left))
        s.check("the code now is good", a.lms_code_ok(db, S3, code))
        s.check("...and one window ago (the time to scan and send)", a.lms_code_ok(db, S3, a._lms_code(sec, S3, w - 1)))
        s.check("never two windows ago", not a.lms_code_ok(db, S3, a._lms_code(sec, S3, w - 2)))
        s.check("another session's code isn't this one's", a._lms_code(sec, S3, w) != a._lms_code(sec, S2, w))
        m = a._qr_matrix("https://staging.example.com/learning/in/%d?c=%s" % (S3, code))
        n = len(m)
        finder = all(m[y][x] == (max(abs(x - 3), abs(y - 3)) in (0, 1, 3)) for y in range(7) for x in range(7))
        s.check("the QR is a square of a known version with its finder pattern", n in (21, 25, 29, 33, 37, 41)
                and all(len(r_) == n for r_ in m) and finder, n)
    qj = C_LND.get("/admin/learning/sessions/%d/qr.json" % S3).get_json() or {}
    s.check("the screen's refresh gives the SVG, the code, and today open", qj.get("svg", "").startswith("<svg")
            and re.fullmatch(r"\d{6}", qj.get("code", "")) and qj.get("open") is True and qj.get("day") == T, str(qj)[:120])
    if C_BG:
        s.check("a BG admin can't open the room's screen", C_BG.get("/admin/learning/sessions/%d/qr.json" % S3)
                .status_code == 403)

    s.section("clocking in")
    post(C_LND, "/admin/learning/sessions/%d" % S3, {"action": "add", "employee_id": "ZZ9LF-E1", "reason": ""})
    s.check("L&D adding someone needs a reason", reg_of(E1, S3) is None)
    for e_ in ("ZZ9LF-E1", "ZZ9LF-E3", "ZZ9LF-E4"):
        post(C_LND, "/admin/learning/sessions/%d" % S3, {"action": "add", "employee_id": e_,
                                                         "reason": "ZZLF late, the HOD agreed"})
    s.check("...with one, confirmed even after the session started", reg_of(E1, S3)["status"] == "approved"
            and reg_of(E1, S3)["nomination"] == "hr")
    with a.app.app_context():
        code, _l = a.lms_code_now(a.get_db(), S3)
    r = C1.get("/learning/in/%d?c=%s" % (S3, code))
    s.check("scanning the QR clocks them in", r.status_code == 200 and "You&#39;re in" in r.get_data(as_text=True)
            and one("SELECT method FROM lms_attendance WHERE session_id=? AND user_id=? AND on_date=?", (S3, E1, T)) == "qr")
    r = C1.get("/learning/in/%d?c=%s" % (S3, code))
    s.check("again: already in, one row", "already clocked in" in r.get_data(as_text=True) and
            one("SELECT COUNT(*) FROM lms_attendance WHERE session_id=? AND user_id=?", (S3, E1)) == 1)
    r = post(C2, "/learning/in/%d" % S3, {"c": "000000" if code != "000000" else "111111"})
    s.check("a wrong code says so and writes nothing", "That code has changed" in r.get_data(as_text=True)
            and one("SELECT COUNT(*) FROM lms_attendance WHERE session_id=? AND user_id=?", (S3, E2)) == 0)
    r = post(C2, "/learning/in/%d" % S3, {"c": code})
    s.check("typing the code works, and someone not on the list is a walk-in", "walk-in" in r.get_data(as_text=True)
            and one("SELECT method FROM lms_attendance WHERE session_id=? AND user_id=?", (S3, E2)) == "code")
    with a.app.app_context():
        code1, _l = a.lms_code_now(a.get_db(), S1)
    s.check("on a day the session doesn't run, nobody clocks in", "isn&#39;t open" in
            C3.get("/learning/in/%d?c=%s" % (S1, code1)).get_data(as_text=True)
            and one("SELECT COUNT(*) FROM lms_attendance WHERE session_id=?", (S1,)) == 0)
    with a.app.app_context():
        code, _l = a.lms_code_now(a.get_db(), S3)
    anon = a.app.test_client()
    r = anon.get("/learning/in/%d?c=%s" % (S3, code))
    ck = [c_ for c_ in r.headers.getlist("Set-Cookie") if c_.startswith(a._LMS_CI_COOKIE + "=")]
    s.check("scanned before signing in: on to sign-in, the scan held in a signed cookie", r.status_code == 302 and
            "/login" in r.headers.get("Location", "") and ck and "HttpOnly" in ck[0], r.status_code)
    raw = ck[0].split(";")[0].split("=", 1)[1] if ck else ""
    r = anon.get("/learning/in/%d?c=123" % S3)
    s.check("...a bad code sets nothing", not [c_ for c_ in r.headers.getlist("Set-Cookie") if c_.startswith("lms_ci=")])
    C4.set_cookie(a._LMS_CI_COOKIE, raw) if "server_name" not in C4.set_cookie.__code__.co_varnames else \
        C4.set_cookie("localhost", a._LMS_CI_COOKIE, raw)
    r = C4.get("/")
    s.check("signed in, they land back on the clock-in", r.status_code == 302 and
            "/learning/in/%d" % S3 in r.headers.get("Location", "") and "pre=1" in r.headers.get("Location", ""),
            r.headers.get("Location"))
    r = C4.get("/learning/in/%d?pre=1" % S3)
    s.check("...which clocks them in and spends the cookie", "You&#39;re in" in r.get_data(as_text=True)
            and one("SELECT COUNT(*) FROM lms_attendance WHERE session_id=? AND user_id=?", (S3, E4)) == 1
            and any(c_.startswith("lms_ci=;") or "lms_ci=\"\"" in c_ or ("lms_ci=" in c_ and "Expires=Thu, 01 Jan 1970" in c_)
                    for c_ in r.headers.getlist("Set-Cookie")))
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM lms_attendance WHERE session_id=? AND user_id=?", (S3, E4))
        db.commit()
    C3.set_cookie(a._LMS_CI_COOKIE, str(S3)) if "server_name" not in C3.set_cookie.__code__.co_varnames else \
        C3.set_cookie("localhost", a._LMS_CI_COOKIE, str(S3))
    C3.get("/learning/in/%d?pre=1" % S3)
    s.check("a forged cookie clocks nobody in", one("SELECT COUNT(*) FROM lms_attendance WHERE session_id=? AND "
                                                     "user_id=?", (S3, E3)) == 0)

    s.section("the day: marking by hand, the T3")
    U3 = "/admin/learning/sessions/%d" % S3
    post(C_LND, U3, {"action": "mark_uid", "user_id": E4, "day": T, "reason": ""})
    s.check("marking someone in by hand needs a reason", one("SELECT COUNT(*) FROM lms_attendance WHERE session_id=? "
                                                             "AND user_id=?", (S3, E4)) == 0)
    post(C_LND, U3, {"action": "mark_uid", "user_id": E4, "day": T, "reason": "ZZLF signed the T3, phone flat"})
    s.check("...with it, marked, the reason kept and audited", one("SELECT reason FROM lms_attendance WHERE "
            "session_id=? AND user_id=?", (S3, E4)) == "ZZLF signed the T3, phone flat" and one(
            "SELECT COUNT(*) FROM activity_log WHERE action='lms_attendance' AND target_user_id=?", (E4,)) == 1)
    if C_BG:
        s.check("a BG admin can't mark anyone", post(C_BG, U3, {"action": "mark_uid", "user_id": E3, "day": T,
                                                                "reason": "x"}).status_code == 403)
    post(C_LND, U3, {"action": "signed", "day": T, "signed": [str(E1), str(E3)]})
    with a.app.app_context():
        sh = a.lms_day_sheet(a.get_db(), S3, T)
    kinds = {(m_["kind"], m_["uid"]) for m_ in sh["mismatch"]}
    s.check("the T3's ticks against the clock-ins: E3 signed, didn't clock in; E4 clocked in, didn't sign; E2 a walk-in",
            kinds == {("signed_no_clock", E3), ("clock_no_sign", E4), ("walkin", E2)}, kinds)
    s.check("...counts: 3 in (2 confirmed + a walk-in) of 3 confirmed", sh["n_in"] == 3 and sh["n_confirmed"] == 3,
            (sh["n_in"], sh["n_confirmed"]))
    page = C_LND.get(U3 + "?day=" + T).get_data(as_text=True)
    s.check("the session page shows what to check", "signed the T3 but didn" in page and "walk-in" in page)
    posts, bare = confirmed_forms(page)
    s.check("every POST form on it is double-confirmed (%d)" % len(posts), posts and not bare, bare[:2])
    import io
    r = C_LND.post(U3, data={"csrf_token": "tok", "action": "t3", "day": T,
                             "scan": (io.BytesIO(b"MZ\x90\x00"), "t3.exe")}, content_type="multipart/form-data")
    s.check("the scan must be a PDF or a photo", one("SELECT COUNT(*) FROM lms_t3 WHERE session_id=? AND stored_path "
                                                     "IS NOT NULL", (S3,)) == 0)
    r = C_LND.post(U3, data={"csrf_token": "tok", "action": "t3", "day": T,
                             "scan": (io.BytesIO(b"%PDF-1.4 zzlf"), "zzlf-t3.pdf")}, content_type="multipart/form-data")
    s.check("a PDF is kept, with who signed still there", one("SELECT filename FROM lms_t3 WHERE session_id=? AND "
            "on_date=?", (S3, T)) == "zzlf-t3.pdf" and E1 in json.loads(one(
                "SELECT signed_json FROM lms_t3 WHERE session_id=?", (S3,))))
    r = C_LND.get(U3 + "/t3/scan?day=" + T)
    s.check("...and opens for L&D", r.status_code == 200 and r.data.startswith(b"%PDF"))
    _fn = one("SELECT filename FROM lms_t3 WHERE session_id=? AND on_date=?", (S3, T))
    try:
        with a.app.app_context():
            _d = a.get_db()
            _d.execute("UPDATE lms_t3 SET filename=? WHERE session_id=? AND on_date=?", ("T3 \u2014 \u62a5\u4ef7\u5355.pdf", S3, T))
            _d.commit()
        r = C_LND.get(U3 + "/t3/scan?day=" + T)
        _cd = r.headers.get("Content-Disposition", "")
        s.check("a scan named with an em dash and Chinese: 200, inline, filename*=UTF-8'' carries it", r.status_code == 200
                and _cd.startswith("inline;") and "filename*=UTF-8''T3%20%E2%80%94%20%E6%8A%A5%E4%BB%B7%E5%8D%95.pdf" in _cd
                and _cd.encode("latin-1") is not None, _cd)
    finally:
        with a.app.app_context():
            _d = a.get_db()
            _d.execute("UPDATE lms_t3 SET filename=? WHERE session_id=? AND on_date=?", (_fn, S3, T))
            _d.commit()
    if C_BG:
        s.check("...not for a BG admin", C_BG.get(U3 + "/t3/scan?day=" + T).status_code == 403)
    t3 = C_LND.get(U3 + "/t3?day=" + T).get_data(as_text=True)
    s.check("the printed T3 lists the confirmed, with blank rows for walk-ins", "ZZ LF E1" in t3 and "ZZ LF E3" in t3
            and "ZZ LF E2" not in t3 and t3.count("<tr>") >= 3 + 5 + 1, t3.count("<tr>"))
    if C_BG:
        bgp = C_BG.get(U3 + "?day=" + T)
        s.check("another group's admin reads the session, none of its people's names",
                bgp.status_code == 200 and "ZZ LF" not in bgp.get_data(as_text=True))
        s.check("...nor prints the T3 (it lists every group's people)", C_BG.get(U3 + "/t3?day=" + T).status_code == 403)
    s.check("the people's own group's admin reads their names", "ZZ LF E1" in C_PP.get(U3 + "?day=" + T)
            .get_data(as_text=True))
    post(C_LND, U3, {"action": "walkin", "user_id": E2, "day": T})
    s.check("a walk-in L&D confirms gets a place of their own", reg_of(E2, S3)["status"] == "approved"
            and reg_of(E2, S3)["nomination"] == "walkin")

    s.section("closing, then the rating")
    post(C_LND, "/admin/learning/sessions/%d" % S2, {"action": "close"})
    s.check("a session can't be closed before its last day", one("SELECT closed_at FROM lms_sessions WHERE id=?",
                                                                 (S2,)) is None)
    # closing waits for the last day's clock-out (2026-10-23): this run is open all day, so close it just after midnight
    _now0 = a._now_myt
    a._now_myt = lambda: datetime.combine(TODAY + timedelta(days=1), datetime.min.time()) + timedelta(minutes=40)
    try:
        post(C_LND, U3, {"action": "close", "day": T})
    finally:
        a._now_myt = _now0
    out = {u_: (reg_of(u_, S3)["outcome"], reg_of(u_, S3)["hours"]) for u_ in (E1, E2, E3, E4)}
    s.check("closed: who clocked in attended with the day's hours, who didn't is absent",
            out == {E1: ("attended", 7.0), E2: ("attended", 7.0), E3: ("absent", 0.0), E4: ("attended", 7.0)}, out)
    with a.app.test_request_context("/"):
        db = a.get_db()
        for u_ in (E1, E2):
            a.lms_register(db, db.execute("SELECT * FROM users WHERE id=?", (u_,)).fetchone(), S4, nomination="hr",
                           nominator=LND, late_reason="ZZLF test")
        db.execute("INSERT INTO lms_attendance(session_id, on_date, user_id, method) VALUES (?,?,?, 'qr')",
                   (S4, D(-1), E1))
        db.execute("INSERT INTO lms_attendance(session_id, on_date, user_id, method) VALUES (?,?,?, 'qr')", (S4, T, E1))
        db.execute("INSERT INTO lms_attendance(session_id, on_date, user_id, method) VALUES (?,?,?, 'qr')", (S4, T, E2))
        db.commit()
    a._now_myt = lambda: datetime.combine(TODAY + timedelta(days=1), datetime.min.time()) + timedelta(minutes=40)
    try:   # after the last day's clock-out (2026-10-23)
        post(C_LND, "/admin/learning/sessions/%d" % S4, {"action": "close", "day": T})
    finally:
        a._now_myt = _now0
    s.check("two days: both = attended, 14 h; one = part of it, 7 h", (reg_of(E1, S4)["outcome"], reg_of(E1, S4)["hours"],
            reg_of(E2, S4)["outcome"], reg_of(E2, S4)["hours"]) == ("attended", 14.0, "partial", 7.0))
    home1 = C1.get("/learning").get_data(as_text=True)
    s.check("the person is asked how it was", "How was it?" in home1 and 'action="/learning/rate/%d"' % reg_of(E1, S3)["id"]
            in home1)
    r3 = reg_of(E1, S3)["id"]
    post(C1, "/learning/rate/%d" % r3, {"relevant": "5", "clear": "4", "apply": "9", "overall": "4"})
    s.check("an answer outside 1-5 is refused", one("SELECT COUNT(*) FROM lms_ratings WHERE registration_id=?", (r3,)) == 0)
    post(C1, "/learning/rate/%d" % r3, {"relevant": "5", "clear": "4", "apply": "4", "overall": "4",
                                         "comment": "ZZLF the role play helped"})
    s.check("rated once", one("SELECT overall FROM lms_ratings WHERE registration_id=?", (r3,)) == 4)
    post(C1, "/learning/rate/%d" % r3, {"relevant": "1", "clear": "1", "apply": "1", "overall": "1"})
    s.check("...never twice", one("SELECT overall FROM lms_ratings WHERE registration_id=?", (r3,)) == 4)
    post(C3, "/learning/rate/%d" % reg_of(E3, S3)["id"], {"relevant": "1", "clear": "1", "apply": "1", "overall": "1"})
    s.check("someone absent can't rate it", one("SELECT COUNT(*) FROM lms_ratings WHERE registration_id=?",
                                                (reg_of(E3, S3)["id"],)) == 0)
    post(C2, "/learning/rate/%d" % r3, {"relevant": "1", "clear": "1", "apply": "1", "overall": "1"})
    s.check("...nor someone else's", one("SELECT overall FROM lms_ratings WHERE registration_id=?", (r3,)) == 4)
    page = C_LND.get(U3).get_data(as_text=True)
    s.check("the session page holds one rating back: no average, no comment, until 3 and 5 have rated (2026-10-23)",
            "1 rating so far" in html.unescape(page) and "the role play helped" not in page)
    s.check("the space counts the hours and what's done", "hours this year" in home1)

    s.section("the calendar file")
    r = C1.get("/learning/ics/%d" % r3)
    body = r.get_data(as_text=True)
    s.check("a confirmed session's .ics: one event a day, 00:00 MYT as 16:00Z the day before",
            r.status_code == 200 and r.mimetype == "text/calendar" and body.count("BEGIN:VEVENT") == 1
            and "DTSTART:%sT160000Z" % (TODAY - timedelta(days=1)).strftime("%Y%m%d") in body, body[:300])
    s.check("...nobody else's", C2.get("/learning/ics/%d" % r3).status_code == 404)

    s.section("cancelling a place")
    post(C2, "/learning/register", {"session": S2})
    g = reg_of(E2, S2)
    post(C_LND, "/admin/learning/sessions/%d" % S2, {"action": "cancel", "registration_id": g["id"], "reason": ""})
    s.check("L&D cancelling a place needs the reason", reg_of(E2, S2)["status"] != "cancelled")
    post(C_LND, "/admin/learning/sessions/%d" % S2, {"action": "cancel", "registration_id": g["id"],
                                                    "reason": "ZZLF moved to another site"})
    s.check("...with it, cancelled and the person reads why", reg_of(E2, S2)["status"] == "cancelled"
            and reg_of(E2, S2)["remark"] == "ZZLF moved to another site")

    s.section("the pages render, every POST form double-confirmed")
    pages = {"Mine": (C1, "/learning"), "Team": (CM, "/learning?view=team"), "Dept": (CH, "/learning?view=dept"),
             "register": (C1, "/learning/register?session=%d" % S2), "request": (C1, "/learning/request"),
             "sessions": (C_LND, "/admin/learning/sessions?show=all"), "requests": (C_LND, "/admin/learning/requests"),
             "rounds": (C_LND, "/admin/learning/rounds"), "settings": (C_SU, "/admin/learning/settings"),
             "screen": (C_LND, "/admin/learning/sessions/%d/screen" % S3)}
    bad_pages, unconfirmed = [], []
    for k, (c_, u_) in pages.items():
        r = c_.get(u_)
        if r.status_code != 200:
            bad_pages.append((k, r.status_code))
            continue
        _p, b = confirmed_forms(r.get_data(as_text=True))
        unconfirmed += [(k, f) for f in b]
    s.check("every page answers 200", not bad_pages, bad_pages)
    s.check("...and every POST form on them asks first", not unconfirmed, unconfirmed[:3])
    s.check("someone with no team gets Mine, whatever they ask for", "Waiting on you" not in
            C1.get("/learning?view=team").get_data(as_text=True))
    s.check("an admin opening the space goes to the admin side", C_SU.get("/learning").status_code == 302)
    pnl = CO_.get("/learning/panel?tab=catalogue").get_data(as_text=True)
    s.check("the Learning panel offers Register for an open session", "/learning/register?session=%d" % S1 in pnl)
    pnl = C2.get("/learning/panel?tab=catalogue").get_data(as_text=True)
    s.check("...and where they have a request, where it is instead", "/learning/register?session=%d" % S1 not in pnl
            and "Confirmed" in pnl)
finally:
    if _ENV0 is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = _ENV0
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        if _CHAINS0:
            db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('lms_chains', ?)", (_CHAINS0[0],))
        db.commit()
sys.exit(s.done())
