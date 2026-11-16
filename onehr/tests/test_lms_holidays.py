"""AI+ Learning: public holidays in the working-day clocks, and the admin calendar's "N others" (2026-10-24, the gap
check's parked items). Chris: "national 2026-2027 built in, L&D adds state/company days on Settings".

What this suite holds:
  * the clocks skip weekends and Malaysia's national holidays: an approval step's days, the day before a step falls due,
    L&D's working day (the digest)
  * L&D adds a day of its own (a weekday, named, not a national one already), removes it, switches a national day off and
    back on; each logged; a BG admin can't; the clocks follow at once
  * Settings lists them (national, provisional, added by L&D, switched off); the calendars name a holiday on its day
  * the admin calendar's "N others" opens every session that day in the side card
Everything here is synthetic (ZZHO) and removed at the end; the holiday setting is put back as it was.
"""
import html
import os
import re
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: public holidays in the clocks, and the calendar's day list")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG = "ZZHO Group"
_ENV0 = os.environ.get("ONEHR_LMS")
TODAY = a._today_myt()


def _cleanup(db):
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZHO %'")
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE username LIKE 'zzho-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    _HOL0 = (db.execute("SELECT value FROM app_settings WHERE key='lms_holidays'").fetchone() or [None])[0]
    db.execute("DELETE FROM app_settings WHERE key='lms_holidays'")
    LND = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzho-lnd', 'ZZ HO L&D', 'x', 'admin', ?)", (a.LMS_ADMIN_BG,)).lastrowid
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzho-bga', 'ZZ HO BG admin', 'x', 'admin', ?)", (BG,)).lastrowid
    P = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days) VALUES "
                   "('ZZHO Busy Day', 'inhouse', 'published', 7, 1)").lastrowid
    # four runs on one weekday next month: the calendar shows three and "1 others"
    nm = (TODAY.replace(day=1) + timedelta(days=40)).replace(day=1)
    BUSY = nm + timedelta(days=(2 - nm.weekday()) % 7 + 7)   # the second Wednesday
    for i in range(4):
        db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, seats, status) VALUES "
                   "(?, ?, ?, ?, 20, 'planned')", (P, "ZZHO run %d" % (i + 1), BUSY.isoformat(), BUSY.isoformat()))
    db.commit()


