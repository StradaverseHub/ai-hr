"""A calibrator holds no HOD role (Chris, 2026-10-28, widened 2026-10-30).

Two rules, one suite:

  A. The Profile's HOD row is labelled by the HOD's own job title when that HOD holds a BU CEO seat or is a BG CEO
     (Group CEO / CEO / COO / MD / ED / Director, else "Head of unit" / "Head of group"). An ordinary HOD, a calibrator
     and a Group Chief keep "HOD"; the value (the name) and `hod_hidden` are unchanged. (hod_id is org data and STAYS.)
  B. "If a person is marked as calibrator, then this role will supersede HOD role": anyone who holds a BU CEO seat, a BU
     calibration group, a BG CEO seat or a Group Chief group has NO HOD role at all, in every cycle type, whether their
     department sits wholly or only partly inside their seat. No Dept tab, no Department Review card, not named on the
     "HODs not done" line, no HOD notice or reminder, not counted as an HOD, no /hod table, no HOD route. Their
     department's people skip the Dept step. ONE helper (`_hod_review_holders` / `hod_has_role`) feeds every reader;
     an ordinary HOD keeps the review exactly as before.
  C. GRADE H is the one exception (Chris, 2026-11-03, "Yes, allow for Grade H"): a calibration seat of the normal review (a BU
     calibration group's calibrator, a Group Chief group's) takes no Grade H HOD role away; a BU CEO or BG CEO seat still does.
     `gradeh_hod_has_role` is the Grade H twin of `hod_has_role`, from the same read (`_hod_seat_kinds`); a source lint keeps every
     Grade H reader on the twin and every normal-review reader on `hod_has_role` / `_hod_ids_with_review`.

Fresh database (fresh_db=True): its own synthetic groups ("ZZCH ..."), put back by the harness at the end.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("A calibrator holds no HOD role: the Profile label, and no Department Review for a BU CEO, BG CEO, CG calibrator or Group Chief")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
NAV = {"Sec-Fetch-Mode": "navigate"}
a.ai_draft.review_agent_available = lambda: True      # _calib_assist_on needs a model reachable
BG, BG2 = "ZZCH Group", "ZZCH Group Two"
UA, UM, UB, UG = "ZZCH Unit A", "ZZCH Unit M", "ZZCH Unit B", "ZZCH Unit G"
DG, DZ = "ZZCH Dept G", "ZZCH Dept Z"

with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CID = a.active_cycle_id(db)
    PID = a.active_pm_period(db)["id"]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))   # the review's higher tiers are the Year-End's
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','calibration','pm','tm')")
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN ('pm_hod','pot_hod')", (CID,))
    for k in ("ai_calib", "review_unified"):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k,))
    for k in ("calib_lock_strict", "calib_tol_mode", "calib_tol_people", "dept_review_due"):
        db.execute("DELETE FROM app_settings WHERE key=?", (k,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND business_group!='' "
                           "AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=UB, department=DZ,
                 job_title="ZZCH Officer")
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
    CEO1 = person("ZZCH-CEO1", "ZZ CH Ceo One", company=UA, buceo_bg=BG, buceo_company=UA,
                  job_title="Chief Executive Officer")
    CEO2 = person("ZZCH-CEO2", "ZZ CH Ceo Two", company=UM, buceo_bg=BG, buceo_company=UM, job_title="Head of Retail")
    CAL = person("ZZCH-CAL", "ZZ CH Calibrator")
    BGC = person("ZZCH-BGC", "ZZ CH Bg Ceo", business_group=BG2, company=UG, bgceo_bg=BG2, job_title="")
    GCH = person("ZZCH-GCH", "ZZ CH Group Chief")
    ORD = person("ZZCH-ORD", "ZZ CH Ordinary Hod")
    PA = [person("ZZCH-PA%d" % i, "ZZ CH A %d" % i, company=UA, hod_id=CEO1, department="ZZCH Dept A") for i in range(3)]
    PM_ = [person("ZZCH-PM%d" % i, "ZZ CH M %d" % i, company=UM, hod_id=CEO2, department="ZZCH Dept M") for i in range(2)]
    PMB = [person("ZZCH-PB%d" % i, "ZZ CH B %d" % i, hod_id=CEO2) for i in range(2)]         # CEO2's, another unit
    PC = [person("ZZCH-PC%d" % i, "ZZ CH C %d" % i, hod_id=CAL, department=DG) for i in range(2)]   # in CAL's group
    PD = [person("ZZCH-PD0", "ZZ CH D 0", hod_id=CAL)]                                            # not in it
    PG = [person("ZZCH-PG%d" % i, "ZZ CH G %d" % i, business_group=BG2, company=UG, hod_id=BGC) for i in range(2)]
    PGX = [person("ZZCH-PGX", "ZZ CH G X", hod_id=BGC)]                                          # another group
    PH = [person("ZZCH-PH%d" % i, "ZZ CH H %d" % i, hod_id=GCH) for i in range(3)]               # 0, 1 in the Group Chief's
    PO = [person("ZZCH-PO%d" % i, "ZZ CH O %d" % i, hod_id=ORD) for i in range(2)]
    ALL = PA + PM_ + PMB + PC + PD + PG + PGX + PH + PO
    for pid in ALL:   # a scorecard each, so they are in the PERFORMANCE population too
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, "
                   "company) SELECT ?,id,?,?,?,business_group,company FROM users WHERE id=?",
                   (PID, "ZZCH KPI", 100, "more", pid))
    # a BU calibration group: CAL calibrates Dept G of Unit B
    gid = db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)",
                     (BG, UB, "ZZCH Group Panel", CAL)).lastrowid
    db.execute("INSERT INTO calib_bu_group_units(group_id, business_group, company, department) VALUES (?,?,?,?)",
               (gid, BG, UB, DG))
    # a Group Chief's group with two of GCH's people
    gcid = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZCH GC GROUP', ?)", (GCH,)).lastrowid
    for pid in PH[:2]:
        db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id) VALUES (?,?)", (gcid, pid))
    # a 360 panel line each, so the HOD table (/hod) has people to list for the ones who still hold the role
    for pid in ALL:
        db.execute("INSERT OR IGNORE INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?,'peer')",
                   (CID, pid, ORD))
    db.commit()
    NAMES = {pid: db.execute("SELECT full_name FROM users WHERE id=?", (pid,)).fetchone()[0] for pid in ALL}


def user(uid):
    with a.app.test_request_context("/"):
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def q(sql, args=()):
    with a.app.test_request_context("/"):
        return a.get_db().execute(sql, args).fetchone()


def ex(sql, args=()):
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute(sql, args)
        db.commit()


def set_half(h):
    ex("UPDATE cycles SET half=? WHERE id=?", (h, CID))


# ---------------------------------------------------------------------------
s.section("A. the Profile's label for an HOD who is a CEO")
L = a._head_title_label
rows = [("Group Chief Executive Officer", True, "Group CEO"), ("GROUP CHIEF EXECUTIVE OFFICER, RETAIL", False, "Group CEO"),
        ("Chief Executive Officer", False, "CEO"), ("  chief   executive officer - Property ", True, "CEO"),
        ("Chief Operating Officer", False, "COO"), ("Managing Director", False, "MD"),
        ("Managing Director, Malaysia", True, "MD"), ("Executive Director", False, "ED"),
        ("executive director (Finance)", False, "ED"), ("Company Director", False, "Director"),
        ("Director of Operations", False, "Director"), ("Deputy Managing Director", False, "Head of unit"),
        ("Senior Director", True, "Head of group"), ("Head of Retail", False, "Head of unit"),
        ("Head of Retail", True, "Head of group"), ("", False, "Head of unit"), (None, True, "Head of group"),
        ("   ", False, "Head of unit"), ("Group Chief Financial Officer", False, "Group CFO"),
        ("Group Chief Financial Officer", True, "Group CFO")]
for title, bgs, want in rows:
    s.check("%r%s -> %s" % (title, " (BG CEO)" if bgs else "", want), L(title, bgs) == want, L(title, bgs))


# _chief_title_short (Chris, 2026-10-30): a Chief officer title reads its short form
C = a._chief_title_short
for title, want in (("Group Chief Executive Officer", "Group CEO"), ("Group Chief Financial Officer", "Group CFO"),
                    ("Group Chief Transformation Officer", "Group CTrO"), ("Group Chief Synergy Officer", "Group CSO"),
                    ("Group Chief Risk Officer", "Group CRO"), ("Group Chief Technology Officer", "Group CTO"),
                    ("Chief Financial Officer (Chin Hin Building Materia", "CFO"), ("Chief Finance Officer", "CFO"),
                    ("Chief Operating Officer", "COO"), ("Chief Executive Officer", "CEO"),
                    ("chief  people & culture officer", "CPCO"), ("Chief Financial Officer, Retail", "CFO"),
                    ("Chief Financial Officer - Property", "CFO"), ("Chief Transformation Officer", "CTrO"),
                    ("Chief Strategy and Technology Officer", "CSTO"),
                    ("Chief Foreman", None), ("Deputy Chief Financial Officer", None), ("Assistant Chief Officer", None),
                    ("Chief Officer", None), ("Head of Department", None), ("Managing Director", None),
                    ("Chief Financial Officership", None), ("", None), (None, None), ("   ", None)):
    s.check("_chief_title_short(%r) -> %r" % (title, want), C(title) == want, C(title))


def profile_dt(uid):
    b = H.client_as(a, uid).get("/profile", headers=NAV).get_data(as_text=True)
    rowm = re.findall(r'<dt>(?:<abbr title="([^"]*)">)?([^<]+)(?:</abbr>)?</dt><dd([^>]*)>([^<]*)</dd>', b)
    return {k: (cls, v) for _tip, k, cls, v in rowm}, b


def hod_tip_of(uid):
    b = profile_dt(uid)[1]
    m = re.search(r'<dt><abbr title="([^"]*)">([^<]+)</abbr></dt><dd', b)
    return (m.group(2), m.group(1)) if m else None


def head_row(uid):
    d, _b = profile_dt(uid)
    for k in ("Group CEO", "Group CFO", "Group CTrO", "CEO", "COO", "MD", "ED", "Director", "Head of unit", "Head of group", "HOD"):
        if k in d:
            return k, d[k]
    return None, None


lab, val = head_row(PA[0])
s.check("the rendered /profile: a BU CEO whose title is Chief Executive Officer is labelled CEO, with their name as the "
        "value", lab == "CEO" and val[1] == a.proper_name(NAMES.get(CEO1) or user(CEO1)["full_name"]), (lab, val))
for title, want in (("Group Chief Executive Officer", "Group CEO"), ("Chief Operating Officer", "COO"),
                    ("Managing Director", "MD"), ("Executive Director", "ED"), ("Company Director", "Director"),
                    ("Head of Retail", "Head of unit"), ("", "Head of unit")):
    ex("UPDATE users SET job_title=? WHERE id=?", (title, CEO1))
    s.check("...a BU CEO titled %r reads %s on the page" % (title, want), head_row(PA[0])[0] == want, head_row(PA[0]))
ex("UPDATE users SET job_title='Chief Executive Officer' WHERE id=?", (CEO1,))
lab, val = head_row(PG[0])
s.check("a BG CEO with no title reads Head of group", lab == "Head of group", (lab, val))
ex("UPDATE users SET job_title='Managing Director' WHERE id=?", (BGC,))
s.check("...a BG CEO titled Managing Director reads MD", head_row(PG[0])[0] == "MD", head_row(PG[0]))
ex("UPDATE users SET job_title='' WHERE id=?", (BGC,))
ex("UPDATE users SET buceo_bg=?, buceo_company=? WHERE id=?", (BG2, UG, BGC))
s.check("...someone who is BOTH a BU CEO and a BG CEO takes the BG fallback (Head of group)",
        head_row(PG[0])[0] == "Head of group", head_row(PG[0]))
ex("UPDATE users SET buceo_bg=NULL, buceo_company=NULL WHERE id=?", (BGC,))
ex("DELETE FROM buceo_seats WHERE user_id=?", (BGC,))
lab, val = head_row(PO[0])
s.check("an ordinary HOD stays HOD", lab == "HOD", (lab, val))
lab, val = head_row(PC[0])
s.check("a calibrator who is the person's HOD stays HOD (their title is never read)", lab == "HOD", (lab, val))
ex("UPDATE users SET job_title='Head of Finance' WHERE id=?", (CAL,))
s.check("...even titled Head of Finance", head_row(PC[0])[0] == "HOD", head_row(PC[0]))
ex("UPDATE users SET job_title='Chief Executive Officer' WHERE id=?", (CAL,))
s.check("...but a Chief officer title names them even with no seat (Chris, 2026-10-30): CEO, with the full title on hover",
        head_row(PC[0])[0] == "CEO" and hod_tip_of(PC[0]) == ("CEO", "Chief Executive Officer"), (head_row(PC[0]), hod_tip_of(PC[0])))
lab, val = head_row(PH[2])
s.check("a Group Chief who is the person's HOD stays HOD", lab == "HOD", (lab, val))
# a Chief officer title, with and without a seat (Chris, 2026-10-30)
ex("UPDATE users SET job_title='Group Chief Transformation Officer' WHERE id=?", (CAL,))
s.check("no seat, Group Chief Transformation Officer: Group CTrO, full title on hover",
        head_row(PC[0])[0] == "Group CTrO" and hod_tip_of(PC[0]) == ("Group CTrO", "Group Chief Transformation Officer"),
        (head_row(PC[0]), hod_tip_of(PC[0])))
s.check("...and the HOD's name is still the value", head_row(PC[0])[1][1] == a.proper_name(NAMES.get(CAL) or user(CAL)["full_name"]), head_row(PC[0]))
for title in ("Chief Foreman", "Managing Director", "Deputy Chief Financial Officer", ""):
    ex("UPDATE users SET job_title=? WHERE id=?", (title, CAL))
    s.check("no seat, titled %r: plain HOD, no abbr" % title, head_row(PC[0])[0] == "HOD" and hod_tip_of(PC[0]) is None,
            (head_row(PC[0]), hod_tip_of(PC[0])))
ex("UPDATE users SET job_title='Group Chief Financial Officer' WHERE id=?", (CEO1,))
s.check("a seat holder titled Group Chief Financial Officer reads Group CFO, full title on hover",
        head_row(PA[0])[0] == "Group CFO" and hod_tip_of(PA[0]) == ("Group CFO", "Group Chief Financial Officer"),
        (head_row(PA[0]), hod_tip_of(PA[0])))
ex("UPDATE users SET job_title='Chief Executive Officer' WHERE id=?", (CEO1,))
s.check("a seat holder titled Chief Executive Officer: CEO with the abbr title", hod_tip_of(PA[0]) == ("CEO", "Chief Executive Officer"), hod_tip_of(PA[0]))
ex("UPDATE users SET job_title='Head of Retail' WHERE id=?", (CEO1,))
s.check("a seat holder with an ordinary title: Head of unit, also with the full title on hover",
        hod_tip_of(PA[0]) == ("Head of unit", "Head of Retail"), hod_tip_of(PA[0]))
ex("UPDATE users SET job_title='Chief Executive Officer' WHERE id=?", (CEO1,))
with a.app.test_request_context("/"):
    rec = a.profile_record(a.get_db(), user(PO[0]))
s.check("an ordinary HOD: hod_tip None", rec["hod_label"] == "HOD" and rec["hod_tip"] is None, rec)
ex("UPDATE users SET job_title='ZZCH Officer' WHERE id=?", (CAL,))    # put back (the person() default)
ex("UPDATE users SET left_at='2026-01-01' WHERE id=?", (CEO1,))
d, b = profile_dt(PA[0])
s.check("an HOD who has left shows no name, as before: the label is HOD and the value 'Not on record yet'",
        d.get("HOD") == (' class="pf-none"', "Not on record yet") and "CEO" not in d, d.get("HOD"))
ex("UPDATE users SET left_at=NULL WHERE id=?", (CEO1,))
d_cl, _b = profile_dt(CEO1)
s.check("the CEO's own Profile has no HOD row (hod_hidden unchanged)", not any(k in d_cl for k in ("HOD", "CEO", "Head of unit")),
        list(d_cl))
with a.app.test_request_context("/"):
    rec = a.profile_record(a.get_db(), user(PA[0]))
s.check("the record keeps `hod` (the name) and `hod_hidden` as before, with the label beside them",
        rec["hod"] and rec["hod_label"] == "CEO" and rec["hod_hidden"] is False, rec)

# ---------------------------------------------------------------------------
# B. a calibrator holds no HOD role. Every reader of the HOD role, as one login sees it: True = the login still holds
# the HOD role there. A holder reads all False; an ordinary HOD all True (so each reader is reached); with the seat
# test switched off every reader comes back (so each check is sensitive to the rule, not vacuously false).
HOLDERS = {"CEO1": CEO1, "CEO2": CEO2, "CAL": CAL, "BGC": BGC, "GCH": GCH}
DEPT = {CEO1: PA, CEO2: PM_ + PMB, CAL: PC + PD, BGC: PG + PGX, GCH: PH, ORD: PO}
# a person of theirs OUTSIDE their seat, for the readers a seat outranks (the leader role names the strongest seat first);
# a BU CEO whose whole department sits inside the unit has none
OUTSIDE = {CEO2: PMB[0], CAL: PD[0], BGC: PGX[0], GCH: PH[2], ORD: PO[0]}
UNITS = ((BG, UA), (BG, UM), (BG, UB), (BG2, UG))
SU_ = H.actors(a)[0]["id"]


def obs(uid):
    """One login's HOD role, reader by reader (Year-End, Mid-Year or an Early Year, whichever the cycle is now)."""
    real_open = a._notice_open_cells
    a._notice_open_cells = lambda db, cyc, now: ["pm_hod", "pot_hod"]
    out = {}
    try:
        with a.app.test_request_context("/review/journey?view=dept"):
            from flask import session as _s
            _s["user_id"] = uid
            db = a.get_db()
            u = user(uid)
            cyc = a.active_cycle(db)
            out["tier"] = ("hod", uid) in a.calibration_tier_of(db, u)
            out["views"] = "dept" in a._journey_views(db, u)
            out["dash"] = a.dash_dept_review(db, u) is not None
            try:
                out["pm_pop"] = bool(a._pm_calib_resolve(db, u, "hod", hod_id=uid)["population"])
            except Exception:   # noqa: BLE001 -- the 403 of an empty scope
                out["pm_pop"] = False
            out["pot_pop"] = bool(a._pot_scope_population(db, "hod", uid))
            out["cell"] = any(c[0] == "pm_hod" for c in a._ask_cells(db, u))
            out["notice"] = uid in {r[0]["id"] for r in a.notice_recipients(db)}
            out["bar"] = "hod" in a._bar_ann_roles(db, u)
            out["pill"] = "pm_hod" in a._pill_my_cells(db, u, cyc)
            out["listed"] = any(uid in [i for i, _n in (a.pm_hod_reviews_open if ax == "pm" else a.pot_hod_reviews_open)(
                db, PID if ax == "pm" else CID, bg, co)] for bg, co in UNITS for ax in ("pm", "pot"))
            out["ids"] = uid in a._hod_ids_with_review(db, [uid])
            out["role"] = a.hod_has_role(db, uid)
            out["is_hod_of"] = a.is_hod_of(u, uid)
            out["led"] = any(t["key"] == "dept" for t in a._led_tabs(db, u))
            out["nav_hod"] = bool(a.inject_user()["nav_is_hod"])
            out["nav_pm_hod"] = bool(a.inject_user()["nav_is_pm_hod"])
            if uid in OUTSIDE:
                x = db.execute("SELECT * FROM users WHERE id=?", (OUTSIDE[uid],)).fetchone()
                out["leader_role"] = a.leader_role_of(db, u, x) == "hod"
                out["report"] = a.can_view_report(db, u, OUTSIDE[uid])
            scopes = [r for r in a._calib_lock_scopes(db, user(SU_), cyc) if r["tier"] == "hod"]
            out["lock_row"] = str(uid) in {r["key"] for r in scopes}
            card = a.dash_bu_status(db, u, cyc)
            if card is not None:
                out["bu_card"] = bool(card["n_depts"]) and not (card.get("axes") and card["axes"][0].get("word") == "No HOD review")
            bgc = a.dash_bg_status(db, u, cyc)
            if bgc is not None:
                out["bg_card"] = any("of 1 department" in r["sub"] or "of 1 in" in r["word"] for r in bgc["units"])
            seats = a._prerun_seats(db, OUTSIDE.get(uid) or DEPT[uid][0])
            out["prerun"] = any(t == "hod" and h == uid for t, _k, h in seats)
    finally:
        a._notice_open_cells = real_open
    c = H.client_as(a, uid)
    out["page_hod"] = c.get("/hod", headers=NAV).status_code == 200
    return out


