"""A reminder's date range (Chris, 2026-10-19: "for the recurring, admin should be able to configure from 1 Oct to 10 Oct
to send out the employee reminder every day at 9am; similarly for BU and BGCEO reminder").

What this suite holds:
  * everyone's reminder: "every N days from <first> to <last>" counts from the first day, every N days, while any part
    is open, and never outside the dates; with only a last day, the old repeat (from each part's opening) stops there;
    with no dates it is as before; dates with no repeat given mean every day
  * a cycle whose parts open by date, with none dated, has no send day at all (not even the old target-date rule)
  * the form: saves the two dates, refuses a last day before the first and a date it can't read, and shows them again
  * the leader progress email: never outside its dates, "every N days" counted from the first day, the words say so,
    and its form saves and refuses the same way
"""
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A reminder's date range: every day from 1 Oct to 10 Oct at 09:00")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
KEYS = ("reminder_auto_enabled", "reminder_days_before", "reminder_send_time", "reminder_on_open", "reminder_every_days",
        "reminder_every_from", "reminder_every_to", "leader_progress_rules")
with a.app.app_context():
    db = a.get_db()
    CYC = db.execute("SELECT * FROM cycles WHERE is_active=1").fetchone()
    CID = CYC["id"]
    SAVED = {k: db.execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone() for k in KEYS}
    WIN = [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows WHERE cycle_id=?",
                                        (CID,))]
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]


def window(opens, closes):
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        if opens or closes:
            d.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_results', ?, ?)",
                      (CID, opens, closes))
        d.commit()


def reasons(day, **kw):
    rules = dict(enabled=True, on_open=False, days_before=[], every_days=0, send_time="09:00", every_from=None,
                 every_to=None)
    rules.update(kw)
    with a.app.test_request_context("/"):
        d = a.get_db()
        return a.reminder_reasons(d, a.active_cycle(d), day, rules)


