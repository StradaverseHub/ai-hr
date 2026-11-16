"""The rating record (Chris, 2026-09-28: "For rating and band, should we also save it, as for admin later, they will
need to view it or generate a report or export in excel on these info").

One row per person per cycle (rating_records) holding every score and band as it stood at the last sign-off / lock,
rebuilt by ONE builder (_rating_record_refresh) at each of them, frozen when the cycle is archived. The admin page
(/admin/reports/ratings), Capture and the Excel export (/admin/export/ratings.xlsx) read it.

Writes rows, so a fresh copy.
"""
import inspect
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Rating record -- saved scores and bands, the admin report and the Excel export")

BG = "ZZRR Group"
CO = "ZZRR Co"
EVIL = '=HYPERLINK("http://x")Test'

# ---------------------------------------------------------------------------
s.section("build: an isolated subject with two 5-point KPI lines, both HR-locked")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    # the BU CEO's and BG CEO's tiers count at Year-End only (Mid-Year is Self, LM and HOD, 2026-10-12)
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.commit()
    HOD = db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                     "company, department, job_title, job_grade) VALUES ('zzrr-hod','ZZRR Hod','x','user',"
                     "'ZZRRH-1',?,?, 'Ops', 'Head', 20)", (BG, CO)).lastrowid
    SUBJ = db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                      "company, department, job_title, job_grade, hod_id) VALUES ('zzrr-1',?,'x','user',"
                      "'ZZRR-1',?,?, 'Ops', 'Planner', 14, ?)", (EVIL, BG, CO, HOD)).lastrowid
    if not db.execute("SELECT 1 FROM pm_bg_config WHERE business_group=?", (BG,)).fetchone():
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))

    def kpi(name, rates, actual):
        tid = db.execute(
            "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
            "company, rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?,50,'more','approved',?,?,?,?,?,?,?)",
            (CID, SUBJ, name, BG, CO) + tuple(rates)).lastrowid
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft, admin_filled) "
                   "VALUES (?,?,?,0,1)", (tid, actual, SUBJ))
        return tid

    kpi("ZZRR Gross Profit", (9, 11, 12, 13, 15), 15)      # rung 5
    kpi("ZZRR Deliveries", (1, 2, 3, 4, 5), 3)              # rung 3
    db.commit()
    SU, BGA, _EMP = H.actors(a)


def refresh(event="test"):
    with a.app.test_request_context("/"):
        db = a.get_db()
        n = a._rating_record_refresh(db, CID, [SUBJ], event, None, commit=True)
    return n


def rec():
    return H.rows(a, "SELECT * FROM rating_records WHERE cycle_id=? AND subject_id=?", (CID, SUBJ))


def live_band():
    with a.app.test_request_context("/"):
        db = a.get_db()
        subj = db.execute("SELECT * FROM users WHERE id=?", (SUBJ,)).fetchone()
        mgr = a.pm_final_overalls(db, CID, [SUBJ])[SUBJ]
        return mgr, a.pm_effective_band(db, subj, CID, mgr["label"])


# ---------------------------------------------------------------------------
s.section("the record holds the same figures the live screens compute")
s.check("a refresh writes one row", refresh() == 1 and len(rec()) == 1, len(rec()))
r = rec()[0]
mgr, eff = live_band()
# Independent check of the weighted overall: rung 5 and rung 3 at 50/50 -> 4.0.
s.check("the manager-approved overall is the weighted 1-5 figure (independently: (5+3)/2 = 4.0)",
        abs((r["pm_mgr_value"] or 0) - 4.0) < 1e-9 and abs(mgr["value"] - 4.0) < 1e-9, (r["pm_mgr_value"], mgr))
s.check("...and its band is the live band", r["pm_mgr_band"] == mgr["label"], (r["pm_mgr_band"], mgr["label"]))
s.check("the self figure covers all the weight", r["pm_weight_total"] == 100 and r["pm_weight_covered"] == 100,
        (r["pm_weight_total"], r["pm_weight_covered"]))
s.check("no calibration tier has locked -> every 'band after tier' is empty",
        all(r["pm_%s_band" % t] is None for t in ("hod", "buceo", "bgceo", "group", "super")), dict(r))
s.check("...and the final band is the manager's, decided by the line manager",
        r["pm_final_band"] == eff["band"] == mgr["label"] and r["pm_final_source"] == "raw", (r["pm_final_band"], eff))
s.check("identity is recorded as text, so a leaver's history survives", r["employee_id"] == "ZZRR-1"
        and r["business_group"] == BG and r["company"] == CO, (r["employee_id"], r["business_group"]))

# ---------------------------------------------------------------------------
s.section("calibration tiers: the band AFTER each tier, locked only, carried up")
with a.app.app_context():
    db = a.get_db()
    hs = db.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, "
                    "locked_at, locked_by) VALUES (?, 'hod', ?, ?, 'ZZRR Hod', datetime('now'), ?)",
                    (CID, str(HOD), BG, HOD)).lastrowid
    db.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band, "
               "justification, adjusted_by) VALUES (?,?,?,?, 'strong year', ?)", (hs, SUBJ, mgr["label"], "OU", HOD))
    bs = db.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label) "
                    "VALUES (?, 'buceo', ?, ?, ?)", (CID, CO, BG, CO)).lastrowid
    db.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band, "
               "justification, adjusted_by) VALUES (?,?,'OU','ME', 'still deciding', ?)", (bs, SUBJ, HOD))
    db.commit()
