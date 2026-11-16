"""The three libraries' downloads on Reports > Data downloads (Chris, 10 Nov 2026): the KPI library, the competency library
and the career routes, each an Excel file, the super admin's alone.

What this suite holds:
  * each is a valid .xlsx for the super admin, named by the one pattern (_dl_filename), with an About sheet, and each download
    writes an `export` row to the activity log; each has its row on Reports (the right card, no panel: they download straight)
  * a BG admin and a unit admin are refused (403) and never see the three rows on Reports; the Roles & access page lists them
    among the super admin's
  * the KPI library file: sheet one is the library import's columns in its order, then the read-only ones; no number column
    and a seeded rate / target / weight never appears; a retired row says Active = No; a variant row names its parent; a
    list of grades or departments is written where the import cannot say it; the file goes back through the library import's
    check with nothing to change, and an altered cell is found (falsified); a row sharing an import key is flagged
  * the competency library file: Jobs (a row for each competency a job asks of its holders, Current and Next, read against the
    profile's own rows) and Competencies (a row for every written level, its jobs, whether it waits for P&R)
  * the career routes file: every offered move is the side panel's own (tc_route_groups, worked out job by job), a hidden move is
    marked Hidden, a pinned one Pinned, a target role nobody holds is flagged, and the file's batch read (tc_routes_ctx)
    gives every job the routes it gets without it
Synthetic (ZZLX-*) on a fresh scratch database.
"""
import io
import os
import random
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("The libraries' downloads: KPI library, competency library, career routes")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
from openpyxl import load_workbook  # noqa: E402

SU, _BGA0, EMP = H.actors(a)
db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
BG, UNIT, DEPT = "ZZLX Group", "ZZLX Unit", "ZZLX Dept"
EPS = {"admin_export_kpi_library": ("pm", "KPI library", "Performance", "KPI_library"),
       "admin_export_competency_library": ("competency", "Competency library", "Competency", "Competency_library"),
       "admin_export_career_routes": ("idp", "Career routes", "CareerPlan", "Career_routes")}
with a.app.test_request_context("/"):
    URL = {ep: a.url_for(ep) for ep in EPS}
HUB = "/admin/reports/all?kind=data"


def one(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return r[0] if r else None


def book(c, url):
    """(response, sheets as {title: rows incl. header}) of a download."""
    r = c.get(url)
    if r.status_code != 200 or r.data[:2] != b"PK":
        return r, {}
    wb = load_workbook(io.BytesIO(r.data), read_only=True)
    # a blank cell reads back as None: said as "" so a test compares what the file says
    return r, {w.title: [["" if v is None else v for v in x] for x in w.iter_rows(values_only=True)] for w in wb.worksheets}


def col(rows, name):
    i = [str(x) for x in rows[0]].index(name)
    return [r[i] for r in rows[1:]]


def n_exports():
    return one("SELECT COUNT(*) FROM activity_log WHERE action='export'")


# ---- the accounts ------------------------------------------------------------------------------------------------------------------
db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, UNIT))
BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                 "VALUES ('zzlx-bga', 'ZZ LX Groupadmin', 'x', 'admin', 'ZZLX-BGA', ?, ?)", (BG, BG)).lastrowid
UNA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                 "VALUES ('zzlx-una', 'ZZ LX Unitadmin', 'x', 'admin', 'ZZLX-UNA', ?, ?)", (BG, BG)).lastrowid
db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?, ?)", (UNA, UNIT))
db.commit()
SUC, BAC, UAC = H.client_as(a, SU["id"]), H.client_as(a, BGA), H.client_as(a, UNA)

# ---- the KPI library: seeded rows, each carrying figures the file must never show ---------------------------------------------------
NUM = 424242.5


def lib(name, **kw):
    v = dict(business_group=BG, company="*", department="*", tier_n=0, job_grade="*", kpi_name=name, category="ZZLX Fin · Sales",
             description="ZZLX what it measures", unit="%", method="more", perspective="Financial", bu_level=0, active=1,
             job_grades=None, departments=None, department_mode="include",
             rate1=NUM, rate2=NUM, rate3=NUM, rate4=NUM, rate5=NUM, threshold=NUM, target=NUM, multiple=7, excellence=NUM,
             weightage_default=NUM, spread_json='{"x": 424243.5}')
    v.update(kw)
    return db.execute("INSERT INTO pm_kpi_library(%s) VALUES (%s)" % (",".join(v), ",".join("?" * len(v))), list(v.values())).lastrowid


