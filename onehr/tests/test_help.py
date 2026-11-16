"""Help in the account menu (Chris, 2026-10-22: "design the Help button in the account menu next ... what it offers and
where a reported issue goes"; "build Help on staging and production as drawn on the canvas";
canvas [design canvas link removed]).

What this suite holds:
  * Help is in the account menu on every signed-in page (an employee's and an admin's), with its panel and script; the
    sign-in page has neither
  * the quick answers follow the page, the view and the part (a line manager in Team gets moderation answers, not the
    check-in's), a moment that's true goes first (a part that has closed), at most five, fixed words; a view the login
    doesn't hold falls back to Mine; reopening is named only in the admins' list (Chris: "we don't socialize this")
  * a report: a listed topic and their words are required, over 1,000 characters is refused (never trimmed), no CSRF is
    refused; the page's details only when ticked, never a query string; one screenshot, an image by its own bytes, up to
    2 MB; more than ten an hour is answered calmly and not stored
  * one email to every super admin's notification addresses and a copy to the person; nobody emailed without addresses
  * the screenshot opens for the person who sent it and the super admin only
  * Ticketing (was People › Help requests): the super admin's by default; Mark in progress, Reply & close (a reply is required; it goes
    to them by email and shows under their reports), Reopen; each asks first and goes in the audit log
  * OneHR Agent's reply pointing to Help carries the Go card (help_go), live and on replay; the welcome's own line about
    Help doesn't

Writes, so a fresh copy, put back at the end.
"""
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
s = H.Suite("Help: quick answers by page, view and part; a report to the super admin; the chat's Go card")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
HERE = os.path.dirname(os.path.abspath(__file__))
JS = open(os.path.join(HERE, "..", "static", "help.js")).read()
JJS = open(os.path.join(HERE, "..", "static", "journey_chat.js")).read()
SU, BGA, _E = H.actors(a)
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
sent = []
_cfg, _send = a.mailer.is_configured, a.mailer.send_mail


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


def report(client, **form):
    d = dict({"csrf_token": "tok", "about": "broken", "detail": "ZZHELP The Save button did nothing."}, **form)
    return client.post("/help/report", data=d, content_type="multipart/form-data",
                       headers={"X-Requested-With": "fetch", "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130"})


def n_rows(where="1", args=()):
    return H.one(a, "SELECT COUNT(*) FROM help_requests WHERE detail LIKE 'ZZHELP%%' AND " + where, args)


with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','evidence','tm','idp','pm')",
               (CID,))
    db.execute("UPDATE cycles SET kind='mid_year', half=2, starts_on=NULL, awaiting_open=0 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
    # an employee with a work email, and a line manager of someone taking part
    ME = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND job_grade IS NOT NULL "
                    "AND COALESCE(email,'')<>'' ORDER BY id LIMIT 1").fetchone()
    OTHER = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND id!=? ORDER BY id LIMIT 1",
                       (ME["id"],)).fetchone()
    SUPER_IDS = [r[0] for r in db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' "
                                          "AND left_at IS NULL")]
    db.execute("DELETE FROM admin_notify_emails WHERE user_id IN (%s)" % ",".join("?" * len(SUPER_IDS)), SUPER_IDS)
    db.execute("DELETE FROM pm_review_chat WHERE subject_id=?", (ME["id"],))
    # this cycle's result not out to them yet (the copy's may be): the part's own answers lead
    for t_ in ("result_releases", "talent_releases"):
        db.execute("DELETE FROM %s WHERE cycle_id=? AND subject_id=?" % t_, (CID, ME["id"]))
    db.commit()
    MGR = None
    for row in db.execute("SELECT DISTINCT manager_id FROM users WHERE manager_id IS NOT NULL AND left_at IS NULL"):
        u_ = db.execute("SELECT * FROM users WHERE id=?", (row[0],)).fetchone()
        if u_ and u_["role"] != "admin" and not u_["left_at"] and "team" in a._journey_views(db, u_):
            MGR = u_
            break
E = H.client_as(a, ME["id"])
O = H.client_as(a, OTHER["id"])
S = H.client_as(a, SU["id"])

