"""The line manager's review of a development plan: the remark, then Approve plan (Chris, 2026-10-21: "remove the
career conversation ... LM will just comment on the IDP of the person and approve it", the remark required; then the
look of canvas 8J9QzZua7VGUD8rsgXcqQk: where they're aiming, each goal's gap and its 70 / 20 / 10, the career profile in
two parts, one grey heading style). Plus the competency save that checked a higher level before its first level.

  * _idp_approve_plan is the one writer (the card, the classic page, the agent's close_plan): a shared plan, the overall
    remark first, then pm_idp_close; it never writes a career conversation;
  * the route answers JSON for the card and a flash for the classic page;
  * the payload: where they're aiming (the role picked, its grade, skills match), each goal's gap, can_approve;
  * the queue: Needs your remark / Ready to approve / Approved;
  * the competency card keeps a refused tick selected and claims no save it didn't make."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("IDP review: the remark, then Approve plan; the competency card's refused ticks")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
JS = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
CSS = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
SRC = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
TPL = open(os.path.join(H.REPO, "templates", "idp_team_member.html"), encoding="utf-8").read()


def fn(name):
    i = JS.find("function %s(" % name)
    return JS[i:JS.find("\n  }\n", i)] if i >= 0 else ""


def post(client, url, headers=None, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form, headers=headers or {})


# ---------------------------------------------------------------------------
# A line manager (the KPI approver AND users.manager_id) with a report, as test_idp_fit seeds it.
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("UPDATE cycles SET half=2 WHERE is_active=1")   # IDP plan review is Year-End only
    db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('review_unified','1')")
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','evidence','pm','tm','idp')")
    db.commit()
    PERIOD = a.active_pm_period(db)
    MGR = RID = None
    for r in db.execute("SELECT ap.approver_id AS m, t.subject_id AS s FROM pm_kpi_target_approvers ap "
                        "JOIN pm_kpi_targets t ON t.id = ap.kpi_target_id JOIN users u ON u.id = t.subject_id "
                        "WHERE t.cycle_id=? AND ap.seq=1 AND u.manager_id = ap.approver_id AND u.left_at IS NULL "
                        "GROUP BY ap.approver_id, t.subject_id LIMIT 1", (PERIOD["id"],)):
        MGR, RID = r["m"], r["s"]
    YR = a.pm_idp_plan_year(PERIOD)
    MGRU = dict(db.execute("SELECT * FROM users WHERE id=?", (MGR,)).fetchone()) if MGR else None
    if MGR:
        db.execute("DELETE FROM pm_idp WHERE plan_year=? AND subject_id=?", (YR, RID))
        db.execute("DELETE FROM pm_career_conversations WHERE plan_year=? AND subject_id=?", (YR, RID))
        IDP_ID = db.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status, shared_at) "
                            "VALUES (?,?,?,'shared',datetime('now'))", (YR, PERIOD["id"], RID)).lastrowid
        db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, action_experience, action_education, target_date, "
                   "required_level, have_level, gap_kind) VALUES (?,1,'Cost Analysis','Build the quarterly breakdown',"
                   "'A costing course','2027-06-30',4,3,'current')", (IDP_ID,))
        db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, action_experience, required_level, gap_kind) "
                   "VALUES (?,2,'Budget Planning','Draft one cost centre budget',4,'new')", (IDP_ID,))
        db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area) VALUES (?,3,'Presenting')", (IDP_ID,))
        a.pm_career_profile_for(db, RID, create=True)
        # the role they picked: a job profile of the suite's own (the copy may hold none)
        _tid = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, source, active) "
                          "VALUES ('ZZTEST Dept', 'ZZTEST Assistant Manager, Cost Planning', '15', 'test', 1)").lastrowid
        TGT = db.execute("SELECT id, job_title, job_grade FROM tc_job_profiles WHERE id=?", (_tid,)).fetchone()
        db.execute("UPDATE pm_career_profile SET aspiration_mid='Run the site cost planning', target_profile_id=? "
                   "WHERE subject_id=?", (TGT["id"] if TGT else None, RID))
        db.commit()

if not MGR:
    s.check("SKIP: no line manager who approves a report's KPI lines in this database", True)
    sys.exit(s.done())

# ---------------------------------------------------------------------------
s.section("the payload: where they're aiming, each goal's gap, can_approve")
with a.app.test_request_context("/"):
    db = a.get_db()
    d = a._journey_team_plan_data(db, MGRU, RID, "Report")
    aim = d.get("aiming") or {}
    s.check("where they're aiming: the role they picked, by its own title and grade",
            TGT is not None and aim.get("title") == TGT["job_title"] and aim.get("grade") == TGT["job_grade"], aim)
    s.check("...with a skills match count, never a 'ready' word", "match" in aim and "total" in aim
            and "ready" not in str(aim).lower(), aim)
    g = {x["area"]: x for x in d["goals"]}
    s.check("each goal carries the gap the drafter stored: kind, level held and level needed",
            (g["Cost Analysis"]["gap_kind"], g["Cost Analysis"]["have_level"], g["Cost Analysis"]["required_level"])
            == ("current", 3, 4) and g["Budget Planning"]["gap_kind"] == "new" and g["Presenting"]["gap_kind"] == "",
            [(x["area"], x["gap_kind"], x["have_level"], x["required_level"]) for x in d["goals"]])
    s.check("no remark yet: can_close (shared) but not can_approve", d["can_close"] is True and d["can_approve"] is False,
            (d["can_close"], d["can_approve"]))
    db.execute("UPDATE pm_career_profile SET target_profile_id=NULL WHERE subject_id=?", (RID,)); db.commit()
    s.check("...no role picked: no aiming line", a._journey_team_plan_data(db, MGRU, RID, "Report").get("aiming") is None)
    db.execute("UPDATE pm_career_profile SET target_profile_id=? WHERE subject_id=?", (TGT["id"], RID)); db.commit()

s.section("the queue: needs your remark, ready to approve, approved")
with a.app.test_request_context("/"):
    db = a.get_db()
    row = {r["id"]: r for r in a._journey_team_reports(db, MGRU, "plan_review")}.get(RID)
    s.check("a shared plan with no remark: 'Needs your remark', not done, Write your remark",
            row and row["meta"] == "Needs your remark" and row["done"] is False and row["action"] == "Write your remark",
            row and (row["meta"], row["done"], row["action"]))

s.section("Approve plan: the remark first, then it closes; no career conversation")
with a.app.test_request_context("/"):
    db = a.get_db()
    n_conv0 = db.execute("SELECT COUNT(*) FROM pm_career_conversations").fetchone()[0]
    res, err = a._idp_approve_plan(db, MGRU, PERIOD, RID)
    s.check("without the overall remark it is REFUSED (needs_remark) and the plan stays shared",
            res is None and err and err["reason"] == "needs_remark"
            and db.execute("SELECT status FROM pm_idp WHERE id=?", (IDP_ID,)).fetchone()[0] == "shared", err)
C = H.client_as(a, MGR)
r = post(C, "/idp/team/%d/career-conversation" % RID, headers={"X-Requested-With": "fetch"})
j = r.get_json() or {}
s.check("...the card's call gets JSON: 409, ok False, the reason in words",
        r.status_code == 409 and j.get("ok") is False and "remark" in (j.get("error") or ""), (r.status_code, j))
r = post(C, "/review/team/idp-remark", report=str(RID),
         remark="A clear plan: cost analysis builds on a strength; budget planning is the gap, and I'll support it.")
s.check("the line manager saves the overall remark", r.status_code == 200 and (r.get_json() or {}).get("ok"),
        r.status_code)
with a.app.test_request_context("/"):
    db = a.get_db()
    row = {r["id"]: r for r in a._journey_team_reports(db, MGRU, "plan_review")}.get(RID)
    s.check("...the queue reads 'Ready to approve', still not done, Approve the plan",
            row and row["meta"] == "Ready to approve" and row["done"] is False and row["action"] == "Approve the plan",
            row and (row["meta"], row["done"], row["action"]))
    s.check("...and the payload's can_approve turns on",
            a._journey_team_plan_data(db, MGRU, RID, "Report")["can_approve"] is True)
r = post(C, "/idp/team/%d/career-conversation" % RID, headers={"X-Requested-With": "fetch"})
j = r.get_json() or {}
s.check("with the remark in, Approve plan CLOSES it (JSON ok)",
        r.status_code == 200 and j.get("ok") is True
        and H.one(a, "SELECT status FROM pm_idp WHERE id=?", (IDP_ID,)) == "closed", (r.status_code, j))
s.check("...and writes no career conversation (gone since 2026-10-21)",
        H.one(a, "SELECT COUNT(*) FROM pm_career_conversations") == n_conv0)
s.check("...logged as the plan's close, 'approved'",
        H.one(a, "SELECT detail FROM activity_log WHERE action='idp_close' AND target_user_id=? ORDER BY id DESC "
                 "LIMIT 1", (RID,)) == "%s: approved" % YR)
r = post(C, "/idp/team/%d/career-conversation" % RID, headers={"X-Requested-With": "fetch"})
s.check("approving again is refused: it's already approved", r.status_code == 409
        and "already approved" in ((r.get_json() or {}).get("error") or ""), r.get_json())
with a.app.test_request_context("/"):
    db = a.get_db()
    row = {r["id"]: r for r in a._journey_team_reports(db, MGRU, "plan_review")}.get(RID)
    s.check("...the queue reads 'Approved', done", row and row["meta"] == "Approved" and row["done"] is True, row and (row["meta"], row["done"]))
    db.execute("UPDATE pm_idp SET status='draft' WHERE id=?", (IDP_ID,)); db.commit()
    s.check("a DRAFT plan can't be approved (pm_idp_close would close a draft nobody shared)",
            a._idp_approve_plan(db, MGRU, PERIOD, RID)[1]["reason"] == "not_shared")
    s.check("...nor through the agent's close_plan, which takes no date or note any more",
            a._mgr_tool_close_plan(db, MGRU, None, RID, {}).get("ok") is False)
    db.execute("UPDATE pm_idp SET status='shared' WHERE id=?", (IDP_ID,)); db.commit()
C2 = H.client_as(a, MGR)
r = C2.post("/idp/team/%d/career-conversation" % RID, data={"csrf_token": "tok"})
s.check("the classic page's form (no fetch header) approves and redirects back",
        r.status_code in (302, 303) and H.one(a, "SELECT status FROM pm_idp WHERE id=?", (IDP_ID,)) == "closed",
        r.status_code)

s.section("the card (client): no career conversation; Approve plan off until the remark is written")
w = fn("idpReviewWidget")
s.check("no date, no 'what was discussed', no 'Record conversation'",
        "Career conversation\"" not in w and "rv-idp-date" not in w and "Record conversation" not in w
        and "What was discussed" not in w and "idpClose" not in JS)
s.check("Approve plan, disabled until the remark box holds text, the remark flushed before the confirm box",
        'go.textContent = "Approve plan";' in w and "var ok = hasRemark(); go.disabled = !ok;" in w
        and "cardRmFlush(rmKey).then(function () {" in w and 'confirmText: "Approve plan"' in w)
s.check("...the remark box says it's required", "required: true," in w and "Required before you approve" in w)
s.check("where they're aiming sits above the AI insight; never 'ready'",
        w.find("rv-idp-aim") < w.find("rv-idp-insight") and "skills match (a match is not a promotion decision)" in w
        and "ready" not in w.lower().split("rv-idp-aim", 1)[1].split("rv-idp-insight", 1)[0])
s.check("each goal: its gap tag, its date, 70 / 20 / 10 in three columns, a missing part said",
        "idpGapTag(g)" in w and '"On the job · 70"' in w and '"From others · 20"' in w and '"Formal · 10"' in w
        and '"None given"' in w)
gt = fn("idpGapTag")
s.check("the gap tag: new for the role, a level held to needed, from their results, or none",
        '"New for the role"' in gt and '"Closes a gap · L" + have + " to L" + need' in gt
        and '"From their results"' in gt and 'return "";' in gt)
s.check("the career profile in two parts, one grey heading style (no amber rv-mgr-sec on this card)",
        '"Where they want to go"' in w and '"About them"' in w and "rv-mgr-sec" not in w
        and ".rv-idp-sec { margin: 6px 2px 0; }" in CSS and H.cv("color: #5f6578; }") in CSS)
s.check("the approve call sends the fetch header and shows a refusal under the button",
        'headers: { "X-Requested-With": "fetch" }' in fn("idpApprove")
        and '.rv-mod-err[data-close="\' + rid + \'"]' in fn("idpApprove"))
s.check("the classic page: Approve plan, double-confirmed, no date field",
        "Approve plan" in TPL and "data-confirm=" in TPL and 'name="held_on"' not in TPL)
s.check("the agent: close_plan{} approves (the remark first), its prompt and person-text list hold no note",
        "close_plan{held_on" not in SRC and '"close_plan": ("note",)' not in SRC
        and "close_plan{} APPROVES the plan" in SRC)

# ---------------------------------------------------------------------------
s.section("the competency card's Save: a refused tick stays selected, and no 'saved' turn is claimed")
s.check("the card shows the refusal, keeps the refused tick selected, and Save sends no turn on a refusal "
        "(the level pair itself is the person's to give since c8da210)",
        "says.join(\" \")" in fn("tcSaveErrSay") and "if (errs.length) { bubble(\"agent\", tcSaveErrSay(errs)); return; }"
        in fn("saveCompetencyAnswers") and "tc.pending = keep;" in fn("saveCompetencyAnswers")
        and "bubble(\"agent\", tcSaveErrSay(j.errors))" in fn("flushPendingAnswers"))

H.restore_db()
sys.exit(s.done())
