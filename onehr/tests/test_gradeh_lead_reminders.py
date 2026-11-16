"""Grade H Appraisal: the leaders' THREE reminder days (Chris, 2026-11-06: "remove the daily reminder, for appraisal, send them 3 times
(open days, 3 days before, last day). same for HODs calibration (send on first day, 3 days before, last day) and BUCEO").

What this suite holds, every day from 6 to 30 Nov 2026 (the clock is moved to 09:30 MYT of each day; the world moves with it: an
acknowledgement or a sign-off lands at its own time):
  * the appraiser (gradeh_lm, 6-18 Nov) is in the reminder EMAIL only on 6, 15 and 18; the bar (reminder_items) shows them every day 6-18
  * an HOD whose people had all acknowledged by 14 Nov 08:30: the stage first opened that day, so 14, then 18 and 21 (calendar 12-21)
  * an HOD whose last person acknowledged after that day's send time (14 Nov 10:00): the send could not see it open, so 15, 18, 21
  * an HOD whose people never all acknowledge: opens on the fallback (19 Nov 00:00), so 19 and 21 (18 is before it opened for them)
  * an HOD whose people had all acknowledged before the cell: the cell's own start (12), then 18 (their item is gone once they sign)
  * a BU CEO (cell 19-23): a unit whose last HOD signed on 20 Nov 08:30 -> 20 and 23; on 21 Nov 08:00 -> 21 and 23 (20 is before it
    opened); a unit with no HOD stage -> the cell's start, 19, then 20 and 23; a unit whose HODs never sign -> the fallback, 22 and 23
  * the bar never changes: every leader's Grade H item is shown on every day its part is open for them, as before
  * reminder_why: the four leader cells never follow the every-N-days rule, the range rule or the global days_before / on_open (the
    same days under three different global rules); the fallback days are reasons ("opens for those still waiting"); every OTHER cell
    (the main review, Grade H staff) reads exactly as the old rule (an oracle written here), every day
  * the send and the send-time recheck both hold it; Email > Schedule shows the leader days, and says so in one line
  * FALSIFIED: without the filter, without the every-rule exclusion, and with the cell's start in place of the first-opened moment, the
    same checks fail
Synthetic (ZZLR-*) on a fresh scratch database; the suite puts back what it changes.
"""
import json
import os
import re
import sqlite3
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H leaders: reminded on three days only")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, EMP = H.actors(a)
PFX, BG = "ZZLR-", "ZZLR Group"
UNITS = {"CO": "ZZLR Unit A", "CO2": "ZZLR Unit B", "CO3": "ZZLR Unit C", "CO4": "ZZLR Unit D"}
U, P = {}, {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
# This suite is about the leaders' lines in Everyone's reminder by their own rules. The one-email rule (a leader who gets Grade H progress that
# day loses these lines, 2026-11-09) is tests/test_gradeh_leader_email.py's: here nobody is served by progress, so the lines read as they did.
a.gradeh_prog_served = lambda *x, **k: {}
LEAD = ("gradeh_lm", "gradeh_hod_pot", "gradeh_hod_perf", "gradeh_buceo")   # the suite's own list: a patched app constant does not move it
STAFF = ("gradeh_kpi", "gradeh_ack")
UTCF = "%Y-%m-%d %H:%M:%S"

db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")


def D(n, m=11):
    return date(2026, m, n)


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


def mk(k, grade="H", hod=None, co=UNITS["CO"], dept=None):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, job_title, hod_id, email, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?,?,?, 'Driver', ?,?, '2020-01-01')",
        ((PFX + k).lower(), "ZZ LR " + k, PFX + k, BG, co, dept or "ZZLR Dept " + k, grade, hod, (PFX + k).lower() + "@zzlr.example")).lastrowid


def person(k, appraiser=None, submitted=True, ack=None):
    pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, appraiser_id, language, language_set_at) "
                     "VALUES (?,?,?, 'B', ?, 'en', datetime('now'))", (CID, PFX + k, U[k], appraiser)).lastrowid
    P[k] = pid
    db.execute("INSERT INTO gradeh_appraisals (cycle_id, person_id, lm_submitted_at, perf_band, pot_band, acknowledged_at) "
               "VALUES (?,?,?,?,?,?)", (CID, pid, "2026-11-10 02:00:00" if submitted else None, "ME" if submitted else None,
                                       "Mid" if submitted else None, ack))
    return pid


