"""AI+ Learning: clock out with the rating, and the trainer's link (Chris, 2026-10-22: "usually the training is run by
the trainer, we can do clock out together with the post training evaluation/satisfaction form. I think the room QR +
sign in is the most feasible way"; then "ok to all five, go build it on staging"; canvas boards 3C, 3D and 9B).

What this suite holds:
  * the codes: the clock-out code is its own (an in code never clocks anyone out); the in code is what it always was
  * the screen's mode: clock-in until 15 minutes before the end, then clock-out by itself, unless the trainer picked a
    mode after that; the trainer's pick from earlier today holds before then; yesterday's pick is forgotten; clock-out
    closes half an hour after the end
  * on a phone: clock-out refused while the screen shows clock-in, for an in code, and without a clock-in today; on the
    last day the rating is the clock-out (both written, or neither); other days, a walk-in, or rated already: one tap;
    the held scan is the person's own and runs out; scanned signed out, sign-in lands back on clock-out
  * the room's screen: the mode, the clock-out code and address, counts and never a name; the switch is L&D's or the
    super admin's (a BG admin's is refused)
  * the trainer's link: 404 while Learning is dark, without a key, with a wrong or an old one; counts only; shut
    outside the session's hours; its switch needs the key; made and made again by L&D only, logged
  * marking by hand and closing: a mark-in covers the day; mark out needs a reason and a clock-in; everyone out at
    once; in without out shows to settle once that day's clock-out has closed; closing counts a day with its clock-out
    on a session added since, and an older session as before; a new session asks for clock-out
Everything here is synthetic (ZZLC / ZZ9LC-) and removed at the end.
"""
import hashlib
import hmac
import html
import json
import os
import sys
import time
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: clock out with the rating, and the trainer's link")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO = "ZZLC Group", "ZZLC U1"
_ENV0 = os.environ.get("ONEHR_LMS")
_NOW0, _TODAY0, _HOLD0 = a._now_myt, a._today_myt, a.LMS_OUT_HOLD_SECONDS
_SCREEN0 = a.ai_draft.screen_message
TODAY = _TODAY0()
NOW = [datetime(TODAY.year, TODAY.month, TODAY.day, 12, 0)]


def at(hm):
    h, m = hm.split(":")
    NOW[0] = datetime(TODAY.year, TODAY.month, TODAY.day, int(h), int(m))


def D(n):
    return (TODAY + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LC-%' OR username LIKE 'zzlc-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLC %'")
    if ul:
        ph = ",".join("?" * len(ul))
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
                      "(?,?, 'x', 'user', ?,?,?, 'ZZLC Sales', 'ZZLC Officer', '15', ?, ?, '2020-01-01')",
                      (eid.lower(), "ZZ LC " + eid.split("-")[1], eid, BG, CO, mgr,
                       eid.lower() + "@example.invalid")).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    MGR = person(db, "ZZ9LC-MGR")
    E1, E2, E3, E4, E5 = (person(db, "ZZ9LC-E%d" % i, MGR) for i in range(1, 6))
    LND = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzlc-lnd', 'ZZ LC L&D', 'x', 'admin', ?)", (a.LMS_ADMIN_BG,)).lastrowid
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzlc-bga', 'ZZ LC BG admin', 'x', 'admin', ?)", (BG,)).lastrowid
    P = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, effectiveness, trainer) VALUES "
                   "('ZZLC Negotiation', 'inhouse', 'published', 14, 2, '1,3', 'ZZLC Trainer')").lastrowid

    def sess(a_, b_, needs_out=1):
        return db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, start_time, end_time, needs_out) "
                          "VALUES (?,?,?, '09:00', '17:00', ?)", (P, a_, b_, needs_out)).lastrowid
    S2 = sess(D(-1), D(0))          # yesterday and today: today is its last day
    S1 = sess(D(0), D(1))           # today and tomorrow: today is day 1 of 2
    SOLD = sess(D(-3), D(-3), None)  # an older session, before clock-out

    def reg(uid, sid):
        return db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json) VALUES "
                          "(?,?,?, 'approved', '[]')", (uid, sid, P)).lastrowid
    R = {(u_, S2): reg(u_, S2) for u_ in (E1, E2, E4, E5)}
    R[(E1, S1)] = reg(E1, S1)
    R[(E1, SOLD)] = reg(E1, SOLD)
    for u_ in (E1, E2, E4):   # yesterday, day 1 of S2: in and out
        db.execute("INSERT INTO lms_attendance(session_id, on_date, user_id, method, out_at, out_method) VALUES "
                   "(?,?,?, 'qr', datetime('now'), 'qr')", (S2, D(-1), u_))
    db.execute("INSERT INTO lms_attendance(session_id, on_date, user_id, method) VALUES (?,?,?, 'qr')", (SOLD, D(-3), E1))
    db.commit()
    for sid in (S2, S1, SOLD):
        a._lms_qr_secret(db, sid)
    SEC = {sid: db.execute("SELECT qr_secret FROM lms_sessions WHERE id=?", (sid,)).fetchone()[0] for sid in (S2, S1)}


