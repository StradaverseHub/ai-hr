"""AI+ Learning: the calendar invite as an Outlook meeting request, sent when a place is confirmed (2026-10-24). Chris:
"now it requires user to download the calendar instead of automatically send them a calendar invite, is there any way
we can do it?"; his picks: a real meeting request, automatically on confirm.

What this suite holds:
  * the mailer: a meeting request is MIME (multipart/alternative, the calendar its own text/calendar part with its
    method), sent through Graph's MIME send with the same Mail.Send; the outbox sends it where the row carries one, and
    every other email exactly as before
  * the meeting: one event a place (one UID), the run's days as a daily repeat, OneHR's sender the organiser, the
    person the one attendee with no reply asked, a later sequence to update, CANCEL to remove; lines folded at 75 octets
  * the invite goes by itself when a place is confirmed (the chain's last step), by OneHR, once; not for e-learning or a
    run already started; on a server with no email it's ready on the person's page; the scheduler's sweep sends any
    missed, once
  * a change of venue sends the update; the person's page and L&D's say so
Everything here is synthetic (ZZIA) and removed at the end.
"""
import base64
import email
import html
import json
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: the calendar invite as a meeting request, sent on confirming")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG = "ZZIA Group"
_ENV0 = {k: os.environ.get(k) for k in ("ONEHR_LMS", "APP_BASE_URL")}
_MAIL0, _SENDER0 = a.mailer.is_configured, a.mailer.sender_address
TODAY = a._today_myt()


