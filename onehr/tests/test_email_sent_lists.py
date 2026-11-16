"""Email > Sent: every run opens its people, BG admin status and Admin notices (Chris, 2026-11-03: "for sent, add in email sent to
admin too, and can we keep each item open into right panel to show the person and email successfully send, or failed"; canvas
[design canvas link removed], boards A to E, "Yes, as drawn"; he picked "BG admin + notices").

What this suite holds (its own synthetic people, ZZES-*, on the shared suite database; everything it writes is put back):
  * each run knows its emails: reminder_send, lp_send and bga_send put " | batch <key>" on their activity row and, for the two new
    ones, on their outbox rows; reminder_runs / lp_runs / bga_runs read the row exactly as before (the batch bit is skipped by the
    parsers); the progress bar (outbox_sends) never shows an lp- or bga- batch
  * the run-time skips are logged for the panel to name (the reminder's cooldown, a leader's or a BG admin's nothing to report),
    and a 'skipped' row changes nothing the cooldown reads
  * one classification (sent / failed / waiting / not sent) serves the page's second lines and the panel's chips and rows: the
    numbers agree, for a run that names its batch and for the same run read by time (a run from before this release)
  * the panel: chips over the whole run, show= and Search in are server parameters, Failed first, an error never a stack trace,
    a person's row opens them, an address with no account has no Open, the 500-row cap, the progress bar's two links
  * Admin notices: the admin-task emails and the admin copy of Help / sign-in help (a person's own copy drops out), by MYT day, the
    last 14 days, one read; the four lists are the super admin's alone
  * one grouped read a card, never one per run
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
s = H.Suite("Email > Sent: every run opens its people")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
assert not a.mailer.is_configured(), "the harness must not send email"
BG, U1 = "ZZES Group", "ZZES Unit"
TOKEN = "ZZES-"
DOMAIN = "@zzes.invalid"
ID = {}


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def one(sql, args=()):
    return ctx(lambda d: d.execute(sql, args).fetchone()[0])


def run_sql(sql, args=()):
    def f(d):
        d.execute(sql, args)
        d.commit()
    ctx(f)


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE ?", (TOKEN + "%",))]
    if ul:
        ph = ",".join("?" * len(ul))
        for tbl in ("email_optouts", "email_outbox", "notifications", "admin_notify_emails"):
            db.execute("DELETE FROM %s WHERE user_id IN (%s)" % (tbl, ph), ul)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM email_outbox WHERE to_email LIKE ?", ("%" + DOMAIN,))
    db.execute("DELETE FROM notifications WHERE to_email LIKE ? OR created_at >= '2030-01-01'", ("%" + DOMAIN,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


SET_KEYS = ("email_wave_on", "email_wave_size", "email_wave_gap", "leader_progress_rules", "bg_admin_progress_rules")
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CYC = db.execute("SELECT * FROM cycles WHERE is_active=1").fetchone()
    CID = CYC["id"]
    # what other suites left of these emails' logs is set aside (a run is found by the window since the run before it, so another
    # suite's row of the same kind an hour ago would be this suite's); given back at the end
    NF_KINDS = (a.REMINDER_KIND, a.GRADEH_REMINDER_KIND, a.LP_KIND, a.BGA_KIND, a.ADMIN_TASK_KIND, a.HELP_KIND, a.SIGNIN_HELP_KIND)
    RUN_ACTIONS = ("reminder_run", "leader_progress_run", "bg_admin_progress_run")
    STASH = {"email_outbox": [dict(r) for r in db.execute("SELECT * FROM email_outbox")],
             "notifications": [dict(r) for r in db.execute("SELECT * FROM notifications WHERE kind IN (%s)" % ",".join("?" * len(NF_KINDS)),
                                                           NF_KINDS)],
             "activity_log": [dict(r) for r in db.execute("SELECT * FROM activity_log WHERE action IN (%s)" % ",".join("?" * len(RUN_ACTIONS)),
                                                          RUN_ACTIONS)]}
    db.execute("DELETE FROM email_outbox")
    db.execute("DELETE FROM notifications WHERE kind IN (%s)" % ",".join("?" * len(NF_KINDS)), NF_KINDS)
    db.execute("DELETE FROM activity_log WHERE action IN (%s)" % ",".join("?" * len(RUN_ACTIONS)), RUN_ACTIONS)
    db.commit()
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    OUT0 = db.execute("SELECT COALESCE(MAX(id),0) FROM email_outbox").fetchone()[0]
    NF0 = db.execute("SELECT COALESCE(MAX(id),0) FROM notifications").fetchone()[0]
    KEPT = [dict(r) for r in db.execute("SELECT * FROM email_optouts")]
    db.execute("DELETE FROM email_optouts")
    SETTINGS = {k: (db.execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone() or [None])[0] for k in SET_KEYS}
    # waves on, the default: every email of a run is due at once (the suite sets the few it wants later by hand)
    db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('email_wave_on','1'),('email_wave_size','200'),"
               "('email_wave_gap','30')")
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, U1))

    def person(key, role="user", admin_bg=None, email=True, **kw):
        ID[key] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
            "job_grade, years_of_service, email, admin_bg) VALUES (?,?,'x',?,?,?,?,?,?,?,?,?)",
            ("zzes-" + key.lower(), "ZZ ES Person " + key, role, TOKEN + key, BG, U1, "Sales", 14, 3,
             ("zzes-%s%s" % (key.lower(), DOMAIN)) if email else None, admin_bg)).lastrowid
    for k in ("E%d" % i for i in range(1, 14)):
        person(k, email=(k != "E10"))   # E10 has no email on file
    for k in ("L1", "L2", "L3", "L4"):
        person(k)
    person("L5", email=False)
    person("SUP", role="admin")                   # a super admin of our own
    person("BGA", role="admin", admin_bg=BG)      # a BG admin
    person("UNA", role="admin", admin_bg=BG)      # a unit admin (a row in admin_companies)
    person("A1", role="admin", admin_bg=BG)       # group-wide BG admins for the BG admin status email
    person("A2", role="admin", admin_bg=BG)
    person("A3", role="admin", admin_bg=BG)
    person("STAFF")
    db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (ID["UNA"], U1))
    db.commit()

SUP_ID = ID["SUP"]
ITEM = {"group": "own", "role": "own", "text": "Enter your KPI results and submit", "detail": "", "closes": "",
        "url": "/review", "closes_on": None}
_real = (a.reminder_items, a._outbox_kick, a.lp_build, a.lp_mail, a.bga_build, a.bga_mail)
a.reminder_items = lambda db_, u_: [dict(ITEM)] if (u_["employee_id"] or "").startswith(TOKEN) else _real[0](db_, u_)
a._outbox_kick = lambda flask_app=None: False
a.lp_mail = lambda *args, **kw: ("ZZES Leader progress", "<p>x</p>")
a.bga_mail = lambda *args, **kw: ("ZZES BG admin status", "<p>x</p>")
sup = H.client_as(a, SUP_ID)
bga = H.client_as(a, ID["BGA"])
una = H.client_as(a, ID["UNA"])
staff = H.client_as(a, ID["STAFF"])


def user(key):
    return ctx(lambda d: d.execute("SELECT * FROM users WHERE id=?", (ID[key],)).fetchone())


def age(minutes, log0, out0, nf0):
    """Move what a run wrote `minutes` back in time, so the runs of this suite are told apart by their windows (a second
    resolution: two runs in one second would share one)."""
    def f(d):
        d.execute("UPDATE activity_log SET created_at=datetime(created_at, ?) WHERE id>?", ("-%d minutes" % minutes, log0))
        d.execute("UPDATE email_outbox SET created_at=datetime(created_at, ?), send_after=CASE WHEN send_after IS NULL "
                  "THEN NULL ELSE datetime(send_after, ?) END WHERE id>?", ("-%d minutes" % minutes, "-%d minutes" % minutes, out0))
        d.execute("UPDATE notifications SET created_at=datetime(created_at, ?) WHERE id>?", ("-%d minutes" % minutes, nf0))
        d.commit()
    ctx(f)


def marks():
    return (one("SELECT COALESCE(MAX(id),0) FROM activity_log"), one("SELECT COALESCE(MAX(id),0) FROM email_outbox"),
            one("SELECT COALESCE(MAX(id),0) FROM notifications"))


def last_run(action):
    return ctx(lambda d: dict(d.execute("SELECT id, created_at, detail FROM activity_log WHERE action=? ORDER BY id DESC "
                                        "LIMIT 1", (action,)).fetchone()))


def set_user_row(kind_like, key, **cols):
    sets = ", ".join("%s=?" % c for c in cols)
    run_sql("UPDATE email_outbox SET %s WHERE kind LIKE ? AND user_id=?" % sets, list(cols.values()) + [kind_like, ID[key]])


def cooldown(keys):
    return ctx(lambda d: {k: a.reminder_in_cooldown(d, ID[k], CID) for k in keys})


def panel(key, **q):
    qs = "&".join("%s=%s" % (k, v) for k, v in q.items())
    return sup.get("/admin/list/%s?%s&fragment=1" % (key, qs))


def rows_of(body):
    """[(name, state tone, pill words, sub line, has Open)] of a panel's rows, in order."""
    out = []
    for tr in re.findall(r'<tr class="data-row".*?</tr>', body, re.S):
        who = re.search(r"<b>(.*?)</b>", tr, re.S)
        pill = re.search(r'class="clp-pill is-(\w+)"[^>]*>(.*?)</span>(?:<span class="muted small clp-sub[^"]*"[^>]*>(.*?)</span>)?', tr, re.S)
        out.append((html.unescape(who.group(1)) if who else "", pill.group(1) if pill else "",
                    html.unescape(pill.group(2)) if pill else "", html.unescape(pill.group(3) or "") if pill else "",
                    "data-person-open" in tr))
    return out