def holds_nothing(o):
    return not any(o.values())


def holds_everything(o):
    return all(o.values())


def fail_keys(o, want):
    return [k for k, v in o.items() if v != want]


# the Dept view at the chat's own URL, plus every route of the classic pages
def write_attempts(hod, subject):
    """The HOD's classic write routes for one person: performance + potential, with a remark."""
    c = H.client_as(a, hod)
    c.post("/calibration/hod/%d/adjust" % hod, data={"csrf_token": "tok", "subject_id": str(subject),
                                                      "adjusted_band": "High", "justification": "ZZCH remark"})
    c.post("/performance/calibration/hod/%d/adjust" % hod, data={"csrf_token": "tok", "subject_id": str(subject),
                                                                  "adjusted_band": "AE", "justification": "ZZCH remark"})
    return (q("SELECT COUNT(*) FROM calibration_adjustments WHERE subject_id=?", (subject,))[0],
            q("SELECT COUNT(*) FROM pm_calibration_adjustments WHERE subject_id=?", (subject,))[0])


def clear_writes(ids):
    marks = ",".join(str(i) for i in ids)
    ex("DELETE FROM calibration_adjustments WHERE subject_id IN (%s)" % marks)
    ex("DELETE FROM pm_calibration_adjustments WHERE subject_id IN (%s)" % marks)


