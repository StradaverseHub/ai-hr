"""The security test's sign-in findings, fixed (2026-10-31, Chris: "go ahead and fix all now"). One suite for the bundle:

  2-03 + 2-11  one hash check whatever the Employee ID (known, unknown, closed), so how long a wrong password takes tells
               nothing; a stored ID is capped at 64 characters; login_attempts is indexed and pruned
  2-04 + 2-14  Sign out really ends the session on the server (a copied cookie is refused), per session only; every Log out
               is a POST with the token; a GET still signs out unless the browser says another site sent it; a cookie from
               before is stamped with an id and keeps working
  2-05         a new reset link no longer closes the earlier unused ones
  2-06 + 2-09  a reset link dies with a password change, an admin reset, an import or a closed account; the BG-admin,
               sub-admin and L&D-admin reset writers record how the password was set, end the links and write the trail
  2-08 + 2-10  one _password_problem() for every writer; a lock that trips leaves one Audit-log row an hour; wrong current
               passwords on Change password are capped
  2-01         a row with is_demo=1 doesn't sign in where the server has no demo accounts (is_demo only, never an ID prefix)
  2-13         the known-device cookie holds only a random id
  2-07 + 3-10  covered with the sign-in help suite (test_signin_help)

A guard is only real if it fails without its fix: every check here is wrapped so that on the old code it FAILS on its own
rather than stopping the suite, and the suite was run against origin/main to show that.

Synthetic (ZZHS-*) on the shared suite database; everything is put back at the end.
"""
import os
import re
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from werkzeug.security import check_password_hash, generate_password_hash  # noqa: E402

a = H.setup()
s = H.Suite("Sign-in hardening -- timing, real sign-out, reset links, one password rule, lock trail, demo gate, device cookie")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)

PW = "Right-pass-1"
NEWPW = "Brand-new-pass-9"
# 128 characters of an ordinary phrase (a run of one letter is refused as too easy since 2026-10-31)
LONG128 = ("river stone 7 " * 10)[:128]
LONG128B = ("lamp post 3 " * 11)[:128]
cheap = generate_password_hash(PW, method="pbkdf2:sha256:1000")     # the suite signs in many times
real = generate_password_hash(PW, method="pbkdf2:sha256")           # a real hash's cost, for the timing
_DEMO_ENV = os.environ.get("L360_DEMO_ACCOUNTS")
_ODDS = getattr(a, "LOGIN_PRUNE_ODDS", 50)   # (getattr: the old code has none of the new names)
ID_MAX = getattr(a, "LOGIN_ID_MAX", 64)
PW_FAILS = getattr(a, "PWCHANGE_MAX_FAILS", 5)


def run(sql, args=()):
    with a.app.app_context():
        d = a.get_db()
        d.execute(sql, args)
        d.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def rows(sql, args=()):
    return H.rows(a, sql, args)


def chk(name, fn, detail=None):
    """A check that can't stop the suite: on code without the fix, whatever it touches may not exist."""
    try:
        r = fn()
    except Exception as e:  # noqa: BLE001
        return s.check(name, False, "raised %s: %s" % (type(e).__name__, str(e)[:120]))
    return s.check(name, bool(r), detail if detail is not None else "")


_start_ended = None
try:
    _start_ended = one("SELECT COALESCE(MAX(rowid),0) FROM ended_sessions")
except Exception:  # noqa: BLE001 -- the old code has no such table
    pass


def _cleanup():
    with a.app.app_context():
        d = a.get_db()
        ids = [r[0] for r in d.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZHS-%'")]
        if ids:
            ph = ",".join("?" * len(ids))
            d.execute("DELETE FROM password_resets WHERE user_id IN (%s)" % ph, ids)
            d.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
            d.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ids)
            d.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
        d.execute("DELETE FROM login_attempts WHERE username LIKE 'ZZHS-%' OR username LIKE 'pwchg:ZZHS-%' OR username LIKE 'ZZHS%'")
        d.execute("DELETE FROM activity_log WHERE action='password_reset_unknown' AND detail LIKE 'Employee ID typed: ZZHS%'")
        d.commit()
        for sql, args in (("DELETE FROM known_devices WHERE username LIKE 'ZZHS-%'", ()),
                          ("DELETE FROM ended_sessions WHERE rowid > ?", (_start_ended,)) if _start_ended is not None else (None, None),
                          ("DELETE FROM ended_sessions WHERE sid LIKE 'zzhs-%'", ())):
            if not sql:
                continue
            try:
                d.execute(sql, args)
                d.commit()
            except Exception:  # noqa: BLE001
                pass


with a.app.test_request_context("/"):
    db = a.get_db()
    _cleanup()
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]
    BG = a.org_bgs(db)[0]
    COMPANY = a.org_map(db)[BG][0]

    def mk(eid, **over):
        v = dict(base, username=eid, employee_id=eid, full_name=eid, email=None, manager_id=None, hod_id=None,
                 left_at=None, role="user", admin_bg=None, password_hash=cheap, is_demo=0, is_system_admin=0,
                 pw_source=None, pw_set_at=None)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    KNOWN = mk("ZZHS-KNOWN", password_hash=real, email="zzhs-known@example.invalid")
    CLOSED = mk("ZZHS-CLOSED", password_hash=real, left_at="2026-01-01")
    U = mk("ZZHS-U", email="zzhs-u@example.invalid")
    V = mk("ZZHS-V", email="zzhs-v@example.invalid")
    LOCKME = mk("ZZHS-LOCK")
    PWU = mk("ZZHS-PWU")
    BGADM = mk("ZZHS-BGADM", role="admin", admin_bg=BG, full_name="ZZHS BG admin")
    SUBADM = mk("ZZHS-SUBADM", role="admin", admin_bg=BG, full_name="ZZHS sub-admin")
    SYSADM = mk("ZZHS-SYSADM", role="admin", admin_bg=BG, full_name="ZZHS system admin", is_system_admin=1)
    db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (SUBADM, COMPANY))
    db.commit()


