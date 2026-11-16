"""AI+ Learning: the gap check's parked items (2026-10-24; Chris: "complete the rest").

What this suite holds:
  * the calendar invite's UID carries this server's own address, so staging's and production's never share one
  * the cost-sharing letter counts each place at its own cost, and says so when they differ
  * L&D cancels a scheduled announcement before it goes: its queued emails cancelled, nobody's dashboard row, not
    once its time has come, logged; a BG admin can't
  * who replies to HRDC's queries is L&D's list on Settings (the first the default; empty puts the default back)
  * the trainer's email two days before carries the room link, made by OneHR when L&D hasn't, for a run's own trainer too
  * Settings > Emails' preview shows L&D's own subject and opening line
  * the coach and the L&D agent keep only the months OneHR gave them, as they keep only its numbers
Everything here is synthetic (ZZPK) and removed at the end; changed settings are put back.
"""
import html
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: the gap check's parked items")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG = "ZZPK Group"
_ENV0 = {k: os.environ.get(k) for k in ("ONEHR_LMS", "APP_BASE_URL")}
_MAIL0 = a.mailer.is_configured
TODAY = a._today_myt()


def D(n):
    return (TODAY + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE username LIKE 'zzpk-%'")]
    aids = [r[0] for r in db.execute("SELECT a.id FROM lms_announcements a JOIN lms_programmes p ON "
                                     "p.id=a.programme_id WHERE p.title LIKE 'ZZPK %'")]
    for aid in aids:
        db.execute("DELETE FROM email_outbox WHERE batch=?", ("lms-announce-%d" % aid,))
        db.execute("DELETE FROM lms_sent WHERE ref=?", ("ann:%d" % aid,))
    db.execute("DELETE FROM email_outbox WHERE subject LIKE '%ZZPK%' OR to_email LIKE 'zzpk-%'")
    sids = [r[0] for r in db.execute("SELECT s.id FROM lms_sessions s JOIN lms_programmes p ON p.id=s.programme_id "
                                     "WHERE p.title LIKE 'ZZPK %'")]
    for sid in sids:
        db.execute("DELETE FROM lms_sent WHERE ref=?", ("sess:%d" % sid,))
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZPK %'")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM lms_registrations WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE user_id IS NULL AND detail LIKE '%the trainer''s link made by OneHR%' "
               "AND detail LIKE 'Session %'")
    db.commit()


def _setting(db, key):
    r = db.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
    return r[0] if r else None


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    _OWN0 = _setting(db, "lms_hrdc_owners")
    _ES0 = db.execute("SELECT * FROM lms_email_settings WHERE kind='approve'").fetchone()
    _ES0 = dict(_ES0) if _ES0 else None
    LND = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzpk-lnd', 'ZZ PK L&D', 'x', 'admin', ?)", (a.LMS_ADMIN_BG,)).lastrowid
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzpk-bga', 'ZZ PK BG admin', 'x', 'admin', ?)", (BG,)).lastrowid
    E = [db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                    "job_grade, confirmation_date, email) VALUES (?,?, 'x', 'user', ?, ?, 'ZZPK U1', '14', '2020-01-01', ?)",
                    ("zzpk-e%d" % i, "ZZ PK E%d" % i, "ZZ9PK-E%d" % i, BG if i < 3 else "ZZPK Other",
                     "zzpk-e%d@example.invalid" % i)).lastrowid for i in range(4)]
    P = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, cost_per_pax, hrdc_claimable, trainer, "
                   "trainer_email) VALUES ('ZZPK Negotiation', 'inhouse', 'published', 7, 1, 1600, 1, NULL, NULL)").lastrowid
    S1 = db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, seats, status) VALUES "
                    "(?, 'ZZPK run', ?, ?, 20, 'planned')", (P, D(2), D(2))).lastrowid
    # three places: two at the programme's cost (one with no cost of its own), one agreed at RM 1,200
    for uid, cost in ((E[0], 1600), (E[1], None), (E[2], 1200), (E[3], 1600)):
        db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, cost, "
                   "hrdc_claimable) VALUES (?,?,?, 'approved', '[]', ?, 1)", (uid, S1, P, cost))
    db.commit()


