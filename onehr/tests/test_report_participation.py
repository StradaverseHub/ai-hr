"""A leader sees a report only in the parts of the review the report takes part in (Chris, 2026-10-30: "out means out").

Production had 35 people on a role "IDP user" (no Performance, no 360 about them, no competency) and 8 taken out on
Participants who still had KPI lines with approvers and competency assignments, so their line managers' lists would have
carried them when the line manager window opens, and "assess on their behalf" would have let the line manager write their
figures. Taking part is per part: participant_sql(prefix, module) over a population, _report_takes_part(db, id, module)
for one person (both over participation()'s rule), with module pm / competency / tm_rated.

What this suite holds, with one line manager (also the first approver of every line, a second approver after them) and:
  * a control who takes part in everything
  * A: on a role without Performance (competency and the 360 stay)
  * B: on a role without the competency review (Performance and the 360 stay)
  * C: taken out on Participants AFTER they submitted -- their work leaves the lists too
  * D: below the cycle's minimum job grade
  * E: on a role without the 360 about them (Performance and competency stay)
and, for the Career Plan guard, a second leader whose only reports are an "IDP user" and one taken out:
  * KPI lists (journey Team, Performance Team, counts, Team door/stage, summaries, bulk approve), competency lists
    (Team view, hub flags, summaries, bulk approve) and the 360 the line manager reads follow it, by relationship
  * every writer refuses an out report, and with the list gates forced open still refuses (defence in depth): on-behalf
    draft and commit for KPI and competency, moderate draft and lock, the remarks, competency override and approve,
    the chat tools, and the routes (403 / 404 / 409 with the words, never a write)
  * the Career Plan is untouched: the IDP review lists, reviewer test and Team door keep every one of them
Synthetic ZZPR people only; a fresh_db suite, so Suite.done() puts the scratch copy back.
"""
import atexit
import contextlib
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
_FINISHED = False
atexit.register(lambda: None if _FINISHED else H.restore_db())   # a crash must not leave its ZZPR people for the next suite
s = H.Suite("Leaders' KPI and competency lists and writers follow the report's participation")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
C_SU = H.client_as(a, SU["id"])


@contextlib.contextmanager
def D():
    """A request context of its own: nothing cached across checks (the roles map, windows, the leader abilities)."""
    with a.app.test_request_context("/"):
        yield a.get_db()


# ------------------------------------------------------------------------------------------------ the people
with D() as db:
    CID = a.active_cycle_id(db)
    P = dict(a.active_pm_period(db))
    assert P["id"] == CID, (P["id"], CID)
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=?", (CID,))
    db.execute("DELETE FROM leader_role_access WHERE ability IN ('lm.behalf','mx.behalf','lm.moderate','lm.competency')")
    MG = a.active_cycle(db)["min_job_grade"]
    if MG is None:
        db.execute("UPDATE cycles SET min_job_grade=12 WHERE id=?", (CID,))
        MG = 12
    base = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 AND business_group "
                      "IN (SELECT business_group FROM pm_bg_config WHERE mechanism='A') LIMIT 1").fetchone()
    if base is None:   # the generated fixture (a worktree has no leadership360.db): give one group the 1-5 ladder
        base = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone()
        db.execute("INSERT OR REPLACE INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)",
                   (base["business_group"],))
    base = dict(base)
    cols = [c for c in base if c != "id"]
    GRADE, LOW = str(max(int(MG), 14)), str(int(MG) - 1)
    UM = a._urole_map(db)

    def mkrole(name, mods):
        rid = db.execute("INSERT INTO user_roles(name, created_by) VALUES (?,?)", (name, SU["id"])).lastrowid
        db.executemany("INSERT INTO user_role_modules(role_id, module) VALUES (?,?)", [(rid, m) for m in mods])
        return rid

    COMMON = ("tm_rate", "idp", "results")
    R_NOPM = mkrole("ZZPR no Performance", ("tm_rated", "competency") + COMMON)
    R_NOCOMP = mkrole("ZZPR no competency", ("pm", "tm_rated") + COMMON)
    R_NO360 = mkrole("ZZPR no 360 about them", ("pm", "competency") + COMMON)
    R_IDP = mkrole("ZZPR IDP user", ("idp", "results"))

    def mk(tag, mgr=None, role=None, grade=None):
        eid = "ZZPR-" + tag
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ Part " + tag, display_name=None, email=None,
                 hod_id=None, manager_id=mgr, buceo_bg=None, buceo_company=None, bgceo_bg=None,
                 confirmation_date="2020-01-01", left_at=None, role="user", is_demo=0, job_grade=grade or GRADE,
                 user_role_id=role, years_of_service=5)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v.get(c) for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    LM = mk("LM")
    NX = mk("NX")
    LMX = mk("LMX")          # the second leader: only reports who are out of Performance and the competency review
    NXO = mk("NXO")          # approves the second leader's reports without leading them
    CTL = mk("CTL", LM)
    RA = mk("RA", LM, R_NOPM)
    RB = mk("RB", LM, R_NOCOMP)
    RC = mk("RC", LM)        # taken out on Participants once they have submitted
    RD = mk("RD", LM, grade=LOW)
    RE = mk("RE", LM, R_NO360)
    X1 = mk("X1", LMX, R_IDP)
    X2 = mk("X2", LMX)       # taken out
    ALL = [CTL, RA, RB, RC, RD, RE]
    NAME = {CTL: "CTL", RA: "RA", RB: "RB", RC: "RC", RD: "RD", RE: "RE", X1: "X1", X2: "X2"}
    L1, L2, TCA = {}, {}, {}
    for n_ in (1, 2):   # two competencies to assign (the generated fixture has none)
        db.execute("INSERT OR IGNORE INTO tc_skills(skill_code, title, level, skill_type, skill_category, active) "
                   "VALUES (?,?,3,'ZZ','ZZ PR',1)", ("ZZPR-S%d" % n_, "ZZ Part skill %d" % n_))
    skills = [r[0] for r in db.execute("SELECT id FROM tc_skills WHERE skill_code LIKE 'ZZPR-S%' ORDER BY id")]
    for who in ALL + [X1, X2]:
        first, second = (LM, NX) if who in ALL else (LMX, NXO)
        ids = []
        for name, unit, w in (("ZZ Sales revenue", "RM (mil)", 60), ("ZZ Collection", "%", 40)):
            db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, "
                       "company, unit, rate1, rate2, rate3, rate4, rate5, status) VALUES "
                       "(?,?,?,?,?,?,?,?,1,2,3,4,5,'approved')",
                       (CID, who, name, w, "more", base["business_group"], base["company"], unit))
            tid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
            ids.append(tid)
            db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (tid, first))
            db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,2,?)", (tid, second))
        L1[who], L2[who] = ids          # the first line submitted, the second saved and never submitted
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)",
                   (ids[0], 3.5, who))
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,1)",
                   (ids[1], 2.5, who))
        TCA[who] = []
        for sk, fut in zip(skills, (0, 1)):
            db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future) VALUES (?,?,?,?)",
                       (CID, who, sk, fut))
            TCA[who].append(db.execute("SELECT last_insert_rowid()").fetchone()[0])
    # a 360 panel for each of the main reports (three raters, nothing submitted)
    for who in ALL:
        for rater in (LM, NX, LMX):
            db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?,'peer')",
                       (CID, who, rater))
    db.commit()
    # competency: RA, RC and RE have submitted (the normal review path); CTL, RB and RD never did (on behalf)
    SUBMITTED = [RA, RC, RE]
    for who in SUBMITTED:
        asm = a.tc_get_or_create_assessment(db, CID, who)
        for asg in TCA[who]:
            db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer, remark) VALUES (?,?,'yes','ZZ note')",
                       (asm["id"], asg))
        db.execute("UPDATE tc_assessments SET status='submitted', submitted_at=datetime('now'), overall_remark='ZZ own' "
                   "WHERE id=?", (asm["id"],))
    db.commit()


