"""Admin round 4 (Chris, 2026-10-13: "alright, go ahead and build them" -- the "OneHR Admin Round 4" canvas).

Row 1, progress that counts everyone:
  * every module's state counts everyone taking part, Not started included (the Progress pages used to say "everyone
    in scope is complete" when nobody had started), each person at one stage
  * Progress: a status chip per stage, the line manager on each row, a download of exactly the list on screen
  * the Career Plan has a Run tab with the same Progress page
  * readiness steps are N of M against the people taking part; a step only others can move waits on them and is never
    on the admin's to-do
  * Calibration & Talent > Run > Lock status: every HOD / BU CEO / Talent Box scope, open or locked

Shares the suite database and puts back everything it changes.
"""
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Admin round 4 -- progress that counts everyone, Lock status")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"

SU, BGA, EMP = H.actors(a)
C_SU, C_BG = H.client_as(a, SU["id"]), H.client_as(a, BGA["id"])
PART = "role!='admin' AND COALESCE(is_demo,0)=0 AND " + a.participant_sql()


def count_people(c, url):
    r = c.get(url)
    m = re.search(r'class="adm-count">([\d,]+) (?:person|people)', r.get_data(as_text=True))
    return r.status_code, int(m.group(1).replace(",", "")) if m else None


def xlsx_rows(resp):
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(resp.data), read_only=True)
    ws = wb.worksheets[0]
    return [list(r) for r in ws.iter_rows(values_only=True)]


# ---------------------------------------------------------------------------
s.section("every module counts everyone taking part, Not started included")
with a.app.test_request_context("/admin"):
    db = a.get_db()
    cid = a.active_cycle_id(db)
    users = a._mod_scope_users(db, SU)
    n_part = db.execute("SELECT COUNT(*) FROM users WHERE " + PART).fetchone()[0]
    s.check("the module pages' people are everyone taking part", len(users) == n_part, (len(users), n_part))
    for key in ("pm", "competency", "calibration", "idp"):
        mod = a._module_view(key)
        st, note = mod["state"](db, SU, users)
        keys = {x[0] for x in mod["stages"]}
        s.check("%s: one stage for every person taking part" % key,
                note is None and len(st) == len(users) and all(v["stage"] in keys for v in st.values()),
                (note, len(st), len(users)))
    pm_state, _n = a._mod_pm_state(db, SU, users)
    with_lines = {r[0] for r in db.execute("SELECT DISTINCT subject_id FROM pm_kpi_targets WHERE cycle_id=?", (cid,))}
    want_ns = sum(1 for uid in users if uid not in with_lines)
    got_ns = sum(1 for v in pm_state.values() if v["stage"] == "not_started")
    s.check("Performance's Not started = taking part with no KPI line (an independent count)",
            got_ns == want_ns and want_ns > 0, (got_ns, want_ns))
    s.check("...and nobody with a KPI line is Not started",
            all(pm_state[uid]["stage"] != "not_started" for uid in users if uid in with_lines))

# ---------------------------------------------------------------------------
s.section("Progress: a chip per stage, the list, its download")
code, n = count_people(C_SU, "/admin/module/pm/progress?fstage=not_started")
s.check("Performance Progress lists the Not started", code == 200 and n == want_ns, (code, n, want_ns))
code, n_all = count_people(C_SU, "/admin/module/pm/progress")
s.check("...and Everyone by default", code == 200 and n_all == n_part, (code, n_all, n_part))
body = C_SU.get("/admin/module/pm/progress").get_data(as_text=True)
s.check("...with a status chip per stage and the line manager column",
        all(lbl in body for lbl in ("Not started", "Targets set", "Results in", "Complete")) and "Line manager" in body)
r = C_SU.get("/admin/module/pm/progress.xlsx?fstage=not_started")
rows = xlsx_rows(r) if r.status_code == 200 else []
s.check("the download is exactly the list on screen (one row per person, plus the header)",
        r.status_code == 200 and len(rows) == want_ns + 1 and rows[0][0] == "Employee ID", (r.status_code, len(rows)))
if BGA is not None:
    r = C_BG.get("/admin/module/pm/progress.xlsx")
    rows = xlsx_rows(r) if r.status_code == 200 else []
    with a.app.test_request_context("/admin"):
        own = a.display_bg(BGA["admin_bg"])
    s.check("a BG admin's download holds their own business group only",
            r.status_code == 200 and len(rows) > 1 and all(x[2] == own for x in rows[1:]), (r.status_code, len(rows)))
for key in ("competency", "calibration", "idp"):
    code, _n = count_people(C_SU, "/admin/module/%s/progress" % key)
    s.check("%s Progress opens" % key, code == 200, code)
s.check("the Career Plan's Overview stays its own page", C_SU.get("/admin/module/idp").status_code == 404
        and C_SU.get("/admin/m/idp").status_code == 200)
for key in ("pm", "competency", "calibration"):
    r = C_SU.get("/admin/module/%s" % key)
    b = r.get_data(as_text=True)
    s.check("%s Overview opens with its stage tiles and a by-business-group table" % key,
            r.status_code == 200 and "adm-stage-tile" in b and "By business group" in b, r.status_code)
b = C_SU.get("/admin/module/pm").get_data(as_text=True)
s.check("...and no download link (its Excel moved to Reports, 4 Nov 2026; the address still downloads)",
        "/admin/module/pm/progress.xlsx" not in b and "Download progress" not in b)

# ---------------------------------------------------------------------------
s.section("readiness: N of M, and steps that wait on others")
with a.app.test_request_context("/admin"):
    db = a.get_db()
    groups, _d, _t = a._cycle_readiness(db, SU, a.active_cycle(db))
    steps = {x["label"]: x for g in groups for x in g["steps"]}
    n_pop = db.execute("SELECT COUNT(*) FROM users u WHERE u.role!='admin' AND " +
                       a.calibration_population_sql("u")).fetchone()[0]
    kt = steps.get("KPI targets in")
    s.check("KPI targets in: N of the people taking part", kt and kt["of"] == n_pop, kt and (kt["of"], n_pop))
    rs = steps.get("Results submitted")
    s.check("Results submitted waits on employees, not on the admin",
            rs and rs["waits"] == "employees" and rs["state"] in ("waiting", "done"), rs and rs["state"])
    s.check("the moderator step says what it checks", "Every KPI line has a moderator" in steps)
    cl = steps.get("Calibration locked")
    s.check("Calibration locked is N of M scopes, waiting on the leaders",
            cl and cl["of"] and cl["waits"] == "leaders", cl and (cl["of"], cl["state"]))
    shell = a.admin_shell(SU, "/admin")
    pm_badge = next((i["badge"] for grp in shell["side"] for i in grp["items"] if i["key"] == "pm"), None)
    pm_todo = sum(1 for g in groups if g["label"] == "Performance" for x in g["steps"]
                  if x["state"] not in ("done", "waiting"))
    s.check("the sidebar's to-do leaves out steps waiting on others",
            pm_badge == ("%d to do" % pm_todo if pm_todo else "Done"), (pm_badge, pm_todo))

# ---------------------------------------------------------------------------
s.section("Lock status: every scope that locks, open or locked")
with a.app.test_request_context("/admin"):
    db = a.get_db()
    cyc = a.active_cycle(db)
    lrows = a._calib_lock_scopes(db, SU, cyc)
    hods = {r[0] for r in db.execute("SELECT DISTINCT u.hod_id FROM users u WHERE u.hod_id IS NOT NULL AND "
                                     "u.role!='admin' AND " + a.calibration_population_sql("u"))}
    s.check("one row per HOD over anyone taking part", len([r for r in lrows if r["tier"] == "hod"]) == len(hods),
            (len([r for r in lrows if r["tier"] == "hod"]), len(hods)))
    pm_locked = {r[0] for r in db.execute("SELECT scope_key FROM pm_calibration_sessions WHERE cycle_id=? AND "
                                          "tier='hod' AND locked_at IS NOT NULL", (cyc["id"],))}
    s.check("an HOD row's performance reads locked exactly when its session is",
            all(bool(r["pm"]) == (r["key"] in pm_locked) for r in lrows if r["tier"] == "hod"))
    mid = a.cycle_is_mid_year(db, cyc["id"])
    s.check("Mid-Year has the HOD reviews only; Year-End adds BU CEO and Talent Box rows",
            (not any(r["tier"] != "hod" for r in lrows)) if mid else any(r["tier"] == "buceo" for r in lrows))
r = C_SU.get("/admin/calibration/locks")
b = r.get_data(as_text=True)
s.check("the page opens for a super admin, in the Calibration & Talent menu", r.status_code == 200
        and "Lock status" in b and "Still open" in b, r.status_code)
m = re.search(r'Everything<span>([\d,]+)</span>.*?Still open<span>([\d,]+)</span>.*?Locked<span>([\d,]+)</span>', b, re.S)
s.check("...Everything = Still open + Locked", m and int(m.group(1).replace(",", "")) ==
        int(m.group(2).replace(",", "")) + int(m.group(3).replace(",", "")))
if BGA is not None:
    with a.app.test_request_context("/admin"):
        db = a.get_db()
        brows = a._calib_lock_scopes(db, BGA, a.active_cycle(db))
    s.check("a BG admin sees their own business group's scopes only",
            all(r["bg"] == BGA["admin_bg"] for r in brows), len(brows))
    s.check("...and the page opens for them", C_BG.get("/admin/calibration/locks").status_code == 200)
r = C_SU.get("/admin/calibration/locks?format=xlsx")
s.check("the download is a workbook", r.status_code == 200 and r.data[:2] == b"PK", r.status_code)

# ---------------------------------------------------------------------------
s.section("the menu")
b = C_SU.get("/admin/module/idp/progress").get_data(as_text=True)
s.check("Career Plan has a Run tab", ">Run<" in b)
b = C_SU.get("/admin/module/competency/progress").get_data(as_text=True)
s.check("Competency's Run tab lists Assign competencies", "Assign competencies" in b)

# ===========================================================================
# Row 2: cycle setup
# ===========================================================================
s.section("the cycle's period: every part's dates sit inside it")
with a.app.app_context():
    db = a.get_db()
    ACID = a.active_cycle_id(db)
    _cyc0 = dict(db.execute("SELECT * FROM cycles WHERE id=?", (ACID,)).fetchone())
    _win0 = [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows WHERE "
                                          "cycle_id=?", (ACID,))]
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (ACID,))
    db.execute("UPDATE cycles SET starts_on='2027-06-01 09:00', ends_on='2027-07-31 23:59' WHERE id=?", (ACID,))
    db.commit()
