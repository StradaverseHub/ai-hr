"""The guided review -- Phase C step 2: the shell, the switch, the Account stage.

THE CONVERSATION IS A PROJECTION OVER MODULE ROWS. There is no cursor, no
transcript, and no second definition of "done" -- so most of this suite asserts
things that must NOT exist, and the two that matter most are:

  * every /review GET issues ZERO writes  (it is a read surface)
  * review_state() contains no literal status string  (one definition of done)

If either ever fails, the surface has started keeping its own opinion about the
data it is supposed to be projecting, which is the one way it can begin
disagreeing with the pages it replaces.

This suite WRITES (it keys KPI values), so it takes a fresh database copy.
"""
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Guided review -- the shell and the Account stage")
SU, _BG, _EMP = H.actors(a)
SRC = H.source(a)
CODE = H.code_without_docstrings(SRC)

# (the sign-off preview with each stage too: the zero-writes trace below proves the pop-up's readiness check is
# write-free on every part it serves -- 2026-09-29)
REVIEW_GETS = ("/review", "/review/account", "/review/account/turn", "/review/signoff/preview",
               "/review/signoff/preview?stage=account", "/review/signoff/preview?stage=competency",
               "/review/signoff/preview?stage=career_plan", "/review/signoff/preview?stage=feedback",
               "/review/checkin", "/review/checkin/turn",
               "/review/summary", "/review/done",
               "/review/setting", "/review/setting/chat/history",
               "/review/competency", "/review/competency/chat/history")

# ---------------------------------------------------------------------------
s.section("the module switch -- the phase must turn off without a deploy")
s.check("'review' is one of the six module keys (Succession and Reward archived 2026-10-08, Promotion 2026-10-13)",
        "review" in a.CYCLE_MODULE_KEYS and len(a.CYCLE_MODULE_KEYS) == 6, a.CYCLE_MODULE_KEYS)
s.check("it has a human label", bool(a.CYCLE_MODULE_LABELS.get("review")))
# Seeded active=0 explicitly: cycle_module_on() reads a MISSING row as ON, so
# "ships off" is a row, not an absence.
rows = H.rows(a, "SELECT cycle_id, active FROM cycle_modules WHERE module_key='review'")
n_cycles = H.one(a, "SELECT COUNT(*) FROM cycles")
s.check("a row exists for every cycle", len(rows) == n_cycles, (len(rows), n_cycles))
# Ships off by default (the seed writes active=0 where no row exists), but a live
# deployment may switch it on -- staging and this dev DB have. The invariant is
# the EXPLICIT ROW (off is a row, never an absence); each value is a real 0/1.
s.check("...each is an explicit 0/1, not an absence",
        all(r["active"] in (0, 1) for r in rows), [dict(r) for r in rows])

s.section("switching it on must survive the next boot")
# The seed must never re-disable a module an admin switched on.
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key='review'")
    db.commit()
    a._ensure_runtime_schema()
    still_on = H.one(a, "SELECT MIN(active) FROM cycle_modules WHERE module_key='review'")
s.check("re-running the migration leaves it ON", still_on == 1, still_on)

# ---------------------------------------------------------------------------
s.section("every /review route is CLASSIFIED, none is ungated")
# The whole module gate rests on the URL-map assertion in test_module_gate.py.
# A parameterised /review/<stage> rule would resolve to that literal string,
# which no classifier can map -- forcing these names into the ungated set and
# hollowing the assertion out. Longhand routes are what keep it honest.
# Grade H Appraisal's line manager pages (/review/gradeh, 2026-10-28) are the 'gradeh' module's, classified by prefix and held by
# test_gradeh_lm: this suite counts the review module's own
review_eps = sorted(r.endpoint for r in a.app.url_map.iter_rules()
                    if str(r.rule).startswith("/review") and not str(r.rule).startswith("/review/gradeh"))
s.note("endpoints: %s" % ", ".join(review_eps))
# 46 as of the Career Plan editable widget (2026-09-08): +2 for the career-profile
# and dev-plan-goals bulk-save endpoints (review_career_save_all, review_ahead_save_all).
# (The KPI-Remark pop-out briefly added a review_kpi_remark route on 2026-09-10; it was
# retired 2026-09-11 when the Remark control was re-pointed to the chat -- drafting now
# flows through the check-in agent's tools, no new route.) 46 as of 2026-09-14: was 47;
# -1 for removing review_demo_reports (the demo Solo/Manager toggle) -- the one "Viewing
# as" persona switcher now drives the Team view. 50 as of 2026-09-20: +1 for
# review_kpi_note -- the deterministic Save from the KPI draft-note card. 50 as of
# 2026-09-22: -1, review_kpi_note RETIRED (the KPI check-in dropped the per-KPI note step
# -- it now forces a supporting FILE on each AE/OU KPI and collects one overall remark).
# The count changing is deliberate; what matters is that every one is classified by NAME
# below, so the module-gate URL map stays honest.
# 50 as of 2026-09-24: +1, review_team_idp_summary (the manager's AI summary of one report's shared
# development plan, fetched per report so a slow model never stalls a turn).
# 51 as of 2026-09-24 (later that day): +1, review_team_pm_summary (the manager's AI summary of one
# report's performance -- their score + their own remark -- fetched per report, never inside a turn).
# 52 as of 2026-09-25: +1, review_team_tm_summary (the line manager's AI summary of one report's competency
# self-assessment, fetched per report, never inside a turn).
# 53 as of 2026-09-26: +1, review_kpi_remark (the Remarks box under the employee's KPI table, saved as they type).
# 55 as of 2026-09-28: +2, review_feedback_remark + review_competency_remark (the remark boxes on the 360 and
# competency cards' last page).
# 56 as of 2026-09-28 (later): +1, review_team_calib_summary (the calibrator's AI insight on one person, fetched
# per person by the calibration card, never inside a turn).
# 57: +1, review_team_pot_summary (the calibrator's AI insight on one person's POTENTIAL, 2026-09-28).
# 58: +1, review_demo_reset_team (the demo Reset under the Team view rewinds only the reviewer's side, 2026-09-28).
# 59: +1, review_team_idp_remark (the line manager's ONE overall remark on a plan, saved as they type, 2026-09-29).
# 60: +1, review_signoff_preview (the write-free readiness + summary the one-card sign-off pop-up shows, 2026-09-29).
# 63: +1, review_demo_reset_calibration (the demo Reset in a leader view -- Dept / BU / BG -- rewinds only that
# view's calibration, 2026-09-30).
# 64: +1, review_team_dept_accept (the Department summary's Save: keep the ticked LM bands, 2026-09-30).
# 65: +1, review_team_tbox_person (one person's page on the BG CEO's Talent Box, 2026-10-05).
# 66: +1, review_team_tbox_insight (the BG CEO's short AI insight on one person in the box, 2026-10-07).
# 67: +1, review_team_tbox_remark (the BG CEO's own optional remark on one person, saved as typed, 2026-10-07).
# 69: +1, review_nav (the navigator alone, for what the client has on screen: the queue in every view, 2026-10-16).
# 70: +1, review_setting_unit (the setting card's unit offer, clicked: the line and its figures to the suggested unit,
# 2026-10-18).
# 71: +1, review_team_tm_360 (the line manager's view of one report's 360 in the competency review, 2026-10-21).
# 72: +1, review_intro_seen (the welcome's lines, each stored as the page shows it, 2026-10-22).
# 74: +1, review_team_behalf_pm (a line manager's assessment of someone who didn't submit, on their behalf, 2026-10-26).
# 76: +2, chair_person_summary and chair_stars_download (the Executive Chairman's short summary and Stars download, dark unless
# ONEHR_CHAIR=1, 2026-10-29).
# 79: +3, chair_leaders_move / _lock / _record (his leaders' Talent Box, P4, dark unless ONEHR_CHAIR=1, 2026-10-29); his person
# page reuses review_team_tbox_person.
# 80: +1, chair_insight_make (the Executive Chairman's AI insight card, its own POST, P3, 2026-10-29).
s.check("eighty /review routes (+ the sign-off pop-up's preview; + the curve's in-place move and AI fit, "
        "2026-09-29; + the leader view's calibration reset and the Department summary's bulk keep, 2026-09-30; + the "
        "Talent Box person page, 2026-10-05; + its short AI insight and the BG CEO's remark, 2026-10-07; + one read "
        "for a page's insights, 2026-10-09; + the navigator alone, 2026-10-16; + the setting card's unit offer, "
        "2026-10-18; + the line manager's view of a report's 360, 2026-10-21; + the welcome's lines, 2026-10-22; + the "
        "KPI table's live total, 2026-10-22; + the assessment on someone's behalf, 2026-10-26; + the Executive Chairman's "
        "summary and Stars download, 2026-10-29; + his leaders' Talent Box: move, lock and record, 2026-10-29; + his AI "
        "insight's own POST, 2026-10-29)",
        len(review_eps) == 80 and a.MODULE_ENDPOINTS.get("review_nav") == "review"
        and a.MODULE_ENDPOINTS.get("review_team_behalf_pm") == "review"
        and a.MODULE_ENDPOINTS.get("review_kpi_preview") == "review"
        and a.MODULE_ENDPOINTS.get("review_setting_unit") == "review"
        and a.MODULE_ENDPOINTS.get("review_intro_seen") == "review", review_eps)