def user(i):
    with D() as db:
        return dict(db.execute("SELECT * FROM users WHERE id=?", (i,)).fetchone())


NOW = None
with D() as db:
    NOW = a._now_myt()
fmt = lambda d: d.strftime("%Y-%m-%d %H:%M")  # noqa: E731


def windows(employee_closed=True):
    """The person's own parts closed with nothing submitted (or still open), the leader's own approve windows open."""
    with D() as db:
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        emp = (fmt(NOW - timedelta(days=9)), fmt(NOW - timedelta(days=1))) if employee_closed else \
            (fmt(NOW - timedelta(days=2)), fmt(NOW + timedelta(days=3)))
        lmw = (fmt(NOW - timedelta(days=1)), fmt(NOW + timedelta(days=6)))
        for cell in ("pm_results", "tc_self"):
            db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell) + emp)
        for cell in ("pm_approve", "tc_approve"):
            db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell) + lmw)
        db.commit()


windows()
CLM = H.client_as(a, LM)
SET = lambda xs: {NAME[x] for x in xs}  # noqa: E731


# -------------------------------------------------------------------------------------------- the lists, as the LM sees
def kpi_surfaces(leader=LM):
    """Who is on each KPI list for a leader: {surface: set of tags}."""
    lu = user(leader)
    out = {}
    with D() as db:
        out["_pm_review_subject_ids"] = set(a._pm_review_subject_ids(db, lu, CID))
        out["journey team (pm_review)"] = {r["id"] for r in a._journey_team_reports(db, lu, "pm_review")}
    html = H.client_as(a, leader).get("/performance/team").get_data(as_text=True)
    out["/performance/team page"] = {x for x in ALL + [X1, X2] if "ZZ Part %s" % NAME[x] in html}
    return out


def comp_surfaces(leader=LM):
    lu = user(leader)
    out = {}
    with D() as db:
        out["_tc_reports_for"] = {r["id"] for r in a._tc_reports_for(db, leader, CID)}
        out["journey team (tm_review)"] = {r["id"] for r in a._journey_team_reports(db, lu, "tm_review")}
    r = H.client_as(a, leader).get("/technical/team")
    html = r.get_data(as_text=True)
    out["/technical/team page"] = {x for x in ALL + [X1, X2] if "ZZ Part %s" % NAME[x] in html} if r.status_code == 200 \
        else set()
    return out


def names(ids):
    return sorted(NAME.get(i, i) for i in ids)


# ================================================================================================ before anyone is out
s.section("before anyone is out of anything: C has submitted and is on every list")
ks, cs = kpi_surfaces(), comp_surfaces()
want_kpi_before = {CTL, RB, RC, RE}   # A is on a role without Performance, D is below the grade: out from the start
want_comp_before = {CTL, RA, RC, RE}
s.check("the KPI lists carry the control, B, C and E -- and not A (no Performance on their role) or D (below the grade)",
        all(v & set(ALL) == want_kpi_before for v in ks.values()), {k: names(v & set(ALL)) for k, v in ks.items()})
s.check("the competency lists carry the control, A, C and E -- and not B (no competency on their role) or D",
        all(v & set(ALL) == want_comp_before for v in cs.values()), {k: names(v & set(ALL)) for k, v in cs.items()})

