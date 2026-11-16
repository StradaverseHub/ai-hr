"""PAT after a BU CEO's lock (Chris, 2026-10-17).

  "add the warning and flag to the admin, and set control level, for BG and BU admin, they can't change the PAT score
   after BUCEO locked, only super admin can do so, and there should be an added function for super admin to run AI fit
   to the new curve (either move down or up) per our rule of nearest scoring and strongest justification fit as an
   option for super admin to have one click to complete it."
  "for any action that will impact or change the final band of an employee by super admin, there must be a mandatory
   remark logged by super admin ... And all these will be saved in the audit trail for system record."

A synthetic business group (ZZPL) with three units: Alpha, banded by its BU CEO on the Normal curve (PAT 100%) and
locked; Beta, not locked; Gamma, locked with no figure of its own (it is on the normal curve: since PAT Ref, 2026-10-27,
a unit never reads its business group's figure). Everything is put back at the end,
the cycle's half included (BU CEO calibration is a Year-End tier).
"""
import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("PAT after a BU CEO's lock -- who may change it, the flag, the super admin's AI fit with a remark")
BG, CA, CB, CC = "ZZPL BG", "ZZPL Alpha", "ZZPL Beta", "ZZPL Gamma"
PAT = "/admin/performance/pbt"
FIT = "/admin/performance/pbt/fit"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZPL-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN "
                   "(%s))" % ph, ids)
        for tb in ("pm_kpi_targets", "pm_calibration_adjustments", "rating_records"):
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (tb, ph), ids)
        db.execute("DELETE FROM buceo_seats WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
    db.execute("DELETE FROM activity_log WHERE action IN ('pm_pbt_set','pm_pat_fit') AND detail LIKE ?", ("%ZZPL%",))
    db.execute("DELETE FROM pm_calibration_adjustments WHERE session_id IN (SELECT id FROM pm_calibration_sessions WHERE "
               "business_group=?)", (BG,))
    for tb in ("pm_calibration_sessions", "calibration_sessions"):
        db.execute("DELETE FROM %s WHERE business_group=?" % tb, (BG,))
    for tb in ("talent_box_bu_locks", "pm_pbt_achievement", "pm_pat_lock_flags", "org_units", "pm_bg_config"):
        db.execute("DELETE FROM %s WHERE business_group=?" % tb, (BG,))
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZPL-%'")
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    _cleanup(db)
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    MODS0 = {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))}
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('pm','calibration','tm')", (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, co=CA, kpi=True, **over):
        over = dict(over)
        score = over.pop("_score", 3.0)
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=co, department="ZZPL Ops",
                 job_grade="14", left_at=None, is_demo=0, role="user", admin_bg=None, years_of_service=3)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        uid = db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
        if kpi:   # a Rate 1-5 line with a submitted result, so the fit can rank them by score
            t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                           "business_group, company, rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?,100,'more',"
                           "'approved',?,?,1,2,3,4,5)", (PER, uid, "ZZPL KPI", BG, co)).lastrowid
            db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)",
                       (t, score, uid))
        return uid
    for co in (CA, CB, CC):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, co))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    BOSS = person("ZZPL-BUCEO", "ZZ PL Buceo", kpi=False)
    BGC = person("ZZPL-BGCEO", "ZZ PL Bgceo", kpi=False, bgceo_bg=BG)
    ADM = person("ZZPL-ADM", "ZZ PL Bgadmin", kpi=False, role="admin", admin_bg=BG)
    NORMAL = ["UA"] + ["BE"] * 2 + ["ME"] * 14 + ["AE"] * 2 + ["OU"]   # 5/10/70/10/5 of 20
    # scores spread through each band (the ME people from 2.6 to 3.9), so the fit has a nearest score to pick
    SCORES = [1.2, 2.0, 2.3] + [2.6 + 0.1 * i for i in range(14)] + [4.1, 4.4, 4.8]
    PEOPLE = [person("ZZPL-P%02d" % i, "ZZ PL Person %02d" % i, _score=SCORES[i]) for i in range(20)]
    GAMMA = [person("ZZPL-G%02d" % i, "ZZ PL Gamma %02d" % i, co=CC) for i in range(3)]
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]
    db.commit()
    a._assign_buceo(db, dict(db.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone()), BOSS, BG, CA)
    ps = a._pm_calib_get_or_create_session(db, PER, "buceo", CA, BG, CA)
    for sid, band in zip(PEOPLE, NORMAL):
        a._pm_calib_upsert_adjustment(db, ps["id"], sid, "", band, "BU CEO call", BOSS)
    # Gamma: locked too, with no PAT of its own
    pg = a._pm_calib_get_or_create_session(db, PER, "buceo", CC, BG, CC)
    db.execute("UPDATE pm_calibration_sessions SET locked_at=CURRENT_TIMESTAMP, locked_by=? WHERE id=?", (SUP, pg["id"]))
    db.commit()

