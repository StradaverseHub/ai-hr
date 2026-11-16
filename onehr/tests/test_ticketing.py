"""Ticketing (Chris, 2026-10-22: "for the sign in help and get help, combine them into one item put them on the left
panel below All settings, and call it 'Ticketing' ... the super admin should log who closes it (dropdown in a list by
selecting the email address set for the super admin)"; "add the ticketing to our admin role access control page too,
disable for other admins by default"; "go with option A ticketing dashboard"; canvas
[design canvas link removed]).

What this suite holds:
  * one list over both tables: Get Help reports and sign-in requests, each with its own reference, Open / In progress /
    Closed, type chips, a panel each; the old addresses redirect to it
  * Reply & close: a reply is required; Closed by must be one of the closing account's notification emails (typed
    anything else, or none set: refused, unchanged); the email, What you did and the reply stored; a history row; an
    audit row naming the email
  * a Get Help reply goes to their work email as resolved; a sign-in reply only to the address they typed when it is
    the one on their active account, never otherwise
  * Reopen asks who too, clears the reply, sends nothing
  * access: Ticketing's two items are in no preset and no built-in role; a role without them can't open or act; a role
    given them sees only its own people's tickets (a sign-in request naming no account stays the super admin's) and the
    screenshot only of those; the sidebar shows the open count
  * the overview (dashboard A): the tiles, the issues ranked with sign-in grouped, the business groups per 100 people
  * Roles & access: groups folded, Ticketing marked New, the modern name box; View only still reads View only

Writes, so a fresh copy, put back at the end.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Ticketing: one list, Closed by from the notification emails, access by tick, dashboard A")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
sent = []
_cfg, _send = a.mailer.is_configured, a.mailer.send_mail
GA, GB = "ZZTK ALPHA GROUP", "ZZTK BETA GROUP"


def post(client, **form):
    form.setdefault("csrf_token", "tok")
    return client.post("/admin/tickets", data=form)


def user(db, eid, bg, email, role="user", admin_bg=None, left=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                      "company, email, admin_bg, left_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                      (eid, "ZZ TK " + eid, "x", role, eid, bg, bg + " UNIT", email, admin_bg, left)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    PA = user(db, "ZZ9TK-PA", GA, "zz9tk-pa@zz9tk.invalid")
    PB = user(db, "ZZ9TK-PB", GB, "zz9tk-pb@zz9tk.invalid")
    PA2 = user(db, "ZZ9TK-PA2", GA, "zz9tk-pa2@zz9tk.invalid")
    ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZTK Ticket role', 'group')").lastrowid
    ADM = user(db, "ZZ9TK-ADM", "", "zz9tk-adm@zz9tk.invalid", role="admin", admin_bg=GA)
    db.execute("UPDATE users SET admin_role_id=? WHERE id=?", (ROLE, ADM))
    for it in sorted(a.role_preset_items("view")):
        db.execute("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", (ROLE, it))
    db.execute("DELETE FROM admin_notify_emails WHERE user_id IN (?,?)", (SU["id"], ADM))
    for e in ("one@zz9tk.invalid", "two@zz9tk.invalid", "three@zz9tk.invalid", "four@zz9tk.invalid"):
        db.execute("INSERT INTO admin_notify_emails(user_id, email) VALUES (?,?)", (SU["id"], e))
    db.execute("INSERT INTO admin_notify_emails(user_id, email) VALUES (?, 'adm@zz9tk.invalid')", (ADM,))
    hid = {}
    for k, uid, about, where in (("a1", PA, "broken", "the KPI check-in"), ("a2", PA2, "broken", "the KPI check-in"),
                                 ("a3", PA, "figure", "the Total KPI score"), ("b1", PB, "find", "the dashboard")):
        hid[k] = db.execute("INSERT INTO help_requests(user_id, about, detail, where_label, shot_file, emailed, copied) "
                            "VALUES (?,?,?,?,?,4,1)", (uid, about, "ZZTK report " + k, where,
                                                       "zz9tk-%s.png" % k if k in ("a1", "b1") else None)).lastrowid
    sid = {}
    for k, uid, typed, issue in (("s_ok", PA, "zz9tk-pa@zz9tk.invalid", "locked"),
                                 ("s_other", PB, "someone@else.invalid", "password"),
                                 ("s_none", None, "nobody@zz9tk.invalid", "id")):
        sid[k] = db.execute("INSERT INTO signin_requests(issue, full_name, employee_id, email, detail, user_id, "
                            "email_on_file, emailed) VALUES (?,?,?,?,?,?,?,2)",
                            (issue, "ZZ TK typed " + k, "ZZ9TK-" + k.upper(), typed, "ZZTK signin " + k, uid,
                             int(k == "s_ok"))).lastrowid
    # an old one, closed before Ticketing: no email recorded
    OLD = db.execute("INSERT INTO help_requests(user_id, about, detail, status, reply, replied_by, replied_at) "
                     "VALUES (?, 'other', 'ZZTK old report', 'sorted', 'ZZTK old reply', ?, datetime('now','-2 days'))",
                     (PA, SU["id"])).lastrowid
    db.commit()

os.makedirs(a.HELP_UPLOAD_DIR, exist_ok=True)
for k in ("a1", "b1"):
    with open(os.path.join(a.HELP_UPLOAD_DIR, "zz9tk-%s.png" % k), "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)

S = H.client_as(a, SU["id"])
AD = H.client_as(a, ADM)
EMP = H.client_as(a, PA2)
try:
    a.mailer.is_configured = lambda: True
    a.mailer.send_mail = lambda to, subj, html_, **k: sent.append(
        {"to": list(to) if not isinstance(to, str) else [to], "subj": subj, "html": html_})

    s.section("access by default")
    s.check("Ticketing's items are in no preset", not any(
        {"ticketing.read", "ticketing.act"} & a.role_preset_items(k) for k, _l, _d in a.ACCESS_PRESETS))
    with a.app.app_context():
        d = a.get_db()
        built = [r["id"] for r in d.execute("SELECT id FROM admin_roles WHERE builtin IS NOT NULL")]
        held = d.execute("SELECT COUNT(*) FROM admin_role_access WHERE item LIKE 'ticketing.%%' AND role_id IN (%s)"
                         % ",".join("?" * len(built)), built).fetchone()[0] if built else 0
    s.check("no built-in role has them", held == 0, held)
    s.check("a role without them: the list and the overview refused", AD.get("/admin/tickets").status_code in (302, 403)
            and AD.get("/admin/tickets/overview").status_code in (302, 403))
    s.check("...a write refused, nothing changed", post(AD, action="progress", kind="help", ticket_id=str(hid["a1"]))
            .status_code in (302, 403) and H.one(a, "SELECT status FROM help_requests WHERE id=?", (hid["a1"],)) == "new")
    ah = AD.get("/admin").get_data(as_text=True)
    s.check("...and no Ticketing in their menu", 'href="/admin/tickets' not in ah)
    s.check("an employee: refused", EMP.get("/admin/tickets").status_code in (302, 403))
    with a.app.app_context():
        s.check("View only still reads View only (Ticketing is named only when ticked)",
                a.role_summary_words(a.role_preset_items("view")) == "View only"
                and "Ticketing" in a.role_summary_words(a.role_preset_items("view") | {"ticketing.read"}))

    s.section("one list")
    sh = S.get("/admin").get_data(as_text=True)
    n_open = H.one(a, "SELECT (SELECT COUNT(*) FROM help_requests WHERE status='new') + "
                      "(SELECT COUNT(*) FROM signin_requests WHERE done_at IS NULL AND COALESCE(status,'new')='new')")
    s.check("the super admin's menu has Ticketing with its open count",
            re.search(r'href="/admin/tickets/overview"', sh) is not None and ("%d to do" % n_open) in sh, n_open)
    lp = S.get("/admin/tickets?show=all").get_data(as_text=True)
    refs = ["OH-H-%04d" % hid[k] for k in hid] + ["OH-%04d" % sid[k] for k in sid]
    s.check("both kinds in one list, each with its own reference and panel", all(r in lp for r in refs)
            and all(("pnl-tk-help-%d" % hid[k]) in lp for k in hid) and all(("pnl-tk-signin-%d" % sid[k]) in lp for k in sid))
    s.check("the type chips filter", ("OH-%04d" % sid["s_ok"]) not in S.get("/admin/tickets?show=all&type=help")
            .get_data(as_text=True) and ("OH-H-%04d" % hid["a1"]) not in S.get("/admin/tickets?show=all&type=signin")
            .get_data(as_text=True))
    forms = [f for f in re.findall(r"<form[^>]*method=\"post\"[^>]*>", lp) if 'action="/logout"' not in f]   # Log out is a POST form (2-14), no action that asks
    s.check("every action asks first", forms and all("data-confirm" in f for f in forms), len(forms))
    sel = re.search(r'<select id="tk-by-help-%d"[^>]*>(.*?)</select>' % hid["a1"], lp, re.S)
    s.check("Closed by lists exactly this account's four notification emails", sel is not None
            and sorted(re.findall(r'<option value="([^"]+)">', sel.group(1)))
            == sorted(["one@zz9tk.invalid", "two@zz9tk.invalid", "three@zz9tk.invalid", "four@zz9tk.invalid"]))
    s.check("...and a first, empty choice so one must be picked", sel is not None
            and '<option value="">Pick your email</option>' in sel.group(1) and "required" in lp)
    s.check("an old ticket closed before Ticketing says so", "Closed by: not recorded (before Ticketing)" in lp)
    for old, new in (("/admin/signin-help", "type=signin"), ("/admin/help-requests", "type=help")):
        s.check("the old address %s lands on Ticketing" % old, new in S.get(old).headers.get("Location", ""))

    s.section("Reply & close")
    t = hid["a1"]
    post(S, action="close", kind="help", ticket_id=str(t), reply="ZZTK fixed", by_email="someone@typed.invalid")
    s.check("Closed by not one of the account's emails: refused, unchanged",
            H.one(a, "SELECT status FROM help_requests WHERE id=?", (t,)) == "new")
    post(S, action="close", kind="help", ticket_id=str(t), reply="ZZTK fixed")
    s.check("no Closed by: refused, unchanged", H.one(a, "SELECT status FROM help_requests WHERE id=?", (t,)) == "new")
    post(S, action="close", kind="help", ticket_id=str(t), reply="", by_email="two@zz9tk.invalid")
    s.check("no reply: refused, unchanged", H.one(a, "SELECT status FROM help_requests WHERE id=?", (t,)) == "new")
    post(S, action="progress", kind="help", ticket_id=str(t))
    s.check("Mark in progress: moved, a history row", H.one(a, "SELECT status FROM help_requests WHERE id=?", (t,))
            == "progress" and H.one(a, "SELECT COUNT(*) FROM ticket_events WHERE kind='help' AND ticket_id=? AND "
                                       "action='progress'", (t,)) == 1)
    del sent[:]
    r = post(S, action="close", kind="help", ticket_id=str(t), reply="ZZTK We fixed the Save button.",
             did_note="ZZTK cleared the cache", by_email="two@zz9tk.invalid")
    row = H.rows(a, "SELECT * FROM help_requests WHERE id=?", (t,))[0]
    s.check("closed: sorted, the reply, What you did and the email kept", row["status"] == "sorted"
            and row["reply"] == "ZZTK We fixed the Save button." and row["did_note"] == "ZZTK cleared the cache"
            and row["closed_by_email"] == "two@zz9tk.invalid" and row["replied_by"] == SU["id"], dict(row))
    s.check("...a history row with the email", H.one(a, "SELECT by_email FROM ticket_events WHERE kind='help' AND "
                                                        "ticket_id=? AND action='closed'", (t,)) == "two@zz9tk.invalid")
    s.check("...an audit row naming it", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='ticket_close' AND "
                                                 "detail LIKE ?", ("%OH-H-" + "%04d" % t + "%two@zz9tk.invalid%",)) == 1)
    s.check("...emailed to their work email as resolved, the reply in it, never who closed it", len(sent) == 1
            and sent[0]["to"] == ["zz9tk-pa@zz9tk.invalid"] and "is resolved" in sent[0]["subj"]
            and "fixed the Save button" in sent[0]["html"] and "two@zz9tk.invalid" not in sent[0]["html"]
            and "cleared the cache" not in sent[0]["html"], sent)
    s.check("...the save opens the ticket again", "panel=tk-help-%d" % t in r.headers.get("Location", ""))
    cp = S.get("/admin/tickets?show=closed").get_data(as_text=True)
    s.check("the Closed tab shows Closed by in the status's place", "<th scope=\"col\">Closed by</th>" in cp
            and "two@zz9tk.invalid" in cp and 'class="tk-status' not in cp.split("</table>")[0])
    s.check("...its panel: who closed it, the reply, What you did, the history, Reopened by",
            "Closed by two@zz9tk.invalid" in cp and "ZZTK cleared the cache" in cp
            and re.search(r'id="tk-by-help-%d"' % t, cp) is not None and "Reopened by" in cp)

    s.section("sign-in replies go only where they can")
    del sent[:]
    post(S, action="close", kind="signin", ticket_id=str(sid["s_ok"]), reply="ZZTK reset", by_email="one@zz9tk.invalid")
    s.check("typed the address on their account: closed, the reply emailed there",
            H.one(a, "SELECT done_at IS NOT NULL FROM signin_requests WHERE id=?", (sid["s_ok"],)) == 1
            and [x["to"] for x in sent] == [["zz9tk-pa@zz9tk.invalid"]] and "resolved" in sent[0]["subj"], sent)
    del sent[:]
    post(S, action="close", kind="signin", ticket_id=str(sid["s_other"]), reply="ZZTK reset",
         by_email="one@zz9tk.invalid")
    s.check("typed another address: closed, nothing emailed (OneHR never emails a stranger)",
            H.one(a, "SELECT done_at IS NOT NULL FROM signin_requests WHERE id=?", (sid["s_other"],)) == 1 and not sent,
            sent)
    post(S, action="close", kind="signin", ticket_id=str(sid["s_none"]), reply="ZZTK checked",
         by_email="one@zz9tk.invalid")
    s.check("no account: closed, nothing emailed", H.one(a, "SELECT done_at IS NOT NULL FROM signin_requests WHERE id=?",
                                                         (sid["s_none"],)) == 1 and not sent)

    s.section("Reopen")
    post(S, action="reopen", kind="help", ticket_id=str(t))
    s.check("without Reopened by: refused", H.one(a, "SELECT status FROM help_requests WHERE id=?", (t,)) == "sorted")
    del sent[:]
    post(S, action="reopen", kind="help", ticket_id=str(t), by_email="three@zz9tk.invalid")
    row = H.rows(a, "SELECT * FROM help_requests WHERE id=?", (t,))[0]
    s.check("with it: In progress, the reply and Closed by cleared, nothing sent", row["status"] == "progress"
            and row["reply"] is None and row["closed_by_email"] is None and not sent)
    s.check("...a history row and an audit row with the email", H.one(
        a, "SELECT by_email FROM ticket_events WHERE kind='help' AND ticket_id=? AND action='reopened'", (t,))
        == "three@zz9tk.invalid" and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='ticket_reopen' AND "
                                              "detail LIKE ?", ("%three@zz9tk.invalid%",)) == 1)
    post(S, action="reopen", kind="signin", ticket_id=str(sid["s_ok"]), by_email="four@zz9tk.invalid")
    s.check("a sign-in ticket reopens too", H.one(a, "SELECT done_at FROM signin_requests WHERE id=?", (sid["s_ok"],))
            is None and H.one(a, "SELECT status FROM signin_requests WHERE id=?", (sid["s_ok"],)) == "progress")

    s.section("an account with no notification email")
    with a.app.app_context():
        d = a.get_db()
        saved = [r[0] for r in d.execute("SELECT email FROM admin_notify_emails WHERE user_id=?", (SU["id"],))]
        d.execute("DELETE FROM admin_notify_emails WHERE user_id=?", (SU["id"],))
        d.commit()
    np_ = S.get("/admin/tickets?show=all").get_data(as_text=True)
    s.check("Reply & close is off and says why", "has no notification email to pick" in np_ and re.search(
        r'form="tk-close-help-%d" disabled' % hid["a3"], np_) is not None)
    post(S, action="close", kind="help", ticket_id=str(hid["a3"]), reply="x", by_email="one@zz9tk.invalid")
    s.check("...and the server refuses a close all the same", H.one(a, "SELECT status FROM help_requests WHERE id=?",
                                                                    (hid["a3"],)) == "new")
    with a.app.app_context():
        d = a.get_db()
        for e in saved:
            d.execute("INSERT INTO admin_notify_emails(user_id, email) VALUES (?,?)", (SU["id"], e))
        d.commit()

    s.section("a role given Ticketing")
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT INTO admin_role_access(role_id, item) VALUES (?, 'ticketing.read')", (ROLE,))
        d.commit()
    gl = AD.get("/admin/tickets?show=all").get_data(as_text=True)
    s.check("read only: their own group's tickets, nobody else's", ("OH-H-%04d" % hid["a2"]) in gl
            and ("OH-H-%04d" % hid["b1"]) not in gl and ("OH-%04d" % sid["s_ok"]) in gl
            and ("OH-%04d" % sid["s_other"]) not in gl)
    s.check("...never a sign-in request that names no account", ("OH-%04d" % sid["s_none"]) not in gl)
    s.check("...and no actions: they read", "Your admin role reads Ticketing" in gl and 'id="tk-close-' not in gl)
    s.check("...a write refused", post(AD, action="progress", kind="help", ticket_id=str(hid["a2"])).status_code
            in (302, 403) and H.one(a, "SELECT status FROM help_requests WHERE id=?", (hid["a2"],)) == "new")
    s.check("...the overview opens", AD.get("/admin/tickets/overview").status_code == 200)
    s.check("...the screenshot of their own people's opens, another group's doesn't",
            AD.get("/help/shot/%d" % hid["a1"]).status_code == 200 and AD.get("/help/shot/%d" % hid["b1"]).status_code
            == 404)
    s.check("...nor for an employee who isn't the sender", EMP.get("/help/shot/%d" % hid["a1"]).status_code == 404)
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT INTO admin_role_access(role_id, item) VALUES (?, 'ticketing.act')", (ROLE,))
        d.commit()
    gl = AD.get("/admin/tickets?show=all").get_data(as_text=True)
    sel = re.search(r'<select id="tk-by-help-%d"[^>]*>(.*?)</select>' % hid["a2"], gl, re.S)
    s.check("with act: Closed by lists their own account's emails", sel is not None
            and re.findall(r'<option value="([^"]+)">', sel.group(1)) == ["adm@zz9tk.invalid"])
    post(AD, action="close", kind="help", ticket_id=str(hid["a2"]), reply="ZZTK sorted", by_email="adm@zz9tk.invalid")
    s.check("...closes their own people's ticket", H.one(a, "SELECT closed_by_email FROM help_requests WHERE id=?",
                                                         (hid["a2"],)) == "adm@zz9tk.invalid")
    post(AD, action="close", kind="help", ticket_id=str(hid["b1"]), reply="ZZTK sorted", by_email="adm@zz9tk.invalid")
    s.check("...never another group's", H.one(a, "SELECT status FROM help_requests WHERE id=?", (hid["b1"],)) == "new")
    post(AD, action="close", kind="help", ticket_id=str(hid["a3"]), reply="ZZTK sorted", by_email="two@zz9tk.invalid")
    s.check("...nor with the super admin's email", H.one(a, "SELECT status FROM help_requests WHERE id=?",
                                                         (hid["a3"],)) == "new")

    s.section("the overview (dashboard A)")
    ov = S.get("/admin/tickets/overview?d=30").get_data(as_text=True)
    with a.app.app_context():
        d = a.get_db()
        o = a._tickets_overview(d, a.get_db().execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone(),
                                "30", "", "rate")
        n_help = d.execute("SELECT COUNT(*) FROM help_requests WHERE created_at > datetime('now','-30 days')").fetchone()[0]
        n_si = d.execute("SELECT COUNT(*) FROM signin_requests WHERE created_at > datetime('now','-30 days')").fetchone()[0]
        n_open = d.execute("SELECT (SELECT COUNT(*) FROM help_requests WHERE status='new') + (SELECT COUNT(*) FROM "
                           "signin_requests WHERE done_at IS NULL AND COALESCE(status,'new')='new')").fetchone()[0]
        heads = d.execute("SELECT COUNT(*) FROM users WHERE business_group=? AND role!='admin' AND left_at IS NULL "
                          "AND COALESCE(is_demo,0)=0", (GA,)).fetchone()[0]
        got_a = d.execute("SELECT COUNT(*) FROM help_requests h JOIN users u ON u.id=h.user_id WHERE u.business_group=? "
                          "AND h.created_at > datetime('now','-30 days')", (GA,)).fetchone()[0] + d.execute(
            "SELECT COUNT(*) FROM signin_requests r JOIN users u ON u.id=r.user_id WHERE u.business_group=? AND "
            "r.created_at > datetime('now','-30 days')", (GA,)).fetchone()[0]
    s.check("received counts both tables", o["received"] == n_help + n_si, (o["received"], n_help, n_si))
    s.check("open counts what nobody has picked up", o["tiles"]["open"] == n_open, (o["tiles"]["open"], n_open))
    sig = next((i for i in o["issues"] if i["key"] == "signin"), None)
    s.check("the sign-in requests count together as one issue, their reasons under it", sig is not None
            and sig["label"] == "Locked out or password" and sig["n"] == n_si and "Sign-in page" in sig["sub"])
    s.check("the issues are ranked, most first", [i["n"] for i in o["issues"]] == sorted(
        [i["n"] for i in o["issues"]], reverse=True))
    brk = next((i for i in o["issues"] if i["key"] == "broken"), None)
    s.check("...each with where it happens most", brk is not None and brk["sub"].startswith("Mostly the KPI check-in"))
    ga = next((g for g in o["groups"] if g["bg"] == GA), None)
    s.check("a group per 100 of its active people", ga is not None and ga["n"] == got_a
            and ga["rate"] == round(100 * got_a / heads, 1), (ga, got_a, heads))
    s.check("a sign-in request matching no account counts in no group", o["unmatched"] >= 1
            and ("match no account" in ov or "matches no account" in ov))
    s.check("the page shows the tiles, the ranking and the groups", "Most recurring issues" in ov
            and "By business group" in ov and "Time to close (median)" in ov and "Locked out or password" in ov)
    s.check("a row opens its tickets", re.search(r'href="/admin/tickets\?[^"]*topic=signin', ov) is not None
            and re.search(r'href="/admin/tickets\?[^"]*bg=ZZTK', ov) is not None)
    cnt = S.get("/admin/tickets/overview?d=30&by=count").get_data(as_text=True)
    s.check("the Count switch", 'aria-pressed="true" class="is-on">Count' in cnt)
    fl = S.get("/admin/tickets?show=all&topic=signin&d=30").get_data(as_text=True)
    s.check("...its tickets, filtered", ("OH-%04d" % sid["s_ok"]) in fl and ("OH-H-%04d" % hid["a1"]) not in fl)

    s.section("Roles & access")
    rp = S.get("/admin/roles").get_data(as_text=True)
    s.check("every group starts folded, with Open all", '<details class="rl-mod" open' not in rp
            and '<details class="rl-mod">' in rp and "data-rl-foldall" in rp)
    s.check("Ticketing is a group marked New, with its two ticks", re.search(r'Ticketing<span class="rl-new"', rp)
            is not None and 'value="ticketing.read"' in rp and 'value="ticketing.act"' in rp)
    s.check("Add a role's name is the modern box", 'class="rl-name"' in rp)
    s.check("every Ticketing route is classified", isinstance(a.ADMIN_ACCESS_MAP.get("admin_tickets"), dict)
            and a._ACCESS_SECTION_MODULE.get("ticketing") == "ticketing")
finally:
    a.mailer.is_configured, a.mailer.send_mail = _cfg, _send
    for k in ("a1", "b1"):
        try:
            os.remove(os.path.join(a.HELP_UPLOAD_DIR, "zz9tk-%s.png" % k))
        except OSError:
            pass

sys.exit(s.done())
