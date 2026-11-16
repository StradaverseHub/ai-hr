"""The Chart of KPI, piece C: the handshake keys (Chris, 2026-10-30, docs/chart-of-kpi.md "Phase 2"; the canvas boards 6 and 7).

What this suite holds:
  * storage: kpi_ext_systems, kpi_chart_links, user_ext_ids (a unique partial index on active (system, ID) and one active ID
    per person per system) and org_ext_ids exist with their columns and constraints
  * dark unless ONEHR_COA=1: the Systems route and every new POST action (a link, a system, a unit code, a person's ID) are
    404s for the super admin and write nothing; no Data link, Systems tab or "IDs in other systems" is drawn; flag on, a BG
    admin gets a 403 and the access map says "super" for every new door
  * Systems: add (name only, max 60, never an address, unique ignoring case), retire (hidden from new links, kept on what
    uses it, marked Retired) and bring back; the counts agree with the data and come from one read
  * unit codes: a real unit picked from the lists, a live system, one code per unit and system, a code belongs to one unit in
    a system (the message names the unit), remove
  * the data link: every combination of whose figure and matched on, a BU-level KPI (and a variant of it) only the unit's, a
    factor above 0, an unknown or retired system, the metric and period; Save and Remove are double-confirmed and audited;
    Test answers the fixed sentence and makes no network call; the preview shows Employee IDs and never a name
  * a person's IDs in other systems: add, one per system, a clash names the holder's Employee ID, remove (the row is kept),
    the system admin lock, super admin only
  * piece A2's Early Year "Set my KPIs" door honours a library row's named people

Each guard is falsified: the request is refused, then goes through once ONLY that condition is removed.
Synthetic (ZZLK / ZZ9LK-*) on the shared suite database; everything is put back at the end.
"""
import atexit
import html as _html
import os
import re
import socket
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The Chart of KPI, piece C: the handshake keys")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
A, B = "ZZLK Group A", "ZZLK Group B"
PREFIX = "ZZ9LK-"
LIBURL = "/admin/performance/library"
SYSURL = LIBURL + "/systems"
LINES = "/admin/users/%d/lines"
FLAG0 = os.environ.get("ONEHR_COA")
TESTSENT = "No system connected yet: the link is saved and will be used once the system is connected."
KEEP = {}

with a.app.app_context():
    _d = a.get_db()
    BASE_NODE = _d.execute("SELECT COALESCE(MAX(id), 0) FROM kpi_chart").fetchone()[0]
    BASE_NAME = _d.execute("SELECT COALESCE(MAX(id), 0) FROM kpi_chart_names").fetchone()[0]
    BASE_ACT = _d.execute("SELECT COALESCE(MAX(id), 0) FROM activity_log").fetchone()[0]
    BASE_SYS = _d.execute("SELECT COALESCE(MAX(id), 0) FROM kpi_ext_systems").fetchone()[0]


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE ? OR username LIKE 'zzlk%'", (PREFIX + "%",))]
    db.execute("DELETE FROM kpi_chart_links WHERE node_id > ? OR system_id > ?", (BASE_NODE, BASE_SYS))
    db.execute("DELETE FROM org_ext_ids WHERE business_group IN (?,?) OR system_id > ?", (A, B, BASE_SYS))
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM user_ext_ids WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_kpi_library_people WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM user_ext_ids WHERE system_id > ?", (BASE_SYS,))
    db.execute("DELETE FROM kpi_ext_systems WHERE id > ?", (BASE_SYS,))
    db.execute("DELETE FROM kpi_chart_names WHERE id > ?", (BASE_NAME,))
    db.execute("UPDATE kpi_chart SET parent_id=NULL WHERE id > ?", (BASE_NODE,))
    db.execute("DELETE FROM kpi_chart WHERE id > ?", (BASE_NODE,))
    db.execute("UPDATE kpi_chart SET was_codes=NULL, retired_at=NULL WHERE id <= ? AND level='persp'", (BASE_NODE,))
    db.execute("DELETE FROM activity_log WHERE id > ? AND action IN ('pm_kpi_chart', 'pm_kpi_library', 'ext_link', 'ext_unlink')", (BASE_ACT,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group IN (?,?)", (A, B))
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?)", (A, B))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (A, B))
    db.commit()


def q1(sql, args=()):
    with a.app.app_context():
        return a.get_db().execute(sql, args).fetchone()


def qa(sql, args=()):
    with a.app.app_context():
        return [dict(r) for r in a.get_db().execute(sql, args).fetchall()]


def dbx(sql, *args):
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute(sql, args)
        d_.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    KEEP["cycle"] = dict(db.execute("SELECT kind, year, half FROM cycles WHERE id=?", (CID,)).fetchone())
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZLK U1'),(?, 'ZZLK U2'),(?, 'ZZLK U9')", (A, A, B))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A'),(?, 'A')", (A, B))
    U = {}
    for n_, bg, co in ((1, A, "ZZLK U1"), (2, A, "ZZLK U1"), (3, A, "ZZLK U2"), (4, B, "ZZLK U9")):
        eid = PREFIX + str(n_)
        U[n_] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                           "department, job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?, 'ZZLK Dept', '14', "
                           "'2020-01-01')", (eid.lower(), "ZZ LK Person " + str(n_), eid, bg, co)).lastrowid
    U["SYSP"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                           "is_system_admin) VALUES ('zzlk-sysp', 'ZZ LK Sysperson', 'x', 'user', ?, ?, 'ZZLK U1', 1)",
                           (PREFIX + "S", A)).lastrowid
    U["LEFT"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                           "left_at) VALUES ('zzlk-left', 'ZZ LK Leaver', 'x', 'user', ?, ?, 'ZZLK U1', '2026-06-22')",
                           (PREFIX + "L", A)).lastrowid
    U["DEMO"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                           "is_demo) VALUES ('zzlk-demo', 'ZZ LK Demo', 'x', 'user', ?, ?, 'ZZLK U1', 1)",
                           (PREFIX + "D", A)).lastrowid
    U["ADM"] = db.execute("INSERT INTO users(username, full_name, password_hash, role) VALUES ('zzlk-adm', 'ZZ LK Admin', 'x', "
                          "'admin')").lastrowid
    U["SYSA"] = db.execute("INSERT INTO users(username, full_name, password_hash, role, is_system_admin) VALUES "
                           "('zzlk-sysa', 'ZZ LK Sysadmin', 'x', 'admin', 1)").lastrowid
    U["BGA"] = db.execute("INSERT INTO users(username, full_name, password_hash, role, admin_bg) VALUES "
                          "('zzlk-bga', 'ZZ LK BG admin', 'x', 'admin', ?)", (A,)).lastrowid

    def lib(name, bg, bu=0):
        return db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
                          "description, unit, method, rate1, rate2, rate3, rate4, rate5, bu_level, active, perspective) "
                          "VALUES (?, '*', '*', 0, '*', ?, NULL, ?, 'RM', 'more', 1, 2, 3, 4, 5, ?, 1, 'Financial')",
                          (bg, name, "Defines " + name, bu)).lastrowid

    def holds(name, *ns):
        for n_ in ns:
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, "
                       "rate4, rate5, business_group, company, description) SELECT ?, id, ?, 10, 'more', 1,2,3,4,5, "
                       "business_group, company, 'own words' FROM users WHERE id=?", (CID, name, U[n_]))
    P = {r["code"]: r["id"] for r in db.execute("SELECT id, code FROM kpi_chart WHERE level='persp'")}
    G, _cg = a._chart_add_node(db, "group", P["1"], "ZZLK Profitability", SU["id"])

    def kpi(name, bg="", group=G):
        nid, code = a._chart_add_node(db, "kpi", group, name, SU["id"])
        a._chart_map_name(db, nid, name, bg, "seed", SU["id"])
        return nid, code
    K_GP, c_gp = kpi("ZZLK Gross profit")          # a BU-level KPI
    K_SV, c_sv = kpi("ZZLK Sales value")           # a person's KPI
    V_SV, c_vsv = a._chart_add_node(db, "variant", K_SV, "ZZLK Sales value: Export", SU["id"], qualifier="Export")
    a._chart_map_name(db, V_SV, "ZZLK Sales value: Export", "", "variant", SU["id"])
    V_GP, c_vgp = a._chart_add_node(db, "variant", K_GP, "ZZLK Gross profit: Plant", SU["id"], qualifier="Plant")
    a._chart_map_name(db, V_GP, "ZZLK Gross profit: Plant", "", "variant", SU["id"])
    lib("ZZLK Gross profit", A, bu=1)
    lib("ZZLK Sales value", A)
    holds("ZZLK Gross profit", 1, 2)
    holds("ZZLK Sales value", 1, 2, 3)
    holds("ZZLK Sales value: Export", 4)
    db.commit()
    ME = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())


