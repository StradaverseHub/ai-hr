"""The competency library (Chris, 2026-10-18: "ok, build them and deploy"; the libraries canvas boards 7-9 and the
Requests board's competency tab).

What this suite holds:
  * the index: every job's five with the level now and next and who wrote each (Chin Hin for a CHG- competency or a
    -CH level), its people by business group read by tc_profile_for_user's own rule, its specialisation's ladder, and
    every competency with the jobs using it now and next
  * the page: the tree by business group (or job family first), a job held in two groups as one profile ("Also in"),
    its five, its ladder; a competency opened with its levels and its jobs; the search
  * who: the super admin edits; a BG admin sees their group's jobs only, proposes, and is refused every edit
  * Edit the five: five different competencies at a written level, the next one level up where written (none past the
    top); one profile so every group that holds it changes; P&R's signed-off profile back to draft; this cycle's
    holders who haven't started get the new five, anyone who started keeps theirs; in the trail
  * a competency's levels edited for every job that uses it; a rename onto another competency's name refused
  * proposals: a BG admin's new competency for a job in their group, in SkillsFuture's shape, with a reason; decided on
    the Requests page's Competency tab; approved, it is a Chin Hin competency (CHG-) inactive until P&R's sign-off,
    which the super admin marks in its panel; until then it can't go on a job
  * the catalogue: by category, Used by one job, Similar names
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The competency library: jobs, their five, the catalogue and proposals")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BGA, BGB = "ZZCL Group A", "ZZCL Group B"
SPEC = "ZQC-SAL-01"
COMPS = [("ZZCL Sales Closure", "ZZCL Selling", [(3, "ZQA-SNM-3001-1.1"), (4, "ZQA-SNM-4001-1.1"),
                                                 (5, "ZQA-SNM-5001-CH1.0")]),
         ("ZZCL Pricing and Quotation Control", "ZZCL Selling", [(3, "CHG-SAL-3901-1.0"), (4, "CHG-SAL-4901-1.0")]),
         ("ZZCL Pricing and Quotation Management", "ZZCL Selling", [(3, "ZQA-PQM-3002-1.1"), (4, "ZQA-PQM-4002-1.1")]),
         ("ZZCL Account Planning", "ZZCL Selling", [(3, "ZQA-ACP-3003-1.1"), (4, "ZQA-ACP-4003-1.1")]),
         ("ZZCL Customer Care", "ZZCL Service", [(3, "ZQA-CUS-3004-1.1"), (4, "ZQA-CUS-4004-1.1"),
                                                 (5, "ZQA-CUS-5004-1.1")]),
         ("ZZCL Sales Forecasting", "ZZCL Selling", [(3, "ZQA-FOR-3005-1.1"), (4, "ZQA-FOR-4005-1.1"),
                                                     (5, "ZQA-FOR-5005-1.1"), (6, "ZQA-FOR-6005-1.1")]),
         ("ZZCL Tender Writing", "ZZCL Service", [(3, "ZQA-TEN-3006-1.1"), (4, "ZQA-TEN-4006-1.1")]),
         # another sector's skill with the same title: a different competency (its code family), as in SSG's data
         ("ZZCL Customer Care", "ZZCL Service", [(3, "ZQB-CUS-3004-1.1")])]


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9CL-%'")]
    db.execute("DELETE FROM tc_library_requests WHERE business_group IN (?,?)", (BGA, BGB))
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM tc_assessments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM tc_assignments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM ja_people WHERE employee_id LIKE 'ZZ9CL-%'")
    db.execute("DELETE FROM tc_job_profiles WHERE job_code LIKE 'ZQC-%'")
    db.execute("DELETE FROM tc_skills WHERE title LIKE 'ZZCL %'")
    db.execute("DELETE FROM ja_taxonomy WHERE code LIKE 'ZQC%'")
    db.execute("DELETE FROM activity_log WHERE action IN ('tc_profile','tc_skill','tc_request') AND detail LIKE '%ZZCL%'")
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BGA, BGB))
    db.commit()


def skid(code):
    return H.one(a, "SELECT id FROM tc_skills WHERE skill_code=?", (code,))


def five_of(pid, fut=0):
    return [r[0] for r in H.rows(a, "SELECT s.skill_code FROM tc_job_profile_skills ps JOIN tc_skills s ON "
                                    "s.id=ps.skill_id WHERE ps.profile_id=? AND ps.is_future=? ORDER BY ps.sort_order",
                                 (pid, fut))]


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    _prev = dict(db.execute("SELECT min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
    db.execute("UPDATE cycles SET min_job_grade=NULL WHERE id=?", (CID,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'UA'),(?, 'UB')", (BGA, BGB))
    db.execute("INSERT INTO ja_taxonomy(code, level, parent_code, name) VALUES ('ZQC', 'family', NULL, 'ZQC'),"
               "('ZQC-SAL', 'sub', 'ZQC', 'ZZCL Sales'),(?, 'spec', 'ZQC-SAL', 'ZZCL Sales Operations')", (SPEC,))
    for title, cat, levels in COMPS:
        for lvl, code in levels:
            db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, "
                       "proficiency_description, ability_items, knowledge_items, active) VALUES (?,?,?,'TSC',?,?,?,?,1)",
                       (code, title, lvl, cat, "%s at L%d" % (title, lvl), "Ability one\nAbility two", "Knowledge one"))
    P = {}
    for g, title in ((12, "ZZCL Executive, Sales"), (14, "ZZCL Senior Executive, Sales"), (16, "ZZCL Manager, Sales")):
        P[g] = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, review_status, "
                          "plan_mode, source, active) VALUES ('ZZCL Sales', ?, ?, ?, 'draft', 'explicit', 'arch', 1)",
                          (title, str(g), "%s-%d" % (SPEC, g))).lastrowid
    first5 = [c[2] for c in COMPS[:5]]
    for g, lvl in ((12, 3), (14, 3), (16, 4)):
        for i, levels in enumerate(first5, start=1):
            lv = dict(levels)
            db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, is_future) "
                       "VALUES (?, (SELECT id FROM tc_skills WHERE skill_code=?), ?, ?, 0)", (P[g], lv[lvl], lvl, i))
            if lvl + 1 in lv:
                db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, "
                           "is_future) VALUES (?, (SELECT id FROM tc_skills WHERE skill_code=?), ?, ?, 1)",
                           (P[g], lv[lvl + 1], lvl + 1, i))
    U = {}
    for k, bg, co, gr in (("1", BGA, "UA", "12"), ("2", BGB, "UB", "12"), ("3", BGA, "UA", "14"),
                          ("4", BGB, "UB", "16")):
        U[k] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                          "company, job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?, ?, ?, ?, '2020-01-01')",
                          ("zz9cl-" + k, "ZZ CL " + k, "ZZ9CL-" + k, bg, co, gr)).lastrowid
        db.execute("INSERT INTO ja_people(employee_id, family_code, sub_code, spec_code, unit_code, job_scope, title, "
                   "source) VALUES (?, 'ZQC', 'ZQC-SAL', ?, NULL, NULL, 'ZZCL Sales', 'test')", ("ZZ9CL-" + k, SPEC))
    ADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                     "VALUES ('zz9cl-bga', 'ZZ CL Groupadmin', 'x', 'admin', 'ZZ9CL-BGA', ?, ?)", (BGA, BGA)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
BA = H.client_as(a, ADM)
URL = "/admin/competency/library"
KEY = "ZQA-SNM-001"   # a competency is its code family


def five_form(pid, picks, refresh=True):
    d = {"csrf_token": "tok", "action": "five", "profile_id": str(pid)}
    for i, (k, lv) in enumerate(picks, start=1):
        d["skill_%d" % i], d["level_%d" % i] = k, str(lv)
    if refresh:
        d["refresh"] = "1"
    return d


try:
    s.section("the index")
    with a.app.test_request_context("/"):
        db = a.get_db()
        ix = a._tc_lib_index(db)
        holders = a._tc_profile_holders(db)
        rule = {}
        for k, uid in U.items():
            u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            prof, _src = a.tc_profile_for_user(db, u)
            rule[uid] = prof["id"] if prof else None
    by_rule = {}
    for uid, pid in rule.items():
        by_rule.setdefault(pid, set()).add(uid)
    s.check("each job's people are tc_profile_for_user's own answer, read in one pass",
            all({h["id"] for h in holders.get(pid, [])} == uids for pid, uids in by_rule.items() if pid)
            and by_rule.get(P[12]) == {U["1"], U["2"]}, (by_rule, {k: [h["id"] for h in v] for k, v in holders.items()
                                                              if k in P.values()}))
    p12 = ix["profiles"][P[12]]
    s.check("a job held in two groups is one profile, its people counted by group",
            p12["bgs"] == {BGA: 1, BGB: 1} and p12["people"] == 2, p12["bgs"])
    s.check("its five: the level now and next, who wrote each",
            [(f["title"], f["now"], f["next"], f["source"]) for f in p12["five"]][:2] == [
                ("ZZCL Sales Closure", 3, 4, "SkillsFuture"), ("ZZCL Pricing and Quotation Control", 3, 4, "Chin Hin")]
            and len(p12["five"]) == 5, p12["five"][:2])
    s.check("a level Chin Hin wrote for an SSG competency reads Chin Hin", a.tc_skill_source("ZQA-SNM-5001-CH1.0") ==
            "Chin Hin" and a.tc_skill_source("ZQA-SNM-4001-1.1") == "SkillsFuture")
    s.check("the specialisation's ladder, by grade, each at its level",
            [(ix["profiles"][i]["grade"], ix["profiles"][i]["level"]) for i in ix["ladders"][(SPEC, "")]] ==
            [(12, 3), (14, 3), (16, 4)])
    s.check("a competency is its code family, not its title (two sectors' skills share titles)",
            a.tc_comp_key("ZQA-SNM-3001-1.1") == a.tc_comp_key("ZQA-SNM-5001-CH1.0") == "ZQA-SNM-001"
            and a.tc_comp_key("CHG-PRD-3008-1.0") == "CHG-PRD-008"
            and a.tc_comp_key("ZQA-CUS-3004-1.1") != a.tc_comp_key("ZQB-CUS-3004-1.1"))
    sk = ix["skills"].get(KEY) or {}
    s.check("a competency knows the jobs using it now and as their next level",
            sk.get("now") == {P[12], P[14], P[16]} and sk.get("next") == {P[12], P[14], P[16]}
            and sk.get("levels") == [3, 4, 5])

    s.section("the page")
    pg = SUP.get(URL + "?job=%d&g=%s" % (P[12], BGA)).get_data(as_text=True)
    s.check("the tree by business group: both groups, the job under the open one, the other a link (rendered once opened)",
            "ZZCL Group A" in pg and 'class="kl-tn cl-bgl"' in pg and "ZZCL Group B" in pg
            and pg.count("ZZCL Executive, Sales · JG 12</span>") == 1)
    pgb = SUP.get(URL + "?job=%d&g=%s" % (P[12], BGB)).get_data(as_text=True)
    s.check("...opened from the other group: the same job, Also in the first", "Also in ZZCL Group A" in pgb
            and pgb.count("ZZCL Executive, Sales · JG 12</span>") == 1)
    s.check("the job: held in both, one profile; Also in the other; its five; Edit the five",
            "one profile for all" in pg and "Also in ZZCL Group B" in pg and "ZZCL Sales Closure" in pg
            and "L3 &rarr; L4" in pg and "Edit the five" in pg and "Draft · with P&amp;R for review" in pg)
    s.check("the ladder in its specialisation", len(re.findall(r'class="cl-rung( is-on)?"', pg)) == 3
            and "JG 16 · L4" in pg)
    pg = SUP.get(URL + "?by=jf&q=manager").get_data(as_text=True)
    s.check("job family first, and the search", "ZZCL Manager, Sales · JG 16</span>" in pg
            and "ZZCL Executive, Sales · JG 12</span>" not in pg)
    pg = SUP.get(URL + "?job=%d&skill=%s&panel=skill" % (P[12], KEY)).get_data(as_text=True)
    s.check("a competency opened: its levels, its jobs, Edit", 'id="pnl-skill"' in pg and "ZQA-SNM-5001-CH1.0" in pg
            and "used by 3 jobs now" in pg and "ZZCL Manager, Sales · JG 16" in pg and ">Edit</a>" in pg)

    s.section("a BG admin")
    pg = BA.get(URL + "?job=%d" % P[12]).get_data(as_text=True)
    s.check("sees their group's jobs only, and Propose instead of Edit",
            "ZZCL Group A" in pg and "ZZCL Group B</span><span" not in pg and "Propose a competency" in pg
            and "Edit the five" not in pg)
    jf = BA.get(URL + "?by=jf").get_data(as_text=True)
    s.check("...job family first too: a job only another group holds isn't there", "ZZCL Senior Executive, Sales" in jf
            and "ZZCL Manager, Sales · JG 16</span>" not in jf)
    s.check("...every edit refused", BA.post(URL, data=five_form(P[12], [])).status_code == 403
            and BA.post(URL, data={"csrf_token": "tok", "action": "skill", "key": KEY}).status_code == 403
            and BA.post(URL, data={"csrf_token": "tok", "action": "signoff", "key": KEY}).status_code == 403)

    s.section("Edit the five")
    with a.app.app_context():
        db = a.get_db()
        a._tc_assign_from_profile(db, CID, U["1"], P[12])
        a._tc_assign_from_profile(db, CID, U["2"], P[12])
        asm = db.execute("INSERT INTO tc_assessments(cycle_id, subject_id) VALUES (?,?)", (CID, U["2"])).lastrowid
        first = db.execute("SELECT id FROM tc_assignments WHERE cycle_id=? AND subject_id=? ORDER BY id LIMIT 1",
                           (CID, U["2"])).fetchone()[0]
        db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer) VALUES (?,?, 'yes')", (asm, first))
        db.execute("UPDATE tc_job_profiles SET review_status='approved' WHERE id=?", (P[12],))
        db.commit()
    u2_before = H.rows(a, "SELECT skill_id FROM tc_assignments WHERE cycle_id=? AND subject_id=? ORDER BY skill_id",
                       (CID, U["2"]))
    picks = [("ZQA-SNM-001", 3), ("ZQA-CUS-004", 3), ("ZQA-TEN-006", 3), ("ZQA-FOR-005", 3), ("ZQA-ACP-003", 3)]
    r = SUP.post(URL, data=five_form(P[12], picks), follow_redirects=True).get_data(as_text=True)
    s.check("five different competencies at a level each: saved", five_of(P[12]) == [
        "ZQA-SNM-3001-1.1", "ZQA-CUS-3004-1.1", "ZQA-TEN-3006-1.1", "ZQA-FOR-3005-1.1", "ZQA-ACP-3003-1.1"], r[-300:])
    s.check("...the next level of each, one up", five_of(P[12], 1) == [
        "ZQA-SNM-4001-1.1", "ZQA-CUS-4004-1.1", "ZQA-TEN-4006-1.1", "ZQA-FOR-4005-1.1", "ZQA-ACP-4003-1.1"])
    s.check("...P&R's signed-off profile goes back to draft, and the page says so", H.one(
        a, "SELECT review_status FROM tc_job_profiles WHERE id=?", (P[12],)) == "draft" and "back to P&amp;R" in r)
    got = {x[0] for x in H.rows(a, "SELECT skill_id FROM tc_assignments WHERE cycle_id=? AND subject_id=?",
                                (CID, U["1"]))}
    s.check("...this cycle's holder who hadn't started has the new five (and their next levels)",
            got == {skid(c) for c in five_of(P[12]) + five_of(P[12], 1)}, len(got))
    s.check("...the one who had started keeps theirs", H.rows(
        a, "SELECT skill_id FROM tc_assignments WHERE cycle_id=? AND subject_id=? ORDER BY skill_id",
        (CID, U["2"])) == u2_before and "1 had started and keep theirs" in r)
    s.check("...in the trail, before and after", H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='tc_profile' AND detail LIKE '%ZZCL Executive, Sales%' AND "
           "detail LIKE '%was ZQA-SNM-3001-1.1%'") == 1)
    before = five_of(P[12])
    try:
        r = SUP.post(URL, data=five_form(P[12], picks[:4] + [("ZQA-SNM-001", 3)]), follow_redirects=True)
        said = r.get_data(as_text=True)
    except Exception as e:   # noqa: BLE001 -- a guard gone shows as a crash on the UNIQUE key: a failed check
        said = "crashed: %s" % type(e).__name__
    s.check("the same competency twice is refused", five_of(P[12]) == before
            and "five different competencies" in said, said[-200:])
    try:
        said = SUP.post(URL, data=five_form(P[12], picks[:4] + [("ZQA-ACP-003", 6)]),
                        follow_redirects=True).get_data(as_text=True)
    except Exception as e:   # noqa: BLE001 -- a guard gone shows as a crash: a failed check
        said = "crashed: %s" % type(e).__name__
    s.check("a level that isn't written is refused, told why", five_of(P[12]) == before
            and "has no L6 written" in said, said[-200:])
    SUP.post(URL, data=five_form(P[12], picks[:4]))
    s.check("fewer than five is refused", five_of(P[12]) == before)
    SUP.post(URL, data=five_form(P[16], [("ZQA-SNM-001", 5), ("ZQA-CUS-004", 5), ("ZQA-TEN-006", 4),
                                         ("ZQA-FOR-005", 6), ("ZQA-ACP-003", 4)], refresh=False))
    s.check("at its top written level (or L6) a competency has no next level", five_of(P[16]) == [
        "ZQA-SNM-5001-CH1.0", "ZQA-CUS-5004-1.1", "ZQA-TEN-4006-1.1", "ZQA-FOR-6005-1.1", "ZQA-ACP-4003-1.1"]
        and five_of(P[16], 1) == [])

    s.section("a competency's levels")
    rows = H.rows(a, "SELECT id, level FROM tc_skills WHERE skill_code LIKE 'ZQA-CUS-%' ORDER BY level")
    form = {"csrf_token": "tok", "action": "skill", "key": "ZQA-CUS-004", "title": "ZZCL Customer Care",
            "category": "ZZCL Service"}
    for rid, lvl in rows:
        form["desc_%d" % rid] = "Looks after customers at L%d" % lvl
        form["abil_%d" % rid] = "- Answer within a day\n\n- Close the loop"
        form["know_%d" % rid] = "Service standards"
    SUP.post(URL, data=form)
    got = H.rows(a, "SELECT proficiency_description, ability_items FROM tc_skills WHERE skill_code LIKE 'ZQA-CUS-%' "
                    "ORDER BY level")
    s.check("every level saved for every job using it (bullets and blanks tidied)", tuple(got[0]) == (
        "Looks after customers at L3", "Answer within a day\nClose the loop") and len(got) == 3
        and H.one(a, "SELECT proficiency_description FROM tc_skills WHERE skill_code='ZQB-CUS-3004-1.1'") ==
        "ZZCL Customer Care at L3")
    s.check("...the other sector's skill of the same title isn't touched (a competency is its code family)", H.one(
        a, "SELECT ability_items FROM tc_skills WHERE skill_code='ZQB-CUS-3004-1.1'") == "Ability one\nAbility two")
    s.check("...in the trail", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='tc_skill' AND detail LIKE "
                                        "'ZZCL Customer Care%'") == 1)
    SUP.post(URL, data=dict(form, title="ZZCL Tender Writing"))
    s.check("a rename onto another competency's name is refused", H.one(
        a, "SELECT COUNT(*) FROM tc_skills WHERE title='ZZCL Customer Care' AND skill_code LIKE 'ZQA-%'") == 3)
    SUP.post(URL, data=dict(form, **{"desc_%d" % rows[0][0]: ""}))
    s.check("a level with no description is refused", H.one(
        a, "SELECT proficiency_description FROM tc_skills WHERE id=?", (rows[0][0],)) == "Looks after customers at L3")

    s.section("proposals")
    prop = {"csrf_token": "tok", "action": "propose", "profile_id": str(P[12]), "title": "ZZCL Showroom Conversion",
            "category": "ZZCL Selling", "reason": "Showroom staff need it",
            "desc_3": "Converts showroom visits", "abil_3": "Greet\nQualify", "know_3": "Product range",
            "desc_4": "Coaches others to convert", "abil_4": "Coach", "know_4": "Conversion metrics"}
    BA.post(URL, data=prop)
    rq = H.rows(a, "SELECT id, status, payload_json FROM tc_library_requests WHERE business_group=?", (BGA,))
    pl = json.loads(rq[0][2]) if rq else {}
    s.check("a BG admin proposes a new competency for a job in their group, at its level now and next",
            len(rq) == 1 and rq[0][1] == "waiting" and [lv["level"] for lv in pl.get("levels", [])] == [3, 4]
            and pl.get("job_code") == "%s-12" % SPEC, rq)
    s.check("...a name the catalogue has is refused", BA.post(URL, data=dict(prop, title="ZZCL Tender Writing"))
            .status_code == 302 and H.one(a, "SELECT COUNT(*) FROM tc_library_requests WHERE business_group=?",
                                          (BGA,)) == 1)
    BA.post(URL, data=dict(prop, title="ZZCL Missing Ability", abil_4=""))
    s.check("...each level needs its abilities and knowledge", H.one(
        a, "SELECT COUNT(*) FROM tc_library_requests WHERE payload_json LIKE '%Missing Ability%'") == 0)
    s.check("...never for a job their group doesn't hold", BA.post(URL, data=dict(prop, profile_id=str(P[16])))
            .status_code == 404)
    RQ = "/admin/competency/library/requests"
    pg = SUP.get(RQ).get_data(as_text=True)
    s.check("the super admin sees it on Requests' Competency tab", "ZZCL Showroom Conversion" in pg
            and "Approve for P&amp;R" in pg and "New competency · job" in pg)
    s.check("...the KPI tab offers the switch, with the count", ">Competency<span>1</span>" in SUP.get(
        "/admin/performance/library/requests").get_data(as_text=True))
    s.check("a BG admin sees their own as My proposals, and can't decide", "My proposals" in BA.get(RQ).get_data(
        as_text=True) and BA.post(RQ, data={"csrf_token": "tok", "action": "approve", "request_id": rq[0][0]})
        .status_code == 403)
    SUP.post(RQ, data={"csrf_token": "tok", "action": "approve", "request_id": rq[0][0]})
    new = H.rows(a, "SELECT skill_code, level, active FROM tc_skills WHERE title='ZZCL Showroom Conversion' "
                    "ORDER BY level")
    s.check("approved: a Chin Hin competency (CHG-<sub>-), each level, inactive until P&R sign it off",
            [(c[:8], lv, act) for c, lv, act in new] == [("CHG-SAL-", 3, 0), ("CHG-SAL-", 4, 0)]
            and new[0][0][9:12] == new[1][0][9:12] and new[0][0][9:12] == "902", new)
    s.check("...the proposal says so, in the trail", H.one(
        a, "SELECT status FROM tc_library_requests WHERE id=?", (rq[0][0],)) == "approved" and H.one(
        a, "SELECT COUNT(*) FROM activity_log WHERE action='tc_request' AND detail LIKE '%approved: ZZCL Showroom%'") == 1)
    pg = SUP.get(URL + "?skill=CHG-SAL-902&panel=skill").get_data(as_text=True)
    s.check("its panel: inactive, who proposed it, and P&R's sign-off to mark", "Waiting for P&amp;R sign-off" in pg
            and "ZZ CL Groupadmin" in pg and "P&amp;R signed it off</button>" in pg)
    SUP.post(URL, data=five_form(P[14], picks[:4] + [("CHG-SAL-902", 3)], refresh=False))
    s.check("...until then it can't go on a job", "ZZCL Showroom Conversion" not in str(five_of(P[14])) and not any(
        c.startswith("CHG-SAL-3902") for c in five_of(P[14])))
    SUP.post(URL, data={"csrf_token": "tok", "action": "signoff", "key": "CHG-SAL-902"})
    s.check("signed off: in use", H.one(a, "SELECT MIN(active) FROM tc_skills WHERE title='ZZCL Showroom Conversion'")
            == 1)
    SUP.post(URL, data=five_form(P[14], picks[:4] + [("CHG-SAL-902", 3)], refresh=False))
    s.check("...and it can go on a job", any(c.startswith("CHG-SAL-3902") for c in five_of(P[14])), five_of(P[14]))
    BA.post(URL, data=dict(prop, title="ZZCL Second Idea"))
    rid = H.one(a, "SELECT id FROM tc_library_requests WHERE payload_json LIKE '%ZZCL Second Idea%'")
    SUP.post(RQ, data={"csrf_token": "tok", "action": "reject", "request_id": rid})
    s.check("a rejection needs its reason", H.one(a, "SELECT status FROM tc_library_requests WHERE id=?", (rid,)) ==
            "waiting")
    SUP.post(RQ, data={"csrf_token": "tok", "action": "reject", "request_id": rid, "note": "Use Customer Care"})
    s.check("...with one, rejected", H.one(a, "SELECT status, decision_note FROM tc_library_requests WHERE id=?",
                                           (rid,)) is not None and tuple(H.rows(
        a, "SELECT status, decision_note FROM tc_library_requests WHERE id=?", (rid,))[0]) == ("rejected",
                                                                                                   "Use Customer Care"))

    s.section("the catalogue")
    CAT = "/admin/competency/library/catalogue"
    pg = SUP.get(CAT + "?cat=ZZCL+Selling").get_data(as_text=True)
    s.check("by category, each competency with its levels and jobs", "ZZCL Selling" in pg and "ZZCL Sales Closure" in pg
            and "L3 to L5" in pg and "competencies ·" in pg)
    s.check("two sectors' skills of one title are two competencies, each named with its code family",
            "ZZCL Customer Care · ZQA-CUS-004" in SUP.get(CAT + "?cat=ZZCL+Service").get_data(as_text=True)
            and "ZZCL Customer Care · ZQB-CUS-004" in SUP.get(CAT + "?cat=ZZCL+Service").get_data(as_text=True))
    s.check("Similar names: two names that may be one", "Similar to ZZCL Pricing and Quotation Management" in SUP.get(
        CAT + "?show=similar&cat=ZZCL+Selling").get_data(as_text=True))
    one = SUP.get(CAT + "?show=one&cat=ZZCL+Selling").get_data(as_text=True)
    s.check("Used by one job", "ZZCL Showroom Conversion" in one and "ZZCL Sales Closure</a>" not in one)
    s.check("a BG admin reads it too", BA.get(CAT).status_code == 200)

    s.section("where it lives")
    src = H.source(a)
    s.check("Competency › Settings lists the library, its catalogue and requests",
            '_pg("admin_competency_library", "Competency library", hidden=True)' in src
            and '"open": ("admin_competency_library", "Open the competency library")' in src)
    s.check("every POST form on the pages is double-confirmed", all(
        'data-confirm=' in f for f in open(os.path.join(H.REPO, "templates", "admin_competency_library.html"),
                                           encoding="utf-8").read().split('<form method="post"')[1:]))
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _db.execute("UPDATE cycles SET min_job_grade=? WHERE id=?", (_prev["min_job_grade"], CID))
        _cleanup(_db)

sys.exit(s.done())
