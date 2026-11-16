"""The one reminder (Chris, 2026-10-10, canvas row E).

"Reminder should work as all-in-one, meaning to say if the current point is the opening for individual result check in
and LM moderation, all Employees and LM who have pending items will get the email reminder. the reminder will list all
the pending items" -- and "super admin can define the frequency".

So: one email per person, listing what is still waiting on them in the parts open NOW (read from the dashboard's own
"what needs you": the Your review panel, the Your team card, the leader rows), at most one a day; the super admin's
rules say when it goes (a part opens, N days before a part closes, every N days while open, at a time); Cycle >
Reminders shows who's waiting (counted in the background), one person's email, Send now and the sends so far. A BG
admin sees and sends for their own people. Everything here is synthetic (ZZRM-*) and is removed at the end.
"""
import html
import re
import importlib.util
import io
import os
import sys
import time
from contextlib import redirect_stdout
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The one reminder -- everything waiting on a person, when the super admin says")

BG, CO = "ZZRM BG", "ZZRM CO"
KEYS = ("reminder_auto_enabled", "reminder_days_before", "reminder_send_time", "reminder_on_open",
        "reminder_every_days", "reminder_all_subject", "reminder_all_opening", "reminder_snapshot",
        "reminder_snapshot_running", "reminder_bulk_running", "reminder_bulk_meta", "reminder_template",
        "reminder_auto_last", "reminder_runner_runs")


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZRM-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM notifications WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM email_outbox WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM activity_log WHERE id > ? AND action IN ('reminder_run','reminder_schedule',"
               "'reminder_content')", (LOG0,))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    _cleanup(db)
    _settings = {k: v for k, v in db.execute("SELECT key, value FROM app_settings WHERE key IN (%s)"
                                             % ",".join("?" * len(KEYS)), KEYS)}
    db.execute("DELETE FROM app_settings WHERE key IN (%s)" % ",".join("?" * len(KEYS)), KEYS)
    _tpls = H.stash_email_templates(db)
    _mods = [tuple(r) for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))]
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','pm','tm','idp')", (CID,))
    _wins = [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (CID,))]
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))      # every part open, no dates
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, mgr=None, role="user", admin_bg=None, email=True, yos=3):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name,
                 email=(eid.lower() + "@example.invalid") if email else None, hod_id=None, manager_id=mgr,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO,
                 department="ZZRM Dept", years_of_service=yos, confirmation_date=None, left_at=None, is_demo=0,
                 role=role, admin_bg=admin_bg)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    LM = mk("ZZRM-LM", "ZZ RM Manager")
    A = mk("ZZRM-A", "ZZ RM Alpha <b>&", mgr=LM)              # a name that must come out escaped
    B = mk("ZZRM-B", "ZZ RM Bravo", mgr=LM, email=False)
    IDLE = mk("ZZRM-IDLE", "ZZ RM Idle", yos=0)              # taken out of the cycle, rates nobody: nothing waiting
    # taken out by an admin: not confirmed alone no longer means nothing waits (the Career Plan is everyone's, 2026-10-19)
    db.execute("INSERT OR REPLACE INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?,'remove')",
               (CID, IDLE))
    ADM = mk("ZZRM-ADM", "ZZ RM Groupadmin", role="admin", admin_bg=BG)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (BG,))
    for sid in (A, B, LM):
        for k in ("ZZRM Revenue", "ZZRM Cost"):
            t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, "
                           "rate3, rate4, rate5, business_group, company, department) VALUES (?,?,?,50,'more',"
                           "80,90,100,110,120,?,?,'ZZRM Dept')", (CID, sid, k, BG, CO)).lastrowid
            if sid != LM:
                db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t, LM))
    # A submitted both results, so they wait on the line manager; B owes theirs
    for t in db.execute("SELECT id FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=?", (A, CID)).fetchall():
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,100,?,0)",
                   (t[0], A))
    db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?,'peer')",
               (CID, B, A))                                   # A owes B a 360 rating
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def u(uid):
    return ctx(lambda d: dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


def items(uid):
    return ctx(lambda d: a.reminder_items(d, u(uid)))


def setwin(cell, opens=None, closes=None):
    ctx(lambda d: (d.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES "
                             "(?,?,?,?)", (CID, cell, opens, closes)), d.commit()))


