"""Email in the left menu (Chris, 2026-10-24: "merge reminder and email into email, and place them as a menu item on the
left panel, put them under all settings and before ticketing, since this email eventually will serve all modules at any
time (including learning)"; canvas [design canvas link removed], "A is good").

What this suite holds:
  * the menu: Email sits between All settings and Ticketing, with Schedule, Emails and templates and Sent; Cycle no
    longer has Reminders or Emails tabs; Email's pages read with the Cycle's read
  * Schedule: every send day of everyone's reminder from the calendar and the rules (email_plan): the day a part opens
    on its own line, a repeat folded into one line, the day a part closes said of that day; each day's template, a
    dated one marked; the switch is the super admin's, on or off with every rule kept, never on with no rule
  * Everyone's reminder in sentences: the repeat, "until each part closes" clearing any dates, a saved day before
    closing that isn't one of the choices kept, the test of today's template, and what it would send
  * Emails and templates: the list and the editor beside it, one Save for the name, the words and when it's used, a
    date refused before any word is saved, dates over in the past left alone when only the words change; the older
    editor address and the older panel address land on the editor
  * the previews: one person's reminder in the words being typed, a day's template with made-up parts
  * Sent: the waves and the runs, and the waves' save comes back to it
Everything here is put back at the end.
"""
import html
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Email: Schedule, Everyone's reminder in sentences, Emails and templates, Sent")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
sup = H.client_as(a, SU["id"])
bga = H.client_as(a, BGA["id"]) if BGA else None
KEYS = ("reminder_auto_enabled", "reminder_days_before", "reminder_send_time", "reminder_on_open", "reminder_every_days",
        "reminder_every_from", "reminder_every_to", "reminder_template", "reminder_all_subject", "reminder_all_opening")
with a.app.app_context():
    db = a.get_db()
    CID = db.execute("SELECT id FROM cycles WHERE is_active=1").fetchone()[0]
    SAVED = {k: db.execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone() for k in KEYS}
    WIN = [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows WHERE cycle_id=?",
                                        (CID,))]
    MODS = [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=?",
                                         (CID,))]
    TPLS = H.stash_email_templates(db)
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    NOTE0 = db.execute("SELECT COALESCE(MAX(id),0) FROM notifications").fetchone()[0]
_sent = []
_real = (a.mailer.send_mail, a.mailer.config_status)


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def text(r):
    return html.unescape(r.get_data(as_text=True))


def rules():
    return ctx(lambda d: a.reminder_rules())


def set_rules(enabled=True, on_open=True, days=(0,), every=1, at="08:00", f=None, t=None):
    ctx(lambda d: a.set_reminder_rules(enabled, on_open, list(days), every, at, f, t))


def tpl(tid):
    return ctx(lambda d: d.execute("SELECT * FROM email_templates WHERE id=?", (tid,)).fetchone())


def post_em(data, client=None, follow=True):
    return (client or sup).post("/admin/emails", data=dict(data, csrf_token="tok"), follow_redirects=follow)


def post_rm(data, client=None, follow=True):
    return (client or sup).post("/admin/reminders", data=dict(data, csrf_token="tok"), follow_redirects=follow)