sup, boss, adm, bgc = (H.client_as(a, x) for x in (SUP, BOSS, ADM, BGC))


def pat(cl, co, val):
    r = cl.post(PAT, data={"csrf_token": "tok", "business_group": BG, "company": co, "achievement_pct": val},
                follow_redirects=True)
    return re.findall(r'class="flash flash-(\w+)"[^>]*>([^<]+)', html.unescape(r.get_data(as_text=True)))


def pct(co):
    return H.one(a, "SELECT achievement_pct FROM pm_pbt_achievement WHERE cycle_id=? AND business_group=? AND company=?",
                 (PER, BG, co))


def bands():
    return {r[0]: r[1] for r in H.rows(a, "SELECT ca.subject_id, ca.adjusted_band FROM pm_calibration_adjustments ca "
                                          "JOIN pm_calibration_sessions cs ON cs.id=ca.session_id WHERE cs.cycle_id=? AND "
                                          "cs.tier='buceo' AND cs.scope_key=?", (PER, CA))}


def locked(co=CA):
    return H.one(a, "SELECT locked_at FROM pm_calibration_sessions WHERE cycle_id=? AND tier='buceo' AND scope_key=?",
                 (PER, co))


def page(cl):
    return html.unescape(cl.get(PAT + "?fbg=" + BG.replace(" ", "+")).get_data(as_text=True))


def row_of(b, co):
    """The unit's row and, when there is one, its flag row."""
    i = b.find('data-unit="%s"' % co)
    j = b.find('class="data-row', i + 10)
    return b[i:j if j > 0 else i + 6000]