s.check("...the BG CEO's Talent Box remark is classified 'review'",
        a.MODULE_ENDPOINTS.get("review_team_tbox_remark") == "review")
s.check("...the Talent Box insight is classified 'review'",
        a.MODULE_ENDPOINTS.get("review_team_tbox_insight") == "review")
s.check("...the Talent Box person page is classified 'review'",
        a.MODULE_ENDPOINTS.get("review_team_tbox_person") == "review")
s.check("...the Department summary's bulk keep is classified 'review'",
        a.MODULE_ENDPOINTS.get("review_team_dept_accept") == "review")
s.check("...the calibration reset is classified 'review'",
        a.MODULE_ENDPOINTS.get("review_demo_reset_calibration") == "review")
s.check("...the sign-off preview route is classified 'review' (a GET: the writes stay thirty-six)",
        a.MODULE_ENDPOINTS.get("review_signoff_preview") == "review")
s.check("...the IDP remark route is classified 'review'", a.MODULE_ENDPOINTS.get("review_team_idp_remark") == "review")
s.check("...both calibrator insight routes are classified 'review'",
        a.MODULE_ENDPOINTS.get("review_team_calib_summary") == "review"
        and a.MODULE_ENDPOINTS.get("review_team_pot_summary") == "review")
s.check("...the 360 and competency remark-box routes are classified 'review'",
        a.MODULE_ENDPOINTS.get("review_feedback_remark") == "review"
        and a.MODULE_ENDPOINTS.get("review_competency_remark") == "review")
s.check("...the KPI Remarks-box route is classified 'review'",
        a.MODULE_ENDPOINTS.get("review_kpi_remark") == "review")
s.check("...the TM-summary route is classified 'review'",
        a.MODULE_ENDPOINTS.get("review_team_tm_summary") == "review")
s.check("...the IDP-summary route is classified 'review'",
        a.MODULE_ENDPOINTS.get("review_team_idp_summary") == "review")
s.check("...and so is the PM-summary route",
        a.MODULE_ENDPOINTS.get("review_team_pm_summary") == "review")
s.check("...and review_feedback_comment is no longer in the URL map",
        "review_feedback_comment" not in review_eps and "review_feedback_comment" not in a.MODULE_ENDPOINTS)
# The STAGE path segment is always a literal -- no /review/<stage> catch-all,
# which is what would resolve to a string the classifier cannot map. The only
# parameterised rules are the subject-SCOPED team routes and the evidence-attach
# route (by evidence id), all classified by endpoint name (asserted below), so
# the classifier still maps them and nothing lands in MODULE_UNGATED_ENDPOINTS.
_param = sorted(str(r.rule) for r in a.app.url_map.iter_rules()
                if str(r.rule).startswith("/review") and not str(r.rule).startswith("/review/gradeh") and "<" in str(r.rule))
s.check("no parameterised STAGE rule; only id-scoped team + attach/remove routes",
        _param == ["/review/evidence/<int:eid>/attach",
                   "/review/evidence/attachment/<int:aid>/delete",
                   "/review/kpi/<int:kpi_id>/attach",
                   "/review/team/<int:subject_id>",
                   "/review/team/<int:subject_id>/note"], _param)
s.check("every one is in MODULE_ENDPOINTS",
        all(e in a.MODULE_ENDPOINTS for e in review_eps),
        [e for e in review_eps if e not in a.MODULE_ENDPOINTS])
s.check("NONE was added to MODULE_UNGATED_ENDPOINTS",
        not [e for e in review_eps if e in a.MODULE_UNGATED_ENDPOINTS],
        [e for e in review_eps if e in a.MODULE_UNGATED_ENDPOINTS])
# A stage belongs to the module whose WORK it is, not to the phase.
s.check("the shell and the terminal page belong to 'review'",
        a.MODULE_ENDPOINTS.get("review_home") == "review"
        and a.MODULE_ENDPOINTS.get("review_done") == "review")
s.check("the Account stage belongs to 'pm' -- the module whose work it is",
        a.MODULE_ENDPOINTS.get("review_account") == "pm"
        and a.MODULE_ENDPOINTS.get("review_account_turn") == "pm"
        and a.MODULE_ENDPOINTS.get("review_summary") == "pm")
# The KPI-setting chat: the stage PAGE is 'pm' work (404s with Performance off, the
# UI entry gate, like review_account); the chat/history/propose plumbing is phase
# infrastructure ('review', like review_chat/review_confirm).
s.check("the setting stage PAGE belongs to 'pm'",
        a.MODULE_ENDPOINTS.get("review_setting") == "pm")
s.check("the setting chat plumbing belongs to 'review'",
        a.MODULE_ENDPOINTS.get("review_setting_chat") == "review"
        and a.MODULE_ENDPOINTS.get("review_setting_chat_history") == "review"
        and a.MODULE_ENDPOINTS.get("review_setting_propose") == "review")
# The competency chat: the stage PAGE is 'tm' work (404s when Talent Management is
# off, the UI entry gate); the chat/history/submit plumbing is 'review' phase infra.
s.check("the competency stage PAGE belongs to 'tm'",
        a.MODULE_ENDPOINTS.get("review_competency") == "tm")
s.check("the competency chat plumbing belongs to 'review'",
        a.MODULE_ENDPOINTS.get("review_competency_chat") == "review"
        and a.MODULE_ENDPOINTS.get("review_competency_chat_history") == "review"
        and a.MODULE_ENDPOINTS.get("review_competency_submit") == "review")
# The development-plan chat: the stage PAGE is 'idp' work (404s when Development
# plans is off); the chat/history/submit plumbing is 'review' phase infra. Named
# in MODULE_ENDPOINTS and NOT left to the /idp URL prefix, which never sees /review.
s.check("the ahead stage PAGE belongs to 'idp'",
        a.MODULE_ENDPOINTS.get("review_ahead") == "idp")
s.check("the ahead chat plumbing belongs to 'review'",
        a.MODULE_ENDPOINTS.get("review_ahead_chat") == "review"
        and a.MODULE_ENDPOINTS.get("review_ahead_chat_history") == "review"
        and a.MODULE_ENDPOINTS.get("review_ahead_submit") == "review")
s.check("the career stage PAGE belongs to 'idp'",
        a.MODULE_ENDPOINTS.get("review_career") == "idp")
s.check("the career chat plumbing belongs to 'review'",
        a.MODULE_ENDPOINTS.get("review_career_chat") == "review"
        and a.MODULE_ENDPOINTS.get("review_career_chat_history") == "review")
# The career profile has NO status and NO approval gate, so it must not grow a
# submit endpoint by copy-paste from the three stages that do have one.
s.check("the career stage has NO submit endpoint at all",
        not [e for e in review_eps if e.startswith("review_career") and "submit" in e],
        [e for e in review_eps if e.startswith("review_career")])

