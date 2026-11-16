"""Phase 0 repairs -- 7430e62.

Every repair in that commit is a READ-PATH or GATE fix: no schema change, and
nothing about which band wins may move. So most of what follows asserts what
must NOT have changed.
"""
import ast
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
import ai_draft  # noqa: E402
s = H.Suite("Phase 0 -- repairs")
SU, _BG, EMP = H.actors(a)
SRC = H.source(a)
TREE = ast.parse(SRC)

# ---------------------------------------------------------------------------
s.section("the half comparison -- the regression this phase exists for")
# cycles.half is an INTEGER since the pm_periods -> cycles merge; two IDP
# helpers compared it to the string "HY2". 2 == "HY2" is False, so
# pm_idp_can_edit() refused unconditionally and all six write paths were shut.
for period, want, label in [
        ({"year": 2026, "half": 2}, True, "int 2  (how cycles stores it)"),
        ({"year": 2026, "half": 1}, False, "int 1"),
        ({"year": 2026, "half": "HY2"}, True, "legacy 'HY2'"),
        ({"year": 2026, "half": "HY1"}, False, "legacy 'HY1'"),
        ({"year": 2026, "half": "2"}, True, "string '2'"),
        ({"year": 2026, "half": None}, False, "NULL half"),
        (None, False, "no period at all")]:
    s.check("_is_year_end %-30s -> %s" % (label, want),
            a._is_year_end(period) == want, a._is_year_end(period))
s.check("pm_idp_is_authoring is True at Year-End",
        a.pm_idp_is_authoring({"year": 2026, "half": 2}) is True)
s.check("...and False at Mid-Year",
        a.pm_idp_is_authoring({"year": 2026, "half": 1}) is False)

s.section("the plan a period resolves to")
s.check("Year-End 2026 writes the 2027 plan",
        a.pm_idp_plan_year({"year": 2026, "half": 2}) == 2027)
s.check("Mid-Year 2026 reads the 2026 plan",
        a.pm_idp_plan_year({"year": 2026, "half": 1}) == 2026)
s.check("no period -> None", a.pm_idp_plan_year(None) is None)
# The SQL half of the codebase already implemented exactly this rule.
s.check("matches the merge SQL's own rule (CASE WHEN half=2 THEN year+1)",
        "CASE WHEN p.half=2 THEN p.year + 1 ELSE p.year END" in SRC)

s.section("pm_idp_can_edit")
s.check("False when not authoring", a.pm_idp_can_edit({"status": "draft"}, False) is False)
s.check("True at Year-End on a draft", a.pm_idp_can_edit({"status": "draft"}, True) is True)
s.check("a closed plan stays shut", a.pm_idp_can_edit({"status": "closed"}, True) is False)

# ---------------------------------------------------------------------------
s.section("with a Year-End cycle ACTIVE, the IDP write paths open")
# The predicate checks above cannot make the claim "the gate opens". This
# activates a real Year-End cycle in the scratch copy and drives the routes.
with a.app.app_context():
    db = a.get_db()
    prev_active = db.execute("SELECT id FROM cycles WHERE is_active=1").fetchone()[0]
    ye = db.execute("SELECT id, name, year, half FROM cycles WHERE half=2 "
                    "ORDER BY year DESC LIMIT 1").fetchone()
    db.execute("UPDATE cycles SET is_active=0")
    db.execute("UPDATE cycles SET is_active=1 WHERE id=?", (ye["id"],))
    db.commit()
s.note("activated %s (year=%s half=%s)" % (ye["name"], ye["year"], ye["half"]))
try:
    E = H.client_as(a, EMP["id"])
    s.check("employee GET /idp -> 200", E.get("/idp").status_code == 200)
    r = E.post("/idp/autosave", data={"csrf_token": "tok", "aspiration": "Lead a plant"})
    # Before the fix this was 409 "This plan is no longer editable". Anything
    # else means it got past the period gate.
    s.check("autosave no longer refused as 'not editable'", r.status_code != 409,
            (r.status_code, str(r.get_json())[:52]))

    real_idp = a.get_idp_settings
    try:
        a.get_idp_settings = lambda: (True, 3, 6, False)      # index 3 = AI off
        r = E.post("/idp/suggest", data={"csrf_token": "tok"})
        msg = (r.get_json() or {}).get("error") or ""
        s.check("AI off -> 503 from the AI switch, not the period gate",
                r.status_code == 503 and "switched off" in msg, (r.status_code, msg[:50]))
        a.get_idp_settings = lambda: (True, 3, 6, True)
        r = E.post("/idp/suggest", data={"csrf_token": "tok"})
        blocked = (r.status_code == 503
                   and "switched off" in ((r.get_json() or {}).get("error") or ""))
        s.check("AI on -> past the switch", not blocked, r.status_code)
    finally:
        a.get_idp_settings = real_idp

    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = EMP["id"]
        db = a.get_db()
        per = db.execute("SELECT * FROM cycles WHERE is_active=1").fetchone()
        s.check("a plan written now files under year+1",
                a.pm_idp_plan_year(per) == ye["year"] + 1, a.pm_idp_plan_year(per))
        yrs = a.pm_idp_years_for(db, EMP["id"], per)
        s.check("the year switcher still offers every year on file",
                a.pm_idp_plan_year(per) in yrs, yrs)
