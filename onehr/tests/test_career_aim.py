"""A chosen career role is an AIM, never a promotion (Chris, 2026-10-22: "do we mention the career track or goal user
picks serves just as aspiration and not a guarantee promotion?"; then, on the canvas "OneHR Career Aim Wording",
[design canvas link removed], "ok to go ahead").

What this suite holds:
  * the line is said in all five places: the direction card (with the skills-match clause only when skill states
    show), right after the pick ("Noted: you're aiming for ..." where it was "Locked in ..."), the Share pop-up (the
    role they're aiming for, with its grade), the dashboard's Career Plan panel, the line manager's Approve card (and
    the classic Approve page)
  * the Share pop-up's line comes from the person's own pick, and says the plan itself is the aim without one
  * both agents that talk about roles (the journey's Career Plan brief, the standalone career chat) carry the rule
  * one look: .rv-aim-note, navy, never red

  * the card's pick ("I'd like to aim for <role>", Chris, 2026-11-01) is never a model message on another part: with
    the Career Plan locked it gets the fixed locked line and saves nothing (the page puts Confirm back); with it open
    but the page on another part it is the Career Plan's pick and saves; the card never stays "Confirmed" unsaved

Fresh database (fresh_db=True): one person's career profile is written and the suite's copy is put back at the end.
"""
import inspect
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("A chosen career role is an aim, never a promotion")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
JS = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
DJS = open(os.path.join(H.REPO, "static", "dashboard.js"), encoding="utf-8").read()
CSS = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
SRC = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
TPL = open(os.path.join(H.REPO, "templates", "idp_team_member.html"), encoding="utf-8").read()


def _fn(src, name):
    """The body of one JS function, from its name to the next top-level-ish function."""
    i = src.find("function %s(" % name)
    return src[i:src.find("\n  function ", i + 10)] if i >= 0 else ""


s.section("1. Where they pick: the direction card")
card = _fn(JS, "careerDirectionCard")
s.check("the card says a pick is an aim, not a promotion or a promise of a move",
        "Pick where you'd like to aim. Your pick shapes your development goals. " in card
        and "It isn't a promotion or a promise of a move" in card and "if (roles.length) box.appendChild(aimNote(" in card)
s.check("...and that a skills match isn't a promotion decision, only where skill states show",
        '(skilled ? ", and a skills match isn\'t a promotion decision." : ".")' in card)
s.check("...the old one-line sub is gone; \"Ordered by how close\" stays for routed roles with skills",
        "it is not a promotion decision" not in card
        and 'if (skilled && routed)' in card and '"Ordered by how close each role is to your job."' in card)

s.section("2. Right after the pick")
src_pick = SRC[SRC.find("# an aim, never a promotion (Chris, 2026-10-22"):][:900]
s.check("both replies open \"Noted: you're aiming for <role>.\" and say an aim isn't a promotion",
        src_pick.count("\"Noted: you're aiming for %s. %s ") == 2 and src_pick.count("CAREER_AIM_PICKED") == 2
        and a.CAREER_AIM_PICKED == "An aim guides your development; it isn't a promotion.")
s.check("...\"Locked in\" is gone from the Career Plan's replies", "\"Locked in %s." not in SRC)

s.section("3. The Share pop-up")
s.check("the career plan's preview carries the line", 'out["aim"] = _career_aim_line(db, u)'
        in inspect.getsource(a._signoff_preview))
s.check("...and the pop-up draws it before the warning, career plan only",
        'if (stage === "career_plan" && pv.aim && pv.aim.say) body.appendChild(aimNote(pv.aim.say, pv.aim.role));' in JS
        and JS.find("body.appendChild(aimNote(pv.aim.say") < JS.find('w.className = "modal-warning rv-so-warn"'))

import sqlite3  # noqa: E402
con = sqlite3.connect(a.DB_PATH)
con.row_factory = sqlite3.Row
# the suite's own role to aim for (the suite database may hold no job profiles; the fresh copy is put back at the end)
_tid = con.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, source, active) "
                   "VALUES ('ZZTEST Dept', 'ZZTEST Assistant Manager, Sales', '15', 'test', 1)").lastrowid
con.commit()
prof = con.execute("SELECT id, job_title, job_grade FROM tc_job_profiles WHERE id=?", (_tid,)).fetchone()
who = con.execute("SELECT id FROM users WHERE id NOT IN (SELECT subject_id FROM pm_career_profile) "
                  "ORDER BY id LIMIT 1").fetchone()
