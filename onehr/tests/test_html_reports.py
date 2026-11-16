"""The on-screen reports (Chris, 2026-10-19: "for report, we should have 2 types, one is the data report like csv export,
another is html report where it comes with BG/BU/department level reporting"; option A of canvas
[design canvas link removed]).

What this suite holds:
  * Reports opens On screen: each module's reports with Open, the report pages it had, and a way to its data; the Data
    downloads tab still lists every download
  * every report opens for the super admin and downloads its view as Excel with an About sheet
  * the levels: all groups -> a group's units -> a unit's departments; Rows are can go further down, never up
  * the numbers, on a group made for the test: the status totals equal the people taking part; the results spread,
    potential, both movements (steps, the tiers that moved), the talent box and its categories, the competency gaps
  * a BG admin sees their own group only, whatever the address asks; a module they can't read is refused
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The on-screen reports: by business group, unit and department")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
from openpyxl import load_workbook  # noqa: E402

SU, _BGA, _E = H.actors(a)
BG = "ZZHR Group"


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9HR-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM tc_scores WHERE assessment_id IN (SELECT id FROM tc_assessments WHERE subject_id IN (%s))"
                   % ph, ul)
        for t in ("rating_records", "talent_releases", "tc_assessments", "tc_assignments", "admin_access"):
            db.execute("DELETE FROM %s WHERE %s IN (%s)" % (t, "admin_id" if t == "admin_access" else "subject_id", ph),
                       ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def book(c, url):
    r = c.get(url)
    if r.status_code != 200:
        return r.status_code, None
    wb = load_workbook(io.BytesIO(r.get_data()), read_only=True)
    return 200, wb


def table(c, url):
    """{row label: {column: value}} of a view's Excel download, and its header."""
    code, wb = book(c, url + ("&" if "?" in url else "?") + "format=xlsx")
    if not wb:
        return {}, []
    rows = [list(r) for r in wb.worksheets[0].iter_rows(values_only=True)]
    head = rows[0]
    return {r[0]: dict(zip(head, r)) for r in rows[1:]}, head


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    cyc = db.execute("SELECT * FROM cycles WHERE is_active=1").fetchone()
    CID = cyc["id"]
    for u in ("ZZHR Unit 1", "ZZHR Unit 2"):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, u))
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                     "VALUES ('zz9hr-bga', 'ZZ HR Groupadmin', 'x', 'admin', 'ZZ9HR-BGA', ?, ?)", (BG, BG)).lastrowid

    def person(eid, unit, dept):
        return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                          "company, department, job_grade, years_of_service) VALUES (?,?, 'x', 'user', ?, ?, ?, ?, "
                          "'14', 5)", (eid.lower(), "ZZ HR " + eid, eid, BG, unit, dept)).lastrowid
    P = person("ZZ9HR-P", "ZZHR Unit 1", "ZZHR Sales")
    Q = person("ZZ9HR-Q", "ZZHR Unit 1", "ZZHR Finance")
    R = person("ZZ9HR-R", "ZZHR Unit 2", "ZZHR Plant")
    # P: performance ME (line manager) -> AE at HOD -> AE at BU CEO -> OU at BG CEO = OU; potential Low -> Mid at BU CEO
    db.execute("INSERT INTO rating_records(cycle_id, subject_id, employee_id, full_name, business_group, company, "
               "department, pm_mgr_band, pm_hod_band, pm_buceo_band, pm_bgceo_band, pm_final_band, pot_raw_band, "
               "pot_buceo_band, pot_final_band) VALUES (?,?, 'ZZ9HR-P', 'x', ?, 'ZZHR Unit 1', 'ZZHR Sales', 'ME', 'AE', "
               "'AE', 'OU', 'OU', 'Low', 'Mid', 'Mid')", (CID, P, BG))
    # Q: ME all the way (no move); potential High
    db.execute("INSERT INTO rating_records(cycle_id, subject_id, employee_id, full_name, business_group, company, "
               "department, pm_mgr_band, pm_final_band, pot_raw_band, pot_final_band) VALUES (?,?, 'ZZ9HR-Q', 'x', ?, "
               "'ZZHR Unit 1', 'ZZHR Finance', 'ME', 'ME', 'High', 'High')", (CID, Q, BG))
    db.execute("INSERT INTO talent_releases(cycle_id, subject_id) VALUES (?,?)", (CID, P))
    # P's competency answers: two competencies reviewed, the line manager says yes to one and no to the other
    # two different competencies (a competency is its code family: two levels of one count as one)
    sk = []
    for r in db.execute("SELECT id, skill_code, title FROM tc_skills ORDER BY id LIMIT 400"):
        if not sk or (a.tc_comp_key(r["skill_code"]) != a.tc_comp_key(db.execute(
                "SELECT skill_code FROM tc_skills WHERE id=?", (sk[0],)).fetchone()[0]) and r["title"] !=
                db.execute("SELECT title FROM tc_skills WHERE id=?", (sk[0],)).fetchone()[0]):
            sk.append(r["id"])
        if len(sk) == 2:
            break
    asm = db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?, 'reviewed')",
                     (CID, P)).lastrowid
    for skid, mgr in zip(sk, ("yes", "no")):
        aid = db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) VALUES (?,?,?)",
                         (CID, P, skid)).lastrowid
        db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer, manager_answer) VALUES (?,?, 'yes', ?)",
                   (asm, aid, mgr))
    SKILLS = {r[0]: r[1] for r in db.execute("SELECT id, title FROM tc_skills WHERE id IN (?,?)", sk)}
    db.commit()
