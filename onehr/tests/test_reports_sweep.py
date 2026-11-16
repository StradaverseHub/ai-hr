"""The module pages' downloads move to Reports (Chris, 4 Nov 2026: "anything downloaded or shown as a report lives on Admin ›
Reports"; canvas [design canvas link removed], all four options (a)).

What this suite holds:
  * every button that moved is gone from its page (Progress and Overview of the four modules, Rater progress, People panels, Users,
    the audit log, Lock status, Final bands, Late passes, the Roles years-of-service card, Opted out, Data integrity, Ask OneHR,
    AI+ feedback, Learning needs / Effectiveness / the L&D agent) and every old address still answers (bookmarks)
  * Reports › Data downloads: the new rows, each in its card, each on the panel with its kind; the super admin's tab counts ten more
  * access is as it was: a BG admin with calibration.read / idp.read sees Calibration progress, Lock status and Plan progress and
    nothing of the other eight; their endpoints refuse a BG admin (403); an admin without the module's read tick sees neither the
    row nor the file
  * a BG admin's three files hold their own group only, and a pick of another group gives an empty file
  * Final bands: one file, every Group Chief scope, both axes side by side, from an independent read of the band tables
  * Data integrity: one sheet per check; the audit log honours date_from / date_to and the panel's count endpoint says the file's rows
  * every file is .xlsx with an About sheet; the panel's count for each is the number of rows its file holds
Synthetic (ZZSW-*) on a fresh scratch database.
"""
import io
import json
import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["ONEHR_LMS"] = "1"   # Learning's two files and its agent page are tested; read on every call, put back at the end
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Reports sweep: the module pages' downloads move to Reports")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
from openpyxl import load_workbook  # noqa: E402

SU, _BGA0, EMP = H.actors(a)
PFX = "ZZSW-"
BG_A, BG_B = "ZZSW Group A", "ZZSW Group B"
UA1, UA2, UB1 = "ZZSW Unit A1", "ZZSW Unit A2", "ZZSW Unit B1"
db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
HUB = "/admin/reports/all"
NEW = {   # endpoint -> (card, label, kind, who: "bg" a BG admin with the module's read tick, or "super")
    "admin_export_calibration_progress": ("calibration", "Calibration progress", "active", "bg"),
    "admin_export_calibration_locks": ("calibration", "Lock status", "active", "bg"),
    "admin_export_final_bands": ("calibration", "Final bands", "active", "super"),
    "admin_export_idp_progress": ("idp", "Plan progress", "active", "bg"),
    "admin_export_late_passes": ("cycle", "Late passes", "pick", "super"),
    "admin_roles_service_list": ("people", "Full on years of service alone", "roster", "super"),
    "admin_export_optouts": ("people", "Opted out of emails", "roster", "super"),
    "admin_export_audit_log": ("audit", "Audit log", "dates", "super"),
    "admin_export_data_integrity": ("audit", "Data integrity", "active", "super"),
    "admin_export_ask_log": ("audit", "Ask OneHR questions", "roster", "super"),
    "admin_feedback_export": ("audit", "AI+ feedback", "pick", "super")}
LMS_NEW = {"admin_export_lms_needs": "Learning needs", "admin_export_lms_effectiveness": "ISO evidence"}
with a.app.test_request_context("/"):
    URL = {ep: a.url_for(ep) for ep in list(NEW) + list(LMS_NEW) + ["admin_export_audit_count"]}


def one(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return r[0] if r else None


def run(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        r = fn(d)
        d.commit()
        return r


# ---- the setup ---------------------------------------------------------------------------------------------------------------------
CID = run(lambda d: a.active_cycle_id(d))
HALF0 = one("SELECT half FROM cycles WHERE id=?", (CID,))
db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))   # Year-End: the BU CEO and Talent Box tiers have rows too
base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 LIMIT 1").fetchone())
COLS = [c for c in base if c != "id"]
U = {}


def mk(k, bg, co, dept="ZZSW Dept", hod=None, role="user", conf="2020-01-01", years=3, admin_bg=None, grade="15", role_id=None):
    v = dict(base, username=(PFX + k).lower(), employee_id=PFX + k, full_name="ZZ SW " + k, email=None, hod_id=hod, manager_id=hod,
             buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=bg, company=co, department=dept, years_of_service=years,
             confirmation_date=conf, left_at=None, is_demo=0, role=role, admin_bg=admin_bg, job_grade=grade, job_title="ZZ Test",
             user_role_id=None, admin_role_id=role_id, is_system_admin=0)
    cur = db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(COLS), ",".join("?" * len(COLS))), [v[c] for c in COLS])
    U[k] = cur.lastrowid
    return cur.lastrowid


for bg_, co_ in ((BG_A, UA1), (BG_A, UA2), (BG_B, UB1)):
    db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (bg_, co_))
for bg_ in (BG_A, BG_B):
    db.execute("INSERT OR IGNORE INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (bg_,))
mk("HODA", BG_A, UA1, "ZZSW Dept A")
mk("HODB", BG_B, UB1, "ZZSW Dept B")
mk("A1", BG_A, UA1, "ZZSW Dept A", hod=U["HODA"])
mk("A2", BG_A, UA2, "ZZSW Dept A", hod=U["HODA"])
mk("B1", BG_B, UB1, "ZZSW Dept B", hod=U["HODB"])
mk("CH1", BG_A, UA1, "ZZSW Chiefs")
mk("CH2", BG_B, UB1, "ZZSW Chiefs")
mk("SV1", BG_A, UA1, "ZZSW Dept A", hod=U["HODA"], conf=None)   # Full on years of service alone: no confirmation date
mk("SV2", BG_B, UB1, "ZZSW Dept B", hod=U["HODB"], conf=None)
for k in ("A1", "A2", "B1"):   # a final, moderated scorecard each: it puts them on the performance axis of the queue
    t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, rate5, "
                   "business_group, company, department) VALUES (?,?, 'ZZSW KPI', 100, 'more', 80,90,100,110,120, ?,?, 'x')",
                   (CID, U[k], one("SELECT business_group FROM users WHERE id=?", (U[k],)),
                    one("SELECT company FROM users WHERE id=?", (U[k],)))).lastrowid
    db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t, U["HODA"]))
    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,100,?,0)", (t, U[k]))
    db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) VALUES (?,1,'confirm',100,?)",
               (t, U["HODA"]))
