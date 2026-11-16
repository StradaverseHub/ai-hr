"""The super admin amends a BU KPI's target, and refills its result, until results are released (Chris, 2026-11-14: "Allow super admin to
amend the BU KPI target and result, with a warning message that the Department Review has already begun. BU KPI can still be amended
till the result release.").

What this suite holds (a Year-End, Mechanism B, the Department Review window moved to read only for the second half):
  * a setup save, in any mode, never touches a person whose result is released (counted, said in the flash and the trail); the normal
    save still sends a moderated line back to its moderators
  * the late amendment (action save_kpi_late): the super admin's alone (403 for a group admin), only while the page reads only, refused
    without a remark (the remark rides on the audit line); it writes the target figures, unit and method of ONE saved setup and nothing
    else (carriers, weight mode, bands, category, library link in the form are ignored); it reaches lines with results, calibrated
    lines and moderated lines (which KEEP their moderation), adds and takes off nobody, never touches a released person, leaves a
    calibrator's band move where it was, follows the rating records as a retarget, tells the person in their own conversation (no
    "moderated again"), holds a person's own result whose unit would change, and re-scores the Grade H lines that follow it except a
    released unit's
  * the pages: the warning and the Amend button for the super admin only, the amend card's confirm names the unit, the people reached,
    calibrated and released
  * Fill BU result for the super admin: a calibrated person's line is refilled (only a released result is left), the rows carry a
    Calibrated chip, the apply needs the remark action and refuses a plain apply that would reach them; any other viewer is unchanged
  * falsified: each guard changes the outcome when switched off
"""
import atexit
import json
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
a = H.setup()
s = H.Suite("BU KPI: the super admin amends a target and refills a result until results are released")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, CO2 = "ZZBL Group", "ZZBL Unit", "ZZBL Unit2"
NAME = "ZZBL PAT"
U = {}
# A own result, B own result moderated, C none, D Group People's fill + calibrated, E fill + released, K own result moderated +
# calibrated, L fill, F own line not linked, G a holder with no line
HOLD = "ABCDEKL"
SAVE = HOLD + "Y"   # Y is covered by the setup but its line is not linked to it
OLD = dict(threshold=0.2, target=1.0, multiple=100.0, unit="RM (bil)")
NEW1 = dict(threshold=0.3, target=1.1, multiple=100.0, unit="RM (bil)")
NEW2 = dict(threshold=0.4, target=1.2, multiple=100.0, unit="RM (bil)")
NEW3 = dict(threshold=0.4, target=1200.0, multiple=100.0, unit="RM (mil)")
REMARK = "ZZBL the unit's audited figure moved"


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BL-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        gp = [r[0] for r in db.execute("SELECT id FROM gradeh_people WHERE user_id IN (%s)" % ph, ul)]
        if gp:
            pg = ",".join("?" * len(gp))
            db.execute("DELETE FROM gradeh_kpi_lines WHERE person_id IN (%s)" % pg, gp)
            db.execute("DELETE FROM gradeh_appraisals WHERE person_id IN (%s)" % pg, gp)
            db.execute("DELETE FROM gradeh_people WHERE id IN (%s)" % pg, gp)
        tl = [r[0] for r in db.execute("SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)]
        if tl:
            pt = ",".join("?" * len(tl))
            for tb in ("pm_kpi_approvals", "pm_kpi_results", "pm_kpi_moderation_drafts", "pm_kpi_target_approvers", "pm_checkins"):
                db.execute("DELETE FROM %s WHERE kpi_target_id IN (%s)" % (tb, pt), tl)
        db.execute("DELETE FROM result_releases WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM lm_handover_archive WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_review_chat WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_manager_chat WHERE reviewer_id IN (%s) OR report_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action IN ('pm_bu_kpi','pm_bu_fill','gradeh_bu_fill') AND detail LIKE '%ZZBL%'")
    db.execute("DELETE FROM pm_calibration_sessions WHERE business_group=?", (BG,))
    db.execute("DELETE FROM gradeh_releases WHERE unit IN (?,?)", (CO, CO2))
    db.execute("DELETE FROM admin_roles WHERE name='ZZBL role'")
    db.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def n_of(sql, *args):
    return H.one(a, sql, args)


def put_window(opens):
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', ?, NULL)", (CID, opens))
        d_.commit()


def stamp(days):
    with a.app.app_context():
        return (a._now_myt() + timedelta(days=days)).strftime("%Y-%m-%d %H:%M")


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    PREV = dict(db.execute("SELECT kind, year, half, min_job_grade, open_by_date FROM cycles WHERE id=?", (CID,)).fetchone())
    W0 = db.execute("SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'", (CID,)).fetchone()
    R0 = db.execute("SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell='pm_results'", (CID,)).fetchone()

    def _put_back():
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=?, open_by_date=? WHERE id=?",
                       (PREV["kind"], PREV["year"], PREV["half"], PREV["min_job_grade"], PREV["open_by_date"], CID))
            for cell, w in (("pm_hod", W0), ("pm_results", R0)):
                d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell=?", (CID, cell))
                if w:
                    d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell, w[0], w[1]))
            d_.commit()
    atexit.register(_put_back)
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_results', '2020-01-01 00:00', NULL)", (CID,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'B')", (BG,))
    LIB = db.execute(
        "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, "
        "method, weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, 'Financial', 'RM (bil)', 'more', 20, 1)",
        (BG, NAME)).lastrowid
    for e, nm, co_, g_ in (("M", "Manager", CO, "21"), ("H1", "Hod", CO, "22")):
        U[e] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                          "department, job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?, 'Management', ?, '2020-01-01')",
                          ("zz9bl-" + e.lower(), "ZZ BL " + nm, "ZZ9BL-" + e, BG, co_, g_)).lastrowid
    for e in HOLD + "FGY":
        U[e] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                          "department, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', 'user', ?,?,?, 'Sales', '14', "
                          "'2020-01-01', ?)", ("zz9bl-" + e.lower(), "ZZ BL " + e, "ZZ9BL-" + e, BG, CO, U["M"])).lastrowid
        if e != "G":   # G has no line of this name at all
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, threshold, target, "
                       "multiple, business_group, company, library_id) VALUES (?,?,?, 30, 'more', ?, 'Financial', ?, ?, ?, ?,?,?)",
                       (CID, U[e], NAME, OLD["unit"], OLD["threshold"], OLD["target"], OLD["multiple"], BG, CO, LIB))
    db.execute("UPDATE users SET hod_id=? WHERE id IN (?,?)", (U["H1"], U["D"], U["K"]))
    # two Grade H people follow the setup: GA in the unit, GB from another unit whose Grade H results are released
    for e, co_ in (("GA", CO), ("GB", CO2)):
        U[e] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                          "department, job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?, 'Sales', 'H', '2020-01-01')",
                          ("zz9bl-" + e.lower(), "ZZ BL " + e, "ZZ9BL-" + e, BG, co_)).lastrowid
    ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZBL role', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(ROLE, "pm.read"), (ROLE, "pm.bu_kpi")])
    BGADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg, "
                       "admin_role_id) VALUES ('zz9bl-bga', 'ZZ BL Group Admin', 'x', 'admin', 'ZZ9BL-BGA', ?, ?, ?)",
                       (BG, BG, ROLE)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
