"""Manager mode of the unified review journey (2026-09-09), Phase 0+1 -- the READ-ONLY
team view: the SAME chat + navigator + tabs, turned on by view=team (echoed per request,
never stored) + a focused `report`. The three manager stages (pm_review / tm_review /
plan_review) already exist in REVIEW_STAGES; 360 is omitted. This suite proves the wiring:

  * the team axis is the three team-group stages -- feedback (360) + career_review absent
  * the nav lists the manager's reports; PM and IDP share the approver population
  * the focused report is clamped to the manager's OWN population (a crafted id can't leak)
  * the review table carries the report's OWN entered result (the extra reference column)
  * GET ?view=team renders the team chrome for a manager; a non-manager falls back to mine
  * the employee (mine) journey is unaffected
  * the team read path writes nothing (read-only lint on the new helpers)

Runs against the repo DB / generated fixture; asserts relationships, not hard numbers.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
import ai_draft  # noqa: E402  (unused directly; keeps import parity with the other suites)
s = H.Suite("Manager mode -- the read-only team review journey")
# IDP plan review and Calibration are Year-End only (Chris, 2026-09-28), so this suite runs in a Year-End cycle -- and
# puts the half back afterwards (it shares the harness database with the suites after it).
with a.app.app_context():
    _db_h = a.get_db()
    _HALF_CID = a.active_cycle_id(_db_h)
    _HALF_WAS = _db_h.execute("SELECT half FROM cycles WHERE id=?", (_HALF_CID,)).fetchone()["half"]
    _db_h.execute("UPDATE cycles SET half=2 WHERE id=?", (_HALF_CID,))
    # ...and the modules its routes are gated on (/review/*, the team summaries' pm / tm / idp, /evidence/* below),
    # on in the active cycle whatever an earlier suite in the batch left, all put back as found at the end, with
    # review_unified (2026-10-26: a neighbour's leftover review=0 failed it in run_parallel.sh's batch 6)
    _MODS_WAS = [dict(r) for r in _db_h.execute(
        "SELECT * FROM cycle_modules WHERE module_key IN ('review','pm','tm','idp','evidence')")]
    _RU_WAS = _db_h.execute("SELECT value FROM app_settings WHERE key='review_unified'").fetchone()
    for _m in ("review", "pm", "tm", "idp"):
        _db_h.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1) "
                      "ON CONFLICT(cycle_id, module_key) DO UPDATE SET active=1", (_HALF_CID, _m))
    _db_h.commit()

SRC = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()


def _find_manager(db, period_id):
    """A user who approves at least one KPI line this period (the PM/IDP population),
    else a line manager with a competency report. Returns a user row or None."""
    row = db.execute(
        "SELECT DISTINCT a.approver_id AS uid FROM pm_kpi_target_approvers a "
        "JOIN pm_kpi_targets t ON t.id = a.kpi_target_id "
        "JOIN users u ON u.id = a.approver_id "
        "JOIN users su ON su.id = t.subject_id "
        "WHERE t.cycle_id=? AND u.role != 'admin' AND u.left_at IS NULL "
        "AND UPPER(TRIM(COALESCE(su.job_grade,'')))!='H' LIMIT 1",   # a Grade H report is never in the normal review (2026-10-30)
        (period_id,)).fetchone()
    if row:
        return dict(db.execute("SELECT * FROM users WHERE id=?", (row["uid"],)).fetchone())
    return None


def _find_tm_manager(db):
    """A line manager who has at least one direct report carrying competencies this
    cycle -- i.e. _tc_reports_for is non-empty (the TM override population + gate).
    Returns (manager_row, cycle_id, reports) or (None, None, None)."""
    cid = a.active_cycle_id(db)
    if not cid:
        return None, None, None
    for row in db.execute(
        "SELECT DISTINCT u.manager_id AS uid FROM users u "
        "JOIN tc_assignments t ON t.subject_id = u.id AND t.cycle_id=? "
        "WHERE u.manager_id IS NOT NULL AND u.left_at IS NULL AND u.role!='admin'",
        (cid,)).fetchall():
        m = db.execute("SELECT * FROM users WHERE id=? AND role!='admin' AND left_at IS NULL",
                       (row["uid"],)).fetchone()
        if not m:
            continue
        reports = a._tc_reports_for(db, row["uid"], cid)
        if reports:
            return dict(m), cid, reports
    return None, None, None


# ---------------------------------------------------------------------------
s.section("the team axis is the three manager stages -- 360 + career_review absent")
with a.app.test_request_context("/review/journey"):
    from flask import session as _sess
    db = a.get_db()
    period = a.active_pm_period(db)
    mgr = _find_manager(db, period["id"]) if period else None
    if not mgr:
        s.check("SKIP: no manager with an approver-chain report in this database", True)
    else:
        _sess["user_id"] = mgr["id"]
        st = a.review_state(db, mgr)
        team = a._journey_team_live_stages(st)
        keys = [x["key"] for x in team]
        s.check("team stages are a subset of pm_review/tm_review/plan_review",
                set(keys) <= {"pm_review", "tm_review", "plan_review"}, keys)
        s.check("360 (feedback) is never a team stage", "feedback" not in keys)
        s.check("career_review is folded away (never a team stage)", "career_review" not in keys)
        s.check("each team stage carries its module (pm/tm/idp)",
                all(x["module"] in ("pm", "tm", "idp") for x in team), keys)

# ---------------------------------------------------------------------------
s.section("populations: PM and IDP share the approver chain; the report is clamped")
with a.app.test_request_context("/review/journey"):
    from flask import session as _sess
    db = a.get_db()
    period = a.active_pm_period(db)
    mgr = _find_manager(db, period["id"]) if period else None
    if not mgr:
        s.check("SKIP: no manager to resolve populations for", True)
    else:
        _sess["user_id"] = mgr["id"]
        pm_ids = {r["id"] for r in a._journey_team_reports(db, mgr, "pm_review")}
        idp_ids = {r["id"] for r in a._journey_team_reports(db, mgr, "plan_review")}
        s.check("PM review population is non-empty for this manager", bool(pm_ids), len(pm_ids))
        # the plan review is the approver chain PLUS their own direct reports writing a plan (the IDP is everyone's,
        # Chris 2026-10-19): an independent query for the second half
        _own = {r[0] for r in db.execute("SELECT id FROM users WHERE manager_id=? AND role!='admin' AND "
                                         "COALESCE(is_demo,0)=0 AND " + a.idp_participant_sql(), (mgr["id"],))}
        s.check("IDP plan-review population = the PM review population + their own direct reports with a plan",
                idp_ids == pm_ids | _own and pm_ids <= idp_ids, (len(pm_ids), len(_own), len(idp_ids)))
        tm_ids = {r["id"] for r in a._journey_team_reports(db, mgr, "tm_review")}
        s.check("TM review population is its own list (line-managed reports w/ competencies)",
                isinstance(tm_ids, set))
        # The nav projection: one item per report, kind team, all clickable (done marked).
        nav = a._journey_team_nav_items(db, mgr, "pm_review")
        s.check("the team nav is kind=team with one item per report",
                nav["kind"] == "team" and len(nav["items"]) == len(pm_ids), nav["kind"])
        s.check("every report item carries a name + done flag + meta",
                all("name" in it and "done" in it and "meta" in it for it in nav["items"]))
        # Auth clamp: a crafted report id can only ever resolve to one of the manager's own.
        crafted = a._journey_active_report(db, mgr, "pm_review", 10 ** 9)
        s.check("a crafted ?report= is clamped to the manager's own population",
                crafted in pm_ids, crafted)

# ---------------------------------------------------------------------------
s.section("the review table carries the report's OWN entered result (the extra column)")
with a.app.test_request_context("/review/journey"):
    from flask import session as _sess
    db = a.get_db()
    period = a.active_pm_period(db)
    mgr = _find_manager(db, period["id"]) if period else None
    if not mgr:
        s.check("SKIP: no manager to build a review table for", True)
    else:
        _sess["user_id"] = mgr["id"]
        report = a._journey_active_report(db, mgr, "pm_review", None)
        ov = a._journey_team_overview(db, mgr, "pm_review", report)
        s.check("the overview is tagged pm_review with the focused report's data",
                ov["stage"] == "pm_review" and (ov["data"] or {}).get("report_id") == report, ov["stage"])
        lines = (ov["data"] or {}).get("lines") or []
        s.check("each KPI line exposes the report's entered value + rating + band beside "
                "the moderated value (the reference column)",
                all(set(("report_value", "report_rating", "report_band",
                         "mod_value", "mod_band")) <= set(l) for l in lines), len(lines))
        # Phase 2a: each line also carries the target id + moderation affordances so the
        # client can drive the EXISTING moderate routes, and `actionable` matches the one
        # gate those routes enforce (_pm_line_actionable_by) -- never surfaced looser.
        s.check("each KPI line carries id + actionable + draft fields for moderation",
                all(set(("id", "actionable", "draft_value", "draft_justification")) <= set(l)
                    for l in lines), len(lines))
        mine, _mp, _sp, _al = a._pm_member_previews(db, report, period["id"], mgr["id"])
        by_id = {t["id"]: t for t in mine}
        s.check("a line's `actionable` equals _pm_line_actionable_by for its target "
                "(the journey never opens a line the write route would reject)",
                all(l["actionable"] == a._pm_line_actionable_by(by_id[l["id"]], mgr["id"])
                    for l in lines if l["id"] in by_id), len(lines))
        s.check("a locked line is never actionable (read-only in the widget)",
                all((not l["actionable"]) for l in lines if l.get("locked")))

# ---------------------------------------------------------------------------
s.section("Phase 2b TM: each competency carries id + actionable + mod_remark; "
          "actionable == assessment 'submitted' (the write route's own gate)")
with a.app.test_request_context("/review/journey"):
    from flask import session as _sess
    db = a.get_db()
    mgr, cid, reports = _find_tm_manager(db)
    if not mgr:
        s.check("SKIP: no line manager with a competency report in this database", True)
    else:
        _sess["user_id"] = mgr["id"]
        rep = reports[0]
        data = a._journey_team_tm_data(db, mgr, rep["id"], rep["full_name"])
        items = [it for g in data["groups"] for it in g["items"]]
        s.check("every competency item carries id + actionable + mod_remark",
                all(set(("id", "actionable", "mod_remark")) <= set(it) for it in items), len(items))
        s.check("the envelope carries reviewed + can_approve", "reviewed" in data and "can_approve" in data)
        # can_approve mirrors the /approve completeness gate: every line has an effective rating.
        arow = db.execute("SELECT id, status FROM tc_assessments WHERE subject_id=? AND cycle_id=?",
                          (rep["id"], cid)).fetchone()
        rows, _g = a._tc_rows(db, cid, rep["id"], (arow["id"] if arow else None))
        s.check("can_approve == submitted and every competency has an effective rating (a draft never shows)",
                data["can_approve"] == (bool(arow and arow["status"] == "submitted") and bool(rows)
                                        and all(r.get("effective") for r in rows)),
                data["can_approve"])
        # THE invariant (mirrors the PM actionable==gate check): across EVERY report the
        # manager owns, a line is actionable iff the assessment is 'submitted', and a
        # 'reviewed' (locked) assessment opens nothing -- so the widget never opens a
        # control technical_review_autosave/approve would then reject.
        ok = True
        for rr in reports:
            d = a._journey_team_tm_data(db, mgr, rr["id"], rr["full_name"])
            st = d["status"]
            its = [it for g in d["groups"] for it in g["items"]]
            if not all(it["actionable"] == (st == "submitted") for it in its):
                ok = False
            if d["reviewed"] != (st == "reviewed"):
                ok = False
            if st == "reviewed" and any(it["actionable"] for it in its):
                ok = False
        s.check("across ALL reports: actionable iff submitted; reviewed -> reviewed flag & no item actionable", ok)

# ---------------------------------------------------------------------------
s.section("Phase 2b IDP: goals carry id + actionable(==shared); plan/career/conversation "
          "surfaced; can_close & closed track status; career always commentable")
with a.app.test_request_context("/review/journey"):
    from flask import session as _sess
    db = a.get_db()
    period = a.active_pm_period(db)
    mgr = _find_manager(db, period["id"]) if period else None
    if not mgr:
        s.check("SKIP: no manager for the IDP plan-review checks", True)
    else:
        _sess["user_id"] = mgr["id"]
        reports = a._journey_team_reports(db, mgr, "plan_review")
        s.check("plan-review population is non-empty", bool(reports), len(reports))
        ok = True
        n_goals = 0
        n_actionable = 0
        seen = set()
        for rr in reports:
            d = a._journey_team_plan_data(db, mgr, rr["id"], rr["name"])
            seen.add(str(d["status"]))
            # envelope shape
            if not (set(("manager_comment", "plan_actionable", "career",
                         "conversation", "closed", "can_close")) <= set(d)):
                ok = False
            shared = (d["status"] == "shared")
            if d["plan_actionable"] != shared or d["can_close"] != shared:
                ok = False
            if d["closed"] != (d["status"] == "closed"):
                ok = False
            # every goal carries the write handle + an actionable flag == plan shared
            for g in d["goals"]:
                n_goals += 1
                if not (set(("id", "actionable", "manager_comment")) <= set(g)):
                    ok = False
                if g["actionable"] != shared:
                    ok = False
                if g["actionable"]:
                    n_actionable += 1
            # career block always present + always commentable (route gates on approver only)
            car = d["career"]
            if not (set(("aspiration_now", "strengths", "mobility",
                         "career_comment", "career_actionable")) <= set(car)):
                ok = False
            if car["career_actionable"] is not True:
                ok = False
        s.check("every plan-review report holds the full shape and the actionable/close/closed "
                "invariants (statuses seen: %s)" % ",".join(sorted(seen)), ok)
        s.check("(info) goals projected: %d, of which actionable (shared plans): %d"
                % (n_goals, n_actionable), True)
        # The fixture may hold no shared plans, which would leave the goal-level
        # invariant vacuous -- so seed one plan + goal and drive shared/draft/closed
        # deterministically (a test must reach the line it asserts). Restored after.
        if reports:
            subj = reports[0]["id"]
            yr = a.pm_idp_plan_year(period)
            pre = a.pm_idp_for(db, yr, subj)          # None if this report has no plan yet
            idp = a.pm_idp_for(db, yr, subj, create=True)
            orig_status = idp["status"]
            gid = db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, action_experience) "
                             "VALUES (?,?,?,?)", (idp["id"], 999, "Phase2b test goal", "Lead")).lastrowid
            db.commit()
            try:
                for st, act, closed in (("shared", True, False),
                                        ("draft", False, False),
                                        ("closed", False, True)):
                    # a real agreed plan was SHARED first (a plan closed straight from draft stays private)
                    db.execute("UPDATE pm_idp SET status=?, shared_at=CASE WHEN ?='draft' THEN NULL "
                               "ELSE datetime('now') END WHERE id=?", (st, st, idp["id"]))
                    db.commit()
                    d = a._journey_team_plan_data(db, mgr, subj, "Test")
                    g = next((x for x in d["goals"] if x["id"] == gid), None)
                    if st == "draft":
                        # A DRAFT plan is private to its author (as on the classic pages) -- the
                        # manager's journey no longer projects its goals (2026-09-24).
                        s.check("IDP status=draft -> its goals are PRIVATE (not projected to the manager)",
                                g is None and d["goals"] == [], d["goals"])
                        s.check("...and it is summarised as not shared, with no remark to write",
                                d.get("ai_summary") == "No development plan shared yet." and d.get("remark_open") is False,
                                (d.get("ai_summary"), d.get("remark_open")))
                    else:
                        s.check("IDP status=%s -> goal carries id + actionable==%s" % (st, act),
                                g is not None and g["actionable"] == act, st)
                        s.check("IDP status=%s -> the overall remark is open only while shared" % st,
                                d.get("remark_open") is act, d.get("remark_open"))
                    s.check("IDP status=%s -> plan_actionable & can_close == %s" % (st, act),
                            d["plan_actionable"] == act and d["can_close"] == act, st)
                    s.check("IDP status=%s -> closed flag == %s; career comment stays open" % (st, closed),
                            d["closed"] == closed and d["career"]["career_actionable"] is True, st)
            finally:
                db.execute("DELETE FROM pm_idp_goals WHERE id=?", (gid,))
                if pre is None:
                    db.execute("DELETE FROM pm_idp WHERE id=?", (idp["id"],))
                else:
                    db.execute("UPDATE pm_idp SET status=? WHERE id=?", (orig_status, idp["id"]))
                db.commit()

# ---------------------------------------------------------------------------
s.section("Team-summary <-> Individual toggle: mode resolves, summary lists every member")
s.check("mode defaults to summary; only 'detail' flips it",
        a._journey_active_team_mode(None) == "summary"
        and a._journey_active_team_mode("detail") == "detail"
        and a._journey_active_team_mode("junk") == "summary")
with a.app.test_request_context("/review/journey"):
    from flask import session as _sess
    db = a.get_db()
    period = a.active_pm_period(db)
    mgr = _find_manager(db, period["id"]) if period else None
    if not mgr:
        s.check("SKIP: no manager for the summary/detail checks", True)
    else:
        _sess["user_id"] = mgr["id"]
        pm_ids = {r["id"] for r in a._journey_team_reports(db, mgr, "pm_review")}
        summ = a._journey_team_summary(db, mgr, "pm_review")
        s.check("the PM summary is one row per report, each carrying a final score field",
                summ["kind"] == "team_summary"
                and {r["id"] for r in summ["rows"]} == pm_ids
                and all("score" in r and "band" in r and "status" in r for r in summ["rows"]),
                len(summ["rows"]))
        # The overview picks summary vs a single report's detail off `mode`.
        ov_sum = a._journey_team_overview(db, mgr, "pm_review", None, "summary")
        s.check("mode=summary -> the whole-team table (kind team_summary)",
                (ov_sum["data"] or {}).get("kind") == "team_summary")
        rep = a._journey_active_report(db, mgr, "pm_review", None)
        ov_det = a._journey_team_overview(db, mgr, "pm_review", rep, "detail")
        s.check("mode=detail -> that one report's KPI table (kind pm_review, with lines)",
                (ov_det["data"] or {}).get("kind") == "pm_review"
                and "lines" in (ov_det["data"] or {}))
        # The competency summary counts demonstrated / total per member.
        tsum = a._journey_team_summary(db, mgr, "tm_review")
        s.check("the competency summary carries demonstrated/total per member",
                tsum["kind"] == "team_summary"
                and all(("demonstrated" in r and "total" in r) for r in tsum["rows"]),
                len(tsum["rows"]))
        # The plan summary (UX review F17 / F24): who has SHARED a plan (a draft is theirs alone), its goal count, and
        # none_shared -- checked against an independent read, then with a shared plan put in for one report.
        _yr = a.pm_idp_plan_year(period)

        def _indep_shared(sid):
            r0 = db.execute("SELECT status FROM pm_idp WHERE subject_id=? AND plan_year=?", (sid, _yr)).fetchone()
            return bool(r0 and r0["status"] in ("shared", "closed"))
        psum = a._journey_team_summary(db, mgr, "plan_review")
        s.check("the plan summary marks who has shared a plan (independent read); only a shared plan carries a goal count",
                psum["rows"] and all(r["shared"] == _indep_shared(r["id"]) for r in psum["rows"])
                and all((r["goals"] is None) == (not r["shared"]) for r in psum["rows"])
                and psum["none_shared"] == (not any(_indep_shared(r["id"]) for r in psum["rows"])),
                [(r["id"], r["shared"], r["goals"]) for r in psum["rows"]][:4])
        _pr = psum["rows"][0]["id"] if psum["rows"] else None
        _had = db.execute("SELECT id FROM pm_idp WHERE subject_id=? AND plan_year=?", (_pr, _yr)).fetchone() if _pr else None
        if _pr and not _had:
            _iid = db.execute("INSERT INTO pm_idp(plan_year, subject_id, status, shared_at) VALUES (?,?,'shared',"
                              "datetime('now'))", (_yr, _pr)).lastrowid
            db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area) VALUES (?,1,'Cost control'), (?,2,'Pricing'), "
                       "(?,3,'')", (_iid, _iid, _iid))
            db.commit()
            psum2 = a._journey_team_summary(db, mgr, "plan_review")
            _r2 = next(r for r in psum2["rows"] if r["id"] == _pr)
            s.check("...a shared plan: shared, its goals counted (a blank goal isn't one), and the summary isn't 'none shared'",
                    _r2["shared"] is True and _r2["goals"] == 2 and psum2["none_shared"] is False, (_r2, psum2["none_shared"]))
            db.execute("DELETE FROM pm_idp WHERE id=?", (_iid,))
            db.execute("DELETE FROM pm_idp_summaries WHERE subject_id=?", (_pr,))
            db.commit()
        else:
            s.check("SKIP: the first report already has a plan this year (the inserted-plan check needs one without)", True)

# ---------------------------------------------------------------------------
s.section("GET ?view=team renders the team chrome for a manager; non-manager -> mine")
with a.app.app_context():
    a.get_db().execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('review_unified','1')")
    a.get_db().commit()
with a.app.test_request_context("/review/journey"):
    from flask import session as _sess
    db = a.get_db()
    period = a.active_pm_period(db)
    mgr = _find_manager(db, period["id"]) if period else None
if mgr:
    E = H.client_as(a, mgr["id"])
    html = E.get("/review/journey?view=team").get_data(as_text=True)
    manages = None
    with a.app.test_request_context("/review/journey"):
        from flask import session as _sess
        _sess["user_id"] = mgr["id"]
        manages = a._review_manages(a.get_db(), mgr)
    if manages:
        s.check("a manager's ?view=team renders the team view", 'data-view="team"' in html, manages)
        s.check("...with the KPI Review label + no 360 tab",
                # the asset version (?v=<newest static file's time>) can hold "360" by chance: it isn't a 360 tab
                "KPI Review" in html and "360" not in re.sub(r"\?v=\d+", "", re.sub(r"<script.*?</script>", "", html,
                                                                                       flags=re.S)))
        # The employee (mine) journey is unaffected for the same person.
        mine = E.get("/review/journey").get_data(as_text=True)
        s.check("the same manager's plain /review/journey is still the employee view",
                'data-view="mine"' in mine)
    else:
        s.check("SKIP: this manager is not _review_manages (no data-driven manager path)", True)
    # A non-manager forcing ?view=team falls back to the employee view.
    with a.app.app_context():
        nonmgr = a.get_db().execute(
            "SELECT id FROM users WHERE role!='admin' AND left_at IS NULL "
            "AND id NOT IN (SELECT DISTINCT approver_id FROM pm_kpi_target_approvers) "
            "AND id NOT IN (SELECT DISTINCT manager_id FROM users WHERE manager_id IS NOT NULL) "
            "LIMIT 1").fetchone()
    if nonmgr:
        html2 = H.client_as(a, nonmgr["id"]).get("/review/journey?view=team").get_data(as_text=True)
        s.check("a non-manager forcing ?view=team falls back to the employee view",
                'data-view="mine"' in html2)
else:
    s.check("SKIP: no manager for the GET checks", True)
with a.app.app_context():
    a.get_db().execute("DELETE FROM app_settings WHERE key='review_unified'")
    a.get_db().commit()

# ---------------------------------------------------------------------------
# The manager's IDP step (Chris, 2026-09-24): an AI summary of each report's SHARED plan, and the
# manager's job is ONE overall remark on it (~100 words).
s.section("manager TM: potential band (competency alone), AI summary, and the person's own view (Chris, 2026-09-25)")
with a.app.test_request_context("/review/journey"):
    from flask import session as _sess
    db = a.get_db()
    mgr, cid, reports = _find_tm_manager(db)
    if not mgr:
        s.check("SKIP: no line manager with a competency report in this database", True)
    else:
        _sess["user_id"] = mgr["id"]
        rep = reports[0]
        rid = rep["id"]
        _a0 = db.execute("SELECT * FROM tc_assessments WHERE subject_id=? AND cycle_id=?", (rid, cid)).fetchone()
        _a0 = dict(_a0) if _a0 else None
        _sc0 = [dict(r) for r in db.execute("SELECT * FROM tc_scores WHERE assessment_id=?",
                                            (_a0["id"],))] if _a0 else []
        _cfg0, _sum0 = a.ai_draft.is_configured, a.ai_draft.summarise_competency
        try:
            if not _a0:
                db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?,'pending')", (cid, rid))
            aid = db.execute("SELECT id FROM tc_assessments WHERE subject_id=? AND cycle_id=?", (rid, cid)).fetchone()["id"]
            asg = [r["id"] for r in db.execute("SELECT id FROM tc_assignments WHERE subject_id=? AND cycle_id=?",
                                               (rid, cid))]
            db.execute("DELETE FROM tc_scores WHERE assessment_id=?", (aid,))
            db.execute("DELETE FROM tc_summaries WHERE subject_id=?", (rid,))

            def _answer(self_ans, mgr_ans=None, status="submitted", remark="I led the Q3 cost review myself."):
                db.execute("DELETE FROM tc_scores WHERE assessment_id=?", (aid,))
                for x in asg:
                    db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer, manager_answer, remark) "
                               "VALUES (?,?,?,?,?)", (aid, x, self_ans, mgr_ans, None))
                db.execute("UPDATE tc_assessments SET status=?, overall_remark=? WHERE id=?", (status, remark, aid))
                db.commit()
            # -- the band follows the answers, by the product's own rule (independent relationships, not numbers)
            _answer("yes", status="pending")
            s.check("a DRAFT self-assessment gives no band (it is private to its author)",
                    a._tc_competency_band(db, rid, cid, "self") is None
                    and a._tc_competency_band(db, rid, cid, "effective") is None)
            _pd = a._journey_team_tm_data(db, mgr, rid, rep["full_name"])
            _pit = [it for g in _pd["groups"] for it in g["items"]]
            s.check("...and the manager's Individual view shows none of their draft answers or remark",
                    all(it["report_answer"] is None and not it["report_remark"] for it in _pit)
                    and not _pd["report_remark"] and _pd["band"] is None, [it["report_answer"] for it in _pit][:3])
            _answer("yes")
            s.check("submitted, everything Demonstrate -> High, by their own answers and with your calls",
                    a._tc_competency_band(db, rid, cid, "self") == "High"
                    and a._tc_competency_band(db, rid, cid, "effective") == "High")
            _answer("yes", mgr_ans="no")
            s.check("your calls move the 'with your calls' band (all Developing -> Low) while theirs stays High",
                    a._tc_competency_band(db, rid, cid, "effective") == "Low"
                    and a._tc_competency_band(db, rid, cid, "self") == "High")
            _answer("no")
            s.check("everything Developing -> Low", a._tc_competency_band(db, rid, cid, "self") == "Low")
            # -- the Team summary row + the Individual view carry the band, the summary and the level
            _answer("yes")
            _row = next((r for r in a._journey_team_summary(db, mgr, "tm_review")["rows"] if r["id"] == rid), {})
            s.check("the TM Team summary row carries the band (with your calls + theirs) and the summary fields",
                    _row.get("band") == "High" and _row.get("self_band") == "High"
                    and "ai_summary" in _row and _row.get("summary_pending") is True
                    and _row.get("demonstrated") == len(asg), _row)
            _td = a._journey_team_tm_data(db, mgr, rid, rep["full_name"])
            _its = [it for g in _td["groups"] for it in g["items"]]
            s.check("the Individual view: the band, their remark, and each card's level + descriptor + ability items",
                    _td["band"] == "High" and "Q3 cost review" in _td["report_remark"]
                    and all(it.get("level") in ("current", "next") and "detail" in it and "ability_items" in it
                            for it in _its), (_td["band"], _td["report_remark"]))
            # -- the summary: source, check, plain fallback, cache, route
            _st, _first, _full, _src, _extra, _facts = a._tc_summary_source(db, rid, cid)
            s.check("the summary source is THEIR answers + remark, never the manager's calls",
                    "their answer: Demonstrate" in _src and "Q3 cost review" in _src and "Your call" not in _src, _src[:160])
            _t0 = (db.execute("SELECT title FROM tc_skills s JOIN tc_assignments t ON t.skill_id=s.id WHERE t.id=?",
                              (asg[0],)).fetchone() or ["x"])[0]
            # current level Demonstrate, next level Developing: ONE competency, reported once per list
            db.execute("UPDATE tc_scores SET answer=CASE WHEN (SELECT is_future FROM tc_assignments WHERE id="
                       "tc_scores.assignment_id)=1 THEN 'no' ELSE 'yes' END WHERE assessment_id=?", (aid,))
            db.commit()
            _fx = a._tc_summary_source(db, rid, cid)[5]
            _pl = a._tc_summary_plain(_first, _fx, "submitted")
            s.check("the plain summary never lists one competency as both demonstrated and still developing "
                    "(its next level is reported apart)",
                    not (set(_fx["demo"]) & set(_fx["dev"])) and set(_fx["next_dev"]) <= set(_fx["demo"])
                    and _pl.count("”.") == 0, (_fx, _pl))
            _answer("yes")
            s.check("a faithful summary passes the check",
                    a._tc_summary_error(_src, _extra, "%s marked %s as Demonstrate and says they led the Q3 cost "
                                                     "review themselves." % (_first, _t0)) is None)
            _badw = next(w for w in ("seven", "nine", "eight", "six", "three") if w not in _extra.lower().split())
            s.check("...one that states a count they don't have is refused (no spelled numbers in the vocabulary)",
                    a._tc_summary_error(_src, _extra, "%s marks %s competencies as Demonstrate." % (_first, _badw))
                    is not None, _badw)
            s.check("...one that names something they never wrote is refused",
                    a._tc_summary_error(_src, _extra, "%s led the Singapore rollout of %s." % (_first, _t0)) is not None)
            s.check("...and one that talks about a band or score is refused (the band is the server's)",
                    a._tc_summary_error(_src, _extra, "%s is High potential on %s." % (_first, _t0)) is not None
                    and a._tc_summary_error(_src, _extra, "%s scored well on %s." % (_first, _t0)) is not None)
            a.ai_draft.is_configured = lambda: False
            _r = a._tc_summary_for(db, rid, generate=True)
            _ntit = len({r["title"] for r in db.execute(
                "SELECT s.title FROM tc_assignments t JOIN tc_skills s ON s.id=t.skill_id WHERE t.subject_id=? "
                "AND t.cycle_id=?", (rid, cid))})
            s.check("AI off -> the plain summary, from their stored answers, counted in competencies (one unit)",
                    _r["source"] == "plain" and ("demonstrates %d of %d competencies" % (_ntit, _ntit)) in _r["summary"],
                    _r)
            s.check("...cached: the Team summary now reads it without generating",
                    a._tc_summary_for(db, rid)["summary"] == _r["summary"])
            a.ai_draft.is_configured = lambda: True
            db.execute("DELETE FROM tc_summaries WHERE subject_id=?", (rid,)); db.commit()
            _aion0 = a.ai_on
            a.ai_on = lambda k: True
            a.ai_draft.summarise_competency = lambda first, txt, **k: "%s marked %s as Demonstrate." % (first, _t0)
            _r = a._tc_summary_for(db, rid, generate=True)
            s.check("AI on and it holds up -> 'ai'", _r["source"] == "ai" and _t0 in _r["summary"], _r)
            db.execute("DELETE FROM tc_summaries WHERE subject_id=?", (rid,)); db.commit()
            a.ai_draft.summarise_competency = lambda first, txt, **k: "%s is a High potential leader in Singapore." % first
            s.check("AI that invents or bands -> the plain summary", a._tc_summary_for(db, rid, generate=True)["source"] == "plain")
            db.execute("DELETE FROM tc_summaries WHERE subject_id=?", (rid,)); db.commit()

            def _boom(*x, **k):
                raise TimeoutError("slow")
            a.ai_draft.summarise_competency = _boom
            s.check("...and so does a bare timeout", a._tc_summary_for(db, rid, generate=True)["source"] == "plain")
            # -- THE VERDICT (Chris, 2026-09-25): are their self-ratings justified? the floor + the model's JSON
            _answer("yes")   # everything Demonstrate, no reasons, a one-line remark
            _fxv = a._tc_summary_source(db, rid, cid)[5]
            _v, _vw, _vs = a._tc_insight(_first, _fxv)
            s.check("TM verdict floor: everything Demonstrate with no reason for any and a one-line remark -> not "
                    "justified, with a step to ask for examples", _v == "not_justified" and "no reason" in _vw and _vs,
                    (_v, _vw, _vs))
            db.execute("DELETE FROM tc_summaries WHERE subject_id=?", (rid,)); db.commit()
            a.ai_draft.summarise_competency = lambda first, txt, **k: a.json.dumps({
                "verdict": "well_justified", "verdict_why": "%s marked %s as Demonstrate." % (first, _t0),
                "paragraph": "%s marked %s as Demonstrate." % (first, _t0), "discuss": []})
            _rv = a._tc_summary_for(db, rid, generate=True)
            s.check("...the model can't lift it: its 'well justified' gives way to the floor (its paragraph kept)",
                    _rv["source"] == "ai" and _rv["data"]["verdict"] == "not_justified" and _rv["data"]["verdict_why"] == _vw,
                    _rv.get("data"))
            s.check("...stored with the summary, so the Team summary reads the verdict from the cache",
                    (a._tc_summary_for(db, rid).get("data") or {}).get("verdict") == "not_justified")
            db.execute("UPDATE tc_scores SET remark='I ran the monthly variance review and presented it to the plant head.' "
                       "WHERE assessment_id=?", (aid,))
            db.execute("UPDATE tc_assessments SET overall_remark=? WHERE id=?", (
                "I am still developing %s: I have not yet run it on my own and need more practice." % _t0, aid))
            db.commit()
            _fxc = a._tc_summary_source(db, rid, cid)[5]
            _vc = a._tc_insight(_first, _fxc)
            s.check("...a remark saying they are still developing what they marked Demonstrate is flagged (not 'well')",
                    _vc[0] in ("partly_justified", "not_justified") and "still developing" in _vc[1]
                    and any("still developing" in x for x in _vc[2]), _vc)
            db.execute("UPDATE tc_scores SET remark='Did it.' WHERE assessment_id=?", (aid,))
            db.execute("UPDATE tc_assessments SET overall_remark=? WHERE id=?", (
                "I am strongest on cost control: I rebuilt the monthly variance report and walked the plant head through "
                "it every month. Next half I want to lead the plant's cost review on my own.", aid))
            db.commit()
            s.check("...a reason of a few words ('Did it.') backs nothing -- the claims still count as unreasoned",
                    a._tc_summary_source(db, rid, cid)[5]["n_reasoned"] == 0)
            db.execute("UPDATE tc_scores SET remark='I ran the monthly variance review and presented it to the plant head.' "
                       "WHERE assessment_id=?", (aid,))
            db.commit()
            _fxw = a._tc_summary_source(db, rid, cid)[5]
            s.check("...with a reason behind every claim and a real remark, the floor allows 'well justified'",
                    a._tc_insight(_first, _fxw)[0] == "well_justified", a._tc_insight(_first, _fxw))
            db.execute("DELETE FROM tc_summaries WHERE subject_id=?", (rid,)); db.commit()
            a.ai_draft.summarise_competency = lambda first, txt, **k: a.json.dumps({
                "verdict": "partly_justified",
                "verdict_why": "Every reason they gave is the monthly variance review.",
                "paragraph": "%s marked %s as Demonstrate." % (first, _t0),
                "discuss": ["Ask for an example of %s beyond the monthly variance review." % _t0]})
            _rv2 = a._tc_summary_for(db, rid, generate=True)
            s.check("...a MORE critical model is kept, with its why and its suggested step",
                    (_rv2.get("data") or {}).get("verdict") == "partly_justified"
                    and "monthly variance review" in (_rv2.get("data") or {}).get("verdict_why", "")
                    and any(_t0 in x for x in (_rv2.get("data") or {}).get("discuss", [])), _rv2.get("data"))
            a.ai_draft.summarise_competency = lambda first, txt, **k: "%s marked %s as Demonstrate." % (first, _t0)
            db.execute("DELETE FROM tc_summaries WHERE subject_id=?", (rid,)); db.commit()
            _rv3 = a._tc_summary_for(db, rid, generate=True)
            s.check("...a plain-prose reply (the older contract) still works, with the server's verdict",
                    _rv3["source"] == "ai" and (_rv3.get("data") or {}).get("verdict") == "well_justified", _rv3.get("data"))
            db.execute("DELETE FROM tc_summaries WHERE subject_id=?", (rid,)); db.commit()
            a.ai_on = _aion0
            _answer("no", mgr_ans="yes")
            s.check("a change to their answers invalidates the cached summary (pending again)",
                    a._tc_summary_for(db, rid)["pending"] is True)
            _answer("yes")
            _C = H.client_as(a, mgr["id"])
            a.ai_draft.is_configured = lambda: False
            _rr = _C.post("/review/team/tm-summary", data={"csrf_token": "tok", "report": str(rid)})
            s.check("POST /review/team/tm-summary for your own report -> the summary",
                    _rr.status_code == 200 and (_rr.get_json() or {}).get("summary"), _rr.status_code)
            _rr = _C.post("/review/team/tm-summary", data={"csrf_token": "tok", "report": "999999999"})
            s.check("...someone you don't line-manage -> 404", _rr.status_code == 404, _rr.status_code)
            # -- the agent sees the band + summary; an unsubmitted assessment gets a short 'nothing to review'
            _tk = a._journey_team_stage_task(db, mgr, "tm_review", rid)
            s.check("the TM agent task carries the band (competency alone, not the 360) and their remark",
                    "NOT the 360" in _tk and "Q3 cost review" in _tk and "Override any competency" in _tk, _tk[:200])
            _answer("yes", status="pending")
            _tk = a._journey_team_stage_task(db, mgr, "tm_review", rid)
            s.check("...a draft: nothing to review, never offer to rate or approve",
                    "NOT SUBMITTED" in _tk and "Override any competency" not in _tk, _tk[:200])
        finally:
            a.ai_draft.is_configured, a.ai_draft.summarise_competency = _cfg0, _sum0
            db.execute("DELETE FROM tc_summaries WHERE subject_id=?", (rid,))
            db.execute("DELETE FROM tc_scores WHERE assessment_id IN (SELECT id FROM tc_assessments WHERE subject_id=? "
                       "AND cycle_id=?)", (rid, cid))
            if _a0:
                cols = ",".join(_a0)
                db.execute("INSERT OR REPLACE INTO tc_assessments(%s) VALUES (%s)" % (cols, ",".join("?" * len(_a0))),
                           list(_a0.values()))
                for sc in _sc0:
                    c2 = ",".join(sc)
                    db.execute("INSERT INTO tc_scores(%s) VALUES (%s)" % (c2, ",".join("?" * len(sc))), list(sc.values()))
            else:
                db.execute("DELETE FROM tc_assessments WHERE subject_id=? AND cycle_id=?", (rid, cid))
            db.commit()
_jsp2 = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
_tmw = _jsp2[_jsp2.find("function tmReviewWidget("):_jsp2.find("function tcModerateBtns(")]
_tsw = _jsp2[_jsp2.find("  function teamSummaryWidget("):_jsp2.find("  // Wrap the toggle + the right widget")]
_stc = _jsp2[_jsp2.find("  function statusCell("):_jsp2.find("  function teamSummaryWidget(")]
s.check("client: the same four columns in PM, TM and IDP -- Team member, Result, AI insight, Status (UX review F17); the "
        "tick column only when someone can be approved in bulk",
        "<th>Team member</th><th class='rv-sum-result'>Result</th>" in _tsw and "Final score</th>" not in _tsw
        and "Potential<span" not in _tsw and "&& eligible > 0;" in _tsw
        and 'gc.textContent = r.goals + " goal" + (r.goals === 1 ? "" : "s");' in _tsw)
s.check("client: three status words (UX review F23) -- Review (the step is its tooltip and accessible name), Waiting on "
        "the row's own words (the reason on hover), Done",
        'rmkEl("span", null, "Review")' in _stc and "b.title = r.action;" in _stc
        and 'b.setAttribute("aria-label", r.action + " for "' in _stc
        and '(r.done ? "Done" : (r.status || "Waiting"))' in _stc and "c.title = r.wait_why || r.status;" in _stc)
s.check("client: no plan shared yet -> one line, not a table of dashes (UX review F24)",
        'data.none_shared' in _tsw and "No plans shared yet; each appears here when it's shared." in _tsw)
s.check("client: the TM Team summary carries the potential band in its Result column and the AI insight icon",
        "tmBandPill(r.band, r.self_band, r.band_basis)" in _jsp2 and '(stage === "tm_review" ? "tm" : null)' in _jsp2
        and '"/review/team/tm-summary"' in _jsp2 and "function rmkStore(kind)" in _jsp2)
s.check("client: the TM Individual view follows the person's own view -- one competency a page between the "
        "side strips (2026-10-21), each card's descriptor + ability items (and the fold) + level",
        "bezelWrap(page, mtc.section, groups.length" in _tmw and "tcPageHead(g, mtc.section" in _tmw
        and "rv-tc-detail" in _tmw and "tcAbilities(abil," in _tmw and "rv-tc-level" in _tmw
        and "data-tmsum-report" in _tmw and "function mtcPage(" in _jsp2)
s.check("client: your call refreshes the band line in place (no rebuild: quick clicks + focus survive)",
        "tmBandRefresh(rid);" in _jsp2[_jsp2.find("function tcModerate("):][:1500]
        and "function tmBandRefresh(" in _jsp2 and "seq !== tmBandSeq" in _jsp2)
s.check("client: paging reuses the fetched summary (the cached payload is marked answered, no re-fetch)",
        "mtc.data.summary_pending = false;" in _jsp2
        and "if (data.summary_pending && !tmSummaries[rid]) queueTmSummary(rid, true);" in _jsp2)
_css2 = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
s.check("css: the 260px text basis applies only above phone width (on a phone the row is a column)",
        "@media (min-width: 561px) {   /* on a phone the row is a column" in _css2)
_stm = {"period": {"half": 2}, "stages": [{"key": k, "group": "team", "state": "open", "short": k} for k in ("pm_review", "tm_review",
                                                                                       "plan_review")]}
_offer = [{"role": "user", "content": "lock it"},
          {"role": "agent", "content": "Locked. Everyone here is reviewed -- shall we go to TM Review?",
           "quick_replies": ["Go to TM Review"]}]
_noffer = [{"role": "agent", "content": "Locked -- that's final.", "quick_replies": []}]
_mv = lambda m, h=None: a._team_move_asked(_stm, "pm_review", m, h)
s.check("the model may switch part only when asked, or on a yes to a move the agent just offered",
        not _mv("ok thanks, what's next?") and not _mv("Ok thanks, what\u2019s next?")
        and not _mv("ok thanks", _noffer) and _mv("ok thanks", _offer) and _mv("yes", _offer) and not _mv("yes", _noffer)
        and _mv("No, take me to TM") and _mv("No worries, go to IDP") and _mv("Wait, actually take me to competency review")
        and not _mv("no, stay here", _offer) and _mv("next part please") and _mv("TM please")
        and not _mv("what does TM cover for Aisha?") and not _mv("go to PM")
        and "_team_move_asked(st, active_stage, msg, prior_history)" in SRC)
s.check("a chip carrying an internal id is dropped ('Rate Cost Analysis (6569)')",
        'not re.search(r"\\(\\s*#?\\d+\\s*\\)|#\\d+", str(q))' in SRC)
s.check("the default person is the first with something to do (not someone who hasn't submitted)",
        'ready = next((r["id"] for r in reports if not r["done"] and r.get("action")), None)' in SRC)

s.section("manager IDP: AI summary per report (checked, cached, plain fallback) + the one overall remark")
_chk = a._idp_summary_error
_plan = ("Goal: Supplier negotiation. By 2027-03-31. On the job: Lead the Q3 vendor review. "
         "From others: Shadow the procurement head.\nAspiration now: Grow into a senior buyer role. "
         "Mobility: Open to a move within the business group.")
_ex = "Aisha Rahman Aisha 1 one March 2027"
_good = ("Aisha's plan has one goal: supplier negotiation by March 2027, by leading the Q3 vendor review and "
         "shadowing the procurement head. She wants to grow into a senior buyer role and is open to a move "
         "within the business group.")
s.check("a faithful summary passes the check", _chk(_plan, _ex, _good) is None, _chk(_plan, _ex, _good))
s.check("...an invented qualification / place is refused (the word check alone let it through)",
        _chk(_plan, _ex, _good + " She also wants an MBA and to lead the Singapore office.") is not None)
s.check("...an invented figure is refused",
        _chk(_plan, _ex, _good.replace("one goal", "one goal and five milestones")) is not None)
s.check("...and so is an essay", _chk(_plan, _ex, " ".join(["plan"] * 130)) is not None)
s.check("an ordinary verb opening a sentence is fine ('Aspires to...' -- a false refusal seen on gpt-5-mini)",
        _chk(_plan, _ex, _good + " Aspires to grow into a senior buyer role.") is None)
s.check("...an invented name that STARTS a sentence is refused too (review, 2026-09-24)",
        _chk(_plan, _ex, _good + " Singapore is where she hopes to move.") is not None)
s.check("...but a spelled-out number the plan gives in digits passes ('1-3 years' -> 'three years')",
        _chk(_plan + "\nIn 1-3 years: Lead a category team.", _ex + " three one",
             _good + " Within three years she aims to lead a category team.") is None)
s.check("a possessive or apostrophe name is still the person (\"'Ain's plan\" -- found in the full run)",
        _chk("Goal: Supplier negotiation.", "'AIN ZAKIRAH 'Ain 1 one",
             "'Ain's plan has one goal: supplier negotiation, alongside Aisha.") is not None
        and _chk("Goal: Supplier negotiation.", "'AIN ZAKIRAH 'Ain 1 one",
                 "'Ain's plan has one goal: supplier negotiation.") is None)
with a.app.test_request_context("/"):
    from flask import session as _ms
    db = a.get_db()
    period = a.active_pm_period(db)
    mgr = _find_manager(db, period["id"]) if period else None
    reps = a._pm_approver_subject_ids(db, mgr, period["id"]) if mgr else []
    if mgr and reps:
        _ms["user_id"] = mgr["id"]
        subj = reps[0]
        yr = a.pm_idp_plan_year(period)
        _pre = a.pm_idp_for(db, yr, subj)
        _idp = a.pm_idp_for(db, yr, subj, create=True)
        _orig = (_idp["status"], _idp.get("manager_comment"))
        _orig_mgr = db.execute("SELECT manager_id FROM users WHERE id=?", (subj,)).fetchone()["manager_id"]
        db.execute("UPDATE users SET manager_id=? WHERE id=?", (mgr["id"], subj))   # the remark owner
        _g = db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, action_experience, target_date) "
                        "VALUES (?,?,?,?,?)", (_idp["id"], 998, "Summary test goal", "Lead the vendor review",
                                               "2027-03-31")).lastrowid
        db.execute("UPDATE pm_idp SET status='draft', manager_comment=NULL WHERE id=?", (_idp["id"],))
        db.execute("DELETE FROM pm_idp_summaries WHERE subject_id=?", (subj,))
        db.commit()
        _real_cfg, _real_sum = ai_draft.is_configured, getattr(ai_draft, "assess_idp_fit", None)
        try:
            d0 = a._idp_summary_for(db, subj, generate=True)
            s.check("a DRAFT plan is not summarised (private): 'No development plan shared yet.'",
                    d0["summary"] == "No development plan shared yet." and d0["source"] == "none", d0)
            db.execute("UPDATE pm_idp SET status='shared' WHERE id=?", (_idp["id"],)); db.commit()
            p0 = a._idp_summary_for(db, subj, generate=False)
            s.check("a shared plan with no cached summary reads as pending (never generated inside a turn)",
                    p0["pending"] is True and p0["summary"] is None, p0)
            ai_draft.is_configured = lambda: False
            p1 = a._idp_summary_for(db, subj, generate=True)
            s.check("with the model off it falls back to a PLAIN summary built from their plan",
                    p1["source"] == "plain" and "Summary test goal" in (p1["summary"] or ""), p1)
            s.check("...and it is cached: the next read is not pending",
                    a._idp_summary_for(db, subj, generate=False)["summary"] == p1["summary"])
            ai_draft.is_configured = lambda: True
            _real_idp = a.get_idp_settings
            a.get_idp_settings = lambda: tuple(list(_real_idp())[:3] + [True] + list(_real_idp())[4:])
            _asp = None
            try:
                db.execute("UPDATE pm_idp_goals SET action_exposure='Shadow the procurement head' WHERE id=?", (_g,))
                db.commit()
                s.check("editing the plan invalidates the cached summary (its fingerprint changed)",
                        a._idp_summary_for(db, subj, generate=False)["pending"] is True)
                # no direction stated, whatever the database holds: the synthetic fixture gives this person career
                # aspirations, so the server's own reading was 'fits' there and the kinder-verdict check below could
                # never fail closed (CI red since 2026-09-29). Put back in the finally.
                _asp = db.execute("SELECT aspiration_now, aspiration_mid, aspiration_long FROM pm_career_profile "
                                  "WHERE subject_id=?", (subj,)).fetchone()
                db.execute("UPDATE pm_career_profile SET aspiration_now=NULL, aspiration_mid=NULL, aspiration_long=NULL "
                           "WHERE subject_id=?", (subj,))
                db.commit()
                # the FIT insight (2026-09-29): JSON, every field checked; its verdict may be harsher than the
                # server's reading, never kinder (no direction stated -> the server says 'partly fits')
                ai_draft.assess_idp_fit = lambda first, src, **kw: json.dumps({
                    "verdict": "partly_fits", "verdict_why": "The goal is concrete, but no direction is stated.",
                    "paragraph": (first + "'s plan has a summary test goal, leading the vendor review and shadowing "
                                  "the procurement head."),
                    "discuss": ["Agree when the vendor review will start."]})
                p2 = a._idp_summary_for(db, subj, generate=True)
                s.check("with the model on, an insight that holds up against the plan is shown as the AI insight",
                        p2["source"] == "ai" and (p2["data"] or {}).get("kind") == "idp_fit", p2)
                ai_draft.assess_idp_fit = lambda first, src, **kw: json.dumps({
                    "verdict": "fits", "verdict_why": "The goal is concrete, with actions and a date.",
                    "paragraph": first + "'s plan has a summary test goal, leading the vendor review.", "discuss": []})
                db.execute("DELETE FROM pm_idp_summaries WHERE subject_id=?", (subj,)); db.commit()
                p2k = a._idp_summary_for(db, subj, generate=True)
                s.check("...but a KINDER verdict ('fits') keeps the whole AI reading off (server's 'partly fits')",
                        p2k["source"] == "plain" and (p2k["data"] or {}).get("verdict") == "partly_fits", p2k.get("data"))
                db.execute("UPDATE pm_idp_goals SET action_education='A negotiation course' WHERE id=?", (_g,))
                db.commit()
                ai_draft.assess_idp_fit = lambda first, src, **kw: json.dumps({
                    "verdict": "not_yet", "verdict_why": "Too early.",
                    "paragraph": first + " wants an MBA and to run the Singapore office within three years.",
                    "discuss": []})
                p3 = a._idp_summary_for(db, subj, generate=True)
                s.check("...an AI summary that invents is NOT shown -- the plain one is",
                        p3["source"] == "plain" and "Singapore" not in (p3["summary"] or ""), p3)
                ai_draft.assess_idp_fit = lambda first, src, **kw: (_ for _ in ()).throw(TimeoutError("slow"))
                db.execute("UPDATE pm_idp_goals SET action_education='A course' WHERE id=?", (_g,)); db.commit()
                s.check("...and a model failure of ANY kind (a bare timeout) falls back instead of erroring",
                        a._idp_summary_for(db, subj, generate=True)["source"] == "plain")
            finally:
                a.get_idp_settings = _real_idp
                if _asp is not None:
                    db.execute("UPDATE pm_career_profile SET aspiration_now=?, aspiration_mid=?, aspiration_long=? "
                               "WHERE subject_id=?", (_asp[0], _asp[1], _asp[2], subj))
                    db.commit()
            # the route: your own report -> 200; not yours -> 404
            _E = H.client_as(a, mgr["id"])
            _r1 = _E.post("/review/team/idp-summary", data={"csrf_token": "tok", "report": str(subj)})
            s.check("POST /review/team/idp-summary for your own report -> the summary",
                    _r1.status_code == 200 and (_r1.get_json() or {}).get("summary"), _r1.status_code)
            _stranger = db.execute("SELECT id FROM users WHERE id NOT IN (%s) AND role!='admin' LIMIT 1"
                                   % ",".join("?" * (len(reps) + 1)), tuple(reps) + (mgr["id"],)).fetchone()
            if _stranger:
                _r2 = _E.post("/review/team/idp-summary", data={"csrf_token": "tok", "report": str(_stranger["id"])})
                s.check("...someone who isn't your report -> 404 (never another person's plan)", _r2.status_code == 404)
            # the overall remark (comment_plan) + close rules
            cp = lambda txt: a._mgr_tool_comment_plan(db, mgr, None, subj, {"comment": txt})
            s.check("the overall remark rejects an essay (~100 words, generous cap)",
                    cp(" ".join(["good"] * (a._REVIEW_REMARK_MAX_WORDS + 40))).get("ok") is False)
            s.check("...and a template", cp("[Insert your remark here]").get("ok") is False)
            _rem = "A clear, practical plan. Leading the vendor review is the right stretch; I'll pair you with procurement."
            s.check("...a real remark saves on a SHARED plan", cp(_rem).get("ok") is True)
            _rows = {r["id"]: r for r in a._journey_team_reports(db, mgr, "plan_review")}
            s.check("with the remark in, the report is 'Ready to approve' (not done until approved, 2026-10-21)",
                    _rows[subj]["done"] is False and _rows[subj]["meta"] == "Ready to approve"
                    and _rows[subj]["action"] == "Approve the plan", _rows[subj])
            db.execute("UPDATE pm_idp SET manager_comment=NULL WHERE id=?", (_idp["id"],)); db.commit()
            _rows = {r["id"]: r for r in a._journey_team_reports(db, mgr, "plan_review")}
            s.check("...without it, a shared plan 'Needs your remark' (not done)",
                    _rows[subj]["done"] is False and _rows[subj]["meta"] == "Needs your remark", _rows[subj])
            db.execute("UPDATE pm_idp SET status='draft' WHERE id=?", (_idp["id"],)); db.commit()
            s.check("a DRAFT plan takes no remark", cp(_rem).get("ok") is False)
            s.check("...and cannot be closed (pm_idp_close would have closed a draft)",
                    a._mgr_tool_close_plan(db, mgr, None, subj, {}).get("ok") is False)
            db.execute("UPDATE pm_idp SET status='shared' WHERE id=?", (_idp["id"],)); db.commit()
            _facts = a._grounding_facts(db, mgr, None, "plan_review", report_id=subj)
            s.check("the own-words guard's facts include their shared plan on the IDP stage (a remark may repeat it)",
                    "Lead the vendor review" in _facts and "Summary test goal" in _facts)
            s.check("...but NOT on the KPI stage (a KPI justification can't lean on the plan text)",
                    "Lead the vendor review" not in a._grounding_facts(db, mgr, None, "pm_review", report_id=subj))
            # another approver in the chain: the LINE MANAGER owns the remark (while they approve one of the
            # person's KPI lines -- a line manager outside the chain owns nothing, review 2026-09-29)
            _t1 = db.execute("SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? ORDER BY id LIMIT 1",
                             (period["id"], subj)).fetchone()
            if _stranger and _t1:
                db.execute("INSERT OR IGNORE INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) "
                           "VALUES (?,9,?)", (_t1["id"], _stranger["id"]))
            db.execute("UPDATE users SET manager_id=? WHERE id=?", (_stranger["id"] if _stranger else None, subj))
            db.commit()
            if _stranger:
                s.check("an approver who is NOT the line manager can't write the overall remark",
                        cp(_rem).get("ok") is False)
                _rows = {r["id"]: r for r in a._journey_team_reports(db, mgr, "plan_review")}
                s.check("...and has nothing pending there ('Line manager to remark')",
                        _rows[subj]["done"] is True and _rows[subj]["meta"] == "Line manager to remark", _rows[subj])
                _pd = a._journey_team_plan_data(db, mgr, subj, "X")
                s.check("...the widget shows it as the line manager's remark, not writable",
                        _pd["remark_mine"] is False and _pd["remark_open"] is False)
            if _stranger and _t1:
                db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id=? AND approver_id=? AND seq=9",
                           (_t1["id"], _stranger["id"]))
            db.execute("UPDATE users SET manager_id=? WHERE id=?", (mgr["id"], subj)); db.commit()
            # a plan CLOSED straight from draft (the classic route does that) was never shared -> private
            db.execute("UPDATE pm_idp SET status='closed', shared_at=NULL WHERE id=?", (_idp["id"],)); db.commit()
            s.check("a plan closed without ever being shared stays private (no goals, no summary)",
                    a._journey_team_plan_data(db, mgr, subj, "X")["goals"] == []
                    and a._idp_summary_for(db, subj, generate=True)["summary"] == "No development plan shared yet.")
            db.execute("UPDATE pm_idp SET status='closed', shared_at=datetime('now') WHERE id=?", (_idp["id"],)); db.commit()
            s.check("the one write helper refuses to change an AGREED (closed) plan's remark -- classic page too",
                    (a._idp_plan_comment_write(db, mgr, period, subj, "late change")[1] or {}).get("reason") == "closed")
            _ts = a._journey_team_perf_summary(db, mgr)["idp"]
            s.check("summarize_team counts only CLOSED plans as agreed", _ts["agreed"] >= 1 and "remarked" in _ts, _ts)
            db.execute("UPDATE pm_idp SET status='shared' WHERE id=?", (_idp["id"],)); db.commit()
            s.check("...and the helper caps the remark at the same ~100-word limit",
                    (a._idp_plan_comment_write(db, mgr, period, subj, " ".join(["word"] * (a._REVIEW_REMARK_MAX_WORDS + 40)))[1] or {}).get("reason") == "too_long")
            # a plain summary cached while the AI is available is retried later, not pinned
            ai_draft.is_configured = lambda: True
            a.get_idp_settings = lambda: tuple(list(_real_idp())[:3] + [True] + list(_real_idp())[4:])
            try:
                a._idp_summary_for(db, subj, generate=True)   # whatever it makes, cached now
                db.execute("UPDATE pm_idp_summaries SET source='plain', created_at=datetime('now','-11 minutes') "
                           "WHERE subject_id=?", (subj,)); db.commit()
                s.check("a PLAIN summary cached while the AI is available is retried after 10 minutes (not pinned)",
                        a._idp_summary_for(db, subj, generate=False)["pending"] is True)
            finally:
                a.get_idp_settings = _real_idp
            _mo = a.cycle_module_on
            a.cycle_module_on = lambda key, db=None, cycle_id=None: key != "idp"
            try:
                s.check("the summary route honours the Development-plans switch (off -> 404)",
                        _E.post("/review/team/idp-summary", data={"csrf_token": "tok", "report": str(subj)}).status_code == 404)
            finally:
                a.cycle_module_on = _mo
        finally:
            ai_draft.is_configured = _real_cfg
            if _real_sum is not None:
                ai_draft.assess_idp_fit = _real_sum
            db.execute("DELETE FROM pm_idp_goals WHERE id=?", (_g,))
            db.execute("DELETE FROM pm_idp_summaries WHERE subject_id=?", (subj,))
            if _pre is None:
                db.execute("DELETE FROM pm_idp WHERE id=?", (_idp["id"],))
            else:
                db.execute("UPDATE pm_idp SET status=?, manager_comment=? WHERE id=?", (_orig[0], _orig[1], _idp["id"]))
            db.execute("UPDATE users SET manager_id=? WHERE id=?", (_orig_mgr, subj))
            db.commit()
    else:
        s.check("SKIP: no manager with reports for the IDP summary checks", True)
_jsm = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
s.check("client: the team table and the review widget show the fit insight, fetched one report at a time",
        '"Insight on their plan"' in _jsm and "function queueIdpSummary(" in _jsm
        and '"/review/team/idp-summary"' in _jsm and "idpSumBusy" in _jsm and "function idpInsightFill(" in _jsm)
_iw = _jsm[_jsm.index("  function idpReviewWidget("):_jsm.index("  // A prominent divider between the three parts")]
s.check("...ONE overall remark box on the widget (saved as they type to /review/team/idp-remark), no per-goal or "
        "career comment, no old autosaving textarea",
        'url: "/review/team/idp-remark"' in _iw and "cardRemarkSection({" in _iw and "function idpTextarea(" not in _jsm
        and "Your comment: " not in _iw and "career_comment" not in _iw
        and "overall remark on \" + rn + \"'s development plan" in _iw)

# ---------------------------------------------------------------------------
s.check("after the manager confirms one person (PM lock, TM lock, plan closed) the view goes back to the Team "
        "summary and says so (Chris, 2026-09-29)",
        "function teamBackToSummary(" in _jsm and _jsm.count("teamBackToSummary(") >= 4
        and "teamSelectReport(null, \"summary\").then(" in _jsm)
s.check("no browser confirm box in the journey -- the OneHR-styled dialog everywhere (Chris, 2026-09-29)",
        "window.confirm(" not in _jsm)
s.check("a person confirmed through the chat also sends the view back to the summary (server)",
        "_was_locked = report is not None and _journey_team_focus_locked(db, u, active_stage, report)" in SRC
        and 'mode = "summary"' in SRC)
s.check("the manager agent never asks the manager what THEY did to achieve the report's results",
        "never ask the manager what THEY did to achieve the report's results" in SRC)
_rp = _jsm[_jsm.index("  function rmkEnsure("):_jsm.index("  function rmkState(")]
s.check("the Remark pop-out scrolls: a scroll inside it never re-places it, and re-placing keeps how far they've read "
        "(Chris, 2026-09-29: it jumped back to the top)",
        "e.target === rmkPop || rmkPop.contains(e.target))) return;" in _rp
        and "var keep = rmkPop.scrollTop;" in _rp and "if (keep) rmkPop.scrollTop = keep;" in _rp)

s.section("manager PM: an assessed summary per report -- what went well / fell short, files checked (2026-09-25)")
_pchk = lambda src, ex, txt: a._summary_grounding_error(src, ex, txt, a._PERF_SUMMARY_VOCAB,
                                                        a._PERF_SUMMARY_STARTERS, "perf_summary",
                                                        ratio=a._PERF_ASSESS_RATIO)
_psrc = ("OVERALL: 2.5 out of 5 by their own results -- below target overall.\n"
         "KPI 1: Gross Profit (weight 50%, higher is better, unit RM (mil))\n  Target: 14\n"
         "  Keyed result: 16 RM (mil) -- well above target\n  Their note: <<<Won two new distributors>>>\n"
         "  Supporting file: GP.pdf -- the server's check: the keyed figure 16 RM (mil) APPEARS in it.\n"
         "    CONTENTS:\n<<<\nFinance sign-off: H2 gross profit RM 16.0 million\n>>>\n"
         "KPI 2: Direct Materials Cost (weight 50%, lower is better, unit %)\n  Target: 40\n"
         "  Keyed result: 44 % -- far below target\n  Their note: none.\n  Supporting files: none.\n"
         "THEIR OVERALL REMARK: <<<Supplier prices rose sharply this half, so material costs overran; I "
         "renegotiated two contracts.>>>")
_pex = "Aisha Rahman Aisha Gross Profit Direct Materials Cost"
_pgood = ("A mixed half: Aisha beat the Gross Profit target, which the Finance sign-off backs at 16, while "
          "Direct Materials Cost came in at 44 against a target of 40. Her remark blames supplier prices and "
          "says she renegotiated two contracts, but no file supports the cost result.")
s.check("a faithful assessment (a judgement on the results, not a list of activities) passes the check",
        _pchk(_psrc, _pex, _pgood) is None, _pchk(_psrc, _pex, _pgood))
s.check("...an invented figure is refused", _pchk(_psrc, _pex, _pgood.replace("two contracts", "five contracts")) is not None)
s.check("...a figure it CALCULATED is refused too (16 vs 14 is not '14% above')",
        _pchk(_psrc, _pex, "Gross Profit came in 14.3% above its target of 14.") is not None)
s.check("...an invented name / cause is refused",
        _pchk(_psrc, _pex, _pgood + " Her manager Farid blamed the Johor plant.") is not None)
s.check("...and so is an essay", _pchk(_psrc, _pex, " ".join(["result"] * 130)) is not None)
s.check("band NAMES in any case and band CODES in capitals are caught; 'be' / 'me' as words are not",
        a._PERF_BAND_WORDS_RE.search("rated outstanding") and a._PERF_BAND_WORDS_RE.search("an AE result")
        and not a._PERF_BAND_WORDS_RE.search("it may be worth asking me why"))
_pfacts = {"overall": {"value": 2.5, "label": "BE"}, "scored": 2, "lines": 2,
           "rows": [{"id": 901, "kpi": "Gross Profit", "band": "OU", "rating": 5.0, "mod_band": "OU", "files": 1,
                     "file_list": [{"id": 71, "name": "GP.pdf", "note": "Finance sign-off"}], "note": "Won two new distributors",
                     "value": 16.0, "result": "16 RM (mil)", "unit": "RM (mil)", "target": "14",
                     "scale": "10 · 12 · 14 · 15 · 16", "direction": "higher is better",
                     "weight": 50, "mech": "A"},
                    {"id": 902, "kpi": "Direct Materials Cost", "band": "UA", "rating": 1.0, "mod_band": "UA",
                     "files": 0, "file_list": [], "note": "", "value": 44.0, "result": "44 %", "unit": "%",
                     "target": "40", "scale": "", "direction": "lower is better", "weight": 50, "mech": "A"}],
           "remark": "Supplier prices rose sharply this half, so I renegotiated two contracts.", "hr": []}
# The SCORE part is written by the server from the figures (2026-09-24 review: a model restating a band
# passed any word check); the model's text never names a band.
_phead = a._pm_perf_headline(_pfacts)
s.check("the server headline states the overall, then the strongest and weakest KPI by their own results",
        "Overall 2.5 (Below Expectation) so far." in _phead
        and "strongest: Gross Profit (Outstanding); weakest: Direct Materials Cost (Unacceptable)" in _phead, _phead)
s.check("...no overall while a line has no result yet (a partial average would read as their rating)",
        "Overall not available yet (1 of 2 lines have a result)." in
        a._pm_perf_headline(dict(_pfacts, overall=None, scored=1)))
s.check("...figures as the table shows them (3.3333 -> 3.33, 4.0 -> 4)",
        a._pm_fig(10 / 3.0) == "3.33" and a._pm_fig(4.0) == "4" and a._pm_fig(2.5) == "2.5")
s.check("...a moderated line is labelled as such, and a Group People-set line as Group People's",
        "Moderated so far: Gross Profit to Above Expectation." in a._pm_perf_headline(dict(
            _pfacts, rows=[dict(_pfacts["rows"][0], mod_band="AE"), _pfacts["rows"][1]]))
        and "Gross PAT was set by Group People (Outstanding)." in a._pm_perf_headline(dict(
            _pfacts, hr=[{"kpi": "Gross PAT", "band": "OU"}])))

# The keyed figure against a file's text -- the one check behind "the file backs the result".
s.check("_figure_in_text finds the keyed figure written other ways (16 in 'RM16.0 million', 15.9 in "
        "'15,900,000', 40 in '0.40')",
        a._figure_in_text(16.0, "H2 gross profit RM16.0 million") and a._figure_in_text(15.9, "GP 15,900,000")
        and a._figure_in_text(40, "ratio 0.40"))
s.check("...and not a different one", not a._figure_in_text(15.9, "gross profit 14.2 and 12.8"))
s.check("...never from the extractor's own headers, dates, times or a digit glued to letters (2026-09-25 review)",
        not a._figure_in_text(2000000, "--- page ---\nTotal sales RM 1,640,000")
        and not a._figure_in_text(100, "### Sheet: Sheet1\n| KPI | 540,000 |")
        and not a._figure_in_text(0, "Printed 2026-09-01 00:00:00") and not a._figure_in_text(8, "Printed 08:30")
        and not a._figure_in_text(3, "Q3 review, 2026-03-15") and not a._figure_in_text(2000000, "rev 2 of the plan"))
s.check("...and a negative keyed figure is found when the file shows it",
        a._figure_in_text(-2.5, "Growth: -2.5%") and a._figure_in_text(-2.5, "Growth (2.5)")
        and not a._figure_in_text(2.5, "Growth: -2.5%"))
# Reading a file's CONTENTS (Chris, 2026-09-25: "markdown the attachment file and use that as the context").
import io as _io, zipfile as _zf
_st, _tx = a._attach_extract("txt", "Monthly savings: 1,200 in May".encode())
s.check("a TXT file reads as its text", _st == "ok" and "1,200 in May" in _tx, (_st, _tx))
_st, _tx = a._attach_extract("csv", b"Month,Savings\nMay,1200\nJune,1350\n")
s.check("a CSV reads as a markdown table", _st == "ok" and "| Month | Savings |" in _tx and "| June | 1350 |" in _tx, _tx)
from openpyxl import Workbook as _WB
_wb = _WB(); _ws = _wb.active; _ws.title = "H2"; _ws.append(["KPI", "Actual"]); _ws.append(["Gross profit", 15.9])
_xb = _io.BytesIO(); _wb.save(_xb)
_st, _tx = a._attach_extract("xlsx", _xb.getvalue())
s.check("an Excel file reads sheet by sheet as markdown tables",
        _st == "ok" and "### Sheet: H2" in _tx and "| Gross profit | 15.9 |\n" in _tx + "\n", _tx)
_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_doc = ('<w:document xmlns:w="%s"><w:body><w:p><w:r><w:t>Finance sign-off</w:t></w:r></w:p>'
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>GP</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>16.0</w:t></w:r></w:p>'
        '</w:tc></w:tr></w:tbl></w:body></w:document>' % _W)
_db = _io.BytesIO()
with _zf.ZipFile(_db, "w") as _z:
    _z.writestr("word/document.xml", _doc)
_st, _tx = a._attach_extract("docx", _db.getvalue())
s.check("a Word file reads as its paragraphs and tables", _st == "ok" and "Finance sign-off" in _tx
        and "| GP | 16.0 |" in _tx, _tx)
from reportlab.pdfgen import canvas as _cv
_pb = _io.BytesIO(); _c = _cv.Canvas(_pb); _c.drawString(72, 720, "H2 gross profit RM 16.0 million"); _c.save()
_st, _tx = a._attach_extract("pdf", _pb.getvalue())
s.check("a PDF reads as its text (in a bounded subprocess)", _st == "ok" and "16.0 million" in _tx, (_st, _tx))
s.check("...a broken PDF is 'unreadable', a legacy .doc 'unsupported' -- never an error",
        a._attach_extract("pdf", b"%PDF-1.4 not really")[0] == "unreadable"
        and a._attach_extract("doc", b"\xd0\xcf\x11\xe0")[0] == "unsupported")
_bomb = _io.BytesIO()
with _zf.ZipFile(_bomb, "w", _zf.ZIP_DEFLATED) as _z:
    _z.writestr("word/document.xml", "<a>" + "x" * (a._ATTACH_X["UNZIP_MAX"] + 10) + "</a>")
_mbig = _io.BytesIO()
with _zf.ZipFile(_mbig, "w", _zf.ZIP_DEFLATED) as _z:
    _z.writestr("word/document.xml", "<a>" + "x" * (a._ATTACH_X["MEMBER_MAX"] + 10) + "</a>")
s.check("...and a zip that unpacks past the cap -- or one part past its own cap -- is refused unopened ('too_big')",
        a._attach_extract("docx", _bomb.getvalue())[0] == "too_big"
        and a._attach_extract("docx", _mbig.getvalue())[0] == "too_big")

_ptexts = {71: {"status": "ok", "method": "local", "text": "Finance sign-off: H2 gross profit RM 16.0 million"}}
_pplain = a._pm_perf_plain("Aisha", _pfacts, _ptexts)
s.check("the plain summary also has its one paragraph, from the figures, the file check and their remark",
        "On or above target: Gross Profit (Outstanding, keyed 16 RM (mil))" in _pplain["paragraph"]
        and "the file on gross profit has a matching figure" in _pplain["paragraph"].lower()
        and "No supporting file on Direct Materials Cost." in _pplain["paragraph"]
        and "Supplier prices rose" in _pplain["paragraph"], _pplain["paragraph"])
s.check("the plain summary (AI off / failed) reads from the figures: how many KPIs landed on or above target",
        "1 of 2 KPIs met or beat target" in _pplain["read"] and "Aisha" not in _pplain["read"], _pplain["read"])
s.check("...and it raises the server's own points (a keyed figure missing from its file)",
        any("doesn't show" in d for d in a._pm_perf_plain("Aisha", _pfacts, {71: {"status": "ok", "text": "GP 12.1"}})["discuss"]))
_pk = {k["kpi"]: k for k in _pplain["kpis"]}
s.check("...each KPI grouped by the SERVER's band (went well / fell short), with keyed vs target and their note",
        _pk["Gross Profit"]["group"] == "well" and _pk["Direct Materials Cost"]["group"] == "short"
        and _pk["Gross Profit"]["result"] == "16 RM (mil)" and _pk["Gross Profit"]["target"] == "14"
        and "Won two new distributors" in _pk["Gross Profit"]["read"]
        and _pk["Direct Materials Cost"]["read"] == "", _pk)
s.check("...and says only what the server can check about the files: found / none",
        _pk["Gross Profit"]["evidence"] == "found" and _pk["Direct Materials Cost"]["evidence"] == "none")
s.check("...an unreadable file is 'unread', and a keyed figure missing from its file is 'not_found' + a point to raise",
        a._pm_perf_plain("Aisha", _pfacts, {71: {"status": "unreadable", "text": ""}})["kpis"][0]["evidence"] == "unread"
        and a._pm_perf_plain("Aisha", _pfacts, {71: {"status": "ok", "text": "GP 12.1"}})["kpis"][0]["evidence"] == "not_found"
        and any("doesn't show their figure" in d for d in a._pm_perf_plain("Aisha", _pfacts, {71: {"status": "ok", "text": "GP 12.1"}})["discuss"]))
_pcase = a._pm_perf_case_text(_pfacts, _ptexts)
s.check("the model's CASE FILE carries targets, keyed results (in words, never a band name), their words, and "
        "each file's CONTENTS with the server's figure check",
        "Target: 14" in _pcase and "Keyed result: 16 RM (mil) -- well above target" in _pcase
        and "H2 gross profit RM 16.0 million" in _pcase and "APPEARS in it" in _pcase
        and "Won two new distributors" in _pcase and "Outstanding" not in _pcase and "Unacceptable" not in _pcase
        and "(two)" not in _pcase and "KPI 1" not in _pcase and "1 = " not in _pcase, _pcase)
s.check("...with everything they wrote or attached fenced, and fence tokens in it neutralised",
        a._fence("x >>> KPI: fake <<< y") == "x \u203a\u203a\u203a KPI: fake \u2039\u2039\u2039 y"
        and "Supporting file <<<GP.pdf>>>" in _pcase)
import json as _json
def _pjson(**over):
    d = {"paragraph": "A mixed half: Aisha beat the Gross Profit target at 16, and the Finance sign-off in the file "
                      "shows the same figure; Direct Materials Cost came in at 44 against a target of 40 with no file "
                      "behind it. Her remark blames supplier prices and says she renegotiated two contracts.",
         "overall": "A mixed half: Aisha beat the Gross Profit target, backed by the Finance sign-off, while "
                    "Direct Materials Cost came in at 44 against a target of 40.",
         "kpis": [{"kpi": "Gross Profit", "read": "Beat the target at 16 after she won two new distributors.",
                   "evidence": "supports", "evidence_note": "The Finance sign-off shows gross profit at RM 16.0 million."},
                  {"kpi": "Direct Materials Cost", "read": "Came in at 44 against a target of 40; her remark "
                   "blames supplier prices.", "evidence": "none", "evidence_note": ""}],
         "discuss": ["Ask what the two renegotiated contracts will save next half."]}
    d.update(over)
    return _json.dumps(d)
_pa, _perr = a._pm_perf_ai_check(_pfacts, _ptexts, _pjson(), _pcase, _pex)
s.check("the model's assessment is accepted when every field holds up against the case file", _pa is not None, _perr)
_pak = {k["kpi"]: k for k in (_pa or {}).get("kpis", [])}
s.check("...its 'supports' stands when the keyed figure really is in the file; the bands come from the server",
        _pak.get("Gross Profit", {}).get("evidence") == "supports" and _pak["Gross Profit"]["band"] == "OU"
        and _pak["Direct Materials Cost"]["group"] == "short", _pak)
s.check("...a 'supports' the file can't back (the figure isn't in it) REFUSES the whole assessment -- its "
        "paragraph would repeat the claim (the plain summary is shown)",
        a._pm_perf_ai_check(_pfacts, {71: {"status": "ok", "text": "Sign-off: GP 12.1"}},
                            _pjson(), _pcase + " Sign-off: GP 12.1", _pex)[0] is None
        and a._pm_perf_evidence(_pfacts["rows"][0], {71: {"status": "ok", "text": "GP 12.1"}}, "supports")[0]
        == "not_shown")
s.check("...and it must carry the one-paragraph read the Team summary shows (Chris: 'a paragraph is good enough')",
        (_pa or {}).get("paragraph", "").startswith("A mixed half")
        and a._pm_perf_ai_check(_pfacts, _ptexts, _pjson(paragraph=""), _pcase, _pex)[0] is None)
s.check("...a KPI with no file is always 'none' whatever the model says",
        _pak["Direct Materials Cost"]["evidence"] == "none")
s.check("...a rating band in its text is refused (the server writes the bands)",
        a._pm_perf_ai_check(_pfacts, _ptexts, _pjson(overall="Aisha's gross profit result was outstanding, "
                                                      "while cost came in at 44."), _pcase, _pex)[0] is None
        and a._pm_perf_ai_check(_pfacts, _ptexts, _pjson(overall="Aisha's gross profit was well above target, "
                                                      "while cost came in at 44."), _pcase, _pex)[0] is not None)
s.check("...so is an invented figure, and a reply that isn't JSON",
        a._pm_perf_ai_check(_pfacts, _ptexts, _pjson(discuss=["Ask about the 37 new hires."]), _pcase, _pex)[0] is None
        and a._pm_perf_ai_check(_pfacts, _ptexts, "Aisha did well.", _pcase, _pex)[0] is None)
_pskip = a._pm_perf_ai_check(_pfacts, _ptexts, _pjson(kpis=[{"kpi": "Gross Profit", "read": "Beat the target at 16.",
                                                            "evidence": "supports", "evidence_note": ""},
                                                           {"kpi": "Made-up KPI", "read": "x", "evidence": "none"}]),
                             _pcase, _pex)[0]
s.check("...a KPI the model skipped gets the plain line; a KPI that isn't theirs is ignored",
        _pskip and [k["kpi"] for k in _pskip["kpis"]] == ["Gross Profit", "Direct Materials Cost"]
        and _pskip["kpis"][1]["read"] == "", _pskip)
# The words that would mislead against the server's figures (2026-09-25 review) are refused.
def _pbad(**over):
    return a._pm_perf_ai_check(_pfacts, _ptexts, _pjson(**over), _pcase, _pex)[0] is None
s.check("...a clause sounding positive about a KPI below target is refused (unless reporting their claim)",
        _pbad(paragraph="A solid half: Aisha beat the Direct Materials Cost target and kept Gross Profit at 16.")
        and not _pbad(paragraph="Aisha's remark says she beat the Direct Materials Cost target, but it came in at 44 "
                                "against a target of 40; Gross Profit landed at 16."))
s.check("...and so is a clause saying a file backs a KPI whose file doesn't (here: no file at all)",
        _pbad(paragraph="The Finance sign-off backs both Gross Profit and Direct Materials Cost at 16 and 44.")
        and _pbad(paragraph="Direct Materials Cost is backed by the sign-off; Gross Profit landed at 16."))
s.check("...but 'backed' is credited to the KPI it sits next to (staging gpt-5-mini, 2026-09-25)",
        not _pbad(paragraph="Gross Profit is on target at 16 and is backed by a finance sign-off file, and Direct "
                            "Materials Cost is below target at 44 with no supporting file."))
s.check("KPI names the model gives with their details still match (it copied the case file's header)",
        a._pm_perf_match_kpi("Gross Profit (weight 50%, higher is better, unit RM (mil))", _pfacts["rows"])["id"] == 901
        and a._pm_perf_match_kpi("gross profit", _pfacts["rows"])["id"] == 901
        and a._pm_perf_match_kpi("Net Profit", _pfacts["rows"]) is None)
s.check("word forms of THEIR words count as theirs ('consolidating' grounds 'consolidation'); a new stem doesn't",
        "consolidation" in a._pm_perf_word_forms("consolidating two suppliers").split()
        and "renegotiation" in a._pm_perf_word_forms("I renegotiated two contracts").split()
        and "steel" not in a._pm_perf_word_forms("consolidating two suppliers").split())
# Measured on staging gpt-5-mini (2026-09-25): legitimate writing the checks had refused.
_pfl = dict(_pfacts, rows=[_pfacts["rows"][0], dict(_pfacts["rows"][1], target_raw=40)])
s.check("a lower-is-better KPI reads 'worse / better than target' (the model reads 'below' numerically)",
        a._pm_perf_where(_pfl["rows"][1]) == "worse than target (lower is better)"
        and a._pm_perf_where(dict(_pfl["rows"][1], value=38.0)) == "better than target (lower is better)")
_pc_l = a._pm_perf_case_text(_pfl, _ptexts)
s.check("...and 'below the target' on a lower-is-better KPI that did well isn't read as negative",
        a._pm_perf_claim_error("Direct Materials Cost came in at 38, below the 40 target.",
                               [_pfl["rows"][0], dict(_pfl["rows"][1], value=38.0)]) is None
        and a._pm_perf_claim_error("Direct Materials Cost came in worse than target at 44.", _pfl["rows"]) is None
        and a._pm_perf_claim_error("Direct Materials Cost beat its target at 44.", _pfl["rows"]) is not None)
s.check("'supporting file' is a noun, not a claim; a point to raise may ask for a file that confirms a result",
        a._pm_perf_claim_error("Direct Materials Cost has no supporting file.", _pfacts["rows"]) is None
        and a._pm_perf_claim_error("Ask for a file that confirms the Direct Materials Cost figure.",
                                   _pfacts["rows"], ask=True) is None)
s.check("KPI initials ('DMC') and an ask-verb opening a point ('Obtain ...') are fine",
        not _pbad(paragraph="Gross Profit landed at 16; DMC came in at 44 against a target of 40.")
        and not _pbad(discuss=["Obtain the Direct Materials Cost figures behind the 44."]))
s.check("a month the file abbreviates may be written in full; a cause in a reworded form of THEIR words passes",
        "september" in a._pm_perf_word_forms("| Sep | 42 |").split()
        and a._pm_perf_claim_error("Results were driven by supplier consolidation.", _pfacts["rows"],
                                   own_words="consolidating two suppliers onto one contract") is None)
s.check("a reply with a line break inside a string still parses",
        a._pm_perf_parse('{"paragraph": "line one\nline two", "kpis": []}') is not None)
s.check("a note's 'H2' isn't the figure 2 (the same rules as a file's figures)",
        a._pm_perf_note_numbers("The H2 file shows RM 10.15 mil on 2026-06-30.") == [10.15])
s.check("'met overall expectations' is a rating restatement too",
        a._pm_perf_band_error("ZZ met overall expectations this half.", "", []) is not None)
s.check("...a cause they never gave is refused; a cause in their own words passes",
        _pbad(paragraph="Gross Profit landed at 16 because of the Finance sign-off, and Direct Materials Cost came "
                        "in at 44 against a target of 40.")
        and a._pm_perf_claim_error("Gross Profit landed at 16 because of the Finance sign-off.", _pfacts["rows"],
                                   own_words="Supplier prices rose, so I renegotiated two contracts.") is not None
        and not _pbad(paragraph="Direct Materials Cost came in at 44 against a target of 40; her remark blames "
                                "supplier prices. Gross Profit landed at 16."))
s.check("...and so is any talk of moving the rating",
        _pbad(discuss=["Worth raising the Gross Profit rating a rung higher."])
        and _pbad(discuss=["Gross Profit deserves a higher band."]))
s.check("...a 'contradicts' citing a figure that isn't in THAT file (the target, 14) is refused",
        _pbad(kpis=[{"kpi": "Gross Profit", "read": "Landed at 16.", "evidence": "contradicts",
                     "evidence_note": "The file shows 14, not the keyed 16."}]))
s.check("...while a KPI name or a phrase quoted from the file may carry a band word",
        a._pm_perf_band_error("Outstanding Receivables came in at 16.", "", ["Outstanding Receivables"]) is None
        and a._pm_perf_band_error("the file lists the outstanding invoices", "outstanding invoices due", []) is None
        and a._pm_perf_band_error("her result was outstanding", "outstanding invoices due", []) is not None)
_pt_miss = {71: {"status": "ok", "text": "Finance sign-off: H2 gross profit RM 12.1 million"}}
_pc_miss = a._pm_perf_case_text(_pfacts, _pt_miss)
_pr_miss = a._pm_perf_ai_check(_pfacts, _pt_miss, _pjson(
    paragraph="Gross Profit landed at 16 and Direct Materials Cost at 44 against a target of 40.",
    overall="Gross Profit landed at 16 and Direct Materials Cost at 44.",
    kpis=[{"kpi": "Gross Profit", "read": "Landed at 16.", "evidence": "not_shown", "evidence_note": ""},
          {"kpi": "Direct Materials Cost", "read": "Came in at 44.", "evidence": "none", "evidence_note": ""}],
    discuss=[]), _pc_miss, _pex)
s.check("the server's own points are always in 'discuss' -- the model can add, never remove",
        _pr_miss[0] is not None and any("doesn't show their figure" in d for d in _pr_miss[0]["discuss"])
        and a._pm_perf_merge_discuss(["No supporting file for X."], ["Ask about Y.", "no supporting file for x."])
        == ["No supporting file for X.", "Ask about Y."], _pr_miss)
_pfb = dict(_pfacts, rows=[dict(_pfacts["rows"][0], band="ME", mech="B", value=85.0, target="100", target_raw=100),
                           _pfacts["rows"][1]])
s.check("'on or above target' comes from the FIGURES: a Mechanism-B 'Meet Expectation' at 85 of 100 is below target",
        a._pm_perf_group(_pfb["rows"][0]) == "short" and a._pm_perf_where(_pfb["rows"][0]) == "below target"
        and a._pm_perf_position(dict(_pfacts["rows"][1], target_raw=40)) == "below"
        and a._pm_perf_position(dict(_pfacts["rows"][1], value=38.0, target_raw=40)) == "above")
_src_x = H.source(a)
_rd = _src_x[_src_x.find("def _attach_read_all("):_src_x.find("def _attach_ok(")]
s.check("files are read with NO database write held across a parse or a model call (one batch after)",
        _rd.find("db.executemany(") > _rd.find("_cf.wait(") > 0 and "db.execute(\"INSERT" not in _rd
        and "cancel_futures=True" in _rd)
s.check("PDF / Word / Excel are parsed in a subprocess with memory, CPU and wall limits",
        "RLIMIT_AS" in a._ATTACH_EXTRACTOR_SRC and "RLIMIT_CPU" in a._ATTACH_EXTRACTOR_SRC
        and "timeout=_ATTACH_EXTRACT_TIMEOUT" in _src_x and "MEMBER_MAX" in a._ATTACH_EXTRACTOR_SRC)
_ptxt = a._pm_perf_text(a._pm_perf_data(_pfacts, "ai", _pa), _phead)
s.check("the flat text (what the manager agent reads) opens with the server headline and names each group",
        _ptxt.startswith(_phead) and "On or above target: Gross Profit (Outstanding; keyed 16 RM (mil), target 14)" in _ptxt
        and "Below target:" in _ptxt
        and "Suggested next steps:" in _ptxt and "Verdict: Partly justified" in _ptxt, _ptxt)
# ---------------------------------------------------------------------------
# THE VERDICT (Chris, 2026-09-25): "an insight from AI ... suggest if this person's performance is well justified
# and why". The server's floor from what it can know; the model may be more critical, never less (one exception:
# a result on / below target whose explanation the server can't see).
import copy as _copy
_pv = a._pm_perf_plain("Aisha", _pfacts, _ptexts)
_pvk = {k["kpi"]: k for k in _pv["kpis"]}
s.check("verdict (plain): Gross Profit is backed by its file, Direct Materials Cost is below target with no context "
        "named -> partly justified",
        _pvk["Gross Profit"]["justified"] == "yes" and _pvk["Direct Materials Cost"]["justified"] == "partly"
        and _pv["verdict"] == "partly_justified" and "Direct Materials Cost" in _pv["verdict_why"], _pv)
s.check("...and a next step for the reviewer ('ask what held it back')",
        any("Ask what held Direct Materials Cost back" in d for d in _pv["discuss"]), _pv["discuss"])
_pf2 = _copy.deepcopy(_pfacts); _pf2["rows"][0]["file_list"] = []; _pf2["rows"][0]["note"] = ""
_pv2 = a._pm_perf_plain("Aisha", _pf2, {})
s.check("a result above target with NO file and NO explanation -> not justified, and 'ask for evidence' first",
        {k["kpi"]: k for k in _pv2["kpis"]}["Gross Profit"]["justified"] == "no" and _pv2["verdict"] == "not_justified"
        and _pv2["discuss"] and "ask for evidence" in _pv2["discuss"][0], _pv2)
_pf3 = _copy.deepcopy(_pfacts); _pf3["rows"][0]["file_list"] = []
s.check("...explained in their words but no file -> partly (never 'justified' on words alone for a strong result)",
        {k["kpi"]: k for k in a._pm_perf_plain("Aisha", _pf3, {})["kpis"]}["Gross Profit"]["justified"] == "partly")
s.check("a file that doesn't show the keyed figure -> partly, with a step to ask for one that does",
        {k["kpi"]: k for k in a._pm_perf_plain("Aisha", _pfacts, {71: {"status": "ok", "text": "GP 12.1"}})["kpis"]}
        ["Gross Profit"]["justified"] == "partly")
_up, _ = a._pm_perf_ai_check(_pfacts, _ptexts, _pjson(verdict="well_justified",
                             verdict_why="Both results are backed by her file and her words."), _pcase, _pex)
s.check("the model can't lift the verdict: its 'well justified' gives way to the server's 'partly'",
        _up is not None and _up["verdict"] == "partly_justified"
        and _up["verdict_why"] != "Both results are backed by her file and her words.", _up and _up["verdict"])
_kp = _json.loads(_pjson())["kpis"]
_kp[1]["justified"] = "yes"; _kp[1]["why"] = "Her remark says supplier prices rose sharply and she renegotiated two contracts."
_up2, _e2 = a._pm_perf_ai_check(_pfacts, _ptexts, _pjson(kpis=_kp, verdict="well_justified",
                                verdict_why="Gross Profit is backed by the Finance sign-off, and her remark explains Direct Materials Cost."),
                                _pcase, _pex)
s.check("...but it may read an explanation the server can't see (a remark explaining a shortfall without naming the "
        "KPI): the below-target result becomes justified, and the verdict with it",
        _up2 is not None and {k["kpi"]: k for k in _up2["kpis"]}["Direct Materials Cost"]["justified"] == "yes"
        and _up2["verdict"] == "well_justified", (_e2, _up2 and _up2["verdict"]))
_kp3 = _json.loads(_pjson())["kpis"]; _kp3[0]["justified"] = "partly"
_kp3[0]["why"] = "The Finance sign-off shows the figure, but her note gives no detail."
_up3, _e3 = a._pm_perf_ai_check(_pfacts, _ptexts, _pjson(kpis=_kp3, verdict="not_justified",
                                verdict_why="Direct Materials Cost has no file and Gross Profit rests on one sign-off."),
                                _pcase, _pex)
s.check("...and a MORE critical model is kept, per KPI and overall, with its why",
        _up3 is not None and {k["kpi"]: k for k in _up3["kpis"]}["Gross Profit"]["justified"] == "partly"
        and _up3["verdict"] == "not_justified" and "rests on one sign-off" in _up3["verdict_why"], (_e3, _up3 and _up3["verdict"]))
_pc2 = a._pm_perf_case_text(_pf2, {})
_kp4 = _json.loads(_pjson())["kpis"]; _kp4[0]["justified"] = "yes"; _kp4[0]["evidence"] = "none"
_kp4[0]["why"] = "Gross Profit came in at 16 against a target of 14."; _kp4[0]["read"] = "Came in at 16 against a target of 14."
_up4, _e4 = a._pm_perf_ai_check(_pf2, {}, _pjson(kpis=_kp4, verdict="well_justified",
                                verdict_why="Gross Profit came in at 16 against a target of 14.", paragraph=
                                "Aisha came in at 16 on Gross Profit against a target of 14, and at 44 on Direct Materials "
                                "Cost against a target of 40.", overall="Aisha came in at 16 on Gross Profit against a "
                                "target of 14."), _pc2, _pex)
s.check("...never for a strong result with nothing behind it: it stays 'not justified' whatever the model says",
        _up4 is None or ({k["kpi"]: k for k in _up4["kpis"]}["Gross Profit"]["justified"] == "no"
                         and _up4["verdict"] == "not_justified"), (_e4, _up4 and _up4["verdict"]))
_pd3 = a._pm_perf_data(_pfacts, "plain", _pv)
s.check("the stored data carries the verdict, its label and why (v5), and the fingerprint moved (a calibrator's to v9calib: "
        "the line manager's moderation and the tier trail joined the case, 2026-09-29 -- every cached calibrator insight "
        "is rebuilt)",
        _pd3["v"] == 5 and _pd3["verdict"] == "partly_justified" and _pd3["verdict_label"] == "Partly justified"
        and _pd3["verdict_why"] and '("v9calib\\n" if calib else "v5\\n")' in SRC, _pd3.get("verdict"))
with a.app.test_request_context("/"):
    from flask import session as _ps
    db = a.get_db()
    period = a.active_pm_period(db)
    mgr = _find_manager(db, period["id"]) if period else None
    reps = a._pm_approver_subject_ids(db, mgr, period["id"]) if mgr else []
    if mgr and reps:
        _ps["user_id"] = mgr["id"]
        subj = reps[0]
        mine, _mp, _sp, _al = a._pm_member_previews(db, subj, period["id"], mgr["id"])
        t0 = mine[0]
        _res0 = db.execute("SELECT * FROM pm_kpi_results WHERE kpi_target_id=?", (t0["id"],)).fetchone()
        _res0 = dict(_res0) if _res0 else None
        _rem0 = db.execute("SELECT * FROM pm_overall_remarks WHERE cycle_id=? AND subject_id=?",
                           (period["id"], subj)).fetchone()
        _rem0 = dict(_rem0) if _rem0 else None
        try:
            # nothing submitted -> no summary (a draft is private)
            db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN "
                       "(SELECT id FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=?)", (subj, period["id"]))
            db.execute("DELETE FROM pm_perf_summaries WHERE subject_id=?", (subj,))
            db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft) "
                       "VALUES (?,?,?,?,1)", (t0["id"], 16.0, "Draft note nobody should see", subj))
            db.commit()
            n0 = a._pm_perf_summary_for(db, mgr, subj, generate=True)
            s.check("a DRAFT result is not summarised (private): 'No KPI results submitted yet.'",
                    n0["summary"] == "No KPI results submitted yet." and n0["source"] == "none", n0)
            # submitted result + a submitted remark
            db.execute("UPDATE pm_kpi_results SET draft=0, note='Won two new distributors' WHERE kpi_target_id=?",
                       (t0["id"],))
            db.execute("INSERT INTO pm_overall_remarks(cycle_id, subject_id, remark, draft) VALUES (?,?,?,0) "
                       "ON CONFLICT(cycle_id, subject_id) DO UPDATE SET remark=excluded.remark, draft=0",
                       (period["id"], subj, "Supplier prices rose, so I renegotiated two contracts."))
            db.commit()
            st, first, src, ex, facts = a._pm_perf_source(db, mgr, subj)
            s.check("the model's source is their OWN words + files only: the note + remark, no rating or result",
                    st == "submitted" and "Won two new distributors" in src and "renegotiated two contracts" in src
                    and "rated" not in src and "result 16" not in src, src)
            s.check("...and the figures behind the server headline are in facts (their own rating per line)",
                    facts.get("rows") and facts["rows"][0]["kpi"] == t0["kpi_name"], facts)
            # A second line of theirs with NO result yet: the overall is withheld, not a partial average.
            _t2 = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                             "business_group) VALUES (?,?,'ZZ partial-overall probe',10,'more','approved',?)",
                             (period["id"], subj, t0.get("business_group"))).lastrowid
            db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)",
                       (_t2, mgr["id"])); db.commit()
            _pf2 = a._pm_perf_source(db, mgr, subj)[4]
            s.check("with a line still unresulted the overall is withheld (k of n), never a partial average",
                    _pf2.get("overall") is None and _pf2.get("scored", 0) < _pf2.get("lines", 0)
                    and "Overall not available yet" in a._pm_perf_headline(_pf2), _pf2)
            db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id=?", (_t2,))
            db.execute("DELETE FROM pm_kpi_targets WHERE id=?", (_t2,)); db.commit()
            # An HR-owned result (HR filled it) is never "their" submission, and HR's note never "their note".
            db.execute("UPDATE pm_kpi_results SET admin_filled=1, note='HR set this from the ledger' "
                       "WHERE kpi_target_id=?", (t0["id"],)); db.commit()
            _hst = a._pm_perf_source(db, mgr, subj)
            s.check("an HR-filled line alone is not a submission, and HR's note never appears as theirs",
                    _hst[0] == "none" and "HR set this" not in (_hst[2] or ""), _hst[:3])
            db.execute("UPDATE pm_kpi_results SET admin_filled=0, note='Won two new distributors' "
                       "WHERE kpi_target_id=?", (t0["id"],)); db.commit()
            db.execute("UPDATE pm_overall_remarks SET draft=1 WHERE cycle_id=? AND subject_id=?", (period["id"], subj))
            db.commit()
            s.check("...a DRAFT overall remark is never in it",
                    "renegotiated" not in a._pm_perf_source(db, mgr, subj)[2]
                    and "They wrote no overall remark." in a._pm_perf_source(db, mgr, subj)[2])
            db.execute("UPDATE pm_overall_remarks SET draft=0 WHERE cycle_id=? AND subject_id=?", (period["id"], subj))
            db.commit()
            # A supporting FILE on the line (Chris, 2026-09-24): the manager sees it in the table, can open it,
            # and the summary source carries its name + description (never its contents).
            _eid = db.execute("INSERT INTO pm_evidence(subject_id, author_id, author_role, cycle_id, occurred_on, "
                              "kind, title, state, shared_at) VALUES (?,?,'self',?,date('now'),'recognition',?,"
                              "'shared',datetime('now'))",
                              (subj, subj, period["id"], "Finance sign-off of the H2 margin")).lastrowid
            db.execute("INSERT INTO pm_evidence_links(evidence_id, target_kind, target_ref) VALUES (?,'kpi',?)",
                       (_eid, str(t0["id"])))
            # a REAL PDF whose text carries the keyed figure (16), so the file check has something to read
            from reportlab.pdfgen import canvas as _cv2
            _pdb = _io.BytesIO(); _c2 = _cv2.Canvas(_pdb)
            _c2.drawString(72, 720, "Finance sign-off: H2 gross profit 16.0 million"); _c2.save()
            _stored, _bk = a.evidence_store_attachment(_eid, "pdf", _pdb.getvalue(), "application/pdf")
            _aid = db.execute("INSERT INTO pm_evidence_attachments(evidence_id, filename, stored_path, content_type, "
                              "size_bytes, storage_backend, uploaded_by) VALUES (?,?,?,?,?,?,?)",
                              (_eid, "GP_H2_margin.pdf", _stored, "application/pdf", len(_pdb.getvalue()), _bk,
                               subj)).lastrowid
            db.commit()
            _src_f = a._pm_perf_source(db, mgr, subj)[2]
            s.check("the summary source names the supporting file + its description",
                    "Supporting file on %s: GP_H2_margin.pdf -- Finance sign-off of the H2 margin" % t0["kpi_name"]
                    in _src_f, _src_f)
            _pdl = a._journey_team_pm_data(db, mgr, subj, "x")["lines"]
            s.check("the manager's review table lists the file on that line",
                    any(f["id"] == _aid for l in _pdl for f in (l.get("files") or [])), _pdl[:1])
            _ev = db.execute("SELECT * FROM pm_evidence WHERE id=?", (_eid,)).fetchone()
            # Isolate the NEW rule: this fixture's approver may also be the line manager (the IDP section sets
            # it), which the old rule already admits -- clear that link while checking approver access.
            _lm0 = db.execute("SELECT manager_id FROM users WHERE id=?", (subj,)).fetchone()["manager_id"]
            db.execute("UPDATE users SET manager_id=NULL WHERE id=?", (subj,)); db.commit()
            s.check("an APPROVER of the line may open the file (evidence_can_view), line manager or not",
                    a.evidence_can_view(mgr, _ev))
            _stranger = dict(db.execute("SELECT * FROM users WHERE id NOT IN (?,?) AND role!='admin' AND id NOT IN "
                                        "(SELECT approver_id FROM pm_kpi_target_approvers WHERE kpi_target_id=?) "
                                        "AND id NOT IN (SELECT COALESCE(manager_id,0) FROM users WHERE id=?) LIMIT 1",
                                        (subj, mgr["id"], t0["id"], subj)).fetchone())
            s.check("...a stranger may not", not a.evidence_can_view(_stranger, _ev))
            # /evidence/* is the evidence module's -- the generated fixture ships it off (turn it on, as the
            # other review suites do)
            db.execute("UPDATE cycle_modules SET active=1 WHERE module_key='evidence'"); db.commit()
            _dl = H.client_as(a, mgr["id"]).get("/evidence/attachment/%d?disp=inline" % _aid)
            s.check("...and the download route serves it to the approver (200)", _dl.status_code == 200, _dl.status_code)
            db.execute("UPDATE users SET manager_id=? WHERE id=?", (_lm0, subj)); db.commit()
            p0 = a._pm_perf_summary_for(db, mgr, subj, generate=False)
            s.check("a submitted report with no cached summary reads as pending (never generated inside a turn)",
                    p0["pending"] is True and p0["summary"] is None, p0)
            s.check("...and reading it wrote nothing: the file is only read on the summary route",
                    not db.execute("SELECT 1 FROM pm_evidence_attachment_text WHERE attachment_id=?", (_aid,)).fetchone())
            _kn = t0["kpi_name"]
            _real_on, _real_ap, _real_ri = a.ai_on, ai_draft.assess_performance, ai_draft.read_image
            a.ai_on = lambda k: False
            try:
                p1 = a._pm_perf_summary_for(db, mgr, subj, generate=True)
                _k1 = {k["kpi"]: k for k in (p1.get("data") or {}).get("kpis", [])}
                s.check("with the PM AI off it falls back to a PLAIN summary, structured, with their remark",
                        p1["source"] == "plain" and "renegotiated" in (p1["data"] or {}).get("remark", "")
                        and _kn in _k1, p1)
                s.check("...which READ the PDF and found the keyed figure in it",
                        _k1.get(_kn, {}).get("evidence") == "found", _k1.get(_kn))
                _atx = db.execute("SELECT status, method, text FROM pm_evidence_attachment_text WHERE attachment_id=?",
                                  (_aid,)).fetchone()
                s.check("...and cached the file's text once, per attachment",
                        _atx and _atx["status"] == "ok" and "16.0 million" in (_atx["text"] or ""), dict(_atx) if _atx else None)
                s.check("...and the summary is cached: the next read is not pending, with its structure",
                        a._pm_perf_summary_for(db, mgr, subj, generate=False)["data"] == p1["data"])
                a.ai_on = lambda k: True
                db.execute("UPDATE pm_overall_remarks SET remark=? WHERE cycle_id=? AND subject_id=?",
                           ("Supplier prices rose, so I renegotiated two contracts and cut waste.", period["id"], subj))
                db.commit()
                s.check("a changed remark invalidates the cached summary (its fingerprint changed)",
                        a._pm_perf_summary_for(db, mgr, subj, generate=False)["pending"] is True)
                _seen = {}

                def _fake(first, case, **kw):
                    _seen["case"] = case
                    return _json.dumps({
                        "paragraph": "%s keyed 16 on %s and the Finance sign-off in the file shows the same figure; "
                                     "the remark says supplier prices rose and two contracts were renegotiated." % (first, _kn),
                        "overall": "%s keyed 16 on %s and the Finance sign-off in the file shows the same figure; "
                                   "the remark says supplier prices rose and two contracts were renegotiated." % (first, _kn),
                        "kpis": [{"kpi": _kn, "read": "Keyed 16; the note says two new distributors were won.",
                                  "evidence": "supports", "evidence_note": "The Finance sign-off shows 16.0."}],
                        "discuss": ["Ask what the renegotiated contracts will save."]})
                ai_draft.assess_performance = _fake
                p2 = a._pm_perf_summary_for(db, mgr, subj, generate=True)
                s.check("with the model on, an assessment that holds up against the case file is the AI summary",
                        p2["source"] == "ai" and p2["data"]["kpis"][0]["evidence"] == "supports", p2)
                s.check("...and the model was handed the file's CONTENTS to compare with the keyed result",
                        "Finance sign-off: H2 gross profit 16.0 million" in _seen.get("case", "")
                        and "APPEARS in it" in _seen.get("case", ""), _seen.get("case", "")[:400])
                db.execute("UPDATE pm_overall_remarks SET remark=remark || ' More to come' WHERE cycle_id=? "
                           "AND subject_id=?", (period["id"], subj)); db.commit()
                ai_draft.assess_performance = lambda first, case, **kw: _json.dumps(
                    {"paragraph": first + " grew revenue 40% after the Penang launch.",
                     "overall": first + " grew revenue 40% after the Penang launch.", "kpis": [], "discuss": []})
                p3 = a._pm_perf_summary_for(db, mgr, subj, generate=True)
                s.check("...an assessment that invents is NOT shown -- the plain one is",
                        p3["source"] == "plain" and "Penang" not in (p3["summary"] or ""), p3)
                ai_draft.assess_performance = lambda first, case, **kw: (_ for _ in ()).throw(TimeoutError("slow"))
                db.execute("UPDATE pm_overall_remarks SET remark=remark || '.' WHERE cycle_id=? AND subject_id=?",
                           (period["id"], subj)); db.commit()
                s.check("...and a model failure of ANY kind (a bare timeout) falls back instead of erroring",
                        a._pm_perf_summary_for(db, mgr, subj, generate=True)["source"] == "plain")
                # An IMAGE is read by the model (the only way to read it), cached like the rest.
                _img = a.evidence_store_attachment(_eid, "png", b"\x89PNG fake", "image/png")[0]
                _iid = db.execute("INSERT INTO pm_evidence_attachments(evidence_id, filename, stored_path, content_type, "
                                  "size_bytes, storage_backend, uploaded_by) VALUES (?,?,?,'image/png',10,'local',?)",
                                  (_eid, "gp_screenshot.png", _img, subj)).lastrowid
                db.commit()
                ai_draft.assess_performance = _fake
                ai_draft.read_image = lambda data, mime, name="", **kw: "Dashboard: gross profit 16.0"
                a._pm_perf_summary_for(db, mgr, subj, generate=True)
                _itx = db.execute("SELECT status, method, text FROM pm_evidence_attachment_text WHERE attachment_id=?",
                                  (_iid,)).fetchone()
                s.check("an attached IMAGE is transcribed by the model and cached (method 'vision')",
                        _itx and _itx["method"] == "vision" and "16.0" in _itx["text"], dict(_itx) if _itx else None)
                # A model hiccup reading an image (429) is NOT cached, so a later summary tries again.
                _img2 = a.evidence_store_attachment(_eid, "png", b"\x89PNG fake2", "image/png")[0]
                _iid2 = db.execute("INSERT INTO pm_evidence_attachments(evidence_id, filename, stored_path, content_type, "
                                   "size_bytes, storage_backend, uploaded_by) VALUES (?,?,?,'image/png',11,'local',?)",
                                   (_eid, "gp_screenshot2.png", _img2, subj)).lastrowid
                db.commit()

                def _busy(*aa, **kw):
                    raise ai_draft.AIDraftError("Azure OpenAI HTTP 429: busy")
                ai_draft.read_image = _busy
                p5 = a._pm_perf_summary_for(db, mgr, subj, generate=True)
                s.check("...a model hiccup reading an image is not cached (it will be tried again)",
                        not db.execute("SELECT 1 FROM pm_evidence_attachment_text WHERE attachment_id=?", (_iid2,)).fetchone()
                        and a._attach_unread_images(db, [_iid2]) == 1, p5.get("source"))
                db.execute("UPDATE pm_perf_summaries SET created_at=datetime('now','-11 minutes') WHERE subject_id=?",
                           (subj,)); db.commit()
                s.check("...and after 10 minutes the summary is due again (retried while an image is unread)",
                        a._pm_perf_summary_for(db, mgr, subj, generate=False)["pending"] is True)
                ai_draft.read_image = lambda data, mime, name="", **kw: (_ for _ in ()).throw(
                    ai_draft.AIDraftError("Azure OpenAI HTTP 400: images not supported"))
                a._pm_perf_summary_for(db, mgr, subj, generate=True)
                s.check("...while a refusal (4xx) is cached as unreadable, so it isn't retried forever",
                        (db.execute("SELECT status FROM pm_evidence_attachment_text WHERE attachment_id=?",
                                    (_iid2,)).fetchone() or {"status": None})["status"] == "unreadable")
            finally:
                a.ai_on, ai_draft.assess_performance, ai_draft.read_image = _real_on, _real_ap, _real_ri
            _rows = a._journey_team_summary(db, mgr, "pm_review")["rows"]
            _row = next((r for r in _rows if r["id"] == subj), {})
            s.check("the Team summary rows carry the summary + its structure (cache only)",
                    "ai_summary" in _row and "summary_pending" in _row and _row.get("ai_summary")
                    and (_row.get("summary_data") or {}).get("kpis"), _row)
            s.check("...and an `action` exactly when the manager has lines to moderate",
                    all((r.get("action") or "").startswith("Moderate ") == bool(r.get("can_approve") and not r.get("done"))
                        for r in _rows), [(r.get("status"), r.get("action")) for r in _rows])
            _pd = a._journey_team_pm_data(db, mgr, subj, "x")
            s.check("...and so does the Individual view", "ai_summary" in _pd and "summary_data" in _pd, list(_pd))
            _l0 = next((l for l in _pd["lines"] if l["id"] == t0["id"]), {})
            s.check("each line says whether its band moved (no per-KPI remark any more)",
                    "band_change" in _l0 and "report_note" not in _l0, _l0)
            s.check("...and the view carries their submitted overall remark + whether yours is required",
                    "renegotiated two contracts" in (_pd.get("report_remark") or "") and "remark_required" in _pd,
                    (_pd.get("report_remark"), _pd.get("remark_required")))
            _om = a._pm_overall_move(db, mgr, subj, period["id"])
            s.check("the gate reads the SAME overall bands the Individual view shows (their overall vs moderated)",
                    _om == ((_pd.get("overall_self") or {}).get("band"), (_pd.get("overall_mod") or {}).get("band")),
                    (_om, _pd.get("overall_self"), _pd.get("overall_mod")))
            s.check("the flat summary opens with the server's score headline",
                    (a._pm_perf_summary_for(db, mgr, subj, generate=False)["summary"] or "").startswith(
                        a._pm_perf_headline(a._pm_perf_source(db, mgr, subj)[4])))
            # "Open <name>" from chat: go_to_report takes a NAME (the VOICE rule forbids ids).
            _nm = db.execute("SELECT full_name FROM users WHERE id=?", (subj,)).fetchone()["full_name"]
            s.check("go_to_report resolves a person's NAME to their report",
                    a._journey_team_resolve_report(db, mgr, "pm_review", None, "go_to_report",
                                                   {"args": {"report": _nm}}) == subj)
            _task = a._journey_team_stage_task(db, mgr, "pm_review", subj)
            s.check("the manager agent sees the employee's submitted remark and the summary on screen",
                    "renegotiated two contracts" in _task and "performance summary on the manager's screen" in _task)
            _E = H.client_as(a, mgr["id"])
            _r1 = _E.post("/review/team/pm-summary", data={"csrf_token": "tok", "report": str(subj)})
            s.check("POST /review/team/pm-summary for your own report -> the summary and its structure",
                    _r1.status_code == 200 and (_r1.get_json() or {}).get("summary")
                    and ((_r1.get_json() or {}).get("data") or {}).get("kpis"), _r1.status_code)
            _r2 = _E.post("/review/team/pm-summary", data={"csrf_token": "tok", "report": "999999999"})
            s.check("...someone who isn't your report -> 404", _r2.status_code == 404, _r2.status_code)
            # A manager may ask about their people's profile (Chris, 2026-09-25): role, grade, department...
            _prof = a._journey_team_profiles(db, mgr, [subj])
            _psub = next((p for p in _prof if p.get("name") == _nm), {})
            s.check("the team agent knows its people's profile facts (role, job grade, department ...)",
                    _psub and set(_psub) <= {lab for _c, lab in a._TEAM_PROFILE_FIELDS}, _psub)
            _ost = db.execute("SELECT id FROM users WHERE id NOT IN (%s) AND role!='admin' AND COALESCE(manager_id,0)!=? "
                              "LIMIT 1" % ",".join(str(i) for i in reps + [mgr["id"]]), (mgr["id"],)).fetchone()
            s.check("...and nobody else's", not _ost or not any(
                p.get("staff_no") == db.execute("SELECT employee_id FROM users WHERE id=?", (_ost["id"],)).fetchone()[0]
                for p in _prof if p.get("staff_no")))
            _sys = a._journey_team_agent_system(db, mgr, a.review_state(db, mgr), "pm_review", subj)
            s.check("...and is told those questions are in scope for a manager",
                    "THEIR PEOPLE'S PROFILES" in _sys and "profile facts listed above are in scope" in _sys)
            # A line manager's lock is final (Chris, 2026-09-25): once their steps are locked, the remark can't change.
            _mine0 = a._pm_member_previews(db, subj, period["id"], mgr["id"])[0]
            _acts = [t for t in _mine0 if a._pm_line_actionable_by(t, mgr["id"])]
            for _t in _acts:
                a._pm_moderate_commit(db, mgr, _t["id"], "", None)
            _mine1 = a._pm_member_previews(db, subj, period["id"], mgr["id"])[0]
            if _acts:
                s.check("after the line manager locks their lines, their review is final (my_locked)",
                        a._pm_approver_done(mgr, _mine1) and a._journey_team_pm_data(db, mgr, subj, "x")["my_locked"])
                _rw = a._pm_manager_remark_write(db, mgr, period, subj, "A late change of heart.")
                s.check("...and the remark can no longer be edited (same as an employee's final confirmation)",
                        _rw[0] is None and (_rw[1] or {}).get("reason") in ("locked",), _rw)
                _ltask = a._journey_team_stage_task(db, mgr, "pm_review", subj)
                s.check("...and the agent is told it's locked and final",
                        "IS LOCKED -- final" in _ltask)
                s.check("...with no remark-writing instructions left in its task (the staging model kept offering to "
                        "'replace the overall remark' while they were there)",
                        "set_report_remark" not in _ltask and "REQUIRED when their" not in _ltask, _ltask[:300])
                s.check("the server knows the focused review is locked",
                        a._journey_team_focus_locked(db, mgr, "pm_review", subj))
                _say, _qr = a._team_locked_reply(
                    "All KPIs are locked and final. Would you like me to replace it now or keep it as is?",
                    ["Replace overall remark", "Keep as is", "Summarize team"], db, mgr, a.review_state(db, mgr),
                    "pm_review", subj)
                s.check("the model's offer to replace the remark is dropped (sentence + chips) and the way on added",
                        "replace" not in _say.lower() and "locked and final" in _say
                        and ("Next still to review" in _say or "Everyone here is reviewed" in _say
                             or "Nobody else has anything ready" in _say)
                        and not any(q in _qr for q in ("Replace overall remark", "Keep as is"))
                        and "Summarize team" in _qr, (_say, _qr))
                # Asked to change it: the server answers, with NO model call, and stays on the part.
                db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('review_unified','1')")
                db.commit()
                _calls = []
                _av0, _ag0 = a.ai_draft.review_agent_available, a.ai_draft.review_agent
                a.ai_draft.review_agent_available = lambda: True
                a.ai_draft.review_agent = lambda *x, **k: (_calls.append(1), {"say": "Moving to TM.", "quick_replies": [],
                                                                            "action": {"tool": "next", "args": {}}})[1]
                _seq = []

                def _mover(*x, **k):   # tries to switch part on its own, then just offers
                    _seq.append(1)
                    return ({"say": "Moving on.", "quick_replies": [], "action": {"tool": "next", "args": {}}}
                            if len(_seq) == 1 else
                            {"say": "Shall we go to the next part?", "quick_replies": [], "action": None})
                try:
                    _rl = _E.post("/review/chat", data={"csrf_token": "tok", "message": "Edit overall remark",
                                                        "journey": "1", "view": "team", "stage": "pm_review",
                                                        "mode": "detail", "report": str(subj)}).get_json() or {}
                    a.ai_draft.review_agent = _mover
                    _rn = _E.post("/review/chat", data={"csrf_token": "tok", "message": "ok thanks, what's next?",
                                                        "journey": "1", "view": "team", "stage": "pm_review",
                                                        "mode": "detail", "report": str(subj)}).get_json() or {}
                    s.check("'ok thanks, what's next?' -- the model's own switch of part is refused; it offers instead",
                            _rn.get("stage") == "pm_review" and not _rn.get("moved") and len(_seq) == 2,
                            (_rn.get("stage"), _rn.get("moved"), len(_seq)))
                    a.ai_draft.review_agent = lambda *x, **k: {"say": "Taking you to Competency Review now.",
                                                                "quick_replies": [], "action": {"tool": "next", "args": {}}}
                    _rf = _E.post("/review/chat", data={"csrf_token": "tok", "message": "hmm, what now?",
                                                        "journey": "1", "view": "team", "stage": "pm_review",
                                                        "mode": "detail", "report": str(subj)}).get_json() or {}
                    s.check("...and a turn that ends on refused moves never claims it moved: it offers, with the chip",
                            not _rf.get("moved") and "Taking you" not in (_rf.get("say") or "")
                            and "Say the word and I'll take you to" in (_rf.get("say") or "")
                            and any(str(q).startswith("Go to ") for q in (_rf.get("quick_replies") or [])),
                            (_rf.get("say"), _rf.get("quick_replies")))
                finally:
                    a.ai_draft.review_agent_available, a.ai_draft.review_agent = _av0, _ag0
                    db.execute("DELETE FROM app_settings WHERE key='review_unified'")
                    db.execute("DELETE FROM pm_manager_chat WHERE reviewer_id=? AND report_id=?", (mgr["id"], subj))
                    db.commit()
                s.check("'Edit overall remark' on a locked review -> the server says it's locked and final, no model "
                        "call, and the page stays on PM",
                        not _calls and "locked" in (_rl.get("say") or "") and "can't be changed" in (_rl.get("say") or "")
                        and _rl.get("stage") == "pm_review" and not _rl.get("moved"), (_calls, _rl.get("say"), _rl.get("stage")))
            else:
                s.check("SKIP: no actionable line to lock for the final-lock checks", True)
        finally:
            db.execute("DELETE FROM pm_kpi_approvals WHERE acted_by=? AND kpi_target_id IN (SELECT id FROM "
                       "pm_kpi_targets WHERE subject_id=?)", (mgr["id"], subj))
            db.execute("DELETE FROM pm_evidence_attachment_text WHERE attachment_id IN (SELECT a.id FROM "
                       "pm_evidence_attachments a JOIN pm_evidence e ON e.id=a.evidence_id WHERE e.subject_id=? "
                       "AND e.title='Finance sign-off of the H2 margin')", (subj,))
            db.execute("DELETE FROM pm_evidence WHERE subject_id=? AND title='Finance sign-off of the H2 margin'", (subj,))
            db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (t0["id"],))
            if _res0:
                cols = ",".join(_res0); db.execute("INSERT INTO pm_kpi_results(%s) VALUES (%s)"
                                                    % (cols, ",".join("?" * len(_res0))), list(_res0.values()))
            db.execute("DELETE FROM pm_overall_remarks WHERE cycle_id=? AND subject_id=?", (period["id"], subj))
            if _rem0:
                cols = ",".join(_rem0); db.execute("INSERT INTO pm_overall_remarks(%s) VALUES (%s)"
                                                    % (cols, ",".join("?" * len(_rem0))), list(_rem0.values()))
            db.execute("DELETE FROM pm_perf_summaries WHERE subject_id=?", (subj,))
            db.commit()
    else:
        s.check("SKIP: no manager with reports for the PM summary checks", True)
_jsp = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
s.check("client: the summary in the popout + the Individual block, fetched one report at a time",
        "function queuePmSummary(" in _jsp and '"/review/team/pm-summary"' in _jsp and "pmSumBusy" in _jsp
        and "data-pmsum-report" in _jsp and 'lmInsightFill(psm, "pm", pmSummaries[prid], pmSumFail[prid]);' in _jsp)
_lmt = _jsp[_jsp.index("  function lmTexts("):_jsp.index("  function lmVerdict(")]
_lmv = _jsp[_jsp.index("  function lmVerdict("):_jsp.index("  function lmInsightFill(")]
_lmf = _jsp[_jsp.index("  function lmInsightFill("):_jsp.index("  function lmPopBody(")]
s.check("client: the insight is the calibration card's verdict block (Chris, 2026-09-30: 'apply the same UI fix of the "
        "AI summary from the performance and potential calibration to our line manager team view for PM, TM, and IDP'): "
        "the question, the pill and its source on one line, then WHY and the written paragraph, then at most three "
        "things to check",
        all(q in _jsp for q in ('"Are their results justified by evidence?"', '"Does their self-assessment hold up?"',
                                '"Does the plan fit where they stand?"'))
        and '"rv-cal-verdict rv-lm-verdict"' in _lmv and "verdictPill(d.verdict)" in _lmv and "aiSrcTag(" in _lmv
        and '"rv-cal-why rv-lm-lead"' in _lmv and '"rv-cal-why rv-lm-para"' in _lmv
        and "d.verdict_why" in _lmt and "d.paragraph" in _lmt and "calSteps(d.discuss || [])" in _lmf)
s.check("...every fact once: a paragraph that already says the reason isn't led by it again",
        'lmNorm(body).indexOf(lmNorm(lead)) !== -1) lead = "";' in _lmt)
s.check("...the PM, TM and IDP Individual views and their repaints all draw it, and the old blocks are gone",
        'lmInsightFill(sb, "tm", tmSummaries[rid], tmSumFail[rid]);' in _jsp
        and 'function idpInsightFill(el, e, failed) { lmInsightFill(el, "idp", e, failed); }' in _jsp
        and 'lmInsightFill(el, "pm", pmSummaries[rid], pmSumFail[rid]);' in _jsp
        and not any(("function %s(" % f) in _jsp for f in ("pmSummaryView", "verdictBlock", "stepsBlock",
                                                          "pmSumPaint", "tmSumPaint")))
s.check("client: the KPIs are listed once (UX review F16) -- no evidence table above the moderation table; the table "
        "carries each KPI's Justified? (its reason on hover), filled in when the read arrives",
        "calEvidenceTable" not in _lmf and "<th rowspan='2' class='rv-mgr-justh'>Justified?</th>" in _jsp
        and "tr.appendChild(lmJustCell(l, ctx.rid));" in _jsp and 'tr.querySelector("td.rv-mgr-just")' in _jsp
        and "function kpiJustSpan(" in _jsp and "else if (k && k.justified) jc.appendChild(kpiJustSpan(k));" in _jsp)
s.check("client: the Remark column's popout carries the same block, then the first thing to check, and the column "
        "tags each person's verdict",
        "lmPopBody(wrap, kind, e);" in _jsp and '"Next: " + d.discuss[0]' in _jsp
        and "var vt = rmkVerdictTag(kind, r.id); if (vt) rin.appendChild(vt);" in _jsp)
_cssv = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
s.check("CSS: the verdict is symbol and word, no colour ('Not justified' darker); on a phone the table tag keeps its "
        "symbol and the word goes to the tooltip (Chris, 2026-09-30: 'too many colour')",
        H.cv('.rv-verdict[data-tone="bad"] { color: #1f2433; font-weight: 700; }') in _cssv
        and ".rv-mgr-sumtable .rv-verdict-tag .rv-vw { display: none; }" in _cssv
        and H.cv("background: #e6f4ee") not in _cssv.split(".rv-verdict {", 1)[1].split("}", 1)[0])
s.check("client: each KPI line in the manager's table lists its files, opening in the preview box (2026-11-07: fpvLink, the plain "
        "download as the href, data-fpv-src the ?disp=inline one)",
        "rv-mgr-file" in _jsp and 'fpvLink(a, "/evidence/attachment/" + f.id, f.name, l.base || l.kpi, f.size, f.gp)' in _jsp
        and 'setAttribute("data-fpv-src", dl + "?disp=inline")' in _jsp)
s.check("client: the summary sits behind an icon in an 'AI insight' column (no line under the row any more)",
        "<th class='rv-rmk-th'>\" + ICON.spark + \"AI insight</th>" in _jsp and "function rmkButton(" in _jsp and "rv-mgr-sumsub" not in _jsp)
s.check("client: one floating popout, opened on hover / focus, pinned on click, closed on Escape",
        "function rmkShow(" in _jsp and 'b.addEventListener("mouseenter"' in _jsp and 'b.addEventListener("focus"' in _jsp
        and 'e.key === "Escape"' in _jsp and "rmkPinned = true" in _jsp and 'rv-rmk-pop' in _jsp)
s.check("client: the Status column shows the next action as a button (else a quiet chip)",
        "function statusCell(" in _jsp and '"rv-act-btn"' in _jsp and "rv-status-chip" in _jsp
        and "tr.appendChild(statusCell(r));" in _jsp)
s.check("client: a file that doesn't back the result (or holds words written to the AI) says so on the Justified? cell's hover",
        "k.evidence_note && /^(partly|contradicts|not_shown|unread|flagged)$/.test(k.evidence" in _jsp)
s.check("client: the Individual view has a Remarks section BELOW the KPI table -- theirs, then yours "
        "(no remark columns squeezed into the table)",
        "box.appendChild(pmRemarksSection(data));" in _jsp and '"Their remark"' in _jsp and '"Your remark"' in _jsp
        and "rv-their-th" not in _jsp and "rv-myrm-th" not in _jsp and "function pmRemarkCell(" not in _jsp)
s.check("...your remark follows the OVERALL band: required while it moves, optional while it stays, with a "
        "word count (a guide, not a rule)",
        "function pmRemarkRequired()" in _jsp and "pmOverall.self !== pmOverall.mod" in _jsp
        and '" · aim 50–100"' in _jsp and "pmOverall.mod = j.mine_preview.label" in _jsp)
s.check("...Confirm & lock stops while it is required and empty, and saves it before locking",
        "pmRemarkRequired() && !pmWords(rta.value)" in _jsp
        and "flushes.push(pmRemarkSave(data.report_id, rta.value).then(" in _jsp
        and '"/performance/team/" + rid + "/remark-autosave"' in _jsp and "res.needs_remark" in _jsp)
_stx = {"period": {"half": 2}, "stages": [{"key": k, "group": "team", "state": "open", "short": k} for k in ("pm_review", "tm_review",
                                                                                       "plan_review")]}
s.check("a named team part moves ('Go to TM', 'IDP'); a question doesn't; next goes on in order",
        a._journey_team_stage_pick(_stx, "pm_review", "Go to TM") == "tm_review"
        and a._journey_team_stage_pick(_stx, "pm_review", "IDP review") == "plan_review"
        and a._journey_team_stage_pick(_stx, "pm_review", "What does TM cover for Aisha?") is None
        and a._journey_team_next_stage(_stx, "pm_review") == "tm_review"
        and a._journey_team_next_stage(_stx, "plan_review") is None)
s.check("once everyone in a part is reviewed the agent offers the next part, and the chip really moves",
        "ALL REVIEWED" in SRC and "Go to %s" in SRC and "_journey_team_stage_pick(st, active_stage, msg)" in SRC)
s.check("a manager whose own review is done is offered the Team review, and asking for it moves the page",
        a._JOURNEY_TEAM_GO_RE.search("Go to Team review") and a._JOURNEY_TEAM_GO_RE.search("take me to my team")
        and not a._JOURNEY_TEAM_GO_RE.search("how is my team doing?")
        and "goto=_journey_team_url(st)" in SRC and "They also MANAGE a team" in SRC
        and "window.location.href = j.goto" in _jsp)
s.check("a request to change it is recognised; a question about a change is not",
        all(a._TEAM_EDIT_REQ_RE.search(m) for m in ("Edit overall remark", "Replace overall remark",
                                                    "can I change my remark?", "help me redraft it",
                                                    "ok, I want to update Gross Profit"))
        and not any(a._TEAM_EDIT_REQ_RE.search(m) for m in ("why did the band change?", "what changed for Aisha?",
                                                            "Keep as is")))
s.check("an offer to change a locked review is spotted; saying it can't change is not",
        a._team_locked_offer("Would you like me to replace it now or keep it as is?")
        and a._team_locked_offer("Back to Aisha -- do you want to replace the overall remark now?")
        and not a._team_locked_offer("Your remark can't be changed now.")
        and not a._team_locked_offer("All KPIs for Aisha are locked and final."))
s.check("the reply to a locked review drops the offer + its chips and gives the way on",
        "_team_locked_reply(say, qr, db, u, st, active_stage, report)" in SRC
        and "_journey_team_focus_locked(db, u, active_stage, report)" in SRC
        and "_TEAM_EDIT_REQ_RE.search(msg)" in SRC)
s.check("an approved competency review and an agreed plan are final too",
        "YOU APPROVED IT -- the review is LOCKED and final" in SRC and 'return (idp or {}).get("status") == "closed"' in SRC)
s.check("'Open <name>' / 'Review <name>' opens that person (exact name), before the model -- from the summary too",
        "JUST OPENED" in SRC and '(?:open|review)\\s+(.+?)' in SRC
        and 'if opened and (opened != report or mode != "detail"):' in SRC)
s.check("client: a locked review's remark is read-only",
        "if (data.all_locked || data.my_locked) {" in _jsp)
s.check("client: a silent report switch refreshes the navigator, and a hand-opened Done group stays open",
        "swapChrome(j);              // ...and the navigator" in _jsp and "var wasOpen = " in _jsp)
s.check("opening one person from chat shows their table, from the Team summary tab too",
        'mode = "detail"' in SRC[SRC.find('if tool in ("go_to_report", "next_report"):'):][:900])
s.check("the 'Full profile' link is gone (summary rows + the detail header)",
        'pl.textContent = "Full profile"' not in _jsp and 'teamSelectReport(r.id, "profile")' not in _jsp
        and 'teamSelectReport(data.report_id, "profile")' not in _jsp)

# ---------------------------------------------------------------------------
s.section("demo: the login shown as 'Employee' gets no Team view (Chris, 2026-09-24)")
with a.app.app_context():
    db = a.get_db()
    _cid = a.active_cycle_id(db)
    _vbg = "ZZ Viewing-As BG"

    def _vu(eid, persona=None, switcher=0):
        # a grade and a confirmation date: a report who takes part in Performance, which is what a leader's team is made
        # of since the lists follow the report's participation (2026-10-30; without them the person is out of the cycle)
        return db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                          "company, department, demo_persona, demo_switcher, job_grade, confirmation_date) "
                          "VALUES (?,?,'x','user',?,?,'ZZ Co','ZZ D',?,?,'14','2020-01-01')",
                          (eid, eid, eid, _vbg, persona, switcher)).lastrowid
    # idempotent: this suite runs on a persistent scratch DB
    for _old in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZVA-%'").fetchall():
        db.execute("DELETE FROM pm_kpi_target_approvers WHERE approver_id=? OR kpi_target_id IN "
                   "(SELECT id FROM pm_kpi_targets WHERE subject_id=?)", (_old["id"], _old["id"]))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id=?", (_old["id"],))
        db.execute("DELETE FROM users WHERE id=?", (_old["id"],))
    VLOG = _vu("ZZVA-LOGIN", None, 1)          # the demo login: a switcher, not itself a persona
    VEMP = _vu("ZZVA-EMP", "employee")
    VMGR = _vu("ZZVA-MGR", "manager")
    _vt = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, "
                     "business_group) VALUES (?,?,?,100,'more','approved',?)", (_cid, VEMP, "ZZVA KPI", _vbg)).lastrowid
    db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (_vt, VLOG))
    db.commit()
with a.app.test_request_context("/review/journey"):
    from flask import session as _vs
    db = a.get_db()
    _vs["user_id"] = VLOG
    _lu = dict(db.execute("SELECT * FROM users WHERE id=?", (VLOG,)).fetchone())
    s.check("the demo login really approves a KPI line (it has a team)", a._pm_manages_anyone(db, _lu) is True)
    s.check("...but with no persona picked the dropdown reads 'Employee', so there is no Team view",
            a._review_manages(db, _lu) is False)
    _vs["demo_as"] = VMGR
    s.check("once a persona is picked, the rule no longer applies to the login",
            a._demo_login_shown_as_employee(_lu) is False)
with a.app.test_request_context("/"):
    from flask import session as _vs2
    db = a.get_db()
    period = a.active_pm_period(db)
    _rm = _find_manager(db, period["id"]) if period else None
    if _rm:
        _vs2["user_id"] = _rm["id"]
        s.check("a real approver (no demo switcher) still gets the Team view", a._review_manages(db, _rm) is True)
_vhtml = H.client_as(a, VLOG).get("/review/journey").get_data(as_text=True)
s.check("the journey page offers no Team tab to the demo login shown as Employee",
        ">Team<" not in _vhtml and "Team Review" not in _vhtml, _vhtml[:200])
_navt = open(os.path.join(H.REPO, "templates", "_journey_nav.html"), encoding="utf-8").read()
s.check("the team navigator splits To review / Done, with reviewed reports still clickable",
        "rv-nav-done-team" in _navt and "{% for it in done %}{{ nav_item(it, nav) }}{% endfor %}" in _navt
        and "{% for it in pending %}{{ nav_item(it, nav) }}{% endfor %}" in _navt)
s.check("...and the client opens the Done group when the focused report is in it",
        'el.closest("details.rv-nav-done")' in _jsp)

# ---------------------------------------------------------------------------
s.section("the manager's table comes to the reply when asked (Chris, 2026-09-25: 'same goes for ... all roles')")
with a.app.test_request_context("/review/journey"):
    db = a.get_db()
    period = a.active_pm_period(db)
    _wm = _find_manager(db, period["id"]) if period else None
    if _wm:
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('review_unified','1')")
        db.commit()
if _wm:
    _avT, _agT = a.ai_draft.review_agent_available, a.ai_draft.review_agent
    _TSAY = ["Sure -- it's just below."]
    a.ai_draft.review_agent_available = lambda: True
    a.ai_draft.review_agent = lambda *x, **k: {"say": _TSAY[0], "quick_replies": [], "action": None}
    try:
        _ET = H.client_as(a, _wm["id"])
        _t1 = _ET.post("/review/chat", data={"csrf_token": "tok", "message": "show me the table again", "journey": "1",
                                             "view": "team", "stage": "pm_review", "mode": "summary"}).get_json() or {}
        s.check("a manager's 'show me the table again' -> a firm stage_focus render for the part they're on",
                {"type": "stage_focus", "stage": _t1.get("stage")} in (_t1.get("renders") or []), _t1.get("renders"))
        _TSAY[0] = "Enter your moderated figures in the table, then Confirm & lock."
        _t2 = _ET.post("/review/chat", data={"csrf_token": "tok", "message": "what does moderating mean?",
                                             "journey": "1", "view": "team", "stage": "pm_review",
                                             "mode": "summary"}).get_json() or {}
        s.check("...a reply that sends them to the table -> a soft one",
                any(r.get("type") == "stage_focus" and r.get("soft") for r in (_t2.get("renders") or [])),
                _t2.get("renders"))
    finally:
        a.ai_draft.review_agent_available, a.ai_draft.review_agent = _avT, _agT
        with a.app.app_context():
            _dbT = a.get_db()
            _dbT.execute("DELETE FROM app_settings WHERE key='review_unified'")
            _dbT.execute("DELETE FROM pm_manager_chat WHERE reviewer_id=?", (_wm["id"],))
            _dbT.commit()
else:
    s.check("SKIP: no manager with KPI lines for the team focus checks", True)

# ---------------------------------------------------------------------------
s.section("the team read path is read-only (no writes in the new helpers)")
# The manager view is a pure projection in this phase; a stray INSERT/UPDATE/DELETE in a
# read helper would be a real defect (the write phase adds them deliberately, elsewhere).
for fn in ("_journey_team_reports", "_journey_team_nav_items", "_journey_team_overview",
           "_journey_team_summary", "_journey_team_pm_data", "_journey_team_tm_data",
           "_journey_team_plan_data", "_journey_active_report", "_journey_team_live_stages",
           "_pm_perf_source", "_tc_summary_source", "_tc_competency_band"):
    i0 = SRC.find("def %s(" % fn)
    i1 = SRC.find("\ndef ", i0 + 1)
    body = SRC[i0:i1]
    s.check("%s writes nothing (read-only projection)" % fn,
            "INSERT" not in body and "UPDATE" not in body and "DELETE" not in body, fn)

# ---------------------------------------------------------------------------
s.section("the insight's words, as the reader sees them (UI audit, 2026-09-29)")
_pol = a._insight_polish
s.check("the person is 'they' (their name is on the card once, as its heading) -- sentence start, possessive, mid-sentence",
        _pol("ZZ reports an on-target overall result.", "ZZ Demo Report 12 (CHBM)") == "They report an on-target overall result."
        and _pol("Ahmad's remark is blank; Ahmad gave no note.", "AHMAD ZZ SAMPLE")
        == "Their remark is blank; they gave no note.",
        (_pol("ZZ reports an on-target overall result.", "ZZ Demo Report 12 (CHBM)"),
         _pol("Ahmad's remark is blank; Ahmad gave no note.", "AHMAD ZZ SAMPLE")))
_pj = _pol("The case file provides no supporting files, so neither keyed result is independently substantiated.", "")
s.check("the prompt's jargon becomes plain words ('case file', 'keyed', 'substantiated'), and a sentence starts upper-case",
        _pj == "Their record provides no supporting files, so neither result is backed.", _pj)
_pp = _pol("Gross Profit rests on the figure alone.; Direct Materials Cost: 42 % vs 42.. See -- the file.", "")
s.check("clean punctuation: no '.;', '..', ' -- ' or '42 %' (an ellipsis '...' is left alone)",
        ".;" not in _pp and ".." not in _pp and " -- " not in _pp and "42 %" not in _pp and "42%" in _pp
        and _pol("Wait...", "") == "Wait...", _pp)
_vk = [{"kpi": "Gross Profit", "justified": "no", "justified_why": "The above-target result rests on the figure alone."},
       {"kpi": "Direct Materials Cost", "justified": "partly", "justified_why": "On target, but nothing supports it."}]
_vw = a._pm_perf_verdict_why(_vk, "")
s.check("the verdict's reason is one clean sentence (it read '...support it.; Direct ... supports it.. They wrote')",
        ".;" not in _vw and ".." not in _vw and "Gross Profit: the above-target" in _vw and _vw.endswith("remark."), _vw)
s.check("the count sentence names nobody and says the count in words",
        a._pm_perf_count_read(0, 2) == "Both KPIs came in below target." and a._pm_perf_count_read(2, 2) == "Both KPIs met or beat target."
        and a._pm_perf_count_read(1, 3) == "1 of 3 KPIs met or beat target." and a._pm_perf_count_read(0, 0) == "No results yet."
        and a._pm_perf_count_read(1, 1) == "Their one KPI met or beat target.")
_sk = [{"kpi": "Gross Profit", "justified": "no", "evidence": "none", "group": "well", "band": "AE"},
       {"kpi": "Direct Materials Cost", "justified": "no", "evidence": "none", "group": "well", "band": "ME"},
       {"kpi": "Net Revenue", "justified": "no", "evidence": "contradicts", "group": "well", "band": "AE"}]
_sc = a._pm_perf_steps(_sk, "not_justified", "calibrator")
s.check("a calibrator's steps are short, say what to DO, and say where the result really lands ('on target' for ME, "
        "never 'above target')",
        "Check the file on Net Revenue \u2014 it doesn't match their result." in _sc
        and "Ask for evidence behind Gross Profit's above target result." in _sc
        and "Ask for evidence behind Direct Materials Cost's on target result." in _sc
        and all(len(x) <= 100 for x in _sc) and not any("--" in x for x in _sc), _sc)
_sm = a._pm_perf_steps(_sk[:2], "not_justified")
s.check("...a line manager's keep their own wording, with a real dash",
        any(x.startswith("No supporting file for Gross Profit, a result above target \u2014") for x in _sm)
        and any("a result on target" in x for x in _sm) and not any("--" in x for x in _sm), _sm)
s.check("one step per KPI: the model's 'Ask for evidence supporting the Gross Profit result' beside the server's is dropped",
        a._pm_perf_merge_discuss(["No supporting file for Gross Profit, ask for evidence."],
                                 ["Ask for evidence supporting the Gross Profit result.", "Ask about the Q4 order."],
                                 limit=3, kpi_names=["Gross Profit"])
        == ["No supporting file for Gross Profit, ask for evidence.", "Ask about the Q4 order."])
s.check("'Nothing to query' stands alone: the model's 'Accept X as entered' steps are dropped beside it, and a real "
        "question from the model replaces it",
        "_asks = [x for x in discuss if not re.match(" in SRC
        and "steps = [x for x in steps if x not in _clean] + ([] if _asks else _clean)" in SRC)
s.check("the prompt asks for 'they' and one sentence of WHY, never 'keyed' / 'case file'",
        "never by name" in open(os.path.join(H.REPO, "ai_draft.py"), encoding="utf-8").read()
        and "ONE sentence, at most 30 words: WHY the verdict" in open(os.path.join(H.REPO, "ai_draft.py"), encoding="utf-8").read())
s.check("every stored insight is polished at the source, and the navigator lists people in the card's order",
        "data = _pm_perf_polish(data, _fullname)" in SRC
        and "return out   # the card's paging order" in SRC)

with a.app.app_context():
    _db_h = a.get_db()
    _db_h.execute("UPDATE cycles SET half=? WHERE id=?", (_HALF_WAS, _HALF_CID))
    _db_h.execute("DELETE FROM cycle_modules WHERE module_key IN ('review','pm','tm','idp','evidence')")
    for _r in _MODS_WAS:
        _db_h.execute("INSERT INTO cycle_modules(%s) VALUES (%s)" % (",".join(_r), ",".join("?" * len(_r))),
                      list(_r.values()))
    if _RU_WAS is None:
        _db_h.execute("DELETE FROM app_settings WHERE key='review_unified'")
    else:
        _db_h.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', ?)", (_RU_WAS["value"],))
    _db_h.commit()
    _key = lambda r: (r["cycle_id"], r["module_key"])  # noqa: E731
    s.check("the cycle's half, its modules and review_unified are put back as found (it shares the batch's database)",
            _db_h.execute("SELECT half FROM cycles WHERE id=?", (_HALF_CID,)).fetchone()["half"] == _HALF_WAS
            and sorted((dict(r) for r in _db_h.execute(
                "SELECT * FROM cycle_modules WHERE module_key IN ('review','pm','tm','idp','evidence')")), key=_key)
            == sorted(_MODS_WAS, key=_key)
            and [tuple(r) for r in _db_h.execute("SELECT value FROM app_settings WHERE key='review_unified'")]
            == ([tuple(_RU_WAS)] if _RU_WAS is not None else []))
sys.exit(s.done())
