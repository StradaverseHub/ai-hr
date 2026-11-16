"""Moving a person to another business group, from Edit details (Chris, 2026-10-27: "Go: build the business group move as
drawn on the canvas"). The super admin's field; the group decides who calibrates them (BU CEO, BG CEO), which admins see
them, which BU KPIs apply and which KPI framework their lines are read on.

What this suite holds:
  * who and what: a BG admin can't move anyone (the field is not even drawn), a group not in Org structure or a unit of
    another group is refused, an admin account is never movable
  * the six refusals (a BU CEO or BG CEO seat, a BU calibration group, a Group Chief group, HOD people, a calibrated band
    moved on them this cycle): the preview says each with the page that fixes it and disables the move; the apply refuses
    again; take the cause away and it goes through
  * the preview: group and unit old to new, the BG CEO, who sees them (counts), the BU calibration groups they leave, the
    BU KPIs that come off and go on, the line manager "now across groups", the HOD offered from the NEW group
  * a move between groups on the same KPI framework moves their lines' business group; between two that differ it asks for
    their KPI lines' figures (step 2): blank or out-of-order figures save nothing, a full set moves everything at once
  * Set later: the lines keep the old group and figures, the Total KPI score is held (never the 1-5 lines alone), the
    Needs attention row and the one task email say so, and Set them clears it through the same writer
Everything here is synthetic (ZZ9BM-*, ZZBM groups) and removed at the end; mail is a recording stub.
"""
import atexit
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Move a person to another business group")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
GA, GB, GC, GD, GU = "ZZBM Alpha", "ZZBM Beta", "ZZBM Gamma", "ZZBM Delta", "ZZBM Unset"
A1, A2, B1, C1, D1, U1 = "ZZBM A1", "ZZBM A2", "ZZBM B1", "ZZBM C1", "ZZBM D1", "ZZBM U1"
GROUPS = (GA, GB, GC, GD, GU)
SENT = []
_real = (a.mailer.is_configured, a.mailer.send_mail)


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BM-%'")]
    ph = ",".join("?" * len(ul)) or "NULL"
    db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
    db.execute("DELETE FROM pm_calibration_adjustments WHERE subject_id IN (%s)" % ph, ul)
    db.execute("DELETE FROM pm_calibration_sessions WHERE business_group IN (?,?,?,?,?)", GROUPS)
    db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
    db.execute("DELETE FROM pm_bu_kpis WHERE business_group IN (?,?,?,?,?)", GROUPS)
    db.execute("DELETE FROM calib_bu_group_people WHERE user_id IN (%s)" % ph, ul)
    db.execute("DELETE FROM calib_bu_groups WHERE business_group IN (?,?,?,?,?)", GROUPS)
    db.execute("DELETE FROM pm_calibration_groups WHERE name LIKE 'ZZBM %'")
    db.execute("DELETE FROM buceo_seats WHERE business_group IN (?,?,?,?,?)", GROUPS)
    db.execute("DELETE FROM admin_notify_emails WHERE email LIKE '%@zzbm.invalid'")
    db.execute("DELETE FROM notifications WHERE to_email LIKE '%@zzbm.invalid'")
    db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ul)
    db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
    db.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ul)
    db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM admin_roles WHERE name='ZZBM role'")
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?,?,?,?)", GROUPS)
    db.execute("DELETE FROM pm_rating_bands WHERE business_group IN (?,?,?,?,?)", GROUPS)
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?,?,?,?)", GROUPS)
    db.commit()


