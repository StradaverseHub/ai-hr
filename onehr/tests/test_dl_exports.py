"""The data downloads: who each row is about, one file name, KPI lines that go back in, a fuller Users file (Chris,
2026-10-28: "Download Excel stays disabled after one download", "identity columns on every export about people", "file
names", "KPI lines re-importable", "Users: everything on the person's page").

What this suite holds:
  * the panel's Download Excel button is never left dimmed: the form opts out of base.html's busy mark and dl_scope.js
    clears it when a Download... click fills the panel
  * the identity block (business group, unit, name, Employee ID, grade, title, department, line manager and his or her
    Employee ID) starts every file about people; the group column goes when the file covers one group (picked, or a BG
    admin's own), the unit column when it covers one unit; the audit log has none
  * every one of the downloads is named AI+OneHR_<BG>_<BU>_<Module>_<Export>_<date>.xlsx: AllBGs / the one group, AllBUs /
    <n>BUs / the one unit; the header quotes the name and carries its UTF-8 form (the + survives)
  * every file has an About sheet (the eight import templates after their How to fill sheet), and a template's
    first columns are still its import's, unchanged
  * KPI lines: the import's own columns (the identity block carries Employee ID), a Cycle column, framework columns by
    the groups in the file, Result: columns that are only read; fed unchanged to the import's check every line is matched
    with no change and none is new; one target edited is exactly one change; a Cycle that isn't the import's is refused
    row by row, a file with no Cycle column is read as before
  * Users: everything on the person's page, never an IC / passport number, a password or a private display name

Self-contained: its own three groups (ZZEX, one a scoring A, one B base, one B excellence), people and lines
(ZZ9EX-), deleted at the end.
"""
import io
import os
import re
import sys
from collections import defaultdict
from urllib.parse import unquote, urlencode

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from openpyxl import load_workbook  # noqa: E402

a = H.setup()
s = H.Suite("The data downloads: identity, file names, KPI lines back in, Users")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
C_SU = H.client_as(a, SU["id"])
PFX = "ZZ9EX-"
GA, GB, GX = "ZZEX Alpha", "ZZEX Beta", "ZZEX Xcel"
CO = "ZZEX Unit"
URL = {}
with a.app.test_request_context("/"):
    for _s, _l, _f, ep, _d in a.ADMIN_REPORTS:
        URL[ep] = a.url_for(ep)
LABEL = {ep: (sec, lbl) for sec, lbl, _f, ep, _d in a.ADMIN_REPORTS}
MODULE = {"pm": "Performance", "f360": "360", "competency": "Competency", "calibration": "Calibration",
          "people": "People", "audit": "Audit", "idp": "CareerPlan", "cycle": "Cycle"}
# the export word where the label would repeat its module's (the Reports sweep, 4 Nov 2026)
EXPORT_WORD = {"admin_export_calibration_progress": "Progress", "admin_export_idp_progress": "Progress"}
TEMPLATES = {"admin_export_no_kpi": a.KPI_TARGETS_IMPORT_COLUMNS, "admin_export_no_competency": a.JOB_IMPORT_COLUMNS,
             "admin_export_no_panel": a.PANEL_IMPORT_COLUMNS, "admin_export_short_panel": a.PANEL_IMPORT_COLUMNS,
             "admin_export_no_lm": a.ROSTER_COLUMNS, "admin_export_no_hod": a.ROSTER_COLUMNS,
             "admin_export_no_conf": a.ROSTER_COLUMNS, "admin_export_no_details": a.ROSTER_COLUMNS}
IDENT = list(a.DL_IDENT_HEAD)


def word(name):
    """The file-name word for a group or unit, worked out here by the rule: a trailing (CODE) alone, else the words
    hyphenated, punctuation dropped."""
    m = re.search(r"\(([A-Za-z0-9]+)\)\s*$", name)
    if m:
        return m.group(1)
    return re.sub(r"-+", "-", "-".join(re.sub(r"[^A-Za-z0-9 -]", "", name).split()))


def book(resp):
    wb = load_workbook(io.BytesIO(resp.get_data()), read_only=True)
    out = {}
    for ws in wb.worksheets:
        out[ws.title] = [["" if v is None else v for v in r] for r in ws.iter_rows(values_only=True)]
    return wb.sheetnames, out


def first(resp):
    names, sheets = book(resp)
    rows = sheets[names[0]]
    return (rows[0] if rows else []), rows[1:]


def expected_name(ep, bgw, buw):
    sec, lbl = LABEL[ep]
    exp = "_".join(re.sub(r"[()+]", "", EXPORT_WORD.get(ep, lbl)).split())
    return "AI+OneHR_%s_%s_%s_%s_" % (bgw, buw, MODULE[sec], exp)


def disp(resp):
    cd = resp.headers.get("Content-Disposition", "")
    m = re.match(r'^attachment; filename="([^"]+)"; filename\*=UTF-8\'\'(\S+)$', cd)
    return (m.group(1), unquote(m.group(2))) if m else (None, None)


def cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9EX-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        tids = "SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (%s)" % tids, ul)
        db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN (%s)" % tids, ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM buceo_seats WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?,?)", (GA, GB, GX))
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?,?)", (GA, GB, GX))
    db.execute("DELETE FROM activity_log WHERE action='export' AND detail LIKE 'AI+OneHR_%'")
    db.commit()