s.section("B. control: an ordinary HOD with no seat holds the role in every reader")
o_ord = obs(ORD)
s.check("the ordinary HOD is reached by every reader (Dept view, card, populations, cell, notice, bar, pill, lists, nav, "
        "/hod, the lock-scopes row, the prerun seat)", holds_everything(o_ord), fail_keys(o_ord, True))

s.section("B. Year-End: a calibrator is no HOD, whole department inside the seat or only part of it")
for nm, uid in HOLDERS.items():
    o = obs(uid)
    s.check("%s holds no HOD role in any reader (%d readers read)" % (nm, len(o)), holds_nothing(o), fail_keys(o, False))
with a.app.test_request_context("/review/journey?view=dept"):
    from flask import session as _s
    _s["user_id"] = CEO1
    _db = a.get_db()
    s.check("...the BU CEO's views are the BU tab, never Dept", "bu" in a._journey_leader_views(_db, user(CEO1))
            and "dept" not in a._journey_leader_views(_db, user(CEO1)), a._journey_leader_views(_db, user(CEO1)))
    _tiers = [t for t, _k in a.calibration_tier_of(_db, user(CEO1))]
    s.check("...and the tier list is the BU CEO's alone (no 'hod')", "buceo" in _tiers and "hod" not in _tiers, _tiers)
    _ct = [t for t, _k in a.calibration_tier_of(_db, user(BGC))]
    s.check("...a BG CEO keeps the BG tier, a calibrator the group tier, a Group Chief no line tier",
            "bgceo" in _ct and "hod" not in _ct
            and [t for t, _k in a.calibration_tier_of(_db, user(CAL))] == ["bugrp"]
            and [t for t, _k in a.calibration_tier_of(_db, user(GCH))] == [], (_ct,))
    s.check("...every one of their department's people, partly outside the seat or not, is in nobody's HOD list: the "
            "helper hands every holder ' AND 0' and nobody else a fragment",
            all(a._hod_review_skip_sql(_db, h) == (" AND 0", []) for h in HOLDERS.values())
            and a._hod_review_skip_sql(_db, ORD) == ("", []) and a._hod_review_skip_sql(_db, 0) == ("", []))
    s.check("...the holders are exactly the four seat kinds (BU CEO seat, BG CEO, calibrator, Group Chief) and the ordinary "
            "HOD is not one", a._hod_review_holders(_db) >= set(HOLDERS.values()) and ORD not in a._hod_review_holders(_db),
            sorted(a._hod_review_holders(_db) & set(ALL + list(HOLDERS.values()))))
