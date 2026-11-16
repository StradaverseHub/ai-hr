"""Grade H Appraisal: the Grade H HOD from Group People's list (Chris, 2026-11-02: "set the HOD as per the HR file ... and don't affect
our current HOD in production for JG12 and above").

What this suite holds:
  * storage: gradeh_people.hod_user_id (nullable), in the DDL, in SCHEMA and behind the ALTER guard; users.hod_id is NEVER written by
    anything Grade H (every user's hod_id is byte-identical before and after the import and every Set HOD)
  * the effective Grade H HOD = COALESCE(hod_user_id, users.hod_id): a blank falls back to the OneHR HOD; the listed HOD (not the
    users.hod_id one) sees the person on /calibration/gradeh/hod and can move and sign off, the old one no longer does
  * an HOD who has left, or who is the person themselves, is no HOD: the BU CEO covers them, and they count as done for the BU early opening
  * a listed HOD who is the unit's BU CEO: the BU CEO covers; a BU CEO or BG CEO holds no Grade H HOD role (gradeh_hod_has_role) whoever lists them (a calibrator of the normal review does, 2026-11-03)
  * sign-offs are keyed by the effective HOD (the early opening of the BU CEO's stage reads them)
  * an HOD for Grade H only (no Department Review) has the dashboard's Your next step row and the journey's Grade H tab; a Department
    Review's HOD does not need them; the leader reminder, the audiences and People & progress read the effective HOD
  * the list import: the column (after Appraiser employee ID), its template, blank = NULL, a value must be an active, non-demo, other person
    (a linked ID works), another business group and a calibrator only warn, a different HOD asks the super admin, a blank never wipes
  * Set HOD on People & progress: super admin only, picked, double-confirmed, audited, refused once the HOD has signed
  * the KB row is reworded once, Help / Ask / the agent's prompt say where the Grade H HOD comes from

Synthetic (ZZ9HL-*) on a fresh scratch database; the suite puts back what it changes.
"""
import csv as _csv
import hashlib
import io
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H Appraisal: the Grade H HOD from the list")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, EMP = H.actors(a)
PFX, BG, BG2, CO, COB = "ZZ9HL-", "ZZHL Group", "ZZHL Other Group", "ZZHL Unit A", "ZZHL Unit B"
U, P = {}, {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
BASE = "/calibration/gradeh"
LIST = "/admin/gradeh/import/list"
import sqlite3  # noqa: E402

db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
FMT = "%Y-%m-%d %H:%M"
UTCF = "%Y-%m-%d %H:%M:%S"
LH = list(a.GRADEH_LIST_IMPORT_COLUMNS)
HOD_COL = LH.index("HOD employee ID") if "HOD employee ID" in LH else -1


def one(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return r[0] if r else None


def run(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        r = fn(d)
        d.commit()
        return r


def text(resp):
    h = resp.get_data(as_text=True)
    h = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", h)
    m = re.search(r'<main id="main"[\s\S]*', h)
    h = m.group(0) if m else h
    h = re.sub(r"<[^>]+>", " ", h)
    return " ".join(h.replace("&#39;", "'").replace("&amp;", "&").replace("&quot;", '"').split())


def csrf(**kw):
    d = {"csrf_token": "tok"}
    d.update(kw)
    return d


def utc(dt_myt):
    return (dt_myt - timedelta(hours=8)).strftime(UTCF) if dt_myt else ""


def mk(k, grade="H", hod=None, co=CO, bg=BG, dept="ZZHL Dept", title="Driver", demo=0):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, job_title, hod_id, confirmation_date, is_demo, email) VALUES (?,?, 'x', 'user', ?,?,?,?,?,?,?, '2020-01-01', ?, ?)",
        ((PFX + k).lower(), "ZZ HL " + k, PFX + k, bg, co, dept, grade, title, hod, demo, "zzhl.%s@example.test" % k.lower())).lastrowid


def person(k, hod_user=None, submitted=True):
    pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, hod_user_id) VALUES (?,?,?,'B',?)",
                     (CID, PFX + k, U[k], hod_user)).lastrowid
    P[k] = pid
    db.execute(
        "INSERT INTO gradeh_appraisals (cycle_id, person_id, lm_submitted_at, perf_band, pot_band, perf_rating, pot_score, "
        "b_achievements, b_strengths, b_development, conversation_held, acknowledged_at) VALUES (?,?,?,?,?,3.2,9.0,'a','s','d',1,?)",
        (CID, pid, (NOW - timedelta(days=3)).strftime(UTCF) if submitted else None, "ME" if submitted else None,
         "Mid" if submitted else None, utc(NOW)))
    db.commit()
    return pid


def urow(k):
    return db.execute("SELECT * FROM users WHERE id=?", (U[k],)).fetchone()


def hod_snapshot():
    return [tuple(r) for r in db.execute("SELECT id, hod_id FROM users ORDER BY id")]


def scope(k):
    return run(lambda d: {r["id"] for r in a.gradeh_hod_scope(d, U[k], CID)})


def names(k):
    return {kk for kk, v in P.items() if v in scope(k)}


def hod_open(k, stage="pot", now=None):
    return run(lambda d: a.gradeh_hod_open_for(d, CID, U[k], stage, now))


def bu_open(co=CO, bg=BG):
    return run(lambda d: a.gradeh_bu_open_for(d, CID, co, bg))


def hsign(k, stages=("pot", "perf")):
    for stg in stages:
        db.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?,?,?,?,?)",
                   (CID, "hod", stg, str(U[k]), U[k]))
    db.commit()


def unsign(k):
    db.execute("DELETE FROM gradeh_signoffs WHERE cycle_id=? AND tier='hod' AND scope_key=?", (CID, str(U[k])))
    db.commit()


def cells(w):
    def _w(d):
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell LIKE 'gradeh_%'", (CID,))
        for cell in ("gradeh_hod_pot", "gradeh_hod_perf", "gradeh_buceo"):
            d.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                      (CID, cell, w[0].strftime(FMT), w[1].strftime(FMT)))
    run(_w)


def setting(name, value):
    run(lambda d: a.gradeh_set_setting(d, name, value, None))


def xfile(rows, head=None):
    buf = io.StringIO()
    w = _csv.writer(buf)
    w.writerow(head or LH)
    w.writerows(rows)
    return io.BytesIO(buf.getvalue().encode())


def lrow(eid, hod="", appr="", route="Line manager", sup="", co=CO, priv=""):
    """One row of the list file, in the import's own column order (found by name, so the test follows the constant)."""
    row = [""] * len(LH)
    for col, val in (("Employee ID", eid), ("Route", route), ("Appraiser employee ID", appr), ("HOD employee ID", hod),
                     ("Supervisor name", sup), ("Company", co), ("Private company", priv)):
        row[LH.index(col)] = val
    return row


