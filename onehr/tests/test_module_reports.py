"""The module reports on Reports (Chris, 2026-10-19: "for performance, one should be the submission status report, second
is the KPI line report, third is the result report. We also need competency report for the competency line per user,
submission status, and a potential report from 360 + competency. Calibration report should generate the movement of
performance and movement of potential, and lastly the talent status").

What this suite holds:
  * Reports lists them by module, in that order, beside the KPI lines CSV and the Ratings record
  * each is a real Excel file with its sheet and an About sheet, for the super admin and scoped for a BG admin
  * the status files cover exactly the people taking part (the Progress pages' own people) and count their lines
  * the competency lines file has one row per competency set for someone this cycle
  * results, potential, both movements and the talent status read the ratings record: the final bands, the steps, the
    direction, the tiers that moved, the talent status it gives, what's released and the years before
  * each new download belongs to its module for the per-admin access
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The module reports: status, lines, results, potential, movement and talent status")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
from openpyxl import load_workbook  # noqa: E402

SU, _BGA, _E = H.actors(a)
BG = "ZZRP Group"
BG2 = "ZZRP Other Group"
NEW = [("pm", "admin_export_pm_status", "/admin/export/pm-status.xlsx", "Performance status"),
       ("pm", "admin_export_pm_results", "/admin/export/pm-results.xlsx", "Performance results"),
       ("competency", "admin_export_tc_lines", "/admin/export/competency-lines.xlsx", "Competency lines"),
       ("competency", "admin_export_tc_status", "/admin/export/competency-status.xlsx", "Competency status"),
       ("competency", "admin_export_potential", "/admin/export/potential.xlsx", "Potential (360 + competency)"),
       ("calibration", "admin_export_pm_movement", "/admin/export/performance-movement.xlsx", "Performance movement"),
       ("calibration", "admin_export_pot_movement", "/admin/export/potential-movement.xlsx", "Potential movement"),
       ("calibration", "admin_export_talent", "/admin/export/talent-status.xlsx", "Talent status")]


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9RP-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        for t in ("rating_records", "talent_releases", "leader_releases", "result_releases", "talent_status_history",
                  "tc_assignments"):
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (t, ph), ul)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG2))
    db.commit()


def book(c, url):
    r = c.get(url)
    if r.status_code != 200:
        return r.status_code, None
    return 200, load_workbook(io.BytesIO(r.get_data()), read_only=True)


def sheet_rows(wb, i=0):
    ws = wb.worksheets[i]
    rows = [list(r) for r in ws.iter_rows(values_only=True)]
    return rows[0], rows[1:]


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    cyc = db.execute("SELECT * FROM cycles WHERE is_active=1").fetchone()
    CID = cyc["id"]
    YEAR = a._cycle_year_half(cyc)[0]
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZRP U1')", (BG,))
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                     "VALUES ('zz9rp-bga', 'ZZ RP Groupadmin', 'x', 'admin', 'ZZ9RP-BGA', ?, ?)", (BG, BG)).lastrowid
    P = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                   "department, job_grade, job_title) VALUES ('zz9rp-p', 'ZZ RP Person', 'x', 'user', 'ZZ9RP-P', ?, "
                   "'ZZRP U1', 'ZZRP Dept', '14', 'ZZRP Title')", (BG,)).lastrowid
    # a known record: performance ME (line manager) -> AE at HOD, AE at BU CEO, OU at BG CEO = OU final;
    # potential Low (computed) -> Mid at BU CEO = Mid final
    db.execute("INSERT INTO rating_records(cycle_id, subject_id, employee_id, full_name, business_group, company, "
               "department, job_grade, job_title, pm_mechanism, pm_self_band, pm_mgr_value, pm_mgr_band, pm_hod_band, "
               "pm_buceo_band, pm_bgceo_band, pm_final_band, pm_final_source, f360_avg, f360_max, f360_submitted, "
               "f360_valid, pot_score, pot_raw_band, pot_buceo_band, pot_final_band, pot_final_source) VALUES "
               "(?,?, 'ZZ9RP-P', 'ZZ RP Person', ?, 'ZZRP U1', 'ZZRP Dept', '14', 'ZZRP Title', 'A', 'ME', 3.0, 'ME', "
               "'AE', 'AE', 'OU', 'OU', 'bgceo', 3.5, 5, 6, 1, 11.2, 'Low', 'Mid', 'Mid', 'buceo')", (CID, P, BG))
    db.execute("INSERT INTO talent_releases(cycle_id, subject_id) VALUES (?,?)", (CID, P))
    db.execute("INSERT INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pm')", (CID, P))
    # someone in another group with a record: a BG admin's file must never hold them
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZRP U2')", (BG2,))
    Q = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                   "job_grade) VALUES ('zz9rp-q', 'ZZ RP Other', 'x', 'user', 'ZZ9RP-Q', ?, 'ZZRP U2', '15')",
                   (BG2,)).lastrowid
    db.execute("INSERT INTO rating_records(cycle_id, subject_id, employee_id, full_name, business_group, company, "
               "pm_mgr_band, pm_final_band, pot_raw_band, pot_final_band) VALUES (?,?, 'ZZ9RP-Q', 'ZZ RP Other', ?, "
               "'ZZRP U2', 'ME', 'ME', 'Mid', 'Mid')", (CID, Q, BG2))
    db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) SELECT ?, ?, id FROM tc_skills ORDER BY id "
               "LIMIT 1", (CID, P))
    if YEAR:
        db.execute("INSERT INTO talent_status_history(subject_id, year, category, source) VALUES (?,?, 'Star', 'import')",
                   (P, YEAR - 1))
    db.commit()
SUP, BAC = H.client_as(a, SU["id"]), H.client_as(a, BGA)

try:
    s.section("Reports lists them by module")
    hub = SUP.get("/admin/reports/all?kind=data").get_data(as_text=True)   # the Data downloads tab
    # each module's "People with no ..." file comes last (2026-10-21), in its import's own columns (test_import_exports)
    # (the libraries' files, 10 Nov 2026, come before it: KPI library and Competency library)
    want = {"pm": ["Submission status", "KPI lines", "Results", "KPI library", "People with no KPI line"],
            "competency": ["Competency lines", "Submission status", "Potential (360 + competency)", "Competency library",
                           "People with no competencies"],
            # (and the module pages' downloads that moved here on 4 Nov 2026, after the Ratings record)
            "calibration": ["Performance movement", "Potential movement", "Talent status", "Ratings record",
                            "Calibration progress", "Lock status", "Final bands"]}
    with a.app.test_request_context("/"):
        a.g._admin_perms = None
        u = a.get_db().execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        groups = {g_["key"]: [f["label"] for f in g_["files"]] for g_ in a._reports_for(u)}
    for k, labels in want.items():
        s.check("%s: %s, in that order" % (k, ", ".join(labels)), groups.get(k) == labels, groups.get(k))
    s.check("...and the page shows them", all(lbl in hub for v in want.values() for lbl in v)
            and "/admin/export/talent-status.xlsx" in hub)

    s.section("each is a real workbook with an About sheet")
    files = {}
    for mod, ep, url, title in NEW:
        code, wb = book(SUP, url)
        ok = code == 200 and wb is not None and [w.title for w in wb.worksheets] == [title[:31], "About"]
        s.check("%s: an Excel file, '%s' then About" % (url, title), ok, code)
        if ok:
            files[ep] = sheet_rows(wb)
        s.check("...belongs to %s for the per-admin access" % mod, a._ACCESS_PAGE_MODULE.get(ep) == mod)
    with a.app.app_context():
        n_logs = a.get_db().execute("SELECT COUNT(*) FROM activity_log WHERE action='export' AND user_id=? AND "
                                    "detail LIKE 'AI+OneHR_%_Performance_Submission_status_%'", (SU["id"],)).fetchone()[0]
    s.check("a download is in the audit log", n_logs >= 1, n_logs)

    s.section("the status files cover the people taking part")

    def n_part():
        with a.app.test_request_context("/"):
            return a.get_db().execute("SELECT COUNT(*) FROM users WHERE role!='admin' AND COALESCE(left_at,'')='' AND "
                                      "COALESCE(is_demo,0)=0 AND " + a.participant_sql()).fetchone()[0]
    for ep, url in (("admin_export_pm_status", "/admin/export/pm-status.xlsx"),
                    ("admin_export_tc_status", "/admin/export/competency-status.xlsx")):
        # counted just before and just after: other suites share this database and may add people meanwhile
        before = n_part()
        code, wb = book(SUP, url)
        after = n_part()
        files[ep] = sheet_rows(wb) if wb else (None, [])
        rows = files[ep][1]
        s.check("%s: one row per person taking part (%d)" % (ep, before), len(rows) in (before, after) and before > 1,
                (len(rows), before, after))
    head, rows = files.get("admin_export_pm_status", ([], []))
    with a.app.app_context():
        d = a.get_db()
        lines = {r[0]: r[1] for r in d.execute("SELECT u.employee_id, COUNT(*) FROM pm_kpi_targets t JOIN users u ON "
                                               "u.id=t.subject_id WHERE t.cycle_id=? GROUP BY u.employee_id", (CID,))}
    if head:
        i_id, i_n = head.index("Employee ID"), head.index("KPI lines")
        wrong = [r[i_id] for r in rows if (r[i_n] or 0) != lines.get(r[i_id], 0)]
        s.check("...with each person's KPI line count (%d people with lines)" % sum(1 for r in rows if r[i_n]),
                not wrong and any(r[i_n] for r in rows), wrong[:3])

    s.section("competency lines: one row per competency set")

    def n_lines():
        with a.app.app_context():
            return a.get_db().execute(
                "SELECT COUNT(*) FROM tc_assignments a JOIN users u ON u.id=a.subject_id WHERE a.cycle_id=? AND "
                "u.role!='admin' AND COALESCE(u.is_demo,0)=0", (CID,)).fetchone()[0]
    before = n_lines()
    _code, _wb = book(SUP, "/admin/export/competency-lines.xlsx")
    after = n_lines()
    rows = sheet_rows(_wb)[1] if _wb else []
    s.check("as many rows as competencies set this cycle (%d)" % before, len(rows) in (before, after) and before > 1,
            (len(rows), before, after))

    s.section("results, potential, movement and talent read the ratings record")

    def row_of(ep, eid="ZZ9RP-P"):
        h, rs = files.get(ep, ([], []))
        i = h.index("Employee ID") if h else 0
        r = next((x for x in rs if x[i] == eid), None)
        return dict(zip(h, r)) if r else {}
    r = row_of("admin_export_pm_results")
    s.check("Results: their line manager's band and the final band, decided by the BG CEO",
            r.get("Line manager's band") == "ME" and r.get("Final band") == "OU"
            and r.get("Final band decided by") == "BG CEO" and r.get("Released to them") == "Yes", r)
    r = row_of("admin_export_potential")
    s.check("Potential: the 360, the score, the computed and final bands",
            r.get("360 score") == 3.5 and r.get("Potential score") == 11.2 and r.get("Potential band (computed)") ==
            "Low" and r.get("Potential final band") == "Mid" and r.get("Released to them") == "No", r)
    r = row_of("admin_export_pm_movement")
    s.check("Performance movement: ME to OU is +2, Up", r.get("Line manager's band") == "ME" and r.get("Final band") ==
            "OU" and r.get("Steps") == 2 and r.get("Direction") == "Up" and r.get("Moved") == "Yes", r)
    s.check("...moved at the HOD and the BG CEO, not the BU CEO (it held AE)",
            r.get("Where it moved") == "HOD (ME to AE); BG CEO (AE to OU)" and r.get("After BU CEO") == "AE", r)
    r = row_of("admin_export_pot_movement")
    s.check("Potential movement: Low to Mid is +1 at the BU CEO", r.get("Computed band") == "Low"
            and r.get("Steps") == 1 and r.get("Where it moved") == "BU CEO (Low to Mid)", r)
    r = row_of("admin_export_talent")
    s.check("Talent status: the cell OU and Mid make, released to them",
            r.get("Talent status") == a.talent_category("OU", "Mid") and r.get("Released to them") == "Yes", r)
    if YEAR:
        s.check("...with the year before's status", r.get("Talent status %d" % (YEAR - 1)) == "Star", r)

    s.section("a BG admin's files hold their group only")
    for ep, url in (("admin_export_pm_movement", "/admin/export/performance-movement.xlsx"),
                    ("admin_export_tc_lines", "/admin/export/competency-lines.xlsx")):
        code, wb = book(BAC, url)
        h, rs = sheet_rows(wb) if wb else ([], [])
        # a BG admin's file covers one group, so it has no Business group column (the identity block drops it): the
        # people in it are read back from the users table
        eids = {x[h.index("Employee ID")] for x in rs} if h else set()
        with a.app.app_context():
            dbx = a.get_db()
            bgs = {dbx.execute("SELECT business_group FROM users WHERE employee_id=? AND role!='admin'", (e,)).fetchone()[0]
                   for e in eids}
        s.check("%s for the BG admin: only %s, and no Business group column" % (url, BG),
                code == 200 and bool(bgs) and bgs <= {BG} and "Business group" not in h, (code, bgs, h[:3]))
    h, rs = sheet_rows(book(BAC, "/admin/export/performance-movement.xlsx")[1])
    s.check("...and their own person is in it", any(x[h.index("Employee ID")] == "ZZ9RP-P" for x in rs))
    hs, rss = sheet_rows(book(SUP, "/admin/export/performance-movement.xlsx")[1])
    s.check("...the other group's person is in the super admin's file, never theirs",
            not any(x[h.index("Employee ID")] == "ZZ9RP-Q" for x in rs)
            and any(x[hs.index("Employee ID")] == "ZZ9RP-Q" for x in rss))
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
