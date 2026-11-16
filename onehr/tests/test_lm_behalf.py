"""A line manager assesses someone who didn't submit, on their behalf (Chris, 2026-10-26: "if a person didn't submit, it
will flow to the LM first, if the LM didn't respond, only then it will flow to the HOD, and so on"; canvas
[design canvas link removed], his four picks: their saved figures shown, competency too, the why
required with files optional, a note on the person's card and no email).

Once the person's own part has CLOSED with nothing submitted, the line manager keys in each KPI figure (a moderation step
flagged on_behalf, never a result of theirs) and sets each competency level (the assessment flagged on_behalf, so it has
no self figure), writes why, and confirms. What the person saved stays theirs, untouched. Synthetic ZZ people only; a
fresh_db suite, so Suite.done() puts the scratch copy back.
"""
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("A line manager's assessment of someone who didn't submit, on their behalf")
assert H.SCRATCH_MARKER in a.DB_PATH

ctx = a.app.test_request_context("/")
ctx.push()
db = a.get_db()
CID = a.active_cycle_id(db)
P = dict(a.active_pm_period(db))
db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=?", (CID,))
db.execute("DELETE FROM leader_role_access WHERE ability IN ('lm.behalf','mx.behalf')")
# a Mechanism-A group: the 1-5 ladder (a Mechanism-B line needs its threshold, OneHR's QC note)
base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 AND UPPER(TRIM(COALESCE(job_grade,'')))!='H' AND business_group IN "
                       "(SELECT business_group FROM pm_bg_config WHERE mechanism='A') LIMIT 1").fetchone())
cols = [c for c in base if c != "id"]
ids = {}
for eid, mgr in (("ZZBH-LM", None), ("ZZBH-MX", None), ("ZZBH-A", "LM"), ("ZZBH-B", "LM"), ("ZZBH-C", "LM"),
                 ("ZZBH-D", "LM")):
    v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ Behalf " + eid[5:], display_name=None, email=None,
             hod_id=None, manager_id=ids.get(mgr), buceo_bg=None, buceo_company=None, bgceo_bg=None,
             confirmation_date="2020-01-01", left_at=None, role="user")
    db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v.get(c) for c in cols])
    ids[eid[5:]] = db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]
LM, MX, A, B, C, D = ids["LM"], ids["MX"], ids["A"], ids["B"], ids["C"], ids["D"]
user = lambda i: dict(db.execute("SELECT * FROM users WHERE id=?", (i,)).fetchone())
lines = {}
for who in (A, B, C, D):
    for name, unit, w in (("ZZ Sales revenue", "RM (mil)", 60), ("ZZ Collection", "%", 40)):
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company,"
                   " unit, rate1, rate2, rate3, rate4, rate5, status) VALUES (?,?,?,?,?,?,?,?,1,2,3,4,5,'approved')",
                   (P["id"], who, name, w, "more", base["business_group"], base["company"], unit))
        tid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        lines.setdefault(who, []).append(tid)
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,?,?)", (tid, 1, LM))
# B's collection line has a second step (a matrix manager after the line manager)
db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,?,?)", (lines[B][1], 2, MX))
# A saved figures and never submitted; C submitted
for t, v in zip(lines[A], (3.5, 2.5)):
    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,1)", (t, v, A))
for t, v in zip(lines[C], (4.0, 4.0)):
    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) VALUES (?,?,?,0)", (t, v, C))
# competencies: two for A, who saved answers and never submitted
skills = [r[0] for r in db.execute("SELECT id FROM tc_skills ORDER BY id LIMIT 2")]
tca = []
for sk, fut in zip(skills, (0, 1)):
    db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future) VALUES (?,?,?,?)", (CID, A, sk, fut))
    tca.append(db.execute("SELECT last_insert_rowid()").fetchone()[0])
db.commit()
aa = a.tc_get_or_create_assessment(db, CID, A)
for asg in tca:
    db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer, remark) VALUES (?,?,'yes','ZZ my own note')",
               (aa["id"], asg))
db.execute("UPDATE tc_assessments SET overall_remark='ZZ my own draft remark' WHERE id=?", (aa["id"],))
db.commit()
lm, mx, ua, uc = user(LM), user(MX), user(A), user(C)
NOW = a._now_myt()
fmt = lambda d: d.strftime("%Y-%m-%d %H:%M")


