"""AI+ Learning: every email (Chris, 2026-10-22: "we also need reminder for training, like email reminder to attend
training, reminder for LM to approve, and evaluate after their direct report attended the training, and whatever is
required an email communication"; canvas boards 9A, 16A; "ok, build all of it on staging").

What this suite holds:
  * one sender: an email goes once (kind + what + whom); a kind switched off sends and records nothing; recorded even
    with no email here (no backlog later), queued only where the server sends email and the person has an address;
    L&D's subject ({programme}) and opening line; never to someone who has left
  * at the moment it happens: a request to approve, confirmed, returned (with the remark), the waiting list and a
    place coming up, taken off by L&D (the person and their line manager), a withdrawal (the line manager), a session
    cancelled (everyone on it)
  * the scheduler: a day before an approval's clock, then passed on (the next person up and the one who held it);
    three days before and the day before from 08:00; the trainer two days before, with the room's link; an absence
    (the person and their line manager); the rating the day after closing; the line manager's 3-month confirmation and
    its second reminder five working days on; the nomination round opened and closing; L&D's weekday digest from 08:00
  * a 1- or 3-month check-in switched off isn't emailed
  * Settings › Emails: L&D or the super admin switch and word them (logged), a BG admin can't; each has a preview
Everything here is synthetic (ZZLM / ZZ9LM-) and removed at the end.
"""
import html
import json
import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: every email")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO = "ZZLM Group", "ZZLM U1"
_ENV0 = os.environ.get("ONEHR_LMS")
_NOW0, _TODAY0, _MAIL0, _SCREEN0 = a._now_myt, a._today_myt, a.mailer.is_configured, a.ai_draft.screen_message
T0 = date(2026, 11, 4)                     # a Wednesday
NOW = [datetime(2026, 11, 4, 9, 0)]


def at(d, hm="09:00"):
    NOW[0] = datetime(d.year, d.month, d.day, int(hm[:2]), int(hm[3:]))


