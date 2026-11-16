"""Announcements and the deadline reminder in the notice bar (Chris, 2026-10-26: "use this as an announcement banner
like telling user the deadline, when to submit, and please ensure you save your submission"; "can more than 1
announcement run at a time? (the upgrade should supersede all and stand alone)"; "for the login page, we just need
general announcement"; "make it configurable on where the announcement can appear, including option for AI+ check in
page, but disable by default ... keep them looping continuously"; canvas [design canvas link removed]
boards 12-16b).

What this suite holds:
  * Admin › Notices lists announcements and the deadline reminder; posting, changing and ending are the super admin's,
    double-confirmed and audited; a BG admin can't post
  * the form: a headline (60) and a message (160), an audience from its list, a role ticked for picked roles, an end
    after its start and after now, at most 92 days; a page ticked, the sign-in page only with Everyone (the sign-in page
    alone has no button); a page open from before pages keeps the old meaning
  * who sees one: everyone signed in (admins too); the roles whose part is open (follows the calendar day by day);
    picked roles (an HOD only, not their people); the sign-in page only general ones, never a targeted one, with no
    button
  * where: only on the pages ticked (sign-in, dashboard, AI+ check-in, admin pages, every other page), the AI+ check-in
    never by default; one posted before pages = the dashboard (and the sign-in page if it was for it); the deadline
    reminder on its own pages (the dashboard by default); no Got it (its route is gone)
  * several at once, newest first, all in one line
  * a notice before OneHR closes stands alone: no announcement nor reminder while it is current
  * the deadline reminder: each person's own soonest-closing part from the calendar, from the set days before, only
    while something of theirs waits; the last day red, first and not put away; a line manager's count of people; off,
    an admin, nothing waiting or a closed part = none; kept a few minutes, dropped by their own POST; on the real
    readers it runs
  * the page script builds the bar's words as text, never markup, every item in one line that loops; the layout var
    follows the announcement bar; the KB row is conceptual and has no Got it

Writes, so a fresh copy, put back at the end.
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta

from werkzeug.datastructures import MultiDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Announcements and the deadline reminder: who sees what, several at once, the notice alone")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
SU, BGA, _E = H.actors(a)
_real_now, _real_items = a._now_myt, a.reminder_items


def at(dt):
    a._now_myt = lambda: dt


def real():
    a._now_myt = _real_now


def post(client, **form):
    form.setdefault("csrf_token", "tok")
    return client.post("/admin/notices", data=form)


with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','evidence','tm','idp','pm')",
               (CID,))
    db.execute("UPDATE cycles SET kind='year_end', half=2, starts_on=NULL, awaiting_open=0, open_by_date=1 WHERE id=?",
               (CID,))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    db.execute("DELETE FROM site_notices")
    db.execute("DELETE FROM site_announcements")
    db.execute("DELETE FROM app_settings WHERE key IN ('deadline_reminder','release_window','notice_hold')")
    db.commit()
    TODAY = a._today_myt()
    NOW = datetime(TODAY.year, TODAY.month, TODAY.day, 10, 0)
    D = lambda n: (TODAY + timedelta(days=n)).isoformat()   # noqa: E731
    # the calendar: the employees' check-in open now, closing in 2 days; the line managers' after it; the HOD's last
    CAL = {"pm_results": (D(-1), D(2)), "tc_self": (D(-1), D(2)), "idp_self": (D(-1), D(2)), "f360": (D(-1), D(2)),
           "pm_approve": (D(3), D(9)), "tc_approve": (D(3), D(9)), "idp_review": (D(3), D(9)),
           "pm_hod": (D(12), D(16)), "pot_hod": (D(12), D(16))}
    for cell, (o, c) in CAL.items():
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                   (CID, cell, o + " 00:00", c + " 23:59"))
    db.commit()
    cyc = a.active_cycle(db)
    # someone taking part (their check-in is theirs), and someone who is only an HOD
    EMP = None
    lead_free = ("id NOT IN (SELECT hod_id FROM users WHERE hod_id IS NOT NULL) AND id NOT IN (SELECT user_id FROM "
                 "buceo_seats) AND COALESCE(bgceo_bg,'')=''")
    for u in db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 AND "
                        + lead_free + " ORDER BY id LIMIT 400"):
        if a.participation(db, u, cyc, module="pm")[0]:
            EMP = u
            break
    HODU = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND id!=? AND id NOT IN "
                      "(SELECT manager_id FROM users WHERE manager_id IS NOT NULL) AND " + lead_free +
                      " ORDER BY id DESC LIMIT 1", (EMP["id"],)).fetchone()
    db.execute("UPDATE users SET hod_id=? WHERE id=?", (HODU["id"], EMP["id"]))
    db.commit()
    EMP = db.execute("SELECT * FROM users WHERE id=?", (EMP["id"],)).fetchone()
S = H.client_as(a, SU["id"])
B = H.client_as(a, BGA["id"]) if BGA else None
E = H.client_as(a, EMP["id"])


def items(uid=None, auth=False, now=None, place="dashboard"):
    with a.app.test_request_context("/"):
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone() if uid else None
        return a.bar_items(db, u, auth=auth, now=now or NOW, place=place)


def rules():
    with a.app.app_context():
        return a.deadline_rules()


def heads(xs):
    return [x["lead"] for x in xs if x["kind"] == "ann"]


def add(headline, audience="everyone", roles=None, on_signin=0, button="none", start=None, end=None, places=None):
    """places None = posted before announcements had pages"""
    with a.app.app_context():
        db = a.get_db()
        cur = db.execute("INSERT INTO site_announcements(headline, message, audience, roles, on_signin, button, "
                         "starts_at, ends_at, created_by, places) VALUES (?,?,?,?,?,?,?,?,?,?)",
                         (headline, "Message for " + headline, audience, json.dumps(roles) if roles else None,
                          on_signin, button, (start or NOW - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M"),
                          (end or NOW + timedelta(days=5)).strftime("%Y-%m-%d %H:%M"), SU["id"], places))
        db.commit()
        return cur.lastrowid


def clear():
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM site_announcements")
        db.execute("DELETE FROM site_notices")
        db.commit()
    a._DL_CACHE.clear()


try:
    at(NOW)
    a.reminder_items = lambda db, u: []   # no deadline reminder until the section that means one
    # ------------------------------------------------------------------ the admin page
    s.section("Admin › Notices: announcements and the deadline reminder, the super admin's")
    page = S.get("/admin/notices").get_data(as_text=True)
    s.check("the page lists announcements and the deadline reminder, with Post an announcement",
            "Announcements" in page and "Deadline reminder" in page and 'data-panel-open="announce"' in page
            and 'id="ntc-ann"' in page and 'id="ntc-dl"' in page)
    s.check("the reminder's preview reads the calendar (the employees' part closes in 2 days)",
            "Your check-in closes" in page and "Last day: your check-in closes tonight at 23:59" in page)
    forms = re.findall(r'<form method="post" action="/admin/notices"[^>]*>', page)
    s.check("every form on the page is double-confirmed", forms and all("data-confirm=" in f for f in forms), len(forms))
    form = dict(action="ann_post", headline="OneHR goes live on Mon 2 Nov", message="Check your details now.",
                audience="everyone", places_sent="1", places=["signin", "dashboard"], button="profile",
                from_date=D(0), from_time="now", until_date=D(6), until_time="23:59")
    if B:
        n0 = H.one(a, "SELECT COUNT(*) FROM site_announcements")
        r = post(B, **form)
        s.check("a BG admin can't post one", r.status_code in (302, 403, 404)
                and H.one(a, "SELECT COUNT(*) FROM site_announcements") == n0)
    r = post(S, **form)
    aid = H.one(a, "SELECT MAX(id) FROM site_announcements")
    row = None
    with a.app.app_context():
        row = a.get_db().execute("SELECT * FROM site_announcements WHERE id=?", (aid,)).fetchone()
    s.check("the super admin posts one: from now, until its day at 23:59, Everyone, the sign-in page and dashboard",
            r.status_code == 302 and row and row["audience"] == "everyone" and row["places"] == "signin,dashboard"
            and row["starts_at"] == NOW.strftime("%Y-%m-%d %H:%M") and row["ends_at"] == D(6) + " 23:59"
            and row["button"] == "profile" and row["version"] == 1, dict(row) if row else None)
    s.check("...audited", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='bar_announce_post'") >= 1)
    page = S.get("/admin/notices").get_data(as_text=True)
    s.check("it's listed, showing now, where it shows, with Change and End", "OneHR goes live on Mon 2 Nov" in page
            and "Showing now" in page and "<td>Sign-in page and dashboard</td>" in page and "aedit=%d" % aid in page
            and 'value="ann_end"' in page)
    r = post(S, action="ann_update", aid=str(aid), **{k: v for k, v in form.items() if k != "action"})
    with a.app.app_context():
        row = a.get_db().execute("SELECT * FROM site_announcements WHERE id=?", (aid,)).fetchone()
    s.check("changing it moves its version on", row["version"] == 2
            and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='bar_announce_change'") >= 1)
    r = post(S, action="ann_end", aid=str(aid))
    with a.app.app_context():
        row = a.get_db().execute("SELECT * FROM site_announcements WHERE id=?", (aid,)).fetchone()
    s.check("ending it takes it off the bar at once", row["status"] == "ended" and not heads(items(EMP["id"]))
            and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='bar_announce_end'") >= 1)
    clear()

    # ------------------------------------------------------------------ the form
    s.section("The form: lengths, a listed audience, a ticked role, an end after its start")

    def check_form(label, want_error, **over):
        f = dict(headline="A headline", message="A message.", audience="everyone", from_date=D(0), from_time="now",
                 until_date=D(3), until_time="23:59")
        f.update(over)
        md = MultiDict([(k, x) for k, v in f.items() for x in (v if isinstance(v, list) else [v])])
        with a.app.test_request_context("/"):
            v, err = a.bar_ann_form(md, NOW, a.get_db())
        s.check(label, (err is not None) == want_error and (want_error or v is not None), err or v)
        return v
    check_form("a headline is required", True, headline="  ")
    check_form("a headline over 60 is refused", True, headline="x" * 61)
    check_form("a message over 160 is refused", True, message="y" * 161)
    check_form("an audience not on the list is refused", True, audience="hackers")
    check_form("picked roles need one ticked", True, audience="roles")
    check_form("a role not on the list doesn't count", True, audience="roles", roles=["root"])
    check_form("an end before its start is refused", True, from_date=D(3), from_time="10:00", until_date=D(2))
    check_form("an end already past is refused", True, from_date=D(-2), from_time="10:00", until_date=D(-1))
    check_form("at most 92 days", True, until_date=D(95))
    v = check_form("HODs only, at a time", False, audience="roles", roles=["hod"], from_date=D(1), from_time="08:00")
    s.check("...stored as picked, from 08:00", v and json.loads(v["roles"]) == ["hod"]
            and v["starts_at"] == D(1) + " 08:00")
    check_form("a page is required", True, places_sent="1")
    check_form("a page not on the list doesn't count", True, places_sent="1", places=["everywhere"])
    check_form("the sign-in page only with Everyone", True, audience="open", places_sent="1",
               places=["signin", "dashboard"])
    v = check_form("ticked pages are stored in their order", False, places_sent="1", places=["checkin", "dashboard"])
    s.check("...", v and v["places"] == "dashboard,checkin" and v["on_signin"] == 0, v and v["places"])
    v = check_form("the sign-in page alone has no button", False, places_sent="1", places=["signin"], button="profile")
    s.check("...nobody is signed in there", v and v["button"] == "none" and v["on_signin"] == 1)
    v = check_form("a page open from before pages: the dashboard, and the sign-in page if ticked", False,
                   on_signin="1")
    s.check("...", v and v["places"] == "signin,dashboard", v and v["places"])
    v = check_form("...its Sign-in page only: Everyone, on the sign-in page, no button", False, audience="signin",
                   button="profile")
    s.check("...", v and v["audience"] == "everyone" and v["places"] == "signin" and v["button"] == "none", v)
    # a button to a page in OneHR, picked from OneHR's own list (2026-10-26: a feature's page, a programme's detail)
    L = dict(button="link", link_label="View the programme")
    check_form("a link button needs its words", True, button="link", link_target="page:profile")
    check_form("...words over 24 are refused", True, button="link", link_label="w" * 25, link_target="page:profile")
    check_form("...and a page picked", True, **L)
    check_form("...from the list only: an address typed in isn't a pick", True, link_target="/profile", **L)
    check_form("...nor a page that isn't on it", True, link_target="page:admin", **L)
    v = check_form("a page picked: kept as the pick, the button column 'none' (its CHECK is older than the link)", False,
                   link_target="page:profile", **L)
    s.check("...", v and v["link_target"] == "page:profile" and v["link_label"] == "View the programme"
            and v["button"] == "none", v)
    v = check_form("on the sign-in page alone the link is dropped too", False, places_sent="1", places=["signin"],
                   link_target="page:profile", **L)
    s.check("...", v and v["button"] == "none" and v["link_target"] is None, v)
    _lms0 = os.environ.get("ONEHR_LMS")
    os.environ.pop("ONEHR_LMS", None)
    check_form("with AI+ Learning off, its pages aren't on the list", True, link_target="page:learning", **L)
    with a.app.test_request_context("/"):
        keys = [t["key"] for t in a.bar_link_targets(a.get_db())]
    s.check("...nor in the picker", "page:profile" in keys and not [k for k in keys if "learning" in k or
                                                                      k.startswith("prog:")], keys)
    os.environ["ONEHR_LMS"] = "1"
    try:
        with a.app.app_context():
            db = a.get_db()
            cur = db.execute("INSERT INTO lms_programmes(title, status) VALUES ('Zz banner test programme', 'published')")
            PROG = cur.lastrowid
            DRAFT = db.execute("INSERT INTO lms_programmes(title, status) VALUES ('Zz banner draft', 'draft')").lastrowid
            db.commit()
        with a.app.test_request_context("/"):
            tg = a.bar_link_targets(a.get_db())
        s.check("with Learning on: its pages and each published programme are on the list, a draft isn't",
                "page:learning" in [t["key"] for t in tg] and {"key": "prog:%d" % PROG, "name": "Zz banner test programme",
                                                                "kind": "Learning programme", "words": "View the programme"} in tg
                and "prog:%d" % DRAFT not in [t["key"] for t in tg])
        check_form("...a programme picked", False, link_target="prog:%d" % PROG, **L)
        check_form("...a draft refused", True, link_target="prog:%d" % DRAFT, **L)
        lid = add("New programme", places="dashboard")
        with a.app.app_context():
            a.get_db().execute("UPDATE site_announcements SET link_label='View the programme', link_target=? WHERE id=?",
                               ("prog:%d" % PROG, lid))
            a.get_db().commit()
        xs = items(EMP["id"])
        s.check("...in the bar: their words, to the programme's page", xs and xs[0]["button"] == {
            "label": "View the programme", "url": "/learning/programme/%d" % PROG}, xs)
        with a.app.app_context():
            a.get_db().execute("UPDATE lms_programmes SET status='archived' WHERE id=?", (PROG,))
            a.get_db().commit()
        s.check("...taken down: the button goes, the announcement stays", heads(items(EMP["id"])) == ["New programme"]
                and items(EMP["id"])[0]["button"] is None)
        os.environ.pop("ONEHR_LMS", None)
        s.check("...and with Learning off, none", items(EMP["id"])[0]["button"] is None)
    finally:
        if _lms0 is None:
            os.environ.pop("ONEHR_LMS", None)
        else:
            os.environ["ONEHR_LMS"] = _lms0
        with a.app.app_context():
            a.get_db().execute("DELETE FROM lms_programmes WHERE title LIKE 'Zz banner %'")
            a.get_db().commit()
        clear()
    v = check_form("Now on a later date starts that day at midnight", False, from_date=D(1), from_time="now")
    s.check("...", v and v["starts_at"] == D(1) + " 00:00")

    # ------------------------------------------------------------------ who sees one
    s.section("Who sees one: everyone, the roles whose part is open, picked roles, the sign-in page")
    add("For everyone", button="profile")
    xs = items(EMP["id"])
    s.check("everyone signed in: the employee, with Check my details", heads(xs) == ["For everyone"]
            and xs[0]["button"] == {"label": "Check my details", "url": "/profile"} and "hide" not in xs[0], xs)
    xa = items(SU["id"])
    s.check("...and an admin, without a Profile button", heads(xa) == ["For everyone"] and xa[0]["button"] is None)
    s.check("...but not the sign-in page unless ticked", heads(items(auth=True)) == [])
    clear()
    lid = add("With a link", places="signin,dashboard")
    with a.app.app_context():
        a.get_db().execute("UPDATE site_announcements SET link_label='See what''s new', link_target='page:profile' "
                           "WHERE id=?", (lid,))
        a.get_db().commit()
    xs = items(EMP["id"])
    s.check("a link button: their words, to that page", xs and xs[0]["button"] == {"label": "See what's new",
                                                                                 "url": "/profile"}, xs)
    s.check("...none on the sign-in page", items(auth=True)[0]["button"] is None)
    page = S.get("/admin/notices?panel=announce&aedit=%d" % lid).get_data(as_text=True)
    s.check("...Change opens it with A page in OneHR picked, its words and the page filled in",
            re.search(r'<option value="link" selected', page) and 'value="See what&#39;s new"' in page
            and 'name="link_target" value="page:profile"' in page and 'value="Profile: their details"' in page,
            re.findall(r'<option value="link"[^>]*>', page))
    s.check("...and the list shows its words and page", "See what&#39;s new<br><span class=\"muted\">Profile: their details" in page)
    s.check("...the picker's list is OneHR's own pages, handed to the page as data", re.search(
        r'<script type="application/json" id="ntc-link-targets">\[\{.*"key": "page:dashboard"', page)
        and 'name="link_url"' not in page)
    clear()
    add("Everyone and sign-in", on_signin=1, button="profile")
    xs = items(auth=True)
    s.check("ticked for the sign-in page: there, with no button", heads(xs) == ["Everyone and sign-in"]
            and xs[0]["button"] is None, xs)
    clear()
    add("Sign-in only", audience="signin")
    s.check("Sign-in page only: on the sign-in page", heads(items(auth=True)) == ["Sign-in only"])
    s.check("...and never on a signed-in page", heads(items(EMP["id"])) == [] and heads(items(SU["id"])) == [])
    clear()
    add("HODs only", audience="roles", roles=["hod"], on_signin=1)
    s.check("picked roles: the HOD sees it", heads(items(HODU["id"])) == ["HODs only"])
    s.check("...their people don't", heads(items(EMP["id"])) == [])
    s.check("...and a targeted one never reaches the sign-in page, even ticked", heads(items(auth=True)) == [])
    clear()
    add("Admins only", audience="roles", roles=["admin"])
    s.check("Admins: the super admin, not an employee", heads(items(SU["id"])) == ["Admins only"]
            and heads(items(EMP["id"])) == [])
    clear()
    add("Whose part is open", audience="open", end=NOW + timedelta(days=20))
    s.check("the roles whose part is open: the employee while their check-in is", heads(items(EMP["id"]))
            == ["Whose part is open"])
    s.check("...not an admin (no part)", heads(items(SU["id"])) == [])
    later = datetime.combine(TODAY + timedelta(days=13), NOW.time())
    at(later)
    s.check("...and on the HOD's day it follows the calendar: the HOD sees it, the employee no longer",
            heads(items(HODU["id"], now=later)) == ["Whose part is open"] and heads(items(EMP["id"], now=later)) == [])
    at(NOW)
    clear()
    add("Not yet", start=NOW + timedelta(hours=2))
    add("Over", start=NOW - timedelta(days=3), end=NOW - timedelta(minutes=1))
    s.check("before its start and after its end: not shown", heads(items(EMP["id"])) == [])
    clear()

    # ------------------------------------------------------------------ several at once; the notice alone
    s.section("Several at once, newest first; a notice before OneHR closes stands alone")
    add("Older", start=NOW - timedelta(hours=5))
    a2 = add("Newer", start=NOW - timedelta(hours=1))
    xs = items(EMP["id"])
    s.check("both, newest first", heads(xs) == ["Newer", "Older"], heads(xs))
    k1 = xs[0]["key"]
    with a.app.app_context():
        a.get_db().execute("UPDATE site_announcements SET version=version+1 WHERE id=?", (a2,))
        a.get_db().commit()
    s.check("a changed one gets a new key", items(EMP["id"])[0]["key"] != k1)
    dash = E.get("/dashboard").get_data(as_text=True)
    m = re.search(r"data-ann='([^']*)'", dash)
    bar = re.search(r'<div class="sn-bar sn-ann[^"]*" id="site-ann".*?\n  </div>', dash, re.S)
    bar = bar.group(0) if bar else ""
    s.check("the dashboard draws both in one line, newest first, a dot between, and hands the page both",
            bar.count('class="sn-item') == 2 and bar.count('class="sn-dot"') == 1
            and bar.index(">Newer<") < bar.index(">Older<") and m
            and [x["lead"] for x in json.loads(m.group(1).replace("&#34;", '"').replace("&quot;", '"'))] ==
            ["Newer", "Older"], bar[:300])
    s.check("...with no Got it and no arrows", "Got it" not in bar and "data-ann-prev" not in bar
            and "sn-pager" not in dash)
    j = E.get("/notice.json?place=dashboard").get_json()
    s.check("/notice.json says the same, for a page left open", [x["lead"] for x in j["ann"]] == ["Newer", "Older"]
            and j["notice"] is None)
    # a notice due now: it stands alone
    with a.app.app_context():
        db = a.get_db()
        soon = (a._now_myt() + timedelta(minutes=30)).strftime("%Y-%m-%d %H:%M")
        db.execute("INSERT INTO site_notices(kind, starts_at, downtime_min, closes, email_before, email_after, source) "
                   "VALUES ('upgrade', ?, 30, 1, 0, 0, 'admin')", (soon,))
        db.commit()
    j = E.get("/notice.json?place=dashboard").get_json()
    dash = E.get("/dashboard").get_data(as_text=True)
    s.check("with an upgrade's bar up, no announcement shows: the notice stands alone", j["notice"] and j["ann"] == []
            and 'id="site-notice"' in dash and 'id="site-ann"' not in dash)
    s.check("...nor on the sign-in page", a.app.test_client().get("/notice.json?auth=1").get_json()["ann"] == [])
    at(NOW)
    clear()

    # ------------------------------------------------------------------ the deadline reminder
    s.section("The deadline reminder: their own part, from the calendar, while something waits")
    close = TODAY + timedelta(days=2)
    calls = []

    def stub(db, u, team=None):
        calls.append(u["id"])
        if u["id"] == EMP["id"]:
            return [{"role": "own", "group": "own", "closes_on": close, "url": "/review/journey", "people": []}]
        if team:
            return team
        return []
    a.reminder_items = stub
    xs = items(EMP["id"])
    dl = [x for x in xs if x["kind"] == "deadline"]
    want_lead = "Your check-in closes %s %d %s, 23:59" % (close.strftime("%a"), close.day, close.strftime("%b"))
    # today counts (Chris 2026-11-01: "on 2nd Nov ... they have 7 days"): a close 2 days out reads "3 days left"
    s.check("2 days before: their check-in's closing date and what to do", dl and dl[0]["lead"] == want_lead
            and dl[0]["body"].startswith("3 days left. Save as you go; only Save & submit sends it")
            and not dl[0]["red"]
            and dl[0]["button"] == {"label": "Open my check-in", "url": "/review/journey"}, dl)
    n = len(calls)
    items(EMP["id"])
    s.check("kept a few minutes: the second page doesn't read it again", len(calls) == n)
    E.post("/notice.json")   # any POST of theirs (here a refused one) drops it
    items(EMP["id"])
    s.check("...and a POST of theirs drops it, so what they submitted comes off", len(calls) == n + 1)
    add("An announcement")
    xs = items(EMP["id"])
    s.check("with an announcement, the reminder comes after it", [x["kind"] for x in xs] == ["ann", "deadline"])
    last = datetime.combine(close, NOW.time())
    a._DL_CACHE.clear()
    xs = items(EMP["id"], now=last)
    s.check("on the last day: red and first", [x["kind"] for x in xs] == ["deadline", "ann"]
            and xs[0]["red"]
            and xs[0]["lead"] == "Last day: your check-in closes tonight at 23:59"
            and xs[0]["body"] == "Check your answers, then press Save & submit.", xs)
    clear()
    s.check("after it closes: none", not [x for x in items(EMP["id"], now=datetime.combine(close + timedelta(days=1),
                                                                                             NOW.time()))
                                          if x["kind"] == "deadline"])
    with a.app.app_context():
        a.get_db().execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('deadline_reminder', ?)",
                           (json.dumps({"on": True, "days": 1}),))
        a.get_db().commit()
    a._DL_CACHE.clear()
    s.check("set to 1 day before: not yet, 2 days out", not [x for x in items(EMP["id"]) if x["kind"] == "deadline"])
    r = post(S, action="save_deadline", on="", days="3")
    a._DL_CACHE.clear()
    s.check("switched off on the page: none, and audited", rules()["on"] is False
            and not [x for x in items(EMP["id"]) if x["kind"] == "deadline"]
            and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='deadline_reminder'") >= 1)
    post(S, action="save_deadline", on="1", days="3")
    a._DL_CACHE.clear()
    s.check("back on, from 3 days, on the dashboard", rules() == {"on": True, "days": 3, "places": ["dashboard"]}
            and [x for x in items(EMP["id"]) if x["kind"] == "deadline"])
    s.check("...and by default nowhere else: not the AI+ check-in, nor other pages",
            not [x for x in items(EMP["id"], place="checkin") if x["kind"] == "deadline"]
            and not [x for x in items(EMP["id"], place="other") if x["kind"] == "deadline"])
    r = post(S, action="save_deadline", on="1", days="3", places_sent="1", places=["checkin"])
    a._DL_CACHE.clear()
    s.check("set to the AI+ check-in only: there, and off the dashboard; audited with its pages",
            rules()["places"] == ["checkin"] and [x for x in items(EMP["id"], place="checkin") if x["kind"] == "deadline"]
            and not [x for x in items(EMP["id"]) if x["kind"] == "deadline"]
            and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='deadline_reminder' AND detail LIKE "
                         "'%on checkin (was%'") >= 1)
    r = post(S, action="save_deadline", on="1", days="3", places_sent="1", places=["signin", "admin"])
    s.check("...never the sign-in page or admin pages: none ticked is refused, nothing changes",
            rules()["places"] == ["checkin"])
    post(S, action="save_deadline", on="1", days="3", places_sent="1", places=["dashboard"])
    a._DL_CACHE.clear()
    s.check("never for an admin", not [x for x in items(SU["id"]) if x["kind"] == "deadline"])
    s.check("never on the sign-in page", not [x for x in items(auth=True) if x["kind"] == "deadline"])
    a.reminder_items = lambda db, u: []
    a._DL_CACHE.clear()
    s.check("nothing of theirs waiting: none", not [x for x in items(EMP["id"]) if x["kind"] == "deadline"])
    # a line manager: their people counted once each across the reviews closing that day
    a.reminder_items = lambda db, u: [
        {"role": "team", "closes_on": close, "url": "/review/journey?view=team", "people": [1, 2, 3]},
        {"role": "team", "closes_on": close, "url": "/review/journey?view=team&stage=x", "people": [3, 4]},
        {"role": "hod", "closes_on": close + timedelta(days=1), "url": "/review/journey?view=dept", "people": []}]
    a._DL_CACHE.clear()
    dl = [x for x in items(EMP["id"]) if x["kind"] == "deadline"]
    s.check("a line manager: the soonest part, the people still waiting counted once", dl
            and dl[0]["lead"].startswith("Your team's reviews close ") and "4 people still to review." in dl[0]["body"]
            and dl[0]["button"]["label"] == "Open my team", dl)
    w = {r: a.deadline_words(r, close, 3) for r in ("f360", "hod", "buceo", "bgceo")}
    s.check("each part says its own", w["f360"][0].startswith("Your 360 feedback closes") and "Lock each unit" in
            w["buceo"][1] and "Lock each business unit" in w["bgceo"][1] and "Save each person" in w["hod"][1], w)
    s.check("an Early Year's own part is the KPI setting", a.deadline_words("own", close, 2, early=True)[0]
            .startswith("Your KPI setting closes") and "only Submit sends" in a.deadline_words("own", close, 2,
                                                                                              early=True)[1])

    # ------------------------------------------------------------------ the whole time a part is open (Chris 2026-11-01)
    s.section("The deadline reminder: the whole time a part is open, and today counts in the days left")
    W = a.DEADLINE_WHOLE
    s.check("the whole-window setting is an int past any part's length, and is one of the choices",
            isinstance(W, int) and W >= 366 and W in a.DEADLINE_DAYS and a.DEADLINE_DAYS[-1] == W
            and all(isinstance(d, int) for d in a.DEADLINE_DAYS))
    with a.app.app_context():
        a.get_db().execute("DELETE FROM app_settings WHERE key='deadline_reminder'")
        a.get_db().commit()
    s.check("nothing saved: the default is the whole time a part is open, on the dashboard",
            rules() == {"on": True, "days": W, "places": ["dashboard"]}, rules())
    for junk in ("x", 4, 0, -3, None, [3], 3.5):
        with a.app.app_context():
            a.get_db().execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('deadline_reminder', ?)",
                               (json.dumps({"on": True, "days": junk}),))
            a.get_db().commit()
        s.check("a saved days of %r is not a choice: it falls back to the default" % (junk,), rules()["days"] == W,
                rules())
    with a.app.app_context():
        a.get_db().execute("DELETE FROM app_settings WHERE key='deadline_reminder'")
        a.get_db().commit()

    def own_bar(closes_in, today_plus):
        """The employee's bar when their check-in closes `closes_in` days after TODAY, on the day TODAY + today_plus."""
        a.reminder_items = lambda db, u: ([{"role": "own", "group": "own", "closes_on": TODAY + timedelta(days=closes_in),
                                            "url": "/review/journey", "people": []}] if u["id"] == EMP["id"] else [])
        a._DL_CACHE.clear()
        return [x for x in items(EMP["id"], now=datetime.combine(TODAY + timedelta(days=today_plus), NOW.time()))
                if x["kind"] == "deadline"]
    # the check-in is open from D(-1) to D(2): four days, so its first day reads "4 days left"
    first, mid, day_before, last = own_bar(2, -1), own_bar(2, 0), own_bar(2, 1), own_bar(2, 2)
    s.check("whole mode: the bar shows on the part's FIRST day, saying '4 days left' for a 4-day window",
            first and first[0]["body"].startswith("4 days left. Save as you go;") and not first[0]["red"], first)
    s.check("...'3 days left' the next day, and '2 days left' the day before the last",
            mid and mid[0]["body"].startswith("3 days left.") and day_before
            and day_before[0]["body"].startswith("2 days left.") and not day_before[0]["red"])
    s.check("...and on the last day the red 'Last day' bar, exactly as before",
            last and last[0]["red"] and last[0]["lead"] == "Last day: your check-in closes tonight at 23:59"
            and last[0]["body"] == "Check your answers, then press Save & submit.", last)
    s.check("...a 7-day part reads '7 days left' on its first day, a long one counts all the way",
            own_bar(6, 0)[0]["body"].startswith("7 days left.") and own_bar(30, 0)[0]["body"].startswith("31 days left."))
    a.reminder_items = lambda db, u: []
    a._DL_CACHE.clear()
    s.check("...nothing once it is submitted (nothing of theirs still waits)",
            not [x for x in items(EMP["id"], now=datetime.combine(TODAY - timedelta(days=1), NOW.time()))
                 if x["kind"] == "deadline"])
    s.check("...never before the part opens (the day before its first day: none, then its first day: shown)",
            not own_bar(2, -2) and own_bar(2, -1))
    a.reminder_items = lambda db, u: []
    a._DL_CACHE.clear()
    # the wording itself: today counts, the singular stays right, the last day is untouched
    s.check("deadline_words counts today: left 6 -> '7 days left', left 1 -> '2 days left', left 0 -> the red last day",
            a.deadline_words("own", close, 6)[1].startswith("7 days left.")
            and a.deadline_words("own", close, 1)[1].startswith("2 days left.")
            and a.deadline_words("f360", close, 1)[1].startswith("2 days left.")
            and a.deadline_words("own", close, 0)[0] == "Last day: your check-in closes tonight at 23:59"
            and not re.search(r"\bleft\b", a.deadline_words("own", close, 0)[1]))
    s.check("...the singular is only ever '1 day left.' for the helper's own 1 (nothing past today)",
            a._dl_left_words(0) == "1 day left." and a._dl_left_words(1) == "2 days left."
            and a._dl_left_words(6) == "7 days left.")
    # 3-day mode keeps its guard: nothing 4+ days before the close, the count is inclusive
    post(S, action="save_deadline", on="1", days="3", places_sent="1", places=["dashboard"])
    s.check("3-day mode saved as 3 (an int, not the whole window)", rules()["days"] == 3, rules())
    s.check("3-day mode: 3 days before the close it shows, '4 days left'", own_bar(3, 0)
            and own_bar(3, 0)[0]["body"].startswith("4 days left."))
    s.check("3-day mode: 4 days before the close it does NOT show (the guard)", not own_bar(4, 0)
            and not own_bar(30, 0) and not own_bar(5, 0))
    s.check("3-day mode: 2 days before: '3 days left'; the day before: '2 days left'",
            own_bar(2, 0)[0]["body"].startswith("3 days left.") and own_bar(2, 1)[0]["body"].startswith("2 days left."))
    post(S, action="save_deadline", on="1", days="7", places_sent="1", places=["dashboard"])
    s.check("7-day mode: 6 days before shows '7 days left', 7 days before '8 days left'; 8 days before does not",
            own_bar(6, 0) and own_bar(6, 0)[0]["body"].startswith("7 days left.") and own_bar(7, 0)
            and own_bar(7, 0)[0]["body"].startswith("8 days left.") and not own_bar(8, 0))
    # the save route: accepts the whole-window choice, refuses what is not a choice, audits both words
    a.reminder_items = lambda db, u: []
    r = post(S, action="save_deadline", on="1", days=str(W), places_sent="1", places=["dashboard"])
    s.check("the route accepts the whole-window choice", rules()["days"] == W and r.status_code in (302, 303), rules())
    s.check("...audited in words, as the new value", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='deadline_reminder' AND detail LIKE "
           "'on, the whole time a part is open, on dashboard (was on, from 7 days before, dashboard)'") >= 1)
    for bad in ("4", "0", "-1", "367", "junk", "", "3.0", "1e2"):
        post(S, action="save_deadline", on="1", days=bad, places_sent="1", places=["dashboard"])
        s.check("...a days of %r is refused: nothing changes" % bad, rules()["days"] == W, rules())
    post(S, action="save_deadline", on="1", days="3", places_sent="1", places=["dashboard"])
    s.check("...and 'was' reads in words too when the old value was the whole window", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='deadline_reminder' AND detail LIKE "
           "'on, from 3 days before, on dashboard (was on, the whole time a part is open, dashboard)'") >= 1
            and rules()["days"] == 3)
    page = S.get("/admin/notices").get_data(as_text=True)
    s.check("with 3 days saved, the card's heading and options read as before",
            "What each role sees, 3 days before and on the last day" in page
            and "3 days before their part closes</option>" in page and "from the day their part opens" not in page)
    post(S, action="save_deadline", on="1", days=str(W), places_sent="1", places=["dashboard"])
    page = S.get("/admin/notices").get_data(as_text=True)
    dlf = re.search(r'<form[^>]*id="ntc-dl".*?</form>', page, re.S)
    dlf = dlf.group(0) if dlf else ""
    s.check("whole mode: the option reads 'the whole time their part is open', selected, and the heading says from the "
            "day it opens", re.search(r'<option value="%d" selected>the whole time their part is open</option>' % W, dlf)
            and "What each role sees from the day their part opens, and on the last day" in dlf
            and "366 days" not in dlf and "7 days before their part closes</option>" in dlf, dlf[:300])
    # the preview: the first bar is what a person reads on the first day it shows
    with a.app.app_context():
        db = a.get_db()
        saved_cal = [tuple(x) for x in db.execute("SELECT cell, opens_at, closes_at FROM cycle_windows WHERE cycle_id=? "
                                                 "AND cell IN ('pm_results','tc_self','idp_self','pm_hod','pot_hod')",
                                                 (CID,))]
        db.execute("UPDATE cycle_windows SET opens_at=?, closes_at=? WHERE cycle_id=? AND cell IN ('pm_results',"
                   "'tc_self','idp_self')", (D(0) + " 00:00", D(6) + " 23:59", CID))
        db.execute("UPDATE cycle_windows SET opens_at=?, closes_at=? WHERE cycle_id=? AND cell IN ('pm_hod','pot_hod')",
                   (D(12) + " 00:00", D(14) + " 23:59", CID))
        db.commit()
        pv = lambda days: {p["who"]: p for p in a.deadline_preview(db, {"on": True, "days": days,   # noqa: E731
                                                                          "places": ["dashboard"]})}
        pw, p7, p3 = pv(W), pv(7), pv(3)
        # put the calendar back
        for cell, o, c in saved_cal:
            db.execute("UPDATE cycle_windows SET opens_at=?, closes_at=? WHERE cycle_id=? AND cell=?", (o, c, CID, cell))
        db.commit()
    s.check("preview, whole mode: a 7-day window (the 2-8 Nov employees) reads '7 days left' on its first bar",
            pw["Employees"]["body"].startswith("7 days left.") and pw["Employees"]["lead"].startswith("Your check-in closes ")
            , pw.get("Employees"))
    s.check("...a window shorter than the setting reads its own length: 3 days for a 3-day window, even set to 7",
            pw["HODs"]["body"].startswith("3 days left.") and p7["HODs"]["body"].startswith("3 days left.")
            and p7["Employees"]["body"].startswith("7 days left."), (pw.get("HODs"), p7.get("HODs")))
    s.check("...set to 3 days, the first bar of a 7-day window reads '4 days left' (3 days before the close, today counted)",
            p3["Employees"]["body"].startswith("4 days left.") and p3["HODs"]["body"].startswith("3 days left."),
            (p3.get("Employees"), p3.get("HODs")))
    s.check("...the last-day bar is unchanged in every mode", all(
        x["Employees"]["last_lead"] == "Last day: your check-in closes tonight at 23:59"
        and x["Employees"]["last_body"] == "Check your answers, then press Save & submit." for x in (pw, p7, p3)))
    with a.app.app_context():
        a.get_db().execute("DELETE FROM app_settings WHERE key='deadline_reminder'")
        a.get_db().commit()
    a._DL_CACHE.clear()
    a.reminder_items = _real_items
    a._DL_CACHE.clear()
    try:
        with a.app.test_request_context("/"):
            r0 = a.deadline_item(a.get_db(), EMP, NOW)
        ok = r0 is None or (isinstance(r0, dict) and r0["kind"] == "deadline")
    except Exception as ex:   # noqa: BLE001
        ok, r0 = False, repr(ex)
    s.check("on the real readers it runs", ok, r0)

    # ------------------------------------------------------------------ timing that follows the calendar
    s.section("When it shows follows the calendar: until the cycle opens, while a part is open")
    a.reminder_items = lambda db, u: []
    clear()
    with a.app.app_context():
        db = a.get_db()
        # the cycle hasn't opened yet: every part a few days ahead (the check-in opens on day 4)
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for cell, (o, c) in {"pm_results": (D(4), D(10)), "tc_self": (D(4), D(10)), "f360": (D(4), D(10)),
                             "idp_self": (D(4), D(10)), "pm_approve": (D(11), D(17)), "pm_hod": (D(14), D(20)),
                             "pot_hod": (D(14), D(20))}.items():
            db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                       (CID, cell, o + " 00:00", c + " 23:59"))
        db.commit()
    tform = dict(action="ann_post", headline="Our AI+ OneHR goes live on {opens}",
                 message="Check your details now, before {opens}.", audience="everyone", places_sent="1",
                 places=["signin", "dashboard"], button="help",
                 timing="until_open", from_date=D(0), from_time="now", until_date=D(1), until_time="23:59")
    r = post(S, **tform)
    with a.app.app_context():
        row = a.get_db().execute("SELECT * FROM site_announcements ORDER BY id DESC LIMIT 1").fetchone()
    s.check("until the cycle opens: stored with its timing and the cycle it follows", row and row["timing"] ==
            "until_open" and row["cycle_id"] == CID and row["ends_at"] == D(3) + " 23:59", dict(row) if row else r.status_code)
    d4 = TODAY + timedelta(days=4)
    xs = items(EMP["id"])
    s.check("...{opens} filled from the calendar", heads(xs) == ["Our AI+ OneHR goes live on %s %d %s" % (
        d4.strftime("%a"), d4.day, d4.strftime("%b"))], heads(xs))
    s.check("...shown up to 23:59 the day before it opens", heads(items(EMP["id"], now=datetime.combine(
        TODAY + timedelta(days=3), datetime.min.time()).replace(hour=23, minute=59))) != [])
    s.check("...and gone at the opening", heads(items(EMP["id"], now=datetime.combine(d4, datetime.min.time()))) == [])
    # an early release: the check-in moves two days earlier on the calendar
    with a.app.app_context():
        db = a.get_db()
        for cell in ("pm_results", "tc_self", "f360", "idp_self"):
            db.execute("UPDATE cycle_windows SET opens_at=? WHERE cycle_id=? AND cell=?", (D(2) + " 00:00", CID, cell))
        db.commit()
    day1_late = datetime.combine(TODAY + timedelta(days=1), datetime.min.time()).replace(hour=23, minute=59)
    s.check("an early release (the calendar moved to day 2): it stops at 23:59 on day 1 by itself",
            heads(items(EMP["id"], now=day1_late)) != [] and
            heads(items(EMP["id"], now=day1_late + timedelta(minutes=1))) == [])
    s.check("...and the sign-in page follows the same calendar", heads(items(auth=True, now=day1_late)) != []
            and heads(items(auth=True, now=day1_late + timedelta(minutes=1))) == [])
    page = S.get("/admin/notices").get_data(as_text=True)
    s.check("Banner lists it as Until the cycle opens", "Until the cycle opens" in page)
    clear()
    pform = dict(tform, timing="part", part="own", headline="The 2026 Year-End is open",
                 message="Employees: key in your KPI results and self-assessment, {dates}.", places=["signin"])
    post(S, **pform)
    with a.app.app_context():
        row = a.get_db().execute("SELECT * FROM site_announcements ORDER BY id DESC LIMIT 1").fetchone()
    s.check("while a part is open: stored with its part", row and row["timing"] == "part" and row["part"] == "own"
            and row["audience"] == "everyone" and row["places"] == "signin" and row["button"] == "none")
    d2 = datetime.combine(TODAY + timedelta(days=2), datetime.min.time())
    s.check("...not before its first day", heads(items(auth=True, now=d2 - timedelta(minutes=1))) == [])
    xs = items(auth=True, now=d2)
    want = "Employees: key in your KPI results and self-assessment, %s." % a._rw_span(TODAY + timedelta(days=2),
                                                                                     TODAY + timedelta(days=10))
    s.check("...from 00:00 on its first day, {dates} filled", xs and xs[0]["body"] == want, xs and xs[0]["body"])
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycle_windows SET closes_at=? WHERE cycle_id=? AND cell IN ('pm_results','tc_self','f360',"
                   "'idp_self')", (D(7) + " 23:59", CID))
        db.commit()
    d7_late = datetime.combine(TODAY + timedelta(days=7), datetime.min.time()).replace(hour=23, minute=59)
    s.check("...the part closing earlier on the calendar: it ends then too, its dates said again",
            heads(items(auth=True, now=d7_late)) != [] and heads(items(auth=True, now=d7_late + timedelta(minutes=1)))
            == [] and a._rw_span(TODAY + timedelta(days=2), TODAY + timedelta(days=7)) in items(auth=True, now=d7_late)[0]["body"])
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN ('pm_results','tc_self','f360','idp_self')",
                   (CID,))
        db.commit()
    s.check("...and a part taken off the calendar: not shown", heads(items(auth=True, now=d2)) == [])
    r = post(S, **dict(pform, part="own"))
    s.check("posting to a part with no dates is refused", H.one(a, "SELECT COUNT(*) FROM site_announcements") == 1)
    clear()
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for cell, (o, c) in CAL.items():
            db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                       (CID, cell, o + " 00:00", c + " 23:59"))
        db.commit()
    r = post(S, **tform)
    s.check("until the cycle opens, once it has: refused", H.one(a, "SELECT COUNT(*) FROM site_announcements") == 0)

    # ------------------------------------------------------------------ Banner's two tabs
    s.section("Banner: the menu's name, two tabs, each opening where it should")
    s.check("the menu calls it Banner", [x["label"] for x in a.ADMIN_SECTIONS if x["key"] == "notices"] == ["Banner"])
    page = S.get("/admin/notices").get_data(as_text=True)
    s.check("the page is Banner with the Announcements and Notices tabs", "<h1>Banner</h1>" in page
            and 'data-ntc-tabbtn="announcements"' in page and 'data-ntc-tabbtn="notices"' in page
            and 'data-banner-tab="announcements"' in page and 'data-banner-tab="notices"' in page)
    s.check("with nothing live it opens on Announcements", re.search(
        r'data-banner-tab="notices" hidden', page) and not re.search(r'data-banner-tab="announcements" hidden', page))
    page = S.get("/admin/notices?tab=notices").get_data(as_text=True)
    s.check("?tab=notices opens on Notices", re.search(r'data-banner-tab="announcements" hidden', page)
            and not re.search(r'data-banner-tab="notices" hidden', page))
    r = post(S, action="save_deadline", on="1", days="3")
    s.check("a save on Announcements comes back to it", "tab=announcements" in (r.headers.get("Location") or ""))
    r = post(S, action="cancel", nid="0")
    s.check("a notice action comes back to Notices", "tab=notices" in (r.headers.get("Location") or ""))

    # ------------------------------------------------------------------ where it shows
    s.section("Where it shows: the pages ticked, the AI+ check-in never by default; no Got it")
    a.reminder_items = lambda db, u: []
    clear()
    with a.app.test_request_context("/"):
        got = {p: a.bar_place(endpoint=e, path=p) for p, e in (("/dashboard", "dashboard"), ("/review/journey",
               "review_journey"), ("/review", "review_home"), ("/admin/notices", "admin_notices"),
               ("/profile", "my_settings"), ("/reviewer", "x"))}
    s.check("each page knows which it is: dashboard, AI+ check-in (/review), admin, every other",
            got == {"/dashboard": "dashboard", "/review/journey": "checkin", "/review": "checkin",
                    "/admin/notices": "admin", "/profile": "other", "/reviewer": "other"}, got)
    add("Dashboard only", places="dashboard")
    s.check("ticked for the dashboard: there", heads(items(EMP["id"])) == ["Dashboard only"])
    s.check("...and nowhere else: not the AI+ check-in, admin pages, other pages or the sign-in page",
            not heads(items(EMP["id"], place="checkin")) and not heads(items(SU["id"], place="admin"))
            and not heads(items(EMP["id"], place="other")) and not heads(items(auth=True)))
    clear()
    add("Check-in too", places="dashboard,checkin")
    s.check("ticked for the AI+ check-in: there too", heads(items(EMP["id"], place="checkin")) == ["Check-in too"]
            and heads(items(EMP["id"])) == ["Check-in too"])
    clear()
    add("For admins at work", audience="roles", roles=["admin"], places="admin")
    s.check("admin pages: an admin there, not on the dashboard", heads(items(SU["id"], place="admin"))
            == ["For admins at work"] and not heads(items(SU["id"])))
    clear()
    add("Old, for everyone")
    add("Old, with sign-in", on_signin=1)
    add("Old, sign-in only", audience="signin")
    s.check("one posted before pages: the dashboard, never the AI+ check-in",
            heads(items(EMP["id"])) == ["Old, with sign-in", "Old, for everyone"]
            and not heads(items(EMP["id"], place="checkin")) and not heads(items(EMP["id"], place="other")),
            heads(items(EMP["id"])))
    s.check("...and the sign-in page where it was for it", heads(items(auth=True)) == ["Old, sign-in only",
                                                                                    "Old, with sign-in"])
    clear()
    add("Targeted, marked for sign-in", audience="roles", roles=["hod"], places="signin,dashboard")
    s.check("a targeted one marked for the sign-in page still never reaches it", not heads(items(auth=True))
            and heads(items(HODU["id"])) == ["Targeted, marked for sign-in"])
    clear()
    add("On the dashboard", places="dashboard")
    j = E.get("/notice.json?place=checkin").get_json()
    s.check("/notice.json answers for the page it's asked from", j["ann"] == []
            and [x["lead"] for x in E.get("/notice.json?place=dashboard").get_json()["ann"]] == ["On the dashboard"]
            and E.get("/notice.json?place=anything").get_json()["ann"] == [])
    dash = E.get("/dashboard").get_data(as_text=True)
    s.check("the dashboard says it's the dashboard, so the bar's checks ask for its own", 'data-place="dashboard"' in dash
            and 'id="site-ann"' in dash)
    s.check("Got it is gone: its route, its button", "site_notice_dismiss" not in a.MODULE_UNGATED_ENDPOINTS
            and E.post("/notice/dismiss", data={"csrf_token": "tok", "key": "a1.1"}).status_code in (404, 405)
            and "Got it" not in dash)
    page = S.get("/admin/notices?panel=announce").get_data(as_text=True)
    box = lambda k: re.search(r'<input type="checkbox" name="places" value="%s"([^>]*)>' % k, page)   # noqa: E731
    s.check("Post an announcement asks where: the dashboard ticked, the AI+ check-in not",
            box("dashboard") and "checked" in box("dashboard").group(1) and box("checkin")
            and "checked" not in box("checkin").group(1) and box("signin") and box("admin") and box("other")
            and 'name="places_sent"' in page and 'name="on_signin"' not in page)
    dlf = re.search(r'<form[^>]*id="ntc-dl".*?</form>', page, re.S)
    dlf = dlf.group(0) if dlf else ""
    s.check("...and the deadline reminder's card has its own pages, no sign-in or admin page",
            re.search(r'name="places" value="dashboard" checked.*?value="checkin".*?value="other"', dlf, re.S)
            and 'value="admin"' not in dlf and 'value="signin"' not in dlf, dlf[-600:])
    clear()

    # ------------------------------------------------------------------ the page script, the layout, the KB
    s.section("The page script writes words as text; the layout follows the bar; the KB row")
    js = open(os.path.join(ROOT, "static", "notice.js")).read()
    inner = [ln.strip() for ln in js.splitlines() if "innerHTML" in ln]
    s.check("the bar's words go in as text: markup only for the fixed icons", inner and all(
        ("ICON" in ln or "paths" in ln) for ln in inner), inner)
    s.check("a button opens only OneHR's own pages", "/^\\/(?!\\/)/.test(btn.url" in js)
    s.check("one line with every item and the notice hand-over; no Got it or arrows; it asks for its own page",
            "data-ann-hide" not in js and "data-ann-prev" not in js and "dismiss(" not in js and "sn-dot" in js
            and "paintAnn();" in js and "anns = j.ann || []" in js and '"?place=" + encodeURIComponent(place)' in js)
    s.check("...the loop's copy keeps its buttons out of the tab order",
            'copy.querySelectorAll("a, button").forEach(function (x) { x.setAttribute("tabindex", "-1"); });' in js)
    css = open(os.path.join(ROOT, "static", "style.css")).read()
    s.check("the announcement bar pushes the pinned panels down like a notice",
            "html:has(#site-ann:not([hidden]):not(.is-auth))" in css)
    s.check("one line: the words don't wrap, and run across when they don't fit (a hidden copy for the loop)",
            ".sn-bar .sn-text { flex: 1; min-width: 0; display: flex; overflow: hidden; white-space: nowrap; }" in css
            and "@keyframes sn-run" in css and "function fitRun(t)" in js and 'copy.setAttribute("aria-hidden", "true")' in js)
    s.check("...still, with an ellipsis, for anyone who asks for less motion; paused on hover or focus",
            re.search(r"prefers-reduced-motion: reduce\)\s*\{\s*\.sn-bar \.sn-text\.is-running \.sn-run \{ animation: none; \}", css)
            and "animation-play-state: paused" in css)
    s.check("the sign-in page's bar is pinned at the top and adds no height (the brand panel's top room holds it)",
            ".sn-bar.is-auth { position: fixed; top: 0;" in css and "main.auth-shell .ax-brand { padding-top: 56px;" in css)
    s.check("its buttons are the small ones", ".sn-act { flex: none; display: inline-flex; align-items: center; min-height: 32px;"
            in css and "min-height: 32px; padding: 0 10px; border-radius: 8px; cursor: pointer; white-space: nowrap; }" in css)
    with a.app.app_context():
        kb = a.get_db().execute("SELECT body FROM kb_entries WHERE slug='announcements-and-deadlines'").fetchone()
    s.check("the KB row is there and conceptual (no numbers), with no Got it or arrows", kb
            and not re.search(r"\d", kb["body"]) and "Got it" not in kb["body"] and "arrows" not in kb["body"])
finally:
    real()
    a.reminder_items = _real_items
    a._DL_CACHE.clear()

sys.exit(s.done())
