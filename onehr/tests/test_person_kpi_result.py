"""The person page's Performance tab: the Rating column, one Moderation column, the Final result row and the Moderation panel
(Chris, 2026-11-03).

What this suite holds:
  * the Rating column: before a moderator acts it is THEIR figure's rating, labelled "their figure"; after, the moderated
    figure's rating with the band pill (the pill left the Result cell); a line whose moderated figure differs says "Adjusted"
  * the Final result row never prints a partial total: until every line is locked it says "Worked out once all N are
    moderated" and carries no number and no band pill (falsified: the provisional total WOULD be a number); once every line
    is locked its number and band are pm_overall_for_targets's, formatted, and calibration is "not yet" or the tier's band
  * a person whose lines sit on two scales is "Held", no number; a person with no lines has no Final row
  * the flow strip's Moderation step is a link to the panel only once a line is moderated
  * the Moderation panel: "Adjusted" with the moderator's reason and "Confirmed", their figures' total and the official one
  * a threshold -> target group's column is "Achievement" and its figures are percentages
"""
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The Performance tab: Rating, Moderation, the Final result row and the Moderation panel")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, BGB, CO, DEPT = "ZZPR Group", "ZZPR Percent Group", "ZZPR Unit", "ZZPR Dept"
REASON = "ZZPR reason: the plant shut for a week & the figure was re-stated"
_real_final_result = a.final_result


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9PR-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM pm_kpi_approvals WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id "
                   "IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id "
                   "IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE "
                   "subject_id IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?)", (BG, BGB))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BGB))
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    for bg in (BG, BGB):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (bg, CO))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'base')", (BGB,))

    def mk(eid, name, bg, mgr=None):
        return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                          "company, department, job_title, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', "
                          "'user', ?,?,?,?, 'ZZ Analyst', '14', '2020-01-01', ?)",
                          (eid.lower(), name, eid, bg, CO, DEPT, mgr)).lastrowid
    M = mk("ZZ9PR-M", "ZZ PR Manager", BG)
    P = mk("ZZ9PR-P", "ZZ PR Person", BG, M)        # two lines on the 1-5 ladder
    N = mk("ZZ9PR-N", "ZZ PR Nolines", BG, M)       # no lines at all
    PB = mk("ZZ9PR-B", "ZZ PR Percent", BGB, M)     # one threshold -> target line
    db.commit()
SUP = H.client_as(a, SU["id"])


def line(db, uid, bg, name, weight, actual, *, a_ladder=True, chain=()):
    """A KPI line on the 1-5 ladder (10..50) or threshold 100 -> target 200, with the figure they submitted."""
    tid = db.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, category, weightage, unit, method, rate1, rate2, rate3, "
        "rate4, rate5, threshold, target, multiple, business_group, company, department, status) VALUES (?,?,?, 'ZZPR · Family', "
        "?, 'RM', 'more', ?,?,?,?,?, ?,?,?, ?,?,?, 'approved')",
        (CID, uid, name, weight, *((10, 20, 30, 40, 50, None, None, None) if a_ladder else (None,) * 5 + (100, 200, 100)),
         bg, CO, DEPT)).lastrowid
    for i, ap in enumerate(chain, start=1):
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,?,?)", (tid, i, ap))
    if actual is not None:
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)",
                   (tid, actual, uid))
    return tid


def moderate(tid, action, original, adjusted=None, reason=None, seq=1):
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, adjusted_value, justification, "
                   "acted_by) VALUES (?,?,?,?,?,?,?)", (tid, seq, action, original, adjusted, reason, M))
        db.commit()


def page(uid=P, extra=""):
    r = SUP.get("/admin/users/%d?tab=performance%s" % (uid, extra))
    return r.status_code, html.unescape(r.get_data(as_text=True))


def final_row(b):
    m = re.search(r'<div class="pp-krow pp-ktotal" id="kpi-final">(.*?)\n  </div>', b, re.S)
    return m.group(1) if m else ""


def panel(b):
    m = re.search(r'<aside class="adm-panel[^"]*" id="pnl-kpi-mod".*?</aside>', b, re.S)
    return m.group(0) if m else ""


def row(b, tid):
    m = re.search(r'<div class="pp-krow" id="kpi-%d">(.*?)</div>' % tid, b, re.S)
    return m.group(1) if m else ""


def detail(uid=P):
    with a.app.app_context():
        db = a.get_db()
        p = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        ts = [dict(t) for t in db.execute("SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? ORDER BY id",
                                          (CID, uid))]
        a.attach_pm_chains(db, ts)
        a.pm_score_targets(db, ts)
        return (a.pm_overall_for_targets(db, ts, require_locked=True), a.pm_overall_for_targets(db, ts, require_locked=False),
                [t["score"] for t in ts])


