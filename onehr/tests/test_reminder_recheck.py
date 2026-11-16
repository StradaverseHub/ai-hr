"""A queued reminder is worked out again just before it goes (Chris, 2026-10-26: "re-check each queued reminder just
before it sends, drop it if nothing is pending and refresh the list if it's shorter").

Everyone's reminder is written when it is queued (08:00) and goes in waves of 200 every 30 minutes, so the last wave can
go hours later. Someone who finished in between used to get that morning's email listing what they had already done.
Now the sender asks again for each reminder it claims (_outbox_reminder_recheck): nothing waiting = not sent
('cancelled', REMINDER_NOTHING_LEFT, logged as skipped, the progress line says how many); a list that changed = the
email is written again from what waits now, with the template of the day it was queued; the same list = sent as queued.
Other emails go as they were, and a check that fails never holds a reminder back. Everything here is synthetic
(ZZRC-*) and is removed at the end.
"""
import inspect
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A queued reminder is checked again just before it sends")

KPI = {"group": "own", "role": "own", "text": "Enter your KPI results and submit", "detail": "", "closes": "",
       "url": "/review", "closes_on": None}
RATE = {"group": "f360", "role": "f360", "text": "Rate your colleagues in the 360", "detail": "", "closes": "",
        "url": "/review", "closes_on": None}


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZRC-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM notifications WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM email_outbox WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM email_outbox WHERE to_email LIKE '%@zzrc.invalid'")
    db.execute("DELETE FROM notifications WHERE to_email LIKE '%@zzrc.invalid'")
    db.execute("DELETE FROM activity_log WHERE id > ? AND action='reminder_run'", (LOG0,))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    OLD = (db.execute("SELECT id FROM cycles WHERE id!=? ORDER BY id LIMIT 1", (CID,)).fetchone() or [None])[0]
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    _cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 "
                           "LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ RC " + eid[5:], email=eid.lower() +
                 "@zzrc.invalid", hod_id=None, manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None,
                 left_at=None, is_demo=0, role="user", admin_bg=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    DONE, SHORT, SAME, LEFT, BOOM = (mk("ZZRC-" + x) for x in ("DONE", "SHORT", "SAME", "LEFT", "BOOM"))
    db.commit()
    PEOPLE = [DONE, SHORT, SAME, LEFT, BOOM]

# what waits on each, set by the suite: at queue time everyone has two things; the real reader for a leaver
WAITING = {u: [KPI, RATE] for u in PEOPLE}
RAISE = set()
_real_items, _real_kick, _real_tpl = a.reminder_items, a._outbox_kick, a.email_tpl_words


def _items(db_, u_):
    if u_["id"] in RAISE:
        raise RuntimeError("the dashboard read failed")
    if u_["left_at"]:
        return _real_items(db_, u_)
    return [dict(i) for i in WAITING.get(u_["id"], [])] if u_["id"] in WAITING else _real_items(db_, u_)


TPL_DAYS = []


def _tpl(key, day=None, db=None):
    if key == "reminder":
        TPL_DAYS.append(day)
    return _real_tpl(key, day=day, db=db)


_sent = []
_real = (a.mailer.send_mail, a.mailer.is_configured, a.mailer.get_token, a.OUTBOX_ASYNC)
a.reminder_items, a.email_tpl_words = _items, _tpl
a.mailer.is_configured = lambda: True
a.mailer.get_token = lambda: "tok"
a.mailer.send_mail = lambda to, subject, body, token=None, save_to_sent=True: _sent.append((to, subject, body))
a.OUTBOX_ASYNC = False


def row_of(uid):
    return ctx(lambda d: dict(d.execute("SELECT * FROM email_outbox WHERE user_id=? AND kind=? ORDER BY id DESC "
                                        "LIMIT 1", (uid, a.REMINDER_KIND)).fetchone() or {}))


def sent_to(uid):
    to = "zzrc-%s@zzrc.invalid" % {DONE: "done", SHORT: "short", SAME: "same", LEFT: "left", BOOM: "boom"}[uid]
    return [x for x in _sent if x[0] == to]