def chips_of(body):
    """{chip label: n, '_on': the chosen one} from a panel's chips row."""
    out = {}
    for cls, label, n in re.findall(r'<a class="clp-chip([^"]*)" href="[^"]*" data-list-reload[^>]*>(\w[\w ]*?) <b>([\d,]+)</b>', body):
        out[label] = int(n.replace(",", ""))
        if "is-on" in cls:
            out["_on"] = label
    return out


def plain(x):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", x)).split())


def page_row(body, run_id, key):
    """The Email > Sent table row that carries a run's People link, as plain text."""
    for tr in re.findall(r"<tr>.*?</tr>", body, re.S):
        if 'data-list-open="/admin/list/%s?run=%d&amp;fragment=1"' % (key, run_id) in tr:
            return plain(tr)
    return ""


def tally_of(kind, run_id):
    runs = ctx(lambda d: {"reminder": a.reminder_runs, "lp": a.lp_runs, "bga": a.bga_runs}[kind](d, limit=50))
    cards = ctx(lambda d: a.es_cards(d, kind, runs))
    card = next(r for r in cards if r["id"] == run_id)
    return {k: v for k, v in card["es"].items() if k != "ob"}, card


def panel_counts(key, **q):
    c = chips_of(panel(key, **q).get_data(as_text=True))
    return {"sent": c.get("Sent", 0), "failed": c.get("Failed", 0), "waiting": c.get("Waiting", 0), "not_sent": c.get("Not sent", 0),
            "all": c.get("All", 0)}


def sub_text(t):
    bits = ["%s sent" % format(t["sent"], ",")]
    for k, w in (("failed", "failed"), ("not_sent", "not sent"), ("waiting", "waiting")):
        if t[k]:
            bits.append("%s %s" % (format(t[k], ","), w))
    return " · ".join(bits)


