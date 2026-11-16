"""Potential calibration in the journey (Chris, 2026-09-28: "For performance and potential calibration respectively,
use the same line manager method by providing the overall AI summary + their score of the person's performance or
potential first with left and right navigation button, only then show the calibration curve").

A second Calibration tab (stage 'calibration_pot') for HOD / BU CEO / BG CEO over the SAME tables the classic potential
pages write. Moves go through _pot_calib_apply (the classic adjust routes' checks); the lock is the classic lock route,
which now returns to the journey. The AI insight on a person's potential obeys every 360 anonymity rule.

Writes rows, so a fresh copy.
"""
import inspect
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Potential calibration -- person by person, the AI insight within the 360 rules")

# ---------------------------------------------------------------------------
s.section("build: a HOD scope whose people have real 360s")
with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','calibration','pm','tm')")
    db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('ai_calib','1')")
    db.commit()
    # the HOD whose department has the most people with a VALID 360 this cycle
    best = None
    for h in db.execute("SELECT hod_id, COUNT(*) n FROM users WHERE hod_id IS NOT NULL AND role!='admin' "
                        "GROUP BY hod_id ORDER BY n DESC LIMIT 40").fetchall():
        pop = a._pot_scope_population(db, "hod", h["hod_id"])
        valid = [p for p in pop if a.subject_result(db, p, CID).get("score_valid")]
        if len(valid) >= 2 and (best is None or len(valid) > best[1]):
            best = (h["hod_id"], len(valid), pop, valid)
    s.check("the fixture has a HOD scope with at least two valid 360s", best is not None, best and best[1])
    HOD, _nv, POP, VALID = best
    HODU = dict(db.execute("SELECT * FROM users WHERE id=?", (HOD,)).fetchone())
    # a clean scope on this fresh copy: the fixture may already hold a locked HOD session with moves in it
    db.execute("DELETE FROM calibration_adjustments WHERE session_id IN (SELECT id FROM calibration_sessions "
               "WHERE cycle_id=? AND tier='hod' AND scope_key=?)", (CID, str(HOD)))
    db.execute("DELETE FROM calibration_sessions WHERE cycle_id=? AND tier='hod' AND scope_key=?", (CID, str(HOD)))
    db.commit()
    P1, P2 = dict(VALID[0]), dict(VALID[1])

_real_tier, _real_on = a.calibration_tier_of, a._calib_assist_on
a.calibration_tier_of = lambda db, u: [("hod", HOD)] if u["id"] == HOD else []
a._calib_assist_on = lambda u: True


def scope():
    with a.app.test_request_context("/"):
        db = a.get_db()
        return a._pot_calib_scope(db, HODU, fresh=True)


# ---------------------------------------------------------------------------
s.section("the scope and the rows: the classic pages' own reads")
sc = scope()
s.check("the HOD resolves to their department", sc is not None and sc[0] == "hod"
        and {p["id"] for p in sc[2]["population"]} == {p["id"] for p in POP}, sc and sc[0])
with a.app.test_request_context("/"):
    db = a.get_db()
    ov = a._pot_calib_overview(db, HODU, sc)
    r1 = next(r for r in ov["rows"] if r["id"] == P1["id"])
    res1 = a.subject_result(db, db.execute("SELECT * FROM users WHERE id=?", (P1["id"],)).fetchone(), CID)
    band1 = a.subject_band(db, db.execute("SELECT * FROM users WHERE id=?", (P1["id"],)).fetchone(), CID)["band"]
s.check("each row's potential score is combined_potential's, out of its own maximum",
        r1["score"] == a._pot_shown(res1.get("combined") or {})[0]
        and r1["score_max"] == a._fig1((res1.get("combined") or {}).get("max")),
        (r1["score"], (res1.get("combined") or {}).get("score")))
s.check("...and at HOD the band they come in with is the computed band (subject_band)",
        r1["incoming_band"] == band1 == r1["current_band"], (r1["incoming_band"], band1))
s.check("the framework is 15-70-15 over Low / Mid / High", ov["band_order"] == ["Low", "Mid", "High"]
        and ov["target"] == {"Low": 15, "Mid": 70, "High": 15} and ov["axis"] == "potential", ov["target"])
s.check("the lock goes to the classic HOD lock route", ov["lock_url"].endswith("/calibration/hod/%d/lock" % HOD),
        ov["lock_url"])

# ---------------------------------------------------------------------------
s.section("the move: the classic routes' checks, their writer")
with a.app.test_request_context("/"):
    db = a.get_db()
    _, e_self = a._pot_calib_apply(db, dict(P1), sc, P1["id"], "High", "mine")
    _, e_band = a._pot_calib_apply(db, HODU, sc, P1["id"], "Stellar", "x")
    _, e_out = a._pot_calib_apply(db, HODU, sc, 99990001, "High", "x")
    new = "Low" if band1 != "Low" else "Mid"
    subj, e_ok = a._pot_calib_apply(db, HODU, sc, P1["id"], new.lower(), "Their own reason")
    adj = db.execute("SELECT ca.* FROM calibration_adjustments ca JOIN calibration_sessions cs ON cs.id=ca.session_id "
                     "WHERE cs.cycle_id=? AND cs.tier='hod' AND cs.scope_key=? AND ca.subject_id=?",
                     (CID, str(HOD), P1["id"])).fetchone()
s.check("nobody calibrates their own band", e_self and "own band" in e_self, e_self)
s.check("only Low / Mid / High", e_band is not None, e_band)
s.check("never someone outside the scope", e_out is not None, e_out)
s.check("a valid move writes the adjustment, band case-normalised, the original = the band they came in with",
        e_ok is None and adj and adj["adjusted_band"] == new and adj["original_band"] == (band1 or ""), dict(adj) if adj else e_ok)
sc = scope()
with a.app.test_request_context("/"):
    ov2 = a._pot_calib_overview(a.get_db(), HODU, sc)
    r1b = next(r for r in ov2["rows"] if r["id"] == P1["id"])
s.check("...and the card shows them moved", r1b["current_band"] == new and r1b["adjusted"], (r1b["current_band"],))
with a.app.test_request_context("/"):
    t = a._pot_calib_run_tool(a.get_db(), HODU, sc, {"tool": "move_band", "args": {
        "subject": P2["full_name"], "band": "Mid", "justification": "Steady across every principle"}})
s.check("the chat's move_band resolves the NAME in scope and goes through the same write", t.get("ok") is True, t)
with a.app.test_request_context("/"):
    lk = a._pot_calib_run_tool(a.get_db(), HODU, scope(), {"tool": "prepare_lock", "args": {}})
s.check("prepare_lock shows the Lock card (the model never locks)",
        lk.get("render", {}).get("type") == "calib_lock" and lk["render"]["data"]["axis"] == "potential", lk.get("render", {}).get("type"))

# ---------------------------------------------------------------------------
s.section("the AI insight: anonymised themes, never who / how many / a band")
with a.app.test_request_context("/"):
    db = a.get_db()
    subj1 = db.execute("SELECT * FROM users WHERE id=?", (P1["id"],)).fetchone()
    st, first, src, extra, facts = a._pot_summary_source(db, subj1, CID)
    panel = [r["n"] for r in db.execute(
        "SELECT u.full_name n FROM assignments x JOIN users u ON u.id=x.assessor_id WHERE x.subject_id=? AND x.cycle_id=? "
        "AND x.status='submitted' AND x.archived=0", (P1["id"], CID)).fetchall()]
s.check("a valid 360 is summarised", st == "ok" and src, st)
s.check("...and NO rater's name reaches the source", not any(n and n in src for n in panel), [n for n in panel if n in src])
s.check("...no relationship word and no count or share in the per-principle lines",
        not any(w in src.lower() for w in ("line_manager", "direct_report", "matrix_manager"))
        and "raters' view -- " in src, src[:200])
s.check("the checker refuses a number", bool(a._pot_summary_error(src, extra, "%s was rated well by 3 raters." % first)))
s.check("...who said it", bool(a._pot_summary_error(src, extra, "A peer said %s is strong on delivery." % first)))
s.check("...a band", bool(a._pot_summary_error(src, extra, "%s looks like a high potential band." % first)))
with a.app.test_request_context("/"):
    db = a.get_db()
    lowest = db.execute("SELECT u.* FROM users u WHERE u.role!='admin' AND u.id NOT IN (SELECT subject_id FROM "
                        "assignments WHERE cycle_id=? AND status='submitted') LIMIT 1", (CID,)).fetchone()
    stt, *_r = a._pot_summary_source(db, lowest, CID)
    thin = a._pot_summary_plain("X", {"valid": False, "raters": 0, "min_valid": 4})
s.check("below the 360 threshold there is no insight to write (status 'thin')", stt == "thin", stt)
s.check("...and the plain line says so, with no themes", "Not enough 360 feedback" in thin, thin)

# ---------------------------------------------------------------------------
s.section("the route: re-derived scope, never yourself, its own cache")
cH = H.client_as(a, HOD)
r_in = cH.post("/review/team/pot-summary", data={"csrf_token": "tok", "report": P2["id"]})
j = r_in.get_json() or {}
s.check("someone in your scope gets an insight (plain when the model is off)", r_in.status_code == 200 and j.get("summary"),
        (r_in.status_code, j))