# ---------------------------------------------------------------------------
s.section("ONE definition of done -- the rule the design rests on")
_i = SRC.find("def review_state(db, u):")
_body = H.code_without_docstrings(SRC[_i:SRC.find("\ndef review_resume", _i)])
# review_state() must CALL the module's predicates, never re-decide with a
# literal. If a stage ever seems to need one, the module should expose a
# predicate instead -- that is the signal, and this is what surfaces it.
LITERALS = ("'approved'", '"approved"', "'draft'", '"draft"', "'proposed'", '"proposed"',
            "'submitted'", '"submitted"', "'shared'", '"shared"', "'closed'", '"closed"',
            "'reviewed'", '"reviewed"', "'returned'", '"returned"')
found = [x for x in LITERALS if x in _body]
s.check("review_state() contains NO status literal", not found, found)
for pred in ("pm_can_self_edit", "pm_result_entry_open", "cycle_module_on"):
    s.check("...it calls %-22s instead" % pred, pred in _body)

# ---------------------------------------------------------------------------
s.section("build a subject with real KPI lines")
# BUILT, NOT FOUND. The first version hunted for a subject who already had
# approved KPI lines -- which the developer's own database has and the CI fixture
# does not, because seed_staging.py builds 360 panels and no PM targets. The
# suite failed in CI for lack of data rather than for a defect.
#
# Building them also makes every count below EXACT rather than whatever the
# database happened to hold, which is the difference between asserting a
# relationship and asserting an accident.
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    SUBJ = db.execute("SELECT u.* FROM users u WHERE u.role!='admin' "
                      "AND u.left_at IS NULL LIMIT 1").fetchone()
    db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN "
               "(SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?)",
               (CID, SUBJ["id"]))
    db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?",
               (CID, SUBJ["id"]))
    # Two lines, 50/50, both approved and both scorable under either mechanism.
    for name, weight in (("ZZ Review Line A", 50.0), ("ZZ Review Line B", 50.0)):
        db.execute(
            "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, unit, "
            "method, target, threshold, excellence, rate1, rate2, rate3, rate4, rate5, "
            "status, business_group, company, department) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved',?,?,?)",
            (CID, SUBJ["id"], name, weight, "%", "more", 90.0, 70.0, 100.0,
             70.0, 80.0, 90.0, 95.0, 100.0, SUBJ["business_group"] or "",
             SUBJ["company"] or "", SUBJ["department"] or ""))
    db.commit()
s.check("the subject has exactly two approved KPI lines",
        H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=? "
                 "AND status='approved'", (CID, SUBJ["id"])) == 2)
E = H.client_as(a, SUBJ["id"])


def state():
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = SUBJ["id"]
        return a.review_state(a.get_db(), SUBJ)


ST0 = state()
ACC0 = next(x for x in ST0["stages"] if x["key"] == "account")
s.note("account: state=%s %d of %d open" % (ACC0["state"], ACC0["n_open"], ACC0["n_total"]))
s.check("the stage sees exactly the two lines built", ACC0["n_total"] == 2, ACC0["n_total"])
s.check("...and both need a figure", ACC0["n_open"] == 2, ACC0["n_open"])

# ---------------------------------------------------------------------------
s.section("the rail sub-groups by module, with the prefix stripped")
# review_state exposes a prefix-stripped `short` label so the rail can group the
# stages under a module heading (PM / TM / IDP) rather than restating the module
# name in every row -- derived independently here, never from the app's split.
for x in ST0["stages"]:
    want = x["label"].split(" – ", 1)[-1]
    s.check("stage %-13s short == label minus prefix" % x["key"], x.get("short") == want,
            (x.get("short"), x["label"]))
s.check("account's short drops the 'PM – ' prefix", ACC0["short"] == "KPI Check-in", ACC0["short"])
with a.app.test_request_context("/review"):
    from flask import session as _sess
    _sess["user_id"] = SUBJ["id"]
    RAIL = a.app.jinja_env.get_template("_review_rail.html").render(st=ST0, stage=ACC0)
live_self_mods = sorted({x["module"] for x in ST0["stages"]
                         if x["group"] == "self" and x["state"] != "off"})
s.check("PM is a live self group (the review surface)", "pm" in live_self_mods, live_self_mods)
for m in live_self_mods:
    s.check("the rail renders a %s sub-category head" % m.upper(),
            "rv-rail-grouphead" in RAIL and (">" + m.upper() + "<") in RAIL, m)
s.check("the rail shows the SHORT label, not the 'PM – ' prefix",
        "KPI Check-in" in RAIL and "PM – KPI Check-in" not in RAIL, None)
s.check("each group head carries an inline-svg module icon",
        RAIL.count("<svg") >= len(live_self_mods), RAIL.count("<svg"))

# The rail leads with the Mine / Team switch (short labels so it fits one row), not
# a "Yours" header. RAIL was rendered without `manages` -> the single-tab branch.
s.check("the rail no longer prints a 'Yours' header", "Yours" not in RAIL, None)
s.check("...a non-manager rail shows a single 'Mine' tab (no Team)",
        ">Mine<" in RAIL and ">Team<" not in RAIL, None)
with a.app.test_request_context("/review"):
    VT_MGR = a.app.jinja_env.get_template("_review_viewtabs.html").render(manages=True, active="mine")
    VT_EMP = a.app.jinja_env.get_template("_review_viewtabs.html").render(manages=False, active="mine")
s.check("a manager's switch offers both Mine and Team side by side",
        ">Mine<" in VT_MGR and ">Team<" in VT_MGR, None)
s.check("...Team links to the team surface, full labels kept as tooltips",
        "/review/team" in VT_MGR and 'title="My Review"' in VT_MGR and 'title="Team Review"' in VT_MGR, None)
s.check("a non-manager's switch is a single 'Mine' tab (same pill, so no layout jump)",
        ">Mine<" in VT_EMP and ">Team<" not in VT_EMP, None)

s.section("the pages render")
for url in REVIEW_GETS:
    if "/checkin" in url:   # period-gated -- the PM turn only in a quarterly period
        continue
    r = E.get(url)
    s.check("GET %-24s" % url, r.status_code in (200, 302), r.status_code)
# The PM self-KPI stage is period-aware: `account` (enter the result) in a
# results period, `checkin` (trajectory) in a quarterly one. Prove checkin is
# reachable when the active period is quarterly.
with a.app.app_context():
    a.get_db().execute("UPDATE cycles SET kind='quarterly' WHERE is_active=1")
    a.get_db().commit()
for url in ("/review/checkin", "/review/checkin/turn"):
    s.check("GET %-26s (quarterly)" % url, E.get(url).status_code in (200, 302),
            E.get(url).status_code)
with a.app.app_context():
    a.get_db().execute("UPDATE cycles SET kind='mid_year' WHERE is_active=1")
    a.get_db().commit()

# ---------------------------------------------------------------------------
s.section("EVERY /review GET writes NOTHING")
# The conversation is a read surface over other people's writes. Wrap the
# connection and count anything that mutates.
WRITE = re.compile(r"^\s*(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b", re.I)
# the one write a signed-in GET makes: the person's last-seen stamp (Online now, 2026-11-02; _stamp_last_seen, at most one a
# five minutes, never review state). Allowed by its exact statement, so any other write still fails this check.
STAMP = re.compile(r"^\s*UPDATE users SET last_seen_at=datetime\('now'\) WHERE id=\d+\s*$", re.I)
seen = []
# set_trace_callback, not a wrapped .execute: sqlite3.Connection.execute is a
# read-only attribute, and the trace hook sees EVERY statement the connection
# runs -- including any issued from inside a helper this test never names.
_real_connect = a.sqlite3.connect


def _tracing_connect(*args, **kw):
    con = _real_connect(*args, **kw)
    con.set_trace_callback(
        lambda sql: seen.append(" ".join((sql or "").split())[:70])
        if WRITE.match(sql or "") and not STAMP.match(sql or "") else None)
    return con


a.sqlite3.connect = _tracing_connect
try:
    for url in REVIEW_GETS:
        # A fresh client per URL, so each request opens its own connection and
        # the trace hook is installed on it.
        H.client_as(a, SUBJ["id"]).get(url)
finally:
    a.sqlite3.connect = _real_connect
s.note("write statements seen across %d GETs: %d" % (len(REVIEW_GETS), len(seen)))
s.check("zero writes from any /review GET", not seen, seen[:3])

