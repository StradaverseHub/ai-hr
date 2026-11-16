"""What each admin role may do, set by the super admin (Roles & access, Chris 2026-10-20: "one RBAC based on the role
assigned ... Once set the bgadmin should apply to all the BG bgadmin"; "role only, no exception"; "the main difference
between BU and BG admin would be the business units they can access to"; custom roles "yes"; canvas
[design canvas link removed]). Replaces the per-admin ticks of 2026-10-19.

What this suite holds:
  * every admin write route names its item(s) in ADMIN_ACCESS_MAP ("super" / "always" / "lms" otherwise), per form
    action where one route does several; every item is in the registry; every module has its pages item
  * the built-in roles exist and every admin account has a role; a new account reads as its scope's built-in role
  * the super admin creates a role (View only to start), gives it to an admin with its scope, ticks it on the matrix
    (only the roles shown change), presets, renames and retires it -- all super only, all in the audit log
  * the gate follows the role: per item, per form action; confirming someone stays the super admin's; "super" routes
    refuse a role with everything
  * an unticked module hides its pages (by endpoint, key, path, person tab), the menu drops it
  * no note about their access on the page; admin.js gets their role's items and every write route's rule
  * the Admins page shows each admin's role, and changes it in their panel; no per-admin grid
  * a whole-company role acts everywhere and is never the super admin
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("What each admin role may do, set by the super admin")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG = "ZZAC Group"
ROLE_PREFIX = "ZZAC "


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9AC-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM admin_access WHERE admin_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    rids = [r[0] for r in db.execute("SELECT id FROM admin_roles WHERE name LIKE ?", (ROLE_PREFIX + "%",))]
    if rids:
        ph = ",".join("?" * len(rids))
        db.execute("DELETE FROM admin_role_access WHERE role_id IN (%s)" % ph, rids)
        db.execute("DELETE FROM admin_roles WHERE id IN (%s)" % ph, rids)
    db.execute("DELETE FROM activity_log WHERE action LIKE 'admin_role%' AND detail LIKE ?", (ROLE_PREFIX + "%",))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZAC U1')", (BG,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZAC U2')", (BG,))
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                     "VALUES ('zz9ac-bga', 'ZZ AC Groupadmin', 'x', 'admin', 'ZZ9AC-BGA', ?, ?)", (BG, BG)).lastrowid
    UNA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                     "VALUES ('zz9ac-una', 'ZZ AC Unitadmin', 'x', 'admin', 'ZZ9AC-UNA', ?, ?)", (BG, BG)).lastrowid
    db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?, 'ZZAC U1')", (UNA,))
    P = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                   "job_grade) VALUES ('zz9ac-p', 'ZZ AC Person', 'x', 'user', 'ZZ9AC-P', ?, 'ZZAC U1', '14')",
                   (BG,)).lastrowid
    BUILTIN = {r["builtin"]: r["id"] for r in db.execute("SELECT id, builtin FROM admin_roles WHERE builtin IS NOT NULL")}
    db.commit()
SUP, BAC, UAC = H.client_as(a, SU["id"]), H.client_as(a, BGA), H.client_as(a, UNA)
MODS = set(a.ACCESS_MODULE_KEYS)
ITEMS = set(a.ADMIN_ITEM_KEYS)


def row(uid):
    with a.app.app_context():
        return a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


def items_of(uid):
    with a.app.test_request_context("/"):
        return set(a.admin_items(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


def role_items(rid):
    with a.app.app_context():
        return a.admin_role_items(a.get_db(), rid)


def refused(uid, path, form):
    """The gate's verdict on a POST to `path` with this form, for this admin (the route itself never runs)."""
    with a.app.test_request_context(path, method="POST", data=form):
        u = a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return a.admin_access_refused(u)


def post_roles(form, c=None):
    return (c or SUP).post("/admin/roles?tab=admin", data=dict(form, csrf_token="tok"))


def give_role(uid, rid, bg=BG, companies=(), c=None):
    data = {"csrf_token": "tok", "role_id": str(rid), "business_group": bg}
    if companies:
        data["companies"] = list(companies)
    return (c or SUP).post("/admin/admins/%d/role" % uid, data=data)