# ================================================================================================ C is taken out
s.section("C is taken out on Participants after submitting: their work leaves the leader's lists too")
r = C_SU.post("/admin/participants", data={"csrf_token": "tok", "action": "remove", "ids": [str(RC), str(X2)]})
with D() as db:
    cp = {x["subject_id"]: x["mode"] for x in db.execute(
        "SELECT subject_id, mode FROM cycle_participants WHERE cycle_id=? AND subject_id IN (?,?)", (CID, RC, X2))}
    rcu = db.execute("SELECT * FROM users WHERE id=?", (RC,)).fetchone()
    sub = db.execute("SELECT status FROM tc_assessments WHERE subject_id=? AND cycle_id=?", (RC, CID)).fetchone()
    res = db.execute("SELECT COUNT(*) FROM pm_kpi_results WHERE kpi_target_id=? AND draft=0", (L1[RC],)).fetchone()[0]
    s.check("taken out through the real Participants route; their submitted work is still on file",
            cp == {RC: "remove", X2: "remove"} and a.participation(db, rcu, None, "pm") == (False, "removed")
            and sub["status"] == "submitted" and res == 1, (cp, sub and sub["status"], res))
    s.check("SQL and Python agree for every report and part (the rule behind every list)",
            all((db.execute("SELECT 1 FROM users WHERE id=? AND " + a.participant_sql("", m), (p,)).fetchone() is not None)
                == a._report_takes_part(db, p, m) for p in ALL + [X1, X2] for m in ("pm", "competency", "tm_rated")))

EXP = {  # who takes part in (pm, competency, tm_rated)
    CTL: (1, 1, 1), RA: (0, 1, 1), RB: (1, 0, 1), RC: (0, 0, 0), RD: (0, 0, 0), RE: (1, 1, 0)}
IN_KPI = {p for p in ALL if EXP[p][0]}
IN_COMP = {p for p in ALL if EXP[p][1]}
IN_360 = {p for p in ALL if EXP[p][2]}
with D() as db:
    s.check("each report takes part in exactly the parts they should (Python rule, per part)",
            all(tuple(int(a._report_takes_part(db, p, m)) for m in ("pm", "competency", "tm_rated")) == EXP[p] for p in ALL),
            {NAME[p]: tuple(int(a._report_takes_part(db, p, m)) for m in ("pm", "competency", "tm_rated")) for p in ALL})
    s.check("the refusal words are plain",
            a._report_part_refusal("pm") == "Performance isn't part of this person's review this cycle."
            and "competency review" in a._report_part_refusal("competency"))

s.section("the KPI lists: out of Performance means off the list, in the other parts means on theirs")
ks = kpi_surfaces()
for k, v in ks.items():
    s.check("%s lists exactly who takes part in Performance" % k, v & set(ALL) == IN_KPI, names(v & set(ALL)))
s.check("B stays on the KPI list (out of the competency review only); the control is on every list",
        all(RB in v and CTL in v for v in ks.values()))
ks_nx = kpi_surfaces(NX)
s.check("the second approver's list follows it too", all(v & set(ALL) == IN_KPI for v in ks_nx.values()),
        {k: names(v & set(ALL)) for k, v in ks_nx.items()})
with D() as db:
    lu, ids_all = user(LM), None
    split = a._pm_pending_split(db, lu, CID)
    s.check("what is waiting on the line manager counts who takes part, in people (the Hub's count, the dashboard)",
            split["team_pending"] == len(IN_KPI) and a._pm_pending_count(db, lu) == len(IN_KPI),
            (split, a._pm_pending_count(db, lu)))
    dt = a.dash_team(db, lu, CID)
    s.check("the dashboard's team strip counts who takes part", dt and dt["reports"] == len(IN_KPI), dt)
    kt = next((t for t in a.dash_tasks(db, lu) if t["key"] == "kpi_team"), None)
    s.check("the dashboard's 'review your team's KPI results' task counts who takes part (%d of %d)"
            % (len(IN_KPI), len(IN_KPI)),
            kt and ("%d of %d direct reports" % (len(IN_KPI), len(IN_KPI))) in kt["subtitle"], kt and kt["subtitle"])
    s.check("a behalf-pending person who is out is not waiting on the line manager",
            a._pm_behalf_pending_ids(db, lu, CID) <= IN_KPI, a._pm_behalf_pending_ids(db, lu, CID))
    s.check("the evidence ledger's authority: the line manager may review those in Performance, not those out",
            {p for p in ALL if a._pm_can_review_subject(db, lu, p)} == IN_KPI,
            names({p for p in ALL if a._pm_can_review_subject(db, lu, p)}))
    ev = H.client_as(a, LM).get("/review/team").get_data(as_text=True)
    s.check("...and the evidence Team page lists them the same",
            {p for p in ALL if "ZZ Part %s" % NAME[p] in ev} == IN_KPI, names({p for p in ALL if "ZZ Part %s" % NAME[p] in ev}))

s.section("the competency lists")
cs = comp_surfaces()
for k, v in cs.items():
    s.check("%s lists exactly who takes part in the competency review" % k, v & set(ALL) == IN_COMP, names(v & set(ALL)))
with D() as db:
    flags = a._hub_tc_flags(db, user(LM), CID)
    s.check("the hub's flag and 'submitted, waiting' count follow it (A, C and E submitted; only A and E take part)",
            flags[1] and flags[2] == len(set(SUBMITTED) & IN_COMP), flags)

s.section("the 360 the line manager reads follows the 360 part")
with D() as db:
    got = {p: a._lm_360_ready(db, CID, user(p), LM) for p in ALL}