def u_(uid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def call(fn, *args, **kw):
    with a.app.test_request_context():
        return fn(*args, **kw)


def dbcall(fn, *args, **kw):
    with a.app.test_request_context():
        return fn(a.get_db(), *args, **kw)


def body(r):
    return html.unescape(r.get_data(as_text=True))


def one(sql, args=()):
    return H.one(a, sql, args)


D = date.fromisoformat
try:
    os.environ["ONEHR_LMS"] = "1"
    CL, CB = H.client_as(a, LND), H.client_as(a, BGA)

    s.section("the clocks skip the national holidays")
    s.check("a step of 1 working day from Friday 28 Aug 2026 falls on Tuesday 1 Sep (31 Aug is National Day)",
            call(a._lms_workdays, D("2026-08-28"), 1) == D("2026-09-01"))
    s.check("...from Friday 6 Nov, Tuesday 10 Nov (Deepavali's Monday replacement)",
            call(a._lms_workdays, D("2026-11-06"), 1) == D("2026-11-10"))
    s.check("...and 5 days over Chinese New Year: Monday 16 Feb 2026 to Wednesday 25 Feb",
            call(a._lms_workdays, D("2026-02-16"), 5) == D("2026-02-25"))
    s.check("the working day before Tuesday 1 Sep is Friday 28 Aug",
            call(a._lms_workday_before, D("2026-09-01")) == D("2026-08-28"))
    s.check("an approval step started Friday 28 Aug with 1 day is due Tuesday 1 Sep",
            call(a._lms_level_due, {"status": "pending", "level": 0, "chain": [{"days": 1}],
                                    "level_since": "2026-08-28 09:00:00"}) == D("2026-09-01"))
    s.check("Christmas isn't a working day (no digest), Thursday 24 Dec is",
            call(a.lms_workday, D("2026-12-25")) is False and call(a.lms_workday, D("2026-12-24")) is True)
    s.check("every built-in day is a weekday, and 2027's moon-sighted days are marked provisional",
            all(D(d).weekday() < 5 for d in a.LMS_HOLIDAYS_MY) and "2027-03-10" in a.LMS_HOLIDAYS_PROVISIONAL and
            a.LMS_HOLIDAYS_PROVISIONAL <= set(a.LMS_HOLIDAYS_MY))

    s.section("L&D's own days")

    def post(c, op, d, name=""):
        return c.post("/admin/learning/settings", data={"csrf_token": "tok", "action": "holiday", "op": op, "date": d,
                                                         "name": name})
    post(CB, "add", "2026-12-24", "ZZHO Company day")
    s.check("a BG admin can't add one", "2026-12-24" not in call(a.lms_holidays))
    s.check("...nor by the function itself", dbcall(a.lms_holiday_set, u_(BGA), "add", "2026-12-24", "ZZHO")[0] is False)
    post(CL, "add", "2026-12-24", "")
    s.check("a day needs its name", "2026-12-24" not in call(a.lms_holidays))
    post(CL, "add", "2026-12-26", "ZZHO Boxing Day")
    s.check("...and a weekday (a Saturday is skipped already)", "2026-12-26" not in call(a.lms_holidays))
    post(CL, "add", "2026-08-31", "ZZHO Merdeka")
    s.check("...and not a national one already", call(a.lms_holidays)["2026-08-31"]["src"] == "national")
    post(CL, "add", "2026-12-24", "ZZHO Company day")
    s.check("L&D adds Thursday 24 Dec: the clocks skip it at once", call(a.lms_holidays)["2026-12-24"]["src"] == "ld"
            and call(a._lms_workdays, D("2026-12-23"), 1) == D("2026-12-28"))
    s.check("...logged", one("SELECT COUNT(*) FROM activity_log WHERE user_id=? AND action='lms_settings' AND detail "
                             "LIKE '%Public holiday added: ZZHO Company day%'", (LND,)) == 1)
    post(CL, "remove", "2026-12-24")
    s.check("...and removes it", "2026-12-24" not in call(a.lms_holidays) and
            call(a._lms_workdays, D("2026-12-23"), 1) == D("2026-12-24"))
    post(CL, "off", "2026-08-31")
    s.check("L&D switches a national day off: it counts as a working day",
            call(a._lms_workdays, D("2026-08-28"), 1) == D("2026-08-31"))
    post(CL, "on", "2026-08-31")
    s.check("...and back on", call(a._lms_workdays, D("2026-08-28"), 1) == D("2026-09-01"))

    s.section("Settings and the calendars")
    with a.app.test_request_context():
        a.lms_holiday_set(a.get_db(), u_(LND), "add", (TODAY + timedelta(days=(3 - TODAY.weekday()) % 7 + 7)).isoformat(),
                          "ZZHO Company day")
        a.lms_holiday_set(a.get_db(), u_(LND), "off", "2027-10-28")
    pg = body(CL.get("/admin/learning/settings"))
    s.check("Settings lists them: national, added by L&D, switched off, with the add form",
            "Public holidays" in pg and "National" in pg and "Added by L&D" in pg and "ZZHO Company day" in pg and
            "Switched off" in pg and "Add the day…" in pg)
    s.check("...2027's moon-sighted days provisional", "Provisional" in pg or TODAY.year > 2027)
    pgb = body(CB.get("/admin/learning/settings"))
    s.check("a BG admin reads them, with nothing to change", "Public holidays" in pgb and "Add the day…" not in pgb and
            "Switch off…" not in pgb)
    with a.app.test_request_context():
        cal = a.lms_calendar(a.get_db(), u_(LND), "2026-12", staff=False)
    cell = next(c for w in cal["weeks"] for c in w if c["iso"] == "2026-12-25")
    s.check("the calendar names a holiday on its day", cell["holiday"] == "Christmas Day")
    s.check("...on staff's month too", "Christmas Day" in body(CL.get("/admin/learning/calendar?m=2026-12")))

    s.section("the admin calendar's day list")
    m = BUSY.isoformat()[:7]
    cg = body(CL.get("/admin/learning/calendar?m=%s" % m))
    s.check("a day with four sessions shows three and links the rest",
            re.search(r'<a class="lc-evx" href="[^"]*[?&]d=%s"[^>]*>1 others</a>' % BUSY.isoformat(), cg) is not None)
    dg = body(CL.get("/admin/learning/calendar?m=%s&d=%s" % (m, BUSY.isoformat())))
    s.check("...which opens every session that day in the side card",
            all("ZZHO run %d" % i in dg for i in range(1, 5)) and "4 sessions" in dg)
finally:
    if _ENV0 is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = _ENV0
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM app_settings WHERE key='lms_holidays'")
        if _HOL0 is not None:
            db.execute("INSERT INTO app_settings(key, value) VALUES ('lms_holidays', ?)", (_HOL0,))
        _cleanup(db)

sys.exit(s.done())