refresh("after hod lock")
r = rec()[0]
s.check("a LOCKED HOD move is recorded as the band after HOD", r["pm_hod_band"] == "OU", r["pm_hod_band"])
s.check("an UNLOCKED BU CEO session is not a decision yet (empty), even with a move in it",
        r["pm_buceo_band"] is None, r["pm_buceo_band"])
s.check("...and the final band follows the live cascade (HOD decides)",
        r["pm_final_band"] == "OU" and r["pm_final_source"] == "hod" and live_band()[1]["band"] == "OU",
        (r["pm_final_band"], r["pm_final_source"]))
with a.app.app_context():
    db = a.get_db()
    db.execute("DELETE FROM pm_calibration_adjustments WHERE session_id=?", (bs,))
    db.execute("UPDATE pm_calibration_sessions SET locked_at=datetime('now') WHERE id=?", (bs,))
    db.commit()
refresh("after buceo lock")
r = rec()[0]
s.check("a BU CEO lock that left them alone carries the band up (band after BU CEO = OU)",
        r["pm_buceo_band"] == "OU" and r["pm_bgceo_band"] is None, (r["pm_buceo_band"], r["pm_bgceo_band"]))
s.check("the provenance (tiers_json) says the HOD moved them, with the justification kept out of the columns",
        '"moved": true' in (r["tiers_json"] or "") and "strong year" in (r["tiers_json"] or ""), r["tiers_json"])

# ---------------------------------------------------------------------------
s.section("potential: the record matches subject_result / effective_band for someone with a real 360")
with a.app.test_request_context("/"):
    db = a.get_db()
    P = db.execute("SELECT subject_id, COUNT(*) n FROM assignments WHERE cycle_id=? AND status='submitted' "
                   "AND archived=0 GROUP BY subject_id ORDER BY n DESC LIMIT 1", (CID,)).fetchone()
    if P:
        a._rating_record_refresh(db, CID, [P["subject_id"]], "test", None, commit=True)
        psub = db.execute("SELECT * FROM users WHERE id=?", (P["subject_id"],)).fetchone()
        pres = a.subject_result(db, psub, CID)
        peff = a.effective_band(db, psub, CID)
        prr = db.execute("SELECT * FROM rating_records WHERE cycle_id=? AND subject_id=?",
                         (CID, P["subject_id"])).fetchone()
if P:
    s.check("the 360 average, raters submitted and computed band are subject_result's",
            prr["f360_avg"] == pres["avg_score"] and prr["f360_submitted"] == pres["submitted"]
            and prr["pot_raw_band"] == pres["band"], (prr["f360_avg"], pres["avg_score"], prr["pot_raw_band"]))
    s.check("...the combined potential score is combined_potential's",
            prr["pot_score"] == (pres.get("combined") or {}).get("score"), (prr["pot_score"], pres.get("combined")))
    s.check("...and the final potential band is effective_band's", prr["pot_final_band"] == peff.get("band")
            and prr["pot_final_source"] == peff.get("source"), (prr["pot_final_band"], peff))
else:
    s.check("the fixture has a subject with a submitted 360 (needed for the potential checks)", False)

# ---------------------------------------------------------------------------
s.section("every sign-off and lock writes the record (the hooks)")
# (every Unlock is _unlock_scope's since 2026-11-07, one writer for both axes: it refreshes the record, and the old unlock
# routes are its callers, checked below)
HOOKS = ["_review_do_confirm", "performance_kpi_submit_all", "_pm_moderate_commit", "_pm_calib_lock",
         "_unlock_scope", "_pm_super_set", "pm_calibration_override_clear", "_talent_box_lock",
         "calibration_hod_lock", "calibration_company_lock", "calibration_bg_lock",
         "calibration_bugroup_lock", "_feedback_submit", "_tc_submit",
         "_tc_approve_assessment"]
for fn in HOOKS:
    s.check("%s refreshes the rating record" % fn,
            "_rating_record_refresh(" in inspect.getsource(getattr(a, fn)), fn)
for fn in ("_pm_calib_unlock", "calibration_hod_unlock", "calibration_company_unlock", "calibration_bg_unlock",
           "calibration_bugroup_unlock"):
    s.check("%s unlocks through the one writer (which refreshes the rating record)" % fn,
            "_unlock_route(" in inspect.getsource(getattr(a, fn)) or "_unlock_scope(" in inspect.getsource(getattr(a, fn)), fn)
# the super tier has one write (2026-10-10): the calibration override and the Final bands queue both go through it
s.check("the super override and Final bands both write through _pm_super_set (which refreshes the record)",
        all("_pm_super_set(" in inspect.getsource(getattr(a, fn)) for fn in ("pm_calibration_override",
                                                                             "admin_final_bands")))
