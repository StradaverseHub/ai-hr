"""The Career Plan's Skills match route (Chris, 2026-11-08, canvas D7dHy7pnqfjCtvcbCXfvqK: "Yes, as drawn").

A person's Career Plan adds up to 3 roles in their OWN job family, from their grade up to two above, where they already hold at
least 3 of the role's 5 competencies at the level it needs (and at least 60% of them) and today's routes do not offer the role.
They come after the recommended step and the roles Group People suggested. The recommended step never changes. What this
suite holds:
  * the rule: 3 held at the level qualifies; 2 of 5, 3 titles but one a level short, 3 of 6, and 2 of 2 do not; another family,
    a hidden role, a role three grades up, one below their grade, a retired role, the demo ladder and a never-offered title do not
  * the cap and the order: four qualify, three show, best match first, then the lower grade, then the title
  * not doubled: a role the job's routes already offer keeps its own tag and shows once; a role Group People suggested shows
    once as Suggested by Group People
  * nothing assessed (no answer on any competency of their own job, or no answers) means no Skills match; a demo account
    is unchanged
  * the candidate order: the recommended step, Group People's suggestions, the Skills match roles, the rest
  * _career_recommended never returns one (an explicit guard), even a 5-of-5 role one grade up
  * the role card and the route count on ONE helper (_career_person_held / _career_person_basis): card match == route match
  * the suggest-a-role picker greys one ("Already in their Career Plan: a skills match") and _person_suggest_refusal and the
    POST refuse it, from the list the person sees
  * what the agents, Ask OneHR, Help and the KB say
Everything is synthetic (ZZ9SM..., ZZSM ...) and removed at the end."""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Career Plan: the Skills match route")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, _E = H.actors(a)
BG = "ZZSM Group"
LABEL = "skills match"
SG_LABEL = "suggested by Group People"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9SM-%' OR employee_id LIKE 'ZZA9SM-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM tc_person_routes WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM pm_career_profile WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM tc_scores WHERE assessment_id IN (SELECT id FROM tc_assessments WHERE subject_id IN (%s))" % ph, ids)
        db.execute("DELETE FROM tc_assignments WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM tc_assessments WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM ja_people WHERE employee_id LIKE 'ZZ9SM-%' OR employee_id LIKE 'ZZA9SM-%'")
    pids = [r[0] for r in db.execute("SELECT id FROM tc_job_profiles WHERE job_title LIKE 'ZZSM %' OR job_code LIKE 'ZQS-%' "
                                     "OR job_code LIKE 'ZQT-%'")]
    if pids:
        ph = ",".join("?" * len(pids))
        db.execute("DELETE FROM tc_person_routes WHERE to_profile_id IN (%s)" % ph, pids)
        db.execute("DELETE FROM tc_career_routes WHERE from_profile_id IN (%s) OR to_profile_id IN (%s)" % (ph, ph), pids + pids)
        db.execute("DELETE FROM tc_job_profile_skills WHERE profile_id IN (%s)" % ph, pids)
        db.execute("DELETE FROM tc_job_profiles WHERE id IN (%s)" % ph, pids)
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZSM-%'")
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    SK = {}
    for t in "ABCDEFGHIJKLMNOPQ":
        for lv in (3, 4, 5):
            SK[(t, lv)] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, active, "
                                     "proficiency_description) VALUES (?,?,?, 'tsc', 1, ?)",
                                     ("ZZSM-%s-%d" % (t, lv), "ZZSM Skill " + t, lv, "ZZSM %s at %d" % (t, lv))).lastrowid
    P = {}

    def prof(jc, skills, lv=3, title=None, active=1, source="architecture"):
        """A profile; `skills` is a list of titles (at `lv`) or (title, level) pairs."""
        pid = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, plan_mode, source, active) "
                         "VALUES ('ZZSM Sub', ?, ?, ?, 'explicit', ?, ?)",
                         (title or ("ZZSM " + jc), jc.rsplit("-", 1)[1], jc, source, active)).lastrowid
        for i, t in enumerate(skills):
            t, l_ = t if isinstance(t, tuple) else (t, lv)
            db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, is_future) "
                       "VALUES (?,?,?,?,0)", (pid, SK[(t, l_)], l_, i))
        P[jc] = pid
        return pid
    # the person holds (a "yes" at level 3): A-E (their job), F, G, H, K, M; answered "no" on L; never assigned I, J, N, O, P, Q
    JOB = list("ABCDE")
    prof("ZQS-SUB-01-A-14", JOB)                    # the job they hold
    prof("ZQS-SUB-01-A-15", JOB, lv=4)              # their own job +1: the recommended step
    prof("ZQS-SUB-01-A-16", JOB, lv=4)              # their own job +2
    prof("ZQS-OTH-01-A-15", list("FGHIJ"))          # R1: holds F, G, H = 3 of 5, the job does not offer it (no overlap with theirs)
    prof("ZQS-OTH-02-A-15", list("FGNOP"))          # R2: holds F, G = 2 of 5
    prof("ZQS-OTH-03-A-15", ["F", "G", ("H", 4), "N", "O"])   # R3: F, G, H titles held but H needs L4 (they hold L3): 2 at the level
    prof("ZQS-OTH-07-A-15", list("FGHNOP"))         # R7: 3 of SIX = 50%, under the 60% share
    prof("ZQS-OTH-08-A-15", list("FG"))             # R8: 2 of 2 = 100% but under the 3 minimum
    prof("ZQT-OTH-01-A-15", list("FGHIJ"))          # another family: 3 of 5 is no match for them
    prof("ZQS-HID-01-A-15", list("FGHKM"))          # 5 of 5, but hidden from their job
    prof("ZQS-OTH-04-A-17", list("FGHNO"))          # JG 17: three above JG 14
    prof("ZQS-OTH-05-A-13", list("FGHNO"))          # JG 13: below their grade
    prof("ZQS-OTH-06-A-15", list("FGHNO"), active=0)   # retired
    prof("ZQS-XXX-01-A-15", list("FGHNO"), title="Executive Chairman")   # never offered as a career path
    prof("ZQS-DMO-01-A-15", list("FGHNO"), source=a._CAREER_DEMO_SOURCE)   # the demo ladder
    prof("ZQS-SUB-01-B-15", list("ABCNO"))          # offered by their job's routes (same specialisation), 3 of 5 held
    LEG = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, source, active) "
                     "VALUES ('ZZSM Legacy', 'ZZSM Legacy Role', '14', 'test', 1)").lastrowid   # no job code
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, grade=14, unit="ZQS-SUB-01-A", name="ZZ SM Person"):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, job_grade=grade,
                 job_title="ZZSM Title", department="ZZSM Dept", business_group=BG, left_at=None, is_demo=0, role="user",
                 manager_id=None, hod_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, admin_bg=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        if unit:
            db.execute("INSERT INTO ja_people(employee_id, family_code, sub_code, spec_code, unit_code, job_scope, arch_grade, "
                       "source) VALUES (?,?,?,?,?,?,?, 'test')", (eid, "ZQS", "ZQS-SUB", "ZQS-SUB-01", unit, "ZZSM", str(grade)))
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    UP = mk("ZZ9SM-P", name="Aisyah SM")            # the person
    UN = mk("ZZ9SM-N", name="ZZ SM Noanswers")      # the same job, nothing assessed
    UX = mk("ZZ9SM-X", name="ZZ SM Offbasis")       # answers only on rows that are not in their set: held F, G, H but no basis
    UD = mk("ZZA9SM-D", name="ZZ SM Demo")          # a demo account, same job and answers as the person
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                     "VALUES ('zz9sm-bga', 'ZZ SM Groupadmin', 'x', 'admin', 'ZZ9SM-BGA', ?, ?)", (BG, BG)).lastrowid

    def give(uid, pairs, future=False):
        """Assign and answer: pairs of ((title, level), answer)."""
        ass = db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?, 'submitted')",
                         (CID, uid)).lastrowid
        for i, ((t, lv), ans) in enumerate(pairs):
            asg = db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, seq, source) "
                             "VALUES (?,?,?,?,?, 'admin')", (CID, uid, SK[(t, lv)], 1 if future else 0, i)).lastrowid
            db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer) VALUES (?,?,?)", (ass, asg, ans))
    OWN = [(("A", 3), "yes"), (("B", 3), "yes"), (("C", 3), "yes"), (("D", 3), "yes"), (("E", 3), "yes"),
           (("F", 3), "yes"), (("G", 3), "yes"), (("H", 3), "yes"), (("K", 3), "yes"), (("L", 3), "no"), (("M", 3), "yes")]
    give(UP, OWN)
    give(UD, OWN)
    give(UX, [(("F", 3), "yes"), (("G", 3), "yes"), (("H", 3), "yes")], future=True)   # next-level rows: not their set
    # one hidden route: HID is hidden from their job
    db.execute("INSERT INTO tc_career_routes(from_profile_id, to_profile_id, kind, created_by) VALUES (?,?, 'hidden', ?)",
               (P["ZQS-SUB-01-A-14"], P["ZQS-HID-01-A-15"], SU["id"]))
    db.commit()