s.check("...cached once per person per cycle (viewer-independent: no tier notes in it)",
        H.one(a, "SELECT COUNT(*) FROM pot_calib_summaries WHERE subject_id=? AND cycle_id=?", (P2["id"], CID)) == 1)
r_out = cH.post("/review/team/pot-summary", data={"csrf_token": "tok", "report": 99990001})
s.check("outside your scope: 404", r_out.status_code == 404, r_out.status_code)
r_self = H.client_as(a, P1["id"]).post("/review/team/pot-summary", data={"csrf_token": "tok", "report": P1["id"]})
s.check("your own record: 404", r_self.status_code == 404, r_self.status_code)

# ---------------------------------------------------------------------------
s.section("the privacy fixes that came with it")
with a.app.test_request_context("/"):
    db = a.get_db()
    tsub = db.execute("SELECT a.subject_id FROM tc_assignments a WHERE a.cycle_id=? GROUP BY a.subject_id LIMIT 1",
                      (CID,)).fetchone()
    if tsub:
        sid = tsub[0]
        db.execute("DELETE FROM tc_assessments WHERE cycle_id=? AND subject_id=?", (CID, sid))
        db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status, overall_remark, manager_overall_remark) "
                   "VALUES (?,?, 'pending', 'half a draft', 'manager draft')", (CID, sid))
        db.commit()
        tsu = db.execute("SELECT * FROM users WHERE id=?", (sid,)).fetchone()
        e1 = a._calib_tc_evidence(db, tsu, CID)
        db.execute("UPDATE tc_assessments SET status='submitted' WHERE cycle_id=? AND subject_id=?", (CID, sid)); db.commit()
        e2 = a._calib_tc_evidence(db, tsu, CID)
        db.execute("UPDATE tc_assessments SET status='reviewed' WHERE cycle_id=? AND subject_id=?", (CID, sid)); db.commit()
        e3 = a._calib_tc_evidence(db, tsu, CID)
if tsub:
    s.check("a DRAFT competency remark no longer reaches the calibration room",
            e1["overall_remark"] == "" and e1["manager_overall_remark"] == "", (e1["overall_remark"], e1["manager_overall_remark"]))
    s.check("...their own remark shows once submitted, the manager's only once reviewed",
            e2["overall_remark"] == "half a draft" and e2["manager_overall_remark"] == ""
            and e3["manager_overall_remark"] == "manager draft", (e2["manager_overall_remark"], e3["manager_overall_remark"]))
s.check("per-principle comments are ordered by their TEXT, never the rater's name",
        "ORDER BY cc.comment" in inspect.getsource(a.statement_agreement)
        and "ORDER BY u.full_name" not in inspect.getsource(a.statement_agreement))

# ---------------------------------------------------------------------------
s.section("wiring: the journey tab, the lock's way back, the client")
for fn in ("calibration_hod_lock", "calibration_company_lock", "calibration_bg_lock"):
    s.check("%s returns to the journey when locked from there" % fn,
            "_pot_calib_back(" in inspect.getsource(getattr(a, fn)))
_src = H.source(a)
s.check("the Potential tab follows Performance in a leader view's parts (Dept / BU, 2026-09-30)",
        "(_journey_calib_stage(tier), _pot_calib_stage(tier))" in _src)
s.check("...its own thread, tools and prompt",
        'stage in ("calibration", "calibration_pot")' in _src and "_pot_calib_run_tool(db, u, sc, action)" in _src
        and "return _pot_calib_system(db, u, sc)" in _src)
s.check("...and a calibrator who manages nobody still gets their leader view (Mine | Dept)",
        "bool(_pot_calib_scope(db, u, tier=tier))" in inspect.getsource(a._journey_leader_views)
        and "_journey_leader_views(db, u)" in inspect.getsource(a._review_manages))
_js = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "journey_chat.js"),
           encoding="utf-8").read()
s.check("client: the same person-by-person card, on the potential axis (score, raters, its own insight route)",
        'pot = d.axis === "potential"' in _js and '"/review/team/pot-summary"' in _js
        and 'stage === "calibration" || stage === "calibration_pot"' in _js)
s.check("client: the lock card says potential, and carries the BG for a BG CEO lock",
        '(d.axis === "potential" ? "potential" : "performance")' in _js and 'if (d.lock_bg) hid.push(["bg", d.lock_bg]);' in _js)

# ---------------------------------------------------------------------------
# 2026-09-30, Chris: "the potential calibration is missing the ai suggestion function and also the table columns
# didn't have the band movement like the performance calibration".
s.section("the band's journey on the curve: Self -> LM -> [HOD] -> this tier (attach_tier_chain's own reading)")
sc = scope()
with a.app.test_request_context("/"):
    db = a.get_db()
    ov = a._pot_calib_overview(db, HODU, sc)
    bad = []
    for r in ov["rows"]:
        urow = db.execute("SELECT * FROM users WHERE id=?", (r["id"],)).fetchone()
        sb = a.subject_band(db, urow, CID)   # independently: the classic reading of Self and LM
        ch = r.get("chain") or []
        # a potential that isn't final (2026-10-01: both the 360 and the approved competency are needed) shows no LM
        # band, and no Self band until the 360 is in and they've submitted their own answers
        want_lm = sb["band"] if r["pot_final"] else None
        want_self = (sb["self_band"] if (r["pot_final"] or (r["valid"] and r.get("comp_status") in
                                                             ("submitted", "reviewed"))) else None)
        if ([c["tier"] for c in ch] != ["Self", "LM", "HOD"] or ch[0]["band"] != want_self
                or ch[1]["band"] != want_lm or ch[2]["band"] != r["current_band"] or not ch[2].get("own")):
            bad.append((r["name"], ch, sb["self_band"], sb["band"], r["pot_final"]))
s.check("at HOD every row carries Self | LM | HOD(own), Self and LM exactly subject_band()'s self_band / band "
        "where the potential is final (blank where it isn't)", ov["rows"] and not bad, bad[:2])
s.check("...the own column is 'moved' only when it differs from what came in",
        all(r["chain"][-1]["moved"] == (bool(r["adjusted"]) and r["current_band"] != r["incoming_band"]) for r in ov["rows"]))
# The fixture has no REVIEWED competency, so everyone's Self band equals their LM band and the checks above can't tell
# the two apart (a Self/LM swap passed them). Pin the mapping on a row where they differ.
_ch = a._pot_calib_chain({"self_band": "High", "lm_band": "Mid", "current_band": "Low", "adjusted": True,
                          "incoming_band": "Mid", "tier_slots": []}, "hod")
s.check("the chain maps Self to their own answers' band and LM to the reviewed one (a row where they differ)",
        [c["tier"] for c in _ch] == ["Self", "LM", "HOD"] and _ch[0]["band"] == "High" and _ch[1]["band"] == "Mid"
        and _ch[2]["band"] == "Low" and _ch[2]["moved"], _ch)
_chb = a._pot_calib_chain({"self_band": "Mid", "lm_band": "Mid", "current_band": "High", "adjusted": False,
                           "incoming_band": "High", "tier_slots": [{"tier": "HOD", "band": "High", "changed": True}]},
                          "buceo")
s.check("...at BU CEO the HOD column carries the HOD's move, and the own column is BU CEO",
        [c["tier"] for c in _chb] == ["Self", "LM", "HOD", "BU CEO"] and _chb[2] == {"tier": "HOD", "band": "High",
                                                                                     "moved": True, "note": ""}
        and not _chb[3]["moved"], _chb)
_chn = a._pot_calib_chain({"self_band": "Mid", "lm_band": "Mid", "current_band": "Mid", "adjusted": False,
                           "incoming_band": "Mid", "hod_note": "  Kept -- steady year  ",
                           "tier_slots": [{"tier": "HOD", "band": "Mid", "changed": False}]}, "buceo")
s.check("...and a department review's KEPT band carries the HOD's remark, unmoved (2026-09-30)",
        _chn[2] == {"tier": "HOD", "band": None, "moved": False, "note": "Kept -- steady year"}, _chn)
_chl = a._pot_calib_chain({"self_band": "Mid", "lm_band": "Mid", "current_band": "Low", "adjusted": False,
                           "incoming_band": "Low", "hod_late": "Mid",
                           "tier_slots": [{"tier": "HOD", "band": "Low", "changed": True}]}, "buceo")
s.check("...and an HOD band set before the LM's band came in (and disagreeing) is flagged in that column for the BU "
        "CEO (Chris, 2026-10-02)", _chl[2].get("late") == "Mid" and "late" not in _chb[2], _chl)
# the flag itself (attach_tier_chain): the HOD set Low when nothing final came up ('' seen), the LM's Mid came since
_ha = {"original_band": "", "seen_band": "", "adjusted_band": "Low"}
s.check("...the rule behind it: seen '' and the LM's Mid now -> flagged; seen Mid -> not; agreeing -> not",
        a._calib_late(_ha, "Mid", "Low") == {"now": "Mid", "was": "", "who": "LM"}
        and a._calib_late(dict(_ha, seen_band="Mid"), "Mid", "Low") is None
        and a._calib_late(_ha, "Low", "Low") is None)

s.section("the fit's case: a close call is decided by the line manager's review (synthetic, the fixture can't)")
_pp = [{"id": 1, "name": "A", "band": "Mid", "score": 3.0, "D": 0.0, "mod": 0, "lm_band": "Mid"},
       {"id": 2, "name": "B", "band": "Mid", "score": 3.05, "D": 0.0, "mod": 1, "lm_band": "Mid"},
       {"id": 3, "name": "C", "band": "Mid", "score": 3.4, "D": 0.0, "mod": 0, "lm_band": "Low"}]
