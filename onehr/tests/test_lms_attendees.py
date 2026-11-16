"""AI+ Learning: attendees, calendar invites, withdrawing with a reason, absences (Chris, 2026-10-22: "admin can issue
calendar invite after confirming the training attendee, and remove the invite if the attendee withdraws or admin removes
them. Any withdrawal from the training registered requires justification from the user, and this should dynamically
open up the slot and make available to others. Absentism to the training should also be tracked and flagged to admin
and LM."; canvas boards 8D, 8E, 15C; "ok, build all of it on staging").

What this suite holds:
  * withdrawing: a reason (a kind and a line) or nothing happens; it's kept for the line manager and L&D; the place
    goes to the next person waiting; the invite is cancelled; never on or after the first day
  * invites: only a confirmed place on a session still to come; on a server without email it's ready on their page;
    with email, the calendar file goes attached (METHOD:REQUEST, the person as attendee); once; L&D's "send to all";
    taken off by L&D, withdrawing, or the session cancelled sends a CANCEL with a later sequence; sending again after
    a cancellation moves the sequence on
  * the outbox and the mailer: an attachment only where the email has one, every other email sent exactly as before
  * absences: a confirmed place on a day whose clock-in has closed, no clock-in, no withdrawal; not before the day's
    window closes; once; voided by a mark-in by hand; never for e-learning; an older closed session from its result
    only; the person says why (or that they were there); the line manager or L&D excuses it, with a reason; two or more
    not excused in a year are flagged
  * where it shows: Mine, Team, the dashboard's rows, the L&D session page; the scheduler finds them
Everything here is synthetic (ZZLA / ZZ9LA-) and removed at the end.
"""
import base64
import html
import json
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: attendees, invites, withdrawing, absences")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO = "ZZLA Group", "ZZLA U1"
_ENV0 = os.environ.get("ONEHR_LMS")
_NOW0, _TODAY0 = a._now_myt, a._today_myt
_MAIL0, _SCREEN0 = a.mailer.is_configured, a.ai_draft.screen_message
TODAY = _TODAY0()
NOW = [datetime(TODAY.year, TODAY.month, TODAY.day, 12, 0)]


def at(hm):
    NOW[0] = datetime(TODAY.year, TODAY.month, TODAY.day, int(hm[:2]), int(hm[3:]))


def D(n):
    return (TODAY + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LA-%' OR username LIKE 'zzla-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLA %'")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM email_outbox WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM lms_registrations WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM lms_attendance WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, mgr=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, email, confirmation_date) VALUES "
                      "(?,?, 'x', 'user', ?,?,?, 'ZZLA Sales', 'ZZLA Officer', '15', ?, ?, '2020-01-01')",
                      (eid.lower(), "ZZ LA " + eid.split("-")[1], eid, BG, CO, mgr,
                       eid.lower() + "@example.invalid")).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    MGR = person(db, "ZZ9LA-MGR")
    E1, E2, E3, E4, E5, E6, E7 = (person(db, "ZZ9LA-E%d" % i, MGR) for i in range(1, 8))
    OTHER = person(db, "ZZ9LA-OTH")
    LND = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzla-lnd', 'ZZ LA L&D', 'x', 'admin', ?)", (a.LMS_ADMIN_BG,)).lastrowid
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzla-bga', 'ZZ LA BG admin', 'x', 'admin', ?)", (BG,)).lastrowid

    def prog(title, kind="inhouse"):
        return db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, trainer, vendor) VALUES "
                          "(?, ?, 'published', 14, 2, 'Ms ZZLA', 'ZZLA Training')", (title, kind)).lastrowid
    P, PE = prog("ZZLA Negotiation"), prog("ZZLA Excel Online", "elearning")

    def sess(pid, a_, b_, needs_out=1, closed=False, seats=None):
        return db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, start_time, end_time, venue, seats, "
                          "needs_out, closed_at) VALUES (?,?,?, '09:00', '17:00', 'ZZLA Room 2', ?, ?, ?)",
                          (pid, a_, b_, seats, needs_out, "2026-01-01 00:00:00" if closed else None)).lastrowid
    SA = sess(P, D(-2), D(-1))                 # ran: two days over
    SB = sess(P, D(0), D(0))                   # today, 09:00-17:00
    SE = sess(PE, D(-1), D(-1))                # e-learning, over
    SL = sess(P, D(-10), D(-10), None, True)   # an older session, closed, before clock-out
    SU_ = sess(P, D(10), D(10), 1, False, 2)   # coming up, two seats

    def reg(uid, sid, status="approved", outcome=None, pid=P):
        return db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, outcome) "
                          "VALUES (?,?,?,?, '[]', ?)", (uid, sid, pid, status, outcome)).lastrowid
    R = {}
    for u_ in (E1, E2, E4):
        R[(u_, SA)] = reg(u_, SA)
    R[(E3, SA)] = reg(E3, SA, "withdrawn")
    R[(E2, SB)] = reg(E2, SB)
    R[(E2, SE)] = reg(E2, SE, pid=PE)
    R[(E5, SL)] = reg(E5, SL, outcome="absent")
    R[(E1, SL)] = reg(E1, SL, outcome="attended")
    R[(E1, SU_)] = reg(E1, SU_)
    R[(E5, SU_)] = reg(E5, SU_)
    R[(E6, SU_)] = reg(E6, SU_, "waitlisted")
    for d in (D(-2), D(-1)):
        db.execute("INSERT INTO lms_attendance(session_id, on_date, user_id, method, out_at) VALUES (?,?,?, 'qr', "
                   "datetime('now'))", (SA, d, E1))
    db.execute("INSERT INTO lms_attendance(session_id, on_date, user_id, method, out_at) VALUES (?,?,?, 'qr', "
               "datetime('now'))", (SA, D(-2), E4))
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


