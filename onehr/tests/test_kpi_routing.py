"""KPI routing: one moderator per KPI line, then the leaders in turn (Chris, 2026-10-10).

"The approver flow should be fixed in the order employee to LM (one way), then goes to HOD for dept review, BUCEO for
calibration, and lastly BGCEO for talent box calibration. For the matrix manager case, it would be applied at KPI
level, said if person A carries 5 KPIs, first 3 KPIs are routed to LM for moderation, while the last 2 KPIs go to the
matrix manager for approval."

So the KPI import carries one "Matrix manager ID" column (blank = the line manager) in place of Approver 1/2/3, every
chain it writes is one step, the employee's own proposal goes to the line manager (keeping a matrix manager the import
set), department approver defaults are no longer read, each moderator sees and acts on only their own KPIs, the person
is final only once every KPI is moderated, and Fill BU KPI fills one unit at a time. Everything here is synthetic
(ZZKR-*) and is removed at the end.
"""
import io
import re
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("KPI routing -- one moderator per KPI, a matrix manager per KPI, a unit at a time")

BG, CO1, CO2 = "ZZKR BG", "ZZKR CO1", "ZZKR CO2"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZKR-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM pm_department_approver_defaults WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.execute("DELETE FROM activity_log WHERE action IN ('pm_kpi_import','pm_bu_fill') AND id > ?", (LOG0,))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    PER = dict(a.active_pm_period(db))
    CID = PER["id"]
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    _cleanup(db)
    _mods = [tuple(r) for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))]
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','pm')", (CID,))
    _win = [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=? AND cell='pm_approve'", (CID,))]
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_approve'", (CID,))   # open while we test
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, co=CO1, mgr=None, left=None, role="user", admin_bg=None):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None,
                 manager_id=mgr, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=co,
                 department="ZZKR Dept", years_of_service=3, confirmation_date=None, left_at=left, is_demo=0,
                 role=role, admin_bg=admin_bg)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    LM = mk("ZZKR-LM", "ZZ KR Linemanager")
    MX = mk("ZZKR-MX", "ZZ KR Matrixmanager", co=CO2)
    A = mk("ZZKR-A", "ZZ KR Alpha", mgr=LM)
    B = mk("ZZKR-B", "ZZ KR Bravo", co=CO2, mgr=LM)
    C = mk("ZZKR-C", "ZZ KR Charlie")                                  # no line manager
    GONE = mk("ZZKR-GONE", "ZZ KR Leaver", left="2026-01-01")
    BUADM = mk("ZZKR-ADM", "ZZ KR Unitadmin", role="admin", admin_bg=BG)
    db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (BUADM, CO1))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (BG,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?)", (BG, CO1, BG, CO2))
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def u(uid):
    return ctx(lambda d: dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


def tid(sid, name):
    r = H.rows(a, "SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? AND kpi_name=?", (CID, sid, name))
    return r[0][0] if r else None


def chain(sid, name):
    return [r[0] for r in H.rows(a, "SELECT approver_id FROM pm_kpi_target_approvers WHERE kpi_target_id=? "
                                    "ORDER BY seq", (tid(sid, name),))]


HEAD = "Employee ID,KPI,Weightage,Method,Rate 1,Rate 2,Rate 3,Rate 4,Rate 5,Matrix manager ID\n"


def line(eid, kpi, w, mm=""):
    return "%s,%s,%s,More,80,90,100,110,120,%s\n" % (eid, kpi, w, mm)


sup = H.client_as(a, SUP)


def upload(text, preview=False, client=None):
    data = {"csrf_token": "tok", "file": (io.BytesIO(text.encode()), "kpi.csv")}
    if not preview:   # all four steps (the one-shot post is gone, 1a-01)
        return H.import_steps(client or sup, "/admin/performance/import", data)
    data["preview"] = "1"
    return (client or sup).post("/admin/performance/import", data=data, content_type="multipart/form-data",
                                follow_redirects=True)


try:
    # -----------------------------------------------------------------------
    s.section("the template and the page")
    r = sup.get("/admin/performance/import/template.csv")
    head = H.as_csv_text(r).splitlines()[0]
    s.check("the template's last column is Matrix manager ID, and the Approver columns are gone",
            r.status_code == 200 and head.endswith("Matrix manager ID") and "Approver" not in head, head)
    tpl = H.as_csv_text(r)
    ids_ = [ln.split(",")[0] for ln in tpl.splitlines()[1:] if ln.strip()]
    s.check("the template's rows are EXAMPLE- placeholders, never a real person's Employee ID (2026-10-14)",
            ids_ and all(x.startswith("EXAMPLE-") for x in ids_), ids_)
    n_before = H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets")
    b_ = upload(tpl).get_data(as_text=True)
    s.check("the template uploaded unchanged imports nothing, and says it is the example row",
            H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets") == n_before and "example row" in b_)
    body = sup.get("/admin/performance/import").get_data(as_text=True)
    s.check("the page explains one moderator per KPI and the new column",
            "One moderator per KPI" in body and "Matrix manager ID" in body and "Approver 1/2/3" in body)

    # -----------------------------------------------------------------------
    s.section("a file using the old Approver columns")
    old = ("Employee ID,KPI,Weightage,Method,Rate 1,Rate 2,Rate 3,Rate 4,Rate 5,Approver 1 Employee ID,"
           "Approver 2 Employee ID\nZZKR-A,ZZKR Old,100,More,80,90,100,110,120,ZZKR-LM,ZZKR-MX\n")
    r = upload(old)
    b = r.get_data(as_text=True)
    s.check("is refused with a note on what changed, and nothing is written",
            "still uses the old Approver 1/2/3 columns" in b and "Matrix manager ID" in b
            and tid(A, "ZZKR Old") is None, r.status_code)
    blank_old = ("Employee ID,KPI,Weightage,Method,Rate 1,Rate 2,Rate 3,Rate 4,Rate 5,Approver 1 Employee ID\n"
                 "ZZKR-A,ZZKR Old,100,More,80,90,100,110,120,\n")
    r = upload(blank_old)
    s.check("...but with those columns left blank it imports, to the line manager",
            tid(A, "ZZKR Old") is not None and chain(A, "ZZKR Old") == [LM], chain(A, "ZZKR Old"))
    ctx(lambda d: (d.execute("DELETE FROM pm_kpi_targets WHERE subject_id=? AND kpi_name='ZZKR Old'", (A,)),
                   d.commit()))

    # -----------------------------------------------------------------------
    s.section("person A: three KPIs to the line manager, two to the matrix manager")
    FILE = (HEAD + line("ZZKR-A", "ZZKR KPI 1", 30) + line("ZZKR-A", "ZZKR KPI 2", 20)
            + line("ZZKR-A", "ZZKR KPI 3", 10) + line("ZZKR-A", "ZZKR KPI 4", 25, "ZZKR-MX")
            + line("ZZKR-A", "ZZKR KPI 5", 15, "ZZKR-MX")
            + line("ZZKR-B", "ZZKR KPI 1", 100, "ZZKR-LM")                 # the LM's own ID = a blank one
            + line("ZZKR-C", "ZZKR KPI 1", 100))                           # no line manager at all
    r = upload(FILE, preview=True)   # the four steps (2026-10-26): kept, checked; who moderates what is step 3
    tok = (re.search(r'name="token" value="([0-9a-f]{32})"', r.get_data(as_text=True)) or [None, ""])[1]
    r = sup.post("/admin/performance/import", data={"csrf_token": "tok", "token": tok, "action": "quality_ok",
                                                    "ack": "1"}, follow_redirects=True)
    b = r.get_data(as_text=True)
    s.check("the changes step says who moderates what, per person",
            r.status_code == 200 and "Who moderates what" in b and "3 to the line manager" in b
            and "2 to ZZ KR Matrixmanager" in b and "go to a matrix manager" in b, r.status_code)
    s.check("...people with no split are one count, and a line with no moderator is named",
            "go to each person's line manager" in b and "have no moderator and wait on the Exceptions page" in b)
    s.check("...and the preview writes nothing", tid(A, "ZZKR KPI 1") is None)
    r = upload(FILE)
    b = r.get_data(as_text=True)
    s.check("the import says how many go to a matrix manager", "2 KPI line(s) go to a matrix manager" in b)
    s.check("KPI 1-3 go to the line manager alone",
            all(chain(A, "ZZKR KPI %d" % i) == [LM] for i in (1, 2, 3)),
            [chain(A, "ZZKR KPI %d" % i) for i in (1, 2, 3)])
    s.check("KPI 4-5 go to the matrix manager alone",
            all(chain(A, "ZZKR KPI %d" % i) == [MX] for i in (4, 5)),
            [chain(A, "ZZKR KPI %d" % i) for i in (4, 5)])
    s.check("the line manager's own ID in the column routes to them, once", chain(B, "ZZKR KPI 1") == [LM])
    s.check("a person with no line manager imports with no moderator (the Exceptions page)",
            tid(C, "ZZKR KPI 1") is not None and chain(C, "ZZKR KPI 1") == [])
    s.check("every chain the import wrote is one step",
            H.one(a, "SELECT COALESCE(MAX(ap.seq),0) FROM pm_kpi_target_approvers ap JOIN pm_kpi_targets t "
                     "ON t.id=ap.kpi_target_id JOIN users u ON u.id=t.subject_id "
                     "WHERE u.employee_id LIKE 'ZZKR-%'") == 1)
    s.check("the activity log records the matrix split",
            H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_kpi_import' AND user_id=? "
                     "AND detail LIKE '%2 to a matrix manager%'", (SUP,)) >= 1)

    # -----------------------------------------------------------------------
    s.section("rows that are refused (and the whole file with them)")
    for label, mm in (("an unknown matrix manager ID", "ZZKR-NOBODY"), ("a matrix manager who has left", "ZZKR-GONE"),
                      ("a person named as their own matrix manager", "ZZKR-A")):
        r = upload(HEAD + line("ZZKR-B", "ZZKR KPI 9", 50) + line("ZZKR-A", "ZZKR KPI 9", 50, mm))
        b = r.get_data(as_text=True)
        s.check(label + " rejects the file, so nothing is written",
                "A matrix manager OneHR can&#39;t use" in b and "Fix the rows that can" in b   # step 2 names it; nothing goes on
                and tid(B, "ZZKR KPI 9") is None and tid(A, "ZZKR KPI 9") is None)

    # -----------------------------------------------------------------------
    s.section("an old two-step chain, and department defaults")
    def two_step(d):
        t1 = tid(A, "ZZKR KPI 1")
        d.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,2,?)", (t1, MX))
        d.commit()
    ctx(two_step)
    s.check("(set up: KPI 1 has a second step)", chain(A, "ZZKR KPI 1") == [LM, MX])
    upload(HEAD + line("ZZKR-A", "ZZKR KPI 1", 30))
    s.check("re-importing it leaves one step, the line manager", chain(A, "ZZKR KPI 1") == [LM],
            chain(A, "ZZKR KPI 1"))
    ctx(lambda d: (d.execute("INSERT INTO pm_department_approver_defaults(business_group, department, seq, "
                             "approver_id) VALUES (?,?,1,?),(?,?,2,?)", (BG, "ZZKR Dept", MX, BG, "ZZKR Dept", LM)),
                   d.commit()))
    upload(HEAD + line("ZZKR-A", "ZZKR KPI 6", 10))
    s.check("a department default is not read by the import", chain(A, "ZZKR KPI 6") == [LM], chain(A, "ZZKR KPI 6"))
    s.check("...nor by the employee's own proposal",
            ctx(lambda d: a.pm_setting_resolve_approvers(d, u(A))) == [LM]
            and ctx(lambda d: a.pm_setting_resolve_approvers(d, u(C))) == [])
    ctx(lambda d: (d.execute("DELETE FROM pm_department_approver_defaults WHERE business_group=?", (BG,)),
                   d.execute("DELETE FROM pm_kpi_targets WHERE id=?", (tid(A, "ZZKR KPI 6"),)), d.commit()))
    src = H.code_without_docstrings(H.source(a))
    s.check("nothing in the code reads pm_department_approver_defaults any more",
            "FROM pm_department_approver_defaults" not in src)

    # -----------------------------------------------------------------------
    s.section("each moderator sees, and acts on, only their own KPIs")
    def submit(d):
        for i in range(1, 6):
            d.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)",
                      (tid(A, "ZZKR KPI %d" % i), 100, A))
        d.commit()
    ctx(submit)
    mine_lm = ctx(lambda d: [t["kpi_name"] for t in a._pm_member_previews(d, A, CID, LM)[0]])
    mine_mx = ctx(lambda d: [t["kpi_name"] for t in a._pm_member_previews(d, A, CID, MX)[0]])
    s.check("the line manager's view of A holds KPI 1-3", mine_lm == ["ZZKR KPI 1", "ZZKR KPI 2", "ZZKR KPI 3"],
            mine_lm)
    s.check("the matrix manager's view of A holds KPI 4-5 only", mine_mx == ["ZZKR KPI 4", "ZZKR KPI 5"], mine_mx)
    s.check("the matrix manager has a team (A) without being anyone's line manager",
            ctx(lambda d: a._pm_manages_anyone(d, u(MX)))
            and ctx(lambda d: a._pm_approver_subject_ids(d, u(MX), CID)) == [A])
    pm_lines = ctx(lambda d: [ln["kpi"] for ln in
                              a._journey_team_pm_data(d, u(MX), A, "ZZ KR Alpha")["lines"]])
    s.check("the AI+ team review shows the matrix manager KPI 4-5", pm_lines == ["ZZKR KPI 4", "ZZKR KPI 5"], pm_lines)

    def commit_as(uid, name):
        def go(d):
            res, err = a._pm_moderate_commit(d, u(uid), tid(A, name), "", None)
            return (err or {}).get("reason")
        return ctx(go)
    s.check("the line manager can't moderate KPI 4", commit_as(LM, "ZZKR KPI 4") == "not_actionable")
    s.check("the matrix manager can't moderate KPI 1", commit_as(MX, "ZZKR KPI 1") == "not_actionable")
    s.check("the line manager moderates KPI 1-3",
            all(commit_as(LM, "ZZKR KPI %d" % i) is None for i in (1, 2, 3)))
    s.check("...and A is not final yet: two KPIs wait on the matrix manager",
            ctx(lambda d: a.pm_period_locked_for(d, CID, A)) is False)
    s.check("the matrix manager moderates KPI 4-5", all(commit_as(MX, "ZZKR KPI %d" % i) is None for i in (4, 5)))
    s.check("...and now A is final, ready for the HOD", ctx(lambda d: a.pm_period_locked_for(d, CID, A)) is True)
    s.check("one way: a moderated KPI can't be moderated again", commit_as(MX, "ZZKR KPI 4") == "not_actionable")

    # -----------------------------------------------------------------------
    s.section("the employee's proposal keeps a matrix manager the import set")
    def proposal(d):
        for name, w, ch in (("ZZKR Set 1", 50, [MX]), ("ZZKR Set 2", 30, []), ("ZZKR Set 3", 20, [MX, LM])):
            d.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, "
                      "rate3, rate4, rate5, business_group, company, department, status) "
                      "VALUES (?,?,?,?, 'more', 80,90,100,110,120, ?,?, 'ZZKR Dept', 'draft')",
                      (CID, B, name, w, BG, CO2))
            t = d.execute("SELECT last_insert_rowid()").fetchone()[0]
            for seq, aid in enumerate(ch, start=1):
                d.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,?,?)",
                          (t, seq, aid))
        d.commit()
        me = u(B)
        cx = a._pm_setting_context(d, me)
        return a._pm_setting_propose(d, me, cx)
    ok, errs, warn = ctx(proposal)
    s.check("(set up: B proposes three KPIs)", ok, errs)
    s.check("a KPI the import routed to the matrix manager stays with them", chain(B, "ZZKR Set 1") == [MX])
    s.check("a KPI with no chain goes to the line manager", chain(B, "ZZKR Set 2") == [LM])
    s.check("an old two-step chain becomes one step, the line manager", chain(B, "ZZKR Set 3") == [LM],
            chain(B, "ZZKR Set 3"))
    s.check("...and no 'no approver' warning when every KPI has one", warn is None, warn)

    # -----------------------------------------------------------------------
    s.section("Fill BU KPI, one unit at a time")
    def bu_lines(d):
        for sid, co in ((A, CO1), (C, CO1), (B, CO2)):
            d.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, "
                      "rate3, rate4, rate5, business_group, company, department) "
                      "VALUES (?,?, 'ZZKR Unit PBT', 10, 'more', 80,90,100,110,120, ?,?, 'ZZKR Dept')",
                      (CID, sid, BG, co))
        d.commit()
    ctx(bu_lines)
    b = sup.get("/admin/performance/bu-fill?business_group=" + BG).get_data(as_text=True)
    s.check("a BG admin picks a unit or the whole group",
            "Whole business group" in b and a.proper_name(CO1) in b and a.proper_name(CO2) in b)
    form = {"csrf_token": "tok", "business_group": BG, "kpi_name": "ZZKR Unit PBT", "actual_value": "104.2"}
    r = sup.post("/admin/performance/bu-fill", data=dict(form, company=CO1, action="calc"))
    j = r.get_json() or {}
    s.check("the calc for one unit counts that unit's people only", r.status_code == 200 and j.get("n_total") == 2
            and j.get("rows", "").count("data-bf-row") == 2, r.status_code)
    pg1 = sup.get("/admin/performance/bu-fill?business_group=%s&company=%s&kpi_name=ZZKR+Unit+PBT" % (BG, CO1)).get_data(as_text=True)
    s.check("...the page lists a KPI with lines but no setup (the name rule), selected, with 2 who get the result",
            "Who gets this result · 2" in pg1 and "ZZKR Unit PBT" in pg1)
    r = sup.post("/admin/performance/bu-fill", data=dict(form, action="calc"))
    s.check("...the whole group counts all three", (r.get_json() or {}).get("n_total") == 3)
    # a result-level edit needs the admin's reason (Chris, 2026-10-18): none, or a blank one, fills nothing
    for rs in (None, "   "):
        sup.post("/admin/performance/bu-fill", data=dict(form, company=CO1, **({"reason": rs} if rs else {})))
    s.check("filling with no reason fills nothing", H.one(a, "SELECT COUNT(*) FROM pm_kpi_results r JOIN pm_kpi_targets t "
            "ON t.id=r.kpi_target_id WHERE t.kpi_name='ZZKR Unit PBT'") == 0)
    s.check("...and the Fill box asks for one", 'data-confirm-reason=' in pg1)
    sup.post("/admin/performance/bu-fill", data=dict(form, company=CO1, reason="ZZKR audited unit figure"))
    filled = {r[0] for r in H.rows(a, "SELECT t.subject_id FROM pm_kpi_results r JOIN pm_kpi_targets t "
                                      "ON t.id=r.kpi_target_id WHERE t.kpi_name='ZZKR Unit PBT' AND r.admin_filled=1")}
    s.check("filling one unit fills its people and leaves the other unit alone", filled == {A, C}, filled)
    s.check("an empty note is stored as no note (it once saved the word 'None')", {r[0] for r in H.rows(
        a, "SELECT r.note FROM pm_kpi_results r JOIN pm_kpi_targets t ON t.id=r.kpi_target_id WHERE t.kpi_name='ZZKR Unit PBT' "
           "AND r.admin_filled=1")} == {None})
    s.check("the fill is logged with the unit and the reason",
            H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='pm_bu_fill' AND detail LIKE ? AND detail LIKE ?",
                  ("%" + BG + " / " + CO1 + "%", "%reason: ZZKR audited unit figure%")) == 1)
    bua = H.client_as(a, BUADM)
    b = bua.get("/admin/performance/bu-fill?business_group=" + BG).get_data(as_text=True)
    s.check("a BU admin sees only their own unit, and 'All your units'",
            "All your units" in b and a.proper_name(CO1) in b and a.proper_name(CO2) not in b
            and "Whole business group" not in b)
    r = bua.post("/admin/performance/bu-fill", data=dict(form, company=CO2, action="calc"))
    s.check("...and can't fill another unit", r.status_code == 403, r.status_code)
    r = bua.get("/admin/performance/bu-fill?business_group=%s&company=%s" % (BG, CO2))
    s.check("...nor open it", r.status_code == 403, r.status_code)
finally:
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        for k, act in _mods:
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (act, CID, k))
        for w in _win:
            db.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w), ",".join("?" * len(w))),
                       list(w.values()))
        db.commit()

sys.exit(s.done())