def new_client(ip=None):
    c = a.app.test_client()
    if ip:
        c.environ_base["REMOTE_ADDR"] = ip
    with c.session_transaction() as ss_:
        ss_["csrf_token"] = "tok"
    return c


def sign_in(c, user, pw=PW):
    with c.session_transaction() as ss_:
        ss_.setdefault("csrf_token", "tok")
        tok = ss_["csrf_token"]
    r = c.post("/login", data={"username": user, "password": pw, "csrf_token": tok})
    if r.status_code == 302:
        c.get("/session/alive")   # the new session's first request: it gets its token, as a page load gives one
    return r


def alive(c):
    """Whether this client is signed in: /session/alive runs the request gate and answers for the session it left."""
    return bool(c.get("/session/alive").get_json().get("signed_in"))


def token(c):
    with c.session_transaction() as ss_:
        return ss_.get("csrf_token", "tok")


def post(c, path, **data):
    data.setdefault("csrf_token", token(c))
    return c.post(path, data=data)


def pw_hash(uid):
    return one("SELECT password_hash FROM users WHERE id=?", (uid,))


def session_cookie(c):
    ck = c.get_cookie("session")
    return ck.value if ck else None


def cookie_client(value):
    c = a.app.test_client()
    c.set_cookie("session", value)
    return c


# =================================================================================================================
# 1. Sign-in timing, ID cap, index, pruning (2-03, 2-11)
# =================================================================================================================
s.section("2-03: one hash check whatever the Employee ID")
calls = []
_real_check = a.check_password_hash


def counting(h, p):
    calls.append(h)
    return _real_check(h, p)


a.check_password_hash = counting
try:
    for what, user, pw in (("a known ID, wrong password", "ZZHS-KNOWN", "nope"), ("a known ID, right password", "ZZHS-KNOWN", PW),
                           ("an unknown ID", "ZZHS-NOBODY-1", "nope"), ("a closed account, wrong password", "ZZHS-CLOSED", "nope"),
                           ("a closed account, right password", "ZZHS-CLOSED", PW)):
        del calls[:]
        sign_in(new_client(), user, pw)
        s.check("%s: exactly one hash check" % what, len(calls) == 1, "%d checks" % len(calls))
finally:
    a.check_password_hash = _real_check

samples = {"known": [], "unknown": [], "closed": []}
for i in range(5):
    for kind, user in (("known", "ZZHS-KNOWN"), ("unknown", "ZZHS-NOBODY-T%d" % i), ("closed", "ZZHS-CLOSED")):
        c = new_client()
        t0 = time.perf_counter()
        sign_in(c, user, "wrong-%d" % i)
        samples[kind].append(time.perf_counter() - t0)
med = {k: statistics.median(v) for k, v in samples.items()}
s.note("median seconds: %s" % {k: round(v, 3) for k, v in med.items()})
s.check("the wrong password takes about as long for an unknown ID as for a known one (%.0f ms against %.0f ms)"
        % (med["unknown"] * 1000, med["known"] * 1000), med["unknown"] > 0.5 * med["known"])
s.check("...and for a closed account (%.0f ms)" % (med["closed"] * 1000), 0.5 * med["known"] < med["closed"] < 2 * med["known"])
run("DELETE FROM login_attempts WHERE username LIKE 'ZZHS%'")

s.section("2-11: ID cap, index, pruning")
long_id = "ZZHS-" + "x" * 5000
sign_in(new_client(), long_id)
stored = rows("SELECT username FROM login_attempts WHERE username LIKE 'ZZHS-xxxx%'")
s.check("a 5,005-character ID is stored at most %d characters" % ID_MAX,
        len(stored) == 1 and len(stored[0][0]) <= ID_MAX, [len(r[0]) for r in stored])
chk("login_attempts has an index on (username, ts)", lambda: any(
    [c[2] for c in rows("PRAGMA index_info(%s)" % ix[1])] == ["username", "ts"]
    for ix in rows("PRAGMA index_list(login_attempts)")))
chk("the index query plan uses it for the lock's count", lambda: "USING INDEX" in " ".join(
    str(tuple(r)) for r in rows("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM login_attempts WHERE username=? AND device IS ? "
                                 "AND ts > datetime('now','-15 minutes')", ("x", None))).upper())
run("INSERT INTO login_attempts(username, ip, ts) VALUES ('ZZHS-OLD', 'x', datetime('now','-2 days'))")
run("INSERT INTO login_attempts(username, ip, ts) VALUES ('ZZHS-NEW', 'x', datetime('now','-2 hours'))")
a.LOGIN_PRUNE_ODDS = 10 ** 9
try:
    sign_in(new_client(), "ZZHS-NOBODY-P1", "nope")
    s.check("with the odds at one in a billion a failed attempt deletes nothing old",
            one("SELECT COUNT(*) FROM login_attempts WHERE username='ZZHS-OLD'") == 1)
    a.LOGIN_PRUNE_ODDS = 1
    sign_in(new_client(), "ZZHS-NOBODY-P2", "nope")
    s.check("on the pruning turn a failed attempt deletes the rows over a day old",
            one("SELECT COUNT(*) FROM login_attempts WHERE username='ZZHS-OLD'") == 0)
    s.check("...and keeps the recent ones", one("SELECT COUNT(*) FROM login_attempts WHERE username='ZZHS-NEW'") == 1)
