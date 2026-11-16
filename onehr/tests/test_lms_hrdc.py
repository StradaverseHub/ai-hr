"""AI+ Learning S13: the HRDC tracker (Chris, 2026-10-22: "everything now goes to group people L&D"; board 10).

What this suite holds:
  * the board: HRDC-claimable sessions only, a cell per business group: no pax, after pax (registration still open),
    not filed (red from 14 days before D-14), filed, query, approved, rejected; the tiles count what the cells say
  * Group People L&D (or the super admin) records each step; approved needs the grant ID; a BG's admin reads their
    own group's line only and records nothing
  * an HRDC query: one at a time, its reply due 5 working days on, the filing reads Query until it's closed
  * the JD14 claim: its step and due date, late when past, gone when claimed
  * the clock reads Learning › Settings' days over the defaults
Everything here is synthetic (ZZLH / ZZ9LH-) and removed at the end.
"""
import html
import json
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning S13: HRDC")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BGA, BGB = "ZZLH A Group", "ZZLH B Group"
_ENV0 = os.environ.get("ONEHR_LMS")


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LH-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLH %'")
    db.execute("DELETE FROM app_settings WHERE key='lms_clock'")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM lms_registrations WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BGA, BGB))
    db.commit()


def person(db, eid, bg, role="user", admin_bg=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, admin_bg) VALUES (?,?, 'x', ?, ?,?, 'ZZLH U1', 'ZZLH Sales', "
                      "'ZZLH Officer', '15', ?)", (eid.lower(), "ZZ LH " + eid.split("-")[1], role, eid, bg,
                                                   admin_bg)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    for bg in (BGA, BGB):
        db.execute("INSERT INTO org_units(business_group, company, active) VALUES (?, 'ZZLH U1', 1)", (bg,))
    LND = person(db, "ZZ9LH-LND", None, "admin", a.LMS_ADMIN_BG)
    BGADM = person(db, "ZZ9LH-BGA", BGA, "admin", BGA)
    P1, P2 = (db.execute("INSERT INTO lms_programmes(title, kind, status, hrdc_claimable) VALUES (?, 'inhouse', "
                         "'published', ?)", (t, h)).lastrowid for t, h in (("ZZLH Chemical Handling", 1),
                                                                          ("ZZLH Not Claimable", 0)))
    today = a._today_myt()

    def sess(pid, d1, cutoff):
        return db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, seats, reg_cutoff) VALUES "
                          "(?, 'ZZLH run', ?, ?, 20, ?)", (pid, d1.isoformat(), d1.isoformat(), cutoff.isoformat())
                          ).lastrowid
    S1 = sess(P1, today + timedelta(days=20), today - timedelta(days=1))      # D-14 in 6 days, pax fixed
    S2 = sess(P1, today + timedelta(days=60), today + timedelta(days=30))     # registration still open
    S3 = sess(P2, today + timedelta(days=20), today - timedelta(days=1))      # not claimable
    for i in range(2):
        u_ = person(db, "ZZ9LH-A%d" % i, BGA)
        for sid in (S1, S2, S3):
            db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json) VALUES "
                       "(?,?,?, 'approved', '[]')", (u_, sid, P2 if sid == S3 else P1))
    BU = person(db, "ZZ9LH-B0", BGB)   # someone from B on the later run only, so B is a column with no pax on S1
    db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json) VALUES "
               "(?,?,?, 'approved', '[]')", (BU, S2, P1))
    db.commit()


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