c1 = H.client_as(a, CEO1)
html = c1.get("/review/journey?view=dept").get_data(as_text=True)
s.check("GET /review/journey?view=dept falls back: not the Dept view, and no Dept tab in the toggle",
        'data-view="dept"' not in html and ">Dept<" not in html, re.findall(r'data-view="(\w+)"', html)[:3])
with a.app.test_request_context("/"):
    db = a.get_db()
    from werkzeug.exceptions import HTTPException
    try:
        a._pm_calib_resolve(db, user(CEO1), "hod", hod_id=CEO1)
        refused = False
    except HTTPException as e_:
        refused = e_.code == 403
s.check("the performance resolver refuses their (now empty) department", refused)
# (the Performance Department page, /performance/department, went to the dashboard for everyone 2026-10-31: test_sec_classic)
s.check("the HOD table (/hod) is 403 for a holder, 200 for the ordinary HOD",
        all(H.client_as(a, h).get(path, headers=NAV).status_code == 403 for h in HOLDERS.values()
            for path in ("/hod",))
        and all(H.client_as(a, ORD).get(path, headers=NAV).status_code == 200 for path in ("/hod",)),
        [H.client_as(a, h).get("/hod", headers=NAV).status_code for h in HOLDERS.values()])
s.check("a HOD write route is refused for every holder's people, in both parts and for a person outside their seat too "
        "(no row written)", all(write_attempts(h, p) == (0, 0) for h, p in [(CEO1, PA[0]), (CEO2, PM_[0]), (CEO2, PMB[0]),
                                                                              (CAL, PD[0]), (BGC, PGX[0]), (GCH, PH[2])]))
