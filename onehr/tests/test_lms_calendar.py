"""AI+ Learning: the learning calendar (Chris, 2026-10-22: "we also need a calendar view of the learning program, open to
both users and admin (admin to edit and add program)"; canvas boards 8A, 15A; "ok, build all of it on staging").

What this suite holds:
  * staff's month: sessions of published programmes open to them (their audience) only; a draft programme's and a
    cancelled session never; each day of a run; their plan's marked and first; full ones (the waiting list), or hidden
    with "With seats"; their own marked; by competency, format and place; month by month; as a list
  * L&D's month: every session, a draft programme's dashed; add one on a day; change one: seats never below those
    confirmed, more seats move the waiting list up, a change of when or where tells everyone on it (once per change)
    and updates their sent invites; cancel one; a BG admin can't
Everything here is synthetic (ZZLK / ZZ9LK-) and removed at the end.
"""
import html
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: the learning calendar")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG = "ZZLK Group"
_ENV0 = os.environ.get("ONEHR_LMS")
_NEEDS0, _MAIL0 = a.lms_person_needs, a.mailer.is_configured
TODAY = a._today_myt()
M0 = (TODAY.replace(day=1) + timedelta(days=40)).replace(day=1)   # the month after next: nothing of the scratch copy's
MONTH = M0.isoformat()[:7]


def D(n):
    return (M0 + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LK-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLK %'")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM lms_sent WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM email_outbox WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM lms_registrations WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, grade="15", role="user", admin_bg=None, mgr=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, email, admin_bg, manager_id, confirmation_date) VALUES "
                      "(?,?, 'x', ?, ?,?, 'ZZLK U1', 'ZZLK Sales', 'ZZLK Officer', ?, ?, ?, ?, '2020-01-01')",
                      (eid.lower(), "ZZ LK " + eid.split("-")[1], role, eid, BG, grade,
                       eid.lower() + "@example.invalid", admin_bg, mgr)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZLK U1')", (BG,))
    MGR = person(db, "ZZ9LK-MGR")
    E1, E2, E3, E4, LOW = (person(db, "ZZ9LK-%s" % x, mgr=MGR) for x in ("E1", "E2", "E3", "E4", "LOW"))
    db.execute("UPDATE users SET job_grade='9' WHERE id=?", (LOW,))
    LND = person(db, "ZZ9LK-LND", None, "admin", a.LMS_ADMIN_BG)
    BGA = person(db, "ZZ9LK-BGA", None, "admin", BG)

    def prog(title, status="published", kind="inhouse", aud=None):
        return db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, audience_json) VALUES "
                          "(?,?,?, 7, 1, ?)", (title, kind, status, aud)).lastrowid
    PA, PB = prog("ZZLK Negotiation"), prog("ZZLK Excel", kind="elearning")
    PD = prog("ZZLK Draft", "draft")
    PH = prog("ZZLK Leaders", aud='{"grade_min": 13}')
    db.execute("INSERT INTO lms_programme_competencies(programme_id, comp_key, level, confirmed) VALUES "
               "(?, 'zzlk-pricing', 3, 1)", (PA,))

    def sess(pid, a_, b_, seats=None, venue="ZZLK Room", status="planned"):
        return db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, start_time, end_time, "
                          "venue, seats, reg_cutoff, status, needs_out) VALUES (?, 'ZZLK run', ?, ?, '09:00', '17:00', ?, "
                          "?, ?, ?, 1)", (pid, a_, b_, venue, seats, D(-20), status)).lastrowid
    SA = sess(PA, D(9), D(10), seats=3)           # two days, three seats
    SF = sess(PA, D(16), D(16), seats=1)          # full
    SB = sess(PB, D(12), D(12), venue="Online")
    SD = sess(PD, D(14), D(14))                   # a draft programme's
    SC = sess(PA, D(20), D(20), status="cancelled")
    SH = sess(PH, D(22), D(22))                   # JG 13 and up
    db.execute("UPDATE lms_sessions SET reg_cutoff=? WHERE id IN (?,?,?,?,?,?)", (D(5), SA, SF, SB, SD, SC, SH))

    def reg(uid, sid, status="approved"):
        return db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, level, "
                          "level_since) VALUES (?,?,?,?, '[]', 0, date('now'))",
                          (uid, sid, db.execute("SELECT programme_id FROM lms_sessions WHERE id=?", (sid,)).fetchone()[0],
                           status)).lastrowid
    R1 = reg(E1, SA)
    R2 = reg(E2, SA)
    RF = reg(E3, SF)
    RW = reg(E4, SA, "pending")
    db.execute("INSERT INTO lms_invites(registration_id, via) VALUES (?, 'email')", (R1,))
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


