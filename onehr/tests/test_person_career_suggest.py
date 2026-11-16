"""Roles suggested for ONE person's Career Plan (Chris, 2026-11-07, canvas Nb3NYF8C9W5X3F3Pcr6drX boards A1, A2, E1: "Yes, as drawn").

The super admin adds job-architecture roles to one person's Career Plan (tc_person_routes). They show to that person as "Suggested
by Group People" beside the moves their job offers; their job, their competency set and everyone else's plan stay as they are.
What this suite holds:
  * the writes: POST /admin/users/<uid>/plan, actions suggest_add / suggest_remove, are the super admin's alone (the gate says
    "super" in ADMIN_ACCESS_MAP and the route 403s again); every refusal changes nothing and names why (an out-of-range grade
    below and above, a duplicate, their own job, an inactive or unknown role, a role with no job code, a never-offered one)
  * the one reader (tc_person_suggested_routes) and its wrapper (tc_career_routes_for_person): the suggestions are in
    _career_candidate_roles after the recommended step, best skills match first. A suggested role exactly one grade up IS the
    recommended step (Chris, 2026-11-08, "Yes, build and ship"; best match first when there are two), else their own job +1; a role their job already offers is not doubled; a person with no placed job still gets them; ANOTHER holder of the
    same job does not
  * the role pick (admin action=role) and the chat's set_direction accept a suggested role; removing one leaves their choice
  * nothing a suggestion must never touch is touched: tc_assignments and ja_people (count and content), pm_career_profile's choice
  * the skills match also counts the person's own competency set; a person whose set IS their job's reads exactly as before
  * the audit trail, the confirm texts as drawn, the block shown to the super admin only (any other admin's card has none)
Everything is synthetic (ZZ9PS..., ZZPS...) and removed at the end."""
import html as _html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Roles suggested for one person's Career Plan")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, _E = H.actors(a)
BG = "ZZPS Group"
LABEL = "suggested by Group People"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9PS-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM tc_person_routes WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM pm_career_profile WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM tc_scores WHERE assessment_id IN (SELECT id FROM tc_assessments WHERE subject_id IN (%s))" % ph, ids)
        db.execute("DELETE FROM tc_assignments WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM tc_assessments WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM ja_people WHERE employee_id LIKE 'ZZ9PS-%'")
    db.execute("DELETE FROM activity_log WHERE action='career_suggest' AND detail LIKE '%ZZPS%'")
    pids = [r[0] for r in db.execute("SELECT id FROM tc_job_profiles WHERE job_title LIKE 'ZZPS %' OR job_code LIKE 'ZQP-%' "
                                     "OR job_code LIKE 'ZQQ-%'")]
    if pids:
        ph = ",".join("?" * len(pids))
        db.execute("DELETE FROM tc_person_routes WHERE to_profile_id IN (%s)" % ph, pids)
        db.execute("DELETE FROM tc_career_routes WHERE from_profile_id IN (%s) OR to_profile_id IN (%s)" % (ph, ph), pids + pids)
        db.execute("DELETE FROM tc_job_profile_skills WHERE profile_id IN (%s)" % ph, pids)
        db.execute("DELETE FROM tc_job_profiles WHERE id IN (%s)" % ph, pids)
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZPS-%'")
    db.execute("DELETE FROM ja_taxonomy WHERE code LIKE 'ZQ%' AND name LIKE 'ZQ %'")
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    SK = {}
    for t in "ABCDEFGHIJ":
        for lv in (3, 4, 5):
            SK[(t, lv)] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, active, "
                                     "proficiency_description) VALUES (?,?,?, 'tsc', 1, ?)",
                                     ("ZZPS-%s-%d" % (t, lv), "ZZPS Skill " + t, lv, "ZZPS %s at %d" % (t, lv))).lastrowid
    P = {}

    def prof(jc, skills, lv=3, title=None, active=1, source="architecture"):
        pid = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, plan_mode, source, active) "
                         "VALUES ('ZZPS Sub', ?, ?, ?, 'explicit', ?, ?)",
                         (title or ("ZZPS " + jc), jc.rsplit("-", 1)[1], jc, source, active)).lastrowid
        for i, t in enumerate(skills):
            db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, is_future) "
                       "VALUES (?,?,?,?,0)", (pid, SK[(t, lv)], lv, i))
        P[jc] = pid
        return pid
    JOB = ["A", "B", "C", "D", "E"]
    prof("ZQP-SUB-01-A-14", JOB)                 # the job the people hold
    prof("ZQP-SUB-01-A-15", JOB, lv=4)           # their own job +1: the recommended step
    prof("ZQP-SUB-01-A-16", JOB, lv=4)           # their own job +2: their job already offers it
    # their own job's future rows (the next level), which the merge of a person's own set must ignore
    for i, t in enumerate(JOB):
        db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, is_future) "
                   "VALUES (?,?,4,?,1)", (P["ZQP-SUB-01-A-14"], SK[(t, 4)], i))
    BD = ["F", "G", "H", "I", "J"]               # another family entirely: the job never offers these
    prof("ZQQ-BDV-01-14", BD)
    prof("ZQQ-BDV-01-15", BD, lv=4)
    prof("ZQQ-BDV-01-16", BD, lv=4)
    prof("ZQQ-BDV-01-17", BD, lv=4)              # JG 17: three above JG 14, out of range
    prof("ZQQ-BDV-01-13", BD)                    # JG 13: below their grade
    prof("ZQQ-BDV-02-14", BD, active=0)          # retired
    prof("ZQQ-XXX-01-14", BD, title="Executive Chairman")   # never offered as a career path (tc_not_a_career_route)
    prof("ZQQ-DMO-01-14", BD, source=a._CAREER_DEMO_SOURCE)   # the demo ladder
    LEG = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, source, active) "
                     "VALUES ('ZZPS Legacy', 'ZZPS Legacy Role', '14', 'test', 1)").lastrowid   # no job code
    for code, lvl, parent, name in (("ZQP", "family", None, "ZQ Pee Family"), ("ZQQ", "family", None, "ZQ Cue Sales")):
        db.execute("INSERT INTO ja_taxonomy(code, level, parent_code, name) VALUES (?,?,?,?)", (code, lvl, parent, name))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, grade, unit="ZQP-SUB-01-A", name="ZZ PS Person"):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, job_grade=grade,
                 job_title="ZZPS Title", department="ZZPS Dept", business_group=BG, left_at=None, is_demo=0, role="user",
                 manager_id=None, hod_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, admin_bg=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        if unit:
            db.execute("INSERT INTO ja_people(employee_id, family_code, sub_code, spec_code, unit_code, job_scope, arch_grade, "
                       "source) VALUES (?,?,?,?,?,?,?, 'test')", (eid, "ZQP", "ZQP-SUB", "ZQP-SUB-01", unit, "ZZPS", str(grade)))
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    UP = mk("ZZ9PS-P", 14, name="Aisyah PS")          # the person: their own set is the commercial one
    UQ = mk("ZZ9PS-Q", 14, name="ZZ PS Holder Two")  # another holder of the same job, their set is the job's
    UN = mk("ZZ9PS-N", 14, unit=None, name="ZZ PS Nojob")   # no placed job
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                     "VALUES ('zz9ps-bga', 'ZZ PS Groupadmin', 'x', 'admin', 'ZZ9PS-BGA', ?, ?)", (BG, BG)).lastrowid

    def give_set(uid, titles_levels, answers):
        ass = db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?, 'submitted')",
                         (CID, uid)).lastrowid
        for i, ((t, lv), ans) in enumerate(zip(titles_levels, answers)):
            asg = db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, seq, source) "
                             "VALUES (?,?,?,0,?, 'admin')", (CID, uid, SK[(t, lv)], i)).lastrowid
            db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer) VALUES (?,?,?)", (ass, asg, ans))
        # the next-level rows of a set built from a job: ignored by the merge
        for t, lv in titles_levels[:2]:
            db.execute("INSERT OR IGNORE INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, seq, source) "
                       "VALUES (?,?,?,1,?, 'admin')", (CID, uid, SK[(t, lv + 1)], 90))
    give_set(UP, [("F", 3), ("G", 3)], ["yes", "no"])                      # commercial: nothing of their job's
    give_set(UQ, [("A", 3), ("B", 3), ("C", 3), ("D", 3), ("E", 3)], ["yes", "yes", "no", "yes", "yes"])   # their job's own
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
    return "ZZPS " + code


