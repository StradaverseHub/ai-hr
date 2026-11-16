"""Mass emails go out in waves (Chris, 2026-10-21: "help to set the email to send in batch by default, see what is the
sweet spot for mass email send"; plan ~/.claude/plans/pure-floating-muffin.md, Strand 2).

The load test had the site failing at ~200 people online, and one email to everyone at once puts ~270-500 online. So
every mass email OneHR sends (everyone's reminder, the release emails) is queued in the outbox with the time its wave
may go: by default 200 people every 30 minutes, the super admin's setting on Cycle > Reminders (BG and unit admins read
it). The sender sends only what's due, at 30 a minute inline too; the background sender waits for the next wave with
its heartbeat kept; an after-response check (once a minute a process) and the server's 15-minute job keep the waves
moving after a deploy. The reminder's cooldown counts from when it was queued, so a late wave never holds someone out
of tomorrow's. Everything here is synthetic (ZZEW-*) and is removed at the end.
"""
import html
import importlib.util
import io
import os
import re
import sqlite3
import sys
import threading
import time
from contextlib import redirect_stdout
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Mass emails in waves -- 200 every 30 minutes by default, the super admin's setting")

GROUPS = ("ZZEW Charlie", "ZZEW Alpha", "ZZEW Bravo")     # created out of order on purpose
UNITS = ("ZZEW Unit 3", "ZZEW Unit 1", "ZZEW Unit 2")
DEPTS = ("ZZEW Dept B", "ZZEW Dept A")
N = 450
KEYS = ("email_wave_on", "email_wave_size", "email_wave_gap", "outbox_beat", "reminder_auto_enabled",
        "reminder_bulk_running", "reminder_bulk_meta", "reminder_runner_runs", "reminder_auto_last")


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZEW-%'")]
    if ids:
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            ph = ",".join("?" * len(chunk))
            db.execute("DELETE FROM notifications WHERE user_id IN (%s)" % ph, chunk)
            db.execute("DELETE FROM email_outbox WHERE user_id IN (%s)" % ph, chunk)
            db.execute("DELETE FROM release_emails WHERE recipient_id IN (%s) OR subject_id IN (%s)" % (ph, ph),
                       chunk + chunk)
            for t in ("leader_releases", "result_releases", "talent_releases"):
                db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (t, ph), chunk)
            db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph),
                       chunk + chunk)
            db.execute("DELETE FROM users WHERE id IN (%s)" % ph, chunk)
    db.execute("DELETE FROM email_outbox WHERE to_email LIKE '%@zzew.invalid' OR kind='zz_wave'")
    db.execute("DELETE FROM notifications WHERE kind='zz_wave' OR to_email LIKE '%@zzew.invalid'")
    db.execute("DELETE FROM activity_log WHERE id > ? AND action IN ('reminder_run','email_waves')", (LOG0,))
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
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 "
                           "LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, bg, co, dept, role="user", admin_bg=None):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ EW " + eid[5:], email=eid.lower() +
                 "@zzew.invalid", hod_id=None, manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None,
                 business_group=bg, company=co, department=dept, years_of_service=3, confirmation_date=None,
                 left_at=None, is_demo=0, role=role, admin_bg=admin_bg)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    PEOPLE = [mk("ZZEW-%03d" % i, GROUPS[(i * 7) % 3], UNITS[(i * 5) % 3], DEPTS[(i * 3) % 2]) for i in range(N)]
    ADM = mk("ZZEW-ADM", "ZZEW Alpha", "ZZEW Unit 1", "ZZEW Dept A", role="admin", admin_bg="ZZEW Alpha")
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]
    INFO = {r["id"]: (r["business_group"], r["company"], r["department"], r["id"], r["email"])
            for r in db.execute("SELECT * FROM users WHERE employee_id LIKE 'ZZEW-%' AND role!='admin'")}


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def q(sql, args=()):
    return ctx(lambda d: d.execute(sql, args).fetchall())


