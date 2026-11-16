"""Email > Schedule's top card, "On their own schedule" (Chris, 2026-11-09: "we should have toggle for all schedules", "One Grade H switch";
canvas board A1, approved "Yes, as drawn"). It replaced the two top cards: Everyone's reminder's bar and (2026-11-08) "Emails to leaders".

What this suite holds:
  * the card: ONE card with its heading, a row an email in the brief's order (Everyone's reminder, Grade H reminders only where Grade H runs,
    Leader progress, BG admin status, Ready for you), each with a switch, its name, "Next: <day>, <time>" (bold) and one muted line, Set it up
    on its own page or anchor; Send now on Everyone's reminder only; the old bar and leaders card are gone
  * the switch is the setting its Set it up page saves, through ONE writer each (reminder_switch_set, lp_switch_set, bga_switch_set,
    ready_switch_set, gradeh_switch_set), with OneHR's confirm box per flip ("Stop Leader progress? No leader progress email goes until you
    switch it back on."), an audit row, and an off row that reads "Off · nothing goes on its own"
  * the Next lines are the senders' own readers (the figures agree), the card's words for no cycle / no send day
  * POST /admin/email/switch is the super admin's alone; an unknown email or value is a 400; Grade H has no switch where it does not run
  * the Grade H switch: no row = on; flipped off it is one setting that every Grade H email reads (test_gradeh_leader_email holds the rest)
  * the two old list rows stay gone from "Not on the calendar"
Everything here is put back at the end."""
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Email > Schedule: the top card, a switch for every schedule")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
sup = H.client_as(a, SU["id"])
bga = H.client_as(a, BGA["id"]) if BGA else None
KEYS = ("leader_progress_rules", "ready_notice_rules", "bg_admin_progress_rules", "reminder_auto_enabled", "gradeh_reminders_enabled",
        "reminder_days_before", "reminder_on_open", "reminder_every_days", "reminder_send_time")
with a.app.app_context():
    SAVED = {k: a.get_db().execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone() for k in KEYS}


def put(key, val, raw=False):
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM app_settings WHERE key=?", (key,))
        if val is not None:
            d.execute("INSERT INTO app_settings(key,value) VALUES (?,?)", (key, val if raw else json.dumps(val)))
        d.commit()


def getset(key):
    with a.app.app_context():
        r = a.get_db().execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
        return r[0] if r else None


def page(url="/admin/email", c=None):
    r = (c or sup).get(url)
    return r.status_code, html.unescape(r.get_data(as_text=True))


def row(body, key):
    m = re.search(r'<div class="eml-own-row[^"]*" data-eml-row="%s">(.*?)\n    </div>\n' % key, body, re.S)
    return m.group(1) if m else ""


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def flip(email, to, c=None):
    return (c or sup).post("/admin/email/switch", data={"csrf_token": "tok", "email": email, "enabled": to}, follow_redirects=True)


def audits(action):
    with a.app.app_context():
        return a.get_db().execute("SELECT detail FROM activity_log WHERE action=? ORDER BY id DESC", (action,)).fetchall()


LP = {"enabled": True, "freq": "every", "every_days": 1, "send_time": "08:30", "roles": ["bgceo", "buceo", "cg", "hod"],
      "parts": ["pm_approve", "tc_approve"], "skip_done": True}
