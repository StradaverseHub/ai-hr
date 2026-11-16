"""Admin > Reports & audit > Usage: the "Online now" tile (Chris, 2026-11-02): the people who used OneHR in the last 15
minutes and have not signed out since.

Sign-ins are cookie-only, so each person carries users.last_seen_at (UTC):
  * a signed-in request stamps it, at most once every ONLINE_STAMP_EVERY seconds (the cookie's `ls` mark is the throttle),
    never for a page's own background ask (/notice.json) or a static file, and a locked database never fails the request
  * signing in stamps it; signing out sets it NULL so they leave the count at once
  * the tile counts last_seen_at inside ONLINE_WINDOW_MIN for the same people as the page's other tiles (no admin, demo
    account or leaver) and inside the viewer's business-group scope
  * the super admin's tile opens its people (ADMIN_LISTS "online-now", the same people as the number); no one else's does

Synthetic (ZZOL-*) people on the shared suite database; everything is put back at the end. Usage is the super admin's
alone (Audit and usage), so the business-group scope is held on the page by swapping bg_scope for a scoped one and on the
list by a real BG admin row.
"""
import os
import re
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from werkzeug.security import generate_password_hash  # noqa: E402

a = H.setup()
s = H.Suite("Online now: a last-seen stamp, a tile, and the list behind it")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG1, BG2 = "ZZOL Group One", "ZZOL Group Two"
PW = "Right-pass-1"


def cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZOL-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM login_attempts WHERE username LIKE 'ZZOL-%'")
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    cleanup(db)
    ENDED0 = db.execute("SELECT COALESCE(MAX(rowid),0) FROM ended_sessions").fetchone()[0]
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]
    pwh = generate_password_hash(PW, method="pbkdf2:sha256:1000")

    def mk(eid, bg=BG1, role="user", demo=0, left=None, admin_bg=None):
        v = dict(base, username=eid, employee_id=eid, full_name=eid, email=None, manager_id=None, hod_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=bg, company=bg + " Unit",
                 department="ZZOL Dept", job_grade="14", left_at=left, is_demo=demo, role=role, admin_bg=admin_bg,
                 password_hash=pwh, last_seen_at=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    P1, P2 = mk("ZZOL-P1"), mk("ZZOL-P2")                       # business group one
    Q1 = mk("ZZOL-Q1", bg=BG2)                                  # business group two
    ADM = mk("ZZOL-ADM", role="admin")                          # an admin
    DEMO = mk("ZZOL-DEMO", demo=1)                              # a demo account
    GONE = mk("ZZOL-GONE", left="2026-01-31 00:00:00")          # a leaver
    BGA1 = mk("ZZOL-BGA", role="admin", admin_bg=BG1)           # BG one's admin
    db.commit()

su = H.client_as(a, SU["id"])


def seen(uid):
    return H.one(a, "SELECT last_seen_at FROM users WHERE id=?", (uid,))


def set_seen(uid, sql):
    """last_seen_at = a SQLite datetime expression (or NULL)."""
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE users SET last_seen_at=%s WHERE id=?" % sql, (uid,))
        d.commit()


def ago(uid, minutes):
    set_seen(uid, "datetime('now','-%d minutes')" % minutes)


def mark(c):
    with c.session_transaction() as ss:
        return ss.get("ls")


def put_mark(c, v):
    with c.session_transaction() as ss:
        ss["ls"] = v


def tile():
    """The tile's number on Usage, as the super admin sees it."""
    html = su.get("/admin/activity").get_data(as_text=True)
    m = re.search(r'Online now</span><b>([\d,]+)</b>\s*<span class="muted small">([^<]*)</span>', html)
    return (int(m.group(1).replace(",", "")), m.group(2), html) if m else (None, None, html)


def listed():
    """(its title's number, the Employee IDs in it) from the list panel's fragment."""
    r = su.get("/admin/list/online-now?fragment=1")
    b = r.get_data(as_text=True)
    n = re.search(r'data-list-title="Online now · ([\d,]+)"', b)
    return (int(n.group(1).replace(",", "")) if n else None), set(re.findall(r'clp-eid">\s*(ZZOL-[A-Z0-9]+)', b)), r


try:
    s.section("a signed-in request stamps it, at most once every five minutes")
    s.check("the numbers: 5 minutes between stamps, a 15 minute window", a.ONLINE_STAMP_EVERY == 300
            and a.ONLINE_WINDOW_MIN == 15)
    s.check("the column exists and starts empty for our people", seen(P1) is None and seen(P2) is None)
    c = H.client_as(a, P1)
    s.check("a person who has not used OneHR has no mark on their cookie", mark(c) is None)
    r = c.get("/account/password")
    s.check("their first request stamps last_seen_at (UTC, now)", r.status_code == 200 and seen(P1) is not None
            and H.one(a, "SELECT (strftime('%s','now') - strftime('%s', last_seen_at)) < 60 FROM users WHERE id=?",
                      (P1,)) == 1, (r.status_code, seen(P1)))
    s.check("...and the cookie carries the time of it", isinstance(mark(c), int) and abs(mark(c) - time.time()) < 60,
            mark(c))
    set_seen(P1, "'2000-01-01 00:00:00'")
    c.get("/account/password")
    s.check("a second request inside the five minutes does not write again", seen(P1) == "2000-01-01 00:00:00", seen(P1))
    put_mark(c, int(time.time()) - 299)
    c.get("/account/password")
    s.check("...nor one at 299 seconds", seen(P1) == "2000-01-01 00:00:00", seen(P1))
    put_mark(c, int(time.time()) - 301)
    c.get("/account/password")
    s.check("...but one past 300 seconds stamps again", seen(P1) != "2000-01-01 00:00:00" and seen(P1) >= "2026", seen(P1))
    s.check("...and moves the cookie's mark on", abs(mark(c) - time.time()) < 60, mark(c))

    s.section("a page's own background ask, a static file and a stranger do not count as use")
    set_seen(P2, "'2000-01-01 00:00:00'")
    c2 = H.client_as(a, P2)
    c2.get("/notice.json?auth=1")
    c2.get("/static/style.css")
    s.check("/notice.json (static/notice.js polls it from a tab left open) and a static file stamp nothing",
            seen(P2) == "2000-01-01 00:00:00" and mark(c2) is None, (seen(P2), mark(c2)))
    anon = a.app.test_client()
    anon.get("/login")
    s.check("a request with no one signed in writes no one's stamp (no cookie mark either)",
            H.one(a, "SELECT COUNT(*) FROM users WHERE id=? AND last_seen_at IS NOT NULL", (Q1,)) == 0)
    c2.get("/account/password")
    s.check("their next page does", seen(P2) != "2000-01-01 00:00:00")

    s.section("only real activity counts: not a timed background fetch")
    set_seen(P2, "'2000-01-01 00:00:00'")
    cb = H.client_as(a, P2)
    cb.get("/account/password", headers={"Sec-Fetch-Mode": "cors"})
    s.check("a GET the browser sent as a background fetch (Sec-Fetch-Mode: cors) stamps nothing and sets no mark",
            seen(P2) == "2000-01-01 00:00:00" and mark(cb) is None, (seen(P2), mark(cb)))
    cb.get("/account/password", headers={"Sec-Fetch-Mode": "same-origin"})
    s.check("...nor does any other mode but navigate (same-origin)", seen(P2) == "2000-01-01 00:00:00")
    cb.get("/account/password", headers={"Sec-Fetch-Mode": "navigate"})
    s.check("...the same GET as a navigation stamps", seen(P2) != "2000-01-01 00:00:00" and mark(cb) is not None, seen(P2))
    set_seen(P2, "'2000-01-01 00:00:00'")
    cn = H.client_as(a, P2)
    cn.get("/account/password")
    s.check("...and with no Sec-Fetch-Mode header at all (an older browser, a test client) it stamps",
            seen(P2) != "2000-01-01 00:00:00" and mark(cn) is not None, seen(P2))
    set_seen(P2, "'2000-01-01 00:00:00'")
    cp = H.client_as(a, P2)
    with cp.session_transaction() as ss:
        tok2 = ss["csrf_token"]
    r = cp.post("/account/password", data={"csrf_token": tok2, "current": "x", "new": "y", "confirm": "z"},
                headers={"Sec-Fetch-Mode": "cors"})
    s.check("a POST sent with Sec-Fetch-Mode: cors (a fetch that writes) is real activity: it stamps",
            r.status_code in (200, 302) and seen(P2) != "2000-01-01 00:00:00" and mark(cp) is not None,
            (r.status_code, seen(P2)))

    s.section("one rule for activity: the idle sign-out's _request_is_activity()")
    src = open(os.path.join(H.REPO, "app.py")).read()
    body_ = src[src.index("def _stamp_last_seen("):].split("\n\n\n", 1)[0]
    s.check("_stamp_last_seen asks _request_is_activity() and holds no Sec-Fetch rule of its own",
            "_request_is_activity()" in body_ and "Sec-Fetch" not in body_, body_[:80])
    s.check("...exactly once defined (a later def would silently win)", src.count("def _request_is_activity(") == 1
            and src.count("def _stamp_last_seen(") == 1 and src.count("def _online_clear(") == 1
            and src.count("def _online_now_sql(") == 1 and src.count("def _list_online_now(") == 1)
    set_seen(P2, "'2000-01-01 00:00:00'")
    ca = H.client_as(a, P2)
    ca.get("/session/alive?peek=1")
    s.check("the idle box's read-only peek (/session/alive?peek=1) is not activity: it stamps nothing",
            seen(P2) == "2000-01-01 00:00:00" and mark(ca) is None, (seen(P2), mark(ca)))
    ca.get("/session/alive", headers={"Sec-Fetch-Mode": "cors"})
    s.check("...the page's own ping (/session/alive, a script fetch) is activity, as for the idle limit: it stamps",
            seen(P2) != "2000-01-01 00:00:00" and mark(ca) is not None, (seen(P2), mark(ca)))
    for meth, hdr, want in (("get", {"Sec-Fetch-Mode": "cors"}, False), ("get", {"Sec-Fetch-Mode": "navigate"}, True),
                            ("get", {}, True), ("head", {"Sec-Fetch-Mode": "no-cors"}, False)):
        set_seen(P2, "'2000-01-01 00:00:00'")
        cx = H.client_as(a, P2)
        with a.app.test_request_context("/account/password", method=meth.upper(), headers=hdr):
            rule = a._request_is_activity()
        getattr(cx, meth)("/account/password", headers=hdr)
        stamped = seen(P2) != "2000-01-01 00:00:00"
        s.check("%s %s: _request_is_activity() says %s and the stamp %s" % (meth, hdr or "(no header)", rule,
                "happened" if stamped else "did not"), rule == want and stamped == rule, (rule, stamped))

    s.section("a locked database never fails the page")
    set_seen(P2, "'2000-01-01 00:00:00'")
    cl = H.client_as(a, P2)
    holder = sqlite3.connect(a.DB_PATH, timeout=0.1)
    try:
        holder.execute("BEGIN IMMEDIATE")   # a writer holds the database
        t0 = time.time()
        r = cl.get("/account/password")
        took = time.time() - t0
    finally:
        holder.rollback()
        holder.close()
    s.check("the page still loads (200) while the stamp can't be written", r.status_code == 200, r.status_code)
    s.check("...it waited well under the usual 5 seconds for the stamp (quarter of a second, not the 5)", took < 3, took)
    s.check("...nothing was stamped and the cookie's mark stays unset, so the next request tries again",
            seen(P2) == "2000-01-01 00:00:00" and mark(cl) is None, (seen(P2), mark(cl)))
    cl.get("/account/password")
    s.check("...which it does", seen(P2) != "2000-01-01 00:00:00" and mark(cl) is not None)
    set_seen(P2, "'2000-01-01 00:00:00'")
    holder = sqlite3.connect(a.DB_PATH, timeout=0.1)
    try:
        holder.execute("BEGIN IMMEDIATE")
        with a.app.test_request_context("/account/password"):
            a.session["user_id"] = P2
            a._stamp_last_seen()
            bt = a.get_db().execute("PRAGMA busy_timeout").fetchone()[0]
            ls_after = a.session.get("ls")
    finally:
        holder.rollback()
        holder.close()
    s.check("...and the connection's wait is put back to 5 seconds for the rest of the request, a skipped stamp or not",
            bt == 5000 and ls_after is None and seen(P2) == "2000-01-01 00:00:00", (bt, ls_after))

    s.section("signing in stamps it; signing out clears it at once")
    set_seen(P1, "NULL")
    cs = a.app.test_client()
    with cs.session_transaction() as ss:
        ss["csrf_token"] = "tok"
    r = cs.post("/login", data={"username": "ZZOL-P1", "password": PW, "csrf_token": "tok"})
    s.check("a good sign-in works", r.status_code == 302 and "login" not in r.headers.get("Location", ""),
            (r.status_code, r.headers.get("Location")))
    s.check("...and stamps last_seen_at, with the cookie's mark", seen(P1) is not None and isinstance(mark(cs), int),
            (seen(P1), mark(cs)))
    set_seen(P2, "NULL")
    a.app.test_client().post("/login", data={"username": "ZZOL-P2", "password": "wrong-Pass-9", "csrf_token": "tok"})
    s.check("a wrong password stamps nothing", seen(P2) is None)
    n_in = tile()[0]
    s.check("they are counted while signed in", n_in is not None and listed()[1] >= {"ZZOL-P1"}, n_in)
    cs.get("/account/password")   # the sign-in starts a fresh session: its first page gives it a form token
    with cs.session_transaction() as ss:
        tok = ss["csrf_token"]
    r = cs.post("/logout", data={"csrf_token": tok})
    s.check("Sign out sets last_seen_at NULL", r.status_code == 302 and seen(P1) is None, (r.status_code, seen(P1)))
    s.check("...and the count drops by one at once", tile()[0] == n_in - 1, (n_in, tile()[0]))
    # another session of the same person carries on: a password change leaves the stamp alone
    set_seen(P1, "datetime('now')")
    cs3 = H.client_as(a, P1)
    cs3.get("/account/password")
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash("Second-pass-2", method="pbkdf2:sha256:1000"), P2))
        d.commit()
    s.check("a stamp is left alone by anything but Sign out (another browser may still be in)", seen(P1) is not None)

    s.section("the tile: the same people as the other tiles, inside 15 minutes")
    for u in (P1, P2, Q1, ADM, DEMO, GONE, BGA1):
        set_seen(u, "NULL")
    n0, line, html = tile()
    s.check("the tile is there, with its label and its line", n0 is not None and line == "in the last 15 min", (n0, line))
    s.check("it is the fifth tile, after Logins today, in the five-column row",
            html.index("Logins today") < html.index("Online now") and 'class="adm-tiles adm-tiles-5"' in html)
    ago(P1, 0)
    s.check("a participant seen now: one more", tile()[0] == n0 + 1, (n0, tile()[0]))
    ago(P1, 14)
    s.check("...still there at 14 minutes", tile()[0] == n0 + 1)
    ago(P1, 16)
    s.check("...not at 16 minutes", tile()[0] == n0, (n0, tile()[0]))
    set_seen(P1, "NULL")
    s.check("...nor with no stamp (signed out)", tile()[0] == n0)
    for u in (ADM, DEMO, GONE):
        ago(u, 0)
    s.check("an admin, a demo account and a leaver, all seen now, add nothing", tile()[0] == n0, (n0, tile()[0]))
    ago(P1, 1)
    ago(P2, 2)
    ago(Q1, 3)
    n3, _l, html = tile()
    s.check("three participants of two groups: three more", n3 == n0 + 3, (n0, n3))
    s.check("the number reads with its thousands comma, like the others", re.search(r"Online now</span><b>[\d,]+</b>", html))

    s.section("the list: the same people as the number, the super admin's")
    nl, ids, r = listed()
    s.check("it opens for the super admin", r.status_code == 200 and nl is not None, r.status_code)
    s.check("its title's number is the tile's", nl == n3, (nl, n3))
    s.check("...with our three in it and no admin, demo account or leaver",
            {"ZZOL-P1", "ZZOL-P2", "ZZOL-Q1"} <= ids and not ids & {"ZZOL-ADM", "ZZOL-DEMO", "ZZOL-GONE"}, ids)
    body = r.get_data(as_text=True)
    s.check("...each with their business unit and when they were last seen, in Malaysia time (HH:MM)",
            "ZZOL Group One Unit" in body and re.search(r"<td class=\"small\">\d\d:\d\d</td>", body)
            and "Malaysia time" in body)
    hm = H.one(a, "SELECT strftime('%H:%M', last_seen_at, '+8 hours') FROM users WHERE id=?", (P1,))
    s.check("...the time is the stamp plus eight hours", ">%s<" % hm in body, hm)
    s.check("the tile carries the list for the super admin (data-list-open) and the page has the panel to open it in",
            'data-list-open="/admin/list/online-now?fragment=1"' in html and 'id="pnl-list"' in html)
    tpl = open(os.path.join(H.REPO, "templates", "admin_activity.html")).read()
    s.check("...and only for the super admin: the attribute sits behind nav_is_super, as on every count",
            re.search(r"\{% if nav_is_super %\}<a class=\"admin-card adm-tile adm-tile-link\"[^>]*data-list-open=", tpl)
            is not None and 'data-list-open' not in tpl.replace(
                tpl[tpl.index("{% if nav_is_super %}<a class"):tpl.index("{% else %}<div class")], ""))
    r = su.get("/admin/list/online-now")
    s.check("without ?fragment it goes to the Usage page", r.status_code == 302 and "/admin/activity" in
            r.headers.get("Location", ""), r.headers.get("Location"))

    s.section("the list is refused to everyone else")
    spec = a.ADMIN_LISTS["online-now"]
    s.check("registered as the super admin's own (not all_admins), in a module access can tick",
            not spec["all_admins"] and spec["module"] in a.ACCESS_MODULE_KEYS, spec)
    rb = H.client_as(a, BGA1).get("/admin/list/online-now?fragment=1")
    s.check("a BG admin gets 403 and sees no one", rb.status_code == 403 and "clp-eid" not in rb.get_data(as_text=True),
            rb.status_code)
    re_ = H.client_as(a, P1).get("/admin/list/online-now?fragment=1")
    s.check("an employee can't open it", re_.status_code in (302, 403, 404) and "clp-eid" not in re_.get_data(as_text=True),
            re_.status_code)
    ru = H.client_as(a, BGA1).get("/admin/activity")
    s.check("...nor the Usage page itself: it is the super admin's alone", ru.status_code in (302, 403)
            and "Online now" not in ru.get_data(as_text=True), ru.status_code)

    s.section("business-group scope: the count and the list stay inside the viewer's group")
    with a.app.test_request_context("/"):
        d = a.get_db()
        bga_row = d.execute("SELECT * FROM users WHERE id=?", (BGA1,)).fetchone()
        su_row = d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        mine = a.ADMIN_LISTS["online-now"]["build"](d, bga_row, None, {})
        wide = a.ADMIN_LISTS["online-now"]["build"](d, su_row, None, {})
    got = {r_["eid"] for r_ in mine["rows"]}
    s.check("the list, as BG one's admin: only people of BG one", {"ZZOL-P1", "ZZOL-P2"} <= got and "ZZOL-Q1" not in got
            and all(r_["bu"].startswith("ZZOL Group One") or r_["eid"] in got for r_ in mine["rows"]), got)
    s.check("...while the whole organisation's has BG two's person too", "ZZOL-Q1" in {r_["eid"] for r_ in wide["rows"]})
    real_scope = a.bg_scope
    try:
        a.bg_scope = lambda u, col="business_group": (" AND %s = ?" % col, [BG1])
        scoped = tile()[0]
    finally:
        a.bg_scope = real_scope
    s.check("the tile, scoped to BG one, counts BG one's people and not BG two's (here: exactly P1 and P2)",
            scoped == 2, scoped)
    s.check("...and unscoped it is the whole organisation's, three more than none", tile()[0] == n3)
    ago(P2, 20)
    a.bg_scope = lambda u, col="business_group": (" AND %s = ?" % col, [BG1])
    try:
        scoped1 = tile()[0]
    finally:
        a.bg_scope = real_scope
    s.check("...and scoped it follows the window too (P2 out at 20 minutes: one left)", scoped1 == 1, scoped1)

    s.section("the front end")
    css = open(os.path.join(H.REPO, "static", "style.css")).read()
    s.check("the five-column modifier is its own class (.adm-tiles stays four wherever it is used)",
            ".adm-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));" in css
            and re.search(r"\.adm-tiles\.adm-tiles-5 \{ grid-template-columns: repeat\(5, minmax\(0, 1fr\)\); \}", css)
            is not None)
    s.check("...and it drops to two columns at the same breakpoint as the others",
            re.search(r"\.adm-tiles, \.adm-tiles\.adm-tiles-5 \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}",
                      css) is not None)
    others = 0
    for fn in sorted(f for f in os.listdir(os.path.join(H.REPO, "templates")) if f.endswith(".html")):
        t_ = open(os.path.join(H.REPO, "templates", fn)).read()
        if "adm-tiles-5" in t_:
            others += 1
    s.check("only the Usage page and Audit and usage's AI insights tab (2026-11-06, five tiles) use it", others == 2, others)
finally:
    with a.app.app_context():
        d = a.get_db()
        cleanup(d)
        d.execute("DELETE FROM ended_sessions WHERE rowid > ?", (ENDED0,))
        d.commit()

sys.exit(s.done())