finally:
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET is_active=0")
        db.execute("UPDATE cycles SET is_active=1 WHERE id=?", (prev_active,))
        db.commit()

# ---------------------------------------------------------------------------
s.section("a switched-off module must refuse, not just hide the button")
FORM = {"draft": "x", "instruction": "tidy", "category": "Core", "csrf_token": "tok"}
real_on, real_cfg = a.ai_on, ai_draft.is_configured
real_dp, real_dm = ai_draft.draft_pm, ai_draft.draft_pm_manager
try:
    # The module-gate 503 and the not-configured 503 carry the SAME message, so
    # a bare status check cannot tell them apart. Stub the call to succeed:
    # module-on is then a 200, module-off is unambiguously the gate.
    ai_draft.is_configured = lambda: True
    ai_draft.draft_pm = lambda d, i, context=None, **kw: "stub"
    ai_draft.draft_pm_manager = lambda d, i, context=None, **kw: "stub"
    a.ai_on = lambda k: k != "ai_tc"
    r = H.client_as(a, EMP["id"]).post("/technical/overall-draft-ai", data=FORM)
    s.check("ai_tc off  -> the technical endpoint refuses", r.status_code == 503,
            r.status_code)
    a.ai_on = lambda k: k != "ai_pm"
    r = H.client_as(a, EMP["id"]).post("/technical/overall-draft-ai", data=FORM)
    s.check("ai_pm off  -> technical drafting still works",
            r.status_code == 200 and (r.get_json() or {}).get("ok") is True,
            r.status_code)
finally:
    a.ai_on, ai_draft.is_configured = real_on, real_cfg
    ai_draft.draft_pm, ai_draft.draft_pm_manager = real_dp, real_dm

# 'Draft with AI' (Chris, 2026-09-24: "make sure all our remark writing does not create hallucination"):
# a rewrite may re-word what the person wrote, never add a fact or a figure to it -- and the AI never
# writes a remark from nothing.
s.section("Draft with AI re-words what they wrote -- never adds facts or figures")
RW = a._rewrite_grounding_error
_mine = "I kept supplier costs flat in a slow quarter and held margin."
s.check("a polish that re-orders their words passes",
        RW(_mine, "Polish", "", "In a slow quarter I kept supplier costs flat and held our margin.") is None)
s.check("an invented figure is refused, and the message names it",
        "12" in (RW(_mine, "Make it longer", "", _mine + " Costs fell 12%.") or ""))
s.check("invented details are refused",
        RW(_mine, "Make it longer", "", "I kept supplier costs flat by renegotiating three vendor contracts and "
           "launching a regional sourcing programme with procurement.") is not None)
s.check("an empty draft is refused -- the AI polishes, it doesn't invent a remark from nothing",
        RW("", "Polish", "", "A strong half with great results.") is not None)
_real_cfg, _real_on, _real_dp = ai_draft.is_configured, a.ai_on, ai_draft.draft_pm
try:
    ai_draft.is_configured = lambda: True
    a.ai_on = lambda k: True
    ai_draft.draft_pm = lambda d, i, context=None, **kw: "I kept supplier costs flat and cut spend 12% across four plants."
    _u0 = H.one(a, "SELECT COUNT(*) FROM pm_ai_draft_usage WHERE user_id=?", (EMP["id"],))
    _rr = H.client_as(a, EMP["id"]).post("/technical/overall-draft-ai",
                                         data=dict(FORM, draft="I kept supplier costs flat."))
    s.check("a route returning an invented rewrite answers 422 with the reason, and nothing is applied",
            _rr.status_code == 422 and (_rr.get_json() or {}).get("ok") is False
            and "12" in ((_rr.get_json() or {}).get("error") or ""), (_rr.status_code, _rr.get_json()))
    s.check("...and it does not cost them one of their AI drafts",
            H.one(a, "SELECT COUNT(*) FROM pm_ai_draft_usage WHERE user_id=?", (EMP["id"],)) == _u0)