_cs = {p["id"]: p["case"] for p in a._pot_calib_fit_case(_pp, "Mid")}
s.check("someone whose competency their line manager moderated DOWN has a weaker case than a peer a hair below them",
        _cs[2] < _cs[1], _cs)
s.check("...and someone sitting a band ABOVE their line manager's review goes first, despite the higher score",
        _cs[3] < _cs[2] and _cs[3] < _cs[1], _cs)
_r = a._pot_calib_fit_reasons(dict(_pp[1], raw=10.7, max=35.0, basis="combined", self_band="High", words=0,
                                   off=0), "down", "Mid", _pp)
s.check("...the reasons say so in words, never a rater, a count or a relationship",
        any("moderated it down" in x and "High" in x for x in _r)
        and not any(w in " ".join(_r).lower() for w in ("rater", "peer", "colleague", "said")), _r)

s.section("the AI fit on the potential curve: preview is write-free, apply writes through _pot_calib_apply")
with a.app.test_request_context("/"):
    db = a.get_db()
    # a clean HOD session, then a person below the 360 threshold (no panel at all) in the same department
    db.execute("DELETE FROM calibration_adjustments WHERE session_id IN (SELECT id FROM calibration_sessions "
               "WHERE cycle_id=? AND tier='hod' AND scope_key=?)", (CID, str(HOD)))
    cols = [c for c in P1.keys() if c != "id"]
    vals = dict(P1, username="zzfit-thin", employee_id="ZZFIT-THIN", full_name="ZZ Fit Thin", email=None)
    db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [vals[c] for c in cols])
    THIN = db.execute("SELECT id FROM users WHERE username='zzfit-thin'").fetchone()[0]
    db.commit()
sc = scope()
with a.app.test_request_context("/"):
    db = a.get_db()
    VAL_IDS = [p["id"] for p in sc[2]["population"]
               if a.subject_result(db, p, CID).get("score_valid") and p["id"] != HOD]
    # everyone with a valid 360 to High: far over the 15% expected there. An HOD's band change needs their remark now
    # (the department review, 2026-09-30) -- and without one it is refused
    _s, e_noremark = a._pot_calib_apply(db, HODU, scope(), VAL_IDS[0], "High" if a.subject_band(
        db, db.execute("SELECT * FROM users WHERE id=?", (VAL_IDS[0],)).fetchone(), CID)["band"] != "High" else "Low", "")
    for pid in VAL_IDS:
        _s, e = a._pot_calib_apply(db, HODU, scope(), pid, "High", "Set High for the fit test")
    _s, e_thin = a._pot_calib_apply(db, HODU, scope(), THIN, "Mid", "Set Mid for the fit test")
    # the remarks were only the setup's ticket in: blank them, so the fit's own note is what gets written below
    db.execute("UPDATE calibration_adjustments SET justification='' WHERE session_id IN (SELECT id FROM "
               "calibration_sessions WHERE cycle_id=? AND tier='hod' AND scope_key=?)", (CID, str(HOD)))
    db.commit()
s.check("an HOD's potential band change without a remark is refused (the department review)",
        e_noremark == a.HOD_REMARK_MSG, e_noremark)
s.check("the fixture: the thin person is in the scope, and at least two valid people sit in High",
        THIN in {p["id"] for p in scope()[2]["population"]} and len(VAL_IDS) >= 2 and e_thin is None,
        (len(VAL_IDS), e_thin))


def adj_snapshot():
    return [dict(r) for r in H.rows(a, "SELECT ca.subject_id, ca.adjusted_band, ca.justification FROM "
                                       "calibration_adjustments ca JOIN calibration_sessions cs ON cs.id=ca.session_id "
                                       "WHERE cs.cycle_id=? AND cs.tier='hod' AND cs.scope_key=? ORDER BY ca.subject_id",
                                       (CID, str(HOD)))]


before = adj_snapshot()
# The fit is a BU CEO's and BG CEO's now: an HOD does a department review, with no curve to fit (2026-09-30). The route
# refuses it here; the fit ENGINE is exercised directly on this scope (the same code a BU CEO's route runs).
r_hod = cH.post("/review/team/calib-fit", data={"csrf_token": "tok", "stage": "calibration_pot", "mode": "preview"})
s.check("the HOD's fit route is refused -- a department review has no curve",
        (r_hod.get_json() or {}).get("ok") is False and "no curve" in ((r_hod.get_json() or {}).get("error") or ""),
        r_hod.get_json())
with a.app.test_request_context("/"):
    jp = dict(ok=True, **a._pot_calib_fit_moves(a.get_db(), HODU, scope()))
s.check("preview: ok, with moves, and they bring every band within the rule",
        jp.get("ok") and jp.get("moves") and jp.get("within_after"), jp)
s.check("...and writes NOTHING", adj_snapshot() == before)
mv = jp.get("moves") or []
# everyone starts in High, so Low can only be filled by moving someone twice -- the shared loop allows that ONLY when
# the curve can't be met otherwise, and shows it as one move (High -> Low); a jump anywhere else would be a defect
s.check("...every move is out of High, one band down -- or High -> Low where Low can only be filled that way",
        mv and all(m["from"] == "High" and m["to"] in ("Mid", "Low") for m in mv)
        and sum(1 for m in mv if m["to"] == "Low") <= round(0.15 * sum(1 for _ in VAL_IDS)) + 1,
        [(m["from"], m["to"]) for m in mv][:6])
s.check("...never the calibrator, never the person below the 360 threshold",
        not any(m["id"] in (HOD, THIN) for m in mv), [m["id"] for m in mv])
s.check("...who is named as held back, with the potential wording on the card",
        "ZZ Fit Thin" in (jp.get("unscored") or []), jp.get("unscored"))
_why = " ".join(" ".join(m.get("reasons") or []) for m in mv).lower()
s.check("...the reasons never say who rated them, how many, or which relationship (360 anonymity)",
        _why and not any(w in _why for w in ("rater", "peer", "direct report", "matrix", "colleague", "said")), _why[:300])

# the first move, against an INDEPENDENT ranking built from the raw reads: pct of max x5, the band their line
# manager's review gave (subject_band), the competency moderation (self_band vs band), a submitted remark
with a.app.test_request_context("/"):
    db = a.get_db()
    ORD = ["Low", "Mid", "High"]

    def case_of(pid, band):
        urow = db.execute("SELECT * FROM users WHERE id=?", (pid,)).fetchone()
        res = a.subject_result(db, urow, CID)
        sb = a.subject_band(db, urow, CID)
        sc5 = 5.0 * min(1.0, (res.get("combined") or {}).get("score") / res["max_score"])
        off = ORD.index(band) - ORD.index(sb["band"]) if sb["band"] in ORD else 0
        mod = ORD.index(sb["self_band"]) - ORD.index(sb["band"]) if sb["self_band"] in ORD and sb["band"] in ORD else 0
        rm = db.execute("SELECT status, overall_remark FROM tc_assessments WHERE cycle_id=? AND subject_id=?",
                        (CID, pid)).fetchone()
        words = len(((rm["overall_remark"] or "") if rm and rm["status"] in ("submitted", "reviewed") else "").split())
        return (sc5 + (0.25 if words >= 20 else 0.1 if words else 0.0) + (-0.2 if mod > 0 else 0.2 if mod < 0 else 0.0)
                - off, sc5, urow["full_name"])
    ranked = sorted(VAL_IDS, key=lambda pid: case_of(pid, "High"))
s.check("the first move takes the WEAKEST case out of High (an independent ranking of the same inputs)",
        mv and mv[0]["from"] == "High" and mv[0]["id"] == ranked[0],
        (mv[:1], ranked[:3]))

# apply: the moves shown, plus three the server must refuse (stale 'from', the calibrator, below the threshold)
_crafted = mv + [{"id": ranked[-1], "from": "Low", "to": "Mid", "reasons": ["x"]},
                 {"id": HOD, "from": "High", "to": "Low", "reasons": ["x"]},
                 {"id": THIN, "from": "Mid", "to": "Low", "reasons": ["x"]}]
# The fit is never offered in an HOD's department review (its route refuses it); this section drives the fit's own
# mechanics through the HOD fixture scope, whose seeded rows would otherwise read as saved -- and a department review
# saves each person once (2026-10-06, _hod_saved_already), and an HOD's changed band needs their remark, which the fit
# no longer writes for them (2026-10-06: the remark is the calibrator's). So both rules step aside for the two applies
# here only -- a BU CEO, the fit's real seat, has neither rule.
_real_saved, _real_rmk = a._hod_saved_already, a._hod_remark_needed
a._hod_saved_already = lambda *x, **k: False
a._hod_remark_needed = lambda *x, **k: False
with a.app.test_request_context("/"):
    _ap, _sk = a._pot_calib_fit_apply(a.get_db(), HODU, _crafted)
ja = {"ok": True, "applied": len(_ap), "skipped": len(_sk)}
after = {r["subject_id"]: r for r in adj_snapshot()}
s.check("apply writes exactly the shown moves and skips the three crafted ones",
        ja.get("ok") and ja.get("applied") == len(mv) and ja.get("skipped") == 3
        and all(after[m["id"]]["adjusted_band"] == m["to"] for m in mv), (ja.get("applied"), ja.get("skipped")))