def windows(employee_closed=True, lm_open=True):
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    emp = (fmt(NOW - timedelta(days=9)), fmt(NOW - timedelta(days=1))) if employee_closed else \
        (fmt(NOW - timedelta(days=2)), fmt(NOW + timedelta(days=3)))
    lmw = (fmt(NOW - timedelta(days=1)), fmt(NOW + timedelta(days=6))) if lm_open else \
        (fmt(NOW - timedelta(days=3)), fmt(NOW - timedelta(hours=1)))
    for cell in ("pm_results", "tc_self"):
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell) + emp)
    for cell in ("pm_approve", "tc_approve"):
        db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell) + lmw)
    db.commit()
    a.g.pop("_cycle_windows", None)   # read once per request: this suite is one long request


def reports():
    return {r["id"]: r for r in a._journey_team_reports(db, lm, "pm_review")}


# ------------------------------------------------------------------ before their deadline
s.section("while their own check-in is still open")
windows(employee_closed=False)
ls, why = a._pm_behalf_state(db, lm, A)
s.check("the gate waits for their deadline", len(ls) == 2 and why and "until it closes" in why, why)
r = reports()
s.check("the Team list says Not submitted yet, with nothing to press (it said 'Waiting on others')",
        r[A]["meta"] == "Not submitted yet" and not r[A]["action"] and not r[A]["behalf"], r[A])
res, err = a._pm_behalf_draft(db, lm, A, lines[A][0], "3")
s.check("...and a figure is refused", res is None and err and err["reason"] == "closed", err)
res, err = a._tc_override_one(db, lm, CID, A, tca[0], "yes", "")
s.check("...and so is a competency level (their self-assessment is still theirs)", err and err["reason"] == "not_reviewable",
        err)

# ------------------------------------------------------------------ after it
s.section("once it closed unsubmitted")
windows()
ls, why = a._pm_behalf_state(db, lm, A)
s.check("the gate opens for the line manager", len(ls) == 2 and why is None, why)
r = reports()
s.check("the Team list: Didn't submit, Assess on their behalf, first in the order",
        r[A]["meta"].startswith("Didn't submit") and r[A]["action"] == "Assess on their behalf" and r[A]["behalf"]
        and a._team_attention_rank(r[A]) < a._team_attention_rank(r[C]), (r[A], r[C]))
s.check("...the same for someone who saved nothing", r[B]["behalf"] and r[B]["meta"].startswith("Didn't submit"), r[B])
s.check("...and someone who submitted is moderated as before", r[C]["meta"] == "2 to moderate" and not r[C]["behalf"], r[C])
pend = a._pm_pending_split(db, lm, P["id"])["team_pending"]
s.check("what's waiting on the line manager counts them (it counted submitters only)", pend == 4, pend)
card = a._journey_team_pm_data(db, lm, A, "ZZ Behalf A")
bh = card.get("behalf") or {}
s.check("the card carries the assessment: open, their lines, what they saved (Chris's pick: shown as a starting point)",
        bh.get("open") and sorted(bh.get("ids") or []) == sorted(lines[A])
        and bh.get("saved") == {str(lines[A][0]): 3.5, str(lines[A][1]): 2.5}, bh)
s.check("...and someone who saved nothing has nothing beside the box",
        (a._journey_team_pm_data(db, lm, B, "B").get("behalf") or {}).get("saved") == {})
res, err = a._pm_behalf_draft(db, lm, A, lines[A][0], "lots")
s.check("a figure that isn't a number is refused", err and err["reason"] == "bad_number", err)
res, err = a._pm_behalf_draft(db, lm, A, lines[A][1], "3.2%")
s.check("a % on a % line is fine", err is None and res["lines"][1]["value"] == 3.2, (res, err))
s.check("...and the preview rates it, with no total while a line has no figure",
        res["lines"][1]["band"] and res["total"] is None and res["missing"] == 1, res)
res, err = a._pm_behalf_commit(db, lm, A)
s.check("confirming with a line still empty is refused", err and err["reason"] == "incomplete"
        and "ZZ Sales revenue" in err["msg"], err)
