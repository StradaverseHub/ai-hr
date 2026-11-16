"""Grade H staff are never on a 360 (Chris, 2026-10-28; BUILD-SPEC "Gate and scope": "they rate nobody, are on no 360 panel").

THE rule is build_assignments.is_grade_h (job grade 'H', trimmed, any case); app.py's is_grade_h / gradeh_no360_refusal /
no360_sql and build_panels_db.load_people all ask it. It holds whether or not ONEHR_GRADEH is on and whatever the cycle's
job-grade floor (this suite runs with NO floor and the switch OFF, so nothing but the rule can be what keeps them out), and
it changes nothing for anyone who is not Grade H.

What this suite holds, one check per way onto a panel, each run twice: with the rule (nobody Grade H gets on) and with the
rule switched off (the SAME steps put them on, so each check reaches the line it is about; a guard that is never falsified
proves nothing):
  * the panel editor: Add a rater (the Grade H person as the rated, as the rater, padded and lower case, as a line manager),
    the bulk Add suggested (as rater and as subject), and Restore from the archive
  * a line manager change (_apply_line_manager_change, which the Data integrity fix, the person page and the panel file share):
    still their line manager on the org chart, never put on a panel, and the existing panel is not disturbed
  * the panel file: the quality step names the row, nothing Grade H is valid, and the writer skips it on its own
  * the bulk build (POST /admin/panels/build) and the loader every engine reads (build_panels_db.load_people), floor or none
  * starting a cycle cloned from the active one (a Grade H pair in the source is not carried)
  * "short of a full panel" and "no panel" do not list them, and the rest of the build is unchanged for everyone else
  * the Overview's "No 360 panel yet" list and its "Assessor panels built" tile (2026-10-28) count only people who can be on a panel
Everything here is synthetic (ZZ9NH-*).
"""
import os
import shutil
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
assert "onehr-tests" in a.DB_PATH
s = H.Suite("Grade H is never on a 360: every way onto a panel refuses them")
SU, BGA, EMP = H.actors(a)
BG, CO, DEPT = "ZZNH BG", "ZZNH CO", "ZZNH Dept"
PFX = "ZZ9NH-"
# suffix -> job grade as stored. LMX manages everyone; N* are ordinary JG 15; H1 / H2 are Grade H however it was typed.
GRADES = {"LMX": 15, "N1": 15, "N2": 15, "N3": 15, "N4": 15, "H1": "H", "H2": " h "}
ID = {}
_ENV0 = os.environ.pop("ONEHR_GRADEH", None)   # the switch OFF: the rule does not depend on it
SUC = H.client_as(a, SU["id"])


def q(sql, args=()):
    return H.one(a, sql, args)


with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle(db)["id"]
    MG0 = db.execute("SELECT min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    db.execute("UPDATE cycles SET min_job_grade=NULL WHERE id=?", (CID,))   # no floor: only the rule can keep them out
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]
    for suf, jg in GRADES.items():
        eid = PFX + suf
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ NoThreeSixty " + suf, email=None, hod_id=None,
                 manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO,
                 department=DEPT, years_of_service=3, confirmation_date="2000-01-01", left_at=None, is_demo=0, role="user",
                 job_grade=jg)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        ID[suf] = db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    db.commit()
HS = (ID["H1"], ID["H2"])
MINE = tuple(ID.values())
PH = ",".join("?" * len(MINE))


def writer(fn):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = SU["id"]
        d = a.get_db()
        r = fn(d)
        d.commit()
        return r


def reset():
    def go(d):
        d.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (PH, PH), MINE + MINE)
        d.execute("DELETE FROM activity_log WHERE target_user_id IN (%s)" % PH, MINE)
        for k in ("N1", "N2", "N3", "H1", "H2"):
            d.execute("UPDATE users SET manager_id=? WHERE id=?", (ID["LMX"], ID[k]))
    writer(go)


