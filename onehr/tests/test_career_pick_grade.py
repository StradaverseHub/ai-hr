"""A Career Plan role pick keeps the GRADE picked when a title is offered at two grades (2026-11-05).

The job architecture holds job titles at more than one grade. The direction card's Confirm sends "I'd like to aim for
<title> (JG<n>)"; `_career_tool_set_direction` used to throw the "(JGnn)" away and store the first title match, so a pick of
the higher grade saved the lower profile. Held here:
  * "<title> (JG<higher>)" stores the higher profile and aspiration_mid ends "(JG<higher>)"; "(JG<lower>)" stores the lower
  * the grade is read with any spacing and case
  * a bare title offered at two grades is refused, nothing changes, and the error names the grades
  * a grade not offered at that title is refused; a unique title with no grade still works
  * the real chat route (the card's "I'd like to aim for ..." message) stores the picked profile
  * the model's brief tells it to name a role by its full listed label

Fresh database (fresh_db=True): synthetic ZZTEST people and profiles; the suite's copy is put back at the end.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("A Career Plan role pick keeps the grade picked")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
import ai_draft  # noqa: E402

CHBM = "CHIN HIN BUILDING MATERIAL (CHBM)"
TITLE = "ZZTEST Manager, Executive Support"
UNIQ = "ZZTEST Unique Role, Sales"

_avail0, _agent0 = ai_draft.review_agent_available, ai_draft.review_agent
ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = lambda system, messages, timeout=90: {"say": "(model)", "quick_replies": [], "action": None}
try:
    with a.app.app_context():
        db = a.get_db()
        CID = a.active_cycle_id(db)
        db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','tm','idp','pm')")
        db.execute("UPDATE cycle_modules SET active=0 WHERE module_key='evidence'")
        db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
        db.execute("UPDATE cycles SET kind='year_end', half=2, starts_on=NULL, open_by_date=0 WHERE id=?", (CID,))
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        if not db.execute("SELECT 1 FROM pm_bg_config WHERE business_group=?", (CHBM,)).fetchone():
            db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (CHBM,))

        def prof(title, grade):
            return db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, source, active) VALUES "
                              "('ZZTEST Dept', ?, ?, ?, 1)", (title, str(grade), a._CAREER_DEMO_SOURCE)).lastrowid
        LO, HI, UN = prof(TITLE, 16), prof(TITLE, 17), prof(UNIQ, 16)
        UID = db.execute(
            "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_title, job_grade, confirmation_date, years_of_service) "
            "VALUES ('ZZPICKG','Test Pick Grade','x','user','ZZPICKG',?,'ZZ Co','ZZTEST Dept','Executive','15',"
            "'2020-01-01', 4.0)", (CHBM,)).lastrowid
        db.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) "
                   "VALUES (?,?,'agent','Hello.','account')", (UID, CID))
        db.commit()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (UID,)).fetchone())
        roles = a._career_candidate_roles(db, u)["roles"]
    at = [r for r in roles if r["title"] == TITLE]
    s.check("fixture: the person is offered the title at two adjacent grades, and the unique one",
            sorted(str(r["grade"]) for r in at) == ["16", "17"] and any(r["title"] == UNIQ for r in roles),
            [(r["title"], r["grade"]) for r in roles])

    def pick(choice):
        with a.app.test_request_context("/"):
            db = a.get_db()
            u = dict(db.execute("SELECT * FROM users WHERE id=?", (UID,)).fetchone())
            return a._career_tool_set_direction(db, u, CID, {"choice": choice})

    def state():
        r = H.rows(a, "SELECT target_profile_id t, aspiration_mid m FROM pm_career_profile WHERE subject_id=?", (UID,))
        return (r[0]["t"], r[0]["m"]) if r else (None, None)

    def reset():
        with a.app.app_context():
            a.get_db().execute("DELETE FROM pm_career_profile WHERE subject_id=?", (UID,))
            a.get_db().commit()

    # 1. the grade picked is the grade stored
    r = pick(TITLE + " (JG17)")
    t, m = state()
    s.check("(JG17) stores the JG17 profile and says JG17", r.get("ok") and t == HI and m.endswith("(JG17)"), (r, t, m))
    r = pick(TITLE + " (JG16)")
    t, m = state()
    s.check("(JG16) stores the JG16 profile and says JG16", r.get("ok") and t == LO and m.endswith("(JG16)"), (r, t, m))
    r = pick(TITLE + " (JG17)")
    t, m = state()
    s.check("re-picking JG17 stores JG17 again, not JG16", r.get("ok") and t == HI and m.endswith("(JG17)"), (r, t, m))
    for variant in (TITLE.lower() + " ( jg 16 )", TITLE + " (jg16)"):
        r = pick(variant)
        s.check("the grade is read with any spacing and case: %r" % variant[-12:], r.get("ok") and state()[0] == LO, r)
    reset()

    # 2. refusals change nothing
    pick(TITLE + " (JG17)")
    before = state()
    r = pick(TITLE)
    s.check("a bare title at two grades is refused, naming both, and nothing changes",
            r.get("ok") is False and "JG16" in r["error"] and "JG17" in r["error"] and state() == before, (r, state()))
    r = pick(TITLE + " (JG19)")
    s.check("a grade not offered at that title is refused, nothing changes",
            r.get("ok") is False and "isn't in their career options" in r["error"] and state() == before, (r, state()))
    r = pick("ZZTEST Manager (JG17)")
    s.check("a shorter title (no substring match) is still refused", r.get("ok") is False and state() == before, r)
    reset()

    # 3. a unique title still works, with or without its grade
    r = pick(UNIQ)
    s.check("a unique title with no grade still works", r.get("ok") and state()[0] == UN, (r, state()))
    reset()
    r = pick(UNIQ + " (JG16)")
    s.check("...and with its grade", r.get("ok") and state()[0] == UN, (r, state()))
    reset()

    # 4. the real chat route: the card's Confirm message
    def turn(msg):
        c = H.client_as(a, UID)
        rr = c.post("/review/chat?journey=1", data={"csrf_token": "tok", "message": msg, "stage": "career_plan",
                                                    "journey": "1"})
        return (rr.get_json() or {}) if rr.status_code == 200 else {"_status": rr.status_code}
    j = turn("I'd like to aim for %s (JG17)" % TITLE)
    t, m = state()
    s.check("the chat route: the JG17 card pick stores the JG17 profile", j.get("aim_saved") is True and t == HI
            and m.endswith("(JG17)") and "(JG17)" in (j.get("say") or ""), (j.get("aim_saved"), t, m, j.get("_status")))
    j = turn("I'd like to aim for %s (JG16)" % TITLE)
    s.check("...and the JG16 card pick then stores JG16", j.get("aim_saved") is True and state()[0] == LO, state())
    reset()
    j = turn("I'd like to aim for %s" % TITLE)
    s.check("the chat route: a bare title at two grades is not saved (no aim_saved)",
            not j.get("aim_saved") and state() == (None, None), (j.get("aim_saved"), state()))

    # 5. the model is told to use the full label
    with a.app.app_context():
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (UID,)).fetchone())
        src = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
    s.check("the Career Plan brief tells the model to name a role by its full listed label with (JGnn)",
            "A title can be offered at more than one grade: always name a role by its full listed " in src
            and 'label, with its (JGnn)."' in src)
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _avail0, _agent0

sys.exit(s.done())
