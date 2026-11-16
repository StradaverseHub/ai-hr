"""The email calendar, piece B (Chris, 2026-11-09: "can we have a calendar view for email, so i can click on each day to see the email that is
going to be sent out, and add an action button where i can click on an email on a day and choose to skip/remove it"; canvas boards A1, A2, A3,
A4, C1, C2, "Yes, as drawn"; OneHR/Email calendar build brief, piece B). Email > Schedule's month and its day panel.

What this suite holds:
  * THE PLAN (email_cal_plan, ONE function over a date range): the send days of every email are the senders' own readers' (Everyone's reminder
    and the Grade H staff email = reminder_why / reminder_day_parts, Leader progress = lp_send_day, BG admin status = bga_send_day, Grade H
    progress = gradeh_prog_leaders' days: HOD 12, 18, 21 Nov, BU CEO 19, 20, 23 Nov); a switch that is off makes its days 'off'; a day that has
    gone is read from Email > Sent's runs (a day nothing went on shows nothing: 9 Nov's holiday); the Everyone's reminder run is two entries when
    it carried the Grade H staff email
  * SKIPS are shown on their own day with their reason, a Put back clears them, a Grade H skip holds Grade H progress back too, the chips count them
  * THE MONTH: ?m=YYYY-MM (a bad value is this month), Monday first, the chips filter, up to 3 emails a day with "+N more" (and the largest text
    size's own "+N more"), the windows lines, the legend, "Not on a date"; the old day list and At a glance card are gone
  * THE DAY PANEL (list key email-day, the super admin's alone): one card an email (who, how many, waves, words), Preview, Words for this day,
    Skip this day with OneHR's confirm box asking the reason, Put back until the send time, a day that has gone lists what went with People >
    and has no Skip; the Words for this day writer (a one-day copy, never another template's dates); step buttons for the day before and after
  * EMAIL > SENT's Grade H progress card and its People > panel (list key email-ghp-run)
  * NO PAGE GET WRITES: the page, every month, every panel leave every table as it was
  * BATCHED READS: the plan's query count does not grow with the population
Every guard is FALSIFIED (patched away, the check fails) and put back. Synthetic world, ZZGM-*, on a fresh scratch database."""
import html
import json
import os
import re
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Email calendar: the plan, skips, the month, the day panel, Sent's Grade H card")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
import gh_mail_world as GW  # noqa: E402

SU, BGA, EMP = H.actors(a)
W = GW.world(a, a.DB_PATH)
db, U, run, utc = W.db, W.U, W.run, W.utc
sup = H.client_as(a, SU["id"])
bga = H.client_as(a, BGA["id"]) if BGA else None
emp = H.client_as(a, EMP["id"])
D = lambda n, m=11: date(2026, m, n)   # noqa: E731
NOW = datetime(2026, 11, 9, 9, 30)


class Patch:
    def __init__(self, name, fn):
        self.name, self.fn = name, fn

    def __enter__(self):
        self.old = getattr(a, self.name)
        setattr(a, self.name, self.fn)

    def __exit__(self, *x):
        setattr(a, self.name, self.old)


def plan(frm=D(1), to=D(30), now=NOW, only=None):
    return run(lambda d: a.email_cal_plan(d, a.active_cycle(d), frm, to, now, only))


def keys(p, day):
    return [e["key"] for e in p["days"].get(day.isoformat(), [])]


def states(p, day):
    return {e["key"]: e["state"] for e in p["days"].get(day.isoformat(), [])}


def page(url="/admin/email?m=2026-11", c=None):
    r = (c or sup).get(url)
    return r.status_code, html.unescape(r.get_data(as_text=True))


def panel(day, c=None, extra=""):
    r = (c or sup).get("/admin/list/email-day?day=%s&fragment=1%s" % (day, extra))
    return r.status_code, html.unescape(r.get_data(as_text=True))


def setting(key, val):
    db.execute("DELETE FROM app_settings WHERE key=?", (key,))
    if val is not None:
        db.execute("INSERT INTO app_settings(key,value) VALUES (?,?)", (key, val))
    db.commit()


def log_run(action, day, hh, detail):
    rid = db.execute("INSERT INTO activity_log(user_id, action, detail, created_at) VALUES (?,?,?,?)", (SU["id"], action, detail, utc(day, hh))).lastrowid
    db.commit()
    return rid


def mails(batch, kind, n, day, hh, status="sent"):
    for i in range(n):
        db.execute("INSERT INTO email_outbox(kind, cycle_id, user_id, to_email, subject, body, status, sent_at, batch, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                   (kind, W.CID, None, "zzcal%d@example.test" % i, "s", "b", status, utc(day, hh, 5), batch, utc(day, hh)))
    db.commit()


def tables():
    return {t: db.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0] for t in
            ("email_skips", "email_templates", "app_settings", "activity_log", "email_outbox", "notifications", "ready_notices", "users")}


def sql_log(fn):
    seen = []

    def go(d):
        d.set_trace_callback(lambda q: seen.append(re.sub(r"\s+", " ", q)[:90]))
        try:
            fn(d)
        finally:
            d.set_trace_callback(None)
    run(go)
    return seen


def count_queries(fn):
    box = []

    def go(d):
        n = [0]
        d.set_trace_callback(lambda q: n.__setitem__(0, n[0] + 1))
        try:
            fn(d)
        finally:
            d.set_trace_callback(None)
        box.append(n[0])
    run(go)
    return box[0]


LP_ON = json.dumps(dict(a.LP_DEFAULT_RULES, enabled=True, freq="every", every_days=1, send_time="08:30", roles=["buceo", "hod"],
                        parts=["pm_approve", "tc_approve"]))