def role_id(name):
    with a.app.app_context():
        r = a.get_db().execute("SELECT id FROM admin_roles WHERE name=?", (name,)).fetchone()
        return r[0] if r else None


def last_log(action):
    with a.app.app_context():
        r = a.get_db().execute("SELECT detail FROM activity_log WHERE action=? ORDER BY id DESC LIMIT 1",
                               (action,)).fetchone()
        return r[0] if r else ""


def specs(spec):
    return list(spec["map"].values()) + [spec["default"]] if isinstance(spec, dict) else [spec]


try:
    s.section("every admin write route names its item")
    rules = [r for r in a.app.url_map.iter_rules() if r.rule.startswith("/admin") and "POST" in r.methods
             and not any(r.rule.startswith(p_) for p_ in a.ARCHIVED_ROUTE_PREFIXES)]
    s.check("there are admin write routes (%d)" % len(rules), len(rules) >= 40, len(rules))
    unmapped = sorted({r.endpoint for r in rules if r.endpoint not in a.ADMIN_ACCESS_MAP})
    s.check("each names its rule in ADMIN_ACCESS_MAP (a new one fails here until it does)", not unmapped, unmapped)
    stale = sorted(set(a.ADMIN_ACCESS_MAP) - set(a.app.view_functions))
    s.check("...and the map names no route that doesn't exist", not stale, stale)
    bad = []
    for ep, spec in a.ADMIN_ACCESS_MAP.items():
        for sp in specs(spec):
            if sp in ("always", "super", "lms"):
                continue
            if not (isinstance(sp, tuple) and sp[0] == "items" and sp[1] and all(k in ITEMS for k in sp[1])):
                bad.append((ep, sp))
    s.check("every item a route needs is in the registry (a role can be given it)", not bad, bad[:5])
    s.check("no write route asks for a module's pages item (a change, never a read)",
            not [ep for ep, spec in a.ADMIN_ACCESS_MAP.items() for sp in specs(spec)
                 if isinstance(sp, tuple) and any(a.ADMIN_ITEM_BY_KEY[k][2] == "read" for k in sp[1])])
    _role_mods = MODS - {"audit"}   # Audit and usage has no item: the super admin's alone (2026-10-21)
    s.check("every module but Audit and usage has its pages item, first in its rows",
            all(next(i for i in a.ADMIN_ITEMS if i[0] == m)[2] == "read" for m in _role_mods)
            and set(a.ADMIN_READ_ITEM) == _role_mods and {i[0] for i in a.ADMIN_ITEMS} == _role_mods)
    n_split = sum(1 for v in a.ADMIN_ACCESS_MAP.values() if isinstance(v, dict))
    s.check("routes doing several things are split by their form action (%d)" % n_split, n_split >= 10, n_split)
    s.check("the old per-admin ticks route is gone", "admin_admin_access" not in a.app.view_functions
            and SUP.post("/admin/admins/%d/access" % UNA, data={"csrf_token": "tok"}).status_code in (404, 405))

    s.section("the built-in roles, and every admin holds one")
    s.check("BG admin, BU admin and L&D admin are built in", set(BUILTIN) >= {"bg", "bu", "lnd"}, BUILTIN)
    with a.app.app_context():
        no_role = a.get_db().execute("SELECT COUNT(*) FROM users WHERE role='admin' AND COALESCE(admin_bg,'')!='' "
                                     "AND admin_role_id IS NULL AND employee_id NOT LIKE 'ZZ9AC-%'").fetchone()[0]
        n_super = a.get_db().execute("SELECT COUNT(*) FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' "
                                     "AND admin_role_id IS NOT NULL").fetchone()[0]
    s.check("every admin account from before has its role (the boot gave it)", no_role == 0, no_role)
    s.check("...and the super admin has none", n_super == 0, n_super)
    with a.app.test_request_context("/"):
        _db = a.get_db()
        s.check("an account with no role yet reads as its scope's: a whole-group admin the BG admin role, a unit admin "
                "the BU admin role", a.admin_role_of(row(BGA), _db)["builtin"] == "bg"
                and a.admin_role_of(row(UNA), _db)["builtin"] == "bu")
        s.check("the seeded BG admin role is today's View only (production: every BG admin was)",
                a.admin_role_items(_db, BUILTIN["bg"]) >= a.role_preset_items("view"))
        sup_u = _db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        s.check("the super admin holds every item, never view only",
                set(a.admin_items(sup_u)) == ITEMS and not a.admin_viewonly(sup_u) and a.admin_role_of(sup_u) is None)

    s.section("the super admin creates a role")
    NAME = ROLE_PREFIX + "HRBP"
    s.check("a BG admin can't open Roles & access, nor post to it (403)",
            BAC.get("/admin/roles").status_code == 403 and post_roles({"action": "add_role", "name": NAME,
                                                                         "scope_kind": "group"}, BAC).status_code == 403)
    r = post_roles({"action": "add_role", "name": NAME, "scope_kind": "group"})
    RID = role_id(NAME)
    s.check("the super admin adds one: it shows straight away on the matrix", r.status_code == 302 and RID
            and ("show=" in r.headers.get("Location", "")) and str(RID) in r.headers.get("Location", ""),
            r.headers.get("Location"))
    s.check("...starting View only", role_items(RID) == a.role_preset_items("view"), role_items(RID))
    s.check("...in the audit log", NAME in last_log("admin_role_add") and "View only" in last_log("admin_role_add"))
    s.check("a second role with the same name (any case) is refused", "already" in post_roles(
        {"action": "add_role", "name": NAME.lower(), "scope_kind": "units"}).headers.get("Location", "") or
        "already" in SUP.get(post_roles({"action": "add_role", "name": NAME.lower(), "scope_kind": "units"}
                                        ).headers.get("Location", "/admin/roles")).get_data(as_text=True))
    s.check("...and so is a scope that isn't one of the three", role_id(ROLE_PREFIX + "Bad") is None and post_roles(
        {"action": "add_role", "name": ROLE_PREFIX + "Bad", "scope_kind": "learning"}).status_code == 302
        and role_id(ROLE_PREFIX + "Bad") is None)
    UNAME = ROLE_PREFIX + "Unit desk"
    post_roles({"action": "add_role", "name": UNAME, "scope_kind": "units"})
    URID = role_id(UNAME)

    s.section("the super admin gives an admin the role, with where they act")
    s.check("a BG admin can't (403)", give_role(UNA, RID, c=BAC).status_code == 403)
    r = give_role(BGA, RID)
    s.check("the group role: their role and their group set", r.status_code == 302
            and row(BGA)["admin_role_id"] == RID and row(BGA)["admin_bg"] == BG, (r.status_code, dict(row(BGA))))
    s.check("...in the audit log, with what it was", "HRBP" in last_log("admin_role_set")
            and "was BG admin" in last_log("admin_role_set"), last_log("admin_role_set"))
    s.check("a units role needs at least one unit", give_role(UNA, URID).status_code == 302
            and row(UNA)["admin_role_id"] != URID)
    give_role(UNA, URID, companies=["ZZAC U1", "ZZAC U2"])
    with a.app.app_context():
        comps = {r_[0] for r_ in a.get_db().execute("SELECT company FROM admin_companies WHERE admin_id=?", (UNA,))}
    s.check("...with them: the role and both units", row(UNA)["admin_role_id"] == URID and comps == {"ZZAC U1", "ZZAC U2"},
            comps)
    give_role(UNA, URID, companies=["ZZAC U1"])
    s.check("the super admin can't be given a role", "always have everything" in SUP.post(
        "/admin/admins/%d/role" % SU["id"], data={"csrf_token": "tok", "role_id": str(RID)},
        follow_redirects=True).get_data(as_text=True))

    s.section("the matrix: only the roles shown change")
    before_u = role_items(URID)
    form = {"action": "save", "roles_shown": str(RID),
            "t_%d" % RID: ["people.read", "people.details", "people.email", "pm.kpi_edit", "pm.reopen", "audit.read",
                           "cycle.read", "org.read", "reports.read", "leaders.read", "competency.read", "idp.read",
                           "calibration.read"]}
    r = post_roles(form)
    got = role_items(RID)
    s.check("its ticks are stored", {"people.details", "people.email", "pm.kpi_edit", "pm.reopen"} <= got, got)
    s.check("...a change brings its module's pages with it (pm.read came with Edit a KPI line)", "pm.read" in got)
    s.check("...an unticked module is gone (360 Feedback)", "f360.read" not in got)
    s.check("...a role not shown keeps its ticks (a partial post never clears it)", role_items(URID) == before_u)
    log = last_log("admin_role_access")
    s.check("...in the audit log: + what it gained, − what it lost, and its admins", "+ Edit a KPI line" in log
            and "− See 360 Feedback" in log and "(1 admin)" in log, log)
    s.check("the same save again says nothing changed", "Nothing changed" in SUP.get(
        post_roles(form).headers.get("Location"), follow_redirects=True).get_data(as_text=True))
    s.check("a BG admin's save is refused (403)", post_roles(form, BAC).status_code == 403)

    s.section("the gate follows the role")
    s.check("Change a work email passes", not refused(BGA, "/admin/users", {"action": "set_email"}))
    s.check("Add a person is refused (not given)", refused(BGA, "/admin/users", {"action": "add_user"}))
    s.check("closing an account is refused", refused(BGA, "/admin/users", {"action": "mark_left"}))
    s.check("an action nobody classified on a split route is the super admin's",
            refused(BGA, "/admin/users", {"action": "remove_user"}))
    s.check("confirming someone is the super admin's now, even for a role with People details",
            refused(BGA, "/admin/users", {"action": "set_confirmed"}))
    s.check("a KPI line's edit passes, its delete doesn't", not refused(BGA, "/admin/users/%d/kpi" % P, {"action": "edit"})
            and refused(BGA, "/admin/users/%d/kpi" % P, {"action": "delete"}))
    s.check("a reopen follows what it reopens: the KPI check-in passes, a Career Plan doesn't",
            not refused(BGA, "/admin/users/%d/reopen" % P, {"part": "pm_self"})
            and refused(BGA, "/admin/users/%d/reopen" % P, {"part": "idp_self"}))
    s.check("every reopen path needs its module's reopen item",
            all(v[1][0].endswith(".reopen") for v in a.ADMIN_ACCESS_MAP["admin_person_reopen"]["map"].values())
            and a.ADMIN_ACCESS_MAP["admin_panel"]["map"]["reset_submission"] == ("items", ("f360.reopen",)))
    s.check("a 403 really comes back over HTTP for a refused write", BAC.post("/admin/users", data={
        "csrf_token": "tok", "action": "mark_left", "user_id": str(P)}).status_code == 403)

    post_roles({"action": "preset", "role_id": str(RID), "preset": "full"})
    s.check("'Everything' gives every item but those ticked only by name (Ticketing), and Grade H's read item while Grade H is dark",
            role_items(RID) == ITEMS - set(a.ADMIN_ITEMS_EXPLICIT) - set(a._admin_items_hidden()) and {"ticketing.read", "ticketing.act"}
            <= set(a.ADMIN_ITEMS_EXPLICIT) and set(a._admin_items_hidden()) == {"gradeh.read"}, ITEMS - role_items(RID))
    supers = sorted({ep for ep, sp in a.ADMIN_ACCESS_MAP.items() if sp == "super"})
    leaks = []
    for r_ in rules:
        if r_.endpoint not in supers:
            continue
        url = re.sub(r"<(?:[a-z]+:)?([a-z_]+)>", lambda m: "1" if m.group(1) not in ("key", "token", "path", "bg")
                     else "x", r_.rule)
        if not refused(BGA, url, {"action": "add"}):
            leaks.append(r_.rule)
    s.check("even with everything, each of the %d super admin's routes refuses them" % len(supers),
            supers and not leaks, leaks[:5])
    s.check("...releasing results and Roles & access among them", {"admin_talent_release", "admin_release",
                                                                  "admin_roles", "admin_admin_role"} <= set(supers))
    s.check("...and setting a Group Chief (a split action)", refused(BGA, "/admin/users/%d/lines" % P, {"action": "set_gc"}))
    s.check("...and confirming someone", refused(BGA, "/admin/users", {"action": "set_confirmed"}))
    imports = {"admin_import_roster": "/admin/import/roster", "admin_import": "/admin/import",
               "admin_import_kpi_targets": "/admin/performance/import",
               "admin_import_jobs": "/admin/competency/import-jobs"}
    s.check("every import is the super admin's, whatever the role (Chris, 2026-10-31, 1a-04): mapped \"super\", and "
            "a role with every item is refused each of them, a staged file too",
            set(imports) <= set(supers) and all(refused(BGA, u_, {"preview": "1"}) for u_ in imports.values()),
            [e for e in imports if e not in supers])
    s.check("...the ticks that only guarded an import are gone, the ones that guard more stay (360 add raters and build "
            "panels, Competency match / place a job)",
            "people.roster" not in a.ADMIN_ITEM_BY_KEY and "pm.import" not in a.ADMIN_ITEM_BY_KEY
            and a.ADMIN_ACCESS_MAP["admin_panel_build"] == ("items", ("f360.add",))
            and a.ADMIN_ACCESS_MAP["admin_panel"]["map"]["add"] == ("items", ("f360.add",))
            and a.ADMIN_ACCESS_MAP["admin_person_competency"]["map"]["place_job"] == ("items", ("competency.job",))
            and "f360.add" in ITEMS and "competency.job" in ITEMS)
    with a.app.app_context():   # a role saved before the change still holds the gone tick: ignored, never an error
        _d = a.get_db()
        _d.execute("INSERT OR IGNORE INTO admin_role_access(role_id, item) VALUES (?, 'people.roster')", (RID,))
        _d.commit()
        stale = "people.roster" in a.admin_role_items(_d, RID) or "people.roster" in role_items(RID)
        _d.execute("DELETE FROM admin_role_access WHERE role_id=? AND item='people.roster'", (RID,))
        _d.commit()
    s.check("...and a role row still holding a gone tick is ignored, not an error", not stale)
    post_roles({"action": "preset", "role_id": str(RID), "preset": "cycle"})
    pc = role_items(RID)
    s.check("'Run the cycle' edits and adds where it can: no delete, no seat",
            pc == a.role_preset_items("cycle") and not [k for k in pc if a.ADMIN_ITEM_BY_KEY[k][2] == "delete"]
            and "leaders.seat" not in pc and "people.lm" in pc, sorted(pc))
    post_roles({"action": "preset", "role_id": str(RID), "preset": "view"})
    s.check("'View only' reads every module and changes nothing", role_items(RID) == a.role_preset_items("view"))
    with a.app.test_request_context("/"):
        s.check("...so its admin is view only", a.admin_viewonly(a.get_db().execute(
            "SELECT * FROM users WHERE id=?", (BGA,)).fetchone()))

    s.section("an unticked module hides its pages")
    post_roles({"action": "save", "roles_shown": str(URID),
                "t_%d" % URID: ["people.read", "people.email", "people.add", "pm.read", "pm.kpi_edit", "cycle.read",
                                "org.read", "reports.read", "leaders.read", "competency.read", "idp.read",
                                "calibration.read", "audit.read"]})
    r = UAC.get("/admin/360")
    s.check("a 360 page goes to Home", r.status_code == 302 and r.headers.get("Location", "").rstrip("/").endswith(
        "/admin"), (r.status_code, r.headers.get("Location")))
    s.check("...saying why", "role doesn&#39;t include 360 Feedback" in UAC.get("/admin/360", follow_redirects=True)
            .get_data(as_text=True))
    s.check("a module page by its key (360 Settings)", UAC.get("/admin/m/f360/settings").status_code == 302)
    s.check("a page found by the menu page owning its path (a person's 360, under /admin/subjects)",
            UAC.get("/admin/subjects/%d" % P).status_code == 302)
    s.check("a download no menu page owns, by the data it carries (the 360 results CSV)",
            UAC.get("/admin/export/results.csv").status_code == 302)
    s.check("the cycle switcher and the search stay open to every admin",
            UAC.get("/admin/search.json").status_code == 200 and a._ACCESS_PAGE_MODULE.get("admin_cycle_select", 1)
            is None)
    unowned = []
    with a.app.test_request_context("/"):
        for r_ in a.app.url_map.iter_rules():
            if (not r_.rule.startswith("/admin") or "GET" not in r_.methods or r_.endpoint in a._ACCESS_PAGE_MODULE
                    or r_.endpoint.startswith("admin_module_") or r_.endpoint == "admin_person"
                    or r_.endpoint == "admin_report_view" or r_.endpoint == "admin_list_view"
                    or getattr(a.app.view_functions.get(r_.endpoint), "_nav_gate", None) in ("super", "system")
                    or r_.endpoint in ("admin_overview", "admin_all_settings")):
                continue
            if any(r_.rule.startswith(p_) for p_ in a.ARCHIVED_ROUTE_PREFIXES):
                continue
            if a._access_page_module(r_.endpoint, {}, re.sub(r"<[^>]+>", "7", r_.rule)) is None:
                unowned.append(r_.rule)
    s.check("every other admin page belongs to a module (by its menu entry, its path, or by name)", not unowned,
            unowned[:8])
    s.check("a person's module tab follows the module (360 tab refused, Performance tab open)",
            UAC.get("/admin/users/%d?tab=f360" % P).status_code == 302
            and UAC.get("/admin/users/%d?tab=performance" % P).status_code == 200)
    s.check("Home is always open", UAC.get("/admin").status_code == 200)
    pg = UAC.get("/admin").get_data(as_text=True)
    side = re.search(r'<nav class="adm-side".*?</nav>', pg, re.S)
    side = side.group(0) if side else ""
    s.check("the menu drops 360 Feedback and keeps People", side and 'adm-side-lbl">360 Feedback<' not in side
            and ('adm-side-lbl">People<' in side or 'adm-fly-lbl">People<' in side))
    s.check("...and offers no Roles & access to a BU admin", "/admin/roles" not in side)

    s.section("the portal: no note, and the script gets the role's items")
    s.check("no note about their access on the page (Chris: \"don't need this note\")",
            "Your access." not in pg and "View only." not in pg and "the super admin sets this" not in pg)
    s.check("the page is marked for the script (data-adm-access), not view only",
            "data-adm-access" in pg and "data-adm-viewonly" not in pg)
    m = re.search(r"window\.ADM_ACCESS = (\{.*?\});</script>", pg, re.S)
    data = json.loads(m.group(1)) if m else {}
    s.check("the script gets their role's items", "people.email" in data.get("items", [])
            and "people.close" not in data.get("items", []), data.get("items"))
    bad_rx = []
    all_posts = [r_ for r_ in a.app.url_map.iter_rules() if r_.rule.startswith("/admin") and "POST" in r_.methods]
    for rx, spec in data.get("routes", []):
        if not [r_ for r_ in all_posts if re.match(rx, re.sub(r"<(?:[a-z]+:)?([a-z_]+)>", "7", r_.rule))]:
            bad_rx.append(rx)
    s.check("...and every admin write route's rule, each pattern matching its own route (%d)" % len(data.get(
        "routes", [])), len(data.get("routes", [])) >= len(rules) and not bad_rx, bad_rx[:3])
    js = open(os.path.join(H.REPO, "static", "admin.js"), encoding="utf-8").read()
    s.check("static/admin.js reads items and keeps only the forms, buttons and choices they may use",
            "spec[0] === 'items'" in js and "ADM_ACCESS" in js and "spec.m" in js and "is-viewonly-btn" in js)
    pv = BAC.get("/admin").get_data(as_text=True)
    s.check("a View only role's page is marked view only for the script, with no note either",
            "data-adm-viewonly" in pv and "View only." not in pv)

    s.section("the Admins page: each admin's role")
    pga = SUP.get("/admin/admins").get_data(as_text=True)
    s.check("a Role column, each role a link to its matrix", ">Role</th>" in pga
            and 'href="/admin/roles?show=%d"' % RID in pga and NAME in pga)
    s.check("the panel changes their role, with no per-admin grid", "admin/admins/%d/role" % BGA in pga
            and 'name="acc_people_delete"' not in pga and "Save access" not in pga and "Save role" in pga)
    s.check("Add an admin asks their role, and offers the roles you created", 'name="role_id"' in pga
            and "data-role-pick" in pga and UNAME in pga)
    r = SUP.post("/admin/admins", data={"csrf_token": "tok", "username": "zz9ac-new", "password": "silver anchor 47",
                                        "role_id": str(URID), "business_group": BG, "companies": ["ZZAC U2"]})
    with a.app.app_context():
        nu = a.get_db().execute("SELECT * FROM users WHERE username='zz9ac-new'").fetchone()
        if nu:
            a.get_db().execute("UPDATE users SET employee_id='ZZ9AC-NEW' WHERE id=?", (nu["id"],))
            a.get_db().commit()
            ncomps = {r_[0] for r_ in a.get_db().execute("SELECT company FROM admin_companies WHERE admin_id=?",
                                                           (nu["id"],))}
    s.check("adding one with a units role: the role and the unit", nu is not None and nu["admin_role_id"] == URID
            and ncomps == {"ZZAC U2"}, dict(nu) if nu else None)
    s.check("...in the audit log, with the role", UNAME in last_log("admin_create"), last_log("admin_create"))

    s.section("Roles & access: up to 4 side by side, rename, retire")
    extra = []
    for i in range(4):
        post_roles({"action": "add_role", "name": ROLE_PREFIX + "Extra %d" % i, "scope_kind": "group"})
        extra.append(role_id(ROLE_PREFIX + "Extra %d" % i))
    pr = SUP.get("/admin/roles").get_data(as_text=True)
    heads = re.findall(r'data-role-head="(\d+)"', pr)
    s.check("the matrix shows at most 4 roles side by side", 0 < len(heads) <= 4, heads)
    s.check("...every role a chip, the hidden ones said to keep their ticks", pr.count('class="rl-chip') >= 6
            and "Roles not shown keep their ticks" in pr)
    pr2 = SUP.get("/admin/roles?show=%d,%d" % (RID, extra[3])).get_data(as_text=True)
    s.check("a chip shows the role you pick", set(re.findall(r'data-role-head="(\d+)"', pr2)) == {str(RID), str(extra[3])})
    post_roles({"action": "rename", "role_id": str(extra[0]), "name": ROLE_PREFIX + "Renamed"})
    s.check("a created role can be renamed", role_id(ROLE_PREFIX + "Renamed") == extra[0])
    post_roles({"action": "rename", "role_id": str(BUILTIN["bg"]), "name": ROLE_PREFIX + "Nope"})
    s.check("...a built-in one can't", role_id(ROLE_PREFIX + "Nope") is None)
    post_roles({"action": "retire", "role_id": str(RID)})
    with a.app.app_context():
        held = a.get_db().execute("SELECT retired_at FROM admin_roles WHERE id=?", (RID,)).fetchone()[0]
    s.check("a role an admin still holds can't be retired", held is None)
    post_roles({"action": "retire", "role_id": str(extra[1])})
    with a.app.app_context():
        gone = a.get_db().execute("SELECT retired_at FROM admin_roles WHERE id=?", (extra[1],)).fetchone()[0]
    s.check("...one nobody holds can, and it leaves the matrix", gone is not None
            and 'data-role-head="%d"' % extra[1] not in SUP.get("/admin/roles?show=%d" % extra[1]).get_data(as_text=True))

    s.section("a whole-company role")
    CNAME = ROLE_PREFIX + "Group reader"
    post_roles({"action": "add_role", "name": CNAME, "scope_kind": "company"})
    CRID = role_id(CNAME)
    give_role(BGA, CRID)
    with a.app.test_request_context("/"):
        u = a.get_db().execute("SELECT * FROM users WHERE id=?", (BGA,)).fetchone()
        s.check("its admin acts on the whole company: no group, any unit", u["admin_bg"] == a.ADMIN_COMPANY_SCOPE
                and a.admin_bg_of(u) is None and a.can_access(u, "ANY OTHER GROUP", "ANY UNIT")
                and a.bg_scope(u) == ("", []))
        s.check("...and is never the super admin", not a.is_super(u) and a.admin_role_of(u)["id"] == CRID)
    s.check("...so a super admin's route still refuses them", refused(BGA, "/admin/release", {"action": "add"}))
    s.check("...and its admins' role is View only to start", items_of(BGA) == a.role_preset_items("view"))

    s.section("Audit and usage is the super admin's alone (Chris, 2026-10-21: \"It shouldn't be\" open to BG / BU admins)")
    s.check("no item opens it, so no role can", not any(i[0] == "audit" for i in a.ADMIN_ITEMS)
            and "audit" in a.ADMIN_SUPER_ROWS)
    gone = {}
    for path in ("/admin/audit-log", "/admin/activity", "/admin/data-integrity", "/admin/ask-log",
                 "/admin/export/audit-log.xlsx", "/admin/ask-log.xlsx"):
        r_ = BAC.get(path)
        gone[path] = (r_.status_code, r_.headers.get("Location", "").rstrip("/").endswith("/admin"))
    s.check("a View only admin (every module's pages) is refused all four tabs and both downloads (sent Home, or 403 "
            "where the route was already the super admin's: the audit log)",
            all(v == (302, True) or v[0] == 403 for v in gone.values())
            and gone["/admin/activity"] == gone["/admin/data-integrity"] == gone["/admin/ask-log"] == (302, True), gone)
    s.check("...Home doesn't link them into Data integrity, and Reports doesn't list the Audit log",
            "/admin/data-integrity" not in BAC.get("/admin").get_data(as_text=True)
            and "/admin/export/audit-log" not in BAC.get("/admin/reports/all?kind=data").get_data(as_text=True))
    s.check("...a Data integrity fix is the super admin's", a.admin_access_need("admin_data_integrity_fix", {}) == "super")
    s.check("the super admin still opens them", all(SUP.get(p_).status_code == 200 for p_ in (
        "/admin/audit-log", "/admin/activity", "/admin/data-integrity", "/admin/ask-log")))

    s.section("All settings is the super admin's alone (Chris, 2026-10-21: \"hide the All settings from bg and bu admin\")")
    r_all, r_pf = BAC.get("/admin/all-settings"), BAC.get("/admin/m/org/settings")
    s.check("a View only admin can't open the sheet (403) or its Platform tab (sent Home)", r_all.status_code == 403
            and r_pf.status_code == 302 and r_pf.headers.get("Location", "").rstrip("/").endswith("/admin"),
            (r_all.status_code, r_pf.status_code))
    home = BAC.get("/admin").get_data(as_text=True)
    perf = BAC.get("/admin/m/pm/settings").get_data(as_text=True)
    s.check("...the menu doesn't offer it, nor a module's Settings page link to it", "/admin/all-settings" not in home
            and "/admin/m/org/settings" not in home and "/admin/all-settings" not in perf, BAC.get(
                "/admin/m/pm/settings").status_code)
    with a.app.test_request_context("/"):
        bga_ = a.get_db().execute("SELECT * FROM users WHERE id=?", (BGA,)).fetchone()
        su_ = a.get_db().execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        hrefs = [i["href"] for i in a._admin_index(a.get_db(), bga_)]
        s_hrefs = [i["href"] for i in a._admin_index(a.get_db(), su_)]
    s.check("...and the search finds neither the sheet nor a Platform setting for them",
            not any(h.startswith("/admin/all-settings") or h.startswith("/admin/m/org/settings") for h in hrefs)
            and any(h.startswith("/admin/all-settings") for h in s_hrefs))
    s.check("the super admin still opens both", SUP.get("/admin/all-settings").status_code == 200
            and SUP.get("/admin/m/org/settings").status_code == 200)
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