def D(n):
    return (T0 + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LM-%' OR username LIKE 'zzlm-%'")]
    db.execute("DELETE FROM lms_rounds WHERE title LIKE 'ZZLM %'")
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLM %'")
    db.execute("DELETE FROM lms_sent WHERE to_key='e:zzlm-trainer@example.invalid'")
    db.execute("DELETE FROM email_outbox WHERE to_email='zzlm-trainer@example.invalid'")
    db.execute("DELETE FROM lms_email_settings")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM lms_sent WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM email_outbox WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM lms_registrations WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, mgr=None, hod=None, role="user", admin_bg=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, hod_id, email, admin_bg, confirmation_date) VALUES "
                      "(?,?, 'x', ?, ?,?,?, 'ZZLM Sales', 'ZZLM Officer', '15', ?, ?, ?, ?, '2020-01-01')",
                      (eid.lower(), "ZZ LM " + eid.split("-")[1], role, eid, BG, CO, mgr, hod,
                       eid.lower() + "@example.invalid", admin_bg)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    HOD = person(db, "ZZ9LM-HOD")
    MGR = person(db, "ZZ9LM-MGR", hod=HOD)
    E = {i: person(db, "ZZ9LM-E%d" % i, MGR, HOD) for i in range(1, 10)}
    LND = person(db, "ZZ9LM-LND", role="admin", admin_bg=a.LMS_ADMIN_BG)
    BGA = person(db, "ZZ9LM-BGA", role="admin", admin_bg=BG)
    P = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, trainer, vendor, trainer_email) VALUES "
                   "('ZZLM Negotiation', 'inhouse', 'published', 7, 1, 'Ms ZZLM', 'ZZLM Training', "
                   "'zzlm-trainer@example.invalid')").lastrowid

    def sess(day, seats=None, key=None):
        return db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, start_time, end_time, venue, seats, "
                          "needs_out, room_key) VALUES (?,?,?, '09:00', '17:00', 'ZZLM Room', ?, 1, ?)",
                          (P, day, day, seats, key)).lastrowid
    S_D1, S_D3, S_TR, S_PAST, S_FULL = sess(D(1)), sess(D(3)), sess(D(2), key="zzlmkey"), sess(D(-1)), sess(D(20), 1)

    def reg(uid, sid, status="approved", **kw):
        cols = ["user_id", "session_id", "programme_id", "status", "chain_json"] + list(kw)
        vals = [uid, sid, P, status, kw.pop("chain", "[]") if False else "[]"] + list(kw.values())
        return db.execute("INSERT INTO lms_registrations(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                          vals).lastrowid
    R_D1, R_D3 = reg(E[1], S_D1), reg(E[2], S_D3)
    chain = lambda since: json.dumps([{"role": "lm", "approver": MGR, "days": 3, "escalate": "hod",  # noqa: E731
                                       "state": "waiting"}])
    R_REM = db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, level, "
                       "level_since) VALUES (?,?,?, 'pending', ?, 0, ?)", (E[3], S_D3, P, chain(0), D(-2))).lastrowid
    R_LATE = db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, level, "
                        "level_since) VALUES (?,?,?, 'pending', ?, 0, ?)", (E[4], S_D3, P, chain(0), D(-7))).lastrowid
    R_RATE = reg(E[5], S_PAST, outcome="attended")
    db.execute("UPDATE lms_sessions SET closed_at=? WHERE id=?", (D(-1) + " 02:00:00", S_PAST))
    R_ABS = reg(E[6], S_PAST)
    ABS = db.execute("INSERT INTO lms_absences(registration_id, on_date) VALUES (?,?)", (R_ABS, D(-1))).lastrowid
    R_M3 = reg(E[7], S_PAST, outcome="attended")
    EV = db.execute("INSERT INTO lms_evaluations(registration_id, kind, due_on, status, updated_at) VALUES "
                    "(?, 'm3', ?, 'self_done', ?)", (R_M3, D(-1), D(-1) + " 03:00:00")).lastrowid
    RD = db.execute("INSERT INTO lms_rounds(title, closes_on) VALUES ('ZZLM Q1 round', ?)", (D(10),)).lastrowid
    R_FULL = reg(E[8], S_FULL)
    S_OLD1, S_OLD3 = sess(D(-40)), sess(D(-100))
    reg(E[5], S_OLD1, outcome="attended")
    reg(E[7], S_OLD3, outcome="attended")
    # the scheduler emails the open round closing soonest: hold any other open round aside for the suite
    OTHER_ROUNDS = [r[0] for r in db.execute("SELECT id FROM lms_rounds WHERE status='open' AND id!=?", (RD,))]
    db.execute("UPDATE lms_rounds SET status='closed' WHERE id IN (%s)" % ",".join("?" * len(OTHER_ROUNDS)),
               OTHER_ROUNDS) if OTHER_ROUNDS else None
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def sent(kind, uid=None, ref=None, to_key=None):
    q, args = "SELECT COUNT(*) FROM lms_sent WHERE kind=?", [kind]
    if uid:
        q += " AND user_id=?"
        args.append(uid)
    if ref:
        q += " AND ref=?"
        args.append(ref)
    if to_key:
        q += " AND to_key=?"
        args.append(to_key)
    return one(q, tuple(args))


def queued(uid, like="%"):
    return one("SELECT COUNT(*) FROM email_outbox WHERE user_id=? AND subject LIKE ?", (uid, like))


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


def due():
    with a.app.app_context():
        return a.lms_mail_due(a.get_db())