s.check("a panel is read for those the 360 rates; for the rest there is none to see (state 'none', panel 0)",
        all((got[p]["panel"] > 0) == (p in IN_360) and (got[p]["state"] != "none") == (p in IN_360) for p in ALL),
        {NAME[p]: (got[p]["state"], got[p]["panel"]) for p in ALL})

s.section("a leader whose only reports are out: no KPI team, no competency team, no flags")
with D() as db:
    ux, un = user(LMX), user(NXO)
    s.check("the second leader (reports: an IDP user and one taken out) has no KPI list, no competency list",
            a._pm_review_subject_ids(db, ux, CID) == [] and a._tc_reports_for(db, LMX, CID) == []
            and not a._pm_manages_anyone(db, ux) and not a._hub_tc_flags(db, ux, CID)[1] and a._hub_tc_flags(db, ux, CID)[2] == 0,
            a._pm_review_subject_ids(db, ux, CID))
    ef = a._pm_entry_flags(db, ux, CID)
    efm = a._pm_entry_flags(db, user(LM), CID)
    s.check("the entry flags: in a chain still (the Career Plan's door) but no KPI team; the line manager has both",
            ef["approver"] and not ef["pm_team"] and efm["approver"] and efm["pm_team"], (ef, efm))
    doors = [d["name"] for d in a.dash_leadership(db, ux)]
    doors_lm = [d["name"] for d in a.dash_leadership(db, user(LM))]
    s.check("the Hub: no Team performance door for them, the Career Plan's team door stays; the line manager has both",
            "Team performance" not in doors and "Team development plans" in doors
            and "Team performance" in doors_lm and "Team development plans" in doors_lm, (doors, doors_lm))
    stages = {x["key"] for x in a.review_state(db, ux)["stages"]}
    stages_lm = {x["key"] for x in a.review_state(db, user(LM))["stages"]}
    s.check("the review's stages: no KPI team stage for them (and no competency one); the Career Plan's two stay",
            "pm_review" not in stages and "tm_review" not in stages and {"plan_review", "career_review"} <= stages
            and {"pm_review", "tm_review", "plan_review"} <= stages_lm, (sorted(stages), sorted(stages_lm)))
    s.check("their Performance Team page is empty (not a 403: they are still in a chain)",
            not (kpi_surfaces(LMX)["/performance/team page"] & {X1, X2}))
    nav = lambda who, path: H.client_as(a, who).get(path).get_data(as_text=True)  # noqa: E731
    s.check("the classic nav: no 'Team PM' tab for them, 'My team' on the Career Plan stays; the line manager has the tab",
            'id="nav-pm-team"' not in nav(LMX, "/performance/team") and 'id="nav-idp-team"' in nav(LMX, "/idp")
            and 'id="nav-pm-team"' in nav(LM, "/performance/team"))

s.section("the Career Plan is untouched: its lists keep every one of them")
with D() as db:
    lu = user(LM)
    idp_ids = set(a._idp_review_subject_ids(db, lu, CID))
    s.check("the Career Plan review list still carries all six (chain-driven, not gated by Performance)",
            set(ALL) <= idp_ids, names(set(ALL) - idp_ids))
    s.check("...and the reviewer test is true for each", all(a._idp_is_reviewer_of(db, lu, p, CID) for p in ALL))
    s.check("...the ungated chain list is as it was", set(ALL) <= set(a._pm_approver_subject_ids(db, lu, CID)))
    s.check("...and the second leader still reviews their IDP user's and taken-out report's plans",
            {X1, X2} <= set(a._idp_review_subject_ids(db, user(LMX), CID))
            and a._idp_is_reviewer_of(db, user(LMX), X1, CID) and a._idp_is_reviewer_of(db, user(NXO), X2, CID))
    s.check("...and the Career Plan's own participation is separate (an IDP user has a plan, and so does a taken-out person: "
            "a take-out ends their own review, not their plan, Chris 2026-11-03)",
            a.idp_participation(db, user(X1))[0] and a.idp_participation(db, user(X2)) == (True, "removed")
            and not a.is_participant(db, user(X2)))

# the Team tab at Year-End keeps the Career Plan's reviewer who approves KPI lines of a Career Plan writer, without leading them
with D() as db:
    half0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.commit()
try:
    with D() as db:
        s.check("at Year-End the second approver (no direct reports, no Performance team) keeps their Team tab for the "
                "Career Plan's review", a._is_year_end(a.active_pm_period(db)) and a._review_manages_team(db, user(NXO))
                and not a._pm_manages_anyone(db, user(NXO)), a._review_manages_team(db, user(NXO)))
finally:
    with D() as db:
        db.execute("UPDATE cycles SET half=? WHERE id=?", (half0, CID))
        db.commit()
with D() as db:
    s.check("...and in the Mid-Year, with no Career Plan review, they have none", not a._review_manages_team(db, user(NXO)))

# ================================================================================================ routes: reads
s.section("pages and read routes refuse an out report")
pages = {p: CLM.get("/performance/team/%d" % p).status_code for p in ALL}
s.check("a report's Performance page: open for who takes part, 403 for the rest",
        all((pages[p] == 200) == (p in IN_KPI) and (pages[p] in (200, 403)) for p in ALL),
        {NAME[p]: v for p, v in pages.items()})
tp = {p: CLM.get("/technical/team/%d" % p).status_code for p in ALL}
s.check("a report's competency page: open for who takes part, 403 for the rest",
        all((tp[p] == 200) == (p in IN_COMP) for p in ALL), {NAME[p]: v for p, v in tp.items()})
pv = {p: CLM.post("/performance/team/%d/moderate-preview" % p, data={"csrf_token": "tok"}).status_code for p in ALL}
s.check("the what-if preview: 200 for who takes part, 403 for the rest", all((pv[p] == 200) == (p in IN_KPI) for p in ALL),
        {NAME[p]: v for p, v in pv.items()})