BA = H.client_as(a, BGADM)
URL = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
FURL = "/admin/performance/bu-fill?business_group=%s&company=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
K = "k%d_" % LIB
COLS = "t.id, t.threshold, t.target, t.multiple, t.unit, t.method, t.bu_kpi_id, t.weightage"


def ln(eid):
    r = H.rows(a, "SELECT %s FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND u.employee_id=? "
                  "AND t.kpi_name=?" % COLS, (CID, "ZZ9BL-" + eid, NAME))
    return tuple(r[0]) if r else None


def figs(eid):
    r = ln(eid)
    return None if r is None else (r[1], r[2], r[3], r[4])


def F(d):
    return (d["threshold"], d["target"], d["multiple"], d["unit"])


def result_of(tid):
    r = H.rows(a, "SELECT actual_value, note, draft, admin_filled, submitted_at FROM pm_kpi_results WHERE kpi_target_id=?", (tid,))
    return tuple(r[0]) if r else None


def setup_row():
    with a.app.app_context():
        d_ = a.get_db()
        return dict(d_.execute("SELECT * FROM pm_bu_kpis WHERE business_group=? AND company=? AND kpi_name=?", (BG, CO, NAME)).fetchone())


def n_appr(eid):
    return n_of("SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=?", ln(eid)[0])


def n_draft(eid):
    return n_of("SELECT COUNT(*) FROM pm_kpi_moderation_drafts WHERE kpi_target_id=?", ln(eid)[0])


def save(fig, who, client=None):
    form = {"csrf_token": "tok", "action": "save_kpi", "kpi": str(LIB), K + "threshold": str(fig["threshold"]),
            K + "target": str(fig["target"]), K + "multiple": str(fig["multiple"]), K + "unit": fig["unit"],
            K + "carriers": "holders", K + "wmode": "own", K + "holder_set": "1", K + "holder": ["ZZ9BL-" + e for e in who]}
    return (client or SUP).post(URL, data=form, follow_redirects=True).get_data(as_text=True).replace("&#39;", "'")


def late(fig, client=None, remark=REMARK, follow=True, extra=None, setup=None, action="save_kpi_late"):
    form = {"csrf_token": "tok", "action": action, "setup": str(setup if setup is not None else setup_row()["id"]),
            "threshold": str(fig["threshold"]), "target": str(fig["target"]), "multiple": str(fig["multiple"]), "unit": fig["unit"],
            "method": "more"}
    if remark is not None:
        form["remark"] = remark
    form.update(extra or {})
    r = (client or SUP).post(URL, data=form, follow_redirects=follow)
    return r.get_data(as_text=True).replace("&#39;", "'") if follow else r


def audit_late():
    return [r[0] for r in H.rows(a, "SELECT detail FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZBL%' "
                                    "AND detail LIKE '%amended late%' ORDER BY id")]


def last_note(eid):
    r = H.rows(a, "SELECT content FROM pm_review_chat WHERE subject_id=? AND role='agent' ORDER BY id DESC LIMIT 1", (U[eid],))
    return r[0][0] if r else ""


def gh_line(k):
    return H.rows(a, "SELECT l.bu_pct, l.bu_value, l.bu_kpi_id FROM gradeh_kpi_lines l JOIN gradeh_people p ON p.id=l.person_id "
                     "WHERE p.user_id=?", (U[k],))[0]


