"""Linked Employee IDs (Chris, 2026-10-29: "allow for cases where a person carries more than one employee ID, to link the
ID and super admin to select which one to use as main, e.g. R0001 and X0002"; canvas
[design canvas link removed]).

users.employee_id stays the MAIN ID (what they sign in with, what every page shows). user_employee_ids holds the others:
imports and People search find the person by any of them. The super admin links, removes and chooses the main ID from the
person page's Account panel; nobody else can.

What this suite holds:
  * storage: the table and its partial unique index in SCHEMA and in _ensure_runtime_schema (put back on a database that
    lacks it); an ID is actively linked once, a removed row is kept and may be linked again
  * the Employee IDs box: the super admin sees the buttons, a BG admin sees the IDs and none; the main ID's chip; "linked
    by <who>, <d Mon>"; the Account summary's " · N linked IDs"; the app's own prompt / confirm boxes with the approved words
  * Link / Remove / Make main: the happy paths (DB state, audit rows, the username rule, the password hash untouched, the
    failed sign-ins under the old name cleared, one transaction) and EVERY refusal, each falsified: the request is refused
    and the same request goes through once only that condition is removed
  * access: both ways in the map as "super"; a BG admin gets 403; a system admin's account stays a system admin's
  * the other way: a manual Add person / an admin username refuses an ID that is someone's linked ID
  * imports resolve linked IDs through one shared batched resolver: the roster (ID, Manager and HOD columns: updated under
    the main ID, never renamed, nobody new, not marked left; the same person twice is an error; the same-person look-at
    stays silent), the KPI targets import, panels, clear panels, passwords and job codes; each Quality step lists it as
    a look-at item that never stops a row being clean
  * People search (find.json, the People list, the pickers) finds a person by an active linked ID, not a removed one

Synthetic (ZZLI-*) on the shared suite database; everything is put back at the end.
"""
import atexit
import csv as _csv
import hashlib
import html as _html
import io
import os
import re
import sys

from werkzeug.security import check_password_hash, generate_password_hash

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Linked Employee IDs -- link, remove, make main; imports and People search find a person by any of them")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, _E0 = H.actors(a)
BG, CO = "ZZLI Group", "ZZLI Unit"
LINES = "/admin/users/%d/lines"
LOCK = a.SYSTEM_ADMIN_LOCK_MSG
ONLY_SUPER = "Only the super admin can link, remove or change Employee IDs."
U = {}
KEEP = {}


def dbx(sql, *args):
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute(sql, args)
        d_.commit()


def one(sql, *args):
    return H.one(a, sql, args)


def rows(sql, *args):
    return H.rows(a, sql, args)


def _cleanup(d_):
    ids = [r[0] for r in d_.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZLI%' OR username LIKE 'zzli%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        d_.execute("DELETE FROM user_employee_ids WHERE user_id IN (%s) OR employee_id LIKE 'ZZLI%%' OR "
                   "linked_by IN (%s)" % (ph, ph), ids + ids)
        d_.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE manager_id IN (%s) OR hod_id IN (%s) OR id IN (%s)"
                   % (ph, ph, ph), ids + ids + ids)
        d_.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        d_.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        d_.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        d_.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    d_.execute("DELETE FROM login_attempts WHERE username LIKE 'zzli%'")
    d_.execute("DELETE FROM tc_job_profiles WHERE job_code LIKE 'ZLI-%'")
    d_.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    d_.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    d_.execute("DELETE FROM admin_role_access WHERE role_id IN (SELECT id FROM admin_roles WHERE name LIKE 'ZZLI%')")
    d_.execute("DELETE FROM admin_roles WHERE name LIKE 'ZZLI%'")
    d_.commit()


with a.app.app_context():
    d = a.get_db()
    d.execute("PRAGMA foreign_keys=ON")
    _cleanup(d)
    CID = a.active_cycle_id(d)
    KEEP["cycle"] = dict(d.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
    d.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    d.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))

    def person(eid, name, username="same", **kw):
        cols = dict(username=eid if username == "same" else username, full_name=name,
                    password_hash=generate_password_hash(eid + "-pw-test", method="pbkdf2:sha256"), role="user",
                    employee_id=eid, business_group=BG, company=CO, department="ZZLI Ops", job_grade=20,
                    confirmation_date="2020-01-01", joined_date="2015-01-01")
        cols.update(kw)
        return d.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                         list(cols.values())).lastrowid
    U["P1"] = person("ZZLI-P1", "ZZ LI Pone")                                   # the person most cases use
    U["P2"] = person("ZZLI-P2", "ZZ LI Ptwo")
    U["P3"] = person("ZZLI-P3", "ZZ LI Pthree", username="zzli_p3_login")        # a sign-in name that is not their ID
    U["M1"] = person("ZZLI-M1", "ZZ LI Mgr")
    U["H1"] = person("ZZLI-H1", "ZZ LI Hod")
    U["PX"] = person("ZZLI-PX", "ZZ LI Pxtra")
    U["LEFT"] = person("ZZLI-LEFT", "ZZ LI Leaver", left_at="2026-06-22")
    U["DEMO"] = person("ZZLI-DEMO", "ZZ LI Demo", is_demo=1)
    U["SYSP"] = person("ZZLI-SYSP", "ZZ LI Sysperson", is_system_admin=1)         # a person row carrying the system flag
    U["ADM"] = d.execute("INSERT INTO users(username, full_name, password_hash, role) VALUES ('zzli-adm', 'ZZ LI Admin', 'x', "
                         "'admin')").lastrowid
    U["SYSA"] = d.execute("INSERT INTO users(username, full_name, password_hash, role, is_system_admin) VALUES "
                          "('zzli-sysa', 'ZZ LI Sysadmin', 'x', 'admin', 1)").lastrowid
    ROLE = d.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZLI role', 'group')").lastrowid
    d.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)",
                  [(ROLE, i) for i in ("people.read", "people.details", "people.hod", "people.lm", "people.roster")])
    U["BGA"] = d.execute("INSERT INTO users(username, full_name, password_hash, role, admin_bg, admin_role_id) VALUES "
                         "('zzli-bga', 'ZZ LI BG admin', 'x', 'admin', ?, ?)", (BG, ROLE)).lastrowid
    d.execute("UPDATE users SET manager_id=? WHERE id=?", (U["M1"], U["P1"]))
    d.commit()
    SUPNAME = d.execute("SELECT full_name FROM users WHERE id=?", (SU["id"],)).fetchone()[0]
    ME = dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())

cS = H.client_as(a, SU["id"])
cB = H.client_as(a, U["BGA"])
cSys = H.client_as(a, U["SYSA"])


def _put_back():
    with a.app.app_context():
        d_ = a.get_db()
        _cleanup(d_)
        k = KEEP["cycle"]
        d_.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?",
                   (k["kind"], k["year"], k["half"], k["min_job_grade"], CID))
        d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_results'", (CID,))
        if KEEP.get("window"):
            d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_results', ?, ?)",
                       (CID,) + tuple(KEEP["window"]))
        d_.commit()
    for kind, toks in KEEP.get("tokens", {}).items():
        for t in toks:
            a._imp_unstage(kind, t)


atexit.register(_put_back)


def txt(r):
    return _html.unescape(r.get_data(as_text=True))


def lnk(c, uid, action, eid, **kw):
    return c.post(LINES % uid, data=dict({"csrf_token": "tok", "action": action, "eid": eid}, **kw), follow_redirects=True)


def active(uid):
    return [r[0] for r in rows("SELECT employee_id FROM user_employee_ids WHERE user_id=? AND removed_at IS NULL ORDER BY id", uid)]


def n_links():
    return one("SELECT COUNT(*) FROM user_employee_ids WHERE employee_id LIKE 'ZZLI%' OR user_id IN (SELECT id FROM users "
               "WHERE employee_id LIKE 'ZZLI%')")


def wipe_links():
    dbx("DELETE FROM user_employee_ids WHERE employee_id LIKE 'ZZLI%' OR user_id IN (SELECT id FROM users WHERE "
        "employee_id LIKE 'ZZLI%' OR username LIKE 'zzli%')")


def logged(action, uid):
    return one("SELECT COUNT(*) FROM activity_log WHERE action=? AND target_user_id=?", action, uid)


def page(c, uid):
    r = c.get("/admin/users/%d" % uid)
    return r.status_code, txt(r)


def box(pg):
    i = pg.find('id="employee-ids"')
    return pg[i: pg.find("<b>Work email</b>", i)] if i >= 0 else ""


def refused_then_ok(name, uid, eid, expect, fix, undo=None, c=None):
    """The request is refused with `expect` and nothing is linked; `fix` removes ONLY that condition; the same request
    then goes through (the guard is the reason, not the request)."""
    c = c or cS
    n0 = n_links()
    r = lnk(c, uid, "eid_link", eid)
    s.check("%s: refused, nothing linked" % name, expect in txt(r) and n_links() == n0 and eid not in active(uid),
            (expect, txt(r)[:0]))
    fix()
    r = lnk(c, uid, "eid_link", eid)
    s.check("   FALSIFY: with only that condition removed the same request links it", eid in active(uid), txt(r)[:0])
    if undo:
        undo()
    wipe_links()


# ---------------------------------------------------------------------------------------------------------------------
s.section("storage: the table, its partial unique index, and the schema step that puts it back")
src = H.source(a)
with a.app.app_context():
    d = a.get_db()
    cols = [r[1] for r in d.execute("PRAGMA table_info(user_employee_ids)")]
    idx = {r[1]: r[2] for r in d.execute("PRAGMA index_list(user_employee_ids)")}
s.check("user_employee_ids has the approved columns",
        cols == ["id", "user_id", "employee_id", "linked_at", "linked_by", "removed_at", "removed_by"], cols)
s.check("...a unique index on active IDs and an index on user_id",
        idx.get("idx_user_eids_active") == 1 and "idx_user_eids_user" in idx, idx)
import inspect  # noqa: E402
s.check("...in SCHEMA (fresh installs) and in _ensure_runtime_schema (the guarded step), both CREATE ... IF NOT EXISTS",
        "CREATE TABLE IF NOT EXISTS user_employee_ids" in a.SCHEMA
        and "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_eids_active" in a.SCHEMA
        and "CREATE TABLE IF NOT EXISTS user_employee_ids(" in inspect.getsource(a._ensure_runtime_schema)
        and "WHERE removed_at IS NULL" in inspect.getsource(a._ensure_runtime_schema))
with a.app.app_context():
    d = a.get_db()
    d.execute("DROP TABLE user_employee_ids")
    d.commit()
a._ensure_runtime_schema()
with a.app.app_context():
    d = a.get_db()
    s.check("a database without the table gets it back from _ensure_runtime_schema, with both indexes",
            bool(d.execute("SELECT 1 FROM sqlite_master WHERE name='user_employee_ids'").fetchone())
            and {"idx_user_eids_active", "idx_user_eids_user"} <= {r[1] for r in d.execute("PRAGMA index_list(user_employee_ids)")})
    d.execute("INSERT INTO user_employee_ids(user_id, employee_id, linked_at) VALUES (?, 'ZZLI-U1', datetime('now'))", (U["P1"],))
    d.commit()
    try:
        d.execute("INSERT INTO user_employee_ids(user_id, employee_id, linked_at) VALUES (?, 'ZZLI-U1', datetime('now'))", (U["P2"],))
        dup = False
    except Exception:  # noqa: BLE001 -- sqlite3.IntegrityError
        dup = True
    d.rollback()
    d.execute("UPDATE user_employee_ids SET removed_at=datetime('now') WHERE employee_id='ZZLI-U1'")
    d.execute("INSERT INTO user_employee_ids(user_id, employee_id, linked_at) VALUES (?, 'ZZLI-U1', datetime('now'))", (U["P2"],))
    d.commit()
    s.check("an ID can be actively linked once; once removed the same ID can be linked again (the old row stays)",
            dup and d.execute("SELECT COUNT(*) FROM user_employee_ids WHERE employee_id='ZZLI-U1'").fetchone()[0] == 2)