def _put_back():
    with a.app.app_context():
        d_ = a.get_db()
        _cleanup(d_)
        k = KEEP["cycle"]
        d_.execute("UPDATE cycles SET kind=?, year=?, half=? WHERE id=?", (k["kind"], k["year"], k["half"], CID))
        d_.commit()
    if FLAG0 is None:
        os.environ.pop("ONEHR_COA", None)
    else:
        os.environ["ONEHR_COA"] = FLAG0


atexit.register(_put_back)
SUP = H.client_as(a, SU["id"])
BGC = H.client_as(a, U["BGA"])
SYSC = H.client_as(a, U["SYSA"])
KEY_SV, KEY_GP = a._kpi_key("ZZLK Sales value"), a._kpi_key("ZZLK Gross profit")


def txt(r):
    return _html.unescape(r.get_data(as_text=True))


def post(client, data, url=LIBURL):
    d = dict(data)
    d["csrf_token"] = "tok"
    return client.post(url, data=d, follow_redirects=True)


def flashes(r):
    return " ".join(_html.unescape(m) for m in re.findall(r'class="flash[^"]*"[^>]*>(.*?)</div>', r.get_data(as_text=True), re.S))


def acts(n=0):
    return [r["detail"] for r in qa("SELECT detail FROM activity_log WHERE id > ? AND action='pm_kpi_chart' ORDER BY id", (BASE_ACT,))][n:]


def n_acts():
    return len(acts())


def sys_id(name):
    r = q1("SELECT id FROM kpi_ext_systems WHERE name=?", (name,))
    return r[0] if r else None


def add_system(name, client=None):
    return post(client or SUP, {"action": "system_add", "system_name": name}, SYSURL)


def lk(node_id):
    r = q1("SELECT * FROM kpi_chart_links WHERE node_id=?", (node_id,))
    return dict(r) if r else None


def n_links():
    return q1("SELECT COUNT(*) FROM kpi_chart_links")[0]


def link_form(node, key=KEY_SV, **kw):
    d = {"action": "chart_link_save", "kpi": key, "node_id": node, "system_id": SID1, "metric_id": "M-100", "period": "quarter",
         "whose": "person", "matched_on": "employee_id", "unit": "", "factor": "1"}
    d.update(kw)
    return d


def kpi_page(key=KEY_SV, client=None, **args):
    qs = "&".join("%s=%s" % (k, v) for k, v in args.items())
    return txt((client or SUP).get(LIBURL + "?kpi=%s&panel=kpi%s" % (key.replace(" ", "+"), "&" + qs if qs else "")))


def refused_then_ok(name, bad, expect, fix, check_after=None):
    """`bad` is posted and refused (the flash holds `expect`, nothing written); `fix` removes ONLY that condition; the same
    request is posted again and goes through (the guard is the reason, not the request)."""
    n0, a0 = n_links(), n_acts()
    r = bad()
    s.check("%s: refused, nothing written" % name, expect in flashes(r) and n_links() == n0 and n_acts() == a0, (expect, flashes(r)))
    fix()
    r = bad()
    s.check("   FALSIFY: with only that condition removed the same request goes through", expect not in flashes(r)
            and (check_after() if check_after else (n_links() == n0 + 1 or n_acts() > a0)), flashes(r))