def u_(uid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def dbcall(fn, *args, **kw):
    with a.app.test_request_context():
        return fn(a.get_db(), *args, **kw)


def body(r):
    return html.unescape(r.get_data(as_text=True))


def one(sql, args=()):
    return H.one(a, sql, args)


try:
    os.environ["ONEHR_LMS"] = "1"
    CL, CB = H.client_as(a, LND), H.client_as(a, BGA)

    s.section("the invite's UID")
    with a.app.test_request_context():
        reg = a.get_db().execute("SELECT * FROM lms_registrations WHERE user_id=? AND session_id=?", (E[0], S1)).fetchone()
        os.environ["APP_BASE_URL"] = "https://staging.example.com"
        ics_stg = a.lms_ics(a.get_db(), reg)
        os.environ["APP_BASE_URL"] = "http://127.0.0.1:5001"
        ics_loc = a.lms_ics(a.get_db(), reg)
    s.check("staging's invite carries staging's address", "UID:onehr-lms-%d-0@staging.example.com" % reg["id"]
            in ics_stg)
    s.check("...a local one production's", "UID:onehr-lms-%d-0@example.com" % reg["id"] in ics_loc)

    s.section("the cost-sharing letter")
    with a.app.test_request_context():
        cs = a.lms_cost_share(a.get_db(), u_(LND), a._lms_session_row(a.get_db(), S1))
    rows = {r["bg"]: r for r in cs["rows"]}
    s.check("each place at its own cost: 1,600 + 1,600 (none of its own) + 1,200", rows[BG]["cost"] == 4400 and
            rows[BG]["pax"] == 3, rows.get(BG))
    s.check("...the total too, and it says the costs differ", cs["total"] == 6000 and cs["varies"] is True)
    lt = body(CL.get("/admin/learning/sessions/%d/costletter" % S1))
    s.check("the letter says each place is at its own cost", "each place at its own cost" in lt and "4,400.00" in lt)

    s.section("cancelling a scheduled announcement")
    a.mailer.is_configured = lambda: True
    pk = {"all": False, "bg": [BG], "bu": [], "dept": [], "grade": [], "jf": []}
    later = (datetime.utcnow() + timedelta(hours=8) + timedelta(days=2)).strftime("%Y-%m-%d") + " 09:00"
    with a.app.test_request_context():
        db = a.get_db()
        db.execute("DELETE FROM lms_registrations WHERE session_id=?", (S1,))
        db.commit()
        ok, _m, AID = a.lms_announce_send(db, u_(LND), P, pk, "ZZPK Later", "ZZPK the message", send_at=later)
        ok2, _m, AID2 = a.lms_announce_send(db, u_(LND), P, dict(pk, bg=["ZZPK Other"]), "ZZPK Now", "ZZPK the message")
    s.check("two announcements: one for later, one now", ok and ok2 and one(
        "SELECT COUNT(*) FROM email_outbox WHERE batch=? AND status='queued'", ("lms-announce-%d" % AID,)) == 3)
    pg = body(CL.get("/admin/learning/announce?pid=%d" % P))
    s.check("Sent before: the later one says when it goes, with Cancel", "Goes " in pg and "Cancel…" in pg)
    CB.post("/admin/learning/announce", data={"csrf_token": "tok", "programme_id": P, "action": "cancel",
                                              "announcement_id": AID})
    s.check("a BG admin can't cancel it", one("SELECT cancelled_at FROM lms_announcements WHERE id=?", (AID,)) is None)
    s.check("...nor by the function itself", dbcall(a.lms_announce_cancel, u_(BGA), AID)[0] is False)
    CL.post("/admin/learning/announce", data={"csrf_token": "tok", "programme_id": P, "action": "cancel",
                                              "announcement_id": AID2})
    s.check("one already gone can't be cancelled", one("SELECT cancelled_at FROM lms_announcements WHERE id=?",
                                                       (AID2,)) is None)
    CL.post("/admin/learning/announce", data={"csrf_token": "tok", "programme_id": P, "action": "cancel",
                                              "announcement_id": AID})
    s.check("L&D cancels the later one: its queued emails cancelled", one(
        "SELECT cancelled_at FROM lms_announcements WHERE id=?", (AID,)) is not None and one(
        "SELECT COUNT(*) FROM email_outbox WHERE batch=? AND status='queued'", ("lms-announce-%d" % AID,)) == 0 and one(
        "SELECT COUNT(*) FROM email_outbox WHERE batch=? AND status='cancelled'", ("lms-announce-%d" % AID,)) == 3)
    s.check("...logged", one("SELECT COUNT(*) FROM activity_log WHERE user_id=? AND action='lms_announce' AND detail "
                             "LIKE '%cancelled before it went%'", (LND,)) == 1)
    s.check("...once only", dbcall(a.lms_announce_cancel, u_(LND), AID)[0] is False)
    with a.app.test_request_context():
        db = a.get_db()
        db.execute("UPDATE lms_announcements SET send_at=datetime('now', '-1 minute') WHERE id=?", (AID,))
        db.commit()
        acts0 = (a.dash_learning(db, u_(E[0])) or {}).get("acts", [])
        acts3 = (a.dash_learning(db, u_(E[3])) or {}).get("acts", [])
    s.check("nobody's dashboard shows a cancelled one, the sent one does", not any(
        "ZZPK Negotiation" in x.get("title", "") for x in acts0) and any("ZZPK Negotiation" in x.get("title", "")
                                                                         for x in acts3))
    sends = dbcall(a._outbox_send, "lms-announce-%d" % AID)
    s.check("the sending bar doesn't count the cancelled emails", sends["total"] == 0 and not sends["live"])
    s.check("Sent before says it was cancelled", "Cancelled " in body(CL.get("/admin/learning/announce?pid=%d" % P)))
    a.mailer.is_configured = _MAIL0

    s.section("who replies to HRDC's queries")

    def owners(c, text):
        return c.post("/admin/learning/settings", data={"csrf_token": "tok", "action": "hrdc_owners", "owners": text})
    owners(CB, "ZZPK Someone")
    s.check("a BG admin can't change the list", "ZZPK Someone" not in dbcall(lambda db: a.lms_hrdc_owners()) and
            dbcall(a.lms_hrdc_owners_set, u_(BGA), "ZZPK Someone")[0] is False)
    owners(CL, "ZZPK Group People L&D\nZZPK Apex Training\n\nzzpk apex training\nZZPK BG People Partner")
    got = dbcall(lambda db: a.lms_hrdc_owners())
    s.check("L&D's list, one a line, no repeats", got == ("ZZPK Group People L&D", "ZZPK Apex Training",
                                                          "ZZPK BG People Partner"), got)
    s.check("Settings shows it", "ZZPK Apex Training" in body(CL.get("/admin/learning/settings")))
    owners(CL, "\n".join("ZZPK %d" % i for i in range(9)))
    s.check("...up to 8", dbcall(lambda db: a.lms_hrdc_owners())[0] == "ZZPK Group People L&D")
    with a.app.test_request_context():
        db = a.get_db()
        db.execute("INSERT OR REPLACE INTO lms_hrdc(session_id, business_group, status) VALUES (?,?, 'filed')", (S1, BG))
        db.commit()
        ok, _m = a.lms_hrdc_query_add(db, u_(LND), S1, BG, {"about": "ZZPK the trainer's CV", "owner": "ZZPK Apex Training",
                                                             "opened_on": D(0)})
        ow = db.execute("SELECT owner FROM lms_hrdc_queries WHERE session_id=?", (S1,)).fetchone()
    s.check("a query takes an owner from L&D's list", ok and ow and ow[0] == "ZZPK Apex Training")
    owners(CL, "")
    s.check("empty puts the default back", dbcall(lambda db: a.lms_hrdc_owners()) == a.LMS_HRDC_OWNERS)

    s.section("the trainer's room link")
    with a.app.test_request_context():
        db = a.get_db()
        db.execute("UPDATE lms_sessions SET trainer_email_s='zzpk-trainer@example.invalid', room_key=NULL WHERE id=?",
                   (S1,))
        db.commit()
    a.mailer.is_configured = lambda: True
    with a.app.test_request_context():
        a.lms_mail_due(a.get_db())
    a.mailer.is_configured = _MAIL0
    key = one("SELECT room_key FROM lms_sessions WHERE id=?", (S1,))
    mail = one("SELECT body FROM email_outbox WHERE to_email='zzpk-trainer@example.invalid' ORDER BY id DESC LIMIT 1")
    s.check("two days before, OneHR makes the link for a run's own trainer and emails it", bool(key) and mail and
            ("/learning/room/%d?k=%s" % (S1, key)) in html.unescape(mail))
    s.check("...logged as OneHR's", one("SELECT COUNT(*) FROM activity_log WHERE user_id IS NULL AND detail=?",
                                        ("Session %d: the trainer's link made by OneHR for the trainer's email" % S1,)) == 1)

    s.section("the email preview")
    with a.app.test_request_context():
        db = a.get_db()
        db.execute("INSERT INTO lms_email_settings(kind, enabled, subject, intro) VALUES ('approve', 1, ?, ?) ON "
                   "CONFLICT(kind) DO UPDATE SET subject=excluded.subject, intro=excluded.intro",
                   ("ZZPK To approve: {programme}", "ZZPK Hello from Group People L&D."))
        db.commit()
    pv = body(CL.get("/admin/learning/emails/approve/preview"))
    s.check("Settings > Emails' preview shows L&D's subject and opening line", "ZZPK To approve: Negotiation for Margin"
            in pv and "ZZPK Hello from Group People L&D." in pv)

    s.section("the coach keeps only the months OneHR gave it")
    g = a._lms_coach_grounded
    facts = "today 2026-10-24; the run: 2026-11-05 to 2026-11-06, Room 2"
    s.check("a month OneHR gave it stays", g("Your run is on 5 Nov.", facts) == "Your run is on 5 Nov.")
    s.check("...one it didn't give is replaced", g("Your run is on 5 March.", facts) == a._LMS_COACH_FALLBACK)
    s.check("...\"you may\" isn't a month", g("You may register now.", facts) == "You may register now.")
    s.check("...and numbers as before", g("It has 12 seats.", facts) == a._LMS_COACH_FALLBACK)
finally:
    a.mailer.is_configured = _MAIL0
    for k, v in _ENV0.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM app_settings WHERE key='lms_hrdc_owners'")
        if _OWN0 is not None:
            db.execute("INSERT INTO app_settings(key, value) VALUES ('lms_hrdc_owners', ?)", (_OWN0,))
        db.execute("DELETE FROM lms_email_settings WHERE kind='approve'")
        if _ES0:
            db.execute("INSERT INTO lms_email_settings(%s) VALUES (%s)" % (",".join(_ES0), ",".join("?" * len(_ES0))),
                       list(_ES0.values()))
        _cleanup(db)

sys.exit(s.done())