# ---------------------------------------------------------------------------
s.section("the conversation advances, and RESUMES from the data")
t1 = a.review_next_target(ST0)
s.check("it asks about a line that needs a figure", t1 is not None and t1["needs_figure"])
body = E.get("/review/account").get_data(as_text=True)
s.check("the account page IS the chat surface", 'id="rv-chat"' in body, None)
# The KPI names come through the CONVERSATION now, not static HTML; the scorecard
# page (the 'See every KPI' destination) still lists them.
summ = E.get("/review/summary").get_data(as_text=True)
s.check("the KPI it needs is named on the scorecard page", t1["kpi_name"] in summ, t1["kpi_name"])

# Key it through the MODULE's own route -- the conversation adds no writer.
E.post("/performance/kpi/%d/autosave" % t1["id"],
       data={"csrf_token": "tok", "actual_value": "88"})
ST1 = state()
t2 = a.review_next_target(ST1)
s.check("the turn MOVED ON after the module wrote", t2 is None or t2["id"] != t1["id"],
        (t1["id"], t2["id"] if t2 else None))
s.check("...and the open count dropped from 2 to exactly 1",
        next(x for x in ST1["stages"] if x["key"] == "account")["n_open"] == 1,
        next(x for x in ST1["stages"] if x["key"] == "account")["n_open"])
# THE RESUMPTION CLAIM: WHERE-you-are is re-derived every turn (review_state /
# review_resume), never stored. NB pm_review_session (the sign-off LOCK) is a durable
# verdict, not a resumption cursor -- so guard against a stored cursor/position
# specifically, not the word "session".
s.check("resumption is re-derivation -- no cursor/position is stored",
        "review_cursor" not in CODE and "REVIEW_POSITION" not in CODE
        and "review_stage_at" not in CODE and "current_stage" not in CODE)

s.section("the acknowledgement's number comes from the SERVER")
ack = a.review_acknowledge(ST1, t1["id"])
s.note("said: %s" % ack)
s.check("there is an acknowledgement for the line just keyed", bool(ack))
sc = next(t for t in ST1["targets"] if t["id"] == t1["id"])["score"]
if sc and sc.get("value") is not None:
    shape = ("%.0f%%" % sc["value"]) if sc["mechanism"] == "B" else ("%.1f of 5" % sc["value"])
    s.check("it quotes pm_score_targets()'s own figure, not a recomputation",
            shape in ack, (shape, ack))
    s.check("...and the band it resolved to", (sc.get("label") or "") in ack, sc.get("label"))
s.check("a crafted target id is ignored", a.review_acknowledge(ST1, 99999999) is None)
turn = E.get("/review/account/turn?just=%d" % t1["id"]).get_data(as_text=True)
s.check("the turn renders it", "Saved" in turn)
# No scoring in the browser, ever.
js = H.source(a, os.path.join("static", "review.js"))
for bad in ("/ 100", "* 100", "toFixed", "Math."):
    s.check("review.js does no arithmetic on a score (%s)" % bad, bad not in js)

s.section("the partial total is never printed as a total")
# ?fragment=1, not the whole page: matching "partial" anywhere in a full render
# would pass on the word appearing in the nav, which proves nothing.
sm = E.get("/review/summary?fragment=1").get_data(as_text=True)
txt = " ".join(re.sub(r"<[^>]+>", " ", sm).split())
s.check("the fragment is JUST the table, not the whole page",
        "<html" not in sm.lower() and "rv-summary" in sm)
with a.app.app_context():
    ov, cov, tot = a.review_partial_overall(a.get_db(), state()["targets"])
s.note("overall=%s covering %s of %s" % (ov["value"] if ov else None, cov, tot))
if ov and cov < tot:
    s.check("a partial figure is LABELLED partial", "partial" in txt.lower(), txt[:120])
    s.check("...and says what it covers", "covering" in txt.lower())
elif ov:
    s.check("a complete figure says it covers everything", "covering all" in txt.lower())
else:
    s.check("with nothing scored it says so rather than showing 0",
            "nothing scored" in txt.lower(), txt[:120])
with a.app.app_context():
    s.check("the helper returns coverage, so a template cannot print the bare score",
            len(a.review_partial_overall(a.get_db(), [])) == 3)

# ---------------------------------------------------------------------------
s.section("switching a module off")
def with_module(key, active, fn):
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?) "
                   "ON CONFLICT(cycle_id, module_key) DO UPDATE SET active=excluded.active",
                   (CID, key, active))
        db.commit()
    try:
        return fn()
    finally:
        with a.app.app_context():
            db = a.get_db()
            db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key=?",
                       (CID, key))
            db.commit()

# pm off -> the STAGE dies, because the stage belongs to pm.
codes = with_module("pm", 0, lambda: {u: E.get(u).status_code for u in REVIEW_GETS})
s.note("pm off -> %s" % codes)
s.check("/review/account 404s with Performance off", codes["/review/account"] == 404,
        codes["/review/account"])
s.check("...so does its turn, its summary, and check-in -- all pm's",
        all(codes[u] == 404 for u in ("/review/account/turn", "/review/summary",
                                      "/review/checkin", "/review/checkin/turn")),
        codes)
s.check("the shell still answers -- it is not pm's", codes["/review"] in (200, 302),
        codes["/review"])
# review off -> the WHOLE surface dies, and the module pages are untouched.
codes = with_module("review", 0, lambda: {u: E.get(u).status_code for u in REVIEW_GETS})
pm_alive = with_module("review", 0, lambda: E.get("/performance").status_code)
s.note("review off -> %s ; /performance -> %s" % (codes, pm_alive))
# EVERY route, not just the shell. The first version of this suite asserted only
# the shell and the terminal page, and passed while /review/account still served
# 200 -- because the gate classifies that route as 'pm', which was on. A bookmark
# kept the whole surface usable with the phase switched off, which is the defect
# f72c126 exists to prevent. Assert all five, or the switch is decorative.
s.check("EVERY /review route 404s with the phase off",
        all(v == 404 for v in codes.values()), codes)
s.check("THE MODULE PAGE IS UNTOUCHED -- nothing existing was removed",
        pm_alive == 200, pm_alive)

s.section("the deploy route probe -- do not repeat 63eb628")
# The module gate is a before_request and runs BEFORE @login_required; the
# staging deploy fetches every parameterless GET UNAUTHENTICATED and counts
# anything but 200-or-redirect as broken. That collision rolled back the Phase A
# deploy. A new gated module must not bring it back.
anon = a.app.test_client()
bad = [(u, anon.get(u).status_code) for u in REVIEW_GETS
       if anon.get(u).status_code >= 400]
s.check("no /review route answers 4xx/5xx to an anonymous visitor", not bad, bad)
s.check("they redirect to sign-in instead",
        all(anon.get(u).status_code in (301, 302) for u in REVIEW_GETS),
        {u: anon.get(u).status_code for u in REVIEW_GETS})

s.section("an admin has no conversation of their own")
A = H.client_as(a, SU["id"])
s.check("super admin gets 404 from every /review route",
        all(A.get(u).status_code == 404 for u in REVIEW_GETS),
        {u: A.get(u).status_code for u in REVIEW_GETS})

s.section("the phrasebook is keyed and pure")
s.check("phrases are keyed, never rendered sentences", isinstance(a.REVIEW_PHRASES, dict))
s.check("review_phrase takes no db/request/session",
        "def review_phrase(key, **args):" in SRC)
s.check("every phrase key used in code exists",
        all(k in a.REVIEW_PHRASES
            for k in re.findall(r'review_phrase\("([a-z_.]+)"', CODE)))
s.check("selection is deterministic -- no randomness anywhere in the engine",
        "random" not in H.code_without_docstrings(
            SRC[SRC.find("REVIEW_STAGES = ("):SRC.find("def review_partial_overall")]))

# ---------------------------------------------------------------------------
s.section("STEP 3 -- the rail is the whole journey")
RAIL = [x["key"] for x in state()["stages"]]
s.note("rail: %s" % " -> ".join(RAIL))
self_keys = [x["key"] for x in state()["stages"] if x["group"] == "self"]
# Module-grouped and period-aware. In a results period the PM self-KPI slot is
# `account`; `checkin` is absent (it is the quarterly turn). SUBJ is not a
# manager here, so the rail is the self journey.
s.check("the self rail is the module-named journey (no KPI setting: it runs in the Early Year only, 2026-10-15)",
        self_keys == ["account", "feedback", "competency", "ahead", "career"],
        self_keys)