try:
    def win(cell):
        r = H.rows(a, "SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell=?", (ACID, cell))
        return tuple(r[0]) if r else None
    C_SU.post("/admin/windows", data={"csrf_token": "tok", "cycle": str(ACID), "action": "save_one:f360",
                                      "opens_f360": "2027-07-20T09:00", "closes_f360": "2027-08-02T23:59"})
    s.check("a part closing after the cycle closes is refused", win("f360") is None, win("f360"))
    C_SU.post("/admin/windows", data={"csrf_token": "tok", "cycle": str(ACID), "action": "save_one:f360",
                                      "opens_f360": "2027-06-01T09:00", "closes_f360": "2027-06-28T23:59"})
    s.check("...and one inside it saves", win("f360") == ("2027-06-01 09:00", "2027-06-28 23:59"), win("f360"))
    C_SU.post("/admin/windows", data={"csrf_token": "tok", "cycle": str(ACID), "action": "save",
                                      "opens_tc_self": "2027-05-20T09:00", "closes_tc_self": "2027-06-21T23:59",
                                      "opens_f360": "2027-06-01T09:00", "closes_f360": "2027-06-28T23:59",
                                      "opens_pm_results": "2027-06-01T09:00", "closes_pm_results": "2027-06-21T23:59"})
    s.check("Save all keeps the rows inside and refuses the one opening before the cycle",
            win("tc_self") is None and win("pm_results") == ("2027-06-01 09:00", "2027-06-21 23:59"),
            (win("tc_self"), win("pm_results")))
    C_SU.post("/admin/windows", data={"csrf_token": "tok", "cycle": str(ACID), "action": "open_now:tc_approve"})
    s.check("Open now is refused while today is outside the period", win("tc_approve") is None, win("tc_approve"))
    page = C_SU.get("/admin/windows?cycle=%d" % ACID).get_data(as_text=True)
    s.check("Edit all dates shows the period and holds every part", "The cycle's period" in page
            and "1 Jun – 31 Jul 2027" in page and page.count('data-cell="') == 14 and 'id="win-save"' in page)

    s.section("Edit cycle: name, code, year, half and the period, logged")
    nxt = "/admin/cycle?cycle=%d" % ACID
    base = {"csrf_token": "tok", "action": "edit_cycle", "cycle_id": str(ACID), "next": nxt,
            "name": _cyc0["name"], "code": _cyc0["code"], "year": str(_cyc0["year"] or ""),
            "half": str(_cyc0["half"] or ""), "starts_on": "2027-06-01T09:00", "ends_on": "2027-07-31T23:59"}
    r = C_SU.post("/admin/cycles", data=dict(base, ends_on="2027-06-20T23:59"))
    c1 = H.rows(a, "SELECT ends_on FROM cycles WHERE id=?", (ACID,))[0][0]
    s.check("a period that would leave a dated part outside is refused", c1 == "2027-07-31 23:59"
            and r.headers.get("Location", "").endswith(nxt), c1)
    other = H.rows(a, "SELECT name FROM cycles WHERE id!=? LIMIT 1", (ACID,))
    if other:
        C_SU.post("/admin/cycles", data=dict(base, name=other[0][0]))
        s.check("another cycle's name is refused", H.rows(a, "SELECT name FROM cycles WHERE id=?", (ACID,))[0][0]
                == _cyc0["name"])
    n_log = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='cycle' AND detail LIKE 'Edited %'")
    _other_half = 1 if _cyc0["half"] == 2 else 2
    C_SU.post("/admin/cycles", data=dict(base, year="2031", half=str(_other_half), ends_on="2027-08-15T23:59"))
    c2 = H.rows(a, "SELECT year, half, ends_on FROM cycles WHERE id=?", (ACID,))[0]
    s.check("year, half and the period save", tuple(c2) == (2031, _other_half, "2027-08-15 23:59"), tuple(c2))
    s.check("...and the change is in the audit log, old and new",
            H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='cycle' AND detail LIKE 'Edited %'") == n_log + 1
            and "half " in (H.rows(a, "SELECT detail FROM activity_log WHERE action='cycle' ORDER BY id DESC LIMIT 1")
                            [0][0]))
    cal = C_SU.get("/admin/cycle?cycle=%d" % ACID).get_data(as_text=True)
    s.check("the Calendar's This cycle card shows them, with Edit cycle", "This cycle" in cal and "2031" in cal
            and "Year-End" in cal and 'id="adm-cyc-edit"' in cal and 'value="edit_cycle"' in cal)

    s.section("no dates yet: copy another cycle's, shifted")
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (ACID,))
        SRC = db.execute("SELECT id FROM cycles WHERE id!=? ORDER BY id LIMIT 1", (ACID,)).fetchone()[0]
        _src0 = [tuple(r) for r in db.execute("SELECT cycle_id, cell, opens_at, closes_at FROM cycle_windows WHERE "
                                              "cycle_id=?", (SRC,))]
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (SRC,))
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                   (SRC, "f360", "2026-06-01 09:00", "2026-06-28 23:59"))
        db.commit()
    try:
        cal = C_SU.get("/admin/cycle?cycle=%d" % ACID).get_data(as_text=True)
        s.check("the Calendar says no part has dates and offers to copy", "No dates set" in cal
                and 'name="copy"' in cal and 'name="shift"' in cal)
        pg = C_SU.get("/admin/windows?cycle=%d&copy=%d&shift=12" % (ACID, SRC)).get_data(as_text=True)
        s.check("the copy pre-fills the dates 12 months later", 'name="opens_f360" value="2027-06-01T09:00"' in pg
                and 'name="closes_f360" value="2027-06-28T23:59"' in pg and "12 months later" in pg)
        s.check("...and saves nothing until Save", not H.rows(a, "SELECT 1 FROM cycle_windows WHERE cycle_id=?",
                                                               (ACID,)))
    finally:
        with a.app.app_context():
            db = a.get_db()
            db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (SRC,))
            for r_ in _src0:
                db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", r_)
            db.commit()

    s.section("Mid-Year greys the parts it doesn't use")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET half=1 WHERE id=?", (ACID,))
        db.commit()
    pg = C_SU.get("/admin/windows?cycle=%d" % ACID).get_data(as_text=True)
    s.check("KPI setting, the plan and the BU / BG CEO parts read Not used at Mid-Year; seven to date",
            pg.count('class="win-row is-unused"') == 7 and pg.count('data-cell="') == 14 and "used at Mid-Year" in pg)

    s.section("a BG admin reads the calendar")
    if BGA is not None:
        r = C_BG.get("/admin/cycle")
        b = r.get_data(as_text=True)
        s.check("it opens for them, read only: no form that saves dates or the cycle", r.status_code == 200
                and "Read only" in b and 'action="/admin/windows"' not in b and 'value="edit_cycle"' not in b, r.status_code)
        s.check("...with their own group's results, released to leaders and to each person", "Your group's results" in b)
        s.check("...and Edit all dates stays a super admin's", C_BG.get("/admin/windows").status_code == 403)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (ACID,))
        for r_ in _win0:
            db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", r_)
        db.execute("UPDATE cycles SET name=?, code=?, year=?, half=?, starts_on=?, ends_on=? WHERE id=?",
                   (_cyc0["name"], _cyc0["code"], _cyc0["year"], _cyc0["half"], _cyc0["starts_on"], _cyc0["ends_on"],
                    ACID))
        db.commit()

s.section("Start the next cycle: the tick, and a refusal keeps the form")
n_cyc = H.one(a, "SELECT COUNT(*) FROM cycles")
r = C_SU.post("/admin/cycles", data={"csrf_token": "tok", "action": "create", "name": "ZZ R4 Start", "code": "ZZ-R4",
                                     "year": "2027", "half": "1", "source": "empty"})
s.check("without the tick nothing starts", H.one(a, "SELECT COUNT(*) FROM cycles") == n_cyc)
s.check("...and the form comes back with what was typed", "name=ZZ+R4+Start" in r.headers.get("Location", "")
        and "#start" in r.headers.get("Location", ""), r.headers.get("Location"))
pg = C_SU.get("/admin/cycles?name=ZZ+R4+Start&code=ZZ-R4").get_data(as_text=True)
s.check("the Start form asks for the tick and says what freezes", 'name="confirm_freeze"' in pg
        and "rating records freeze" in pg and 'value="ZZ R4 Start"' in pg and "Cycle opens" in pg)

# ===========================================================================
# Row 3: fixing people data where it's flagged
# ===========================================================================
import csv as _csv  # noqa: E402
s.section("the people picker: by name, ID or job, in the admin's own scope")
with a.app.app_context():
    db = a.get_db()
    MGR = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 AND "
                     "business_group=? AND id IN (SELECT manager_id FROM users WHERE manager_id IS NOT NULL) LIMIT 1",
                     (BGA["admin_bg"],)).fetchone()
    OUT = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 AND "
                     "business_group!=? LIMIT 1", (BGA["admin_bg"],)).fetchone()
j = C_SU.get("/admin/people/find.json?q=" + MGR["full_name"].split()[0]).get_json()
s.check("a super admin finds a manager by name, with what they lead", any(p["eid"] == MGR["employee_id"] and
                                                                       p["leads"] >= 1 for p in j["people"]))
j = C_BG.get("/admin/people/find.json?q=" + (OUT["employee_id"] or "")).get_json()
s.check("a BG admin never finds someone outside their group", not any(p["eid"] == OUT["employee_id"]
                                                                      for p in j["people"]))

s.section("Data integrity: fix a row where it's listed")
with a.app.app_context():
    db = a.get_db()
    TGT = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 AND "
                     "business_group=? AND id!=? AND manager_id IS NOT NULL AND manager_id!=? LIMIT 1",
                     (BGA["admin_bg"], MGR["id"], MGR["id"])).fetchone()
    _keep = (TGT["manager_id"], TGT["department"])
    db.execute("UPDATE users SET manager_id=NULL WHERE id=?", (TGT["id"],))
    db.commit()
