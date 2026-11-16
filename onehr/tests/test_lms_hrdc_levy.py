"""AI+ Learning: the HRDC levy balance by entity (2026-10-24, LMS canvas section 21, boards 21A-21B). Chris: "we also
should add in the HRDC balance for each entities/BU for L&D admin"; his picks: L&D types each balance or uploads them,
OneHR counts approved, filed and planned, L&D and the super admin change it while a BG or BU admin reads their own,
short in red and under 20% amber.

What this suite holds:
  * what this year's learning takes, by the person's entity: each HRDC-claimable place (confirmed, not absent) at its
    cost, approved / filed (or query) / planned by its business group's filing; a rejected filing, a cancelled run, an
    absence and next year's run don't count; an external course by its own HRDC record
  * L&D enters a balance with its date (a number, today or before, an entity of theirs), every entry kept, the latest
    used; a BG admin can't; logged
  * the board: what's left after all, short first, then under 20%, then none; entities with nothing fold away; a BG
    admin reads their own group's entities only
  * the upload: the template's columns, every row checked first, one wrong row and nothing is saved, a blank balance
    skipped; the template lists every entity with its balance
  * the page, and L&D's today list naming a short entity
Everything here is synthetic (ZZLV / ZZ9LV-) and removed at the end.
"""
import html
import io
import os
import sys
from datetime import timedelta


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: the HRDC levy balance by entity")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG, OBG = "ZZLV Group", "ZZLV Other"
U1, U2, U3, O1 = "ZZLV U1", "ZZLV U2", "ZZLV U3", "ZZLV O1"
_ENV0 = os.environ.get("ONEHR_LMS")
TODAY = a._today_myt()
YEAR_END = TODAY.replace(month=12, day=31)


def D(n):
    return (TODAY + timedelta(days=n)).isoformat()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LV-%' OR username LIKE 'zzlv-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLV %'")
    db.execute("DELETE FROM lms_hrdc_levy WHERE business_group IN (?, ?)", (BG, OBG))
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM lms_registrations WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM org_units WHERE business_group IN (?, ?)", (BG, OBG))
    db.commit()


