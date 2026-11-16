"""AI+ Learning S14: a session's own clock and its documents (Chris, 2026-10-22: "continue with S10 to S15"; board 10B).

What this suite holds:
  * the clock: registration closes on the session's cut-off, the HRDC pack, the BG filing and the grant's approval
    in days before day one from Learning › Settings; a session's own days (in order: pack, filing, approval), and back
    to Settings'; Settings' registration close sets a new session's cut-off; only L&D changes it
  * the document pack: six items ticked ready and back, counted on the clock
  * the cost-sharing letter: each business group's people confirmed x the cost a person, with its HRDC filing; a BG
    admin's own group only; the printed letter and the T3 Excel are L&D's
  * the final pax list (Excel): everyone confirmed, the IC column blank; a BG admin's own group only
Everything here is synthetic (ZZLD / ZZ9LD-) and removed at the end.
"""
import io
import json
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning S14: a session's clock and documents")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BGA, BGB = "ZZLD A Group", "ZZLD B Group"
_ENV0 = os.environ.get("ONEHR_LMS")


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LD-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLD %'")
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
                      "department, job_title, job_grade, admin_bg) VALUES (?,?, 'x', ?, ?,?, 'ZZLD U1', 'ZZLD Sales', "
                      "'ZZLD Officer', '15', ?)", (eid.lower(), "ZZ LD " + eid.split("-")[1], role, eid, bg,
                                                   admin_bg)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    for bg in (BGA, BGB):
        db.execute("INSERT INTO org_units(business_group, company, active) VALUES (?, 'ZZLD U1', 1)", (bg,))
    LND = person(db, "ZZ9LD-LND", None, "admin", a.LMS_ADMIN_BG)
    BGADM = person(db, "ZZ9LD-BGA", BGA, "admin", BGA)
    P = db.execute("INSERT INTO lms_programmes(title, kind, status, hrdc_claimable, cost_per_pax) VALUES "
                   "('ZZLD Negotiation', 'inhouse', 'published', 1, 1200)").lastrowid
    today = a._today_myt()
    D1 = today + timedelta(days=40)
    S = db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, seats, reg_cutoff) VALUES "
                   "(?, 'ZZLD run', ?, ?, 30, ?)", (P, D1.isoformat(), (D1 + timedelta(days=1)).isoformat(),
                                                   (D1 - timedelta(days=30)).isoformat())).lastrowid
    for i, bg in enumerate([BGA] * 3 + [BGB] * 2):
        u_ = person(db, "ZZ9LD-P%d" % i, bg)
        db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json) VALUES "
                   "(?,?,?, 'approved', '[]')", (u_, S, P))
    W = person(db, "ZZ9LD-W", BGA)   # waiting: never on the pax list
    db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json) VALUES "
               "(?,?,?, 'pending', '[]')", (W, S, P))
    db.commit()


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