finally:
    ai_draft.is_configured, a.ai_on, ai_draft.draft_pm = _real_cfg, _real_on, _real_dp
_src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app.py")).read()
s.check("the 360 rate-page rewrite runs the same check",
        "_rewrite_grounding_error(draft_text, instruction, principle" in _src)
s.check("only the IDP development-action rewrite opts out (plans, not claims)",
        _src.count("ground=False,") == 1 and "draft_fn=ai_draft.draft_pm, ground=False," in _src)

s.section("lint: no non-Performance AI route may inherit the Performance switch")
# NOT "every route says module=" -- a PM route correctly takes the ai_pm
# default. The invariant is that a /technical or /idp route must not.
inherits = []
for node in ast.walk(TREE):
    if not isinstance(node, ast.FunctionDef):
        continue
    rules = [d.args[0].value for d in node.decorator_list
             if isinstance(d, ast.Call) and getattr(d.func, "attr", "") == "route"
             and d.args and isinstance(d.args[0], ast.Constant)]
    ai_rules = [r for r in rules if "draft-ai" in r or "/suggest" in r]
    if not ai_rules:
        continue
    body = ast.get_source_segment(SRC, node) or ""
    for rule in ai_rules:
        if rule.startswith("/technical") and 'module="ai_tc"' not in body:
            inherits.append((node.name, rule, "must declare ai_tc"))
        if rule.startswith("/idp") and "get_idp_settings()" not in body:
            inherits.append((node.name, rule, "must gate on the IDP switch"))
s.check("no AI route inherits another module's switch", not inherits, inherits)
s.check("all five technical routes declare ai_tc", SRC.count('module="ai_tc"') == 5,
        SRC.count('module="ai_tc"'))
_resp = [n for n in ast.walk(TREE)
         if isinstance(n, ast.FunctionDef) and n.name == "_pm_ai_draft_respond"][0]
_rsrc = ast.get_source_segment(SRC, _resp) or ""
s.check("the shared responder gates on its module PARAMETER",
        "if module and not ai_on(module)" in _rsrc and 'ai_on("ai_pm")' not in _rsrc)

s.section("blocking AI calls")
import inspect  # noqa: E402
s.check("draft_idp_goals is 25s, not 45",
        inspect.signature(ai_draft.draft_idp_goals).parameters["timeout"].default == 25)
s.check("nothing in ai_draft waits longer than 30s",
        "timeout=45" not in H.source(a, "ai_draft.py")
        and "timeout=60" not in H.source(a, "ai_draft.py"))

# ---------------------------------------------------------------------------
s.section("the calibration trail -- every tier, not just the last")
# THIS SECTION SEEDS ITS OWN ADJUSTMENTS, and it has to.
#
# Until 2026-08-28 it asserted "each entry carries a tier label and a note" over
# whatever the database happened to hold -- and pm_calibration_adjustments is
# EMPTY here, so every trail was [] and all() over nothing is True. The check was
# green while inspecting ZERO entries: it could not have failed no matter what
# pm_calibration_trails() returned. A vacuous check is worse than no check,
# because it is counted as coverage.
#
# So it now builds the exact case the repair exists for -- the live one from
# subject 3849: the HOD moved the band WITH a justification, the BU CEO moved it
# again with NO note. pm_effective_band() returns the BU CEO's empty note and
# stops, so a BG CEO saw an empty tooltip and never the reasoning that actually
# produced the rating. Both tiers must appear, in authority order.
#
# Everything written here is removed in the finally, so the scratch database is
# left as it was found and a re-run measures the same thing.
s.check("pm_calibration_trails exists", hasattr(a, "pm_calibration_trails"))
s.check("the per-subject version was not left behind",
        not hasattr(a, "pm_calibration_trail"))