def txt(r):
    return html.unescape(r.get_data(as_text=True))


def user(uid):
    with a.app.app_context():
        return a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


def absences(uid):
    with a.app.app_context():
        return [(r["on_date"], r["status"]) for r in a.get_db().execute(
            "SELECT a.on_date, a.status FROM lms_absences a JOIN lms_registrations r ON r.id=a.registration_id WHERE "
            "r.user_id=? ORDER BY a.on_date", (uid,))]


def outbox(uid):
    with a.app.app_context():
        return [dict(r) for r in a.get_db().execute("SELECT * FROM email_outbox WHERE user_id=? ORDER BY id", (uid,))]


try:
    env("1")
    a._now_myt = lambda: NOW[0]
    a._today_myt = lambda: NOW[0].date()
    a.ai_draft.screen_message = (lambda m: None)
    CS, CL, CB, CM = (H.client_as(a, x) for x in (SU["id"], LND, BGA, MGR))
    C1, C2, C5, C6, CO_ = (H.client_as(a, x) for x in (E1, E2, E5, E6, OTHER))

    s.section("the mailer and the outbox: an attachment only where the email has one")
    sent = []
    _http0 = a.mailer._http_json
    a.mailer._http_json = lambda url, data=None, method=None, headers=None: sent.append(json.loads(data))
    a.mailer.send_mail("x@example.invalid", "S", "<p>b</p>", token="t")
    a.mailer.send_mail("x@example.invalid", "S", "<p>b</p>", token="t",
                       attachments=[{"name": "invite.ics", "content_type": "text/calendar; method=REQUEST",
                                     "content": "BEGIN:VCALENDAR"}])
    a.mailer._http_json = _http0
    s.check("no attachment: the message is as it always was", "attachments" not in sent[0]["message"])
    att = sent[1]["message"]["attachments"][0]
    s.check("with one: a Graph file attachment, base64", att["@odata.type"] == "#microsoft.graph.fileAttachment" and
            att["name"] == "invite.ics" and base64.b64decode(att["contentBytes"]).decode() == "BEGIN:VCALENDAR")
    calls = []
    _send0 = a.mailer.send_mail
    a.mailer.send_mail = lambda *ar, **kw: calls.append(kw)
    a._outbox_send_row({"to_email": "x", "subject": "s", "body": "b", "attach_json": None}, "t")
    a._outbox_send_row({"to_email": "x", "subject": "s", "body": "b", "attach_json": json.dumps([{"name": "i.ics",
                                                                                                 "content": "x"}])}, "t")
    a.mailer.send_mail = _send0
    s.check("the sender passes an attachment only when the row has one", calls[0] == {"token": "t"} and
            calls[1]["attachments"][0]["name"] == "i.ics")

    s.section("the calendar file")
    with a.app.app_context():
        db = a.get_db()
        reg1 = a._lms_reg(db, R[(E1, SU_)])
        plain, req, can = (a.lms_ics(db, reg1), a.lms_ics(db, reg1, "REQUEST", 0, "e1@example.invalid"),
                           a.lms_ics(db, reg1, "CANCEL", 1, "e1@example.invalid"))
    s.check("the download is as before (no method)", "METHOD:" not in plain and "SEQUENCE" not in plain)
    s.check("an invite: METHOD:REQUEST, the attendee, sequence 0", "METHOD:REQUEST" in req and
            "ATTENDEE;RSVP=FALSE:mailto:e1@example.invalid" in req and "SEQUENCE:0" in req)
    s.check("a cancellation: the same event, a later sequence, cancelled", "METHOD:CANCEL" in can and
            "SEQUENCE:1" in can and "STATUS:CANCELLED" in can and
            req.split("UID:")[1].split("\r\n")[0] == can.split("UID:")[1].split("\r\n")[0])

    s.section("invites")
    a.mailer.is_configured = lambda: False
    r = CB.post("/admin/learning/sessions/%d" % SU_, data={"csrf_token": "tok", "action": "invite",
                                                          "registration_id": R[(E1, SU_)]})
    s.check("a BG admin can't send one", r.status_code == 403 and not one(
        "SELECT COUNT(*) FROM lms_invites WHERE registration_id=?", (R[(E1, SU_)],)))
    r = CL.post("/admin/learning/sessions/%d" % SU_, data={"csrf_token": "tok", "action": "invite",
                                                          "registration_id": R[(E1, SU_)]})
    s.check("no email on this server: ready on their page, nothing queued", one(
        "SELECT status||'/'||via FROM lms_invites WHERE registration_id=?", (R[(E1, SU_)],)) == "sent/page" and
        not outbox(E1))
    with a.app.app_context():
        db = a.get_db()
        lnd = db.execute("SELECT * FROM users WHERE id=?", (LND,)).fetchone()
        ok, msg = a.lms_invite_send(db, lnd, R[(E6, SU_)])
        s.check("only a confirmed place gets one", not ok and not one(
            "SELECT COUNT(*) FROM lms_invites WHERE registration_id=?", (R[(E6, SU_)],)))
        ok, msg = a.lms_invite_send(db, lnd, R[(E1, SA)])
        s.check("...on a session still to come", not ok)
    a.mailer.is_configured = lambda: True
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM lms_invites WHERE registration_id=?", (R[(E1, SU_)],))
        db.commit()
    r = CL.post("/admin/learning/sessions/%d" % SU_, data={"csrf_token": "tok", "action": "invite_all"})
    with a.app.app_context():
        ob = outbox(E1)
    s.check("L&D sends to everyone confirmed: emailed, with the invite attached",
            one("SELECT COUNT(*) FROM lms_invites i JOIN lms_registrations r ON r.id=i.registration_id WHERE "
                "r.session_id=? AND i.status='sent' AND i.via='email'", (SU_,)) == 2 and len(ob) == 1 and
            "METHOD:REQUEST" in json.loads(ob[0]["attach_json"])[0]["content"] and
            ob[0]["subject"] == "Calendar invite: ZZLA Negotiation")
    r = CL.post("/admin/learning/sessions/%d" % SU_, data={"csrf_token": "tok", "action": "invite_all"})
    CL.post("/admin/learning/sessions/%d" % SU_, data={"csrf_token": "tok", "action": "invite",
                                                      "registration_id": R[(E1, SU_)]})
    s.check("...once, whether sent to all again or to them alone", len(outbox(E1)) == 1 and one(
        "SELECT seq FROM lms_invites WHERE registration_id=?", (R[(E1, SU_)],)) == 0)
    s.check("logged", one("SELECT COUNT(*) FROM activity_log WHERE action='lms_invite' AND target_user_id=?", (E1,)) >= 1)

    s.section("withdrawing: a reason, the next person, the invite cancelled")
    r = C1.post("/learning/mine/%d" % R[(E1, SU_)], data={"csrf_token": "tok", "action": "withdraw", "why": "busy"})
    s.check("no reason kind: nothing happens", one("SELECT status FROM lms_registrations WHERE id=?",
                                                    (R[(E1, SU_)],)) == "approved")
    r = C1.post("/learning/mine/%d" % R[(E1, SU_)], data={"csrf_token": "tok", "action": "withdraw", "why_kind": "clash",
                                                          "why": "  "})
    s.check("no line: nothing happens", one("SELECT status FROM lms_registrations WHERE id=?",
                                             (R[(E1, SU_)],)) == "approved")
    r = C1.post("/learning/mine/%d" % R[(E1, SU_)], data={"csrf_token": "tok", "action": "withdraw", "why_kind": "clash",
                                                          "why": "ZZLA year-end stock count those days"})
    s.check("with both: withdrawn, the reason kept", one(
        "SELECT status||'/'||withdraw_kind||'/'||remark FROM lms_registrations WHERE id=?", (R[(E1, SU_)],)) ==
        "withdrawn/clash/ZZLA year-end stock count those days")
    s.check("...in the request's history for the line manager and L&D", one(
        "SELECT remark FROM lms_approvals WHERE registration_id=? AND action='withdrawn'", (R[(E1, SU_)],)) ==
        "A work clash I can't move: ZZLA year-end stock count those days")
    with a.app.app_context():
        ob = outbox(E1)
    s.check("the invite is cancelled, by email with a later sequence", one(
        "SELECT status||'/'||seq FROM lms_invites WHERE registration_id=?", (R[(E1, SU_)],)) == "cancelled/1" and
        len(ob) == 2 and "STATUS:CANCELLED" in json.loads(ob[1]["attach_json"])[0]["content"] and
        ob[1]["subject"] == "Cancelled: ZZLA Negotiation")
    s.check("the place goes to the next person waiting", one("SELECT status FROM lms_registrations WHERE id=?",
                                                             (R[(E6, SU_)],)) in ("pending", "approved"))
    pg = txt(CM.get("/learning?view=team"))
    s.check("the line manager sees who withdrew and why", "Withdrew in the last 60 days" in pg and
            "ZZLA year-end stock count those days" in pg)
    pg = txt(CL.get("/admin/learning/sessions/%d" % SU_))
    s.check("L&D sees it in the session's history", "withdrew: “A work clash I can't move: ZZLA year-end stock count "
            "those days”" in pg and "Attendees and invites" in pg)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE lms_registrations SET status='approved' WHERE id=?", (R[(E1, SU_)],))
        db.commit()
        lnd = db.execute("SELECT * FROM users WHERE id=?", (LND,)).fetchone()
        a.lms_invite_send(db, lnd, R[(E1, SU_)])
    s.check("sent again after a cancellation: the sequence moves on", one(
        "SELECT status||'/'||seq FROM lms_invites WHERE registration_id=?", (R[(E1, SU_)],)) == "sent/2")
    r = CL.post("/admin/learning/sessions/%d" % SU_, data={"csrf_token": "tok", "action": "cancel",
                                                          "registration_id": R[(E5, SU_)],
                                                          "reason": "ZZLA moved to Johor"})
    s.check("taken off by L&D: the invite cancelled", one("SELECT status FROM lms_invites WHERE registration_id=?",
                                                          (R[(E5, SU_)],)) == "cancelled")
    with a.app.app_context():
        db = a.get_db()
        su = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        a.lms_session_save(db, su, P, {"reason": "ZZLA trainer unwell"}, sid=SU_, cancel=True)
    s.check("the session cancelled: every invite cancelled", one(
        "SELECT status FROM lms_invites WHERE registration_id=?", (R[(E1, SU_)],)) == "cancelled")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE lms_sessions SET status='planned' WHERE id=?", (SU_,))
        db.execute("UPDATE lms_registrations SET status='approved' WHERE id=?", (R[(E1, SU_)],))
        db.commit()
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE lms_sessions SET starts_on=?, ends_on=? WHERE id=?", (D(0), D(0), SU_))
        db.commit()
    r = C1.post("/learning/mine/%d" % R[(E1, SU_)], data={"csrf_token": "tok", "action": "withdraw", "why_kind": "leave",
                                                          "why": "ZZLA sick"})
    s.check("never on the first day: ask L&D", one("SELECT status FROM lms_registrations WHERE id=?",
                                                  (R[(E1, SU_)],)) == "approved")
    a.mailer.is_configured = lambda: False

    s.section("absences")
    at("12:00")
    with a.app.app_context():
        db = a.get_db()
        n = a.lms_absence_scan(db)
        s.check("a confirmed place, a day over, no clock-in: an absence (both of E2's days, E4's second)",
                absences(E2)[:2] == [(D(-2), "open"), (D(-1), "open")] and absences(E4) == [(D(-1), "open")])
        s.check("...none for someone who came, or who withdrew", absences(E1) == [] and absences(E3) == [])
        s.check("...none before the day's clock-in closes (today, 12:00)", (D(0), "open") not in absences(E2))
        s.check("...never for e-learning", one("SELECT COUNT(*) FROM lms_absences WHERE registration_id=?",
                                               (R[(E2, SE)],)) == 0)
        s.check("...an older closed session from its result only", absences(E5) == [(D(-10), "open")] and
                one("SELECT COUNT(*) FROM lms_absences WHERE registration_id=?", (R[(E1, SL)],)) == 0)
        s.check("...once", a.lms_absence_scan(db) == 0 and n >= 4)
    at("17:31")
    with a.app.app_context():
        a.lms_absence_scan(a.get_db())
    s.check("today's, once its clock-in has closed", (D(0), "open") in absences(E2))
    with a.app.app_context():
        db = a.get_db()
        lnd = db.execute("SELECT * FROM users WHERE id=?", (LND,)).fetchone()
        a.lms_mark(db, lnd, SA, D(-1), E4, "ZZLA signed the T3")
    s.check("a mark-in by hand voids it", absences(E4) == [(D(-1), "void")])
    aid = one("SELECT a.id FROM lms_absences a JOIN lms_registrations r ON r.id=a.registration_id WHERE r.user_id=? "
              "AND a.on_date=?", (E2, D(-2)))
    pg = txt(C2.get("/learning"))
    s.check("the person sees it, and is asked why", "Didn't come" in pg and "Tell us why" in pg)
    s.check("...and Done says they didn't clock in, not completed", "Didn't clock in" in pg)
    r = CO_.post("/learning/absence/%d" % aid, data={"csrf_token": "tok", "action": "explain", "why": "x"})
    s.check("only their own", one("SELECT status FROM lms_absences WHERE id=?", (aid,)) == "open")
    C2.post("/learning/absence/%d" % aid, data={"csrf_token": "tok", "action": "explain", "why": ""})
    s.check("a reason, or nothing", one("SELECT status FROM lms_absences WHERE id=?", (aid,)) == "open")
    C2.post("/learning/absence/%d" % aid, data={"csrf_token": "tok", "action": "explain",
                                                "why": "ZZLA site emergency at Plant 2"})
    s.check("explained", one("SELECT status||'/'||reason FROM lms_absences WHERE id=?", (aid,)) ==
            "explained/ZZLA site emergency at Plant 2")
    aid2 = one("SELECT a.id FROM lms_absences a JOIN lms_registrations r ON r.id=a.registration_id WHERE r.user_id=? "
               "AND a.on_date=?", (E2, D(-1)))
    C2.post("/learning/absence/%d" % aid2, data={"csrf_token": "tok", "action": "explain", "was_there": "1"})
    s.check("'I was there' goes to L&D to check", one("SELECT reason FROM lms_absences WHERE id=?", (aid2,)) ==
            "I was there: please check the T3.")
    with a.app.app_context():
        s.check("two or more not excused this year: flagged", a.lms_absence_counts(a.get_db(), [E2])[E2] >= 2)
    pg = txt(CM.get("/learning?view=team"))
    s.check("the line manager sees them, the count, and why", "ZZLA site emergency at Plant 2" in pg and
            "this year</span>" in pg and "Excuse…" in pg)
    r = CO_.post("/learning/absence/%d" % aid, data={"csrf_token": "tok", "action": "excuse", "reason": "ok"})
    s.check("someone who isn't their line manager can't excuse it", one("SELECT status FROM lms_absences WHERE id=?",
                                                                        (aid,)) == "explained")
    CM.post("/learning/absence/%d" % aid, data={"csrf_token": "tok", "action": "excuse", "reason": ""})
    s.check("excusing needs a reason", one("SELECT status FROM lms_absences WHERE id=?", (aid,)) == "explained")
    CM.post("/learning/absence/%d" % aid, data={"csrf_token": "tok", "action": "excuse",
                                                "reason": "ZZLA emergency confirmed"})
    s.check("the line manager excuses it, logged", one("SELECT status||'/'||note FROM lms_absences WHERE id=?", (aid,)) ==
            "excused/ZZLA emergency confirmed" and one(
                "SELECT COUNT(*) FROM activity_log WHERE action='lms_absence' AND target_user_id=?", (E2,)) == 1)
    with a.app.app_context():
        s.check("an excused one stops counting", a.lms_absence_counts(a.get_db(), [E2])[E2] ==
                sum(1 for d, st in absences(E2) if st in ("open", "explained")))
    aid5 = one("SELECT a.id FROM lms_absences a JOIN lms_registrations r ON r.id=a.registration_id WHERE r.user_id=?",
               (E5,))
    r = CL.post("/admin/learning/sessions/%d" % SL, data={"csrf_token": "tok", "action": "excuse", "absence_id": aid5,
                                                         "reason": "ZZLA MC on file"})
    s.check("L&D excuses from the session page", one("SELECT status FROM lms_absences WHERE id=?", (aid5,)) == "excused")
    pg = txt(CL.get("/admin/learning/sessions/%d" % SA))
    s.check("the session page: each place's absences, and who has two or more this year",
            "Two or more absences this year" in pg and "ZZ LA E2" in pg)

    s.section("the dashboard's rows")
    with a.app.app_context():
        db = a.get_db()
        d2 = a.dash_learning(db, a._lms_user(db, E2))
        dm = a.dash_learning(db, a._lms_user(db, MGR))
    s.check("the person: tell us why", any(x["title"].startswith("You didn't clock in at ZZLA Negotiation") and
                                           x["url"] == "/learning?view=mine&tab=apply#absent" for x in d2["acts"]))
    s.check("the line manager: their report didn't come", any("didn't come" in x["title"] and
                                                               x["url"] == "/learning?view=team&tab=team#absent"
                                                               for x in dm["acts"]))

    s.section("the scheduler, the registry")
    with a.app.app_context():
        r = a.lms_auto(a.get_db())
    s.check("lms_auto scans for absences and says so", "absences" in r and isinstance(r["absences"], int))
    s.check("the person's route is never cycle-gated", "learning_absence" in a.MODULE_UNGATED_ENDPOINTS)
    s.check("audit labels", "lms_invite" in a.ACTION_LABELS and "lms_absence" in a.ACTION_LABELS)
    s.check("the schema text is the same in both", all(t_ in a._LMS_DDL and t_ in a.SCHEMA for t_ in (
        "CREATE TABLE IF NOT EXISTS lms_invites", "CREATE TABLE IF NOT EXISTS lms_absences", "withdraw_kind TEXT")))
    env(None)
    s.check("dark: the absence route is a 404", C2.post("/learning/absence/%d" % aid2,
                                                       data={"csrf_token": "tok", "why": "x"}).status_code == 404)
finally:
    env(_ENV0)
    a._now_myt, a._today_myt, a.mailer.is_configured = _NOW0, _TODAY0, _MAIL0
    a.ai_draft.screen_message = _SCREEN0
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
sys.exit(s.done())
