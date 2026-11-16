"""The "People with no ..." downloads, each in its import's own columns, and back in (Chris, 2026-10-21: "it should also
have the export for people without KPI line, 360 panel, competency too. so admin can export them in excel and update the
list and import back. So the export needs to follow our import format").

What this suite holds:
  * each download's columns are its import's, then the Reference: columns, with a How to fill sheet; one row a person,
    only the Employee ID filled; the people are the module's own count, and a BG admin's file holds their group only
  * the round trips: the file filled in for one of ours imports their KPI line, their rater, their job and its
    competencies; every row left as it is is skipped, said so; nothing else changes
  * the job code import: all or nothing (a code not at their grade, a code with two job scopes and none given, the
    template's example row each turn the file away), the job scope column picks the profile; a View only BG admin
    downloads but can't import
  * the panel template no longer seeds real Employee IDs

Self-contained: its own group, units, people, jobs and competencies (ZZ9IE- / ZQI- / ZZIE-), deleted at the end.
"""
import html
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from openpyxl import Workbook, load_workbook  # noqa: E402

a = H.setup()
s = H.Suite("The People with no ... downloads, in their imports' columns, and back in")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, OT = "ZZIE Group", "ZZIE Unit", "ZZIE Other Group"
PFX = "ZZ9IE-"
P = {}


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9IE-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM tc_assignments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM tc_assessments WHERE subject_id IN (%s)" % ph, ul)
        tids = "SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (%s)" % tids, ul)
        db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN (%s)" % tids, ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM ja_people WHERE employee_id LIKE 'ZZ9IE-%'")
    db.execute("DELETE FROM ja_taxonomy WHERE code LIKE 'ZQI%'")
    db.execute("DELETE FROM tc_job_profile_skills WHERE profile_id IN (SELECT id FROM tc_job_profiles WHERE job_code "
               "LIKE 'ZQI-%')")
    db.execute("DELETE FROM tc_job_profiles WHERE job_code LIKE 'ZQI-%'")
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZIE-%'")
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, OT))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM admin_role_access WHERE role_id IN (SELECT id FROM admin_roles WHERE name='ZZIE roster role')")
    db.execute("DELETE FROM admin_roles WHERE name='ZZIE roster role'")
    db.commit()


def uid(eid):
    r = H.rows(a, "SELECT id FROM users WHERE employee_id=?", (eid,))
    return r[0][0] if r else 0


def book(client, url):
    """(status, header, body rows, sheet titles) of a download."""
    r = client.get(url)
    if r.status_code != 200 or r.data[:2] != b"PK":
        return r.status_code, None, [], []
    wb = load_workbook(io.BytesIO(r.data), read_only=True)
    rows = [["" if v is None else v for v in x] for x in wb.worksheets[0].iter_rows(values_only=True)]
    return 200, rows[0], rows[1:], [w.title for w in wb.worksheets]


def refill(head, body, fills):
    """The same file with these people's cells filled ({eid: {column: value}} or [{...}] for several rows), as .xlsx."""
    wb = Workbook()
    ws = wb.active
    ws.append(head)
    for r in body:
        for want in (fills.get(r[0]) if isinstance(fills.get(r[0]), list) else [fills.get(r[0])]):
            row = list(r)
            for k, v in (want or {}).items():
                row[head.index(k)] = v
            ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return io.BytesIO(buf.getvalue())


def upload(client, url, f, **extra):
    data = dict({"csrf_token": "tok", "file": (f, "back.xlsx")}, **extra)
    if extra.get("preview"):   # step 1 only
        r = client.post(url, data=data, content_type="multipart/form-data", follow_redirects=True)
    else:   # all four steps: the one-shot post is gone (1a-01); what stops it is on the page it ends on
        r = H.import_steps(client, url, data)
    return r.status_code, r.get_data(as_text=True)


def n_list(client, url):
    m = re.search(r'data-list-n="(\d+)"', client.get(url).get_data(as_text=True))
    return int(m.group(1)) if m else -1


