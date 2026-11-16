"""Career routes as a tree, every job's ladder filled to JG 20, and the leadership step (Chris, 2026-10-19: "go with option
B for both, build it" on canvas [design canvas link removed]).

What this suite holds (a made-up job family and leadership roles, put back at the end):
  * the gaps: each job's grades from its first to JG 20 that no profile holds; never below its first, never above 20
  * the fill: each gap becomes a target role (source 'target', a draft, nobody on it) titled in the ladder's words,
    its five the grade below's at its own grade's level and one up (none past L6); run twice, it adds nothing
  * the routes: a grade's next step is the target role above it; from JG 20, 21 and 22 the next grade's roles on the
    leadership track are offered whatever their family, and never from JG 19, never two grades up
  * the importer: a re-import never retires a target role, and supersedes it once the file holds its job code
  * the page: the tree (the leadership track first), a job's ladder with missing grades and target roles, the
    leadership rows above, the routes panel, pin / hide / show again, Fill the missing grades, a BG admin refused, an
    older ?profile= link landing on its grade; the competency library tags a target role; the settings card's words
"""
import importlib.util
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Career routes: the tree, ladders filled to JG 20, the leadership step")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
TAX = [("ZZF", "family", None, "ZZ Finance Family"), ("ZZF-FIN", "sub_family", "ZZF", "ZZ Finance"),
       ("ZZF-FIN-01", "specialisation", "ZZF-FIN", "ZZ Finance Partner"),
       ("ZZF-FIN-01-A", "unit", "ZZF-FIN-01", "ZZ Finance Partner"), ("EXL-ZZ", "sub_family", "EXL", "ZZ General Management")]


def _cleanup(db):
    db.execute("DELETE FROM tc_job_profiles WHERE job_code LIKE 'ZZF-%' OR job_code LIKE 'EXL-ZZ-%'")
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZS-%'")
    db.execute("DELETE FROM ja_taxonomy WHERE code LIKE 'ZZF%' OR code='EXL-ZZ'" + (
        " OR code='EXL'" if ADDED_EXL else ""))
    db.execute("DELETE FROM users WHERE employee_id='ZZ9CT-BGA'")
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    ADDED_EXL = not db.execute("SELECT 1 FROM ja_taxonomy WHERE code='EXL'").fetchone()
    _cleanup(db)
    LOG0 = db.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    for row in TAX + ([("EXL", "family", None, "Management")] if ADDED_EXL else []):
        db.execute("INSERT INTO ja_taxonomy(code, level, parent_code, name) VALUES (?,?,?,?)", row)
    SK = {}
    for fam in ("TST", "LDR"):
        for n in range(1, 6):
            for lv in (3, 4, 5, 6):
                code = "ZZS-%s-%d%03d-1.0" % (fam, lv, n)
                SK[(fam, n, lv)] = db.execute("INSERT INTO tc_skills(skill_code, title, level) VALUES (?,?,?)",
                                              (code, "ZZ %s skill %d" % (fam, n), lv)).lastrowid
    ID = {}

    def prof(code, title, fam="TST", dept="ZZ Finance"):
        g = int(code.rsplit("-", 1)[1])
        lv = a.tc_grade_proficiency(g)
        pid = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, plan_mode, review_status, job_code, "
                         "source, active) VALUES (?,?,?,'explicit','draft',?,'architecture',1)",
                         (dept, title, str(g), code)).lastrowid
        for n in range(1, 6):
            db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, is_future) "
                       "VALUES (?,?,?,?,0)", (pid, SK[(fam, n, lv)], lv, n))
            if lv < 6:
                db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, "
                           "is_future) VALUES (?,?,?,?,1)", (pid, SK[(fam, n, lv + 1)], lv + 1, n))
        ID[code] = pid
    prof("ZZF-FIN-01-A-12", "Executive, Finance Partner")
    prof("ZZF-FIN-01-A-14", "Senior Executive, Finance Partner")
    prof("ZZF-FIN-01-A-18", "Senior Manager, Finance Partner")
    prof("ZZF-FIN-02-20", "General Manager, Finance Planning")
    prof("ZZF-FIN-03-21", "Director, Finance")
    prof("ZZF-FIN-04-22", "Chief Financial Officer, ZZ")
    prof("EXL-ZZ-01-21", "Chief Operating Officer, ZZ", "LDR", "ZZ General Management")
    prof("EXL-ZZ-01-22", "Chief Executive Officer, ZZ", "LDR", "ZZ General Management")
    prof("EXL-ZZ-01-23", "Group Chief Executive Officer, ZZ", "LDR", "ZZ General Management")
    prof("EXL-ZZ-02-20", "General Manager, Operations ZZ", "LDR", "ZZ General Management")   # a leadership role at JG 20
    prof("EXL-ZZ-03-22", "Managing Director, ZZ", "LDR", "ZZ General Management")   # one held only at JG 22
    # a retired profile still holding one gap's job code (an earlier mapping's, deactivated by a later import)
    RETIRED = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, source, active) VALUES "
                         "('ZZ Finance', 'ZZ old title', '16', 'ZZF-FIN-01-A-16', 'architecture', 0)").lastrowid
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                     "VALUES ('zz9ct-bga','ZZ CT Groupadmin','x','admin','ZZ9CT-BGA','ZZ CT Group','ZZ CT Group')").lastrowid
    db.commit()