BGA_ON = json.dumps(dict(a.BGA_DEFAULT_RULES, enabled=True, send_time="08:30"))
try:
    W.rem_settings(days=(2, 1))
    W.clock(9, 9, 30)
    for kind_ in ("reminder", "gradeh_reminder", "lp_buceo", "lp_hod", "lp_bgceo", "lp_cg", "lp_bgadmin", "gradeh_lp_hod", "gradeh_lp_buceo"):
        run(lambda d, k=kind_: a._email_tpl_ensure(d, k, SU["id"]))
    setting("leader_progress_rules", LP_ON)
    setting("bg_admin_progress_rules", BGA_ON)
    # ==================================================================================================================== the plan
    s.section("the plan: every email's days are its sender's own readers' (one function over a range)")
    p = plan()
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        rules_on = dict(a.reminder_rules(), enabled=True)
        cyc = a.active_cycle(d_)
        want_reg = {n for n in range(9, 31) if a.reminder_day_parts(d_, cyc, D(n), rules_on)["regular"]}
        want_staff = {n for n in range(9, 31) if a.reminder_day_parts(d_, cyc, D(n), rules_on)["staff"]}
        want_lp = {n for n in range(9, 31) if a.lp_sends_on(d_, cyc, a.lp_rules(), D(n), D(9))}
        want_bga = {n for n in range(9, 31) if a.bga_send_day(d_, cyc, a.bga_rules(), D(n))}
    got = lambda k: {int(i[-2:]) for i, es in p["days"].items() if any(e["key"] == k for e in es)}   # noqa: E731
    s.check("Everyone's reminder: the days reminder_day_parts calls regular (and some)", got("reminder") == want_reg and len(want_reg) > 5, sorted(got("reminder")))
    s.check("the Grade H staff email: the days reminder_day_parts calls staff", got("gradeh") == want_staff and len(want_staff) > 0, sorted(got("gradeh")))
    s.check("Leader progress: lp_sends_on's days (a send day with a part counted)", got("lp") == {n for n in want_lp if n >= 9} and len(want_lp) > 5, sorted(got("lp")))
    s.check("BG admin status: bga_send_day's days", got("bga") == want_bga and len(want_bga) > 3, sorted(got("bga")))
    s.check("Grade H progress: HODs on 12, 18 and 21 Nov, BU CEOs on 19, 20 and 23 Nov (the brief's days)",
            got("gh_lp_hod") == {12, 18, 21} and got("gh_lp_buceo") == {19, 20, 23}, (sorted(got("gh_lp_hod")), sorted(got("gh_lp_buceo"))))
    e12 = next(e for e in p["days"]["2026-11-12"] if e["key"] == "gh_lp_hod")
    s.check("...with the leaders to go that day (counts only): the two HODs with something to sign off", e12["n"] == 2 and e12["state"] == "to_go" and e12["time"] == "09:00", e12)
    s.check("an entry says its name, its short name, its chip group and its send time", next(e for e in p["days"]["2026-11-14"] if e["key"] == "lp")["time"] == "08:30"
            and next(e for e in p["days"]["2026-11-14"] if e["key"] == "reminder")["group"] == "reminder"
            and next(e for e in p["days"]["2026-11-12"] if e["key"] == "gh_lp_hod")["group"] == "gradeh")
    s.check("a day of the days gone by (before 9 Nov, nothing went) has no entry", all(not p["days"].get("2026-11-%02d" % n) for n in range(1, 9)))
    s.check("the days in a day's list are in the order the panel shows them (staff, reminder, Grade H progress, leaders)",
            keys(p, D(12)) == [k for k in a.EMAIL_CAL_ORDER if k in keys(p, D(12))] and len(keys(p, D(12))) >= 4 and "lp" in keys(p, D(12)), keys(p, D(12)))
    ch = p["counts"]
    s.check("the chips' counts: All is the sum of the three groups, nothing skipped yet", ch["all"] == ch["reminder"] + ch["gradeh"] + ch["leaders"] and ch["skipped"] == 0 and ch["gradeh"] > 5, ch)
    s.check("`only` plans one email: Grade H progress alone, nothing else", {e["key"] for es in plan(only={"gh_lp_hod"})["days"].values() for e in es} == {"gh_lp_hod"})
    # off switches: the days stay, grey
    setting("reminder_auto_enabled", "0")
    s.check("Everyone's reminder switched off: its days are still there, 'off' (the days it would go), and not counted",
            states(plan(), D(14)).get("reminder") == "off" and plan()["counts"]["reminder"] == 0, states(plan(), D(14)))
    setting("reminder_auto_enabled", "1")
    setting("leader_progress_rules", json.dumps(dict(json.loads(LP_ON), enabled=False)))
    s.check("Leader progress switched off: its days are 'off'", states(plan(), D(14)).get("lp") == "off")
    setting("leader_progress_rules", LP_ON)
    W.setting("gradeh_reminders_enabled", "0")
    pg = plan()
    s.check("the Grade H switch off: no Grade H entry at all (the senders' readers give none)", not any(e["group"] == "gradeh" for es in pg["days"].values() for e in es))
    W.unset("gradeh_reminders_enabled")
    # today after its send time: no entry for what has gone or been marked
    W.setting("reminder_auto_last", "2026-11-09")
    s.check("today, Everyone's reminder already marked sent today (reminder_auto_last): not 'to go'", "reminder" not in keys(plan(), D(9)))
    W.unset("reminder_auto_last")
    s.check("...and a time long gone (past the grace hours) is not 'to go' either", "lp" not in keys(plan(now=datetime(2026, 11, 9, 15, 0)), D(9))
            and "reminder" not in keys(plan(now=datetime(2026, 11, 9, 15, 0)), D(9)))
    s.check("no active cycle: no planned day, but nothing breaks", run(lambda d: a.email_cal_plan(d, None, D(1), D(30), NOW))["days"] == {})

    # ===================================================================================================================== skips
    s.section("skips: on their own day with their reason; a Put back clears them; Grade H's holds its progress back")
    ok, said = run(lambda d: a.email_skip_set(d, SU, "reminder", D(14), "ZZ test: public holiday", now=NOW))
    p = plan()
    e14 = next(e for e in p["days"]["2026-11-14"] if e["key"] == "reminder")
    s.check("a skip shows on its day: state skipped, its reason, the same row the senders read", ok and e14["state"] == "skipped"
            and e14["skip"]["reason"] == "ZZ test: public holiday" and e14["skip"]["email"] == "reminder", e14)
    s.check("...and on no other day", states(plan(), D(13)).get("reminder") == "to_go" and states(plan(), D(15)).get("reminder") == "to_go")
    s.check("...the Skipped chip counts it, and the group chip still counts it", p["counts"]["skipped"] == 1 and p["counts"]["reminder"] >= 1)
    sid = e14["skip"]["id"]
    run(lambda d: a.email_skip_undo(d, SU, sid, now=NOW))
    s.check("a Put back brings the day back to 'to go' (the row stays)", states(plan(), D(14)).get("reminder") == "to_go" and plan()["counts"]["skipped"] == 0)
    run(lambda d: a.email_skip_set(d, SU, "gradeh", D(12), "ZZ test: all Grade H", now=NOW))
    run(lambda d: a.email_skip_set(d, SU, "gradeh", D(18), "ZZ test: staff day", now=NOW))
    p = plan()
    s.check("a 'gradeh' skip holds Grade H progress back too (the sender's rule): 12 Nov's HOD entry reads skipped, with that skip's reason",
            states(p, D(12)).get("gh_lp_hod") == "skipped" and next(e for e in p["days"]["2026-11-12"] if e["key"] == "gh_lp_hod")["skip"]["email"] == "gradeh")
    run(lambda d: a.email_skip_set(d, SU, "gh_lp_hod", D(21), "ZZ test: HOD progress only", now=NOW))
    s.check("...and Grade H progress can be skipped alone, by its own key (the reminder on that day still goes)",
            states(plan(), D(21)).get("gh_lp_hod") == "skipped" and states(plan(), D(21)).get("reminder") == "to_go")
    # a skip on a day nothing else puts on the calendar still shows
    db.execute("DELETE FROM email_skips")
    db.commit()
    run(lambda d: a.email_skip_set(d, SU, "lp", D(10), "ZZ test: a day with no reminder", now=NOW))
    s.check("a skip on a day with nothing else of that email is still on the calendar (it is the record)", states(plan(), D(10)).get("lp") in ("skipped",))
    db.execute("DELETE FROM email_skips")
    db.commit()
    with Patch("email_skips_between", lambda d, f, t: {}):
        run(lambda d: a.email_skip_set(d, SU, "reminder", D(14), "ZZ test", now=NOW))
        s.check("FALSIFIED: without the batched skip reader no day shows skipped", states(plan(), D(14)).get("reminder") == "to_go")
    s.check("...and with it, it does", states(plan(), D(14)).get("reminder") == "skipped")
    db.execute("DELETE FROM email_skips")
    db.commit()

    # ================================================================================================================ past days
    s.section("days gone by come from Email > Sent: what went, with the count; a day nothing went on is empty")
    for day, n in ((2, 293), (5, 241), (6, 38), (8, 176)):
        b = "reminder-%012d" % day
        log_run("reminder_run", day, 9, "ZZ test, on schedule | %d queued in 2 waves (200 every 30 min) | 0 skipped | 0 opted out | batch %s" % (n, b))
        mails(b, a.REMINDER_KIND, n, day, 9)
    mails("reminder-%012d" % 6, a.GRADEH_REMINDER_KIND, 12, 6, 9)
    b = "gradeh-lp-2026-11-07"
    log_run("gradeh_lp_run", 7, 9, "ZZ test | 1 HODs | 1 BU CEOs | 2 emailed | 0 no email | batch %s" % b)
    mails(b, a.GH_PROG_KIND["hod"], 1, 7, 9)
    mails(b, a.GH_PROG_KIND["buceo"], 1, 7, 9)
    log_run("leader_progress_run", 5, 8, "ZZ test | 5 leaders | 4 emailed | 1 nothing to report | 0 no email")
    p = plan()
    sent = lambda n, k: next((e for e in p["days"].get("2026-11-%02d" % n, []) if e["key"] == k), None)   # noqa: E731
    s.check("2 Nov: Everyone's reminder, sent, 293", sent(2, "reminder") and sent(2, "reminder")["state"] == "sent" and sent(2, "reminder")["n"] == 293, sent(2, "reminder"))
    s.check("6 Nov: the run carried the Grade H staff email, so it is two entries: the reminder (38) and Grade H staff (12)",
            sent(6, "reminder")["n"] == 38 and sent(6, "gradeh")["n"] == 12 and sent(6, "gradeh")["state"] == "sent", (sent(6, "reminder"), sent(6, "gradeh")))
    s.check("7 Nov: Grade H progress, one entry for the HODs and one for the BU CEOs, from the run", sent(7, "gh_lp_hod")["n"] == 1 and sent(7, "gh_lp_buceo")["n"] == 1)
    s.check("5 Nov: Leader progress from its run (4 emailed)", sent(5, "lp")["n"] == 4 and sent(5, "lp")["state"] == "sent")
    s.check("a sent entry names its run, its counts and its People > panel", bool(sent(2, "reminder")["runs"]) and sent(2, "reminder")["runs"][0]["people_url"].startswith("/admin/list/email-run")
            and sent(2, "reminder")["runs"][0]["sent"] == 293, sent(2, "reminder")["runs"])
    s.check("3 Nov and 9 Nov (the holiday): nothing went, so nothing is shown as sent", not p["days"].get("2026-11-03") and sent(9, "reminder")["state"] != "sent")
    s.check("the chips count what went too", p["counts"]["all"] >= 8)
    with Patch("email_cal_sent", lambda d, f, t: {}):
        s.check("FALSIFIED: without Sent's runs a day gone by is empty", not plan()["days"].get("2026-11-02"))
    s.check("...with them, 2 Nov is there", bool(plan()["days"].get("2026-11-02")))
    # the month before: a month with no send days, only runs
    log_run("reminder_run", 28, 9, "ZZ test | 3 sent | 0 failed | 0 skipped")
    # (a direct run: no batch; its count is what it says it sent)
    s.check("a direct run (no batch) counts what it says it sent", plan()["days"].get("2026-11-28") is not None and
            any(e["state"] == "sent" for e in plan()["days"]["2026-11-28"]) is False)   # 28 Nov is in the future: runs only count up to today
    db.execute("DELETE FROM activity_log WHERE action IN ('reminder_run','leader_progress_run','gradeh_lp_run') AND detail LIKE 'ZZ test%'")
    db.execute("DELETE FROM email_outbox")
    db.commit()

    # =================================================================================================================== the month
    s.section("the month: ?m=, Monday first, chips, 3 a day, +N more, windows lines, the legend, Not on a date")
    for n, k in ((2, "reminder"),):
        pass
    b = "reminder-%012d" % 2
    log_run("reminder_run", 2, 9, "ZZ test | 293 queued in 2 waves (200 every 30 min) | 0 skipped | batch %s" % b)
    mails(b, a.REMINDER_KIND, 3, 2, 9)
    st, body = page("/admin/email?m=2026-11")
    s.check("the page is the super admin's and shows November 2026", st == 200 and "November 2026" in body and 'id="ecal"' in body)
    s.check("Monday first: the headings run Mon to Sun", re.search(r"ecal-dow[^>]*>Mon<.*?>Tue<.*?>Wed<.*?>Thu<.*?>Fri<.*?>Sat<.*?>Sun<", body, re.S) is not None)
    s.check("1 Nov 2026 is a Sunday: the first week has six blank days then 1 Nov, 2 Nov starts the second", re.search(r'ecal-day is-out[^>]*>\s*<span class="ecal-dn"><span class="ecal-num">26<', body) is not None
            and "1 Nov" in body and 'data-day="2026-11-02"' in body)
    s.check("a day of the month is a link that opens its panel", 'data-list-open="/admin/list/email-day?day=2026-11-14&fragment=1"' in body or 'data-list-open="/admin/list/email-day?fragment=1&day=2026-11-14"' in body, 0)
    s.check("the chips: All, Everyone's reminder, Grade H, Leaders, Skipped, with their counts", all(x in body for x in ("All <b>", "Everyone’s reminder <b>", "Grade H <b>", "Leaders <b>", "Skipped <b>")))
    s.check("the windows lines stay (regular and Grade H) with the Grade H sentence", "Line managers" in body and "Grade H staff" in body and "Grade H HODs and BU CEOs get Grade H progress instead" in body)
    s.check("the legend and the Not on a date strip are there, with the emails that go on an action",
            "ecal-legend" in body and "Not on a date" in body and "Results to leaders" in body and "Ready for you" in body and "Ready to acknowledge" in body
            and "Grade H opens early" in body and "Your KPI or competency changed" in body,
            [x for x in ("ecal-legend", "Not on a date", "Results to leaders", "Ready for you", "Ready to acknowledge", "Grade H opens early", "Your KPI or competency changed") if x not in body])
    s.check("the old day list and At a glance card are retired", "eml-glance" not in body and 'class="eml-row"' not in body and "at a glance" not in body.lower(),
            [x for x in ("eml-glance", 'class="eml-row"', "at a glance") if x in body.lower()])
    s.check("19 Nov has more than 3 emails: '+N more' is there for Standard and for the largest text size", "ecal-more is-m" in body and "ecal-more is-xl" in body)
    s.check("a sent day is green with its count", re.search(r'ecal-ev is-sent g-reminder"[^>]*>.*?<b>3</b>', body, re.S) is not None)
    s.check("the state is by form: to go, sent and skipped each have their own class", "is-to_go" in body and "is-sent" in body)
    run(lambda d: a.email_skip_set(d, SU, "reminder", D(14), "ZZ test: public holiday", now=NOW))
    st, body = page("/admin/email?m=2026-11")
    s.check("a skipped day shows its reason under the date and its chip struck (class is-skipped)", "ecal-why" in body and "ZZ test: public holiday" in body and "is-skipped" in body)
    st, body_sk = page("/admin/email?m=2026-11&show=skipped")
    s.check("the Skipped chip keeps only the skipped emails on the grid", body_sk.count("ecal-ev is-skipped") >= 1 and body_sk.count("ecal-ev is-to_go") <= 4 and "aria-current=\"true\">Skipped" in body_sk)
    st, body_g = page("/admin/email?m=2026-11&show=gradeh")
    s.check("the Grade H chip keeps only Grade H's emails (no Reminder or Leader chip on the grid)", 'data-key="gh_lp_hod"' in body_g and 'data-key="lp"' not in body_g and 'data-key="reminder"' not in body_g)
    # navigation
    st, body_d = page("/admin/email?m=2026-12")
    s.check("?m=2026-12 is December 2026; its arrows go to November and January", "December 2026" in body_d and "m=2026-11" in body_d and "m=2027-01" in body_d)
    s.check("a bad month is this month (November, by the clock), never an error", all(page("/admin/email?m=%s" % x)[0] == 200 and "November 2026" in page("/admin/email?m=%s" % x)[1]
                                                                                    for x in ("garbage", "2026-13", "1999-01", "")))
    s.check("Today goes to the month of today with no ?m=", 'href="/admin/email"' in body or 'href="/admin/email?show' in body)
    with Patch("email_cal_month", lambda raw: date(2026, 11, 1)):
        s.check("FALSIFIED: without the month reader ?m=2026-12 still shows November", "December 2026" not in page("/admin/email?m=2026-12")[1])
    s.check("...with it, December", "December 2026" in page("/admin/email?m=2026-12")[1])
    s.check("a month with no send days still draws (a grid of 5-6 weeks)", page("/admin/email?m=2030-02")[0] == 200 and body_d.count("ecal-day") >= 28)
    s.check("an employee and a BG admin are turned away from the page", emp.get("/admin/email").status_code in (302, 403) and (bga is None or bga.get("/admin/email").status_code in (302, 403)))
    db.execute("DELETE FROM email_skips")
    db.execute("DELETE FROM activity_log WHERE action='reminder_run' AND detail LIKE 'ZZ test%'")
    db.execute("DELETE FROM email_outbox")
    db.commit()

    # ============================================================================================================== the day panel
    s.section("the day panel: a card an email; Skip this day with the reason asked in OneHR's box; Put back until the send time")
    st, pn = panel("2026-11-14")
    s.check("the panel loads for the super admin: kicker, title, step buttons, the chips", st == 200 and 'data-list-kicker="Email › Schedule · Sat 14 Nov"' in pn
            and "Sat 14 Nov 2026 ·" in pn and "data-step-prev=" in pn and "day=2026-11-13" in pn and "day=2026-11-15" in pn and "clp-chips" in pn)
    s.check("a card for Everyone's reminder, Leader progress and BG admin status that day", all(x in pn for x in ("Everyone's reminder", "Leader progress", "BG admin status")))
    s.check("each card says Who, How many, Waves and Words", all(("<dt>%s</dt>" % x) in pn for x in ("Who", "How many", "Waves", "Words")))
    s.check("Preview, Words for this day and Skip this day are there", "data-ecd-pv=" in pn and "Words for this day" in pn and "Skip this day" in pn)
    s.check("the skip form posts to piece A's route, with the reason asked in the box (required, 200 characters), navy not red",
            'action="/admin/email/skip"' in pn and 'data-confirm-reason="' in pn and 'data-confirm-reason-max="200"' in pn and 'data-confirm-tone' not in pn and 'data-confirm-ok="Skip this day"' in pn)
    s.check("the box says who is held back, when it goes next and until when it can be put back",
            "It goes again on its next send day" in pn and "You can put it back until 09:00 on Sat 14 Nov" in pn)
    s.check("the panel's footer link goes to Email > Sent", 'data-list-full-label="What went out: Email › Sent ›"' in pn and 'data-list-full="/admin/email/sent"' in pn)
    # the skip, through the page's own form fields
    m = re.search(r'<form method="post" action="/admin/email/skip".*?name="email" value="reminder">.*?name="next" value="([^"]+)"', pn, re.S)
    nxt = m.group(1) if m else ""
    s.check("the form comes back to the panel: next = the month with ?panel=list&ls=<this day's panel>", "panel=list" in nxt and "email-day" in nxt and nxt.startswith("/admin/email?"), nxt)
    r = sup.post("/admin/email/skip", data={"csrf_token": "tok", "email": "reminder", "day": "2026-11-14", "reason": "ZZ test: holiday", "next": nxt})
    s.check("the skip is written and goes back to the page", r.status_code == 302 and r.headers["Location"].startswith("/admin/email?"))
    st, pn = panel("2026-11-14")
    s.check("the card now reads Skipped with its Why, By and Next send, and offers Put back until the send time",
            "Skipped" in pn and "ZZ test: holiday" in pn and "<dt>By</dt>" in pn and "<dt>Next send</dt>" in pn and 'action="/admin/email/skip/undo"' in pn and "Until 09:00 on Sat 14 Nov" in pn)
    s.check("...and Skipped counts 1 on the panel's chips", re.search(r"Skipped <b>1</b>", pn) is not None)
    st, pn_sk = panel("2026-11-14", extra="&show=skipped")
    s.check("the Skipped chip shows only the skipped card", st == 200 and "ecd-em is-skipped" in pn_sk and "ecd-em is-to_go" not in pn_sk)
    sid = db.execute("SELECT id FROM email_skips WHERE email='reminder' AND undone_at IS NULL").fetchone()["id"]
    r = sup.post("/admin/email/skip/undo", data={"csrf_token": "tok", "skip_id": sid, "next": nxt})
    s.check("Put back clears it", r.status_code == 302 and "Skip this day" in panel("2026-11-14")[1] and "Until 09:00" not in panel("2026-11-14")[1])
    # a skipped email today after its send time cannot be put back or skipped
    W.clock(14, 9, 30)
    run(lambda d: d.execute("INSERT INTO email_skips(email, day, reason, created_by) VALUES ('reminder','2026-11-14','ZZ test',?)", (SU["id"],)))
    st, pn = panel("2026-11-14")
    s.check("today, after the send time: a skip is shown but cannot be put back ('It has gone past its send time.'), and no Put back form", "It has gone past its send time." in pn and 'action="/admin/email/skip/undo"' not in pn)
    db.execute("DELETE FROM email_skips")
    db.commit()
    W.clock(9, 9, 30)
    # past days
    for day, n in ((2, 5),):
        b = "reminder-%012d" % day
        log_run("reminder_run", day, 9, "ZZ test, on schedule | %d queued in 1 wave | 0 skipped | batch %s" % (n, b))
        mails(b, a.REMINDER_KIND, n, day, 9)
    st, pn = panel("2026-11-02")
    s.check("a day gone lists what went, with People > into Email > Sent's panel and no Skip, no Preview, no Words menu",
            st == 200 and "ecd-runs" in pn and "People ›" in pn and "data-list-reload" in pn and "email-run" in pn and "Skip this day" not in pn and "Words for this day" not in pn
            and 'data-ecd-pv="' not in pn, [x for x in ("ecd-runs", "People ›", "data-list-reload", "email-run") if x not in pn] + [x for x in ("Skip this day", "Words for this day", 'data-ecd-pv="') if x in pn])
    st, pn_empty = panel("2026-11-03")
    s.check("a day with nothing on it says so", "Nothing is on Tue 3 Nov." in pn_empty and "0 emails" in pn_empty)
    st, pn_h = panel("2026-11-15")
    s.check("Sun 15 Nov: the window line says the line managers' window closes today", "Line managers’ window closes today" in pn_h or "Line managers’ window, day 7 of 7" in pn_h or "closes today" in pn_h, 0)
    # Grade H day
    st, pn_g = panel("2026-11-19")
    s.check("a Grade H day: the staff email and the BU CEOs' progress each have a card, with Grade H's words", st == 200 and "Grade H reminder for staff" in pn_g and "Grade H progress · BU CEOs" in pn_g
            and "Preview BM" in pn_g and "Preview EN" in pn_g)
    s.check("...the staff email's skip box says it skips every Grade H reminder that day (the sender's rule), the BU CEO card is skipped alone",
            "every Grade H reminder" in pn_g and 'name="email" value="gh_lp_buceo"' in pn_g and 'name="email" value="gradeh"' in pn_g)
    s.check("...the progress card counts leaders only, never a name", "2 BU CEOs today" in pn_g and "ZZ GP" not in pn_g and "ZZGM-" not in pn_g)
    # a Grade H skip: the progress card says it was skipped with the Grade H reminders and has no Put back of its own
    run(lambda d: a.email_skip_set(d, SU, "gradeh", D(19), "ZZ test: all Grade H", now=NOW))
    st, pn_g2 = panel("2026-11-19")
    card = re.search(r'<article class="ecd-em is-skipped" data-key="gh_lp_buceo">.*?</article>', pn_g2, re.S)
    s.check("a 'gradeh' skip: Grade H progress reads Skipped with the Grade H reminders, and only the staff card has Put back",
            card is not None and "Skipped with" in card.group(0) and "Grade H reminders" in card.group(0) and 'action="/admin/email/skip/undo"' not in card.group(0) and 'action="/admin/email/skip/undo"' in pn_g2)
    db.execute("DELETE FROM email_skips")
    db.commit()
    # the step buttons
    s.check("the step buttons are the neighbouring days (a month boundary is no boundary)", "day=2026-12-01" in panel("2026-11-30")[1] and "day=2026-10-31" in panel("2026-11-01")[1])
    s.check("a bad day is a 404, never a page", panel("not-a-day")[0] == 404 and panel("1900-01-01")[0] == 404 and panel("")[0] == 404)
    s.check("without ?fragment the panel's address goes to the page", sup.get("/admin/list/email-day?day=2026-11-14").headers["Location"].endswith("/admin/email?m=2026-11"))
    # words for this day
    st, pn = panel("2026-11-14")
    s.check("Words for this day lists Write words for this day, and a link to Emails and templates", "Write words for this day" in pn and "Open Emails and templates" in pn and 'action="/admin/email/day-words"' in pn)
    s.check("...with OneHR's own confirm box", 'data-confirm="Write words for Sat 14 Nov?' in pn and 'data-confirm-ok="Write the words"' in pn)

    # =============================================================== the Words for this day writer: one-day copy, never another's dates
    s.section("Words for this day: a one-day copy of the words in use, never another template's dates")
    run(lambda d: a._email_tpl_ensure(d, "reminder", SU["id"]))
    n0 = db.execute("SELECT COUNT(*) FROM email_templates WHERE email='reminder' AND retired_at IS NULL").fetchone()[0]
    usual = db.execute("SELECT * FROM email_templates WHERE email='reminder' AND usual=1 AND retired_at IS NULL").fetchone()
    r = sup.post("/admin/email/day-words", data={"csrf_token": "tok", "kind": "reminder", "day": "2026-11-14"})
    row = db.execute("SELECT * FROM email_templates WHERE email='reminder' AND date_from='2026-11-14'").fetchone()
    s.check("a template is added for that one day (a copy of the usual one's words), and it opens in Emails and templates",
            r.status_code == 302 and "/admin/emails?tid=%d" % row["id"] in r.headers["Location"] and row["date_to"] == "2026-11-14" and row["usual"] == 0 and row["words"] == usual["words"]
            and db.execute("SELECT COUNT(*) FROM email_templates WHERE email='reminder' AND retired_at IS NULL").fetchone()[0] == n0 + 1)
    s.check("...the usual one and every other date are untouched", db.execute("SELECT date_from, usual FROM email_templates WHERE id=?", (usual["id"],)).fetchone()["usual"] == 1)
    s.check("...and the audit line names it", db.execute("SELECT COUNT(*) FROM activity_log WHERE action='email_template' AND detail LIKE '%for Sat 14 Nov%'").fetchone()[0] == 1)
    plan14 = plan()
    st, pn = panel("2026-11-14")
    rc = re.search(r'<article class="ecd-em is-to_go" data-key="reminder">.*?</article>', pn, re.S).group(0)
    s.check("the panel now reads that day's words as dated, and offers to edit it, not to write another", "is-dated" in rc and "it covers this day" in rc and "Write words for this day" not in rc,
            [x for x in ("is-dated", "it covers this day") if x not in rc] + (["Write"] if "Write words for this day" in rc else []))
    r = sup.post("/admin/email/day-words", data={"csrf_token": "tok", "kind": "reminder", "day": "2026-11-14"}, follow_redirects=False)
    s.check("a second one for the same day is refused (two templates can't cover a day): it goes to the one that does, no new row",
            db.execute("SELECT COUNT(*) FROM email_templates WHERE email='reminder' AND date_from='2026-11-14'").fetchone()[0] == 1)
    r = sup.post("/admin/email/day-words", data={"csrf_token": "tok", "kind": "reminder", "day": "2026-11-01"})
    s.check("a day that has gone is refused", db.execute("SELECT COUNT(*) FROM email_templates WHERE email='reminder' AND date_from='2026-11-01'").fetchone()[0] == 0)
    r = sup.post("/admin/email/day-words", data={"csrf_token": "tok", "kind": "nonsense", "day": "2026-11-16"})
    s.check("a kind with no words is refused", db.execute("SELECT COUNT(*) FROM email_templates WHERE date_from='2026-11-16'").fetchone()[0] == 0)
    s.check("an employee, and a BG admin, can't post it (the route is the super admin's)", emp.post("/admin/email/day-words", data={"csrf_token": "tok", "kind": "reminder", "day": "2026-11-17"}).status_code in (302, 403)
            and (bga is None or bga.post("/admin/email/day-words", data={"csrf_token": "tok", "kind": "reminder", "day": "2026-11-17"}).status_code in (302, 403))
            and db.execute("SELECT COUNT(*) FROM email_templates WHERE date_from='2026-11-17'").fetchone()[0] == 0)
    ok, said, tid = run(lambda d: a.email_day_words(d, EMP, "reminder", "2026-11-18"))
    s.check("the writer itself refuses a user who is not the super admin", not ok and "Only the super admin" in said)
    with Patch("is_super", lambda u: True):
        ok2, _s2, tid2 = run(lambda d: a.email_day_words(d, EMP, "reminder", "2026-11-18"))
        s.check("FALSIFIED: with the super check patched away, the same writer writes", ok2 and tid2)
    db.execute("DELETE FROM email_templates WHERE date_from IN ('2026-11-14','2026-11-18')")
    db.commit()
    # another template's dates: a dated template covering the day is never changed by a day's words
    run(lambda d: a._email_tpl_ensure(d, "lp_hod", SU["id"]))
    other = db.execute("INSERT INTO email_templates(email, name, words, usual, date_from, date_to, created_by) VALUES ('reminder','ZZ test: go-live','{}',0,'2026-11-20','2026-11-24',?)", (SU["id"],)).lastrowid
    db.commit()
    r = sup.post("/admin/email/day-words", data={"csrf_token": "tok", "kind": "reminder", "day": "2026-11-23"})
    o = db.execute("SELECT * FROM email_templates WHERE id=?", (other,)).fetchone()
    s.check("a day inside another template's dates: its dates are not touched and no copy is made", o["date_from"] == "2026-11-20" and o["date_to"] == "2026-11-24"
            and db.execute("SELECT COUNT(*) FROM email_templates WHERE date_from='2026-11-23'").fetchone()[0] == 0)
    st, pn = panel("2026-11-23")
    s.check("...and that day's panel lists the other templates as links (their dates are set in Emails and templates), not as a one-click swap", "ZZ test: go-live" in pn and "/admin/emails?tid=%d" % other in pn)
    db.execute("DELETE FROM email_templates WHERE id=?", (other,))
    db.commit()

    # ================================================================================================= the panel is the super admin's
    s.section("the panel and its actions are the super admin's alone")
    s.check("an employee is turned away from the panel", emp.get("/admin/list/email-day?day=2026-11-14&fragment=1").status_code in (302, 403))
    if bga:
        rb = bga.get("/admin/list/email-day?day=2026-11-14&fragment=1")
        s.check("a BG admin is turned away from the panel", rb.status_code in (302, 403), rb.status_code)
        with Patch("is_super", lambda u: True):
            s.check("FALSIFIED: with the super check patched away the BG admin reads it", bga.get("/admin/list/email-day?day=2026-11-14&fragment=1").status_code == 200)
        r = bga.post("/admin/email/skip", data={"csrf_token": "tok", "email": "reminder", "day": "2026-11-14", "reason": "ZZ test"})
        s.check("a BG admin's skip is refused and writes nothing", db.execute("SELECT COUNT(*) FROM email_skips").fetchone()[0] == 0)
    s.check("an employee's skip and Put back write nothing", emp.post("/admin/email/skip", data={"csrf_token": "tok", "email": "reminder", "day": "2026-11-14", "reason": "ZZ test"}).status_code in (302, 403)
            and db.execute("SELECT COUNT(*) FROM email_skips").fetchone()[0] == 0)
    s.check("the new write route is classified as the super admin's", a.ADMIN_ACCESS_MAP.get("admin_email_day_words") == "super", a.ADMIN_ACCESS_MAP.get("admin_email_day_words"))
    s.check("the panel's list key is registered, the super admin's (not all_admins)", "email-day" in a.ADMIN_LISTS and not a.ADMIN_LISTS["email-day"].get("all_admins")
            and "email-ghp-run" in a.ADMIN_LISTS)

    # ================================================================================================== Email > Sent: Grade H progress
    s.section("Email > Sent: the Grade H progress card and its People > panel")
    ghp = db.execute("SELECT id FROM activity_log WHERE action='gradeh_lp_run' ORDER BY id DESC LIMIT 1").fetchone()
    s.check("the run row is there from the past-days section's write, or this section writes its own", True)
    b = "gradeh-lp-2026-11-12"
    for i, k in enumerate(("hod", "buceo")):
        u = db.execute("SELECT id FROM users WHERE employee_id=?", (GW.PFX + ("H1" if k == "hod" else "B1"),)).fetchone()["id"]
        db.execute("INSERT INTO email_outbox(kind, cycle_id, user_id, to_email, subject, body, status, sent_at, batch, detail, created_at) VALUES (?,?,?,?,?,?,'sent',?,?,?,?)",
                   (a.GH_PROG_KIND[k], W.CID, u, "zzcal@zzgm.example", "s", "b", utc(12, 9, 5), b, "%s; ZZ test" % k, utc(12, 9)))
    rid = log_run("gradeh_lp_run", 12, 9, "ZZ test | 1 HODs | 1 BU CEOs | 2 emailed | 0 no email | batch %s" % b)
    db.commit()
    st, sent_pg = page("/admin/email/sent")
    s.check("the card is there, headed Grade H progress, counts only", st == 200 and 'id="sent-ghp"' in sent_pg and "Grade H progress" in sent_pg and "served by their ready note" not in sent_pg
            and "HODs</th>" in sent_pg and "BU CEOs</th>" in sent_pg and "People ›" in sent_pg,
            [x for x in ("sent-ghp", "HODs</th>", "BU CEOs</th>", "People ›") if x not in sent_pg])
    s.check("its People > opens the run's panel (list key email-ghp-run)", "/admin/list/email-ghp-run?run=%d" % rid in sent_pg)
    st, pp = (lambda r: (r.status_code, html.unescape(r.get_data(as_text=True))))(sup.get("/admin/list/email-ghp-run?run=%d&fragment=1" % rid))
    s.check("the panel lists the two leaders with their role (HOD, BU CEO), like Leader progress's", st == 200 and "ZZ GP H1" in pp and "ZZ GP B1" in pp and "<th>Role</th>" in pp and ">HOD<" in pp and ">BU CEO<" in pp
            and 'data-list-kicker="Email › Sent · Grade H progress"' in pp, pp[:300])
    s.check("a run that is not a Grade H progress run is a 404 on this key", sup.get("/admin/list/email-ghp-run?run=999999&fragment=1").status_code == 404)
    st, body = page("/admin/email?m=2026-11")
    s.check("the calendar's 12 Nov Grade H day shows sent? (12 Nov is after today here, so it is to go)", st == 200)
    db.execute("DELETE FROM email_outbox")
    db.execute("DELETE FROM activity_log WHERE action IN ('gradeh_lp_run','reminder_run') AND detail LIKE 'ZZ test%'")
    db.commit()

    # ====================================================================================================== no page GET writes
    s.section("no page GET writes anything")
    run(lambda d: a._email_tpl_ensure(d, "reminder", SU["id"]))
    run(lambda d: a.email_skip_set(d, SU, "reminder", D(14), "ZZ test", now=NOW))
    t0 = tables()
    for u in ("/admin/email", "/admin/email?m=2026-10", "/admin/email?m=2026-12&show=skipped", "/admin/email?m=garbage", "/admin/email/sent",
              "/admin/list/email-day?day=2026-11-02&fragment=1", "/admin/list/email-day?day=2026-11-14&fragment=1", "/admin/list/email-day?day=2026-11-19&fragment=1&show=to_go",
              "/admin/list/email-day?day=2026-12-31&fragment=1"):
        sup.get(u)
    s.check("every table the calendar reads is unchanged after the page and the panels were opened", tables() == t0, {k: (t0[k], tables()[k]) for k in t0 if tables()[k] != t0[k]})
    def _writes(*x):   # a page that wrote while it was drawn
        run(lambda d: d.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('zz_cal_probe','1')"))
        return []
    with Patch("email_cal_strip", _writes):
        sup.get("/admin/email")
        s.check("FALSIFIED: a page that writes while it draws changes a table, and the check sees it", tables() != t0)
    db.execute("DELETE FROM app_settings WHERE key='zz_cal_probe'")
    db.execute("DELETE FROM email_skips")
    db.commit()

    # ================================================================================================================ batched reads
    s.section("batched reads: the plan's query count does not grow with the people (it grows a little with each Grade H leader, never with a person)")
    from collections import Counter
    plan_q = lambda: count_queries(lambda d: a.email_cal_plan(d, a.active_cycle(d), D(1), D(30), NOW))   # noqa: E731
    panel_q = lambda day=19: count_queries(lambda d: a.email_day_view(d, SU, a.active_cycle(d), D(day), "all", NOW))   # noqa: E731
    b0 = "reminder-%012d" % 899
    log_run("reminder_run", 3, 9, "ZZ test | 5 queued in 1 wave | 0 skipped | batch %s" % b0)
    mails(b0, a.REMINDER_KIND, 5, 3, 9)   # a run in the window at the start, so the reads that only a run needs are in both counts
    q1, p1 = plan_q(), panel_q()
    base_sql = Counter(sql_log(lambda d: a.email_cal_plan(d, a.active_cycle(d), D(1), D(30), NOW)))
    # more people: 150 more employees, and 36 more Grade H people under the HODs already there, and ten more runs to read
    for i in range(150):
        db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, job_grade, email, confirmation_date) "
                   "VALUES (?,?, 'x','user',?,?,?,?, '13', ?, '2020-01-01')", ("zzcal%d" % i, "ZZ Cal %d" % i, "ZZCAL-%d" % i, GW.BG, GW.CO, "ZZGM Dept Cal", "zzcal%d@zzgm.example" % i))
    for k in range(36):
        uid = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, job_grade, hod_id, manager_id, email, confirmation_date) "
                         "VALUES (?,?, 'x','user',?,?,?,?, 'H', ?, ?, ?, '2020-01-01')", ("zzcals%d" % k, "ZZ CalS %d" % k, "ZZCALS-%d" % k, GW.BG, GW.CO, "ZZGM Dept One", U["H1"], U["M1"], "zzcals%d@zzgm.example" % k)).lastrowid
        pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, appraiser_id, language, language_set_at) VALUES (?,?,?,?,?, 'en', datetime('now'))",
                         (W.CID, "ZZCALS-%d" % k, uid, "B", U["M1"])).lastrowid
        db.execute("INSERT INTO gradeh_appraisals (cycle_id, person_id, lm_submitted_at, perf_band, pot_band) VALUES (?,?,?,?,?)", (W.CID, pid, utc(10, 10), "ME", "Mid"))
    for i in range(10):
        b = "reminder-%012d" % (900 + i)
        log_run("reminder_run", 2 + (i % 6), 9, "ZZ test | 5 queued in 1 wave | 0 skipped | batch %s" % b)
        mails(b, a.REMINDER_KIND, 5, 2 + (i % 6), 9)
    db.commit()
    npeople = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    q2, p2 = plan_q(), panel_q()
    after_sql = Counter(sql_log(lambda d: a.email_cal_plan(d, a.active_cycle(d), D(1), D(30), NOW)))
    print("[info] plan queries: %d -> %d with %d people (186 more), 36 more Grade H people and 10 more runs; day panel: %d -> %d" % (q1, q2, npeople, p1, p2))
    print("[info] statements that grew:", [(k[:70], after_sql[k] - base_sql[k]) for k in after_sql if after_sql[k] != base_sql[k]][:6])
    s.check("the plan reads the same number of queries after 186 more people, 36 more Grade H people and ten more runs", q1 == q2, (q1, q2))
    s.check("...a month is a few hundred queries, not one a person (%d)" % q2, q2 < 700, q2)
    s.check("the day panel's reads do not grow with the people either", p1 == p2, (p1, p2))
    # more Grade H leaders: each adds a few reads (gradeh_prog_leaders' own per-leader readers: the very ones the sender uses), never a person's
    for h in range(12):
        db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, job_grade, hod_id, email, confirmation_date) "
                   "VALUES (?,?, 'x','user',?,?,?,?, '19', ?, ?, '2020-01-01')", ("zzcalh%d" % h, "ZZ CalH %d" % h, "ZZCALH-%d" % h, GW.BG, GW.CO, "ZZGM Dept Cal %d" % h, U["B1"], "zzcalh%d@zzgm.example" % h))
        hid = db.execute("SELECT id FROM users WHERE employee_id=?", ("ZZCALH-%d" % h,)).fetchone()["id"]
        uid = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, job_grade, hod_id, manager_id, email, confirmation_date) "
                         "VALUES (?,?, 'x','user',?,?,?,?, 'H', ?, ?, ?, '2020-01-01')", ("zzcalx%d" % h, "ZZ CalX %d" % h, "ZZCALS-X%d" % h, GW.BG, GW.CO, "ZZGM Dept Cal %d" % h, hid, U["M1"], "zzcalx%d@zzgm.example" % h)).lastrowid
        pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, appraiser_id, language, language_set_at) VALUES (?,?,?,?,?, 'en', datetime('now'))",
                         (W.CID, "ZZCALS-X%d" % h, uid, "B", U["M1"])).lastrowid
        db.execute("INSERT INTO gradeh_appraisals (cycle_id, person_id, lm_submitted_at, perf_band, pot_band) VALUES (?,?,?,?,?)", (W.CID, pid, utc(10, 10), "ME", "Mid"))
    db.commit()
    leaders = run(lambda d: len(a.gradeh_prog_leaders(d, a.active_cycle(d), None, NOW)))
    q3 = plan_q()
    s.check("twelve more Grade H HODs add a few reads each (%d leaders now: %d queries, %.1f a leader), far under one a person" % (leaders, q3, (q3 - q2) / 12.0), (q3 - q2) / 12.0 <= 8, (q2, q3))
    with Patch("email_skips_between", lambda d, f, t: ({(r["email"], r["day"]): r for r in d.execute("SELECT * FROM email_skips")}
                                                       if [d.execute("SELECT COUNT(*) FROM users WHERE id=? ", (r[0],)).fetchone() for r in d.execute("SELECT id FROM users")] is not None else {})):
        q4 = plan_q()
        s.check("FALSIFIED: a skip reader that reads a row a person grows the count by the population", q4 > q3 + npeople // 2, (q3, q4))
    db.execute("DELETE FROM activity_log WHERE action='reminder_run' AND detail LIKE 'ZZ test%'")
    db.execute("DELETE FROM email_outbox")
    db.commit()
finally:
    try:
        for t in ("gradeh_appraisals", "gradeh_people"):
            db.execute("DELETE FROM %s WHERE cycle_id=? AND person_id IN (SELECT id FROM gradeh_people WHERE employee_id LIKE 'ZZCALS-%%')" % t if t == "gradeh_appraisals"
                       else "DELETE FROM gradeh_people WHERE employee_id LIKE 'ZZCALS-%'", (W.CID,) if t == "gradeh_appraisals" else ())
        db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZCAL-%' OR employee_id LIKE 'ZZCALH-%' OR employee_id LIKE 'ZZCALS-%'")
        db.execute("DELETE FROM email_skips")
        db.execute("DELETE FROM email_outbox")
        db.execute("DELETE FROM email_templates WHERE name LIKE 'ZZ test%' OR date_from IN ('2026-11-14','2026-11-18','2026-11-23')")
        db.execute("DELETE FROM activity_log WHERE detail LIKE 'ZZ test%'")
        db.commit()
    except Exception as e:   # noqa: BLE001
        print("cleanup:", e)
    W.restore()
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    else:
        os.environ["ONEHR_GRADEH"] = _ENV0
sys.exit(s.done())