s.check("checkin is not a stage in a results period", "checkin" not in RAIL, RAIL)
s.check("outside an Early Year there is no KPI-setting stage at all (Chris, 2026-10-15)", "agree" not in RAIL, RAIL)
s.check("every stage names a real endpoint",
        all(x["endpoint"] in {r.endpoint for r in a.app.url_map.iter_rules()}
            for x in state()["stages"]),
        [x["endpoint"] for x in state()["stages"]])

s.section("THE WAITING SPLIT -- work the employee cannot clear is not theirs")
# KPI setting runs in an Early Year only (2026-10-15): this section's cycle is one while it runs
with a.app.app_context():
    _ey0 = dict(a.get_db().execute("SELECT half, kind FROM cycles WHERE id=?", (CID,)).fetchone())
    a.get_db().execute("UPDATE cycles SET half=0, kind='early_year' WHERE id=?", (CID,))
    a.get_db().commit()


def _ey_back():
    with a.app.app_context():
        a.get_db().execute("UPDATE cycles SET half=?, kind=? WHERE id=?", (_ey0["half"], _ey0["kind"], CID))
        a.get_db().commit()


import atexit  # noqa: E402
atexit.register(_ey_back)
# dash_tasks() counts a 'proposed' target as the employee's work while the
# approver-side count claims THE SAME ROWS. A stage driven by that would ask
# them forever to finish something they cannot.
with a.app.app_context():
    db = a.get_db()
    PROP = db.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, unit, "
        "method, target, status, business_group, company, department) "
        "VALUES (?,?,?,?,?,?,?,'proposed',?,?,?)",
        (CID, SUBJ["id"], "ZZ Proposed Line", 10.0, "%", "more", 5.0,
         SUBJ["business_group"] or "", SUBJ["company"] or "",
         SUBJ["department"] or "")).lastrowid
    db.commit()
AG = next(x for x in state()["stages"] if x["key"] == "agree")
s.note("agree -> %s, blocked_on=%r" % (AG["state"], AG["blocked_on"]))
s.check("a PROPOSED target puts Agree in WAITING, not open",
        AG["state"] == "waiting", AG["state"])
s.check("...and it is NOT counted as work still theirs",
        AG["state"] != "open")
# THE CHECK I WROTE FIRST WAS A TAUTOLOGY: `X and Y or X` is true whenever X is,
# so it passed while blocked_on was None and the rail fell back to a generic
# "your manager". Name the approver properly, then assert the name.
with a.app.app_context():
    db = a.get_db()
    APPR = db.execute("SELECT id, full_name FROM users WHERE id!=? AND role!='admin' "
                      "LIMIT 1", (SUBJ["id"],)).fetchone()
    db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) "
               "VALUES (?,1,?)", (PROP, APPR["id"]))
    db.commit()
AG2 = next(x for x in state()["stages"] if x["key"] == "agree")
s.note("with a chain -> blocked_on=%r" % AG2["blocked_on"])
s.check("the waiting stage NAMES the approver it is with",
        AG2["blocked_on"] == APPR["full_name"], (AG2["blocked_on"], APPR["full_name"]))
# the per-stage rail on the setting page (the AI+ journey off, so a WAITING scorecard still opens it)
with a.app.app_context():
    _u0 = a.get_db().execute("SELECT value FROM app_settings WHERE key='review_unified'").fetchone()
    a.get_db().execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES ('review_unified', '0')")
    a.get_db().commit()
_rs = E.get("/review/setting")
body = _rs.get_data(as_text=True)
with a.app.app_context():
    if _u0 is None:
        a.get_db().execute("DELETE FROM app_settings WHERE key='review_unified'")
    else:
        a.get_db().execute("UPDATE app_settings SET value=? WHERE key='review_unified'", (_u0[0],))
    a.get_db().commit()
# The visible subline was dropped; status is the dot + a title= hover tooltip. The
# waiting step must NAME its approver in that tooltip and must not read as the
# employee's own outstanding work. Inspect the <li ...> just before its label.
seg = body.split("rv-railcol", 1)[-1].split(">" + AG2["short"] + "<")[0][-200:]   # in the rail, not the <title>
s.check("...and the rail names the approver in the step tooltip",
        ("With " + APPR["full_name"]) in seg, (_rs.status_code, _rs.headers.get("Location"), seg[-120:]))
s.check("...and does NOT count it as work still theirs",
        "still yours" not in seg, seg)
# Degrading safely matters as much: an unresolved chain must still be WAITING,
# never silently reassigned to the employee.
with a.app.app_context():
    db = a.get_db()
    db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id=?", (PROP,))
    db.commit()
AG3 = next(x for x in state()["stages"] if x["key"] == "agree")
s.check("an unresolved chain is still WAITING, not handed back to the employee",
        AG3["state"] == "waiting" and AG3["blocked_on"] is None,
        (AG3["state"], AG3["blocked_on"]))
s.check("the module predicate is what decides it, not the surface",
        a.pm_setting_is_waiting("proposed") is True
        and a.pm_setting_is_waiting("draft") is False)
with a.app.app_context():
    db = a.get_db()
    db.execute("DELETE FROM pm_kpi_targets WHERE id=?", (PROP,))
    db.commit()
_ey_back()

s.section("pm_checkins -- the absent column IS the design")
cols = [r["name"] for r in H.rows(a, "PRAGMA table_info(pm_checkins)")]
s.note("columns: %s" % ", ".join(cols))
# A check-in must never look like a submission. A rule in a route is a rule
# somebody deletes; a missing column is a migration somebody has to justify.
s.check("there is NO actual_value column", "actual_value" not in cols, cols)
s.check("...and no occurred_on either -- a check-in is about now",
        "occurred_on" not in cols)
s.check("kpi_target_id is the whole key -- no cycle_id, no subject_id",
        "cycle_id" not in cols and "subject_id" not in cols, cols)
ddl = H.one(a, "SELECT sql FROM sqlite_master WHERE name='pm_checkins'")
s.check("UNIQUE on kpi_target_id", "UNIQUE" in ddl.upper())
s.check("'nothing_yet' is a first-class answer", "nothing_yet" in ddl)

s.section("the check-in write")
CT = next(t for t in state()["targets"] if not t["bu_level"])
r = E.post("/review/checkin/save", data={"csrf_token": "tok",
                                         "kpi_target_id": str(CT["id"]),
                                         "answer": "nothing_yet"})
s.check("'nothing yet' is accepted, not refused", r.status_code == 200
        and (r.get_json() or {}).get("ok"), (r.status_code, r.get_json()))
s.check("one row exists",
        H.one(a, "SELECT COUNT(*) FROM pm_checkins WHERE kpi_target_id=?", (CT["id"],)) == 1)
E.post("/review/checkin/save", data={"csrf_token": "tok", "kpi_target_id": str(CT["id"]),
                                     "answer": "at_risk", "note": "Supplier slipped."})
s.check("re-answering UPDATES, never duplicates",
        H.one(a, "SELECT COUNT(*) FROM pm_checkins WHERE kpi_target_id=?", (CT["id"],)) == 1)
s.check("...and the answer changed",
        H.one(a, "SELECT answer FROM pm_checkins WHERE kpi_target_id=?", (CT["id"],)) == "at_risk")
# Absent is unchanged -- the df38274 rule, in a table written for the first time.
E.post("/review/checkin/save", data={"csrf_token": "tok", "kpi_target_id": str(CT["id"]),
                                     "answer": "on_track"})
s.check("an absent note is UNCHANGED, not blanked",
        H.one(a, "SELECT note FROM pm_checkins WHERE kpi_target_id=?",
              (CT["id"],)) == "Supplier slipped.")
r = E.post("/review/checkin/save", data={"csrf_token": "tok",
                                         "kpi_target_id": str(CT["id"]), "answer": "nope"})
s.check("an answer outside the vocabulary is refused", r.status_code == 400, r.status_code)
with a.app.app_context():
    other = a.get_db().execute(
        "SELECT id FROM pm_kpi_targets WHERE subject_id!=? LIMIT 1", (SUBJ["id"],)).fetchone()
