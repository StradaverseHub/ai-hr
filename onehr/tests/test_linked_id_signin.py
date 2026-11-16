"""Sign in with a linked Employee ID (Chris, 2026-11-03: "Use linked ID").

A person can carry more than one Employee ID: users.username is the one they sign in with, and user_employee_ids holds the
others. Sign-in, Forgot password and sign-in help now take an ACTIVE linked ID too, through ONE helper (_login_account).

What this suite holds:
  * the helper: a sign-in name first (as it always was); else an active linked ID, exact and case-sensitive; never a removed
    link, an admin's or a demo account's
  * /login: a linked ID signs in to its own account; the main ID still does; a removed link, a case variant, a link on an
    admin account and a wrong password are refused with the one message; a link on a closed account says "no longer
    active" only with the right password; the one-hash timing rule holds for a linked ID, a wrong password and no account
  * the lock: failures typed under the linked ID and the main ID count TOGETHER (under the account's own sign-in name), so
    alternating the IDs a person carries can't double their tries; a name that matches no account is still counted as typed;
    a good sign-in by a linked ID clears the account's count
  * Forgot password: a linked ID plus the account's work email sends the link; a wrong email, a removed link, a closed or
    admin account and a case variant send nothing; the page's answer is the same for all of them
  * sign-in help: a linked ID finds the account; the person's notice goes only when the email typed is the one on file; an
    admin's link, a removed link and a case variant find nothing; the answer is the same either way

Every guard here was falsified: the code was broken on purpose, the check failed, the code was put back (see the commit message).
Synthetic (ZZLX-*) on the shared suite database; everything is put back at the end.
"""
import html as _html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from werkzeug.security import generate_password_hash  # noqa: E402

a = H.setup()
s = H.Suite("Linked ID sign-in -- /login, Forgot password and sign-in help take an active linked Employee ID")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

PW = "Linked-pass-1"
cheap = generate_password_hash(PW, method="pbkdf2:sha256:1000")     # the suite signs in many times
MAIL = "zzlx-main@zzlx.invalid"
NOMATCH = "That Employee ID and password don't match."
CLOSED_MSG = "This account is no longer active."
LOCKED = "Too many failed attempts"
U = {}


def dbx(sql, *args):
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute(sql, args)
        d_.commit()


def one(sql, *args):
    return H.one(a, sql, args)


def _cleanup():
    with a.app.app_context():
        d_ = a.get_db()
        ids = [r[0] for r in d_.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZLX-%' OR username LIKE 'ZZLX-%'")]
        if ids:
            ph = ",".join("?" * len(ids))
            d_.execute("DELETE FROM user_employee_ids WHERE user_id IN (%s)" % ph, ids)
            d_.execute("DELETE FROM password_resets WHERE user_id IN (%s)" % ph, ids)
            d_.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
            d_.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
        d_.execute("DELETE FROM user_employee_ids WHERE employee_id LIKE 'ZZLX-%'")
        d_.execute("DELETE FROM login_attempts WHERE username LIKE 'ZZLX-%' OR username LIKE 'zzlx-%'")
        d_.execute("DELETE FROM signin_requests WHERE employee_id LIKE 'ZZLX-%' OR employee_id LIKE 'zzlx-%'")
        d_.execute("DELETE FROM activity_log WHERE action LIKE 'password_reset%' AND detail LIKE '%ZZLX%'")
        d_.commit()
        for sql in ("DELETE FROM known_devices WHERE username LIKE 'ZZLX-%'",
                    "DELETE FROM notifications WHERE kind='signin_help' AND detail LIKE '%ZZLX%'"):
            try:
                d_.execute(sql)
                d_.commit()
            except Exception:  # noqa: BLE001
                pass


_cleanup()


def person(eid, **kw):
    cols = dict(username=eid, full_name="ZZ LX " + eid, password_hash=cheap, role="user", employee_id=eid,
                business_group="ZZLX Group", email=None)
    cols.update(kw)
    with a.app.app_context():
        d_ = a.get_db()
        uid = d_.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                         list(cols.values())).lastrowid
        d_.commit()
    return uid


def link(uid, eid, removed=False):
    dbx("INSERT INTO user_employee_ids(user_id, employee_id, linked_at, removed_at) VALUES (?,?,datetime('now'),%s)"
        % ("datetime('now')" if removed else "NULL"), uid, eid)


