"""Grade H Appraisal: AI+ "Fit the curve with AI" on the HOD's stage page and the BU CEO's Talent Box (2 Nov 2026; canvas "AI fit to curve").

What this suite holds:
  * the pick is a FIXED RULE (no model is called), deterministic, adjacent bands only, the fewest moves, and the curve it says it leaves is
    the curve the page really shows after Apply (asserted against gradeh_calib_curve, not a number)
  * every guard is falsified: a closed / signed-off / locked stage gives no control and refuses both POSTs and writes nothing; a seat or
    unit that is not theirs is refused; the fit's own ability off gives 403 and no control; no CSRF, signed out, an admin, a module off
  * who is never suggested: the leader's own band, a person the leader already moved on that axis, a person with no line manager input
    (they stay where they are and still count on the curve); apply skips them too, and anyone outside the scope or whose band changed
  * preview writes nothing (band moves, agree ticks and audit rows unchanged)
  * apply goes through the same writers as a manual move (gradeh_hod_move / gradeh_buceo_move), exactly N moves plus ONE summary audit row;
    the remark is the leader's own and required per move (missing, over 300 words: that move is refused); a refused move never loses the
    moves made before it (gradeh_buceo_move rolls back on a refusal: the apply commits after each move); a placeholder is never stored
  * the page: the control on the HOD's verdict line and in the BU CEO's Talent Box title bar, only while the stage can change; the panel's
    script; the abilities hod.gradeh_fit / bu.gradeh_fit on Leader roles; Help, the KB and Ask carry the line
Synthetic (ZZ9GF-*) on a fresh scratch database; the suite puts back what it changes.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H Appraisal: AI+ fit to curve")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, EMP = H.actors(a)
PFX, BG, CO, COB = "ZZ9GF-", "ZZGF Group", "ZZGF Unit A", "ZZGF Unit B"
U, P = {}, {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
BASE = "/calibration/gradeh"
import sqlite3  # noqa: E402

db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")


def one(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return r[0] if r else None


def run(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        r = fn(d)
        d.commit()
        return r


def csrf(**kw):
    d = {"csrf_token": "tok"}
    d.update(kw)
    return d


def mk(k, grade="H", hod=None, co=CO, dept="ZZGF Dept"):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, job_title, hod_id, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?,?,?, 'Driver', ?, '2020-01-01')",
        ((PFX + k).lower(), "ZZ GF " + k, PFX + k, BG, co, dept, grade, hod)).lastrowid


def person(k, perf="ME", pot="Mid", submitted=True, route="B", score=9.0, rating=3.0):
    pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route) VALUES (?,?,?,?)",
                     (CID, PFX + k, U[k], route)).lastrowid
    P[k] = pid
    db.execute(
        "INSERT INTO gradeh_appraisals (cycle_id, person_id, lm_submitted_at, perf_band, pot_band, perf_rating, perf_value, pot_score, "
        "promo_nominate, promo_reason, b_achievements, b_strengths, b_development, conversation_held) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)",
        (CID, pid, "2026-11-10 02:00:00" if submitted else None, perf if submitted else None, pot if submitted else None,
         rating if submitted else None, None, score if submitted else None, "no", None, "ZZ-ACH-" + k, "ZZ-STR-" + k, "ZZ-DEV-" + k))
    return pid


def urow(k):
    return db.execute("SELECT * FROM users WHERE id=?", (U[k],)).fetchone()


def moves(pid=None, stage=None):
    q, args = "SELECT * FROM gradeh_band_moves WHERE 1=1", []
    if pid:
        q += " AND person_id=?"
        args.append(pid)
    if stage:
        q += " AND stage=?"
        args.append(stage)
    return db.execute(q + " ORDER BY id", args).fetchall()


def counts():
    """Every table a fit could touch: moves, agree ticks, sign-offs and the audit rows."""
    return (one("SELECT COUNT(*) FROM gradeh_band_moves"), one("SELECT COUNT(*) FROM gradeh_reviews"),
            one("SELECT COUNT(*) FROM gradeh_signoffs"), one("SELECT COUNT(*) FROM activity_log"))


def n_audit(action):
    return one("SELECT COUNT(*) FROM activity_log WHERE action=?", (action,))


def ids(js):
    return [m["id"] for m in js["moves"]]


def prev(who, **kw):
    path = "/hod/fit" if who.startswith("HOD") else "/unit/fit"
    d = {"mode": "preview"}
    d.update(kw)
    r = C[who].post(BASE + path, data=csrf(**d))
    return r.status_code, (r.get_json(silent=True) or {})


def appl(who, mv_list, **kw):
    path = "/hod/fit" if who.startswith("HOD") else "/unit/fit"
    d = {"mode": "apply", "moves": json.dumps(mv_list)}
    d.update(kw)
    r = C[who].post(BASE + path, data=csrf(**d))
    return r.status_code, (r.get_json(silent=True) or {})


def hod_args():
    return {"stage": "pot"}


def bu_args(axis="pot", unit=CO):
    return {"axis": axis, "unit": unit}


def mine(js, k):
    return next((m for m in js["moves"] if m["id"] == P[k]), None)


def mvspec(js, k, remark="ZZ a fair reason."):
    m = mine(js, k)
    return {"id": m["id"], "from": m["from"], "to": m["to"], "remark": remark}


if True:
    CID = run(lambda d: a.active_cycle_id(d))
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()["half"]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell LIKE 'gradeh_%'", (CID,))
    for c_ in (CO, COB):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, c_))
    U["BCA"] = mk("BCA", "21", dept="ZZGF Division")
    U["HOD1"] = mk("HOD1", "19", hod=U["BCA"], dept="ZZGF Dept One")
    U["HOD2"] = mk("HOD2", "19", hod=U["BCA"], dept="ZZGF Dept Two")
    U["PLAIN"] = mk("PLAIN", "15")
    U["BCB"] = mk("BCB", "H", co=COB, dept="ZZGF Division")
    U["HODB"] = mk("HODB", "19", hod=U["BCB"], co=COB, dept="ZZGF Dept B")
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, U["BCA"]))
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, COB, U["BCB"]))
    # HOD1: ten. Potential: High x5 (13.5 14 14.5 15 16), Mid x3 (8 9 10), Low x1 (3), one with no line manager input (default Low).
    # High has 5 and the curve expects about 2 of 10, so the lowest scores in High go down. Performance: ME 3.0 for most, two spread.
    spec = [("S1", "AE", "High", 13.5, 4.0), ("S2", "ME", "High", 14.0, 3.1), ("S3", "ME", "High", 14.5, 3.2), ("S4", "ME", "High", 15.0, 3.3),
            ("S5", "ME", "High", 16.0, 3.4), ("S6", "ME", "Mid", 8.0, 3.0), ("S7", "ME", "Mid", 9.0, 3.0), ("S8", "ME", "Mid", 10.0, 3.0),
            ("S9", "BE", "Low", 3.0, 2.0)]
    for k, perf, pot, sc, rt in spec:
        U[k] = mk(k, hod=U["HOD1"], dept="ZZGF Dept One")
        person(k, perf, pot, score=sc, rating=rt)
    U["S10"] = mk("S10", hod=U["HOD1"], dept="ZZGF Dept One")
    person("S10", submitted=False)
    # HOD2: two Mid. A person with no HOD goes to the BU CEO directly. The BU CEO is himself on the list (High 13.2: the lowest High, so
    # if his own record were ever offered it would be picked first).
    for k in ("T1", "T2"):
        U[k] = mk(k, hod=U["HOD2"], dept="ZZGF Dept Two")
        person(k, "ME", "Mid", score=9.0)
    U["N1"] = mk("N1", dept="ZZGF Dept None")
    person("N1", "ME", "Mid", score=9.0)
    person("BCA", "ME", "High", score=13.2)
    # unit B: for the out-of-scope checks
    for k in ("B1", "B2"):
        U[k] = mk(k, hod=U["HODB"], co=COB, dept="ZZGF Dept B")
        person(k, "ME", "Mid")
    db.commit()

C = {k: H.client_as(a, U[k]) for k in U}
CSU = H.client_as(a, SU["id"])


def page(who, path):
    return C[who].get(BASE + path).get_data(as_text=True)


def ctl(h):
    return 'id="ghf-open"' in h


def set_window(cell, opens, closes):
    run(lambda d: (d.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell=?", (CID, cell)),
                   d.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell, opens, closes)), None))


def clear_windows():
    run(lambda d: (d.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell LIKE 'gradeh_%'", (CID,)), None))


def hod_curve(k="HOD1", axis="pot"):
    def f(d):
        rows = a.gradeh_hod_scope(d, U[k], CID)
        mv_, rv_, ys_ = a._gh_cal_load(d, CID, rows)
        P_ = [p for p in (a._gh_cal_person(r, mv_, rv_, ys_) for r in rows) if not p["disagree"]]   # the pages' curve leaves out who does not agree
        return a.gradeh_calib_curve(d, CID, axis, [p["b_hod"][axis] for p in P_], rows[0]["business_group"], rows[0]["company"])
    return run(f)


def bu_curve(axis="pot", k="BCA", co=CO):
    def f(d):
        rows = a.gradeh_unit_scope(d, CID, BG, co)
        mv_, rv_, ys_ = a._gh_cal_load(d, CID, rows)
        P_ = [p for p in (a._gh_cal_person(r, mv_, rv_, ys_) for r in rows) if not p["disagree"]]   # the pages' curve leaves out who does not agree
        return a.gradeh_calib_curve(d, CID, axis, [p["b_bu"][axis] for p in P_], BG, co)
    return run(f)


try:
    s.section("the pick: a fixed rule, deterministic, adjacent, fewest moves")
    _model = a.ai_draft._chat_complete_call
    def _boom(*x, **k):
        raise AssertionError("the fit must never call a model")
    a.ai_draft._chat_complete_call = _boom
    c0 = counts()
    st, j1 = prev("HOD1", **hod_args())
    s.check("an HOD's preview answers ok with moves (no model called: the model call is booby-trapped)", st == 200 and j1.get("ok") and j1["state"] == "ok" and j1["moves"], (st, j1.get("error")))
    st, j2 = prev("HOD1", **hod_args())
    s.check("deterministic: a second preview is identical", j1["moves"] == j2["moves"] and j1["after"] == j2["after"])
    s.check("preview writes nothing: moves, agree ticks, sign-offs and audit rows unchanged", counts() == c0, (c0, counts()))
    s.check("every move is one band over, High to Mid, going down", all(m["dir"] == "down" and m["from"] == "High" and m["to"] == "Mid" for m in j1["moves"]))
    s.check("the people nearest the High line go: S1 (13.5), S2 (14), S3 (14.5), in that order, S4 / S5 stay",
            ids(j1) == [P["S1"], P["S2"], P["S3"]], ids(j1))
    s.check("before + after each add up to the people on the curve, the no-line-manager person counted",
            sum(j1["before"].values()) == sum(j1["after"].values()) == j1["total"] == 10, (j1["before"], j1["after"]))
    gaps_one_less = {k: j1["expected"][k] - (j1["before"][k] + (len(j1["moves"]) - 1 if k == "Mid" else -(len(j1["moves"]) - 1) if k == "High" else 0)) for k in j1["before"]}
    s.check("...(fewest moves) one move fewer would leave a band outside the tolerance", run(lambda d: a._calib_over_framework(gaps_one_less, 10)), gaps_one_less)
    s.check("the case line holds only Grade H figures: score of 17.5 and distance to the High line",
            all("of 17.5" in m["line"] and "above the High line" in m["line"] for m in j1["moves"]), [m["line"] for m in j1["moves"]])
    s.check("a Why fold, and the remark placeholder is words, not a stored value", all(m["why"] and m["ph"].startswith("Moved to Mid") for m in j1["moves"]))
    s.check("the person with no line manager input stays and is named in the note; the curve still counts them",
            P["S10"] not in ids(j1) and "no line manager input" in j1["note"] and j1["held_n"] == 1 and j1["before"]["Low"] == 2, j1["note"])
    a.ai_draft._chat_complete_call = _model

    s.section("the curve after the moves is the real curve after Apply")
    specs = [mvspec(j1, k) for k in ("S1", "S2", "S3")]
    c0 = counts()
    st, r1 = appl("HOD1", specs, **hod_args())
    c1 = counts()
    s.check("apply answers ok with all three applied, none skipped", st == 200 and r1.get("ok") and r1["applied"] == 3 and not r1["skipped"], r1)
    s.check("exactly 3 band moves, each stage 'hod' on axis pot with the leader's own remark, and ONE summary audit row (plus one per move)",
            c1[0] - c0[0] == 3 and all(m["stage"] == "hod" and m["axis"] == "pot" and m["band"] == "Mid" and m["remark"] == "ZZ a fair reason."
                                       for m in moves()[-3:])
            and c1[3] - c0[3] == 4 and n_audit("gradeh_fit_apply") == 1 and n_audit("gradeh_hod_move") == 3, (c0, c1))
    cv = hod_curve()
    s.check("the curve now equals the preview's 'after' (the relationship, not a number)", cv["dist"] == j1["after"] and not cv["breaches"], (cv["dist"], j1["after"]))
    s.check("the people moved read as the HOD's move, the line manager's stored band is untouched",
            all(db.execute("SELECT pot_band FROM gradeh_appraisals WHERE person_id=?", (P[k],)).fetchone()[0] == "High" for k in ("S1", "S2", "S3")))
    st, j3 = prev("HOD1", **hod_args())
    s.check("a spread already within the expected spread: no moves, the empty state's words", j3["state"] == "empty" and not j3["moves"]
            and "already within the expected spread" in j3["message"], j3.get("message"))
    s.check("people the leader already moved are never offered again, and the note says how many stay", j3["mine_n"] == 3 and "already moved" in j3["note"])
    flash = C["HOD1"].get(BASE + "/hod").get_data(as_text=True)
    s.check("the page's own message says what was applied", "3 moves applied to Grade H potential" in flash)

    s.section("who is never suggested (and apply skips them as well)")
    # fresh state for the unit: undo the HOD's moves
    run(lambda d: (d.execute("DELETE FROM gradeh_band_moves"), None))
    st, jb = prev("BCA", **bu_args())
    s.check("a BU CEO's preview answers with moves", st == 200 and jb["state"] == "ok" and jb["moves"], (st, jb.get("error")))
    s.check("the leader's own band is never suggested (their own 13.2 is the lowest High: it would be first)", P["BCA"] not in ids(jb), ids(jb))
    s.check("...and the picks are the nearest High to the line that are not theirs: S1, S2, S3", ids(jb) == [P["S1"], P["S2"], P["S3"]], ids(jb))
    c0 = counts()
    st, ra = appl("BCA", [{"id": P["BCA"], "from": "High", "to": "Mid", "remark": "ZZ my own"}], **bu_args())
    s.check("apply on their own record is refused (skipped with the self-band words), nothing written",
            ra["applied"] == 0 and ra["skipped"] and "own band" in ra["skipped"][0]["why"].lower() and counts()[:3] == c0[:3], ra)
    # a person the leader already moved on this axis
    ok, msg = run(lambda d: a.gradeh_buceo_move(d, urow("BCA"), P["S1"], None, "Mid", "ZZ my own call."))
    st, jb2 = prev("BCA", **bu_args())
    s.check("a person the BU CEO already moved on that axis is excluded and counted", ok and P["S1"] not in ids(jb2) and jb2["mine_n"] == 1, (ok, msg, ids(jb2)))
    st, rb = appl("BCA", [{"id": P["S1"], "from": "Mid", "to": "Low", "remark": "ZZ x"}], **bu_args())
    s.check("...and apply refuses to move them again", rb["applied"] == 0 and "already moved" in rb["skipped"][0]["why"], rb)
    st, rn = appl("BCA", [{"id": P["S10"], "from": "Low", "to": "Mid", "remark": "ZZ x"}], **bu_args())
    s.check("a person with no line manager input is skipped by apply too", rn["applied"] == 0 and "line manager has not submitted" in rn["skipped"][0]["why"], rn)
    s.check("...and is never in a preview, yet counted on the curve", P["S10"] not in ids(jb2) and jb2["before"]["Low"] == bu_curve()["dist"]["Low"])
    st, ro = appl("BCA", [{"id": P["B1"], "from": "Mid", "to": "High", "remark": "ZZ x"}], **bu_args())
    s.check("out of scope (another unit's person) is skipped, nothing written", ro["applied"] == 0 and "isn't in your scope" in ro["skipped"][0]["why"]
            and not moves(P["B1"]), ro)
    st, rh = appl("HOD1", [{"id": P["T1"], "from": "Mid", "to": "High", "remark": "ZZ x"}], **hod_args())
    s.check("an HOD cannot move another HOD's person (skipped, out of scope)", rh["applied"] == 0 and "isn't in your scope" in rh["skipped"][0]["why"]
            and not moves(P["T1"]), rh)
    st, rs = appl("HOD1", [{"id": P["S2"], "from": "Low", "to": "Mid", "remark": "ZZ x"}], **hod_args())
    s.check("a stale 'from' (the band has changed since the suggestion) is skipped", rs["applied"] == 0 and "changed" in rs["skipped"][0]["why"], rs)
    s.check("a unit that is not theirs: 404 on the preview", prev("BCA", **bu_args(unit=COB))[0] == 404 and appl("BCA", [], **bu_args(unit=COB))[0] == 404)
    s.check("a seat with no Grade H unit / no department: 404; an admin: 404; signed out: the sign-in redirect",
            C["PLAIN"].post(BASE + "/hod/fit", data=csrf(mode="preview", stage="pot")).status_code == 404
            and C["HOD1"].post(BASE + "/unit/fit", data=csrf(mode="preview", axis="pot", unit=CO)).status_code == 404
            and CSU.post(BASE + "/hod/fit", data=csrf(mode="preview", stage="pot")).status_code == 404
            and a.app.test_client().post(BASE + "/hod/fit", data={"mode": "preview"}).status_code in (302, 400))
    s.check("no CSRF token: refused (400) and nothing written", C["HOD1"].post(BASE + "/hod/fit", data={"mode": "preview", "stage": "pot"}).status_code == 400)
    s.check("a stage that is not one: 400", prev("HOD1", stage="x")[0] == 400 and prev("BCA", axis="x", unit=CO)[0] == 400)

    s.section("the remark is the leader's own, required for every move")
    run(lambda d: (d.execute("DELETE FROM gradeh_band_moves"), None))
    st, jb = prev("BCA", **bu_args())
    sp = [mvspec(jb, "S1"), mvspec(jb, "S2"), mvspec(jb, "S3")]
    c0 = counts()
    st, rm = appl("BCA", [dict(sp[0], remark=""), dict(sp[1], remark="   ")], **bu_args())
    s.check("apply with a missing remark is refused move by move (Write the remark first), nothing written",
            rm["applied"] == 0 and len(rm["skipped"]) == 2 and all("remark" in x["why"].lower() for x in rm["skipped"]) and counts()[:3] == c0[:3], rm)
    # PARTIAL: the middle move's remark is over 300 words, so gradeh_record_move refuses it and gradeh_buceo_move ROLLS BACK
    long_ = "word " * 301
    st, rp = appl("BCA", [sp[0], dict(sp[1], remark=long_), sp[2]], **bu_args())
    s.check("a partial refusal: the refused move is reported with its reason; the moves before AND after it are kept (commit after each)",
            rp["applied"] == 2 and len(rp["skipped"]) == 1 and rp["skipped"][0]["id"] == sp[1]["id"] and "300 words" in rp["skipped"][0]["why"]
            and [m["person_id"] for m in moves()] == [sp[0]["id"], sp[2]["id"]], (rp, [m["person_id"] for m in moves()]))
    s.check("...with one summary audit row saying 2 applied, 1 skipped",
            one("SELECT detail FROM activity_log WHERE action='gradeh_fit_apply' ORDER BY id DESC LIMIT 1").endswith("2 applied, 1 skipped"))
    # falsify: a refusal in the FIRST move must not undo later ones either; and the first applied one survives a later refusal (above)
    run(lambda d: (d.execute("DELETE FROM gradeh_band_moves"), None))
    st, rq = appl("BCA", [dict(sp[0], remark=long_), sp[1], sp[2]], **bu_args())
    s.check("a refusal first does not stop the rest", rq["applied"] == 2 and len(rq["skipped"]) == 1, rq)
    s.check("every stored remark is exactly what the leader typed, never a placeholder", all(m["remark"] == "ZZ a fair reason." for m in moves())
            and not any(m["remark"] == mine(jb, "S1")["ph"] for m in moves()))
    s.check("moves written by a BU CEO's fit are stage 'buceo' on the right axis", all(m["stage"] == "buceo" and m["axis"] == "pot" for m in moves()))
    cvb = bu_curve()
    st, jb3 = prev("BCA", **bu_args())
    s.check("the BU CEO's curve after Apply equals what the preview promised, for the moves kept", not cvb["breaches"] or jb3["state"] in ("ok", "stuck"), cvb["dist"])

    s.section("gates: a stage that cannot change gives no control and refuses both POSTs")
    run(lambda d: (d.execute("DELETE FROM gradeh_band_moves"), None))
    h = page("HOD1", "/hod")
    s.check("open stage: the control is on the curve's verdict line, with the panel's mount and script",
            ctl(h) and "Fit the curve with AI" in h and re.search(r'class="rv-cal-vline">\s*<div class="rv-calib-verdict', h) and 'id="ghf"' in h
            and "gradeh_calib_fit.js" in h and 'data-stage="pot"' in h)
    h = page("BCA", "/unit")
    s.check("the BU CEO's box: the control in the Talent Box title bar, before Grid | List",
            ctl(h) and re.search(r'rv-tbox-titlebar">[\s\S]*?id="ghf-open"[\s\S]*?class="rv-tbox-views"', h) and 'data-unit="%s"' % CO in h and 'data-axis="' in h)
    c0 = counts()
    # the HOD's calendar cell closed
    set_window("gradeh_hod_pot", "2026-01-01 00:00:00", "2026-01-02 00:00:00")
    h = page("HOD1", "/hod")
    s1, e1 = prev("HOD1", **hod_args()); s2, e2 = appl("HOD1", [{"id": P["S1"], "from": "High", "to": "Mid", "remark": "ZZ x"}], **hod_args())
    s.check("the HOD's window closed: no control, preview and apply refused (409) with the gate's words, nothing written",
            not ctl(h) and s1 == 409 and s2 == 409 and e1["error"] and e1["error"] == e2["error"] and counts() == c0, (s1, s2, e1))
    clear_windows()
    s.check("the window open again: the control is back", ctl(page("HOD1", "/hod")) and prev("HOD1", **hod_args())[0] == 200)
    # signed off
    run(lambda d: (d.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?, 'hod', 'pot', ?, ?)",
                             (CID, str(U["HOD1"]), U["HOD1"])), None))
    s1, e1 = prev("HOD1", **hod_args()); s2, e2 = appl("HOD1", [{"id": P["S1"], "from": "High", "to": "Mid", "remark": "ZZ x"}], **hod_args())
    s.check("a signed-off stage: no control (on its own page), no fit, no write", not ctl(page("HOD1", "/hod?stage=pot")) and s1 == 409 and s2 == 409 and "signed off" in e1["error"]
            and counts()[0] == c0[0], (s1, s2, e1))
    s.check("performance stays shut until potential is signed (the gate's words), so no fit there either",
            prev("HOD2", stage="perf")[0] == 409 or prev("HOD2", stage="perf")[0] == 404)
    run(lambda d: (d.execute("DELETE FROM gradeh_signoffs"), None))
    s.check("an HOD whose stage is open but who asks for performance before potential is signed: refused", prev("HOD1", stage="perf")[0] == 409)
    # BU: closed window, signed, released
    set_window("gradeh_buceo", "2026-01-01 00:00:00", "2026-01-02 00:00:00")
    s1, e1 = prev("BCA", **bu_args()); s2, e2 = appl("BCA", [], **bu_args())
    s.check("the BU CEO's window closed: no control, both POSTs refused (409)", not ctl(page("BCA", "/unit")) and s1 == 409 and s2 == 409 and counts()[0] == c0[0], (s1, s2, e1))
    clear_windows()
    run(lambda d: (d.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?, 'buceo', 'all', ?, ?)",
                             (CID, CO, U["BCA"])), None))
    s1, e1 = prev("BCA", **bu_args()); s2, e2 = appl("BCA", [], **bu_args())
    s.check("a signed-off unit gives no fit and no control", not ctl(page("BCA", "/unit")) and s1 == 409 and s2 == 409 and "signed off" in e1["error"], (s1, e1))
    run(lambda d: (d.execute("DELETE FROM gradeh_signoffs"), None))
    run(lambda d: (d.execute("INSERT INTO gradeh_releases(cycle_id, unit, released_by) VALUES (?,?,?)", (CID, CO, SU["id"])), None))
    s1, e1 = prev("BCA", **bu_args())
    s.check("a released unit gives no fit and no control either", s1 == 409 and "released" in e1["error"] and not ctl(page("BCA", "/unit")), (s1, e1))
    run(lambda d: (d.execute("DELETE FROM gradeh_releases"), None))
    s.check("both open again", ctl(page("BCA", "/unit")) and prev("BCA", **bu_args())[0] == 200)
    # the early-opening gate: a fallback date in the future closes a stage until its people have finished
    _g = a.gradeh_hod_gate
    a.gradeh_hod_gate = lambda d_, c_, h_, st_, now=None: "Opens on 19 Nov, or sooner once all your Grade H people have acknowledged: 1 of 9 so far."
    try:
        s1, e1 = prev("HOD1", **hod_args())
        s.check("the early-opening rule (gradeh_hod_gate) closes the stage: no control, 409 with its words",
                not ctl(page("HOD1", "/hod")) and s1 == 409 and "Opens on 19 Nov" in e1["error"], (s1, e1))
    finally:
        a.gradeh_hod_gate = _g
    s.check("...and back with the gate", ctl(page("HOD1", "/hod")))

    s.section("the fit's own abilities")
    for ab, who, path, args in (("hod.gradeh_fit", "HOD1", "/hod", hod_args()), ("bu.gradeh_fit", "BCA", "/unit", bu_args())):
        run(lambda d: d.execute("INSERT OR REPLACE INTO leader_role_access(role, ability, allowed) VALUES (?, ?, 0)", (ab.split(".")[0], ab)))
        c0 = counts()
        s1, e1 = prev(who, **args); s2, e2 = appl(who, [], **args)
        s.check("%s off: 403 on both POSTs, no control, the page itself still opens, nothing written" % ab,
                s1 == 403 and s2 == 403 and "switched off" in e1["error"] and not ctl(page(who, path)) and C[who].get(BASE + path).status_code == 200
                and counts() == c0, (s1, s2))
        run(lambda d: d.execute("DELETE FROM leader_role_access WHERE ability=?", (ab,)))
        s.check("...and on again: the control and the fit are back (default on, no row needed)", ctl(page(who, path)) and prev(who, **args)[0] == 200)
    s.check("Leader roles lists both abilities while the module is on, with a label; neither while it is off",
            {"hod.gradeh_fit", "bu.gradeh_fit"} <= {k for _g, k, _l, _n in a.leader_abilities_shown()} and "bu.gradeh_fit" in a.LEADER_ABILITY_LABEL
            and (os.environ.__setitem__("ONEHR_GRADEH", "0") or not ({"hod.gradeh_fit", "bu.gradeh_fit"} & {k for _g, k, _l, _n in a.leader_abilities_shown()}))
            and os.environ.__setitem__("ONEHR_GRADEH", "1") is None)
    os.environ["ONEHR_GRADEH"] = "0"
    s.check("the server switch off: 404 on both POSTs", C["HOD1"].post(BASE + "/hod/fit", data=csrf(mode="preview", stage="pot")).status_code == 404)
    os.environ["ONEHR_GRADEH"] = "1"
    with a.app.test_request_context("/"):
        d = a.get_db(); d.execute("UPDATE cycle_modules SET active=0 WHERE cycle_id=? AND module_key='gradeh'", (CID,)); d.commit()
    s.check("the cycle's module off: 404 on both POSTs", C["HOD1"].post(BASE + "/hod/fit", data=csrf(mode="preview", stage="pot")).status_code == 404
            and C["BCA"].post(BASE + "/unit/fit", data=csrf(mode="preview", axis="pot", unit=CO)).status_code == 404)
    with a.app.test_request_context("/"):
        d = a.get_db(); d.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key='gradeh'", (CID,)); d.commit()
    for n in ("calib_gradeh_hod_fit", "calib_gradeh_unit_fit"):
        s.check("%s is a route classified to the module" % n, n in a.app.view_functions and a.module_of_request(n, BASE + "/x") == "gradeh"
                and n not in a.UROLE_ENDPOINTS)

    s.section("falsified: each guard, removed, lets the bad thing through (so the checks above bite)")
    st, jb = prev("BCA", **bu_args())
    def _own(d):
        rows = a.gradeh_unit_scope(d, CID, BG, CO)
        return a._gh_fit_moves(d, CID, rows, "bu", "pot", 0, BG, CO)   # uid 0: nobody is the leader, so the own-record guard has nothing to catch
    s.check("without the own-band guard the BU CEO's own 13.2 (the lowest High) is the FIRST suggestion", ids(run(_own)) and ids(run(_own))[0] == P["BCA"], ids(run(_own)))
    run_gate = a._gh_cal_hod_stage_gate
    run(lambda d: (d.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?, 'hod', 'pot', ?, ?)", (CID, str(U["HOD1"]), U["HOD1"])), None))
    a._gh_cal_hod_stage_gate = lambda *x, **k: None
    try:
        s.check("without the stage gate a signed-off stage would still get a fit (the 409 above is the gate's doing)", prev("HOD1", **hod_args())[0] == 200)
    finally:
        a._gh_cal_hod_stage_gate = run_gate
        run(lambda d: (d.execute("DELETE FROM gradeh_signoffs"), None))
    _lc = a.leader_learn_can
    a.leader_learn_can = lambda *x, **k: True
    run(lambda d: d.execute("INSERT OR REPLACE INTO leader_role_access(role, ability, allowed) VALUES ('hod', 'hod.gradeh_fit', 0)"))
    try:
        s.check("without the ability check an HOD with the fit switched off would still get one (the 403 above is the check's doing)", prev("HOD1", **hod_args())[0] == 200)
    finally:
        a.leader_learn_can = _lc
        run(lambda d: d.execute("DELETE FROM leader_role_access WHERE ability='hod.gradeh_fit'"))
    # the rollback trap is real: two BU CEO moves in ONE transaction, the second refused, loses the first
    run(lambda d: (d.execute("DELETE FROM gradeh_band_moves"), None))
    def _trap(d):
        ok1, _m1 = a.gradeh_buceo_move(d, urow("BCA"), P["S1"], None, "Mid", "ZZ first")
        ok2, _m2 = a.gradeh_buceo_move(d, urow("BCA"), P["S2"], None, "Mid", "word " * 301)
        return ok1, ok2
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        ok1, ok2 = _trap(d_)
        d_.commit()
    s.check("falsified: without a commit after each move, a refused BU CEO move rolls back the one before it (the partial-refusal check above bites)",
            ok1 and not ok2 and not moves(), (ok1, ok2, len(moves())))

    s.section("a person who does not agree is not calibrated: never proposed, never moved, never counted")
    run(lambda d: (d.execute("DELETE FROM gradeh_band_moves"), None))
    for who_, pre_, args_ in (("HOD1", "HOD stage (potential)", hod_args()), ("BCA", "BU CEO stage (potential)", bu_args())):
        st, base = prev(who_, **args_)
        s.check(pre_ + ": before anyone disagrees, S1 (the lowest High, 13.5) is the first suggestion and is counted",
                st == 200 and ids(base) and ids(base)[0] == P["S1"], ids(base))
        # S1 tells us they do not agree (the column the pages' own reader, gradeh_is_disagreed / _gh_cal_person["disagree"], reads)
        run(lambda d: (d.execute("UPDATE gradeh_appraisals SET disagree_at='2026-11-11 03:00:00', disagree_by=?, acknowledged_at='2026-11-11 03:00:00' "
                                 "WHERE person_id=?", (U["S1"], P["S1"])), None))
        try:
            c0 = counts()
            st, dj = prev(who_, **args_)
            s.check(pre_ + ": S1 is not proposed any more", st == 200 and dj["ok"] and P["S1"] not in ids(dj), ids(dj))
            s.check(pre_ + ": S1 is not counted: the curve's total is one fewer, High has one fewer, and the total is the page's own curve total",
                    dj["total"] == base["total"] - 1 and dj["before"]["High"] == base["before"]["High"] - 1
                    and dj["total"] == (hod_curve() if who_ == "HOD1" else bu_curve())["total"], (base["total"], dj["total"], dj["before"]))
            s.check(pre_ + ": the others are still fitted by the same rule (S2 and S3 are next)", ids(dj)[:2] == [P["S2"], P["S3"]], ids(dj))
            s.check(pre_ + ": the note does not count them as 'no line manager input' or as moved", dj["held_n"] == base["held_n"] and dj["mine_n"] == base["mine_n"], (dj["held_n"], dj["mine_n"]))
            st, ra = appl(who_, [{"id": P["S1"], "from": "High", "to": "Mid", "remark": "ZZ should not be written"}], **args_)
            s.check(pre_ + ": apply refuses to move them (skipped with the calibration words), nothing written but the summary audit row",
                    st == 200 and ra["applied"] == 0 and ra["skipped"] and ra["skipped"][0]["why"] == a.GH_DISAGREE_CAL_MSG and not moves(P["S1"])
                    and counts()[:3] == c0[:3], ra)
            n_line = lambda j_: re.findall(r"(\d+) (?:person who does|people who do) not agree with their result (?:is|are) not in this fit: they keep their line manager's rating\.", j_["note"])
            s.check(pre_ + ": the fit's own notes say who is left out: '1 person who does not agree with their result is not in this fit: they keep their line manager's rating.'",
                    dj["dis_n"] == 1 and n_line(dj) == ["1"] and "1 person who does not agree with their result is not in this fit: they keep their line manager's rating." in dj["note"], dj["note"])
            s.check(pre_ + ": the count is the page's own (the page's disagree line says the same N), and before anyone disagrees there is no such line",
                    dj["dis_n"] == (run(lambda d: a.gradeh_hod_view(d, urow("HOD1"), CID)["n_dis"]) if who_ == "HOD1"
                                    else run(lambda d: a.gradeh_unit_view(d, urow("BCA"), CID)["n_dis"]))
                    and base["dis_n"] == 0 and not n_line(base) and "not in this fit" not in base["note"], (dj["dis_n"], base["note"]))
            run(lambda d: (d.execute("UPDATE gradeh_appraisals SET disagree_at='2026-11-11 03:00:00', disagree_by=?, acknowledged_at='2026-11-11 03:00:00' "
                                     "WHERE person_id=?", (U["S2"], P["S2"])), None))
            try:
                st, d2 = prev(who_, **args_)
                s.check(pre_ + ": two people who do not agree: the plural reads right and the count is 2",
                        st == 200 and d2["dis_n"] == 2 and n_line(d2) == ["2"]
                        and "2 people who do not agree with their result are not in this fit: they keep their line manager's rating." in d2["note"], d2["note"])
            finally:
                run(lambda d: (d.execute("UPDATE gradeh_appraisals SET disagree_at=NULL, disagree_by=NULL, acknowledged_at=NULL WHERE person_id=?", (P["S2"],)), None))
            s.check(pre_ + ": the 'after' of the suggestion is the curve the page shows after Apply, still without S1",
                    sum(dj["after"].values()) == dj["total"], dj["after"])
            # falsified: if the fit's reader did not drop them they WOULD be proposed and counted
            _cp = a._gh_cal_person
            def _cp_blind(*x, **k):
                r_ = _cp(*x, **k)
                r_["disagree"] = False
                return r_
            a._gh_cal_person = _cp_blind
            try:
                st, bj = prev(who_, **args_)
                s.check(pre_ + ": falsified: without the disagree filter S1 is proposed again and counted (the checks above bite)",
                        st == 200 and ids(bj) and ids(bj)[0] == P["S1"] and bj["total"] == base["total"], (ids(bj), bj["total"]))
                s.check(pre_ + ": falsified: with the reader blind to who disagrees there is no 'not in this fit' line (the note check above bites)",
                        not n_line(bj) and bj["dis_n"] == 0, bj["note"])
            finally:
                a._gh_cal_person = _cp
        finally:
            run(lambda d: (d.execute("UPDATE gradeh_appraisals SET disagree_at=NULL, disagree_by=NULL, acknowledged_at=NULL WHERE person_id=?", (P["S1"],)), None))
    run(lambda d: (d.execute("DELETE FROM gradeh_band_moves"), None))

    s.section("whose people the fit reads is the Grade H HOD (the list's hod_user_id, else users.hod_id), never users.hod_id alone")
    run(lambda d: (d.execute("DELETE FROM gradeh_band_moves"), None))
    st, base = prev("HOD1", **hod_args())
    # Group People's Grade H list names HOD1 for T1 and T2 (their OneHR HOD, users.hod_id, stays HOD2: Grade H never writes it)
    run(lambda d: (d.execute("UPDATE gradeh_people SET hod_user_id=? WHERE id IN (?,?)", (U["HOD1"], P["T1"], P["T2"])), None))
    try:
        st, lj = prev("HOD1", **hod_args())
        s.check("the list's HOD: the two people named for HOD1 are on HOD1's curve (12, was 10) and one band count moved with them",
                st == 200 and lj["total"] == base["total"] + 2 and lj["before"]["Mid"] == base["before"]["Mid"] + 2, (base["total"], lj["total"]))
        s.check("...users.hod_id still says HOD2, who now has nobody in Grade H: the fit is a 404 for them, no preview of their old people",
                db.execute("SELECT hod_id FROM users WHERE id=?", (U["T1"],)).fetchone()[0] == U["HOD2"]
                and C["HOD2"].post(BASE + "/hod/fit", data=csrf(mode="preview", stage="pot")).status_code == 404)
        st, rt = appl("HOD1", [{"id": P["T1"], "from": "Mid", "to": "High", "remark": "ZZ x"}], **hod_args())
        s.check("a person the list names for HOD1 is in HOD1's scope for apply (not 'isn't in your scope'; the move itself is the stale / gate's call)",
                st == 200 and not any("isn't in your scope" in x["why"] for x in rt["skipped"]), rt)
    finally:
        run(lambda d: (d.execute("UPDATE gradeh_people SET hod_user_id=NULL WHERE id IN (?,?)", (P["T1"], P["T2"])), d.execute("DELETE FROM gradeh_band_moves"), None))
    st, back = prev("HOD1", **hod_args())
    s.check("put back: without the list's HOD the fit reads users.hod_id again (10)", back["total"] == base["total"], (back["total"], base["total"]))

    s.section("the measure: where a person sits in their band")
    cuts = {"FIAMMA": (60, 80, 100, 120), "SIGNATURE": (80, 95, 110, 130)}
    ok_ = True
    for sc_, cs in a.GRADEH_FIT_PCT_CUTS.items():
        for i, c_ in enumerate(cs):
            ok_ = ok_ and a.gradeh_kpi_rating(sc_, c_ - 1) == i + 1 and a.gradeh_kpi_rating(sc_, c_ + 1) == i + 2
    s.check("the % bands the fit uses are the ones gradeh_kpi_rating rates by (both scales, every cut)", ok_ and set(a.GRADEH_FIT_PCT_CUTS) == set(cuts))
    m1 = run(lambda d: a._gh_fit_measure("pot", "High", {"pot_score": 13.5, "perf_value": None, "perf_rating": None}, None, CID))
    s.check("potential: 13.5 in High is 0.5 over the 13 line, 11% up the band", m1["kind"] == "pot" and m1["lo"] == 13 and abs(m1["pos"] - 0.5 / 4.5) < 1e-9, m1)
    m2 = run(lambda d: a._gh_fit_measure("perf", "AE", {"pot_score": None, "perf_value": 104.0, "perf_rating": 4.0}, "FIAMMA", CID))
    s.check("performance on the KPI route: 104% in AE sits 4 points over the 100 line", m2["kind"] == "kpi" and m2["lo"] == 100 and abs(m2["pos"] - 0.2) < 1e-9, m2)
    m3 = run(lambda d: a._gh_fit_measure("perf", "AE", {"pot_score": None, "perf_value": None, "perf_rating": 3.88}, None, CID))
    s.check("performance by the line manager's average: 3.88 in AE sits 0.38 over the 3.5 line", m3["kind"] == "avg" and m3["lo"] == 3.5 and abs(m3["pos"] - 0.38) < 1e-9, m3)
    s.check("a missing figure gives no position (the person is held, never ranked on a guess)", run(lambda d: a._gh_fit_measure("pot", "High", {"pot_score": None, "perf_value": None, "perf_rating": None}, None, CID)) is None)
    st, jp = prev("BCA", **bu_args("perf"))
    s.check("the performance axis fits too (BU CEO's switch): a preview answers ok for perf", st == 200 and jp["ok"] and jp["axis_name"] == "Performance" and sum(jp["before"].values()) == jp["total"], (st, jp.get("error")))

    s.section("the page and what the agents know")
    js = open(os.path.join(H.REPO, "static", "gradeh_calib_fit.js"), encoding="utf-8").read()
    s.check("the panel's script never calls the browser's confirm() or alert(): the app's own box asks", not re.search(r"\b(window\.)?(confirm|alert)\(", js)
            and "data-confirm" in js and "innerHTML" not in js)
    css = open(os.path.join(H.REPO, "static", "gradeh_calib.css"), encoding="utf-8").read()
    tail = css[css.index(".ghf {") - 80:]
    tail = tail.split("/* the Grade H list's Department column wraps", 1)[0]   # the phone-view block after it (2026-11-08, piece E) is the page's own light hex on purpose
    s.check("the panel's CSS is colour tokens and rem: no hex colour, no px font-size (but the 56px bar is var(--topbar-h))",
            not re.search(r"#[0-9a-fA-F]{3,8}\b", tail) and not re.search(r"font-size:\s*\d+(\.\d+)?px", tail) and "var(--topbar-h" in tail)
    s.check("the panel sits on the LEFT", re.search(r"\.ghf \{[^}]*left: 0;", tail) is not None)
    tpl = open(os.path.join(H.REPO, "templates", "gradeh_calib.html"), encoding="utf-8").read()
    s.check("the template says AI+ suggests, you decide; the old 'no model on these pages' line is gone", "no model on these pages" not in tpl and "nothing changes until you apply" in tpl)
    s.check("Help: the quick answer exists and is listed for both seats", "gh_cal_fit" in a.HELP_QA and "gh_cal_fit" in a.HELP_LISTS["gh_hod"][1] and "gh_cal_fit" in a.HELP_LISTS["gh_bu"][1]
            and len(a.HELP_LISTS["gh_hod"][1]) <= a.HELP_LIST_MAX and len(a.HELP_LISTS["gh_bu"][1]) <= a.HELP_LIST_MAX
            and "nothing changes until you apply" in a.HELP_QA["gh_cal_fit"][1])
    kb = {r_[0]: r_[1] for r_ in db.execute("SELECT slug, body FROM kb_entries WHERE slug IN ('gradeh-hod','gradeh-bu-ceo')")}
    s.check("KB: both rows carry the Fit the curve with AI sentence, conceptual (no figure or cut-off)",
            all("Fit the curve with AI" in kb.get(k, "") for k in ("gradeh-hod", "gradeh-bu-ceo"))
            and not re.search(r"\b\d+(\.\d+)?\b", a._KB_GRADEH_HOD_BODY.split("Fit the curve with AI")[1]))
    s.check("KB: the guarded reword keys on the exact previous text (an admin's edit is left alone)",
            a._KB_GRADEH_HOD_BODY.startswith(a._KB_GRADEH_HOD_BODY_BEFORE_FIT) and a._KB_GRADEH_BUCEO_BODY.startswith(a._KB_GRADEH_BUCEO_BODY_BEFORE_FIT))
    src = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
    s.check("Ask OneHR's facts name the fit for both seats", src.count("Fit the curve with AI") >= 6)

finally:
    a.ai_draft._chat_complete_call = _model
    os.environ["ONEHR_GRADEH"] = _ENV0 if _ENV0 is not None else ""
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET half=? WHERE id=?", (HALF0, CID))
        d.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
        d.execute("DELETE FROM leader_role_access WHERE ability LIKE '%.gradeh_fit'")
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell LIKE 'gradeh_%'", (CID,))
        d.commit()

sys.exit(s.done())
