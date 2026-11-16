"""Talent Box Round 2 -- the BG CEO's check-in page and agents (Chris, 2026-11-14, piece 3 of OneHR/Talent Box Round 2 2026-11-14/BUILD-PLAN.md).

  "round 2 bar will only show after admin pushes to BGCEO for round 2" / "the top bar row to show Calibration round 1 and
   Calibration round 2 respectively"

What this suite holds (each guard is falsified: where it stays off AND where it comes on are both checked):
  * before a push, in 'admin' mode (Group People re-place the unit) and for anyone but the seated BG CEO: no steps on the Calibration
    bar, no Round 2 facts in the box, the agents say nothing of Round 2; after a push: both steps (round 1 ticked, round 2 open), the
    facts (units, forecast -> actual PAT, curve before -> after, lock-by day), Suggest with AI offered
  * Calibration round 1 is the Round 1 record read only: every person where tb_round1_marks says, nobody movable, the forecast PAT; the
    live box (round 2) counts a move SINCE Round 1 and is outside the moves cap while its round is open
  * the lock-by day passed: read only and "Group People finish it"; locked: both steps ticked, "replaces round 1"
  * Suggest with AI is hidden when the seat's bg.fit is off; its chat message is fixed words built from the fit (no model, no name)
  * the Talent Box agent's prompt and first line carry the round (unit, PAT forecast -> actual, curve before -> after, lock-by day)
    and no staff name; Ask OneHR's guide, the KB row and Help's quick answer are there, with no figure, band or name
Its own synthetic business groups on the SHARED suite database (ZZR3-*); everything is put back at the end.
"""
import json
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Talent Box Round 2 -- the BG CEO's check-in page, Suggest with AI and what the agents know")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
_real_avail = a.ai_draft.review_agent_available
a.ai_draft.review_agent_available = lambda: True
SU, BGA, _E = H.actors(a)
BG, BG2 = "ZZR3 Group", "ZZR3 Two"
UA, UB, UC = "ZZR3 Alpha", "ZZR3 Beta", "ZZR3 Gamma"
W1 = "ZZR3 Whisky"
PFX = "ZZR3-"
REASON = "ZZR3 the actual PAT is in"
XHR = {"X-Requested-With": "XMLHttpRequest", "Sec-Fetch-Mode": "cors"}

with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    # a run that died half-way: its rounds, locks and people go first
    db.execute("DELETE FROM tb_round1_marks WHERE round_id IN (SELECT id FROM tb_rounds WHERE business_group IN (?,?))", (BG, BG2))
    db.execute("DELETE FROM tb_rounds WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM talent_box_bu_locks WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM pm_pbt_achievement WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZR3-%'")
    _ORIG = {"half": db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0],
             "settings": {k: (r[0] if r else None) for k in ("ai_calib", "review_unified", "tb_limit_moves_on", "tb_limit_moves_pct",
                                                              "tb_limit_stars_on")
                          for r in [db.execute("SELECT value FROM app_settings WHERE key=?", (k,)).fetchone()]},
             "modules": {r[0]: r[1] for r in db.execute("SELECT module_key, active FROM cycle_modules WHERE cycle_id=? "
                                                         "AND module_key IN ('review','calibration','pm','tm')", (CID,))},
             "windows": [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=? AND cell='tb_bgceo'", (CID,))],
             "max": {tb: db.execute("SELECT COALESCE(MAX(id),0) FROM %s" % tb).fetchone()[0]
                     for tb in ("calibration_sessions", "pm_calibration_sessions", "calibration_adjustments",
                                "pm_calibration_adjustments", "pm_kpi_targets", "activity_log", "email_outbox", "late_passes",
                                "notifications")}}
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN ('review','calibration','pm','tm')", (CID,))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='tb_bgceo'", (CID,))   # open all cycle
    for k in ("ai_calib", "review_unified"):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k,))
    for k in ("tb_limit_moves_on", "tb_limit_stars_on"):
        db.execute("DELETE FROM app_settings WHERE key=?", (k,))
    for bg_, cos in ((BG, (UA, UB, UC)), (BG2, (W1,))):
        for co in cos:
            db.execute("INSERT OR IGNORE INTO org_units(business_group, company, active) VALUES (?,?,1)", (bg_, co))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, company, bg=BG, email=None, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=email, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=bg, company=company)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        uid = db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group) "
                   "VALUES (?,?,?,100,'more','approved',?)", (PER, uid, "ZZR3 KPI", bg))
        return uid
    BOSS = person(PFX + "CEO", "ZZ R3 Group CEO", UC, bgceo_bg=BG, email="zzr3-ceo@example.test")
    BOSS2 = person(PFX + "CE2", "ZZ R3 Two CEO", W1, bg=BG2, bgceo_bg=BG2, email="zzr3-ce2@example.test")
    SPEC = {UA: [("ME", "Mid"), ("ME", "Mid"), ("ME", "Mid"), ("BE", "Low"), ("OU", "High"), ("AE", "Mid")],
            UB: [("ME", "Mid"), ("AE", "Mid"), ("ME", "High")],
            UC: [("ME", "Mid"), ("ME", "Mid")]}
    P = {co: [person("%s%s%d" % (PFX, co.split()[-1][:3].upper(), i), "ZZ R3 %s %d" % (co.split()[-1], i), co)
              for i in range(len(specs))] for co, specs in SPEC.items()}
    SPEC2 = {W1: [("ME", "Mid"), ("AE", "Mid"), ("ME", "Mid")]}
    P2 = {W1: [person(PFX + "WH%d" % i, "ZZ R3 Whisky %d" % i, W1, bg=BG2) for i in range(3)]}
    for co, ids in list(P.items()) + list(P2.items()):   # their BU CEOs banded and locked both axes
        specs = SPEC.get(co) or SPEC2[co]
        bgx = BG if co in P else BG2
        pa = a._pm_calib_get_or_create_session(db, PER, "buceo", co, bgx, co)
        ca = a._get_or_create_calibration_session(db, CID, "buceo", co, bgx, co)
        for sid, (pb, qb) in zip(ids, specs):
            a._pm_calib_upsert_adjustment(db, pa["id"], sid, "", pb, "BU set", BOSS)
            a._calibration_upsert_adjustment(db, ca["id"], sid, "", qb, "BU set", BOSS)
        db.execute("UPDATE pm_calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE id=?", (pa["id"],))
        db.execute("UPDATE calibration_sessions SET locked_at=CURRENT_TIMESTAMP WHERE id=?", (ca["id"],))
    for bgx, co in [(BG, c) for c in P] + [(BG2, W1)]:   # forecast PAT 85% = Normal
        db.execute("INSERT OR REPLACE INTO pm_pbt_achievement(cycle_id, business_group, company, achievement_pct) VALUES (?,?,?,85)",
                   (PER, bgx, co))
    db.commit()
    SUROW = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())