# two Group Chief scopes: G1 across both business groups (A1, B1), G2 inside one (A2)
G1 = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZSW Scope One', ?)", (U["CH1"],)).lastrowid
G2 = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZSW Scope Two', ?)", (U["CH2"],)).lastrowid
for g_, k in ((G1, "A1"), (G1, "B1"), (G2, "A2")):
    db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id) VALUES (?,?)", (g_, U[k]))
db.commit()
PERIOD = run(lambda d: dict(a.active_pm_period(d)))
REMARK_PM, REMARK_POT = "ZZSW the final call on performance", "ZZSW the final call on potential"


def calls(d):
    # performance: the Group Chief's locked call on A1 (ME -> AE), then the super admin's final band (OU)
    gs = a._pm_calib_get_or_create_session(d, CID, "group", str(G1), BG_A, "ZZSW Scope One")
    a._pm_calib_upsert_adjustment(d, gs["id"], U["A1"], "ME", "AE", "ZZSW chief remark", U["CH1"], seen_band="ME")
    d.execute("UPDATE pm_calibration_sessions SET locked_at=datetime('now') WHERE id=?", (gs["id"],))
    sup = dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
    ok, msg = a._pm_super_set(d, sup, PERIOD, dict(d.execute("SELECT * FROM users WHERE id=?", (U["A1"],)).fetchone()), "OU", REMARK_PM)
    assert ok, msg
    # potential: the Group Chief's locked calls on A1 (Mid -> High) and B1 (Low -> Mid); the super admin's final potential on B1 (High)
    ps = a._get_or_create_calibration_session(d, CID, "group", str(G1), BG_A, "ZZSW Scope One")
    a._calibration_upsert_adjustment(d, ps["id"], U["A1"], "Mid", "High", "ZZSW chief pot", U["CH1"])
    a._calibration_upsert_adjustment(d, ps["id"], U["B1"], "Low", "Mid", "ZZSW chief pot", U["CH1"])
    d.execute("UPDATE calibration_sessions SET locked_at=datetime('now') WHERE id=?", (ps["id"],))
    ok, msg = a._pot_super_set(d, sup, CID, dict(d.execute("SELECT * FROM users WHERE id=?", (U["B1"],)).fetchone()), "High", REMARK_POT)
    assert ok, msg
    d.commit()


run(calls)
# late passes (one a person in each group), opt-outs, the feedback and Ask OneHR questions, and a second, quiet cycle
OLD = db.execute("INSERT INTO cycles(code, name, is_active, year, half) VALUES ('ZZSW-OLD', 'ZZSW old cycle', 0, 2024, 2)").lastrowid
for k in ("A1", "B1"):
    db.execute("INSERT INTO late_passes(cycle_id, user_id, cell, until_at, reason, given_by) VALUES (?,?, 'tc_self', "
               "datetime('now','+3 days'), ?, ?)", (CID, U[k], "ZZSW late " + k, SU["id"]))
    db.execute("INSERT INTO email_optouts(user_id, kind, until, reason, set_by) VALUES (?, 'reminder', NULL, ?, ?)",
               (U[k], "ZZSW off " + k, SU["id"]))
    db.execute("INSERT INTO journey_feedback(user_id, cycle_id, persona, rating, comment, status, rated_at, commented_at) VALUES "
               "(?,?,?,?,?, 'commented', datetime('now'), datetime('now'))", (U[k], CID, a.FEEDBACK_PERSONAS[0], 4, "ZZSW line " + k))
    db.execute("INSERT INTO activity_log(user_id, action, detail) VALUES (?, 'ask_unanswered', ?)", (U[k], "ZZSW question " + k))
db.execute("INSERT INTO journey_feedback(user_id, cycle_id, persona, rating, status, rated_at) VALUES (?,?,?,3,'rated', datetime('now'))",
           (U["A2"], OLD, a.FEEDBACK_PERSONAS[0]))
# three audit rows on known days (UTC noon-ish, so the same day in Malaysia)
for day in ("2026-09-05", "2026-09-15", "2026-09-25"):
    db.execute("INSERT INTO activity_log(user_id, action, detail, created_at) VALUES (?, 'zzsw_mark', ?, ?)",
               (SU["id"], "ZZSW audit mark " + day, day + " 04:00:00"))
db.commit()


def role_id(builtin):
    return one("SELECT id FROM admin_roles WHERE builtin=?", (builtin,))


if not role_id("bg"):
    run(lambda d: a._seed_access_roles())
NOROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZSW No Calibration or Career Plan', 'group')").lastrowid
db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)",
               [(NOROLE, k) for k in sorted(a.role_preset_items("view")) if k not in ("calibration.read", "idp.read")])
mk("BGAA", BG_A, UA1, role="admin", admin_bg=BG_A, role_id=role_id("bg"))
mk("BGAB", BG_B, UB1, role="admin", admin_bg=BG_B, role_id=role_id("bg"))
mk("NOA", BG_A, UA1, role="admin", admin_bg=BG_A, role_id=NOROLE)
db.commit()
SUC = H.client_as(a, SU["id"])
BAC, BBC, NOC, EMPC = (H.client_as(a, U["BGAA"]), H.client_as(a, U["BGAB"]), H.client_as(a, U["NOA"]), H.client_as(a, EMP["id"]))
EIDS = {k: PFX + k for k in U}


def xl(c, url):
    """(response, sheets as {title: [header, rows...]}, About as {item: detail})."""
    r = c.get(url)
    if r.status_code != 200 or r.data[:2] != b"PK":
        return r, {}, {}
    wb = load_workbook(io.BytesIO(r.data), read_only=True)
    sheets = {w.title: [list(x) for x in w.iter_rows(values_only=True)] for w in wb.worksheets}
    return r, sheets, {x[0]: x[1] for x in sheets.get("About", [])}