s.check("...the person below the threshold and the stale one are where they were",
        after[THIN]["adjusted_band"] == "Mid" and (after[ranked[-1]]["adjusted_band"] == "High"
                                                   or ranked[-1] in {m["id"] for m in mv}), (after[THIN]["adjusted_band"],))
s.check("...and no written move carries an AI note: the remark is the calibrator's to write (Chris, 2026-10-06: 'it "
        "shouldn't populate the remark and leave it for the BUCEO to fill')",
        not any("AI suggestion" in (after[m["id"]]["justification"] or "") for m in mv))
with a.app.test_request_context("/"):
    ov3 = a._pot_calib_overview(a.get_db(), HODU, scope())
s.check("...and the curve is now within the rule", not ov3["breaches"], ov3["breaches"])
with a.app.test_request_context("/"):
    _ap2, _sk2 = a._pot_calib_fit_apply(a.get_db(), HODU, mv)
a._hod_saved_already, a._hod_remark_needed = _real_saved, _real_rmk
s.check("re-applying the same (now stale) moves writes nothing", len(_ap2) == 0
        and {r["subject_id"]: r["adjusted_band"] for r in adj_snapshot()} == {k: v["adjusted_band"] for k, v in after.items()})
r_pm = cH.post("/review/team/calib-fit", data={"csrf_token": "tok", "mode": "preview"})
s.check("no stage is still the PERFORMANCE fit (its own scope and message)",
        "potential" not in ((r_pm.get_json() or {}).get("error") or "") and "_pot_calib_fit_route(db, u)"
        in inspect.getsource(a.review_team_calib_fit), (r_pm.status_code, r_pm.get_json()))

s.section("a BU CEO sees the HOD's locked move in its own column")
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("UPDATE calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE cycle_id=? AND tier='hod' "
               "AND scope_key=?", (CID, str(HOD)))
    # the HOD's own remark on the people the fit moved (it writes none, 2026-10-06): what the BU CEO's chain carries
    db.execute("UPDATE calibration_adjustments SET justification='Ready for more, from the HOD.' WHERE subject_id IN "
               "(%s) AND session_id=(SELECT id FROM calibration_sessions WHERE cycle_id=? AND tier='hod' AND scope_key=?)"
               % ",".join("?" * len(mv)), [m["id"] for m in mv] + [CID, str(HOD)])
    db.commit()
with a.app.test_request_context("/"):
    db = a.get_db()
    BG_, CO_ = P1["business_group"], P1["company"]
    BUU = db.execute("SELECT * FROM users WHERE business_group=? AND company=? AND role!='admin' AND id NOT IN (%s) "
                     "LIMIT 1" % ",".join(str(p["id"]) for p in POP + [HODU]), (BG_, CO_)).fetchone() \
        or db.execute("SELECT * FROM users WHERE role!='admin' AND id NOT IN (%s) LIMIT 1"
                      % ",".join(str(p["id"]) for p in POP + [HODU])).fetchone()
    BUU = dict(BUU)
a.calibration_tier_of = lambda db, u: ([("hod", HOD)] if u["id"] == HOD
                                       else [("buceo", (BG_, CO_))] if u["id"] == BUU["id"] else [])
with a.app.test_request_context("/"):
    db = a.get_db()
    bsc = a._pot_calib_scope(db, BUU, fresh=True)
    bov = a._pot_calib_overview(db, BUU, bsc)
    hod_locked = {r["subject_id"]: r["adjusted_band"] for r in adj_snapshot()}
    bad = []
    for r in bov["rows"]:
        urow = db.execute("SELECT * FROM users WHERE id=?", (r["id"],)).fetchone()
        lm = a.subject_band(db, urow, CID)["band"]
        hb = hod_locked.get(r["id"]) if urow["hod_id"] == HOD else None
        want_moved = bool(hb) and hb != lm
        ch = r["chain"]
        # the HOD's band whenever they have a row, kept or moved -- as on performance (2026-10-07: a kept band used to
        # come through as None, a dash); None only when they recorded nothing
        if ([c["tier"] for c in ch] != ["Self", "LM", "HOD", "BU CEO"] or ch[2]["moved"] != want_moved
                or ch[2]["band"] != (hb or None)):
            bad.append((r["name"], ch, hb, lm))
s.check("at BU CEO: Self | LM | HOD | BU CEO(own); the HOD's band whenever they have a row (kept or moved), flagged as "
        "moved exactly where its locked move differs",
        bsc and bsc[0] == "buceo" and bov["rows"] and not bad, bad[:2])
s.check("...and at least one row shows a band the HOD KEPT (not vacuous)",
        any(not r["chain"][2]["moved"] and r["chain"][2]["band"] for r in bov["rows"]))
s.check("...and at least one row actually shows an HOD move (not vacuous)",
        any(r["chain"][2]["moved"] for r in bov["rows"]))
s.check("...and the HOD's remark rides on its column (what the BU CEO reads)",
        any(r["chain"][2].get("note") for r in bov["rows"] if r["chain"][2]["moved"]))
# the fit route at the BU CEO's seat: it answers, and a locked scope refuses it
cB = H.client_as(a, BUU["id"])
r_bu = cB.post("/review/team/calib-fit", data={"csrf_token": "tok", "stage": "calibration_pot", "mode": "preview"})
s.check("the fit route answers at a BU CEO's seat", (r_bu.get_json() or {}).get("ok") is True, r_bu.get_json())
with a.app.test_request_context("/"):
    db = a.get_db()
    _bkey = bsc[2]["scope_key"]
    _bs = a._get_or_create_calibration_session(db, CID, "buceo", _bkey, BG_, "test")
    db.execute("UPDATE calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE id=?", (_bs["id"],))
    db.commit()
r_lk = cB.post("/review/team/calib-fit", data={"csrf_token": "tok", "stage": "calibration_pot", "mode": "preview"})
s.check("a locked scope refuses the fit", (r_lk.get_json() or {}).get("ok") is False
        and "locked" in ((r_lk.get_json() or {}).get("error") or ""), r_lk.get_json())
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("DELETE FROM calibration_adjustments WHERE session_id=?", (_bs["id"],))
    db.execute("DELETE FROM calibration_sessions WHERE id=?", (_bs["id"],))
    db.commit()

s.section("client: the potential curve has the fit and the band's journey")
_js = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "journey_chat.js"),
           encoding="utf-8").read()
s.check("client: the fit button and chip are no longer performance-only",
        'if (d.axis !== "potential" && !d.locked)' not in _js
        and 'if (!pot) out.push({ label: "Fit the curve with AI"' not in _js and 'label: "Fit the curve with AI"' in _js)
s.check("client: the preview and the apply both post the stage", _js.count('f.append("stage", stage)') >= 3
        and 'f.append("mode", "preview"); f.append("stage", stage);' in _js
        and 'f.append("mode", "apply"); f.append("stage", stage);' in _js)
s.check("client: the roster draws the chain on both axes (potential's score where performance has Justified?)",
        'var chainHead = (rows[0] && rows[0].chain)' in _js and 'head += pot ? "<th class=\\"rv-cal-thj is-pot\\">Potential score</th>" : "<th class=\\"rv-cal-thj\\">Justified?</th>";' in _js)
s.check("client: the fit dialog says what the potential suggestion is based on",
        "potential score (their 360 and the competency their line manager reviewed)" in _js)

# ---------------------------------------------------------------------------
s.section("the potential score is the 360 + the approved competency, wherever it is shown (2026-10-01)")
# Chris: "the average score for potential should be 360 leadership principle +competency". The band always was; the
# classic pages' "Potential Score" column showed the 360 average alone. P1 gets an approved competency (synthetic --
# the fixture may hold none), weighted 40:60; P2 has none, so stays the 360 alone, said so.
_real_tcr, _real_tw = a.tc_reviewed_score, a.tc_weights_for
with a.app.test_request_context("/"):
    db = a.get_db()
    _r1 = a.subject_result(db, P1, CID)
    _p360 = _r1["avg_score"] / _r1["max_score"] * 100
    _tech = 1.0 if _p360 > 50 else 9.0          # a competency share well away from the 360's, so the two differ