wipe_links()
with a.app.test_request_context("/"):
    dd = a.get_db()
    s.check("the audit trail has a label for each of the three actions",
            all(a.ACTION_LABELS.get(k) for k in ("eid_link", "eid_unlink", "eid_main"))
            and a.ACTION_LABELS["eid_link"] == "Linked an Employee ID to someone")

# ---------------------------------------------------------------------------------------------------------------------
s.section("the Employee IDs box: super admin and others")
code, pg = page(cS, U["P1"])
b = box(pg)
raw = cS.get("/admin/users/%d" % U["P1"]).get_data(as_text=True)
s.check("the box is the first thing in the Account panel, before Work email",
        code == 200 and 'id="employee-ids"' in pg and pg.index('id="employee-ids"') < pg.index("<b>Work email</b>"))
s.check("with no linked ID: 'Employee IDs · 1 on this person', the main ID with its chip, Link an ID, the note",
        "Employee IDs" in b and "1 on this person" in b and "ZZLI-P1" in b and "Main · signs in" in b
        and ">Link an ID</button>" in b and "Make main" not in b and "Remove" not in b
        and "Super admin only. Imports, People search and sign-in find them by any of these IDs." in b, b[:200])
s.check("...Link an ID is OneHR's own prompt, in the approved words, posting to the person's lines route",
        'data-prompt="Link another Employee ID to ZZ LI Pone. Type it as HRIS or the old system has it; it can\'t be anyone else\'s ID."'
        in _html.unescape(raw) and 'data-confirm-ok="Link this ID"' in raw and 'name="action" value="eid_link"' in raw
        and 'data-prompt-field="eid"' in raw and "confirm(" not in raw[raw.find('id="employee-ids"'): raw.find('id="employee-ids"') + 3000])
s.check("the Account summary line has no linked-ID count while there are none", "linked ID" not in
        pg[pg.find('id="account"'): pg.find('id="account"') + 700])
code, pgb = page(cB, U["P1"])
bb = box(pgb)
s.check("a BG admin who can open the person sees the box and the IDs but no buttons",
        code == 200 and "ZZLI-P1" in bb and "Main · signs in" in bb and "Link an ID" not in bb and 'name="action"' not in bb, code)