def person(db, eid, bg, co):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?, '15', '2020-01-01')",
                      (eid.lower(), "ZZ LV " + eid.split("-")[1], eid, bg, co)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    for bg, co in ((BG, U1), (BG, U2), (BG, U3), (OBG, O1)):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (bg, co))
    # U3 has a preferred name on Org structure: an upload may name it so, as the page and the template do
    db.execute("UPDATE org_units SET preferred_name='ZZLV Third Entity Sdn Bhd' WHERE business_group=? AND company=?",
               (BG, U3))
    E1, E2 = person(db, "ZZ9LV-E1", BG, U1), person(db, "ZZ9LV-E2", BG, U1)
    E3 = person(db, "ZZ9LV-E3", BG, U2)
    E4 = person(db, "ZZ9LV-E4", OBG, O1)
    LND = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzlv-lnd', 'ZZ LV L&D', 'x', 'admin', ?)", (a.LMS_ADMIN_BG,)).lastrowid
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, admin_bg) VALUES "
                     "('zzlv-bga', 'ZZ LV BG admin', 'x', 'admin', ?)", (BG,)).lastrowid
    P = db.execute("INSERT INTO lms_programmes(title, kind, status, hours, days, cost_per_pax, hrdc_claimable) VALUES "
                   "('ZZLV Negotiation', 'inhouse', 'published', 7, 1, 1600, 1)").lastrowid

    def sess(day, status="planned"):
        return db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, seats, status) VALUES "
                          "(?, 'ZZLV run', ?, ?, 20, ?)", (P, day, day, status)).lastrowid
    same_year = min(YEAR_END, TODAY + timedelta(days=20)).isoformat()
    S1, S2, S3, S4 = (sess(same_year) for _ in range(4))
    S5 = sess(same_year, "cancelled")
    S6 = sess((YEAR_END + timedelta(days=40)).isoformat())

    def reg(uid, sid, outcome=None, cost=1600):
        return db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, cost, "
                          "hrdc_claimable, outcome) VALUES (?,?,?, 'approved', '[]', ?, 1, ?)",
                          (uid, sid, P, cost, outcome)).lastrowid
    reg(E1, S1), reg(E2, S1), reg(E4, S1)
    reg(E1, S2)
    reg(E3, S3), reg(E1, S3, outcome="absent")
    reg(E2, S4)
    reg(E3, S5)
    reg(E1, S6)
    db.execute("INSERT INTO lms_registrations(user_id, programme_id, ext_title, ext_starts_on, ext_ends_on, status, "
               "chain_json, cost, hrdc_claimable) VALUES (?, NULL, 'ZZLV External', ?, ?, 'approved', '[]', 1000, 1)",
               (E3, same_year, same_year))
    for sid, st in ((S1, "approved"), (S2, "filed"), (S4, "rejected")):
        db.execute("INSERT INTO lms_hrdc(session_id, business_group, status) VALUES (?,?,?)", (sid, BG, st))
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def u_(uid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def call(fn, *args, **kw):
    with a.app.test_request_context():
        return fn(a.get_db(), *args, **kw)


def body(r):
    return html.unescape(r.get_data(as_text=True))


def xlsx(rows, head=None):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.append(list(head or a.LMS_LEVY_COLUMNS))
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def names(*pairs):
    with a.app.test_request_context():
        return [a.display_bg(p[0]) if len(p) == 1 else a.display_company(*p) for p in pairs]


def board(uid):
    return call(a.lms_levy_board, u_(uid))


try:
    os.environ["ONEHR_LMS"] = "1"
    CL, CB = H.client_as(a, LND), H.client_as(a, BGA)

    s.section("what this year's learning takes")
    uses = call(a.lms_levy_uses, TODAY.year)
    u1, u2, o1 = uses.get((BG, U1)), uses.get((BG, U2)), uses.get((OBG, O1))
    s.check("an approved filing's places: approved, at their cost", u1 and u1["approved"] == 3200, u1)
    s.check("...a filed one: filed", u1["filed"] == 1600)
    s.check("...not filed: planned; an external course with no HRDC record too", u2 and u2["planned"] == 2600, u2)
    s.check("...another group's people under their own filing (none yet: planned)", o1 and o1["planned"] == 1600 and
            o1["approved"] == 0, o1)
    s.check("a rejected filing, a cancelled run, an absence and next year's run don't count",
            u1["planned"] == 0 and sum(v["n"] for v in u1["items"].values()) == 3)

    s.section("entering a balance")
    def save(c, co, bal, at, bg=BG, note=""):
        return c.post("/admin/learning/hrdc", data={"csrf_token": "tok", "action": "levy", "bg": bg, "company": co,
                                                    "balance": bal, "as_of": at, "note": note})
    save(CB, U1, "5000", D(-5))
    s.check("a BG admin can't enter one", one("SELECT COUNT(*) FROM lms_hrdc_levy WHERE company=?", (U1,)) == 0)
    save(CL, U1, "five thousand", D(-5))
    s.check("it must be a number", one("SELECT COUNT(*) FROM lms_hrdc_levy WHERE company=?", (U1,)) == 0)
    save(CL, U1, "5000", D(3))
    s.check("...as at today or before", one("SELECT COUNT(*) FROM lms_hrdc_levy WHERE company=?", (U1,)) == 0)
    save(CL, "ZZLV Nowhere", "5000", D(-5))
    s.check("...for an entity on the list", one("SELECT COUNT(*) FROM lms_hrdc_levy WHERE company='ZZLV Nowhere'") == 0)
    s.check("...nor by the function itself", call(a.lms_levy_set, u_(BGA), BG, U1, "5000", D(-5))[0] is False
            and one("SELECT COUNT(*) FROM lms_hrdc_levy WHERE company=?", (U1,)) == 0)
    save(CL, U1, "5,000", D(-5), note="ZZLV eTRiS statement")
    save(CL, U1, "RM 4,000.00", D(-40))
    s.check("L&D enters one, every entry kept", one("SELECT COUNT(*) FROM lms_hrdc_levy WHERE company=?", (U1,)) == 2)
    s.check("...the latest as-at date used, though an older statement was entered after it",
            call(a.lms_levy_latest)[(BG, U1)]["balance"] == 5000)
    s.check("...logged", one("SELECT COUNT(*) FROM activity_log WHERE action='lms_hrdc_levy' AND user_id=?",
                             (LND,)) == 2 and "lms_hrdc_levy" in a.ACTION_LABELS)
    save(CL, U2, "2000", D(-30))

    s.section("the board")
    b = board(LND)
    rows = {(r["bg"], r["company"]): r for r in b["rows"]}
    s.check("U1: left after all, under 20%: amber", rows[(BG, U1)]["left"] == 200 and rows[(BG, U1)]["state"] == "low"
            and rows[(BG, U1)]["pct"] == 4, rows[(BG, U1)])
    s.check("U2: short, red", rows[(BG, U2)]["left"] == -600 and rows[(BG, U2)]["state"] == "short")
    s.check("O1: learning and no balance yet", rows[(OBG, O1)]["state"] == "none")
    order = [(r["bg"], r["company"]) for r in b["rows"] if r["bg"] in (BG, OBG)]
    s.check("short first, then under 20%, then none", order == [(BG, U2), (BG, U1), (OBG, O1)], order)
    s.check("an entity with no balance and no learning folds away", (BG, U3) in [(r["bg"], r["company"])
                                                                                 for r in b["quiet"]])
    bb = board(BGA)
    mine = {(r["bg"], r["company"]) for r in bb["rows"] + bb["quiet"]}
    s.check("a BG admin reads their own group's entities only", (BG, U1) in mine and (OBG, O1) not in mine)
    save(CL, U1, "9000", D(-1))
    s.check("a newer balance moves it to ok", board(LND)["rows"] and {(r["bg"], r["company"]): r for r in
                                                                      board(LND)["rows"]}[(BG, U1)]["state"] == "ok")
    with a.app.app_context():
        a.get_db().execute("UPDATE lms_hrdc_levy SET as_of=? WHERE company=?", (D(-40), U1))
        a.get_db().commit()
    s.check("...older than 21 days (the latest entry on the latest date), it asks to be updated", {(r["bg"], r["company"]): r for r in
                                                             board(LND)["rows"]}[(BG, U1)]["state"] == "stale")

    s.section("the upload and the template")
    def up(c, data, name="levy.xlsx"):   # all four steps: a post without them changes nothing (1a-01)
        return H.import_steps(c, "/admin/learning/hrdc", {"action": "levy_upload", "file": (io.BytesIO(data), name)})
    n0 = one("SELECT COUNT(*) FROM lms_hrdc_levy WHERE business_group IN (?,?)", (BG, OBG))
    up(CL, b"not a spreadsheet", "levy.csv")
    s.check("a file that isn't the Excel template: refused", one(
        "SELECT COUNT(*) FROM lms_hrdc_levy WHERE business_group IN (?,?)", (BG, OBG)) == n0)
    up(CL, xlsx([[BG, U3, 3000, D(-1)]], head=["Group", "Unit", "Balance", "Date"]))
    s.check("...nor other columns", one("SELECT COUNT(*) FROM lms_hrdc_levy WHERE business_group IN (?,?)",
                                        (BG, OBG)) == n0)
    up(CL, xlsx([[BG, U3, 3000, D(-1)], [BG, "ZZLV Nowhere", 100, D(-1)]]))
    s.check("one wrong row: nothing saved", one("SELECT COUNT(*) FROM lms_hrdc_levy WHERE business_group IN (?,?)",
                                                (BG, OBG)) == n0)
    up(CB, xlsx([[BG, U3, 3000, D(-1)]]))
    s.check("a BG admin can't upload", one("SELECT COUNT(*) FROM lms_hrdc_levy WHERE company=?", (U3,)) == 0)
    nBG, nU3, nU2, nO1 = names((BG,), (BG, U3), (BG, U2), (OBG, O1))
    up(CL, xlsx([[nBG, nU3, 3000, D(-1), "ZZLV upload"], [OBG, O1, 8000, D(-2)],
                 [BG, U2, None, None]]))
    s.check("L&D's file: every good row saved (one by its preferred name), a blank balance skipped",
            nU3 == "ZZLV Third Entity Sdn Bhd" and one(
        "SELECT balance FROM lms_hrdc_levy WHERE company=?", (U3,)) == 3000 and one(
        "SELECT balance FROM lms_hrdc_levy WHERE company=?", (O1,)) == 8000 and one(
        "SELECT COUNT(*) FROM lms_hrdc_levy WHERE company=?", (U2,)) == 1)
    n1 = one("SELECT COUNT(*) FROM lms_hrdc_levy")
    r = CL.post("/admin/learning/hrdc", data={"csrf_token": "tok", "action": "levy_upload", "file": (
        io.BytesIO(xlsx([[BG, U3, 7777, D(-1)]])), "levy.xlsx")}, content_type="multipart/form-data",
        follow_redirects=True)
    s.check("a file posted without the steps (no preview, no token) is refused and saves nothing, L&D or not",
            one("SELECT COUNT(*) FROM lms_hrdc_levy") == n1 and "Nothing was imported" in body(r)
            and one("SELECT COUNT(*) FROM lms_hrdc_levy WHERE balance=7777") == 0)
    r = CB.post("/admin/learning/hrdc", data={"csrf_token": "tok", "action": "levy_upload", "file": (
        io.BytesIO(xlsx([[BG, U3, 7777, D(-1)]])), "levy.xlsx")}, content_type="multipart/form-data")
    s.check("...a BG admin's too", one("SELECT COUNT(*) FROM lms_hrdc_levy") == n1)
    r = CL.get("/admin/learning/hrdc?view=levy&template=1")
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(r.data), read_only=True)
    trows = list(wb.worksheets[0].iter_rows(values_only=True))
    s.check("the template: the columns, every entity with its balance", r.status_code == 200 and
            list(trows[0])[:5] == list(a.LMS_LEVY_COLUMNS) and any(
                t[1] == nU3 and t[2] == 3000 for t in trows[1:]))
    import re as _re
    r = CL.post("/admin/learning/hrdc", data={"csrf_token": "tok", "action": "levy_upload", "preview": "1", "file": (
        io.BytesIO(xlsx([[BG, U3, 3100, D(-1)]])), "levy.xlsx")}, content_type="multipart/form-data")
    loc = r.headers.get("Location", "")
    ltok = (_re.search(r"check=([0-9a-f]{32})", loc) or [None, ""])[1]
    pg = CL.get(loc).get_data(as_text=True) if ltok else ""
    s.check("Check the file (the four steps, 2026-10-26): kept, its quality step on the levy view, nothing saved yet",
            "view=levy" in loc and "2 · Quality" in pg and one("SELECT balance FROM lms_hrdc_levy WHERE company=? ORDER BY "
                                                              "id DESC LIMIT 1", (U3,)) == 3000, loc)
    CL.post("/admin/learning/hrdc", data={"csrf_token": "tok", "token": ltok, "action": "quality_ok"})
    pg = CL.get("/admin/learning/hrdc?view=levy&check=%s&step=changes" % ltok).get_data(as_text=True)
    s.check("...what it saves: each entity's balance now and the file's", "Each entity&#39;s balance" in pg
            and "RM 3,000.00" in pg and "RM 3,100.00" in pg)
    CL.post("/admin/learning/hrdc", data={"csrf_token": "tok", "token": ltok, "action": "to_apply"})
    CL.post("/admin/learning/hrdc", data={"csrf_token": "tok", "token": ltok, "action": "apply"})
    s.check("...then Apply saves it as a new entry", one("SELECT balance FROM lms_hrdc_levy WHERE company=? ORDER BY id "
                                                          "DESC LIMIT 1", (U3,)) == 3100)

    s.section("the page")
    pg = body(CL.get("/admin/learning/hrdc?view=levy"))
    s.check("Levy balance by entity: tiles, rows, the short one in red", "Levy balance by entity" in pg and
            "Short RM 600" in pg and nU2 in pg and "Upload balances…" in pg)
    s.check("...each entity's panel: the balance form, what takes from it, the entries", "Save the balance…" in pg and
            "What takes from it this year" in pg and "ZZLV eTRiS statement" in pg)
    pgb = body(CB.get("/admin/learning/hrdc?view=levy"))
    s.check("a BG admin reads it, with no form", "Levy balance by entity" in pgb and "Save the balance…" not in pgb and
            nO1 not in pgb)
    s.check("the filings page switches to it", "Levy balance by entity" in body(CL.get("/admin/learning/hrdc")))
    with a.app.test_request_context():
        today_ = a.lms_ld_today(a.get_db(), u_(LND))
    s.check("L&D's today list names a short entity", any(x["text"] == "HRDC levy short: %s" % nU2
                                                         for x in today_))
    with a.app.test_request_context():
        lv = a._lms_ld_tool(a.get_db(), u_(LND), {"tool": "levy"})
        prompt = a._lms_ld_system(a.get_db(), u_(LND))
    ent = {e["entity"]: e for e in lv["feed"]["entities"]}
    s.check("the L&D agent reads it: levy{} gives each entity, left and its state, as a table",
            "levy{}" in prompt and ent.get(nU2, {}).get("state") == "Short" and ent[nU2]["left_after_all"] == "RM -600"
            and lv["card"]["kind"] == "table", ent.get(nU2))
    s.check("the schema text is the same in both", a._LMS_DDL.strip() in a.SCHEMA)
finally:
    if _ENV0 is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = _ENV0
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
