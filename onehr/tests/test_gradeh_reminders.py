"""Grade H Appraisal: reminders, the email schedule, the deadline bar and the release window (Chris, 2026-10-31: "Approve, build it";
canvas boards E1 Email schedule, E2 Grade H reminder emails, E3 Deadline bar).

What this suite holds:
  * LEADERS' items in Everyone's reminder (group "Grade H Appraisal"): the appraiser, the Grade H HOD and the BU CEO get one more item in
    the email they already get, only while their part is open and something waits; none with the server switch off, with Grade H unticked
    on the cycle, with the part closed, once everyone is submitted / signed off, or with the leader ability (lm.gradeh) switched off
  * the day rule: Grade H's parts follow reminder_why only where Grade H runs; a staff-only day sends no Everyone's reminder to the
    rest of the company (reminder_day_parts)
  * the recheck drops a leader who has acted by the time their wave comes; an email left with nothing in it is not sent
  * the DEADLINE BAR: leaders' Grade H lines (appraiser, HOD, BU CEO) in board E3's words, grey within the rules' days and red on the
    last day, on the dashboard and on the Grade H pages; Banner's Deadline reminder previews them; the staff line follows the deemed switch
  * the RELEASE WINDOW: where Grade H runs, its parts are a group on Admin > Notices; a ticked Grade H part's closing day and the evening
    before block a planned release; the notice emails go to the Grade H roles whose window is open (staff with a work email,
    appraisers, HODs, BU CEOs) and to nobody else; nothing of it with the switch off or Grade H unticked
  * KNOWLEDGE: the admin Help on the Email, Reminders and Notices pages says Grade H is in the reminders, the schedule, the bar and the
    release window (only where Grade H is on); All settings / the Admin Agent's row says "Grade H included"; the staff and leader
    answers (Help, Ask OneHR) say whether they get a reminder; none of it with the switch off
  * Grade H STAFF's own email (kind gradeh_reminder): the KPI achievement and acknowledge cases, EN and BM on the person's own
    language, the amber deemed line only while the switch is on, only people with a work email and something waiting (a person
    with none is counted "bar only"), the day rule, one email for a supervisor who is also a leader, the recheck
Synthetic (ZZ9GR-*) on a fresh scratch database; the suite puts back what it changes.
"""
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, time as dtime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H Appraisal: reminders, the schedule, the bar and the release window")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SU, BGA, EMP = H.actors(a)
PFX, BG, CO, CO2 = "ZZ9GR-", "ZZGR Group", "ZZGR Unit A", "ZZGR Unit B"
U, P = {}, {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
# This suite is about the leaders' lines in Everyone's reminder by their own rules. The one-email rule (a leader who gets Grade H progress that
# day loses these lines, 2026-11-09) is tests/test_gradeh_leader_email.py's: here nobody is served by progress, so the lines read as they did.
a.gradeh_prog_served = lambda *x, **k: {}

db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")


def one(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return r[0] if r else None


def run(fn):
    with a.app.test_request_context("/", base_url=a.app_base_url()):
        d = a.get_db()
        r = fn(d)
        d.commit()
        return r


def text(resp):
    h = resp.get_data(as_text=True)
    h = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", h)
    m = re.search(r'<main id="main"[\s\S]*', h)
    h = m.group(0) if m else h
    h = re.sub(r"<[^>]+>", " ", h)
    return " ".join(h.replace("&#39;", "'").replace("&amp;", "&").replace("&quot;", '"').split())


def csrf(**kw):
    d = {"csrf_token": "tok"}
    d.update(kw)
    return d


def mk(k, grade="H", mgr=None, hod=None, co=CO, email="auto", dept="ZZGR Dept"):
    em = (PFX + k).lower() + "@zzgr.example" if email == "auto" else email
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, job_title, manager_id, hod_id, email, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?,?,?, 'Driver', ?,?,?, "
        "'2020-01-01')", ((PFX + k).lower(), "ZZ GR " + k, PFX + k, BG, co, dept, grade, mgr, hod, em)).lastrowid


def person(k, route="B", lang="en", appraiser=None, submitted=False, staff_sent=False, ack=None, lm_at="2026-11-10 02:00:00"):
    pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, appraiser_id, language, language_set_at) "
                     "VALUES (?,?,?,?,?,?, datetime('now'))", (CID, PFX + k, U[k], route, appraiser, lang)).lastrowid
    P[k] = pid
    db.execute("INSERT INTO gradeh_appraisals (cycle_id, person_id, staff_submitted_at, lm_submitted_at, perf_band, pot_band, "
               "acknowledged_at) VALUES (?,?,?,?,?,?,?)",
               (CID, pid, "2026-11-01 02:00:00" if staff_sent else None, lm_at if submitted else None,
                "ME" if submitted else None, "Mid" if submitted else None, ack))
    return pid


def lines_for(pid, spec=(("ZZ Alpha", 60), ("ZZ Beta", 40))):
    for i, (name, w) in enumerate(spec, 1):
        db.execute("INSERT INTO gradeh_kpi_lines (cycle_id, person_id, kpi_name, weight, group_scale, sort_order) "
                   "VALUES (?,?,?,?, 'FIAMMA', ?)", (CID, pid, name, w, i))


def urow(k):
    return db.execute("SELECT * FROM users WHERE id=?", (U[k],)).fetchone()


def set_window(cell, opens=None, closes=None):
    db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell, opens, closes))
    db.commit()


def day(n):
    return a._today_myt() + timedelta(days=n)


def win(cell, open_n, close_n):
    """The cell open from `open_n` days from today (MYT), closing `close_n` days from today at 23:59."""
    set_window(cell, day(open_n).isoformat() + " 00:00", day(close_n).isoformat() + " 23:59")


def clear_windows():
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    db.commit()


def module(on):
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', ?)", (CID, 1 if on else 0))
    db.commit()


def gh_items(k):
    return [i for i in run(lambda d: a.reminder_items(d, urow(k))) if i["group"] == "gradeh"]


def setting(name, value):
    run(lambda d: a.gradeh_set_setting(d, name, value, None))


def clear_settings():
    db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
    db.commit()


def ability(role, key, allowed):
    db.execute("INSERT OR REPLACE INTO leader_role_access(role, ability, allowed) VALUES (?,?,?)", (role, key, 1 if allowed else 0))
    db.commit()


def ability_clear():
    db.execute("DELETE FROM leader_role_access WHERE ability LIKE '%.gradeh'")
    db.commit()


