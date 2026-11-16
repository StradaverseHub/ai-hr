"""AI+ Learning: announce a programme (Chris, 2026-10-22: "L&D admin should also be able to add a new program and blast
to all users or selected group to notify the rollout of a training"; "admin can choose by BG / BU / Dept / job grade /
job family"; canvas board 16B; "ok, build all of it on staging").

What this suite holds:
  * who: everyone with AI+ Learning, or by business group, business unit, department, job grade and job family (the
    sub-family) -- any within a row, all the rows together; nothing picked is nobody; never a leaver or an admin
    account; anyone confirmed on a run still to come is left out, and counted
  * sending: a published programme only; a subject and a message; now, or at a time not past (MYT); one email each,
    once, in the outbox's waves under its own batch; each person also gets a "New" row on their dashboard once it's
    sent, until they register; logged
  * the draft: the AI's from the programme, or a plain one when the AI isn't there or fails
  * the page: L&D's count before sending, "sent before" with registrations since; a BG admin can't send
Everything here is synthetic (ZZLN / ZZ9LN-) and removed at the end.
"""
import html
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: announce a programme")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG = "ZZLN Group"
_ENV0 = os.environ.get("ONEHR_LMS")
_MAIL0, _AI0, _DRAFT0, _SCREEN0 = (a.mailer.is_configured, a.ai_draft.is_configured, a.ai_draft.lms_announce_draft,
                                   a.ai_draft.screen_message)


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LN-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLN %'")
    db.execute("DELETE FROM ja_people WHERE employee_id LIKE 'ZZ9LN-%'")
    db.execute("DELETE FROM ja_taxonomy WHERE code LIKE 'ZZLN-%'")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM lms_sent WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM email_outbox WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM lms_registrations WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action='lms_announce' AND detail LIKE 'ZZLN %'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, unit, dept, grade, jf=None, role="user", admin_bg=None, left=None):
    uid = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                     "department, job_title, job_grade, email, admin_bg, left_at, confirmation_date) VALUES "
                     "(?,?, 'x', ?, ?,?,?,?, 'ZZLN Officer', ?, ?, ?, ?, '2020-01-01')",
                     (eid.lower(), "ZZ LN " + eid.split("-")[1], role, eid, BG, unit, dept, grade,
                      eid.lower() + "@example.invalid", admin_bg, left)).lastrowid
    if jf:
        db.execute("INSERT INTO ja_people(employee_id, sub_code) VALUES (?,?)", (eid, jf))
    return uid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    for u_ in ("ZZLN U1", "ZZLN U2"):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, u_))
    db.execute("INSERT INTO ja_taxonomy(code, level, name) VALUES ('ZZLN-S1', 'sub', 'ZZLN Sales family'), "
               "('ZZLN-S2', 'sub', 'ZZLN Finance family')")
    A = person(db, "ZZ9LN-A", "ZZLN U1", "ZZLN Sales", "13", "ZZLN-S1")
    B = person(db, "ZZ9LN-B", "ZZLN U1", "ZZLN Finance", "16", "ZZLN-S2")
    C = person(db, "ZZ9LN-C", "ZZLN U2", "ZZLN Sales", "16", "ZZLN-S1")
    Dp = person(db, "ZZ9LN-D", "ZZLN U2", "ZZLN Sales", "13")
    X = person(db, "ZZ9LN-X", "ZZLN U2", "ZZLN Sales", "13")
    L = person(db, "ZZ9LN-L", "ZZLN U1", "ZZLN Sales", "13", left="2026-01-01")
    LND = person(db, "ZZ9LN-LND", None, None, None, role="admin", admin_bg=a.LMS_ADMIN_BG)
    BGA = person(db, "ZZ9LN-BGA", None, None, None, role="admin", admin_bg=BG)
    P = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, description) VALUES "
                   "('ZZLN Negotiation', 'inhouse', 'published', 14, 2, 'Holding price with distributors')").lastrowid
    PD = db.execute("INSERT INTO lms_programmes(title, kind, status) VALUES ('ZZLN Draft', 'inhouse', 'draft')").lastrowid
    S = db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on, seats, reg_cutoff) VALUES "
                   "(?, date('now','+30 days'), date('now','+31 days'), 24, date('now','+20 days'))", (P,)).lastrowid
    db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json) VALUES "
               "(?,?,?, 'approved', '[]')", (X, S, P))
    db.commit()
    MINE = {A, B, C, Dp, X, L}


def one(sql, args=()):
    return H.one(a, sql, args)


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


