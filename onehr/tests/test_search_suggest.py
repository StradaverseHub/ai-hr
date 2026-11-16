"""Search as you type (Chris, 2026-10-27): the search boxes that answered only on Enter suggest matches from 2 letters.

What this suite holds:
  * one read-only GET route, /suggest?kind=&q=, returns [{"v": text to search on, "m": a muted line}], at most 8, nothing
    under 2 letters, an unknown kind 404, POST refused; it writes nothing
  * each kind finds a known term: people (honouring the Search in field), competencies, KPIs, jobs, audit, programmes,
    and the two staff Learning boxes
  * each kind is gated like its page: a BG admin never gets a person outside their group (falsified: the super admin
    does), a non-admin is refused the admin kinds, the audit log is the super admin's, Learning is dark when
    ONEHR_LMS is off
  * template lint: every one of the search boxes carries data-suggest (and the markup the script needs)
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Search as you type")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _EMP = H.actors(a)
BG_A, BG_B = "ZZSG Alpha Group", "ZZSG Beta Group"
_lms0 = os.environ.get("ONEHR_LMS")


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9SG-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM tc_skills WHERE title LIKE 'ZZSG %'")
    db.execute("DELETE FROM tc_job_profiles WHERE job_code LIKE 'ZQS-%'")
    db.execute("DELETE FROM pm_kpi_library WHERE kpi_name LIKE 'ZZSG %'")
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZSG %'")
    db.commit()


def _user(db, eid, name, bg, role="user", admin_bg=None, grade="14", company="ZSU"):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, job_grade, "
        "job_title, department, admin_bg, confirmation_date) VALUES (?, ?, 'x', ?, ?, ?, ?, ?, 'ZZSG Planner', 'ZZSG Dept', "
        "?, '2020-01-01')", (eid.lower(), name, role, eid, bg, company, grade, admin_bg)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    U1 = _user(db, "ZZ9SG-1", "ZZSG Alpha Person", BG_A)
    U2 = _user(db, "ZZ9SG-2", "ZZSG Beta Person", BG_B)
    ADM = _user(db, "ZZ9SG-A", "ZZSG Alpha Admin", BG_A, role="admin", admin_bg=BG_A)
    EMPL = _user(db, "ZZ9SG-E", "ZZSG Plain Employee", BG_A)
    for i in range(12):   # more than 8 matches
        _user(db, "ZZ9SG-M%02d" % i, "ZZSG Many %02d" % i, BG_A)
    for lvl, code in ((3, "ZQS-ABC-3001-1.1"), (4, "ZQS-ABC-4001-1.1")):
        db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, active) VALUES (?, "
                   "'ZZSG Skill Alpha', ?, 'TSC', 'ZZSG Cat', 1)", (code, lvl))
    db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, review_status, plan_mode, source, "
               "active) VALUES ('ZZSG Dept', 'ZZSG Job Alpha', '16', 'ZQS-JOB-01-16', 'draft', 'explicit', 'arch', 1)")
    for bg, nm in ((BG_A, "ZZSG Revenue Alpha"), (BG_B, "ZZSG Revenue Beta")):
        db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, method, "
                   "active) VALUES (?, '*', '*', 0, '*', ?, 'more', 1)", (bg, nm))
    db.execute("INSERT INTO lms_programmes(title, category, status) VALUES ('ZZSG Programme Alpha', 'ZZSG Leadership', "
               "'published')")
    db.execute("INSERT INTO lms_programmes(title, category, status) VALUES ('ZZSG Programme Draft', 'ZZSG Leadership', "
               "'draft')")
    db.execute("INSERT INTO activity_log(user_id, action, detail, target_user_id) VALUES (?, 'user_edit', 'zzsg test', ?)",
               (SU["id"], U1))
    db.commit()
SUP = H.client_as(a, SU["id"])
BGA = H.client_as(a, ADM)
EMPC = H.client_as(a, EMPL)
SG = "/suggest"


def get(c, **kw):
    return c.get(SG, query_string=kw)


def vals(r):
    return [x["v"] for x in (r.get_json(silent=True) or [])]


def counts(db):
    return [db.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0] for t in
            ("users", "activity_log", "tc_skills", "tc_job_profiles", "pm_kpi_library", "lms_programmes", "tc_assignments")]


try:
    os.environ.pop("ONEHR_LMS", None)
    s.section("the route")
    r = get(SUP, kind="people", q="ZZSG Alpha P")
    j = r.get_json()
    s.check("people: a known name comes back as {v, m}, the person's name and 'Employee ID · unit'",
            r.status_code == 200 and "ZZSG Alpha Person" in vals(r)
            and any(x["v"] == "ZZSG Alpha Person" and "ZZ9SG-1" in x["m"] and "ZSU" in x["m"] for x in j))
    s.check("nothing under 2 letters", all(get(SUP, kind=k, q="Z").get_json() == [] for k in
                                           ("people", "competencies", "kpis", "jobs", "audit")))
    s.check("one letter plus spaces is still under 2", get(SUP, kind="people", q=" Z ").get_json() == [])
    big = get(SUP, kind="people", q="ZZSG Many").get_json()
    s.check("never more than 8 (12 people match)", len(big) == 8)
    s.check("an unknown kind is 404 and a missing one too", get(SUP, kind="nope", q="ab").status_code == 404
            and get(SUP, q="ab").status_code == 404)
    s.check("GET only: a POST is refused", SUP.post(SG, data={"csrf_token": "tok", "kind": "people", "q": "ab"}).status_code == 405)
    anon = a.app.test_client().get(SG + "?kind=people&q=ab")
    s.check("signed out: the sign-in redirect (the route probe's expectation), never data",
            anon.status_code in (301, 302) and "/login" in (anon.headers.get("Location") or ""))
    s.check("a bare /suggest while signed out is a redirect too, not a 404",
            a.app.test_client().get(SG).status_code in (301, 302))

    s.section("people: Search in and scope")
    s.check("Employee ID field: the ID is the value", "ZZ9SG-1" in vals(get(SUP, kind="people", q="ZZ9SG-1", qin="eid",
                                                                           src="admin_users")))
    s.check("Employee ID field does not match a name", "ZZSG Alpha Person" not in vals(
        get(SUP, kind="people", q="ZZSG Alpha P", qin="eid", src="admin_users")))
    jt = get(SUP, kind="people", q="ZZSG Plan", qin="title", src="admin_users").get_json()
    s.check("a field of few values (Job title) suggests the title once, with how many hold it",
            [x["v"] for x in jt].count("ZZSG Planner") == 1 and any("people" in x["m"] for x in jt))
    with a.app.app_context():   # a numeric job grade is an int to SQLite: the ranking must not assume text
        _d = a.get_db()
        _d.execute("UPDATE users SET job_grade=CAST(job_grade AS INTEGER) WHERE id=?", (U1,))
        _d.commit()
        _gt = _d.execute("SELECT typeof(job_grade) FROM users WHERE id=?", (U1,)).fetchone()[0]
    rg = get(SUP, kind="people", q="14", qin="grade", src="admin_users")
    s.check("Job grade: a numeric grade (stored as an integer) is suggested, not a 500",
            _gt == "integer" and rg.status_code == 200 and "14" in vals(rg), (_gt, rg.status_code))
    s.check("_suggest_rank takes a number as well as text",
            a._suggest_rank(15, "1") == 0 and a._suggest_rank(25, "1") == 2 and a._suggest_rank(None, "1") == 2
            and a._suggest_rank("Chief Planner", "pl") == 1)
    sup_vals = vals(get(SUP, kind="people", q="ZZSG Beta Person", src="admin_users"))
    bga_vals = vals(get(BGA, kind="people", q="ZZSG Beta Person", src="admin_users"))
    s.check("a BG admin never gets a person outside their group, and the super admin does (guard falsified)",
            "ZZSG Beta Person" in sup_vals and "ZZSG Beta Person" not in bga_vals)
    s.check("a BG admin does get their own group's person",
            "ZZSG Alpha Person" in vals(get(BGA, kind="people", q="ZZSG Alpha P", src="admin_users")))
    for ep in ("admin_participants", "admin_subjects", "admin_assessors", "admin_module_progress"):
        kw = {"key": "pm"} if ep == "admin_module_progress" else {}
        s.check("%s: the BG admin is held to their group there too" % ep,
                "ZZSG Beta Person" not in vals(get(BGA, kind="people", q="ZZSG Beta Person", src=ep, **kw)))
    s.check("an unknown page claim is refused, never read as People (a listed page and an absent claim answer)",
            get(SUP, kind="people", q="ZZSG Alpha P", src="admin_nope").status_code == 403
            and get(BGA, kind="people", q="ZZSG Alpha P", src="admin_nope").status_code == 403
            and get(SUP, kind="people", q="ZZSG Alpha P", src="admin_users").status_code == 200
            and "ZZSG Alpha Person" in vals(get(SUP, kind="people", q="ZZSG Alpha P")))
    s.check("Subjects and Assessors name only people holding an assignment in the viewed cycle (guard falsified: People does name them)",
            all("ZZSG Alpha Person" not in vals(get(SUP, kind="people", q="ZZSG Alpha P", src=ep))
                for ep in ("admin_subjects", "admin_assessors"))
            and "ZZSG Alpha Person" in vals(get(SUP, kind="people", q="ZZSG Alpha P", src="admin_users")))
    s.check("Module progress answers (its population is participant_sql, as the page's own list)",
            get(SUP, kind="people", q="ZZSG Alpha P", src="admin_module_progress", key="pm").status_code == 200)
    s.check("an admin's own login never shows as a person in the lists", "ZZSG Alpha Admin" not in vals(
        get(SUP, kind="people", q="ZZSG Alpha Adm", src="admin_users")))
    with a.app.app_context():
        _d = a.get_db()
        _d.execute("UPDATE users SET left_at=datetime('now') WHERE id=?", (U2,))
        _d.commit()
    s.check("a leaver is not suggested on the active list, and is on Show: Left",
            "ZZSG Beta Person" not in vals(get(SUP, kind="people", q="ZZSG Beta Person", src="admin_users"))
            and "ZZSG Beta Person" in vals(get(SUP, kind="people", q="ZZSG Beta Person", src="admin_users", show="left")))
    with a.app.app_context():
        _d = a.get_db()
        _d.execute("UPDATE users SET left_at=NULL WHERE id=?", (U2,))
        _d.commit()

    s.section("the libraries and the audit log")
    s.check("competencies: a title, once (two levels), with its category",
            any(x["v"] == "ZZSG Skill Alpha" and x["m"] == "ZZSG Cat" for x in get(SUP, kind="competencies", q="ZZSG Skill").get_json())
            and vals(get(SUP, kind="competencies", q="ZZSG Skill")).count("ZZSG Skill Alpha") == 1)
    s.check("competencies: a code finds it, filled with the code",
            "ZQS-ABC-3001-1.1" in vals(get(SUP, kind="competencies", q="zqs-abc-3")))
    s.check("competencies: a BG admin sees only what their groups' jobs use (none here); the super admin does",
            "ZZSG Skill Alpha" not in vals(get(BGA, kind="competencies", q="ZZSG Skill"))
            and "ZZSG Skill Alpha" in vals(get(SUP, kind="competencies", q="ZZSG Skill")))
    s.check("kpis: the super admin sees both groups' KPIs, each with its group",
            {"ZZSG Revenue Alpha", "ZZSG Revenue Beta"} <= set(vals(get(SUP, kind="kpis", q="ZZSG Revenue"))))
    s.check("kpis: a BG admin gets their own group's only (guard falsified by the line above)",
            vals(get(BGA, kind="kpis", q="ZZSG Revenue")) == ["ZZSG Revenue Alpha"])
    s.check("jobs: a title, with its code; the library follows the group, the career map does not",
            any(x["v"] == "ZZSG Job Alpha" and "ZQS-JOB-01-16" in x["m"] for x in get(SUP, kind="jobs", q="ZZSG Job", src="library").get_json())
            and "ZZSG Job Alpha" not in vals(get(BGA, kind="jobs", q="ZZSG Job", src="library"))
            and "ZZSG Job Alpha" in vals(get(BGA, kind="jobs", q="ZZSG Job", src="routes")))
    s.check("jobs: a code finds it in the library", "ZQS-JOB-01-16" in vals(get(SUP, kind="jobs", q="zqs-job", src="library")))
    aj = get(SUP, kind="audit", q="ZZSG Alpha P").get_json()
    s.check("audit: a person the log names, with their Employee ID", any(x["v"] == "ZZSG Alpha Person" and "ZZ9SG-1" in x["m"] for x in aj))
    s.check("audit: an Employee ID finds them", "ZZ9SG-1" in vals(get(SUP, kind="audit", q="ZZ9SG-1")) or
            "ZZSG Alpha Person" in vals(get(SUP, kind="audit", q="ZZ9SG-1")))
    s.check("audit: a person the log never names is not offered", "ZZSG Beta Person" not in vals(get(SUP, kind="audit", q="ZZSG Beta")))
    s.check("audit is the super admin's: a BG admin and an employee are refused",
            get(BGA, kind="audit", q="ZZSG Alpha P").status_code == 403 and get(EMPC, kind="audit", q="ZZSG Alpha P").status_code == 403)

    s.section("gates")
    for k in ("people", "competencies", "kpis", "jobs"):
        s.check("%s: a non-admin is refused (falsified: the super admin is answered)" % k,
                get(EMPC, kind=k, q="ZZSG").status_code == 403 and get(SUP, kind=k, q="ZZSG").status_code == 200)

    s.section("Learning: dark unless ONEHR_LMS=1")
    for k, q_ in (("programmes", "ZZSG Prog"), ("learning", "ZZSG Skill"), ("learning_prog", "ZZSG Prog")):
        s.check("%s: 404 while Learning is off" % k, get(SUP, kind=k, q=q_).status_code == 404 and get(EMPC, kind=k, q=q_).status_code == 404)
    os.environ["ONEHR_LMS"] = "1"
    pr = get(SUP, kind="programmes", q="ZZSG Prog")
    s.check("programmes (admin): every status, with the status as meta",
            {x["v"]: x["m"] for x in pr.get_json()}.get("ZZSG Programme Alpha") == "Published"
            and "ZZSG Programme Draft" in vals(pr))
    s.check("programmes (admin): a category finds its programmes' category", "ZZSG Leadership" in vals(get(SUP, kind="programmes", q="ZZSG Lead")))
    s.check("programmes (admin): an employee is refused", get(EMPC, kind="programmes", q="ZZSG Prog").status_code == 403)
    lp = get(EMPC, kind="learning_prog", q="ZZSG Prog")
    s.check("learning_prog (staff): the published programme only, never a draft",
            lp.status_code == 200 and "ZZSG Programme Alpha" in vals(lp) and "ZZSG Programme Draft" not in vals(lp))
    lx = get(EMPC, kind="learning", q="ZZSG Skill")
    s.check("learning (staff): a competency from the catalogue", lx.status_code == 200 and "ZZSG Skill Alpha" in vals(lx))
    s.check("learning kinds are the staff's: an admin gets 404", get(SUP, kind="learning", q="ZZSG Skill").status_code == 404)

    s.section("nothing is written")
    with a.app.app_context():
        before = counts(a.get_db())
    for k, q_ in (("people", "ZZSG"), ("competencies", "ZZSG"), ("kpis", "ZZSG"), ("jobs", "ZZSG"), ("audit", "ZZSG"),
                  ("programmes", "ZZSG")):
        get(SUP, kind=k, q=q_)
    for k in ("learning", "learning_prog"):
        get(EMPC, kind=k, q="ZZSG")
    get(BGA, kind="people", q="ZZSG", src="admin_users")
    with a.app.app_context():
        after = counts(a.get_db())
    s.check("every table the kinds read has the same number of rows after", before == after, (before, after))

    s.section("template lint: every search box suggests")
    T = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "templates")

    def rd(p):
        return open(os.path.join(T, p), encoding="utf-8").read()

    def tag_of(src, needle):
        i = src.index(needle)
        st = src.rfind("<input", 0, i)
        return src[st:src.index(">", i) + 1]
    BOXES = [("_search_in.html", 'aria-label="{{ label }}"', "people"),
             ("admin_competency_catalogue.html", 'id="cc-q"', "competencies"),
             ("admin_kpi_library.html", 'aria-label="Search the library"', "kpis"),
             ("admin_competency_library.html", 'aria-label="Find a job"', "jobs"),
             ("admin_career_tree.html", 'aria-label="Find a job"', "jobs"),
             ("admin_audit_log.html", 'name="q" value="{{ q }}" placeholder="Search by admin', "audit"),
             ("admin_learning_programmes.html", 'id="lm-pq"', "programmes"),
             ("learning/_panel.html", 'id="lm-q"', "learning"),
             ("learning/_panel.html", 'id="lm-cq"', "learning_prog")]
    for f, needle, kind in BOXES:
        t = tag_of(rd(f), needle)
        s.check("%s (%s) carries data-suggest=%s, its url, autocomplete off and the aria hooks" % (f, needle[:22], kind),
                'data-suggest="%s"' % kind in t and "data-suggest-url=" in t and 'autocomplete="off"' in t
                and 'aria-autocomplete="list"' in t and 'aria-expanded="false"' in t, t[:160])
    s.check("the six people lists draw the macro, so each carries the people box",
            all("search_in_box(" in rd(p) for p in ("admin_users.html", "admin_users_bulk.html", "admin_participants.html",
                                                    "admin_subjects.html", "admin_assessors.html", "admin_module_progress.html")))
    # no box marked data-no-qin (a search that isn't a people list) was left without it
    loose = []
    for root, _d, files in os.walk(T):
        for fn in files:
            if fn.endswith(".html"):
                src = open(os.path.join(root, fn), encoding="utf-8").read()
                for m in re.finditer(r"<input[^>]*data-no-qin=[^>]*>", src):
                    if "data-suggest=" not in m.group(0) and 'type="search"' in m.group(0):
                        loose.append(fn + ": " + m.group(0)[:80])
    s.check("every search box that says why it is not a people list suggests", loose == [], loose)
    s.check("the script is on every signed-in page", "suggest.js" in rd("base.html"))
    pg = SUP.get("/admin/users").get_data(as_text=True)
    s.check("a rendered People page has the box stamped with its page and the script",
            'data-suggest="people"' in pg and 'data-suggest-src="admin_users"' in pg and "suggest.js" in pg)
finally:
    if _lms0 is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = _lms0
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