s.check("...and the ordinary HOD's write goes through (the route is reached)", write_attempts(ORD, PO[0]) == (1, 1),
        write_attempts(ORD, PO[0]))
clear_writes(ALL)
rj = c1.post("/review/team/calib-move", data={"csrf_token": "tok", "stage": "calibration", "subject": str(PA[1]),
                                              "band": "AE", "view": "dept", "justification": "ZZCH remark"}).get_json() or {}
s.check("...the chat's view=dept move writes no HOD row (it falls to their BU view, where the BU CEO's own call is theirs)",
        q("SELECT COUNT(*) FROM pm_calibration_adjustments x JOIN pm_calibration_sessions y ON y.id=x.session_id "
          "WHERE y.tier='hod' AND x.subject_id=?", (PA[1],))[0] == 0, (rj.get("ok"), rj.get("error")))
clear_writes(ALL)
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("a holder's department people stay in the cycle's people (hod_id is org data and stays): they still point at "
            "the holder", all(q("SELECT hod_id FROM users WHERE id=?", (p,))[0] == h for h, ps in DEPT.items() for p in ps))
    s.check("...and the Profile still names the holder as the HOD (the head title is untouched)",
            head_row(PA[0])[0] == "CEO" and head_row(PC[0])[0] == "HOD", (head_row(PA[0]), head_row(PC[0])))

s.section("B. Mid-Year: the same, in every cycle type")
set_half(1)
for nm, uid in HOLDERS.items():
    o = obs(uid)
    s.check("Mid-Year: %s holds no HOD role in any reader" % nm, holds_nothing(o), fail_keys(o, False))
o_mid = obs(ORD)
s.check("...Mid-Year: the ordinary HOD keeps every reader", holds_everything(o_mid), fail_keys(o_mid, True))
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("...the helper still hands every holder ' AND 0' at Mid-Year",
            all(a._hod_review_skip_sql(db, h) == (" AND 0", []) for h in HOLDERS.values())
            and a._hod_review_skip_sql(db, ORD) == ("", []))
set_half(0)
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("...and in an Early Year", all(a._hod_review_skip_sql(db, h) == (" AND 0", []) for h in HOLDERS.values())
            and a._hod_review_skip_sql(db, ORD) == ("", []))
set_half(1)


def mid_final(pid):
    """final_result('pm') at Mid-Year for a person whose line manager has approved a rating and nobody above has acted."""
    real = (a.pm_final_overalls, a.pm_effective_band, a._rr_tier_bands)
    a.pm_final_overalls = lambda db, cid, ids: {i: {"label": "ME"} for i in ids}
    a.pm_effective_band = lambda db, subject, cid, raw=None: {"band": "ME"}
    a._rr_tier_bands = lambda db, cid, subject, raw, kind: ({}, {})
    try:
        with a.app.test_request_context("/"):
            db = a.get_db()
            return a.final_result(db, db.execute("SELECT * FROM users WHERE id=?", (pid,)).fetchone(), CID, "pm")
    finally:
        a.pm_final_overalls, a.pm_effective_band, a._rr_tier_bands = real


s.check("Mid-Year: a holder's department people are final at their line manager's rating (no HOD review to wait for) "
        "and the ordinary HOD's people still wait for it",
        all(mid_final(p)["final"] for p in (PA[0], PM_[0], PMB[0], PC[0], PD[0], PG[0], PH[0]))
        and not mid_final(PO[0])["final"] and mid_final(PO[0])["stage"].startswith("Line manager approved"),
        (mid_final(PA[0]), mid_final(PO[0])))
with a.app.test_request_context("/"):
    db = a.get_db()
    u_ = user(CEO1)
    card = a.dash_bu_status(db, u_, a.active_cycle(db))
    gcard = a.dash_group_status(db, user(GCH), a.active_cycle(db))
    bcard = a.dash_bg_status(db, user(BGC), a.active_cycle(db))
s.check("Mid-Year: the BU CEO's card, the Group Chief's and the BG CEO's count no HOD review for a holder's department "
        "(\"No HOD review\", the line manager's bands are final)",
        card["mid_year"] and card["n_depts"] == 0 and card["axes"][0]["word"] == "No HOD review"
        and all(r["word"] == "No HOD review" for r in gcard["units"]) and bcard is not None
        and all(r["word"] == "No HOD review" for r in bcard["units"] if r["name"] in (UG,)),
        (card["n_depts"], [r["word"] for r in gcard["units"]], [r["word"] for r in bcard["units"]]))
with a.app.test_request_context("/"):
    db = a.get_db()
    s.check("the prerun reads no HOD insight for a holder's people (Mid-Year too), and does for the ordinary HOD's",
            not any(t == "hod" for t, _k, _h in a._prerun_seats(db, PA[0]))
            and not any(t == "hod" for t, _k, _h in a._prerun_seats(db, PMB[0]))
            and any(t == "hod" and h == ORD for t, _k, h in a._prerun_seats(db, PO[0])))
set_half(2)

s.section("B. the BU lock names no calibrator under \"HODs not done\", and a mixed unit still names the ordinary HOD")
with a.app.test_request_context("/"):
    db = a.get_db()
    named = {(bg, co, ax): [i for i, _n in (a.pm_hod_reviews_open if ax == "pm" else a.pot_hod_reviews_open)(
        db, PID if ax == "pm" else CID, bg, co)] for bg, co in UNITS + ((BG, BG),) for ax in ("pm", "pot")}
    every = {i for v in named.values() for i in v}
    s.check("no holder is named on any unit's open list, on either axis", not (every & set(HOLDERS.values())), every)
    # an ordinary HOD in a unit with a BU CEO: still named
    ex("UPDATE users SET hod_id=? WHERE id=?", (ORD, PM_[0]))
    named_ord = {i for i, _n in a.pm_hod_reviews_open(db, PID, BG, UM)}
    s.check("...and an ordinary HOD whose people sit in a BU CEO's unit is named there (the list is not just empty)",
            ORD in named_ord and CEO2 not in named_ord, named_ord)
    ex("UPDATE users SET hod_id=? WHERE id=?", (CEO2, PM_[0]))