a.mailer.is_configured = lambda: True      # emails queue (the sender is never started: _outbox_kick is stubbed)
a._outbox_kick = lambda *x, **k: False
STAND = []   # what the fit stand-in was asked


def ctx(fn):
    with a.app.test_request_context("/"):
        return fn(a.get_db())


def exe(sql, args=()):
    def f(d):
        d.execute(sql, args)
        d.commit()
    ctx(f)


def one(sql, args=()):
    return H.one(a, sql, args)


def rows(sql, args=()):
    return [dict(r) for r in H.rows(a, sql, args)]


SUP, BOSSC, BOSS2C = H.client_as(a, SU["id"]), H.client_as(a, BOSS), H.client_as(a, BOSS2)
EMPC = H.client_as(a, P[UB][0])
URL = "/admin/calibration/talent-box/round2/"


def post(c, url, **d):
    d.setdefault("csrf_token", "tok")
    return c.post(url, data=d, headers=XHR)


def js(r):
    try:
        return r.get_json() or {}
    except Exception:   # noqa: BLE001
        return {}


def actual(co, pct, bg=BG):
    return post(SUP, URL + "actual", bg=bg, company=co, actual_pct=str(pct), remark=REASON)


def openr(co, mode, bg=BG, due_on=None):
    d = {"bg": bg, "company": co, "mode": mode, "remark": REASON}
    if due_on:
        d["due_on"] = due_on
    return post(SUP, URL + "open", **d)


def tblock(c, co, bg=BG):
    return post(c, "/talent-box/bg/%s/lock" % bg, ajax="1", company=co)


def move(c, sid, perf=None, pot=None, bg=BG):
    d = {"subject_id": str(sid)}
    if perf:
        d["performance_band"] = perf
    if pot:
        d["potential_band"] = pot
    return post(c, "/talent-box/bg/%s/move" % bg, **d)


def hist(c, co=None, rtab=None):
    q = "/review/chat/history?journey=1&view=bg&stage=talent_box" + ("&company=" + co.replace(" ", "+") if co else "") + \
        ("&rtab=%s" % rtab if rtab else "")
    j = c.get(q).get_json() or {}
    return (j.get("overview") or {}).get("data") or {}, j.get("modtabs_html") or ""


def people(d):
    return {p["id"]: (p["perf"], p["pot"], p["category"], c["key"], p) for c in d.get("cells") or [] for p in c["people"]}