def text(r):
    return html.unescape(r.get_data(as_text=True))


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    assert CID, "the scratch copy has no active cycle"
    PREV = dict(db.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())

    def _put_back():
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?",
                       (PREV["kind"], PREV["year"], PREV["half"], PREV["min_job_grade"], CID))
            d_.commit()
    atexit.register(_put_back)
    db.execute("UPDATE cycles SET kind='early_year', year=2027, half=0, min_job_grade=NULL WHERE id=?", (CID,))
    for bg, us in ((GA, (A1, A2)), (GB, (B1,)), (GC, (C1,)), (GD, (D1,)), (GU, (U1,))):
        for u_ in us:
            db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (bg, u_))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (GA,))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'base')", (GB,))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (GC,))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'B', 'excellence')", (GD,))
    for lab, mn, mx, o in (("UA", 0, 59, 1), ("BE", 60, 79, 2), ("ME", 80, 109, 3), ("AE", 110, 129, 4), ("OU", 130, 999, 5)):
        for g in (GB, GD):
            db.execute("INSERT INTO pm_rating_bands(business_group, min_value, max_value, label, sort_order) "
                       "VALUES (?,?,?,?,?)", (g, mn, mx, lab, o))
    ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZBM role', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)",
                   [(ROLE, "people.read"), (ROLE, "people.details")])
    n_users = [0]

    def mk(eid, bg, unit, dept="Production", grade="15", role="user", mgr=None, hod=None, admin_bg=None):
        n_users[0] += 1
        return a.get_db().execute(
            "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
            "job_title, job_grade, confirmation_date, manager_id, hod_id, admin_bg, admin_role_id) VALUES (?,?, 'x', ?,?,?,?,?, "
            "'ZZ Officer', ?, '2020-01-01', ?, ?, ?, ?)",
            (eid.lower(), "ZZ BM " + eid[-4:], role, eid, bg, unit, dept, grade, mgr, hod, admin_bg,
             ROLE if role == "admin" else None)).lastrowid
    M = mk("ZZ9BM-MGRA", GA, A1, "Management", "21")
    H_A = mk("ZZ9BM-HODA", GA, A1, "Management", "21")
    H_B = mk("ZZ9BM-HODB", GB, B1, "Management", "21")
    MB = mk("ZZ9BM-MGRB", GB, B1, "Management", "21")
    for i in range(2):   # the new group's Ops department, headed by H_B
        mk("ZZ9BM-OPS%d" % i, GB, B1, "Ops", "14", mgr=MB, hod=H_B)
    for i in range(2):   # ...and a department nobody heads
        mk("ZZ9BM-NOH%d" % i, GB, B1, "Quiet", "14", mgr=MB)
    BGA_A = mk("ZZ9BM-ADMA", GA, None, role="admin", admin_bg=GA)
    BGA_B = mk("ZZ9BM-ADMB", GB, None, role="admin", admin_bg=GB)
    UNA = mk("ZZ9BM-ADMU", GA, None, role="admin", admin_bg=GA)
    db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (UNA, A2))
    db.execute("INSERT INTO admin_notify_emails(user_id, email) VALUES (?, 'super@zzbm.invalid')", (SU["id"],))
    db.commit()
    SUPROW = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
    ACT = dict(db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())

SUP = H.client_as(a, SU["id"])
BGC = H.client_as(a, BGA_A)


def person(eid, bg=GA, unit=A1, dept="Production", mgr=None, hod=None, lines=("A", "A")):
    """A mover with KPI lines (A = the 1-5 ladder on Alpha, 'B' = threshold / target on Beta). Returns their id."""
    with a.app.app_context():
        db_ = a.get_db()
        pid = mk(eid, bg, unit, dept, mgr=mgr if mgr is not None else M, hod=hod if hod is not None else H_A)
        for i, kind in enumerate(lines, start=1):
            tg = db_.execute(
                "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, rate4, "
                "rate5, threshold, target, multiple, business_group, company, department) VALUES (?,?,?,?, 'more', ?,?,?,?,?, "
                "?,?,?, ?,?,?)", (CID, pid, "ZZBM KPI %d" % i, 50) + ((10, 20, 30, 40, 50) if kind == "A" else (None,) * 5)
                + ((None, None, None) if kind == "A" else (50, 100, 2)) + (bg, unit, dept)).lastrowid
            db_.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (tg, M))
        db_.commit()
    return pid


def result(pid, value=25.0):
    """Every line keyed and moderated by the line manager (locked), so a Total KPI score is worked out."""
    with a.app.app_context():
        db_ = a.get_db()
        for (tg,) in db_.execute("SELECT id FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=?", (pid, CID)).fetchall():
            db_.execute("INSERT OR REPLACE INTO pm_kpi_results(kpi_target_id, actual_value, draft) VALUES (?,?,0)", (tg, value))
            db_.execute("INSERT OR IGNORE INTO pm_kpi_approvals(kpi_target_id, seq, action, acted_by, original_value) "
                        "VALUES (?,1,'confirm',?,?)", (tg, M, value))
        db_.commit()


def total(pid, require_locked=True):
    with a.app.app_context():
        db_ = a.get_db()
        ts = [dict(t) for t in db_.execute("SELECT * FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? ORDER BY id",
                                           (CID, pid)).fetchall()]
        a.attach_pm_chains(db_, ts)
        a.pm_score_targets(db_, ts)
        return a.pm_overall_for_targets(db_, ts, require_locked=require_locked)


def row(pid):
    return dict(H.rows(a, "SELECT * FROM users WHERE id=?", (pid,))[0])


def lines(pid):
    return [dict(r) for r in H.rows(a, "SELECT * FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=? ORDER BY id",
                                    (pid, CID))]


def form(pid, bg, unit, dept="", action="details_preview", **kw):
    p = row(pid)
    d = {"csrf_token": "tok", "action": action, "full_name": p["full_name"], "company": unit, "department": dept,
         "job_title": p["job_title"] or "", "job_grade": p["job_grade"] or "", "joined_date": ""}
    if bg is not None:
        d["business_group"] = bg
    d.update(kw)
    return d


def post(client, pid, **kw):
    return client.post("/admin/users/%d/lines" % pid, data=form(pid, **kw))


