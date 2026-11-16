"""Talent Box Round 2 -- the back end (Chris, 2026-11-14: the actual PAT after the BG CEO locked a unit on the forecast; plan:
OneHR/Talent Box Round 2 2026-11-14/BUILD-PLAN.md, piece 1).

  "round 2 happens before results are released, and it supersedes round 1 ... This doesn't impact Group Chief, round 2 only
   applies to BGCEO."

What this suite holds (each guard is falsified: the refusal AND the allowed path are both checked):
  * the two tables, and the state worked out from a row, never stored
  * the actual PAT: the super admin's alone, with a remark, only for a unit the BG CEO has locked, refused once anything is
    released; the first save writes the Round 1 record (equal to the box at lock) and the forecast; later saves change only the
    actual figure; PAT Ref refuses a locked unit's figure; units calibrated together shift together
  * 'same' curve: nothing to open
  * Do Round 2 here (admin mode): the BG CEO is refused (the unit stays locked), the super admin may move with the round's remark
    on every audit and band row, the moves cap does not apply to the unit (it does to a unit with no round), the lock re-pins,
    snapshots, and marks the round locked; nothing moves after
  * Push to the BG CEO: the lock row goes (and the group's two sessions' lock, with every other unit and a person with no unit
    keeping a lock row of their own), the BG CEO moves only the round's units, the late pass until the lock-by day, refused after
    it while the super admin can finish, the BG CEO's lock marks the round locked and locks the group again
  * the release gate, the remark gate (the round's remark), the email (queued, no staff names, no bands), Remind
  * Suggest with AI proposes (write-free) and Apply all recomputes on the server and skips a stale move
Its own synthetic business groups on the SHARED suite database (ZZR2-*); everything is put back at the end.
"""
import json
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Talent Box Round 2 -- the actual PAT, the two ways to run it, the gates, the email")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG, BG2, BG3 = "ZZR2 Group", "ZZR2 Two", "ZZR2 Three"
UT = "ZZR2 Tango"
UA, UB, UC, UD, UE, UF, UG = ("ZZR2 Alpha", "ZZR2 Beta", "ZZR2 Gamma", "ZZR2 Delta", "ZZR2 Echo", "ZZR2 Foxtrot", "ZZR2 Golf")
W1, W2 = "ZZR2 Whisky", "ZZR2 Xray"
PFX = "ZZR2-"
REASON = "ZZR2 the actual PAT is in"
XHR = {"X-Requested-With": "XMLHttpRequest", "Sec-Fetch-Mode": "cors"}   # a fetch, as the page makes it
SENT = []

with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZR2-%'")   # a run that died half-way
    _ORIG = {"half": db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0],
             "settings": {k: (r[0] if r else None) for k in ("ai_calib", "review_unified", "tb_limit_moves_on", "tb_limit_moves_pct",
                                                              "tb_limit_stars_on")
                          for r in [db.execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone()]},
             "modules": {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=? "
                                                         "AND module_key IN ('review','calibration','pm','tm')", (CID,))},
             "windows": [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=? AND cell='tb_bgceo'", (CID,))],
             "max": {tb: db.execute("SELECT COALESCE(MAX(id),0) FROM %s" % tb).fetchone()[0]
                     for tb in ("calibration_sessions", "pm_calibration_sessions", "calibration_adjustments",
                                "pm_calibration_adjustments", "pm_kpi_targets", "activity_log", "email_outbox", "late_passes",
                                "notifications")}}
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm')", (CID,))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='tb_bgceo'", (CID,))   # open all cycle
    for k in ("ai_calib", "review_unified"):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k,))
    for k in ("tb_limit_moves_on", "tb_limit_stars_on"):
        db.execute("DELETE FROM app_settings WHERE key=?", (k,))
    for bg_, cos in ((BG, (UA, UB, UC, UD, UE, UF, UG)), (BG2, (W1, W2)), (BG3, (UT,))):
        for co in cos:
            db.execute("INSERT OR IGNORE INTO org_units(business_group, company, active) VALUES (?,?,1)", (bg_, co))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, company, bg=BG, email=None, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=email, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=bg, company=company)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        uid = db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group) "
                   "VALUES (?,?,?,100,'more','approved',?)", (PER, uid, "ZZR2 KPI", bg))
        return uid
    BOSS = person(PFX + "CEO", "ZZ R2 Group CEO", UC, bgceo_bg=BG, email="zzr2-ceo@example.test")
    BOSS2 = person(PFX + "CE2", "ZZ R2 Two CEO", W2, bg=BG2, bgceo_bg=BG2, email="zzr2-ce2@example.test")
    # perf / pot per person: Solid Core (ME, Mid) ... one box each, so a move across a category is easy to tell
    SPEC = {UA: [("ME", "Mid"), ("ME", "Mid"), ("ME", "Mid"), ("BE", "Low"), ("OU", "High")],
            UB: [("ME", "Mid"), ("AE", "Mid"), ("ME", "High")],
            UC: [("ME", "Mid"), ("ME", "Mid"), ("AE", "Mid")],
            UD: [("ME", "Mid"), ("AE", "Mid")], UE: [("ME", "Mid")],
            UF: [("ME", "Mid"), ("ME", "Mid"), ("AE", "Mid"), ("BE", "Low")],
            UG: [("ME", "Mid"), ("ME", "Mid"), ("AE", "Mid"), ("BE", "Low")]}
    P = {}   # company -> [ids]
    for co, specs in SPEC.items():
        P[co] = [person("%s%s%d" % (PFX, co.split()[-1][:3].upper(), i), "ZZ R2 %s %d" % (co.split()[-1], i), co)
                 for i in range(len(specs))]
    NU1 = person(PFX + "NU1", "ZZ R2 Nounit One", None)   # a person with no business unit, in the BG
    P2 = {W1: [person(PFX + "WH%d" % i, "ZZ R2 Whisky %d" % i, W1, bg=BG2) for i in range(2)],
          W2: [person(PFX + "XR%d" % i, "ZZ R2 Xray %d" % i, W2, bg=BG2) for i in range(2)]}
    NU2 = person(PFX + "NU2", "ZZ R2 Nounit Two", None, bg=BG2)
    SPEC2 = {W1: [("ME", "Mid"), ("AE", "Mid")], W2: [("ME", "Mid"), ("BE", "Low")]}
    BOSS3 = person(PFX + "CE3", "ZZ R2 Three CEO", UT, bg=BG3, bgceo_bg=BG3, email="zzr2-ce3@example.test")
    P3 = {UT: [person(PFX + "TA%02d" % i, "ZZ R2 Tango %d" % i, UT, bg=BG3) for i in range(31)]}   # for the Apply all timing
    SPEC2[UT] = [("ME", "Mid")] * 31
    # their BU CEOs banded and locked both axes (the BG CEO's lock pins what the box shows)
    for co, ids in list(P.items()) + list(P2.items()) + list(P3.items()):
        specs = SPEC.get(co) or SPEC2[co]
        bgx = BG if co in P else BG2 if co in P2 else BG3
        pa = a._pm_calib_get_or_create_session(db, PER, "buceo", co, bgx, co)
        ca = a._get_or_create_calibration_session(db, CID, "buceo", co, bgx, co)
        for sid, (pb, qb) in zip(ids, specs):
            a._pm_calib_upsert_adjustment(db, pa["id"], sid, "", pb, "BU set", BOSS)
            a._calibration_upsert_adjustment(db, ca["id"], sid, "", qb, "BU set", BOSS)
        db.execute("UPDATE pm_calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE id=?", (pa["id"],))
        db.execute("UPDATE calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE id=?", (ca["id"],))
    # forecast PAT (PAT Ref): 85% = Normal for every unit
    for bgx, co in [(BG, c) for c in P] + [(BG2, c) for c in P2] + [(BG3, UT)]:
        db.execute("INSERT OR REPLACE INTO pm_pbt_achievement(cycle_id, business_group, company, achievement_pct) VALUES (?,?,?,85)",
                   (PER, bgx, co))
    # units D and E are calibrated together, D leading (and its PAT the one they follow)
    for co in (UD, UE):
        db.execute("INSERT OR REPLACE INTO calib_unit_joins(cycle_id, business_group, company, lead) VALUES (?,?,?,?)", (CID, BG, co, UD))
    db.commit()
    SUROW = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())

a.mailer.is_configured = lambda: True      # this suite's emails queue (the sender is never started: _outbox_kick is stubbed)
a._outbox_kick = lambda *x, **k: False
_real_fit = a._pm_calib_fit_moves
SEEN_FIT = []


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def exe(sql, args=()):
    def f(d):
        d.execute(sql, args)
        d.commit()
    ctx(f)


def one(sql, args=()):
    return H.one(a, sql, args)


def rows(sql, args=()):
    return [dict(r) for r in H.rows(a, sql, args)]


def rnd(co, bg=BG):
    return ctx(lambda d: dict(a._tb_round_row(d, PER, bg, co) or {}))


def state(co, bg=BG):
    return ctx(lambda d: a._tb_round_state(a._tb_round_row(d, PER, bg, co)))


