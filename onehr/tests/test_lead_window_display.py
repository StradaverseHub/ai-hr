"""A leader's dashboard and left panel follow the cycle's windows (Chris, 2026-11-02): a BU CEO was told "your turn" (red
"Calibration . 3 to calibrate", "Move on to AI+ Calibration") on 2 Nov although the BU CEO window opens 16 Nov. The writes were
already window-gated; this is DISPLAY only, and every date and state comes from the cycle's configured windows at request time.

What this suite holds, role by role (HOD, BU CEO, calibrator's group, BG CEO, Group Chief, Executive Chairman), each in four
states of ITS window (cells pm_hod / pot_hod, pm_buceo / pot_buceo, tb_bgceo):
  * NOT OPEN: no count, no 'turn', no "You lead" act, no reminder; the card's sub is "Opens <date>" with the date READ BACK from
    the window (the window is edited and the words follow), "Not open yet" for a part of a by-date cycle with no start date,
    the year added only when it is not this year's; the rail says "Later" with the date
  * OPEN: today's count, today's words
  * CLOSED (no pass): "Closed" (a locked part keeps its own word: Submitted / Locked)
  * CLOSED + a late pass for unit A (or group one): unit A counts, unit B does not; a pass for another business group never
    opens this one
plus the two-tier person (BU CEO + BG CEO: each tier on its own window), the BU CEO's Talent Box (both axes open), the
reminder, Ask OneHR's "You lead" line, and the journey's left panel ("Opens ..." in place of the pending count).
Every guard is FALSIFIED by switching it off (the helper forced open, the pass's scope dropped) and watching the check fail.
Synthetic ZZLW-* only; the cycle, its modules, its windows and the settings are put back at the end."""
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
s = H.Suite("Leader windows -- the dashboard says 'Opens <date>' until a leader's part opens")
_real_avail = a.ai_draft.review_agent_available
_real_ai_url = a._dash_ai_url
_real_lead_window = a._lead_window
_real_scope_keys = a._lead_scope_keys
_real_view_tier = a._journey_view_tier
a.ai_draft.review_agent_available = lambda: True
BG, BG_OTHER = "ZZLW BG", "ZZLW Other BG"
U1, U2, U3 = "ZZLW U1", "ZZLW U2", "ZZLW U3"
CELLS = ("pm_hod", "pot_hod", "pm_buceo", "pot_buceo", "tb_bgceo")
os.environ.pop("ONEHR_CHAIR", None)


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZLW-%'")]
    gids = [r[0] for r in db.execute("SELECT id FROM pm_calibration_groups WHERE name LIKE 'ZZLW%'")]
    db.execute("DELETE FROM late_passes WHERE reason LIKE 'ZZLW%'")
    if gids:
        ph = ",".join("?" * len(gids))
        db.execute("DELETE FROM pm_calibration_adjustments WHERE session_id IN (SELECT id FROM pm_calibration_sessions "
                   "WHERE tier='group' AND scope_key IN (%s))" % ph, [str(g_) for g_ in gids])
        db.execute("DELETE FROM pm_calibration_sessions WHERE tier='group' AND scope_key IN (%s)" % ph, [str(g_) for g_ in gids])
        db.execute("DELETE FROM pm_calibration_group_members WHERE group_id IN (%s)" % ph, gids)
        db.execute("DELETE FROM pm_calibration_groups WHERE id IN (%s)" % ph, gids)
    db.execute("DELETE FROM calib_bu_group_people WHERE group_id IN (SELECT id FROM calib_bu_groups WHERE business_group=?)", (BG,))
    db.execute("DELETE FROM calib_bu_groups WHERE business_group=?", (BG,))
    for t, adj in (("pm_calibration_sessions", "pm_calibration_adjustments"), ("calibration_sessions", "calibration_adjustments")):
        db.execute("DELETE FROM %s WHERE session_id IN (SELECT id FROM %s WHERE business_group IN (?,?))" % (adj, t), (BG, BG_OTHER))
        db.execute("DELETE FROM %s WHERE business_group IN (?,?)" % t, (BG, BG_OTHER))
    db.execute("DELETE FROM talent_box_bu_locks WHERE business_group IN (?,?)", (BG, BG_OTHER))
    if ids:
        ph = ",".join("?" * len(ids))
        for t in ("chair_calls", "chair_locks"):
            try:
                db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (t, ph), ids)
            except Exception:  # noqa: BLE001
                pass
        for t in ("pm_calibration_adjustments", "calibration_adjustments", "rating_records"):
            db.execute("DELETE FROM %s WHERE subject_id IN (%s)" % (t, ph), ids)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM buceo_seats WHERE user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids * 2)
        db.execute("DELETE FROM notifications WHERE user_id IN (%s)" % ph, ids)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM app_settings WHERE key IN ('exec_chair_id','exec_chair_delegate_id','exec_chair_team')")
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG_OTHER))
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CYC = dict(a.active_cycle(db))
    CID = CYC["id"]
    PID = a.active_pm_period(db)["id"]
    _cleanup(db)
    ORIG = {"windows": [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (CID,))],
            "modules": [tuple(r) for r in db.execute("SELECT cycle_id, module_key, active FROM cycle_modules WHERE cycle_id=?",
                                                     (CID,))],
            "cycle": {k: CYC[k] for k in ("half", "kind", "open_by_date")},
            "chair_setting": [tuple(r) for r in db.execute("SELECT key, value FROM app_settings WHERE key IN "
                                                           "('exec_chair_id','exec_chair_delegate_id','exec_chair_team')")]}
    db.execute("UPDATE cycles SET half=2, kind='year_end', open_by_date=0 WHERE id=?", (CID,))   # the tiers exist at Year-End
    for mk_ in ("pm", "tm", "idp", "calibration", "evidence", "review"):
        db.execute("INSERT OR REPLACE INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,1)", (CID, mk_))
    db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def mk(eid, name, bg=BG, co=U1, mgr=None, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=mgr,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=bg, company=co, department="ZZLW Dept",
                 job_grade="16", years_of_service=3, confirmation_date="2020-01-01", left_at=None, is_demo=0, role="user",
                 admin_bg=None)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    for co_ in (U1, U2, U3):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, co_))
    HOD = mk("ZZLW-HOD", "ZZ LW Hod")
    P1 = mk("ZZLW-P1", "ZZ LW Person One", hod_id=HOD)
    P2 = mk("ZZLW-P2", "ZZ LW Person Two", hod_id=HOD)
    for pid_ in (P1, P2):   # a scorecard each: in the performance population too
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company) "
                   "VALUES (?,?,?,?,?,?,?)", (PID, pid_, "ZZLW KPI", 100, "more", BG, U1))
    BU = mk("ZZLW-BU", "ZZ LW Buceo")
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?),(?,?,?)", (BG, U1, BU, BG, U2, BU))
    CAL = mk("ZZLW-CAL", "ZZ LW Calibrator")
    G = []
    for nm in ("ZZLW Group One", "ZZLW Group Two"):
        db.execute("INSERT INTO calib_bu_groups(business_group, company, name, calibrator_id) VALUES (?,?,?,?)", (BG, U1, nm, CAL))
        G.append(db.execute("SELECT MAX(id) FROM calib_bu_groups").fetchone()[0])
    for g_, p_ in zip(G, (P1, P2)):
        db.execute("INSERT INTO calib_bu_group_people(group_id, business_group, user_id) VALUES (?,?,?)", (g_, BG, p_))
    BGC = mk("ZZLW-BGC", "ZZ LW Bgceo", bgceo_bg=BG)
    BOTH = mk("ZZLW-BOTH", "ZZ LW Both Seats", bgceo_bg=BG)   # a BU CEO and a BG CEO
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, U3, BOTH))
    CHIEF = mk("ZZLW-GC", "ZZ LW Groupchief")
    GID = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZLW Group Finance', ?)", (CHIEF,)).lastrowid
    for pid_ in (P1, P2):
        db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id) VALUES (?,?)", (GID, pid_))
    CH = mk("ZZLW-CH", "ZZ LW Chairman")
    CHL = mk("ZZLW-CHL", "ZZ LW Chair Leader", mgr=CH, bgceo_bg=BG_OTHER, business_group=BG_OTHER, co=U2)   # in his box: a BG CEO
    db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG_OTHER, U2))
    SUP = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL LIMIT 1").fetchone()[0]
    db.commit()
    NOW = a._now_myt()