try:
    # ------------------------------------------------------------------ the menu, the panel, the script
    dash = E.get("/dashboard").get_data(as_text=True)
    s.check("an employee's account menu has Help, opening the panel", 'data-help-open="home"' in dash
            and "Answers, or report a problem" in dash)
    s.check("...named Get Help, with no New badge (Chris, 2026-10-22: \"remove the new label, change the Help to Get "
            "Help\")", '<span class="acct-help-n">Get Help</span>' in dash and "acct-help-new" not in dash)
    s.check("...and the page carries the panel and its script", 'id="oh-help"' in dash and "help.js" in dash
            and 'data-ep="dashboard"' in dash)
    adm = S.get("/admin").get_data(as_text=True)
    s.check("an admin page has Help in the account menu too", 'data-help-open="home"' in adm and 'id="oh-help"' in adm)
    login = a.app.test_client().get("/login").get_data(as_text=True)
    s.check("the sign-in page has no Help panel (nobody is signed in)", 'id="oh-help"' not in login
            and "help.js" not in login)
    s.check("the menu's item has its own listener (the dropdown stops clicks at its edge)",
            '#acct-menu [data-help-open]' in JS and 'addEventListener("click", opener)' in JS)

    # ------------------------------------------------------------------ the quick answers
    s.check("anyone signed out is sent to sign in", a.app.test_client().get("/help/answers").status_code in (301, 302))
    every = [k for _lab, keys in a.HELP_LISTS.values() for k in keys]
    s.check("every list names answers that exist, five at most",
            all(k in a.HELP_QA for k in every) and all(len(keys) <= a.HELP_LIST_MAX
                                                       for _l, keys in a.HELP_LISTS.values()),
            [k for k in every if k not in a.HELP_QA])
    leak = [k for k, (q, ans) in a.HELP_QA.items() if not k.startswith("adm_") and re.search(r"reopen", q + ans, re.I)]
    s.check("no answer for employees or leaders names reopening (Chris: only for a special case)", not leak, leak)
    s.check("...the admins' list does (Reopen is their tool)", re.search(r"Reopen", a.HELP_QA["adm_submitted"][1]))

    def ans(client, **q):
        return client.get("/help/answers", query_string=q).get_json() or {}

    jd = ans(E, ep="dashboard")
    s.check("on the dashboard: the dashboard's list, Ask OneHR named for anything else",
            jd.get("label") == "Dashboard" and "Ask OneHR" in (jd.get("hint") or "") and 0 < len(jd.get("items") or []) <= 5,
            jd.get("label"))
    s.check("...the topics, the limits and Group People's address come with it",
            [x["key"] for x in jd.get("about") or []] == [k for k, _ in a.HELP_ABOUT] and jd.get("max_text") == 1000
            and jd.get("max_shot_mb") == 2 and jd.get("address") == a.HELP_ADDRESS)
    jk = ans(E, ep="review_journey", view="mine", stage="account")
    s.check("in the check-in, Mine · KPI: the KPI check-in's answers, the wrong-results one first",
            jk.get("label") == "KPI check-in" and (jk.get("items") or [{}])[0].get("key") == "kpi_wrong"
            and "OneHR Agent" in (jk.get("hint") or ""), jk.get("label"))
    jt = ans(E, ep="review_journey", view="mine", stage="competency")
    s.check("...on the competency part, the 360 and competency's", jt.get("label") == "360 and competency"
            and (jt.get("items") or [{}])[0].get("key") == "tm_anon")
    ji = ans(E, ep="review_journey", view="mine", stage="career_plan")
    s.check("...on the Career Plan, the plan's", ji.get("label") == "Career Plan")
    jb = ans(E, ep="review_journey", view="bu", stage="calibration")
    s.check("a view the login doesn't hold is Mine (a crafted ?view=bu)", jb.get("label") == "KPI check-in", jb.get("label"))
    if MGR:
        M = H.client_as(a, MGR["id"])
        jm = ans(M, ep="review_journey", view="team", stage="pm_review")
        s.check("a line manager in Team on KPIs gets the moderation answers, not the check-in's",
                jm.get("label") == "Team · KPI moderation" and (jm.get("items") or [{}])[0].get("key") == "team_mod",
                jm.get("label"))
        jm2 = ans(M, ep="review_journey", view="team", stage="plan_review")
        s.check("...and on the Career Plan review, the approval answers",
                (jm2.get("items") or [{}])[0].get("key") == "team_approve")
        jmd = ans(M, ep="dashboard")
        s.check("on a line manager's dashboard, the last line is their seat's", any(
            x.get("key") == "seat_team" for x in jmd.get("items") or []), [x.get("key") for x in jmd.get("items") or []])
    else:
        s.check("a line manager to test Team with (none in this copy)", False)
    ja = ans(S, ep="admin_overview")
    s.check("an admin gets the admins' list, the Admin Agent named", ja.get("label") == "Admin"
            and "Admin Agent" in (ja.get("hint") or ""))
    jo = ans(E, ep="change_password")
    s.check("any other page: the general list, pointing to the dashboard", jo.get("label") == "OneHR"
            and "dashboard" in (jo.get("hint") or ""))

    # a moment goes first: the KPI check-in closed
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES "
                   "(?, 'pm_results', '2026-01-01 00:00', '2026-01-02 00:00')", (CID,))
        db.commit()
    jc = ans(E, ep="review_journey", view="mine", stage="account")
    keys = [x["key"] for x in jc.get("items") or []]
    s.check("a closed part: can I still read it, and why the chat won't answer, go first",
            keys[:2] == ["closed_read", "closed_chat"] and len(keys) == 5, keys)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        db.commit()
    s.check("...and go once it's open again", [x["key"] for x in (ans(E, ep="review_journey", view="mine",
                                                                       stage="account").get("items") or [])][0]
            == "kpi_wrong")

    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO result_releases(cycle_id, subject_id, kind) VALUES (?, ?, 'pm')", (CID, ME["id"]))
        db.commit()
    jr = ans(E, ep="dashboard")
    s.check("once their result is released to them, why only final bands goes first",
            (jr.get("items") or [{}])[0].get("key") == "rel_bands", [x.get("key") for x in jr.get("items") or []])
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM result_releases WHERE cycle_id=? AND subject_id=?", (CID, ME["id"]))
        db.execute("INSERT INTO leader_releases(cycle_id, subject_id, kind) VALUES (?, ?, 'pm')", (CID, ME["id"]))
        db.commit()
    s.check("...not when it has gone only to their leaders (step 1)", (ans(E, ep="dashboard").get("items") or [{}])[0]
            .get("key") == "dash_start")
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM leader_releases WHERE cycle_id=? AND subject_id=?", (CID, ME["id"]))
        db.commit()

    # ------------------------------------------------------------------ a report
    a.mailer.is_configured = lambda: True
    a.mailer.send_mail = lambda to, subj, html_, **k: sent.append(
        {"to": list(to) if not isinstance(to, str) else [to], "subj": subj, "html": html_})
    s.check("no CSRF token: refused, nothing stored", report(E, csrf_token="").status_code == 400 and n_rows() == 0)
    r = report(E, about="nonsense")
    s.check("a topic not on the list: refused", r.status_code == 422 and n_rows() == 0)
    r = report(E, detail="   ")
    s.check("no words: refused", r.status_code == 422 and n_rows() == 0)
    r = report(E, detail="ZZHELP " + "x" * 1000)
    s.check("over 1,000 characters: refused, never trimmed", r.status_code == 422 and n_rows() == 0
            and "1000" in (r.get_json() or {}).get("error", ""), (r.get_json() or {}).get("error"))
    r = report(E, shot=(io.BytesIO(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "x.png"))
    s.check("a 'screenshot' that isn't an image by its own bytes (an SVG named .png): refused",
            r.status_code == 422 and n_rows() == 0)
    r = report(E, shot=(io.BytesIO(PNG + b"\x00" * (2 * 1024 * 1024)), "big.png"))
    s.check("a screenshot over 2 MB: refused", r.status_code == 422 and n_rows() == 0)

    sent.clear()
    r = report(E)
    j = r.get_json() or {}
    s.check("a report with nobody's address set: stored, a reference back, emailed to no admin",
            j.get("ok") and re.fullmatch(r"OH-H-\d{4,}", j.get("ref") or "") and n_rows() == 1
            and H.one(a, "SELECT emailed FROM help_requests WHERE detail LIKE 'ZZHELP%' ORDER BY id DESC LIMIT 1") == 0,
            j)
    s.check("...the page's details not added unless ticked", H.one(
        a, "SELECT COUNT(*) FROM help_requests WHERE detail LIKE 'ZZHELP%' AND where_label IS NULL AND page_path IS NULL "
           "AND browser IS NULL") == 1)
    s.check("...a copy to them (their work email)", any(x["to"] == [ME["email"].strip()] and j["ref"] in x["subj"]
                                                         for x in sent), [x["subj"] for x in sent])
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO admin_notify_emails(user_id, email) VALUES (?, 'zzhelp-su@zzhelp.invalid')",
                   (SUPER_IDS[0],))
        db.commit()
    sent.clear()
    r = report(E, add_page="1", ep="review_journey", view="mine", stage="account",
               path="/review/journey?stage=account&q=Somebody", title="Your review",
               shot=(io.BytesIO(PNG), "screenshot.png"))
    j2 = r.get_json() or {}
    rid = int(j2.get("ref", "OH-H-0").split("-")[-1])
    row = H.rows(a, "SELECT * FROM help_requests WHERE id=?", (rid,))[0]
    s.check("ticked: where it happened, the path with no query, the browser and system only",
            row["where_label"] == "AI+ check-in · Mine · KPI check-in" and row["page_path"] == "/review/journey"
            and row["browser"] == "Chrome on Windows", (row["where_label"], row["page_path"], row["browser"]))
    s.check("...the screenshot kept as a file, by its bytes", row["shot_file"] and row["shot_file"].endswith(".png")
            and os.path.isfile(os.path.join(a.HELP_UPLOAD_DIR, row["shot_file"])) and row["shot_bytes"] == len(PNG))
    adm_mail = [x for x in sent if "zzhelp-su@zzhelp.invalid" in x["to"]]
    s.check("one email to the super admins' addresses, its reference in the subject",
            len(adm_mail) == 1 and j2["ref"] in adm_mail[0]["subj"] and row["emailed"] == 1, [x["to"] for x in sent])
    s.check("...their words in it, the screenshot left in OneHR", adm_mail and "Save button did nothing" in
            adm_mail[0]["html"] and "attached in OneHR" in adm_mail[0]["html"] and "base64" not in adm_mail[0]["html"])
    s.check("their reports come back with it", (j2.get("mine") or [{}])[0].get("ref") == j2.get("ref"))

    # the screenshot: theirs and the super admin's only
    g1 = E.get("/help/shot/%d" % rid)
    s.check("the person who sent it opens their screenshot", g1.status_code == 200 and g1.mimetype == "image/png"
            and g1.headers.get("X-Content-Type-Options") == "nosniff")
    s.check("...the super admin too", S.get("/help/shot/%d" % rid).status_code == 200)
    s.check("...nobody else (another employee)", O.get("/help/shot/%d" % rid).status_code == 404)
    if BGA:
        s.check("...nor a BG admin", H.client_as(a, BGA["id"]).get("/help/shot/%d" % rid).status_code == 404)

    # an hour's worth
    with a.app.app_context():
        db = a.get_db()
        have = db.execute("SELECT COUNT(*) FROM help_requests WHERE user_id=?", (ME["id"],)).fetchone()[0]
        for _ in range(a.HELP_PER_HOUR - have):
            db.execute("INSERT INTO help_requests(user_id, about, detail) VALUES (?, 'other', 'ZZHELP filler')",
                       (ME["id"],))
        db.commit()
    before = n_rows()
    r = report(E)
    s.check("over ten an hour: answered calmly (429), nothing stored", r.status_code == 429 and n_rows() == before
            and a.HELP_ADDRESS in (r.get_json() or {}).get("error", ""))
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM help_requests WHERE detail='ZZHELP filler'")
        db.commit()

    # ------------------------------------------------------------------ Ticketing (was People › Help requests)
    s.check("an employee can't open Ticketing", E.get("/admin/tickets").status_code in (302, 403, 404))
    if BGA:
        s.check("...nor a BG admin (no role has Ticketing until the super admin ticks it)",
                H.client_as(a, BGA["id"]).get("/admin/tickets").status_code in (302, 403, 404))
    s.check("the old Help requests address lands on Ticketing's Get Help tickets",
            "/admin/tickets?type=help" in S.get("/admin/help-requests").headers.get("Location", ""))
    page = S.get("/admin/tickets?show=all").get_data(as_text=True)
    s.check("the super admin's list has the report with its panel", j2["ref"] in page and ('pnl-tk-help-%d' % rid) in page)
    forms = [f for f in re.findall(r"<form[^>]*method=\"post\"[^>]*>", page) if 'action="/logout"' not in f]   # Log out is a POST form (2-14), no action that asks
    s.check("every action on it asks first", forms and all("data-confirm" in f for f in forms), len(forms))
    s.check("People no longer carries it; Ticketing does",
            not any(p["ep"] in ("admin_help_requests", "admin_signin_help") for sec in a.ADMIN_SECTIONS
                    for t in sec["tabs"] for p in t["pages"])
            and any(p["ep"] == "admin_tickets" for sec in a.ADMIN_SECTIONS if sec["key"] == "ticketing"
                    for t in sec["tabs"] for p in t["pages"]))
    post(S, "/admin/tickets", action="progress", kind="help", ticket_id=str(rid))
    s.check("Mark in progress: moved, in the audit log", H.one(a, "SELECT status FROM help_requests WHERE id=?", (rid,))
            == "progress" and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='ticket_progress' AND "
                                       "detail LIKE ?", ("%" + j2["ref"] + "%",)) == 1)
    post(S, "/admin/tickets", action="close", kind="help", ticket_id=str(rid), reply="",
         by_email="zzhelp-su@zzhelp.invalid")
    s.check("Reply & close with no reply: refused, unchanged",
            H.one(a, "SELECT status FROM help_requests WHERE id=?", (rid,)) == "progress")
    sent.clear()
    post(S, "/admin/tickets", action="close", kind="help", ticket_id=str(rid), reply="ZZ We fixed the Save button.",
         by_email="zzhelp-su@zzhelp.invalid")
    row = H.rows(a, "SELECT * FROM help_requests WHERE id=?", (rid,))[0]
    s.check("with a reply: closed (sorted), the reply kept, who and when", row["status"] == "sorted"
            and row["reply"] == "ZZ We fixed the Save button." and row["replied_by"] == SU["id"] and row["replied_at"]
            and row["closed_by_email"] == "zzhelp-su@zzhelp.invalid")
    s.check("...the reply emailed to them as resolved, quoting the reference", any(
        x["to"] == [ME["email"].strip()] and j2["ref"] in x["subj"] and "resolved" in x["subj"]
        and "fixed the Save button" in x["html"] for x in sent))
    s.check("...in the audit log", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='ticket_close' AND "
                                            "detail LIKE ?", ("%" + j2["ref"] + "%",)) == 1)
    mine = (ans(E, ep="dashboard").get("mine") or [])
    s.check("...and under their reports in Help", any(m["ref"] == j2["ref"] and m["status"] == "sorted"
                                                       and "fixed the Save button" in m["reply"] for m in mine))
    s.check("another person never sees it", not any(m["ref"] == j2["ref"] for m in ans(O, ep="dashboard").get("mine") or []))
    post(S, "/admin/tickets", action="reopen", kind="help", ticket_id=str(rid), by_email="zzhelp-su@zzhelp.invalid")
    s.check("Reopen: back to In progress", H.one(a, "SELECT status FROM help_requests WHERE id=?", (rid,)) == "progress")
    s.check("every ticket action has its audit words", {"ticket_progress", "ticket_close", "ticket_reopen"}
            <= set(a.ACTION_LABELS))
    s.check("Help's routes stay up whatever module is off", {"help_answers_view", "help_report", "help_shot"}
            <= set(a.MODULE_UNGATED_ENDPOINTS))

    # ------------------------------------------------------------------ the Go card
    a.mailer.is_configured, a.mailer.send_mail = _cfg, _send
    s.check("a reply pointing to Help is marked", a._help_points(
        "Sorry about that. Please report it with Help in the account menu at the top right."))
    s.check("...help with writing isn't", not a._help_points("I'll help you write your remark in your own words."))
    SCRIPT = [{"say": "Sorry about that. You can tell me the figure and I'll save it. To let Group People know, please "
                      "report it with Help in the account menu at the top right.", "quick_replies": [], "action": None}]
    _avail, _agent = ai_draft.review_agent_available, ai_draft.review_agent
    ai_draft.review_agent_available = lambda: True
    ai_draft.review_agent = lambda system, messages, timeout=90: (SCRIPT.pop(0) if SCRIPT else
                                                                 {"say": "(the model answered)", "quick_replies": [],
                                                                  "action": None})
    try:
        j0 = post(E, "/review/chat?journey=1", message="", stage="account").get_json() or {}
        steps = j0.get("intro") or []
        for i in range(len(steps)):
            post(E, "/review/intro/seen", step=str(i), stage="account")
        jt_ = post(E, "/review/chat?journey=1", message="The Save button did nothing", stage="account").get_json() or {}
        s.check("live: the reply pointing to Help carries the Go card", jt_.get("help_go") is True and "Help in the "
                "account menu" in (jt_.get("say") or ""), jt_.get("say"))
        jh = E.get("/review/chat/history?journey=1&stage=account").get_json() or {}
        go = [m for m in jh.get("messages") or [] if m.get("help_go")]
        intro3 = [m for m in jh.get("messages") or [] if str(m.get("content", "")).startswith(a._INTRO_HELP_OPEN)]
        s.check("on replay: that reply has it", len(go) == 1 and "top right" in go[0].get("content", ""), len(go))
        s.check("...the welcome's own line about Help doesn't", intro3 and not any(m.get("help_go") for m in intro3),
                len(intro3))
    finally:
        ai_draft.review_agent_available, ai_draft.review_agent = _avail, _agent
    s.check("the page draws the card and Go opens Help on Report a problem", "helpGoCard" in JJS
            and 'window.ohHelp.open("report")' in JJS and "if (m.help_go) helpGoCard();" in JJS
            and "if (anchor && j.help_go) helpGoCard();" in JJS)
    s.check("the journey tells Help its view and part", "window.ohHelpCtx" in JJS)
    s.check("the panel takes a pasted screenshot from the clipboard", '"paste"' in JS and "getAsFile" in JS)

    # ------------------------------------------------------------------ the agents and the tour know Get Help
    # (Chris, 2026-10-22: "we need to consistently update whenever there is a new feature or new module, so our agent
    # and the first login tutorial can pick them up")
    ASKJS = open(os.path.join(HERE, "..", "static", "ask_onehr.js")).read()
    OBJS = open(os.path.join(HERE, "..", "static", "onboarding.js")).read()
    with a.app.test_request_context("/"):
        hits = {q: a._ask_intent(q, {}) for q in (
            "The save button isn't working", "I want to report a problem", "I found a bug on my KPI page",
            "my page won't load", "where do I get help?", "how do I contact Group People")}
        miss = {q: a._ask_intent(q, {}) for q in ("help me write my remark", "what's pending for me?")}
    s.check("Ask OneHR: something not working, or wanting help, gets Get Help's Report a problem card, in code",
            all(h and (h.get("cards") or [{}])[0].get("help") == "report" for h in hits.values()),
            {q: bool(h and (h.get("cards") or [{}])[0].get("help")) for q, h in hits.items()})
    s.check("...never 'help me write' (the check-in's Write with AI) and never what's pending",
            not (miss["help me write my remark"] or {}).get("cards") and
            (miss["what's pending for me?"] or {}).get("mark") == "here",
            {q: (h or {}).get("cards") for q, h in miss.items()})
    ja_ = E.post("/ask", data={"csrf_token": "tok", "message": "the save button isn't working"}).get_json() or {}
    s.check("...through the route, with no model call", ja_.get("mode") == "direct"
            and (ja_.get("cards") or [{}])[0].get("help") == "report" and "Get Help" in (ja_.get("say") or ""),
            ja_.get("say"))
    s.check("the guide draws that card as Get Help's opener", 'b.setAttribute("data-help-open"' in ASKJS
            and "if (c.help)" in ASKJS)
    with a.app.test_request_context("/"):
        db = a.get_db()
        facts, _links = a._ask_facts(db, a.get_db().execute("SELECT * FROM users WHERE id=?", (ME["id"],)).fetchone(),
                                     {})
    s.check("Ask OneHR's facts say where Get Help is, so the model can too", any(
        f.startswith("GET HELP:") and "Account menu" in f for f in facts))
    with a.app.app_context():
        kb = a.get_db().execute("SELECT title, body, tags FROM kb_entries WHERE slug='get-help'").fetchone()
    s.check("the KB has Get Help, in plain words (no ids, tools or numbers)", kb is not None and "Report a problem"
            in kb["body"] and "Account menu" in kb["body"] and not re.search(r"\d|tool|_", kb["body"]),
            kb and kb["body"][:80])
    with a.app.test_request_context("/"):
        g_ = a._ask_guide(a.get_db(), "how do I report a problem")
    s.check("...and Ask OneHR's guide finds it", any("report" in (x.get("title") or "").lower()
                                                     or "Get Help" in (x.get("body") or "") for x in g_ or []),
            [x.get("title") for x in g_ or []])
    # the stop's title names What's new too since the release log (2026-11-03): "What's new and Get Help"
    s.check("the first sign-in tour has a Get Help stop on the account button", bool(re.search(
            r'\{ sel: \["#acct-trigger"\], title: "[^"]*Get Help"', OBJS)) and "Report a problem" in OBJS)
    s.check("...and the tour says Group People, never HR", not re.search(r"\bHR\b", OBJS))

    s.section("A required field left empty is marked where it is (Chris, 2026-10-22: \"link them to it and red highlight "
              "the section\")")
    TPLH = open(os.path.join(HERE, "..", "templates", "_help_panel.html")).read()
    CSSH = open(os.path.join(HERE, "..", "static", "style.css")).read()
    s.check("both required fields are sections with their own message under them, tied to the control",
            'data-hp-field="about" aria-describedby="hp-about-err"' in TPLH
            and '<p class="hp-ferr" id="hp-about-err" data-hp-ferr="about" hidden>' in TPLH
            and 'data-hp-field="detail"' in TPLH and 'aria-describedby="hp-detail-err"' in TPLH
            and '<p class="hp-ferr" id="hp-detail-err" data-hp-ferr="detail" hidden>' in TPLH)
    _send_fn = JS[JS.find("function send()"):JS.find("var c = ctx();", JS.find("function send()"))]
    s.check("Send report marks EVERY empty one, writes the linked note and takes them to the first",
            "FIELDS.forEach(function (k) { fieldErr(k, missing.indexOf(k) >= 0); });" in _send_fn
            and "missingNote(); goField(missing[0]); return;" in _send_fn and 'err("Pick what' not in _send_fn)
    s.check("...the note names each one as a link that jumps to it", 'el("button", "hp-errlink"' in JS
            and "goField(k);" in JS and 'box.scrollIntoView({ block: "center"' in JS)
    s.check("...and a field clears as soon as it's filled; a fresh form and a reopen start clean",
            'aboutBox.addEventListener("change", function () { fieldErr("about", false); missingNote(); });' in JS
            and 'if (detail.value.trim()) fieldErr("detail", false);' in JS
            and "dropShot(); clearErr(); clearFields(); countNow();" in JS and "clearErr(); clearFields(); pickAbout(about);" in JS)
    s.check("the look: the section tinted and edged red, its label red, the note a tinted box (red is for alerts)",
            ".hp-field.is-invalid { margin: 0 -12px; padding: 10px 12px;" in CSSH
            and H.cv(".hp-field.is-invalid .hp-label { color: var(--red-700); }") in CSSH
            and ".hp-err:not([hidden]) {" in CSSH and ".hp-ferr[hidden] { display: none; }" in CSSH)
finally:
    a.mailer.is_configured, a.mailer.send_mail = _cfg, _send
    with a.app.app_context():
        db = a.get_db()
        for (f,) in db.execute("SELECT shot_file FROM help_requests WHERE shot_file IS NOT NULL").fetchall():
            try:
                os.remove(os.path.join(a.HELP_UPLOAD_DIR, os.path.basename(f)))
            except OSError:
                pass

sys.exit(s.done())