if other:
    r = E.post("/review/checkin/save", data={"csrf_token": "tok",
                                             "kpi_target_id": str(other["id"]),
                                             "answer": "on_track"})
    s.check("somebody else's KPI line is refused", r.status_code == 403, r.status_code)

s.section("pm_evidence_links gets its first writer")
# Phase A created this table and nothing ever wrote to it -- the exact thing
# that commit's own message warned against.
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key='evidence'")
    db.commit()
r = E.post("/evidence/new", data={"csrf_token": "tok", "body": "Ran the changeover.",
                                  "occurred_on": "2026-03-14", "kind": "delivery"})
EID = H.one(a, "SELECT MAX(id) FROM pm_evidence WHERE subject_id=?", (SUBJ["id"],))
s.check("an evidence item was created", EID is not None, EID)
r = E.post("/evidence/%d/link" % EID, data={"csrf_token": "tok", "target_kind": "kpi",
                                            "target_ref": str(CT["id"])})
s.check("linking it to a KPI succeeds", r.status_code == 200 and (r.get_json() or {}).get("ok"),
        (r.status_code, r.get_json()))
row = H.rows(a, "SELECT target_kind, target_ref FROM pm_evidence_links WHERE evidence_id=?",
             (EID,))
s.note("stored: %s" % [dict(x) for x in row])
# THE FORMAT DECISION: target_kind already carries the kind, so target_ref is
# the BARE id. "kpi:<id>" would double-encode and make the index useless.
s.check("target_ref is the BARE id, not 'kpi:<id>'",
        row and row[0]["target_ref"] == str(CT["id"]), [dict(x) for x in row])
s.check("...and target_kind carries the kind", row and row[0]["target_kind"] == "kpi")
E.post("/evidence/%d/link" % EID, data={"csrf_token": "tok", "target_kind": "kpi",
                                        "target_ref": str(CT["id"])})
s.check("linking twice is idempotent -- UNIQUE holds",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence_links WHERE evidence_id=?", (EID,)) == 1)
if other:
    r = E.post("/evidence/%d/link" % EID, data={"csrf_token": "tok", "target_kind": "kpi",
                                                "target_ref": str(other["id"])})
    s.check("citing somebody ELSE's KPI is refused -- no enumeration oracle",
            r.status_code == 403, r.status_code)
r = E.post("/evidence/%d/link" % EID, data={"csrf_token": "tok", "target_kind": "nonsense",
                                            "target_ref": str(CT["id"])})
s.check("an unknown target_kind is refused", r.status_code == 400, r.status_code)
E.post("/evidence/%d/unlink" % EID, data={"csrf_token": "tok", "target_kind": "kpi",
                                          "target_ref": str(CT["id"])})
s.check("unlink removes the citation",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence_links WHERE evidence_id=?", (EID,)) == 0)
s.check("...and leaves the evidence item itself untouched",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence WHERE id=?", (EID,)) == 1)

s.section("the writers live where the module gate can see them")
s.check("the link routes are classified as 'evidence', not 'review'",
        a.MODULE_ENDPOINTS.get("evidence_link") == "evidence"
        and a.MODULE_ENDPOINTS.get("evidence_unlink") == "evidence")
# /review writes: the check-in agent turn + save + sign-off lock, the KPI-evidence
# writer, the manager note, the attach, the demo mechanism switch, the
# KPI-setting agent's turn + Submit, the competency agent's turn + Submit, the
# development-plan agent's turn + Share, the career agent's turn (no Share -- the
# profile has no lifecycle), the UNIFIED 360's human Submit + its demo reset (the
# journey TURN reuses /review/chat, so it adds no turn route), the in-chat KPI
# bulk-save, the competency + 360 'Save answers' bulk-record endpoints (the batch
# evaluation-widget model, mirroring the KPI save-all), the Career Plan widget's two
# bulk-save endpoints (/review/career/save-all + /review/ahead/save-all -- profile +
# dev-plan goals), and the ONE consolidated demo reset (/review/demo/reset-all -- the
# five per-stage resets collapsed into it). All classified; endorse/dispute/cite live
# under /evidence. (The KPI table's per-KPI note step was RETIRED 2026-09-22 -- so
# /review/kpi/note is gone; a standout KPI's evidence is now the FILE attached via
# /review/kpi/<id>/attach, and the one written part is the overall remark, saved through
# the chat agent's set_overall_remark tool -- no dedicated route.)
_writes = sorted(str(r.rule) for r in a.app.url_map.iter_rules()
                 if str(r.rule).startswith("/review") and not str(r.rule).startswith("/review/gradeh") and "POST" in r.methods)
s.check("/review owns its fifty-one known writes (+ the line manager's view of a report's 360, 2026-10-21; + the "
        "welcome's lines, 2026-10-22; + the assessment on someone's behalf, 2026-10-26; + the Executive Chairman's leaders' "
        "box: move, lock, record, 2026-10-29; + his AI insight's own POST, 2026-10-29)",
        _writes == ["/review/ahead/chat", "/review/ahead/save-all", "/review/ahead/submit",
                    "/review/career/chat", "/review/career/save-all",
                    "/review/chair/insight", "/review/chair/leaders/lock", "/review/chair/leaders/move", "/review/chair/leaders/record",
                    "/review/chat",
                    "/review/checkin/save", "/review/competency/chat",
                    "/review/competency/note", "/review/competency/remark",
                    "/review/competency/save-all", "/review/competency/submit",
                    "/review/confirm",
                    "/review/demo/feedback-reset", "/review/demo/mechanism",
                    "/review/demo/reset-all", "/review/demo/reset-calibration", "/review/demo/reset-team",
                    "/review/evidence/<int:eid>/attach",
                    "/review/evidence/attachment/<int:aid>/delete",
                    "/review/feedback/remark", "/review/feedback/save-all",
                    "/review/feedback/submit",
                    "/review/intro/seen",
                    "/review/kpi-evidence", "/review/kpi/<int:kpi_id>/attach",
                    "/review/kpi/remark", "/review/kpi/save-all",
                    "/review/setting/chat", "/review/setting/propose", "/review/setting/unit",
                    "/review/team/<int:subject_id>/note",
                    "/review/team/approve-bulk", "/review/team/behalf/pm", "/review/team/calib-fit",
                    "/review/team/calib-move",
                    "/review/team/calib-summary", "/review/team/dept-accept", "/review/team/idp-remark",
                    "/review/team/idp-summary", "/review/team/insights",
                    "/review/team/pm-summary", "/review/team/pot-summary", "/review/team/tbox-insight",
                    "/review/team/tbox-person", "/review/team/tbox-remark",
                    "/review/team/tm-360", "/review/team/tm-summary"], _writes)
s.check("the evidence label no longer claims check-ins it does not gate",
        "check-in" not in a.CYCLE_MODULE_LABELS["evidence"].lower(),
        a.CYCLE_MODULE_LABELS["evidence"])

# ---------------------------------------------------------------------------
s.section("demo-only controls (ZZ accounts): reset + mechanism switch")
# Gate = employee_id starts with ZZ. Mutate a few seeded users' ids in this
# throwaway DB: a ZZ caller with its own chat+result, a non-ZZ subject whose rows
# must stay untouched, and a ZZ mechanism-switch target.
with a.app.app_context():
    db = a.get_db()
    _spares = db.execute("SELECT id FROM users WHERE role!='admin' AND left_at IS NULL "
                         "AND id!=? AND employee_id NOT LIKE 'ZZ%' ORDER BY id LIMIT 2",
                         (SUBJ["id"],)).fetchall()

    def _ensure(eid, spare_id):
        row = db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()
        if row:
            return row["id"]
        db.execute("UPDATE users SET employee_id=? WHERE id=?", (eid, spare_id))
        return spare_id

    ZZID = _ensure("ZZDEMOTEST-CALLER", _spares[0]["id"])   # unique -> always a rename
    TGTID = _ensure("ZZPMDEMO-FIA1", _spares[1]["id"])       # present on staging, else renamed
    _zkpi = db.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
        "status, business_group) VALUES (?,?,?,100,'more','approved','ZZ BG')",
        (CID, ZZID, "ZZ Demo KPI")).lastrowid
    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value) VALUES (?, 5)", (_zkpi,))
    db.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content) "
               "VALUES (?,?,'user','hi'),(?,?,'agent','hello')", (ZZID, CID, ZZID, CID))
    # A non-ZZ subject (SUBJ) with its own chat + result -- reset must NOT touch it.
    _skpi = db.execute("SELECT id FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=? LIMIT 1",
                       (SUBJ["id"], CID)).fetchone()["id"]
    db.execute("INSERT OR IGNORE INTO pm_kpi_results(kpi_target_id, actual_value) VALUES (?, 9)", (_skpi,))
    db.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content) "
               "VALUES (?,?,'user','mine')", (SUBJ["id"], CID))
    db.commit()

