"""The Early Year cycle (Chris, 2026-10-15: "rename to midyear (after kpi setting to midyear review) and yearend (after
midyear review to year end review), and also our new early year cycle (on kpi setting after year end closes)").

An Early Year is half 0 with kind 'early_year': KPI setting and its approval only. Its agreed KPIs carry into that
year's Mid-Year when HR starts it.

What this suite holds (all on a COPY of the suite database, because starting a cycle archives the active one):
  * the Start form offers the type and the KPI carry-in; an Early Year can't carry KPIs in
  * an Early Year starts with Performance and the check-in on, the rest off, no 360 panels, and only the two KPI
    setting window cells
  * the person's review is KPI setting only: /review lands on the setting chat, the journey sends them back
  * the dashboard: a KPI-setting panel, the rail closing into the Mid-Year (no calibration, no results), Where you
    stand reads their KPIs, the history never lists an Early Year
  * an approver sees their people's KPIs waiting, with a navy (not AI) button to the approval page; no leader views,
    no Team card
  * the Mid-Year carries the agreed lines in: approved only, people taking part only, a moderator who left replaced by
    the line manager, no results
  * Edit cycle switches the type (half 0 is not "not set"); the SQL predicate keeps a cycle with no half
"""
import os
import shutil
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Early Year -- a KPI-setting cycle whose agreed KPIs carry into the Mid-Year")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _bg, _emp = H.actors(a)

tmp = tempfile.mkdtemp(prefix="onehr-tests-earlyyear-")
real = a.DB_PATH
cp = os.path.join(tmp, "copy.db")
src = sqlite3.connect(real)
dst = sqlite3.connect(cp)
src.backup(dst)
src.close()
dst.close()
a.DB_PATH = cp
assert "onehr-tests" in a.DB_PATH


def q(sql, args=()):
    c = sqlite3.connect(cp)
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def do(sql, args=()):
    c = sqlite3.connect(cp)
    try:
        c.execute(sql, args)
        c.commit()
    finally:
        c.close()


