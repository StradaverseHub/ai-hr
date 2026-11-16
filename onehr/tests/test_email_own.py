"""Your own emails (Chris, 2026-11-09, the email calendar piece C: "i can choose a day and add in a new email template with a setting page where
i can configure to repeat it and the frequency, and to who", "there should be an option list to pick from our templates"; canvas boards B1, B2,
B3, "Yes, as drawn"; OneHR/Email calendar build brief, piece C). The super admin writes an email herself and OneHR sends it on its days.

What this suite holds:
  * THE STORE AND ITS REFUSALS (email_own_save, the super admin's alone): the tables, a new series with its words as a usual template under its
    own key, the audit row; refused: not the super admin, a named person (any field the form was not drawn with: nothing stored), a placeholder
    OneHR can't fill, {tasks} with "All of them" or with BG admins, Until or a one-off's day past the cycle's last close (naming the date), a first
    day in the past, N out of range, a time off the quarter hour, an unknown role or business group, a repeated name
  * email_own_days (ONE function): once, every N days, weekly, capped at the cycle's last close, nothing for a removed series
  * START FROM (B2): the option list is every template in use grouped as the Emails and templates rail (Grade H's where it runs, the usual one marked,
    Upgrades left out), a copy never changes its original, Grade H's BM / EN copies the English, a leader progress template's table is not copied
  * WHO (email_own_recipients, ONE function): each role, only-waiting vs all, business groups, one email a person with two roles ticked, a shared
    mailbox keeps one email each, opt-outs (Everyone's reminder's; Leader progress's for a leader-only person), the Executive Chairman is never
    emailed by role, BG admins' addresses deduped by address, a count that is exact up to a limit and "up to" above it, no per-person read for a count
  * THE SEND (email_own_auto from the 15-minute job): nothing before its time, queued in waves with the batch key at its time, never twice (the UNIQUE
    send record: two ticks, and a record that is the only thing holding it), a late tick inside the grace hours sends that day's once and never
    yesterday's, a live skip holds it back and writes no record, Put back lets it go, a server with no email set up records the day and queues nothing
  * THE RECHECK before each queued email goes: finished, opted out, removed, skipped since, no longer in the role: dropped; still waiting: rewritten
  * THE CALENDAR: the plan shows the series on the right days (outlined, ↻), a skip struck, a sent day with its count, the Your own chip; the day panel
    card (tag, Sends line, Preview, Edit the series, Skip, Remove the series, + Add an email on <day> only from today)
  * EDIT AND REMOVE: an edit changes the sends still to come (a day already sent stays recorded; the first day can't go before today); Remove stops the
    sends still to come, keeps the row, its words and what went, double-confirmed
  * THE PAGES: Add / Edit panel, Emails and templates (group Your own emails, dated words for a day used by the send), Email > Sent's card and its
    People > panel; the access map; no GET writes
Every guard is FALSIFIED (patched away, the check fails) and put back. Synthetic world, ZZGM-*, on a fresh scratch database."""
import html
import json
import os
import re
import sys
from datetime import date, datetime, timedelta

from werkzeug.datastructures import MultiDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Your own emails: the store, who, the send, the recheck, the calendar, edit and remove")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
import gh_mail_world as GW  # noqa: E402

SU, BGA, EMP = H.actors(a)
W = GW.world(a, a.DB_PATH)
db, U, run, utc = W.db, W.U, W.run, W.utc
_real = (a.mailer.is_configured, a._outbox_kick, a.email_wave_rules)
a.mailer.is_configured = lambda: True
a._outbox_kick = lambda *x, **k: False
sup = H.client_as(a, SU["id"])
bga = H.client_as(a, BGA["id"]) if BGA else None
emp = H.client_as(a, EMP["id"])
D = lambda n, m=11: date(2026, m, n)   # noqa: E731
BG = W.BG


class Patch:
    def __init__(self, name, fn):
        self.name, self.fn = name, fn

    def __enter__(self):
        self.old = getattr(a, self.name)
        setattr(a, self.name, self.fn)

    def __exit__(self, *x):
        setattr(a, self.name, self.old)


def form(**kw):
    """A posted form for the Add panel (a MultiDict); a value None leaves the field out, a list posts it many times."""
    base = dict(name="ZZ own A", subject="{days_left}: {tasks} still to do", heading="A nudge from Group People", greeting="Hi {name},",
                opening="Here is what is still waiting on you.", button="Open AI+ OneHR", closing="", footer="", role=["lm"], waiting="waiting",
                bg_mode="some", bg=[BG], first_day="2026-11-12", at_time="09:00", repeat="days", every_n="2", until="2026-11-16", weekday="")
    base.update(kw)
    md = MultiDict()
    for k, v in base.items():
        if v is None:
            continue
        for x in (v if isinstance(v, list) else [v]):
            md.add(k, x)
    return md


def save(f, oid=None, now=None, who=None):
    return run(lambda d: a.email_own_save(d, who or SU, f, oid, now or datetime(2026, 11, 12, 8, 0)))


def own_row(oid):
    return db.execute("SELECT * FROM email_own WHERE id=?", (oid,)).fetchone()


def n(table, where="1=1", args=()):
    return db.execute("SELECT COUNT(*) FROM %s WHERE %s" % (table, where), args).fetchone()[0]


def counts():
    return {t: n(t) for t in ("email_own", "email_own_sends", "email_templates", "email_outbox", "email_skips", "activity_log", "notifications", "app_settings")}


def cyc_(d):
    return a.active_cycle(d)


def recips(oid, day=D(12), **kw):
    return run(lambda d: a.email_own_recipients(d, cyc_(d), a.email_own_row(d, oid, live=False), day, **kw))


def who_ids(res):
    return sorted(r["u"]["id"] for r in res["rows"])


def uid(*ks):
    return sorted(U[k] for k in ks)


def auto(now, oid=None):
    return run(lambda d: a.email_own_auto(d, cyc_(d), now=now))


def outbox(oid=None, status=None):
    q, args = "SELECT * FROM email_outbox WHERE kind=?", [a.OWN_KIND]
    if oid:
        q += " AND batch LIKE ?"
        args.append("own-%d-%%" % oid)
    if status:
        q += " AND status=?"
        args.append(status)
    return db.execute(q + " ORDER BY id", args).fetchall()


def setting(key, val):
    db.execute("DELETE FROM app_settings WHERE key=?", (key,))
    if val is not None:
        db.execute("INSERT INTO app_settings(key,value) VALUES (?,?)", (key, val))
    db.commit()


def sql_count(fn):
    seen = []

    def go(d):
        d.set_trace_callback(lambda q: seen.append(q))
        try:
            fn(d)
        finally:
            d.set_trace_callback(None)
    run(go)
    return len(seen)


def clear_own():
    for t in ("email_own_sends", "email_own", "email_skips", "email_outbox", "notifications"):
        db.execute("DELETE FROM %s" % t)
    db.execute("DELETE FROM email_templates WHERE email LIKE 'own:%'")
    db.execute("DELETE FROM activity_log WHERE action LIKE 'email_own%'")
    db.commit()


def reset_sends():
    """Forget what the sends queued and logged (the series stay)."""
    for t in ("email_outbox", "email_own_sends", "notifications"):
        db.execute("DELETE FROM %s" % t)
    db.execute("DELETE FROM activity_log WHERE action='email_own_run'")
    db.commit()


def stamp_runs(day, hh, mm=5):
    """The run rows read the server's real clock; a calendar read of a simulated day needs them on that day."""
    db.execute("UPDATE activity_log SET created_at=? WHERE action='email_own_run'", (utc(day, hh, mm),))
    db.commit()


def post(c, url, data, **kw):
    return c.post(url, data=dict({"csrf_token": "tok"}, **data), **kw)


def page(url, c=None):
    r = (c or sup).get(url)
    return r.status_code, html.unescape(r.get_data(as_text=True))


def snapshot_tables():
    return {t: n(t) for t in ("email_own", "email_own_sends", "email_templates", "app_settings", "activity_log", "email_outbox", "notifications",
                              "email_skips", "ready_notices", "users")}