SUP, BAC = H.client_as(a, SU["id"]), H.client_as(a, BGA)


def ctx(uid, fn):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        db_ = a.get_db()
        return fn(db_, dict(db_.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


def roles_of(uid):
    return ctx(uid, lambda d, u: a._career_candidate_roles(d, u))["roles"]


def titles(rs):
    return [r["title"] for r in rs]


def T(code):
    return "ZZSM " + code


def sm(rs):
    return [r["title"] for r in rs if r.get("skills_match")]


def route_rows(uid):
    """The Skills match rows of the person-level list: what the route adds after the job's routes and the suggestions."""
    return ctx(uid, lambda d, u: [r for r in a.tc_career_routes_for_person(d, u, a.tc_profile_for_user(d, u)[0], have={})
                                  if r.get("skills_match")])


def add_roles(extra):
    with a.app.app_context():
        d = a.get_db()
        for jc, skills, kw in extra:
            P[jc] = None
            pid = d.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, plan_mode, source, active) "
                            "VALUES ('ZZSM Sub', ?, ?, ?, 'explicit', 'architecture', 1)",
                            (T(jc), jc.rsplit("-", 1)[1], jc)).lastrowid
            for i, t in enumerate(skills):
                d.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, is_future) "
                          "VALUES (?,?,3,?,0)", (pid, SK[(t, 3)], i))
            P[jc] = pid
        d.commit()