L_ANY = lib("ZZLX Sales margin")
L_SCOPED = lib("ZZLX Units shipped", company=UNIT, department=DEPT, tier_n=2, job_grade="14", method="less", bu_level=1,
               unit="Days", perspective="Internal Process", description="ZZLX days to ship")
L_RETIRED = lib("ZZLX Old KPI", active=0)
L_VARIANT = lib("ZZLX Sales margin - Retail")
db.execute("INSERT INTO pm_kpi_aliases(business_group, alias_key, alias_name, into_key, into_name, kind, qualifier) VALUES "
           "(?,?,?,?,?, 'variant', 'Retail')", (BG, "zzlx sales margin - retail", "ZZLX Sales margin - Retail",
                                               "zzlx sales margin", "ZZLX Sales margin"))
L_LIST = lib("ZZLX Grade list", job_grades="15,16", departments="zzlx dept", department_mode="exclude")
db.commit()

# ---- the competency library and the career map: our own jobs ----------------------------------------------------------------------
sk = {}


def skill(code, title, level, active=1):
    sk[code] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, proficiency_description, "
                          "knowledge_items, ability_items, active) VALUES (?,?,?,?,?,?,?,?,?)",
                          (code, title, level, "TSC", "ZZLX Category", "ZZLX does it at L%d" % level, "- know one\n- know two",
                           "- can one\n- can two", active)).lastrowid
    return sk[code]


for n_, title in ((1, "ZZLX Planning"), (2, "ZZLX Reporting")):
    skill("ZLX-OPR-3%03d-1.0" % n_, title, 3)
    skill("ZLX-OPR-4%03d-1.0" % n_, title, 4)
skill("CHG-ZLX-3003-1.0", "ZZLX Chin Hin written", 3, active=0)   # a new Chin Hin competency, waiting for P&R, no level above


def profile(code, title, grade, comps, source=None, scope=None):
    pid = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, job_scope, source, active, "
                     "review_status, plan_mode) VALUES (?,?,?,?,?,?,1,'draft','explicit')",
                     (DEPT, title, str(grade), code, scope, source)).lastrowid
    for i, (cur, nxt) in enumerate(comps):
        db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, is_future) VALUES (?,?,?,?,0)",
                   (pid, sk[cur], int(cur.split("-")[2][0]), i))
        if nxt:
            db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, is_future) VALUES (?,?,?,?,1)",
                       (pid, sk[nxt], int(nxt.split("-")[2][0]), i))
    return pid


FIVE = [("ZLX-OPR-3001-1.0", "ZLX-OPR-4001-1.0"), ("ZLX-OPR-3002-1.0", "ZLX-OPR-4002-1.0"), ("CHG-ZLX-3003-1.0", None)]
P_A12 = profile("ZLX-CRT-01-12", "ZZLX Analyst", 12, FIVE)
P_A13 = profile("ZLX-CRT-01-13", "ZZLX Senior Analyst", 13, FIVE)
P_A14 = profile("ZLX-CRT-01-14", "ZZLX Lead Analyst", 14, FIVE)
P_B13 = profile("ZLX-CRT-02-13", "ZZLX Planner", 13, FIVE)
P_T = profile("ZLY-CRT-01-14", "ZZLX Target Role", 14, FIVE, source="target")   # a grade nobody holds, in another family
db.execute("INSERT INTO tc_career_routes(from_profile_id, to_profile_id, kind) VALUES (?,?, 'hidden')", (P_A12, P_B13))
db.execute("INSERT INTO tc_career_routes(from_profile_id, to_profile_id, kind) VALUES (?,?, 'pinned')", (P_A12, P_T))
# a spread of generated jobs in the same sub-family, so the batch read is held against the page's own on more than five jobs
rnd = random.Random(11)
PIDS = [P_A12, P_A13, P_A14, P_B13, P_T]
comp_codes = [c for c, _n in FIVE]
for j in range(4):
    for g in (12, 13, 14, 15, 16):
        pick = [x for x in FIVE if rnd.random() < 0.8] or FIVE[:1]
        PIDS.append(profile("ZLX-CRT-%02d-%d" % (3 + j, g), "ZZLX Generated %d-%d" % (j, g), g, pick))
