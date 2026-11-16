"""A password change ends the other sessions; how long a sign-in lasts: an hour with no activity signs someone out (Chris,
2026-11-02), with a box at 50 minutes; the super admin and system admin are exempt, and so is an admin whose role has
Inactivity sign-out off (the built-in L&D admin role: tests/test_idle_role.py).

History: the 2026-10-24 developer handoff (12.2) found a password change left every other session signed in and no session
lifetime or idle timeout set. Chris then said an idle timeout "not for now"; on 2026-11-02 he reversed it ("inactive for an
hour = forced sign-out"), and "apply this to users only, not for the super admin and system admin". The longest sign-in
(SESSION_MAX_HOURS) stays off ("No fixed limit") but is built and held here with its number set.

What this suite holds:
  * signing in stamps the session with who it is and a mark of the password: an HMAC, so the cookie holds nothing of the hash
  * a password change ends every OTHER session: the person's own change (the browser that made it carries on), the reset
    link, People's Reset (the Ticketing agent's writer too), and any write of password_hash; the sign-in page says why
  * a session from before the mark (and the harness's) is stamped on its next request, never ended for lacking it
  * as shipped: idle limit 60 minutes with the warning at 10, no longest sign-in, Flask's cookie lifetime unchanged; a
    signed-in page loads session_alive.js with data-idle-sec=3600 and data-warn-sec=600, the sign-in page does not
  * what counts as activity on the server (one helper, _request_is_activity): a page navigation, any write, the page's ping
    and a request with no Sec-Fetch-Mode count; a script's background fetch (the banner poll) and /session/alive?peek=1 do not;
    the idle check itself runs on every request; the ping is stamped at once, the rest at most every SESSION_SEEN_EVERY
  * past the hour: signed out, the sign-in page says the exact idle sentence once; a stale form gets "Your session expired"
  * /logout?why=idle ends the session (its id in ended_sessions) and lands on /login?signed_out=idle, whose sentence is fixed
    in code (any other value shows nothing, the query is never echoed); a plain Log out says nothing
  * who it covers (_idle_applies, read by the gate and by base.html): the super admin and the system admin are never signed
    out for idle and get no script; a BG admin and staff are covered; judged by the real account
  * the longest sign-in signs out however active, when switched on
  * Help's "Why was I signed out?" and the KB row say the hour and the 10-minute warning; the one-time UPDATE leaves an
    edited body alone
  * each guard falsified: the activity helper, the words, the login parameter, the exemption
Synthetic (ZZSN-*) on the shared suite database; everything is put back at the end.
"""
import os
import re
import sys
import time
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from werkzeug.security import generate_password_hash  # noqa: E402

a = H.setup()
s = H.Suite("Sessions: a password change ends the other sessions; an hour idle signs out (users, not the super admin); the 50-minute box")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
PW, PW2 = "Right-pass-1", "Second-pass-2"
LIMITS0 = (a.SESSION_IDLE_MIN, a.SESSION_MAX_HOURS)
WARN0 = a.SESSION_WARN_MIN
IDLE_FN0 = a._idle_applies
HELP0 = dict(a.HELP_QA)


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZSN-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM password_resets WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM login_attempts WHERE username LIKE 'ZZSN-%'")
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    _cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]
    pwh = generate_password_hash(PW, method="pbkdf2:sha256:1000")   # cheap rounds: the suite signs in many times

    def mk(eid, **over):
        v = dict(base, username=eid, employee_id=eid, full_name=eid, email=None, manager_id=None, hod_id=None,
                 left_at=None, role="user", admin_bg=None, password_hash=pwh)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    ME, YOU = mk("ZZSN-ME"), mk("ZZSN-YOU")
    SUPER = mk("ZZSN-SUPER", role="admin", admin_bg=None)
    SYSA = mk("ZZSN-SYS", role="admin", admin_bg=None, is_system_admin=1)
    BGADM = mk("ZZSN-BGA", role="admin", admin_bg="ZZ-BG")
    db.commit()


def sign_in(eid, pw=PW):
    c = a.app.test_client()
    with c.session_transaction() as ss:
        ss["csrf_token"] = "tok"
    c.post("/login", data={"username": eid, "password": pw, "csrf_token": "tok"})
    c.get("/account/password")   # the sign-in starts a fresh session: its first page gives it a form token
    return c