try:
    today = ctx(lambda d: a._today_myt())
    T = lambda n: today + timedelta(days=n)   # noqa: E731
    DAY = lambda n: ctx(lambda d: a._em_day(T(n)))   # noqa: E731
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        d.executemany("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", [
            (CID, "pm_results", "%s 00:00" % T(2).isoformat(), "%s 23:59" % T(8).isoformat()),
            (CID, "pm_approve", "%s 00:00" % T(9).isoformat(), "%s 23:59" % T(15).isoformat())])
        d.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='pm'", (CID,))   # no row = on
        d.commit()
    set_rules()
    a.mailer.send_mail = lambda to, subject, body, **kw: _sent.append((to, subject, body))
    a.mailer.config_status = lambda: {"configured": True}

    # -----------------------------------------------------------------------
    s.section("the menu: Email between All settings and Ticketing")
    keys = [x["key"] for x in a.ADMIN_SECTIONS]
    # Notices (the release window, 2026-10-26) sits between Email and Ticketing
    s.check("Email sits after All settings, then Notices, then Ticketing", keys.index("settings") + 1 == keys.index("email")
            == keys.index("notices") - 1 == keys.index("ticketing") - 2, keys)
    em = a.ADMIN_SECTION_BY_KEY["email"]
    s.check("...its tabs: Schedule, Emails and templates, Sent", [t_["label"] for t_ in em["tabs"]] ==
            ["Schedule", "Emails and templates", "Sent"])
    s.check("...Everyone's reminder and Leader progress live under Schedule, hidden", all(
        any(p_["ep"] == ep and p_.get("hidden") and p_.get("under") == "admin_email_schedule"
            for p_ in em["tabs"][0]["pages"]) for ep in ("admin_reminders", "admin_reminders_leaders")))
    s.check("Cycle has no Reminders or Emails tab any more", not any(
        t_["key"] in ("reminders", "emails") for t_ in a.ADMIN_SECTION_BY_KEY["cycle"]["tabs"]))
    s.check("Email is in no module: every page of it is the super admin's (Chris, 2026-10-24)",
            "email" not in a._ACCESS_SECTION_MODULE and all(
                a.ADMIN_ACCESS_MAP.get(ep) == "super" for ep in ("admin_reminders", "admin_reminders_leaders",
                                                                  "admin_reminders_preview", "admin_emails"))
            and not any(it[1] == "cycle.remind" for it in a.ADMIN_ITEMS))
    r = sup.get("/admin/email")
    b = text(r)
    s.check("Schedule opens, with the switch, the next send and its tabs", r.status_code == 200
            and "On their own schedule" in b and 'role="switch"' in r.get_data(as_text=True) and 'href="/admin/emails"' in b and 'href="/admin/email/sent"' in b
            and re.search(r'class="adm-fly-row is-active"[^>]*>\s*<span class="adm-fly-t">\s*<span class="adm-fly-lbl">Email</span>', r.get_data(as_text=True)))

    # -----------------------------------------------------------------------
    s.section("Schedule: every send day, from the calendar and the rules")
    plan = ctx(lambda d: a.email_plan(d, a.active_cycle(d)))
    shape = [(p_["kind"], (p_["frm"] - today).days, (p_["to"] - today).days) for p_ in plan]
    s.check("the day it opens, every day after it folded, the day it closes; then the line managers' the same",
            shape == [("open", 2, 2), ("every", 3, 7), ("close", 8, 8), ("open", 9, 9), ("every", 10, 14),
                      ("close", 15, 15)], shape)
    s.check("...the opening day names who it opens for", plan[0]["who"] == "Employees"
            and plan[3]["who"] == "Line managers" and plan[0]["words"].endswith("opens"))
    s.check("...the closing day is said of that day, not of today", "closes that day" in plan[2]["words"]
            and "today" not in plan[2]["words"], plan[2]["words"])
    s.check("...a repeat line reads as one run of days", plan[1]["day"] == ctx(
        lambda d: a._email_span(T(3), T(7))) and "–" in plan[1]["day"], plan[1]["day"])
    # the calendar (2026-11-09, replacing the day list): each send day of the plan is a day of the month with a Reminder chip on it, and its panel says who
    def cell(n, key="reminder", extra=""):
        pg = text(sup.get("/admin/email?m=%s%s" % (T(n).strftime("%Y-%m"), extra)))
        m_ = re.search(r'data-day="%s".*?</a>' % T(n).isoformat(), pg, re.S)
        return m_.group(0) if m_ else ""
    s.check("the page draws them: each send day of the plan (the opening day, a repeat day, the closing day) has a Reminder chip on the calendar",
            all('data-key="reminder"' in cell(n) for n in (2, 5, 8, 9, 12, 15)), [n for n in (2, 5, 8, 9, 12, 15) if 'data-key="reminder"' not in cell(n)])
    pn = text(sup.get("/admin/list/email-day?day=%s&fragment=1" % T(2).isoformat()))
    s.check("...and the day's panel names who it opens for and says what", "<dt>Who</dt><dd>Employees" in pn and "opens" in pn, pn[:200])
    # a dated template on the opening day: the go-live announcement
    post_em({"action": "new", "email": "reminder", "name": "ZZEP Go-live"})
    GO = H.one(a, "SELECT id FROM email_templates WHERE email='reminder' AND name='ZZEP Go-live' AND retired_at IS NULL")
    post_em({"action": "when", "email": "reminder", "tid": GO, "mode": "dates", "date_from": T(2).isoformat(),
             "date_to": T(2).isoformat()})
    plan = ctx(lambda d: a.email_plan(d, a.active_cycle(d)))
    s.check("each day names its template, a dated one marked", plan[0]["tpl"] == "ZZEP Go-live" and plan[0]["dated"]
            and plan[1]["tpl"] != "ZZEP Go-live" and not plan[1]["dated"], [(p_["tpl"], p_["dated"]) for p_ in plan[:2]])
    pn = text(sup.get("/admin/list/email-day?day=%s&fragment=1" % T(2).isoformat()))
    s.check("...as the day's panel shows it", '<span class="eml-tpl is-dated">ZZEP Go-live</span>' in pn)

    # the switch
    r = post_rm({"action": "auto", "enabled": "off"}, follow=False)
    s.check("the switch turns it off, every rule kept", not rules()["enabled"] and rules()["on_open"]
            and rules()["every_days"] == 1 and rules()["days_before"] == [0]
            and r.headers["Location"].endswith("/admin/email"))
    b = text(sup.get("/admin/email?m=%s" % T(2).strftime("%Y-%m")))
    s.check("...the page says so, and still draws the days it would go (grey: 'off')", "Off · nothing goes on its own" in b
            and "its days show grey" in b and "ecal-ev is-off" in cell(2), cell(2)[:200])
    post_rm({"action": "auto", "enabled": "on"})
    s.check("...and back on", rules()["enabled"] and H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='reminder_schedule' AND detail LIKE "
           "'%from Email › Schedule%'", (LOG0,)) == 2)
    set_rules(enabled=False, on_open=False, days=(), every=0)
    b = text(post_rm({"action": "auto", "enabled": "on"}))
    s.check("it won't switch on with no rule to send by", not rules()["enabled"] and "Set when it goes first" in b)
    set_rules()
    if bga:
        paths = ("/admin/email", "/admin/email/sent", "/admin/reminders", "/admin/reminders/leaders", "/admin/emails",
                 "/admin/reminders/waiting.json", "/admin/reminders/people.json?q=zz", "/admin/reminders/preview?day="
                 + T(2).isoformat())
        got = {p_: bga.get(p_).status_code for p_ in paths}
        s.check("a BG admin opens no Email page (Chris, 2026-10-24: \"Super admin only\")",
                all(v == 403 for v in got.values()), got)
        s.check("...has no Email in their menu", not ctx(lambda d: any(a._admin_nav_allowed(p_, dict(BGA)) for t_ in
                                                                       em["tabs"] for p_ in t_["pages"])))
        s.check("...and can't switch it", post_rm({"action": "auto", "enabled": "off"}, bga, follow=False)
                .status_code == 403 and rules()["enabled"])
        from flask import template_rendered
        hrefs = []

        def _keep(sender, template, context, **kw):
            if template.name in ("admin_module_progress.html", "admin_calibration_locks.html"):
                hrefs.append(context.get("remind_href"))
        template_rendered.connect(_keep, a.app)
        try:
            for c_ in (sup, bga):
                c_.get("/admin/module/pm/progress")
                c_.get("/admin/calibration/locks")
        finally:
            template_rendered.disconnect(_keep, a.app)
        s.check("...nor offered Remind on a module's progress or the lock status, which the super admin is",
                len(hrefs) == 4 and sorted(bool(h) for h in hrefs) == [False, False, True, True], hrefs)

    # -----------------------------------------------------------------------
    s.section("Everyone's reminder, set up in sentences")
    b = text(sup.get("/admin/reminders"))
    s.check("the four sentences, with the repeat picked and the closing day ticked",
            re.search(r'<option value="1" selected>every day</option>', b) is not None
            and 'name="until"' in b and 'name="send_time" value="08:00"' in b
            and re.search(r'name="day_before" value="0" checked', b) is not None
            and re.search(r'name="day_before" value="1" >', b) is not None)
    s.check("...the templates it uses, and what it sends", "ZZEP Go-live" in b and "What this sends" in b
            and DAY(2) in b and "Edit in Emails and templates" in b)
    set_rules(days=(5, 0))
    b = text(sup.get("/admin/reminders"))
    s.check("a saved day before closing that isn't one of the choices is kept", 'type="hidden" name="day_before" value="5"'
            in b and "and 5 days before, kept as saved" in b)
    base = {"action": "save_schedule", "enabled": "on", "on_open": "on", "every_days": "1", "send_time": "08:00",
            "day_before": ["0"]}
    post_rm(dict(base, until="date", range_from=T(3).isoformat(), range_to=T(6).isoformat()))
    s.check("“dates I pick” keeps the dates", (rules()["every_from"], rules()["every_to"]) ==
            (T(3).isoformat(), T(6).isoformat()), (rules()["every_from"], rules()["every_to"]))
    post_rm(dict(base, until="close", range_from=T(3).isoformat(), range_to=T(6).isoformat()))
    s.check("“until each part closes” clears them, whatever the hidden fields held",
            rules()["every_from"] is None and rules()["every_to"] is None and rules()["every_days"] == 1)
    post_rm(dict(base, every_days="0"))
    s.check("“not again” saves no repeat", rules()["every_days"] == 0 and rules()["days_before"] == [0])
    set_rules()
    _sent.clear()
    b = text(post_rm({"action": "test_sample", "test_to": "me@zzep.invalid"}))
    s.check("Send me a test: today's template, made-up parts, to the admin, [Test] first", len(_sent) == 1
            and _sent[0][0] == "me@zzep.invalid" and _sent[0][1].startswith("[Test] ") and "Test sent to" in b,
            [x[:2] for x in _sent])
    if bga:
        s.check("...the super admin's only", post_rm({"action": "test_sample", "test_to": "x@zzep.invalid"}, bga,
                                                     follow=False).status_code == 403)

    # -----------------------------------------------------------------------
    s.section("Emails and templates: the list, and the editor beside it")
    U0 = H.one(a, "SELECT id FROM email_templates WHERE email='reminder' AND usual=1 AND retired_at IS NULL")
    b = text(sup.get("/admin/emails?email=reminder"))
    s.check("an email opens at the template it uses today", re.search(r'<h2 id="eml-ed-h">%s ' % re.escape(
        tpl(U0)["name"]), b) is not None and 'aria-current="page"' in b)
    LPB = H.one(a, "SELECT id FROM email_templates WHERE email='lp_buceo' AND usual=1 AND retired_at IS NULL")
    b = text(sup.get("/admin/emails?panel=email-lp_buceo"))
    s.check("...the older panel address lands on that email's", 'name="tid" value="%d"' % LPB in b)
    r = sup.get("/admin/emails/template?id=%d" % GO)
    s.check("the older editor address goes to the editor", r.status_code == 302
            and r.headers["Location"].endswith("/admin/emails?tid=%d" % GO))
    words0 = ctx(lambda d: a.email_tpl_saved(tpl(GO)))
    r = post_em({"action": "save", "email": "reminder", "tid": GO, "name": "ZZEP Go-live", "mode": "dates",
                 "date_from": T(4).isoformat(), "date_to": T(2).isoformat(), "subject": "ZZEP changed {count}"})
    s.check("a last day before the first is refused before any word is saved", "The last day comes before the first."
            in text(r) and ctx(lambda d: a.email_tpl_saved(tpl(GO)))["subject"] == words0["subject"]
            and tpl(GO)["date_from"] == T(2).isoformat())
    r = post_em({"action": "save", "email": "reminder", "tid": GO, "name": "ZZEP Go-live day", "mode": "dates",
                 "date_from": T(2).isoformat(), "date_to": T(3).isoformat(), "subject": "ZZEP go-live {count}"},
                follow=False)
    g = tpl(GO)
    s.check("one Save: the name, the words and the days together", g["name"] == "ZZEP Go-live day"
            and ctx(lambda d: a.email_tpl_saved(g))["subject"] == "ZZEP go-live {count}"
            and (g["date_from"], g["date_to"]) == (T(2).isoformat(), T(3).isoformat())
            and r.headers["Location"].endswith("/admin/emails?tid=%d" % GO))
    s.check("...each written to the audit log", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='email_template' AND (detail LIKE "
           "'%changed Name, Subject%' OR detail LIKE '%is used on%')", (LOG0,)) >= 2)
    b = text(post_em({"action": "save", "email": "reminder", "tid": GO, "name": "ZZEP Go-live day", "mode": "dates",
                      "date_from": T(2).isoformat(), "date_to": T(3).isoformat(), "subject": "ZZEP go-live {count}"}))
    s.check("a Save that changes nothing says so", "Nothing had changed." in b)
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE email_templates SET date_from=?, date_to=? WHERE id=?", (T(-5).isoformat(), T(-4).isoformat(),
                                                                                   GO))
        d.commit()
    post_em({"action": "save", "email": "reminder", "tid": GO, "name": "ZZEP Go-live day", "mode": "dates",
             "date_from": T(-5).isoformat(), "date_to": T(-4).isoformat(), "subject": "ZZEP over {count}"})
    s.check("days already over stay as they are when only the words change", ctx(
        lambda d: a.email_tpl_saved(tpl(GO)))["subject"] == "ZZEP over {count}" and tpl(GO)["date_from"]
        == T(-5).isoformat())
    post_em({"action": "save", "email": "reminder", "tid": GO, "name": "ZZEP Go-live day", "mode": "none"})
    s.check("Not in use from the same Save takes the dates away", tpl(GO)["date_from"] is None)
    post_em({"action": "save", "email": "reminder", "tid": GO, "name": "ZZEP Go-live day", "mode": "dates",
             "date_from": T(2).isoformat(), "date_to": T(2).isoformat(), "subject": "ZZEP go-live {count}"})
    b = text(post_em({"action": "save", "email": "reminder", "tid": U0, "name": tpl(U0)["name"], "mode": "dates",
                      "date_from": T(20).isoformat(), "date_to": T(20).isoformat()}))
    s.check("the usual one still can't be given dates", "is the usual one" in b and tpl(U0)["usual"] == 1
            and tpl(U0)["date_from"] is None)

    # -----------------------------------------------------------------------
    s.section("the previews")
    r = sup.get("/admin/reminders/preview?day=%s" % T(2).isoformat())
    s.check("a day's template, made-up parts, addressed to the admin", "Subject:</b> ZZEP go-live 3" in r.get_data(
        as_text=True))
    r = sup.get("/admin/reminders/preview?day=%s" % T(5).isoformat())
    s.check("...another day's, the usual one", "ZZEP go-live" not in r.get_data(as_text=True))
    # a synthetic persona, never a real person (the local database holds real names: no body is printed here)
    eid = H.one(a, "SELECT employee_id FROM users WHERE employee_id LIKE 'ZZPMDEMO-%' AND role!='admin' "
                   "AND left_at IS NULL ORDER BY id LIMIT 1")
    r = sup.post("/admin/emails/preview", data={"csrf_token": "tok", "tid": GO, "eid": eid, "subject": "ZZEP typed"})
    b = text(r)
    s.check("Preview as one person: their own reminder, or that nothing waits on them now", bool(eid)
            and r.status_code == 200 and ("Subject:</b> ZZEP typed" in b or "Nothing is waiting on" in b))
    r = sup.post("/admin/emails/preview", data={"csrf_token": "tok", "tid": GO, "eid": "ZZEP-NOBODY"})
    s.check("...nobody by that Employee ID", "No one with that Employee ID." in text(r))
    r = sup.post("/admin/emails/preview", data={"csrf_token": "tok", "tid": LPB, "eid": eid,
                                                "subject": "ZZEP lp {scope}"})
    s.check("...an email other than the reminder previews with made-up parts", "Subject:</b> ZZEP lp" in text(r))

    # -----------------------------------------------------------------------
    s.section("Sent: the waves and the runs")
    r = sup.get("/admin/email/sent")
    b = text(r)
    s.check("Sent opens with the waves and both emails' runs", r.status_code == 200 and "Mass emails go out in waves"
            in b and "<h2 id=\"eml-sent-h\">Everyone's reminder</h2>" in b and "Leader progress</h2>" in b
            and 'action="/admin/reminders"' in b)
    w0 = ctx(lambda d: a.email_wave_rules())
    r = post_rm({"action": "save_waves", "wave_on": "1" if w0["on"] else "", "wave_size": str(w0["size"]),
                 "wave_gap": str(w0["gap"])}, follow=False)
    s.check("...the waves' Save comes back to it", r.headers["Location"].endswith("/admin/email/sent#waves"))
finally:
    a.mailer.send_mail, a.mailer.config_status = _real
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        d.executemany("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", WIN)
        d.execute("DELETE FROM cycle_modules WHERE cycle_id=?", (CID,))
        d.executemany("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", MODS)
        for k, v in SAVED.items():
            d.execute("DELETE FROM app_settings WHERE key=?", (k,))
            if v is not None:
                d.execute("INSERT INTO app_settings(key,value) VALUES (?,?)", (k, v[0]))
        H.restore_email_templates(d, TPLS)
        d.execute("DELETE FROM activity_log WHERE id>? AND action IN ('reminder_schedule', 'email_template', "
                  "'email_waves')", (LOG0,))
        d.execute("DELETE FROM notifications WHERE id>? AND to_email LIKE '%@zzep.invalid'", (NOTE0,))
        d.commit()

sys.exit(s.done())
