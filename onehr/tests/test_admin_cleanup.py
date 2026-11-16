"""The admin page review (Chris, 2026-10-10, canvas row K):

  "run a thorough review of all our admin page, and ensure every pages follow our new design style, and also do a
   review on the functionality and necessity of our admin pages and configuration, list down any redundancy and make
   adjustment"
  "for the BG and BU filter selection, always go by order of BG, BU, then department, each in one row, and apply
   navigation button if there are more than the display allowed"

What this pins: the filter rows (group, then unit once a group is picked, then department once a unit is; each option a
link that keeps the page's other arguments; a BG admin starts at their own units); the one Admins page that replaced BG
admins and Sub-admins; Release results releasing the 360 report too; the pages folded into others answering with a
redirect; the bulk "mark as left" page on the rows, its select-all honouring the department; a form's `next` followed
only on this site's admin paths; and no browser dialog left on an admin page.

Its own synthetic business group (ZZAC) on the shared suite database, two units: Alpha with two departments (Finance 2,
Ops 1), Beta with one (Sales 2). Everything is put back at the end.
"""
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Admin review -- filter rows, one Admins page, report release, folded pages, no browser dialogs")
BG, CA, CB = "ZZAC Group", "ZZAC Alpha Sdn Bhd", "ZZAC Beta Sdn Bhd"
FIN, OPS, SAL = "ZZAC Finance", "ZZAC Ops", "ZZAC Sales"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZAC-%' OR username LIKE 'zzac-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        for tb, col in (("assignments", "subject_id"), ("assignments", "assessor_id"), ("report_releases", "subject_id"),
                        ("result_releases", "subject_id"), ("admin_companies", "admin_id")):
            db.execute("DELETE FROM %s WHERE %s IN (%s)" % (tb, col, ph), ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZAC-%' OR username LIKE 'zzac-%'")
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    _cleanup(db)   # a run that died half-way
    _period, _cyc = a.talent_period_cycle(db)
    RCID = _cyc["id"] if _cyc else None          # the 360 cycle Release results releases reports for
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, company, dept, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=company, department=dept,
                 left_at=None, is_demo=0, role="user", admin_bg=None, job_grade=15, confirmation_date="2020-01-01")
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
    F1 = person("ZZAC-F1", "ZZ AC Finance One", CA, FIN)
    F2 = person("ZZAC-F2", "ZZ AC Finance Two", CA, FIN)
    O1 = person("ZZAC-O1", "ZZ AC Ops One", CA, OPS)
    S1 = person("ZZAC-S1", "ZZ AC Sales One", CB, SAL)
    S2 = person("ZZAC-S2", "ZZ AC Sales Two", CB, SAL)
    N1 = person("ZZAC-N1", "ZZ AC Nounit One", None, None)   # no business unit on record (NULL) ...
    N2 = person("ZZAC-N2", "ZZ AC Nounit Two", "", None)     # ... and blank: "All of" must count both
    BGA = person("ZZAC-BGA", "ZZ AC Groupadmin", CA, None, role="admin", admin_bg=BG)
    UNA = person("ZZAC-UNA", "ZZ AC Unitadmin", CB, None, role="admin", admin_bg=BG)
    db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (UNA, CB))
    for co in (CA, CB):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, co))
    MINV = a.min_valid()
    # F1 has enough ratings in for a report; F2 has one in and one still to come (so Finance is outstanding)
    for cyc_id in {CID, RCID} - {None}:
        for i, who in enumerate([x for x in (O1, S1, S2, F2, UNA) if x != F1][:MINV]):
            db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, submitted_at) "
                       "VALUES (?,?,?,'peer','submitted',datetime('now'))", (cyc_id, F1, who))
        db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, submitted_at) "
                   "VALUES (?,?,?,'peer','submitted',datetime('now'))", (cyc_id, F2, O1))
        db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) "
                   "VALUES (?,?,?,'peer','pending')", (cyc_id, F2, S1))
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]
    OTHER = db.execute("SELECT business_group FROM org_units WHERE active=1 AND business_group!=? ORDER BY "
                       "business_group LIMIT 1", (BG,)).fetchone()[0]
    DBG = a.display_bg(BG)
    LA, LB = a.display_company(BG, CA) or CA, a.display_company(BG, CB) or CB


def page(cl, url):
    r = cl.get(url)
    return r.status_code, html.unescape(r.get_data(as_text=True))


def frows(body):
    """The filter rows as [(label, [(pill text, on, href)])], read off the page."""
    out = []
    for m in re.finditer(r'<span class="adm-frow-lbl">(.*?)</span>(.*?)</div>\s*<button', body, re.S):
        pills = [(re.sub(r"<span>.*?</span>", "", t).strip(), "is-on" in c, h)
                 for c, h, t in re.findall(r'<a class="adm-frow-pill([^"]*)" href="([^"]*)"[^>]*>(.*?)</a>', m.group(2),
                                           re.S)]
        if m.group(1) != "Role":   # People > Users' Role row (admin round 4, row 8) is its own filter, not the chain
            out.append((m.group(1), pills))
    return out


def pill(rows, label, text):
    for lbl, ps in rows:
        if lbl == label:
            for t, on, h in ps:
                if t == text:
                    return on, h
    return None


def db_one(sql, args=()):
    with a.app.app_context():
        return a.get_db().execute(sql, args).fetchone()