def sysprompt(uid, co):
    with a.app.test_request_context("/review/journey?view=bg&stage=talent_box&company=" + co.replace(" ", "+")):
        a.session["user_id"] = uid
        db_ = a.get_db()
        u = db_.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return a._talent_box_system(db_, u), a._talent_box_opener(db_, u)


def fit_for(sg_ids, frm="ME", to="AE"):
    """The fit stand-in: propose frm -> to for these people (a known proposal; the real fit is piece 1's own suite)."""
    def fake(db_, u_, c_, tier_):
        mv = [{"id": i, "name": "x", "from": frm, "to": to, "direction": "up", "reasons": ["a stand-in"]} for i in sg_ids]
        STAND.append(([p["id"] for p in c_["population"]], tier_))
        return {"moves": mv, "within_after": True, "unscored": [], "message": "%d stand-in moves." % len(mv)}
    return fake


# ======================================================================================================================
s.section("Round 1: the BG CEO locks the units on the forecast; nothing of Round 2 shows before a push")
for co in (UA, UB):
    r = tblock(BOSSC, co)
    s.check("%s locked by the BG CEO" % co, js(r).get("ok") is True, js(r))
r = tblock(BOSS2C, W1, bg=BG2)
s.check("(the other group) %s locked" % W1, js(r).get("ok") is True, js(r))
d0, mt0 = hist(BOSSC, UA)
s.check("no push: the box is the box it always was (no round2, no round tab on the bar, no tab-1 button)",
        "round2" not in d0 and d0.get("company") == UA and d0.get("bu_locked") is True and "data-tb-rtab" not in mt0
        and "Calibration round" not in mt0 and "Talent Box" in mt0, (list(d0)[:6], mt0[:200]))
for co in (UA, UB):
    s.check("the actual PAT for %s" % co, js(actual(co, 62)).get("ok") is True)
s.check("the actual for the other group's unit", js(actual(W1, 62, bg=BG2)).get("ok") is True)
d1, mt1 = hist(BOSSC, UA)
s.check("an actual PAT saved and the curve shifted but nothing opened: still nothing for the BG CEO", "round2" not in d1
        and "data-tb-rtab" not in mt1, list(d1)[:5])
r = openr(W1, "admin", bg=BG2)
dw, mtw = hist(BOSS2C, W1)
s.check("'Do Round 2 here' (Group People re-place it): the BG CEO sees nothing new -- no round2, no steps (admin mode never shows)",
        js(r).get("ok") is True and "round2" not in dw and "data-tb-rtab" not in mtw and dw.get("bu_locked") is True, (js(r), list(dw)[:6]))
s.check("...and the agent says nothing of Round 2", "ROUND 2" not in sysprompt(BOSS2, W1)[0] and "Round 2" not in sysprompt(BOSS2, W1)[1])

# ======================================================================================================================
s.section("pushed: the steps, the facts, Suggest with AI")
DUE = (a._today_myt() + timedelta(days=3))
r = openr(UA, "bgceo", due_on=DUE.isoformat())
s.check("Alpha pushed to the BG CEO, lock-by %s" % DUE, js(r).get("ok") is True, js(r))
RID = one("SELECT id FROM tb_rounds WHERE company=? AND period_id=?", (UA, PER))
d, mt = hist(BOSSC, UA)
R = d.get("round2") or {}
U = R.get("unit") or {}
DAY = DUE.strftime("%a %-d %b")
s.check("the overview carries the round facts for the unit on screen: its forecast and actual PAT, its curve before and after, the lock-by day",
        U.get("key") == UA and U.get("state") == "open" and U.get("forecast") == "85%" and U.get("actual") == "62%"
        and U.get("before") == "Normal" and U.get("after") == "Negatively skewed" and U.get("due") == DAY and U.get("due_on") == DUE.isoformat()
        and R.get("tab") == "2" and R.get("open_n") == 1 and R.get("can_suggest") is True and R.get("readonly") is False
        and R.get("bg") == BG and "_marks" not in R and [x["key"] for x in R.get("units") or []] == [UA], R)
s.check("the Calibration bar: both steps, round 1 ticked, round 2 open and picked, the round 1 tab clickable",
        'data-tb-rtab="1"' in mt and 'data-tb-rtab="2"' in mt and "Calibration round 1" in mt and "Calibration round 2" in mt
        and re.search(r'data-tb-rtab="1"[^>]*aria-selected="false"', mt) and re.search(r'data-tb-rtab="2"[^>]*aria-selected="true"', mt)
        and "rv-mt-done rv-mt-rtab" in mt and "rv-mt-cur rv-mt-rtab" in mt and "&#10003;" in mt and "disabled" not in mt, mt)
