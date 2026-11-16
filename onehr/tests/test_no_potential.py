"""A cycle with no potential result (Chris, 2026-10-14, for production's 2026 Mid-Year: "there won't be competency
result, so there won't be potential band and talent status for 2026 mid year, and only performance band is available").

cycles.no_potential = 1 (set by the super admin on Edit cycle, read through cycle_has_potential) takes every potential
band out of the cycle -- raw, calibrated or final -- and with it the talent status. The 360 itself stays: its scores,
its principles and its report. A switch rather than a data rule, because a cycle whose competency simply wasn't recorded
(the staging demo's past cycles) still has the potential its 360 gave it.

Checked on the suite database (shared, everything put back): the readers, the screens' flags, the Potential tab, Edit
cycle (super admin only, logged, the records follow), and the Mid-Year KPI import's refusal lives in
test_midyear_import.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A cycle with no potential result -- no potential band, no talent status, the 360 kept")
SU, BGA, EMP = H.actors(a)


def ctx():
    return a.app.test_request_context("/")


def setp(cid, v):
    with ctx():
        db = a.get_db()
        db.execute("UPDATE cycles SET no_potential=? WHERE id=?", (v, cid))
        db.commit()


# ---------------------------------------------------------------------------
s.section("the fixture: the active cycle, someone with a valid 360 and a band")
with ctx():
    db = a.get_db()
    ACID = a.active_cycle_id(db)
    ORIG = db.execute("SELECT no_potential FROM cycles WHERE id=?", (ACID,)).fetchone()[0]
    P = None
    for r in db.execute("SELECT u.* FROM users u JOIN assignments x ON x.subject_id=u.id WHERE x.cycle_id=? AND "
                        "x.status='submitted' AND x.archived=0 AND u.role!='admin' AND u.left_at IS NULL "
                        "GROUP BY u.id ORDER BY COUNT(*) DESC LIMIT 60", (ACID,)).fetchall():
        sb = a.subject_band(db, r, ACID)
        if sb["band"] and sb["score_valid"]:
            P = dict(r)
            break
    s.check("(someone on the active cycle has a valid 360 and a potential band)", P is not None)
    if P is None:
        sys.exit(s.done())
    res0 = a.subject_result(db, P, ACID)
    AVG0 = res0["avg_score"]
    s.check("before: combined_potential reads a source", (res0.get("combined") or {}).get("source") != "none",
            (res0.get("combined") or {}).get("source"))
    s.check("before: cycle_has_potential is True", a.cycle_has_potential(db, ACID) is True)
    s.check("before: a final potential result exists", a.final_result(db, P, ACID, "pot") is not None)
    # a band set by the super admin (never locked, always wins) -- the calibrated case the switch must also empty
    sess = db.execute("SELECT id FROM calibration_sessions WHERE cycle_id=? AND tier='super' AND scope_key=?",
                      (ACID, a.POT_SUPER_SCOPE_KEY)).fetchone()
    MADE_SESS = sess is None
    if MADE_SESS:
        db.execute("INSERT INTO calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label) "
                   "VALUES (?, 'super', ?, '', 'ZZ no-potential test')", (ACID, a.POT_SUPER_SCOPE_KEY))
        sess = db.execute("SELECT id FROM calibration_sessions WHERE cycle_id=? AND tier='super' AND scope_key=?",
                          (ACID, a.POT_SUPER_SCOPE_KEY)).fetchone()
    SESS = sess[0]
    OLD_ADJ = db.execute("SELECT original_band, adjusted_band FROM calibration_adjustments WHERE session_id=? AND "
                         "subject_id=?", (SESS, P["id"])).fetchone()
    SET_BAND = "High" if res0["band"] != "High" else "Low"
    db.execute("INSERT OR REPLACE INTO calibration_adjustments(session_id, subject_id, original_band, adjusted_band, "
               "justification, adjusted_by) VALUES (?,?,?,?,'ZZ test',?)",
               (SESS, P["id"], res0["band"], SET_BAND, SU["id"]))
    db.commit()
with ctx():
    db = a.get_db()
    eb = a.effective_band(db, P, ACID)
    s.check("before: the super admin's band counts (effective_band)", eb["band"] == SET_BAND and eb["source"] == "super",
            (eb["band"], eb["source"]))

# ---------------------------------------------------------------------------
s.section("the switch on: no potential band anywhere, the 360 kept")
setp(ACID, 1)
with ctx():
    db = a.get_db()
    s.check("cycle_has_potential reads False", a.cycle_has_potential(db, ACID) is False)
    s.check("...another cycle keeps its potential", all(a.cycle_has_potential(db, c[0]) for c in db.execute(
        "SELECT id FROM cycles WHERE id!=? AND COALESCE(no_potential,0)=0", (ACID,))))
    res = a.subject_result(db, P, ACID)
    s.check("the 360 score stays", res["avg_score"] == AVG0 and res["submitted"] == res0["submitted"],
            (res["avg_score"], AVG0))
    s.check("...with no potential band, and combined_potential reads 'none'",
            res["band"] is None and (res.get("combined") or {}).get("source") == "none",
            (res["band"], (res.get("combined") or {}).get("source")))
    sb = a.subject_band(db, P, ACID)
    s.check("subject_band: no band and no self band", sb["band"] is None and sb["self_band"] is None,
            (sb["band"], sb["self_band"]))
    eb = a.effective_band(db, P, ACID)
    s.check("effective_band: even the super admin's band is gone", eb["band"] is None and eb["source"] == "raw",
            (eb["band"], eb["source"]))
    s.check("final_result(pot) is None", a.final_result(db, P, ACID, "pot") is None)
    s.check("no talent status, even unreleased", a.talent_status_for(db, P, ACID, released_only=False) is None)
    rr = a._rating_record_row(db, ACID, P)
    pot_keys = ("pot_raw_band", "pot_final_band", "pot_self_band", "pot_super_band", "pot_hod_band", "pot_score")
    s.check("the rating record carries no potential band", all(rr.get(k) is None for k in pot_keys),
            {k: rr.get(k) for k in pot_keys})
    s.check("...but keeps the 360", rr.get("f360_avg") == AVG0 and rr.get("f360_submitted") == res0["submitted"])
    bi = a._report_band_info(db, P, ACID, {})
    s.check("the 360 report says 'none this cycle', not 'not released'", bi.get("pot_none") is True
            and not bi.get("pot_unreleased") and bi.get("band") is None, bi)
    cyc = db.execute("SELECT * FROM cycles WHERE id=?", (ACID,)).fetchone()
    rel = a._result_release_rows(db, cyc, cyc, [db.execute("SELECT * FROM users WHERE id=?", (P["id"],)).fetchone()])
    s.check("Release results: no potential to release", not rel or rel[0].get("pot") is None,
            rel and rel[0].get("pot"))
    row = a._dash_record_row(db, db.execute("SELECT * FROM users WHERE id=?", (P["id"],)).fetchone(), cyc, cyc)
    s.check("the record row is marked no_pot", row.get("no_pot") is True)

# the Potential review / calibration tab: a HOD with a valid-360 scope has it before, and loses it
_real_tier, _real_on = a.calibration_tier_of, a._calib_assist_on
with ctx():
    db = a.get_db()
    HOD = None
    for h in db.execute("SELECT hod_id FROM users WHERE hod_id IS NOT NULL AND role!='admin' GROUP BY hod_id "
                        "ORDER BY COUNT(*) DESC LIMIT 20").fetchall():
        if a._pot_scope_population(db, "hod", h[0]):
            HOD = h[0]
            break
    HODU = dict(db.execute("SELECT * FROM users WHERE id=?", (HOD,)).fetchone()) if HOD else None
    MODS = {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (ACID,))}
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key='calibration'", (ACID,))
    db.commit()
a.calibration_tier_of = lambda db, u: [("hod", HOD)] if HOD and u["id"] == HOD else []
a._calib_assist_on = lambda u: True
try:
    setp(ACID, ORIG)
    with ctx():
        before = a._pot_calib_scope(a.get_db(), HODU, fresh=True, tier="hod") if HODU else None
    setp(ACID, 1)
    with ctx():
        after = a._pot_calib_scope(a.get_db(), HODU, fresh=True, tier="hod") if HODU else "x"
    s.check("(a HOD has a Potential scope while the cycle has potential)", before is not None, HOD)
    s.check("...and none once it has no potential result", after is None)
finally:
    a.calibration_tier_of, a._calib_assist_on = _real_tier, _real_on
    with ctx():
        db = a.get_db()
        if "calibration" in MODS:
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key='calibration'",
                       (MODS["calibration"], ACID))
        else:
            db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='calibration'", (ACID,))
        db.commit()

# ---------------------------------------------------------------------------
s.section("Edit cycle: the super admin sets it, logged; the records follow")
setp(ACID, None)
with ctx():
    db = a.get_db()
    cyc0 = dict(db.execute("SELECT * FROM cycles WHERE id=?", (ACID,)).fetchone())
    HAD_RR = db.execute("SELECT 1 FROM rating_records WHERE cycle_id=? AND subject_id=?",
                        (ACID, P["id"])).fetchone() is not None
    a._rating_record_refresh(db, ACID, [P["id"]], "zz_test", commit=True)
    rr0 = db.execute("SELECT pot_final_band, f360_avg, frozen_at FROM rating_records WHERE cycle_id=? AND "
                     "subject_id=?", (ACID, P["id"])).fetchone()
s.check("(the record holds a potential band first)", rr0 is not None and rr0[0] is not None and rr0[2] is None,
        rr0 and tuple(rr0))
nxt = "/admin/cycle?cycle=%d" % ACID
base = {"csrf_token": "tok", "action": "edit_cycle", "cycle_id": str(ACID), "next": nxt,
        "name": cyc0["name"], "code": cyc0["code"], "year": str(cyc0["year"] or ""),
        "half": str(cyc0["half"] or ""), "starts_on": (cyc0["starts_on"] or "").replace(" ", "T"),
        "ends_on": (cyc0["ends_on"] or "").replace(" ", "T")}
n_log = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='cycle' AND detail LIKE '%potential band%'")
C_SU = H.client_as(a, SU["id"])
C_SU.post("/admin/cycles", data=dict(base, potential="0"))
s.check("Potential band None saves", H.one(a, "SELECT no_potential FROM cycles WHERE id=?", (ACID,)) == 1)
s.check("...logged as 'yes -> none'", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='cycle' AND detail "
                                            "LIKE '%potential band yes -> none%'") >= 1 and
        H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='cycle' AND detail LIKE '%potential band%'")
        == n_log + 1)
rr1 = H.rows(a, "SELECT pot_final_band, pot_raw_band, f360_avg FROM rating_records WHERE cycle_id=? AND subject_id=?",
             (ACID, P["id"]))[0]
s.check("...and the cycle's records follow at once: no potential band, the 360 kept",
        rr1[0] is None and rr1[1] is None and rr1[2] == rr0[1], tuple(rr1))
C_SU.post("/admin/cycles", data=dict(base))
s.check("a save without the field leaves it as it is", H.one(a, "SELECT no_potential FROM cycles WHERE id=?",
                                                             (ACID,)) == 1)
page = C_SU.get(nxt).get_data(as_text=True)
s.check("the Calendar says it, with the switch", "no competency ran" in page and 'name="potential"' in page)
C_SU.post("/admin/cycles", data=dict(base, potential="1"))
s.check("Potential band Yes puts it back", not H.one(a, "SELECT no_potential FROM cycles WHERE id=?", (ACID,)))
rr2 = H.rows(a, "SELECT pot_final_band FROM rating_records WHERE cycle_id=? AND subject_id=?", (ACID, P["id"]))[0]
s.check("...and the record's band comes back", rr2[0] is not None, tuple(rr2))
if BGA:
    r = H.client_as(a, BGA["id"]).post("/admin/cycles", data=dict(base, potential="0"))
    s.check("a BG admin can't set it", r.status_code == 403 and not H.one(
        a, "SELECT no_potential FROM cycles WHERE id=?", (ACID,)), r.status_code)
arch = H.rows(a, "SELECT id, name, code, no_potential FROM cycles WHERE archived_at IS NOT NULL LIMIT 1")
if arch:
    C_SU.post("/admin/cycles", data={"csrf_token": "tok", "action": "edit_cycle", "cycle_id": str(arch[0][0]),
                                     "name": arch[0][1], "code": arch[0][2], "potential": "0"})
    s.check("a past cycle reads only: the switch isn't saved",
            H.one(a, "SELECT no_potential FROM cycles WHERE id=?", (arch[0][0],)) == arch[0][3])

# ---------------------------------------------------------------------------
s.section("the screens")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dash = open(os.path.join(REPO, "templates", "dashboard.html")).read()
js = open(os.path.join(REPO, "static", "dashboard.js")).read()
s.check("the dashboard shows 'None this cycle' for both, not 'Not released'", "no_pot" in dash
        and "None this cycle" in dash)
s.check("the record panel reads no_pot", "d.no_pot" in js)
setp(ACID, 1)
rel_page = C_SU.get("/admin/talent-release?period=%d" % ACID).get_data(as_text=True)
setp(ACID, ORIG)
s.check("Release results: the note, and the picker offers Performance only",
        "has no potential band" in rel_page and '<option value="three">Performance</option>' in rel_page
        and 'value="pot"' not in rel_page and 'value="talent"' not in rel_page)
_lab = next((ln for ln in rel_page.splitlines() if "var LABEL" in ln), "")
s.check("...and its script still parses (the labels go through tojson, never an escaped quote)",
        "var NOPOT = true" in rel_page and 'three: "Performance"' in _lab and "&#39;" not in _lab, _lab.strip())

# ---------------------------------------------------------------------------
# put everything back
with ctx():
    db = a.get_db()
    db.execute("UPDATE cycles SET no_potential=? WHERE id=?", (ORIG, ACID))
    if OLD_ADJ:
        db.execute("UPDATE calibration_adjustments SET original_band=?, adjusted_band=? WHERE session_id=? AND "
                   "subject_id=?", (OLD_ADJ[0], OLD_ADJ[1], SESS, P["id"]))
    else:
        db.execute("DELETE FROM calibration_adjustments WHERE session_id=? AND subject_id=?", (SESS, P["id"]))
    if MADE_SESS:
        db.execute("DELETE FROM calibration_sessions WHERE id=?", (SESS,))
    db.commit()
    if HAD_RR:
        a._rating_record_refresh(db, ACID, [P["id"]], "zz_test", commit=True)
    else:
        db.execute("DELETE FROM rating_records WHERE cycle_id=? AND subject_id=?", (ACID, P["id"]))
        db.commit()
sys.exit(s.done())