sup, bga, una = (H.client_as(a, x) for x in (SUP, BGA, UNA))
try:
    # -----------------------------------------------------------------------
    s.section("filter rows: business group, then unit, then department, each in its own row")
    code, b = page(sup, "/admin/users")
    r0 = frows(b)
    s.check("Users opens with the business group row only", code == 200 and [x[0] for x in r0] == ["Business group"],
            [x[0] for x in r0])
    hit = pill(r0, "Business group", DBG)
    s.check("...each group a link, with its headcount (ZZAC: 7 people)", hit is not None
            and "fbg=" in hit[1] and re.search(r'%s<span>7</span>' % re.escape(DBG), b) is not None, hit)
    code, b = page(sup, "/admin/users?fbg=%s&q=ZZ+AC" % BG)
    r1 = frows(b)
    s.check("picking a group adds the unit row under it", [x[0] for x in r1] == ["Business group", "Business unit"],
            [x[0] for x in r1])
    s.check("...the group is the one lit", (pill(r1, "Business group", DBG) or (False,))[0])
    s.check("...and 'All of' counts the whole group, the two with no unit on record too (7, as the list shows)",
            re.search(r'All of %s<span>7</span>' % re.escape(DBG), b) is not None and "7 people" in b)
    hit = pill(r1, "Business unit", LA)
    s.check("...each unit keeps the search and the group", hit is not None and "q=ZZ+AC" in hit[1]
            and "fbg=" in hit[1] and "fbu=" in hit[1], hit)
    code, b = page(sup, "/admin/users?fbg=%s&fbu=%s&page=3" % (BG, CA))
    r2 = frows(b)
    s.check("picking a unit adds the department row", [x[0] for x in r2] == ["Business group", "Business unit",
                                                                            "Department"], [x[0] for x in r2])
    dp = [t for t, _on, _h in dict(r2)["Department"]]
    s.check("...listing that unit's departments only", dp == ["All", FIN, OPS], dp)
    s.check("...and no pill carries the page number", all("page=" not in h for _l, ps in r2 for _t, _o, h in ps))
    code, b = page(sup, "/admin/users?fbg=%s&fbu=%s&fdept=%s" % (BG, CA, FIN))
    s.check("a department narrows the list to its people", "ZZ AC Finance One" in b and "ZZ AC Finance Two" in b
            and "ZZ AC Ops One" not in b and "ZZ AC Sales One" not in b)
    code, b = page(bga, "/admin/users?fbg=%s" % OTHER)
    rb = frows(b)
    s.check("a BG admin has no group row: they start at their own units", [x[0] for x in rb] == ["Business unit"]
            and pill(rb, "Business unit", LA) is not None, [x[0] for x in rb])
    code, b = page(una, "/admin/users")
    ru = frows(b)
    s.check("a unit admin sees their own unit only", pill(ru, "Business unit", LB) is not None
            and pill(ru, "Business unit", LA) is None, ru)
    s.check("the arrows are there for a row that overflows (admin.js shows them)",
            'class="adm-frow-nav is-prev"' in b and 'class="adm-frow-nav is-next"' in b)
    js = open(os.path.join(a.app.root_path, "static", "admin.js")).read()
    s.check("...and admin.js drives them: hidden unless the row overflows, and the lit pill scrolled into view",
            "adm-frow" in js and "scrollWidth" in js and "is-on" in js)

    # -----------------------------------------------------------------------
    s.section("the same rows on the other admin pages")
    for url, label in (("/admin/subjects?fbg=%s" % BG, "360 People"),
                       ("/admin/assessors?fbg=%s" % BG, "Rater progress"),
                       ("/admin/participants?bg=%s" % BG, "Participants"),
                       ("/admin/talent-release?bg=%s" % BG, "Release results"),
                       ("/admin/module/pm/progress?fbg=%s" % BG, "Performance progress")):
        code, b = page(sup, url)
        lbls = [x[0] for x in frows(b)]
        s.check("%s: group, then unit" % label, code == 200 and lbls[:2] == ["Business group", "Business unit"],
                (code, lbls))

    # -----------------------------------------------------------------------
    s.section("360 Overview: where the ratings are outstanding, by department")
    code, b = page(bga, "/admin/360")
    m = re.search(r'<b>%s</b>.*?<a class="btn-link" href="([^"]+)">Open' % re.escape(FIN), b, re.S)
    s.check("a department with a rating still to come is listed (Finance)", code == 200 and m is not None, code)
    sec = b.split("Where the ratings are outstanding", 1)[-1].split("</section>", 1)[0]
    shown = re.findall(r"<td><b>(.*?)</b>", sec)
    s.check("...and nothing from another business group for a BG admin (Finance is ZZAC's only one outstanding)",
            shown == [FIN], shown)
    href = m.group(1) if m else ""
    s.check("its Open link carries the unit as the People page reads it (fcompany), and the department",
            "fcompany=" in href and "fdept=" in href and "fbu=" not in href, href)
    code, b = page(bga, href or "/admin/subjects")
    s.check("...and opens People on that department only", "ZZ AC Finance Two" in b and "ZZ AC Ops One" not in b
            and "ZZ AC Sales One" not in b)

    # -----------------------------------------------------------------------
    s.section("one Admins page for BG admins and unit admins")
    code, b = page(sup, "/admin/admins")
    s.check("the super admin sees every kind: the group admin and the unit admin", code == 200
            and "zzac-bga" in b and "zzac-una" in b and "All of %s" % DBG in b and "%s: 1 business unit<" % DBG in b
            and LB in b)
    code, b = page(bga, "/admin/admins")
    s.check("a BG admin sees their own group's unit admins only", code == 200 and "zzac-una" in b
            and "zzac-bga" not in b and "Everything" not in b)
    s.check("a unit admin cannot open it", una.get("/admin/admins").status_code == 403)
    for old in ("/admin/bg-admins", "/admin/subadmins"):
        r = sup.get(old)
        s.check("%s comes to Admins" % old, r.status_code in (301, 302)
                and r.headers.get("Location", "").endswith("/admin/admins"), (r.status_code, r.headers.get("Location")))
    r = sup.post("/admin/admins", data={"csrf_token": "tok", "username": "zzac-new-bg", "password": "silver anchor 47",
                                        "business_group": BG})
    row = db_one("SELECT admin_bg, (SELECT COUNT(*) FROM admin_companies WHERE admin_id=users.id) FROM users "
                 "WHERE username='zzac-new-bg'")
    s.check("the super admin adding with no unit ticked makes a whole-group admin", row is not None
            and row[0] == BG and row[1] == 0, row and tuple(row))
    r = bga.post("/admin/admins", data={"csrf_token": "tok", "username": "zzac-new-un", "password": "silver anchor 47",
                                        "business_group": OTHER, "companies": [CB, "Not A Unit Sdn Bhd"]})
    row = db_one("SELECT admin_bg, (SELECT GROUP_CONCAT(company) FROM admin_companies WHERE admin_id=users.id) FROM "
                 "users WHERE username='zzac-new-un'")
    s.check("a BG admin can't add a unit admin: view only (Chris, 2026-10-19)", r.status_code == 403 and row is None,
            row and tuple(row))
    bga.post("/admin/admins", data={"csrf_token": "tok", "username": "zzac-new-none", "password": "silver anchor 47"})
    s.check("...and cannot add a whole-group admin (no unit ticked is refused)",
            db_one("SELECT 1 FROM users WHERE username='zzac-new-none'") is None)
    sup.post("/admin/admins", data={"csrf_token": "tok", "username": "zzac-new-bg", "password": "silver anchor 47",
                                    "business_group": BG})
    s.check("a username already taken is refused", db_one("SELECT COUNT(*) FROM users WHERE username='zzac-new-bg'")[0]
            == 1)

    # -----------------------------------------------------------------------
    s.section("Release results releases the 360 report too (was People > Report ready)")
    if RCID is None:
        s.check("a period with a matching 360 cycle to release for", False, "none in the suite database")
    else:
        r = sup.get("/admin/subjects?scope=report_ready")
        s.check("People's old Report ready view comes here", r.status_code in (301, 302)
                and "/admin/talent-release" in r.headers.get("Location", ""), r.headers.get("Location"))
        code, b = page(sup, "/admin/talent-release?bg=%s" % BG)
        s.check("the page has a 360 report column", code == 200 and "360 report" in b)
        sup.post("/admin/talent-release?bg=%s" % BG, data={"csrf_token": "tok", "action": "release",
                                                           "result": "report", "ids": [F1, F2]})
        rel = {r[0] for r in H.rows(a, "SELECT subject_id FROM report_releases WHERE cycle_id=? AND subject_id IN "
                                       "(?,?)", (RCID, F1, F2))}
        s.check("releasing reports releases the one with enough ratings in (F1, %d in) and skips the one without (F2)"
                % MINV, rel == {F1}, rel)
        s.check("...and the release is in the activity log", db_one(
            "SELECT 1 FROM activity_log WHERE action='release' AND target_user_id=?", (F1,)) is not None)
        sup.post("/admin/talent-release?bg=%s" % BG, data={"csrf_token": "tok", "action": "revoke",
                                                           "result": "report", "ids": [F1]})
        s.check("taking it back removes it", db_one("SELECT 1 FROM report_releases WHERE cycle_id=? AND subject_id=?",
                                                    (RCID, F1)) is None)
        s.check("a BG admin cannot release (super admin only)", bga.post(
            "/admin/talent-release", data={"csrf_token": "tok", "action": "release", "result": "report",
                                           "ids": [F1]}).status_code in (302, 403)
            and db_one("SELECT 1 FROM report_releases WHERE subject_id=?", (F1,)) is None)

    # -----------------------------------------------------------------------
    s.section("pages folded into others answer with a redirect")
    for url, want in (("/admin/subjects/%d/panel" % F1, "/admin/users/%d" % F1),
                      ("/admin/subjects/%d/assessing" % F1, "/admin/users/%d" % F1),
                      ("/admin/m/pm/reports", "/admin/reports")):
        r = sup.get(url)
        loc = r.headers.get("Location", "")
        s.check("%s comes to %s" % (url, want), r.status_code in (301, 302) and want in loc
                and ("tab=f360" in loc if "subjects" in url else True), (r.status_code, loc))
    s.check("...and the redirects still check scope (a unit admin of Beta is refused Alpha's person)",
            una.get("/admin/subjects/%d/panel" % F1).status_code == 403
            and una.get("/admin/subjects/%d/assessing" % F1).status_code == 403)
    code, b = page(sup, "/admin/users/%d?tab=f360" % F1)
    s.check("the person's 360 tab holds their panel and the feedback they give", code == 200
            and "Feedback they give" in b)

    # -----------------------------------------------------------------------
    s.section("Users: the row menu went; a person changes on their page")
    before = db_one("SELECT manager_id, hod_id FROM users WHERE id=?", (F1,))
    for act in ("set_manager", "set_hod", "set_bgceo", "set_buceo"):
        sup.post("/admin/users", data={"csrf_token": "tok", "action": act, "user_id": F1, "manager_eid": "ZZAC-O1",
                                       "hod_eid": "ZZAC-O1", "bg": BG, "company": CA})
    after = db_one("SELECT manager_id, hod_id, bgceo_bg, buceo_bg FROM users WHERE id=?", (F1,))
    s.check("the removed Users actions change nothing (lines and roles change on the person page)",
            tuple(after) == (before[0], before[1], None, None), tuple(after))
    r = sup.post("/admin/users", data={"csrf_token": "tok", "action": "set_email", "user_id": F1,
                                       "email": "zz.ac@example.test", "next": "/admin/users/%d?tab=overview" % F1})
    s.check("a form's next is followed back to the person page", r.headers.get("Location", "").endswith(
        "/admin/users/%d?tab=overview" % F1), r.headers.get("Location"))
    for bad in ("https://example.test/x", "//example.test/x", "/admin/\\example.test", "/login"):
        r = sup.post("/admin/users", data={"csrf_token": "tok", "action": "set_email", "user_id": F1, "email": "",
                                           "next": bad})
        loc = r.headers.get("Location", "")
        s.check("...but not off this site's admin pages (%s)" % bad, "example.test" not in loc
                and not loc.endswith("/login"), loc)

    # -----------------------------------------------------------------------
    s.section("Mark several as left / Bring people back, on the rows")
    code, b = page(sup, "/admin/users?view=inactivate&fbg=%s&fbu=%s&fdept=%s" % (BG, CA, FIN))
    s.check("the bulk page has the rows and lists that department only", code == 200
            and [x[0] for x in frows(b)] == ["Business group", "Business unit", "Department"]
            and "ZZ AC Finance One" in b and "ZZ AC Ops One" not in b)
    s.check("...on the kit: a lede, no page title, and the app's dialog", "adm-lede" in b and "<h1" not in b
            and 'data-confirm-ok="Mark as left"' in b)
    r = sup.post("/admin/users", data={"csrf_token": "tok", "action": "bulk_mark_left", "select_all": "1", "q": "",
                                       "fbg": BG, "fcompany": CA, "fdept": FIN})
    gone = {x[0] for x in H.rows(a, "SELECT id FROM users WHERE employee_id LIKE 'ZZAC-%' AND left_at IS NOT NULL")}
    s.check("choosing every one that matches marks that department's people only (not Ops, not Beta)",
            gone == {F1, F2}, gone)
    loc = r.headers.get("Location", "")
    s.check("...and comes back to the same group, unit and department", "view=inactivate" in loc
            and "fbu=" in loc and "fdept=" in loc, loc)
    code, b = page(sup, "/admin/users?view=activate&fbg=%s" % BG)
    s.check("Bring people back lists the leavers, counted as such", "ZZ AC Finance One" in b and "ZZ AC Ops One" not in b
            and re.search(r'%s<span>2</span>' % re.escape(DBG), b) is not None)
    oadm = db_one("SELECT id FROM users WHERE role='admin' AND admin_bg=? LIMIT 1", (OTHER,))
    if oadm:
        H.client_as(a, oadm[0]).post("/admin/users", data={"csrf_token": "tok", "action": "bulk_reactivate",
                                                            "select_all": "1", "fbg": BG})
        s.check("another group's admin choosing everyone brings nobody back here", db_one(
            "SELECT COUNT(*) FROM users WHERE id IN (?,?) AND left_at IS NOT NULL", (F1, F2))[0] == 2)
    sup.post("/admin/users", data={"csrf_token": "tok", "action": "bulk_reactivate", "user_id": [F1, F2]})
    s.check("ticking people brings them back", db_one("SELECT COUNT(*) FROM users WHERE id IN (?,?) AND left_at IS NULL",
                                                      (F1, F2))[0] == 2)

    # -----------------------------------------------------------------------
    s.section("no browser dialog on an admin page; the kit's top of page")
    tdir = os.path.join(a.app.root_path, "templates")
    files = [os.path.join(tdir, f) for f in os.listdir(tdir) if f.startswith("admin") and f.endswith(".html")]
    for sub in ("settings", os.path.join("settings", "cards"), "person"):
        d = os.path.join(tdir, sub)
        files += [os.path.join(d, f) for f in os.listdir(d) if f.endswith(".html")]
    native = re.compile(r"return confirm\(|window\.confirm\(|(?<![\w.])alert\(|window\.alert\(|window\.prompt\(|"
                        r"(?<![\w.])prompt\(")
    hits = [os.path.relpath(f, tdir) for f in files if native.search(open(f).read())]
    s.check("no confirm(), alert() or prompt() in any admin, settings or person template", not hits, hits)
    basej = open(os.path.join(tdir, "base.html")).read()
    s.check("a confirm can sit on one submit button, and the replay submits through it (its value still posts)",
            "e.submitter.hasAttribute('data-confirm')" in basej and "var by = sub ||" in basej
            and "f.requestSubmit(by)" in basej)
    steps = open(os.path.join(tdir, "_import_steps.html")).read()   # every import in four steps (2026-10-26)
    up_ = re.search(r"{% macro upload.*?{% endmacro %}", steps, re.S).group(0)
    fin_ = re.search(r"{% macro final.*?{% endmacro %}", steps, re.S).group(0)
    for f in ("admin_import.html", "admin_import_roster.html", "admin_clear_panels.html",
              "admin_import_passwords.html"):
        src = open(os.path.join(tdir, f)).read()
        s.check("%s: checking the file asks nothing, Apply (step 4) asks first" % f, "_import_steps.html" in src
                and "imp.upload" in src and "data-confirm" not in src and "data-confirm" not in up_
                and 'data-confirm="{{ af.confirm }}"' in fin_)
    clash = [os.path.relpath(f, tdir) for f in files + [os.path.join(tdir, "_filter_rows.html")]
             if re.search(r'class="adm-search[ "]', open(f).read()) and not f.endswith("_admin_search.html")]
    s.check("a page's search row is .adm-fsearch: .adm-search is the full-screen search overlay (it greyed the page out)",
            not clash, clash)
    code, b = page(sup, "/admin/performance/exceptions")
    s.check("KPI lines with no moderator: a lede, the word moderator, no page title", code == 200
            and "adm-lede" in b and "<h1" not in b and "Approver exceptions" not in b and "moderator" in b, code)
    # -----------------------------------------------------------------------
    s.section("round 2 (2026-10-11): the audit log in words")
    import ast
    tree = ast.parse(H.source(a))
    logged = {n_.args[2].value for n_ in ast.walk(tree) if isinstance(n_, ast.Call)
              and getattr(n_.func, "id", None) == "log_activity" and len(n_.args) >= 3
              and isinstance(n_.args[2], ast.Constant)}
    unlabelled = sorted(c for c in logged if c not in a.ACTION_LABELS)
    s.check("every action the code logs has a label in words (%d codes)" % len(logged), not unlabelled, unlabelled)
    s.check("...and no label is just its code", all(v != k and "_" not in v for k, v in a.ACTION_LABELS.items()))
    s.check("computed and unknown codes still read as words",
            a.action_label("pm_kpi_setting_return") == "KPI setting: return"
            and a.action_label("talent_pip_lock") == "PIP list: lock"
            and a.action_label("some_new_thing") == "Some new thing", (a.action_label("pm_kpi_setting_return"),
                                                                      a.action_label("some_new_thing")))
    sup.post("/admin/users", data={"csrf_token": "tok", "action": "set_email", "user_id": S1,
                                   "email": "zz.ac.s1@example.test"})
    code, b = page(sup, "/admin/audit-log?q=ZZ+AC+Sales+One")
    s.check("the Audit log shows 'Changed work email', not set_email", code == 200 and "Changed work email" in b
            and ">set_email<" not in b, code)
    s.check("...its Action filter lists words", "Changed work email" in b.split("pm-")[-1] or '"Changed work email"' in b)
    code, b = page(sup, "/admin/audit-log?faction=Changed+work+email&q=ZZ+AC")
    code2, b2 = page(sup, "/admin/audit-log?faction=set_email&q=ZZ+AC")
    s.check("filtering by the words finds it, and an old link by code still does",
            "ZZ AC Sales One" in b and "ZZ AC Sales One" in b2)
    r = sup.get("/admin/export/audit-log.csv?q=ZZ+AC+Sales+One")
    csv_ = H.as_csv_text(r)
    s.check("the export says it in words and keeps the code in its own column",
            "Changed work email" in csv_ and "Action code" in csv_.splitlines()[0] and "set_email" in csv_)
    code, b = page(sup, "/admin/users/%d" % S1)
    s.check("the person page's What changed says it in words", "Changed work email" in b)

    # -----------------------------------------------------------------------
    s.section("round 2: the rows on Rater extremes and Fill BU KPI; Users' download follows the list")
    code, b = page(sup, "/admin/assessor-extremes?fbg=%s" % BG)
    s.check("Rater extremes has the group and unit rows, and no column menus", code == 200
            and [x[0] for x in frows(b)][:2] == ["Business group", "Business unit"] and "col-menu-btn" not in b, code)
    code, b = page(sup, "/admin/performance/bu-fill?business_group=%s" % BG)
    s.check("Fill BU KPI picks the group and unit on the rows, the first unit option the whole group",
            code == 200 and [x[0] for x in frows(b)] == ["Business group", "Business unit"]
            and (pill(frows(b), "Business unit", "Whole business group") or (False,))[0], code)
    code, b = page(sup, "/admin/users?fbg=%s&fbu=%s&fdept=%s&show=all" % (BG, CA, FIN))
    m = re.search(r'href="(/admin/export/users\.(?:csv|xlsx)[^"]*)"', b)
    s.check("Users has no Download link now (it moved to Reports, 4 Nov 2026); the address takes the group, unit, department and Show choice",
            m is None)
    from urllib.parse import urlencode as _ue
    href = "/admin/export/users.xlsx?" + _ue([("fbg", BG), ("fcompany", CA), ("fdept", FIN), ("show", "all")])
    out = H.as_csv_text(sup.get(href)) if href else ""
    s.check("...and the file holds that department only", "ZZ AC Finance One" in out and "ZZ AC Ops One" not in out
            and "ZZ AC Sales One" not in out)

    # -----------------------------------------------------------------------
    s.section("round 2: the KPI library, competency speed, the 400 page, data integrity, Promotion")
    with a.app.test_request_context("/"):
        tiers = a.default_tiers()
        t2 = next(t for t in tiers if t["n"] == 2)
        row = {k: None for k in ("job_grades", "company", "department", "kpi_name", "category", "description", "unit",
                                 "departments", "department_mode")}   # no number columns: the library holds none
        row.update({"id": 1, "job_grade": "*", "tier_n": 2, "method": "more", "bu_level": 0, "company": "*",
                    "department": "*", "kpi_name": "x"})
        out = a.app.jinja_env.from_string('{% from "_kpi_form.html" import kpi_form %}'
                                          '{{ kpi_form(cfg, tiers, row, "update", "BG", []) }}').render(
            cfg=None, tiers=tiers, row=row)
    want = ",".join(str(g_) for g_ in range(t2["min"], t2["max"] + 1))
    # the grades are ticked boxes since 2026-10-19
    got = ",".join(re.findall(r'name="job_grades" value="([^"]*)" checked', out.replace("\n", " ")))
    s.check("a KPI library row kept by its old tier opens with that tier's grades (it opened blank)", got == want,
            (got, want))
    src = H.source(a)
    s.check("competency progress counts answers with the scores as the outer loop (4.9 s -> 0.003 s on staging)",
            "FROM tc_scores sc \"\n        \"CROSS JOIN tc_assignments a ON a.id = sc.assignment_id" in src)
    with a.app.app_context():
        db_ = a.get_db()
        cid_ = a.active_cycle_id(db_)
        q_ = ("SELECT a.subject_id, COUNT(*) FROM tc_scores sc %s tc_assignments a ON a.id = sc.assignment_id "
              "WHERE a.cycle_id=? GROUP BY a.subject_id")
        same = (dict(db_.execute(q_ % "JOIN", (cid_,)).fetchall()) == dict(db_.execute(q_ % "CROSS JOIN", (cid_,))
                                                                           .fetchall()))
    s.check("...and it counts exactly what the plain join counted", same)
    nocsrf = a.app.test_client()
    with nocsrf.session_transaction() as ss:
        ss["user_id"] = SUP
        ss["csrf_token"] = "tok"
    r = nocsrf.post("/admin/users", data={"action": "set_email", "user_id": S1, "email": ""})
    s.check("a form with a bad security token says the session expired", r.status_code == 400
            and "Your session expired" in r.get_data(as_text=True))
    r = sup.get("/admin/export/report.pdf")
    body = r.get_data(as_text=True)
    s.check("any other bad request says what it is, not 'session expired'", r.status_code == 400
            and "That couldn't be done" in html.unescape(body) and "session expired" not in body)
    chk = next(c for c in a.DATA_CHECKS if c["key"] == "released_below_threshold")
    s.check("Data integrity's released-too-early check opens Release results (it opened Results analysis)",
            chk["fix_ep"] == "admin_talent_release")
    code, b = page(sup, "/admin/data-integrity?check=no_department")
    s.check("...each person in a check opens their own page", code == 200
            and "/admin/users/%d?tab=overview" % N1 in b and "To fix:" in b and "Open Users" not in b, code)
    _rp = sup.get("/admin/promotion/config")
    s.check("the Promotion page, archived 2026-10-13 (it was parked), goes to the admin home",
            _rp.status_code in (301, 302) and _rp.headers.get("Location", "").endswith("/admin"), _rp.status_code)
    tpl_hits = []
    for root_, _d, fs in os.walk(tdir):
        for f_ in fs:
            if f_.endswith(".html") and re.search(r'on(click|submit)="return confirm\(', open(os.path.join(root_, f_)).read()):
                tpl_hits.append(f_)
    s.check("no form or button anywhere asks with the browser's confirm()", not tpl_hits, tpl_hits)
    # -----------------------------------------------------------------------
    s.section("the potential score's 360 : competency weighting on TM's settings, 40 : 60 by default (2026-10-11)")
    for key in ("f360", "competency"):
        code, b = page(sup, "/admin/m/%s/settings" % key)
        s.check("%s settings carry the weighting card, with the 40 : 60 default and a fill-every-grade helper" % key,
                code == 200 and 'id="band-weights"' in b and "Potential score: 360 and competency weighting" in b
                and 'name="w360_15"' in b and "Now <b>40 : 60 for every grade</b>" in b and 'id="bw-all-btn"' in b, code)
    code, b = page(sup, "/admin/m/calibration/settings")
    s.check("...and Calibration & Talent no longer holds it, its thresholds card pointing there instead",
            code == 200 and 'id="band-weights"' not in b and "Open Competency settings" in b, code)
    code, b = page(bga, "/admin/m/competency/settings")
    s.check("a BG admin doesn't get the card (super admin only)", 'name="w360_15"' not in b, code)
    src_ = H.source(a)
    s.check("a new database seeds 40 : 60 for every grade", 'VALUES (?,?,?)", (_jg, 40.0, 60.0))' in src_
            and "else 50.0" not in src_)
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        keep = [tuple(r) for r in d_.execute("SELECT job_grade, w_360, w_tech, updated_by FROM tc_band_weights")]
        d_.execute("UPDATE tc_band_weights SET w_360=50, w_tech=50, updated_by=NULL WHERE job_grade='18'")
        d_.execute("UPDATE tc_band_weights SET w_360=50, w_tech=50, updated_by=? WHERE job_grade='19'", (SUP,))
        d_.commit()
    try:
        a._ensure_runtime_schema()   # what every boot (and the deploy's migration step) runs
        with a.app.test_request_context("/"):
            d_ = a.get_db()
            w18 = tuple(d_.execute("SELECT w_360, w_tech FROM tc_band_weights WHERE job_grade='18'").fetchone())
            w19 = tuple(d_.execute("SELECT w_360, w_tech FROM tc_band_weights WHERE job_grade='19'").fetchone())
        s.check("an old seeded 50 : 50 grade moves to 40 : 60 once; a split an admin saved is never touched",
                w18 == (40.0, 60.0) and w19 == (50.0, 50.0), (w18, w19))
    finally:
        with a.app.test_request_context("/"):
            d_ = a.get_db()
            for jg_, w3, wt, ub in keep:
                d_.execute("UPDATE tc_band_weights SET w_360=?, w_tech=?, updated_by=? WHERE job_grade=?",
                           (w3, wt, ub, jg_))
            d_.commit()
    # -----------------------------------------------------------------------
    s.section("the potential band cutoffs: this cycle's own, beside the weighting (2026-10-11)")
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        ac_ = a.active_cycle(d_)
        keep_c = (ac_["low_max"], ac_["mid_max"]) if ac_ else None
        mx_ = a.max_score_for_grade(d_, 16, ac_["id"]) if ac_ else None
    if not ac_:
        s.check("an active cycle to set cutoffs for", False, "none in the suite database")
    else:
        try:
            for key in ("competency", "f360"):
                code, b = page(sup, "/admin/m/%s/settings" % key)
                s.check("%s settings: the cutoffs card names the running cycle and saves for it" % key, code == 200
                        and 'id="thresholds"' in b and 'value="cycle_cutoffs"' in b and "Save for this cycle" in b and ac_["name"] in b,
                        code)
            code, b = page(sup, "/admin/m/calibration/settings")
            s.check("Calibration & Talent points there instead of holding the cards", code == 200
                    and 'value="cycle_cutoffs"' not in b and "Potential score and bands" in b
                    and "/admin/m/competency/settings" in b, code)
            lo_, mi_ = round(mx_ * 0.3, 1), round(mx_ * 0.7, 1)
            # a ratings record that predates the change, and a frozen one that must never move (2026-10-11)
            with a.app.test_request_context("/"):
                d_ = a.get_db()
                a._rating_record_refresh(d_, ac_["id"], [F1, F2], "test", None, commit=True)
                d_.execute("UPDATE rating_records SET pot_raw_band='ZZ', updated_at='2000-01-01 00:00:00' "
                           "WHERE cycle_id=? AND subject_id=?", (ac_["id"], F1))
                d_.execute("UPDATE rating_records SET pot_raw_band='ZZ', frozen_at='2000-01-01 00:00:00' "
                           "WHERE cycle_id=? AND subject_id=?", (ac_["id"], F2))
                d_.commit()
            r = sup.post("/admin/settings", data={"csrf_token": "tok", "action": "cycle_cutoffs", "low_max": str(lo_),
                                                  "mid_max": str(mi_), "next": "/admin/m/competency/settings#thresholds", "remark": "ZZ test remark (super admin band rule)"})
            with a.app.test_request_context("/"):
                d_ = a.get_db()
                rr1 = d_.execute("SELECT pot_raw_band, updated_at FROM rating_records WHERE cycle_id=? AND subject_id=?",
                                 (ac_["id"], F1)).fetchone()
                rr2 = d_.execute("SELECT pot_raw_band FROM rating_records WHERE cycle_id=? AND subject_id=?",
                                 (ac_["id"], F2)).fetchone()
            s.check("the save brings the running cycle's ratings record up to date at once (it waited for a sign-off)",
                    rr1 and rr1["pot_raw_band"] != "ZZ" and rr1["updated_at"] > "2000-01-01", rr1 and tuple(rr1))
            s.check("...and a frozen record is never rewritten", rr2 and rr2["pot_raw_band"] == "ZZ",
                    rr2 and tuple(rr2))
            with a.app.test_request_context("/"):
                got = tuple(a.get_db().execute("SELECT low_max, mid_max FROM cycles WHERE id=?", (ac_["id"],)).fetchone())
                tfc = a.thresholds_for_cycle(a.get_db(), ac_["id"])
            s.check("saving sets the running cycle's own cutoffs, and bands read them", got == (lo_, mi_)
                    and tfc == (lo_, mi_) and r.headers.get("Location", "").endswith("/admin/m/competency/settings#thresholds"),
                    (got, tfc, r.headers.get("Location")))
            s.check("...and the change is in the audit log with what it was", H.one(
                a, "SELECT COUNT(*) FROM activity_log WHERE action='settings' AND detail LIKE ?",
                ("Potential cutoffs for %s: Low ≤ %g, Mid ≤ %g%%(was%%" % (ac_["name"], lo_, mi_),)) >= 1)
            for bad, why in (({"low_max": str(mi_), "mid_max": str(lo_)}, "Low above Mid"),
                             ({"low_max": "1", "mid_max": str(mx_ + 1)}, "Mid past the maximum"),
                             ({"low_max": "x", "mid_max": "2"}, "not a number")):
                sup.post("/admin/settings", data=dict(bad, csrf_token="tok", action="cycle_cutoffs",
                                                      remark="ZZ test remark (super admin band rule)"))
                with a.app.test_request_context("/"):
                    now_ = tuple(a.get_db().execute("SELECT low_max, mid_max FROM cycles WHERE id=?",
                                                    (ac_["id"],)).fetchone())
                s.check("...%s is refused and nothing changes" % why, now_ == (lo_, mi_), now_)
            r = bga.post("/admin/settings", data={"csrf_token": "tok", "action": "cycle_cutoffs", "low_max": "1",
                                                  "mid_max": "2"})
            with a.app.test_request_context("/"):
                now_ = tuple(a.get_db().execute("SELECT low_max, mid_max FROM cycles WHERE id=?", (ac_["id"],)).fetchone())
            s.check("a BG admin can't set them (super admin only)", r.status_code in (302, 403) and now_ == (lo_, mi_),
                    (r.status_code, now_))
        finally:
            with a.app.test_request_context("/"):
                d_ = a.get_db()
                d_.execute("UPDATE cycles SET low_max=?, mid_max=? WHERE id=?", keep_c + (ac_["id"],))
                d_.commit()

    with a.app.test_request_context("/"):
        idx_ = [r_[1] for r_ in a.get_db().execute("PRAGMA index_list(tc_scores)")]
    s.check("competency scores are indexed by assignment (approved 2026-10-11)", "idx_tc_scores_assignment" in idx_, idx_)
    bare = []
    for root_, _d, fs in os.walk(tdir):
        for f_ in fs:
            if f_.endswith(".html"):
                for line_ in open(os.path.join(root_, f_)).read().splitlines():
                    m_ = re.search(r"(^|[^A-Za-z0-9_.])confirm\(", line_)
                    if m_ and "//" not in line_[:m_.start()] and "{#" not in line_[:m_.start()]:
                        bare.append(f_)   # a comment that mentions confirm() doesn't count
    s.check("no template calls the browser's confirm() at all (page scripts use window.askConfirm)", not bare
            and "window.askConfirm = function" in open(os.path.join(tdir, "base.html")).read(), bare)

    with a.app.test_request_context("/"):
        body_ = a.get_db().execute("SELECT body FROM kb_entries WHERE slug='potential-band'").fetchone()[0]
    s.check("the guide's potential entry says it comes from the 360 and the approved competency", "competency" in body_
            and "your leadership 360 gives a potential rating" not in body_, body_[:80])
    # -----------------------------------------------------------------------
    s.section("the five settings merges (Chris approved, 2026-10-11)")
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        acid_ = a.active_cycle_id(d_)
        keep_w = [tuple(r_) for r_ in d_.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows "
                                                 "WHERE cycle_id=? AND cell IN ('pm_hod','pot_hod')", (acid_,))]
        keep_k = {r_[0]: r_[1] for r_ in d_.execute(
            "SELECT key, value FROM app_settings WHERE key IN ('ai_idp','ai_calib','idp_ai_enabled','calib_assist',"
            "'review_unified_bgs','dept_review_due') OR key LIKE 'succ\\_%' ESCAPE '\\'")}
        d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN ('pm_hod','pot_hod')", (acid_,))
        d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pot_hod', NULL, "
                   "'2031-01-02 10:00')", (acid_,))
        for k_, v_ in (("dept_review_due", "2031-01-01 18:00"), ("idp_ai_enabled", "0"), ("calib_assist", "0"),
                       ("review_unified_bgs", '["X"]'), ("succ_min_bench", "2")):
            d_.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (k_, v_))
        d_.execute("DELETE FROM app_settings WHERE key IN ('ai_idp','ai_calib')")
        d_.commit()
    try:
        a._ensure_runtime_schema()
        with a.app.test_request_context("/"):
            d_ = a.get_db()
            w_ = dict((r_[0], r_[1]) for r_ in d_.execute("SELECT cell, closes_at FROM cycle_windows WHERE cycle_id=? "
                                                         "AND cell IN ('pm_hod','pot_hod')", (acid_,)))
            k_ = {r_[0]: r_[1] for r_ in d_.execute("SELECT key, value FROM app_settings WHERE key IN ('ai_idp','ai_calib',"
                                                     "'idp_ai_enabled','calib_assist','review_unified_bgs',"
                                                     "'dept_review_due','succ_min_bench')")}
            idp_ai = a.get_idp_settings()[3]
            real = a.ai_draft.review_agent_available
            a.ai_draft.review_agent_available = lambda: True
            try:
                calib_ai = a._calib_assist_on({"employee_id": "E1", "id": 0})
            finally:
                a.ai_draft.review_agent_available = real
        s.check("(a) the HOD deadline moves onto the running cycle's HOD rows where it has none, then goes",
                w_.get("pm_hod") == "2031-01-01 18:00" and w_.get("pot_hod") == "2031-01-02 10:00"
                and "dept_review_due" not in k_, (w_, k_))
        s.check("(b) the Career Plan's and the calibration assistant's AI switches join the one store, values kept",
                k_.get("ai_idp") == "0" and k_.get("ai_calib") == "0" and "idp_ai_enabled" not in k_
                and "calib_assist" not in k_ and idp_ai is False and calib_ai is False, (k_, idp_ai, calib_ai))
        s.check("(c) the AI+ pilot list's stored business groups go", "review_unified_bgs" not in k_, k_)
        s.check("(e) Succession's rule keys go", "succ_min_bench" not in k_, k_)
    finally:
        with a.app.test_request_context("/"):
            d_ = a.get_db()
            d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN ('pm_hod','pot_hod')", (acid_,))
            for row_ in keep_w:
                d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", row_)
            d_.execute("DELETE FROM app_settings WHERE key IN ('ai_idp','ai_calib','idp_ai_enabled','calib_assist',"
                       "'review_unified_bgs','dept_review_due','succ_min_bench')")
            for k2, v2 in keep_k.items():
                d_.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (k2, v2))
            d_.commit()
    s.check("(a) nothing reads the old deadline any more", "_setting(\"dept_review_due\"" not in H.source(a))
    code, b = page(sup, "/admin/talent-release")
    s.check("(d) the potential band display switch is on Release results", code == 200 and 'id="band-visibility"' in b
            and 'value="band_visibility"' in b, code)
    code, b = page(sup, "/admin/m/org/settings")
    s.check("...and no longer on Organisation's Settings", code == 200 and 'value="band_visibility"' not in b, code)
    r = sup.post("/admin/settings", data={"csrf_token": "tok", "action": "band_visibility", "show_band": "1"})
    s.check("...its save comes back to Release results", r.headers.get("Location", "").endswith(
        "/admin/talent-release#band-visibility"), r.headers.get("Location"))
    eps = {r_.endpoint for r_ in a.app.url_map.iter_rules()}
    gone = [ep_ for ep_ in ("reward_merit", "reward_bonus", "reward_offcycle", "admin_reward_config",
                            "admin_import_salaries", "succession_home", "succession_candidate", "succession_career_plan",
                            "admin_succession_config") if ep_ in eps]
    tpl_gone = [t_ for t_ in ("reward_merit.html", "succession.html", "settings/_succession.html", "settings/_reward.html",
                              "admin_import_salaries.html") if os.path.exists(os.path.join(tdir, t_))]
    s.check("(e) the archived Succession and Reward pages and templates are deleted", not gone and not tpl_gone,
            (gone, tpl_gone))
    with a.app.test_request_context("/"):
        n_sal = a.get_db().execute("SELECT name FROM sqlite_master WHERE name='reward_salaries'").fetchone()
    s.check("...while Reward's data tables stay (data, not settings)", n_sal is not None)
    r = sup.post("/admin/settings", data={"csrf_token": "tok", "action": "no_such_setting"})
    s.check("an unknown settings action is refused, never read as a thresholds save", r.status_code == 400,
            r.status_code)
    s.section("Add a person: line manager and HOD picked from the people in OneHR (Chris, 2026-10-16)")
    code, b = page(sup, "/admin/users?view=add")
    s.check("the form picks both from the people search, each filling a hidden Employee ID",
            code == 200 and b.count('class="pick" data-pick') == 2 and 'class="pick-val" name="manager_eid"' in b
            and 'class="pick-val" name="hod_eid"' in b, code)
    s.check("...one field tall in the stacked form (a 220px flex basis once made that row 239px)",
            ".pp-fields label > .pick { flex: none; display: flex; width: 100%; min-width: 0; }" in H.source(
                a, "static/style.css"))
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        d_.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, "
                   "left_at) VALUES ('zzac-l1', 'ZZ AC Leaver', 'x', 'user', 'ZZAC-L1', ?, ?, datetime('now'))", (BG, CA))
        d_.commit()

    def add_person(eid, mgr, hod):
        return sup.post("/admin/users", data={"csrf_token": "tok", "action": "add_user", "employee_id": eid,
                                              "full_name": "ZZ AC New " + eid, "business_group": BG, "company": CA,
                                              "manager_eid": mgr, "hod_eid": hod, "joined_date": "2026-10-01"})
    made_ = lambda eid: H.one(a, "SELECT COUNT(*) FROM users WHERE employee_id=?", (eid,)) == 1
    add_person("ZZAC-NEW1", "ZZAC-NOPE", "ZZAC-O1")
    s.check("a line manager OneHR can't find: nobody is added", not made_("ZZAC-NEW1"))
    add_person("ZZAC-NEW2", "ZZAC-O1", "ZZAC-L1")
    s.check("...nor with an HOD who has left", not made_("ZZAC-NEW2"))
    add_person("ZZAC-NEW3", "ZZAC-O1", "ZZAC-F1")
    s.check("...both found and active: added, linked to them", made_("ZZAC-NEW3") and H.one(
        a, "SELECT COUNT(*) FROM users WHERE employee_id='ZZAC-NEW3' AND manager_id=? AND hod_id=?", (O1, F1)) == 1)
finally:
    with a.app.test_request_context("/"):   # put the shared suite database back as this suite found it
        db = a.get_db()
        _cleanup(db)
sys.exit(s.done())
