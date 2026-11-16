"""The BG CEO's agent reads a person's profile when asked (Chris, 2026-10-22: "give the BG CEO's agent each person's
joined date, years of service and confirmation date when asked, like the BU CEO's agent has", then "please ensure this
only work for CEO and not the other role").

  * person_profile{subject}: one person's profile facts (the BU CEO's prompt's fields), someone in the BG CEO's own
    scope only, through the Talent Box's dispatcher
  * the BG CEO tier only: a BU CEO, an HOD, a Group Chief or a line manager's tier gets "unknown tool"
  * the BG CEO's Talent Box prompt names it with its rule; the Group Chief's does not
  * its result fits the leader loop's room, and no page draws it

Writes, so a fresh copy, put back at the end.
"""
import inspect
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("The BG CEO's agent: a person's profile when asked, the BG CEO only")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
JS = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
SRC = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()

with a.app.test_request_context("/"):
    db = a.get_db()
    P1, P2 = [r["id"] for r in db.execute(
        "SELECT id FROM users WHERE role!='admin' AND left_at IS NULL AND manager_id IS NOT NULL ORDER BY id LIMIT 2")]
    db.execute("UPDATE users SET joined_date='2021-03-01', confirmation_date='2021-06-01', years_of_service=5.6 "
               "WHERE id=?", (P1,))
    db.commit()
    sub1 = dict(db.execute("SELECT * FROM users WHERE id=?", (P1,)).fetchone())
    lm = db.execute("SELECT full_name FROM users WHERE id=?", (sub1["manager_id"],)).fetchone()[0]
    ctx = {"population": [sub1]}
    t_bg = a._person_profile_tool(db, "bgceo", ctx, {"subject": P1})
    t_name = a._person_profile_tool(db, "bgceo", ctx, {"subject": sub1["full_name"]})
    others = {t: a._person_profile_tool(db, t, ctx, {"subject": P1}) for t in ("buceo", "hod", "group", "lm", None)}
    t_out = a._person_profile_tool(db, "bgceo", ctx, {"subject": P2})
    # a manager with a direct report, and someone else to stand in for the people under review
    M = db.execute("SELECT manager_id FROM users WHERE manager_id IS NOT NULL AND left_at IS NULL "
                   "GROUP BY manager_id ORDER BY manager_id LIMIT 1").fetchone()[0]
    MU = dict(db.execute("SELECT * FROM users WHERE id=?", (M,)).fetchone())
    DR = [r[0] for r in db.execute("SELECT full_name FROM users WHERE manager_id=? AND left_at IS NULL", (M,))]
    OTHER = db.execute("SELECT id, full_name FROM users WHERE (manager_id IS NULL OR manager_id<>?) AND id<>? AND "
                       "left_at IS NULL ORDER BY id LIMIT 1", (M, M)).fetchone()
    team_view = [x["name"] for x in a._journey_team_profiles(db, MU, [OTHER[0]])]
    leader_view = [x["name"] for x in a._journey_team_profiles(db, MU, [OTHER[0]], with_direct=False)]

s.section("the BG CEO reads one person's profile, in their own scope")
pf = t_bg.get("profile") or {}
s.check("joined date, confirmation date and years of service, as on record",
        t_bg.get("ok") and pf.get("joined") == "2021-03-01" and pf.get("confirmed") == "2021-06-01"
        and pf.get("years_of_service") == 5.6, pf)
s.check("...and the rest of what the BU CEO's prompt lists: name, role, grade, department, company, line manager",
        pf.get("name") == sub1["full_name"] and pf.get("line_manager") == lm
        and set(pf) <= {lab for _c, lab in a._TEAM_PROFILE_FIELDS}, sorted(pf))
s.check("by name too", t_name == t_bg)
s.check("someone outside their scope is refused", not t_out.get("ok"), t_out)
s.check("the result fits the leader loop's room (900 characters)", len(json.dumps(t_bg)) < 900, len(json.dumps(t_bg)))

s.section("the BG CEO only (Chris: \"only work for CEO and not the other role\")")
s.check("a BU CEO, an HOD, a Group Chief, a line manager or no tier: unknown tool",
        all(v == {"ok": False, "error": "unknown tool"} for v in others.values()), others)
s.check("the tier list is the BG CEO's alone", a._PROFILE_TOOL_TIERS == ("bgceo",))
s.check("served through the Talent Box's dispatcher, registered with its tools",
        'if tool == "person_profile":' in inspect.getsource(a._tb_run_tool) and "person_profile" in a._TB_TOOLS)
s.check("the calibration dispatchers don't serve it (the BU CEO's prompt already lists its people's profiles)",
        "person_profile" not in inspect.getsource(a._calib_run_tool)
        and "person_profile" not in inspect.getsource(a._pot_calib_run_tool))

s.section("a leader view reads only the people under review (Chris: \"BUCEO will be able to call for the BU people only\")")
s.check("the Team view: the people under review plus the line manager's direct reports",
        OTHER[1] in team_view and DR and all(n in team_view for n in DR), (len(team_view), len(DR)))
s.check("a leader view (HOD, BU CEO, Talent Box): the people under review only, no direct report outside them",
        leader_view == [OTHER[1]], leader_view)
s.check("direct reports join only in the Team view's own parts",
        a._TEAM_DIRECT_STAGES == ("pm_review", "tm_review", "plan_review")
        and "with_direct=active_stage in _TEAM_DIRECT_STAGES" in inspect.getsource(a._journey_team_agent_system))

s.section("the agent is told when to use it; the Group Chief's isn't")
s.check("the BG CEO's Talent Box prompt names the tool and its rule",
        "person_profile{subject}" in inspect.getsource(a._talent_box_system)
        and "_PROFILE_TOOL_BRIEF" in inspect.getsource(a._talent_box_system)
        and "joined or confirmation date, years of service" in a._PROFILE_TOOL_BRIEF)
s.check("the Group Chief's prompt doesn't", "person_profile" not in inspect.getsource(a._tb_group_system))
_tas = inspect.getsource(a._journey_team_agent_system)
s.check("on the Talent Box the profiles section points to the tool, never an empty list (read as \"not allowed\")",
        'if active_stage == "talent_box" and (_journey_talent_box_scope(db, u) or ("",))[0] in _PROFILE_TOOL_TIERS' in _tas
        and "call person_profile{subject} and answer from it" in _tas)
s.check("the leader loop gives it 900 characters",
        '_room = 900 if tool in ("open_person", "past_talent", "person_profile") else 400' in SRC)
s.check("no page draws it", "person_profile" not in JS)

H.restore_db()
sys.exit(s.done())
