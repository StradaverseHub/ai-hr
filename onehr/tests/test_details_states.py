"""This cycle in detail, before it opens and after it is released (Chris, 2026-10-18: "we should allow users to go to
where you stand - details to view their KPI (with their respective targets per 5-rating or threshold/target
mechanism), and their assigned competencies there. If a module is not started, no action is available for users to
the AI+ checkin"; and "once the result is released to user, it should be treated as 'off-cycle'"; canvas "OneHR
Year-End Details States").

What this suite holds (on a COPY of the suite database, because starting a cycle archives the active one):
  * a started, never-opened cycle: the dashboard says nothing is open, every part not open yet, no way into the AI+
    check-in, and Where you stand opens Details on the KPI targets and on the competencies
  * Details then carries each KPI's targets by the group's scale (the 1-5 rating figures for Mechanism A; threshold /
    target / excellence and the group's cut-offs for B) and each competency's level now and next, with what each means
    and its abilities
  * Ask OneHR offers the two ways in, answered in code, each opening Details on its tab
  * once the person's result is released, Details is the result only: the final band, the line manager's strongest /
    to grow (titles only), no KPI line, no band along the way
"""
import os
import shutil
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("This cycle in detail -- before it opens (targets, competencies) and once released (the result only)")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _bg, _emp = H.actors(a)

tmp = tempfile.mkdtemp(prefix="onehr-tests-details-")
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
        return c.execute("SELECT last_insert_rowid()").fetchone()[0]
    finally:
        c.close()