finally:
    a.LOGIN_PRUNE_ODDS = _ODDS
run("DELETE FROM login_attempts WHERE username LIKE 'ZZHS%'")
s.check("the real odds are a small fraction (1 in %d)" % _ODDS, _ODDS >= 20)

# =================================================================================================================
# 2. Sign out (2-04, 2-14, 3-07)
# =================================================================================================================
s.section("2-04: Sign out ends the session on the server")
c1 = new_client()
r = sign_in(c1, "ZZHS-U")
s.check("signed in", r.status_code == 302 and alive(c1))
copy = session_cookie(c1)
with c1.session_transaction() as ss_:
    sid1 = ss_.get("sid")
chk("the signed cookie holds a random session id", lambda: bool(sid1) and len(sid1) >= 16)
replay = cookie_client(copy)
s.check("a copy of the cookie works before Sign out", alive(replay))
r = c1.post("/logout", data={"csrf_token": token(c1)})
s.check("Sign out (a POST with the token) goes to sign-in", r.status_code == 302 and r.headers["Location"].endswith("/login"))
s.check("...and this browser is signed out", not alive(c1))
rp = cookie_client(copy)
s.check("a copy of the cookie taken before is REFUSED after Sign out", not alive(rp))
s.check("...and a page it opens goes to sign-in, saying it was signed out", (lambda r_: r_.status_code in (302, 401)
        or "/login" in (r_.headers.get("Location") or ""))(cookie_client(copy).get("/account/password")))
chk("the ended id is in ended_sessions, one row", lambda: one("SELECT COUNT(*) FROM ended_sessions WHERE sid=?", (sid1,)) == 1)

s.section("it ends only that session")
d1, d2 = new_client(), new_client()
sign_in(d1, "ZZHS-U")
sign_in(d2, "ZZHS-U")
d1.post("/logout", data={"csrf_token": token(d1)})
s.check("signing out on one device leaves the person's other device signed in", not alive(d1) and alive(d2))

s.section("a password change still ends the other sessions")
p1, p2 = new_client(), new_client()
sign_in(p1, "ZZHS-PWU")
sign_in(p2, "ZZHS-PWU")
post(p1, "/account/password", current=PW, new=NEWPW, confirm=NEWPW)
s.check("the password changed", check_password_hash(pw_hash(PWU), NEWPW))
s.check("...this browser carries on", alive(p1))
s.check("...the other session ended", not alive(p2))
run("UPDATE users SET password_hash=? WHERE id=?", (cheap, PWU))

s.section("a cookie from before the release keeps working")
old = a.app.test_client()
with old.session_transaction() as ss_:
    ss_["user_id"] = U
    ss_["csrf_token"] = "tok"
    ss_["pw"] = a._session_pw_mark(pw_hash(U))        # what a session signed in before this release carries: no id
s.check("a session with no id is signed in", alive(old))
with old.session_transaction() as ss_:
    stamped = ss_.get("sid")
chk("...and its next request stamps an id on it", lambda: bool(stamped))
oc = session_cookie(old)
old.post("/logout", data={"csrf_token": "tok"})
s.check("...so Sign out ends that one too: its copy is refused", not alive(cookie_client(oc)))

s.section("2-14: GET /logout only from this site")
g = new_client()
sign_in(g, "ZZHS-U")
r = g.get("/logout", headers={"Sec-Fetch-Site": "cross-site"})
s.check("a cross-site GET goes to the dashboard and signs nobody out",
        r.status_code == 302 and r.headers["Location"].endswith("/dashboard") and alive(g), r.headers.get("Location"))
r = g.get("/logout", headers={"Sec-Fetch-Site": "same-site"})
s.check("...so does a same-site (another sub-domain) one", r.status_code == 302 and alive(g))
for site in ("same-origin", "none", None):
    g2 = new_client()
    sign_in(g2, "ZZHS-U")
    r = g2.get("/logout", headers={"Sec-Fetch-Site": site} if site else {})
    s.check("a GET with Sec-Fetch-Site %s signs out" % (site or "absent"), r.status_code == 302
            and r.headers["Location"].endswith("/login") and not alive(g2))
g3 = new_client()
sign_in(g3, "ZZHS-U")
r = g3.post("/logout", data={"csrf_token": "wrong"})
s.check("a POST without the right token is refused (400) and signs nobody out", r.status_code == 400 and alive(g3))
r = g3.post("/logout", data={})
s.check("...and with no token at all", r.status_code == 400 and alive(g3))

s.section("Log out from a stale tab goes to sign-in, never to a 400")
st = new_client()
sign_in(st, "ZZHS-U")
st_tok = token(st)
st_copy = session_cookie(st)
st.post("/logout", data={"csrf_token": st_tok})                       # tab A signs out
r = cookie_client(st_copy).post("/logout", data={"csrf_token": st_tok})   # tab B: the old cookie and the old token
s.check("a copy of the cookie signed out elsewhere, Log out with its old token: to sign-in, no 400",
        r.status_code == 302 and r.headers["Location"].endswith("/login"), r.status_code)
