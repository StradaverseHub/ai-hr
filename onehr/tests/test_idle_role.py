"""Inactivity sign-out, per admin role (Chris, 2026-11-02: "keep L&D admin out of the 1 hr inactivity then, add this as one of
the role configuration too").

a640b16f signs everyone out after an hour with no activity except the super admin and system admin. This adds
admin_roles.idle_signout (1 = the role's admins are covered, the default; 0 = left out), the built-in L&D admin role seeded to
0 once, and one shared writer, _role_idle_set, for the Roles & access switch (its page: tests/test_idle_role_ui.py).

What this suite holds:
  * the column: NOT NULL, default 1; a new role is covered; only the built-in L&D admin role starts at 0
  * the L&D admin: no idle script on a signed-in page, no activity stamp, idle three hours and still signed in (a page, a
    fetch and the ping), peek says no idle_left; a BG admin on the same suite still gets the script and is signed out past the hour
  * a custom role's switch (_role_idle_set): off exempts its admin on the very next request (a session already open, the stale
    stamp dropped); on again covers them (a fresh hour starts, and past it they are signed out)
  * the gate, the page's helper (idle_signout_on) and /session/alive agree: all read _idle_applies on the real account
  * ONE query a request for the role (cached in g); an admin with no findable role keeps idle on; an account from before the
    roles reads as the role its scope gives
  * the writer: the super admin's alone (a BG admin, an L&D admin, a user, nobody and an unknown role are refused, and nothing
    is written or logged); one audit row, admin_role_idle, naming the role and On / Off
  * the seed runs once: a later change survives a re-run of the seed and of _ensure_runtime_schema; the column is put back, by
    its ALTER guard, on a database from before it
  * each guard falsified: the role helper, the super-only check, the seed's once-key
Synthetic (ZZIR-*) on the shared suite database; everything is put back at the end.
"""
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from werkzeug.security import generate_password_hash  # noqa: E402

a = H.setup()
s = H.Suite("Inactivity sign-out per admin role: the L&D admin is left out; the Roles & access switch's writer; the seed runs once")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
PW = "Right-pass-1"
IDLE_FN0, ROLE_FN0, IS_SUPER0 = a._idle_applies, a._idle_role_off, a.is_super
ROLE_PREFIX = "ZZIR role"
IDLE = 3600
DEAD = IDLE + a.SESSION_SEEN_EVERY    # the server's deadline: the hour plus the grace minute (_idle_deadline)
KEY = "idle_role_seeded"

with a.app.app_context():
    _d = a.get_db()
    LND0 = _d.execute("SELECT idle_signout FROM admin_roles WHERE builtin='lnd'").fetchone()[0]
    KEY0 = _d.execute("SELECT value FROM app_settings WHERE key=?", (KEY,)).fetchone()
    KEY0 = KEY0[0] if KEY0 else None


def _q(sql, args=()):
    with a.app.app_context():
        return [tuple(r) for r in a.get_db().execute(sql, args).fetchall()]


def _x(sql, args=()):
    with a.app.app_context():
        d = a.get_db()
        d.execute(sql, args)
        d.commit()


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZIR-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM activity_log WHERE action='admin_role_idle' AND detail LIKE ?", (ROLE_PREFIX + "%",))
    db.execute("DELETE FROM admin_roles WHERE name LIKE ?", (ROLE_PREFIX + "%",))
    db.execute("DELETE FROM login_attempts WHERE username LIKE 'ZZIR-%'")
    db.commit()


def _restore_seed(db):
    """Put the built-in L&D admin role and the seed's once-key back as the suite found them."""
    if "idle_signout" in [r[1] for r in db.execute("PRAGMA table_info(admin_roles)")]:
        db.execute("UPDATE admin_roles SET idle_signout=? WHERE builtin='lnd'", (LND0,))
    if KEY0 is None:
        db.execute("DELETE FROM app_settings WHERE key=?", (KEY,))
    else:
        db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?,?)", (KEY, KEY0))
    db.commit()


