"""AI+ Learning: needs by business group, business unit and job family (Chris, 2026-10-22: "learning needs analysis by
global (all need), BG-specific, BU-specific, and job family"; canvas board 7B; "ok, build all of it on staging").

What this suite holds:
  * a view at a time: business group, business unit or job family (the architecture's SUB-family); every view adds up
    to the same need per competency
  * "No job family yet": below JG 12, or not mapped in the architecture
  * the columns: the most need first, the first few shown and the rest as one "Other" column (its cells the sum of the
    rest), never an "Other" of one, "none" last; the download has every column
  * the job-family filter narrows to one family, or to "No job family yet"; it never widens a group admin's scope, who
    has no group view
  * the AI read's facts and the cache key follow the view and the filter (the defaults keep today's key); the read
    returns to the same view
  * the page: the View by pills, the job-family filter, the note
Everything here is synthetic (ZZLV / ZZ9LV-) and removed at the end.
"""
import html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning: needs by group, unit and job family")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, BG2 = "ZZLV Group", "ZZLV Other Group"
U1, U2 = "ZZLV UNIT ONE SDN BHD", "ZZLV UNIT TWO SDN BHD"
_ENV0 = os.environ.get("ONEHR_LMS")
_AI0, _READ0 = a.ai_draft.is_configured, a.ai_draft.lms_needs_read
_COLS0 = a.LMS_LNA_COLS


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LV-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM lms_interest WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM ja_people WHERE employee_id LIKE 'ZZ9LV-%'")
    db.execute("DELETE FROM ja_taxonomy WHERE code LIKE 'ZZLV-%'")
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZLV-%'")
    db.execute("DELETE FROM lms_reads WHERE scope_key LIKE 'lna|ZZLV%'")
    db.execute("DELETE FROM org_units WHERE business_group IN (?, ?)", (BG, BG2))
    db.commit()


def person(db, eid, grade, unit=U1, bg=BG, role="user", admin_bg=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, admin_bg) VALUES (?,?, 'x', ?, ?,?,?, 'ZZLV Ops', 'ZZLV Officer', "
                      "?, ?)", (eid.lower(), "ZZ LV " + eid.split("-")[1], role, eid, bg, unit, grade,
                                admin_bg)).lastrowid


def jf(db, eid, code):
    db.execute("INSERT INTO ja_people(employee_id, sub_code, source) VALUES (?, ?, 'test')", (eid, code))


def want(db, uid, key):
    db.execute("INSERT INTO lms_interest(user_id, kind, comp_key) VALUES (?, 'competency', ?)", (uid, key))


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    for bg_, u_ in ((BG, U1), (BG, U2), (BG2, "ZZLV UNIT THREE SDN BHD")):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (bg_, u_))
    K = {}
    for i, t in enumerate(("ZZLV Alpha", "ZZLV Beta", "ZZLV Gamma"), 1):
        db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, proficiency_description, "
                   "active) VALUES (?,?,3,'tsc','ZZLV','x',1)", ("ZZLV-AAA-3%03d-1.0" % i, t))
        K[t.split()[1]] = "ZZLV-AAA-%03d" % i
    db.execute("INSERT INTO ja_taxonomy(code, level, name) VALUES ('ZZLV-FIN', 'sub', 'ZZLV Finance')")
    db.execute("INSERT INTO ja_taxonomy(code, level, name) VALUES ('ZZLV-SAL', 'sub', 'ZZLV Sales')")
    E1, E2 = person(db, "ZZ9LV-E1", "15"), person(db, "ZZ9LV-E2", "15")
    E3 = person(db, "ZZ9LV-E3", "16", U2)
    E4 = person(db, "ZZ9LV-E4", "10", U2)     # below JG 12: no job family, even with an architecture row
    E5 = person(db, "ZZ9LV-E5", "14", U2)     # not mapped
    jf(db, "ZZ9LV-E1", "ZZLV-FIN")
    jf(db, "ZZ9LV-E2", "ZZLV-FIN")
    jf(db, "ZZ9LV-E3", "ZZLV-SAL")
    jf(db, "ZZ9LV-E4", "ZZLV-FIN")
    want(db, E1, K["Alpha"])
    want(db, E2, K["Alpha"])
    want(db, E2, K["Beta"])
    want(db, E3, K["Alpha"])
    want(db, E4, K["Beta"])
    want(db, E5, K["Alpha"])
    EXTRA = []
    for i in range(1, 10):                    # nine more job families, one person each, all needing Gamma
        code = "ZZLV-J%02d" % i
        db.execute("INSERT INTO ja_taxonomy(code, level, name) VALUES (?, 'sub', ?)", (code, "ZZLV Family %02d" % i))
        uid = person(db, "ZZ9LV-X%d" % i, "13")
        jf(db, "ZZ9LV-X%d" % i, code)
        want(db, uid, K["Gamma"])
        EXTRA.append(uid)
    O1 = person(db, "ZZ9LV-O1", "15", "ZZLV UNIT THREE SDN BHD", BG2)   # another group, the same family as E1
    jf(db, "ZZ9LV-O1", "ZZLV-FIN")
    want(db, O1, K["Alpha"])
    LND = person(db, "ZZ9LV-LND", None, None, None, "admin", a.LMS_ADMIN_BG)
    BGA = person(db, "ZZ9LV-BGA", None, None, BG, "admin", BG)
    db.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def user(uid):
    with a.app.app_context():
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def lna(uid, **kw):
    with a.app.app_context():
        return a.lms_lna(a.get_db(), user(uid), **kw)