def first(sheets):
    return next(v for k, v in sheets.items() if k != "About")


def col(rows, name):
    i = [str(x) for x in rows[0]].index(name)
    return [r[i] for r in rows[1:]]


def picks(**kw):
    out = []
    for k, v in kw.items():
        for x in (v if isinstance(v, (list, tuple)) else [v]):
            out.append((k, x))
    from urllib.parse import urlencode
    return "?" + urlencode(out)


def hub(c):
    return c.get(HUB + "?kind=data").get_data(as_text=True)


def card(h, key):
    m = re.search(r'<section class="admin-card adm-rep" id="data-%s">(.*?)</section>' % key, h, re.S)
    return m.group(1) if m else ""


def labels(blk):
    return re.findall(r'<li><span class="adm-rep-name"><b>([^<]+)</b>', blk)


def dl_data(h):
    m = re.search(r'id="dl-data">(.*?)</script>', h, re.S)
    return json.loads(m.group(1)) if m else {}


try:
    # =================================================================================================================================
    s.section("the setup is what the tests rely on")
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        rows_pm, _m = a._final_bands_rows(d_, PERIOD, G1)
        rows_pot, _m2 = a._final_bands_rows_pot(d_, CID, G1)
        locks = a._calib_lock_scopes(d_, dict(d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()), a.active_cycle(d_))
    s.check("Scope One's queue holds A1 on performance (and not B1, who has no scorecard here... B1 has one: both) and both on potential",
            {r["p"]["employee_id"] for r in rows_pm} == {EIDS["A1"], EIDS["B1"]}
            and {r["p"]["employee_id"] for r in rows_pot} == {EIDS["A1"], EIDS["B1"]}, ([r["p"]["employee_id"] for r in rows_pm],))
    s.check("...and the calibration scopes include the two HODs' department reviews",
            {"ZZ SW HODA", "ZZ SW HODB"} <= {r["who"] for r in locks if r["tier"] == "hod"}, len(locks))

    # =================================================================================================================================
    s.section("every button that moved is gone from its page; every old address still answers")
    GONE = [   # (page, what must not be on it)
        ("/admin/module/pm/progress", r"progress\.xlsx|Download \(Excel\)"),
        ("/admin/module/competency/progress", r"progress\.xlsx|Download \(Excel\)"),
        ("/admin/module/calibration/progress", r"progress\.xlsx|Download \(Excel\)"),
        ("/admin/module/idp/progress", r"progress\.xlsx|Download \(Excel\)"),
        ("/admin/module/pm", r"progress\.xlsx|Download progress"),
        ("/admin/module/competency", r"progress\.xlsx|Download progress"),
        ("/admin/module/calibration", r"progress\.xlsx|Download progress"),
        ("/admin/m/idp", r"progress\.xlsx|Download progress"),
        ("/admin/assessors", r"export/assessor-progress|>Download<"),
        ("/admin/subjects", r"export/panels|Download panels"),
        ("/admin/users", r"export/users|Download this list"),
        ("/admin/audit-log", r"export/audit-log|Export Excel"),
        ("/admin/calibration/locks", r"format=xlsx|Download \(Excel\)"),
        ("/admin/calibration/final-bands?g=%d" % G1, r"format=xlsx|Download \(Excel\)"),
        ("/admin/calibration/final-bands?g=%d&axis=pot" % G1, r"format=xlsx|Download \(Excel\)"),
        ("/admin/late-passes", r"download=1|Download \(Excel\)"),
        ("/admin/roles?tab=user", r"service-list|Download the \d+"),
        ("/admin/reminders/opted-out", r"xlsx=1|Download \(Excel\)"),
        ("/admin/reminders/opted-out?show=all", r"xlsx=1|Download \(Excel\)"),
        ("/admin/data-integrity?check=no_email", r"format=xlsx|Export Excel"),
        ("/admin/ask-log", r"ask-log\.(csv|xlsx)|>Download<"),
        ("/admin/feedback", r"feedback\.xlsx|Download \(Excel\)"),
        ("/admin/learning/needs", r"format=xlsx|Download \(Excel\)"),
        ("/admin/learning/effectiveness", r"format=xlsx|ISO evidence \(Excel\)"),
        ("/admin/learning/agent", r"learning/reports/(hours|attendance|hrdc)|Reports \(Excel\)")]
    bad = []
    for page, rx in GONE:
        for who, c in (("super", SUC),):
            r = c.get(page)
            body = r.get_data(as_text=True)
            if r.status_code != 200 or re.search(rx, body):
                bad.append((page, r.status_code, (re.search(rx, body) or [None])[0] if r.status_code == 200 else None))
    s.check("%d pages, as the super admin: each renders and holds none of its old download addresses or words" % len(GONE), not bad, bad)
    s.check("(the patterns find what they are about: each old address is a real route that still downloads a workbook)",
            all(SUC.get(u).status_code == 200 and SUC.get(u).data[:2] == b"PK" for u in (
                "/admin/module/pm/progress.xlsx", "/admin/module/calibration/progress.xlsx", "/admin/module/idp/progress.xlsx",
                "/admin/export/assessor-progress.xlsx", "/admin/export/panels.xlsx", "/admin/export/users.xlsx",
                "/admin/export/audit-log.xlsx", "/admin/calibration/locks?format=xlsx",
                "/admin/calibration/final-bands?g=%d&format=xlsx" % G1, "/admin/late-passes?download=1",
                "/admin/roles/service-list.xlsx", "/admin/reminders/opted-out?xlsx=1", "/admin/data-integrity?check=no_email&format=xlsx",
                "/admin/ask-log.xlsx", "/admin/feedback.xlsx", "/admin/learning/needs?format=xlsx",
                "/admin/learning/effectiveness?format=xlsx")),
            [u for u in ("/admin/export/panels.xlsx", "/admin/export/users.xlsx") if SUC.get(u).status_code != 200])
    s.check("a page's other buttons stay: Users keeps Add a person and Mark several as left; Subjects keeps Release reports",
            all(x in SUC.get("/admin/users").get_data(as_text=True) for x in ("Add a person", "Mark several as left"))
            and "Release reports" in SUC.get("/admin/subjects").get_data(as_text=True))
    s.check("...the Learning import and session papers are untouched (the L&D agent page still says where its reports are)",
            "under <a href=\"/admin/reports/all?kind=data#data-learning\">Reports</a>" in SUC.get("/admin/learning/agent").get_data(as_text=True))

    # =================================================================================================================================
    s.section("Data downloads: the new rows, each in its card, each on the panel with its kind")
    h = hub(SUC)
    got = {ep: labels(card(h, c)) for ep, (c, _l, _k, _w) in NEW.items()}
    s.check("every new row is in its card, by its label", all(NEW[ep][1] in got[ep] for ep in NEW), {ep: got[ep] for ep in NEW if NEW[ep][1] not in got[ep]})
    s.check("...Calibration progress, Lock status and Final bands follow Ratings record; the Career Plan card holds Plan progress, then Career routes (10 Nov 2026)",
            labels(card(h, "calibration"))[-4:] == ["Ratings record", "Calibration progress", "Lock status", "Final bands"]
            and labels(card(h, "idp")) == ["Plan progress", "Career routes"], labels(card(h, "calibration")))
    order = re.findall(r'<section class="admin-card adm-rep" id="data-([a-z0-9_]+)">', h)
    s.check("...the Cycle card comes after the modules, right before People, as drawn (not first, the menu's order)",
            "cycle" in order and "people" in order and order.index("cycle") == order.index("people") - 1
            and order.index("cycle") > order.index("idp"), order)
    s.check("...the Cycle card holds Late passes; People ends with the two new rows; Audit and usage lists Audit log, Data integrity, "
            "Ask OneHR questions, AI+ feedback in that order",
            labels(card(h, "cycle")) == ["Late passes"]
            and labels(card(h, "people"))[-3:] == ["People with missing profile details", "Full on years of service alone", "Opted out of emails"]
            and labels(card(h, "audit")) == ["Audit log", "Data integrity", "Ask OneHR questions", "AI+ feedback"],
            (labels(card(h, "cycle")), labels(card(h, "people"))[-3:], labels(card(h, "audit"))))
    s.check("...the Audit and usage card carries that name; the Cycle card has a grey square, like People",
            "Audit and usage" in re.sub(r"<[^>]+>", " ", card(h, "audit")) and "var(--d-bg-8a90a2)" in card(h, "cycle")
            and "#b5651d" in card(h, "idp"))
    kinds = {}
    for m in re.finditer(r'data-dl-href="([^"]+)"\s+data-dl-mode="(\w+)"', h):
        kinds[m.group(1)] = m.group(2)
    s.check("...every new row opens the Download... panel with the kind drawn for it",
            all(kinds.get(URL[ep]) == NEW[ep][2] for ep in NEW), {ep: kinds.get(URL[ep]) for ep in NEW if kinds.get(URL[ep]) != NEW[ep][2]})
    s.check("...the audit log has its dates (the range picker), the others their business group and units",
            'data-dl-dates' in h and "data-odp-range" in h and 'data-dl-remote="/admin/export/audit-log/count.json"' in h)
    n_data = int(re.search(r"Data downloads <span>· (\d+)", h).group(1))
    with a.app.test_request_context("/"):
        n_files = sum(len(g["files"]) for g in a._reports_for(dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())))
    s.check("the super admin's data tab counts every row (%d: the platform's, and Learning's five here); the sweep added ten (the audit log was a row already)" % n_data,
            n_data == n_files == len(a.ADMIN_REPORTS) + len(a.LMS_REPORTS) and len([ep for ep in NEW if ep != "admin_export_audit_log"]) == 10,
            (n_data, n_files, len(a.ADMIN_REPORTS), len(a.LMS_REPORTS)))
    s.check("...the files' words are the drawn ones", all(x in h for x in (
        "Each person taking part: where their calibration is and what&#39;s waiting, the same status as Calibration › Progress.",
        "Each calibration scope of the active cycle: the tier, who calibrates it, how many people, whether performance and potential are locked, when it closes.",
        "Everyone in a Group Chief&#39;s scope: the BG CEO&#39;s call, the Group Chief&#39;s, the suggestion, the final band and its remark, performance and potential side by side.",
        "Each person: where their Career Plan is (not started, drafted, shared, closed) and when it last changed, the same status as Career Plan › Progress.",
        "Every late pass of the cycle: who, which part, until when, who gave it and why, and whether it&#39;s open, used or ended.",
        "Everyone who is Full only because of over a year&#39;s service, with no confirmation date: their years, and whether they take part in the running cycle.",
        "Everyone taken off Everyone&#39;s reminder or Leader progress: which emails, until when, who did it and why, running or ended.",
        "Every admin action, for the dates you pick.",
        "Every data check of the active cycle, a sheet per check: the people it finds and what&#39;s wrong.",
        "What people asked Ask OneHR that it couldn&#39;t answer, over the last 90 days, by group, unit and department. Never a name.",
        "Every face and line people left after a check-in: when, the persona, the face, what they wrote, their group and unit.")),
        [x[:30] for x in ("Each person taking part", "Every admin action, for the dates you pick.") if x not in h])
    hl = labels(card(h, "learning"))
    s.check("Learning (dark unless ONEHR_LMS=1, on here): Learning needs and ISO evidence join its three downloads",
            hl == ["Learning hours", "Attendance", "HRDC", "Learning needs", "ISO evidence"], hl)

    # =================================================================================================================================
    s.section("access is as it was: a BG admin with the read ticks sees three rows; the others are the super admin's")
    ha = hub(BAC)
    bg_rows = {ep for ep, v in NEW.items() if v[3] == "bg"}
    seen_a = {ep for ep in NEW if NEW[ep][1] in labels(card(ha, NEW[ep][0]))}
    s.check("a BG admin (View only: reads Calibration and Career Plan) sees Calibration progress, Lock status and Plan progress and none of "
            "the other eight", seen_a == bg_rows, sorted(seen_a ^ bg_rows))
    hn = hub(NOC)
    seen_n = {ep for ep in NEW if NEW[ep][1] in labels(card(hn, NEW[ep][0]))}
    s.check("an admin whose role lacks calibration.read and idp.read sees none of the eleven (falsify: with the ticks they see three)",
            seen_n == set(), sorted(seen_n))
    codes_a = {ep: BAC.get(URL[ep]).status_code for ep in NEW}
    s.check("the BG admin downloads their three (200); the other eight are refused (403)",
            all(codes_a[ep] == 200 for ep in bg_rows) and all(codes_a[ep] == 403 for ep in NEW if ep not in bg_rows), codes_a)
    codes_n = {ep: NOC.get(URL[ep]).status_code for ep in NEW}
    s.check("an admin without the ticks is sent away from the three (302) and refused the eight (403)",
            all(codes_n[ep] == 302 for ep in bg_rows) and all(codes_n[ep] == 403 for ep in NEW if ep not in bg_rows), codes_n)
    s.check("...and the audit count for the dates is the super admin's alone",
            SUC.get(URL["admin_export_audit_count"]).status_code == 200 and BAC.get(URL["admin_export_audit_count"]).status_code == 403
            and EMPC.get(URL["admin_export_audit_count"]).status_code in (302, 403))
    s.check("an employee and a signed-out visitor get none of the files",
            all(EMPC.get(URL[ep]).status_code in (302, 403) for ep in NEW)
            and all(a.app.test_client().get(URL[ep]).status_code == 302 for ep in NEW))
    codes_l = {ep: (SUC.get(URL[ep]).status_code, EMPC.get(URL[ep]).status_code) for ep in LMS_NEW}
    s.check("Learning's two files: the super admin downloads them; an employee is refused", all(v[0] == 200 and v[1] in (302, 403) for v in codes_l.values()),
            codes_l)

    # =================================================================================================================================
    s.section("every file is a workbook with an About sheet, named by its picks")
    allf = {}
    for ep in list(NEW) + list(LMS_NEW):
        r, sh, ab = xl(SUC, URL[ep])
        allf[ep] = (r, sh, ab)
    s.check("each is .xlsx (spreadsheet content type, a PK file) with its sheet and an About sheet",
            all(v[0].status_code == 200 and "spreadsheetml" in (v[0].mimetype or "") and "About" in v[1] and len(v[1]) >= 2 for v in allf.values()),
            {ep: (v[0].status_code, v[0].mimetype, list(v[1])[:3]) for ep, v in allf.items() if "About" not in v[1]})
    r, sh, ab = xl(SUC, URL["admin_export_late_passes"] + picks(fbg=BG_A))
    cd = r.headers.get("Content-Disposition", "")
    s.check("a Reports file's name carries the picks, its About sheet the group and units and the cycle",
            "AI+OneHR_ZZSW-Group-A_AllBUs_Cycle_Late_passes_" in cd and ab.get("Business group") == BG_A and ab.get("Cycle"), cd)

    # =================================================================================================================================
    s.section("a BG admin's three files hold their own group only; a pick of another group gives an empty file")
    ppl_a = {EIDS[k] for k in ("A1", "A2", "HODA", "SV1")}
    ppl_b = {EIDS[k] for k in ("B1", "HODB", "SV2")}
    for ep in ("admin_export_calibration_progress", "admin_export_idp_progress"):
        ra, sha, _ = xl(BAC, URL[ep])
        rb, shb, _ = xl(BBC, URL[ep])
        ea, eb = set(col(first(sha), "Employee ID")), set(col(first(shb), "Employee ID"))
        s.check("%s: A's admin gets A's people and none of B's; B's admin the reverse" % ep,
                EIDS["A1"] in ea and EIDS["B1"] not in ea and EIDS["B1"] in eb and EIDS["A1"] not in eb,
                (EIDS["A1"] in ea, EIDS["B1"] in ea, EIDS["B1"] in eb, EIDS["A1"] in eb))
        rx, shx, _ = xl(BAC, URL[ep] + picks(fbg=BG_B))
        s.check("...a pick of the other group gives A's admin an empty file (header only), never B's people",
                rx.status_code == 200 and len(first(shx)) == 1, (rx.status_code, len(first(shx))))
        rs, shs, abs_ = xl(SUC, URL[ep] + picks(fbg=BG_A, fcompany=[UA1]))
        es = set(col(first(shs), "Employee ID"))
        s.check("...the super admin's picks narrow: group A, unit A1 holds A1 and not A2 or B1", EIDS["A1"] in es and EIDS["A2"] not in es
                and EIDS["B1"] not in es and abs_.get("Business units") == UA1, sorted(es & set(EIDS.values())))
    ra, sha, _ = xl(BAC, URL["admin_export_calibration_locks"])
    rb, shb, _ = xl(BBC, URL["admin_export_calibration_locks"])
    wa, wb_ = set(col(first(sha), "Name")), set(col(first(shb), "Name"))
    s.check("Lock status: A's admin sees HODA's department review and not HODB's; B's admin the reverse",
            "ZZ SW HODA" in wa and "ZZ SW HODB" not in wa and "ZZ SW HODB" in wb_ and "ZZ SW HODA" not in wb_,
            ("ZZ SW HODA" in wa, "ZZ SW HODB" in wa, "ZZ SW HODB" in wb_, "ZZ SW HODA" in wb_))
    rx, shx, _ = xl(BAC, URL["admin_export_calibration_locks"] + picks(fbg=BG_B))
    s.check("...a pick of the other group gives A's admin an empty file", rx.status_code == 200 and len(first(shx)) == 1, len(first(shx)))
    rs, shs, _ = xl(SUC, URL["admin_export_calibration_locks"] + picks(fbg=BG_B, fcompany=[UB1]))
    ws_ = set(col(first(shs), "Name"))
    s.check("...the super admin's pick of group B, unit B1: HODB's review and the B1 unit's rows, none of A's",
            "ZZ SW HODB" in ws_ and "ZZ SW HODA" not in ws_, ("ZZ SW HODB" in ws_, "ZZ SW HODA" in ws_))
    # the same file is the page's own rows (relationship): the Lock status file holds one row a scope the page lists
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        me_ = dict(d_.execute("SELECT * FROM users WHERE id=?", (U["BGAA"],)).fetchone())
        n_scopes = len(a._calib_lock_scopes(d_, me_, a.active_cycle(d_)))
    s.check("...and holds exactly the scopes the page lists for that admin (%d)" % n_scopes, len(first(xl(BAC, URL["admin_export_calibration_locks"])[1])) - 1 == n_scopes)

    # =================================================================================================================================
    s.section("Final bands: one file, every Group Chief scope, both bands side by side")
    r, sh, ab = xl(SUC, URL["admin_export_final_bands"])
    fb = first(sh)
    hdr = [str(x) for x in fb[0]]
    s.check("one row a person of every scope (A1 and B1 in Scope One, A2 in Scope Two), the scope and its Group Chief named",
            r.status_code == 200 and set(col(fb, "Employee ID")) == {EIDS["A1"], EIDS["B1"], EIDS["A2"]}
            and {(g, c) for g, c in zip(col(fb, "Group Chief scope"), col(fb, "Group Chief"))} == {("ZZSW Scope One", "ZZ SW CH1"), ("ZZSW Scope Two", "ZZ SW CH2")},
            (len(fb), r.status_code))
    s.check("...both bands' columns side by side: six a band and the decided by and at",
            hdr[7:] == ["Performance: " + x for x in a.FINAL_BANDS_AXIS] + ["Potential: " + x for x in a.FINAL_BANDS_AXIS]
            and {"Performance: BG CEO", "Performance: Group Chief", "Performance: Group Chief locked (MYT)", "Performance: Suggested",
                 "Performance: Final band", "Performance: Remark", "Potential: BG CEO", "Potential: Group Chief", "Potential: Final band",
                 "Potential: Remark"} <= set(hdr), hdr)
    by = {row[hdr.index("Employee ID")]: dict(zip(hdr, row)) for row in fb[1:]}
    # what the band tables hold, read independently of the builders
    def tbl(sql, args=()):
        return db.execute(sql, args).fetchone()

    chief_pm = tbl("SELECT ca.adjusted_band b FROM pm_calibration_adjustments ca JOIN pm_calibration_sessions cs ON cs.id=ca.session_id "
                   "WHERE cs.tier='group' AND cs.scope_key=? AND ca.subject_id=?", (str(G1), U["A1"]))["b"]
    fin_pm = tbl("SELECT ca.adjusted_band b, ca.justification j FROM pm_calibration_adjustments ca JOIN pm_calibration_sessions cs ON "
                 "cs.id=ca.session_id WHERE cs.tier='super' AND ca.subject_id=?", (U["A1"],))
    fin_pot = tbl("SELECT ca.adjusted_band b, ca.justification j FROM calibration_adjustments ca JOIN calibration_sessions cs ON "
                  "cs.id=ca.session_id WHERE cs.tier='super' AND ca.subject_id=?", (U["B1"],))
    chief_pot_b1 = tbl("SELECT ca.adjusted_band b FROM calibration_adjustments ca JOIN calibration_sessions cs ON cs.id=ca.session_id "
                       "WHERE cs.tier='group' AND cs.scope_key=? AND ca.subject_id=?", (str(G1), U["B1"]))["b"]
    a1, b1, a2 = by[EIDS["A1"]], by[EIDS["B1"]], by[EIDS["A2"]]
    s.check("A1: the Group Chief's locked performance call and the super admin's final performance band, with its remark, as the tables hold them",
            a1["Performance: Group Chief"] == chief_pm == "AE" and a1["Performance: Final band"] == fin_pm["b"] == "OU"
            and a1["Performance: Remark"] == fin_pm["j"] and REMARK_PM in a1["Performance: Remark"], a1)
    s.check("...and A1's potential: the Group Chief's call, no final yet", a1["Potential: Group Chief"] == "High" and a1["Potential: Final band"] in ("", None),
            (a1["Potential: Group Chief"], a1["Potential: Final band"]))
    s.check("B1: potential carries the Group Chief's Mid and the super admin's final High with its remark; performance is the BG CEO's call only",
            b1["Potential: Group Chief"] == chief_pot_b1 == "Mid" and b1["Potential: Final band"] == fin_pot["b"] == "High"
            and b1["Potential: Remark"] == fin_pot["j"] and b1["Performance: Group Chief"] in ("", None)
            and b1["Performance: Final band"] in ("", None), b1)
    s.check("A2 (Scope Two): on the file with no call yet, so every band cell is empty", all(a2[k] in ("", None) for k in hdr[7:] if "Group Chief locked" not in k
            and k.endswith(("Group Chief", "Final band", "Remark", "Decided by"))), {k: a2[k] for k in hdr[7:] if a2[k]})
    s.check("a person appears once, with a row's cells from both axes (one row a person)", len(fb) - 1 == 3 and ab.get("Group Chief scopes in the file") == 2,
            (len(fb) - 1, ab.get("Group Chief scopes in the file")))
    # the page's own queue agrees with the file (relationship): the same final band for A1 as Final bands shows
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        pg = {r_["p"]["employee_id"]: r_ for r_ in a._final_bands_rows(d_, PERIOD, G1)[0]}
    s.check("...the file's figure is the page's: A1's final performance band and chief call are the queue's own",
            (pg[EIDS["A1"]]["final"] or {}).get("adjusted_band") == a1["Performance: Final band"] and pg[EIDS["A1"]]["chief"] == a1["Performance: Group Chief"])
    rg, shg, _ = xl(SUC, URL["admin_export_final_bands"] + picks(fbg=BG_B))
    s.check("the panel's picks narrow it (group B: B1 only); a unit with nobody gives an empty file",
            set(col(first(shg), "Employee ID")) == {EIDS["B1"]}
            and len(first(xl(SUC, URL["admin_export_final_bands"] + picks(fbg=BG_A, fcompany=[UB1]))[1])) == 1)

    # =================================================================================================================================
    s.section("the other files: people, cycles, dates")
    r, sh, ab = xl(SUC, URL["admin_export_late_passes"])
    lp = first(sh)
    s.check("Late passes: the active cycle's two passes with who, part, until, given by and why; the cycle pick reads ?cycle= (a cycle with none: empty)",
            {EIDS["A1"], EIDS["B1"]} <= set(col(lp, "Employee ID")) and {"ZZSW late A1", "ZZSW late B1"} <= set(col(lp, "Reason"))
            and len(first(xl(SUC, URL["admin_export_late_passes"] + picks(cycle=OLD))[1])) == 1, len(lp))
    r, sh, ab = xl(SUC, URL["admin_roles_service_list"])
    sv = first(sh)
    s.check("Full on years of service alone: the people with no confirmation date and over a year's service, in the picks (group B: SV2 only)",
            {EIDS["SV1"], EIDS["SV2"]} <= set(col(sv, "Employee ID")) and EIDS["A1"] not in set(col(sv, "Employee ID"))
            and {EIDS["SV2"]} == set(col(first(xl(SUC, URL["admin_roles_service_list"] + picks(fbg=BG_B))[1]), "Employee ID")) & set(EIDS.values()),
            len(sv))
    r, sh, ab = xl(SUC, URL["admin_export_optouts"])
    oo = first(sh)
    s.check("Opted out of emails: both people, running, with the reason; the picks narrow it",
            {EIDS["A1"], EIDS["B1"]} <= set(col(oo, "Employee ID")) and {"ZZSW off A1", "ZZSW off B1"} <= set(col(oo, "Why"))
            and set(col(first(xl(SUC, URL["admin_export_optouts"] + picks(fbg=BG_A))[1]), "Employee ID")) & set(EIDS.values()) == {EIDS["A1"]})
    r, sh, ab = xl(SUC, URL["admin_export_ask_log"])
    aq = first(sh)
    s.check("Ask OneHR questions: the two questions with group, unit and department and no name or Employee ID column; the picks narrow it",
            {"ZZSW question A1", "ZZSW question B1"} <= set(col(aq, "Question")) and not ({"Name", "Employee ID", "Employee name"} & set(map(str, aq[0])))
            and {"ZZSW question B1"} == {q for q in col(first(xl(SUC, URL["admin_export_ask_log"] + picks(fbg=BG_B, fcompany=[UB1]))[1]), "Question") if "ZZSW" in q})
    r, sh, ab = xl(SUC, URL["admin_feedback_export"])
    fbk = first(sh)
    s.check("AI+ feedback: the cycle's two cards with their line, the group and unit; ?cycle= reads another cycle's (one row, no line)",
            {"ZZSW line A1", "ZZSW line B1"} <= set(col(fbk, "What they wrote"))
            and {EIDS["A2"]} == set(col(first(xl(SUC, URL["admin_feedback_export"] + picks(cycle=OLD))[1]), "Employee ID")) & set(EIDS.values()))
    # Data integrity: a sheet per check. The pages cap a check's list (DATA_CHECK_ROW_CAP); the workbook is every row: the cap is
    # set low here so a capped read would show
    CAP0 = a.DATA_CHECK_ROW_CAP
    a.DATA_CHECK_ROW_CAP = 5
    r, sh, ab = xl(SUC, URL["admin_export_data_integrity"])
    titles = [t for t in sh if t != "About"]
    s.check("Data integrity: a sheet per check (%d), titles unique, within 31 characters, the columns of each check's own Excel" % len(a.DATA_CHECKS),
            len(titles) == len(a.DATA_CHECKS) == len({t.lower() for t in titles}) and all(len(t) <= 31 for t in titles)
            and all([str(x) for x in sh[t][0]] == a.DATA_CHECK_HEAD for t in titles), (len(titles), len(a.DATA_CHECKS)))
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        me_ = dict(d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        want = [len(a.data_check_rows(d_, me_, a.active_cycle_id(d_), c, cap=False)[0]) for c in a.DATA_CHECKS]
    s.check("...each sheet holds every row of its check, uncapped (the Data integrity page's own rows)", [len(sh[t]) - 1 for t in titles] == want, (want, [len(sh[t]) - 1 for t in titles]))
    s.check("...the synthetic people with no email are on 'No email address' (they have none), and the picks narrow it to a group",
            EIDS["A1"] in col(sh["No email address"], "Employee ID")
            and EIDS["B1"] in col(sh["No email address"], "Employee ID")
            and EIDS["B1"] not in col(xl(SUC, URL["admin_export_data_integrity"] + picks(fbg=BG_A))[1]["No email address"], "Employee ID"))
    a.DATA_CHECK_ROW_CAP = CAP0
    s.check("(the cap was %d here: some check holds more rows than that, so a capped workbook would have shown)" % 5, max(want) > 5, max(want))
    # the audit log's dates
    base_url = URL["admin_export_audit_log"]
    def marks(url):
        r_, sh_, ab_ = xl(SUC, url)
        return sorted(d for d in (re.findall(r"ZZSW audit mark (\d{4}-\d{2}-\d{2})", str(x)) for x in col(first(sh_), "Detail")) for d in d), ab_, len(first(sh_)) - 1

    all_m, ab_all, n_all = marks(base_url)
    mid_m, ab_mid, n_mid = marks(base_url + picks(date_from="2026-09-10", date_to="2026-09-20"))
    from_m, _x, _y = marks(base_url + picks(date_from="2026-09-10"))
    to_m, _x, _y = marks(base_url + picks(date_to="2026-09-20"))
    s.check("the audit log with no dates holds all three marks; with a range only the one inside it (date_from / date_to)",
            all_m == ["2026-09-05", "2026-09-15", "2026-09-25"] and mid_m == ["2026-09-15"], (all_m, mid_m))
    s.check("...an open end is open: from the 10th holds the 15th and the 25th; to the 20th holds the 5th and the 15th",
            from_m == ["2026-09-15", "2026-09-25"] and to_m == ["2026-09-05", "2026-09-15"], (from_m, to_m))
    s.check("...the About sheet says the dates, 'Everything' without any; no business group or unit rows (the dates don't cut by them)",
            ab_mid.get("Dates") == "2026-09-10 to 2026-09-20" and ab_all.get("Dates") == "Everything" and "Business group" not in ab_mid,
            (ab_mid.get("Dates"), ab_all.get("Dates")))
    rr = SUC.get(base_url + picks(date_from="2026-09-10", date_to="2026-09-20"))
    s.check("...and the file's name carries them", "_from_2026-09-10_to_2026-09-20_" in rr.headers.get("Content-Disposition", ""), rr.headers.get("Content-Disposition"))
    cnt = lambda q_="": SUC.get(URL["admin_export_audit_count"] + q_).get_json()["n"]   # noqa: E731
    # (a download is itself an audit row, written after its rows are read: count, then read the file straight after, nothing between)
    c_all = cnt()
    n_all2 = len(first(xl(SUC, base_url)[1])) - 1
    c_mid = cnt(picks(date_from="2026-09-10", date_to="2026-09-20"))
    n_mid2 = len(first(xl(SUC, base_url + picks(date_from="2026-09-10", date_to="2026-09-20"))[1])) - 1
    s.check("the panel's count for the dates is the file's rows: with no dates, and with a range",
            c_all == n_all2 and c_mid == n_mid2 == n_mid and n_mid < n_all, (c_all, n_all2, c_mid, n_mid2))

    # =================================================================================================================================
    s.section("the panel's count for each is the number of rows its file holds")
    D = dl_data(hub(SUC))
    C = D.get("counts", {})
    KEY = {"admin_export_calibration_progress": "sw_cal_prog", "admin_export_idp_progress": "sw_idp_prog",
           "admin_export_calibration_locks": "sw_locks", "admin_export_final_bands": "sw_fbands", "admin_roles_service_list": "sw_service",
           "admin_export_optouts": "sw_optouts", "admin_export_ask_log": "sw_ask", "admin_export_data_integrity": "sw_integrity"}
    bad = []
    for ep, key in KEY.items():
        for bg_ in (BG_A, BG_B):
            n_file = len(first(xl(SUC, URL[ep] + picks(fbg=bg_))[1])) - 1
            if ep == "admin_export_data_integrity":
                n_file = sum(len(v) - 1 for k, v in xl(SUC, URL[ep] + picks(fbg=bg_))[1].items() if k != "About")
            n_cnt = (C.get(key, {}).get(bg_) or {}).get("n", 0)
            if n_file != n_cnt:
                bad.append((ep, bg_, n_file, n_cnt))
    s.check("every group-by-group count the panel is given is the number of rows the file holds for that group (%d files, two groups)" % len(KEY), not bad, bad)
    bad = []
    for ep, key in (("admin_export_late_passes", "sw_late"), ("admin_feedback_export", "sw_feedback")):
        for cid_ in (CID, OLD):
            for bg_ in (BG_A, BG_B):
                n_file = len(first(xl(SUC, URL[ep] + picks(fbg=bg_, cycle=cid_))[1])) - 1
                n_cnt = (C.get(key, {}).get("__cycle", {}).get(str(cid_), {}).get(bg_) or {}).get("n", 0)
                if n_file != n_cnt:
                    bad.append((ep, cid_, bg_, n_file, n_cnt))
    s.check("...and the cycle-picked two (late passes, feedback) are counted per cycle, each the file's rows", not bad, bad)
    s.check("...a unit's count is the file's rows for that unit (Calibration progress, unit A1 and A2)",
            all(len(first(xl(SUC, URL["admin_export_calibration_progress"] + picks(fbg=BG_A, fcompany=[u_]))[1])) - 1
                == ((C["sw_cal_prog"].get(BG_A) or {}).get("u") or {}).get(u_, 0) for u_ in (UA1, UA2)))
    ab_ = BAC.get(HUB + "?kind=data").get_data(as_text=True)
    Cb = dl_data(ab_).get("counts", {})
    s.check("a BG admin's counts hold their three files and only their group (nothing of the super admin's)",
            set(Cb) == {"sw_cal_prog", "sw_idp_prog", "sw_locks"} and all(set(v) == {BG_A} or BG_A in v and BG_B not in v for v in Cb.values()), {k: list(v)[:3] for k, v in Cb.items()})
    s.check("the panel script knows the dates and the unit words (static/dl_scope.js)", all(x in open(os.path.join(os.path.dirname(a.__file__), "static", "dl_scope.js")).read()
                                                                                         for x in ("data-dl-remote", "data-dl-dates", "__cycle", "data-dl-unit")))

    # =================================================================================================================================
    s.section("Learning's two files, and the removed words elsewhere")
    r, sh, ab = xl(SUC, URL["admin_export_lms_needs"])
    s.check("Learning needs: the needs page's own columns, with an About sheet; ISO evidence: the Effectiveness page's",
            r.status_code == 200 and first(sh)[0][:3] == ["Competency", "People who need it", "Stars or Super Stars"]
            and [str(x) for x in first(xl(SUC, URL["admin_export_lms_effectiveness"])[1])[0]] == a.LMS_EVIDENCE_HEAD, first(sh)[0][:3])
    with a.app.test_request_context("/"):
        adm_text = " ".join(x[3] for x in a.ADMIN_ITEMS)
    s.check("the access page's words no longer promise People a download of its own", "downloads on Reports" in adm_text and "a person's page, downloads" not in adm_text)
finally:
    os.environ.pop("ONEHR_LMS", None)
    db.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
    db.commit()
sys.exit(s.done())
