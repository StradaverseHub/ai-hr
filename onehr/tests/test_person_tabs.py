"""The person page, part 2 (Chris, 2026-10-10, canvas I3-I6): Competency, 360 Feedback, Career Plan, History.

Each tab reads its module's own readers and writes through its module's own path: the competency generator's rules
(a set with answers is never swapped -- tc_scores cascades on tc_assignments -- and a reviewed set is final), the panel
editor (posted to with `next` back to the person page), the career profile's one write path (HR's mode skips the
person's own window and lock, and is logged as HR's), and the ratings record for the history. Everything here is
synthetic (ZZPX-*) and is removed at the end.
"""
import html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The person page, part 2 -- Competency, 360 Feedback, Career Plan, History")

BG, BG2, CO = "ZZPX BG", "ZZPX Other BG", "ZZPX CO"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZPX-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        for t in ("tc_assignments", "tc_assessments", "rating_records", "pm_kpi_targets"):
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (t, ph), ids)
        db.execute("DELETE FROM pm_idp WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM pm_career_profile WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM tc_career_routes WHERE from_profile_id IN (SELECT id FROM tc_job_profiles WHERE "
               "job_title LIKE 'ZZPX%')")
    db.execute("DELETE FROM tc_job_profiles WHERE job_title LIKE 'ZZPX%'")
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZPX-%'")
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG2))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    PAST = db.execute("SELECT id FROM cycles WHERE id!=? ORDER BY id DESC LIMIT 1", (CID,)).fetchone()
    PAST = PAST[0] if PAST else None
    _cleanup(db)
    _wins = [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=? AND cell='idp_self'", (CID,))]
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, mgr=None, bg=BG, role="user", admin_bg=None, title="ZZPX Engineer"):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=mgr,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=bg, company=CO,
                 department="ZZPX Dept", job_title=title, job_grade="16", years_of_service=3, confirmation_date=None,
                 left_at=None, is_demo=0, role=role, admin_bg=admin_bg)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    LM = mk("ZZPX-LM", "ZZ PX Manager", title="ZZPX Lead")
    A = mk("ZZPX-A", "ZZ PX Alpha", mgr=LM)
    PEER = mk("ZZPX-P", "ZZ PX Peer", mgr=LM)
    OTHER_ADM = mk("ZZPX-ADM", "ZZ PX Otheradmin", bg=BG2, role="admin", admin_bg=BG2)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?),(?,?)", (BG, CO, BG2, CO))
    sk = {}
    for code, title, lvl in (("ZZPX-S1-3", "ZZPX Planning", 3), ("ZZPX-S1-4", "ZZPX Planning", 4),
                             ("ZZPX-S2-3", "ZZPX Safety", 3), ("ZZPX-S3-4", "ZZPX Programmes", 4),
                             ("ZZPX-S4-2", "ZZPX Drawing", 2)):
        db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type) VALUES (?,?,?, 'Technical')",
                   (code, title, lvl))
        sk[code] = db.execute("SELECT id FROM tc_skills WHERE skill_code=?", (code,)).fetchone()[0]
    db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, proficiency_level, source) "
               "VALUES ('ZZPX Dept', 'ZZPX Engineer', '16', 3, 'manual')")
    # a ZZ account's role choices come from the demo-tagged profiles (_career_candidate_roles), so this one is one
    db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, proficiency_level, source) "
               "VALUES ('ZZPX Other', 'ZZPX Senior Engineer', '17', 4, ?)", (a._CAREER_DEMO_SOURCE,))
    P1 = db.execute("SELECT id FROM tc_job_profiles WHERE job_title='ZZPX Engineer'").fetchone()[0]
    P2 = db.execute("SELECT id FROM tc_job_profiles WHERE job_title='ZZPX Senior Engineer'").fetchone()[0]
    for pid, code in ((P1, "ZZPX-S1-3"), (P1, "ZZPX-S2-3"), (P2, "ZZPX-S3-4")):
        db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id) VALUES (?,?)", (pid, sk[code]))
    db.execute("INSERT INTO tc_career_routes(from_profile_id, to_profile_id, kind) VALUES (?,?, 'pinned')", (P1, P2))
    db.commit()
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL "
                     "LIMIT 1").fetchone()[0]


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def u(uid):
    return ctx(lambda d: dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()))


