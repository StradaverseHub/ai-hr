"""Sign-in help (Chris, 2026-10-19: "on the trouble signing in ... change it into a pop out mini ticketing box, where user
can fill in their name, employee ID, and email and a description box to describe their issues with few pre-filled
selections to choose and this will send an email to the super admin (with email set in admin page), and cc the user";
"go with option C, build it" on canvas [design canvas link removed]).

What this suite holds:
  * the sign-in page: Get help in place of the old line, opening the help desk in the assistant card (the card carries
    the server's own numbers, the request card and, only where resets work, the reset card); static/auth.js runs it as
    a script with no AI model, a glow and a dotted line, and falls back to /signin-help where the card isn't shown
  * /signin-help: a page of its own for anyone without the card, and where the card posts (JSON with fetch)
  * a request is stored as typed, with a reference, and answers the SAME whether or not the Employee ID or email exists
  * one email to every super admin's notification addresses, never copying the person (security test 2-07, 2026-10-31):
    the person gets a separate email of fixed words, only when what they typed is the email on that Employee ID's active
    account, with none of the typed words; the subject carries the reference and the issue only (3-10), the typed
    Employee ID is in the body; nothing about the account in the email; no super admin emailed with no addresses set
  * refused: no CSRF token, a missing field, a bad email, more than 500 characters (never trimmed); a filled hidden
    field (a script) is answered as sent and stored nowhere; more than 3 an hour from one address or for one Employee ID
    is answered calmly and neither stored nor sent
  * Ticketing (was People › Sign-in help): the super admin's by default, every request with the account it names, Reply
    & close (who closed it picked from their notification emails) and Reopen (each asks first, each in the audit log)
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Sign-in help: the assistant's help desk, a request, an email to the super admins")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
a.SIGNIN_NOTICE_ASYNC = False   # the person's notice goes inline in a suite, so it can be read at once
NOTICE = a.SIGNIN_NOTICE_SUBJECT


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9SH-%'")]
    db.execute("DELETE FROM signin_requests WHERE employee_id LIKE 'ZZ9SH-%' OR employee_id LIKE 'zz9sh-%'")
    db.execute("DELETE FROM admin_notify_emails WHERE email LIKE '%@zz9sh.invalid'")
    db.execute("DELETE FROM notifications WHERE kind='signin_help' AND to_email LIKE '%zz9sh%'")
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM activity_log WHERE action IN ('signin_help_done', 'signin_help_reopen') AND detail LIKE '%ZZ9SH%'")
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    P = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, email) "
                   "VALUES ('ZZ9SH-P', 'ZZ SH Person', 'x', 'user', 'ZZ9SH-P', 'ZZSH Group', 'zz9sh-p@zz9sh.invalid')"
                   ).lastrowid
    L = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, email, "
                   "left_at) VALUES ('ZZ9SH-L', 'ZZ SH Leaver', 'x', 'user', 'ZZ9SH-L', 'ZZSH Group', "
                   "'zz9sh-l@zz9sh.invalid', '2026-01-01')").lastrowid
    db.commit()
    SUPER_IDS = [r[0] for r in db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' "
                                          "AND left_at IS NULL")]
    HAD = {r[0] for r in db.execute("SELECT DISTINCT user_id FROM admin_notify_emails")}


def anon(ip="198.51.100.7"):
    c = a.app.test_client()
    c.environ_base["REMOTE_ADDR"] = ip
    with c.session_transaction() as ss_:
        ss_["csrf_token"] = "tok"
    return c


def ask(data, ip="198.51.100.7", fetch=True):
    d = dict({"csrf_token": "tok", "issue": "locked", "full_name": "ZZ SH Person", "employee_id": "ZZ9SH-P",
              "email": "zz9sh-p@zz9sh.invalid", "detail": "Waited, still locked"}, **data)
    return anon(ip).post("/signin-help", data=d, headers={"X-Requested-With": "fetch"} if fetch else {})


def n_req(where="1", args=()):
    return H.one(a, "SELECT COUNT(*) FROM signin_requests WHERE (employee_id LIKE 'ZZ9SH-%%' OR employee_id LIKE "
                    "'zz9sh-%%') AND %s" % where, args)


_cfg, _send = a.mailer.is_configured, a.mailer.send_mail
sent = []
try:
    s.section("the sign-in page")
    pg = anon().get("/login").get_data(as_text=True)
    s.check("Get help replaces 'Your People Business Partner can help', and opens the help desk",
            re.search(r'<a href="/signin-help" class="ax-helpbtn" id="ax-help-open" data-help-open '
                      r'aria-controls="ax-help" aria-expanded="false">', pg) is not None
            and "Trouble signing in? Your People Business Partner can help." not in pg)
    box = re.search(r'<div class="axh" id="ax-help" hidden[^>]*>', pg)
    s.check("the help desk sits in the assistant card, hidden until Get help", box is not None
            and pg.find('id="ax-help"') > pg.find('id="ax-demo"'))
    s.check("...carrying the server's own numbers (8 tries, 15 minutes, a 30-minute link)",
            box and ('data-fails="%d"' % a.LOGIN_MAX_FAILS) in box.group(0)
            and ('data-window="%d"' % a.LOGIN_WINDOW_MIN) in box.group(0) and ('data-ttl="%d"' % a.RESET_TTL_MIN)
            in box.group(0))
    tpl = pg[pg.find('id="axh-ticket-tpl"'):]
    s.check("...its request card: the six choices, name, Employee ID, work email, what they see (500), the hidden field",
            all(('value="%s"' % k) in tpl for k, _l in a.SIGNIN_HELP_ISSUES) and 'name="full_name"' in tpl
            and 'name="employee_id"' in tpl and 'name="email"' in tpl and 'maxlength="500"' in tpl
            and 'name="website"' in tpl and 'name="csrf_token"' in tpl)
    s.check("...and the reset card, posting to /forgot (only where resets work)", 'id="axh-forgot-tpl"' in pg
            and 'action="/forgot"' in pg[pg.find('id="axh-forgot-tpl"'):])
    js = open(os.path.join(H.REPO, "static", "auth.js"), encoding="utf-8").read()
    s.check("static/auth.js runs it as a script: posts to the card's own form (fetch), no model, no other address",
            "X-Requested-With" in js and "cardFrom(\"#axh-ticket-tpl\")" in js and "/review" not in js
            and "ask_onehr" not in js and "openai" not in js.lower())
    s.check("...the glow and the dotted line, held then gone, still for reduced motion",
            "is-help-pulse" in js and "drawLine" in js and "later(function () { svg.classList.add(\"is-out\"); }, 2800)" in js
            and "prefers-reduced-motion" in js)
    s.check("...and where the card isn't shown (a narrow screen), the page of its own",
            "if (!card.offsetParent) { window.location.href = helpBtn.href; return; }" in js)

    s.section("/signin-help, the page of its own")
    r = anon().get("/signin-help")
    p = r.get_data(as_text=True)
    s.check("anyone can open it, with the same fields and a way back", r.status_code == 200
            and 'name="full_name"' in p and "Send to the People team" in p and 'href="/login"' in p
            and 'class="auth-shell"' in p and 'class="topbar' not in p)
    s.check("...a choice can come ticked from the link (?issue=locked)",
            re.search(r'value="locked" required checked', anon().get("/signin-help?issue=locked").get_data(as_text=True))
            is not None)

    s.section("a request")
    a.mailer.is_configured = lambda: True
    a.mailer.send_mail = lambda to, subj, html_, **k: sent.append({"to": list(to) if not isinstance(to, str) else [to],
                                                                   "cc": k.get("cc"), "subj": subj, "html": html_})
    s.check("no CSRF token: refused", anon().post("/signin-help", data={"full_name": "x"}).status_code == 400)
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM admin_notify_emails WHERE user_id IN (%s)" % ",".join("?" * len(SUPER_IDS)), SUPER_IDS)
        d.commit()
    r0 = ask({}, ip="198.51.100.40")
    s.check("with no super admin address set: stored, no super admin emailed (the person still gets their notice)",
            r0.get_json().get("ok") and [x for x in sent if x["subj"] != NOTICE] == []
            and H.one(a, "SELECT emailed FROM signin_requests WHERE id=(SELECT MAX(id) FROM signin_requests)") == 0)
    del sent[:]
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT INTO admin_notify_emails(user_id, email, added_by) VALUES (?, 'one@zz9sh.invalid', ?)",
                  (SUPER_IDS[0], SUPER_IDS[0]))
        d.execute("INSERT INTO admin_notify_emails(user_id, email, added_by) VALUES (?, 'two@zz9sh.invalid', ?)",
                  (SUPER_IDS[0], SUPER_IDS[0]))
        d.commit()
    before = n_req()
    r = ask({"full_name": "Typed Requester"}, ip="198.51.100.41")   # a name that is not the account's own
    j = r.get_json()
    s.check("a request: stored as typed, with its reference", r.status_code == 200 and j.get("ok")
            and re.match(r"^OH-\d{4,}$", j.get("ref") or "") and n_req() == before + 1, j)
    row = H.rows(a, "SELECT issue, full_name, employee_id, email, detail, user_id, email_on_file, copied, emailed "
                    "FROM signin_requests WHERE id=(SELECT MAX(id) FROM signin_requests)")[0]
    s.check("...the account it names found, the email the one on file", tuple(row) == (
        "locked", "Typed Requester", "ZZ9SH-P", "zz9sh-p@zz9sh.invalid", "Waited, still locked", P, 1, 1, 2), tuple(row))
    m = sent[-1] if sent else {}
    adm = [x for x in sent if x["subj"] != NOTICE]
    m = adm[-1] if adm else {}
    s.check("ONE email, to every super admin's notification address", len(adm) == 1
            and sorted(m["to"]) == ["one@zz9sh.invalid", "two@zz9sh.invalid"], [x.get("to") for x in sent])
    s.check("...the person is NOT copied on it, though it's the email on their account (2-07)", not m.get("cc")
            and "zz9sh-p@zz9sh.invalid" not in m["to"])
    s.check("...the subject names the reference and the choice, and not the Employee ID they typed (3-10)",
            m.get("subj") == "Sign-in help %s · Account locked" % j.get("ref") and "ZZ9SH" not in m.get("subj", ""),
            m.get("subj"))
    s.check("...the email holds what they typed, the Employee ID too, and nothing about the account",
            "Waited, still locked" in m.get("html", "") and "Typed Requester" in m.get("html", "") and "ZZ9SH-P" in m.get("html", "")
            and not re.search(r"failed sign-in|last signed in|locked until|on file\b", m.get("html", ""), re.I))
    nt = [x for x in sent if x["subj"] == NOTICE]
    s.check("the person gets ONE separate email, to the address on their account, with the fixed words",
            len(nt) == 1 and nt[0]["to"] == ["zz9sh-p@zz9sh.invalid"] and not nt[0].get("cc")
            and a.SIGNIN_NOTICE_TEXT in nt[0]["html"], nt and nt[0]["html"][-300:])
    s.check("...none of what the requester typed is in it: not the name, the Employee ID, the issue or the detail",
            nt and not re.search(r"Waited, still locked|Typed Requester|ZZ9SH|Account locked|OH-\d", nt[0]["html"] + nt[0]["subj"]))
    s.check("...and the request is marked as having told them",
            H.one(a, "SELECT copied FROM signin_requests WHERE id=?", (int(j["ref"].split("-")[1]),)) == 1)
    del sent[:]
    r2 = ask({"email": "someone.else@zz9sh.invalid"}, ip="198.51.100.42")
    s.check("an email that isn't the one on file: sent to the super admins, and no notice to anyone",
            len(sent) == 1 and not sent[0]["cc"] and sent[0]["subj"] != NOTICE, [x["subj"] for x in sent])
    del sent[:]
    r3 = ask({"employee_id": "ZZ9SH-NOBODY"}, ip="198.51.100.43")
    s.check("an Employee ID nobody has: the same, no notice", len(sent) == 1 and sent[0]["subj"] != NOTICE)
    del sent[:]
    ask({"employee_id": "ZZ9SH-L", "email": "zz9sh-l@zz9sh.invalid"}, ip="198.51.100.44")
    s.check("a closed account's own email: still no notice", len(sent) == 1 and sent[0]["subj"] != NOTICE)
    keys = [sorted(x.get_json().keys()) for x in (r, r2, r3)]
    s.check("every answer reads the same (ok and a reference), whatever was typed",
            keys[0] == keys[1] == keys[2] == ["ok", "ref"] and all(x.get_json()["ok"] for x in (r, r2, r3)), keys)

    s.section("what is refused")
    del sent[:]
    before = n_req()
    for what, data, msg in (("no name", {"full_name": " "}, "Put in your name."),
                            ("no Employee ID", {"employee_id": ""}, "Put in your Employee ID."),
                            ("no email", {"email": ""}, "Put in your work email"),
                            ("a bad email", {"email": "not-an-email"}, "doesn't look like an email"),
                            ("over 500 characters", {"detail": "x" * 501}, "Keep it to 500 characters (501 now)")):
        rr = ask(data, ip="198.51.100.50")
        s.check("%s: refused (422), with why" % what, rr.status_code == 422 and msg in (rr.get_json() or {}).get(
            "error", ""), rr.get_json())
    s.check("...none stored, none sent", n_req() == before and not sent)
    rr = ask({"detail": "y" * 500, "employee_id": "ZZ9SH-LONG"}, ip="198.51.100.51")
    s.check("exactly 500 is fine, kept whole", rr.get_json().get("ok")
            and H.one(a, "SELECT LENGTH(detail) FROM signin_requests WHERE id=(SELECT MAX(id) FROM signin_requests)")
            == 500)
    rr = ask({"issue": "<script>", "employee_id": "ZZ9SH-ODD"}, ip="198.51.100.52")
    s.check("a choice not on the list is stored as Something else", rr.get_json().get("ok") and H.one(
        a, "SELECT issue FROM signin_requests WHERE id=(SELECT MAX(id) FROM signin_requests)") == "other")
    del sent[:]
    before = n_req()
    hp = ask({"website": "http://spam.example", "employee_id": "ZZ9SH-BOT"}, ip="198.51.100.53")
    s.check("the hidden field filled (a script): answered as sent, stored nowhere, sent to nobody",
            hp.get_json() == {"ok": True, "ref": None} and n_req() == before and not sent)

    s.section("too many")
    del sent[:]
    ip = "198.51.100.60"
    outs = [ask({"employee_id": "ZZ9SH-R%d" % i}, ip=ip).get_json() for i in range(4)]
    s.check("3 an hour from one address: the 4th is answered calmly, neither stored nor sent",
            all(o.get("ref") for o in outs[:3]) and outs[3] == {"ok": True, "ref": None, "limited": True}
            and len(sent) == 3, outs[3])
    del sent[:]
    outs = [ask({"employee_id": "ZZ9SH-SAME"}, ip="198.51.100.%d" % (70 + i)).get_json() for i in range(4)]
    s.check("...and 3 an hour for one Employee ID, from any address", all(o.get("ref") for o in outs[:3])
            and outs[3].get("limited") and len(sent) == 3)

    s.section("without the script")
    del sent[:]
    pr = ask({"employee_id": "ZZ9SH-PAGE"}, ip="198.51.100.80", fetch=False)
    pt = pr.get_data(as_text=True)
    s.check("the page posts the same and says Help is on its way, with the reference", pr.status_code == 200
            and "Help is on its way" in pt and re.search(r"Your reference is <b>OH-\d{4,}</b>", pt) is not None
            and len(sent) == 1)
    bad = ask({"employee_id": "ZZ9SH-PAGE2", "email": "nope"}, ip="198.51.100.81", fetch=False)
    s.check("...and a mistake comes back on the page, what they typed kept", bad.status_code == 422
            and "doesn&#39;t look like an email" in bad.get_data(as_text=True)
            and 'value="ZZ9SH-PAGE2"' in bad.get_data(as_text=True))

    s.section("Ticketing (was People › Sign-in help)")
    SUP, BAC = H.client_as(a, SU["id"]), H.client_as(a, BGA["id"])
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT OR IGNORE INTO admin_notify_emails(user_id, email, added_by) VALUES (?, 'su@zz9sh.invalid', ?)",
                  (SU["id"], SU["id"]))
        d.commit()
    s.check("a BG admin can't open it (no role has Ticketing until ticked)",
            BAC.get("/admin/tickets?type=signin").status_code in (302, 403))
    s.check("the old address lands on Ticketing's sign-in tickets",
            "/admin/tickets?type=signin" in SUP.get("/admin/signin-help").headers.get("Location", ""))
    lp = SUP.get("/admin/tickets?type=signin&show=all").get_data(as_text=True)
    s.check("the super admin sees each request with its reference and, from the agent, the account it names",
            j.get("ref") in lp and "Account locked" in lp and "Waited, still locked" in lp and "No account with Employee ID"
            in lp and "Their account is closed" in lp and "The email they typed is the one on their account" in lp)
    rid = int(j["ref"].split("-")[1])
    s.check("...Reply & close asks first", re.search(r'<form method="post" id="tk-close-signin-%d"[^>]*data-confirm=' % rid,
                                                    lp, re.S) is not None and 'data-confirm-ok="Reply &amp; close"' in lp)
    del sent[:]
    SUP.post("/admin/tickets", data={"csrf_token": "tok", "action": "close", "kind": "signin", "ticket_id": str(rid),
                                     "reply": "ZZ Your password is reset.", "by_email": "su@zz9sh.invalid"})
    s.check("Closed: by whom, with the email picked", H.one(a, "SELECT done_by FROM signin_requests WHERE id=?", (rid,))
            == SU["id"] and H.one(a, "SELECT closed_by_email FROM signin_requests WHERE id=?", (rid,)) == "su@zz9sh.invalid")
    s.check("...in the audit log", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='ticket_close' AND "
                                            "detail LIKE ?", ("%" + j["ref"] + "%",)) == 1)
    s.check("...the reply went to the address they typed, the one on their account, as resolved",
            any(x["to"] == ["zz9sh-p@zz9sh.invalid"] and "resolved" in x["subj"] and "password is reset" in x["html"]
                for x in sent), [x.get("subj") for x in sent])
    _new = SUP.get("/admin/tickets?type=signin&show=open").get_data(as_text=True)
    _done = SUP.get("/admin/tickets?type=signin&show=closed").get_data(as_text=True)
    s.check("...it moves from Open to Closed", ('>%s<' % j["ref"]) not in _new and ('>%s<' % j["ref"]) in _done)
    SUP.post("/admin/tickets", data={"csrf_token": "tok", "action": "reopen", "kind": "signin", "ticket_id": str(rid),
                                     "by_email": "su@zz9sh.invalid"})
    s.check("...Reopen puts it back", H.one(a, "SELECT done_at FROM signin_requests WHERE id=?", (rid,)) is None)
    s.check("a BG admin can't close one", BAC.post("/admin/tickets", data={
        "csrf_token": "tok", "action": "close", "kind": "signin", "ticket_id": str(rid), "reply": "x",
        "by_email": "su@zz9sh.invalid"}).status_code in (302, 403)
        and H.one(a, "SELECT done_at FROM signin_requests WHERE id=?", (rid,)) is None)
    _spec = a.ADMIN_ACCESS_MAP.get("admin_tickets") or {}
    s.check("Ticketing is in the menu (super admin) and its writes need the act tick",
            'href="/admin/tickets/overview"' in lp and isinstance(_spec, dict)
            and all(_spec["map"].get(k) == ("items", ("ticketing.act",)) for k in ("progress", "close", "reopen"))
            and _spec.get("default") == "super", _spec)
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM admin_notify_emails WHERE email LIKE '%@zz9sh.invalid'")
        d.commit()
    ap = SUP.get("/admin/admins").get_data(as_text=True)
    s.check("the super admin finds their own addresses from their row on Admins (Chris couldn't, 2026-10-19)",
            re.search(r'<a class="btn-link" href="/admin/notify">Notification emails</a>', ap) is not None)
    s.check("...and Account › Notification emails says sign-in help comes there",
            "<b>Sign-in help</b>" in SUP.get("/admin/notify").get_data(as_text=True))
    s.check("with mail on and no address set, the page says nobody gets these by email",
            "Nobody gets new tickets by email yet" in SUP.get("/admin/tickets").get_data(as_text=True))
finally:
    a.mailer.is_configured, a.mailer.send_mail = _cfg, _send
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
