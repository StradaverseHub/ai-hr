"""The job profile panel, a person's Career routes and the Job card's service (Chris, 2026-10-19; canvas
[design canvas link removed]).

Competency > Run > Assign competencies: a hand-made profile's panel finds a competency, counts what its picks come to
out of ten (each pick its level now plus the level above, tc_pick_plan_size, as tc_profile_plan derives it), tags each
pick Current and the level above Future, and set_skills refuses more than ten. A job-architecture profile's panel reads
its five, each current level with its future, and links to the library where they change. A person's Career Plan tab
opens their job's routes in place (?routes=1), read there. The person page's Job card shows years of service and the
confirmation date. Everything here is synthetic (ZZAS*) and removed at the end.
"""
import html
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Assign competencies panel, a person's Career routes, the Job card's service")


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZAS-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    pids = [r[0] for r in db.execute("SELECT id FROM tc_job_profiles WHERE job_title LIKE 'ZZAS%'")]
    if pids:
        ph = ",".join("?" * len(pids))
        db.execute("DELETE FROM tc_career_routes WHERE from_profile_id IN (%s) OR to_profile_id IN (%s)" % (ph, ph),
                   pids + pids)
        db.execute("DELETE FROM tc_job_profile_skills WHERE profile_id IN (%s)" % ph, pids)
        db.execute("DELETE FROM tc_job_profiles WHERE id IN (%s)" % ph, pids)
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZAS-%'")
    db.execute("DELETE FROM activity_log WHERE detail LIKE 'ZZAS%'")
    db.commit()


SU = H.actors(a)[0]
SUP = SU["id"]
with a.app.test_request_context("/"):
    db = a.get_db()
    _cleanup(db)

    def skill(title, level, cat):
        code = "ZZAS-%s-%d" % (title.split()[-1][:3].upper(), level)
        db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, active) "
                   "VALUES (?,?,?,?,?,1)", (code, title, level, "tsc", cat))
        return db.execute("SELECT id FROM tc_skills WHERE skill_code=?", (code,)).fetchone()[0]
    SK = {}
    for t in ("Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"):
        for lv in (3, 4, 5):
            SK[(t, lv)] = skill("ZZAS " + t, lv, "ZZAS Cat One" if t < "D" else "ZZAS Cat Two")
    SK[("Golf", 6)] = skill("ZZAS Golf", 6, "ZZAS Cat Two")       # a ceiling: no level above

    def profile(title, grade, job_code=None, plan_mode=None, lvl=4):
        db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, proficiency_level, job_code, "
                   "plan_mode, source, active) VALUES (?,?,?,?,?,?,?,1)",
                   ("ZZAS Dept", title, grade, lvl, job_code, plan_mode, "test"))
        return db.execute("SELECT id FROM tc_job_profiles WHERE department='ZZAS Dept' AND job_title=? AND job_grade=?",
                          (title, grade)).fetchone()[0]
    MAN = profile("ZZAS Manual Role", "15")
    SEN = profile("ZZAS Senior Role", "16")
    HID = profile("ZZAS Hidden Role", "16")
    OVER = profile("ZZAS Overfull Role", "15")
    ARCH = profile("ZZAS Arch Role", "15", job_code="ZZAS-UNIT-A-15", plan_mode="explicit", lvl=None)
    # the architecture profile: Alpha 3 and Bravo 3 now, their 4s next, and Echo 4 a next-role competency (no pair)
    for i, (k, fut) in enumerate(((("Alpha", 3), 0), (("Bravo", 3), 0), (("Alpha", 4), 1), (("Bravo", 4), 1),
                                  (("Echo", 4), 1))):
        db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, sort_order, is_future) VALUES (?,?,?,?)",
                   (ARCH, SK[k], i, fut))
    # a profile set up before the limit, with 6 picks that come to 12
    for i, t in enumerate(("Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot")):
        db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, sort_order) VALUES (?,?,?)",
                   (OVER, SK[(t, 3)], i))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1")
                .fetchone())
    cols = [c for c in base.keys() if c != "id"]
    v = dict(base, username="zzas-1", employee_id="ZZAS-1", full_name="ZZ AS One", email=None, job_grade="15",
             job_title="ZZAS Manual Role", department="ZZAS Dept", left_at=None, is_demo=0, role="user",
             manager_id=None, hod_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, admin_bg=None,
             joined_date=None, confirmation_date=None, years_of_service=None)
    db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
    U = db.execute("SELECT id FROM users WHERE employee_id='ZZAS-1'").fetchone()[0]
    db.commit()


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def post_skills(pid, picks):
    return sup.post("/admin/competency/profiles", data={"csrf_token": "tok", "action": "set_skills", "profile_id": pid,
                                                        "skill": [SK[k] for k in picks]}, follow_redirects=True)