s.section("B. the BU CEO's queue and the Talent Box's band trail know no HOD step for a calibrator's people")


def queue_text(uid, pid):
    """The BU CEO's department queue (the AI+ check-in's BU view) over one person, as text."""
    import json
    with a.app.test_request_context("/review/journey?view=bu"):
        from flask import session as _s
        _s["user_id"] = uid
        db = a.get_db()
        items = [{"id": str(pid), "name": "ZZ", "done": False, "meta": "", "moved": False, "scope_locked": False,
                  "closed": False}]
        return json.dumps(a._calib_queue(db, user(uid), "calibration", items), default=str)


def trail_state(pid):
    """The HOD step of the Talent Box's performance trail for one person: 'na' (no HOD), 'wait' (an HOD who hasn't locked)."""
    with a.app.test_request_context("/"):
        db = a.get_db()
        row = db.execute("SELECT * FROM users WHERE id=?", (pid,)).fetchone()
        tr = a._tb_band_trails(db, {"period": {"id": PID}, "cycle_id": CID}, [{"user": row}])
        return [st for st in tr[pid]["perf"] if st[0] == "hod"][0][2]


ex("UPDATE users SET hod_id=? WHERE id=?", (ORD, PM_[0]))
s.check("the BU CEO's queue reads \"no HOD review\" for a department their own seat heads, \"with the HOD\" for an "
        "ordinary HOD's", "no HOD review" in queue_text(CEO2, PM_[1]) and "with the HOD" not in queue_text(CEO2, PM_[1])
        and "with the HOD" in queue_text(CEO2, PM_[0]), queue_text(CEO2, PM_[1])[:200])
s.check("the Talent Box's trail has no HOD step (na) for a calibrator's person and a waiting one (wait) for an ordinary "
        "HOD's", trail_state(PM_[1]) == "na" and trail_state(PM_[0]) == "wait" and trail_state(PA[0]) == "na",
        (trail_state(PM_[1]), trail_state(PM_[0])))
ex("UPDATE users SET hod_id=? WHERE id=?", (CEO2, PM_[0]))

s.section("B. the HOD notice email and reminder")
with a.app.test_request_context("/"):
    db = a.get_db()
    real_open = a._notice_open_cells
    a._notice_open_cells = lambda db_, cyc, now: ["pm_hod", "pot_hod"]
    try:
        got = {r[0]["id"] for r in a.notice_recipients(db)}
    finally:
        a._notice_open_cells = real_open
    s.check("only the ordinary HOD gets the HOD release notice, no holder does",
            ORD in got and not (got & set(HOLDERS.values())), sorted(got & set(HOLDERS.values()) | ({ORD} & got)))
    s.check("the reminder line comes from the dashboard's Dept Review card: a holder has none, the ordinary HOD has one",
            a.dash_dept_review(db, user(CEO1)) is None and a.dash_dept_review(db, user(CAL)) is None
            and a.dash_dept_review(db, user(ORD)) is not None)

# ---------------------------------------------------------------------------
s.section("copy: the knowledge the agents and Help carry")
src = H.source(a)
s.check("the newly-confirmed KB row says a calibrator has no Department Review (seed), and the guarded one-time updates "
        "reword both earlier wordings",
        "calibrator or Group Chief has no Department Review" in a._KB_NEWLY_CONFIRMED_BODY
        and src.count("UPDATE kb_entries SET body=? WHERE slug='newly-confirmed' AND body LIKE") == 2
        and "(if their HOD is also their BU CEO or BG CEO, that calibration covers them instead)" in src
        and "calibrator or Group Chief has no Department Review" in a.HELP_QA["newly"][1])
with a.app.test_request_context("/"):
    db = a.get_db()
    u_ = user(CEO1)
    st = a.review_state(db, u_)
    sysmsg = a._journey_agent_system(db, u_, st, None, is_opener=True)
    m_ = re.search(r"the switch above the left panel \(([^)]*)\)", sysmsg)
    s.check("the agent's opening names the switch's real views: a BU CEO with no Dept gets 'Mine, and BU', not Dept / BU / BG",
            m_ and "Dept" not in m_.group(1) and "BU" in m_.group(1), m_ and m_.group(1))
    m2_ = re.search(r"the switch above the left panel \(([^)]*)\)",
                    a._journey_agent_system(db, user(ORD), a.review_state(db, user(ORD)), None, is_opener=True))
s.check("...and a login that has the Dept view still hears it", m2_ and "Dept" in m2_.group(1), m2_ and m2_.group(1))

# ---------------------------------------------------------------------------
s.section("B. Grade H: a BU CEO or BG CEO holds no HOD role there; a calibrator of the normal review does (Chris 2026-11-03)")
_GH0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
UH = "ZZCH Unit H"
GH = {}


def gh_run(fn):
    with a.app.test_request_context("/"):
        db_ = a.get_db()
        r_ = fn(db_)
        db_.commit()
        return r_


def gh_user(eid, name, hod=None, bu=False, grade="H"):
    def go(d):
        d.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
                  "job_grade, job_title, hod_id, buceo_bg, buceo_company, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?,?,?, 'Driver', ?,?,?, '2020-01-01')",
                  (eid.lower(), name, eid, BG, UH, "ZZCH Dept H", grade, hod, BG if bu else None, UH if bu else None))
        return d.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    return gh_run(go)


def gh_person(uid, submitted=True):
    def go(d):
        pid = d.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route) SELECT ?, employee_id, id, 'B' FROM users WHERE id=?",
                        (CID, uid)).lastrowid
        d.execute("INSERT INTO gradeh_appraisals (cycle_id, person_id, lm_submitted_at, perf_band, pot_band, perf_rating, pot_score, "
                  "conversation_held) VALUES (?,?,?,?,?,3.2,9,1)", (CID, pid, "2026-11-10 02:00:00" if submitted else None,
                                                                    "ME" if submitted else None, "Mid" if submitted else None))
        return pid
    return gh_run(go)


gh_run(lambda d: (d.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, UH)),
                  d.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1) "
                            "ON CONFLICT(cycle_id, module_key) DO UPDATE SET active=1", (CID,))))
GH["BUH"] = gh_user("ZZCH-BUH", "ZZ CH Unit H Ceo", bu=True)
CEO_H = {"CEO2": CEO2, "BGC": BGC}      # a BU CEO seat (another unit's) and a BG CEO seat: no Grade H HOD role
CAL_H = {"CAL": CAL, "GCH": GCH}        # a BU calibration group's calibrator and a Group Chief group's: the HOD role stays in Grade H
HOLD_H = dict(CEO_H, **CAL_H)          # four ways to hold a seat, none of them Unit H's own
GP = {"ORD": gh_person(gh_user("ZZCH-GHO", "ZZ CH Gh Ord", hod=ORD))}
for nm_, uid_ in HOLD_H.items():
    GP[nm_] = gh_person(gh_user("ZZCH-GH" + nm_, "ZZ CH Gh " + nm_, hod=uid_))
