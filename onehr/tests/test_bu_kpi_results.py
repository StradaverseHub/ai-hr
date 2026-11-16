"""BU KPI setup keeps open until the HOD Department Review starts, and a save reaches lines with results (Chris, 2026-11-03:
"keep it open until the HOD Department Review starts, and a change updates every line in the unit, including lines that
already have results"; before it, 2026-10-23, it closed when the results check-in started and held every line someone had
acted on).

What this suite holds (a Year-End; the window that matters is pm_hod's):
  * the cut-off: open the day before the Department Review starts, read only the day it has started, a save refused then
    with nothing changed; the results check-in no longer matters
  * a line with a result takes the unit's new target; the person's result figure, note and submission are untouched; a line
    a moderator had signed off goes back to its moderators (approvals cleared, each step kept as the moderator's own
    starting point), is told in the person's conversation and the moderator's, and its score is worked out again from the
    new target; the rating record is rebuilt (no manager figure until it is moderated again)
  * a line HR filled (no moderation) takes the target too and stays final; its score follows the new target
  * a line whose method or unit would change stays as it is, its moderation too (held, said why)
  * a person no longer covered keeps a line with results (held); taking the KPI off holds it too, and deletes no result
  * every other writer (a person added, a unit moved: _bu_kpi_apply without locked_ok) still holds an acted-on line
  * falsified: the method / unit guard, the apply guard and the cut-off each change the outcome when switched off
"""
import atexit
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("BU KPI setup: open until the Department Review, a save reaches lines with results")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO = "ZZBR Group", "ZZBR Unit"
U = {}
EIDS = ("A", "B", "C", "D", "E", "F", "G")


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BR-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        tl = [r[0] for r in db.execute("SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)]
        if tl:
            pt = ",".join("?" * len(tl))
            for tb in ("pm_kpi_approvals", "pm_kpi_results", "pm_kpi_moderation_drafts", "pm_kpi_target_approvers",
                       "pm_checkins"):
                db.execute("DELETE FROM %s WHERE kpi_target_id IN (%s)" % (tb, pt), tl)
        db.execute("DELETE FROM pm_review_chat WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_manager_chat WHERE reviewer_id IN (%s) OR report_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%ZZBR%'")
    db.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def ln(eid, name="ZZBR PAT"):
    r = H.rows(a, "SELECT t.id, t.rate1, t.rate5, t.weightage, t.method, t.unit, t.bu_kpi_id FROM pm_kpi_targets t "
                  "JOIN users u ON u.id=t.subject_id WHERE t.cycle_id=? AND u.employee_id=? AND t.kpi_name=?",
               (CID, "ZZ9BR-" + eid, name))
    return tuple(r[0]) if r else None


def n_of(sql, *args):
    return H.one(a, sql, args)


def result_of(tid):
    r = H.rows(a, "SELECT actual_value, note, draft, admin_filled, submitted_at FROM pm_kpi_results WHERE kpi_target_id=?",
               (tid,))
    return tuple(r[0]) if r else None


def line_state(eid):
    """The line as the page's own readers see it: (score value, locked, effective value)."""
    with a.app.app_context():
        db = a.get_db()
        t = db.execute("SELECT t.*, u.business_group FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id WHERE "
                       "t.cycle_id=? AND u.employee_id=? AND t.kpi_name='ZZBR PAT'", (CID, "ZZ9BR-" + eid)).fetchone()
        t = dict(t)
        a.attach_pm_chains(db, [t])
        a.pm_score_targets(db, [t])
        return (t["score"]["value"] if t["score"] else None), t["locked"], t["effective_value"]


def put_window(opens):
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', ?, NULL)",
                   (CID, opens))
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
    R0 = db.execute("SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell='pm_results'",
                    (CID,)).fetchone()

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
    # the results check-in started long ago: it no longer closes BU KPI setup
    db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_results', "
               "'2020-01-01 00:00', NULL)", (CID,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    LIB = db.execute(
        "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, "
        "method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', 'ZZBR PAT', "
        "'Financial', '%', 'more', 90, 95, 100, 105, 110, 20, 1)", (BG,)).lastrowid
    U["M"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                        "department, job_grade, confirmation_date) VALUES ('zz9br-m', 'ZZ BR Manager', 'x', 'user', "
                        "'ZZ9BR-M', ?, ?, 'Management', '21', '2020-01-01')", (BG, CO)).lastrowid
    for e in EIDS:
        U[e] = db.execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', 'user', ?,?,?, 'Sales', '14', "
            "'2020-01-01', ?)", ("zz9br-" + e.lower(), "ZZ BR " + e, "ZZ9BR-" + e, BG, CO, U["M"])).lastrowid
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, "
                   "rate2, rate3, rate4, rate5, business_group, company, library_id) VALUES (?,?, 'ZZBR PAT', 30, 'more', "
                   "'%', 'Financial', 90, 95, 100, 105, 110, ?,?,?)", (CID, U[e], BG, CO, LIB))
    db.commit()