def sess(c):
    with c.session_transaction() as ss:
        return dict(ss)


def put(c, **kv):
    with c.session_transaction() as ss:
        ss.update(kv)


def signed_in(c):
    """A login_required page with no module: 200 signed in, else the way to sign-in."""
    return c.get("/account/password").status_code == 200


def login_page(c):
    return c.get("/login").get_data(as_text=True).replace("&#39;", "'")


def set_hash(uid, pw):
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(pw, method="pbkdf2:sha256:1000"),
                                                                 uid))
        d.commit()


def limits(idle, maxh):
    a.SESSION_IDLE_MIN, a.SESSION_MAX_HOURS = idle, maxh


try:
    s.section("signing in stamps the session")
    c = sign_in("ZZSN-ME")
    v = sess(c)
    s.check("who it is", v.get("user_id") == ME)
    s.check("...and the password's mark: 16 hex, nothing of the hash", re.fullmatch(r"[0-9a-f]{16}", v.get("pw") or "")
            and v["pw"] not in pwh and all(p not in str(v) for p in pwh.split("$")[1:]))
    s.check("signed in", signed_in(c))

    s.section("a password change ends the OTHER sessions")
    c1, c2 = sign_in("ZZSN-ME"), sign_in("ZZSN-ME")
    s.check("two browsers signed in", signed_in(c1) and signed_in(c2))
    r = c1.post("/account/password", data={"csrf_token": sess(c1)["csrf_token"], "current": PW, "new": PW2,
                                           "confirm": PW2})
    s.check("their own change: saved", r.status_code == 302 and H.one(
        a, "SELECT pw_source FROM users WHERE id=?", (ME,)) == "own" and
        H.one(a, "SELECT password_hash FROM users WHERE id=?", (ME,)) != pwh)
    s.check("...the browser that made it carries on", signed_in(c1))
    s.check("...the other is signed out, and told why", not signed_in(c2) and
            "Your password was changed, so you were signed out here." in login_page(c2))
    s.check("...and signs in again with the new one", signed_in(sign_in("ZZSN-ME", PW2)))

    set_hash(ME, PW)
    c1 = sign_in("ZZSN-ME")
    raw = "zzsn-token-%d" % time.time()
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT INTO password_resets(token_hash, user_id) VALUES (?,?)", (a._hash_token(raw), ME))
        d.commit()
    anon = a.app.test_client()
    with anon.session_transaction() as ss:
        ss["csrf_token"] = "tok"
    r = anon.post("/reset/%s" % raw, data={"csrf_token": "tok", "new": PW2, "confirm": PW2})
    s.check("the reset link: set, and the session elsewhere ends", r.status_code == 302 and not signed_in(c1))

    set_hash(ME, PW)
    c1 = sign_in("ZZSN-ME")
    cs = H.client_as(a, SU["id"])
    r = cs.post("/admin/users", data={"csrf_token": "tok", "action": "reset_pw", "user_id": ME, "new_password": PW2})
    s.check("People's Reset (the Ticketing agent's writer too): their session ends",
            r.status_code == 302 and H.one(a, "SELECT pw_source FROM users WHERE id=?", (ME,)) == "admin" and
            not signed_in(c1))
    s.check("...the admin who reset it carries on", signed_in(cs))

    c1, c3 = sign_in("ZZSN-ME", PW2), sign_in("ZZSN-YOU")
    set_hash(ME, "Third-pass-3")
    s.check("any write of the password hash ends their sessions (the import, the admins' and L&D admins' resets)",
            not signed_in(c1))
    s.check("...and nobody else's", signed_in(c3))

    s.section("sessions from before the mark")
    c = H.client_as(a, YOU)
    s.check("a session with only who it is carries on", signed_in(c))
    s.check("...stamped on its next request", bool(sess(c).get("pw")))
    set_hash(YOU, PW2)
    s.check("...so a password change ends it from then on", not signed_in(c))
    c = a.app.test_client()
    r = c.get("/__scratch_login/%d" % YOU)
    s.check("the harness's scratch login still works", r.status_code == 302 and signed_in(c))

    SENT = "You've been inactive for an hour, so we signed you out. Sign in again to continue."
    IDLE = 3600
    DEAD = IDLE + a.SESSION_SEEN_EVERY   # the server's deadline: the hour plus one grace minute for the stamp's lag (_idle_deadline)

    def hdr(c, mode=None, path="/account/password"):
        """A GET as a browser makes it, with its Sec-Fetch-Mode (None: an old browser that sends none)."""
        return c.get(path, headers={"Sec-Fetch-Mode": mode} if mode else {})

    def aged(c, secs):
        put(c, seen=int(time.time()) - secs)

    s.section("as shipped: an hour idle, a warning at 10 minutes, no longest sign-in (Chris, 2026-11-02)")
    s.check("idle limit 60 minutes, warning 10, no longest sign-in", (a.SESSION_IDLE_MIN, a.SESSION_WARN_MIN,
                                                                   a.SESSION_MAX_HOURS) == (60, 10, None))
    s.check("Flask's cookie lifetime unchanged", a.app.permanent_session_lifetime == timedelta(days=31))
    c = sign_in("ZZSN-YOU", PW2)
    v = sess(c)
    s.check("signing in stamps the last activity, not the start", abs(v.get("seen", 0) - int(time.time())) < 5 and
            "since" not in v, v.keys())
    pg = c.get("/account/password").get_data(as_text=True)
    m = re.search(r'<script src="[^"]*session_alive\.js[^"]*" data-idle-sec="(\d+)" data-warn-sec="(\d+)"[^>]*>', pg)
    s.check("a signed-in page loads session_alive.js with data-idle-sec=3600 and data-warn-sec=600",
            m and (int(m.group(1)), int(m.group(2))) == (a.SESSION_IDLE_MIN * 60, a.SESSION_WARN_MIN * 60) == (3600, 600))
    s.check("...with the addresses it needs (ping, log out, sign-in)", 'data-alive="/session/alive"' in pg and
            'data-logout="/logout"' in pg and 'data-login="/login"' in pg)
    s.check("...and the form token it signs out with is on the page", 'name="csrf-token"' in pg)
    s.check("the sign-in page doesn't load it", "session_alive.js" not in a.app.test_client().get("/login").get_data(
        as_text=True))
    limits(None, None)
    c0 = sign_in("ZZSN-YOU", PW2)
    s.check("FALSIFIED the other way: with no idle limit set, no activity stamp and no script on any page",
            "seen" not in sess(c0) and "session_alive.js" not in c0.get("/account/password").get_data(as_text=True))
    put(c0, seen=int(time.time()) - 3 * 86400)
    s.check("...and three days idle stays in", signed_in(c0))
    limits(60, None)

    s.section("what counts as activity on the server (one helper)")
    c = sign_in("ZZSN-YOU", PW2)
    for label, mode, want in (("a script's background fetch (Sec-Fetch-Mode: cors), like the banner poll", "cors", False),
                              ("a same-origin fetch", "same-origin", False),
                              ("a no-cors fetch", "no-cors", False),
                              ("a page navigation (Sec-Fetch-Mode: navigate)", "navigate", True),
                              ("a request with no Sec-Fetch-Mode at all (an old browser: the safe side)", None, True)):
        aged(c, 300)
        s0 = sess(c)["seen"]
        r = hdr(c, mode)
        s.check("%s: %s" % (label, "moves the last activity" if want else "does not move it"),
                r.status_code == 200 and ((sess(c)["seen"] > s0) is want), (mode, s0, sess(c)["seen"]))
    aged(c, 300)
    s0 = sess(c)["seen"]
    tok = sess(c)["csrf_token"]
    c.post("/account/password", data={"csrf_token": tok, "current": "x", "new": "y", "confirm": "z"})
    s.check("a POST moves it", sess(c)["seen"] > s0)
    aged(c, 300)
    s0 = sess(c)["seen"]
    c.post("/account/password", headers={"Sec-Fetch-Mode": "cors"}, data={"csrf_token": tok, "current": "x", "new": "y",
                                                                          "confirm": "z"})
    s.check("...a write is a write whatever its mode (a script's POST too)", sess(c)["seen"] > s0)
    aged(c, 300)
    s0 = sess(c)["seen"]
    r = c.get("/session/alive", headers={"Sec-Fetch-Mode": "cors"})
    s.check("/session/alive (the page's own fetch, mode cors) moves it", r.get_json().get("signed_in") is True and
            sess(c)["seen"] > s0)
    put(c, seen=int(time.time()) - 30)
    s0 = sess(c)["seen"]
    c.get("/session/alive", headers={"Sec-Fetch-Mode": "cors"})
    s.check("...stamped at once, not held to the %ds re-stamp" % a.SESSION_SEEN_EVERY, sess(c)["seen"] > s0)
    put(c, seen=int(time.time()) - 30)
    s0 = sess(c)["seen"]
    hdr(c, "navigate")
    s.check("a navigation inside %ds is not re-stamped (the cookie isn't re-signed on every request)" %
            a.SESSION_SEEN_EVERY, sess(c)["seen"] == s0)
    aged(c, 300)
    s0 = sess(c)["seen"]
    r = c.get("/session/alive?peek=1", headers={"Sec-Fetch-Mode": "cors"})
    d = r.get_json()
    s.check("/session/alive?peek=1 moves nothing", sess(c)["seen"] == s0)
    s.check("...and reports idle_left by the server's deadline (the hour and its grace minute, less the 5 minutes)", d.get("signed_in") is True
            and isinstance(d.get("idle_left"), int) and abs(d["idle_left"] - (DEAD - 300)) <= 5, d)
    r = c.get("/session/alive?peek=1")
    s.check("...with no header too (peek never counts)", sess(c)["seen"] == s0 and r.get_json()["signed_in"] is True)
    aged(c, DEAD + 5)
    r = hdr(c, "cors")
    s.check("the idle check runs on a request that doesn't count: past the hour, a background fetch finds them signed out",
            "user_id" not in sess(c))
    # falsify the helper: if every request counted, the background fetch would move it
    real = a._request_is_activity
    a._request_is_activity = lambda: True
    try:
        c = sign_in("ZZSN-YOU", PW2)
        aged(c, 300)
        s0 = sess(c)["seen"]
        hdr(c, "cors")
        s.check("FALSIFIED: with the helper broken (everything counts) a background fetch moves it, so the checks above bite",
                sess(c)["seen"] > s0)
    finally:
        a._request_is_activity = real

    s.section("the grace minute: the server ends it one SESSION_SEEN_EVERY after the page's hour")
    s.check("the deadline is one helper: seen + the hour + the grace", a._idle_deadline(1000) == 1000 + IDLE +
            a.SESSION_SEEN_EVERY == 1000 + DEAD and a.SESSION_SEEN_EVERY == 60)
    c = sign_in("ZZSN-YOU", PW2)
    aged(c, IDLE + 30)
    s.check("a stamp half a grace minute past the hour (the page's own time-out would be here first): still in", signed_in(c))
    aged(c, DEAD - 5)
    s.check("just under the deadline: carries on", signed_in(c))
    aged(c, DEAD + 5)
    s.check("just past the deadline: ends", not signed_in(c) and "user_id" not in sess(c))
    c = sign_in("ZZSN-YOU", PW2)
    aged(c, IDLE - 300)
    d0 = c.get("/session/alive?peek=1").get_json()["idle_left"]
    s.check("peek's idle_left is read from the same deadline (the hour, the grace, less the idle so far)",
            abs(d0 - (a._idle_deadline(sess(c)["seen"]) - int(time.time()))) <= 2 and abs(d0 - (DEAD - (IDLE - 300))) <= 5, d0)
    for label, grace in (("removed (0)", 0), ("doubled (120)", 120)):
        keep = a.SESSION_SEEN_EVERY
        a.SESSION_SEEN_EVERY = grace
        try:
            c = sign_in("ZZSN-YOU", PW2)
            aged(c, IDLE + 30)
            carried = signed_in(c)
            c = sign_in("ZZSN-YOU", PW2)
            aged(c, DEAD - 5)
            under = signed_in(c)
            c = sign_in("ZZSN-YOU", PW2)
            aged(c, DEAD + 5)
            past = not signed_in(c)
            c = sign_in("ZZSN-YOU", PW2)
            aged(c, IDLE - 300)
            left = c.get("/session/alive?peek=1").get_json()["idle_left"]
        finally:
            a.SESSION_SEEN_EVERY = keep
        s.check("FALSIFIED: with the grace %s each check above fails (half-a-minute past, just under, just past, peek)" % label,
                not carried if grace == 0 else (not past), (carried, under, past))
        s.check("...and peek's idle_left no longer matches the one-minute grace", abs(left - (DEAD - (IDLE - 300))) > 5, left)
        if grace == 0:
            s.check("...(removed: a stamp half a minute past the hour is wrongly ended)", not carried)
            s.check("...(removed: just under the one-minute deadline is wrongly ended)", not under)
        else:
            s.check("...(doubled: just past the one-minute deadline wrongly carries on)", not past)

    s.section("past the hour: signed out, in the exact words")
    c = sign_in("ZZSN-YOU", PW2)
    put(c, seen=int(time.time()) - DEAD + 60)
    s.check("a minute short of the deadline: still in, and that request counted", signed_in(c) and
            abs(sess(c)["seen"] - int(time.time())) < 5)
    aged(c, DEAD + 5)
    s.check("past it: signed out", not signed_in(c) and "user_id" not in sess(c))
    pg = login_page(c)
    s.check("...the sign-in page says the exact idle sentence, once", pg.count(SENT) == 1 and
            "Sign in again to carry on" not in pg, pg.count(SENT))
    s.check("...and the words come from SESSION_IDLE_MIN (an hour)", a._session_idle_words() == "an hour" and
            a._session_idle_sentence() == SENT)
    c = sign_in("ZZSN-YOU", PW2)
    tok = sess(c)["csrf_token"]
    aged(c, DEAD + 5)
    r = c.post("/account/password", data={"csrf_token": tok, "current": PW2, "new": PW, "confirm": PW})
    s.check("a form sent after it gets 'Your session expired', nothing written", r.status_code == 400 and
            "Your session expired" in r.get_data(as_text=True) and
            a.check_password_hash(H.one(a, "SELECT password_hash FROM users WHERE id=?", (YOU,)), PW2))
    c = sign_in("ZZSN-YOU", PW2)
    limits(30, None)
    aged(c, 1900)
    signed_in(c)
    pg = login_page(c)
    s.check("FALSIFIED: another number changes the words ('30 minutes'), so they are derived, not fixed",
            "You've been inactive for 30 minutes, so we signed you out. Sign in again to continue." in pg and
            a._session_idle_words() == "30 minutes")
    limits(60, None)
    s.check("the other reasons keep their words ('Sign in again to carry on')", a._session_end_words("password") ==
            "Your password was changed, so you were signed out here." and
            a._session_end_words("ended") == "You were signed out.")

    s.section("the page's ping and the sign-out from the page")
    c = sign_in("ZZSN-YOU", PW2)
    aged(c, 600)
    r = c.get("/session/alive")
    d = r.get_json()
    s.check("signed in: it says so and how long is left", r.status_code == 200 and d["signed_in"] is True and
            abs(d["idle_left"] - DEAD) <= 5, d)
    aged(c, DEAD + 5)
    d = c.get("/session/alive").get_json()
    s.check("past the idle limit: signed out, why 'idle', in the idle words, and to copy what they typed",
            d.get("signed_in") is False and d.get("why") == "idle" and
            d.get("say", "").startswith("You've been inactive for an hour, so we signed you out.") and
            "Copy anything you've typed" in d["say"], d)
    r = a.app.test_client().get("/session/alive")
    s.check("signed out from the start: 200 all the same (the route probe)", r.status_code == 200 and
            r.get_json().get("signed_in") is False)
    s.check("it belongs to no module", "session_alive" in a.MODULE_UNGATED_ENDPOINTS and
            a.module_of_request("session_alive", "/session/alive") is None)
    js = open(os.path.join(H.REPO, "static", "session_alive.js"), encoding="utf-8").read()
    s.check("the script: activity events, localStorage in try/catch, the box's words, no browser confirm()",
            all(e in js for e in ("'keydown'", "'pointerdown'", "'wheel'", "'input'", "'touchstart'",
                                  "'pointermove'")) and "onehr.idle.last" in js and "onehr.idle.out" in js and
            "Are you still there?" in js and "Log me out" in js and "Stay signed in" in js and
            "?why=idle" in js and "peek=1" in js and "confirm(" not in js and "alert(" not in js)
    s.check("...and it does NOT listen for 'scroll' (a page scrolling itself, like a streaming chat, would count as someone being there)",
            "'scroll'" not in js and '"scroll"' not in js and "addEventListener('scroll'" not in js)
    s.section("/logout?why=idle and the sign-in page's sentence")
    c = sign_in("ZZSN-YOU", PW2)
    sid = sess(c)["sid"]
    r = c.get("/logout?why=idle", headers={"Sec-Fetch-Site": "same-origin"})
    s.check("the page's time-out: signed out, to /login?signed_out=idle", r.status_code == 302 and
            r.headers["Location"].endswith("/login?signed_out=idle") and "user_id" not in sess(c))
    s.check("...its session id is ended on the server", bool(H.one(a, "SELECT 1 FROM ended_sessions WHERE sid=?", (sid,))))
    pg = c.get("/login?signed_out=idle").get_data(as_text=True).replace("&#39;", "'")
    s.check("the sign-in page shows the idle sentence in its alert box, once", pg.count(SENT) == 1 and
            'class="ax-alert"' in pg and "data-idle-note" in pg)
    for q in ("/login", "/login?signed_out=1", "/login?signed_out=Idle", "/login?signed_out=idle%20", "/login?signed_out=ZZECHO"):
        pg = a.app.test_client().get(q).get_data(as_text=True).replace("&#39;", "'")
        s.check("%s: no sentence, and the query's text is never echoed" % q, "inactive for" not in pg and "ZZECHO" not in pg)
    pg = a.app.test_client().get("/login?signed_out=%3Cb%3EZZXSS%3C/b%3E").get_data(as_text=True)
    s.check("a script-looking value is never put on the page", "ZZXSS" not in pg)
    c = sign_in("ZZSN-YOU", PW2)
    aged(c, DEAD + 5)
    r = c.get("/logout?why=idle", headers={"Sec-Fetch-Site": "same-origin"})
    pg = c.get("/login?signed_out=idle").get_data(as_text=True).replace("&#39;", "'")
    s.check("already ended by the server's own check, then the page's time-out: the sentence is shown once, never twice",
            r.status_code == 302 and pg.count(SENT) == 1, pg.count(SENT))
    c = sign_in("ZZSN-YOU", PW2)
    r = c.get("/logout?why=idle", headers={"Sec-Fetch-Site": "cross-site"})
    s.check("a link on another site still can't sign anyone out (?why=idle changes nothing there)",
            r.status_code == 302 and r.headers["Location"].endswith("/dashboard") and signed_in(c))
    r = c.get("/logout?why=banana", headers={"Sec-Fetch-Site": "same-origin"})
    s.check("any other ?why= signs out and says nothing", r.status_code == 302 and r.headers["Location"].endswith("/login"))
    c = sign_in("ZZSN-YOU", PW2)
    r = c.post("/logout", data={"csrf_token": sess(c)["csrf_token"]})
    pg = c.get("/login").get_data(as_text=True).replace("&#39;", "'")
    s.check("Log me out (a POST with the token): the normal sign-out, no message", r.status_code == 302 and
            r.headers["Location"].endswith("/login") and "user_id" not in sess(c) and "inactive for" not in pg and
            "signed out" not in pg.lower().replace("signed out of", ""), r.headers.get("Location"))
    c1 = sign_in("ZZSN-YOU", PW2)
    tok1 = sess(c1)["csrf_token"]
    c1.post("/logout", data={"csrf_token": tok1})
    r = c1.get("/logout")
    pg = c1.get("/login").get_data(as_text=True)
    s.check("a second tab's sign-out after the first (the same session, already ended) says nothing either",
            r.status_code == 302 and "You were signed out" not in pg)

    # the race the browser showed: tab B hears "log out" and signs out first, then tab A's own POST arrives with the cookie of a
    # session that is already ended on the server. Log out says nothing, whatever ended it.
    c = sign_in("ZZSN-YOU", PW2)
    tok = sess(c)["csrf_token"]
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT OR IGNORE INTO ended_sessions(sid) VALUES (?)", (sess(c)["sid"],))
        d_.commit()
    r = c.post("/logout", data={"csrf_token": tok})
    pg = c.get("/login").get_data(as_text=True).replace("&#39;", "'")
    s.check("Log me out arriving after another tab ended the same session: to sign-in, with no message at all",
            r.status_code == 302 and r.headers["Location"].endswith("/login") and "You were signed out" not in pg and
            "inactive for" not in pg and "ax-alert" not in pg.replace(".ax-alert", ""), r.headers.get("Location"))
    c = sign_in("ZZSN-YOU", PW2)
    aged(c, DEAD + 5)
    r = c.get("/logout?why=idle", headers={"Sec-Fetch-Site": "same-origin"})
    s.check("...and the page's idle time-out reaching a session already past the hour: the sentence once (from the parameter)",
            c.get("/login?signed_out=idle").get_data(as_text=True).replace("&#39;", "'").count(SENT) == 1)

    s.section("who it covers: users, not the super admin or the system admin")
    for who, uid, label in (("ZZSN-SUPER", SUPER, "the super admin"), ("ZZSN-SYS", SYSA, "the system admin")):
        c = sign_in(who, PW)
        pg = c.get("/account/password").get_data(as_text=True)
        s.check("%s: no idle script on a signed-in page" % label, "session_alive.js" not in pg and
                c.get("/account/password").status_code == 200)
        s.check("...and no activity stamp", "seen" not in sess(c), sess(c).keys())
        put(c, seen=int(time.time()) - 3 * 3600)
        r = hdr(c, "navigate")
        s.check("...idle three hours: still signed in (a page, a fetch and the ping)", r.status_code == 200 and
                hdr(c, "cors").status_code == 200 and c.get("/session/alive").get_json()["signed_in"] is True)
        s.check("...the stale stamp is dropped, not kept", "seen" not in sess(c))
        d = c.get("/session/alive?peek=1").get_json()
        s.check("...and peek says signed in with no idle_left", d == {"signed_in": True, "idle_left": None}, d)
    c = sign_in("ZZSN-BGA", PW)
    pg = c.get("/account/password").get_data(as_text=True)
    s.check("a BG admin (not super) gets the idle script", 'data-idle-sec="3600"' in pg, c.get("/account/password").status_code)
    aged(c, DEAD + 5)
    s.check("...and past the hour is signed out", c.get("/account/password").status_code != 200 or
            "user_id" not in sess(c))
    s.check("...(signed out, not merely refused)", "user_id" not in sess(c) and SENT in login_page(c))
    # the helper is what decides both: break it and the super admin is covered again
    a._idle_applies = lambda row: bool(a.SESSION_IDLE_MIN)
    try:
        c = sign_in("ZZSN-SUPER", PW)
        pg = c.get("/account/password").get_data(as_text=True)
        s.check("FALSIFIED: with the helper broken the super admin gets the script", 'data-idle-sec="3600"' in pg)
        aged(c, DEAD + 5)
        s.check("...and is signed out past the hour (so the exemption checks above bite, in both the page and the gate)",
                "user_id" not in sess(c) or not signed_in(c))
    finally:
        a._idle_applies = IDLE_FN0
    # an account that becomes or stops being super takes effect on its next request
    c = sign_in("ZZSN-YOU", PW2)
    aged(c, 2 * 3600)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE users SET role='admin', admin_bg=NULL WHERE id=?", (YOU,))
        d_.commit()
    s.check("a user made a super admin: the idle ending no longer applies on their next request", signed_in(c))
    pg = c.get("/account/password").get_data(as_text=True)
    s.check("...and the page drops the script", "session_alive.js" not in pg)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE users SET role='user', admin_bg=NULL WHERE id=?", (YOU,))
        d_.commit()
    pg = c.get("/account/password").get_data(as_text=True)
    s.check("...made a user again: covered on their next request (the script is back, a fresh hour starts)",
            'data-idle-sec="3600"' in pg and abs(sess(c).get("seen", 0) - int(time.time())) < 5)
    src = H.source(a)
    s.check("both readers ask the same helper, on the REAL account (demo_actor), never the persona",
            "_idle_applies(demo_actor())" in src and "idle_on = _idle_applies(row)" in src and
            "def idle_signout_on" in src)

    s.section("switched on: the longest sign-in")
    limits(None, 12)
    MAXH = 12 * 3600
    c = sign_in("ZZSN-YOU", PW2)
    s.check("signing in stamps when", abs(sess(c).get("since", 0) - int(time.time())) < 5)
    put(c, since=int(time.time()) - MAXH + 60)
    s.check("a minute short of 12 hours: still in", signed_in(c))
    put(c, since=int(time.time()) - MAXH - 5)
    s.check("past it, however active: signed out, and why", not signed_in(c) and
            "a sign-in lasts 12 hours" in login_page(c))
    src = H.source(a)
    s.check("...and Flask's own cookie lifetime is held to it once set",
            'if SESSION_MAX_HOURS:   # Flask refuses a cookie not re-signed for this long' in src and
            'app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=SESSION_MAX_HOURS)' in src)
    limits(*LIMITS0)

    s.section("what Help and the KB say")
    q, ans = a.HELP_QA["signed_out"]
    s.check("Help's 'Why was I signed out?' says an hour, the 10-minute box, Stay signed in and any tab", q ==
            "Why was I signed out?" and "After an hour with no activity" in ans and "About 10 minutes before" in ans and
            "Stay signed in" in ans and "any OneHR tab" in ans and "password" in ans and
            "signed_out" in a.HELP_LISTS["other"][1], ans)
    s.check("...and the password answer still says it signs out the other devices",
            "other devices" in a.HELP_QA["dash_password"][1])
    kb = H.one(a, "SELECT body FROM kb_entries WHERE slug='signed-out' AND active=1")
    s.check("the KB row says the same (for Ask OneHR and the agents)", kb == a._KB_SIGNED_OUT_BODY and
            "after an hour with no activity" in kb and "About 10 minutes before" in kb and "Stay signed in" in kb and
            "any OneHR tab" in kb and "every other device" in kb, kb)
    s.check("...and the old text is kept inside it, whole", a._KB_SIGNED_OUT_BEFORE in a._KB_SIGNED_OUT_BODY)
    s.check("Help and the KB say what counts (mouse, typing, clicking) and never scrolling (Chris 2026-11-03)",
            "Moving the mouse, typing or clicking" in ans and "Moving the mouse, typing or clicking" in kb and
            "scroll" not in ans.lower() and "scroll" not in kb.lower(), (ans, kb))
    kbq = lambda: H.one(a, "SELECT body FROM kb_entries WHERE slug='signed-out'")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE kb_entries SET body=? WHERE slug='signed-out'", (a._KB_SIGNED_OUT_BEFORE,))
        d_.commit()
    a._ensure_runtime_schema()
    s.check("a live row still on the old text is reworded once by the boot", kbq() == a._KB_SIGNED_OUT_BODY)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE kb_entries SET body=? WHERE slug='signed-out'", (a._KB_SIGNED_OUT_BODY_SCROLL,))
        d_.commit()
    a._ensure_runtime_schema()
    s.check("a live row on the 2-3 Nov text (scrolling counts) takes the right words once", kbq() == a._KB_SIGNED_OUT_BODY)
    edited = a._KB_SIGNED_OUT_BEFORE + " ZZ Group People's own words."
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE kb_entries SET body=? WHERE slug='signed-out'", (edited,))
        d_.commit()
    a._ensure_runtime_schema()
    s.check("a hand-edited body is left alone (the UPDATE matches the old text exactly)", kbq() == edited)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE kb_entries SET body=? WHERE slug='signed-out'", (a._KB_SIGNED_OUT_BODY,))
        d_.commit()
finally:
    limits(*LIMITS0)
    a.SESSION_WARN_MIN = WARN0
    a._idle_applies = IDLE_FN0
    with a.app.app_context():
        _cleanup(a.get_db())
sys.exit(s.done())