GP["UNSUB"] = gh_person(gh_user("ZZCH-GHU", "ZZ CH Gh Unsub", hod=CAL), submitted=False)


def gh_can(uid):
    return gh_run(lambda d: (a.gradeh_hod_can(d, d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()),
                             [r["id"] for r in a.gradeh_hod_scope(d, uid, CID)],
                             "hod" in a.gradeh_audiences(d, d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())))


def gh_http(uid, writes=True):
    c = H.client_as(a, uid)
    return {"page": c.get("/calibration/gradeh/hod").status_code,
            "writes": [] if not writes else [c.post("/calibration/gradeh/hod/" + w, data={"csrf_token": "tok", "pid": GP["ORD"], "stage": "pot", "band": "High",
                                                                    "remark": "A fair reason."}).status_code for w in ("move", "agree", "signoff")]}


def gh_obs(which):
    return {nm_: (gh_can(uid_), gh_http(uid_)) for nm_, uid_ in which.items()}


can_o, scope_o, aud_o = gh_can(ORD)
s.check("control: an ordinary HOD (no seat) is a Grade H HOD: the ability, their person in scope, the 'hod' audience, the page opens",
        can_o and scope_o == [GP["ORD"]] and aud_o and gh_http(ORD, writes=False)["page"] == 200)
OBS_H = gh_obs(CEO_H)
for nm_, (res_, http_) in OBS_H.items():
    can_, scope_, aud_ = res_
    s.check("%s holds a BU CEO / BG CEO seat: no Grade H HOD ability, no person in scope, no 'hod' audience; the HOD page and its three writes are 404" % nm_,
            not can_ and scope_ == [] and not aud_ and http_["page"] == 404 and http_["writes"] == [404, 404, 404], (res_, http_))
OBS_C = gh_obs(CAL_H)
for nm_, (res_, http_) in OBS_C.items():
    can_, scope_, aud_ = res_
    own_ = sorted(GP[k_] for k_ in ((nm_, "UNSUB") if nm_ == "CAL" else (nm_,)))
    s.check("%s calibrates the normal review but is a Grade H HOD: the ability, their own people (%d) in scope, the 'hod' audience, the page opens (200)" % (nm_, len(own_)),
            can_ and sorted(scope_) == own_ and aud_ and http_["page"] == 200, (res_, http_))
s.check("...and in the NORMAL review the same two calibrators still hold no HOD role (hod_has_role, _hod_ids_with_review)",
        gh_run(lambda d: [a.hod_has_role(d, CAL), a.hod_has_role(d, GCH), a._hod_ids_with_review(d, [CAL, GCH, ORD])]) == [False, False, [ORD]])
s.check("the BU CEO of Unit H keeps their own Grade H access, and a plain HOD keeps theirs",
        gh_run(lambda d: bool(a.gradeh_buceo_units(d, d.execute("SELECT * FROM users WHERE id=?", (GH["BUH"],)).fetchone())))
        and H.client_as(a, GH["BUH"]).get("/calibration/gradeh/unit").status_code == 200 and gh_http(ORD, writes=False)["page"] == 200)
st_h = gh_run(lambda d: a.gradeh_unit_signoff_state(d, CID, UH))
s.check("the BU CEO's sign-off waits on the ordinary HOD AND the two calibrators (their HOD stage is real); a BU CEO's and a BG CEO's people have no HOD stage, so nothing waits on them",
        sorted(h_["id"] for h_ in st_h["hods"]) == sorted([ORD, CAL, GCH]) and st_h["hods_total"] == 3
        and not any(n_ in st_h["blocking"] for n_ in ("ZZ CH Ceo Two", "ZZ CH Bg Ceo")), st_h["blocking"])
adm_ = {p_["pid"]: p_["status"] for p_ in gh_run(lambda d: a.gradeh_admin_people(d, CID))}
s.check("...and Group People's list reads a BU CEO's / BG CEO's submitted person as with the BU CEO ('bu'), not stuck at an HOD step "
        "('submitted'), as a calibrator's and an ordinary HOD's still unsigned person are",
        all(adm_[GP[n_]] == "bu" for n_ in CEO_H) and all(adm_[GP[n_]] == "submitted" for n_ in list(CAL_H) + ["ORD"]), adm_)
s.check("a BU CEO's person is never 'done' by a stale HOD sign-off either: no HOD stage exists for them",
        gh_run(lambda d: [a._gh_cal_person(r_, *a._gh_cal_load(d, CID, [r_])) for r_ in d.execute(
            a._GH_CAL_SQL + "AND p.id=?", (CID, GP["CEO2"])).fetchall()])[0]["hod_signed"] == {"perf": False, "pot": False})

# falsify: the twin blind (hod_id alone): the BU CEO / BG CEO would be Grade H HODs again
_hrh0 = a.gradeh_hod_has_role
a.gradeh_hod_has_role = lambda db_, hid_: bool(hid_)
try:
    can_f = {nm_: gh_can(uid_) for nm_, uid_ in CEO_H.items()}
finally:
    a.gradeh_hod_has_role = _hrh0
s.check("falsified: with the Grade H readers asking hod_id alone (the twin blind), a BU CEO and a BG CEO are Grade H HODs again "
        "(ability, scope and audience), so the checks above reached their guard",
        all(c_[0] and c_[1] and c_[2] for c_ in can_f.values()), can_f)
s.check("...and restored: neither holds it again", all(not gh_can(uid_)[0] for uid_ in CEO_H.values()))
# falsify: the twin back on the normal review's rule (the old behaviour): the calibrators lose it
a.gradeh_hod_has_role = lambda db_, hid_: a.hod_has_role(db_, hid_)
try:
    can_o = {nm_: gh_can(uid_)[0] for nm_, uid_ in CAL_H.items()}
finally:
    a.gradeh_hod_has_role = _hrh0
s.check("falsified: with the twin on the normal review's rule (the old behaviour), the calibrators are no Grade H HOD, so the checks above reached their guard",
        not any(can_o.values()), can_o)
s.check("...and restored: both hold it again", all(gh_can(uid_)[0] for uid_ in CAL_H.values()))

# ---- the source lint (rule C) ------------------------------------------------------------------------------------------
import ast  # noqa: E402

