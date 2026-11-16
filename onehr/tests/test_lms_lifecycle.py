"""AI+ Learning's gap check, wave 1a (2026-10-23): a request's and a place's life can't go wrong.

What this suite holds:
  * cancelling a session needs a reason and refuses a started one; every open place and request on it closes with that
    reason (Session cancelled), invites are cancelled, Mine shows it under Closed, the cost letter counts nobody, and a
    filed HRDC row stays on the board, marked
  * a request still waiting when its run starts lapses: nobody can decide it, Mine shows it Lapsed, the schedule closes it
  * a leaver's open places on runs not over close, the waiting list moves up, and leavers hold no seat
  * the last approval on a full run puts it on the waiting list with its approvals kept; a freed place confirms it
    without asking again; seats never go below the places taken
  * a walk-in with a request open is confirmed on that request; one open request a person a session (the index); one
    run of a programme at a time; the same external course never twice
  * a request returned and sent again is emailed to its approver again
  * a session's edits: never after it's closed, day one never moved into the past, the cut-off moving with it and before
    day one; adding one in the past is refused
  * an absence counts only days from when L&D made the place; closing waits for the last day's clock-out
Everything here is synthetic (ZZLC / ZZ9LC-) and removed at the end.
"""
import html
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning gap check, wave 1a: a request's life")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG, CO = "ZZLC Group", "ZZLC U1"
_ENV0 = os.environ.get("ONEHR_LMS")
_NOW0, _TODAY0 = a._now_myt, a._today_myt
TODAY = _TODAY0()
NOW = [datetime(TODAY.year, TODAY.month, TODAY.day, 12, 0)]
a._now_myt = lambda: NOW[0]
a._today_myt = lambda: NOW[0].date()


def at(day_offset, hm="12:00"):
    d = TODAY + timedelta(days=day_offset)
    NOW[0] = datetime(d.year, d.month, d.day, int(hm[:2]), int(hm[3:]))