try:
    with a.app.app_context():
        db = a.get_db()
        T1 = line(db, P, BG, "ZZPR Sales", 60, 25, chain=(M,))     # rating 2 on their own figure
        T2 = line(db, P, BG, "ZZPR Margin", 40, 45, chain=(M,))    # rating 4
        db.commit()

    # -----------------------------------------------------------------------------------------------------------------
    s.section("before anyone moderates: their own rating, and no total")
    code, b = page()
    r1, r2 = row(b, T1), row(b, T2)
    s.check("the page renders and the table's eight headings include Rating and Moderation, not Moderated by / Status",
            code == 200 and ">Rating</span>" in b and ">Moderation</span>" in b and ">Moderated by</span>" not in b
            and ">Status</span>" not in b)
    s.check("the Rating cell is their own rating, muted, labelled 'their figure' (a Rate 1-5 ladder: 2 and 4)",
            'class="pp-rate-self">2</span>' in r1 and 'class="pp-rate-self">4</span>' in r2 and r1.count("their figure") == 1
            and "potential-pill" not in r1 and "potential-pill" not in r2)
    s.check("the Moderation cell carries who moderates and the status word together",
            'class="pp-modc"' in r1 and "LM" in r1 and "ZZ PR Manager" in r1 and "With the line manager" in r1)
    fr = final_row(b)
    s.check("a Final result row is there, with the weight total", "Final result" in fr and "Total KPI score, weighted" in fr
            and ">100%<" in fr)
    s.check("it says 'Worked out once all 2 are moderated · 0 of 2 done' and prints NO number and NO band",
            "Worked out once all 2 are moderated · 0 of 2 done" in fr and "pp-total" not in fr and "potential-pill" not in fr
            and not re.search(r"\d\.\d\d", fr), fr)
    s.check("the Moderation step is a plain span (nothing is moderated), and there is no Moderation panel",
            "pp-step-link" not in b and "panel=kpi-mod" not in b and 'id="pnl-kpi-mod"' not in b)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("one line moderated: still no total")
    moderate(T1, "adjust", 25, 35, REASON)
    code, b = page()
    r1, r2, fr = row(b, T1), row(b, T2), final_row(b)
    s.check("the moderated line's Rating is bold with its band pill (the pill left the Result cell), and says Adjusted",
            re.search(r"pp-rate\"><b>3</b> <span class=\"potential-pill\" data-band=\"\w+\">", r1)
            and r1.count("potential-pill") == 1 and "pp-adj\">Adjusted<" in r1 and "<b>35</b>" in r1, r1)
    s.check("...while the other line still shows their own rating",
            'class="pp-rate-self">4</span>' in r2 and "their figure" in r2 and "Adjusted" not in r2)
    s.check("falsified: the provisional total of what is scored IS a number, yet the row prints none (the guard holds)",
            detail()[1] is not None and detail()[0] is None and "pp-total" not in fr and not re.search(r"\d\.\d\d", fr)
            and "potential-pill" not in fr and "Worked out once all 2 are moderated · 1 of 2 done" in fr, fr)
    s.check("the Moderation step is now a link to the panel, with the title, a trailing ›, and the panel is on the page",
            re.search(r'<a class="pp-step pp-step-link [^"]*" href="[^"]*panel=kpi-mod" data-panel-open="kpi-mod" '
                      r'title="See what was moderated">Moderation · 1 of 2 done', b) is not None and "pp-step-go" in b
            and 'id="pnl-kpi-mod"' in b)
    pn = panel(b)
    s.check("the panel's foot does not print a total either: 'Worked out once all 2 are moderated'",
            "Worked out once all 2 are moderated" in pn and "kpm-big" not in pn)

    # -----------------------------------------------------------------------------------------------------------------
    s.section("every line locked: the official total, its band, and the panel")
    moderate(T2, "confirm", 45)
    code, b = page()
    official, provisional, scores = detail()
    fr, pn = final_row(b), panel(b)
    want = "%.2f" % official["value"]
    s.check("the Final row's number is pm_overall_for_targets(require_locked=True), two decimals, and its band is the label",
            official is not None and ('class="pp-total">%s</b>' % want) in fr
            and ('data-band="%s">%s</span>' % (official["label"], official["label"])) in fr, (want, fr))
    s.check("...and equals the weighted rating worked out by hand: sum(rating x weight) / sum(weight)",
            abs(official["value"] - sum(sc["value"] * w for sc, w in zip(scores, (60, 40))) / 100.0) < 0.005
            and float(want) == round(official["value"], 2))
    with a.app.app_context():
        _p = a.get_db().execute("SELECT * FROM users WHERE id=?", (P,)).fetchone()
        _fr = a.final_result(a.get_db(), _p, CID, "pm")
    _st = (_fr or {}).get("stage") or ""
    _undecided = _st in a._KPI_NOT_CALIBRATED or _st.startswith("Line manager approved")
    s.check("moderation is 'All 2 moderated · <d Mon>', and calibration reads what final_result says (no tier has decided here: "
            "not yet, or, with no HOD in a Mid-Year, final at the line manager's band)",
            re.search(r"All 2 moderated · \d{1,2} [A-Z][a-z]{2}<", fr)
            and (("After calibration: not yet" in fr) if _undecided else
                 ('After calibration: <span class="potential-pill" data-band="%s">%s</span> %s' % (_fr["band"], _fr["band"], _st)) in fr),
            (_st, fr))
    s.check("the step reads Moderation · 2 of 2 done ✓ and is still a link (is-done)",
            re.search(r'pp-step-link is-done[^>]*>Moderation · 2 of 2 done ✓', b) is not None)

    # the calibrated side: a tier's band and its stage words, never a note
    for stage, final in (("BU CEO locked — BG CEO still to lock", False), ("Final", True)):
        a.final_result = lambda db_, p_, c_, k_, ov_map=None, _st=stage, _f=final: {
            "band": "AE", "final": _f, "stage": _st, "score_valid": True, "justification": "ZZPR SECRET NOTE"}
        try:
            code, b = page()
        finally:
            a.final_result = _real_final_result
        fr = final_row(b)
        s.check("a decided tier shows its band pill and the stage words: %r" % stage,
                ('After calibration: <span class="potential-pill" data-band="AE">AE</span> %s' % stage) in fr
                and "not yet" not in fr and "SECRET" not in b, fr)
    a.final_result = lambda db_, p_, c_, k_, ov_map=None: {
        "band": "ME", "final": False, "stage": "Line manager approved — not calibrated yet", "score_valid": True}
    try:
        code, b = page()
    finally:
        a.final_result = _real_final_result
    s.check("...and the line manager's own 'not calibrated yet' stage reads as not yet, never as a tier's band",
            "After calibration: not yet" in final_row(b))

    s.check("the panel: one card per line, in table order, 'Adjusted' with the moderator's reason, and 'Confirmed'",
            pn.index("ZZPR Sales") < pn.index("ZZPR Margin") and pn.count("kpm-chip is-adj\">Adjusted<") == 1
            and pn.count("kpm-chip is-ok\">Confirmed<") == 1 and REASON in pn, pn[:400])
    s.check("...each card shows their figure -> the moderated one with ratings, the moderator, the time in MYT and the weight",
            "25 RM" in pn and "35 RM" in pn and "rating 2" in pn and "rating 3" in pn
            and re.search(r"ZZ PR Manager · \d{1,2} [A-Z][a-z]{2} \d{4}, \d\d:\d\d MYT · weight 60%", pn) is not None
            and "weight 40%" in pn, pn)
    selfs_total = (2 * 60 + 4 * 40) / 100.0
    s.check("the panel's foot: their figures' total, then the official one with its band, and a Done button",
            ("Their figures <b>%.2f</b>" % selfs_total) in pn and ('kpm-big">%s</b>' % want) in pn and "data-panel-close>Done<" in pn
            and "Moderation · 2 of 2 done" in pn and "by their line manager, ZZ PR Manager" in pn, pn[-900:])

    # -----------------------------------------------------------------------------------------------------------------
    s.section("held, no lines, and a threshold -> target group")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE pm_kpi_targets SET bg_pending=1 WHERE id=?", (T2,))
        db.commit()
    try:
        code, b = page()
        fr = final_row(b)
        s.check("lines on two scales: 'Held: their lines sit on two scales', no number, no pill",
                "Held: their lines sit on two scales" in fr and "pp-total" not in fr and "potential-pill" not in fr, fr)
    finally:
        with a.app.app_context():
            a.get_db().execute("UPDATE pm_kpi_targets SET bg_pending=0 WHERE id=?", (T2,))
            a.get_db().commit()
    code, b = page(N)
    s.check("a person with no KPI lines has no Final result row", code == 200 and "kpi-final" not in b
            and 'id="pnl-kpi-mod"' not in b)
    with a.app.app_context():
        db = a.get_db()
        TB = line(db, PB, BGB, "ZZPR Percent line", 100, 150, a_ladder=False, chain=(M,))
        db.commit()
    code, b = page(PB)
    rb = row(b, TB)
    sc = detail(PB)[2][0]
    s.check("a threshold -> target group: the heading is Achievement and their figure is the percentage, one decimal",
            ">Achievement</span>" in b and ">Rating</span>" not in b and ('class="pp-rate-self">%.1f%%</span>' % sc["value"]) in rb
            and "their figure" in rb, rb)
    moderate(TB, "adjust", 150, 190, "ZZPR percent reason")
    code, b = page(PB)
    official, _prov, scores = detail(PB)
    fr = final_row(b)
    s.check("...and once locked its total is a percentage with one decimal, and the band pill is the overall's",
            official is not None and ('class="pp-total">%.1f%%</b>' % official["value"]) in fr
            and 'data-band="%s"' % official["label"] in fr, fr)
finally:
    a.final_result = _real_final_result
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