APP_SRC = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app.py"), encoding="utf-8").read()
PLAIN_ = {"hod_has_role", "_hod_ids_with_review"}
TWIN_ = {"gradeh_hod_has_role", "_gh_hod_ids_with_role"}
GH_PREFIX = ("gradeh_", "_gradeh_", "_gh_", "_ghl_", "_gkl_")
MIXED_OK = {"notice_recipients"}   # serves both reviews: its "hod" key asks the plain filter, its "gh_hod" key the twin (checked below)


def hod_lint(src):
    """[(kind, function, line)]: a Grade H reader (name starts gradeh_ / _gh_ / ...) calling the plain HOD readers, or a function that
    is neither Grade H nor the mixed notice builder calling the Grade H twin."""
    bad = []

    def walk(node, top):
        for ch in ast.iter_child_nodes(node):
            t_ = top
            if isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)) and top is None:
                t_ = ch.name
            if isinstance(ch, ast.Call):
                f_ = ch.func
                n_ = f_.id if isinstance(f_, ast.Name) else f_.attr if isinstance(f_, ast.Attribute) else None
                gh_ = bool(t_) and t_.startswith(GH_PREFIX)
                if n_ in PLAIN_ and gh_:
                    bad.append(("grade-h-uses-plain", t_, ch.lineno))
                if n_ in TWIN_ and not gh_ and t_ not in MIXED_OK:
                    bad.append(("normal-uses-twin", t_, ch.lineno))
            walk(ch, t_)
    walk(ast.parse(src), None)
    return bad


def notice_lint(src):
    m_ = re.search(r'if key == "hod":[^\n]*\n\s*ids = set\(_hod_ids_with_review\(db, sorted\(ids\)\)\)\n\s*elif key == "gh_hod":[^\n]*\n\s*ids = set\(_gh_hod_ids_with_role\(db, sorted\(ids\)\)\)', src)
    return bool(m_)


s.check("lint: no Grade H reader (gradeh_* / _gh_*) asks hod_has_role or _hod_ids_with_review, and only Grade H readers (and the notice builder) ask the twin",
        hod_lint(APP_SRC) == [], hod_lint(APP_SRC))
s.check("lint: the notice builder sends the normal HOD key through the plain filter and the Grade H key through the twin", notice_lint(APP_SRC))
s.check("lint, the Grade H readers it covers are all there (the twin is called by gradeh_hod_can, gradeh_hod_scope, _gh_slots, _gh_hod_stage, _gh_cal_person, _ghl_load)",
        {n_ for n_ in ("gradeh_hod_can", "gradeh_hod_scope", "_gh_slots", "_gh_hod_stage", "_gh_cal_person", "_ghl_load") if re.search(
            r"def %s\(.*?(?=\ndef )" % n_, APP_SRC, re.S) and "gradeh_hod_has_role(" in re.search(r"def %s\(.*?(?=\ndef )" % n_, APP_SRC, re.S).group(0)} ==
        {"gradeh_hod_can", "gradeh_hod_scope", "_gh_slots", "_gh_hod_stage", "_gh_cal_person", "_ghl_load"})
# falsify the lint: a Grade H reader back on the plain function / a normal reader on the twin / the notice's key back on the plain filter
bad1 = hod_lint(APP_SRC.replace("not gradeh_hod_has_role(db, hod_id):\n        return []", "not hod_has_role(db, hod_id):\n        return []"))
bad2 = hod_lint(APP_SRC.replace("    if hod_id and hod_id in _hod_review_holders(db):\n        return \" AND 0\", []",
                                                                                             "    if hod_id and gradeh_hod_has_role(db, hod_id):\n        return \" AND 0\", []"))
bad3 = notice_lint(APP_SRC.replace('elif key == "gh_hod":', 'elif key == "gh_hod_x":'))
s.check("falsified lint: gradeh_hod_scope on hod_has_role is caught; a normal-review function (_hod_review_skip_sql) on the twin is caught; the notice's Grade H key on the plain filter is caught",
        ("grade-h-uses-plain", "gradeh_hod_scope") in {(k_, f_) for k_, f_, _l in bad1}
        and ("normal-uses-twin", "_hod_review_skip_sql") in {(k_, f_) for k_, f_, _l in bad2} and not bad3, (bad1, bad2, bad3))
if _GH0 is None:
    os.environ.pop("ONEHR_GRADEH", None)
else:
    os.environ["ONEHR_GRADEH"] = _GH0

# ---------------------------------------------------------------------------
s.section("falsify every guard: with the seat test off, every reader brings the HOD role back")
real_holders, real_lab = a._hod_review_holders, a._head_title_label
a._hod_review_holders = lambda db: set()
try:
    off = {nm: obs(uid) for nm, uid in HOLDERS.items()}
    wrote = write_attempts(CEO1, PA[0])
    queue_off, trail_off = queue_text(CEO1, PA[0]), trail_state(PA[0])
    set_half(1)
    off_mid = {nm: obs(uid) for nm, uid in HOLDERS.items()}
    mid_off = [mid_final(p)["final"] for p in (PA[0], PM_[0], PC[0], PH[0])]
    set_half(2)
finally:
    a._hod_review_holders = real_holders
    set_half(2)
for nm in HOLDERS:
    s.check("seat test off, Year-End: %s holds the HOD role in every reader again (so each check above reached its "
            "guard)" % nm, holds_everything(off[nm]), fail_keys(off[nm], True))
    s.check("seat test off, Mid-Year: %s too" % nm, holds_everything(off_mid[nm]), fail_keys(off_mid[nm], True))
s.check("...the write the guard refused now lands (both parts)", wrote == (1, 1), wrote)
s.check("...the BU CEO's queue waits \"with the HOD\" and the trail waits at the HOD step again",
        "with the HOD" in queue_off and trail_off == "wait", trail_off)
clear_writes(ALL)
s.check("...and at Mid-Year a holder's department people wait for an HOD review again", not any(mid_off), mid_off)
a._head_title_label = lambda title, bg_seat: "HOD"
try:
    lab_off = head_row(PA[0])[0]
finally:
    a._head_title_label = real_lab
s.check("mapping off: a BU CEO's row reads HOD again (the label check is real)", lab_off == "HOD" and head_row(PA[0])[0] == "CEO",
        lab_off)
# the guards restored: the first check again
s.check("restored: the holders hold nothing again, the ordinary HOD everything",
        all(holds_nothing(obs(u_)) for u_ in HOLDERS.values()) and holds_everything(obs(ORD)))

sys.exit(s.done())