U["main"] = person("ZZLX-MAIN", email=MAIL)
link(U["main"], "ZZLX-OLD")                      # an active link: the older ID
link(U["main"], "ZZLX-GONE", removed=True)       # taken off
U["closed"] = person("ZZLX-CLOSED", left_at="2026-01-01", email="zzlx-closed@zzlx.invalid")
link(U["closed"], "ZZLX-CLOSEDOLD")
U["adm"] = person("ZZLX-ADM", role="admin", email="zzlx-adm@zzlx.invalid")
link(U["adm"], "ZZLX-ADMLINK")
U["demo"] = person("ZZLX-DEMO", is_demo=1, email="zzlx-demo@zzlx.invalid")
link(U["demo"], "ZZLX-DEMOLINK")
U["lock"] = person("ZZLX-LOCK")                  # the lock cases
link(U["lock"], "ZZLX-LOCKOLD")


def client():
    c_ = a.app.test_client()
    with c_.session_transaction() as ss_:
        ss_["csrf_token"] = "tok"
    return c_


def signin(username, pw=PW):
    """(status, redirected to somewhere other than /login, page text)."""
    r = client().post("/login", data={"csrf_token": "tok", "username": username, "password": pw})
    return r.status_code, (r.status_code == 302 and "/login" not in r.headers.get("Location", "/login")), \
        _html.unescape(r.get_data(as_text=True))


def signs_in(username, pw=PW):
    return signin(username, pw)[1]


def refused(username, pw=PW):
    st, ok, body = signin(username, pw)
    return st == 200 and not ok and NOMATCH in body and CLOSED_MSG not in body and LOCKED not in body


def attempts(name):
    return one("SELECT COUNT(*) FROM login_attempts WHERE username=?", name)


def wipe_attempts():
    dbx("DELETE FROM login_attempts WHERE username LIKE 'ZZLX-%' OR username LIKE 'zzlx-%'")


# ---------------------------------------------------------------------------------------------------------------------
s.section("the helper")
with a.app.app_context():
    d = a.get_db()
    la = a._login_account
    r_main, r_old, r_gone = la(d, "ZZLX-MAIN"), la(d, "ZZLX-OLD"), la(d, "ZZLX-GONE")
    s.check("a sign-in name finds its account", r_main is not None and r_main["id"] == U["main"])
    s.check("an active linked ID finds the account it is linked to", r_old is not None and r_old["id"] == U["main"])
    s.check("a removed link, a case variant, an empty name and a made-up one find nothing",
            r_gone is None and la(d, "zzlx-old") is None and la(d, "") is None and la(d, None) is None
            and la(d, "ZZLX-NOBODY") is None)
    s.check("a link on an admin account and on a demo account find nothing",
            la(d, "ZZLX-ADMLINK") is None and la(d, "ZZLX-DEMOLINK") is None)
    s.check("an admin's or demo account's own sign-in name still resolves (today's rule, judged by /login)",
            la(d, "ZZLX-ADM") is not None and la(d, "ZZLX-DEMO") is not None)
    s.check("a closed account's link resolves (the caller judges left_at)",
            la(d, "ZZLX-CLOSEDOLD") is not None and la(d, "ZZLX-CLOSEDOLD")["left_at"])
    s.check("linked_only skips the sign-in name",
            la(d, "ZZLX-MAIN", linked_only=True) is None and la(d, "ZZLX-OLD", linked_only=True) is not None)
    # the sign-in name wins over a link
    dbx("INSERT INTO user_employee_ids(user_id, employee_id, linked_at) VALUES (?, 'ZZLX-LOCK', datetime('now'))", U["main"])
    s.check("a name that is both someone's sign-in name and a link goes to the sign-in name",
            la(d, "ZZLX-LOCK")["id"] == U["lock"])
    dbx("DELETE FROM user_employee_ids WHERE user_id=? AND employee_id='ZZLX-LOCK'", U["main"])

# ---------------------------------------------------------------------------------------------------------------------
s.section("/login")
s.check("the linked ID signs in, to the account it is linked to", signs_in("ZZLX-OLD"))
with a.app.test_client() as c_:
    with c_.session_transaction() as ss_:
        ss_["csrf_token"] = "tok"
    c_.post("/login", data={"csrf_token": "tok", "username": "ZZLX-OLD", "password": PW})
    with c_.session_transaction() as ss_:
        sid = ss_.get("user_id")