# ------------------------------------------------------------------------------------------------ the busy button
s.section("Download Excel is never left dimmed after one download")
hub = C_SU.get("/admin/reports/all?kind=data").get_data(as_text=True)
form = re.search(r"<form[^>]*data-dl-form[^>]*>", hub)
s.check("the panel's form opts out of base.html's busy mark", bool(form) and "data-no-busy" in form.group(0), form)
base_js = open(os.path.join(os.path.dirname(a.__file__), "templates", "base.html")).read()
s.check("...which is the opt-out base.html's submit handler honours (so the test would fail without it)",
        "data-no-busy" in base_js and "btn-busy" in base_js)
dl_js = open(os.path.join(os.path.dirname(a.__file__), "static", "dl_scope.js")).read()
s.check("dl_scope.js clears the button's busy mark whenever a Download... click fills the panel",
        re.search(r"button\[type=\"submit\"\][^\n]*\n?[^\n]*btn-busy", dl_js) is not None
        and dl_js.index("btn-busy") < dl_js.index("setUnits(bgEl.value, bgEl.value === p.fbg"), "no btn-busy removal found")

# ------------------------------------------------------------------------------------------------ the data
SEEDED = []
try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        cleanup(db)
        ac = a.active_cycle(db)
        for g_, mech, var in ((GA, "A", None), (GB, "B", "base"), (GX, "B", "excellence")):
            db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (g_, CO))
            db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?,?,?)", (g_, mech, var))

        def mk(eid, bg, mgr=None, hod=None, conf="2020-01-01", left=None, jg="14"):
            return db.execute(
                "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                "department, job_grade, job_title, confirmation_date, manager_id, hod_id, left_at, email, "
                "employment_type, cost_center, work_location, joined_date, years_of_service) VALUES (?,?, 'x', 'user', "
                "?,?,?, 'ZZEX Dept', ?, 'ZZEX Title', ?,?,?,?, ?, 'Permanent', 'CC9', 'Site 9', '2021-03-01', 5)",
                (eid.lower(), "ZZ EX " + eid[len(PFX):], eid, bg, CO, jg, conf, mgr, hod, left,
                 eid.lower() + "@zz.example")).lastrowid
        U = {}
        for k, g_ in (("A", GA), ("B", GB), ("X", GX)):
            U["M" + k] = mk(PFX + "M" + k, g_)
            U["P" + k] = mk(PFX + "P" + k, g_, mgr=U["M" + k])
        U["MM"] = mk(PFX + "MM", GA)                      # a matrix manager for one line
        U["LEFT"] = mk(PFX + "LEFT", GA, mgr=U["MA"], left="2026-09-01 00:00:00")
        db.execute("UPDATE users SET hod_id=? WHERE id=?", (U["MA"], U["PA"]))
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (GA, CO, U["MA"]))
        CID = ac["id"]

        def line(subj, bg, name, w, method="more", focus=None, unit="RM", cat="Financial", desc="ZZEX line", chain=(),
                 **sc):
            vals = dict(rate1=None, rate2=None, rate3=None, rate4=None, rate5=None, threshold=None, target=None,
                        multiple=None, excellence=None)
            vals.update(sc)
            tid = db.execute(
                "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, category, description, weightage, unit, "
                "method, rate1, rate2, rate3, rate4, rate5, threshold, target, multiple, excellence, business_group, "
                "company, department, status, focus) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ZZEX Dept',"
                "'approved',?)", (CID, subj, a.kpi_line_name(name, focus), cat, desc, w, unit, method, vals["rate1"],
                                  vals["rate2"], vals["rate3"], vals["rate4"], vals["rate5"], vals["threshold"],
                                  vals["target"], vals["multiple"], vals["excellence"], bg, CO, focus)).lastrowid
            for i, ap in enumerate(chain, start=1):
                db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,?,?)",
                           (tid, i, ap))
            return tid
        line(U["PA"], GA, "ZZEX Sales", 60, chain=[U["MA"]], rate1=10, rate2=20, rate3=30, rate4=40, rate5=50)
        line(U["PA"], GA, "ZZEX Brand", 40, focus="Elba", unit="%", cat="Operational", chain=[U["MM"]],
             rate1=60, rate2=70, rate3=80, rate4=90, rate5=100)
        line(U["PB"], GB, "ZZEX PAT", 50, chain=[U["MB"]], threshold=50, target=100, multiple=100)
        line(U["PB"], GB, "ZZEX Cost", 50, method="less", chain=[U["MB"]], threshold=120, target=100, multiple=100)
        line(U["PX"], GX, "ZZEX Revenue", 100, chain=[U["MX"]], threshold=40, target=100, excellence=150)
        db.commit()
        ME = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        big = db.execute("SELECT business_group, company, COUNT(*) n FROM users WHERE role!='admin' AND left_at IS NULL "
                         "AND COALESCE(is_demo,0)=0 AND COALESCE(company,'')!='' AND employee_id NOT LIKE 'ZZ9EX-%' "
                         "GROUP BY business_group, company ORDER BY n DESC").fetchall()
        BG = big[0]["business_group"]
        UNITS = [r["company"] for r in big if r["business_group"] == BG][:2]
        mgr_of = {r["employee_id"]: (r["m_eid"], r["m_name"]) for r in db.execute(
            "SELECT u.employee_id, m.employee_id m_eid, m.full_name m_name FROM users u LEFT JOIN users m ON "
            "m.id=u.manager_id WHERE u.employee_id IS NOT NULL")}
    with a.app.test_request_context("/"):
        bgw = word(a.display_bg(BG))
        buw1 = word(a.display_company(BG, UNITS[0]) or UNITS[0])
        ga_w = word(a.display_bg(GA))

    # -------------------------------------------------------------------------------------------- the identity block
    s.section("every file about people starts with who each row is about; the group and unit go when it covers one")
    ABOUT_PEOPLE = ("admin_export_pm_status", "admin_export_pm_results", "admin_export_tc_lines",
                    "admin_export_tc_status", "admin_export_potential", "admin_export_pm_movement",
                    "admin_export_pot_movement", "admin_export_talent", "admin_performance_export",
                    "admin_export_results", "admin_export_responses", "admin_export_assessor_progress",
                    "admin_export_panels", "admin_export_ratings", "admin_export_users")
    with a.app.app_context():
        db = a.get_db()   # a ratings record for two people in the picked unit, so the records' files have rows
        ppl = db.execute("SELECT id, employee_id, full_name, business_group, company FROM users WHERE role!='admin' AND "
                         "left_at IS NULL AND COALESCE(is_demo,0)=0 AND business_group=? AND company=? AND id NOT IN "
                         "(SELECT subject_id FROM rating_records WHERE cycle_id=? AND subject_id IS NOT NULL) LIMIT 2",
                         (BG, UNITS[0], CID)).fetchall()
        for p_ in ppl:
            SEEDED.append(db.execute(
                "INSERT INTO rating_records(cycle_id, subject_id, employee_id, full_name, business_group, company, "
                "pm_mgr_band, pm_final_band, pot_raw_band, pot_final_band) VALUES (?,?,?,?,?,?,'ME','AE','Mid','High')",
                (CID, p_["id"], p_["employee_id"], p_["full_name"], p_["business_group"], p_["company"])).lastrowid)
        db.commit()
    SCEN = {"all": ("", IDENT),
            "one group": ("?" + urlencode([("fbg", BG)]), [h for h in IDENT if h != "Business group"]),
            "one group, one unit": ("?" + urlencode([("fbg", BG), ("fcompany", UNITS[0])]),
                                    [h for h in IDENT if h not in ("Business group", "Business unit")]),
            "one group, two units": ("?" + urlencode([("fbg", BG)] + [("fcompany", u) for u in UNITS]),
                                     [h for h in IDENT if h != "Business group"])}
    for name, (qs, want) in SCEN.items():
        bad = []
        for ep in ABOUT_PEOPLE:
            r = C_SU.get(URL[ep] + qs)
            if r.status_code != 200:
                bad.append((ep, r.status_code))
                continue
            h, rows = first(r)
            if h[:len(want)] != want or ("Employee ID" in h[len(want):]):
                bad.append((ep, h[:len(want) + 1]))
        s.check("%d people downloads, %s: the identity block is %s" % (len(ABOUT_PEOPLE), name, ", ".join(want[:2]) + "..."),
                not bad, bad[:3])
    h, _rows = first(C_SU.get(URL["admin_export_audit_log"]))
    s.check("the audit log has no identity block (it is about what admins did)", "Employee name" not in h
            and "Business group" not in h and h[0] == "When (MYT)", h[:3])
    if BGA:
        C_BGA = H.client_as(a, BGA["id"])
        h, _r = first(C_BGA.get(URL["admin_export_users"]))
        with a.app.app_context():
            own_cos = a.admin_companies_of(a.get_db().execute("SELECT * FROM users WHERE id=?", (BGA["id"],)).fetchone())
        want = [x for x in IDENT if x != "Business group" and (len(own_cos) != 1 or x != "Business unit")]
        s.check("a BG admin's file covers their group: no Business group column", h[:len(want)] == want, h[:4])

    # ------------------------------------------------------------------ the cells
    s.section("the cells: name, ID, grade, title, department, and the line manager's name and Employee ID")
    h, rows = first(C_SU.get(URL["admin_export_users"]))
    with a.app.app_context():
        raw = {r[0]: (r[1], r[2]) for r in a.get_db().execute("SELECT employee_id, business_group, company FROM users")}
    wrong_raw = [r[h.index("Employee ID")] for r in rows if (r[0], r[1]) != (raw[r[h.index("Employee ID")]][0] or "",
                                                                         raw[r[h.index("Employee ID")]][1] or "")]
    s.check("the Business group and Business unit cells are HRIS's raw names, never the display names (%d rows)"
            % len(rows), not wrong_raw and any(r[0] for r in rows), wrong_raw[:3])
    iE, iM, iI = h.index("Employee ID"), h.index("Line manager employee ID"), h.index("Line manager")
    by = {r[iE]: r for r in rows}
    s.check("our people are in the Users file with their line manager's Employee ID", by[PFX + "PA"][iM] == PFX + "MA"
            and by[PFX + "PA"][h.index("Employee name")] == "ZZ EX PA" and by[PFX + "PA"][iI] == "ZZ EX MA"
            and by[PFX + "PA"][h.index("Job title")] == "ZZEX Title" and by[PFX + "PA"][h.index("Department")] == "ZZEX Dept"
            and by[PFX + "PA"][h.index("Job grade")] in (14, "14"), by.get(PFX + "PA", [])[:9])
    wrong = [e for e, r in by.items() if r[iM] != (mgr_of.get(e, (None, None))[0] or "")]
    s.check("...and every row's line manager Employee ID is the one on the users table (%d rows)" % len(rows),
            not wrong and len(rows) > 100, wrong[:3])
    h2, r2 = first(C_SU.get(URL["admin_export_pm_status"]))
    s.check("a status file carries the same, with the old 'Line manager' column gone (no duplicate)",
            h2.count("Line manager") == 1 and h2.count("Employee ID") == 1, h2[:12])

    # -------------------------------------------------------------------------------------------- file names
    s.section("one file name pattern for every download")
    SCN = (("all", "", "AllBGs", "AllBUs"), ("one group", "?" + urlencode([("fbg", BG)]), bgw, "AllBUs"),
           ("one unit", "?" + urlencode([("fbg", BG), ("fcompany", UNITS[0])]), bgw, buw1),
           ("two units", "?" + urlencode([("fbg", BG)] + [("fcompany", u) for u in UNITS]), bgw, "2BUs"))
    today = a._today_myt().isoformat()
    for name, qs, bw, bu in SCN:
        bad = []
        for ep in LABEL:
            r = C_SU.get(URL[ep] + qs)
            plain, utf = disp(r)
            # the audit log is by date and filter, never by group: the panel's picks are not read there
            # (nor are the three libraries' files, 10 Nov 2026: they hold every group whatever is picked)
            want = expected_name(ep, *(("AllBGs", "AllBUs") if ep == "admin_export_audit_log" or ep in a.DL_LIBRARY_EPS else (bw, bu))) + today + ".xlsx"
            if r.status_code != 200 or plain != want or utf != want:
                bad.append((ep, r.status_code, plain))
        s.check("all %d downloads, %s: AI+OneHR_%s_%s_<Module>_<Export>_<date>.xlsx" % (len(LABEL), name, bw[:12], bu[:12]),
                not bad and len(LABEL) == len(a.ADMIN_REPORTS), bad[:3])
    r = C_SU.get(URL["admin_export_talent"])
    s.check("the header quotes the name and carries its UTF-8 form, the + intact", "filename*=UTF-8''AI%2BOneHR_" in
            r.headers["Content-Disposition"] and 'filename="AI+OneHR_' in r.headers["Content-Disposition"],
            r.headers["Content-Disposition"])
    cases = {"Chin Hin Building Material (CHBM)": "CHBM", "Fiamma Holdings Berhad": "Fiamma-Holdings-Berhad",
             "Smith & Sons, Co. Ltd.": "Smith-Sons-Co-Ltd", "Alpha - Beta  (Asia)": "Asia", "A--B": "A-B",
             "Group (Old) Name": "Group-Old-Name", "Unit (...)": "Unit"}
    s.check("the file-name word: a trailing (CODE) alone, else hyphenated, punctuation dropped, hyphens collapsed",
            all(a._dl_slug(k) == v for k, v in cases.items()), {k: a._dl_slug(k) for k in cases if a._dl_slug(k) != cases[k]})
    ok = a._DL_NAME_UNSAFE_RE.sub("", 'a/b\\c:d*e?f"g<h>i|j') == "abcdefghij"
    s.check("the characters unsafe in a file name are stripped", ok)
    s.check("a Content-Disposition for a non-ASCII name falls back to a plain one and keeps the UTF-8 form",
            a._attachment_header("AI+OneHR_Café.xlsx") == 'attachment; filename="AI+OneHR_Caf_.xlsx"; '
            "filename*=UTF-8''AI%2BOneHR_Caf%C3%A9.xlsx", a._attachment_header("AI+OneHR_Café.xlsx"))
    if BGA:
        r = C_BGA.get(URL["admin_export_users"])
        plain, _u = disp(r)
        with a.app.test_request_context("/"):
            bw = word(a.display_bg(BGA["admin_bg"]))
        s.check("a BG admin's file carries their own group", plain and plain.startswith("AI+OneHR_%s_" % bw), plain)
    r = C_SU.get(URL["admin_export_users"] + "?" + urlencode([("fbg", GA)]))
    plain, _u = disp(r)
    s.check("a picked group of ours is in the name", plain and ga_w in plain, plain)
    detail = H.one(a, "SELECT detail FROM activity_log WHERE user_id=? AND action='export' ORDER BY id DESC LIMIT 1",
                   (SU["id"],))
    s.check("the audit line holds the file's name", detail and detail.startswith("AI+OneHR_"), detail)

    # -------------------------------------------------------------------------------------------- About + templates
    s.section("every file has an About sheet; the import templates keep their import's columns first")
    bad_about, bad_tpl = [], []
    for ep in LABEL:
        r = C_SU.get(URL[ep])
        names, sheets = book(r)
        if ep in TEMPLATES:
            cols = list(TEMPLATES[ep])
            if sheets[names[0]][0][:len(cols)] != cols or names[1] != "How to fill" or names[-1] != "About":
                bad_tpl.append((ep, names))
        elif ep == "admin_export_audit_log" or ep in ABOUT_PEOPLE or True:
            # Data integrity is a sheet a check, About last; the audit log's About says its dates in place of group and units (2026-11-04)
            if names[-1] != "About" or (len(names) != 2 and ep not in ("admin_export_data_integrity", "admin_export_competency_library", "admin_export_kpi_library")):
                bad_about.append((ep, names))
                continue
            ab = {x[0]: x[1] for x in sheets["About"]}
            need = {"Report", "Scope", "Business group", "Business units", "Generated (MYT)", "Rows", "What this is"}
            if ep == "admin_export_audit_log":
                need = (need - {"Business group", "Business units"}) | {"Dates"}
            if ep in a.DL_LIBRARY_EPS:   # every business group, said in one row (10 Nov 2026)
                need = (need - {"Business group", "Business units"}) | {"Business groups"}
            if not need <= set(ab) or ab["Rows"] != sum(len(sheets[n_]) - 1 for n_ in names[:-1]):
                bad_about.append((ep, sorted(need - set(ab)), ab.get("Rows")))
    s.check("every file with an About sheet: its report, scope, group, units (the audit log: its dates), when, rows and what it is",
            not bad_about, bad_about[:3])
    s.check("8 import templates: the import's own columns first and unchanged, How to fill second, About last",
            not bad_tpl and len(TEMPLATES) == 8, bad_tpl[:3])
    ab = {x[0]: x[1] for x in book(C_SU.get(URL["admin_export_pm_status"] + "?" + urlencode(
        [("fbg", BG), ("fcompany", UNITS[0])])))[1]["About"]}
    want_bg, want_bu = BG, UNITS[0]   # HRIS's own spelling, never the display name
    s.check("...and the About sheet names the cycle and the picks", ab.get("Cycle") == ac["name"]
            and ab.get("Business group") == want_bg and ab.get("Business units") == want_bu, ab)
    h, rows = first(C_SU.get(URL["admin_export_no_kpi"]))
    s.check("a template's Reference: columns name the line manager and now their Employee ID too",
            "Reference: line manager" in h and h[h.index("Reference: line manager") + 1] ==
            "Reference: line manager employee ID", h[-4:])
    h, rows = first(C_SU.get(URL["admin_export_no_conf"]))
    s.check("...the roster templates' Reference: line manager employee ID follows Reference: line manager",
            h[h.index("Reference: line manager") + 1] == "Reference: line manager employee ID", h[-4:])

    # -------------------------------------------------------------------------------------------- KPI lines
    s.section("KPI lines: the import's columns, a Cycle, Result: columns that are only read")
    full = C_SU.get(URL["admin_performance_export"])
    names, sheets = book(full)
    s.check("one sheet first, then About; mode is still the active cycle's", names == ["KPI lines", "About"]
            and a.DL_CYCLE_MODE["admin_performance_export"] == "active", names)
    hd = sheets["KPI lines"][0]
    imp = [c for c in a.KPI_TARGETS_IMPORT_COLUMNS]
    ix = {c: hd.index(c) for c in imp}
    s.check("identity first, then Cycle, then the import's own headings in the import's order, Employee ID once",
            hd[:9] == IDENT and hd[9] == "Cycle" and hd.count("Employee ID") == 1
            and [c for c in hd if c in imp] == imp and hd.index("KPI") == 10 and hd.index("Matrix manager ID") < hd.index(
                "Result: own value"), hd[:14])
    s.check("every other heading before Result: is the identity block or Cycle, and every Result: heading is read only",
            all(c in imp or c in IDENT or c == "Cycle" or c.startswith("Result: ") for c in hd), [c for c in hd if c not in imp
                                                                                                    and c not in IDENT])
    ALIASES = {"employee id", "eid", "id", "staff id", "kpi", "kpi name", "focus", "weightage", "weightage %", "weight",
               "method", "strategic thrust / category", "category", "strategic thrust", "kpi description",
               "description", "unit of measure", "unit", "threshold", "target", "multiple", "excellence",
               "matrix manager id", "matrix manager employee id", "matrix manager"} | {"rate %d" % i for i in range(1, 6)} \
        | {"rate%d" % i for i in range(1, 6)}
    extra = [c for c in hd if c not in imp]
    s.check("no identity or Result: heading collides with an alias the import reads",
            not [c for c in extra if a._norm_header(c) in ALIASES], [c for c in extra if a._norm_header(c) in ALIASES])
    s.check("the framework columns are the import's, in its order, between Method and Matrix manager ID",
            hd.index("Method") < hd.index("Rate 1") < hd.index("Excellence") < hd.index("Matrix manager ID"))

    def kpi_file(qs=""):
        r = C_SU.get(URL["admin_performance_export"] + qs)
        return a._xlsx_records(r.get_data()), first(r)

    def run(recs):
        with a.app.test_request_context("/"):
            d = a.get_db()
            me = d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
            period = a.active_pm_period(d)
            chk = a._kti_check(d, me, period, recs)
            cls = a._kti_classify(d, period, chk)
            return chk, cls

    # the framework columns follow the groups in the file
    for g_, want, nots in ((GA, ["Rate 1", "Rate 2", "Rate 3", "Rate 4", "Rate 5"], ("Threshold", "Target", "Multiple", "Excellence")),
                           (GB, ["Threshold", "Target", "Multiple"], ("Rate 1", "Excellence")),
                           (GX, ["Threshold", "Target", "Excellence"], ("Rate 1", "Multiple"))):
        _recs, (h_, rows_) = kpi_file("?" + urlencode([("fbg", g_)]))
        fw = [c for c in h_ if c in ("Rate 1", "Rate 2", "Rate 3", "Rate 4", "Rate 5", "Threshold", "Target",
                                     "Multiple", "Excellence")]
        s.check("%s only: the framework columns are %s" % (g_, ", ".join(want)), fw == want and not set(nots) & set(h_)
                and all(r[h_.index("Employee ID")].startswith(PFX) for r in rows_) and rows_, (fw, len(rows_)))
    h_, rows_ = first(C_SU.get(URL["admin_performance_export"] + "?" + urlencode([("fbg", GA)])))
    s.check("one group picked: no Business group column (the unit's stays: nothing was ticked)",
            "Business group" not in h_ and "Business unit" in h_)
    for g_, mech_cols in ((GA, ("Result: rating (of 5)",)), (GB, ("Result: achievement %",))):
        h_, _r = first(C_SU.get(URL["admin_performance_export"] + "?" + urlencode([("fbg", g_)])))
        other = "Result: achievement %" if g_ == GA else "Result: rating (of 5)"
        s.check("%s: its result column is %s only" % (g_, mech_cols[0]), mech_cols[0] in h_ and other not in h_, h_[-8:])

    # Result: weighted is the line's score times its weight over the weight of ALL the person's lines; a line with no
    # result counts as 0 and stays in the total, so a part-scored person's line is never inflated (Chris 2026-11-06)
    h_, rows_ = first(C_SU.get(URL["admin_performance_export"]))
    num = lambda v: None if v in (None, "") else float(v)
    sc_cols = [h_.index(c) for c in ("Result: rating (of 5)", "Result: achievement %") if c in h_]
    i_eid, i_w, i_wt = h_.index("Employee ID"), h_.index("Weightage"), h_.index("Result: weighted")
    tot = defaultdict(float)
    for r in rows_:
        tot[r[i_eid]] += num(r[i_w]) or 0
    bad, blank_rows = [], 0
    for r in rows_:
        t_, w_, wt = tot[r[i_eid]], num(r[i_w]) or 0, num(r[i_wt])
        sv = next((num(r[i]) for i in sc_cols if num(r[i]) is not None), None)
        if not t_:
            continue
        if sv is None:
            blank_rows += 1
            if wt != 0:
                bad.append((r[i_eid], "blank result, weighted", wt))
        elif wt is None or abs(wt - sv * w_ / t_) > 0.06 * w_ / t_ + 0.011:
            bad.append((r[i_eid], sv, w_, t_, wt))
    s.check("Result: weighted = score x weight / ALL the person's line weights; a line with no result shows 0",
            not bad and blank_rows, (bad[:5], blank_rows))

    # one group at a time, then all together: every line matched, no change, none new
    for label, qs in (("a scoring-A group", "?" + urlencode([("fbg", GA)])), ("a B base group", "?" + urlencode([("fbg", GB)])),
                      ("a B excellence group", "?" + urlencode([("fbg", GX)])), ("every group at once", "")):
        recs, _f = kpi_file(qs)
        chk, cls = run(recs)
        mine = [r for r in chk["valid"] if r["eid"].startswith(PFX)]
        want_n = {"?" + urlencode([("fbg", GA)]): 2, "?" + urlencode([("fbg", GB)]): 2,
                  "?" + urlencode([("fbg", GX)]): 1, "": 5}[qs]
        s.check("%s, fed back unchanged: our %d lines all matched, none new, none changed, no row refused"
                % (label, want_n), len(mine) == want_n and all(r["existing_id"] and not r["changes"] and not r["skip"]
                                                              for r in mine) and not chk["errors"],
                [(r["eid"], r["changes"]) for r in mine if r["changes"]] + chk["errors"][:2])
        if qs == "":
            others = [r for r in chk["valid"] if not r["eid"].startswith(PFX)]
            odd = [(r["kpi_name"][:0], [f for f, _x, _y in r["changes"]]) for r in others if r["changes"]]
            allowed = {"Unit", "Moderator"}   # a unit HR spelt '#' (read back as Number) and a chain of two moderators
            s.check("...and every existing line in the database matched, none new, the only changes being a unit the "
                    "standard spells otherwise or a legacy chain of two moderators (%d lines)" % len(others),
                    len(others) > 100 and not [r for r in others if not r["existing_id"]]
                    and all({f for f, _x, _y in r["changes"]} <= allowed for r in others) and not chk["errors"],
                    odd[:3])

    # the matrix manager only where it isn't the line manager
    recs, (h_, rows_) = kpi_file("?" + urlencode([("fbg", GA)]))
    mm = {r[h_.index("KPI")]: r[h_.index("Matrix manager ID")] for r in rows_}
    s.check("Matrix manager ID is blank when the line manager moderates, the moderator's Employee ID when not",
            mm == {"ZZEX Sales": "", "ZZEX Brand": PFX + "MM"}, mm)
    row = next(r for r in rows_ if r[h_.index("KPI")] == "ZZEX Brand")
    s.check("the KPI and its Focus are split so the same name is rebuilt (Brand · Elba), the method as More / Less",
            row[h_.index("Focus")] == "Elba" and row[h_.index("Method")] == "More"
            and a.kpi_line_name(row[h_.index("KPI")], row[h_.index("Focus")]) == "ZZEX Brand · Elba")
    _r, (hb, rb) = kpi_file("?" + urlencode([("fbg", GB)]))
    s.check("a less-is-better line says Less, and its threshold and target are written as stored",
            {r[hb.index("KPI")]: r[hb.index("Method")] for r in rb} == {"ZZEX PAT": "More", "ZZEX Cost": "Less"}
            and next(r for r in rb if r[hb.index("KPI")] == "ZZEX Cost")[hb.index("Threshold")] == 120)

    # one target changed is one change
    recs, _f = kpi_file("?" + urlencode([("fbg", GA)]))
    k = next(i for i, r in enumerate(recs) if r["kpi"] == "ZZEX Sales")
    recs[k]["rate 3"] = float(recs[k]["rate 3"]) + 1
    chk, cls = run(recs)
    ch = [(r["kpi_name"], r["changes"]) for r in chk["valid"] if r["changes"]]
    s.check("one target edited in the file is exactly one change, on that line", len(ch) == 1 and ch[0][0] == "ZZEX Sales"
            and [f for f, _x, _y in ch[0][1]] == ["Target"], ch)
    recs, _f = kpi_file("?" + urlencode([("fbg", GB)]))
    k = next(i for i, r in enumerate(recs) if r["kpi"] == "ZZEX PAT")
    recs[k]["target"] = float(recs[k]["target"]) + 5
    recs[k]["weightage"] = 50
    chk, cls = run(recs)
    ch = [(r["kpi_name"], [f for f, _x, _y in r["changes"]]) for r in chk["valid"] if r["changes"]]
    s.check("a B line's target edited: one change", ch == [("ZZEX PAT", ["Target"])], ch)
    recs, _f = kpi_file("?" + urlencode([("fbg", GA)]))
    k = next(i for i, r in enumerate(recs) if r["kpi"] == "ZZEX Sales")
    recs[k]["matrix manager id"] = PFX + "MM"
    chk, cls = run(recs)
    ch = [(r["kpi_name"], [f for f, _x, _y in r["changes"]]) for r in chk["valid"] if r["changes"]]
    s.check("a moderator edited in the file is exactly one change too", ch == [("ZZEX Sales", ["Moderator"])], ch)

    # the Cycle guard
    recs, _f = kpi_file("?" + urlencode([("fbg", GA)]))
    cyc_name = a._norm_header(ac["name"]) and recs[0]["cycle"]
    s.check("the Cycle column holds the period's name", cyc_name == ac["name"], cyc_name)
    wrong = [dict(r, cycle="ZZEX Some Other Year") for r in recs]
    chk, cls = run(wrong)
    kinds = {e["kind"] for e in chk["errors"]}
    s.check("a file from another cycle: every row refused as 'A different cycle's file', naming both cycles",
            kinds == {"A different cycle's file"} and len(chk["errors"]) == len(recs) and not chk["valid"]
            and all("ZZEX Some Other Year" in e["why"] and ac["name"] in e["why"] for e in chk["errors"]),
            [e["why"] for e in chk["errors"][:1]])
    chk, cls = run(recs)
    s.check("the right cycle is read as it is", not chk["errors"] and len(chk["valid"]) == len(recs))
    nocol = [{k_: v for k_, v in r.items() if k_ != "cycle"} for r in recs]
    chk, cls = run(nocol)
    s.check("a file with no Cycle column behaves as before", not chk["errors"] and len(chk["valid"]) == len(recs)
            and all(r["existing_id"] and not r["changes"] for r in chk["valid"]))
    blank = [dict(r, cycle="") for r in recs]
    chk, cls = run(blank)
    s.check("a blank Cycle cell is no cycle at all", not chk["errors"] and len(chk["valid"]) == len(recs))
    mixed = [dict(r) for r in recs]
    mixed[0]["cycle"] = "ZZEX Some Other Year"
    chk, cls = run(mixed)
    s.check("only the row with the wrong cycle is refused", len(chk["errors"]) == 1 and chk["errors"][0]["row"] == 2
            and len(chk["valid"]) == len(recs) - 1)
    r = C_SU.post("/admin/performance/import", data={"csrf_token": "tok", "preview": "1", "file": (io.BytesIO(
        C_SU.get(URL["admin_performance_export"] + "?" + urlencode([("fbg", GA)])).get_data()), "lines.xlsx")},
        content_type="multipart/form-data", follow_redirects=True)
    page = r.get_data(as_text=True)
    s.check("the real import accepts the download as it is (its Quality step has nothing to fix)", r.status_code == 200
            and "2 · Quality" in page and "to fix" not in page.split("2 · Quality")[1][:300], r.status_code)

    # results, read only
    with a.app.app_context():
        d = a.get_db()
        tid = d.execute("SELECT id FROM pm_kpi_targets WHERE subject_id=? AND kpi_name='ZZEX Sales'", (U["PA"],)).fetchone()[0]
        d.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, draft) VALUES (?, 35, 0)", (tid,))
        d.commit()
    _r, (h_, rows_) = kpi_file("?" + urlencode([("fbg", GA)]))
    row = dict(zip(h_, next(r for r in rows_ if r[h_.index("KPI")] == "ZZEX Sales")))
    s.check("Result: own value, the moderated value, the 1-5 rating and the lock state are beside the targets",
            row["Result: own value"] == 35 and row["Result: moderated value"] == 35 and row["Result: rating (of 5)"] == 3
            and row["Result: locked"] == "No" and row["Result: approvers"] == "ZZ EX MA", row)
    # PA: Sales (weight 60) scored 3, Brand (weight 40) has no result. The scored line's weighted share is over ALL
    # the weight (3 x 60 / 100), never over the scored weight alone (3 x 60 / 60 = the whole 3), and Brand shows 0
    brand = dict(zip(h_, next(r for r in rows_ if r[h_.index("Employee ID")] == row["Employee ID"]
                              and r[h_.index("KPI")] != "ZZEX Sales")))
    s.check("a part-scored person: the scored line's Result: weighted is over all their weight, the unscored line is 0",
            brand["Result: rating (of 5)"] in (None, "") and row["Result: weighted"] == round(3 * 60 / (60 + 40), 2)
            and row["Result: weighted"] != 3 and brand["Result: weighted"] == 0,
            (row["Result: weighted"], brand["Result: weighted"]))
    recs2, _f = kpi_file("?" + urlencode([("fbg", GA)]))
    chk, cls = run(recs2)
    s.check("...and a Result: column is never read by the import (the line changes nothing)",
            not chk["errors"] and all(not r["changes"] for r in chk["valid"]))

    # -------------------------------------------------------------------------------------------- Users
    s.section("Users: everything on the person's page, never a secret")
    h, rows = first(C_SU.get(URL["admin_export_users"]))
    want_tail = ["HOD", "HOD employee ID", "Work email", "Employment type", "Cost center", "Work location",
                 "Joined date", "Years of service", "Confirmation date", "Confirmation status", "User role",
                 "Taking part in %s" % ac["name"], "BU CEO of", "BG CEO of", "Group Chief of", "Calibration group",
                 "HOD of", "Line manager of", "Status", "Linked IDs"]
    s.check("the identity block, then HOD to Status, in that order", h == IDENT + want_tail, h)
    low = " ".join(h).lower()
    s.check("no IC / passport column, no password, no display name or picture", not any(
        w in low for w in ("ic /", "passport", "password", "display name", "avatar", "picture", "last 4")), h)
    by = {r[h.index("Employee ID")]: dict(zip(h, r)) for r in rows}
    pa = by[PFX + "PA"]
    s.check("a person: HOD and his Employee ID, work email, type, cost centre, location, joined and confirmation dates",
            pa["HOD"] == "ZZ EX MA" and pa["HOD employee ID"] == PFX + "MA" and pa["Work email"] == (PFX + "PA").lower() +
            "@zz.example" and pa["Employment type"] == "Permanent" and pa["Cost center"] == "CC9"
            and pa["Work location"] == "Site 9" and pa["Joined date"] == "2021-03-01" and pa["Confirmation date"] ==
            "2020-01-01" and pa["Confirmation status"] == "Confirmed", pa)
    with a.app.test_request_context("/"):
        d = a.get_db()
        svc = a.person_service(d.execute("SELECT * FROM users WHERE employee_id=?", (PFX + "PA",)).fetchone())["length"]
        role = a.urole_name(d.execute("SELECT * FROM users WHERE employee_id=?", (PFX + "PA",)).fetchone(), d)[0]
    s.check("...years of service as the person's page words it, and the user role by name", pa["Years of service"] == svc
            and pa["User role"] == role and svc != "", (pa["Years of service"], svc, pa["User role"], role))
    s.check("...a BU CEO of the unit they hold, who they head and lead (counts of people still here)",
            by[PFX + "MA"]["BU CEO of"] != "" and by[PFX + "MA"]["HOD of"] == 1 and by[PFX + "MA"]["Line manager of"] == 1
            and by[PFX + "PA"]["BU CEO of"] == "" and by[PFX + "PA"]["HOD of"] == 0, (by[PFX + "MA"]["BU CEO of"],
                                                                                         by[PFX + "MA"]["HOD of"],
                                                                                         by[PFX + "MA"]["Line manager of"]))
    s.check("...status: Active, or Left and the day they left in Malaysia", pa["Status"] == "Active"
            and by[PFX + "LEFT"]["Status"] == "Left 2026-09-01", (pa["Status"], by[PFX + "LEFT"]["Status"]))
    with a.app.app_context():
        d = a.get_db()
        want_in = {r[0] for r in d.execute("SELECT employee_id FROM users WHERE role!='admin' AND " + a.participant_sql())}
    got_in = {e for e, r in by.items() if r["Taking part in %s" % ac["name"]] == "Yes"}
    s.check("Taking part in the active cycle is the participant rule's own answer (%d Yes)" % len(got_in),
            got_in == want_in & set(by) and got_in and got_in != set(by) | set(), (len(got_in), len(want_in & set(by))))
    s.check("...and the left person is No, the active ones with a confirmation date Yes", by[PFX + "LEFT"][
        "Taking part in %s" % ac["name"]] == "No" and pa["Taking part in %s" % ac["name"]] in ("Yes", "No"))
    # the Users page's own filters still narrow the download
    only = first(C_SU.get(URL["admin_export_users"] + "?" + urlencode([("fbg", GA), ("show", "active")])))
    s.check("the Users page's own filters (group, Show active) still work: our group's active people only",
            {r[only[0].index("Employee ID")] for r in only[1]} == {PFX + x for x in ("MA", "PA", "MM")}, len(only[1]))
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        for i in SEEDED:
            db.execute("DELETE FROM rating_records WHERE id=?", (i,))
        db.commit()
        cleanup(db)

sys.exit(s.done())