a.tc_reviewed_score = lambda db, sid, cid: (_tech, _tech, 10.0) if sid == P1["id"] else (None, None, None)
a.tc_weights_for = lambda db, jg: (40.0, 60.0)
try:
    with a.app.test_request_context("/"):
        db = a.get_db()
        rows = a._calibration_rows(db, POP, CID, a.subject_band, None)
        by = {r["user"]["id"]: r for r in rows}
        s.check("classic rows: everyone's score is the combined potential score",
                all(r["avg_score"] == a._pot_shown(a.subject_result(db, r["user"], CID).get("combined") or {})[0]
                    for r in rows))
        r1, res1 = by[P1["id"]], a.subject_result(db, P1, CID)
        _T = res1["max_score"] + 10.0   # the total of both maxima (Chris, 2026-10-01: "out of 30.0 (the sum)")
        _c3, _ct = _p360 * 0.4 / 100 * _T, (_tech / 10.0 * 100) * 0.6 / 100 * _T   # the admin's 40:60, on that total
        exp = _c3 + _ct
        s.check("...competency approved: each half's share times its admin weight, added on the total of both maxima "
                "-- not the 360 alone", r1["pot_basis"] == "combined"
                and r1["avg_score"] == a._fig1(a._fig1(_c3) + a._fig1(_ct))
                and abs(r1["max_score"] - _T) < 1e-6, (r1["avg_score"], exp, r1["max_score"]))
        s.check("...and the band reads that sum at the same share of its total (the 360-scale cut-offs keep meaning)",
                res1["band"] == a.potential_band(exp / _T * res1["max_score"], a.thresholds_for_cycle(db, CID)))
        r2 = by[P2["id"]]
        s.check("...no approved competency: the 360 alone, marked 360_only",
                r2["pot_basis"] == "360_only" and r2["avg_score"] == a._fig1(a.subject_result(db, P2, CID)["avg_score"]))
        s.check("...the rows carry the admin's weights, each half's points and what it adds (its weight's slice of the "
                "total)", r1["w_360"] == 40.0 and r1["w_tech"] == 60.0 and r1["pts_tech"] == _tech
                and r1["max_tech"] == 10.0 and r1["pts_360"] == a._fig1(res1["avg_score"])
                and r1["c_360_max"] == a._fig1(0.4 * _T) and r1["c_tech_max"] == a._fig1(0.6 * _T))
        s.check("...and the shown parts add up to the shown score (one rounding, half up -- 26.25 + 1.0 read 27.2 once)",
                abs(r1["avg_score"] - (r1["c_360"] + r1["c_tech"])) < 1e-9
                and a._fig1(26.25) == 26.3 and a._fig1(27.25) == 27.3, (r1["avg_score"], r1["c_360"], r1["c_tech"]))
        ov = a._pot_calib_overview(db, HODU, scope())
        pp = {p["id"]: p for p in ov["rows"]}
        s.check("the chat roster: the same basis and weights",
                pp[P1["id"]]["basis"] == "combined" and pp[P1["id"]]["w_tech"] == 60.0
                and pp[P1["id"]]["score_max"] == a._fig1(_T)
                and pp[P2["id"]]["basis"] == "360_only")
        sc_ = scope()
        sysp = a._dept_review_system(db, HODU, sc_[2], journey=True, axis="pot", sc=sc_)
        s.check("the agent knows whether the competency is in each score, and who isn't final (Low by default)",
                '"includes_competency": true' in sysp and '"includes_competency": false' in sysp
                and '"not_finalised_low_by_default": true' in sysp and "not_finalised_low_by_default=true" in sysp)
    html = cH.get("/calibration/hod/%d" % HOD).get_data(as_text=True)
    s.check("the classic HOD page: the breakdown on hover and a 360 only tag",
            ("+ competency %.1f of %g (weighted 40:60)" % (a._fig1(_ct), a._fig1(0.6 * _T))) in html
            and "calib-pot-basis" in html
            and "360 only: competency not reviewed yet" in html, html[:200] if "calib-table" not in html else "")
finally:
    a.tc_reviewed_score, a.tc_weights_for = _real_tcr, _real_tw
s.check("client: the roster marks a 360-only score (a * on the score's line since 2026-10-06, not a tag under it) and "
        "gives the breakdown on hover; an older stored card keeps its tag",
        "function potBasisText(r)" in _js and 'tagHost.appendChild(rmkEl("span", "rv-pot-basis", "360 only"))' in _js
        and 'pin.appendChild(calMark("basis", bt || ' in _js and _js.count("potBasisMark(") >= 2)

# ---------------------------------------------------------------------------
s.section("the potential review needs both halves; Self = 360 + their own submitted answers (2026-10-01)")
# Chris: "for potential review table, add in competency + 360 scores. only show score if both are filled, if not deemed
# as not finalized - default to low, and HOD can assign a band" -- and: "For self, it will use self-rated competency +
# 360 score; LM band = LM-rated competency + 360 score". Real competency rows on this fresh copy: P1 approved by the
# line manager (who moderated the next level down), P2 submitted but not approved, a third (if any) still a draft.
_P3 = dict(VALID[2]) if len(VALID) > 2 else None
with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("DELETE FROM calibration_adjustments WHERE session_id IN (SELECT id FROM calibration_sessions "
               "WHERE cycle_id=? AND tier='hod' AND scope_key=?)", (CID, str(HOD)))
    db.execute("DELETE FROM calibration_sessions WHERE cycle_id=? AND tier='hod' AND scope_key=?", (CID, str(HOD)))
    db.execute("INSERT OR IGNORE INTO tc_skills(skill_code, title, skill_category) VALUES "
               "('ZZPOTR-1','ZZ Pot Skill A','ZZ'), ('ZZPOTR-2','ZZ Pot Skill B','ZZ')")
    _sk = [r["id"] for r in db.execute("SELECT id FROM tc_skills WHERE skill_code LIKE 'ZZPOTR-%' ORDER BY skill_code")]

    def _mk(sid, status, mine, lm=(None, None)):
        db.execute("DELETE FROM tc_assessments WHERE cycle_id=? AND subject_id=?", (CID, sid))
        db.execute("DELETE FROM tc_assignments WHERE cycle_id=? AND subject_id=?", (CID, sid))
        asg = [db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future) VALUES (?,?,?,?)",
                          (CID, sid, k, i)).lastrowid for i, k in enumerate(_sk)]   # current level, next level
        asid = db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?,?)",
                          (CID, sid, status)).lastrowid
        for i, aid in enumerate(asg):
            db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer, manager_answer) VALUES (?,?,?,?)",
                       (asid, aid, mine[i], lm[i]))
    _mk(P1["id"], "reviewed", ("yes", "yes"), (None, "no"))   # self 2.5 / 2.5; the LM's call 1.0 / 2.5
    _mk(P2["id"], "submitted", ("yes", "yes"))                 # self 2.5 / 2.5, not approved
    if _P3:
        _mk(_P3["id"], "pending", ("yes", "yes"))              # a draft: private, never read
    db.commit()