def row(l_, key):
    return next((r for r in l_["rows"] if r["key"] == key), None)


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


try:
    env("1")
    s.section("a view at a time")
    J = lna(LND, bg=BG, view="jf")
    al = row(J, K["Alpha"])
    s.check("by job family: the sub-family's name is the column", J["view"] == "jf" and al and
            al["cells"].get("ZZLV Finance") == 2 and al["cells"].get("ZZLV Sales") == 1, dict(al["cells"]) if al else J)
    s.check("below JG 12 or not mapped: 'No job family yet' (an architecture row under JG 12 doesn't count)",
            al and al["cells"].get(a.LMS_NO_JF) == 1 and row(J, K["Beta"])["cells"].get(a.LMS_NO_JF) == 1
            and row(J, K["Beta"])["cells"].get("ZZLV Finance") == 1, dict(row(J, K["Beta"])["cells"]))
    U = lna(LND, bg=BG, view="bu")
    G = lna(LND, bg=BG, view="bg")
    with a.app.app_context():
        u1_name = a.display_company(BG, U1)
    s.check("by business unit, with the unit's preferred name", U["view"] == "bu" and
            row(U, K["Alpha"])["cells"].get(U1) == 2 and U["labels"].get(U1) == u1_name, U["labels"])
    s.check("every view adds up to the same need per competency", all(
        sum(v for c, v in row(V, k)["cells"].items() if c != "__other__") == row(V, k)["n"] == row(J, k)["n"]
        for V in (J, U, G) for k in K.values()), [(row(J, k)["n"], row(U, k)["n"], row(G, k)["n"]) for k in K.values()])
    s.check("a group picked: by unit by default, its key as before", lna(LND, bg=BG)["view"] == "bu"
            and lna(LND, bg=BG)["scope_key"] == "lna|%s||" % BG)
    s.check("...another view or a job family adds to the key", J["scope_key"] == "lna|%s|||v=jf" % BG and
            lna(LND, bg=BG, view="jf", jf="ZZLV-FIN")["scope_key"] == "lna|%s|||v=jf|jf=ZZLV-FIN" % BG)

    s.section("the columns")
    gm = row(J, K["Gamma"])
    labels = [c["label"] for c in J["shown_cols"]]
    s.check("the most need first; the first %d shown, the rest as one Other, 'No job family yet' last" % a.LMS_LNA_COLS,
            labels[0] == "ZZLV Finance" and len(labels) == a.LMS_LNA_COLS + 2 and labels[-2] == "Other %d"
            % (11 - a.LMS_LNA_COLS) and labels[-1] == a.LMS_NO_JF, labels)
    hidden = [c for c in J["cols"] if c not in {x["key"] for x in J["shown_cols"]}]
    s.check("...Other's cell is the sum of the columns it holds", gm["cells"]["__other__"] == sum(
        gm["cells"].get(c, 0) for c in hidden) and gm["cells"]["__other__"] > 0, (gm["cells"]["__other__"], hidden))
    s.check("...every column kept for the download", len(J["cols"]) == 12 and J["cols"][-1] == a.LMS_NO_JF, J["cols"])
    a.LMS_LNA_COLS = 10
    J10 = lna(LND, bg=BG, view="jf")
    a.LMS_LNA_COLS = _COLS0
    s.check("never an 'Other' of one (11 families, 10 to show: all 11 shown)",
            not any(c["key"] == "__other__" for c in J10["shown_cols"]) and len(J10["shown_cols"]) == 12,
            [c["label"] for c in J10["shown_cols"]])

    s.section("the job-family filter, and a group admin's scope")
    F = lna(LND, bg=BG, view="jf", jf="ZZLV-FIN")
    s.check("one job family: its people only", F["tiles"]["people"] == 2 and row(F, K["Alpha"])["n"] == 2
            and row(F, K["Beta"])["n"] == 1, F["tiles"])
    N = lna(LND, bg=BG, view="jf", jf=a.LMS_LNA_NONE)
    s.check("'No job family yet': below JG 12 and the unmapped", N["tiles"]["people"] == 2 and
            row(N, K["Alpha"])["n"] == 1 and row(N, K["Beta"])["n"] == 1, N["tiles"])
    s.check("the family list comes from the people in scope", ("ZZLV-FIN", "ZZLV Finance") in J["jf_opts"]
            and ("ZZLV-SAL", "ZZLV Sales") in J["jf_opts"])
    B = lna(BGA, view="bg", jf="ZZLV-FIN")
    s.check("a group admin: no group view (by unit instead)", B["view"] == "bu" and B["bg"] == BG, B["view"])
    s.check("...and a job family never widens it (the other group's Finance person stays out)",
            B["tiles"]["people"] == 2, B["tiles"])
    BA = lna(BGA, view="jf", bg=BG2)
    s.check("...nor another group asked for", BA["bg"] == BG and row(BA, K["Alpha"])["n"] == 4,
            row(BA, K["Alpha"])["n"] if row(BA, K["Alpha"]) else BA)
    W = lna(LND, view="jf", jf="ZZLV-FIN")
    s.check("L&D, all groups: the family across groups (the other group's person counts)",
            W["tiles"]["people"] == 3 and row(W, K["Alpha"])["n"] == 3, W["tiles"])

    s.section("the AI read, the download, the page")
    with a.app.app_context():
        facts = a._lms_needs_facts(J)
        facts_u = a._lms_needs_facts(U)
    s.check("...a unit by its preferred name", u1_name in facts_u and "by business unit" in facts_u, facts_u[:300])
    s.check("the read's facts name the view and its columns", "by job family" in facts and "ZZLV Finance" in facts
            and "__other__" not in facts, facts[:300])
    CL, CB = H.client_as(a, LND), H.client_as(a, BGA)
    a.ai_draft.is_configured = lambda: True
    a.ai_draft.lms_needs_read = lambda f: ["ZZLV Alpha is the most needed."]
    r = CL.post("/admin/learning/needs/read", data={"csrf_token": "tok", "bg": BG, "view": "jf", "jf": "ZZLV-FIN"})
    loc = r.headers.get("Location", "")
    s.check("the read is kept for this view and filter, and returns to it", r.status_code == 302 and "view=jf" in loc
            and "jf=ZZLV-FIN" in loc and one("SELECT COUNT(*) FROM lms_reads WHERE scope_key=?",
                                             ("lna|%s|||v=jf|jf=ZZLV-FIN" % BG,)) == 1, loc)
    x = H.as_csv_text(CL.get("/admin/learning/needs?bg=%s&view=jf&format=xlsx" % BG.replace(" ", "+")))
    head = x.splitlines()[0] if x else ""
    s.check("the download: every job family, none folded into Other", all(
        ("ZZLV Family %02d" % i) in head for i in range(1, 10)) and a.LMS_NO_JF in head and "Other" not in head,
        head[:300])
    page = html.unescape(CL.get("/admin/learning/needs?bg=%s&view=jf" % BG.replace(" ", "+")).get_data(as_text=True))
    s.check("the page: View by, three ways for L&D", "View by" in page and ">Business group</a>" in page and
            ">Business unit</a>" in page and ">Job family</a>" in page)
    s.check("...the job-family filter with 'No job family yet'", 'name="jf"' in page and
            'value="%s"' % a.LMS_LNA_NONE in page and ">ZZLV Finance</option>" in page)
    s.check("...by job family, its note and Other", "by job family" in page and "below JG 12" in page and
            ">Other 5</th>" in page, "")
    page = html.unescape(CB.get("/admin/learning/needs").get_data(as_text=True))
    s.check("a group admin's page: no group view", ">Business unit</a>" in page and ">Business group</a>" not in page)
finally:
    a.LMS_LNA_COLS = _COLS0
    a.ai_draft.is_configured, a.ai_draft.lms_needs_read = _AI0, _READ0
    env(_ENV0)
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