def drop_roles(codes):
    with a.app.app_context():
        d = a.get_db()
        for jc in codes:
            d.execute("DELETE FROM tc_job_profile_skills WHERE profile_id=?", (P[jc],))
            d.execute("DELETE FROM tc_job_profiles WHERE id=?", (P[jc],))
            del P[jc]
        d.commit()


def set_suggested(uid, codes):
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM tc_person_routes WHERE subject_id=?", (uid,))
        for jc in codes:
            d.execute("INSERT INTO tc_person_routes(subject_id, to_profile_id, created_by) VALUES (?,?,?)", (uid, P[jc], SU["id"]))
        d.commit()


try:
    s.section("the fixture")
    held = ctx(UP, lambda d, u: a._career_person_held(d, u["id"]))
    s.check("the person holds F, G, H, K, M and their job's A-E at level 3, and not L (answered no) or I, J, N",
            all(held.get("ZZSM Skill " + t) == 3 for t in "ABCDEFGHKM")
            and not any("ZZSM Skill " + t in held for t in "LIJNOPQ"), held)
    own, basis = ctx(UP, lambda d, u: a._career_person_basis(d, u, a.tc_profile_for_user(d, u)[0], held))
    s.check("...and they have assessed their own set (a basis)", len(basis) >= 5, basis)
    s.check("the constants are the design's: label, 3 of 5, 60%, at most 3, order 5",
            a.TC_SKILLS_MATCH_ROUTE_LABEL == LABEL and a.TC_SKILLS_MATCH_MIN == 3 and a.TC_SKILLS_MATCH_SHARE == 0.6
            and a.TC_SKILLS_MATCH_CAP == 3 and a.TC_ROUTE_ORDER["skills match"] == 5)

    s.section("the rule: which roles qualify")
    rs = roles_of(UP)
    tt = titles(rs)
    s.check("R1 (3 of 5 held) is offered, tagged skills match, with its match and total", sm(rs) == [T("ZQS-OTH-01-A-15")]
            and rs[tt.index(T("ZQS-OTH-01-A-15"))]["route"] == LABEL
            and (rs[tt.index(T("ZQS-OTH-01-A-15"))]["match"], rs[tt.index(T("ZQS-OTH-01-A-15"))]["total"]) == (3, 5), tt)
    s.check("...and today's job routes do NOT offer it (absent from tc_career_routes_for, the job-level reader)",
            P["ZQS-OTH-01-A-15"] not in [r["profile"]["id"] for r in ctx(UP, lambda d, u: a.tc_career_routes_for(
                d, a.tc_profile_for_user(d, u)[0], have={}))])
    for code, why in (("ZQS-OTH-02-A-15", "R2: 2 of 5"),
                      ("ZQS-OTH-03-A-15", "R3: three titles held but one a level short (2 at the level)"),
                      ("ZQS-OTH-07-A-15", "3 of 6: under 60%"), ("ZQS-OTH-08-A-15", "2 of 2: under the minimum of 3"),
                      ("ZQT-OTH-01-A-15", "another family"), ("ZQS-HID-01-A-15", "hidden from their job"),
                      ("ZQS-OTH-04-A-17", "three grades up"), ("ZQS-OTH-05-A-13", "below their grade"),
                      ("ZQS-OTH-06-A-15", "retired"), ("ZQS-XXX-01-A-15", "never offered (Executive Chairman)"),
                      ("ZQS-DMO-01-A-15", "the demo ladder")):
        s.check("absent: %s" % why, T(code) not in tt, tt)
    s.check("the route itself (before the card's own grade cap) keeps to their grade up to two above: only R1",
            [r["profile"]["job_code"] for r in route_rows(UP)] == ["ZQS-OTH-01-A-15"], [r["profile"]["job_code"] for r in route_rows(UP)])
    s.check("their own job +1 is the recommended step, first", rs[0]["title"] == T("ZQS-SUB-01-A-15") and rs[0].get("recommended")
            and not rs[0].get("skills_match"), tt)
    s.check("the order: the recommended step, then the Skills match role, then the rest as before",
            tt == [T("ZQS-SUB-01-A-15"), T("ZQS-OTH-01-A-15"), T("ZQS-SUB-01-A-16"), T("ZQS-SUB-01-B-15")], tt)
    off = rs[tt.index(T("ZQS-SUB-01-B-15"))]
    s.check("a role the job's routes already offer (3 of 5 held) keeps its own tag and shows once",
            tt.count(T("ZQS-SUB-01-B-15")) == 1 and off["route"] == "same specialisation" and not off.get("skills_match"), off)

    s.section("a role Group People suggested shows once, as theirs; the order is recommended, suggestions, Skills match, rest")
    add_roles([("ZQS-OTH-09-A-16", list("FGHNO"), {})])   # 3 of 5 held, JG 16: a Skills match until Group People suggest it
    s.check("before it is suggested it is the second Skills match role", sm(roles_of(UP)) == [T("ZQS-OTH-01-A-15"), T("ZQS-OTH-09-A-16")])
    set_suggested(UP, ["ZQS-OTH-09-A-16"])
    rs = roles_of(UP)
    tt = titles(rs)
    sg = [r for r in rs if r["title"] == T("ZQS-OTH-09-A-16")]
    s.check("once, tagged suggested by Group People (3 of 5 held, not a skills match)", len(sg) == 1 and sg[0]["route"] == SG_LABEL
            and sg[0]["suggested"] and not sg[0].get("skills_match"), sg)
    s.check("order: the recommended step, the suggestion, the Skills match role, then the rest",
            tt[:3] == [T("ZQS-SUB-01-A-15"), T("ZQS-OTH-09-A-16"), T("ZQS-OTH-01-A-15")]
            and set(tt[3:]) == {T("ZQS-SUB-01-A-16"), T("ZQS-SUB-01-B-15")} and len(tt) == 5, tt)
    s.check("...and the recommended step is still their own job +1", rs[0].get("recommended") and rs[0]["title"] == T("ZQS-SUB-01-A-15"))
    set_suggested(UP, [])
    drop_roles(["ZQS-OTH-09-A-16"])

    s.section("the cap and the order: four qualify, three show")
    add_roles([("ZQS-OTH-10-A-15", list("FGHKM"), {}), ("ZQS-OTH-11-A-16", list("FGHKN"), {}), ("ZQS-OTH-12-A-14", list("FGHNO"), {})])
    rs = roles_of(UP)
    s.check("5 of 5 (JG 15), 4 of 5 (JG 16), 3 of 5 (JG 14) and R1 (3 of 5, JG 15): three show, best match first, then the lower grade, "
            "and R1 is the one cut", sm(rs) == [T("ZQS-OTH-10-A-15"), T("ZQS-OTH-11-A-16"), T("ZQS-OTH-12-A-14")], sm(rs))
    s.check("...with their match counts 5, 4, 3 of 5", [(r["match"], r["total"]) for r in rs if r.get("skills_match")] == [(5, 5), (4, 5), (3, 5)])
    s.check("the 5-of-5 role one grade up is NOT the recommended step: it stays their own job +1",
            [r["title"] for r in rs if r.get("recommended")] == [T("ZQS-SUB-01-A-15")] and rs[0]["title"] == T("ZQS-SUB-01-A-15"))
    s.check("the limit never cuts one: the job-level limit (1) leaves all three Skills match rows on the person's list",
            [r["profile"]["job_code"] for r in ctx(UP, lambda d, u: a.tc_career_routes_for_person(
                d, u, a.tc_profile_for_user(d, u)[0], limit=1)) if r.get("skills_match")] ==
            ["ZQS-OTH-10-A-15", "ZQS-OTH-11-A-16", "ZQS-OTH-12-A-14"])
    s.check("the route rows have the shape of the suggestions' rows",
            all(set(("profile", "overlap", "shared", "new", "track_move", "lane", "step", "pinned", "score", "route", "next_step",
                     "next_job", "target", "gap", "skills_match", "match", "total")) <= set(r) and r["lane"] == "cross"
                and r["pinned"] is False and r["next_step"] is False and r["next_job"] is False and r["route"] == LABEL
                and r["skills_match"] is True for r in route_rows(UP)))
    s.check("the route's own order is the candidate list's: -match, grade, title",
            [r["profile"]["job_code"] for r in route_rows(UP)] == ["ZQS-OTH-10-A-15", "ZQS-OTH-11-A-16", "ZQS-OTH-12-A-14"])
    drop_roles(["ZQS-OTH-10-A-15", "ZQS-OTH-11-A-16", "ZQS-OTH-12-A-14"])

    s.section("nothing assessed, no placed job, a demo account")
    s.check("no answers at all: no Skills match role", not sm(roles_of(UN)) and not route_rows(UN), titles(roles_of(UN)))
    s.check("answers only on rows that are not in their set (held F, G, H) but nothing of their own set assessed: no basis, no Skills match",
            ctx(UX, lambda d, u: sorted(a._career_person_held(d, u["id"]))) == ["ZZSM Skill F", "ZZSM Skill G", "ZZSM Skill H"]
            and not ctx(UX, lambda d, u: a._career_person_basis(d, u, a.tc_profile_for_user(d, u)[0],
                                                              a._career_person_held(d, u["id"]))[1])
            and not sm(roles_of(UX)) and not route_rows(UX), titles(roles_of(UX)))
    s.check("no placed job (None), or a legacy profile with no job code: nothing",
            ctx(UP, lambda d, u: a.tc_person_skills_match_routes(d, u, None, set(), a._career_person_held(d, u["id"]))) == []
            and ctx(UP, lambda d, u: a.tc_person_skills_match_routes(
                d, u, dict(d.execute("SELECT * FROM tc_job_profiles WHERE id=?", (LEG,)).fetchone()), set(),
                a._career_person_held(d, u["id"]))) == [])
    s.check("a demo account is unchanged: the same job and answers, and no Skills match role",
            a.demo_accounts_on() and a.is_demo_account({"employee_id": "ZZA9SM-D"}) and not sm(roles_of(UD))
            and not route_rows(UD) and titles(roles_of(UD)) == [T("ZQS-SUB-01-A-15"), T("ZQS-SUB-01-A-16"), T("ZQS-SUB-01-B-15")],
            titles(roles_of(UD)))
    s.check("...while the same answers on a real account do get one", sm(roles_of(UP)) == [T("ZQS-OTH-01-A-15")])

    s.section("one rule for the card and the route (the shared helper)")
    rs = roles_of(UP)
    card = {r["profile_id"]: (r["match"], r["total"]) for r in rs if r.get("skills_match")}
    routed = {r["profile"]["id"]: (r["match"], r["total"]) for r in route_rows(UP)}
    s.check("each Skills match role's card match equals the route's match", card and card == routed, (card, routed))
    _held, _basis = a._career_person_held, a._career_person_basis
    a._career_person_held = lambda d, uid: dict(_held(d, uid), **{"ZZSM Skill I": 3, "ZZSM Skill J": 3})   # holds two more of R1's five
    try:
        rs_h = roles_of(UP)
        r1 = next(r for r in rs_h if r["title"] == T("ZQS-OTH-01-A-15"))
        s.check("falsified: the card and the route both read _career_person_held, so one extra held skill moves both to 5 of 5 together",
                (r1["match"], r1["total"]) == (5, 5) and r1.get("skills_match")
                and {x["profile"]["id"]: x["match"] for x in route_rows(UP)}[P["ZQS-OTH-01-A-15"]] == 5)
    finally:
        a._career_person_held = _held
    s.check("...and with the helper put back it is 3 of 5 again", next(r for r in roles_of(UP) if r["title"] == T("ZQS-OTH-01-A-15"))["match"] == 3)
    card_row = next(r for r in roles_of(UP) if r["title"] == T("ZQS-OTH-01-A-15"))
    s.check("a Skills match card lists its skills with the person's state on each (3 match)",
            [x["state"] for x in card_row["skills"]].count("match") == 3 and len(card_row["skills"]) == 5)

    s.section("_career_recommended never returns a Skills match role")
    cur_rows = [{"title": "X", "grade": 15, "skills_match": True, "suggested": True, "match": 5, "route": LABEL},
                {"title": "Y", "grade": 15, "skills_match": True, "next_step": True, "match": 5}]
    s.check("even flagged suggested / next_step by a later change, a Skills match one grade up is not recommended",
            a._career_recommended(cur_rows, 14) is None)
    s.check("...while a suggestion one grade up still is, beside it", a._career_recommended(
        cur_rows + [{"title": "Z", "grade": 15, "suggested": True, "match": 1}], 14)["title"] == "Z")
    s.check("the 19 Oct rule: their own job +1 is recommended over a 5-of-5 Skills match +1, whichever comes first",
            a._career_recommended([{"title": "Q", "grade": 15, "skills_match": True, "match": 5, "route": LABEL},
                                   {"title": "O", "grade": 15, "next_step": True, "match": 0, "route": "next grade in this job"}],
                                  14)["title"] == "O")

    s.section("the suggest-a-role picker and its refusal")
    pid1 = P["ZQS-OTH-01-A-15"]
    html = SUP.get("/admin/users/%d?tab=plan" % UP).get_data(as_text=True)
    m = re.search(r'<script type="application/json" class="sg-data">(.*?)</script>', html, re.S)
    pick = {r["id"]: r for r in json.loads(m.group(1))["roles"]} if m else {}
    s.check("the picker greys R1: Already in their Career Plan: a skills match",
            pick.get(pid1, {}).get("off") == "Already in their Career Plan: a skills match", pick.get(pid1))
    s.check("...and not a role that is no Skills match (R2) or the others", pick.get(P["ZQS-OTH-02-A-15"], {}).get("off") is None
            and pick.get(P["ZQS-SUB-01-B-15"], {}).get("off") == "Already in their Career Plan: their job offers it", pick.get(P["ZQS-OTH-02-A-15"]))
    refusal = ctx(UP, lambda d, u: a._person_suggest_refusal(d, u, d.execute("SELECT * FROM tc_job_profiles WHERE id=?", (pid1,)).fetchone()))
    s.check("_person_suggest_refusal refuses it, in words", refusal and "skills match" in refusal and "can't be suggested" in refusal, refusal)
    s.check("...and not R2", ctx(UP, lambda d, u: a._person_suggest_refusal(
        d, u, d.execute("SELECT * FROM tc_job_profiles WHERE id=?", (P["ZQS-OTH-02-A-15"],)).fetchone())) is None)
    r = SUP.post("/admin/users/%d/plan" % UP, data={"csrf_token": "tok", "action": "suggest_add", "profile_id": str(pid1)})
    flash = SUP.get(r.headers.get("Location", "/"), follow_redirects=True).get_data(as_text=True)
    s.check("the POST refuses it and writes nothing", r.status_code == 302 and "skills match" in flash.replace("&#39;", "'")
            and not H.rows(a, "SELECT 1 FROM tc_person_routes WHERE subject_id=?", (UP,)))
    s.check("the admin's Role choice select lists the Skills match role (it is one of the roles they can pick)",
            '<option value="%d"' % pid1 in html)

    s.section("what the chat and the agents say")
    lines = ctx(UP, lambda d, u: a._career_tool_show_routes(d, u, CID, {}))["render"]["data"]["lines"]
    one = next(x for x in lines if x["title"] == T("ZQS-OTH-01-A-15"))
    s.check("the career map line carries route and '3 of 5 skills match' (the % stays the card's)", one["route"] == LABEL
            and one["match_words"] == "3 of 5 skills match" and "skills_match" in one, one)
    s.check("...and a line that is not a Skills match has no such words", all(x["match_words"] is None for x in lines
            if x["title"] != T("ZQS-OTH-01-A-15")))
    sysmsg = ctx(UP, lambda d, u: a._career_agent_system(d, u, {"profile": {}, "complete": False}))
    s.check("the career agent knows it: at least 3 of its 5, an aim, never a promotion, never ready",
            "skills match" in sysmsg and "at least 3 of its 5" in sysmsg and "never a promotion" in sysmsg
            and 'never "ready"' in sysmsg)
    src = H.source(a)
    s.check("Ask OneHR's Career Plan facts say it (and say nothing of anyone's result)", "Career Plan roles, Skills match" in src
            and "At most three show, after the recommended " in src.replace('"\n                         "', ""))
    s.check("Help's Career Plan answer says it", "Skills match" in a.HELP_QA["idp_match"][1] and not re.search(r"\bready\b", a.HELP_QA["idp_match"][1].split("promotion decision")[1]))
    kb = H.one(a, "SELECT body FROM kb_entries WHERE slug='career-skills-match'")
    s.check("the KB has a Career Plan row for it, seeded by its own slug, conceptual and with no 'ready'",
            kb and "Skills match" in kb and "3 of its 5" in kb and not re.search(r"\bready\b", kb.lower()), kb)
    s.check("the tour needs no change: it lists no route tags", "skills match" not in open(os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "static", "onboarding.js"), encoding="utf-8").read().lower())
    _js = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "journey_chat.js"),
               encoding="utf-8").read()
    s.check("the role card's tag reads from route, capitalised ('Skills match'), a plain tag (is-next only for the next step)",
            "(r.route.charAt(0).toUpperCase() + r.route.slice(1))" in _js
            and 'tag.className = "rv-dir-tag" + (r.next_step || r.recommended ? " is-next" : "")' in _js)
finally:
    with a.app.app_context():
        _cleanup(a.get_db())
sys.exit(s.done())