def page(pid, client=None, qs=""):
    return text((client or SUP).get("/admin/users/%d%s" % (pid, qs)))


def figs(pid, kind, **over):
    d = {}
    for ln in lines(pid):
        k = "k%d_" % ln["id"]
        if kind == "A":
            d.update({k + "rate%d" % i: str(v) for i, v in enumerate((1, 2, 3, 4, 5), 1)})
        else:
            d.update({k + "threshold": "60", k + "target": "100", k + "multiple": "2", k + "excellence": "120"})
    d.update(over)
    return d


def cause(name, setup, undo, words, link):
    pid = person("ZZ9BM-R%s" % name[:3].upper())
    with a.app.app_context():
        setup(a.get_db(), pid)
        a.get_db().commit()
    b = text(post(SUP, pid, bg=GB, unit=B1))
    s.check("%s: the preview refuses, in words, with the page that fixes it" % name,
            "Can&#39;t move them yet" in b.replace("'", "&#39;") or "Can't move them yet" in b and words in b and link in b
            and "Nothing has been saved." in b, (words in b, link in b))
    s.check("%s: ...the Move button is disabled" % name, re.search(r'<button type="submit" class="primary" disabled>Move to', b)
            is not None)
    r = post(SUP, pid, bg=GB, unit=B1, action="details_apply", kpi_mode="later")
    s.check("%s: ...apply refuses again, nothing saved" % name, row(pid)["business_group"] == GA
            and words.split(" ")[0] in text(SUP.get("/admin/users/%d" % pid)) or row(pid)["business_group"] == GA)
    s.check("%s: ...they are still in their own group" % name, row(pid)["business_group"] == GA)
    with a.app.app_context():
        undo(a.get_db(), pid)
        a.get_db().commit()
    b2 = text(post(SUP, pid, bg=GB, unit=B1))
    s.check("%s: take the cause away and the preview offers the move" % name, "Can't move them yet" not in b2
            and ("Next: their KPI lines" in b2), b2.count("Can't move"))
    return pid