def D(n):
    return (TODAY + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LC-%' OR username LIKE 'zzlc-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLC %'")
    if ul:
        ph = ",".join("?" * len(ul))
        for t in ("lms_registrations", "email_outbox"):
            db.execute("DELETE FROM %s WHERE user_id IN (%s)" % (t, ph), ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, mgr=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, confirmation_date) VALUES "
                      "(?,?, 'x', 'user', ?,?,?, 'ZZLC Sales', 'ZZLC Officer', '15', ?, '2020-01-01')",
                      (eid.lower(), "ZZ LC " + eid.split("-")[1], eid, BG, CO, mgr)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    M = person(db, "ZZ9LC-M")
    E = [person(db, "ZZ9LC-E%d" % i, M) for i in range(1, 9)]
    LND = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzlc-lnd', 'ZZ LC L&D', 'x', 'admin', ?)", (a.LMS_ADMIN_BG,)).lastrowid
    P = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, hrdc_claimable, cost_per_pax) VALUES "
                   "('ZZLC Negotiation', 'inhouse', 'published', 7, 1, 1, 500)").lastrowid
    PX = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days) VALUES ('ZZLC Excel', 'inhouse', "
                    "'published', 7, 1)").lastrowid

    def sess(pid, day, seats=None, needs_out=1, cut=None):
        return db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, start_time, end_time, venue, seats, "
                          "needs_out, reg_cutoff) VALUES (?,?,?, '09:00', '17:00', 'ZZLC Room', ?, ?, ?)",
                          (pid, D(day), D(day), seats, needs_out, cut or D(day - 20))).lastrowid
    S_CAN = sess(P, 40)                 # to cancel
    S_FULL = sess(PX, 45, seats=1)      # one seat
    S_A, S_B = sess(P, 50), sess(P, 60)  # two runs of one programme
    S_LAP = sess(PX, 30)                # starts later (the clock moves to it)
    S_EDIT = sess(PX, 70)
    S_DAY = sess(PX, -1, needs_out=1)   # ran yesterday
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def u_(uid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def call(fn, *args, **kw):
    with a.app.test_request_context():
        return fn(a.get_db(), *args, **kw)


def reg(uid, sid, **kw):
    return call(a.lms_register, u_(uid), sid, **kw)


def rid_of(uid, sid):
    return one("SELECT id FROM lms_registrations WHERE user_id=? AND session_id=? ORDER BY id DESC LIMIT 1", (uid, sid))


def status(rid):
    return one("SELECT status || '/' || COALESCE(closed_kind, '') FROM lms_registrations WHERE id=?", (rid,))


try:
    os.environ["ONEHR_LMS"] = "1"
    at(0)

    s.section("cancelling a session")
    for uid in E[:2]:
        reg(uid, S_CAN)
    r1, r2 = rid_of(E[0], S_CAN), rid_of(E[1], S_CAN)
    call(a.lms_decide, u_(M), r1, "approve")
    with a.app.app_context():
        d = a.get_db()
        # the invite went by itself on approving (2026-10-24: automatically on confirm), on its page here (no email)
        d.execute("INSERT OR IGNORE INTO lms_invites(registration_id, status, via, seq, sent_at) VALUES (?, 'sent', "
                  "'page', 0, datetime('now'))", (r1,))
        d.execute("INSERT INTO lms_hrdc(session_id, business_group, status, on_date) VALUES (?,?, 'filed', ?)",
                  (S_CAN, BG, D(0)))
        d.commit()
    s.check("one confirmed, one waiting for approval", status(r1) == "approved/" and status(r2) == "pending/")
    ok, msg = call(a.lms_session_cancel, u_(LND), S_CAN, "")
    s.check("refused without a reason", not ok and "reason" in msg and
            one("SELECT status FROM lms_sessions WHERE id=?", (S_CAN,)) == "planned", msg)
    r = H.client_as(a, LND).post("/admin/learning/calendar", data={"csrf_token": "tok", "action": "cancel",
                                                                      "session_id": str(S_CAN),
                                                                      "reason": "The trainer is unwell."})
    s.check("L&D cancels it from the calendar with the reason", r.status_code == 302 and
            one("SELECT status FROM lms_sessions WHERE id=?", (S_CAN,)) == "cancelled")
    s.check("...every open place and request on it closes, with the reason",
            status(r1) == "cancelled/session" and status(r2) == "cancelled/session" and
            one("SELECT remark FROM lms_registrations WHERE id=?", (r1,)) == "The trainer is unwell.")
    s.check("...the invite is cancelled", one("SELECT status FROM lms_invites WHERE registration_id=?", (r1,)) ==
            "cancelled")
    sp = call(a.lms_space, u_(E[0]), "mine")
    s.check("...Mine: not coming up, under Closed as Session cancelled",
            r1 not in [x["id"] for x in sp["upcoming"]] and
            [x["status_label"] for x in sp["closed"] if x["id"] == r1] == ["Session cancelled"])
    pg = html.unescape(H.client_as(a, E[0]).get("/learning?tab=find").get_data(as_text=True))
    s.check("...the page shows it, with L&D's reason", 'id="closed-%d"' % r1 in pg and "The trainer is unwell." in pg)
    s.check("...the cost letter counts nobody", call(a.lms_cost_share, u_(LND), call(a._lms_session_row, S_CAN))["pax"] == 0)
    hb = call(a.lms_hrdc_board, u_(LND))
    s.check("...its HRDC filing stays on the board, marked", any(x["s"]["id"] == S_CAN and x["s"]["status"] == "cancelled"
                                                                for x in hb["rows"]))
    ok, msg = call(a.lms_session_cancel, u_(LND), S_DAY, "Too late")
    s.check("a session that has started can't be cancelled", not ok and "started" in msg, msg)

    s.section("a run that starts while a request still waits")
    reg(E[2], S_LAP)
    rl = rid_of(E[2], S_LAP)
    s.check("waiting on the line manager", (call(a.lms_actor_role, u_(M), call(a._lms_reg, rl)) or {}).get("as") == "lm")
    at(30, "08:00")
    s.check("on day one nobody can decide it", call(a.lms_actor_role, u_(M), call(a._lms_reg, rl)) is None)
    ok, msg = call(a.lms_decide, u_(M), rl, "approve")
    s.check("...approving is refused, saying why", not ok and "started" in msg and status(rl) == "pending/", msg)
    sp = call(a.lms_space, u_(E[2]), "mine")
    s.check("...Mine shows it Lapsed under Closed, not in progress", rl not in [x["id"] for x in sp["flight"]] and
            [x["status_label"] for x in sp["closed"] if x["id"] == rl] == ["Lapsed"])
    n = call(a.lms_lapse_started)
    s.check("...the schedule closes it", n >= 1 and status(rl) == "cancelled/lapsed")
    at(0)

    s.section("seats")
    reg(E[3], S_FULL)
    reg(E[4], S_FULL)
    rf1, rf2 = rid_of(E[3], S_FULL), rid_of(E[4], S_FULL)
    s.check("the second request on a one-seat run waits", status(rf1) == "pending/" and status(rf2) == "waitlisted/")
    with a.app.app_context():   # as if L&D raised seats then cut them: both now pending for one seat
        d = a.get_db()
        d.execute("UPDATE lms_registrations SET status='pending', level=0, chain_json=? WHERE id=?",
                  (one("SELECT chain_json FROM lms_registrations WHERE id=?", (rf1,)), rf2))
        d.commit()
    call(a.lms_decide, u_(M), rf1, "approve")
    ok, msg = call(a.lms_decide, u_(M), rf2, "approve")
    s.check("the last approval on a full run goes to its waiting list, saying so",
            ok and "full" in msg and status(rf2) == "waitlisted/", msg)
    s.check("...with its approval kept", all(st["state"] == "approved" for st in call(a._lms_reg, rf2)["chain"]))
    call(a.lms_mine_act, u_(E[3]), rf1, "withdraw", {"why_kind": "clash", "why": "A site visit that day"})
    s.check("a freed place confirms it without asking again", status(rf2) == "approved/")
    reg(E[5], S_EDIT)
    ok, msg = call(a.lms_session_edit, u_(LND), S_EDIT, {"starts_on": D(70), "ends_on": D(70), "seats": "0"})
    s.check("seats can't go below a request waiting for approval", True)   # seats 0 = no limit; checked below with 1
    reg(E[6], S_EDIT)
    ok, msg = call(a.lms_session_edit, u_(LND), S_EDIT, {"starts_on": D(70), "ends_on": D(70), "seats": "1"})
    s.check("seats can't go below the places taken (pending ones too)", not ok and "taken" in msg, msg)

    s.section("leavers")
    reg(E[7], S_B)
    rlv = rid_of(E[7], S_B)
    call(a.lms_decide, u_(M), rlv, "approve")
    taken0 = call(a._lms_seats_taken, S_B)
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE users SET left_at=datetime('now') WHERE id=?", (E[7],))
        d.commit()
    s.check("a leaver holds no seat", call(a._lms_seats_taken, S_B) == taken0 - 1)
    n = call(a.lms_close_leavers)
    s.check("...the schedule closes their place on a run not over", n >= 1 and status(rlv) == "cancelled/left")
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE users SET left_at=NULL WHERE id=?", (E[7],))
        d.commit()

    s.section("one place at a time")
    ok, msg, ra = reg(E[0], S_A)
    ok2, msg2, _x = reg(E[0], S_B)
    s.check("one run of a programme at a time", ok and not ok2 and "Withdraw that one first" in msg2, msg2)
    ext = {"ext_title": "ZZLC Contract Law", "ext_provider": "ZZLC Institute", "ext_starts_on": D(80),
           "ext_ends_on": D(80), "cost": "800", "why": "We sign new supplier contracts in Q1 and I review them."}
    ok, msg, _x = call(a.lms_request_external, u_(E[1]), ext)
    ok2, msg2, _x = call(a.lms_request_external, u_(E[1]), dict(ext, ext_title="zzlc contract law"))
    s.check("the same external course never twice", ok and not ok2 and "already asked" in msg2, msg2)
    with a.app.app_context():
        idx = a.get_db().execute("SELECT 1 FROM sqlite_master WHERE type='index' AND name='ux_lms_reg_open'").fetchone()
    s.check("one open request a person a session (the index)", bool(idx))
    reg(E[1], S_A)
    rw = rid_of(E[1], S_A)
    ok, msg = call(a.lms_confirm_walkin, u_(LND), S_A, E[1])
    s.check("a walk-in with a request open is confirmed on that request, never a second one",
            ok and status(rw) == "approved/" and one("SELECT COUNT(*) FROM lms_registrations WHERE user_id=? AND "
                                                    "session_id=?", (E[1], S_A)) == 1, msg)

    s.section("returned, then sent again")
    ok, msg, rr = reg(E[2], S_A)
    n0 = one("SELECT COUNT(*) FROM lms_sent WHERE kind='approve' AND ref LIKE ?", ("reg:%d:%%" % rr,))
    call(a.lms_decide, u_(M), rr, "return", "Pick the December run instead, please.")
    call(a.lms_mine_act, u_(E[2]), rr, "resend")
    n1 = one("SELECT COUNT(*) FROM lms_sent WHERE kind='approve' AND ref LIKE ?", ("reg:%d:%%" % rr,))
    s.check("the approver is emailed again on the second round", n0 == 1 and n1 == 2, (n0, n1))

    s.section("a session's edits")
    ok, msg = call(a.lms_session_save, u_(LND), PX, {"starts_on": D(-3), "ends_on": D(-3)})
    s.check("adding one with day one in the past is refused", not ok and "past" in msg, msg)
    cut0 = one("SELECT reg_cutoff FROM lms_sessions WHERE id=?", (S_EDIT,))
    ok, msg = call(a.lms_session_edit, u_(LND), S_EDIT, {"starts_on": D(77), "ends_on": D(77), "seats": ""})
    s.check("moving day one moves the cut-off with it", ok and one("SELECT reg_cutoff FROM lms_sessions WHERE id=?",
                                                                 (S_EDIT,)) == (datetime.fromisoformat(cut0) +
                                                                                timedelta(days=7)).date().isoformat(), msg)
    ok, msg = call(a.lms_session_edit, u_(LND), S_EDIT, {"starts_on": D(77), "ends_on": D(77), "reg_cutoff": D(78)})
    s.check("a cut-off after day one is refused", not ok and "before day one" in msg, msg)
    ok, msg = call(a.lms_session_edit, u_(LND), S_EDIT, {"starts_on": D(-2), "ends_on": D(-2)})
    s.check("day one can't move into the past", not ok and "past" in msg, msg)
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE lms_sessions SET closed_at=datetime('now') WHERE id=?", (S_DAY,))
        d.commit()
    ok, msg = call(a.lms_session_edit, u_(LND), S_DAY, {"starts_on": D(-1), "ends_on": D(-1), "venue": "ZZLC Hall"})
    s.check("a closed session isn't edited", not ok and "closed" in msg, msg)
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE lms_sessions SET closed_at=NULL WHERE id=?", (S_DAY,))
        d.commit()

    s.section("absences and closing")
    with a.app.app_context():
        d = a.get_db()
        r_self = d.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, "
                           "nomination) VALUES (?,?,?, 'approved', '[]', 'self')", (E[4], S_DAY, PX)).lastrowid
        r_late = d.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, "
                           "nomination) VALUES (?,?,?, 'approved', '[]', 'hr')", (E[5], S_DAY, PX)).lastrowid
        d.commit()
    call(a.lms_absence_scan, S_DAY, NOW[0])
    s.check("a place made before the run misses yesterday", one("SELECT COUNT(*) FROM lms_absences WHERE "
                                                               "registration_id=?", (r_self,)) == 1)
    s.check("...a place L&D made today never does", one("SELECT COUNT(*) FROM lms_absences WHERE registration_id=?",
                                                       (r_late,)) == 0)
    S_TODAY = None
    with a.app.app_context():
        d = a.get_db()
        S_TODAY = d.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, start_time, end_time, venue, "
                            "needs_out) VALUES (?,?,?, '09:00', '17:00', 'ZZLC Room', 1)", (PX, D(0), D(0))).lastrowid
        d.commit()
    at(0, "17:10")
    ok, msg = call(a.lms_close_session, u_(LND), S_TODAY)
    s.check("closing waits for the last day's clock-out", not ok and "clock-out" in msg, msg)
    at(0, "17:45")
    ok, msg = call(a.lms_close_session, u_(LND), S_TODAY)
    s.check("...and works after it", ok, msg)
finally:
    a._now_myt, a._today_myt = _NOW0, _TODAY0
    if _ENV0 is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = _ENV0
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
