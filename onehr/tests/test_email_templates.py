"""Email templates, Cycle > Emails (Chris, 2026-10-24: "can we have a template toggle so admin can see which template is
being used for which email comm? like go live announcement, daily reminder, and we will add on later on the learning
reminder, program rollout, etc."; canvas [design canvas link removed], his pick A with C's dates;
"yes only super admin").

- Each mass email (everyone's reminder, the two leader progress emails, the two release emails) keeps its words as
  templates: one usual one, and others that take over on the MYT days they cover.
- Before any template, an email reads its older settings; the first template of each is made from them.
- Two templates never cover the same day; the usual one can't be dated, unused or retired; past days are refused.
- The Reminders and Leader progress pages edit the template in use today.
- The super admin's only: a BG admin gets 403 and no menu entry.
Everything here is put back at the end.
"""
import html
import json
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Email templates: Cycle > Emails, the usual one and the ones that take over on dates")

KEYS = ("reminder_template", "reminder_all_subject", "reminder_all_opening", "leader_progress_template")
LOG0 = H.one(a, "SELECT COALESCE(MAX(id),0) FROM activity_log")
NOTE0 = H.one(a, "SELECT COALESCE(MAX(id),0) FROM notifications")
with a.app.app_context():
    db = a.get_db()
    TPLS = H.stash_email_templates(db)
    SAVED = {k: v for k, v in db.execute("SELECT key, value FROM app_settings WHERE key IN (%s)"
                                         % ",".join("?" * len(KEYS)), KEYS)}
    db.execute("DELETE FROM app_settings WHERE key IN (%s)" % ",".join("?" * len(KEYS)), KEYS)
    # an older saved reminder, as production has it (the launch-day words, saved before templates existed)
    OLD = dict(a.REMINDER_TPL_DEFAULT, subject="ZZET old subject {count}", heading="ZZET old heading")
    db.execute("INSERT INTO app_settings(key, value) VALUES ('reminder_template', ?)", (json.dumps(OLD),))
    db.execute("INSERT INTO app_settings(key, value) VALUES ('leader_progress_template', ?)",
               (json.dumps({"buceo": {"subject": "ZZET BU subject {scope}"}}),))
    db.commit()
SU, BGA, EMP = H.actors(a)
SUP = SU["id"]
sup = H.client_as(a, SUP)
bga = H.client_as(a, BGA["id"]) if BGA else None
_sent = []
_real = (a.mailer.send_mail, a.mailer.config_status)


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def post(data, client=None, follow=True):
    return (client or sup).post("/admin/emails", data=dict(data, csrf_token="tok"), follow_redirects=follow)


def text(r):
    return html.unescape(r.get_data(as_text=True))


def tpl_id(key, name):
    r = H.one(a, "SELECT COALESCE(MAX(id),0) FROM email_templates WHERE email=? AND name=? AND retired_at IS NULL",
              (key, name))
    return r or None


def words(key, day=None):
    return ctx(lambda d: a.email_tpl_words(key, day=day, db=d))


