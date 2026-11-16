"""BG and unit admins read the admin portal; only the super admin changes it (Chris, 2026-10-19: "remove all edit and add
and delete function for BG and BU admins, only super admin can have the full access, BG and BU admins will only have view
access to the admin portal"; "bg and bu admins can view and download the reports"; proposals kept; their notification
addresses set by the super admin).

What this suite holds:
  * every admin route that takes a POST refuses a BG admin and a unit admin (403, before the route runs), except the
    four that change nothing until the super admin acts or only read: a KPI library proposal, a competency proposal,
    the Admin Agent's questions and the reminder preview
  * the super admin is never refused by it
  * their GETs stay open: Home, a person's page, the reports and the downloads
  * the portal says so (the View only notice, data-adm-viewonly) and static/admin.js turns every change form's controls
    off, while a proposal form (data-viewonly-ok) still sends
  * the page's own chrome is never locked (Chris, 2026-11-03: "the log out button disappears from the CHCE bghr admin page"):
    Log out is a POST form in the top bar's Account menu, and static/admin.js's CHROME skip names the top bar, so a BG
    admin, a unit admin and a role admin all keep it, while every form in #main stays under the lock
  * an authoritative roster file closes only the business groups it names (the super admin now imports every group's)
"""
import os
import re
import sys
from html.parser import HTMLParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("BG and unit admins read the admin portal; only the super admin changes it")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG = "ZZVO Group"
# Grade H Appraisal is dark (404 for everyone) unless ONEHR_GRADEH=1: switch it on here so its super-only admin writes are
# judged by their own 403 for a BG or unit admin, not hidden behind the dark gate (2026-10-28)
os.environ["ONEHR_GRADEH"] = "1"


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9VO-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM admin_role_access WHERE role_id IN (SELECT id FROM admin_roles WHERE name='ZZVO role')")
    db.execute("DELETE FROM admin_roles WHERE name='ZZVO role'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZVO U1')", (BG,))
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                     "VALUES ('zz9vo-bga', 'ZZ VO Groupadmin', 'x', 'admin', 'ZZ9VO-BGA', ?, ?)", (BG, BG)).lastrowid
    UNA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                     "VALUES ('zz9vo-una', 'ZZ VO Unitadmin', 'x', 'admin', 'ZZ9VO-UNA', ?, ?)", (BG, BG)).lastrowid
    db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?, 'ZZVO U1')", (UNA,))
    # a role admin: their role ticks one change, so their pages carry data-adm-access, not data-adm-viewonly
    RID = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZVO role', 'group')").lastrowid
    db.execute("INSERT INTO admin_role_access(role_id, item) VALUES (?, 'f360.add')", (RID,))
    RAD = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg, "
                     "admin_role_id) VALUES ('zz9vo-rad', 'ZZ VO Roleadmin', 'x', 'admin', 'ZZ9VO-RAD', ?, ?, ?)",
                     (BG, BG, RID)).lastrowid
    P = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                   "job_grade) VALUES ('zz9vo-p', 'ZZ VO Person', 'x', 'user', 'ZZ9VO-P', ?, 'ZZVO U1', '14')",
                   (BG,)).lastrowid
    db.commit()
SUP, BAC, UAC = H.client_as(a, SU["id"]), H.client_as(a, BGA), H.client_as(a, UNA)
RAC = H.client_as(a, RAD)
# what stays open to an admin with nothing ticked: the "always" routes of their access (test_admin_access holds the rest)
ALLOWED = {ep for ep, spec in a.ADMIN_ACCESS_MAP.items()
           if spec == "always" or (isinstance(spec, dict) and "always" in spec["map"].values())}


class _Forms(HTMLParser):
    """Every POST form of a page: its action, and whether it sits in #main and which of its ancestors match `sel`
    (a comma list of simple `.class` / `#id` / `tag.class` selectors, all admin.js's CHROME needs)."""
    VOID = {"input", "meta", "link", "br", "img", "hr", "path", "circle", "rect", "line", "source", "col", "area", "base"}

    def __init__(self, sel):
        super().__init__()
        self.sel = [x.strip() for x in sel.split(",") if x.strip()]
        self.stack, self.forms = [], []

    def _hit(self, tag, at):
        cls = (at.get("class") or "").split()
        for one in self.sel:
            m = re.fullmatch(r"([a-z0-9]*)((?:[.#][A-Za-z0-9_-]+)*)", one)
            if not m:
                continue
            if m.group(1) and m.group(1) != tag:
                continue
            if all((p[1:] in cls) if p[0] == "." else (at.get("id") == p[1:]) for p in re.findall(r"[.#][A-Za-z0-9_-]+", m.group(2))):
                return True
        return False

    def handle_starttag(self, tag, attrs):
        at = dict(attrs)
        if tag == "form" and (at.get("method") or "get").lower() == "post":
            self.forms.append({"action": at.get("action") or "", "in_chrome": any(c for _t, c, _m in self.stack),
                               "in_main": any(m for _t, _c, m in self.stack)})
        if tag not in self.VOID:
            self.stack.append((tag, self._hit(tag, at), at.get("id") == "main"))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break