def h_rows(cid=None, archived=None):
    """Panel rows (any state unless `archived` says) with a Grade H person on either end."""
    sql = ("SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND (subject_id IN (?,?) OR assessor_id IN (?,?))"
           + ("" if archived is None else " AND archived=%d" % archived))
    return q(sql, (cid or CID,) + HS + HS)


def pairs(cid=None):
    return {(r[0], r[1]) for r in H.rows(a, "SELECT subject_id, assessor_id FROM assignments WHERE cycle_id=? AND archived=0",
                                         (cid or CID,)) if r[0] in MINE and r[1] in MINE}


def post_panel(subject, **form):
    return SUC.post("/admin/subjects/%d/panel" % ID[subject], data=dict(csrf_token="tok", **form), follow_redirects=True)


def exercise():
    """Every way onto a panel, once. {path: whether a Grade H person got on}, plus the controls (ordinary people still can)."""
    out, ctl = {}, {}

    reset()
    post_panel("H1", action="add", assessor_eid=PFX + "N2", relationship="peer")
    out["editor: Add, the Grade H person is the one rated"] = h_rows() > 0
    reset()
    post_panel("N1", action="add", assessor_eid=PFX + "H1", relationship="peer")
    out["editor: Add, the Grade H person is the rater"] = h_rows() > 0
    reset()
    post_panel("N1", action="add", assessor_eid=PFX + "H2", relationship="peer")
    out["editor: Add, a grade typed ' h ' (padded, lower case)"] = h_rows() > 0
    reset()
    post_panel("N1", action="add", assessor_eid=PFX + "H1", relationship="line_manager")
    out["editor: Add as line manager"] = h_rows() > 0 or q("SELECT manager_id FROM users WHERE id=?", (ID["N1"],)) == ID["H1"]
    reset()
    post_panel("N1", action="add", assessor_eid=PFX + "N2", relationship="peer")
    ctl["editor: Add still works for ordinary people"] = (ID["N1"], ID["N2"]) in pairs()

    reset()
    post_panel("N1", action="add_suggested", **{"pick_%d" % ID["H1"]: "1", "rel_%d" % ID["H1"]: "peer",
                                                 "pick_%d" % ID["H2"]: "1", "rel_%d" % ID["H2"]: "peer",
                                                 "pick_%d" % ID["N3"]: "1", "rel_%d" % ID["N3"]: "peer"})
    out["editor: Add suggested, Grade H people ticked as raters"] = h_rows() > 0
    ctl["editor: Add suggested still adds the ordinary one ticked beside them"] = (ID["N1"], ID["N3"]) in pairs()
    reset()
    post_panel("H1", action="add_suggested", **{"pick_%d" % ID["N2"]: "1", "rel_%d" % ID["N2"]: "peer"})
    out["editor: Add suggested, the Grade H person is the one rated"] = h_rows() > 0

    reset()
    writer(lambda d: d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, archived) "
                               "VALUES (?,?,?, 'peer', 1)", (CID, ID["N1"], ID["H1"])))
    aid = q("SELECT id FROM assignments WHERE cycle_id=? AND subject_id=? AND assessor_id=?", (CID, ID["N1"], ID["H1"]))
    post_panel("N1", action="restore", assignment_id=aid)
    out["editor: Restore from the archive"] = h_rows(archived=0) > 0
    reset()
    writer(lambda d: d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, archived) "
                               "VALUES (?,?,?, 'peer', 1)", (CID, ID["N1"], ID["N2"])))
    aid = q("SELECT id FROM assignments WHERE cycle_id=? AND subject_id=? AND assessor_id=?", (CID, ID["N1"], ID["N2"]))
    post_panel("N1", action="restore", assignment_id=aid)
    ctl["editor: Restore still works for ordinary people"] = (ID["N1"], ID["N2"]) in pairs()

    # a line manager change: still the line manager (org chart), never a panel row, the panel already there is not disturbed
    reset()
    writer(lambda d: d.execute("UPDATE users SET manager_id=? WHERE id=?", (ID["N4"], ID["H1"])))
    r1 = writer(lambda d: a._apply_line_manager_change(d, ID["H1"], ID["LMX"], CID, actor_id=SU["id"]))
    out["line manager change: a Grade H person's new line manager goes on their panel"] = h_rows() > 0
    ctl["...the org chart still follows (users.manager_id)"] = q("SELECT manager_id FROM users WHERE id=?", (ID["H1"],)) == ID["LMX"]
    ctl["...and says why (assignment_action)"] = r1["assignment_action"] == "no360"
    reset()
    writer(lambda d: d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?, 'line_manager')",
                               (CID, ID["N1"], ID["LMX"])))
    r2 = writer(lambda d: a._apply_line_manager_change(d, ID["N1"], ID["H1"], CID, actor_id=SU["id"]))
    out["line manager change: a Grade H person made someone's line manager goes on their panel"] = h_rows() > 0
    ctl["...the existing line manager row is not displaced"] = (ID["N1"], ID["LMX"]) in pairs() and r2["displaced"] is None
    reset()
    r3 = writer(lambda d: a._apply_line_manager_change(d, ID["N1"], ID["N2"], CID, actor_id=SU["id"]))
    ctl["line manager change: still puts an ordinary line manager on the panel"] = (
        r3["assignment_action"] == "created" and (ID["N1"], ID["N2"]) in pairs())

    # the panel file
    rows = [(2, PFX + "H1", PFX + "N2", "peer"), (3, PFX + "N1", PFX + "H1", "peer"), (4, PFX + "N1", PFX + "H2", "peer"),
            (5, PFX + "N1", PFX + "N2", "peer")]
    reset()
    chk = writer(lambda d: a._panel_import_check(d, SU, CID, rows, False))
    bad = [v for v in chk["valid"] if v["sid"] in HS or v["aid"] in HS]
    out["panel file: the quality step lets a Grade H row through as valid"] = bool(bad)
    ctl["panel file: ...names the three rows, as Grade H"] = (
        sorted(e["row"] for e in chk["errors"]) == [2, 3, 4] and all("Grade H" in e["why"] for e in chk["errors"]))
    ctl["panel file: ...and the ordinary row stays valid in a clean file"] = (
        {(v["sid"], v["aid"]) for v in writer(lambda d: a._panel_import_check(d, SU, CID, [rows[3]], False))["valid"]}
        == {(ID["N1"], ID["N2"])})
    forced = [dict(sid=ID["H1"], aid=ID["N2"], rel="peer"), dict(sid=ID["N1"], aid=ID["H1"], rel="peer"),
              dict(sid=ID["N1"], aid=ID["N3"], rel="peer")]
    reset()
    writer(lambda d: a._panel_import_apply(d, SU, CID, forced, False))
    out["panel file: the writer, handed a Grade H row, writes it"] = h_rows() > 0
    ctl["panel file: ...and still writes the ordinary one beside it"] = (ID["N1"], ID["N3"]) in pairs()

    # the bulk build, and the loader every engine reads (with no floor, and with one)
    reset()
    SUC.post("/admin/panels/build", data=dict(csrf_token="tok", mode="missing", apply="1"))
    out["the bulk build gives a Grade H person a panel or a seat on one"] = h_rows() > 0
    ctl["the bulk build still builds panels for the ordinary people"] = any(
        r[0] in (ID["N1"], ID["N2"], ID["N3"], ID["N4"]) for r in H.rows(
            a, "SELECT subject_id FROM assignments WHERE cycle_id=? AND archived=0", (CID,)))
    eids = lambda mg: {p for p in writer(lambda d: a._bpdb.load_people(d, mg))}  # noqa: E731
    out["the engine's loader (no floor) lists a Grade H person"] = bool({PFX + "H1", PFX + "H2"} & eids(None))
    ctl["the loader (JG 12 floor, which already drops a letter grade) still lists no Grade H person"] = not ({PFX + "H1", PFX + "H2"} & eids(12))
    ctl["the loader still lists the ordinary people"] = {PFX + "N1", PFX + "LMX"} <= eids(None)
    reset()   # (the build above may have given them a row, and a panel of one is not "short" for a letter grade)
    ssql, ssp = writer(lambda d: a._f360_short_sql(CID))
    short = {r[0] for r in H.rows(a, "SELECT u.id FROM users u WHERE u.employee_id LIKE ? " + ssql, (PFX + "%",) + tuple(ssp))}
    out["'Short of a full panel' lists a Grade H person"] = bool(short & set(HS))
    ctl["'Short of a full panel' still lists the ordinary people"] = bool(short & {ID["N1"], ID["N4"]})

    # the Overview: the "No 360 panel yet" list and the "Assessor panels built" tile count the people on a panel at all
    reset()
    lst = writer(lambda d: a._list_ready_no_panel(d, a.current_user(), CID, {}))
    listed = {r["uid"] for r in lst["rows"]}
    out["the Overview's 'No 360 panel yet' list names a Grade H person"] = bool(listed & set(HS))
    ctl["the Overview's 'No 360 panel yet' list still names the ordinary people"] = {ID["N1"], ID["N4"]} <= listed
    ctl["...and its title counts exactly the rows"] = ("· %s" % format(len(lst["rows"]), ",")) in lst["title"]
    groups = writer(lambda d: a._cycle_readiness(d, dict(d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()),
                                                 a.active_cycle(d)))[0]
    step = next((x for g_ in groups for x in g_["steps"] if x["label"] == "Assessor panels built"), None)
    pop_not_h = q("SELECT COUNT(*) FROM users u WHERE u.role!='admin' AND " + a.calibration_population_sql("u")
                  + " AND UPPER(TRIM(COALESCE(CAST(u.job_grade AS TEXT),'')))!='H'")
    out["the Overview's 'Assessor panels built' tile counts a Grade H person in the people taking part"] = bool(
        step) and step["of"] != pop_not_h
    ctl["the tile is there and counts the ordinary people taking part"] = bool(step) and step["of"] == pop_not_h and step["of"] >= 5
    ctl["...and the people it leaves out of the list are the same as it counts as missing a panel"] = bool(step) and (
        step["of"] - step["n"] == len(lst["rows"]))

    # starting a cycle cloned from this one: a Grade H pair in the source is not carried (on a COPY: starting archives)
    reset()
    writer(lambda d: [d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?, 'peer')",
                                (CID, x, y)) for x, y in ((ID["N1"], ID["N2"]), (ID["N1"], ID["H1"]), (ID["H2"], ID["N3"]))])
    tmp = tempfile.mkdtemp(prefix="onehr-tests-no360-")
    real = a.DB_PATH
    try:
        cp = os.path.join(tmp, "copy.db")
        src = sqlite3.connect(real)
        dst = sqlite3.connect(cp)
        src.backup(dst)
        src.close()
        dst.close()
        a.DB_PATH = cp
        assert "onehr-tests" in a.DB_PATH
        C = H.client_as(a, SU["id"])
        C.post("/admin/cycles", data={"action": "create", "csrf_token": "tok", "name": "ZZNH Year-End", "code": "ZZNH-YE",
                                      "confirm_freeze": "1", "source": "clone:%d" % CID, "year": "2026", "half": "2"})
        c2 = sqlite3.connect(cp)
        new = c2.execute("SELECT id FROM cycles WHERE code='ZZNH-YE'").fetchone()
        got = set()
        if new:
            got = {(x[0], x[1]) for x in c2.execute("SELECT subject_id, assessor_id FROM assignments WHERE cycle_id=?", (new[0],))}
        c2.close()
        out["a cycle cloned forward carries a Grade H pair"] = bool(got & {(ID["N1"], ID["H1"]), (ID["H2"], ID["N3"])})
        ctl["a cycle cloned forward still carries the ordinary pair"] = (ID["N1"], ID["N2"]) in got
    finally:
        a.DB_PATH = real
        shutil.rmtree(tmp, ignore_errors=True)
    reset()
    return out, ctl