try:
    with a.app.test_request_context("/"):
        db = a.get_db()
        _s1, _s2 = a.subject_result(db, P1, CID), a.subject_result(db, P2, CID)
        c1, c2 = _s1["combined"], _s2["combined"]
        def _bl(sr, tech, tmx, jg):   # the admin's weight for the grade, applied to each share, on both maxima
            w3, wt = a.tc_weights_for(db, jg)
            T = sr["max_score"] + tmx
            return (sr["avg_score"] / sr["max_score"] * w3 / 100 + tech / tmx * wt / 100) * T, T
        _lm1, _T1 = _bl(_s1, 1.0, 2.5, P1["job_grade"])
        s.check("LM = the 360 and the competency as the line manager approved it (1.0 of 2.5), weighted by the grade's "
                "admin split, out of both maxima", c1["source"] == "combined" and abs(c1["score"] - _lm1) < 1e-6
                and abs(c1["max"] - _T1) < 1e-6, (c1["score"], _lm1, c1["max"]))
        s.check("Self = the same with their OWN answers (2.5 of 2.5), for an approved assessment",
                abs(c1["self_score"] - _bl(_s1, 2.5, 2.5, P1["job_grade"])[0]) < 1e-6)
        s.check("...and the competency's two figures are kept: theirs and the line manager's",
                c1["tech_self"] == 2.5 and c1["pts_tech"] == 1.0 and c1["tech_self_max"] == 2.5)
        _ss2, _T2 = _bl(_s2, 2.5, 2.5, P2["job_grade"])
        s.check("...and for one submitted but not approved yet: Self is 360 + their own answers, while the LM figure "
                "stays the 360 alone",
                c2["source"] == "360_only" and c2["score"] == _s2["avg_score"] and c2["pct_tech_self"] == 100.0
                and abs(c2["self_score"] - _ss2) < 1e-6 and abs(c2["self_max"] - _T2) < 1e-6,
                (c2["self_score"], c2["score"]))
        if _P3:
            _c3 = a.subject_result(db, _P3, CID)["combined"]
            s.check("...a draft is never read: Self stays the 360 alone", _c3["self_score"] == _c3["score"]
                    and _c3["pct_tech_self"] is None)
        ov = a._pot_calib_overview(db, HODU, scope())
        pp = {p["id"]: p for p in ov["rows"]}
        p1, p2 = pp[P1["id"]], pp[P2["id"]]
        _th = a.thresholds_for_cycle(db, CID)
        s.check("the review: both halves in -> final, the 360 and competency figures filled, the band came in",
                p1["pot_final"] and not p1["band_default"] and p1["comp_status"] == "reviewed"
                and abs(p1["comp_pct"] - 40.0) < 1e-6 and p1["incoming_band"] == a.potential_band(c1["band_score"], _th),
                (p1["pot_final"], p1["comp_status"], p1["comp_pct"], p1["incoming_band"]))
        s.check("...competency not approved -> not finalised: Low only by default, nothing came in, and the HOD must set "
                "a band before the review can finish",
                p2["pot_final"] is False and p2["band_default"] and p2["current_band"] == "Low"
                and p2["incoming_band"] is None and p2["comp_status"] == "submitted" and not p2["finalised"]
                and P2["id"] in [x["id"] for x in ov["unassigned"]] and ov["n_default"] >= 1,
                (p2["pot_final"], p2["current_band"], p2["incoming_band"], p2["comp_status"]))
        _ch2 = {c["tier"]: c["band"] for c in p2["chain"]}
        s.check("...its Self band is 360 + their own answers; no LM band (it would be the 360's alone)",
                _ch2["Self"] == a.potential_band(c2["self_band_score"], _th) and _ch2["LM"] is None, _ch2)
        if _P3:
            _ch3 = {c["tier"]: c["band"] for c in pp[_P3["id"]]["chain"]}
            s.check("...a draft: no Self band and no LM band", _ch3["Self"] is None and _ch3["LM"] is None, _ch3)
        sc_ = scope()
        sysp = a._dept_review_system(db, HODU, sc_[2], journey=True, axis="pot", sc=sc_)
        _rost = json.loads(sysp.split("say so if you quote it" if False else "before the review can finish):\n", 1)[1]
                           .split("\n", 1)[0])
        _r2 = next(x for x in _rost if x["name"] == P2["full_name"])
        s.check("the agent's roster: no score and no band for a potential that isn't final, flagged Low by default",
                _r2["potential_score"] is None and _r2["band"] is None and _r2["not_finalised_low_by_default"]
                and _r2["competency_approved"] is False, _r2)
        _raw2 = a.subject_band(db, P2, CID)["band"]
        _sub, _err = a._pot_calib_apply(db, HODU, sc_, P2["id"], _raw2, "")
        s.check("the writer: nothing came in for them, so even the 360's own band needs the HOD's remark",
                _sub is None and _err == a.HOD_REMARK_MSG, (_raw2, _err))
        _sub, _err = a._pot_calib_apply(db, HODU, sc_, P2["id"], "Mid",
                                        "Their competency isn't approved yet; Mid from what I see day to day.")
        db.commit()
        _adj = db.execute("SELECT original_band, adjusted_band FROM calibration_adjustments WHERE subject_id=? AND "
                          "session_id IN (SELECT id FROM calibration_sessions WHERE cycle_id=? AND tier='hod' AND "
                          "scope_key=?)", (P2["id"], CID, str(HOD))).fetchone()
        p2b = {p["id"]: p for p in a._pot_calib_overview(db, HODU, scope())["rows"]}[P2["id"]]
        s.check("...with a remark it saves, recorded as set (nothing came in), and they're no longer waiting",
                _err is None and _adj and _adj["original_band"] == "" and _adj["adjusted_band"] == "Mid"
                and p2b["current_band"] == "Mid" and not p2b["band_default"], (_err, dict(_adj) if _adj else None))
    _jg = str(P1["job_grade"]).strip()
    _sup = H.actors(a)[0]
    with a.app.test_request_context("/"):
        _w_before = a.tc_weights_for(a.get_db(), _jg)
    _rw = H.client_as(a, _sup["id"]).post("/admin/settings", data={"csrf_token": "tok", "action": "band_weights", "remark": "ZZ test remark",
                                                                   "w360_" + _jg: "30"})
    with a.app.test_request_context("/"):
        db = a.get_db()
        _c1w = a.subject_result(db, P1, CID)["combined"]
        _exp_w = (_c1w["pct_360"] * 30 / 100 + 40.0 * 70 / 100) / 100 * _c1w["max"]   # LM 1.0 / 2.5 = 40%
    s.check("the weighting is Admin -> Settings': saving 30:70 for their grade changes the score to match",
            _rw.status_code in (302, 303) and _c1w["w_360"] == 30.0 and _c1w["w_tech"] == 70.0
            and abs(_c1w["score"] - _exp_w) < 1e-6, (_rw.status_code, _c1w["w_360"], _c1w["score"], _exp_w))
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("UPDATE tc_band_weights SET w_360=?, w_tech=? WHERE job_grade=?", (_w_before[0], _w_before[1], _jg))
        db.commit()
    with a.app.test_request_context("/"):
        db = a.get_db()
        a._rating_record_refresh(db, CID, [P1["id"]], "test")
        db.commit()
        _rr = db.execute("SELECT pot_score, pot_max FROM rating_records WHERE cycle_id=? AND subject_id=?",
                         (CID, P1["id"])).fetchone()
        _c1 = a.subject_result(db, P1, CID)["combined"]
    s.check("the rating record keeps the summed score with its own maximum (pot_max), not the 360's",
            _rr and abs(_rr["pot_score"] - _c1["score"]) < 1e-6 and abs(_rr["pot_max"] - _c1["max"]) < 1e-6,
            dict(_rr) if _rr else None)
finally:
    pass
s.check("client: no separate 360 / Competency columns (Chris, 2026-10-01: 'we dont need the 2 columns'); the Potential "
        "cell carries the sum and its parts, the person page the breakdown (no 'Weights from Admin' line), the AI insight one line (360 + Competency = Potential); 'Not final', Low by default",
        "rv-cal-th3" not in _js and "potPart360" not in _js and "potSubLine" not in _js
        and "function potJourney(d, r, review)" in _js
        and "card.appendChild(pot ? potJourney(d, r, review) : perfJourney(d, r, review));" in _js
        and 'if (kind === "calp" && info.row) wrap.appendChild(potLine(info.row));' in _js
        and "function potLine(r)" in _js and 'op("+");' in _js and 'op("=");' in _js
        and "rv-pot-bd-src" not in _js
        and 'if (r.pot_final === false) {' in _js and '"(" + (pot ? "Low" : "UA") + " by default) — choose a band"' in _js
        and "function calNotFinal(r, pot)" in _js)

# ---------------------------------------------------------------------------
s.section("strengths and development areas (2026-10-05): the top / bottom principles of the 360, in words only")


def _shares(db, sid):
    """Independent of _pot_strengths: per principle, the Demonstrate share weighted like the score (a next-level
    behaviour 1.5, the current 1.0) from the raw tallies, and whether every rater said Demonstrate on all of it."""
    subj = db.execute("SELECT * FROM users WHERE id=?", (sid,)).fetchone()
    crits, _n = a.statement_agreement(db, subj, CID)
    out = {}
    for c in crits:
        y = sum(st["yes"] * (1.5 if st["is_future"] else 1.0) for st in c["statements"])
        t = sum(st["total"] * (1.5 if st["is_future"] else 1.0) for st in c["statements"])
        if t:
            out[c["name"]] = (y / t, all(st["yes"] == st["total"] for st in c["statements"]))
    return out


def _sw(sid):
    with a.app.test_request_context("/"):
        db = a.get_db()
        ov = a._pot_calib_overview(db, HODU, scope())
        return next(r for r in ov["rows"] if r["id"] == sid), _shares(db, sid)


_r1, _sh = _sw(P1["id"])
_s1 = _r1.get("strengths") or {}
_top, _bot = _s1.get("top") or [], _s1.get("bottom") or []
s.check("a person with a valid 360 carries their strengths: at most 3 and 3, never the same principle in both (or, "
        "seen the same everywhere, one line instead)",
        _s1 and len(_top) <= 3 and len(_bot) <= 3 and (_top or _s1.get("even"))
        and not ({i["name"] for i in _top} & {i["name"] for i in _bot})
        and {i["name"] for i in _top + _bot} <= set(_sh), (len(_top), len(_bot), _s1.get("even")))
s.check("the ranking is the score's own weighting: every top principle is more strongly seen than every bottom one",
        all(_sh[t["name"]][0] > _sh[b["name"]][0] for t in _top for b in _bot)
        and (not _top or _sh[_top[0]["name"]][0] == max(v[0] for v in _sh.values())),
        [(i["name"], round(_sh[i["name"]][0], 2)) for i in _top + _bot])
s.check("'fully demonstrated' is exactly every rater saying Demonstrate on every behaviour of it",
        all(i["full"] == _sh[i["name"]][1] for i in _top + _bot))
s.check("words, never a count or a % (the 360's anonymity)",
        not any(re.search(r"[0-9%]", (i.get("label") or "") + (i.get("note") or "")) for i in _top + _bot)
        and not re.search(r"[0-9%]", ((_s1.get("even") or {}).get("label") or "") + ((_s1.get("even") or {}).get("note") or "")),
        [(i.get("label"), i.get("note")) for i in _top + _bot])
_inval = [p for p in POP if p["id"] not in {v["id"] for v in VALID}]
if _inval:
    _ri, _ = _sw(_inval[0]["id"])
    s.check("below the 360 threshold: no strengths at all", _ri.get("strengths") is None, _ri.get("strengths"))
with a.app.test_request_context("/"):
    db = a.get_db()
    _rows = a._pot_calib_rows(db, scope()[2])
    _skip = a._pot_strengths(db, _rows, CID, skip=P1["id"])
s.check("never the calibrator's own row", P1["id"] not in _skip and P2["id"] in _skip, sorted(_skip)[:4])

# shape P1's answers principle by principle, (current level, next level), then put them back
with a.app.test_request_context("/"):
    db = a.get_db()
    _subj = db.execute("SELECT * FROM users WHERE id=?", (P1["id"],)).fetchone()
    _st = a.statements_for_grade(db, _subj["job_grade"], CID)
    _crit = []
    for x in _st:
        if x["criterion_id"] not in [c[0] for c in _crit]:
            _crit.append((x["criterion_id"], x["criterion_name"]))
    _asg = [r["id"] for r in db.execute("SELECT id FROM assignments WHERE subject_id=? AND cycle_id=? AND "
                                        "status='submitted' AND archived=0", (P1["id"], CID))]
    _q = ",".join("?" * len(_asg))
    _orig = [tuple(r) for r in db.execute("SELECT id, answer FROM responses WHERE assignment_id IN (%s)" % _q, _asg)]