try:
    # Data integrity is the super admin's since 2026-10-21 (under Audit and usage)
    pg = C_SU.get("/admin/data-integrity?check=no_manager").get_data(as_text=True)
    s.check("the no-line-manager list carries a picker on each row and a bulk bar",
            'class="dc-row-fix"' in pg and 'id="dc-bulk"' in pg and 'data-pick' in pg)
    r = C_SU.post("/admin/data-integrity/fix", data={"csrf_token": "tok", "check": "no_manager", "uid": str(TGT["id"]),
                                                    "lm_eid": MGR["employee_id"]})
    got = H.rows(a, "SELECT manager_id FROM users WHERE id=?", (TGT["id"],))[0][0]
    s.check("Save sets their line manager, and it's on their page's log", r.status_code == 302 and got == MGR["id"]
            and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='set_manager' AND target_user_id=? AND "
                         "detail LIKE '%Data integrity%'", (TGT["id"],)) >= 1, got)
    r = C_BG.post("/admin/data-integrity/fix", data={"csrf_token": "tok", "check": "no_manager", "uid": str(OUT["id"]),
                                                    "lm_eid": MGR["employee_id"]})
    s.check("a BG admin can't fix someone outside their group", r.status_code == 403, r.status_code)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET department=NULL WHERE id=?", (TGT["id"],))
        db.commit()
    C_SU.post("/admin/data-integrity/fix", data={"csrf_token": "tok", "check": "no_department", "uid": str(TGT["id"]),
                                                "department": "__new__", "department_new": "ZZ R4 Dept"})
    s.check("a department is set the same way", H.rows(a, "SELECT department FROM users WHERE id=?",
                                                      (TGT["id"],))[0][0] == "ZZ R4 Dept")
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET manager_id=?, department=? WHERE id=?", (_keep[0], _keep[1], TGT["id"]))
        db.commit()

s.section("the person page: Edit details, and what it changes")
with a.app.app_context():
    db = a.get_db()
    P0 = dict(db.execute("SELECT * FROM users WHERE id=?", (TGT["id"],)).fetchone())
    units = [c for c in a.org_map(db).get(P0["business_group"], []) if c != P0["company"]]
pg = C_BG.get("/admin/users/%d" % TGT["id"]).get_data(as_text=True)
s.check("the Overview has a Details card with Edit, and the line manager and HOD are picked by name",
        'id="details"' in pg and 'value="details_preview"' in pg and 'name="lm_eid" class="pick-val"' in pg
        and 'name="hod_eid" class="pick-val"' in pg)
if units:
    form = {"csrf_token": "tok", "company": units[0], "department": "__new__", "department_new": "ZZ R4 Moved",
            "job_title": "__new__", "job_title_new": "ZZ R4 Title", "job_grade": P0["job_grade"] or ""}
    pg = C_SU.post("/admin/users/%d/lines" % TGT["id"], data=dict(form, action="details_preview")).get_data(as_text=True)
    # (piece 3, 2026-11-08) a unit change makes other things follow (BU KPI lines, pending 360 ratings, who calibrates them), each said in
    # its own row; the "Stays as it is" row lists only what really stays: their KPI lines (less any the BU KPI row takes off) and their
    # 360 panel. Its count is theirs, not a number written here.
    with a.app.test_request_context("/"):
        _d = a.get_db()
        _cid = a.active_cycle_id(_d) or 0
        _n_kpi = _d.execute("SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=?", (TGT["id"], _cid)).fetchone()[0]
        _plan = a._profile_change_plan(_d, dict(_d.execute("SELECT * FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' LIMIT 1").fetchone()),
                                       dict(_d.execute("SELECT * FROM users WHERE id=?", (TGT["id"],)).fetchone()),
                                       {"company": units[0], "department": "ZZ R4 Moved", "job_title": "ZZ R4 Title"}, a.active_cycle(_d))
    _stay = _n_kpi - sum(n_.get("off", 0) for n_ in _plan["notes"])
    s.check("the preview says what changes: the unit, the department, and the BU CEO calibration that follows the unit",
            "What this changes" in pg and "BU CEO calibration" in pg and "ZZ R4 Moved" in pg)
    s.check("...and its 'Stays as it is' row lists only what stays: their KPI lines (the count is theirs, less any the BU KPI row takes off) and "
            "their 360 panel; what follows is in the rows above it",
            ("Their %d KPI line%s and their 360 panel stay as they are" % (_stay, "" if _stay == 1 else "s")) in pg
            and pg.index("Stays as it is") > pg.index("BU CEO calibration"))
    s.check("...and nothing is saved by the preview",
            H.rows(a, "SELECT company, job_title FROM users WHERE id=?", (TGT["id"],))[0][1] == P0["job_title"])
    C_SU.post("/admin/users/%d/lines" % TGT["id"], data=dict(form, action="details_apply"))
    got = H.rows(a, "SELECT company, department, job_title FROM users WHERE id=?", (TGT["id"],))[0]
    s.check("Save details saves them and logs it on their page", tuple(got) == (units[0], "ZZ R4 Moved", "ZZ R4 Title")
            and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='set_details' AND target_user_id=?",
                      (TGT["id"],)) >= 1, tuple(got))
    C_SU.post("/admin/users/%d/lines" % TGT["id"], data=dict(form, action="details_apply", company="ZZ No Such Unit"))
    s.check("a unit outside their group's Org structure is refused",
            H.rows(a, "SELECT company FROM users WHERE id=?", (TGT["id"],))[0][0] == units[0])
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE users SET company=?, department=?, job_title=?, job_grade=?, hod_id=? WHERE id=?",
               (P0["company"], P0["department"], P0["job_title"], P0["job_grade"], P0["hod_id"], TGT["id"]))
    db.commit()

s.section("the roster import in one step: check, then apply the same file")


def _roster_csv(rows):
    buf = io.StringIO()
    w = _csv.writer(buf)
    w.writerow(a.ROSTER_COLUMNS)
    w.writerows(rows)
    return buf.getvalue().encode("utf-8")


def _past_quality(client, tok):
    """Step 2 -> 3 of the import: past the quality check (ticking that the things to look at were seen), then the
    changes page."""
    client.post("/admin/import/roster", data={"csrf_token": "tok", "token": tok, "action": "quality_ok", "ack": "1"})
    return client.get("/admin/import/roster?check=%s&step=changes" % tok).get_data(as_text=True)


def _apply(client, tok):
    """Steps 3 -> 4 -> Apply (the fourth step, 2026-10-26)."""
    client.post("/admin/import/roster", data={"csrf_token": "tok", "token": tok, "action": "to_apply"})
    client.post("/admin/import/roster", data={"csrf_token": "tok", "token": tok, "action": "apply"})


def _row(**kw):
    r = dict(zip(a.ROSTER_COLUMNS, [""] * len(a.ROSTER_COLUMNS)))
    for k, v in kw.items():
        r[k] = v
    return [r[c] for c in a.ROSTER_COLUMNS]


_cols = {c.lower(): c for c in a.ROSTER_COLUMNS}
good = _row(**{_cols["employee id"]: TGT["employee_id"], _cols["employee name"]: TGT["full_name"],
               _cols["business group"]: TGT["business_group"], _cols["company"]: TGT["company"] or "",
               _cols["job title"]: "ZZ R4 Imported Title"})
bad = _row(**{_cols["employee id"]: "ZZR4-NEW-1", _cols["employee name"]: "ZZ R4 New",
              _cols["business group"]: TGT["business_group"], _cols["company"]: "ZZ No Such Unit"})
r = C_SU.post("/admin/import/roster", data={"csrf_token": "tok", "mode": "upsert", "preview": "1",
                                            "file": (io.BytesIO(_roster_csv([good, bad])), "r4.csv")},
              content_type="multipart/form-data")
loc = r.headers.get("Location", "")
tok = loc.split("check=")[-1] if "check=" in loc else ""
s.check("choosing a file checks it and keeps it (a token), changing nothing", r.status_code == 302 and len(tok) == 32
        and H.rows(a, "SELECT job_title FROM users WHERE id=?", (TGT["id"],))[0][0] == P0["job_title"], loc)
pg = C_SU.get("/admin/import/roster?check=" + tok).get_data(as_text=True)
s.check("the check lists the row that can't be imported, the unit that isn't in Org structure among them",
        "can't be imported" in pg and "isn&#39;t a unit in Org structure" in pg and "Continue to the changes" in pg)
s.check("...Continue stays off while any row fails", re.search(
    r'<button type="submit" class="primary"\s+disabled>Continue to the changes', pg) is not None)
csvb = H.as_csv_text(C_SU.get("/admin/import/roster/check/%s.csv" % tok))
s.check("every error downloads with its row and reason", "ZZR4-NEW-1" in csvb and "Org structure" in csvb)
s.check("someone else can't read or apply that file", C_BG.get("/admin/import/roster/check/%s.csv" % tok).status_code
        == 404)
r = C_SU.post("/admin/import/roster", data={"csrf_token": "tok", "mode": "upsert", "preview": "1",
                                            "file": (io.BytesIO(_roster_csv([good])), "r4.csv")},
              content_type="multipart/form-data")
tok2 = r.headers.get("Location", "").split("check=")[-1]
pg = _past_quality(C_SU, tok2)
s.check("a clean file shows what each update changes, by field", "Job title" in pg and "ZZ R4 Imported Title" in pg
        and "Download every change" in pg)
s.check("...with the counts as numbers (a key named 'update' once read as the dict's own method)",
        "built-in method" not in pg and re.search(r"<b>1</b><span>to update</span>", pg) is not None)
_apply(C_SU, tok2)
s.check("Apply this file applies that same file, no picking it again",
        H.rows(a, "SELECT job_title FROM users WHERE id=?", (TGT["id"],))[0][0] == "ZZ R4 Imported Title")
s.check("...and the kept file is gone afterwards", C_SU.get("/admin/import/roster/check/%s.csv" % tok2).status_code == 404)
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE users SET job_title=? WHERE id=?", (P0["job_title"], TGT["id"]))
    db.commit()

# ===========================================================================
# Row 4: Org structure as a table
# ===========================================================================
s.section("Org structure: one table, row menus, a read-only view for a BG admin")
pg = C_SU.get("/admin/org").get_data(as_text=True)
s.check("one table of groups and units, each row's Edit opening its panel (rename, display name, its people, remove)",
        'id="org-table"' in pg and pg.count('class="btn-link org-edit-btn" data-panel-open="org-') >= 2
        and 'value="rename_company"' in pg and 'value="set_company_display"' in pg and "Removed · " in pg)