s.check("archiving a cycle (activate or create) freezes the outgoing cycle's record",
        inspect.getsource(a.admin_cycles).count("_rating_record_freeze(") >= 2)
s.check("the manager hook fires only once EVERY line is locked (the approved figure exists then)",
        "if pm_period_locked_for(db, target[\"cycle_id\"], target[\"subject_id\"]):"
        in inspect.getsource(a._pm_moderate_commit))

# ---------------------------------------------------------------------------
s.section("never blocks the lock that called it")
_real = a._rating_record_row
a._rating_record_row = lambda db, cid, subj: (_ for _ in ()).throw(TypeError("NULL threshold"))
try:
    with a.app.test_request_context("/"):
        _n = a._rating_record_refresh(a.get_db(), CID, [SUBJ], "boom", None)
    s.check("a builder error is swallowed (0 written, no exception)", _n == 0, _n)
finally:
    a._rating_record_row = _real

# ---------------------------------------------------------------------------
s.section("the admin page, scoping, Capture")
c = H.client_as(a, SU["id"])
pg = c.get("/admin/reports/ratings?cycle=%d" % CID)
s.check("a super admin sees the page with the recorded person", pg.status_code == 200 and b"ZZRR-1" in pg.data,
        pg.status_code)
if BGA is not None and (BGA["admin_bg"] or "") != BG:
    pb = H.client_as(a, BGA["id"]).get("/admin/reports/ratings?cycle=%d" % CID)
    s.check("a BG admin of another business group does NOT see them", pb.status_code == 200 and b"ZZRR-1" not in pb.data,
            pb.status_code)
    xb = H.client_as(a, BGA["id"]).get("/admin/export/ratings.xlsx?cycle=%d" % CID)
    s.check("...nor in their Excel export", xb.status_code == 200 and b"ZZRR-1" not in xb.data, xb.status_code)
pe = H.client_as(a, SUBJ).get("/admin/reports/ratings")
s.check("an employee cannot open it", pe.status_code in (302, 403, 404), pe.status_code)
with a.app.app_context():
    a.get_db().execute("DELETE FROM rating_records WHERE cycle_id=? AND subject_id=?", (CID, SUBJ))
    a.get_db().commit()
cp = c.post("/admin/reports/ratings/capture", data={"csrf_token": "tok", "cycle": CID, "bg": BG})
s.check("Capture records someone who was never recorded", cp.status_code == 302 and len(rec()) == 1
        and rec()[0]["last_event"] == "admin_capture", (cp.status_code, len(rec())))

# ---------------------------------------------------------------------------
s.section("the Excel export")
x = c.get("/admin/export/ratings.xlsx?cycle=%d" % CID)
s.check("a real .xlsx comes back", x.status_code == 200 and "spreadsheetml" in (x.headers.get("Content-Type") or ""),
        (x.status_code, x.headers.get("Content-Type")))
from openpyxl import load_workbook  # noqa: E402
wb = load_workbook(io.BytesIO(x.data))
ws = wb["Ratings record"]
hdr = [cell.value for cell in next(ws.iter_rows(min_row=1, max_row=1))]
s.check("it carries every column, starting with who and ending with the provenance",
        hdr[-len(a._RR_EXPORT_HEADER[len(a._RR_IDENT_COLS):]):] == a._RR_EXPORT_HEADER[len(a._RR_IDENT_COLS):]
        and "Employee ID" in hdr and "PM band after HOD" in hdr and "Potential final band" in hdr, hdr[:6])
i_eid, i_name = hdr.index("Employee ID"), hdr.index("Employee name")
mine = [[cell.value for cell in row] for row in ws.iter_rows(min_row=2) if row[i_eid].value == "ZZRR-1"]
s.check("the person's row is there with their bands", bool(mine) and "OU" in mine[0] and 4.0 in mine[0],
        mine[:1])
s.check("a name that looks like a formula is written as text, never a formula",
        bool(mine) and mine[0][i_name] == "'" + EVIL, mine[0][i_name] if mine else None)
s.check("an About sheet explains what it is", "About" in wb.sheetnames)

# ---------------------------------------------------------------------------
s.section("freeze: an archived cycle's record never moves again")
with a.app.app_context():
    db = a.get_db()
    a._rating_record_freeze(db, CID)
    db.commit()
before = dict(rec()[0])
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE pm_calibration_sessions SET locked_at=NULL WHERE id=?", (hs,))
    db.commit()
s.check("a refresh after freezing writes nothing", refresh("after freeze") == 0, None)
after = dict(rec()[0])
s.check("...and the frozen row is unchanged, though the live band has since fallen back",
        after["pm_hod_band"] == before["pm_hod_band"] == "OU" and after["frozen_at"], (before["pm_hod_band"], after))
cp2 = c.post("/admin/reports/ratings/capture", data={"csrf_token": "tok", "cycle": CID, "bg": BG})
s.check("Capture refuses to rewrite a frozen cycle", rec()[0]["pm_hod_band"] == "OU" and rec()[0]["last_event"]
        == before["last_event"], rec()[0]["last_event"])

with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
    db.commit()

sys.exit(s.done())
