"""Roles & access: the Inactivity sign-out switches (Chris, 2026-11-02: "Approve, build it"; canvas
[design canvas link removed], boards A1, A2 and B). The back end is tests/test_idle_role.py.

What this suite holds:
  * A1: Admin roles tab, a last group "Sign-in" (NEW badge): a summary row (Super admin "Never signed out", each role "Signed
    out" / "Stays signed in") and one row, "Signed out after an hour with no activity", kind "sign-in", the help line, "Never" for
    the Super admin, a checkbox per shown role ticked = idle_signout on
  * it is saved by Save roles (action=save), only for roles_shown, through _role_idle_set (one admin_role_idle audit row each);
    absent is not empty: a post without the row's marker (idle_in_form) changes nothing; a role not in roles_shown is untouched
  * A2: the change line and OneHR's confirm box name the role and its admin count (the page's script)
  * B: the fixed L&D admin card shows "After an hour with no activity" with its two choices only where AI+ Learning is on; the other
    choice is a double-confirmed form (action=idle_lnd) whose button says what it does; the super admin's alone
  * a BG admin can open and post nothing here; nothing is written for a refused caller
  * each guard falsified: the row's marker, the roles_shown scope, the L&D card's Learning gate
Synthetic (ZZIU-*) on the shared suite database; everything is put back at the end.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from werkzeug.security import generate_password_hash  # noqa: E402

a = H.setup()
s = H.Suite("Roles & access: the Sign-in row and the L&D admin card's two choices")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
PREFIX = "ZZIU role"
LMS0 = os.environ.get("ONEHR_LMS")
KEY = "idle_role_seeded"

with a.app.app_context():
    _d = a.get_db()
    LND0 = _d.execute("SELECT idle_signout FROM admin_roles WHERE builtin='lnd'").fetchone()[0]
    R_LND = _d.execute("SELECT id FROM admin_roles WHERE builtin='lnd'").fetchone()[0]
    R_BG = _d.execute("SELECT id FROM admin_roles WHERE builtin='bg'").fetchone()[0]
    R_BU = _d.execute("SELECT id FROM admin_roles WHERE builtin='bu'").fetchone()[0]
    BG0, BU0 = [_d.execute("SELECT idle_signout FROM admin_roles WHERE id=?", (r,)).fetchone()[0] for r in (R_BG, R_BU)]


def q(sql, args=()):
    with a.app.app_context():
        return [tuple(r) for r in a.get_db().execute(sql, args).fetchall()]


def x(sql, args=()):
    with a.app.app_context():
        d = a.get_db()
        d.execute(sql, args)
        d.commit()


def col(rid):
    return q("SELECT idle_signout FROM admin_roles WHERE id=?", (rid,))[0][0]


def n_audit():
    return q("SELECT COUNT(*) FROM activity_log WHERE action='admin_role_idle'")[0][0]


def cleanup(d):
    ids = [r[0] for r in d.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZIU-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        d.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        d.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    d.execute("DELETE FROM activity_log WHERE action='admin_role_idle' AND detail LIKE ?", (PREFIX + "%",))
    d.execute("DELETE FROM admin_role_access WHERE role_id IN (SELECT id FROM admin_roles WHERE name LIKE ?)", (PREFIX + "%",))
    d.execute("DELETE FROM admin_roles WHERE name LIKE ?", (PREFIX + "%",))
    d.commit()


with a.app.app_context():
    db = a.get_db()
    cleanup(db)
    R_CUS = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES (?, 'group')", (PREFIX + " custom",)).lastrowid
    db.execute("INSERT INTO admin_role_access(role_id, item) VALUES (?, ?)", (R_CUS, sorted(a.role_preset_items("view"))[0]))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]
    v = dict(base, username="ZZIU-BGA", employee_id="ZZIU-BGA", full_name="ZZIU-BGA", email=None, manager_id=None, hod_id=None,
             left_at=None, role="admin", admin_bg="ZZ-BG", admin_role_id=R_CUS, is_system_admin=0,
             password_hash=generate_password_hash("x", method="pbkdf2:sha256:1000"))
    db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
    BGA = db.execute("SELECT id FROM users WHERE employee_id='ZZIU-BGA'").fetchone()[0]
    db.commit()

SUP = H.client_as(a, SU["id"])
BAC = H.client_as(a, BGA)
IDS = (R_BG, R_BU, R_CUS)


def page(show=IDS):
    return SUP.get("/admin/roles?tab=admin&show=" + ",".join(str(i) for i in show)).get_data(as_text=True)


def items_form(rids):
    """The matrix's own item ticks as they stand, so a save moves nothing but the Sign-in row."""
    with a.app.app_context():
        d = a.get_db()
        return {"t_%d" % r: sorted(a.admin_role_items(d, r)) for r in rids}