def urow(k):
    return db.execute("SELECT * FROM users WHERE id=?", (U[k],)).fetchone()


def set_window(cell, opens, closes):
    db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell, opens, closes))
    db.commit()


def win(cell, o, c):
    set_window(cell, "2026-11-%02d 00:00" % o, "2026-11-%02d 23:59" % c)


def calendar(main=True):
    """The board's calendar for Nov 2026: staff KPI / acknowledge, the four leader cells, and (main) the main review."""
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    win("gradeh_kpi", 2, 10)
    win("gradeh_ack", 9, 20)
    win("gradeh_lm", 6, 18)
    win("gradeh_hod_pot", 12, 21)
    win("gradeh_hod_perf", 12, 21)
    win("gradeh_buceo", 19, 23)
    if main:
        win("pm_results", 2, 8)
        win("tc_self", 2, 8)
        win("pm_approve", 9, 15)
        win("pm_hod", 12, 18)
        win("pm_buceo", 16, 18)
        win("tb_bgceo", 19, 30)
    db.commit()


def setting(name, value):
    run(lambda d: a.gradeh_set_setting(d, name, value, None))


def utc(day, hh, mm=0):
    """A MYT date-time as the stored UTC string."""
    return (datetime(2026, 11, day, hh, mm) - timedelta(hours=8)).strftime(UTCF)


def rem_settings(days=(2, 1), on_open=True, every=1, send="09:00"):
    for k_, v_ in (("reminder_days_before", json.dumps(list(days))), ("reminder_on_open", "1" if on_open else "0"),
                   ("reminder_every_days", str(every)), ("reminder_auto_enabled", "1"), ("reminder_send_time", send)):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES (?,?)", (k_, v_))
    db.execute("DELETE FROM app_settings WHERE key IN ('reminder_every_from','reminder_every_to')")
    db.commit()


_NOW0 = a._now_myt


def clock(day, hh=9, mm=30):
    a._now_myt = lambda: datetime(2026, 11, day, hh, mm)


def clock_back():
    a._now_myt = _NOW0


# --- the world: units, leaders, people, and what lands when -------------------------------------------------------------------------
EVENTS = [(utc(13, 10), "ack", "HS1a"), (utc(14, 8, 30), "ack", "HS1b"), (utc(14, 10), "ack", "HS3a"),
          (utc(19, 20), "sign", "K1", "pot"), (utc(20, 8, 30), "sign", "K1", "perf"),
          (utc(20, 20), "sign", "L1", "pot"), (utc(21, 8), "sign", "L1", "perf")]


def reset_world():
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=NULL, deemed_at=NULL WHERE person_id IN (?,?,?)", (P["HS1a"], P["HS1b"], P["HS3a"]))
    db.execute("DELETE FROM gradeh_signoffs WHERE cycle_id=?", (CID,))
    db.commit()


def apply_events(now_myt):
    cut = (now_myt - timedelta(hours=8)).strftime(UTCF)
    for ev in EVENTS:
        at, kind = ev[0], ev[1]
        if at > cut:
            continue
        if kind == "ack":
            db.execute("UPDATE gradeh_appraisals SET acknowledged_at=? WHERE person_id=? AND acknowledged_at IS NULL", (at, P[ev[2]]))
        elif not db.execute("SELECT 1 FROM gradeh_signoffs WHERE cycle_id=? AND tier='hod' AND stage=? AND scope_key=?",
                            (CID, ev[3], str(U[ev[2]]))).fetchone():
            db.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by, signed_at) VALUES (?,?,?,?,?,?)",
                       (CID, "hod", ev[3], str(U[ev[2]]), U[ev[2]], at))
    db.commit()


LEADERS = ("M1", "H1", "H2", "H3", "K1", "L1", "B1", "B2", "B3", "B4")


def simulate(email_fn=None, days=range(6, 31)):
    """{leader: (days the bar shows a Grade H item, days the email does)}, the clock at 09:30 of each day and the world as it was then."""
    reset_world()
    bar, mail = {k: set() for k in LEADERS}, {k: set() for k in LEADERS}
    try:
        for n in days:
            clock(n)
            apply_events(a._now_myt())
            for k in LEADERS:
                items = run(lambda d, k=k: a.reminder_items(d, urow(k)))
                if any(i["group"] == "gradeh" for i in items):
                    bar[k].add(n)
                got = run(lambda d, k=k: (email_fn or a.reminder_items_email)(d, urow(k)))
                if any(i["group"] == "gradeh" for i in got):
                    mail[k].add(n)
    finally:
        clock_back()
        reset_world()
    return bar, mail