cos = {c["key"]: c for c in d.get("companies") or []}
s.check("the pushed unit's pill says it (forecast, actual, state); the others carry nothing",
        cos[UA].get("round") == {"state": "open", "forecast": "85%", "actual": "62%"} and "round" not in cos[UB] and "round" not in cos[UC], cos)
s.check("the box is the live one: Alpha is no longer locked (its lock row went with the push), nobody counted as moved yet",
        d.get("bu_locked") is False and d.get("cap_on") is False and not [p for c in d["cells"] for p in c["people"] if p["moved"]],
        (d.get("bu_locked"), d.get("cap_on")))
hn = BOSSC.get("/review/chat/history?journey=1&view=bg&stage=talent_box&company=" + UA.replace(" ", "+")).get_json() or {}
s.check("the left panel's row for the pushed unit says the PAT change (and the others keep their one figure)",
        "6 people \u00b7 PAT\u00a085%\u00a0\u2192\u00a062%" in (hn.get("nav_html") or "") and (hn.get("nav_html") or "").count("\u2192") == 1
        and "3 people \u00b7 PAT 62%" in (hn.get("nav_html") or ""),   # (the arrow only on the pushed unit)
        re.findall(r"\d+ (?:person|people) \u00b7 PAT[^<\"]*", hn.get("nav_html") or ""))
dC, mtC = hist(BOSSC, UC)
RC = dC.get("round2") or {}
s.check("a unit that was not pushed (Gamma) on screen: the facts are there, its own unit is None, the bar keeps the steps with round 1 disabled",
        RC.get("unit") is None and RC.get("open_n") == 1 and 'data-tb-rtab="1"' in mtC and re.search(r'data-tb-rtab="1"[^>]*disabled', mtC)
        and "round2" in dC, (RC.get("unit"), mtC))
# only the seated BG CEO of that group; the admin's own copy of the box passes a company and is never the chat's
dadm = ctx(lambda d_: a._journey_talent_box_overview(d_, SUROW, ("bgceo", {"bg": BG}, a._talent_box_resolve(d_, SUROW, "bgceo", admin_view=True, bg=BG)),
                                                     company=UA, all_filters=True, picks={}))
s.check("falsified: the admin's copy of the box (a super admin reading it) gets no round2", "round2" not in (dadm or {"x": 1}) and dadm is not None)
d2o, mt2o = hist(BOSS2C, W1)
s.check("falsified: the other group's CEO (nothing pushed there) still sees nothing", "round2" not in d2o and "data-tb-rtab" not in mt2o)

# --- Calibration round 1: the record
s.section("Calibration round 1: the Round 1 record, read only")
marks = {r["subject_id"]: (r["perf_band"], r["pot_band"], r["category"]) for r in rows("SELECT * FROM tb_round1_marks WHERE round_id=?", (RID,))}
s.check("the Round 1 record was taken at the BG CEO's lock: one mark for each of Alpha's people", len(marks) == len(P[UA]) == 6, marks)
who = move(BOSSC, P[UA][0], perf="AE", pot="High")
s.check("the BG CEO moves someone on the live box (round 2): Round 1 placements started it, the move is theirs", js(who).get("ok") is True, js(who))
dm, mtm = hist(BOSSC, UA)
mv = {i: v for i, v in people(dm).items() if v[4]["moved"]}
s.check("round 2 counts a move SINCE ROUND 1 (the person moved, from the category they stood in at Round 1; nobody else)",
        list(mv) == [P[UA][0]] and mv[P[UA][0]][4]["from_cat"] and mv[P[UA][0]][4]["from_key"] == "mid|Mid" and mv[P[UA][0]][4]["up"] is True
        and mv[P[UA][0]][0] == "AE", {i: (v[0], v[1], v[4]["from_cat"]) for i, v in mv.items()})
d1v, mt1v = hist(BOSSC, UA, rtab="1")
R1 = d1v.get("round2") or {}
now1 = people(d1v)
s.check("Calibration round 1 (?rtab=1): the tab says '1', the bar's round 1 step is the picked one",
        R1.get("tab") == "1" and re.search(r'data-tb-rtab="1"[^>]*aria-selected="true"', mt1v)
        and re.search(r'data-tb-rtab="2"[^>]*aria-selected="false"', mt1v), (R1.get("tab"), mt1v))
s.check("...every person sits where tb_round1_marks put them, whatever the BG CEO did since (the move is not in it)",
        {i: (v[0], v[1]) for i, v in now1.items()} == {i: (m[0], m[1]) for i, m in marks.items()}
        and now1[P[UA][0]][0] == "ME" and now1[P[UA][0]][3] == "mid|Mid", {i: v[:2] for i, v in now1.items()})
