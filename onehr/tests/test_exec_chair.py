"""The Executive Chairman view, piece P1: the seat and his team (Chris, 2026-10-29: "Approve all picks"; plan: OneHR/Executive
Chairman view/Build plan (staging) v1.md; board 3, Admin > Leaders > Executive Chairman).

One person holds the seat (a setting, not a user role) and keeps rating his reports in the 360; the abilities that make him
their line manager in the review (moderate their KPI results, assess on their behalf, review their competency, close their
Career Plan) are off for him by default and nobody does them for him (the delegate no longer stands in: Chris, 2026-11-03 for
KPI moderation, 2026-11-06 for competency, Career Plan and assessing on their behalf). Dark behind ONEHR_CHAIR=1.

What this suite holds:
  * flag off: every chair endpoint is 404 (signed-out still goes to sign in), nobody is the chair whatever is stored, no
    leader_can / review list / default moderator changes, and Admin > Leaders is the same page it was
  * flag on: only the super admin reaches the tab and saves (BG admin, unit admin, staff and signed-out refused), every POST
    needs its CSRF token and a known action, the seat and the delegate are picked from the list (typed text, an admin, a
    leaver, the chair as his own delegate and the delegate as chair all refused), a partial post changes nothing it didn't
    carry, each change is one audit row and a repeat is none
  * the chair's team abilities are off (leader_can, the shared writers, his review lists, Team tab and nav); with a tick on
    he can again (falsified one by one); everyone else's abilities are untouched
  * the delegate reviews the competency and Career Plan of nobody's reports but their own manager role's (the chair's reports
    are reviewed by no one while his ticks are off: Chris, 2026-11-06; the rule's own suite is test_chair_norev.py); nobody
    moderates the chair's reports' KPI lines while his Moderate tick is off, the delegate's own lines included (Chris, 2026-11-03;
    the rule's own suite is test_chair_nomod.py)
  * the chair still rates his reports in the 360, and stays their line manager; no row is changed by any of it
Synthetic ZZ9EC people only, cloned from one real row's shape; a fresh_db suite, so Suite.done() puts the scratch copy back."""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Executive Chairman, P1: the seat and his team abilities (the stored delegate stays, nothing sets it)")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
os.environ.pop("ONEHR_CHAIR", None)
SU, _BGA0, _E = H.actors(a)
SRC = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
ABILITIES = ("lm.moderate", "mx.moderate", "lm.behalf", "mx.behalf", "lm.competency", "lm.see_360", "lm.plan")
TICK_OF = {"lm.moderate": "moderate", "mx.moderate": "moderate", "lm.behalf": "behalf", "mx.behalf": "behalf",
           "lm.competency": "competency", "lm.see_360": "competency", "lm.plan": "plan"}


def run(fn, path="/"):
    """fn(db) in a request of its own (each request has its own per-request caches)."""
    with a.app.test_request_context(path):
        return fn(a.get_db())


def put(key, val):
    def f(d):
        if val is None:
            d.execute("DELETE FROM app_settings WHERE key=?", (key,))
        else:
            d.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (key, str(val)))
        d.commit()
    run(f)


def raw(key):
    r = H.rows(a, "SELECT value FROM app_settings WHERE key=?", (key,))
    return r[0][0] if r else None


def seat(chair, deleg, ticks=()):
    put("exec_chair_id", chair)
    put("exec_chair_delegate_id", deleg)
    put("exec_chair_team", json.dumps({k: (k in ticks) for k in ("moderate", "behalf", "competency", "plan")}))


def n_log(action):
    return H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action=?", (action,))


# ---------------------------------------------------------------------------------------------------------- the people
with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PERIOD = dict(a.active_pm_period(db))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 AND "
                           "business_group IN (SELECT business_group FROM pm_bg_config WHERE mechanism='A') LIMIT 1").fetchone())
    cols = [c for c in base if c != "id"]
    ids = {}

    def mk(tag, mgr=None, left=False):
        eid = "ZZ9EC-" + tag
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ EC " + tag, display_name=None, email=None,
                 hod_id=None, manager_id=ids.get(mgr), buceo_bg=None, buceo_company=None, bgceo_bg=None,
                 confirmation_date="2020-01-01", left_at=("2026-01-01" if left else None), role="user", is_demo=0,
                 user_role_id=None, job_grade="14")
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v.get(c) for c in cols])
        ids[tag] = db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
    mk("CH")                       # the Executive Chairman
    mk("DL", "CH")                 # the delegate: a report of the chair, as X0007 is of X0003
    mk("R1", "CH")                 # the chair's reports
    mk("R2", "CH")
    mk("LM")                       # another line manager
    mk("OR", "LM")                 # and a report of theirs
    mk("LV", left=True)            # a leaver
    CH, DL, R1, R2, LMX, OR, LV = (ids[k] for k in ("CH", "DL", "R1", "R2", "LM", "OR", "LV"))
    # a BG admin and a unit admin, and a plain employee (OR) to be refused
    BGN = base["business_group"]
    for tag, comp in (("BGA", None), ("UNA", base["company"])):
        db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, admin_bg) "
                   "VALUES (?, ?, 'x', 'admin', ?, ?, ?)", ("zz9ec-" + tag.lower(), "ZZ EC " + tag, "ZZ9EC-" + tag, BGN, BGN))
        ids[tag] = db.execute("SELECT id FROM users WHERE employee_id=?", ("ZZ9EC-" + tag,)).fetchone()[0]
        if comp:
            db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?, ?)", (ids[tag], comp))
    BGA, UNA = ids["BGA"], ids["UNA"]
    # competencies and Career Plans to review: the chair's two reports, the delegate's own (he is a report of the chair),
    # and the other manager's report
    skills = [r[0] for r in db.execute("SELECT id FROM tc_skills ORDER BY id LIMIT 2")]
    for who in (R1, R2, DL, OR):
        for sk in skills:
            db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) VALUES (?,?,?)", (CID, who, sk))
        db.execute("INSERT OR REPLACE INTO tc_assessments(cycle_id, subject_id, status, submitted_at) "
                   "VALUES (?,?,'submitted', datetime('now'))", (CID, who))
    YR = a.pm_idp_plan_year(PERIOD)
    for who in (R1, DL, OR):
        db.execute("DELETE FROM pm_idp WHERE plan_year=? AND subject_id=?", (YR, who))
        db.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status, shared_at) VALUES (?,?,?,'shared',"
                   "datetime('now'))", (YR, PERIOD["id"], who))
    # one KPI line the chair already moderates (R2: an existing line, never re-pointed by code), one for the delegate to
    # moderate (R1: routed by the default moderator, below)
    def line(subject, name):
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company, "
                   "unit, rate1, rate2, rate3, rate4, rate5, status) VALUES (?,?,?,100,'more',?,?,'RM (mil)',1,2,3,4,5,'approved')",
                   (PERIOD["id"], subject, name, base["business_group"], base["company"]))
        return db.execute("SELECT last_insert_rowid()").fetchone()[0]
    LINE_R2 = line(R2, "ZZ EC line for R2")
    a._pm_set_moderator(db, LINE_R2, [CH])
    LINE_R1 = line(R1, "ZZ EC line for R1")
    # a 360 assignment: the chair rates R1 as their line manager
    db.execute("INSERT OR REPLACE INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) "
               "VALUES (?,?,?,'line_manager','pending')", (CID, R1, CH))
    db.commit()
    EID = {k: "ZZ9EC-" + k for k in ids}