r = st.post("/logout", data={"csrf_token": st_tok})                   # the same browser, already signed out
s.check("...and from the browser that already signed out", r.status_code == 302 and r.headers["Location"].endswith("/login"), r.status_code)
r = new_client().post("/logout", data={"csrf_token": "tok"})
s.check("...and with no session at all", r.status_code == 302 and r.headers["Location"].endswith("/login"), r.status_code)
_idle = getattr(a, "SESSION_IDLE_MIN", None)
ic = new_client()
sign_in(ic, "ZZHS-U")
with ic.session_transaction() as ss_:
    ss_["seen"] = int(time.time()) - 7200
try:
    a.SESSION_IDLE_MIN = 30
    r = ic.post("/logout", data={"csrf_token": token(ic)})
finally:
    a.SESSION_IDLE_MIN = _idle
s.check("a session ended for being idle, clicking Log out: to sign-in, no 400", r.status_code == 302
        and r.headers["Location"].endswith("/login"), r.status_code)
w1, w2 = new_client(), new_client()
sign_in(w1, "ZZHS-PWU")
sign_in(w2, "ZZHS-PWU")
post(w1, "/account/password", current=PW, new=NEWPW, confirm=NEWPW)
r = w2.post("/logout", data={"csrf_token": token(w2)})
s.check("a session ended by a password change, clicking Log out: to sign-in, no 400", r.status_code == 302
        and r.headers["Location"].endswith("/login"), r.status_code)
run("UPDATE users SET password_hash=?, pw_set_at=NULL WHERE id=?", (cheap, PWU))
ws = new_client()
sign_in(ws, "ZZHS-U")
r = ws.post("/logout", data={"csrf_token": "stale-or-wrong"})
s.check("but a signed-in session with a wrong token is still a 400, and stays signed in", r.status_code == 400 and alive(ws))

s.section("every persona can sign out by POST")
for who, uid in (("an employee", V), ("the super admin", SU["id"]), ("a BG admin", BGA["id"] if BGA else None)):
    if uid is None:
        continue
    if who == "an employee":
        c = new_client()
        sign_in(c, "ZZHS-V")
    else:
        c = H.client_as(a, uid)
        alive(c)   # the first request stamps its id, as any real session's does
    r = c.post("/logout", data={"csrf_token": token(c)})
    s.check("%s: POST /logout signs out" % who, r.status_code == 302 and r.headers["Location"].endswith("/login") and not alive(c),
            r.status_code)

s.section("the Log out buttons")
src_t = {}
for fn in os.listdir(os.path.join(H.HARNESS, "templates")):
    if fn.endswith(".html"):
        src_t[fn] = open(os.path.join(H.HARNESS, "templates", fn), encoding="utf-8").read()
hits = [(fn, m.start()) for fn, t in src_t.items() for m in re.finditer(r"url_for\(\s*['\"]logout['\"]", t)]
# the one deliberate exception (Chris, 2026-11-02, the inactivity box): base.html hands the idle script the sign-out address as
# data-logout, for the page's own same-origin GET /logout?why=idle at the hour (the server allows a GET only from the same
# origin). It is not a link anyone can click, and the script is held below to use nothing else.
idle_hits = [h for h in hits if src_t[h[0]][max(0, h[1] - 16):h[1]] == 'data-logout="{{ ']
s.check("the inactivity script's data-logout is the only non-form reference, once, on its own script tag",
        len(idle_hits) == 1 and idle_hits[0][0] == "base.html" and
        "session_alive.js" in src_t["base.html"][max(0, idle_hits[0][1] - 400):idle_hits[0][1]])
hits = [h for h in hits if h not in idle_hits]
only_forms = all(re.search(r"action=\"\{\{\s*url_for\(\s*['\"]logout['\"]", src_t[fn][max(0, i - 40):i + 40]) for fn, i in hits)
s.check("every template reference to the logout address is a form's action (%d of them): none is a link" % len(hits),
        len(hits) >= 2 and only_forms, hits)
js_all = " ".join(open(os.path.join(H.HARNESS, "static", f), encoding="utf-8").read() for f in os.listdir(os.path.join(H.HARNESS, "static"))
                  if f.endswith(".js"))
s.check("no script links to /logout", "/logout" not in js_all)
for who, uid in (("an employee", V), ("the super admin", SU["id"])):
    c = H.client_as(a, uid)
    page = c.get("/dashboard" if who == "an employee" else "/admin").get_data(as_text=True)
    m = re.search(r'<form method="post" action="/logout"[^>]*>(.*?)</form>', page, re.S)
    s.check("%s's account menu: Log out is a POST form with the token and a button" % who, bool(m)
            and 'name="csrf_token"' in m.group(1) and '<button type="submit" class="logout"' in m.group(1)
            and 'href="/logout"' not in page, page[:80] if not m else "")
css = open(os.path.join(H.HARNESS, "static", "style.css"), encoding="utf-8").read()
s.check("the button is drawn as the menu row the link was (same padding, radius, colour, hover)",
        all(x in css for x in (".acct-menu button.logout", "padding: 9px 12px", H.cv("color: #c0392b"), ".acct-menu button.logout:hover",
                               H.cv("background: #f9e6e6"))))

s.section("pruning: kept 32 days")
chk("a row over 32 days old goes on the next Sign out, a younger one stays", lambda: (
    run("INSERT INTO ended_sessions(sid, ended_at) VALUES ('zzhs-old', datetime('now','-40 days'))"),
    run("INSERT INTO ended_sessions(sid, ended_at) VALUES ('zzhs-young', datetime('now','-10 days'))"),
    (lambda c_: (sign_in(c_, "ZZHS-U"), c_.post("/logout", data={"csrf_token": token(c_)})))(new_client()),
    one("SELECT COUNT(*) FROM ended_sessions WHERE sid='zzhs-old'") == 0
    and one("SELECT COUNT(*) FROM ended_sessions WHERE sid='zzhs-young'") == 1)[-1])