s.check("a role to aim for, and someone with no career profile yet", bool(prof and who))
if prof and who:
    u = {"id": who["id"]}
    none_line = a._career_aim_line(con, u)
    s.check("no pick: the plan itself is the aim", none_line == {"role": None, "say": "Your Career Plan guides your "
            "development. It isn't a promotion or a promise of a move."}, none_line)
    con.execute("INSERT INTO pm_career_profile (subject_id, target_profile_id) VALUES (?, ?)", (who["id"], prof["id"]))
    con.commit()
    try:
        line = a._career_aim_line(con, u)
        s.check("a pick: the role with its grade, and that it guides the goals and isn't a promotion",
                line["role"] == "%s (JG%s)" % (prof["job_title"].strip(), prof["job_grade"])
                and line["say"] == "It guides your development goals; it isn't a promotion or a promise of a move.",
                line)
    finally:
        con.execute("DELETE FROM pm_career_profile WHERE subject_id=?", (who["id"],))
        con.commit()
con.close()

s.section("4. The dashboard's Career Plan panel")
s.check("under Where you want to go", "Where you're aiming guides your development. It isn't a promotion or a promise "
        "of a move." in DJS and DJS.find('["Target role", d.profile.target]') < DJS.find("Where you're aiming guides"))

s.section("5. The line manager's Approve card")
w = _fn(JS, "idpReviewWidget")
s.check("just above Approve plan (Chris, 2026-10-22: \"do we have same disclaimer note on the LM view?\"): approving "
        "agrees the goals, not a move to the role",
        '"Their aim guides the plan. Approving agrees the development goals, not a move to the role."' in w
        and w.find("rv-idp-aim") < w.find("Their aim guides the plan") < w.find('"Approve plan"'))
s.check("...said even when they haven't picked a role, and above the approved line too",
        '"A Career Plan is an aim, not a promotion. Approving agrees the development goals, not a move to a new role."'
        in w and w.find("A Career Plan is an aim, not a promotion") < w.find("if (closed) {")
        and "box.appendChild(aimNote(aim && aim.title" in w and w.count("aimNote(") == 1)
s.check("...and on the classic Approve page", "Their aim guides the plan: approving agrees the development goals,"
        in TPL and "not a move to the role." in TPL)

s.section("6. The agents")
rule = a.CAREER_AIM_RULE
s.check("the rule: an aim, never a promotion, a promise of a move or something they'll get",
        "AIMING" in rule and "NEVER call it a promotion, a promise of a move, or something they will get" in rule)
s.check("...in the journey's Career Plan brief", "CAREER_AIM_RULE" in inspect.getsource(a._journey_career_plan_task))
s.check("...and in the standalone career chat", "CAREER_AIM_RULE" in inspect.getsource(a._career_agent_system))

s.section("7. One look")
s.check("aimNote draws the note, the role in bold after \"You're aiming for\"", 'n.className = "rv-aim-note"' in JS
        and "You're aiming for " in _fn(JS, "aimNote"))
s.check(".rv-aim-note: the light navy box, a navy icon, never red",
        ".rv-aim-note {" in CSS and H.cv("background: #f3f5fc") in CSS[CSS.find(".rv-aim-note {"):][:300]
        and H.cv("stroke: var(--navy)") in CSS
        and "#d61923" not in CSS[CSS.find(".rv-aim-note {"):][:600].lower()
        and not re.search(r"var\(--(ai|ai-ink|ai-tint|ai-line|[\w-]*d61923)\)", CSS[CSS.find(".rv-aim-note {"):][:600]))

s.section("8. The card's pick on another part (Chris, 2026-11-01: \"Confirmed\", then \"isn't available as the next-move direction\")")
import ai_draft  # noqa: E402

CHBM = "CHIN HIN BUILDING MATERIAL (CHBM)"
CALLS = [0]


def _stub(system, messages, timeout=90):
    CALLS[0] += 1
    return {"say": "(the model answered)", "quick_replies": [], "action": None}