try:
    with a.app.app_context():
        db = a.get_db()
        base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
        cols = [c for c in base.keys() if c != "id"]
        for eid, mgr in (("ZZEY-MGR", None), ("ZZEY-EMP", "ZZEY-MGR"), ("ZZEY-GONE", "ZZEY-MGR"),
                         ("ZZEY-MTX", None), ("ZZEY-EMP2", "ZZEY-MGR")):
            v = dict(base, username=eid, employee_id=eid, full_name="Person " + eid[5:], email=None, hod_id=None,
                     manager_id=None, left_at=None, role="user", admin_bg=None, years_of_service=3, job_grade=14)
            db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                       [v[c] for c in cols])
        ID = {r[0]: r[1] for r in db.execute("SELECT employee_id, id FROM users WHERE employee_id LIKE 'ZZEY-%'")}
        for e in ("ZZEY-EMP", "ZZEY-GONE", "ZZEY-EMP2"):   # the manager is their HOD too: a Dept view at Year-End
            db.execute("UPDATE users SET manager_id=?, hod_id=? WHERE id=?", (ID["ZZEY-MGR"], ID["ZZEY-MGR"], ID[e]))
        # a 2027 plan (written at the 2026 Year-End): a row in the record for the Early Year, were it not left out
        cur = db.execute("INSERT INTO pm_idp(plan_year, subject_id) VALUES (2027, ?)", (ID["ZZEY-EMP"],))
        db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, action) VALUES (?, 1, 'ZZEY area', 'ZZEY action')",
                   (cur.lastrowid,))
        db.commit()
        CID0 = a.active_cycle_id(db)

    C = H.client_as(a, SU["id"])
    body = C.get("/admin/cycles").get_data(as_text=True)
    s.section("The Start form")
    s.check("offers the cycle type with Early Year", 'id="cyc-type"' in body and '<option value="0"' in body
            and "Early Year</option>" in body)
    s.check("offers where KPIs carry in from", 'name="kpi_source"' in body)

    s.section("Starting an Early Year")
    r = C.post("/admin/cycles", data={"action": "create", "csrf_token": "tok", "name": "ZZEY 2027 Early Year",
                                      "code": "ZZEY-EY", "confirm_freeze": "1", "source": "clone:%d" % CID0,
                                      "year": "2027", "half": "0", "kpi_source": "carry:%d" % CID0})
    s.check("an Early Year that would carry KPIs in is refused", not q("SELECT 1 FROM cycles WHERE code='ZZEY-EY'"))
    r = C.post("/admin/cycles", data={"action": "create", "csrf_token": "tok", "name": "ZZEY 2027 Early Year",
                                      "code": "ZZEY-EY", "confirm_freeze": "1", "source": "clone:%d" % CID0,
                                      "year": "2027", "half": "0", "starts_on": "2026-10-01T09:00",
                                      "ends_on": "2027-03-31T18:00"})
    row = q("SELECT id, half, kind, is_active, no_potential FROM cycles WHERE code='ZZEY-EY'")
    s.check("started: half 0, kind early_year, active, no potential band", row and row[0][1:] == (0, "early_year", 1, 1),
            row)
    EY = row[0][0] if row else None
    mods = dict(q("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (EY,)))
    s.check("Performance and the check-in on, everything else off",
            mods.get("pm") == 1 and mods.get("review") == 1
            and all(mods.get(k) == 0 for k in ("tm", "idp", "calibration", "evidence")), mods)
    s.check("no 360 panels carried in, though the form said clone",
            q("SELECT COUNT(*) FROM assignments WHERE cycle_id=?", (EY,))[0][0] == 0)
    with a.app.test_request_context("/"):
        db = a.get_db()
        cyc = db.execute("SELECT * FROM cycles WHERE id=?", (EY,)).fetchone()
        s.check("its window cells are KPI setting and its approval only",
                a._cycle_cells_used(cyc) == ["pm_setting", "pm_setting_approve"], a._cycle_cells_used(cyc))
        s.check("it reads as an Early Year, (2027, 0)", a.cycle_row_is_early_year(cyc)
                and a._cycle_year_half(cyc) == (2027, 0))
        s.check("no rating record is written for it", a._rating_record_refresh(db, EY, [base["id"]], "test") == 0
                and db.execute("SELECT COUNT(*) FROM rating_records WHERE cycle_id=?", (EY,)).fetchone()[0] == 0)

    s.section("The person's review is KPI setting only")
    E = H.client_as(a, ID["ZZEY-EMP"])
    # a part opens on its start date (2026-10-19): until HR sets KPI setting's, there is nothing to open
    r = E.get("/review")
    s.check("before KPI setting has a start date, /review goes to the dashboard", r.status_code == 302
            and r.headers["Location"].rstrip("/").endswith("/dashboard"), (r.status_code, r.headers.get("Location")))
    for cell in ("pm_setting", "pm_setting_approve"):
        C.post("/admin/windows", data={"csrf_token": "tok", "cycle": str(EY), "action": "open_now:" + cell})
    with a.app.test_request_context("/"):
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (ID["ZZEY-EMP"],)).fetchone()
        st = a.review_state(db, u)
        keys = [x["key"] for x in st["stages"]]
        s.check("their stages are KPI setting alone", keys == ["agree"], keys)
        s.check("...and it is open", st["stages"][0]["state"] == a.REVIEW_STATE_OPEN)
    r = E.get("/review")
    s.check("/review lands on the setting chat", r.status_code == 302 and "/review/setting" in r.headers["Location"],
            (r.status_code, r.headers.get("Location")))
    r = E.get("/review/journey")
    s.check("the journey sends them back to /review", r.status_code == 302
            and r.headers["Location"].rstrip("/").endswith("/review"), r.headers.get("Location"))

    def dash(eid):
        with a.app.test_request_context("/"):
            db = a.get_db()
            u = db.execute("SELECT * FROM users WHERE id=?", (ID[eid],)).fetchone()
            ctx = a._dash_context(db, u)
            return ctx, a._journey_leader_views(db, u)

    s.section("The dashboard in an Early Year")
    ctx, _lv = dash("ZZEY-EMP")
    P = ctx["panel"] or {}
    s.check("running, with a KPI-setting panel", ctx["mode"] == "running" and P.get("early_year") is True, ctx["mode"])
    s.check("titled 'Your 2027 KPI setting', its button opens the setting chat",
            P.get("label") == "Your 2027 KPI setting" and P.get("button") == "Start KPI setting with AI"
            and P.get("url", "").endswith("/review/setting"), (P.get("label"), P.get("button"), P.get("url")))
    steps = (ctx["rail"] or {}).get("steps") or []
    names = [x["name"] for x in steps]
    s.check("the rail: KPI setting (to the setting chat), then the Mid-Year it carries into",
            names == ["KPI setting", "Mid-Year check-in"] and steps[0]["url"].endswith("/review/setting"), names)
    s.check("...no calibration and no results step", not ({"Calibration", "Results released"} & set(names)))
    s.check("...the Mid-Year step isn't counted as one of this cycle's", ctx["rail"]["total"] == 1)
    acts = ctx["here"]["acts"]
    s.check("You are here: one act, tagged Your KPI setting", len(acts) == 1 and acts[0]["tag"] == "Your KPI setting")
    keys = [x["key"] for x in ctx["standing"]]
    s.check("Where you stand reads their KPIs, not a performance rating or a 360", "kpis" in keys
            and "performance" not in keys and "f360" not in keys, keys)
    s.check("...'Not set yet'", next(x for x in ctx["standing"] if x["key"] == "kpis")["pending"] == "Not set yet")
    s.check("the history never lists the Early Year", EY not in [r_.get("cycle_id") for r_ in ctx["record_all"]])
    html = E.get("/dashboard").get_data(as_text=True)
    s.check("the page shows Where you stand, without 'This cycle in detail' (no result to detail)",
            'id="od-st-h"' in html and 'data-record="current"' not in html)

    s.section("Proposed: with the approver")
    with a.app.app_context():
        db = a.get_db()
        bg = db.execute("SELECT business_group FROM users WHERE id=?", (ID["ZZEY-EMP"],)).fetchone()[0]
        TID = {}
        for eid, kpi in (("ZZEY-EMP", "ZZEY Sales"), ("ZZEY-EMP", "ZZEY Margin"), ("ZZEY-GONE", "ZZEY Sales"),
                         ("ZZEY-EMP2", "ZZEY Sales")):
            cur = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, "
                             "rate2, rate3, rate4, rate5, business_group, status) VALUES (?,?,?,50,'more',1,2,3,4,5,?,"
                             "'proposed')", (EY, ID[eid], kpi, bg))
            TID[(eid, kpi)] = cur.lastrowid
            # ZZEY-EMP's Margin goes to a matrix manager; the rest to the line manager
            ap = ID["ZZEY-MTX"] if kpi == "ZZEY Margin" else ID["ZZEY-MGR"]
            db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)",
                       (cur.lastrowid, ap))
        db.commit()
    ctx, _lv = dash("ZZEY-EMP")
    s.check("the person's panel: with the approver, no button", (ctx["panel"]["title"] or "").startswith(
        "Your KPIs are with") and ctx["panel"]["button"] is None, ctx["panel"]["title"])
    ctx, lv = dash("ZZEY-MGR")
    ap = ctx["panel"].get("approvals") or {}
    s.check("the approver: 3 people waiting", ap.get("waiting") == 3, ap)
    act = next((x for x in ctx["here"]["acts"] if x["button"] == "Review their KPIs"), None)
    s.check("You are here: 'Review their KPIs', a navy button to the approval page",
            act and act.get("ai") is False and act["url"].endswith("/performance/setting/review"), act)
    step = next((x for x in ctx["rail"]["steps"] if x["name"] == "Approve their KPIs"), None)
    s.check("the rail: Approve their KPIs, their turn", step and step["state"] == "turn", step)
    s.check("no leader views and no Team card in an Early Year", lv == [] and ctx["team"] is None, (lv, ctx["team"]))
    # the guard itself: with an HOD scope that would hold people (the scope readers stubbed to say so), still none
    _scope = (a._journey_calib_scope, a._pot_calib_scope)
    a._journey_calib_scope = a._pot_calib_scope = lambda *x, **k: [1]
    try:
        _c, lv_on = dash("ZZEY-MGR")
    finally:
        a._journey_calib_scope, a._pot_calib_scope = _scope
    s.check("...no Dept view for the HOD even where their department review would have people", lv_on == [], lv_on)
    html = H.client_as(a, ID["ZZEY-MGR"]).get("/dashboard").get_data(as_text=True)
    s.check("the page renders the approval as a navy link, not AI red",
            'class="od-btn-nv' in html and ">Review their KPIs</a>" in html)

    s.section("Approved: agreed")
    do("UPDATE pm_kpi_targets SET status='approved' WHERE cycle_id=?", (EY,))
    ctx, _lv = dash("ZZEY-EMP")
    s.check("the person's panel: agreed, carries into the Mid-Year", ctx["panel"]["title"] == "Your KPIs are agreed"
            and ctx["here"]["done"] == "Your KPIs are agreed", (ctx["panel"]["title"], ctx["here"]["done"]))
    s.check("Where you stand: 2 agreed", next(x for x in ctx["standing"] if x["key"] == "kpis")["text"] == "2 agreed")

    s.section("The Mid-Year carries the agreed KPIs in")
    do("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, status) "
       "VALUES (?,?,'ZZEY Draft',10,'more',?,'draft')", (EY, ID["ZZEY-EMP2"], bg))   # never agreed
    do("UPDATE users SET left_at='2026-10-10' WHERE id=?", (ID["ZZEY-GONE"],))       # a leaver
    do("UPDATE users SET left_at='2026-10-10' WHERE id=?", (ID["ZZEY-MTX"],))        # a moderator who left
    body = C.get("/admin/cycles").get_data(as_text=True)
    s.check("the form offers the Early Year to carry from", 'value="carry:%d" data-early="1"' % EY in body)
    r = C.post("/admin/cycles", data={"action": "create", "csrf_token": "tok", "name": "ZZEY 2027 Mid-Year",
                                      "code": "ZZEY-MY", "confirm_freeze": "1", "source": "empty", "year": "2027",
                                      "half": "1", "kpi_source": "carry:%d" % EY, "starts_on": "2026-10-02T09:00"})
    my = q("SELECT id, half, kind FROM cycles WHERE code='ZZEY-MY'")
    s.check("the Mid-Year started, kind mid_year", my and my[0][1:] == (1, "mid_year"), my)
    MY = my[0][0] if my else None
    s.check("...with every module closed until HR opens it (2026-10-18)", my and not any(
        v for (v,) in q("SELECT active FROM cycle_modules WHERE cycle_id=?", (MY,))))
    # HR opens the Mid-Year's parts, as they now do after Start (a new cycle starts with its modules closed)
    C.post("/admin/cycles", data={"action": "set_modules", "csrf_token": "tok", "cycle_id": str(MY),
                                  "module": ["pm", "tm", "review", "evidence"]})
    lines = q("SELECT u.employee_id, t.kpi_name, t.status FROM pm_kpi_targets t JOIN users u ON u.id=t.subject_id "
              "WHERE t.cycle_id=? AND u.employee_id LIKE 'ZZEY-%' ORDER BY 1, 2", (MY,))
    s.check("the agreed lines of people taking part carried in, approved; not the draft, not the leaver's",
            lines == [("ZZEY-EMP", "ZZEY Margin", "approved"), ("ZZEY-EMP", "ZZEY Sales", "approved"),
                      ("ZZEY-EMP2", "ZZEY Sales", "approved")], lines)
    chain = dict(q("SELECT t.kpi_name, a.approver_id FROM pm_kpi_targets t JOIN pm_kpi_target_approvers a "
                   "ON a.kpi_target_id=t.id WHERE t.cycle_id=? AND t.subject_id=?", (MY, ID["ZZEY-EMP"])))
    s.check("the moderator who left is replaced by the line manager; the line manager's stays",
            chain == {"ZZEY Margin": ID["ZZEY-MGR"], "ZZEY Sales": ID["ZZEY-MGR"]}, chain)
    s.check("no results came with them", q("SELECT COUNT(*) FROM pm_kpi_results r JOIN pm_kpi_targets t ON "
                                           "t.id=r.kpi_target_id WHERE t.cycle_id=?", (MY,))[0][0] == 0)
    s.check("the Early Year's own lines are untouched",
            q("SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=?", (EY,))[0][0] == 5)
    with a.app.test_request_context("/"):
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (ID["ZZEY-EMP"],)).fetchone()
        rows = a.dash_record(db, u)
        s.check("archived now, the Early Year still never reaches the person's history",
                rows is not None and EY not in [r_.get("cycle_id") or r_.get("period_id") for r_ in rows]
                and not any("Early Year" in (r_.get("name") or "") for r_ in rows),
                [r_.get("name") for r_ in rows])
    s.check("the carry is in the audit log", q("SELECT COUNT(*) FROM activity_log WHERE action='cycle' AND detail LIKE "
                                               "'Started cycle ZZEY 2027 Mid-Year%carried%agreed KPI%'")[0][0] == 1)

    s.section("Outside an Early Year there is no KPI setting (Chris, 2026-10-15: retire the Year-End's)")
    do("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, status) "
       "VALUES (?,?,'ZZEY MY Draft',10,'more',?,'draft')", (MY, ID["ZZEY-EMP"], bg))   # a leftover draft
    with a.app.test_request_context("/"):
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (ID["ZZEY-EMP"],)).fetchone()
        ctx_s = a._pm_setting_context(db, u)
        s.check("the setting page reads only, saying where KPI setting runs", ctx_s["editable"] is False
                and a._pm_setting_shut_reason(ctx_s) == a._KPI_SETTING_ELSEWHERE, (ctx_s["editable"],))
        s.check("the review has no KPI-setting stage", "agree" not in [x["key"] for x in a.review_state(db, u)["stages"]])
        s.check("Set my KPIs is not offered", a._pm_entry_flags(db, u, MY)["setting"] is False)
        s.check("the classic task list has no 'Finish setting your KPIs'",
                "kpi_set" not in [t_.get("key") for t_ in (a.dash_tasks(db, u) or [])])
        myrow = db.execute("SELECT * FROM cycles WHERE id=?", (MY,)).fetchone()
        s.check("the calendar marks both setting parts unused, at Mid-Year and at Year-End",
                not ({"pm_setting", "pm_setting_approve"} & set(a._cycle_cells_used(myrow)))
                and not ({"pm_setting", "pm_setting_approve"} & set(a._cycle_cells_used(dict(myrow, half=2, kind="year_end")))))
    E2 = H.client_as(a, ID["ZZEY-EMP"])
    r = E2.post("/performance/setting/draft-ai", data={"csrf_token": "tok"})
    s.check("'Suggest a scorecard with AI' is refused with the sentence", r.status_code == 409
            and (r.get_json() or {}).get("error") == a._KPI_SETTING_ELSEWHERE, (r.status_code, r.get_json()))
    r = E2.post("/performance/setting/autosave", data={"csrf_token": "tok", "action": "add"},
                headers={"Sec-Fetch-Mode": "cors"})
    s.check("a setting write is held by the window gate", r.status_code == 409
            and (r.get_json() or {}).get("error") == a._KPI_SETTING_ELSEWHERE, (r.status_code, r.get_json()))
    do("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, status) "
       "VALUES (?,?,'ZZEY MY Proposed',10,'more',?,'proposed')", (MY, ID["ZZEY-EMP2"], bg))
    pid_ = q("SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND kpi_name='ZZEY MY Proposed'", (MY,))[0][0]
    do("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (pid_, ID["ZZEY-MGR"]))
    r = H.client_as(a, ID["ZZEY-MGR"]).post("/performance/setting/review/%d" % ID["ZZEY-EMP2"],
                                             data={"csrf_token": "tok", "action": "approve"},
                                             headers={"Sec-Fetch-Mode": "cors"})
    s.check("an approver can't approve a leftover proposal: the window gate holds it, with the sentence",
            r.status_code == 409 and (r.get_json() or {}).get("error") == a._KPI_SETTING_ELSEWHERE
            and q("SELECT status FROM pm_kpi_targets WHERE id=?", (pid_,))[0][0] == "proposed",
            (r.status_code, r.get_json(silent=True)))
    r = E2.get("/review/setting")
    s.check("an old link to the setting chat goes to /review", r.status_code == 302
            and r.headers["Location"].rstrip("/").endswith("/review"), (r.status_code, r.headers.get("Location")))

    s.section("Edit cycle switches the type")
    r = C.post("/admin/cycles", data={"action": "edit_cycle", "csrf_token": "tok", "cycle_id": MY,
                                      "name": "ZZEY 2027 Mid-Year", "code": "ZZEY-MY", "year": "2027", "half": "0",
                                      "starts_on": "2026-10-02T09:00"})
    s.check("Mid-Year -> Early Year: half 0, kind follows, no potential band",
            q("SELECT half, kind, no_potential FROM cycles WHERE id=?", (MY,)) == [(0, "early_year", 1)])
    s.check("...logged by name", q("SELECT COUNT(*) FROM activity_log WHERE action='cycle' AND detail LIKE "
                                   "'Edited ZZEY 2027 Mid-Year: half Mid-Year -> Early Year%'")[0][0] == 1)
    do("UPDATE cycles SET half=NULL, kind=NULL WHERE id=?", (MY,))
    r = C.post("/admin/cycles", data={"action": "edit_cycle", "csrf_token": "tok", "cycle_id": MY,
                                      "name": "ZZEY 2027 Mid-Year", "code": "ZZEY-MY", "year": "2027", "half": "0",
                                      "starts_on": "2026-10-02T09:00"})
    s.check("not set -> Early Year is a change (half 0 isn't 'not set')",
            q("SELECT half, kind FROM cycles WHERE id=?", (MY,)) == [(0, "early_year")])

    s.section("The SQL predicate")
    do("UPDATE cycles SET half=NULL, kind=NULL WHERE id=?", (MY,))
    with a.app.app_context():
        db = a.get_db()
        py = {c["id"] for c in db.execute("SELECT * FROM cycles") if not a.cycle_row_is_early_year(c)}
        sql = {r[0] for r in db.execute("SELECT id FROM cycles c WHERE NOT %s" % a.early_year_sql("c"))}
        s.check("NOT early_year_sql keeps exactly the cycles the Python rule keeps, a cycle with no half included",
                py == sql and MY in sql and EY not in sql, (sorted(py), sorted(sql)))
finally:
    a.DB_PATH = real
    shutil.rmtree(tmp, ignore_errors=True)

sys.exit(s.done())