_real = (a._ba.is_grade_h, a.no360_sql)
try:
    s.section("the rule itself: job grade 'H', however it was typed, and nobody else")
    for v_, want in (("H", True), ("h", True), (" H ", True), ("12", False), (12, False), (None, False), ("", False),
                     ("HX", False), ("FW", False), ("GM", False)):
        s.check("is_grade_h(%r) is %s" % (v_, want), a._ba.is_grade_h(v_) is want and a.is_grade_h({"job_grade": v_}) is want)
    s.check("a users row without a job_grade key is not Grade H (no crash)", a.is_grade_h({}) is False)
    sql_ok = {r[0] for r in H.rows(a, "SELECT employee_id FROM users WHERE employee_id LIKE ? AND " + a.no360_sql(), (PFX + "%",))}
    s.check("no360_sql keeps the ordinary people and drops both Grade H spellings",
            sql_ok == {PFX + k for k in ("LMX", "N1", "N2", "N3", "N4")}, sorted(sql_ok))
    s.check("...also through a table prefix", {r[0] for r in H.rows(a, "SELECT u.employee_id FROM users u WHERE u.employee_id LIKE ? AND "
                                                                    + a.no360_sql("u"), (PFX + "%",))} == sql_ok)
    s.check("a letter grade that is NOT H is not caught (FW / GM keep today's behaviour)",
            not any(a._ba.is_grade_h(x) for x in ("FW", "GM", "G12")))
    s.check("the rule holds with ONEHR_GRADEH off, and with no job-grade floor (this suite's setup)",
            os.environ.get("ONEHR_GRADEH") is None and q("SELECT min_job_grade FROM cycles WHERE id=?", (CID,)) is None)
    msg = writer(lambda d: a.gradeh_no360_refusal(d, ID["N1"], ID["H1"]))
    s.check("the refusal names the person and says why, in plain words", msg and "ZZ NoThreeSixty H1" in msg
            and "Grade H" in msg and "can't be a rater" in msg, msg)
    s.check("...for the person rated too; nothing for two ordinary people",
            "can't have a panel" in (writer(lambda d: a.gradeh_no360_refusal(d, ID["H2"], ID["N1"])) or "")
            and writer(lambda d: a.gradeh_no360_refusal(d, ID["N1"], ID["N2"])) is None
            and writer(lambda d: a.gradeh_no360_refusal(d, ID["N1"])) is None)

    s.section("with the rule: no way onto a panel puts a Grade H person on one")
    got, ctl = exercise()
    for path, leaked in got.items():
        s.check("refused: " + path, not leaked)
    for path, ok in ctl.items():
        s.check("control (ordinary people unaffected): " + path, ok)

    s.section("FALSIFIED: the rule switched off, the same steps DO put them on (so each check above reaches its line)")
    a._ba.is_grade_h = lambda v: False
    a.no360_sql = lambda prefix="": "1=1"
    try:
        got_off, _ctl_off = exercise()
    finally:
        a._ba.is_grade_h, a.no360_sql = _real
    for path, leaked in got_off.items():
        s.check("with the rule off this path lets them in: " + path, leaked)
    s.check("the rule is back on", a._ba.is_grade_h("H") is True)
    reset()
finally:
    a._ba.is_grade_h, a.no360_sql = _real
    if _ENV0 is not None:
        os.environ["ONEHR_GRADEH"] = _ENV0

    def _clean(d):
        d.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (PH, PH), MINE + MINE)
        d.execute("DELETE FROM activity_log WHERE target_user_id IN (%s)" % PH, MINE)
        d.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % PH, MINE)
        d.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % PH, MINE)
        d.execute("DELETE FROM users WHERE id IN (%s)" % PH, MINE)
        d.execute("UPDATE cycles SET min_job_grade=? WHERE id=?", (MG0, CID))
    writer(_clean)
sys.exit(s.done())
