"""AI+ Learning's gap check, wave 1b (2026-10-23): who decides. Chris's calls of 23 Oct: a request's line manager step
follows whoever is their line manager now, and Group People L&D can decide a stuck step with a reason; no line manager
on record -> their HOD, else L&D (for confirming too); bulk decisions, Return kept and a final Decline added.

What this suite holds:
  * a line manager change: the new one decides, the old one no longer sees or acts on it
  * no line manager on record (none, left, an admin account): the step is their HOD's; with no HOD either, L&D's; on an
    external chain whose later steps are L&D's, the step is skipped and says so
  * a stuck step (nobody holds it, or past its clock with nobody to pass it to): L&D decides it for them, only with a
    reason, in the audit log; a step that isn't stuck isn't theirs to take
  * Decline: final, with the remark they read; the place goes to the waiting list; Mine shows it Declined
  * bulk: the ticked requests approved, returned or declined at once with one note; one that can't be doesn't stop
    the rest; the Team view and L&D's Requests draw the ticks; a BG admin can't decide
  * confirming a 3-month check-in or learning on the job: the line manager, else the HOD (in Dept), else L&D (on
    Requests); the email goes to whoever confirms
Everything here is synthetic (ZZLD / ZZ9LD-) and removed at the end.
"""
import html
import json
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning gap check, wave 1b: who decides")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG, CO = "ZZLD Group", "ZZLD U1"
_ENV0 = os.environ.get("ONEHR_LMS")
TODAY = a._today_myt()


def D(n):
    return (TODAY + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LD-%' OR username LIKE 'zzld-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLD %'")
    if ul:
        ph = ",".join("?" * len(ul))
        for t in ("lms_ojt", "lms_registrations", "email_outbox"):
            db.execute("DELETE FROM %s WHERE user_id IN (%s)" % (t, ph), ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, mgr=None, hod=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, hod_id, confirmation_date) VALUES "
                      "(?,?, 'x', 'user', ?,?,?, 'ZZLD Sales', 'ZZLD Officer', '15', ?, ?, '2020-01-01')",
                      (eid.lower(), "ZZ LD " + eid.split("-")[1], eid, BG, CO, mgr, hod)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    HOD = person(db, "ZZ9LD-HOD")
    M1, M2 = person(db, "ZZ9LD-M1", hod=HOD), person(db, "ZZ9LD-M2", hod=HOD)
    E = {k: person(db, "ZZ9LD-" + k, M1, HOD) for k in ("A", "B", "C", "D", "F", "G", "H", "J")}
    NOLM = person(db, "ZZ9LD-NOLM", None, HOD)            # no line manager, an HOD
    NOBODY = person(db, "ZZ9LD-NOBODY", None, None)       # neither
    LND = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzld-lnd', 'ZZ LD L&D', 'x', 'admin', ?)", (a.LMS_ADMIN_BG,)).lastrowid
    P = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days) VALUES ('ZZLD Negotiation', 'inhouse', "
                   "'published', 7, 1)").lastrowid
    P2 = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days) VALUES ('ZZLD Excel', 'inhouse', "
                    "'published', 7, 1)").lastrowid
    P3 = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days) VALUES ('ZZLD Pricing', 'inhouse', "
                    "'published', 7, 1)").lastrowid

    def sess(pid, day, seats=None):
        return db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, start_time, end_time, venue, seats, "
                          "needs_out, reg_cutoff) VALUES (?,?,?, '09:00', '17:00', 'ZZLD Room', ?, 1, ?)",
                          (pid, D(day), D(day), seats, D(day - 20))).lastrowid
    S, S2, S3, S_PAST = sess(P, 40, seats=1), sess(P2, 45), sess(P3, 50), sess(P2, -100)
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


def regd(rid):
    return call(a._lms_reg, rid)


def role_of(actor, rid):
    return call(a.lms_actor_role, u_(actor), regd(rid))


def setcol(uid, col, val):
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE users SET %s=? WHERE id=?" % col, (val, uid))
        d.commit()