def u(uid):
    return run(lambda d: d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


CHR, DLR, R1R, R2R, LMR, ORR = (u(x) for x in (CH, DL, R1, R2, LMX, OR))
SUP, BGC, UNC, STC = (H.client_as(a, x) for x in (SU["id"], BGA, UNA, OR))
SIGNED_OUT = a.app.test_client()
# deterministic windows: the suite asks who may act, never whether a date has come
_real_window, _real_open = a.window_closed, a.cycle_is_open
a.window_closed = lambda *x, **k: None
a.cycle_is_open = lambda *x, **k: True
BEFORE = {}


def post(c, **form):
    form.setdefault("csrf_token", "tok")
    return c.post("/admin/leaders/chair", data=form, follow_redirects=True)


def save(**form):
    form.setdefault("action", "save")
    return post(SUP, **form)


def words(r):
    t = r.get_data(as_text=True)
    return " ".join(re.findall(r'class="flash[^"]*"[^>]*>(.*?)<', t, re.S))


try:
    BEFORE["manager"] = {k: u(v)["manager_id"] for k, v in (("R1", R1), ("R2", R2), ("DL", DL))}
    BEFORE["assign"] = H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=?", (CID,))
    BEFORE["lines"] = H.rows(a, "SELECT id, approver_id FROM pm_kpi_target_approvers ORDER BY id")
    # the seat is stored but the flag is off
    seat(CH, DL, ticks=())
    LEAD = "/admin/leaders?tab=bgceo"
    LINK = '<a role="tab" aria-selected="false" href="/admin/leaders/chair">Executive Chairman</a>'

    # ----------------------------------------------------------------------------------------------------- flag off
    s.section("flag off: every chair endpoint is 404 and nothing changes")
    s.check("chair_on() is False without ONEHR_CHAIR", a.chair_on() is False)
    s.check("the chair endpoints are registered (so the gate has something to hold)",
            "admin_leaders_chair" in a.app.view_functions and a.CHAIR_ENDPOINTS <= set(a.app.view_functions))
    r = SUP.get("/admin/leaders/chair")
    s.check("the super admin's GET is 404", r.status_code == 404, r.status_code)
    r = SUP.post("/admin/leaders/chair", data={"csrf_token": "tok", "action": "save", "chair": EID["R1"]})
    s.check("...and so is a POST, which saves nothing", r.status_code == 404 and raw("exec_chair_id") == str(CH),
            (r.status_code, raw("exec_chair_id")))
    s.check("...a BG admin's and a plain employee's too", BGC.get("/admin/leaders/chair").status_code == 404
            and STC.get("/admin/leaders/chair").status_code == 404)
    r = SIGNED_OUT.get("/admin/leaders/chair")
    s.check("signed out still goes to sign in (a 404 there would fail the deploy's route probe)",
            r.status_code == 302 and "/login" in r.headers.get("Location", ""), (r.status_code, r.headers.get("Location")))
    s.check("nobody is the chair, whatever is stored", run(lambda d: a.chair_user_id(d)) is None
            and not run(lambda d: a.is_chair(CHR)) and run(lambda d: a.chair_delegate_id(d)) is None)
    s.check("...no leader ability changes, for him or anyone",
            all(run(lambda d, ab=ab: a.leader_can(CHR, ab, d)) and run(lambda d, ab=ab: a.leader_can(DLR, ab, d))
                for ab in ABILITIES)
            and all(run(lambda d, ab=ab: a.leader_ability_off(d, CHR, ab)) is None for ab in ABILITIES))
    s.check("...his review lists are his own, the delegate's his own",
            run(lambda d: a._cycle_review_managers(d, CH, "competency")) == [CH]
            and run(lambda d: a._cycle_review_managers(d, CH, "plan")) == [CH]
            and run(lambda d: a._cycle_review_managers(d, DL, "competency")) == [DL]
            and {r["id"] for r in run(lambda d: a._tc_reports_for(d, CH, CID))} == {R1, R2, DL}
            and {r["id"] for r in run(lambda d: a._tc_reports_for(d, DL, CID))} == set())
    s.check("...his Career Plan reviews, Team flags and approver list are today's",
            run(lambda d: a._idp_is_reviewer_of(d, CHR, R1, PERIOD["id"])) and run(lambda d: a._idp_lm_has_plans(d, CHR))
            and run(lambda d: a._hub_tc_flags(d, CHR, CID))[1] and R2 in run(
                lambda d: a._pm_approver_subject_ids(d, CHR, PERIOD["id"]))
            and run(lambda d: a._pm_manages_anyone(d, CHR)) and run(lambda d: a._review_manages_team(d, CHR)))
    s.check("...a new line's default moderator is the line manager",
            run(lambda d: a.pm_setting_resolve_approvers(d, R1R)) == [CH]
            and run(lambda d: a._pm_kpi_moderator(d, R1R, "", "ZZ"))[0]["approver_ids"] == [CH]
            and run(lambda d: a._pm_default_moderator_id(d, R1, CH)) == CH
            and run(lambda d: a._pm_mod_ability(d, DLR, R1)) == "mx.moderate")
    off_html = SUP.get(LEAD).get_data(as_text=True)
    s.check("Admin > Leaders has no Executive Chairman tab and no word of it", "Executive Chairman" not in off_html
            and "/admin/leaders/chair" not in off_html and "ec-" not in off_html.split("</head>")[-1])
    s.check("the tab strip is the three it was", off_html.count('role="tab"') == 3, off_html.count('role="tab"'))

    # ------------------------------------------------------------------------------------------------------ flag on
    os.environ["ONEHR_CHAIR"] = "1"
    s.section("flag on: only the super admin reaches the tab")
    on_html = SUP.get(LEAD).get_data(as_text=True)
    s.check("the Leaders page gains the one tab link and nothing else (the page, minus the link, is byte for byte "
            "what it was with the flag off)", LINK in on_html and on_html.replace(LINK, "") == off_html,
            (LINK in on_html, len(on_html), len(off_html)))
    s.check("a BG admin's Leaders page has no such tab", "Executive Chairman" not in BGC.get(LEAD).get_data(as_text=True))
    r = SUP.get("/admin/leaders/chair")
    pg = r.get_data(as_text=True)
    s.check("the super admin opens it, with the confirm on the form and the CSRF token in it", r.status_code == 200
            and "Executive Chairman" in pg and 'data-confirm="' in pg and 'name="csrf_token"' in pg
            and 'data-confirm-ok="' in pg, r.status_code)
    s.check("the people are PICKED (strict picker, hidden Employee ID), never a typed Employee ID box",
            pg.count("data-pick") >= 2 and pg.count('class="pick-val"') == 2 and 'name="chair"' in pg
            and 'name="delegate"' not in pg and not re.search(r'<input[^>]*name="(chair|delegate|leader)"[^>]*type="text"', pg))
    # the second picker is "Add a leader" on his leaders' Talent Box card (2026-10-30; tests/test_exec_chair_members.py)
    s.check("the wording is the board's: the seat, 'Their own review', fixed step 1, the five abilities",
            all(x in pg for x in ("The seat", "Their own review", "Once results are released to leaders (step 1)",
                                  "Rate them in the 360", "Moderate their KPI results", "Assess on their behalf",
                                  "Review their competency", "Review and close their Career Plan")))
    s.check("...Rate them in the 360 is on and fixed (disabled, not posted)", re.search(
        r'<input type="checkbox" checked disabled>\s*<span>Rate them in the 360', pg) is not None)
    # 2026-11-03: the Moderate tick's note says where their bands are set ("he sets their bands in his Talent Box"): a sentence about
    # WHO decides, not a band, a result or a remark of anyone's. That one sentence is read out before the check; any other mention fails.
    _page = pg.split("When they see")[0].replace("he sets their bands in his Talent Box", "").replace(
        "he sets the bands in his Talent Box", "")
    s.check("...and the page names no result, band or remark", not re.search(r"band|remark|result of", _page))
    s.check("a BG admin, a unit admin and a plain employee are refused (403)", BGC.get("/admin/leaders/chair").status_code == 403
            and UNC.get("/admin/leaders/chair").status_code == 403 and STC.get("/admin/leaders/chair").status_code == 403)
    s.check("...and signed out goes to sign in", SIGNED_OUT.get("/admin/leaders/chair").status_code == 302)
    s.check("...nor can they save (403), and nothing is saved", all(
        post(c, action="save", chair=EID["R2"]).status_code == 403 for c in (BGC, UNC, STC)) and raw("exec_chair_id") == str(CH))
    s.check("a POST with no CSRF token is refused (400)", SUP.post("/admin/leaders/chair", data={
        "action": "save", "chair": EID["R2"]}).status_code == 400 and raw("exec_chair_id") == str(CH))
    s.check("the route is the super admin's in the access map, a super-only row on Roles & access, and takes the "
            "system-admin guard", a.ADMIN_ACCESS_MAP.get("admin_leaders_chair") == "super"
            and any("Executive Chairman" in x for x in a.ADMIN_SUPER_ROWS["leaders"])
            and "_system_admin_locked(me, chair_row, db)" in SRC.split("def _chair_save(")[1].split("def _chair_page(")[0]
            and a.action_label("exec_chair_set") == "Set the Executive Chairman"
            and a.action_label("exec_chair_delegate_set").startswith("Set the Executive Chairman")
            and a.action_label("exec_chair_team") == "Change the Executive Chairman's team abilities")

    s.section("saving the seat and the ticks (a delegate stored before stays as it is)")
    seat(None, DL)   # the delegate is stored (as X0007 is on production); the page has no way to set it
    put("exec_chair_team", None)
    s.check("nobody holds the seat until the super admin sets it", run(lambda d: a.chair_user_id(d)) is None
            and not run(lambda d: a.is_chair(CHR)) and all(run(lambda d, ab=ab: a.leader_can(CHR, ab, d)) for ab in ABILITIES))
    n0 = n_log("exec_chair_set")
    r = save(chair=EID["CH"], team_posted="1")
    s.check("saving the seat leaves the stored delegate as it was", raw("exec_chair_id") == str(CH) and raw("exec_chair_delegate_id") == str(DL)
            and "Saved" in words(r), (raw("exec_chair_id"), words(r)))
    s.check("...he is the chair (a row or a bare id), the delegate is not, and the stored delegate still reads as the delegate",
            run(lambda d: a.chair_user_id(d)) == CH and run(lambda d: a.is_chair(CHR))
            and run(lambda d: a.is_chair({"id": CH})) and not run(lambda d: a.is_chair(DLR))
            and not run(lambda d: a.is_chair(None)) and run(lambda d: a.chair_delegate_id(d)) == DL)
    s.check("...each change is one audit row, by the super admin, on the person",
            n_log("exec_chair_set") == n0 + 1 and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action IN "
                                                           "('exec_chair_set') AND user_id=? "
                                                           "AND target_user_id=?", (SU["id"], CH)) == 1
            and n_log("exec_chair_delegate_set") == 0)
    s.check("...with no ticks yet posted changed, no ability row is written (all off is the default)",
            raw("exec_chair_team") is None and n_log("exec_chair_team") == 0)
    n1 = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action LIKE 'exec_chair%'")
    r = save(chair=EID["CH"], team_posted="1")
    s.check("saving the same again says so and logs nothing", "Nothing changed" in words(r)
            and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action LIKE 'exec_chair%'") == n1, words(r))
    pg = SUP.get("/admin/leaders/chair").get_data(as_text=True)
    s.check("the page shows who holds it and their user role, read only (the 360-only role is Roles & access's, no code)",
            EID["CH"] in pg and "User role:" in pg and "Change on Roles &amp; access" in pg and 'name="user_role' not in pg)

    s.section("refused: only a listed person")
    def unchanged():
        return raw("exec_chair_id") == str(CH) and raw("exec_chair_delegate_id") == str(DL)
    for label, form in (("typed text, not a pick", {"chair": "ZZ EC R1"}),
                        ("an unknown Employee ID", {"chair": "ZZ9EC-NOBODY"}),
                        ("an admin account as the chair", {"chair": EID["BGA"]}),
                        ("a leaver as the chair", {"chair": EID["LV"]}),
                        ("a tick that is not on the list", {"team_posted": "1", "team": ["moderate", "rate"]}),
                        ("ticks without the posted marker", {"team": ["moderate"]})):
        r = save(**form)
        s.check("%s: refused, with a sentence, nothing saved" % label, words(r).strip() and "Saved" not in words(r)
                and unchanged() and raw("exec_chair_team") is None, (words(r), raw("exec_chair_id")))
    s.check("...the leaver's sentence says who has left, never a bare error", "has left" in words(save(chair=EID["LV"])))
    r = post(SUP, chair=EID["R1"])
    s.check("a post with no action is not a save", "Nothing to save" in words(r) and unchanged())
    r = save(chair=EID["CH"], team_posted="1")
    s.check("...a field the post doesn't carry stays as it is (absent is not empty): the seat is still his",
            raw("exec_chair_id") == str(CH) and "Nothing changed" in words(r))

    s.section("no delegate picker (Chris, 2026-11-06): the page has none, a crafted post cannot set it, the guard still reads it")
    pg = SUP.get("/admin/leaders/chair").get_data(as_text=True)
    s.check("the page has no delegate field and no delegate words", 'name="delegate"' not in pg and "His delegate" not in pg
            and "ec-del-l" not in pg and "delegate" not in pg.lower(), re.findall(r"[^.]{0,40}delegate[^.]{0,40}", pg, re.I)[:2])
    for label, form in (("another person's Employee ID", {"delegate": EID["R2"]}),
                        ("the same Employee ID", {"delegate": EID["DL"]}),
                        ("an empty value", {"delegate": ""}),
                        ("a crafted post that also posts the ticks (unchanged)", {"delegate": EID["R2"], "team_posted": "1"}),
                        ("a crafted post that also names the seat", {"delegate": EID["R2"], "chair": EID["CH"], "team_posted": "1"})):
        r = save(**form)
        s.check("a post with delegate = %s leaves the stored delegate exactly as it was, no delegate audit row" % label,
                raw("exec_chair_delegate_id") == str(DL) and n_log("exec_chair_delegate_set") == 0, (raw("exec_chair_delegate_id"), words(r)))
    n_all = H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action LIKE 'exec_chair%'")
    s.check("...a delegate-only post says nothing changed and logs nothing at all", "Nothing changed" in words(save(delegate=EID["R2"]))
            and H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action LIKE 'exec_chair%'") == n_all)
    # FALSIFY: the check above can fail. If a post DID set it, the stored value would differ; show the comparison catches it
    put("exec_chair_delegate_id", R2)
    s.check("FALSIFY: had the stored delegate changed, the comparison used above would not hold", raw("exec_chair_delegate_id") != str(DL))
    put("exec_chair_delegate_id", DL)
    s.check("...and the audit label for the old rows stays", a.action_label("exec_chair_delegate_set") == "Set the Executive Chairman's delegate")
    s.check("the guard still refuses the stored delegate on a chair report's KPI line, with the sentence",
            run(lambda d: a._pm_mod_refusal(d, DLR, R1)) == a._PM_CHAIR_UNMOD_WHY and bool(a._PM_CHAIR_UNMOD_WHY)
            and run(lambda d: a._pm_chair_delegate_barred(d, CH, DL)) is True)
    s.check("...and not another manager, nor the delegate on someone else's report (the guard is not wider)",
            run(lambda d: a._pm_mod_refusal(d, LMR, R1)) is None and run(lambda d: a._pm_mod_refusal(d, DLR, OR)) is None)
    put("exec_chair_delegate_id", None)
    s.check("FALSIFY: with nothing stored the same call refuses nobody", run(lambda d: a._pm_mod_refusal(d, DLR, R1)) is None)
    put("exec_chair_delegate_id", DL)

    s.section("the ticks: saved, shown, audited")
    r = save(team_posted="1", team=["moderate", "plan"])
    st = run(lambda d: a._chair_state(d))
    s.check("two abilities kept: stored, read back, one audit row", st["ticks"] == {
        "moderate": True, "behalf": False, "competency": False, "plan": True} and n_log("exec_chair_team") == 1
            and "his team abilities" in words(r), (st["ticks"], words(r)))
    pg = SUP.get("/admin/leaders/chair").get_data(as_text=True)
    s.check("...and the page shows exactly those ticked", len(re.findall(r'name="team" value="(moderate|plan)" checked', pg)) == 2
            and not re.search(r'name="team" value="(behalf|competency)" checked', pg))
    r = save(team_posted="1")
    s.check("posting the marker with none ticked turns them all off", run(lambda d: a._chair_state(d))["ticks"] == {
        k: False for k in ("moderate", "behalf", "competency", "plan")} and n_log("exec_chair_team") == 2)

    # ------------------------------------------------------------------------------------------------ the chair's team
    s.section("the chair's team abilities are off (default), and only his")
    seat(CH, DL, ticks=())
    s.check("every one of the seven abilities is refused for him", not any(
        run(lambda d, ab=ab: a.leader_can(CHR, ab, d)) for ab in ABILITIES))
    s.check("...his other seats' abilities are untouched (calibration, learning, the rest of the registry)",
            all(run(lambda d, ab=ab: a.leader_can(CHR, ab, d)) for ab in ("hod.view", "hod.move", "bu.view", "bg.view", "gc.view"))
            and run(lambda d: a.leader_learn_can(CHR, "lm.learn_approve", d)))
    s.check("...the delegate, another line manager and the super admin keep all seven", all(
        run(lambda d, ab=ab, w=w: a.leader_can(w, ab, d)) for ab in ABILITIES for w in (DLR, LMR, SU)))
    msg = run(lambda d: a.leader_ability_off(d, CHR, "lm.competency"))
    s.check("his refusal reads in his own words, says nobody does it for him (the delegate no longer stands in), not 'switched off for "
            "your role'", msg and "Executive Chairman" in msg and "nobody does it for you" in msg and "delegate" not in msg
            and "self-assessment counts" in msg and "switched off for your role" not in msg, msg)
    # 2026-11-03 (Chris: "Disable all moderate, even for the delegate"): moderation goes to nobody, so his refusal for it names his
    # Talent Box, not the delegate
    msg = run(lambda d: a.leader_ability_off(d, CHR, "lm.moderate"))
    s.check("...and for moderation it says nobody does it: he sets their bands in his Talent Box (no delegate named)",
            msg and "Executive Chairman" in msg and "Talent Box" in msg and "delegate" not in msg
            and "switched off for your role" not in msg, msg)
    s.check("...and nobody else is told that", run(lambda d: a.leader_ability_off(d, LMR, "lm.moderate")) is None)
    for tick in ("moderate", "behalf", "competency", "plan"):
        seat(CH, DL, ticks=(tick,))
        got = {ab: run(lambda d, ab=ab: a.leader_can(CHR, ab, d)) for ab in ABILITIES}
        s.check("FALSIFY: with only '%s' on he can again exactly its abilities" % tick,
                all(got[ab] == (TICK_OF[ab] == tick) for ab in ABILITIES), got)
    seat(CH, DL, ticks=())

    s.section("the shared writers refuse him, and take the delegate")
    res = run(lambda d: a._pm_manager_remark_write(d, CHR, PERIOD, R2, "ZZ chair remark"))
    s.check("moderation (the report remark) is refused for him, on a line that still names him",
            res[0] is None and res[1]["reason"] == "closed" and "Executive Chairman" in res[1]["msg"], res)
    s.check("...he does not list those lines, so his Team tab is the 360 only",
            run(lambda d: a._pm_approver_subject_ids(d, CHR, PERIOD["id"])) == []
            and not run(lambda d: a._pm_manages_anyone(d, CHR)) and not run(lambda d: a._pm_is_approver_of(d, CHR, R2, PERIOD["id"])))
    seat(CH, DL, ticks=("moderate",))
    res = run(lambda d: a._pm_manager_remark_write(d, CHR, PERIOD, R2, "ZZ chair remark"))
    s.check("FALSIFY: with Moderate on the same write goes through", res[0] == {"ok": True} or (
        res[1] and res[1]["reason"] != "closed"), res)
    s.check("...and his approver list and Team tab are back", R2 in run(lambda d: a._pm_approver_subject_ids(d, CHR, PERIOD["id"]))
            and run(lambda d: a._review_manages_team(d, CHR)))
    seat(CH, DL, ticks=())

    res = run(lambda d: a._tc_override_one(d, CHR, CID, R1, run(lambda d2: d2.execute(
        "SELECT id FROM tc_assignments WHERE subject_id=? AND cycle_id=? LIMIT 1", (R1, CID)).fetchone()[0]), "yes", ""))
    s.check("his competency review is refused (nothing written)", res[0] is None and res[1]["reason"] == "closed"
            and "Executive Chairman" in res[1]["msg"], res)
    s.check("...he lists none of his reports for review (Team view, nav flag and Hub card agree)",
            run(lambda d: a._tc_reports_for(d, CH, CID)) == [] and run(lambda d: a._cycle_review_managers(d, CH, "competency")) == []
            and run(lambda d: a._hub_tc_flags(d, CHR, CID)) == (False, False, 0)
            and run(lambda d: a._tc_team_mids(d, CH)) == [])
    res = run(lambda d: a._idp_plan_comment_write(d, CHR, PERIOD, R1, "ZZ chair plan remark"))
    s.check("his Career Plan close is refused", res[0] is None and res[1]["reason"] == "closed"
            and "Executive Chairman" in res[1]["msg"], res)
    s.check("...he reviews no plan, and has no plans to review in his Team tab",
            run(lambda d: a._idp_review_subject_ids(d, CHR, PERIOD["id"])) == []
            and not run(lambda d: a._idp_is_reviewer_of(d, CHR, R1, PERIOD["id"])) and not run(lambda d: a._idp_lm_has_plans(d, CHR)))
    s.check("...so he has no Team tab at all: only the 360", not run(lambda d: a._review_manages_team(d, CHR)))
    with a.app.test_request_context("/"):
        a.session["user_id"] = CH
        nav = a.inject_user()
    s.check("...and the nav's competency Team view is gone for him", nav.get("nav_is_tc_manager") is False,
            nav.get("nav_is_tc_manager"))
    seat(CH, DL, ticks=("competency",))
    cid_aid = run(lambda d: d.execute("SELECT id FROM tc_assignments WHERE subject_id=? AND cycle_id=? LIMIT 1", (R1, CID)).fetchone()[0])
    res = run(lambda d: a._tc_override_one(d, CHR, CID, R1, cid_aid, "yes", ""))
    s.check("FALSIFY: with Review their competency on he can review R1 (written)", res[0] and res[0].get("ok")
            and {r["id"] for r in run(lambda d: a._tc_reports_for(d, CH, CID))} == {R1, R2, DL}
            and run(lambda d: a._hub_tc_flags(d, CHR, CID))[1] and a.chair_on(), res)
    with a.app.test_request_context("/"):
        a.session["user_id"] = CH
        nav = a.inject_user()
    s.check("FALSIFY: ...and the nav's Team view is back for him", nav.get("nav_is_tc_manager") is True, nav.get("nav_is_tc_manager"))
    seat(CH, DL, ticks=("plan",))
    res = run(lambda d: a._idp_plan_comment_write(d, CHR, PERIOD, R1, "ZZ chair plan remark"))
    s.check("FALSIFY: with Career Plan on he can close R1's plan review (written), and lists their plans",
            res[0] == {"ok": True} and run(lambda d: a._idp_is_reviewer_of(d, CHR, R1, PERIOD["id"]))
            and run(lambda d: a._idp_lm_has_plans(d, CHR)) and R1 in run(lambda d: a._idp_review_subject_ids(d, CHR, PERIOD["id"])), res)
    seat(CH, DL, ticks=())
    res = run(lambda d: a._tc_override_one(d, CHR, CID, R1, cid_aid, "yes", ""))
    s.check("...and turned off again he is refused again", res[0] is None and res[1]["reason"] == "closed", res)
    # behalf: the on-behalf gate is its own ability
    s.check("assessing on their behalf is refused for him (the shared gate says why)",
            "Executive Chairman" in (run(lambda d: a.leader_ability_off(d, CHR, "lm.behalf")) or "")
            and "Executive Chairman" in (run(lambda d: a.leader_ability_off(d, CHR, "mx.behalf")) or ""))

    s.section("the delegate does not review the chair's reports: nobody does (2026-11-06), and everyone else's is untouched")
    # Chris, 2026-11-06 ("B: nobody reviews"): with his Competency and Career Plan ticks off the chair's reports have no reviewer at
    # all, the delegate included; the rule's own suite is tests/test_chair_norev.py. Here: the delegate's lists and the writers.
    s.check("the delegate's competency list is empty (the chair's reports are his no more, and their own row never was)",
            {r["id"] for r in run(lambda d: a._tc_reports_for(d, DL, CID))} == set()
            and run(lambda d: a._cycle_review_managers(d, DL, "competency")) == [DL])
    s.check("...another manager's list is their own report only, the chair's reports are in no one's",
            {r["id"] for r in run(lambda d: a._tc_reports_for(d, LMX, CID))} == {OR}
            and run(lambda d: a._cycle_review_managers(d, LMX, "competency")) == [LMX]
            and run(lambda d: a._cycle_review_managers(d, R1, "competency")) == [R1])
    s.check("the chair's team adjustment: he drops his own, the delegate gains nothing", 
            run(lambda d: a._chair_team_adjust(d, DL, "competency")) == (False, [])
            and run(lambda d: a._chair_team_adjust(d, DL, "plan")) == (False, [])
            and run(lambda d: a._chair_team_adjust(d, CH, "competency")) == (True, [])
            and run(lambda d: a._chair_team_adjust(d, CH, "plan")) == (True, []))
    res = run(lambda d: a._tc_override_one(d, DLR, CID, R1, cid_aid, "yes", ""))
    s.check("the delegate cannot review R1's competency any more (403 forbidden, nothing written)",
            res[0] is None and res[1]["reason"] == "forbidden", res)
    oid = run(lambda d: d.execute("SELECT id FROM tc_assignments WHERE subject_id=? AND cycle_id=? LIMIT 1", (OR, CID)).fetchone()[0])
    res = run(lambda d: a._tc_override_one(d, DLR, CID, OR, oid, "yes", ""))
    s.check("...and not someone else's report either (403 forbidden)", res[0] is None and res[1]["reason"] == "forbidden", res)
    did = run(lambda d: d.execute("SELECT id FROM tc_assignments WHERE subject_id=? AND cycle_id=? LIMIT 1", (DL, CID)).fetchone()[0])
    res = run(lambda d: a._tc_override_one(d, DLR, CID, DL, did, "yes", ""))
    s.check("...nor their own competency (they are a report of the chair too)", res[0] is None and res[1]["reason"] == "forbidden", res)
    s.check("the delegate's Team flags: no competency team, no plans to review (they have no reports of their own here)",
            run(lambda d: a._hub_tc_flags(d, DLR, CID))[1] is False and run(lambda d: a._tc_team_mids(d, DL)) == [DL]
            and not run(lambda d: a._idp_lm_has_plans(d, DLR)) and not run(lambda d: a._review_manages_team(d, DLR)))
    with a.app.test_request_context("/"):
        a.session["user_id"] = DL
        nav = a.inject_user()
    s.check("...and the nav has no competency Team view for the delegate", nav.get("nav_is_tc_manager") is False,
            nav.get("nav_is_tc_manager"))
    pr = lambda who, subj: run(lambda d: a._idp_is_reviewer_of(d, who, subj, PERIOD["id"]))
    s.check("nobody reviews R1's Career Plan: not the delegate, not the other manager, not the chair; the other manager's own "
            "report is still theirs", not pr(DLR, R1) and not pr(LMR, R1) and not pr(CHR, R1) and not pr(DLR, OR) and pr(LMR, OR)
            and R1 not in run(lambda d: a._idp_review_subject_ids(d, DLR, PERIOD["id"])))
    res = run(lambda d: a._idp_plan_comment_write(d, DLR, PERIOD, R1, "ZZ delegate plan remark"))
    s.check("...the shared writer refuses the delegate (403)", res[0] is None and res[1]["reason"] == "forbidden", res)
    seat(CH, DL, ticks=("competency", "plan"))
    s.check("FALSIFY: with both his ticks on the chair reviews his reports again (and the delegate still does not)",
            {r["id"] for r in run(lambda d: a._tc_reports_for(d, CH, CID))} == {R1, R2, DL}
            and {r["id"] for r in run(lambda d: a._tc_reports_for(d, DL, CID))} == set()
            and run(lambda d: a._cycle_review_managers(d, DL, "competency")) == [DL]
            and not pr(DLR, R1) and pr(CHR, R1))
    seat(CH, None, ticks=())
    s.check("with no delegate named it is the same: nobody reviews his reports, his abilities stay off, and the page no longer "
            "says someone stands in",
            run(lambda d: a._cycle_review_managers(d, DL, "competency")) == [DL]
            and not run(lambda d: a.leader_can(CHR, "lm.competency", d))
            and "Nobody stands in yet" not in SUP.get("/admin/leaders/chair").get_data(as_text=True))
    seat(CH, DL, ticks=())

    s.section("the default KPI moderator: none for the chair's reports (2026-11-03), and the delegate's own items")
    # Chris, 2026-11-03: "Disable all moderate, even for the delegate": with the Moderate tick off the chair's direct reports have NO
    # moderator, the delegate's own lines included. (Before: the delegate moderated them as his stand-in; see tests/test_chair_nomod.py.)
    s.check("a new line for the chair's report has no moderator (the shared setting resolver gives an empty chain)",
            run(lambda d: a.pm_setting_resolve_approvers(d, R1R)) == [])
    s.check("...nor does the import's and the person page's (the one moderator function), the LM's-own-ID case included",
            run(lambda d: a._pm_kpi_moderator(d, R1R, "", "ZZ"))[0]["approver_ids"] == []
            and run(lambda d: a._pm_kpi_moderator(d, R1R, EID["CH"], "ZZ"))[0]["approver_ids"] == []
            and run(lambda d: a._pm_kpi_moderator(d, R1R, EID["CH"], "ZZ"))[0]["route"] == "chair")
    s.check("...a report of another manager keeps theirs", run(lambda d: a.pm_setting_resolve_approvers(d, ORR)) == [LMX])
    s.check("...and the delegate's own line has none either (their line manager is the chair)",
            run(lambda d: a.pm_setting_resolve_approvers(d, DLR)) == []
            and run(lambda d: a._pm_kpi_moderator(d, DLR, "", "ZZ"))[0]["approver_ids"] == [])
    s.check("a matrix manager who is not the chair's report's line manager is still the matrix manager",
            run(lambda d: a._pm_kpi_moderator(d, R1R, EID["LM"], "ZZ"))[0]["approver_ids"] == [LMX])
    seat(CH, DL, ticks=("moderate",))
    s.check("FALSIFY: with Moderate on the chair is the default moderator again",
            run(lambda d: a.pm_setting_resolve_approvers(d, R1R)) == [CH]
            and run(lambda d: a._pm_kpi_moderator(d, R1R, "", "ZZ"))[0]["approver_ids"] == [CH])
    seat(CH, DL, ticks=())
    # a line that still names the delegate (made before the rule): the delegate is refused, not the matrix manager's
    run(lambda d: (a._pm_set_moderator(d, LINE_R1, [DL]), d.commit()))
    s.check("...the delegate no longer stands in as the line manager (mx.moderate, not lm.moderate), and the write is refused",
            run(lambda d: a._pm_mod_ability(d, DLR, R1)) == "mx.moderate"
            and run(lambda d: a._pm_mod_ability(d, LMR, R1)) == "mx.moderate"
            and run(lambda d: a._pm_behalf_ability(d, DLR, R1)) == "mx.behalf")
    res = run(lambda d: a._pm_manager_remark_write(d, DLR, PERIOD, R1, "ZZ delegate remark"))
    s.check("...even a chain that still names the delegate is refused by the shared moderation writer",
            res[0] is None and res[1]["reason"] == "closed" and "Talent Box" in res[1]["msg"], res)
    run(lambda d: (a._pm_set_moderator(d, LINE_R1, []), d.commit()))
    s.check("no existing KPI line was re-pointed by any of this (a production data step, not code)",
            H.rows(a, "SELECT id, approver_id FROM pm_kpi_target_approvers WHERE kpi_target_id IN (%d)" % LINE_R2)[0][1] == CH)

    s.section("the chair still rates in the 360, and stays their line manager")
    s.check("nothing about the panels or manager_id changed: R1, R2 and the delegate still report to him, his assignment stands",
            {k: u(v)["manager_id"] for k, v in (("R1", R1), ("R2", R2), ("DL", DL))} == BEFORE["manager"]
            and H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=?", (CID,)) == BEFORE["assign"]
            and H.one(a, "SELECT COUNT(*) FROM assignments WHERE subject_id=? AND assessor_id=? AND relationship='line_manager'",
                      (R1, CH)) == 1)
    CC = H.client_as(a, CH)
    r = CC.get("/rate/%d" % R1)
    s.check("with every team tick off the chair opens R1's 360 rating page (no 403, no redirect)", r.status_code == 200
            and "ZZ EC R1" in r.get_data(as_text=True), r.status_code)
    stmt = H.rows(a, "SELECT statement_id FROM responses WHERE assignment_id=(SELECT id FROM assignments WHERE subject_id=? "
                     "AND assessor_id=? AND cycle_id=?)", (R1, CH, CID))
    form = {"csrf_token": "tok", "ajax": "1", "action": "save"}
    form.update({"ans_%d" % x[0]: "yes" for x in stmt[:1]})
    r = CC.post("/rate/%d" % R1, data=form)
    s.check("...and saves a rating on it", r.status_code in (200, 204) and bool(stmt) and H.one(
        a, "SELECT COUNT(*) FROM responses WHERE assignment_id=(SELECT id FROM assignments WHERE subject_id=? AND "
           "assessor_id=? AND cycle_id=?) AND answer='yes'", (R1, CH, CID)) >= 1, (r.status_code, len(stmt)))
    r = CC.get("/rate/%d" % R2)
    s.check("...and has no rating page for someone not assigned to him (403, as for anyone)", r.status_code == 403, r.status_code)

    s.section("who is the chair when things change")
    put("exec_chair_id", LV)
    s.check("a chair who has left is nobody (the page says so)", run(lambda d: a.chair_user_id(d)) is None
            and all(run(lambda d, ab=ab: a.leader_can(CHR, ab, d)) for ab in ABILITIES)
            and "has left, so nobody holds the seat" in SUP.get("/admin/leaders/chair").get_data(as_text=True))
    put("exec_chair_id", "not a number")
    s.check("...so is a setting that is not a person", run(lambda d: a.chair_user_id(d)) is None)
    put("exec_chair_id", BGA)
    s.check("...so is an admin account stored by hand", run(lambda d: a.chair_user_id(d)) is None)
    seat(CH, CH, ticks=())
    s.check("a delegate stored as the chair himself is nobody (never his own stand-in)",
            run(lambda d: a.chair_delegate_id(d)) is None and run(lambda d: a._cycle_review_managers(d, CH, "competency")) == [])
    seat(CH, DL, ticks=())
    os.environ.pop("ONEHR_CHAIR", None)
    s.section("flag off again: back to today")
    s.check("every ability, list and default is today's, with the seat and ticks still stored",
            all(run(lambda d, ab=ab: a.leader_can(CHR, ab, d)) for ab in ABILITIES)
            and run(lambda d: a._cycle_review_managers(d, CH, "competency")) == [CH]
            and run(lambda d: a._cycle_review_managers(d, DL, "competency")) == [DL]
            and run(lambda d: a.pm_setting_resolve_approvers(d, R1R)) == [CH]
            and SUP.get("/admin/leaders/chair").status_code == 404 and SUP.get(LEAD).get_data(as_text=True) == off_html)

    s.section("the other lint suites know the route")
    s.check("the audit-log action labels exist for every chair action",
            all(a.action_label(x) != x.replace("_", " ").capitalize() for x in ("exec_chair_set", "exec_chair_delegate_set",
                                                                              "exec_chair_team")))
    s.check("no new def shadows another in app.py (a later def silently wins)", all(
        len(re.findall(r"^def %s\(" % n, SRC, re.M)) == 1 for n in (
            "chair_on", "_chair_state", "chair_user_id", "is_chair", "chair_delegate_id", "_chair_off_ability",
            "_chair_team_adjust", "_chair_pm_hidden", "_chair_stands_in", "_pm_default_moderator_id", "_chair_pick",
            "_chair_save", "_chair_page", "admin_leaders_chair", "_chair_gate", "_tc_team_mids",
            "_cycle_review_managers", "_cycle_review_managers_own")))
finally:
    os.environ.pop("ONEHR_CHAIR", None)
    a.window_closed, a.cycle_is_open = _real_window, _real_open

sys.exit(s.done())
