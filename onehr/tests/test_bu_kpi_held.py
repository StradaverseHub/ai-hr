"""A BU KPI's saved figures reach Group People's Fill BU lines, and the lines still on earlier figures can be brought onto the
setup (Chris, 2026-11-14: "edited BU KPI target must reach the Fill BU KPI page"). Production case: the super admin saved
Profit after tax with new figures AND a new unit (RM (bil) to RM (mil)); the 3 lines already holding Group People's Fill BU result
were held for "the unit differs", so Fill BU KPI and the scores read the old target.

What this suite holds (a Year-End, Mechanism B, the Department Review window moved to read only for the second half):
  * a save that changes the unit: a line whose only result is Group People's fill takes the figures, unit and method and keeps its
    result untouched; a line with the person's own result, a person's draft, or a fill the line manager moderated is still held
    ("the method or unit differs"); a line with no result takes it as always; an uncovered line with a result stays held
  * `bring_held` (Bring them onto this setup): the super admin's alone (403 for a group admin), refused without a remark, works while
    BU KPI setup reads only, brings only lines already linked to the setup whose person it still covers and whose figures differ,
    adds no line to anyone (an uncovered person, a covered person whose line is not linked), changes no setup, leaves a released
    or calibrated person as they are, reports a person-typed result it cannot move, writes the remark in the audit line, and
    Fill BU's selection and score then read the new target
  * the page: the "Earlier figures" chip on each such row, the count, the button for the super admin only
  * falsified: the fill rule, the covered filter, the released and calibration skips each change the outcome when switched off
"""
import atexit
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("BU KPI: saved figures reach Group People's fill, held lines brought onto the setup")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO = "ZZBH Group", "ZZBH Unit"
NAME = "ZZBH PAT"
U = {}
# A fill, B own result, C fill the manager moderated, D own draft, E fill (calibrated), F fill (released), G fill, H fill but no
# longer covered, I own line never on the setup, J no result, Y covered but the line is not linked, X covered by nothing
EIDS = ("A", "B", "C", "D", "E", "F", "G", "H", "J", "Y")
OLD = dict(threshold=0.2, target=1.386, multiple=100.0, unit="RM (bil)")
NEW = dict(threshold=0.724, target=0.905, multiple=100.0, unit="RM (mil)")
REMARK = "ZZBH repair of the PAT unit"


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BH-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        tl = [r[0] for r in db.execute("SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)]
        if tl:
            pt = ",".join("?" * len(tl))
            for tb in ("pm_kpi_approvals", "pm_kpi_results", "pm_kpi_moderation_drafts", "pm_kpi_target_approvers",
                       "pm_checkins"):
                db.execute("DELETE FROM %s WHERE kpi_target_id IN (%s)" % (tb, pt), tl)
        db.execute("DELETE FROM result_releases WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_review_chat WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_manager_chat WHERE reviewer_id IN (%s) OR report_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action IN ('pm_bu_kpi','pm_bu_fill') AND detail LIKE '%ZZBH%'")
    db.execute("DELETE FROM pm_calibration_sessions WHERE business_group=?", (BG,))
    db.execute("DELETE FROM admin_roles WHERE name='ZZBH role'")
    db.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


COLS = "t.id, t.threshold, t.target, t.multiple, t.unit, t.method, t.bu_kpi_id, t.weightage"


def ln(eid, name=NAME):
    r = H.rows(a, "SELECT %s FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND u.employee_id=? "
                  "AND t.kpi_name=?" % COLS, (CID, "ZZ9BH-" + eid, name))
    return tuple(r[0]) if r else None


def figs(eid):
    """The line's figures and unit: (threshold, target, multiple, unit)."""
    r = ln(eid)
    return None if r is None else (r[1], r[2], r[3], r[4])


OLDF = (OLD["threshold"], OLD["target"], OLD["multiple"], OLD["unit"])
NEWF = (NEW["threshold"], NEW["target"], NEW["multiple"], NEW["unit"])


def n_of(sql, *args):
    return H.one(a, sql, args)


def result_of(tid):
    r = H.rows(a, "SELECT actual_value, note, draft, admin_filled, submitted_at FROM pm_kpi_results WHERE kpi_target_id=?", (tid,))
    return tuple(r[0]) if r else None


def put_window(opens):
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', ?, NULL)",
                   (CID, opens))
        d_.commit()


def stamp(days):
    with a.app.app_context():
        return (a._now_myt() + timedelta(days=days)).strftime("%Y-%m-%d %H:%M")


def reset_line(eid, link=True):
    """Put a line back on the earlier figures and unit, as production's three were."""
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE pm_kpi_targets SET threshold=?, target=?, multiple=?, unit=? WHERE id=?",
                   (OLD["threshold"], OLD["target"], OLD["multiple"], OLD["unit"], ln(eid)[0]))
        d_.commit()


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
                    d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                               (CID, cell, w[0], w[1]))
            d_.commit()
    atexit.register(_put_back)
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_results', "
               "'2020-01-01 00:00', NULL)", (CID,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'B')", (BG,))
    LIB = db.execute(
        "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, "
        "method, weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, 'Financial', 'RM (bil)', 'more', 20, 1)",
        (BG, NAME)).lastrowid
    U["M"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                        "department, job_grade, confirmation_date) VALUES ('zz9bh-m', 'ZZ BH Manager', 'x', 'user', "
                        "'ZZ9BH-M', ?, ?, 'Management', '21', '2020-01-01')", (BG, CO)).lastrowid
    U["H1"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                         "department, job_grade, confirmation_date) VALUES ('zz9bh-h1', 'ZZ BH Hod', 'x', 'user', "
                         "'ZZ9BH-H1', ?, ?, 'Management', '22', '2020-01-01')", (BG, CO)).lastrowid
    for e in EIDS + ("I", "X"):
        U[e] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', 'user', ?,?,?, 'Sales', '14', "
            "'2020-01-01', ?)", ("zz9bh-" + e.lower(), "ZZ BH " + e, "ZZ9BH-" + e, BG, CO, U["M"])).lastrowid
        if e == "I":
            pass
        if e != "X":   # X has no line of this name at all; every other person starts on a line of their own with the old figures
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, threshold, "
                       "target, multiple, business_group, company, library_id) VALUES (?,?,?, 30, 'more', ?, 'Financial', ?, ?, ?, "
                       "?,?,?)", (CID, U[e], NAME, OLD["unit"], OLD["threshold"], OLD["target"], OLD["multiple"], BG, CO, LIB))
    # E is held by a locked HOD session over them; F's result is released
    db.execute("UPDATE users SET hod_id=? WHERE id=?", (U["H1"], U["E"]))
    ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZBH role', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)", [(ROLE, "pm.read"), (ROLE, "pm.bu_kpi")])
    BGADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                       "admin_bg, admin_role_id) VALUES ('zz9bh-bga', 'ZZ BH Group Admin', 'x', 'admin', 'ZZ9BH-BGA', ?, ?, "
                       "?)", (BG, BG, ROLE)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