s.check("the demo routes are all classified 'review'",
        a.MODULE_ENDPOINTS.get("review_demo_reset_all") == "review"
        and a.MODULE_ENDPOINTS.get("review_demo_mechanism") == "review"
        and a.MODULE_ENDPOINTS.get("review_demo_reset_team") == "review")

# Consolidation (2026-09-14): the demo Solo/Manager toggle is gone -- the ONE
# "Viewing as" persona switcher drives the Team view via _review_manages, which now
# uses the real predicate for everyone (no ZZ demo_manages short-circuit).
s.check("review_demo_reports route removed",
        "review_demo_reports" not in {r.endpoint for r in a.app.url_map.iter_rules()})
s.check("demo_manages short-circuit gone from app.py",
        "demo_manages" not in H.code_without_docstrings(H.source(a)))

# The gate: a NON-ZZ user is refused the routes (404), and its data is untouched.
NZ = H.client_as(a, SUBJ["id"])
s.check("non-ZZ user -> reset is 404",
        NZ.post("/review/demo/reset-all", data={"csrf_token": "tok"}).status_code == 404)
s.check("non-ZZ user -> mechanism is 404",
        NZ.post("/review/demo/mechanism", data={"csrf_token": "tok", "mech": "a"}).status_code == 404)

ZC = H.client_as(a, ZZID)
s.check("bogus mech -> 404",
        ZC.post("/review/demo/mechanism", data={"csrf_token": "tok", "mech": "nope"}).status_code == 404)

# The switch: mech=fiamma -> session becomes the ZZ target (ZZPMDEMO-FIA1).
r = ZC.post("/review/demo/mechanism", data={"csrf_token": "tok", "mech": "fiamma"})
s.check("mech=fiamma redirects", r.status_code in (302, 303), r.status_code)
with ZC.session_transaction() as _sess:
    s.check("...session switched to the ZZ target account", _sess.get("user_id") == TGTID,
            (_sess.get("user_id"), TGTID))
# a session carries its account's password mark (the 2026-10-24 handoff, 12.2): the switch drops the old one's, so the
# target's next page is theirs, not the sign-in page
s.check("...and stays signed in as the target", ZC.get("/account/password").status_code == 200)
with ZC.session_transaction() as _sess:
    s.check("...stamped with the target's own mark", _sess.get("user_id") == TGTID and _sess.get("pw"))

# The ONE reset clears the ZZ caller's WHOLE journey -- chat + results + session lock,
# and leaves its targets 'approved' so it lands on a ready check-in. (Fresh client --
# the one above switched identity.) SUBJ's rows must survive.
with a.app.app_context():
    _rdb = a.get_db()
    _rdb.execute("INSERT OR REPLACE INTO pm_review_session(subject_id, cycle_id, locked_at, locked_by) "
                 "VALUES (?,?,datetime('now'),?)", (ZZID, CID, ZZID))
    # Seed check-in narrative content for BOTH the ZZ caller and a non-ZZ subject: an
    # overall remark + a review-logged example (recognition evidence). The reset must clear
    # the ZZ caller's and leave the non-ZZ subject's alone.
    for _sid in (ZZID, SUBJ["id"]):
        _rdb.execute("INSERT INTO pm_overall_remarks(cycle_id, subject_id, remark, submitted_by, draft) "
                     "VALUES (?,?,?,?,1)", (CID, _sid, "stale remark", _sid))
        _rdb.execute("INSERT INTO pm_evidence(subject_id, author_id, occurred_on, kind, body, state) "
                     "VALUES (?,?, '2026-01-01', 'recognition', 'stale example', 'shared')", (_sid, _sid))
    _rdb.commit()
ZC2 = H.client_as(a, ZZID)
r = ZC2.post("/review/demo/reset-all", data={"csrf_token": "tok"})
s.check("reset redirects", r.status_code in (302, 303), r.status_code)
s.check("ZZ caller's chat cleared",
        H.one(a, "SELECT COUNT(*) FROM pm_review_chat WHERE subject_id=?", (ZZID,)) == 0)
s.check("ZZ caller's results cleared",
        H.one(a, "SELECT COUNT(*) FROM pm_kpi_results r JOIN pm_kpi_targets t ON t.id=r.kpi_target_id "
                 "WHERE t.subject_id=?", (ZZID,)) == 0)
s.check("ZZ caller's session lock cleared (re-runnable)",
        H.one(a, "SELECT COUNT(*) FROM pm_review_session WHERE subject_id=? AND cycle_id=?", (ZZID, CID)) == 0)
s.check("ZZ caller's targets left approved (lands on a ready check-in)",
        H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=? "
                 "AND status!='approved'", (ZZID, CID)) == 0)
s.check("...but the non-ZZ subject's chat is untouched",
        H.one(a, "SELECT COUNT(*) FROM pm_review_chat WHERE subject_id=?", (SUBJ["id"],)) >= 1)
s.check("...and the non-ZZ subject's result is untouched",
        H.one(a, "SELECT COUNT(*) FROM pm_kpi_results r JOIN pm_kpi_targets t ON t.id=r.kpi_target_id "
                 "WHERE t.subject_id=?", (SUBJ["id"],)) >= 1)
# The reset also wipes the ZZ caller's OWN check-in narrative (or it shows on the next
# confirm card even after they skip): the overall remark + the review-logged examples.
s.check("ZZ caller's overall remark cleared by reset",
        H.one(a, "SELECT COUNT(*) FROM pm_overall_remarks WHERE subject_id=? AND cycle_id=?", (ZZID, CID)) == 0)
s.check("ZZ caller's logged examples (recognition evidence) cleared by reset",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence WHERE author_id=? AND kind='recognition'", (ZZID,)) == 0)
s.check("...but the non-ZZ subject's remark is untouched",
        H.one(a, "SELECT COUNT(*) FROM pm_overall_remarks WHERE subject_id=? AND cycle_id=?", (SUBJ["id"], CID)) >= 1)
s.check("...and the non-ZZ subject's evidence is untouched",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence WHERE author_id=? AND kind='recognition'", (SUBJ["id"],)) >= 1)

# The demo check-in editability override: a ZZ account may key a result even on a
# NON-approved target (the widget bug fix), while a real user may not; BU-level and an
# already-submitted result still block. Pure-function checks + one live save.
s.check("_review_line_editable: ZZ + non-approved target -> editable",
        a._review_line_editable({"employee_id": "ZZDEMOTEST-CALLER"},
                                {"bu_level": 0, "status": "proposed", "result": None}) is True)
s.check("_review_line_editable: non-ZZ + non-approved -> NOT editable",
        a._review_line_editable({"employee_id": "X0008"},
                                {"bu_level": 0, "status": "proposed", "result": None}) is False)
s.check("_review_line_editable: ZZ but already submitted (draft=0) -> NOT editable",
        a._review_line_editable({"employee_id": "ZZX"},
                                {"bu_level": 0, "status": "proposed", "result": {"draft": 0}}) is False)
s.check("_review_line_editable: ZZ but BU-level (HR's figure) -> NOT editable",
        a._review_line_editable({"employee_id": "ZZX"},
                                {"bu_level": 1, "status": "approved", "result": None}) is False)
# Live: put the ZZ target back to a NON-approved status; save-all still records it
# because the account is a ZZ demo -> the widget works (the override on the write path).
_ztid = H.one(a, "SELECT id FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=? LIMIT 1", (ZZID, CID))
with a.app.app_context():
    a.get_db().execute("UPDATE pm_kpi_targets SET status='proposed' WHERE id=?", (_ztid,))
    a.get_db().commit()
ZC_save = H.client_as(a, ZZID)
ZC_save.post("/review/kpi/save-all", data={"csrf_token": "tok", ("actual_value_%d" % _ztid): "7"})
s.check("save-all records a ZZ line whose target is NON-approved (the demo override)",
        H.one(a, "SELECT actual_value FROM pm_kpi_results WHERE kpi_target_id=?", (_ztid,)) == 7.0)

# ---------------------------------------------------------------------------
s.section("attach a file DIRECTLY to a KPI (FILES column) -- no example needed first")
with a.app.app_context():
    a.get_db().execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES(?, 'evidence', 1) "
                       "ON CONFLICT(cycle_id, module_key) DO UPDATE SET active=1", (CID,))
    a.get_db().commit()


def _pdf(name="proof.pdf"):
    return {"csrf_token": "tok", "file": (io.BytesIO(b"%PDF-1.4 demo"), name)}


ZC_att = H.client_as(a, ZZID)
r_att = ZC_att.post("/review/kpi/%d/attach" % _ztid, data=_pdf(),
                    content_type="multipart/form-data")
s.check("own KPI attach -> ok", r_att.status_code == 200 and (r_att.get_json() or {}).get("ok") is True,
        (r_att.status_code, r_att.get_json()))
s.check("...it created a KPI-linked recognition evidence item",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence e JOIN pm_evidence_links l ON l.evidence_id=e.id "
                 "WHERE e.author_id=? AND e.kind='recognition' AND l.target_kind='kpi' AND l.target_ref=?",
                 (ZZID, str(_ztid))) >= 1)