def box(bg=BG):
    """{person id: (perf, pot, category)} of the BG CEO's box as it reads now."""
    def f(d):
        c_ = a._talent_box_resolve(d, SUROW, "bgceo", admin_view=True, bg=bg)
        return {r["user"]["id"]: (r["perf_band"], r["pot_band"], r["category"]) for r in a.talent_box_rows(d, c_)}
    return ctx(f)


def bands(sid, bg=BG):
    """The BG tier's own band rows for one person: {axis: (adjusted, pinned, justification)}."""
    out = {}
    for ax, tbl, sess in (("pm", "pm_calibration_adjustments", "pm_calibration_sessions"),
                          ("pot", "calibration_adjustments", "calibration_sessions")):
        r = rows("SELECT ca.adjusted_band, ca.pinned, ca.justification FROM %s ca JOIN %s cs ON cs.id=ca.session_id WHERE "
                 "cs.tier='bgceo' AND cs.business_group=? AND ca.subject_id=?" % (tbl, sess), (bg, sid))
        out[ax] = (r[0]["adjusted_band"], r[0]["pinned"], r[0]["justification"]) if r else None
    return out


def lockrows(bg=BG):
    return {r["company"] for r in rows("SELECT company FROM talent_box_bu_locks WHERE business_group=?", (bg,))}


def sess_locked(bg=BG):
    return [one("SELECT COUNT(*) FROM %s WHERE tier='bgceo' AND scope_key=? AND locked_at IS NOT NULL" % t, (bg,))
            for t in ("pm_calibration_sessions", "calibration_sessions")]


SUP, BOSSC, BOSS2C, BOSS3C = H.client_as(a, SU["id"]), H.client_as(a, BOSS), H.client_as(a, BOSS2), H.client_as(a, BOSS3)
BGAC = H.client_as(a, BGA["id"]) if BGA else None
EMPC = H.client_as(a, P[UB][0])
URL = "/admin/calibration/talent-box/round2/"


def post(c, url, **d):
    d.setdefault("csrf_token", "tok")
    return c.post(url, data=d, headers=XHR)


def js(r):
    try:
        return r.get_json() or {}
    except Exception:   # noqa: BLE001
        return {}


def err(r):
    return js(r).get("error") or ""


def actual(c, co, pct, remark=REASON, bg=BG):
    d = {"bg": bg, "company": co, "actual_pct": str(pct)}
    if remark is not None:
        d["remark"] = remark
    return post(c, URL + "actual", **d)


def openr(c, co, mode, remark=REASON, due_on=None, bg=BG):
    d = {"bg": bg, "company": co, "mode": mode}
    if remark is not None:
        d["remark"] = remark
    if due_on:
        d["due_on"] = due_on
    return post(c, URL + "open", **d)


def lockr(c, co, rid=None, remark=None, bg=BG):
    d = {"bg": bg, "company": co}
    if rid:
        d["round_id"] = str(rid)
    if remark:
        d["remark"] = remark
    return post(c, URL + "lock", **d)


def move(c, sid, perf=None, pot=None, rid=None, remark=None, bg=BG):
    d = {"subject_id": str(sid)}
    if perf:
        d["performance_band"] = perf
    if pot:
        d["potential_band"] = pot
    if rid:
        d["round_id"] = str(rid)
    if remark:
        d["remark"] = remark
    return post(c, "/talent-box/bg/%s/move" % bg, **d)


def tblock(c, co, bg=BG, rid=None, remark=None):
    d = {"ajax": "1"}
    if co:
        d["company"] = co
    if rid:
        d["round_id"] = str(rid)
    if remark:
        d["remark"] = remark
    return post(c, "/talent-box/bg/%s/lock" % bg, **d)


def emails(kind="tb_round2"):
    return rows("SELECT * FROM email_outbox WHERE kind=? ORDER BY id", (kind,))


def in_log(action, needle):
    return one("SELECT COUNT(*) FROM activity_log WHERE id>? AND action=? AND detail LIKE ?",
               (_ORIG["max"]["activity_log"], action, "%" + needle + "%")) > 0


# ======================================================================================================================
s.section("the tables, and the state worked out from a row, never stored")
sch = {t: [r["name"] for r in rows("PRAGMA table_info(%s)" % t)] for t in ("tb_rounds", "tb_round1_marks")}
s.check("tb_rounds and tb_round1_marks exist with the plan's columns",
        {"id", "period_id", "cycle_id", "business_group", "company", "forecast_pct", "actual_pct", "curve_before", "curve_after",
         "r1_taken_at", "actual_set_at", "actual_set_by", "actual_remark", "mode", "opened_at", "opened_by", "remark", "due_at",
         "cleared_bg_lock", "emailed_at", "reminded_at", "locked_at", "locked_by"} == set(sch["tb_rounds"])
        and sch["tb_round1_marks"] == ["round_id", "subject_id", "perf_band", "pot_band", "category"], sch)
src = H.source(a)
s.check("...and the SCHEMA string says the same, so a fresh database has them (additive: IF NOT EXISTS in both)",
        src.count("CREATE TABLE IF NOT EXISTS tb_rounds (") == 1 and src.count("CREATE TABLE IF NOT EXISTS tb_rounds(") == 1
        and src.count("CREATE TABLE IF NOT EXISTS tb_round1_marks (") == 1 and src.count("CREATE TABLE IF NOT EXISTS tb_round1_marks(") == 1)