try:
    C = H.client_as(a, SU["id"])
    C.post("/admin/cycles", data={"action": "create", "csrf_token": "tok", "name": "ZZDS 2026 Year-End", "code": "ZZDS-YE",
                                  "confirm_freeze": "1", "source": "empty", "year": "2026", "half": "2",
                                  "starts_on": "2026-10-01T00:00", "min_job_grade": "12"})
    CID = q("SELECT id FROM cycles WHERE code='ZZDS-YE'")[0][0]
    for bg, mech, var in (("ZZDS A Group", "A", None), ("ZZDS B Group", "B", "excellence")):
        do("INSERT OR REPLACE INTO pm_bg_config(business_group, mechanism, variant) VALUES (?,?,?)", (bg, mech, var))
    for i, (mn, lab) in enumerate(((0, "UA"), (80, "BE"), (95, "ME"), (110, "AE"), (130, "OU")), start=1):
        do("INSERT INTO pm_rating_bands(business_group, min_value, label, sort_order) VALUES (?,?,?,?)",
           ("ZZDS B Group", mn, lab, i))
    with a.app.app_context():
        db = a.get_db()
        base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
        cols = [c for c in base.keys() if c != "id"]
        for eid, bg in (("ZZDS-A", "ZZDS A Group"), ("ZZDS-B", "ZZDS B Group")):
            v = dict(base, username=eid, employee_id=eid, full_name="Person " + eid, email=None, hod_id=None,
                     manager_id=None, left_at=None, role="user", admin_bg=None, years_of_service=3, job_grade=13,
                     business_group=bg, is_demo=0)
            db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                       [v[c] for c in cols])
        db.commit()
    ID = dict(q("SELECT employee_id, id FROM users WHERE employee_id LIKE 'ZZDS-%'"))
    do("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, category, weightage, unit, method, rate1, rate2, "
       "rate3, rate4, rate5, business_group) VALUES (?,?,'ZZDS Sales revenue','Financial',60,'RM mil','more',8,9,10,11,12,"
       "'ZZDS A Group')", (CID, ID["ZZDS-A"]))
    do("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, category, weightage, unit, method, rate1, rate2, "
       "rate3, rate4, rate5, business_group) VALUES (?,?,'ZZDS Overdue debt','Financial',40,'RM mil','less',2,1.8,1.5,"
       "1.2,1,'ZZDS A Group')", (CID, ID["ZZDS-A"]))
    do("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, unit, method, threshold, target, excellence, "
       "business_group) VALUES (?,?,'ZZDS Sell-out',100,'RM mil','more',4,5,6,'ZZDS B Group')", (CID, ID["ZZDS-B"]))
    SK = {}
    for code, title, lv in (("ZZDS-SEL-3001", "ZZDS Selling", 3), ("ZZDS-SEL-4001", "ZZDS Selling", 4),
                            ("ZZDS-PRC-3001", "ZZDS Pricing", 3), ("ZZDS-PRC-4001", "ZZDS Pricing", 4),
                            ("ZZDS-CLO-3001", "ZZDS Closing", 3), ("ZZDS-CLO-4001", "ZZDS Closing", 4)):
        SK[code] = do("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, proficiency_description,"
                      " ability_items, active) VALUES (?,?,?,'tsc','ZZDS Cat',?,?,1)",
                      (code, title, lv, "%s at level %d" % (title, lv), "Do the first thing\nDo the second thing"))
    AS = {}
    for seq, (code, fut) in enumerate((("ZZDS-SEL-3001", 0), ("ZZDS-SEL-4001", 1), ("ZZDS-PRC-3001", 0),
                                      ("ZZDS-PRC-4001", 1), ("ZZDS-CLO-3001", 0), ("ZZDS-CLO-4001", 1))):
        AS[code] = do("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, seq, source) VALUES "
                      "(?,?,?,?,?, 'profile')", (CID, ID["ZZDS-A"], SK[code], fut, seq))

    s.section("Started, nothing open: the dashboard")
    E = H.client_as(a, ID["ZZDS-A"])
    body = E.get("/dashboard").get_data(as_text=True)
    s.check("it says nothing is open yet, each part not open yet", "hasn't opened yet" in body
            and body.count("od-await-st") == 4, body.count("od-await-st"))
    s.check("Where you stand opens Details on the KPI targets and on the competencies",
            'data-record="current" data-tab="kpi"' in body and 'data-record="current" data-tab="comp"' in body
            and "2 set · targets in Details" in body and "3 for your job" in body)
    _card = body.split('id="od-here-h"')[1].split("</section>")[0] if 'id="od-here-h"' in body else "/review"
    s.check("no way into the AI+ check-in", "/review" not in _card and E.get("/review").status_code == 404)

    s.section("Details before it opens")
    j = E.get("/me/record/current").get_json() or {}
    lines = (j.get("perf") or {}).get("lines") or []
    s.check("it is the not-open view", j.get("mode") == "present" and j.get("awaiting") is True, (j.get("mode"),
                                                                                                    j.get("awaiting")))
    s.check("each KPI carries its five rating figures and which way is better (Mechanism A)",
            len(lines) == 2 and {ln["name"]: (ln["rates"], ln["method"]) for ln in lines}
            == {"ZZDS Sales revenue": ([8, 9, 10, 11, 12], "more"), "ZZDS Overdue debt": ([2, 1.8, 1.5, 1.2, 1], "less")}
            and (j["perf"].get("scale") or {}).get("mechanism") == "A", [(ln["name"], ln["rates"]) for ln in lines])
    items = (j.get("competency") or {}).get("items") or []
    sel = next((it for it in items if it["title"] == "ZZDS Selling"), {})
    lv = {x["level"]: x for x in sel.get("levels") or []}
    s.check("each competency carries its level now and next, with what each means and its abilities",
            len(items) == 3 and set(lv) == {3, 4} and lv[3]["future"] is False and lv[4]["future"] is True
            and lv[3]["desc"] == "ZZDS Selling at level 3" and lv[4]["abilities"] == ["Do the first thing",
                                                                                    "Do the second thing"], lv)
    jb = H.client_as(a, ID["ZZDS-B"]).get("/me/record/current").get_json() or {}
    lb = ((jb.get("perf") or {}).get("lines") or [{}])[0]
    sc = (jb.get("perf") or {}).get("scale") or {}
    s.check("a threshold / target group: each line's threshold, target and excellence, and the group's cut-offs",
            (lb.get("threshold"), lb.get("target"), lb.get("excellence")) == (4, 5, 6) and sc.get("mechanism") == "B"
            and sc.get("variant") == "excellence" and [x["min"] for x in sc.get("bands") or []] == [0, 80, 95, 110, 130],
            (lb, sc))

    s.section("Ask OneHR")
    with a.app.test_request_context("/"):
        from flask import session as _s
        _s["user_id"] = ID["ZZDS-A"]
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (ID["ZZDS-A"],)).fetchone()
        ctx = a._dash_context(db, u)
        sug = a._ask_suggestions(ctx)
        ik = a._ask_intent("Show my KPI targets", ctx)
        ic = a._ask_intent("Show my competencies", ctx)
    s.check("the dashboard is in the not-open state", ctx["mode"] == "awaiting", ctx["mode"])
    s.check("it offers the two ways in", "Show my KPI targets" in sug and "Show my competencies" in sug, sug)
    s.check("...answered in code, each card opening Details on its tab",
            ik and ik["cards"] and (ik["cards"][0]["panel"], ik["cards"][0]["arg"]) == ("current", "kpi")
            and ic and ic["cards"] and (ic["cards"][0]["panel"], ic["cards"][0]["arg"]) == ("current", "comp"),
            (ik, ic))

    s.section("Once released: the result only")
    ta = do("INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?, 'reviewed')", (CID, ID["ZZDS-A"]))
    for code, mine, lm in (("ZZDS-SEL-3001", "yes", "yes"), ("ZZDS-SEL-4001", "no", "yes"),
                           ("ZZDS-PRC-3001", "yes", "no"), ("ZZDS-PRC-4001", "no", "no"),
                           ("ZZDS-CLO-3001", "yes", "yes"), ("ZZDS-CLO-4001", "yes", "no")):
        do("INSERT INTO tc_scores(assessment_id, assignment_id, answer, manager_answer) VALUES (?,?,?,?)",
           (ta, AS[code], mine, lm))
    with a.app.test_request_context("/"):
        from flask import session as _s3
        _s3["user_id"] = SU["id"]
        db = a.get_db()
        su = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        subj = db.execute("SELECT * FROM users WHERE id=?", (ID["ZZDS-A"],)).fetchone()
        ok, _m = a._pot_super_set(db, su, CID, subj, "Mid", "ZZDS test")
        db.execute("INSERT INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pot')", (CID, ID["ZZDS-A"]))
        db.commit()
    r = E.get("/me/record/current").get_json() or {}
    s.check("Details is the result view, this cycle released to them", r.get("mode") == "record" and r.get("current")
            is True and (r.get("final") or {}).get("pot") == "Mid", (r.get("mode"), r.get("current"), r.get("final")))
    s.check("...with no KPI line, no figure, no competency answer", "perf" not in r and "competency" not in r,
            sorted(r))
    s.check("...the line manager's strongest (the next level shown) and to grow (still developing), titles only",
            r.get("comp_calls") == {"strong": ["ZZDS Selling"], "grow": ["ZZDS Pricing"]}, r.get("comp_calls"))
finally:
    a.DB_PATH = real
    shutil.rmtree(tmp, ignore_errors=True)

sys.exit(s.done())