def gh_expect(fig, value=1.082):
    with a.app.app_context():
        d_ = a.get_db()
        st_ = dict(setup_row())
        st_.update(fig)
        return round(a.gradeh_bu_result_of(d_, st_, value, "FIAMMA")[1], 2)


def put_approval(eid):
    with a.app.app_context():
        d_ = a.get_db()
        tid = ln(eid)[0]
        d_.execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id=?", (tid,))
        d_.execute("DELETE FROM pm_kpi_moderation_drafts WHERE kpi_target_id=?", (tid,))
        d_.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, adjusted_value, justification, acted_by) "
                   "VALUES (?,1,'adjust',0.9,0.95,'ZZBL moderator',?)", (tid, U["M"]))
        d_.commit()


def state_now():
    with a.app.app_context():
        db = a.get_db()
        return a._bu_kpi_state(db, a.active_cycle(db))


def unlink_y():
    """Y: covered by the setup (a holder) but its own line is not linked to it, on the earlier figures."""
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_kpi_targets SET bu_kpi_id=NULL, threshold=?, target=?, multiple=?, unit=? WHERE id=?",
                   (OLD["threshold"], OLD["target"], OLD["multiple"], OLD["unit"], ln("Y")[0]))
        d_.commit()


def seed_results():
    """Every holder's line back as the world started: results, moderation and the earlier figures (the lines stay linked)."""
    with a.app.app_context():
        d_ = a.get_db()
        tids = [ln(e)[0] for e in HOLD]
        ph = ",".join("?" * len(tids))
        for tb in ("pm_kpi_approvals", "pm_kpi_results", "pm_kpi_moderation_drafts", "pm_kpi_target_approvers"):
            d_.execute("DELETE FROM %s WHERE kpi_target_id IN (%s)" % (tb, ph), tids)
        for e in HOLD:
            d_.execute("UPDATE pm_kpi_targets SET threshold=?, target=?, multiple=?, unit=? WHERE id=?",
                       (OLD["threshold"], OLD["target"], OLD["multiple"], OLD["unit"], ln(e)[0]))
        d_.execute("UPDATE pm_bu_kpis SET threshold=?, target=?, multiple=?, unit=? WHERE business_group=? AND company=? AND kpi_name=?",
                   (OLD["threshold"], OLD["target"], OLD["multiple"], OLD["unit"], BG, CO, NAME))
        for e in "DEL":   # Group People's Fill BU result
            d_.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, submitted_at, draft, admin_filled) "
                       "VALUES (?, 1.082, NULL, ?, '2026-01-01 00:00:00', 0, 1)", (ln(e)[0], SU["id"]))
        for e, v in (("A", 0.9), ("B", 0.8), ("K", 0.85)):   # the person's own result
            d_.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, submitted_at, draft, admin_filled) "
                       "VALUES (?, ?, 'ZZBL own', ?, '2026-01-01 00:00:00', 0, 0)", (ln(e)[0], v, U[e]))
        for e in "BK":   # moderated by the line manager
            d_.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (ln(e)[0], U["M"]))
            d_.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, adjusted_value, justification, acted_by) "
                       "VALUES (?,1,'adjust',0.9,0.95,'ZZBL moderator',?)", (ln(e)[0], U["M"]))
        d_.commit()


def reset_world(pct=None):
    seed_results()
    unlink_y()
    if pct is not None:
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("UPDATE gradeh_kpi_lines SET bu_pct=?, bu_value=1.082, bu_kpi_id=? WHERE person_id IN (SELECT id FROM gradeh_people WHERE "
                       "user_id IN (?,?))", (pct, setup_row()["id"], U["GA"], U["GB"]))
            d_.commit()