with a.app.app_context():
    db = a.get_db()
    _cleanup(db)
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]
    pwh = generate_password_hash(PW, method="pbkdf2:sha256:1000")   # cheap rounds: the suite signs in many times
    R_LND = db.execute("SELECT id FROM admin_roles WHERE builtin='lnd'").fetchone()[0]
    R_BG = db.execute("SELECT id FROM admin_roles WHERE builtin='bg'").fetchone()[0]
    R_BU = db.execute("SELECT id FROM admin_roles WHERE builtin='bu'").fetchone()[0]
    # a custom role is made the way the page makes one: no idle_signout named
    R_CUS = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES (?, 'group')", (ROLE_PREFIX + " custom",)).lastrowid
    db.commit()

    def mk(eid, **over):
        v = dict(base, username=eid, employee_id=eid, full_name=eid, email=None, manager_id=None, hod_id=None,
                 left_at=None, role="user", admin_bg=None, password_hash=pwh, admin_role_id=None, is_system_admin=0)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    LND = mk("ZZIR-LND", role="admin", admin_bg=a.LMS_ADMIN_BG, admin_role_id=R_LND)
    BGA = mk("ZZIR-BGA", role="admin", admin_bg="ZZ-BG", admin_role_id=R_BG)
    BUA = mk("ZZIR-BUA", role="admin", admin_bg="ZZ-BG", admin_role_id=R_BU)
    CUS = mk("ZZIR-CUS", role="admin", admin_bg="ZZ-BG", admin_role_id=R_CUS)
    OLD_LND = mk("ZZIR-OLDLND", role="admin", admin_bg=a.LMS_ADMIN_BG, admin_role_id=None)   # from before the roles
    OLD_BG = mk("ZZIR-OLDBG", role="admin", admin_bg="ZZ-BG", admin_role_id=None)
    USR = mk("ZZIR-USR")
    SUPER = mk("ZZIR-SUPER", role="admin", admin_bg=None)
    SYSA = mk("ZZIR-SYS", role="admin", admin_bg=None, is_system_admin=1)
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


def aged(c, secs):
    put(c, seen=int(time.time()) - secs)


def has_script(c):
    return "session_alive.js" in c.get("/account/password").get_data(as_text=True)


def signed_in(c):
    return c.get("/account/password").status_code == 200


def row_of(uid):
    with a.app.app_context():
        return a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


def idle_col(rid):
    return _q("SELECT idle_signout FROM admin_roles WHERE id=?", (rid,))[0][0]


def set_idle(me_id, rid, on):
    with a.app.test_request_context("/"):
        d = a.get_db()
        return a._role_idle_set(d, d.execute("SELECT * FROM users WHERE id=?", (me_id,)).fetchone(), rid, on)


def n_audit():
    return _q("SELECT COUNT(*) FROM activity_log WHERE action='admin_role_idle'")[0][0]