def _shape(pattern):
    """pattern: one (current, next) answer pair per principle, in framework order."""
    with a.app.test_request_context("/"):
        db = a.get_db()
        for (cid_, _nm), pair in zip(_crit, pattern):
            for fut, ans in ((False, pair[0]), (True, pair[1])):
                ids = [x["statement_id"] for x in _st if x["criterion_id"] == cid_ and bool(x["is_future"]) == fut]
                db.execute("UPDATE responses SET answer=? WHERE assignment_id IN (%s) AND statement_id IN (%s)"
                           % (_q, ",".join("?" * len(ids))), [ans] + _asg + ids)
        db.commit()
    return _sw(P1["id"])[0]["strengths"]


_N = len(_crit)
_YY, _YN, _NN = ("yes", "yes"), ("yes", "no"), ("no", "no")
try:
    # every principle Demonstrated, except the 2nd (nothing) and 3rd (the current level only)
    _s1 = _shape([_YY, _NN, _YN] + [_YY] * (_N - 3))
    _top, _bot, _lt = _s1["top"], _s1["bottom"], _s1["letter"]
    s.check("ties among the fully demonstrated go to framework order: the top three are the first three of them",
            [i["name"] for i in _top] == [c[1] for k, c in enumerate(_crit) if k not in (1, 2)][:3]
            and all(i["full"] and i["step"] == 4 for i in _top)
            and _top[0]["label"] == ("Demonstrated" if _lt else "Fully demonstrated"), [(i["name"], i["label"]) for i in _top])
    s.check("the bottom: what nobody saw first, then the next level missing; a fully demonstrated one never shows there",
            [i["name"] for i in _bot] == [_crit[1][1], _crit[2][1]] and not any(i["full"] for i in _bot),
            [i["name"] for i in _bot])
    s.check("a development area says which level is short: the current level the bigger flag, the next level room to grow",
            _bot[0]["gap"] == "current" and _bot[0]["note"].startswith("Current-level behaviour not")
            and _bot[1]["gap"] == "next" and _bot[1]["note"] == ("Next-level behaviour not demonstrated yet" if _lt
                                                                  else "Next-level behaviour not seen yet"),
            [(i["gap"], i["note"]) for i in _bot])
    # two Demonstrated, three the current level only, two nothing: a weakly seen tie runs across the top's third place
    _s1 = _shape([_YY, _YY, _YN, _YN, _YN, _NN, _NN][:_N])
    s.check("a tie across the line that's weakly seen goes to development areas, never to strengths; the weakest first, "
            "ties in framework order, and the rest of the tie counted",
            [i["name"] for i in _s1["top"]] == [_crit[0][1], _crit[1][1]]
            and [i["name"] for i in _s1["bottom"]] == [_crit[5][1], _crit[6][1], _crit[2][1]]
            and _s1["more_same"] == 2 and [i["name"] for i in _s1["more_items"]] == [_crit[3][1], _crit[4][1]]
            and all(i.get("note") for i in _s1["more_items"]),
            ([i["name"] for i in _s1["top"]], [i["name"] for i in _s1["bottom"]], _s1["more_same"]))
    # staging, 2026-10-05: one principle fully demonstrated, the other six all the current level only
    _s1 = _shape([_YY] + [_YN] * (_N - 1))
    s.check("one strong principle and six seen the same, weakly: one strength, the six as development areas (+3 more) "
            "-- never two weak 'strengths' and 'nothing stands out'",
            [i["name"] for i in _s1["top"]] == [_crit[0][1]]
            and [i["name"] for i in _s1["bottom"]] == [c[1] for c in _crit[1:4]] and _s1["more_same"] == _N - 4
            and [i["name"] for i in _s1["more_items"]] == [c[1] for c in _crit[4:]],
            ([i["name"] for i in _s1["top"]], [i["name"] for i in _s1["bottom"]], _s1["more_same"]))
    # the current level on every principle, the next level on none: all the same
    _s1 = _shape([_YN] * _N)
    s.check("seen the same on every principle: no top or bottom, one line with the level that's short",
            _s1["top"] == [] and _s1["bottom"] == [] and _s1.get("even")
            and _s1["even"]["label"] == ("Partly demonstrated" if _lt else "Mixed")
            and _s1["even"]["note"] == ("Next-level behaviour not demonstrated yet" if _lt
                                        else "Next-level behaviour not seen yet"), _s1.get("even"))
    _s1 = _shape([_YY] * _N)
    s.check("everything fully demonstrated: the top three, no development area, and the page says why",
            len(_s1["top"]) == 3 and _s1["bottom"] == [] and not _s1.get("even")
            and _s1["n_full"] == _s1["n"] == _N, (_s1["n_full"], _s1["n"]))
finally:
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.executemany("UPDATE responses SET answer=? WHERE id=?", [(ans, rid) for rid, ans in _orig])
        db.commit()

_r1, _ = _sw(P1["id"])
_r2, _ = _sw(P2["id"])
s.check("the competency their line manager reviewed: fully demonstrated vs still developing, by their call",
        (_r1["strengths"].get("comp") or {}).get("full") == ["ZZ Pot Skill A"]
        and (_r1["strengths"].get("comp") or {}).get("dev") == [{"title": "ZZ Pot Skill B", "level": "next"}],
        _r1["strengths"].get("comp"))
s.check("...and nothing from a competency not reviewed yet: it's said, never shown",
        "comp" not in (_r2.get("strengths") or {}) and (_r2.get("strengths") or {}).get("comp_pending") is True,
        _r2.get("strengths"))
# ---------------------------------------------------------------------------
s.section("what was written (2026-10-05): theirs, their LM's, and for a BU CEO the HOD's -- summarised, then in full")
with a.app.test_request_context("/"):
    db = a.get_db()
    for sid, own, lm in ((P1["id"], "I grew my planning this year and led the cost review.", "Strong on cost work; "
                          "planning still developing."),
                         (P2["id"], "Submitted, waiting on my manager.", "A draft of the manager's remark."),
                         (_P3["id"] if _P3 else None, "My private draft remark.", None)):
        if sid:
            db.execute("UPDATE tc_assessments SET overall_remark=?, manager_overall_remark=?, reviewed_by=? "
                       "WHERE cycle_id=? AND subject_id=?", (own, lm, HOD, CID, sid))
    _p1s = [r["id"] for r in db.execute("SELECT sc.id FROM tc_scores sc JOIN tc_assessments t ON t.id=sc.assessment_id "
                                        "WHERE t.cycle_id=? AND t.subject_id=? ORDER BY sc.id", (CID, P1["id"]))]
    db.execute("UPDATE tc_scores SET remark='Cost reviews every month.' WHERE id=?", (_p1s[0],))
    db.execute("UPDATE tc_scores SET manager_remark='Not yet leading the plan.' WHERE id=?", (_p1s[1],))
    # the HOD's department review: their remark on P1, submitted
    _sess = db.execute("SELECT id, locked_at FROM calibration_sessions WHERE cycle_id=? AND tier='hod' AND scope_key=?",
                       (CID, str(HOD))).fetchone()
    _sid = _sess["id"] if _sess else db.execute(
        "INSERT INTO calibration_sessions(cycle_id, tier, scope_key, business_group) VALUES (?,?,?,?)",
        (CID, "hod", str(HOD), HODU["business_group"])).lastrowid
    _lock0 = _sess["locked_at"] if _sess else None
    _adj0 = db.execute("SELECT * FROM calibration_adjustments WHERE session_id=? AND subject_id=?",
                       (_sid, P1["id"])).fetchone()
    db.execute("DELETE FROM calibration_adjustments WHERE session_id=? AND subject_id=?", (_sid, P1["id"]))
    db.execute("INSERT INTO calibration_adjustments(session_id, subject_id, original_band, adjusted_band, justification) "
               "VALUES (?,?,?,?,?)", (_sid, P1["id"], "High", "Mid", "Steady, but the plan isn't theirs yet."))
    db.commit()
