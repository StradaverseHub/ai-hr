"""Two sign-in gaps closed before the production rollout (2026-10-15, from the handoff review).

1. "Forgot password" told anyone whether an Employee ID and work email pair exists ("don't match our records"). It now
   gives one answer whatever was entered -- a match, a wrong email, an unknown ID, a closed account, no email on file,
   the hourly cap and a failed send all read the same -- and the email goes from a background thread so the time the
   page takes gives nothing away either. Only a server with no email at all says so, the same for everyone.
2. The sign-in lockout was per username, so anyone knowing a colleague's Employee ID could lock them out. A browser
   that has signed in as a username now carries a signed known-device cookie, and its attempts are counted apart:
   failures elsewhere lock out every other browser (guessing stays capped) but never the person's own.

Synthetic (ZZLS-*) on the shared suite database; everything is put back at the end.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from werkzeug.security import generate_password_hash  # noqa: E402

a = H.setup()
s = H.Suite("Sign-in security -- Forgot password gives one answer; a lockout can't shut someone out of their own browser")

PW = "Right-pass-1"
RESET_PW = "Reset-pass-fresh-5"   # a link refuses the current password (the last 5 passwords, 2026-10-31)
DEV = a.DEVICE_COOKIE


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZLS-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM password_resets WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM login_attempts WHERE username LIKE 'ZZLS-%'")
    db.execute("DELETE FROM known_devices WHERE username LIKE 'ZZLS-%'")
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

    ME = mk("ZZLS-MATCH", email="zzls-match@example.invalid")
    mk("ZZLS-LEFT", email="zzls-left@example.invalid", left_at="2026-01-01")
    mk("ZZLS-NOMAIL")
    VIC = mk("ZZLS-VICTIM", email="zzls-victim@example.invalid")
    mk("ZZLS-OTHER")
    for i in range(1, 7):
        mk("ZZLS-U%d" % i)
    db.commit()


def resets(uid):
    return H.one(a, "SELECT COUNT(*) FROM password_resets WHERE user_id=?", (uid,))


# =================================================================================================================
# 1. Forgot password
# =================================================================================================================
_prod, _cfg, _send, _async = a._PROD, a.mailer.is_configured, a.mailer.send_mail, a.RESET_MAIL_ASYNC
fc = a.app.test_client()


def ask(eid, email):
    with fc.session_transaction() as ss_:
        ss_["csrf_token"] = "tok"
    return fc.post("/forgot", data={"username": eid, "email": email, "csrf_token": "tok"}).get_data(as_text=True)


try:
    a._PROD, a.RESET_MAIL_ASYNC = True, False
    a.mailer.is_configured = lambda: True
    sent = []
    a.mailer.send_mail = lambda to, *a_, **k_: sent.append(to)

    match = ask("ZZLS-MATCH", "ZZLS-match@example.invalid ")     # case and spaces don't matter
    s.check("a match: one email, to the address on file", sent == ["zzls-match@example.invalid"], sent)
    s.check("...and one reset link", resets(ME) == 1)
    del sent[:]
    others = {
        "a wrong email": ask("ZZLS-MATCH", "someone-else@example.invalid"),
        "an unknown Employee ID": ask("ZZLS-NOBODY", "zzls-match@example.invalid"),
        "a closed account": ask("ZZLS-LEFT", "zzls-left@example.invalid"),
        "an account with no email on file": ask("ZZLS-NOMAIL", "anything@example.invalid"),
    }
    s.check("...and none of the others sent anything", sent == [], sent)
    for what, body in others.items():
        s.check("%s reads exactly as a match does" % what, body == match)
    s.check("the one answer never says whether they matched",
            "we'll email" in match and "match an active account" in match and "don't match" not in match)

    # the hourly cap: a 4th request in the hour sends nothing, and reads the same
    for _ in range(a.RESET_MAX_PER_HOUR - 1):
        ask("ZZLS-MATCH", "zzls-match@example.invalid")
    del sent[:]
    capped = ask("ZZLS-MATCH", "zzls-match@example.invalid")
    s.check("over the hourly cap: nothing sent", sent == [], sent)
    s.check("...and it reads as a match does", capped == match)

    # a failed send: logged, never shown
    with a.app.test_request_context("/"):
        a.get_db().execute("DELETE FROM password_resets WHERE user_id=?", (ME,))
        a.get_db().commit()

    def boom(*_a, **_k):
        raise RuntimeError("graph down")
    a.mailer.send_mail = boom
    failed = ask("ZZLS-MATCH", "zzls-match@example.invalid")
    s.check("a failed send reads as a match does", failed == match)
    s.check("...and the failure is in the activity log",
            H.one(a, "SELECT COUNT(*) FROM activity_log WHERE user_id IS NULL AND target_user_id=? AND "
                     "action='password_reset' AND detail='reset email failed to send'", (ME,)) == 1)

    # the email goes in the background: a slow send doesn't slow the page
    with a.app.test_request_context("/"):
        a.get_db().execute("DELETE FROM password_resets WHERE user_id=?", (ME,))
        a.get_db().commit()
    slow = []

    def slow_send(to, *a_, **k_):
        time.sleep(0.6)
        slow.append(to)
    a.mailer.send_mail, a.RESET_MAIL_ASYNC = slow_send, True
    t0 = time.time()
    ask("ZZLS-MATCH", "zzls-match@example.invalid")
    took = time.time() - t0
    s.check("a match answers without waiting for the email (%.2fs, the send takes 0.6s)" % took, took < 0.45)
    for _ in range(40):
        if slow:
            break
        time.sleep(0.05)
    s.check("...and the email still goes", slow == ["zzls-match@example.invalid"], slow)
    a.RESET_MAIL_ASYNC = False

    # no email on the server at all: the same for everyone, and no form
    a.mailer.is_configured = lambda: False
    page = fc.get("/forgot").get_data(as_text=True)
    s.check("no email on the server: the page says reset by email isn't available, and offers no form",
            "isn't available on OneHR just now" in page and 'name="email"' not in page)
    b1, b2 = ask("ZZLS-MATCH", "zzls-match@example.invalid"), ask("ZZLS-NOBODY", "x@example.invalid")
    s.check("...a post says the same, match or not", b1 == b2 and "isn't available on OneHR just now" in b1)
finally:
    a._PROD, a.mailer.is_configured, a.mailer.send_mail, a.RESET_MAIL_ASYNC = _prod, _cfg, _send, _async

tpl = open(os.path.join(os.path.dirname(a.__file__), "templates", "forgot_password.html")).read()
s.check("the template has no 'don't match our records' answer left", "match our records" not in tpl)

# =================================================================================================================
# 2. The lockout
# =================================================================================================================
N = a.LOGIN_MAX_FAILS


def browser():
    return a.app.test_client()


def sign_in(c, user, pw):
    """(signed in?, locked out?)"""
    with c.session_transaction() as ss_:
        ss_["csrf_token"] = "tok"
    r = c.post("/login", data={"username": user, "password": pw, "csrf_token": "tok"})
    body = r.get_data(as_text=True)
    with c.session_transaction() as ss_:
        ok = r.status_code == 302 and ss_.get("user_id") is not None
        ss_.clear()   # signed back out; the device cookie stays, as on logout
    return ok, "Too many failed attempts" in body


def fails(user, dev):
    return H.one(a, "SELECT COUNT(*) FROM login_attempts WHERE username=? AND device IS ?", (user, dev))


victim, attacker = browser(), browser()
ok, _ = sign_in(victim, "ZZLS-VICTIM", PW)
ck = victim.get_cookie(DEV)
s.check("a good sign-in leaves a known-device cookie", ok and ck is not None)
s.check("...HttpOnly, SameSite=Lax", ck is not None and ck.http_only and (ck.same_site or "").lower() == "lax")
vdev = a._device_signer().loads(ck.value)["d"] if ck else None

for _ in range(N):
    sign_in(attacker, "ZZLS-VICTIM", "wrong-guess")
ok_a, locked_a = sign_in(attacker, "ZZLS-VICTIM", PW)
s.check("%d failures from another browser lock that browser out -- even with the right password" % N,
        not ok_a and locked_a)
ok_n, locked_n = sign_in(browser(), "ZZLS-VICTIM", PW)
s.check("...and every other browser without the cookie (the guessing stays capped)", not ok_n and locked_n)
ok_v, locked_v = sign_in(victim, "ZZLS-VICTIM", PW)
s.check("the person's own browser still signs in", ok_v and not locked_v)

forged = browser()
forged.set_cookie(DEV, ck.value[:-2] + ("AA" if not ck.value.endswith("AA") else "BB"))
s.check("a tampered cookie counts as no cookie: locked out", sign_in(forged, "ZZLS-VICTIM", PW) == (False, True))
other = browser()
sign_in(other, "ZZLS-OTHER", PW)
s.check("a browser known for a DIFFERENT person is still locked out of this one",
        sign_in(other, "ZZLS-VICTIM", PW) == (False, True))

# the person's own browser has its own count: their typos lock it, but never touch the shared count
for _ in range(3):
    sign_in(victim, "ZZLS-VICTIM", "my-typo")
s.check("their own failures are counted against their browser alone", fails("ZZLS-VICTIM", vdev) == 3
        and fails("ZZLS-VICTIM", None) == N)
sign_in(victim, "ZZLS-VICTIM", PW)
s.check("a good sign-in clears only its own browser's count", fails("ZZLS-VICTIM", vdev) == 0
        and fails("ZZLS-VICTIM", None) == N)
for _ in range(N):
    sign_in(victim, "ZZLS-VICTIM", "my-typo")
s.check("%d of their own failures lock their own browser too" % N, sign_in(victim, "ZZLS-VICTIM", PW) == (False, True))

# a reset clears every count
with a.app.test_request_context("/"):
    d = a.get_db()
    raw = "zzls-reset-token"
    d.execute("INSERT INTO password_resets(token_hash, user_id) VALUES (?,?)", (a._hash_token(raw), VIC))
    d.commit()
rc = browser()
with rc.session_transaction() as ss_:
    ss_["csrf_token"] = "tok"
rc.post("/reset/" + raw, data={"new": RESET_PW, "confirm": RESET_PW, "csrf_token": "tok"})
s.check("a password reset clears every count for them",
        fails("ZZLS-VICTIM", vdev) == 0 and fails("ZZLS-VICTIM", None) == 0)
s.check("...so a new browser signs in again", sign_in(browser(), "ZZLS-VICTIM", RESET_PW) == (True, False))

# a shared PC remembers the last five people, newest first
pc = browser()
for i in range(1, 7):
    sign_in(pc, "ZZLS-U%d" % i, PW)
pdev = a._device_signer().loads(pc.get_cookie(DEV).value)
users = [r[0] for r in H.rows(a, "SELECT username FROM known_devices WHERE device=? ORDER BY last_at DESC, rowid DESC", (pdev["d"],))]
s.check("a shared browser remembers the last %d people, newest first (kept on the server, by its device id)" % a.DEVICE_COOKIE_MAX_USERS,
        users == ["ZZLS-U6", "ZZLS-U5", "ZZLS-U4", "ZZLS-U3", "ZZLS-U2"], users)
s.check("...and its cookie holds the device id and no Employee ID (security test 2-13)",
        list(pdev) == ["d"] and "ZZLS" not in pc.get_cookie(DEV).value and "ZZLS" not in repr(pdev))

# on staging and production the cookie is Secure
_p = a._PROD
try:
    a._PROD = True
    sc = browser()
    with sc.session_transaction() as ss_:
        ss_["csrf_token"] = "tok"
    r = sc.post("/login", data={"username": "ZZLS-OTHER", "password": PW, "csrf_token": "tok"})
    hdr = [h for h in r.headers.getlist("Set-Cookie") if h.startswith(DEV + "=")]
    s.check("with L360_PROD the cookie is Secure", bool(hdr) and "Secure" in hdr[0], hdr)
finally:
    a._PROD = _p

with a.app.test_request_context("/"):
    _cleanup(a.get_db())
sys.exit(s.done())
