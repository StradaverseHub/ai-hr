"""The leader emails' "Next:" line names the day the sender will actually send (Chris, 2026-11-09: the line said "Mon 9 Nov" for Leader
progress while the KPI moderation part is counted only from the day AFTER it opens, so the sender sent nothing that day).

ONE rule: lp_counted_on (the parts counted on a day) -> lp_sends_on (a send day by the rules AND a part counted) -> read by lp_next_send (the line, on Email > Schedule and the Leader progress page) and email_cal_plan (the calendar); the BG
admins' bga_send_day is the same rule for its own rules (bga_next_send, the Email calendar, the Leader progress page's BG admin card).
The sender is the independent oracle: its stubbed send records a real send only when lp_live_parts has a part counted that day.

What this holds (clock pinned, KPI moderation opens 9 Nov, KPI check-in closed 8 Nov):
  * the opening day is no send day: from 8 Nov the Next is 10 Nov, not 9 Nov; the sender, run on 9 Nov, emails nobody and writes nothing; on 10 Nov it sends
  * a day marked by setting the last-sent date ahead (production's holiday mark) and a live skip are passed over, as the sender does
  * for each start day the line equals the first day the sender (lp_auto / bga_auto, run day by day at the send time) really sends on
  * the Email calendar puts Leader progress and BG admin status on the same days as the line
  * the BG admin card on the Leader progress page says the same Next as bga_next_send
  * FALSIFIED: with the shared rule broken (every day counts), the line and the sender no longer agree
Synthetic world on a fresh scratch database; every setting and window is put back."""
import json
import os
import re
import sys
from datetime import date, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Leader emails: the Next line is the day the sender sends")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
import gh_mail_world as GW  # noqa: E402

SU, BGA, EMP = H.actors(a)
W = GW.world(a, a.DB_PATH)
db, run = W.db, W.run
_real = (a.mailer.is_configured, a._outbox_kick, a.lp_send, a.bga_send)
sent = {"lp": [], "bga": []}
idle = []   # a run of the sender on a day with no part counted (lp_live_parts, what the real send builds from): it emails nobody


def _stub(kind):
    def f(d, cyc_, why, **k):
        rules = a.lp_rules() if kind == "lp" else a.bga_rules()
        if a.lp_live_parts(d, cyc_, rules, a._today_myt())[0]:
            sent[kind].append(a._today_myt())   # a real send: something was counted
        else:
            idle.append((kind, a._today_myt()))   # the job ran, nobody gets an email
        return {"leaders": 0, "admins": 0, "emailed": 0, "nothing": 0, "no_email": 0}
    return f


a.mailer.is_configured = lambda: True
a._outbox_kick = lambda *x, **k: False
a.lp_send, a.bga_send = _stub("lp"), _stub("bga")
D = lambda n, m=11: date(2026, m, n)   # noqa: E731
LP_ALL = ["bgceo", "buceo", "cg", "hod"]


class Patch:
    def __init__(self, name, fn):
        self.name, self.fn = name, fn

    def __enter__(self):
        self.old = getattr(a, self.name)
        setattr(a, self.name, self.fn)

    def __exit__(self, *x):
        setattr(a, self.name, self.old)


def cyc(d):
    return a.active_cycle(d)


def rules_set(parts):
    W.setting("leader_progress_rules", json.dumps(dict(a.LP_DEFAULT_RULES, enabled=True, freq="every", every_days=1, send_time="08:30",
                                                       roles=LP_ALL, parts=parts)))
    W.setting("bg_admin_progress_rules", json.dumps({"enabled": True, "send_time": "08:30", "parts": parts}))


def nxt(kind):
    f = a.lp_next_send if kind == "lp" else a.bga_next_send
    return run(lambda d: f(d, cyc(d), None, a._now_myt()))


def auto(kind):
    f = a.lp_auto if kind == "lp" else a.bga_auto
    return run(lambda d: f(d, cyc(d)))


def sender_day(kind, start, until=D(20)):
    """The first day from `start` the sender really sends on: the job run at 08:31 each day (the clock pinned), as the 15-minute timer
    would. The list of days it sent is what the stubbed lp_send / bga_send recorded."""
    sent[kind].clear()
    d = start
    while d <= until:
        W.clock(d.day, 8, 31, d.month)
        auto(kind)
        if sent[kind]:
            return sent[kind][0]
        d = date.fromordinal(d.toordinal() + 1)
    return None


def agree(kind, start):
    """(line's day, sender's day) from `start` 08:00, each on its own copy of the settings (the sender writes *_last as it goes)."""
    last_key = "leader_progress_last" if kind == "lp" else a.BGA_LAST_KEY
    W.clock(start.day, 8, 0, start.month)
    row = db.execute("SELECT value FROM app_settings WHERE key=?", (last_key,)).fetchone()
    line = nxt(kind)
    sd = sender_day(kind, start)
    db.execute("DELETE FROM app_settings WHERE key=?", (last_key,))
    if row:
        db.execute("INSERT INTO app_settings(key,value) VALUES (?,?)", (last_key, row[0]))
    db.commit()
    return (line.date() if line else None), sd