try:
    put("reminder_days_before", [1, 0])
    put("reminder_on_open", "1", raw=True)
    put("reminder_send_time", "09:00", raw=True)
    put("reminder_auto_enabled", "1", raw=True)
    put("leader_progress_rules", LP)
    put("ready_notice_rules", {"enabled": True, "send_time": "08:30", "roles": ["hod", "buceo"]})
    put("bg_admin_progress_rules", {"enabled": True, "send_time": "08:30", "parts": ["pm_approve"]})
    put("gradeh_reminders_enabled", None)

    s.section("the card: one card, a row an email, in the brief's order")
    code, b = page()
    s.check("Schedule opens for the super admin", code == 200)
    s.check("ONE card, 'On their own schedule', with its words; the two cards it replaced are gone", 'id="eml-own-h">On their own schedule</h2>' in b
            and "Counts only, never a name." in b and 'class="admin-card eml-bar"' not in b and 'class="admin-card eml-leaders"' not in b
            and "Emails to leaders" not in b)
    s.check("...right above the calendar", b.index("eml-own-h") < b.index('class="admin-card ecal"'))
    names = re.findall(r'data-eml-row="(\w+)"', b)
    gh_on = ctx(lambda d: bool(a.gradeh_rm_cid(d)))
    s.check("rows in order: Everyone's reminder, [Grade H reminders where Grade H runs], Leader progress, BG admin status, Ready for you",
            names == (["reminder", "gradeh"] if gh_on else ["reminder"]) + ["lp", "bga", "ready"], names)
    s.check("...here Grade H does not run (no ONEHR_GRADEH), so it has no row and no switch", not gh_on and 'data-eml-row="gradeh"' not in b)
    rows = {k: row(b, k) for k in ("reminder", "lp", "bga", "ready")}
    s.check("every row is found, with a switch button, its name and a Set it up", all(
        rows[k] and 'role="switch"' in rows[k] and "Set it up" in rows[k] for k in rows) and all(
        n in rows[k] for k, n in (("reminder", "Everyone's reminder"), ("lp", "Leader progress"), ("bga", "BG admin status"), ("ready", "Ready for you"))))
    s.check("each switch is a form posting to /admin/email/switch with its email and the opposite value", all(
        ('action="/admin/email/switch"' in rows[k] and ('name="email" value="%s"' % k) in rows[k] and 'name="enabled" value="off"' in rows[k])
        for k in rows))
    s.check("the switches are On (aria-checked=true) and say so with the switch class", all(
        'aria-checked="true"' in rows[k] and "eml-switch is-on" in rows[k] for k in rows))
    s.check("Set it up goes to its own page or anchor", 'href="/admin/reminders">Set it up' in rows["reminder"]
            and 'href="/admin/reminders/leaders">Set it up' in rows["lp"] and 'href="/admin/reminders/leaders#bga">Set it up' in rows["bga"]
            and 'href="/admin/reminders/leaders#ready">Set it up' in rows["ready"])
    s.check("...the anchors are real ones on the Leader progress page", all(x in page("/admin/reminders/leaders")[1] for x in ('id="ready"', 'id="bga"')))
    s.check("Send now is on Everyone's reminder's row only", "Send now" in rows["reminder"] and not any("Send now" in rows[k] for k in ("lp", "bga", "ready")))
    s.check("the foot links to Email > Sent", 'href="/admin/email/sent">What went out: Email › Sent ›' in b)
    s.check("each switch carries OneHR's confirm box: a title, the message, the verb on its button; navy, not red (a Stop can be switched back on)",
            all(("data-confirm-title=" in rows[k] and "data-confirm-ok=" in rows[k] and "data-confirm-tone" not in rows[k]) for k in rows)
            and 'data-confirm="No leader progress email goes until you switch it back on." data-confirm-title="Stop Leader progress?" '
                'data-confirm-ok="Stop Leader progress"' in rows["lp"])
    s.check("...the reminder's words are the ones its old switch had", "Stop sending everyone&#39;s reminder on its own?" in rows["reminder"].replace("'", "&#39;")
            or "Stop sending everyone's reminder on its own?" in rows["reminder"])

    s.section("the Next lines: the senders' own readers, bold, with one muted line")
    nx_lp = ctx(lambda d: a.lp_next_send(d, a.active_cycle(d), dict(LP)))
    s.check("Leader progress: 'Next: <day>, 08:30' is lp_next_send's", (re.search(r"<b>Next: (\w{3} \d+ \w{3}), 08:30</b>", rows["lp"]) is not None
                                                                    and nx_lp is not None
                                                                    and ("Next: %s, 08:30" % ctx(lambda d: a._em_day(nx_lp))) in rows["lp"]), rows["lp"][:400])
    s.check("...with the rule in words as the muted line", "Every day" in rows["lp"] and 'class="muted small"' in rows["lp"])
    nx_r = ctx(lambda d: a.reminder_next_send(d, a.active_cycle(d)))
    s.check("Everyone's reminder: its Next is reminder_next_send's, 'up to N people' under it",
            (nx_r[0] is None and "Nothing to send in the next 90 days" in rows["reminder"])
            or (("Next: %s, 09:00" % ctx(lambda d: a._em_day(nx_r[0]))) in rows["reminder"] and "up to " in rows["reminder"] and "people" in rows["reminder"]), rows["reminder"][:400])
    nx_b = ctx(lambda d: a.bga_next_send(d, a.active_cycle(d), a.bga_rules()))
    s.check("BG admin status: its Next is bga_next_send's (a send time), the muted line says every day while a part is open",
            ((nx_b is None and "No send day in the next two months" in rows["bga"]) or ("Next: %s, 08:30" % ctx(lambda d: a._em_day(nx_b))) in rows["bga"])
            and "Every day while a part it counts is open" in rows["bga"], rows["bga"][:400])
    s.check("Ready for you: on no date, so 'Checked daily at 08:30' and no Next", "<b>Checked daily at 08:30</b>" in rows["ready"] and "Next:" not in rows["ready"]
            and "Once per place, when the tier below is done" in rows["ready"])
    s.check("none of the Who chips are on the page any more (they move into the day panel, piece B)", "eml-rc" not in b and "eml-lr " not in b)

    s.section("a switch is the setting its Set it up page saves, through one writer; a confirm, an audit row, 'Off · nothing goes on its own'")
    # Leader progress
    r = flip("lp", "off")
    saved = json.loads(getset("leader_progress_rules"))
    s.check("Leader progress off: the same JSON setting the page saves, 'enabled' false, every other rule kept", saved["enabled"] is False
            and {k: v for k, v in saved.items() if k not in ("enabled", "since")} == {k: v for k, v in dict(a.LP_DEFAULT_RULES, **LP).items()
                                                                                     if k not in ("enabled", "since")})
    s.check("...says so, and the audit row is the page's own (leader_progress_schedule)", "doesn't go out on its own" in html.unescape(r.get_data(as_text=True))
            and any("on=False" in x[0] for x in audits("leader_progress_schedule")))
    code, b = page()
    s.check("...the row reads 'Off · nothing goes on its own', with the switch off and Start in its confirm", "Off · nothing goes on its own" in row(b, "lp")
            and 'aria-checked="false"' in row(b, "lp") and 'data-confirm-title="Start Leader progress?"' in row(b, "lp")
            and 'name="enabled" value="on"' in row(b, "lp") and "Next:" not in row(b, "lp"))
    flip("lp", "on")
    s.check("...and back on, the same rules", json.loads(getset("leader_progress_rules"))["enabled"] is True)
    # the page's own save writes through the same function
    ok_, msg = ctx(lambda d: a.lp_switch_set(d, SU, False))
    s.check("lp_switch_set is the writer (and the page's own save is lp_rules_save, which it calls)", ok_ and "lp_rules_save(db, me, rules)" in H.source(a)
            and "flash(lp_rules_save(db, me, rules)" in H.source(a), msg)
    ctx(lambda d: a.lp_switch_set(d, SU, True))
    put("leader_progress_rules", dict(LP, roles=[]))
    r = flip("lp", "on")
    s.check("Starting Leader progress with nobody ticked is refused, naming what to do, nothing written", "Tick who gets it first" in html.unescape(r.get_data(as_text=True))
            and json.loads(getset("leader_progress_rules"))["roles"] == [])
    put("leader_progress_rules", LP)
    # BG admin status
    flip("bga", "off")
    s.check("BG admin status off: bg_admin_progress_rules.enabled false, the parts kept", json.loads(getset("bg_admin_progress_rules"))["enabled"] is False
            and json.loads(getset("bg_admin_progress_rules"))["parts"] == ["pm_approve"] and any("on=False" in x[0] for x in audits("bg_admin_progress_schedule")))
    s.check("...its row reads Off", "Off · nothing goes on its own" in row(page()[1], "bga"))
    flip("bga", "on")
    s.check("...and back on", json.loads(getset("bg_admin_progress_rules"))["enabled"] is True)
    # Ready for you
    flip("ready", "off")
    s.check("Ready for you off: ready_notice_rules.enabled false, roles kept, audited", json.loads(getset("ready_notice_rules"))["enabled"] is False
            and json.loads(getset("ready_notice_rules"))["roles"] == ["hod", "buceo"] and any("on=False" in x[0] for x in audits("ready_notice_schedule")))
    s.check("...its row reads Off", "Off · nothing goes on its own" in row(page()[1], "ready"))
    flip("ready", "on")
    # Everyone's reminder
    r = flip("reminder", "off")
    s.check("Everyone's reminder off: reminder_auto_enabled 0, its rules kept (days before, on open, time)", getset("reminder_auto_enabled") == "0"
            and json.loads(getset("reminder_days_before")) == [1, 0] and getset("reminder_on_open") == "1" and getset("reminder_send_time") == "09:00")
    s.check("...the audit row is its page's own (reminder_schedule), and its Send now still works (the form is there)",
            any("on=False" in x[0] for x in audits("reminder_schedule")) and "Send now" in row(page()[1], "reminder"))
    s.check("...the row reads 'Off · nothing goes on its own' and 'Send now still works.'", "Off · nothing goes on its own" in row(page()[1], "reminder")
            and "Send now still works." in row(page()[1], "reminder"))
    flip("reminder", "on")
    s.check("...and back on", getset("reminder_auto_enabled") == "1")
    r = sup.post("/admin/reminders", data={"csrf_token": "tok", "action": "auto", "enabled": "off"}, follow_redirects=False)
    s.check("Everyone's reminder's own page still posts the same switch (action=auto), through the same writer", getset("reminder_auto_enabled") == "0"
            and r.status_code == 302 and "reminder_switch_set(db, me" in H.source(a))
    flip("reminder", "on")
    put("reminder_days_before", [])
    put("reminder_on_open", "0", raw=True)
    put("reminder_every_days", "0", raw=True)
    put("reminder_auto_enabled", "0", raw=True)
    r = flip("reminder", "on")
    s.check("Everyone's reminder can't start with no rule at all: refused, naming what to set first", "Set when it goes first" in html.unescape(r.get_data(as_text=True))
            and getset("reminder_auto_enabled") == "0")
    put("reminder_days_before", [1, 0])
    put("reminder_on_open", "1", raw=True)
    put("reminder_auto_enabled", "1", raw=True)

    s.section("the route: the super admin's alone, an unknown email or value is a 400")
    s.check("POST /admin/email/switch is the super admin's in the access map", a.ADMIN_ACCESS_MAP.get("admin_email_switch") == "super")
    s.check("an unknown email is a 400", sup.post("/admin/email/switch", data={"csrf_token": "tok", "email": "nope", "enabled": "on"}).status_code == 400)
    s.check("an unknown value is a 400", sup.post("/admin/email/switch", data={"csrf_token": "tok", "email": "lp", "enabled": "maybe"}).status_code == 400)
    s.check("Grade H has no switch where it does not run (a 404, nothing written)", sup.post(
        "/admin/email/switch", data={"csrf_token": "tok", "email": "gradeh", "enabled": "off"}).status_code == 404 and getset("gradeh_reminders_enabled") is None)
    if bga is not None:
        s.check("a BG admin can't flip one (403), nothing written", bga.post("/admin/email/switch", data={"csrf_token": "tok", "email": "lp", "enabled": "off"}).status_code == 403
                and json.loads(getset("leader_progress_rules"))["enabled"] is True)
        r = bga.get("/admin/email")
        s.check("...nor open Email > Schedule at all", r.status_code in (302, 403, 404))
    s.check("the route is behind super_required, as the page is", "@super_required" in H.source(a)[H.source(a).index("def admin_email_switch") - 90:H.source(a).index("def admin_email_switch")])

    s.section("the Grade H switch: no row = on; one setting; the writer audits it")
    s.check("no row = on", ctx(lambda d: a.gradeh_reminders_on(d)) is True)
    ok_, msg = ctx(lambda d: a.gradeh_switch_set(d, SU, False))
    s.check("off: one setting, gradeh_reminders_enabled = 0, one audit row naming what it covers", ok_ and getset("gradeh_reminders_enabled") == "0"
            and ctx(lambda d: a.gradeh_reminders_on(d)) is False and any("the staff email" in x[0] for x in audits("gradeh_reminders_switch")), msg)
    s.check("...gradeh_rm_active is None whatever the module says; gradeh_rm_cid itself (where Grade H runs) is not the switch's", ctx(lambda d: a.gradeh_rm_active(d)) is None)
    ctx(lambda d: a.gradeh_switch_set(d, SU, True))
    s.check("on again", getset("gradeh_reminders_enabled") == "1" and ctx(lambda d: a.gradeh_reminders_on(d)) is True)
    put("gradeh_reminders_enabled", None)

    s.section("no cycle: the card says so; Off and On with nothing to send")
    put("leader_progress_rules", dict(LP, range_from="2020-01-01", range_to="2020-01-02"))
    s.check("Leader progress On with no send day: the Leader progress page's own words", "No send day in the next two months" in row(page()[1], "lp")
            and "Next:" not in row(page()[1], "lp"))
    put("leader_progress_rules", dict(LP, roles=[]))
    s.check("...with nobody ticked: 'Nobody is ticked to get it'", "Nobody is ticked to get it" in row(page()[1], "lp"))
    put("leader_progress_rules", LP)
    rows_ = ctx(lambda d: a.email_schedule_rows(d, None, None))
    s.check("with no active cycle: Everyone's reminder says so, and a row still has its switch, name and Set it up",
            rows_[0]["when"] == "There is no active cycle" and all(r_["setup"] and r_["name"] for r_ in rows_) and [r_["key"] for r_ in rows_] == ["reminder", "lp", "bga", "ready"])

    s.section("the calendar below it: Leader progress and BG admin status are days on it, not rows; 'Not on a date' holds what goes on an action")
    code, b = page()
    cal = b[b.index('class="admin-card ecal"'):]
    s.check("'Not on a date' holds the release row and Ready for you, and no row for Leader progress or BG admin status", "Not on a date" in cal
            and "<b>Leader progress</b>" not in cal and "<b>BG admin status</b>" not in cal and "When you release results" in cal)
    s.check("the chips filter by reloading (links with ?show=), so the top card has no filter hooks", "data-eml-mod" not in b and "data-eml-show" not in b and "?m=" in cal)
finally:
    with a.app.app_context():
        d = a.get_db()
        for k, v in SAVED.items():
            d.execute("DELETE FROM app_settings WHERE key=?", (k,))
            if v is not None:
                d.execute("INSERT INTO app_settings(key,value) VALUES (?,?)", (k, v[0]))
        d.commit()

sys.exit(s.done())