def setting(k, v):
    ctx(lambda d: (d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES (?,?)", (k, v)), d.commit()))


def unset(*ks):
    ctx(lambda d: (d.execute("DELETE FROM app_settings WHERE key IN (%s)" % ",".join("?" * len(ks)), ks), d.commit()))


def fresh_day():
    """Nobody of ours emailed or queued yet."""
    ctx(lambda d: (d.execute("DELETE FROM email_outbox WHERE to_email LIKE '%@zzew.invalid'"),
                   d.execute("DELETE FROM notifications WHERE to_email LIKE '%@zzew.invalid' OR user_id IN "
                             "(SELECT id FROM users WHERE employee_id LIKE 'ZZEW-%')"), d.commit()))


def ours(rows):
    return [r for r in rows if (r["employee_id"] or "").startswith("ZZEW-")]


def flashes(resp):
    """The page's flash messages, apart from the rest of it (the card's script carries the same words)."""
    import re as _re
    return " ".join(html.unescape(m) for m in _re.findall(r'<div class="flash flash-\w+"[^>]*>(.*?)</div>',
                                                         resp.get_data(as_text=True), _re.S))


def mine():
    """What went to our people (an inline drain sends anything due, whoever queued it)."""
    return [x for x in _sent if x.endswith("@zzew.invalid")]


# every one of ours has one thing waiting (the real reminder_items reads the dashboard: far too slow for 450)
ITEM = {"group": "own", "role": "own", "text": "Enter your KPI results and submit", "detail": "", "closes": "",
        "url": "/review", "closes_on": None}
_real_items, _real_people, _real_kick = a.reminder_items, a.reminder_people, a._outbox_kick
a.reminder_items = lambda db_, u_: [dict(ITEM)] if (u_["employee_id"] or "").startswith("ZZEW-") else \
    _real_items(db_, u_)
_sent = []
_real = (a.mailer.send_mail, a.mailer.is_configured, a.mailer.config_status, a.mailer.get_token, a.OUTBOX_ASYNC,
         a.OUTBOX_PACE, a.OUTBOX_WATCH)
a.mailer.is_configured = lambda: True
a.mailer.config_status = lambda: {"configured": True, "sender": "x", "has_tenant": True, "has_client_id": True,
                                  "has_secret": True}
a.mailer.get_token = lambda: "tok"
a.mailer.send_mail = lambda to, subject, body, token=None, save_to_sent=True: _sent.append(to)
a.OUTBOX_ASYNC = False
sup = H.client_as(a, SUP)
adm = H.client_as(a, ADM)


class SleepLog:
    """Stands in for the app's `time` module: records each sleep and waits at most `cap` seconds of it."""
    def __init__(self, cap=0.0, probe=None):
        self.calls, self.cap, self.probe = [], cap, probe

    def sleep(self, x):
        self.calls.append(x)
        if self.probe:
            self.probe()
        time.sleep(min(x, self.cap))

    def __getattr__(self, name):
        return getattr(time, name)


try:
    # -----------------------------------------------------------------------
    s.section("the rules: on, 200 people, 30 minutes by default; the super admin's ranges")
    r0 = ctx(lambda d: a.email_wave_rules())
    s.check("by default waves are on: 200 people every 30 minutes", r0 == {"on": True, "size": 200, "gap": 30}, r0)
    setting("email_wave_size", "9")
    setting("email_wave_gap", "x")
    s.check("a stored value out of its range reads as the default", ctx(lambda d: a.email_wave_rules())
            == {"on": True, "size": 200, "gap": 30}, ctx(lambda d: a.email_wave_rules()))
    unset("email_wave_size", "email_wave_gap")
    err = a.email_wave_error
    s.check("25 to 2,000 people a wave", err(24, 30) and err(2001, 240) and not err(25, 5) and not err(2000, 67),
            (err(24, 30), err(2001, 240)))
    s.check("5 to 240 minutes between waves", err(100, 4) and err(100, 241) and not err(100, 240))
    s.check("a gap too short for the wave to go out at 30 a minute is refused: 200 needs 7 minutes",
            "at least 7 minutes" in err(200, 6) and not err(200, 7), err(200, 6))
    s.check("...2,000 needs 67", "at least 67 minutes" in err(2000, 66) and not err(2000, 67))
    t0 = datetime(2026, 11, 2, 0, 0, 0)
    tt = a.email_wave_times(N, {"on": True, "size": 200, "gap": 30}, t0)
    s.check("row i goes at start + (i // 200) x 30 minutes: 200 now, 200 at +30, 50 at +60",
            tt[:200] == ["2026-11-02 00:00:00"] * 200 and tt[200:400] == ["2026-11-02 00:30:00"] * 200
            and tt[400:] == ["2026-11-02 01:00:00"] * 50, sorted(set(tt)))
    s.check("waves off: every row due now", a.email_wave_times(5, {"on": False, "size": 200, "gap": 30}, t0)
            == [None] * 5)
    s.check("the plan reads as the run log and the card say it", ctx(lambda d: a.email_wave_plan(450))["text"] ==
            "in 3 waves (200 every 30 min)" and ctx(lambda d: a.email_wave_line(1986)) ==
            "Everyone (1,986): 10 waves, the last one about 4 h 30 min after the first.",
            ctx(lambda d: a.email_wave_line(1986)))

    # -----------------------------------------------------------------------
    s.section("everyone's reminder is queued in waves, a team's emails together, nothing sent at queue time")
    people = ctx(lambda d: ours(a.reminder_people(d)))
    want = [x[3] for x in sorted(INFO.values())]   # (group, unit, department, id), written apart from the app's query
    s.check("reminder_people comes in business group, unit and department order", [p["id"] for p in people] == want
            and want != sorted(want), [p["id"] for p in people][:5])
    kicks = []
    a._outbox_kick = lambda flask_app=None: kicks.append(1) or False
    _sent.clear()
    before = time.time()
    tally = ctx(lambda d: a.reminder_send(d, a.active_cycle(d), people, "zz waves", actor_id=SUP, live=True))
    a._outbox_kick = _real_kick
    rows = q("SELECT id, user_id, kind, status, send_after, detail FROM email_outbox WHERE to_email LIKE "
             "'%@zzew.invalid' ORDER BY id")
    s.check("450 queued, none sent while queuing (the sender sends them)", tally["queued"] == N and tally["sent"] == 0
            and _sent == [] and len(rows) == N and all(r["status"] == "queued" for r in rows), (tally, len(_sent)))
    s.check("...each a reminder, saying why", all(r["kind"] == a.REMINDER_KIND and r["detail"] == "zz waves"
                                                  for r in rows))
    s.check("...and the sender was asked to start", kicks == [1], kicks)
    s.check("the outbox holds them in the people's order", [r["user_id"] for r in rows] == want)
    waves = sorted({r["send_after"] for r in rows})
    w_at = [datetime.strptime(w, "%Y-%m-%d %H:%M:%S") for w in waves]
    s.check("three waves: 200, 200 and 50", len(waves) == 3 and [sum(1 for r in rows if r["send_after"] == w)
                                                                  for w in waves] == [200, 200, 50], waves)
    s.check("...the first now, then 30 and 60 minutes on", abs((w_at[0] - datetime.utcfromtimestamp(before))
                                                                .total_seconds()) < 120
            and [(w - w_at[0]).total_seconds() for w in w_at] == [0, 1800, 3600], waves)
    s.check("...in order: the first 200 people go first", [r["user_id"] for r in rows if r["send_after"] == waves[0]]
            == want[:200])
    runs = ctx(lambda d: a.reminder_runs(d))
    s.check("the run log reads '450 queued in 3 waves (200 every 30 min)'", runs and runs[0]["queued"] == N and
            runs[0]["plan"] == "in 3 waves (200 every 30 min)" and runs[0]["sent"] == 0, runs[:1])

    # -----------------------------------------------------------------------
    s.section("the sender sends only what is due; a wave moved into the past goes next; never a row before its time")
    st = ctx(lambda d: a.outbox_status(d))
    s.check("the status: 200 due now, 250 waiting for their wave, the next at its time in MYT",
            st["due"] >= 200 and st["later"] == 250
            and st["next"].endswith((w_at[1] + timedelta(hours=8)).strftime("%H:%M")), st)
    _sent.clear()
    ctx(lambda d: a._outbox_drain(a.app, inline=True))
    first = {INFO[u][4] for u in want[:200]}
    s.check("an inline drain sends the 200 that are due, and returns", len(mine()) == 200 and set(mine()) == first,
            len(mine()))
    s.check("...the other 250 still wait", H.one(a, "SELECT COUNT(*) FROM email_outbox WHERE to_email LIKE "
                                                    "'%@zzew.invalid' AND status='queued'") == 250)
    ctx(lambda d: (d.execute("UPDATE email_outbox SET send_after=datetime('now','-1 minute') WHERE send_after=? AND "
                             "status='queued'", (waves[1],)), d.commit()))
    _sent.clear()
    ctx(lambda d: a._outbox_drain(a.app, inline=True))
    s.check("moving the second wave into the past sends the next 200, and only them",
            len(mine()) == 200 and set(mine()) == {INFO[u][4] for u in want[200:400]}, len(mine()))
    s.check("never a row before its time: every sent row's wave had come", H.one(
        a, "SELECT COUNT(*) FROM email_outbox WHERE to_email LIKE '%@zzew.invalid' AND status='sent' AND "
           "send_after > sent_at") == 0 and H.one(a, "SELECT COUNT(*) FROM email_outbox WHERE to_email LIKE "
                                                     "'%@zzew.invalid' AND status='queued' AND send_after=?",
                                                  (waves[2],)) == 50)
    s.check("...each send in the notifications log, as a reminder", H.one(
        a, "SELECT COUNT(*) FROM notifications WHERE to_email LIKE '%@zzew.invalid' AND status='sent' AND kind=?",
        (a.REMINDER_KIND,)) == 400)

    # -----------------------------------------------------------------------
    s.section("the cooldown counts from when a reminder was queued, and a queued one counts")
    U0, U4 = want[0], want[449]
    cool = lambda uid: ctx(lambda d: a.reminder_in_cooldown(d, uid, CID))   # noqa: E731
    s.check("someone whose reminder waits for its wave is in the cooldown", cool(U4))
    s.check("...and so is someone whose reminder went", cool(U0))
    # yesterday's 08:00 run: queued 23 h ago, its late wave sent 19 h ago
    ctx(lambda d: (d.execute("UPDATE email_outbox SET created_at=datetime('now','-23 hours') WHERE user_id=? AND "
                             "to_email LIKE '%@zzew.invalid'", (U0,)),
                   d.execute("UPDATE notifications SET created_at=datetime('now','-19 hours') WHERE user_id=? AND "
                             "to_email LIKE '%@zzew.invalid'", (U0,)), d.commit()))
    s.check("a reminder queued 23 hours ago that went out in a late wave doesn't hold them out of today's", not cool(U0))
    ctx(lambda d: (d.execute("UPDATE email_outbox SET created_at=datetime('now','-21 hours') WHERE user_id=? AND "
                             "to_email LIKE '%@zzew.invalid'", (U0,)),
                   d.execute("INSERT INTO notifications(cycle_id, user_id, to_email, kind, pending_count, status, detail) "
                             "VALUES (?,?,?,?,2,'sent','direct')", (CID, U0, "x@zzew.invalid", a.REMINDER_KIND)),
                   d.commit()))
    s.check("...a reminder sent straight (2 waiting, before the waves) still does", cool(U0))
    ctx(lambda d: (d.execute("DELETE FROM notifications WHERE user_id=? AND detail='direct'", (U0,)),
                   d.execute("UPDATE email_outbox SET created_at=datetime('now') WHERE user_id=?", (U0,)), d.commit()))

    # -----------------------------------------------------------------------
    s.section("Send now only queues, and a second one queues nobody")
    a.reminder_people = lambda db_, me_=None, *x, **k: ours(_real_people(db_, me_, *x, **k))

    def send_now(client):
        r_ = client.post("/admin/reminders", data={"csrf_token": "tok", "action": "send_now"})
        for _i in range(120):
            if not ctx(lambda d: a.bulk_send_status()[0]):
                break
            time.sleep(0.5)
        return r_
    n0 = H.one(a, "SELECT COUNT(*) FROM email_outbox WHERE to_email LIKE '%@zzew.invalid'")
    _sent.clear()
    r = send_now(sup)
    s.check("a second Send now queues nobody: everyone is queued or emailed already", r.status_code == 302 and
            H.one(a, "SELECT COUNT(*) FROM email_outbox WHERE to_email LIKE '%@zzew.invalid'") == n0 and _sent == [],
            (r.status_code, len(_sent)))
    s.check("...its run says so", ctx(lambda d: a.reminder_runs(d))[0]["queued"] == 0
            and "Send now, by" in ctx(lambda d: a.reminder_runs(d))[0]["why"])
    rp = sup.get("/admin/reminders")
    b = html.unescape(rp.get_data(as_text=True))
    s.check("Send now says the emails go in waves", "in waves of 200 every 30 minutes, the first now" in flashes(rp),
            flashes(rp))
    b = html.unescape(sup.get("/admin/email/sent").get_data(as_text=True))   # Email › Sent since 2026-10-24
    s.check("the Sent list reads the first run as queued in waves", "450 queued in 3 waves (200 every 30 min)" in b)

    # -----------------------------------------------------------------------
    s.section("waves off: every email due now")
    fresh_day()
    setting("email_wave_on", "0")
    a._outbox_kick = lambda flask_app=None: False
    tally = ctx(lambda d: a.reminder_send(d, a.active_cycle(d), people, "zz all at once", live=True))
    a._outbox_kick = _real_kick
    s.check("450 queued, none waiting for a wave", tally["queued"] == N and H.one(
        a, "SELECT COUNT(*) FROM email_outbox WHERE to_email LIKE '%@zzew.invalid' AND send_after IS NULL") == N
        and ctx(lambda d: a.outbox_status(d))["later"] == 0)
    s.check("...the run log says all at once", ctx(lambda d: a.reminder_runs(d))[0]["plan"] ==
            "all at once (waves are off)")
    s.check("...and so does the bar", (ctx(lambda d: a.outbox_sends(d)) or [{}])[0].get("label") ==
            "Everyone's reminder, all at once")
    _sent.clear()
    ctx(lambda d: a._outbox_drain(a.app, inline=True))
    s.check("...and one drain sends them all", len(mine()) == N, len(mine()))
    unset("email_wave_on")

    # -----------------------------------------------------------------------
    s.section("the release emails go in waves too")
    fresh_day()
    setting("email_wave_size", "25")
    setting("email_wave_gap", "5")
    P = ctx(lambda d: dict(d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()))
    me = ctx(lambda d: dict(d.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone()))
    a._outbox_kick = lambda flask_app=None: False
    em = ctx(lambda d: a.release_email_queue(d, me, P, P, {"pm": want[:60]}, "employees"))
    a._outbox_kick = _real_kick
    rel = q("SELECT send_after FROM email_outbox WHERE kind=? AND to_email LIKE '%@zzew.invalid' ORDER BY id",
            (a.RELEASE_PERSON_KIND,))
    rw = sorted({r[0] for r in rel})
    rw = sorted({r[0] for r in rel if r[0]})
    rt = [datetime.strptime(w, "%Y-%m-%d %H:%M:%S") for w in rw]
    s.check("60 people's emails in 3 waves of 25, 5 minutes apart", em and em["people"] == 60 and em["waves"] == 3
            and len(rel) == 60 and [sum(1 for r in rel if r[0] == w) for w in rw] == [25, 25, 10]
            and [(t - rt[0]).total_seconds() for t in rt] == [0, 300, 600], (em, rw))
    s.check("...the first wave in queue order", rw and [r[0] for r in rel[:25]] == [rw[0]] * 25)
    unset("email_wave_size", "email_wave_gap")
    a._outbox_kick = lambda flask_app=None: False   # the page kicks the sender; here the first wave waits for the job
    b = html.unescape(sup.get("/admin/talent-release").get_data(as_text=True))
    s.check("the Release results page names the waves it is waiting on", "waiting for their wave, the next at" in b)
    _rq = a.release_email_queue
    a.release_email_queue = lambda *x, **k: {"leaders": 12, "people": 438, "no_email": 0, "waves": 3}
    r = sup.post("/admin/talent-release", data={"csrf_token": "tok", "action": "release", "result": "pm",
                                                "to": "both", "ids": [want[0]]}, follow_redirects=True)
    a.release_email_queue, a._outbox_kick = _rq, _real_kick
    s.check("...and a release's message names them", "Emailing 12 leaders and 438 people in the background, in 3 "
            "waves of 200 every 30 minutes (the first now)" in flashes(r), flashes(r))

    # -----------------------------------------------------------------------
    s.section("the server's 15-minute job sends what is due, on any day")
    spec = importlib.util.spec_from_file_location("send_reminders_w", os.path.join(H.REPO, "send_reminders.py"))
    sr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sr)
    ctx(lambda d: (d.execute("UPDATE email_outbox SET send_after=datetime('now','-1 minute') WHERE kind=? AND "
                             "to_email LIKE '%@zzew.invalid' AND send_after=?", (a.RELEASE_PERSON_KIND, rw[1])),
                   d.commit()))
    setting("reminder_auto_enabled", "0")
    _sent.clear()
    out = io.StringIO()
    sys.argv = ["send_reminders.py", "--auto"]
    with redirect_stdout(out):
        sr.main()
    out = out.getvalue()
    s.check("--auto with reminders off still sends the due waves (the first and the one moved into the past)",
            len(mine()) == 50 and "Automatic reminders are off" in out, (len(mine()), out[-300:]))
    s.check("...says what is left", "Outbox: 0 due now, 10 waiting for their wave" in out, out[:200])
    s.check("...and leaves the last wave alone", H.one(a, "SELECT COUNT(*) FROM email_outbox WHERE kind=? AND "
                                                          "to_email LIKE '%@zzew.invalid' AND status='queued'",
                                                       (a.RELEASE_PERSON_KIND,)) == 10)
    a.OUTBOX_ASYNC = False   # the job set it; this suite drains inline

    # -----------------------------------------------------------------------
    s.section("paced at 30 a minute, inline too; the background sender waits for the next wave")
    fresh_day()
    for i in range(3):
        ctx(lambda d: (a._outbox_add(d, "zz_wave", "p%d@zzew.invalid" % i, "S", "<p>b</p>"), d.commit()))
    a.OUTBOX_PACE = True
    sl = SleepLog()
    a.time = sl
    _sent.clear()
    ctx(lambda d: a._outbox_drain(a.app, inline=True))
    a.time, a.OUTBOX_PACE = time, False
    s.check("an inline drain waits 2 seconds after each email (30 a minute)", len(mine()) == 3
            and sl.calls == [2.0] * len(_sent), sl.calls)
    s.check("the next wait: none queued", ctx(lambda d: a._outbox_next_wait(d)) is None)
    ctx(lambda d: (a._outbox_add(d, "zz_wave", "later@zzew.invalid", "S", "<p>b</p>",
                                 send_after=(datetime.utcnow() + timedelta(seconds=90)).strftime("%Y-%m-%d %H:%M:%S")),
                   d.commit()))
    nw = ctx(lambda d: a._outbox_next_wait(d))
    s.check("...one 90 seconds ahead", nw is not None and 80 <= nw <= 91, nw)
    # a wave 90 seconds off: the sender waits a minute at most (the row is taken away during the wait, so it stops)
    sl = SleepLog(probe=lambda: ctx(lambda d: (d.execute("UPDATE email_outbox SET status='zz_gone' WHERE "
                                                         "to_email='later@zzew.invalid'"), d.commit())))
    a.time = sl
    th = threading.Thread(target=a._outbox_drain, args=(a.app,), daemon=True)
    th.start()
    th.join(10)
    a.time = time
    s.check("a sender waiting for a wave 90 seconds off sleeps a minute at most, then looks again",
            not th.is_alive() and sl.calls[:1] == [a.OUTBOX_WAIT_MAX_S], sl.calls)
    ctx(lambda d: (d.execute("UPDATE email_outbox SET status='queued', send_after=? WHERE to_email='later@zzew.invalid'",
                             ((datetime.utcnow() + timedelta(seconds=3)).strftime("%Y-%m-%d %H:%M:%S"),)), d.commit()))
    beats = []

    def probe():
        c = sqlite3.connect(a.DB_PATH)
        beats.append(c.execute("SELECT value FROM app_settings WHERE key='outbox_beat'").fetchone())
        c.close()
    sl = SleepLog(cap=0.25, probe=probe)
    a.time = sl
    _sent.clear()
    th = threading.Thread(target=a._outbox_drain, args=(a.app,), daemon=True)
    th.start()
    th.join(20)
    a.time = time
    s.check("the background sender sends the row once its wave comes, then stops", not th.is_alive()
            and _sent == ["later@zzew.invalid"], (th.is_alive(), _sent))
    s.check("...waiting toward it meanwhile, a second at least", sl.calls and max(sl.calls) <= 3.5
            and min(sl.calls) >= 1.0, sl.calls[:5])
    s.check("...its heartbeat kept while it waits (so no second sender starts)", beats and all(b_ for b_ in beats),
            beats[:3])
    s.check("...and cleared when it's done", H.one(a, "SELECT COUNT(*) FROM app_settings WHERE key='outbox_beat'") == 0)

    # -----------------------------------------------------------------------
    s.section("the Graph token: renewed before it expires; a failed send tried once more on a fresh one")
    fresh_day()
    tokens, tries = [], []

    def get_token():
        tokens.append(1)
        return "tok%d" % len(tokens)

    def flaky(fail_times):
        """A send_mail that fails each address's first `fail_times` tries, then sends."""
        def send(to, subject, body, token=None, save_to_sent=True):
            tries.append((to, token))
            if sum(1 for t_, _k in tries if t_ == to) <= fail_times:
                raise a.mailer.MailerError("Graph HTTP 401: token expired")
            _sent.append(to)
        return send
    a.mailer.get_token = get_token
    ctx(lambda d: (a._outbox_add(d, "zz_wave", "once@zzew.invalid", "S", "<p>b</p>"), d.commit()))
    a.mailer.send_mail = flaky(1)
    _sent.clear()
    ctx(lambda d: a._outbox_drain(a.app, inline=True))
    st_ = H.one(a, "SELECT status FROM email_outbox WHERE to_email='once@zzew.invalid'")
    s.check("a send that fails once is tried again and goes: sent, not failed", st_ == "sent" and mine() ==
            ["once@zzew.invalid"], (st_, tries))
    s.check("...on a fresh token", len(tokens) == 2 and [k for _t, k in tries] == ["tok1", "tok2"], tries)
    s.check("...and only the send is logged", H.one(a, "SELECT COUNT(*) FROM notifications WHERE to_email="
                                                        "'once@zzew.invalid' AND status='failed'") == 0)
    ctx(lambda d: (a._outbox_add(d, "zz_wave", "twice@zzew.invalid", "S", "<p>b</p>"), d.commit()))
    tries.clear()
    a.mailer.send_mail = flaky(5)
    ctx(lambda d: a._outbox_drain(a.app, inline=True))
    s.check("one that fails again is tried once more only, then marked failed", H.one(
        a, "SELECT status FROM email_outbox WHERE to_email='twice@zzew.invalid'") == "failed" and len(tries) == 2,
        tries)
    ctx(lambda d: (a._outbox_add(d, "zz_wave", "paced@zzew.invalid", "S", "<p>b</p>"), d.commit()))
    a.mailer.send_mail = flaky(1)
    a.OUTBOX_PACE = True
    sl = SleepLog()
    a.time = sl
    ctx(lambda d: a._outbox_drain(a.app, inline=True))
    a.time, a.OUTBOX_PACE = time, False
    s.check("...paced, it waits a moment before the second try (then the usual 2 seconds)",
            sl.calls == [a.OUTBOX_RETRY_WAIT_S, 2.0], sl.calls)

    class Clock:
        """The app's `time` with a clock the test moves: each send takes half an hour."""
        def __init__(self):
            self.t = 1000.0

        def monotonic(self):
            return self.t

        def sleep(self, x):
            pass

        def __getattr__(self, name):
            return getattr(time, name)
    clk = Clock()

    def slow_send(to, subject, body, token=None, save_to_sent=True):
        tries.append((to, token))
        clk.t += 1800
        _sent.append(to)
    for i in range(3):
        ctx(lambda d: (a._outbox_add(d, "zz_wave", "t%d@zzew.invalid" % i, "S", "<p>b</p>"), d.commit()))
    tokens.clear()
    tries.clear()
    a.mailer.send_mail = slow_send
    a.time = clk
    ctx(lambda d: a._outbox_drain(a.app, inline=True))
    a.time = time
    s.check("a sender that has run past %d minutes takes a fresh token: 3 sends half an hour apart, 2 tokens"
            % (a.OUTBOX_TOKEN_MAX_S // 60), len(tries) == 3 and len(tokens) == 2
            and [k for _t, k in tries] == ["tok1", "tok1", "tok2"], tries)
    a.mailer.get_token = lambda: "tok"
    a.mailer.send_mail = lambda to, subject, body, token=None, save_to_sent=True: _sent.append(to)

    # -----------------------------------------------------------------------
    s.section("after a response, once a minute a process, the sender starts when due emails wait")
    src = H.code_without_docstrings(H.source(a))
    hook = src[src.index("def _outbox_after_request"):]
    hook = hook[:hook.index("\n\n\n")]
    s.check("the check reads and writes nothing in the request itself (its thread does)",
            "get_db" not in hook and "execute" not in hook and "threading.Thread" in hook, hook[:120])
    a.OUTBOX_WATCH = True
    a._OUTBOX_WATCH["at"], a._OUTBOX_WATCH["pid"] = float("-inf"), None
    ctx(lambda d: (a._outbox_add(d, "zz_wave", "w1@zzew.invalid", "S", "<p>b</p>"), d.commit()))
    _sent.clear()
    sup.get("/login")

    def wait_sent(n, secs=5.0):
        t_end = time.time() + secs
        while time.time() < t_end and len(_sent) < n:
            time.sleep(0.1)
        return list(_sent)
    s.check("a response starts the sender for an email that is due", wait_sent(1) == ["w1@zzew.invalid"], _sent)
    ctx(lambda d: (a._outbox_add(d, "zz_wave", "w2@zzew.invalid", "S", "<p>b</p>"), d.commit()))
    sup.get("/login")
    s.check("...but not twice within the minute", wait_sent(2, 1.5) == ["w1@zzew.invalid"], _sent)
    a._OUTBOX_WATCH["at"] = float("-inf")
    sup.get("/login")
    s.check("...a minute on, it looks again", wait_sent(2) == ["w1@zzew.invalid", "w2@zzew.invalid"], _sent)
    a.OUTBOX_WATCH = False

    # -----------------------------------------------------------------------
    s.section("how far each mass send has got: the super admin's bar (Chris: \"like XXX/2000\")")
    fresh_day()
    BAD = {INFO[u][4] for u in want[:3]}
    a.mailer.send_mail = lambda to, subject, body, token=None, save_to_sent=True: (
        (_ for _ in ()).throw(a.mailer.MailerError("Graph HTTP 400")) if to in BAD else _sent.append(to))
    a._outbox_kick = lambda flask_app=None: False
    ctx(lambda d: a.reminder_send(d, a.active_cycle(d), people, "zz bar", live=True))
    a._outbox_kick = _real_kick
    batches = q("SELECT batch, COUNT(*) FROM email_outbox WHERE to_email LIKE '%@zzew.invalid' GROUP BY batch")
    s.check("one mass send's rows share one key", len(batches) == 1 and (batches[0][0] or "").startswith("reminder-")
            and batches[0][1] == N, [tuple(b_) for b_ in batches])
    _sent.clear()
    ctx(lambda d: a._outbox_drain(a.app, inline=True))
    a.mailer.send_mail = lambda to, subject, body, token=None, save_to_sent=True: _sent.append(to)
    x = ctx(lambda d: a.outbox_sends(d))[0]
    w0, w1, w2 = sorted({r[0] for r in q("SELECT send_after FROM email_outbox WHERE batch=?", (batches[0][0],))})
    t0 = datetime.strptime(w0, "%Y-%m-%d %H:%M:%S")
    s.check("the bar counts it: 197 of 450 sent, 3 failed, 250 waiting for their wave", (
        x["total"], x["sent"], x["failed"], x["now"], x["later"]) == (450, 197, 3, 0, 250) and x["live"], x)
    s.check("...says what it is and when it was queued", x["label"] == "Everyone's reminder" and
            x["sub"].startswith("queued ") and x["sub"].endswith("on the schedule"), x["sub"])
    s.check("...the next wave and when the last should go: the 50 of the last wave at 30 a minute after its time",
            x["next"] == ctx(lambda d: a._outbox_when(w1)) and x["finish"] == ctx(
                lambda d: a._outbox_clock(t0 + timedelta(minutes=60 + 50 / 30.0))), (x["next"], x["finish"]))
    r = sup.get("/admin/reminders/progress")
    b = html.unescape(r.get_data(as_text=True))
    s.check("the super admin's bar reads 197 / 450 sent, failed in red, what waits and when it ends",
            r.status_code == 200 and "197 / 450 sent" in " ".join(re.sub(r"<[^>]+>", " ", b).split())
            and 'class="rm-send-bad"' in b
            and "3 failed" in b and "250 waiting for their wave · next wave" in b and "All sent by about" in b
            and 'data-live="1"' in b, b[:300])
    s.check("...counts only: no address, no name", "@zzew.invalid" not in b and "ZZ EW" not in b)
    s.check("a BG admin can't read it", adm.get("/admin/reminders/progress").status_code == 403)
    b = html.unescape(sup.get("/admin/email/sent").get_data(as_text=True))
    s.check("the super admin's Email › Sent card shows the bar, ticking", 'id="rm-sends"' in b and 'data-live="1"' in b
            and "/admin/reminders/progress" in b and 'id="rm-wave-status"' not in b)
    s.check("...a BG admin opens no Sent page (the Email menu is the super admin's, 2026-10-24)",
            adm.get("/admin/email/sent").status_code == 403)
    a._outbox_kick = lambda flask_app=None: False
    em = ctx(lambda d: a.release_email_queue(d, me, P, P, {"pm": want[100:130]}, "employees"))   # not released yet
    a._outbox_kick = _real_kick
    xs = ctx(lambda d: a.outbox_sends(d))
    s.check("two sends going: one bar each, the newest first", len(xs) == 2 and xs[0]["label"] ==
            "Results released to employees" and xs[1]["label"] == "Everyone's reminder" and xs[0]["now"] == 30,
            [(y["label"], y["now"]) for y in xs])
    s.check("...a release's says its cycle", P["name"] in xs[0]["sub"], xs[0]["sub"])
    ctx(lambda d: (d.execute("UPDATE email_outbox SET send_after=datetime('now','-1 minute') WHERE status='queued' AND "
                             "to_email LIKE '%@zzew.invalid'"), d.commit()))
    ctx(lambda d: a._outbox_drain(a.app, inline=True))
    xs = ctx(lambda d: a.outbox_sends(d))
    s.check("all gone: the latest send, finished", len(xs) == 1 and xs[0]["label"] == "Results released to employees"
            and not xs[0]["live"] and xs[0]["finished"] and xs[0]["sent"] == 30, xs)
    done = ctx(lambda d: a.render_template("_mass_send_progress.html",
                                           sends=[a._outbox_send(d, batches[0][0])]))
    s.check("...a finished reminder with failures says they get the next one", "3 failed &rsaquo;</a></b>: they get the next "
            "reminder · finished" in done and "data-live" not in done, done[-260:])
    s.check("...and with no mass send at all, says so", "No mass email has gone out yet" in ctx(
        lambda d: a.render_template("_mass_send_progress.html", sends=[])))

    # -----------------------------------------------------------------------
    s.section("Email › Sent: the super admin's card (the whole Email menu is theirs, 2026-10-24)")
    s.check("save_waves is the super admin's in the access map", a.admin_access_need(
        "admin_reminders", {"action": "save_waves"}) == "super")
    s.check("...and the access page says so", "mass-email waves" in dict((m[0], m[3]) for m in a.ACCESS_MODULES)["cycle"])
    ctx(lambda d: (a._outbox_add(d, "zz_wave", "card@zzew.invalid", "S", "<p>b</p>", send_after=(
        datetime.utcnow() + timedelta(minutes=30)).strftime("%Y-%m-%d %H:%M:%S")), d.commit()))
    b = html.unescape(sup.get("/admin/email/sent").get_data(as_text=True))
    s.check("the super admin sees the card, its switch and numbers, and Save", "Mass emails go out in waves" in b
            and 'name="wave_size"' in b and 'name="wave_gap"' in b and "Save the waves</button>" in b
            and "data-confirm=\"Save how mass emails go out?" in b)
    s.check("...the line for everyone", "Everyone (" in b and "waves, the last one about" in b)
    r = adm.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_waves", "wave_on": "1",
                                           "wave_size": "50", "wave_gap": "10"})
    s.check("a BG admin's save is refused", r.status_code == 403 and ctx(lambda d: a.email_wave_rules())["size"] == 200,
            r.status_code)
    _map = a.ADMIN_ACCESS_MAP["admin_reminders"]
    a.ADMIN_ACCESS_MAP["admin_reminders"] = "always"   # past the access map: the handler refuses it on its own
    r = adm.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_waves", "wave_on": "1",
                                           "wave_size": "50", "wave_gap": "10"})
    a.ADMIN_ACCESS_MAP["admin_reminders"] = _map
    s.check("...by the handler too", r.status_code == 403 and ctx(lambda d: a.email_wave_rules())["size"] == 200,
            r.status_code)
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_waves", "wave_on": "1",
                                           "wave_size": "300", "wave_gap": "45"}, follow_redirects=True)
    s.check("the super admin's save is kept", ctx(lambda d: a.email_wave_rules()) == {"on": True, "size": 300,
                                                                                       "gap": 45}
            and "waves of 300, 45 minutes apart" in flashes(r), flashes(r))
    s.check("...and audited", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='email_waves' AND user_id=? AND "
                                       "id>? AND detail LIKE 'on=True, 300 per wave, every 45 min%'", (SUP, LOG0)) == 1)
    for bad, why in ((("2001", "30"), "from 25 to 2,000"), (("200", "300"), "from 5 to 240"),
                     (("600", "15"), "at least 20 minutes"), (("abc", "30"), "from 25 to 2,000")):
        r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_waves", "wave_on": "1",
                                               "wave_size": bad[0], "wave_gap": bad[1]}, follow_redirects=True)
        s.check("refused: %s people, %s minutes (%s)" % (bad[0], bad[1], why), why in flashes(r)
                and ctx(lambda d: a.email_wave_rules())["size"] == 300, flashes(r))
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_waves", "wave_size": "300",
                                           "wave_gap": "45"})
    s.check("switched off: all at once from now on", ctx(lambda d: a.email_wave_rules())["on"] is False)
    s.check("the outbox has the column", "send_after" in {r[1] for r in q("PRAGMA table_info(email_outbox)")})
    s.check("the All settings sheet shows it", any(row["key"] == "email_waves" for sec in a.ADMIN_SETTINGS["cycle"]
                                                   ["sections"] for row in sec["rows"]))
finally:
    (a.mailer.send_mail, a.mailer.is_configured, a.mailer.config_status, a.mailer.get_token, a.OUTBOX_ASYNC,
     a.OUTBOX_PACE, a.OUTBOX_WATCH) = _real
    a.reminder_items, a.reminder_people, a._outbox_kick, a.time = _real_items, _real_people, _real_kick, time
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        db.execute("DELETE FROM app_settings WHERE key IN (%s)" % ",".join("?" * len(KEYS)), KEYS)
        for k, v in _settings.items():
            db.execute("INSERT INTO app_settings(key,value) VALUES (?,?)", (k, v))
        db.commit()

sys.exit(s.done())