try:
    os.environ["ONEHR_LMS"] = "1"

    s.section("a line manager change")
    ok, _m, ra = reg(E["A"], S2)
    s.check("asked: it waits on their line manager", ok and (role_of(M1, ra) or {}).get("as") == "lm")
    setcol(E["A"], "manager_id", M2)
    s.check("their line manager changes: the new one decides it", (role_of(M2, ra) or {}).get("as") == "lm")
    s.check("...the one who moved on doesn't see it or act on it", role_of(M1, ra) is None and
            ra not in [w["id"] for w in call(a.lms_waiting_on, u_(M1))])
    ok, msg = call(a.lms_decide, u_(M2), ra, "approve")
    s.check("...and approves it", ok and regd(ra)["status"] == "approved", msg)

    s.section("no line manager on record")
    ok, _m, rn = reg(NOLM, S2)
    st = regd(rn)["chain"][0]
    s.check("their HOD decides, and the step says so", st["role"] == "hod" and st["approver"] == HOD and
            "their HOD decides" in st["note"] and (role_of(HOD, rn) or {}).get("as") == "hod", st)
    ok, _m, rb = reg(NOBODY, S2)
    st = regd(rb)["chain"][0]
    s.check("no HOD either: Group People L&D decides", st["role"] == "lnd" and "L&D decides" in st["note"] and
            (role_of(LND, rb) or {}).get("as") == "lnd" and not (role_of(LND, rb) or {}).get("override"), st)
    setcol(E["B"], "manager_id", LND)    # an admin account as line manager is nobody here
    ok, _m, rx = reg(E["B"], S2)
    s.check("a line manager who is an admin account counts as none: their HOD decides",
            regd(rx)["chain"][0]["role"] == "hod")
    setcol(E["B"], "manager_id", M1)
    ext = {"ext_title": "ZZLD Contract Law", "ext_provider": "ZZLD Institute", "ext_starts_on": D(80),
           "ext_ends_on": D(80), "cost": "800", "why": "We sign new supplier contracts in Q1 and I review them."}
    ok, _m, re_ = call(a.lms_request_external, u_(NOBODY), ext)
    ch = regd(re_)["chain"]
    s.check("on an external chain with L&D's steps later, the step is skipped and says so",
            ch[0]["state"] == "skipped" and "L&D decides" in ch[0]["note"] and regd(re_)["chain"][regd(re_)["level"]]["role"]
            == "pp", ch)

    s.section("a stuck step")
    ok, _m, rs = reg(E["C"], S2)
    s.check("a step someone can act on isn't L&D's to take", role_of(LND, rs) is None)
    ok, msg = call(a.lms_decide, u_(LND), rs, "approve", "ZZLD")
    s.check("...deciding it is refused", not ok and regd(rs)["status"] == "pending", msg)
    setcol(M1, "left_at", D(0))           # their line manager leaves, and nobody new is on record
    who = role_of(LND, rs)
    s.check("their line manager leaves: L&D can decide it for them", who and who.get("override"), who)
    s.check("...it shows under Nobody else can act on L&D's Requests", 'id="stuck-%d"' % rs in html.unescape(
        H.client_as(a, LND).get("/admin/learning/requests").get_data(as_text=True)))
    ok, msg = call(a.lms_decide, u_(LND), rs, "approve", "")
    s.check("...only with a reason", not ok and "reason" in msg and regd(rs)["status"] == "pending", msg)
    r = H.client_as(a, LND).post("/admin/learning/requests", data={"csrf_token": "tok", "action": "approve",
                                                                     "registration_id": str(rs),
                                                                     "remark": "Their manager left on Friday."})
    s.check("...with it, it's decided, the step noting L&D", r.status_code == 302 and regd(rs)["status"] == "approved"
            and "Group People L&D" in regd(rs)["chain"][0]["note"])
    s.check("...and it's in the audit log", "Their manager left on Friday." in (one(
        "SELECT detail FROM activity_log WHERE action='lms_registration' AND target_user_id=? ORDER BY id DESC LIMIT 1",
        (E["C"],)) or ""))
    setcol(M1, "left_at", None)
    ok, _m, rl = reg(E["D"], S2)
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE lms_registrations SET level_since=? WHERE id=?", (D(-20), rl))
        d.execute("UPDATE users SET hod_id=NULL WHERE id=?", (E["D"],))
        d.commit()
    s.check("past its clock with nobody to pass it to: stuck too, and the line manager can still act",
            (role_of(LND, rl) or {}).get("override") and (role_of(M1, rl) or {}).get("as") == "lm")
    setcol(E["D"], "hod_id", HOD)

    s.section("Decline")
    ok, _m, r1 = reg(E["F"], S)
    ok, _m, r2 = reg(E["G"], S)
    s.check("a one-seat run: the second waits", regd(r1)["status"] == "pending" and regd(r2)["status"] == "waitlisted")
    ok, msg = call(a.lms_decide, u_(M1), r1, "decline", "")
    s.check("declining needs a remark", not ok and regd(r1)["status"] == "pending", msg)
    ok, msg = call(a.lms_decide, u_(M1), r1, "decline", "Not this quarter, the budget is used.")
    s.check("declined: closed for good, with the remark", ok and regd(r1)["status"] == "cancelled" and
            regd(r1)["closed_kind"] == "declined" and regd(r1)["remark"] == "Not this quarter, the budget is used.", msg)
    s.check("...the place goes to the waiting list", regd(r2)["status"] == "pending")
    s.check("...they're told", one("SELECT COUNT(*) FROM lms_sent WHERE kind='returned' AND ref=?",
                                   ("reg:%d:declined" % r1,)) == 1)
    sp = call(a.lms_space, u_(E["F"]), "mine")
    s.check("...Mine shows it Declined under Closed", [x["status_label"] for x in sp["closed"] if x["id"] == r1] ==
            ["Declined"])
    ok, msg = call(a.lms_mine_act, u_(E["F"]), r1, "resend")
    s.check("...and it can't be sent again", not ok, msg)

    s.section("in bulk")
    rids = []
    for k in ("H", "J"):
        rids.append(reg(E[k], S2)[2])
    rids.append(r2)
    r = H.client_as(a, M1).post("/learning/decide/bulk", data={"csrf_token": "tok", "rid": [str(x) for x in rids],
                                                               "bulk": "return", "view": "team"})
    ok, msg = call(a.lms_decide_many, u_(M1), rids, "return", "  ")
    s.check("returning the ticked needs the note, said once for all", all(regd(x)["status"] == "pending" for x in rids)
            and not ok and msg == "Give the note everyone ticked reads.", msg)
    r = H.client_as(a, M1).post("/learning/decide/bulk", data={"csrf_token": "tok", "rid": [str(x) for x in rids] +
                                                               [str(rb)], "bulk": "approve", "view": "team"})
    s.check("the ticked approved at once; one that isn't theirs is left, the rest go",
            r.status_code == 302 and all(regd(x)["status"] in ("approved", "waitlisted") for x in rids) and
            regd(rb)["status"] == "pending")
    ok, msg = call(a.lms_decide_many, u_(M1), [rids[0], rb], "approve")
    s.check("...the message says which couldn't be, and why", "Not done" in msg and "ZZ LD NOBODY" in msg, msg)
    ok_, _m, rk = reg(E["H"], S3)   # a run with room, another programme
    ok, msg = call(a.lms_decide_many, u_(M1), [rk], "decline", "No budget left this quarter.")
    s.check("declined in bulk with one note", ok and regd(rk)["closed_kind"] == "declined", msg)
    pg = html.unescape(H.client_as(a, M1).get("/learning?view=team&tab=team").get_data(as_text=True))
    ok_, _m, rt = reg(E["J"], S3)
    pg = html.unescape(H.client_as(a, M1).get("/learning?view=team&tab=team").get_data(as_text=True))
    s.check("the Team view draws the ticks, Tick all and the bulk bar, and Decline beside Return",
            'id="ln-bulk"' in pg and 'data-bulk-all' in pg and 'name="rid" value="%d" form="ln-bulk"' % rt in pg and
            'value="decline"' in pg)
    r = H.client_as(a, BGA["id"]).post("/admin/learning/requests", data={"csrf_token": "tok", "action": "bulk",
                                                                          "rid": [str(rt)], "bulk": "approve"})
    s.check("a BG admin can't decide (they read only)", r.status_code == 403 and regd(rt)["status"] == "pending",
            r.status_code)

    s.section("confirming without a line manager")
    with a.app.app_context():
        d = a.get_db()
        evs = {}
        for uid in (NOLM, NOBODY):
            rr = d.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, outcome) "
                           "VALUES (?,?,?, 'approved', '[]', 'attended')", (uid, S_PAST, P2)).lastrowid
            evs[uid] = d.execute("INSERT INTO lms_evaluations(registration_id, kind, due_on, status, words_json, "
                                 "self_level) VALUES (?, 'm3', ?, 'self_done', ?, NULL)",
                                 (rr, D(-5), json.dumps({"changed": "I price every quote with the margin check now.",
                                                         "example": "The Southern renewal."}))).lastrowid
        d.commit()
    s.check("no line manager: their HOD confirms, in Dept", [e["id"] for e in call(a.lms_space, u_(HOD), "dept")
                                                            ["to_confirm"]] == [evs[NOLM]])
    s.check("...not in the HOD's Team view", evs[NOLM] not in [e["id"] for e in call(a.lms_space, u_(HOD), "team")
                                                               .get("to_confirm", [])])
    ok, msg = call(a.lms_eval_confirm, u_(HOD), evs[NOLM], "confirm", None)
    s.check("...and confirms it", ok and one("SELECT status FROM lms_evaluations WHERE id=?", (evs[NOLM],)) ==
            "confirmed", msg)
    s.check("no HOD either: L&D confirms, on Requests", evs[NOBODY] in [e["id"] for e in call(
        a.lms_eval_to_confirm, u_(LND))] and "No line manager or HOD to confirm" in html.unescape(
        H.client_as(a, LND).get("/admin/learning/requests").get_data(as_text=True)))
    r = H.client_as(a, LND).post("/admin/learning/requests", data={"csrf_token": "tok", "action": "eval_confirm",
                                                                     "eval_id": str(evs[NOBODY])})
    s.check("...and confirms it there", one("SELECT status FROM lms_evaluations WHERE id=?", (evs[NOBODY],)) ==
            "confirmed")
    ok, msg = call(a.lms_ojt_send, u_(NOLM), {"kind": "others", "what": "Mentoring a joiner",
                                              "example": "Went through two cost sheets with her and checked the variances.",
                                              "goal_id": "", "when": "October"})
    oid = one("SELECT id FROM lms_ojt WHERE user_id=? ORDER BY id DESC LIMIT 1", (NOLM,))
    s.check("learning on the job with no line manager goes to their HOD", ok and "your HOD" in msg and
            one("SELECT manager_id FROM lms_ojt WHERE id=?", (oid,)) == HOD, msg)
    ok, msg = call(a.lms_ojt_decide, u_(HOD), oid, "confirm")
    s.check("...who confirms it", ok and one("SELECT status FROM lms_ojt WHERE id=?", (oid,)) == "confirmed", msg)
finally:
    if _ENV0 is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = _ENV0
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