_og = C_SU.get("/admin/org").get_data(as_text=True)
_grp = re.findall(r'<tbody class="org-grp" data-bg="([^"]*)"', _og)
_bgrow = _og[_og.index('id="org-bgrow"'):] if 'id="org-bgrow"' in _og else ""
_pills = re.findall(r'<a class="adm-frow-pill([^"]*)" href="([^"]*)"', _bgrow[:_bgrow.index('</div>', _bgrow.index('adm-frow-pills'))] if _bgrow else "")
_pslugs = [re.search(r'[?&]bg=([^&"]+)', h).group(1) for _c, h in _pills[1:] if 'bg=' in h]
s.check("Org structure: the admin BG filter row (All + one pill a group, All on by default) in group order, the old drop-down gone",
        len(_grp) == _og.count('<tbody class="org-grp"') > 0 and len(_pills) == len(_grp) + 1 and 'is-on' in _pills[0][0]
        and 'bg=' not in _pills[0][1] and all('is-on' not in c for c, _h in _pills[1:]) and _pslugs == _grp
        and 'id="org-bg"' not in _og, (len(_grp), len(_pills)))
_og2 = C_SU.get("/admin/org?bg=" + _grp[0]).get_data(as_text=True)
_bgrow2 = _og2[_og2.index('id="org-bgrow"'):]
_p2 = re.findall(r'<a class="adm-frow-pill([^"]*)" href="([^"]*)"', _bgrow2[:_bgrow2.index('</div>', _bgrow2.index('adm-frow-pills'))])
s.check("...?bg=<slug> puts that pill on and All off", 'is-on' in _p2[1][0] and 'is-on' not in _p2[0][0], _p2[:2])
s.check("...and the Removed view has no BG row", 'id="org-bgrow"' not in C_SU.get("/admin/org?show=removed").get_data(as_text=True))
r = C_BG.get("/admin/org")
b = r.get_data(as_text=True)
s.check("a BG admin reads their own group's units (it was a 403), with no form that changes anything",
        r.status_code == 200 and "Read only" in b and 'name="action"' not in b, r.status_code)
s.check("...and can't post a change", C_BG.post("/admin/org", data={"csrf_token": "tok", "action": "add_company",
                                                                    "business_group": BGA["admin_bg"],
                                                                    "company": "ZZ R4 Nope"}).status_code == 403)

s.section("removing a unit that still has people asks for its name; Removed brings it back")
with a.app.app_context():
    db = a.get_db()
    UN = db.execute("SELECT company, COUNT(*) n FROM users WHERE business_group=? AND role!='admin' AND left_at IS NULL "
                    "AND COALESCE(company,'')!='' AND company IN (SELECT company FROM org_units WHERE business_group=? "
                    "AND active=1) GROUP BY company ORDER BY n LIMIT 1", (BGA["admin_bg"], BGA["admin_bg"])).fetchone()
_act = lambda: H.one(a, "SELECT active FROM org_units WHERE business_group=? AND company=?", (BGA["admin_bg"], UN[0]))
try:
    C_SU.post("/admin/org", data={"csrf_token": "tok", "action": "remove_company", "business_group": BGA["admin_bg"],
                                  "old": UN[0], "confirm_name": ""})
    s.check("without its name typed, a unit with %d people stays" % UN[1], _act() == 1)
    C_SU.post("/admin/org", data={"csrf_token": "tok", "action": "remove_company", "business_group": BGA["admin_bg"],
                                  "old": UN[0], "confirm_name": UN[0]})
    s.check("with its name typed it's removed, its people untouched", _act() == 0 and H.one(
        a, "SELECT COUNT(*) FROM users WHERE business_group=? AND company=? AND role!='admin' AND left_at IS NULL",
        (BGA["admin_bg"], UN[0])) == UN[1])
    pg = C_SU.get("/admin/org?show=removed").get_data(as_text=True)
    s.check("...and listed under Removed with the people still in it and a Restore", UN[0] in pg
            and 'value="restore_company"' in pg)
    C_SU.post("/admin/org", data={"csrf_token": "tok", "action": "restore_company", "business_group": BGA["admin_bg"],
                                  "company": UN[0]})
    s.check("Restore brings it back as it was", _act() == 1)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE org_units SET active=1 WHERE business_group=? AND company=?", (BGA["admin_bg"], UN[0]))
        db.commit()


# ---------------------------------------------------------------------------
# Row 5: one BU CEO for several units, each locked on its own (Chris: "we do have case where one person is BUCEO of two
# BUs"; approved "build it, each unit locked separately").
s.section("BU CEO seats: one row per unit, seeded from the old columns")
with a.app.app_context():
    db = a.get_db()
    old_cols = {(r[0], r[1]): r[2] for r in db.execute(
        "SELECT buceo_bg, buceo_company, id FROM users WHERE COALESCE(buceo_bg,'')!='' AND COALESCE(buceo_company,'')!=''")}
    seats = {(r[0], r[1]): r[2] for r in db.execute("SELECT business_group, company, user_id FROM buceo_seats")}
s.check("every old BU CEO column pair has its seat row", all(seats.get(k) == v for k, v in old_cols.items()),
        [k for k, v in old_cols.items() if seats.get(k) != v][:3])

with a.app.app_context():
    db = a.get_db()
    BG5 = BGA["admin_bg"]
    UNITS = [r[0] for r in db.execute(
        "SELECT o.company FROM org_units o WHERE o.business_group=? AND o.active=1 AND EXISTS (SELECT 1 FROM users u "
        "WHERE u.business_group=o.business_group AND u.company=o.company AND u.role!='admin' AND u.left_at IS NULL) "
        "ORDER BY o.company LIMIT 3", (BG5,))]
    P5 = db.execute("SELECT * FROM users WHERE business_group=? AND role!='admin' AND left_at IS NULL "
                    "AND COALESCE(is_demo,0)=0 AND COALESCE(bgceo_bg,'')='' AND id NOT IN (SELECT user_id FROM "
                    "buceo_seats) ORDER BY id LIMIT 1", (BG5,)).fetchone()
    SAVED = [(r[0], r[1], r[2]) for r in db.execute(
        "SELECT business_group, company, user_id FROM buceo_seats WHERE business_group=? AND company IN (%s)"
        % ",".join("?" * len(UNITS)), [BG5] + UNITS)]
    CID5 = a.active_cycle_id(db)
s.check("fixture: two units with people and a person to seat", len(UNITS) >= 2 and P5 is not None, len(UNITS))
UA, UB = UNITS[0], UNITS[1]
SESS_SAVED = []


def _seats5():
    return [r[0] for r in H.rows(a, "SELECT company FROM buceo_seats WHERE user_id=? ORDER BY company", (P5["id"],))]


def _primary5():
    return H.one(a, "SELECT buceo_company FROM users WHERE id=?", (P5["id"],))


try:
    with a.app.test_request_context("/admin/leaders"):
        db = a.get_db()
        ok, _m = a._assign_buceo(db, SU, P5["id"], BG5, UA)
        ok2, msg2 = a._assign_buceo(db, SU, P5["id"], BG5, UB)
        db.commit()
    s.check("adding a second unit keeps the first: they lead both", ok and ok2 and _seats5() == sorted([UA, UB]),
            _seats5())
    s.check("...the message says each is locked on its own", "each locked on its own" in msg2)
    s.check("...users.buceo_company stays their first unit", _primary5() == UA, _primary5())
    s.check("...and whoever held the second unit no longer does",
            H.one(a, "SELECT user_id FROM buceo_seats WHERE business_group=? AND company=?", (BG5, UB)) == P5["id"])
    with a.app.test_request_context("/"):
        db = a.get_db()
        u5 = db.execute("SELECT * FROM users WHERE id=?", (P5["id"],)).fetchone()
        s.check("is_buceo_of is true for both units", a.is_buceo_of(u5, BG5, UA) and a.is_buceo_of(u5, BG5, UB))
        tiers = [k for t, k in a.calibration_tier_of(db, u5) if t == "buceo"]
        s.check("calibration_tier_of returns a seat per unit", sorted(c for _b, c in tiers) == sorted([UA, UB]), tiers)
    with a.app.test_request_context("/?bu_unit=%s" % UB):
        db = a.get_db()
        u5 = db.execute("SELECT * FROM users WHERE id=?", (P5["id"],)).fetchone()
        first = next(k for t, k in a.calibration_tier_of(db, u5) if t == "buceo")
        s.check("?bu_unit= picks the unit worked on (it comes first)", first == (BG5, UB), first)
    # each unit locks on its own: lock both of A's calibrations, and the pick moves to B
    with a.app.app_context():
        db = a.get_db()
        for tbl in ("pm_calibration_sessions", "calibration_sessions"):
            had = db.execute("SELECT id, locked_at, locked_by FROM %s WHERE cycle_id=? AND tier='buceo' AND scope_key=?"
                             % tbl, (CID5, UA)).fetchone()
            SESS_SAVED.append((tbl, tuple(had) if had else None))
            if had:
                db.execute("UPDATE %s SET locked_at=datetime('now'), locked_by=? WHERE id=?" % tbl, (P5["id"], had[0]))
            else:
                db.execute("INSERT INTO %s(cycle_id, tier, scope_key, business_group, scope_label, locked_at, locked_by) "
                           "VALUES (?,?,?,?,?,datetime('now'),?)" % tbl, (CID5, "buceo", UA, BG5, UA, P5["id"]))
        db.commit()
    with a.app.test_request_context("/"):
        db = a.get_db()
        u5 = db.execute("SELECT * FROM users WHERE id=?", (P5["id"],)).fetchone()
        first = next(k for t, k in a.calibration_tier_of(db, u5) if t == "buceo")
        s.check("with no pick, the first unit not locked on both axes comes first", first == (BG5, UB), first)
        cyc = db.execute("SELECT * FROM cycles WHERE id=?", (CID5,)).fetchone()
        st = a.dash_bu_status(db, u5, cyc)
        un = {x["label"]: x for x in (st or {}).get("units") or []}
        s.check("the dashboard's BU card lists both units, the one on screen lit",
                len(un) == 2 and sum(1 for x in un.values() if x["on"]) == 1, list(un))
        nb = sum(1 for tbl in ("pm_calibration_sessions", "calibration_sessions") if db.execute(
            "SELECT 1 FROM %s WHERE cycle_id=? AND tier='buceo' AND scope_key=? AND business_group=? AND locked_at IS "
            "NOT NULL" % tbl, (CID5, UB, BG5)).fetchone())
        s.check("...the locked one says so, the other by its own locks (an independent count)",
                un[a.display_company(BG5, UA)]["state"] == "locked"
                and un[a.display_company(BG5, UB)]["state"] == {0: "open", 1: "part", 2: "locked"}[nb],
                (un[a.display_company(BG5, UA)]["state"], un[a.display_company(BG5, UB)]["state"], nb))
        _orig_tier = a._journey_view_tier
        a._journey_view_tier = lambda *_a, **_k: "buceo"
        try:
            pills = a._journey_bu_units(db, u5, "calibration")
        finally:
            a._journey_view_tier = _orig_tier
        s.check("the BU view's unit pills: one per unit, the locked one with its day, each a link",
                len(pills) == 2 and sum(1 for p in pills if p["locked"]) == 1
                and all("bu_unit=" in p["href"] for p in pills), pills)
    js = open(os.path.join(a.APP_DIR, "static", "journey_chat.js")).read()
    s.check("the calibration card draws the unit pills when there are two or more",
            "function calUnitPills" in js and "d.bu_units.length > 1" in js)
    # the person page and the Leaders page say it
    pg = C_SU.get("/admin/users/%s" % P5["id"]).get_data(as_text=True)
    s.check("the person page lists both units, each with its own Remove",
            pg.count('name="action" value="clear_buceo"') == 2 and "each locked on its own" in pg)
    with a.app.app_context():   # the select lists the group's units they don't lead yet -- none when it has just two
        _more5 = [c_ for c_ in a.org_map(a.get_db()).get(BG5, []) if c_ not in (UA, UB)]
    s.check("...and offers another unit to add (when the group has one)", ("Add a unit" in pg) == bool(_more5),
            len(_more5))
    pg = C_SU.get("/admin/leaders?tab=buceo&bg=%s" % BG5).get_data(as_text=True)
    s.check("the Leaders page says they lead 2 units, with a move-instead choice",
            "leads 2 units" in pg and 'name="move" value="1"' in pg)
    # Remove one: they keep the other
    C_SU.post("/admin/users/%s/lines" % P5["id"], data={"csrf_token": "tok", "action": "clear_buceo", "company": UA})
    s.check("removing one unit leaves the other theirs", _seats5() == [UB] and _primary5() == UB,
            (_seats5(), _primary5()))
    # move instead: the units they led are left with none
    with a.app.test_request_context("/admin/leaders"):
        db = a.get_db()
        a._assign_buceo(db, SU, P5["id"], BG5, UA)
        ok, msg = a._assign_buceo(db, SU, P5["id"], BG5, UB, move=False)
        ok, msg = a._assign_buceo(db, SU, P5["id"], BG5, UNITS[2] if len(UNITS) > 2 else UA, move=True)
        db.commit()
    want = [UNITS[2]] if len(UNITS) > 2 else [UA]
    s.check("'move them instead' leaves only the new unit, the others vacant", _seats5() == want, _seats5())
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM buceo_seats WHERE user_id=?", (P5["id"],))
        db.execute("DELETE FROM buceo_seats WHERE business_group=? AND company IN (%s)" % ",".join("?" * len(UNITS)),
                   [BG5] + UNITS)
        for bg_, co_, uid_ in SAVED:
            db.execute("INSERT OR REPLACE INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)",
                       (bg_, co_, uid_))
        for uid_ in {P5["id"]} | {x[2] for x in SAVED}:
            a._sync_buceo_primary(db, uid_)
        for tbl, had in SESS_SAVED:
            if had:
                db.execute("UPDATE %s SET locked_at=?, locked_by=? WHERE id=?" % tbl, (had[1], had[2], had[0]))
            else:
                db.execute("DELETE FROM %s WHERE cycle_id=? AND tier='buceo' AND scope_key=? AND locked_by=?" % tbl,
                           (CID5, UA, P5["id"]))
        db.execute("DELETE FROM activity_log WHERE target_user_id=? AND action IN ('set_buceo','clear_buceo')",
                   (P5["id"],))
        db.commit()