def admin(uid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def board(uid=LND):
    with a.app.test_request_context():
        return a.lms_hrdc_board(a.get_db(), admin(uid))


def cell(b, sid, bg):
    row = next((r for r in b["rows"] if r["s"]["id"] == sid), None)
    return next((c for c in (row["cells"] if row else []) if c["bg"] == bg), None), row


def call(fn, uid, *args):
    with a.app.test_request_context():
        return fn(a.get_db(), admin(uid), *args)


try:
    env("1")
    s.section("the board")
    b = board()
    sids = [r["s"]["id"] for r in b["rows"]]
    s.check("HRDC-claimable sessions only", S1 in sids and S2 in sids and S3 not in sids, sids)
    c1a, r1 = cell(b, S1, BGA)
    s.check("not filed, red: D-14 within 14 days", c1a["state"] == "not_filed" and c1a["red"] and c1a["pax"] == 2 and
            r1["d14"] == today + timedelta(days=6), c1a)
    s.check("...a business group with nobody on it: no pax", cell(b, S1, BGB)[0]["state"] == "nopax")
    s.check("...only the business groups with people on a listed session", BGA in b["bgs"] and BGB in b["bgs"] and
            all(H.one(a, "SELECT COUNT(*) FROM lms_registrations r JOIN users u ON u.id=r.user_id WHERE r.status="
                         "'approved' AND u.business_group=? AND r.session_id IN (%s)" % ",".join(map(str, sids)), (g,))
                or H.one(a, "SELECT COUNT(*) FROM lms_hrdc WHERE business_group=?", (g,)) for g in b["bgs"]), b["bgs"])
    s.check("...registration still open: after pax", cell(b, S2, BGA)[0]["state"] == "afterpax")
    s.check("the tiles count what the cells say", b["tiles"]["at_risk"] == sum(c["red"] for r in b["rows"]
                                                                                 for c in r["cells"]), b["tiles"])

    s.section("L&D records each step")
    ok, msg = call(a.lms_hrdc_set, LND, S1, BGA, {"status": "filed", "on_date": today.isoformat()})
    c, _r = cell(board(), S1, BGA)
    s.check("filed, on its date; no longer red", ok and c["state"] == "filed" and not c["red"] and
            c["label"].startswith("Filed "), (msg, c))
    ok, msg = call(a.lms_hrdc_set, LND, S1, BGA, {"status": "approved"})
    s.check("approved needs the grant ID", not ok and "grant ID" in msg, msg)
    s.check("...nothing for a business group not on the board", not call(a.lms_hrdc_set, LND, S1, "Nobody's Group",
                                                                          {"status": "filed"})[0])
    s.check("...nothing for a session that isn't claimable", not call(a.lms_hrdc_set, LND, S3, BGA, {"status": "filed"})[0])

    s.section("a query: one at a time, 5 working days")
    ok, msg = call(a.lms_hrdc_query_add, LND, S1, BGA, {"about": "The trainer's certificate", "opened_on":
                                                          today.isoformat(), "owner": "Vendor, via L&D"})
    q = H.one(a, "SELECT reply_by FROM lms_hrdc_queries WHERE session_id=? AND business_group=? AND closed_on IS NULL",
              (S1, BGA))
    d, n = today, 0
    while n < 5:   # working days: weekends AND public holidays skipped (9 Nov 2026 is the Deepavali holiday)
        d += timedelta(days=1)
        n += d.weekday() < 5 and a.lms_workday(d)
    s.check("logged: the reply due 5 working days on, the filing reads Query", ok and q == d.isoformat() and
            cell(board(), S1, BGA)[0]["state"] == "query", (msg, q, d))
    ok2, msg2 = call(a.lms_hrdc_query_add, LND, S1, BGA, {"about": "A second question"})
    s.check("...one at a time", not ok2 and "one query at a time" in msg2, msg2)
    qid = H.one(a, "SELECT id FROM lms_hrdc_queries WHERE session_id=? AND closed_on IS NULL", (S1,))
    ok, msg = call(a.lms_hrdc_query_close, LND, qid)
    s.check("...answered: closed, the filing reads Filed", ok and cell(board(), S1, BGA)[0]["state"] == "filed", msg)
    ok, msg = call(a.lms_hrdc_set, LND, S1, BGA, {"status": "approved", "grant_id": "ZZLH-GRANT-1"})
    s.check("approved with the grant ID", ok and cell(board(), S1, BGA)[0]["grant"] == "ZZLH-GRANT-1", msg)

    s.section("the JD14 claim")
    ok, msg = call(a.lms_jd14_set, LND, S1, BGA, {"step": "sign", "due_on": (today - timedelta(days=4)).isoformat()})
    cl = next((x for x in board()["claims"] if x["session_id"] == S1), None)
    s.check("its step, late when past its date", ok and cl and cl["step_label"] == "L&D to sign" and cl["late"] == 4, cl)
    call(a.lms_jd14_set, LND, S1, BGA, {"step": "done"})
    s.check("...gone from the list once claimed", not any(x["session_id"] == S1 for x in board()["claims"]))

    s.section("a BG's admin reads their own group's line")
    bb = board(BGADM)
    s.check("only their group", bb["bgs"] == [BGA], bb["bgs"])
    ok, msg = call(a.lms_hrdc_set, BGADM, S1, BGA, {"status": "rejected"})
    s.check("...and records nothing", not ok and cell(board(), S1, BGA)[0]["state"] == "approved", msg)
    CL, CB = H.client_as(a, LND), H.client_as(a, BGADM)
    pg = html.unescape(CL.get("/admin/learning/hrdc").get_data(as_text=True))
    s.check("the page: L&D's, with the grid and Log a query", "Sessions by business group" in pg and
            "ZZLH Chemical Handling" in pg and "Log a query" in pg)
    r = CB.get("/admin/learning/hrdc")
    s.check("...the BG admin's, read only", r.status_code == 200 and "Log a query" not in r.get_data(as_text=True))
    s.check("...their write is refused", CB.post("/admin/learning/hrdc", data={"csrf_token": "tok", "action": "cell",
                                                                                "session_id": S1, "bg": BGA,
                                                                                "status": "filed"}).status_code == 403)

    s.section("the clock")
    with a.app.test_request_context():
        db = a.get_db()
        s_ = a._lms_session_row(db, S1)
        d0 = a.lms_clock(db, s_)
        db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('lms_clock', ?)", (json.dumps({"approve": 21}),))
        db.commit()
        d1 = a.lms_clock(db, s_)
    s.check("D-14 by default, Settings' days over it; registration closes on the session's cut-off",
            d0["approve"] == date.fromisoformat(s_["starts_on"]) - timedelta(days=14) and
            d1["approve"] == date.fromisoformat(s_["starts_on"]) - timedelta(days=21) and
            d0["reg_close"] == today - timedelta(days=1), (d0, d1))

    s.section("only while Learning is on")
    env(None)
    s.check("the page is dark", CL.get("/admin/learning/hrdc").status_code == 404)
finally:
    env(_ENV0)
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
