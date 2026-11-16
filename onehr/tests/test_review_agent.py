"""The conversational review agent (2026-08-31). The MODEL converses and proposes
actions; these tools VALIDATE and perform every write and compute every rating --
the model is never the source of truth. The real model is never called here: the
agent turn is stubbed, exactly as test_phase0 stubs ai_draft, because the dev
bridge (the claude CLI) and Azure are both out of a test's reach.

Writes (KPI results, evidence, check-ins), so a fresh copy.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
s = H.Suite("Review agent -- tools validate & write, the model only proposes")
SU, _BG, _EMP = H.actors(a)

CHBM = "CHIN HIN BUILDING MATERIAL (CHBM)"   # mechanism A (5-point) in the fixture


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


# ---------------------------------------------------------------------------
s.section("build: a CHBM subject with two 5-point KPI lines")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','evidence')")
    # The KPI check-in's 3-step gates (AE/OU file + required remark) are the UNIFIED-JOURNEY rule;
    # the tools branch on _review_unified_on(u), so turn the flag on for these tool-level tests.
    # (The standalone /review/chat loop below stays standalone -- it never passes ?journey=1.)
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
    db.execute("UPDATE cycles SET kind='mid_year' WHERE id=?", (CID,))
    us = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                    "ORDER BY id LIMIT 2").fetchall()
    SUBJ, OTHER = us[0], us[1]

    def kpi(subj, name, rates):
        r = dict(zip(("rate1", "rate2", "rate3", "rate4", "rate5"), rates))
        return db.execute(
            "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
            "status, business_group, rate1, rate2, rate3, rate4, rate5) "
            "VALUES (?,?,?,?, 'more', 'approved', ?, ?, ?, ?, ?, ?)",
            (CID, subj, name, 50.0, CHBM, r["rate1"], r["rate2"], r["rate3"],
             r["rate4"], r["rate5"])).lastrowid

    GP = kpi(SUBJ["id"], "ZZ Gross Profit", (9, 11, 12, 13, 15))
    DM = kpi(SUBJ["id"], "ZZ Deliveries", (1, 2, 3, 4, 5))
    OTHER_KPI = kpi(OTHER["id"], "ZZ Not Yours", (1, 2, 3, 4, 5))
    if not db.execute("SELECT 1 FROM pm_bg_config WHERE business_group=?", (CHBM,)).fetchone():
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (CHBM,))
    db.commit()


def tool(name, args, uid=None):
    uid = uid or SUBJ["id"]
    # A request context, not just app: the tools call current_user()/tier config
    # which read the session.
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return a._review_run_tool(db, dict(u), CID, {"tool": name, "args": args})


def attach_file(kpi_id, uid=None):
    """Give a KPI a supporting FILE the way the paperclip does (review_kpi_attach): a
    KPI-linked recognition evidence item + one attachment row, so _review_kpi_attachment_ids
    sees it and the AE/OU submit gate passes. Mirrors the route's create path (pm_evidence_write
    + share + link + attachment) rather than driving HTTP, so a test that needs evidence ON a
    KPI can set it in one call. Returns the evidence id."""
    uid = uid or SUBJ["id"]
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
        fields = {"body": None, "impact": None, "who": None, "title": None,
                  "kind": "recognition", "occurred_on": a._today_myt().isoformat(),
                  "occurred_precision": "day", "metric_value": None, "metric_unit": None,
                  "raised_with_subject": None}
        eid, _err = a.pm_evidence_write(db, u, uid, fields)
        db.execute("UPDATE pm_evidence SET state='shared' WHERE id=?", (eid,))
        db.execute("INSERT OR IGNORE INTO pm_evidence_links(evidence_id, target_kind, target_ref) "
                   "VALUES (?, 'kpi', ?)", (eid, str(kpi_id)))
        db.execute("INSERT INTO pm_evidence_attachments(evidence_id, filename, stored_path, "
                   "content_type, size_bytes, uploaded_by) VALUES (?, 'evidence.pdf', 'x/y.pdf', "
                   "'application/pdf', 12, ?)", (eid, uid))
        db.commit()
        return eid


def set_remark(text, uid=None):
    """Save the overall remark via the agent tool (set_overall_remark), so a test that needs
    the required overall remark present can set it in one call."""
    return tool("set_overall_remark", {"text": text}, uid=uid)


# ---------------------------------------------------------------------------
s.section("record_kpi_result -- writes a draft and returns the SERVER's rating")
r = tool("record_kpi_result", {"kpi_id": GP, "actual_value": "16"})
s.check("ok", r.get("ok") is True, r)
s.check("the band is computed by the tool, not the model", r.get("band") == "Outstanding", r)
s.check("...rating shape returned", r.get("rating") == "5.0 of 5", r.get("rating"))
s.check("a draft result row was written",
        H.one(a, "SELECT actual_value FROM pm_kpi_results WHERE kpi_target_id=?", (GP,)) == 16.0)
s.check("...as a DRAFT (not submitted)",
        H.one(a, "SELECT draft FROM pm_kpi_results WHERE kpi_target_id=?", (GP,)) == 1)
s.check("a STRONG, uncited KPI carries a next_step nudge to ask for an example",
        "next_step" in r and "example" in r["next_step"].lower(), r.get("next_step"))
# free-text-ish input the model would have extracted: "16" as a string with commas
r2 = tool("record_kpi_result", {"kpi_id": DM, "actual_value": "2"})
s.check("a weak line records without a next_step nudge",
        r2.get("ok") and "next_step" not in r2, r2)
s.check("a KPI that is not the caller's own is refused",
        tool("record_kpi_result", {"kpi_id": OTHER_KPI, "actual_value": "3"}).get("ok") is False)
s.check("a non-numeric value is refused",
        tool("record_kpi_result", {"kpi_id": GP, "actual_value": "loads"}).get("ok") is False)

# ---------------------------------------------------------------------------
s.section("record_kpi_result -- the model echoes the unit: '41%' on a % line saves 41 (staging, 2026-10-19)")
# The bug: "Yes, please enter 41%." on Direct Materials Cost (a lower-is-better % KPI, 53/46/42/38/32) was refused
# ("I couldn't save 41% just now") while 41 typed in the table saved and scored 3.0 ME.
with a.app.app_context():
    db = a.get_db()
    PCT = db.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
        "unit, rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?,?, 'less', 'approved', ?, '%', 53, 46, 42, 38, 32)",
        (CID, SUBJ["id"], "ZZ Direct Materials Cost", 10.0, CHBM)).lastrowid
    db.commit()
rp = tool("record_kpi_result", {"kpi_id": PCT, "actual_value": "41%"})
s.check("'41%' on a % line is recorded", rp.get("ok") is True, rp)
s.check("...as 41, the number the table would have saved",
        H.one(a, "SELECT MAX(actual_value) FROM pm_kpi_results WHERE kpi_target_id=?", (PCT,)) == 41.0)
s.check("...and the lower-is-better ladder scores it 3.0 ME, as the table did",
        rp.get("rating") == "3.0 of 5" and rp.get("band") == "Meet Expectation", rp)
s.check("' 40 % ' (spaces) is recorded too",
        tool("record_kpi_result", {"kpi_id": PCT, "actual_value": " 40 % "}).get("ok") is True
        and H.one(a, "SELECT MAX(actual_value) FROM pm_kpi_results WHERE kpi_target_id=?", (PCT,)) == 40.0)
s.check("a bare 41 still records", tool("record_kpi_result", {"kpi_id": PCT, "actual_value": 41}).get("ok") is True)
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE pm_kpi_targets SET unit='RM (mil)' WHERE id=?", (PCT,))
    db.commit()
rr = tool("record_kpi_result", {"kpi_id": PCT, "actual_value": "41%"})
s.check("'41%' on a line NOT in % is refused (a % can't mean RM)", rr.get("ok") is False, rr)
s.check("...and the error tells the model to retry with the bare number itself, not send them to the table",
        "bare number" in (rr.get("error") or "") and "call the tool again yourself" in rr["error"]
        and "RM (mil)" in rr["error"], rr)
s.check("...nothing was written", H.one(a, "SELECT MAX(actual_value) FROM pm_kpi_results WHERE kpi_target_id=?",
                                        (PCT,)) == 41.0)
s.check("'RM 13.4 mil' is refused, never guessed at (its scale is the line's call)",
        tool("record_kpi_result", {"kpi_id": PCT, "actual_value": "RM 13.4 mil"}).get("ok") is False)
s.check("'nan' is refused", tool("record_kpi_result", {"kpi_id": PCT, "actual_value": "nan"}).get("ok") is False)
s.check("another person's line is refused before its figure is read",
        tool("record_kpi_result", {"kpi_id": OTHER_KPI, "actual_value": "41%"}).get("error")
        == "that KPI is not yours this period")
with a.app.app_context():   # put it back: later sections count this subject's lines
    db = a.get_db()
    db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (PCT,))
    db.execute("DELETE FROM pm_kpi_targets WHERE id=?", (PCT,))
    db.commit()

# ---------------------------------------------------------------------------
s.section("KPI overview card -- the 5-point scale (1->5, no band names) + result field")
# At this point GP is keyed (16 -> Outstanding, rung 5) and DM is keyed (2);
# OTHER_KPI belongs to someone else and is un-keyed.


def overview(uid):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        db = a.get_db()
        u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        ov = a._review_kpi_overview(db, dict(u))
        return ov["data"]["lines"] if ov else []


def num(x):
    return float(str(x).replace(",", ""))


sub_lines = overview(SUBJ["id"])
s.check("the overview lists the subject's OWN KPIs only",
        sorted(l["kpi_id"] for l in sub_lines) == sorted((GP, DM)),
        [l["kpi"] for l in sub_lines])
gp = next((l for l in sub_lines if l["kpi_id"] == GP), None)
s.check("each KPI carries a 5-rung scale", gp and len(gp["scale"]) == 5,
        gp and len(gp["scale"]))
s.check("the scale runs 1 -> 5 by rating number",
        gp and [r["n"] for r in gp["scale"]] == [1, 2, 3, 4, 5],
        gp and [r["n"] for r in gp["scale"]])
s.check("...with ascending threshold values",
        gp and num(gp["scale"][0]["value"]) < num(gp["scale"][-1]["value"]),
        gp and [r["value"] for r in gp["scale"]])
s.check("the scale rungs OMIT the band definition (no Outstanding/etc.)",
        gp and all("band" not in r for r in gp["scale"]), gp and gp["scale"][0])
s.check("a keyed KPI shows the recorded result", gp and gp["result"] == "16",
        gp and gp["result"])
s.check("...the landed rung is highlighted (achieved_n = 5)",
        gp and gp["achieved_n"] == 5, gp and gp["achieved_n"])
s.check("...and the achieved band rides in the result cell",
        gp and gp["band"] == "Outstanding", gp and gp["band"])
s.check("...with the raw band CODE for the band pill (OU)",
        gp and gp["band_code"] == "OU", gp and gp.get("band_code"))
s.check("each line carries mechanism + direction for the flat row",
        gp and "mechanism" in gp and "direction" in gp, gp)
s.check("...and the raw method (more/less) so the client can light the live rung",
        gp and gp.get("method") in ("more", "less"), gp and gp.get("method"))
s.check("a Mechanism-A KPI carries no Mechanism-B scale",
        gp and gp["scale_b"] == [], gp and gp.get("scale_b"))

oth_lines = overview(OTHER["id"])
ok = oth_lines[0] if oth_lines else None
s.check("an un-keyed OWN KPI is editable (a result field is offered)",
        ok and ok["editable"] is True, ok)
s.check("...with no result and no landed rung yet",
        ok and ok["result"] is None and ok["achieved_n"] is None, ok)

# The overview is a LIVE widget returned by the history endpoint, not a stored
# snapshot -- so a reload always reflects what is keyed.
_HC = H.client_as(a, SUBJ["id"])
_hj = _HC.get("/review/chat/history").get_json()
s.check("the history endpoint returns the live overview",
        _hj.get("overview") and len(_hj["overview"]["lines"]) == 2,
        _hj.get("overview"))

# The isolated FINAL SCORE = the weighted overall, Sigma(value*weight)/Sigma(weight).
# Verify it INDEPENDENTLY from the per-line rungs + weights (not the page's own
# expression) -- the number must be the server's, and correct. Tolerant on format,
# strict on the math + coverage (a partial must never be presented as a total).
with a.app.test_request_context("/"):
    from flask import session as _sess
    _sess["user_id"] = SUBJ["id"]
    _db = a.get_db()
    _u = _db.execute("SELECT * FROM users WHERE id=?", (SUBJ["id"],)).fetchone()
    _data = a._review_kpi_overview(_db, dict(_u))["data"]
_ov = _data.get("overall")
_scored = [l for l in _data["lines"] if l.get("band_code")]
_covered = sum(l["weight"] for l in _scored)
_total = sum(l["weight"] for l in _data["lines"])
_expect = (sum(l["achieved_n"] * l["weight"] for l in _scored) / _covered) if _covered else None
s.check("the overview carries a weighted final score", bool(_ov), _ov)
s.check("...equal to an independently computed weighted average of the rungs",
        _ov and abs(float(str(_ov["value"]).replace("%", "")) - _expect) < 0.05,
        _ov and (_ov["value"], _expect))
s.check("...carrying coverage (never a partial shown as a total)",
        _ov and _ov["covered"] == _covered and _ov["total"] == _total,
        _ov and (_ov.get("covered"), _ov.get("total"), _covered, _total))

# ---------------------------------------------------------------------------
s.section("no PHANTOM rating: a seeded/approved effective_value shows nothing until keyed")
# The FIAMMA/SIGNATURE demo accounts carry a prior APPROVAL, so pm_effective_value()
# returns a value (-> a computed score) even after a Reset clears the raw result row.
# Reproduce it: a KPI with an approval snapshot but NO pm_kpi_results row -> has_value
# is False, but pm_score_targets still scores it. The display must show NO rating, and
# the FINAL must not count it.
with a.app.app_context():
    _pdb = a.get_db()
    PH = _pdb.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
        "status, business_group, rate1, rate2, rate3, rate4, rate5) "
        "VALUES (?,?,?,?, 'more', 'approved', ?, 9, 11, 12, 13, 15)",
        (CID, OTHER["id"], "ZZ Phantom", 50.0, CHBM)).lastrowid
    # An approval snapshot (value 15 -> rung 5), but deliberately NO result row.
    _pdb.execute(
        "INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value) "
        "VALUES (?, 1, 'confirm', 15)", (PH,))
    _pdb.commit()
# At the DATA layer the phantom is real: a score is computed, but nothing is keyed.
with a.app.test_request_context("/"):
    from flask import session as _ps
    _ps["user_id"] = OTHER["id"]
    _pdb = a.get_db()
    _pu = _pdb.execute("SELECT * FROM users WHERE id=?", (OTHER["id"],)).fetchone()
    _pst = a.review_state(_pdb, dict(_pu))
    _pt = next((t for t in _pst["targets"] if t["id"] == PH), None)
s.check("the phantom line scores at the data layer (effective_value present)",
        _pt and _pt.get("score") and _pt["score"].get("value") is not None, _pt and _pt.get("score"))
s.check("...but nothing is actually keyed (has_value False)",
        _pt and not _pt.get("has_value"), _pt and _pt.get("has_value"))
# At the DISPLAY layer the phantom is suppressed.
_ph = next((l for l in overview(OTHER["id"]) if l["kpi_id"] == PH), None)
s.check("an un-keyed line with an approved value shows NO result", _ph and _ph["result"] is None, _ph)
s.check("...NO rating", _ph and _ph["rating"] is None, _ph and _ph.get("rating"))
s.check("...NO band / band code", _ph and _ph["band"] is None and _ph["band_code"] is None, _ph)
s.check("...NO landed rung", _ph and _ph["achieved_n"] is None, _ph and _ph.get("achieved_n"))
# The FINAL excludes it: OTHER has only un-keyed lines, so there is no overall to show.
with a.app.test_request_context("/"):
    from flask import session as _ps2
    _ps2["user_id"] = OTHER["id"]
    _pdb2 = a.get_db()
    _pu2 = _pdb2.execute("SELECT * FROM users WHERE id=?", (OTHER["id"],)).fetchone()
    _pdata = a._review_kpi_overview(_pdb2, dict(_pu2))["data"]
s.check("a phantom score never inflates the FINAL (nothing keyed -> no overall)",
        _pdata.get("overall") is None, _pdata.get("overall"))

# ---------------------------------------------------------------------------
s.section("BU-level KPI (PAT) -- SHOWN read-only 'Filled by HR', never blocks Confirm")
# A company-wide figure (PAT) the employee SEES but never keys: HR fills it for the whole
# function via Fill BU KPI. The overview must include the line (not skip it), flagged
# bu_level + not editable, with no rating until HR fills it; and it must NOT block Confirm.
with a.app.app_context():
    _bdb = a.get_db()
    # A dedicated CHBM subject, so the BG-wide library row's scope matches on business_group.
    _bthird = _bdb.execute(
        "SELECT id FROM users WHERE role!='admin' AND left_at IS NULL "
        "AND id NOT IN (?, ?) ORDER BY id LIMIT 1", (SUBJ["id"], OTHER["id"])).fetchone()
    BUU = _bthird["id"]
    _bdb.execute("UPDATE users SET business_group=?, department='Sales', job_grade='15' "
                 "WHERE id=?", (CHBM, BUU))
    # A BG-wide BU-level library row for PAT -> pm_bu_level_names returns {'pat'} for CHBM.
    _bdb.execute(
        "INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, "
        "kpi_name, method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level, active) "
        "VALUES (?, '*', '*', 0, '*', 'PAT', 'more', 4, 6, 8, 10, 12, 30, 1, 1)", (CHBM,))
    # The subject's own keyable KPI + a PAT target matching the library name.
    OWN = _bdb.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
        "status, business_group, rate1, rate2, rate3, rate4, rate5) "
        "VALUES (?,?, 'ZZ Own KPI', 40.0, 'more', 'approved', ?, 9, 11, 12, 13, 15)",
        (CID, BUU, CHBM)).lastrowid
    PAT = _bdb.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
        "status, business_group, rate1, rate2, rate3, rate4, rate5) "
        "VALUES (?,?, 'PAT', 30.0, 'more', 'approved', ?, 4, 6, 8, 10, 12)",
        (CID, BUU, CHBM)).lastrowid
    _bdb.commit()
with a.app.test_request_context("/"):
    from flask import session as _bs
    _bs["user_id"] = BUU
    _bdb2 = a.get_db()
    _buu = _bdb2.execute("SELECT * FROM users WHERE id=?", (BUU,)).fetchone()
    _bnames = a.pm_bu_level_names(_bdb2, dict(_buu))
    _bst = a.review_state(_bdb2, dict(_buu))
    _bpt = next((t for t in _bst["targets"] if t["id"] == PAT), None)
    _bov = a._review_kpi_overview(_bdb2, dict(_buu))["data"]
s.check("pm_bu_level_names picks up the BG-wide PAT", "pat" in _bnames, _bnames)
s.check("review_state flags the PAT target bu_level", _bpt and _bpt.get("bu_level"), _bpt and _bpt.get("bu_level"))
_blines = _bov["lines"]
_bpat = next((l for l in _blines if l["kpi_id"] == PAT), None)
_bown = next((l for l in _blines if l["kpi_id"] == OWN), None)
s.check("the BU-level line IS shown in the overview (not skipped)",
        _bpat is not None, [l["kpi"] for l in _blines])
s.check("...flagged bu_level to the client", _bpat and _bpat.get("bu_level") is True, _bpat and _bpat.get("bu_level"))
s.check("...read-only (never keyable by the employee)", _bpat and _bpat.get("editable") is False,
        _bpat and _bpat.get("editable"))
s.check("...no result/rating until HR fills it",
        _bpat and _bpat["result"] is None and _bpat["rating"] is None, _bpat)
s.check("the employee's OWN line stays editable", _bown and _bown.get("editable") is True,
        _bown and _bown.get("editable"))
# Key the own line (a ME -> no file needed) + write the required overall remark, then Confirm must
# be READY -- the unfilled PAT does not block it.
_brk = tool("record_kpi_result", {"kpi_id": OWN, "actual_value": "12"}, uid=BUU)
s.check("the own line records a draft", _brk.get("ok") is True, _brk)
set_remark("Met my target for the year and kept delivery on track.", uid=BUU)
_bpc = tool("prepare_confirm", {}, uid=BUU)
s.check("prepare_confirm is READY -- the unfilled BU-level PAT never blocks Confirm",
        _bpc.get("ok") is True and _bpc.get("ready") is True, _bpc)
# HR runs Fill BU KPI: an admin_filled, draft=0 result on the PAT target.
with a.app.app_context():
    _hdb = a.get_db()
    _hdb.execute(
        "INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, admin_filled, draft) "
        "VALUES (?, 10, ?, 1, 0)", (PAT, SU["id"]))
    _hdb.commit()
with a.app.test_request_context("/"):
    from flask import session as _hs
    _hs["user_id"] = BUU
    _hdb2 = a.get_db()
    _hu = _hdb2.execute("SELECT * FROM users WHERE id=?", (BUU,)).fetchone()
    _hov = a._review_kpi_overview(_hdb2, dict(_hu))["data"]
_hpat = next((l for l in _hov["lines"] if l["kpi_id"] == PAT), None)
s.check("once HR fills it, the BU-level line shows its result", _hpat and _hpat["result"] is not None, _hpat)
s.check("...and a server-computed rating", _hpat and _hpat["rating"] is not None, _hpat and _hpat.get("rating"))
s.check("...still read-only for the employee after the fill", _hpat and _hpat.get("editable") is False,
        _hpat and _hpat.get("editable"))

# ---------------------------------------------------------------------------
s.section("HR-owned KPIs take NO attachment and are outside the AE/OU file rule (Chris, 2026-09-23)")
# HR's fill lands PAT at 10 on the 4/6/8/10/12 ladder = Above Expectation, with NO file. The
# employee can't fill it, so it must not owe one: no paperclip payload, not in attach_needed, never
# blocks Confirm, and every write path refuses a file/link on it.
import io as _bio
s.check("precondition: HR's PAT fill is rated AE (a standout that WOULD owe a file if it were theirs)",
        _hpat and _hpat.get("band_code") == "AE", _hpat and _hpat.get("band_code"))
s.check("the overview flags it hr_owned", _hpat and _hpat.get("hr_owned") is True, _hpat)
s.check("...and carries no evidence id / no attachments (nothing for the client to render or extend)",
        _hpat and _hpat.get("eid") is None and _hpat.get("attachments") == [], _hpat)
s.check("the own line is NOT hr_owned", _bown and _bown.get("hr_owned") is False, _bown)
s.check("attach_needed never lists HR's PAT", PAT not in [x["kpi_id"] for x in _hov.get("attach_needed", [])],
        _hov.get("attach_needed"))
_bpc2 = tool("prepare_confirm", {}, uid=BUU)
s.check("prepare_confirm stays READY with HR's AE PAT carrying no file",
        _bpc2.get("ok") is True and _bpc2.get("ready") is True, _bpc2)
with a.app.test_request_context("/"):
    from flask import session as _gs
    _gs["user_id"] = BUU
    _gdb = a.get_db()
    _gu = dict(_gdb.execute("SELECT * FROM users WHERE id=?", (BUU,)).fetchone())
    _gok, _gerr = a._review_submit_blockers(
        _gdb, _gu, CID, [t for t in a.review_state(_gdb, _gu)["targets"] if not t.get("bu_level")])
    _hrids = a._review_hr_owned_ids(_gdb, _gu, CID)
s.check("_review_submit_blockers passes (no 'needs a supporting file' for PAT)", _gok is True, _gerr)
s.check("_review_hr_owned_ids names PAT and not the own line", PAT in _hrids and OWN not in _hrids, _hrids)


def _kattach(kpi_id, uid):
    return H.client_as(a, uid).post("/review/kpi/%d/attach" % kpi_id,
                                    data={"file": (_bio.BytesIO(b"%PDF-1.4 x"), "proof.pdf"),
                                          "csrf_token": "tok"},
                                    content_type="multipart/form-data")


_n_links0 = H.one(a, "SELECT COUNT(*) FROM pm_evidence_links WHERE target_kind='kpi' AND target_ref=?", (str(PAT),))
_ra = _kattach(PAT, BUU)
s.check("POST /review/kpi/<PAT>/attach is REFUSED (400)",
        _ra.status_code == 400 and (_ra.get_json() or {}).get("ok") is False, (_ra.status_code, _ra.get_json()))
s.check("...and NO evidence item was linked to PAT (refused before the create)",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence_links WHERE target_kind='kpi' AND target_ref=?",
              (str(PAT),)) == _n_links0)
_rok = _kattach(OWN, BUU)
s.check("positive control: attaching to the OWN line (still a draft) succeeds",
        _rok.status_code == 200 and (_rok.get_json() or {}).get("ok") is True, (_rok.status_code, _rok.get_json()))
_le = tool("log_evidence", {"kpi_id": PAT, "text": "HR's figure, not mine to evidence."}, uid=BUU)
s.check("log_evidence refuses to link to an HR-owned KPI", _le.get("ok") is False, _le)
_le2 = tool("log_evidence", {"kpi_id": OWN, "text": "Closed the Q3 supplier deal early."}, uid=BUU)
s.check("...but links to the own KPI and returns the VALIDATED kpi_id",
        _le2.get("ok") is True and _le2.get("kpi_id") == OWN, _le2)
_lc = H.client_as(a, BUU).post("/evidence/%d/link" % _le2["evidence_id"],
                               data={"target_kind": "kpi", "target_ref": str(PAT), "csrf_token": "tok"})
s.check("evidence_link refuses an HR-owned KPI", _lc.status_code == 400, (_lc.status_code, _lc.get_json()))
# A legacy link onto PAT (made before the refusals) -> review_evidence_attach refuses a file on it.
with a.app.app_context():
    _ldb = a.get_db()
    _ldb.execute("INSERT OR IGNORE INTO pm_evidence_links(evidence_id, target_kind, target_ref) "
                 "VALUES (?, 'kpi', ?)", (_le2["evidence_id"], str(PAT)))
    _ldb.commit()
_rea = H.client_as(a, BUU).post("/review/evidence/%d/attach" % _le2["evidence_id"],
                                data={"file": (_bio.BytesIO(b"%PDF-1.4 x"), "p.pdf"), "csrf_token": "tok"},
                                content_type="multipart/form-data")
s.check("review_evidence_attach refuses an item linked to an HR-owned KPI", _rea.status_code == 400,
        (_rea.status_code, _rea.get_json()))
with a.app.app_context():
    _ldb = a.get_db()
    _ldb.execute("DELETE FROM pm_evidence_links WHERE evidence_id=? AND target_ref=?",
                 (_le2["evidence_id"], str(PAT)))
    _ldb.commit()

# An HR-filled line that is NOT library-flagged BU-level (Fill BU KPI is BG-wide; the flag is scoped)
# -> still HR-owned: it never owes the employee a file.
with a.app.app_context():
    _xdb = a.get_db()
    XHR = _xdb.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
        "status, business_group, rate1, rate2, rate3, rate4, rate5) "
        "VALUES (?,?, 'ZZ Group Revenue', 30.0, 'more', 'approved', ?, 4, 6, 8, 10, 12)",
        (CID, BUU, CHBM)).lastrowid
    _xdb.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, admin_filled, draft) "
                 "VALUES (?, 12, ?, 1, 0)", (XHR, SU["id"]))
    _xdb.commit()
with a.app.test_request_context("/"):
    from flask import session as _xs
    _xs["user_id"] = BUU
    _xdb2 = a.get_db()
    _xu = dict(_xdb2.execute("SELECT * FROM users WHERE id=?", (BUU,)).fetchone())
    _xov = a._review_kpi_overview(_xdb2, _xu)["data"]
    _xst = a.review_state(_xdb2, _xu)
    _xline = next((l for l in _xov["lines"] if l["kpi_id"] == XHR), None)
    _xt = next((t for t in _xst["targets"] if t["id"] == XHR), None)
    _xneed = a._review_kpis_needing_file(_xdb2, _xu, _xst["targets"])
s.check("precondition: the non-flagged HR fill is NOT bu_level but lands OU",
        _xt and not _xt.get("bu_level") and (_xt.get("score") or {}).get("label") == "OU",
        _xt and (_xt.get("bu_level"), (_xt.get("score") or {}).get("label")))
s.check("...it is hr_owned (HR-filled) and owes no file", _xline and _xline.get("hr_owned") is True
        and XHR not in [t["id"] for t in _xneed], _xline)
_bpc3 = tool("prepare_confirm", {}, uid=BUU)
s.check("...and it never blocks Confirm", _bpc3.get("ok") is True and _bpc3.get("ready") is True, _bpc3)
with a.app.app_context():
    _xdb = a.get_db()
    _xdb.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (XHR,))
    _xdb.execute("DELETE FROM pm_kpi_targets WHERE id=?", (XHR,))
    _xdb.commit()

# THE LOCK FIX: an HR fill is never the employee's sign-off. With the own line's result removed,
# HR's draft=0 PAT fill is the ONLY result row -- the legacy "every row draft=0" clause used to read
# that as a submitted, locked check-in.
with a.app.app_context():
    _kdb = a.get_db()
    _own_row = dict(_kdb.execute("SELECT * FROM pm_kpi_results WHERE kpi_target_id=?", (OWN,)).fetchone())
    _kdb.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (OWN,))
    _kdb.commit()
    s.check("precondition: HR's draft=0 fill is now the ONLY result row",
            _kdb.execute("SELECT COUNT(*) c, MAX(draft) d FROM pm_kpi_results r JOIN pm_kpi_targets t "
                         "ON t.id=r.kpi_target_id WHERE t.subject_id=? AND t.cycle_id=?",
                         (BUU, CID)).fetchone()["c"] == 1)
    s.check("pm_review_locked is FALSE -- HR's fill is not the employee's sign-off",
            a.pm_review_locked(_kdb, BUU, CID) is False)
_sv = H.client_as(a, BUU).post("/review/kpi/save-all",
                               data={"actual_value_%d" % OWN: "12", "csrf_token": "tok"})
s.check("...so save-all still records the own line (not refused as locked)",
        _sv.status_code == 200 and (_sv.get_json() or {}).get("ok") is True, (_sv.status_code, _sv.get_json()))
# The legacy clause still holds for the EMPLOYEE's own submitted rows (a pre-sign-off check-in).
with a.app.app_context():
    _kdb = a.get_db()
    _kdb.execute("UPDATE pm_kpi_results SET draft=0 WHERE kpi_target_id=?", (OWN,))
    _kdb.commit()
    s.check("a legacy check-in (own rows all draft=0, no session row) still reads LOCKED",
            a.pm_review_locked(_kdb, BUU, CID) is True)
    _kdb.execute("UPDATE pm_kpi_results SET draft=1 WHERE kpi_target_id=?", (OWN,))
    _kdb.commit()

# ---------------------------------------------------------------------------
s.section("Mechanism B -- scale references (threshold/target/multiplier) + a rating %")
# Mech B has no 1-5 ladder, so the layout heads its columns with the scale
# references and carries a dedicated Rating column. Guard the payload it renders
# from: scale_b labels, an achievement-% rating, and a band code.
with a.app.app_context():
    _bdb = a.get_db()
    if not _bdb.execute("SELECT 1 FROM pm_bg_config WHERE business_group=?", ("ZZ MECH B",)).fetchone():
        _bdb.execute("INSERT INTO pm_bg_config(business_group, mechanism, variant) "
                     "VALUES ('ZZ MECH B','B','base')")
        # Mech B bands are per-BG (pm_label_for_value reads them); same cutoffs as a
        # real Mech-B BG so the % maps to a band. 95% -> ME (floor at 81).
        for _lab, _min, _so in [("UA", 0, 1), ("BE", 61, 2), ("ME", 81, 3),
                                ("AE", 101, 4), ("OU", 121, 5)]:
            _bdb.execute("INSERT INTO pm_rating_bands(business_group, min_value, label, sort_order) "
                         "VALUES ('ZZ MECH B', ?, ?, ?)", (_min, _lab, _so))
    _mbu = _bdb.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL "
                        "ORDER BY id LIMIT 1 OFFSET 2").fetchone()
    MBID = _bdb.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
        "status, business_group, threshold, target, multiple) "
        "VALUES (?,?,?,?, 'more', 'approved', 'ZZ MECH B', ?, ?, ?)",
        (CID, _mbu["id"], "ZZ Sales Revenue", 100.0, 8000000, 10000000, 200)).lastrowid
    _bdb.commit()
tool("record_kpi_result", {"kpi_id": MBID, "actual_value": "9500000"}, uid=_mbu["id"])
_mb = next((l for l in overview(_mbu["id"]) if l["kpi_id"] == MBID), None)
s.check("a Mech B line carries its scale references (Threshold/Target/Multiplier)",
        _mb and [r["label"] for r in _mb["scale_b"]] == ["Threshold", "Target", "Multiplier"],
        _mb and _mb.get("scale_b"))
s.check("...and no 1-5 rung ladder",
        _mb and _mb["scale"] == [], _mb and _mb.get("scale"))
s.check("...the rating is an achievement percentage",
        _mb and _mb["rating"] and _mb["rating"].endswith("%"), _mb and _mb.get("rating"))
s.check("...with a band code for the rating pill",
        _mb and bool(_mb["band_code"]), _mb and _mb.get("band_code"))
# The live Mech-B glow scores client-side, so each scale reference carries a numeric
# raw, and the overview carries the per-BG band cutoffs (bands_b) for the % -> band map.
s.check("...each scale reference carries a numeric raw (for the live % glow)",
        _mb and all(isinstance(r.get("raw"), (int, float)) for r in _mb["scale_b"]),
        _mb and [r.get("raw") for r in _mb["scale_b"]])
with a.app.test_request_context("/"):
    from flask import session as _bsess
    _bsess["user_id"] = _mbu["id"]
    _bdb2 = a.get_db()
    _bu = _bdb2.execute("SELECT * FROM users WHERE id=?", (_mbu["id"],)).fetchone()
    _bov = a._review_kpi_overview(_bdb2, dict(_bu))
s.check("...the overview carries per-BG band cutoffs (bands_b) for the live % glow",
        _bov and _bov["data"].get("bands_b")
        and all(("code" in b and "min" in b) for b in _bov["data"]["bands_b"]),
        _bov and _bov["data"].get("bands_b"))

# ---------------------------------------------------------------------------
s.section("log_evidence -- a shared item, cited to the KPI")
r = tool("log_evidence", {"kpi_id": GP, "text": "Closed the Bina Puri deal, RM 3.2m."})
s.check("ok", r.get("ok") is True, r)
with a.app.app_context():
    row = a.get_db().execute(
        "SELECT e.state, e.author_role, l.target_ref FROM pm_evidence e "
        "JOIN pm_evidence_links l ON l.evidence_id=e.id "
        "WHERE e.subject_id=? AND l.target_kind='kpi' AND l.target_ref=?",
        (SUBJ["id"], str(GP))).fetchone()
s.check("a SHARED evidence item is cited to the KPI",
        row and row["state"] == "shared" and row["target_ref"] == str(GP), dict(row) if row else None)
s.check("...authored as self", row and row["author_role"] == "self")
s.check("now the KPI is cited, the record nudge stops",
        "next_step" not in tool("record_kpi_result", {"kpi_id": GP, "actual_value": "16"}))
s.check("empty evidence text is refused", tool("log_evidence", {"text": "  "}).get("ok") is False)
# A bare affirmation ("yes, I can share") is NOT the example -- refuse it so the
# agent asks for the real content instead of logging agreement / moving on.
for _aff in ("Yes, I can share", "yes", "sure", "I can share", "of course"):
    _r = tool("log_evidence", {"kpi_id": GP, "text": _aff})
    s.check("affirmation %r is refused as evidence" % _aff, _r.get("ok") is False, _r)
s.check("a real example still logs",
        tool("log_evidence", {"kpi_id": GP, "text": "Renegotiated supplier terms, saving 4%."}).get("ok") is True)
# A direct KPI file-attach creates a file-only recognition item (empty body). The confirm
# card's example recap (_review_justification) must SKIP it -- it is a file, not an example.
with a.app.test_request_context("/"):
    from flask import session as _sj
    _sj["user_id"] = SUBJ["id"]
    _jdb = a.get_db()
    _feid = _jdb.execute("INSERT INTO pm_evidence(subject_id, author_id, occurred_on, kind, body, state) "
                         "VALUES (?,?, '2026-01-01', 'recognition', NULL, 'shared')",
                         (SUBJ["id"], SUBJ["id"])).lastrowid
    _jdb.execute("INSERT INTO pm_evidence_links(evidence_id, target_kind, target_ref) VALUES (?,'kpi',?)",
                 (_feid, str(GP)))
    _jdb.commit()
    _just = a._review_justification(_jdb, dict(_jdb.execute("SELECT * FROM users WHERE id=?", (SUBJ["id"],)).fetchone()))
s.check("the recap includes real examples but SKIPS the file-only (empty-body) item",
        all((j["text"] or "").strip() for j in _just) and any("supplier" in (j["text"] or "") for j in _just), _just)

# ---------------------------------------------------------------------------
s.section("attach a supporting file to a review-logged evidence item")
import io as _io
_ev = tool("log_evidence", {"kpi_id": GP, "text": "Won the Bina Puri tender, RM 3.2m."})
_eid = _ev.get("evidence_id")
s.check("log_evidence returns the evidence_id (so the chat can attach)", isinstance(_eid, int), _ev)


def _attach(eid, name, data, uid=None):
    cl = H.client_as(a, uid if uid is not None else SUBJ["id"])
    return cl.post("/review/evidence/%s/attach" % eid,
                   data={"file": (_io.BytesIO(data), name), "csrf_token": "tok"},
                   content_type="multipart/form-data")


r = _attach(_eid, "proof.pdf", b"%PDF-1.4 evidence")
s.check("a PDF attaches to your own item",
        r.status_code == 200 and (r.get_json() or {}).get("ok") is True, r.get_json())
s.check("...the attachment row was written",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence_attachments WHERE evidence_id=?", (_eid,)) == 1)
s.check("a .exe is refused",
        (_attach(_eid, "x.exe", b"MZ").get_json() or {}).get("ok") is False)
s.check("an oversize file is refused",
        (_attach(_eid, "big.png", b"x" * (a.EVIDENCE_ATTACH_MAX_BYTES + 10)).get_json() or {}).get("ok") is False)
s.check("another person's item -> 404 (not theirs to attach to)",
        _attach(_eid, "p.pdf", b"%PDF", uid=OTHER["id"]).status_code == 404)
# 2026-09-24 (Chris): the refusals state the limits, so a multi-file pick can say why a file was skipped.
_exe_err = (_attach(_eid, "x.exe", b"MZ").get_json() or {}).get("error", "")
s.check("a wrong type's refusal names the accepted types", a.EVIDENCE_ATTACH_TYPES_TEXT in _exe_err, _exe_err)
_big_err = (_attach(_eid, "big.png", b"x" * (a.EVIDENCE_ATTACH_MAX_BYTES + 10)).get_json() or {}).get("error", "")
s.check("an oversize refusal names the size limit", "%d MB is the limit" % a.EVIDENCE_ATTACH_MAX_MB in _big_err, _big_err)
_cap_ids = []
for _ci in range(a.EVIDENCE_MAX_ATTACH_PER_ITEM - 1):     # the item already holds one file
    _cr = _attach(_eid, "cap%d.pdf" % _ci, b"%PDF-1.4 cap").get_json() or {}
    _cap_ids.append(_cr.get("count"))
s.check("files up to the cap attach (counts 2..4)", _cap_ids == [2, 3, 4], _cap_ids)
_over = _attach(_eid, "cap_over.pdf", b"%PDF-1.4 cap")
s.check("the file past the cap is refused, and the refusal says up to 4 files",
        _over.status_code == 400 and "up to 4 files" in ((_over.get_json() or {}).get("error") or ""),
        _over.get_json())
for _car in H.rows(a, "SELECT id FROM pm_evidence_attachments WHERE evidence_id=? AND filename LIKE 'cap%'",
                   (_eid,)):
    post(H.client_as(a, SUBJ["id"]), "/review/evidence/attachment/%d/delete" % _car[0])
s.check("...and the cap files are cleaned up (back to the one proof.pdf)",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence_attachments WHERE evidence_id=?", (_eid,)) == 1)
s.check("review_evidence_attach is classified 'evidence'",
        a.MODULE_ENDPOINTS.get("review_evidence_attach") == "evidence")

# ---------------------------------------------------------------------------
s.section("attachments surface on the KPI table + preview + remove")
# The overview line for GP (which now has an attached file via its linked evidence
# item) carries `eid` + `attachments`; a KPI with no evidence carries [].
_ovl = overview(SUBJ["id"])
_gp = next((l for l in _ovl if l["kpi_id"] == GP), None)
_dm = next((l for l in _ovl if l["kpi_id"] == DM), None)
_aid = H.one(a, "SELECT id FROM pm_evidence_attachments WHERE evidence_id=?", (_eid,))
s.check("the GP line carries its evidence id + one attachment",
        _gp and _gp.get("eid") == _eid and len(_gp.get("attachments") or []) == 1, _gp and _gp.get("attachments"))
s.check("...the attachment carries a filename + a preview url to the serve route",
        _gp["attachments"][0]["filename"] == "proof.pdf"
        and _gp["attachments"][0]["url"] == "/evidence/attachment/%d?disp=inline" % _aid,
        _gp["attachments"][0])
s.check("a KPI with no logged evidence carries an empty attachments list",
        _dm and _dm.get("attachments") == [] and _dm.get("eid") is None, _dm and _dm.get("attachments"))

# The serve route: ?disp=inline previews, default downloads.
_sc = H.client_as(a, SUBJ["id"])
_inl = _sc.get("/evidence/attachment/%d?disp=inline" % _aid)
s.check("?disp=inline serves the file inline (preview)",
        _inl.status_code == 200 and _inl.headers.get("Content-Disposition", "").startswith("inline"),
        _inl.headers.get("Content-Disposition"))
s.check("default serves as a download (back-compat)",
        _sc.get("/evidence/attachment/%d" % _aid).headers.get("Content-Disposition", "").startswith("attachment"))

# Remove: another person can't delete it; the author can, and the row + file go.
s.check("another person's attachment -> 404 (not theirs to remove)",
        post(H.client_as(a, OTHER["id"]), "/review/evidence/attachment/%d/delete" % _aid).status_code == 404)
s.check("...and it is still there",
        H.one(a, "SELECT COUNT(*) FROM pm_evidence_attachments WHERE id=?", (_aid,)) == 1)
# Once the check-in is CONFIRMED, a KPI's supporting file can't be removed (Chris, 2026-09-24: a submitted
# Above Expectation lost its only file after confirm, because the x stayed live and the route didn't check).
with a.app.app_context():
    _ldb = a.get_db()
    _had_lock = _ldb.execute("SELECT 1 FROM pm_review_session WHERE subject_id=? AND cycle_id=?",
                             (SUBJ["id"], CID)).fetchone()
    if not _had_lock:
        _ldb.execute("INSERT INTO pm_review_session(subject_id, cycle_id, locked_at, locked_by) "
                     "VALUES (?,?,datetime('now'),?)", (SUBJ["id"], CID, SUBJ["id"]))
    _ldb.commit()
_dlk = post(_sc, "/review/evidence/attachment/%d/delete" % _aid)
s.check("after the check-in is confirmed, removing a KPI's file is REFUSED (400) and the file stays",
        _dlk.status_code == 400 and "submitted" in ((_dlk.get_json() or {}).get("error") or "")
        and H.one(a, "SELECT COUNT(*) FROM pm_evidence_attachments WHERE id=?", (_aid,)) == 1,
        (_dlk.status_code, _dlk.get_json()))
with a.app.app_context():
    _ldb = a.get_db()
    if not _had_lock:
        _ldb.execute("DELETE FROM pm_review_session WHERE subject_id=? AND cycle_id=?", (SUBJ["id"], CID))
    _ldb.commit()
_del = post(_sc, "/review/evidence/attachment/%d/delete" % _aid)
s.check("the author removes their own attachment (ok + row gone)",
        (_del.get_json() or {}).get("ok") is True
        and H.one(a, "SELECT COUNT(*) FROM pm_evidence_attachments WHERE id=?", (_aid,)) == 0, _del.get_json())
s.check("...so the KPI line's attachments are now empty",
        (next((l for l in overview(SUBJ["id"]) if l["kpi_id"] == GP), {}).get("attachments")) == [])
s.check("review_evidence_attachment_delete is classified 'evidence'",
        a.MODULE_ENDPOINTS.get("review_evidence_attachment_delete") == "evidence")

# ---------------------------------------------------------------------------
s.section("set_checkin -- the quarterly trajectory (no number)")
r = tool("set_checkin", {"kpi_id": GP, "answer": "at_risk"})
s.check("ok", r.get("ok") is True, r)
s.check("a pm_checkins row exists",
        H.one(a, "SELECT answer FROM pm_checkins WHERE kpi_target_id=?", (GP,)) == "at_risk")
s.check("an answer outside the vocabulary is refused",
        tool("set_checkin", {"kpi_id": GP, "answer": "great"}).get("ok") is False)
s.check("...and there is deliberately no actual_value column on pm_checkins",
        "actual_value" not in [r[1] for r in H.rows(a, "SELECT * FROM pragma_table_info('pm_checkins')")])

# ---------------------------------------------------------------------------
s.section("submit gate: AE/OU need a FILE, and the overall remark is required (Chris, 2026-09-22)")
# GP is keyed at 16 -> Outstanding (its attachment was removed just above). A standout rating
# must carry a supporting FILE and the overall remark is required, so prepare_confirm is BLOCKED
# on the file first, then on the remark, then passes once both are there.
_pc0 = tool("prepare_confirm", {})
s.check("prepare_confirm is BLOCKED while a strong (OU) line has no supporting file",
        _pc0.get("ok") is False and "file" in _pc0.get("error", "").lower(), _pc0)


def ov_data(uid=None):
    uid = uid or SUBJ["id"]
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = uid
        db = a.get_db()
        u = dict(db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
        return a._review_kpi_overview(db, u)["data"], a._journey_kpi_steps(db, u), \
            a._review_remark_step_open(db, u)


# The one-tap attach list (Chris, 2026-09-23) is the SAME list the gate blocks on: GP (OU, no file)
# is in it, DM (BE) is not; the banner's Justification step agrees; the remark step is not open yet.
_od0, _st0, _ro0 = ov_data()
s.check("attach_needed lists exactly the OU line with no file (not the BE line)",
        [x["kpi_id"] for x in _od0.get("attach_needed", [])] == [GP], _od0.get("attach_needed"))
s.check("...each item carries the KPI NAME for the button label",
        (_od0.get("attach_needed") or [{}])[0].get("kpi") == "ZZ Gross Profit", _od0.get("attach_needed"))
s.check("the overview carries the caps the client pre-checks a multi-file pick against",
        _od0.get("attach_max") == a.EVIDENCE_MAX_ATTACH_PER_ITEM == 4
        and _od0.get("attach_max_bytes") == a.EVIDENCE_ATTACH_MAX_BYTES,
        (_od0.get("attach_max"), _od0.get("attach_max_bytes")))
s.check("drift check: the gate's missing-file names == attach_needed names",
        [x["kpi"] for x in _od0["attach_needed"]] == [n.strip() for n in
         _pc0.get("error", "").split("add one for:")[-1].split(",")], (_od0["attach_needed"], _pc0))
s.check("...and the banner's Justification step is NOT done while a file is owed",
        next(x for x in _st0 if x["key"] == "justify")["done"] is False, _st0)
s.check("the remark step is NOT open while a standout still owes a file", _ro0 is False)
attach_file(GP)
_od1, _st1, _ro1 = ov_data()
s.check("once GP has its file, attach_needed is EMPTY", _od1.get("attach_needed") == [], _od1.get("attach_needed"))
s.check("...and the remark step is now OPEN (every own line keyed, no file owed, no remark yet)",
        _ro1 is True)
_pc1 = tool("prepare_confirm", {})
s.check("...file added, now BLOCKED on the missing overall remark",
        _pc1.get("ok") is False and "remark" in _pc1.get("error", "").lower(), _pc1)
set_remark("A strong year: I held margin on the Top 3 accounts and beat the delivery target.")
s.check("...and passes once the strong line has a file AND the remark is written",
        tool("prepare_confirm", {}).get("ok") is True)
_od2, _st2, _ro2 = ov_data()
s.check("with the remark written, the remark step is closed again", _ro2 is False)
with a.app.app_context():
    _edb = a.get_db()
    _edb.execute("UPDATE cycle_modules SET active=0 WHERE module_key='evidence'")
    _edb.execute("DELETE FROM pm_evidence_attachments WHERE evidence_id IN (SELECT e.id FROM pm_evidence e "
                 "JOIN pm_evidence_links l ON l.evidence_id=e.id WHERE l.target_kind='kpi' AND l.target_ref=?)",
                 (str(GP),))
    _edb.commit()
_od3, _, _ = ov_data()
s.check("with the evidence module OFF, attach_needed is empty even for a file-less OU line (the gate is off too)",
        _od3.get("attach_needed") == [], _od3.get("attach_needed"))
with a.app.app_context():
    _edb = a.get_db()
    _edb.execute("UPDATE cycle_modules SET active=1 WHERE module_key='evidence'")
    _edb.commit()
attach_file(GP)   # restore GP's file for the sections below

# ---------------------------------------------------------------------------
s.section("prepare_confirm -- shows the sign-off card, writes NOTHING (the lock is /review/confirm)")
pc = tool("prepare_confirm", {})
s.check("ok + a confirm render payload",
        pc.get("ok") and pc.get("render", {}).get("type") == "confirm", pc)
s.check("the confirm card carries the final scorecard lines",
        len(pc.get("render", {}).get("data", {}).get("lines", [])) >= 1, pc)
s.check("...and drafts are NOT promoted -- still amendable until the person confirms",
        H.one(a, "SELECT MIN(draft) FROM pm_kpi_results WHERE kpi_target_id IN (?,?)", (GP, DM)) == 1)
s.check("submit_results is retired -- the agent can no longer lock silently",
        "submit_results" not in a._REVIEW_TOOLS)

# ---------------------------------------------------------------------------
s.section("save_career -- the second conversational tool (career profiling)")
s.check("an aspiration is saved",
        tool("save_career", {"field": "aspiration_now", "value": "Lead the delivery team"}).get("ok") is True)
s.check("...and stored on the profile",
        H.one(a, "SELECT aspiration_now FROM pm_career_profile WHERE subject_id=?",
              (SUBJ["id"],)) == "Lead the delivery team")
s.check("a valid mobility is saved",
        tool("save_career", {"field": "mobility", "value": "within_bg"}).get("ok") is True)
s.check("an invalid mobility value is refused",
        tool("save_career", {"field": "mobility", "value": "anywhere"}).get("ok") is False)
s.check("an unknown career field is refused",
        tool("save_career", {"field": "salary", "value": "more"}).get("ok") is False)
with a.app.app_context():
    s.check("the profile now reads complete (mobility + an aspiration)",
            a.pm_career_is_complete(a.get_db(), SUBJ["id"]) is True)

# ---------------------------------------------------------------------------
s.section("show_scorecard -- a renderable card, figures from the server")
sc = tool("show_scorecard", {})
s.check("ok + a scorecard render payload",
        sc.get("ok") and sc.get("render", {}).get("type") == "scorecard", sc)
s.check("it carries the KPI lines", len(sc["render"]["data"]["lines"]) >= 1,
        sc["render"]["data"])
s.check("the model is fed a compact result, not the bulky render",
        "displayed" in sc and sc["displayed"] == "scorecard")

# ---------------------------------------------------------------------------
s.section("show_kpis is retired -- the KPI table is pinned at the top, not rendered on request")
s.check("show_kpis is no longer a registered review tool", "show_kpis" not in a._REVIEW_TOOLS)
sk = tool("show_kpis", {})
s.check("...calling it is refused as an unknown tool", sk.get("ok") is False, sk)

# ---------------------------------------------------------------------------
s.section("the JSON-turn parser")
p = ai_draft._parse_turn('{"say":"Hi there","quick_replies":["Yes","No"],"action":null}')
s.check("parses say + quick_replies", p["say"] == "Hi there" and p["quick_replies"] == ["Yes", "No"])
s.check("action null stays null", p["action"] is None)
p2 = ai_draft._parse_turn('Sure! Here it is:\n{"say":"ok","action":{"tool":"prepare_confirm","args":{}}}')
s.check("finds the JSON even with prose around it", p2["say"] == "ok" and p2["action"]["tool"] == "prepare_confirm")
p3 = ai_draft._parse_turn('{"say":"x","action":{"noselect":1}}')
s.check("an action without a tool is dropped to null", p3["action"] is None)
# gpt-4o-mini sometimes spells a no-op as {"tool":"null"} instead of action:null.
p4 = ai_draft._parse_turn('{"say":"confirm?","action":{"tool":"null","args":{}}}')
s.check('a {"tool":"null"} no-op is dropped to null', p4["action"] is None)
p5 = ai_draft._parse_turn('{"say":"y","action":{"tool":"none"}}')
s.check('a {"tool":"none"} no-op is dropped to null', p5["action"] is None)
try:
    ai_draft._parse_turn("there is no json here at all")
    s.check("garbled output raises", False)
except ai_draft.AIDraftError:
    s.check("garbled output raises", True)

# ---------------------------------------------------------------------------
s.section("review_agent retries a transient failure, fails fast on a config error")
_cc, _isc, _cli = ai_draft._chat_complete, ai_draft.is_configured, ai_draft.review_cli_enabled
try:
    ai_draft.is_configured = lambda: True
    ai_draft.review_cli_enabled = lambda: False
    calls = {"n": 0}

    def flaky(system, user, max_tokens, timeout):   # transient the first time, ok after
        calls["n"] += 1
        if calls["n"] == 1:
            # a connection reset -- a timeout is deliberately NOT retried (a second 25s try can't fit behind nginx's
            # 60s; test_ai_review holds that rule)
            raise ai_draft.AIDraftError("Network error reaching Azure OpenAI: [Errno 104] Connection reset by peer")
        return '{"say":"ok","quick_replies":[],"action":null}'
    ai_draft._chat_complete = flaky
    t = ai_draft.review_agent("sys", [{"role": "user", "content": "hi"}])
    s.check("a transient failure is retried, then succeeds",
            t.get("say") == "ok" and calls["n"] == 2, (t, calls))

    calls["n"] = 0

    def perm(system, user, max_tokens, timeout):    # permanent config error
        calls["n"] += 1
        raise ai_draft.AIDraftError("Azure OpenAI HTTP 404: DeploymentNotFound")
    ai_draft._chat_complete = perm
    raised = False
    try:
        ai_draft.review_agent("sys", [{"role": "user", "content": "hi"}])
    except ai_draft.AIDraftError:
        raised = True
    s.check("a 404 config error fails fast (one attempt, no retry)", raised and calls["n"] == 1, calls)
finally:
    ai_draft._chat_complete, ai_draft.is_configured, ai_draft.review_cli_enabled = _cc, _isc, _cli

# ---------------------------------------------------------------------------
s.section("_chat_complete adapts its params to the model (GPT-5 vs chat)")
import json as _json
import urllib.request as _ur


class _Resp:
    def __init__(self, b): self._b = b.encode()
    def read(self): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False


_cap = {}


def _fake_open(req, timeout=None):
    _cap["body"] = _json.loads(req.data.decode())
    return _Resp('{"choices":[{"message":{"content":"hi"}}]}')


_ocfg, _ouo = ai_draft._cfg, _ur.urlopen
try:
    _ur.urlopen = _fake_open
    ai_draft._cfg = lambda: ("https://x", "k", "gpt-5-mini", "2024-10-21")
    ai_draft._chat_complete("s", "u", 500, 30)
    p = _cap["body"]
    s.check("gpt-5 -> max_completion_tokens, not max_tokens",
            p.get("max_completion_tokens") == 500 and "max_tokens" not in p, p)
    s.check("gpt-5 -> reasoning_effort minimal, no custom temperature",
            p.get("reasoning_effort") == "minimal" and "temperature" not in p, p)
    ai_draft._cfg = lambda: ("https://x", "k", "gpt-4o-mini", "2024-10-21")
    ai_draft._chat_complete("s", "u", 500, 30)
    p2 = _cap["body"]
    s.check("chat model -> max_tokens + temperature (unchanged)",
            p2.get("max_tokens") == 500 and "temperature" in p2
            and "max_completion_tokens" not in p2, p2)
finally:
    ai_draft._cfg, _ur.urlopen = _ocfg, _ouo

# ---------------------------------------------------------------------------
s.section("the dev CLI bridge is guarded -- never on a VM")
_saved = {k: os.environ.get(k) for k in ("REVIEW_AGENT_CLI", "L360_PROD")}
try:
    os.environ["REVIEW_AGENT_CLI"] = "1"; os.environ.pop("L360_PROD", None)
    s.check("flagged + not prod -> the CLI bridge is available", ai_draft.review_cli_enabled() is True)
    os.environ["L360_PROD"] = "1"
    s.check("flagged BUT prod -> refused (staging/prod set L360_PROD=1)",
            ai_draft.review_cli_enabled() is False)
    os.environ.pop("REVIEW_AGENT_CLI", None); os.environ.pop("L360_PROD", None)
    s.check("not flagged -> refused", ai_draft.review_cli_enabled() is False)
finally:
    for k, v in _saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

# ---------------------------------------------------------------------------
s.section("the agent loop -- a stubbed model proposes, the server executes")
_avail, _agent = ai_draft.review_agent_available, ai_draft.review_agent
SCRIPT = []


def stub_agent(system, messages, timeout=90):
    return SCRIPT.pop(0)


ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = stub_agent
try:
    with a.app.app_context():
        a.get_db().execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (DM,))
        a.get_db().execute("DELETE FROM pm_review_chat WHERE subject_id=?", (SUBJ["id"],))
        a.get_db().commit()
    E = H.client_as(a, SUBJ["id"])
    # turn 1 records a KPI; turn 2 (after the tool result) speaks and stops.
    SCRIPT[:] = [
        {"say": "Got it.", "quick_replies": [],
         "action": {"tool": "record_kpi_result", "args": {"kpi_id": DM, "actual_value": "4"}}},
        {"say": "Recorded — that's a 4 of 5. Anything else?", "quick_replies": ["All done"],
         "action": None},
    ]
    resp = post(E, "/review/chat", message="deliveries came in at 4").get_json()
    s.check("the loop ran the tool then returned the final say",
            resp.get("say", "").startswith("Recorded"), resp)
    s.check("...the proposed write actually landed (server executed it)",
            H.one(a, "SELECT actual_value FROM pm_kpi_results WHERE kpi_target_id=?", (DM,)) == 4.0)
    s.check("...the quick_replies are returned", resp.get("quick_replies") == ["All done"])
    s.check("...and a fresh rail comes back for the live update", "rail_html" in resp)
    s.check("the transcript persisted (user + agent)",
            H.one(a, "SELECT COUNT(*) FROM pm_review_chat WHERE subject_id=?", (SUBJ["id"],)) >= 2)
    # quick_replies persist on the stored agent row
    s.check("the agent row stored its quick_replies",
            "All done" in (H.one(a, "SELECT quick_replies FROM pm_review_chat WHERE subject_id=? "
                                  "AND role='agent' ORDER BY id DESC LIMIT 1", (SUBJ["id"],)) or ""))
    # The KPI table is PINNED at the top now, so asking to see it must NOT append a
    # second inline table (the old "two tables" bug) -- the pinned `overview`
    # payload, returned every turn, is what carries it.
    SCRIPT[:] = [{"say": "Your KPIs are pinned at the top.",
                  "quick_replies": [], "action": None}]
    r2 = post(E, "/review/chat", message="can you show me my KPIs?").get_json()
    s.check("asking to see KPIs renders NO second inline table",
            not any(x.get("type") == "kpi_overview" for x in (r2.get("renders") or [])), r2)
    s.check("...the pinned overview is still returned every turn",
            r2.get("overview") and len(r2["overview"]["lines"]) >= 1, r2.get("overview"))
    SCRIPT[:] = [{"say": "Sure thing.", "quick_replies": [], "action": None}]
    r3 = post(E, "/review/chat", message="thanks, that's helpful").get_json()
    s.check("a normal message also renders no inline table",
            not any(x.get("type") == "kpi_overview" for x in (r3.get("renders") or [])), r3)
    # A bare value must never be offered as a one-tap chip on a result-entry turn
    # (tapping "16" would record a fake figure), and the redundant "I'll type it"
    # chip is dropped too -- both stripped server-side regardless of the model.
    # Real action chips (Skip, Need an example) survive.
    SCRIPT[:] = [{"say": "What did Gross Profit come in at?",
                  "quick_replies": ["16", "15.5", "I'll type it", "Need an example", "Skip"],
                  "action": None}]
    r4 = post(E, "/review/chat", message="let's do gross profit").get_json()
    _qr4 = r4.get("quick_replies") or []
    s.check("bare-number quick replies are stripped",
            not any(re.match(r"^\s*[-+]?[\d.,]+\s*$", str(q)) for q in _qr4), _qr4)
    s.check("...the 'I'll type it' chip is stripped",
            not any(re.search(r"type it", str(q), re.I) for q in _qr4), _qr4)
    s.check("...but Skip and other action chips survive",
            "Skip" in _qr4 and "Need an example" in _qr4, _qr4)
    # A confirm card is TERMINAL: a model that re-calls prepare_confirm every turn must NOT stack
    # duplicate cards. Make prepare_confirm READY (both AE/OU lines keyed + a supporting FILE, and
    # the overall remark written), feed TWO prepare_confirm turns, assert ONE card + the loop broke.
    with a.app.app_context():
        db = a.get_db()
        for kid, val in ((GP, 16.0), (DM, 4.0)):   # 16 -> OU, 4 -> AE (both standout)
            if db.execute("SELECT 1 FROM pm_kpi_results WHERE kpi_target_id=?", (kid,)).fetchone():
                db.execute("UPDATE pm_kpi_results SET actual_value=?, draft=1 WHERE kpi_target_id=?", (val, kid))
            else:
                db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) "
                           "VALUES (?,?,?,1)", (kid, val, SUBJ["id"]))
        db.commit()
    attach_file(GP); attach_file(DM)
    set_remark("A solid year -- held margin on the Top 3 accounts and hit the delivery target.")
    SCRIPT[:] = [
        {"say": "Let's lock it in.", "quick_replies": [], "action": {"tool": "prepare_confirm", "args": {}}},
        {"say": "Again.", "quick_replies": [], "action": {"tool": "prepare_confirm", "args": {}}},
    ]
    rc = post(E, "/review/chat", message="all done, confirm").get_json()
    _cc = [x for x in (rc.get("renders") or []) if x.get("type") == "confirm"]
    s.check("prepare_confirm renders EXACTLY ONE card (no duplicate stacking)", len(_cc) == 1, len(_cc))
    s.check("...the second prepare_confirm turn was never consumed (the loop broke)", len(SCRIPT) == 1, len(SCRIPT))
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _avail, _agent

# ---------------------------------------------------------------------------
# OWN WORDS (Chris, 2026-09-24: "make sure all our remark writing does not create hallucination").
# Probed on gpt-5-mini: coaching a KPI remark, the model saved -- without asking -- "I led outreach to
# ten prospects ... negotiated with two vendors", none of which the person said. Every agent tool that
# saves free text as a person's words now runs _person_text_guard in its loop.
s.section("own words: no agent saves text the person never gave (every remark / note / justification path)")
_regs = {}   # tool name -> EVERY registered function of that name (the employee's and the manager's
             # set_competency share a name)
for _reg in [getattr(a, _nm) for _nm in ("_REVIEW_TOOLS", "_TC_TOOLS", "_CAREER_TOOLS", "_FEEDBACK_TOOLS",
                                         "_CALIB_TOOLS", "_TB_TOOLS")] + list(a._MANAGER_STAGE_TOOLS.values()):
    for _tn, _fn in _reg.items():
        _regs.setdefault(_tn, []).append(_fn)
s.check("every guarded tool is a real registered tool (no stale names)",
        all(t in _regs for t in a._PERSON_TEXT_TOOLS), [t for t in a._PERSON_TEXT_TOOLS if t not in _regs])
_insp = __import__("inspect")
_reads = lambda t, ans: any('args.get("%s"' % an in _insp.getsource(fn) for fn in _regs[t] for an in ans)
s.check("...and each reads the argument the guard checks (the text can't slip in under another name)",
        all(_reads(t, ans) for t, ans in a._PERSON_TEXT_TOOLS.items()),
        [t for t, ans in a._PERSON_TEXT_TOOLS.items() if not _reads(t, ans)])
s.check("the manager's, calibrator's, rater's and employee's text tools are all covered",
        all(t in a._PERSON_TEXT_TOOLS for t in (
            "set_overall_remark", "log_evidence", "set_overall_note", "draft_reflection", "set_competency",
            "set_field", "save_career", "set_feedback_remark", "set_report_remark", "moderate_kpi",
            "lock_kpi", "comment_goal", "comment_plan", "comment_career", "move_band")))
s.check("...close_plan writes no one's words any more (Approve plan takes no note, 2026-10-21)",
        "close_plan" not in a._PERSON_TEXT_TOOLS)
_loops = ("review_chat", "review_competency_chat", "review_career_chat", "_journey_chat_turn",
          "_journey_team_chat_turn", "pm_calib_chat")
s.check("EVERY agent loop runs the guard before dispatching a tool",
        all("_person_text_guard(history, action" in _insp.getsource(getattr(a, f)) for f in _loops),
        [f for f in _loops if "_person_text_guard(history, action" not in _insp.getsource(getattr(a, f))])
_G = a._person_text_guard
_h = [{"role": "user", "content": "Move Ali up to High."}]
s.check("calibrator: a made-up justification is refused (they gave no reason)",
        _G(_h, {"tool": "move_band", "args": {"subject": "Ali", "band": "High",
                                             "justification": "Consistently over-delivered on three major accounts"}}) is not None)
s.check("...their own reason passes",
        _G([{"role": "user", "content": "Move Ali up to High -- he carried the plant shutdown recovery."}],
           {"tool": "move_band", "args": {"justification": "Carried the plant shutdown recovery."}}) is None)
s.check("...a fact a tool returned THIS turn counts (the evidence explain_person showed)",
        _G(_h + [{"role": "tool", "content": '{"evidence": "Led the plant shutdown recovery in March"}'}],
           {"tool": "move_band", "args": {"justification": "Led the plant shutdown recovery in March"}}) is None)
s.check("...but a previous refusal never 'grounds' the words it listed",
        _G(_h + [{"role": "tool", "content": '{"ok": false, "error": "NOT SAVED -- that wording adds things '
                                              'they did not say: accounts, consistently, delivered, major"}'}],
           {"tool": "move_band", "args": {"justification": "Consistently over-delivered on three major accounts"}}) is not None)
s.check("manager: a remark with an invented figure is refused",
        _G([{"role": "user", "content": "She did well on margin this half."}],
           {"tool": "set_report_remark", "args": {"remark": "She did well on margin this half, up 12%."}}) is not None)
s.check("a choice field (mobility) is not prose -- skipped",
        _G([], {"tool": "set_field", "args": {"field": "mobility", "value": "within_bg"}}) is None)
s.check("an untouched tool (a rating) is not checked",
        _G([], {"tool": "record_kpi_result", "args": {"kpi_id": 1, "actual_value": "16"}}) is None)
s.check("the shared prompt rule tells every agent: their own words, or wording they said yes to",
        "THEIR OWN WORDS" in a._AGENT_SCOPE_GUARD and "ASK them for it" in a._AGENT_SCOPE_GUARD)
_cps = a._pm_calib_assist_system.__code__.co_consts
_cpsrc = _insp.getsource(a._pm_calib_assist_system)
s.check("the calibration prompt no longer tells the model to 'ALWAYS include a justification' of its own",
        "include a justification)" not in _cpsrc and "OWN reason" in _cpsrc and "never make one" in _cpsrc)

def _remark_now():
    return H.one(a, "SELECT remark FROM pm_overall_remarks WHERE subject_id=? AND cycle_id=?", (SUBJ["id"], CID))
_inv = "I led outreach to ten prospects and negotiated with two vendors, lifting margin in every region."
_prev = _remark_now()
ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = stub_agent
try:
    E = H.client_as(a, SUBJ["id"])
    _save = lambda txt: {"tool": "set_overall_remark", "args": {"text": txt}}
    SCRIPT[:] = [{"say": "Saved your remark.", "quick_replies": [], "action": _save(_inv)},
                 {"say": "Here's what I'd write -- does it read right?", "quick_replies": [], "action": None}]
    _r = post(E, "/review/chat", message="It was a steady half.").get_json()
    s.check("standalone check-in: an invented KPI remark is NOT saved", _remark_now() == _prev, _remark_now())
    s.check("...and the reply is the model's follow-up (asking), not its false 'Saved'",
            (_r.get("say") or "").startswith("Here's what I'd write"), _r.get("say"))
    _own = "Demand was slow in Q2 but I kept supplier costs flat and we held margin."
    SCRIPT[:] = [{"say": "Saved.", "quick_replies": [], "action": _save(_own)},
                 {"say": "Done -- that's on the record.", "quick_replies": [], "action": None}]
    post(E, "/review/chat", message=_own)
    s.check("...their OWN words save", _remark_now() == _own, _remark_now())
    _draft = ("Demand was slow in Q2, so I held supplier costs flat and protected margin -- a steady half "
              "in a soft market.")
    SCRIPT[:] = [{"say": 'Here is a tighter version: "%s" -- does that read right?' % _draft,
                  "quick_replies": [], "action": None}]
    post(E, "/review/chat", message="can you tighten it up?")
    SCRIPT[:] = [{"say": "Saved.", "quick_replies": [], "action": _save(_draft)},
                 {"say": "Done.", "quick_replies": [], "action": None}]
    post(E, "/review/chat", message="yes, save it")
    s.check("...a draft they said yes to saves (light rewording of their words is fine)",
            _remark_now() == _draft, _remark_now())
    SCRIPT[:] = [{"say": "I've saved it!", "quick_replies": ["Great"], "action": _save(_inv)}
                 for _ in range(ai_draft.REVIEW_AGENT_MAX_TOOLS + 2)]
    _rl = post(E, "/review/chat", message="whatever you think").get_json()
    s.check("a model that keeps trying to save invented text ends on 'not saved yet' -- never its false claim",
            _rl.get("say") == a._GUARD_FALLBACK_SAY and _remark_now() == _draft, (_rl.get("say"), _remark_now()))
    SCRIPT[:] = [{"say": "Saved.", "quick_replies": [], "action": _save(_inv)},
                 {"say": "Here's a draft -- does it read right?", "quick_replies": [], "action": None}]
    post(E, "/review/chat?journey=1", message="It was a steady half.", stage="account")
    s.check("journey check-in: the same invented remark is NOT saved", _remark_now() == _draft, _remark_now())
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _avail, _agent

# ---------------------------------------------------------------------------
s.section("degradation -- no model reachable, an honest reply not a broken chat")
# In the fixture Azure is unconfigured and REVIEW_AGENT_CLI is unset, so the
# agent is genuinely unavailable -- the route must say so, never 500.
E = H.client_as(a, SUBJ["id"])
j = post(E, "/review/chat", message="hello").get_json()
s.check("review_agent_available is False in the fixture", ai_draft.review_agent_available() is False)
s.check("the route replies honestly, not an error",
        j.get("ok") and "switched on" in j.get("say", "").lower(), j)
# ABSENT is not EMPTY: a degraded turn must still carry an overview so the client
# doesn't wipe the pinned KPI table (the bug fixed for IDP, now fixed here too).
s.check("...a degraded turn STILL carries an overview", "overview" in j, list(j))
_avail_g, _agent_g = ai_draft.review_agent_available, ai_draft.review_agent


def _boom(system, messages, timeout=90):
    raise ai_draft.AIDraftError("simulated transient failure")


ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = _boom
try:
    rerr = post(H.client_as(a, SUBJ["id"]), "/review/chat", message="hi").get_json()
    s.check("a model ERROR mid-conversation still carries an overview (widget not wiped)",
            "overview" in rerr, list(rerr))
    # what staff SEE is counted (7 Nov 2026): ONE counts-only line per "lost the thread" reply, the label only
    import logging as _logging

    class _Cap(_logging.Handler):
        def __init__(self):
            super().__init__(_logging.WARNING)
            self.rec = []

        def emit(self, record):
            self.rec.append(record.getMessage())
    _cap, _lg = _Cap(), _logging.getLogger("onehr.ai")
    _lvl = _lg.level
    _lg.addHandler(_cap)
    _lg.setLevel(_logging.WARNING)
    try:
        rl = post(H.client_as(a, SUBJ["id"]), "/review/chat", message="a private sentence PRIVATE-XYZ").get_json()
        s.check("the review chat's reply is unchanged, and ONE counts-only line says it was shown",
                rl.get("say") == "Sorry -- I lost the thread there. Could you say that again?"
                and _cap.rec == ["OneHR AI chat lost the thread: stage=review"], (rl.get("say"), _cap.rec))
        s.check("...nothing of the message, name or ID in the log", not any(
            w in m for m in _cap.rec for w in ("PRIVATE-XYZ", SUBJ["full_name"], str(SUBJ["employee_id"]))), _cap.rec)
    finally:
        _lg.removeHandler(_cap)
        _lg.setLevel(_lvl)
finally:
    ai_draft.review_agent_available, ai_draft.review_agent = _avail_g, _agent_g
_js = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                        "static", "review_chat.js"), encoding="utf-8").read()
s.check("the client ignores an ABSENT overview rather than clearing on it",
        "if (data === undefined) return;" in _js)

# ---------------------------------------------------------------------------
s.section("in-chat KPI check-in: bulk save + justification + summarised remark")
E2 = H.client_as(a, SUBJ["id"])
with a.app.app_context():
    db = a.get_db()
    db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (?,?)", (GP, DM))
    db.execute("DELETE FROM pm_overall_remarks WHERE cycle_id=? AND subject_id=?", (CID, SUBJ["id"]))
    db.execute("DELETE FROM pm_review_session WHERE cycle_id=? AND subject_id=?", (CID, SUBJ["id"]))
    db.commit()
# The Save-results button: bulk-record ALL keyed results as DRAFT, server-side.
r = post(E2, "/review/kpi/save-all",
         **{("actual_value_%d" % GP): "16", ("actual_value_%d" % DM): "4"}).get_json()
s.check("save-all records the filled results", len(r.get("recorded", [])) == 2, r)
s.check("...as DRAFT, not submitted",
        H.one(a, "SELECT draft FROM pm_kpi_results WHERE kpi_target_id=?", (GP,)) == 1)
s.check("...with the value", H.one(a, "SELECT actual_value FROM pm_kpi_results WHERE kpi_target_id=?", (GP,)) == 16.0)
post(E2, "/review/kpi/save-all", **{("actual_value_%d" % OTHER_KPI): "3"})
s.check("save-all cannot write a KPI that is not the caller's own",
        H.one(a, "SELECT COUNT(*) FROM pm_kpi_results WHERE kpi_target_id=?", (OTHER_KPI,)) == 0)
# The GENERAL overall remark (draft).
s.check("set_overall_remark stores a draft summarised remark",
        tool("set_overall_remark", {"text": "Strong half overall — GP well ahead."}).get("ok") is True)
s.check("...as draft=1",
        H.one(a, "SELECT draft FROM pm_overall_remarks WHERE cycle_id=? AND subject_id=?",
              (CID, SUBJ["id"])) == 1)
# ~100-word target with a GENEROUS ceiling (Chris, 2026-09-22): an essay is rejected (never
# silent-trimmed so the person's words aren't cut mid-sentence); a short paragraph is fine.
s.check("set_overall_remark REJECTS a wall of text (generous word cap)",
        tool("set_overall_remark", {"text": " ".join(["word"] * (a._REVIEW_REMARK_MAX_WORDS + 40))}).get("ok") is False)
s.check("...but accepts a ~90-word paragraph",
        tool("set_overall_remark", {"text": " ".join(["word"] * 90)}).get("ok") is True)
tool("set_overall_remark", {"text": "Strong half overall — GP well ahead."})   # restore the real one

# The per-KPI NOTE step is RETIRED (2026-09-22): a standout KPI's evidence is a FILE attached to
# it (has_attachment), not a written note; draft_kpi_note / set_kpi_note / the writer / the route
# are all gone. _looks_like_placeholder STAYS (shared by the competency draft-reflection card).
s.check("draft_kpi_note and set_kpi_note are both retired (not registered tools)",
        "draft_kpi_note" not in a._REVIEW_TOOLS and "set_kpi_note" not in a._REVIEW_TOOLS)
_src0 = H.source(a)
s.check("the note tool / writer / route are gone from the source",
        all(x not in _src0 for x in ("def _review_tool_draft_kpi_note(",
                                     "def _review_save_kpi_note(", "def review_kpi_note(")))
s.check("_looks_like_placeholder still catches a template + clears a real sentence",
        a._looks_like_placeholder("[Please replace this]") and a._looks_like_placeholder("<your note here>")
        and not a._looks_like_placeholder("Pricing changes to the Top 3 accounts drove it."))

# GP (OU) and DM (AE) both landed high -> both need a supporting FILE before submit. Attach one each.
attach_file(GP); attach_file(DM)
with a.app.test_request_context("/"):
    from flask import session as _rsess
    _rsess["user_id"] = SUBJ["id"]
    _rdb = a.get_db()
    _ru = _rdb.execute("SELECT * FROM users WHERE id=?", (SUBJ["id"],)).fetchone()
    _ovd = a._review_kpi_overview(_rdb, dict(_ru))["data"]
    _scd = a._review_tool_show_scorecard(_rdb, dict(_ru), CID, {})["render"]["data"]
    _lines = a._review_kpi_lines(_rdb, dict(_ru))
s.check("the overview no longer carries a per-KPI note field",
        all("note" not in l for l in _ovd["lines"]), _ovd["lines"][:1])
s.check("...but carries the overall remark in the envelope",
        "GP well ahead" in (_ovd.get("overall_remark") or ""), _ovd.get("overall_remark"))
s.check("the agent's KPI lines carry has_attachment (not a note), True once a file is attached",
        all("note" not in l and "has_attachment" in l for l in _lines)
        and any(l["kpi_id"] == GP and l["has_attachment"] for l in _lines), _lines[:1])
s.check("the scorecard line no longer carries a per-KPI note",
        all("note" not in l for l in _scd["lines"]), _scd["lines"][:1])
# prepare_confirm is ready (both AE/OU lines attached, remark written) + carries the remark.
pc = tool("prepare_confirm", {})
s.check("prepare_confirm is ready and carries the summarised remark",
        pc.get("ready") and "GP well ahead" in (pc.get("render", {}).get("data", {}).get("overall_remark") or ""), pc)

# client: the remark block is OVERALL-only, and the KPI note card + per-line note are gone.
_jjs = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                         "static", "journey_chat.js"), encoding="utf-8").read()
# 2026-09-23 (Chris): the KPI card no longer carries an "Overall remark / + Add a remark" row -- the
# remark has its own guided step (the remark-guide card) and the saved text shows on the confirm card.
s.check("the KPI card has NO overall-remark row (renderOverallRemark / overallRemarkBox gone)",
        "renderOverallRemark" not in _jjs and "overallRemarkBox" not in _jjs and "rv-remark-tag-kpi" not in _jjs)
s.check("...while the confirm card still shows the saved remark (scorecardTable 'Overall remark')",
        'rh.textContent = "Overall remark"' in _jjs and "d.overall_remark" in _jjs)
s.check("the KPI draft-note card + its /review/kpi/note Save are gone from the client",
        "kpiNoteDraftCard" not in _jjs and '"/review/kpi/note"' not in _jjs)
s.check("the scorecard no longer renders a per-KPI note / 'No note added'",
        "rv-sc-note" not in _jjs and "No note added" not in _jjs)

# The two extra gates (each AE/OU line has a FILE + the overall remark is written) are enforced
# at BOTH prepare_confirm (which renders the card) AND /review/confirm (the true, server-enforced
# lock) through ONE shared predicate, so a crafted POST straight to /review/confirm can't bypass
# them -- the old note gate lived ONLY in prepare_confirm.
s.section("the submit gates are enforced at the true lock, via one shared predicate")
_src2 = H.source(a)
s.check("_review_submit_blockers is the ONE predicate, called by prepare_confirm AND review_confirm",
        "def _review_submit_blockers(" in _src2
        and _src2.count("_review_submit_blockers(db, u, cid, mine)") >= 2)
# Live: drop the remark -> POST /review/confirm is refused AT THE ROUTE (not just prepare_confirm).
with a.app.app_context():
    _cdb = a.get_db()
    _cdb.execute("DELETE FROM pm_overall_remarks WHERE cycle_id=? AND subject_id=?", (CID, SUBJ["id"]))
    _cdb.commit()
_rc0 = post(E2, "/review/confirm")
s.check("POST /review/confirm is BLOCKED (400) when the overall remark is missing",
        _rc0.status_code == 400 and "remark" in (_rc0.get_json() or {}).get("error", "").lower(),
        _rc0.get_json())
set_remark("Strong half overall — GP well ahead.")   # restore for the successful confirm below

# The human Confirm submits: results AND remark -> draft=0, session locked.
rc = post(E2, "/review/confirm").get_json()
s.check("confirm submits the results (draft->0)",
        rc.get("ok") and H.one(a, "SELECT draft FROM pm_kpi_results WHERE kpi_target_id=?", (GP,)) == 0)
s.check("...and promotes the summarised remark to the approver (draft->0)",
        H.one(a, "SELECT draft FROM pm_overall_remarks WHERE cycle_id=? AND subject_id=?",
              (CID, SUBJ["id"])) == 0)

# ---------------------------------------------------------------------------
s.section("classification + one write")
for ep in ("review_chat", "review_chat_history"):
    s.check("%s is classified 'review'" % ep, a.MODULE_ENDPOINTS.get(ep) == "review")
with a.app.app_context():
    a.get_db().execute("UPDATE cycle_modules SET active=0 WHERE module_key='review'")
    a.get_db().commit()
s.check("review off -> /review/chat 404s", post(E, "/review/chat", message="x").status_code == 404)
with a.app.app_context():
    a.get_db().execute("UPDATE cycle_modules SET active=1 WHERE module_key='review'")
    a.get_db().commit()

# ---------------------------------------------------------------------------
s.section("once the check-in is LOCKED, the journey prompt suggests 360 / competency")
def _journey_kpi_prompt(locked):
    # review_state -> current_user reads the session, so run in a request context.
    with a.app.test_request_context("/"):
        from flask import session as _sess
        _sess["user_id"] = SUBJ["id"]
        _db = a.get_db()
        _db.execute("DELETE FROM pm_review_session WHERE subject_id=? AND cycle_id=?", (SUBJ["id"], CID))
        # results amendable (draft=1) so pm_review_locked is driven ONLY by the lock
        # row (an earlier test promoted these to draft=0, which also reads as locked).
        _db.execute("UPDATE pm_kpi_results SET draft=1 WHERE kpi_target_id IN "
                    "(SELECT id FROM pm_kpi_targets WHERE subject_id=? AND cycle_id=?)", (SUBJ["id"], CID))
        if locked:
            _db.execute("INSERT OR REPLACE INTO pm_review_session(subject_id, cycle_id, locked_at, locked_by) "
                        "VALUES (?,?,datetime('now'),?)", (SUBJ["id"], CID, SUBJ["id"]))
        _db.commit()
        _u = dict(_db.execute("SELECT * FROM users WHERE id=?", (SUBJ["id"],)).fetchone())
        p = a._review_agent_system(_db, _u, a.review_state(_db, _u), journey=True)
        _db.execute("DELETE FROM pm_review_session WHERE subject_id=? AND cycle_id=?", (SUBJ["id"], CID))
        _db.commit()
        return p
_open = _journey_kpi_prompt(False)
_locked = _journey_kpi_prompt(True)
s.check("locked -> the prompt offers 360 feedback / competency next",
        "LOCKED" in _locked and "360 feedback" in _locked and "competency" in _locked)
s.check("locked -> it must NOT re-open the check-in (no prepare_confirm again)",
        "not call prepare_confirm again" in _locked.lower())
s.check("unlocked -> the normal 3-step check-in flow (prepare_confirm), not the suggest-next guidance",
        "LOCKED" not in _open and "prepare_confirm()" in _open)

# ---------------------------------------------------------------------------
s.section("journey check-in: 3 steps -- results + AE/OU file, one overall remark, submit (2026-09-22)")
_ol = _open.lower()
# STEP 1: fill the table, then FORCE a supporting FILE on each AE/OU KPI -- a file, not a note.
s.check("it is framed as THREE steps",
        "three simple steps" in _ol and "step 1" in _ol and "step 2" in _ol and "step 3" in _ol)
s.check("STEP 1 forces a supporting FILE on each AE/OU KPI (a file, not a written note)",
        "attach a supporting file" in _ol and "required for every ae/ou kpi" in _ol
        and "not a written note" in _ol)
s.check("...and there is NO per-KPI note step (do not ask for a written explanation/justification)",
        "no per-kpi note step" in _ol
        and "do not ask them to type an explanation or a justification for a kpi" in _ol)
s.check("...a middling / below-target KPI needs NO attachment",
        "needs no attachment" in _ol)
s.check("...if a standout can't be evidenced, gently suggest a re-check (they amend the result)",
        "cannot produce evidence" in _ol and "may be worth a re-check" in _ol)
# The AUTHORITATIVE evidence-status block: AE/OU with a file (DONE) vs still needing one.
s.check("it carries an AUTHORITATIVE EVIDENCE STATUS block (done vs still-needing a file)",
        "evidence status (authoritative" in _ol
        and "already have a supporting file" in _ol and "still needing a file" in _ol)
# STEP 2: ONE overall remark, ~100 words, shown to the BG/BU CEO to defend self-ratings, REQUIRED.
s.check("STEP 2 asks for ONE overall remark, ~100 words, and says it is REQUIRED",
        "one overall remark" in _ol and "100 words" in _ol
        and "required before they can submit" in _ol)
# 2026-09-25 (Chris): "these replies don't sound like a smart model helping out the user" -- the agent converses
# (answers first, helps with a frame from their own results) and saves only through save_remark (their exact words).
s.check("STEP 2: the agent asks for the remark, ANSWERS questions first, and saves only via save_remark",
        "ask for their overall remark" in _ol and "answer what they ask first" in _ol
        and "save_remark{}" in _open and "exactly as they typed it" in _ol)
s.check("...help = the draft written straight away from what they said; no length verdict; an instruction is not the remark",
        "write the draft straight away" in _ol and "never say it's too brief" in _ol
        and "that message is not their remark" in _ol)
_q_strong = a._review_remark_question("strong")
s.check("the question itself: 50-100 words, to the BG/BU CEO to explain their results, with a STAR tip",
        "in 50-100 words" in _q_strong and "BG/BU CEO" in _q_strong and "explain them in your own words" in _q_strong
        and "Tip: the STAR method helps -- Situation, Task, Action, Result." in _q_strong, _q_strong)
# STEP 3: review + submit, gently; never leave the check-in until confirmed or deferred.
s.check("STEP 3 is review + submit via prepare_confirm(), gently, never forced",
        "step 3" in _ol and "prepare_confirm()" in _open and "never force it" in _ol)
s.check("...it must NOT leave the check-in until confirmed or they defer",
        "do not leave the kpi check-in (go_to_stage / next)" in _ol
        and "either confirmed or said they'd rather come back to it later" in _ol)
s.check("...never claims submitted itself; only the Confirm click submits",
        "never claim it is submitted yourself" in _ol)
# No per-KPI note and no log_evidence in the journey (the file IS the evidence; one written remark).
s.check("the journey forbids log_evidence and any per-KPI note",
        "do not call log_evidence and do not draft any per-kpi note" in _ol)
s.check("...it grounds ratings in the line data (never computes a rating)",
        "read each kpi's result and its 'rating' from the line data exactly" in _ol)
# The STANDALONE check-in keeps its per-KPI evidence flow (log_evidence).
with a.app.test_request_context("/"):
    from flask import session as _ss
    _ss["user_id"] = SUBJ["id"]
    _sdb = a.get_db()
    _standalone = a._review_agent_system(_sdb, dict(_sdb.execute("SELECT * FROM users WHERE id=?", (SUBJ["id"],)).fetchone()),
                                         a.review_state(_sdb, dict(_sdb.execute("SELECT * FROM users WHERE id=?", (SUBJ["id"],)).fetchone())),
                                         journey=False)
s.check("the STANDALONE check-in still carries the per-KPI evidence flow (log_evidence)",
        "log_evidence" in _standalone and "EVIDENCE FLOW" in _standalone)

# ---------------------------------------------------------------------------
s.section("journey prompt (2026-09-23): one-tap attach button, remark WHY + STAR, HR-filled KPIs")
# STEP 1 points to the one-tap button and never asks to be told once attached.
s.check("STEP 1 points to the one-tap 'Attach file' button",
        "one-tap 'attach file -- <kpi>' button" in _ol)
s.check("STEP 1 says what the file is FOR: it becomes their supporting evidence -> a summary, not a working file",
        "becomes their supporting evidence" in _ol and "supporting summary" in _ol
        and "not their working file" in _ol and "proceed without" in _ol)
s.check("...never offers its own attach chip, never asks to be told once attached",
        "do not offer your own attach quick reply" in _ol
        and "never ask them to tell you once it is attached" in _ol)
# 2026-09-24 (Chris): the agent states the limits -- 4 files per KPI, the size cap each (5 MB since 2026-10-23),
# the types, several at once.
s.check("STEP 1 gives the attachment limits the first time it asks for a file",
        "the first time you ask for a file, also give the limits" in _ol
        and a._REVIEW_FILE_LIMIT_TEXT.lower() in _ol and "pick several files at once" in _ol)
s.check("...built from the caps the route enforces (4 files, the size cap, the accepted types)",
        a._REVIEW_FILE_LIMIT_TEXT == "up to %d files per KPI, each up to %d MB (%s)" % (
            a.EVIDENCE_MAX_ATTACH_PER_ITEM, a.EVIDENCE_ATTACH_MAX_BYTES // 1048576, a.EVIDENCE_ATTACH_TYPES_TEXT)
        and "up to 4 files per kpi, each up to %d mb" % a.EVIDENCE_ATTACH_MAX_MB in a._REVIEW_FILE_LIMIT_TEXT.lower(),
        a._REVIEW_FILE_LIMIT_TEXT)
s.check("STEP 2: no STAR coaching loop (one question at a time) -- a STAR tip only",
        "help them draft it with star" not in _ol and "one question at a time" not in _ol)
s.check("the KPI journey prompt does NOT carry _STAR_COACH (the remark exception is scoped)",
        a._STAR_COACH not in _open)
s.check("...and _STAR_COACH keeps its rule elsewhere (no STAR name-drop, no 'calibration' step)",
        "do NOT name-drop 'STAR'" in a._STAR_COACH and "never as an internal 'calibration' step" in a._STAR_COACH)


def _jprompt(uid):
    with a.app.test_request_context("/"):
        from flask import session as _jps
        _jps["user_id"] = uid
        _jdb = a.get_db()
        _ju = dict(_jdb.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())
        return a._review_agent_system(_jdb, _ju, a.review_state(_jdb, _ju), journey=True)


_bp = _jprompt(BUU)
s.check("a subject with an HR-filled KPI gets the 'KPIs FILLED BY GROUP PEOPLE' line naming it",
        "KPIs FILLED BY GROUP PEOPLE" in _bp and "PAT" in _bp.split("KPIs FILLED BY GROUP PEOPLE")[1][:200], _bp[-600:])
s.check("...with no file / no action asked of them",
        "no file and no action" in _bp)
s.check("a subject with no HR-filled KPI gets no such line", "KPIs FILLED BY GROUP PEOPLE" not in _open)
# The state-driven REMARK STEP block: only while STEP 2 is live, and it knows if the guide is shown.
with a.app.app_context():
    _rdb = a.get_db()
    _saved_remark = _rdb.execute("SELECT remark FROM pm_overall_remarks WHERE cycle_id=? AND subject_id=?",
                                 (CID, SUBJ["id"])).fetchone()
    _rdb.execute("DELETE FROM pm_overall_remarks WHERE cycle_id=? AND subject_id=?", (CID, SUBJ["id"]))
    _rdb.execute("DELETE FROM pm_review_session WHERE subject_id=? AND cycle_id=?", (SUBJ["id"], CID))
    _rdb.execute("UPDATE pm_kpi_results SET draft=1 WHERE kpi_target_id IN (?,?)", (GP, DM))
    _rdb.execute("DELETE FROM pm_review_chat WHERE subject_id=? AND cycle_id=?", (SUBJ["id"], CID))
    _rdb.commit()
_od_r, _, _ro_r = ov_data()
s.check("precondition: SUBJ's remark step is open (all keyed, no file owed, no remark)",
        _ro_r is True, (_od_r.get("attach_needed"), [(l["kpi"], l["result"]) for l in _od_r["lines"]]))
_rp1 = _jprompt(SUBJ["id"])
s.check("REMARK STEP block: live -> ask if not asked yet, and follow HOW THE REMARK STEP WORKS",
        "REMARK STEP (live now)" in _rp1 and "follow HOW THE REMARK STEP WORKS" in _rp1)
with a.app.app_context():
    _rdb = a.get_db()
    _rdb.execute("INSERT INTO pm_review_chat(subject_id, cycle_id, role, content, card, stage) "
                 "VALUES (?,?,'agent','x',?, 'account')",
                 (SUBJ["id"], CID, '[{"type": "remark_guide", "data": {}}]'))
    _rdb.commit()
_rp2 = _jprompt(SUBJ["id"])
s.check("...an old guide card in the chat changes nothing (there is no guide-card variant any more)",
        "REMARK STEP (live now)" in _rp2 and "already in the chat above" not in _rp2)
with a.app.app_context():
    _rdb = a.get_db()
    _rdb.execute("DELETE FROM pm_review_chat WHERE subject_id=? AND cycle_id=?", (SUBJ["id"], CID))
    if _saved_remark:
        _rdb.execute("INSERT INTO pm_overall_remarks(cycle_id, subject_id, remark, draft) VALUES (?,?,?,1)",
                     (CID, SUBJ["id"], _saved_remark["remark"]))
    _rdb.commit()
s.check("with the remark written, there is NO live REMARK STEP block",
        "REMARK STEP (live now)" not in _jprompt(SUBJ["id"]))
s.check("the unlocked prompt still never contains the word LOCKED", "LOCKED" not in _rp1 and "LOCKED" not in _rp2)

# The remark guide card: static copy, S/T/A/R, the why names the CEO + calibration, a STAR button.
_rg = a._review_remark_guide_card()
s.check("the remark_guide card: type + STAR labels in order",
        _rg["type"] == "remark_guide"
        and [x["label"] for x in _rg["data"]["star"]] == ["Situation", "Task", "Action", "Result"], _rg)
s.check("...its why names the winning case, the CEO and calibration, and concrete evidence",
        all(w in _rg["data"]["why"] for w in ("winning case", "CEO", "calibration", "concrete evidence")),
        _rg["data"]["why"])
s.check("...and offers STAR drafting help with a button",
        _rg["data"]["button"] == "Help me draft it with STAR" and "STAR" in _rg["data"]["help"], _rg["data"])
# The framing follows the RESULT (Chris, 2026-09-24): "the user clearly scored poorly -- how is it a
# chance to write down the winning case? The STAR recommendation should adjust to help them explain
# the poor result instead."
_tone = a._review_remark_tone
s.check("tone: UA/BE overall -> 'below', ME (or no overall yet) -> 'meets', AE/OU -> 'strong'",
        [_tone({"overall": {"band_code": c}}) for c in ("UA", "BE", "ME", "AE", "OU")]
        == ["below", "below", "meets", "strong", "strong"]
        and _tone({"overall": None}) == "meets" and _tone(None) == "meets")
_rgb = a._review_remark_guide_card("below")["data"]
s.check("a below-target card EXPLAINS the result -- never a 'winning case' -- and still names the CEO + calibration",
        "winning case" not in _rgb["why"].lower() and "below target" in _rgb["why"]
        and "explain" in _rgb["why"] and "CEO" in _rgb["why"] and "calibration" in _rgb["why"], _rgb["why"])
s.check("...its STAR hints are about what got in the way, what they did, and what they learned",
        [x["label"] for x in _rgb["star"]] == ["Situation", "Task", "Action", "Result"]
        and "hard" in _rgb["star"][0]["hint"] and "limit the impact or recover" in _rgb["star"][2]["hint"]
        and "learned" in _rgb["star"][3]["hint"], _rgb["star"])
s.check("...and its button asks for help EXPLAINING it",
        _rgb["button"] == "Help me explain it with STAR" and "explain my results" in _rgb["button_msg"])
_rgm = a._review_remark_guide_card("meets")["data"]
s.check("a Meets card tells the story behind the result (no 'winning case'), and its Result hint covers any shortfall",
        "winning case" not in _rgm["why"].lower() and "story behind your result" in _rgm["why"]
        and "fell short" in _rgm["star"][3]["hint"], _rgm)
_orig_tone = a._review_remark_tone
try:
    a._review_remark_tone = lambda data: "below"
    _pb = _jprompt(SUBJ["id"])
    a._review_remark_tone = lambda data: "strong"
    _ps = _jprompt(SUBJ["id"])
finally:
    a._review_remark_tone = _orig_tone
s.check("the ONE question follows the tone: strong -> what went right; below -> the challenges; meets -> both",
        "what went right" in a._review_remark_question("strong") and "challenges" not in a._review_remark_question("strong")
        and "the challenges behind your results" in a._review_remark_question("below")
        and "went right" not in a._review_remark_question("below")
        and "what went right, and any challenges" in a._review_remark_question("meets"))
s.check("...below also carries the accommodating TONE steer (no band names recited, never 'poor'); strong does not",
        "TONE FOR THIS PERSON" in _pb and "do NOT recite band names" in _pb and "TONE FOR THIS PERSON" not in _ps)
_ras = __import__("inspect").getsource(a._review_agent_system)
s.check("the live REMARK STEP says no file talk, and keeps a below-target reply kind",
        "Do not bring up files or" in _ras
        and "Their result came in BELOW TARGET: keep that line kind" in _ras)
s.check("with no standout KPI the prompt says there is NO file step (no file talk at all)",
        "if not _strong:" in _ras and "NO FILES NEEDED" in _ras)
s.check("the journey turn asks the ONE question from the same tone (no guide card any more)",
        "_review_remark_question(_review_remark_tone(" in __import__("inspect").getsource(a._journey_chat_turn)
        and "_review_remark_guide_card(" not in __import__("inspect").getsource(a._journey_chat_turn))
# _review_remark_step_open truth table over synthetic overview data.
_L = lambda **k: dict({"result": "1", "editable": True, "hr_owned": False, "bu_level": False}, **k)
_T = a._review_remark_step_open
s.check("step-open truth table: all keyed + no file owed + no remark + unlocked -> True",
        _T(None, None, {"lines": [_L(), _L()], "attach_needed": [], "overall_remark": "", "locked": False}) is True)
s.check("...a remark already written -> False",
        _T(None, None, {"lines": [_L()], "attach_needed": [], "overall_remark": "done", "locked": False}) is False)
s.check("...locked -> False",
        _T(None, None, {"lines": [_L()], "attach_needed": [], "overall_remark": "", "locked": True}) is False)
s.check("...a file still owed -> False",
        _T(None, None, {"lines": [_L()], "attach_needed": [{"kpi_id": 1}], "overall_remark": ""}) is False)
s.check("...an own editable line unkeyed -> False",
        _T(None, None, {"lines": [_L(), _L(result=None)], "attach_needed": [], "overall_remark": ""}) is False)
s.check("...nothing keyed at all -> False",
        _T(None, None, {"lines": [_L(result=None, editable=False)], "attach_needed": [], "overall_remark": ""}) is False)
s.check("...an unkeyed HR-owned line is ignored -> True",
        _T(None, None, {"lines": [_L(), _L(result=None, editable=False, hr_owned=True)],
                        "attach_needed": [], "overall_remark": ""}) is True)

# ---------------------------------------------------------------------------
s.section("the agent's KPI lines carry the SERVER rating (no hallucinated number)")
# The bug (2026-09-15, Chris): the agent said "5.0 of 5" for a less-is-better line the
# server scored 4.0, because _review_kpi_lines gave it only the band, never the numeric
# rating. Reproduce the exact case: rates 53/46/42/38/32, method 'less', actual 33 ->
# highest rung cleared is 4 (33<=38, not <=32) -> "4.0 of 5" / Above Expectation.
with a.app.test_request_context("/"):
    from flask import session as _s5
    _s5["user_id"] = SUBJ["id"]
    _db5 = a.get_db()
    DMC = _db5.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
        "status, business_group, rate1, rate2, rate3, rate4, rate5) "
        "VALUES (?,?,?,?, 'less', 'approved', ?, 53, 46, 42, 38, 32)",
        (CID, SUBJ["id"], "ZZ Direct Materials Cost", 50.0, CHBM)).lastrowid
    NK = _db5.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
        "status, business_group, rate1, rate2, rate3, rate4, rate5) "
        "VALUES (?,?,?,?, 'more', 'approved', ?, 1, 2, 3, 4, 5)",
        (CID, SUBJ["id"], "ZZ Unkeyed Line", 0.0, CHBM)).lastrowid
    _db5.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, draft) "
                 "VALUES (?, 33, ?, 1)", (DMC, SUBJ["id"]))
    _db5.commit()
    _u5 = _db5.execute("SELECT * FROM users WHERE id=?", (SUBJ["id"],)).fetchone()
    _klines = a._review_kpi_lines(_db5, dict(_u5))
    _kov = a._review_kpi_overview(_db5, dict(_u5))["data"]["lines"]
_dmc_line = next((l for l in _klines if l["kpi_id"] == DMC), None)
_dmc_ov = next((l for l in _kov if l["kpi_id"] == DMC), None)
_nk_line = next((l for l in _klines if l["kpi_id"] == NK), None)
s.check("a keyed less-is-better line carries the SERVER rating for the agent",
        bool(_dmc_line) and _dmc_line.get("rating") == "4.0 of 5", _dmc_line)
s.check("...it EQUALS the pinned table's rating (one server value, no divergence)",
        bool(_dmc_ov) and _dmc_line["rating"] == _dmc_ov["rating"],
        (_dmc_line.get("rating") if _dmc_line else None, _dmc_ov.get("rating") if _dmc_ov else None))
s.check("...the band is the human NAME, never the raw code",
        _dmc_line.get("band") == "Above Expectation", _dmc_line.get("band"))
s.check("an un-keyed line carries NO rating (nothing for the agent to state)",
        bool(_nk_line) and _nk_line.get("rating") is None, _nk_line)
# The prompt forbids the model deriving a rating itself.
_kp = _journey_kpi_prompt(False)
s.check("the prompt forbids the model computing/guessing a rating",
        "never compute" in _kp.lower() and "verbatim" in _kp.lower(), _kp[-600:])

# ---------------------------------------------------------------------------
s.section("resumed check-in: never re-ask for a file on an ALREADY-ATTACHED KPI")
# On a RESUMED check-in the agent must not re-ask for a file on an AE/OU KPI that already has one.
# _review_kpi_lines carries has_attachment, and an AUTHORITATIVE EVIDENCE STATUS block lists
# already-attached (DONE) vs still-needing -- the same explicit-list pattern the note-status block
# used (gpt-5-mini honours the list far more reliably than its own scan). DMC (above) is a strong
# (AE) keyed line with NO file yet.
s.check("_review_kpi_lines carries has_attachment (False until a file is attached), not a note field",
        _dmc_line is not None and _dmc_line.get("has_attachment") is False and "note" not in _dmc_line,
        _dmc_line)
def _between(hay, a_, b_):
    i = hay.find(a_)
    if i < 0:
        return ""
    i += len(a_); j = hay.find(b_, i)
    return hay[i:j] if j >= 0 else hay[i:]
_DA, _DB = "never re-ask for a file: ", ". Standout (AE/OU) KPIs STILL needing"
_TA, _TB = "ask for these in order: ", ". Work ONLY"
with a.app.test_request_context("/"):
    from flask import session as _s6
    _s6["user_id"] = SUBJ["id"]
    _db6 = a.get_db()
    _u6 = dict(_db6.execute("SELECT * FROM users WHERE id=?", (SUBJ["id"],)).fetchone())
    _p_todo = a._review_agent_system(_db6, _u6, a.review_state(_db6, _u6), journey=True)
    # Attach a file to DMC (a KPI-linked recognition item + one attachment) -> it moves to DONE.
    _de = _db6.execute("INSERT INTO pm_evidence(subject_id, author_id, occurred_on, kind, body, state) "
                       "VALUES (?,?, date('now'), 'recognition', NULL, 'shared')",
                       (SUBJ["id"], SUBJ["id"])).lastrowid
    _db6.execute("INSERT INTO pm_evidence_links(evidence_id, target_kind, target_ref) VALUES (?,'kpi',?)",
                 (_de, str(DMC)))
    _db6.execute("INSERT INTO pm_evidence_attachments(evidence_id, filename, stored_path, content_type, "
                 "size_bytes, uploaded_by) VALUES (?, 'e.pdf', 'x', 'application/pdf', 9, ?)", (_de, SUBJ["id"]))
    _db6.commit()
    _p_done = a._review_agent_system(_db6, _u6, a.review_state(_db6, _u6), journey=True)
    _db6.execute("DELETE FROM pm_evidence_attachments WHERE evidence_id=?", (_de,))  # restore
    _db6.execute("DELETE FROM pm_evidence_links WHERE evidence_id=?", (_de,))
    _db6.execute("DELETE FROM pm_evidence WHERE id=?", (_de,))
    _db6.commit()
s.check("the journey KPI prompt carries an AUTHORITATIVE EVIDENCE STATUS block",
        "EVIDENCE STATUS (AUTHORITATIVE" in _p_todo)
# NON-VACUOUS: with no file the strong line is in 'still needing'; with a file it moves to DONE.
s.check("an un-attached standout KPI is listed as STILL needing a file (not already-attached)",
        "ZZ Direct Materials Cost" in _between(_p_todo, _TA, _TB)
        and "ZZ Direct Materials Cost" not in _between(_p_todo, _DA, _DB),
        _between(_p_todo, _TA, _TB))
s.check("...and once a file is attached it moves to the already-attached (DONE) list",
        "ZZ Direct Materials Cost" in _between(_p_done, _DA, _DB),
        _between(_p_done, _DA, _DB))
s.check("the status block tells the agent to work only the still-needing, never re-ask an attached one",
        "NEVER re-ask for a file on a KPI in the already-attached list" in _p_todo
        and "prepare_confirm()" in _p_todo)

# ---------------------------------------------------------------------------
s.section("plain-spoken register: _strip_praise_opener drops a leading praise word")
# gpt-5-mini reflexively opens with "Nice --"/"Fantastic --" etc. (A/B: 8/8, even with a
# 'vary your opener' rule). This backstop strips a LEADING interjection + separator so the
# reply leads with the substance -- deterministic, never empties the message.
sp = a._strip_praise_opener
s.check("strips 'Nice -- ...' and re-capitalises",
        sp("Nice — that's a clear set of drivers") == "That's a clear set of drivers",
        sp("Nice — that's a clear set of drivers"))
s.check("strips an em-dash with NO spaces ('Fantastic—leading ...')",
        sp("Fantastic—leading both projects") == "Leading both projects",
        sp("Fantastic—leading both projects"))
s.check("strips a comma separator ('Great, what did you do?')",
        sp("Great, what did you do?") == "What did you do?", sp("Great, what did you do?"))
s.check("strips a two-hyphen separator ('Outstanding -- what drove it?')",
        sp("Outstanding -- what drove it?") == "What drove it?", sp("Outstanding -- what drove it?"))
s.check("strips the mild filler openers gpt-5-mini reaches for ('Solid --', 'Good --')",
        sp("Solid — you led both projects") == "You led both projects"
        and sp("Good — you led both projects") == "You led both projects",
        (sp("Solid — you led both projects"), sp("Good — you led both projects")))
s.check("leaves a SUBSTANTIVE opener untouched (no praise word first)",
        sp("Gross Profit came in ahead — what drove it?")
        == "Gross Profit came in ahead — what drove it?",
        sp("Gross Profit came in ahead — what drove it?"))
s.check("does NOT over-strip an integrated praise phrase (conservative)",
        sp("Outstanding on Gross Profit — brilliant work")
        == "Outstanding on Gross Profit — brilliant work",
        sp("Outstanding on Gross Profit — brilliant work"))
s.check("never empties the message ('Nice --' with nothing after is kept)",
        sp("Nice —") == "Nice —", sp("Nice —"))
s.check("a greeting is not a praise opener ('Hi Chris -- ...' kept)",
        sp("Hi Chris — let's start with your KPIs").startswith("Hi Chris"),
        sp("Hi Chris — let's start with your KPIs"))
s.check("empty / None in -> unchanged out",
        sp("") == "" and sp(None) is None, (sp(""), sp(None)))
# The VOICE prompt now tells the model NOT to open with a superlative.
_voice = _journey_kpi_prompt(True)
s.check("the prompt tells the agent not to open with a superlative/acknowledgement word",
        "do not open a reply with a superlative" in _voice.lower(), _voice[:900])

sys.exit(s.done())