def cal(uid, **kw):
    with a.app.test_request_context():
        db = a.get_db()
        u = a._lms_user(db, uid)
        return a.lms_calendar(db, u, MONTH, staff=kw.pop("staff", True), **kw)


def on_day(c, day, sid):
    return any(e["sid"] == sid for w in c["weeks"] for cell in w if cell["iso"] == day for e in cell["events"])


try:
    env("1")
    a.lms_person_needs = lambda db, u: [{"key": "zzlk-pricing", "source": "plan", "level": 4}] if u["id"] == E2 else []
    CL, CB = H.client_as(a, LND), H.client_as(a, BGA)
    C1, C2, CLOW = H.client_as(a, E1), H.client_as(a, E2), H.client_as(a, LOW)

    s.section("staff's month")
    c = cal(E2)
    s.check("published sessions, on each of their days", on_day(c, D(9), SA) and on_day(c, D(10), SA) and
            on_day(c, D(12), SB))
    s.check("never a draft programme's, never a cancelled session", SD not in c["events"] and SC not in c["events"])
    s.check("only what's open to them (a JG 13+ programme)", SH in c["events"] and SH not in cal(LOW)["events"])
    s.check("their plan's marked (and not for someone it isn't)", c["events"][SF]["plan"] is True and
            cal(E1)["events"][SF]["plan"] is False)
    c3 = cal(E3)
    s.check("their own marked", c3["events"][SF]["state"] == "registered")
    s.check("full: the waiting list", cal(E2)["events"][SF]["state"] == "full")
    s.check("'With seats' hides a full one (not their own)", SF not in cal(E2, seats_only=True)["events"] and
            SF in cal(E3, seats_only=True)["events"])
    s.check("by competency, format and place", set(cal(E2, comp="zzlk-pricing")["events"]) >= {SA, SF} and
            SB not in cal(E2, comp="zzlk-pricing")["events"] and set(cal(E2, kind="elearning")["events"]) == {SB}
            and set(cal(E2, venue="Online")["events"]) == {SB})
    with a.app.test_request_context():
        db = a.get_db()
        cp = a.lms_calendar(db, a._lms_user(db, E2), (M0 - timedelta(days=1)).isoformat()[:7])
    s.check("month by month", c["next"] == (M0 + timedelta(days=32)).replace(day=1).isoformat()[:7] and
            c["prev"] == (M0 - timedelta(days=1)).replace(day=1).isoformat()[:7] and SA not in cp["events"])
    pg = html.unescape(CLOW.get("/learning?view=calendar&m=%s&seats=0" % MONTH).get_data(as_text=True))
    s.check("the page: the month, the sessions, their own view", M0.strftime("%B %Y") in pg and "ZZLK Negotiation" in pg
            and "ZZLK Leaders" not in pg)
    pg = html.unescape(C2.get("/learning?view=calendar&m=%s&s=%d" % (MONTH, SB)).get_data(as_text=True))
    s.check("...the one they pick, with Register", "/learning/register?session=%d" % SB in pg and
            "Open the programme" in pg)
    pg = html.unescape(C2.get("/learning?view=calendar&m=%s&mode=list" % MONTH).get_data(as_text=True))
    s.check("...as a list", "lc-li" in pg and "ZZLK Excel" in pg)

    s.section("L&D's month")
    pg = html.unescape(CL.get("/admin/learning/calendar?m=%s" % MONTH).get_data(as_text=True))
    s.check("every session, a draft programme's dashed", "ZZLK Draft" in pg and "lc-ev is-draft" in pg)
    r = CB.post("/admin/learning/calendar", data={"csrf_token": "tok", "action": "edit", "session_id": SA,
                                                 "starts_on": D(9), "ends_on": D(9)})
    s.check("a BG admin can't change one", r.status_code == 403 and one("SELECT ends_on FROM lms_sessions WHERE id=?",
                                                                        (SA,)) == D(10))
    CL.post("/admin/learning/calendar", data={"csrf_token": "tok", "action": "edit", "session_id": SA, "starts_on": D(9),
                                             "ends_on": D(10), "seats": "1", "venue": "ZZLK Room"})
    s.check("seats never below those confirmed", one("SELECT seats FROM lms_sessions WHERE id=?", (SA,)) == 3)
    CL.post("/admin/learning/calendar", data={"csrf_token": "tok", "action": "edit", "session_id": SA, "starts_on": D(9),
                                             "ends_on": D(8)})
    s.check("the last day never before the first", one("SELECT ends_on FROM lms_sessions WHERE id=?", (SA,)) == D(10))
    a.mailer.is_configured = lambda: True
    CL.post("/admin/learning/calendar", data={"csrf_token": "tok", "action": "edit", "session_id": SA, "starts_on": D(11),
                                             "ends_on": D(12), "start_time": "09:00", "end_time": "17:00", "seats": "3",
                                             "venue": "ZZLK Room 5", "reg_cutoff": D(5)})
    s.check("moved: saved", one("SELECT starts_on||'/'||ends_on||'/'||venue FROM lms_sessions WHERE id=?", (SA,)) ==
            "%s/%s/ZZLK Room 5" % (D(11), D(12)))
    s.check("...everyone on it told (confirmed and waiting for approval)", one(
        "SELECT COUNT(*) FROM lms_sent WHERE kind='changed' AND ref LIKE ? AND user_id IN (?,?,?)",
        ("sess:%d:edit:%%" % SA, E1, E2, E4)) == 3)
    s.check("...a sent invite updated: a later sequence, emailed", one(
        "SELECT seq FROM lms_invites WHERE registration_id=?", (R1,)) == 1 and one(
        "SELECT COUNT(*) FROM email_outbox WHERE user_id=? AND subject LIKE 'Updated:%'", (E1,)) == 1)
    CL.post("/admin/learning/calendar", data={"csrf_token": "tok", "action": "edit", "session_id": SA, "starts_on": D(11),
                                             "ends_on": D(12), "start_time": "09:00", "end_time": "17:00", "seats": "3",
                                             "venue": "ZZLK Room 5", "reg_cutoff": D(5)})
    s.check("saved again unchanged: nobody told twice", one(
        "SELECT COUNT(*) FROM lms_sent WHERE kind='changed' AND ref LIKE ?", ("sess:%d:edit:%%" % SA,)) == 3)
    for d_, e_ in ((D(9), D(9)), (D(11), D(12))):   # moved back, then there again: told each time
        CL.post("/admin/learning/calendar", data={"csrf_token": "tok", "action": "edit", "session_id": SA,
                                                 "starts_on": d_, "ends_on": e_, "start_time": "09:00",
                                                 "end_time": "17:00", "seats": "3", "venue": "ZZLK Room 5",
                                                 "reg_cutoff": D(5)})
    s.check("moved back and there again: told each time", one(
        "SELECT COUNT(*) FROM lms_sent WHERE kind='changed' AND ref LIKE ? AND user_id=?", ("sess:%d:edit:%%" % SA,
                                                                                             E1)) == 3)
    CL.post("/admin/learning/calendar", data={"csrf_token": "tok", "action": "edit", "session_id": SA, "starts_on": D(11),
                                             "ends_on": D(12), "start_time": "09:00", "end_time": "17:00", "seats": "3",
                                             "venue": "ZZLK Room 5", "reg_cutoff": D(5)})
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE lms_registrations SET status='waitlisted' WHERE id=?", (RW,))
        db.execute("UPDATE lms_sessions SET seats=2 WHERE id=?", (SA,))
        db.commit()
    CL.post("/admin/learning/calendar", data={"csrf_token": "tok", "action": "edit", "session_id": SA, "starts_on": D(11),
                                             "ends_on": D(12), "start_time": "09:00", "end_time": "17:00", "seats": "3",
                                             "venue": "ZZLK Room 5", "reg_cutoff": D(5)})
    s.check("more seats: the waiting list moves up", one("SELECT status FROM lms_registrations WHERE id=?", (RW,)) !=
            "waitlisted")
    CL.post("/admin/learning/calendar", data={"csrf_token": "tok", "action": "add", "programme_id": PA,
                                             "starts_on": D(25), "ends_on": D(25), "seats": "12", "venue": "ZZLK Hall",
                                             "run_label": "ZZLK added"})
    SN = one("SELECT id FROM lms_sessions WHERE run_label='ZZLK added'")
    s.check("added on a day", SN and one("SELECT starts_on||'/'||seats FROM lms_sessions WHERE id=?", (SN,)) ==
            "%s/12" % D(25) and on_day(cal(E2), D(25), SN))
    CL.post("/admin/learning/calendar", data={"csrf_token": "tok", "action": "cancel", "session_id": SA,
                                              "reason": "ZZLK trainer unwell"})
    s.check("cancelled: gone from staff's month, invites cancelled", one(
        "SELECT status FROM lms_sessions WHERE id=?", (SA,)) == "cancelled" and SA not in cal(E2)["events"] and
        one("SELECT status FROM lms_invites WHERE registration_id=?", (R1,)) == "cancelled")
    s.check("the registry", a.ADMIN_ACCESS_MAP.get("admin_learning_calendar") == "lms")
    env(None)
    s.check("dark: the calendar view is a 404", C1.get("/learning?view=calendar").status_code == 404)
finally:
    env(_ENV0)
    a.lms_person_needs, a.mailer.is_configured = _NEEDS0, _MAIL0
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
sys.exit(s.done())
