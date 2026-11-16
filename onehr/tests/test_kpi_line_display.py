"""A KPI line's Focus and description on every KPI table (Chris, 2026-10-18: "fill in the focus, description, and show
them on the kpi table card for all related? like the self fill kpi table, record in dashboard, record in LM, HOD,
BUCEO, and BGCEO view"; the libraries canvas board 22).

What this suite holds:
  * kpi_line_parts gives each line its KPI (the name without its Focus), its Focus and the person's description,
    beside the full name, which stays the row's key
  * every payload a KPI table is drawn from carries them: the employee's check-in card, the sign-off scorecard, the
    setting chat, the dashboard record (This cycle in detail, the profile pop-out), the line manager's moderation card,
    and the person sheet the HOD, BU CEO, Group Chief and BG CEO share
  * every renderer draws them through static/kpi_line.js (the KPI, its Focus tag, the description clamped, Read all for the rest), loaded
    on every page; the check-in row repaints when either changes
  * the admin person page and the classic calibration KPI report show them too
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("A KPI line's Focus and description on every KPI table")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG = "ZZKD Group"
ROOT = H.REPO


def read(rel):
    return open(os.path.join(ROOT, rel), encoding="utf-8").read()


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9KD-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


try:
    s.section("the parts")
    P = a.kpi_line_parts
    s.check("a line with a Focus: the KPI, the Focus, the description", P({
        "kpi_name": "Gross Profit · Skyline Roofing", "focus": "Skyline Roofing", "description": "Plant GP"}) == {
        "base": "Gross Profit", "focus": "Skyline Roofing", "detail": "Plant GP"})
    s.check("...without: the name as it is, nothing else", P({"kpi_name": "PAT", "focus": None, "description": None})
            == {"base": "PAT", "focus": "", "detail": ""})

    s.section("every payload carries them")
    src = H.source(a)

    def fn_body(name):
        i = src.index("\ndef %s(" % name)
        return src[i:src.index("\ndef ", i + 5)]
    for fn, what in (("_review_kpi_overview", "the employee's check-in card"),
                     ("_review_tool_show_scorecard", "the sign-off scorecard"),
                     ("_setting_overview", "the setting chat"),
                     ("_pm_period_summary", "the dashboard record and the profile pop-out"),
                     ("_journey_team_pm_data", "the line manager's moderation card"),
                     ("_calib_kpi_table", "the HOD / BU CEO / Group Chief / BG CEO person sheet")):
        s.check("%s (%s)" % (what, fn), "**kpi_line_parts(t)" in fn_body(fn))
    s.check("...while the AI's perf source is left as it was (no new words in its prompts)",
            "kpi_line_parts" not in fn_body("_pm_perf_source"))
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'U1')", (BG,))
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
        CID = a.active_cycle_id(db)
        PID = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                         "company, job_grade, confirmation_date) VALUES ('zz9kd-p', 'ZZ KD P', 'x', 'user', 'ZZ9KD-P', "
                         "?, 'U1', '14', '2020-01-01')", (BG,)).lastrowid
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, focus, description, weightage, method, "
                   "rate1, rate2, rate3, rate4, rate5, business_group, company) VALUES (?,?, 'ZZKD Gross Profit · "
                   "Skyline Roofing', 'Skyline Roofing', 'Gross profit of the Skyline Roofing plant, from the monthly "
                   "accounts.', 100, 'more', 1,2,3,4,5, ?, 'U1')", (CID, PID, BG))
        db.commit()
        u = db.execute("SELECT * FROM users WHERE id=?", (PID,)).fetchone()
    with a.app.test_request_context("/"):
        db = a.get_db()
        sm = a._pm_period_summary(db, u, CID)
    lines = (sm or {}).get("lines") or []
    s.check("...and the dashboard record's lines really have them", lines and lines[0].get("base") == "ZZKD Gross Profit"
            and lines[0].get("focus") == "Skyline Roofing" and lines[0].get("detail", "").startswith("Gross profit of"),
            lines[:1])

    s.section("every renderer draws them")
    kl = read("static/kpi_line.js")
    s.check("one helper: the KPI, its Focus tag, the description clamped with Read all opening the pop-out",
            "kpi-focus" in kl and "kpi-desc" in kl and "kpi-desc-more" in kl and "onehrKpiLine.open" in kl
            and "textContent" in kl and "innerHTML" not in kl and "is-open" not in kl)
    s.check("...loaded on every page, in the head", 'filename=\'kpi_line.js\'' in read("templates/base.html").split(
        "</head>")[0])
    jc = read("static/journey_chat.js")
    for fn, what in (("kpiRowCells", "the check-in row"), ("pmKpiRow", "the moderation row"),
                     ("scorecardTable", "the sign-off scorecard"), ("calKpiTable", "the person sheet")):
        body = jc[jc.index("function %s(" % fn):]
        body = body[:body.index("\n  function ", 20)]
        # the quiet tables (2026-10-22) name it without the tag and say the Focus on the line under it (kpiMetaEl)
        flat = fn != "scorecardTable"
        s.check("journey: %s uses it (%s)" % (what, fn),
                (("kpiNameFlat(" in body and "kpiMetaEl(" in body) if flat else "kpiNameEl(" in body)
                and "kpiDescEl(" in body)
    sig = jc[jc.index("function kpiRowSig(l)"):]
    sig = sig[:sig.index("\n  }")]
    s.check("...the check-in row repaints when the Focus or description changes", "l.focus" in sig and "l.detail" in sig)
    db_js = read("static/dashboard.js")
    s.check("the dashboard's two KPI tables use it", db_js.count("klName(") >= 3 and db_js.count("klDesc(") >= 3)
    for f in ("static/setting_chat.js", "static/review_chat.js"):
        s.check("%s uses it" % f, "klName(nm, l, l.kpi)" in read(f) and "klDesc(l)" in read(f))
    s.check("the profile pop-out uses it", "onehrKpiLine" in read("templates/_record_popout.html"))
    s.check("the classic calibration KPI report shows them", "kpi-focus" in read("templates/_calib_report_kpi.html")
            and "t['description']" in read("templates/_calib_report_kpi.html"))

    s.section("the admin person page")
    pg = H.client_as(a, SU["id"]).get("/admin/users/%d?tab=performance&fragment=1" % PID).get_data(as_text=True)
    s.check("its row: the KPI, the Focus tag, the description", '<b>ZZKD Gross Profit<span class="kpi-focus">Skyline '
            'Roofing</span></b>' in pg and "Gross profit of the Skyline Roofing plant" in pg)
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