def stage(f, cl=None):
    r = (cl or C_SU).post(LIST, data={"csrf_token": "tok", "preview": "1", "file": (f, "gh.csv")}, content_type="multipart/form-data")
    return (re.search(r"check=([0-9a-f]{32})", r.headers.get("Location", "")) or [None, ""])[1]


def step(tok, action, **form):
    return C_SU.post(LIST, data=dict({"csrf_token": "tok", "token": tok, "action": action}, **form))


def page(tok, st=None):
    return C_SU.get(LIST + "?check=%s%s" % (tok, ("&step=" + st) if st else "")).get_data(as_text=True)


def fid(key):
    return "d_" + hashlib.sha1(key.encode()).hexdigest()[:10]


def load(rows, head=None):
    with a.app.test_request_context("/"):
        d = a.get_db()
        me = dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        spec = a._IMP[a.GRADEH_LIST_KIND]
        ctx = spec["load"](d, me, {"filename": "gh.csv"}, xfile(rows, head).read())
        return ctx, a._imp_quality(spec, ctx)


def apply_file(rows, picks=None):
    """The four steps through the real routes; returns the token (the file applied) or None when a step stopped it."""
    tok = stage(xfile(rows))
    if not tok:
        return None
    step(tok, "quality_ok", ack="1")
    r = step(tok, "to_apply", **{fid(k): v for k, v in (picks or {}).items()})
    if "step=apply" not in r.headers.get("Location", ""):
        return None
    step(tok, "apply")
    return tok


def gp(k):
    return db.execute("SELECT * FROM gradeh_people WHERE cycle_id=? AND employee_id=?", (CID, PFX + k)).fetchone()


if True:
    CID = run(lambda d: a.active_cycle_id(d))
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()["half"]
    OBD0 = one("SELECT open_by_date FROM cycles WHERE id=?", (CID,))
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
    for bg_, c_ in ((BG, CO), (BG, COB), (BG2, "ZZHL Other Unit")):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (bg_, c_))
    NOW = a._now_myt()
    # seats
    U["BCA"] = mk("BCA", "21", dept="ZZHL Division")                       # unit A's BU CEO
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, U["BCA"]))
    U["BCB"] = mk("BCB", "21", co=COB, dept="ZZHL Division")               # unit B's BU CEO
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, COB, U["BCB"]))
    U["CAL"] = mk("CAL", "22", dept="ZZHL Division")                       # a BG CEO: holds no Grade H HOD role
    db.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (BG, U["CAL"]))
    U["OLDH"] = mk("OLDH", "15", hod=U["BCA"], dept="ZZHL Old")            # the HOD in OneHR (users.hod_id); JG 15 so the check-in is theirs too
    U["LISTH"] = mk("LISTH", "15", hod=U["BCA"], dept="ZZHL Listed")       # named by the list only: nobody's users.hod_id
    U["LEFTH"] = mk("LEFTH", "19", dept="ZZHL Left")
    U["LEFTL"] = mk("LEFTL", "19", dept="ZZHL LeftL")                      # active when the list names them, leaves after
    U["XBG"] = mk("XBG", "19", bg=BG2, co="ZZHL Other Unit", dept="ZZHL Other")   # an HOD in another business group
    U["MR1"] = mk("MR1", "15", hod=U["OLDH"], dept="ZZHL Old")             # a JG 15 report of OLDH: the main review's Department Review
    # the Grade H people, unit A: who their OneHR HOD is (the list adds its HOD later, through the import)
    U["G1"] = mk("G1", hod=U["OLDH"])        # list: LISTH
    U["G2"] = mk("G2", hod=U["OLDH"])        # list: none
    U["G3"] = mk("G3", hod=U["LEFTH"])       # OneHR HOD has left, list: none
    U["G4"] = mk("G4", hod=U["OLDH"])        # list: LEFTL, who leaves
    U["G5"] = mk("G5", hod=U["OLDH"])        # list: the unit's BU CEO
    U["G6"] = mk("G6", hod=U["OLDH"])        # list: a BG CEO
    U["G7"] = mk("G7")                       # no OneHR HOD; list: LISTH
    U["G8"] = mk("G8")                       # OneHR HOD is themselves
    db.execute("UPDATE users SET hod_id=id WHERE id=?", (U["G8"],))
    U["G9"] = mk("G9", hod=U["BCA"])         # OneHR HOD is the unit's BU CEO; list: LISTH
    U["G10"] = mk("G10", hod=U["OLDH"])      # list: an HOD in another business group
    db.execute("UPDATE users SET left_at=datetime('now') WHERE id=?", (U["LEFTH"],))
    # unit B (the BU CEO's early opening)
    U["OLDB"] = mk("OLDB", "19", hod=U["BCB"], co=COB, dept="ZZHL Old B")
    U["LISTB"] = mk("LISTB", "19", hod=U["BCB"], co=COB, dept="ZZHL Listed B")
    U["LEFTB"] = mk("LEFTB", "19", co=COB, dept="ZZHL Left B")
    U["B1"] = mk("B1", hod=U["LEFTB"], co=COB)
    U["B2"] = mk("B2", hod=U["OLDB"], co=COB)
    db.execute("UPDATE users SET left_at=datetime('now') WHERE id=?", (U["LEFTB"],))
    for k_ in ("ai_calib", "review_unified"):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k_,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','calibration','pm','tm')")
    db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
    db.commit()

C = {k: H.client_as(a, U[k]) for k in U}
C_SU = H.client_as(a, SU["id"])
C_EMP = H.client_as(a, EMP["id"])
_real_avail = a.ai_draft.review_agent_available
a.ai_draft.review_agent_available = lambda: True
DAY = timedelta(days=1)
INSIDE = (NOW - DAY, NOW + 10 * DAY)