def snap(uid):
    """What a suggestion must never touch, for one person: their competency set and their place in the architecture."""
    with a.app.app_context():
        d = a.get_db()
        return ([tuple(r) for r in d.execute("SELECT id, cycle_id, skill_id, is_future, seq, source FROM tc_assignments "
                                             "WHERE subject_id=? ORDER BY id", (uid,))],
                [tuple(r) for r in d.execute("SELECT * FROM ja_people WHERE employee_id=(SELECT employee_id FROM users "
                                             "WHERE id=?)", (uid,))],
                [tuple(r) for r in d.execute("SELECT id, status FROM tc_assessments WHERE subject_id=? ORDER BY id", (uid,))])


def rows_of(uid):
    return [(r["to_profile_id"], r["created_by"]) for r in H.rows(
        a, "SELECT to_profile_id, created_by FROM tc_person_routes WHERE subject_id=? ORDER BY id", (uid,))]


def post(client, uid, action, pid, **kw):
    return client.post("/admin/users/%d/plan" % uid, data=dict({"csrf_token": "tok", "action": action,
                                                                "profile_id": str(pid)}, **kw))


def flash_of(client, resp):
    return _html.unescape(client.get(resp.headers.get("Location", "/"), follow_redirects=True).get_data(as_text=True))


def page(client, uid):
    return client.get("/admin/users/%d?tab=plan" % uid).get_data(as_text=True)