_avail0, _agent0 = ai_draft.review_agent_available, ai_draft.review_agent
ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = _stub
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
        # the role on the card: a job-architecture role one grade up (a ZZ account's roles come from this source)
        AIM_PID = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, source, active) VALUES "
                             "('ZZTEST Dept', 'ZZTEST Senior Executive, Sales', '15', ?, 1)",
                             (a._CAREER_DEMO_SOURCE,)).lastrowid
        AIM_LBL = "ZZTEST Senior Executive, Sales (JG15)"
        _sk = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_category, proficiency_description, "
                         "ability_items, active) VALUES ('ZZAIM-SK', 'ZZ Aim Skill', 3, 'Operations', 'x', '- One', 1)").lastrowid

        def mk(eid, name):
            return db.execute(
                "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, "
                "department, job_title, job_grade, confirmation_date, years_of_service) "
                "VALUES (?,?,'x','user',?,?,'ZZ Co','ZZTEST Dept','Executive','14','2020-01-01', 4.0)",
                (eid, name, eid, CHBM)).lastrowid
        LOCKED, OPEN = mk("ZZAIMA", "Test Aim Locked"), mk("ZZAIMB", "Test Aim Open")
        COL = mk("ZZAIMC", "Test Aim Colleague")
        for uid in (LOCKED, OPEN):
            db.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, stage) "
                       "VALUES (?,?,'agent','Hello.','account')", (uid, CID))
        # LOCKED has a KPI check-in and a competency still open, so the Career Plan waits; OPEN has neither, but a
        # colleague to rate, so the page can be on another part (the 360) while the Career Plan is open
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
                   "rate1, rate2, rate3, rate4, rate5) VALUES (?,?,'ZZ Aim KPI',100.0,'more','approved',?,9,11,12,13,15)",
                   (CID, LOCKED, CHBM))
        db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, source) VALUES (?,?,?,0,'profile')",
                   (CID, LOCKED, _sk))
        db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) "
                   "VALUES (?,?,?,'peer','pending')", (CID, COL, OPEN))
        db.commit()
    TREE = "ZZTEST Senior Executive, Sales"

    def _state(uid):
        with a.app.test_request_context("/"):
            from flask import session
            session["user_id"] = uid
            db = a.get_db()
            u = dict(db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
            st = a.review_state(db, u)
            keys = [x["key"] for x in a._journey_live_stages(st)]
            cand = [r["title"] for r in a._career_candidate_roles(db, u)["roles"]]
            return a._journey_idp_locked(st), keys, cand, a._journey_switch_line(db, u, CID, st, "career_plan")

    def _aim(uid):
        r = H.rows(a, "SELECT target_profile_id FROM pm_career_profile WHERE subject_id=?", (uid,))
        return r[0]["target_profile_id"] if r else None

    def _turn(uid, stage, msg):
        c = H.client_as(a, uid)
        r = c.post("/review/chat?journey=1", data={"csrf_token": "tok", "message": msg, "stage": stage, "journey": "1"})
        return (r.get_json() or {}) if r.status_code == 200 else {"_status": r.status_code}

    lk_locked, lk_keys, lk_cand, lk_line = _state(LOCKED)
    op_locked, op_keys, op_cand, _ = _state(OPEN)
    s.check("fixture: LOCKED waits on its check-in and competency and has Career Plan among its parts; OPEN does not wait, "
            "has the 360 as another part, and both are offered the role",
            lk_locked is True and "career_plan" in lk_keys and op_locked is False and "career_plan" in op_keys
            and "feedback" in op_keys and TREE in lk_cand and TREE in op_cand, (lk_locked, lk_keys, op_locked, op_keys))
    PICK = "I'd like to aim for " + AIM_LBL

    # (a) locked: the fixed line, no model, nothing saved, the card told to go back
    n0 = CALLS[0]
    j = _turn(LOCKED, "career_plan", PICK)
    def _locked_ok(j):
        return (j.get("say") == lk_line[0] and j.get("aim_refused") is True and j.get("stage") != "career_plan"
                and j.get("moved") is False and not j.get("aim_saved") and bool(j.get("modtabs_html")))
    s.check("(a) locked Career Plan, pick posted with stage=career_plan: the fixed locked line, flagged aim_refused, "
            "the part stays on another stage",
            _locked_ok(j), (j.get("say"), j.get("stage"), j.get("aim_refused")))
    s.check("...no model call, and nothing saved (no target, no aspiration)",
            CALLS[0] == n0 and _aim(LOCKED) is None
            and H.one(a, "SELECT COUNT(*) FROM pm_career_profile WHERE subject_id=?", (LOCKED,)) == 0, CALLS[0] - n0)
    _tap = H.client_as(a, LOCKED).post("/review/chat?journey=1", data={
        "csrf_token": "tok", "message": "", "stage": "career_plan", "switch": "1", "from": "account", "journey": "1"}).get_json()
    s.check("...the locked line is the very one a tap on the locked Career Plan gets",
            j.get("say") == _tap.get("say") and bool(j.get("say")), (j.get("say"), _tap.get("say")))
    # falsify: with the guard off the pick reaches the model on the part it was swapped to
    _src = a._JOURNEY_AIM_RE
    try:
        import re as _re
        a._JOURNEY_AIM_RE = _re.compile(r"^(?!x)x")   # the aim pattern matches nothing: today's behaviour
        n1 = CALLS[0]
        jf = _turn(LOCKED, "career_plan", PICK)
        broken = (CALLS[0] > n1) and not _locked_ok(jf)
    finally:
        a._JOURNEY_AIM_RE = _src
    s.check("falsified: without the guard the same pick goes to the model on another part", broken)

    # (b) open, but the page is on another part (a stale card picked from the history): it is the Career Plan's pick
    n0 = CALLS[0]
    j = _turn(OPEN, "feedback", PICK)
    s.check("(b) Career Plan open, pick posted from the 360: saved, the deterministic \"Noted\" line, stage career_plan, "
            "aim_saved, no model call",
            _aim(OPEN) == AIM_PID and CALLS[0] == n0 and j.get("stage") == "career_plan" and j.get("aim_saved") is True
            and (j.get("say") or "").startswith("Noted: you're aiming for %s. %s " % (AIM_LBL, a.CAREER_AIM_PICKED))
            and not j.get("aim_refused"), (_aim(OPEN), j.get("stage"), (j.get("say") or "")[:60]))
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_career_profile WHERE subject_id=?", (OPEN,))
        a.get_db().commit()

    # (c) the normal path is unchanged
    n0 = CALLS[0]
    j = _turn(OPEN, "career_plan", PICK)
    s.check("(c) pick posted with stage=career_plan, unlocked: saved as before, same line, aim_saved",
            _aim(OPEN) == AIM_PID and CALLS[0] == n0 and j.get("stage") == "career_plan" and j.get("aim_saved") is True
            and (j.get("say") or "").startswith("Noted: you're aiming for %s. " % AIM_LBL), (_aim(OPEN), j.get("stage")))
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_career_profile WHERE subject_id=?", (OPEN,))
        a.get_db().commit()

    # a role that is not on the card is neither saved nor flagged saved: the page puts its Confirm back
    j = _turn(OPEN, "career_plan", "I'd like to aim for Chief of Everything (JG30)")
    s.check("an off-list pick: not saved, and no aim_saved, so the card does not stay Confirmed",
            _aim(OPEN) is None and not j.get("aim_saved"), (j.get("aim_saved"), _aim(OPEN)))
    # falsify (b): without the re-route the stale pick is not saved
    try:
        a._JOURNEY_AIM_RE = _re.compile(r"^(?!x)x")
        _turn(OPEN, "feedback", PICK)
        broken_b = _aim(OPEN) is None
    finally:
        a._JOURNEY_AIM_RE = _src
    s.check("falsified: without the re-route a stale pick from another part saves nothing", broken_b)

    # the page: the card goes back to Confirm when the reply is not the saved aim
    s.check("the page keeps one way back: pendingAimUndo is set by Confirm, taken by the turn, run unless aim_saved, "
            "and on a failed request",
            "var pendingAimUndo = null;" in JS and "pendingAimUndo = function ()" in JS
            and "var aimUndo = pendingAimUndo; pendingAimUndo = null;" in JS
            and "if (aimUndo && !(j && j.aim_saved)) aimUndo();" in JS and JS.count("if (aimUndo) aimUndo();") == 1)
    undo_src = JS[JS.find("pendingAimUndo = function ()"):][:260]
    s.check("...the undo removes rv-dir-picked, restores the earlier confirmed role and redraws Confirm",
            'box.classList.remove("rv-dir-picked")' in undo_src and "confirmedId = wasConfirmed" in undo_src
            and "updGo();" in undo_src)
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _avail0, _agent0

sys.exit(s.done())