s.section("a direct write of the old columns (the seeders) keeps its old meaning through the triggers")
with a.app.app_context():
    db = a.get_db()
    BEFORE = [(r[0], r[1], r[2]) for r in db.execute(
        "SELECT business_group, company, user_id FROM buceo_seats WHERE business_group=? AND company IN (?,?)",
        (BG5, UA, UB))]
    Q5 = db.execute("SELECT id FROM users WHERE business_group=? AND role!='admin' AND left_at IS NULL AND id!=? AND "
                    "COALESCE(bgceo_bg,'')='' AND id NOT IN (SELECT user_id FROM buceo_seats) ORDER BY id DESC LIMIT 1",
                    (BG5, P5["id"])).fetchone()[0]
    HOLDER_A = (Q5,)
try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM buceo_seats WHERE business_group=? AND company=?", (BG5, UA))
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG5, UA, Q5))
        a._sync_buceo_primary(db, Q5)
        db.commit()
    s.check("fixture: someone else holds the unit first",
            H.one(a, "SELECT buceo_company FROM users WHERE id=?", (Q5,)) == UA)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET buceo_bg=?, buceo_company=? WHERE id=?", (BG5, UA, P5["id"]))
        db.commit()
    s.check("setting the columns gives them that unit's seat", _seats5() == [UA], _seats5())
    if HOLDER_A:
        s.check("...taken from whoever held it, whose columns no longer name it",
                H.one(a, "SELECT COUNT(*) FROM buceo_seats WHERE user_id=? AND company=?", (HOLDER_A[0], UA)) == 0
                and H.one(a, "SELECT COALESCE(buceo_company,'') FROM users WHERE id=?", (HOLDER_A[0],)) != UA)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET buceo_company=? WHERE id=?", (UB, P5["id"]))
        db.commit()
    s.check("moving the columns to another unit moves the seat (the old one-unit write)", _seats5() == [UB], _seats5())
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET buceo_bg=NULL, buceo_company=NULL WHERE id=?", (P5["id"],))
        db.commit()
    s.check("clearing the columns takes every seat away", _seats5() == [], _seats5())
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM buceo_seats WHERE user_id=?", (P5["id"],))
        db.execute("DELETE FROM buceo_seats WHERE business_group=? AND company IN (?,?)", (BG5, UA, UB))
        for bg_, co_, uid_ in BEFORE:
            db.execute("INSERT OR REPLACE INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)",
                       (bg_, co_, uid_))
        db.execute("DELETE FROM buceo_seats WHERE user_id=?", (Q5,))
        for uid_ in {P5["id"], Q5} | {x[2] for x in BEFORE}:
            a._sync_buceo_primary(db, uid_)
        db.commit()


# ---------------------------------------------------------------------------
# Row 6: units calibrated together (the canvas's M1-M3; Chris approved the build). Each unit keeps its own session
# underneath, so every reader that finds a person's BU CEO band by their own unit works as it is.
s.section("units calibrated together: joined by a super admin, one population, one curve")
with a.app.app_context():
    db = a.get_db()
    CID6 = a.active_cycle_id(db)
    # two units of the group with the most people in the performance calibration; their BU CEO calibration rows for
    # this cycle are set aside here and put back exactly in the finally (the scratch data has every unit locked)
    def _pick6():
        r = db.execute("SELECT business_group FROM users WHERE role!='admin' AND COALESCE(company,'')!='' AND "
                       + a.pm_calibration_population_sql() + " GROUP BY business_group ORDER BY COUNT(*) DESC LIMIT 1",
                       (CID6,)).fetchone()
        fr = [x[0] for x in db.execute(
            "SELECT company FROM users WHERE business_group=? AND role!='admin' AND COALESCE(company,'')!='' AND "
            + a.pm_calibration_population_sql() + " GROUP BY company HAVING COUNT(*) BETWEEN 3 AND 80 "
            "ORDER BY COUNT(*) LIMIT 2", (r[0], CID6))] if r else []
        return (r[0] if r else None), fr
    SEEDED6 = []
    db.execute("DELETE FROM pm_kpi_targets WHERE kpi_name='ZZR6 KPI'")   # left by a run that stopped half-way
    BG6, _free = _pick6()
    if len(_free) < 2:
        # the generated CI fixture holds no KPI scorecards (only what earlier suites leave), so no group has two units
        # in the performance calibration: give two units of a group KPI lines (removed in the finally) rather than test
        # an empty population. The fixture has one such group: Northwind.
        _units = db.execute(
            "SELECT business_group, company FROM users WHERE role!='admin' AND COALESCE(company,'')!='' AND "
            + a.participant_sql() + " AND is_demo=0 GROUP BY business_group, company HAVING COUNT(*) >= 3 "
            "ORDER BY business_group, COUNT(*)").fetchall()
        _bgx = next((r[0] for r in _units if sum(1 for x in _units if x[0] == r[0]) >= 2), None)
        _cos = [r[1] for r in _units if r[0] == _bgx][:2]
        for _co in _cos:
            for (_uid,) in db.execute(
                    "SELECT id FROM users WHERE business_group=? AND company=? AND role!='admin' AND "
                    + a.participant_sql() + " AND is_demo=0 AND id NOT IN (SELECT subject_id FROM pm_kpi_targets "
                    "WHERE cycle_id=?) ORDER BY id LIMIT 40", (_bgx, _co, CID6)).fetchall():
                SEEDED6.append(db.execute(
                    "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                    "business_group, company) VALUES (?,?,'ZZR6 KPI',100,'more','approved',?,?)",
                    (CID6, _uid, _bgx, _co)).lastrowid)
        db.commit()
        BG6, _free = _bgx, _cos
    SAVED6 = {}
    for st, at in (("pm_calibration_sessions", "pm_calibration_adjustments"),
                   ("calibration_sessions", "calibration_adjustments")):
        ss = [dict(r) for r in db.execute("SELECT * FROM %s WHERE cycle_id=? AND tier='buceo' AND scope_key IN (?,?)"
                                          % st, (CID6, _free[0], _free[1]))]
        aa = [dict(r) for x in ss for r in db.execute("SELECT * FROM %s WHERE session_id=?" % at, (x["id"],))]
        SAVED6[st] = (at, ss, aa)
        for x in ss:
            db.execute("DELETE FROM %s WHERE session_id=?" % at, (x["id"],))
            db.execute("DELETE FROM %s WHERE id=?" % st, (x["id"],))
    HALF6 = db.execute("SELECT half FROM cycles WHERE id=?", (CID6,)).fetchone()[0]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID6,))   # BU CEO calibration is Year-End's (Mid-Year skips it)
    TB6 = [dict(r) for r in db.execute("SELECT * FROM talent_box_bu_locks WHERE cycle_id=? AND company IN (?,?)",
                                       (CID6, _free[0], _free[1]))]
    db.execute("DELETE FROM talent_box_bu_locks WHERE cycle_id=? AND company IN (?,?)", (CID6, _free[0], _free[1]))
    db.commit()
    J1, J2 = (_free + [None, None])[:2]
    _ppl = [r[0] for r in db.execute(
        "SELECT id FROM users WHERE business_group=? AND role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 "
        "AND COALESCE(bgceo_bg,'')='' AND id NOT IN (SELECT user_id FROM buceo_seats) AND COALESCE(company,'') NOT IN "
        "(?,?) ORDER BY id LIMIT 2", (BG6, J1 or "", J2 or ""))]
    if len(_ppl) < 2:   # a group of just the two units (the CI fixture): people of theirs outside the KPI population
        _ppl += [r[0] for r in db.execute(
            "SELECT id FROM users WHERE business_group=? AND role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 "
            "AND COALESCE(bgceo_bg,'')='' AND id NOT IN (SELECT user_id FROM buceo_seats) AND id NOT IN (SELECT "
            "subject_id FROM pm_kpi_targets WHERE cycle_id=?) ORDER BY id DESC LIMIT ?", (BG6, CID6, 2 - len(_ppl)))]
    LEAD6, MEM6 = _ppl
    SEATS6 = [(r[0], r[1], r[2]) for r in db.execute(
        "SELECT business_group, company, user_id FROM buceo_seats WHERE business_group=? AND company IN (?,?)",
        (BG6, J1, J2))]
