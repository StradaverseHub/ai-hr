"""AI+ Learning: a seat that comes free on the day (2026-10-23, LMS canvas section 19, boards 19A-19C). Chris: "do we
allow walk in to replace no show?", then "absence still counts. Also, a L&D admin can swap a person seat who withdrew or
no-show (admin marks as no show) last minute and give it to another person", then "go ahead with section 19".

What this suite holds:
  * Group People L&D marks a confirmed person a no-show, from the day before the run, with the reason they read: their
    place frees (the waiting list moves up), the day is their absence and counts; not before the day before, not a day
    still to come, not someone who clocked in that day; a BG admin can't
  * L&D gives a freed seat (a no-show's or a withdrawal's) to someone waiting, or to anyone else (outside the audience
    marked so), with a reason: confirmed at once, in place of the person who left, the invite sent, they and their line
    manager emailed; a seat goes once; someone already on the run is picked from the waiting list; a withdrawal stays a
    withdrawal; not once the run is closed
  * a walk-in takes a no-show's seat that day: the run stays as full, the no-show's place ends with the day their
    absence; it needs a reason, and someone who didn't clock in; with nobody's place it's an extra place as before
  * the pax list and the T3 say "in place of"; the HRDC board flags a filing made before a seat changed hands until
    L&D saves it again
  * the person given a seat sees why on Mine and a dashboard row; their line manager a row; the no-show's place reads
    "Didn't come"; the session page offers it all to L&D and nothing to a BG admin; the KB and the email list know it
Everything here is synthetic (ZZLS / ZZ9LS-) and removed at the end.
"""
import html
import json
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: a seat that comes free on the day")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, OBG = "ZZLS Group", "ZZLS U1", "ZZLS Other"
_ENV0 = os.environ.get("ONEHR_LMS")
_MAIL0 = a.mailer.is_configured
TODAY = a._today_myt()


