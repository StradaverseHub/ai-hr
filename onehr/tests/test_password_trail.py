"""Password events leave a record on the Audit log (Chris, 2026-10-30: "we need the record so we can trace").

Every self-service password event is an activity_log row against the person it is about (user_id = target_user_id =
them; an Employee ID that matches nothing has neither), and none of them is hidden from /admin/audit-log:
  * password_change          -- they changed their own password (Change password page, Profile panel)
  * password_reset           -- a reset link emailed / failed to send / set a new password / (dev) shown on screen
  * password_reset_capped    -- Forgot password held a link back: the hourly limit was reached
  * password_reset_mismatch  -- the Employee ID matched an active account but the typed email did not (or none is on file)
  * password_reset_unknown   -- the Employee ID matches no active account (unknown or left): the cleaned ID, no person
The page itself gives one answer whatever was typed (byte-identical, HTML and JSON), and a typed email is never stored.

Synthetic (ZZPT-*) on the shared suite database; everything is put back at the end.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from werkzeug.security import generate_password_hash  # noqa: E402

a = H.setup()
s = H.Suite("Password trail -- every password event is on the Audit log, against the person")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)

OLD, NEW = "Old-trail-pass1", "New-trail-pass22"
NEW2 = "Third-trail-pass33"   # a change can't go back to one of the last 5 passwords (2026-10-31)
MATCH_MAIL = "zzpt-match@example.invalid"
TYPED_WRONG = "typed-wrong-zzpt@example.invalid"
TYPED_NOMAIL = "typed-nomail-zzpt@example.invalid"
CODES = ("password_change", "password_reset", "password_reset_capped", "password_reset_mismatch",
         "password_reset_unknown")


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZPT-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM password_resets WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM activity_log WHERE action='password_reset_unknown' AND detail LIKE 'Employee ID typed: ZZPT%'")
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    _cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]
    pwh = generate_password_hash(OLD, method="pbkdf2:sha256:1000")

    def mk(eid, **over):
        v = dict(base, username=eid, employee_id=eid, full_name=eid, email=None, manager_id=None, hod_id=None,
                 left_at=None, role="user", admin_bg=None, password_hash=pwh)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    ME = mk("ZZPT-MATCH", email=MATCH_MAIL)
    NOMAIL = mk("ZZPT-NOMAIL")
    mk("ZZPT-LEFT", email="zzpt-left@example.invalid", left_at="2026-01-01")
    CHG = mk("ZZPT-CHG")
    LNK = mk("ZZPT-LINK")
    db.commit()


def trail(action, uid=None, null_user=False, where="", args=(), by_them=False):
    """Rows of one action code about one person: target = uid, and NO actor (nobody was signed in) unless by_them, when
    the actor is the person too (signed in, or held the emailed link). null_user: the person-less rows (no actor, no
    target). Anyone can type someone's Employee ID on Forgot password, so those rows must not name them as the actor."""
    return [tuple(r) for r in _trail(action, uid, null_user, where, args, by_them)]


def _trail(action, uid, null_user, where, args, by_them):
    if null_user:
        return H.rows(a, "SELECT id, user_id, target_user_id, detail FROM activity_log WHERE action=? "
                         "AND user_id IS NULL AND target_user_id IS NULL " + where + " ORDER BY id", (action,) + tuple(args))
    if by_them:
        return H.rows(a, "SELECT id, user_id, target_user_id, detail FROM activity_log WHERE action=? "
                         "AND user_id=? AND target_user_id=? " + where + " ORDER BY id", (action, uid, uid) + tuple(args))
    return H.rows(a, "SELECT id, user_id, target_user_id, detail FROM activity_log WHERE action=? "
                     "AND user_id IS NULL AND target_user_id=? " + where + " ORDER BY id", (action, uid) + tuple(args))


def count_all():
    return H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action IN (%s)" % ",".join("?" * len(CODES)), CODES)


# =================================================================================================================
s.section("the codes are in words, and none is hidden from the Audit log")
for code in CODES:
    lab = a.ACTION_LABELS.get(code)
    s.check("%s has a plain-words label (%s)" % (code, lab), bool(lab) and "_" not in lab and lab != code)
    s.check("%s is not a hidden self-service action" % code, code not in a.SELF_SERVICE_ACTIONS)