res, err = a._pm_behalf_draft(db, lm, A, lines[A][0], "4")
s.check("with every figure in, the total shows", err is None and res["total"] and res["missing"] == 0, res)
res, err = a._pm_behalf_commit(db, lm, A)
s.check("...but not without the why (Chris's pick: required)", err and err["reason"] == "needs_remark", err)
r1, e1 = a._pm_manager_remark_write(db, lm, P, A, "From the Q3 sales and collection reports, and what I saw this year.")
s.check("the why is the report remark's own writer", e1 is None, e1)
res, err = a._pm_behalf_commit(db, lm, A)
s.check("then it confirms", err is None and res["n"] == 2, err)
appr = db.execute("SELECT a.* FROM pm_kpi_approvals a WHERE a.kpi_target_id IN (?,?) ORDER BY a.kpi_target_id",
                  lines[A]).fetchall()
s.check("each line has one step: the line manager's figure, flagged on_behalf, nothing coming in from them",
        len(appr) == 2 and all(x["on_behalf"] == 1 and x["acted_by"] == LM and x["action"] == "adjust"
                               and x["original_value"] is None for x in appr)
        and [x["adjusted_value"] for x in appr] == [4.0, 3.2], [dict(x) for x in appr])
saved = db.execute("SELECT actual_value, draft FROM pm_kpi_results WHERE kpi_target_id IN (?,?) ORDER BY kpi_target_id",
                   lines[A]).fetchall()
s.check("what they saved is untouched: their own private draft", [tuple(x) for x in saved] == [(3.5, 1), (2.5, 1)],
        [tuple(x) for x in saved])
s.check("the moderation drafts are cleared", not db.execute(
    "SELECT 1 FROM pm_kpi_moderation_drafts WHERE approver_id=? AND kpi_target_id IN (?,?)", [LM] + lines[A]).fetchone())
fin = a.pm_final_overalls(db, P["id"], [A])[A]
s.check("their final (line-manager) result exists, from the line manager's figures", fin and fin["label"], fin)
s.check("...and they have no self figure anywhere (nothing of theirs was submitted)",
        a.pm_self_overalls(db, P["id"], [A]).get(A) is None and a._rr_pm_self(db, P["id"], A)[0] is None,
        (a.pm_self_overalls(db, P["id"], [A]), a._rr_pm_self(db, P["id"], A)))
s.check("they're tagged for the leaders above", A in a.lm_behalf_ids(db, P["id"]) and C not in a.lm_behalf_ids(db, P["id"]))
kt = a._calib_kpi_table(db, A, P["id"])
s.check("the calibrators' KPI table shows the line manager's figures, none of their own, marked on their behalf",
        kt["on_behalf"] and all(l["report_value"] is None and l["mod_value"] is not None and l["mod_band"]
                                for l in kt["lines"]) and kt["overall_mod"], kt)
ents = a._pm_remark_entries(db, lm, A, "hod")
s.check("the line manager's why goes up to the calibrators, said as on their behalf (it had no result of theirs to "
        "hang on)", any(e["role"] == "lm" and "From the Q3" in e["text"] and "on their behalf" in e["who"] for e in ents),
        ents)
ps = a._pm_perf_summary_for(db, lm, A)
s.check("the AI insight says so in words and calls no model", ps["source"] == "behalf" and "on their behalf" in ps["summary"],
        ps)
res, err = a._pm_behalf_commit(db, lm, A)
s.check("it's final: a second confirm finds nothing", err and err["reason"] == "closed", err)
card = a._journey_team_pm_data(db, lm, A, "A")
s.check("the card now reads done, the lines on_behalf with their rating", (card["behalf"] or {}).get("done")
        and all(l["on_behalf"] and l["mod_band"] for l in card["lines"]), card["behalf"])
r = reports()
s.check("...and the Team list says so", r[A]["done"] and r[A]["on_behalf"] and "on their behalf" in r[A]["meta"], r[A])
summ = a._journey_team_summary(db, lm, "pm_review")
s.check("the Team summary carries both flags and counts who's left", summ.get("behalf", {}).get("n") == 2
        and any(x["id"] == A and x["on_behalf"] for x in summ["rows"]), summ.get("behalf"))

s.section("a line with a later step goes on to it")
for t, v in zip(lines[B], ("2", "3")):
    a._pm_behalf_draft(db, lm, B, t, v)