def save(show=IDS, ticked=(), marker=True, shown=None):
    form = dict(items_form(shown or show), csrf_token="tok", action="save", roles_shown=",".join(str(i) for i in (shown or show)),
                show=",".join(str(i) for i in show))
    if marker:
        form["idle_in_form"] = "1"
    for r in ticked:
        form["idle_%d" % r] = "1"
    return SUP.post("/admin/roles?tab=admin", data=form)


def box(html, rid):
    m = re.search(r'<input type="checkbox" name="idle_%d" value="1" data-idle-rid="%d" (checked)?' % (rid, rid), html)
    return None if not m else bool(m.group(1))


try:
    s.section("A1: the Sign-in group in the Admin roles matrix")
    pg = page()
    s.check("a last group 'Sign-in' with the NEW badge, after every other group", ">Sign-in<span class=\"rl-new\"" in pg and
            pg.rindex('<details class="rl-mod"') == pg.index('<details class="rl-mod" data-idle-mod') < pg.index('class="muted small rl-note"'))
    gm = pg[pg.index("data-idle-mod"):pg.index('class="muted small rl-note"')]
    s.check("...its summary row: Super admin 'Never signed out', each role 'Signed out' / 'Stays signed in'",
            "Never signed out" in gm and
            re.search(r'data-idle-sum="%d">Signed out<' % R_BG, gm) and re.search(r'data-idle-sum="%d">Signed out<' % R_BU, gm))
    s.check("...the row: its words, the 'sign-in' kind pill, the help line, 'Never' for the Super admin",
            "Signed out after an hour with no activity" in gm and '<span class="rl-kind">sign-in</span>' in gm and
            "At 50 minutes a box asks" in gm and "Untick it for a role whose screen stays open, such as a room display." in gm and
            'rl-superonly">Never<' in gm)
    s.check("...one checkbox per shown role, ticked as the column says (BG, BU and the new custom role: all signed out)",
            [box(gm, r) for r in IDS] == [True, True, True] and gm.count('type="checkbox"') == 3, [box(gm, r) for r in IDS])
    s.check("...the form carries the row's marker, and each head knows its admin count (for the confirm box)",
            'name="idle_in_form" value="1"' in pg and 'data-role-n="1"' in pg)
    s.check("...the boxes do not post as items (their own names), so an item save can't take them", 'name="t_%d" value="idle' % R_BG not in pg)
    s.check("...the L&D admin role is not a column (its card is fixed)", 'data-role-head="%d"' % R_LND not in pg)
    s.check("...the script names the change and the confirm box's lines",
            "stays signed in when idle" in pg and "is signed out when idle" in pg and "will no longer be signed out" in pg and
            "after an hour with no activity." in pg)

    s.section("Save roles: only roles_shown, through _role_idle_set, one audit row each")
    n0 = n_audit()
    r = save(ticked=(R_BG, R_CUS))      # BU admin unticked
    s.check("saved: back to the page", r.status_code == 302)
    s.check("...BU admin is off, BG admin and the custom role stay on", (col(R_BG), col(R_BU), col(R_CUS)) == (1, 0, 1),
            (col(R_BG), col(R_BU), col(R_CUS)))
    rows = q("SELECT user_id, detail FROM activity_log WHERE action='admin_role_idle' ORDER BY id DESC")
    s.check("...one audit row, naming the role and Off", n_audit() == n0 + 1 and rows[0][0] == SU["id"] and
            "BU admin" in rows[0][1] and "Off" in rows[0][1], rows[:1])
    fl = SUP.get("/admin/roles?tab=admin&show=%d,%d,%d" % IDS).get_data(as_text=True)
    s.check("...the page then shows BU admin 'Stays signed in', unticked", box(fl, R_BU) is False and
            re.search(r'data-idle-sum="%d">Stays signed in<' % R_BU, fl) and "Saved BU admin." in fl.replace("&nbsp;", " "), None)
    r = save(ticked=(R_BG, R_CUS))
    s.check("saving again with nothing changed: no new audit row", n_audit() == n0 + 1)
    save(ticked=(R_BG, R_BU, R_CUS))
    s.check("ticked again: BU admin is back on, one more audit row naming On", col(R_BU) == 1 and n_audit() == n0 + 2 and
            "On" in q("SELECT detail FROM activity_log WHERE action='admin_role_idle' ORDER BY id DESC LIMIT 1")[0][0])

    s.section("absent is not empty")
    n0 = n_audit()
    save(ticked=(), marker=False)
    s.check("a post without the row (no marker) changes nothing, whatever it omits", (col(R_BG), col(R_BU), col(R_CUS)) == (1, 1, 1)
            and n_audit() == n0)
    # falsified: the marker is the guard. With it, the same post (no boxes) turns every shown role off.
    save(ticked=(), marker=True)
    s.check("FALSIFIED: the same post WITH the marker and no ticks switches every shown role off (so the marker is the guard)",
            (col(R_BG), col(R_BU), col(R_CUS)) == (0, 0, 0))
    for rid in IDS:
        x("UPDATE admin_roles SET idle_signout=1 WHERE id=?", (rid,))
    x("DELETE FROM activity_log WHERE action='admin_role_idle'")

    s.section("only the roles shown")
    n0 = n_audit()
    save(show=IDS, shown=(R_CUS,), ticked=())     # only the custom role is in roles_shown; BG and BU boxes absent
    s.check("a role not in roles_shown keeps its setting (BG, BU on), the one shown follows its box (off)",
            (col(R_BG), col(R_BU), col(R_CUS)) == (1, 1, 0) and n_audit() == n0 + 1)
    # falsified: were every role read, BG and BU would have gone off too
    s.check("FALSIFIED: the save reads roles_shown, not every role (BG and BU would be off otherwise)", col(R_BG) == 1 and col(R_BU) == 1)
    x("UPDATE admin_roles SET idle_signout=1 WHERE id=?", (R_CUS,))

    s.section("who may: the super admin's alone")
    n0 = n_audit()
    form = dict(items_form(IDS), csrf_token="tok", action="save", roles_shown=",".join(map(str, IDS)), idle_in_form="1")
    r1 = BAC.post("/admin/roles?tab=admin", data=form)
    r2 = BAC.post("/admin/roles?tab=admin", data={"csrf_token": "tok", "action": "idle_lnd", "idle": "on"})
    s.check("a BG admin: refused on both, nothing written, nothing logged", r1.status_code in (302, 403) and
            r2.status_code in (302, 403) and (col(R_BG), col(R_BU), col(R_CUS), col(R_LND)) == (1, 1, 1, LND0) and n_audit() == n0 and
            BAC.get("/admin/roles").status_code in (302, 403))

    s.section("B: the L&D admin card's two choices (only where AI+ Learning is on)")
    os.environ.pop("ONEHR_LMS", None)
    pg = page()
    s.check("AI+ Learning off: no L&D card, so no choices; and the action is refused", "data-lnd-idle" not in pg and
            SUP.post("/admin/roles?tab=admin", data={"csrf_token": "tok", "action": "idle_lnd", "idle": "on"}).status_code == 400
            and col(R_LND) == LND0)
    os.environ["ONEHR_LMS"] = "1"
    x("UPDATE admin_roles SET idle_signout=0 WHERE id=?", (R_LND,))
    pg = page()
    card = pg[pg.index("data-lnd-idle"):]
    card = card[:card.index("</div>\n      <span class=\"muted small\">For the room screen")]
    s.check("AI+ Learning on, as seeded: 'After an hour with no activity', Stays signed in chosen, Signed out offered",
            "After an hour with no activity" in pg and 'is-on" aria-current="true">Stays signed in<' in card and
            ">Signed out</button>" in card and "For the room screen. The super admin&rsquo;s to change." in pg)
    s.check("...its form is double-confirmed, titled, and the button says what it does", 'data-confirm-title="Sign L&amp;D admins out when idle?"' in card
            and 'data-confirm-ok="Sign them out when idle"' in card and "A room screen left open will go back to the sign-in page." in card
            and 'name="idle" value="on"' in card)
    n0 = n_audit()
    r = SUP.post("/admin/roles?tab=admin", data={"csrf_token": "tok", "action": "idle_lnd", "idle": "on"})
    s.check("Signed out: saved, one audit row naming the L&D admin role and On", r.status_code == 302 and col(R_LND) == 1 and
            n_audit() == n0 + 1 and "On" in q("SELECT detail FROM activity_log WHERE action='admin_role_idle' ORDER BY id DESC LIMIT 1")[0][0])
    pg = page()
    card = pg[pg.index("data-lnd-idle"):]
    card = card[:card.index("For the room screen")]
    s.check("...the card flips: Signed out chosen, 'Stays signed in' offered with 'Keep them signed in'",
            'is-on" aria-current="true">Signed out<' in card and ">Stays signed in</button>" in card and
            'data-confirm-ok="Keep them signed in"' in card and 'name="idle" value="off"' in card and
            "Keep L&amp;D admins signed in when idle?" in card)
    r = SUP.post("/admin/roles?tab=admin", data={"csrf_token": "tok", "action": "idle_lnd", "idle": "on"})
    s.check("the same choice again: unchanged, no new audit row", n_audit() == n0 + 1 and col(R_LND) == 1)
    r = SUP.post("/admin/roles?tab=admin", data={"csrf_token": "tok", "action": "idle_lnd", "idle": "off"})
    s.check("Stays signed in: saved, column 0, one more audit row", col(R_LND) == 0 and n_audit() == n0 + 2)
    s.check("a value that is neither on nor off: 400, nothing written", SUP.post("/admin/roles?tab=admin", data={
        "csrf_token": "tok", "action": "idle_lnd", "idle": "maybe"}).status_code == 400 and col(R_LND) == 0)
    # falsified: the Learning gate. With Learning off the same post is refused, so the card and its action go together.
    os.environ.pop("ONEHR_LMS", None)
    s.check("FALSIFIED: with Learning switched off again the same post is refused (the gate, not the value, held it)", SUP.post(
        "/admin/roles?tab=admin", data={"csrf_token": "tok", "action": "idle_lnd", "idle": "on"}).status_code == 400 and col(R_LND) == 0)
    s.check("...and the matrix's other rows and this one never touch the L&D role (it is not a column)", col(R_LND) == 0)
    src = H.source(a)
    s.check("no access-map entry needed: the whole page is the super admin's", '"admin_roles", "admin_admin_role"' in src)
finally:
    if LMS0 is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = LMS0
    with a.app.app_context():
        d_ = a.get_db()
        cleanup(d_)
        d_.execute("UPDATE admin_roles SET idle_signout=? WHERE id=?", (LND0, R_LND))
        d_.execute("UPDATE admin_roles SET idle_signout=? WHERE id=?", (BG0, R_BG))
        d_.execute("UPDATE admin_roles SET idle_signout=? WHERE id=?", (BU0, R_BU))
        d_.commit()
sys.exit(s.done())