try:
    with a.app.test_request_context("/"):
        db = a.get_db()
        _ppl = [db.execute("SELECT * FROM users WHERE id=?", (x,)).fetchone() for x in
                [P1["id"], P2["id"]] + ([_P3["id"]] if _P3 else [])]
        _e_open_bu = a._pot_remark_entries(db, _ppl, CID, "buceo")
        db.execute("UPDATE calibration_sessions SET locked_at=datetime('now') WHERE id=?", (_sid,)); db.commit()
        _e_hod = a._pot_remark_entries(db, _ppl, CID, "hod")
        _e_bu = a._pot_remark_entries(db, _ppl, CID, "buceo")
    _roles = lambda es: [(e["role"], e["on"] is not None) for e in es]
    s.check("an HOD reads their own remark and their line manager's -- the overall ones and the notes, attributed",
            _roles(_e_hod[P1["id"]]) == [("self", False), ("self", True), ("lm", False), ("lm", True)]
            and _e_hod[P1["id"]][0]["text"].startswith("I grew my planning")
            and _e_hod[P1["id"]][2]["who"].startswith("Their line manager"), _e_hod[P1["id"]])
    s.check("...never the HOD's own remark (they wrote it)", not any(e["role"] == "hod" for e in _e_hod[P1["id"]]))
    s.check("a BU CEO also reads the HOD's, with the move, once the department review is submitted -- not before",
            [e for e in _e_bu[P1["id"]] if e["role"] == "hod"][0]["move"] == "moved High → Mid"
            and [e for e in _e_bu[P1["id"]] if e["role"] == "hod"][0]["text"].startswith("Steady")
            and not any(e["role"] == "hod" for e in _e_open_bu[P1["id"]]), _e_bu[P1["id"]][-1])
    s.check("the line manager's remark only once they've reviewed it: submitted, theirs alone",
            [x for x in _roles(_e_bu[P2["id"]]) if x[0] != "hod"] == [("self", False)], _e_bu[P2["id"]])
    if _P3:
        s.check("...and a draft is private: nothing", _e_bu[_P3["id"]] == [], _e_bu[_P3["id"]])
    with a.app.test_request_context("/"):
        _rows_h = {r["id"]: r for r in a._pot_calib_overview(a.get_db(), HODU, scope())["rows"]}
        _trl = a._pot_trail(a.get_db(), a.get_db().execute("SELECT * FROM users WHERE id=?", (P1["id"],)).fetchone(),
                            CID, "buceo")
    s.check("the HOD's person page carries them on the row", _rows_h[P1["id"]]["remarks"] == _e_hod[P1["id"]])
    _p1r, _p2r = _rows_h[P1["id"]], _rows_h[P2["id"]]
    s.check("the Self row's figures: their own score by their own competency answers, its two parts adding up, the same "
            "360 part as the line manager's (2026-10-05: 'the same result display like performance')",
            _p1r["self_score"] is not None and abs(_p1r["self_score"] - (_p1r["self_c_360"] + _p1r["self_c_tech"])) < 0.051
            and _p1r["self_c_360"] == _p1r["c_360"] and _p1r["self_c_tech"] == _p1r["c_tech_max"]
            and _p1r["self_max"] == _p1r["score_max"],
            {k: _p1r[k] for k in ("self_score", "self_max", "self_c_360", "self_c_tech", "c_360", "c_tech_max", "score_max")})
    s.check("...and for someone submitted but not yet approved too (the 360 plus their own answers)",
            _p2r["self_score"] is not None and _p2r["self_c_tech"] is not None, {k: _p2r[k] for k in ("self_score",
                                                                                                    "self_c_tech")})
    s.check("a BU CEO's HOD row names the HOD", _trl and _trl[0]["label"] == "HOD" and _trl[0]["by"] == HODU["full_name"],
            _trl)

    _ents = _e_bu[P1["id"]]
    _src = a._pot_remarks_source(_ents)
    s.check("the model reads each remark attributed and fenced as data",
            "Their own competency remark: <<<I grew" in _src and "Their line manager's competency remark: <<<" in _src
            and "The HOD's remark when they moved High to Mid: <<<Steady" in _src, _src)
    _real = (a.ai_draft.is_configured, getattr(a.ai_draft, "summarise_remarks"))
    a.ai_draft.is_configured = lambda: True
    _say = {"t": ""}
    a.ai_draft.summarise_remarks = lambda first, src, reviewer=None, timeout=20, about="potential": _say["t"]
    try:
        def _sum(text):
            _say["t"] = text
            with a.app.test_request_context("/"):
                db = a.get_db()
                db.execute("DELETE FROM pot_remark_summaries"); db.commit()
                return a._pot_remarks_summary_for(db, P1["id"], CID, "buceo", _ents, generate=True)
        _ok = _sum("They say they grew their planning and led the cost review; their line manager agrees on cost "
                   "work but says planning is still developing, and the HOD moved them from High to Mid, noting the "
                   "plan isn't theirs yet.")
        s.check("a faithful, attributed summary is shown as the AI's", _ok["source"] == "ai", _ok)
        _bad = _sum("They led the Singapore expansion and their line manager praised their budgeting of five sites.")
        s.check("...one that adds what nobody wrote falls back to their remarks, shortened and attributed",
                _bad["source"] == "plain" and _bad["summary"].startswith("They wrote: \u201cI grew")
                and "Their line manager wrote:" in _bad["summary"] and "The HOD (moved High → Mid) wrote:" in _bad["summary"],
                _bad)
        _adv = _sum("They grew their planning; their line manager agrees on cost work, so they should be kept at High.")
        s.check("...and one that says what the band should be is refused too", _adv["source"] == "plain", _adv)
        _tid = _sum("They grew their planning and led the cost review. No HOD remark is provided. Their line manager "
                    "agrees on cost work.")
        s.check("...a sentence about a remark nobody wrote is dropped (GPT-6 Luna, 2026-10-05)",
                _tid["source"] == "ai" and "No HOD" not in _tid["summary"]
                and _tid["summary"].endswith("agrees on cost work."), _tid)
        with a.app.test_request_context("/"):
            _none = a._pot_remarks_summary_for(a.get_db(), P1["id"], CID, "buceo", [], generate=True)
        s.check("no remarks: said plainly, no model call", _none["summary"] == "No written remarks yet.", _none)
    finally:
        a.ai_draft.is_configured, a.ai_draft.summarise_remarks = _real
    _rr = H.client_as(a, HOD).post("/review/team/pot-summary", data={"csrf_token": "tok", "report": P1["id"],
                                                                      "what": "remarks"})
    _jr = _rr.get_json() or {}
    s.check("the route (what=remarks): the HOD's scope, the HOD's view of the remarks, summarised and cached per tier",
            _rr.status_code == 200 and _jr.get("ok") and _jr.get("summary") and _jr.get("entries") == _e_hod[P1["id"]]
            and H.one(a, "SELECT COUNT(*) FROM pot_remark_summaries WHERE subject_id=? AND cycle_id=? AND tier='hod'",
                      (P1["id"], CID)) == 1, (_rr.status_code, _jr.get("source")))
finally:
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("DELETE FROM calibration_adjustments WHERE session_id=? AND subject_id=?", (_sid, P1["id"]))
        if _adj0:
            db.execute("INSERT INTO calibration_adjustments(%s) VALUES (%s)" % (",".join(_adj0.keys()),
                       ",".join("?" * len(_adj0.keys()))), tuple(_adj0))
        db.execute("UPDATE calibration_sessions SET locked_at=? WHERE id=?", (_lock0, _sid))
        db.commit()

_js = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "journey_chat.js"),
           encoding="utf-8").read()
_sp = _js[_js.find("function calSumPaint("):_js.find("\n  function calTarget(")]
_pc = _js[_js.find("function calPersonCard("):_js.find("\n  function calTitleBar(")]
s.check("client: the remarks summary sits INSIDE the AI read, right under the result (2026-10-05: 'move them up right "
        "below the result as the first to view'), the remarks themselves behind one button; the strengths after it",
        "function calRemarksPart(r, pot, hodSeat, buSeat)" in _js and 'f.append("what", "remarks");' in _js
        and 'b.textContent = "Read the remarks in full";' in _js and 'openRemarkModal({ title: "Their remarks"' in _js
        and "if (card && card._calRow) vb.appendChild(calRemarksPart(card._calRow, pot, card._hodSeat, card._buSeat));" in _sp
        and _pc.find("potJourney(d, r, review)") < _pc.find("calSumPaint(vb, skey);")
        < _pc.find("card.appendChild(potStrengths(r.strengths));")
        and "potRemarks" not in _js and "hodInRemarks" not in _js)
s.check("client: the potential result reads like performance's -- Self (360 + their own competency), Line manager (360 + "
        "the approved competency), the HOD with who, your move -- each with its band",
        '"Self", of(r.self_score, r.self_max) + " · 360 " + fmtScore(r.self_c_360)' in _js
        and '+ " · 360 " + fmtScore(r.c_360) + " + competency " + fmtScore(r.c_tech) + " approved"' in _js
        and "journeyMoves(box, d, r, review);" in _js)
s.check("client: the person card (the BU CEO's and the HOD's department review alike) shows the block, from the server's "
        "words and a four-step meter",
        "function potStrengths(s)" in _js and "if (pot && r.strengths) card.appendChild(potStrengths(r.strengths));" in _js
        and "i <= (it.step || 0)" in _js and "Bottom \" + bot.length + \" · development areas" in _js
        and "Their competency strengths show here once their line manager has reviewed it." in _js
        and "if (s.even) {" in _js and "if (!s.even) box.appendChild(cols);" in _js
        and '" more seen the same"' in _js and "No principle stands out as a strength in the 360." in _js)
s.check("client: every '+N more' is a button that opens the rest in place and folds it again (Chris, 2026-10-05: 'the "
        "+1 more is not clickable')",
        "function swMoreBtn(extra, label)" in _js and 'b.type = "button"' in _js and 'b.setAttribute("aria-expanded"' in _js
        and 'swMoreBtn(ex, "+" + more.length + " more seen the same")' in _js
        and 'swMoreBtn(extra, "+" + (names.length - 3) + " more")' in _js
        and 'row("Fully demonstrated", cp.full || []);' in _js and '"rv-pot-sw-soft", " +" + more' not in _js and '"rv-pot-sw-more", "+"' not in _js)

a.calibration_tier_of, a._calib_assist_on = _real_tier, _real_on
sys.exit(s.done())