try:
    s.section("the column and its seed")
    info = _q("SELECT name, \"notnull\", dflt_value FROM pragma_table_info('admin_roles') WHERE name='idle_signout'")
    s.check("admin_roles.idle_signout is INTEGER NOT NULL DEFAULT 1", info == [("idle_signout", 1, "1")], info)
    s.check("the built-in L&D admin role starts at 0 (left out)", LND0 == 0 and idle_col(R_LND) == 0, (LND0, idle_col(R_LND)))
    s.check("...the BG and BU admin roles and a new custom role are covered", (idle_col(R_BG), idle_col(R_BU), idle_col(R_CUS)) == (1, 1, 1))
    s.check("...the seed left its once-key", KEY0 is not None)
    src = H.source(a)
    s.check("in the CREATE TABLE statement (today's shape) AND behind an ALTER guard", '"idle_signout INTEGER NOT NULL DEFAULT 1)")' in src
            and 'ALTER TABLE admin_roles ADD COLUMN idle_signout INTEGER NOT NULL DEFAULT 1' in src)

    s.section("the L&D admin is never signed out for idle; a BG admin still is")
    c = sign_in("ZZIR-LND")
    s.check("signed in", signed_in(c))
    s.check("L&D admin: no idle script on a signed-in page", not has_script(c))
    s.check("...and no activity stamp", "seen" not in sess(c), list(sess(c)))
    put(c, seen=int(time.time()) - 3 * 3600)
    r = c.get("/account/password", headers={"Sec-Fetch-Mode": "navigate"})
    s.check("...idle three hours: still signed in (a page, a fetch and the ping)", r.status_code == 200 and
            c.get("/account/password", headers={"Sec-Fetch-Mode": "cors"}).status_code == 200 and
            c.get("/session/alive").get_json()["signed_in"] is True)
    s.check("...the stale stamp is dropped", "seen" not in sess(c))
    s.check("...and peek says signed in with no idle_left", c.get("/session/alive?peek=1").get_json() ==
            {"signed_in": True, "idle_left": None})
    c = sign_in("ZZIR-OLDLND")
    aged(c, 3 * 3600)
    s.check("an L&D admin from before the roles (no role id) reads as the L&D role: no script, not signed out",
            signed_in(c) and not has_script(c))
    for who, label in (("ZZIR-BGA", "a BG admin"), ("ZZIR-BUA", "a BU admin"), ("ZZIR-CUS", "a custom-role admin"),
                       ("ZZIR-OLDBG", "a BG admin from before the roles"), ("ZZIR-USR", "a user")):
        c = sign_in(who)
        s.check("%s: gets the idle script, with a stamp" % label, 'data-idle-sec="3600"' in c.get("/account/password").get_data(as_text=True)
                and "seen" in sess(c))
        aged(c, DEAD + 5)
        s.check("...and past the hour is signed out", not signed_in(c) and "user_id" not in sess(c))
        c = sign_in(who)
        aged(c, DEAD - 30)
        s.check("...but not a half minute before the server's deadline", signed_in(c))
    for who, label in (("ZZIR-SUPER", "the super admin"), ("ZZIR-SYS", "the system admin")):
        c = sign_in(who)
        aged(c, 3 * 3600)
        s.check("%s: still exempt (as before)" % label, signed_in(c) and not has_script(c))

    s.section("the gate, the page and /session/alive agree: one helper on the real account")
    with a.app.test_request_context("/"):
        a.session["user_id"] = LND
        s.check("idle_signout_on for the L&D admin: None", a.idle_signout_on() is None)
        a.session["user_id"] = BGA
        s.check("...for a BG admin: the numbers", a.idle_signout_on() == {"idle": 3600, "warn": 600}, a.idle_signout_on())
    with a.app.test_request_context("/"):
        s.check("_idle_applies: L&D admin False, BG admin True, user True, super False", (
            a._idle_applies(row_of(LND)), a._idle_applies(row_of(BGA)), a._idle_applies(row_of(USR)),
            a._idle_applies(row_of(SUPER))) == (False, True, True, False))
    s.check("both readers and the gate ask _idle_applies on the real account (demo_actor / the users row)",
            "_idle_applies(demo_actor())" in src and "idle_on = _idle_applies(row)" in src and
            "return bool(SESSION_IDLE_MIN) and not is_super(row) and not _idle_role_off(row)" in src)
    s.check("the gate's row carries the role id", "SELECT id, password_hash, role, admin_bg, admin_role_id FROM users WHERE id=?" in src)

    s.section("one query a request, cached in g; no findable role keeps idle on")
    with a.app.test_request_context("/"):
        d = a.get_db()
        seen_sql = []
        d.set_trace_callback(lambda q: seen_sql.append(q))
        u = row_of(LND)
        res = [a._idle_applies(u) for _ in range(4)]
        n = sum(1 for q in seen_sql if "admin_roles" in q)
        d.set_trace_callback(None)
        s.check("four asks about one admin: one role query", n == 1 and res == [False] * 4, (n, res))
    with a.app.test_request_context("/"):
        seen_sql = []
        a.get_db().set_trace_callback(lambda q: seen_sql.append(q))
        a._idle_applies(row_of(BGA)); a._idle_applies(row_of(LND)); a._idle_applies(row_of(BGA))
        n = sum(1 for q in seen_sql if "admin_roles" in q)
        a.get_db().set_trace_callback(None)
        s.check("...the cache is per admin: a second admin in the same request is read, not mistaken for the first", n >= 2)
    with a.app.test_request_context("/"):
        s.check("...and with the answer for one admin cached, another is still judged on their own role",
                a._idle_applies(row_of(LND)) is False and a._idle_applies(row_of(BGA)) is True)
    # an admin whose role cannot be found at all keeps idle on
    a.admin_role_of_0 = a.admin_role_of
    try:
        a.admin_role_of = lambda u, db=None: None
        with a.app.test_request_context("/"):
            ghost = dict(row_of(LND)); ghost["admin_role_id"] = 999999
            s.check("an admin with no role (the id points nowhere, nothing found by scope): idle stays on",
                    a._idle_applies(ghost) is True)
    finally:
        a.admin_role_of = a.admin_role_of_0
    with a.app.test_request_context("/"):
        ghost = dict(row_of(LND)); ghost["admin_role_id"] = 999999
        s.check("...but a stale role id falls back to the role the scope gives (L&D: left out)", a._idle_applies(ghost) is False)
        s.check("a non-admin has no role to read: covered", a._idle_applies(row_of(USR)) is True and
                a._idle_role_off(row_of(USR)) is False and a._idle_role_off(None) is False)
    s.check("SESSION_IDLE_MIN off: nobody is covered, whatever the role", (
        setattr(a, "SESSION_IDLE_MIN", None), a._idle_applies(row_of(BGA)))[1] is False)
    a.SESSION_IDLE_MIN = 60

    s.section("the writer: the super admin's alone")
    before = n_audit()
    for who, uid in (("a BG admin", BGA), ("the L&D admin", LND), ("a custom-role admin", CUS), ("a user", USR)):
        err = set_idle(uid, R_CUS, False)
        s.check("%s: refused with a sentence" % who, isinstance(err, str) and "super admin" in err, err)
    with a.app.test_request_context("/"):
        d = a.get_db()
        errs = (a._role_idle_set(d, None, R_CUS, False), a._role_idle_set(d, {"role": "user", "admin_bg": None}, R_CUS, False))
    s.check("nobody (None), and a row that is no admin: refused", all(isinstance(e, str) for e in errs), errs)
    s.check("...nothing written, nothing logged", idle_col(R_CUS) == 1 and n_audit() == before)
    err = set_idle(SU["id"], 999999, False)
    s.check("an unknown role: refused", isinstance(err, str) and "not found" in err and n_audit() == before, err)
    _x("UPDATE admin_roles SET retired_at=datetime('now') WHERE id=?", (R_CUS,))
    err = set_idle(SU["id"], R_CUS, False)
    s.check("a retired role: refused", isinstance(err, str) and idle_col(R_CUS) == 1, err)
    _x("UPDATE admin_roles SET retired_at=NULL WHERE id=?", (R_CUS,))
    # falsified: the super-only check. With is_super broken a BG admin writes, so the refusals above bite.
    a.is_super = lambda u: True
    try:
        err = set_idle(BGA, R_CUS, False)
        s.check("FALSIFIED: with the super-admin check broken a BG admin's call writes (so the refusals above were the guard)",
                err is None and idle_col(R_CUS) == 0)
    finally:
        a.is_super = IS_SUPER0
    _x("UPDATE admin_roles SET idle_signout=1 WHERE id=?", (R_CUS,))
    _x("DELETE FROM activity_log WHERE action='admin_role_idle'")
    before = n_audit()
    err = set_idle(SUPER, R_CUS, False)
    s.check("the super admin: saved (None) and the column is 0", err is None and idle_col(R_CUS) == 0, err)
    rows = _q("SELECT user_id, action, detail FROM activity_log WHERE action='admin_role_idle' ORDER BY id DESC")
    s.check("...one audit row, admin_role_idle, naming the role, Off", n_audit() == before + 1 and rows[0][0] == SUPER and
            ROLE_PREFIX + " custom" in rows[0][2] and "Off" in rows[0][2] and "was On" in rows[0][2], rows[:1])
    err = set_idle(SYSA, R_CUS, True)
    s.check("the system admin (a super admin too): saved, On, one more row naming On", err is None and idle_col(R_CUS) == 1 and
            n_audit() == before + 2 and "inactivity sign-out On" in _q(
                "SELECT detail FROM activity_log WHERE action='admin_role_idle' ORDER BY id DESC LIMIT 1")[0][0])
    s.check("...the audit log says it in words", a.ACTION_LABELS.get("admin_role_idle") == "Change a role's inactivity sign-out")
    s.check("only routes call the writer, never a template (the Roles & access switch: tests/test_idle_role_ui.py)", "_role_idle_set" not in " ".join(
        open(os.path.join(H.REPO, "templates", f), encoding="utf-8").read() for f in os.listdir(os.path.join(H.REPO, "templates"))
        if f.endswith(".html")))

    s.section("a custom role's switch exempts its admin, and turns back on")
    c = sign_in("ZZIR-CUS")
    s.check("covered to begin with: the script, a stamp", 'data-idle-sec="3600"' in c.get("/account/password").get_data(as_text=True)
            and "seen" in sess(c))
    set_idle(SUPER, R_CUS, False)
    aged(c, 3 * 3600)
    s.check("the role switched off: the session already open, idle three hours, is not signed out on its next request",
            signed_in(c))
    s.check("...the page drops the script and the stale stamp goes", not has_script(c) and "seen" not in sess(c))
    s.check("...peek: no idle_left", c.get("/session/alive?peek=1").get_json() == {"signed_in": True, "idle_left": None})
    c2 = sign_in("ZZIR-CUS")
    s.check("...a fresh sign-in gets no stamp either", "seen" not in sess(c2) and not has_script(c2))
    set_idle(SUPER, R_CUS, True)
    s.check("switched on again: the script is back and a fresh hour starts", has_script(c) and
            abs(sess(c).get("seen", 0) - int(time.time())) < 5, sess(c).get("seen"))
    aged(c, DEAD + 5)
    s.check("...and past the hour they are signed out again", not signed_in(c) and "user_id" not in sess(c))
    # another role's admins are untouched by a custom role's switch
    set_idle(SUPER, R_CUS, False)
    c = sign_in("ZZIR-BGA")
    aged(c, DEAD + 5)
    s.check("a BG admin is still signed out while the custom role is off (a role's switch moves only its own admins)", not signed_in(c))
    set_idle(SUPER, R_BG, False)
    c = sign_in("ZZIR-BGA")
    aged(c, 3 * 3600)
    s.check("...and the built-in BG admin role can be switched off too", signed_in(c) and not has_script(c) and
            idle_col(R_BG) == 0)
    set_idle(SUPER, R_BG, True)
    set_idle(SUPER, R_CUS, True)

    # falsified: the role helper. Broken, the L&D admin and a switched-off custom role are covered again.
    set_idle(SUPER, R_CUS, False)
    a._idle_role_off = lambda u: False
    try:
        c = sign_in("ZZIR-LND")
        s.check("FALSIFIED: with the role helper broken the L&D admin gets the script", has_script(c))
        aged(c, DEAD + 5)
        s.check("...and is signed out past the hour (so the exemption checks above bite, in the page and the gate)", not signed_in(c))
        c = sign_in("ZZIR-CUS")
        aged(c, DEAD + 5)
        s.check("...and so is the switched-off custom role's admin", not signed_in(c))
    finally:
        a._idle_role_off = ROLE_FN0
    set_idle(SUPER, R_CUS, True)

    s.section("the seed runs once; a later change survives the boot")
    s.check("as found: L&D left out", idle_col(R_LND) == 0)
    set_idle(SUPER, R_LND, True)
    s.check("the super admin puts the L&D admin role back on", idle_col(R_LND) == 1)
    a._ensure_runtime_schema()
    a._seed_access_roles()
    s.check("a re-run of _ensure_runtime_schema and the seed does not undo it", idle_col(R_LND) == 1, idle_col(R_LND))
    c = sign_in("ZZIR-LND")
    aged(c, DEAD + 5)
    s.check("...so the L&D admin is covered again, until the super admin says otherwise", not signed_in(c))
    set_idle(SUPER, R_BG, False)
    a._seed_access_roles()
    s.check("...nor is another role's setting touched by the seed", idle_col(R_BG) == 0 and idle_col(R_LND) == 1)
    set_idle(SUPER, R_BG, True)
    # falsified: without its once-key the seed puts the L&D role back to 0 (so the key is what keeps a later change)
    _x("DELETE FROM app_settings WHERE key=?", (KEY,))
    a._seed_access_roles()
    s.check("FALSIFIED: with the once-key gone the seed runs again and puts the L&D admin role back to Off (so the key is the guard)",
            idle_col(R_LND) == 0 and idle_col(R_BG) == 1 and idle_col(R_CUS) == 1)
    s.check("...and leaves its key", bool(_q("SELECT 1 FROM app_settings WHERE key=?", (KEY,))))
    # a database from before the column: the ALTER guard adds it (every role covered), the seed leaves the L&D role out
    try:
        _x("ALTER TABLE admin_roles DROP COLUMN idle_signout")
        dropped = True
    except Exception as e:   # an old SQLite: the guard is held by the source check above
        dropped = False
        s.note("DROP COLUMN not available here (%s); the ALTER guard is held by the source check" % e)
    if dropped:
        _x("DELETE FROM app_settings WHERE key=?", (KEY,))
        s.check("(a database from before the column: it is gone)",
                "idle_signout" not in [r[0] for r in _q("SELECT name FROM pragma_table_info('admin_roles')")])
        a._ensure_runtime_schema()
        s.check("...the boot adds it, default 1, for every role", [r[0] for r in _q(
            "SELECT idle_signout FROM admin_roles WHERE builtin IN ('bg','bu') OR id=?", (R_CUS,))] == [1, 1, 1])
        a._seed_access_roles()
        s.check("...and the seed leaves only the L&D admin role out", (idle_col(R_LND), idle_col(R_BG), idle_col(R_BU), idle_col(R_CUS)) == (0, 1, 1, 1))
        a._ensure_runtime_schema()
        a._seed_access_roles()
        s.check("...a second boot changes nothing", (idle_col(R_LND), idle_col(R_BG)) == (0, 1))
finally:
    a._idle_applies, a._idle_role_off, a.is_super = IDLE_FN0, ROLE_FN0, IS_SUPER0
    a.SESSION_IDLE_MIN = 60
    with a.app.app_context():
        d_ = a.get_db()
        if "idle_signout" not in [r[1] for r in d_.execute("PRAGMA table_info(admin_roles)")]:
            d_.execute("ALTER TABLE admin_roles ADD COLUMN idle_signout INTEGER NOT NULL DEFAULT 1")
        _cleanup(d_)
        _restore_seed(d_)
sys.exit(s.done())