try:
    W.calendar(main=True)   # KPI check-in 2-8 Nov, KPI moderation 9-15, HOD 12-18 ...
    W.rem_settings(days=(2, 1))
    rules_set(["pm_approve"])

    s.section("the opening day: counted from the day after the part opens")
    W.clock(8, 8, 0)
    s.check("from 8 Nov the leader line is 10 Nov, 08:30 (9 Nov is the day KPI moderation opens: counted from tomorrow)",
            nxt("lp") == datetime(2026, 11, 10, 8, 30), nxt("lp"))
    s.check("...and the BG admin line is the same", nxt("bga") == datetime(2026, 11, 10, 8, 30), nxt("bga"))
    W.clock(9, 8, 31)
    msg_lp = auto("lp")
    s.check("the sender on 9 Nov at 08:31 emails nobody and says why (nothing is counted: it sends nothing, not even an idle run)",
            not sent["lp"] and not idle and "nothing goes out today" in msg_lp, (sent, idle, msg_lp))
    s.check("...and it writes no last-sent date for the day (9 Nov, Chris 2026-11-09: it used to, which overwrote a holiday mark)",
            db.execute("SELECT value FROM app_settings WHERE key='leader_progress_last'").fetchone() is None)
    W.setting("leader_progress_last", "2026-11-20")   # a holiday mark set ahead
    msg_lp = auto("lp")
    s.check("a last-sent date set ahead survives an idle send day (no part counted)",
            "nothing goes out today" in msg_lp and db.execute("SELECT value FROM app_settings WHERE key='leader_progress_last'").fetchone()[0] == "2026-11-20", msg_lp)
    with Patch("lp_counted_on", lambda db_, cyc_, rules, day, today=None: [p for p in a.LP_PARTS if p[0] in rules["parts"]]):
        auto("lp")
    s.check("FALSIFIED: with the guard's rule broken (every day counts) the idle run overwrites the mark and sends",
            db.execute("SELECT value FROM app_settings WHERE key='leader_progress_last'").fetchone()[0] == "2026-11-09" and sent["lp"] == [], sent)
    db.execute("DELETE FROM app_settings WHERE key='leader_progress_last'")
    db.commit()
    idle.clear()
    sent["lp"].clear()
    msg = auto("bga")
    s.check("the BG admins' sender on 9 Nov likewise", not sent["bga"] and "nothing goes out today" in msg, msg)
    W.clock(10, 8, 31)
    auto("lp")
    auto("bga")
    s.check("on 10 Nov both send", sent["lp"] == [D(10)] and sent["bga"] == [D(10)], sent)
    s.check("...and the leaders' job records 10 Nov as sent (a counted part: the guard lets it through)",
            db.execute("SELECT value FROM app_settings WHERE key='leader_progress_last'").fetchone()[0] == "2026-11-10")
    db.execute("DELETE FROM app_settings WHERE key='leader_progress_last'")
    db.commit()
    msg_none = run(lambda d: a.lp_auto(d, None))
    s.check("lp_auto with no cycle at all returns the no-part line and writes nothing",
            "nothing goes out today" in msg_none and db.execute("SELECT value FROM app_settings WHERE key='leader_progress_last'").fetchone() is None, msg_none)
    for k_ in ("leader_progress_last", a.BGA_LAST_KEY):
        db.execute("DELETE FROM app_settings WHERE key=?", (k_,))
    db.commit()
    idle.clear()
    sent["lp"].clear()
    sent["bga"].clear()

    s.section("the line equals the sender's day, from every start day")
    for kind in ("lp", "bga"):
        for start in (D(5), D(8), D(9), D(10), D(12)):
            ln, sd = agree(kind, start)
            s.check("%s from %d Nov: line %s = sender %s" % (kind, start.day, ln, sd), ln == sd and sd is not None, (ln, sd))
    s.check("from 5 Nov (the KPI check-in is not what these rules count) the first day is 10 Nov, never the opening day 9 Nov",
            agree("lp", D(5))[0] == D(10))

    s.section("a holiday marked by the last-sent date set ahead, and a live skip")
    for kind, last_key in (("lp", "leader_progress_last"), ("bga", a.BGA_LAST_KEY)):
        W.setting(last_key, "2026-11-10")
        ln, sd = agree(kind, D(10))   # from 10 Nov 08:00 (the leaders' sender records 9 Nov's idle run, which would overwrite a mark set on it)
        s.check("%s: 10 Nov marked as sent: the line is 11 Nov and the sender sends on 11 Nov" % kind, ln == D(11) == sd, (ln, sd))
        db.execute("DELETE FROM app_settings WHERE key=?", (last_key,))
        db.commit()
    run(lambda d: a.email_skip_set(d, SU, "lp", D(10), "ZZ test: holiday", now=datetime(2026, 11, 8, 7, 0)))
    run(lambda d: a.email_skip_set(d, SU, "bga", D(10), "ZZ test: holiday", now=datetime(2026, 11, 8, 7, 0)))
    for kind in ("lp", "bga"):
        ln, sd = agree(kind, D(8))
        s.check("%s: 10 Nov skipped: the line is 11 Nov and the sender sends on 11 Nov" % kind, ln == D(11) == sd, (ln, sd))
    db.execute("DELETE FROM email_skips")
    db.commit()

    s.section("a part already open: every day from its second day")
    rules_set(["pm_results"])   # KPI check-in 2-8 Nov
    for kind in ("lp", "bga"):
        ln, sd = agree(kind, D(4))
        s.check("%s from 4 Nov: the line and the sender are both 4 Nov" % kind, ln == sd == D(4), (ln, sd))
    W.clock(3, 8, 0)
    s.check("KPI check-in opened 2 Nov: 3 Nov is its first counted day, so the line from 2 Nov 08:00 is 3 Nov, not 2 Nov",
            (W.clock(2, 8, 0) or True) and nxt("lp") == datetime(2026, 11, 3, 8, 30), nxt("lp"))
    W.clock(9, 8, 0)
    s.check("after it closes (8 Nov) nothing is counted: no next send, as the sender would find", nxt("lp") is None and nxt("bga") is None)
    rules_set(["pm_approve"])

    s.section("the Email calendar puts them on the same days")
    W.clock(8, 8, 0)
    plan = run(lambda d: a.email_cal_plan(d, cyc(d), D(8), D(13), a._now_myt()))
    for key, kind in (("lp", "lp"), ("bga", "bga")):
        days = sorted(iso for iso, es in plan["days"].items() if any(e["key"] == key and e["state"] == "to_go" for e in es))
        s.check("%s: 9 Nov is not on the calendar, 10 Nov is, and the first one is the line's day" % key,
                "2026-11-09" not in days and "2026-11-10" in days and days[0] == nxt(kind).date().isoformat(), days)

    s.section("the Leader progress page: the BG admin card's Next")
    sup = H.client_as(a, SU["id"])
    page = sup.get("/admin/reminders/leaders").get_data(as_text=True)
    card = page[page.find('id="bga"'):]
    card = card[:card.find("</section>")]
    s.check("the BG admin card says 'Next: Tue 10 Nov 2026, 08:30' (bga_next_send's)",
            re.search(r"<b>Next:</b>\s*Tue 10 Nov 2026, 08:30", card) is not None, re.sub(r"\s+", " ", card)[:600])
    W.setting("bg_admin_progress_rules", json.dumps({"enabled": False, "send_time": "08:30", "parts": ["pm_approve"]}))
    page = sup.get("/admin/reminders/leaders").get_data(as_text=True)
    card = page[page.find('id="bga"'):]
    card = card[:card.find("</section>")]
    s.check("...off: 'It doesn't go out on its own' and no Next", "go out on its own" in card and "<b>Next:</b>" not in card)
    rules_set(["pm_approve"])

    s.section("FALSIFIED: with the shared rule broken the line names the opening day, a day the sender emails nobody")
    s.check("the control: the sender's first real send from 8 Nov is 10 Nov", sender_day("lp", D(8)) == D(10) and sender_day("bga", D(8)) == D(10))
    for k_ in ("leader_progress_last", a.BGA_LAST_KEY):
        db.execute("DELETE FROM app_settings WHERE key=?", (k_,))
    db.commit()
    every = lambda db_, cyc_, rules, day, today=None: [p for p in a.LP_PARTS if p[0] in rules["parts"]]   # noqa: E731
    W.clock(8, 8, 0)
    with Patch("lp_counted_on", every):
        broken_line = nxt("lp")
        broken_bga = nxt("bga")
    s.check("broken, the line is no longer 10 Nov (it names 8 Nov, when nothing is counted): the agreement checks above would fail",
            broken_line != datetime(2026, 11, 10, 8, 30), broken_line)
    s.check("...nor the BG admin line", broken_bga != datetime(2026, 11, 10, 8, 30), broken_bga)
    W.clock(8, 8, 0)
    s.check("put back: the line is 10 Nov again", nxt("lp") == datetime(2026, 11, 10, 8, 30))
finally:
    a.mailer.is_configured, a._outbox_kick, a.lp_send, a.bga_send = _real
    W.restore()
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    else:
        os.environ["ONEHR_GRADEH"] = _ENV0

sys.exit(s.done())