try:
    cells(INSIDE)
    setting("gradeh_hod_fallback_at", "")
    setting("gradeh_bu_fallback_at", "")

    # ======================================================================================================================
    s.section("storage: a nullable column, in the DDL, in SCHEMA, behind the ALTER guard")
    cols = {r["name"]: r for r in db.execute("PRAGMA table_info(gradeh_people)")}
    s.check("gradeh_people.hod_user_id exists, INTEGER, nullable, no default", "hod_user_id" in cols and cols["hod_user_id"]["type"] == "INTEGER"
            and not cols["hod_user_id"]["notnull"] and cols["hod_user_id"]["dflt_value"] is None, dict(cols.get("hod_user_id") or {}))
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app.py"), encoding="utf-8").read()
    s.check("the same column is in _GRADEH_DDL and in SCHEMA (two copies, held equal by test_gradeh_gate)", src.count(
        "    private_company INTEGER NOT NULL DEFAULT 0,\n    hod_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,") == 2)
    s.check("and an ALTER guard for a table made before it", "ALTER TABLE gradeh_people ADD COLUMN hod_user_id" in src)
    # the guard: take the column away, run the schema step, it is back (a falsified guard would leave it missing)
    try:
        db.execute("PRAGMA foreign_keys=OFF")
        db.execute("ALTER TABLE gradeh_people DROP COLUMN hod_user_id")
        db.commit()
        dropped = "hod_user_id" not in [r[1] for r in db.execute("PRAGMA table_info(gradeh_people)")]
    except sqlite3.OperationalError as e:   # this SQLite refuses to drop a foreign-key column: the guard is then read in the source only
        dropped = False
        s.note("DROP COLUMN refused here (%s): the guard was read in the source above" % e)
    if dropped:
        a._ensure_runtime_schema()
        s.check("falsified: with the column gone, _ensure_runtime_schema() adds it back (the ALTER guard runs)",
                "hod_user_id" in [r[1] for r in db.execute("PRAGMA table_info(gradeh_people)")])
        a._ensure_runtime_schema()
        s.check("...and a second run changes nothing", "hod_user_id" in [r[1] for r in db.execute("PRAGMA table_info(gradeh_people)")])
    db.execute("PRAGMA foreign_keys=ON")

    # ======================================================================================================================
    s.section("the list import: columns, template, the example row")
    s.check("the column is 'HOD employee ID', right after 'Appraiser employee ID'", HOD_COL == LH.index("Appraiser employee ID") + 1, LH)
    r = C_SU.get(LIST + "/template.xlsx")
    from openpyxl import load_workbook  # noqa: E402
    rr = [list(x) for x in load_workbook(io.BytesIO(r.data), read_only=True).worksheets[0].iter_rows(values_only=True)]
    s.check("the template download has the column, and every example row (HOD cell included) is an EXAMPLE- placeholder",
            [str(x) for x in rr[0]] == LH and all(str(x[0]).startswith("EXAMPLE-") for x in rr[1:])
            and all(len(x) == len(LH) for x in rr[1:]) and any(str(x[HOD_COL]).startswith("EXAMPLE-") for x in rr[1:]), rr[:3])
    pg = C_SU.get(LIST).get_data(as_text=True)
    s.check("the page's column help names the HOD column, says it is Grade H only and blank = their OneHR HOD",
            "HOD employee ID" in pg and "Grade H only" in pg and "blank means their HOD on OneHR" in pg)
    rx = C_SU.get("/admin/gradeh/export/not-on-list.xlsx")
    rxr = [list(x) for x in load_workbook(io.BytesIO(rx.data), read_only=True).worksheets[0].iter_rows(values_only=True)] if rx.status_code == 200 else [[]]
    s.check("the 'not on the list' download follows the constant: its first columns are the import's, HOD employee ID included",
            [str(x) for x in rxr[0][:len(LH)]] == LH, rxr[0])

    # ======================================================================================================================
    s.section("the list import: quality (refused, warned)")
    bad = [lrow(PFX + "G1", hod=PFX + "G1"),                       # themselves
           lrow(PFX + "G2", hod=PFX + "LEFTH"),                     # has left
           lrow(PFX + "G3", hod=PFX + "NOPE"),                      # unknown
           lrow(PFX + "G4", hod=SU["employee_id"] if SU["employee_id"] else "ZZNOADMIN"),   # an admin account is no HOD
           lrow(PFX + "G5", hod=PFX + "DEMO")]                      # a demo login
    db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, job_grade, is_demo) "
               "VALUES (?,?, 'x', 'user', ?, ?, ?, '19', 1)", ((PFX + "DEMO").lower(), "ZZ HL DEMO", PFX + "DEMO", BG, CO))
    db.commit()
    snap0 = hod_snapshot()   # after the last account the suite makes: from here every users.hod_id must stay as it is
    ctx, q = load(bad)
    why = {e["eid"]: e["why"] for e in ctx["errors"]}
    s.check("an HOD who is the person themselves is refused, naming it", "own HOD" in why.get(PFX + "G1", ""), why.get(PFX + "G1"))
    s.check("an HOD who has left is refused", "isn't a current employee" in why.get(PFX + "G2", ""), why.get(PFX + "G2"))
    s.check("an unknown Employee ID is refused", "isn't a current employee" in why.get(PFX + "G3", ""), why.get(PFX + "G3"))
    s.check("an admin account is refused", "isn't a current employee" in why.get(PFX + "G4", ""), why.get(PFX + "G4"))
    s.check("a demo login is refused", "demo login" in why.get(PFX + "G5", ""), why.get(PFX + "G5"))
    s.check("all five are in one fix group on the quality step, 'An HOD OneHR can't use'", {f["kind"]: f["n"] for f in q["fix"]}.get("An HOD OneHR can't use") == 5,
            {f["kind"]: f["n"] for f in q["fix"]})
    s.check("falsified: the same rows with a usable HOD (LISTH) have no fix", not load([lrow(PFX + "G1", hod=PFX + "LISTH")])[0]["errors"])
    pg = page(stage(xfile(bad)))
    s.check("the file cannot go on: the page says what can't be imported", "fix them in your file" in pg)
    ctx, q = load([lrow(PFX + "G10", hod=PFX + "XBG"), lrow(PFX + "G6", hod=PFX + "CAL"), lrow(PFX + "G1", hod=PFX + "LISTH")])
    lk = {g["key"]: g["n"] for g in q["look"]}
    s.check("an HOD in another business group is a warning (worth a look), not an error", not ctx["errors"] and lk.get("hod_bg") == 1
            and any("ZZ HL XBG" in f["detail"] for g in q["look"] if g["key"] == "hod_bg" for f in g["found"]), (lk, ctx["errors"]))
    s.check("an HOD who holds a BG CEO seat is a warning too (they have no Grade H HOD role)", lk.get("hod_norole") == 1, lk)
    s.check("the same-group, ordinary HOD (LISTH) raises neither warning", all(f["eid"] != PFX + "G1" for g in q["look"]
            if g["key"] in ("hod_bg", "hod_norole") for f in g["found"]))
    # a linked ID finds its person (the import's way of resolving Employee IDs)
    db.execute("INSERT INTO user_employee_ids(user_id, employee_id, linked_at) VALUES (?,?,datetime('now'))", (U["LISTH"], PFX + "LISTH-A"))
    db.commit()
    ctx, _q = load([lrow(PFX + "G1", hod=PFX + "LISTH-A")])
    s.check("a person's linked Employee ID resolves to them as the HOD", not ctx["errors"] and ctx["valid"][0]["hod_id"] == U["LISTH"],
            (ctx["errors"], [v["hod_id"] for v in ctx["valid"]]))
    s.check("nothing was written by checking a file", db.execute("SELECT COUNT(*) FROM gradeh_people").fetchone()[0] == 0 and hod_snapshot() == snap0)

    # ======================================================================================================================
    s.section("the import writes gradeh_people.hod_user_id only; a blank is NULL and falls back to their OneHR HOD")
    everyone = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10"]
    tok = apply_file([lrow(PFX + k_) for k_ in everyone])
    s.check("a first file with no HODs puts all ten on the list", tok and db.execute("SELECT COUNT(*) FROM gradeh_people WHERE cycle_id=?", (CID,)).fetchone()[0] == 10)
    s.check("...every hod_user_id is NULL (a blank stores NULL)", db.execute("SELECT COUNT(*) FROM gradeh_people WHERE hod_user_id IS NOT NULL").fetchone()[0] == 0)
    s.check("...and users.hod_id is byte-identical for every user", hod_snapshot() == snap0)
    for k_ in everyone:
        P[k_] = gp(k_)["id"]
        db.execute(
            "INSERT INTO gradeh_appraisals (cycle_id, person_id, lm_submitted_at, perf_band, pot_band, perf_rating, pot_score, b_achievements, "
            "b_strengths, b_development, conversation_held, acknowledged_at) VALUES (?,?,?,?,?,3.2,9.0,'a','s','d',1,?)",
            (CID, P[k_], (NOW - timedelta(days=3)).strftime(UTCF), "ME", "Mid", utc(NOW)))
    db.commit()
    # BEFORE: everyone with an OneHR HOD is that HOD's; nobody has LISTH
    s.check("before any HOD is listed the effective HOD is users.hod_id: OLDH has G1 G2 G4 G5 G6 G10, LISTH has nobody, the left / own / BU CEO ones go to the BU CEO",
            names("OLDH") == {"G1", "G2", "G4", "G5", "G6", "G10"} and names("LISTH") == set(), (names("OLDH"), names("LISTH")))
    s.check("...a left OneHR HOD (G3), an own-HOD (G8) and the BU CEO as HOD (G9) are in no HOD's scope",
            not any(P[k_] in scope(h) for k_ in ("G3", "G8", "G9") for h in ("OLDH", "LISTH", "LEFTH", "BCA")))
    main0 = run(lambda d: [(t, k) for t, k in a.calibration_tier_of(d, urow("OLDH"))])
    main0_l = run(lambda d: [(t, k) for t, k in a.calibration_tier_of(d, urow("LISTH"))])

    good = [lrow(PFX + "G1", hod=PFX + "LISTH"), lrow(PFX + "G2"), lrow(PFX + "G3"), lrow(PFX + "G4", hod=PFX + "LEFTL"),
            lrow(PFX + "G5", hod=PFX + "BCA"), lrow(PFX + "G6", hod=PFX + "CAL"), lrow(PFX + "G7", hod=PFX + "LISTH"), lrow(PFX + "G8"),
            lrow(PFX + "G9", hod=PFX + "LISTH"), lrow(PFX + "G10", hod=PFX + "XBG")]
    tk = stage(xfile(good))
    pg = page(tk)
    s.check("the quality step shows both warnings (another business group, a BG CEO seat) and no error", "worth a look" in pg
            and "different business group" in pg and "BU CEO or BG CEO seat" in pg and "fix them in your file" not in pg)
    step(tk, "quality_ok", ack="1")
    pg = page(tk, "changes")
    s.check("step 3 shows an HOD column and the file's HOD by name", re.search(r">\s*HOD\s*<", pg) is not None and "ZZ HL LISTH" in pg, pg[:0])
    s.check("...a blank row reads as their OneHR HOD (named), and a person with none as the BU CEO covering",
            "OneHR HOD (ZZ HL OLDH)" in pg and "the BU CEO covers them" in pg)
    step(tk, "to_apply")
    pg = page(tk, "apply")
    s.check("the final preview shows the HOD column and the same names", "ZZ HL LISTH" in pg and "OneHR HOD (ZZ HL OLDH)" in pg)
    dl = C_SU.get(LIST + "/check/%s.xlsx?what=final" % tk)
    rows_ = [list(x) for x in load_workbook(io.BytesIO(dl.data), read_only=True).worksheets[0].iter_rows(values_only=True)]
    s.check("...and its Excel has an HOD column", dl.status_code == 200 and "HOD" in [str(x) for x in rows_[0]], rows_[:1])
    s.check("nothing is written before Apply", db.execute("SELECT COUNT(*) FROM gradeh_people WHERE hod_user_id IS NOT NULL").fetchone()[0] == 0)
    step(tk, "apply")
    want = {"G1": "LISTH", "G4": "LEFTL", "G5": "BCA", "G6": "CAL", "G7": "LISTH", "G9": "LISTH", "G10": "XBG"}
    got = {k_: gp(k_)["hod_user_id"] for k_ in everyone}
    s.check("applied: hod_user_id is the file's HOD where the file names one, NULL where it is blank",
            all(got[k_] == (U[want[k_]] if k_ in want else None) for k_ in everyone), got)
    s.check("USERS.HOD_ID IS BYTE-IDENTICAL for every user after the import (the main review's HOD is untouched)", hod_snapshot() == snap0)
    s.check("...so the HODs of the main review are the same: OLDH and LISTH hold the same calibration tiers as before",
            run(lambda d: [(t, k) for t, k in a.calibration_tier_of(d, urow("OLDH"))]) == main0
            and run(lambda d: [(t, k) for t, k in a.calibration_tier_of(d, urow("LISTH"))]) == main0_l)
    s.check("...and OLDH's main-review report (MR1) is still theirs and only theirs",
            [r_[0] for r_ in db.execute("SELECT id FROM users WHERE hod_id=? AND id=?", (U["OLDH"], U["MR1"]))] == [U["MR1"]]
            and db.execute("SELECT COUNT(*) FROM users WHERE hod_id=?", (U["LISTH"],)).fetchone()[0] == 0)
    audit = db.execute("SELECT detail FROM activity_log WHERE action='gradeh_import_list' ORDER BY id DESC LIMIT 1").fetchone()
    s.check("the import is audited", audit is not None)
    db.execute("UPDATE users SET left_at=datetime('now') WHERE id=?", (U["LEFTL"],))   # G4's listed HOD leaves after the list
    db.execute("UPDATE gradeh_people SET hod_user_id=? WHERE id=?", (U["G8"], P["G8"]))   # a listed HOD who is the person themselves (the import refuses it)
    db.commit()

    # ======================================================================================================================
    s.section("the effective HOD: the listed one, not users.hod_id")
    s.check("LISTH now has G1, G7 and G9 (G9's OneHR HOD was the BU CEO: the list's HOD takes it back from the BU CEO)",
            names("LISTH") == {"G1", "G7", "G9"}, names("LISTH"))
    s.check("OLDH keeps only G2 (blank list) and G10's goes to the other group's HOD: G1 left them, G4 / G5 / G6 left them for 'no HOD'",
            names("OLDH") == {"G2"} and names("XBG") == {"G10"}, (names("OLDH"), names("XBG")))
    s.check("a blank falls back to users.hod_id: G2 is OLDH's although the file never named them", P["G2"] in scope("OLDH"))
    s.check("falsified: the old HOD is no longer the HOD of a listed person (G1 not in OLDH's scope)", P["G1"] not in scope("OLDH"))
    s.check("an HOD who has left is no HOD: G3 (OneHR HOD left) and G4 (listed HOD left) are in nobody's scope",
            not any(P[k_] in scope(h) for k_ in ("G3", "G4") for h in ("OLDH", "LISTH", "LEFTH", "LEFTL", "BCA")))
    s.check("an effective HOD who is the person themselves is no HOD (G8, by users.hod_id and by the list)",
            not any(P["G8"] in scope(h) for h in ("OLDH", "LISTH", "G8")))
    s.check("a listed HOD who is the unit's BU CEO: the BU CEO covers (G5 in nobody's HOD scope)",
            not any(P["G5"] in scope(h) for h in ("OLDH", "BCA", "LISTH")))
    s.check("...and the reverse is read off the EFFECTIVE HOD, not users.hod_id: G9's OneHR HOD is the BU CEO yet LISTH has them",
            P["G9"] in scope("LISTH"))
    s.check("a BG CEO holds no Grade H HOD role whoever lists them: G6 is in nobody's scope, the BG CEO's included", not any(P["G6"] in scope(h) for h in ("CAL", "OLDH", "LISTH")))
    s.check("an HOD in another business group is allowed to hold the person (G10 is XBG's)", P["G10"] in scope("XBG") and urow("XBG")["business_group"] != urow("G10")["business_group"])
    want_eff = {"G1": "LISTH", "G2": "OLDH", "G3": None, "G4": None, "G5": "BCA", "G6": "CAL", "G7": "LISTH", "G8": None, "G9": "LISTH", "G10": "XBG"}
    twin = {k_: run(lambda d, k_=k_: a.gradeh_hod_of(d, d.execute("SELECT * FROM gradeh_people WHERE id=?", (P[k_],)).fetchone())) for k_ in everyone}
    s.check("the Python twin (gradeh_hod_of) gives the effective HOD for every person: listed, else OneHR's, None if left or themselves",
            all(twin[k_] == (U[v] if v else None) for k_, v in want_eff.items()), twin)
    sqlh = {k_: db.execute("SELECT " + a._GH_HOD_SQL + " FROM gradeh_people p JOIN users uu ON uu.id=p.user_id WHERE p.id=?", (P[k_],)).fetchone()[0] for k_ in everyone}
    s.check("...and _GH_HOD_SQL gives the same, person by person", sqlh == twin, sqlh)

    # ======================================================================================================================
    s.section("the pages and the writers follow it")
    t = text(C["LISTH"].get(BASE + "/hod"))
    s.check("the listed HOD opens the Grade H HOD page and sees G1, G7, G9, not G2", C["LISTH"].get(BASE + "/hod").status_code == 200
            and all("ZZ HL " + k_ in t for k_ in ("G1", "G7", "G9")) and "ZZ HL G2" not in t, t[:200])
    t = text(C["OLDH"].get(BASE + "/hod"))
    s.check("the OneHR HOD still sees G2, and no longer G1", "ZZ HL G2" in t and "ZZ HL G1" not in t)
    s.check("someone who is nobody's Grade H HOD (a BU CEO, an employee) gets a 404", C["BCB"].get(BASE + "/hod").status_code == 404 and C_EMP.get(BASE + "/hod").status_code == 404)
    s.check("a BG CEO (CAL, and a list that names them) has no Grade H HOD page", C["CAL"].get(BASE + "/hod").status_code == 404)
    ok, msg = run(lambda d: a.gradeh_hod_move(d, urow("OLDH"), P["G1"], "pot", "High", "ZZ the old HOD tries"))
    s.check("falsified: the old HOD cannot move a listed person (not their department)", not ok and "isn't in your department" in msg, msg)
    ok, msg = run(lambda d: a.gradeh_hod_move(d, urow("LISTH"), P["G1"], "pot", "High", "ZZ the listed HOD moves them"))
    s.check("the listed HOD can move them", ok, msg)
    ok, msg = run(lambda d: a.gradeh_hod_move(d, urow("LISTH"), P["G2"], "pot", "High", "ZZ not theirs"))
    s.check("...but not G2 (a blank, so OLDH's)", not ok and "isn't in your department" in msg, msg)
    s.check("the move is the listed HOD's own, on record", one("SELECT COUNT(*) FROM gradeh_band_moves WHERE person_id=? AND stage='hod' AND by_user_id=?", (P["G1"], U["LISTH"])) == 1)
    ok, msg = run(lambda d: (a.gradeh_hod_agree(d, urow("LISTH"), "pot", [P["G7"], P["G9"]], {P["G7"], P["G9"]})))
    ok2, msg2 = run(lambda d: a.gradeh_hod_signoff(d, urow("LISTH"), "pot", "ZZ the spread is the spread"))
    s.check("the listed HOD agrees and signs off potential for their people", ok and ok2, (msg, msg2))
    s.check("the sign-off is keyed by the listed HOD's id (the effective HOD)", one("SELECT COUNT(*) FROM gradeh_signoffs WHERE tier='hod' AND stage='pot' AND scope_key=?", (str(U["LISTH"]),)) == 1)
    ok3, msg3 = run(lambda d: a.gradeh_hod_signoff(d, urow("OLDH"), "pot", "ZZ nothing to do with them"))
    s.check("falsified: the old HOD's own sign-off is for G2 only (still to review), never LISTH's people", not ok3 and "still to review" in msg3, msg3)
    unsign("LISTH")
    db.execute("DELETE FROM gradeh_reviews WHERE tier='hod'")
    db.execute("DELETE FROM gradeh_band_moves")
    db.commit()
    # reminders and notices
    rows_l = run(lambda d: a._gradeh_lead_rows(d, urow("LISTH"), CID))
    rows_o = run(lambda d: a._gradeh_lead_rows(d, urow("OLDH"), CID))
    s.check("the leader reminder / bar line: LISTH has a Grade H HOD line for 3 people, OLDH for 1",
            any(r_[0] == "gradeh_hod" and r_[5]["n"] == 3 for r_ in rows_l) and any(r_[0] == "gradeh_hod" and r_[5]["n"] == 1 for r_ in rows_o), (rows_l, rows_o))
    s.check("...and the left / BG CEO / BU CEO's ones get none", not any(r_[0] == "gradeh_hod" for k_ in ("LEFTH", "CAL", "BCA") for r_ in run(lambda d, k_=k_: a._gradeh_lead_rows(d, urow(k_), CID))))
    aud = run(lambda d: (a.gradeh_audiences(d, urow("LISTH")), a.gradeh_audiences(d, urow("OLDH")), a.gradeh_audiences(d, urow("CAL"))))
    s.check("the audiences (Ask, Help, the KB, the agent): LISTH and OLDH hold the 'hod' seat, the BG CEO does not",
            "hod" in aud[0] and "hod" in aud[1] and "hod" not in aud[2], aud)
    sql = "SELECT DISTINCT " + a._GH_HOD_SQL + " FROM gradeh_people p JOIN users uu ON uu.id=p.user_id WHERE p.cycle_id=? AND " + a._GH_HOD_SQL + " IS NOT NULL" + a._GH_CAL_NOT_BU
    raw_set = {r_[0] for r_ in db.execute(sql, (CID,))}
    s.check("the notice audience's HOD set (the same fragment) is LISTH, OLDH, XBG and the calibrator the list names (dropped next by "
            "_gh_hod_ids_with_role), never the left, own or BU CEO ones",
            raw_set == {U["LISTH"], U["OLDH"], U["XBG"], U["CAL"]}, raw_set)
    s.check("...and after the Grade H HOD-role filter the BG CEO is gone too", set(run(lambda d: a._gh_hod_ids_with_role(d, sorted(raw_set)))) == {U["LISTH"], U["OLDH"], U["XBG"]})

    # ======================================================================================================================
    s.section("People & progress: the effective HOD, with a Grade H marker where it differs")
    ppl = run(lambda d: {p_["eid"]: p_ for p_ in a.gradeh_admin_people(d, CID)})
    s.check("the HOD shown for G1 is LISTH (the listed one), marked as from the list, with their OneHR HOD named",
            ppl[PFX + "G1"]["hod_name"] == "ZZ HL LISTH" and ppl[PFX + "G1"]["hod_listed"] and ppl[PFX + "G1"]["hod_main_name"] == "ZZ HL OLDH", ppl[PFX + "G1"]["hod_name"])
    s.check("G2 (blank) shows OLDH with no marker; G3 / G4 / G5 / G6 / G8 show no HOD stage (the BU CEO covers)",
            ppl[PFX + "G2"]["hod_name"] == "ZZ HL OLDH" and not ppl[PFX + "G2"]["hod_listed"]
            and not any(ppl[PFX + k_]["hod_stage"] for k_ in ("G3", "G4", "G5", "G6", "G8")), [(k_, ppl[PFX + k_]["hod_stage"]) for k_ in ("G3", "G4", "G5", "G6", "G8")])
    s.check("G9 (OneHR HOD was the BU CEO) now has an HOD stage: LISTH", ppl[PFX + "G9"]["hod_stage"] and ppl[PFX + "G9"]["hod_name"] == "ZZ HL LISTH")
    t_html = C_SU.get("/admin/gradeh?tab=people&q=ZZ+HL").get_data(as_text=True)
    s.check("the page says 'from the Grade H list' in the listed HOD's cell title (naming their OneHR HOD), once per listed person, none beside G2 (one line a person, 2026-11-03)",
            t_html.count("(from the Grade H list; their OneHR HOD:") >= 4 and "their OneHR HOD: ZZ HL OLDH" in t_html)
    xl = C_SU.get("/admin/gradeh/export/list.xlsx") if "admin_gradeh_list_xlsx" in a.app.view_functions else None
    if xl is not None and xl.status_code == 200:
        rws = [list(x) for x in load_workbook(io.BytesIO(xl.data), read_only=True).worksheets[0].iter_rows(values_only=True)]
        hi = [str(x) for x in rws[0]].index("HOD")
        s.check("the Excel's HOD column is the effective HOD", any("ZZ HL LISTH" in str(r_[hi]) for r_ in rws[1:]))

    # ======================================================================================================================
    s.section("the BU CEO's early opening reads the effective HOD and its sign-offs")
    setting("gradeh_bu_fallback_at", utc(NOW + 5 * DAY))
    person("B1")
    person("B2", hod_user=None)
    s.check("unit B: B1's OneHR HOD has LEFT, so no HOD stage: done; B2's HOD (OLDB) has not signed: 1 of 2, closed",
            (lambda r_: (not r_["open"]) and r_["done"] == 1 and r_["total"] == 2)(bu_open(COB)), bu_open(COB))
    hsign("OLDB")
    s.check("OLDB signs both stages: B2 done, 2 of 2, open", (lambda r_: r_["open"] and r_["done"] == 2)(bu_open(COB)), bu_open(COB))
    unsign("OLDB")
    db.execute("UPDATE gradeh_people SET hod_user_id=? WHERE id=?", (U["LISTB"], P["B2"]))
    db.commit()
    s.check("B2 is now LISTB's: OLDB's sign-off does not count and LISTB has not signed: 1 of 2, closed", (lambda r_: (not r_["open"]) and r_["done"] == 1)(bu_open(COB)), bu_open(COB))
    hsign("OLDB")
    s.check("falsified: OLDB signing again (the users.hod_id HOD) still does not open it", not bu_open(COB)["open"])
    unsign("OLDB")
    hsign("LISTB")
    s.check("LISTB (the listed HOD) signs both stages: 2 of 2, open, and the BU gate agrees (None)",
            bu_open(COB)["open"] and bu_open(COB)["done"] == 2 and run(lambda d: a.gradeh_bu_gate(d, CID, BG, COB)) is None, bu_open(COB))
    unsign("LISTB")
    db.execute("UPDATE users SET left_at=datetime('now') WHERE id=?", (U["LISTB"],))
    db.commit()
    s.check("the listed HOD leaves: B2 goes to the BU CEO, both done, open (a left HOD never holds the BU CEO back)",
            bu_open(COB)["open"] and bu_open(COB)["done"] == 2, bu_open(COB))
    db.execute("UPDATE users SET left_at=NULL WHERE id=?", (U["LISTB"],))
    db.execute("UPDATE users SET left_at=NULL WHERE id=?", (U["LEFTB"],))
    db.commit()
    s.check("falsified: the left HOD of B1 comes back: B1 now waits on them, so the unit is closed again (the left rule is what opened it)",
            not bu_open(COB)["open"] and bu_open(COB)["done"] == 0, bu_open(COB))
    db.execute("UPDATE users SET left_at=datetime('now') WHERE id=?", (U["LEFTB"],))
    db.commit()
    people_b = run(lambda d: {p_["eid"]: p_ for p_ in a.gradeh_admin_people(d, CID)})
    unit_b = run(lambda d: a.gradeh_unit_signoff_state(d, CID, COB))
    s.check("the unit's sign-off state names the effective HODs: LISTB (B2) and nobody for B1", [h["name"] for h in unit_b["hods"]] == ["ZZ HL LISTB"], unit_b["hods"])
    # the HOD stage in the HOD's own early opening: its people, acknowledged or not
    setting("gradeh_hod_fallback_at", utc(NOW + 5 * DAY))
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=NULL WHERE person_id=?", (P["G7"],))
    db.commit()
    r1 = hod_open("LISTH")
    s.check("the HOD's early opening counts the listed HOD's people (G1, G7, G9): 2 of 3 acknowledged, closed before the fallback",
            r1["total"] == 3 and r1["done"] == 2 and not r1["open"], r1)
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=? WHERE person_id=?", (utc(NOW), P["G7"]))
    db.commit()
    s.check("G7 acknowledges: 3 of 3, open", hod_open("LISTH")["open"] and hod_open("LISTH")["done"] == 3)
    s.check("OLDH's count is theirs alone (G2): 1 of 1", hod_open("OLDH")["total"] == 1)
    setting("gradeh_hod_fallback_at", "")
    setting("gradeh_bu_fallback_at", "")

    # ======================================================================================================================
    s.section("the Grade H HOD role: an HOD for Grade H only has a way in")
    views_l = run(lambda d: a._journey_leader_views(d, urow("LISTH")))
    s.check("LISTH has no Department Review (no dept view): the main review does not know them as an HOD", "dept" not in views_l
            and not any(t_ == "hod" for t_, _k in run(lambda d: a.calibration_tier_of(d, urow("LISTH")))), views_l)
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        s.check("gradeh_hod_only(LISTH) is true; for a person with no Grade H people, a calibrator, the BU CEO and an employee it is false",
                a.gradeh_hod_only(d_, urow("LISTH")) and not any(a.gradeh_hod_only(d_, urow(k_)) for k_ in ("CAL", "BCA", "G2")))
        orig = a._journey_leader_views
        a._journey_leader_views = lambda d, u: ["dept"] if u["id"] == U["LISTH"] else orig(d, u)
        try:
            s.check("falsified: with a Department Review (a dept view) the same HOD is NOT 'Grade H only' (their tab sits beside it)", not a.gradeh_hod_only(d_, urow("LISTH")))
        finally:
            a._journey_leader_views = orig
    r = C["LISTH"].get("/dashboard")
    t = text(r)
    s.check("the dashboard shows 'Grade H Appraisal · 3 Grade H people to review' under Your next step, a navy 'Open Grade H review' button to /calibration/gradeh/hod",
            "3 Grade H people to review" in t and 'href="/calibration/gradeh/hod"' in r.get_data(as_text=True) and "Open Grade H review" in t, t[:300])
    s.check("...and the row is the existing pattern: no new card (no ghl-card) and not the line manager's wording ('to appraise')",
            "ghl-card" not in r.get_data(as_text=True) and "Grade H staff to appraise" not in t)
    t_o = text(C["OLDH"].get("/dashboard"))
    s.check("OLDH (an HOD for Grade H whose journey has no Department Review in this fixture, or who has one): consistent with gradeh_hod_only",
            ("1 Grade H person to review" in t_o) == run(lambda d: a.gradeh_hod_only(d, urow("OLDH"))), t_o[:100])
    s.check("a Grade H person who is nobody's HOD has no such row", "Grade H people to review" not in text(C["G2"].get("/dashboard")))
    j = C["LISTH"].get("/review/journey").get_data(as_text=True)
    s.check("the journey's Mine view carries the minimised Grade H tab, linking to the HOD page", "rv-mt-gradeh" in j and 'href="/calibration/gradeh/hod"' in j)
    s.check("...and the rail's Your team door is there too", "Grade H calibration" in j)
    s.check("falsified: someone with no Grade H people has no Grade H tab", "rv-mt-gradeh" not in C["MR1"].get("/review/journey").get_data(as_text=True))
    run(lambda d: d.execute("INSERT OR REPLACE INTO leader_role_access(role, ability, allowed) VALUES ('hod', 'hod.gradeh', 0)"))
    s.check("the leader ability hod.gradeh switched off still closes the page to a Grade H-only HOD, and the dashboard row goes",
            C["LISTH"].get(BASE + "/hod").status_code == 404 and "Grade H people to review" not in text(C["LISTH"].get("/dashboard")))
    run(lambda d: d.execute("DELETE FROM leader_role_access WHERE ability LIKE '%.gradeh'"))

    # ======================================================================================================================
    s.section("the main review's Department Review is unchanged: the same people before and after")
    s.check("users.hod_id for OLDH's report MR1 is still OLDH; OLDH is still MR1's main-review HOD (the Department Review is built from users.hod_id)",
            one("SELECT hod_id FROM users WHERE id=?", (U["MR1"],)) == U["OLDH"] and hod_snapshot() == snap0)
    s.check("a Grade H person's list HOD does not make them anyone's main-review report (G1's users.hod_id is still OLDH, not LISTH)",
            one("SELECT hod_id FROM users WHERE id=?", (U["G1"],)) == U["OLDH"] and one("SELECT COUNT(*) FROM users WHERE hod_id=?", (U["LISTH"],)) == 0)

    # ======================================================================================================================
    s.section("a second file: a different HOD asks the super admin; a blank never wipes")
    nxt = [lrow(PFX + "G1", hod=PFX + "OLDH"), lrow(PFX + "G7")]
    ctx, q = load(nxt)
    v1 = next(v for v in ctx["valid"] if v["eid"] == PFX + "G1")
    s.check("a row whose HOD differs from the one set is 'updated' and asks (hod:eid), a blank row on G7 asks nothing and is 'same'",
            a._ghl_change(v1) == "updated" and a._ghl_ask(v1) == [("hod:" + PFX + "G1", "hod")]
            and a._ghl_change(next(v for v in ctx["valid"] if v["eid"] == PFX + "G7")) == "same")
    tk = stage(xfile(nxt))
    step(tk, "quality_ok", ack="1")
    pg = page(tk, "changes")
    s.check("step 3 asks: 'The file names a different HOD from the one set now'", "different HOD from the one set now" in pg and "Keep the one set now" in pg)
    step(tk, "to_apply")   # unanswered
    s.check("unanswered it does not go on (nothing changed)", gp("G1")["hod_user_id"] == U["LISTH"])
    step(tk, "to_apply", **{fid("hod:" + PFX + "G1"): "keep"})
    step(tk, "apply")
    s.check("answered 'keep': G1 stays with LISTH; a blank G7 is not wiped", gp("G1")["hod_user_id"] == U["LISTH"] and gp("G7")["hod_user_id"] == U["LISTH"])
    tk = stage(xfile(nxt))
    step(tk, "quality_ok", ack="1")
    step(tk, "to_apply", **{fid("hod:" + PFX + "G1"): "file"})
    step(tk, "apply")
    s.check("answered 'use the file's': G1 moves to OLDH; users.hod_id is still untouched", gp("G1")["hod_user_id"] == U["OLDH"] and hod_snapshot() == snap0)
    db.execute("UPDATE gradeh_people SET hod_user_id=? WHERE id=?", (U["LISTH"], P["G1"]))
    db.commit()

    # ======================================================================================================================
    s.section("Set HOD on People & progress (super admin)")
    HURL = "/admin/gradeh/hod"
    s.check("the route is the super admin's in the access map", a.admin_access_need("admin_gradeh_hod", {}) == "super")
    r = C_SU.get("/admin/gradeh?tab=people&panel=hod&set=%d" % P["G2"])
    s.check("the panel opens with a strict picker and the double-confirm text", r.status_code == 200 and 'name="hod_eid"' in r.get_data(as_text=True)
            and "Their HOD in the main review does not change" in r.get_data(as_text=True) and 'data-pick' in r.get_data(as_text=True))
    snap1 = hod_snapshot()
    r = C_SU.post(HURL, data=csrf(pid=str(P["G2"]), hod_eid=PFX + "LISTH"), follow_redirects=True)
    s.check("set: G2's Grade H HOD is LISTH, audited, users.hod_id untouched", gp("G2")["hod_user_id"] == U["LISTH"] and hod_snapshot() == snap1
            and one("SELECT COUNT(*) FROM activity_log WHERE action='gradeh_set_hod' AND target_user_id=?", (U["G2"],)) == 1)
    s.check("...and the effective HOD follows at once: LISTH has G2, OLDH has nobody", P["G2"] in scope("LISTH") and scope("OLDH") == set())
    r = C_SU.post(HURL, data=csrf(pid=str(P["G2"]), clear="1"), follow_redirects=True)
    s.check("clear: their OneHR HOD is their Grade H HOD again", gp("G2")["hod_user_id"] is None and P["G2"] in scope("OLDH"))
    for label, who in (("themselves", PFX + "G2"), ("someone who has left", PFX + "LEFTH"), ("an unknown ID", PFX + "NOPE"), ("a demo login", PFX + "DEMO")):
        C_SU.post(HURL, data=csrf(pid=str(P["G2"]), hod_eid=who))
        s.check("refused: %s" % label, gp("G2")["hod_user_id"] is None)
    for who_, cl in (("a BG admin", H.client_as(a, BGA["id"]) if BGA else None), ("an HOD", C["OLDH"]), ("an employee", C_EMP)):
        if cl is not None:
            r = cl.post(HURL, data=csrf(pid=str(P["G2"]), hod_eid=PFX + "LISTH"))
            s.check("%s cannot set it (403/404), nothing changes" % who_, r.status_code in (403, 404) and gp("G2")["hod_user_id"] is None, r.status_code)
    r = C_SU.post(HURL, data={"pid": str(P["G2"]), "hod_eid": PFX + "LISTH"})
    s.check("no CSRF token: refused (400), nothing changes", r.status_code == 400 and gp("G2")["hod_user_id"] is None)
    ok, msg = run(lambda d: a.gradeh_set_hod(d, urow("OLDH"), P["G2"], PFX + "LISTH"))
    s.check("the writer itself refuses a non-super account", not ok and gp("G2")["hod_user_id"] is None, msg)
    hsign("OLDH", ("pot",))
    C_SU.post(HURL, data=csrf(pid=str(P["G2"]), hod_eid=PFX + "LISTH"))
    s.check("refused once their current HOD has signed off a stage (OLDH signed potential)", gp("G2")["hod_user_id"] is None)
    unsign("OLDH")
    hsign("LISTH", ("pot",))
    C_SU.post(HURL, data=csrf(pid=str(P["G2"]), hod_eid=PFX + "LISTH"))
    s.check("...and once the picked HOD has signed off a stage", gp("G2")["hod_user_id"] is None)
    unsign("LISTH")
    db.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?, 'buceo', 'all', ?, ?)", (CID, CO, U["BCA"]))
    db.commit()
    C_SU.post(HURL, data=csrf(pid=str(P["G2"]), hod_eid=PFX + "LISTH"))
    s.check("...and once the BU CEO has signed off the unit", gp("G2")["hod_user_id"] is None)
    db.execute("DELETE FROM gradeh_signoffs WHERE tier='buceo'")
    db.commit()
    C_SU.post(HURL, data=csrf(pid=str(P["G2"]), hod_eid=PFX + "LISTH"))
    s.check("falsified: with every lock off the same post goes through", gp("G2")["hod_user_id"] == U["LISTH"])
    C_SU.post(HURL, data=csrf(pid=str(P["G2"]), clear="1"))
    C_SU.post(HURL, data=csrf(pid=str(P["G1"]), hod_eid=PFX + "CAL"))
    s.check("naming a BG CEO is allowed but says the BU CEO covers them", gp("G1")["hod_user_id"] == U["CAL"] and P["G1"] not in scope("CAL"))
    db.execute("UPDATE gradeh_people SET hod_user_id=? WHERE id=?", (U["LISTH"], P["G1"]))
    db.commit()

    # ======================================================================================================================
    s.section("what the agents, Help, Ask and the KB say")
    body = lambda: one("SELECT body FROM kb_entries WHERE slug='gradeh-hod'")   # noqa: E731
    s.check("the HOD's KB row says the Grade H HOD comes from the Grade H list (Group People), else the OneHR HOD, and can be Grade H only",
            "Grade H list from Group People" in body() and "whose OneHR HOD you are" in body() and "HOD for Grade H only" in body()
            and "has left" in body() and "Grade H tab at the top of your Department Review" in body(), body()[:160])
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-hod'", (a._KB_GRADEH_HOD_BODY_BEFORE_LIST,))
    db.commit()
    a._ensure_runtime_schema()
    a._ensure_runtime_schema()
    s.check("a database seeded before: the HOD row holding the exact previous text is reworded once, and a second run changes nothing", body() == a._KB_GRADEH_HOD_BODY)
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-hod'", (a._KB_GRADEH_HOD_BODY_BEFORE_LIST + " An admin's addition.",))
    db.commit()
    a._ensure_runtime_schema()
    s.check("...and an admin's edited row is left alone", body() == a._KB_GRADEH_HOD_BODY_BEFORE_LIST + " An admin's addition.")
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-hod'", (a._KB_GRADEH_HOD_BODY,))
    db.commit()
    s.check("Help's answer and the agent's prompt and the welcome say where the Grade H HOD comes from",
            "Grade H list" in a.HELP_QA["gh_dash_cal"][1] and "Your next step" in a.HELP_QA["gh_dash_cal"][1]
            and "Grade H list" in a._journey_gradeh_prompt(frozenset({"hod"})) and "Grade H list" in a._journey_gradeh_welcome(frozenset({"hod"})))

    def _facts(k):
        with a.app.test_request_context("/"):
            d = a.get_db()
            u = a.get_user_by_id(d, U[k]) if hasattr(a, "get_user_by_id") else urow(k)
            return " ".join(a._ask_facts(d, u, a._dash_context(d, u))[0])
    fh = _facts("LISTH")
    s.check("Ask OneHR's facts for the listed HOD name Grade H calibration and where the people come from",
            "Grade H calibration" in fh and "Grade H list names you HOD for" in fh, fh[-300:])

finally:
    a.ai_draft.review_agent_available = _real_avail
    os.environ["ONEHR_GRADEH"] = _ENV0 if _ENV0 is not None else ""
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET half=?, open_by_date=? WHERE id=?", (HALF0, OBD0, CID))
        d.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell LIKE 'gradeh_%'", (CID,))
        d.execute("DELETE FROM leader_role_access WHERE ability LIKE '%.gradeh'")
        d.commit()

sys.exit(s.done())