run("DELETE FROM ended_sessions WHERE sid LIKE 'zzhs-%'") if _start_ended is not None else None

# =================================================================================================================
# 3. Reset links (2-05, 2-06), the password writers (2-09), one rule (2-08)
# =================================================================================================================
s.section("2-05: a new link no longer closes the earlier ones")


def issue(uid):
    with a.app.app_context():
        link = a._issue_reset_link(a.get_db(), uid)
    return link.rsplit("/reset/", 1)[1] if link else None


def link_ok(tok):
    page = new_client().get("/reset/" + tok).get_data(as_text=True)
    return 'name="new"' in page


run("DELETE FROM password_resets WHERE user_id=?", (V,))
t1, t2 = issue(V), issue(V)
s.check("two links in the hour: both are unused rows", one("SELECT COUNT(*) FROM password_resets WHERE user_id=? AND used_at IS NULL", (V,)) == 2)
s.check("...and the first still opens", link_ok(t1))
s.check("...as does the second", link_ok(t2))
t3, t4 = issue(V), issue(V)
s.check("the hourly cap still holds: the 4th is None", t3 and t4 is None)
run("DELETE FROM password_resets WHERE user_id=?", (V,))

s.section("2-06: a link dies with any new password, and with a closed account")
for why in ("own change", "admin reset"):
    run("DELETE FROM password_resets WHERE user_id=?", (V,))
    tok = issue(V)
    s.check("%s: a fresh link opens" % why, link_ok(tok))
    with a.app.test_request_context("/"):
        dbx = a.get_db()
        if why == "own change":
            vrow = dbx.execute("SELECT * FROM users WHERE id=?", (V,)).fetchone()
            err = a._password_change(dbx, vrow, PW, NEWPW, NEWPW)
        else:
            sup = dbx.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
            ok_, err = a._admin_password_set(dbx, sup, V, NEWPW)
            err = None if ok_ else err
    s.check("%s: the password changed" % why, err is None and check_password_hash(pw_hash(V), NEWPW), err)
    s.check("%s: the unused link rows are gone" % why, one("SELECT COUNT(*) FROM password_resets WHERE user_id=? AND used_at IS NULL", (V,)) == 0)
    s.check("%s: the old link shows the expired page" % why, not link_ok(tok))
    run("UPDATE users SET password_hash=?, pw_set_at=NULL WHERE id=?", (cheap, V))
# a writer that does not delete rows (the password import) is caught by pw_set_at being later than the link
run("DELETE FROM password_resets WHERE user_id=?", (V,))
tok = issue(V)
run("UPDATE password_resets SET created_at=datetime('now','-5 minutes') WHERE user_id=?", (V,))
s.check("a link five minutes old opens", link_ok(tok))
run("UPDATE users SET pw_set_at=datetime('now','-10 minutes') WHERE id=?", (V,))
s.check("...and with pw_set_at BEFORE the link it still opens", link_ok(tok))
run("UPDATE users SET pw_set_at=datetime('now') WHERE id=?", (V,))
s.check("...but once a password was written after the link was made, it is refused", not link_ok(tok))
before = pw_hash(V)
rr = new_client().post("/reset/" + tok, data={"new": NEWPW, "confirm": NEWPW, "csrf_token": "tok"})
s.check("...and a POST to it changes nothing", pw_hash(V) == before)
run("UPDATE users SET pw_set_at=NULL WHERE id=?", (V,))
s.check("...with pw_set_at cleared it opens again (the check is that column)", link_ok(tok))
run("UPDATE users SET left_at='2026-01-01' WHERE id=?", (V,))
s.check("a closed account's link shows the expired page", not link_ok(tok))
before = pw_hash(V)
new_client().post("/reset/" + tok, data={"new": NEWPW, "confirm": NEWPW, "csrf_token": "tok"})
s.check("...and setting a password through it does nothing", pw_hash(V) == before)
run("UPDATE users SET left_at=NULL WHERE id=?", (V,))
s.check("reopened, the same link works again", link_ok(tok))
run("DELETE FROM password_resets WHERE user_id=?", (V,))
run("INSERT INTO password_resets(token_hash, user_id, used_at) VALUES (?,?,datetime('now'))", ("zzhs-used", V))
with a.app.test_request_context("/"):
    dbx = a.get_db()
    a._password_change(dbx, dbx.execute("SELECT * FROM users WHERE id=?", (V,)).fetchone(), PW, NEWPW, NEWPW)
s.check("a USED link row is kept (the hourly cap counts it)", one("SELECT COUNT(*) FROM password_resets WHERE token_hash='zzhs-used'") == 1)
run("DELETE FROM password_resets WHERE user_id=?", (V,))
run("UPDATE users SET password_hash=?, pw_set_at=NULL WHERE id=?", (cheap, V))