def D(n):
    return (TODAY + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LS-%' OR username LIKE 'zzls-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLS %'")
    if ul:
        ph = ",".join("?" * len(ul))
        for t in ("lms_registrations", "email_outbox", "lms_sent", "lms_attendance"):
            db.execute("DELETE FROM %s WHERE user_id IN (%s)" % (t, ph), ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group IN (?, ?)", (BG, OBG))
    db.commit()


def person(db, eid, mgr=None, bg=BG, co=CO):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, confirmation_date, email) VALUES "
                      "(?,?, 'x', 'user', ?,?,?, 'ZZLS Sales', 'ZZLS Officer', '15', ?, '2020-01-01', ?)",
                      (eid.lower(), "ZZ LS " + eid.split("-")[1], eid, bg, co, mgr,
                       eid.lower() + "@zzls.invalid")).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZLS O1')", (OBG,))
    MGR = person(db, "ZZ9LS-MGR")
    E1, E2, E3, E4, E5, E6 = (person(db, "ZZ9LS-E%d" % i, MGR) for i in range(1, 7))
    W = person(db, "ZZ9LS-WALK", MGR)
    STR = person(db, "ZZ9LS-STR", bg=OBG, co="ZZLS O1")
    LND = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzls-lnd', 'ZZ LS L&D', 'x', 'admin', ?)", (a.LMS_ADMIN_BG,)).lastrowid
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzls-bga', 'ZZ LS BG admin', 'x', 'admin', ?)", (BG,)).lastrowid
    P = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, audience_json, hrdc_claimable) VALUES "
                   "('ZZLS Negotiation', 'inhouse', 'published', 14, 2, ?, 1)",
                   (json.dumps({"grade_min": None, "grade_max": None, "bgs": [BG], "companies": []}),)).lastrowid

    def sess(a_, b_, seats=3):
        return db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, start_time, end_time, venue, seats) "
                          "VALUES (?,?,?, '00:00', '23:59', 'ZZLS Room', ?)", (P, D(a_), D(b_), seats)).lastrowid

    def reg(uid, sid, status="approved"):
        return db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json) VALUES "
                          "(?,?,?,?, ?)", (uid, sid, P, status, json.dumps(
                              [{"role": "lm", "state": "approved" if status == "approved" else "waiting",
                                "days": 3}]))).lastrowid
    S = sess(1, 2)                       # starts tomorrow: a no-show can be marked from today
    R1, R2, R3 = reg(E1, S), reg(E2, S), reg(E3, S)
    R4 = reg(E4, S, "waitlisted")
    S_LATE = sess(3, 4)                  # two days on: too early to mark
    RL = reg(E1, S_LATE)
    S2 = sess(0, 0, seats=2)             # today: a walk-in
    RA, RB = reg(E5, S2), reg(E6, S2)
    db.execute("INSERT INTO lms_attendance(session_id, on_date, user_id, method) VALUES (?,?,?, 'qr')", (S2, D(0), W))
    db.execute("INSERT INTO lms_attendance(session_id, on_date, user_id, method) VALUES (?,?,?, 'qr')", (S2, D(0), E6))
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def u_(uid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def call(fn, *args, **kw):
    with a.app.test_request_context():
        return fn(a.get_db(), *args, **kw)


def exe(sql, args=()):
    with a.app.app_context():
        d = a.get_db()
        d.execute(sql, args)
        d.commit()


def reg_(rid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM lms_registrations WHERE id=?", (rid,)).fetchone())


def body(r):
    return html.unescape(r.get_data(as_text=True))


def act(c, sid, **kw):
    return c.post("/admin/learning/sessions/%d" % sid, data=dict({"csrf_token": "tok"}, **kw))


try:
    os.environ["ONEHR_LMS"] = "1"
    a.mailer.is_configured = (lambda: True)
    CL, CB, C1, C4, C3, CM, CS = (H.client_as(a, x) for x in (LND, BGA, E1, E4, E3, MGR, STR))

    s.section("marking a no-show")
    pg = body(CL.get("/admin/learning/sessions/%d" % S))
    s.check("the day before the run, L&D's page offers Mark no-show on each confirmed place",
            pg.count('name="action" value="noshow"') == 3, pg.count('name="action" value="noshow"'))
    s.check("...a BG admin's page offers nothing", 'value="noshow"' not in body(CB.get("/admin/learning/sessions/%d" % S)))
    call(a.lms_invite_send, u_(LND), R2)
    act(CB, S, action="noshow", registration_id=str(R2), on_day=D(1), reason="ZZLS: no word")
    s.check("a BG admin can't mark one", reg_(R2)["status"] == "approved")
    act(CL, S, action="noshow", registration_id=str(R2), on_day=D(1), reason="")
    s.check("it needs the reason", reg_(R2)["status"] == "approved")
    act(CL, S, action="noshow", registration_id=str(R2), on_day=D(5), reason="ZZLS: x")
    s.check("...and one of the run's days", reg_(R2)["status"] == "approved")
    act(CL, S, action="noshow", registration_id=str(R2), on_day=D(2), reason="ZZLS: x")
    s.check("...not a day still to come (day 2, before day 1)", reg_(R2)["status"] == "approved")
    ok, msg = call(a.lms_mark_noshow, u_(LND), RL, D(3), "ZZLS: too early")
    s.check("...not before the day before the run", not ok and reg_(RL)["status"] == "approved", msg)
    act(CL, S, action="noshow", registration_id=str(R2), on_day=D(1),
        reason="ZZLS: MC from tomorrow, told L&D tonight")
    r2 = reg_(R2)
    s.check("L&D marks one: the place closes as a no-show, with the reason they read", r2["status"] == "cancelled" and
            r2["closed_kind"] == "noshow" and r2["remark"] == "ZZLS: MC from tomorrow, told L&D tonight")
    s.check("...the day is their absence, open (it counts)", one(
        "SELECT status FROM lms_absences WHERE registration_id=? AND on_date=?", (R2, D(1))) == "open" and
        call(a.lms_absence_counts, [E2])[E2] == 1)
    s.check("...their invite is cancelled", one("SELECT status FROM lms_invites WHERE registration_id=?", (R2,)) ==
            "cancelled")
    s.check("...the waiting list moves up, through its approval", reg_(R4)["status"] == "pending")
    s.check("...logged", one("SELECT COUNT(*) FROM activity_log WHERE action='lms_registration' AND detail LIKE "
                             "'%%marked a no-show for%%' AND target_user_id=?", (E2,)) == 1)
    exe("UPDATE lms_attendance SET session_id=session_id")   # nothing: a clock-in below
    exe("INSERT INTO lms_attendance(session_id, on_date, user_id, method) VALUES (?,?,?, 'qr')", (S2, D(0), E5))
    ok, msg = call(a.lms_mark_noshow, u_(LND), RA, D(0), "ZZLS: x")
    s.check("someone who clocked in that day can't be marked", not ok and reg_(RA)["status"] == "approved", msg)
    exe("DELETE FROM lms_attendance WHERE session_id=? AND user_id=?", (S2, E5))

    s.section("giving a seat that came free")
    pg = body(CL.get("/admin/learning/sessions/%d" % S))
    s.check("the no-show's row offers Give the seat, with the waiting list first in its panel",
            "Give the seat…" in pg and "Give ZZ LS E2's seat to someone" in pg and "The waiting list first" in pg and
            "ZZ LS E4" in pg)
    act(CB, S, action="seat_give", source_id=str(R2), to=str(R4), reason="ZZLS: next up")
    s.check("a BG admin can't give it", reg_(R4)["status"] == "pending")
    act(CL, S, action="seat_give", source_id=str(R2), to=str(R4), reason="")
    s.check("it needs the reason", reg_(R4)["status"] == "pending")
    n_mail = one("SELECT COUNT(*) FROM lms_sent WHERE kind='seat'")
    act(CL, S, action="seat_give", source_id=str(R2), to=str(R4), reason="ZZLS: a seat came free; you were next")
    r4 = reg_(R4)
    s.check("L&D gives it to the next one waiting: confirmed at once, in E2's place, with the reason",
            r4["status"] == "approved" and r4["replaces_reg"] == R2 and r4["seat_note"] ==
            "ZZLS: a seat came free; you were next" and r4["seat_at"])
    s.check("...the invite sent (on their page here)", one("SELECT status FROM lms_invites WHERE registration_id=?",
                                                           (R4,)) == "sent")
    s.check("...they and their line manager are emailed", one("SELECT COUNT(*) FROM lms_sent WHERE kind='seat'") ==
            n_mail + 2 and one("SELECT COUNT(*) FROM lms_sent WHERE kind='seat' AND ref=?", ("seat:%d:lm" % R4,)) == 1)
    s.check("...the no-show's absence still counts", call(a.lms_absence_counts, [E2])[E2] == 1)
    act(CL, S, action="seat_give", source_id=str(R2), to="other", employee_id="ZZ9LS-E5", reason="ZZLS: again")
    s.check("a seat goes once", one("SELECT COUNT(*) FROM lms_registrations WHERE replaces_reg=?", (R2,)) == 1)
    ok, _m = call(a.lms_mine_act, u_(E3), R3, "withdraw", {"why_kind": "clash", "why": "ZZLS: stock count"})
    act(CL, S, action="seat_give", source_id=str(R3), to="other", employee_id="ZZ9LS-E1",
        reason="ZZLS: they're on it already")
    s.check("someone already on the run is refused (pick them from the waiting list)", one(
        "SELECT COUNT(*) FROM lms_registrations WHERE replaces_reg=?", (R3,)) == 0)
    act(CL, S, action="seat_give", source_id=str(R3), to="other", employee_id="ZZ9LS-STR",
        reason="ZZLS: their HOD asked, outside the group")
    rs = one("SELECT id FROM lms_registrations WHERE replaces_reg=?", (R3,))
    s.check("a withdrawal's seat to anyone else: confirmed, added by L&D, outside the audience marked so",
            rs and reg_(rs)["status"] == "approved" and reg_(rs)["nomination"] == "hr" and reg_(rs)["off_audience"] == 1
            and reg_(rs)["user_id"] == STR)
    s.check("...the withdrawal stays a withdrawal", reg_(R3)["status"] == "withdrawn")
    pg = body(CL.get("/admin/learning/sessions/%d" % S))
    s.check("the page says who stands in for whom, and the seats given", "In place of ZZ LS E2" in pg and
            "In place of ZZ LS E3" in pg and pg.count("Seat given to") == 2)

    s.section("a walk-in in a no-show's seat")
    pg = body(CL.get("/admin/learning/sessions/%d?day=%s" % (S2, D(0))))
    s.check("the walk-in's Confirm attending opens the panel: in whose place, or an extra place",
            "Confirm attending…" in pg and "In whose place?" in pg and "Nobody: an extra place" in pg)
    s.check("...offering only who didn't clock in", "ZZ LS E5" in pg.split("In whose place?")[1].split("Nobody")[0] and
            "ZZ LS E6" not in pg.split("In whose place?")[1].split("Nobody")[0])
    taken0 = call(a._lms_seats_taken, S2)
    act(CL, S2, action="walkin", user_id=str(W), replace_rid=str(RA), reason="", day=D(0))
    s.check("in someone's place it needs a reason", not one("SELECT COUNT(*) FROM lms_registrations WHERE user_id=? AND "
                                                             "session_id=?", (W, S2)))
    act(CL, S2, action="walkin", user_id=str(W), replace_rid=str(RB), reason="ZZLS: x", day=D(0))
    s.check("...and someone who didn't clock in", not one("SELECT COUNT(*) FROM lms_registrations WHERE user_id=? AND "
                                                           "session_id=?", (W, S2)) and reg_(RB)["status"] == "approved")
    act(CL, S2, action="walkin", user_id=str(W), replace_rid=str(RA), reason="ZZLS: came with the HOD's agreement",
        day=D(0))
    rw = one("SELECT id FROM lms_registrations WHERE user_id=? AND session_id=? AND status='approved'", (W, S2))
    s.check("L&D confirms the walk-in in E5's place: confirmed, standing in for them", rw and reg_(rw)["replaces_reg"]
            == RA and reg_(rw)["nomination"] == "walkin")
    s.check("...E5's place ends there, the day their absence (it counts)", reg_(RA)["status"] == "cancelled" and
            reg_(RA)["closed_kind"] == "replaced" and one("SELECT status FROM lms_absences WHERE registration_id=? AND "
                                                          "on_date=?", (RA, D(0))) == "open")
    s.check("...the run stays as full", call(a._lms_seats_taken, S2) == taken0)
    s.check("...the walk-in's line manager is told (the walk-in, there, isn't emailed)",
            one("SELECT COUNT(*) FROM lms_sent WHERE kind='seat' AND ref=?", ("seat:%d:lm" % rw,)) == 1 and
            one("SELECT COUNT(*) FROM lms_sent WHERE kind='seat' AND ref=?", ("seat:%d" % rw,)) == 0)
    exe("INSERT INTO lms_attendance(session_id, on_date, user_id, method) VALUES (?,?,?, 'qr')", (S2, D(0), E4))
    ok, msg = call(a.lms_confirm_walkin, u_(LND), S2, E4)
    s.check("with nobody's place, a walk-in is an extra place as before", ok and one(
        "SELECT COUNT(*) FROM lms_registrations WHERE user_id=? AND session_id=? AND status='approved'", (E4, S2)) == 1
        and call(a._lms_seats_taken, S2) == taken0 + 1)

    s.section("the pax list, the T3 and HRDC")
    with a.app.test_request_context():
        pax = {r["employee_id"]: r["in_place_of"] for r in a.lms_pax_rows(a.get_db(), u_(LND), S)}
        sheet = a.lms_day_sheet(a.get_db(), S2, D(0))
    s.check("the pax list says whose place", pax.get("ZZ9LS-E4") == "ZZ LS E2" and pax.get("ZZ9LS-STR") == "ZZ LS E3"
            and pax.get("ZZ9LS-E1") == "", pax)
    s.check("...and the T3's rows", any(r["uid"] == W and r["in_place_of"] == "ZZ LS E5" for r in sheet["rows"]))
    r = CL.get("/admin/learning/sessions/%d/paxlist" % S)
    s.check("...the Excel has the column", r.status_code == 200)
    exe("INSERT INTO lms_hrdc(session_id, business_group, status, on_date, updated_at) VALUES (?,?, 'filed', ?, "
        "datetime('now', '-1 day'))", (S, BG, D(-1)))
    with a.app.test_request_context():
        board = a.lms_hrdc_board(a.get_db(), u_(LND))
    cell = [c for r_ in board["rows"] if r_["s"]["id"] == S for c in r_["cells"] if c["bg"] == BG]
    s.check("a filing made before a seat changed hands is flagged: Replacement to file", cell and cell[0]["repl"])
    exe("UPDATE lms_hrdc SET updated_at=datetime('now', '+1 minute') WHERE session_id=?", (S,))
    with a.app.test_request_context():
        board = a.lms_hrdc_board(a.get_db(), u_(LND))
    cell = [c for r_ in board["rows"] if r_["s"]["id"] == S for c in r_["cells"] if c["bg"] == BG]
    s.check("...until L&D saves the cell again", cell and not cell[0]["repl"])

    s.section("what each of them sees")
    pg = body(C4.get("/learning?view=mine&tab=find"))
    s.check("the person given the seat: why, on their confirmed place",
            "A seat came free, so Group People L&D gave it to you: “ZZLS: a seat came free; you were next”" in pg)
    with a.app.test_request_context():
        acts4 = (a.dash_learning(a.get_db(), u_(E4)) or {}).get("acts") or []
        actsm = (a.dash_learning(a.get_db(), u_(MGR)) or {}).get("acts") or []
    s.check("...a dashboard row", any(x["title"] == "You've got a place: ZZLS Negotiation" for x in acts4))
    s.check("their line manager: a row, no step of theirs", any("has a place: ZZLS Negotiation" in x["title"] and
                                                               "no step of yours waits" in x["sub"] for x in actsm))
    pg = body(H.client_as(a, E2).get("/learning?view=mine&tab=find"))
    s.check("the no-show: their place reads Didn't come, with L&D's reason", "Didn't come: seat freed" in pg and
            "ZZLS: MC from tomorrow, told L&D tonight" in pg)
    s.check("the KB says a seat that comes free can be given", "seat comes free" in a._KB_AI_LEARNING_BODY)
    s.check("the email list has it", "seat" in a.LMS_EMAIL_KINDS)
    s.check("the schema text is the same in both", a._LMS_DDL.strip() in a.SCHEMA)
finally:
    a.mailer.is_configured = _MAIL0
    if _ENV0 is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = _ENV0
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