sm = {p: CLM.post("/review/team/pm-summary", data={"csrf_token": "tok", "report": p}).status_code for p in ALL}
s.check("the KPI summary route: not found for who is out of Performance", all((sm[p] == 404) != (p in IN_KPI) for p in ALL),
        {NAME[p]: v for p, v in sm.items()})
tm = {p: CLM.post("/review/team/tm-summary", data={"csrf_token": "tok", "report": p}).status_code for p in ALL}
s.check("the competency summary route: not found for who is out of the competency review",
        all((tm[p] == 404) != (p in IN_COMP) for p in ALL), {NAME[p]: v for p, v in tm.items()})
for kind, inn in (("pm", IN_KPI), ("tm", IN_COMP)):
    j = CLM.post("/review/team/insights", data={"csrf_token": "tok", "kind": kind,
                                                 "ids": ",".join(str(p) for p in ALL)}).get_json() or {}
    got_ids = {int(k) for k in (j.get("items") or {})}
    s.check("the insights batch (%s) answers only for who takes part" % kind, got_ids == inn, names(got_ids))
tm360 = {}
# the 360 route: readiness stubbed to 'detail' so only the route's OWN gate separates them (defence in depth)
_real = {k: getattr(a, k) for k in ("_lm_360_ready", "cycle_has_potential", "subject_result", "_lm_360_principles",
                                      "feedback_overall_remarks", "max_score_for_grade")}
a._lm_360_ready = lambda db, cid, subject, viewer: {"state": "detail", "submitted": 4, "closed_disp": "closed"}
a.cycle_has_potential = lambda db, cid: True
a.subject_result = lambda db, rep, cid: {"avg_score": 3.0}
a._lm_360_principles = lambda db, rep, cid: ([], [], [])
a.feedback_overall_remarks = lambda *x, **k: []
a.max_score_for_grade = lambda *x, **k: 5
try:
    for p in ALL:
        tm360[p] = CLM.post("/review/team/tm-360", data={"csrf_token": "tok", "report": p}).status_code
finally:
    for k, v in _real.items():
        setattr(a, k, v)
s.check("the line manager's 360 detail route has its own gate: refused (404) for who the 360 doesn't rate, even when "
        "readiness said detail", all((tm360[p] == 200) == (p in IN_360 and p in IN_COMP) for p in ALL)
        and tm360[RE] == 404, {NAME[p]: v for p, v in tm360.items()})
with D() as db:
    card = {p: a._journey_team_pm_data(db, user(LM), p, "x") for p in ALL}
    s.check("the review card's KPI table is empty for who is out of Performance",
            all(bool(card[p]["lines"]) == (p in IN_KPI) for p in ALL), {NAME[p]: len(card[p]["lines"]) for p in ALL})
    s.check("'Didn't submit' is only for who the part was theirs to do (their closed check-in / self-assessment)",
            all(a._behalf_part_closed(db, "pm_results", CID, p) == (p in IN_KPI)
                and a._behalf_part_closed(db, "tc_self", CID, p) == (p in IN_COMP) for p in ALL))


# ================================================================================================ writers: KPI
def err_words(err):
    return (err or {}).get("msg") or ""


s.section("on behalf (KPI): the control can; the rest are refused with the words, and nothing is written")
with D() as db:
    lu = user(LM)
    states = {p: a._pm_behalf_state(db, lu, p) for p in ALL}
s.check("the gate: open for who takes part (one line to assess), closed with the words for the rest",
        all((len(states[p][0]) == 1 and states[p][1] is None) == (p in IN_KPI) for p in ALL)
        and all(states[p][1] == a._report_part_refusal("pm") and states[p][0] == [] for p in ALL if p not in IN_KPI),
        {NAME[p]: (len(v[0]), v[1]) for p, v in states.items()})
res = {}
with D() as db:
    lu = user(LM)
    for p in ALL:
        res[p] = a._pm_behalf_draft(db, lu, p, L2[p], "3")
s.check("a figure is drafted for who takes part; refused for the rest",
        all((res[p][1] is None) == (p in IN_KPI) for p in ALL) and all(
            res[p][1]["reason"] == "closed" and "isn't part" in err_words(res[p][1]) for p in ALL if p not in IN_KPI),
        {NAME[p]: (res[p][1] or {}).get("msg") for p in ALL})
with D() as db:
    drafts = {p: db.execute("SELECT COUNT(*) FROM pm_kpi_moderation_drafts WHERE kpi_target_id=? AND approver_id=?",
                            (L2[p], LM)).fetchone()[0] for p in ALL}
s.check("...and only who takes part has a draft stored", all((drafts[p] == 1) == (p in IN_KPI) for p in ALL), drafts)
rr = {p: CLM.post("/review/team/behalf/pm", data={"report_id": p, "kpi_target_id": L2[p], "value": "4",
                                                    "csrf_token": "tok"}) for p in ALL}
s.check("the route answers the same: 200 who takes part, 409 and not ok for the rest",
        all((rr[p].status_code == 200) == (p in IN_KPI) for p in ALL)
        and all(rr[p].status_code == 409 and not rr[p].get_json()["ok"] for p in ALL if p not in IN_KPI),
        {NAME[p]: rr[p].status_code for p in ALL})

s.section("the line manager's remark on a report (the why): same")
rm = {p: CLM.post("/performance/team/%d/remark-autosave" % p, data={"csrf_token": "tok", "remark": "ZZ based on the records"})
      for p in ALL}