def text(r):
    return html.unescape(r.get_data(as_text=True))


def n_rows(pid):
    return H.one(a, "SELECT COUNT(*) FROM tc_job_profile_skills WHERE profile_id=?", (pid,))


sup = H.client_as(a, SUP)
try:
    s.section("What a set of picks comes to (each pick its level now, plus the level above)")
    size = lambda ks: ctx(lambda d: a.tc_pick_plan_size(d, [SK[k] for k in ks]))  # noqa: E731
    s.check("one pick with a level above: 1 current, 1 future", size([("Alpha", 3)]) == (1, 1), size([("Alpha", 3)]))
    s.check("two levels of one competency: both current, only the higher one's next is future",
            size([("Alpha", 3), ("Alpha", 4)]) == (2, 1), size([("Alpha", 3), ("Alpha", 4)]))
    s.check("a top-level pick has no future", size([("Golf", 6)]) == (1, 0), size([("Golf", 6)]))
    s.check("the same pick twice counts once", size([("Bravo", 3), ("Bravo", 3)]) == (1, 1))
    s.check("the limit is the architecture's five, twice", a.TC_PROFILE_MAX == 10)

    s.section("Save refuses more than ten")
    six = [(t, 3) for t in ("Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot")]
    r = post_skills(MAN, six)
    s.check("six picks (12) are refused, saying how many to untick, and nothing is saved",
            "at most 10" in text(r) and "untick 2" in text(r) and n_rows(MAN) == 0, n_rows(MAN))
    r = post_skills(MAN, six[:5])
    s.check("five picks (10) are saved, the flash counting them out of ten",
            "Saved 10 of 10 competencies" in text(r) and n_rows(MAN) == 5
            and len(ctx(lambda d: a.tc_profile_plan(d, MAN))) == 10, n_rows(MAN))
    r = post_skills(MAN, six[:5] + [("Golf", 6)])
    s.check("a sixth pick at the top level makes 11: refused, the five kept", "at most 10" in text(r)
            and n_rows(MAN) == 5)
    r = post_skills(MAN, six[:4] + [("Golf", 6)])
    s.check("four picks and a top-level one (9) are saved", "Saved 9 of 10" in text(r) and n_rows(MAN) == 5)
    s.check("...and logged with the split", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE detail LIKE "
                                                     "'ZZAS Manual Role: 9 competencies (5 current, 4 future)'") == 1)

    s.section("A hand-made profile's panel")
    b = text(sup.get("/admin/competency/profiles?profile=%d" % MAN))
    s.check("Find a competency, the count out of ten, the All / Selected switch",
            'data-pf-q' in b and 'data-pf-max="10"' in b and "9 of 10 competencies" in b
            and "5 current · 4 future" in b and 'data-pf-show="sel"' in b, "")
    s.check("each competency carries its title and level for the count", 'data-key="ZZAS Alpha" data-lv="3"' in b)
    s.check("a pick is tagged Current from the start; an unpicked one isn't",
            'value="%d" checked>' % SK[("Alpha", 3)] in b
            and b.count('<span class="pf-tag is-cur">Current</span>') == 5, b.count('pf-tag is-cur">Current'))
    s.check("the search box is not a form field (it never posts)", 'name="q"' not in b.split('id="prof-skills"')[1]
            .split("</form>")[0])
    s.check("Save is on, and the panel says at most ten", "At most 10: each pick is its level now plus the level "
            "above." in b and 'class="primary">Save competencies' in b)
    s.check("the script switches the footer's Save, never the Deactivate / Remove buttons in the same form",
            "form.querySelector('.adm-panel-foot button[type=\"submit\"]')" in b
            and "form.querySelector('button[type=\"submit\"]')" not in b)
    b = text(sup.get("/admin/competency/profiles?profile=%d" % OVER))
    s.check("a profile already over ten: 12 of 10, untick 2, Save off",
            "12 of 10 competencies" in b and "Untick 2 before you save" in b
            and 'class="primary" disabled>Save competencies' in b, "")

    s.section("A job-architecture profile's panel")
    b = text(sup.get("/admin/competency/profiles?profile=%d" % ARCH))
    body = b.split('id="pnl-prof-%d"' % ARCH)[1].split("</aside>")[0]
    s.check("its competencies as people get them: each current level with its future, a next-role one on its own",
            "5 of 10 competencies" in body and "2 current · 3 future" in body and body.count('class="pf-prow"') == 3
            and "ZZAS Echo" in body, "")
    s.check("nothing to tick, and Change its five opens the library's editor",
            'name="skill"' not in body and "Change its five in the Competency library" in body
            and "/admin/competency/library?" in body and "job=%d" % ARCH in body and "panel=five" in body, "")
    s.check("its header says where it comes from, not 'level —'", "ZZAS-UNIT-A-15 · from the job architecture" in b
            and "level —" not in body.split("adm-panel-sub")[1][:200])
    s.check("Status and Remove stay", 'form="prof-toggle"' in body and 'form="prof-remove"' in body)

    s.section("A person's Career routes, in their Career Plan tab")
    ctx(lambda d: (d.execute("DELETE FROM tc_job_profile_skills WHERE profile_id IN (?,?)", (SEN, HID)),
                   [d.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, sort_order) VALUES (?,?,?)",
                              (pid, SK[(t, 3)], i)) for pid in (SEN, HID)
                    for i, t in enumerate(("Alpha", "Bravo", "Charlie", "Delta"))],
                   d.execute("INSERT INTO tc_career_routes(from_profile_id, to_profile_id, kind, created_by) "
                             "VALUES (?,?,'hidden',?)", (MAN, HID, SUP)), d.commit()))
    b = text(sup.get("/admin/users/%d?tab=plan&fragment=1" % U))
    s.check("the path card's Career routes opens the same tab with ?routes=1 (so it reloads in a list's panel)",
            "/admin/users/%d?tab=plan&routes=1" % U in b and "Career routes ›" in b, "")
    b = text(sup.get("/admin/users/%d?tab=plan&routes=1&fragment=1" % U))
    s.check("?routes=1: the moves their job offers, with the way back", "Career routes from their job" in b
            and "ZZAS Manual Role · JG 15" in b and "Back to their Career Plan" in b
            and "/admin/users/%d?tab=plan" % U in b, "")
    s.check("...a route offered from their job, and the one Group People hid", "ZZAS Senior Role" in b and "Hidden by Group People" in b
            and "ZZAS Hidden Role" in b, "")
    s.check("...read here: no Pin or Hide form, and the career tree linked for those",
            "kind" not in b.split('id="pp-routes"')[1] and "Open in the career tree" in b, "")
    s.check("...in place of the tab's other sections", "Their role choice and career profile" not in b)
    s.check("the career tree's own Routes panel still lists its routes",
            sup.get("/admin/career-routes").status_code == 200)

    s.section("The Job card: years of service and the confirmation date")
    today = ctx(lambda d: a._today_myt())
    three = today.replace(year=today.year - 3, day=min(today.day, 28))
    sv = lambda **k: ctx(lambda d: a.person_service(dict({"joined_date": None, "confirmation_date": None,  # noqa: E731
                                                          "years_of_service": None}, **k)))
    r1 = sv(joined_date=three.isoformat(), confirmation_date="2020-02-03")
    s.check("joined three years ago: '3 years', the day, and the confirmation day",
            r1["length"].startswith("3 years") and r1["joined"] and r1["confirmed"] == "3 Feb 2020", r1)
    r2 = sv(joined_date=date(today.year + 1, 1, 15).isoformat())
    s.check("joining later: upcoming, no length", r2["upcoming"] and not r2["length"], r2)
    r3 = sv(years_of_service=6.4)
    s.check("no joining date: the roster's years, and over a year counts as confirmed",
            r3["length"] == "About 6 years" and r3["counted"] and not r3["confirmed"], r3)
    r4 = sv(joined_date=today.isoformat())
    s.check("joined today: 'Under a month', not confirmed", r4["length"] == "Under a month" and not r4["counted"], r4)
    ctx(lambda d: (d.execute("UPDATE users SET joined_date=?, confirmation_date='2020-02-03' WHERE id=?",
                             (three.isoformat(), U)), d.commit()))
    b = text(sup.get("/admin/users/%d" % U))
    s.check("the person page's Job card shows both", "Years of service" in b and "Confirmation date" in b
            and "3 Feb 2020" in b and "Joined " in b, "")
    s.check("every template still compiles", H.every_template_compiles(a))
finally:
    with a.app.test_request_context("/"):
        _cleanup(a.get_db())
s.done()