try:
    s.section("queued at 08:00 with two things waiting for everyone")
    a._outbox_kick = lambda flask_app=None: False     # held in the queue, as a later wave is
    people = ctx(lambda d: d.execute("SELECT * FROM users WHERE id IN (%s) ORDER BY id" % ",".join("?" * len(PEOPLE)),
                                     PEOPLE).fetchall())
    tally = ctx(lambda d: a.reminder_send(d, CYC, people, "ZZRC test run", live=True))
    a._outbox_kick = _real_kick
    s.check("all five queued, none sent yet", tally["queued"] == 5 and not _sent, tally)
    Q = {u: row_of(u) for u in PEOPLE}
    s.check("each queued email lists both things", all("Enter your KPI results" in Q[u]["body"]
                                                       and "Rate your colleagues" in Q[u]["body"] for u in PEOPLE))
    BATCH = Q[DONE]["batch"]

    # by the time their wave comes: DONE finished everything, SHORT finished the KPI check-in, SAME is unchanged,
    # LEFT has left, BOOM's re-check fails
    WAITING[DONE] = []
    WAITING[SHORT] = [RATE]
    ctx(lambda d: (d.execute("UPDATE users SET left_at=datetime('now') WHERE id=?", (LEFT,)), d.commit()))
    RAISE.add(BOOM)
    # one row queued at 17:00 UTC on 1 Nov, which is 2 Nov in MYT (the day its template is read for)
    ctx(lambda d: (d.execute("UPDATE email_outbox SET created_at='2026-11-01 17:00:00' WHERE id=?", (Q[SHORT]["id"],)),
                   d.commit()))
    # an email of another kind, for someone with nothing waiting, goes as it is
    ctx(lambda d: (a._outbox_add(d, "zz_rc_other", "zzrc-done@zzrc.invalid", "Other subject", "<p>Other body</p>",
                                 user_id=DONE, cycle_id=CID), d.commit()))
    # a reminder queued in another cycle is not sent in this one
    ctx(lambda d: (a._outbox_add(d, a.REMINDER_KIND, "zzrc-same@zzrc.invalid", "Old cycle", "<p>Old</p>",
                                 user_id=SAME, cycle_id=OLD, batch="zzrc-oldcycle"), d.commit()))
    TPL_DAYS.clear()
    ctx(lambda d: a._outbox_drain(a.app, inline=True))

    s.section("nothing waiting: not sent")
    r = row_of(DONE)
    s.check("DONE's reminder is not sent", not [x for x in sent_to(DONE) if x[1] != "Other subject"],
            [x[1] for x in sent_to(DONE)])
    s.check("...its row is 'cancelled' with the reason", r["status"] == "cancelled"
            and r["error"] == a.REMINDER_NOTHING_LEFT, (r.get("status"), r.get("error")))
    s.check("...and logged as skipped", H.one(a, "SELECT COUNT(*) FROM notifications WHERE user_id=? AND kind=? AND "
                                                 "status='skipped' AND detail=?",
                                              (DONE, a.REMINDER_KIND, a.REMINDER_NOTHING_LEFT)) == 1)
    s.check("a leaver's reminder is not sent either (the person is read again)", not sent_to(LEFT)
            and row_of(LEFT)["status"] == "cancelled")
    s.check("a reminder of another cycle is not sent", OLD is not None
            and not [x for x in sent_to(SAME) if x[1] == "Old cycle"]
            and H.one(a, "SELECT status FROM email_outbox WHERE batch='zzrc-oldcycle'") == "cancelled")
    s.check("an email of another kind goes as it was queued", [x[1:] for x in sent_to(DONE)]
            == [("Other subject", "<p>Other body</p>")], [x[1] for x in sent_to(DONE)])

    s.section("a shorter list: written again; the same list: sent as queued")
    got = sent_to(SHORT)
    s.check("SHORT gets one email", len(got) == 1, len(got))
    s.check("...listing only what still waits", got and "Rate your colleagues" in got[0][2]
            and "Enter your KPI results" not in got[0][2])
    s.check("...and the outbox row holds what was sent", got and row_of(SHORT)["body"] == got[0][2]
            and row_of(SHORT)["status"] == "sent")
    s.check("...with the template of the MYT day it was queued (17:00 UTC 1 Nov = 2 Nov)",
            a.date(2026, 11, 2) in TPL_DAYS, TPL_DAYS)
    got = sent_to(SAME)
    s.check("SAME gets its email exactly as queued", len(got) == 1 and got[0][1:] == (Q[SAME]["subject"],
                                                                                     Q[SAME]["body"]))

    s.section("a check that fails never holds a reminder back")
    got = sent_to(BOOM)
    s.check("BOOM's reminder still goes, as queued", len(got) == 1 and got[0][2] == Q[BOOM]["body"], len(got))
    s.check("...its row is sent", row_of(BOOM)["status"] == "sent")

    s.section("the super admin's progress line")
    p = ctx(lambda d: a._outbox_send(d, BATCH))
    s.check("the total leaves out the two not sent, and every one left has gone", p["total"] == 3 and p["sent"] == 3,
            (p["total"], p["sent"]))
    s.check("...and says how many and why", "2 not sent, nothing left for them to do" in p["sub"], p["sub"])
    s.check("a dropped reminder doesn't hold them out of tomorrow's (the cooldown counts what was queued or sent)",
            not ctx(lambda d: a.reminder_in_cooldown(d, DONE, CID)))
    s.section("the countdown wording (Chris, 4 Nov 2026): a row queued with the OLD subject goes out with the new words")
    TODAY = ctx(lambda d: a._today_myt())
    DATED = [dict(KPI, closes_on=TODAY + a.timedelta(days=3)), dict(RATE, closes_on=TODAY + a.timedelta(days=8))]
    WAITING[SHORT] = DATED
    OLD_TPL = dict(a.REMINDER_TPL_DEFAULT, subject=a._REMINDER_SUBJECT_BEFORE_COUNTDOWN,
                   opening=a._REMINDER_OPENING_BEFORE_COUNTDOWN)
    TPLS = ctx(lambda d: H.stash_email_templates(d))
    SETS = {k: v for k, v in ctx(lambda d: d.execute("SELECT key, value FROM app_settings WHERE key IN "
                                                      "('reminder_template','reminder_all_subject','reminder_all_opening')").fetchall())}
    ctx(lambda d: (d.execute("DELETE FROM app_settings WHERE key IN ('reminder_template','reminder_all_subject',"
                             "'reminder_all_opening')"),
                   d.execute("INSERT INTO email_templates(email, name, words, usual) VALUES ('reminder','Reminder',?,1)",
                             (json.dumps(OLD_TPL),)), d.commit()))
    # the email as it was queued under the old words
    def queued_old(d):
        u_ = d.execute("SELECT * FROM users WHERE id=?", (SHORT,)).fetchone()
        subj, body = a.reminder_mail(u_, DATED, CYC, tpl=OLD_TPL, db=d)
        a._outbox_add(d, a.REMINDER_KIND, "zzrc-short@zzrc.invalid", subj, body, user_id=SHORT, cycle_id=CID,
                      batch="zzrc-countdown")
        d.commit()
        return subj
    OLD_SUBJ = ctx(queued_old)
    s.check("queued under the old default subject", OLD_SUBJ == "Reminder: 2 things are waiting on you in AI+ OneHR", OLD_SUBJ)
    OB0 = ctx(lambda d: [tuple(r) for r in d.execute("SELECT id, subject, body, status, error FROM email_outbox ORDER BY id")])
    n = ctx(lambda d: (a._reminder_countdown_reword(d), d.commit())[0])
    OB1 = ctx(lambda d: [tuple(r) for r in d.execute("SELECT id, subject, body, status, error FROM email_outbox ORDER BY id")])
    s.check("the rewording changed the saved template (one row)", n == 1 and ctx(lambda d: a.email_tpl_words("reminder", db=d))
            ["subject"] == a._REMINDER_SUBJECT_COUNTDOWN, n)
    s.check("...and never reads or writes email_outbox: its source names no such table, and no queued row changed",
            "email_outbox" not in inspect.getsource(a._reminder_countdown_reword) and OB0 == OB1)
    rowq = ctx(lambda d: d.execute("SELECT * FROM email_outbox WHERE batch='zzrc-countdown'").fetchone()["id"])
    got = ctx(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (rowq,)).fetchone()))
    s.check("the recheck writes it again with the countdown subject, filled",
            got is not None and got["subject"] == "4 days left: 2 things you need to do in AI+ OneHR", got and got["subject"])
    s.check("...the opening says you must finish before the deadline, the old line gone", got is not None
            and "You must finish it before the deadline" in got["body"] and "worth finishing" not in got["body"])
    s.check("...no placeholder is left in the subject or the body", got is not None and "{" not in got["subject"]
            and "{days_left}" not in got["body"] and "{tasks}" not in got["body"] and "{closes}" not in got["body"]
            and "{cycle}" not in got["body"], got and got["subject"])
    s.check("...and the stored row holds it", ctx(lambda d: d.execute("SELECT subject FROM email_outbox WHERE id=?",
                                                                      (rowq,)).fetchone()[0]) == got["subject"])
finally:
    (a.mailer.send_mail, a.mailer.is_configured, a.mailer.get_token, a.OUTBOX_ASYNC) = _real
    a.reminder_items, a._outbox_kick, a.email_tpl_words = _real_items, _real_kick, _real_tpl
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        if "TPLS" in globals():   # the countdown section stashed the email templates and the reminder's older settings
            H.restore_email_templates(db, TPLS)
            db.execute("DELETE FROM app_settings WHERE key IN ('reminder_template','reminder_all_subject','reminder_all_opening')")
            for k_, v_ in SETS.items():
                db.execute("INSERT INTO app_settings(key, value) VALUES (?,?)", (k_, v_))
            db.commit()

sys.exit(s.done())