s.check("...and the category each stood in (the box's own label for that cell), the forecast PAT and curve, the unit locked",
        all(v[2] == next(c["label"] for c in d1v["cells"] if c["key"] == v[3]) for v in now1.values())
        and d1v.get("pat") == 85.0 and (d1v.get("perf_curve") or {}).get("curve", {}).get("label") == "Normal"
        and (d1v.get("perf_curve") or {}).get("curve", {}).get("pct") == 85.0
        and d1v.get("bu_locked") is True and d1v.get("locked") is True and d1v.get("both_locked") is True
        and d1v.get("placed") == len(marks), (d1v.get("pat"), d1v.get("perf_curve", {}).get("curve")))
s.check("...nobody can be moved in it, nobody counts as moved, nothing suggested",
        all(p["locked"] is True and p["moved"] is False for _i, (_a, _b, _c, _k, p) in now1.items()) and d1v["cap_on"] is False)
dist = (d1v["perf_curve"] or {}).get("distribution") or {}
s.check("...its performance spread is the Round 1 record's (ME x4 -> 3 + 1, BE 1, OU 1, AE 1 by marks)",
        dist == {b: sum(1 for m in marks.values() if m[0] == b) for b in a.PM_BAND_ORDER}, dist)
s.check("...the pill carries the forecast and the lock tick for the unit (as it stood), no 'updated' tag",
        {c["key"]: c for c in d1v["companies"]}[UA]["pat"] == 85.0 and {c["key"]: c for c in d1v["companies"]}[UA]["tb_locked"] is True)
s.check("round 1 is refused for a unit with no record (Gamma): the page falls to round 2", (hist(BOSSC, UC, rtab="1")[0].get("round2") or {}).get("tab") == "2")
exe("DELETE FROM tb_round1_marks WHERE round_id=?", (RID,))
dn, _mn = hist(BOSSC, UA, rtab="1")
s.check("falsified: with the record gone the same ask falls to round 2 (the tab never lies about what it shows)",
        (dn.get("round2") or {}).get("tab") == "2" and people(dn)[P[UA][0]][0] == "AE")
for sid, m in marks.items():
    exe("INSERT INTO tb_round1_marks(round_id, subject_id, perf_band, pot_band, category) VALUES (?,?,?,?,?)", (RID, sid, m[0], m[1], m[2]))

# --- Suggest with AI
s.section("Suggest with AI: the fixed words, the bg.fit switch, Apply all")
real_fit = a._pm_calib_fit_moves
a._pm_calib_fit_moves = fit_for([P[UA][1], P[UA][2]])
sg = BOSSC.get("/talent-box/round2/suggest?bg=%s&company=%s" % (BG.replace(" ", "+"), UA.replace(" ", "+")))
J = js(sg)
s.check("Suggest (the BG CEO, their pushed unit) proposes and says why in the chat's own FIXED WORDS (a string built in code)",
        sg.status_code == 200 and J.get("ok") and J.get("count") == 2 and isinstance(J.get("chat"), str)
        and "On the Negatively skewed curve" in J["chat"] and "expects about" in J["chat"] and "you have" in J["chat"]
        and "2 people from Meet Expectation to Above Expectation" in J["chat"] and "Apply all" in J["chat"], J.get("chat"))
s.check("...the words carry no staff name (the moves are counted by band; the names stay on the box)",
        not re.search(r"ZZ R3 ", J["chat"]) and all(m["name"] == "x" for m in J["moves"]))
a._pm_calib_fit_moves = fit_for([])
J0 = js(BOSSC.get("/talent-box/round2/suggest?bg=%s&company=%s" % (BG.replace(" ", "+"), UA.replace(" ", "+"))))
s.check("no moves to suggest: the words say so, never invent one", J0.get("ok") and J0["chat"].endswith("so I have no moves to suggest.")
        and "I'd move" not in J0["chat"], J0.get("chat"))
a._pm_calib_fit_moves = real_fit
w = a._tb_round_fit_words("Unit", {"label": "Normal", "dist": a.PM_DIST_CURVES["normal"]}, {"UA": 0, "BE": 0, "ME": 10, "AE": 0, "OU": 0},
                          {"moves": [], "within_after": False})
s.check("the words work on a spread the fit cannot improve: it says it is the BG CEO's judgement", "your judgement" in w, w)
exe("INSERT OR REPLACE INTO leader_role_access(role, ability, allowed) VALUES ('bg', 'bg.fit', 0)")
doff, mtoff = hist(BOSSC, UA)
Roff = doff.get("round2") or {}
s.check("bg.fit OFF for the seat (Leader roles): the page carries can_suggest False, so the button is not drawn; the route refuses too",
        Roff.get("can_suggest") is False and Roff.get("unit", {}).get("state") == "open"
        and js(BOSSC.get("/talent-box/round2/suggest?bg=%s&company=%s" % (BG.replace(" ", "+"), UA.replace(" ", "+")))).get("ok") is not True)