try:
    # ---------------------------------------------------------------------------------------------------------------
    s.section("Everyone's reminder: run 1 (a batch, people sent / failed / waiting / not sent) and its activity row")
    l0, o0, n0 = marks()
    ok, said = ctx(lambda d: (a.email_optout_set(d, user("SUP"), user("E5"), ["reminder"], "", "ZZES opted out"), d.commit())[0])
    s.check("(setup) E5 is opted out of Everyone's reminder", ok, said)
    people = [user(k) for k in ("E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10")]
    t1 = ctx(lambda d: a.reminder_send(d, a.active_cycle(d), people, "zz run one", actor_id=SUP_ID, live=True))
    s.check("8 queued, E5 opted out, E10 has no email", t1["queued"] == 8 and t1["opted_out"] == 1 and t1["skipped"] == 1, t1)
    R1 = last_run("reminder_run")
    s.check("the run's activity row names its batch: '| batch reminder-<hex>'",
            re.search(r"\| batch reminder-[0-9a-f]{12}$", R1["detail"]) is not None, R1["detail"])
    B1 = R1["detail"].rsplit("batch ", 1)[1]
    s.check("...and the outbox rows carry that key", one("SELECT COUNT(*) FROM email_outbox WHERE batch=?", (B1,)) == 8)
    stripped = re.sub(r" \| batch \S+$", "", R1["detail"])
    run_sql("UPDATE activity_log SET detail=? WHERE id=?", (stripped, R1["id"]))
    old_parse = ctx(lambda d: a.reminder_runs(d, limit=1))[0]
    run_sql("UPDATE activity_log SET detail=? WHERE id=?", (R1["detail"], R1["id"]))
    new_parse = ctx(lambda d: a.reminder_runs(d, limit=1))[0]
    s.check("reminder_runs reads the row exactly as before with the batch bit (only batch is new)",
            {k: v for k, v in new_parse.items() if k != "batch"} == {k: v for k, v in old_parse.items() if k != "batch"}
            and new_parse["batch"] == B1 and old_parse["batch"] == "" and new_parse["queued"] == 8 and new_parse["skipped"] == 1
            and new_parse["opted_out"] == 1, (old_parse, new_parse))
    s.check("the opted-out and no-email skips are logged (as before)", one(
        "SELECT COUNT(*) FROM notifications WHERE id>? AND status='skipped' AND user_id IN (?,?)", (n0, ID["E5"], ID["E10"])) == 2)
    # what became of each email, by hand: sent, failed (a stack trace in the error), cancelled for each reason, waiting
    now_s = "datetime('now')"
    for key, cols in (("E1", dict(status="sent", sent_at="2026-11-03 02:03:00")), ("E2", dict(status="sent", sent_at="2026-11-02 05:10:00")),
                      ("E3", dict(status="failed", error="Traceback (most recent call last):\n  File \"x.py\", line 1\nMailerError: 429 Too many requests")),
                      ("E4", dict(status="cancelled", error=a.REMINDER_NOTHING_LEFT)),
                      ("E6", dict(status="cancelled", error=a.REMINDER_OPTED_OUT)),
                      ("E7", dict(status="cancelled", error=a.REMINDER_OPTOUT_UNREAD))):
        set_user_row("pending_reminder", key, **cols)
    run_sql("UPDATE email_outbox SET send_after=NULL WHERE user_id=? AND kind='pending_reminder'", (ID["E9"],))
    # the sender logs a recheck's cancel as skipped too: it is the outbox row that names the person, never a second row
    for k, why in (("E4", a.REMINDER_NOTHING_LEFT), ("E6", a.REMINDER_OPTED_OUT), ("E7", a.REMINDER_OPTOUT_UNREAD)):
        ctx(lambda d, k=k, why=why: a.log_notification(d, CID, ID[k], "zzes-%s%s" % (k.lower(), DOMAIN), "skipped", 0, why))
    age(180, l0, o0, n0)
    run_sql("UPDATE email_outbox SET send_after=datetime('now','+90 minutes') WHERE user_id=? AND kind='pending_reminder'", (ID["E8"],))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("run 2: the cooldown skip is logged, and a 'skipped' row changes nothing the cooldown reads")
    before = cooldown(["E1", "E2", "E3", "E5", "E8", "E10", "E11", "E12"])
    l1, o1, n1 = marks()
    t2 = ctx(lambda d: a.reminder_send(d, a.active_cycle(d), [user(k) for k in ("E1", "E2", "E8", "E11")], "zz run two",
                                       actor_id=SUP_ID, live=True))
    s.check("E11 is queued; E1, E2 and E8 are in the cooldown (skipped)", t2["queued"] == 1 and t2["skipped"] == 3, t2)
    s.check("the cooldown skip is logged as 'skipped', in the cooldown's words", one(
        "SELECT COUNT(*) FROM notifications WHERE id>? AND status='skipped' AND kind=? AND detail=? AND user_id IN (?,?,?)",
        (n1, a.REMINDER_KIND, a.REMINDER_COOLDOWN_WHY, ID["E1"], ID["E2"], ID["E8"])) == 3)
    after = cooldown(["E1", "E2", "E3", "E5", "E8", "E10", "E11", "E12"])
    # E11 itself changed: run 2 queued them, so the outbox holds them now; every other answer is what it was
    s.check("reminder_in_cooldown answers the same with the new rows there: E1, E2 and E8 are held by the outbox, someone with only a "
            "'skipped' row (E5, E10) is not", before == dict(after, E11=before["E11"]) and after["E11"] and not before["E11"]
            and after["E1"] and after["E2"] and after["E8"] and not after["E5"] and not after["E10"], (before, after))
    R2 = last_run("reminder_run")
    B2 = R2["detail"].rsplit("batch ", 1)[1]
    age(120, l1, o1, n1)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the panel: chips over the whole run, Failed first, the reasons, Open")
    body = panel("email-run", run=R1["id"]).get_data(as_text=True)
    ch = chips_of(body)
    rows = rows_of(body)
    s.check("the chips count the whole run: All 10 / Sent 2 / Failed 1 / Waiting 2 / Not sent 5, All on", ch == {
        "All": 10, "Sent": 2, "Failed": 1, "Waiting": 2, "Not sent": 5, "_on": "All"}, ch)
    s.check("ten rows, sorted Failed, Waiting, Not sent, Sent", [r[1] for r in rows] == ["bad", "info", "info", "off", "off", "off",
                                                                                          "off", "off", "ok", "ok"], [r[1] for r in rows])
    by = {r[0].replace("ZZ ES Person ", ""): r for r in rows}
    s.check("Sent shows its clock (MYT), the day under it when it was not today", by["E1"][2] == "Sent · 10:03"
            and by["E2"][2] == "Sent · 13:10" and by["E2"][3].endswith("2 Nov") and by["E1"][3] in ("", "Tue 3 Nov"), (by["E1"], by["E2"]))
    s.check("Failed: the error under it, short, never a stack trace", by["E3"][2] == "Failed" and by["E3"][3] == "Send failed"
            and "Traceback" not in body and "x.py" not in body, by["E3"])
    s.check("Waiting: 'Waiting · wave HH:MM' for a later wave, 'Going out now' for one that is due", by["E8"][2].startswith(
        "Waiting · wave ") and by["E9"][2] == "Going out now", (by["E8"], by["E9"]))
    s.check("Not sent, each with its words", by["E4"][3] == "Nothing left to do by their wave" and by["E6"][3] == "Opted out"
            and by["E7"][3] == "Opt-out couldn't be read" and by["E5"][3] == "Opted out" and by["E10"][3] == "No email on file"
            and all(by[k][2] == "Not sent" for k in ("E4", "E5", "E6", "E7", "E10")), by)
    s.check("a recheck's skipped log does not add a row of its own (the outbox row names the person once)",
            len([r for r in rows if r[0].endswith(("E4", "E6", "E7"))]) == 3)
    s.check("every person with an account has Open", all(r[4] for r in rows))
    s.check("the kicker, the title (3 Nov 2026 style, MYT) and the run's why", 'data-list-kicker="Email › Sent · Everyone&#39;s reminder"' in body
            and re.search(r'data-list-title="\d{1,2} \w{3} 2026, \d\d:\d\d · 10 people"', body) and 'data-list-sub="zz run one"' in body,
            re.findall(r'data-list-(?:kicker|title|sub)="[^"]*"', body))
    s.check("the people's emails show here (the super admin's panel)", "zzes-e1@zzes.invalid" in body)
    s.check("a chip is a link that reloads the panel: data-list-reload, its run kept", 'data-list-reload' in body
            and "run=%d" % R1["id"] in body and "show=failed" in body)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the page's second lines equal the panel's chips (a run that names its batch)")
    page = sup.get("/admin/email/sent").get_data(as_text=True)
    t_1, card1 = tally_of("reminder", R1["id"])
    s.check("run 1's tally is the panel's: sent 2, failed 1, waiting 2, not sent 5", t_1 == {
        "sent": 2, "failed": 1, "waiting": 2, "not_sent": 5, "all": 10, "rows": 8} and t_1 == dict(panel_counts("email-run", run=R1["id"]),
                                                                                               rows=8), t_1)
    txt = page_row(page, R1["id"], "email-run")
    s.check("...and the Queued cell's second line says so, with a People link", sub_text(t_1) in txt and "People ›" in txt,
            txt)
    s.check("...failed is in the bad colour", re.search(r'<b class="rm-bad">1 failed</b>', page) is not None)
    t_2, card2 = tally_of("reminder", R2["id"])
    s.check("run 2: 1 queued and due (waiting 1), 3 not sent by the cooldown", t_2["waiting"] == 1 and t_2["not_sent"] == 3
            and t_2["all"] == 4 and t_2 == dict(panel_counts("email-run", run=R2["id"]), rows=1), t_2)
    rows2 = rows_of(panel("email-run", run=R2["id"]).get_data(as_text=True))
    s.check("...the cooldown rows say 'Already emailed in the last 20 hours'", sum(r[3] == "Already emailed in the last 20 hours"
                                                                                for r in rows2) == 3, rows2)

    s.section("show= and Search in are server parameters; the chips count the whole run")
    b = panel("email-run", run=R1["id"], show="failed").get_data(as_text=True)
    r_ = rows_of(b)
    s.check("show=failed lists only Failed, the chip on, the counts still the whole run", [x[2] for x in r_] == ["Failed"]
            and chips_of(b)["_on"] == "Failed" and chips_of(b)["All"] == 10, (r_, chips_of(b)))
    for key, label in (("sent", "Sent"), ("waiting", "Waiting"), ("not_sent", "Not sent")):
        r_ = rows_of(panel("email-run", run=R1["id"], show=key).get_data(as_text=True))
        want = {"sent": 2, "waiting": 2, "not_sent": 5}[key]
        s.check("show=%s lists its %d" % (key, want), len(r_) == want and all(x[2].startswith(
            {"sent": "Sent", "waiting": ("Waiting", "Going"), "not_sent": "Not sent"}[key]) for x in r_), r_)
    b = panel("email-run", run=R1["id"], q="ZZ ES Person E3", qin="name").get_data(as_text=True)
    s.check("search narrows (by name): one row; the chips still count the whole run", [x[0] for x in rows_of(b)] == [
        "ZZ ES Person E3"] and chips_of(b)["All"] == 10, (rows_of(b), chips_of(b)))
    s.check("...by Employee ID", [x[0] for x in rows_of(panel("email-run", run=R1["id"], q="ZZES-E7", qin="eid").get_data(as_text=True))] == [
        "ZZ ES Person E7"])
    s.check("...by email", [x[0] for x in rows_of(panel("email-run", run=R1["id"], q="zzes-e9@", qin="email").get_data(as_text=True))] == [
        "ZZ ES Person E9"])
    s.check("...a field that doesn't hold it finds nobody (the ID typed in Name)", rows_of(panel(
        "email-run", run=R1["id"], q="ZZES-E7", qin="name").get_data(as_text=True)) == [])
    b = panel("email-run", run=R1["id"], q="zz es person e", qin="name", show="sent").get_data(as_text=True)
    s.check("chip and search together", len(rows_of(b)) == 2 and 'name="show" value="sent"' in b and 'name="run"' in b and
            'name="qin"' in b and 'class="clp-search"' in b, len(rows_of(b)))
    s.check("the chips keep the search typed (a chip's link carries q)", "q=zz+es+person+e" in b or "q=zz%20es%20person%20e" in b)
    s.check("Search in has Name, Employee ID and Email (and All fields)", all(x in b for x in (">Name<", ">Employee ID<", ">Email<",
                                                                                              ">All fields<")), "menu")

    # ---------------------------------------------------------------------------------------------------------------
    s.section("a run from before this release (no batch on its row): its emails are found by time")
    full_rows = rows_of(panel("email-run", run=R1["id"]).get_data(as_text=True))
    run_sql("UPDATE activity_log SET detail=? WHERE id=?", (stripped, R1["id"]))
    t_old, _c = tally_of("reminder", R1["id"])
    s.check("same tally with no batch named", t_old == t_1, (t_old, t_1))
    s.check("...same people in the panel", rows_of(panel("email-run", run=R1["id"]).get_data(as_text=True)) == full_rows)
    s.check("...and run 2's rows are not run 1's", t_old["all"] == 10 and t_2["all"] == 4)
    b = panel("email-run", batch=B1).get_data(as_text=True)
    s.check("the progress bar's ?batch= finds that old run by its first email", chips_of(b).get("All") == 10, chips_of(b))
    run_sql("UPDATE activity_log SET detail=? WHERE id=?", (stripped.replace("| 1 skipped", "| 15 skipped"), R1["id"]))
    b = panel("email-run", run=R1["id"]).get_data(as_text=True)
    s.check("skips never logged per person are counted, not named: '14 skipped before 4 Nov can't be named'",
            "14 skipped before 4 Nov can&#39;t be named." in b or "14 skipped before 4 Nov can't be named." in b, re.findall(r'data-list-sub="[^"]*"', b))
    run_sql("UPDATE activity_log SET detail=? WHERE id=?", (R1["detail"], R1["id"]))
    b = panel("email-run", run=R1["id"]).get_data(as_text=True)
    s.check("a run that named everyone says nothing of the kind", "can&#39;t be named" not in b and "can't be named" not in b)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Leader progress: batch, nothing to report logged, the panel with Role")
    LEADERS = {}

    def build_lp(db_, cyc_, rules=None, only=None):
        out = []
        for key, role, secs, opted in (("L1", "bgceo", [1], False), ("L2", "buceo", [1], False), ("L3", "hod", [], False),
                                       ("L4", "cg", [1], True), ("L5", "hod", [1], False)):
            out.append({"role": role, "user": db_.execute("SELECT * FROM users WHERE id=?", (ID[key],)).fetchone(),
                        "sections": secs, "left_out": [], "note": None, "opted_out": opted})
        return out, [1], []
    a.lp_build = build_lp
    l2, o2, n2 = marks()
    tl = ctx(lambda d: a.lp_send(d, a.active_cycle(d), "zz leaders", actor_id=SUP_ID, live=True))
    s.check("2 emailed, 1 nothing to report, 1 opted out, 1 no email", tl == {"leaders": 5, "emailed": 2, "nothing": 1, "no_email": 1,
                                                                             "opted_out": 1}, tl)
    RL = last_run("leader_progress_run")
    BL = RL["detail"].rsplit("batch ", 1)[1]
    s.check("the row names its batch (lp-<hex>) and the two outbox rows carry it", re.fullmatch(r"lp-[0-9a-f]{12}", BL) and one(
        "SELECT COUNT(*) FROM email_outbox WHERE batch=? AND kind=?", (BL, a.LP_KIND)) == 2, RL["detail"])
    s.check("a leader with nothing to report is logged as skipped (kind leader_progress)", one(
        "SELECT COUNT(*) FROM notifications WHERE id>? AND user_id=? AND status='skipped' AND kind=? AND detail='nothing to report; hod'",
        (n2, ID["L3"], a.LP_KIND)) == 1)
    s.check("...and every leader skip carries the role after a ';' (opted out; cg, no email on file; hod), the words first", one(
        "SELECT COUNT(*) FROM notifications WHERE id>? AND kind=? AND status='skipped' AND detail IN ('opted out; cg', 'no email on file; hod')",
        (n2, a.LP_KIND)) == 2)
    lp_stripped = re.sub(r" \| batch \S+$", "", RL["detail"])
    run_sql("UPDATE activity_log SET detail=? WHERE id=?", (lp_stripped, RL["id"]))
    lp_old = ctx(lambda d: a.lp_runs(d, limit=1))[0]
    run_sql("UPDATE activity_log SET detail=? WHERE id=?", (RL["detail"], RL["id"]))
    lp_new = ctx(lambda d: a.lp_runs(d, limit=1))[0]
    s.check("lp_runs reads the row exactly as before with the batch bit", {k: v for k, v in lp_new.items() if k != "batch"} == {
        k: v for k, v in lp_old.items() if k != "batch"} and lp_new["batch"] == BL and lp_new["emailed"] == 2 and lp_new["nothing"] == 1
            and lp_new["opted_out"] == 1 and lp_new["no_email"] == 1 and lp_new["leaders"] == 5, (lp_old, lp_new))
    set_user_row(a.LP_KIND, "L1", status="sent", sent_at="2026-11-03 02:00:00")
    set_user_row(a.LP_KIND, "L2", status="failed", error="mailbox unavailable")
    age(60, l2, o2, n2)
    tl_, _c = tally_of("lp", RL["id"])
    b = panel("email-lp-run", run=RL["id"]).get_data(as_text=True)
    lrows = rows_of(b)
    s.check("5 rows: 1 sent, 1 failed, 3 not sent; the chips equal the page's tally", tl_ == {"sent": 1, "failed": 1, "waiting": 0,
                                                                                            "not_sent": 3, "all": 5, "rows": 2}
            and chips_of(b) == {"All": 5, "Sent": 1, "Failed": 1, "Not sent": 3, "_on": "All"}, (tl_, chips_of(b)))
    s.check("...(no Waiting chip when nothing waits)", "Waiting" not in chips_of(b))
    s.check("...the reasons: Nothing to report, Opted out, No email on file; the error short", sorted(r[3] for r in lrows if r[1] == "off") == [
        "No email on file", "Nothing to report", "Opted out"] and [r[3] for r in lrows if r[1] == "bad"] == ["mailbox unavailable"], lrows)
    roles = {}
    for tr in re.findall(r'<tr class="data-row".*?</tr>', b, re.S):
        roles[html.unescape(re.search(r"<b>(.*?)</b>", tr, re.S).group(1)).replace("ZZ ES Person ", "")] = plain(re.findall(
            r'<td class="small">(.*?)</td>', tr, re.S)[0])
    s.check("the Role column reads the outbox detail's prefix, and a skipped row's suffix, with the page's role labels: no leader's is blank",
            roles == {"L1": "BG CEO", "L2": "BU CEO", "L3": "HOD", "L4": "Calibrator", "L5": "HOD"} and ">Role<" in b, roles)
    s.check("the person (ID · unit), no BU column", ">BU<" not in b and "ZZES Unit" in b)
    s.check("the title says leaders", re.search(r'data-list-title="[^"]*· 5 leaders"', b) is not None)
    txt = page_row(sup.get("/admin/email/sent").get_data(as_text=True), RL["id"], "email-lp-run")
    s.check("the card's Emailed cell adds '1 sent · 1 failed' (the skips are the other columns), and a People ›", "2 · 1 nothing to report 1 sent · 1 failed" in txt
            and "not sent" not in txt and "People ›" in txt, txt)
    run_sql("UPDATE activity_log SET detail=? WHERE id=?", (lp_stripped, RL["id"]))
    s.check("an old leader run is found by time too (rows of its kind in its window)", tally_of("lp", RL["id"])[0] == tl_)
    run_sql("UPDATE activity_log SET detail=? WHERE id=?", (RL["detail"], RL["id"]))
    # a run where nothing it counts was open: no batch, no people
    a.lp_build = lambda db_, cyc_, rules=None, only=None: ([], [], [])
    l3, o3, n3 = marks()
    ctx(lambda d: a.lp_send(d, a.active_cycle(d), "zz closed", actor_id=SUP_ID, live=True))
    RLC = last_run("leader_progress_run")
    s.check("a closed run has no batch and no People link; it still reads as closed", "batch" not in RLC["detail"] and "nothing it counts is open"
            in RLC["detail"] and ctx(lambda d: a.lp_runs(d, limit=1))[0]["closed"] and tally_of("lp", RLC["id"])[1]["people_url"] == "")
    age(30, l3, o3, n3)

    s.section("the progress bar never shows a leader or BG admin batch")
    s.check("outbox_sends names reminder batches only (lp- is queued, it is not there)", all(not x["batch"].startswith(("lp-", "bga-"))
                                                                                          for x in ctx(lambda d: a.outbox_sends(d))))
    run_sql("UPDATE email_outbox SET status='queued' WHERE batch=?", (BL,))
    s.check("...even with its rows queued (live), the bar leaves it out", BL not in [x["batch"] for x in ctx(lambda d: a.outbox_sends(d))])
    keep = a._OUTBOX_BAR_ONLY
    a._OUTBOX_BAR_ONLY = "1=1"
    leaked = BL in [x["batch"] for x in ctx(lambda d: a.outbox_sends(d))]
    a._OUTBOX_BAR_ONLY = keep
    s.check("falsified: without the exclusion the lp- batch DOES reach the bar (so the check above proves something)", leaked)
    run_sql("UPDATE email_outbox SET status=CASE WHEN user_id=? THEN 'sent' ELSE 'failed' END WHERE batch=?", (ID["L1"], BL))
    run_sql("UPDATE email_outbox SET error='mailbox unavailable' WHERE batch=? AND status='failed'", (BL,))
    s.check("the bar's own reader is as before for a reminder batch: 8 queued less the 3 cancelled", ctx(
        lambda d: a._outbox_send(d, B1))["total"] == 5)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("BG admin status: batch, nothing to report logged, one row per address")
    a.lp_build = _real[2]

    def build_bga(db_, cyc_, rules=None, today=None, only=None):
        def u(k):
            return db_.execute("SELECT * FROM users WHERE id=?", (ID[k],)).fetchone()
        return [{"user": u("A1"), "bg": BG, "sections": [1], "addrs": ["zzes-a1-one%s" % DOMAIN, "zzes-a1-two%s" % DOMAIN]},
                {"user": u("A2"), "bg": BG, "sections": [1], "addrs": []},
                {"user": u("A3"), "bg": BG, "sections": [], "addrs": ["zzes-a3%s" % DOMAIN]}], [1]
    a.bga_build = build_bga
    l4, o4, n4 = marks()
    tb = ctx(lambda d: a.bga_send(d, a.active_cycle(d), "zz bg admins", actor_id=SUP_ID, live=True))
    s.check("3 admins: 1 emailed to 2 addresses, 1 nothing to report, 1 no notification email", tb == {
        "admins": 3, "emailed": 1, "addresses": 2, "nothing": 1, "no_email": 1}, tb)
    RB = last_run("bg_admin_progress_run")
    BB = RB["detail"].rsplit("batch ", 1)[1]
    s.check("the row names its batch (bga-<hex>), the address rows carry it, the bar leaves it out", re.fullmatch(r"bga-[0-9a-f]{12}", BB)
            and one("SELECT COUNT(*) FROM email_outbox WHERE batch=? AND kind=?", (BB, a.BGA_KIND)) == 2
            and BB not in [x["batch"] for x in ctx(lambda d: a.outbox_sends(d))])
    s.check("an admin with nothing to report is logged as skipped (kind bg_admin_progress)", one(
        "SELECT COUNT(*) FROM notifications WHERE id>? AND user_id=? AND status='skipped' AND kind=? AND detail='nothing to report'",
        (n4, ID["A3"], a.BGA_KIND)) == 1)
    bga_stripped = re.sub(r" \| batch \S+$", "", RB["detail"])
    run_sql("UPDATE activity_log SET detail=? WHERE id=?", (bga_stripped, RB["id"]))
    b_old = ctx(lambda d: a.bga_runs(d, limit=1))[0]
    run_sql("UPDATE activity_log SET detail=? WHERE id=?", (RB["detail"], RB["id"]))
    b_new = ctx(lambda d: a.bga_runs(d, limit=1))[0]
    s.check("bga_runs: admins 3, emailed 1, nothing to report 1, no notification email 1, batch; the same without the batch bit", {
        k: v for k, v in b_new.items() if k != "batch"} == {k: v for k, v in b_old.items() if k != "batch"} and b_new["admins"] == 3
            and b_new["emailed"] == 1 and b_new["nothing"] == 1 and b_new["no_email"] == 1 and b_new["batch"] == BB and not b_new["closed"],
            (b_old, b_new))
    run_sql("UPDATE email_outbox SET status='sent', sent_at='2026-11-03 02:30:00' WHERE batch=? AND to_email LIKE 'zzes-a1-one%'", (BB,))
    run_sql("UPDATE email_outbox SET status='failed', error='550 mailbox full' WHERE batch=? AND to_email LIKE 'zzes-a1-two%'", (BB,))
    age(15, l4, o4, n4)
    tb_, cardb = tally_of("bga", RB["id"])
    b = panel("email-bga-run", run=RB["id"]).get_data(as_text=True)
    brows = rows_of(b)
    s.check("4 rows: an address a row, plus the two skipped admins; 1 sent, 1 failed, 2 not sent", tb_ == {
        "sent": 1, "failed": 1, "waiting": 0, "not_sent": 2, "all": 4, "rows": 2} and chips_of(b) == {
        "All": 4, "Sent": 1, "Failed": 1, "Not sent": 2, "_on": "All"} and len(brows) == 4, (tb_, chips_of(b)))
    s.check("...the reasons: Nothing to report, No notification email; the error short", sorted(r[3] for r in brows if r[1] == "off") == [
        "No notification email", "Nothing to report"] and [r[3] for r in brows if r[1] == "bad"] == ["550 mailbox full"], brows)
    s.check("...the BG admin / Group columns, the title counts the admins (3), both addresses show", ">BG admin<" in b and ">Group<" in b
            and re.search(r'data-list-title="[^"]*· 3 BG admins"', b) is not None and "zzes-a1-one@zzes.invalid" in b
            and "zzes-a1-two@zzes.invalid" in b, "cols")
    page = sup.get("/admin/email/sent").get_data(as_text=True)
    txt = page_row(page, RB["id"], "email-bga-run")
    s.check("the card's Emailed cell: '1 · 1 nothing to report', second line '2 addresses: 1 sent · 1 failed'; No email 1; People ›",
            "1 · 1 nothing to report 2 addresses: 1 sent · 1 failed" in txt and "not sent" not in txt and "People ›" in txt, txt)
    s.check("the card has its muted line, its columns", "The daily email to each group-wide BG admin, sent to the addresses on their account&#39;s notification emails." in page
            or "The daily email to each group-wide BG admin, sent to the addresses on their account's notification emails." in page)
    s.check("...in this order: Everyone's reminder, Leader progress, BG admin status, Admin notices", page.index("Everyone's reminder") <
            page.index(">Leader progress<") < page.index(">BG admin status<") < page.index(">Admin notices<"))
    a.bga_build = _real[4]
    l5, o5, n5 = marks()
    a.bga_build = lambda db_, cyc_, rules=None, today=None, only=None: ([], [])
    ctx(lambda d: a.bga_send(d, a.active_cycle(d), "zz bg closed", actor_id=SUP_ID, live=True))
    RBC = last_run("bg_admin_progress_run")
    s.check("a closed BG admin run reads as closed, no People link", ctx(lambda d: a.bga_runs(d, limit=1))[0]["closed"]
            and tally_of("bga", RBC["id"])[1]["people_url"] == "")
    s.check("...its row is one muted cell: 'nothing it counts was open'", "nothing it counts was open" in sup.get("/admin/email/sent").get_data(as_text=True))
    age(5, l5, o5, n5)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the progress bar's two links (a reminder batch only)")
    bar = sup.get("/admin/reminders/progress").get_data(as_text=True)
    s.check("'N / M sent ›' opens that batch's list; '1 failed ›' opens it on Failed", 'data-list-open="/admin/list/email-run?batch=%s&amp;fragment=1"' % B1 in bar
            and 'data-list-open="/admin/list/email-run?batch=%s&amp;show=failed&amp;fragment=1"' % B1 in bar and "1 failed &rsaquo;" in bar)
    s.check("...a leader or BG admin batch never has a bar", "lp-" not in bar and "bga-" not in bar)
    b = panel("email-run", batch=B1, show="failed").get_data(as_text=True)
    s.check("the bar's link lands on the run's Failed", [x[2] for x in rows_of(b)] == ["Failed"], rows_of(b))
    run_sql("UPDATE activity_log SET detail=? WHERE id=?", (stripped, R1["id"]))
    s.check("...and for a run from before the key, the same", panel("email-run", batch=B1).status_code == 200)
    run_sql("UPDATE activity_log SET detail=? WHERE id=?", (R1["detail"], R1["id"]))
    page = sup.get("/admin/email/sent").get_data(as_text=True)
    s.check("Email › Sent draws the list panel for the links", 'data-panel="list"' in page and 'data-list-open="/admin/list/email-run?run=' in page)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Admin notices: which emails, by MYT day, the admin copy of Help and sign-in help")
    run_sql("INSERT OR IGNORE INTO admin_notify_emails(user_id, email) VALUES (?,?)", (ID["BGA"], "zzes-bga-notice" + DOMAIN))

    def nf(kind, status, to, uid, detail, at):
        run_sql("INSERT INTO notifications(cycle_id, user_id, to_email, kind, status, detail, created_at) VALUES (NULL,?,?,?,?,?,?)",
                (uid, to, kind, status, detail, at))
    D1 = "2030-03-01"
    nf(a.ADMIN_TASK_KIND, "sent", "zzes-bga-notice" + DOMAIN, ID["BGA"], "3 new joiners to set up in ZZES Group", "2030-03-01 02:00:00")
    nf(a.ADMIN_TASK_KIND, "sent", "zzes-bga-notice" + DOMAIN, ID["BGA"], "AI+ OneHR: KPI lines to set for ZZ Person", "2030-03-01 03:00:00")
    nf(a.ADMIN_TASK_KIND, "sent", "zzes-bga-notice" + DOMAIN, ID["BGA"], "A KPI library proposal is waiting for you", "2030-03-01 03:30:00")
    nf(a.ADMIN_TASK_KIND, "sent", "zzes-bga-notice" + DOMAIN, ID["BGA"], "Your competency proposal: approved", "2030-03-01 03:40:00")
    nf(a.ADMIN_TASK_KIND, "sent", "zzes-bga-notice" + DOMAIN, ID["BGA"], "A test from OneHR", "2030-03-01 03:50:00")
    nf(a.ADMIN_TASK_KIND, "sent", "zzes-bga-notice" + DOMAIN, ID["BGA"], "Something else entirely", "2030-03-01 03:55:00")
    nf(a.ADMIN_TASK_KIND, "failed", "zzes-bga-notice" + DOMAIN, ID["BGA"], "Traceback (most recent call last):\nboom", "2030-03-01 04:00:00")
    # a help report: the person's own copy goes to their own address (dropped); the copy to an admin address is counted
    nf(a.HELP_KIND, "sent", "zzes-bga-notice" + DOMAIN, ID["E1"], "Help H-1 · Something broke · ZZES-E1", "2030-03-01 05:00:00")
    nf(a.HELP_KIND, "sent", "zzes-e1" + DOMAIN, ID["E1"], "Your report", "2030-03-01 05:01:00")
    nf(a.HELP_KIND, "sent", "ZZES-E2" + DOMAIN.upper(), ID["E2"], "Your report", "2030-03-01 05:02:00")   # own copy: case differs only
    nf(a.HELP_KIND, "failed", "zzes-nobody-holds-this" + DOMAIN, ID["E1"], "550 no such mailbox", "2030-03-01 05:03:00")
    nf(a.SIGNIN_HELP_KIND, "sent", "zzes-bga-notice" + DOMAIN, None, "Sign-in help S-1 · password", "2030-03-01 06:00:00")   # no user: an admin copy
    nf(a.SIGNIN_HELP_KIND, "sent", "zzes-e3" + DOMAIN, ID["E3"], "Sign-in help was requested", "2030-03-01 06:01:00")   # the person's notice
    nf(a.SIGNIN_HELP_KIND, "sent", "zzes-nobody-holds-this" + DOMAIN, None, "Sign-in help S-2 · locked", "2030-03-01 06:02:00")
    # the next MYT day starts at 16:00 UTC
    nf(a.ADMIN_TASK_KIND, "sent", "zzes-bga-notice" + DOMAIN, ID["BGA"], "1 new joiner to set up in ZZES Group", "2030-03-01 16:30:00")
    # a kind that is not an admin notice
    nf(a.REMINDER_KIND, "sent", "zzes-e4" + DOMAIN, ID["E4"], "x", "2030-03-01 07:00:00")
    days = ctx(lambda d: a.es_notices(d))
    d1 = next(x for x in days if x["day"] == D1)
    s.check("the day's emails: 7 admin tasks (1 failed), 2 admin copies of Help (1 failed), 2 of sign-in help = 11", d1["n"] == 11
            and d1["sent"] == 9 and d1["failed"] == 2, d1)
    s.check("the person's own copy of a Help report drops out (to_email = their users.email, trimmed, any case), and the matched person's "
            "sign-in notice with it", d1["n"] == 7 + 2 + 2 and d1["types"]["Help report"] == 2 and d1["types"]["Sign-in help"] == 2)
    s.check("What counts by type from the subject map: New joiners to set up, KPI lines to set, KPI library proposal, Competency proposal, "
            "Test email, Other notice, Help report, Sign-in help", d1["types"] == {
                "New joiners to set up": 1, "KPI lines to set": 1, "KPI library proposal": 1, "Competency proposal": 1, "Test email": 1,
                "Other notice": 2, "Help report": 2, "Sign-in help": 2}, d1["types"])
    s.check("MYT days: 16:30 UTC is the next day", any(x["day"] == "2030-03-02" and x["n"] == 1 for x in days))
    page = sup.get("/admin/email/sent").get_data(as_text=True)
    txt = plain(re.search(r"<tr>(?:(?!</tr>).)*?data-list-open=\"/admin/list/email-notices\?day=2030-03-01&amp;fragment=1\".*?</tr>", page, re.S).group(0))
    s.check("the card row: Day / What / Emails / Sent / Failed / People ›", txt.startswith("Fri 1 Mar") and " 11 9 2 People ›" in txt
            and "2 Help report" in txt, txt)
    s.check("the card's muted line", "One row a day." in page and "The emails OneHR sends an admin when something waits on them" in page)
    b = panel("email-notices", day=D1).get_data(as_text=True)
    nrows = rows_of(b)
    s.check("the panel: All 11 / Sent 9 / Failed 2 (no Waiting, no Not sent chip), equal to the card", chips_of(b) == {
        "All": 11, "Sent": 9, "Failed": 2, "_on": "All"}, chips_of(b))
    s.check("...Failed first; Sent with its clock", [r[1] for r in nrows][:2] == ["bad", "bad"] and all(r[1] == "ok" for r in nrows[2:])
            and nrows[-1][2].startswith("Sent · ") and len(nrows) == 11, nrows)
    s.check("...a failed notice's error is short, never a stack trace", "Traceback" not in b and "boom" not in b)
    s.check("...columns Admin / What / Email / Status / Open; the subject in What with its full words on hover", ">Admin<" in b and ">What<" in b
            and 'title="3 new joiners to set up in ZZES Group"' in b and "zzes-bga-notice@zzes.invalid" in b)
    s.check("...a help copy to an address an admin account holds names that admin; one no account holds has no uid and no Open", any(
        r[0] == "ZZ ES Person BGA" for r in nrows) and any(r[0] == "No admin account" and not r[4] for r in nrows)
            and all(r[4] for r in nrows if r[0].startswith("ZZ ES")))
    b = panel("email-notices", day=D1, show="failed").get_data(as_text=True)
    s.check("show=failed lists only the failed two", len(rows_of(b)) == 2 and chips_of(b)["_on"] == "Failed" and chips_of(b)["All"] == 11)
    b = panel("email-notices", day=D1, q="library", qin="what").get_data(as_text=True)
    s.check("Search in: What finds the subject; Name and Email too", [r[0] for r in rows_of(b)] == ["ZZ ES Person BGA"] and len(rows_of(
        panel("email-notices", day=D1, q="new joiners", qin="what").get_data(as_text=True))) == 1 and len(rows_of(
            panel("email-notices", day=D1, q="no such", qin="what").get_data(as_text=True))) == 0 and len(rows_of(
                panel("email-notices", day=D1, q="nobody-holds", qin="email").get_data(as_text=True))) == 2 and len(rows_of(
                    panel("email-notices", day=D1, q="ZZ ES Person BGA", qin="name").get_data(as_text=True))) == 9,
            [len(rows_of(panel("email-notices", day=D1, **kw).get_data(as_text=True))) for kw in (
                dict(q="library", qin="what"), dict(q="new joiners", qin="what"), dict(q="no such", qin="what"),
                dict(q="nobody-holds", qin="email"), dict(q="ZZ ES Person BGA", qin="name"))])
    s.check("a day that is not a day is a 404", panel("email-notices", day="not-a-day").status_code == 404)
    # a failed admin-task email keeps its subject (ADMIN_TASK_ERR_SEP), and the card and panel read both parts
    _mail = (a.mailer.is_configured, a.mailer.send_mail)
    a.mailer.is_configured = lambda: True

    def _boom(to, subject, body, token=None, save_to_sent=True):
        raise RuntimeError("550 5.2.2 mailbox full\n  File \"mailer.py\", line 9, in send")
    a.mailer.send_mail = _boom
    try:
        ctx(lambda d: a._admin_task_email(d, ID["BGA"], "4 new joiners to set up in ZZES Group", "H", ["p"]))
        ctx(lambda d: a._admin_task_email(d, ID["BGA"], "S" * 300, "H", ["p"]))
    finally:
        a.mailer.is_configured, a.mailer.send_mail = _mail
    fr = ctx(lambda d: [r[0] for r in d.execute("SELECT detail FROM notifications WHERE kind=? AND status='failed' AND to_email=? AND "
                                                  "created_at > datetime('now','-1 hour') AND created_at < '2030-01-01' ORDER BY id", (a.ADMIN_TASK_KIND, "zzes-bga-notice" + DOMAIN))])
    s.check("a failed admin task logs its subject, the separator and the error, cut to 200 (a long subject keeps the separator)",
            len(fr) == 2 and fr[0].startswith("4 new joiners to set up in ZZES Group" + a.ADMIN_TASK_ERR_SEP + "550 5.2.2 mailbox full")
            and all(len(x) <= 200 for x in fr) and a.ADMIN_TASK_ERR_SEP in fr[1] and fr[1].startswith("S" * 120), fr)
    s.check("a sent one still logs the subject alone", ctx(lambda d: d.execute(
        "SELECT COUNT(*) FROM notifications WHERE kind=? AND status='sent' AND detail LIKE '%error:%'", (a.ADMIN_TASK_KIND,)).fetchone()[0]) == 0)
    today_d = ctx(lambda d: a._today_myt().isoformat())
    dt_ = next(x for x in ctx(lambda d: a.es_notices(d)) if x["day"] == today_d)
    s.check("Admin notices: the failed one counts under its type (New joiners to set up), the other is Other notice",
            dt_["types"] == {"New joiners to set up": 1, "Other notice": 1} and dt_["failed"] == 2 and dt_["n"] == 2, dt_)
    b = panel("email-notices", day=today_d).get_data(as_text=True)
    ftr = next(t for t in re.findall(r'<tr class="data-row".*?</tr>', b, re.S) if "4 new joiners" in html.unescape(t))
    s.check("...the panel's What is the subject and the Status line the error's first line, never the stack", 'title="4 new joiners to set up in ZZES Group"' in ftr
            and "550 5.2.2 mailbox full" in html.unescape(ftr) and "mailer.py" not in b and "Traceback" not in b and "error:" not in b)
    nf(a.ADMIN_TASK_KIND, "failed", "zzes-bga-notice" + DOMAIN, ID["BGA"], "550 old row, error only", "2030-03-01 04:30:00")
    s.check("an older failed row (error alone) stays Other notice", ctx(lambda d: [x for x in a.es_notices(d) if x["day"] == D1][0])["types"].get(
        "Other notice") == 3)
    run_sql("DELETE FROM notifications WHERE created_at > datetime('now','-1 day') AND created_at < '2030-01-01' AND kind=?", (a.ADMIN_TASK_KIND,))
    run_sql("DELETE FROM notifications WHERE detail='550 old row, error only'")

    # the card reads 60 days at most; the indexes the reads use
    nf(a.ADMIN_TASK_KIND, "sent", "zzes-bga-notice" + DOMAIN, ID["BGA"], "KPI lines to set for OLD", 0)
    run_sql("UPDATE notifications SET created_at=datetime('now','-70 days') WHERE detail='KPI lines to set for OLD'")
    nf(a.ADMIN_TASK_KIND, "sent", "zzes-bga-notice" + DOMAIN, ID["BGA"], "KPI lines to set for RECENT", 0)
    run_sql("UPDATE notifications SET created_at=datetime('now','-50 days') WHERE detail='KPI lines to set for RECENT'")
    d50 = ctx(lambda d: d.execute("SELECT date(created_at,'+8 hours') FROM notifications WHERE detail='KPI lines to set for RECENT'").fetchone()[0])
    d70 = ctx(lambda d: d.execute("SELECT date(created_at,'+8 hours') FROM notifications WHERE detail='KPI lines to set for OLD'").fetchone()[0])
    got_days = [x["day"] for x in ctx(lambda d: a.es_notices(d))]
    s.check("Admin notices reads the last 60 days: a day 50 days back is on the card, one 70 days back is not", d50 in got_days and d70 not in got_days,
            (d50, d70, got_days))
    run_sql("DELETE FROM notifications WHERE detail IN ('KPI lines to set for OLD', 'KPI lines to set for RECENT')")
    idx_o = {r[1] for r in H.rows(a, "PRAGMA index_list(email_outbox)")}
    idx_n = {r[1] for r in H.rows(a, "PRAGMA index_list(notifications)")}
    s.check("the two additive indexes exist: email_outbox(kind, created_at) and notifications(kind, created_at)",
            "idx_outbox_kind_created" in idx_o and "idx_notif_kind_created" in idx_n and "idx_notif_lookup" in idx_n and "idx_outbox_user" in idx_o)
    src_ = H.source(a)
    s.check("...the notifications one also in SCHEMA (a fresh database), the outbox one beside its siblings in the runtime schema",
            "CREATE INDEX IF NOT EXISTS idx_notif_kind_created ON notifications(kind, created_at);" in src_
            and src_.count("idx_notif_kind_created") == 2 and src_.count("idx_outbox_kind_created") == 1)
    plan_n = " ".join(str(r[3]) for r in H.rows(a, "EXPLAIN QUERY PLAN " + a._ES_NF_GROUPS % ("?,?", ""), ["x", "y", "", "a", "b", "c"]))
    plan_o = " ".join(str(r[3]) for r in H.rows(a, "EXPLAIN QUERY PLAN " + a._ES_OB_GROUPS % "?,?", ["x", "y", ""]))
    s.check("the grouped reads use them", "idx_notif_kind_created" in plan_n and "idx_outbox_kind_created" in plan_o, (plan_n, plan_o))
    # the last 14 days that had any
    for i in range(1, 17):
        nf(a.ADMIN_TASK_KIND, "sent", "zzes-bga-notice" + DOMAIN, ID["BGA"], "KPI lines to set for Z", "2030-01-%02d 03:00:00" % i)
    days = ctx(lambda d: a.es_notices(d))
    s.check("only the last 14 MYT days that had any: 03-02, 03-01, then 01-16 down to 01-03", len(days) == 14 and days[0]["day"] == "2030-03-02"
            and days[1]["day"] == "2030-03-01" and days[-1]["day"] == "2030-01-05", [x["day"] for x in days])
    seen = []
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.set_trace_callback(seen.append)
        a.es_notices(d)
        d.set_trace_callback(None)
    s.check("Admin notices is ONE read", len([q for q in seen if "FROM notifications" in q]) == 1, len(seen))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("one grouped read a card, never one per run")
    seen = []
    with a.app.test_request_context("/"):
        d = a.get_db()
        runs8 = a.reminder_runs(d, limit=20)
        d.set_trace_callback(seen.append)
        a.es_cards(d, "reminder", runs8)
        d.set_trace_callback(None)
    s.check("the reminder card: one outbox read, one notifications read (and the one older run's time), for %d runs" % len(runs8), len(runs8) >= 2
            and len([q for q in seen if "FROM email_outbox" in q]) == 1 and len([q for q in seen if "FROM notifications" in q]) == 1
            and len(seen) <= 4, (len(runs8), len(seen)))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the four lists are the super admin's alone")
    urls = ["/admin/list/email-run?run=%d&fragment=1" % R1["id"], "/admin/list/email-lp-run?run=%d&fragment=1" % RL["id"],
            "/admin/list/email-bga-run?run=%d&fragment=1" % RB["id"], "/admin/list/email-notices?day=%s&fragment=1" % D1]
    for nm, cl in (("a BG admin", bga), ("a unit admin", una)):
        s.check("%s is refused all four (403)" % nm, [cl.get(u).status_code for u in urls] == [403] * 4, [cl.get(u).status_code for u in urls])
    sc = [staff.get(u).status_code for u in urls]
    s.check("a staff user gets none of them", all(c != 200 for c in sc) and "zzes-e1@" not in staff.get(urls[0]).get_data(as_text=True), sc)
    s.check("the super admin gets all four", [sup.get(u).status_code for u in urls] == [200] * 4)
    s.check("a run that isn't this kind's, or isn't a run, is a 404", panel("email-run", run=RL["id"]).status_code == 404
            and panel("email-lp-run", run=999999999).status_code == 404 and panel("email-run", run="x").status_code == 404
            and panel("email-run", batch="reminder-zz").status_code == 404)
    r = sup.get("/admin/list/email-run?run=%d" % R1["id"])
    s.check("without ?fragment it goes to the Sent page", r.status_code == 302 and "/admin/email/sent" in r.headers["Location"])
    s.check("the lists are GETs only: no write route", sup.post(urls[0], data={"csrf_token": "tok"}).status_code == 405)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the 500-row cap, the title keeping the whole count")
    BIG = "reminder-" + "e" * 12
    l6, o6, n6 = marks()
    ids = [ID["E%d" % i] for i in range(1, 13)]
    ctx(lambda d: [d.execute("INSERT INTO email_outbox(kind, cycle_id, user_id, to_email, subject, body, status, sent_at, batch) VALUES "
                             "(?,?,?,?,?,?, 'sent', datetime('now'), ?)", (a.REMINDER_KIND, CID, ids[i % 12], "zzes-big%d%s" % (i, DOMAIN),
                                                                           "S", "<p>b</p>", BIG)) for i in range(520)] and (
        d.execute("UPDATE email_outbox SET created_at=datetime(created_at, '-' || (id - ?) || ' seconds') WHERE batch=?", (o6, BIG)),
        d.commit()))   # one email a second apart, as a run's are
    ctx(lambda d: a.log_activity(d, SUP_ID, "reminder_run", "zz big | 520 queued in 3 waves (200 every 30 min) | 0 skipped | batch " + BIG))
    RBIG = last_run("reminder_run")
    b = panel("email-run", run=RBIG["id"]).get_data(as_text=True)
    s.check("520 emails: 500 rows shown, the head says 520 emails' people, 'Showing the first 500 of 520'", len(rows_of(b)) == 500
            and "Showing the first 500 of 520." in b and chips_of(b)["All"] == 520, (len(rows_of(b)), chips_of(b)))
    s.check("...the note points at the chips and search, not at a full page that lists no people", "Narrow it with a chip or the search." in b)
    age(3, l6, o6, n6)
    ph3 = ",".join("?" * len(a.ES_RUNS["reminder"]["kinds"]))
    grp = ctx(lambda d: d.execute(a._ES_OB_GROUPS % ph3, list(a.ES_RUNS["reminder"]["kinds"]) + [""]).fetchall())
    gbig = [g for g in grp if g["batch"] == BIG]
    s.check("a batch is read as a few groups, not an email each: 520 emails in %d groups, every email counted" % len(gbig),
            len(gbig) <= 2 and sum(g["n"] for g in gbig) == 520 and len(grp) < 40, (len(gbig), len(grp)))
    t_big, _c = tally_of("reminder", RBIG["id"])
    s.check("...and the page's numbers for it are the panel's (520 sent)", t_big == dict(panel_counts("email-run", run=RBIG["id"]), rows=520)
            and t_big["sent"] == 520, t_big)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("a run that sent straight (no outbox) and a dry run list their people too")
    l7, o7, n7 = marks()
    ctx(lambda d: a.reminder_send(d, a.active_cycle(d), [user("E13")], "zz dry", actor_id=SUP_ID, live=False))
    RD = last_run("reminder_run")
    bd = rows_of(panel("email-run", run=RD["id"]).get_data(as_text=True))
    s.check("a dry run: its person is Not sent, 'Dry run: nothing was sent'", len(bd) == 1 and bd[0][2] == "Not sent" and bd[0][3] == "Dry run: nothing was sent", (bd, RD["detail"]))
    age(2, l7, o7, n7)
    l8, o8, n8 = marks()
    _m = (a.mailer.get_token, a.mailer.send_mail)
    a.mailer.get_token = lambda: "tok"
    a.mailer.send_mail = lambda to, subject, body, token=None, save_to_sent=True: None
    try:
        ctx(lambda d: a.reminder_send(d, a.active_cycle(d), [user("E13")], "zz redirected", actor_id=SUP_ID, live=True,
                                      test_to="zzes-admin-test" + DOMAIN))
    finally:
        a.mailer.get_token, a.mailer.send_mail = _m
    RX = last_run("reminder_run")
    t_x, card_x = tally_of("reminder", RX["id"])
    bx = panel("email-run", run=RX["id"]).get_data(as_text=True)
    s.check("a run that sent straight: its one person is Sent (the redirected address shows), the tally the same as the chips", card_x["direct"]
            and [r[2][:6] for r in rows_of(bx)] == ["Sent ·"] and "zzes-admin-test@zzes.invalid" in bx and t_x == dict(
                panel_counts("email-run", run=RX["id"]), rows=0) and t_x["sent"] == 1, (t_x, RX["detail"]))
    age(1, l8, o8, n8)

    # the chip/page equality, for every kind, run once more over all runs this suite made
    for kind, key, rid in (("reminder", "email-run", R1["id"]), ("reminder", "email-run", R2["id"]), ("lp", "email-lp-run", RL["id"]),
                           ("bga", "email-bga-run", RB["id"])):
        t_, _c = tally_of(kind, rid)
        s.check("%s run %s: page tally == panel chips" % (kind, rid), t_ == dict(panel_counts(key, run=rid), rows=t_["rows"]), t_)
