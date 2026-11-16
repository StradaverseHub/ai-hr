"""The review-chat reconception (2026-08-29): period-kind, the KPI picker, the
strong-rating evidence prompt, the AE/OU follow-up, and the module-named,
role-aware rail.

Writes (evidence + KPI targets), so a fresh copy. Everything is BUILT, not
hunted -- the generated CI fixture has no approved PM targets.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Review chat -- period-kind, picker, strong-rating, role rail")
SU, _BG, _EMP = H.actors(a)


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','evidence')")
    us = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                    "ORDER BY id LIMIT 3").fetchall()
    SUBJ, MGR = us[0], us[1]
    db.commit()

# ---------------------------------------------------------------------------
s.section("period kind -- quarterly is trajectory, mid/year-end collect results")
with a.app.app_context():
    db = a.get_db()
    def kind(k):
        db.execute("UPDATE cycles SET kind=? WHERE id=?", (k, CID)); db.commit()
        return db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone()
    s.check("quarterly -> trajectory only", a.pm_period_collects_results(kind("quarterly")) is False)
    s.check("mid_year -> results", a.pm_period_collects_results(kind("mid_year")) is True)
    s.check("year_end -> results", a.pm_period_collects_results(kind("year_end")) is True)
    s.check("no period -> results (legacy-safe)", a.pm_period_collects_results(None) is True)
    kind("mid_year")

def state_for(uid):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        u = a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return a.review_state(a.get_db(), u)

with a.app.app_context():
    rail = [x["key"] for x in state_for(SUBJ["id"])["stages"]]
s.check("results period: the PM self-KPI slot is 'account', not 'checkin'",
        "account" in rail and "checkin" not in rail, rail)
with a.app.app_context():
    a.get_db().execute("UPDATE cycles SET kind='quarterly' WHERE id=?", (CID,)); a.get_db().commit()
    rail_q = [x["key"] for x in state_for(SUBJ["id"])["stages"]]
    a.get_db().execute("UPDATE cycles SET kind='mid_year' WHERE id=?", (CID,)); a.get_db().commit()
s.check("quarterly period: the slot is 'checkin', not 'account'",
        "checkin" in rail_q and "account" not in rail_q, rail_q)

# ---------------------------------------------------------------------------
s.section("the module-named, role-aware rail")
with a.app.app_context():
    labels = {x["key"]: x["label"] for x in state_for(SUBJ["id"])["stages"]}
s.check("labels carry the module code", labels.get("account", "").startswith("PM –"), labels.get("account"))
s.check("competency is 'TM – Competency Assessment'",
        labels.get("competency") == "TM – Competency Assessment", labels.get("competency"))
s.check("career profiling is a self stage now",
        any(x["key"] == "career" and x["group"] == "self" for x in state_for(SUBJ["id"])["stages"]))
with a.app.app_context():
    plain_has_team = any(x["group"] == "team" for x in state_for(SUBJ["id"])["stages"])
s.check("a plain employee sees NO team stages", not plain_has_team)

# Make MGR a KPI approver of SUBJ, then MGR should see team stages.
with a.app.app_context():
    db = a.get_db()
    TID = db.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
        "status, business_group) VALUES (?,?,?,?,?,'approved',?)",
        (CID, SUBJ["id"], "ZZ Deliveries", 100.0, "more", SUBJ["business_group"] or "")).lastrowid
    db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) "
               "VALUES (?,1,?)", (TID, MGR["id"]))
    db.commit()
    mgr_stages = state_for(MGR["id"])["stages"]
    team_keys = [x["key"] for x in mgr_stages if x["group"] == "team"]
s.check("a line manager sees the PM – KPI Review team stage", "pm_review" in team_keys, team_keys)
s.check("...labelled with the module code",
        next((x["label"] for x in mgr_stages if x["key"] == "pm_review"), "").startswith("PM –"))

# ---------------------------------------------------------------------------
s.section("the KPI picker validates -- own unanswered lines only")
with a.app.app_context():
    st = state_for(SUBJ["id"])
    tids = [t["id"] for t in st["targets"] if t.get("needs_figure")]
    picked = a.review_pick_target(st, tids[0]) if tids else None
    s.check("a real unanswered own line is accepted", picked is not None and picked["id"] == tids[0])
    s.check("a foreign / unknown id is refused", a.review_pick_target(st, 99999999) is None)

# ---------------------------------------------------------------------------
s.section("strong-rating prompt -- fires on AE/OU, and only when uncited")
with a.app.app_context():
    db = a.get_db()
    fake = {"targets": [
        {"id": 501, "kpi_name": "Strong KPI", "has_value": True, "score": {"label": "OU"}},
        {"id": 502, "kpi_name": "Mid KPI", "has_value": True, "score": {"label": "ME"}},
    ]}
    strong = a.review_strong_prompt(db, dict(SUBJ), fake, 501)
    s.check("an OU line triggers the prompt", strong is not None and strong["id"] == 501)
    s.check("...carrying a friendly score name",
            strong and strong.get("score_name") == a.PM_LABEL_NAMES.get("OU"))
    s.check("a ME (not strong) line does NOT", a.review_strong_prompt(db, dict(SUBJ), fake, 502) is None)
    # once an item is cited to the KPI, the prompt stops nagging
    eid = db.execute("INSERT INTO pm_evidence(subject_id, author_id, author_role, occurred_on, "
                     "kind, body, state, shared_at) VALUES (?,?, 'self','2026-03-01','recognition',"
                     "'did well','shared',datetime('now'))", (SUBJ["id"], SUBJ["id"])).lastrowid
    db.execute("INSERT INTO pm_evidence_links(evidence_id, target_kind, target_ref) "
               "VALUES (?,'kpi','501')", (eid,))
    db.commit()
    s.check("...and stops once the KPI already has cited evidence",
            a.review_strong_prompt(db, dict(SUBJ), fake, 501) is None)

s.section("AE/OU overall follow-up")
with a.app.app_context():
    db = a.get_db()
    # a fresh subject with no recognition item yet
    other = us[2]
    s.check("AE overall with no example yet -> prompt",
            a.review_overall_examples_pending(db, dict(other), {"label": "AE"}) is not None)
    s.check("a mid overall -> no prompt",
            a.review_overall_examples_pending(db, dict(other), {"label": "ME"}) is None)

# ---------------------------------------------------------------------------
s.section("the compliment writer -- a shared evidence item cited to the KPI")
E = H.client_as(a, SUBJ["id"])
r = post(E, "/review/kpi-evidence", body="Closed the Ipoh backlog single-handed.",
         kpi_target_id=str(TID))
s.check("it writes and returns ok", r.status_code == 200 and (r.get_json() or {}).get("ok"),
        (r.status_code, r.get_json()))
with a.app.app_context():
    db = a.get_db()
    row = db.execute("SELECT e.* FROM pm_evidence e JOIN pm_evidence_links l ON l.evidence_id=e.id "
                     "WHERE e.subject_id=? AND l.target_kind='kpi' AND l.target_ref=? "
                     "AND e.state='shared'", (SUBJ["id"], str(TID))).fetchone()
s.check("a shared evidence item is cited to that KPI", row is not None)
s.check("...authored by the subject as 'self'", row and row["author_role"] == "self")
s.check("an empty body is refused", post(E, "/review/kpi-evidence", body="  ").status_code == 400)
# a foreign KPI id is simply not linked (no oracle), the item still writes unlinked
r2 = post(E, "/review/kpi-evidence", body="general note", kpi_target_id="99999999")
s.check("a foreign KPI id does not error (writes unlinked)", r2.status_code == 200)
# gated on the evidence module
with a.app.app_context():
    a.get_db().execute("UPDATE cycle_modules SET active=0 WHERE module_key='evidence'")
    a.get_db().commit()
s.check("evidence off -> the writer 404s",
        post(E, "/review/kpi-evidence", body="x", kpi_target_id=str(TID)).status_code == 404)
with a.app.app_context():
    a.get_db().execute("UPDATE cycle_modules SET active=1 WHERE module_key='evidence'")
    a.get_db().commit()

# ---------------------------------------------------------------------------
s.section("AI wording degrades to the phrasebook -- /review/say echoes when off")
r = E.get("/review/say?t=" + a.url_quote("What did Gross Profit come in at?")
          if hasattr(a, "url_quote") else "/review/say?t=Hello")
# Azure is unconfigured in the fixture, so ai_on('ai_review') is False -> echo.
j = E.get("/review/say?t=Hello%20there").get_json()
s.check("with AI off, /review/say returns the sentence unchanged",
        j and j.get("ok") and j.get("text") == "Hello there", j)
s.check("an empty sentence is refused", E.get("/review/say?t=").status_code == 400)

sys.exit(s.done())