now = a._utc_now()
past = (now - timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
fut = (now + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
R = lambda **k: dict({"actual_pct": 62.0, "curve_before": "normal", "curve_after": "negative", "mode": None, "due_at": None,
                      "locked_at": None}, **k)   # noqa: E731
TRUTH = [(None, "none"), (R(actual_pct=None), "none"), (R(curve_after="normal"), "same"), (R(), "waiting"),
         (R(mode="admin"), "open"), (R(mode="bgceo", due_at=fut), "open"), (R(mode="bgceo", due_at=past), "due"),
         (R(mode="admin", due_at=past), "open"), (R(mode="bgceo", due_at=past, locked_at="2026-11-01 00:00:00"), "locked"),
         (R(mode="admin", locked_at="2026-11-01 00:00:00"), "locked")]
s.check("the state: none / same / waiting / open / due (pushed and past its day) / locked, from the row alone",
        [a._tb_round_state(r) for r, _w in TRUTH] == [w for _r, w in TRUTH], [a._tb_round_state(r) for r, _w in TRUTH])

# ======================================================================================================================
s.section("Round 1: the BG CEO locks the units on the forecast")
with BOSSC.session_transaction() as ss:
    ss.pop("_flashes", None)
for co in (UA, UB, UF, UG, UD):
    r = tblock(BOSSC, co)
    s.check("%s locks" % co, js(r).get("ok") is True, js(r))
SNAP = box()   # the box as the BG CEO locked it: Round 1
s.check("units A, B, F, G and D+E are locked (D's join locks as one); Gamma is not; the group is not", lockrows() == {UA, UB, UF, UG, UD, UE}
        and sess_locked() == [0, 0], (lockrows(), sess_locked()))
TBL = ctx(lambda d: set(a._tb_bu_locks(d, PER, BG)))
GC0 = [one("SELECT COUNT(*) FROM pm_calibration_sessions WHERE tier='group'"), one("SELECT COUNT(*) FROM pm_group_locks"),
       one("SELECT COUNT(*) FROM calibration_sessions WHERE tier='group'")]

# ======================================================================================================================
s.section("the actual PAT: the super admin's alone, with a remark, for a locked unit only")
ADMIN_EPS = ("admin_tb_round_actual", "admin_tb_round_open", "admin_tb_round_remind", "admin_tb_round_lock")
s.check("every Round 2 write is mapped 'super' on the access map, and the four band-moving ones ask the remark",
        all(a.ADMIN_ACCESS_MAP.get(e) == "super" for e in ADMIN_EPS)
        and all(e in a.SUPER_BAND_ENDPOINTS for e in ("admin_tb_round_actual", "admin_tb_round_open", "admin_tb_round_lock",
                                                      "tb_round_apply")))
bad = []
for who, c in (("BG CEO", BOSSC), ("BG admin", BGAC), ("an employee", EMPC)):
    if c is None:
        continue
    for ep, d in (("actual", {"bg": BG, "company": UA, "actual_pct": "62", "remark": REASON}),
                  ("open", {"bg": BG, "company": UA, "mode": "admin", "remark": REASON}),
                  ("remind", {"bg": BG, "company": UA}), ("lock", {"bg": BG, "company": UA, "remark": REASON})):
        r = post(c, URL + ep, **d)
        if r.status_code != 403:
            bad.append((who, ep, r.status_code))
s.check("non-super refused on each write route (403): the BG CEO, a BG admin, an employee", not bad, bad)
s.check("...and nothing was written", one("SELECT COUNT(*) FROM tb_rounds") == 0)
r = actual(SUP, UA, 62, remark=None)
s.check("no remark: refused before the route runs (the band-remark gate)", r.status_code == 400 and "remark" in err(r)
        and one("SELECT COUNT(*) FROM tb_rounds") == 0, js(r))
r = actual(SUP, UC, 62)
s.check("a unit the BG CEO has NOT locked is refused (its figure is still the forecast)", r.status_code == 400
        and "hasn't locked" in err(r) and one("SELECT COUNT(*) FROM tb_rounds") == 0, js(r))
r = actual(SUP, UA, "abc")
s.check("a figure that is not a number is refused", r.status_code == 400 and one("SELECT COUNT(*) FROM tb_rounds") == 0, js(r))
r = actual(SUP, UA, "")
s.check("a blank figure is refused", r.status_code == 400 and one("SELECT COUNT(*) FROM tb_rounds") == 0, js(r))
r = actual(SUP, UA, 62, bg="ZZ nope")
s.check("a unit of another group is refused", r.status_code == 400, js(r))

# released: nothing of a unit with a released result changes (falsified: the same save goes through once nothing is released)
exe("INSERT INTO leader_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pm')", (PER, P[UB][1]))
r = actual(SUP, UB, 90)
s.check("a unit with a result released to leaders is refused", r.status_code == 400 and "released" in err(r)
        and one("SELECT COUNT(*) FROM tb_rounds WHERE company=?", (UB,)) == 0, js(r))
exe("DELETE FROM leader_releases WHERE subject_id=?", (P[UB][1],))

r = actual(SUP, UA, 62)
RA = rnd(UA)
s.check("A: the actual save writes its row: forecast 85, actual 62, curve Normal -> Negatively skewed, who and when, the remark",
        js(r).get("ok") is True and RA.get("forecast_pct") == 85.0 and RA.get("actual_pct") == 62.0
        and RA.get("curve_before") == "normal" and RA.get("curve_after") == "negative" and RA.get("actual_set_by") == SU["id"]
        and RA.get("actual_remark") == REASON and RA.get("r1_taken_at") and state(UA) == "waiting", (js(r), RA))
s.check("...and the PAT every curve reads is now the actual: 62 -> the Negatively skewed curve",
        ctx(lambda d: a.pm_curve_for(d, PER, BG, UA)["key"]) == "negative"
        and one("SELECT achievement_pct FROM pm_pbt_achievement WHERE business_group=? AND company=?", (BG, UA)) == 62.0)
MK = {r["subject_id"]: (r["perf_band"], r["pot_band"], r["category"])
      for r in rows("SELECT * FROM tb_round1_marks WHERE round_id=?", (RA["id"],))}
s.check("the Round 1 record is each person of the unit's placement as the BG CEO locked it (it equals the box at lock)",
        MK == {i: SNAP[i] for i in P[UA]} and len(MK) == 5, (MK, {i: SNAP[i] for i in P[UA]}))
r = actual(SUP, UA, 64)
s.check("a later save while waiting changes only the actual figure and the curve after: the forecast and the record stay",
        js(r).get("ok") is True and rnd(UA)["actual_pct"] == 64.0 and rnd(UA)["forecast_pct"] == 85.0
        and rnd(UA)["curve_before"] == "normal" and one("SELECT COUNT(*) FROM tb_round1_marks WHERE round_id=?", (RA["id"],)) == 5
        and one("SELECT COUNT(*) FROM tb_rounds WHERE company=?", (UA,)) == 1)
actual(SUP, UA, 62)
r = actual(SUP, UB, 90)
s.check("B: an actual on the same curve (85 -> 90, Normal -> Normal): state 'same', Round 1 stands",
        js(r).get("ok") is True and state(UB) == "same" and "Round 1 stands" in (js(r).get("message") or ""), js(r))
r = openr(SUP, UB, "admin")
s.check("...and there is nothing to open (admin or push), nothing changed", r.status_code == 400 and "didn't change" in err(r)
        and rnd(UB)["mode"] is None and openr(SUP, UB, "bgceo").status_code == 400)
r = openr(SUP, UC, "admin")
s.check("a unit with no actual yet can't be opened", r.status_code == 400 and "actual PAT" in err(r))
r = actual(SUP, UF, 62)
r2 = actual(SUP, UG, 62)
s.check("F and G shift too (Normal -> Negatively skewed)", state(UF) == "waiting" and state(UG) == "waiting")

# PAT Ref
s.section("PAT Ref: a locked unit's figure is read only there")
def patsave(co, raw):
    with a.app.test_request_context("/"):
        d = a.get_db()
        out = a._pat_save(d, SUROW, a.active_pm_period(d), BG, [(co, raw)])
        return out
saved, e_ = patsave(UA, "50")
s.check("_pat_save refuses a unit the BG CEO has locked (even for the super admin): 'Change it on Talent Box > Round 2 · Actual'",
        not saved and "Round 2 · Actual" in (e_ or "") and one("SELECT achievement_pct FROM pm_pbt_achievement WHERE business_group=? "
                                                             "AND company=?", (BG, UA)) == 62.0, (saved, e_))
saved, e_ = patsave(UB, "100")
s.check("...and one with a Round 2 row, locked or not (B stays on 90)", not saved and e_ and one(
    "SELECT achievement_pct FROM pm_pbt_achievement WHERE business_group=? AND company=?", (BG, UB)) == 90.0, (saved, e_))
saved, e_ = patsave(UC, "80")
s.check("...but a unit nobody has locked still changes on PAT Ref (Gamma 85 -> 80, then back)", e_ is None and len(saved) == 1
        and one("SELECT achievement_pct FROM pm_pbt_achievement WHERE business_group=? AND company=?", (BG, UC)) == 80.0, (saved, e_))
patsave(UC, "85")
r = SUP.post("/admin/performance/pbt", data={"csrf_token": "tok", "business_group": BG, "company": [UA], "achievement_pct": ["40"]},
             follow_redirects=True)
s.check("the PAT Ref page's own save is refused the same way, with the words on the page",
        "Round 2 · Actual" in r.get_data(as_text=True) and one(
            "SELECT achievement_pct FROM pm_pbt_achievement WHERE business_group=? AND company=?", (BG, UA)) == 62.0)
fl = ctx(lambda d: a._pat_lock_view(d, SUROW, PER, BG, UA, a.pm_curve_for(d, PER, BG, UA)))
s.check("its post-lock flag (the BU CEO's lock, the PAT since moved) points to Round 2, not the BU CEO fit",
        fl is not None and fl["round"] and fl["round"]["state"] == "waiting" and fl["moves"] is None, fl and fl.get("round"))
s.check("the PAT Ref page still draws, with each unit's read-only mark given to its template",
        SUP.get("/admin/performance/pbt?fbg=" + BG.replace(" ", "+")).status_code == 200
        and ctx(lambda d: a._pat_bg_locked(d, PER, BG, UA)) is True and ctx(lambda d: a._pat_bg_locked(d, PER, BG, UC)) is False)

# ======================================================================================================================
s.section("units calibrated together shift together")
r = actual(SUP, UE, 40)
s.check("the actual PAT is entered for the unit the group FOLLOWS (Delta), not a member: Echo is refused naming it",
        r.status_code == 400 and "follows" in err(r) and one("SELECT COUNT(*) FROM tb_rounds WHERE company IN (?,?)", (UD, UE)) == 0, js(r))
r = actual(SUP, UD, 62)
s.check("Delta's actual: one row each for Delta and Echo, the Round 1 record for both units' people, both 'waiting'",
        js(r).get("ok") is True and state(UD) == "waiting" and state(UE) == "waiting"
        and one("SELECT COUNT(*) FROM tb_round1_marks WHERE round_id IN (SELECT id FROM tb_rounds WHERE company IN (?,?))", (UD, UE)) == 3,
        (js(r), state(UD), state(UE)))
sec = ctx(lambda d: a._tb_rounds_for_bg(d, PER, BG))
UNITS = {x["key"]: x for x in sec["units"]}
s.check("_tb_rounds_for_bg: one entry for the joined units, under their lead, naming both, the figures and the states",
        UD in UNITS and UE not in UNITS and UNITS[UD]["members"] == [UD, UE] and UNITS[UD]["state"] == "waiting"
        and UNITS[UD]["forecast_pct"] == 85.0 and UNITS[UD]["actual_pct"] == 62.0 and UNITS[UD]["shifted"]
        and UNITS[UD]["curve_after_label"] == "Negatively skewed" and UNITS[UB]["state"] == "same" and UNITS[UC]["state"] == "none"
        and UNITS[UC]["bg_locked"] is False and UNITS[UA]["bg_locked"] is True and len(UNITS[UD]["round_ids"]) == 2
        and set(sec["hold"]) >= {UNITS[UA]["label"], UNITS[UD]["label"]} and UNITS[UB]["label"] not in sec["hold"]
        and sec["counts"].get("waiting", 0) >= 4, {k: (v["state"], v["label"]) for k, v in UNITS.items()})
r = openr(SUP, UE, "admin")
RD = rnd(UD)
s.check("opening a member opens the whole join: both rows 'admin', both 'open' (one shift sends all members to Round 2 together)",
        js(r).get("ok") is True and state(UD) == "open" and state(UE) == "open" and rnd(UE)["mode"] == "admin"
        and rnd(UE)["remark"] == REASON, js(r))
r = lockr(SUP, UE, rid=RD["id"])
s.check("...and Lock Round 2 locks both rows together", js(r).get("ok") is True and state(UD) == "locked" and state(UE) == "locked"
        and {UD, UE} <= lockrows(), js(r))
exe("DELETE FROM tb_round1_marks WHERE round_id IN (SELECT id FROM tb_rounds WHERE company IN (?,?))", (UD, UE))
exe("DELETE FROM tb_rounds WHERE company IN (?,?)", (UD, UE))
exe("UPDATE pm_pbt_achievement SET achievement_pct=85 WHERE business_group=? AND company IN (?,?)", (BG, UD, UE))

# ======================================================================================================================
s.section("the release gate: nothing goes out for a unit whose Round 2 is waiting, open or due")
def release(sid, to="leaders", what="pm"):
    c = SUP
    with c.session_transaction() as ss:
        ss.pop("_flashes", None)
    c.post("/admin/talent-release", data={"csrf_token": "tok", "action": "release", "result": what, "to": to, "ids": [str(sid)]})
    with c.session_transaction() as ss:
        return " ".join(m for _c, m in ss.pop("_flashes", []))
fl = release(P[UA][4])
s.check("waiting (Alpha): refused, naming the unit, nothing released", "Talent Box Round 2" in fl and "Alpha" in fl
        and one("SELECT COUNT(*) FROM leader_releases WHERE subject_id=?", (P[UA][4],)) == 0, fl)
fl = release(P[UA][4], to="employees", what="all")
s.check("...whatever is released (all) and to whom (employees)", "Talent Box Round 2" in fl, fl)
fl = release(P[UB][0])
s.check("'same' (Beta) is not held: the release goes on to its own answer", "Talent Box Round 2" not in fl and fl, fl)
exe("DELETE FROM leader_releases WHERE subject_id IN (%s)" % ",".join(str(i) for i in P[UB]))
exe("DELETE FROM result_releases WHERE subject_id IN (%s)" % ",".join(str(i) for i in P[UB]))
exe("DELETE FROM talent_releases WHERE subject_id IN (%s)" % ",".join(str(i) for i in P[UB]))

# ======================================================================================================================
s.section("Do Round 2 here (admin mode): the unit stays locked for everyone else, the super admin re-places it")
exe("INSERT OR REPLACE INTO app_settings(key,value) VALUES('tb_limit_moves_on','1')")
exe("INSERT OR REPLACE INTO app_settings(key,value) VALUES('tb_limit_moves_pct','10')")
mail0 = len(emails())
r = openr(SUP, UA, "admin", remark=None)
s.check("no remark: refused, still waiting", r.status_code == 400 and "remark" in err(r) and state(UA) == "waiting", js(r))
r = openr(SUP, UA, "sideways")
s.check("a mode that is neither is refused", r.status_code == 400 and state(UA) == "waiting", js(r))
r = openr(SUP, UA, "admin")
RA = rnd(UA)
s.check("opened: mode 'admin', who and when, the remark; state 'open'; the BG CEO is told nothing; its lock row stays",
        js(r).get("ok") is True and RA["mode"] == "admin" and RA["opened_by"] == SU["id"] and RA["remark"] == REASON
        and RA["due_at"] is None and state(UA) == "open" and UA in lockrows() and len(emails()) == mail0
        and not RA["cleared_bg_lock"], (js(r), RA))
r = openr(SUP, UA, "admin")
s.check("...and opening it again is refused", r.status_code == 400 and "already" in err(r))
r = actual(SUP, UA, 70)
s.check("the actual PAT can't change once opened", r.status_code == 400 and "already been opened" in err(r)
        and rnd(UA)["actual_pct"] == 62.0, js(r))
r = move(BOSSC, P[UA][0], perf="OU", pot="High")
s.check("the BG CEO moving someone of it: refused, the unit is locked (they see nothing new)", r.status_code == 400
        and "locked" in err(r) and bands(P[UA][0])["pm"][1] is not None, js(r))
r = move(SUP, P[UA][0], perf="OU", pot="High")
s.check("the super admin moving it with no remark and no round named: refused by the remark gate", r.status_code == 400
        and "remark" in err(r) and bands(P[UA][0])["pm"][1] is not None, js(r))
r = move(SUP, P[UB][0], perf="OU", pot="High", remark="ZZR2 not a round")
s.check("...and on a unit with no Round 2 (Beta, locked) the lock still holds, even with a remark", r.status_code == 400
        and "locked" in err(r), js(r))
r = move(SUP, P[UA][0], perf="OU", pot="High", rid=RA["id"])
b0 = bands(P[UA][0])
s.check("the super admin moves a person of it naming the round only: the round's remark rides on the band rows and the audit row",
        js(r).get("ok") is True and b0["pm"][0] == "OU" and b0["pm"][1] is None and b0["pm"][2] == REASON
        and b0["pot"][0] == "High" and b0["pot"][2] == REASON and in_log("talent_box_move", REASON) and in_log("talent_box_move", "Round 2"),
        (js(r), b0))
r = move(SUP, P[UA][1], perf="OU", pot="High", rid=RA["id"])
s.check("a SECOND move across a category is allowed: a Round 2 unit is exempt from the moves cap (10% of 5 is one)",
        js(r).get("ok") is True and bands(P[UA][1])["pm"][0] == "OU", js(r))
exe("INSERT OR REPLACE INTO app_settings(key,value) VALUES('tb_limit_moves_pct','10')")
r1 = move(SUP, P[UC][0], perf="OU", pot="High", remark="ZZR2 control")
r2 = move(SUP, P[UC][1], perf="OU", pot="High", remark="ZZR2 control")
s.check("falsified: the same two category moves on Gamma (no Round 2) are held to the cap -- the second is refused",
        js(r1).get("ok") is True and r2.status_code == 400 and "Movement cap" in err(r2), (js(r1), js(r2)))
r = move(SUP, P[UA][0], rid=999999)
s.check("a round_id that isn't an open round gives the form no remark: asked for one", r.status_code == 400 and "remark" in err(r))
exe("DELETE FROM app_settings WHERE key IN ('tb_limit_moves_on','tb_limit_moves_pct')")
# Suggest with AI and Apply all (the fit stubbed to a known proposal: ME -> AE for whoever sits at ME in the unit)
def fake_fit(db_, u_, c_, tier_):
    cur = a.pm_curve_for_scope(db_, c_)
    SEEN_FIT.append(([p["id"] for p in c_["population"]], cur["key"], tier_))
    mv = [{"id": r_["user"]["id"], "name": r_["user"]["full_name"], "from": "ME", "to": "AE", "direction": "up",
           "reasons": ["a stand-in"]} for r_ in a._pm_calib_assist_rows(db_, c_, tier_)
          if r_["current_band"] == "ME" and r_["user"]["id"] != u_["id"]]
    return {"moves": mv, "within_after": True, "unscored": [], "message": "%d stand-in moves." % len(mv)}
a._pm_calib_fit_moves = fake_fit
sg = SUP.get("/talent-box/round2/suggest?bg=%s&company=%s" % (BG, UA))
J = js(sg)
s.check("Suggest (the super admin, an admin round): proposes only -- it read the unit's people against the ACTUAL curve",
        sg.status_code == 200 and J.get("ok") and [m["id"] for m in J["moves"]] == [P[UA][2]] and J["curve_key"] == "negative"
        and sorted(SEEN_FIT[-1][0]) == sorted(P[UA]) and SEEN_FIT[-1][2] == "bgceo" and J["fp"] and bands(P[UA][2])["pm"][1] is not None,
        (J, SEEN_FIT[-1:]))
s.check("...and writes nothing (the person is still pinned at ME)", bands(P[UA][2])["pm"][0] == "ME")
sgb = BOSSC.get("/talent-box/round2/suggest?bg=%s&company=%s" % (BG, UA))
s.check("the BG CEO can't Suggest for an admin round (they see nothing of it)", sgb.status_code == 400 and "no open Round 2" in err(sgb), js(sgb))
sge = EMPC.get("/talent-box/round2/suggest?bg=%s&company=%s" % (BG, UA))
s.check("an employee can't either", sge.status_code == 400, js(sge))
ap = post(SUP, "/talent-box/round2/apply", bg=BG, company=UA, moves=json.dumps(J["moves"]))
s.check("Apply all with no remark and no round: refused (the super admin's band remark)", ap.status_code == 400 and "remark" in err(ap)
        and bands(P[UA][2])["pm"][0] == "ME", js(ap))
ap = post(SUP, "/talent-box/round2/apply", bg=BG, company=UA, moves=json.dumps(J["moves"]), round_id=str(RA["id"]))
s.check("Apply all naming the round: the move is written through the move writer, with the round's remark; 1 applied, 0 skipped",
        js(ap).get("ok") and js(ap)["applied"] == 1 and js(ap)["skipped"] == 0 and bands(P[UA][2])["pm"][0] == "AE"
        and bands(P[UA][2])["pm"][2] == REASON, js(ap))
# lock: re-pin what wasn't moved, snapshot, rating record, the round locked
a3 = P[UA][3]
exe("DELETE FROM pm_calibration_adjustments WHERE subject_id=? AND session_id IN (SELECT id FROM pm_calibration_sessions WHERE tier='bgceo' "
    "AND business_group=?)", (a3, BG))
exe("DELETE FROM talent_status_history WHERE subject_id IN (%s)" % ",".join(str(i) for i in P[UA]))
r = tblock(BOSSC, UA)
s.check("the BG CEO's own Lock on it is 'already locked' (nothing for them to do)", js(r).get("already") is True or r.status_code == 400, js(r))
r = lockr(SUP, UA)
s.check("Lock Round 2 with no round named and no remark: refused by the remark gate", r.status_code == 400 and "remark" in err(r)
        and state(UA) == "open", js(r))
r = lockr(SUP, UA, rid=RA["id"])
s.check("Lock Round 2 (the round's remark): the round is locked by the super admin; state 'locked'",
        js(r).get("ok") is True and state(UA) == "locked" and rnd(UA)["locked_by"] == SU["id"], js(r))
s.check("...it re-pinned what was not moved (the person we cleared is pinned again at their band)",
        bands(a3)["pm"] is not None and bands(a3)["pm"][1] is not None and bands(a3)["pm"][0] == "BE", bands(a3))
s.check("...snapshotted the talent status for the unit's people", one(
    "SELECT COUNT(*) FROM talent_status_history WHERE source='calibration' AND subject_id IN (%s)" % ",".join(str(i) for i in P[UA])) == 5)
s.check("...its audit row names Round 2 and carries the round's remark", in_log("talent_box_lock", "Round 2 locked by Group People")
        and in_log("talent_box_lock", REASON))
r = lockr(SUP, UA, rid=RA["id"], remark=REASON)
s.check("locking it again is refused", r.status_code == 400 and "already locked" in err(r), js(r))
r = move(SUP, P[UA][4], perf="AE", rid=RA["id"], remark=REASON)
s.check("nothing moves after the lock (the unit is locked again for everyone, a remark or not)",
        r.status_code == 400 and "locked" in err(r), js(r))
MK2 = {r["subject_id"]: (r["perf_band"], r["pot_band"], r["category"])
       for r in rows("SELECT * FROM tb_round1_marks WHERE round_id=?", (RA["id"],))}
s.check("Round 1 is kept as the record: it still says where the BG CEO had put everyone, after Round 2 moved some",
        MK2 == MK and box()[P[UA][0]] != SNAP[P[UA][0]] and ctx(lambda d: a._tb_round1_view(d, [RA["id"]]))[RA["id"]]["marks"][P[UA][0]]
        ["perf"] == SNAP[P[UA][0]][0])
s.check("Round 2 superseded Round 1 with no new reader: the band every reader takes is Round 2's",
        ctx(lambda d: a.pm_effective_band(d, d.execute("SELECT * FROM users WHERE id=?", (P[UA][0],)).fetchone(), PER, None))["band"] == "OU")
s.check("the Group Chief's tier is untouched: no group session, group lock or group box row was written by any of it",
        [one("SELECT COUNT(*) FROM pm_calibration_sessions WHERE tier='group'"), one("SELECT COUNT(*) FROM pm_group_locks"),
         one("SELECT COUNT(*) FROM calibration_sessions WHERE tier='group'")] == GC0)

# ======================================================================================================================
s.section("Push to the BG CEO: a whole business group locked in one go, the unit comes back alone, the group locks again")
def lock_whole(bg_, c_):
    with c_.session_transaction() as ss:
        ss.pop("_flashes", None)
    return post(c_, "/talent-box/bg/%s/lock" % bg_, ajax="1")
rl = lock_whole(BG2, BOSS2C)
s.check("setup: the BG CEO locks the whole group on the classic lock (no unit rows, both sessions locked)", js(rl).get("ok") is True
        and sess_locked(BG2) == [1, 1] and lockrows(BG2) == set(), (js(rl), sess_locked(BG2), lockrows(BG2)))
SNAP2 = box(BG2)
r = actual(SUP, W1, 62, bg=BG2)
s.check("a unit of a locked group takes an actual (the group is locked): waiting", js(r).get("ok") and state(W1, BG2) == "waiting", js(r))
r = openr(SUP, W1, "bgceo", bg=BG2, due_on="2000-01-01")
s.check("a lock-by day in the past is refused", r.status_code == 400 and "past" in err(r) and state(W1, BG2) == "waiting", js(r))
r = openr(SUP, W1, "bgceo", bg=BG2, due_on="not a day")
s.check("...so is no day at all that can be read", r.status_code == 400, js(r))
BEFORE = {"w2": ctx(lambda d: a.pm_effective_band(d, d.execute("SELECT * FROM users WHERE id=?", (P2[W2][0],)).fetchone(), PER, None)),
          "nu": ctx(lambda d: a.pm_effective_band(d, d.execute("SELECT * FROM users WHERE id=?", (NU2,)).fetchone(), PER, None))}
r = openr(SUP, W1, "bgceo", bg=BG2)
R1 = rnd(W1, BG2)
dd = a._today_myt()
n_wd, d_ = 0, dd
while n_wd < 5:
    d_ += timedelta(days=1)
    n_wd += 1 if d_.weekday() < 5 else 0
s.check("pushed with no day given: due at the end of the 5th working day after today, MYT (stored UTC: 15:59:59)",
        js(r).get("ok") is True and R1["mode"] == "bgceo" and R1["due_at"] == d_.isoformat() + " 15:59:59"
        and state(W1, BG2) == "open", (js(r), R1))
s.check("the group's two sessions' lock is lifted, flagged on the round (cleared_bg_lock), and W1's lock row is gone",
        sess_locked(BG2) == [0, 0] and R1["cleared_bg_lock"] == 1 and W1 not in lockrows(BG2))
s.check("...every OTHER unit and the person with no unit got a lock row of their own, so their locked bands still count",
        lockrows(BG2) == {W2, ""}, lockrows(BG2))
AFTER = {"w2": ctx(lambda d: a.pm_effective_band(d, d.execute("SELECT * FROM users WHERE id=?", (P2[W2][0],)).fetchone(), PER, None)),
         "nu": ctx(lambda d: a.pm_effective_band(d, d.execute("SELECT * FROM users WHERE id=?", (NU2,)).fetchone(), PER, None))}
s.check("...the other unit's person and the no-unit person read the BG CEO's tier exactly as before (the group is no longer 'locked' as a whole)",
        {k: (v["band"], v["source"]) for k, v in AFTER.items()} == {k: (v["band"], v["source"]) for k, v in BEFORE.items()}
        and AFTER["w2"]["source"] == "bgceo", (BEFORE, AFTER))
exe("DELETE FROM talent_box_bu_locks WHERE business_group=? AND company=?", (BG2, W2))
fall = ctx(lambda d: a.pm_effective_band(d, d.execute("SELECT * FROM users WHERE id=?", (P2[W2][0],)).fetchone(), PER, None))
s.check("falsified: without that row the other unit's person would have fallen back to a lower tier",
        fall["source"] != "bgceo", fall)
exe("INSERT OR IGNORE INTO talent_box_bu_locks(period_id, cycle_id, business_group, company) VALUES (?,?,?,?)", (PER, CID, BG2, W2))
s.check("the other unit stays closed to its BU CEO and HOD while the group's own lock is lifted (its row stands in for it)",
        bool(ctx(lambda d: a._bg_closed(d, "both", PER, BG2, W2))) and bool(ctx(lambda d: a._bg_closed(d, "both", PER, BG2, W1))))
s.check("the push email: none queued while the server (stub) says it's configured but the seat's mail was queued once",
        len([e for e in emails() if "ZZR2 Whisky" in e["body"]]) == 1)
MAIL = [e for e in emails() if "ZZR2 Whisky" in e["body"]][0]
cname = ctx(lambda d: d.execute("SELECT name FROM cycles WHERE id=?", (CID,)).fetchone()[0])
names = [r["full_name"] for r in rows("SELECT full_name FROM users WHERE employee_id LIKE 'ZZR2-%'")]
s.check("the email goes to the seated BG CEO: subject 'PAT updated for 1 of your business units: <cycle> Talent Box to review'",
        MAIL["to_email"] == "zzr2-ce2@example.test" and MAIL["subject"] == "PAT updated for 1 of your business units: %s Talent Box to review" % cname
        and MAIL["user_id"] == BOSS2, MAIL["subject"])
low = MAIL["body"]
s.check("...its table: the unit, PAT 85% -> 62%, Normal -> Negatively skewed, the lock-by day, the button 'Open my Talent Box'",
        "ZZR2 Whisky" in low and "85%" in low and "62%" in low and "Normal" in low and "Negatively skewed" in low
        and "Open my Talent Box" in low and "Please lock by" in low and "placement" in low.lower())
s.check("...light only, white boxes, brand AI+ OneHR by Chin Hin",
        "color-scheme" in low and "light only" in low and 'bgcolor="#ffffff"' in low and "OneHR by Chin Hin" in low)
s.check("...and no staff name, no band, no count of people anywhere in it",
        not any(n in low for n in names if n != "ZZ R2 Two CEO") and not any(w in low for w in ("Super Star", "Solid Core", "PIP", "Star ", " people", "Low potential"))
        and not re.search(r"\b\d+ (?:people|person|staff|employees)\b", low), [n for n in names if n in low])
r = move(BOSS2C, P2[W1][0], perf="AE", bg=BG2)
s.check("the BG CEO moves a person of the pushed unit (the pin is cleared by the move; the placement started as Round 1)",
        js(r).get("ok") is True and bands(P2[W1][0], BG2)["pm"][0] == "AE" and bands(P2[W1][0], BG2)["pm"][1] is None
        and SNAP2[P2[W1][0]][0] == "ME", (js(r), SNAP2[P2[W1][0]]))
s.check("...and the unpinned person's pin (Round 1's placement) is still there", bands(P2[W1][1], BG2)["pm"][1] is not None
        and bands(P2[W1][1], BG2)["pm"][0] == SNAP2[P2[W1][1]][0])
r = move(BOSS2C, P2[W2][0], perf="AE", bg=BG2)
s.check("another unit's person is refused by its own lock, which now says which unit has Round 2 open",
        r.status_code == 400 and "is locked; Round 2 is open for ZZR2 Whisky" in err(r), js(r))
r = move(BOSS2C, NU2, perf="AE", bg=BG2)
s.check("a person with no unit is refused while the group's '' lock row stands (what the push of a whole-group lock left them)",
        r.status_code == 400 and "no business unit are locked" in err(r) and "Round 2 is open for ZZR2 Whisky" in err(r)
        and bands(NU2, BG2)["pm"][1] is not None, js(r))
s.check("...and the '' row is not a unit anywhere a locked unit is counted or listed",
        ctx(lambda d: set(a._tb_bu_locks(d, PER, BG2))) == {W2} and "" in lockrows(BG2),
        (ctx(lambda d: set(a._tb_bu_locks(d, PER, BG2))), lockrows(BG2)))
src2 = H.source(a)
s.check("...the dashboard's, the cycle line's and the units-locked counts leave the '' row out",
        src2.count("business_group=? AND company!='' AND locked_at IS NOT NULL") == 2
        and "WHERE period_id=? AND company!='' GROUP BY business_group" in src2)
exe("DELETE FROM talent_box_bu_locks WHERE business_group=? AND company=''", (BG2,))
r = move(BOSS2C, NU2, perf="AE", bg=BG2)
s.check("falsified: with that row gone the same person moves (the refusal is the row's, nothing else's)", js(r).get("ok") is True, js(r))
exe("INSERT OR IGNORE INTO talent_box_bu_locks(period_id, cycle_id, business_group, company) VALUES (?,?,?,'')", (PER, CID, BG2))
r = lockr(SUP, W1, bg=BG2, rid=R1["id"])
s.check("the super admin can't Lock it before its day: it is with the BG CEO", r.status_code == 400 and "with the BG CEO" in err(r)
        and state(W1, BG2) == "open", js(r))
r = tblock(BOSS2C, W1, bg=BG2)
whole = js(r)
s.check("the BG CEO's own Lock marks the round locked, locks the unit again, and the last unit locks the group again",
        whole.get("ok") is True and whole.get("whole") is True and state(W1, BG2) == "locked" and rnd(W1, BG2)["locked_by"] == BOSS2
        and sess_locked(BG2) == [1, 1] and W1 in lockrows(BG2), (whole, state(W1, BG2), sess_locked(BG2)))
s.check("...and the '' row is gone with the relock, in the same transaction: the group's own lock holds the people with no unit again",
        "" not in lockrows(BG2) and lockrows(BG2) == {W1, W2}, lockrows(BG2))
s.check("...so the count of locked units reads right after it (2 of 2)", one(
    "SELECT COUNT(*) FROM talent_box_bu_locks WHERE business_group=? AND company!=''", (BG2,)) == 2)
r = move(BOSS2C, P2[W1][0], perf="OU", bg=BG2)
s.check("...and it is closed to them again", r.status_code == 400 and "locked" in err(r))
exe("UPDATE late_passes SET closed_at=datetime('now') WHERE user_id=?", (BOSS2,))
BU = ctx(lambda d: a._bg_closed(d, "both", PER, BG2, W1))
s.check("a BU CEO or HOD stays closed on a unit with a Round 2 (_bg_closed)", bool(BU))
r = actual(SUP, W2, 62, bg=BG2)
s.check("Whisky's second unit takes an actual too (the group is locked again): waiting", js(r).get("ok") and state(W2, BG2) == "waiting", js(r))
exe("UPDATE pm_calibration_sessions SET locked_at=NULL WHERE tier='bgceo' AND scope_key=?", (BG2,))
exe("DELETE FROM talent_box_bu_locks WHERE business_group=?", (BG2,))
r = openr(SUP, W2, "admin", bg=BG2)
s.check("a unit unlocked since its actual was saved can't be opened (it has nothing locked to redo)", r.status_code == 400
        and "isn't locked" in err(r) and state(W2, BG2) == "waiting", js(r))
exe("UPDATE pm_calibration_sessions SET locked_at=CURRENT_TIMESTAMP, locked_by=? WHERE tier='bgceo' AND scope_key=?", (BOSS2, BG2))
exe("INSERT OR IGNORE INTO talent_box_bu_locks(period_id, cycle_id, business_group, company) VALUES (?,?,?,?)", (PER, CID, BG2, W1))
exe("INSERT OR IGNORE INTO talent_box_bu_locks(period_id, cycle_id, business_group, company) VALUES (?,?,?,?)", (PER, CID, BG2, W2))
with a.app.test_request_context("/"):
    ok_, msg_ = a._unlock_scope(a.get_db(), SUROW, "bgceo", BG2)
s.check("Unlock of the whole group (Round 1 starts again) clears its rounds and the Round 1 record with the pins they described",
        ok_ and one("SELECT COUNT(*) FROM tb_rounds WHERE business_group=?", (BG2,)) == 0
        and one("SELECT COUNT(*) FROM tb_round1_marks WHERE round_id NOT IN (SELECT id FROM tb_rounds)") == 0 and W1 not in lockrows(BG2), (ok_, msg_))
r = actual(SUP, W2, 70, bg=BG2)
s.check("...and an unlocked unit takes no actual again until the BG CEO locks it", r.status_code == 400 and "hasn't locked" in err(r), js(r))


# ======================================================================================================================
s.section("Apply all on a big fit: 31 moves, each through the move writer (it resolves the box per move)")
import time  # noqa: E402
rl = tblock(BOSS3C, UT, bg=BG3)
r = actual(SUP, UT, 62, bg=BG3)
r = openr(SUP, UT, "bgceo", bg=BG3, due_on=(a._today_myt() + timedelta(days=3)).isoformat())
s.check("setup: a unit of 32 people locked, shifted and pushed", js(rl).get("ok") and js(r).get("ok") and state(UT, BG3) == "open", (js(rl), js(r)))
sgT = js(BOSS3C.get("/talent-box/round2/suggest?bg=%s&company=%s" % (BG3, UT)))
t0 = time.perf_counter()
apT = post(BOSS3C, "/talent-box/round2/apply", bg=BG3, company=UT, moves=json.dumps(sgT["moves"]))
secs = time.perf_counter() - t0
print("        Apply all, %d moves: %.2f s" % (len(sgT["moves"]), secs))
s.check("31 suggested moves, all 31 applied (%.2f s, under 10)" % secs, len(sgT["moves"]) == 31 and js(apT).get("applied") == 31 and secs < 10
        and js(apT).get("skipped") == 0, (len(sgT["moves"]), js(apT)))

# ======================================================================================================================
s.section("Push to the BG CEO, Talent Box window closed: a late pass until its day; the BG CEO moves only the round's units")
exe("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,'tb_bgceo',?,?)",
    (CID, (a._now_myt() - timedelta(days=9)).strftime("%Y-%m-%d %H:%M"), (a._now_myt() - timedelta(days=2)).strftime("%Y-%m-%d %H:%M")))
r = move(BOSSC, P[UC][2], perf="AE")
s.check("setup: the window is closed, so the BG CEO is refused anywhere until a pass", r.status_code in (400, 409) and "closed" in err(r), (r.status_code, js(r)))
r = move(SUP, P[UC][2], perf="AE", remark="ZZR2 a Round 1 move by the super admin")
s.check("...and so is the super admin on a unit that has no Round 2 (the writer holds them to the window: no round, no way round it)",
        r.status_code == 400 and "closed" in err(r) and bands(P[UC][2])["pm"] is None, (r.status_code, js(r)))
DUE_F = (a._today_myt() + timedelta(days=6)).isoformat()
r = openr(SUP, UF, "bgceo", due_on=DUE_F)
RF = rnd(UF)
pass_ = rows("SELECT * FROM late_passes WHERE user_id=? AND cell='tb_bgceo' AND closed_at IS NULL", (BOSS,))
s.check("the late pass's reason is fixed words, never the super admin's remark (the leader reads it)",
        len(pass_) == 1 and pass_[0]["reason"] == "Talent Box Round 2: PAT updated for ZZR2 Foxtrot" and REASON not in pass_[0]["reason"]
        and "ZZR2 the actual" not in pass_[0]["reason"], pass_ and pass_[0]["reason"])
s.check("F pushed: its lock row gone; the BG isn't whole-locked so nothing cleared; a late pass for the group until the end of the lock-by day",
        js(r).get("ok") is True and UF not in lockrows() and RF["cleared_bg_lock"] == 0 and len(pass_) == 1
        and pass_[0]["scope_key"] == BG and pass_[0]["until_at"] == DUE_F + " 15:59:59" and RF["due_at"] == DUE_F + " 15:59:59", (js(r), pass_))
def src_of(sid):
    return ctx(lambda d: a.pm_effective_band(d, d.execute("SELECT * FROM users WHERE id=?", (sid,)).fetchone(), PER, None)["source"])
s.check("rule 11: while F is with the BG CEO its people read a LOWER tier (the unit is open again, as before its Round 1 lock); every "
        "locked unit's people still read the BG CEO's tier",
        src_of(P[UF][3]) != "bgceo" and src_of(P[UA][3]) == "bgceo" and src_of(P[UB][0]) == "bgceo", (src_of(P[UF][3]), src_of(P[UA][3])))
bgc = ctx(lambda d: a._bg_closed(d, "both", PER, BG, UB))
s.check("...and BU CEO / HOD stay closed on the other locked units", bool(bgc))
r = openr(SUP, UG, "bgceo", due_on=a._today_myt().isoformat())
RG = rnd(UG)
s.check("G pushed to lock today", js(r).get("ok") is True and state(UG) == "open" and UG not in lockrows(), js(r))
em = [e for e in emails() if e["to_email"] == "zzr2-ceo@example.test"]
s.check("each push queued its own email to the seated BG CEO (the subject names the cycle)", len(em) == 2
        and all(e["subject"].startswith("PAT updated for 1 of your business units") for e in em)
        and RF["emailed_at"] and RG["emailed_at"], [e["subject"] for e in em])
r = move(BOSSC, P[UF][0], perf="AE")
s.check("the BG CEO moves F's person: the pass lets them through the closed window", js(r).get("ok") is True
        and bands(P[UF][0])["pm"][0] == "AE", js(r))
r = move(BOSSC, P[UG][0], perf="AE")
s.check("...and G's person (the other pushed unit)", js(r).get("ok") is True)
r = move(BOSSC, P[UA][3], perf="AE")
s.check("a locked unit's person (Alpha) is refused by its lock, saying which units have Round 2 open", r.status_code == 400
        and "is locked; Round 2 is open for ZZR2 Foxtrot, ZZR2 Golf" in err(r) and bands(P[UA][3])["pm"][0] == "BE", js(r))
r = move(BOSSC, P[UC][2], perf="OU")
s.check("a unit still in Round 1 (Gamma, not locked) stays movable while a Round 2 is open, exactly as before",
        js(r).get("ok") is True and bands(P[UC][2])["pm"][0] == "OU", js(r))
r = move(BOSSC, NU1, perf="AE")
s.check("a person with no unit moves too here: no '' row stands (the group was not locked whole), so nothing holds them",
        js(r).get("ok") is True and bands(NU1)["pm"][0] == "AE", js(r))
r = tblock(BOSSC, None)
s.check("the whole-group lock is refused while a Round 2 is open (lock its unit first)", r.status_code == 400 and "Round 2 is still open" in err(r)
        and sess_locked() == [0, 0], js(r))
r = move(SUP, P[UF][3], perf="AE", rid=RF["id"])
s.check("the super admin moving a PUSHED unit before its lock-by day is refused: 'Round 2 for Foxtrot is with the BG CEO until <date>'",
        r.status_code == 400 and "Round 2 for ZZR2 Foxtrot is with the BG CEO until" in err(r) and bands(P[UF][3])["pm"][1] is not None, js(r))
r = lockr(SUP, UF, rid=RF["id"])
s.check("the super admin can't Lock F before its day", r.status_code == 400 and "with the BG CEO" in err(r) and state(UF) == "open", js(r))
# suggest / apply for the BG CEO on a pushed unit
sg = BOSSC.get("/talent-box/round2/suggest?bg=%s&company=%s" % (BG, UF))
J = js(sg)
s.check("Suggest (the seated BG CEO, their pushed unit): the proposal, read against the actual curve, no name beyond their own people",
        sg.status_code == 200 and J.get("ok") and sorted(m["id"] for m in J["moves"]) == [P[UF][1]] and J["curve_key"] == "negative"
        and sorted(SEEN_FIT[-1][0]) == sorted(P[UF]) and J["unit"], J)
sg2 = BOSSC.get("/talent-box/round2/suggest?bg=%s&company=%s" % (BG, UA))
s.check("...not for a unit that isn't theirs to redo (Alpha: no open round)", sg2.status_code == 400, js(sg2))
sg3 = BOSS2C.get("/talent-box/round2/suggest?bg=%s&company=%s" % (BG, UF))
s.check("...nor for another business group's BG CEO", sg3.status_code == 400, js(sg3))
sg4 = SUP.get("/talent-box/round2/suggest?bg=%s&company=%s" % (BG, UF))
s.check("the super admin may read the suggestion of a pushed unit too (read only)", sg4.status_code == 200 and js(sg4).get("ok"))
apx = post(SUP, "/talent-box/round2/apply", bg=BG, company=UF, moves=json.dumps(J["moves"]), remark=REASON)
s.check("...but not apply it while it is the BG CEO's: Apply is the BG CEO's before the day", apx.status_code == 400
        and "Round 2 for ZZR2 Foxtrot is with the BG CEO until" in err(apx) and bands(P[UF][1])["pm"][0] == "ME", js(apx))
# a stale move: the person is moved by hand after the suggestion was drawn
extra = {"id": P[UF][2], "from": "ME", "to": "AE"}   # never proposed (he sits at AE): an invented move
r = move(BOSSC, P[UF][1], perf="OU")
ap = post(BOSSC, "/talent-box/round2/apply", bg=BG, company=UF, moves=json.dumps(J["moves"] + [extra]))
s.check("Apply all after the person was moved by hand, with an invented move besides: the server works the fit out again and "
        "skips both (0 applied, 2 skipped); the hand move stands", js(ap).get("ok") and js(ap)["applied"] == 0 and js(ap)["skipped"] == 2
        and bands(P[UF][1])["pm"][0] == "OU" and bands(P[UF][2])["pm"][0] == "AE", js(ap))
r = move(BOSSC, P[UF][1], perf="ME")   # back to where the stand-in proposes from
J2 = js(BOSSC.get("/talent-box/round2/suggest?bg=%s&company=%s" % (BG, UF)))
ap = post(BOSSC, "/talent-box/round2/apply", bg=BG, company=UF, moves=json.dumps(J2["moves"]))
s.check("Apply all with what they were shown: applied through the move writer (1 applied), the move is the BG CEO's own (no remark)",
        js(ap).get("ok") and js(ap)["applied"] == 1 and bands(P[UF][1])["pm"][0] == "AE" and bands(P[UF][1])["pm"][1] is None
        and in_log("tb_round_fit_apply", "applied 1 move"), js(ap))
apb = post(EMPC, "/talent-box/round2/apply", bg=BG, company=UF, moves=json.dumps(J2["moves"]))
s.check("an employee's Apply is refused", apb.status_code == 400 and bands(P[UF][1])["pm"][0] == "AE", js(apb))
exe("INSERT OR REPLACE INTO leader_role_access(role, ability, allowed) SELECT 'bg', 'bg.fit', 0 WHERE 1")
sgx = BOSSC.get("/talent-box/round2/suggest?bg=%s&company=%s" % (BG, UF))
s.check("the seat's bg.fit switch (Leader roles) stops Suggest", sgx.status_code == 400 and "switched off" in err(sgx), js(sgx))
exe("DELETE FROM leader_role_access WHERE role='bg' AND ability='bg.fit'")
s.check("...and it is a row on the Leader roles page (a new leader action gets its key)", any(x[1] == "bg.fit" for x in a.LEADER_ABILITIES)
        and "bg.fit" in a.LEADER_ABILITY_LABEL)
# release gate while open, and the BU CEO / HOD stay closed
fl = release(P[UF][3])
s.check("release refused for a unit whose Round 2 is open (Foxtrot)", "Talent Box Round 2" in fl and "Foxtrot" in fl, fl)
BUC = ctx(lambda d: a._bg_closed(d, "both", PER, BG, UF))
s.check("a BU CEO or HOD stays closed on the pushed unit while its lock row is gone", bool(BUC))
# remind
n0 = len(emails())
r = post(SUP, URL + "remind", bg=BG, company=UF)
em = emails()
s.check("Remind: the same email again to whoever holds the seat, its subject saying Reminder; the time stamped",
        js(r).get("ok") is True and len(em) == n0 + 1 and em[-1]["subject"].startswith("Reminder: PAT updated for 1 of your business units")
        and em[-1]["to_email"] == "zzr2-ceo@example.test" and rnd(UF)["reminded_at"], js(r))
r = post(SUP, URL + "remind", bg=BG, company=UA)
s.check("...nobody to remind on a unit that isn't pushed", r.status_code == 400)
# after the day
exe("UPDATE tb_rounds SET due_at=? WHERE id=?", (past, RG["id"]))
s.check("G's lock-by day passes: its state is 'due'; F is still open", state(UG) == "due" and state(UF) == "open")
r = move(BOSSC, P[UG][1], perf="OU")
s.check("the BG CEO is refused on G after the day: 'Round 2 closed on ...; Group People finish it'", r.status_code == 400
        and "closed on" in err(r) and "Group People" in err(r) and bands(P[UG][1])["pm"][1] is not None, js(r))
r = tblock(BOSSC, UG)
s.check("...and refused G's Lock too", r.status_code == 400 and "closed on" in err(r) and state(UG) == "due", js(r))
r = post(SUP, URL + "remind", bg=BG, company=UG)
s.check("...and there is nobody to remind once it is due", r.status_code == 400)
fl = release(P[UG][2])
s.check("release is refused for a unit whose Round 2 is due", "Talent Box Round 2" in fl and "Golf" in fl, fl)
sgd = BOSSC.get("/talent-box/round2/suggest?bg=%s&company=%s" % (BG, UG))
s.check("the BG CEO's Suggest is refused after the day too", sgd.status_code == 400 and "closed on" in err(sgd), js(sgd))
r = move(BOSSC, P[UF][2], perf="OU")
s.check("falsified: F, not due, still moves for the BG CEO in the same breath", js(r).get("ok") is True)
r = move(SUP, P[UG][2], perf="OU")
s.check("the super admin finishes G on the card after the day: with no remark and no round, the remark gate asks", r.status_code == 400
        and "remark" in err(r), (r.status_code, js(r)))
r = move(SUP, P[UG][2], perf="OU", rid=RG["id"])
s.check("...naming the round, it moves (the round's remark carried), the closed window and the lapsed pass notwithstanding",
        js(r).get("ok") is True and bands(P[UG][2])["pm"][0] == "OU" and bands(P[UG][2])["pm"][2] == REASON,
        (r.status_code, js(r), bands(P[UG][2])))
sga = SUP.get("/talent-box/round2/suggest?bg=%s&company=%s" % (BG, UG))
apg = post(SUP, "/talent-box/round2/apply", bg=BG, company=UG, moves=json.dumps(js(sga)["moves"]), round_id=str(RG["id"]))
s.check("...and Apply all is the super admin's once it is due (the one ME person, proposed to AE, applied)",
        js(apg).get("ok") and [m["id"] for m in js(sga)["moves"]] == [P[UG][1]] and js(apg)["applied"] == 1
        and bands(P[UG][1])["pm"][0] == "AE", (js(sga), js(apg)))
r = lockr(SUP, UG, rid=RG["id"])
s.check("Lock Round 2 by the super admin finishes it: state 'locked', the unit's lock row is back, locked by them",
        js(r).get("ok") is True and state(UG) == "locked" and UG in lockrows() and rnd(UG)["locked_by"] == SU["id"], js(r))
r = tblock(BOSSC, UF)
s.check("rule 11: once the BG CEO locks it again, F's people read the BG CEO's tier again", js(r).get("ok") is True and src_of(P[UF][3]) == "bgceo")
s.check("the BG CEO's Lock of F: the round is locked by them; the group is not whole (Gamma is not locked)",
        js(r).get("ok") is True and js(r).get("whole") is False and state(UF) == "locked" and rnd(UF)["locked_by"] == BOSS
        and sess_locked() == [0, 0], js(r))
fl = release(P[UF][3])
s.check("release is no longer held for F once it is locked (the gate's own words are gone)", "Talent Box Round 2" not in fl and fl, fl)
s.check("the late pass still stands: the group isn't whole-locked, Gamma is open",
        one("SELECT COUNT(*) FROM late_passes WHERE user_id=? AND cell='tb_bgceo' AND closed_at IS NULL", (BOSS,)) == 1)
fl = release(P[UA][4])
s.check("release is no longer held for Alpha once its Round 2 is locked", "Talent Box Round 2" not in fl and fl, fl)
s.check("Group Chief tier untouched through the push, the lock-row delete and the clearing",
        [one("SELECT COUNT(*) FROM pm_calibration_sessions WHERE tier='group'"), one("SELECT COUNT(*) FROM pm_group_locks"),
         one("SELECT COUNT(*) FROM calibration_sessions WHERE tier='group'")] == GC0)

# ======================================================================================================================
s.section("the email template, Cycle > Emails, and the access page")
k = a.EMAIL_TPL_KIND.get("tb_round2")
s.check("an email kind of its own, before the shared spec of Your own emails, with the plan's fields and placeholders",
        k and k["title"] == "Talent Box · PAT updated" and a.EMAIL_TPL_KINDS[-1]["key"] == "own"
        and [x["key"] for x in a.EMAIL_TPL_KINDS][-2] == "tb_round2"
        and k["placeholders"] == ("display_name", "first_name", "full_name", "cycle", "count", "due"), k and k["placeholders"])
KEPT_TPL = ctx(lambda d: H.stash_email_templates(d))
ctx(lambda d: a._email_tpl_ensure(d, "tb_round2"))
w = ctx(lambda d: a.email_tpl_words("tb_round2", db=d))
s.check("its words are the plan's, read through email_tpl_words; a word OneHR doesn't fill is refused when saved",
        w == a.TB_ROUND_TPL_DEFAULT and w["subject"].startswith("PAT updated for {count} of your business units")
        and a._tpl_words_from({"opening": "Hi {nonsense}"}, k["fields"], k["placeholders"], dict(w), k["multiline"])[1])
smp = ctx(lambda d: a.email_tpl_sample(d, "tb_round2", w, SUROW))
s.check("Cycle > Emails' sample renders from made-up units, addressed to the admin", smp and "Sample unit A" in smp[1]
        and smp[0].startswith("PAT updated for 2 of your business units"), smp and smp[0])
s.check("the emails page lists it", "Talent Box · PAT updated" in SUP.get("/admin/emails").get_data(as_text=True))
ctx(lambda d: H.restore_email_templates(d, KEPT_TPL))

# ======================================================================================================================
s.section("put back what this suite changed")
a._pm_calib_fit_moves = _real_fit
exe("DELETE FROM late_passes WHERE user_id IN (?,?)", (BOSS, BOSS2))
with a.app.test_request_context("/"):   # the shared suite database as this suite found it
    db = a.get_db()
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZR2-%'")]
    ph = ",".join("?" * len(ids))
    for tb in ("leader_releases", "result_releases", "talent_releases", "rating_records", "tb_insights", "talent_status_history",
               "talent_box_remarks"):
        try:
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (tb, ph), ids)
        except Exception:   # noqa: BLE001 -- a table this database lacks
            db.rollback()
    db.execute("DELETE FROM tb_round1_marks WHERE round_id IN (SELECT id FROM tb_rounds WHERE business_group IN (?,?,?))", (BG, BG2, BG3))
    db.execute("DELETE FROM tb_rounds WHERE business_group IN (?,?,?)", (BG, BG2, BG3))
    db.execute("DELETE FROM talent_box_bu_locks WHERE business_group IN (?,?,?)", (BG, BG2, BG3))
    db.execute("DELETE FROM pm_pat_lock_flags WHERE business_group IN (?,?,?)", (BG, BG2, BG3))
    db.execute("DELETE FROM pm_pbt_achievement WHERE business_group IN (?,?,?)", (BG, BG2, BG3))
    db.execute("DELETE FROM calib_unit_joins WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?,?)", (BG, BG2, BG3))
    for tb, mx in _ORIG["max"].items():
        db.execute("DELETE FROM %s WHERE id>?" % tb, (mx,))
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZR2-%'")
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='tb_bgceo'", (CID,))
    for w_ in _ORIG["windows"]:
        db.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w_), ",".join("?" * len(w_))), list(w_.values()))
    db.execute("UPDATE cycles SET half=? WHERE id=?", (_ORIG["half"], CID))
    for k_, v in _ORIG["settings"].items():
        if v is None:
            db.execute("DELETE FROM app_settings WHERE key=?", (k_,))
        else:
            db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)", (k_, v))
    for k_, v in _ORIG["modules"].items():
        db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, CID, k_))
    db.commit()
s.check("nothing of this suite is left behind", one("SELECT COUNT(*) FROM users WHERE employee_id LIKE 'ZZR2-%'") == 0
        and one("SELECT COUNT(*) FROM tb_rounds") == 0 and one("SELECT COUNT(*) FROM tb_round1_marks") == 0
        and one("SELECT COUNT(*) FROM org_units WHERE business_group IN (?,?,?)", (BG, BG2, BG3)) == 0)
sys.exit(s.done())