def one(sql, args=()):
    return H.one(a, sql, args)


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


def code(sid, kind="in"):
    with a.app.app_context():
        return a.lms_code_now(a.get_db(), sid, kind)[0]


def att(uid, sid, day=None):
    with a.app.app_context():
        r = a.get_db().execute("SELECT * FROM lms_attendance WHERE session_id=? AND on_date=? AND user_id=?",
                               (sid, day or D(0), uid)).fetchone()
        return dict(r) if r else None


def rated(uid, sid):
    return one("SELECT COUNT(*) FROM lms_ratings WHERE registration_id=?", (R[(uid, sid)],))


def hold_of(html):
    import re
    m = re.search(r'name="hold" value="([^"]+)"', html)
    return m.group(1) if m else None


ANS = {"relevant": "5", "clear": "4", "apply": "5", "overall": "5", "comment": "ZZLC the role-play helped"}

try:
    env("1")
    a._now_myt = lambda: NOW[0]
    a.ai_draft.screen_message = lambda m: None   # the comment screen is a model call; not this suite's subject
    a._today_myt = lambda: NOW[0].date()
    CS, CL, CB = H.client_as(a, SU["id"]), H.client_as(a, LND), H.client_as(a, BGA)
    C1, C2, C3, C4, C5 = (H.client_as(a, x) for x in (E1, E2, E3, E4, E5))

    s.section("the codes")
    w = int(time.time()) // a.LMS_QR_SECONDS
    s.check("the in code is what it always was (an HMAC of 'session:window')",
            a._lms_code(SEC[S2], S2, w) == "%06d" % (int(hmac.new(SEC[S2].encode(), ("%d:%d" % (S2, w)).encode(),
                                                                  hashlib.sha256).hexdigest()[:12], 16) % 1000000))
    s.check("the clock-out code is its own", a._lms_code(SEC[S2], S2, w, "out") != a._lms_code(SEC[S2], S2, w))
    with a.app.app_context():
        db = a.get_db()
        s.check("an in code is no clock-out code, and the other way round",
                not a.lms_code_ok(db, S2, code(S2), "out") and not a.lms_code_ok(db, S2, code(S2, "out"))
                and a.lms_code_ok(db, S2, code(S2, "out"), "out") and a.lms_code_ok(db, S2, code(S2)))

    s.section("the screen's mode")
    T = lambda hm: datetime(TODAY.year, TODAY.month, TODAY.day, int(hm[:2]), int(hm[3:]))   # noqa: E731
    base = {"end_time": "17:00", "screen_mode": None, "screen_mode_at": None}
    sm = a.lms_screen_mode
    s.check("clock-in until 15 minutes before the end, then clock-out by itself",
            (sm(base, T("12:00")), sm(base, T("16:44")), sm(base, T("16:45"))) == ("in", "in", "out"))
    pick = lambda m, hm, day=TODAY: dict(base, screen_mode=m, screen_mode_at="%s %s:00" % (day.isoformat(), hm))  # noqa
    s.check("the trainer's clock-out from earlier today holds", sm(pick("out", "11:00"), T("12:00")) == "out")
    s.check("the trainer's clock-in after the auto time holds (someone came late)",
            sm(pick("in", "16:50"), T("16:55")) == "in")
    s.check("...but a clock-in picked before it gives way to the auto switch", sm(pick("in", "10:00"), T("16:50")) == "out")
    s.check("yesterday's pick is forgotten", sm(pick("out", "11:00", TODAY - timedelta(days=1)), T("12:00")) == "in")
    s2row = {"starts_on": D(0), "ends_on": D(0), "start_time": "09:00", "end_time": "17:00", "screen_mode": "out",
             "screen_mode_at": "%s 12:00:00" % D(0)}
    s.check("clock-out closes half an hour after the end",
            a.lms_checkout_window(s2row, T("17:29"))[1] and not a.lms_checkout_window(s2row, T("17:31"))[1])

    s.section("on a phone: the last day's rating is the clock-out")
    at("12:00")
    r = C1.get("/learning/in/%d?c=%s" % (S2, code(S2)))
    s.check("E1 clocks in from the room's QR", r.status_code == 200 and att(E1, S2) is not None)
    r = C1.get("/learning/out/%d?c=%s" % (S2, code(S2, "out")))
    s.check("clock-out is refused while the screen shows clock-in",
            "Clock-out for this session isn't open now." in html.unescape(r.get_data(as_text=True)) and not att(E1, S2)["out_at"])
    r = CB.post("/admin/learning/sessions/%d/screen" % S2, data={"csrf_token": "tok", "mode": "out"})
    s.check("a BG admin can't switch the screen", r.status_code == 403)
    r = CL.post("/admin/learning/sessions/%d/screen" % S2, data={"csrf_token": "tok", "mode": "out"})
    s.check("L&D switches it to clock-out", r.status_code == 200 and r.get_json()["mode"] == "out")
    r = C1.get("/learning/out/%d?c=%s" % (S2, code(S2)))
    s.check("an in code doesn't clock out", "That code has changed" in html.unescape(r.get_data(as_text=True)) and not att(E1, S2)["out_at"])
    r = C4.get("/learning/out/%d?c=%s" % (S2, code(S2, "out")))
    s.check("no clock-in today: told to clock in first", "You haven't clocked in today" in html.unescape(r.get_data(as_text=True))
            and att(E4, S2) is None)
    r = C1.get("/learning/out/%d?c=%s" % (S2, code(S2, "out")))
    pg = html.unescape(r.get_data(as_text=True))
    hold = hold_of(pg)
    s.check("the last day, confirmed, not rated: the rating, held", r.status_code == 200 and 'name="relevant"' in pg and
            "Send and clock out" in pg and hold and not att(E1, S2)["out_at"])
    r = C1.post("/learning/out/%d" % S2, data=dict(ANS, csrf_token="tok", hold=hold, overall=""))
    s.check("an answer missing: neither the rating nor the clock-out is written, and the form stays",
            "Answer each question, 1 to 5." in html.unescape(r.get_data(as_text=True)) and not att(E1, S2)["out_at"] and
            rated(E1, S2) == 0 and hold_of(html.unescape(r.get_data(as_text=True))) == hold)
    r = C2.post("/learning/out/%d" % S2, data=dict(ANS, csrf_token="tok", hold=hold))
    s.check("someone else's held scan does nothing", "has run out" in html.unescape(r.get_data(as_text=True)) and
            rated(E2, S2) == 0 and rated(E1, S2) == 0)
    r = C1.post("/learning/out/%d" % S2, data=dict(ANS, csrf_token="tok", hold=hold[:-3] + "xyz"))
    s.check("a tampered one does nothing", "has run out" in html.unescape(r.get_data(as_text=True)) and rated(E1, S2) == 0)
    a.LMS_OUT_HOLD_SECONDS = -1
    r = C1.post("/learning/out/%d" % S2, data=dict(ANS, csrf_token="tok", hold=hold))
    a.LMS_OUT_HOLD_SECONDS = _HOLD0
    s.check("a run-out one does nothing", "has run out" in html.unescape(r.get_data(as_text=True)) and rated(E1, S2) == 0)
    r = C1.post("/learning/out/%d" % S2, data=dict(ANS, csrf_token="tok", hold=hold))
    pg = html.unescape(r.get_data(as_text=True))
    s.check("sent: the rating and the clock-out, together", "You're out. Thank you." in pg and rated(E1, S2) == 1 and
            att(E1, S2)["out_at"] and att(E1, S2)["out_method"] == "qr", __import__("re").findall(r'ck-msg[^>]*>([^<]*)|<b>([^<]*)</b>', pg)[:4])
    s.check("...the rating as given", one("SELECT overall||'/'||clear||'/'||comment FROM lms_ratings WHERE "
                                          "registration_id=?", (R[(E1, S2)],)) == "5/4/ZZLC the role-play helped")
    s.check("...and what comes next", "Your hours and XP count when L&D closes the session" in pg and
            "In one month:" in pg)
    r = C1.get("/learning/out/%d?c=%s" % (S2, code(S2, "out")))
    s.check("a second scan: already out", "You're already clocked out for today." in html.unescape(r.get_data(as_text=True)))

    s.section("on a phone: one tap")
    C3.get("/learning/in/%d?c=%s" % (S2, code(S2)))
    r = C3.get("/learning/out/%d?c=%s" % (S2, code(S2, "out")))
    pg = html.unescape(r.get_data(as_text=True))
    s.check("a walk-in not confirmed: one tap, no form", att(E3, S2) and 'name="relevant"' not in pg and
            "Clock out · 12:00" in pg)
    r = C3.post("/learning/out/%d" % S2, data={"csrf_token": "tok", "hold": hold_of(pg)})
    s.check("...out, nothing rated", att(E3, S2)["out_at"] and
            one("SELECT COUNT(*) FROM lms_ratings t JOIN lms_registrations r ON r.id=t.registration_id WHERE "
                "r.user_id=?", (E3,)) == 0)
    with a.app.app_context():
        a.lms_set_screen_mode(a.get_db(), S1, "out")
    C1.get("/learning/in/%d?c=%s" % (S1, code(S1)))
    r = C1.get("/learning/out/%d?c=%s" % (S1, code(S1, "out")))
    pg = html.unescape(r.get_data(as_text=True))
    s.check("day 1 of 2: one tap, the rating comes on the last day", 'name="relevant"' not in pg and
            "The rating comes at the end of day 2" in pg)
    r = C1.post("/learning/out/%d" % S1, data={"csrf_token": "tok", "hold": hold_of(pg)})
    pg = html.unescape(r.get_data(as_text=True))
    s.check("...out for today", "You're out for today." in pg and att(E1, S1)["out_at"] and "See you on day 2" in pg)

    s.section("scanned signed out")
    C0 = a.app.test_client()
    r = C0.get("/learning/out/%d?c=%s" % (S2, code(S2, "out")))
    ck = [c_ for c_ in r.headers.getlist("Set-Cookie") if c_.startswith("lms_ci=")]
    s.check("a good clock-out scan signed out: to sign-in, held in the cookie", r.status_code == 302 and
            "/login" in r.headers["Location"] and ck)
    raw = ck[0].split(";")[0].split("=", 1)[1]
    with a.app.test_request_context(headers={"Cookie": "lms_ci=" + raw}):
        u5 = a.get_db().execute("SELECT * FROM users WHERE id=?", (E5,)).fetchone()
        land = a._landing_for(u5)
        s.check("sign-in lands back on clock-out", land == "/learning/out/%d?pre=1" % S2 and
                a._lms_pending_checkin() is None, land)
    with a.app.test_request_context(headers={"Cookie": "lms_ci=" + a._lms_ci_signer().dumps({"s": S2})}):
        s.check("...and a clock-in scan still lands on clock-in", a._lms_pending_checkin() == S2 and
                a._lms_pending_checkin("out") is None)

    s.section("the room's screen")
    r = CL.get("/admin/learning/sessions/%d/qr.json" % S2)
    d = r.get_json()
    s.check("it shows clock-out, its code and address", d["mode"] == "out" and d["code"] == code(S2, "out") and
            d["path"] == "/learning/out/%d" % S2 and d["last"] is True and "<svg" in d["svg"])
    s.check("...with counts: in today, out", d["in"] == 2 and d["out"] == 2, (d["in"], d["out"]))
    s.check("...and never a name", "ZZ LC" not in json.dumps(d))
    pg = CL.get("/admin/learning/sessions/%d/screen" % S2).get_data(as_text=True)
    s.check("the page has the switch", 'data-mode="out"' in pg and 'data-mode="in"' in pg and "ZZ LC E" not in pg)

    s.section("the trainer's link")
    C0 = a.app.test_client()
    with C0.session_transaction() as ss:
        ss["csrf_token"] = "tok"
    s.check("no link made yet: 404", C0.get("/learning/room/%d?k=" % S2).status_code == 404)
    r = CB.post("/admin/learning/sessions/%d" % S2, data={"csrf_token": "tok", "action": "room_key"})
    s.check("a BG admin can't make it", r.status_code == 403 and not one("SELECT room_key FROM lms_sessions WHERE id=?", (S2,)))
    pg = html.unescape(CL.get("/admin/learning/sessions/%d" % S2).get_data(as_text=True))
    s.check("the session page offers it", "The trainer's link" in pg and "Make the trainer's link" in pg and
            "(ZZLC Trainer)" in pg)
    r = CL.post("/admin/learning/sessions/%d" % S2, data={"csrf_token": "tok", "action": "room_key"})
    K1 = one("SELECT room_key FROM lms_sessions WHERE id=?", (S2,))
    s.check("L&D makes it, logged", r.status_code == 302 and K1 and len(K1) >= 20 and
            one("SELECT COUNT(*) FROM activity_log WHERE user_id=? AND action='lms_session' AND detail=?",
                (LND, "Session %d: made the trainer's link" % S2)) == 1)
    pg = html.unescape(CL.get("/admin/learning/sessions/%d" % S2).get_data(as_text=True))
    s.check("...and shows it to copy", ("/learning/room/%d?k=%s" % (S2, K1)) in pg and "Copy the link" in pg)
    r = C0.get("/learning/room/%d?k=%s" % (S2, K1))
    pg = html.unescape(r.get_data(as_text=True))
    s.check("signed out, with the key: the room's screen, its switch, no names", r.status_code == 200 and
            'data-mode="out"' in pg and "ZZ LC" not in pg and "For the trainer" in pg)
    s.check("a wrong key or none: 404", C0.get("/learning/room/%d?k=%s" % (S2, K1[:-2] + "zz")).status_code == 404
            and C0.get("/learning/room/%d" % S2).status_code == 404)
    d = C0.get("/learning/room/%d/qr.json?k=%s" % (S2, K1)).get_json()
    s.check("its refresh: the clock-out code and counts, never a name", d["mode"] == "out" and
            d["code"] == code(S2, "out") and "ZZ LC" not in json.dumps(d))
    r = C0.post("/learning/room/%d/mode" % S2, data={"csrf_token": "tok", "mode": "in", "k": K1})
    s.check("the trainer switches back to clock-in", r.status_code == 200 and r.get_json()["mode"] == "in")
    s.check("...not without the key", C0.post("/learning/room/%d/mode" % S2,
                                              data={"csrf_token": "tok", "mode": "out"}).status_code == 404)
    at("07:00")
    d = C0.get("/learning/room/%d/qr.json?k=%s" % (S2, K1)).get_json()
    s.check("before the session's hours: shut, no code", d == {"closed": True, "open": False})
    s.check("...and no switch", C0.post("/learning/room/%d/mode" % S2,
                                        data={"csrf_token": "tok", "mode": "out", "k": K1}).status_code == 404)
    at("12:00")
    CL.post("/admin/learning/sessions/%d" % S2, data={"csrf_token": "tok", "action": "room_key", "renew": "1"})
    K2 = one("SELECT room_key FROM lms_sessions WHERE id=?", (S2,))
    s.check("a new link stops the old one", K2 != K1 and C0.get("/learning/room/%d?k=%s" % (S2, K1)).status_code == 404
            and C0.get("/learning/room/%d?k=%s" % (S2, K2)).status_code == 200 and
            one("SELECT COUNT(*) FROM activity_log WHERE user_id=? AND action='lms_session' AND detail=?",
                (LND, "Session %d: made a new trainer's link (the old one stopped)" % S2)) == 1)
    env(None)
    s.check("while Learning is dark: 404, signed out too", C0.get("/learning/room/%d?k=%s" % (S2, K2)).status_code == 404
            and C0.get("/learning/room/%d/qr.json?k=%s" % (S2, K2)).status_code == 404
            and C1.get("/learning/out/%d" % S2).status_code == 404)
    env("1")

    s.section("marking by hand, and closing")
    with a.app.app_context():
        db = a.get_db()
        lnd = db.execute("SELECT * FROM users WHERE id=?", (LND,)).fetchone()
        ok, _m = a.lms_mark(db, lnd, S2, D(0), E4, "ZZLC signed the T3")
        x = att(E4, S2)
        s.check("a mark-in by hand covers the day, its clock-out too", ok and x["method"] == "manual" and
                x["out_at"] and x["out_method"] == "manual" and x["out_reason"] == "ZZLC signed the T3")
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO lms_attendance(session_id, on_date, user_id, method) VALUES (?,?,?, 'qr')", (S2, D(0), E2))
        db.execute("INSERT INTO lms_attendance(session_id, on_date, user_id, method) VALUES (?,?,?, 'qr')", (S2, D(0), E5))
        db.commit()
        sh = a.lms_day_sheet(db, S2, D(0))
        s.check("in without out isn't to settle while clock-out is open", not [m for m in sh["mismatch"]
                                                                              if m["kind"] == "in_no_out"])
    at("17:45")
    with a.app.app_context():
        sh = a.lms_day_sheet(a.get_db(), S2, D(0))
    s.check("...and is once it has closed", sorted(m["uid"] for m in sh["mismatch"] if m["kind"] == "in_no_out")
            == sorted([E2, E5]) and sh["n_out"] == 3, sh["n_out"])
    pg = html.unescape(CL.get("/admin/learning/sessions/%d?day=%s" % (S2, D(0))).get_data(as_text=True))
    s.check("the page lists them, with Mark out and Mark all 2 out", "clocked in but didn't clock out" in pg and
            'value="mark_out"' in pg and "Mark all 2 out" in pg and "Clocked out" in pg)
    r = CL.post("/admin/learning/sessions/%d" % S2, data={"csrf_token": "tok", "action": "close", "day": D(0)})
    s.check("closing counts a day with its clock-out: E2 and E5 came part of it", r.status_code == 302 and
            [one("SELECT outcome||'/'||hours FROM lms_registrations WHERE id=?", (R[(u_, S2)],)) for u_ in (E1, E2, E4, E5)]
            == ["attended/14.0", "partial/7.0", "attended/14.0", "absent/0.0"],
            [one("SELECT outcome||'/'||hours FROM lms_registrations WHERE id=?", (R[(u_, S2)],)) for u_ in (E1, E2, E4, E5)])
    with a.app.app_context():
        db = a.get_db()
        lnd = db.execute("SELECT * FROM users WHERE id=?", (LND,)).fetchone()
        s.check("mark out needs a reason", a.lms_mark_out(db, lnd, S2, D(0), [E2], "  ")[0] is False and
                not att(E2, S2)["out_at"])
        s.check("...and a clock-in that day", a.lms_mark_out(db, lnd, S2, D(0), [E3 + 999], "ZZLC left early")[0] is False)
    r = CL.post("/admin/learning/sessions/%d" % S2, data={"csrf_token": "tok", "action": "mark_out", "user_id": E2,
                                                         "day": D(0), "reason": "ZZLC left early with leave"})
    s.check("mark out with a reason, logged", r.status_code == 302 and att(E2, S2)["out_method"] == "manual" and
            att(E2, S2)["out_reason"] == "ZZLC left early with leave" and
            one("SELECT COUNT(*) FROM activity_log WHERE action='lms_attendance' AND target_user_id=? AND detail LIKE "
                "'%marked out by hand%'", (E2,)) == 1)
    r = CL.post("/admin/learning/sessions/%d" % S2, data={"csrf_token": "tok", "action": "mark_all_out", "day": D(0),
                                                         "reason": "ZZLC the clock-out screen wasn't shown"})
    s.check("everyone still in, out at once", att(E5, S2)["out_at"] and att(E5, S2)["out_method"] == "manual")
    CL.post("/admin/learning/sessions/%d" % S2, data={"csrf_token": "tok", "action": "close", "day": D(0)})
    s.check("closing again recounts", one("SELECT outcome FROM lms_registrations WHERE id=?", (R[(E2, S2)],)) == "attended")
    with a.app.app_context():
        db = a.get_db()
        su = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        a.lms_close_session(db, su, SOLD)
        s.check("an older session counts its clock-ins as before", one("SELECT outcome FROM lms_registrations WHERE "
                                                                        "id=?", (R[(E1, SOLD)],)) == "attended")
        xp = a.lms_xp(db, [E1])[E1]
        s.check("the room's rating earns its XP once closed", any(("rating", a.LMS_XP_RATE) in r_["parts"]
                                                                   for r_ in xp["rows"]))
        ok, _m = a.lms_session_save(db, su, P, {"starts_on": D(30), "ends_on": D(30)})
        s.check("a session added now asks for clock-out", ok and one("SELECT needs_out FROM lms_sessions WHERE "
                                                                     "programme_id=? ORDER BY id DESC LIMIT 1", (P,)) == 1)

    s.section("the registry")
    s.check("the new staff routes are never cycle-gated", {"learning_checkout", "learning_room", "learning_room_qr",
                                                           "learning_room_mode"} <= a.MODULE_UNGATED_ENDPOINTS)
    s.check("the screen's switch is Learning's own write ('lms')", a.ADMIN_ACCESS_MAP.get("admin_learning_screen") == "lms")
    import inspect
    s.check("clock-out is open to someone still on their first sign-in",
            "learning_checkout" in inspect.getsource(a._onboarding_gate))
    s.check("the audit label says in or out", a.ACTION_LABELS["lms_attendance"] ==
            "Marked someone in or out at a session by hand")
    s.check("the schema text has the new columns, the same in both", all(c_ in a._LMS_DDL and c_ in a.SCHEMA for c_ in (
        "out_at TEXT", "out_reason TEXT", "room_key TEXT", "needs_out INTEGER")))
finally:
    env(_ENV0)
    a._now_myt, a._today_myt, a.LMS_OUT_HOLD_SECONDS = _NOW0, _TODAY0, _HOLD0
    a.ai_draft.screen_message = _SCREEN0
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
sys.exit(s.done())