def url_of(rule):
    return re.sub(r"<(?:[a-z]+:)?([a-z_]+)>", lambda m: "1" if m.group(1) not in ("key", "token", "path", "filename")
                  else "x", rule.rule)


try:
    s.section("every admin write")
    rules = [r for r in a.app.url_map.iter_rules() if r.rule.startswith("/admin") and "POST" in r.methods]
    s.check("there are admin write routes to check (%d)" % len(rules), len(rules) >= 30, len(rules))
    leaks = []
    for r in rules:
        if r.endpoint in ALLOWED:
            continue
        archived = any(r.rule.startswith(p_) for p_ in a.ARCHIVED_ROUTE_PREFIXES)   # a bare 404 for everyone
        # the Executive Chairman view is dark (404 for everyone signed in) while ONEHR_CHAIR is off; test_exec_chair
        # holds the 403 for a BG admin and a unit admin with it on
        archived = archived or (r.endpoint in a.CHAIR_ENDPOINTS and not a.chair_on())
        for who, c in (("BG admin", BAC), ("unit admin", UAC)):
            code = c.post(url_of(r), data={"csrf_token": "tok", "action": "add"}).status_code
            if code != 403 and not (archived and code == 404):
                leaks.append("%s %s -> %s" % (who, r.rule, code))
    s.check("each refuses a BG admin and a unit admin (403, before the route runs)", not leaks, leaks[:10])
    s.check("...except what changes nothing until the super admin acts, or only reads", ALLOWED == {
        "admin_library_propose", "admin_competency_library", "admin_agent",   # the reminder's preview: super's (Email)
        "admin_learning_agent",   # the L&D agent's ask reads only (2026-10-22, S15); sending a draft is L&D's
        "admin_tickets_agent",    # the Ticketing agent's ask reads only, the route checks Ticketing's read (2026-10-23)
        "admin_learning_certificates",   # a certificate preview writes nothing; the route takes L&D's only
        "admin_connect_create", "admin_connect_revoke"})   # AI+ Connect (2026-10-28): a bare 404 for everyone but a system admin
    s.check("a competency proposal passes the gate; every other action on that page doesn't", BAC.post(
        "/admin/competency/library", data={"csrf_token": "tok", "action": "propose", "profile_id": "0"}).status_code
        != 403 and BAC.post("/admin/competency/library", data={"csrf_token": "tok", "action": "five"}).status_code == 403)
    s.check("a KPI library proposal passes it", BAC.post("/admin/performance/library/propose", data={
        "csrf_token": "tok", "kind": "new_kpi", "name": ""}).status_code != 403)
    s.check("the super admin is never refused by it", SUP.post("/admin/users", data={
        "csrf_token": "tok", "action": "nonsense"}).status_code != 403)

    s.section("reading stays open")
    for path in ("/admin", "/admin/users/%d" % P, "/admin/reports", "/admin/reports/all", "/admin/module/pm/progress.xlsx",
                 "/admin/performance/export.csv", "/admin/notify"):
        s.check("a BG admin reads %s" % path, BAC.get(path).status_code == 200, BAC.get(path).status_code)
    # Audit and usage (Data integrity among it) and All settings are the super admin's (Chris, 2026-10-21)
    for path in ("/admin/data-integrity", "/admin/all-settings"):
        s.check("...but not %s: the super admin's" % path, BAC.get(path).status_code in (302, 403),
                BAC.get(path).status_code)

    s.section("the portal marks it for the script, with no note (Chris, 2026-10-20: \"don't need this note\")")
    pg = BAC.get("/admin").get_data(as_text=True)
    s.check("a BG admin's portal: the marker the script reads, and no View only note",
            "data-adm-viewonly" in pg and "View only." not in pg and "changes are made by the super admin" not in pg)
    s.check("...a unit admin's too", "data-adm-viewonly" in UAC.get("/admin").get_data(as_text=True))
    s.check("...never the super admin's", "data-adm-viewonly" not in SUP.get("/admin").get_data(as_text=True))
    js = open(os.path.join(H.REPO, "static", "admin.js"), encoding="utf-8").read()
    s.check("static/admin.js turns every change form's controls off, keeping a proposal form and plain buttons",
            "data-adm-viewonly" in js and "is-viewonly" in js and "[data-viewonly-ok]" in js
            and "getAttribute('type') === 'button'" in js and "MutationObserver" in js)
    for f, n in (("templates/admin_kpi_library.html", 2), ("templates/admin_competency_library.html", 1)):
        s.check("%s's proposal form%s still send%s" % (f, "s" if n > 1 else "", "" if n > 1 else "s"),
                open(os.path.join(H.REPO, f), encoding="utf-8").read().count("data-viewonly-ok") == n)
    # a plain button that sends its form by script (QC 2026-10-24: a BG admin's KPI import showed a live Preview that
    # answered 403) goes with the form's own buttons
    lock = js[js.index("function lockForm"):js.index("function lock(root)")]
    s.check("...but a plain button marked data-sends goes off and hides with them",
            "!el.hasAttribute('data-sends')" in lock and "is-viewonly-btn" in lock)
    tpl_dir = os.path.join(H.REPO, "templates")
    sends, unmarked = 0, []
    for root, _d, files in os.walk(tpl_dir):
        for fn in files:
            if not fn.endswith(".html"):
                continue
            src = open(os.path.join(root, fn), encoding="utf-8").read()
            for b in re.findall(r"<button\b[^>]*>", src):
                if 'type="button"' in b and re.search(r"\bdata-(preview-btn|pt)\b", b):
                    sends += 1
                    if "data-sends" not in b:
                        unmarked.append(fn)
    s.check("every script-sent button (an import's Preview, Participants' three) is marked data-sends (%d)" % sends,
            sends >= 3 and not unmarked, unmarked)   # Participants' three at least (the imports in four steps,
                                                     # 2026-10-26, check the file with a plain submit instead)

    s.section("the page's own chrome is never locked: Log out stays for every admin (Chris, 2026-11-03)")
    m_ = re.search(r"var CHROME = '([^']+)';", js)
    s.check("static/admin.js names the chrome it never locks in one selector constant (CHROME)", bool(m_) and m_.group(1).strip() != "")
    chrome_sel = m_.group(1) if m_ else ".no-such-chrome"
    lock_src = js[js.index("function lock(root)"):js.index("lock(document);")]
    s.check("...and lock() skips a form inside it, next to the data-viewonly-ok skip",
            bool(re.search(r"f\.closest\('\[data-viewonly-ok\]'\)\s*\|\|\s*f\.closest\(CHROME\)", lock_src)))
    for who, c in (("BG admin", BAC), ("unit admin", UAC), ("role admin", RAC)):
        pgw = c.get("/admin").get_data(as_text=True)
        s.check("%s: the page is locked for the script (data-adm-viewonly or data-adm-access)" % who,
                "data-adm-viewonly" in pgw or "data-adm-access" in pgw)
        fp = _Forms(chrome_sel)
        fp.feed(pgw)
        outs = [f for f in fp.forms if f["action"].endswith("/logout")]
        s.check("%s: Log out is a POST form in the top bar, inside what CHROME names, not in #main" % who,
                len(outs) == 1 and outs[0]["in_chrome"] and not outs[0]["in_main"], outs)
    # nothing in #main is ever inside the chrome: the lock on admin content is today's
    seen_main = 0
    for path in ("/admin", "/admin/notify", "/admin/users/%d" % P, "/admin/performance/library"):
        fp = _Forms(chrome_sel)
        fp.feed(BAC.get(path).get_data(as_text=True))
        inmain = [f for f in fp.forms if f["in_main"]]
        seen_main += len(inmain)
        s.check("a BG admin's %s: every POST form in #main is outside CHROME (%d of them)" % (path, len(inmain)),
                not any(f["in_chrome"] for f in inmain), [f for f in inmain if f["in_chrome"]])
    s.check("...and the pages checked do carry POST forms in #main to lock, so the check reaches them", seen_main > 0, seen_main)

    s.section("an authoritative roster closes only the groups it names")
    with a.app.test_request_context("/"):
        db = a.get_db()
        sup = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        sc, sp = a._roster_leaver_scope(sup, {BG})
        n = db.execute("SELECT COUNT(*) FROM users WHERE role='user' AND left_at IS NULL AND is_demo=0" + sc,
                       sp).fetchone()[0]
        n_bg = db.execute("SELECT COUNT(*) FROM users WHERE role='user' AND left_at IS NULL AND is_demo=0 AND "
                          "business_group=?", (BG,)).fetchone()[0]
        none_sc, none_sp = a._roster_leaver_scope(sup, set())
    s.check("the super admin's file naming one group can only close that group's people", n == n_bg == 1, (n, n_bg))
    s.check("...a file naming none closes nobody", none_sc.strip() == "AND 0" and none_sp == [])
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
