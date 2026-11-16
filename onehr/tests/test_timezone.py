"""Store UTC, display MYT -- bd675e2.

RECONSTRUCTED. The original suite lived in /private/tmp and was lost to a macOS
cleanup; this asserts the same invariants, written from the commit's own record
of them. Where the original checked a count taken from the live VM, this checks
the RELATIONSHIP instead, because it runs against the repo's local database.

Both VMs run Etc/UTC and every user is in Malaysia, so the server clock is never
the right answer to a user-facing question.
"""
import datetime as dt
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Timezone -- store UTC, display MYT")
SU, _BG, _EMP = H.actors(a)
SRC = H.source(a)
CODE = H.code_without_docstrings(SRC)

s.section("the two clock helpers")
delta = a._now_myt() - dt.datetime.utcnow()
s.check("_now_myt() is 8h ahead of UTC", abs(delta.total_seconds() - 8 * 3600) < 2, delta)
s.check("_today_myt() == _now_myt().date()", a._today_myt() == a._now_myt().date())

s.section("the 00:00-08:00 MYT window -- where UTC still says yesterday")
# The eight hours a day in which the server's own date is the PREVIOUS day.
# Nobody tests at 02:00, which is why these bugs survived; freeze the clock
# rather than spot-checking during office hours.
real_now = a._now_myt
try:
    a._now_myt = lambda: dt.datetime(2026, 8, 22, 2, 0)     # 18:00 UTC on the 21st
    s.check("_today_myt() returns the MYT day", a._today_myt() == dt.date(2026, 8, 22),
            a._today_myt())
    cycle = {"ends_on": "2026-08-25"}
    s.check("days_until_deadline counts from the MYT date",
            a.days_until_deadline(cycle) == 3, a.days_until_deadline(cycle))
    a._now_myt = lambda: dt.datetime(2026, 8, 21, 23, 0)    # one hour earlier
    s.check("...and is one MORE the hour before MYT midnight",
            a.days_until_deadline(cycle) == 4, a.days_until_deadline(cycle))
    a._now_myt = lambda: dt.datetime(2026, 8, 22, 2, 0)
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = SU["id"]
        name = a._export_filename("results", SU, "csv")
    s.check("an export filename stamps the MYT date", name.endswith("_2026-08-22.csv"), name)
finally:
    a._now_myt = real_now

s.section("the display filters")
s.check("myt shifts a stored UTC timestamp",
        a._myt("2026-08-21 17:30:00") == "2026-08-22 01:30", a._myt("2026-08-21 17:30:00"))
s.check("myt_date gives the MYT DATE, not the UTC one",
        a._myt_date("2026-08-21 17:30:00") == "2026-08-22", a._myt_date("2026-08-21 17:30:00"))
s.check("myt_date on the same day stays put", a._myt_date("2026-08-22 01:00:00") == "2026-08-22")
s.check("myt_date(None) is '', not a crash", a._myt_date(None) == "")
s.check("myt_date('') is ''", a._myt_date("") == "")
s.check("myt_date passes unparseable text through",
        a._myt_date("not a date") == "not a date"[:10])
s.check("both filters are registered on Jinja",
        "myt" in a.app.jinja_env.filters and "myt_date" in a.app.jinja_env.filters)

s.section("the lint -- staging's only backstop")
# Production dropped `date` from the import entirely, so date.today() is a
# NameError there. Staging CANNOT: date.fromisoformat is used at three sites.
# This lint is the only thing standing in for that. Keep it.
s.check("no date.today() in code", "date.today()" not in CODE)
s.check("no datetime.now() in code", "datetime.now()" not in CODE)
s.check("utcnow survives ONLY inside _now_myt", CODE.count("utcnow") == 1, CODE.count("utcnow"))
s.check("date.fromisoformat still used -- which is WHY the lint is needed",
        "date.fromisoformat" in CODE)
import ast  # noqa: E402
_tm = [n for n in ast.walk(ast.parse(SRC))
       if isinstance(n, ast.FunctionDef) and n.name == "_today_myt"][0]
_lines = set(range(_tm.lineno, _tm.end_lineno + 1))
_outside = [i + 1 for i, line in enumerate(SRC.splitlines())
            if "_now_myt().date()" in line and (i + 1) not in _lines]
s.check("_now_myt().date() appears only inside _today_myt()", not _outside, _outside)

s.section("storage is untouched -- UTC in, always")
# Mixing zones inside one column would make every existing row and every future
# comparison unreliable, and no migration repairs it afterwards.
s.check("SQL still writes UTC (datetime('now') unqualified)",
        SRC.count("datetime('now')") > 100, SRC.count("datetime('now')"))
s.check("the MYT day-buckets are still there ('+8 hours')",
        SRC.count("'+8 hours'") >= 6, SRC.count("'+8 hours'"))
s.check("rolling windows are durations, left alone", "-30 days" in SRC or "-60 minutes" in SRC)

s.section("four things that look like hits and must stay raw")
act = H.source(a, os.path.join("templates", "admin_activity.html"))
rem = H.source(a, os.path.join("templates", "admin_reminders.html"))
sent = H.source(a, os.path.join("templates", "admin_email_sent.html"))   # the runs moved to Email › Sent (2026-10-24)
# the Usage page's recent feed went (2026-10-10): it repeated the Audit log, which shows every time in MYT. What is
# left is the day buckets, already MYT ('+8 hours'), so no stored UTC timestamp reaches this page.
s.check("admin_activity shows no stored UTC timestamp (its recent feed is the Audit log now)",
        "created_at" not in act and "{{ d['d'] }}" in act)
# the one reminder (2026-10-10) has no sortable activity table any more: its Sent list is the runs, shown in MYT
s.check("Email › Sent shows the reminder's sends in MYT",
        '"when": _when_disp(_myt(r["created_at"]))' in SRC and "{{ r.when }}" in sent)
s.check("bulk_meta started_at is already MYT and labelled so",
        "{{ bulk_meta.get('started_at', '?') }} MYT" in rem)

s.section("no template slices a stored timestamp any more")
import glob  # noqa: E402
import re  # noqa: E402
bad = []
for path in glob.glob(os.path.join(H.HARNESS, "templates", "*.html")):
    for i, line in enumerate(open(path, encoding="utf-8").read().splitlines(), 1):
        for m in re.finditer(r"\{\{([^}]*)\}\}", line):
            expr = m.group(1)
            if re.search(r"_at'?\]?\[:\d+\]", expr) and "myt" not in expr:
                bad.append((os.path.basename(path), i, expr.strip()[:50]))
s.check("zero '[:10]' slices of a *_at value remain", not bad, bad[:4])

s.section("the primary structural check")
# Jinja resolves filter names at COMPILE time, so this reaches the succession,
# BUCEO/BGCEO calibration and talent-decision pages that the stale local
# database and the tier gates cannot.
n, broken = H.every_template_compiles(a)
s.check("all %d templates compile" % n, not broken, broken[:3])

sys.exit(s.done())