try:
    s.section("1. the BU CEO calibrates on the Normal curve (PAT 100%) and locks")
    pat(sup, CA, "100")
    r = boss.post("/performance/calibration/company/%s/%s/lock" % (BG, CA), data={"csrf_token": "tok"})
    s.check("Alpha is locked by its BU CEO", locked() is not None)
    b0 = bands()
    b = page(sup)
    s.check("the PAT page marks the lock beside the curve", "BU CEO locked" in row_of(b, CA))
    _js = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "pat_ref.js")).read()
    s.check("...and the super admin's Save warns what a change does to the locked result, before it is made (the box's "
            "words are built from the row's lock and the figure's change)",
            'data-locked="' in row_of(b, CA) and 'data-locked-curve="Normal"' in row_of(b, CA)
            and "locked its calibration on" in _js and "sits off the new one" in _js)

    s.section("2. a BG admin can't change a locked unit's PAT; the super admin can")
    fl = pat(adm, CA, "140")
    s.check("a BG admin's change to a locked unit is refused, the figure untouched", pct(CA) == 100, fl)
    b = page(adm)
    s.check("...their page shows it read only, saying why", 'name="achievement_pct"' not in row_of(b, CA)
            and "only the super admin changes it now" in row_of(b, CA))
    n_cb = lambda: H.one(a, "SELECT COUNT(*) FROM pm_pbt_achievement WHERE cycle_id=? AND business_group=? AND "   # noqa: E731
                            "company=?", (PER, BG, CB))
    cb0 = n_cb()
    pat(adm, CB, "90")
    s.check("...and since 2026-10-19 an unlocked unit is the super admin's too (BG admins are view only)",
            n_cb() == cb0 and (cb0 == 0 or pct(CB) != 90))
    pat(sup, CB, "90")
    s.check("...the super admin sets it", pct(CB) == 90)
    fl = pat(sup, "", "120")
    s.check("...and a business group's own figure is refused for everyone (the super admin too): there is none any more",
            H.one(a, "SELECT COUNT(*) FROM pm_pbt_achievement WHERE cycle_id=? AND business_group=? AND company=''",
                  (PER, BG)) == 0 and any(c == "error" for c, _m in fl), fl)
    fl = pat(sup, CA, "140")
    s.check("the super admin's change goes through", pct(CA) == 140, fl)
    s.check("...the BU CEO's lock and their 20 bands stay as they were", locked() is not None and bands() == b0)
    f = H.rows(a, "SELECT locked_curve, locked_pct FROM pm_pat_lock_flags WHERE cycle_id=? AND business_group=? AND "
                  "company=?", (PER, BG, CA))
    f = [tuple(r) for r in f]
    s.check("...and the unit is flagged with the curve they locked on (Normal, 100%)", f == [("normal", 100.0)], f)
    s.check("...its PAT change is in the audit trail", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_pbt_set' AND detail LIKE ?", ("%" + CA + ": 140%%",)) == 1)

    s.section("3. the flag and the super admin's one-click AI fit")
    b = page(sup)
    rb = row_of(b, CA)
    s.check("the flag names the curve they locked on and the one it reads now",
            "PAT changed after the BU CEO's lock" in rb and "<b>Normal</b>" in rb and "Positively skewed" in rb)
    m = re.search(r'data-confirm-list=\'([^\']*)\'', rb)
    moves = json.loads(html.unescape(m.group(1))) if m else []
    fp = re.search(r'name="fp" value="([0-9a-f]+)"', rb)
    s.check("the fit button lists who moves, and asks the remark in the same box",
            moves and fp and 'data-confirm-reason="Your remark (required)' in rb and "rv-ai-action" in rb
            and 'action="%s"' % FIT in rb, moves)
    card = html.unescape(sup.get("/admin/all-settings").get_data(as_text=True))
    s.check("the PAT Ref line on All settings counts it", "changed after the BU CEO's lock" in card)
    b = page(adm)
    s.check("a BG admin sees the flag, no fit button", "PAT changed after the BU CEO's lock" in row_of(b, CA)
            and FIT not in row_of(b, CA) and "The super admin can fit it" in row_of(b, CA))
    r = adm.post(FIT, data={"csrf_token": "tok", "business_group": BG, "company": CA, "fp": fp.group(1) if fp else "",
                            "remark": "ZZ remark"})
    s.check("...and can't post it", r.status_code in (302, 403) and bands() == b0, r.status_code)
    r = sup.post(FIT, data={"csrf_token": "tok", "business_group": BG, "company": CA, "fp": fp.group(1) if fp else "",
                            "remark": "   "}, follow_redirects=True)
    s.check("no remark, no fit: refused, nothing moves", bands() == b0 and "Write your remark first"
            in html.unescape(r.get_data(as_text=True)))
    r = sup.post(FIT, data={"csrf_token": "tok", "business_group": BG, "company": CA, "fp": "0000",
                            "remark": "ZZ PL refit for the audited PAT"}, follow_redirects=True)
    s.check("a stale preview (fingerprint) is refused too", bands() == b0 and "look at the moves again"
            in html.unescape(r.get_data(as_text=True)))
    REMARK = "ZZ PL audited PAT came in at 140%; refitting the locked result to the positive curve."
    r = sup.post(FIT, data={"csrf_token": "tok", "business_group": BG, "company": CA, "fp": fp.group(1) if fp else "",
                            "remark": REMARK}, follow_redirects=True)
    after = bands()
    moved = {k for k in after if after[k] != b0.get(k)}
    s.check("with the remark, the fit moves exactly the people it listed, one band each",
            len(moved) == len(moves) and moves, (len(moved), len(moves)))
    with a.app.test_request_context("/"):
        _d = a.get_db()
        _u = dict(_d.execute("SELECT * FROM users WHERE id=?", (SUP,)).fetchone())
        _ctx = a._pm_calib_resolve(_d, _u, "buceo", bg=BG, company=CA)
        _srow = _d.execute("SELECT * FROM pm_calibration_sessions WHERE cycle_id=? AND tier='buceo' AND scope_key=?",
                           (PER, CA)).fetchone()
        BR = a._pm_calib_lock_breaches(_d, "buceo", _ctx, _srow)
    s.check("...and the unit now sits within the positive curve's rule", BR == {}, BR)
    s.check("...the BU CEO's lock stays", locked() is not None)
    s.check("...each move carries the remark, as the super admin's",
            H.one(a, "SELECT COUNT(*) FROM pm_calibration_adjustments ca JOIN pm_calibration_sessions cs ON "
                     "cs.id=ca.session_id WHERE cs.scope_key=? AND ca.justification LIKE ? AND ca.adjusted_by=?",
                  (CA, REMARK[:30] + "%", SUP)) == len(moved))
    s.check("...the audit trail has a row per person moved (with the remark) and one for the unit",
            H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_pat_fit' AND detail LIKE ? AND user_id=?",
                  ("%" + REMARK[:30] + "%", SUP)) == len(moved) + 1
            and H.one(a, "SELECT COUNT(DISTINCT target_user_id) FROM activity_log WHERE action='pm_pat_fit' AND "
                         "target_user_id IS NOT NULL AND user_id=?", (SUP,)) >= len(moved))
    b = page(sup)
    s.check("the flag now says who fitted it, how many, with the remark, and offers no second fit",
            "Fitted to it by" in row_of(b, CA) and REMARK[:20] in row_of(b, CA) and FIT not in row_of(b, CA))
    card = html.unescape(sup.get("/admin/all-settings").get_data(as_text=True))
    s.check("...and the line no longer counts it", "changed after the BU CEO's lock" not in card)

    s.section("4. once the BG CEO has decided the unit, the fit stops")
    with a.app.test_request_context("/"):
        _d = a.get_db()
        _d.execute("INSERT INTO talent_box_bu_locks(period_id, cycle_id, business_group, company, locked_by) "
                   "VALUES (?,?,?,?,?)", (PER, CID, BG, CA, BGC))
        _d.commit()
    pct0 = pct(CA)
    _fl0 = pat(sup, CA, "60")
    s.check("a later change on PAT Ref is refused (Talent Box Round 2, 2026-11-15): once the BG CEO has locked the unit its figure is read "
            "only there, and moves only as the actual PAT on Talent Box > Round 2 · Actual; nothing is saved",
            pct(CA) == pct0 and any(c == "error" and "Round 2 · Actual" in m for c, m in _fl0), (pct0, pct(CA), _fl0))
    b = page(sup)
    s.check("...the flag its earlier change left stays as it was (the fit it got), with no fit button",
            "PAT changed after" in row_of(b, CA) and "Fitted to it by" in row_of(b, CA) and FIT not in row_of(b, CA))
    with a.app.test_request_context("/"):   # as a later change before the BG CEO's lock would have left it: the fit cleared
        _d = a.get_db()
        _d.execute("UPDATE pm_pat_lock_flags SET fitted_at=NULL, fitted_by=NULL, fit_moves=NULL, fit_remark=NULL "
                   "WHERE cycle_id=? AND business_group=? AND company=?", (PER, BG, CA))
        _d.commit()
    b = page(sup)
    s.check("...and with no fit on it, it says the BG CEO's bands are final", "PAT changed after" in row_of(b, CA)
            and "The BG CEO has already locked it" in row_of(b, CA) and FIT not in row_of(b, CA))
    b1 = bands()
    r = sup.post(FIT, data={"csrf_token": "tok", "business_group": BG, "company": CA, "fp": "x", "remark": REMARK},
                 follow_redirects=True)
    _fl = re.findall(r'class="flash flash-(\w+)"[^>]*>([^<]+)', html.unescape(r.get_data(as_text=True)))
    s.check("...and a fit posted anyway is refused, saying the BG CEO's bands are final", bands() == b1
            and any(c == "error" and "Unlock it first to refit" in m for c, m in _fl), _fl)
finally:
    with a.app.test_request_context("/"):
        db = a.get_db()
        _cleanup(db)
        db.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
        for k, v in MODS0.items():
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, CID, k))
        db.commit()
sys.exit(s.done())