a._pm_manager_remark_write(db, lm, P, B, "Assessed from the team's records.")
res, err = a._pm_behalf_commit(db, lm, B)
s.check("B confirms", err is None, err)
tb = [dict(t) for t in db.execute("SELECT * FROM pm_kpi_targets WHERE id=?", (lines[B][1],))]
a.attach_pm_chains(db, tb)
s.check("the matrix manager after the line manager may act on it (it had no result of theirs)",
        a._pm_line_actionable_by(tb[0], MX) and not tb[0]["locked"], tb[0]["next_approver"])

# ------------------------------------------------------------------ who may
s.section("who may, and when")
s.check("someone who isn't on the chain has nothing to assess", a._pm_behalf_state(db, uc, D)[0] == [])
windows(lm_open=False)
_w = a._pm_behalf_state(db, lm, D)
s.check("the line manager's own window closed: refused, saying so", len(_w[0]) == 2 and _w[1] and "closed" in _w[1], _w)
windows()
db.execute("INSERT OR REPLACE INTO leader_role_access(role, ability, allowed) VALUES ('lm','lm.behalf',0)")
db.commit()
a.g.pop("_leader_off", None)
_w = a._pm_behalf_state(db, lm, D)
s.check("switched off on Roles & access (lm.behalf): refused, saying so", _w[1] and "switched off" in _w[1], _w)
s.check("...the competency too", "switched off" in (a._tc_behalf_state(db, lm, CID, A) or ""))
db.execute("DELETE FROM leader_role_access WHERE ability='lm.behalf'")
db.commit()
a.g.pop("_leader_off", None)
s.check("...and back on, open again", a._pm_behalf_state(db, lm, D)[1] is None)
c2 = a.app.test_client()
c2.get("/__scratch_login/%d" % LM)
with c2.session_transaction() as sess:
    tok = sess.get("csrf_token")
rr = c2.post("/review/team/behalf/pm", data={"report_id": D, "kpi_target_id": lines[D][0], "value": "4",
                                              "csrf_token": tok})
s.check("the route saves a figure as the line manager types", rr.status_code == 200 and rr.get_json()["ok"]
        and rr.get_json()["lines"][0]["value"] == 4.0, (rr.status_code, rr.get_json()))
rr = c2.post("/review/team/behalf/pm", data={"report_id": A, "op": "confirm", "csrf_token": tok})
s.check("...and answers JSON, refusing what isn't open (A is done)", rr.status_code == 409 and rr.get_json()["ok"] is False,
        (rr.status_code, rr.get_json()))
c3 = a.app.test_client()
c3.get("/__scratch_login/%d" % C)
with c3.session_transaction() as sess:
    tok3 = sess.get("csrf_token")
rr = c3.post("/review/team/behalf/pm", data={"report_id": D, "kpi_target_id": lines[D][0], "value": "5",
                                              "csrf_token": tok3})
s.check("someone else posting for D is refused", rr.status_code == 409 and not rr.get_json()["ok"], rr.status_code)
s.check("the route is on the window gate's map (pm_approve) and the module map",
        a.WINDOW_ENDPOINT_CELLS.get("review_team_behalf_pm") == ["pm_approve"]
        and a.MODULE_ENDPOINTS.get("review_team_behalf_pm") == "review")
s.check("Roles & access lists both abilities", {"lm.behalf", "mx.behalf"} <= {k for _g, k, _l, _n in a.LEADER_ABILITIES})

# ------------------------------------------------------------------ competency
s.section("competency, on their behalf")
st = a._tc_behalf_state(db, lm, CID, A)
s.check("their self-assessment closed unsubmitted: the levels are the line manager's", st is None, st)
tmd = a._journey_team_tm_data(db, lm, A, "A")
s.check("the card: actionable, what they saved beside each level, approve not yet",
        (tmd["behalf"] or {}).get("open") and all(it["actionable"] and it["report_answer"] == "yes"
                                                   for g in tmd["groups"] for it in g["items"])
        and not tmd["can_approve"] and tmd["remark_required"], tmd.get("behalf"))