exe("DELETE FROM leader_role_access WHERE role='bg' AND ability='bg.fit'")
s.check("falsified: bg.fit back on, the control is offered again", (hist(BOSSC, UA)[0].get("round2") or {}).get("can_suggest") is True)
src = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
s.check("the page draws Suggest with AI only when the server says can_suggest (and the round is open), and Apply all posts what it showed",
        "r2.can_suggest && u.state === \"open\"" in src and "r2.suggest_url" in src and "r2.apply_url" in src
        and 'JSON.stringify(sg.moves.map(function (m) { return { id: m.id, from: m.from, to: m.to }; }))' in src)
s.check("the Suggest strip, the '+n suggested' row and the 'AI: -> ME' marks draw only once Suggest was clicked (tb.sg), and Dismiss clears it",
        "function tbR2AiStrip" in src and "var sg = tb.sg; if (!sg || !sg.count" in src and "function tbR2Dismiss() {\n    tb.sg = null;" in src)
s.check("the PAT bar's smaller state is remembered in this browser only, in a try / catch",
        re.search(r"function tbR2Min\(\) \{ try \{ return window\.localStorage\.getItem\(TB_R2_MIN_KEY\) === \"min\"; \} catch", src)
        and "tbR2SetMin" in src and re.search(r"try \{ window\.localStorage\.setItem\(TB_R2_MIN_KEY", src))
s.check("a click on a step re-reads the box for that round, and the chat turn and the refresh both carry it (?rtab=1)",
        'e.target.closest("[data-tb-rtab]")' in src and src.count('"&rtab=1"') >= 1 and 'f.append("rtab", "1")' in src)
# Apply all through the real route (the fit stood in; every move still goes through _talent_box_apply)
a._pm_calib_fit_moves = fit_for([P[UA][1], P[UA][2]])
ap = post(BOSSC, "/talent-box/round2/apply", bg=BG, company=UA,
          moves=json.dumps([{"id": P[UA][1], "from": "ME", "to": "AE"}, {"id": P[UA][2], "from": "ME", "to": "AE"}]))
s.check("Apply all applies what it was shown, through the box's own writer", js(ap).get("ok") and js(ap).get("applied") == 2, js(ap))
a._pm_calib_fit_moves = real_fit
da, _ma = hist(BOSSC, UA)
s.check("...the box now counts three moves since Round 1 (one by hand, two applied)", len([p for c in da["cells"] for p in c["people"] if p["moved"]]) == 3)

# --- the agents
s.section("what the Talent Box agent knows of a pushed round")
sysp, opener = sysprompt(BOSS, UA)
NAMES = [r["full_name"] for r in rows("SELECT full_name FROM users WHERE employee_id LIKE 'ZZR3-%'")]
i0 = sysp.index("TALENT BOX ROUND 2")
_end = sysp.find("\n\n", sysp.index("ON SCREEN NOW", i0))
brief = sysp[i0:_end if _end > 0 else len(sysp)]
s.check("the system prompt carries the open round: the unit, the PAT forecast -> actual, the curves before -> after, the lock-by day, the steps",
        "TALENT BOX ROUND 2" in sysp and UA.split()[-1] in brief and "PAT 85% forecast (Normal curve) to 62% actual (Negatively skewed curve)" in brief
        and ("lock by %s" % DAY) in brief and "Calibration round 1" in brief and "Calibration round 2" in brief and "SUGGEST WITH AI is a BUTTON" in brief
        and "Round 2's lock REPLACES round 1" in brief, brief[:600])
s.check("...it tells the model it never clicks Suggest, never invents a band or a count, and that round 1 is read only",
        "You never click it or apply it" in brief and "never invent a band, a name or a count" in brief and "READ ONLY" in brief)
s.check("...and no staff name in the round's own lines (the people the box already lists are the box's)", not any(n in brief for n in NAMES), [n for n in NAMES if n in brief])
s.check("the first line says it in fixed words: the actual PAT against the forecast, the curve change, the lock-by day, and points to Suggest with AI",
        "Group People has entered the actual PAT for" in opener and "62%" in opener and "85% forecast" in opener
        and "from the Normal to the Negatively skewed curve" in opener and ("Lock by %s" % DAY) in opener and "Suggest with AI" in opener
        and not any(n in opener for n in NAMES), opener)