s.check("...and the session is that account's, not a made-up one", sid == U["main"], sid)
s.check("the main ID still signs in", signs_in("ZZLX-MAIN"))
s.check("a wrong password through the linked ID is refused with the one message", refused("ZZLX-OLD", "nope-nope-1"))
s.check("a removed link is refused", refused("ZZLX-GONE"))
dbx("UPDATE user_employee_ids SET removed_at=datetime('now') WHERE employee_id='ZZLX-OLD'")
s.check("   FALSIFY: the active link signs in until it is removed, then is refused", refused("ZZLX-OLD"))
dbx("UPDATE user_employee_ids SET removed_at=NULL WHERE employee_id='ZZLX-OLD'")
s.check("...and signs in again once it is active", signs_in("ZZLX-OLD"))
s.check("a case variant of a linked ID is refused (Employee ID is case-sensitive)",
        refused("zzlx-old") and refused("Zzlx-Old"))
s.check("a link on an admin account is refused, even with the right password", refused("ZZLX-ADMLINK"))
s.check("   control: the admin's own sign-in name is untouched by the change", signs_in("ZZLX-ADM"))
s.check("a link on a demo account is refused", refused("ZZLX-DEMOLINK"))
st, ok, body = signin("ZZLX-CLOSEDOLD")
s.check("a link on a closed account, right password: the closed-account message, no session",
        st == 200 and not ok and CLOSED_MSG in body, (st, ok))
st, ok, body = signin("ZZLX-CLOSEDOLD", "nope-nope-1")
s.check("...a wrong password there says nothing of the account (the one message)",
        st == 200 and not ok and NOMATCH in body and CLOSED_MSG not in body)
st, ok, body = signin("ZZLX-CLOSED")
s.check("   control: the closed account's own name behaves the same", st == 200 and not ok and CLOSED_MSG in body)

# timing: ONE hash check whatever the ID is, the helper asked every time
calls, helper = [], []
_chk, _la = a.check_password_hash, a._login_account


def _chk_spy(h, p):
    calls.append(h)
    return _chk(h, p)


def _la_spy(*aa, **kk):
    helper.append(aa[1])
    return _la(*aa, **kk)


a.check_password_hash, a._login_account = _chk_spy, _la_spy
try:
    for typed, pw in (("ZZLX-OLD", "nope-nope-1"), ("ZZLX-OLD", PW), ("ZZLX-MAIN", "nope-nope-1"),
                      ("ZZLX-NOBODY", "nope-nope-1"), ("zzlx-old", "nope-nope-1"), ("ZZLX-CLOSEDOLD", PW),
                      ("ZZLX-ADMLINK", PW)):
        del calls[:], helper[:]
        signin(typed, pw)
        s.check("one hash check, and the helper asked once, typing %s %s" % (
            typed, "(right password)" if pw == PW else "(wrong password)"), len(calls) == 1 and helper == [typed],
                (len(calls), helper))
    del calls[:]
    signin("ZZLX-NOBODY", "nope-nope-1")
    s.check("a name with no account is checked against the dummy hash", calls == [a._DUMMY_PW_HASH])
    del calls[:]
    signin("ZZLX-OLD", "nope-nope-1")
    s.check("a linked ID is checked against the ACCOUNT's own hash, not the dummy",
            calls == [one("SELECT password_hash FROM users WHERE id=?", U["main"])])
finally:
    a.check_password_hash, a._login_account = _chk, _la

# ---------------------------------------------------------------------------------------------------------------------
s.section("the lock")
wipe_attempts()
for _ in range(4):
    refused("ZZLX-LOCKOLD", "nope-nope-1")
    refused("ZZLX-LOCK", "nope-nope-1")
s.check("failures typed under the linked ID and the main ID are counted together, under the account's own sign-in name",
        attempts("ZZLX-LOCK") == 8 and attempts("ZZLX-LOCKOLD") == 0, (attempts("ZZLX-LOCK"), attempts("ZZLX-LOCKOLD")))
s.check("...so the ninth try is locked whichever ID it is typed under, even with the right password",
        all(LOCKED in signin(t)[2] and not signin(t)[1] for t in ("ZZLX-LOCKOLD", "ZZLX-LOCK")))
s.check("...and the lock did not add a row of its own", attempts("ZZLX-LOCK") == 8)
wipe_attempts()
for _ in range(7):
    refused("ZZLX-LOCKOLD", "nope-nope-1")