try:
    s.section("set up: the unit's setup saved, lines adopted, then results, moderation, a calibration, a release and two Grade H lines")
    put_window(stamp(1))   # the Department Review starts tomorrow: BU KPI setup is open
    save(OLD, SAVE)
    SID = setup_row()["id"]
    s.check("the setup is saved and every holder's line is on it; F keeps its own line, G has none", all(
        figs(e) == F(OLD) and ln(e)[6] == SID for e in HOLD) and ln("F")[6] is None and ln("G") is None, [ln(e) for e in HOLD])
    TID = {e: ln(e)[0] for e in HOLD + "FY"}
    unlink_y()
    with a.app.app_context():
        db = a.get_db()
        # G is named in the setup's people, yet holds no line: a late save must not add one
        data = json.loads(db.execute("SELECT carriers_json FROM pm_bu_kpis WHERE id=?", (SID,)).fetchone()[0])
        data["people"] = sorted(set(data.get("people") or []) | {"ZZ9BL-G"})
        db.execute("UPDATE pm_bu_kpis SET carriers_json=? WHERE id=?", (json.dumps(data), SID))
        db.commit()
    seed_results()
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO result_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?, 'pm', ?)", (CID, U["E"], SU["id"]))
        sess = db.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label) VALUES "
                          "(?, 'hod', ?, ?, 'ZZBL hod')", (CID, str(U["H1"]), BG)).lastrowid   # open: a calibrator moved two bands
        for e in "DK":
            db.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band, justification, adjusted_by) "
                       "VALUES (?,?, 'EX', 'HI', 'ZZBL', ?)", (sess, U[e], U["H1"]))
        for e, co_ in (("GA", CO), ("GB", CO2)):
            pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, appraiser_id, language, private_company) "
                             "VALUES (?,?,?, 'A', ?, 'en', 0)", (CID, "ZZ9BL-" + e, U[e], U["M"])).lastrowid
            db.execute("INSERT INTO gradeh_kpi_lines (cycle_id, person_id, kpi_name, weight, group_scale, sort_order, bu_kpi_id, bu_value) "
                       "VALUES (?,?,?, 100, 'FIAMMA', 1, ?, 1.082)", (CID, pid, NAME, SID))
        db.execute("INSERT INTO gradeh_releases(cycle_id, unit, released_by) VALUES (?,?,?)", (CID, CO2, SU["id"]))
        db.commit()
    # the Grade H lines hold the percent the OLD target scored for 1.082
    pct_old = gh_expect(OLD)
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE gradeh_kpi_lines SET bu_pct=? WHERE bu_kpi_id=?", (pct_old, SID))
        db.commit()
    RES0 = {e: result_of(TID[e]) for e in HOLD}
    ADJ0 = H.rows(a, "SELECT subject_id, adjusted_band FROM pm_calibration_adjustments ORDER BY id")
    s.check("the world: 7 linked lines, 1 released, 2 calibrated; two Grade H lines on the old percent",
            n_of("SELECT COUNT(*) FROM pm_kpi_targets WHERE bu_kpi_id=?", SID) == 7 and gh_line("GA")[0] == pct_old
            and gh_line("GB")[0] == pct_old)
    N_LINES = n_of("SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name=?", CID, NAME)
    calls = []
    _rr = a._rating_record_refresh

    def _rr_spy(db_, cid_, sids_, event_, *rest, **kw):
        calls.append((event_, tuple(sorted(sids_))))
        return _rr(db_, cid_, sids_, event_, *rest, **kw)
    a._rating_record_refresh = _rr_spy

    s.section("part 1: a setup save (the page open) never touches a released person; a moderated line still goes back to its moderators")
    out = save(NEW1, SAVE)
    s.check("A, C, D, L, K, B take the new figures", all(figs(e) == F(NEW1) for e in "ACDLKB"), [ln(e) for e in "ACDLKB"])
    s.check("E (result released) is left exactly as it was: figures and result", figs("E") == F(OLD) and result_of(TID["E"]) == RES0["E"], ln("E"))
    s.check("...the page says so", "1 person left as they are: their result is released." in out, out[out.find("saved for"):][:400])
    s.check("...the trail counts them", n_of("SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZBL PAT%set for%1 left "
                                              "as they are: their result is released%'") == 1)
    s.check("B and K (moderated) went back to their moderators in the normal save: approvals cleared, a draft seeded",
            n_appr("B") == 0 and n_appr("K") == 0 and n_draft("B") >= 1, (n_appr("B"), n_draft("B")))
    s.check("...and the person's note says they are being moderated again", "being moderated again" in last_note("B"), last_note("B"))
    s.check("the Grade H line of the unit is re-scored, the released unit's is left as it was", gh_line("GA")[0] == gh_expect(NEW1)
            and gh_line("GB")[0] == pct_old, (gh_line("GA"), gh_line("GB"), gh_expect(NEW1)))
    s.check("the people's results are untouched", all(result_of(TID[e]) == RES0[e] for e in "ABDKL"))
    reset_world(pct_old)   # the earlier figures, results and moderation again, for the late tests

    s.section("part 2: the page, once the Department Review has started")
    put_window(stamp(-1))
    open_, note = state_now()
    s.check("BU KPI setup reads only", open_ is False and note.startswith("The Department Review started"), (open_, note))
    pg = SUP.get(URL + "&kpi=%d" % LIB).get_data(as_text=True).replace("&#39;", "'")
    s.check("the super admin reads the warning at the top", "As super admin you can still change a KPI's target, unit and method until "
            "results are released. A change reaches lines already reviewed and calibrated: a band a calibrator moved stays; a band nobody moved "
            "follows the new score. Released people are left as they are." in pg and "The Department Review started on" in pg)
    s.check("...and an Amend target button", ">Amend target<" in pg and "edit=1" in pg)
    pb = BA.get(URL + "&kpi=%d" % LIB).get_data(as_text=True)
    s.check("a group admin sees neither the warning nor the button", "As super admin" not in pb and "Amend target" not in pb and 'value="save_kpi_late"' not in pb)
    def notes(h):
        """(the read-only note, the late warning, the warning in bold, the Fill BU result link on the late line) on a page."""
        h = h.replace("&#39;", "'")
        return ("so BU KPIs read only" in h, "data-bk-late-warn" in h and "As super admin you can still change" in h,
                "<b>The Department Review" in h, 'data-bk-late-warn>' in h and "Their results: <a" in h.split("data-bk-late-warn>", 1)[-1][:900])
    s.check("the super admin reads the late warning ALONE (plain weight, with the Fill BU result link on it), and no read-only note; "
            "the group admin reads the read-only note and no warning",
            notes(pg) == (False, True, False, True) and notes(pb)[:2] == (True, False) and "To change a line now, use the person's Performance page" in pb,
            (notes(pg), notes(pb)))
    # the default page, no group picked (2026-11-14): same notes as a unit page
    pd_s = SUP.get("/admin/performance/bu-kpis").get_data(as_text=True)
    pd_b = BA.get("/admin/performance/bu-kpis").get_data(as_text=True)
    s.check("the default page (no group picked): the super admin reads the late warning alone with the Fill BU result link; the group admin reads the read-only note and no warning",
            notes(pd_s) == (False, True, False, True) and notes(pd_b)[:2] == (True, False), (notes(pd_s), notes(pd_b)))
    _is0 = a.is_super
    a.is_super = lambda u: False
    try:
        n_off = notes(SUP.get(URL + "&kpi=%d" % LIB).get_data(as_text=True))
    finally:
        a.is_super = _is0
    a.is_super = lambda u: True
    try:
        n_on = notes(BA.get(URL + "&kpi=%d" % LIB).get_data(as_text=True))
    finally:
        a.is_super = _is0
    s.check("falsified: treated as a non-super the same page reads the read-only note and no warning; a group admin treated as super reads the warning and no read-only note",
            n_off[:2] == (True, False) and n_on[:2] == (False, True), (n_off, n_on))
    pe = SUP.get(URL + "&kpi=%d&edit=1" % LIB).get_data(as_text=True).replace("&#39;", "'")
    s.check("the amend card posts save_kpi_late with the setup, asks the remark, shows the figures", 'value="save_kpi_late"' in pe
            and 'name="setup" value="%d"' % SID in pe and 'data-confirm-reason-field="remark"' in pe and 'name="threshold"' in pe
            and 'value="0.2"' in pe and "As super admin you can still change" in pe)
    _bad = [x for x in ('name="k%d_carriers"' % LIB, 'name="k%d_wmode"' % LIB, 'bk-seg', 'name="weight"') if x in pe]
    s.check("...with no carriers, weight or library fields on it", not _bad, _bad)
    s.check("...the confirm names the unit and KPI, 6 people reached, 2 calibrated, 1 released", all(x in pe for x in (
        "Amend ZZBL PAT for", "go on 6 lines", "2 people are calibrated", "1 person is released and left as they are")), pe[pe.find("data-confirm="):][:700])
    pbe = BA.get(URL + "&kpi=%d&edit=1" % LIB).get_data(as_text=True)
    _bad = [x for x in ("bk-late-form", 'value="save_kpi_late"', "Amend ZZBL PAT") if x in pbe]
    s.check("a group admin asking for the amend card is shown the read card instead", not _bad, _bad)
    s.check("the card's ordinary Save is still refused while it reads only", "Nothing was saved" in save(NEW1, HOLD) and figs("A") == F(OLD))

    s.section("part 3: who may, and what is refused")
    r = late(NEW2, client=BA, follow=False)
    s.check("a group admin posting it gets 403, nothing changes", r.status_code == 403 and figs("A") == F(OLD) and setup_row()["target"] == 1.0, r.status_code)
    r = late(NEW2, remark=None, follow=False)
    s.check("the super admin without a remark is refused, nothing changes", r.status_code in (302, 303) and figs("A") == F(OLD)
            and setup_row()["target"] == 1.0 and not audit_late(), r.status_code)
    s.check("a blank remark too", "Write your remark first" in late(NEW2, remark="  ") and figs("A") == F(OLD))
    s.check("a setup that is not this unit's is refused (400)", late(NEW2, follow=False, setup=999999).status_code == 400)
    bad = late(dict(NEW2, target=""), follow=True)
    s.check("a figure missing is refused in words, nothing saved", "needs Threshold and Target" in bad and "Nothing was saved" in bad
            and setup_row()["target"] == 1.0 and figs("A") == F(OLD), bad[bad.find("needs"):][:200])
    put_window(stamp(1))
    r = late(NEW2)
    s.check("while the page is open the late action is refused: use the card's own Save", "BU KPI setup is open, so use the card's own Save" in r
            and figs("A") == F(OLD) and setup_row()["target"] == 1.0)
    put_window(stamp(-1))

    s.section("part 4: the late amendment")
    SET0 = setup_row()
    calls.clear()
    junk = {"k%d_carriers" % LIB: "everyone", "carriers": "everyone", "wmode": "one", "weight": "55", "category": "Hacked", "library_id": "1",
            "kpi_name": "Hacked", "bmin": "1", "bw": "100", "people": ["ZZ9BL-G", "ZZ9BL-F"], "holder": ["ZZ9BL-F"], "weightage": "99"}
    out = late(NEW2, extra=junk)
    s.check("A (own result), C (none), D (fill, calibrated), L (fill), K (moderated, calibrated) and B (moderated) take the new figures",
            all(figs(e) == F(NEW2) for e in "ACDLKB"), [ln(e) for e in "ACDLKB"])
    s.check("E (result released) is left exactly as it was", figs("E") == F(OLD) and result_of(TID["E"]) == RES0["E"], ln("E"))
    s.check("no result was touched", all(result_of(TID[e]) == RES0[e] for e in HOLD))
    s.check("the setup holds the new figures and nothing else changed (carriers, weight, bands, category, library, name)",
            {k: v for k, v in setup_row().items() if k not in ("threshold", "target", "multiple", "unit", "updated_at", "updated_by")}
            == {k: v for k, v in SET0.items() if k not in ("threshold", "target", "multiple", "unit", "updated_at", "updated_by")}
            and (setup_row()["threshold"], setup_row()["target"]) == (0.4, 1.2), setup_row())
    s.check("the weights stay as they were on every line", all(ln(e)[7] == 30.0 for e in "ABCDEKL"))
    s.check("nobody was added or taken off: G has no line, F keeps its own, the line count is the same",
            ln("G") is None and ln("F")[6] is None and figs("F") == F(OLD) and n_of(
                "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name=?", CID, NAME) == N_LINES)
    s.check("B and K (moderated) KEEP their moderation: the approval stays, nothing is sent back, no draft is seeded",
            n_appr("B") == 1 and n_appr("K") == 1 and n_draft("B") == 0 and n_draft("K") == 0, (n_appr("B"), n_draft("B")))
    s.check("the people with a result are told in their own conversation, with no 'moderated again'",
            all("changed in your unit's BU KPI setup" in last_note(e) for e in "ABK") and "moderated again" not in last_note("B")
            and "moderated again" not in last_note("K"), (last_note("A"), last_note("B")))
    s.check("a calibrator's band moves stand", H.rows(a, "SELECT subject_id, adjusted_band FROM pm_calibration_adjustments ORDER BY id") == ADJ0)
    s.check("the rating records follow, once each, as a retarget, for everyone whose line took the new target",
            len(calls) == 1 and calls[0][0] == "bu_kpi_retarget" and set(calls[0][1]) >= {U["A"], U["B"], U["K"], U["D"], U["L"]}
            and U["E"] not in calls[0][1], calls)
    s.check("the Grade H line of the unit is scored again; the released unit's is left", gh_line("GA")[0] == gh_expect(NEW2)
            and gh_line("GB")[0] == pct_old and gh_expect(NEW2) != pct_old, (gh_line("GA"), gh_line("GB"), gh_expect(NEW2)))
    s.check("the page says what happened", "6 of 6 lines took the new target, unit and method." in out
            and "2 moderated lines kept their moderation and are scored against the new target" in out
            and "2 calibrated: a band a calibrator moved stays, a band nobody moved follows the new score." in out
            and "1 left as they are: their result is released." in out, out[out.find("amended for"):][:700])
    al = audit_late()
    s.check("one audit line: the counts and the super admin's remark", len(al) == 1 and "amended late, after the Department Review started" in al[0]
            and "6 reached, of them 2 calibrated" in al[0] and "remark: " + REMARK in al[0], al)
    s.check("the page again reads the new figures on the card", "0.4" in SUP.get(URL + "&kpi=%d" % LIB).get_data(as_text=True))
    s.check("a second identical amendment changes nothing more (0 updated)", "0 of 6 lines took the new target" in late(NEW2))

    s.section("part 5: a new unit: a person's own result that would change meaning is held, a Group People fill moves")
    put_approval("B")
    n3 = late(NEW3)
    s.check("C, D, L take the new unit (a fill is the unit's, not the person's); A, B, K (their own result) are held on the old unit",
            all(figs(e) == F(NEW3) for e in "CDL") and all(figs(e) == F(NEW2) for e in "ABK"), [ln(e) for e in "ABCDKL"])
    s.check("...the page says 3 held because their own result is in another unit or method; the released one is left", "3 held because their own result is in another unit or method." in n3
            and "1 left as they are: their result is released." in n3, n3[n3.find("amended for"):][:600])
    s.check("...the unit's Group People figure is untouched", all(result_of(TID[e]) == RES0[e] for e in "DL"))
    mp, mpw = None, None
    with a.app.app_context():
        mp = a._bu_kpi_late_parse({"method": "less", "threshold": "0.4", "target": "1.2", "multiple": "100", "unit": "RM (bil)"}, setup_row(),
                                  a.get_db().execute("SELECT * FROM pm_bg_config WHERE business_group=?", (BG,)).fetchone())
        mpw = a._bu_kpi_late_parse({"threshold": "0.4", "target": "1.2", "multiple": "100"}, setup_row(),
                                   a.get_db().execute("SELECT * FROM pm_bg_config WHERE business_group=?", (BG,)).fetchone())
    s.check("the method is read from the form (Lower is better with a rising scale is refused); absent keeps the saved method and unit",
            mp[0] is None and mp[1] and mpw[0] and mpw[0]["method"] == "more" and mpw[0]["unit"] == "RM (mil)", (mp, mpw))
    # put the unit back to the earlier one for the Fill part
    late(dict(NEW2, unit="RM (bil)"))
    s.check("(put back) the unit goes back for the lines that can take it", all(figs(e)[3] == "RM (bil)" for e in "CDL"))

    s.section("part 6: Fill BU result, the super admin: until results are released")
    reset_world(pct_old)
    FQ = FURL + "&kpi_name=" + NAME.replace(" ", "+")
    pgs = SUP.get(FQ).get_data(as_text=True).replace("&#39;", "'")
    pga = BA.get(FQ).get_data(as_text=True).replace("&#39;", "'")
    s.check("the super admin's page says 2 people are calibrated and asks the remark; the apply posts apply_calibrated",
            "2 people below are calibrated. As super admin you can still fill their line until their result is released" in pgs
            and 'name="action" value="apply_calibrated"' in pgs and 'data-confirm-reason-field="remark"' in pgs)
    s.check("...the rows carry a Calibrated chip on the two, and E reads Released, stays as filled", pgs.count(">Calibrated<") == 2
            and "Released, stays as filled" in pgs and "Calibrated, stays as filled" not in pgs, (pgs.count(">Calibrated<"),))
    s.check("a group admin's page has no calibrated note, no remark action, no chip, and still holds the calibrated people",
            "people below are calibrated" not in pga and "apply_calibrated" not in pga and ">Calibrated<" not in pga
            and "Calibrated, stays as filled" in pga, pga.count("Calibrated"))

    def calc(client, v="1.234"):
        r = client.post(FURL, data={"csrf_token": "tok", "action": "calc", "business_group": BG, "company": CO, "kpi_name": NAME,
                                    "actual_value": v}, headers={"X-Requested-With": "fetch"})
        return r.get_json()
    cs, ca = calc(SUP), calc(BA)
    s.check("the live preview: the super admin reaches D, K (calibrated), L, A, B, C = 6 lines, 2 of them calibrated; E is left",
            cs["n_fill"] == 6 and cs["n_cal"] == 2, (cs["n_fill"], cs["n_cal"]))
    s.check("...a group admin reaches A, B, C only, none calibrated: D, E, K, L are left", ca["n_fill"] == 3 and ca["n_cal"] == 0, (ca["n_fill"], ca["n_cal"]))

    def fill(client, v="1.234", **extra):
        form = {"csrf_token": "tok", "business_group": BG, "company": CO, "kpi_name": NAME, "actual_value": v, "note": "", "reason": "ZZBL reason"}
        form.update(extra)
        return client.post(FURL, data=form, follow_redirects=True).get_data(as_text=True).replace("&#39;", "'")

    def vals():
        return {e: (result_of(ln(e)[0]) or (None,))[0] for e in HOLD}
    V0 = vals()
    with a.app.app_context():   # Grade H lines that share the result make the fill the super admin's alone: set them aside for the group admin's
        d_ = a.get_db()
        d_.execute("UPDATE gradeh_kpi_lines SET bu_kpi_id=NULL WHERE bu_kpi_id=?", (SID,))
        d_.commit()
    fill(BA, "1.5")
    V3 = vals()
    s.check("a group admin's fill is unchanged: A, B, C take it; the calibrated D and K, the released E and the fill L are left",
            all(V3[e] == 1.5 for e in "ABC") and all(V3[e] == V0[e] for e in "DEKL"), (V0, V3))
    reset_world(pct_old)
    out = fill(SUP)
    s.check("a plain apply that would reach calibrated people is refused, nothing written", "reaches 2 calibrated people, which needs your remark" in out
            and vals() == V0 and n_appr("B") == 1, (vals(), V0))
    out = fill(SUP, action="apply_calibrated", reason="")
    s.check("the remark action without a remark is refused by the gate, nothing written", "Write your remark first" in out and vals() == V0)
    ARC0 = n_of("SELECT COUNT(*) FROM lm_handover_archive WHERE part='pm_bu_fill' AND subject_id IN (?,?)", U["B"], U["K"])
    out = fill(SUP, action="apply_calibrated", remark="ZZBL fill after calibration", reason="")
    V1 = vals()
    s.check("with the remark, every line but the released one takes the figure", all(V1[e] == 1.234 for e in "ABCDKL") and V1["E"] == V0["E"], V1)
    s.check("...the released person's result and line are untouched", result_of(TID["E"]) == RES0["E"])
    s.check("...the calibrator's band moves stand", H.rows(a, "SELECT subject_id, adjusted_band FROM pm_calibration_adjustments ORDER BY id") == ADJ0)
    s.check("...the moderated lines were replaced (approvals archived and cleared)", n_appr("B") == 0 and n_appr("K") == 0 and n_of(
        "SELECT COUNT(*) FROM lm_handover_archive WHERE part='pm_bu_fill' AND subject_id IN (?,?)", U["B"], U["K"]) == ARC0 + 2)
    s.check("...the page says 2 calibrated; the audit line carries the remark", "2 calibrated: a band a calibrator moved stays" in out and n_of(
        "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_fill' AND detail LIKE '%2 calibrated people included%' AND "
        "detail LIKE '%ZZBL fill after calibration%'") == 1)

    s.section("falsified: each guard changes the outcome when switched off")

    def reset_late():
        reset_world(pct_old)

    def edit_amend(client=None, **kw):
        return late(NEW2, client=client, follow=False, **kw)
    reset_late()
    # 1. the super-only gate: with a group admin treated as super, the late save would run
    _is = a.is_super
    a.is_super = lambda u: True
    try:
        r = edit_amend(client=BA)
    finally:
        a.is_super = _is
    s.check("super check off: a group admin's amendment would run (so the super check is what stops it)", figs("A") == F(NEW2), (r.status_code, ln("A")))
    reset_late()
    # 2. the remark
    _acts = a.SUPER_BAND_ENDPOINTS["admin_bu_kpis"]
    a.SUPER_BAND_ENDPOINTS["admin_bu_kpis"] = frozenset({"bring_held"})
    try:
        r = edit_amend(remark=None)
    finally:
        a.SUPER_BAND_ENDPOINTS["admin_bu_kpis"] = _acts
    s.check("remark list off: the same post with no remark is accepted and changes the lines (the list is what asks)", figs("A") == F(NEW2), r.status_code)
    reset_late()
    # 3. the released skip in the apply
    _rm = a.setup_released_many
    a.setup_released_many = lambda db_, ids_, cid_, kind_: {i: None for i in ids_}
    try:
        edit_amend()
    finally:
        a.setup_released_many = _rm
    s.check("released skip off: E's line would take the new target (so the skip is what leaves it)", figs("E") == F(NEW2), ln("E"))
    reset_late()
    # 4. the moderation kept
    _bm = a._bu_kpi_back_to_moderation
    a._bu_kpi_back_to_moderation = lambda db_, me_, act_, ch_, out_, touched=None, keep=False: _bm(db_, me_, act_, ch_, out_, touched=touched, keep=False)
    try:
        edit_amend()
    finally:
        a._bu_kpi_back_to_moderation = _bm
    s.check("moderation kept off: B and K would go back to their moderators in a late save (so `late` is what keeps them)",
            n_appr("B") == 0 and n_appr("K") == 0 and n_draft("B") >= 1, (n_appr("B"), n_draft("B")))
    reset_late()
    # 5. nobody added or adopted
    s.check("(before) Y, covered with its own unlinked line, is not adopted by a late save", (edit_amend(), ln("Y")[6])[1] is None and figs("Y") == F(OLD), ln("Y"))
    reset_late()
    _ap = a._bu_kpi_apply
    a._bu_kpi_apply = lambda db_, me_, act_, s_, people_, **kw: _ap(db_, me_, act_, s_, people_, **dict(kw, late=False))
    try:
        edit_amend()
    finally:
        a._bu_kpi_apply = _ap
    s.check("late filter off: Y (covered, line not linked) is adopted and given the new target (so `late` is what adopts nobody)",
            ln("Y")[6] == SID and figs("Y") == F(NEW2), ln("Y"))
    reset_late()
    # 6. Fill: the released-only hold (a calibrated person is held again with the full hold)
    _ph = a._pm_calibration_hold
    a._pm_calibration_hold = lambda db_, cid_, subj_, released_only=False: _ph(db_, cid_, subj_)
    try:
        c2 = calc(SUP)
    finally:
        a._pm_calibration_hold = _ph
    s.check("released-only off: the super admin's fill would hold D and K again (4 lines, none calibrated)", c2["n_fill"] == 4 and c2["n_cal"] == 0, (c2["n_fill"], c2["n_cal"]))
    # 7. Fill: the release hold itself
    _rh = a._pm_release_hold
    a._pm_release_hold = lambda db_, cid_, ids_: set()
    try:
        c3 = calc(SUP)
    finally:
        a._pm_release_hold = _rh
    s.check("release hold off: E would be refilled too (7 lines), so the release is what leaves it", c3["n_fill"] == 7, c3["n_fill"])
    # 8. Fill: the remark cannot be skipped: with the flag off a plain apply writes D
    _fb = a._bu_fill_buckets

    def _nocal(*args, **kw):
        t_, b_, su_, c_ = _fb(*args, **kw)
        for k_ in b_:
            for row in b_[k_]:
                row["calibrated"] = False
        return t_, b_, su_, c_
    a._bu_fill_buckets = _nocal
    try:
        fill(SUP, "1.7")
    finally:
        a._bu_fill_buckets = _fb
    s.check("calibrated flag off: a plain apply would fill the calibrated D without any remark (so the flag is what refuses it)",
            result_of(ln("D")[0])[0] == 1.7, result_of(ln("D")[0]))
    reset_late()
    # 9. Fill: the remark list
    _fa = a.SUPER_BAND_ENDPOINTS.pop("admin_performance_bu_fill")
    try:
        fill(SUP, "1.8", action="apply_calibrated", reason="ZZBL x")
    finally:
        a.SUPER_BAND_ENDPOINTS["admin_performance_bu_fill"] = _fa
    s.check("remark list off: apply_calibrated with no remark is accepted (so the list is what asks)", result_of(ln("D")[0])[0] == 1.8, result_of(ln("D")[0]))
    reset_late()
    # 10. Grade H: a released unit's line is left by the refresh; with the release gone it is re-scored
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_bu_kpis SET threshold=?, target=?, multiple=?, unit=? WHERE id=?", (NEW2["threshold"], NEW2["target"], NEW2["multiple"], NEW2["unit"], SID))
        d_.commit()
        me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        a.gradeh_bu_refresh(d_, me_, d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (SID,)).fetchone())
        d_.commit()
    s.check("Grade H refresh: the unit's line moves, the released unit's stays", gh_line("GA")[0] == gh_expect(NEW2) and gh_line("GB")[0] == pct_old,
            (tuple(gh_line("GA")), tuple(gh_line("GB")), gh_expect(NEW2), pct_old))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM gradeh_releases WHERE unit=?", (CO2,))
        d_.commit()
        me_ = d_.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        a.gradeh_bu_refresh(d_, me_, d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (SID,)).fetchone())
        d_.commit()
    s.check("falsified: with the unit not released the same refresh re-scores the other line too", gh_line("GB")[0] == gh_expect(NEW2), tuple(gh_line("GB")))
finally:
    try:
        a._rating_record_refresh = _rr
    except NameError:
        pass
    _put_back()
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    else:
        os.environ["ONEHR_GRADEH"] = _ENV0

sys.exit(s.done())