sys1, _o1 = sysprompt(BOSS, UC)
s.check("a unit that was not pushed: the prompt still names the round but says this unit stays as it is",
        "TALENT BOX ROUND 2" in sys1 and "is not one of those" in sys1)
s.check("the facts are the seated BG CEO's: a person who is not that business group's CEO gets None (falsified: the seat gets them)",
        ctx(lambda d_: a._tb_round_bg_view(d_, d_.execute("SELECT * FROM users WHERE id=?", (BOSS2,)).fetchone(),
                                           a._talent_box_resolve(d_, SUROW, "bgceo", admin_view=True, bg=BG), UA)) is None
        and ctx(lambda d_: a._tb_round_bg_view(d_, d_.execute("SELECT * FROM users WHERE id=?", (BOSS,)).fetchone(),
                                               a._talent_box_resolve(d_, SUROW, "bgceo", admin_view=True, bg=BG), UA)) is not None)

# --- Ask OneHR, the KB, Help
s.section("Ask OneHR's guide, the knowledge base and Help's quick answer")
with a.app.test_request_context("/"):
    a.session["user_id"] = BOSS
    db_ = a.get_db()
    u_ = db_.execute("SELECT * FROM users WHERE id=?", (BOSS,)).fetchone()
    ctx_ = a._dash_context(db_, u_)
    facts, _links = a._ask_facts(db_, u_, ctx_)
    ub_ = db_.execute("SELECT * FROM users WHERE id=?", (BOSS2,)).fetchone()
    facts2, _l2 = a._ask_facts(db_, ub_, a._dash_context(db_, ub_))
    kb = db_.execute("SELECT slug, title, body, tags FROM kb_entries WHERE slug='talent-box-round-2'").fetchone()
    kbhit = a._journey_tool_search_kb(db_, {"query": "round 2 updated PAT calibration round"})
    hp = a.help_answers(db_, u_, "review_journey", view="bg", stage="talent_box")
    hp2 = a.help_answers(db_, ub_, "review_journey", view="bg", stage="talent_box")
ft = "\n".join(facts)
s.check("Ask OneHR's guide knows (the BG CEO of a group with a pushed round): the units reopened and where to go, a place never a result",
        "TALENT BOX, PAT UPDATED" in ft and "Calibration round 1" in ft and "Calibration round 2" in ft and "Suggest with AI" in ft
        and "no figure, band or name" in ft, [x for x in facts if "TALENT BOX" in x])
line = next(x for x in facts if "TALENT BOX, PAT UPDATED" in x)
s.check("...and the line holds no PAT figure, band or name (a guide, never a result)",
        not re.search(r"\d+\s*%", line) and not any(n in line for n in NAMES) and "62" not in line and "85" not in line, line)
s.check("falsified: the CEO of the group with nothing pushed gets no such line", not any("PAT UPDATED" in x for x in facts2))
s.check("the KB row 'talent-box-round-2' is seeded and conceptual (no figure, band or name), and search_kb finds it",
        kb is not None and "Calibration round 2" in kb["body"] and "Suggest with AI" in kb["body"] and not re.search(r"\d+\s*%", kb["body"])
        and "talent-box-round-2" in json.dumps(kbhit) or "Talent Box round 2" in json.dumps(kbhit), (kb and kb["title"], str(kbhit)[:200]))
s.check("the KB row is the one place seeded by slug (INSERT OR IGNORE, so an admin's edit is never overwritten)",
        len(re.findall(r'"talent-box-round-2"', H.source(a))) == 1 and "INSERT OR IGNORE INTO kb_entries" in H.source(a))
k0 = [i["key"] for i in hp["items"]]
s.check("Help's quick answers on the BG view: the round's answer comes FIRST while a round was pushed to them, fixed words, five at most",
        k0[0] == "bg_round2" and len(k0) <= a.HELP_LIST_MAX and "Calibration round 2" in hp["items"][0]["a"]
        and not re.search(r"\d+\s*%", hp["items"][0]["a"]), k0)
s.check("falsified: for the CEO of the group with nothing pushed it is not there", "bg_round2" not in [i["key"] for i in hp2["items"]])
s.check("...and it is a key in HELP_QA with its question", "bg_round2" in a.HELP_QA and a.HELP_QA["bg_round2"][0].endswith("on my Talent Box?"))