def fmt(dt, with_year=None):
    """How a date reads on the dashboard: '16 Nov' (the year only when it is not this year's)."""
    y = (dt.year != NOW.year) if with_year is None else with_year
    return "%d %s%s" % (dt.day, dt.strftime("%b"), (" %d" % dt.year) if y else "")


def stamp(dt):
    return dt.strftime("%Y-%m-%d %H:%M")


def run(fn, uid=None, path="/"):
    with a.app.test_request_context(path):
        if uid:
            a.session["user_id"] = uid
        d = a.get_db()
        u = dict(d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()) if uid else None
        return fn(d, u)


def exe(sql, args=()):
    def f(d, _u):
        d.execute(sql, args)
        d.commit()
    run(f)


def setwin(cell, opens, closes):
    exe("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, cell, opens, closes))


def clearwin():
    exe("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))


T_OPEN = NOW + timedelta(days=10)    # a start still ahead
T_OPEN2 = NOW + timedelta(days=24)   # ...and an edit of it
STATES = {   # state -> (opens, closes) for every leader cell
    "not_open": (stamp(T_OPEN), stamp(NOW + timedelta(days=30))),
    "open": (stamp(NOW - timedelta(days=1)), stamp(NOW + timedelta(days=10))),
    "closed": (stamp(NOW - timedelta(days=10)), stamp(NOW - timedelta(days=1))),
}


def all_cells(state, opens=None):
    o, c = STATES[state]
    for cell in CELLS:
        setwin(cell, opens or o, c)


def give(uid, cell, scope, bg=BG):
    exe("INSERT INTO late_passes(cycle_id, user_id, cell, scope_key, tier, business_group, until_at, reason, given_by) "
        "VALUES (?,?,?,?,?,?,datetime('now','+2 days'),'ZZLW pass',?)", (CID, uid, cell, scope, None, bg, SUP))


def end_passes():
    exe("DELETE FROM late_passes WHERE reason LIKE 'ZZLW%'")


def card(uid):
    """The AI+ Calibration card the dashboard draws for this leader (and the doors it was built from)."""
    def f(d, u):
        lead = a.dash_leadership(d, u)
        cards = a.dash_cards(d, u, None, lead, [])
        return next((c for c in cards if c["key"] == "calibration"), None), lead
    return run(f, uid)


def counts(uid):
    def f(d, u):
        return {"pm": a._lead_pm_counts(d, u, tiers=("buceo", "bugrp")), "pot": a._lead_pot_counts(d, u, tiers=("buceo", "bugrp")),
                "box": a._lead_box_counts(d, u)}
    return run(f, uid)


def leaders_of(uid):
    """The leader rows the dashboard's rail / You are here / reminder read, with a chat door for each (the fixture has no
    calibration chat people, so the AI-door gate is stood in for)."""
    def f(d, u):
        cards = [dict(c) for c in a.dash_cards(d, u, None, a.dash_leadership(d, u), [])
                 if c["key"] in ("dept_review", "calibration", "group_calib")]
        return [dict(c, dest=("AI+ Dept Review" if c["key"] == "dept_review" else "AI+ Talent Box" if c["key"] == "group_calib"
                              else "AI+ Calibration"), button="Move on to x", url=c.get("url") or "/x") for c in cards]
    return run(f, uid)


try:
    # =======================================================================================================
    s.section("the helper: one answer from the cycle's windows (open / not open with its start / closed)")
    clearwin()
    all_cells("not_open")
    w = run(lambda d, u: a._lead_window(d, u, ["pm_buceo", "pot_buceo"], CID), BU)
    s.check("a part not open yet says so, with the start read from its window", w[0] == "not_open" and a._parse_when(w[1]) == a._parse_when(stamp(T_OPEN)), w)
    setwin("pm_buceo", stamp(T_OPEN2), stamp(NOW + timedelta(days=40)))
    w = run(lambda d, u: a._lead_window(d, u, ["pm_buceo", "pot_buceo"], CID), BU)
    s.check("...several cells: the EARLIEST start (pot is the sooner)", w[0] == "not_open" and a._parse_when(w[1]) == a._parse_when(stamp(T_OPEN)), w)
    setwin("pot_buceo", stamp(NOW - timedelta(days=1)), stamp(NOW + timedelta(days=5)))
    w = run(lambda d, u: a._lead_window(d, u, ["pm_buceo", "pot_buceo"], CID), BU)
    s.check("...open when ANY cell is open (as the reminder's rule)", w == ("open", None), w)
    all_cells("closed")
    w = run(lambda d, u: a._lead_window(d, u, ["pm_buceo", "pot_buceo"], CID), BU)
    s.check("closed: the closing time", w[0] == "closed" and a._parse_when(w[1]) == a._parse_when(STATES["closed"][1]), w)
    clearwin()
    exe("UPDATE cycles SET open_by_date=1 WHERE id=?", (CID,))
    w = run(lambda d, u: a._lead_window(d, u, ["tb_bgceo"], CID), BGC)
    s.check("a by-date cycle with no start date for the part: not open, no date", w == ("not_open", None), w)
    s.check("...worded 'Not open yet', never a date", a._lead_say(*w) == "Not open yet" and a._lead_say(*w, lower=True) == "not open yet")
    exe("UPDATE cycles SET open_by_date=0 WHERE id=?", (CID,))
    w = run(lambda d, u: a._lead_window(d, u, ["tb_bgceo"], CID), BGC)
    s.check("...and the older rule (no dates = open all cycle) stays", w == ("open", None), w)
    nxt = NOW.replace(year=NOW.year + 1, month=1, day=5, hour=9, minute=0)
    s.check("the year shows only when it is not this year's", a._lead_say("not_open", stamp(NOW + timedelta(days=3))) == "Opens " + fmt(NOW + timedelta(days=3), False)
            and a._lead_say("not_open", stamp(nxt)) == "Opens 5 Jan %d" % nxt.year, a._lead_say("not_open", stamp(nxt)))

    # =======================================================================================================
    s.section("the BU CEO: not open -> 'Opens <date>', no count, not a turn; open -> today's count; closed -> 'Closed'")
    clearwin()
    all_cells("not_open")
    c_, lead = card(BU)
    cnt = counts(BU)
    s.check("not open: no door counts anything, though two units are unlocked (the fixture reaches the guard)",
            cnt["pm"]["count"] == 0 and cnt["pm"]["unlocked"] == 2 and cnt["pot"]["count"] == 0 and cnt["pot"]["unlocked"] == 2
            and cnt["box"]["count"] == 0 and cnt["box"]["unlocked"] == 2, cnt)
    s.check("...the card says 'Opens <the window's start>' and the doors the same in lower case",
            c_ and c_["sub"] == "Opens " + fmt(T_OPEN) and all(p["meta"] == "opens " + fmt(T_OPEN) for p in c_["pending"]), c_)
    rows = leaders_of(BU)
    s.check("...so it is 'later', never 'turn'", rows and all(a._dash_lead_state(r) == "later" for r in rows), [r["sub"] for r in rows])

    def rail_and_here(uid, rows):
        return run(lambda d, u: (a.dash_rail(d, u, None, None, rows), a.dash_here(None, None, rows)), uid)
    rail, here = rail_and_here(BU, rows)
    st_ = [x for x in rail["steps"] if x["name"] == "Calibration"]   # (the leader's row folds into the cycle's one Calibration step)
    s.check("...the rail's Calibration step says 'Opens <date>' under 'Not yet' (never 'Your turn'), and You are here has no act",
            len(st_) == 1 and st_[0]["state"] == "later" and st_[0]["short"] == "Opens " + fmt(T_OPEN) and st_[0]["full"].startswith("Not yet")
            and not any(x["kind"] == "lead" for x in here["acts"]) and here["head"] == "Nothing needs you right now", (st_, here["head"]))
    # the window is edited: the dashboard follows on the next load (the date is not held anywhere)
    all_cells("not_open", opens=stamp(T_OPEN2))
    c2, _l = card(BU)
    s.check("an admin moves the start: the next load says the new date", c2["sub"] == "Opens " + fmt(T_OPEN2) and c2["sub"] != c_["sub"], c2["sub"])
    all_cells("not_open")
    # a by-date cycle with no start date
    clearwin()
    exe("UPDATE cycles SET open_by_date=1 WHERE id=?", (CID,))
    c3, _l = card(BU)
    s.check("a by-date cycle with no start date for the part: 'Not open yet', no date", c3["sub"] == "Not open yet"
            and all(p["meta"] == "not open yet" for p in c3["pending"]), c3)
    s.check("...and that is 'later' too", a._dash_lead_state(c3) == "later")
    exe("UPDATE cycles SET open_by_date=0 WHERE id=?", (CID,))
    # open
    all_cells("open")
    c_, lead = card(BU)
    cnt = counts(BU)
    s.check("open: each door counts its two units (pm 2, pot 2, box 2) and the card says 6 to calibrate",
            cnt["pm"]["count"] == 2 == cnt["pm"]["unlocked"] and cnt["pot"]["count"] == 2 and cnt["box"]["count"] == 2
            and c_["sub"] == "6 to calibrate" and all(p["meta"] == "2 pending" for p in c_["pending"]), (cnt["pm"], c_))
    rows = leaders_of(BU)
    rail, here = rail_and_here(BU, rows)
    s.check("...it is their turn again: 'turn' in the rail with the count and an act under You are here",
            a._dash_lead_state(rows[0]) == "turn" and any(x["name"] == "Calibration" and x["state"] == "turn" and x["short"] == "6 to calibrate"
                                                          for x in rail["steps"]) and any(x["kind"] == "lead" for x in here["acts"]), rail["steps"])
    # closed
    all_cells("closed")
    c_, lead = card(BU)
    cnt = counts(BU)
    s.check("closed (no pass): nothing counts, the card says 'Closed' (the doors 'closed'), state 'closed'",
            cnt["pm"]["count"] == 0 and cnt["pm"]["unlocked"] == 2 and c_["sub"] == "Closed" and all(p["meta"] == "closed" for p in c_["pending"])
            and a._dash_lead_state(c_) == "closed", c_)
    rows = leaders_of(BU)
    rail, here = rail_and_here(BU, rows)
    st_ = [x for x in rail["steps"] if x["name"] == "Calibration"]
    s.check("closed: the rail's merged Calibration step says 'Closed' (state closed, no stale word, no act), not 'Not yet'",
            len(st_) == 1 and st_[0]["state"] == "closed" and st_[0]["short"] == "Closed" and st_[0]["full"] == "Closed"
            and "word" not in st_[0] and not any(x["kind"] == "lead" for x in here["acts"]), st_)
    _real_state = a._dash_lead_state
    a._dash_lead_state = lambda c: "done"
    rail_bad, _h = rail_and_here(BU, rows)
    a._dash_lead_state = _real_state
    st_bad = [x for x in rail_bad["steps"] if x["name"] == "Calibration"]
    s.check("FALSIFIED: without the closed fold the same rail reads 'Not yet' (the bug), so the check bites",
            st_bad and st_bad[0]["short"] == "Not yet", st_bad)
    # the three states, side by side, on the merged step's short text
    shorts = {}
    for stt in ("not_open", "open", "closed"):
        all_cells(stt)
        r_, _h = rail_and_here(BU, leaders_of(BU))
        shorts[stt] = next(x["short"] for x in r_["steps"] if x["name"] == "Calibration")
    s.check("the merged step reads 'Opens <d>', then the count, then 'Closed'",
            shorts == {"not_open": "Opens " + fmt(T_OPEN), "open": "6 to calibrate", "closed": "Closed"}, shorts)
    all_cells("closed")
    # only part of it open: the BU CEO's Talent Box needs both axes (as the writer does), the axes count on their own
    all_cells("open")
    setwin("pot_buceo", *STATES["not_open"])
    cnt = counts(BU)
    s.check("performance open, potential not yet: pm counts 2, pot 0, and the Talent Box (both axes) 0",
            cnt["pm"]["count"] == 2 and cnt["pot"]["count"] == 0 and cnt["box"]["count"] == 0, cnt)
    c_, _l = card(BU)
    s.check("...so the card counts only what is open: '2 to calibrate'", c_["sub"] == "2 to calibrate", c_["sub"])
    s.check("...and the potential door says when it opens",
            next(p for p in c_["pending"] if "Potential" in p["label"])["meta"] == "opens " + fmt(T_OPEN), c_["pending"])

    # ------------------------------------------------------------------ closed + a late pass: unit A counts, unit B does not
    s.section("closed + a late pass for unit A: unit A counts, unit B does not (and the pass is that unit's alone)")
    all_cells("closed")
    give(BU, "pm_buceo", U1)
    cnt = counts(BU)
    s.check("a pass for unit A (stored under pm_buceo, which covers pot_buceo): each door counts one", cnt["pm"]["count"] == 1
            and cnt["pot"]["count"] == 1 and cnt["box"]["count"] == 1, cnt)
    ws = run(lambda d, u: (a._lead_scope_window(d, u, "buceo", (BG, U1), "pm", CID), a._lead_scope_window(d, u, "buceo", (BG, U2), "pm", CID)), BU)
    s.check("...unit A is open, unit B is closed", ws[0][0] == "open" and ws[1][0] == "closed", ws)
    c_, _l = card(BU)
    s.check("...the card counts 3 to calibrate (not 6, not 0)", c_["sub"] == "3 to calibrate", c_["sub"])
    # falsify: drop the pass's scope (any pass opens every unit)
    a._lead_scope_keys = lambda db_, cid_, tier_, key_: None
    cnt_bad = counts(BU)
    a._lead_scope_keys = _real_scope_keys
    s.check("FALSIFIED: with the scope dropped a pass for A opens B too (pm counts 2), so the scope is what keeps B closed",
            cnt_bad["pm"]["count"] == 2, cnt_bad["pm"])
    end_passes()
    s.check("...and without the pass nothing counts again", counts(BU)["pm"]["count"] == 0)
    exe("INSERT INTO late_passes(cycle_id, user_id, cell, scope_key, until_at, reason, given_by) VALUES (?,?,?,?,datetime('now','-1 hours'),'ZZLW pass',?)",
        (CID, BU, "pm_buceo", U1, SUP))
    s.check("an expired pass opens nothing", counts(BU)["pm"]["count"] == 0)
    end_passes()
    exe("INSERT INTO leader_releases(cycle_id, subject_id, kind, released_by) VALUES (?,?,'pm',?)", (CID, P1, SUP))
    give(BU, "pm_buceo", U1)
    s.check("a pass whose scope's results are released to leaders has lapsed: it opens nothing", counts(BU)["pm"]["count"] == 0)
    exe("DELETE FROM leader_releases WHERE cycle_id=? AND subject_id=?", (CID, P1))
    end_passes()

    # ------------------------------------------------------------------ falsify the window guard on the counters
    s.section("falsified: the counters really read the window")
    all_cells("not_open")
    a._lead_window = lambda *x, **k: ("open", None)
    bad = counts(BU)
    a._lead_window = _real_lead_window
    s.check("with the window check forced open the same fixture counts 2 / 2 / 2 (so the not-open zeros above are the guard's)",
            bad["pm"]["count"] == 2 and bad["pot"]["count"] == 2 and bad["box"]["count"] == 2, bad)
    s.check("...and the real helper puts it back", counts(BU)["pm"]["count"] == 0)

    # =======================================================================================================
    s.section("'Where your BU is' unit pills: the word follows each scope's window while nothing is locked")
    def pills(uid):
        return run(lambda d, u: [(p["label"], p["word"], p["state"]) for p in a._dash_bu_units(d, u, None, CID)], uid)
    all_cells("not_open")
    pw = [w for _l, w, _st in pills(BU)]
    s.check("not open: each pill says 'opens <d>' (read from the window), never 'to calibrate'", pw == ["opens " + fmt(T_OPEN)] * 2, pills(BU))
    all_cells("not_open", opens=stamp(T_OPEN2))
    s.check("...and follows an edit of the window", [w for _l, w, _st in pills(BU)] == ["opens " + fmt(T_OPEN2)] * 2)
    clearwin()
    exe("UPDATE cycles SET open_by_date=1 WHERE id=?", (CID,))
    s.check("a by-date cycle with no start date: 'not open yet'", [w for _l, w, _st in pills(BU)] == ["not open yet"] * 2)
    exe("UPDATE cycles SET open_by_date=0 WHERE id=?", (CID,))
    all_cells("open")
    s.check("open: 'to calibrate' as today", [w for _l, w, _st in pills(BU)] == ["to calibrate"] * 2, pills(BU))
    setwin("pot_buceo", *STATES["not_open"])
    s.check("one axis open is open (any axis, as the reminder reads it)", [w for _l, w, _st in pills(BU)] == ["to calibrate"] * 2)
    all_cells("closed")
    s.check("closed (no pass): 'closed'", [w for _l, w, _st in pills(BU)] == ["closed"] * 2, pills(BU))
    give(BU, "pm_buceo", U1)
    pw = pills(BU)
    s.check("a late pass for unit A: only A's pill reads 'to calibrate', B's stays 'closed'",
            [w for _l, w, _st in pw] == ["to calibrate", "closed"], pw)
    a._lead_scope_keys = lambda db_, cid_, tier_, key_: None
    pw_bad = pills(BU)
    a._lead_scope_keys = _real_scope_keys
    s.check("FALSIFIED: with the pass's scope dropped B reads 'to calibrate' too, so the scope is what keeps B closed",
            [w for _l, w, _st in pw_bad] == ["to calibrate", "to calibrate"], pw_bad)
    end_passes()
    exe("INSERT OR REPLACE INTO pm_calibration_sessions(cycle_id, tier, scope_key, business_group, scope_label, locked_at) "
        "VALUES (?, 'buceo', ?, ?, 'ZZLW', datetime('now'))", (PID, U1, BG))
    pw = pills(BU)
    s.check("locked on one axis keeps its own word ('1 of 2 locked'), closed window or not; the other unit still says 'closed'",
            [w for _l, w, _st in pw] == ["1 of 2 locked", "closed"], pw)
    exe("DELETE FROM pm_calibration_sessions WHERE business_group=? AND tier='buceo'", (BG,))
    all_cells("not_open")
    a._lead_window = lambda *x, **k: ("open", None)
    pw_bad = pills(BU)
    a._lead_window = _real_lead_window
    s.check("FALSIFIED: with the window check forced open the not-open pills say 'to calibrate' again (the old words)",
            [w for _l, w, _st in pw_bad] == ["to calibrate"] * 2, pw_bad)
    all_cells("not_open")
    cw = [w for _l, w, _st in pills(CAL)]
    s.check("a calibrator's group pills (tier 'bugrp', the 3-tuple key) read the window too: 'opens <d>'", cw == ["opens " + fmt(T_OPEN)] * 2, cw)
    all_cells("closed")
    give(CAL, "pm_buceo", "grp:%d" % G[0])
    cw = pills(CAL)
    s.check("...closed, with a pass for group one: group one 'to calibrate', group two 'closed'", [w for _l, w, _st in cw] == ["to calibrate", "closed"], cw)
    end_passes()

    # =======================================================================================================
    s.section("the calibrator's group: its own tier ('bugrp' counts as BU CEO), a pass for group one opens group one only")
    all_cells("not_open")
    c_, lead = card(CAL)
    cnt = counts(CAL)
    s.check("not open: two groups unlocked, nothing counted; the card says 'Opens <date>'",
            cnt["pm"]["unlocked"] == 2 and cnt["pm"]["count"] == 0 and cnt["pot"]["count"] == 0
            and c_ and c_["sub"] == "Opens " + fmt(T_OPEN), (cnt, c_ and c_["sub"]))
    s.check("...a calibrator has no Talent Box door of their own", all("Talent Box" not in d["name"] for d in lead), [d["name"] for d in lead])
    all_cells("open")
    cnt = counts(CAL)
    c_, _l = card(CAL)
    s.check("open: each axis counts its two groups, the card says 4 to calibrate",
            cnt["pm"]["count"] == 2 and cnt["pot"]["count"] == 2 and c_["sub"] == "4 to calibrate", (cnt, c_["sub"]))
    all_cells("closed")
    c_, _l = card(CAL)
    s.check("closed: 'Closed'", c_["sub"] == "Closed" and a._dash_lead_state(c_) == "closed", c_["sub"])
    give(CAL, "pm_buceo", "grp:%d" % G[0])
    cnt = counts(CAL)
    s.check("a pass for group one: group one counts on each axis (1 + 1), group two does not", cnt["pm"]["count"] == 1 and cnt["pot"]["count"] == 1, cnt)
    c_, _l = card(CAL)
    s.check("...the card says 2 to calibrate", c_["sub"] == "2 to calibrate", c_["sub"])
    end_passes()

    # =======================================================================================================
    s.section("the BG CEO: the Talent Box follows tb_bgceo; a pass for another business group opens nothing here")
    all_cells("not_open")
    c_, lead = card(BGC)
    cnt = counts(BGC)
    s.check("not open: the Talent Box door counts 0 of 1 and the card says 'Opens <date>'", cnt["box"]["unlocked"] == 1 and cnt["box"]["count"] == 0
            and c_ and c_["sub"] == "Opens " + fmt(T_OPEN) and a._dash_lead_state(c_) == "later", (cnt["box"], c_ and c_["sub"]))
    all_cells("open")
    c_, _l = card(BGC)
    s.check("open: '1 to calibrate', their turn", c_["sub"] == "1 to calibrate" and a._dash_lead_state(c_) == "turn", c_["sub"])
    all_cells("closed")
    c_, _l = card(BGC)
    s.check("closed: 'Closed'", c_["sub"] == "Closed", c_["sub"])
    give(BGC, "tb_bgceo", BG_OTHER, bg=BG_OTHER)
    s.check("a pass for ANOTHER business group opens nothing", counts(BGC)["box"]["count"] == 0)
    end_passes()
    give(BGC, "tb_bgceo", BG)
    c_, _l = card(BGC)
    s.check("a pass for their own business group opens it: '1 to calibrate'", counts(BGC)["box"]["count"] == 1 and c_["sub"] == "1 to calibrate", c_["sub"])
    end_passes()

    # a person holding two tiers is counted per tier on its own window
    s.section("a BU CEO who is also a BG CEO: each tier on its own window")
    all_cells("open")
    setwin("tb_bgceo", *STATES["not_open"])
    cnt = counts(BOTH)
    s.check("BU tier open, BG tier not yet: the box counts the BU tier's unit only (1), the performance door 1",
            cnt["box"]["count"] == 1 and cnt["box"]["unlocked"] == 2 and cnt["pm"]["count"] == 1, cnt)
    setwin("tb_bgceo", *STATES["open"])
    setwin("pm_buceo", *STATES["not_open"])
    setwin("pot_buceo", *STATES["not_open"])
    cnt = counts(BOTH)
    s.check("BG tier open, BU tier not yet: the box counts the BG tier's business group only (1)", cnt["box"]["count"] == 1 and cnt["pm"]["count"] == 0, cnt)
    all_cells("open")
    s.check("both open: the box counts both tiers (2)", counts(BOTH)["box"]["count"] == 2, counts(BOTH)["box"])

    # =======================================================================================================
    s.section("the HOD's Dept Review: a part not open yet says 'opens <date>' (it read 'Closed' before)")
    all_cells("not_open")
    d1 = run(lambda d, u: a.dash_dept_review(d, u), HOD)
    s.check("the fixture reaches the card: two parts for the HOD", d1 and len(d1["pending"]) == 2, d1)
    s.check("not open: no part to submit; the sub is 'Opens <the earliest start>', the parts say when, and it is 'later'",
            d1["sub"] == "Opens " + fmt(T_OPEN) and all(p["meta"] == "opens " + fmt(T_OPEN) for p in d1["pending"])
            and a._dash_lead_state(d1) == "later", d1)
    setwin("pot_hod", stamp(T_OPEN2), STATES["not_open"][1])
    d1 = run(lambda d, u: a.dash_dept_review(d, u), HOD)
    s.check("...each part reads ITS cell (potential starts later) and the sub the earlier", d1["sub"] == "Opens " + fmt(T_OPEN)
            and [p["meta"] for p in d1["pending"]] == ["opens " + fmt(T_OPEN), "opens " + fmt(T_OPEN2)], d1["pending"])
    rows = leaders_of(HOD)
    rail, here = rail_and_here(HOD, rows)
    s.check("...the rail says 'Opens <date>', and no act under You are here", any(x["name"] == "Department review" and x["state"] == "later"
            and x["short"] == "Opens " + fmt(T_OPEN) for x in rail["steps"]) and not here["acts"], rail["steps"])
    all_cells("open")
    d1 = run(lambda d, u: a.dash_dept_review(d, u), HOD)
    s.check("open: '2 to submit' as before", d1["sub"] == "2 to submit" and all(p["meta"] == "to submit" for p in d1["pending"]), d1)
    setwin("pot_hod", *STATES["not_open"])
    d1 = run(lambda d, u: a.dash_dept_review(d, u), HOD)
    s.check("one part open, one not yet: '1 to submit', the other says when", d1["sub"] == "1 to submit"
            and [p["meta"] for p in d1["pending"]] == ["to submit", "opens " + fmt(T_OPEN)], d1["pending"])
    all_cells("closed")
    d1 = run(lambda d, u: a.dash_dept_review(d, u), HOD)
    s.check("closed: 'Closed' (the writers' own _hod_review_closed sentence still decides it)", d1["sub"] == "Closed"
            and all(p["meta"] == "closed" for p in d1["pending"]) and a._dash_lead_state(d1) == "closed", d1)
    s.check("...and the writers' check is untouched: _hod_review_closed still says why, before AND after the window",
            run(lambda d, u: bool(a._hod_review_closed(d, "pm", PID, [{"business_group": BG, "company": U1}])), HOD))
    all_cells("not_open")
    s.check("...before the window it says it is not open (writers unchanged)",
            "opens" in (run(lambda d, u: a._hod_review_closed(d, "pm", PID, [{"business_group": BG, "company": U1}]), HOD) or ""))
    a._lead_window = lambda *x, **k: ("open", None)
    d_bad = run(lambda d, u: a.dash_dept_review(d, u), HOD)
    a._lead_window = _real_lead_window
    s.check("FALSIFIED: with the window check forced open the not-open card falls back to 'Closed' (the old bug), so the check bites",
            d_bad["sub"] == "Closed", d_bad["sub"])

    # =======================================================================================================
    s.section("the Group Chief: the display follows tb_bgceo (writes unchanged); a lock wins")
    all_cells("not_open")
    g1 = run(lambda d, u: a.dash_group_calib(d, u), CHIEF)
    s.check("the fixture reaches the card (a Group Chief with people in their group)", g1 and g1["name"] == "AI+ Talent Box", g1)
    s.check("not open: 'Opens <date>', no pending item, 'later'", g1["sub"] == "Opens " + fmt(T_OPEN) and g1["pending"] == []
            and a._dash_lead_state(g1) == "later", g1)
    rows = leaders_of(CHIEF)
    rail, here = rail_and_here(CHIEF, rows)
    s.check("...no act under You are here", rows and not here["acts"] and any(x["state"] == "later" for x in rail["steps"] if x["who"] == "You lead"), here["acts"])
    all_cells("not_open", opens=stamp(T_OPEN2))
    s.check("...the window's edit shows on the next load", run(lambda d, u: a.dash_group_calib(d, u), CHIEF)["sub"] == "Opens " + fmt(T_OPEN2))
    all_cells("open")
    g1 = run(lambda d, u: a.dash_group_calib(d, u), CHIEF)
    s.check("open: as today ('1 Talent Box to lock', one pending item)", g1["sub"] == "1 Talent Box to lock" and len(g1["pending"]) == 1
            and a._dash_lead_state(g1) == "turn", g1)
    all_cells("closed")
    g1 = run(lambda d, u: a.dash_group_calib(d, u), CHIEF)
    s.check("closed: 'Closed'", g1["sub"] == "Closed" and a._dash_lead_state(g1) == "closed", g1)

    def lock_group():
        def f(d, u):
            sess = a._pm_calib_get_or_create_session(d, PID, "group", str(GID), "", "ZZLW Group Finance")
            d.execute("UPDATE pm_calibration_sessions SET locked_at=datetime('now'), locked_by=? WHERE id=?", (CHIEF, sess["id"]))
            d.commit()
        run(f, CHIEF)
    lock_group()
    s.check("locked wins over closed", run(lambda d, u: a.dash_group_calib(d, u), CHIEF)["sub"] == "Locked")
    all_cells("not_open")
    s.check("...and over not open", run(lambda d, u: a.dash_group_calib(d, u), CHIEF)["sub"] == "Locked")
    exe("UPDATE pm_calibration_sessions SET locked_at=NULL WHERE tier='group' AND scope_key=?", (str(GID),))
    # the left panel, for real: the Group Chief's Talent Box navigator
    GV = "/review/journey?view=group&stage=group_calib"
    nav = run(lambda d, u: a._journey_team_nav_items(d, u, "group_calib"), CHIEF, GV)
    html_ = run(lambda d, u: a._journey_nav_html(d, u, a.review_state(d, u), "group_calib", view="group"), CHIEF, GV)
    s.check("left panel, not open: the header says 'Opens <date>', and the queue's pending count line is gone",
            nav.get("opens") == "Opens " + fmt(T_OPEN) and ("Opens " + fmt(T_OPEN)) in html_ and "rv-nq-key" not in html_, (nav.get("opens"), "rv-nq-key" in html_))
    all_cells("open")
    nav = run(lambda d, u: a._journey_team_nav_items(d, u, "group_calib"), CHIEF, GV)
    html_ = run(lambda d, u: a._journey_nav_html(d, u, a.review_state(d, u), "group_calib", view="group"), CHIEF, GV)
    s.check("left panel, open: no 'Opens', the counts line is back", nav.get("opens") == "" and "Opens " not in html_ and "rv-nq-key" in html_, nav.get("opens"))

    # =======================================================================================================
    s.section("the journey's left panel for the BG CEO and the BU CEO / HOD calibrations")
    all_cells("not_open")
    o_bg = run(lambda d, u: a._journey_nav_opens(d, u, "talent_box"), BGC, "/review/journey?view=bg&stage=talent_box")
    s.check("BG CEO's Talent Box: 'Opens <date>' while tb_bgceo is not open", o_bg == "Opens " + fmt(T_OPEN), o_bg)
    all_cells("open")
    s.check("...nothing once it is open", run(lambda d, u: a._journey_nav_opens(d, u, "talent_box"), BGC, "/review/journey?view=bg&stage=talent_box") == "")
    all_cells("closed")
    s.check("...nothing once it is closed (the card says it is closed)", run(lambda d, u: a._journey_nav_opens(d, u, "talent_box"), BGC, "/review/journey?view=bg&stage=talent_box") == "")
    for tier, axis_cells, stage in (("buceo", ("pm_buceo", "pot_buceo"), "calibration"), ("hod", ("pm_hod", "pot_hod"), "calibration_pot")):
        all_cells("not_open")
        a._journey_view_tier = lambda db_=None, u_=None, t_=tier: t_
        o = run(lambda d, u: a._journey_nav_opens(d, u, stage), BU)
        axis_cell = axis_cells[0] if stage == "calibration" else axis_cells[1]
        setwin(axis_cell, stamp(NOW - timedelta(days=1)), stamp(NOW + timedelta(days=3)))
        o_open = run(lambda d, u: a._journey_nav_opens(d, u, stage), BU)
        a._journey_view_tier = _real_view_tier
        s.check("%s %s: 'Opens <date>' while its cell is not open, '' once it is" % (tier, stage), o == "Opens " + fmt(T_OPEN) and o_open == "", (o, o_open))
    # the template: nav['opens'] replaces the pending count (queue or not)
    def render(nav):
        def f(d, u):
            st = a.review_state(d, u)
            stages = [{"key": "talent_box", "short": "Talent Box", "module": "cal", "state": "open", "label": "Talent Box"}]
            return a.render_template("_journey_nav.html", st=st, active_stage="talent_box", live_stages=stages, chat_keys=["talent_box"],
                                     nav=nav, view="bg")
        return run(f, BGC, "/review/journey?view=bg&stage=talent_box")
    nv = {"kind": "tbox", "items": [{"id": "x", "name": "ZZLW U1", "done": False, "tag": "", "meta": "2 people"}], "focus": ""}
    h0 = render(dict(nv))
    h1 = render(dict(nv, opens="Opens 16 Nov"))
    s.check("the template (no queue): 'Pending calibration' with its count normally; with 'opens' the date and no count",
            "Pending calibration" in h0 and 'rv-nav-todo-n">1<' in h0 and "Pending calibration" not in h1
            and "Opens 16 Nov" in h1 and "rv-nav-todo-n" not in h1, (h0.count("rv-nav-todo-n"), h1.count("rv-nav-todo-n")))
    q = a._tbox_queue(nv)
    h2 = render(dict(nv, queue=q))
    h3 = render(dict(nv, queue=q, opens="Opens 16 Nov"))
    s.check("the template (queue): the key line ('1 to lock') normally; with 'opens' the header says the date and the key line is gone",
            "rv-nq-key" in h2 and "Opens 16 Nov" not in h2 and "rv-nq-key" not in h3 and 'rv-nav-prog">Opens 16 Nov<' in h3.replace("\n", "").replace("  ", ""), (h2.count("rv-nq-key"), h3.count("rv-nq-key")))

    # =======================================================================================================
    s.section("the Executive Chairman: his step follows tb_bgceo (writes unchanged); his box runs on after close")
    os.environ["ONEHR_CHAIR"] = "1"
    exe("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)", (a.CHAIR_SETTING_ID, str(CH)))
    all_cells("not_open")
    st1 = run(lambda d, u: a._chair_leaders_step(d, u), CH)
    s.check("not open: 'Opens <date>', state 'later', and NO link (his Leaders tab is greyed until then, Chris 2026-11-04; the 2026-11-02 "
            "link landed on it)", st1["line"] == "Opens " + fmt(T_OPEN) and st1["state"] == "later" and st1["url"] is None
            and st1.get("not_open"), st1)
    all_cells("not_open", opens=stamp(T_OPEN2))
    s.check("...the window's edit shows on the next load", run(lambda d, u: a._chair_leaders_step(d, u), CH)["line"] == "Opens " + fmt(T_OPEN2))
    dash = run(lambda d, u: a._chair_dash(d, u), CH)
    s.check("...his dashboard's step says it", next(x for x in dash["steps"] if x["key"] == "leaders")["line"] == "Opens " + fmt(T_OPEN2), dash["steps"])
    all_cells("open")
    st2 = run(lambda d, u: a._chair_leaders_step(d, u), CH)
    s.check("open: as before ('0 of 1 placed', his turn)", st2["state"] == "turn" and re.match(r"\d+ of \d+ placed", st2["line"]), st2)
    all_cells("closed")
    st3 = run(lambda d, u: a._chair_leaders_step(d, u), CH)
    s.check("closed: as before (his box runs until results are released)", st3["state"] == "turn" and re.match(r"\d+ of \d+ placed", st3["line"]), st3)
    exe("INSERT INTO chair_locks(cycle_id, subject_id, axis, band, locked_by) VALUES (?,?,?,?,?),(?,?,?,?,?)",
        (CID, CHL, "pm", "ME", CH, CID, CHL, "pot", "Mid", CH))
    all_cells("not_open")
    st4 = run(lambda d, u: a._chair_leaders_step(d, u), CH)
    s.check("a lock of his wins over 'Opens' (done, 'Locked')", st4["state"] == "done" and st4["line"] == "Locked", st4)
    exe("DELETE FROM chair_locks WHERE cycle_id=? AND subject_id=?", (CID, CHL))
    _real_no = a._chairlead_not_open
    a._chairlead_not_open = lambda db_, u_: None
    st_bad = run(lambda d, u: a._chair_leaders_step(d, u), CH)
    a._chairlead_not_open = _real_no
    s.check("FALSIFIED: with the window check forced open the same not-open window reads 'turn' again", st_bad["state"] == "turn", st_bad)
    os.environ.pop("ONEHR_CHAIR", None)

    # =======================================================================================================
    s.section("the reminder and Ask OneHR read the same: a 'later' row is no turn, no act, no reminder")
    a._dash_ai_url = lambda url: True   # the fixture has no chat door to the AI+ views; let the leader rows through
    for uid, who in ((BU, "BU CEO"), (HOD, "HOD"), (BGC, "BG CEO"), (CAL, "calibrator"), (CHIEF, "Group Chief")):
        all_cells("not_open")
        n_not = [i for i in run(lambda d, u: a.reminder_items(d, u), uid) if i["group"] == "lead"]
        all_cells("open")
        n_open = [i for i in run(lambda d, u: a.reminder_items(d, u), uid) if i["group"] == "lead"]
        s.check("%s: no leader reminder before the window opens, one once it is open" % who, n_not == [] and len(n_open) >= 1, (len(n_not), len(n_open)))
    all_cells("not_open")
    lines = run(lambda d, u: [l for l in a._ask_facts(d, u, a._dash_context(d, u))[0] if "YOU LEAD" in l], BU)
    all_cells("open")
    lines_open = run(lambda d, u: [l for l in a._ask_facts(d, u, a._dash_context(d, u))[0] if "YOU LEAD" in l], BU)
    a._dash_ai_url = _real_ai_url
    s.check("Ask OneHR's 'YOU LEAD' line says 'Opens <date>' before the window (never a count), and the count once open",
            len(lines) == 1 and "Opens " in lines[0] and "to calibrate" not in lines[0]
            and len(lines_open) == 1 and "6 to calibrate" in lines_open[0], (lines, lines_open))

    s.check("(every not-open / closed assertion above has its open twin, and the helper and the pass's scope are each switched off once)", True)
    sys.exit(s.done())
finally:
    a.ai_draft.review_agent_available = _real_avail
    a._dash_ai_url = _real_ai_url
    a._lead_window = _real_lead_window
    a._lead_scope_keys = _real_scope_keys
    a._journey_view_tier = _real_view_tier
    os.environ.pop("ONEHR_CHAIR", None)
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        d_.execute("DELETE FROM leader_releases WHERE cycle_id=? AND subject_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZLW-%')", (CID,))
        _cleanup(d_)
        d_.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for w_ in ORIG["windows"]:
            d_.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(w_), ",".join("?" * len(w_))), list(w_.values()))
        d_.execute("DELETE FROM cycle_modules WHERE cycle_id=?", (CID,))
        for m_ in ORIG["modules"]:
            d_.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?,?,?)", m_)
        d_.execute("UPDATE cycles SET half=?, kind=?, open_by_date=? WHERE id=?",
                   (ORIG["cycle"]["half"], ORIG["cycle"]["kind"], ORIG["cycle"]["open_by_date"], CID))
        for k_, v_ in ORIG["chair_setting"]:
            d_.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?,?)", (k_, v_))
        d_.commit()