s.check("fixture: two units nobody has started calibrating, and two BU CEOs", J1 and J2 and LEAD6 and MEM6,
        (J1 is not None, J2 is not None))
C_LEAD = H.client_as(a, LEAD6)
C_MEM = H.client_as(a, MEM6)
_real_breaches = a._pm_calib_lock_breaches
try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM buceo_seats WHERE business_group=? AND company IN (?,?)", (BG6, J1, J2))
        db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?),(?,?,?)",
                   (BG6, J1, LEAD6, BG6, J2, MEM6))
        for uid_ in {LEAD6, MEM6} | {x[2] for x in SEATS6}:
            a._sync_buceo_primary(db, uid_)
        db.commit()
    s.check("a BG admin can't open the page", C_BG.get("/admin/calibration/joins").status_code == 403)
    pg = C_SU.get("/admin/leaders?tab=buceo&bg=%s" % BG6)   # the join form moved onto Leaders > BU CEOs (2026-10-26)
    s.check("the super admin's Leaders > BU CEOs lists the units with who calibrates them", pg.status_code == 200
            and "Who calibrates them" in pg.get_data(as_text=True))
    jp = lambda **kw: C_SU.post("/admin/calibration/joins", data=dict(csrf_token="tok", action="join",
                                                                       business_group=BG6, **kw))
    jp(company=[J1], lead=J1)
    s.check("one unit alone isn't joined", H.one(a, "SELECT COUNT(*) FROM calib_unit_joins WHERE cycle_id=?", (CID6,)) == 0)
    jp(company=[J1, J2], lead="")
    s.check("...nor with nobody chosen to calibrate them",
            H.one(a, "SELECT COUNT(*) FROM calib_unit_joins WHERE cycle_id=?", (CID6,)) == 0)
    jp(company=[J1, J2], lead=J1, curve_of="ZZ NOT TICKED")
    s.check("...nor following the PAT of a unit that isn't ticked",
            H.one(a, "SELECT COUNT(*) FROM calib_unit_joins WHERE cycle_id=?", (CID6,)) == 0)
    pg_ = C_SU.get("/admin/leaders?tab=buceo&bg=%s" % BG6).get_data(as_text=True)
    s.check("the form asks whose PAT they follow, and offers only the ticked units' BU CEOs and curves",
            "Whose PAT curve they follow" in pg_ and 'name="curve_of"' in pg_ and pg_.count('data-co="%s"' % J1) == 2
            and "narrow(lead, on)" in pg_ and "narrow(curve, on)" in pg_)
    jp(company=[J1, J2], lead=J1)
    with a.app.test_request_context("/"):
        db = a.get_db()
        j = a.calib_join(db, CID6, BG6, J2)
    s.check("joined: either unit finds the join, the chosen unit leads", j and j["lead"] == J1
            and sorted(j["members"]) == sorted([J1, J2]))
    s.check("...and the join is logged, with whose PAT it follows (none sent: the lead's)",
            H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='calib_join' AND detail LIKE ?",
                  ("%" + BG6 + "%following the PAT curve of " + J1 + "%",)) >= 1
            and j and j.get("curve_of") == J1
            and H.one(a, "SELECT COUNT(*) FROM calib_unit_joins WHERE cycle_id=? AND curve_of=?", (CID6, J1)) == 2)
    with a.app.test_request_context("/"):
        db = a.get_db()
        uL = db.execute("SELECT * FROM users WHERE id=?", (LEAD6,)).fetchone()
        uM = db.execute("SELECT * FROM users WHERE id=?", (MEM6,)).fetchone()
        ctxL = a._pm_calib_resolve(db, uL, "buceo", bg=BG6, company=J1)
        ctxM = a._pm_calib_resolve(db, uM, "buceo", bg=BG6, company=J2)
        period = a.active_pm_period(db)
        want = {r[0] for r in db.execute("SELECT id FROM users WHERE business_group=? AND company IN (?,?) AND "
                                         "role!='admin' AND " + a.pm_calibration_population_sql(),
                                         (BG6, J1, J2, period["id"]))}
        s.check("the lead's BU CEO calibrates both units' people as one population (an independent count)",
                {p["id"] for p in ctxL["population"]} == want and ctxL["scope_key"] == J1 and not ctxL.get("read_only"),
                (len(ctxL["population"]), len(want)))
        s.check("the other unit's BU CEO reaches the same population, read only",
                {p["id"] for p in ctxM["population"]} == want and ctxM.get("read_only") is True)
        cv = a.pm_curve_for_scope(db, ctxL)
        exp = a.pm_curve_for(db, CID6, BG6, J1)["dist"]
        s.check("one population, one curve: the PAT curve of the unit picked (the lead's here), never a blend (Chris, "
                "2026-10-20)", cv["dist"] == exp and cv.get("scope") == "joined" and cv.get("follows") == J1
                and [e["company"] for e in cv["joined"] if e["followed"]] == [J1], (cv["dist"], exp))
        db.execute("UPDATE calib_unit_joins SET curve_of=? WHERE cycle_id=? AND business_group=?", (J2, CID6, BG6))
        a._req_cache().clear()
        ctx2 = a._pm_calib_resolve(db, uL, "buceo", bg=BG6, company=J1)
        cv2 = a.pm_curve_for_scope(db, ctx2)
        s.check("...and follows the other unit's PAT when that is the one picked",
                cv2["dist"] == a.pm_curve_for(db, CID6, BG6, J2)["dist"] and cv2.get("follows") == J2
                and (a.display_company(BG6, J2) or J2) in cv2["label"], cv2.get("label"))
        db.execute("UPDATE calib_unit_joins SET curve_of=? WHERE cycle_id=? AND business_group=?", (J1, CID6, BG6))
        db.commit()
        a._req_cache().clear()
        # a move: the read-only BU CEO is refused; the lead's lands on the person's own unit
        subj = next(p for p in ctxL["population"] if p["company"] == J2 and p["id"] not in (LEAD6, MEM6))
        _s, err = a._pm_calib_apply(db, uM, ctxM, "buceo", subj["id"], "OU", "")
        s.check("the other unit's BU CEO can't move anyone", _s is None and "calibrates" in (err or ""))
        _s, err = a._pm_calib_apply(db, uL, ctxL, "buceo", subj["id"], "OU", "")
        db.commit()
        s.check("the lead's move is saved", _s is not None and err is None, err)
    s.check("...on the person's own unit's session, where every reader looks",
            H.one(a, "SELECT s.scope_key FROM pm_calibration_adjustments a JOIN pm_calibration_sessions s ON "
                     "s.id=a.session_id WHERE s.cycle_id=? AND s.tier='buceo' AND a.subject_id=?", (CID6, subj["id"])) == J2)
    with a.app.test_request_context("/"):
        db = a.get_db()
        uL = db.execute("SELECT * FROM users WHERE id=?", (LEAD6,)).fetchone()
        ctxL = a._pm_calib_resolve(db, uL, "buceo", bg=BG6, company=J1)
        ov = a._pm_calib_assist_overview(db, uL, ctxL, "buceo", {"bg": BG6, "company": J1})["data"]
        row = next(r for r in ov["rows"] if r["id"] == subj["id"])
        s.check("the joined curve's roster shows the move, with each person's unit for the card's lens",
                row["current_band"] == "OU" and row["unit"] == J2 and ov["join"]
                and sorted(x["company"] for x in ov["join"]["units"]) == sorted([J1, J2]))
        ok, why = a._join_unit_state(db, CID6, BG6, J2)
        s.check("a unit whose BU CEO has started can't be joined again", not ok and "started" in why, why)
        # potential: the same population, scope and read-only rule
        sc_pop = a._pot_scope_population(db, "buceo", (BG6, J2))
        tier, key, pctx = a._pot_calib_sc(db, CID6, "buceo", (BG6, J2), sc_pop)
        s.check("potential: one population, scoped to the lead unit",
                {p["company"] for p in sc_pop} <= {J1, J2} and len({p["company"] for p in sc_pop}) == 2
                and pctx["scope_key"] == J1 and pctx.get("join"))
        s.check("the Talent Box counts the joined units as one, under the lead",
                a._tb_unit_key({"cycle_id": CID6, "business_group": BG6, "period": {"id": CID6}}, J2) == J1
                and " and " in a._talent_box_bu_label(BG6, J1))
    js = open(os.path.join(a.APP_DIR, "static", "journey_chat.js")).read()
    s.check("the card's unit lens (labelled BU, 2026-10-17) and read-only state are drawn", 'grPillRow("BU"' in js
            and "d.join.read_only" in js and "function calJoinUnit" in js)
    # one lock for both units (the curve rule set aside: this checks the lock, not the spread)
    a._pm_calib_lock_breaches = lambda *_a, **_k: {}
    r = C_MEM.post("/performance/calibration/company/%s/%s/lock" % (BG6, J2), data={"csrf_token": "tok", "ajax": "1"})
    s.check("the other unit's BU CEO can't lock them", "calibrates" in r.get_data(as_text=True) and not H.one(
        a, "SELECT COUNT(*) FROM pm_calibration_sessions WHERE cycle_id=? AND tier='buceo' AND scope_key IN (?,?) AND "
           "locked_at IS NOT NULL", (CID6, J1, J2)))
    r = C_LEAD.post("/performance/calibration/company/%s/%s/lock" % (BG6, J1), data={"csrf_token": "tok", "ajax": "1"})
    s.check("the lead's one lock locks both units", H.one(
        a, "SELECT COUNT(*) FROM pm_calibration_sessions WHERE cycle_id=? AND tier='buceo' AND scope_key IN (?,?) AND "
           "locked_at IS NOT NULL", (CID6, J1, J2)) == 2, r.get_data(as_text=True)[:200])
    with a.app.test_request_context("/"):
        db = a.get_db()
        sub = db.execute("SELECT * FROM users WHERE id=?", (subj["id"],)).fetchone()
        eb = a.pm_effective_band(db, sub, CID6, "ME")
    s.check("...and the move counts for the person, read by their own unit", eb["band"] == "OU" and eb["source"] == "buceo",
            eb)
    C_SU.post("/admin/calibration/joins", data={"csrf_token": "tok", "action": "separate", "business_group": BG6,
                                                 "lead": J1})
    s.check("locked units can't be separated this cycle",
            H.one(a, "SELECT COUNT(*) FROM calib_unit_joins WHERE cycle_id=? AND lead=?", (CID6, J1)) == 2)
    pg = C_SU.get("/admin/calibration/locks?fbg=%s" % BG6).get_data(as_text=True)
    s.check("Lock status shows the joined units as one BU CEO scope", "together this cycle" in pg)