s.section("2-09: the BG-admin, sub-admin and L&D-admin reset writers")
SUP = H.client_as(a, SU["id"])
alive(SUP)
for label, path, aid, kw in (("BG admin", "/admin/bg-admins", BGADM, {}), ("sub-admin", "/admin/subadmins", SUBADM, {"bg": BG})):
    run("DELETE FROM password_resets WHERE user_id=?", (aid,))
    tok = issue(aid)
    run("INSERT INTO password_resets(token_hash, user_id) VALUES ('zzhs-x-%s', ?)" % aid, (aid,))
    before = pw_hash(aid)
    post(SUP, path, action="reset_pw", admin_id=str(aid), new_password="short7!", **kw)
    s.check("%s: a 7-character password is refused (the rule is 8 now)" % label, pw_hash(aid) == before)
    post(SUP, path, action="reset_pw", admin_id=str(aid), new_password=NEWPW, **kw)
    s.check("%s: an 8+ character password is set" % label, check_password_hash(pw_hash(aid), NEWPW))
    row = rows("SELECT pw_source, pw_set_at FROM users WHERE id=?", (aid,))[0]
    s.check("%s: recorded as set by an admin, with the time" % label, row[0] == "admin" and row[1], tuple(row))
    s.check("%s: its unused reset links are gone" % label,
            one("SELECT COUNT(*) FROM password_resets WHERE user_id=? AND used_at IS NULL", (aid,)) == 0)
    s.check("%s: on the Audit log against the account, the super admin as the actor, no password in it" % label,
            len(rows("SELECT 1 FROM activity_log WHERE action='reset_pw' AND target_user_id=? AND user_id=? AND detail LIKE ? AND "
                     "detail NOT LIKE ?", (aid, SU["id"], "%password reset%", "%" + NEWPW + "%"))) == 1)
    run("UPDATE users SET password_hash=?, pw_source=NULL, pw_set_at=NULL WHERE id=?", (cheap, aid))
# a system admin's account is changed by a system admin only
before = pw_hash(SYSADM)
post(SUP, "/admin/bg-admins", action="reset_pw", admin_id=str(SYSADM), new_password=NEWPW)
s.check("a super admin who is not a system admin can't reset a system admin's password", pw_hash(SYSADM) == before)
# a reset through People still works
with a.app.test_request_context("/"):
    dbx = a.get_db()
    sup = dbx.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
    ok_, msg = a._admin_password_set(dbx, sup, V, "1234567")
    s.check("People's Reset: 7 characters is refused, saying why", not ok_ and "at least 8" in msg, msg)
    ok_, msg = a._admin_password_set(dbx, sup, V, "ZZHS-V")
    s.check("...so is the Employee ID itself", not ok_, msg)
    ok_, msg = a._admin_password_set(dbx, sup, V, "plum-v57")
    s.check("...8 characters is set", ok_, msg)
run("UPDATE users SET password_hash=?, pw_source=NULL, pw_set_at=NULL WHERE id=?", (cheap, V))

s.section("2-08: one rule, everywhere")
pp = getattr(a, "_password_problem", None)
chk("it exists", lambda: callable(pp))
chk("under 8 characters", lambda: pp("1234567", "ZZHS-X") and "at least 8" in pp("1234567", "ZZHS-X"))
chk("8 characters is fine", lambda: pp("plum-v57", "ZZHS-X") is None)
chk("128 characters is fine", lambda: pp(LONG128, "ZZHS-X") is None)
chk("129 characters is refused", lambda: pp("a" * 129, "ZZHS-X") and "at most 128" in pp("a" * 129, "ZZHS-X"))
chk("an Employee ID, as typed or in other case, is refused", lambda: pp("ZZHS-LONGID", "ZZHS-LONGID") and pp("zzhs-longid", "ZZHS-LONGID"))
chk("no complexity rule: all lower-case letters pass", lambda: pp("plumtree", "ZZHS-X") is None)
chk("with no ID given only the lengths are checked", lambda: pp("plum-v57") is None)

U_LONG = "ZZHS-LONGID"
LONGID = None
with a.app.test_request_context("/"):
    dbx = a.get_db()
    LONGID = dbx.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id) VALUES (?,?,?,?,?)",
                         (U_LONG, "ZZHS long", cheap, "user", U_LONG)).lastrowid
    dbx.commit()
pc = new_client()
sign_in(pc, U_LONG)
for what, new, wants in (("its Employee ID", U_LONG, "Employee ID"), ("129 characters", "x" * 129, "at most 128"), ("7 characters", "1234567", "at least 8")):
    before = pw_hash(LONGID)
    post(pc, "/account/password", current=PW, new=new, confirm=new)
    s.check("Change password refuses %s" % what, pw_hash(LONGID) == before)
r = post(pc, "/account/password", current=PW, new=U_LONG, confirm=U_LONG)
chk("...and says why", lambda: "Employee ID" in r.get_data(as_text=True))
post(pc, "/account/password", current=PW, new=LONG128, confirm=LONG128)
s.check("...but 128 characters is accepted", check_password_hash(pw_hash(LONGID), LONG128))
run("UPDATE users SET password_hash=? WHERE id=?", (cheap, LONGID))
# the reset link applies it too
run("DELETE FROM password_resets WHERE user_id=?", (LONGID,))
tok = issue(LONGID)
before = pw_hash(LONGID)
new_client().post("/reset/" + tok, data={"new": U_LONG, "confirm": U_LONG, "csrf_token": "tok"})
s.check("a reset link refuses the Employee ID", pw_hash(LONGID) == before and link_ok(tok))
new_client().post("/reset/" + tok, data={"new": "y" * 200000, "confirm": "y" * 200000, "csrf_token": "tok"})
s.check("...and 200,000 characters", pw_hash(LONGID) == before)
new_client().post("/reset/" + tok, data={"new": LONG128B, "confirm": LONG128B, "csrf_token": "tok"})
s.check("...and takes a good one", check_password_hash(pw_hash(LONGID), LONG128B))
# creating an admin account follows the rule too
before_n = one("SELECT COUNT(*) FROM users WHERE username LIKE 'zzhs-new%'")
post(SUP, "/admin/bg-admins", action="create", username="zzhs-new1", password="1234567", business_group=BG)
s.check("Add a BG admin with 7 characters is refused", one("SELECT COUNT(*) FROM users WHERE username='zzhs-new1'") == 0)
post(SUP, "/admin/bg-admins", action="create", username="zzhs-new2", password="zzhs-new2", business_group=BG)
s.check("...and with the account's own username as the password", one("SELECT COUNT(*) FROM users WHERE username='zzhs-new2'") == 0)
run("DELETE FROM users WHERE username LIKE 'zzhs-new%'")
run("DELETE FROM users WHERE id=?", (LONGID,))