# ---------------------------------------------------------------------------------------------------------------------
s.section("Link an ID: the happy path")
r = lnk(cS, U["P1"], "eid_link", "  ZZLI-P1A ")
row = rows("SELECT * FROM user_employee_ids WHERE user_id=? AND removed_at IS NULL", U["P1"])
s.check("the ID is trimmed and linked to the person by the super admin, active",
        len(row) == 1 and row[0]["employee_id"] == "ZZLI-P1A" and row[0]["linked_by"] == SU["id"] and row[0]["removed_by"] is None
        and re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d", row[0]["linked_at"] or ""), [dict(x) for x in row])
s.check("...the page says so", "ZZLI-P1A is now linked to ZZ LI Pone" in txt(r) and "they still sign in with ZZLI-P1" in txt(r))
s.check("...one audit row, naming the person and both IDs, with the person as its target",
        logged("eid_link", U["P1"]) == 1 and one("SELECT detail FROM activity_log WHERE action='eid_link' AND target_user_id=?", U["P1"])
        == "ZZ LI Pone: Employee ID ZZLI-P1A linked (main ID ZZLI-P1)")
s.check("...the person's own account is untouched: main ID, sign-in name and password hash",
        rows("SELECT employee_id, username FROM users WHERE id=?", U["P1"])[0][:] == ("ZZLI-P1", "ZZLI-P1")
        and check_password_hash(one("SELECT password_hash FROM users WHERE id=?", U["P1"]), "ZZLI-P1-pw-test"))
code, pg = page(cS, U["P1"])
b = box(pg)
day = " ".join((a._myt_date_str(row[0]["linked_at"]) or "").split()[:2])
s.check("the box lists it: '2 on this person', 'linked by <super admin>, <d Mon>' (MYT), Make main and Remove",
        "2 on this person" in b and "ZZLI-P1A" in b and ("linked by %s, %s" % (SUPNAME, day)) in b
        and re.fullmatch(r"\d{1,2} [A-Z][a-z]{2}", day) and ">Make main</button>" in b and ">Remove</button>" in b, b[:400])
s.check("...and the Account summary line gains ' · 1 linked ID'",
        " · 1 linked ID" in pg[pg.find('id="account"'): pg.find('id="account"') + 700])
lnk(cS, U["P1"], "eid_link", "ZZLI-P1B")
code, pg = page(cS, U["P1"])
s.check("two linked: '3 on this person' and ' · 2 linked IDs'", "3 on this person" in box(pg)
        and " · 2 linked IDs" in pg[pg.find('id="account"'): pg.find('id="account"') + 700])
code, pgb = page(cB, U["P1"])
s.check("a BG admin sees the linked IDs and who linked them, still no Make main / Remove / Link",
        "ZZLI-P1A" in box(pgb) and "ZZLI-P1B" in box(pgb) and ">Make main<" not in box(pgb) and ">Remove<" not in box(pgb)
        and "Link an ID" not in box(pgb))
raw = cS.get("/admin/users/%d" % U["P1"]).get_data(as_text=True)
s.check("Make main and Remove are OneHR's own confirm boxes, in the approved words, Make main not danger",
        'data-confirm-ok="Make main"' in raw and 'data-confirm-ok="Remove"' in raw
        and "Make ZZLI-P1A the main Employee ID for ZZ LI Pone? They sign in with ZZLI-P1A from now on, not ZZLI-P1. Their "
            "password doesn't change. ZZLI-P1 stays linked, so imports still find them. Pages, downloads and new audit "
            "rows show ZZLI-P1A; older audit rows keep the ID they were written with. OneHR sends them nothing: tell them "
            "their new sign-in ID first." in _html.unescape(raw)
        and "Take ZZLI-P1A off ZZ LI Pone? Imports stop finding them by it. You can link it again later." in _html.unescape(raw)
        and "data-confirm-tone" not in raw[raw.find('id="employee-ids"'): raw.find("<b>Work email</b>")]
        and 'name="action" value="eid_main"' in raw and 'name="action" value="eid_unlink"' in raw)
lnk(cS, U["P3"], "eid_link", "ZZLI-P3A")
raw3 = _html.unescape(cS.get("/admin/users/%d" % U["P3"]).get_data(as_text=True))
s.check("...a person whose sign-in name is not their ID is told it stays, instead of 'they sign in with <ID>'",
        "Their sign-in name (zzli_p3_login) isn't their Employee ID, so it stays as it is." in raw3
        and "They sign in with ZZLI-P3A from now on" not in raw3)
frag = cS.get("/admin/users/%d?tab=overview&fragment=1" % U["P1"])
s.check("the person-in-brief panel (the People list's) carries the count too",
        frag.status_code == 200 and " · 2 linked IDs" in _html.unescape(frag.get_data(as_text=True)), frag.status_code)
wipe_links()

# ---------------------------------------------------------------------------------------------------------------------
s.section("Link an ID: every refusal, each falsified")
refused_then_ok("another account's Employee ID", U["P1"], "ZZLI-P2",
                "ZZLI-P2 is ZZ LI Ptwo's Employee ID, so it can't be linked to ZZ LI Pone. Nothing changed.",
                lambda: dbx("UPDATE users SET employee_id='ZZLI-P2X', username='ZZLI-P2X' WHERE id=?", U["P2"]),
                lambda: dbx("UPDATE users SET employee_id='ZZLI-P2', username='ZZLI-P2' WHERE id=?", U["P2"]))
refused_then_ok("...in another case (zzli-p2)", U["P1"], "zzli-p2",
                "ZZLI-P2 is ZZ LI Ptwo's Employee ID, so it can't be linked to ZZ LI Pone. Nothing changed.",
                lambda: dbx("UPDATE users SET employee_id='ZZLI-P2X', username='ZZLI-P2X' WHERE id=?", U["P2"]),
                lambda: dbx("UPDATE users SET employee_id='ZZLI-P2', username='ZZLI-P2' WHERE id=?", U["P2"]))
refused_then_ok("an admin account's sign-in name", U["P1"], "zzli-adm",
                "zzli-adm is ZZ LI Admin's sign-in ID, so it can't be linked to ZZ LI Pone. Nothing changed.",
                lambda: dbx("UPDATE users SET username='zzli-adm2' WHERE id=?", U["ADM"]),
                lambda: dbx("UPDATE users SET username='zzli-adm' WHERE id=?", U["ADM"]))
refused_then_ok("a person's sign-in name that is not their ID", U["P1"], "zzli_p3_login",
                "zzli_p3_login is ZZ LI Pthree's sign-in ID, so it can't be linked to ZZ LI Pone. Nothing changed.",
                lambda: dbx("UPDATE users SET username='zzli_p3_other' WHERE id=?", U["P3"]),
                lambda: dbx("UPDATE users SET username='zzli_p3_login' WHERE id=?", U["P3"]))
refused_then_ok("an account that has left", U["P1"], "ZZLI-LEFT",
                "ZZLI-LEFT belongs to an account that has left (ZZ LI Leaver). Linking doesn't join two accounts; ask for it "
                "to be retired first.",
                lambda: dbx("UPDATE users SET employee_id='ZZLI-LEFTX', username='ZZLI-LEFTX' WHERE id=?", U["LEFT"]),
                lambda: dbx("UPDATE users SET employee_id='ZZLI-LEFT', username='ZZLI-LEFT' WHERE id=?", U["LEFT"]))
dbx("UPDATE users SET employee_id='ZZLI-RET~retired-1', username='ZZLI-RET~retired-1' WHERE id=?", U["LEFT"])
n0 = n_links()
r = lnk(cS, U["P1"], "eid_link", "ZZLI-RET~retired-1")
s.check("a retired account's ID (X~retired-N) is refused", n_links() == n0 and "can't contain ~" in txt(r))
r = lnk(cS, U["P1"], "eid_link", "ZZLI-RET1")
s.check("   FALSIFY: without the ~ the same ID links", "ZZLI-RET1" in active(U["P1"]))
dbx("UPDATE users SET employee_id='ZZLI-LEFT', username='ZZLI-LEFT' WHERE id=?", U["LEFT"])
wipe_links()

# an ID that is someone else's active link
lnk(cS, U["P2"], "eid_link", "ZZLI-SHARED")
refused_then_ok("an ID already linked to someone else", U["P1"], "ZZLI-SHARED",
                "ZZLI-SHARED is already linked to ZZ LI Ptwo. Remove it there first.",
                lambda: lnk(cS, U["P2"], "eid_unlink", "ZZLI-SHARED"), None)
lnk(cS, U["P2"], "eid_link", "ZZLI-SHARED")
refused_then_ok("...in another case (zzli-shared)", U["P1"], "zzli-shared",
                "ZZLI-SHARED is already linked to ZZ LI Ptwo. Remove it there first.",
                lambda: lnk(cS, U["P2"], "eid_unlink", "ZZLI-SHARED"), None)
lnk(cS, U["P1"], "eid_link", "ZZLI-SHARED")
lnk(cS, U["P1"], "eid_link", "ZZLI-SHARED")
n0 = n_links()
r = lnk(cS, U["P1"], "eid_link", "zzli-shared")
s.check("an ID already linked to this person (any case) is refused, nothing new linked",
        "ZZLI-SHARED is already linked to ZZ LI Pone. Nothing changed." in txt(r) and n_links() == n0)
lnk(cS, U["P1"], "eid_unlink", "ZZLI-SHARED")
r = lnk(cS, U["P1"], "eid_link", "zzli-shared")
s.check("   FALSIFY: once removed it links (stored as typed)", active(U["P1"]) == ["zzli-shared"])
wipe_links()
refused_then_ok("their own main ID", U["P1"], "ZZLI-P1",
                "ZZLI-P1 is already ZZ LI Pone's main Employee ID. Nothing changed.",
                lambda: dbx("UPDATE users SET employee_id='ZZLI-P1M', username='ZZLI-P1M' WHERE id=?", U["P1"]),
                lambda: dbx("UPDATE users SET employee_id='ZZLI-P1', username='ZZLI-P1' WHERE id=?", U["P1"]))

# shape: blank, whitespace, over the length, a ~
n0 = n_links()
for label, bad, good, msg in (("blank", "", "ZZLI-OKB", "Type the Employee ID to link."),
                              ("one with a space inside", "ZZLI OK", "ZZLI-OKS", "no spaces"),
                              ("one with a tab inside", "ZZLI\tOK", "ZZLI-OKT", "no spaces"),
                              ("a ~", "ZZLI~OK", "ZZLI-OKX", "can't contain ~"),
                              ("41 characters", "ZZLI" + "9" * 37, "ZZLI" + "9" * 36, "at most 40 characters")):
    r = lnk(cS, U["P1"], "eid_link", bad)
    s.check("%s is refused (%s), nothing linked" % (label, msg), msg in txt(r) and n_links() == n0 and not active(U["P1"]))
    r = lnk(cS, U["P1"], "eid_link", good)
    s.check("   FALSIFY: %s -> %s links" % (label, good), good in active(U["P1"]))
    wipe_links()

# an admin account or a demo login has no Employee ID of its own to change; a non-super admin is refused outright
with a.app.test_request_context("/"):
    dd = a.get_db()
    meS = dict(dd.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
    meB = dd.execute("SELECT * FROM users WHERE id=?", (U["BGA"],)).fetchone()
    adm = dd.execute("SELECT * FROM users WHERE id=?", (U["ADM"],)).fetchone()
    dem = dd.execute("SELECT * FROM users WHERE id=?", (U["DEMO"],)).fetchone()
    p1 = dd.execute("SELECT * FROM users WHERE id=?", (U["P1"],)).fetchone()
    ok_a, m_a = a._eid_link(dd, meS, adm, "ZZLI-ADMX")
    ok_d, m_d = a._eid_link(dd, meS, dem, "ZZLI-DEMX")
    ok_n, m_n = a._eid_link(dd, meB, p1, "ZZLI-NOSU")
    ok_g, m_g = a._eid_link(dd, meS, p1, "ZZLI-GOOD")
    dd.rollback()
s.check("an admin account is refused ('Pick a person from the list.')", not ok_a and m_a == "Pick a person from the list.", m_a)
s.check("a demo login is refused", not ok_d and m_d == "Pick a person from the list.", m_d)
s.check("the function itself refuses anyone who is not the super admin", not ok_n and m_n == ONLY_SUPER, m_n)
s.check("   FALSIFY: the same call for a real person by the super admin works", ok_g, m_g)
r = cS.post(LINES % U["ADM"], data={"csrf_token": "tok", "action": "eid_link", "eid": "ZZLI-ADMX"})
s.check("an admin account is not a person page at all (404)", r.status_code == 404 and not rows(
    "SELECT 1 FROM user_employee_ids WHERE employee_id='ZZLI-ADMX'"), r.status_code)
wipe_links()

# non-super admin, over HTTP
lnk(cS, U["P1"], "eid_link", "ZZLI-BG1")
for act_, extra in (("eid_link", "ZZLI-BGX"), ("eid_unlink", "ZZLI-BG1"), ("eid_main", "ZZLI-BG1")):
    r = cB.post(LINES % U["P1"], data={"csrf_token": "tok", "action": act_, "eid": extra})
    s.check("a BG admin gets 403 on %s" % act_, r.status_code == 403, r.status_code)
s.check("...nothing changed: ZZLI-BG1 still linked, ZZLI-BGX not, main ID the same",
        active(U["P1"]) == ["ZZLI-BG1"] and one("SELECT employee_id FROM users WHERE id=?", U["P1"]) == "ZZLI-P1")
r = cS.post(LINES % U["P1"], data={"action": "eid_link", "eid": "ZZLI-NOCSRF"})
s.check("a write without the CSRF token is refused", r.status_code == 400 and "ZZLI-NOCSRF" not in active(U["P1"]), r.status_code)
s.check("the three actions are the super admin's in the access map, and the Roles & access page names them",
        all(a.ADMIN_ACCESS_MAP["admin_person_lines"]["map"].get(k) == "super" for k in ("eid_link", "eid_unlink", "eid_main"))
        and any("Employee ID" in x for x in a.ADMIN_SUPER_ROWS["people"]))
rp = txt(cS.get("/admin/roles"))
s.check("no role tick and no user-role row: nothing in ADMIN_ITEMS or UROLE_MODULES is about Employee IDs",
        not [i for i in a.ADMIN_ITEMS if "employee id" in str(i).lower() or "linked" in str(i).lower()]
        and "employee id" not in str(a.UROLE_MODULES).lower(), "")
s.check("the Roles & access page lists it among what only the super admin does",
        "Linking another Employee ID to a person, removing one, and choosing the main ID" in rp, rp[:0])
wipe_links()

# the system admin's account stays theirs
r = lnk(cS, U["SYSP"], "eid_link", "ZZLI-SYS1")
s.check("a super admin who is not a system admin can't link an ID to a system admin's account: the lock sentence",
        LOCK in txt(r) and not active(U["SYSP"]))
r = lnk(cSys, U["SYSP"], "eid_link", "ZZLI-SYS1")
s.check("   FALSIFY: a system admin can", active(U["SYSP"]) == ["ZZLI-SYS1"])
r = lnk(cS, U["SYSP"], "eid_unlink", "ZZLI-SYS1")
s.check("...and Remove is locked the same way", LOCK in txt(r) and active(U["SYSP"]) == ["ZZLI-SYS1"])
r = lnk(cS, U["SYSP"], "eid_main", "ZZLI-SYS1")
s.check("...and Make main", LOCK in txt(r) and one("SELECT employee_id FROM users WHERE id=?", U["SYSP"]) == "ZZLI-SYSP")
r = lnk(cSys, U["SYSP"], "eid_main", "ZZLI-SYS1")
s.check("   FALSIFY: a system admin makes it main", one("SELECT employee_id FROM users WHERE id=?", U["SYSP"]) == "ZZLI-SYS1")
r = lnk(cSys, U["SYSP"], "eid_main", "ZZLI-SYSP")
r = lnk(cSys, U["SYSP"], "eid_unlink", "ZZLI-SYS1")
s.check("...and Remove (back to the first ID, then off)", one("SELECT employee_id FROM users WHERE id=?", U["SYSP"]) == "ZZLI-SYSP"
        and "ZZLI-SYS1" not in active(U["SYSP"]))
wipe_links()
guard_src = src[src.index("def _eid_gate"): src.index("def _eid_link(")]
s.check("the shared gate carries the system-admin guard, and all three writers call it",
        "_system_admin_locked(" in guard_src and all(
            "_eid_gate(" in src[src.index("def " + fn + "("): src.index("def " + fn + "(") + 2200]
            for fn in ("_eid_link", "_eid_unlink", "_eid_make_main")))

# ---------------------------------------------------------------------------------------------------------------------
s.section("Make main: the happy path (the username follows), and its refusals")
lnk(cS, U["P1"], "eid_link", "ZZLI-P1A")
dbx("INSERT INTO login_attempts(username, ip) VALUES ('ZZLI-P1', '127.0.0.1'), ('ZZLI-P1', '127.0.0.1'), ('zzli-other', '1')")
hash0 = one("SELECT password_hash FROM users WHERE id=?", U["P1"])
r = lnk(cS, U["P1"], "eid_main", "ZZLI-P1A")
u1 = rows("SELECT employee_id, username, password_hash FROM users WHERE id=?", U["P1"])[0]
s.check("the person's Employee ID and sign-in name are now the new ID", u1["employee_id"] == "ZZLI-P1A" and u1["username"] == "ZZLI-P1A", tuple(u1)[:2])
s.check("...the password hash is untouched", u1["password_hash"] == hash0 and check_password_hash(u1["password_hash"], "ZZLI-P1-pw-test"))
s.check("...the old main ID is now an active linked ID, linked by the super admin; the new one's link is closed (kept)",
        active(U["P1"]) == ["ZZLI-P1"]
        and rows("SELECT removed_at, removed_by FROM user_employee_ids WHERE employee_id='ZZLI-P1A'")[0]["removed_by"] == SU["id"]
        and rows("SELECT linked_by FROM user_employee_ids WHERE employee_id='ZZLI-P1' AND removed_at IS NULL")[0][0] == SU["id"])
s.check("...failed sign-ins under the old name are cleared (another name's stay)",
        one("SELECT COUNT(*) FROM login_attempts WHERE username='ZZLI-P1'") == 0 and one(
            "SELECT COUNT(*) FROM login_attempts WHERE username='zzli-other'") == 1)
s.check("...one audit row naming the person, both IDs, with the person as its target",
        logged("eid_main", U["P1"]) == 1 and one("SELECT detail FROM activity_log WHERE action='eid_main' AND target_user_id=?", U["P1"])
        == "ZZ LI Pone: main Employee ID ZZLI-P1 -> ZZLI-P1A (ZZLI-P1 stays linked)")
s.check("...the page says who signs in with what, and that OneHR sent nothing",
        "ZZLI-P1A is now ZZ LI Pone's main Employee ID. They sign in with ZZLI-P1A; ZZLI-P1 stays linked" in txt(r)
        and "OneHR sent them nothing" in txt(r))
code, pg = page(cS, U["P1"])
b = box(pg)
s.check("the box shows the new main with its chip and the old one as linked",
        b.index("<b>ZZLI-P1A</b>") < b.index("Main · signs in") < b.index("<b>ZZLI-P1</b>") and "linked by" in b, b[:300])


def signin(username):
    c_ = a.app.test_client()
    with c_.session_transaction() as ss:
        ss["csrf_token"] = "tok"
    return c_.post("/login", data={"csrf_token": "tok", "username": username, "password": "ZZLI-P1-pw-test"})


r_new, r_old = signin("ZZLI-P1A"), signin("ZZLI-P1")
# (2026-11-03, "Use linked ID": the old ID is a linked ID now, and a linked ID signs in too: test_linked_id_signin)
s.check("they sign in with the new ID and their unchanged password; the old ID, now linked, signs in to the same account",
        r_new.status_code == 302 and "/login" not in r_new.headers.get("Location", "/login")
        and r_old.status_code == 302 and "/login" not in r_old.headers.get("Location", "/login"),
        (r_new.status_code, r_new.headers.get("Location"), r_old.status_code, r_old.headers.get("Location")))
with a.app.test_request_context("/"):
    dd = a.get_db()
    via = a._eid_resolve(dd, "ZZLI-P1")
    main = a._eid_resolve(dd, "ZZLI-P1A")
s.check("imports now find the old ID as a linked one and the new as the main one",
        via[0]["id"] == U["P1"] and via[1] is True and main[0]["id"] == U["P1"] and main[1] is False)
r = lnk(cS, U["P1"], "eid_main", "ZZLI-P1")
s.check("and back again: the first ID is main, the second linked, a second audit row",
        rows("SELECT employee_id, username FROM users WHERE id=?", U["P1"])[0][:] == ("ZZLI-P1", "ZZLI-P1A".replace("A", ""))
        and active(U["P1"]) == ["ZZLI-P1A"] and logged("eid_main", U["P1"]) == 2)

# the username is not their Employee ID: it stays, and the message says so
lnk(cS, U["P3"], "eid_link", "ZZLI-P3A")
r = lnk(cS, U["P3"], "eid_main", "ZZLI-P3A")
u3 = rows("SELECT employee_id, username FROM users WHERE id=?", U["P3"])[0]
s.check("a sign-in name that was not their Employee ID stays; the Employee ID changes",
        u3["employee_id"] == "ZZLI-P3A" and u3["username"] == "zzli_p3_login", tuple(u3))
s.check("...and the page says so", "Their sign-in name wasn't their Employee ID, so it stays zzli_p3_login." in txt(r))
s.check("...the audit row says the sign-in name was unchanged", "sign-in name zzli_p3_login unchanged" in one(
    "SELECT detail FROM activity_log WHERE action='eid_main' AND target_user_id=?", U["P3"]))
lnk(cS, U["P3"], "eid_main", "ZZLI-P3")
dbx("UPDATE users SET username='zzli_p3_login' WHERE id=?", U["P3"])
wipe_links()

# one transaction: a clash found while writing leaves everything as it was
lnk(cS, U["P1"], "eid_link", "ZZLI-P1A")
snap = rows("SELECT employee_id, username, password_hash FROM users WHERE id=?", U["P1"])[0][:]
dbx("INSERT INTO user_employee_ids(user_id, employee_id, linked_at) VALUES (?, 'ZZLI-P1', datetime('now'))", U["P2"])  # a race: the old ID got linked elsewhere
r = lnk(cS, U["P1"], "eid_main", "ZZLI-P1A")
s.check("if writing it hits a clash it is refused whole: nothing of it is kept",
        "couldn't be made main" in txt(r) and rows("SELECT employee_id, username, password_hash FROM users WHERE id=?", U["P1"])[0][:] == snap
        and active(U["P1"]) == ["ZZLI-P1A"] and logged("eid_main", U["P1"]) == 2)
wipe_links()

# Make main refusals
lnk(cS, U["P1"], "eid_link", "ZZLI-P1A")
lnk(cS, U["P2"], "eid_link", "ZZLI-P2A")
lnk(cS, U["P1"], "eid_link", "ZZLI-P1R")
lnk(cS, U["P1"], "eid_unlink", "ZZLI-P1R")
state = lambda: (rows("SELECT employee_id, username FROM users WHERE id=?", U["P1"])[0][:], active(U["P1"]), active(U["P2"]))  # noqa: E731
st0 = state()
for label, eid_, msg in (("an ID that isn't linked to them", "ZZLI-NOPE", "ZZLI-NOPE isn't one of ZZ LI Pone's linked IDs."),
                         ("another person's linked ID", "ZZLI-P2A", "ZZLI-P2A isn't one of ZZ LI Pone's linked IDs."),
                         ("an ID that was removed", "ZZLI-P1R", "ZZLI-P1R isn't one of ZZ LI Pone's linked IDs."),
                         ("their own main ID", "ZZLI-P1", "ZZLI-P1 is already ZZ LI Pone's main Employee ID."),
                         ("a blank", "", "That ID isn't one of ZZ LI Pone's linked IDs.")):
    r = lnk(cS, U["P1"], "eid_main", eid_)
    s.check("Make main of %s is refused, nothing changes" % label, msg in txt(r) and state() == st0, msg)
dbx("UPDATE users SET employee_id='ZZLI-P2OLD', username='ZZLI-P2OLD' WHERE id=?", U["P2"])
dbx("UPDATE users SET employee_id='ZZLI-P2', username='ZZLI-P2' WHERE id=?", U["P2"])
# the ID became someone else's Employee ID after it was linked: it can't be made main
dbx("UPDATE users SET employee_id='ZZLI-P1A', username='ZZLI-P1A' WHERE id=?", U["PX"])
r = lnk(cS, U["P1"], "eid_main", "ZZLI-P1A")
s.check("an ID someone else now holds as their Employee ID can't be made main",
        "ZZLI-P1A is ZZ LI Pxtra's Employee ID now, so it can't be made main" in txt(r)
        and one("SELECT employee_id FROM users WHERE id=?", U["P1"]) == "ZZLI-P1")
dbx("UPDATE users SET employee_id='ZZLI-PX', username='ZZLI-PX' WHERE id=?", U["PX"])
r = lnk(cS, U["P1"], "eid_main", "ZZLI-P1A")
s.check("   FALSIFY: with that condition gone the same Make main works", one("SELECT employee_id FROM users WHERE id=?", U["P1"]) == "ZZLI-P1A")
lnk(cS, U["P1"], "eid_main", "ZZLI-P1")
wipe_links()

# ---------------------------------------------------------------------------------------------------------------------
s.section("Make main: the sign-in name follows in any case (sign-in matches the username exactly)")
for k_, eid_, uname_ in (("L1", "ZZLI-L1", "zzli-l1"), ("L2", "ZZLI-L2", "Zzli-L2"), ("L3", "ZZLI-L3", "zzli_l3_unrelated"),
                         ("C1", "ZZLI-C1", "zzli-c1"), ("O1", "ZZLI-O1", "zzli-o1")):
    with a.app.app_context():
        dd = a.get_db()
        U[k_] = dd.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, "
                           "job_grade, confirmation_date) VALUES (?,?,?, 'user', ?,?,?, 20, '2020-01-01')",
                           (uname_, "ZZ LI " + k_, generate_password_hash("ZZLI-pw-1", method="pbkdf2:sha256"), eid_, BG, CO)).lastrowid
        dd.commit()
with a.app.test_request_context("/"):
    f_ = a._eid_follow_username
    s.check("the one rule: exact -> new exactly; lower-case -> new in lower case; another case variant -> new; unrelated / blank -> stays",
            f_("ZZLI-L1", "ZZLI-L1", "ZZLI-L1A") == "ZZLI-L1A" and f_("zzli-l1", "ZZLI-L1", "ZZLI-L1A") == "zzli-l1a"
            and f_("Zzli-L1", "ZZLI-L1", "ZZLI-L1A") == "ZZLI-L1A" and f_("other", "ZZLI-L1", "ZZLI-L1A") is None
            and f_("", "ZZLI-L1", "ZZLI-L1A") is None and f_("zzli-l1", "", "X") is None)


def signin2(username, pw="ZZLI-pw-1"):
    c_ = a.app.test_client()
    with c_.session_transaction() as ss:
        ss["csrf_token"] = "tok"
    r_ = c_.post("/login", data={"csrf_token": "tok", "username": username, "password": pw})
    return r_.status_code == 302 and "/login" not in r_.headers.get("Location", "/login")


def uname(k_):
    return rows("SELECT employee_id, username FROM users WHERE id=?", U[k_])[0][:]


# a lower-case username (the convention for many accounts)
lnk(cS, U["L1"], "eid_link", "ZZLI-L1A")
dbx("INSERT INTO login_attempts(username, ip) VALUES ('zzli-l1', '1'), ('zzli-l1a', '1')")
raw1 = _html.unescape(cS.get("/admin/users/%d" % U["L1"]).get_data(as_text=True))
s.check("the confirm box names the actual new sign-in name (lower case) and the one it replaces",
        "They sign in with zzli-l1a from now on, not zzli-l1." in raw1 and "isn't their Employee ID" not in raw1.split("Make ZZLI-L1A")[1][:700])
s.check("before: they sign in with the old name", signin2("zzli-l1") and not signin2("zzli-l1a"))
r = lnk(cS, U["L1"], "eid_main", "ZZLI-L1A")
s.check("Make main moves the lower-case username to the new ID in lower case", uname("L1") == ("ZZLI-L1A", "zzli-l1a"), uname("L1"))
s.check("...failed sign-ins under both names are cleared", one("SELECT COUNT(*) FROM login_attempts WHERE username IN "
                                                              "('zzli-l1','zzli-l1a')") == 0)
s.check("...they sign in with it and their old password; the old name no longer signs in",
        signin2("zzli-l1a") and not signin2("zzli-l1") and not signin2("ZZLI-L1A"))
s.check("...the page and the audit row name the actual sign-in name",
        "They sign in with zzli-l1a;" in txt(r) and "sign-in name zzli-l1 -> zzli-l1a" in one(
            "SELECT detail FROM activity_log WHERE action='eid_main' AND target_user_id=? ORDER BY id DESC LIMIT 1", U["L1"]))
r = lnk(cS, U["L1"], "eid_main", "ZZLI-L1")
s.check("...and back: the lower-case convention is kept", uname("L1") == ("ZZLI-L1", "zzli-l1") and signin2("zzli-l1"))

# exactly the old ID, and another case variant
lnk(cS, U["L2"], "eid_link", "ZZLI-L2A")
lnk(cS, U["L2"], "eid_main", "ZZLI-L2A")
s.check("a username that is the old ID in another case variant becomes the new ID exactly", uname("L2") == ("ZZLI-L2A", "ZZLI-L2A"), uname("L2"))

# unrelated username
lnk(cS, U["L3"], "eid_link", "ZZLI-L3A")
r = lnk(cS, U["L3"], "eid_main", "ZZLI-L3A")
s.check("a username unrelated to the ID stays, and the page says so",
        uname("L3") == ("ZZLI-L3A", "zzli_l3_unrelated") and "Their sign-in name wasn't their Employee ID, so it stays zzli_l3_unrelated." in txt(r)
        and signin2("zzli_l3_unrelated"))

# another account holds the new username in a different case
lnk(cS, U["C1"], "eid_link", "ZZLI-C1A")
dbx("UPDATE users SET username='zzli-c1a' WHERE id=?", U["O1"])      # a different case from ZZLI-C1A / zzli-c1a is the same name
dbx("UPDATE users SET username='ZZLI-c1A' WHERE id=?", U["O1"])
snapc = uname("C1")
r = lnk(cS, U["C1"], "eid_main", "ZZLI-C1A")
s.check("another account holding the new name in a different case refuses it, nothing changes",
        "ZZLI-C1A is ZZ LI O1's Employee ID now, so it can't be made main" in txt(r) and uname("C1") == snapc
        and active(U["C1"]) == ["ZZLI-C1A"], txt(r)[:0])
dbx("UPDATE users SET username='zzli-o1' WHERE id=?", U["O1"])
r = lnk(cS, U["C1"], "eid_main", "ZZLI-C1A")
s.check("   FALSIFY: with that account's username changed the same Make main works", uname("C1") == ("ZZLI-C1A", "zzli-c1a"), uname("C1"))
wipe_links()

# ---------------------------------------------------------------------------------------------------------------------
s.section("Remove: soft, the main ID can't be removed")
lnk(cS, U["P1"], "eid_link", "ZZLI-P1A")
lnk(cS, U["P2"], "eid_link", "ZZLI-P2A")
n_rows = one("SELECT COUNT(*) FROM user_employee_ids")
r = lnk(cS, U["P1"], "eid_unlink", "ZZLI-P1A")
rw = rows("SELECT * FROM user_employee_ids WHERE employee_id='ZZLI-P1A'")
s.check("Remove keeps the row, with removed_at and removed_by; no longer active", len(rw) == 1 and rw[0]["removed_at"]
        and rw[0]["removed_by"] == SU["id"] and active(U["P1"]) == [] and one("SELECT COUNT(*) FROM user_employee_ids") == n_rows)
s.check("...the page says so, and one audit row names the person and the ID",
        "ZZLI-P1A is off ZZ LI Pone. Imports stop finding them by it; you can link it again later." in txt(r)
        and one("SELECT detail FROM activity_log WHERE action='eid_unlink' AND target_user_id=? ORDER BY id DESC LIMIT 1", U["P1"])
        == "ZZ LI Pone: linked Employee ID ZZLI-P1A removed (main ID ZZLI-P1)")
with a.app.test_request_context("/"):
    dd = a.get_db()
    gone = a._eid_resolve(dd, "ZZLI-P1A")
s.check("...imports stop finding them by it", gone == (None, False))
r = lnk(cS, U["P1"], "eid_link", "ZZLI-P1A")
s.check("...and it can be linked again (a new row; the removed one stays)", active(U["P1"]) == ["ZZLI-P1A"] and one(
    "SELECT COUNT(*) FROM user_employee_ids WHERE employee_id='ZZLI-P1A'") == 2)
for label, eid_, msg in (("the main ID", "ZZLI-P1", "ZZLI-P1 is ZZ LI Pone's main Employee ID; it can't be removed."),
                         ("an ID that isn't linked", "ZZLI-NOPE", "ZZLI-NOPE isn't one of ZZ LI Pone's linked IDs."),
                         ("another person's linked ID", "ZZLI-P2A", "ZZLI-P2A isn't one of ZZ LI Pone's linked IDs."),
                         ("an ID already removed", "ZZLI-NEVER", "isn't one of ZZ LI Pone's linked IDs.")):
    n0 = one("SELECT COUNT(*) FROM user_employee_ids WHERE removed_at IS NULL")
    r = lnk(cS, U["P1"], "eid_unlink", eid_)
    s.check("Remove of %s is refused, nothing changes" % label, msg in txt(r)
            and one("SELECT COUNT(*) FROM user_employee_ids WHERE removed_at IS NULL") == n0
            and one("SELECT employee_id FROM users WHERE id=?", U["P1"]) == "ZZLI-P1")
r = lnk(cS, U["P1"], "eid_unlink", "ZZLI-P1A")
s.check("   FALSIFY: the active linked ID is the one thing that goes", active(U["P1"]) == [])
code, pg = page(cS, U["P1"])
s.check("the main ID row has no Remove or Make main button", "Main · signs in" in box(pg) and ">Remove<" not in box(pg)
        and ">Make main<" not in box(pg))
wipe_links()

# ---------------------------------------------------------------------------------------------------------------------
s.section("the other way: no second account is made with someone's linked ID")
lnk(cS, U["P1"], "eid_link", "ZZLI-NEWP")
n_users = one("SELECT COUNT(*) FROM users")
with a.app.app_context():
    pass
ADD = {"csrf_token": "tok", "action": "add_user", "employee_id": "ZZLI-NEWP", "full_name": "ZZ LI New",
       "business_group": BG, "company": CO, "manager_eid": "ZZLI-M1", "hod_eid": "ZZLI-H1", "job_grade": "20",
       "joined_date": "2026-10-01", "employment_type": "Permanent", "job_title": "__new__",
       "job_title_new": "Zqvplant Zqvli Executive", "department": "__new__", "department_new": "ZZLI Zqvplant"}
r = cS.post("/admin/users", data=ADD, follow_redirects=True)
s.check("Add a person with a linked ID is refused, and says whose it is",
        "'ZZLI-NEWP' is already linked to ZZ LI Pone as another Employee ID" in txt(r) and one("SELECT COUNT(*) FROM users") == n_users
        and not rows("SELECT 1 FROM users WHERE employee_id='ZZLI-NEWP'"))
lnk(cS, U["P1"], "eid_unlink", "ZZLI-NEWP")
r = cS.post("/admin/users", data=ADD, follow_redirects=True)
s.check("   FALSIFY: once removed, the same Add creates the person (so the refusal above was the link)",
        bool(rows("SELECT 1 FROM users WHERE employee_id='ZZLI-NEWP'")), txt(r)[:300])
dbx("DELETE FROM activity_log WHERE detail LIKE '%ZZLI-NEWP%'")
dbx("DELETE FROM users WHERE employee_id='ZZLI-NEWP'")
lnk(cS, U["P1"], "eid_link", "zzli-newadm")
with a.app.test_request_context("/"):
    dd = a.get_db()
    s.check("the one shared check (_eid_link_owner) names the owner, case ignored, and sees a removed link as free",
            a._eid_link_owner(dd, "ZZLI-NEWADM") == "ZZ LI Pone" and a._eid_link_owner(dd, "nobody-has-this") is None)
r = cS.post("/admin/admins", data={"csrf_token": "tok", "username": "zzli-newadm", "password": "Brand-new-pw-1",
                                   "role_id": str(ROLE), "business_group": BG}, follow_redirects=True)
s.check("a new admin account can't take someone's linked ID as its sign-in name",
        not rows("SELECT 1 FROM users WHERE username='zzli-newadm'") and "already exists" in txt(r))
wipe_links()

# ---------------------------------------------------------------------------------------------------------------------
s.section("People search finds a person by an active linked ID")
lnk(cS, U["P1"], "eid_link", "ZZLI-P1ZED")
lnk(cS, U["P1"], "eid_link", "ZZLI-P1GONE")
lnk(cS, U["P1"], "eid_unlink", "ZZLI-P1GONE")


def find(q, c=cS):
    return c.get("/admin/people/find.json?q=" + q).get_json()["people"]


f = find("ZZLI-P1ZED")
s.check("the people picker (find.json) finds them by a linked ID, and shows their main ID",
        [(x["eid"], x["name"]) for x in f] == [("ZZLI-P1", "ZZ LI Pone")], f)
s.check("...by part of it, not by a removed one", [x["eid"] for x in find("p1ze")] == ["ZZLI-P1"] and find("ZZLI-P1GONE") == [])
s.check("...a BG admin's picker, scoped to their group, finds it too; someone else's linked ID finds nobody else",
        [x["eid"] for x in find("ZZLI-P1ZED", cB)] == ["ZZLI-P1"] and "ZZLI-P2" not in [x["eid"] for x in f])
dbx("DELETE FROM user_employee_ids WHERE employee_id='ZZLI-P1ZED'")
s.check("   FALSIFY: with the link gone the same search finds nobody", find("ZZLI-P1ZED") == [])
lnk(cS, U["P1"], "eid_link", "ZZLI-P1ZED")
lst = cS.get("/admin/users?q=ZZLI-P1ZED&qin=eid&show=all")
s.check("the People list finds them by it in Search in › Employee ID, and in All fields",
        lst.status_code == 200 and "ZZ LI Pone" in lst.get_data(as_text=True)
        and "ZZ LI Pone" in cS.get("/admin/users?q=ZZLI-P1ZED&show=all").get_data(as_text=True)
        and "ZZ LI Pone" not in cS.get("/admin/users?q=ZZLI-P1ZED&qin=name&show=all").get_data(as_text=True))
lst = cS.get("/admin/leaders/people?q=ZZLI-P1ZED&bg=" + BG).get_json()
s.check("the Leaders people picker finds them", [x["eid"] for x in lst["people"]] == ["ZZLI-P1"], lst)
lst = cS.get("/admin/reminders/people.json?q=ZZLI-P1ZED").get_json()
s.check("the reminders picker finds them", [x["eid"] for x in lst["results"]] == ["ZZLI-P1"], lst)
with a.app.test_request_context("/"):
    dd = a.get_db()
    p1row = dict(dd.execute("SELECT * FROM users WHERE id=?", (U["P1"],)).fetchone())
    s.check("the Python mirror (people_search_match) finds them by it in All fields and Employee ID, not in Name",
            a.people_search_match("all", "p1zed", p1row) and a.people_search_match("eid", "ZZLI-P1ZED", p1row)
            and not a.people_search_match("name", "p1zed", p1row) and not a.people_search_match("all", "zzli-nope", p1row))
wipe_links()

# ---------------------------------------------------------------------------------------------------------------------
s.section("one batched resolver")
lnk(cS, U["P1"], "eid_link", "ZZLI-P1A")
lnk(cS, U["M1"], "eid_link", "ZZLI-M1A")
with a.app.test_request_context("/"):
    dd = a.get_db()
    q0 = []
    dd.set_trace_callback(lambda sql: q0.append(sql) if "FROM users" in sql or "FROM user_employee_ids" in sql else None)
    got = a._eid_resolve_many(dd, ["ZZLI-P1", "ZZLI-P1A", "ZZLI-M1A", "ZZLI-NOBODY", " ZZLI-P1A ", "", None, "ZZLI-P1"])
    dd.set_trace_callback(None)
s.check("main IDs, linked IDs, an unknown ID, blanks and repeats resolve in two queries however long the list",
        len(q0) == 2 and set(got) == {"ZZLI-P1", "ZZLI-P1A", "ZZLI-M1A"}, (len(q0), sorted(got)))
s.check("...each as (the person, whether it was a linked ID)",
        got["ZZLI-P1"][1] is False and got["ZZLI-P1A"][1] is True and got["ZZLI-M1A"][0]["employee_id"] == "ZZLI-M1"
        and got["ZZLI-P1A"][0]["full_name"] == "ZZ LI Pone")
with a.app.test_request_context("/"):
    dd = a.get_db()
    many = a._eid_resolve_many(dd, ["ZZLI-%d" % i for i in range(1200)] + ["ZZLI-P1A"])
s.check("a long list is read in chunks (no variable-limit failure) and still finds the linked one", "ZZLI-P1A" in many)

# ---------------------------------------------------------------------------------------------------------------------
s.section("the roster import: ID, Manager and HOD columns read through a linked ID")
lnk(cS, U["H1"], "eid_link", "ZZLI-H1A")
dbx("UPDATE users SET hod_id=? WHERE id=?", U["H1"], U["P1"])      # P1 already has H1 as HOD: the file repeats who they have
dbx("UPDATE users SET manager_id=? WHERE id=?", U["M1"], U["P1"])


def rec(eid, name, **kw):
    r_ = {"employee id": eid, "employee name": name, "business group": BG, "company": CO,
          "job grade": "20", "joined date": "2015-01-01", "work email": eid.lower() + "@example.com"}
    r_.update(kw)
    return r_


def check_q(records, authoritative=False, apply_=False):
    with a.app.test_request_context("/"):
        dd = a.get_db()
        me_ = dict(dd.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        chk = a._roster_check(dd, me_, records, authoritative)
        q = a._roster_quality(dd, me_, chk)
        if apply_:
            return chk, q, a._roster_apply(dd, me_, chk)
        return chk, q


def look(q, key):
    g = [x for x in q["look"] if x["key"] == key]
    return g[0]["found"] if g else []


n_before = one("SELECT COUNT(*) FROM users")
chk, q = check_q([rec("ZZLI-P1A", "ZZ LI Pone", department="ZZLI New Dept", manager="ZZLI-M1A", hod="ZZLI-H1A")])
v = chk["valid"][0] if chk["valid"] else {}
s.check("a row whose ID is a linked ID is not an error and is read under their main ID",
        not chk["errors"] and v.get("eid") == "ZZLI-P1" and v.get("existing_id") == U["P1"] and v.get("via_eid") == "ZZLI-P1A", chk["errors"])
s.check("...their Manager and HOD cells, also linked IDs, resolve to the right people's main IDs",
        v.get("mgr") == "ZZLI-M1" and v.get("hod") == "ZZLI-H1" and v.get("mgr_via") == ("ZZLI-M1A", "ZZ LI Mgr")
        and v.get("hod_via") == ("ZZLI-H1A", "ZZ LI Hod"), (v.get("mgr"), v.get("hod")))
s.check("...it is an update (nobody new), and the department is a change", chk["counts"]["add"] == 0 and chk["counts"]["update"] == 1
        and any(c["field"] == "Department" and c["to"] == "ZZLI New Dept" for c in chk["changes"]), chk["counts"])
s.check("the Quality step lists 'Matched through a linked ID' and the Manager / HOD item first, in the approved words",
        [g["key"] for g in q["look"]][:2] == ["linked", "linked_mgr"]
        and look(q, "linked")[0]["detail"] == "Row 2: ZZLI-P1A is ZZ LI Pone (main ID ZZLI-P1)"
        and [x["detail"] for x in look(q, "linked_mgr")] == ["Row 2: line manager ZZLI-M1A is ZZ LI Mgr", "Row 2: HOD ZZLI-H1A is ZZ LI Hod"],
        [x["detail"] for g in q["look"] for x in g["found"]])
s.check("...with their what and why", q["look"][0]["what"] == "Matched through a linked ID" and "doesn't rename them and adds nobody new"
        in q["look"][0]["why"] and q["look"][1]["what"] == "Line manager or HOD matched through a linked ID"
        and "the right person is set" in q["look"][1]["why"])
s.check("they are look-at items: nothing to fix, and the row still counts as clean",
        q["n_fix"] == 0 and q["n_look"] == 3 and q["clean"] == 1, (q["n_fix"], q["n_look"], q["clean"]))
s.check("the 'may be the same person' check stays silent for a row matched through a linked ID", look(q, "same_person") == [])
chk0, q0_ = check_q([rec("ZZLI-NEWX", "ZZ LI Pone", manager="ZZLI-M1")])
s.check("   FALSIFY: a genuinely new ID with the same name does fire it (the silence above was the link)",
        len(look(q0_, "same_person")) == 1)
chk, q, res = check_q([rec("ZZLI-P1A", "ZZ LI Pone", department="ZZLI New Dept", manager="ZZLI-M1A", hod="ZZLI-H1A")], apply_=True)
pr = rows("SELECT employee_id, username, department, manager_id, hod_id, left_at FROM users WHERE id=?", U["P1"])[0]
s.check("applied: they are updated under their main ID -- never renamed, nobody new, no account with the linked ID",
        res[0] == 0 and res[1] == 1 and pr["employee_id"] == "ZZLI-P1" and pr["username"] == "ZZLI-P1"
        and pr["department"] == "ZZLI New Dept" and one("SELECT COUNT(*) FROM users") == n_before
        and not rows("SELECT 1 FROM users WHERE employee_id='ZZLI-P1A' OR username='ZZLI-P1A'"))
s.check("...and their line manager and HOD are the people the linked IDs name", pr["manager_id"] == U["M1"] and pr["hod_id"] == U["H1"])
dbx("UPDATE users SET manager_id=NULL, hod_id=NULL, department='ZZLI Ops' WHERE id=?", U["P1"])
dbx("UPDATE users SET manager_id=? WHERE id=?", U["M1"], U["P1"])
chk, q, res = check_q([rec("ZZLI-P1A", "ZZ LI Pone", manager="ZZLI-M1A", hod="ZZLI-H1A")], apply_=True)
s.check("...an empty slot is filled through the linked IDs too (HOD set from a linked HOD ID)",
        one("SELECT hod_id FROM users WHERE id=?", U["P1"]) == U["H1"] and one("SELECT manager_id FROM users WHERE id=?", U["P1"]) == U["M1"], res)

# a full (authoritative) roster
chk, q = check_q([rec("ZZLI-P1A", "ZZ LI Pone")], authoritative=True)
left_ids = {w["employee_id"] for w in chk["would_leave"]}
s.check("authoritative: the person whose linked ID is in the file is not marked as left for their main ID being absent",
        "ZZLI-P1" not in left_ids and "ZZLI-PX" in left_ids and "ZZLI-P1" in chk["seen"], sorted(left_ids))
chk2, q2 = check_q([rec("ZZLI-PX", "ZZ LI Pxtra")], authoritative=True)
s.check("   FALSIFY: a file that has none of their IDs does mark them", "ZZLI-P1" in {w["employee_id"] for w in chk2["would_leave"]})
chk3, q3 = check_q([rec("ZZLI-P1A", "ZZ LI Pone")], authoritative=True)
dbx("DELETE FROM user_employee_ids WHERE employee_id='ZZLI-P1A'")
chk4, q4 = check_q([rec("ZZLI-P1A", "ZZ LI Pone", manager="ZZLI-M1")], authoritative=True)
s.check("   FALSIFY: with the link gone the same row is a NEW person, and the old account is marked as left",
        chk4["counts"]["add"] == 1 and "ZZLI-P1" in {w["employee_id"] for w in chk4["would_leave"]})
lnk(cS, U["P1"], "eid_link", "ZZLI-P1A")
lnk(cS, U["P1"], "eid_link", "ZZLI-P1B")

# the same person twice
for label, recs, msg, row_eid in (
        ("their main ID, then a linked ID", [rec("ZZLI-P1", "ZZ LI Pone"), rec("ZZLI-P1A", "ZZ LI Pone")],
         "ZZLI-P1 and ZZLI-P1A are the same person (ZZ LI Pone)", "ZZLI-P1A"),
        ("a linked ID, then their main ID", [rec("ZZLI-P1A", "ZZ LI Pone"), rec("ZZLI-P1", "ZZ LI Pone")],
         "ZZLI-P1A and ZZLI-P1 are the same person (ZZ LI Pone)", "ZZLI-P1"),
        ("two linked IDs", [rec("ZZLI-P1A", "ZZ LI Pone"), rec("ZZLI-P1B", "ZZ LI Pone")],
         "ZZLI-P1A and ZZLI-P1B are the same person (ZZ LI Pone)", "ZZLI-P1B")):
    chk, q = check_q(recs)
    e = chk["errors"][0] if chk["errors"] else {}
    s.check("the same person twice (%s) is an error on row 3, shown under the ID the file used" % label,
            len(chk["errors"]) == 1 and e["row"] == 3 and e["why"] == msg and e["eid"] == row_eid, chk["errors"])
chk, q = check_q([rec("ZZLI-P1A", "ZZ LI Pone"), rec("ZZLI-P1A", "ZZ LI Pone")])
s.check("the same linked ID twice is the old 'appears more than once' message",
        len(chk["errors"]) == 1 and "appears more than once" in chk["errors"][0]["why"])
chk, q = check_q([rec("ZZLI-P1A", "ZZ LI Pone"), rec("ZZLI-PX", "ZZ LI Pxtra")])
s.check("   FALSIFY: a linked ID and a different person's ID together are fine", not chk["errors"] and len(chk["valid"]) == 2)
chk, q = check_q([rec("ZZLI-P1", "ZZ LI Pone", manager="ZZLI-NOBODY")])
s.check("control: an unknown line manager is still the old look-at item, no linked item", [g["key"] for g in q["look"]] == ["mgr_missing"])
chk, q = check_q([rec("ZZLI-P1", "ZZ LI Pone", manager="ZZLI-M1A")])
s.check("a main ID row with a linked Manager gives only the Manager item",
        [g["key"] for g in q["look"]] == ["linked_mgr"] and q["clean"] == 1 and q["n_look"] == 1)
chk, q = check_q([rec("ZZLI-P1", "ZZ LI Pone", manager="ZZLI-P1B")])
s.check("a line manager column naming another of their OWN IDs is their own line manager (nobody else reviews them)",
        "mgr_self" in [g["key"] for g in q["look"]], [g["key"] for g in q["look"]])

# end to end on the real Quality page
KEEP.setdefault("tokens", {})
buf = io.StringIO()
w = _csv.writer(buf)
w.writerow(["Employee ID", "Employee Name", "Business Group", "Company", "Manager ID", "Job Grade", "Joined Date"])
w.writerow(["ZZLI-P1A", "ZZ LI Pone", BG, CO, "ZZLI-M1A", "20", "2015-01-01"])
resp = cS.post("/admin/import/roster", data={"csrf_token": "tok", "mode": "upsert", "preview": "1",
                                              "file": (io.BytesIO(buf.getvalue().encode()), "r.csv")},
               content_type="multipart/form-data")
tok = (re.search(r"check=([0-9a-f]{32})", resp.headers.get("Location", "")) or [None, ""])[1]
KEEP["tokens"].setdefault("roster", []).append(tok)
pgq = txt(cS.get("/admin/import/roster?check=" + tok))
s.check("the real Quality page shows both items with the example wording, and Apply is not blocked",
        bool(tok) and "Matched through a linked ID" in pgq and "Line manager or HOD matched through a linked ID" in pgq
        and "Row 2: ZZLI-P1A is ZZ LI Pone (main ID ZZLI-P1)" in pgq and "Row 2: line manager ZZLI-M1A is ZZ LI Mgr" in pgq
        and "I've looked at these" in pgq, tok)
wipe_links()
lnk(cS, U["P1"], "eid_link", "ZZLI-P1A")
lnk(cS, U["M1"], "eid_link", "ZZLI-M1A")
lnk(cS, U["P2"], "eid_link", "ZZLI-P2A")

# ---------------------------------------------------------------------------------------------------------------------
s.section("the shared-engine imports: passwords, clear panels, 360 panels, job codes")


def xfile(head, rws):
    buf_ = io.StringIO()
    w_ = _csv.writer(buf_)
    w_.writerow(head)
    w_.writerows(rws)
    return io.BytesIO(buf_.getvalue().encode())


def stage(url, f, kind, **extra):
    r_ = cS.post(url, data=dict({"csrf_token": "tok", "preview": "1", "file": (f, "li.csv")}, **extra),
                 content_type="multipart/form-data")
    t = (re.search(r"check=([0-9a-f]{32})", r_.headers.get("Location", "")) or [None, ""])[1]
    KEEP["tokens"].setdefault(kind, []).append(t)
    return t


def step(url, t, action, **form):
    return cS.post(url, data=dict({"csrf_token": "tok", "token": t, "action": action}, **form))


def pageq(url, t, st=None):
    return txt(cS.get(url + "?check=%s%s" % (t, ("&step=" + st) if st else "")))


def spec_quality(kind, ctx):
    return a._imp_quality(a._IMP[kind], ctx)


ITEM = "ID matched through a linked ID"
# passwords
PW = "/admin/import/passwords"
hash_p1 = one("SELECT password_hash FROM users WHERE id=?", U["P1"])
tok = stage(PW, xfile(["Employee ID", "Password"], [["ZZLI-P1A", "ZzLi-Pass-1!x"], ["ZZLI-PX", "ZzLi-Pass-2!y"]]), "passwords")
pg = pageq(PW, tok)
s.check("passwords: a linked ID is a look-at item (not an error), with its detail", bool(tok)
        and "matched through a linked ID" in pg and "Row 2: ZZLI-P1A is ZZ LI Pone (main ID ZZLI-P1)" in pg
        and "to fix" not in pg.split("2 · Quality")[1][:160], pg[:0])
r1 = step(PW, tok, "quality_ok", ack="1")
# (P1 signed in above, so the super admin is asked: replace their password, keyed by their MAIN ID)
r2 = step(PW, tok, "to_apply", **{"d_" + hashlib.sha1(b"pw:ZZLI-P1").hexdigest()[:10]: "replace"})
r3 = step(PW, tok, "apply")
s.check("...applied: the password is set for the person under their main ID, no account with the linked ID",
        check_password_hash(one("SELECT password_hash FROM users WHERE id=?", U["P1"]), "ZzLi-Pass-1!x")
        and one("SELECT password_hash FROM users WHERE id=?", U["P1"]) != hash_p1 and one("SELECT COUNT(*) FROM users WHERE "
                                                                                       "employee_id='ZZLI-P1A'") == 0,
        (r1.headers.get("Location"), r2.headers.get("Location"), r3.headers.get("Location")))
dbx("UPDATE users SET password_hash=? WHERE id=?", hash_p1, U["P1"])
tok = stage(PW, xfile(["Employee ID", "Password"], [["ZZLI-P1", "pw-one-123"], ["ZZLI-P1A", "pw-two-123"]]), "passwords")
pg = pageq(PW, tok)
rq = step(PW, tok, "quality_ok", ack="1")
with a.app.test_request_context("/"):
    dd = a.get_db()
    kept = a._imp_load("passwords", dd, dict(dd.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()), tok)
s.check("passwords: their main ID and a linked ID together is an error that names the person, on the page as its own kind, "
        "and Continue is refused",
        kept and [e["why"] for e in kept[2]["errors"]] == ["ZZLI-P1 and ZZLI-P1A are the same person (ZZ LI Pone): the file "
                                                            "has two passwords for them."]
        and "The same person twice" in pg and "step=changes" not in rq.headers.get("Location", "")
        and not a._imp_meta("passwords", tok).get("quality"), rq.headers.get("Location"))
with a.app.test_request_context("/"):
    dd = a.get_db()
    meX = dict(dd.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
    ctx_ok = a._pimp_load(dd, meX, {}, __import__("json").dumps([{"row": 2, "eid": "ZZLI-P1A", "hash": "h"}]).encode())
    ctx_bad = a._pimp_load(dd, meX, {}, __import__("json").dumps([{"row": 2, "eid": "ZZLI-P1", "hash": "h"},
                                                                    {"row": 3, "eid": "ZZLI-P1A", "hash": "h"}]).encode())
    ctx_adm = a._pimp_load(dd, meX, {}, __import__("json").dumps([{"row": 2, "eid": "zzli-adm", "hash": "h"}]).encode())
    q_ok = spec_quality("passwords", ctx_ok)
s.check("passwords: the loader resolves it (valid under the main ID); the quality item never stops the row being clean",
        not ctx_ok["errors"] and ctx_ok["valid"][0]["eid"] == "ZZLI-P1" and ctx_ok["valid"][0]["file_eid"] == "ZZLI-P1A"
        and [g["key"] for g in q_ok["look"]] == ["linked"] and q_ok["clean"] == 1 and q_ok["n_look"] == 1, ctx_ok["errors"])
s.check("   FALSIFY/controls: the same person twice is an error; an admin account is still 'no matching user'",
        [e["why"] for e in ctx_bad["errors"]] == ["ZZLI-P1 and ZZLI-P1A are the same person (ZZ LI Pone): the file has two passwords for them."]
        and ctx_adm["errors"] and "no matching user" in ctx_adm["errors"][0]["why"])

# clear panels
CL = "/admin/clear-panels"
tok = stage(CL, xfile(["Employee ID"], [["ZZLI-P1A"], ["ZZLI-PX"]]), "clear")
pg = pageq(CL, tok)
s.check("clear panels: a linked ID is a look-at item with its detail, read under the main ID",
        bool(tok) and "Row 2: ZZLI-P1A is ZZ LI Pone (main ID ZZLI-P1)" in pg and "ZZ LI Pone" in pg and "Unknown Employee ID" not in pg)
with a.app.test_request_context("/"):
    dd = a.get_db()
    c_ok = a._cimp_load(dd, meX, {"filename": "c.csv"}, b"Employee ID\nZZLI-P1A\nZZLI-PX\n")
    c_bad = a._cimp_load(dd, meX, {"filename": "c.csv"}, b"Employee ID\nZZLI-P1\nZZLI-P1A\n")
    c_dup = a._cimp_load(dd, meX, {"filename": "c.csv"}, b"Employee ID\nZZLI-P1\nZZLI-P1\n")
    q_c = spec_quality("clear", c_ok)
s.check("clear panels: the subject is the person (main ID), the linked item is first, and the row stays clean",
        not c_ok["errors"] and [x["eid"] for x in c_ok["subjects"]] == ["ZZLI-P1", "ZZLI-PX"]
        and [g["key"] for g in q_c["look"]][0] == "linked" and q_c["n_fix"] == 0)
s.check("   the same person twice is an error; the same ID twice is still skipped quietly (the old behaviour)",
        [e["why"] for e in c_bad["errors"]] == ["ZZLI-P1 and ZZLI-P1A are the same person (ZZ LI Pone)."] and not c_dup["errors"])

# 360 panels
PN = "/admin/import"
with a.app.test_request_context("/"):
    dd = a.get_db()
    cyc = a.active_cycle(dd)
    rows_ok = [(2, "ZZLI-P1A", "ZZLI-M1A", "line_manager"), (3, "ZZLI-PX", "ZZLI-P2A", "peer")]
    chk_p = a._panel_import_check(dd, meX, cyc["id"], rows_ok, False)
    ctx_p = a._pnimp_load(dd, meX, {"filename": "p.csv", "replace": False},
                          b"Subject Employee ID,Assessor Employee ID,Relationship\nZZLI-P1A,ZZLI-M1A,line_manager\nZZLI-PX,ZZLI-P2A,peer\n")
    q_p = spec_quality("panels", ctx_p)
    chk_dup = a._panel_import_check(dd, meX, cyc["id"], [(2, "ZZLI-PX", "ZZLI-P2", "peer"), (3, "ZZLI-PX", "ZZLI-P2A", "peer")], False)
    chk_same = a._panel_import_check(dd, meX, cyc["id"], [(2, "ZZLI-PX", "ZZLI-P2", "peer"), (3, "ZZLI-PX", "ZZLI-P2", "peer")], False)
    chk_two = a._panel_import_check(dd, meX, cyc["id"], [(2, "ZZLI-PX", "ZZLI-P2", "peer"), (3, "ZZLI-PX", "ZZLI-P1", "peer")], False)
s.check("360 panels: subject and assessor written as linked IDs resolve to the people (main IDs in the pairs)",
        not chk_p["errors"] and [(v["srow"]["employee_id"], v["arow"]["employee_id"]) for v in chk_p["valid"]]
        == [("ZZLI-P1", "ZZLI-M1"), ("ZZLI-PX", "ZZLI-P2")], chk_p["errors"])
s.check("...the quality step lists each linked ID (subject / assessor) first, and it never stops a row being clean",
        [g["key"] for g in q_p["look"]][:1] == ["linked"] and q_p["n_look"] == 3 and q_p["clean"] == 2
        and any(i["detail"] == "Row 2: subject ZZLI-P1A is ZZ LI Pone (main ID ZZLI-P1)" for i in q_p["look"][0]["found"])
        and any(i["detail"] == "Row 3: assessor ZZLI-P2A is ZZ LI Ptwo (main ID ZZLI-P2)" for i in q_p["look"][0]["found"]),
        [(g["key"], g["n"]) for g in q_p["look"]])
s.check("...the same pair written under a main ID and a linked ID is an error naming the person",
        any("ZZLI-P2 and ZZLI-P2A are the same person (ZZ LI Ptwo)" in e["why"] for e in chk_dup["errors"]), chk_dup["errors"])
s.check("   FALSIFY: the same pair written the same way twice, and two different assessors, are not",
        not any("same person" in e["why"] for e in chk_same["errors"]) and not any("same person" in e["why"] for e in chk_two["errors"]))

# job codes
with a.app.app_context():
    d = a.get_db()
    d.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, plan_mode, source, active) VALUES "
              "('ZZLI Dept', 'ZZLI Job', 20, 'ZLI-OPS-01-20', 'explicit', 'architecture', 1)")
    d.commit()
with a.app.test_request_context("/"):
    dd = a.get_db()
    lk_ = []
    plan, errs, blank = a._jobs_import_check(dd, meX, [{"employee id": "ZZLI-P1A", "job code": "ZLI-OPS-01-20", "job scope": ""}], lk_)
    plan2, errs2, _b = a._jobs_import_check(dd, meX, [{"employee id": "ZZLI-P1", "job code": "ZLI-OPS-01-20", "job scope": ""},
                                                       {"employee id": "ZZLI-P1A", "job code": "ZLI-OPS-01-20", "job scope": ""}])
    plan3, errs3, _b = a._jobs_import_check(dd, meX, [{"employee id": "ZZLI-LEFT", "job code": "ZLI-OPS-01-20", "job scope": ""}])
    ctx_j = a._jimp_load(dd, meX, {"filename": "j.csv"}, b"Employee ID,Job Code,Job Scope\nZZLI-P1A,ZLI-OPS-01-20,\n")
    q_j = spec_quality("jobs", ctx_j)
s.check("job codes: a linked ID is read under the main ID and reported (look-at, not an error)",
        not errs and plan and plan[0][0]["employee_id"] == "ZZLI-P1" and lk_
        and lk_[0]["detail"] == "Row 2: ZZLI-P1A is ZZ LI Pone (main ID ZZLI-P1)", (errs, lk_))
s.check("...through the four steps: the plan and quality step carry it, and the row stays clean",
        not ctx_j["errors"] and ctx_j["plan"][0]["eid"] == "ZZLI-P1" and [g["key"] for g in q_j["look"]][0] == "linked"
        and q_j["clean"] == 1, (ctx_j["errors"], [g["key"] for g in q_j["look"]]))
s.check("...the same person twice is an error; a leaver is still 'no active employee'",
        [e["why"] for e in errs2] == ["ZZLI-P1 and ZZLI-P1A are the same person (ZZ LI Pone)."]
        and errs3 and "no active employee" in errs3[0]["why"], (errs2, errs3))

# ---------------------------------------------------------------------------------------------------------------------
s.section("the KPI targets import")
with a.app.app_context():
    d = a.get_db()
    KEEP["window"] = tuple(d.execute("SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell='pm_results'",
                                     (CID,)).fetchone() or ()) or None
    d.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
    d.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_results', "
              "'2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
    d.commit()
HEAD = "Employee ID,KPI,Focus,Unit of Measure,Weightage,Method,Rate 1,Rate 2,Rate 3,Rate 4,Rate 5,Matrix manager ID\n"


def kline(eid, kpi, w, mm=""):
    return "%s,%s,,%%,%s,More,80,90,100,110,120,%s\n" % (eid, kpi, w, mm)


def kti(text):
    with a.app.test_request_context("/"):
        dd = a.get_db()
        me_ = dict(dd.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        period = dd.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()
        recs = a._read_records("k.csv", text.encode())
        chk = a._kti_check(dd, me_, period, recs)
        cls = a._kti_classify(dd, period, chk)
        return chk, a._kti_quality(dd, period, chk, cls)


chk, q = kti(HEAD + kline("ZZLI-P1A", "ZZLI Sales", 60) + kline("ZZLI-P1", "ZZLI Cost", 40))
s.check("KPI targets: a row written with a linked ID goes in under the person's main ID, no error",
        not chk["errors"] and [(r["eid"], r["kpi_name"]) for r in chk["valid"]] == [("ZZLI-P1", "ZZLI Sales"), ("ZZLI-P1", "ZZLI Cost")]
        and chk["valid"][0]["subject_id"] == U["P1"] and chk["valid"][1]["subject_id"] == U["P1"], chk["errors"])
s.check("...the Quality step lists it as a look-at item, first, with the detail; it is not counted against the row",
        [g["key"] for g in q["look"]][0] == "linked"
        and q["look"][0]["found"][0]["detail"] == "Row 2: ZZLI-P1A is ZZ LI Pone (main ID ZZLI-P1)"
        and q["look"][0]["what"] == "row uses another of the person's IDs (a linked ID)"
        and q["n_fix"] == 0, [(g["key"], g["n"]) for g in q["look"]])
chk_m, q_m = kti(HEAD + kline("ZZLI-P1", "ZZLI Sales", 60) + kline("ZZLI-P1", "ZZLI Cost", 40))
s.check("...and the same file written with the main ID has the same clean count (a linked ID never makes a row unclean)",
        q["clean"] == q_m["clean"] and q["n_look"] == q_m["n_look"] + 1, (q["clean"], q_m["clean"], q["n_look"], q_m["n_look"]))
chk, q = kti(HEAD + kline("ZZLI-P1A", "ZZLI Sales", 100) + kline("ZZLI-P1", "ZZLI Sales", 100))
s.check("KPI targets: the same KPI for the same person under their main ID and a linked ID is an error naming the person",
        len(chk["errors"]) == 1 and chk["errors"][0]["row"] == 3
        and "ZZLI-P1A and ZZLI-P1 are the same person (ZZ LI Pone): KPI 'ZZLI Sales' appears under both." in chk["errors"][0]["why"],
        chk["errors"])
chk, q = kti(HEAD + kline("ZZLI-P1A", "ZZLI Sales", 60) + kline("ZZLI-P1", "ZZLI Cost", 40))
chk2_, q2_ = kti(HEAD + kline("ZZLI-P1", "ZZLI Sales", 100) + kline("ZZLI-P1", "ZZLI Sales", 100))
s.check("   FALSIFY/control: two different KPIs under two IDs are fine; the same ID twice keeps its old message",
        not chk["errors"] and len(chk2_["errors"]) == 1 and "appears more than once in the file" in chk2_["errors"][0]["why"]
        and "same person" not in chk2_["errors"][0]["why"])
chk, q = kti(HEAD + kline("ZZLI-P1", "ZZLI Sales", 100, mm="ZZLI-M1A"))
s.check("a matrix manager written as a linked ID is the right person", not chk["errors"]
        and chk["valid"][0]["approver_ids"] == [U["M1"]], chk["errors"])
chk, q = kti(HEAD + kline("ZZLI-NOBODY", "ZZLI Sales", 100) + kline("zzli-adm", "ZZLI Sales", 100))
s.check("control: an unknown ID and an admin account are still 'no such employee'",
        [e["kind"] for e in chk["errors"]] == ["Unknown Employee ID", "Unknown Employee ID"] and not chk["valid"])
dbx("DELETE FROM user_employee_ids WHERE employee_id='ZZLI-P1A'")
chk, q = kti(HEAD + kline("ZZLI-P1A", "ZZLI Sales", 100))
s.check("   FALSIFY: with the link gone the same row is 'no such employee'", chk["errors"] and chk["errors"][0]["kind"] == "Unknown Employee ID")

# the route's own Quality page
lnk(cS, U["P1"], "eid_link", "ZZLI-P1A")
r_ = cS.post("/admin/performance/import", data={"csrf_token": "tok", "preview": "1", "file": (
    io.BytesIO((HEAD + kline("ZZLI-P1A", "ZZLI Sales", 100)).encode()), "k.csv")}, content_type="multipart/form-data")
tk = (re.search(r"check=([0-9a-f]{32})", r_.headers.get("Location", "")) or [None, ""])[1]
KEEP["tokens"].setdefault("kpi_targets", []).append(tk)
pgk = txt(cS.get("/admin/performance/import?check=" + tk))
s.check("the KPI targets Quality page shows the linked-ID item", bool(tk) and "Row 2: ZZLI-P1A is ZZ LI Pone (main ID ZZLI-P1)" in pgk
        and "another of the person" in pgk, tk)

# ---------------------------------------------------------------------------------------------------------------------
s.section("the pasted list on a calibration group, and the templates")
with a.app.test_request_context("/"):
    dd = a.get_db()
    res = {e_: r_ for e_, (r_, _v) in a._eid_resolve_many(dd, ["ZZLI-P1A", "ZZLI-M1A", "ZZLI-NOPE"]).items()
           if r_["role"] != "admin" and r_["left_at"] is None}
s.check("a pasted list of Employee IDs resolves linked ones to the person (the group's add goes through _eid_resolve_many)",
        sorted(res) == ["ZZLI-M1A", "ZZLI-P1A"] and "_eid_resolve_many(db, eids)" in src[src.index('raw = re.split(r"[\\s,;]+", request.form.get("ids")'):][:900])
_n, broken = H.every_template_compiles(a)
s.check("every template compiles, person/_overview.html and _summary.html included", not broken, broken)

# ---------------------------------------------------------------------------------------------------------------------
s.section("the People list: Show 'Has linked IDs', the 'Also' line, the download's Linked IDs column, the person header")
wipe_links()
lnk(cS, U["P1"], "eid_link", "ZZLI-ALSO1")
lnk(cS, U["P1"], "eid_link", "ZZLI-ALSO2")
lnk(cS, U["LEFT"], "eid_link", "ZZLI-LEFTA")
lnk(cS, U["PX"], "eid_link", "ZZLI-GONEX")
lnk(cS, U["PX"], "eid_unlink", "ZZLI-GONEX")
s.check("setup: P1 has two active links, the leaver one, PX only a removed one",
        active(U["P1"]) == ["ZZLI-ALSO1", "ZZLI-ALSO2"] and active(U["LEFT"]) == ["ZZLI-LEFTA"] and active(U["PX"]) == [])
LIST = "/admin/users?show=linked&q=ZZLI-&qin=employee_id&fbg=" + BG.replace(" ", "+")
pg = txt(cS.get(LIST))
s.check("the Show select offers 'Has linked IDs' between 'No work email' and 'Left'",
        bool(re.search(r'value="noemail"[^>]*>No work email</option>\s*<option value="linked"[^>]*>Has linked IDs</option>'
                       r'\s*<option value="left"', pg)))
s.check("Show=linked lists a person with an active link and a leaver with one",
        "ZZ LI Pone" in pg and "ZZ LI Leaver" in pg)
s.check("...but not the person whose only link was removed, nor one who never had any",
        "ZZ LI Pxtra" not in pg and "ZZ LI Ptwo" not in pg)
s.check("   FALSIFY: Show=all with the same search lists the unlinked people too",
        "ZZ LI Pxtra" in txt(cS.get(LIST.replace("show=linked", "show=all"))))
s.check("   FALSIFY: Show=active drops the leaver, so 'linked' is what keeps them",
        "ZZ LI Leaver" not in txt(cS.get(LIST.replace("show=linked", "show=active"))))
s.check("the select shows 'Has linked IDs' as the chosen one", bool(re.search(r'value="linked"\s+selected', pg)))
s.check("the row says 'Also ZZLI-ALSO1, ZZLI-ALSO2' on its own line (class adm-also), and the cell's hover holds it too",
        bool(re.search(r'<span class="muted small adm-also">Also ZZLI-ALSO1, ZZLI-ALSO2</span>', pg))
        and "also ZZLI-ALSO1, ZZLI-ALSO2" in pg)
s.check("the leaver's row says 'Also ZZLI-LEFTA'", "Also ZZLI-LEFTA</span>" in pg)
pg_all = txt(cS.get(LIST.replace("show=linked", "show=all")))
m_ = re.search(r"<tr>\s*<td[^>]*>.{0,400}?ZZ LI Ptwo.*?</tr>", pg_all, re.S)
s.check("a person without links has no 'Also' line (their row is one line as before)",
        bool(m_) and "adm-also" not in m_.group(0) and "Also" not in m_.group(0))
s.check("the CSS keys the new line on its own class next to .adm-users",
        ".adm-users td .adm-also" in open(os.path.join(os.path.dirname(a.__file__), "static", "style.css")).read())
with a.app.test_request_context("/"):
    mp_ = a._eid_linked_map(a.get_db(), [U["P1"], U["LEFT"], U["PX"], U["P2"]])
s.check("one batched helper returns the active links oldest first, nothing for removed or none",
        mp_ == {U["P1"]: ["ZZLI-ALSO1", "ZZLI-ALSO2"], U["LEFT"]: ["ZZLI-LEFTA"]}, mp_)
s.check("scope: a BG admin of another group sees nobody of this group under Show=linked",
        _BGA0 is not None and _BGA0["admin_bg"] != BG
        and "ZZ LI Pone" not in txt(H.client_as(a, _BGA0["id"]).get(LIST.replace("&fbg=" + BG.replace(" ", "+"), ""))))
s.check("   FALSIFY: the BG admin of this group sees them under the same filter",
        "ZZ LI Pone" in txt(cB.get(LIST)) and "ZZ LI Leaver" in txt(cB.get(LIST)))
# the download
r_ = cS.get(LIST)
href = re.search(r'href="(/admin/export/users\.xlsx[^"]*)"', r_.get_data(as_text=True))
s.check("the list has no Download link now (it moved to Reports, 4 Nov 2026); the address takes show=linked", href is None and "show=linked" in LIST, LIST)
href = LIST.replace("/admin/users?", "/admin/export/users.xlsx?")
csvt = H.as_csv_text(cS.get(href)) if href else ""
rows_ = list(_csv.reader(io.StringIO(csvt)))
hdr = next((r for r in rows_ if "Linked IDs" in r), None)
li_ = hdr.index("Linked IDs") if hdr else -1
byname = {r[hdr.index("Employee name")] if "Employee name" in hdr else "": r for r in rows_[rows_.index(hdr) + 1:]} if hdr else {}
s.check("the export has a 'Linked IDs' column (last)", hdr is not None and li_ == len(hdr) - 1, hdr)
s.check("...P1's cell is 'ZZLI-ALSO1, ZZLI-ALSO2', the leaver's 'ZZLI-LEFTA'",
        byname.get("ZZ LI Pone", [""] * 99)[li_] == "ZZLI-ALSO1, ZZLI-ALSO2" and byname.get("ZZ LI Leaver", [""] * 99)[li_] == "ZZLI-LEFTA",
        sorted(byname)[:6])
s.check("...and the export with show=linked holds only people with links",
        "ZZ LI Pxtra" not in byname and "ZZ LI Ptwo" not in byname)
full = list(_csv.reader(io.StringIO(H.as_csv_text(cS.get("/admin/export/users.xlsx?show=all&q=ZZLI-&qin=employee_id")))))
fh = next(r for r in full if "Linked IDs" in r)
fb = {r[fh.index("Employee name")]: r for r in full[full.index(fh) + 1:]} if "Employee name" in fh else {}
s.check("an ordinary export has the column too, empty for a person with no link",
        fb.get("ZZ LI Ptwo", ["x"] * 99)[fh.index("Linked IDs")] == "" and fb.get("ZZ LI Pone", [""] * 99)[fh.index("Linked IDs")] != "")
# the person page header
pgp = txt(cS.get("/admin/users/%d" % U["P1"]))
mh = re.search(r'<span class="muted small pp-meta">(.*?)</span></div>', pgp, re.S)
s.check("the person page header says 'ZZLI-P1 · also ZZLI-ALSO1, ZZLI-ALSO2' with the Account panel opener",
        bool(mh) and re.search(r'^ZZLI-P1 &middot; <button type="button" class="pp-also" data-panel-open="account"[^>]*>also '
                               r'ZZLI-ALSO1, ZZLI-ALSO2</button>|^ZZLI-P1 . <button[^>]*data-panel-open="account"[^>]*>also '
                               r'ZZLI-ALSO1, ZZLI-ALSO2</button>', mh.group(1)), mh and mh.group(1)[:200])
pgx = txt(cS.get("/admin/users/%d" % U["PX"]))
mx = re.search(r'<span class="muted small pp-meta">(.*?)</span></div>', pgx, re.S)
s.check("   FALSIFY: a person whose only link was removed has no 'also' in the header line",
        bool(mx) and "also" not in mx.group(1) and "pp-also" not in pgx)
s.check("the cycle picker is nowrap and does not shrink (CSS keyed on .pp-head .pp-cycle)",
        bool(re.search(r"\.pp-head \.pp-cycle \{[^}]*flex-shrink: 0[^}]*white-space: nowrap",
                       open(os.path.join(os.path.dirname(a.__file__), "static", "style.css")).read())))
wipe_links()

# ---------------------------------------------------------------------------------------------------------------------
s.section("the suite leaves nothing behind")
wipe_links()
_put_back()
s.check("nothing this suite made is left behind",
        one("SELECT COUNT(*) FROM users WHERE employee_id LIKE 'ZZLI%' OR username LIKE 'zzli%'") == 0
        and one("SELECT COUNT(*) FROM user_employee_ids WHERE employee_id LIKE 'ZZLI%'") == 0
        and one("SELECT COUNT(*) FROM org_units WHERE business_group LIKE 'ZZLI%'") == 0
        and one("SELECT COUNT(*) FROM admin_roles WHERE name LIKE 'ZZLI%'") == 0
        and one("SELECT COUNT(*) FROM tc_job_profiles WHERE job_code LIKE 'ZLI-%'") == 0)
sys.exit(s.done())