SUP = H.client_as(a, SU["id"])
URL = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
K = "k%d_" % LIB


def card(rates, who):
    f = {K + "rate%d" % i: str(v) for i, v in enumerate(rates, 1)}
    f.update({K + "carriers": "holders", K + "wmode": "own", K + "holder_set": "1", K + "unit": "%"})
    f[K + "holder"] = ["ZZ9BR-" + e for e in who]
    return f


def save(rates, who):
    form = {"csrf_token": "tok", "action": "save_kpi", "kpi": str(LIB)}
    form.update(card(rates, who))
    return SUP.post(URL, data=form, follow_redirects=True).get_data(as_text=True)


def state_now():
    with a.app.app_context():
        db = a.get_db()
        return a._bu_kpi_state(db, a.active_cycle(db))


try:
    s.section("the cut-off: the HOD Department Review, not the results check-in")
    put_window(stamp(1))   # the Department Review starts tomorrow (MYT)
    open_, note = state_now()
    s.check("the day before the Department Review starts it is open, saying when (the results check-in began in 2020)",
            open_ is True and note.startswith("Open until the Department Review starts on "), (open_, note))
    pg = SUP.get(URL).get_data(as_text=True)
    s.check("...and the page says so, with the save form", "Open until the Department Review starts on" in pg)
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'", (CID,))
        d_.commit()
    open_, note = state_now()
    s.check("with no start date on an older cycle (parts open all cycle) it reads only",
            open_ is False and note == "The Department Review is open, so BU KPIs read only.", (open_, note))
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE cycles SET open_by_date=1 WHERE id=?", (CID,))
        d_.commit()
    open_, note = state_now()
    s.check("with no start date on a cycle whose parts open by date it is open, saying the date isn't set",
            (open_, note) == (True, "Open until the Department Review starts. Its start date isn't set yet."), (open_, note))
    put_window(stamp(-1))   # started yesterday
    open_, note = state_now()
    s.check("once the Department Review has started it reads only, saying since when",
            open_ is False and note.startswith("The Department Review started on "), (open_, note))
    n0 = n_of("SELECT COUNT(*) FROM pm_bu_kpis WHERE business_group=?", BG)
    out = save((80, 85, 90, 95, 100), EIDS)
    s.check("...a save is refused and nothing changes", "Nothing was saved" in out and n_of(
        "SELECT COUNT(*) FROM pm_bu_kpis WHERE business_group=?", BG) == n0 == 0 and ln("A")[1:3] == (90, 110)
        and ln("A")[6] is None, (n0, ln("A")))
    put_window(stamp(1))
    s.check("the day before it starts, the same save goes through (the guard is the window)", "Nothing was saved" not in
            save((90, 95, 100, 105, 110), EIDS) and ln("A")[6] is not None)
    s.check("...every carrier's line is adopted at the unit's target, at its own weight",
            all(ln(e)[1:4] == (90, 110, 30) and ln(e)[6] == ln("A")[6] for e in EIDS), [ln(e) for e in EIDS])

    s.section("lines with results: set up")
    TID = {e: ln(e)[0] for e in EIDS}
    with a.app.app_context():
        db = a.get_db()
        # B: the person's own result, moderated by the line manager (one chain step)
        # D: the same, but its method differs from the unit's (less / more)
        # E: the same, but its unit differs (RM / %)
        # F: moderated, and about to be left out of the setup
        for e in "BDEF":
            db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) "
                       "VALUES (?, 97, 'ZZBR own note', ?, 0, 0)", (TID[e], U[e]))
            db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)",
                       (TID[e], U["M"]))
            db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, adjusted_value, "
                       "justification, acted_by) VALUES (?,1,'adjust',97,96,'ZZBR moderator note',?)", (TID[e], U["M"]))
        # G: the person's own result, submitted, not yet moderated (nothing to lift)
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) "
                   "VALUES (?, 97, 'ZZBR own note', ?, 0, 0)", (TID["G"], U["G"]))
        # C: HR filled it: final, no moderation
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) "
                   "VALUES (?, 97, NULL, ?, 0, 1)", (TID["C"], SU["id"]))
        db.execute("UPDATE pm_kpi_targets SET method='less' WHERE id=?", (TID["D"],))
        db.execute("UPDATE pm_kpi_targets SET unit='RM' WHERE id=?", (TID["E"],))
        db.commit()
    BEFORE = {"B": line_state("B"), "C": line_state("C")}
    res_before = {e: result_of(TID[e]) for e in "BCDEFG"}
    with a.app.app_context():   # the rating record as it stands with B's line moderated and locked
        db = a.get_db()
        a._rating_record_refresh(db, CID, [U["B"], U["C"]], "zzbr_prime", SU["id"], commit=True)
    s.check("before: B's line is locked by its moderator, C's by HR; both score off the old target",
            BEFORE["B"][1] is True and BEFORE["C"][1] is True and BEFORE["B"][2] == 96 and BEFORE["C"][2] == 97, BEFORE)
    s.check("...B's rating record carries the manager's figure", n_of(
        "SELECT pm_mgr_value FROM rating_records WHERE cycle_id=? AND subject_id=?", CID, U["B"]) is not None)
    mail0 = n_of("SELECT COUNT(*) FROM email_outbox") + n_of("SELECT COUNT(*) FROM notifications")

    s.section("a save with the new target: every line in the unit takes it, results or not")
    out = save((80, 85, 90, 95, 100), "ABCDEG")   # F is no longer covered
    NEW = (80, 100)
    s.check("an untouched line (A: no result) takes the target, as before", ln("A")[1:3] == NEW, ln("A"))
    s.check("a line with a result (B) takes it too", ln("B")[1:3] == NEW, ln("B"))
    s.check("a line HR filled (C) takes it too", ln("C")[1:3] == NEW, ln("C"))
    s.check("a submitted line nobody has moderated yet (G) takes it too, its result untouched", ln("G")[1:3] == NEW
            and result_of(TID["G"]) == res_before["G"] and n_of(
                "SELECT COUNT(*) FROM pm_kpi_moderation_drafts WHERE kpi_target_id=?", TID["G"]) == 0, ln("G"))
    s.check("B's result figure, note and submission are untouched", result_of(TID["B"]) == res_before["B"],
            (result_of(TID["B"]), res_before["B"]))
    s.check("C's result is untouched, and still HR's", result_of(TID["C"]) == res_before["C"]
            and result_of(TID["C"])[3] == 1)
    s.check("B's moderation is cleared: its line is back with the moderator", n_of(
        "SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=?", TID["B"]) == 0)
    d = H.rows(a, "SELECT approver_id, adjusted_value, justification FROM pm_kpi_moderation_drafts WHERE kpi_target_id=?",
               (TID["B"],))
    s.check("...what the moderator wrote is kept as their starting point, not lost", len(d) == 1
            and tuple(d[0]) == (U["M"], 96, "ZZBR moderator note"), d)
    s.check("...nothing was cleared on a line nobody had moderated (C: HR's, A: none)", n_of(
        "SELECT COUNT(*) FROM pm_kpi_moderation_drafts WHERE kpi_target_id IN (?,?)", TID["A"], TID["C"]) == 0)
    sb, sc = line_state("B"), line_state("C")
    s.check("B's score is worked out again from the new target, off the person's own figure until re-moderated",
            sb[1] is False and sb[2] == 97 and sb[0] != BEFORE["B"][0], (BEFORE["B"], sb))
    s.check("C's score follows the new target and the line is still final (HR's)", sc[1] is True and sc[2] == 97
            and sc[0] != BEFORE["C"][0], (BEFORE["C"], sc))
    rr = H.rows(a, "SELECT pm_mgr_value, last_event FROM rating_records WHERE cycle_id=? AND subject_id=?", (CID, U["B"]))
    s.check("B's rating record is rebuilt: no manager figure until the line is moderated again", rr and rr[0][0] is None
            and rr[0][1] == "bu_kpi_retarget", rr)
    rc = H.rows(a, "SELECT last_event FROM rating_records WHERE cycle_id=? AND subject_id=?", (CID, U["C"]))
    s.check("...and C's (a line with a result and no moderation) is rebuilt too", rc and rc[0][0] == "bu_kpi_retarget", rc)
    ra = n_of("SELECT COUNT(*) FROM rating_records WHERE cycle_id=? AND subject_id=? AND last_event='bu_kpi_retarget'",
              CID, U["A"])
    s.check("...none for A, whose line had no result", ra == 0, ra)

    s.section("a line whose method or unit would change stays as it is")
    s.check("D (method differs) is held: same target, same moderation", ln("D")[1:3] == (90, 110) and ln("D")[4] == "less"
            and n_of("SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=?", TID["D"]) == 1
            and result_of(TID["D"]) == res_before["D"], ln("D"))
    s.check("E (unit differs) is held the same way", ln("E")[1:3] == (90, 110) and ln("E")[5] == "RM"
            and n_of("SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=?", TID["E"]) == 1)
    s.check("F (no longer covered, moderated) is held as it was, result and all", ln("F")[1:3] == (90, 110)
            and n_of("SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=?", TID["F"]) == 1
            and result_of(TID["F"]) == res_before["F"])

    s.section("what the admin is told")
    s.check("lines updated, of which with results and back to moderation", "4 updated" in out and
            "Of the updated lines, 3 had results and took the new target; 1 went back to its moderator: the results "
            "themselves are untouched." in out, out[out.find("saved for"):][:400])
    s.check("...the ones held because the method or unit differs", "2 lines held because the method or unit differs." in out)
    s.check("...the one held because someone acted on it (no longer covered)",
            "1 line left as they were: someone has acted on them." in out)
    s.check("...the save asks first, saying lines with results go back to their moderators", (
        "Lines with results take it too: any a moderator had signed off go back to their moderators" in SUP.get(
            URL + "&kpi=%d&edit=1" % LIB).get_data(as_text=True).replace("&#39;", "'")))
    s.check("...and the trail says it", n_of(
        "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_kpi' AND detail LIKE '%3 with results took the target, 1 "
        "went back to their moderators, 2 held: the method or unit differs, 1 held: someone acted on them%'") == 1)

    s.section("who is told: in the app only, never by email")
    def notes(e):
        return H.rows(a, "SELECT content, stage FROM pm_review_chat WHERE subject_id=? AND role='agent'", (U[e],))
    pn, pc, pg_ = notes("B"), notes("C"), notes("G")
    s.check("B (moderation lifted) is told in their own conversation: the target moved, the result did not, and the "
            "line is being moderated again", len(pn) == 1 and "ZZBR PAT" in pn[0][0]
            and "changed in your unit's BU KPI setup" in pn[0][0] and "stay as you entered them" in pn[0][0]
            and "being moderated again" in pn[0][0], pn)
    s.check("C (HR-filled, no moderation) is told once too, without 'moderated again'", len(pc) == 1
            and "changed in your unit's BU KPI setup" in pc[0][0] and "stay as you entered them" in pc[0][0]
            and "moderated" not in pc[0][0], pc)
    s.check("G (submitted, not yet moderated) is told once, without 'moderated again'", len(pg_) == 1
            and "changed in your unit's BU KPI setup" in pg_[0][0] and "moderated" not in pg_[0][0], pg_)
    mn = H.rows(a, "SELECT content, stage FROM pm_manager_chat WHERE reviewer_id=? AND report_id=? AND role='agent'",
                (U["M"], U["B"]))
    s.check("the moderator is told in theirs, with the person named", len(mn) == 1 and "ZZ BR B" in mn[0][0]
            and "back with you to moderate again" in mn[0][0], mn)
    s.check("...no moderator is told of C or G (nothing was lifted)", n_of(
        "SELECT COUNT(*) FROM pm_manager_chat WHERE report_id IN (?,?)", U["C"], U["G"]) == 0)
    s.check("...nobody is told of A (no result) or of D, E, F (held, unchanged)", n_of(
        "SELECT COUNT(*) FROM pm_review_chat WHERE subject_id IN (?,?,?,?) AND role='agent'", U["A"], U["D"], U["E"],
        U["F"]) == 0 and n_of("SELECT COUNT(*) FROM pm_manager_chat WHERE report_id IN (?,?,?,?)", U["A"], U["D"],
                              U["E"], U["F"]) == 0)
    s.check("...the words never say reopen", "reopen" not in (pn[0][0] + pc[0][0] + pg_[0][0] + mn[0][0]).lower())
    s.check("...and no email was queued or logged", n_of("SELECT COUNT(*) FROM email_outbox") + n_of(
        "SELECT COUNT(*) FROM notifications") == mail0)

    s.section("a save again changes nothing more; a person's submission stays submitted")
    save((80, 85, 90, 95, 100), "ABCDEG")
    s.check("the same save twice: nobody is told again (B, C, G one note each), the moderator once", all(
        len(notes(e)) == 1 for e in "BCG") and n_of(
        "SELECT COUNT(*) FROM pm_manager_chat WHERE reviewer_id=?", U["M"]) == 1)
    s.check("B's result is still submitted (draft 0), never reopened for them", result_of(TID["B"])[2] == 0)

    s.section("every other writer still holds a line someone acted on (falsifying locked_ok)")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE pm_bu_kpis SET rate1=70, rate2=75, rate3=80, rate4=85, rate5=90 WHERE business_group=? AND "
                   "company=?", (BG, CO))
        db.commit()
        srow = db.execute("SELECT * FROM pm_bu_kpis WHERE business_group=? AND company=?", (BG, CO)).fetchone()
        people = a._bu_unit_people(db, BG, CO)
        db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) VALUES (?,1,"
                   "'confirm',97,?)", (TID["B"], U["M"]))
        db.commit()
        me = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        act = a.active_cycle(db)
        o1 = a._bu_kpi_apply(db, me, act, srow, people, only=U["B"])   # a person added, a unit moved: locked_ok is off
        db.commit()
    s.check("without locked_ok B's moderated line is held, not retargeted and not sent back", o1["held"] == 1
            and o1["updated"] == 0 and o1["differs"] == 0 and ln("B")[1:3] == NEW and n_of(
                "SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=?", TID["B"]) == 1, (o1, ln("B")))
    with a.app.app_context():
        db = a.get_db()
        o2 = a._bu_kpi_apply(db, me, act, srow, people, only=U["B"], locked_ok=True)
        db.commit()
    s.check("with locked_ok the same call changes it and sends it back (so that guard is what held it)",
            o2["updated"] == 1 and o2["with_results"] == 1 and o2["remoderated"] == 1 and ln("B")[1:3] == (70, 90)
            and n_of("SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=?", TID["B"]) == 0, (o2, ln("B")))

    s.section("falsified: the method / unit guard is what held D and E")
    _m = a._bu_meaning
    a._bu_meaning = lambda method, unit: ("", "")
    try:
        with a.app.app_context():
            db = a.get_db()
            o3 = a._bu_kpi_apply(db, me, act, srow, people, locked_ok=True)
            db.commit()
    finally:
        a._bu_meaning = _m
    s.check("switched off, D and E are retargeted (and their method and unit changed): the guard is what held them",
            o3["differs"] == 0 and ln("D")[1:3] == (70, 90) and ln("D")[4] == "more" and ln("E")[5] == "%", (o3, ln("D"),
                                                                                                           ln("E")))

    s.section("taking the KPI off holds a line with results; no result is deleted")
    with a.app.app_context():
        db = a.get_db()
        a._put = db.execute("SELECT COUNT(*) FROM pm_kpi_results WHERE kpi_target_id IN (%s)" % ",".join(
            str(TID[e]) for e in EIDS)).fetchone()[0]
    sid = n_of("SELECT id FROM pm_bu_kpis WHERE business_group=? AND company=?", BG, CO)
    r = SUP.post(URL, data={"csrf_token": "tok", "action": "take_off", "setup": str(sid)}, follow_redirects=True)
    t_off = r.get_data(as_text=True)
    s.check("an untouched line (A) is given back as it was", ln("A")[1:3] == (90, 110) and ln("A")[6] is None, ln("A"))
    s.check("...lines with results stay as they are, linked: held (B, C, D, E, F, G)",
            all(ln(e)[6] == sid for e in "BCDEFG"), [ln(e) for e in "BCDEFG"])
    s.check("...the KPI stays saved, and every result is still there", n_of(
        "SELECT COUNT(*) FROM pm_bu_kpis WHERE id=?", sid) == 1 and n_of(
        "SELECT COUNT(*) FROM pm_kpi_results WHERE kpi_target_id IN (%s)" % ",".join(str(TID[e]) for e in EIDS)) == a._put)
    s.check("...and the page says so", "left as they were: someone has acted on them" in t_off, t_off[:0])

    s.section("falsified: past the Department Review the same save changes nothing")
    put_window(stamp(-1))
    before = [ln(e) for e in EIDS]
    out = save((60, 65, 70, 75, 80), "ABCDEFG")
    s.check("a save is refused, so no line moves", "Nothing was saved" in out and [ln(e) for e in EIDS] == before)
    put_window(stamp(1))
    save((60, 65, 70, 75, 80), "ABCDEFG")
    s.check("(the window put back one day before) the same save moves lines again", ln("A")[1:3] == (60, 80),
            ln("A"))
finally:
    _put_back()
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