if True:
    CID = run(lambda d: a.active_cycle_id(d))
    HALF0, OBD0 = [db.execute("SELECT half, open_by_date FROM cycles WHERE id=?", (CID,)).fetchone()[k] for k in ("half", "open_by_date")]
    db.execute("UPDATE cycles SET half=2, open_by_date=1 WHERE id=?", (CID,))
    module(True)
    for c_ in (CO, CO2):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, c_))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    clear_settings()
    # --- leaders: M1 appraises S1 (Route B, to do), S2 (Route A, KPI not sent: waiting for them), S3 (submitted)
    U["M1"] = mk("M1", "15")
    U["S1"] = mk("S1", mgr=U["M1"])
    U["S2"] = mk("S2", mgr=U["M1"])
    U["S3"] = mk("S3", mgr=U["M1"])
    person("S1", "B", appraiser=U["M1"])
    person("S2", "A", appraiser=U["M1"])
    lines_for(P["S2"])
    person("S3", "B", appraiser=U["M1"], submitted=True)
    # a second appraiser with only a submitted person, and one with the ability switched off for the seat
    U["M2"] = mk("M2", "15")
    U["S4"] = mk("S4", mgr=U["M2"])
    person("S4", "B", appraiser=U["M2"], submitted=True)
    # an HOD (H1) over two Grade H people, and a BU CEO (B1) over a unit with them
    U["B1"] = mk("B1", "21", dept="ZZGR Division")
    U["H1"] = mk("H1", "19", hod=U["B1"], dept="ZZGR Dept One")
    U["S5"] = mk("S5", hod=U["H1"], dept="ZZGR Dept One")
    U["S6"] = mk("S6", hod=U["H1"], dept="ZZGR Dept One")
    person("S5", "B")
    person("S6", "B", submitted=True)
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, U["B1"]))
    db.commit()
    # --- Grade H staff: K1/K2 (Route A, KPI not sent, EN/BM), K3 (the same with no work email), K4 (KPI sent, waiting for the
    #     line manager), A1/A2 (the line manager has submitted, EN/BM), A3 (acknowledged), X1 (a Grade H person who is also
    #     an appraiser: a supervisor-leader)
    U["M3"] = mk("M3", "15")   # the staff's appraiser: kept apart from M1 / M2, whose counts the first sections read
    for k_, lang_ in (("K1", "en"), ("K2", "bm"), ("K3", "en"), ("K4", "en"), ("A1", "en"), ("A2", "bm"), ("A3", "en"), ("X1", "en")):
        U[k_] = mk(k_, email=None if k_ == "K3" else "auto")
    one_day_ago = (datetime.utcnow() - timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
    for k_, lang_ in (("K1", "en"), ("K2", "bm"), ("K3", "en"), ("K4", "en"), ("X1", "en")):
        person(k_, "A", lang_, appraiser=U["M3"], staff_sent=(k_ == "K4"))
        lines_for(P[k_])
    for k_, lang_, ack_ in (("A1", "en", None), ("A2", "bm", None), ("A3", "en", "2026-11-01 02:00:00")):
        person(k_, "B", lang_, appraiser=U["M3"], submitted=True, lm_at=one_day_ago, ack=ack_)
    # X1 appraises SX (not yet submitted): so X1 has a leader item too
    U["SX"] = mk("SX")
    person("SX", "B", "en", appraiser=U["X1"])
    db.commit()
CIDS = None
C = {}


def case_of(k):
    return run(lambda d: a.gradeh_staff_case(d, d.execute("SELECT * FROM gradeh_people WHERE id=?", (P[k],)).fetchone(), CID))


def rem_settings(days=(3, 1), on_open=True):
    for k_, v_ in (("reminder_days_before", json.dumps(list(days))), ("reminder_on_open", "1" if on_open else "0"),
                   ("reminder_every_days", "0"), ("reminder_auto_enabled", "1")):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES (?,?)", (k_, v_))
    db.commit()


def fixed_deemed(n_days_from_today, on=True):
    """The deemed switch, with a fixed deadline at 23:59 MYT that many days out (stored UTC)."""
    t = datetime.combine(day(n_days_from_today), datetime.min.time()).replace(hour=15, minute=59)   # 23:59 MYT
    setting("gradeh_deemed_on", bool(on))
    setting("gradeh_deemed_mode", "fixed")
    setting("gradeh_deemed_at", t.strftime("%Y-%m-%d %H:%M:%S"))


def queue(keys, **kw):
    def go(d):
        cyc = a.active_cycle(d)
        rows = [d.execute("SELECT * FROM users WHERE id=?", (U[k],)).fetchone() for k in keys]
        return a.reminder_send(d, cyc, rows, "ZZGR test", live=True, **kw)
    return run(go)


def outbox(k=None, kind=None):
    q, args = "SELECT * FROM email_outbox WHERE 1=1", []
    if k:
        q += " AND user_id=?"
        args.append(U[k])
    if kind:
        q += " AND kind=?"
        args.append(kind)
    return db.execute(q + " ORDER BY id", args).fetchall()


def wipe_mail():
    db.execute("DELETE FROM email_outbox")
    db.execute("DELETE FROM notifications")
    db.commit()


def restore():
    os.environ["ONEHR_GRADEH"] = _ENV0 if _ENV0 is not None else ""
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    db.execute("UPDATE cycles SET half=?, open_by_date=? WHERE id=?", (HALF0, OBD0, CID))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%' OR key IN ('release_window','deadline_reminder')")
    db.execute("DELETE FROM site_notices")
    db.execute("DELETE FROM email_outbox")
    db.execute("DELETE FROM leader_role_access WHERE ability LIKE '%.gradeh'")
    db.commit()


try:
    # ================================================================ 1. leaders' items
    s.section("leaders' Grade H items in Everyone's reminder")
    clear_windows()
    s.check("the control: with every Grade H part undated (and the cycle opening by date) nobody has a Grade H item",
            not any(gh_items(k) for k in ("M1", "H1", "B1")))
    win("gradeh_lm", -1, 3)
    it = gh_items("M1")
    s.check("the appraiser gets ONE item while the appraisal part is open and someone is not yet submitted",
            len(it) == 1 and it[0]["text"] == "Appraise your Grade H team" and it[0]["role"] == "gradeh_lm", it)
    s.check("...its detail counts who is ready and who waits for their KPI achievement (S1 ready, S2 waiting, S3 done)",
            it and it[0]["detail"] == "1 ready for you · 1 waiting for their KPI achievement", it and it[0]["detail"])
    s.check("...its close date is the part's close, and it opens the Grade H team page",
            it and it[0]["closes_on"] == day(3) and it[0]["url"] == "/review/gradeh", it and (it[0]["closes_on"], it[0]["url"]))
    s.check("an appraiser whose people are all submitted has none (nothing waits on them)", gh_items("M2") == [])
    s.check("a person who appraises nobody has none", gh_items("S1") == [])
    # the email lists it under the group's own label, beside everything else
    subj, html_ = run(lambda d: a.reminder_mail(urow("M1"), a.reminder_items(d, urow("M1")), a.active_cycle(d), db=d))
    s.check("the email carries it under 'GRADE H APPRAISAL' with the people it counts and when it closes",
            "Grade H Appraisal" in html_ and "Appraise your Grade H team" in html_ and "1 ready for you" in html_
            and "1 thing is" in html_, subj)

    s.section("the HOD and the BU CEO")
    win("gradeh_hod_pot", -1, 4)
    win("gradeh_hod_perf", -1, 4)
    win("gradeh_buceo", -1, 6)
    it = gh_items("H1")
    s.check("the Grade H HOD gets one item while a review stage is open and unsigned",
            len(it) == 1 and it[0]["text"] == "Review your Grade H people: potential, then performance"
            and it[0]["role"] == "gradeh_hod" and it[0]["url"] == "/calibration/gradeh/hod", it)
    it = gh_items("B1")
    s.check("the BU CEO gets one item per unit, while the sign-off is open and the unit is not signed off",
            len(it) == 1 and it[0]["text"] == "Sign off Grade H for %s" % run(lambda d: a.display_company(BG, CO))
            and it[0]["role"] == "gradeh_buceo" and it[0]["closes_on"] == day(6), it)
    db.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?,?,?,?,?)",
               (CID, "hod", "pot", str(U["H1"]), U["H1"]))
    db.commit()
    s.check("an HOD who has signed off potential still has performance to do: the item stays",
            len(gh_items("H1")) == 1)
    db.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?,?,?,?,?)",
               (CID, "hod", "perf", str(U["H1"]), U["H1"]))
    db.commit()
    s.check("...and none once both stages are signed off", gh_items("H1") == [])
    db.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?,?,?,?,?)",
               (CID, "buceo", "all", CO, U["B1"]))
    db.commit()
    s.check("a BU CEO whose unit is signed off has none", gh_items("B1") == [])
    db.execute("DELETE FROM gradeh_signoffs WHERE cycle_id=?", (CID,))
    db.commit()

    s.section("absent when it should be: part closed, flag off, unticked, ability off")
    win("gradeh_lm", -9, -2)
    s.check("a closed appraisal part: no appraiser item", gh_items("M1") == [])
    win("gradeh_lm", 2, 5)
    s.check("a part not open yet: none", gh_items("M1") == [])
    win("gradeh_lm", -1, 3)
    s.check("the control: open again, back", len(gh_items("M1")) == 1)
    os.environ["ONEHR_GRADEH"] = "0"
    s.check("server switch off: no Grade H item for any leader", not any(gh_items(k) for k in ("M1", "H1", "B1")))
    os.environ["ONEHR_GRADEH"] = "1"
    module(False)
    s.check("Grade H unticked on the cycle: none", not any(gh_items(k) for k in ("M1", "H1", "B1")))
    module(True)
    ability("lm", "lm.gradeh", False)
    s.check("a leader whose lm.gradeh ability is off gets no appraiser item", gh_items("M1") == [])
    ability_clear()
    ability("hod", "hod.gradeh", False)
    s.check("...nor an HOD with hod.gradeh off", gh_items("H1") == [])
    ability_clear()
    ability("bu", "bu.gradeh", False)
    s.check("...nor a BU CEO with bu.gradeh off", gh_items("B1") == [])
    ability_clear()
    s.check("the control: abilities back, all three items back", all(len(gh_items(k)) == 1 for k in ("M1", "H1", "B1")))

    s.section("the day rule: Grade H's parts follow reminder_why only where Grade H runs")
    clear_windows()
    win("gradeh_kpi", 0, 6)
    win("gradeh_lm", 0, 9)
    rules = dict(run(lambda d: a.reminder_rules()), enabled=True, on_open=True, days_before=[3, 1], every_days=0, every_from=None, every_to=None)
    today = a._today_myt()
    why = run(lambda d: a.reminder_why(d, a.active_cycle(d), today, rules))
    s.check("the day Grade H parts open is a send day, for both (the KPI achievement and the appraisal)",
            {c for k, c, _w in why if k == "open"} >= {"gradeh_kpi", "gradeh_lm"}, why)
    parts = run(lambda d: a.reminder_day_parts(d, a.active_cycle(d), today, rules))
    s.check("...it sends Everyone's reminder (the appraisal is a leaders' part) and the staff's own email", parts == {"regular": True, "staff": True}, parts)
    why3 = run(lambda d: a.reminder_why(d, a.active_cycle(d), day(3), rules))
    s.check("3 days before the KPI part closes: a last call", ("close", "gradeh_kpi") in {(k, c) for k, c, _w in why3}, why3)
    p3 = run(lambda d: a.reminder_day_parts(d, a.active_cycle(d), day(3), rules))
    s.check("...and it is a STAFF day only: Everyone's reminder is not sent to the rest of the company that day", p3 == {"regular": False, "staff": True}, p3)
    p6 = run(lambda d: a.reminder_day_parts(d, a.active_cycle(d), day(6), rules))
    s.check("3 days before the appraisal closes: a leaders' last call (regular, no staff)", p6 == {"regular": True, "staff": False}, p6)
    module(False)
    s.check("Grade H unticked: no Grade H reason on any of those days",
            all(not run(lambda d, n=n: a.reminder_why(d, a.active_cycle(d), day(n), rules)) for n in (0, 3, 6)))
    os.environ["ONEHR_GRADEH"] = "0"
    module(True)
    s.check("server switch off: the same",
            all(not run(lambda d, n=n: a.reminder_why(d, a.active_cycle(d), day(n), rules)) for n in (0, 3, 6)))
    os.environ["ONEHR_GRADEH"] = "1"

    # ================================================================ 2. queued, then worked out again before it sends
    s.section("the recheck: a leader who has acted by their wave is dropped; an email with nothing left is not sent")
    clear_windows()
    win("gradeh_lm", -1, 3)   # close - 3 days = today: a leader's day (2026-11-06: the email goes only on a leader's three days)
    win("gradeh_hod_pot", 0, 4)   # opens today: the HOD's first day
    win("gradeh_hod_perf", 0, 4)
    db.execute("DELETE FROM email_outbox")
    db.execute("DELETE FROM notifications")
    db.commit()

    def queue_for(k):
        def go(d):
            cyc = a.active_cycle(d)
            return a.reminder_send(d, cyc, [d.execute("SELECT * FROM users WHERE id=?", (U[k],)).fetchone()], "ZZGR test", live=True)
        return run(go)
    t_ = queue_for("M1")
    row = db.execute("SELECT * FROM email_outbox WHERE user_id=? AND kind=?", (U["M1"], a.REMINDER_KIND)).fetchone()
    s.check("a reminder queues for the appraiser, with the Grade H item in it", t_["queued"] == 1 and row
            and "Appraise your Grade H team" in row["body"], t_)
    # S1 is submitted by the time the wave comes: the 'ready' count falls, the item stays (S2 still waits)
    db.execute("UPDATE gradeh_appraisals SET lm_submitted_at='2026-11-10 02:00:00', perf_band='ME', pot_band='Mid' WHERE person_id=?", (P["S1"],))
    db.commit()
    got = run(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (row["id"],)).fetchone()))
    s.check("someone ready in between: the email is written again from what waits now (0 ready, the KPI waiter stays)",
            got is not None and "waiting for their KPI achievement" in got["body"] and "1 ready for you" not in got["body"], got and got["body"][:80])
    db.execute("UPDATE gradeh_appraisals SET lm_submitted_at='2026-11-10 02:00:00', perf_band='ME', pot_band='Mid' WHERE person_id=?", (P["S2"],))
    db.commit()
    got = run(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (row["id"],)).fetchone()))
    st = db.execute("SELECT status, error FROM email_outbox WHERE id=?", (row["id"],)).fetchone()
    s.check("everyone submitted by then: nothing is sent (cancelled, 'nothing pending when its wave came')",
            got is None and st["status"] == "cancelled" and st["error"] == a.REMINDER_NOTHING_LEFT, dict(st))
    db.execute("UPDATE gradeh_appraisals SET lm_submitted_at=NULL, perf_band=NULL, pot_band=NULL WHERE person_id IN (?,?)", (P["S1"], P["S2"]))
    db.commit()
    # the HOD and BU CEO the same way: a sign-off between queueing and sending drops the item
    t_ = queue_for("H1")
    rowh = db.execute("SELECT * FROM email_outbox WHERE user_id=? AND kind=?", (U["H1"], a.REMINDER_KIND)).fetchone()
    s.check("a reminder queues for the HOD", t_["queued"] == 1 and rowh and "Review your Grade H people" in rowh["body"], t_)
    for stg in ("pot", "perf"):
        db.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?,?,?,?,?)",
                   (CID, "hod", stg, str(U["H1"]), U["H1"]))
    db.commit()
    got = run(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (rowh["id"],)).fetchone()))
    s.check("the HOD signs off both stages before their wave: not sent", got is None
            and one("SELECT status FROM email_outbox WHERE id=?", (rowh["id"],)) == "cancelled")
    db.execute("DELETE FROM gradeh_signoffs WHERE cycle_id=?", (CID,))
    db.execute("DELETE FROM email_outbox")
    db.commit()

    # ================================================================ 3. Grade H staff's own email
    s.section("what waits on a Grade H person: the KPI achievement, or acknowledging")
    clear_windows()
    win("gradeh_kpi", -1, 3)
    win("gradeh_lm", -1, 3)
    win("gradeh_ack", -1, 5)
    fixed_deemed(4)
    c1, c2, c3, c4 = case_of("K1"), case_of("K2"), case_of("K3"), case_of("K4")
    s.check("Route A, KPI not sent, the part open: the KPI case, closing at the part's close",
            c1 and c1["case"] == "kpi" and c1["closes"].date() == day(3) and (c1["closes"].hour, c1["closes"].minute) == (23, 59), c1)
    s.check("...nothing for someone who has sent it (K4)", c4 is None)
    a1, a3 = case_of("A1"), case_of("A3")
    s.check("the line manager has submitted, nobody has acknowledged, acknowledge open: the acknowledge case, by the earlier of the "
            "deemed deadline (day 4) and the part's close (day 5)",
            a1 and a1["case"] == "ack" and a1["closes"].date() == day(4) and a1["deemed"] and a1["deemed"].date() == day(4), a1)
    s.check("...nothing once acknowledged (A3)", a3 is None)
    fixed_deemed(9)
    s.check("a deemed date later than the part's close: the part's close is the date they must act by (day 5), the deemed one is still named",
            case_of("A1")["closes"].date() == day(5) and case_of("A1")["deemed"].date() == day(9))
    fixed_deemed(-1)
    s.check("a deadline that has passed (the deemed date was yesterday): nothing waits to be reminded of", case_of("A1") is None)
    fixed_deemed(4, on=False)
    s.check("the switch off: no deemed date at all, and the date is the part's close",
            case_of("A1")["closes"].date() == day(5) and case_of("A1")["deemed"] is None)
    fixed_deemed(4)
    win("gradeh_kpi", 2, 5)
    s.check("the KPI part not open yet: no KPI case", case_of("K1") is None)
    win("gradeh_kpi", -9, -2)
    s.check("...closed: none", case_of("K1") is None)
    win("gradeh_kpi", -1, 3)
    s.check("...open again: back", case_of("K1") is not None)
    set_window("gradeh_kpi", day(-1).isoformat() + " 00:00", None)
    s.check("a KPI part with no close date has no date to name: no case, so no email", case_of("K1") is None)
    win("gradeh_kpi", -1, 3)

    s.section("the words: English and Bahasa Melayu, the KPI and acknowledge cases")
    def mail(k, lang, case):
        return run(lambda d: a._gradeh_reminder_mail(d, d.execute("SELECT * FROM users WHERE id=?", (U[k],)).fetchone(), lang, case, "2026 Year-End"))
    fixed_deemed(4)
    kc, ac = case_of("K1"), case_of("A1")
    sub_en, h_en = mail("K1", "en", kc)
    sub_bm, h_bm = mail("K2", "bm", kc)
    want_en = a.gh_day_words(kc["closes"], "en")
    want_bm = a.gh_day_words(kc["closes"], "bm")
    s.check("the KPI email in English: the board's subject with the day, the heading, the sub line, the 11:59 pm close and the button",
            sub_en == "Reminder: your KPI achievement closes %s" % want_en and "My Appraisal" in h_en
            and "Your KPI achievement has not been sent" in h_en and "closes on %s, 11:59 pm" % want_en in h_en.replace("&amp;", "&")
            and "Open My Appraisal" in h_en, sub_en)
    s.check("...and in Bahasa Melayu: the board's words, 'malam' for 11:59, the BM button",
            sub_bm == "Peringatan: pencapaian KPI anda ditutup %s" % want_bm and "Penilaian Saya" in h_bm
            and "Pencapaian KPI anda belum dihantar" in h_bm and "11:59 malam" in h_bm and "Buka Penilaian Saya" in h_bm, sub_bm)
    s.check("...BM weekdays are Malay (the board's 'Ahad' for a Sunday), English ones are not",
            a.gh_day_words(datetime(2026, 11, 29, 23, 59), "bm") == "Ahad 29 Nov" and a.gh_day_words(datetime(2026, 11, 29, 23, 59), "en") == "Sun 29 Nov"
            and a.gh_day_words(datetime(2026, 12, 11, 23, 59), "bm", time=True) == "Jum 11 Dis, 11:59 malam")
    s.check("a link only: no band, rating or comment is in it, and the only name is the person's own",
            not re.search(r"\b(Unacceptable|Below Expectation|Meets Expectation|Outstanding|potential|rating)\b", h_en)
            and "Hi Zz Gr K1," in h_en and "Zz Gr K2" not in h_en and "/my-appraisal" in h_en, None)
    sub_ack, h_ack = mail("A1", "en", ac)
    s.check("the acknowledge email in English, switch on: the subject, the opening, and the amber 'treated as acknowledged' line with the date and time",
            sub_ack == "Reminder: acknowledge your appraisal by %s" % a.gh_day_words(ac["closes"], "en")
            and "Your appraisal is ready to read" in h_ack and "acknowledge it on My Appraisal" in h_ack
            and "we will treat it as you have acknowledged your result" in h_ack and "11:59 pm" in h_ack and "#fdf3df" in h_ack, sub_ack)
    sub_ack_bm, h_ack_bm = mail("A2", "bm", ac)
    s.check("...in Bahasa Melayu the same, with the amber line", sub_ack_bm.startswith("Peringatan: sahkan penilaian anda sebelum")
            and "dianggap telah anda sahkan" in h_ack_bm and "#fdf3df" in h_ack_bm, sub_ack_bm)
    fixed_deemed(4, on=False)
    ac_off = case_of("A1")
    _s, h_off = mail("A1", "en", ac_off)
    _s2, h_off_bm = mail("A2", "bm", ac_off)
    s.check("the deemed switch off: the amber line is gone, in both languages, and the rest of the email stays",
            "we will treat it" not in h_off and "#fdf3df" not in h_off and "dianggap telah anda sahkan" not in h_off_bm
            and "acknowledge it on My Appraisal" in h_off, None)
    fixed_deemed(4)
    s.check("a case with a deemed date but the template's amber field emptied shows no amber either (the field is the words)",
            "#fdf3df" not in run(lambda d: a._gradeh_reminder_mail(d, d.execute("SELECT * FROM users WHERE id=?", (U["A1"],)).fetchone(), "en", ac, "Y",
                                                                       tpl=dict(a.GRADEH_REMINDER_TPL_DEFAULT, deemed_ack="")))[1])
    s.check("a template's own words are the ones used (EN subject changed, BM left alone)",
            run(lambda d: a._gradeh_reminder_mail(d, d.execute("SELECT * FROM users WHERE id=?", (U["K1"],)).fetchone(), "en", kc, "Y",
                                                  tpl=dict(a.GRADEH_REMINDER_TPL_DEFAULT, subject="ZZGR new {closes}")))[0].startswith("ZZGR new ")
            and run(lambda d: a._gradeh_reminder_mail(d, d.execute("SELECT * FROM users WHERE id=?", (U["K2"],)).fetchone(), "bm", kc, "Y",
                                                      tpl=dict(a.GRADEH_REMINDER_TPL_DEFAULT, subject="ZZGR new {closes}")))[0].startswith("Peringatan"))

    s.section("who it goes to, on which days, and in which language")
    rem_settings((3, 1))
    wipe_mail()
    t_ = queue(["K1", "K2", "K3", "K4", "A1", "A2", "A3"], regular=False, gh_staff="day")
    got = {k: outbox(k, a.GRADEH_REMINDER_KIND) for k in ("K1", "K2", "K3", "K4", "A1", "A2", "A3")}
    s.check("the KPI part closes in 3 days (a last call): K1 and K2 are queued their own email; K3 (no work email), K4 (sent) and A3 (acknowledged) are not",
            len(got["K1"]) == 1 and len(got["K2"]) == 1 and not got["K3"] and not got["K4"] and not got["A3"], {k: len(v) for k, v in got.items()})
    s.check("...K1's in English, K2's in Bahasa Melayu, each to their own address",
            got["K1"] and got["K1"][0]["subject"].startswith("Reminder: your KPI") and got["K1"][0]["to_email"] == (PFX + "K1").lower() + "@zzgr.example"
            and got["K2"] and got["K2"][0]["subject"].startswith("Peringatan: pencapaian KPI"))
    s.check("...A1 and A2 (to acknowledge by day 4: a last call is 3 / 1 days before, so not today) are not",
            not got["A1"] and not got["A2"])
    s.check("K3 is logged as skipped for no work email, and is not counted as nothing waiting",
            db.execute("SELECT COUNT(*) FROM notifications WHERE user_id=? AND status='skipped' AND detail='no email on file'", (U["K3"],)).fetchone()[0] == 1)
    s.check("a staff-only day sends nobody Everyone's reminder (the leaders' items stay out of it)", not outbox(None, a.REMINDER_KIND), len(outbox(None, a.REMINDER_KIND)))
    wipe_mail()
    t_ = queue(["M1"], regular=False, gh_staff="day")
    s.check("...and a leader with a Grade H item (M1) is not emailed on a staff-only day (regular False)", not outbox("M1"), len(outbox("M1")))
    t_ = queue(["M1"], regular=True, gh_staff="day")
    s.check("...while on a regular day the same leader is (the control)", len(outbox("M1", a.REMINDER_KIND)) == 1)
    wipe_mail()
    t_ = queue(["K1", "K2", "K3", "K4", "A1", "A2", "A3"], regular=False, gh_staff="day")
    s.check("...and the batch reads as 'Grade H reminder' on Email › Sent",
            run(lambda d: a._outbox_send(d, outbox("K1")[0]["batch"]))["label"].startswith("Grade H reminder"))
    wipe_mail()
    win("gradeh_kpi", -1, 6)
    t_ = queue(["K1", "K2"], regular=False, gh_staff="day")
    s.check("KPI part closing in 6 days (not a rule day, not its opening day): nobody is emailed", not outbox(), len(outbox()))
    win("gradeh_kpi", 0, 6)
    t_ = queue(["K1", "K2"], regular=False, gh_staff="day")
    s.check("...the day it opens: both are (on-open rule)", len(outbox(None, a.GRADEH_REMINDER_KIND)) == 2, len(outbox()))
    wipe_mail()
    rem_settings((3, 1), on_open=False)
    t_ = queue(["K1", "K2"], regular=False, gh_staff="day")
    s.check("...with the on-open rule off: not", not outbox(), len(outbox()))
    rem_settings((3, 1))
    wipe_mail()
    win("gradeh_kpi", -1, 3)
    win("gradeh_ack", -1, 5)
    fixed_deemed(3)
    t_ = queue(["A1", "A2", "K1"], regular=False, gh_staff="day")
    s.check("acknowledging: the deemed deadline (day 3) is the earlier of the two, so today is its 3-days-before call: A1 and A2 are queued",
            len(outbox("A1", a.GRADEH_REMINDER_KIND)) == 1 and len(outbox("A2", a.GRADEH_REMINDER_KIND)) == 1)
    s.check("...A2's in Bahasa Melayu, with the amber line",
            "dianggap telah anda sahkan" in outbox("A2", a.GRADEH_REMINDER_KIND)[0]["body"]
            and "we will treat it" in outbox("A1", a.GRADEH_REMINDER_KIND)[0]["body"])
    wipe_mail()
    fixed_deemed(3, on=False)
    t_ = queue(["A1"], regular=False, gh_staff="day")
    s.check("the switch off: the deadline is the part's close (day 5), so today (day 0) is not a last call: nothing is queued", not outbox())
    win("gradeh_ack", -1, 3)
    t_ = queue(["A1"], regular=False, gh_staff="day")
    s.check("...the part closing in 3 days: it is, and the email has no amber line",
            len(outbox("A1", a.GRADEH_REMINDER_KIND)) == 1 and "#fdf3df" not in outbox("A1")[0]["body"])
    wipe_mail()
    win("gradeh_ack", -1, 5)
    fixed_deemed(4)
    t_ = queue(["K1", "A1", "K3"], regular=False, gh_staff="all")
    s.check("Send now ('all'): everyone with something waiting and an address, whatever the day, one email each",
            len(outbox("K1")) == 1 and len(outbox("A1")) == 1 and not outbox("K3"))
    t_ = queue(["K1", "A1"], regular=False, gh_staff="all")
    s.check("...and once a day: a second run inside the cooldown queues nobody again", len(outbox("K1")) == 1 and len(outbox("A1")) == 1)
    wipe_mail()
    t_ = queue(["K1"], regular=False, gh_staff=None)
    s.check("no Grade H pass (gh_staff None): the staff are not emailed", not outbox())
    os.environ["ONEHR_GRADEH"] = "0"
    t_ = queue(["K1", "A1"], regular=False, gh_staff="all")
    s.check("the server switch off: no Grade H email, whatever is asked", not outbox())
    os.environ["ONEHR_GRADEH"] = "1"
    module(False)
    t_ = queue(["K1", "A1"], regular=False, gh_staff="all")
    s.check("Grade H unticked on the cycle: none either", not outbox())
    module(True)

    s.section("one email: a supervisor who is also a leader")
    wipe_mail()
    win("gradeh_kpi", -1, 3)
    win("gradeh_lm", -1, 3)
    t_ = queue(["X1"], regular=True, gh_staff="day")
    rows_ = outbox("X1")
    s.check("a Grade H person who also appraises someone, on a day the leader email goes: ONE email in all",
            len(rows_) == 1 and rows_[0]["kind"] == a.REMINDER_KIND, [r["kind"] for r in rows_])
    s.check("...it is the leader email, with the appraisal item and their own KPI item added, in the Grade H group",
            "Appraise your Grade H team" in rows_[0]["body"] and "Enter your KPI achievement" in rows_[0]["body"]
            and "2 things you need to do" in rows_[0]["subject"] and rows_[0]["body"].count("Grade H Appraisal") >= 1, rows_[0]["subject"])
    s.check("...and no staff email beside it", not outbox("X1", a.GRADEH_REMINDER_KIND))
    wipe_mail()
    t_ = queue(["X1"], regular=False, gh_staff="day")
    rows_ = outbox("X1")
    s.check("a day only the staff email goes (no leader email that day): their own staff email, in their language, one email",
            len(rows_) == 1 and rows_[0]["kind"] == a.GRADEH_REMINDER_KIND, [r["kind"] for r in rows_])
    wipe_mail()
    t_ = queue(["M2"], regular=True, gh_staff="day")
    s.check("a leader with no Grade H staff row of their own: the leader email is exactly what it was (no own item)",
            all("Enter your KPI achievement" not in r["body"] for r in outbox("M2")))
    wipe_mail()

    s.section("the recheck: worked out again just before it sends")
    rem_settings((3, 1))
    win("gradeh_kpi", -1, 3)
    win("gradeh_ack", -1, 5)
    fixed_deemed(4)
    t_ = queue(["K1", "K2", "A2"], regular=False, gh_staff="all")
    rk1, rk2, ra2 = outbox("K1")[0], outbox("K2")[0], outbox("A2")[0]
    def recheck(r):
        return run(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (r["id"],)).fetchone()))
    s.check("nothing changed since queueing: the same email goes", recheck(rk1) is not None and recheck(rk1)["body"] == rk1["body"])
    db.execute("UPDATE gradeh_appraisals SET staff_submitted_at='2026-11-01 02:00:00' WHERE person_id=?", (P["K1"],))
    db.commit()
    got = recheck(rk1)
    st = db.execute("SELECT status, error FROM email_outbox WHERE id=?", (rk1["id"],)).fetchone()
    s.check("K1 sent their KPI achievement before their wave: not sent ('cancelled', 'nothing pending when its wave came') and logged as skipped",
            got is None and st["status"] == "cancelled" and st["error"] == a.REMINDER_NOTHING_LEFT
            and db.execute("SELECT COUNT(*) FROM notifications WHERE user_id=? AND status='skipped' AND kind=?", (U["K1"], a.GRADEH_REMINDER_KIND)).fetchone()[0] == 1, dict(st))
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at='2026-11-02 02:00:00' WHERE person_id=?", (P["A2"],))
    db.commit()
    s.check("A2 acknowledged before their wave: not sent", recheck(ra2) is None)
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=NULL WHERE person_id=?", (P["A2"],))
    win("gradeh_kpi", -9, -2)
    s.check("K2's KPI part closed before their wave: not sent", recheck(rk2) is None)
    win("gradeh_kpi", -1, 3)
    # a case that moved on: K2's line manager (Route A, KPI sent) now has them to appraise: nothing waits on K2, but an email
    # written for 'KPI' is not rewritten as 'acknowledge'; here K2 sent it, so nothing is left
    wipe_mail()
    t_ = queue(["K2"], regular=False, gh_staff="all")
    rk2 = outbox("K2")[0]
    db.execute("UPDATE gradeh_people SET language='en' WHERE id=?", (P["K2"],))
    db.commit()
    got = recheck(rk2)
    s.check("the person switched language before their wave: the email is written again in the language now on their row",
            got is not None and got["subject"].startswith("Reminder: your KPI") and got["subject"] != rk2["subject"], got and got["subject"])
    db.execute("UPDATE gradeh_people SET language='bm' WHERE id=?", (P["K2"],))
    db.execute("UPDATE users SET left_at=datetime('now') WHERE id=?", (U["K2"],))
    db.commit()
    s.check("a person who has left by their wave: not sent", recheck(rk2) is None)
    db.execute("UPDATE users SET left_at=NULL WHERE id=?", (U["K2"],))
    db.execute("DELETE FROM email_outbox")
    db.commit()

    # ================================================================ 4. Email › Schedule
    s.section("Email › Schedule: the Grade H pill, its windows, its days, its events and the no-email count")
    SUC = H.client_as(a, SU["id"])
    # Pin the clock at 08:00 MYT today: a day is shown "to go" only until the late hours after its send time have passed
    # (_email_day_open), so after 12:00 the "today" checks below would fail on the time of day alone.
    _real_now_myt = a._now_myt
    _today_pin = a._today_myt()
    _pin = lambda hh: (lambda: datetime.combine(_today_pin, dtime(hh, 0)))   # noqa: E731
    a._now_myt = _pin(8)
    clear_windows()
    rem_settings((3, 1))
    # the board's calendar, moved to today: KPI 7 days, line managers 14, acknowledge after, HODs after, BU CEOs last
    win("gradeh_kpi", 0, 6)
    win("gradeh_lm", 0, 13)
    win("gradeh_ack", 14, 18)
    win("gradeh_hod_pot", 14, 18)
    win("gradeh_hod_perf", 14, 18)
    win("gradeh_buceo", 19, 22)
    fixed_deemed(18)
    mon = lambda n: day(n).strftime("%Y-%m")   # noqa: E731
    r = SUC.get("/admin/email?m=%s" % mon(0))
    b = r.get_data(as_text=True)
    t_ = text(r)
    s.check("the page opens with Grade H running", r.status_code == 200)
    pills = re.findall(r'class="ecal-chip[^"]*" href="[^"]*"[^>]*>([^<]*?) <b>', b)
    s.check("the filter chips are All / Everyone's reminder / Grade H / Leaders / Your own / Skipped, in that order",
            [x.replace("\u2019", "'") for x in pills[:6]] == ["All", "Everyone's reminder", "Grade H", "Leaders", "Your own", "Skipped"], pills)
    s.check("the Grade H windows line names staff (KPI, then acknowledge), line managers, HODs and BU CEOs with their dates",
            re.search(r"Grade H staff KPI [^,]{6,30}, acknowledge [^,]{6,30} Line managers .{6,30}? HODs .{6,30}? BU CEOs \w{3} \d+", t_) is not None, re.findall(r"Grade H staff KPI.{0,200}", t_))
    cal = lambda n: (re.search(r'data-day="%s".*?</a>' % day(n).isoformat(), text_raw(SUC.get("/admin/email?m=%s" % mon(n))), re.S) or [""])[0]   # noqa: E731
    text_raw = lambda resp: resp.get_data(as_text=True)   # noqa: E731
    plan_rows = run(lambda d: a.email_plan(d, a.active_cycle(d)))
    by = {(r_["frm"] - day(0)).days: r_ for r_ in plan_rows}
    staff_day = next(n for n in sorted(by) if by[n]["gh_staff"] and not by[n]["regular"])
    leaders_day = next(n for n in sorted(by) if by[n]["regular"] and not by[n]["gh_staff"] and n > 0)
    s.check("the calendar carries the purple 'Grade H staff' chip on a staff day (no Reminder chip), and the regular Reminder chip on a leaders' day",
            'data-key="gradeh"' in cal(staff_day) and "g-gradeh" in cal(staff_day) and 'data-key="reminder"' not in cal(staff_day)
            and 'data-key="reminder"' in cal(leaders_day) and 'data-key="gradeh"' not in cal(leaders_day), (staff_day, leaders_day))
    first = by[0]
    s.check("the day Grade H opens has both chips (Reminder, Grade H staff), and the plan says what opens and who",
            'data-key="reminder"' in cal(0) and 'data-key="gradeh"' in cal(0)
            and "Grade H: the KPI achievement and the line manager appraisal open" in first["words"].replace("&amp;", "&")
            and "Grade H staff on the KPI route; their line managers" in first["who"], (first["words"], first["who"]))
    pn0 = text(SUC.get("/admin/list/email-day?day=%s&fragment=1" % day(0).isoformat()))
    s.check("...and its panel has a card for each (Grade H's staff email, and Everyone's reminder)", "Grade H reminder for staff" in pn0 and "Everyone" in pn0, pn0[:200])
    a._now_myt = _pin(13)
    late = run(lambda d: a.email_cal_plan(d, a.active_cycle(d), day(0), day(0), now=a._now_myt()))
    s.check("past its send time and the late hours, an email that didn't go is not shown as to go today",
            not [e for e in late["days"].get(day(0).isoformat(), []) if e["key"] == "reminder" and e["state"] == "to_go"], late["days"].get(day(0).isoformat()))
    a._now_myt = _pin(8)
    kpi_last = [x for x in plan_rows if "Grade H KPI achievement closes in 3 days" in x["words"]]
    s.check("3 days before the KPI part closes: a Grade H-only day (the staff email, no Reminder)",
            len(kpi_last) == 1 and kpi_last[0]["gh_staff"] and not kpi_last[0]["regular"] and "Only those with something still waiting" in kpi_last[0]["who"], kpi_last)
    lm_last = [x for x in plan_rows if "Grade H appraisals close in 3 days" in x["words"]]
    s.check("3 days before the line managers' part closes: a leaders' day with the regular reminder and no Grade H staff email",
            len(lm_last) == 1 and lm_last[0]["regular"] and not lm_last[0]["gh_staff"] and "Line managers with someone still to submit" in lm_last[0]["who"], lm_last)
    ack_last = [x for x in plan_rows if "Acknowledge by" in x["words"]]
    s.check("acknowledging: the 3-day and 1-day calls name the deadline, with 'or it counts as agreed' while the switch is on",
            len(ack_last) == 2 and all("or it counts as agreed" in x["words"] and "23:59" in x["words"] and "Grade H staff not yet acknowledged" in x["who"] for x in ack_last), len(ack_last))
    s.check("the two Grade H events are under NOT ON A DATE: 'Ready to acknowledge · BM / EN' and 'Your result · BM / EN'",
            "Ready to acknowledge \u00b7 BM / EN" in b and "Your result \u00b7 BM / EN" in b and "When the line manager submits" in b)
    s.check("...and the footnote says Grade H staff get theirs in the language they picked",
            "Grade H staff get theirs in the language they picked." in t_)
    # the Grade H staff card: how many, and those with no work email (K3: the KPI route, no address)
    pns = text(SUC.get("/admin/list/email-day?day=%s&fragment=1" % day(staff_day).isoformat()))
    nomail = db.execute("SELECT COUNT(*) FROM gradeh_people p JOIN users u ON u.id=p.user_id WHERE p.cycle_id=? AND p.private_company=0 AND u.left_at IS NULL "
                        "AND u.role!='admin' AND COALESCE(u.email,'') NOT LIKE '%@%'", (CID,)).fetchone()[0]
    s.check("the staff card's How many counts those with no work email (they see the bar only), as the one rule gradeh_has_email says",
            nomail >= 1 and ("%d have no work email" % nomail) in pns, (nomail, re.findall(r"How many</dt><dd>[^<]*", pns)))
    n_ = run(lambda d: a.gradeh_no_email_count(d, day(0)))
    s.check("the sender's own count is a relationship: those on the KPI route with nothing sent and no work email, as of that day (K3)",
            n_ == db.execute("SELECT COUNT(*) FROM gradeh_people p JOIN users u ON u.id=p.user_id WHERE p.route='A' AND p.cycle_id=? "
                             "AND NOT EXISTS (SELECT 1 FROM gradeh_appraisals x WHERE x.person_id=p.id AND x.staff_submitted_at IS NOT NULL) "
                             "AND COALESCE(u.email,'')=''", (CID,)).fetchone()[0], n_)
    db.execute("UPDATE users SET email='zzgr-k3@zzgr.example' WHERE id=?", (U["K3"],))
    db.commit()
    s.check("...give K3 a work email and the staff card's count drops by one", ("%d have no work email" % nomail) not in text(SUC.get("/admin/list/email-day?day=%s&fragment=1" % day(staff_day).isoformat())))
    db.execute("UPDATE users SET email=NULL WHERE id=?", (U["K3"],))
    db.commit()
    # deemed off: no 'counts as agreed' in the plan
    fixed_deemed(18, on=False)
    plan2 = run(lambda d: a.email_plan(d, a.active_cycle(d)))
    s.check("the deemed switch off: the acknowledge days still go (the part's close), with no 'counts as agreed' words",
            any("Acknowledge by" in x["words"] for x in plan2) and not any("or it counts as agreed" in x["words"] for x in plan2), [x["words"] for x in plan2 if "cknowledg" in x["words"]][:2])
    fixed_deemed(18)
    # off: flag, unticked
    os.environ["ONEHR_GRADEH"] = "0"
    b0 = SUC.get("/admin/email").get_data(as_text=True)
    s.check("the server switch off: no Grade H chip, line, event or Grade H day anywhere on the page",
            ">Grade H <b>" not in b0 and "Grade H" not in b0 and "g-gradeh" not in b0.replace(".ecal-ev.g-gradeh", "") and "is-gh" not in b0.replace(".eml-tpl.is-gh", ""))
    os.environ["ONEHR_GRADEH"] = "1"
    module(False)
    b1 = SUC.get("/admin/email").get_data(as_text=True)
    s.check("Grade H unticked on the cycle: the same", ">Grade H <b>" not in b1 and "Grade H reminder" not in b1
            and "Ready to acknowledge" not in b1 and "g-gradeh" not in b1 and "Grade H staff KPI" not in text(SUC.get("/admin/email")))
    module(True)

    a._now_myt = _real_now_myt

    # ================================================================ 5. the deadline bar
    s.section("the deadline bar: leaders' Grade H lines, grey within the days, red on the last day")
    clear_windows()
    # 3 days, set here: the default became the whole window on 2026-11-01 (DEADLINE_WHOLE), and this section counts days
    db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('deadline_reminder',?)",
               (json.dumps({"on": True, "days": 3, "places": ["dashboard"]}),))
    db.execute("UPDATE gradeh_appraisals SET staff_submitted_at=NULL WHERE person_id=?", (P["K1"],))   # K1 sent theirs in the recheck section
    db.commit()

    def dl(k, place="dashboard", only_gh=False):
        a._DL_CACHE.clear()   # the bar keeps a person's items a few minutes; each look here is a new one
        return run(lambda d: a.deadline_item(d, urow(k), a._now_myt(), place, only_gh=only_gh))
    win("gradeh_lm", -1, 3)
    it = dl("M1")
    s.check("the appraiser, 3 days before their part closes (rules: 3): the board's line, with how many are ready for them",
            it and it["lead"] == "Your Grade H appraisals close %s %d %s, 23:59" % (day(3).strftime("%a"), day(3).day, day(3).strftime("%b"))
            and it["body"] == "4 days left. 1 is ready for you." and not it["red"] and it["kind"] == "deadline", it)
    s.check("...with a button to their team page", it and it["button"] == {"label": "Open my Grade H team", "url": "/review/gradeh"}, it and it["button"])
    win("gradeh_lm", -1, 4)
    s.check("4 days out (rules: 3): none", dl("M1") is None)
    win("gradeh_lm", -1, 0)
    it = dl("M1")
    s.check("the last day: red, the board's words",
            it and it["red"] and it["lead"] == "Last day: your Grade H appraisals close tonight at 23:59"
            and it["body"] == "Submit each person once you have talked it through.", it)
    win("gradeh_lm", -1, 1)
    s.check("one day out: today counts (2 days left, as the main bar reads it)", dl("M1")["body"].startswith("2 days left."))
    win("gradeh_lm", -1, 3)
    db.execute("UPDATE gradeh_appraisals SET lm_submitted_at='2026-11-10 02:00:00', perf_band='ME', pot_band='Mid' WHERE person_id IN (?,?)", (P["S1"], P["S2"]))
    db.commit()
    s.check("everyone submitted: the line goes (it follows what waits, like the email's item)", dl("M1") is None)
    db.execute("UPDATE gradeh_appraisals SET lm_submitted_at=NULL, perf_band=NULL, pot_band=NULL WHERE person_id IN (?,?)", (P["S1"], P["S2"]))
    db.commit()
    win("gradeh_hod_pot", -1, 3)
    win("gradeh_hod_perf", -1, 3)
    it = dl("H1")
    s.check("the Grade H HOD: 'Your Grade H review closes ...' and 'Sign off potential, then performance.'",
            it and it["lead"].startswith("Your Grade H review closes ") and it["body"] == "4 days left. Sign off potential, then performance."
            and it["button"]["url"] == "/calibration/gradeh/hod", it)
    win("gradeh_buceo", -1, 0)
    it = dl("B1")
    s.check("the BU CEO on the last day: red, 'Sign off each unit once you are done.'",
            it and it["red"] and it["lead"] == "Last day: your Grade H sign-off closes tonight at 23:59"
            and it["body"] == "Sign off each unit once you are done.", it)
    s.check("a person with no Grade H part of their own has none", dl("S1") is None and dl("M2") is None)
    # the soonest part wins, as for every part: M1 also leads a Grade H HOD seat here (H1's people are moved under M1)
    win("gradeh_lm", -1, 2)
    win("gradeh_hod_pot", -1, 1)
    win("gradeh_hod_perf", -1, 1)
    db.execute("UPDATE users SET hod_id=? WHERE id IN (?,?)", (U["M1"], U["S5"], U["S6"]))
    db.commit()
    it = dl("M1")
    s.check("a person with two Grade H parts waiting (appraiser, and HOD of S5 and S6) gets the sooner closing one as their line (the HOD review, 1 day)",
            it and it["lead"].startswith("Your Grade H review closes") and it["body"].startswith("2 days left."), it)
    win("gradeh_hod_pot", -1, 3)
    win("gradeh_hod_perf", -1, 3)
    it = dl("M1")
    s.check("...and when the appraisal closes first, that one", it and it["lead"].startswith("Your Grade H appraisals close"), it)
    db.execute("UPDATE users SET hod_id=? WHERE id IN (?,?)", (U["H1"], U["S5"], U["S6"]))
    db.commit()
    # on the pages
    db.execute("DELETE FROM app_settings WHERE key='deadline_reminder'")
    db.commit()
    def bar(k, path, place):
        a._DL_CACHE.clear()

        def go(d):
            with a.app.test_request_context(path, base_url=a.app_base_url()):
                return a.bar_items(d, urow(k), now=a._now_myt(), place=place)
        return run(go)
    win("gradeh_lm", -1, 3)
    s.check("a leader's Grade H line is in the bar on the dashboard", [i["lead"] for i in bar("M1", "/dashboard", "dashboard")]
            and bar("M1", "/dashboard", "dashboard")[0]["lead"].startswith("Your Grade H appraisals close"))
    s.check("...and on the Grade H pages (place 'checkin', which is not ticked)",
            [i["lead"] for i in bar("M1", "/review/gradeh", "checkin")] and "Your Grade H appraisals" in bar("M1", "/review/gradeh", "checkin")[0]["lead"])
    s.check("...but not on the AI+ check-in's own pages, where only the ticked places show it", bar("M1", "/review/journey", "checkin") == [])
    s.check("...and the calibration pages carry the HOD's and the BU CEO's lines",
            bar("H1", "/calibration/gradeh/hod", "other") and bar("B1", "/calibration/gradeh/unit", "other"))
    os.environ["ONEHR_GRADEH"] = "0"
    s.check("the server switch off: no Grade H line anywhere", bar("M1", "/review/gradeh", "checkin") == [] and dl("M1") is None
            and dl("H1") is None and dl("B1") is None)
    os.environ["ONEHR_GRADEH"] = "1"
    module(False)
    s.check("Grade H unticked: none", dl("M1") is None and dl("H1") is None and dl("B1") is None)
    module(True)

    s.section("the staff line follows the deemed switch")
    clear_windows()
    win("gradeh_ack", -1, 9)
    fixed_deemed(2)
    def sdl(k):
        a._DL_CACHE.clear()
        return run(lambda d: a.deadline_item(d, urow(k), a._now_myt(), "dashboard"))
    it = sdl("A1")
    s.check("acknowledging, the switch on: the bar names the deadline and the deemed words (English)",
            it and it["lead"].startswith("Acknowledge your appraisal before ") and "23:59" in it["lead"]
            and it["body"] == "If you do not acknowledge or tell us you do not agree, we will treat it as acknowledged.", it)
    it = sdl("A2")
    s.check("...and in Bahasa Melayu, the board's words", it and it["lead"].startswith("Sahkan penilaian anda sebelum ") and "11:59 malam" in it["lead"]
            and it["body"] == "Jika anda tidak mengesahkan atau memberitahu kami bahawa anda tidak bersetuju, penilaian ini akan dianggap telah anda sahkan.", it)
    fixed_deemed(2, on=False)
    s.check("the switch off: there is no deadline to name, so no acknowledge line and no deemed words at all",
            sdl("A1") is None and sdl("A2") is None)
    fixed_deemed(2)
    win("gradeh_kpi", -1, 3)
    it = sdl("K1")
    s.check("the KPI line (English): board E3's words", it and it["lead"].startswith("Your KPI achievement closes ")
            and it["body"] == "4 days left. Enter each KPI, then send it to your line manager.", it)
    it = sdl("K2")
    s.check("...in Bahasa Melayu", it and it["lead"].startswith("Pencapaian KPI anda ditutup ") and it["body"].startswith("4 hari lagi. Masukkan setiap KPI"), it)
    win("gradeh_kpi", -1, 0)
    it = sdl("K1")
    s.check("...the last day, red", it and it["red"] and it["lead"] == "Last day: your KPI achievement closes tonight at 23:59"
            and it["body"] == "Send it to your line manager.", it)

    s.section("Banner > Deadline reminder previews the Grade H lines")
    clear_windows()
    win("gradeh_kpi", 0, 6)
    win("gradeh_ack", 14, 18)
    win("gradeh_lm", 0, 13)
    win("gradeh_hod_pot", 14, 18)
    win("gradeh_hod_perf", 14, 18)
    win("gradeh_buceo", 19, 22)
    r = SUC.get("/admin/notices")
    b = r.get_data(as_text=True)
    t_ = text(r)
    rows_ = re.findall(r'<span class="ntc-dlwho"><b>([^<]*)</b>', b)
    s.check("the five Grade H rows, in the board's order, after the cycle's own",
            [x for x in rows_ if "Grade H" in x] == ["Grade H staff \u00b7 EN", "Grade H staff \u00b7 BM", "Grade H line managers",
                                                       "HODs \u00b7 Grade H", "BU CEOs \u00b7 Grade H"], rows_)
    s.check("...each with its 3-days line and its last-day line, in the words the live bar uses",
            "Your KPI achievement closes" in t_ and "Pencapaian KPI anda ditutup" not in t_ and "Sahkan penilaian anda sebelum" in t_
            and "Last day: your Grade H appraisals close tonight at 23:59" in t_ and "Last day: your Grade H sign-off closes tonight at 23:59" in t_
            and "Your Grade H review closes" in t_)
    s.check("...the line under it says staff see theirs on My Appraisal and leaders on the dashboard and the Grade H pages",
            "Grade H staff see theirs on My Appraisal, in the language they picked; it also names the deemed date." in t_)
    s.check("the staff rows say what the live line says: the same lead for the same date (relationship, not a copy)",
            run(lambda d: [x for x in a.deadline_preview_gh(d) if x["who"].startswith("Grade H staff \u00b7 EN")][0]["lead"])
            == a.gh_t("en", "dl_kpi_lead", d=a._gh_dl_when(datetime.combine(day(6), datetime.min.time()).replace(hour=23, minute=59), "en")))
    os.environ["ONEHR_GRADEH"] = "0"
    b0 = SUC.get("/admin/notices").get_data(as_text=True)
    s.check("the server switch off: no Grade H row or line on Banner", "Grade H" not in text(SUC.get("/admin/notices")).replace("Grade H Appraisal", "")
            and "ntc-ghsub" not in b0)
    os.environ["ONEHR_GRADEH"] = "1"

    # ================================================================ 6. the release window
    s.section("the release window: a Grade H part's closing day, and the evening before, block a planned release")
    clear_windows()
    db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('release_window', ?)",
               (json.dumps({"freeze_from": "2000-01-01", "freeze_to": "2000-01-02"}),))   # no launch freeze in the way
    db.commit()
    win("gradeh_kpi", 0, 6)
    win("gradeh_lm", 0, 13)
    win("gradeh_ack", 14, 18)
    win("gradeh_hod_pot", 14, 20)
    win("gradeh_hod_perf", 14, 20)
    win("gradeh_buceo", 19, 25)

    def rw(fn):
        return run(lambda d: fn(d))
    parts = rw(lambda d: a.release_parts(d, a.active_cycle(d)))
    gh_group = [g for g in parts if g["name"] == "Grade H Appraisal"]
    s.check("where Grade H runs, Admin > Notices lists a Grade H Appraisal group with its six parts, dated, followed by default",
            len(gh_group) == 1 and [p_["cell"] for p_ in gh_group[0]["parts"]] == list(a.GRADEH_CELL_KEYS)
            and all(p_["dated"] and p_["on"] for p_ in gh_group[0]["parts"]) and gh_group[0]["parts"][0]["name"] == "KPI achievement", gh_group)
    offs = rw(lambda d: [(x["from"], x["to"], x["text"]) for x in a.release_blackouts(d)])
    kpi_close = day(6)
    s.check("the KPI part's last day and the evening before are no-release days, said by who closes (Grade H staff)",
            any(f == kpi_close - timedelta(days=1) and t == kpi_close and "Grade H staff close" in txt for f, t, txt in offs), offs)
    s.check("...and every other Grade H part's: line managers' appraisal (day 13), HODs' (day 20), BU CEOs' (day 25)",
            all(any(t == day(n) and f == day(n) - timedelta(days=1) and who in txt for f, t, txt in offs)
                for n, who in ((13, "Grade H appraisers"), (20, "Grade H HODs"), (25, "Grade H BU CEOs"))), offs)
    s.check("release_blackout_on: the closing day and the evening before say so; two days before does not",
            rw(lambda d: a.release_blackout_on(d, day(6)) and a.release_blackout_on(d, day(5))) and "Grade H staff close" in rw(lambda d: a.release_blackout_on(d, day(6)))
            and rw(lambda d: a.release_blackout_on(d, day(4))) is None)
    # a planned release on that day is refused, the way every part's closing day refuses it
    rr = rw(lambda d: a.notice_save(d, SU, {"kind": "upgrade", "date": day(6).isoformat(), "from": "19:30", "downtime": "30", "closes": "1"}))
    s.check("posting a planned release on the KPI part's closing day is refused", rr[0] is False and rr[2] is None, rr[:2])
    rr = rw(lambda d: a.notice_save(d, SU, {"kind": "upgrade", "date": day(4).isoformat(), "from": "19:30", "downtime": "30", "closes": "1"}))
    s.check("...and two days before it is allowed (the control)", rr[0] is True, rr[:2])
    db.execute("DELETE FROM site_notices")
    db.execute("DELETE FROM email_outbox")
    db.commit()
    # the window's range follows the Grade H dates too
    a_, b_ = rw(lambda d: a.release_range(d))
    s.check("the window runs until the last Grade H part closes (the BU CEO's sign-off, day 25)", b_ == day(25), (a_, b_))
    # unticking: the super admin follows chosen parts only
    db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('release_window', ?)",
               (json.dumps({"freeze_from": "2000-01-01", "freeze_to": "2000-01-02", "cells": ["gradeh_lm"]}),))
    db.commit()
    offs = rw(lambda d: [(x["from"], x["to"], x["text"]) for x in a.release_blackouts(d)])
    s.check("followed parts picked by hand (only the appraisal): only its closing day blocks; the KPI part's does not",
            any(t == day(13) for f, t, txt in offs) and not any(t == day(6) for f, t, txt in offs), offs)
    db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('release_window', ?)",
               (json.dumps({"freeze_from": "2000-01-01", "freeze_to": "2000-01-02"}),))
    db.commit()

    s.section("the notice emails reach the Grade H roles whose window is open, and nobody else")
    def recips(extra_open=()):
        r_ = rw(lambda d: a.notice_recipients(d))
        return {u["id"]: line for u, line in r_}
    clear_windows()
    win("gradeh_kpi", -1, 6)
    got = recips()
    s.check("only the KPI part open: Grade H staff with a work email get it (K1, K2), with a line that does not name the module",
            U["K1"] in got and U["K2"] in got and got[U["K1"]].startswith("Your appraisal is open until ")
            and "Grade H" not in got[U["K1"]], got.get(U["K1"]))
    s.check("...staff with no work email (K3) are not on the list", U["K3"] not in got)
    s.check("...nor the appraisers, HODs or BU CEOs (their windows are not open)", not ({U["M1"], U["H1"], U["B1"]} & set(got)))
    win("gradeh_lm", -1, 6)
    win("gradeh_hod_pot", -1, 6)
    win("gradeh_hod_perf", -1, 6)
    win("gradeh_buceo", -1, 6)
    got = recips()
    s.check("with the appraisal part open too: the appraiser (M1, who has someone to appraise) gets 'Your Grade H appraisals are open until'",
            U["M1"] in got and got[U["M1"]].startswith("Your Grade H appraisals are open until "), got.get(U["M1"]))
    s.check("...the HOD (H1) gets 'Your Grade H review is open until', the BU CEO (B1) 'Your Grade H sign-off is open until'",
            got.get(U["H1"], "").startswith("Your Grade H review is open until ") and got.get(U["B1"], "").startswith("Your Grade H sign-off is open until "),
            (got.get(U["H1"]), got.get(U["B1"])))
    s.check("...a Grade H person who appraises nobody (S1) gets the staff line only, never an appraiser's",
            got.get(U["S1"], "").startswith("Your appraisal is open until ") and "Grade H" not in got.get(U["S1"], ""), got.get(U["S1"]))
    ability("lm", "lm.gradeh", False)
    s.check("an appraiser whose lm.gradeh is switched off is not told", U["M1"] not in recips())
    ability_clear()
    ability("hod", "hod.gradeh", False)
    s.check("...nor an HOD with hod.gradeh off", U["H1"] not in recips())
    ability_clear()
    txt_ = rw(lambda d: a.notice_recipients_text(d))
    s.check("the panel's 'who gets it' text names the Grade H roles", "Grade H staff" in txt_ and "Grade H appraisers" in txt_ and "Grade H HODs" in txt_
            and "Grade H BU CEOs" in txt_, txt_)
    # the email itself goes to them: queue the email before and read the outbox
    db.execute("DELETE FROM email_outbox")
    db.commit()
    _cfg, _kick = a.mailer.is_configured, a._outbox_kick
    a.mailer.is_configured = lambda: True      # this server sends no email: only the queue is looked at, nothing is sent
    a._outbox_kick = lambda *x, **k: False
    try:
        rr = rw(lambda d: a.notice_save(d, SU, {"kind": "upgrade", "date": day(4).isoformat(), "from": "19:30", "downtime": "30",
                                               "closes": "1", "email_before": "1", "email_after": "1"}))
    finally:
        a.mailer.is_configured, a._outbox_kick = _cfg, _kick
    sent_to = {r_["user_id"] for r_ in db.execute("SELECT user_id FROM email_outbox WHERE kind='notice_before'")}
    s.check("posting a notice queues the email before to exactly those (K1, K2, M1, H1, B1), none to K3",
            {U["K1"], U["K2"], U["M1"], U["H1"], U["B1"]} <= sent_to and U["K3"] not in sent_to, len(sent_to))
    db.execute("DELETE FROM site_notices")
    db.execute("DELETE FROM email_outbox")
    db.commit()
    s.section("the release run reads these same functions")
    tick_src = open(os.path.join(ROOT, "notice_tick.py"), encoding="utf-8").read()
    sh_src = open(os.path.join(ROOT, "deploy", "release_window.sh"), encoding="utf-8").read()
    s.check("notice_tick.py posts through notice_save and asks release_window_open, notice_flag_want and notice_reopen: no list of parts of its own",
            all(x in tick_src for x in ("appmod.notice_save(", "appmod.release_window_open(", "appmod.notice_flag_want(", "appmod.notice_reopen("))
            and "NOTICE_GROUPS" not in tick_src and "GRADEH" not in tick_src and "release_parts" not in tick_src)
    s.check("deploy/release_window.sh calls notice_tick.py for everything it posts, holds and reopens, and reads no calendar of its own",
            sh_src.count("notice_tick.py") >= 1 and "cycle_windows" not in sh_src and "NOTICE_GROUPS" not in sh_src)
    clear_windows()
    for c_ in ("gradeh_kpi", "gradeh_buceo"):
        win(c_, 3, 9)
    s.check("a cycle whose only dated parts are Grade H's has a release window on those days (release_window_open, the one tick and the run ask)",
            rw(lambda d: a.release_window_open(d, day(5))) and not rw(lambda d: a.release_window_open(d, day(20))))
    module(False)
    s.check("...and not with Grade H unticked: nothing dated, no window", not rw(lambda d: a.release_window_open(d, day(5))))
    module(True)

    s.section("nothing of it with the switch off or Grade H unticked")
    for what, off_ in (("the server switch off", lambda: os.environ.__setitem__("ONEHR_GRADEH", "0")), ("Grade H unticked", lambda: module(False))):
        off_()
        parts0 = rw(lambda d: a.release_parts(d, a.active_cycle(d)))
        s.check("%s: no Grade H group on Admin > Notices, no Grade H closing day blocks a release, no Grade H cell is open for a notice, "
                "no Grade H recipient" % what,
                not [g for g in parts0 if g["name"] == "Grade H Appraisal"]
                and not any("Grade H" in x["text"] for x in rw(lambda d: a.release_blackouts(d)))
                and not (set(a.GRADEH_CELL_KEYS) & set(rw(lambda d: a._notice_open_cells(d, a.active_cycle(d), a._now_myt()))))
                and not ({U["K1"], U["M1"], U["H1"], U["B1"]} & set(recips())), what)
        os.environ["ONEHR_GRADEH"] = "1"
        module(True)

    # ================================================================ 7. what Help, All settings and Ask OneHR say
    s.section("knowledge: the admin Help on the Email pages, All settings, and the seats' own answers")
    def helpa(ep, k="SU"):
        uu = SU if k == "SU" else urow(k)
        return run(lambda d: a.help_answers(d, uu, ep))
    pages_ = ("admin_email_schedule", "admin_emails", "admin_reminders", "admin_reminders_leaders", "admin_email_sent", "admin_notices")
    got = {ep: helpa(ep) for ep in pages_}
    s.check("on every Email, Reminders and Notices page the admin's Help lists the five Grade H answers (where Grade H is on)",
            all([i["key"] for i in g["items"]] == ["gh_adm_rem", "gh_adm_sched", "gh_adm_noemail", "gh_adm_bar", "gh_adm_window"]
                and g["label"] == "Email and reminders" for g in got.values()), {k: [i["key"] for i in v["items"]] for k, v in got.items()})
    txt_ = " ".join(i["a"] for i in got["admin_email_schedule"]["items"])
    s.check("...they say Grade H is in the reminders and the schedule: leaders' items, staff's own email in their language, the days, "
            "no work email = the bar only, the closing days in the release window",
            "Grade H staff get their own short email" in txt_ and "language they picked" in txt_ and "Grade H pill" in txt_
            and "No work email: bar only" in txt_ and "evening before" in txt_ and "Banner" in txt_, txt_[:120])
    s.check("a page that is not about email keeps the usual admin answers", [i["key"] for i in helpa("admin_users")["items"]][0].startswith("adm_"))
    s.check("All settings (and the Admin Agent's index) say Grade H is included in the reminder row",
            "Grade H included" in run(lambda d: a._st_reminders(d, SU)))
    s.check("the HOD's and the BU CEO's Help gain 'Will I get a reminder?'",
            "gh_hod_rem" in [i["key"] for i in a.HELP_LISTS and [{"key": k} for k in a.HELP_LISTS["gh_hod"][1]]]
            and "gh_bu_rem" in a.HELP_LISTS["gh_bu"][1] and len(a.HELP_LISTS["gh_hod"][1]) <= a.HELP_LIST_MAX and len(a.HELP_LISTS["gh_bu"][1]) <= a.HELP_LIST_MAX)
    faq = {f[0]: f for f in a.GRADEH_STAFF_FAQ}
    s.check("the staff's Help and Ask OneHR answer 'Will I get a reminder?' in both languages, without saying Grade H or Reopen",
            "remind" in faq and faq["remind"][1] == ("kpi", "ack") and all(faq["remind"][3]) and faq["remind"][3][0] != faq["remind"][3][1]
            and not re.search(r"Grade H|Gred H|Reopen", " ".join(faq["remind"][3])))
    lmq = {f[0]: f for f in a.GRADEH_LM_FAQ}
    s.check("the appraiser's Ask OneHR answers it too, and the language entry is still the last (the order the page relies on)",
            "reminder" in lmq and a.GRADEH_LM_FAQ[-1][0] == "language" and a.gradeh_lm_ask("will I get a reminder")[0] == lmq["reminder"][3][0])
    os.environ["ONEHR_GRADEH"] = "0"
    off = {ep: helpa(ep) for ep in pages_}
    s.check("the server switch off: the admin Help on those pages is the usual one, nothing about Grade H",
            all(not any(i["key"].startswith("gh_") for i in g["items"]) and g["label"] != "Email and reminders" for g in off.values())
            and "Grade H" not in run(lambda d: a._st_reminders(d, SU)))
    os.environ["ONEHR_GRADEH"] = "1"
    module(False)
    s.check("Grade H unticked: All settings' row does not say Grade H is included", "Grade H" not in run(lambda d: a._st_reminders(d, SU)))
    module(True)

finally:
    restore()

sys.exit(s.done())