s.check("a real self-service action still is hidden (the denylist still works)", "login" in a.SELF_SERVICE_ACTIONS)

# =================================================================================================================
s.section("Forgot password: every outcome leaves a row, and the page answers the same")
_prod, _cfg, _send, _async = a._PROD, a.mailer.is_configured, a.mailer.send_mail, a.RESET_MAIL_ASYNC
fc = a.app.test_client()


def ask(eid, email, as_json=False):
    with fc.session_transaction() as ss_:
        ss_["csrf_token"] = "tok"
    hdr = {"X-Requested-With": "fetch"} if as_json else {}
    return fc.post("/forgot", data={"username": eid, "email": email, "csrf_token": "tok"},
                   headers=hdr).get_data(as_text=True)


try:
    a._PROD, a.RESET_MAIL_ASYNC = True, False
    a.mailer.is_configured = lambda: True
    sent = []
    a.mailer.send_mail = lambda to, *a_, **k_: sent.append(to)

    # a match: the link is emailed, and the row says so
    base_all = count_all()
    match = ask("ZZPT-MATCH", MATCH_MAIL)
    match_js = ask("ZZPT-MATCH", MATCH_MAIL, as_json=True)    # a second link (2 of 3 for the hour)
    r_ = trail("password_reset", ME, where="AND detail='reset link emailed'")
    s.check("a match: 'reset link emailed' against the person, with no actor (nobody signed in)",
            sent == [MATCH_MAIL, MATCH_MAIL] and len(r_) == 2, (sent, r_))
    s.check("...and nothing else was written for a clean match", count_all() == base_all + 2)

    # a wrong email: a row against the account; the typed email is nowhere
    n0 = len(trail("password_reset_mismatch", ME))
    wrong = ask("ZZPT-MATCH", TYPED_WRONG)
    wrong_js = ask("ZZPT-MATCH", TYPED_WRONG, as_json=True)
    r_ = trail("password_reset_mismatch", ME)
    s.check("a wrong email: password_reset_mismatch against the account (no actor), saying it is not the one on file",
            len(r_) == n0 + 2 and all("not the one on file" in x[3] for x in r_), r_)
    s.check("...and a wrong email sent nothing", len(sent) == 2, sent)

    # an account with no work email: same code, saying which
    nomail = ask("ZZPT-NOMAIL", TYPED_NOMAIL)
    nomail_js = ask("ZZPT-NOMAIL", TYPED_NOMAIL, as_json=True)
    r_ = trail("password_reset_mismatch", NOMAIL)
    s.check("no work email on file: password_reset_mismatch, saying so",
            len(r_) == 2 and all("no work email" in x[3] for x in r_), r_)
    ask("ZZPT-NOMAIL", "")
    s.check("...an empty email field on an account with none is the same", len(trail("password_reset_mismatch", NOMAIL)) == 3)

    # an unknown or closed Employee ID: no person, the cleaned ID
    unk = ask("ZZPT-NOBODY", MATCH_MAIL)
    unk_js = ask("ZZPT-NOBODY", MATCH_MAIL, as_json=True)
    left = ask("ZZPT-LEFT", "zzpt-left@example.invalid")
    r_ = trail("password_reset_unknown", null_user=True, where="AND detail LIKE ?", args=("%ZZPT-NOBODY",))
    s.check("an unknown Employee ID: password_reset_unknown with no actor and no target, the ID typed",
            len(r_) == 2 and all(x[3] == "Employee ID typed: ZZPT-NOBODY" for x in r_), r_)
    r_ = trail("password_reset_unknown", null_user=True, where="AND detail LIKE ?", args=("%ZZPT-LEFT",))
    s.check("a closed account reads as unknown (it has no active account)", len(r_) == 1, r_)
    ask("  ZZPT-NO\x07BO   DY  ", MATCH_MAIL)
    r_ = trail("password_reset_unknown", null_user=True, where="AND detail=?", args=("Employee ID typed: ZZPT-NOBO DY",))
    s.check("the typed ID is cleaned: control characters out, spaces folded and trimmed", len(r_) == 1, r_)
    ask("ZZPT-" + "X" * 80, MATCH_MAIL)
    r_ = trail("password_reset_unknown", null_user=True, where="AND detail LIKE ?", args=("%ZZPT-XXX%",))
    s.check("...and kept to 40 characters", len(r_) == 1 and len(r_[0][3]) == len("Employee ID typed: ") + 40, r_)
    n_unk = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='password_reset_unknown'")
    empty = ask("", MATCH_MAIL)
    ask("   ", MATCH_MAIL)
    s.check("an empty Employee ID writes nothing",
            H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='password_reset_unknown'") == n_unk)

    # the person is never the actor of anything started from Forgot password
    s.check("no Forgot-password row names the person as the actor",
            H.one(a, "SELECT COUNT(*) FROM activity_log WHERE user_id IN (?,?) AND action LIKE 'password_reset%' "
                     "AND detail != 'password set via reset link'", (ME, NOMAIL)) == 0)

    # an email typed into the Employee ID box is never stored
    ask("zzpt-email-in-id@example.invalid", MATCH_MAIL)
    r_ = trail("password_reset_unknown", null_user=True, where="AND detail LIKE ?", args=("%an email address%",))
    s.check("an email typed as the Employee ID is stored as 'an email address', never as typed",
            len(r_) == 1 and r_[0][3] == "Employee ID typed: an email address", r_)
    s.check("...and the typed address is in no row",
            H.one(a, "SELECT COUNT(*) FROM activity_log WHERE detail LIKE ?", ("%zzpt-email-in-id%",)) == 0)

    # the hourly cap: the 3rd link is made, the 4th is held back
    ask("ZZPT-MATCH", MATCH_MAIL)
    s.check("(the third link of the hour was sent)", len(sent) == 3 and len(trail("password_reset_capped", ME)) == 0, sent)
    capped = ask("ZZPT-MATCH", MATCH_MAIL)
    capped_js = ask("ZZPT-MATCH", MATCH_MAIL, as_json=True)
    r_ = trail("password_reset_capped", ME)
    s.check("over the hourly cap: password_reset_capped against the account (no actor), and nothing sent",
            len(r_) == 2 and len(sent) == 3 and str(a.RESET_MAX_PER_HOUR) in r_[0][3], (r_, sent))

    # one answer, whatever was typed -- the page and the pop-out's JSON, byte for byte
    html = {"match": match, "wrong email": wrong, "no email on file": nomail, "unknown ID": unk, "closed account": left,
            "empty ID": empty, "over the cap": capped}
    for what, body in html.items():
        s.check("the page reads exactly as a match does: %s" % what, body == match and "we'll email" in body)
    js = {"match": match_js, "wrong email": wrong_js, "no email on file": nomail_js, "unknown ID": unk_js,
          "over the cap": capped_js}
    for what, body in js.items():
        s.check("the JSON reply reads exactly as a match does: %s" % what, body == match_js and '"requested"' in body)

    # a failed send is a row too (existing behaviour, now against the person)
    def boom(*_a, **_k):
        raise RuntimeError("graph down")
    with a.app.test_request_context("/"):
        a.get_db().execute("DELETE FROM password_resets WHERE user_id=?", (ME,))
        a.get_db().commit()
    a.mailer.send_mail = boom
    failed = ask("ZZPT-MATCH", MATCH_MAIL)
    s.check("a failed send is on the trail against the person, and reads as a match does",
            len(trail("password_reset", ME, where="AND detail='reset email failed to send'")) == 1 and failed == match)

    # the typed email is never stored, anywhere
    s.check("the typed (wrong) emails are in no activity_log row",
            H.one(a, "SELECT COUNT(*) FROM activity_log WHERE detail LIKE ? OR detail LIKE ? OR detail LIKE '%@%'",
                  ("%typed-wrong-zzpt%", "%typed-nomail-zzpt%")) == 0)
    s.check("...and neither is the email on file",
            H.one(a, "SELECT COUNT(*) FROM activity_log WHERE detail LIKE ?", ("%zzpt-match@example%",)) == 0)

    # falsify: a trail that writes nothing is seen, and a trail that raises never reaches the reply
    a.mailer.send_mail = lambda to, *a_, **k_: sent.append(to)
    with a.app.test_request_context("/"):
        a.get_db().execute("DELETE FROM password_resets WHERE user_id=?", (ME,))
        a.get_db().commit()
    real_log = a.log_activity
    n_before = count_all()
    a.log_activity = lambda *a_, **k_: None
    try:
        ask("ZZPT-NOBODY", "x@example.invalid")
        ask("ZZPT-MATCH", TYPED_WRONG)
    finally:
        a.log_activity = real_log
    s.check("(falsified) with the logger switched off no row appears -- so the checks above do see a missing row",
            count_all() == n_before)

    def log_boom(*_a, **_k):
        raise RuntimeError("log down")
    a.log_activity = log_boom
    try:
        after_boom = ask("ZZPT-MATCH", TYPED_WRONG)
        after_boom_unknown = ask("ZZPT-NOBODY", "x@example.invalid")
    finally:
        a.log_activity = real_log
    s.check("a logger that raises never reaches the reply: it reads as a match does",
            after_boom == match and after_boom_unknown == match)

    # development (a laptop): the on-screen link is a row against the person too
    a._PROD = False
    with a.app.test_request_context("/"):
        a.get_db().execute("DELETE FROM password_resets WHERE user_id=?", (ME,))
        a.get_db().commit()
    ask("ZZPT-MATCH", MATCH_MAIL)
    s.check("dev: 'reset link generated (dev)' is against the person",
            len(trail("password_reset", ME, where="AND detail='reset link generated (dev)'")) == 1)
finally:
    a._PROD, a.mailer.is_configured, a.mailer.send_mail, a.RESET_MAIL_ASYNC = _prod, _cfg, _send, _async

# =================================================================================================================
s.section("setting a new password with the emailed link")
with a.app.test_request_context("/"):
    d_ = a.get_db()
    raw = "zzpt-token-" + "a" * 24
    d_.execute("DELETE FROM password_resets WHERE user_id=?", (LNK,))
    d_.execute("INSERT INTO password_resets(token_hash, user_id) VALUES (?,?)", (a._hash_token(raw), LNK))
    d_.commit()
rc = a.app.test_client()
with rc.session_transaction() as ss_:
    ss_["csrf_token"] = "tok"
r = rc.post("/reset/" + raw, data={"new": "short", "confirm": "short", "csrf_token": "tok"})
s.check("a refused new password (too short) writes no row", len(trail("password_reset", LNK, by_them=True)) == 0)
r = rc.post("/reset/" + raw, data={"new": NEW, "confirm": NEW, "csrf_token": "tok"})
r_ = trail("password_reset", LNK, by_them=True)
s.check("the link set a new password: 'password set via reset link', actor and target the person (they held the link)",
        r.status_code == 302 and len(r_) == 1 and r_[0][3] == "password set via reset link", (r.status_code, r_))
s.check("...and the new password is in no activity_log row",
        H.one(a, "SELECT COUNT(*) FROM activity_log WHERE detail LIKE ? OR detail LIKE ?", ("%" + NEW + "%", "%" + OLD + "%")) == 0)
with a.app.app_context():
    s.check("...and the password's source reads as their own",
            a.get_db().execute("SELECT pw_source FROM users WHERE id=?", (LNK,)).fetchone()[0] == "own")

# =================================================================================================================
s.section("changing your own password")
C = H.client_as(a, CHG)
r = C.post("/account/password", data={"csrf_token": "tok", "current": "wrong-one", "new": NEW, "confirm": NEW})
r2 = C.post("/account/password", data={"csrf_token": "tok", "current": OLD, "new": "short", "confirm": "short"})
s.check("a refused change (wrong current, too short) writes no row", len(trail("password_change", CHG, by_them=True)) == 0
        and "incorrect" in r.get_data(as_text=True))
r = C.post("/account/password", data={"csrf_token": "tok", "current": OLD, "new": NEW, "confirm": NEW})
r_ = trail("password_change", CHG, by_them=True)
s.check("a change on the Change password page: one row, actor and target the person",
        r.status_code == 302 and len(r_) == 1 and r_[0][3] == "changed their own password", (r.status_code, r_))
C = H.client_as(a, CHG)
r = C.post("/profile", data={"csrf_token": "tok", "action": "password", "current": NEW, "new": OLD + "x",
                             "confirm": OLD + "x"})
s.check("a change from the Profile panel is the same row (one writer)", len(trail("password_change", CHG, by_them=True)) == 2, r.status_code)
s.check("...and no password is in the trail",
        H.one(a, "SELECT COUNT(*) FROM activity_log WHERE detail LIKE ? OR detail LIKE ? OR detail LIKE ?",
              ("%" + NEW + "%", "%" + OLD + "%", "%" + OLD + "x%")) == 0)

# falsify: no row with the logger off; and a logger that raises doesn't undo or fail the change
real_log = a.log_activity
a.log_activity = lambda *a_, **k_: None
try:
    C = H.client_as(a, CHG)
    C.post("/account/password", data={"csrf_token": "tok", "current": OLD + "x", "new": NEW2, "confirm": NEW2})
finally:
    a.log_activity = real_log
s.check("(falsified) with the logger off a change leaves no new row -- so the check above does see a missing row",
        len(trail("password_change", CHG, by_them=True)) == 2)


def log_boom2(*_a, **_k):
    raise RuntimeError("log down")


a.log_activity = log_boom2
try:
    C = H.client_as(a, CHG)
    r = C.post("/account/password", data={"csrf_token": "tok", "current": NEW2, "new": OLD + "y", "confirm": OLD + "y"})
finally:
    a.log_activity = real_log
with a.app.app_context():
    h_ = a.get_db().execute("SELECT password_hash FROM users WHERE id=?", (CHG,)).fetchone()[0]
s.check("a logger that raises doesn't fail or undo the change", r.status_code == 302
        and a.check_password_hash(h_, OLD + "y"), r.status_code)

# =================================================================================================================
s.section("the super admin's Audit log shows them")
SUP = H.client_as(a, SU["id"])
code, body = None, ""
r = SUP.get("/admin/audit-log?q=ZZPT&per_page=200")
body = r.get_data(as_text=True)
s.check("the Audit log opens", r.status_code == 200)
s.check("a password reset row shows, in words, against the person (found by their Employee ID)",
        a.ACTION_LABELS["password_reset"] in body and "ZZPT-LINK" in body and "password set via reset link" in body)
s.check("a changed-own-password row shows, in words", a.ACTION_LABELS["password_change"] in body and "ZZPT-CHG" in body
        and "changed their own password" in body)
s.check("the refusals show, in words", a.ACTION_LABELS["password_reset_mismatch"] in body
        and a.ACTION_LABELS["password_reset_capped"] in body)
r = SUP.get("/admin/audit-log?q=Employee+ID+typed%3A+ZZPT-NOBODY&per_page=200")
s.check("an unknown-ID row shows, found by the ID typed (no person on it)",
        a.ACTION_LABELS["password_reset_unknown"] in r.get_data(as_text=True))
r = SUP.get("/admin/audit-log?q=ZZPT-NOMAIL&per_page=200")
s.check("searching a person's Employee ID finds their password rows (target)",
        "no work email on file" in r.get_data(as_text=True))
s.check("a row nobody signed in for reads 'Nobody signed in', not '(deleted admin)'",
        "Nobody signed in" in body and body.count("(deleted admin)") == 0)
r = SUP.get("/admin/export/audit-log.xlsx?q=ZZPT")
s.check("the Audit log download carries them too", r.status_code == 200)
import io  # noqa: E402
import openpyxl  # noqa: E402
ws = openpyxl.load_workbook(io.BytesIO(r.data)).active
cells = [str(c.value) for row in ws.iter_rows() for c in row if c.value is not None]
s.check("...and the download says 'Nobody signed in' for them too", "Nobody signed in" in cells
        and "(deleted user)" not in cells)

# falsify: hide the code again and the row goes
_ss = a.SELF_SERVICE_ACTIONS
a.SELF_SERVICE_ACTIONS = frozenset(set(_ss) | {"password_change", "password_reset"})
try:
    hidden = SUP.get("/admin/audit-log?q=ZZPT&per_page=200").get_data(as_text=True)
finally:
    a.SELF_SERVICE_ACTIONS = _ss
s.check("(falsified) listing the codes as self-service again hides the rows -- so the check above is the filter's",
        a.ACTION_LABELS["password_change"] not in hidden and "password set via reset link" not in hidden)

# =================================================================================================================
with a.app.test_request_context("/"):
    _cleanup(a.get_db())
s.check("everything is put back", H.one(a, "SELECT COUNT(*) FROM users WHERE employee_id LIKE 'ZZPT-%'") == 0
        and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE detail LIKE '%ZZPT%'") == 0)
sys.exit(s.done())