s.check("the remark route saves for who takes part, 403 for the rest (and writes nothing)",
        all((rm[p].status_code == 200) == (p in IN_KPI) for p in ALL)
        and all(rm[p].status_code == 403 for p in ALL if p not in IN_KPI), {NAME[p]: rm[p].status_code for p in ALL})
with D() as db:
    lu = user(LM)
    tool = {p: a._mgr_tool_set_report_remark(db, lu, CID, p, {"remark": "ZZ via the chat"}) for p in ALL}
    stored = {p: db.execute("SELECT COUNT(*) FROM pm_manager_remarks WHERE cycle_id=? AND subject_id=? AND submitted_by=?",
                            (CID, p, LM)).fetchone()[0] for p in ALL}
s.check("the chat tool too: ok for who takes part, an error with the words for the rest; only they have a remark stored",
        all(tool[p]["ok"] == (p in IN_KPI) for p in ALL) and all("isn't part" in tool[p]["error"] for p in ALL if p not in IN_KPI)
        and all((stored[p] == 1) == (p in IN_KPI) for p in ALL), (tool, stored))
with D() as db:
    ai = {p: CLM.post("/performance/team/%d/remark-draft-ai" % p, data={"csrf_token": "tok"}).status_code for p in ALL}
s.check("'Draft with AI' for the remark is not offered for who is out (403)",
        all((ai[p] == 403) == (p not in IN_KPI) for p in ALL), {NAME[p]: v for p, v in ai.items()})
aj = {p: CLM.post("/performance/kpi/%d/justification-draft-ai" % L1[p], data={"csrf_token": "tok"}).status_code for p in ALL}
s.check("...nor the per-line justification draft (409 with the words)",
        all((aj[p] == 409) == (p not in IN_KPI) for p in ALL), {NAME[p]: v for p, v in aj.items()})

s.section("on behalf: confirm")
with D() as db:
    lu = user(LM)
    commit = {p: a._pm_behalf_commit(db, lu, p) for p in (CTL, RB, RA, RC, RD)}
s.check("confirming writes the line manager's figure for who takes part; refused for the rest",
        all((commit[p][1] is None) == (p in IN_KPI) for p in commit)
        and all(commit[p][1]["reason"] == "closed" and "isn't part" in err_words(commit[p][1])
                for p in commit if p not in IN_KPI), {NAME[p]: commit[p][1] for p in commit})
rc = CLM.post("/review/team/behalf/pm", data={"report_id": RE, "op": "confirm", "csrf_token": "tok"})
s.check("...the confirm route for the one left (E, who takes part in Performance)", rc.status_code == 200
        and rc.get_json()["ok"], (rc.status_code, rc.get_json()))
with D() as db:
    ob = {p: db.execute("SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=? AND on_behalf=1", (L2[p],)).fetchone()[0]
          for p in ALL}
s.check("...so only who takes part has a step on behalf in the database", all((ob[p] == 1) == (p in IN_KPI) for p in ALL), ob)

s.section("moderating a submitted line: draft, lock, the chat tools, the routes, the bulk approve")
with D() as db:
    lu = user(LM)
    md = {p: a._pm_moderate_draft(db, lu, L1[p], "", None) for p in ALL}
s.check("a moderation draft for a submitted line: for who takes part; refused with the words for the rest",
        all((md[p][1] is None) == (p in IN_KPI) for p in ALL)
        and all(md[p][1]["reason"] == "not_actionable" and "isn't part" in err_words(md[p][1])
                for p in ALL if p not in IN_KPI), {NAME[p]: (md[p][1] or {}).get("msg") for p in ALL})
dr = {p: CLM.post("/performance/kpi/%d/moderate-draft-autosave" % L1[p],
                  data={"csrf_token": "tok", "adjusted_value": "", "justification": ""}).status_code for p in ALL}
s.check("the draft route: 200 who takes part, 409 for the rest", all((dr[p] == 200) == (p in IN_KPI) for p in ALL), dr)
with D() as db:
    lu = user(LM)
    tmod = {p: a._mgr_tool_moderate_kpi(db, lu, CID, p, {"kpi_id": L1[p], "value": 3}) for p in ALL}
s.check("the chat tool that drafts a moderated value: ok for who takes part, an error for the rest",
        all(tmod[p]["ok"] == (p in IN_KPI) for p in ALL), {NAME[p]: tmod[p].get("error") for p in ALL})
with D() as db:
    lu = user(LM)
    tlock = {p: a._mgr_tool_lock_kpi(db, lu, CID, p, {"kpi_id": L1[p]}) for p in (CTL, RA, RC, RD)}
s.check("the chat lock tool: locks the control's line, refuses A, C and D (the line stays unlocked)",
        tlock[CTL]["ok"] and not tlock[RA]["ok"] and not tlock[RC]["ok"] and not tlock[RD]["ok"]
        and all("isn't part" in tlock[p]["error"] for p in (RA, RC, RD)), tlock)
rl = CLM.post("/performance/kpi/%d/moderate-autosave" % L1[RB], data={"csrf_token": "tok", "adjusted_value": ""})
s.check("the lock route locks B's line (B takes part in Performance)", rl.status_code == 200 and rl.get_json()["ok"],
        (rl.status_code, rl.get_json()))
for p in (RA, RC, RD):
    r_ = CLM.post("/performance/kpi/%d/moderate-autosave" % L1[p], data={"csrf_token": "tok", "adjusted_value": ""})
    s.check("the lock route refuses %s (409 with the words)" % NAME[p], r_.status_code == 409 and not r_.get_json()["ok"]
            and "isn't part" in r_.get_json()["error"], (r_.status_code, r_.get_json()))