_seeded = []
with a.app.test_request_context("/"):
    from flask import session as _s
    _s["user_id"] = SU["id"]
    db = a.get_db()
    cid = a.active_cycle_id(db)
    # The subject must be reachable by BOTH scope keys pm_calibration_trails()
    # builds: hod is str(hod_id), buceo is company.
    subj = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                      "AND hod_id IS NOT NULL AND TRIM(COALESCE(company,''))!='' "
                      "LIMIT 1").fetchone()
    s.check("found a subject with both a HOD and a company", subj is not None)
    pop = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                     "AND id!=? LIMIT 39", (subj["id"],)).fetchall()
    pop = [subj] + list(pop)
    try:
        for tier, key, frm, to, note in [
                ("hod", str(subj["hod_id"]), "Mid", "High",
                 "Ran the plant changeover single-handed in March."),
                ("buceo", subj["company"], "High", "Mid", None)]:
            sid = db.execute(
                "INSERT INTO pm_calibration_sessions(cycle_id, tier, scope_key, "
                "business_group, scope_label, locked_at) "
                "VALUES (?,?,?,?,?,datetime('now'))",
                (cid, tier, key, subj["business_group"] or "", "test")).lastrowid
            db.execute("INSERT INTO pm_calibration_adjustments(session_id, subject_id, "
                       "original_band, adjusted_band, justification) VALUES (?,?,?,?,?)",
                       (sid, subj["id"], frm, to, note))
            _seeded.append(sid)
        db.commit()

        t0 = time.time()
        trails = a.pm_calibration_trails(db, pop, cid)
        elapsed = time.time() - t0
        bands = [a.pm_effective_band(db, p, cid, "ME")["band"] for p in pop[:40]]
        has_source = all("source" in a.pm_effective_band(db, p, cid, "ME") for p in pop[:5])
        mine = trails.get(subj["id"], [])
    finally:
        for sid in _seeded:
            db.execute("DELETE FROM pm_calibration_adjustments WHERE session_id=?", (sid,))
            db.execute("DELETE FROM pm_calibration_sessions WHERE id=?", (sid,))
        db.commit()

s.check("keyed by subject", isinstance(trails, dict) and len(trails) == len(pop))
s.check("40 subjects in under 200ms -- batched, not per-subject", elapsed < 0.2,
        "%.3fs" % elapsed)
# The guard that makes every assertion below non-vacuous. all() over an empty
# sequence is True, so without this the four checks that follow prove nothing.
_entries = sum(len(v) for v in trails.values())
s.check("the trail is NOT empty -- these checks inspect real entries", _entries > 0,
        "%d entries over %d subjects" % (_entries, len(trails)))
s.check("each entry carries a tier label and a note",
        _entries > 0 and all(all({"tier", "label", "band", "note"} <= set(e) for e in v)
                             for v in trails.values()))
s.check("BOTH tiers reach the trail, not just the last",
        [e["tier"] for e in mine] == ["hod", "buceo"], [e["tier"] for e in mine])
s.check("...lowest authority first", [e["label"] for e in mine] == ["HOD", "BU CEO"],
        [e["label"] for e in mine])
# The whole point: pm_effective_band() stops at the BU CEO's EMPTY note, so the
# HOD's reasoning was invisible to the person defending the rating.
s.check("the HOD's justification survives the BU CEO's silent override",
        len(mine) == 2 and mine[0]["note"].startswith("Ran the plant changeover")
        and mine[1]["note"] == "",
        [(e["tier"], e["note"][:24]) for e in mine])
s.check("each entry records what it moved FROM",
        len(mine) == 2 and mine[0]["from"] == "Mid" and mine[1]["from"] == "High",
        [(e["from"], e["band"]) for e in mine])
s.check("the seeded sessions were cleaned up",
        not H.one(a, "SELECT COUNT(*) FROM pm_calibration_sessions WHERE scope_label='test'"))

s.section("nothing about which band WINS may have changed")
s.check("pm_effective_band resolves for every subject", len(bands) == len(pop))
s.check("its source field is intact", has_source)

s.section("what the templates now carry")
chain = H.source(a, os.path.join("templates", "_calib_chain.html"))
s.check("the chain renders note_trail", "note_trail" in chain)
s.check("...and still falls back to prev_note", "prev_note" in chain)
rep = H.source(a, os.path.join("templates", "_calib_report_kpi.html"))
s.check("the KPI attachment reaches the calibration report", "t['attachment']" in rep)
s.check("...through the download route that already exists",
        "performance_kpi_attachment_download" in rep)
cyc = H.source(a, os.path.join("templates", "admin_cycles.html"))
s.check("a cycle's year can be set", 'name="year"' in cyc)
s.check("...and its half", 'name="half"' in cyc)
s.check("the INSERT carries them (and the cycle type's kind, 2026-10-15)",
        "INSERT INTO cycles(code, name, ends_on, starts_on, is_active, year, half, kind, min_job_grade, " in SRC)

sys.exit(s.done())