def rng(x, y):
    return set(range(x, y + 1))


EXPECT_MAIL = {"M1": {6, 15, 18}, "H1": {14, 18, 21}, "H2": {19, 21}, "H3": {15, 18, 21}, "K1": {12, 18}, "L1": {12, 18},
               "B1": {22, 23}, "B2": {20, 23}, "B3": {21, 23}, "B4": {19, 20, 23}}
EXPECT_BAR = {"M1": rng(6, 18), "H1": rng(14, 21), "H2": rng(19, 21), "H3": rng(15, 21), "K1": rng(12, 19), "L1": rng(12, 20),
              "B1": rng(22, 23), "B2": rng(20, 23), "B3": rng(21, 23), "B4": rng(19, 23)}


def old_rule(day, rules):
    """The reminder rule as it was before 2026-11-06, written out for every cell but the four leader cells: {(kind, cell)}."""
    out = set()
    for cell in a.WINDOW_KEYS:
        if cell in LEAD:
            continue
        mod = a._REMINDER_CELL_MODULE.get(cell)
        if mod and not run(lambda d, mod=mod: a.cycle_module_on(mod, d, CID)):
            continue
        o, c = (a._parse_when(x) for x in run(lambda d, cell=cell: a.window_dates(d, cell, CID)))
        is_open = bool(o) and o.date() <= day and (not c or c.date() >= day)
        if rules["on_open"] and o and o.date() == day:
            out.add(("open", cell))
        if is_open and c and (c.date() - day).days in rules["days_before"]:
            out.add(("close", cell))
        if is_open and rules["every_days"] and o and (day - o.date()).days > 0 and (day - o.date()).days % rules["every_days"] == 0 \
                and cell not in STAFF:
            out.add(("every", cell))
    return out


def why_set(day, rules):
    return {(k, c) for k, c, _w in run(lambda d: a.reminder_why(d, a.active_cycle(d), day, rules))}


def lead_expected():
    """{(day, kind, cell)} of the leader cells with both fallbacks set (19 Nov / 22 Nov) over 1-30 Nov."""
    out = {(6, "open", "gradeh_lm"), (15, "close", "gradeh_lm"), (18, "close", "gradeh_lm"),
           (19, "open", "gradeh_buceo"), (20, "close", "gradeh_buceo"), (23, "close", "gradeh_buceo"), (22, "fallback", "gradeh_buceo")}
    for c in ("gradeh_hod_pot", "gradeh_hod_perf"):
        out |= {(12, "open", c), (18, "close", c), (21, "close", c), (19, "fallback", c)}
    return out


def lead_days(rules):
    got = set()
    for n in range(1, 31):
        got |= {(n, k, c) for k, c in why_set(D(n), rules) if c in LEAD}
    return got


CID = run(lambda d: a.active_cycle_id(d))
HALF0, OBD0 = [db.execute("SELECT half, open_by_date FROM cycles WHERE id=?", (CID,)).fetchone()[k] for k in ("half", "open_by_date")]


def restore():
    clock_back()
    os.environ["ONEHR_GRADEH"] = _ENV0 if _ENV0 is not None else ""
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    db.execute("UPDATE cycles SET half=?, open_by_date=? WHERE id=?", (HALF0, OBD0, CID))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%' OR key LIKE 'reminder_%'")
    db.execute("DELETE FROM email_outbox")
    db.commit()