db.commit()
OTHER_PINS = rnd.sample(PIDS[5:], 3)
for k, pid in enumerate(OTHER_PINS):
    db.execute("INSERT OR IGNORE INTO tc_career_routes(from_profile_id, to_profile_id, kind) VALUES (?,?,?)",
               (pid, rnd.choice(PIDS), "hidden" if k % 2 else "pinned"))
db.commit()


try:
    # =================================================================================================================================
    s.section("every download: a valid workbook, named by the one pattern, an About sheet, logged as an export")
    s.check("the three are in Reports under their own cards, and download straight (no cycle, no panel)",
            all(any(r[3] == ep and r[0] == sec and r[1] == lbl for r in a.ADMIN_REPORTS) and ep not in a.DL_CYCLE_MODE
                for ep, (sec, lbl, _m, _x) in EPS.items()))
    s.check("...each route is super_required (the nav reads it, so no other admin is offered the row)",
            all(a.app.view_functions[ep]._nav_gate == "super" for ep in EPS))
    SHEETS, RESP = {}, {}
    for ep, (sec, lbl, mod, exp) in EPS.items():
        before = n_exports()
        r, sh = book(SUC, URL[ep])
        SHEETS[ep], RESP[ep] = sh, r
        cd = r.headers.get("Content-Disposition", "")
        s.check("%s: the super admin gets an .xlsx" % lbl, r.status_code == 200 and "spreadsheetml" in r.mimetype and sh and "About" in sh,
                (r.status_code, list(sh)))
        s.check("...named AI+OneHR_AllBGs_AllBUs_%s_%s_<date>.xlsx" % (mod, exp),
                re.search(r'filename="AI\+OneHR_AllBGs_AllBUs_%s_%s_\d{4}-\d{2}-\d{2}\.xlsx"' % (mod, exp), cd) is not None, cd)
        log = db.execute("SELECT detail FROM activity_log WHERE action='export' ORDER BY id DESC LIMIT 1").fetchone()
        s.check("...one export row in the activity log, naming the file and its rows", n_exports() == before + 1
                and log and "AI+OneHR_AllBGs_AllBUs_%s_%s_" % (mod, exp) in log[0] and re.search(r"\d+ rows\)", log[0]), log and log[0])
        about = {x[0]: x[1] for x in sh.get("About", [])}
        s.check("...the About sheet says what it is, the report and the row count", about.get("Report") == lbl
                and about.get("What this is") and about.get("Rows") == sum(len(v) - 1 for k, v in sh.items() if k != "About"), about)

    # =================================================================================================================================
    s.section("only the super admin: a BG admin and a unit admin are refused and never see the rows")
    for who, c in (("a BG admin", BAC), ("a unit admin", UAC)):
        s.check("%s: all three answer 403" % who, all(c.get(URL[ep]).status_code == 403 for ep in EPS),
                {ep: c.get(URL[ep]).status_code for ep in EPS})
        pg = c.get(HUB).get_data(as_text=True)
        s.check("...and Reports lists none of the three (no row, no link)", c.get(HUB).status_code == 200
                and not any(URL[ep] in pg or ("<b>%s</b>" % lbl) in pg for ep, (_s, lbl, _m, _x) in EPS.items()), None)
    emp = H.client_as(a, EMP["id"])
    s.check("an employee is refused too", all(emp.get(URL[ep]).status_code in (302, 403, 404) for ep in EPS))
    pg = SUC.get(HUB).get_data(as_text=True)
    s.check("the super admin's Reports lists all three, each a plain link",
            all(URL[ep] in pg and ("<b>%s</b>" % lbl) in pg for ep, (_s, lbl, _m, _x) in EPS.items()))
    s.check("Roles & access names them among the super admin's, under their modules",
            any("KPI library download" in x for x in a.ADMIN_SUPER_ROWS["pm"])
            and any("competency library download" in x for x in a.ADMIN_SUPER_ROWS["competency"])
            and any("career routes download" in x for x in a.ADMIN_SUPER_ROWS["idp"]))
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        _su = dict(d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        _bg = dict(d_.execute("SELECT * FROM users WHERE id=?", (BGA,)).fetchone())
        found = {i["label"] for i in a._admin_index(d_, _su, with_values=False) if i["kind"] == "report"}
        found_bg = {i["label"] for i in a._admin_index(d_, _bg, with_values=False) if i["kind"] == "report"}
    s.check("the Admin Agent's find_download reads them with the rest (_admin_index walks _reports_for): the super admin's index has "
            "all three, a BG admin's none",
            {v[1] for v in EPS.values()} <= found and not ({v[1] for v in EPS.values()} & found_bg), (found & {v[1] for v in EPS.values()}))

    # =================================================================================================================================
    s.section("KPI library: the import's columns, then read-only ones; no numbers")
    ep = "admin_export_kpi_library"
    sheet = SHEETS[ep]["KPI library"]
    head, body = sheet[0], sheet[1:]
    s.check("the sheets are KPI library (active rows), Retired, About; the first twelve columns are the library import's, in its order",
            list(SHEETS[ep]) == ["KPI library", "Retired", "About"] and SHEETS[ep]["Retired"][0] == head and head[:12] == list(a.KPI_LIBRARY_IMPORT_HEAD) and head[12:] == list(a.KPI_LIBRARY_EXPORT_EXTRA),
            head)
    s.check("...and they are the template's own columns (one list: the template and the file cannot drift)",
            [c[0] for c in [[h] for h in a.KPI_LIBRARY_IMPORT_HEAD]] == [h for h in SHEETS[ep]["KPI library"][0][:12]]
            and list(book(SUC, "/admin/performance/library/template.xlsx")[1].values())[0][0] == list(a.KPI_LIBRARY_IMPORT_HEAD))
    NUMBER_WORDS = re.compile(r"\b(rate|threshold|target|multiple|excellence|weight(age)?|spread)\b", re.I)
    s.check("no column is a number column (rate, threshold, target, multiple, excellence, weight, spread)",
            not [h for h in head if NUMBER_WORDS.search(str(h))], head)
    every_cell = " ".join(str(v) for rows in SHEETS[ep].values() for r in rows for v in r if v is not None)
    s.check("a rate, target, weight or spread seeded on the library rows never appears in the file (%s)" % NUM,
            "424242" not in every_cell and "424243" not in every_cell)
    mine = {r[head.index("KPI")]: r for r in body if r[0] == BG}
    ret_body = SHEETS[ep]["Retired"][1:]
    s.check("sheet one holds the active rows only, sorted by business group then KPI: none says Active = No",
            set(mine) == {"ZZLX Sales margin", "ZZLX Units shipped", "ZZLX Sales margin - Retail", "ZZLX Grade list"}
            and len(body) == one("SELECT COUNT(*) FROM pm_kpi_library WHERE active=1")
            and not [r for r in body if r[head.index("Active")] != "Yes"]
            and [r[0] for r in body] == sorted([r[0] for r in body], key=str.lower), sorted(mine))
    s.check("the Retired sheet holds the retired rows, in the same columns, every one Active = No; the two sheets are every row",
            [r[head.index("KPI")] for r in ret_body if r[0] == BG] == ["ZZLX Old KPI"]
            and len(ret_body) == one("SELECT COUNT(*) FROM pm_kpi_library WHERE active=0")
            and not [r for r in ret_body if r[head.index("Active")] != "No"]
            and len(body) + len(ret_body) == one("SELECT COUNT(*) FROM pm_kpi_library"))
    r_any, r_sc = mine["ZZLX Sales margin"], mine["ZZLX Units shipped"]
    s.check("'any' is written blank (company, department, tier 0, job grade '*'), a scope as the import reads it back",
            r_any[1:5] == ["", "", "", ""] and r_sc[1:5] == [UNIT, DEPT, 2, "14"], (r_any[1:5], r_sc[1:5]))
    s.check("the method reads More / Less, BU level Yes / No, unit and perspective as stored",
            (r_any[9], r_any[11], r_any[8], r_any[10]) == ("More", "No", "%", "Financial")
            and (r_sc[9], r_sc[11], r_sc[8], r_sc[10]) == ("Less", "Yes", "Days", "Internal Process"))
    ai = lambda r: r[head.index("Active")]  # noqa: E731
    s.check("a retired row shows Active = No (on the Retired sheet), the others Yes",
            [ai(r) for r in ret_body if r[5] == "ZZLX Old KPI"] == ["No"] and ai(r_any) == "Yes"
            and ai(mine["ZZLX Sales margin - Retail"]) == "Yes")
    vi = lambda r: r[head.index("Variant of")]  # noqa: E731
    s.check("a variant row names the KPI it is a variant of; others have none",
            vi(mine["ZZLX Sales margin - Retail"]) == "ZZLX Sales margin" and vi(r_any) == "" and vi(r_sc) == "")
    s.check("the last change is MYT (updated_at / created_at + 8 h)", re.match(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}$", str(r_any[head.index("Last changed (MYT)")]))
            and str(r_any[head.index("Last changed (MYT)")]) == a._myt(one("SELECT created_at FROM pm_kpi_library WHERE id=?", (L_ANY,))))
    rl = mine["ZZLX Grade list"]
    s.check("a list of grades or departments is in the read-only columns, never in Department / Job Grade (the import would read it as a name)",
            rl[2] == "" and rl[4] == "" and rl[head.index("Job grades (a list)")] == "15, 16"
            and rl[head.index("Departments (a list)")] == "zzlx dept" and rl[head.index("Departments list means")] == "all except these",
            rl)
    s.check("the About sheet says the Retired sheet is for reading and the import reads the first only, and counts both",
            "import reads only the first sheet" in {x[0]: x[1] for x in SHEETS[ep]["About"]}.get("The Retired sheet", "")
            and "Delete the retired rows" not in " ".join(str(x[1]) for x in SHEETS[ep]["About"])
            and {x[0]: x[1] for x in SHEETS[ep]["About"]}.get("Retired rows") == one("SELECT COUNT(*) FROM pm_kpi_library WHERE active=0")
            and {x[0]: x[1] for x in SHEETS[ep]["About"]}.get("Active rows") == one("SELECT COUNT(*) FROM pm_kpi_library WHERE active=1"))

    # =================================================================================================================================
    s.section("KPI library: back through the library import's check, nothing to change; an altered cell is found")
    from openpyxl import load_workbook as _lw  # noqa: E402


    def import_check(data):
        with a.app.test_request_context("/"):
            d = a.get_db()
            me = dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
            ctx = a._limp_load(d, me, {"filename": "kpi-library.xlsx"}, data)
            ch = a._limp_changes(d, me, ctx, {})
            return ctx, ch

    ctx, ch = import_check(RESP[ep].data)
    ours = [r for r in ctx["valid"] if r["business_group"] == BG]
    s.check("the file reads: no row refused, no number column noticed, all of ours matched to a library row; the import read the first "
            "sheet only (the retired KPI is not among the rows it read)",
            not ctx["errors"] and not ctx["look"] and len(ours) == 4 and all(r["ex"] for r in ours)
            and "ZZLX Old KPI" not in {r["kpi_name"] for r in ctx["valid"]}, (ctx["errors"][:3], ctx["look"], len(ours)))
    s.check("...and nothing changes: no KPI to add, none updated, no BU-level mark moves, no new name close to another",
            all(r["ex"] and not r["fields"] and (r["bu_level"] or 0) == r["bu_now"] for r in ours)
            and not [t for t in ch["tiles"] if t[0] and t[1] != "no change"] and not ch["decide"], (ch["tiles"], [r["fields"] for r in ours]))
    snap = lambda: [tuple(r) for r in db.execute(  # noqa: E731
        "SELECT id, active, category, description, unit, method, perspective, bu_level, company, department, job_grade, tier_n "
        "FROM pm_kpi_library ORDER BY id")]
    before = snap()
    with a.app.test_request_context("/"):
        d = a.get_db()
        me = dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        a._limp_apply(d, me, ctx, {})
    s.check("applying the file as it came changes no row and brings no retired KPI back (0 reactivations)",
            snap() == before and one("SELECT active FROM pm_kpi_library WHERE id=?", (L_RETIRED,)) == 0, None)
    wb = _lw(io.BytesIO(RESP[ep].data))
    ws = wb["KPI library"]
    row = next(i for i, r in enumerate(ws.iter_rows(values_only=True), start=1) if r[5] == "ZZLX Sales margin")
    ws.cell(row=row, column=8).value = "ZZLX a changed definition"
    buf = io.BytesIO()
    wb.save(buf)
    ctx2, ch2 = import_check(buf.getvalue())
    changed = [r for r in ctx2["valid"] if r["business_group"] == BG and r["fields"]]
    s.check("FALSIFY: one altered cell (a definition) is found as exactly one change, in that KPI",
            len(changed) == 1 and changed[0]["kpi_name"] == "ZZLX Sales margin" and changed[0]["fields"] == ["Definition"]
            and any(t[1] == "to update" and t[0] == 1 for t in ch2["tiles"]), [(r["kpi_name"], r["fields"]) for r in changed])
    wb = _lw(io.BytesIO(RESP[ep].data))
    ws = wb["KPI library"]
    ws.cell(row=row, column=10).value = "Less"
    buf = io.BytesIO()
    wb.save(buf)
    ctx3, _ch3 = import_check(buf.getvalue())
    s.check("FALSIFY: an altered method is found too (the check reads every word column)",
            [(r["kpi_name"], r["fields"]) for r in ctx3["valid"] if r["business_group"] == BG and r["fields"]] == [("ZZLX Sales margin", ["Direction"])])

    # two rows that differ only in a list share an import key: flagged in the file, refused by the import (said in the About sheet)
    L_TWIN = lib("ZZLX Sales margin", job_grades="17,18")
    db.commit()
    r2, sh2 = book(SUC, URL[ep])
    h2, b2 = sh2["KPI library"][0], sh2["KPI library"][1:]
    twins = [r for r in b2 if r[0] == BG and r[5] == "ZZLX Sales margin"]
    s.check("two rows with one import key are both flagged 'Same import key as another row', others are not",
            len(twins) == 2 and all(r[h2.index("Same import key as another row")] == "Yes" for r in twins)
            and not any(r[h2.index("Same import key as another row")] for r in b2 if r[5] != "ZZLX Sales margin"))
    ctx4, _ = import_check(r2.data)
    s.check("...and the import does refuse them as 'more than once' (what the About sheet says)",
            any("more than once" in e["why"] for e in ctx4["errors"]) and "refuses the file" in " ".join(str(x[1]) for x in sh2["About"]))
    db.execute("DELETE FROM pm_kpi_library WHERE id=?", (L_TWIN,))
    db.commit()

    # =================================================================================================================================
    s.section("competency library: Jobs (Current and Next, read against the profile's own rows) and Competencies")
    ep = "admin_export_competency_library"
    sh = SHEETS[ep]
    s.check("the sheets are Jobs, Competencies, About", list(sh) == ["Jobs", "Competencies", "About"], list(sh))
    jh, jb = sh["Jobs"][0], sh["Jobs"][1:]
    s.check("Jobs has the job's identity, its competency, level, Current or Next, who wrote it, its review status",
            jh == ["Job code", "Job family", "Sub-family", "Specialisation", "Job title", "Job grade", "Department", "Job scope",
                   "Business groups (people holding it)", "People holding it", "Target role nobody holds", "Competency code",
                   "Competency", "Level", "Current or Next level", "Written by", "Review status"], jh)
    mine = [r for r in jb if r[0] == "ZLX-CRT-01-12"]
    own = lambda fut: {(r["skill_code"], r["level"]) for r in db.execute(  # noqa: E731
        "SELECT s.skill_code, s.level FROM tc_job_profile_skills ps JOIN tc_skills s ON s.id=ps.skill_id WHERE ps.profile_id=? "
        "AND ps.is_future=?", (P_A12, fut))}
    cur_f = {(r[jh.index("Competency code")], r[jh.index("Level")]) for r in mine if r[jh.index("Current or Next level")] == "Current"}
    nxt_f = {(r[jh.index("Competency code")], r[jh.index("Level")]) for r in mine if r[jh.index("Current or Next level")] == "Next"}
    s.check("a job's Current rows are its profile's own current competencies at their levels (read straight from its rows)",
            cur_f == own(0) and len(cur_f) == 3, (cur_f, own(0)))
    s.check("...its Next rows are its profile's own next-level rows, and a competency with no level above has no Next row",
            nxt_f == own(1) and len(nxt_f) == 2 and "CHG-ZLX-3003-1.0" not in {c for c, _l in nxt_f}, (nxt_f, own(1)))
    wr = {r[jh.index("Competency code")]: r[jh.index("Written by")] for r in mine}
    s.check("who wrote it: a CHG- competency is Chin Hin, an SSG one SkillsFuture; an unsigned job is a draft for P&R",
            wr["CHG-ZLX-3003-1.0"] == "Chin Hin" and wr["ZLX-OPR-3001-1.0"] == "SkillsFuture"
            and mine[0][jh.index("Review status")] == "Draft, with P&R for review", wr)
    s.check("the job's family and grade come from the code and its place from the job architecture (grade 12, code's first segment)",
            mine[0][jh.index("Job grade")] == 12 and mine[0][jh.index("Job title")] == "ZZLX Analyst"
            and mine[0][jh.index("Department")] == DEPT)
    s.check("the target role is flagged, the others are not", [r[jh.index("Target role nobody holds")] for r in jb if r[0] == "ZLY-CRT-01-14"][0] == "Yes"
            and not [r for r in jb if r[0] == "ZLX-CRT-01-12" and r[jh.index("Target role nobody holds")]])
    ix_jobs = {r[0] for r in jb}
    s.check("every active job-code profile has rows (one profile, one or more rows)",
            ix_jobs == {r[0] for r in db.execute("SELECT job_code FROM tc_job_profiles WHERE active=1 AND job_code IS NOT NULL")})
    ch, cb = sh["Competencies"][0], sh["Competencies"][1:]
    s.check("Competencies has a row for every written level (one tc_skills row each)",
            len(cb) == one("SELECT COUNT(*) FROM tc_skills") and {r[0] for r in cb} == {r[0] for r in db.execute("SELECT skill_code FROM tc_skills")}
            and ch[:4] == ["Competency code", "Competency", "Level", "Category"], ch)
    crow = {r[0]: r for r in cb}
    jobs_l = lambda code: crow[code][ch.index("Jobs using this level")]  # noqa: E731
    s.check("how many jobs use a level: the level a job asks now or next (L3 of Planning: the 5 jobs holding it and the generated ones)",
            jobs_l("ZLX-OPR-3001-1.0") == one("SELECT COUNT(DISTINCT ps.profile_id) FROM tc_job_profile_skills ps WHERE ps.skill_id=? AND "
                                              "ps.profile_id IN (SELECT id FROM tc_job_profiles WHERE active=1 AND job_code IS NOT NULL)",
                                              (sk["ZLX-OPR-3001-1.0"],))
            and jobs_l("ZLX-OPR-4001-1.0") == one("SELECT COUNT(DISTINCT ps.profile_id) FROM tc_job_profile_skills ps WHERE ps.skill_id=? "
                                                  "AND ps.profile_id IN (SELECT id FROM tc_job_profiles WHERE active=1 AND job_code IS NOT NULL)",
                                                  (sk["ZLX-OPR-4001-1.0"],))
            and jobs_l("ZLX-OPR-3001-1.0") >= 5, (jobs_l("ZLX-OPR-3001-1.0"), jobs_l("ZLX-OPR-4001-1.0")))
    s.check("a competency whose every level is off waits for P&R's sign-off; an active one is Active; the words and items are there",
            crow["CHG-ZLX-3003-1.0"][ch.index("Status")] == "Waiting for P&R sign-off"
            and crow["ZLX-OPR-3001-1.0"][ch.index("Status")] == "Active"
            and crow["ZLX-OPR-3001-1.0"][ch.index("Proficiency description")] == "ZZLX does it at L3"
            and crow["ZLX-OPR-3001-1.0"][ch.index("Knowledge items")] == "know one\nknow two"
            and crow["CHG-ZLX-3003-1.0"][ch.index("Written by")] == "Chin Hin")

    # =================================================================================================================================
    s.section("career routes: the side panel's own moves, Hidden and Pinned marked, a target role flagged")
    ep = "admin_export_career_routes"
    sh = SHEETS[ep]
    rh, rb = sh["Career routes"][0], sh["Career routes"][1:]
    s.check("one sheet, Career routes, then About; the columns say from, to and how it is offered", list(sh) == ["Career routes", "About"]
            and rh[:3] == ["From job code", "From job title", "From job grade"] and "How it is offered" in rh and "Group People's call" in rh, rh)
    F, T, HOW, CALL = (rh.index(x) for x in ("From job code", "To job code", "How it is offered", "Group People's call"))
    # the panel's own answer, job by job, without the batch read: what the page shows for that grade
    page = {}
    with a.app.test_request_context("/"):
        d = a.get_db()
        for pid, code in [(r["id"], r["job_code"]) for r in d.execute("SELECT id, job_code FROM tc_job_profiles WHERE active=1 AND job_code IS NOT NULL")]:
            g = a._ja_parts(code)["grade"]
            groups, hidden = a.tc_route_groups(d, pid, g, {})
            offered = {}
            for label, moves in groups:
                for m in moves:
                    offered[d.execute("SELECT job_code FROM tc_job_profiles WHERE id=?", (m["id"],)).fetchone()[0]] = (label, m["pinned"])
            page[code] = (offered, {h["job_code"] for h in hidden})
    bad = []
    for code, (offered, hidden) in page.items():
        got = {r[T]: (r[HOW], r[CALL] == "Pinned") for r in rb if r[F] == code and r[T] and r[CALL] != "Hidden"}
        got_h = {r[T] for r in rb if r[F] == code and r[CALL] == "Hidden"}
        if got != offered or got_h != hidden:
            bad.append(code)
    s.check("for every job (%d), the moves in the file, how each is offered and the ones hidden are the panel's own, worked out job by job"
            % len(page), len(page) >= 20 and not bad and len({r[F] for r in rb}) == len(page), bad[:5])
    a12 = [r for r in rb if r[F] == "ZLX-CRT-01-12"]
    s.check("an analyst's own next grade is offered as 'next grade in this job' and marked the next step",
            any(r[T] == "ZLX-CRT-01-13" and r[HOW] == "next grade in this job" and r[rh.index("Next step on its ladder")] == "Yes" for r in a12), a12[:4])
    s.check("a move Group People hid is in the file, marked Hidden, with no way offered, and is not also offered",
            [r[HOW] for r in a12 if r[T] == "ZLX-CRT-02-13"] == [""] and [r[CALL] for r in a12 if r[T] == "ZLX-CRT-02-13"] == ["Hidden"])
    s.check("a move Group People pinned is 'suggested by Group People', marked Pinned, and flagged as a target role nobody holds",
            [(r[HOW], r[CALL], r[rh.index("To is a target role nobody holds")]) for r in a12 if r[T] == "ZLY-CRT-01-14"]
            == [("suggested by Group People", "Pinned", "Yes")], [r for r in a12 if r[T] == "ZLY-CRT-01-14"])
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        ctx_ = a.tc_routes_ctx(d_)
        diff = [pid_ for pid_ in [r["id"] for r in d_.execute("SELECT id FROM tc_job_profiles WHERE active=1 AND job_code IS NOT NULL")]
                if a.tc_route_groups(d_, pid_, a._ja_parts(d_.execute("SELECT job_code FROM tc_job_profiles WHERE id=?", (pid_,)).fetchone()[0])["grade"], {})
                != a.tc_route_groups(d_, pid_, a._ja_parts(d_.execute("SELECT job_code FROM tc_job_profiles WHERE id=?", (pid_,)).fetchone()[0])["grade"], {}, ctx=ctx_)]
    s.check("...every active job, with and without the batch read: no difference", not diff, diff[:5])
    abt = {x[0]: x[1] for x in sh["About"]}
    s.check("the About counts match the rows (jobs, moves offered, pinned, hidden)",
            abt["Jobs"] == len(page) and abt["Hidden by Group People"] == len([r for r in rb if r[CALL] == "Hidden"])
            and abt["Pinned by Group People"] == len([r for r in rb if r[CALL] == "Pinned"])
            and abt["Moves offered"] == len([r for r in rb if r[T] and r[CALL] != "Hidden"]), abt)
finally:
    pass

sys.exit(s.done())