s.check("seven failures through the linked ID alone: still open, and the account's seven are on its own name",
        signs_in("ZZLX-LOCKOLD") and attempts("ZZLX-LOCK") == 0)   # the good sign-in cleared the account's count
wipe_attempts()
for _ in range(7):
    refused("ZZLX-LOCKOLD", "nope-nope-1")
refused("ZZLX-LOCK", "nope-nope-1")
s.check("seven through the linked ID, one through the main: the eighth failure counts, so the next try is locked",
        attempts("ZZLX-LOCK") == 8 and LOCKED in signin("ZZLX-LOCK")[2])
wipe_attempts()
dbx("INSERT INTO login_attempts(username, ip) VALUES ('ZZLX-LOCK', '1'), ('ZZLX-LOCK', '1'), ('ZZLX-LOCKOLD', '1')")
s.check("a good sign-in by the linked ID clears the account's count and what was left under the typed ID",
        signs_in("ZZLX-LOCKOLD") and attempts("ZZLX-LOCK") == 0 and attempts("ZZLX-LOCKOLD") == 0)
wipe_attempts()
for _ in range(3):
    refused("ZZLX-NOBODY", "nope-nope-1")
    refused("zzlx-old", "nope-nope-1")
s.check("a name that matches no account is counted as typed (a case variant is not the account)",
        attempts("ZZLX-NOBODY") == 3 and attempts("zzlx-old") == 3 and attempts("ZZLX-MAIN") == 0)
wipe_attempts()
for _ in range(8):
    refused("ZZLX-GONE", "nope-nope-1")
s.check("...(a removed link has no account: its eight are under its own name, and the main ID is open)",
        attempts("ZZLX-GONE") == 8 and attempts("ZZLX-MAIN") == 0 and signs_in("ZZLX-MAIN"))
wipe_attempts()

# ---------------------------------------------------------------------------------------------------------------------
s.section("Forgot password")
_prod, _cfg, _send, _async = a._PROD, a.mailer.is_configured, a.mailer.send_mail, a.RESET_MAIL_ASYNC
sent = []
try:
    a._PROD, a.RESET_MAIL_ASYNC = True, False
    a.mailer.is_configured = lambda: True
    a.mailer.send_mail = lambda to, *aa, **kk: sent.append(to if isinstance(to, str) else list(to))

    def forgot(eid, email):
        dbx("DELETE FROM password_resets WHERE user_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZLX-%')")
        r_ = client().post("/forgot", data={"username": eid, "email": email, "csrf_token": "tok"},
                           headers={"X-Requested-With": "fetch"})
        return r_.status_code, r_.get_json()

    del sent[:]
    ans = forgot("ZZLX-MAIN", MAIL)
    s.check("   control: the main ID and its email send the link", len(sent) == 1, sent)
    del sent[:]
    r_ = forgot("ZZLX-OLD", MAIL)
    s.check("the linked ID and the account's work email send the link, to that email", len(sent) == 1 and MAIL in str(sent[0]), sent)
    s.check("...the answer is the one every request gets", r_ == ans, (r_, ans))
    outs = {}
    for name, eid, email in (("wrong email", "ZZLX-OLD", "someone-else@zzlx.invalid"),
                             ("removed link", "ZZLX-GONE", MAIL), ("case variant", "zzlx-old", MAIL),
                             ("unknown ID", "ZZLX-NOBODY", MAIL),
                             ("closed account's link", "ZZLX-CLOSEDOLD", "zzlx-closed@zzlx.invalid"),
                             ("admin account's link", "ZZLX-ADMLINK", "zzlx-adm@zzlx.invalid"),
                             ("demo account's link", "ZZLX-DEMOLINK", "zzlx-demo@zzlx.invalid")):
        del sent[:]
        outs[name] = forgot(eid, email)
        s.check("%s: nothing is sent, and the answer is the same" % name, not sent and outs[name] == ans, (sent, outs[name]))
    del sent[:]
    forgot("ZZLX-OLD", "")
    s.check("a linked ID with no email typed sends nothing", not sent)
    s.check("the trail names the account for a linked ID with a wrong email (and the typed email nowhere)",
            one("SELECT COUNT(*) FROM activity_log WHERE action='password_reset_mismatch' AND target_user_id=?", U["main"]) >= 1
            and one("SELECT COUNT(*) FROM activity_log WHERE detail LIKE '%someone-else@%'") == 0)
finally:
    a._PROD, a.mailer.is_configured, a.mailer.send_mail, a.RESET_MAIL_ASYNC = _prod, _cfg, _send, _async