# ======================================================================================================================
s.section("the lock-by day passed, then locked")
exe("UPDATE tb_rounds SET due_at=? WHERE id=?", ((a._utc_now() - timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S"), RID))
dd, mtd = hist(BOSSC, UA)
Rd = dd.get("round2") or {}
s.check("past its lock-by day: state 'due', read only, no Suggest; every person locked (no Move); the bar still says round 2 is the picked step",
        Rd.get("unit", {}).get("state") == "due" and Rd.get("readonly") is True and Rd.get("can_suggest") is False and Rd.get("open_n") == 0
        and Rd.get("due_n") == 1 and all(p["locked"] is True for c in dd["cells"] for p in c["people"])
        and re.search(r'data-tb-rtab="2"[^>]*aria-selected="true"', mtd) and "rv-mt-cur rv-mt-rtab" in mtd, Rd.get("unit"))
sysd, opd = sysprompt(BOSS, UA)
s.check("...the agent is told it is closed (Group People finish it) and the first line says so",
        "CLOSED on" in sysd and "Group People finish" in sysd and "closed on" in opd and "read only" in opd)
r = move(BOSSC, P[UA][3], perf="ME")
s.check("...and the back end agrees (a move is refused: Round 2 closed)", r.status_code == 400 and "closed" in (js(r).get("error") or ""), js(r))
exe("UPDATE tb_rounds SET due_at=? WHERE id=?", (DUE.isoformat() + " 15:59:59", RID))
r = tblock(BOSSC, UA)
s.check("the BG CEO locks Alpha again", js(r).get("ok") is True, js(r))
dl, mtl = hist(BOSSC, UA)
Rl = dl.get("round2") or {}
s.check("locked: state 'locked' with the day, no more can_suggest; both steps ticked (round 2 done); round 1 still readable",
        Rl.get("unit", {}).get("state") == "locked" and Rl["unit"]["locked"] and Rl.get("all_locked") is True and Rl.get("can_suggest") is False
        and mtl.count("rv-mt-done rv-mt-rtab") == 2 and "rv-mt-cur rv-mt-rtab" not in mtl and dl.get("bu_locked") is True
        and "disabled" not in mtl, (Rl.get("unit"), mtl))
s.check("...the pill carries Round 2 locked", {c["key"]: c for c in dl["companies"]}[UA]["round"]["state"] == "locked")
sysl, opl = sysprompt(BOSS, UA)
s.check("...the agent is told it is locked and replaces round 1; the first line says it", "LOCKED on" in sysl and "replaces round 1" in opl)
dl1, _ = hist(BOSSC, UA, rtab="1")
s.check("round 1 after the lock is still the record (not the round 2 result): the moved person is back where they stood",
        people(dl1)[P[UA][0]][0] == "ME" and people(dl)[P[UA][0]][0] == "AE")

# ======================================================================================================================
s.section("put everything back")
a._pm_calib_fit_moves = real_fit
a.ai_draft.review_agent_available = _real_avail


def restore(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZR3-%'")]
    ph = ",".join("?" * len(ids))
    for tb in ("leader_releases", "result_releases", "talent_releases", "rating_records", "tb_insights", "talent_status_history",
               "talent_box_remarks"):
        try:
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (tb, ph), ids)
        except Exception:   # noqa: BLE001 -- a table this database lacks
            db.rollback()
    db.execute("DELETE FROM tb_round1_marks WHERE round_id IN (SELECT id FROM tb_rounds WHERE business_group IN (?,?))", (BG, BG2))
    db.execute("DELETE FROM tb_rounds WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM talent_box_bu_locks WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM pm_pat_lock_flags WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM pm_pbt_achievement WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM leader_role_access WHERE role='bg' AND ability='bg.fit'")
    db.execute("DELETE FROM late_passes WHERE user_id IN (%s)" % ph, ids)
    for tb, mx in _ORIG["max"].items():
        db.execute("DELETE FROM %s WHERE id>?" % tb, (mx,))
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZR3-%'")
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='tb_bgceo'", (CID,))
    for w_ in _ORIG["windows"]:
        db.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w_), ",".join("?" * len(w_))), list(w_.values()))
    db.execute("UPDATE cycles SET half=? WHERE id=?", (_ORIG["half"], CID))
    for k_, v in _ORIG["settings"].items():
        if v is None:
            db.execute("DELETE FROM app_settings WHERE key=?", (k_,))
        else:
            db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)", (k_, v))
    for k_, v in _ORIG["modules"].items():
        db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, CID, k_))
    db.commit()


ctx(restore)
s.check("nothing of this suite is left (no ZZR3 person, round, lock or business unit)",
        one("SELECT COUNT(*) FROM users WHERE employee_id LIKE 'ZZR3-%'") == 0
        and one("SELECT COUNT(*) FROM tb_rounds WHERE business_group IN (?,?)", (BG, BG2)) == 0
        and one("SELECT COUNT(*) FROM org_units WHERE business_group IN (?,?)", (BG, BG2)) == 0)
sys.exit(s.done())