s.check("...and stored the attachment",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence_attachments att JOIN pm_evidence_links l "
                 "ON l.evidence_id=att.evidence_id WHERE l.target_kind='kpi' AND l.target_ref=?",
                 (str(_ztid),)) >= 1)
# A second file reuses the SAME item (no duplicate item), just adds an attachment.
ZC_att.post("/review/kpi/%d/attach" % _ztid, data=_pdf("more.pdf"), content_type="multipart/form-data")
s.check("...a second file reuses the same item (one item, two files)",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence e JOIN pm_evidence_links l ON l.evidence_id=e.id "
                 "WHERE e.author_id=? AND e.kind='recognition' AND l.target_ref=?", (ZZID, str(_ztid))) == 1)
# A non-owned KPI (SUBJ's) -> 404.
_stid = H.one(a, "SELECT id FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=? LIMIT 1", (SUBJ["id"], CID))
s.check("another person's KPI -> 404",
        ZC_att.post("/review/kpi/%d/attach" % _stid, data=_pdf(), content_type="multipart/form-data").status_code == 404)
# A disallowed extension -> 400.
s.check("a .exe is refused",
        ZC_att.post("/review/kpi/%d/attach" % _ztid,
                    data={"csrf_token": "tok", "file": (io.BytesIO(b"MZ"), "x.exe")},
                    content_type="multipart/form-data").status_code == 400)
# Once the check-in is locked, no more files.
with a.app.app_context():
    a.get_db().execute("INSERT OR REPLACE INTO pm_review_session(subject_id, cycle_id, locked_at, locked_by) "
                       "VALUES (?,?,datetime('now'),?)", (ZZID, CID, ZZID))
    a.get_db().commit()
s.check("locked check-in -> attach refused (400)",
        ZC_att.post("/review/kpi/%d/attach" % _ztid, data=_pdf(), content_type="multipart/form-data").status_code == 400)
with a.app.app_context():
    a.get_db().execute("DELETE FROM pm_review_session WHERE subject_id=? AND cycle_id=?", (ZZID, CID))
    a.get_db().commit()
s.check("/review/kpi/<id>/attach is classified 'evidence'",
        a.MODULE_ENDPOINTS.get("review_kpi_attach") == "evidence")

# ---------------------------------------------------------------------------
s.section("confirm & lock -- the sign-off is the ONE lock; account is done iff locked")


def acct():
    return next(x for x in state()["stages"] if x["key"] == "account")


def overview_locked():
    with a.app.test_request_context("/"):
        from flask import session as _s
        _s["user_id"] = SUBJ["id"]
        return a._review_kpi_overview(a.get_db(), SUBJ)["data"]["locked"]


# Before every line is keyed, the sign-off is refused (nothing to lock a half-set).
s.check("unkeyed -> /review/confirm refused (400)",
        E.post("/review/confirm", data={"csrf_token": "tok"}).status_code == 400)
# Key both approved lines as DRAFT results (amendable until confirm).
with a.app.app_context():
    db = a.get_db()
    for r in db.execute("SELECT id FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=? "
                        "AND status='approved'", (SUBJ["id"], CID)).fetchall():
        db.execute("INSERT OR REPLACE INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) "
                   "VALUES (?,?,?,1)", (r["id"], 90.0, SUBJ["id"]))
    db.commit()
s.check("all keyed but NOT confirmed -> account still OPEN (not done)", acct()["state"] == "open", acct()["state"])
s.check("...and the overview reports not locked", overview_locked() is False)
# The lock.
rc = E.post("/review/confirm", data={"csrf_token": "tok"})
s.check("confirm returns ok + locked", rc.status_code == 200 and (rc.get_json() or {}).get("locked") is True,
        rc.status_code)
s.check("...results are promoted to draft=0 (submitted)",
        H.one(a, "SELECT MAX(draft) FROM pm_kpi_results r JOIN pm_kpi_targets t ON t.id=r.kpi_target_id "
                 "WHERE t.subject_id=? AND t.cycle_id=?", (SUBJ["id"], CID)) == 0)
s.check("...a session lock row is stamped",
        H.one(a, "SELECT COUNT(*) FROM pm_review_session WHERE subject_id=? AND cycle_id=? "
                 "AND locked_at IS NOT NULL", (SUBJ["id"], CID)) == 1)
s.check("account is now DONE (only because it is locked)", acct()["state"] == "done", acct()["state"])
s.check("...and the overview reports locked", overview_locked() is True)
s.check("confirm is idempotent (already locked -> ok)",
        E.post("/review/confirm", data={"csrf_token": "tok"}).status_code == 200)
s.check("/review/confirm is classified 'review'", a.MODULE_ENDPOINTS.get("review_confirm") == "review")
s.check("/review/kpi/save-all is classified 'review'",
        a.MODULE_ENDPOINTS.get("review_kpi_save_all") == "review")
s.check("/review/team/approve-bulk is classified 'review'",
        a.MODULE_ENDPOINTS.get("review_team_approve_bulk") == "review")

# Backward-compat: a check-in SUBMITTED before this sign-off existed (results at
# draft=0, but no lock row) must still read as done -- else the deploy would flip
# every already-submitted check-in back to 'pending'.
with a.app.app_context():
    a.get_db().execute("DELETE FROM pm_review_session WHERE subject_id=? AND cycle_id=?", (SUBJ["id"], CID))
    a.get_db().commit()
with a.app.app_context():
    s.check("legacy: all results draft=0 but NO lock row -> still locked/done",
            a.pm_review_locked(a.get_db(), SUBJ["id"], CID) is True)
s.check("...and the account stage stays DONE for that legacy state", acct()["state"] == "done", acct()["state"])

# ---------------------------------------------------------------------------
s.section("the demo strip lives in the navy banner (ZZ + /review only)")
_zc = H.client_as(a, ZZID)
_rv = _zc.get("/review/account").get_data(as_text=True)
s.check("banner shows the review demo strip on /review for a ZZ account",
        "rv-demobar-nav" in _rv and "/review/demo/mechanism" in _rv, None)
s.check("...but NOT in the review body (it moved out)", "rv-demobar-top" not in _rv, None)
s.check("...and NOT on /dashboard (a non-/review page)",
        "rv-demobar-nav" not in _zc.get("/dashboard").get_data(as_text=True), None)
s.check("...and NOT for a real (non-ZZ) user on /review",
        "rv-demobar-nav" not in H.client_as(a, SUBJ["id"]).get("/review/account").get_data(as_text=True), None)

sys.exit(s.done())