def admin(uid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def call(fn, uid, *args):
    with a.app.test_request_context():
        return fn(a.get_db(), admin(uid), *args)


def view():
    with a.app.test_request_context():
        db = a.get_db()
        return {c["key"]: c for c in a.lms_session_clock_view(db, a._lms_session_row(db, S))}


def xlsx(resp):
    from openpyxl import load_workbook
    ws = load_workbook(io.BytesIO(resp.data), read_only=True).worksheets[0]
    return [list(r) for r in ws.iter_rows(values_only=True)]


try:
    env("1")
    s.section("the clock")
    v = view()
    s.check("from Settings: registration on its cut-off, the pack D-28, the filing D-24, the approval D-14",
            v["reg_close"]["days"] == 30 and v["pack"]["on"] == D1 - timedelta(days=28) and
            v["file"]["on"] == D1 - timedelta(days=24) and v["approve"]["on"] == D1 - timedelta(days=14)
            and not any(c["own"] for c in v.values()), {k: (c["days"], str(c["on"])) for k, c in v.items()})
    ok, msg = call(a.lms_session_clock_set, LND, S, {"pack": "35", "file": "20", "approve": "21"})
    s.check("its own days must run in order (pack, filing, approval)", not ok and "before" in msg, msg)
    ok, msg = call(a.lms_session_clock_set, LND, S, {"pack": "35", "file": "25", "approve": "15"})
    v = view()
    s.check("...its own days", ok and v["pack"]["on"] == D1 - timedelta(days=35) and v["approve"]["own"] and
            v["approve"]["on"] == D1 - timedelta(days=15), msg)
    ok, msg = call(a.lms_session_clock_set, BGADM, S, {"pack": "40", "file": "25", "approve": "15"})
    s.check("...only L&D changes it", not ok and view()["pack"]["on"] == D1 - timedelta(days=35), msg)
    ok, msg = call(a.lms_session_clock_set, LND, S, {"reset": "1"})
    s.check("...and back to Settings'", ok and not any(c["own"] for c in view().values()), msg)
    CL, CB = H.client_as(a, LND), H.client_as(a, BGADM)
    r = CL.post("/admin/learning/settings", data={"csrf_token": "tok", "action": "clock", "reg_close": "45",
                                                 "pack": "28", "file": "24", "approve": "14"})
    with a.app.test_request_context():
        db = a.get_db()
        ok2, _m = a.lms_session_save(db, admin(LND), P, {"starts_on": (today + timedelta(days=90)).isoformat()})
        cut = db.execute("SELECT reg_cutoff FROM lms_sessions WHERE programme_id=? ORDER BY id DESC LIMIT 1", (P,)
                         ).fetchone()[0]
    s.check("Settings' registration close sets a new session's cut-off", r.status_code == 302 and ok2 and
            cut == (today + timedelta(days=45)).isoformat(), cut)
    r = CL.post("/admin/learning/settings", data={"csrf_token": "tok", "action": "clock", "reg_close": "10",
                                                 "pack": "28", "file": "24", "approve": "14"})
    s.check("...in order: registration closes before the pack", json.loads(H.one(
        a, "SELECT value FROM app_settings WHERE key='lms_clock'"))["reg_close"] == 45)
    s.check("...a BG admin can't change Settings", CB.post("/admin/learning/settings", data={
        "csrf_token": "tok", "action": "clock", "reg_close": "30", "pack": "28", "file": "24", "approve": "14"}
    ).status_code == 403)

    s.section("the document pack")
    call(a.lms_session_doc_tick, LND, S, "outline", True)
    call(a.lms_session_doc_tick, LND, S, "trainer_cert", True)
    s.check("ticked ready, counted on the clock", view()["pack"]["chip"].endswith("2 of 6 ready"), view()["pack"])
    call(a.lms_session_doc_tick, LND, S, "trainer_cert", False)
    ok, _m = call(a.lms_session_doc_tick, BGADM, S, "invoice", True)
    s.check("...and back; only L&D ticks", view()["pack"]["chip"].endswith("1 of 6 ready") and not ok)
    s.check("...only the pack's items", not call(a.lms_session_doc_tick, LND, S, "anything", True)[0])

    s.section("the cost-sharing letter")
    with a.app.test_request_context():
        db = a.get_db()
        db.execute("INSERT INTO lms_hrdc(session_id, business_group, status) VALUES (?,?, 'filed')", (S, BGA))
        db.commit()
    with a.app.test_request_context():
        db = a.get_db()
        c = a.lms_cost_share(db, admin(LND), a._lms_session_row(db, S))
        cb = a.lms_cost_share(db, admin(BGADM), a._lms_session_row(db, S))
    rows = {r["bg"]: r for r in c["rows"]}
    s.check("each group's people x the cost a person, with its HRDC filing", rows[BGA]["pax"] == 3 and
            rows[BGA]["cost"] == 3600 and rows[BGA]["hrdc"] == "Filed" and rows[BGB]["cost"] == 2400 and
            c["total"] == 6000 and c["pax"] == 5, c)
    s.check("...a BG admin: their own group only", [r["bg"] for r in cb["rows"]] == [BGA], cb)
    pg = CL.get("/admin/learning/sessions/%d/costletter" % S)
    s.check("the printed letter: L&D's", pg.status_code == 200 and "6,000.00" in pg.get_data(as_text=True) and
            CB.get("/admin/learning/sessions/%d/costletter" % S).status_code == 403)

    s.section("the final pax list and the T3")
    rows = xlsx(CL.get("/admin/learning/sessions/%d/paxlist" % S))
    s.check("everyone confirmed, nobody waiting, the IC column blank", rows[0][:4] == ["No", "Name", "Employee ID",
                                                                                     "IC number"]
            and len(rows) == 6 and all(not r[3] for r in rows[1:]) and "ZZ LD W" not in [r[1] for r in rows], rows)
    rows_b = xlsx(CB.get("/admin/learning/sessions/%d/paxlist" % S))
    s.check("...a BG admin: their own group's people", len(rows_b) == 4, len(rows_b))
    d = D1.isoformat()
    s.check("the T3 as Excel: L&D's", len(xlsx(CL.get("/admin/learning/sessions/%d/t3.xlsx?day=%s" % (S, d)))) == 6
            and CB.get("/admin/learning/sessions/%d/t3.xlsx?day=%s" % (S, d)).status_code == 403)

    s.section("the session page")
    pg = CL.get("/admin/learning/sessions/%d" % S).get_data(as_text=True)
    s.check("L&D: the clock and the documents, with their forms", 'id="lm-docs"' in pg and 'value="doc"' in pg and
            "Change the clock for this session" in pg and "Cost-sharing letter" in pg)
    pg = CB.get("/admin/learning/sessions/%d" % S).get_data(as_text=True)
    s.check("...a BG admin reads them, no forms", 'id="lm-docs"' in pg and 'value="doc"' not in pg and
            "Change the clock for this session" not in pg)

    s.section("only while Learning is on")
    env(None)
    s.check("the downloads are dark", CL.get("/admin/learning/sessions/%d/paxlist" % S).status_code == 404)
finally:
    env(_ENV0)
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