def tcs():
    return {r[0]: r[1] for r in H.rows(a, "SELECT s.skill_code, a.source FROM tc_assignments a JOIN tc_skills s ON "
                                          "s.id=a.skill_id WHERE a.cycle_id=? AND a.subject_id=?", (CID, A))}


sup = H.client_as(a, SUP)
COMP = "/admin/users/%d/competency" % A


def post(url, **f):
    d = {"csrf_token": "tok"}
    d.update(f)
    r = sup.post(url, data=d, follow_redirects=True)
    return r.status_code, html.unescape(r.get_data(as_text=True))


def page(tab, extra=""):
    r = sup.get("/admin/users/%d?tab=%s%s" % (A, tab, extra))
    return r.status_code, html.unescape(r.get_data(as_text=True))


try:
    # -----------------------------------------------------------------------
    s.section("Competency: the match, the list, and what can change")
    code, b = page("competency")
    s.check("the tab opens, and their job matches its library profile exactly", code == 200 and "Exact match" in b
            and "ZZPX Engineer" in b, code)
    post(COMP, action="reset")
    s.check("Reset assigns the profile's competencies, with the level above as their future half",
            tcs() == {"ZZPX-S1-3": "profile", "ZZPX-S2-3": "profile", "ZZPX-S1-4": "profile"}, tcs())
    # one line per competency (Chris, 2026-10-20): a competency and its own next level, removed together
    code, b = page("competency")
    import re as _re
    crow = {m.group(1): m.group(2) for m in _re.finditer(r'<div class="pp-crow[^"]*"[^>]*>\s*<b><button[^>]*>([^<]+)</button></b><span class="muted">'
                                                           r'[^<]*</span><span class="pp-lv">([^<]+)</span>', b)}
    s.check("a competency and its next level are one line (L3 → L4); one with no next level is its own",
            crow.get("ZZPX Planning") == "L3 → L4" and crow.get("ZZPX Safety") == "L3"
            and len(_re.findall(r"data-cd-open[^>]*>ZZPX Planning</button>", b)) == 1, crow)
    ids = {r[0]: r[1] for r in H.rows(a, "SELECT s.skill_code, a.id FROM tc_assignments a JOIN tc_skills s ON "
                                         "s.id=a.skill_id WHERE a.cycle_id=? AND a.subject_id=?", (CID, A))}
    s.check("the line's Remove carries both of its levels",
            b.count('name="assignment_id" value="%d"' % ids["ZZPX-S1-3"]) == 1
            and b.count('name="assignment_id" value="%d"' % ids["ZZPX-S1-4"]) == 1)
    code, b = post(COMP, action="remove", assignment_id=ids["ZZPX-S1-3"])
    s.check("...so one half alone isn't removed", code == 404 and "ZZPX-S1-3" in tcs() and "ZZPX-S1-4" in tcs(), code)
    code, b = post(COMP, action="remove", assignment_id=[ids["ZZPX-S1-3"], ids["ZZPX-S1-4"]])
    s.check("...and Remove takes both off, logged once", "ZZPX-S1-3" not in tcs() and "ZZPX-S1-4" not in tcs()
            and "Removed ZZPX Planning (L3 and its next level, L4)" in b
            and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE target_user_id=? AND action='tc_person_remove' AND "
                         "detail LIKE '%ZZPX Planning L3 and its next level, L4%'", (A,)) == 1)
    lines = a._person_competency_lines([
        {"id": 1, "is_future": 0, "skill_code": "BEV-OPR-6005-1.1", "title": "Ops", "level": 6, "source": "profile",
         "from": "Job profile", "can_remove": True},
        {"id": 2, "is_future": 1, "skill_code": "BEV-STR-6009-1.1", "title": "Ops Strategy", "level": 6,
         "source": "profile", "from": "Their future role", "can_remove": True}])
    s.check("at the top level, a new advanced competency for the next step is a line of its own",
            [(x["title"], x["level"], x["new_next"]) for x in lines] == [("Ops", "L6", False),
                                                                         ("Ops Strategy", "Next: L6", True)], lines)
    post(COMP, action="reset")
    ctx(lambda d: (d.execute("DELETE FROM activity_log WHERE target_user_id=? AND action='tc_person_remove'", (A,)),
                   d.execute("DELETE FROM activity_log WHERE target_user_id=? AND action='tc_person_reset'", (A,)),
                   d.commit()))
    post(COMP, action="reset")
    code, b = page("competency", "&pq=ZZPX&profile=%d" % P2)
    s.check("matching another profile previews what changes first, writing nothing",
            "+ ZZPX Programmes L4" in b and "ZZPX Planning L3" in b and "ZZPX-S3-4" not in tcs())
    post(COMP, action="match", profile_id=P2)
    s.check("...and Apply swaps their set, marked as HR's", tcs() == {"ZZPX-S3-4": "admin_profile"}, tcs())
    rep = ctx(lambda d: a.tc_generate_assignments(d, u(SUP), CID, commit=False))
    s.check("the generator then leaves them as HR set them", A in {x["id"] for x in rep["manual"]}
            and A not in {x["id"] for x in rep["assign"]})
    post(COMP, action="add", skill_id=sk["ZZPX-S4-2"])
    s.check("Add puts a library competency on, marked as added by HR", tcs().get("ZZPX-S4-2") == "admin")
    code, b = post(COMP, action="add", skill_id=sk["ZZPX-S4-2"])
    s.check("...and not twice", "already has ZZPX Drawing L2" in b)
    s.check("the trail has each change", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE target_user_id=? AND "
                                                  "action IN ('tc_person_reset','tc_person_match','tc_person_add')",
                                               (A,)) == 3)
    aid = H.one(a, "SELECT a.id FROM tc_assignments a JOIN tc_skills s ON s.id=a.skill_id WHERE a.subject_id=? AND "
                   "s.skill_code='ZZPX-S4-2'", (A,))
    post(COMP, action="remove", assignment_id=aid)
    s.check("Remove takes one off", "ZZPX-S4-2" not in tcs())

    def answer(d):
        d.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?, 'pending')", (CID, A))
        asid = d.execute("SELECT id FROM tc_assessments WHERE cycle_id=? AND subject_id=?", (CID, A)).fetchone()[0]
        t = d.execute("SELECT a.id FROM tc_assignments a JOIN tc_skills s ON s.id=a.skill_id WHERE a.subject_id=? "
                      "AND s.skill_code='ZZPX-S3-4'", (A,)).fetchone()[0]
        d.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer) VALUES (?,?, 'yes')", (asid, t))
        d.commit()
        return t
    t3 = ctx(answer)
    code, b = post(COMP, action="match", profile_id=P1)
    s.check("once they've answered, the set can't be swapped (their answers would go with it)",
            "can't be swapped" in b and tcs() == {"ZZPX-S3-4": "admin_profile"})
    code, b = post(COMP, action="reset")
    s.check("...nor reset", tcs() == {"ZZPX-S3-4": "admin_profile"})
    code, b = post(COMP, action="remove", assignment_id=t3)
    s.check("...and an answered competency can't be removed", "ZZPX-S3-4" in tcs())
    post(COMP, action="add", skill_id=sk["ZZPX-S4-2"])
    s.check("...but one can still be added", "ZZPX-S4-2" in tcs())
    ctx(lambda d: (d.execute("UPDATE tc_assessments SET status='reviewed' WHERE subject_id=?", (A,)), d.commit()))
    code, b = post(COMP, action="add", skill_id=sk["ZZPX-S2-3"])
    s.check("once their manager has reviewed it, nothing changes", "is final" in b and "ZZPX-S2-3" not in tcs())
    code, b = page("competency")
    s.check("...and the tab offers no changes", "Change the match" not in b and 'value="remove"' not in b)

    # -----------------------------------------------------------------------
    s.section("360 Feedback: the panel editor, back to the person page")
    here = "/admin/users/%d?tab=f360" % A
    r = sup.post("/admin/subjects/%d/panel" % A, data={"csrf_token": "tok", "action": "add", "assessor_eid": "ZZPX-P",
                                                       "relationship": "peer", "next": here})
    s.check("adding an assessor through the editor comes back to the 360 tab",
            r.status_code == 302 and r.headers["Location"].endswith(here), r.headers.get("Location"))
    asg = H.one(a, "SELECT id FROM assignments WHERE subject_id=? AND assessor_id=? AND cycle_id=?", (A, PEER, CID))
    s.check("...and they're on the panel", asg is not None)
    code, b = page("f360")
    s.check("the tab lists them, the criteria, and a way to remove them",
            "ZZ PX Peer" in b and "What they're rated on" in b and 'value="remove"' in b)
    r = sup.post("/admin/subjects/%d/panel" % A, data={"csrf_token": "tok", "action": "remove", "assignment_id": asg,
                                                       "next": "//evil.example/x"})
    s.check("a `next` off this site is ignored: back to the editor instead",
            r.headers["Location"].endswith("/admin/subjects/%d/panel" % A), r.headers.get("Location"))
    s.check("...the removal still happened", H.one(a, "SELECT COUNT(*) FROM assignments WHERE id=?", (asg,)) == 0)

    # -----------------------------------------------------------------------
    s.section("Career Plan: HR's changes go through the profile's one write path")
    ctx(lambda d: (d.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES "
                             "(?, 'idp_self', '2000-01-01 00:00', '2000-01-02 00:00')", (CID,)), d.commit()))
    ok, err = ctx(lambda d: a.pm_career_save_field(d, A, "aspiration_now", "x"))
    s.check("(the person's own window is shut)", not ok and err, err)
    code, b = post("/admin/users/%d/plan" % A, action="profile", aspiration_now="Lead a site", mobility="within_bg",
                   mentor="ZZ PX Manager")
    prof = ctx(lambda d: a.pm_career_profile_for(d, A))
    s.check("HR saves their profile anyway, through the same validation",
            prof and prof["aspiration_now"] == "Lead a site" and prof["mobility"] == "within_bg", prof)
    s.check("...logged as HR's", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='career_profile_admin' AND "
                                         "target_user_id=? AND detail LIKE '%aspiration_now%'", (A,)) == 1)
    code, b = post("/admin/users/%d/plan" % A, action="profile", mobility="the moon")
    s.check("...and the validation still holds (mobility must be one of the list)",
            ctx(lambda d: a.pm_career_profile_for(d, A))["mobility"] == "within_bg")
    roles = ctx(lambda d: a._career_candidate_roles(d, u(A))["roles"])
    if any(r_.get("profile_id") == P2 for r_ in roles):
        post("/admin/users/%d/plan" % A, action="role", profile_id=P2)
        s.check("their role choice can be set from the routes their job offers",
                ctx(lambda d: a.pm_career_profile_for(d, A))["target_profile_id"] == P2)
    else:
        s.note("no route to ZZPX Senior Engineer on this database: the role choice set is covered by the 400 below")
    r = sup.post("/admin/users/%d/plan" % A, data={"csrf_token": "tok", "action": "role", "profile_id": "999999"})
    s.check("a role that isn't one of their routes is refused", r.status_code == 400, r.status_code)
    year = ctx(lambda d: a.pm_idp_plan_year(a.active_cycle(d)))
    if year:
        ctx(lambda d: (d.execute("INSERT INTO pm_idp(plan_year, subject_id, status, shared_at) VALUES "
                                 "(?,?, 'shared', datetime('now'))", (year, A)), d.commit()))
        # Reopen is the admin Reopen's one writer since 2026-10-16 (test_admin_reopen holds its rules): a reason, and
        # the Year-End only, because the plan can't be changed in any other cycle
        post("/admin/users/%d/plan" % A, action="reopen", plan_year=year)
        s.check("Reopen with no reason changes nothing",
                H.one(a, "SELECT status FROM pm_idp WHERE subject_id=? AND plan_year=?", (A, year)) == "shared")
        post("/admin/users/%d/plan" % A, action="reopen", plan_year=year, reason="ZZPX their goals need a rethink")
        if ctx(lambda d: a.pm_idp_is_authoring(a.active_cycle(d))):
            s.check("with one, Reopen puts a shared plan back to draft, and logs it",
                    H.one(a, "SELECT status FROM pm_idp WHERE subject_id=? AND plan_year=?", (A, year)) == "draft"
                    and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action='reopen_idp_self' AND "
                                 "target_user_id=?", (A,)) == 1)
        else:
            s.check("with one, outside the Year-End it's still refused: the plan can't be changed in this cycle",
                    H.one(a, "SELECT status FROM pm_idp WHERE subject_id=? AND plan_year=?", (A, year)) == "shared")
    code, b = page("plan")
    s.check("the tab shows their path and profile", code == 200 and "Their career path" in b and "Lead a site" in b)

    # -----------------------------------------------------------------------
    s.section("History: the ratings record, every cycle, one opened")
    ctx(lambda d: (d.execute(
        "INSERT INTO rating_records(cycle_id, subject_id, employee_id, full_name, pm_self_band, pm_mgr_band, "
        "pm_hod_band, pm_final_band, pm_final_source, f360_avg, f360_max, f360_submitted, pot_final_band) "
        "VALUES (?,?, 'ZZPX-A', 'ZZ PX Alpha', 'ME', 'AE', 'AE', 'AE', 'hod', 4.1, 5, 6, 'High')", (CID, A)),
        d.commit()))
    code, b = page("history")
    s.check("each cycle they appear in is a row, with the final band and whether it's released",
            code == 200 and CYC["name"] in b and ">AE<" in b and "not yet" in b)
    code, b = page("history", "&rec=%d" % CID)
    s.check("opened, it shows how the band was reached", "Self ME" in b and "LM AE" in b and "HOD AE" in b
            and "Final AE" in b and "4.10 of 5" in b)

    # -----------------------------------------------------------------------
    s.section("scope, and a past cycle")
    oth = H.client_as(a, OTHER_ADM)
    s.check("an admin of another group can't open any tab",
            all(oth.get("/admin/users/%d?tab=%s" % (A, t)).status_code == 403
                for t in ("competency", "f360", "plan", "history")))
    s.check("...nor change their competencies or plan",
            oth.post(COMP, data={"csrf_token": "tok", "action": "reset"}).status_code == 403
            and oth.post("/admin/users/%d/plan" % A, data={"csrf_token": "tok", "action": "reopen",
                                                           "plan_year": year or 2026}).status_code == 403)
    if PAST:
        code, b = page("competency", "&cycle=%d" % PAST)
        s.check("a past cycle's competency tab is read-only", code == 200 and "Add from the library" not in b
                and "Change the match" not in b)
    r = sup.post(COMP, data={"csrf_token": "tok", "action": "promote"})
    s.check("an unknown action is refused", r.status_code == 400)
finally:
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='idp_self'", (CID,))
        for w in _wins:
            db.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w), ",".join("?" * len(w))),
                       list(w.values()))
        db.commit()

sys.exit(s.done())
