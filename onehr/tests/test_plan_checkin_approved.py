"""An approved Career Plan takes check-ins between cycles, through its year (Chris, 2026-10-24: "Yes, through its
year"). The 2026-10-24 developer handoff (12.2) found that Approve plan closes the plan (pm_idp_close) while the panel's
check-in (POST /me/plan/checkin) took a shared plan only, so every plan a line manager approved refused its check-ins
for good: "This plan is closed."

What this suite holds (plan_takes_checkins, one rule for the route, the panel and the dashboard's card):
  * the lifecycle: a line manager approves the plan while the Year-End runs; a check-in then is refused because the
    cycle runs (not because the plan is closed); once their results are released it saves, on the approved plan
  * the panel and the card say Approved, take check-ins, and say "paused" while the cycle runs
  * once a plan's year is over (last year's plan, approved or only shared) it is the record: refused, read-only
  * a draft and a plan closed without being shared are still refused; another person's goal still 404s
  * the client: paused before read-only, the year-over note, the remark shows "once your plan is approved"
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Career Plan check-ins on an approved plan, through its year")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG, CO = "ZZPC Group", "ZZPC U1"
FETCH = {"X-Requested-With": "fetch"}


def post(client, url, headers=None, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form, headers=headers or {})


def checkin(client, goal, status="in_progress", note="ZZPC shadowed the Q1 costing"):
    r = post(client, "/me/plan/checkin", goal_id=str(goal), status=status, note=note)
    return r.status_code, (r.get_json() or {})


def n_checkins(goal):
    return H.one(a, "SELECT COUNT(*) FROM pm_idp_checkins WHERE goal_id=?", (goal,))


def panel(client, year):
    return (client.get("/me/plan?year=%d" % year).get_json() or {}).get("plan") or {}


with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    NOW = a._today_myt().year
    # the Year-End of this year, running, its plan review open (no dates): the plan it reviews is next year's
    db.execute("UPDATE cycles SET kind='year_end', half=2, year=?, min_job_grade=12, open_by_date=0, "
               "starts_on='2026-01-01 00:00' WHERE id=?", (NOW, CID))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='idp_review'", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','evidence','pm','tm','idp')",
               (CID,))
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', '1')")
    db.commit()
    YR = a.pm_idp_plan_year(a.active_pm_period(db))

    def mk(eid, mgr=None):
        return db.execute(
            "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_title, job_grade, manager_id, confirmation_date, years_of_service) "
            "VALUES (?,?,'x','user',?,?,?,'ZZPC Dept','ZZPC Officer','14',?,'2020-01-01',4.0)",
            (eid.lower(), "ZZ PC " + eid[-2:], eid, BG, CO, mgr)).lastrowid

    def plan(sid, year, status, shared=True, area="ZZPC Cost Analysis"):
        iid = db.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status, shared_at, closed_at) "
                         "VALUES (?,?,?,?,?,?)", (year, CID, sid, status,
                                                  "%d-11-20 03:00:00" % (year - 1) if shared else None,
                                                  "%d-11-25 03:00:00" % (year - 1) if status == "closed" else None)
                         ).lastrowid
        return iid, db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, action_experience, target_date) "
                               "VALUES (?,1,?,'Build the quarterly breakdown',?)",
                               (iid, area, "%d-06-30" % year)).lastrowid
    LM = mk("ZZ9PC-LM")
    ME = mk("ZZ9PC-ME", mgr=LM)       # the plan the line manager approves, plus last year's (approved) and older (shared)
    DR = mk("ZZ9PC-DR", mgr=LM)       # a draft
    CU = mk("ZZ9PC-CU", mgr=LM)       # a plan closed without ever being shared (the old close of a draft)
    OT = mk("ZZ9PC-OT")               # someone else
    IDP_A, G_A = plan(ME, YR, "shared")
    IDP_P, G_P = plan(ME, NOW - 1, "closed", area="ZZPC Last year's goal")
    IDP_S, G_S = plan(ME, NOW - 2, "shared", area="ZZPC Older shared goal")
    _d, G_D = plan(DR, YR, "draft", shared=False)
    _c, G_C = plan(CU, YR, "closed", shared=False)
    db.commit()

E, L, O = H.client_as(a, ME), H.client_as(a, LM), H.client_as(a, OT)

s.section("the rule: plan_takes_checkins")
T = a.plan_takes_checkins
SA = "2026-11-20 03:00:00"
cases = [(("shared", SA, NOW + 1), True), (("closed", SA, NOW + 1), True), (("closed", SA, NOW), True),
         (("shared", None, NOW), True), (("closed", SA, NOW - 1), False), (("shared", SA, NOW - 1), False),
         (("draft", None, NOW + 1), False), (("closed", None, NOW + 1), False), ((None, None, NOW + 1), False),
         (("closed", SA, None), True), (("closed", None, None), False)]
bad = [(c, want, T(*c)) for c, want in cases if T(*c) is not want]
s.check("shared or approved through its year; never a draft, a plan closed unshared, or a past year's plan", not bad, bad)

s.section("the lifecycle: approved during the Year-End, checked in on once their results are released")
r = post(L, "/review/team/idp-remark", report=str(ME), remark="A clear plan: costing builds on a strength.")
s.check("the line manager writes the remark", r.status_code == 200, r.status_code)
r = post(L, "/idp/team/%d/career-conversation" % ME, headers=FETCH)
s.check("...and approves the plan: it is closed, as approval does",
        r.status_code == 200 and H.one(a, "SELECT status FROM pm_idp WHERE id=?", (IDP_A,)) == "closed", r.status_code)
with a.app.test_request_context("/"):
    s.check("the cycle runs and nothing of theirs is released: check-ins wait",
            a.plan_checkin_open(a.get_db(), {"id": ME}) is False)
n0 = n_checkins(G_A)
code, j = checkin(E, G_A)
s.check("a check-in now is refused because the cycle runs, never because the plan is approved",
        code == 409 and "between cycles" in (j.get("error") or "") and "closed" not in (j.get("error") or "")
        and n_checkins(G_A) == n0, (code, j.get("error")))
p = panel(E, YR)
s.check("...the panel: Approved, paused (no Check in), not read-only",
        p.get("status_label") == "Approved" and p.get("can_checkin") is False and p.get("checkin_paused") is True
        and not p.get("checkin_ended"), {k: p.get(k) for k in ("status_label", "can_checkin", "checkin_paused")})
with a.app.app_context():
    db = a.get_db()
    db.execute("INSERT INTO result_releases(cycle_id, subject_id, kind, released_at) VALUES (?,?,'pm',datetime('now'))",
               (CID, ME))
    db.commit()
code, j = checkin(E, G_A)
g = next((x for x in ((j.get("panel") or {}).get("plan") or {}).get("goals", []) if x.get("id") == G_A), {})
s.check("released: the check-in on the APPROVED plan saves (200) and answers with the panel",
        code == 200 and j.get("ok") is True and (j.get("panel") or {}).get("year") == YR, (code, j.get("error")))
s.check("...one dated row more, the goal now In progress with the note",
        n_checkins(G_A) == n0 + 1 and g.get("status") == "in_progress"
        and (g.get("checkins") or [{}])[0].get("note") == "ZZPC shadowed the Q1 costing", g)
s.check("...the plan's words are untouched (a check-in never edits the agreed plan)",
        H.one(a, "SELECT area || '|' || action_experience FROM pm_idp_goals WHERE id=?", (G_A,))
        == "ZZPC Cost Analysis|Build the quarterly breakdown")
s.check("...and it stays approved", H.one(a, "SELECT status FROM pm_idp WHERE id=?", (IDP_A,)) == "closed")
p = panel(E, YR)
s.check("the panel: Approved, Check in on, when the last one was",
        p.get("status_label") == "Approved" and p.get("can_checkin") is True and bool(p.get("last_checkin")),
        {k: p.get(k) for k in ("status_label", "can_checkin", "last_checkin")})
with a.app.test_request_context("/"):
    db = a.get_db()
    a.g.user = db.execute("SELECT * FROM users WHERE id=?", (ME,)).fetchone()
    card = a.dash_plan_card(db, a.g.user)
s.check("the dashboard's plan card: this plan, 'approved', with its Check in",
        card and card["year"] == YR and card["status_word"] == "approved" and card["can_checkin"] is True,
        card and {k: card.get(k) for k in ("year", "status_word", "can_checkin")})

s.section("once its year is over, the plan is the record")
for goal, year, what in ((G_P, NOW - 1, "last year's APPROVED plan"), (G_S, NOW - 2, "an older plan only SHARED")):
    n1 = n_checkins(goal)
    code, j = checkin(E, goal)
    s.check("%s: refused (409), its year named, nothing written" % what,
            code == 409 and "year is over" in (j.get("error") or "") and str(year) in (j.get("error") or "")
            and n_checkins(goal) == n1, (code, j.get("error")))
    p = panel(E, year)
    s.check("...the panel: read-only because its year is over (no Check in, not paused)",
            p.get("can_checkin") is False and not p.get("checkin_paused") and p.get("checkin_ended") is True,
            {k: p.get(k) for k in ("status_label", "can_checkin", "checkin_paused", "checkin_ended")})
s.check("last year's approved plan still reads Approved", panel(E, NOW - 1).get("status_label") == "Approved")

s.section("still refused: a draft, a plan closed unshared, another person's goal")
code, j = checkin(H.client_as(a, DR), G_D)
s.check("a draft: 409, share it first", code == 409 and "Share your plan" in (j.get("error") or ""), (code, j))
code, j = checkin(H.client_as(a, CU), G_C)
s.check("a plan closed without being shared: 409, closed", code == 409 and j.get("error") == "This plan is closed.",
        (code, j))
p = panel(H.client_as(a, CU), YR)
s.check("...its panel reads Closed, not Approved, and takes none", p.get("status_label") == "Closed"
        and p.get("can_checkin") is False and not p.get("checkin_paused") and not p.get("checkin_ended"), p.get("status_label"))
n2 = n_checkins(G_A)
r = post(O, "/me/plan/checkin", goal_id=str(G_A), status="dropped")
s.check("another person's goal: 404, nothing written", r.status_code == 404 and n_checkins(G_A) == n2, r.status_code)

s.section("the client")
JS = H.source(a, "static/dashboard.js")
TPL = H.source(a, "templates/dashboard.html")
i_p, i_e, i_c = (JS.find('pl.checkin_paused) gh.appendChild'), JS.find('pl.checkin_ended) gh.appendChild'),
                 JS.find('pl.status === "closed") gh.appendChild'))
s.check("the panel's note: paused, then its year over, then closed (an approved plan in a running cycle is paused)",
        -1 < i_p < i_e < i_c and '"Read only: its year is over"' in JS, (i_p, i_e, i_c))
s.check("...the remark shows 'once your plan is approved'", "once your plan is approved" in JS
        and "once your plan is closed" not in JS)
s.check("...the panel's line under its title follows the status: 'approved on <date>' (or 'closed on' unshared)",
        '(pl.status_label || "Closed").toLowerCase() + (pl.closed_on ? " on " + pl.closed_on : "")' in JS
        and '" plan · closed" + (pl.closed_on' not in JS)
s.check("the dashboard card's line says when its year is over", "{% elif P['checkin_ended'] %}Its year is over" in TPL)

sys.exit(s.done())