try:
    # ---------------------------------------------------------------------------------------------------------------
    s.section("storage")
    with a.app.app_context():
        dd = a.get_db()
        _cols = {t: [r[1] for r in dd.execute("PRAGMA table_info(%s)" % t)]
                 for t in ("kpi_ext_systems", "kpi_chart_links", "user_ext_ids", "org_ext_ids")}
        cols = _cols.__getitem__
        idx_sql = {r[0]: r[1] for r in dd.execute("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name IN "
                                                  "('user_ext_ids','org_ext_ids','kpi_chart_links')")}
        t_sql = {r[0]: r[1] for r in dd.execute("SELECT name, sql FROM sqlite_master WHERE type='table'")}
    s.check("kpi_ext_systems has id, name (unique), note, added_by, added_at, retired_at",
            cols("kpi_ext_systems") == ["id", "name", "note", "added_by", "added_at", "retired_at"]
            and "name TEXT NOT NULL UNIQUE" in t_sql["kpi_ext_systems"], cols("kpi_ext_systems"))
    s.check("kpi_chart_links: one per node, the system, the metric, the period, whose, matched on, unit, factor, who and when",
            cols("kpi_chart_links") == ["id", "node_id", "system_id", "metric_id", "period", "whose", "matched_on", "unit", "factor",
                                        "updated_by", "updated_at"] and "node_id INTEGER NOT NULL UNIQUE" in t_sql["kpi_chart_links"],
            cols("kpi_chart_links"))
    s.check("user_ext_ids carries linked and removed (at, by) and a unique partial index on active (system, ID) and (person, system)",
            cols("user_ext_ids") == ["id", "user_id", "system_id", "ext_id", "linked_at", "linked_by", "removed_at", "removed_by"]
            and "ON user_ext_ids(system_id, ext_id) WHERE removed_at IS NULL" in idx_sql.get("idx_user_ext_ids_active", "")
            and "ON user_ext_ids(user_id, system_id) WHERE removed_at IS NULL" in idx_sql.get("idx_user_ext_ids_one", ""))
    s.check("org_ext_ids: group, unit, system, code; a code and a (unit, system) are unique",
            cols("org_ext_ids") == ["id", "business_group", "company", "system_id", "ext_code", "linked_by", "linked_at"]
            and "UNIQUE(system_id, ext_code)" in t_sql["org_ext_ids"] and "UNIQUE(business_group, company, system_id)" in t_sql["org_ext_ids"])
    with a.app.app_context():
        dd = a.get_db()
        dd.execute("INSERT INTO kpi_ext_systems(name) VALUES ('ZZLK raw')")
        rs = dd.execute("SELECT id FROM kpi_ext_systems WHERE name='ZZLK raw'").fetchone()[0]

        def boom(sql, *args):
            try:
                dd.execute(sql, args)
                return False
            except sqlite3.IntegrityError:
                return True
        s.check("the database itself refuses: a system twice (any case), a period, a whose and a matched on off the lists, a factor of 0",
                boom("INSERT INTO kpi_ext_systems(name) VALUES ('zzlk RAW')")
                and boom("INSERT INTO kpi_chart_links(node_id, system_id, metric_id, period, whose) VALUES (?,?,'m','week','unit')", K_SV, rs)
                and boom("INSERT INTO kpi_chart_links(node_id, system_id, metric_id, period, whose) VALUES (?,?,'m','month','team')", K_SV, rs)
                and boom("INSERT INTO kpi_chart_links(node_id, system_id, metric_id, period, whose, matched_on) VALUES (?,?,'m','month','unit','x')", K_SV, rs)
                and boom("INSERT INTO kpi_chart_links(node_id, system_id, metric_id, period, whose, factor) VALUES (?,?,'m','month','unit',0)", K_SV, rs))
        dd.execute("INSERT INTO user_ext_ids(user_id, system_id, ext_id) VALUES (?,?,'abc')", (U[1], rs))
        s.check("...an active ID twice in a system (any case) and a second active ID for one person in a system",
                boom("INSERT INTO user_ext_ids(user_id, system_id, ext_id) VALUES (?,?,'ABC')", U[2], rs)
                and boom("INSERT INTO user_ext_ids(user_id, system_id, ext_id) VALUES (?,?,'other')", U[1], rs))
        dd.execute("UPDATE user_ext_ids SET removed_at=datetime('now') WHERE user_id=?", (U[1],))
        s.check("...but a removed ID frees both", not boom("INSERT INTO user_ext_ids(user_id, system_id, ext_id) VALUES (?,?,'abc')", U[2], rs)
                and not boom("INSERT INTO user_ext_ids(user_id, system_id, ext_id) VALUES (?,?,'again')", U[1], rs))
        dd.execute("INSERT INTO org_ext_ids(business_group, company, system_id, ext_code) VALUES (?, 'ZZLK U1', ?, 'c1')", (A, rs))
        s.check("...a unit code twice in a system, and a second code for a unit in a system",
                boom("INSERT INTO org_ext_ids(business_group, company, system_id, ext_code) VALUES (?, 'ZZLK U2', ?, 'C1')", A, rs)
                and boom("INSERT INTO org_ext_ids(business_group, company, system_id, ext_code) VALUES (?, 'ZZLK U1', ?, 'c2')", A, rs))
        dd.rollback()

    # ---------------------------------------------------------------------------------------------------------------
    s.section("dark unless ONEHR_COA=1; the super admin's alone")
    os.environ.pop("ONEHR_COA", None)
    SID_OFF = None
    n0, a0 = q1("SELECT COUNT(*) FROM kpi_ext_systems")[0], n_acts()
    p_off = SUP.get(LIBURL + "?kpi=%s&panel=kpi" % KEY_SV.replace(" ", "+")).get_data(as_text=True)
    acc_off = SUP.get("/admin/users/%d?panel=account" % U[1]).get_data(as_text=True)
    s.check("flag off: the Systems page is a 404 (GET and POST) and writes nothing",
            SUP.get(SYSURL).status_code == 404 and SUP.post(SYSURL, data={"csrf_token": "tok", "action": "system_add", "system_name": "ZZLK off"}).status_code == 404
            and q1("SELECT COUNT(*) FROM kpi_ext_systems")[0] == n0)
    s.check("flag off: a link save / remove from the library page is a 404 for the super admin and writes nothing",
            all(SUP.post(LIBURL, data={"csrf_token": "tok", "action": ac, "kpi": KEY_SV, "node_id": K_SV}).status_code == 404
                for ac in ("chart_link_save", "chart_link_remove")) and n_links() == 0)
    s.check("flag off: a person's ext_link / ext_unlink is a 404 for the super admin and writes nothing",
            all(SUP.post(LINES % U[1], data={"csrf_token": "tok", "action": ac, "system_id": "1", "ext_id": "x", "ext_row": "1"}).status_code == 404
                for ac in ("ext_link", "ext_unlink")) and q1("SELECT COUNT(*) FROM user_ext_ids")[0] == 0)
    s.check("flag off: nothing new is drawn (no Data link, no Systems tab, no IDs in other systems)",
            "Data link" not in p_off and "Systems" not in SUP.get(LIBURL).get_data(as_text=True)
            and "IDs in other systems" not in acc_off and 'id="ext-ids"' not in acc_off and "Employee IDs" in acc_off)
    s.check("flag off: no new activity rows", n_acts() == a0)

    os.environ["ONEHR_COA"] = "1"
    s.check("flag on: the super admin opens Systems", SUP.get(SYSURL).status_code == 200)
    s.check("flag on: a BG admin gets a 403 on Systems (GET and POST), on a link save and on a person's ID; nothing is written",
            BGC.get(SYSURL).status_code == 403
            and BGC.post(SYSURL, data={"csrf_token": "tok", "action": "system_add", "system_name": "ZZLK bg"}).status_code == 403
            and BGC.post(LIBURL, data={"csrf_token": "tok", "action": "chart_link_save", "kpi": KEY_SV, "node_id": K_SV}).status_code == 403
            and BGC.post(LINES % U[1], data={"csrf_token": "tok", "action": "ext_link", "system_id": "1", "ext_id": "x"}).status_code in (403, 404)
            and q1("SELECT COUNT(*) FROM kpi_ext_systems")[0] == n0)
    s.check("a signed-out visitor does not get the page", a.app.test_client().get(SYSURL).status_code in (301, 302, 303, 401, 403))
    amap = a.ADMIN_ACCESS_MAP
    s.check("the access map says super for the Systems page and for ext_link / ext_unlink",
            amap.get("admin_kpi_systems") == "super" and amap["admin_person_lines"]["map"].get("ext_link") == "super"
            and amap["admin_person_lines"]["map"].get("ext_unlink") == "super", amap.get("admin_person_lines"))
    s.check("the page is in the menu under the library, and the tabs say Systems on the library, merge queue, match and requests pages",
            '_pg("admin_kpi_systems", "Systems", hidden=True, under="admin_kpi_library")' in H.source(a)
            and all("Systems" in SUP.get(u).get_data(as_text=True) for u in (LIBURL, LIBURL + "/merges", LIBURL + "/match", LIBURL + "/requests")
                    if SUP.get(u).status_code == 200))
    s.check("an unknown action is a 400", SUP.post(SYSURL, data={"csrf_token": "tok", "action": "nope"}).status_code == 400)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Systems: add, retire, bring back")
    r = add_system("ZZLK Alpha")
    SID1 = sys_id("ZZLK Alpha")
    s.check("a system is added by name and the page says so, in the trail", SID1 and "Added the system ZZLK Alpha" in flashes(r)
            and "system added: ZZLK Alpha" in acts()[-1])
    r = add_system("zzlk ALPHA")
    s.check("the same name in another case is refused (one system)", "already a system" in flashes(r)
            and q1("SELECT COUNT(*) FROM kpi_ext_systems WHERE name LIKE 'ZZLK Alpha'")[0] == 1)
    n1 = q1("SELECT COUNT(*) FROM kpi_ext_systems")[0]
    for nm, why in (("", "Type the system's name"), ("   ", "Type the system's name"), ("x" * 61, "at most" if False else "60 characters"),
                    ("https://user:pw@example.test/api", "no address")):
        r = add_system(nm)
        s.check("refused and nothing written: %r" % nm[:24], why in flashes(r) and q1("SELECT COUNT(*) FROM kpi_ext_systems")[0] == n1, flashes(r))
    r = add_system("y" * 60)
    s.check("   FALSIFY the length rule: exactly 60 characters goes in", sys_id("y" * 60) is not None, flashes(r))
    r = add_system("ZZLK Beta")
    SID2 = sys_id("ZZLK Beta")
    s.check("a second system", SID2 and SID2 != SID1)
    r = post(SUP, {"action": "system_add", "system_name": "ZZLK Gamma"}, SYSURL)
    SID3 = sys_id("ZZLK Gamma")
    s.check("the helper text says never a credential", "Never type a password, key, token or address with a login" in txt(SUP.get(SYSURL)))
    pg = txt(SUP.get(SYSURL))
    s.check("every Systems form is double-confirmed", all("data-confirm=" in m for m in [m for m in re.findall(r"<form[^>]*method=\"post\"[^>]*>", pg) if 'class="logout-form"' not in m]), len(pg))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("unit codes")
    UC = lambda **kw: post(SUP, dict({"action": "unitcode_add", "business_group": A, "company": "ZZLK U1", "system_id": SID1, "ext_code": "CC-1"}, **kw), SYSURL)
    r = UC()
    row = q1("SELECT * FROM org_ext_ids WHERE system_id=?", (SID1,))
    s.check("a unit's code is set (group and unit from the org, the system, the code), in the trail",
            row and (row["business_group"], row["company"], row["ext_code"]) == (A, "ZZLK U1", "CC-1") and "unit code set" in acts()[-1], flashes(r))
    r = UC(company="zzlk u2", ext_code="cc-1")
    s.check("a code belongs to one unit in a system: the message names the unit", "already ZZLK U1's code" in flashes(r) or "already Zzlk U1's code" in flashes(r)
            or "U1's code" in flashes(r), flashes(r))
    s.check("   ...nothing written", q1("SELECT COUNT(*) FROM org_ext_ids WHERE system_id=?", (SID1,))[0] == 1)
    r = UC(company="zzlk u2", ext_code="CC-2")
    s.check("   FALSIFY: the same unit with another code goes in (case of the unit ignored)", q1("SELECT COUNT(*) FROM org_ext_ids WHERE system_id=?", (SID1,))[0] == 2, flashes(r))
    r = UC(ext_code="CC-9")
    s.check("a unit has one code per system: a second is refused", "already has the code CC-1" in flashes(r)
            and q1("SELECT COUNT(*) FROM org_ext_ids WHERE system_id=? AND company='ZZLK U1'", (SID1,))[0] == 1)
    r = UC(system_id=SID2, ext_code="CC-9")
    s.check("   FALSIFY: the same unit in another system takes a code", q1("SELECT ext_code FROM org_ext_ids WHERE system_id=?", (SID2,)) is not None, flashes(r))
    n_codes = q1("SELECT COUNT(*) FROM org_ext_ids")[0]
    r = UC(company="Made up unit", ext_code="CC-7")
    s.check("a unit that is not in the org is refused (never free text)", "Pick the business group and the unit from the lists" in flashes(r) and q1("SELECT COUNT(*) FROM org_ext_ids")[0] == n_codes)
    r = UC(company="ZZLK U9", ext_code="CC-7")
    s.check("a real unit of ANOTHER group is refused too", "Pick the business group and the unit" in flashes(r) and q1("SELECT COUNT(*) FROM org_ext_ids")[0] == n_codes)
    r = UC(business_group="Made up group", company="ZZLK U1", ext_code="CC-7")
    s.check("an unknown group is refused", "Pick the business group and the unit" in flashes(r) and q1("SELECT COUNT(*) FROM org_ext_ids")[0] == n_codes)
    r = UC(business_group=B, company="ZZLK U9", ext_code="CC-7")
    s.check("   FALSIFY: the unit with its own group goes in", q1("SELECT COUNT(*) FROM org_ext_ids")[0] == n_codes + 1, flashes(r))
    for kw, why in (({"ext_code": ""}, "Type the unit's code"), ({"ext_code": "z" * 61}, "at most 60"), ({"system_id": "9999999"}, "Pick a system"),
                    ({"system_id": "abc"}, "Pick a system")):
        n_ = q1("SELECT COUNT(*) FROM org_ext_ids")[0]
        r = UC(company="ZZLK U2", **kw)
        s.check("refused: %s" % (list(kw.items())[0],), why in flashes(r) and q1("SELECT COUNT(*) FROM org_ext_ids")[0] == n_, flashes(r))
    # retire a system: it is hidden from new codes
    post(SUP, {"action": "system_retire", "system_id": SID3}, SYSURL)
    n_ = q1("SELECT COUNT(*) FROM org_ext_ids")[0]
    r = UC(company="ZZLK U2", system_id=SID3, ext_code="CC-3")
    s.check("a retired system takes no new code", "is retired" in flashes(r) and q1("SELECT COUNT(*) FROM org_ext_ids")[0] == n_)
    post(SUP, {"action": "system_restore", "system_id": SID3}, SYSURL)
    r = UC(company="ZZLK U2", system_id=SID3, ext_code="CC-3")
    s.check("   FALSIFY: brought back, the same request goes in", q1("SELECT COUNT(*) FROM org_ext_ids")[0] == n_ + 1, flashes(r))
    rid = q1("SELECT id FROM org_ext_ids WHERE system_id=? AND ext_code='CC-3'", (SID3,))[0]
    r = post(SUP, {"action": "unitcode_remove", "code_id": rid}, SYSURL)
    s.check("a unit code is removed and the trail says so", q1("SELECT COUNT(*) FROM org_ext_ids WHERE id=?", (rid,))[0] == 0 and "unit code removed" in acts()[-1], flashes(r))
    r = post(SUP, {"action": "unitcode_remove", "code_id": rid}, SYSURL)
    s.check("removing it again changes nothing", "no longer there" in flashes(r))
    pg = txt(SUP.get(SYSURL))
    s.check("the page lists the codes with the group and unit, and the unit picker lists only real units",
            "CC-1" in pg and "ZZLK U1" in pg and 'data-bg="%s"' % A in pg and "Made up unit" not in pg)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the data link: combinations, BU-level, factor, system")
    ok = lambda r, m="now reads": m in flashes(r)
    r = post(SUP, link_form(K_SV))
    L = lk(K_SV)
    s.check("a person's KPI links by Employee ID: stored, flashed, in the trail", L and (L["system_id"], L["metric_id"], L["period"], L["whose"], L["matched_on"], L["factor"]) == (SID1, "M-100", "quarter", "person", "employee_id", 1.0)
            and ok(r) and "data link saved on %s" % c_sv in acts()[-1], flashes(r))
    r = post(SUP, link_form(K_SV, matched_on="system_person_code", period="year", metric_id="  M  200 ", factor="0.000001", unit="RM"))
    L = lk(K_SV)
    s.check("a change by the person's ID in the system: metric folded, factor and unit kept, 'changed' in the trail",
            L and (L["matched_on"], L["metric_id"], L["period"], L["factor"], L["unit"]) == ("system_person_code", "M 200", "year", 1e-06, "RM")
            and "data link changed on %s" % c_sv in acts()[-1], (flashes(r), L))
    r = post(SUP, link_form(K_SV, matched_on="system_person_code", period="year", metric_id="M 200", factor="0.000001", unit="RM"))
    s.check("saving it unchanged says so and writes no trail row", "exactly that" in flashes(r))
    # the combinations
    combos = [("person", "employee_id", True), ("person", "system_person_code", True), ("person", "unit_code", False),
              ("unit", "unit_code", True), ("unit", "employee_id", False), ("unit", "system_person_code", False), ("unit", "", False),
              ("group", "", True), ("group", "employee_id", False), ("group", "unit_code", False), ("team", "", False),
              ("person", "nonsense", False), ("person", "", False), ("", "", False)]
    got = []
    for who, mo, want in combos:
        dbx("DELETE FROM kpi_chart_links WHERE node_id=?", K_SV)
        n0 = n_links()
        r = post(SUP, link_form(K_SV, whose=who, matched_on=mo))
        got.append(((who, mo), (n_links() == n0 + 1) == want))
    s.check("every whose x matched-on pairing is accepted or refused as designed (%d pairs)" % len(combos), all(g for _c, g in got), [c_ for c_, g in got if not g])
    dbx("DELETE FROM kpi_chart_links WHERE node_id=?", K_SV)
    r = post(SUP, link_form(K_SV, whose="person", matched_on="unit_code"))
    s.check("   the message says what a person's figure is matched on", "matched on employee id or the person's id in the system" in flashes(r).lower(), flashes(r))
    # BU-level
    n0 = n_links()
    r = post(SUP, link_form(K_GP, key=KEY_GP, whose="person", matched_on="employee_id"))
    s.check("a BU-level KPI refuses a person's figure, saying why", "BU-level KPI" in flashes(r) and n_links() == n0, flashes(r))
    r = post(SUP, link_form(K_GP, key=KEY_GP, whose="group", matched_on=""))
    s.check("...and a business group's", "BU-level KPI" in flashes(r) and n_links() == n0)
    r = post(SUP, link_form(K_GP, key=KEY_GP, whose="unit", matched_on="unit_code"))
    s.check("   FALSIFY: the same KPI linked as the unit's figure goes in", lk(K_GP) and lk(K_GP)["whose"] == "unit", flashes(r))
    r = post(SUP, link_form(V_GP, key=KEY_GP, whose="person", matched_on="employee_id"))
    s.check("a variant of a BU-level KPI is the unit's too", "BU-level KPI" in flashes(r) and lk(V_GP) is None, flashes(r))
    dbx("UPDATE pm_kpi_library SET bu_level=0 WHERE business_group=? AND kpi_name='ZZLK Gross profit'", A)
    r = post(SUP, link_form(K_GP, key=KEY_GP, whose="person", matched_on="employee_id"))
    s.check("   FALSIFY: with the library row no longer BU-level the person's figure is allowed", lk(K_GP)["whose"] == "person", flashes(r))
    dbx("UPDATE pm_kpi_library SET bu_level=1 WHERE business_group=? AND kpi_name='ZZLK Gross profit'", A)
    dbx("UPDATE pm_kpi_library SET active=0 WHERE business_group=? AND kpi_name='ZZLK Gross profit'", A)
    r = post(SUP, link_form(K_GP, key=KEY_GP, whose="group", matched_on=""))
    s.check("   only an ACTIVE BU-level row counts: retired, the group's figure is allowed", lk(K_GP)["whose"] == "group", flashes(r))
    dbx("UPDATE pm_kpi_library SET active=1 WHERE business_group=? AND kpi_name='ZZLK Gross profit'", A)
    dbx("DELETE FROM kpi_chart_links WHERE node_id=?", K_GP)
    # factor
    for bad_f in ("0", "-1", "abc", "nan", "inf", "1e20"):
        dbx("DELETE FROM kpi_chart_links WHERE node_id=?", K_SV)
        r = post(SUP, link_form(K_SV, factor=bad_f))
        s.check("a factor of %r is refused" % bad_f, "number above 0" in flashes(r) and lk(K_SV) is None, flashes(r))
    r = post(SUP, link_form(K_SV, factor="0.5"))
    s.check("   FALSIFY: a factor above 0 goes in", lk(K_SV)["factor"] == 0.5, flashes(r))
    dbx("DELETE FROM kpi_chart_links WHERE node_id=?", K_SV)
    r = post(SUP, link_form(K_SV, factor=""))
    s.check("a blank factor reads 1", lk(K_SV)["factor"] == 1.0)
    dbx("DELETE FROM kpi_chart_links WHERE node_id=?", K_SV)
    # metric / period / system / node
    for kw, why in (({"metric_id": ""}, "Type the measure's ID"), ({"metric_id": "m" * 121}, "at most 120"), ({"metric_id": "https://x.test/?k=1"}, "not an address"),
                    ({"period": "week"}, "Pick the period"), ({"period": ""}, "Pick the period"), ({"system_id": "9999999"}, "Pick a system"),
                    ({"system_id": ""}, "Pick a system")):
        r = post(SUP, link_form(K_SV, **kw))
        s.check("refused: %s" % list(kw.items())[0][0] + "=" + repr(list(kw.values())[0])[:14], why in flashes(r) and lk(K_SV) is None, flashes(r))
    post(SUP, {"action": "system_retire", "system_id": SID1}, SYSURL)
    r = post(SUP, link_form(K_SV))
    s.check("a retired system takes no new link", "is retired" in flashes(r) and lk(K_SV) is None)
    post(SUP, {"action": "system_restore", "system_id": SID1}, SYSURL)
    r = post(SUP, link_form(K_SV))
    s.check("   FALSIFY: brought back, the same request goes in", lk(K_SV) is not None, flashes(r))
    r = post(SUP, link_form(K_SV, node_id=K_GP + 9999))
    s.check("a node outside the KPI's family is a 400 (nothing written)", SUP.post(LIBURL, data={"csrf_token": "tok", **link_form(P["1"], key=KEY_SV)}).status_code == 400
            and SUP.post(LIBURL, data={"csrf_token": "tok", **link_form(K_GP, key=KEY_SV)}).status_code == 400 and lk(K_GP) is None)
    r = post(SUP, link_form(V_SV))
    s.check("a variant of the KPI takes a link of its own, and the KPI's is untouched", lk(V_SV) and lk(V_SV)["node_id"] == V_SV and lk(K_SV)["metric_id"] == "M-100")
    dbx("UPDATE kpi_chart SET retired_at=datetime('now') WHERE id=?", V_SV)
    r = post(SUP, link_form(V_SV, metric_id="M-300"))
    s.check("a retired node takes no change", "retired" in flashes(r) and lk(V_SV)["metric_id"] == "M-100")
    dbx("UPDATE kpi_chart SET retired_at=NULL WHERE id=?", V_SV)
    # retire the system a link uses: still readable
    post(SUP, {"action": "system_retire", "system_id": SID1}, SYSURL)
    pg = kpi_page()
    s.check("a retired system's links stay readable: the editor shows it as retired", "ZZLK Alpha (retired)" in pg)
    r = post(SUP, link_form(K_SV, metric_id="M-999"))
    s.check("   ...but saving a change to it is refused until another system is picked", "is retired" in flashes(r) and lk(K_SV)["metric_id"] == "M-100")
    post(SUP, {"action": "system_restore", "system_id": SID1}, SYSURL)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the data link on the page")
    pg = kpi_page()
    s.check("the KPI panel has a Data link section with the system, the measure, the period, whose figure, matched on, unit and factor",
            "Data link" in pg and all(x in pg for x in ('name="system_id"', 'name="metric_id"', 'name="period"', 'name="whose"', 'name="matched_on"',
                                                         'name="unit"', 'name="factor"')) and "ZZLK Alpha" in pg)
    s.check("Save and Remove are double-confirmed", re.search(r'<form[^>]*data-coa-link[^>]*data-confirm="Save the data link for', pg)
            and re.search(r'<form[^>]*data-confirm="Remove the data link from[^"]*"[^>]*data-confirm-tone="danger"', pg))
    s.check("the saved values are in the form", 'value="M-100"' in pg and re.search(r'<option value="quarter"\s+selected', pg)
            and re.search(r'name="whose" value="person"\s+checked', pg))
    s.check("the variants list has a Data link column that opens a variant's own panel",
            "Data link</span>" in pg and "panel=link" in pg and "link=%d" % V_SV in pg)
    pgv = txt(SUP.get(LIBURL + "?kpi=%s&panel=link&link=%d" % (KEY_SV.replace(" ", "+"), V_SV)))
    s.check("a variant's panel holds the same editor for that variant", 'id="pnl-link"' in pgv and 'value="%d"' % V_SV in pgv and 'name="node_id" value="%d"' % V_SV in pgv)
    pgg = kpi_page(KEY_GP, link=K_GP)
    s.check("a BU-level KPI offers only the unit's figure: the other two are disabled and the page says why",
            re.search(r'name="whose" value="person"\s+disabled', pgg) and re.search(r'name="whose" value="group"\s+disabled', pgg)
            and re.search(r'name="whose" value="unit"\s+checked', pgg) and "A BU-level KPI: one figure per unit" in pgg)
    s.check("?panel=link opens the variant's panel and not the KPI's; without it the KPI's panel opens as before",
            'data-panel="kpi"' in pgv and "data-panel-autoopen" not in pgv.split('data-panel="kpi"')[1].split(">")[0]
            and "data-panel-autoopen" in pg.split('data-panel="kpi"')[1].split(">")[0])
    # remove
    r = post(SUP, {"action": "chart_link_remove", "kpi": KEY_SV, "node_id": V_SV})
    s.check("Remove takes the link off, in the trail, and the KPI's own stays", lk(V_SV) is None and lk(K_SV) and "data link removed" in acts()[-1], flashes(r))
    r = post(SUP, {"action": "chart_link_remove", "kpi": KEY_SV, "node_id": V_SV})
    s.check("removing it again changes nothing", "no link to remove" in flashes(r))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Test the link: a fixed answer, no network")
    a0, n0 = n_acts(), n_links()
    pg_no = kpi_page()
    real_connect = socket.socket.connect


    def no_net(self, *aa, **kk):
        raise AssertionError("a network call was made")
    socket.socket.connect = no_net
    try:
        pg_t = kpi_page(link_test=K_SV)
    finally:
        socket.socket.connect = real_connect
    s.check("Test answers the fixed sentence", TESTSENT in pg_t and TESTSENT not in pg_no and "Test the link" in pg_no)
    s.check("a test writes nothing (no link change, no trail row)", n_acts() == a0 and n_links() == n0 and lk(K_SV)["metric_id"] == "M-100")
    s.check("Test is a plain link, not a POST form", re.search(r'<a class="btn-link" href="[^"]*link_test=%d[^"]*">Test the link</a>' % K_SV, pg_no))
    dbx("DELETE FROM kpi_chart_links WHERE node_id=?", K_SV)
    _pg0 = kpi_page()
    s.check("with no link saved there is nothing to test", "Test the link" not in _pg0 and TESTSENT not in kpi_page(link_test=K_SV),
            [(m.start(), _pg0[max(0, m.start() - 160): m.start() + 40]) for m in re.finditer("Test the link", _pg0)][:1])
    post(SUP, link_form(K_SV, matched_on="system_person_code"))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("a person's IDs in other systems")
    ADD = lambda uid, sid, ext, c=None: post(c or SUP, {"action": "ext_link", "system_id": sid, "ext_id": ext}, LINES % uid)
    DEL = lambda uid, rid, c=None: post(c or SUP, {"action": "ext_unlink", "ext_row": rid}, LINES % uid)
    act = lambda uid: qa("SELECT * FROM user_ext_ids WHERE user_id=? AND removed_at IS NULL", (uid,))
    r = ADD(U[1], SID1, "  SP 001 ")
    row = act(U[1])
    s.check("an ID is added (folded), linked by the super admin, audited", len(row) == 1 and row[0]["ext_id"] == "SP 001" and row[0]["system_id"] == SID1 and row[0]["linked_by"] == SU["id"]
            and q1("SELECT COUNT(*) FROM activity_log WHERE action='ext_link' AND target_user_id=?", (U[1],))[0] == 1, flashes(r))
    r = ADD(U[2], SID1, "sp 001")
    s.check("an ID another person holds in the same system is refused (case ignored); the message names the holder's Employee ID, not their name",
            "already the ID of ZZ9LK-1 in ZZLK Alpha" in flashes(r) and "ZZ LK Person" not in flashes(r) and len(act(U[2])) == 0, flashes(r))
    dbx("UPDATE user_ext_ids SET removed_at=datetime('now') WHERE user_id=?", U[1])
    r = ADD(U[2], SID1, "sp 001")
    s.check("   FALSIFY: with the holder's ID removed the same request goes through", len(act(U[2])) == 1 and len(act(U[1])) == 0, flashes(r))
    dbx("UPDATE user_ext_ids SET removed_at=datetime('now') WHERE user_id=?", U[2])
    r = ADD(U[1], SID1, "SP 001")
    s.check("person 1 holds SP 001 again", len(act(U[1])) == 1, flashes(r))
    r = ADD(U[1], SID1, "SP 777")
    s.check("one ID per person per system: a second is refused, naming the first", "already has the ID" in flashes(r) and len(act(U[1])) == 1 and act(U[1])[0]["ext_id"] != "SP 777", flashes(r))
    r = ADD(U[1], SID2, "SP 777")
    s.check("   FALSIFY: in ANOTHER system the same person takes an ID", len(act(U[1])) == 2, flashes(r))
    r = ADD(U[3], SID2, "SP 777")
    s.check("an ID held in this system cannot be taken by another person in it, naming the holder's Employee ID",
            "already the ID of ZZ9LK-1 in ZZLK Beta" in flashes(r) and len(act(U[3])) == 0, flashes(r))
    r = ADD(U[3], SID3, "SP 777")
    s.check("   FALSIFY: in a third system that ID is free", len(act(U[3])) == 1, flashes(r))
    for kw, why in (((U[2], SID1, ""), "Type the person's ID"), ((U[2], SID1, "q" * 61), "at most 60"), ((U[2], "999999", "x"), "Pick a system"),
                    ((U[2], "abc", "x"), "Pick a system")):
        n_ = q1("SELECT COUNT(*) FROM user_ext_ids")[0]
        r = ADD(*kw)
        s.check("refused: %s" % why, why in flashes(r) and q1("SELECT COUNT(*) FROM user_ext_ids")[0] == n_, flashes(r))
    post(SUP, {"action": "system_retire", "system_id": SID3}, SYSURL)
    n_ = q1("SELECT COUNT(*) FROM user_ext_ids")[0]
    r = ADD(U[2], SID3, "RET-1")
    s.check("a retired system takes no new ID", "is retired" in flashes(r) and q1("SELECT COUNT(*) FROM user_ext_ids")[0] == n_)
    post(SUP, {"action": "system_restore", "system_id": SID3}, SYSURL)
    r = ADD(U[2], SID3, "RET-1")
    s.check("   FALSIFY: brought back, the same request goes in", len(act(U[2])) == 1, flashes(r))
    for key_, why in (("LEFT", "has left"), ("DEMO", "Pick a person"), ("ADM", "Pick a person")):
        n_ = q1("SELECT COUNT(*) FROM user_ext_ids")[0]
        r = ADD(U[key_], SID1, "NOPE-" + key_)
        s.check("an account that has left / a demo / an admin takes no ID (%s)" % key_, q1("SELECT COUNT(*) FROM user_ext_ids")[0] == n_, flashes(r))
    # the system admin lock
    n_ = q1("SELECT COUNT(*) FROM user_ext_ids")[0]
    r = ADD(U["SYSP"], SID1, "SYS-1")
    s.check("a system admin's account is theirs: a plain super admin is refused with the lock sentence", a.SYSTEM_ADMIN_LOCK_MSG in flashes(r)
            and q1("SELECT COUNT(*) FROM user_ext_ids")[0] == n_, flashes(r))
    r = ADD(U["SYSP"], SID1, "SYS-1", c=SYSC)
    s.check("   FALSIFY: a system admin makes the same change", len(act(U["SYSP"])) == 1, flashes(r))
    rid = act(U["SYSP"])[0]["id"]
    r = DEL(U["SYSP"], rid)
    s.check("...and the lock holds for Remove", a.SYSTEM_ADMIN_LOCK_MSG in flashes(r) and len(act(U["SYSP"])) == 1)
    r = DEL(U["SYSP"], rid, c=SYSC)
    s.check("   FALSIFY: the system admin removes it", len(act(U["SYSP"])) == 0, flashes(r))
    # remove
    rid = act(U[1])[0]["id"]
    r = DEL(U[2], rid)
    s.check("an ID can be removed only from the person who holds it", "isn't one of" in flashes(r) and len(act(U[1])) >= 1)
    r = DEL(U[1], rid)
    kept = q1("SELECT removed_at, removed_by FROM user_ext_ids WHERE id=?", (rid,))
    s.check("   FALSIFY: from its holder it goes: the row is kept with removed_at and removed_by, audited", kept and kept[0] and kept[1] == SU["id"]
            and q1("SELECT COUNT(*) FROM activity_log WHERE action='ext_unlink' AND target_user_id=?", (U[1],))[0] == 1, flashes(r))
    r = DEL(U[1], rid)
    s.check("removing it again changes nothing", "isn't one of" in flashes(r))
    r = ADD(U[1], SID1, "SP 001")
    s.check("a removed ID may be added again", any(x["ext_id"] == "SP 001" for x in act(U[1])), flashes(r))
    # page
    acc = txt(SUP.get("/admin/users/%d?panel=account" % U[1]))
    i = acc.find('id="ext-ids"')
    bx = acc[i: acc.find("<b>Work email</b>", i)]
    s.check("the Account panel has the box under Employee IDs, with the ID, its system and Remove",
            i > acc.find('id="employee-ids"') > 0 and "IDs in other systems" in bx and "SP 001" in bx and "ZZLK Alpha" in bx and ">Remove<" in bx and "Add an ID" in bx)
    s.check("...every form in it is double-confirmed", all("data-confirm=" in f for f in re.findall(r"<form[^>]*>", bx)) and "Never a password or key" in bx)
    s.check("a BG admin viewing the person sees no such box", 'id="ext-ids"' not in txt(BGC.get("/admin/users/%d" % U[1])))
    s.check("the person's own pages never show it", "IDs in other systems" not in txt(H.client_as(a, U[1]).get("/dashboard")))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the preview: what a pull would fill (Employee IDs, never names)")
    post(SUP, link_form(K_SV, matched_on="system_person_code", system_id=SID1))
    dbx("UPDATE user_ext_ids SET removed_at=datetime('now') WHERE user_id IN (?,?,?)", U[2], U[3], U[1])
    ADD(U[1], SID1, "SP-ONE")
    pg = kpi_page()
    j = pg.find('aria-label="What a pull would fill"')
    pv = pg[j: pg.find("A test only reads", j)] if j >= 0 else ""
    s.check("the holders appear by Employee ID in order with their ID in the system or 'No ID yet'",
            j >= 0 and pv.find("ZZ9LK-1") < pv.find("ZZ9LK-2") < pv.find("ZZ9LK-3") and "SP-ONE" in pv and pv.count("No ID yet") == 2, pv[:0])
    s.check("no name appears in it or anywhere on the panel", "ZZ LK" not in pg, [m for m in re.findall(r"ZZ LK [A-Za-z0-9 ]+", pg)][:3])
    s.check("it says it only reads", "A test only reads. Nothing is saved to any line." in pg)
    dbx("DELETE FROM kpi_chart_links WHERE node_id=?", K_SV)
    post(SUP, link_form(K_SV, whose="unit", matched_on="unit_code"))
    r = post(SUP, {"action": "unitcode_remove", "code_id": q1("SELECT id FROM org_ext_ids WHERE system_id=? AND company='ZZLK U2'", (SID1,))[0]}, SYSURL)
    pg = kpi_page()
    j = pg.find('aria-label="What a pull would fill"')
    pv = pg[j: pg.find("A test only reads", j)]
    s.check("a unit's figure shows each holder's unit and its code there, or 'No code yet'",
            re.search(r"ZZLK U1 (&middot;|·) CC-1", pv, re.I) is not None, pv[-400:])
    s.check("   ...the unit with no code in this system says so", "No code yet" in pv)
    # a cap of 5
    for n_ in range(5, 9):
        with a.app.app_context():
            dd = a.get_db()
            uid_ = dd.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
                              "job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,'ZZLK U1','ZZLK Dept','14','2020-01-01')",
                              ("zzlk-x%d" % n_, "ZZ LK Extra %d" % n_, PREFIX + "X%d" % n_, A)).lastrowid
            dd.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, rate5, "
                       "business_group, company, description) SELECT ?, id, 'ZZLK Sales value', 10, 'more', 1,2,3,4,5, business_group, company, "
                       "'own words' FROM users WHERE id=?", (CID, uid_))
            dd.commit()
    pg = kpi_page()
    j = pg.find('aria-label="What a pull would fill"')
    pv = pg[j: pg.find("A test only reads", j)]
    s.check("at most 5 holders are shown, with the total", len(re.findall(r'<div class="coa-tr"><span>ZZ9LK-', pv)) == 5 and "5 of 7 people who hold it" in pv, pv[-200:])

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the Systems page counts")
    post(SUP, link_form(V_SV, matched_on="employee_id"))
    with a.app.app_context():
        dd = a.get_db()
        sysr = {x["name"]: x for x in a._coa_systems(dd)}
    want_k = {nm: q1("SELECT COUNT(*) FROM kpi_chart_links WHERE system_id=?", (sys_id(nm),))[0] for nm in ("ZZLK Alpha", "ZZLK Beta", "ZZLK Gamma")}
    want_p = {nm: q1("SELECT COUNT(*) FROM user_ext_ids WHERE removed_at IS NULL AND system_id=?", (sys_id(nm),))[0] for nm in want_k}
    want_u = {nm: q1("SELECT COUNT(*) FROM org_ext_ids WHERE system_id=?", (sys_id(nm),))[0] for nm in want_k}
    s.check("each system's KPIs, people and units match a direct count",
            all((sysr[n_]["n_kpis"], sysr[n_]["n_people"], sysr[n_]["n_units"]) == (want_k[n_], want_p[n_], want_u[n_]) for n_ in want_k)
            and sysr["ZZLK Alpha"]["n_kpis"] == 2 and sysr["ZZLK Alpha"]["n_people"] >= 1 and sysr["ZZLK Alpha"]["n_units"] >= 1, sysr["ZZLK Alpha"])
    seen = {"n": 0}
    with a.app.app_context():
        dd = a.get_db()
        orig = dd.execute

        class Tap:
            def __init__(self, c):
                self._c = c

            def execute(self, sql, *args):
                if "FROM kpi_ext_systems s" in sql:
                    seen["n"] += 1
                return self._c.execute(sql, *args)
        a._coa_systems(Tap(dd))
    s.check("the counts come from ONE read, however many systems", seen["n"] == 1)
    pg = txt(SUP.get(SYSURL))
    s.check("the page shows the counts and the system names on one line each, retired ones marked",
            re.search(r"<b title=\"ZZLK Alpha\">ZZLK Alpha</b>\s*<span>2</span>", pg) is not None)
    post(SUP, {"action": "system_retire", "system_id": SID3}, SYSURL)
    pg = txt(SUP.get(SYSURL))
    s.check("a retired system is marked Retired, last, with Bring back", re.search(r"ZZLK Gamma <span class=\"pp-chip\">Retired</span>", pg) and "Bring back" in pg)
    post(SUP, {"action": "system_restore", "system_id": SID3}, SYSURL)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("piece A2's Early Year door honours named people")
    EY_BG = "ZZLK Door"
    with a.app.app_context():
        dd = a.get_db()
        dd.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZLK D1')", (EY_BG,))
        dd.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (EY_BG,))
        mk = lambda n_, nm: dd.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
                                       "job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?, 'ZZLK D1', 'ZZLK Dept', '14', '2020-01-01')",
                                       ("zzlk-door%d" % n_, nm, PREFIX + "DR%d" % n_, EY_BG)).lastrowid
        DL, DU = mk(1, "ZZ LK Door listed"), mk(2, "ZZ LK Door unlisted")
        LIBD = dd.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, description, unit, method, "
                          "bu_level, active) VALUES (?, '*', '*', 0, '*', 'ZZLK Door KPI', 'd', 'RM', 'more', 0, 1)", (EY_BG,)).lastrowid
        dd.execute("UPDATE cycles SET half=0, kind='early_year' WHERE id=?", (CID,))   # KPI setting runs in an Early Year only
        dd.commit()
        flags = lambda uid_: a._pm_entry_flags(dd, dd.execute("SELECT * FROM users WHERE id=?", (uid_,)).fetchone(), CID)["setting"]
        s.check("with no people on the row the door is offered to everyone in scope, exactly as before", flags(DL) is True and flags(DU) is True)
        dd.execute("INSERT INTO pm_kpi_library_people(library_id, user_id, added_by) VALUES (?,?,?)", (LIBD, DL, SU["id"]))
        dd.commit()
        s.check("with a person named, the listed person has the door", flags(DL) is True)
        s.check("...and an unlisted person in the same scope does not", flags(DU) is False)
        dd.execute("DELETE FROM pm_kpi_library_people WHERE library_id=?", (LIBD,))
        dd.commit()
        s.check("   FALSIFY: take the people off and the unlisted person has the door again", flags(DU) is True)
        dd.execute("UPDATE cycles SET half=2, kind='year_end' WHERE id=?", (CID,))
        dd.commit()
        s.check("outside an Early Year no one has the door, listed or not", flags(DL) is False and flags(DU) is False)
        k = KEEP["cycle"]
        dd.execute("UPDATE cycles SET kind=?, half=? WHERE id=?", (k["kind"], k["half"], CID))
        dd.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (EY_BG,))
        dd.execute("DELETE FROM users WHERE business_group=?", (EY_BG,))
        dd.execute("DELETE FROM pm_bg_config WHERE business_group=?", (EY_BG,))
        dd.execute("DELETE FROM org_units WHERE business_group=?", (EY_BG,))
        dd.commit()

    # ---------------------------------------------------------------------------------------------------------------
    s.section("no credential, no address, no network anywhere in the new code")
    src = H.source(a)
    blk = src[src.find("# ---- the Chart of KPI, piece C"): src.find("# ---- proposals to the KPI library")]
    code = H.code_without_docstrings(blk) if hasattr(H, "code_without_docstrings") else blk
    s.check("the new block imports no network client and opens no connection", not re.search(r"\b(urlopen|requests\.|http\.client|socket\.|smtplib|urllib\.request)\b", code))
    s.check("no password, secret or token column in the new tables", not re.search(r"(password|secret|token|api_key|credential)",
            " ".join(t_sql[t] for t in ("kpi_ext_systems", "kpi_chart_links", "user_ext_ids", "org_ext_ids")), re.I))
finally:
    if FLAG0 is None:
        os.environ.pop("ONEHR_COA", None)
    else:
        os.environ["ONEHR_COA"] = FLAG0

sys.exit(s.done())