D = lambda m, dd: date(2026, m, dd)   # noqa: E731
try:
    window("2026-09-25 00:00", "2026-12-31 23:59")   # the results check-in open all through

    s.section("everyone's reminder")
    rng = dict(every_days=1, every_from="2026-10-01", every_to="2026-10-10")
    s.check("every day from 1 Oct to 10 Oct: the first day, a middle one and the last",
            all(reasons(x, **rng) == ["every day from 1 Oct 2026 to 10 Oct 2026"] for x in (D(10, 1), D(10, 5), D(10, 10))),
            reasons(D(10, 1), **rng))
    s.check("...never the day before or the day after", reasons(D(9, 30), **rng) == [] and reasons(D(10, 11), **rng) == [])
    two = dict(rng, every_days=2)
    s.check("every 2 days counts from the first day", reasons(D(10, 1), **two) and not reasons(D(10, 2), **two)
            and reasons(D(10, 3), **two))
    s.check("...whichever day that is: every 3 days from 1 Oct and from 2 Oct each start on their first day",
            all(reasons(D(10, d0), every_days=3, every_from="2026-10-%02d" % d0) and
                reasons(D(10, d0 + 3), every_days=3, every_from="2026-10-%02d" % d0) and
                not reasons(D(10, d0 + 1), every_days=3, every_from="2026-10-%02d" % d0) for d0 in (1, 2)))
    s.check("only a first day: every day from it on", reasons(D(11, 20), every_days=1, every_from="2026-10-01")
            == ["every day from 1 Oct 2026"])
    to_only = dict(every_days=1, every_to="2026-10-10")
    s.check("only a last day: the old repeat while a part is open, until then", reasons(D(10, 5), **to_only)
            and not reasons(D(10, 11), **to_only))
    s.check("no dates: as before, every N days while each part is open", reasons(D(10, 15), every_days=1)
            == ["every 1 days while the results check-in is open"])

    s.section("a cycle whose parts open by date, none dated")
    window(None, None)
    old = dict(days_before=[(date.fromisoformat(CYC["ends_on"][:10]) - D(8, 1)).days], every_days=1)
    s.check("the old rule (days before the cycle's target date) still holds for a cycle without the flag",
            reasons(D(8, 1), **old) != [], reasons(D(8, 1), **old))
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE cycles SET open_by_date=1 WHERE id=?", (CID,))
        d.commit()
    try:
        s.check("...but a cycle whose parts open by date has no send day while nothing is dated",
                reasons(D(8, 1), **old) == [] and reasons(D(10, 3), every_days=1, every_from="2026-10-01") == [])
        window("2026-09-25 00:00", "2026-10-31 23:59")   # its only dated part closes on 31 Oct
        nov = dict(every_days=1, every_from="2026-11-01", every_to="2026-11-10")
        s.check("...and a range day after its parts have closed sends nothing", reasons(D(11, 5), **nov) == []
                and reasons(D(10, 30), **dict(nov, every_from="2026-10-25")) != [])
    finally:
        with a.app.app_context():
            d = a.get_db()
            d.execute("UPDATE cycles SET open_by_date=? WHERE id=?", (a._row_get(CYC, "open_by_date"), CID))
            d.commit()

    s.section("the form")
    SUP = H.client_as(a, SU["id"])
    base = {"csrf_token": "tok", "action": "save_schedule", "enabled": "on", "send_time": "09:00"}
    SUP.post("/admin/reminders", data=dict(base, every_days="1", range_from="2026-10-01", range_to="2026-10-10"))
    r = H.client_as(a, SU["id"])
    got = None
    with a.app.test_request_context("/"):
        got = a.reminder_rules()
    s.check("it saves the two dates and the repeat", got["every_from"] == "2026-10-01" and got["every_to"] == "2026-10-10"
            and got["every_days"] == 1, got)
    pg = SUP.get("/admin/reminders").get_data(as_text=True)
    s.check("...and shows them again", 'name="range_from" value="2026-10-01"' in pg and 'name="range_to" value="2026-10-10"'
            in pg)
    SUP.post("/admin/reminders", data=dict(base, every_days="1", range_from="2026-10-10", range_to="2026-10-01"))
    with a.app.test_request_context("/"):
        got2 = a.reminder_rules()
    s.check("a last day before the first is refused, nothing changed", got2["every_from"] == "2026-10-01"
            and got2["every_to"] == "2026-10-10")
    SUP.post("/admin/reminders", data=dict(base, every_days="1", range_from="2026-13-01", range_to=""))
    with a.app.test_request_context("/"):
        got3 = a.reminder_rules()
    s.check("...and so is a date it can't read", got3["every_from"] == "2026-10-01")
    SUP.post("/admin/reminders", data=dict(base, every_days="", range_from="2026-10-02", range_to="2026-10-03"))
    with a.app.test_request_context("/"):
        got4 = a.reminder_rules()
    s.check("dates with no repeat given: every day within them", got4["every_days"] == 1
            and got4["every_from"] == "2026-10-02")
    SUP.post("/admin/reminders", data=dict(base, every_days="2", range_from="", range_to=""))
    with a.app.test_request_context("/"):
        got5 = a.reminder_rules()
    s.check("blank dates clear the range", got5["every_from"] is None and got5["every_to"] is None
            and got5["every_days"] == 2)
    s.check("each save is in the audit log, the range in words", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='reminder_schedule' AND detail LIKE "
           "'%from 1 Oct 2026 to 10 Oct 2026%'", (LOG0,)) == 1)

    s.section("the leader progress email")
    with a.app.test_request_context("/"):
        d = a.get_db()
        cy = a.active_cycle(d)
        wk = dict(a.LP_DEFAULT_RULES, enabled=True, freq="weekly", weekday=D(10, 5).weekday(),
                  range_from="2026-10-01", range_to="2026-10-10")
        s.check("weekly within its dates: the Monday inside, not the Monday after", a.lp_send_day(d, cy, D(10, 5), wk)
                and not a.lp_send_day(d, cy, D(10, 12), wk))
        ev = dict(wk, freq="every", every_days=1, since="2026-10-19")
        s.check("every day from the first day, whatever day it was saved", a.lp_send_day(d, cy, D(10, 1), ev)
                and a.lp_send_day(d, cy, D(10, 10), ev) and not a.lp_send_day(d, cy, D(9, 30), ev)
                and not a.lp_send_day(d, cy, D(10, 11), ev))
        s.check("the words say so", a.lp_schedule_words(ev) == "every day from 1 Oct 2026 to 10 Oct 2026")
    lbase = {"csrf_token": "tok", "action": "save_rules", "freq": "every", "every_days": "1", "send_time": "09:00",
             "role": ["buceo"], "part": ["pm_results"]}
    SUP.post("/admin/reminders/leaders", data=dict(lbase, range_from="2026-10-01", range_to="2026-10-10"))
    with a.app.test_request_context("/"):
        lr = a.lp_rules()
    s.check("its form saves the dates", lr["range_from"] == "2026-10-01" and lr["range_to"] == "2026-10-10", lr)
    s.check("...shows them again", 'name="range_from" value="2026-10-01"' in SUP.get(
        "/admin/reminders/leaders").get_data(as_text=True))
    SUP.post("/admin/reminders/leaders", data=dict(lbase, range_from="2026-10-10", range_to="2026-10-01"))
    with a.app.test_request_context("/"):
        lr2 = a.lp_rules()
    s.check("...and refuses a last day before the first", lr2["range_from"] == "2026-10-01")
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        _db.executemany("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", WIN)
        for k, v in SAVED.items():
            _db.execute("DELETE FROM app_settings WHERE key=?", (k,))
            if v is not None:
                _db.execute("INSERT INTO app_settings(key,value) VALUES (?,?)", (k, v[0]))
        _db.execute("DELETE FROM activity_log WHERE id>? AND action IN ('reminder_schedule','leader_progress_schedule')",
                    (LOG0,))
        _db.commit()

sys.exit(s.done())