try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        CID = a.active_cycle_id(db)
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?)", (BG, CO, OT, CO))
        db.execute("INSERT OR IGNORE INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
        SK = {}
        for t in ("S1", "S2", "S3", "S4", "S5"):
            for lv in (3, 4):
                SK[(t, lv)] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, active) VALUES "
                                         "(?,?,?, 'tsc', 1)", ("ZZIE-%s-%d" % (t, lv), "ZZIE Skill " + t, lv)).lastrowid

        def prof(code, title, scope=None):
            pid = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, job_scope, "
                             "plan_mode, source, active) VALUES ('ZZIE Dept', ?, ?, ?, ?, 'explicit', 'architecture', 1)",
                             (title, code.rsplit("-", 1)[1], code, scope)).lastrowid
            for i, t in enumerate(("S1", "S2", "S3", "S4", "S5")):
                for fut, lv in ((0, 3), (1, 4)):
                    db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, "
                               "is_future) VALUES (?,?,?,?,?)", (pid, SK[(t, lv)], lv, i, fut))
            P[(code, scope)] = pid
        prof("ZQI-OPS-01-14", "Senior Executive, Zqiops")
        prof("ZQI-OPS-01-16", "Manager, Zqiops")   # a real job, two grades up: the grade check must refuse it
        prof("ZQI-OPS-02-14", "Senior Executive, Zqiops North", "NORTH")
        prof("ZQI-OPS-02-14", "Senior Executive, Zqiops South", "SOUTH")
        for code, lvl, parent in (("ZQI", "family", None), ("ZQI-OPS", "sub", "ZQI"), ("ZQI-OPS-01", "spec", "ZQI-OPS"),
                                  ("ZQI-OPS-02", "spec", "ZQI-OPS")):
            db.execute("INSERT INTO ja_taxonomy(code, level, parent_code, name) VALUES (?,?,?,?)",
                       (code, lvl, parent, code))

        def mk(eid, bg=BG, role="user", admin_bg=None, conf="2020-01-01"):
            return db.execute(
                "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                "department, job_grade, confirmation_date, admin_bg) VALUES (?,?, 'x', ?,?,?,?, 'ZZIE Dept', '14', "
                "?, ?)", (eid.lower(), "ZZ IE " + eid[len(PFX):], role, eid, bg, CO, conf, admin_bg)).lastrowid
        U = {k: mk(PFX + k) for k in ("A", "B", "C", "R", "D", "SELF", "GONE", "LEFTM", "E")}
        # the line manager file: SELF is their own manager, LEFTM's manager has left, E has a manager still here
        db.execute("UPDATE users SET left_at='2026-01-31 00:00:00' WHERE id=?", (U["GONE"],))
        db.execute("UPDATE users SET manager_id=id WHERE id=?", (U["SELF"],))
        db.execute("UPDATE users SET manager_id=? WHERE id=?", (U["GONE"], U["LEFTM"]))
        db.execute("UPDATE users SET manager_id=? WHERE id=?", (U["R"], U["E"]))
        # someone in a group Org structure doesn't list, with no line manager: their row must still go back in
        U["NOORG"] = mk(PFX + "NOORG", bg="ZZIE Unlisted Group")
        U["NOCONF"] = mk(PFX + "NOCONF", conf=None)          # Basic: no confirmation date
        db.execute("UPDATE users SET hod_id=? WHERE id=?", (U["R"], U["E"]))   # E has an HOD still here
        mk(PFX + "O", bg=OT)
        BGADM = mk(PFX + "ADM", role="admin", admin_bg=BG)
        D = U["D"]
        # D has it all: a rater, a KPI line, competencies -- in none of the three files
        db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) VALUES "
                   "(?,?,?, 'peer', 'pending')", (CID, D, U["R"]))
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, "
                   "company, status) VALUES (?,?, 'ZZIE KPI', 100, 'more', ?, ?, 'approved')", (CID, D, BG, CO))
        a._tc_assign_from_profile(db, CID, D, P[("ZQI-OPS-01-14", None)])
        db.commit()
        DBG = a.display_bg(BG)
    SUP, ADM = H.client_as(a, SU["id"]), H.client_as(a, BGADM)
    REF = list(a.IMPORT_REFERENCE_COLUMNS)
    OURS = {PFX + "A", PFX + "B", PFX + "C"}

    s.section("each file: its import's columns, then the reference columns; one row a person")
    files = {"pm": ("/admin/export/no-kpi-lines.xlsx", list(a.KPI_TARGETS_IMPORT_COLUMNS), [],
                    "/admin/list/mod-pm?fstage=not_started&fragment=1"),
             "f360": ("/admin/export/no-panel.xlsx", list(a.PANEL_IMPORT_COLUMNS), [], None),
             "competency": ("/admin/export/no-competencies.xlsx", list(a.JOB_IMPORT_COLUMNS),
                            ["Reference: job code now"], "/admin/list/mod-competency?fstage=not_assigned&fragment=1")}
    got = {}
    for key, (url, cols, extra, lst) in files.items():
        code, head, body, sheets = book(SUP, url)
        got[key] = (head, body)
        s.check("%-10s the import's own columns, then Reference:, and a How to fill sheet" % key,
                code == 200 and head == cols + REF + extra and sheets[1:] == ["How to fill", "About"], (code, head, sheets))
        ids = {r[0] for r in body}
        s.check("%-10s ours with nothing are in it, the one who has it all is not" % key,
                OURS <= ids and PFX + "D" not in ids, (sorted(OURS - ids), PFX + "D" in ids))
        s.check("%-10s only the Employee ID is filled in the import's columns" % key,
                body and all(r[0] and all(v == "" for v in r[1:len(cols)]) for r in body))
        if lst:
            s.check("%-10s as many rows as the Overview's own list counts" % key, len(body) == n_list(SUP, lst),
                    (len(body), n_list(SUP, lst)))
    with a.app.app_context():
        chk = next(c for c in a.DATA_CHECKS if c["key"] == "no_panel")
        n_np = len(a.get_db().execute(chk["sql"], {"cid": CID}).fetchall())
    s.check("f360       as many rows as Data integrity's 'no panel at all'", len(got["f360"][1]) == n_np,
            (len(got["f360"][1]), n_np))
    s.check("the reference columns name the person and their group",
            next(r for r in got["pm"][1] if r[0] == PFX + "A")[len(a.KPI_TARGETS_IMPORT_COLUMNS):][:2]
            == ["ZZ IE A", DBG])

    s.section("a BG admin's files: their group only (a download is read only)")
    for key, (url, cols, _x, _l) in files.items():
        code, head, body, _s = book(ADM, url)
        bgs = {r[len(cols) + 1] for r in body}
        s.check("%-10s downloads, their group's people only" % key, code == 200 and OURS <= {r[0] for r in body}
                and PFX + "O" not in {r[0] for r in body} and bgs == {DBG}, (code, bgs))

    s.section("round trip: the KPI file, one person filled in")
    head, body = got["pm"]
    n0 = H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=?", (CID,))
    kfill = {PFX + "A": {
        "KPI": "ZZIE Sales", "Strategic Thrust / Category": "Financial", "KPI Description": "ZZIE line",
        "Unit of Measure": "RM", "Weightage": 100, "Method": "More", "Rate 1": 60, "Rate 2": 70, "Rate 3": 80,
        "Rate 4": 90, "Rate 5": 100}}
    qpage = upload(SUP, "/admin/performance/import", refill(head, body, kfill), preview="1")[1]   # step 2 says the rest
    code, page = upload(SUP, "/admin/performance/import", refill(head, body, kfill))
    s.check("their line is in, nobody else's", code == 200 and [tuple(x) for x in H.rows(
        a, "SELECT kpi_name FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (CID, uid(PFX + "A")))]
        == [("ZZIE Sales",)] and H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=?", (CID,)) == n0 + 1,
        H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=?", (CID,)) - n0)
    s.check("...and the page says the rest were skipped, not filled in yet",
            "%d rows had only an Employee ID" % (len(body) - 1) in qpage, len(body) - 1)

    s.section("round trip: the panel file, one rater filled in")
    head, body = got["f360"]
    n0 = H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND archived=0", (CID,))
    code, page = upload(SUP, "/admin/import", refill(head, body, {
        PFX + "A": {"Assessor Employee ID": PFX + "R", "Relationship": "peer"},
        PFX + "B": {"Assessor Employee ID": "ZZ9IE-NOBODY", "Relationship": "peer"}}))
    s.check("all or nothing: one bad row turns the whole file away, the good row not added either",
            "Unknown Employee ID" in page and "fix them in your file and choose it again" in page and H.one(
                a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND archived=0", (CID,)) == n0)
    n0 = H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND archived=0", (CID,))
    pfill = {PFX + "A": {"Assessor Employee ID": PFX + "R", "Relationship": "peer"}}
    qpage = upload(SUP, "/admin/import", refill(head, body, pfill), preview="1")[1]
    code, page = upload(SUP, "/admin/import", refill(head, body, pfill))
    s.check("their rater is on their panel, nobody else's changed", code == 200 and [tuple(x) for x in H.rows(
        a, "SELECT assessor_id, relationship FROM assignments WHERE cycle_id=? AND subject_id=? AND archived=0",
        (CID, uid(PFX + "A")))] == [(uid(PFX + "R"), "peer")]
        and H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND archived=0", (CID,)) == n0 + 1,
        re.findall(r'class="flash[^"]*"[^>]*>(.*?)<', page, re.S)[:4])
    s.check("...the rest skipped, said so", "rows had only an Employee ID" in qpage)

    s.section("the job code import: all or nothing")
    head, body = got["competency"]
    cases = (("a code not at their grade", {PFX + "C": {"Job code": "ZQI-OPS-01-16"}},
              "Not at their grade"),
             ("a code with two job scopes and none given", {PFX + "C": {"Job code": "ZQI-OPS-02-14"}},
              "Job scope needed or unknown"),
             ("a scope the code doesn't have", {PFX + "C": {"Job code": "ZQI-OPS-02-14", "Job scope": "EAST"}},
              "Job scope needed or unknown"),
             ("a code nobody has", {PFX + "C": {"Job code": "ZQI-NONE-01-14"}}, "No such job code"))
    for what, fills, said in cases:
        code, page = upload(SUP, "/admin/competency/import-jobs", refill(head, body, dict(
            fills, **{PFX + "A": {"Job code": "ZQI-OPS-01-14"}})))
        s.check("%s turns the file away, said (step 2 names its kind), nothing placed" % what, said in page
                and "1 row can't be imported" in html.unescape(page)
                and H.one(a, "SELECT COUNT(*) FROM tc_assignments WHERE cycle_id=? AND subject_id IN (?,?)",
                          (CID, uid(PFX + "A"), uid(PFX + "C"))) == 0, said)
    tf = io.BytesIO(SUP.get("/admin/competency/import-jobs/template.xlsx").data)
    code, page = upload(SUP, "/admin/competency/import-jobs", tf)
    s.check("the template uploaded as it is: its example row refused", "example row" in page)

    s.section("round trip: the job code file")
    code, page = upload(SUP, "/admin/competency/import-jobs", refill(head, body, {
        PFX + "A": {"Job code": "ZQI-OPS-01-14"}, PFX + "B": {"Job code": "ZQI-OPS-02-14", "Job scope": "south"}}),
        preview="1")
    s.check("Check the file keeps it for the four steps and changes nothing", "2 · Quality" in page
            and "Continue to the changes" in page and H.one(
                a, "SELECT COUNT(*) FROM tc_assignments WHERE cycle_id=? AND subject_id=?", (CID, uid(PFX + "A"))) == 0)
    jq = page
    tok_ = (re.search(r'name="token" value="([0-9a-f]{32})"', page) or [None, ""])[1]
    SUP.post("/admin/competency/import-jobs", data={"csrf_token": "tok", "token": tok_, "action": "quality_ok",
                                                    "ack": "1"})
    page = SUP.get("/admin/competency/import-jobs?check=%s&step=changes" % tok_).get_data(as_text=True)
    s.check("...its changes list each person's job from the file, B on the South scope",
            "Senior Executive, Zqiops South" in page and "ZQI-OPS-01-14" in page)
    code, page = upload(SUP, "/admin/competency/import-jobs", refill(head, body, {
        PFX + "A": {"Job code": "ZQI-OPS-01-14"}, PFX + "B": {"Job code": "ZQI-OPS-02-14", "Job scope": "south"}}))
    n_a = H.one(a, "SELECT COUNT(*) FROM tc_assignments WHERE cycle_id=? AND subject_id=?", (CID, uid(PFX + "A")))
    s.check("their jobs are placed and they have the job's competencies (5 current + 5 next)",
            n_a == 10 and H.one(a, "SELECT COUNT(*) FROM tc_assignments WHERE cycle_id=? AND subject_id=?",
                                (CID, uid(PFX + "B"))) == 10
            and H.one(a, "SELECT spec_code FROM ja_people WHERE employee_id=?", (PFX + "A",)) == "ZQI-OPS-01", n_a)
    s.check("...B on the South job, as the Job scope column said", "Zqiops South" in (H.one(
        a, "SELECT detail FROM activity_log WHERE action='ja_place_job' AND target_user_id=? ORDER BY id DESC LIMIT 1",
        (uid(PFX + "B"),)) or ""))
    s.check("...C, left as it was, untouched, and the rest said as skipped", H.one(
        a, "SELECT COUNT(*) FROM tc_assignments WHERE cycle_id=? AND subject_id=?", (CID, uid(PFX + "C"))) == 0
        and "rows had only an Employee ID" in jq and "2 jobs placed" in page)

    s.section("who may import back: as today")
    r = ADM.post("/admin/competency/import-jobs", data={"csrf_token": "tok", "file": (refill(
        head, body, {PFX + "C": {"Job code": "ZQI-OPS-01-14"}}), "x.xlsx")}, content_type="multipart/form-data")
    s.check("a View only BG admin can't import job codes (403), nothing placed", r.status_code == 403 and H.one(
        a, "SELECT COUNT(*) FROM tc_assignments WHERE cycle_id=? AND subject_id=?", (CID, uid(PFX + "C"))) == 0)
    run = next(t for sec in a.ADMIN_SECTIONS if sec["key"] == "competency" for t in sec["tabs"] if t["key"] == "run")
    s.check("...the page is in Competency > Run", "admin_import_jobs" in [p_["ep"] for p_ in run["pages"]])

    s.section("the line manager file: the roster import's columns (Chris, 2026-10-21)")
    code, head, body, sheets = book(SUP, "/admin/export/no-line-manager.xlsx")
    s.check("the roster import's own columns, then Reference:, and a How to fill sheet", code == 200
            and head == list(a.ROSTER_COLUMNS) + ["Reference: line manager now", "Reference: HOD"]
            and sheets[1:] == ["How to fill", "About"], (code, head))
    by = {r[0]: dict(zip(head, r)) for r in body}
    s.check("none on file, their own, or one who has left: in it; someone with a manager still here: not",
            {PFX + "A", PFX + "SELF", PFX + "LEFTM"} <= set(by) and PFX + "E" not in by and PFX + "GONE" not in by)
    s.check("...each says which", (by[PFX + "A"]["Reference: line manager now"], by[PFX + "SELF"][
        "Reference: line manager now"], by[PFX + "LEFTM"]["Reference: line manager now"])
        == ("none on file", "themselves", "ZZ IE GONE (left)"))
    s.check("...the cells the roster import needs are filled in, Manager is blank",
            (by[PFX + "A"]["Employee Name"], by[PFX + "A"]["Business Group"], by[PFX + "A"]["Company"],
             str(by[PFX + "A"]["Job Grade"]), by[PFX + "A"]["Manager"]) == ("ZZ IE A", BG, CO, "14", ""),
            [by[PFX + "A"][k] for k in ("Employee Name", "Business Group", "Company", "Job Grade", "Manager")])
    with a.app.app_context():
        d_ = a.get_db()
        want = set()
        for k in ("no_manager", "self_manager", "manager_left"):
            chk = next(c for c in a.DATA_CHECKS if c["key"] == k)
            want |= {r[0] for r in d_.execute(chk["sql"], {"cid": CID}).fetchall()}
    s.check("the same people as Data integrity's three line manager checks", set(by) == want,
            (len(set(by) - want), len(want - set(by))))
    code, head2, body2, _s = book(ADM, "/admin/export/no-line-manager.xlsx")
    s.check("a BG admin's file: their group only", code == 200 and PFX + "A" in {r[0] for r in body2}
            and {r[head2.index("Business Group")] for r in body2} == {BG}, code)

    s.section("round trip: the line manager file through the roster import")
    n_act = H.one(a, "SELECT COUNT(*) FROM users WHERE left_at IS NULL")
    code, page = upload(SUP, "/admin/import/roster", refill(head, body, {PFX + "LEFTM": {"Manager": PFX + "R"}}),
                        mode="authoritative")
    s.check("as a full roster it's refused, said, nobody closed or changed", "partial download" in page and H.one(
        a, "SELECT COUNT(*) FROM users WHERE left_at IS NULL") == n_act and H.one(
        a, "SELECT manager_id FROM users WHERE id=?", (U["LEFTM"],)) == U["GONE"],
        (re.findall(r'class="flash[^"]*"[^>]*>(.*?)<', page, re.S)[:2],
         H.one(a, "SELECT COUNT(*) FROM users WHERE employee_id LIKE 'ZZ9IE-%' AND left_at IS NULL")))
    COLS_ = ("full_name, business_group, company, department, job_title, job_grade, email, manager_id, hod_id, "
             "joined_date, confirmation_date, years_of_service, employment_type, cost_center, work_location, left_at")
    snap = lambda: {r[0]: tuple(r[1:]) for r in H.rows(a, "SELECT employee_id, %s FROM users WHERE role!='admin'"
                                                          % COLS_)}   # noqa: E731
    before = snap()
    code, page = upload(SUP, "/admin/import/roster", refill(head, body, {PFX + "LEFTM": {"Company": "ZZIE Nowhere"}}),
                        mode="upsert")
    s.check("moving someone into a unit Org structure lacks is still refused", "isn&#39;t a unit in Org structure"
            in page and snap() == before)
    code, page = upload(SUP, "/admin/import/roster", refill(head, body, {
        PFX + "LEFTM": {"Manager": PFX + "R"}, PFX + "NOORG": {"Manager": PFX + "R"}}), mode="upsert")
    after = snap()
    moved = sorted(k for k in after if after[k] != before.get(k))
    diff = [i for i, (x, y) in enumerate(zip(before.get(PFX + "LEFTM", ()), after.get(PFX + "LEFTM", ()))) if x != y]
    s.check("their line managers are set, the one in a group Org lacks too; nothing else on anyone changed "
            "(every roster field, %d people in the file)" % len(body),
            moved == [PFX + "LEFTM", PFX + "NOORG"] and diff == [7] and after[PFX + "LEFTM"][7] == U["R"]
            and after[PFX + "NOORG"][7] == U["R"],
            (moved[:5], diff, [(k, before.get(k), after[k]) for k in moved[:2]]))

    s.section("People with no confirmation date: the roster's columns, the super admin dates them")
    code, head, body, sheets = book(SUP, "/admin/export/no-confirmation-date.xlsx")
    s.check("the roster import's columns, then Reference:", code == 200 and head == list(a.ROSTER_COLUMNS) + [
        "Reference: joined date", "Reference: years of service", "Reference: line manager",
        "Reference: line manager employee ID"], head)
    ids = {r[0] for r in body}
    s.check("...no date: in it; dated: not", PFX + "NOCONF" in ids and PFX + "A" not in ids)
    bad = refill(head, body, {PFX + "NOCONF": {"Confirmation Date": "31/31/2026"}})
    with a.app.test_request_context("/"):
        chk = a._roster_check(a.get_db(), dict(SU), a._xlsx_records(bad.getvalue()), False)
        look = {g["key"]: g for g in a._roster_quality(a.get_db(), dict(SU), chk)["look"]}
    s.check("a date OneHR can't read isn't a reason to stop the file: the quality step shows it (canvas D5)",
            not chk["errors"] and "'31/31/2026'" in " ".join(f["detail"] for f in look.get("date_bad", {}).get(
                "found", [])), (chk["errors"][:2], sorted(look)))
    bad.seek(0)
    code, page = upload(SUP, "/admin/import/roster", bad, mode="upsert")
    s.check("...and it isn't written: they keep what they have (it used to be stored as typed)",
            H.one(a, "SELECT confirmation_date FROM users WHERE id=?", (U["NOCONF"],)) is None)
    with a.app.test_request_context("/"):
        recs = a._xlsx_records(refill(head, body, {PFX + "NOCONF": {"Confirmation Date": "21/10/2026"}}).getvalue())
        chk = a._roster_check(a.get_db(), dict(SU), recs, False)
        cc = [c for c in chk["changes"] if c["eid"] == PFX + "NOCONF"]
    s.check("the change list shows the date to set, read day/month/year", not chk["errors"] and [
        (c["field"], c["to"]) for c in cc] == [("Confirmation date", "2026-10-21")], (chk["errors"][:2], cc))
    give = lambda items: H.rows(a, "SELECT 1")   # noqa: E731
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT OR IGNORE INTO admin_roles(name, scope_kind) VALUES ('ZZIE roster role', 'group')")
        rid_ = d_.execute("SELECT id FROM admin_roles WHERE name='ZZIE roster role'").fetchone()[0]
        d_.execute("DELETE FROM admin_role_access WHERE role_id=?", (rid_,))
        d_.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)",
                       [(rid_, k) for k in sorted(a.role_preset_items("view")) + ["people.roster", "people.details"]])
        d_.execute("UPDATE users SET admin_role_id=? WHERE id=?", (rid_, BGADM))
        d_.commit()
    code, page = upload(ADM, "/admin/import/roster", refill(head, body, {PFX + "NOCONF": {
        "Confirmation Date": "2026-10-21"}}), mode="upsert")
    s.check("another admin's import (holding the roster) leaves the date as it is", code == 200 and H.one(
        a, "SELECT confirmation_date FROM users WHERE id=?", (U["NOCONF"],)) is None, code)
    code, page = upload(SUP, "/admin/import/roster", refill(head, body, {PFX + "NOCONF": {
        "Confirmation Date": "21/10/2026"}}), mode="upsert")
    s.check("the super admin's sets it, stored as a date", H.one(
        a, "SELECT confirmation_date FROM users WHERE id=?", (U["NOCONF"],)) == "2026-10-21")

    s.section("People short of a full panel: the panel import's columns, their raters beside them")
    code, head, body, sheets = book(SUP, "/admin/export/short-panel.xlsx")
    s.check("the panel import's columns, then Reference:", code == 200 and head == list(a.PANEL_IMPORT_COLUMNS) + REF
            + ["Reference: raters now", "Reference: raters", "Reference: panel target"], head)
    byp = {r[0]: dict(zip(head, r)) for r in body}
    s.check("...one rater: in it, with who rates them now", PFX + "D" in byp and str(byp[PFX + "D"][
        "Reference: raters now"]) == "1" and byp[PFX + "D"]["Reference: raters"] == "ZZ IE R (peer)",
        byp.get(PFX + "D"))
    s.check("...as many rows as the 360 Overview's own list", len(body) == n_list(
        SUP, "/admin/list/f360-short?fragment=1"), (len(body), n_list(SUP, "/admin/list/f360-short?fragment=1")))
    code, page = upload(SUP, "/admin/import", refill(head, body, {PFX + "D": {
        "Assessor Employee ID": PFX + "B", "Relationship": "peer"}}))
    s.check("adding a rater from it: two now, the first kept", sorted(tuple(x) for x in H.rows(
        a, "SELECT assessor_id, relationship FROM assignments WHERE cycle_id=? AND subject_id=? AND archived=0",
        (CID, U["D"]))) == sorted([(U["R"], "peer"), (U["B"], "peer")]))

    s.section("People with no HOD, and the roster's HOD checks (the Leaders page's)")
    code, head, body, sheets = book(SUP, "/admin/export/no-hod.xlsx")
    s.check("the roster import's columns, then Reference:", code == 200 and head == list(a.ROSTER_COLUMNS) + [
        "Reference: HOD now", "Reference: line manager", "Reference: line manager employee ID"], head)
    ids = {r[0] for r in body}
    s.check("...no HOD: in it; an HOD still here: not", PFX + "A" in ids and PFX + "E" not in ids)
    for what, fills, said in (
            ("their own HOD", {PFX + "A": {"HOD": PFX + "A"}}, "nobody is their own HOD"),
            ("an HOD who has left", {PFX + "A": {"HOD": PFX + "GONE"}}, "has left")):
        code, page = upload(SUP, "/admin/import/roster", refill(head, body, fills), mode="upsert")
        s.check("%s is refused, said, nothing changed" % what, said in page and H.one(
            a, "SELECT hod_id FROM users WHERE id=?", (U["A"],)) is None, said)
    # any person may be HOD of people in another business group (Chris, 2026-11-09): the super admin's file loads it, with
    # no allowance set and no flag for it; it is put back so the checks below start from the same state
    code, page = upload(SUP, "/admin/import/roster", refill(head, body, {PFX + "A": {"HOD": PFX + "O"}}), mode="upsert")
    o_id = H.one(a, "SELECT id FROM users WHERE employee_id=?", (PFX + "O",))
    s.check("an HOD in another business group is accepted from the super admin's file (nothing held, nothing flagged)",
            H.one(a, "SELECT hod_id FROM users WHERE id=?", (U["A"],)) == o_id and o_id is not None
            and H.one(a, "SELECT business_group FROM users WHERE id=?", (o_id,)) != H.one(
                a, "SELECT business_group FROM users WHERE id=?", (U["A"],)) and "not business groups" not in page,
            re.findall(r'class="flash[^"]*"[^>]*>(.*?)<', page, re.S)[:2])
    with a.app.app_context():
        a.get_db().execute("UPDATE users SET hod_id=NULL WHERE id=?", (U["A"],))
        a.get_db().commit()
    code, page = upload(SUP, "/admin/import/roster", refill(head, body, {PFX + "A": {"HOD": PFX + "R"}}),
                        mode="upsert")
    s.check("a good HOD is set", H.one(a, "SELECT hod_id FROM users WHERE id=?", (U["A"],)) == U["R"],
            re.findall(r'class="flash[^"]*"[^>]*>(.*?)<', page, re.S)[:2])

    s.section("the panel template no longer seeds real people")
    tw = load_workbook(io.BytesIO(SUP.get("/admin/import/template.xlsx").data), read_only=True).worksheets[0]
    trows = [list(x) for x in tw.iter_rows(values_only=True)]
    s.check("its rows are EXAMPLE- placeholders the import refuses", trows[0] == list(a.PANEL_IMPORT_COLUMNS)
            and trows[1:] and all(str(r[0]).startswith("EXAMPLE-") and str(r[1]).startswith("EXAMPLE-")
                                  for r in trows[1:]), trows[:2])
finally:
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