def pick_data(html):
    m = re.search(r'<script type="application/json" class="sg-data">(.*?)</script>', html, re.S)
    return json.loads(m.group(1)) if m else None


def audit(uid):
    return [r["detail"] for r in H.rows(a, "SELECT detail FROM activity_log WHERE action='career_suggest' AND "
                                           "target_user_id=? ORDER BY id", (uid,))]


try:
    s.section("the person's Career Plan today: nothing suggested")
    before_p = roles_of(UP)
    s.check("fixture: the person is offered their own job one grade up, recommended first, and two up",
            before_p and before_p[0]["title"] == T("ZQP-SUB-01-A-15") and before_p[0].get("recommended")
            and T("ZQP-SUB-01-A-16") in titles(before_p) and not any(r.get("suggested") for r in before_p), titles(before_p))
    s.check("...and none of the commercial roles", not any("ZQQ" in t for t in titles(before_p)), titles(before_p))
    snap_p, snap_q = snap(UP), snap(UQ)
    s.check("the storage exists, additive: tc_person_routes with its unique key and index",
            H.one(a, "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('tc_person_routes','idx_tc_person_routes_subject')") == 2
            and "UNIQUE(subject_id, to_profile_id)" in H.one(a, "SELECT sql FROM sqlite_master WHERE name='tc_person_routes'"))

    s.section("access: the super admin's alone")
    PL = "/admin/users/%d/plan" % UP
    s.check("both actions are \"super\" in ADMIN_ACCESS_MAP, the rest of the route keeps Their Career Plan's item",
            a.ADMIN_ACCESS_MAP["admin_person_plan"]["map"] == {"suggest_add": "super", "suggest_remove": "super"}
            and a.ADMIN_ACCESS_MAP["admin_person_plan"]["default"] == ("items", ("idp.profile",)))

    def refused(uid, form):
        with a.app.test_request_context(PL, method="POST", data=form):
            return a.admin_access_refused(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
    s.check("the gate refuses a BG admin both actions", refused(BGA, {"action": "suggest_add"}) and refused(BGA, {"action": "suggest_remove"}))
    _was_item = a.admin_can_item
    a.admin_can_item = lambda u, it: True   # a role holding EVERY item (what "Everything" gives)
    try:
        s.check("...even one holding every item (the ticks that guard the person's other Career Plan writes pass: action=role)",
                refused(BGA, {"action": "suggest_add"}) and refused(BGA, {"action": "suggest_remove"})
                and not refused(BGA, {"action": "role"}) and not refused(BGA, {"action": "profile"}))
        # the route's own check stands without the gate: take the gate away and the 403 is still there
        _was_ref = a.admin_access_refused
        a.admin_access_refused = lambda u: False
        try:
            r1 = post(BAC, UP, "suggest_add", P["ZQQ-BDV-01-14"])
            r2 = post(BAC, UP, "suggest_remove", P["ZQQ-BDV-01-14"])
            s.check("the route 403s for a non-super admin by itself, both actions (the gate off)",
                    r1.status_code == 403 and r2.status_code == 403, (r1.status_code, r2.status_code))
        finally:
            a.admin_access_refused = _was_ref
    finally:
        a.admin_can_item = _was_item
    s.check("over HTTP, with the real gate: 403 for both, and nothing written", post(BAC, UP, "suggest_add", P["ZQQ-BDV-01-14"]).status_code == 403
            and post(BAC, UP, "suggest_remove", P["ZQQ-BDV-01-14"]).status_code == 403 and not rows_of(UP))
    s.check("an employee can't post it either", H.client_as(a, UQ).post(PL, data={"csrf_token": "tok", "action": "suggest_add",
            "profile_id": str(P["ZQQ-BDV-01-14"])}).status_code in (302, 403, 404) and not rows_of(UP))

    s.section("what the writes refuse (each changes nothing, and says why)")

    def refuse(label, pid, words):
        r = post(SUP, UP, "suggest_add", pid)
        msg = flash_of(SUP, r)
        s.check("refused: %s" % label, r.status_code == 302 and not rows_of(UP) and words in msg,
                (r.status_code, rows_of(UP), words in msg))
    refuse("below their grade (JG 13)", P["ZQQ-BDV-01-13"], "to two grades up")
    refuse("three grades above (JG 17)", P["ZQQ-BDV-01-17"], "to two grades up")
    refuse("a retired role", P["ZQQ-BDV-02-14"], "retired")
    refuse("an unknown role", 987654321, "isn't in the job architecture")
    refuse("a role with no job code", LEG, "isn't a role in the job architecture")
    refuse("a role never offered as a career path (Executive Chairman)", P["ZQQ-XXX-01-14"], "isn't a role in the job architecture")
    refuse("the demo ladder's role", P["ZQQ-DMO-01-14"], "isn't a role in the job architecture")
    refuse("the job they hold", P["ZQP-SUB-01-A-14"], "job they hold")
    r = SUP.post(PL, data={"csrf_token": "tok", "action": "suggest_add"})
    s.check("no role named is a bad request, nothing written", r.status_code == 400 and not rows_of(UP))
    s.check("nothing the refusals touched: their set and place are as they were", (snap(UP), snap(UQ)) == (snap_p, snap_q))

    s.section("the super admin suggests three, and removes one")
    ids = {c: P["ZQQ-BDV-01-%s" % c] for c in ("14", "15", "16")}
    for c in ("14", "15", "16"):
        r = post(SUP, UP, "suggest_add", ids[c])
        s.check("added: the BD role at JG %s" % c, r.status_code == 302 and (ids[c], SU["id"]) in rows_of(UP), rows_of(UP))
    r = post(SUP, UP, "suggest_add", ids["14"])
    s.check("a duplicate is refused, and says it is already suggested", "already suggested" in flash_of(SUP, r)
            and len(rows_of(UP)) == 3)
    s.check("the audit trail has each add: who, what, the person it was done to", [d for d in audit(UP) if d.startswith("added:")] == [
        "added: %s (JG %s)" % (T("ZQQ-BDV-01-%s" % c), c) for c in ("14", "15", "16")], audit(UP))
    s.check("...against the super admin's account", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='career_suggest' "
                                                          "AND user_id=? AND target_user_id=?", (SU["id"], UP)) == 3)
    s.check("a suggestion never touches their set, their job or anyone else's", (snap(UP), snap(UQ)) == (snap_p, snap_q))

    s.section("what the person is offered")
    rs = roles_of(UP)
    tt = titles(rs)
    s.check("the recommended step is first: the suggested role exactly one grade up (2026-11-08), once", rs[0]["title"] == T("ZQQ-BDV-01-15")
            and rs[0].get("recommended") and rs[0].get("suggested") and tt.count(T("ZQQ-BDV-01-15")) == 1
            and sum(1 for r in rs if r.get("recommended")) == 1, tt)
    s.check("...their own job +1 is still offered, after the suggestions, and no longer recommended",
            T("ZQP-SUB-01-A-15") in tt and tt.index(T("ZQP-SUB-01-A-15")) > tt.index(T("ZQQ-BDV-01-16"))
            and not rs[tt.index(T("ZQP-SUB-01-A-15"))].get("recommended"), tt)
    s.check("the other two suggestions come right after it, best skills match first, then grade",
            tt[1:3] == [T("ZQQ-BDV-01-14"), T("ZQQ-BDV-01-16")] and rs[1]["match"] >= rs[2]["match"], tt)
    s.check("...each tagged for the person's role card: Suggested by Group People", all(r["route"] == LABEL and r["suggested"]
            for r in rs[0:3]) and LABEL[0].upper() + LABEL[1:] == "Suggested by Group People")
    s.check("the rest follow as they were (their own job one and two up)", tt[3:] == [T("ZQP-SUB-01-A-15"), T("ZQP-SUB-01-A-16")], tt)
    _js = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "journey_chat.js"),
               encoding="utf-8").read()
    s.check("the card's tag reads from route, capitalised, as every route tag does (static/journey_chat.js): no JS change needed",
            "(r.route.charAt(0).toUpperCase() + r.route.slice(1))" in _js)
    s.check("ANOTHER holder of the same job does not see them", not any("ZQQ" in t for t in titles(roles_of(UQ)))
            and titles(roles_of(UQ)) == titles(before_p), titles(roles_of(UQ)))
    shown = ctx(UP, lambda d, u: a._career_tool_show_directions(d, u, CID, {}))["render"]["data"]["roles"]
    s.check("the chat's direction card carries them too (one list)", [r["title"] for r in shown] == tt)
    routes_card = ctx(UP, lambda d, u: a._career_tool_show_routes(d, u, CID, {}))
    s.check("the chat's career map lists them (the same reader)", all(T("ZQQ-BDV-01-%s" % c) in
            [x["title"] for x in routes_card["render"]["data"]["lines"]] for c in ("14", "15", "16")), routes_card)
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = UP
        d_ = a.get_db()
        u_ = d_.execute("SELECT * FROM users WHERE id=?", (UP,)).fetchone()
        here_ = a.tc_profile_for_user(d_, u_)[0]
        wrapped = a.tc_career_routes_for_person(d_, u_, here_, have={})
        plain = a.tc_career_routes_for(d_, here_, have={})
    s.check("the job-level reader is left alone: tc_career_routes_for has no suggestion, the wrapper has all three",
            not any(r["profile"]["job_code"].startswith("ZQQ") for r in plain)
            and sum(1 for r in wrapped if r["profile"]["job_code"].startswith("ZQQ-BDV-01-1") and r.get("suggested")) == 3)
    s.check("the suggestions come after the job's own routes, so the job's limit never cuts one (limit=1)",
            [r["profile"]["job_code"] for r in ctx(UP, lambda d, u: a.tc_career_routes_for_person(
                d, u, a.tc_profile_for_user(d, u)[0], limit=1))][1:] ==
            ["ZQQ-BDV-01-14", "ZQQ-BDV-01-15", "ZQQ-BDV-01-16"])

    s.section("a role their job already offers is not doubled")
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT INTO tc_person_routes(subject_id, to_profile_id, created_by) VALUES (?,?,?)",
                  (UP, P["ZQP-SUB-01-A-16"], SU["id"]))
        d.commit()
    rs2 = roles_of(UP)
    dup = [r for r in rs2 if r["title"] == T("ZQP-SUB-01-A-16")]
    s.check("once, with the person's label, among the suggestions", len(dup) == 1 and dup[0]["route"] == LABEL and dup[0]["suggested"]
            and rs2.index(dup[0]) in (1, 2, 3, 4), titles(rs2))
    s.check("...and the recommended step is unchanged (the suggested JG 15 role; the added one is JG 16)",
            rs2[0]["title"] == T("ZQQ-BDV-01-15") and rs2[0].get("recommended"))
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM tc_person_routes WHERE subject_id=? AND to_profile_id=?", (UP, P["ZQP-SUB-01-A-16"]))
        d.commit()

    s.section("a person with no placed job, and a role that has since gone")
    with a.app.app_context():
        d = a.get_db()
        d.execute("INSERT INTO tc_person_routes(subject_id, to_profile_id, created_by) VALUES (?,?,?)",
                  (UN, ids["14"], SU["id"]))
        d.commit()
    rn = roles_of(UN)
    s.check("no placed job: the suggestion is still their role", titles(rn) == [T("ZQQ-BDV-01-14")] and rn[0]["suggested"], titles(rn))
    with a.app.app_context():
        a.get_db().execute("DELETE FROM tc_person_routes WHERE subject_id=?", (UN,))
        a.get_db().commit()
    s.check("...and without one they have none, as before", roles_of(UN) == [])
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE tc_job_profiles SET active=0 WHERE id=?", (ids["16"],))
        d.commit()
    s.check("a retired suggested role is no longer offered", T("ZQQ-BDV-01-16") not in titles(roles_of(UP)))
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE tc_job_profiles SET active=1 WHERE id=?", (ids["16"],))
        d.commit()
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE users SET job_grade='16' WHERE id=?", (UP,))   # promoted past JG 14 and 15
        d.commit()
    s.check("a suggestion that falls below their grade is dropped from what they see (_career_cap_grades)",
            T("ZQQ-BDV-01-14") not in titles(roles_of(UP)) and T("ZQQ-BDV-01-15") not in titles(roles_of(UP)))
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE users SET job_grade='14' WHERE id=?", (UP,))
        d.commit()

    s.section("the skills match counts the person's own competency set")
    bd14 = next(r for r in roles_of(UP) if r["title"] == T("ZQQ-BDV-01-14"))
    s.check("they hold Skill F (their own set, answered yes at L3): 1 of 5 on the role that asks for it",
            (bd14["match"], bd14["total"]) == (1, 5) and next(x for x in bd14["skills"] if x["title"] == "ZZPS Skill F")["state"] == "match",
            (bd14["match"], bd14["total"]))
    _was_set = a._career_person_set
    a._career_person_set = lambda db, sid: {}
    try:
        off = next(r for r in roles_of(UP) if r["title"] == T("ZQQ-BDV-01-14"))
    finally:
        a._career_person_set = _was_set
    s.check("falsify: without their set merged in, their job's map has none of their answers and no state is claimed (0 of 0)",
            (off["match"], off["total"]) == (0, 0) and off["skills"] == [], (off["match"], off["total"]))
    bd15 = next(r for r in roles_of(UP) if r["title"] == T("ZQQ-BDV-01-15"))
    s.check("...a role that asks one level more of Skill F: not a match, its next level", next(
        x for x in bd15["skills"] if x["title"] == "ZZPS Skill F")["state"] == "next")
    s.check("their set is read from the active cycle's current rows only (the next-level rows are ignored)",
            ctx(UP, lambda d, u: a._career_person_set(d, UP)) == {"ZZPS Skill F": 3, "ZZPS Skill G": 3})
    _ownset = {"ZZPS Skill F", "ZZPS Skill G"}
    _outside = [(r["title"], x["title"], x["state"]) for r in roles_of(UP) for x in r["skills"] if x["title"] not in _ownset]
    s.check("their job's titles outside their own set read 'new', never a red 'below' for a skill they were never asked",
            _outside and all(st == "new" for _t, _k, st in _outside), _outside[:4])

    def shape(rs):
        return [(r["title"], r.get("route"), r["match"], r["total"], [(x["title"], x["state"], x["need"], x["have"], x["own"])
                                                                      for x in r["skills"]]) for r in rs]
    merged = shape(roles_of(UQ))
    a._career_person_set = lambda db, sid: {}
    try:
        unmerged = shape(roles_of(UQ))
    finally:
        a._career_person_set = _was_set
    s.check("a person whose set IS their job's reads exactly as before (the merge changes nothing)", merged == unmerged
            and any(x[3] for x in merged), merged[:1])
    s.check("...their set did carry titles, so the merge had something to add (it is not an empty set)",
            ctx(UQ, lambda d, u: a._career_person_set(d, UQ)) == {"ZZPS Skill %s" % t: 3 for t in "ABCDE"})

    s.section("the role pick and the chat's set_direction accept a suggested role")
    r = post(SUP, UP, "role", ids["14"])
    s.check("the admin role pick (action=role) takes a suggested role", r.status_code == 302 and H.one(
        a, "SELECT target_profile_id FROM pm_career_profile WHERE subject_id=?", (UP,)) == ids["14"])
    with a.app.app_context():
        a.get_db().execute("UPDATE pm_career_profile SET target_profile_id=NULL WHERE subject_id=?", (UP,))
        a.get_db().commit()
    res = ctx(UP, lambda d, u: a._career_tool_set_direction(d, u, CID, {"choice": "%s (JG15)" % T("ZQQ-BDV-01-15")}))
    s.check("set_direction takes it too, by its listed label with the grade", res.get("ok") and H.one(
        a, "SELECT target_profile_id FROM pm_career_profile WHERE subject_id=?", (UP,)) == ids["15"], res)
    res = ctx(UQ, lambda d, u: a._career_tool_set_direction(d, u, CID, {"choice": "%s (JG15)" % T("ZQQ-BDV-01-15")}))
    s.check("...and refuses it for ANOTHER holder of the same job (it isn't in their options)", res.get("ok") is False, res)
    r = post(SUP, UQ, "role", ids["15"])
    s.check("...the admin role pick refuses it for them too (400)", r.status_code == 400)
    s.check("choosing one changed no set, no job", (snap(UP), snap(UQ)) == (snap_p, snap_q))

    s.section("the person page: the block, for the super admin only")
    html = _html.unescape(page(SUP, UP))
    s.check("the super admin's Career Plan card has the block with the first name, the three roles and its Suggest a role button",
            "Roles suggested for Aisyah" in html and "+ Suggest a role" in html and all(
                T("ZQQ-BDV-01-%s" % c) in html for c in ("14", "15", "16")), None)
    s.check("...rows say JG, the skills match, who and when (MYT)",
            re.search(r"JG 14 · 1 of 5 skills match · [^<]+, %s" % re.escape(a._myt_date_str(
                H.one(a, "SELECT created_at FROM tc_person_routes WHERE subject_id=? AND to_profile_id=?", (UP, ids["14"])))), html), None)
    s.check("...the role they chose (their role choice, set by the pick above) carries the Their choice chip",
            "Their choice" in html and html.index("Their choice") > html.index("Roles suggested for"))
    s.check("...the block sits under the role choice and above the profile fields (the card's order)",
            html.index("pp-role") < html.index("Roles suggested for") < html.index("Save their profile"))
    s.check("the confirm texts are as drawn: Suggest this role? / Suggest role; Remove red, Remove this suggested role? / Remove role",
            'data-confirm-title="Suggest this role?"' in html and 'data-confirm-ok="Suggest role"' in html
            and 'data-confirm-title="Remove this suggested role?"' in html and 'data-confirm-ok="Remove role"' in html
            and html.count('data-confirm-tone="danger"') >= 3
            and "It is their role choice: their choice stays, but the role is no longer offered to pick again." in html
            and "Their job, their competencies and everyone else's plan stay as they are." in html)
    pk = pick_data(html)
    pr = {x["id"]: x for x in (pk or {}).get("roles", [])}
    s.check("the picker's list is the active architecture roles from their grade to two up (JG 14 to JG 16), one batched read",
            pk and pk["range"] == "JG 14 to JG 16" and {ids["14"], ids["15"], ids["16"], P["ZQP-SUB-01-A-14"]} <= set(pr)
            and not ({P["ZQQ-BDV-01-13"], P["ZQQ-BDV-01-17"], P["ZQQ-BDV-02-14"], P["ZQQ-XXX-01-14"], P["ZQQ-DMO-01-14"], LEG} & set(pr)),
            sorted(pr))
    s.check("...greyed with the reasons: their own job, already suggested, already offered by their job",
            "job they hold" in pr[P["ZQP-SUB-01-A-14"]]["off"] and "Already suggested" in pr[ids["14"]]["off"]
            and "their job offers it" in pr[P["ZQP-SUB-01-A-15"]]["off"] and pr[ids["14"]]["match"] == "1 of 5 skills match"
            and pr[ids["14"]]["fam"] == "ZQ Cue Sales", {k: (v["off"], v["match"]) for k, v in pr.items()})
    bhtml = page(BAC, UP)
    s.check("a BG admin's Career Plan card has no block, and no picker data at all", "Roles suggested for" not in bhtml
            and "sg-data" not in bhtml and "pp-suggest" not in bhtml)
    s.check("...they do see today's card (the page loaded: its heading is there)", "Their career path" in bhtml, bhtml[:200])

    s.section("remove: it goes, their choice stays")
    ch_before = H.one(a, "SELECT target_profile_id FROM pm_career_profile WHERE subject_id=?", (UP,))
    r = post(SUP, UP, "suggest_remove", ids["15"])
    s.check("removed", r.status_code == 302 and (ids["15"], SU["id"]) not in rows_of(UP) and len(rows_of(UP)) == 2, rows_of(UP))
    s.check("...their role choice (it was this role) stays", H.one(
        a, "SELECT target_profile_id FROM pm_career_profile WHERE subject_id=?", (UP,)) == ch_before == ids["15"])
    s.check("...it is no longer offered", T("ZQQ-BDV-01-15") not in titles(roles_of(UP)))
    s.check("...in the audit trail", "removed: %s (JG 15)" % T("ZQQ-BDV-01-15") in audit(UP))
    r = post(SUP, UP, "suggest_remove", ids["15"])
    s.check("removing it again says it isn't one of theirs; nothing changes", "isn't one of the roles suggested" in flash_of(SUP, r)
            and len(rows_of(UP)) == 2)
    s.check("removing never touches their set or job", (snap(UP), snap(UQ)) == (snap_p, snap_q))
    r = post(SUP, UP, "suggest_add", ids["15"])
    s.check("it can be suggested again", r.status_code == 302 and (ids["15"], SU["id"]) in rows_of(UP))
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE users SET job_grade='16' WHERE id=?", (UP,))
        d.commit()
    html2 = page(SUP, UP)
    s.check("a suggestion now below their grade shows muted: not offered: below their grade now",
            "not offered: below their grade now" in html2)
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE users SET job_grade='14' WHERE id=?", (UP,))
        d.commit()
    s.check("the block shows with no suggestion too, with the empty-state words", (lambda h: "None yet. A role you suggest shows in "
            "their Career Plan as Suggested by Group People, for them alone." in h)(page(SUP, UQ)))

    s.section("the recommended step: a suggested role exactly one grade up leads (Chris, 2026-11-08)")
    with a.app.app_context():
        d = a.get_db()
        # a second JG 15 role in the commercial family that matches the person's own set better than BD-15 (lv 3 = what they hold)
        pid3 = d.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, plan_mode, source, active) "
                         "VALUES ('ZZPS Sub', ?, '15', 'ZQQ-BDV-03-15', 'explicit', 'architecture', 1)", (T("ZQQ-BDV-03-15"),)).lastrowid
        d.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, is_future) VALUES (?,?,3,0,0)",
                  (pid3, SK[("F", 3)]))
        v = dict(base, username="zz9ps-r", employee_id="ZZ9PS-R", full_name="ZZ PS Recommend", email=None, job_grade=14,
                 job_title="ZZPS Title", department="ZZPS Dept", business_group=BG, left_at=None, is_demo=0, role="user",
                 manager_id=None, hod_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, admin_bg=None)
        d.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        UR = d.execute("SELECT id FROM users WHERE employee_id='ZZ9PS-R'").fetchone()[0]
        d.execute("INSERT INTO ja_people(employee_id, family_code, sub_code, spec_code, unit_code, job_scope, arch_grade, source) "
                  "VALUES ('ZZ9PS-R','ZQP','ZQP-SUB','ZQP-SUB-01','ZQP-SUB-01-A','ZZPS','14','test')")
        ass = d.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?, 'submitted')", (CID, UR)).lastrowid
        for i, (t_, ans) in enumerate((("F", "yes"), ("G", "no"))):
            asg = d.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, seq, source) VALUES (?,?,?,0,?, 'admin')",
                            (CID, UR, SK[(t_, 3)], i)).lastrowid
            d.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer) VALUES (?,?,?)", (ass, asg, ans))
        d.commit()

    def suggest_only(*pids):
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("DELETE FROM tc_person_routes WHERE subject_id=?", (UR,))
            for pid_ in pids:
                d_.execute("INSERT INTO tc_person_routes(subject_id, to_profile_id, created_by) VALUES (?,?,?)", (UR, pid_, SU["id"]))
            d_.commit()

    def rec_of(uid):
        rs_ = roles_of(uid)
        return [r for r in rs_ if r.get("recommended")], rs_
    OWN15, BD15, BD15B, BD14, BD16 = (P["ZQP-SUB-01-A-15"], P["ZQQ-BDV-01-15"], pid3, P["ZQQ-BDV-01-14"], P["ZQQ-BDV-01-16"])

    suggest_only()
    rec, rs_ = rec_of(UR)
    s.check("1. no suggestions: the recommended step is their own job +1, as before", len(rec) == 1 and rec[0]["profile_id"] == OWN15
            and rs_[0] is rec[0] and rec[0]["next_step"] and not rec[0].get("suggested"), titles(rs_))
    tg = ctx(UR, lambda d_, u_: a._career_target_gap(d_, u_))
    s.check("   ...and with no role picked their goals are drafted from it", T("ZQP-SUB-01-A-15") in (tg["target"] or ""), tg["target"])

    suggest_only(BD15)
    rec, rs_ = rec_of(UR)
    tt_ = titles(rs_)
    s.check("2. one suggested role a grade up: it is the recommended step, first, once", len(rec) == 1 and rec[0]["profile_id"] == BD15
            and rec[0]["suggested"] and rs_[0] is rec[0] and tt_.count(T("ZQQ-BDV-01-15")) == 1, tt_)
    s.check("   ...their own job +1 is still listed, after it, not recommended", T("ZQP-SUB-01-A-15") in tt_
            and tt_.index(T("ZQP-SUB-01-A-15")) > 0 and not rs_[tt_.index(T("ZQP-SUB-01-A-15"))].get("recommended"), tt_)
    s.check("   ...and the recommended step is the better match here, the case Chris described",
            rec[0]["match"] >= rs_[tt_.index(T("ZQP-SUB-01-A-15"))]["match"], [(r["title"], r["match"]) for r in rs_])

    suggest_only(BD15, BD15B)
    rec, rs_ = rec_of(UR)
    m = {r["profile_id"]: r["match"] for r in rs_}
    s.check("3. two suggested roles a grade up: the better skills match is recommended, the other follows it, listed once",
            m[BD15B] > m[BD15] and len(rec) == 1 and rec[0]["profile_id"] == BD15B and rs_[0] is rec[0]
            and titles(rs_).count(T("ZQQ-BDV-01-15")) == 1 and rs_[1]["profile_id"] == BD15, [(r["title"], r["match"]) for r in rs_])
    tgb = ctx(UR, lambda d_, u_: a._career_target_gap(d_, u_))
    s.check("5. _career_target_gap with no role picked uses the recommended suggested JG 15 role (the better match), not their own job +1",
            T("ZQQ-BDV-03-15") in (tgb["target"] or "") and T("ZQP-SUB-01-A-15") not in (tgb["target"] or ""), tgb["target"])

    suggest_only(BD14, BD16)
    rec, rs_ = rec_of(UR)
    s.check("4. suggested roles at the same grade and two up only: the recommended step stays their own job +1",
            len(rec) == 1 and rec[0]["profile_id"] == OWN15 and not rec[0].get("suggested"), titles(rs_))

    suggest_only(P["ZQP-SUB-01-A-15"])
    rec, rs_ = rec_of(UR)
    s.check("   a suggestion the job also offers (merged, next_step kept) is recommended either way, once",
            len(rec) == 1 and rec[0]["profile_id"] == OWN15 and rec[0]["suggested"] and rec[0]["next_step"]
            and titles(rs_).count(T("ZQP-SUB-01-A-15")) == 1, titles(rs_))

    # falsify the guard: the old rule (no suggestion preference) must fail checks 2 and 3
    def _old_rule(roles, current):
        cur = a._jg_rank(current) if current is not None else None
        up = [r for r in roles if a._jg_rank(r.get("grade")) == cur + 1] if cur is not None else []
        return (next((r for r in up if r.get("next_step")), None)
                or next((r for r in up if (r.get("base_route") or r.get("route")) == "leadership track"), None)
                or next((r for r in up if r.get("next_job")), None))
    _new_rule, a._career_recommended = a._career_recommended, _old_rule
    try:
        suggest_only(BD15, BD15B)
        rec_old, _x = rec_of(UR)
        s.check("falsified: with the old rule the same two-suggestion case recommends their own job +1, so checks 2 and 3 would fail",
                len(rec_old) == 1 and rec_old[0]["profile_id"] == OWN15 and rec_old[0]["profile_id"] != BD15B)
    finally:
        a._career_recommended = _new_rule
    rec, _x = rec_of(UR)
    s.check("...and with the rule put back it is the better-matching suggestion again", rec[0]["profile_id"] == BD15B)
    suggest_only()

    s.section("what they know")
    src = H.source(a)
    s.check("Ask OneHR's Career Plan facts say it, and that a suggested role one grade up is the recommended step",
            "Group People can suggest roles for one person; they show in that person's Career "
            "Plan as Suggested by Group People. A suggested role one grade up from their grade is their recommended next step." in src.replace('"\n                         "', ""))
    body = src[src.index('if action in ("suggest_add", "suggest_remove"):'):src.index('if action == "reopen":')]
    s.check("the write never calls the job placer, the set writer, or names tc_assignments / ja_people",
            not any(w in body for w in ("_place_job_assign", "_tc_assign_from_profile", "tc_assignments", "ja_people", "ja_place_job")))
    s.check("the action is labelled in the audit log", a.action_label("career_suggest") != "Career suggest"
            and "Suggested a role" in a.action_label("career_suggest"))
finally:
    with a.app.app_context():
        _cleanup(a.get_db())
sys.exit(s.done())