try:
    today = ctx(lambda d: a._today_myt())

    # -----------------------------------------------------------------------
    s.section("Before any template: each email reads its older settings")
    s.check("the reminder reads the words saved before templates existed", ctx(lambda d: a.reminder_template())
            ["subject"] == "ZZET old subject {count}")
    s.check("...and the BU CEOs' progress email its own, the BG CEOs' OneHR's",
            ctx(lambda d: a.lp_template("buceo"))["subject"] == "ZZET BU subject {scope}"
            and ctx(lambda d: a.lp_template("bgceo")) == a.LP_TPL_DEFAULT["bgceo"])
    s.check("the release emails read the approved wording (2026-10-24)",
            words("release_lead")["subject"] == "Results for {count} of your people are ready in AI+ OneHR"
            and words("release_person")["subject"] == "Your {cycle} results are ready in AI+ OneHR")

    # -----------------------------------------------------------------------
    s.section("The super admin's only")
    if bga:
        s.check("a BG admin can't open Cycle > Emails", bga.get("/admin/emails").status_code == 403)
        s.check("...nor change a template", post({"action": "new", "email": "reminder", "name": "x"}, bga,
                                                 follow=False).status_code == 403)
        s.check("...nor preview one", bga.post("/admin/emails/preview", data={"csrf_token": "tok", "tid": "1"})
                .status_code == 403)
        s.check("...and has no menu entry for it", not ctx(lambda d: a._admin_nav_allowed(
            {"ep": "admin_emails"}, dict(BGA))))
    s.check("every Emails route is the super admin's on the access map", all(
        a.ADMIN_ACCESS_MAP.get(ep) == "super" for ep in ("admin_emails", "admin_email_template", "admin_emails_preview")))
    s.check("...and the access page says so", "the email templates (Email › Emails and templates)" in dict(
        (m[0], m[3]) for m in a.ACCESS_MODULES)["cycle"])

    # -----------------------------------------------------------------------
    s.section("Cycle > Emails: each email, who gets it, when, and its template today")
    # the shared spec of Your own emails (2026-11-09, flagged `shared`) has no template of its own: every other kind has exactly one usual one
    _KINDS = [k for k in a.EMAIL_TPL_KINDS if not k.get("shared")]
    r = sup.get("/admin/emails")
    b = text(r)
    s.check("the page opens", r.status_code == 200)
    s.check("its first visit makes each email's usual template from its words of the day",
            H.one(a, "SELECT COUNT(*) FROM email_templates WHERE usual=1 AND retired_at IS NULL") == len(_KINDS)
            and words("reminder")["subject"] == "ZZET old subject {count}"
            and words("lp_buceo")["subject"] == "ZZET BU subject {scope}")
    s.check("...once: a second visit makes none", sup.get("/admin/emails").status_code == 200
            and H.one(a, "SELECT COUNT(*) FROM email_templates") == len(_KINDS))
    # Grade H's staff email (2026-10-28) is listed only where the module is on (it is dark here), so it has no line on this page
    _listed = [k for k in _KINDS if k["key"] not in ("gradeh_ready", "gradeh_reminder", "gradeh_result", "gradeh_lp_hod", "gradeh_lp_buceo",
                                                                "gradeh_ready_hod", "gradeh_ready_buceo") or a.gradeh_on()]
    s.check("every email is listed, each template a link to its editor (Email, 2026-10-24)",
            all(k["title"] in b for k in _listed)
            and b.count('href="/admin/emails?tid=') == len(_listed))
    s.check("...and the template in use today", "Reminder" in b and "In use today" in b)
    forms = [f for f in re.findall(r"<form[^>]*method=\"post\"[^>]*>", b) if 'action="/logout"' not in f]   # Log out is a POST form (2-14), no action that asks
    s.check("every form on it is double-confirmed", forms and all("data-confirm" in f or "data-prompt" in f
                                                                  for f in forms), len(forms))

    # -----------------------------------------------------------------------
    s.section("A new template, its words, its name")
    r = post({"action": "new", "email": "reminder", "name": "  Go-live   announcement "}, follow=False)
    GO = tpl_id("reminder", "Go-live announcement")
    s.check("New makes it from OneHR's own words, not in use, and opens it in the editor",
            GO and r.status_code == 302 and "/admin/emails?tid=%d" % GO in r.headers["Location"]
            and ctx(lambda d: a.email_tpl_saved(d.execute("SELECT * FROM email_templates WHERE id=?", (GO,)).fetchone()))
            == a.REMINDER_TPL_DEFAULT
            and H.one(a, "SELECT usual FROM email_templates WHERE id=?", (GO,)) == 0
            and H.one(a, "SELECT date_from FROM email_templates WHERE id=?", (GO,)) is None)
    s.check("...and an unused template changes nothing sent", words("reminder")["subject"] == "ZZET old subject {count}")
    b = text(post({"action": "new", "email": "reminder", "name": "go-live ANNOUNCEMENT"}))
    s.check("a name the email already has is refused", "already has a template called" in b
            and H.one(a, "SELECT COUNT(*) FROM email_templates WHERE email='reminder' AND retired_at IS NULL") == 2)
    b = text(post({"action": "new", "email": "reminder", "name": " "}))
    s.check("...so is no name", "Give the template a name." in b)
    s.check("an email OneHR doesn't have is a bare 400", post({"action": "new", "email": "zz", "name": "x"},
                                                              follow=False).status_code == 400)
    r = sup.get("/admin/emails/template?id=%d" % GO)
    s.check("the older editor address goes to the editor beside the list", r.status_code == 302
            and r.headers["Location"].endswith("/admin/emails?tid=%d" % GO))
    b = text(sup.get("/admin/emails?tid=%d" % GO))
    s.check("its editor holds every field, when it's used, the placeholders and the docked preview",
            all('name="%s"' % k in b for k, _l, _c, _r in a.REMINDER_TPL_FIELDS) and 'data-ph="{closes}"' in b
            and 'id="eml-frame"' in b and 'id="eml-pv"' in b and "Show preview" in b and "Save template" in b
            and 'name="mode" value="dates"' in b and "<h2 id=\"eml-ed-h\">Go-live announcement" in b)
    LAUNCH = {"subject": "AI+ OneHR is open: {count} {things} waiting on you", "heading": "Your {cycle} check-in is open",
              "button": "Open AI+ OneHR", "opening": "AI+ OneHR is live. The first part closes on {closes}."}
    post(dict(LAUNCH, action="edit", email="reminder", tid=GO, name="Go-live announcement"))
    got = ctx(lambda d: a.email_tpl_saved(d.execute("SELECT * FROM email_templates WHERE id=?", (GO,)).fetchone()))
    s.check("Save keeps its words, the fields it didn't send as they were", got["subject"] == LAUNCH["subject"]
            and got["opening"] == LAUNCH["opening"] and got["footer"] == a.REMINDER_TPL_DEFAULT["footer"])
    s.check("...in the audit log, naming the template and what changed", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='email_template' AND detail LIKE "
           "'Everyone''s reminder · “Go-live announcement”: changed Subject, Heading%'", (LOG0,)) == 1)
    b = text(post({"action": "edit", "email": "reminder", "tid": GO, "name": "Go-live announcement",
                   "heading": "Hi {nobody}"}))
    s.check("a placeholder OneHR doesn't fill is refused", "{nobody}, which OneHR doesn't fill in" in b
            and "{closes}" in b.split("which OneHR doesn't fill in")[1][:200])
    b = text(post({"action": "edit", "email": "reminder", "tid": GO, "name": "Go-live announcement", "subject": " "}))
    s.check("...a required field sent empty is refused", "Subject can't be empty." in b)
    b = text(post({"action": "edit", "email": "reminder", "tid": GO, "name": "Go-live announcement",
                   "button": "x" * 41}))
    s.check("...text over its ceiling is refused, never trimmed", "Keep button under 40 characters." in b
            and words("reminder")["subject"] == "ZZET old subject {count}"
            and ctx(lambda d: a.email_tpl_saved(d.execute("SELECT * FROM email_templates WHERE id=?", (GO,))
                                                .fetchone()))["button"] == "Open AI+ OneHR")
    r = sup.post("/admin/emails/preview", data={"csrf_token": "tok", "tid": GO, "heading": "ZZET draft heading",
                                                "subject": "ZZET draft {count}"})
    b = text(r)
    s.check("the preview follows the unsaved words, addressed to the admin, with made-up parts",
            r.status_code == 200 and "ZZET draft heading" in b and "Subject:</b> ZZET draft 3" in b
            and "Rate your colleagues" in b and "2 colleagues left" in b)
    s.check("...and saves nothing", ctx(lambda d: a.email_tpl_saved(d.execute(
        "SELECT * FROM email_templates WHERE id=?", (GO,)).fetchone()))["heading"] == LAUNCH["heading"])

    # -----------------------------------------------------------------------
    s.section("Dates: a template takes over on the days it covers")
    D0, D1 = today + timedelta(days=9), today + timedelta(days=9)
    post({"action": "when", "email": "reminder", "tid": GO, "mode": "dates", "date_from": D0.isoformat(),
          "date_to": D1.isoformat()})
    s.check("given one day, it's used on that day only", words("reminder", D0)["subject"] == LAUNCH["subject"]
            and words("reminder", D0 - timedelta(days=1))["subject"] == "ZZET old subject {count}"
            and words("reminder", D0 + timedelta(days=1))["subject"] == "ZZET old subject {count}")
    s.check("...today the usual one is still in use", words("reminder")["subject"] == "ZZET old subject {count}")
    ch = ctx(lambda d: a.email_tpl_changes(a.email_tpl_rows(d, "reminder"), today))
    s.check("what takes over next: it on its day, the usual one the day after",
            [(d_, r_["name"]) for d_, r_ in ch] == [(D0, "Go-live announcement"), (D0 + timedelta(days=1), "Reminder")],
            [(d_.isoformat(), r_["name"]) for d_, r_ in ch])
    s.check("...as the list says beside it", re.search(
        r'Go-live announcement</span>\s*<span class="eml-tpl is-dated">%s</span>' % re.escape(ctx(lambda d: a._em_day(D0))),
        text(sup.get("/admin/emails"))) is not None)
    post({"action": "new", "email": "reminder", "name": "ZZET other"})
    OT = tpl_id("reminder", "ZZET other")
    b = text(post({"action": "when", "email": "reminder", "tid": OT, "mode": "dates",
                   "date_from": (D0 - timedelta(days=2)).isoformat(), "date_to": D0.isoformat()}))
    s.check("two templates can't cover the same day", "already covers" in b and H.one(
        a, "SELECT date_from FROM email_templates WHERE id=?", (OT,)) is None)
    b = text(post({"action": "when", "email": "reminder", "tid": OT, "mode": "dates",
                   "date_from": (today - timedelta(days=3)).isoformat(), "date_to": (today - timedelta(days=1)).isoformat()}))
    s.check("...days already over are refused", "Those days are over" in b)
    b = text(post({"action": "when", "email": "reminder", "tid": OT, "mode": "dates",
                   "date_from": D0.isoformat(), "date_to": (D0 - timedelta(days=1)).isoformat()}))
    s.check("...so is a last day before the first", "The last day comes before the first." in b)
    b = text(post({"action": "when", "email": "reminder", "tid": OT, "mode": "dates", "date_from": D0.isoformat()}))
    s.check("...and one day missing", "Give both days" in b)
    post({"action": "when", "email": "reminder", "tid": OT, "mode": "dates", "date_from": today.isoformat(),
          "date_to": today.isoformat()})
    s.check("a dated template covering today is in use today", words("reminder")["subject"] ==
            a.REMINDER_TPL_DEFAULT["subject"] and "ZZET other" == ctx(lambda d: a.email_tpl_pick(
                a.email_tpl_rows(d, "reminder"), today))["name"])
    U0 = tpl_id("reminder", "Reminder")
    b = text(post({"action": "when", "email": "reminder", "tid": U0, "mode": "dates", "date_from": D0.isoformat(),
                   "date_to": D0.isoformat()}))
    s.check("the usual one can't be given dates", "is the usual one" in b and H.one(
        a, "SELECT date_from FROM email_templates WHERE id=?", (U0,)) is None)
    b = text(post({"action": "retire", "email": "reminder", "tid": U0}))
    s.check("...nor retired", "can't be retired" in b and H.one(a, "SELECT retired_at FROM email_templates WHERE id=?",
                                                                (U0,)) is None)

    # -----------------------------------------------------------------------
    s.section("The Reminders page edits the template in use today")
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "save_email", "closing": "ZZET closing."},
                 follow_redirects=True)
    s.check("a save there changes today's template, here the dated one", ctx(lambda d: a.email_tpl_saved(d.execute(
        "SELECT * FROM email_templates WHERE id=?", (OT,)).fetchone()))["closing"] == "ZZET closing."
        and ctx(lambda d: a.email_tpl_saved(d.execute("SELECT * FROM email_templates WHERE id=?", (U0,)).fetchone()))
        ["closing"] != "ZZET closing." and "in the template “ZZET other”" in text(r))
    s.check("...and the page names it, with the way to the others", re.search(
        r'ZZET other</span>\s*<span class="muted small">· in use today', r.get_data(as_text=True)) is not None
        and "/admin/emails?email=reminder" in r.get_data(as_text=True))
    post({"action": "when", "email": "reminder", "tid": OT, "mode": "none"})
    s.check("Not in use takes its dates away: the usual one is back", H.one(
        a, "SELECT date_from FROM email_templates WHERE id=?", (OT,)) is None
        and words("reminder")["subject"] == "ZZET old subject {count}")

    # -----------------------------------------------------------------------
    s.section("The usual one, Duplicate, Retire")
    post({"action": "when", "email": "reminder", "tid": OT, "mode": "usual"})
    s.check("making another the usual one stops the old one", H.one(a, "SELECT usual FROM email_templates WHERE id=?",
                                                                    (OT,)) == 1
            and H.one(a, "SELECT usual FROM email_templates WHERE id=?", (U0,)) == 0
            and H.one(a, "SELECT COUNT(*) FROM email_templates WHERE email='reminder' AND usual=1") == 1
            and words("reminder")["closing"] == "ZZET closing.")
    s.check("...the dated one still takes over on its day", words("reminder", D0)["subject"] == LAUNCH["subject"])
    post({"action": "duplicate", "email": "reminder", "tid": GO})
    CP = tpl_id("reminder", "Copy of Go-live announcement")
    s.check("Duplicate copies the words, unused", CP and H.one(a, "SELECT usual FROM email_templates WHERE id=?", (CP,))
            == 0 and H.one(a, "SELECT date_from FROM email_templates WHERE id=?", (CP,)) is None
            and ctx(lambda d: a.email_tpl_saved(d.execute("SELECT * FROM email_templates WHERE id=?", (CP,))
                                                .fetchone()))["subject"] == LAUNCH["subject"])
    post({"action": "duplicate", "email": "reminder", "tid": GO})
    s.check("...again, a name of its own", tpl_id("reminder", "Copy 2 of Go-live announcement") is not None)
    post({"action": "retire", "email": "reminder", "tid": GO})
    s.check("Retire: it's no longer used or listed, never deleted", H.one(
        a, "SELECT retired_at IS NOT NULL FROM email_templates WHERE id=?", (GO,)) == 1
        and words("reminder", D0)["closing"] == "ZZET closing."
        and GO not in [r_["id"] for r_ in ctx(lambda d: a.email_tpl_rows(d, "reminder"))]
        and sup.get("/admin/emails").status_code == 200)
    b = text(post({"action": "edit", "email": "reminder", "tid": GO, "name": "x", "subject": "y"}))
    s.check("...and a retired one can't be changed", "isn't there any more" in b)

    # -----------------------------------------------------------------------
    s.section("Each email reads its template")
    LPB = tpl_id("lp_bgceo", "BG CEO progress")
    post({"action": "edit", "email": "lp_bgceo", "tid": LPB, "name": "BG CEO progress", "subject": "ZZET BG {scope}"})
    s.check("leader progress: the BG CEOs' email reads its template, the BU CEOs' its own",
            ctx(lambda d: a.lp_template("bgceo"))["subject"] == "ZZET BG {scope}"
            and ctx(lambda d: a.lp_template("buceo"))["subject"] == "ZZET BU subject {scope}")
    RL = tpl_id("release_lead", "Results to leaders")
    post({"action": "edit", "email": "release_lead", "tid": RL, "name": "Results to leaders",
          "subject": "ZZET {count} for {display_name}", "moved": "ZZET moved {moved} in {units}."})
    me = ctx(lambda d: d.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone())
    cyc = {"id": 0, "name": "ZZET Year-End"}
    subj, body = ctx(lambda d: a._release_lead_mail(d, me, 7, {"n": 3}, ["Unit A", "Unit B"], cyc, False, True))
    nm = ctx(lambda d: a.email_names(d, me)["display_name"])
    s.check("the leaders' release email reads its template, placeholders filled", subj == "ZZET 7 for %s" % nm
            and "ZZET moved 3 in Unit A and Unit B." in html.unescape(body)
            and "They can see their own results now too" in html.unescape(body)
            and "Released to you and to them." in body)
    subj, body = ctx(lambda d: a._release_lead_mail(d, me, 7, None, [], cyc, False, False))
    s.check("...no BG CEO moves, no moved line; leaders only, its own line", "ZZET moved" not in body
            and "Group People will release them to them shortly" in html.unescape(body))
    subj, body = ctx(lambda d: a._release_person_mail(d, me, {"pm", "talent"}, cyc))
    s.check("each person's: what was released, the approved words", subj == "Your ZZET Year-End results are ready in "
            "AI+ OneHR" and "your final performance band and your talent status" in body
            and "Thank you for the work you put into your check-in." in body)
    src = H.source(a, "app.py")
    s.check("the reminder send writes every email in the words of the day, read once", re.search(
        r"tpl = reminder_template\(\)[^\n]*\n(.*\n){0,45}?.*reminder_mail\(u, items, cyc, tpl=tpl", src) is not None)
    s.check("...and the release queue its two templates, once", "lead_tpl, person_tpl = email_tpl_words(\"release_lead\""
            in src and "tpl=lead_tpl" in src and "tpl=person_tpl" in src)

    # -----------------------------------------------------------------------
    s.section("Send me a test")
    a.mailer.send_mail = lambda to, subject, body, token=None, save_to_sent=True: _sent.append((to, subject, body))
    a.mailer.config_status = lambda: {"configured": False}
    b = text(post({"action": "test", "email": "lp_bgceo", "tid": LPB, "test_to": "me@zzet.invalid"}))
    s.check("a server with no email sends none", _sent == [] and "Email isn't set up" in b)
    a.mailer.config_status = lambda: {"configured": True}
    b = text(post({"action": "test", "email": "lp_bgceo", "tid": LPB, "test_to": "me@zzet.invalid"}))
    s.check("the test: the template's words, made-up figures, to the address given, [Test] first",
            len(_sent) == 1 and _sent[0][0] == "me@zzet.invalid" and _sent[0][1] == "[Test] ZZET BG Sample group"
            and "Sample unit A" in _sent[0][2] and "Test sent to me@zzet.invalid" in b, [x[:2] for x in _sent])
    s.check("...logged as a test, not as a reminder", H.one(
        a, "SELECT COUNT(*) FROM notifications WHERE id>? AND kind='email_test' AND to_email='me@zzet.invalid'",
        (NOTE0,)) == 1)
    _sent.clear()
    for k in _KINDS:
        tid = H.one(a, "SELECT id FROM email_templates WHERE email=? AND usual=1 AND retired_at IS NULL", (k["key"],))
        post({"action": "test", "email": k["key"], "tid": tid, "test_to": "me@zzet.invalid"})
    s.check("every email's test goes", len(_sent) == len(_KINDS) and all(
        x[1].startswith("[Test] ") and "{" not in x[1] for x in _sent), [x[1] for x in _sent])
    # -----------------------------------------------------------------------
    s.section("Everyone's reminder: the countdown subject and opening (Chris, 4 Nov 2026)")
    EMPU = dict(EMP)
    ITEM = {"group": "own", "role": "own", "text": "Enter your KPI results and submit", "detail": "", "closes": "",
            "url": "/review", "closes_on": None}

    def mail(days, n=2, extra=()):
        its = [dict(ITEM, closes_on=(today + timedelta(days=days)) if days is not None else None)
               for _ in range(n)] + list(extra)
        return ctx(lambda d: a.reminder_mail(EMPU, its, a.active_cycle(d), tpl=dict(a.REMINDER_TPL_DEFAULT), db=d))
    subj, body = mail(0)
    s.check("closing today: 'Last day: 2 things you need to do in AI+ OneHR'",
            subj == "Last day: 2 things you need to do in AI+ OneHR", subj)
    s.check("closing tomorrow: '2 days left: '", mail(1)[0] == "2 days left: 2 things you need to do in AI+ OneHR", mail(1)[0])
    s.check("closing in 3 days: '4 days left: '", mail(3)[0] == "4 days left: 2 things you need to do in AI+ OneHR", mail(3)[0])
    s.check("already past the date reads as the last day", mail(-2)[0].startswith("Last day: "))
    flat = lambda h_: re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html.unescape(h_)))   # noqa: E731
    s.check("the same days as the email's 'Closes first' callout", all(
        ("%d days left" % (k + 1)) in flat(mail(k)[1]) and mail(k)[0].startswith("%d days left" % (k + 1))
        for k in (1, 3, 6)) and "last day" in flat(mail(0)[1]), flat(mail(1)[1])[:400])
    # every day count in the email is the subject's (Chris 4 Nov: "make them match")
    def counts(days, extra_days=()):
        its = [dict(ITEM, closes_on=today + timedelta(days=days))] + [dict(ITEM, closes_on=today + timedelta(days=x))
                                                                      for x in extra_days]
        sj, bd = ctx(lambda d: a.reminder_mail(EMPU, its, a.active_cycle(d), tpl=dict(a.REMINDER_TPL_DEFAULT), db=d))
        return sj, flat(bd)
    for k_, word_ in ((3, "4 days left"), (1, "2 days left")):
        sj_, fb_ = counts(k_, (6,))
        s.check("closes in %d day(s): subject, 'Closes first', the line under the heading and the item chip all say %s"
                % (k_, word_), sj_.startswith(word_ + ": ") and ("%s." % word_) in fb_.split("Closes first")[0]
                and re.search(r"Closes first .*? %s %s\b" % (a._em_day(today + timedelta(days=k_)), word_), fb_) is not None
                and ("%s · %s" % (word_, a._em_day(today + timedelta(days=k_)))) in fb_, fb_[:500])
    sj_, fb_ = counts(3, (6,))
    s.check("the sub-line: 'The first closes on <day>: 4 days left.'", ("The first closes on %s: 4 days left."
            % a._em_day(today + timedelta(days=3))) in fb_ and "closes in 3 days" not in fb_ and "3 days ·" not in fb_, fb_[:400])
    sj_, fb_ = counts(1, (6,))
    s.check("tomorrow's sub-line: 'The first closes tomorrow, <day>: 2 days left.'", (
        "The first closes tomorrow, %s: 2 days left." % a._em_day(today + timedelta(days=1))) in fb_ and "Tomorrow ·" not in fb_, fb_[:400])
    sj_, fb_ = counts(0, (6,))
    s.check("closes today: subject 'Last day', sub-line 'closes today', callout 'Today / last day', chip 'Last day · <day>'",
            sj_.startswith("Last day: ") and "The first closes today." in fb_ and re.search(r"Closes first .*? %s Today last day" % a._em_day(today), fb_)
            and ("Last day · %s" % a._em_day(today)) in fb_ and "Today ·" not in fb_, fb_[:500])
    sj_, fb_ = counts(3, (6,))
    s.check("a second item closing later shows its own count: in 6 days, '7 days left · <day>'",
            ("7 days left · %s" % a._em_day(today + timedelta(days=6))) in fb_
            and ("4 days left · %s" % a._em_day(today + timedelta(days=3))) in fb_, fb_[:600])
    s.check("one helper, read by the subject, the callout, the sub-line and the chip", all(
        a._em_left(today + timedelta(days=k_), today)[0].split(" · ")[0]
        == ("Last day" if k_ <= 0 else "%d days left" % a._reminder_days_left(today + timedelta(days=k_), today))
        and a._reminder_days_left(today + timedelta(days=k_), today) == (k_ + 1 if k_ > 0 else 0) for k_ in (-2, 0, 1, 3, 6)))
    s.check("tones stay by date: red on the last day, amber up to 3 days out, neutral after", [
        a._em_left(today + timedelta(days=k_), today)[1] for k_ in (0, 1, 3, 4, 6)] == ["r", "w", "w", "", ""])
    # falsify: the old chip counted differently ('3 days'), so the cross-check above would have failed on it
    _old_chip = lambda n_: "Today" if n_ <= 0 else "Tomorrow" if n_ == 1 else "%d days" % n_   # noqa: E731
    s.check("falsified: the old chip for 3 days out ('3 days') differs from the subject's count ('4 days left')",
            _old_chip(3) != "%d days left" % a._reminder_days_left(today + timedelta(days=3), today)
            and _old_chip(1) == "Tomorrow")
    s.check("no dated item: 'Reminder: '", mail(None)[0] == "Reminder: 2 things you need to do in AI+ OneHR", mail(None)[0])
    s.check("one thing is '1 thing', two are '2 things'", mail(3, n=1)[0] == "4 days left: 1 thing you need to do in AI+ OneHR"
            and mail(None, n=1)[0] == "Reminder: 1 thing you need to do in AI+ OneHR" and "2 things" in mail(3)[0])
    s.check("the earliest date counts, not the first item's", ctx(lambda d: a.reminder_mail(
        EMPU, [dict(ITEM, closes_on=today + timedelta(days=9)), dict(ITEM, closes_on=today + timedelta(days=1))],
        a.active_cycle(d), tpl=dict(a.REMINDER_TPL_DEFAULT), db=d))[0].startswith("2 days left: "))
    ob = html.unescape(body)
    s.check("the opening: you must finish before the deadline, the old wording gone",
            "You must finish it before the deadline: once a part closes, it can only be read." in ob
            and "worth finishing" not in ob)
    s.check("heading, button and closing are as they were", "2 things are still waiting on you" in ob
            and "Continue in AI+ OneHR" in ob and "a submitted part is final" in ob)
    s.check("days_left and tasks are placeholders on the page's chips and in the template check",
            all(p_ in a.REMINDER_PLACEHOLDERS for p_ in ("days_left", "tasks"))
            and all(p_ not in a.GRADEH_REMINDER_PLACEHOLDERS for p_ in ("days_left", "tasks"))
            and not a._tpl_words_from({"subject": "{days_left}: {tasks} to do"}, a.REMINDER_TPL_FIELDS,
                                      a.REMINDER_PLACEHOLDERS, a.REMINDER_TPL_DEFAULT, ())[1]
            and a._tpl_words_from({"subject": "{zz_nope}"}, a.REMINDER_TPL_FIELDS, a.REMINDER_PLACEHOLDERS,
                                  a.REMINDER_TPL_DEFAULT, ())[1])
    pv = text(sup.get("/admin/emails?tid=%d" % tpl_id("reminder", "Reminder"))) if tpl_id("reminder", "Reminder") else ""
    s.check("the editor offers both as chips", "{days_left}" in pv and "{tasks}" in pv)

    # the one-time rewording of what is SAVED (production already holds a saved Reminder row)
    OLDS, OLDO = a._REMINDER_SUBJECT_BEFORE_COUNTDOWN, a._REMINDER_OPENING_BEFORE_COUNTDOWN
    s.check("the old defaults are the words production holds, the new ones differ", OLDS == "Reminder: {count} {things} "
            "waiting on you in AI+ OneHR" and OLDS != a.DEFAULT_REMINDER_ALL_SUBJECT and OLDO != a.REMINDER_TPL_DEFAULT["opening"]
            and a.REMINDER_TPL_DEFAULT["subject"] == a.DEFAULT_REMINDER_ALL_SUBJECT)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM email_templates")
        db.execute("DELETE FROM app_settings WHERE key IN (%s)" % ",".join("?" * len(KEYS)), KEYS)

        def put(email, name, w, retired=False):
            return db.execute("INSERT INTO email_templates(email, name, words, usual, retired_at) VALUES (?,?,?,?,?)",
                              (email, name, w if isinstance(w, str) else json.dumps(w), 0,
                               "2026-01-01" if retired else None)).lastrowid

        def got(i):
            return json.loads(db.execute("SELECT words FROM email_templates WHERE id=?", (i,)).fetchone()[0])
        base_w = dict(a.REMINDER_TPL_DEFAULT, subject=OLDS, opening=OLDO)
        r_old = put("reminder", "ZZRW old", base_w)
        r_sub = put("reminder", "ZZRW edited subject", dict(base_w, subject="Don't forget, {first_name}"))
        r_open = put("reminder", "ZZRW edited opening", dict(base_w, opening="Hi, a short note."))
        r_new = put("reminder", "ZZRW already new", dict(a.REMINDER_TPL_DEFAULT))
        r_ret = put("reminder", "ZZRW retired", base_w, retired=True)
        r_bad = put("reminder", "ZZRW bad json", "{not json")
        r_oth = put("lp_buceo", "ZZRW other kind", dict(base_w))
        r_gh = put("gradeh_reminder", "ZZRW gradeh", {"subject": OLDS})
        db.execute("INSERT INTO app_settings(key, value) VALUES ('reminder_template', ?)", (json.dumps(base_w),))
        db.execute("INSERT INTO app_settings(key, value) VALUES ('reminder_all_subject', ?)", (OLDS,))
        db.execute("INSERT INTO app_settings(key, value) VALUES ('reminder_all_opening', ?)", ("My own opening",))
        db.commit()
        n1 = a._reminder_countdown_reword(db)
        db.commit()
        s.check("a saved row holding the old subject and opening exactly gets the new words",
                got(r_old)["subject"] == a.DEFAULT_REMINDER_ALL_SUBJECT and got(r_old)["opening"] == a.REMINDER_TPL_DEFAULT["opening"]
                and got(r_old)["heading"] == base_w["heading"])
        s.check("an edited subject is kept (its old opening still moves)", got(r_sub)["subject"] == "Don't forget, {first_name}"
                and got(r_sub)["opening"] == a.REMINDER_TPL_DEFAULT["opening"])
        s.check("an edited opening is kept (its old subject still moves)", got(r_open)["opening"] == "Hi, a short note."
                and got(r_open)["subject"] == a.DEFAULT_REMINDER_ALL_SUBJECT)
        s.check("a row already on the new words is untouched", got(r_new) == dict(a.REMINDER_TPL_DEFAULT))
        s.check("a retired row, a row with malformed JSON, another email kind and Grade H's reminder are all left as they were",
                got(r_ret) == base_w and db.execute("SELECT words FROM email_templates WHERE id=?", (r_bad,)).fetchone()[0]
                == "{not json" and got(r_oth) == base_w and got(r_gh) == {"subject": OLDS})
        s.check("the older settings: 'reminder_template' moved, 'reminder_all_subject' moved, an own 'reminder_all_opening' kept",
                json.loads(db.execute("SELECT value FROM app_settings WHERE key='reminder_template'").fetchone()[0])
                == dict(base_w, subject=a.DEFAULT_REMINDER_ALL_SUBJECT, opening=a.REMINDER_TPL_DEFAULT["opening"])
                and db.execute("SELECT value FROM app_settings WHERE key='reminder_all_subject'").fetchone()[0]
                == a.DEFAULT_REMINDER_ALL_SUBJECT
                and db.execute("SELECT value FROM app_settings WHERE key='reminder_all_opening'").fetchone()[0] == "My own opening")
        s.check("it counted the rows it changed (3 templates, 2 settings)", n1 == 5, n1)
        snap = ([tuple(r) for r in db.execute("SELECT id, words FROM email_templates ORDER BY id")],
                [tuple(r) for r in db.execute("SELECT key, value FROM app_settings WHERE key LIKE 'reminder%' ORDER BY key")])
        n2 = a._reminder_countdown_reword(db)
        db.commit()
        snap2 = ([tuple(r) for r in db.execute("SELECT id, words FROM email_templates ORDER BY id")],
                 [tuple(r) for r in db.execute("SELECT key, value FROM app_settings WHERE key LIKE 'reminder%' ORDER BY key")])
        s.check("a second run changes nothing (idempotent)", n2 == 0 and snap == snap2, n2)
        # falsify the guard: an unguarded rewrite would have overwritten the admin's own subject
        s.check("falsified: without the exact-match guard the edited subject would have been replaced",
                a._REMINDER_REWORD["subject"][0] != got(r_sub)["subject"] and a._REMINDER_REWORD["opening"][0] != got(r_open)["opening"])
        # the boot runs it: a boot-time call over an old row (what the deploy's migrate step does)
        db.execute("UPDATE email_templates SET words=? WHERE id=?", (json.dumps(base_w), r_old))
        db.commit()
        a._ensure_runtime_schema()
        s.check("the migration step (_ensure_runtime_schema) runs it too", got(r_old)["subject"] == a.DEFAULT_REMINDER_ALL_SUBJECT)
        db.execute("DELETE FROM email_templates")
        db.execute("DELETE FROM app_settings WHERE key IN (%s)" % ",".join("?" * len(KEYS)), KEYS)
        db.commit()
    src_rw = H.source(a, "app.py")
    s.check("only Everyone's reminder is named in the rewording (no other email kind)", "email='reminder'" in src_rw
            and "        _reminder_countdown_reword(c)\n" in src_rw)
finally:
    a.mailer.send_mail, a.mailer.config_status = _real
    with a.app.app_context():
        db = a.get_db()
        H.restore_email_templates(db, TPLS)
        db.execute("DELETE FROM app_settings WHERE key IN (%s)" % ",".join("?" * len(KEYS)), KEYS)
        for k, v in SAVED.items():
            db.execute("INSERT INTO app_settings(key, value) VALUES (?,?)", (k, v))
        db.execute("DELETE FROM activity_log WHERE id>? AND action IN ('email_template', 'reminder_content')", (LOG0,))
        db.execute("DELETE FROM notifications WHERE id>? AND to_email LIKE '%@zzet.invalid'", (NOTE0,))
        db.commit()

sys.exit(s.done())
