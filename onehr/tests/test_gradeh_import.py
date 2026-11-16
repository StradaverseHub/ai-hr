"""Grade H Appraisal, piece 2: the two imports, the admin page and the demo seeder (2026-10-28; spec OneHR/JG H Appraisal/BUILD-SPEC.md).

What this suite holds:
  * the Grade H list import on the four-step engine: its quality step (an unknown ID, someone not at grade H, someone twice,
    a bad route, the template's example row; no appraiser / no line manager and a differing company only "worth a look"),
    rows for a private company skipped and counted (never written), apply writes gradeh_people for the active Year-End
    cycle, the super admin's answers (a route change after the person has started; a different appraiser)
  * the Strada8 KPI lines import: weights per person must total 100% (an 85% person is named and the file cannot go on;
    the writer refuses too), a person not on the list, a bad scale, a person's lines are unchanged on a re-import, the
    answer for someone who has started, loading lines puts the person on the KPI route
  * the database is backed up before apply; every change is audited; every download is Excel; the example rows are
    EXAMPLE- placeholders; "who's missing" downloads follow their import's columns
  * the super admin's alone (a BG admin and an employee are refused), 404 while ONEHR_GRADEH is off, a Year-End cycle only
  * the admin page /admin/gradeh: tabs, the Imports tab, placeholders on the rest, the menu entry gated on gradeh_on()
  * the demo seeder: a dry run writes nothing; --apply copies the database first and is idempotent; ZZH ids only

Synthetic (ZZ9GH-*) on a fresh scratch database; the suite puts back what it changes.
"""
import csv as _csv
import hashlib
import io
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H Appraisal: the two imports, the admin page, the demo seeder")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, EMP = H.actors(a)
PFX, BG, CO = "ZZ9GH-", "ZZGH Group", "ZZGH Unit"
U = {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
LIST, KPI = "/admin/gradeh/import/list", "/admin/gradeh/import/kpi"
LH, KH = list(a.GRADEH_LIST_IMPORT_COLUMNS), list(a.GRADEH_KPI_IMPORT_COLUMNS)


def xfile(head, rows):
    if head == LH:   # rows written before the HOD employee ID column (2026-11-02, after Appraiser employee ID) and before the second HOD
        fixed = []   # and HOD split columns (2026-11-03, after HOD employee ID) have no cell for them: blank
        for r in rows:
            r = list(r)
            if len(r) == len(head) - 3:
                r = r[:3] + [""] + r[3:]
            if len(r) == len(head) - 2:
                r = r[:4] + ["", ""] + r[4:]
            fixed.append(r)
        rows = fixed
    buf = io.StringIO()
    w = _csv.writer(buf)
    w.writerow(head)
    w.writerows(rows)
    return io.BytesIO(buf.getvalue().encode())


def stage(url, f, cl=None):
    r = (cl or C).post(url, data={"csrf_token": "tok", "preview": "1", "file": (f, "gh.csv")},
                       content_type="multipart/form-data")
    return (re.search(r"check=([0-9a-f]{32})", r.headers.get("Location", "")) or [None, ""])[1]


def step(url, tok, action, **form):
    return C.post(url, data=dict({"csrf_token": "tok", "token": tok, "action": action}, **form))


def page(url, tok, st=None):
    return C.get(url + "?check=%s%s" % (tok, ("&step=" + st) if st else "")).get_data(as_text=True)


def answer(url, tok, picks, action="to_apply"):
    return step(url, tok, action, **{"d_" + hashlib.sha1(k.encode()).hexdigest()[:10]: v for k, v in picks.items()})


def rows_of(sql, args=()):
    return H.rows(a, sql, args)


def load(kind, head, rows, fn="gh.csv"):
    """The engine's quality of a file, read straight (no request): (ctx, quality)."""
    with a.app.test_request_context("/"):
        db = a.get_db()
        me = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        spec = a._IMP[kind]
        ctx = spec["load"](db, me, {"filename": fn}, xfile(head, rows).read())
        return ctx, a._imp_quality(spec, ctx)


def kinds(q):
    return {f["kind"]: f["n"] for f in q["fix"]}


def n_people():
    return H.one(a, "SELECT COUNT(*) FROM gradeh_people WHERE cycle_id=?", (CID,))


try:
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        CID = a.active_cycle_id(db)
        db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))   # a Year-End
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))

        def mk(k, grade, mgr=None, left=False):
            U[k] = db.execute(
                "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                "department, job_grade, manager_id, confirmation_date, left_at) VALUES (?,?, 'x', 'user', ?,?,?, 'ZZGH Dept', ?,?, "
                "'2020-01-01', ?)", ((PFX + k).lower(), "ZZ GH " + k, PFX + k, BG, CO, grade, mgr,
                                    "2026-01-01" if left else None)).lastrowid
        mk("M1", "15")
        mk("M2", "15")
        mk("N1", "14")                   # not grade H
        for k in ("H1", "H2", "H3", "H4", "H5"):
            mk(k, "H", mgr=U["M1"])
        mk("H6", "H")                    # no line manager
        mk("H7", "H")                    # no line manager
        mk("HL", "H", left=True)         # has left
        db.commit()
    C = H.client_as(a, SU["id"])
    CBG = H.client_as(a, BGA["id"]) if BGA else None
    CEMP = H.client_as(a, EMP["id"])

    s.section("the machinery and the example rows")
    for n in ("GRADEH_LIST_IMPORT_COLUMNS", "GRADEH_KPI_IMPORT_COLUMNS", "admin_gradeh", "admin_gradeh_import_list",
              "admin_gradeh_import_kpi"):
        s.check("%s present" % n, hasattr(a, n))
    s.check("both imports are registered on the shared engine", a.GRADEH_LIST_KIND in a._IMP and a.GRADEH_KPI_KIND in a._IMP)
    s.check("the list's columns: Employee ID, Route, Appraiser employee ID, HOD employee ID, Second HOD employee ID, HOD split %, Supervisor name, Company (and Private company)",
            LH[:8] == ["Employee ID", "Route", "Appraiser employee ID", "HOD employee ID", "Second HOD employee ID", "HOD split %",
                       "Supervisor name", "Company"] and "Private company" in LH, LH)
    s.check("the KPI lines' columns", KH == ["Employee ID", "KPI name", "Weight %", "Group scale"], KH)
    for nm, url, cols in (("list", LIST, LH), ("KPI lines", KPI, KH)):
        r = C.get(url + "/template.xlsx")
        from openpyxl import load_workbook
        ws = load_workbook(io.BytesIO(r.data), read_only=True).worksheets[0]
        rr = [list(x) for x in ws.iter_rows(values_only=True)]
        s.check("the %s template is Excel, in the import's columns, every example row an EXAMPLE- placeholder" % nm,
                r.status_code == 200 and r.data[:2] == b"PK" and [str(x) for x in rr[0]] == cols and len(rr) > 1
                and all(str(x[0]).startswith("EXAMPLE-") for x in rr[1:]), rr[:2])
        s.check("...and it answers as a real spreadsheet: a zip (PK), the spreadsheet content type, an .xlsx attachment name, the "
                "header row parsed back as the import's columns",
                r.data[:4] == b"PK\x03\x04" and r.mimetype == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                and re.search(r'filename="[^"]+\.xlsx"', r.headers.get("Content-Disposition", "")) is not None
                and [str(x) for x in rr[0]] == cols, (r.mimetype, r.headers.get("Content-Disposition")))
        tk = stage(url, io.BytesIO(r.data) if False else xfile(cols, [[x if x is not None else "" for x in row] for row in rr[1:]]))
        ctx, q = load(a.GRADEH_LIST_KIND if url == LIST else a.GRADEH_KPI_KIND, cols,
                      [[x if x is not None else "" for x in row] for row in rr[1:]])
        s.check("...uploaded unchanged, every row is refused as the template's example row, nothing valid",
                set(kinds(q)) == {"The template's example row"} and not ctx["valid"], kinds(q))

    s.section("the Grade H list: quality")
    big = [[PFX + "H1", "KPI", "", "", CO, ""],
           [PFX + "H2", "Line manager", "", "", CO, ""],
           [PFX + "H2", "Line manager", "", "", CO, ""],                          # twice
           [PFX + "NOPE", "KPI", "", "", CO, ""],                                  # unknown
           [PFX + "N1", "KPI", "", "", CO, ""],                                    # not grade H
           [PFX + "HL", "KPI", "", "", CO, ""],                                    # has left
           [PFX + "H3", "Sideways", "", "", CO, ""],                               # bad route
           [PFX + "H4", "KPI", PFX + "NOPE", "", CO, ""],                          # appraiser unknown
           [PFX + "H5", "KPI", PFX + "H5", "", CO, ""],                            # own appraiser
           [PFX + "P1", "KPI", "", "", "Some Private Co", "Yes"],                  # private (not in OneHR at all)
           [PFX + "H6", "Line manager", "", "", CO, "yes"]]                        # private, though in OneHR
    ctx, q = load(a.GRADEH_LIST_KIND, LH, big)
    k = kinds(q)
    s.check("an unknown ID, someone not at grade H, someone who has left, someone twice, a bad route, an unknown appraiser and "
            "their own are each can't-be-imported",
            k.get("Unknown Employee ID") == 1 and k.get("Not Grade H in OneHR") == 1 and k.get("Someone who has left") == 1
            and k.get("In the file twice") == 1 and k.get("A route that isn't KPI or Line manager") == 1
            and k.get("An appraiser OneHR can't use") == 2, k)
    s.check("rows for a private company are skipped and counted, never errors: both counted, neither valid",
            len(ctx["private"]) == 2 and not any(v["eid"] in (PFX + "P1", PFX + "H6") for v in ctx["valid"])
            and not any(PFX + "P1" in e["why"] or (PFX + "H6") in e["why"] for e in ctx["errors"]),
            [p["eid"] for p in ctx["private"]])
    s.check("the good rows still read as valid (H1, H2)", {v["eid"] for v in ctx["valid"]} == {PFX + "H1", PFX + "H2"},
            [v["eid"] for v in ctx["valid"]])
    tk = stage(LIST, xfile(LH, big))
    pg = page(LIST, tk)
    s.check("the page shows the quality step with what can't go in", "2 · Quality" in pg and "can't be imported" in pg
            and "Not Grade H in OneHR" in pg)
    r = step(LIST, tk, "quality_ok", ack="1")
    s.check("with rows that can't go in, Continue goes nowhere and nothing is recorded as seen",
            not a._imp_meta(a.GRADEH_LIST_KIND, tk).get("quality"))
    step(LIST, tk, "apply")
    s.check("...and a forced Apply writes nothing", n_people() == 0)
    s.check("falsified: a clean version of the same file has no fix (so the guard above is the rows, not the file)",
            not load(a.GRADEH_LIST_KIND, LH, big[:2] + [big[-2]])[0]["errors"])
    ctx, q = load(a.GRADEH_LIST_KIND, LH, [[PFX + "H6", "Line manager", "", "", CO, ""],
                                           [PFX + "H7", "Line manager", "", "ZZ Demo Supervisor Seven", "Another Co", ""],
                                           [PFX + "H1", "KPI", "", "", CO, ""]])
    lk = {g["key"]: g["n"] for g in q["look"]}
    s.check("no appraiser and no line manager is worth a look (naming the supervisor text where the file has one); a company "
            "that differs is noted; a KPI-route person with no lines is noted; none stops the file",
            not ctx["errors"] and lk.get("no_appraiser") == 2 and lk.get("company") == 1 and lk.get("no_lines") == 1
            and any("ZZ Demo Supervisor Seven" in f["detail"] for g in q["look"] if g["key"] == "no_appraiser"
                    for f in g["found"]), lk)

    s.section("the Grade H list: the four steps and apply")
    good = [[PFX + "H1", "KPI", "", "", CO, ""],
            [PFX + "H2", "Line manager", PFX + "M2", "", CO, ""],
            [PFX + "H3", "Line manager", "", "", CO, ""],
            [PFX + "H6", "Line manager", "", "ZZ Demo Supervisor Six", CO, ""],
            [PFX + "P1", "KPI", "", "", "Some Private Co", "Yes"],
            [PFX + "P2", "KPI", "", "", "Some Private Co", ""]]   # P2 is no one: with no private mark it is an unknown ID
    tk = stage(LIST, xfile(LH, good))
    s.check("an unmarked unknown ID still stops the file (the private mark is what skips)", "Unknown Employee ID" in page(LIST, tk))
    good = good[:5]
    tk = stage(LIST, xfile(LH, good))
    pg = page(LIST, tk)
    s.check("the quality step: the private row is not a problem; no appraiser is worth a look", "worth a look" in pg
            and "Unknown Employee ID" not in pg)
    step(LIST, tk, "quality_ok", ack="1")
    pg = page(LIST, tk, "changes")
    s.check("the changes: who goes on, the private row counted as skipped, the appraiser in words", "Who goes on the list" in pg
            and "private company, skipped" in pg and "Skipped: private company" in pg and "ZZ GH M2" in pg, pg[:0])
    step(LIST, tk, "to_apply")
    pg = page(LIST, tk, "apply")
    s.check("the final preview names Added and the confirm box says how many are skipped", "Added, KPI route" in pg
            and "1 private-company row is skipped" in pg and 'data-confirm-ok="Apply this file"' in pg)
    dl = C.get(LIST + "/check/%s.xlsx?what=final" % tk)
    s.check("...and downloads as Excel", dl.status_code == 200 and dl.data[:2] == b"PK")
    s.check("nothing is written before Apply", n_people() == 0)
    nb0 = len([f for f in os.listdir(a._imp_backup_dir())]) if os.path.isdir(a._imp_backup_dir()) else 0
    r = step(LIST, tk, "apply")
    s.check("applied: four people on the list for the active cycle; the private row is not loaded", n_people() == 4
            and not rows_of("SELECT 1 FROM gradeh_people WHERE employee_id IN (?, ?)", (PFX + "P1", PFX + "P2")))
    pp = {r_["employee_id"]: r_ for r_ in rows_of(
        "SELECT employee_id, route, appraiser_id, hr_supervisor_name, user_id, language, private_company FROM gradeh_people "
        "WHERE cycle_id=?", (CID,))}
    s.check("routes: H1 KPI (A), the rest Line manager (B)", pp[PFX + "H1"]["route"] == "A" and pp[PFX + "H2"]["route"] == "B"
            and pp[PFX + "H3"]["route"] == "B")
    s.check("a blank Appraiser stays blank (their line manager on OneHR); a named one is stored",
            pp[PFX + "H3"]["appraiser_id"] is None and pp[PFX + "H2"]["appraiser_id"] == U["M2"])
    s.check("the supervisor's name from the file is kept as text only where given, never invented",
            pp[PFX + "H6"]["hr_supervisor_name"] == "ZZ Demo Supervisor Six" and pp[PFX + "H3"]["hr_supervisor_name"] is None)
    s.check("each person is tied to their user, the language defaults to bm, none is flagged private",
            all(v["user_id"] for v in pp.values()) and all(v["language"] == "bm" for v in pp.values())
            and all(not v["private_company"] for v in pp.values()))
    nb1 = len(os.listdir(a._imp_backup_dir()))
    s.check("the database was backed up first (an import backup now exists)", nb1 > nb0 or any(
        "import-gradeh-list" in f for f in os.listdir(a._imp_backup_dir())), os.listdir(a._imp_backup_dir())[-2:])
    done = C.get(r.headers.get("Location", "")).get_data(as_text=True)
    s.check("the done page says so", "Applied gh.csv" in done and "4 added" in done and "1 private-company rows skipped" in done, done[:0])
    det = H.one(a, "SELECT detail FROM activity_log WHERE action='gradeh_import_list' AND user_id=? ORDER BY id DESC LIMIT 1",
                (SU["id"],)) or ""
    s.check("the audit trail names it", "4 added" in det and "1 private-company rows skipped" in det, det)
    tk = stage(LIST, xfile(LH, good))
    step(LIST, tk, "quality_ok", ack="1")
    pg = page(LIST, tk, "changes")
    s.check("the same file again changes nothing: all four 'No change'", "already on it, the same" in pg and re.search(
        r"<b>4</b><span>already on it, the same", pg) is not None)

    s.section("the Grade H list: the super admin's answers")
    with a.app.app_context():
        db = a.get_db()
        pid = {r_["employee_id"]: r_["id"] for r_ in db.execute("SELECT id, employee_id FROM gradeh_people WHERE cycle_id=?", (CID,))}
        db.execute("INSERT INTO gradeh_ratings(cycle_id, person_id, attr_key, rating) VALUES (?,?,?,3)",
                   (CID, pid[PFX + "H3"], a.GRADEH_ATTRIBUTES[0]["key"]))   # H3 has started
        db.commit()
    flip = [[PFX + "H3", "KPI", "", "", CO, ""], [PFX + "H2", "Line manager", PFX + "M1", "", CO, ""]]
    tk = stage(LIST, xfile(LH, flip))
    step(LIST, tk, "quality_ok", ack="1")
    pg = page(LIST, tk, "changes")
    s.check("a route change for someone who has started, and a different appraiser, are each asked",
            "Their route changes and they have started (1)" in pg and "different appraiser" in pg and "Super admin answers" in pg)
    step(LIST, tk, "to_apply")
    s.check("unanswered, Continue to the final preview goes nowhere", not a._imp_meta(a.GRADEH_LIST_KIND, tk).get("changes"))
    step(LIST, tk, "apply")
    s.check("...and Apply with the answers missing writes nothing", rows_of(
        "SELECT route FROM gradeh_people WHERE id=?", (pid[PFX + "H3"],))[0][0] == "B")
    answer(LIST, tk, {"route:" + PFX + "H3": "keep", "appr:" + PFX + "H2": "keep"})
    step(LIST, tk, "apply")
    s.check("answered Keep: H3 stays on the Line manager route, H2 keeps M2", rows_of(
        "SELECT route FROM gradeh_people WHERE id=?", (pid[PFX + "H3"],))[0][0] == "B" and rows_of(
        "SELECT appraiser_id FROM gradeh_people WHERE id=?", (pid[PFX + "H2"],))[0][0] == U["M2"])
    det = H.one(a, "SELECT detail FROM activity_log WHERE action='gradeh_import_list' AND user_id=? ORDER BY id DESC LIMIT 1",
                (SU["id"],)) or ""
    s.check("...the audit trail names who was kept", "kept what was set for 2" in det, det)
    tk = stage(LIST, xfile(LH, flip))
    step(LIST, tk, "quality_ok", ack="1")
    answer(LIST, tk, {"route:" + PFX + "H3": "change", "appr:" + PFX + "H2": "file"})
    step(LIST, tk, "apply")
    s.check("answered Change / Use the file's: H3 is on the KPI route and H2's appraiser is M1", rows_of(
        "SELECT route FROM gradeh_people WHERE id=?", (pid[PFX + "H3"],))[0][0] == "A" and rows_of(
        "SELECT appraiser_id FROM gradeh_people WHERE id=?", (pid[PFX + "H2"],))[0][0] == U["M1"])
    tk = stage(LIST, xfile(LH, [[PFX + "H2", "Line manager", "", "", CO, ""]]))
    step(LIST, tk, "quality_ok", ack="1")
    step(LIST, tk, "to_apply")
    step(LIST, tk, "apply")
    s.check("...(H2 keeps M1 after a file with a blank appraiser)", rows_of(
        "SELECT appraiser_id FROM gradeh_people WHERE id=?", (pid[PFX + "H2"],))[0][0] == U["M1"])

    s.section("the Strada8 KPI lines: quality, weights must total 100%")
    bad85 = [[PFX + "H1", "Sales", 40, "FIAMMA"], [PFX + "H1", "Margin", 45, "FIAMMA"]]
    ctx, q = load(a.GRADEH_KPI_KIND, KH, bad85)
    s.check("weights totalling 85% are refused and named: 'weights total 85%'",
            kinds(q) == {"Weights total 85%, not 100%": 1} and "weights total 85%" in ctx["errors"][0]["why"]
            and not ctx["valid"], ctx["errors"])
    s.check("falsified: 40 + 60 totals 100 and is clean", not load(a.GRADEH_KPI_KIND, KH, [
        [PFX + "H1", "Sales", 40, "FIAMMA"], [PFX + "H1", "Margin", 60, "FIAMMA"]])[0]["errors"])
    s.check("a total over 100 is refused too, and 99.99 is not 100",
            kinds(load(a.GRADEH_KPI_KIND, KH, [[PFX + "H1", "A", 60, "FIAMMA"], [PFX + "H1", "B", 50, "FIAMMA"]])[1]) ==
            {"Weights total 110%, not 100%": 1} and kinds(load(a.GRADEH_KPI_KIND, KH, [
                [PFX + "H1", "A", 60, "FIAMMA"], [PFX + "H1", "B", 39.9, "FIAMMA"]])[1]) == {"Weights total 99.9%, not 100%": 1})
    s.check("a weight written as 25% and thirds that add to 100 are fine", not load(a.GRADEH_KPI_KIND, KH, [
        [PFX + "H1", "A", "25%", "SIGNATURE"], [PFX + "H1", "B", "25%", "SIGNATURE"], [PFX + "H1", "C", "50", "SIGNATURE"]])[0]["errors"])
    ctx, q = load(a.GRADEH_KPI_KIND, KH, [
        [PFX + "H4", "A", 100, "FIAMMA"],                                        # not on the list
        [PFX + "H1", "A", 50, "BOGUS"], [PFX + "H1", "B", 50, "FIAMMA"],         # bad scale
        [PFX + "H2", "A", "abc", "FIAMMA"],                                      # bad weight
        [PFX + "H2", "B", 0, "FIAMMA"],                                          # zero weight
        [PFX + "H3", "A", 50, "FIAMMA"], [PFX + "H3", "A", 50, "FIAMMA"],        # a KPI twice
        [PFX + "N1", "A", 100, "FIAMMA"],                                        # not on the list either
        [PFX + "H6", "A", 50, "FIAMMA"], [PFX + "H6", "B", 50, "SIGNATURE"]])    # mixed scales
    k = kinds(q)
    s.check("not on the list, a bad scale, a bad weight, a KPI twice, mixed scales are each caught",
            k.get("Not on the Grade H list") == 2 and k.get("A group scale that isn't FIAMMA or SIGNATURE") == 1
            and k.get("A weight that isn't a number") == 2 and k.get("A KPI twice") == 1 and k.get("Lines mixing scales") == 1, k)
    ctx = load(a.GRADEH_KPI_KIND, KH, [[PFX + "H1", "A", 100, "FIAMMA"]])[0]
    s.check("a person on a Line manager route moves to KPI: worth a look, not a stop",
            not ctx["errors"] and any(g for g in load(a.GRADEH_KPI_KIND, KH, [[PFX + "H2", "A", 100, "FIAMMA"]])[1]["look"]
                                      if g["key"] == "to_kpi"))
    tk = stage(KPI, xfile(KH, bad85))
    step(KPI, tk, "quality_ok", ack="1")
    step(KPI, tk, "apply")
    s.check("the 85% file: Continue refused, a forced Apply writes no line", not rows_of("SELECT 1 FROM gradeh_kpi_lines")
            and not a._imp_meta(a.GRADEH_KPI_KIND, tk).get("quality") and "Weights total 85%, not 100%" in page(KPI, tk),
            (rows_of("SELECT COUNT(*) FROM gradeh_kpi_lines"), a._imp_meta(a.GRADEH_KPI_KIND, tk).get("quality"), "85%" in page(KPI, tk)))
    with a.app.test_request_context("/"):
        db = a.get_db()
        me = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        fake = {"cyc": db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone(), "valid": [
            {"eid": PFX + "H1", "pid": pid[PFX + "H1"], "route": "A", "same": False, "progress": False, "had": 0, "name": "x",
             "lines": [{"name": "A", "weight": 40.0, "scale": "FIAMMA"}, {"name": "B", "weight": 45.0, "scale": "FIAMMA"}]}]}
        try:
            a._gkl_apply(db, me, fake, {})
            refused = False
        except ValueError as e:
            refused = "85" in str(e)
        db.rollback()
    s.check("the writer itself refuses an 85% person (defence if a bad context ever reached it)", refused
            and not rows_of("SELECT 1 FROM gradeh_kpi_lines"))

    s.section("the Strada8 KPI lines: apply, re-import, the answer for someone who has started")
    lines = [[PFX + "H1", "Sales", 40, "FIAMMA"], [PFX + "H1", "Margin", 35, "FIAMMA"], [PFX + "H1", "Collections", 25, "FIAMMA"],
             [PFX + "H2", "Throughput", 60, "SIGNATURE"], [PFX + "H2", "Waste", 40, "SIGNATURE"]]
    tk = stage(KPI, xfile(KH, lines))
    step(KPI, tk, "quality_ok", ack="1")
    pg = page(KPI, tk, "changes")
    s.check("the changes: each person's lines; weights shown adding to 100; H2 moves to the KPI route",
            "Each person&#39;s KPI lines" in pg and "40 + 35 + 25 = 100" in pg and "60 + 40 = 100" in pg)
    step(KPI, tk, "to_apply")
    pg = page(KPI, tk, "apply")
    s.check("the final preview says 5 lines for 2 people", "5 KPI lines" in pg or ">5<" in pg)
    dl = C.get(KPI + "/check/%s.xlsx?what=changes" % tk)
    s.check("...and the changes download as Excel", dl.status_code == 200 and dl.data[:2] == b"PK")
    step(KPI, tk, "apply")
    ln = rows_of("SELECT p.employee_id, l.kpi_name, l.weight, l.group_scale FROM gradeh_kpi_lines l JOIN gradeh_people p ON p.id=l.person_id "
                 "WHERE l.cycle_id=? ORDER BY l.id", (CID,))
    tot = {}
    for e, _n, w, _sc in ln:
        tot[e] = tot.get(e, 0) + w
    s.check("applied: 5 lines, each person's weights total 100, the scale kept", len(ln) == 5 and tot == {PFX + "H1": 100, PFX + "H2": 100}
            and {x[3] for x in ln if x[0] == PFX + "H2"} == {"SIGNATURE"}, ln)
    s.check("...and both are on the KPI route (A)", all(rows_of("SELECT route FROM gradeh_people WHERE id=?", (pid[e],))[0][0] == "A"
                                                    for e in (PFX + "H1", PFX + "H2")))
    det = H.one(a, "SELECT detail FROM activity_log WHERE action='gradeh_import_kpi' AND user_id=? ORDER BY id DESC LIMIT 1", (SU["id"],)) or ""
    s.check("...audited", "5 KPI lines for 2 people" in det, det)
    ids0 = [r_[0] for r_ in rows_of("SELECT id FROM gradeh_kpi_lines WHERE cycle_id=? ORDER BY id", (CID,))]
    with a.app.app_context():
        db = a.get_db()
        lid = db.execute("SELECT l.id FROM gradeh_kpi_lines l WHERE l.person_id=? ORDER BY l.id", (pid[PFX + "H1"],)).fetchone()[0]
        db.execute("INSERT INTO gradeh_kpi_entries(cycle_id, person_id, line_id, staff_pct, staff_at) VALUES (?,?,?,95,datetime('now'))",
                   (CID, pid[PFX + "H1"], lid))
        db.commit()
    tk = stage(KPI, xfile(KH, lines))
    step(KPI, tk, "quality_ok", ack="1")
    step(KPI, tk, "to_apply")
    step(KPI, tk, "apply")
    s.check("the same lines again change nothing: the line ids, and H1's keyed figure, are kept",
            [r_[0] for r_ in rows_of("SELECT id FROM gradeh_kpi_lines WHERE cycle_id=? ORDER BY id", (CID,))] == ids0
            and H.one(a, "SELECT COUNT(*) FROM gradeh_kpi_entries WHERE person_id=?", (pid[PFX + "H1"],)) == 1)
    new = [[PFX + "H1", "Sales", 50, "FIAMMA"], [PFX + "H1", "Margin", 50, "FIAMMA"]]
    tk = stage(KPI, xfile(KH, new))
    step(KPI, tk, "quality_ok", ack="1")
    pg = page(KPI, tk, "changes")
    s.check("changed lines for someone who has started are asked (replace, or leave)", "They have started, and their lines or "
            "route change (1)" in pg and "Replace their lines" in pg and "Leave them" in pg)
    step(KPI, tk, "to_apply")
    step(KPI, tk, "apply")
    s.check("unanswered: nothing changes", H.one(a, "SELECT COUNT(*) FROM gradeh_kpi_lines WHERE person_id=?", (pid[PFX + "H1"],)) == 3)
    answer(KPI, tk, {"kpi:" + PFX + "H1": "leave"})
    step(KPI, tk, "apply")
    s.check("answered Leave: their three lines and their keyed figure stay", H.one(
        a, "SELECT COUNT(*) FROM gradeh_kpi_lines WHERE person_id=?", (pid[PFX + "H1"],)) == 3 and H.one(
        a, "SELECT COUNT(*) FROM gradeh_kpi_entries WHERE person_id=?", (pid[PFX + "H1"],)) == 1)
    tk = stage(KPI, xfile(KH, new))
    step(KPI, tk, "quality_ok", ack="1")
    answer(KPI, tk, {"kpi:" + PFX + "H1": "replace"})
    step(KPI, tk, "apply")
    s.check("answered Replace: two lines of 50 and the old figure is cleared", [r_[0] for r_ in rows_of(
        "SELECT weight FROM gradeh_kpi_lines WHERE person_id=? ORDER BY id", (pid[PFX + "H1"],))] == [50, 50] and H.one(
        a, "SELECT COUNT(*) FROM gradeh_kpi_entries WHERE person_id=?", (pid[PFX + "H1"],)) == 0)

    s.section("who's missing, and the downloads")
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM gradeh_kpi_lines WHERE person_id=?", (pid[PFX + "H2"],))
        db.commit()
    from openpyxl import load_workbook
    for url, cols, needle, avoid in (("/admin/gradeh/export/not-on-list.xlsx", LH, PFX + "H7", PFX + "H1"),
                                     ("/admin/gradeh/export/no-kpi-lines.xlsx", KH, PFX + "H2", PFX + "H1")):
        r = C.get(url)
        wb = load_workbook(io.BytesIO(r.data), read_only=True)
        rr = [list(x) for x in wb.worksheets[0].iter_rows(values_only=True)]
        ids = {str(x[0]) for x in rr[1:]}
        s.check("%s: Excel, the import's own columns first, the person missing is in it and one who isn't is not" % url.split("/")[-1],
                r.status_code == 200 and [str(x) for x in rr[0][:len(cols)]] == cols and needle in ids and avoid not in ids
                and "How to fill" in wb.sheetnames, (rr[0], needle in ids))
    nm = C.get("/admin/gradeh/export/not-on-list.xlsx").headers.get("Content-Disposition", "")
    s.check("the file is named AI+OneHR_..._GradeH_..._date.xlsx", re.search(r"AI\+OneHR_AllBGs_AllBUs_GradeH_NotOnList_\d{4}-\d{2}-\d{2}\.xlsx", nm) is not None, nm)
    s.check("a kept file's issues download is Excel", C.get(LIST + "/check/%s.xlsx?what=issues" % stage(LIST, xfile(LH, big))).data[:2] == b"PK")

    s.section("access: the super admin's alone; dark when the server switch is off; a Year-End cycle only")
    probes = [("GET", "/admin/gradeh"), ("GET", "/admin/gradeh?tab=imports"), ("GET", LIST), ("GET", KPI),
              ("GET", LIST + "/template.xlsx"), ("GET", KPI + "/template.xlsx"), ("GET", "/admin/gradeh/export/not-on-list.xlsx"),
              ("GET", "/admin/gradeh/export/no-kpi-lines.xlsx"), ("POST", LIST), ("POST", KPI)]

    def call(cl, m, u):
        if m == "GET":
            return cl.get(u).status_code
        return cl.post(u, data={"csrf_token": "tok", "preview": "1", "file": (xfile(LH, [[PFX + "H1", "KPI", "", "", "", ""]]), "x.csv")},
                       content_type="multipart/form-data").status_code
    s.check("the super admin reaches every page (200 or the redirect a POST makes)", all(call(C, m, u) in (200, 302) for m, u in probes),
            [(m, u, call(C, m, u)) for m, u in probes if call(C, m, u) not in (200, 302)])
    if CBG:
        got = [(m, u, call(CBG, m, u)) for m, u in probes]
        # /admin/gradeh itself is admin_required since 2026-10-31 (a BG admin whose role has the Grade H item reads People & progress): a BG admin
        # without it is sent back (302) from that page and its Imports tab; every import page and write stays 403
        s.check("a BG admin is refused every one (403, or sent back from /admin/gradeh): no read, no write",
                all(c == 403 or (c == 302 and u.startswith("/admin/gradeh") and "/import" not in u) for _m, u, c in got), got)
    else:
        s.note("no BG admin in this database: that guard is exercised by the employee below")
    got = [(m, u, call(CEMP, m, u)) for m, u in probes]
    s.check("an employee is refused every one", all(c in (403, 404) for _m, _u, c in got), got)
    s.check("the routes are listed as the super admin's in ADMIN_ACCESS_MAP", all(
        a.ADMIN_ACCESS_MAP.get(e) == "super" for e in ("admin_gradeh_import_list", "admin_gradeh_import_kpi")))
    nb = n_people()
    os.environ.pop("ONEHR_GRADEH", None)
    got = [(m, u, call(C, m, u)) for m, u in probes]
    s.check("ONEHR_GRADEH off: every page and write is 404, even for the super admin", all(c == 404 for _m, _u, c in got), got)
    s.check("...and a staged file can't be applied while it is off", step(LIST, tk, "apply").status_code == 404 and n_people() == nb)
    os.environ["ONEHR_GRADEH"] = "1"
    with a.app.test_request_context("/admin"):
        a.session["user_id"] = SU["id"]
        nav = [pg["ep"] for sct in a.ADMIN_SECTIONS if sct["key"] == "gradeh" for t in sct["tabs"] for pg in t["pages"]]
        s.check("the menu entry exists with the page and its two imports", nav[0] == "admin_gradeh" and "admin_gradeh_import_list" in nav
                and "admin_gradeh_import_kpi" in nav, nav)
        on = a._admin_nav_allowed({"ep": "admin_gradeh", "gate": "gradeh"}, a.current_user())
        os.environ.pop("ONEHR_GRADEH", None)
        off = a._admin_nav_allowed({"ep": "admin_gradeh", "gate": "gradeh"}, a.current_user())
        os.environ["ONEHR_GRADEH"] = "1"
        s.check("the menu entry shows for the super admin when the module is on, and not when it is off", on is True and off is False, (on, off))
    sb = C.get("/admin/gradeh").get_data(as_text=True)
    s.check("the sidebar lists Grade H Appraisal when on", "Grade H Appraisal" in sb)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET half=1 WHERE id=?", (CID,))
        db.commit()
    ctx, q = load(a.GRADEH_LIST_KIND, LH, [[PFX + "H1", "KPI", "", "", "", ""]])
    s.check("on a cycle that is not a Year-End the list import stops, saying so", any("Year-End" in e["why"] for e in ctx["errors"]), ctx["errors"])
    ctx, q = load(a.GRADEH_KPI_KIND, KH, [[PFX + "H1", "A", 100, "FIAMMA"]])
    s.check("...and so does the KPI lines import", any("Year-End" in e["why"] for e in ctx["errors"]))
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
        db.commit()

    s.section("the admin page: tabs, the Imports tab, the other tabs (built in piece 6: tests/test_gradeh_admin.py)")
    pg = C.get("/admin/gradeh").get_data(as_text=True)
    s.check("four tabs; the name is Grade H Appraisal; no 'JG H' and no 'HR'",
            all(t in pg for t in ("People &amp; progress", "Imports", "Final bands", "Settings"))
            and "JG H" not in pg and not re.search(r"\bHR\b", pg))
    for t in ("bands", "settings"):
        s.check("the %s tab renders" % t, C.get("/admin/gradeh?tab=%s" % t).status_code == 200)
    s.check("an unknown tab falls back to the first (People & progress)", 'class="gh-tiles' in C.get("/admin/gradeh?tab=zzz").get_data(as_text=True)
            or "Grade H Appraisal runs on a Year-End cycle only" in C.get("/admin/gradeh?tab=zzz").get_data(as_text=True))
    pg = C.get("/admin/gradeh?tab=imports").get_data(as_text=True)
    s.check("the Imports tab: both imports, their templates, the counts, and no who's-missing download (they are on Reports, 2026-11-04)",
            "Import the Grade H list" in pg and "Import the KPI lines" in pg and "import/list/template.xlsx" in pg and "import/kpi/template.xlsx" in pg
            and "not-on-list" not in pg and "no-kpi-lines" not in pg and "on the Grade H list" in pg)
    for u in (LIST, KPI):
        t = C.get(u).get_data(as_text=True)
        s.check("%s: the first page explains it and holds a template link and no 'JG H' / 'HR'" % u, "How it works" in t and "template" in t.lower()
                and "JG H" not in t and not re.search(r"\bHR\b", t))

    s.section("the demo seeder")
    SEED = os.path.join(H.REPO, "deploy", "demo", "seed_gradeh_demo.py")
    s.check("the seeder exists and names only synthetic ZZH ids", os.path.exists(SEED) and "ZZH" in open(SEED).read())
    src = open(SEED).read()
    s.check("it never prints the password hash", not re.search(r"print\([^)]*\bPW\b", src))
    cp = os.path.join(os.path.dirname(a.DB_PATH), "seedtest.db")
    import shutil
    import sqlite3
    for f in os.listdir(os.path.dirname(cp)):   # a crashed earlier run's leftovers
        if f.startswith("seedtest.db"):
            try:
                os.remove(os.path.join(os.path.dirname(cp), f))
            except OSError:
                pass
    c0 = sqlite3.connect(a.DB_PATH)
    c0.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    c0.close()
    shutil.copy(a.DB_PATH, cp)

    def runseed(*args):
        return subprocess.run([sys.executable, SEED, "--db", cp] + list(args), capture_output=True, text=True, cwd=os.path.dirname(cp))

    def cnt(sql):
        c = sqlite3.connect(cp)
        try:
            return c.execute(sql).fetchone()[0]
        finally:
            c.close()
    before = (cnt("SELECT COUNT(*) FROM users"), cnt("SELECT COUNT(*) FROM gradeh_people"), cnt("SELECT COUNT(*) FROM org_units"))
    r = runseed()
    s.check("a dry run says so and writes nothing (users, Grade H people, units unchanged; no snapshot file)",
            r.returncode == 0 and "DRY RUN" in r.stdout and before == (cnt("SELECT COUNT(*) FROM users"), cnt("SELECT COUNT(*) FROM gradeh_people"),
                                                                       cnt("SELECT COUNT(*) FROM org_units"))
            and not [f for f in os.listdir(os.path.dirname(cp)) if f.startswith("seedtest.db.pre-gradeh-demo")], r.stdout + r.stderr)
    r = runseed("--apply")
    snap = [f for f in os.listdir(os.path.dirname(cp)) if f.startswith("seedtest.db.pre-gradeh-demo") and f.endswith(".bak")]
    s.check("--apply copies the database first (integrity ok) and then writes", r.returncode == 0 and "APPLIED" in r.stdout
            and "integrity ok" in r.stdout and snap, r.stdout[-400:] + r.stderr[-400:])
    sc = sqlite3.connect(os.path.join(os.path.dirname(cp), snap[0])) if snap else None
    s.check("the snapshot is a real copy of the database as it was (every user, no ZZH person yet)", bool(snap) and sc.execute(
        "SELECT COUNT(*) FROM users").fetchone()[0] == before[0] and sc.execute(
        "SELECT COUNT(*) FROM users WHERE employee_id GLOB 'ZZH*'").fetchone()[0] == 0)
    if sc:
        sc.close()
    s.check("it never prints a password or a hash", "pbkdf2" not in r.stdout and "Staging" not in r.stdout)
    s.check("31 synthetic people (1 BU CEO, 3 HODs, 3 line managers, 24 Grade H staff), every id ZZH...",
            cnt("SELECT COUNT(*) FROM users WHERE employee_id GLOB 'ZZH*' AND company='Demo Gradeh Unit Alpha'") == 31
            and cnt("SELECT COUNT(*) FROM users WHERE employee_id GLOB 'ZZH*'") == 31)
    s.check("24 are job grade H; 8 on the KPI route with FIAMMA lines totalling 100, 16 on the Line manager route",
            cnt("SELECT COUNT(*) FROM users WHERE employee_id GLOB 'ZZH[0-9]*' AND job_grade='H'") == 24
            and cnt("SELECT COUNT(*) FROM gradeh_people WHERE employee_id GLOB 'ZZH[0-9]*' AND route='A'") == 8
            and cnt("SELECT COUNT(*) FROM gradeh_people WHERE employee_id GLOB 'ZZH[0-9]*' AND route='B'") == 16
            and cnt("SELECT COUNT(*) FROM (SELECT l.person_id FROM gradeh_kpi_lines l JOIN gradeh_people p ON p.id=l.person_id "
                "WHERE p.employee_id GLOB 'ZZH[0-9]*' GROUP BY l.person_id HAVING ABS(SUM(l.weight)-100)<0.01)") == 8
            and cnt("SELECT COUNT(*) FROM gradeh_kpi_lines l JOIN gradeh_people p ON p.id=l.person_id WHERE p.employee_id GLOB "
                    "'ZZH[0-9]*' AND l.group_scale!='FIAMMA'") == 0)
    s.check("four have no line manager, only a supervisor's name as text", cnt(
        "SELECT COUNT(*) FROM gradeh_people p JOIN users u ON u.id=p.user_id WHERE u.manager_id IS NULL AND p.hr_supervisor_name LIKE 'Demo Supervisor%' "
        "AND p.employee_id GLOB 'ZZH[0-9]*'") == 4)
    s.check("a person in each state: not started, keyed, submitted by the line manager, acknowledged, deemed, acknowledged in person",
            cnt("SELECT COUNT(*) FROM gradeh_appraisals WHERE lm_submitted_at IS NOT NULL AND acknowledged_at IS NULL AND deemed_at IS NULL "
                "AND ack_in_person=0") >= 1 and cnt("SELECT COUNT(*) FROM gradeh_appraisals WHERE acknowledged_at IS NOT NULL AND ack_in_person=0") >= 1
            and cnt("SELECT COUNT(*) FROM gradeh_appraisals WHERE deemed_at IS NOT NULL") >= 1
            and cnt("SELECT COUNT(*) FROM gradeh_appraisals WHERE ack_in_person=1") >= 1
            and cnt("SELECT COUNT(*) FROM gradeh_people p WHERE p.employee_id GLOB 'ZZH[0-9]*' AND NOT EXISTS (SELECT 1 FROM gradeh_appraisals x "
                    "WHERE x.person_id=p.id)") >= 1 and cnt("SELECT COUNT(*) FROM gradeh_kpi_entries") >= 1)
    s.check("the demo BU CEO holds the unit's seat, the staff report to their department's line manager and HOD",
            cnt("SELECT COUNT(*) FROM buceo_seats b JOIN users u ON u.id=b.user_id WHERE u.employee_id='ZZHB01'") == 1
            and cnt("SELECT COUNT(*) FROM users s JOIN users m ON m.id=s.manager_id WHERE s.employee_id='ZZH001' AND m.employee_id='ZZHM01'") == 1
            and cnt("SELECT COUNT(*) FROM users s JOIN users h ON h.id=s.hod_id WHERE s.employee_id='ZZH001' AND h.employee_id='ZZHD01'") == 1)
    s.check("the gradeh module is ticked on the Year-End cycle", cnt("SELECT active FROM cycle_modules WHERE module_key='gradeh'") == 1)
    s.check("the six Grade H parts are DATED on the calendar (an undated part is not open on a cycle that opens by date)",
            cnt("SELECT COUNT(*) FROM cycle_windows WHERE cell LIKE 'gradeh_%' AND opens_at IS NOT NULL AND closes_at IS NOT NULL") == 6)
    _c = sqlite3.connect(cp)
    _c.execute("UPDATE cycle_windows SET opens_at='2026-01-02 00:00', closes_at='2026-12-30 23:59' WHERE cell='gradeh_lm'")
    _c.commit()
    _c.close()
    runseed("--apply")
    s.check("a re-run never moves a date the super admin already set",
            cnt("SELECT COUNT(*) FROM cycle_windows WHERE cell='gradeh_lm' AND opens_at='2026-01-02 00:00' AND closes_at='2026-12-30 23:59'") == 1)
    a_ = (cnt("SELECT COUNT(*) FROM users"), cnt("SELECT COUNT(*) FROM gradeh_people"), cnt("SELECT COUNT(*) FROM gradeh_kpi_lines"),
          cnt("SELECT COUNT(*) FROM gradeh_lp_answers"))
    runseed("--apply")
    s.check("idempotent: a second --apply leaves the same counts", a_ == (cnt("SELECT COUNT(*) FROM users"), cnt("SELECT COUNT(*) FROM gradeh_people"),
                                                                          cnt("SELECT COUNT(*) FROM gradeh_kpi_lines"), cnt("SELECT COUNT(*) FROM gradeh_lp_answers")))
    r = runseed("--apply", "--undo")
    s.check("--undo removes exactly the ZZH people and their rows", r.returncode == 0 and cnt("SELECT COUNT(*) FROM users WHERE employee_id GLOB 'ZZH*'") == 0
            and cnt("SELECT COUNT(*) FROM gradeh_people WHERE employee_id GLOB 'ZZH*'") == 0
            and cnt("SELECT COUNT(*) FROM users") == before[0], r.stdout[-300:] + r.stderr[-300:])
    r = runseed("--db", "/nonexistent/x.db")
    s.check("a missing database is refused, not created", r.returncode != 0 and not os.path.exists("/nonexistent/x.db"))
    for f in os.listdir(os.path.dirname(cp)):
        if f.startswith("seedtest.db"):
            try:
                os.remove(os.path.join(os.path.dirname(cp), f))
            except OSError:
                pass
finally:
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    else:
        os.environ["ONEHR_GRADEH"] = _ENV0
sys.exit(s.done())