s.section("2-10: a lock that trips is on the Audit log, once an hour")
lc = None
for i in range(a.LOGIN_MAX_FAILS - 1):
    sign_in(new_client(), "ZZHS-LOCK", "wrong-%d" % i)
n_lock = lambda uid: one("SELECT COUNT(*) FROM activity_log WHERE action='login_locked' AND target_user_id=?", (uid,))  # noqa: E731
s.check("%d failures: not locked yet, no row" % (a.LOGIN_MAX_FAILS - 1), n_lock(LOCKME) == 0)
sign_in(new_client(), "ZZHS-LOCK", "wrong-last")
s.check("the failure that trips the lock writes ONE row, against the account", n_lock(LOCKME) == 1, n_lock(LOCKME))
row = rows("SELECT user_id, detail FROM activity_log WHERE action='login_locked' AND target_user_id=?", (LOCKME,))
s.check("...nobody signed in as actor, no password, address or typed ID in it", row and row[0][0] is None
        and "wrong" not in row[0][1] and "127.0.0.1" not in row[0][1] and "ZZHS" not in row[0][1], tuple(row[0]) if row else None)
sign_in(new_client(), "ZZHS-LOCK", "wrong-again")
s.check("more attempts while locked add nothing", n_lock(LOCKME) == 1)
run("DELETE FROM login_attempts WHERE username='ZZHS-LOCK'")
for i in range(a.LOGIN_MAX_FAILS):
    sign_in(new_client(), "ZZHS-LOCK", "wrong-%d" % i)
s.check("locked again within the hour (after a reset cleared it): still ONE row (de-duplicated per account)", n_lock(LOCKME) == 1)
run("UPDATE activity_log SET created_at=datetime('now','-2 hours') WHERE action='login_locked' AND target_user_id=?", (LOCKME,))
run("DELETE FROM login_attempts WHERE username='ZZHS-LOCK'")
for i in range(a.LOGIN_MAX_FAILS):
    sign_in(new_client(), "ZZHS-LOCK", "wrong-%d" % i)
s.check("...an hour later it writes another", n_lock(LOCKME) == 2)
n0 = one("SELECT COUNT(*) FROM activity_log WHERE action='login_locked'")
for i in range(a.LOGIN_MAX_FAILS + 2):
    sign_in(new_client(), "ZZHS-NOBODY-L", "wrong-%d" % i)
s.check("an Employee ID with no account that is sprayed writes nothing (no flood)",
        one("SELECT COUNT(*) FROM activity_log WHERE action='login_locked'") == n0)
page = H.client_as(a, SU["id"]).get("/admin/audit-log").get_data(as_text=True)
chk("the super admin's Audit log lists it, as words, with nobody signed in", lambda: "Sign-in locked (too many wrong passwords)" in page
    and "Nobody signed in" in page)
chk("...and the Action filter offers the label", lambda: page.count("Sign-in locked (too many wrong passwords)") >= 2)
chk("...filtering on it shows the row", lambda: "ZZHS-LOCK" in H.client_as(a, SU["id"]).get(
    "/admin/audit-log?faction=Sign-in+locked+%28too+many+wrong+passwords%29").get_data(as_text=True))
run("DELETE FROM login_attempts WHERE username LIKE 'ZZHS%'")

s.section("2-10: wrong current passwords on Change password are capped")
cc = new_client()
sign_in(cc, "ZZHS-PWU")
msgs = [post(cc, "/account/password", current="not-it-%d" % i, new=NEWPW, confirm=NEWPW).get_data(as_text=True)
        for i in range(PW_FAILS + 1)]
chk("%d wrong current passwords say it's incorrect" % PW_FAILS, lambda: all(
    "current password is incorrect" in m for m in msgs[:PW_FAILS]))
chk("...the next one says to wait", lambda: "Too many wrong current passwords" in msgs[PW_FAILS])
before = pw_hash(PWU)
post(cc, "/account/password", current=PW, new=NEWPW, confirm=NEWPW)
s.check("...and now even the RIGHT current password changes nothing", pw_hash(PWU) == before)
s.check("another person's page isn't affected", (lambda c_: (sign_in(c_, "ZZHS-U"), post(c_, "/account/password", current="nope", new=NEWPW,
        confirm=NEWPW).get_data(as_text=True))[1])(new_client()).count("current password is incorrect") == 1)
chk("the count is under a key no Employee ID can be, and the sign-in lock isn't touched", lambda: one(
    "SELECT COUNT(*) FROM login_attempts WHERE username='ZZHS-PWU'") == 0)