SUP, BAC = H.client_as(a, SU["id"]), H.client_as(a, BGA)


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def routes(code):
    def f(d):
        row = d.execute("SELECT * FROM tc_job_profiles WHERE job_code=? AND active=1", (code,)).fetchone()
        return a.tc_career_routes_for(d, dict(row), limit=40)
    return ctx(f)


def mine(d):
    return {k: v for k, v in a.tc_ladder_gaps(d).items() if k.startswith(("ZZF", "EXL-ZZ"))}


try:
    s.section("the gaps")
    gaps = ctx(mine)
    s.check("each job's grades from its first to JG 20 nobody holds", gaps == {"ZZF-FIN-01-A": [13, 15, 16, 17, 19, 20]},
            gaps)
    s.check("...none for a job that starts at JG 20 or above (the leadership track)", "ZZF-FIN-02" not in gaps
            and "EXL-ZZ-01" not in gaps)
    s.check("the ladder's words: Engineer below management, the level then the discipline",
            a._tc_target_title("Senior Engineer, Design", 13) == "Engineer, Design"
            and a._tc_target_title("Engineer, Design", 14) == "Senior Engineer, Design"
            and a._tc_target_title("Senior Engineer, Design", 15) == "Assistant Manager, Design"
            and a._tc_target_title("Project Manager", 19, "Project") == "Assistant General Manager, Project")

    s.section("the page, before the fill")
    pg = SUP.get("/admin/career-routes?job=ZZF-FIN-01-A").get_data(as_text=True)
    s.check("the tree: the family, its sub-family and the job, the leadership track's family first",
            "ZZ Finance Family" in pg and "ZZ Finance Partner" in pg and pg.find("Leadership track") < pg.find("ZZ Finance Family"))
    s.check("the ladder marks a grade nobody holds", "Nobody holds JG 19 in this job" in pg and "Missing" in pg,
            (re.findall(r"cr-r is-[a-z]+", pg)[:20], "Pick a job" in pg, re.findall(r"Nobody holds[^<]*", pg)[:3]))
    s.check("...and the super admin is offered Fill the missing grades", "Fill the missing grades" in pg)
    s.check("a BG admin reads it, but can't fill", BAC.get("/admin/career-routes").status_code == 200
            and BAC.post("/admin/career-routes", data={"csrf_token": "tok", "action": "fill"}).status_code == 403
            and ctx(mine))

    s.section("the fill")
    SUP.post("/admin/career-routes", data={"csrf_token": "tok", "action": "fill"})
    tg = ctx(lambda d: {r["job_code"]: dict(r) for r in d.execute(
        "SELECT * FROM tc_job_profiles WHERE job_code LIKE 'ZZF-FIN-01-A-%' AND source='target'")})
    s.check("each gap became a target role", sorted(tg) == ["ZZF-FIN-01-A-%d" % g for g in (13, 15, 16, 17, 19, 20)],
            sorted(tg))
    s.check("...a draft, no job scope, in the job's department",
            all(r["review_status"] == "draft" and not r["job_scope"] and r["department"] == "ZZ Finance" for r in tg.values()))
    s.check("...titled in the ladder's words", tg["ZZF-FIN-01-A-15"]["job_title"] == "Assistant Manager, Finance Partner"
            and tg["ZZF-FIN-01-A-19"]["job_title"] == "Assistant General Manager, Finance Partner"
            and tg["ZZF-FIN-01-A-20"]["job_title"] == "General Manager, Finance Partner",
            {k: v["job_title"] for k, v in tg.items()})

    def lv(code):
        return ctx(lambda d: sorted((r[0], r[1]) for r in d.execute(
            "SELECT ps.is_future, ps.required_level FROM tc_job_profile_skills ps JOIN tc_job_profiles p ON "
            "p.id=ps.profile_id WHERE p.job_code=?", (code,))))
    s.check("...its five at its grade's level and one up: JG 15 at L4 and L5", lv("ZZF-FIN-01-A-15") == [(0, 4)] * 5 + [(1, 5)] * 5)
    s.check("...JG 19 at L5 and L6, JG 13 at L3 and L4", lv("ZZF-FIN-01-A-19") == [(0, 5)] * 5 + [(1, 6)] * 5
            and lv("ZZF-FIN-01-A-13") == [(0, 3)] * 5 + [(1, 4)] * 5)
    same = ctx(lambda d: {r[0] for r in d.execute(
        "SELECT s.title FROM tc_job_profile_skills ps JOIN tc_skills s ON s.id=ps.skill_id JOIN tc_job_profiles p ON "
        "p.id=ps.profile_id WHERE p.job_code='ZZF-FIN-01-A-19'")})
    s.check("...the same five competencies as the grade below", same == {"ZZ TST skill %d" % n for n in range(1, 6)})
    s.check("a retired profile on a gap's job code is taken over, not met on the index", tg["ZZF-FIN-01-A-16"]["id"] == RETIRED
            and H.one(a, "SELECT COUNT(*) FROM tc_job_profiles WHERE job_code='ZZF-FIN-01-A-16'") == 1
            and tg["ZZF-FIN-01-A-16"]["active"] == 1 and tg["ZZF-FIN-01-A-16"]["job_title"] == "Manager, Finance Partner")
    s.check("run again, it adds nothing", ctx(lambda d: a.tc_fill_ladders(d))["created"] == 0 and ctx(mine) == {})
    s.check("the fill is in the audit log", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND "
                                                     "action='career_targets'", (LOG0,)) == 1)

    s.section("the routes")
    r14 = routes("ZZF-FIN-01-A-14")
    nxt = [r for r in r14 if r.get("next_step")]
    s.check("a grade's next step is the target role above it", len(nxt) == 1 and nxt[0]["profile"]["job_code"] ==
            "ZZF-FIN-01-A-15" and nxt[0]["target"], [(r["profile"]["job_code"], r["route"]) for r in r14])
    lead20 = [r["profile"]["job_code"] for r in routes("ZZF-FIN-02-20") if r["route"] == "leadership track"]
    # up to two grades up (Chris, 2026-10-19: "allow up to 2 job grades selection"): one per leadership job, at its
    # nearest grade -- 01 at JG 21 (not again at 22), 03 at JG 22
    s.check("from JG 20: the leadership roles one and two grades up, whatever their family",
            sorted(lead20) == ["EXL-ZZ-01-21", "EXL-ZZ-03-22"], lead20)
    lead21 = [r["profile"]["job_code"] for r in routes("ZZF-FIN-03-21") if r["route"] == "leadership track"]
    lead22 = [r["profile"]["job_code"] for r in routes("ZZF-FIN-04-22") if r["route"] == "leadership track"]
    s.check("...from JG 21 the BU CEO roles, from JG 22 the BG CEO / Group C-suite ones",
            sorted(lead21) == ["EXL-ZZ-01-22", "EXL-ZZ-03-22"] and lead22 == ["EXL-ZZ-01-23"], (lead21, lead22))
    lead19 = sorted(r["profile"]["job_code"] for r in routes("ZZF-FIN-01-A-19") if r["profile"]["job_code"].startswith("EXL"))
    # from JG 19 too, two grades up (Chris, 2026-10-19: "Yes, from JG 19 at +2"): the JG 21 roles, never a JG 20 one
    s.check("...from JG 19, two grades up: the JG 21 leadership roles only", lead19 == ["EXL-ZZ-01-21"], lead19)
    s.check("...never from JG 18", not [r for r in routes("ZZF-FIN-01-A-18") if r["profile"]["job_code"].startswith("EXL")])
    r20 = [r["profile"]["job_code"] for r in routes("ZZF-FIN-02-20")]
    s.check("...never three grades up, and each leadership job once, at its nearest grade",
            "EXL-ZZ-01-23" not in r20 and "EXL-ZZ-01-22" not in r20, r20)
    s.check("the Career Plan orders it right after the next grade", a.TC_ROUTE_ORDER["leadership track"] == 1
            and a.TC_ROUTE_ORDER["next grade in this job"] == 0)

    s.section("the importer")
    spec = importlib.util.spec_from_file_location("imp", os.path.join(H.REPO, "tools", "import_competency_profiles.py"))
    imp = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(imp)
    file_rows = [{"job_code": c, "title": "x", "department": "ZZ Finance", "grade": c.rsplit("-", 1)[1]} for c in ID]
    _u, _ad, _rn, deact = ctx(lambda d: imp.plan(d, file_rows))
    s.check("a re-import without the target roles never retires them",
            not [g for g in deact if g["job_code"].startswith("ZZF-FIN-01-A")])
    _u2, ad2, _rn2, deact2 = ctx(lambda d: imp.plan(d, file_rows + [{"job_code": "ZZF-FIN-01-A-19", "job_scope": "AGM X",
                                                                     "title": "AGM X", "department": "ZZ Finance",
                                                                     "grade": "19"}]))
    s.check("...and once the file holds a target role's job code, the file supersedes it",
            any(g["job_code"] == "ZZF-FIN-01-A-19" for g in deact2) or tg["ZZF-FIN-01-A-19"]["id"] in ad2.values())
    u3, _a3, _r3, _d3 = ctx(lambda d: imp.plan(d, file_rows + [{"job_code": "ZZF-FIN-01-A-20", "title": "GM",
                                                                 "department": "ZZ Finance", "grade": "20"}]))
    s.check("...taking its row over where the job scope matches", u3.get(("ZZF-FIN-01-A-20", "")) == tg["ZZF-FIN-01-A-20"]["id"])
    # applied, on a throwaway copy: a file profile is an architecture row from then on, unless the file marks it a
    # target role (the 2026-10-19 re-mapping carries the target roles too), which keeps it one
    import shutil, sqlite3 as _sq, json as _js, tempfile as _tf
    _tmpd = _tf.mkdtemp(dir=os.path.dirname(a.DB_PATH))
    assert H.SCRATCH_MARKER in _tmpd
    _cp = os.path.join(_tmpd, "imp.db")
    _c0 = _sq.connect(a.DB_PATH); _c1 = _sq.connect(_cp); _c0.backup(_c1); _c1.close(); _c0.close()
    _sk = [{"code": "ZZT-IMP-%d001-1.0" % L, "title": "ZZ Import Skill", "type": "tsc", "category": "ZZ", "level": L}
           for L in (5, 6)]
    _mp = {"version": "zz-test", "skills": _sk, "profiles": [
        dict(r, current=["ZZT-IMP-5001-1.0"], future=["ZZT-IMP-6001-1.0"], review_status="draft") for r in
        [{"job_code": "ZZF-FIN-01-A-19", "title": "ZZ AGM kept a target", "department": "ZZ Finance", "grade": "19",
          "source": "target"},
         {"job_code": "ZZF-FIN-01-A-20", "title": "ZZ GM now held", "department": "ZZ Finance", "grade": "20"}]]}
    _mf = os.path.join(_tmpd, "m.json")
    open(_mf, "w").write(_js.dumps(_mp))
    imp.main([_mf, "--db", _cp, "--apply", "--allow-unapproved"])
    _c2 = _sq.connect(_cp)
    _srcs = dict(_c2.execute("SELECT job_code, source FROM tc_job_profiles WHERE job_code IN ('ZZF-FIN-01-A-19', "
                             "'ZZF-FIN-01-A-20') AND active=1").fetchall())
    _c2.close()
    shutil.rmtree(_tmpd, ignore_errors=True)
    s.check("...applied: an architecture row from then on, unless the file marks it a target role, which stays one",
            _srcs == {"ZZF-FIN-01-A-19": "target", "ZZF-FIN-01-A-20": "architecture"}, _srcs)

    s.section("the page, after the fill")
    pg = SUP.get("/admin/career-routes?job=ZZF-FIN-01-A").get_data(as_text=True)
    lad = pg[pg.find('class="cr-table"'):pg.find("</table>", pg.find('class="cr-table"'))]
    gs_ = [int(x) for x in re.findall(r'cr-gp[^"]*">JG (\d+)<', lad)]
    s.check("the ladder: JG 23 down to its first grade, target roles tagged",
            gs_ == list(range(23, 11, -1)) and "Target role" in lad and "Nobody holds JG 19" not in lad, gs_)
    s.check("...the leadership track above the job, with its roles", "On the leadership track" in pg
            and "Group Chief Executive Officer, ZZ" in pg)
    pid14 = ID["ZZF-FIN-01-A-14"]
    pg = SUP.get("/admin/career-routes?job=ZZF-FIN-01-A&g=14&pid=%d&panel=routes" % pid14).get_data(as_text=True)
    pn = pg[pg.find('id="pnl-routes"'):]
    s.check("a grade picked: the routes panel, the next step first", 'id="pnl-routes"' in pg and "Next step" in pn
            and "Assistant Manager, Finance Partner" in pn
            and (re.findall(r"<h3>([^<]+)</h3>", pn) or [""])[0] == "Next grade in this job",
            re.findall(r"<h3>([^<]+)</h3>", pn))
    to = ID["ZZF-FIN-02-20"]
    SUP.post("/admin/career-routes", data={"csrf_token": "tok", "from_profile_id": str(pid14), "to_profile_id": str(to),
                                           "kind": "pinned"})
    s.check("pin: kept as HR's", H.one(a, "SELECT kind FROM tc_career_routes WHERE from_profile_id=? AND to_profile_id=?",
                                       (pid14, to)) == "pinned")
    tgt15 = tg["ZZF-FIN-01-A-15"]["id"]
    SUP.post("/admin/career-routes", data={"csrf_token": "tok", "from_profile_id": str(pid14), "to_profile_id": str(tgt15),
                                           "kind": "hidden"})
    pg = SUP.get("/admin/career-routes?job=ZZF-FIN-01-A&g=14&pid=%d&panel=routes" % pid14).get_data(as_text=True)
    s.check("hide: listed under Hidden by Group People, gone from the routes", "Hidden by Group People" in pg
            and not [r for r in routes("ZZF-FIN-01-A-14") if r["profile"]["id"] == tgt15])
    SUP.post("/admin/career-routes", data={"csrf_token": "tok", "from_profile_id": str(pid14), "to_profile_id": str(tgt15),
                                           "kind": "clear"})
    s.check("show again: back in the routes", [r for r in routes("ZZF-FIN-01-A-14") if r["profile"]["id"] == tgt15])
    s.check("a BG admin can't pin", BAC.post("/admin/career-routes", data={
        "csrf_token": "tok", "from_profile_id": str(pid14), "to_profile_id": str(to), "kind": "pinned"}).status_code == 403)
    r = SUP.get("/admin/career-routes?profile=%d" % pid14)
    s.check("an older ?profile= link lands on its job and grade, the panel open", r.status_code == 302
            and "job=ZZF-FIN-01-A" in r.headers["Location"] and "panel=routes" in r.headers["Location"])
    s.check("each pin, hide and show again is in the audit log", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE id>? AND action='career_route'", (LOG0,)) == 3)
    lib = SUP.get("/admin/competency/library?job=%d" % tgt15).get_data(as_text=True)
    s.check("the competency library tags a target role", ">Target role</span>" in lib)
    st = SUP.get("/admin/m/idp/settings").get_data(as_text=True)
    s.check("the settings card counts the target roles", re.search(r"From the job architecture · \d+ target role", st)
            is not None)
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _db.execute("DELETE FROM activity_log WHERE id>? AND action IN ('career_targets','career_route')", (LOG0,))
        _cleanup(_db)

sys.exit(s.done())
