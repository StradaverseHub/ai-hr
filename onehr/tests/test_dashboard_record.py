"""The one-page dashboard's record panel (Chris, 2026-10-08: "For the past or completed reports, build a new view that
slides from the right when clicked, and also add in AI element to the history record"), and what it may show (Chris,
the same day: "for past cycle record, we should only show the final band for performance and potential and user
wouldn't be able to look into their KPI table ... What is important is the talent status ... user can view their
present cycle status and record in detail but it stops at LM approved level, HOD, BUCEO and BGCEO will be hidden ...
User gets to see their full IDP history in details and their LM remarks on it. User will also able to view the 360
report. For KPI, competency, only the calibrated bands are shown without the details.").

What this suite holds:

  * SELF-SCOPED: only the person's own cycles open -- another person's cycle and an admin 404
  * a history entry is the FINAL bands and talent status (each only once released), the 360 once released, and the
    plan in full with the manager's remark -- never a KPI line, a competency answer, a line manager's score or a remark
  * the current cycle joins the history once anything of it is released; a past half's KPI page and JSON are gone
  * THIS cycle in detail (GET /me/record/current) stops at the line manager: no final band, no talent status
  * the AI snapshot is checked against the case (bands only if released, no pay / promotion, no invented figure),
    cached, and written again when what was released changes; the trend reads released final bands only
  * no top-level function is defined twice (the staging probe found a clash)

Shares the suite database and removes everything it adds.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Dashboard record panel -- final bands, the plan, this cycle up to the line manager")
SU, _BG, _EMP = H.actors(a)
BG, CO = "ZZDR Group", "ZZDR Co"

with a.app.app_context():
    db = a.get_db()
    # a run that crashed leaves its rows in the shared database -- clear them first
    _old = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZDR-%'")]
    for _uid in _old:
        db.execute("DELETE FROM record_snapshots WHERE subject_id=?", (_uid,))
        db.execute("DELETE FROM result_releases WHERE subject_id=?", (_uid,))
        db.execute("DELETE FROM pm_overall_remarks WHERE subject_id=?", (_uid,))
        db.execute("DELETE FROM pm_idp_goals WHERE idp_id IN (SELECT id FROM pm_idp WHERE subject_id=?)", (_uid,))
        db.execute("DELETE FROM pm_idp WHERE subject_id=?", (_uid,))
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id=?)",
                   (_uid,))
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id=?", (_uid,))
        db.execute("DELETE FROM users WHERE id=?", (_uid,))
    db.execute("DELETE FROM cycles WHERE code LIKE 'ZZDR-%'")
    db.commit()
    C_OLD = db.execute("INSERT INTO cycles(code, name, is_active, year, half, ends_on) "
                       "VALUES ('ZZDR-2024-H1', 'ZZDR 2024 Mid-Year', 0, 2024, 1, '2024-06-30')").lastrowid
    C_PAST = db.execute("INSERT INTO cycles(code, name, is_active, year, half, ends_on) "
                        "VALUES ('ZZDR-2024-H2', 'ZZDR 2024 Year-End', 0, 2024, 2, '2024-12-31')").lastrowid
    C_THEIRS = db.execute("INSERT INTO cycles(code, name, is_active, year, half, ends_on) "
                          "VALUES ('ZZDR-2023-H2', 'ZZDR 2023 Year-End', 0, 2023, 2, '2023-12-31')").lastrowid
    CID = a.active_cycle_id(db)
    PID = a.active_pm_period_id(db)

    def person(n):
        return db.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, "
                          "company, department, job_title, job_grade) VALUES (?,?,'x','user',?,?,?,'Ops','Planner',14)",
                          ("zzdr-%d" % n, "ZZDR Person%d Tan" % n, "ZZDR-%d" % n, BG, CO)).lastrowid
    SUBJ, OTHER = person(1), person(2)
    _had_bg = db.execute("SELECT 1 FROM pm_bg_config WHERE business_group=?", (BG,)).fetchone()
    if not _had_bg:
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))

    def kpi(cid, who, name, rates, actual, locked=True):
        tid = db.execute(
            "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
            "company, rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?,50,'more','approved',?,?,?,?,?,?,?)",
            (cid, who, name, BG, CO) + tuple(rates)).lastrowid
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft, admin_filled) "
                   "VALUES (?,?,?,0,?)", (tid, actual, who, 1 if locked else 0))
        return tid

    kpi(C_PAST, SUBJ, "ZZDR Gross Profit", (9, 11, 12, 13, 15), 15)      # rung 5
    kpi(C_PAST, SUBJ, "ZZDR Deliveries", (1, 2, 3, 4, 5), 3)             # rung 3
    kpi(C_OLD, SUBJ, "ZZDR Gross Profit", (9, 11, 12, 13, 15), 12)       # rung 3
    kpi(C_OLD, SUBJ, "ZZDR Deliveries", (1, 2, 3, 4, 5), 3)              # rung 3
    kpi(C_THEIRS, OTHER, "ZZDR Sales", (1, 2, 3, 4, 5), 4)               # only OTHER's
    T_NOW = kpi(PID, SUBJ, "ZZDR Output Now", (1, 2, 3, 4, 5), 4, locked=False)   # this cycle, not approved yet
    db.execute("INSERT INTO pm_overall_remarks(cycle_id, subject_id, remark, submitted_by, draft) VALUES (?,?,?,?,0)",
               (C_PAST, SUBJ, "Gross profit held up because I renegotiated two supplier contracts in Q3.", SUBJ))
    # the 2025 plan (from 2024 Year-End) -- closed, with the manager's remark and a goal comment
    IDP_PAST = db.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status, manager_comment) "
                          "VALUES (2025, ?, ?, 'closed', 'Good focus on cost analysis; keep the monthly review going.')",
                          (C_PAST, SUBJ)).lastrowid
    db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, target_date, action_experience, action_exposure, "
               "progress_status, manager_comment) VALUES (?,1,'Cost analysis','2025-12-31',"
               "'Lead the monthly variance review','Shadow the finance lead','done','Well done on this one.')",
               (IDP_PAST,))
    db.commit()
    _ai_prev = db.execute("SELECT value FROM app_settings WHERE key='ai_review'").fetchone()

E = H.client_as(a, SUBJ)
O = H.client_as(a, OTHER)

# ---------------------------------------------------------------------------
s.section("self-scoped: only their own cycles open")
r = E.get("/me/record/%d" % C_PAST)
d = r.get_json() or {}
s.check("their past cycle opens (JSON)", r.status_code == 200 and d.get("name") == "ZZDR 2024 Year-End", r.status_code)
s.check("...newest first: the older cycle is a step away, nothing newer",
        d.get("newer") is None and d.get("older") == C_OLD and d.get("count") == 2 and d.get("position") == 1, d)
s.check("another person's cycle 404s (never a fallback)", E.get("/me/record/%d" % C_THEIRS).status_code == 404)
s.check("...and it's theirs to open", O.get("/me/record/%d" % C_THEIRS).status_code == 200)
s.check("the open cycle isn't in the history while nothing of it is released -- 404",
        E.get("/me/record/%d" % CID).status_code == 404)
s.check("an admin has no record -- 404", H.client_as(a, SU["id"]).get("/me/record/%d" % C_PAST).status_code == 404)
s.check("a crafted id 404s", E.get("/me/record/999999").status_code == 404)

# ---------------------------------------------------------------------------
s.section("a history entry: the final bands and talent status, the 360, the plan -- never the KPI table")
s.check("no KPI line, no line manager's score, no remark of theirs in a history entry",
        "perf" not in d and "remark" not in d and "competency" not in d, sorted(d))
s.check("before any release: no final band, no potential, no talent status",
        d["final"]["pm"] is None and d["final"]["pot"] is None and d.get("talent") is None, d.get("final"))
s.check("the plan in full: each goal's area, date, 70:20:10 actions and where it got to",
        d["plan"] and d["plan"]["year"] == 2025 and d["plan"]["goals"][0]["area"] == "Cost analysis"
        and [x["label"] for x in d["plan"]["goals"][0]["actions"]][:2] == ["On the job", "From others"]
        and d["plan"]["goals"][0]["progress"] == "Done" and d["plan"]["goals"][0]["target_date"] == "31 Dec 2025",
        d.get("plan"))
s.check("...with the line manager's remarks, the plan's and the goal's (closed plan)",
        (d["plan"]["lm_remark"] or "").startswith("Good focus on cost analysis")
        and d["plan"]["goals"][0]["lm_comment"] == "Well done on this one.", d["plan"])
with a.app.app_context():
    db = a.get_db()
    db.execute("INSERT INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pm'), (?,?, 'pm')",
               (C_PAST, SUBJ, C_OLD, SUBJ))
    db.commit()
d2 = E.get("/me/record/%d" % C_PAST).get_json()
s.check("once Performance is released, its final band shows (named) -- the calibrated outcome, not the KPI table",
        d2["final"]["pm"] and d2["final"]["pm"]["band"] == "AE" and d2["final"]["pm"]["name"] == "Above Expectation"
        and "perf" not in d2, d2["final"])
with a.app.test_request_context("/"):
    from flask import session as _s
    _s["user_id"] = SUBJ
    _db = a.get_db()
    _u = dict(_db.execute("SELECT * FROM users WHERE id=?", (SUBJ,)).fetchone())
    _p = a._record_panel(_db, _u, C_PAST)
    _case, _f = a._record_case(_p)
s.check("the AI's case holds only what the entry shows: the released final band and the plan with its remark",
        "Above Expectation" in _case and "Cost analysis" in _case and "Good focus" in _case
        and "ZZDR Gross Profit" not in _case and "renegotiated" not in _case
        and "talent status" not in _case.lower(), _case)
r = E.get("/performance?period=%d" % C_PAST)
s.check("a past half's KPI page goes to its history entry on the dashboard (never its KPI table)",
        r.status_code in (301, 302) and r.headers.get("Location", "").endswith("/dashboard?record=%d" % C_PAST),
        (r.status_code, r.headers.get("Location")))
_sj = E.get("/performance/summary?period=%d" % C_PAST)
s.check("...and its KPI JSON is gone (the route, retired 2026-10-31, goes to the dashboard)",
        _sj.status_code == 302 and _sj.headers.get("Location", "").endswith("/dashboard") and not _sj.is_json)

# ---------------------------------------------------------------------------
s.section("this cycle in detail stops at the line manager; released results join the history")
pc = E.get("/me/record/current").get_json() or {}
_now = [ln for ln in (pc.get("perf") or {}).get("lines", []) if ln["name"] == "ZZDR Output Now"]
s.check("this cycle: their KPI line, the manager's figure only once locked, no overall until every line is approved",
        pc.get("mode") == "present" and _now and _now[0]["self"] == 4.0 and _now[0]["moderated"] is None
        and pc["perf"]["overall"] is None and pc["perf"]["lm_remarks"] == [], pc.get("perf"))
s.check("...and never a calibrated band or a talent status", "final" not in pc and "talent" not in pc, sorted(pc))
with a.app.test_request_context("/"):
    from flask import session as _s2
    _s2["user_id"] = SUBJ
    _db = a.get_db()
    _u2 = _db.execute("SELECT * FROM users WHERE id=?", (SUBJ,)).fetchone()
    _st = a.dash_standing(_db, _u2, a.active_pm_period(_db), a.active_cycle(_db))
s.check("Where you stand stops at the line manager too: no final band, no potential band, no talent status",
        not any(t.get("final_band") or t.get("category") or t["key"] in ("potential", "talent") for t in _st),
        [t["key"] for t in _st])
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE pm_kpi_results SET admin_filled=1 WHERE kpi_target_id=?", (T_NOW,))
    db.execute("INSERT INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pm')", (PID, SUBJ))
    db.commit()
_rows_now = E.get("/me/record/%d" % PID)
s.check("once a super admin releases this cycle's result, it joins the history with its final band",
        _rows_now.status_code == 200 and (_rows_now.get_json() or {}).get("current") is True
        and ((_rows_now.get_json() or {}).get("final") or {}).get("pm") is not None, _rows_now.status_code)
with a.app.app_context():
    db = a.get_db()
    db.execute("DELETE FROM result_releases WHERE cycle_id=? AND subject_id=?", (PID, SUBJ))
    db.commit()

# ---------------------------------------------------------------------------
s.section("the AI snapshot: checked against the case, cached, written again when what was released changes")
_calls = []
_real = (a.ai_draft.summarise_record, a.ai_draft.is_configured)
_reply = {"text": ""}


def _stub(first, case, kind="cycle", timeout=20, max_tokens=1200):
    _calls.append(kind)
    return json.dumps({"snapshot": _reply["text"]} if kind == "cycle" else {"trend": _reply["text"]})


a.ai_draft.summarise_record = _stub
a.ai_draft.is_configured = lambda: True


def _clear():
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM record_snapshots WHERE subject_id=?", (SUBJ,))
        db.commit()


def _snap():
    return E.post("/me/record/%d/snapshot" % C_PAST, data={"csrf_token": "tok"}).get_json() or {}


PLAIN = "After calibration your final performance band was Above Expectation."
try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM app_settings WHERE key='ai_review'")
        db.commit()
    _clear()
    _reply["text"] = ("You finished the year Above Expectation after calibration, and your plan took on cost analysis, "
                      "which your line manager said was a good focus.")
    j = _snap()
    s.check("a grounded snapshot is shown as the AI's", j.get("ok") and j.get("source") == "ai"
            and "Above Expectation" in (j.get("text") or ""), j)
    n0 = len(_calls)
    j2 = _snap()
    s.check("...and cached: the second open doesn't ask the model again", len(_calls) == n0 and j2.get("text") == j.get("text"))
    g = E.get("/me/record/%d" % C_PAST).get_json()
    s.check("...the entry's own read carries the cached snapshot", (g.get("snapshot") or {}).get("source") == "ai")
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM result_releases WHERE cycle_id=? AND subject_id=?", (C_PAST, SUBJ))
        db.commit()
    n1 = len(_calls)
    _snap()
    s.check("a change in what was released writes it again (the case is in the cache's fingerprint)", len(_calls) == n1 + 1)
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pm')", (C_PAST, SUBJ))
        db.commit()
    for label, text in (
            ("a KPI result (never in a history entry)", "ZZDR Gross Profit carried you to Above Expectation."),
            ("a talent status that wasn't released", "A strong year that put you in Star, Above Expectation."),
            ("a potential band that wasn't released", "You finished Above Expectation with high potential this year."),
            ("pay or promotion", "Above Expectation, which should help your bonus this year."),
            ("a figure the case doesn't have", "You came in 30% ahead, finishing Above Expectation."),
            ("a band the record doesn't hold", "You came in Below Expectation for you this year."),
            # lower case passes the name check (every word is in the case or the vocabulary) -- only the band check can
            ("...the same band in lower case", "Your final band was below expectation this year, after calibration."),
            ("...a talent status in lower case", "A solid core year, Above Expectation after calibration.")):
        _clear()
        _reply["text"] = text
        jr = _snap()
        s.check("refused, the released facts shown instead: %s" % label, jr.get("source") == "plain"
                and (jr.get("text") or "").startswith(PLAIN), jr)
    # the GPT-6 Luna probe on staging (2026-10-08): the model narrated the gaps in its case, opened sentences with
    # "They" (the colleagues) and was asked about a record holding nothing but its cycle's name
    _clear()
    _reply["text"] = ("You finished the year Above Expectation after calibration. No development plan details or talent "
                      "status were provided.")
    jg = _snap()
    s.check("a sentence about what the record doesn't hold is dropped, the rest shown as the AI's",
            jg.get("source") == "ai" and "Above Expectation" in (jg.get("text") or "")
            and "provided" not in (jg.get("text") or ""), jg)
    s.check("...a snapshot that is ONLY about the gaps falls back to the released facts",
            a._record_tidy("No final bands were released for this cycle. The information provided includes only the "
                           "cycle label.") == "")
    s.check("a sentence may start with 'They' (the colleagues)",
            a._record_snapshot_error("Cycle: ZZDR\nYour final performance band after calibration (released to you): "
                                     "Above Expectation.", "You finished Above Expectation. They saw it too.") is None,
            a._record_snapshot_error("Cycle: ZZDR\nYour final performance band after calibration (released to you): "
                                     "Above Expectation.", "You finished Above Expectation. They saw it too."))
    s.check("...with a curly apostrophe too (\u2018They\u2019d\u2019, as the model writes it)",
            a._record_snapshot_error("Cycle: ZZDR\nYour final performance band after calibration (released to you): "
                                     "Above Expectation.", "You finished Above Expectation. They\u2019d like more of it.") is None)
    s.check("a released 360 with no principle standing out still says it was released (never 'nothing released')",
            "360 report was released" in a._record_case({"name": "ZZDR", "final": {"pm": None, "pot": None}, "talent": None,
                                                          "report": {"strong": [], "grow": [], "even": False},
                                                          "plan": None})[0]
            and a._record_snapshot_plain({"name": "ZZDR", "final": {"pm": None, "pot": None}, "talent": None,
                                          "report": {"strong": [], "grow": [], "even": False}, "plan": None})
            == "Your 360 report was released to you.")
    with a.app.app_context():
        db = a.get_db()
        n3 = len(_calls)
        t_, src_ = a._record_snapshot(db, _u, {"name": "ZZDR Empty", "key": 999999, "final": {"pm": None, "pot": None},
                                               "talent": None, "report": None, "plan": None}, generate=True)
        db.execute("DELETE FROM record_snapshots WHERE subject_id=? AND cycle_id=999999", (SUBJ,))
        db.commit()
    s.check("a record holding only its cycle's name never goes to the model", len(_calls) == n3 and src_ == "plain"
            and t_ == "Nothing from this cycle has been released to you yet.", (t_, src_, len(_calls) - n3))
    _clear()
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('ai_review', '0')")
        db.commit()
    n2 = len(_calls)
    jo = _snap()
    s.check("with the guided-review AI switched off, the released facts and no model call",
            jo.get("source") == "plain" and len(_calls) == n2, jo)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM app_settings WHERE key='ai_review'")
        db.commit()

    # -----------------------------------------------------------------------
    s.section("the trend: one line across the YEARS, from released Year-End results only (2026-10-14)")
    _clear()
    jt0 = E.post("/me/record/trend", data={"csrf_token": "tok"}).get_json() or {}
    s.check("a Mid-Year and its Year-End are one year -- no trend (a Mid-Year is only a checkpoint)",
            jt0.get("ok") and not jt0.get("text"), jt0)
    with a.app.app_context():   # a second Year-End for SUBJ: 2023
        db = a.get_db()
        kpi(C_THEIRS, SUBJ, "ZZDR Gross Profit", (9, 11, 12, 13, 15), 12)   # rung 3
        kpi(C_THEIRS, SUBJ, "ZZDR Deliveries", (1, 2, 3, 4, 5), 3)          # rung 3
        db.execute("INSERT INTO result_releases(cycle_id, subject_id, kind) VALUES (?,?, 'pm')", (C_THEIRS, SUBJ))
        db.commit()
    try:
        _clear()
        _reply["text"] = "Your Year-End result rose from Meet Expectation in 2023 to Above Expectation in 2024."
        jt = E.post("/me/record/trend", data={"csrf_token": "tok"}).get_json() or {}
        s.check("two released Year-End results -> the AI's trend", jt.get("ok") and jt.get("source") == "ai"
                and "rose from Meet Expectation" in (jt.get("text") or ""), jt)
        with a.app.test_request_context("/"):
            _db = a.get_db()
            _rows = a._record_rows(_db, _u)
            _case = a._record_trend_case(_db, _u, _rows)
            _plain = a._record_trend_plain(_db, _u, _rows)
        s.check("...the case lists the Year-End results, oldest first, and leaves the Mid-Year out",
                _case.find("2023 Year-End") > 0 and _case.find("2023 Year-End") < _case.find("2024 Year-End")
                and "Mid-Year checkpoint" not in _case, _case)
        s.check("...from the figures it reads oldest to newest, by year",
                _plain == "Your Year-End result went from Meet Expectation in 2023 to Above Expectation in 2024.", _plain)
    finally:
        with a.app.app_context():
            db = a.get_db()
            db.execute("DELETE FROM result_releases WHERE cycle_id=? AND subject_id=?", (C_THEIRS, SUBJ))
            db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE "
                       "cycle_id=? AND subject_id=?)", (C_THEIRS, SUBJ))
            db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?", (C_THEIRS, SUBJ))
            db.commit()
        _clear()
    jo2 = O.post("/me/record/trend", data={"csrf_token": "tok"}).get_json() or {}
    s.check("nothing released -> no trend (a line manager's score never makes one)", jo2.get("ok") and not jo2.get("text"), jo2)
finally:
    a.ai_draft.summarise_record, a.ai_draft.is_configured = _real

# ---------------------------------------------------------------------------
s.section("the dashboard lists them and draws the panel")
html = E.get("/dashboard").get_data(as_text=True)
_hi = html.find('class="od-card od-hist"')
_hist = html[_hi:html.find("</section>", _hi)]
s.check("the history card lists YEARS (2026-10-14, board D), each opening the full record at that year",
        _hist.count('class="od-row od-yrow"') == 1 and 'data-panel="records" data-arg="2024"' in _hist
        and "data-record=" not in _hist, _hist[:500])
_rowh = _hist[_hist.find('class="od-row od-yrow"'):_hist.find('</button>', _hist.find('class="od-row od-yrow"'))]
s.check("...a year carries its Year-End's final band, never the line manager's score, nor its Mid-Year",
        'data-band="AE"' in _rowh and "4.0" not in _rowh and "Year-End result" in _rowh
        and "Mid-Year checkpoint" not in _rowh, _rowh[:400])
s.check("...one year, so no 'older years' line", "older year" not in _hist)
s.check("each cycle still opens its record from the panel's list (Year-End first)",
        html.find('data-record="%d"' % C_PAST) > 0 and html.find('data-record="%d"' % C_PAST) < html.find('data-record="%d"' % C_OLD))
s.check("Where you stand opens this cycle in detail (while a cycle runs; between cycles the page is the record; someone "
        "not in this cycle's own review gets that card instead, 2026-10-10)",
        ('data-record="current"' in html) == ('class="od-card od-stand"' in html)
        and any(c_ in html for c_ in ('class="od-card od-stand"', 'class="od-card od-res"', 'class="od-card od-notin"')))
s.check("...the panel slides in from the right: one dialog, its script", 'data-od-drawer role="dialog"' in html
        and "dashboard.js" in html)
s.check("Succession and Reward are nowhere on it (archived 2026-10-08)", "/succession" not in html and "/reward" not in html)
_js = open(os.path.join(H.REPO, "static", "dashboard.js"), encoding="utf-8").read()
s.check("client: person-written text is set with textContent; the panel closes on Escape and gives focus back",
        # one exception, by its exact line: the Learning panel (AI+ Learning, 2026-10-20) is HTML the server renders
        # with Jinja's autoescape, never a JSON field of someone's words (test_lms holds its template free of |safe)
        ".innerHTML = d." not in _js.replace('body.innerHTML = d.html || "";', "") and "innerHTML = j." not in _js
        and 'e.key === "Escape"' in _js
        and "opener.focus()" in _js and "/me/record/" in _js)
_css_d = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
_drawer = html[html.find("data-od-drawer"):html.find("</aside>", html.find("data-od-drawer"))]
s.check("the panel closes on a thin bezel down its left edge, not an x (Chris, 2026-10-08: 'go with bezel on all') -- "
        "the bezel leads the panel, Newer / Older are words, the scrim and Escape close it too",
        'class="od-bezel" data-od-close aria-label="Close your record"' in _drawer
        and _drawer.find("od-bezel") < _drawer.find("od-sheet") and "&times;" not in _drawer and "×" not in _drawer
        and "&lsaquo; Newer</button>" in _drawer and "Older &rsaquo;</button>" in _drawer
        and 'bClose.addEventListener("click", close);' in _js and 'scrim.addEventListener("click", close);' in _js
        and ".od-bezel { flex: 0 0 22px; width: 22px;" in _css_d and ".od-ib[hidden] { display: none; }" in _css_d)
s.check("client: Escape closes the panel -- unless a header menu is open, which takes that Escape first",
        """if (document.querySelector('.js-dd[aria-expanded="true"]')) return;""" in _js
        and _js.index(".js-dd[aria-expanded") < _js.index("e.preventDefault(); close(); return;"))
s.check("client: a history entry draws the final bands, the line manager's strongest / to grow and the 360 -- no plan, "
        "it stays in its Career Plan card (off-cycle, 2026-10-18); this cycle the KPIs and competency",
        "[calls(d), report(d)]" in _js and "[report(d), plan(d)]" not in _js and "renderPresent(d, viaList)" in _js
        and "kpis(d) ||" in _js
        and "competency(d) ||" in _js and "var rp = report(d);" in _js and "var pl = plan(d);" in _js)
s.check("the routes are the person's own, like /me (classified, never module-gated)",
        {"my_record_cycle", "my_record_snapshot", "my_record_trend", "my_record_current"} <= set(a.MODULE_UNGATED_ENDPOINTS))

# ---------------------------------------------------------------------------
s.section("the tools open in the panel: the Career Plan by plan year, the 360 by cycle (Chris, 2026-10-09)")
with a.app.app_context():
    db = a.get_db()
    NOW = a._today_myt().year
    IDP_NOW = db.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status) VALUES (?, ?, ?, 'shared')",
                         (NOW, CID, SUBJ)).lastrowid
    db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, target_date, action_experience) "
               "VALUES (?,1,'ZZDR Supplier negotiation','%d-09-30','Run the Q3 tender')" % NOW, (IDP_NOW,))
    db.execute("INSERT INTO pm_idp_goals(idp_id, seq, area, target_date) VALUES (?,2,'ZZDR Free date','by year end')",
               (IDP_NOW,))
    # next year's plan, being drafted: the newest year, so the default can't be "the newest" by accident
    IDP_NEXT = db.execute("INSERT INTO pm_idp(plan_year, cycle_id, subject_id, status) VALUES (?, ?, ?, 'draft')",
                          (NOW + 1, CID, SUBJ)).lastrowid
    db.execute("INSERT INTO pm_career_profile(subject_id, aspiration_mid, aspiration_long, mobility) "
               "VALUES (?, 'ZZDR Senior planner', 'ZZDR Head of planning', NULL)", (SUBJ,))
    db.commit()
pj = E.get("/me/plan").get_json() or {}
_ys = [y["year"] for y in pj.get("years") or []]
s.check("the Career Plan opens on this calendar year's plan (Chris: 'default to 2026'), not the newest; newest first",
        pj.get("mode") == "plan" and pj.get("year") == NOW and _ys[0] == NOW + 1 and 2025 in _ys
        and _ys == sorted(_ys, reverse=True),
        (pj.get("year"), _ys))
_yn = next((y for y in pj.get("years") or [] if y["year"] == NOW), {})
s.check("...each year tagged in words ('this year · shared'), the older one 'closed'",
        _yn.get("tag") == "this year · shared"
        and next((y["tag"] for y in pj["years"] if y["year"] == NOW + 1), None) == "next · draft"
        and next((y["tag"] for y in pj["years"] if y["year"] == 2025), None) == "closed", pj.get("years"))
_pn = E.get("/me/plan?year=%d" % (NOW + 1)).get_json() or {}
s.check("...next year's plan opens too, with where they want to go (their profile today)",
        _pn.get("year") == NOW + 1 and (_pn.get("profile") or {}).get("next") == "ZZDR Senior planner", _pn.get("year"))
_g = (pj.get("plan") or {}).get("goals") or []
s.check("...the plan in full, its target dates as people read them; a date typed free-form stays as typed",
        [x["area"] for x in _g] == ["ZZDR Supplier negotiation", "ZZDR Free date"]
        and _g[0]["target_date"] == "30 Sep %d" % NOW and _g[1]["target_date"] == "by year end", _g)
s.check("...and where they want to go (their profile today) shows on this year's plan",
        (pj.get("profile") or {}).get("next") == "ZZDR Senior planner"
        and (pj.get("profile") or {}).get("longer") == "ZZDR Head of planning", pj.get("profile"))
p25 = E.get("/me/plan?year=2025").get_json() or {}
s.check("a past year opens with its manager's remark, and no profile (it isn't kept per year)",
        p25.get("year") == 2025 and (p25["plan"]["lm_remark"] or "").startswith("Good focus")
        and p25.get("profile") is None and p25.get("edit_url") is None, (p25.get("year"), p25.get("profile")))
s.check("a year that isn't theirs, or junk, falls back to the default -- never another person's plan",
        (E.get("/me/plan?year=1999").get_json() or {}).get("year") == NOW
        and (E.get("/me/plan?year=x").get_json() or {}).get("year") == NOW)
po = O.get("/me/plan?year=%d" % NOW).get_json() or {}
s.check("SELF-SCOPED: another person sees only their own plan years (none here), never this one's",
        "ZZDR Supplier negotiation" not in json.dumps(po) and "ZZDR Senior planner" not in json.dumps(po)
        and not [y for y in po.get("years") or [] if y.get("status")], po.get("years"))
s.check("...the panel links to the AI check-in only for the year being written, while it's a draft or not started",
        all((y["writing"] and y["status"] in (None, "draft")) == bool(
            (E.get("/me/plan?year=%d" % y["year"]).get_json() or {}).get("edit_url")) for y in pj.get("years") or [])
        and (pj.get("edit_url") is None or pj["edit_url"].endswith("stage=career_plan")), pj.get("years"))
s.check("an admin has no plan or report panel -- 404",
        H.client_as(a, SU["id"]).get("/me/plan").status_code == 404
        and H.client_as(a, SU["id"]).get("/me/report360").status_code == 404)
rj = E.get("/me/report360").get_json() or {}
s.check("the 360 panel with no 360 about them: no cycles, nothing released, no report",
        rj.get("mode") == "report" and rj.get("cycles") == [] and rj.get("released") is False
        and "principles" not in rj, rj)
s.check("both panels are the person's own, like /me (classified, never module-gated)",
        {"my_plan_panel", "my_report_panel"} <= set(a.MODULE_UNGATED_ENDPOINTS))

html = E.get("/dashboard").get_data(as_text=True)
with a.app.app_context():
    _mdb = a.get_db()
    _idp_on, _tm_on = a.cycle_module_on("idp", _mdb), a.cycle_module_on("tm", _mdb)
s.check("the tools are two cards that open the panel, each iff its module is on -- no Review conversations card",
        ('class="od-tcard" data-panel="plan"' in html) == _idp_on and ('class="od-tcard" data-panel="report"' in html) == _tm_on
        and "Review conversations" not in html, (_idp_on, _tm_on))
s.check("...the Career Plan card reads this year's plan", (not _idp_on) or ("%d plan · shared · 2 goals" % NOW) in html)
s.check("Full record opens the list in the panel (a button, not the /me page), every past cycle in its template",
        'class="od-linkbtn" data-panel="records"' in html and 'id="od-records-tpl"' in html
        and html.find('data-record="%d"' % C_OLD, html.find('id="od-records-tpl"')) > 0)
_od = html[html.find('class="od"'):]
# an email address (Help's, 2026-10-22) is no page
_hrefs = sorted(set(h_ for h_ in re.findall(r'href="([^"#]+)"', _od) if not h_.startswith("mailto:")))
with a.app.test_request_context("/"):
    _classic = {a.url_for(ep) for ep in ("my_report", "idp_view", "my_profile", "performance_my_view", "review_history")}
s.check("LINK AUDIT: nothing on a person's dashboard opens a classic module page -- only the AI+ journey and review "
        "(and AI+ Learning's own space, 2026-10-20, where Learning is on)",
        all(h_.startswith("/review/journey") or h_ == "/review" or h_.startswith("/learning") for h_ in _hrefs)
        and not ({h_.split("?")[0] for h_ in _hrefs} & _classic), _hrefs)
_js = open(os.path.join(H.REPO, "static", "dashboard.js"), encoding="utf-8").read()
s.check("client: the panels fetch /me/plan and /me/report360, the record's 360 opens in the panel, not the classic page",
        '"/me/plan' in _js and '"/me/report360' in _js and "Open the 360 report" in _js
        and "links.report_cycle" in _js and "links.report)" not in _js and ".href = links.report" not in _js)
s.check("client: reopening the panel while it slides out cancels the hide (a quick close-and-reopen left it hidden)",
        "if (hideT) { clearTimeout(hideT); hideT = null; }" in _js and "hideT = setTimeout(" in _js)
s.check("client: a cycle opened from the list has a way back to it; deep links ?panel=plan|report|records",
        "&lsaquo; Full record</button>" in html and "showList()" in _js and '"records"' in _js and "panel" in _js)
with a.app.app_context():
    db = a.get_db()
    db.execute("DELETE FROM pm_idp_goals WHERE idp_id=?", (IDP_NOW,))
    db.execute("DELETE FROM pm_idp WHERE id IN (?,?)", (IDP_NOW, IDP_NEXT))
    db.execute("DELETE FROM pm_career_profile WHERE subject_id=?", (SUBJ,))
    db.commit()

# ---------------------------------------------------------------------------
s.section("a released 360 reads through the panel and the pop-out (the staging probe found a name clash, 2026-10-08)")
for _f in ("app.py", "ai_draft.py"):
    _defs = re.findall(r"(?m)^def ([A-Za-z_0-9]+)\(", open(os.path.join(H.REPO, _f), encoding="utf-8").read())
    _dup = sorted({d_ for d_ in _defs if _defs.count(d_) > 1})
    s.check("no top-level function is defined twice in %s (the later one silently wins)" % _f, not _dup, _dup)
with a.app.app_context():
    _rel = a.get_db().execute(
        "SELECT rr.subject_id, rr.cycle_id, c.is_active FROM report_releases rr JOIN cycles c ON c.id=rr.cycle_id "
        "JOIN users u ON u.id=rr.subject_id WHERE u.role!='admin' AND u.left_at IS NULL "
        "ORDER BY c.is_active, rr.cycle_id DESC LIMIT 1").fetchone()
if _rel is None:
    s.check("SKIP: no released 360 report in this database", True)
else:
    _C = H.client_as(a, _rel["subject_id"])
    _jr = _C.get("/my-report/summary?cycle=%d" % _rel["cycle_id"])
    s.check("the old pop-out's /my-report/summary is retired (2026-10-31): it goes to the dashboard, no JSON",
            _jr.status_code == 302 and _jr.headers.get("Location", "").endswith("/dashboard") and not _jr.is_json,
            _jr.status_code)
    _rp = _C.get("/me/report360?cycle=%d" % _rel["cycle_id"]).get_json() or {}
    _txt = json.dumps(_rp)
    s.check("the 360 panel reads a released cycle: the principles and behaviours in words, never a % or a rater count",
        _rp.get("released") is True and _rp.get("cycle") == _rel["cycle_id"] and isinstance(_rp.get("principles"), list)
        and all("pct" not in p_ and p_["words"].startswith("seen") and 1 <= p_["level"] <= 4 for p_ in _rp["principles"])
        and "%" not in _txt and not re.search(r'"(yes|total|n_raters|raters|assessor\w*)"', _txt),
        [(p_.get("short"), p_.get("words")) for p_ in _rp.get("principles") or []][:3])
    _ids = {c_["id"] for c_ in _rp.get("cycles") or []}
    _un = next((c_ for c_ in _rp.get("cycles") or [] if not c_["released"]), None)
    if _un:
        _ru = _C.get("/me/report360?cycle=%d" % _un["id"]).get_json() or {}
        s.check("...a cycle not released yet shows as not released, with nothing of its report",
                _ru.get("released") is False and "principles" not in _ru, _ru)
    with a.app.app_context():
        _peer = a.get_db().execute(
            "SELECT id FROM users WHERE role!='admin' AND left_at IS NULL AND id!=? AND id NOT IN "
            "(SELECT subject_id FROM report_releases) LIMIT 1", (_rel["subject_id"],)).fetchone()
    if _peer:
        _pp = H.client_as(a, _peer["id"]).get("/me/report360?cycle=%d" % _rel["cycle_id"]).get_json() or {}
        s.check("SELF-SCOPED: someone else asking for that cycle never gets this person's report",
                not _pp.get("released") and "principles" not in _pp, _pp.get("cycle"))
    if not _rel["is_active"]:
        _pj = _C.get("/me/record/%d" % _rel["cycle_id"]).get_json() or {}
        s.check("...and the history entry shows that season's 360 (strongest / to grow, in words)",
                isinstance(_pj.get("report"), dict) and "strong" in _pj["report"] and "url" in _pj["report"], _pj.get("report"))

# ---------------------------------------------------------------------------
s.section("this cycle in detail: the AI read first, then Summary / KPI / 360 / Competency / Career Plan (2026-10-11)")
# Chris: "The this cycle in detail button from where you stand should also show the 360 of present cycle, and career
# plan of current cycle, serves with AI summary first, then the toggle to switch between summary, KPI, 360, Competency,
# and Career Plan."
with a.app.app_context():
    db = a.get_db()
    db.execute("DELETE FROM record_snapshots WHERE subject_id=? AND cycle_id<0", (SUBJ,))
    db.commit()
pc = E.get("/me/record/current").get_json() or {}
s.check("the present record carries what the tabs need: its cycle, the plan year, the 360's state, and no summary yet",
        pc.get("cycle_id") and pc.get("plan_year") and "report_last" in pc and pc.get("snapshot") is None, sorted(pc))
_pcalls, _preply = [], {"text": ""}
_real_p = (a.ai_draft.summarise_record, a.ai_draft.is_configured)


def _pstub(first, case, kind="cycle", timeout=20, max_tokens=1200):
    _pcalls.append((kind, case))
    return json.dumps({"snapshot": _preply["text"]})


a.ai_draft.summarise_record = _pstub
a.ai_draft.is_configured = lambda: True
try:
    _preply["text"] = "You are Solid Core this cycle, with a High potential band."   # neither is ever in the case
    j = E.post("/me/record/current/snapshot", data={"csrf_token": "tok"}).get_json() or {}
    _kind, _pcase = _pcalls[-1] if _pcalls else (None, "")
    s.check("the read is asked as the cycle in progress, from a case of only what they can see",
            _kind == "present" and "ZZDR Output Now" in _pcase and "Your line manager approved" in _pcase
            and "talent status" not in _pcase.lower() and "final" not in _pcase.lower()
            and "potential band" not in _pcase.lower(), _pcase.replace("\n", " | ")[:700])
    s.check("a reply naming a talent status or potential band (never in the case) is refused; the read falls back to the figures",
            j.get("ok") and j.get("source") == "plain" and "Solid Core" not in (j.get("text") or "")
            and "KPI" in (j.get("text") or ""), j)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM record_snapshots WHERE subject_id=? AND cycle_id<0", (SUBJ,))
        db.commit()
    _preply["text"] = ("Your line manager approved your KPI line ZZDR Output Now, with the rating Above Expectation. "
                       "Your 360 report for this cycle is released by Group People after calibration.")
    j = E.post("/me/record/current/snapshot", data={"csrf_token": "tok"}).get_json() or {}
    s.check("a grounded reply is shown as the AI read", j.get("ok") and j.get("source") == "ai"
            and "ZZDR Output Now" in j.get("text", ""), j)
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM record_snapshots WHERE subject_id=? AND cycle_id<0", (SUBJ,))
        db.commit()
    _preply["text"] = ("Your line manager has approved one of your one KPI lines, ZZDR Output Now, with the rating "
                       "Above Expectation. Your 360 report for this cycle is released by Group People after calibration.")
    j = E.post("/me/record/current/snapshot", data={"csrf_token": "tok"}).get_json() or {}
    s.check("a count written as a word ('one') is grounded too: the case gives counts both ways (the live probe's "
            "'three goals', 2026-10-12)", j.get("source") == "ai" and "1 (one)" in (_pcalls[-1][1] if _pcalls else ""), j)
    s.check("...and a plan status reads mid-sentence ('shared with your manager'), an acronym kept",
            a._rp_lower("Shared with your manager") == "shared with your manager" and a._rp_lower("IDP closed") == "IDP closed"
            and a._rp_count(3) == "3 (three)")
    n0 = len(_pcalls)
    pc2 = E.get("/me/record/current").get_json() or {}
    s.check("...cached: the panel opens on it next time with no new call",
            (pc2.get("snapshot") or {}).get("source") == "ai" and len(_pcalls) == n0, pc2.get("snapshot"))
    with a.app.app_context():
        db = a.get_db()
        _neg = db.execute("SELECT COUNT(*) FROM record_snapshots WHERE subject_id=? AND cycle_id=?",
                          (SUBJ, -int(pc["cycle_id"]))).fetchone()[0]
    s.check("...under the cycle's negative id, so it never overwrites that cycle's history snapshot", _neg == 1, _neg)
    a.ai_draft.is_configured = lambda: False
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM record_snapshots WHERE subject_id=? AND cycle_id<0", (SUBJ,))
        db.commit()
    j = E.post("/me/record/current/snapshot", data={"csrf_token": "tok"}).get_json() or {}
    s.check("no model: a read from the figures, never a calibrated band", j.get("ok") and j.get("source") == "plain"
            and j.get("text") and not any(w in j["text"] for w in ("Solid Core", "Talent", "potential band")), j)
finally:
    a.ai_draft.summarise_record, a.ai_draft.is_configured = _real_p
_js = open(os.path.join(H.REPO, "static", "dashboard.js"), encoding="utf-8").read()
s.check("the panel opens on Summary (the AI read, then a tile per part), with the five tabs in Chris's order",
        '[["summary", "Summary"], ["kpi", "KPI"], ["f360", "360"], ["comp", "Competency"], ["plan", "Career Plan"]]' in _js
        and 'pick(wantTab && panes[wantTab] ? wantTab : "summary"); wantTab = null;' in _js
        and 'pane("summary", [presentSnapshot(d), presentTiles(d, pick)]);' in _js)
s.check("...the 360 tab says it isn't released yet and offers the last released one; the plan tab shows the plan only "
        "(Chris, 2026-10-12: no way into the plan panel or its check-ins from here)",
        "isn't released yet. Group People releases it after calibration" in _js and "d.report_last" in _js and "loadPlan(py)" not in _js)
s.check("...and the tabs are real tabs (role, aria-selected, arrow keys)", 'setAttribute("role", "tab")' in _js
        and "aria-selected" in _js and 'e.key !== "ArrowRight"' in _js)

# ---------------------------------------------------------------------------
s.section("the full record by year (2026-10-14): each year's Year-End result, the Mid-Year a checkpoint inside it")
with a.app.test_request_context("/"):
    _db = a.get_db()
    _yrs = a._record_years(_db, _u, a._record_rows(_db, _u))
s.check("a Mid-Year and its Year-End are one year, its result the Year-End's",
        len(_yrs) == 1 and _yrs[0]["label"] == "2024" and _yrs[0]["state"] == "final"
        and _yrs[0]["ye"]["cycle_id"] == C_PAST and _yrs[0]["check"] is None, [(y["label"], y["state"]) for y in _yrs])
s.check("...opening it lists the Year-End (final) above the Mid-Year (checkpoint)",
        [(c["kind"], c["final"], (c["r"] or {}).get("cycle_id")) for c in _yrs[0]["cycles"]]
        == [("Year-End", True, C_PAST), ("Mid-Year", False, C_OLD)]
        and _yrs[0]["cycles"][0]["tag"] == "Final · decides your reward"
        and _yrs[0]["cycles"][1]["tag"] == "Checkpoint · after your HOD's review", _yrs[0]["cycles"])
s.check("a cycle's year and half come from its columns, else its name (a legacy 'HY1' reads as 1)",
        a._cycle_year_half({"name": "ZZ 2027 Year-End", "year": None, "half": None}) == (2027, 2)
        and a._cycle_year_half({"name": "Anything", "year": 2026, "half": "HY1"}) == (2026, 1)
        and a._cycle_year_half({"name": "Pilot", "year": None, "half": None}) == (None, None))


def _r(year, half, key, pm="ME", band="Mid", talent="Solid Core", name=None):
    return {"year": year, "half": half, "key": key, "period_id": key, "cycle_id": key, "open": False,
            "name": name or "ZZDR %s %s" % (year, "Mid-Year" if half == 1 else "Year-End"), "closed_on": "30 Jun %s" % year,
            "final_pm": pm, "band": band, "talent": ({"name": talent, "slug": "solid-core"} if talent else None)}


with a.app.app_context():
    db = a.get_db()
    c30 = db.execute("INSERT INTO cycles(code, name, is_active, year, half, ends_on) "
                     "VALUES ('ZZDR-2019-H2', 'ZZDR 2019 Year-End', 0, 2019, 2, '2019-12-31')").lastrowid
    c33 = db.execute("INSERT INTO cycles(code, name, is_active, year, half, ends_on) "
                     "VALUES ('ZZDR-2033-H2', 'ZZDR 2033 Year-End', 0, 2033, 2, '2033-12-31')").lastrowid
    db.commit()
    try:
        yy = a._record_years(db, _u, [_r(2032, 1, 9002), _r(2031, 2, 9003, pm="AE", talent="Star"),
                                       _r(2019, 1, 9004), _r(2031, 1, 9005, pm=None, band=None, talent=None),
                                       _r(None, None, 9006, name="ZZDR Pilot")])
        st = {y["label"]: y for y in yy}
        s.check("newest year first; a cycle with no year stands last on its own",
                [y["label"] for y in yy] == ["2032", "2031", "2019", "ZZDR Pilot"], [y["label"] for y in yy])
        s.check("no Year-End for that year yet -> 'still to come', its checkpoint shown, a 'Not started yet' row",
                st["2032"]["state"] == "coming" and st["2032"]["sub"] == "Year-End still to come"
                and st["2032"]["check"]["key"] == 9002 and st["2032"]["cycles"][0]["r"] is None
                and st["2032"]["cycles"][0]["sub"] == "Not started yet", st["2032"])
        s.check("its Year-End closed without them -> 'No Year-End on record', the checkpoint only, no waiting row",
                st["2019"]["state"] == "none" and st["2019"]["sub"] == "No Year-End on record"
                and all(c["r"] is not None for c in st["2019"]["cycles"]), st["2019"])
        s.check("a released Year-End is the year's result even beside an unreleased Mid-Year",
                st["2031"]["state"] == "final" and st["2031"]["ye"]["key"] == 9003, st["2031"]["state"])
        s.check("a Year-End with nothing released -> pending, never its checkpoint",
                a._record_years(db, _u, [_r(2031, 2, 9007, pm=None, band=None, talent=None), _r(2031, 1, 9008)])[0]["state"]
                == "pending")
        s.check("on the demo's cycle switch a Year-End after the chosen cycle is still to come; one inside it isn't",
                a._record_years(db, _u, [_r(2019, 1, 9004)], as_of={"upto": [9004]})[0]["state"] == "coming"
                and a._record_years(db, _u, [_r(2019, 1, 9004)], as_of={"upto": [9004, c30]})[0]["state"] == "none")
        c34 = db.execute("INSERT INTO cycles(code, name, is_active, year, half, ends_on, starts_on) VALUES "
                         "('ZZDR-2034-H2', 'ZZDR 2034 Year-End', 0, 2034, 2, '2034-12-31', '2034-07-01')").lastrowid
        s.check("a Year-End an admin created ahead (not started, after the open cycle) is still to come, not 'none'",
                a._record_years(db, _u, [_r(2034, 1, 9011)])[0]["state"] == "coming")
        db.execute("DELETE FROM cycles WHERE id=?", (c34,))
        # the open cycle is that year's Year-End -> running (in a transaction that is rolled back)
        db.execute("UPDATE cycles SET is_active=0")
        db.execute("UPDATE cycles SET is_active=1 WHERE id=?", (c33,))
        yr = a._record_years(db, _u, [_r(2033, 1, 9009)])[0]
        db.rollback()
        s.check("its Year-End is the open cycle -> 'in progress', with the day it closes",
                yr["state"] == "running" and yr["sub"] == "Year-End in progress · closes 31 Dec 2033"
                and yr["cycles"][0]["sub"] == "In progress", yr)
        trows = [_r(2032, 1, 9002), _r(2031, 2, 9003, pm="AE", talent="Star")]
        tl = a._record_trend_case(db, _u, trows)
        s.check("the trend lists the Year-End results and the newest year's checkpoint, said as one",
                "2031 Year-End, the year's final result: final performance band Above Expectation" in tl
                and "2032 Mid-Year checkpoint, not a final result" in tl, tl)
        s.check("...and its plain line says so",
                a._record_trend_plain(db, _u, trows) == "Your 2031 Year-End result was Above Expectation. Your 2032 "
                "Mid-Year checkpoint is Meet Expectation; the Year-End result is still to come.",
                a._record_trend_plain(db, _u, trows))
        s.check("...but an older year's Mid-Year never counts", "Mid-Year checkpoint," not in a._record_trend_case(
            db, _u, [_r(2032, 2, 9010, pm="OU"), _r(2031, 2, 9003, pm="AE"), _r(2031, 1, 9005)]))
    finally:
        db.rollback()
        db.execute("DELETE FROM cycles WHERE id IN (?,?)", (c30, c33))
        db.commit()

html_y = E.get("/dashboard").get_data(as_text=True)
_tpl = html_y[html_y.find('<template id="od-records-tpl">'):html_y.find('</template>', html_y.find('<template id="od-records-tpl">'))]
s.check("the panel's list is a card per year, its Year-End result on the header",
        _tpl.count('class="od-yg is-final"') == 1 and 'data-year="2024"' in _tpl
        and _tpl.find('data-band="AE"') < _tpl.find('class="od-yc"'), _tpl[:600])
s.check("...opening to the Year-End (final, first) and the Mid-Year (checkpoint), each opening its record",
        _tpl.find('class="od-crow is-final" data-record="%d"' % C_PAST) > 0
        and _tpl.find('class="od-crow is-final" data-record="%d"' % C_PAST) < _tpl.find('class="od-crow" data-record="%d"' % C_OLD)
        and "Final · decides your reward" in _tpl and "Checkpoint · after your HOD&#39;s review" in _tpl, _tpl[:900])
s.check("...folded until opened (aria-expanded, hidden)", 'aria-expanded="false"' in _tpl and ' hidden>' in _tpl)
_js2 = open(os.path.join(H.REPO, "static", "dashboard.js"), encoding="utf-8").read()
s.check("a year row on the history card opens the panel at that year, its card open and focused",
        "function showList(year)" in _js2 and 'showList(arg); }' in _js2
        and ".od-yg[data-year=\"' + String(year) + '\"]" in _js2 and "if (yb && my === seq) yb.focus();" in _js2)
s.check("the panel opens and closes a year in place and keeps it open for the way back from a cycle",
        "function setYear(g, on)" in _js2 and 'b.setAttribute("aria-expanded", on ? "true" : "false")' in _js2
        and "openYears[" in _js2 and 'lastListKey = viaList ? String(key) : null;' in _js2
        and '["Year", "Performance", "Potential", "Talent status", ""]' in _js2)

# ---------------------------------------------------------------------------
with a.app.app_context():
    db = a.get_db()
    db.execute("DELETE FROM record_snapshots WHERE subject_id IN (?,?)", (SUBJ, OTHER))
    db.execute("DELETE FROM result_releases WHERE subject_id IN (?,?)", (SUBJ, OTHER))
    db.execute("DELETE FROM pm_overall_remarks WHERE subject_id IN (?,?)", (SUBJ, OTHER))
    db.execute("DELETE FROM pm_idp_goals WHERE idp_id IN (SELECT id FROM pm_idp WHERE subject_id IN (?,?))", (SUBJ, OTHER))
    db.execute("DELETE FROM pm_idp WHERE subject_id IN (?,?)", (SUBJ, OTHER))
    db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id IN (?,?))",
               (SUBJ, OTHER))
    db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (?,?)", (SUBJ, OTHER))
    db.execute("DELETE FROM users WHERE id IN (?,?)", (SUBJ, OTHER))
    db.execute("DELETE FROM cycles WHERE id IN (?,?,?)", (C_OLD, C_PAST, C_THEIRS))
    if not _had_bg:
        db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (BG,))
    if _ai_prev is not None:
        db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('ai_review', ?)", (_ai_prev["value"],))
    db.commit()

# a record row's three bands line up (Chris, 2026-10-26: "why the performance band is not aligned with the other 2
# bands?"), and a year with no Year-End says which band its checkpoint is ("it doesn't if it is referring to
# performance or pontential")
s.section("a record row's bands line up; a checkpoint's bands sit in their own columns")
_css_r = open(os.path.join(H.REPO, "static", "style.css"), encoding="utf-8").read()
_bare_pf = [m.group(0).strip() for m in re.finditer(r"(?:^|[,}])\s*\.pf\s*(?=[{,:\[\s>+~])[^{]*\{", _css_r, re.M)
            if not re.search(r"\.pf[\w-]", m.group(0))]
s.check("no style rule on a bare .pf: it is the performance cell of every record row (the Profile page's wrapper "
        "is .pf-page)", not _bare_pf, _bare_pf[:3])
_set = open(os.path.join(H.REPO, "templates", "settings.html"), encoding="utf-8").read()
s.check("...the Profile page wraps in .pf-page", '<div class="pf-page">' in _set and 'class="pf"' not in _set)
_dt = open(os.path.join(H.REPO, "templates", "dashboard.html"), encoding="utf-8").read()
_yc = _dt[_dt.index("{% macro year_check(g)"):_dt.index("{%- endmacro %}", _dt.index("{% macro year_check(g)"))]
s.check("a year with no Year-End draws its checkpoint with record_vals: performance, potential, talent status in "
        "their columns", "record_vals(g['check'])" in _yc and "od-yck" not in _dt)
s.check("...and its year cell says it's the checkpoint, in both the history card and the full record",
        _dt.count("{% if not g['ye'] %}{{ year_check_tag(g) }}{% endif %}") == 2)

sys.exit(s.done())