run("DELETE FROM login_attempts WHERE username LIKE 'pwchg:ZZHS%' OR username LIKE 'ZZHS%'")
post(cc, "/account/password", current=PW, new=NEWPW, confirm=NEWPW)
s.check("after the window it works", check_password_hash(pw_hash(PWU), NEWPW))
run("UPDATE users SET password_hash=?, pw_set_at=NULL WHERE id=?", (cheap, PWU))

# =================================================================================================================
# 6. The demo gate (2-01)
# =================================================================================================================
s.section("2-01: demo rows don't sign in where there are no demo accounts")
with a.app.test_request_context("/"):
    dbx = a.get_db()
    for eid, demo in (("STGHS-DEMO", 1), ("ZZ12345HS", 0), ("ZZHSDEMO-A", 0), ("ZZHSFLAG-B", 1)):
        dbx.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, is_demo) VALUES (?,?,?,?,?,?)",
                    (eid, eid, cheap, "user", eid, demo))
    dbx.commit()
try:
    os.environ["L360_DEMO_ACCOUNTS"] = "0"
    for eid in ("STGHS-DEMO", "ZZHSFLAG-B"):
        c = new_client()
        r = sign_in(c, eid)
        body = r.get_data(as_text=True)
        s.check("%s (is_demo=1), flag off: refused with the same 'don't match' reply" % eid, r.status_code == 200
                and not alive(c) and "That Employee ID and password don&#39;t match" in body.replace("'", "&#39;"), r.status_code)
    s.check("...and it counted as a failed attempt", one("SELECT COUNT(*) FROM login_attempts WHERE username='STGHS-DEMO'") == 1)
    wrong = sign_in(new_client(), "ZZHS-U", "wrong").get_data(as_text=True)
    refused = sign_in(new_client(), "STGHS-DEMO").get_data(as_text=True)
    strip = lambda t: re.sub(r'value="[^"]*"|csrf-token" content="[^"]*"', "", t)  # noqa: E731
    s.check("...identical to a wrong password's page apart from what was typed", strip(wrong) == strip(refused))
    for eid in ("ZZ12345HS", "ZZHSDEMO-A"):
        c = new_client()
        sign_in(c, eid)
        s.check("%s (is_demo=0): signs in, whatever its prefix, with the flag off" % eid, alive(c))
    os.environ["L360_DEMO_ACCOUNTS"] = "1"
    c = new_client()
    sign_in(c, "STGHS-DEMO")
    s.check("with the flag on an is_demo account signs in (staging and the suites)", alive(c))
finally:
    if _DEMO_ENV is None:
        os.environ.pop("L360_DEMO_ACCOUNTS", None)
    else:
        os.environ["L360_DEMO_ACCOUNTS"] = _DEMO_ENV
run("DELETE FROM users WHERE username IN ('STGHS-DEMO','ZZ12345HS','ZZHSDEMO-A','ZZHSFLAG-B')")
run("DELETE FROM login_attempts WHERE username LIKE '%HS%'")

# =================================================================================================================
# 7. The known-device cookie (2-13)
# =================================================================================================================
s.section("2-13: the cookie holds a random id only")
dc = new_client()
sign_in(dc, "ZZHS-U")
ck = dc.get_cookie(a.DEVICE_COOKIE)
payload = a._device_signer().loads(ck.value) if ck else {}
s.check("the cookie's signed payload is the device id and nothing else", list(payload) == ["d"] and re.fullmatch(r"[0-9a-f]{32}", payload.get("d", "")), payload)
s.check("...no Employee ID anywhere in the cookie, signed or readable", "ZZHS" not in (ck.value if ck else "")
        and "ZZHS" not in repr(payload))
chk("the server table says who signed in on that device", lambda: one("SELECT COUNT(*) FROM known_devices WHERE device=? AND username='ZZHS-U'", (payload["d"],)) == 1)
sign_in(dc, "ZZHS-V")
chk("a second person on the same browser is a second row under the same id", lambda: one(
    "SELECT COUNT(*) FROM known_devices WHERE device=?", (payload["d"],)) == 2)
# the lock rule is unchanged: this browser's own attempts are counted apart
sign_in(dc, "ZZHS-U", "typo")
chk("this browser's typos are counted under its device id", lambda: one(
    "SELECT COUNT(*) FROM login_attempts WHERE username='ZZHS-U' AND device=?", (payload["d"],)) == 1)
sign_in(new_client(), "ZZHS-U", "typo")
s.check("...another browser's apart, with no device", one("SELECT COUNT(*) FROM login_attempts WHERE username='ZZHS-U' AND device IS NULL") == 1)
# a cookie from before carried the usernames: its id is read, its list is not trusted
oldck = a._device_signer().dumps({"d": "f" * 32, "u": ["ZZHS-V", "ZZHS-U"]})
oc2 = a.app.test_client()
oc2.set_cookie(a.DEVICE_COOKIE, oldck)
sign_in(oc2, "ZZHS-V", "typo")
s.check("an old-style cookie counts as a new browser once: its list is ignored, so the typo has no device",
        one("SELECT COUNT(*) FROM login_attempts WHERE username='ZZHS-V' AND device IS NULL") == 1)
sign_in(oc2, "ZZHS-V")
newck = a._device_signer().loads(oc2.get_cookie(a.DEVICE_COOKIE).value)
s.check("...after its next good sign-in the cookie is the new shape, with the same id", newck == {"d": "f" * 32}, newck)
run("DELETE FROM login_attempts WHERE username LIKE 'ZZHS%'")

# =================================================================================================================
_cleanup()
sys.exit(s.done())