BA = H.client_as(a, BGADM)
URL = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
K = "k%d_" % LIB


def card(fig, who):
    f = {K + "threshold": str(fig["threshold"]), K + "target": str(fig["target"]), K + "multiple": str(fig["multiple"]),
         K + "unit": fig["unit"], K + "carriers": "holders", K + "wmode": "own", K + "holder_set": "1"}
    f[K + "holder"] = ["ZZ9BH-" + e for e in who]
    return f


def save(fig, who, client=None):
    form = {"csrf_token": "tok", "action": "save_kpi", "kpi": str(LIB)}
    form.update(card(fig, who))
    return (client or SUP).post(URL, data=form, follow_redirects=True).get_data(as_text=True)


def setup_row():
    with a.app.app_context():
        d_ = a.get_db()
        return dict(d_.execute("SELECT * FROM pm_bu_kpis WHERE business_group=? AND company=? AND kpi_name=?",
                               (BG, CO, NAME)).fetchone())


def bring(client=None, remark=REMARK, follow=True):
    form = {"csrf_token": "tok", "action": "bring_held", "setup": str(setup_row()["id"])}
    if remark is not None:
        form["remark"] = remark
    r = (client or SUP).post(URL, data=form, follow_redirects=follow)
    return r if not follow else r.get_data(as_text=True)


def state_now():
    with a.app.app_context():
        db = a.get_db()
        return a._bu_kpi_state(db, a.active_cycle(db))