try:
    env("1")
    a._now_myt = lambda: NOW[0]
    a._today_myt = lambda: NOW[0].date()
    a.ai_draft.screen_message = (lambda m: None)
    a.mailer.is_configured = lambda: True
    CS, CL, CB = H.client_as(a, SU["id"]), H.client_as(a, LND), H.client_as(a, BGA)
    CE = {i: H.client_as(a, E[i]) for i in E}
    CM = H.client_as(a, MGR)

    s.section("one sender")
    with a.app.app_context():
        db = a.get_db()
        u1 = a._lms_user(db, E[1])
        _r = a._lms_mail(db, "returned", u1, "zz:1", "S", ["x"])
        db.commit()
        s.check("queued with email on and an address", _r is True and queued(E[1]) == 1, (_r, queued(E[1])))
        _r = a._lms_mail(db, "returned", u1, "zz:1", "S", ["x"])
        db.commit()
        s.check("once: the same kind, thing and person never twice", _r is False and queued(E[1]) == 1)
        db.execute("INSERT INTO lms_email_settings(kind, enabled) VALUES ('returned', 0)")
        db.commit()
        _r = a._lms_mail(db, "returned", u1, "zz:2", "S", ["x"])
        db.commit()
        s.check("a kind switched off: nothing sent, nothing recorded", _r is False and sent("returned", E[1], "zz:2") == 0)
        db.execute("UPDATE lms_email_settings SET enabled=1, subject='ZZLM {programme} update', intro='ZZLM hello' "
                   "WHERE kind='returned'")
        a._lms_mail(db, "returned", u1, "zz:3", "S", ["x"], prog="Negotiation")
        db.commit()
        row = db.execute("SELECT subject, body FROM email_outbox WHERE user_id=? ORDER BY id DESC", (E[1],)).fetchone()
        s.check("L&D's subject with {programme}, and their opening line first", row["subject"] ==
                "ZZLM Negotiation update" and row["body"].find("ZZLM hello") < row["body"].find("<p>x</p>"))
        a.mailer.is_configured = lambda: False
        _r = a._lms_mail(db, "returned", u1, "zz:4", "S", ["x"])
        db.commit()
        s.check("no email here: recorded, not queued (no backlog later)", _r is False and
                sent("returned", E[1], "zz:4") == 1 and queued(E[1]) == 2, (_r, sent("returned", E[1], "zz:4"),
                                                                            queued(E[1])))
        a.mailer.is_configured = lambda: True
        db.execute("UPDATE users SET left_at='2026-01-01' WHERE id=?", (E[9],))
        db.commit()
        _r = a._lms_mail(db, "returned", a._lms_user(db, E[9]), "zz:5", "S", ["x"])
        db.commit()
        s.check("never to someone who has left", _r is False and queued(E[9]) == 0)
        db.execute("UPDATE users SET left_at=NULL WHERE id=?", (E[9],))
        db.execute("DELETE FROM lms_email_settings")
        db.commit()

    s.section("when it happens")
    CE[9].post("/learning/register", data={"csrf_token": "tok", "session": S_FULL})
    r9 = one("SELECT id FROM lms_registrations WHERE user_id=? AND session_id=?", (E[9], S_FULL))
    s.check("the waiting list", sent("waitlist", E[9], "reg:%d:wait" % r9) == 1 and
            queued(E[9], "You're on the waiting list") == 1)
    CE[8].post("/learning/mine/%d" % R_FULL, data={"csrf_token": "tok", "action": "withdraw", "why_kind": "leave",
                                                   "why": "ZZLM medical"})
    s.check("a withdrawal: the line manager is told, with the reason", sent("withdrew", MGR, "reg:%d" % R_FULL) == 1 and
            queued(MGR, "ZZ LM E8 withdrew from training") == 1)
    s.check("a place came up for the next person", sent("waitlist", E[9], "reg:%d:up" % r9) == 1 and
            queued(E[9], "A place came up for you") == 1)
    s.check("a request to approve, to the line manager", sent("approve", MGR) >= 1)
    CM.post("/learning/decide/%d" % r9, data={"csrf_token": "tok", "action": "return", "remark": "ZZLM not this quarter"})
    s.check("returned, with the remark", sent("returned", E[9]) >= 1 and queued(E[9], "Your learning request came back") == 1
            and "ZZLM not this quarter" in one("SELECT body FROM email_outbox WHERE user_id=? AND subject LIKE "
                                               "'Your learning request came back'", (E[9],)))
    CL.post("/admin/learning/sessions/%d" % S_D1, data={"csrf_token": "tok", "action": "cancel", "registration_id": R_D1,
                                                       "reason": "ZZLM moved to Johor"})
    s.check("taken off by L&D: the person and their line manager", sent("removed", E[1], "reg:%d" % R_D1) == 1 and
            sent("removed", MGR, "reg:%d" % R_D1) == 1)
    with a.app.app_context():
        db = a.get_db()
        su = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        _D3 = [tuple(r) for r in db.execute("SELECT id, status FROM lms_registrations WHERE session_id=?", (S_D3,))]
        a.lms_session_save(db, su, P, {"reason": "ZZ trainer unwell"}, sid=S_D3, cancel=True)
    s.check("a session cancelled: everyone on it", all(sent("changed", u_, "sess:%d:cancel" % S_D3) == 1
                                                       for u_ in (E[2], E[3], E[4])))
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE lms_sessions SET status='planned' WHERE id=?", (S_D3,))
        for _rid, _st in _D3:   # the cancel closes its places too (2026-10-23): put them back for the scheduler's checks
            db.execute("UPDATE lms_registrations SET status=?, closed_kind=NULL, remark=NULL WHERE id=?", (_st, _rid))
        db.execute("UPDATE lms_registrations SET status='approved' WHERE id=?", (R_D1,))
        db.commit()

    s.section("the scheduler")
    at(T0, "09:00")
    due()
    s.check("a day before an approval's clock: the approver", sent("approve_remind", MGR, "reg:%d:L0" % R_REM) == 1 and
            sent("approve_remind", MGR, "reg:%d:L0" % R_LATE) == 0)
    s.check("past it: passed on to the HOD, and the line manager told", sent("passed_on", HOD, "reg:%d:L0" % R_LATE) == 1
            and sent("passed_on", MGR, "reg:%d:L0" % R_LATE) == 1 and sent("passed_on", HOD, "reg:%d:L0" % R_REM) == 0)
    s.check("three days before, and the day before", sent("attend_remind", E[2], "reg:%d:d3" % R_D3) == 1 and
            sent("attend_remind", E[1], "reg:%d:d1" % R_D1) == 1)
    s.check("...with the venue and the trainer", "ZZLM Room" in one(
        "SELECT body FROM email_outbox WHERE user_id=? AND subject LIKE 'Tomorrow:%'", (E[1],)) and "Ms ZZLM" in one(
        "SELECT body FROM email_outbox WHERE user_id=? AND subject LIKE 'Tomorrow:%'", (E[1],)))
    s.check("the trainer, two days before, with the room's link", sent(
        "trainer", ref="sess:%d" % S_TR, to_key="e:zzlm-trainer@example.invalid") == 1 and
        "/learning/room/%d?k=zzlmkey" % S_TR in one("SELECT body FROM email_outbox WHERE to_email="
                                                     "'zzlm-trainer@example.invalid'"))
    s.check("an absence: the person, and their line manager", sent("absent", E[6], "abs:%d" % ABS) == 1 and
            sent("absent", MGR, "abs:%d" % ABS) == 1)
    s.check("the rating, the day after it closed", sent("rate", E[5], "reg:%d" % R_RATE) == 1)
    s.check("the line manager's 3-month confirmation", sent("lm_confirm", MGR, "eval:%d" % EV) == 1 and
            sent("lm_confirm", MGR, "eval:%d:again" % EV) == 0)
    s.check("the round, to HODs", sent("round", HOD, "round:%d:open" % RD) == 1)
    s.check("L&D's digest, weekdays from 08:00", sent("digest", LND, "digest:%s" % T0.isoformat()) == 1)
    n_before = one("SELECT COUNT(*) FROM lms_sent")
    due()
    s.check("a second run sends nothing new", one("SELECT COUNT(*) FROM lms_sent") == n_before)
    at(T0, "07:00")
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM lms_sent WHERE kind IN ('attend_remind','digest')")
        db.commit()
    due()
    s.check("before 08:00: no day-before reminder, no digest", sent("attend_remind", E[1], "reg:%d:d1" % R_D1) == 0 and
            sent("digest", LND) == 0 and sent("attend_remind", E[2], "reg:%d:d3" % R_D3) == 1)
    at(T0 + timedelta(days=7), "09:00")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE lms_rounds SET closes_on=? WHERE id=?", ((T0 + timedelta(days=9)).isoformat(), RD))
        db.commit()
    due()
    s.check("five working days on, the second reminder", sent("lm_confirm", MGR, "eval:%d:again" % EV) == 1)
    s.check("three days before the round closes", sent("round", HOD, "round:%d:closing" % RD) == 1)
    at(date(2026, 11, 7), "09:00")    # a Saturday
    due()
    s.check("no digest at the weekend", sent("digest", LND, "digest:2026-11-07") == 0)

    s.section("check-ins switched off")
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO lms_email_settings(kind, enabled) VALUES ('m3', 0)")
        db.commit()
        a.lms_auto(db)
        s.check("a switched-off check-in isn't emailed (the 1-month one still is)",
                queued(E[5], "Your 1-month check-in%") == 1 and queued(E[7], "Your 3-month%") == 0 and
                one("SELECT COUNT(*) FROM lms_evaluations e JOIN lms_registrations r ON r.id=e.registration_id WHERE "
                    "r.user_id=? AND e.kind='m3' AND e.status='due'", (E[7],)) == 1)

    s.section("Settings › Emails")
    pg = html.unescape(CL.get("/admin/learning/emails").get_data(as_text=True))
    s.check("every email, grouped, with who and when", all(t_ in pg for t_ in (
        "Registering and approving", "Before and on the day", "Reminder to attend", "L&D's daily digest",
        "Confirm what they applied")) and pg.count('class="lm-switch') == 22)
    r = CB.post("/admin/learning/emails", data={"csrf_token": "tok", "action": "toggle", "kind": "digest"})
    s.check("a BG admin can't switch one", r.status_code == 403)
    CL.post("/admin/learning/emails", data={"csrf_token": "tok", "action": "toggle", "kind": "digest"})
    s.check("L&D switches one off, logged", one("SELECT enabled FROM lms_email_settings WHERE kind='digest'") == 0 and
            one("SELECT COUNT(*) FROM activity_log WHERE action='lms_email' AND user_id=?", (LND,)) == 1)
    CL.post("/admin/learning/emails", data={"csrf_token": "tok", "action": "words", "kind": "rate",
                                           "subject": "ZZLM rate {programme}", "intro": "ZZLM thanks"})
    s.check("...and words one", one("SELECT subject||'|'||intro FROM lms_email_settings WHERE kind='rate'") ==
            "ZZLM rate {programme}|ZZLM thanks")
    r = CL.get("/admin/learning/emails/attend_remind/preview")
    s.check("each has a preview", r.status_code == 200 and "Tomorrow: Negotiation for Margin" in r.get_data(as_text=True))
    s.check("the registry: 22 kinds, the page and its writes classified",
            len(a.LMS_EMAILS) == 22 and a.ADMIN_ACCESS_MAP.get("admin_learning_emails") == "lms" and
            "lms_email" in a.ACTION_LABELS)
    s.check("the schema text is the same in both", all(t_ in a._LMS_DDL and t_ in a.SCHEMA for t_ in (
        "CREATE TABLE IF NOT EXISTS lms_email_settings", "CREATE TABLE IF NOT EXISTS lms_sent", "trainer_email TEXT")))
finally:
    with a.app.app_context():
        db = a.get_db()
        if OTHER_ROUNDS:
            db.execute("UPDATE lms_rounds SET status='open' WHERE id IN (%s)" % ",".join("?" * len(OTHER_ROUNDS)),
                       OTHER_ROUNDS)
            db.commit()
    env(_ENV0)
    a._now_myt, a._today_myt, a.mailer.is_configured = _NOW0, _TODAY0, _MAIL0
    a.ai_draft.screen_message = _SCREEN0
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
sys.exit(s.done())