# ---------------------------------------------------------------------------------------------------------------------
s.section("sign-in help")
_cfg, _send, _na = a.mailer.is_configured, a.mailer.send_mail, a.SIGNIN_NOTICE_ASYNC
mails = []
try:
    a.SIGNIN_NOTICE_ASYNC = False
    a.mailer.is_configured = lambda: True
    a.mailer.send_mail = lambda to, subj, html_, **kk: mails.append({"to": [to] if isinstance(to, str) else list(to),
                                                                      "subj": subj})
    n_ip = [0]

    def ask(eid, email):
        """(JSON answer, the stored request row (user_id, email_on_file), the notices sent to a person)."""
        n_ip[0] += 1
        dbx("DELETE FROM signin_requests WHERE employee_id LIKE 'ZZLX-%' OR employee_id LIKE 'zzlx-%'")
        del mails[:]
        c_ = client()
        c_.environ_base["REMOTE_ADDR"] = "198.51.100.%d" % (100 + n_ip[0])
        r_ = c_.post("/signin-help", data={"csrf_token": "tok", "issue": "password", "full_name": "ZZ LX Typed",
                                            "employee_id": eid, "email": email, "detail": "cannot sign in"},
                     headers={"X-Requested-With": "fetch"})
        j = r_.get_json() or {}
        row = H.rows(a, "SELECT user_id, email_on_file FROM signin_requests WHERE employee_id=?", (eid,))
        notes = [m for m in mails if m["subj"] == a.SIGNIN_NOTICE_SUBJECT]
        return (r_.status_code, bool(j.get("ok")), bool(j.get("ref"))), (tuple(row[0]) if row else None), notes

    base = ask("ZZLX-MAIN", MAIL)
    s.check("   control: the main ID and its email find the account and notify the person",
            base[1] == (U["main"], 1) and len(base[2]) == 1 and base[2][0]["to"] == [MAIL], base)
    ans, row, notes = ask("ZZLX-OLD", MAIL)
    s.check("the linked ID and the account's work email find the account", row == (U["main"], 1), row)
    s.check("...the person gets the fixed-words notice, at the email on the account, once", len(notes) == 1 and notes[0]["to"] == [MAIL], notes)
    s.check("...the answer is the one every request gets", ans == base[0], (ans, base[0]))
    ans, row, notes = ask("ZZLX-OLD", "someone-else@zzlx.invalid")
    s.check("a wrong email: stored and not marked as on file, and nobody is emailed (OneHR never writes to strangers)",
            row == (U["main"], 0) and not notes and ans == base[0], (row, notes, ans))
    for name, eid, email in (("a removed link", "ZZLX-GONE", MAIL), ("a case variant", "zzlx-old", MAIL),
                             ("an unknown ID", "ZZLX-NOBODY", MAIL),
                             ("a link on an admin account", "ZZLX-ADMLINK", "zzlx-adm@zzlx.invalid"),
                             ("a link on a demo account", "ZZLX-DEMOLINK", "zzlx-demo@zzlx.invalid")):
        ans, row, notes = ask(eid, email)
        s.check("%s finds no account, notifies no one, and the answer is the same" % name,
                row == (None, 0) and not notes and ans == base[0], (row, notes, ans))
    ans, row, notes = ask("ZZLX-CLOSEDOLD", "zzlx-closed@zzlx.invalid")
    s.check("a link on a closed account finds it, but a closed account is never notified",
            row == (U["closed"], 1) and not notes and ans == base[0], (row, notes))
finally:
    a.mailer.is_configured, a.mailer.send_mail, a.SIGNIN_NOTICE_ASYNC = _cfg, _send, _na

# ---------------------------------------------------------------------------------------------------------------------
s.section("the suite leaves nothing behind")
_cleanup()
s.check("nothing this suite made is left behind",
        one("SELECT COUNT(*) FROM users WHERE employee_id LIKE 'ZZLX-%' OR username LIKE 'ZZLX-%'") == 0
        and one("SELECT COUNT(*) FROM user_employee_ids WHERE employee_id LIKE 'ZZLX-%'") == 0
        and one("SELECT COUNT(*) FROM login_attempts WHERE username LIKE 'ZZLX-%' OR username LIKE 'zzlx-%'") == 0
        and one("SELECT COUNT(*) FROM signin_requests WHERE employee_id LIKE 'ZZLX-%'") == 0)
sys.exit(s.done())