def D(n):
    return (TODAY + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE username LIKE 'zzia-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZIA %'")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM email_outbox WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM lms_sent WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM lms_registrations WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    LND = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzia-lnd', 'ZZ IA L&D', 'x', 'admin', ?)", (a.LMS_ADMIN_BG,)).lastrowid
    E = [db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                    "job_grade, confirmation_date, email) VALUES (?,?, 'x', 'user', ?, ?, 'ZZIA U1', '14', '2020-01-01', ?)",
                    ("zzia-e%d" % i, "ZZ IA Tan, E%d" % i, "ZZ9IA-E%d" % i, BG, "zzia-e%d@example.invalid" % i)).lastrowid
         for i in range(6)]

    def prog(title, kind="inhouse"):
        return db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days) VALUES (?, ?, 'published', 14, 2)",
                          (title, kind)).lastrowid

    def sess(pid, start, end, venue="ZZIA Room 2, Level 3; MCH"):
        return db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, start_time, end_time, "
                          "venue, seats, status) VALUES (?, 'ZZIA run', ?, ?, '09:00', '17:00', ?, 20, 'planned')",
                          (pid, start, end, venue)).lastrowid
    P, PE = prog("ZZIA Negotiation for Margin"), prog("ZZIA Excel Online", "elearning")
    S2 = sess(P, D(20), D(21))           # two days
    S1 = sess(P, D(30), D(30))           # one day
    SE = sess(PE, D(20), D(34))          # e-learning
    SP = sess(P, D(-1), D(0))            # started yesterday

    def reg(uid, sid, pid, status="pending"):
        return db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, level) "
                          "VALUES (?,?,?,?, ?, 0)", (uid, sid, pid, status, json.dumps(
                              [{"role": "lm", "days": 3, "state": "approved"}]))).lastrowid
    R1, R2, RE, RP = reg(E[0], S2, P), reg(E[1], S1, P), reg(E[2], SE, PE), reg(E[3], SP, P)
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def u_(uid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def confirm(rid):
    """The chain's last step, as every way of confirming a place ends (lms_decide, a nomination, the waiting list)."""
    with a.app.test_request_context():
        db = a.get_db()
        reg = a._lms_reg(db, rid)
        st = a._lms_advance(db, rid, reg["chain"])
        db.commit()
        return st


def outbox(uid):
    with a.app.app_context():
        return [dict(r) for r in a.get_db().execute("SELECT * FROM email_outbox WHERE user_id=? ORDER BY id", (uid,))]


try:
    os.environ["ONEHR_LMS"] = "1"
    os.environ["APP_BASE_URL"] = "https://staging.example.com"
    a.mailer.sender_address = lambda: "group.people@example.invalid"

    s.section("the mailer: a meeting request")
    mime = a.mailer.meeting_mime("e@example.invalid", "Calendar invite: X", "<p>hi</p>",
                                 "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n", "REQUEST")
    m = email.message_from_bytes(mime)
    parts = [p for p in m.walk() if not p.is_multipart()]
    cal = next((p for p in parts if p.get_content_type() == "text/calendar"), None)
    s.check("multipart/alternative: the email and the calendar as its own part, with its method",
            m.get_content_type() == "multipart/alternative" and [p.get_content_type() for p in parts] ==
            ["text/html", "text/calendar"] and cal.get_param("method") == "REQUEST" and
            m["Content-Class"] == "urn:content-classes:calendarmessage" and m["From"] == "group.people@example.invalid")
    s.check("...the calendar part is the file, whole", "METHOD:REQUEST" in cal.get_payload(decode=True).decode())
    sent = []
    _http0 = a.mailer._http_json
    a.mailer._http_json = lambda url, data=None, method=None, headers=None: sent.append((url, data, headers))
    a.mailer.send_meeting("e@example.invalid", "S", "<p>b</p>", "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", "CANCEL",
                          token="t")
    a.mailer._http_json = _http0
    url, data, hdr = sent[0]
    s.check("sent through Graph's MIME send: sendMail, text/plain, the MIME base64",
            url.endswith("/sendMail") and hdr["Content-Type"] == "text/plain" and
            b"method=\"CANCEL\"" in base64.b64decode(data))
    calls = []
    _sm0, _sme0 = a.mailer.send_mail, a.mailer.send_meeting
    a.mailer.send_mail = lambda *ar, **kw: calls.append(("mail", ar, kw))
    a.mailer.send_meeting = lambda *ar, **kw: calls.append(("meeting", ar, kw))
    a._outbox_send_row({"to_email": "x", "subject": "s", "body": "b", "attach_json": None}, "t")
    a._outbox_send_row({"to_email": "x", "subject": "s", "body": "b", "attach_json": json.dumps(
        [{"meeting": "REQUEST", "content": "ICS"}])}, "t")
    a._outbox_send_row({"to_email": "x", "subject": "s", "body": "b", "attach_json": json.dumps(
        [{"name": "c.pdf", "content_b64": "eA=="}])}, "t")
    a.mailer.send_mail, a.mailer.send_meeting = _sm0, _sme0
    s.check("the outbox: a meeting row as a meeting, every other email exactly as before",
            [c[0] for c in calls] == ["mail", "meeting", "mail"] and calls[1][1] == ("x", "s", "b", "ICS", "REQUEST")
            and calls[0][2] == {"token": "t"} and calls[2][2]["attachments"][0]["name"] == "c.pdf")

    s.section("the meeting")
    with a.app.test_request_context():
        db = a.get_db()
        r1, p0 = a._lms_reg(db, R1), u_(E[0])
        req, upd, can = (a.lms_ics_meeting(db, r1, "REQUEST", 0, p0), a.lms_ics_meeting(db, r1, "REQUEST", 1, p0),
                         a.lms_ics_meeting(db, r1, "CANCEL", 2, p0))
        one_day = a.lms_ics_meeting(db, a._lms_reg(db, R2), "REQUEST", 0, u_(E[1]))
    uid = "UID:onehr-lms-%d@staging.example.com" % R1
    s.check("one event a place: its UID, METHOD:REQUEST, sequence 0", req.count("BEGIN:VEVENT") == 1 and uid in req
            and "METHOD:REQUEST" in req and "SEQUENCE:0" in req)
    s.check("...the run's two days as a daily repeat from day one, 09:00-17:00 MYT",
            "RRULE:FREQ=DAILY;COUNT=2" in req and "DTSTART:%sT010000Z" % D(20).replace("-", "") in req and
            "DTEND:%sT090000Z" % D(20).replace("-", "") in req and "RRULE" not in one_day)
    s.check("...organised by OneHR's sender, the person its one attendee, no reply asked",
            "ORGANIZER;CN=Group People L&D:mailto:group.people@example.invalid" in req and
            "RSVP=FALSE:mailto:zzia-e0@example.invalid" in req.replace("\r\n ", "") and req.count("ATTENDEE") == 1)
    s.check("...its venue and the person's name escaped (a comma, a semicolon)",
            "LOCATION:ZZIA Room 2\\, Level 3\\; MCH" in req and "CN=ZZ IA Tan\\, E0" in req.replace("\r\n ", ""))
    s.check("an update: the same UID, a later sequence; a cancellation: removed",
            uid in upd and "SEQUENCE:1" in upd and uid in can and "METHOD:CANCEL" in can and "STATUS:CANCELLED" in can)
    s.check("every line at most 75 octets", all(len(x.encode()) <= 75 for x in req.split("\r\n")))
    s.check("...its notes say declining isn't withdrawing, and where to withdraw (Chris: \"tell them in the invite\")",
            "Declining this in Outlook doesn't free your place. Can't come? Withdraw in AI+ Learning with your reason" in
            req.replace("\r\n ", ""))

    s.section("sent when a place is confirmed")
    a.mailer.is_configured = lambda: True
    s.check("the chain's last step confirms the place", confirm(R1) == "approved")
    ob = outbox(E[0])
    inv = [o for o in ob if o["subject"] == "Calendar invite: ZZIA Negotiation for Margin"]
    s.check("...and its invite goes by itself: an Outlook meeting request, by OneHR",
            len(inv) == 1 and json.loads(inv[0]["attach_json"])[0]["meeting"] == "REQUEST" and
            "It's in your Outlook calendar now." in html.unescape(inv[0]["body"]) and
            "Declining this in Outlook doesn't free your place." in html.unescape(inv[0]["body"]) and
            one("SELECT status||'/'||via||'/'||COALESCE(sent_by, 'OneHR') FROM lms_invites WHERE registration_id=?",
                (R1,)) == "sent/email/OneHR")
    s.check("...logged as OneHR's", one("SELECT COUNT(*) FROM activity_log WHERE action='lms_invite' AND user_id IS NULL "
                                        "AND target_user_id=? AND detail LIKE '%sent by OneHR on confirming%'",
                                        (E[0],)) == 1)
    s.check("...the confirmed email says it comes by itself", any(
        "goes into your Outlook calendar" in html.unescape(o["body"]) for o in ob if o["subject"] ==
        "Your place is confirmed"))
    with a.app.test_request_context():
        s.check("...once", a._lms_invite_auto(a.get_db(), R1) is False and len(outbox(E[0])) == len(ob))
    confirm(RE)
    confirm(RP)
    s.check("not for e-learning, nor a run already started", not one(
        "SELECT COUNT(*) FROM lms_invites WHERE registration_id IN (?,?)", (RE, RP)))
    a.mailer.is_configured = lambda: False
    confirm(R2)
    s.check("no email on this server: ready on the person's page", one(
        "SELECT status||'/'||via FROM lms_invites WHERE registration_id=?", (R2,)) == "sent/page" and not [
        o for o in outbox(E[1]) if o["subject"].startswith("Calendar invite")])

    s.section("the scheduler's sweep, and an update")
    a.mailer.is_configured = lambda: True
    with a.app.test_request_context():
        db = a.get_db()
        R4 = db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, level) "
                        "VALUES (?,?,?, 'approved', '[]', 0)", (E[4], S1, P)).lastrowid
        db.commit()
        n1 = a.lms_invites_auto(db)
        n2 = a.lms_invites_auto(db)
    s.check("a confirmed place it missed gets its invite from the sweep, once", n1 >= 1 and n2 == 0 and one(
        "SELECT via FROM lms_invites WHERE registration_id=?", (R4,)) == "email")
    with a.app.test_request_context():
        db = a.get_db()
        R5 = db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, level) "
                        "VALUES (?,?,?, 'approved', '[]', 0)", (E[5], S1, P)).lastrowid
        db.commit()
        out = a.lms_auto(db)
    s.check("...the scheduler's own run does it (every 15 minutes where the server sends email)",
            out and out.get("invites", 0) >= 1 and one("SELECT via FROM lms_invites WHERE registration_id=?", (R5,)) ==
            "email")
    with a.app.test_request_context():
        db = a.get_db()
        s_ = dict(a._lms_session_row(db, S2))
        form = {k: s_[k] or "" for k in ("starts_on", "ends_on", "start_time", "end_time", "seats", "reg_cutoff",
                                         "run_label")}
        form["venue"] = "ZZIA Room 5"
        ok, msg = a.lms_session_edit(db, u_(LND), S2, form)
    upd = [o for o in outbox(E[0]) if o["subject"] == "Updated: ZZIA Negotiation for Margin"]
    s.check("a change of venue sends the update: the same meeting, sequence 1, the new venue",
            ok and len(upd) == 1 and "SEQUENCE:1" in json.loads(upd[0]["attach_json"])[0]["content"] and
            "LOCATION:ZZIA Room 5" in json.loads(upd[0]["attach_json"])[0]["content"], msg)

    s.section("the pages say so")
    pg = html.unescape(H.client_as(a, E[0]).get("/learning?view=mine").get_data(as_text=True))
    s.check("the person's page: in their Outlook calendar, no file to add", "In your Outlook calendar" in pg)
    sp = html.unescape(H.client_as(a, LND).get("/admin/learning/sessions/%d" % S2).get_data(as_text=True))
    s.check("L&D's session page: it goes by itself when a place is confirmed",
            "The calendar invite goes by itself when a place is confirmed" in sp)
finally:
    a.mailer.is_configured, a.mailer.sender_address = _MAIL0, _SENDER0
    for k, v in _ENV0.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