def clearwin():
    ctx(lambda d: (d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,)), d.commit()))


def day(n):
    return (a._today_myt() + timedelta(days=n)).isoformat()


sup = H.client_as(a, SUP)
adm = H.client_as(a, ADM)
_sent = []
_real = (a.mailer.send_mail, a.mailer.is_configured, a.mailer.config_status, a.mailer.get_token)
_real_async = a.OUTBOX_ASYNC

try:
    # -----------------------------------------------------------------------
    s.section("what is waiting on each person, from the dashboard's own sources")
    ia, ilm, ib = items(A), items(LM), items(B)
    s.check("A: their 360 rating and their own review (results are in, so nothing else of theirs)",
            [i["group"] for i in ia] == ["f360"] or sorted(i["group"] for i in ia) == ["f360", "own"],
            [(i["group"], i["text"], i["detail"]) for i in ia])
    s.check("B: their KPI results", any(i["group"] == "own" and "KPI results" in i["text"] for i in ib),
            [(i["group"], i["text"]) for i in ib])
    s.check("the line manager: their team (A's results wait on them) and their own KPI results",
            any(i["group"] == "team" and "ZZ RM Alpha" in i["detail"] for i in ilm)
            and any(i["group"] == "own" for i in ilm), [(i["group"], i["text"], i["detail"]) for i in ilm])
    s.check("someone with nothing waiting gets nothing", items(IDLE) == [])
    s.check("an admin login gets nothing", items(SUP) == [])
    setwin("pm_results", closes=day(-1))
    s.check("a part whose window has closed drops out (B's KPI results)",
            not any(i["group"] == "own" and "KPI results" in i["text"] for i in items(B)))
    setwin("pm_results", opens=day(2))
    s.check("...and so does one not open yet", not any("KPI results" in i["text"] for i in items(B)))
    setwin("pm_results", closes=day(9))
    ib = items(B)
    s.check("an open part says when it closes", any("closes" in i["closes"] and "9 days" in i["closes"] for i in ib),
            [i["closes"] for i in ib])
    setwin("pm_approve", closes=day(-1))
    s.check("the line manager's team item follows its own window", not any(i["group"] == "team" for i in items(LM)))
    clearwin()

    # -----------------------------------------------------------------------
    s.section("the email")
    subj, body = ctx(lambda d: a.reminder_mail(u(LM), a.reminder_items(d, u(LM)), a.active_cycle(d)))
    n = len(ilm)
    s.check("the subject opens with the countdown and counts what's waiting (Chris, 4 Nov 2026)", re.fullmatch(
        r"(Last day|\d+ days left|Reminder): %d things you need to do in AI\+ OneHR" % n, subj) is not None, subj)
    subj1, _b = ctx(lambda d: a.reminder_mail(u(B), [ib[0]], a.active_cycle(d)))
    s.check("...in the singular for one", re.fullmatch(r"(Last day|\d+ days left|Reminder): 1 thing you need to do in AI\+ OneHR",
                                                       subj1) is not None, subj1)
    s.check("it opens with the cycle", "Here's what is still open for you in %s" % CYC["name"] in html.unescape(body))
    s.check("its groups come in order: your team before your own review", html.unescape(body).index(
        "Your team's reviews") < html.unescape(body).index("Your own check-in"))
    s.check("names are escaped, never markup", "<b>&" not in body and "ZZ RM Alpha &lt;b&gt;&amp;" in body)
    s.check("every link is absolute, on the app's own address", "href=\"%s/" % a.app_base_url() in body
            and 'href="/' not in body)

    # -----------------------------------------------------------------------
    s.section("when it goes out: the super admin's rules")
    def reasons(d_):
        return ctx(lambda d: a.reminder_reasons(d, a.active_cycle(d), d_))
    today = a._today_myt()
    ctx(lambda d: a.set_reminder_rules(True, True, [7, 3, 1], 0, "09:00"))
    setwin("pm_results", opens=day(0), closes=day(3))
    r = reasons(today)
    s.check("a part opening today is a send day", any("opens" in x for x in r), r)
    s.check("...and so is 3 days before it closes", any("closes in 3 days" in x for x in reasons(today)), reasons(today))
    s.check("a day with no rule is not", reasons(today + timedelta(days=1)) == [], reasons(today + timedelta(days=1)))
    ctx(lambda d: a.set_reminder_rules(True, False, [], 7, "09:00"))
    setwin("pm_results", opens=day(-7), closes=day(20))
    s.check("every 7 days while a part is open", any("every 7 days" in x for x in reasons(today)), reasons(today))
    s.check("...not on the 6th", reasons(today - timedelta(days=1)) == [])
    ctx(lambda d: (d.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'pm', 0)",
                             (CID,)), d.commit()))
    s.check("a part whose module is off this cycle never fires", reasons(today) == [], reasons(today))
    ctx(lambda d: (d.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'pm', 1)",
                             (CID,)), d.commit()))
    ctx(lambda d: a.set_reminder_rules(False, True, [7, 3, 1], 7, "09:00"))
    s.check("rules off: no send day at all", reasons(today) == [])
    clearwin()

    # -----------------------------------------------------------------------
    s.section("the page")
    r = sup.get("/admin/reminders")
    b = html.unescape(r.get_data(as_text=True))
    s.check("Everyone's reminder opens for the super admin", r.status_code == 200 and "When it goes" in b
            and "Who gets it" in b and "What this sends" in b, r.status_code)
    s.check("...it sits under Email › Schedule now (2026-10-24)", 'href="/admin/email"' in b and
            any(p_["ep"] == "admin_reminders" and p_.get("under") == "admin_email_schedule"
                for t in a.ADMIN_SECTION_BY_KEY["email"]["tabs"] for p_ in t["pages"]))
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_schedule", "enabled": "on",
                                           "on_open": "on", "day_before": ["5", "2"], "every_days": "4",
                                           "send_time": "08:30"})
    rules = ctx(lambda d: a.reminder_rules())
    s.check("Save keeps every rule", rules["enabled"] and rules["on_open"] and rules["days_before"] == [5, 2]
            and rules["every_days"] == 4 and rules["send_time"] == "08:30", rules)
    s.check("...and logs it", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='reminder_schedule' AND id>?",
                                    (LOG0,)) == 1)
    # Send at goes in 15-minute steps, the reminders timer's own (Chris, 2026-10-21): a time between runs moves to the
    # next run, the one it really goes at, never past 23:45; both pages' fields step by 15 minutes
    for typed, want in (("08:10", "08:15"), ("23:50", "23:45")):
        sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_schedule", "enabled": "on",
                                           "on_open": "on", "day_before": ["5", "2"], "every_days": "4",
                                           "send_time": typed})
        s.check("Send at %s is kept as %s, the timer's run" % (typed, want),
                ctx(lambda d: a.reminder_rules())["send_time"] == want, ctx(lambda d: a.reminder_rules())["send_time"])
    sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_schedule", "enabled": "on",
                                       "on_open": "on", "day_before": ["5", "2"], "every_days": "4",
                                       "send_time": "08:30"})
    s.check("...a quarter hour is kept as it is", ctx(lambda d: a.reminder_rules())["send_time"] == "08:30")
    for path in ("/admin/reminders", "/admin/reminders/leaders"):
        b_ = sup.get(path).get_data(as_text=True)
        s.check("%s's Send at steps by 15 minutes" % path,
                re.search(r'<input type="time" name="send_time"[^>]*step="900"', b_) is not None)
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_schedule", "enabled": "on",
                                           "every_days": "45", "send_time": "08:30"}, follow_redirects=True)
    s.check("every 45 days is refused (30 at most)", "30 days at most" in html.unescape(r.get_data(as_text=True))
            and ctx(lambda d: a.reminder_rules())["every_days"] == 4)
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_schedule", "enabled": "on",
                                           "send_time": "08:30"}, follow_redirects=True)
    s.check("on with no rule at all is refused", "at least one rule" in html.unescape(r.get_data(as_text=True)))
    sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_words",
                                       "subject": "{first_name}, {count} for {cycle}", "opening": "Hello there."})
    subj2, body2 = ctx(lambda d: a.reminder_mail(u(B), items(B), a.active_cycle(d)))
    s.check("the words are the super admin's, with their tokens filled",
            subj2 == "Zz, %d for %s" % (len(items(B)), CYC["name"]) and "Hello there." in body2, subj2)
    sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "reset_words"})
    s.check("Back to the default", ctx(lambda d: a.reminder_words())[0] == a.DEFAULT_REMINDER_ALL_SUBJECT)
    r = adm.get("/admin/reminders")
    s.check("a BG admin can't open it: the whole Email menu is the super admin's (Chris, 2026-10-24)",
            r.status_code == 403, r.status_code)
    r = adm.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_schedule", "enabled": "on",
                                           "on_open": "on", "send_time": "07:00"})
    s.check("...and can't change them", r.status_code == 403 and ctx(lambda d: a.reminder_rules())["send_time"]
            == "08:30", r.status_code)
    r = adm.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_words", "subject": "x", "opening": "y"})
    s.check("...nor the words", r.status_code == 403)
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "promote"})
    s.check("an unknown action is refused", r.status_code == 400)

    # -----------------------------------------------------------------------
    s.section("one person's email, and who's waiting")
    r = sup.get("/admin/reminders/preview?eid=ZZRM-LM")
    b = r.get_data(as_text=True)
    s.check("the preview shows that person's email, subject first", r.status_code == 200 and "Subject:" in b
            and "Your team" in b and "Continue in AI+ OneHR" in b)
    b = sup.get("/admin/reminders/preview?eid=ZZRM-IDLE").get_data(as_text=True)
    s.check("someone with nothing waiting: says they get no email", "get no email" in html.unescape(b))
    s.check("a BG admin can't preview anyone, nor count who's waiting", adm.get(
        "/admin/reminders/preview?eid=ZZRM-LM").status_code == 403 and adm.get(
        "/admin/reminders/waiting.json").status_code == 403)
    snap = ctx(lambda d: a._reminder_snapshot_compute(d))
    ctx(lambda d: (d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('reminder_snapshot', ?)",
                             (a.json.dumps(snap),)), d.commit()))
    ADM_ROW = ctx(lambda d: d.execute("SELECT * FROM users WHERE id=?", (ADM,)).fetchone())
    # the count is still scoped by whoever asks (reminder_waiting): a BG-scoped admin's own people, read directly
    d_ = {"waiting": ctx(lambda d: a.reminder_waiting(d, ADM_ROW, snap)), "counting": sup.get(
        "/admin/reminders/waiting.json").get_json()["counting"]}
    w = d_["waiting"]
    roles = {x["key"]: x["n"] for x in w["roles"]}
    s.check("the BG admin's count is their own people: A, B and the line manager", w["total"] == 3, w)
    want = {}
    for uid_ in (A, B, LM):
        for r_ in {i["role"] for i in items(uid_)}:
            want[r_] = want.get(r_, 0) + 1
    s.check("...by role, the same as each person's own items (1 rater, 1 line manager)",
            all(roles.get(k, 0) == want.get(k, 0) for k in roles) and roles.get("f360") == 1
            and roles.get("team") == 1, (roles, want))
    s.check("...and one of them has no email on file", w["no_email"] == 1)
    s.check("a fresh count isn't recounted", d_["counting"] is False)
    ctx(lambda d: (d.execute("DELETE FROM app_settings WHERE key='reminder_snapshot'"), d.commit()))
    d_ = sup.get("/admin/reminders/waiting.json").get_json()
    s.check("with no count yet, it starts one in the background", d_["counting"] is True and d_["waiting"] is None)
    for _i in range(90):
        time.sleep(1)
        d_ = sup.get("/admin/reminders/waiting.json?start=0").get_json()
        if not d_["counting"]:
            break
    snap2, _c = ctx(lambda d: a.reminder_snapshot(d, start=False))
    s.check("...which finishes and gives the same count", not d_["counting"] and snap2 and ctx(
        lambda d: a.reminder_waiting(d, ADM_ROW, snap2))["total"] == 3)

    # -----------------------------------------------------------------------
    s.section("Send now, and the daily job")
    # Send now drains the whole outbox inline: an earlier suite's queued emails (a batch shares the copied database)
    # would go out with ours, so they wait aside until this suite ends
    ctx(lambda d: (d.execute("UPDATE email_outbox SET status='zz-parked' WHERE status='queued'"), d.commit()))
    r = adm.post("/admin/reminders", data={"csrf_token": "tok", "action": "send_now"})
    s.check("a BG admin can't Send now: the super admin's only (Chris, 2026-10-19 and 2026-10-24)", r.status_code == 403)
    # the super admin sends org-wide; here only this suite's people are counted (the copied database holds others)
    _rp = a.reminder_people
    a.reminder_people = lambda db, me, *x, **k: [p for p in _rp(db, me, *x, **k)
                                                 if p["employee_id"] in ("ZZRM-A", "ZZRM-B", "ZZRM-LM", "ZZRM-IDLE")]
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "send_now"}, follow_redirects=True)
    s.check("with email not set up, nothing is sent", "isn't set up" in html.unescape(r.get_data(as_text=True))
            and H.one(a, "SELECT COUNT(*) FROM notifications WHERE user_id IN (?,?,?)", (A, B, LM)) == 0)
    a.mailer.is_configured = lambda: True
    a.mailer.config_status = lambda: {"configured": True, "sender": "x", "has_tenant": True, "has_client_id": True,
                                      "has_secret": True}
    a.mailer.get_token = lambda: "tok"
    a.mailer.send_mail = lambda to, subject, body, token=None, save_to_sent=True: _sent.append((to, subject, body))
    # Send now queues each email in the outbox in waves (2026-10-21); the first wave is due now. Drained inline here, so
    # the send has happened when the background job finishes (test_email_waves covers the waves themselves).
    a.OUTBOX_ASYNC = False
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "send_now"})
    for _i in range(120):
        time.sleep(1)
        if not ctx(lambda d: a.bulk_send_status()[0]):
            break
    to = sorted(x[0] for x in _sent)
    s.check("the super admin's Send now emails everyone with something waiting, once each",
            to == ["zzrm-a@example.invalid", "zzrm-lm@example.invalid"], to)
    s.check("...B, with no email on file, is logged as skipped", H.one(
        a, "SELECT COUNT(*) FROM notifications WHERE user_id=? AND status='skipped'", (B,)) == 1)
    s.check("...the run is in the Sent list", "Send now, by " in html.unescape(
        sup.get("/admin/email/sent").get_data(as_text=True)))
    _sent.clear()
    sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "send_now"})
    for _i in range(120):
        time.sleep(1)
        if not ctx(lambda d: a.bulk_send_status()[0]):
            break
    s.check("a second Send now the same day sends nobody again (at most one a day)", _sent == [], [x[0] for x in _sent])
    # the daily job: dry run by default, and --auto only on a send day
    spec = importlib.util.spec_from_file_location("send_reminders_t", os.path.join(H.REPO, "send_reminders.py"))
    sr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sr)
    real_people = a.reminder_people
    a.reminder_people = lambda db, me=None: [p for p in real_people(db, me) if (p["employee_id"] or "").startswith("ZZRM-")]
    # a fresh day for these three: their reminders are in the notifications log and, since the waves, the outbox
    ctx(lambda d: (d.execute("DELETE FROM notifications WHERE user_id IN (?,?,?)", (A, B, LM)),
                   d.execute("DELETE FROM email_outbox WHERE user_id IN (?,?,?)", (A, B, LM)), d.commit()))
    _sent.clear()

    def run(*argv):
        out = io.StringIO()
        sys.argv = ["send_reminders.py"] + list(argv)
        with redirect_stdout(out):
            sr.main()
        return out.getvalue()
    out = run()
    s.check("the job with no flags is a dry run: nothing sent, each one logged", _sent == [] and "DRY RUN" in out
            and H.one(a, "SELECT COUNT(*) FROM notifications WHERE user_id IN (?,?) AND status='dryrun'", (A, LM)) == 2,
            out[-300:])
    # the job sends at the super admin's time (2026-10-17): this run's is the quarter hour just gone (Send at goes in
    # the timer's 15-minute steps since 2026-10-21)
    _now = a._now_myt()
    _at = "%02d:%02d" % (_now.hour, _now.minute - _now.minute % 15)
    ctx(lambda d: a.set_reminder_rules(True, True, [], 0, _at))
    out = run("--auto")
    s.check("--auto on a day no rule picks does nothing", _sent == [] and "Not a send day" in out, out[-200:])
    setwin("pm_results", opens=day(0), closes=day(30))
    out = run("--auto")
    s.check("--auto on a send day emails them, and says why", sorted(x[0] for x in _sent) ==
            ["zzrm-a@example.invalid", "zzrm-lm@example.invalid"] and "opens" in out, out[-300:])
    a.reminder_people = _rp   # the real one (real_people was this suite's narrowed copy of it)
    clearwin()

    # -----------------------------------------------------------------------
    s.section("a BG CEO who is also a BU CEO gets no BU CEO line in the email (Chris, 2026-11-11)")
    _ri = a.reminder_items
    _it = lambda g, r, t: {"group": g, "role": r, "text": t, "detail": "", "closes": "", "url": "/x", "people": []}   # noqa: E731
    _fake = [_it("own", "own", "KPI results"), _it("lead", "buceo", "AI+ Calibration"), _it("lead", "bgceo", "AI+ Talent Box")]
    a.reminder_items = lambda d, u_: list(_fake) if u_["id"] == LM else _ri(d, u_)
    try:
        em = lambda: [i["text"] for i in ctx(lambda d: a.reminder_items_email(d, d.execute(   # noqa: E731
            "SELECT * FROM users WHERE id=?", (LM,)).fetchone()))]
        s.check("a plain BU CEO (no BG seat) keeps the Calibration line", "AI+ Calibration" in em(), em())
        ctx(lambda d: (d.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (BG, LM)), d.commit()))
        s.check("seated as a BG CEO too: no Calibration line in the email", "AI+ Calibration" not in em(), em())
        s.check("...their Talent Box and own lines stay", "AI+ Talent Box" in em() and "KPI results" in em(), em())
        s.check("...the bar and previews (reminder_items) still read the line", "AI+ Calibration" in
                [i["text"] for i in ctx(lambda d: a.reminder_items(d, d.execute("SELECT * FROM users WHERE id=?", (LM,)).fetchone()))])
        snap_ = ctx(lambda d: a._reminder_snapshot_compute(d))["people"].get(str(LM))
        s.check("the admin count agrees: no BU CEO for them, but BG CEO and Employees stay",
                snap_ and "buceo" not in snap_[2] and "bgceo" in snap_[2] and "own" in snap_[2] and snap_[3] == 2, snap_)
        _fake[:] = [_it("lead", "buceo", "AI+ Calibration")]
        s.check("only the Calibration line waiting: the email has no items (reminder_send's 'nothing' path)", em() == [], em())
        ctx(lambda d: (d.execute("UPDATE users SET bgceo_bg=NULL WHERE id=?", (LM,)), d.commit()))
        s.check("...seat cleared: the same person gets it again", em() == ["AI+ Calibration"], em())
    finally:
        a.reminder_items = _ri
        ctx(lambda d: (d.execute("UPDATE users SET bgceo_bg=NULL WHERE id=?", (LM,)), d.commit()))
finally:
    a.mailer.send_mail, a.mailer.is_configured, a.mailer.config_status, a.mailer.get_token = _real
    a.OUTBOX_ASYNC = _real_async
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        db.execute("UPDATE email_outbox SET status='queued' WHERE status='zz-parked'")
        db.execute("DELETE FROM app_settings WHERE key IN (%s)" % ",".join("?" * len(KEYS)), KEYS)
        for k, v in _settings.items():
            db.execute("INSERT INTO app_settings(key,value) VALUES (?,?)", (k, v))
        H.restore_email_templates(db, _tpls)
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for w_ in _wins:
            db.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w_), ",".join("?" * len(w_))),
                       list(w_.values()))
        db.execute("DELETE FROM cycle_modules WHERE cycle_id=?", (CID,))
        for k, act in _mods:
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", (CID, k, act))
        db.commit()

sys.exit(s.done())
