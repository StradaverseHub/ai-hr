"""A calibrator's justification has a ceiling, and over it is REFUSED, never trimmed (security test 4-07, 2026-10-31).

The BU CEO's is 1,000 characters (the remark box's own); every other tier's the remark ceiling of 300 words. Until now
`_pm_calib_apply` and `_pot_calib_apply` had no length check, so a 30,000-character justification through the chat
(`move_band`) was stored whole. The check lives in the two shared writers (`_calib_remark_over`), so the grid, the chat
tool and the in-place curve move all meet it, and the chat tool relays the error.

Its own synthetic business group; the suite writes, so it takes a fresh copy.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("A justification over its tier's ceiling is refused, never trimmed (4-07)")
a.ai_draft.review_agent_available = lambda: True
BG, CA = "ZZCL Group", "ZZCL Alpha Sdn Bhd"

with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm')",
               (CID,))
    for k in ("ai_calib", "review_unified"):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CA)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        uid = db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group) "
                   "VALUES (?,?,?,100,'more','approved',?)", (PER, uid, "ZZCL KPI", BG))
        return uid
    BUC = person("ZZCL-BUC", "ZZ CL Unit CEO", buceo_bg=BG, buceo_company=CA)
    BGC = person("ZZCL-BGC", "ZZ CL Group CEO", bgceo_bg=BG)
    HODU = person("ZZCL-HOD", "ZZ CL Dept Head")
    P = [person("ZZCL-P%d" % i, "ZZ CL Person %d" % i, hod_id=HODU) for i in range(8)]
    db.commit()
PN = ["ZZ CL Person %d" % i for i in range(8)]
words = lambda n: " ".join(["delivered"] * n)


def note(table, uid):
    r = H.rows(a, "SELECT justification FROM %s WHERE subject_id=? ORDER BY id DESC LIMIT 1" % table, (uid,))
    return r[0][0] if r else None


def n_rows(table, uid):
    return H.one(a, "SELECT COUNT(*) FROM %s WHERE subject_id=?" % table, (uid,))


def pm_ctx(tier, uid):
    from flask import session as _fs
    _fs["user_id"] = uid
    db = a.get_db()
    sc = a._journey_calib_scope(db, a.current_user(), fresh=True)
    return db, sc


# ---------------------------------------------------------------------------
s.section("the BU CEO: 1,000 characters")
for label, length, ok in (("999", 999, True), ("1,000", 1000, True), ("1,001", 1001, False), ("30,000", 30000, False)):
    txt = ("x" * length)
    with a.app.test_request_context("/"):
        db, sc = pm_ctx("buceo", BUC)
        tier, kw, ctx = sc
        was = note("pm_calibration_adjustments", P[0])
        res = a._calib_tool_move_band(db, a.current_user(), ctx, tier, kw, {"subject": PN[0], "band": "AE", "justification": txt})
        db.commit()
    stored = note("pm_calibration_adjustments", P[0])
    s.check("performance, %s characters: %s" % (label, "saved whole" if ok else "refused, and what was saved is untouched"),
            (res.get("ok") is True and stored == txt) if ok else
            (res.get("ok") is False and "characters" in (res.get("error") or "") and "1,000" in (res.get("error") or "")
             and stored == was), (res, len(stored or "")))
with a.app.test_request_context("/"):
    db, sc = pm_ctx("buceo", BUC)
    res = a._calib_tool_move_band(db, a.current_user(), sc[2], sc[0], sc[1], {"subject": PN[1], "band": "AE", "justification": "y" * 5000})
s.check("a refused justification leaves no row for that person at all", res.get("ok") is False
        and n_rows("pm_calibration_adjustments", P[1]) == 0, res)

for label, length, ok in (("1,000", 1000, True), ("1,001", 1001, False)):
    txt = "z" * length
    with a.app.test_request_context("/"):
        from flask import session as _fs
        _fs["user_id"] = BUC
        db = a.get_db()
        sc = a._pot_calib_scope(db, a.current_user(), fresh=True)
        res = a._pot_tool_move_band(db, a.current_user(), sc, {"subject": PN[2], "band": "High", "justification": txt})
        db.commit()
    s.check("potential, %s characters: %s" % (label, "saved whole" if ok else "refused"),
            (res.get("ok") is True and note("calibration_adjustments", P[2]) == txt) if ok else
            (res.get("ok") is False and "characters" in (res.get("error") or "")), res)
s.check("...and the refused one wrote nothing over the saved one", note("calibration_adjustments", P[2]) == "z" * 1000)

# ---------------------------------------------------------------------------
s.section("every other tier: 300 words (the HOD's department review is the one at hand)")
for label, n, ok in (("300", 300, True), ("301", 301, False), ("5,000", 5000, False)):
    with a.app.test_request_context("/"):
        from flask import session as _fs
        _fs["user_id"] = HODU
        db = a.get_db()
        sc = a._journey_calib_scope(db, a.current_user(), fresh=True)
        # an HOD's move HOLDS (dry run); the ceiling is checked before that
        res = a._calib_tool_move_band(db, a.current_user(), sc[2], sc[0], sc[1], {"subject": PN[3], "band": "AE", "justification": words(n)})
    s.check("HOD performance, %s words: %s" % (label, "passes the ceiling (held for their page)" if ok else "refused"),
            (res.get("ok") is True and res.get("held")) if ok else
            (res.get("ok") is False and "words" in (res.get("error") or "") and "300-word" in (res.get("error") or "")), res)
    with a.app.test_request_context("/"):
        from flask import session as _fs
        _fs["user_id"] = HODU
        db = a.get_db()
        psc = a._pot_calib_scope(db, a.current_user(), fresh=True, tier="hod")
        res2 = a._pot_tool_move_band(db, a.current_user(), psc, {"subject": PN[3], "band": "High", "justification": words(n)})
    s.check("HOD potential, %s words: %s" % (label, "passes the ceiling (held)" if ok else "refused"),
            (res2.get("ok") is True and res2.get("held")) if ok else
            (res2.get("ok") is False and "300-word" in (res2.get("error") or "")), res2)
s.check("the ceiling function itself: tiers and edges",
        a._calib_remark_over("buceo", "x" * 1000) is None and a._calib_remark_over("buceo", "x" * 1001)
        and a._calib_remark_over("bugrp", "x" * 1001) and a._calib_remark_over("bgceo", words(300)) is None
        and a._calib_remark_over("bgceo", words(301)) and a._calib_remark_over("group", words(301))
        and a._calib_remark_over("bgceo", "x" * 5000) is None and a._calib_remark_over("hod", None) is None)

# ---------------------------------------------------------------------------
s.section("the Talent Box's move_person: refused over the ceiling, no longer trimmed to 1,000 characters")


def tb_move(k, text):
    from flask import session as _fs
    with a.app.test_request_context("/review/chat", method="POST", data={"view": "bg", "stage": "talent_box"}):
        _fs["user_id"] = BGC
        d = a.get_db()
        res = a._journey_team_run_stage_tool(d, a.current_user(), CID, "talent_box", None,
                                             {"tool": "move_person", "args": {"subject": PN[k], "performance_band": "AE",
                                                                              "justification": text}})
        d.commit()
    return res


def tb_note(k):
    r = H.rows(a, "SELECT ca.justification FROM pm_calibration_adjustments ca JOIN pm_calibration_sessions cs ON cs.id=ca.session_id "
                  "WHERE cs.tier='bgceo' AND ca.subject_id=? ORDER BY ca.id DESC LIMIT 1", (P[k],))
    return r[0][0] if r else None


r301 = tb_move(6, words(301))
s.check("301 words: refused with the ceiling sentence, nothing written", r301.get("ok") is False
        and "300-word" in (r301.get("error") or "") and tb_note(6) is None, r301)
r300 = tb_move(6, words(300))
s.check("300 words (about 3,000 characters): saved whole, not cut to 1,000 characters", r300.get("ok") is True
        and tb_note(6) == words(300), (r300, len(tb_note(6) or "")))
r_big = tb_move(7, "v" * 30000 + " " + words(400))
s.check("a 30,000-character, 400-word justification: refused", r_big.get("ok") is False and tb_note(7) is None, r_big)

# ---------------------------------------------------------------------------
s.section("through the real routes: the grid and the in-place curve")
cb = H.client_as(a, BUC)
r = cb.post("/performance/calibration/company/%s/%s/adjust" % (BG, CA),
            data={"csrf_token": "tok", "subject_id": str(P[4]), "adjusted_band": "AE", "justification": "q" * 1001},
            headers={"X-Requested-With": "XMLHttpRequest"})
j = r.get_json(silent=True) or {}
s.check("the grid's adjust route refuses 1,001 characters and writes nothing",
        n_rows("pm_calibration_adjustments", P[4]) == 0 and (j.get("ok") is False or r.status_code in (301, 302, 400)),
        (r.status_code, j))
r = cb.post("/performance/calibration/company/%s/%s/adjust" % (BG, CA),
            data={"csrf_token": "tok", "subject_id": str(P[4]), "adjusted_band": "AE", "justification": "q" * 1000},
            headers={"X-Requested-With": "XMLHttpRequest"})
s.check("...and takes 1,000", n_rows("pm_calibration_adjustments", P[4]) == 1 and note("pm_calibration_adjustments", P[4]) == "q" * 1000)
r = cb.post("/review/team/calib-move", data={"csrf_token": "tok", "stage": "calibration", "view": "bu", "subject": str(P[5]),
                                             "band": "AE", "justification": "w" * 1500})
j = r.get_json(silent=True) or {}
s.check("the in-place curve move refuses 1,500 characters instead of trimming it to 1,000",
        j.get("ok") is False and n_rows("pm_calibration_adjustments", P[5]) == 0, (r.status_code, j.get("error")))

# ---------------------------------------------------------------------------
s.section("through the chat: the tool's error is relayed, nothing is written")
_real = a.ai_draft.review_agent
try:
    seen = []
    long_just = "carried the whole launch " + "x" * 1100

    def model(system, history):
        if history and history[-1].get("role") == "tool":
            seen.append(history[-1]["content"])
            return {"say": "That remark is too long; shall I shorten it?", "quick_replies": [], "action": None}
        return {"say": "Moving.", "quick_replies": [],
                "action": {"tool": "move_band", "args": {"subject": PN[0], "band": "OU", "justification": long_just}}}
    a.ai_draft.review_agent = model
    n = n_rows("pm_calibration_adjustments", P[0])
    before = note("pm_calibration_adjustments", P[0])
    out = cb.post("/review/chat", data={"csrf_token": "tok", "message": "Move %s to OU, %s" % (PN[0], long_just),
                                        "journey": "1", "view": "bu", "stage": "calibration"}).get_json() or {}
    s.check("the model's move_band with a 1,100-character justification is refused and its error reaches the model",
            note("pm_calibration_adjustments", P[0]) == before and n_rows("pm_calibration_adjustments", P[0]) == n
            and seen and "characters" in seen[0], (seen, out.get("say")))
finally:
    a.ai_draft.review_agent = _real

sys.exit(s.done())