finally:
    a._pm_calib_lock_breaches = _real_breaches
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM calib_unit_joins WHERE cycle_id=? AND business_group=?", (CID6, BG6))
        for st, (at, ss, aa) in SAVED6.items():   # back exactly as they were
            for (i,) in db.execute("SELECT id FROM %s WHERE cycle_id=? AND tier='buceo' AND scope_key IN (?,?)"
                                   % st, (CID6, J1, J2)).fetchall():
                db.execute("DELETE FROM %s WHERE session_id=?" % at, (i,))
                db.execute("DELETE FROM %s WHERE id=?" % st, (i,))
            for row in ss + []:
                db.execute("INSERT INTO %s(%s) VALUES (%s)" % (st, ",".join(row), ",".join("?" * len(row))),
                           list(row.values()))
            for row in aa:
                db.execute("INSERT INTO %s(%s) VALUES (%s)" % (at, ",".join(row), ",".join("?" * len(row))),
                           list(row.values()))
        db.execute("UPDATE cycles SET half=? WHERE id=?", (HALF6, CID6))
        db.execute("DELETE FROM talent_box_bu_locks WHERE cycle_id=? AND company IN (?,?)", (CID6, J1, J2))
        for row in TB6:
            db.execute("INSERT INTO talent_box_bu_locks(%s) VALUES (%s)" % (",".join(row), ",".join("?" * len(row))),
                       list(row.values()))
        db.execute("DELETE FROM buceo_seats WHERE business_group=? AND company IN (?,?)", (BG6, J1, J2))
        for bg_, co_, uid_ in SEATS6:
            db.execute("INSERT OR REPLACE INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)",
                       (bg_, co_, uid_))
        for uid_ in {LEAD6, MEM6} | {x[2] for x in SEATS6}:
            a._sync_buceo_primary(db, uid_)
        db.execute("DELETE FROM activity_log WHERE action IN ('calib_join','calib_separate','pm_calibration_adjust',"
                   "'pm_calibration_lock') AND user_id IN (?,?,?)", (SU["id"], LEAD6, MEM6))
        for tid_ in SEEDED6:   # the fixture's KPI lines this section added
            db.execute("DELETE FROM pm_kpi_targets WHERE id=?", (tid_,))
        db.commit()


# ---------------------------------------------------------------------------
# Row 7: the Group Chief calls both axes; the super admin decides each final band on both (Final bands' Performance |
# Potential switch); the Group Chief demo persona.
s.section("potential: the Group Chief's locked call, the blend rule, the super admin's final band")
with a.app.test_request_context("/"):
    db = a.get_db()
    CID7 = a.active_cycle_id(db)
    HALF7 = db.execute("SELECT half FROM cycles WHERE id=?", (CID7,)).fetchone()[0]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID7,))   # group calls are Year-End's
    db.commit()
    cand = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 AND "
                      "id NOT IN (SELECT subject_id FROM pm_calibration_group_members) ORDER BY id LIMIT 400").fetchall()
    with_band = [p for p in cand if a.effective_band(db, p, CID7).get("band")][:3]
    CHIEF7 = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 AND id "
                        "NOT IN (%s) ORDER BY id DESC LIMIT 1" % ",".join(str(p["id"]) for p in with_band) if with_band
                        else "SELECT * FROM users WHERE 0").fetchone()
s.check("fixture: three people with a potential band and a Group Chief", len(with_band) == 3 and CHIEF7 is not None)
P7 = with_band[0]
GID7 = None
try:
    with a.app.test_request_context("/"):
        db = a.get_db()
        GID7 = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES (?,?)",
                          ("ZZ Row7 Group", CHIEF7["id"])).lastrowid
        for p in with_band:
            db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id) VALUES (?,?)", (GID7, p["id"]))
        db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?,?)",
                   ("calib_group_mode:%s" % GID7, '{"mode": "after", "bg": 50}'))
        db.commit()
        came = a.effective_band(db, P7, CID7).get("band")
        other = next(b for b in a.TALENT_POTENTIAL_ORDER if b != came)
        sess = a._get_or_create_calibration_session(db, CID7, "group", str(GID7), P7["business_group"], "ZZ Row7 Group")
        a._calibration_upsert_adjustment(db, sess["id"], P7["id"], came, other, "", CHIEF7["id"])
        db.commit()
        s.check("an unlocked Group Chief call doesn't count yet", a.effective_band(db, P7, CID7).get("band") == came)
        a._group_lock_pot(db, CHIEF7, {"period": {"id": CID7}, "business_group": P7["business_group"],
                                       "scope_label": "ZZ Row7 Group"}, GID7, P7)
        db.commit()
        eb = a.effective_band(db, P7, CID7)
        s.check("locked person by person, it counts (the Group Chief comes after the BG CEO)",
                eb.get("band") == other and eb.get("source") == "group", eb.get("source"))
        a._group_lock_pot(db, CHIEF7, {"period": {"id": CID7}, "business_group": with_band[1]["business_group"],
                                       "scope_label": "ZZ Row7 Group"}, GID7, with_band[1])
        db.commit()
        s.check("locking someone the Group Chief didn't move keeps the band that came up, explicitly",
                H.one(a, "SELECT band FROM pot_group_locks WHERE group_id=? AND subject_id=?",
                      (GID7, with_band[1]["id"])) == a.effective_band(db, with_band[1], CID7, skip_tiers=("group",)).get("band"))
        db.execute("UPDATE app_settings SET value=? WHERE key=?", ('{"mode": "blend", "bg": 50}', "calib_group_mode:%s" % GID7))
        db.commit()
    with a.app.test_request_context("/"):
        db = a.get_db()
        s.check("a blend only suggests: the BG CEO's call stands until the super admin decides",
                a.effective_band(db, P7, CID7).get("band") == came)
        sug = a.calib_suggest(came, other, a.calib_group_mode(GID7), order=a.TALENT_POTENTIAL_ORDER)
        s.check("the suggestion reads the potential bands (Low / Mid / High)", sug[0] in a.TALENT_POTENTIAL_ORDER or
                (sug[1] and " or " in sug[1]), sug)
    pg = C_SU.get("/admin/calibration/final-bands?g=%d&axis=pot" % GID7)
    body = pg.get_data(as_text=True)
    s.check("Final bands has a Potential side, listing the scope", pg.status_code == 200 and ">Potential<" in body
            and 'value="pot"' in body and "Low" in body)
    C_SU.post("/admin/calibration/final-bands", data={"csrf_token": "tok", "action": "decide", "g": str(GID7),
                                                       "axis": "pot", "subject_id": str(P7["id"]), "band": "High",
                                                       "remark": "Row 7 check"})
    with a.app.test_request_context("/"):
        db = a.get_db()
        eb = a.effective_band(db, P7, CID7)
        s.check("the super admin's final potential band wins over every tier", eb.get("band") == "High"
                and eb.get("source") == "super", eb)
        rr = db.execute("SELECT pot_super_band, pot_final_band, pot_final_source FROM rating_records WHERE cycle_id=? "
                        "AND subject_id=?", (CID7, P7["id"])).fetchone()
        s.check("...and the rating record keeps it", rr and rr["pot_super_band"] == "High" and rr["pot_final_band"] == "High",
                dict(rr) if rr else None)
    C_SU.post("/admin/calibration/final-bands", data={"csrf_token": "tok", "action": "clear", "g": str(GID7),
                                                       "axis": "pot", "subject_id": str(P7["id"]), "remark": "Row 7 clear"})
    with a.app.test_request_context("/"):
        db = a.get_db()
        s.check("Clear takes it back to the calibrated band", a.effective_band(db, P7, CID7).get("source") != "super")
    js = open(os.path.join(a.APP_DIR, "static", "journey_chat.js")).read()
    s.check("the Group Chief's card has the 9-box and a potential call per person",
            "function grNineBox" in js and "function grSetPot" in js and "d.pot_bands" in js)
    s.check("the Group Chief is a demo persona, before the HR admin",
            a.DEMO_PERSONA_ORDER.index("groupchief") < a.DEMO_PERSONA_ORDER.index("admin")
            and a.DEMO_PERSONA_LABELS.get("groupchief") == "Group Chief")
    s.check("the demo seeder is synthetic-only and dry-runs by default",
            os.path.exists(os.path.join(H.REPO, "deploy", "demo", "seed_chbm_group_chief.py"))
            and "NOT LIKE 'ZZ%'" in open(os.path.join(H.REPO, "deploy", "demo", "seed_chbm_group_chief.py")).read())
finally:
    with a.app.app_context():
        db = a.get_db()
        if GID7:
            for st, at in (("calibration_sessions", "calibration_adjustments"),
                           ("pm_calibration_sessions", "pm_calibration_adjustments")):
                for (i,) in db.execute("SELECT id FROM %s WHERE cycle_id=? AND tier='group' AND scope_key=?" % st,
                                       (CID7, str(GID7))).fetchall():
                    db.execute("DELETE FROM %s WHERE session_id=?" % at, (i,))
                    db.execute("DELETE FROM %s WHERE id=?" % st, (i,))
            db.execute("DELETE FROM pot_group_locks WHERE group_id=?", (GID7,))
            db.execute("DELETE FROM pm_calibration_group_members WHERE group_id=?", (GID7,))
            db.execute("DELETE FROM pm_calibration_groups WHERE id=?", (GID7,))
            db.execute("DELETE FROM app_settings WHERE key=?", ("calib_group_mode:%s" % GID7,))
        for (i,) in db.execute("SELECT id FROM calibration_sessions WHERE cycle_id=? AND tier='super'", (CID7,)).fetchall():
            db.execute("DELETE FROM calibration_adjustments WHERE session_id=? AND justification LIKE 'Row 7%'", (i,))
        db.execute("UPDATE cycles SET half=? WHERE id=?", (HALF7, CID7))
        db.execute("DELETE FROM activity_log WHERE detail LIKE '%Row 7 check%'")
        db.commit()