finally:
    a.reminder_items, a._outbox_kick, a.lp_build, a.lp_mail, a.bga_build, a.bga_mail = _real
    with a.app.test_request_context("/"):
        d = a.get_db()
        _cleanup(d)
        d.execute("DELETE FROM email_outbox WHERE id>?", (OUT0,))
        d.execute("DELETE FROM notifications WHERE id>?", (NF0,))
        d.execute("DELETE FROM activity_log WHERE id>?", (LOG0,))
        d.commit()
    # Put back what was set aside, on a connection of its own with foreign keys OFF (the pragma is a no-op inside a transaction): the
    # rows come back exactly as they were, including any whose user or cycle a real database no longer holds (the app never enforced
    # that for these tables), so the put-back can't fail on the parent it checks.
    assert H.SCRATCH_MARKER in a.DB_PATH
    import sqlite3
    raw = sqlite3.connect(a.DB_PATH)
    raw.execute("PRAGMA foreign_keys=OFF")
    for tbl, rows_ in STASH.items():
        for r in rows_:
            raw.execute("INSERT OR REPLACE INTO %s(%s) VALUES (%s)" % (tbl, ",".join(r), ",".join("?" * len(r))), list(r.values()))
    raw.execute("DELETE FROM email_optouts")
    for r in KEPT:
        raw.execute("INSERT INTO email_optouts(%s) VALUES (%s)" % (",".join(r), ",".join("?" * len(r))), list(r.values()))
    for k, v in SETTINGS.items():
        if v is None:
            raw.execute("DELETE FROM app_settings WHERE key=?", (k,))
        else:
            raw.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES (?,?)", (k, v))
    for k in ("email_wave_on", "email_wave_size", "email_wave_gap"):
        if k not in SETTINGS:
            raw.execute("DELETE FROM app_settings WHERE key=?", (k,))
    raw.commit()
    back = {"email_outbox": raw.execute("SELECT COUNT(*) FROM email_outbox").fetchone()[0],
            "notifications": raw.execute("SELECT COUNT(*) FROM notifications WHERE kind IN (%s)" % ",".join("?" * len(NF_KINDS)),
                                         NF_KINDS).fetchone()[0],
            "activity_log": raw.execute("SELECT COUNT(*) FROM activity_log WHERE action IN (%s)" % ",".join("?" * len(RUN_ACTIONS)),
                                        RUN_ACTIONS).fetchone()[0],
            "email_optouts": raw.execute("SELECT COUNT(*) FROM email_optouts").fetchone()[0]}
    raw.close()
    s.section("put back")
    s.check("every row set aside is back, nothing of this suite's left: outbox %d, notifications %d, activity %d, opt-outs %d" % (
        len(STASH["email_outbox"]), len(STASH["notifications"]), len(STASH["activity_log"]), len(KEPT)),
            back == {"email_outbox": len(STASH["email_outbox"]), "notifications": len(STASH["notifications"]),
                     "activity_log": len(STASH["activity_log"]), "email_optouts": len(KEPT)}, back)

sys.exit(s.done())