SUP, BAC = H.client_as(a, SU["id"]), H.client_as(a, BGA)
Q_BG = "bg=" + BG.replace(" ", "%20")

try:
    s.section("Reports opens On screen")
    pg = SUP.get("/admin/reports/all").get_data(as_text=True)
    s.check("two tabs: On screen (the one open) and Data downloads", 'class="rep-tab is-on"' in pg and
            "On screen" in pg and "Data downloads" in pg and "kind=data" in pg)
    # Grade H's two (2026-11-04) are listed only where Grade H is on and open on a Grade H people source: test_gradeh_reports holds them;
    # here, on a server where it is dark, they must be absent
    PLAIN = [r for r in a.HTML_REPORTS if r[1] not in a._HR_GH_KEYS]
    s.check("every on-screen report is listed with Open", all("/admin/reports/all/%s" % r[1] in pg for r in PLAIN))
    s.check("...and a server with Grade H dark lists neither of Grade H's", not a.gradeh_on() and not any(
        "/admin/reports/all/%s" % k in pg for k in a._HR_GH_KEYS))
    s.check("...with the report pages the modules had (Results analysis, Rater extremes, Ratings record)",
            "/admin/reports\"" in pg and "Rater extremes" in pg and "Ratings record" in pg)
    s.check("...and each module's way to its data", pg.count("kind=data#data-") >= 4)
    dt = SUP.get("/admin/reports/all?kind=data").get_data(as_text=True)
    s.check("the Data downloads tab still lists every download (%d)" % len(a.ADMIN_REPORTS),
            dt.count('class="adm-rep-dl"') >= len(a.ADMIN_REPORTS) and "Open &rsaquo;" not in dt)
    s.check("every report has its builder and its module",
            all(r[1] in a._HR_BUILD and a._access_page_module("admin_report_view", {"key": r[1]})
                == a._HR_SECTION_MODULE[r[0]] for r in a.HTML_REPORTS))
    s.check("...and Grade H's own are not open on a dark server, even to the super admin",
            all(SUP.get("/admin/reports/all/%s" % k).status_code == 404 for k in a._HR_GH_KEYS))

    s.section("each opens, and downloads its view")
    for sec, key, title, _w in PLAIN:
        r = SUP.get("/admin/reports/all/%s" % key)
        b = r.get_data(as_text=True)
        code, wb = book(SUP, "/admin/reports/all/%s?format=xlsx" % key)
        s.check("%s: the page and its Excel (%s, About)" % (key, title), r.status_code == 200 and title in b
                and "Download this view" in b and code == 200 and [w.title for w in wb.worksheets][-1] == "About",
                (r.status_code, code))

    s.section("the levels")
    rows, head = table(SUP, "/admin/reports/all/pm-status")
    with a.app.test_request_context("/"):
        shown = a.display_bg(BG)
    s.check("all groups: rows are business groups, our group among them", head[:1] == ["Business group"]
            and shown in rows, list(rows)[:3])
    rows, head = table(SUP, "/admin/reports/all/pm-status?" + Q_BG)
    s.check("a group: rows are its units", head[0] == "Business unit" and {"ZZHR Unit 1", "ZZHR Unit 2"} <= set(rows), rows.keys())
    rows, head = table(SUP, "/admin/reports/all/pm-status?%s&bu=ZZHR%%20Unit%%201" % Q_BG)
    s.check("a unit: rows are its departments", head[0] == "Department" and set(rows) - {"Total"} ==
            {"ZZHR Sales", "ZZHR Finance"}, rows.keys())
    rows, head = table(SUP, "/admin/reports/all/pm-status?%s&rows=dept" % Q_BG)
    s.check("Rows are can go further down: a group's departments",
            head[0] == "Department" and {"ZZHR Sales", "ZZHR Finance", "ZZHR Plant"} <= set(rows))
    rows, head = table(SUP, "/admin/reports/all/pm-status?%s&rows=bg" % Q_BG)
    s.check("...never up: inside a group, rows=bg still shows its units", head[0] == "Business unit")
    pgu = SUP.get("/admin/reports/all/pm-status?" + Q_BG).get_data(as_text=True)
    s.check("a unit's row goes down to it, and the path goes back to all groups",
            ("bu=ZZHR+Unit+1" in pgu or "bu=ZZHR%20Unit%201" in pgu) and ">All groups</a>" in pgu)

    s.section("the numbers, on the test group")
    rows, _h = table(SUP, "/admin/reports/all/pm-status?" + Q_BG)
    s.check("status: our three people take part (U1 two, U2 one, total three)",
            rows.get("ZZHR Unit 1", {}).get("Taking part") == 2 and rows.get("ZZHR Unit 2", {}).get("Taking part") == 1
            and rows.get("Total", {}).get("Taking part") == 3, rows)
    with a.app.test_request_context("/"):
        n_all = a.get_db().execute("SELECT COUNT(*) FROM users WHERE role!='admin' AND COALESCE(left_at,'')='' AND "
                                   "COALESCE(is_demo,0)=0 AND " + a.participant_sql()).fetchone()[0]
    rows, _h = table(SUP, "/admin/reports/all/tc-status")
    s.check("the whole total is everyone taking part (%d), the groups adding up to it" % n_all,
            rows.get("Total", {}).get("Taking part") == n_all and
            sum(v["Taking part"] for k, v in rows.items() if k != "Total") == n_all, rows.get("Total"))
    rows, _h = table(SUP, "/admin/reports/all/pm-results?" + Q_BG)
    u1 = rows.get("ZZHR Unit 1", {})
    s.check("results: U1's final bands are one OU and one ME", u1.get("Rated") == 2 and u1.get("Final band: OU") == 1
            and u1.get("Final band: ME") == 1 and u1.get("AE + OU %") == 50, u1)
    rows, _h = table(SUP, "/admin/reports/all/pm-results?%s&band=lm" % Q_BG)
    s.check("...the line manager's: both ME", rows.get("ZZHR Unit 1", {}).get("Line manager's band: ME") == 2,
            rows.get("ZZHR Unit 1"))
    rows, _h = table(SUP, "/admin/reports/all/pm-movement?" + Q_BG)
    u1 = rows.get("ZZHR Unit 1", {})
    s.check("performance movement: U1 two calibrated, one up, none down, one unchanged",
            u1.get("Calibrated") == 2 and u1.get("Moved up") == 1 and u1.get("Moved down") == 0
            and u1.get("Unchanged") == 1, u1)
    s.check("...moved at the HOD and the BG CEO, not the BU CEO (it held AE); net +2",
            u1.get("At HOD") == 1 and u1.get("At BG CEO") == 1 and u1.get("At BU CEO") == 0
            and u1.get("Net steps") == 2, u1)
    rows, _h = table(SUP, "/admin/reports/all/pot-movement?" + Q_BG)
    u1 = rows.get("ZZHR Unit 1", {})
    s.check("potential movement: one up a step at the BU CEO", u1.get("Moved up") == 1 and u1.get("At BU CEO") == 1
            and u1.get("Net steps") == 1, u1)
    rows, _h = table(SUP, "/admin/reports/all/potential?" + Q_BG)
    u1 = rows.get("ZZHR Unit 1", {})
    s.check("potential: U1 one Mid, one High", u1.get("Placed") == 2 and u1.get("Potential band: Mid") == 1
            and u1.get("Potential band: High") == 1 and u1.get("High %") == 50, u1)
    rows, _h = table(SUP, "/admin/reports/all/talent?" + Q_BG)
    u1, u2 = rows.get("ZZHR Unit 1", {}), rows.get("ZZHR Unit 2", {})
    cat_p, cat_q = a.talent_category("OU", "Mid"), a.talent_category("ME", "High")
    s.check("talent: U1 holds the two cells its bands make; U2 none placed", u1.get(cat_p) == (2 if cat_p == cat_q
            else 1) and u1.get(cat_q) >= 1 and u1.get("Not placed") == 0 and u2.get("Not placed") == 1, (u1, u2))
    s.check("...released: one", u1.get("Released") == 1, u1)
    tp = SUP.get("/admin/reports/all/talent?" + Q_BG).get_data(as_text=True)
    s.check("...and the page draws the talent box for the group (2 placed of 3)", "2 placed of 3" in tp)
    rows, head = table(SUP, "/admin/reports/all/tc-gaps?%s&bu=ZZHR%%20Unit%%201" % Q_BG)
    names = [k for k in rows]
    yes_t, no_t = SKILLS[sk[0]], SKILLS[sk[1]]
    s.check("competency gaps: rows are competencies, the one not met first", head[0] == "Competency" and len(rows) == 2
            and names[0].startswith(no_t) and rows[names[0]]["Not yet"] == 1 and rows[names[1]]["Meet"] == 1,
            (head[:1], names))

    s.section("scope and access")
    pb = BAC.get("/admin/reports/all/pm-status?bg=SOMEONE%20ELSE").get_data(as_text=True)
    rows, head = table(BAC, "/admin/reports/all/pm-status?bg=SOMEONE%20ELSE")
    s.check("a BG admin starts in their own group, whatever the address asks",
            head[:1] == ["Business unit"] and set(rows) - {"Total"} == {"ZZHR Unit 1", "ZZHR Unit 2"} and ">All groups<" not in pb,
            list(rows))
    with a.app.app_context():
        # a role without Calibration's pages (Roles & access, 2026-10-20): its own, so no real BG admin changes
        _d = a.get_db()
        _rid = _d.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZHR no calibration', 'group')").lastrowid
        _d.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)",
                       [(_rid, k) for k in a.role_preset_items("view") if k != "calibration.read"])
        _d.execute("UPDATE users SET admin_role_id=? WHERE id=?", (_rid, BGA))
        _d.commit()
    r = BAC.get("/admin/reports/all/talent")
    s.check("a module they can't read is refused (to Home)", r.status_code == 302, r.status_code)
    hub = BAC.get("/admin/reports/all").get_data(as_text=True)
    s.check("...and Reports doesn't offer it", "/admin/reports/all/talent" not in hub
            and "/admin/reports/all/pm-status" in hub)
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)
        _db.execute("DELETE FROM admin_roles WHERE name='ZZHR no calibration'")
        _db.commit()

sys.exit(s.done())