def who(**pick):
    pk = {"all": pick.pop("all", False)}
    for k in ("bg", "bu", "dept", "grade", "jf"):
        pk[k] = pick.get(k, [])
    with a.app.app_context():
        people, out, _closed = a.lms_announce_audience(a.get_db(), P, pk)
    return {u["id"] for u in people} & MINE, out


try:
    env("1")
    a.ai_draft.screen_message = (lambda m: None)
    CL, CB = H.client_as(a, LND), H.client_as(a, BGA)
    CA = H.client_as(a, A)

    s.section("who gets it")
    got, out = who(bg=[BG])
    s.check("a business group: its people, the one already confirmed left out and counted",
            got == {A, B, C, Dp} and out == 1, (got, out))
    s.check("a business unit", who(bu=["ZZLN U1"])[0] == {A, B})
    s.check("all the rows together (unit and department)", who(bu=["ZZLN U1"], dept=["ZZLN Sales"])[0] == {A})
    s.check("any within a row (both units), all across (Finance)", who(bu=["ZZLN U1", "ZZLN U2"],
                                                                       dept=["ZZLN Finance"])[0] == {B})
    s.check("a job grade", who(bg=[BG], grade=["16"])[0] == {B, C})
    s.check("a job family (the sub-family)", who(jf=["ZZLN-S1"])[0] == {A, C})
    s.check("a job family and a grade", who(jf=["ZZLN-S1"], grade=["13"])[0] == {A})
    s.check("nothing picked is nobody", who()[0] == set())
    got, out = who(all=True)
    s.check("everyone: never a leaver, never someone already confirmed", {A, B, C, Dp} <= got and L not in got and
            X not in got)
    with a.app.app_context():
        opts = a.lms_announce_options(a.get_db())
    s.check("the rows offer what's on record", (BG, BG) in opts["bg"] and ("ZZLN U2", "ZZLN U2") in opts["bu"] and
            ("16", "JG 16") in opts["grade"] and ("ZZLN-S1", "ZZLN Sales family") in opts["jf"])

    s.section("sending")
    a.mailer.is_configured = lambda: True
    with a.app.app_context():
        db = a.get_db()
        lnd = db.execute("SELECT * FROM users WHERE id=?", (LND,)).fetchone()
        pk = {"all": False, "bg": [BG], "bu": [], "dept": [], "grade": [], "jf": []}
        ok, msg, _x = a.lms_announce_send(db, lnd, PD, pk, "ZZLN s", "ZZLN m")
        s.check("only a published programme", not ok)
        ok, msg, _x = a.lms_announce_send(db, lnd, P, pk, "  ", "ZZLN m")
        s.check("a subject and a message", not ok)
        ok, msg, _x = a.lms_announce_send(db, lnd, P, pk, "ZZLN s", "ZZLN m",
                                          send_at=(datetime.utcnow() + timedelta(hours=8) - timedelta(days=1))
                                          .strftime("%Y-%m-%d %H:%M"))
        s.check("never at a time already past", not ok)
        ok, msg, AID = a.lms_announce_send(db, lnd, P, pk, "ZZLN New: Negotiation", "ZZLN Two days on holding price.")
    s.check("sent now: its people recorded", ok and one("SELECT COUNT(*) FROM lms_announce_people WHERE announcement_id=?",
                                                        (AID,)) == 4 and one(
        "SELECT n_people||'/'||n_emailed FROM lms_announcements WHERE id=?", (AID,)) == "4/4")
    s.check("one email each, once, under its own batch", one(
        "SELECT COUNT(*) FROM email_outbox WHERE batch=? AND user_id IN (?,?,?,?)", ("lms-announce-%d" % AID, A, B, C,
                                                                                    Dp)) == 4 and
        one("SELECT COUNT(*) FROM lms_sent WHERE kind='announce' AND ref=?", ("ann:%d" % AID,)) == 4)
    body = one("SELECT body FROM email_outbox WHERE batch=? AND user_id=?", ("lms-announce-%d" % AID, A))
    s.check("...with the message and the runs with seats", "ZZLN Two days on holding price." in body and
            " left of " in body)
    s.check("logged", one("SELECT COUNT(*) FROM activity_log WHERE action='lms_announce' AND user_id=?", (LND,)) == 1)
    with a.app.app_context():
        lab = a._outbox_send(a.get_db(), "lms-announce-%d" % AID)["label"]
    s.check("the outbox's progress names it", lab == "Learning announcement: ZZLN New: Negotiation", lab)
    with a.app.app_context():
        db = a.get_db()
        acts = a.dash_learning(db, a._lms_user(db, A))["acts"]
    s.check("their dashboard: New, until they register", any(x["title"] == "New: ZZLN Negotiation" for x in acts))
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json) VALUES "
                   "(?,?,?, 'pending', '[]')", (A, S, P))
        db.commit()
        acts = a.dash_learning(db, a._lms_user(db, A))["acts"]
    s.check("...gone once they've registered", not any(x["title"].startswith("New: ZZLN") for x in acts))
    later = (datetime.utcnow() + timedelta(hours=8) + timedelta(days=2)).strftime("%Y-%m-%d") + " 09:00"
    with a.app.app_context():
        db = a.get_db()
        lnd = db.execute("SELECT * FROM users WHERE id=?", (LND,)).fetchone()
        ok, msg, AID2 = a.lms_announce_send(db, lnd, P, {"all": False, "bg": [], "bu": ["ZZLN U2"], "dept": [],
                                                         "grade": [], "jf": []}, "ZZLN later", "ZZLN m", send_at=later)
    s.check("sent at a time: stored in UTC, the emails wait for it", ok and one(
        "SELECT send_at FROM lms_announcements WHERE id=?", (AID2,)) ==
        (datetime.strptime(later, "%Y-%m-%d %H:%M") - timedelta(hours=8)).strftime("%Y-%m-%d %H:%M:%S") and one(
        "SELECT MIN(send_after) FROM email_outbox WHERE batch=?", ("lms-announce-%d" % AID2,)) >=
        (datetime.strptime(later, "%Y-%m-%d %H:%M") - timedelta(hours=8)).strftime("%Y-%m-%d %H:%M:%S"))
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM lms_announce_people WHERE announcement_id=? AND user_id=?", (AID, C))
        db.commit()
        acts = a.dash_learning(db, a._lms_user(db, C))["acts"]
    s.check("...and the dashboard row waits for it too", not any(x["title"].startswith("New: ZZLN") for x in acts) and
            one("SELECT COUNT(*) FROM lms_announce_people WHERE announcement_id=? AND user_id=?", (AID2, C)) == 1)

    s.section("the draft")
    a.ai_draft.is_configured = lambda: True
    a.ai_draft.lms_announce_draft = lambda facts, timeout=25: {"subject": "ZZLN AI subject", "message": "ZZLN AI msg"}
    with a.app.app_context():
        s.check("the AI's, from the programme", a.lms_announce_draft(a.get_db(), P) == ("ZZLN AI subject", "ZZLN AI msg"))

    def boom(facts, timeout=25):
        raise a.ai_draft.AIDraftError("x")
    a.ai_draft.lms_announce_draft = boom
    with a.app.app_context():
        s.check("a plain one when the AI fails", a.lms_announce_draft(a.get_db(), P)[0] == "New: ZZLN Negotiation")
    a.ai_draft.is_configured = lambda: False
    with a.app.app_context():
        s.check("...or isn't there", a.lms_announce_draft(a.get_db(), P)[0] == "New: ZZLN Negotiation")

    s.section("the page")
    _r = CL.get("/admin/learning/announce?pid=%d&who=pick&bg=%s" % (P, BG))
    pg = html.unescape(_r.get_data(as_text=True))
    import re as _re
    s.check("L&D sees the count before sending", "Announce a programme" in pg and "4 people" in pg and
            "already confirmed on a run: left out (1)" in pg,
            (_r.status_code, _re.sub(r"\s+", " ", pg[pg.find("lm-ann-count"):pg.find("lm-ann-count") + 300])))
    s.check("...under the programme's own name", "‹ ZZLN Negotiation" in pg and "built-in method" not in pg)
    s.check("...and what was sent before, with registrations since", "ZZLN New: Negotiation" in pg and
            "Registered since" in pg)
    r = CB.post("/admin/learning/announce", data={"csrf_token": "tok", "programme_id": P, "who": "all",
                                                 "subject": "x", "message": "y"})
    s.check("a BG admin can't send one", r.status_code == 403)
    s.check("the registry", a.ADMIN_ACCESS_MAP.get("admin_learning_announce") == "lms" and
            "lms_announce" in a.ACTION_LABELS)
finally:
    env(_ENV0)
    a.mailer.is_configured, a.ai_draft.is_configured, a.ai_draft.lms_announce_draft = _MAIL0, _AI0, _DRAFT0
    a.ai_draft.screen_message = _SCREEN0
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
sys.exit(s.done())