# ---------------------------------------------------------------------------
# Row 8: roles -- the Users list's Role row and column menus, the person page's Group Chief, the roster's seat columns
s.section("People > Users: a Role row, Unit and Department menus that filter every page")
with a.app.app_context():
    db = a.get_db()
    BG8 = BGA["admin_bg"]
    base8 = "role!='admin' AND left_at IS NULL AND business_group=?"
    n_lm = db.execute("SELECT COUNT(*) FROM users u WHERE " + base8 + " AND EXISTS (SELECT 1 FROM users x WHERE "
                      "x.manager_id=u.id AND x.left_at IS NULL AND x.role!='admin')", (BG8,)).fetchone()[0]
    two_units = [r[0] for r in db.execute("SELECT company, COUNT(*) FROM users WHERE " + base8 + " AND "
                                          "COALESCE(company,'')!='' GROUP BY company ORDER BY 2 DESC LIMIT 2", (BG8,))]
    n_two = db.execute("SELECT COUNT(*) FROM users WHERE " + base8 + " AND company IN (?,?)",
                       (BG8, two_units[0], two_units[1])).fetchone()[0]
code, n = count_people(C_SU, "/admin/users?fbg=%s&role=lm" % BG8)
s.check("Role 'Line managers' lists everyone who has a direct report (an independent count)", code == 200 and n == n_lm,
        (n, n_lm))
from urllib.parse import urlencode as _ue
code, n = count_people(C_SU, "/admin/users?" + _ue([("fbg", BG8), ("unit", two_units[0]), ("unit", two_units[1])]))
s.check("the Unit menu ticks two units and lists both, across every page", code == 200 and n == n_two, (n, n_two))
pg = C_SU.get("/admin/users?" + _ue([("fbg", BG8), ("role", "lm"), ("unit", two_units[0])])).get_data(as_text=True)
s.check("the table has Unit and Department columns, each with its menu, and a Role row with counts",
        'name="unit"' in pg and 'name="dept_f"' in pg and ">Line managers<" in pg and "adm-colf" in pg)
s.check("...a chip says what each role means ('N direct reports')", "direct report" in pg and "adm-role is-lm" in pg)
s.check("...the page has no Download now (it moved to Reports, 4 Nov 2026); the role pick stays in its own links",
        "role=lm" in pg and "export/users" not in pg and "Download this list" not in pg)

s.section("the person page: Group Chief, set through one writer")
with a.app.app_context():
    db = a.get_db()
    pp = db.execute("SELECT id FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 "
                    "ORDER BY id LIMIT 2").fetchall()
    GA8, GB8 = pp[0][0], pp[1][0]
    GID8 = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZ Row8 Group', ?)", (GA8,)).lastrowid
    db.commit()
try:
    pg = C_SU.get("/admin/users/%d" % GB8).get_data(as_text=True)
    s.check("their roles card offers 'Make Group Chief of...' with who calls it now", "Make Group Chief of" in pg
            and 'name="action" value="set_gc"' in pg)
    C_SU.post("/admin/users/%d/lines" % GB8, data={"csrf_token": "tok", "action": "set_gc", "group_id": str(GID8)})
    s.check("making them Group Chief hands the group over, logged",
            H.one(a, "SELECT calibrator_id FROM pm_calibration_groups WHERE id=?", (GID8,)) == GB8
            and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_calib_group_chief' AND target_user_id=?",
                      (GB8,)) >= 1)
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id) VALUES (?,?)", (GID8, GA8))
        db.commit()
    C_SU.post("/admin/users/%d/lines" % GA8, data={"csrf_token": "tok", "action": "set_gc", "group_id": str(GID8)})
    s.check("someone in the group can't call it (nobody calls their own band)",
            H.one(a, "SELECT calibrator_id FROM pm_calibration_groups WHERE id=?", (GID8,)) == GB8)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_calibration_group_members WHERE group_id=?", (GID8,))
        db.execute("DELETE FROM pm_calibration_groups WHERE id=?", (GID8,))
        db.execute("DELETE FROM activity_log WHERE action='pm_calib_group_chief' AND target_user_id IN (?,?)", (GA8, GB8))
        db.commit()

s.section("the roster's seat columns: listed before Apply, applied through the Leaders writers")
with a.app.app_context():
    db = a.get_db()
    SP8 = db.execute("SELECT * FROM users WHERE business_group=? AND role!='admin' AND left_at IS NULL AND "
                     "COALESCE(is_demo,0)=0 AND id NOT IN (SELECT user_id FROM buceo_seats) AND COALESCE(bgceo_bg,'')='' "
                     "ORDER BY id DESC LIMIT 1", (BG8,)).fetchone()
    U8 = [r[0] for r in db.execute("SELECT company FROM org_units WHERE business_group=? AND active=1 ORDER BY company "
                                   "LIMIT 2", (BG8,))]
    SEAT8 = [(r[0], r[1], r[2]) for r in db.execute(
        "SELECT business_group, company, user_id FROM buceo_seats WHERE business_group=? AND company IN (?,?)",
        (BG8, U8[0], U8[1]))]


def _seat_row(units):
    return _row(**{_cols["employee id"]: SP8["employee_id"], _cols["employee name"]: SP8["full_name"],
                   _cols["business group"]: SP8["business_group"], _cols["company"]: SP8["company"] or "",
                   _cols["bu ceo of"]: units})


def _upload(client, rows):
    r_ = client.post("/admin/import/roster", data={"csrf_token": "tok", "mode": "upsert", "preview": "1",
                                                    "file": (io.BytesIO(_roster_csv(rows)), "seats.csv")},
                     content_type="multipart/form-data")
    loc_ = r_.headers.get("Location", "")
    return loc_.split("check=")[-1] if "check=" in loc_ else ""


try:
    t8 = _upload(C_SU, [_seat_row("; ".join(U8))])
    pg = _past_quality(C_SU, t8)
    s.check("the check lists the role change, and who loses a seat", "Role changes" in pg and "BU CEO of" in pg
            and ("Adds:" in pg or "A seat the file gives to someone else" in pg))
    _apply(C_SU, t8)
    s.check("Apply gives them both units, through the Leaders writers",
            sorted(r[0] for r in H.rows(a, "SELECT company FROM buceo_seats WHERE user_id=?", (SP8["id"],)))
            == sorted(U8))
    t8 = _upload(C_SU, [_seat_row("NONE")])
    _past_quality(C_SU, t8)
    _apply(C_SU, t8)
    s.check("NONE takes the seats away", not H.rows(a, "SELECT 1 FROM buceo_seats WHERE user_id=?", (SP8["id"],)))
    t8 = _upload(C_SU, [_seat_row("ZZ No Such Unit")])
    pg = C_SU.get("/admin/import/roster?check=" + t8).get_data(as_text=True)
    s.check("a unit that isn't in their business group stops the file", "isn&#39;t a unit in" in pg
            and re.search(r'class="primary"\s+disabled>Continue', pg) is not None)
    # BG and unit admins are view only since 2026-10-19: their file is refused before it is read
    r8 = C_BG.post("/admin/import/roster", data={"csrf_token": "tok", "mode": "upsert", "preview": "1", "file": (
        io.BytesIO(b"Employee ID\n"), "r.csv")}, content_type="multipart/form-data")
    s.check("a BG admin can't import a roster (view only, Chris 2026-10-19)", r8.status_code == 403, r8.status_code)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM buceo_seats WHERE user_id=?", (SP8["id"],))
        db.execute("DELETE FROM buceo_seats WHERE business_group=? AND company IN (?,?)", (BG8, U8[0], U8[1]))
        for bg_, co_, uid_ in SEAT8:
            db.execute("INSERT OR REPLACE INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)",
                       (bg_, co_, uid_))
        for uid_ in {SP8["id"]} | {x[2] for x in SEAT8}:
            a._sync_buceo_primary(db, uid_)
        db.execute("UPDATE users SET job_title=? WHERE id=?", (SP8["job_title"], SP8["id"]))
        db.commit()

# --- The June-2026 units come back only where their group still has people (2026-10-16): staging renamed its demo
# groups to made-up names, and the startup migration was re-adding the real group's unit on every restart.
import shutil  # noqa: E402
import sqlite3  # noqa: E402
_CHBM, _CHGB = "CHIN HIN BUILDING MATERIAL (CHBM)", "CHIN HIN GROUP BERHAD"
_tmp = a.DB_PATH.replace(".db", "-orgguard.db")
assert H.SCRATCH_MARKER in _tmp
shutil.copy(a.DB_PATH, _tmp)
_con = sqlite3.connect(_tmp)
_chgb_people = _con.execute("SELECT COUNT(*) FROM users WHERE business_group=? AND role!='admin' AND left_at IS NULL",
                            (_CHGB,)).fetchone()[0]
_con.execute("UPDATE users SET business_group='ZZ Renamed Group' WHERE business_group=?", (_CHBM,))
_con.execute("DELETE FROM org_units WHERE (business_group=? AND company='GREEN CEMENT SDN BHD') OR "
             "(business_group=? AND company='MUAFAKAT LANCAR SDN BHD')", (_CHBM, _CHGB))
_con.commit()
_con.close()
_old = a.DB_PATH
a.DB_PATH = _tmp
try:
    a._ensure_runtime_schema()
finally:
    a.DB_PATH = _old
_con = sqlite3.connect(_tmp)
_n = lambda bg, co: _con.execute("SELECT COUNT(*) FROM org_units WHERE business_group=? AND company=?", (bg, co)).fetchone()[0]
s.check("a group with nobody left in it doesn't get its June-2026 unit back on start-up",
        _n(_CHBM, "GREEN CEMENT SDN BHD") == 0, _n(_CHBM, "GREEN CEMENT SDN BHD"))
s.check("a group with people still gets it (the copy has %d in CHGB)" % _chgb_people,
        _chgb_people > 0 and _n(_CHGB, "MUAFAKAT LANCAR SDN BHD") == 1, (_chgb_people, _n(_CHGB, "MUAFAKAT LANCAR SDN BHD")))
_con.close()
os.remove(_tmp)

sys.exit(s.done())