res, err = a._tc_override_one(db, lm, CID, A, tca[0], "no", "")
s.check("a level is set on the pending assessment", err is None, err)
res, err = a._tc_approve_assessment(db, lm, CID, A)
s.check("approving with a level still to set is refused (what they saved never stands in)",
        err and err["reason"] == "incomplete", err)
a._tc_override_one(db, lm, CID, A, tca[1], "no", "")
res, err = a._tc_approve_assessment(db, lm, CID, A)
s.check("...and without the remark (required)", err and err["reason"] == "needs_remark", err)
res, err = a._tc_manager_remark_write(db, lm, CID, A, "Solid on the basics; still building the next level.")
s.check("the remark is written on the pending assessment", err is None, err)
res, err = a._tc_approve_assessment(db, lm, CID, A)
s.check("then it approves, on their behalf", err is None and res.get("on_behalf"), err)
row = db.execute("SELECT status, on_behalf, reviewed_by, submitted_at FROM tc_assessments WHERE subject_id=? AND cycle_id=?",
                 (A, CID)).fetchone()
s.check("reviewed, flagged, by the line manager, and never 'submitted' by them",
        row["status"] == "reviewed" and row["on_behalf"] == 1 and row["reviewed_by"] == LM and row["submitted_at"] is None,
        dict(row))
s.check("their own answers are untouched", [r[0] for r in db.execute(
    "SELECT answer FROM tc_scores WHERE assessment_id=? ORDER BY assignment_id", (aa["id"],))] == ["yes", "yes"])
self_sc = a.tc_score(db, aa["id"], "self")
s.check("...and read as no self figure at all", self_sc[0] is None and self_sc[1], self_sc)
tsr = a.tc_reviewed_score(db, A, CID)
s.check("the approved competency is the line manager's, with no self beside it", tsr[0] is None and tsr[1] == 0.0, tsr)
s.check("no self competency band", a._tc_competency_band(db, A, CID, "self") is None)
cp = a.combined_potential(db, ua, CID, 10.0)
s.check("the potential works it out without a self figure (it would have raised)", cp["source"] in ("none", "combined")
        and (cp["source"] == "none" or (cp["score"] is not None and cp["self_score"] is None)), cp.get("source"))
s.check("the Team list says so", any(r["id"] == A and r["on_behalf"] for r in a._journey_team_reports(db, lm, "tm_review")))
pe = a._pot_remark_entries(db, [ua], CID, "hod")
pe_a = pe.get(A) if isinstance(pe, dict) else pe
txt = str(pe_a)
s.check("what they saved (their remark, their notes) never goes up as theirs", "ZZ my own" not in txt
        and "Solid on the basics" in txt, txt[:300])
ev = a._calib_tc_evidence(db, ua, CID)
s.check("...nor in the calibrators' competency evidence", ev["on_behalf"] and ev["overall_remark"] == ""
        and all(r["answer"] is None and r["remark"] is None for g in ev["groups"] for r in g["rows"]), ev.get("overall_remark"))
ts_ = a._tc_summary_for(db, A)
s.check("the competency insight says the levels were set on their behalf", ts_["source"] == "behalf", ts_)

# ------------------------------------------------------------------ the person, and the words
s.section("what the person sees, and what the agents know")
note = a._journey_window_note(db, ua, "checkin", A)
s.check("their own closed card says their line manager assesses it (Chris's pick: a note, no email)",
        note and "your line manager assesses this on your behalf" in note, note)
s.check("...someone who submitted gets the plain closed sentence",
        "on your behalf" not in (a._journey_window_note(db, uc, "checkin", C) or ""))
s.check("no email goes to them", not db.execute("SELECT 1 FROM email_outbox WHERE recipient_id=?", (A,)).fetchone()
        if "recipient_id" in [r[1] for r in db.execute("PRAGMA table_info(email_outbox)")] else True)
s.check("Help's Team answers name it", all("team_behalf" in a.HELP_LISTS[k][1] for k in ("team_kpi", "team_tm"))
        and "on their behalf" in a.HELP_QA["team_behalf"][1])
s.check("the knowledge base explains a missed deadline", "missed-deadline" in open(a.__file__, encoding="utf-8").read())
s.check("the Team agent is told it can't do it for them", "never say you did" in a._MGR_BEHALF_RULE)
ctx.pop()
sys.exit(s.done())