rb = CLM.post("/review/team/approve-bulk", data={"csrf_token": "tok", "stage": "pm_review", "report_ids": [str(p) for p in ALL]})
bj = {x["report_id"]: x for x in (rb.get_json() or {}).get("results", [])}
s.check("the bulk approve: reports who take part are processed, the rest answer 'not yours'",
        rb.status_code == 200 and all(("error" in bj[p] and bj[p]["error"] == "not yours") == (p not in IN_KPI) for p in ALL),
        {NAME[p]: bj.get(p) for p in ALL})
with D() as db:
    locked = {p: db.execute("SELECT COUNT(*) FROM pm_kpi_approvals WHERE kpi_target_id=? AND on_behalf=0", (L1[p],)).fetchone()[0]
              for p in ALL}
s.check("...every line of who takes part is locked now (the control by the chat tool, B by the route, E by the bulk) "
        "and not one line of the rest", all((locked[p] == 1) == (p in IN_KPI) for p in ALL), locked)

# ================================================================================================ writers: competency
s.section("competency, on behalf (their self-assessment closed unsubmitted): the control can; the rest are refused")
with D() as db:
    lu = user(LM)
    st = {p: a._tc_behalf_state(db, lu, CID, p) for p in (CTL, RB, RD)}
s.check("the gate: open for the control (None); the sentence for B and D (out of the competency review)",
        st[CTL] is None and st[RB] == a._report_part_refusal("competency") and st[RD] == a._report_part_refusal("competency"),
        st)
with D() as db:
    lu = user(LM)
    ov = {p: a._tc_override_one(db, lu, CID, p, TCA[p][0], "no", "") for p in (CTL, RB, RD)}
s.check("setting a level on behalf: the control's is written; B and D are refused (403, with the words)",
        ov[CTL][1] is None and all(ov[p][1] and ov[p][1]["reason"] == "forbidden" and "isn't part" in err_words(ov[p][1])
                                   for p in (RB, RD)), {NAME[p]: ov[p][1] for p in ov})
rt = {p: CLM.post("/technical/team/%d/autosave" % p, data={"csrf_token": "tok", "assignment_id": TCA[p][1],
                                                            "manager_answer": "no"}).status_code for p in (CTL, RB, RD)}
s.check("the route: 200 for the control, 403 for B and D", rt[CTL] == 200 and rt[RB] == 403 and rt[RD] == 403, rt)
with D() as db:
    lu = user(LM)
    tc_t = {p: a._mgr_tool_set_competency(db, lu, CID, p, {"assignment_id": TCA[p][0], "answer": "developing"})
            for p in (RB, RD)}
s.check("the chat tool refuses B and D", not any(v["ok"] for v in tc_t.values()), tc_t)
    # the remark first, then approve
with D() as db:
    lu = user(LM)
    rk = {p: a._tc_manager_remark_write(db, lu, CID, p, "ZZ solid on the basics") for p in (CTL, RB, RD)}
s.check("the competency remark: written for the control, refused for B and D",
        rk[CTL][1] is None and rk[RB][1] and rk[RD][1] and "isn't part" in err_words(rk[RB][1]), {NAME[p]: rk[p][1] for p in rk})
rrk = {p: CLM.post("/technical/team/%d/overall-autosave" % p, data={"csrf_token": "tok", "manager_remark": "ZZ route"}).status_code
       for p in (RB, RD)}
s.check("...the remark route: 403 for B and D", rrk == {RB: 403, RD: 403}, rrk)
with D() as db:
    lu = user(LM)
    ap = {p: a._tc_approve_assessment(db, lu, CID, p) for p in (CTL, RB, RD)}
s.check("approving on behalf: the control's is approved (flagged on behalf); B and D are refused",
        ap[CTL][1] is None and ap[CTL][0].get("on_behalf") and ap[RB][1] and ap[RD][1]
        and ap[RB][1]["reason"] == "forbidden", {NAME[p]: ap[p][1] for p in ap})
with D() as db:
    row = {p: db.execute("SELECT status, on_behalf FROM tc_assessments WHERE subject_id=? AND cycle_id=?", (p, CID)).fetchone()
           for p in (CTL, RB, RD)}
    mans = {p: db.execute("SELECT COUNT(*) FROM tc_scores s JOIN tc_assessments x ON x.id=s.assessment_id WHERE "
                          "x.subject_id=? AND x.cycle_id=? AND s.manager_answer IS NOT NULL", (p, CID)).fetchone()[0]
            for p in (CTL, RB, RD)}
s.check("...and in the database only the control's assessment moved (reviewed, on behalf); B and D have none of the "
        "line manager's levels", row[CTL]["status"] == "reviewed" and row[CTL]["on_behalf"] == 1
        and (row[RB] is None or row[RB]["status"] != "reviewed") and (row[RD] is None or row[RD]["status"] != "reviewed")
        and mans[RB] == 0 and mans[RD] == 0, (dict(row[CTL]), mans))

s.section("competency, submitted: A and E (in) are reviewed; C (out, submitted before they were taken out) is refused")
with D() as db:
    lu = user(LM)
    ovs = {p: a._tc_override_one(db, lu, CID, p, TCA[p][0], "no", "") for p in (RA, RE, RC)}
s.check("a level: set for A and E; refused for C -- their submission leaves the leader's review with them",
        ovs[RA][1] is None and ovs[RE][1] is None and ovs[RC][1] and ovs[RC][1]["reason"] == "forbidden"
        and "isn't part" in err_words(ovs[RC][1]), {NAME[p]: ovs[p][1] for p in ovs})