try:
    W.clock(12, 8, 0)
    W.rem_settings(days=(2, 1))
    setting("email_wave_on", "1")
    clear_own()
    # ============================================================================================================== the store
    s.section("the store: the tables, a new series, its words as a usual template, the audit row")
    cols = [r[1] for r in db.execute("PRAGMA table_info(email_own)")]
    s.check("email_own has the brief's columns", cols == ["id", "name", "roles", "waiting_only", "bgs", "first_day", "at_time", "repeat", "every_n", "weekday",
                                                         "until", "cycle_id", "created_by", "created_at", "updated_by", "updated_at", "removed_by", "removed_at"], cols)
    scols = [r[1] for r in db.execute("PRAGMA table_info(email_own_sends)")]
    s.check("email_own_sends keeps a record of each send, UNIQUE on (own_id, day)", scols[:3] == ["id", "own_id", "day"] and any(
        r[2] for r in db.execute("PRAGMA index_list(email_own_sends)") if r[2]), scols)
    ok, said, oid, errs = save(form())
    row = own_row(oid) if oid else None
    s.check("a new series is saved by the super admin", ok and row is not None and row["name"] == "ZZ own A" and said.startswith("Saved “ZZ own A”"), said)
    s.check("...with its roles, waiting, groups, days and time as posted", row and json.loads(row["roles"]) == ["lm"] and row["waiting_only"] == 1 and json.loads(row["bgs"]) == [BG]
            and (row["first_day"], row["at_time"], row["repeat"], row["every_n"], row["until"]) == ("2026-11-12", "09:00", "days", 2, "2026-11-16")
            and row["cycle_id"] == W.CID and row["created_by"] == SU["id"] and row["removed_at"] is None, dict(row) if row else None)
    tp = db.execute("SELECT * FROM email_templates WHERE email=?", ("own:%d" % oid,)).fetchall()
    s.check("its words are ONE usual template under its own key (the same key its skip uses)", len(tp) == 1 and tp[0]["usual"] == 1 and tp[0]["retired_at"] is None
            and json.loads(tp[0]["words"])["subject"] == "{days_left}: {tasks} still to do", [dict(t) for t in tp])
    ad = db.execute("SELECT detail FROM activity_log WHERE action='email_own_add' ORDER BY id DESC LIMIT 1").fetchone()
    s.check("the audit row 'email_own_add' names it, who, the days and the count", ad is not None and "ZZ own A" in ad[0] and "Line managers" in ad[0]
            and "3 sends" in ad[0], ad[0] if ad else None)
    s.check("the shared spec is the last EMAIL_TPL_KINDS row, flagged shared, with the six placeholders; it never gets a template of its own",
            a.EMAIL_TPL_KINDS[-1]["key"] == "own" and a.EMAIL_TPL_KINDS[-1].get("shared") and a.EMAIL_TPL_KIND["own"]["placeholders"] ==
            ("name", "first_name", "link", "closes", "days_left", "tasks") and n("email_templates", "email='own'") == 0)
    s.check("the resolver gives an own email the shared spec under its own name; an unknown key is a KeyError, 'own' itself is no email with words",
            run(lambda d: a.email_tpl_kind("own:%d" % oid, d)["title"]) == "ZZ own A" and run(lambda d: a.email_tpl_valid("own:%d" % oid, d))
            and not run(lambda d: a.email_tpl_valid("own", d)) and not run(lambda d: a.email_tpl_valid("own:999999", d)))
    w_ = run(lambda d: a.email_tpl_words("own:%d" % oid, day=D(12), db=d))
    s.check("email_tpl_words('own:<id>', day) is what a send reads", w_["opening"] == "Here is what is still waiting on you." and w_["greeting"] == "Hi {name},")

    s.section("the refusals: nothing is stored")
    before = counts()

    def refused(label, f, text, **kw):
        ok_, said_, oid_, errs_ = save(f, **kw)
        s.check("%s is refused, nothing stored%s" % (label, " (" + text + ")" if text else ""), not ok_ and (not text or text in " ".join(errs_ + [said_])) and counts() == before,
                (said_, errs_, {k: (before[k], counts()[k]) for k in before if before[k] != counts()[k]}))
    refused("an employee", form(name="ZZ x"), "Only the super admin", who=EMP)
    refused("a BG admin", form(name="ZZ x"), "Only the super admin", who=BGA) if BGA else None
    refused("a named person (user_id)", form(name="ZZ x", user_id="%d" % U["M1"]), "never to named people")
    refused("a named person (employee_id)", form(name="ZZ x", employee_id="ZZGM-M1"), "never to named people")
    refused("a list of people (person_ids)", form(name="ZZ x", person_ids=["1", "2"]), "never to named people")
    refused("a field the form was never drawn with", form(name="ZZ x", wibble="1"), "doesn't take the field")
    refused("a placeholder OneHR can't fill ({count})", form(name="ZZ x", opening="You have {count} things."), "{count}, which OneHR doesn't fill in")
    refused("{display_name} (an own email's is {name})", form(name="ZZ x", greeting="Hi {display_name},"), "{display_name}")
    refused("{tasks} with All of them", form(name="ZZ x", waiting="all"), "{tasks} lists what is waiting")
    refused("{tasks} with BG admins ticked", form(name="ZZ x", role=["lm", "bgadmin"]), "has nothing to count for a BG admin")
    refused("Until past the cycle's last close", form(name="ZZ x", until="2026-12-02"), "Nothing goes after the cycle's last part closes on Mon 30 Nov 2026")
    refused("a one-off on a day past it", form(name="ZZ x", repeat="once", first_day="2026-12-01", until=None), "Nothing goes after the cycle's last part closes")
    refused("a first day in the past", form(name="ZZ x", first_day="2026-11-10", until="2026-11-16"), "The first day can't be before today")
    refused("Every 0 days", form(name="ZZ x", every_n="0"), "from 1 to 30")
    refused("Every 31 days", form(name="ZZ x", every_n="31"), "from 1 to 30")
    refused("Every a-few days", form(name="ZZ x", every_n="soon"), "from 1 to 30")
    refused("Every week with no weekday", form(name="ZZ x", repeat="weekly", weekday=None), "Pick the day of the week")
    refused("a repeat with no Until", form(name="ZZ x", until=""), "Give the last day")
    refused("Until before the first day", form(name="ZZ x", until="2026-11-11"), "Until comes before the first day")
    refused("a time off the quarter hour", form(name="ZZ x", at_time="09:10"), "quarter hour")
    refused("a time that has gone today", form(name="ZZ x", at_time="08:00"), "has gone today", now=datetime(2026, 11, 12, 8, 30))
    refused("an unknown role", form(name="ZZ x", role=["lm", "ceo"]), "Pick roles from the list")
    refused("no role", form(name="ZZ x", role=[]), "Tick who gets it")
    refused("a business group that is not on the list", form(name="ZZ x", bg=["Nowhere Group"]), "Pick business groups from the list")
    refused("Pick some with none picked", form(name="ZZ x", bg=[]), "Pick at least one business group")
    refused("an empty subject", form(name="ZZ x", subject=""), "Subject can't be empty")
    refused("a field with no subject at all", form(name="ZZ x", subject=None), "Subject can't be empty")
    refused("a name already used", form(name="zz OWN a", every_n="2"), "already have an email called")
    refused("a name over 60 characters", form(name="Z" * 61), "under 60 characters")
    refused("no days between the dates (weekly Mon between Tue and Thu)", form(name="ZZ x", repeat="weekly", weekday="0", first_day="2026-11-12", until="2026-11-15"),
            "No send day falls between those dates")
    # every guard falsified
    with Patch("_own_named_refusal", lambda f: None):
        ok_, said_, oid_, errs_ = save(form(name="ZZ falsified", user_id="%d" % U["M1"]))
        s.check("FALSIFIED: without the named-people guard the post is accepted (the guard is what refuses it)", ok_ and oid_ is not None, said_)
        if oid_:
            db.execute("DELETE FROM email_own WHERE id=?", (oid_,))
            db.execute("DELETE FROM email_templates WHERE email=?", ("own:%d" % oid_,))
            db.execute("DELETE FROM activity_log WHERE action='email_own_add' AND detail LIKE 'ZZ falsified%'")
            db.commit()
    with Patch("_own_words_problems", lambda w, wo, r: []):
        ok_, said_, oid_, errs_ = save(form(name="ZZ falsified", waiting="all"))
        s.check("FALSIFIED: without the {tasks} rule it is accepted with All of them", ok_, said_)
        if oid_:
            db.execute("DELETE FROM email_own WHERE id=?", (oid_,))
            db.execute("DELETE FROM email_templates WHERE email=?", ("own:%d" % oid_,))
            db.commit()
    with Patch("email_own_cycle_last", lambda d, c: None):
        ok_, said_, oid_, errs_ = save(form(name="ZZ falsified", until="2026-12-02"))
        s.check("FALSIFIED: without the cycle's last close, Until past it is accepted", ok_, said_)
        if oid_:
            db.execute("DELETE FROM email_own WHERE id=?", (oid_,))
            db.execute("DELETE FROM email_templates WHERE email=?", ("own:%d" % oid_,))
            db.commit()
    db.execute("DELETE FROM activity_log WHERE action='email_own_add' AND detail LIKE 'ZZ falsified%'")
    db.commit()
    s.check("...and the falsified runs left the tables as they were", counts()["email_own"] == before["email_own"] and counts()["email_templates"] == before["email_templates"], counts())

    # the route: the same refusals, the CSRF token in the form, a non-super's POST
    s.section("the route: POST /admin/email/own/save")
    j = lambda r: json.loads(r.get_data(as_text=True))   # noqa: E731
    post_f = lambda f: {k: (f.getlist(k) if len(f.getlist(k)) > 1 else f.get(k)) for k in f.keys()}   # noqa: E731
    r = sup.post("/admin/email/own/save", data=dict(post_f(form(name="ZZ x", user_id="%d" % U["M1"])), csrf_token="tok"), headers={"X-Requested-With": "fetch"})
    jr = j(r)
    s.check("a posted person is refused by the route (JSON for the panel), nothing stored", r.status_code == 200 and jr["ok"] is False and "never to named people" in jr["message"] and counts() == before, jr)
    r = sup.post("/admin/email/own/save", data=dict(post_f(form(name="ZZ x", user_id="%d" % U["M1"])), csrf_token="tok"), follow_redirects=True)
    s.check("...and the same without fetch is a flash and a redirect, nothing stored", "never to named people" in html.unescape(r.get_data(as_text=True)) and counts() == before)
    r = sup.post("/admin/email/own/save", data=dict(post_f(form(name="ZZ route", every_n="2")), csrf_token="tok"), headers={"X-Requested-With": "fetch"})
    jr = j(r)
    s.check("a good form is saved through the route; the reply names where to go next", jr["ok"] is True and jr["id"] and "panel=list" in jr["redirect"], jr)
    rid = jr["id"]
    r = bga.post("/admin/email/own/save", data=dict(post_f(form(name="ZZ y")), csrf_token="tok")) if bga else None
    s.check("a BG admin's POST is refused (403), nothing stored", r is None or (r.status_code == 403 and n("email_own", "name='ZZ y'") == 0))
    r = emp.post("/admin/email/own/save", data=dict(post_f(form(name="ZZ y")), csrf_token="tok"))
    s.check("an employee's POST is refused, nothing stored", r.status_code in (302, 403) and n("email_own", "name='ZZ y'") == 0)
    r = sup.post("/admin/email/own/save", data=post_f(form(name="ZZ z")))
    s.check("a POST without the CSRF token is refused, nothing stored", r.status_code == 400 and n("email_own", "name='ZZ z'") == 0)
    s.check("every new route is the super admin's in the access map", all(a.ADMIN_ACCESS_MAP.get(ep) == "super" for ep in (
        "admin_email_own_save", "admin_email_own_remove", "admin_email_own_summary", "admin_email_own_preview", "admin_email_own_words")))
    db.execute("DELETE FROM email_own WHERE id=?", (rid,))
    db.execute("DELETE FROM email_templates WHERE email=?", ("own:%d" % rid,))
    db.commit()

    # ================================================================================================================ the days
    s.section("email_own_days: once, every N days, weekly, the cap, a removed series")
    row = lambda **kw: dict(dict(first_day="2026-11-10", at_time="09:00", repeat="days", every_n=2, weekday=None, until="2026-11-14", removed_at=None), **kw)   # noqa: E731
    dd = lambda r, f=D(1), t=D(30), cap=None: a.email_own_days(r, f, t, cap)   # noqa: E731
    s.check("every 2 days from Tue 10 to Sat 14: 10, 12, 14 (the canvas's B1 summary)", dd(row()) == [D(10), D(12), D(14)], dd(row()))
    s.check("...a window inside it", dd(row(), D(11), D(13)) == [D(12)] and dd(row(), D(15), D(30)) == [] and dd(row(), D(1), D(9)) == [])
    s.check("every day is each day; every 3 days counts from the FIRST day", dd(row(every_n=1)) == [D(x) for x in range(10, 15)] and dd(row(every_n=3), D(11), D(30)) == [D(13)])
    s.check("weekly: each Thursday from the first day, up to Until", dd(row(repeat="weekly", weekday=3, until="2026-12-03"), D(1), D(30, 12)) == [D(12), D(19), D(26), D(3, 12)])
    s.check("weekly starts on the first day's own weekday when it is that day, else the next one", dd(row(repeat="weekly", weekday=1, first_day="2026-11-10", until="2026-11-24")) == [D(10), D(17), D(24)]
            and dd(row(repeat="weekly", weekday=0, first_day="2026-11-10", until="2026-11-24")) == [D(16), D(23)])
    s.check("once: its first day, only when the window holds it", dd(row(repeat="once", until=None)) == [D(10)] and dd(row(repeat="once", until=None), D(11), D(30)) == [])
    s.check("the cap (the cycle's last close) cuts the series", dd(row(until="2026-12-30", every_n=7), cap=D(30)) == [D(10), D(17), D(24)] and dd(row(first_day="2026-12-01", repeat="once", until=None), cap=D(30)) == [])
    s.check("a removed series has no days, and a row with no Until (a repeat) none", dd(row(removed_at="2026-11-11 00:00:00")) == [] and dd(row(until=None)) == [])

    # ===================================================================================================== Start from (B2)
    s.section("Start from: the option list, a COPY of the words, the original never changes")
    ok, said, base_id, errs = save(form(name="ZZ base", role=["hod"], waiting="all", subject="Base subject", opening="Base opening {name}", closing="Base closing", footer="Base footer",
                                        every_n="2", repeat="once", first_day="2026-11-13", until=None))
    s.check("(an own email to start from later)", ok, said)
    sup.get("/admin/emails")   # a first visit makes each email's usual template (production has had them since 24 Oct)
    groups = run(lambda d: a.email_own_start_groups(d))
    labels = [g["label"] for g in groups]
    s.check("grouped as the Emails and templates rail: Cycle reviews, Results, Grade H Appraisal (Grade H runs), then Your own emails; no Upgrades and maintenance",
            labels == ["Cycle reviews", "Results", "Grade H Appraisal", "Your own emails"], labels)
    allt = {t["id"]: t for t in db.execute("SELECT * FROM email_templates WHERE retired_at IS NULL")}
    listed = {o["tid"] for g in groups for o in g["opts"]}
    notice = {t["id"] for t in allt.values() if t["email"] in ("notice_before", "notice_after")}
    s.check("every template still in use is listed, bar the two upgrade notices", listed == set(allt) - notice and not (listed & notice), (len(listed), len(allt)))
    rem = next(t for t in allt.values() if t["email"] == "reminder" and t["usual"])
    ro = next(o for g in groups for o in g["opts"] if o["tid"] == rem["id"])
    s.check("an email's usual template is marked usual (the reminder's), a dated one shows its dates", ro["usual"] and ro["label"] == "Everyone's reminder · %s" % rem["name"])
    ghr = next(t for t in allt.values() if t["email"] == "gradeh_reminder" and t["usual"])
    s.check("Grade H's BM / EN templates say so", next(o for g in groups for o in g["opts"] if o["tid"] == ghr["id"])["bm_en"] is True)
    gh_off = os.environ.get("ONEHR_GRADEH")
    os.environ["ONEHR_GRADEH"] = "0"
    labels_off = [g["label"] for g in run(lambda d: a.email_own_start_groups(d))]
    os.environ["ONEHR_GRADEH"] = gh_off
    s.check("Grade H's group is listed only where Grade H is set up", "Grade H Appraisal" not in labels_off and "Grade H Appraisal" in labels, labels_off)
    # dated template is listed with its dates
    run(lambda d: a.email_day_words(d, SU, "reminder", D(20)))
    dated = db.execute("SELECT * FROM email_templates WHERE email='reminder' AND date_from='2026-11-20'").fetchone()
    g2 = run(lambda d: a.email_own_start_groups(d))
    od = next((o for g in g2 for o in g["opts"] if dated and o["tid"] == dated["id"]), None)
    s.check("a dated template is listed with its dates", od is not None and od["dated"] and "Fri 20 Nov" in od["when"], od)
    if dated:
        db.execute("DELETE FROM email_templates WHERE id=?", (dated["id"],))
        db.commit()
    before_words = db.execute("SELECT words, name, usual FROM email_templates WHERE id=?", (rem["id"],)).fetchone()
    cp = run(lambda d: a.email_own_copy_words(d, rem["id"]))
    src = json.loads(before_words["words"])
    s.check("a copy takes the template's own words (subject, greeting, button, closing, footer) and names itself 'Copy of <its name>'",
            cp["name"] == "Copy of %s" % rem["name"] and cp["words"]["subject"] == src["subject"] and cp["words"]["button"] == src["button"]
            and cp["words"]["closing"] == src["closing"] and cp["words"]["footer"] == src["footer"] and cp["words"]["greeting"] == src["greeting"].replace("{display_name}", "{name}"), cp)
    s.check("...{display_name} becomes {name}; placeholders a new email can't fill are listed (flagged amber): the reminder's {count}, {things}, {cycle}",
            "{display_name}" not in cp["words"]["greeting"] and {"count", "things", "cycle"} <= set(cp["flagged"]), cp["flagged"])
    f_cp = form(name="ZZ copy", subject=cp["words"]["subject"], heading=cp["words"]["heading"], opening=cp["words"]["opening"], closing=cp["words"]["closing"],
                footer=cp["words"]["footer"], greeting=cp["words"]["greeting"], button=cp["words"]["button"], role=["lm"])
    ok, said, _o, errs = save(f_cp)
    s.check("a copy saved as it stands is refused on its placeholders (the server's refusal, not just the amber line)", not ok and "which OneHR doesn't fill in" in said, said)
    ok, said, copy_id, errs = save(form(name="ZZ copy", subject="Edited subject", opening="Edited opening", closing=cp["words"]["closing"], footer="", role=["lm"]))
    after_words = db.execute("SELECT words, name, usual FROM email_templates WHERE id=?", (rem["id"],)).fetchone()
    s.check("editing a copy never changes the original (its words, name and usual flag are as they were)", ok and tuple(after_words) == tuple(before_words))
    lp = next(t for t in allt.values() if t["email"] == "lp_hod" and t["usual"])
    cl = run(lambda d: a.email_own_copy_words(d, lp["id"]))
    s.check("a leader progress template copies its opening and closing; the table is not copied and the panel says so", cl["words"]["opening"] == json.loads(lp["words"])["opening"]
            and "The progress table isn't in a new email" in cl["note"], cl["note"])
    s.check("Grade H's BM / EN copy is the English words only", run(lambda d: a.email_own_copy_words(d, ghr["id"]))["words"]["opening"] == json.loads(ghr["words"])["opening"]
            and "opening_bm" not in run(lambda d: a.email_own_copy_words(d, ghr["id"]))["words"])
    rd = next(t for t in allt.values() if t["email"] == "ready_hod" and t["usual"])
    s.check("a ready note's (open) opening and button are copied; its table is not", run(lambda d: a.email_own_copy_words(d, rd["id"]))["words"]["opening"] == json.loads(rd["words"])["opening_open"]
            and run(lambda d: a.email_own_copy_words(d, rd["id"]))["words"]["button"] == json.loads(rd["words"])["button_open"] and "table" in run(lambda d: a.email_own_copy_words(d, rd["id"]))["note"])
    s.check("a template that is not there (or is retired) copies nothing", run(lambda d: a.email_own_copy_words(d, 9999999)) is None and run(lambda d: a.email_own_copy_words(d, "x")) is None)
    r = sup.get("/admin/email/own/words?tid=%d" % rem["id"])
    s.check("the route gives the same copy as JSON (GET writes nothing)", r.status_code == 200 and j(r)["ok"] and j(r)["words"]["subject"] == src["subject"])
    for oid_ in (base_id, copy_id):
        db.execute("DELETE FROM email_own WHERE id=?", (oid_,))
        db.execute("DELETE FROM email_templates WHERE email=?", ("own:%d" % oid_,))
    db.commit()

    # ===================================================================================================================== who
    s.section("who: roles, waiting or all, business groups, one email a person, opt-outs, the Executive Chairman, BG admins")
    W.clock(12, 8, 0)
    for mk_ in ("M2", "M3", "M4"):   # a line manager is one of people TAKING PART: the world's S* are Grade H (not in the review), so M2 to M4 get a report who is
        W.mk("KEEPREP" + mk_, "13", mgr=W.U[mk_], email="keeprep%s@zzgm.example" % mk_.lower())
    db.commit()

    def mk_own(**kw):
        ok_, said_, oid_, errs_ = save(form(**dict(dict(name="ZZ who %d" % (db.execute("SELECT COUNT(*) FROM email_own").fetchone()[0] + 1)), **kw)))
        assert ok_, (said_, errs_)
        return oid_
    o_lm = mk_own(role=["lm"], waiting="waiting")
    r1 = recips(o_lm)
    s.check("line managers with something still waiting (Grade H appraisers with appraisals still open on 12 Nov): M2 only", who_ids(r1) == uid("M2") and r1["n"] == 1, who_ids(r1))
    s.check("...candidates are every line manager in the group, those with nothing waiting are counted and left out", r1["candidates"] == 4 and r1["nothing"] == 3 and r1["exact"], r1["candidates"])
    o_lm_all = mk_own(role=["lm"], waiting="all", subject="No tasks here", opening="Hello.")
    s.check("'All of them': every line manager in the group", who_ids(recips(o_lm_all)) == uid("M1", "M2", "M3", "M4"), who_ids(recips(o_lm_all)))
    # a manager whose only report is not taking part is not a line manager of this cycle
    W.mk("NOPART", "15", email="zznopart@zzgm.example")
    W.mk("NOPARTREP", "H", mgr=W.U["NOPART"], email="zznopartrep@zzgm.example")   # a Grade H person: never in the normal review
    W.mk("OUTREP", "13", mgr=W.U["NOPART"], email="zzoutrep@zzgm.example")
    db.commit()
    db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?, 'remove')", (W.CID, W.U["OUTREP"]))   # an admin took this one out of the cycle
    db.commit()
    s.check("'Line managers, all of them' reaches only line managers of people TAKING PART: a manager whose only reports are a Grade H person and one taken out of the cycle is not reached",
            U["NOPART"] not in who_ids(recips(o_lm_all)) and who_ids(recips(o_lm_all)) == uid("M1", "M2", "M3", "M4"), who_ids(recips(o_lm_all)))
    with Patch("participant_sql", lambda prefix="", module=None: "1=1"):
        s.check("FALSIFIED: without the participant rule on the managed person that manager is reached", U["NOPART"] in who_ids(recips(o_lm_all)))
    db.execute("UPDATE cycle_participants SET mode='add' WHERE cycle_id=? AND subject_id=?", (W.CID, W.U["OUTREP"]))
    db.commit()
    s.check("...and a report an admin ADDED to the cycle makes their manager a line manager of it", U["NOPART"] in who_ids(recips(o_lm_all)))
    db.execute("DELETE FROM cycle_participants WHERE subject_id=?", (W.U["OUTREP"],))
    db.execute("DELETE FROM users WHERE employee_id IN ('ZZGM-NOPART','ZZGM-NOPARTREP','ZZGM-OUTREP')")
    db.commit()
    o_hod = mk_own(role=["hod"], waiting="all", subject="HODs", opening="Hello.")
    s.check("HODs (lp_leaders, the HOD role): the three Grade H HODs of the world", set(who_ids(recips(o_hod))) >= set(uid("H1", "H2", "H3")), who_ids(recips(o_hod)))
    o_hod_w = mk_own(role=["hod"], waiting="waiting")
    s.check("HODs with something waiting: H1 and H2 (their Grade H calibration is open on 12 Nov), not H3 (signed off)", who_ids(recips(o_hod_w)) == uid("H1", "H2"), who_ids(recips(o_hod_w)))
    o_bu = mk_own(role=["buceo"], waiting="all", subject="BU CEOs", opening="Hello.")
    s.check("BU CEOs (the seats): B1 and B2", set(who_ids(recips(o_bu))) >= set(uid("B1", "B2")), who_ids(recips(o_bu)))
    o_every = mk_own(role=["everyone"], waiting="waiting")
    s.check("Everyone taking part with something waiting: the three with something waiting (M2, H1, H2)", who_ids(recips(o_every)) == uid("M2", "H1", "H2"), who_ids(recips(o_every)))
    o_every_all = mk_own(role=["everyone"], waiting="all", subject="All", opening="Hello.")
    ev = who_ids(recips(o_every_all))
    s.check("Everyone taking part, all of them: the world's participants (Grade H staff are not in the normal review)", set(uid("M1", "M2", "M3", "M4", "B1", "B2", "H1", "H2", "H3", "X1", "KEEPREPM2", "KEEPREPM3", "KEEPREPM4")) == set(ev), ev)
    # one email a person with two roles ticked
    o_two = mk_own(role=["everyone", "lm", "hod"], waiting="waiting")
    rt = recips(o_two)
    s.check("ONE EMAIL A PERSON with three roles ticked: each person once, however many roles reach them", who_ids(rt) == uid("M2", "H1", "H2") and len(rt["rows"]) == len({r["u"]["id"] for r in rt["rows"]})
            and rt["n"] == 3 and sorted(next(r for r in rt["rows"] if r["u"]["id"] == U["M2"])["roles"]) == ["everyone", "lm"], [(r["u"]["id"], r["roles"]) for r in rt["rows"]])
    # business groups
    db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES ('ZZGM Other Group', 'ZZGM Other Unit')")
    db.commit()
    o_other = mk_own(role=["everyone"], waiting="all", subject="Other", opening="Hello.", bg=["ZZGM Other Group"])
    s.check("a business group with none of them gives nobody; All business groups reaches the group too", recips(o_other)["n"] == 0
            and set(uid("M1")) <= set(who_ids(recips(mk_own(role=["lm"], waiting="all", subject="x", opening="y", bg_mode="all", bg=None)))))
    s.check("a business group is matched on the seat's group for a leader: a BU CEO of the group", set(who_ids(recips(o_bu))) >= set(uid("B1", "B2")) and
            recips(mk_own(role=["buceo"], waiting="all", subject="x", opening="y", bg=["ZZGM Other Group"]))["n"] == 0)
    # opt-outs
    W.optout("M2", "reminder")
    s.check("Everyone's reminder's opt-out is honoured (M2 gets none, and is counted)", who_ids(recips(o_lm)) == [] and recips(o_lm)["opted_out"] == 1, recips(o_lm))
    db.execute("DELETE FROM email_optouts")
    W.optout("H1", "leader_progress")
    s.check("Leader progress's opt-out drops a person reached only through a leader role", who_ids(recips(o_hod_w)) == uid("H2"))
    o_hod_every = mk_own(role=["hod", "everyone"], waiting="waiting")
    s.check("...but not one who is also reached as Everyone (the opt-out is of the leader email)", uid("H1") == [x for x in who_ids(recips(o_hod_every)) if x == U["H1"]])
    with Patch("email_optout_ids", lambda d, k: set()):
        s.check("FALSIFIED: without the opt-out read, an opted-out person is in", U["H1"] in who_ids(recips(o_hod_w)))
    db.execute("DELETE FROM email_optouts")
    db.commit()
    # the Executive Chairman
    setting(a.CHAIR_SETTING_ID, str(U["M2"]))
    s.check("the Executive Chairman is never emailed by role alone: 'all of them' leaves his seat out", U["M2"] not in who_ids(recips(o_lm_all)) and recips(o_lm_all)["n"] == 3, who_ids(recips(o_lm_all)))
    s.check("...when something is waiting on him (Everyone's rule) he is in", U["M2"] in who_ids(recips(o_lm)))
    setting(a.CHAIR_SETTING_ID, str(U["H1"]))
    s.check("...and never through a leader role, flag on or off", U["H1"] not in who_ids(recips(o_hod_w)) and U["H1"] not in who_ids(recips(o_hod)), who_ids(recips(o_hod_w)))
    with Patch("reminder_cc_chair_id", lambda d: None):
        s.check("FALSIFIED: without the seat the Chairman is among the HODs", U["H1"] in who_ids(recips(o_hod)))
    setting(a.CHAIR_SETTING_ID, None)
    # BG admins
    adm = []
    for i, addrs in enumerate((["zzown.a@example.test", "zzown.shared@example.test"], ["zzown.shared@example.test", "zzown.b@example.test"], [])):
        aid = db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, admin_bg, email) VALUES (?,?,?,?,?,?,?)",
                         ("zzownadm%d" % i, "ZZ Own Admin %d" % i, "x", "admin", "ZZOWN-ADM%d" % i, BG, None)).lastrowid
        for ad_ in addrs:
            db.execute("INSERT INTO admin_notify_emails(user_id, email) VALUES (?,?)", (aid, ad_))
        adm.append(aid)
    db.commit()
    o_bga = mk_own(role=["bgadmin"], waiting="all", subject="BG admins", opening="Hello.")
    rb = recips(o_bga)
    s.check("BG admins: to their notification emails, an address two admins share once, an admin with none counted", rb["n"] == 3 and sorted(a_ for r in rb["rows"] for a_ in r["to"]) ==
            ["zzown.a@example.test", "zzown.b@example.test", "zzown.shared@example.test"] and rb["no_email"] == 1, rb["n"])
    s.check("...and {tasks} is refused with BG admins ticked (they have nothing waiting)", not save(form(name="ZZ bga tasks", role=["bgadmin"]))[0])
    adm_row = db.execute("SELECT * FROM users WHERE id=?", (adm[0],)).fetchone()
    _sub, _body = run(lambda d: a.email_own_mail(d, adm_row, None, cyc_(d), a.email_tpl_words("own:%d" % o_bga, day=D(12), db=d)))
    s.check("a BG admin's email has the admin portal as its button and no list of what waits", "/admin" in _body and "Open AI+ OneHR" in _body and "Appraise" not in _body and "oh-row" not in _body)
    # exact and upper bound
    ru = recips(o_lm, waiting=False)
    s.check("the upper bound reads no one's items: line managers 'up to' 4 and says it is not exact", ru["n"] == 4 and ru["exact"] is False and ru["nothing"] == 0)
    rx = recips(o_lm, exact_max=2)
    s.check("a count over its limit is 'up to', under it exact", rx["exact"] is False and rx["n"] == 4 and recips(o_lm, exact_max=10)["exact"] and recips(o_lm, exact_max=10)["n"] == 1)
    # the one person's rule
    s.check("the recheck's rule for one person: the person with something waiting is in, one with nothing is out and says why", who_ids(recips(o_lm, only=U["M2"])) == uid("M2")
            and recips(o_lm, only=U["M1"])["why"] == "nothing" and recips(o_lm, only=U["X1"])["why"] == "out")
    # batched
    base_q = sql_count(lambda d: a.email_own_recipients(d, cyc_(d), a.email_own_row(d, o_lm_all), D(12), waiting=False))
    for i in range(25):
        W.mk("ZZMGR%d" % i, "15", email="zzmgr%d@zzgm.example" % i)
        W.mk("ZZREP%d" % i, "13", mgr=W.U["ZZMGR%d" % i], email="zzrep%d@zzgm.example" % i)
    db.commit()
    more_q = sql_count(lambda d: a.email_own_recipients(d, cyc_(d), a.email_own_row(d, o_lm_all), D(12), waiting=False))
    s.check("BATCHED: the reads do not grow with the population (25 more managers: the same number of queries)", more_q == base_q and recips(o_lm_all)["n"] == 4 + 25, (base_q, more_q, recips(o_lm_all)["n"]))
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZGM-ZZMGR%' OR employee_id LIKE 'ZZGM-ZZREP%'")
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZOWN-ADM%'")
    db.execute("DELETE FROM admin_notify_emails WHERE email LIKE 'zzown.%'")
    db.commit()
    clear_own()

    # ===================================================================================================================== the send
    s.section("the send: nothing before its time, waves, the batch key, once a day, late ticks, skips, the record")
    ok, said, oid, errs = save(form(name="ZZ send", role=["lm"], waiting="waiting", first_day="2026-11-12", until="2026-11-16", every_n="2"))
    assert ok, said
    key = "own:%d" % oid
    rules2 = lambda: {"on": True, "size": 2, "gap": 30}   # noqa: E731
    say = auto(datetime(2026, 11, 12, 8, 59))
    s.check("before its time nothing is queued and no record is written ('not yet')", "not yet, it goes at 09:00" in say and not outbox() and n("email_own_sends") == 0, say)
    say = auto(datetime(2026, 11, 11, 9, 5))
    s.check("on a day that is not one of its days nothing happens", not outbox() and n("email_own_sends") == 0)
    W.clock(12, 9, 0)
    say = auto(datetime(2026, 11, 12, 9, 0))
    ob = outbox(oid)
    s.check("at its time on its day it is queued: one email to the line manager with something waiting (M2), the kind and batch key set",
            len(ob) == 1 and ob[0]["to_email"] == "zzgm-m2@zzgm.example" and ob[0]["batch"] == "own-%d-2026-11-12" % oid and ob[0]["user_id"] == U["M2"] and ob[0]["status"] == "queued", (say, [dict(o) for o in ob]))
    rec = db.execute("SELECT * FROM email_own_sends WHERE own_id=?", (oid,)).fetchone()
    s.check("...its send record is written in the same transaction (UNIQUE own_id, day), with what it queued", rec is not None and rec["day"] == "2026-11-12" and rec["queued"] == 1 and rec["people"] == 1
            and rec["batch"] == "own-%d-2026-11-12" % oid, dict(rec) if rec else None)
    run_row = db.execute("SELECT detail FROM activity_log WHERE action='email_own_run' ORDER BY id DESC LIMIT 1").fetchone()
    s.check("...and the run row counts only: people, emailed, opted out, no email, nothing waiting, the batch", run_row is not None and "1 people | 1 emailed" in run_row[0] and "batch own-%d-2026-11-12" % oid in run_row[0]
            and "ZZ GP" not in run_row[0], run_row[0] if run_row else None)
    body = ob[0]["body"]
    s.check("the email is the reminder's shell: light only, AI+ OneHR by Chin Hin, the greeting by the person's own name, the button, white boxes (bgcolor too), nobody else's name",
            "color-scheme" in body and "by Chin Hin" in body and "Hi ZZ GP M2," in body.replace("Hi Zz Gp M2,", "Hi ZZ GP M2,") and "Open AI+ OneHR" in body and "Appraise your Grade H team" in body
            and 'bgcolor="#ffffff"' in body and not re.search(r"ZZ GP S\d|ZZ GP M[134]", body), body[:300])
    s.check("the subject has its placeholders filled ({days_left}, {tasks}): the part closes in a few days, one thing waiting", re.match(r"^(\d+ days left|Last day): 1 thing still to do$", ob[0]["subject"]) is not None, ob[0]["subject"])
    n_out = n("email_outbox")
    say = auto(datetime(2026, 11, 12, 9, 15))
    s.check("a second tick the same day sends nothing more (already sent today)", n("email_outbox") == n_out and n("email_own_sends") == 1 and "already sent today" in say, say)
    ok2, w2, t2 = run(lambda d: a.email_own_send(d, cyc_(d), a.email_own_row(d, oid), D(12)))
    s.check("...nor does the sender itself: its second insert fails and nothing it rendered is queued", ok2 is False and "already sent" in w2 and n("email_outbox") == n_out, w2)
    db.execute("DELETE FROM email_own_sends WHERE own_id=?", (oid,))
    db.commit()
    ok3, w3, t3 = run(lambda d: a.email_own_send(d, cyc_(d), a.email_own_row(d, oid), D(12)))
    s.check("FALSIFIED: with the record gone the same day goes out again (the record is what holds it)", ok3 and n("email_outbox") == n_out + 1)
    reset_sends()
    # waves
    o_w = save(form(name="ZZ waves", role=["lm"], waiting="all", subject="Waves", opening="Hello.", first_day="2026-11-12", repeat="once", until=None))[2]
    with Patch("email_wave_rules", rules2):
        say = auto(datetime(2026, 11, 12, 9, 0))
    ow = outbox(o_w)
    waves = sorted({r["send_after"] for r in ow})
    s.check("it goes out in waves like every mass email: 4 line managers at 2 a wave are two waves, 30 minutes apart, in the sender's own wave times", len(ow) == 4 and len(waves) == 2
            and (a._parse_when(waves[1]) - a._parse_when(waves[0])) == timedelta(minutes=30), (len(ow), waves))
    db.execute("DELETE FROM email_outbox")
    db.execute("DELETE FROM email_own_sends")
    db.execute("DELETE FROM email_own WHERE id=?", (o_w,))
    db.execute("DELETE FROM email_templates WHERE email=?", ("own:%d" % o_w,))
    db.commit()
    # late ticks
    say = auto(datetime(2026, 11, 12, 11, 30))
    s.check("a late tick inside the grace hours sends that day's, once", len(outbox(oid)) == 1 and n("email_own_sends", "own_id=?", (oid,)) == 1, say)
    reset_sends()
    say = auto(datetime(2026, 11, 12, 12, 30))
    s.check("a job that was down past the grace hours does not send at night: that day did not go, and nothing is recorded", not outbox() and n("email_own_sends") == 0 and "did not go" in say, say)
    say = auto(datetime(2026, 11, 13, 9, 5))
    s.check("...and the next day (not one of its days) sends nothing: never yesterday's", not outbox() and n("email_own_sends") == 0)
    # skip
    ok, said = run(lambda d: a.email_skip_set(d, SU, key, D(12), "ZZ test: no nudge today", now=datetime(2026, 11, 12, 8, 0)))
    s.check("a skip of the series' day is written (its key is own:<id>, its name the series')", ok and "Skipped ZZ send on Thu 12 Nov" in said, said)
    say = auto(datetime(2026, 11, 12, 9, 0))
    s.check("a live skip holds it back: 'Skipped today: <reason>.', nothing queued, no record (the day is not sent)", "Skipped today: ZZ test: no nudge today." in say and not outbox() and n("email_own_sends") == 0, say)
    with Patch("email_skip_row", lambda d, e, day: None):
        say = auto(datetime(2026, 11, 12, 9, 0))
        s.check("FALSIFIED: without the skip read it sends anyway", len(outbox(oid)) == 1)
    reset_sends()
    sk = db.execute("SELECT id FROM email_skips WHERE email=?", (key,)).fetchone()[0]
    ok, said = run(lambda d: a.email_skip_undo(d, SU, sk, now=datetime(2026, 11, 12, 8, 30)))
    say = auto(datetime(2026, 11, 12, 9, 0))
    s.check("Put back before the time lets it go", ok and len(outbox(oid)) == 1, said)
    s.check("a skip of a day the series doesn't go, and of a removed one, is refused", not run(lambda d: a.email_skip_set(d, SU, key, D(13), "ZZ", now=datetime(2026, 11, 12, 8, 0)))[0]
            and not run(lambda d: a.email_skip_set(d, SU, "own:99999", D(12), "ZZ", now=datetime(2026, 11, 12, 8, 0)))[0])
    ok_late, said_late = run(lambda d: a.email_skip_set(d, SU, key, D(12), "ZZ late", now=datetime(2026, 11, 12, 9, 0)))
    s.check("a skip, and its Put back, only until the series' own send time (09:00): at 09:00 it has gone", not ok_late and said_late == a.EMAIL_SKIP_GONE
            and run(lambda d: a.email_skip_send_time(key)) == "09:00" and run(lambda d: a.email_skip_set(d, SU, key, D(12), "ZZ early", now=datetime(2026, 11, 12, 8, 59)))[0])
    reset_sends()
    db.execute("DELETE FROM email_skips")
    db.commit()
    # email not set up
    a.mailer.is_configured = lambda: False
    say = auto(datetime(2026, 11, 12, 9, 0))
    rec = db.execute("SELECT * FROM email_own_sends WHERE own_id=?", (oid,)).fetchone()
    s.check("a server with no email set up (staging) records the day with nothing queued, so it is not tried every 15 minutes", not outbox() and rec is not None and rec["queued"] == 0
            and "isn't set up" in (rec["note"] or "") and "isn't set up" in say, say)
    a.mailer.is_configured = lambda: True
    db.execute("DELETE FROM email_own_sends")
    db.commit()
    # a series made in another cycle is not this cycle's
    db.execute("DELETE FROM email_skips")
    db.execute("UPDATE email_own SET cycle_id=999 WHERE id=?", (oid,))
    db.commit()
    say = auto(datetime(2026, 11, 12, 9, 0))
    s.check("a series made in another cycle is not sent (a new cycle starts none of an old one's), and is not on the calendar", not outbox() and n("email_own_sends") == 0
            and not [e for es in run(lambda d: a.email_cal_plan(d, cyc_(d), D(1), D(30), datetime(2026, 11, 11, 9, 30)))["days"].values() for e in es if e["key"] == key])
    db.execute("UPDATE email_own SET cycle_id=? WHERE id=?", (W.CID, oid))
    db.commit()

    # ================================================================================================================== the recheck
    s.section("the recheck: just before each email goes")
    say = auto(datetime(2026, 11, 12, 9, 0))
    row_ = outbox(oid)[0]

    def claim(r):
        return db.execute("SELECT * FROM email_outbox WHERE id=?", (r["id"],)).fetchone()

    def recheck(r):
        return run(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (r["id"],)).fetchone()))

    def reset(r, **cols):
        db.execute("UPDATE email_outbox SET status='queued', error=NULL WHERE id=?", (r["id"],))
        for k, v in cols.items():
            db.execute("UPDATE email_outbox SET %s=? WHERE id=?" % k, (v, r["id"]))
        db.commit()
    got = recheck(row_)
    s.check("still waiting: the row comes back, unchanged when nothing changed", got is not None and got["subject"] == row_["subject"] and got["status"] == "queued")
    # dated words written after queue are not re-read; the queued day's template is
    W.submit(["S4", "S5", "S6"])   # M2's three people are done
    got = recheck(row_)
    c_ = claim(row_)
    s.check("finished since it was queued: dropped (cancelled, 'nothing pending when its wave came') and logged as skipped", got is None and c_["status"] == "cancelled" and c_["error"] == a.REMINDER_NOTHING_LEFT
            and n("notifications", "kind=? AND status='skipped' AND detail=?", (a.OWN_KIND, a.REMINDER_NOTHING_LEFT)) == 1, dict(c_))
    with Patch("email_own_recipients", lambda d, cy, o, day, **kw: {"rows": [{"u": d.execute("SELECT * FROM users WHERE id=?", (U["M2"],)).fetchone(), "to": ["zzgm-m2@zzgm.example"], "items": None, "roles": ["lm"]}],
                                                                       "why": None}):
        reset(row_)
        s.check("FALSIFIED: without the person's own rule the finished person's email goes", recheck(row_) is not None)
    for k_ in ("S4", "S5", "S6"):
        db.execute("UPDATE gradeh_appraisals SET lm_submitted_at=NULL, perf_band=NULL, pot_band=NULL WHERE person_id=?", (W.P[k_],))
    db.commit()
    reset(row_)
    W.optout("M2", "reminder")
    got = recheck(row_)
    s.check("opted out since it was queued: dropped ('opted out when its wave came')", got is None and claim(row_)["error"] == a.REMINDER_OPTED_OUT)
    db.execute("DELETE FROM email_optouts")
    db.commit()
    reset(row_)
    db.execute("INSERT INTO email_skips(email, day, reason, created_by) VALUES (?,?,?,?)", (key, "2026-11-12", "ZZ test", SU["id"]))
    db.commit()
    got = recheck(row_)
    s.check("its day skipped since: dropped, with its own reason", got is None and claim(row_)["error"] == a.OWN_SKIPPED_SINCE)
    db.execute("DELETE FROM email_skips")
    db.commit()
    reset(row_)
    db.execute("UPDATE email_own SET removed_at=datetime('now') WHERE id=?", (oid,))
    db.commit()
    got = recheck(row_)
    s.check("the series removed since: dropped, with its own reason", got is None and claim(row_)["error"] == a.OWN_REMOVED)
    db.execute("UPDATE email_own SET removed_at=NULL WHERE id=?", (oid,))
    db.commit()
    reset(row_)
    db.execute("UPDATE email_own SET roles=? WHERE id=?", (json.dumps(["hod"]), oid))
    db.commit()
    got = recheck(row_)
    s.check("no longer in the roles picked (the series was edited to HODs): dropped as nothing pending", got is None and claim(row_)["error"] == a.REMINDER_NOTHING_LEFT)
    db.execute("UPDATE email_own SET roles=? WHERE id=?", (json.dumps(["lm"]), oid))
    db.commit()
    reset(row_, subject="stale subject", body="stale body")
    got = recheck(row_)
    s.check("still waiting: the email is written again from what waits now and stored", got is not None and got["subject"] != "stale subject" and "Appraise your Grade H team" in got["body"]
            and claim(row_)["subject"] == got["subject"])
    other = db.execute("INSERT INTO email_outbox(kind, cycle_id, user_id, to_email, subject, body, batch) VALUES ('release_lead', ?, ?, 'zz@example.test', 's', 'b', 'zz-release')", (W.CID, U["M1"])).lastrowid
    db.commit()
    s.check("an email of another kind passes the recheck untouched", recheck({"id": other}) is not None)
    reset_sends()

    # ============================================================================================================== the calendar
    s.section("the calendar: the plan, the chips, the day panel")
    W.clock(11, 9, 30)
    NOW = datetime(2026, 11, 11, 9, 30)
    plan = lambda frm=D(1), to=D(30), now=NOW, only=None: run(lambda d: a.email_cal_plan(d, cyc_(d), frm, to, now, only))   # noqa: E731
    p = plan()
    own_days = sorted(i for i, es in p["days"].items() for e in es if e["key"] == key)
    s.check("the series is on the calendar on its days (12, 14, 16 Nov), as to go, in the group 'own'", own_days == ["2026-11-12", "2026-11-14", "2026-11-16"]
            and all(e["state"] == "to_go" and e["group"] == "own" and e["time"] == "09:00" and e["short"].startswith("↻ ") for es in p["days"].values() for e in es if e["key"] == key), own_days)
    mixed = [i for i, es in p["days"].items() if any(e["key"] == key for e in es) and any(e["key"] != key for e in es)]
    s.check("an own email sorts FIRST in its day (the ones folded into '+N more' are the built-in emails), in the order the series were made",
            len(mixed) >= 1 and all(p["days"][i][0]["key"].startswith("own:") for i in mixed)
            and all([e["key"] for e in es if e["key"].startswith("own:")] == sorted([e["key"] for e in es if e["key"].startswith("own:")], key=a.own_id_of) for es in p["days"].values()), mixed)
    code, pn_o = page("/admin/list/email-day?day=%s&fragment=1" % mixed[0])
    s.check("...and the day panel follows it: the series' card comes before Everyone's reminder's", code == 200 and "ZZ send" in pn_o and pn_o.index("ZZ send") < min(pn_o.index(e["name"]) for e in p["days"][mixed[0]] if not e["key"].startswith("own:") and e["name"] in pn_o), mixed[0])
    s.check("the 'Your own' chip counts it", p["counts"]["own"] == 3 and p["counts"]["all"] >= 3 and ("own", "Your own") in a.EMAIL_CAL_CHIPS)
    q_with = sql_count(lambda d: a.email_cal_plan(d, cyc_(d), D(1), D(30), NOW))
    db.execute("UPDATE email_own SET removed_at=datetime('now')")
    db.commit()
    q_without = sql_count(lambda d: a.email_cal_plan(d, cyc_(d), D(1), D(30), NOW))
    db.execute("UPDATE email_own SET removed_at=NULL")
    db.commit()
    s.check("BATCHED: the series add a few reads to the plan, not one a day or a person (%d with it, %d without)" % (q_with, q_without), 0 <= q_with - q_without <= 8, (q_with, q_without))
    run(lambda d: a.email_skip_set(d, SU, key, D(14), "ZZ test: skip 14", now=NOW))
    p = plan()
    e14 = next(e for e in p["days"]["2026-11-14"] if e["key"] == key)
    s.check("a skip shows the day struck (state skipped, with its reason); the chip counts it", e14["state"] == "skipped" and e14["skip"]["reason"] == "ZZ test: skip 14" and p["counts"]["skipped"] >= 1)
    db.execute("DELETE FROM email_skips")
    db.commit()
    # a send shows the day sent, with its count
    W.clock(12, 9, 5)
    auto(datetime(2026, 11, 12, 9, 5))
    stamp_runs(12, 9)
    p = plan(now=datetime(2026, 11, 12, 10, 0))
    e12 = next(e for e in p["days"]["2026-11-12"] if e["key"] == key)
    s.check("a day it went on is sent, with what it queued; the days to come stay to go", e12["state"] == "sent" and e12["n"] == 1 and e12["runs"] and e12["runs"][0]["people_url"].startswith("/admin/list/email-own-run")
            and next(e for e in p["days"]["2026-11-14"] if e["key"] == key)["state"] == "to_go", e12)
    s.check("only= one series (what the 'goes again on' line asks) gives just that series", set(e["key"] for es in plan(only={key})["days"].values() for e in es) == {key})
    pg = plan(frm=D(12), to=D(12), now=datetime(2026, 11, 12, 10, 0), only={key})
    s.check("today after it went is not to go again (the record holds it)", [e["state"] for e in pg["days"]["2026-11-12"]] == ["sent"])
    code, pg = page("/admin/email?m=2026-11")
    s.check("the month: the Your own chip with its count, the legend entry, the outlined chip with ↻, + Add an email", code == 200 and "Your own <b>3</b>" in pg and "g-own" in pg and "↻ ZZ send" in pg and "+ Add an email" in pg
            and "Click a day to see its emails, skip one or add one." in pg)
    code, pn = page("/admin/list/email-day?day=2026-11-14&fragment=1")
    s.check("the day panel's card: the series' name, its tag, Who, How many, Sends, Preview, Edit the series, Skip this day, Remove the series",
            code == 200 and "ZZ send" in pn and "↻ Every 2 days, 12 – 16 Nov" in pn and "Line managers with something still waiting, " in pn and "Up to 4 if it went now" in pn
            and "2 of 3 still to come (Sat 14, Mon 16 Nov)" in pn and "Preview" in pn and "Edit the series" in pn and "Skip this day" in pn and "Remove the series" in pn,
            ([x for x in ("ZZ send", "\u21bb Every 2 days, 12 – 16 Nov", "Line managers with something still waiting, ", "Up to 4 if it went now", "2 of 3 still to come (Sat 14, Mon 16 Nov)", "Preview", "Edit the series", "Skip this day", "Remove the series") if x not in pn], re.findall(r"Sends</dt><dd>([^<]*)", pn)))
    s.check("...and Remove's own form carries the token too", re.search(r'action="/admin/email/own/remove".*?name="csrf_token" value="tok"', pn, re.S) is not None)
    s.check("Remove the series is red, double-confirmed: OneHR's box naming the series and its sends still to come, tone danger",
            'data-confirm-title="Remove ZZ send?"' in pn and "Its 2 sends still to come won't go. What was already sent stays in Email › Sent." in pn and 'data-confirm-tone="danger"' in pn)
    s.check("the foot gets '+ Add an email on <day>' from today on (it opens the Add panel with that day)", "<template data-list-foot>" in pn and "+ Add an email on Sat 14 Nov" in pn and "key=email-own" not in pn
            and "/admin/list/email-own?day=2026-11-14" in pn)
    code, pnp = page("/admin/list/email-day?day=2026-11-10&fragment=1")
    s.check("a day that has gone has no Add and no Skip", code == 200 and "+ Add an email" not in pnp and "Skip this day" not in pnp)
    code, pnt = page("/admin/list/email-day?day=2026-11-12&fragment=1")
    s.check("a day it went on lists what went with People >, and no Skip or Remove on it", code == 200 and "People ›" in pnt and "Sent</span>" in pnt and "Remove the series" not in pnt, pnt[:100])

    # ============================================================================================================== the add panel
    s.section("the Add an email panel and the Edit panel")
    code, ap = page("/admin/list/email-own?day=2026-11-14&fragment=1")
    s.check("the panel: kicker, title 'A new email from Sat 14 Nov', the sub line, three numbered steps, Start from, Preview, the footer's Cancel and Save the email",
            code == 200 and 'data-list-kicker="Email › Schedule · Add an email"' in ap and 'data-list-title="A new email from Sat 14 Nov"' in ap and "Goes out in waves like every mass email. Saved under “Your own emails”." in ap
            and all(x in ap for x in (">The words<", ">Who gets it<", ">When<", "Start from", ">Preview<", "Save the email", ">Cancel<")), ap[:200])
    s.check("Start from lists the rail's groups, the usual marked, Write new last", 'optgroup label="Cycle reviews"' in ap and "Everyone's reminder · Reminder · usual" in ap and 'optgroup label="Grade H Appraisal"' in ap
            and "BM / EN" in ap and "Write new · blank subject and words" in ap and 'optgroup label="Your own emails"' in ap)
    s.check("the roles are the seven, waiting is the default, Business groups All; the first day is the day opened on; time 09:00; Once", all(x in ap for x in (
        "Everyone taking part", "Line managers", ">HODs<", "BU CEOs", "BG CEOs", "Calibrators", "BG admins", "Only those with something still waiting", "All of them", "Pick some…")) and 'value="2026-11-14"' in ap)
    s.check("no field takes a person: nothing in the form is a user, person or employee id", not re.search(r'name="(user|person|employee|people|staff)', ap))
    s.check("the form carries its own CSRF token (a form added after load needs one), a data-confirm (OneHR's box) and posts to the one writer", 'name="csrf_token" value="tok"' in ap and "data-confirm=" in ap
            and 'action="/admin/email/own/save"' in ap)
    code, ep = page("/admin/list/email-own?id=%d&day=2026-11-12&fragment=1" % oid)
    s.check("Edit the series is the same form filled: its name, words, roles, days", code == 200 and 'value="ZZ send"' in ep and 'data-list-title="Edit “ZZ send”"' in ep and "Edit the series" in ep
            and re.search(r'name="role" value="lm" checked', ep) is not None and 'name="every_n"' in ep and 'value="2026-11-16"' in ep and "Keep this email's own words" in ep and "Save the changes" in ep)
    s.check("the panel's script guards the live line: only the latest request's answer is applied, the box says a neutral line and the blue line 'Counting…' until it arrives",
            "mine !== seq" in ap and "Counting" in ap and "function neutral()" in ap and "Save \\u201c" in ap)
    s.check("an id that is not a live series is a 404", sup.get("/admin/list/email-own?id=99999&fragment=1").status_code == 404)
    s.check("a day it can't read opens on today; a day out of range is a 404", sup.get("/admin/list/email-own?day=nonsense&fragment=1").status_code == 200
            and sup.get("/admin/list/email-own?day=1999-01-01&fragment=1").status_code == 404)
    r = sup.post("/admin/email/own/summary", data=dict(post_f(form(name="ZZ sum", role=["lm"], waiting="waiting")), csrf_token="tok"), headers={"X-Requested-With": "fetch"})
    js = j(r)
    s.check("the live line: 'Sends 3 times: Thu 12, Sat 14 and Mon 16 Nov at 09:00', who and how many (counts only), the box's words", r.status_code == 200 and js["ok"]
            and js["summary"].startswith("Sends **3 times**: Thu 12, Sat 14 and Mon 16 Nov at 09:00.") and "have something waiting today" in js["summary"] and "ZZ GP" not in js["summary"]
            and "line managers" in js["summary"] and js["confirm"].startswith("Send “ZZ sum” to Line managers with something still waiting, ") and "waves" in js["confirm"], js)
    r = sup.post("/admin/email/own/summary", data=dict(post_f(form(name="ZZ sum", repeat="days", until="")), csrf_token="tok"), headers={"X-Requested-With": "fetch"})
    js0 = j(r)
    s.check("Every N days with Until empty: no blue line (no send days), and the amber 'Give the last day (Until).' while she types", js0["summary"] == "" and "Give the last day (Until)." in js0["errors"]["when"], js0)
    s.check("...the strict save refuses it as before", not save(form(name="ZZ nountil", until=""))[0])
    r = sup.post("/admin/email/own/summary", data=dict(post_f(form(name="ZZ sum", repeat="once", until="")), csrf_token="tok"), headers={"X-Requested-With": "fetch"})
    s.check("a one-off needs no Until: its line is there", j(r)["summary"].startswith("Sends **1 time**"))
    r = sup.post("/admin/email/own/summary", data=dict(post_f(form(name="ZZ sum", opening="{count}", waiting="all")), csrf_token="tok"), headers={"X-Requested-With": "fetch"})
    js = j(r)
    s.check("the amber lines come from the same refusals: an unfillable placeholder, {tasks} with All", any("{count}" in x for x in js["errors"]["words"]) and any("{tasks}" in x for x in js["errors"]["words"]))
    r = sup.post("/admin/email/own/summary", data=dict(post_f(form(name="ZZ sum", user_id="1")), csrf_token="tok"))
    s.check("the summary route takes no person either", j(r)["ok"] is False and "never to named people" in j(r)["message"])
    r = sup.post("/admin/email/own/preview", data=dict(post_f(form(name="ZZ pv", subject="Hello {name}", opening="Your things: {tasks}")), csrf_token="tok"))
    pv = html.unescape(r.get_data(as_text=True))
    s.check("Preview is the email in the words typed, made-up items, addressed to the admin; nothing is stored or sent", r.status_code == 200 and "Hello " in pv and "2 things" in pv and "by Chin Hin" in pv
            and "ZZ GP" not in pv and n("email_own", "name='ZZ pv'") == 0)
    r = sup.post("/admin/email/own/preview", data=dict(post_f(form(user_id="1")), csrf_token="tok"))
    s.check("...and Preview takes no person", r.status_code == 400)

    # ============================================================================================================ edit and remove
    s.section("edit and remove")
    db.execute("DELETE FROM email_outbox")
    db.commit()
    sent_before = db.execute("SELECT * FROM email_own_sends WHERE own_id=?", (oid,)).fetchall()
    W.clock(13, 8, 0)
    ok, said, _o, errs = save(form(name="ZZ send", role=["lm", "hod"], waiting="waiting", first_day="2026-11-12", until="2026-11-18", every_n="2", at_time="09:30",
                                   subject="Edited subject {tasks}", opening="Edited opening", bg=[BG]), oid, datetime(2026, 11, 13, 8, 0))
    r_ = own_row(oid)
    s.check("an edit saves the series (roles, until, time) and the usual template's words, audited as email_own_edit", ok and json.loads(r_["roles"]) == ["lm", "hod"] and r_["until"] == "2026-11-18" and r_["at_time"] == "09:30"
            and json.loads(db.execute("SELECT words FROM email_templates WHERE email=? AND usual=1", (key,)).fetchone()[0])["subject"] == "Edited subject {tasks}"
            and n("activity_log", "action='email_own_edit'") == 1 and r_["updated_by"] == SU["id"], said)
    s.check("...a day already sent stays recorded as it was", [dict(x) for x in db.execute("SELECT * FROM email_own_sends WHERE own_id=?", (oid,))] == [dict(x) for x in sent_before] and "2026-11-12" in
            {x["day"] for x in sent_before})
    s.check("...the sends still to come follow the edit: 14, 16, 18 Nov at 09:30, and 12 Nov stays sent",
            [str(x) for x in a.email_own_days(r_, D(13), D(30))] == ["2026-11-14", "2026-11-16", "2026-11-18"] and run(lambda d: [x.isoformat() for x in a.email_own_to_come(d, cyc_(d), a.email_own_row(d, oid), datetime(2026, 11, 13, 8, 0))]) == ["2026-11-14", "2026-11-16", "2026-11-18"])
    ok, said, _o, errs = save(form(name="ZZ send", role=["lm"], first_day="2026-11-12", until="2026-11-18", every_n="2", at_time="09:30"), oid, datetime(2026, 11, 13, 8, 0))
    s.check("a first day that was not changed (the past, it has gone) does not stop an edit; moving it before today is refused", ok and not save(form(name="ZZ send", first_day="2026-11-11", until="2026-11-18"), oid, datetime(2026, 11, 13, 8, 0))[0])
    s.check("a removed or unknown series can't be edited", not save(form(name="ZZ send"), 99999)[0])
    # the edit panel and the calendar after an edit
    p = plan(now=datetime(2026, 11, 13, 8, 0))
    s.check("the calendar follows the edit", sorted(i for i, es in p["days"].items() for e in es if e["key"] == key and e["state"] == "to_go") == ["2026-11-14", "2026-11-16", "2026-11-18"])
    # remove
    s.check("Remove by a non-super is refused, nothing changes", not run(lambda d: a.email_own_remove(d, EMP, oid))[0] and own_row(oid)["removed_at"] is None)
    r = emp.post("/admin/email/own/remove", data={"csrf_token": "tok", "id": str(oid)})
    s.check("...and by an employee's POST", r.status_code in (302, 403) and own_row(oid)["removed_at"] is None)
    templates_before = n("email_templates", "email=?", (key,))
    r = sup.post("/admin/email/own/remove", data={"csrf_token": "tok", "id": str(oid), "next": "/admin/email"}, follow_redirects=True)
    msg = html.unescape(r.get_data(as_text=True))
    r_ = own_row(oid)
    s.check("Remove sets removed_* (the row stays), names the sends still to come and says what stays in Email › Sent; audited as email_own_remove",
            r_["removed_at"] and r_["removed_by"] == SU["id"] and "Removed “ZZ send”. Its 3 sends still to come won't go. What was already sent stays in Email › Sent." in msg
            and n("activity_log", "action='email_own_remove'") == 1)
    s.check("...its words stay (the template kept under Your own emails) and what went stays recorded", n("email_templates", "email=?", (key,)) == templates_before >= 1 and n("email_own_sends", "own_id=?", (oid,)) == 1)
    W.clock(14, 9, 30)
    say = auto(datetime(2026, 11, 14, 9, 30))
    s.check("a removed series sends nothing on its days to come", not outbox(oid, "queued") and n("email_own_sends", "own_id=?", (oid,)) == 1, say)
    p = plan(now=datetime(2026, 11, 14, 8, 0))
    s.check("...and leaves the calendar (its sent day stays: what went went)", [e["state"] for es in p["days"].values() for e in es if e["key"] == key] == ["sent"])
    s.check("a removed series can't be skipped, edited or removed again", not run(lambda d: a.email_skip_set(d, SU, key, D(16), "ZZ", now=datetime(2026, 11, 14, 8, 0)))[0]
            and not run(lambda d: a.email_own_remove(d, SU, oid))[0])
    code, ems = page("/admin/emails?email=%s" % key)
    s.check("Emails and templates still lists it, marked removed, with its words", code == 200 and "ZZ send (removed)" in ems and "Removed: it no longer goes out" in ems and 'value="{days_left}: {tasks} still to do"' in ems,
            [x for x in ("ZZ send (removed)", "Removed: it no longer goes out", 'value="{days_left}: {tasks} still to do"') if x not in ems])

    # ======================================================================================== Emails and templates, dated words
    s.section("Emails and templates: the group Your own emails, words for a day, Email > Sent's card")
    ok, said, o2, errs = save(form(name="ZZ words", role=["lm"], waiting="all", subject="Usual subject", opening="Usual opening", first_day="2026-11-16", until="2026-11-20", every_n="2"), None, datetime(2026, 11, 14, 8, 0))
    assert ok, said
    k2 = "own:%d" % o2
    code, ems = page("/admin/emails")
    s.check("the rail has the group 'Your own emails' with each live one (and its usual template)", code == 200 and 'Your own emails</div>' in ems and "ZZ words" in ems and "Usual words" in ems)
    code, ems = page("/admin/emails?email=%s" % k2)
    s.check("an own template opens in the editor with its six placeholders ({name}, not {display_name}) and no 'display_name' note",
            code == 200 and 'data-ph="{tasks}"' in ems and 'data-ph="{display_name}"' not in ems and "{name} is the name they chose" in ems and 'value="Usual subject"' in ems)
    tid = db.execute("SELECT id FROM email_templates WHERE email=? AND usual=1", (k2,)).fetchone()[0]
    rpv = sup.get("/admin/emails/preview?tid=%d" % tid)
    bpv = html.unescape(rpv.get_data(as_text=True))
    s.check("the day panel's Preview (the template's own preview) shows an own email: its subject and brand, made-up items, addressed to the admin", rpv.status_code == 200 and "Subject:" in bpv and "Usual subject" in bpv
            and "by Chin Hin" in bpv and "ZZ GP" not in bpv)
    r = post(sup, "/admin/emails", {"action": "save", "email": k2, "tid": str(tid), "name": "Usual words", "subject": "Usual subject {count}", "heading": "H", "greeting": "Hi {name},", "button": "Go"})
    s.check("saving an own template refuses a placeholder it can't fill, as every template does", "which OneHR doesn&#39;t fill in" in r.get_data(as_text=True) or n("email_templates", "email=? AND words LIKE '%{count}%'", (k2,)) == 0)
    r = post(sup, "/admin/emails", {"action": "save", "email": "own", "tid": str(tid), "name": "x"})
    s.check("the shared spec 'own' is no email to post to", r.status_code == 400)
    ok, said, dtid = run(lambda d: a.email_day_words(d, SU, k2, D(18)))
    s.check("Words for this day work for an own email (a copy dated that one day, named from the series' words)", ok and dtid and db.execute("SELECT date_from, date_to, usual FROM email_templates WHERE id=?", (dtid,)).fetchone()[:] == ("2026-11-18", "2026-11-18", 0), said)
    db.execute("UPDATE email_templates SET words=? WHERE id=?", (json.dumps(dict(json.loads(db.execute("SELECT words FROM email_templates WHERE id=?", (dtid,)).fetchone()[0]), subject="Dated subject for the 18th")), dtid))
    db.commit()
    s.check("email_tpl_words('own:<id>', day) reads the dated words that day and the usual ones another day", run(lambda d: a.email_tpl_words(k2, day=D(18), db=d))["subject"] == "Dated subject for the 18th"
            and run(lambda d: a.email_tpl_words(k2, day=D(16), db=d))["subject"] == "Usual subject")
    W.clock(18, 9, 0)
    W.rem_settings(days=(2, 1))
    say = auto(datetime(2026, 11, 18, 9, 0))
    s.check("...and the send of that day uses the dated words (the series' every-2-days: 16, 18, 20)", {o["subject"] for o in outbox(o2)} == {"Dated subject for the 18th"} and len(outbox(o2)) == 4, say)
    code, st = page("/admin/email/sent")
    s.check("Email › Sent has the card 'Your own emails': each send with its people, emailed and no email counts, and People ›", code == 200 and 'id="sent-own"' in st and "Your own emails" in st and "ZZ words" in st and "People" in st)
    rid_ = db.execute("SELECT id FROM activity_log WHERE action='email_own_run' ORDER BY id DESC LIMIT 1").fetchone()[0]
    code, pp = page("/admin/list/email-own-run?run=%d&fragment=1" % rid_)
    s.check("its People > panel lists that send's people with their address and status (the super admin's panel)", code == 200 and "Email › Sent · Your own emails" in pp and "@zzgm.example" in pp and ("Waiting" in pp or "Sent" in pp), pp[:200])
    s.check("an unknown run is a 404", sup.get("/admin/list/email-own-run?run=999999&fragment=1").status_code == 404)

    s.section("the job itself: send_reminders.py --auto gives each own email its turn, even on a day Everyone's reminder does not go")
    import importlib.util
    import io
    from contextlib import redirect_stdout
    spec = importlib.util.spec_from_file_location("send_reminders_own", os.path.join(H.REPO, "send_reminders.py"))
    sr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sr)
    src = open(os.path.join(H.REPO, "send_reminders.py"), encoding="utf-8").read()
    s.check("the job calls email_own_auto before Everyone's reminder's early return, and a failure in it is logged and the run goes on", "appmod.email_own_auto(db, cyc)" in src
            and src.index("appmod.email_own_auto") < src.index("if not plan[\"regular\"] and not plan[\"staff\"]") and "Your own emails' turn failed" in src)
    ok, said, o_job, errs = save(form(name="ZZ job", role=["lm"], waiting="all", subject="Job", opening="Hello.", first_day="2026-11-19", repeat="once", until=None), None, datetime(2026, 11, 14, 8, 0))
    assert ok, said
    W.rem_settings(days=(2, 1), enabled=False)
    W.setting("gradeh_reminders_enabled", "0")   # keep this run to the own email
    W.clock(19, 9, 5)

    def job():
        out = io.StringIO()
        sys.argv = ["send_reminders.py", "--auto"]
        with redirect_stdout(out):
            sr.main()
        return out.getvalue()
    out = job()
    s.check("--auto queues the own email (4 line managers) and says so, with Everyone's reminder off that day", len(outbox(o_job, "queued")) == 4 and "ZZ job: 4 emails queued" in out, out[-400:])
    out = job()
    s.check("...a second run (15 minutes on) says it already went and queues nothing more", len(outbox(o_job)) == 4 and "ZZ job: already sent today." in out, out[-300:])
    reset_sends()
    db.execute("DELETE FROM email_own WHERE id=?", (o_job,))
    db.execute("DELETE FROM email_templates WHERE email=?", ("own:%d" % o_job,))
    db.commit()
    W.setting("gradeh_reminders_enabled", "1")
    W.clock(18, 9, 0)

    s.section("the bar, Sent's reasons and a BG admin's recheck")
    s.check("the mass-send bar names an own email's batch as she named it, and counts what was dropped before its wave",
            run(lambda d: a._outbox_send(d, "own-%d-2026-11-18" % o2))["label"] == "Your own email: ZZ words"
            and a._es_why(a.OWN_REMOVED) == "Removed before it went" and a._es_why(a.OWN_SKIPPED_SINCE) == "Skipped before it went")
    aid = db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, admin_bg, email) VALUES ('zzownadmx', 'ZZ Own Admin X', 'x', 'admin', 'ZZOWN-ADMX', ?, NULL)", (BG,)).lastrowid
    db.execute("INSERT INTO admin_notify_emails(user_id, email) VALUES (?, 'zzown.x@example.test')", (aid,))
    db.commit()
    ok, said, o3, errs = save(form(name="ZZ bga send", role=["bgadmin"], waiting="all", subject="BG admins", opening="Hello.", first_day="2026-11-18", repeat="once", until=None, at_time="15:00"),
                              None, datetime(2026, 11, 18, 8, 0))
    assert ok, said
    ok4, w4, _t4 = run(lambda d: a.email_own_send(d, cyc_(d), a.email_own_row(d, o3), D(18)))
    brow = next(r for r in outbox(o3) if r["to_email"] == "zzown.x@example.test")
    s.check("a BG admin's email is queued to their notification address, with their admin id", ok4 and brow["user_id"] == aid and brow["to_email"] == "zzown.x@example.test", w4)
    s.check("its recheck: still their address, the row stays", run(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (brow["id"],)).fetchone())) is not None)
    db.execute("DELETE FROM admin_notify_emails WHERE email='zzown.x@example.test'")
    db.commit()
    got = run(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (brow["id"],)).fetchone()))
    s.check("...and once the address is off their account it is dropped, not sent", got is None and db.execute("SELECT status FROM email_outbox WHERE id=?", (brow["id"],)).fetchone()[0] == "cancelled")
    # the recheck applies the SAME opt-out rule as email_own_recipients: a BG admin has none, a person's Everyone's-reminder opt-out drops them
    db.execute("INSERT INTO admin_notify_emails(user_id, email) VALUES (?, 'zzown.x@example.test')", (aid,))
    db.commit()
    reset_sends()
    ok5, w5, _t5 = run(lambda d: a.email_own_send(d, cyc_(d), a.email_own_row(d, o3), D(18)))
    brow = next(r for r in outbox(o3) if r["to_email"] == "zzown.x@example.test")
    db.execute("INSERT INTO email_optouts(user_id, kind, until, reason, set_by) VALUES (?, 'reminder', NULL, 'ZZ test', NULL)", (aid,))
    db.commit()
    recheck_row = lambda r: run(lambda d: a._outbox_reminder_recheck(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (r["id"],)).fetchone()))   # noqa: E731
    s.check("a BG admin with an Everyone's reminder opt-out row is queued (they have neither opt-out) and NOT dropped at their wave", ok5 and brow["status"] == "queued" and recheck_row(brow) is not None
            and db.execute("SELECT status FROM email_outbox WHERE id=?", (brow["id"],)).fetchone()[0] == "queued", w5)
    s.check("(and the old rule would have dropped them: _outbox_optout_drop alone cancels that row)", run(lambda d: a._outbox_optout_drop(d, d.execute("SELECT * FROM email_outbox WHERE id=?", (brow["id"],)).fetchone(), "reminder", a.OWN_KIND)))
    db.execute("UPDATE email_outbox SET status='queued', error=NULL WHERE id=?", (brow["id"],))
    db.execute("DELETE FROM email_optouts")
    db.commit()
    ok6, said6, o_ev, errs6 = save(form(name="ZZ everyone recheck", role=["everyone"], waiting="all", subject="Everyone", opening="Hello.", first_day="2026-11-18", repeat="once", until=None, at_time="16:00"),
                                   None, datetime(2026, 11, 18, 8, 0))
    assert ok6, said6
    run(lambda d: a.email_own_send(d, cyc_(d), a.email_own_row(d, o_ev), D(18)))
    xrow = next(r for r in outbox(o_ev) if r["user_id"] == U["X1"])
    s.check("an everyone-role person: still qualifying, their row is kept", recheck_row(xrow) is not None)
    db.execute("UPDATE email_outbox SET status='queued', error=NULL WHERE id=?", (xrow["id"],))
    W.optout("X1", "reminder")
    s.check("...and one who opts out AFTER it was queued is dropped at their wave ('opted out when its wave came')", recheck_row(xrow) is None
            and db.execute("SELECT error FROM email_outbox WHERE id=?", (xrow["id"],)).fetchone()[0] == a.REMINDER_OPTED_OUT)
    db.execute("UPDATE email_outbox SET status='queued', error=NULL WHERE id=?", (xrow["id"],))
    db.execute("DELETE FROM email_optouts")
    db.commit()

    def unreadable(d, k):
        raise RuntimeError("locked")
    with Patch("email_optout_ids", unreadable):
        s.check("an opt-out that can't be read still fails closed for a person (not sent on a guess), but not for a BG admin", recheck_row(xrow) is None
                and db.execute("SELECT error FROM email_outbox WHERE id=?", (xrow["id"],)).fetchone()[0] == a.REMINDER_OPTOUT_UNREAD)
    reset_sends()
    db.execute("DELETE FROM users WHERE id=?", (aid,))
    db.commit()

    # ===================================================================================================== no GET writes, access
    s.section("no GET writes; the access map")
    snap = snapshot_tables()
    for url in ("/admin/email?m=2026-11", "/admin/email?m=2026-12&show=own", "/admin/emails", "/admin/emails?email=%s" % k2, "/admin/email/sent", "/admin/list/email-own?day=2026-11-20&fragment=1",
                "/admin/list/email-own?id=%d&fragment=1" % o2, "/admin/list/email-day?day=2026-11-18&fragment=1", "/admin/list/email-day?day=2026-11-19&fragment=1",
                "/admin/email/own/words?tid=%d" % tid):
        sup.get(url)
    s.check("no page, panel or word list writes a thing", snapshot_tables() == snap, {k: (snap[k], snapshot_tables()[k]) for k in snap if snap[k] != snapshot_tables()[k]})
    kept = H.stash_email_templates(db)   # a database no one has opened Emails and templates on: no template exists anywhere
    snap3 = snapshot_tables()
    r = sup.get("/admin/list/email-own?day=2026-11-20&fragment=1")
    body3 = html.unescape(r.get_data(as_text=True))
    rw = sup.get("/admin/email/own/words?tid=kind:reminder")
    s.check("with no template anywhere the panel still lists every email to start from (its words of today), and neither it nor a copy writes anything",
            r.status_code == 200 and 'value="kind:reminder"' in body3 and "Everyone's reminder · Reminder · usual" in body3 and rw.status_code == 200 and j(rw)["words"]["subject"] == run(lambda d: a._email_tpl_legacy("reminder"))["subject"]
            and snapshot_tables() == snap3)
    H.restore_email_templates(db, kept)
    s.check("a day that has gone opens the Add panel on today (an email can't start in the past)", 'value="2026-11-18"' in html.unescape(sup.get("/admin/list/email-own?day=2026-11-01&fragment=1").get_data(as_text=True)))
    for url in ("/admin/list/email-own?day=2026-11-20&fragment=1", "/admin/email/own/words?tid=%d" % tid):
        r1 = bga.get(url) if bga else None
        s.check("a BG admin can't open %s (the super admin's)" % url.split("?")[0], r1 is None or r1.status_code in (302, 403))
        s.check("an employee can't open %s" % url.split("?")[0], emp.get(url).status_code in (302, 403))
finally:
    a.mailer.is_configured, a._outbox_kick, a.email_wave_rules = _real
    try:
        clear_own()
        db.execute("DELETE FROM org_units WHERE business_group='ZZGM Other Group'")
        db.execute("DELETE FROM email_optouts")
        db.execute("DELETE FROM app_settings WHERE key=?", (a.CHAIR_SETTING_ID,))
        db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZGM-KEEPREP%' OR employee_id IN ('ZZGM-NOPART','ZZGM-NOPARTREP','ZZGM-OUTREP')")
        db.commit()
        W.restore()
    finally:
        if _ENV0 is None:
            os.environ.pop("ONEHR_GRADEH", None)
        else:
            os.environ["ONEHR_GRADEH"] = _ENV0
sys.exit(s.done())