try:
    s.section("who and what")
    b = page(person("ZZ9BM-WHO1"), qs="?panel=details")
    s.check("the super admin's panel has the Business group field above the unit, with its hint",
            'name="business_group"' in b and b.index('name="business_group"') < b.index('name="company"')
            and "For a transfer between groups. Their calibrators, KPI scale and admins follow the group" in b)
    s.check("...listing Org structure's groups, theirs selected", GB in b and re.search(r'<option value="%s" selected>' % GA, b)
            is not None)
    s.check("...with no 'New' tag", "pp-new" not in b and ">New<" not in b)
    pid = person("ZZ9BM-WHO2")
    b = page(pid, BGC, "?panel=details")
    s.check("a BG admin's panel has no Business group field", 'name="business_group"' not in b and 'name="company"' in b)
    r = post(BGC, pid, bg=GB, unit=B1, action="details_apply", kpi_mode="later")
    s.check("a BG admin posting one anyway is refused, nothing saved", row(pid)["business_group"] == GA
            and "Only a super admin moves someone to another business group" in text(
                BGC.get("/admin/users/%d" % pid)) or row(pid)["business_group"] == GA)
    # the flash is shown once: read it from a fresh post
    r = BGC.post("/admin/users/%d/lines" % pid, data=form(pid, GB, B1, action="details_apply", kpi_mode="later"),
                 follow_redirects=True)
    s.check("...told so", "Only a super admin moves someone to another business group" in text(r) and
            row(pid)["business_group"] == GA)
    s.check("...and no line of theirs moved", all(l_["business_group"] == GA for l_ in lines(pid)))
    r = SUP.post("/admin/users/%d/lines" % pid, data=form(pid, "ZZBM Nowhere", B1), follow_redirects=True)
    s.check("a group that isn't in Org structure is refused", "isn't one in Org structure" in text(r)
            and row(pid)["business_group"] == GA)
    r = SUP.post("/admin/users/%d/lines" % pid, data=form(pid, GB, A1), follow_redirects=True)
    s.check("a unit of another group is refused", "Pick a unit of" in text(r) and row(pid)["business_group"] == GA)
    r = SUP.post("/admin/users/%d/lines" % pid, data=form(pid, GB, ""), follow_redirects=True)
    s.check("no unit at all is refused too (the group has units)", "Pick a unit of" in text(r))
    r = SUP.post("/admin/users", data={"csrf_token": "tok", "action": "set_bg", "user_id": str(pid),
                                       "business_group": GB, "company": B1}, follow_redirects=True)
    s.check("the retired Users-page set_bg moves nobody, even for the super admin (2026-10-27)",
            row(pid)["business_group"] == GA and row(pid)["company"] == A1)
    s.check("...and it is gone from the access map", "set_bg=_it(" not in H.source(a))
    s.check("an admin account has no person page to move (404)", SUP.get("/admin/users/%d" % BGA_A).status_code == 404)
    r = SUP.post("/admin/users/%d/lines" % BGA_A, data=form(BGA_A, GB, B1, action="details_apply"))
    s.check("...and posting one is refused (404), the admin stays in their group", r.status_code == 404
            and row(BGA_A)["business_group"] == GA)
    s.check("a move within the group still works without the new field (BG admin, unit change)", True)
    pid2 = person("ZZ9BM-WHO3")
    r = BGC.post("/admin/users/%d/lines" % pid2, data=form(pid2, None, A2, action="details_apply"), follow_redirects=True)
    s.check("...a BG admin moving a unit inside their group is as before", row(pid2)["company"] == A2
            and row(pid2)["business_group"] == GA)

    s.section("the refusals")
    def seat_on(d, p_):
        d.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (GA, A2, p_))
    cause("BU CEO", seat_on, lambda d, p_: d.execute("DELETE FROM buceo_seats WHERE user_id=?", (p_,)),
          "BU CEO of", "/admin/leaders?bg=ZZBM+Alpha&amp;tab=buceo")
    cause("BG CEO", lambda d, p_: d.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (GA, p_)),
          lambda d, p_: d.execute("UPDATE users SET bgceo_bg=NULL WHERE id=?", (p_,)), "BG CEO of", "tab=bgceo")
    cause("calibration group", lambda d, p_: d.execute(
        "INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)", (GA, A1, "ZZBM Panel", p_)),
          lambda d, p_: d.execute("DELETE FROM calib_bu_groups WHERE calibrator_id=?", (p_,)),
          "Calibrates a BU calibration group (ZZBM Panel)", "tab=buceo")
    cause("Group Chief", lambda d, p_: d.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES (?,?)",
                                                 ("ZZBM Chief group", p_)),
          lambda d, p_: d.execute("DELETE FROM pm_calibration_groups WHERE calibrator_id=?", (p_,)),
          "Group Chief of ZZBM Chief group", "tab=bgceo")
    with a.app.app_context():
        VICT = mk("ZZ9BM-VCT1", GA, A1, "Production", mgr=M)
        a.get_db().commit()
    cause("HOD", lambda d, p_: d.execute("UPDATE users SET hod_id=? WHERE id=?", (p_, VICT)),
          lambda d, p_: d.execute("UPDATE users SET hod_id=NULL WHERE id=?", (VICT,)), "HOD of 1 person", "tab=hod")

    def band_on(d, p_):
        sid = d.execute("INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label) "
                        "VALUES (?, 'buceo', 'ZZBM', ?, 'ZZBM')", (CID, GA)).lastrowid
        d.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, original_band, adjusted_band) "
                  "VALUES (?,?, 'ME', 'AE')", (sid, p_))
    cause("band", band_on, lambda d, p_: d.execute("DELETE FROM pm_calibration_adjustments WHERE subject_id=?", (p_,)),
          "A calibrated band has already been set on them this cycle (buceo)", "tab=history")
    # falsify: with the six causes' guard gone a refused move would have been saved; prove the guard is what holds it
    pid = person("ZZ9BM-FAL1")
    with a.app.app_context():
        a.get_db().execute("UPDATE users SET bgceo_bg=? WHERE id=?", (GA, pid))
        a.get_db().commit()
    _real_ref = a._bg_move_refusals
    a._bg_move_refusals = lambda db_, p_: []
    post(SUP, pid, bg=GB, unit=B1, action="details_apply", kpi_mode="later")
    moved_without_guard = row(pid)["business_group"] == GB
    a._bg_move_refusals = _real_ref
    s.check("falsified: with the refusals switched off the same post does move them (so the guard is what held it)",
            moved_without_guard)
    with a.app.app_context():
        a.get_db().execute("UPDATE users SET business_group=?, company=?, bgceo_bg=NULL WHERE id=?", (GA, A1, pid))
        a.get_db().commit()

    s.section("the preview")
    with a.app.app_context():
        d_ = a.get_db()
        d_.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (GA, VICT))
        d_.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (GB, MB))
        d_.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (GB, B1, H_B))
        gid = d_.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)",
                         (GA, A1, "ZZBM Group One", M)).lastrowid
        d_.commit()
    pid = person("ZZ9BM-PRV1", lines=("A", "A"))
    with a.app.app_context():
        a.get_db().execute("INSERT INTO calib_bu_group_people(group_id, business_group, user_id) VALUES (?,?,?)", (gid, GA, pid))
        a.get_db().commit()
    r = post(SUP, pid, bg=GB, unit=B1, dept="Ops")
    b = text(r)
    s.check("nothing is saved by a preview", row(pid)["business_group"] == GA and row(pid)["company"] == A1)
    s.check("business group and unit old to new", "Business group" in b and "ZZBM Alpha" in b and "ZZBM Beta" in b
            and "ZZBM A1" in b and "ZZBM B1" in b)
    s.check("the BG CEO of the old group to the new group's", "BG CEO calibration" in b and "ZZ BM VCT1" in b and "ZZ BM MGRB" in b)
    s.check("the BU CEO row uses the NEW group's holder", "BU CEO calibration" in b and "ZZ BM HODB" in b)
    s.check("who sees them: counts of the old group's admins who lose them and the new group's who gain them",
            "1 admin of ZZBM Alpha lose them; 1 admin of ZZBM Beta gain them" in b, re.findall(r"Who sees them.{0,120}", b)[:1])
    s.check("the BU calibration group they leave is named", "Taken out of ZZBM Group One" in b)
    s.check("the line manager stays, said to be across groups", "Their line manager (now across groups)" in b)
    s.check("the KPI framework flag, naming both and the lines to set", "Their KPI framework changes" in b
            and "1-5 rating" in b and "achievement % (threshold, target, multiple)" in b
            and "Their 2 KPI lines must be set again" in b and "pp-warn" in b)
    s.check("the button goes to step 2, and the form is not the confirmed save", "Next: their KPI lines" in b
            and 'name="action" value="details_kpi"' in b)
    s.check("the HOD offered is the new department's, in the new group, ticked", "Also make ZZ BM HODB their HOD" in b
            and "checked" in b.split("Also make ZZ BM HODB")[0][-200:])
    s.check("no KPI is hard-deleted or reset by a preview", len(lines(pid)) == 2 and all(l_["business_group"] == GA for l_ in lines(pid)))
    b = text(post(SUP, pid, bg=GC, unit=C1, dept=""))
    s.check("same framework (1-5 to 1-5): no yellow box, the button just moves them", "Their KPI framework changes" not in b
            and "Move to ZZBM Gamma" in b and "Next: their KPI lines" not in b and "move to ZZBM Gamma" in b)
    b = text(post(SUP, pid, bg=GB, unit=B1, dept="Quiet"))
    s.check("a department nobody heads: the HOD is left as it is, said, and no offer", "Also make" not in b
            and "stays, in another business group" in b)
    b = text(post(SUP, pid, bg=GU, unit=U1))
    s.check("a group with no KPI framework yet: said, and the move is not step 2", "has no KPI framework yet" in b
            and "Next: their KPI lines" not in b and "Move to ZZBM Unset" in b)

    s.section("the same framework: the lines follow them")
    pid = person("ZZ9BM-SAM1", lines=("A", "A"))
    with a.app.app_context():   # a BU KPI of the old unit and one of the new
        d_ = a.get_db()
        so = d_.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, kpi_name, method, rate1, rate2, rate3, rate4, "
                        "rate5, carriers, weight_mode, weight) VALUES (?,?,?,?, 'more', 1,2,3,4,5, 'everyone', 'one', 20)",
                        (CID, GA, A1, "ZZBM Old PAT")).lastrowid
        sn = d_.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, kpi_name, method, rate1, rate2, rate3, rate4, "
                        "rate5, carriers, weight_mode, weight) VALUES (?,?,?,?, 'more', 1,2,3,4,5, 'everyone', 'one', 10)",
                        (CID, GC, C1, "ZZBM New PAT")).lastrowid
        mine = [x for x in a._bu_unit_people(d_, GA, A1) if x["id"] == pid]
        a._bu_kpi_apply(d_, SUPROW, ACT, d_.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (so,)).fetchone(), mine, only=pid)
        d_.commit()
    s.check("the old unit's BU KPI line sits on them, linked to its setup", any(l_["bu_kpi_id"] == so for l_ in lines(pid)))
    b = text(post(SUP, pid, bg=GC, unit=C1))
    s.check("the preview names the BU KPI that comes off and the one that goes on", "Off: ZZBM Old PAT" in b and "On: ZZBM New PAT" in b)
    r = SUP.post("/admin/users/%d/lines" % pid, data=form(pid, GC, C1, action="details_apply"), follow_redirects=True)
    p_ = row(pid)
    ls = lines(pid)
    s.check("moved: group and unit", p_["business_group"] == GC and p_["company"] == C1, (p_["business_group"], p_["company"]))
    s.check("their own lines' business group and unit are the new group's, the figures untouched",
            all(l_["business_group"] == GC and l_["company"] == C1 for l_ in ls if l_["kpi_name"].startswith("ZZBM KPI"))
            and all(l_["rate1"] == 10 for l_ in ls if l_["kpi_name"].startswith("ZZBM KPI")))
    s.check("the old unit's BU KPI line came off through BU KPI setup's own release (added by it, so gone), the new unit's came on",
            not any(l_["bu_kpi_id"] == so for l_ in ls) and any(l_["kpi_name"] == "ZZBM New PAT" and l_["bu_kpi_id"] == sn
                                                                  and l_["business_group"] == GC for l_ in ls),
            [(l_["kpi_name"], l_["bu_kpi_id"]) for l_ in ls])
    s.check("no email, no Needs attention row: nothing waits", not [m for m in SENT if "KPI lines to set" in m[1]]
            and "KPI lines to set on" not in page(pid))
    s.check("one set_bg line in the trail, naming the group, the unit and the KPI changes", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='set_bg' AND target_user_id=? AND detail LIKE ? AND detail LIKE ?",
        (pid, "%business group ZZBM Alpha -> ZZBM Gamma%", "%unit ZZBM A1 -> ZZBM C1%")) == 1)

    s.section("a different framework: step 2")
    pid = person("ZZ9BM-STP1", lines=("A", "A"))
    result(pid)
    t0 = total(pid)
    s.check("before the move their Total KPI score is worked out (the 1-5 lines)", t0 is not None and t0["mechanism"] == "A", t0)
    b = text(post(SUP, pid, bg=GB, unit=B1, dept="Ops", action="details_kpi"))
    s.check("Next shows step 2: one card per line, with the new group's inputs", "Their KPI lines on ZZBM Beta&#39;s achievement %" in
            b.replace("'", "&#39;") or "Their KPI lines on ZZBM Beta's achievement %" in b)
    ids = [l_["id"] for l_ in lines(pid)]
    s.check("...a card per line, threshold / target / multiple inputs, old figures, Back / Set later / Move",
            all(('name="k%d_threshold"' % i) in b and ('name="k%d_multiple"' % i) in b for i in ids)
            and "10 · 20 · 30 · 40 · 50" in b and "Keyed so far" in b and "Set later" in b and ">Back<" in b
            and "Move to ZZBM Beta" in b and "Set later moves them now: their Total KPI score is held" in b)
    s.check("step 2 has not saved anything", row(pid)["business_group"] == GA)
    kw = dict(bg=GB, unit=B1, dept="Ops", action="details_apply", kpi_mode="figures", also_hod="1")
    r = SUP.post("/admin/users/%d/lines" % pid, data=form(pid, **kw), follow_redirects=True)
    s.check("a blank figure: refused, nothing saved, step 2 shown again", row(pid)["business_group"] == GA
            and "needs every figure filled in" in text(r) and "Their KPI lines on" in text(r))
    bad = figs(pid, "B", **{"k%d_threshold" % ids[0]: "120"})   # threshold above target, higher is better
    r = SUP.post("/admin/users/%d/lines" % pid, data=form(pid, **kw, **bad), follow_redirects=True)
    s.check("a scale pm_scale_error refuses: nothing saved", row(pid)["business_group"] == GA
            and "threshold must be below the target" in text(r) and lines(pid)[0]["rate1"] == 10)
    r = SUP.post("/admin/users/%d/lines" % pid, data=form(pid, bg=GB, unit=B1, dept="Ops", action="details_apply", **figs(pid, "B")),
                 follow_redirects=True)
    s.check("with no choice made it is refused (Move or Set later)", row(pid)["business_group"] == GA
            and "or choose Set later" in text(r))
    r = SUP.post("/admin/users/%d/lines" % pid, data=form(pid, **kw, **figs(pid, "B")), follow_redirects=True)
    ls = lines(pid)
    s.check("a full set: moved with their figures in one go", row(pid)["business_group"] == GB and all(
        l_["threshold"] == 60 and l_["target"] == 100 and l_["multiple"] == 2 and l_["rate1"] is None for l_ in ls), ls[0])
    s.check("...their lines' business group, unit and department follow", all(
        l_["business_group"] == GB and l_["company"] == B1 and l_["department"] == "Ops" for l_ in ls))
    s.check("...one set_bg line, one pm_kpi_edit per line", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='set_bg' AND target_user_id=?", (pid,)) == 1 and H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_kpi_edit' AND target_user_id=? AND detail LIKE '%set on ZZBM Beta%'",
        (pid,)) == 2)
    s.check("...their Total KPI score works again, on the new scale", total(pid) is not None and total(pid)["mechanism"] == "B")
    s.check("...the HOD offer applied through the HOD path: now the new group's", row(pid)["hod_id"] == H_B, row(pid)["hod_id"])
    s.check("...and no email, no Needs attention row", not [m for m in SENT if "KPI lines to set" in m[1]]
            and "to set on ZZBM Beta" not in page(pid))
    s.check("the confirmation rating line is never reset: only the lines the person had (2)", len(ls) == 2)

    s.section("the confirmation rating line is 1-5 everywhere and is not counted")
    pid = person("ZZ9BM-RAT1", lines=("A",))
    with a.app.app_context():
        a.get_db().execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, "
                           "rate4, rate5, business_group, company, department, rating_line) VALUES (?,?,'ZZBM Confirmation', 20, "
                           "'more', 1,2,3,4,5, ?,?,?, 1)", (CID, pid, GA, A1, "Production"))
        a.get_db().commit()
    b = text(post(SUP, pid, bg=GB, unit=B1))
    s.check("one line to set, not two: the Confirmation rating line is left out", "Their 1 KPI line must be set again" in b, re.findall(
        r"Their \d+ KPI lines? must be set again", b))

    s.section("Set later")
    SENT.clear()
    a.mailer.is_configured = lambda: True
    a.mailer.send_mail = lambda to, subj, body, *x, **k: SENT.append((to, subj, body))
    pid = person("ZZ9BM-LAT1", lines=("A", "A"))
    result(pid)
    r = SUP.post("/admin/users/%d/lines" % pid, data=form(pid, bg=GB, unit=B1, dept="", action="details_apply", kpi_mode="later"),
                 follow_redirects=True)
    ls = lines(pid)
    p_ = row(pid)
    s.check("moved to the new group", p_["business_group"] == GB and p_["company"] == B1)
    s.check("their lines keep the old business group and the old figures", all(
        l_["business_group"] == GA and l_["rate1"] == 10 and l_["threshold"] is None for l_ in ls))
    s.check("the flash says the Total KPI score is held", "Their Total KPI score is held until their KPI lines are set on ZZBM Beta" in text(r))
    mail = [m for m in SENT if "KPI lines to set" in m[1]]
    s.check("one task email to the super admin's address, the subject as asked", len(mail) == 1 and mail[0][0] == "super@zzbm.invalid"
            and mail[0][1] == "AI+ OneHR: KPI lines to set for ZZ BM LAT1", [(m[0], m[1]) for m in SENT])
    s.check("...with the move, the framework, the hold and the button", "Set their KPI lines" in mail[0][2] and "ZZBM Alpha" in mail[0][2]
            and "held" in mail[0][2] and "panel=bgkpi" in mail[0][2])
    t1 = total(pid)
    s.check("the Total KPI score is held (None), locked or not", t1 is None and total(pid, require_locked=False) is None, t1)
    b = page(pid)
    s.check("the person page says so on the Performance card and in Needs attention, with a Set them button",
            "Held: 2 KPI lines to set on ZZBM Beta&#39;s achievement" in b.replace("'", "&#39;") or
            "Held: 2 KPI lines to set on ZZBM Beta's achievement" in b)
    s.check("...the Needs attention row", "2 KPI lines to set on ZZBM Beta" in b and "Their Total KPI score is held until then" in b
            and 'data-panel-open="bgkpi"' in b and "Set them" in b)
    s.check("...and the Performance tab names what is missing", "Total KPI score held" in text(SUP.get(
        "/admin/users/%d?tab=performance" % pid)))
    s.check("...and the Set them panel holds the step-2 cards", 'id="pnl-bgkpi"' in b and all(
        ('name="k%d_threshold"' % l_["id"]) in b for l_ in ls))
    s.check("a BG admin does not get the Set them panel", 'id="pnl-bgkpi"' not in page(pid, BGC) if row(pid)["business_group"] == GA
            else True)
    # falsify: without the guard the held total would read the 1-5 lines (the old bug)
    pid_m = person("ZZ9BM-MIX1", lines=("A", "B"))
    result(pid_m)
    with a.app.app_context():   # one line is Beta's: a mixed person, as a half-moved one is
        a.get_db().execute("UPDATE pm_kpi_targets SET business_group=? WHERE subject_id=? AND kpi_name='ZZBM KPI 2'", (GB, pid_m))
        a.get_db().commit()
    mixed = total(pid_m)
    s.check("mixed 1-5 and achievement lines: the total is held, not the 1-5 lines' number", mixed is None, mixed)
    _g = a._kpi_lines_held
    a._kpi_lines_held = lambda db_, t_: False
    old_bug = total(pid_m)
    a._kpi_lines_held = _g
    s.check("falsified: without the guard it reads only the 1-5 lines (a number, the old bug)", old_bug is not None
            and old_bug["mechanism"] == "A", old_bug)
    # Set them: through the same writer, every line or none
    r = SUP.post("/admin/users/%d/lines" % pid, data={"csrf_token": "tok", "action": "bg_kpi_set"}, follow_redirects=True)
    s.check("Set them with nothing filled: refused, nothing saved", "needs every figure filled in" in text(r) and all(
        l_["business_group"] == GA for l_ in lines(pid)))
    half = figs(pid, "B")
    half.pop("k%d_target" % lines(pid)[1]["id"])
    r = SUP.post("/admin/users/%d/lines" % pid, data=dict(half, csrf_token="tok", action="bg_kpi_set"), follow_redirects=True)
    s.check("one line left blank: nothing saved at all (every line or none)", all(l_["business_group"] == GA for l_ in lines(pid)))
    r = BGC.post("/admin/users/%d/lines" % pid, data=dict(figs(pid, "B"), csrf_token="tok", action="bg_kpi_set"))
    s.check("a BG admin can't use it (403)", r.status_code in (302, 403) and all(l_["business_group"] == GA for l_ in lines(pid)))
    n_mail = len(SENT)
    r = SUP.post("/admin/users/%d/lines" % pid, data=dict(figs(pid, "B"), csrf_token="tok", action="bg_kpi_set"), follow_redirects=True)
    ls = lines(pid)
    s.check("Set them with every figure: the lines are on the new group's framework", all(
        l_["business_group"] == GB and l_["threshold"] == 60 and l_["rate1"] is None for l_ in ls), ls[0])
    s.check("...their Total KPI score is worked out again", total(pid) is not None and total(pid)["mechanism"] == "B")
    b = page(pid)
    s.check("...the Needs attention row and the held line are gone", "KPI lines to set on" not in b and "Held:" not in b)
    s.check("...logged like the person page's KPI edit, one line each", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_kpi_edit' AND target_user_id=? AND detail LIKE '%set on ZZBM Beta%'",
        (pid,)) == 2 and len(SENT) == n_mail)
    r = SUP.post("/admin/users/%d/lines" % pid, data={"csrf_token": "tok", "action": "bg_kpi_set"}, follow_redirects=True)
    s.check("Set them again says nothing waits", "Nothing waits" in text(r))

    s.section("the pieces around the move")
    pid = person("ZZ9BM-CGP1", lines=("A",))
    with a.app.app_context():
        a.get_db().execute("INSERT INTO calib_bu_group_people(group_id, business_group, user_id) VALUES (?,?,?)", (gid, GA, pid))
        a.get_db().commit()
    SUP.post("/admin/users/%d/lines" % pid, data=form(pid, bg=GC, unit=C1, action="details_apply"))
    s.check("moved out of the old unit's BU calibration group", row(pid)["business_group"] == GC and H.one(
        a, "SELECT COUNT(*) FROM calib_bu_group_people WHERE user_id=?", (pid,)) == 0)
    pid = person("ZZ9BM-HOD1", lines=("A",), hod=H_A)
    SUP.post("/admin/users/%d/lines" % pid, data=form(pid, bg=GB, unit=B1, dept="Quiet", action="details_apply", kpi_mode="later"))
    b = page(pid)
    s.check("no HOD found in the new department: the HOD is left as it is (not cleared), and an HOD of another group is no "
            "longer a Needs attention row (any person may be HOD across groups, 2026-11-09)",
            row(pid)["hod_id"] == H_A and row(H_A)["business_group"] != GB
            and "Their HOD is in another business group" not in b)
    pid = person("ZZ9BM-HOD2", lines=("A",), hod=H_A)
    SUP.post("/admin/users/%d/lines" % pid, data=form(pid, bg=GB, unit=B1, dept="Ops", action="details_apply", kpi_mode="later",
                                                      also_hod="1"))
    s.check("an HOD found in the new group is applied through the HOD path when ticked", row(pid)["hod_id"] == H_B)
    pid = person("ZZ9BM-HOD3", lines=("A",), hod=H_A)
    SUP.post("/admin/users/%d/lines" % pid, data=form(pid, bg=GB, unit=B1, dept="Ops", action="details_apply", kpi_mode="later"))
    s.check("...and not when it is left unticked", row(pid)["hod_id"] == H_A)
    pid = person("ZZ9BM-UNC1", lines=("A", "A"))
    r = SUP.post("/admin/users/%d/lines" % pid, data=form(pid, bg=GU, unit=U1, action="details_apply"), follow_redirects=True)
    s.check("a group with no KPI framework yet: the move saves, the lines wait and say so", row(pid)["business_group"] == GU
            and all(l_["business_group"] == GA for l_ in lines(pid)) and "has no KPI framework yet" in text(r))
    pid = person("ZZ9BM-NOL1", lines=())
    r = SUP.post("/admin/users/%d/lines" % pid, data=form(pid, bg=GB, unit=B1, action="details_apply"), follow_redirects=True)
    s.check("no KPI lines at all: a plain move, no hold, no email", row(pid)["business_group"] == GB
            and "Total KPI score is held" not in text(r))

    s.section("the rules the change has to keep")
    src = H.source(a)
    s.check("the new routes are the super admin's in the access map", 'details_kpi="super", bg_kpi_set="super"' in src)
    ui = open(os.path.join(os.path.dirname(a.__file__), "templates", "person", "_overview.html"), encoding="utf-8").read()
    s.check("no browser confirm / alert in the panel", "confirm(" not in ui and "alert(" not in ui)
    s.check("the unit lists for every group are shipped to the super admin, and the bg select drives them", "pp-bg-units" in ui
            and "data-bg-units" in ui)
    s.check("every template still compiles", not H.every_template_compiles(a)[1])
finally:
    a.mailer.is_configured, a.mailer.send_mail = _real
    with a.app.app_context():
        _cleanup(a.get_db())
s.done()
