"""OneHR's emails (Chris, 2026-10-17, canvas "OneHR Reminders and Release Emails",
[design canvas link removed]).

- One look for every email (board E): the navy band with a heading, one button with the paste-this-link line, a footer.
- Every email greets by the display name the person chose, else their full name; a shared mailbox gets the full name.
- The reminder: every word the super admin's (board Main), previewed as a real person while typing, a test to your own
  address; "Closes first" and a countdown chip per item; the server's job sends at the super admin's time.
- The release emails: a release sends them by itself, never a revoke (Chris: "it will auto send to the BUCEO, similarly
  like once super admin released a BU result to employees, it would notify employees as well"): one email per leader
  with how many of their people (a BU CEO's also says how many the BG CEO moved), one per person; never twice for the
  same result; through the outbox, which a second sender can't double.
Everything here is synthetic (ZZEM-*) and is removed at the end.
"""
import html
import os
import re
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("OneHR's emails -- one look, the display name, the reminder's words and time, the release emails")

BG, CO = "ZZEM BG", "ZZEM CO"
KEYS = ("reminder_template", "reminder_all_subject", "reminder_all_opening", "reminder_auto_last",
        "reminder_runner_runs", "reminder_send_time", "outbox_beat")


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZEM-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM notifications WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM email_outbox WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM release_emails WHERE recipient_id IN (%s) OR subject_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM pm_calibration_adjustments WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM buceo_seats WHERE user_id IN (%s)" % ph, ids)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM pm_calibration_sessions WHERE business_group=?", (BG,))
    db.execute("DELETE FROM email_outbox WHERE to_email LIKE '%@zzem.invalid'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    _cleanup(db)
    _settings = {k: v for k, v in db.execute("SELECT key, value FROM app_settings WHERE key IN (%s)"
                                             % ",".join("?" * len(KEYS)), KEYS)}
    db.execute("DELETE FROM app_settings WHERE key IN (%s)" % ",".join("?" * len(KEYS)), KEYS)
    _tpls = H.stash_email_templates(db)
    _mods = [tuple(r) for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))]
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','pm','tm','idp')", (CID,))
    _wins = [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (CID,))]
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))      # every part open, no dates
    _cyc0 = (CYC["half"], CYC.get("open_by_date"))
    # a Mid-Year whose undated parts are open: a Year-End gives the BU CEO a calibration waiting ("nothing waiting"
    # below), and a cycle that opens by date opens nothing. Pinned, not inherited from the suite run before this one.
    db.execute("UPDATE cycles SET half=1, open_by_date=0 WHERE id=?", (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, mgr=None, hod=None, email="own", display=None, role="user", admin_bg=None):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name,
                 email=(eid.lower() + "@zzem.invalid") if email == "own" else email, hod_id=hod, manager_id=mgr,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO,
                 department="ZZEM Dept", years_of_service=3, confirmation_date=None, left_at=None, is_demo=0,
                 role=role, admin_bg=admin_bg, display_name=display)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    LM = mk("ZZEM-LM", "ZZ EM Manager", display="Lee")
    HOD = mk("ZZEM-HOD", "ZZ EM Hod", display="Hoddy", email="shared@zzem.invalid")
    PEER = mk("ZZEM-PEER", "ZZ EM Peer", email="shared@zzem.invalid")           # shares the HOD's mailbox
    BU = mk("ZZEM-BU", "ZZ EM Bossman")
    S1 = mk("ZZEM-S1", "ZZ EM Alpha", mgr=LM, hod=HOD, display="Al")
    S2 = mk("ZZEM-S2", "ZZ EM Bravo", mgr=LM, hod=HOD, email=None)
    ADM = mk("ZZEM-ADM", "ZZ EM Groupadmin", role="admin", admin_bg=BG)
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, BU))
    db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?,'peer')",
               (CID, S2, S1))                                 # S1 owes S2 a 360 rating: something waiting
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def u(uid):
    return ctx(lambda d: dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


sup = H.client_as(a, SUP)
adm = H.client_as(a, ADM)
_sent = []
_real = (a.mailer.send_mail, a.mailer.is_configured, a.mailer.config_status, a.mailer.get_token, a.OUTBOX_ASYNC,
         a.cycle_is_mid_year, a.release_email_queue)


def mail_on():
    a.mailer.is_configured = lambda: True
    a.mailer.config_status = lambda: {"configured": True, "sender": "x", "has_tenant": True, "has_client_id": True,
                                      "has_secret": True}
    a.mailer.get_token = lambda: "tok"
    a.mailer.send_mail = lambda to, subject, body, token=None, save_to_sent=True: _sent.append((to, subject, body))
    a.OUTBOX_ASYNC = False


def mail_off():
    a.mailer.is_configured = lambda: False


def _counts(em):
    """A release's counts, its waves apart (2026-10-21): a list this short goes in one wave."""
    return {k: v for k, v in (em or {}).items() if k != "waves"} if (em or {}).get("waves") == 1 else em


try:
    # -----------------------------------------------------------------------
    s.section("The greeting: the display name, else the full name; a shared mailbox gets the full name")
    names = ctx(lambda d: {k: a.email_names(d, u(k)) for k in (LM, HOD, S2, BU)})
    s.check("someone who chose a name is greeted by it", names[LM]["display_name"] == "Lee", names[LM])
    s.check("someone who didn't is greeted by their full name", names[S2]["display_name"] == "ZZ EM Bravo", names[S2])
    s.check("an address several people share gets the full name, even when its owner chose one",
            names[HOD]["display_name"] == "ZZ EM Hod", names[HOD])
    s.check("first and full names are there too", names[LM]["first_name"] == "Zz" and names[LM]["full_name"]
            == "ZZ EM Manager", names[LM])
    s.check("HRIS capitals read as a name", a._em_case("TAN AH KOW") == "Tan Ah Kow" and a._em_case("McDonald Lim")
            == "McDonald Lim")

    # -----------------------------------------------------------------------
    s.section("One look for every email")
    doc = a.onehr_email("Hello <there>", a._em_p("Body"), button=("Go", "https://x.test/a?b=1&c=2"), sub="A line",
                        cycle="2026 Year-End", footer="Why you got it")
    s.check("the navy band holds the heading, its line and the cycle", 'bgcolor="#252A59"' in doc
            and "Hello &lt;there&gt;" in doc and "A line" in doc and "2026 Year-End" in doc)
    s.check("one button, with the address to paste under it (escaped)", doc.count('class="oh-btn"') == 1
            and "paste this into your browser" in doc and "https://x.test/a?b=1&amp;c=2" in doc)
    s.check("the footer, then One People · One Culture · One Chin Hin", "Why you got it" in doc
            and "One People · One Culture · One Chin Hin" in doc)
    # light only (2026-10-19): Outlook for Mac in dark mode skipped the dark block, darkened the card and kept the dark
    # text, so the email now asks every app for its light look, and an app forcing dark recolours all of it
    s.check("light only: no dark-mode block, and every mail app is told so", "prefers-color-scheme" not in doc
            and 'name="color-scheme" content="light only"' in doc and 'content="light dark"' not in doc
            and "color-scheme:light only" in doc)
    s.check("tables, for Outlook (no flex, no grid)", "display:flex" not in doc and "display:grid" not in doc
            and doc.count("<table") >= 3)
    s.check("production's address in every link by default", "example.com" in H.source(a, "app.py")
            and "old-host.example" not in H.source(a, "app.py").split("def app_base_url")[1][:400])

    # -----------------------------------------------------------------------
    s.section("The reminder: closes first, and a chip per item")
    today = ctx(lambda d: a._today_myt())
    it = [{"group": "f360", "role": "f360", "text": "Rate your colleagues", "detail": "2 colleagues left",
           "closes": "", "closes_on": today + timedelta(days=3), "url": "/review"},
          {"group": "own", "role": "own", "text": "Enter your KPI results and submit", "detail": "", "closes": "",
           "closes_on": today + timedelta(days=10), "url": "/review"}]
    subj, body = ctx(lambda d: a.reminder_mail(u(S1), it, a.active_cycle(d)))
    s.check("the heading counts them and says when the first closes", "2 things are still waiting on you" in body
            and "The first closes on %s: 4 days left." % a._em_day(today + timedelta(days=3)) in body)
    s.check("greeted by the name they chose", "Hi Al," in body)
    # the chip counts today, as the bar does (Chris 2026-11-01): a part closing in 3 days reads "4 days left"
    callout = body[body.index('class="oh-warn"'):]
    callout = callout[:callout.index("</table>")]
    s.check("Closes first, with the days left (today counts: 3 days out reads 4), in amber at 3 days",
            "Closes first" in body and ">4</span>" in callout and ">3</span>" not in callout
            and "days left" in callout and "border-left:4px solid #d99a2b" in body)
    s.check("...and the sentence under the heading counts the same way (Chris 4 Nov): 'closes on <day>: 4 days left.'",
            "The first closes on %s: 4 days left." % a._em_day(today + timedelta(days=3)) in body
            and "closes in 3 days" not in body)
    for n_out, shown in ((1, "2"), (6, "7")):
        _s, b_ = ctx(lambda d: a.reminder_mail(u(S1), [dict(it[0], closes_on=today + timedelta(days=n_out)), it[1]],
                                                a.active_cycle(d)))
        c_ = b_[b_.index('class="oh-warn"'):]
        c_ = c_[:c_.index("</table>")]
        s.check("...a part closing in %d day(s) reads '%s days left' in the chip, as the bar does" % (n_out, shown),
                (">%s</span>" % shown) in c_ and "days left" in c_, c_[-300:])
    _s, b_ = ctx(lambda d: a.reminder_mail(u(S1), [dict(it[0], closes_on=today), it[1]], a.active_cycle(d)))
    c_ = b_[b_.index('class="oh-warn"'):]
    c_ = c_[:c_.index("</table>")]
    s.check("...closing today: 'Today / last day', in red, unchanged", ">Today</span>" in c_ and "last day" in c_
            and "border-left:4px solid #D61923" in c_, c_[-300:])
    s.check("each item's chip: amber at 3 days (4 days left), neutral at 10 (11 days left)", body.count('class="oh-chip-w"') == 1
            and body.count('class="oh-chip"') == 1 and "11 days left · " in body)
    s.check("the section names, the button and the closing line", "360 feedback you give" in body
            and "Your own check-in" in body and ">Continue in AI+ OneHR</a>" in body
            and "Your AI agent picks up where you left off." in body)
    # Outlook darkens tinted boxes and leaves child-coloured text dark: a box that carries text is white
    box = body[body.index('class="oh-warn"'):]
    box = box[:box.index("</table>")]
    foot = body[body.index('class="oh-foot'):]
    foot = foot[:foot.index("</td>")]
    s.check("the callout and the footer are white boxes (the tone is in the border)",
            'bgcolor="#ffffff"' in box and "background:#ffffff" in box and 'bgcolor="#ffffff"' in foot
            and "background:#ffffff" in foot and "#fff8ea" not in body and "#fafbfd" not in body)
    s.check("the brand reads AI+ OneHR by Chin Hin, AI+ in red, in the band and the footer",
            foot.index("AI+") < foot.index("OneHR by Chin Hin") and 'color:#D61923">AI+</span>' in foot
            and 'color:#ff6b72">AI+</span> OneHR' in body)
    today_it = [dict(it[0], closes_on=today)]
    _s1, b1 = ctx(lambda d: a.reminder_mail(u(S1), today_it, a.active_cycle(d)))
    s.check("on its last day: red, and no Closes first box for a single item",
            'class="oh-chip-r"' in b1 and "The first closes today." in b1 and "Closes first" not in b1)

    # -----------------------------------------------------------------------
    s.section("Every word of the reminder is the super admin's")
    def tpl():
        return ctx(lambda d: a.reminder_template())
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_email", "subject": "{count} for {first_name}",
                                           "heading": "{display_name}, {count} waiting", "greeting": "Dear {full_name},",
                                           "button": "Go now", "opening": "Opening words.", "sec_f360": "Feedback",
                                           "sec_team": "Team", "sec_own": "Mine", "sec_lead": "Lead",
                                           "closing": "Bye.", "footer": "Foot."}, follow_redirects=True)
    t = tpl()
    s.check("Save keeps every field", t["heading"] == "{display_name}, {count} waiting" and t["button"] == "Go now"
            and t["sec_own"] == "Mine" and t["footer"] == "Foot.", t)
    s.check("...and the audit names what changed", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE "
                                                            "action='reminder_content' AND user_id=? AND detail LIKE "
                                                            "'changed: Subject, Heading%'", (SUP,)) >= 1)
    subj2, body2 = ctx(lambda d: a.reminder_mail(u(S1), it, a.active_cycle(d)))
    s.check("the email reads them, placeholders filled", subj2 == "2 for Zz" and "Al, 2 waiting" in body2
            and "Dear ZZ EM Alpha," in body2 and ">Go now</a>" in body2 and ">Mine<" in body2 and "Bye." in body2)
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_email", "heading": "Hi {name}"},
                 follow_redirects=True)
    s.check("a placeholder OneHR doesn't fill is refused, naming the ones it does",
            "{name}, which OneHR doesn't fill in" in html.unescape(r.get_data(as_text=True))
            and tpl()["heading"] == "{display_name}, {count} waiting")
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_email", "subject": " "},
                 follow_redirects=True)
    s.check("a required field sent empty is refused", "Subject can't be empty" in html.unescape(r.get_data(as_text=True))
            and tpl()["subject"] == "{count} for {first_name}")
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_email", "heading": "x" * 121},
                 follow_redirects=True)
    s.check("text over its ceiling is refused, never trimmed", "under 120 characters" in html.unescape(
        r.get_data(as_text=True)) and tpl()["heading"] == "{display_name}, {count} waiting")
    sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_email", "closing": "Later."})
    s.check("a field the form didn't send stays as it is", tpl()["closing"] == "Later." and tpl()["subject"]
            == "{count} for {first_name}")
    r = adm.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_email", "subject": "x"})
    s.check("a BG admin can't change the words", r.status_code == 403)
    r = sup.post("/admin/reminders/preview", data={"csrf_token": "tok", "eid": "ZZEM-S1", "heading": "Draft heading",
                                                   "subject": "Draft subject"})
    b = html.unescape(r.get_data(as_text=True))
    s.check("the preview follows the editor's unsaved words, as that person's real email",
            r.status_code == 200 and "Draft heading" in b and "Subject:</b> Draft subject" in b and "Rate your" in b)
    s.check("...and saves nothing", tpl()["heading"] == "{display_name}, {count} waiting")
    sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "reset_email"})
    s.check("Back to the default puts every word back", tpl() == a.REMINDER_TPL_DEFAULT)
    d_ = sup.get("/admin/reminders/people.json?q=zzem-s").get_json()
    s.check("Preview as finds people by Employee ID", sorted(x["eid"] for x in d_["results"]) == ["ZZEM-S1", "ZZEM-S2"],
            d_)
    other = ctx(lambda d: d.execute("SELECT full_name FROM users WHERE role!='admin' AND business_group!=? AND "
                                    "left_at IS NULL AND employee_id IS NOT NULL LIMIT 1", (BG,)).fetchone()[0])
    s.check("...a BG admin can't search: the Email menu is the super admin's (2026-10-24)",
            adm.get("/admin/reminders/people.json?q=%s" % other[:6]).status_code == 403)
    # the words are edited on Email › Emails and templates since 2026-10-24, the rules on Everyone's reminder
    r = sup.get("/admin/emails?email=reminder")
    b = html.unescape(r.get_data(as_text=True))
    s.check("the editor: the email's every field, Preview as, the chips",
            r.status_code == 200 and all('name="%s"' % k in b for k, _l, _c, _r in a.REMINDER_TPL_FIELDS)
            and "Preview as" in b and 'data-ph="{display_name}"' in b and "Save template" in b)
    s.check("...its Save is double-confirmed", re.search(r'id="eml-form"[^>]*data-confirm="Save “', b.replace("\n", " "))
            is not None)
    s.check("a BG admin opens neither the rules nor the words", adm.get("/admin/reminders").status_code == 403
            and adm.get("/admin/emails").status_code == 403)
    mail_on()
    _sent.clear()
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "test", "eid": "ZZEM-S1",
                                           "test_to": "me@zzem.invalid"}, follow_redirects=True)
    s.check("the test: that person's real email, to the admin's address, [Test] first",
            len(_sent) == 1 and _sent[0][0] == "me@zzem.invalid" and _sent[0][1].startswith("[Test] Reminder: ")
            and "Rate your" in _sent[0][2] and "Hi Al," in _sent[0][2], [x[:2] for x in _sent])
    _sent.clear()
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "test", "eid": "ZZEM-BU",
                                           "test_to": "me@zzem.invalid"}, follow_redirects=True)
    s.check("...someone with nothing waiting has no email to test", _sent == [] and "get no email to test" in
            html.unescape(r.get_data(as_text=True)))

    # -----------------------------------------------------------------------
    s.section("The server's job sends at the super admin's time")
    rules = dict(ctx(lambda d: a.reminder_rules()), send_time="09:00")
    day0 = datetime(2026, 11, 3)
    due = lambda h, m: ctx(lambda d: a.reminder_due_now(d, rules, now=day0.replace(hour=h, minute=m)))  # noqa: E731
    s.check("before the time: not yet", due(8, 59)[0] is False and "Not yet" in due(8, 59)[1])
    s.check("at the time and up to 3 hours after: send", due(9, 0)[0] and due(11, 59)[0])
    s.check("more than 3 hours late: the next send day instead", due(12, 1)[0] is False)
    ctx(lambda d: a.reminder_mark_sent_today(d, now=day0.replace(hour=9, minute=5)))
    s.check("once a day: a second run that day does nothing", due(9, 30) == (False, "Already sent today."))
    ctx(lambda d: (d.execute("DELETE FROM app_settings WHERE key IN ('reminder_auto_last','reminder_runner_runs')"),
                   d.commit()))
    s.check("no run yet: the page says this server has no timer", ctx(lambda d: a.reminder_runner_cadence()) == "none")
    ctx(lambda d: a.reminder_runner_seen(d, now=day0.replace(hour=9)))
    ctx(lambda d: a.reminder_runner_seen(d, now=day0.replace(hour=9, minute=15)))
    s.check("runs 15 minutes apart: it checks often, so any time works", ctx(lambda d: a.reminder_runner_cadence())
            == "often")
    ctx(lambda d: a.reminder_runner_seen(d, now=day0.replace(hour=9) + timedelta(days=1)))
    s.check("runs a day apart: the old daily timer", ctx(lambda d: a.reminder_runner_cadence()) == "daily")
    t_ = open(os.path.join(H.REPO, "deploy", "leadership360-reminders.timer")).read()
    s.check("the timer runs every 15 minutes, and Persistent sits on its own line (a comment after it was never read)",
            "OnCalendar=*-*-* *:00/15:00" in t_ and [l_ for l_ in t_.splitlines() if l_.startswith("Persistent")]
            == ["Persistent=true"])

    # -----------------------------------------------------------------------
    s.section("The outbox: in the background, at Graph's pace, never twice")
    _sent.clear()
    ids = ctx(lambda d: [a._outbox_add(d, "zz_test", "x%d@zzem.invalid" % i, "S%d" % i, "<p>b</p>") for i in range(2)]
              + [d.commit()])[:2]
    ctx(lambda d: a._outbox_kick())
    s.check("a kick sends what's queued, oldest first, each once", [x[0] for x in _sent] == ["x0@zzem.invalid",
                                                                                             "x1@zzem.invalid"], _sent)
    _sent.clear()
    ctx(lambda d: a._outbox_drain(a.app, inline=True))
    s.check("...a second sender finds nothing left to send", _sent == [])
    stale = ctx(lambda d: (d.execute("INSERT INTO email_outbox(kind, to_email, subject, body, status, claim, claimed_at) "
                                     "VALUES ('zz_test','st@zzem.invalid','S','b','sending','dead',"
                                     "datetime('now','-20 minutes'))").lastrowid, d.commit())[0])
    ctx(lambda d: a._outbox_kick())
    s.check("a row a dead sender left half-done goes again", [x[0] for x in _sent] == ["st@zzem.invalid"], _sent)
    s.check("each send is logged", H.one(a, "SELECT COUNT(*) FROM notifications WHERE kind='zz_test' AND status='sent' "
                                            "AND to_email LIKE '%@zzem.invalid'") == 3)
    ctx(lambda d: (d.execute("DELETE FROM notifications WHERE kind='zz_test'"), d.commit()))

    # -----------------------------------------------------------------------
    s.section("The release emails: by themselves, a count and a link")
    P = ctx(lambda d: dict(d.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()))
    me = u(SUP)
    mail_off()
    s.check("a server with no email sends none", ctx(lambda d: a.release_email_queue(d, me, P, P, {"pm": [S1]},
                                                                                      "leaders")) is None)
    mail_on()
    a.cycle_is_mid_year = lambda db_, cid_: False    # a Year-End: the BG CEO's moves count
    sess = ctx(lambda d: (d.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, "
                                    "scope_label) VALUES (?, 'bgceo', ?, ?, 'ZZEM')", (CID, BG, BG)).lastrowid,
                          d.commit())[0])
    ctx(lambda d: (d.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band, "
                             "justification, adjusted_by) VALUES (?,?,'ME','AE','x',?)", (sess, S1, SUP)),
                   d.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band, "
                             "justification, adjusted_by, pinned) VALUES (?,?,'BE','ME','',?, 'lm')", (sess, S2, SUP)),
                   d.commit()))
    s.check("the BG CEO's moves: a move counts, a pin doesn't", ctx(lambda d: a._bg_moved_ids(d, CID, CID, [S1, S2]))
            == {S1: {"pm"}})
    _sent.clear()
    em = ctx(lambda d: a.release_email_queue(d, me, P, P, {"pm": [S1, S2], "talent": [S1]}, "leaders"))
    to = {x[0]: x for x in _sent}
    s.check("step 1: one email to each leader it reached -- line manager, HOD, BU CEO",
            _counts(em) == {"leaders": 3, "people": 0, "no_email": 0} and sorted(to) == sorted(
                ["zzem-lm@zzem.invalid", "shared@zzem.invalid", "zzem-bu@zzem.invalid"]), (em, sorted(to)))
    lm = to.get("zzem-lm@zzem.invalid", ("", "", ""))
    s.check("...with how many of their people, greeted by their name, linking to What you led",
            lm[1] == "Results for 2 of your people are ready in AI+ OneHR" and "Hi Lee," in lm[2]
            and "panel=led&amp;cycle=%d" % CID in lm[2], lm[1])
    s.check("...the shared HOD mailbox greeted by the full name", "Hi ZZ EM Hod," in to.get("shared@zzem.invalid",
                                                                                         ("", "", ""))[2])
    bu = to.get("zzem-bu@zzem.invalid", ("", "", ""))[2]
    s.check("...a BU CEO's says how many the BG CEO moved, in which unit (its name as shown on screen)",
            "Your BG CEO moved 1 of them from the bands you calibrated in %s." % ctx(lambda d: a.display_company(BG, CO))
            in html.unescape(bu))
    s.check("...the line manager's doesn't", "BG CEO moved" not in lm[2])
    s.check("...no band and no other name in any of them", not any(re.search(r"\b(AE|ME|BE|OU|UA)\b|ZZ EM (Alpha|Bravo)",
                                                                             x[2]) for x in _sent))
    s.check("...and not to the people yet", "Your people don't see their results yet" in html.unescape(lm[2]))
    _sent.clear()
    em = ctx(lambda d: a.release_email_queue(d, me, P, P, {"pm": [S1, S2]}, "leaders"))
    s.check("released again (after a revoke): nobody is emailed twice", _sent == [] and em["leaders"] == 0, em)
    _sent.clear()
    em = ctx(lambda d: a.release_email_queue(d, me, P, P, {"pm": [S1, S2]}, "employees"))
    s.check("step 2: one email to each person, and one with no address counted", _counts(em) == {
                "leaders": 0, "people": 1, "no_email": 1} and
            [x[0] for x in _sent] == ["zzem-s1@zzem.invalid"], (em, [x[0] for x in _sent]))
    s.check("...their results are ready, greeted by their name, linking to their record",
            _sent and _sent[0][1] == "Your %s results are ready in AI+ OneHR" % P["name"] and "Hi Al," in _sent[0][2]
            and "your final performance band" in _sent[0][2] and "record=%d" % CID in _sent[0][2])
    _sent.clear()
    ctx(lambda d: a.release_email_queue(d, me, P, P, {"talent": [S1], "pm": [S1]}, "employees"))
    s.check("a result released later gets its own email, naming only it", len(_sent) == 1
            and "your talent status" in _sent[0][2] and "performance band" not in _sent[0][2])
    s.check("every send logged by kind", H.one(a, "SELECT COUNT(*) FROM notifications WHERE kind=? AND user_id IN "
                                                  "(?,?,?)", (a.RELEASE_LEAD_KIND, LM, HOD, BU)) == 3
            and H.one(a, "SELECT COUNT(*) FROM notifications WHERE kind=? AND user_id=?",
                      (a.RELEASE_PERSON_KIND, S1)) == 2)
    a.cycle_is_mid_year = _real[5]
    calls = []
    a.release_email_queue = lambda db_, me_, p_, c_, done_, to_: calls.append((to_, done_)) or {
        "leaders": 0, "people": 0, "no_email": 0}
    sup.post("/admin/talent-release", data={"csrf_token": "tok", "action": "release", "result": "pm", "to": "leaders",
                                            "ids": [S1]})
    sup.post("/admin/talent-release", data={"csrf_token": "tok", "action": "revoke", "result": "pm", "to": "both",
                                            "ids": [S1]})
    s.check("the release page's release sends them; its revoke never does", [c[0] for c in calls] == ["leaders"], calls)
    a.release_email_queue = _real[6]
    b = html.unescape(sup.get("/admin/talent-release").get_data(as_text=True))
    s.check("the page's confirm boxes know each person's leaders and who has an address",
            "var MAIL = true" in b and "data-leads=" in b and "data-mail=" in b and "mailBox(" in b)

    # -----------------------------------------------------------------------
    s.section("The other emails: the same look and greeting")
    rs = a._reset_email_html("Lee", "https://x.test/reset/abc")
    s.check("the password reset", "Reset your password" in rs and "Hi Lee," in rs and "Reset my password" in rs
            and "https://x.test/reset/abc" in rs and "Group People" in rs)
    src = H.source(a, "app.py")
    s.check("...greeted by the display name rule", 'email_names(db, row)["display_name"], link)' in src)
    s.check("the reopen email too", '_em_greet("Hi %s," % email_names(db, actor)["display_name"])' in src)
finally:
    (a.mailer.send_mail, a.mailer.is_configured, a.mailer.config_status, a.mailer.get_token, a.OUTBOX_ASYNC,
     a.cycle_is_mid_year, a.release_email_queue) = _real
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        db.execute("DELETE FROM email_outbox WHERE kind='zz_test'")
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
        db.execute("UPDATE cycles SET half=?, open_by_date=? WHERE id=?", _cyc0 + (CID,))
        db.commit()

sys.exit(s.done())