try:
    db.execute("UPDATE cycles SET half=2, open_by_date=1 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
    for c_ in UNITS.values():
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, c_))
    db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
    rem_settings()
    calendar()
    setting("gradeh_deemed_on", False)   # no deemed deadline: the acknowledge part's close is the only date (the oracle's simple case)
    setting("gradeh_hod_fallback_at", utc(19, 0))
    setting("gradeh_bu_fallback_at", utc(22, 0))
    # -- the world
    for k in ("B1", "B2", "B3", "B4"):
        U[k] = mk(k, "21", co=UNITS[{"B1": "CO", "B2": "CO2", "B3": "CO3", "B4": "CO4"}[k]], dept="ZZLR Division")
    U["M1"] = mk("M1", "15")
    U["S1"] = mk("S1", hod=None)
    person("S1", appraiser=U["M1"], submitted=False)
    # unit A (B1): three HODs, none ever signs; H1's people acknowledge on 13 / 14 Nov, H3's on 14 Nov 10:00, H2's never
    for h_ in ("H1", "H2", "H3"):
        U[h_] = mk(h_, "19", hod=U["B1"], co=UNITS["CO"])
    for k_, h_ in (("HS1a", "H1"), ("HS1b", "H1"), ("HS2a", "H2"), ("HS3a", "H3")):
        U[k_] = mk(k_, hod=U[h_], co=UNITS["CO"])
        person(k_)
    # unit B (B2): HOD K1, whose person acknowledged before the cell; K1 signs 19 Nov 20:00 and 20 Nov 08:30
    U["K1"] = mk("K1", "19", hod=U["B2"], co=UNITS["CO2"])
    U["K1p"] = mk("K1p", hod=U["K1"], co=UNITS["CO2"])
    person("K1p", ack="2026-11-10 02:00:00")
    # unit C (B3): HOD L1 signs 20 Nov 20:00 and 21 Nov 08:00
    U["L1"] = mk("L1", "19", hod=U["B3"], co=UNITS["CO3"])
    U["L1p"] = mk("L1p", hod=U["L1"], co=UNITS["CO3"])
    person("L1p", ack="2026-11-10 02:00:00")
    # unit D (B4): a person with no HOD stage
    U["N1"] = mk("N1", co=UNITS["CO4"])
    person("N1", ack="2026-11-10 02:00:00")
    for k_, co_ in (("B1", "CO"), ("B2", "CO2"), ("B3", "CO3"), ("B4", "CO4")):
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, UNITS[co_], U[k_]))
    db.commit()

    # ============================================================================================ the days, per leader
    s.section("every day 6-30 Nov, the clock at 09:30 and the world moving with it: the email, and the bar")
    bar, mail = simulate()
    for k in LEADERS:
        s.check("%s: the email on %s" % (k, sorted(EXPECT_MAIL[k])), mail[k] == EXPECT_MAIL[k], sorted(mail[k]))
    s.check("the appraiser: the opening day, 3 days before it closes and its last day (6, 15, 18 Nov)", mail["M1"] == {6, 15, 18})
    s.check("the HOD whose people had all acknowledged by 14 Nov 08:30: 14, then 18 and 21", mail["H1"] == {14, 18, 21})
    s.check("the HOD whose last person acknowledged after the 09:00 send (14 Nov 10:00): the next send day, 15, 18, 21", mail["H3"] == {15, 18, 21})
    s.check("the HOD whose people never all acknowledge opens on the fallback, 19 Nov: 19 and 21, nothing for 18 or 20", mail["H2"] == {19, 21})
    s.check("the BU CEO whose unit opened on 20 Nov: 20 and 23; on 21 Nov: 21 and 23 (20 was before it opened)", mail["B2"] == {20, 23} and mail["B3"] == {21, 23})
    s.check("the BU CEO with no HOD stage: the cell's start, 3 days before, the last day; on the fallback, 22 Nov: 22 and 23",
            mail["B4"] == {19, 20, 23} and mail["B1"] == {22, 23})
    for k in LEADERS:
        s.check("%s: the BAR is unchanged, the item shows every day it is open for them (%d days)" % (k, len(EXPECT_BAR[k])), bar[k] == EXPECT_BAR[k], sorted(bar[k]))
    s.check("...so the email's days are always inside the bar's (it never mails what the bar does not show)", all(mail[k] <= bar[k] for k in LEADERS)
            and sum(len(bar[k] - mail[k]) for k in LEADERS) > 30)

    s.section("the bar's own reader (the deadline bar's _dl_items) still lists the item every day it is open")
    ok = True
    for n in (6, 9, 14, 16, 18, 20, 22):
        clock(n)
        a._DL_CACHE.clear()
        reset_world()
        apply_events(a._now_myt())
        got = {k for k in ("M1", "H1", "B4") if any(i["group"] == "gradeh" for i in run(lambda d, k=k: a._dl_items(d, urow(k), a.active_cycle(d), a._now_myt())))}
        want = {k for k in ("M1", "H1", "B4") if n in EXPECT_BAR[k]}
        ok = ok and got == want
        if got != want:
            s.note("day %d: bar %s, want %s" % (n, sorted(got), sorted(want)))
    clock_back()
    reset_world()
    s.check("on 6, 9, 14, 16, 18, 20 and 22 Nov the bar's items are exactly those open for the leader (the email's days do not touch it)", ok)

    # ============================================================================================ the day rule
    s.section("reminder_why: the leader cells have their own three days, under any global rule")
    want = lead_expected()
    R1 = dict(run(lambda d: a.reminder_rules()), enabled=True, on_open=True, days_before=[2, 1], every_days=1, every_from=None, every_to=None)
    R2 = dict(R1, on_open=False, days_before=[5], every_days=3)
    R3 = dict(R1, every_days=0, days_before=[])
    for nm, R in (("on-open on, 2 and 1 days before, every day", R1), ("on-open OFF, 5 days before, every 3 days", R2),
                  ("no repeat, no days before", R3)):
        got = lead_days(R)
        s.check("%s: the leader cells' reasons are the same three days (+ the fallbacks)" % nm, got == want, sorted(got ^ want))
    s.check("...no leader cell is ever an 'every' day", all(k != "every" for _n, k, _c in lead_days(R1)))
    s.check("the close days are 3 and 0 (not the global [2, 1]): 15 and 18 Nov for the appraiser, 18 and 21 for the HODs, 20 and 23 for the BU CEO",
            {(n, c) for n, k, c in want if k == "close"} == {(15, "gradeh_lm"), (18, "gradeh_lm"), (18, "gradeh_hod_pot"), (21, "gradeh_hod_pot"),
                                                          (18, "gradeh_hod_perf"), (21, "gradeh_hod_perf"), (20, "gradeh_buceo"), (23, "gradeh_buceo")})
    s.check("a day with a fallback reason names it in words ('opens for those still waiting')",
            any("opens for those still waiting" in w for k, c, w in run(lambda d: a.reminder_why(d, a.active_cycle(d), D(19), R1)) if k == "fallback"))
    setting("gradeh_hod_fallback_at", "")
    setting("gradeh_bu_fallback_at", "")
    got = lead_days(R1)
    s.check("no fallback set: no fallback day (the cell alone decides), the rest as before", got == {x for x in want if x[1] != "fallback"}, sorted(got ^ want))
    setting("gradeh_hod_fallback_at", utc(9, 0))   # before the HOD cells open
    setting("gradeh_bu_fallback_at", utc(19, 0))   # the BU cell's own first day
    got = lead_days(R1)
    s.check("a fallback on or before the cell's start is no day of its own", got == {x for x in want if x[1] != "fallback"}, sorted(got ^ want))
    setting("gradeh_hod_fallback_at", utc(19, 19, 30))   # after the send time: the send could not see it open that day
    got = {(n, k) for n, k, c in lead_days(R1) if c == "gradeh_hod_pot" and k == "fallback"}
    s.check("a fallback at 19:30 opens for the 09:00 send of the NEXT day (20 Nov)", got == {(20, "fallback")}, got)
    setting("gradeh_hod_fallback_at", utc(19, 0))
    setting("gradeh_bu_fallback_at", utc(22, 0))

    s.section("the range rule never counts a leader's part as 'open'")
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    win("gradeh_lm", 6, 18)
    db.commit()
    RR = dict(R1, every_from="2026-11-01", every_to="2026-11-30")
    s.check("only the appraiser's part is open (the main review has no dates): no 'range' day on 8 Nov", ("range", None) not in why_set(D(8), RR), why_set(D(8), RR))
    win("pm_results", 2, 10)
    s.check("the control: with a main-review part open the same range rule sends on 8 Nov", ("range", None) in why_set(D(8), RR), why_set(D(8), RR))
    calendar()

    s.section("every OTHER cell reads exactly as the old rule: the main review and Grade H staff, every day 1-30 Nov")
    for nm, R in (("daily", R1), ("on-open off, 5 days before, every 3 days", R2), ("no repeat", R3)):
        bad = [n for n in range(1, 31) if {(k, c) for k, c in why_set(D(n), R) if c not in LEAD and k in ("open", "close", "every")} != old_rule(D(n), R)]
        s.check("%s: all 30 days match the old rule (%d cells in it)" % (nm, len({c for n in range(1, 31) for _k, c in old_rule(D(n), R)})), not bad, bad)
    staff_days = {n for n in range(1, 31) if any(c in STAFF for _k, c in why_set(D(n), R1))}
    want_staff = {n for n in range(1, 31) if any(c in STAFF for _k, c in old_rule(D(n), R1))}
    s.check("Grade H staff days (KPI achievement and acknowledging) are the old rule's: %s" % sorted(want_staff), staff_days == want_staff and len(want_staff) > 3, sorted(staff_days))
    s.check("...and reminder_day_parts says 'staff' on exactly those days (a day only staff's cells send is not Everyone's reminder)",
            all(run(lambda d, n=n: a.reminder_day_parts(d, a.active_cycle(d), D(n), R1))["staff"] is (n in want_staff) for n in range(1, 31)))

    # ============================================================================================ falsify
    s.section("falsified: each guard, taken out, makes the same checks fail")
    orig = (a.reminder_items_email, a.GRADEH_LEAD_CELLS, a.gradeh_hod_first_open, a.gradeh_bu_first_open)
    try:
        _b, m_nofilter = simulate(email_fn=lambda d, u, items=None: a.reminder_items(d, u))
        s.check("without the filter the email is the bar: the three-days check fails", m_nofilter != EXPECT_MAIL and m_nofilter == EXPECT_BAR, {k: sorted(v) for k, v in m_nofilter.items() if v != EXPECT_MAIL[k]})
        a.GRADEH_LEAD_CELLS = ()
        s.check("without the every-rule exclusion (the leader cells treated as any cell) the reason check fails", lead_days(R1) != want)
        a.GRADEH_LEAD_CELLS = orig[1]
        a.gradeh_hod_first_open = lambda d, cid, hod_id, cell, now=None: a._parse_when(a.window_dates(d, cell, cid)[0])
        a.gradeh_bu_first_open = lambda d, cid, company, business_group=None: a._parse_when(a.window_dates(d, a.GRADEH_CELL_BUCEO, cid)[0])
        _b, m_wrong = simulate()
        s.check("with the cell's start in place of the first-opened moment the HOD and BU CEO checks fail where the day matters (H1, H2, H3, B1, B3)",
                all(m_wrong[k] != EXPECT_MAIL[k] for k in ("H1", "H2", "H3", "B1", "B3"))
                and all(m_wrong[k] == EXPECT_MAIL[k] for k in ("M1", "K1", "L1", "B2", "B4")), {k: sorted(v) for k, v in m_wrong.items()})
    finally:
        a.reminder_items_email, a.GRADEH_LEAD_CELLS, a.gradeh_hod_first_open, a.gradeh_bu_first_open = orig
    _b, again = simulate()
    s.check("the control: with everything put back the days are right again", again == EXPECT_MAIL)

    # ============================================================================================ send, recheck
    s.section("the send, and the send-time recheck, hold it")
    db.execute("DELETE FROM email_outbox")
    db.execute("DELETE FROM notifications")
    db.commit()
    reset_world()
    apply_events(datetime(2026, 11, 14, 9, 30))
    calendar()

    def queue(day_, k):
        clock(day_)
        try:
            return run(lambda d: a.reminder_send(d, a.active_cycle(d), [d.execute("SELECT * FROM users WHERE id=?", (U[k],)).fetchone()],
                                                 "ZZLR test", live=True))
        finally:
            clock_back()

    def outbox(k):
        return db.execute("SELECT * FROM email_outbox WHERE user_id=? AND kind=? ORDER BY id", (U[k], a.REMINDER_KIND)).fetchall()

    t_ = queue(16, "H1")
    s.check("16 Nov, not one of H1's days: nothing queued (their only item is the Grade H one)", t_["queued"] == 0 and t_["nothing"] == 1 and not outbox("H1"), t_)
    t_ = queue(14, "H1")
    rows_ = outbox("H1")
    s.check("14 Nov, the day their stage opened for them: queued, with the Grade H item", t_["queued"] == 1 and rows_ and "Review your Grade H people" in rows_[0]["body"], t_)
    clock(16)
    try:
        got = run(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (rows_[0]["id"],)).fetchone()))
    finally:
        clock_back()
    st = db.execute("SELECT status, error FROM email_outbox WHERE id=?", (rows_[0]["id"],)).fetchone()
    s.check("its wave comes on a day that is not theirs (the clock at 16 Nov): the recheck drops it, 'nothing pending'",
            got is None and st["status"] == "cancelled" and st["error"] == a.REMINDER_NOTHING_LEFT, dict(st))
    db.execute("DELETE FROM email_outbox")
    db.commit()
    t_ = queue(14, "H1")
    rows_ = outbox("H1")
    clock(14, 10, 15)
    try:
        got = run(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (rows_[0]["id"],)).fetchone()))
    finally:
        clock_back()
    s.check("a wave on the same day (14 Nov 10:15) keeps it", got is not None and "Review your Grade H people" in got["body"])
    db.execute("DELETE FROM email_outbox")
    db.commit()
    # one more item in the same person's email: only the Grade H one is dropped on a day that is not theirs
    own = {"group": "own", "role": "own", "text": "ZZLR own thing", "detail": "", "closes": "", "closes_on": None, "url": "/", "people": []}
    real_items = a.reminder_items
    a.reminder_items = lambda d, u: real_items(d, u) + ([own] if u["id"] == U["H1"] else [])
    try:
        clock(16)
        got16 = run(lambda d: [i["text"] for i in a.reminder_items_email(d, urow("H1"))])
        clock(14)
        got14 = run(lambda d: [i["text"] for i in a.reminder_items_email(d, urow("H1"))])
        clock(16)
        got_bar = run(lambda d: [i["text"] for i in a.reminder_items(d, urow("H1"))])
    finally:
        a.reminder_items = real_items
        clock_back()
    s.check("a person with another item keeps it on a day that is not their Grade H day; the Grade H item is left out (16 Nov)", got16 == ["ZZLR own thing"], got16)
    s.check("...and on their day (14 Nov) both are in the email", len(got14) == 2 and "ZZLR own thing" in got14, got14)
    s.check("...while the bar's reader still lists both on 16 Nov", len(got_bar) == 2, got_bar)
    reset_world()

    # ============================================================================================ the Schedule
    s.section("Email > Schedule: the leader days, and one plain line")
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    for c_, o_, c2 in (("gradeh_lm", 6, 18), ("gradeh_hod_pot", 12, 21), ("gradeh_hod_perf", 12, 21), ("gradeh_buceo", 19, 23)):
        win(c_, o_, c2)
    db.commit()
    plan = run(lambda d: a.email_plan(d, a.active_cycle(d), R1, today=D(6), horizon=40))
    days_ = {r["frm"].day for r in plan}
    s.check("with only the leader cells dated and a daily global rule, the plan lists only their days: 6 12 15 18 19 20 21 22 23",
            days_ == {6, 12, 15, 18, 19, 20, 21, 22, 23} and all(r["kind"] != "every" for r in plan), sorted(days_))
    by = {r["frm"].day: r for r in plan}
    s.check("the HOD fallback day (19 Nov) says it: the reviews open for HODs still waiting", "HOD reviews open for HODs still waiting" in by[19]["words"], by[19]["words"])
    s.check("the BU CEO fallback day (22 Nov) is a row of its own, in words and who", "sign-off opens for BU CEOs" in by[22]["words"]
            and "BU CEOs still waiting" in by[22]["who"] and by[22]["kind"] == "open", by[22])
    s.check("a last-call day names the appraisers (15 Nov: Grade H appraisals close in 3 days)", "close in 3 days" in by[15]["words"], by[15]["words"])
    SUC = H.client_as(a, SU["id"])
    line = ("Grade H appraisers get theirs inside Everyone's reminder. Grade H HODs and BU CEOs get Grade H progress instead: the day it opens "
            "for them, 3 days before it closes and on its last day.")
    t_ = text(SUC.get("/admin/email"))
    s.check("the Schedule page carries the one line when Grade H runs", line in t_, None)
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 0)", (CID,))
    db.commit()
    s.check("...and not when Grade H is unticked", line not in text(SUC.get("/admin/email")))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
    db.commit()
    os.environ["ONEHR_GRADEH"] = "0"
    s.check("...nor with the server switch off, and no leader item then either",
            line not in text(SUC.get("/admin/email")) and not any(i["group"] == "gradeh" for i in run(lambda d: a.reminder_items(d, urow("M1")))))
    os.environ["ONEHR_GRADEH"] = "1"
finally:
    restore()

sys.exit(s.done())