def audit_lines():
    return [r[0] for r in H.rows(a, "SELECT detail FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZBH%' "
                                    "AND detail LIKE '%brought onto the saved setup%' ORDER BY id")]


try:
    s.section("set up: the unit's setup saved on the earlier figures, then Group People's fill and the people's own results")
    put_window(stamp(1))   # the Department Review starts tomorrow: open
    out = save(OLD, "ABCDEFGHJ")
    s.check("the setup is saved and every holder's line is adopted at the earlier figures", all(
        figs(e) == OLDF and ln(e)[6] == setup_row()["id"] for e in "ABCDEFGHJ"), [ln(e) for e in "ABCDEFGHJ"])
    s.check("...I (not a holder) keeps their own line, unlinked, and X has none", ln("I")[6] is None and ln("X") is None)
    TID = {e: ln(e)[0] for e in EIDS}
    with a.app.app_context():
        db = a.get_db()
        for e in "AEFGH":   # Group People's Fill BU result: final, admin-filled
            db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) "
                       "VALUES (?, 1.082, NULL, ?, 0, 1)", (TID[e], SU["id"]))
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) "
                   "VALUES (?, 0.9, 'ZZBH own', ?, 0, 0)", (TID["B"], U["B"]))   # B: the person's own result
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) "
                   "VALUES (?, 0.8, 'ZZBH draft', ?, 1, 0)", (TID["D"], U["D"]))   # D: the person's own draft
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) "
                   "VALUES (?, 1.082, NULL, ?, 0, 1)", (TID["C"], SU["id"]))   # C: a fill the manager moderated
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (TID["C"], U["M"]))
        db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, adjusted_value, justification, "
                   "acted_by) VALUES (?,1,'adjust',1.082,1.0,'ZZBH moderator',?)", (TID["C"], U["M"]))
        db.execute("INSERT INTO result_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?, 'pm', ?)",
                   (CID, U["F"], SU["id"]))
        db.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, locked_at, "
                   "locked_by) VALUES (?, 'hod', ?, ?, 'ZZBH hod', datetime('now'), ?)", (CID, str(U["H1"]), BG, SU["id"]))
        db.commit()
    RES0 = {e: result_of(TID[e]) for e in "ABCDEFGH"}
    with a.app.app_context():   # A also has a check-in: a check-in never holds a line for the unit's own fill
        db = a.get_db()
        db.execute("INSERT INTO pm_checkins(kpi_target_id, answer, answered_by, asked_at) VALUES (?, 'on_track', ?, datetime('now'))",
                   (TID["A"], U["A"]))
        db.commit()

    s.section("part 1: a save that changes the unit reaches a line holding only Group People's fill")
    with a.app.app_context():
        db = a.get_db()
        s.check("the rule itself: A, E, F, G, H carry only the unit's fill; B (own result), C (moderated), D (draft), J (none) do not",
                [a._bu_line_unit_fill(db, TID[e]) for e in "AEFGHBCDJ"] == [True] * 5 + [False] * 4)
    out = save(NEW, "ABCDEFGJ")   # H is no longer covered; the unit and the figures change
    SID = setup_row()["id"]
    s.check("the setup now holds the new figures and unit", (setup_row()["threshold"], setup_row()["target"],
                                                            setup_row()["unit"]) == (0.724, 0.905, "RM (mil)"), setup_row())
    s.check("A (a fill, with a check-in) takes the new figures and the new unit, the check-in kept", figs("A") == NEWF
            and n_of("SELECT COUNT(*) FROM pm_checkins WHERE kpi_target_id=?", TID["A"]) == 1, ln("A"))
    s.check("...and its result is untouched: the same figure, now read in the new unit", result_of(TID["A"]) == RES0["A"],
            (result_of(TID["A"]), RES0["A"]))
    s.check("E and G (fills) take them too, results untouched", all(figs(e) == NEWF and result_of(TID[e]) == RES0[e]
                                                                   for e in "EG"), [ln(e) for e in "EG"])
    # (2026-11-14, the late BU KPI amendment) a setup save never reaches a person whose result is released: F stays as it was
    s.check("F (result released) is left as it is by the save: a released result is final", figs("F") == OLDF
            and result_of(TID["F"]) == RES0["F"], ln("F"))
    s.check("J (no result) takes them as it always did", figs("J") == NEWF, ln("J"))
    s.check("B (the person's own result) is still held: earlier figures and unit", figs("B") == OLDF
            and result_of(TID["B"]) == RES0["B"], ln("B"))
    s.check("D (the person's own draft) is still held", figs("D") == OLDF and result_of(TID["D"]) == RES0["D"], ln("D"))
    s.check("C (a fill the manager moderated) is still held, its moderation kept", figs("C") == OLDF and n_of(
        "SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=?", TID["C"]) == 1, ln("C"))
    s.check("H (no longer covered, has a result) stays as it was, held", figs("H") == OLDF and result_of(TID["H"]) == RES0["H"])
    s.check("the page says 3 lines were held because the method or unit differs", "3 lines held because the method or unit differs." in out,
            out[out.find("saved for"):][:400])
    s.check("...and the trail counts them", n_of("SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE "
                                                 "'%ZZBH PAT%set for%3 held: the method or unit differs%'") == 1)

    s.section("the lines left on the earlier figures, as production's three were")
    for e in "EFG":
        reset_line(e)   # what the fix of part 1 would have prevented: fills on the earlier figures, linked and covered
    reset_line("J")
    with a.app.app_context():
        db = a.get_db()
        # Y: covered by the setup (a holder) but its line is not linked to it; I: a line of their own, not a holder
        db.execute("UPDATE pm_kpi_targets SET bu_kpi_id=NULL WHERE id=?", (TID["Y"],))
        db.execute("UPDATE pm_kpi_targets SET unit=?, threshold=?, target=?, multiple=? WHERE id IN (?,?)",
                   (OLD["unit"], OLD["threshold"], OLD["target"], OLD["multiple"], TID["Y"], TID["Y"]))
        data = __import__("json").loads(db.execute("SELECT carriers_json FROM pm_bu_kpis WHERE id=?", (SID,)).fetchone()[0])
        data["people"] = sorted(set(data.get("people") or []) | {"ZZ9BH-Y"})
        db.execute("UPDATE pm_bu_kpis SET carriers_json=? WHERE id=?", (__import__("json").dumps(data), SID))
        db.commit()
    SET0 = setup_row()
    N_LINES0 = n_of("SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name=?", CID, NAME)
    SNAP0 = {e: ln(e) for e in EIDS + ("I", "X")}
    RR0 = {e: H.rows(a, "SELECT updated_at FROM pm_kpi_targets WHERE id=?", (TID[e],))[0][0] for e in "AEFGJ"}
    with a.app.app_context():
        db = a.get_db()
        held = a._bu_kpi_held_lines(db, a.active_cycle(db), db.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (SID,)).fetchone(),
                                    a._bu_unit_people(db, BG, CO))
        who_held = sorted(p["employee_id"][-1] for p, _t in held)
    s.check("the list of lines on earlier figures is exactly the linked, covered, differing ones: B, C, D, E, F, G, J "
            "(not A who matches, not H uncovered, not Y unlinked, not I or X)", who_held == list("BCDEFGJ"), who_held)

    s.section("the page: a chip on each row, the count, the button for the super admin only")
    put_window(stamp(-1))   # the Department Review started: BU KPI setup now reads only
    open_, note = state_now()
    s.check("BU KPI setup reads only", open_ is False and note.startswith("The Department Review started"), (open_, note))
    pg = SUP.get(URL + "&kpi=%d" % LIB).get_data(as_text=True)
    s.check("the super admin sees 7 rows with the Earlier figures chip", pg.count(">Earlier figures<") == 7, pg.count(">Earlier figures<"))
    s.check("...the note says 7 still hold the earlier figures", "7 still hold the earlier figures" in pg)
    s.check("...and the button, with the remark asked", "Bring them onto this setup" in pg and 'value="bring_held"' in pg
            and "data-confirm-reason-field=\"remark\"" in pg)
    s.check("...the confirm names the unit, the KPI and how many", "Bring 7 people onto the saved ZZBH PAT setup for" in pg.replace("&#39;", "'"))
    pb = BA.get(URL + "&kpi=%d" % LIB).get_data(as_text=True)
    s.check("a group admin sees the chips and the count but no button", pb.count(">Earlier figures<") == 7
            and "7 still hold the earlier figures" in pb and "Bring them onto this setup" not in pb and 'value="bring_held"' not in pb)
    s.check("a save is refused while it reads only (so Bring them is a way round no setup change)", "Nothing was saved" in save(
        NEW, "ABCDEFGJ") and figs("G") == OLDF)

    s.section("Bring them onto this setup: who may, and what is refused")
    r = bring(client=BA, follow=False)
    s.check("a group admin posting it gets 403, nothing changes", r.status_code == 403 and figs("G") == OLDF, r.status_code)
    r = bring(remark=None, follow=False)
    s.check("the super admin without a remark is refused (a flash, back), nothing changes", r.status_code in (302, 303)
            and figs("G") == OLDF and figs("J") == OLDF and not audit_lines(), r.status_code)
    out0 = bring(remark="  ")
    s.check("a blank remark too", "Write your remark first" in out0 and figs("G") == OLDF)

    s.section("with a remark: only the linked, covered, differing lines, and not a released or calibrated person")
    out = bring()
    s.check("G and J (no result) take the saved figures and unit", figs("G") == NEWF and figs("J") == NEWF, (ln("G"), ln("J")))
    s.check("...G's Group People figure is untouched", result_of(TID["G"]) == RES0["G"])
    s.check("E (calibrated: a locked HOD session) is left as it is", figs("E") == OLDF and result_of(TID["E"]) == RES0["E"], ln("E"))
    s.check("F (result released) is left as it is", figs("F") == OLDF and result_of(TID["F"]) == RES0["F"], ln("F"))
    s.check("B, C, D (the person's own result, a moderated fill, a draft) stay held, nothing forced", all(
        figs(e) == OLDF for e in "BCD") and n_of("SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=?", TID["C"]) == 1)
    s.check("H (not covered) and Y (covered, line not linked) are not touched", ln("H") == SNAP0["H"] and ln("Y") == SNAP0["Y"],
            (ln("H"), ln("Y")))
    s.check("A (already on the setup), I (own line) and X (nobody) are not touched; no line was added or taken off",
            ln("A") == SNAP0["A"] and ln("I") == SNAP0["I"] and ln("X") is None and n_of(
                "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name=?", CID, NAME) == N_LINES0)
    s.check("the setup itself is unchanged", setup_row() == SET0)
    s.check("the page says what happened: 2 of 7, 1 released, 1 calibrated, 3 held on their own result", (
        "2 of 7 lines now on the saved figures" in out and "1 left as they are: their result is released." in out
        and "1 calibrated, left as is." in out and "3 held because their own result is in another unit or method." in out),
            out[out.find("ZZBH PAT for"):][:500])
    al = audit_lines()
    s.check("the audit line holds the counts and the super admin's remark", len(al) == 1 and "2 of 7 updated" in al[0]
            and "1 left: result released" in al[0] and "1 left: calibrated" in al[0] and "remark: " + REMARK in al[0], al)
    s.check("the same row says what held 3: the method or unit differs", "3 held: the method or unit differs" in al[0])
    s.check("a second Bring changes nothing more (G and J now match): 0 of 5", "0 of 5 lines now on the saved figures" in bring()
            and figs("G") == NEWF and figs("E") == OLDF)

    s.section("Fill BU result and the score now read the new target")
    with a.app.app_context():
        db = a.get_db()
        me = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        period = a.active_pm_period(db)
        tg = {t["subject_id"]: t for t in a._bu_fill_targets(db, me, period, BG, CO, NAME)}
        cfg = db.execute("SELECT * FROM pm_bg_config WHERE business_group=?", (BG,)).fetchone()
        srow = db.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (SID,)).fetchone()
        sc_new = a._bu_fill_score(cfg, tg[U["G"]], 1.082)
        sc_old = a._bu_fill_score(cfg, tg[U["E"]], 1.082)
        sc_exp = a._bu_fill_score(cfg, dict(srow), 1.082)
    s.check("the Fill BU selection reads G at the new target and unit", (tg[U["G"]]["target"], tg[U["G"]]["unit"]) == (0.905, "RM (mil)"),
            (tg[U["G"]]["target"], tg[U["G"]]["unit"]))
    s.check("...and its score for 1.082 is the setup's own, not the old target's (E, still held, scores differently)",
            sc_new == sc_exp and sc_new != sc_old and sc_old is not None, (sc_new, sc_exp, sc_old))
    pg = SUP.get(URL + "&kpi=%d" % LIB).get_data(as_text=True)
    s.check("the page now counts 5 still on the earlier figures", pg.count(">Earlier figures<") == 5 and "5 still hold the earlier figures" in pg)

    s.section("falsified: each guard changes the outcome when switched off")
    # 1. the fill rule: with it off a save holds a fill line again (production's bug)
    reset_line("A")
    _f = a._bu_line_unit_fill
    a._bu_line_unit_fill = lambda db, tid: False
    try:
        with a.app.app_context():
            db = a.get_db()
            me_ = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
            act_ = a.active_cycle(db)
            srow_ = db.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (SID,)).fetchone()
            o1 = a._bu_kpi_apply(db, me_, act_, srow_, a._bu_unit_people(db, BG, CO), only=U["A"], locked_ok=True)
            db.commit()
    finally:
        a._bu_line_unit_fill = _f
    s.check("fill rule off: A (a fill) is held for 'the unit differs' again", o1["differs"] == 1 and o1["updated"] == 0
            and figs("A") == OLDF, (o1, ln("A")))
    a._bu_line_unit_fill = lambda db, tid: True
    try:
        with a.app.app_context():
            db = a.get_db()
            o2 = a._bu_kpi_apply(db, me_, act_, srow_, a._bu_unit_people(db, BG, CO), only=U["B"], locked_ok=True)
            db.commit()
    finally:
        a._bu_line_unit_fill = _f
    s.check("fill rule always on: B (the person's own result) would be moved to a new unit, so the rule is what holds it",
            o2["differs"] == 0 and o2["updated"] == 1 and figs("B") == NEWF, (o2, ln("B")))
    reset_line("B")
    with a.app.app_context():
        db = a.get_db()
        o3 = a._bu_kpi_apply(db, me_, act_, srow_, a._bu_unit_people(db, BG, CO), only=U["A"], locked_ok=True)
        db.commit()
    s.check("(put back) the real rule brings A onto the setup", o3["updated"] == 1 and figs("A") == NEWF, (o3, ln("A")))
    # 2. the calibration skip
    _h = a._pm_calibration_hold
    a._pm_calibration_hold = lambda db, cid, subj: {}
    try:
        bring()
    finally:
        a._pm_calibration_hold = _h
    s.check("calibration hold off: E is brought (so the hold is what left them as they were)", figs("E") == NEWF, ln("E"))
    reset_line("E")
    # 3. the released skip
    # (_pm_calibration_hold also holds a released person, Fill BU's own rule, so each is a second line for the other: with the
    # release skip alone off F is still left but worded as calibrated; only both off brings F)
    _r = a.setup_released_many
    a.setup_released_many = lambda db, ids, cid, kind: {i: None for i in ids}
    try:
        out_r = bring()
    finally:
        a.setup_released_many = _r
    s.check("released skip off alone: F is still left (Fill BU's hold covers a release) but counted as calibrated",
            figs("F") == OLDF and "2 calibrated, left as is." in out_r and "their result is released" not in out_r, ln("F"))
    a.setup_released_many = lambda db, ids, cid, kind: {i: None for i in ids}
    a._pm_calibration_hold = lambda db, cid, subj: {}
    try:
        bring()
    finally:
        a.setup_released_many = _r
        a._pm_calibration_hold = _h
    s.check("released skip and calibration hold both off: F is brought (so the release is what left them as they were)",
            figs("F") == NEWF, ln("F"))
    reset_line("F")
    reset_line("E")
    # 4. the covered filter (H: linked, not covered)
    _c = a._bu_kpi_covers
    a._bu_kpi_covers = lambda sr, p: True
    try:
        bring()
    finally:
        a._bu_kpi_covers = _c
    s.check("covered filter off: H (no longer covered) would be pushed onto the setup, Y still is not (line not linked)",
            figs("H") == NEWF and ln("Y") == SNAP0["Y"], (ln("H"), ln("Y")))
    reset_line("H")
    # 5. the read-only allowance: with BU KPI setup open, bring still works
    put_window(stamp(1))
    reset_line("G")
    s.check("open, the same Bring works", "1 of" in bring() and figs("G") == NEWF)
    s.check("...and none of this added a line", n_of("SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name=?",
                                                     CID, NAME) == N_LINES0)
finally:
    _put_back()
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
