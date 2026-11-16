"""AI+ Learning, phase 3 slice 2: the check-in schedule after training (plan OneHR/AI+ LMS/AI+ LMS plan 2026-10-20.md
§3.5, decision 6; Chris, 2026-10-21: "continue with the rest of the build").

What this suite holds:
  * the rule: 1 and 3 months for every programme (no 6-month one since 2026-10-23), from the course's last day (the same
    day n months on, or that month's last day); a course counts once they came (attended or part of it), an external
    one once L&D has checked its certificate (2026-10-23); absent counts for nothing
  * a person's own open check-ins (lms_eval_due): the 1- and 3-month ones fallen due and unanswered; a 1-month one is
    left behind once its 3-month one falls due; no 6-month one (Chris, 2026-10-23: "Remove the tick")
  * lms_auto: nothing where Learning is off; a row per check-in fallen due, once (a second run writes none, matched
    against an independent count); a check-in whose course was closed again as absent is voided; one email per person,
    in waves, only where the server sends email, never twice; without email (staging) the dashboard row is the reminder
  * send_reminders.py --auto runs it before its no-cycle stop
  * Learning > Settings: the open count and Run now for an L&D admin or the super admin (a BG admin can't)
  * the person's dashboard row ("Your 1-month check-in: ...", Check in) and the Mine page's Check-ins list
Everything here is synthetic (ZZLE / ZZ9LE-) and removed at the end.
"""
import os
import re
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning, phase 3: the check-in schedule after training")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG, CO = "ZZLE Group", "ZZLE U1"
_ENV0 = os.environ.get("ONEHR_LMS")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LE-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLE %'")
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM email_outbox WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM lms_registrations WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM lms_attendance WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE detail LIKE '%ZZLE%'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, mgr=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id, email, confirmation_date) VALUES "
                      "(?,?, 'x', 'user', ?,?,?, 'ZZLE Sales', 'ZZLE Officer', '15', ?, ?, '2020-01-01')",
                      (eid.lower(), "ZZ LE " + eid.split("-")[1], eid, BG, CO, mgr,
                       eid.lower() + "@example.invalid")).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    TODAY = a._today_myt()
    D = lambda n: (TODAY + timedelta(days=n)).isoformat()   # noqa: E731
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO))
    MGR = person(db, "ZZ9LE-MGR")
    E1 = person(db, "ZZ9LE-E1", MGR)      # came 40 days ago: the 1-month check-in is due
    E2 = person(db, "ZZ9LE-E2", MGR)      # came 100 days ago, a programme with 6 months: the 3-month one is due
    E3 = person(db, "ZZ9LE-E3", MGR)      # absent 40 days ago
    E4 = person(db, "ZZ9LE-E4", MGR)      # an external course that ended 40 days ago
    E5 = person(db, "ZZ9LE-E5", MGR)      # came 10 days ago: nothing due yet

    def prog(title, eff="1,3"):
        return db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, effectiveness) VALUES "
                          "(?, 'inhouse', 'published', 7, 1, ?)", (title, eff)).lastrowid
    P13, P136 = prog("ZZLE Negotiation"), prog("ZZLE Chemical Handling", "1,3,6")

    def sess(pid, end):
        return db.execute("INSERT INTO lms_sessions(programme_id, starts_on, ends_on) VALUES (?,?,?)",
                          (pid, end, end)).lastrowid
    S40, S100, S10 = sess(P13, D(-40)), sess(P136, D(-100)), sess(P13, D(-10))

    def reg(uid, sid, outcome, **kw):
        cols = ["user_id", "session_id", "status", "outcome", "hours", "chain_json"] + list(kw)
        vals = [uid, sid, "approved", outcome, 7 if outcome else None, "[]"] + list(kw.values())
        return db.execute("INSERT INTO lms_registrations(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                          vals).lastrowid
    R1 = reg(E1, S40, "attended")
    R2 = reg(E2, S100, "attended")
    R3 = reg(E3, S40, "absent")
    R4 = reg(E4, None, "attended", ext_title="ZZLE External Course", ext_provider="ZZLE Institute",
             ext_starts_on=D(-41), ext_ends_on=D(-40), checked_at="2026-10-01 09:00:00")   # its certificate checked
    R5 = reg(E5, S10, "partial")
    db.commit()
    PEOPLE = [MGR, E1, E2, E3, E4, E5]


def one(sql, args=()):
    return H.one(a, sql, args)


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


def run_auto(today=None):
    with a.app.test_request_context():
        return a.lms_auto(a.get_db(), today=today)


def due_of(uid):
    with a.app.test_request_context():
        return a.lms_eval_due(a.get_db(), [uid])[uid]


try:
    s.section("the rule")
    s.check("1 and 3 months always; a programme's old 6 asks no more (Chris, 2026-10-23)",
            (a.lms_eff_months("1,3"), a.lms_eff_months(""), a.lms_eff_months("1,3,6"), a.lms_eff_months("6"))
            == ((1, 3), (1, 3), (1, 3), (1, 3)))
    am = a._lms_add_months
    s.check("n months on, or that month's last day", (am(date(2026, 1, 31), 1), am(date(2026, 11, 30), 3),
                                                      am(date(2026, 12, 15), 1), am(date(2028, 1, 31), 1)) ==
            (date(2026, 2, 28), date(2027, 2, 28), date(2027, 1, 15), date(2028, 2, 29)))
    with a.app.test_request_context():
        plan = a.lms_eval_plan(a.get_db(), PEOPLE)
    got = sorted((e["user_id"], e["kind"]) for e in plan)
    s.check("who it asks for: came (all or part), or an external course checked; never the absent; 1 and 3 months "
            "only, even where a programme once asked 6 (Chris, 2026-10-23)",
            got == sorted([(E1, "m1"), (E1, "m3"), (E2, "m1"), (E2, "m3"), (E4, "m1"), (E4, "m3"),
                           (E5, "m1"), (E5, "m3")]), got)
    e1m1 = next(e for e in plan if e["user_id"] == E1 and e["kind"] == "m1")
    s.check("from the course's last day", e1m1["due_on"] == am(date.fromisoformat(D(-40)), 1).isoformat())

    s.section("a person's own open check-ins")
    s.check("E1: the 1-month one", [e["kind"] for e in due_of(E1)] == ["m1"] and due_of(E1)[0]["title"] == "ZZLE Negotiation")
    s.check("E2: the 3-month one only (the 1-month one is left behind)",
            [e["kind"] for e in due_of(E2)] == ["m3"])
    s.check("E4's external course: the 1-month one", [e["kind"] for e in due_of(E4)] == ["m1"])
    s.check("E3 (absent) and E5 (10 days ago): none", due_of(E3) == [] and due_of(E5) == [])

    s.section("lms_auto")
    env(None)
    s.check("nothing where Learning is off", run_auto() is None and
            one("SELECT COUNT(*) FROM lms_evaluations WHERE registration_id IN (?,?,?,?,?)", (R1, R2, R3, R4, R5)) == 0)
    env("1")
    a.mailer.is_configured, _mail0 = (lambda: False), a.mailer.is_configured
    r = run_auto()
    expect = 5   # E1 m1; E2 m1, m3 (the 6-month one is 100 days on, not due); E4 m1 -- and every due one, written
    with a.app.test_request_context():
        indep = sum(1 for e in a.lms_eval_plan(a.get_db(), None) if e["due_on"] <= TODAY.isoformat())
    mine = one("SELECT COUNT(*) FROM lms_evaluations WHERE registration_id IN (?,?,?,?,?)", (R1, R2, R3, R4, R5))
    s.check("a row per check-in fallen due", mine == 4 and r["created"] >= 4, (mine, r))
    s.check("...every due one on the server, matched against the rule's own count",
            one("SELECT COUNT(*) FROM lms_evaluations") >= indep and r["created"] <= indep, (indep, r["created"]))
    r2 = run_auto()
    s.check("a second run writes none", r2["created"] == 0 and
            one("SELECT COUNT(*) FROM lms_evaluations WHERE registration_id IN (?,?,?,?,?)", (R1, R2, R3, R4, R5)) == 4)
    s.check("no email here: none queued, people counted, the dashboard row tells them", r["mail"] is False and
            r["emailed"] == 0 and one("SELECT COUNT(*) FROM email_outbox WHERE user_id IN (?,?,?,?)", (E1, E2, E3, E4)) == 0)
    s.check("its words say so", "email isn't set up here" in a.lms_auto_words(r))
    a.mailer.is_configured = lambda: True
    r3 = run_auto()
    q = one("SELECT COUNT(*) FROM email_outbox WHERE user_id IN (?,?,?,?) AND kind='lms' AND batch LIKE 'lms-checkins-%'",
            (E1, E2, E3, E4))
    s.check("with email: one to each person with their own open check-in (E1, E2, E4)", q == 3 and r3["emailed"] >= 3, (q, r3))
    subj = one("SELECT subject FROM email_outbox WHERE user_id=? AND kind='lms'", (E1,))
    s.check("...named for the check-in and the course", subj == "Your 1-month check-in on ZZLE Negotiation", subj)
    s.check("...and marked told", one("SELECT COUNT(*) FROM lms_evaluations WHERE registration_id IN (?,?,?) AND "
                                      "kind IN ('m1','m3') AND status='due' AND nudged_at IS NULL", (R1, R2, R4)) == 0)
    s.check("E2's left-behind 1-month one is skipped, and their email is the 3-month one alone",
            one("SELECT status FROM lms_evaluations WHERE registration_id=? AND kind='m1'", (R2,)) == "skipped" and
            one("SELECT subject FROM email_outbox WHERE user_id=? AND kind='lms'", (E2,)) ==
            "Your 3-month check-in on ZZLE Chemical Handling")
    run_auto()
    s.check("never twice", one("SELECT COUNT(*) FROM email_outbox WHERE user_id IN (?,?,?,?) AND kind='lms'",
                               (E1, E2, E3, E4)) == q)
    a.mailer.is_configured = _mail0
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE lms_registrations SET outcome='absent', hours=0 WHERE id=?", (R1,))
        db.commit()
    r4 = run_auto()
    s.check("closed again as absent: its open check-in is voided", r4["voided"] >= 1 and
            one("SELECT status FROM lms_evaluations WHERE registration_id=? AND kind='m1'", (R1,)) == "void" and
            due_of(E1) == [])
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE lms_registrations SET outcome='attended', hours=7 WHERE id=?", (R1,))
        db.execute("UPDATE lms_evaluations SET status='due' WHERE registration_id=?", (R1,))
        db.commit()
    src = open(os.path.join(REPO, "send_reminders.py")).read()
    s.check("send_reminders.py --auto runs it before its no-cycle stop",
            0 < src.find("lms_auto(db)") < src.find("No active cycle"))

    s.section("Learning > Settings")
    CS = H.client_as(a, SU["id"])
    page = CS.get("/admin/learning/settings").get_data(as_text=True)
    s.check("the card: what it does and how many are open", "Check-ins after training" in page and
            re.search(r"Open now: <b>\d+</b>", page) and 'value="auto_run"' in page)
    r = CS.post("/admin/learning/settings", data={"csrf_token": "tok", "action": "auto_run"}, follow_redirects=True)
    s.check("Run now runs it and says what happened", r.status_code == 200 and "Learning check-ins:" in
            r.get_data(as_text=True) and one("SELECT COUNT(*) FROM activity_log WHERE action='lms_auto'") >= 1)
    if BGA is not None:
        CB = H.client_as(a, BGA["id"])
        s.check("a BG admin can't run it", CB.post("/admin/learning/settings", data={"csrf_token": "tok",
                                                                                   "action": "auto_run"}).status_code == 403)
    s.check("the form is double-confirmed", re.search(r'data-confirm="Open the check-ins[^"]*"[^>]*data-confirm-ok=', page))

    s.section("what the person sees")
    C1 = H.client_as(a, E1)
    mine_pg = C1.get("/learning").get_data(as_text=True)
    s.check("Mine lists the open check-in", 'id="checkins"' in mine_pg and "1-month check-in: ZZLE Negotiation" in mine_pg
            and "never part of your performance or potential rating" in mine_pg)
    s.check("...with a line in the queue that goes to it", re.search(r'data-go="check-\d+-m1"', mine_pg) is not None)
    with a.app.test_request_context():
        dl = a.dash_learning(a.get_db(), a._lms_user(a.get_db(), E1))
    act = next((x for x in (dl or {}).get("acts", []) if "check-in" in x["title"]), None)
    s.check("the dashboard's next step: 'Your 1-month check-in: ...', Check in, opening its own page (S9)", act and
            act["title"] == "Your 1-month check-in: ZZLE Negotiation" and act["button"] == "Check in" and
            act["url"].startswith("/learning/eval/") and act["url"].endswith("/m1"), act)
    with a.app.test_request_context():
        dl5 = a.dash_learning(a.get_db(), a._lms_user(a.get_db(), E5))
    s.check("...none for someone with nothing due", not any("check-in" in x["title"] for x in (dl5 or {}).get("acts", [])))
finally:
    env(_ENV0)
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
sys.exit(s.done())