rt = CLM.post("/technical/team/%d/autosave" % RC, data={"csrf_token": "tok", "assignment_id": TCA[RC][1],
                                                         "manager_answer": "no"})
s.check("the route for C: 403", rt.status_code == 403, rt.status_code)
with D() as db:
    lu = user(LM)
    for p in (RA, RE):
        a._tc_override_one(db, lu, CID, p, TCA[p][1], "yes", "")
    for p in (RA, RE):
        a._tc_manager_remark_write(db, lu, CID, p, "ZZ solid on the basics")
    apc = a._tc_approve_assessment(db, lu, CID, RC)
    tool_ap = a._mgr_tool_approve_competencies(db, lu, CID, RC, {})
s.check("approving C is refused (function and chat tool)", apc[1] and apc[1]["reason"] == "forbidden"
        and not tool_ap["ok"] and "isn't part" in tool_ap["error"], (apc[1], tool_ap))
rap = CLM.post("/technical/team/%d/approve" % RA, data={"csrf_token": "tok"})
s.check("approving A through the route works", rap.status_code in (200, 302) and (rap.get_json() or {"ok": True}).get("ok", True),
        (rap.status_code, rap.get_data(as_text=True)[:120]))
rbk = CLM.post("/review/team/approve-bulk", data={"csrf_token": "tok", "stage": "tm_review", "report_ids": [str(p) for p in ALL]})
bj = {x["report_id"]: x for x in (rbk.get_json() or {}).get("results", [])}
s.check("the bulk approve (competencies): the reports out of the competency review answer 'not yours'; the rest are processed",
        rbk.status_code == 200 and all((bj[p].get("error") == "not yours") == (p not in IN_COMP) for p in ALL),
        {NAME[p]: bj.get(p) for p in ALL})
with D() as db:
    rs = {p: (db.execute("SELECT status FROM tc_assessments WHERE subject_id=? AND cycle_id=?", (p, CID)).fetchone() or {"status": None})["status"]
          for p in ALL}
s.check("...A and E are reviewed now; C is still only submitted (their review stayed with nobody)",
        rs[RA] == "reviewed" and rs[RE] == "reviewed" and rs[RC] == "submitted", rs)

# ================================================================================================ defence in depth
s.section("with the list gates forced open, the writers still refuse (each has its own gate)")
real_tc, real_bs = a._tc_reports_for, a._pm_behalf_state
a._tc_reports_for = lambda db, m, c: [{"id": p} for p in ALL]
try:
    with D() as db:
        lu = user(LM)
        # reset C and D's assessments' windows etc. are untouched; D has no assessment yet (behalf mode), C submitted
        o1 = a._tc_override_one(db, lu, CID, RC, TCA[RC][1], "yes", "")
        o2 = a._tc_override_one(db, lu, CID, RD, TCA[RD][1], "yes", "")
        o3 = a._tc_approve_assessment(db, lu, CID, RC)
        o4 = a._tc_approve_assessment(db, lu, CID, RD)
        o5 = a._tc_manager_remark_write(db, lu, CID, RD, "ZZ force")
        o6 = a._tc_manager_remark_write(db, lu, CID, RC, "ZZ force")
        beh = a._tc_behalf_state(db, lu, CID, RD)
    s.check("competency override, approve and remark each refuse an out report on their own gate (even if the list let them in)",
            all(o and o[1] and o[1]["reason"] == "forbidden" and "isn't part" in err_words(o[1]) for o in (o1, o2, o3, o4, o5, o6))
            and beh == a._report_part_refusal("competency"), [o[1] for o in (o1, o2, o3, o4, o5, o6)])
    # the KPI side: the same, with the per-person behalf gate forced open -- the candidate SQL has its own gate
    a._pm_behalf_state = lambda db, u, sid, period=None: ([{"id": 0}], None)
    with D() as db:
        waiting = a._pm_behalf_pending_ids(db, user(LM), CID)
    s.check("the people waiting on the line manager to be assessed on their behalf never include who is out of "
            "Performance (their candidate SQL has its own gate)", not (waiting & {RA, RC, RD}), names(waiting))
finally:
    a._tc_reports_for, a._pm_behalf_state = real_tc, real_bs

s.section("the background reader works only for who takes part")
_sw = {k: getattr(a, k) for k in ("_prerun_switch_on", "_prerun_job_busy", "_pm_perf_summary_for")}
a._prerun_switch_on = lambda kind: True
a._prerun_job_busy = lambda *x, **k: False
a._pm_perf_summary_for = lambda *x, **k: {}
try:
    with D() as db:
        out = {p: a._prerun_run(db, {"kind": "pm_lm", "subject_id": p, "cycle_id": CID, "tier": "", "viewer_id": LM,
                                     "scope_key": ""}) for p in ALL}
finally:
    for k, v in _sw.items():
        setattr(a, k, v)
s.check("the KPI reading job (pm_lm) is skipped for who is out of Performance, run for who takes part",
        all((out[p] == "skip") != (p in IN_KPI) for p in ALL), {NAME[p]: v for p, v in out.items()})

# ================================================================================================ wording and the map
s.section("the shared function, and its guards")
src = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
s.check("one helper for the one-person rule, defined once", src.count("def _report_takes_part(") == 1
        and src.count("def _pm_review_subject_ids(") == 1)
s.check("the Career Plan's lists do not call it: _idp_review_subject_ids and idp_participant_sql are untouched",
        "_report_takes_part" not in src[src.index("def _idp_review_subject_ids"):src.index("def _idp_is_reviewer_of")]
        and "_pm_review_subject_ids" not in src[src.index("def _idp_review_subject_ids"):src.index("def _idp_is_reviewer_of")])

_FINISHED = True
sys.exit(s.done())
