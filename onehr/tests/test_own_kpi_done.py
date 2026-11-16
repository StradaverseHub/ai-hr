"""A person's KPI results count as SUBMITTED once every one of their OWN lines is in (product owner, 2026-11-05).

A BU-level line is a unit-wide figure Group People fills once for everyone ("Fill BU KPI", admin_filled=1): the employee
cannot enter it, so it is left out of both sides of the count. Three own lines plus one BU line, the three submitted =
complete. Someone whose lines are ALL BU-level has nothing to submit: in no "submitted" count or denominator, never
pending. One helper, pm_own_results_map, and every reader below must agree on the same people:
  the helper, Home's matrix cell and its list, Results not in yet, readiness "Results submitted", Progress' stage
  (_mod_pm_state), the employee's own dashboard card (my_pending), "left unsubmitted", the Leader progress parts.
Everything here is synthetic (ZZOK-*) and is removed at the end.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
assert "onehr-tests" in a.DB_PATH, a.DB_PATH
s = H.Suite("KPI results count as submitted once a person's own lines are in; BU lines Group People fills are left out")

BG, CO, DEPT = "ZZOK Group", "ZZOK Unit", "ZZOK Office"
BU_KPIS = ("Profit after tax (PAT)", "Business unit gross profit (GP)")
OWN_KPIS = ("ZZOK Customer satisfaction", "ZZOK Delivery on time", "ZZOK Cost per unit")


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZOK-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        tids = "SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph
        for sql in ("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (%s)" % tids,
                    "DELETE FROM pm_kpi_approvals WHERE kpi_target_id IN (%s)" % tids,
                    "DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN (%s)" % tids,
                    "DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph,
                    "DELETE FROM pm_overall_remarks WHERE subject_id IN (%s)" % ph,
                    "DELETE FROM pm_review_session WHERE subject_id IN (%s)" % ph,
                    "DELETE FROM pm_review_chat WHERE subject_id IN (%s)" % ph,
                    "DELETE FROM rating_records WHERE subject_id IN (%s)" % ph,
                    "DELETE FROM notifications WHERE user_id IN (%s)" % ph):
            db.execute(sql, ids)
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM ai_prerun_jobs WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


_orig_names_map = a._pm_bu_names_map
_orig_closed = a._behalf_part_closed
try:
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        CYC = dict(a.active_cycle(db))
        CID = CYC["id"]
        _cleanup(db)
        _mods = [tuple(r) for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=?", (CID,))]
        _wins = [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (CID,))]
        _obd = db.execute("SELECT open_by_date FROM cycles WHERE id=?", (CID,)).fetchone()[0]
        for k, on in (("review", 1), ("pm", 1), ("tm", 1), ("idp", 0)):   # every condition this suite reads, set here
            db.execute("INSERT OR IGNORE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", (CID, k, on))
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (on, CID, k))
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))   # every part open, no dates
        db.execute("UPDATE cycles SET open_by_date=0 WHERE id=?", (CID,))
        base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 "
                               "AND job_grade GLOB '[0-9]*' LIMIT 1").fetchone())
        cols = [c for c in base.keys() if c != "id"]

        def mk(tag, name, mgr=None, jg="22"):
            eid = "ZZOK-" + tag
            v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=eid.lower() + "@zzok.invalid",
                     hod_id=None, manager_id=mgr, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG,
                     company=CO, department=DEPT, job_grade=jg, years_of_service=5, confirmation_date="2020-01-01",
                     left_at=None, is_demo=0, role="user", admin_bg=None)
            db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                       [v[c] for c in cols])
            return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

        LM = mk("LM", "ZZ Ok Manager", jg="23")
        DONE = mk("DONE", "ZZ Ok Done", LM)       # 3 own lines + 1 BU line; the 3 own submitted
        PART = mk("PART", "ZZ Ok Partial", LM)    # 3 own lines + 1 BU line; 2 of the 3 own submitted
        NONE_ = mk("NONE", "ZZ Ok Nothing", LM)   # 3 own lines + 1 BU line; nothing submitted
        ALLBU = mk("ALLBU", "ZZ Ok Buonly", LM)   # two BU lines, nothing of their own
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)", (BG,))
        for k in BU_KPIS:
            db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, "
                       "method, rate1, rate2, rate3, rate4, rate5, bu_level, active) VALUES (?, '*', '*', 0, '*', ?, "
                       "'more', 80, 90, 100, 110, 120, 1, 1)", (BG, k))
        TL = {}

        def line(sid, name, w):
            t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, "
                           "rate3, rate4, rate5, business_group, company, department) VALUES (?,?,?,?,'more',80,90,100,"
                           "110,120,?,?,?)", (CID, sid, name, w, BG, CO, DEPT)).lastrowid
            db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t, LM))
            TL[(sid, name)] = t
            return t
        for sid in (DONE, PART, NONE_):
            for k in OWN_KPIS:
                line(sid, k, 25)
            line(sid, BU_KPIS[0], 25)
        line(ALLBU, BU_KPIS[0], 50)
        line(ALLBU, BU_KPIS[1], 50)

        def submit(sid, name):
            db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, admin_filled, draft) "
                       "VALUES (?,?,?,?,0,0)", (TL[(sid, name)], 100, "ZZOK own figure", sid))
        for k in OWN_KPIS:
            submit(DONE, k)
        for k in OWN_KPIS[:2]:
            submit(PART, k)
        db.commit()
        SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                         "LIMIT 1").fetchone()[0]

    def urow(uid):
        return ctx(lambda d: d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())

    def own_map(ids=None):
        return ctx(lambda d: a.pm_own_results_map(d, CID, ids))

    # ---------------------------------------------------------------- the setup is what the rule is about
    s.section("the setup: the BU line has no result, the three own lines do")
    bu_res = ctx(lambda d: d.execute("SELECT COUNT(*) FROM pm_kpi_results WHERE kpi_target_id=?",
                                     (TL[(DONE, BU_KPIS[0])],)).fetchone()[0])
    s.check("the BU line of the person who is done has NO result (Group People has not filled it yet)", bu_res == 0, bu_res)
    old = ctx(lambda d: d.execute(
        "SELECT COUNT(*), SUM(CASE WHEN r.id IS NOT NULL AND r.draft=0 THEN 1 ELSE 0 END) FROM pm_kpi_targets t "
        "LEFT JOIN pm_kpi_results r ON r.kpi_target_id=t.id WHERE t.cycle_id=? AND t.subject_id=?", (CID, DONE)).fetchone())
    s.check("the OLD rule (every line, BU included) would NOT have called them complete", old[0] != old[1], tuple(old))

    # ---------------------------------------------------------------- the helper
    s.section("the helper: pm_own_results_map")
    m = own_map([DONE, PART, NONE_, ALLBU, LM])
    s.check("3 own lines + 1 BU line, the 3 submitted: own 3 of 3, one BU line", m[DONE]["own_n"] == 3
            and m[DONE]["own_sub"] == 3 and m[DONE]["bu_n"] == 1, m.get(DONE))
    s.check("...they are 'all in'", a.pm_own_all_in(m[DONE]) and not a.pm_own_bu_only(m[DONE]))
    s.check("2 of 3 own lines: not all in", m[PART]["own_sub"] == 2 and m[PART]["own_n"] == 3
            and not a.pm_own_all_in(m[PART]), m.get(PART))
    s.check("nothing submitted: not all in", m[NONE_]["own_sub"] == 0 and not a.pm_own_all_in(m[NONE_]))
    s.check("all-BU: no own line, BU only, never 'all in'", m[ALLBU]["own_n"] == 0 and m[ALLBU]["bu_n"] == 2
            and a.pm_own_bu_only(m[ALLBU]) and not a.pm_own_all_in(m[ALLBU]), m.get(ALLBU))
    s.check("someone with no KPI line is not in the map at all", LM not in m)
    s.check("ids=None reads everyone with a line and agrees with the id-limited read",
            all(own_map().get(i) == m[i] for i in (DONE, PART, NONE_, ALLBU)))
    s.check("the latest submit time is of their own lines", m[DONE]["last"] and m[NONE_]["last"] is None)
    ap = ctx(lambda d: a.pm_own_results_map(d, CID, [DONE], approved_only=True)[DONE])
    s.check("approved_only agrees while every line is approved", ap["own_n"] == 3 and ap["own_sub"] == 3, ap)

    # falsify: with the BU map emptied (BU lines counted as own) the same person is NOT complete
    a._pm_bu_names_map = lambda db_, users, cid=None, lib=None: {u_["id"]: set() for u_ in users if u_}
    try:
        bad = own_map([DONE, ALLBU])
        s.check("FALSIFY: counting the BU line as own, the same person is no longer complete (the checks bite)",
                not a.pm_own_all_in(bad[DONE]) and bad[DONE]["own_n"] == 4 and not a.pm_own_bu_only(bad[ALLBU]), bad)
        bad_cell = ctx(lambda d: a._home_bg_matrix(d, dict(urow(SUP)), a.viewed_cycle(d)))
        r_ = next(r for r in bad_cell["rows"] if r["bg"] == BG)
        s.check("FALSIFY: Home's cell then reads 0 submitted of 4",
                r_["cells"][[c["key"] for c in bad_cell["cols"]].index("pm")]["sub"].startswith("0 of 4 "),
                r_["cells"][[c["key"] for c in bad_cell["cols"]].index("pm")]["sub"])
    finally:
        a._pm_bu_names_map = _orig_names_map

    # ---------------------------------------------------------------- Home matrix and its list
    s.section("Home: the matrix cell and the list behind it count the same people")
    mx = ctx(lambda d: a._home_bg_matrix(d, dict(urow(SUP)), a.viewed_cycle(d)))
    keys = [c["key"] for c in mx["cols"]]
    row = next((r for r in mx["rows"] if r["bg"] == BG), None)
    cell = row["cells"][keys.index("pm")] if row else {}
    s.check("the cell counts people with an own line (3), submitted = those whose own lines are all in (1)",
            cell.get("sub", "").startswith("1 of 3 ") and cell.get("pct") == 33, cell.get("sub"))

    def home_list(bg=BG):
        def f(d):
            me = dict(urow(SUP))
            return a.ADMIN_LISTS["home-cell"]["build"](d, me, CID, {"col": "pm", "bg": bg})
        return ctx(f)
    lst = home_list()
    uids = {r["uid"] for r in lst["rows"]}
    s.check("the list holds exactly those three people; the all-BU person is not listed",
            uids == {DONE, PART, NONE_}, uids)
    s.check("...its title count is the cell's own count", lst["title"].split("·")[1].strip().startswith("1 of 3 "), lst["title"])
    byid = {r["uid"]: r["cells"][0][0] for r in lst["rows"]}
    s.check("...words say own lines: all in / 2 of 3 own lines in / 0 of 3 own lines in",
            byid[DONE] == "all in" and byid[PART] == "2 of 3 own lines in" and byid[NONE_] == "0 of 3 own lines in", byid)
    s.check("...done people sort last", [r["uid"] for r in lst["rows"]][-1] == DONE)

    # ---------------------------------------------------------------- Results not in yet
    s.section("Results not in yet and readiness")
    nis = ctx(lambda d: a.ADMIN_LISTS["ready-not-scored"]["build"](d, dict(urow(SUP)), CID, {}))
    mine = {r["uid"] for r in nis["rows"] if r["eid"].startswith("ZZOK-")}
    s.check("'Results not in yet' lists the partial and the empty (and, as before, someone with no line at all); "
            "not the done, not the all-BU", {PART, NONE_} <= mine and DONE not in mine and ALLBU not in mine, mine)

    def readiness_step():
        def f(d):
            groups, _dn, _tt = a._cycle_readiness(d, dict(urow(SUP)), dict(a.active_cycle(d)))
            for g_ in groups:
                for st_ in g_["steps"]:
                    if st_["label"] == "Results submitted":
                        return st_
        return ctx(f)
    st0 = readiness_step()
    s.check("readiness has a 'Results submitted' step", st0 is not None)
    if st0:
        def base_counts():
            return ctx(lambda d: (
                d.execute("SELECT COUNT(*) FROM users u WHERE u.role!='admin' AND " + a.calibration_population_sql("u")).fetchone()[0],
                [r[0] for r in d.execute("SELECT u.id FROM users u WHERE u.role!='admin' AND "
                                         + a.calibration_population_sql("u") + " AND EXISTS (SELECT 1 FROM pm_kpi_targets t "
                                         "WHERE t.subject_id=u.id AND t.cycle_id=?)", (CID,))]))
        n_people, pop = base_counts()
        om = own_map(pop)
        s.check("...its numerator is the people whose own lines are all in (the helper's own count)",
                st0["n"] == sum(1 for i in pop if a.pm_own_all_in(om.get(i))) and om[DONE] and DONE in pop, (st0["n"], st0["of"]))
        s.check("...its denominator leaves the all-BU people out",
                st0["of"] == n_people - sum(1 for i in pop if a.pm_own_bu_only(om.get(i))) and ALLBU in pop
                and st0["of"] < n_people, (st0["of"], n_people))

    # ---------------------------------------------------------------- Progress' stage
    s.section("Progress: _mod_pm_state stages")
    users = {i: urow(i) for i in (DONE, PART, NONE_, ALLBU, LM)}
    out, err = ctx(lambda d: a._mod_pm_state(d, dict(urow(SUP)), users))
    s.check("no error", err is None, err)
    s.check("3 own + 1 BU, own 3 in: 'Results in'", out[DONE]["stage"] == "results" and out[DONE]["label"] == "Results in"
            and "3 of 3 own" in out[DONE]["detail"], out[DONE])
    s.check("2 of 3 own in: 'Targets set' (not yet complete), saying so in words",
            out[PART]["stage"] == "targets" and out[PART]["detail"] == "2 of 3 own KPI lines submitted", out[PART])
    s.check("nothing in: 'Targets set'", out[NONE_]["stage"] == "targets" and out[NONE_]["state"] == "pending", out[NONE_])
    s.check("all-BU: 'Results in' (so nothing asks them to act), 'BU KPIs only' words, never 'targets'",
            out[ALLBU]["stage"] == "results" and out[ALLBU]["state"] != "pending"
            and out[ALLBU]["detail"].startswith("BU KPIs only"), out[ALLBU])
    s.check("someone with no line is 'Not started'", out[LM]["stage"] == "not_started")
    a._pm_bu_names_map = lambda db_, users_, cid=None, lib=None: {u_["id"]: set() for u_ in users_ if u_}
    try:
        bad, _e = ctx(lambda d: a._mod_pm_state(d, dict(urow(SUP)), users))
        s.check("FALSIFY: with BU lines counted as own, the done person drops to 'Targets set'",
                bad[DONE]["stage"] == "targets", bad[DONE])
    finally:
        a._pm_bu_names_map = _orig_names_map

    # ---------------------------------------------------------------- the employee's own side
    s.section("the employee: dashboard card and 'left unsubmitted'")
    sp = {i: ctx(lambda d, i=i: a._pm_pending_split(d, urow(i), CID)) for i in (DONE, PART, NONE_, ALLBU)}
    s.check("done: my_pending 0 (BU line ignored)", sp[DONE]["my_pending"] == 0, sp[DONE])
    s.check("partial: my_pending 1; nothing in: 3", sp[PART]["my_pending"] == 1 and sp[NONE_]["my_pending"] == 3,
            (sp[PART], sp[NONE_]))
    s.check("all-BU: my_pending 0", sp[ALLBU]["my_pending"] == 0, sp[ALLBU])

    def tasks(uid):
        return ctx(lambda d: [t for t in (a.dash_tasks(d, urow(uid)) or []) if t.get("key") == "kpi"])
    s.check("done: no 'Submit your KPI results' card", not tasks(DONE), tasks(DONE))
    s.check("all-BU: no card either", not tasks(ALLBU))
    tp, tn = tasks(PART), tasks(NONE_)
    s.check("partial: the card says 2 of 3 filled in (own lines, not 4)", len(tp) == 1 and tp[0]["detail"] == "2 of 3 filled in"
            if tp and "detail" in tp[0] else len(tp) == 1 and "2 of 3" in str(tp[0]), tp)
    s.check("nothing in: 0 of 3 filled in", len(tn) == 1 and "0 of 3" in str(tn[0]), tn)
    a._behalf_part_closed = lambda *x, **k: True   # the part has closed with no pass: the question is only who counts
    try:
        left = {i: ctx(lambda d, i=i: a._mine_left_unsubmitted(d, urow(i), "pm_results")) for i in (DONE, PART, NONE_, ALLBU)}
    finally:
        a._behalf_part_closed = _orig_closed
    # (a partly submitted person reads as signed off by pm_review_locked's legacy clause: unchanged and not asserted here)
    s.check("after the close: done and all-BU are never 'left unsubmitted'; someone with nothing in is",
            left[DONE] is False and left[ALLBU] is False and left[NONE_] is True, left)

    # ---------------------------------------------------------------- Leader progress parts and the wait text
    s.section("Leader progress part and the person page's wait text")
    parts = ctx(lambda d: a.lp_person_parts(d, dict(a.active_cycle(d)), ("pm_results",)))["pm_results"]
    s.check("the part counts the three with own lines and leaves the all-BU person out",
            {DONE, PART, NONE_} <= set(parts) and ALLBU not in parts, sorted(parts))
    rows = [{"word": "Not submitted yet", "bu": False}] * 3 + [{"word": "Group People fills", "bu": True}]
    s.check("'0 of n submitted' counts own lines only",
            a._kpi_wait_text(rows, [r for r in rows]) == "Waiting: the employee · 0 of 3 submitted",
            a._kpi_wait_text(rows, rows))
finally:
    a._pm_bu_names_map = _orig_names_map
    a._behalf_part_closed = _orig_closed

    def restore(d):
        _cleanup(d)
        d.execute("DELETE FROM cycle_modules WHERE cycle_id=?", (CID,))
        for k, v in _mods:
            d.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", (CID, k, v))
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for w in _wins:
            d.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w), ",".join("?" * len(w))),
                      list(w.values()))
        d.execute("UPDATE cycles SET open_by_date=? WHERE id=?", (_obd, CID))
        d.commit()
    ctx(restore)

sys.exit(s.done())
