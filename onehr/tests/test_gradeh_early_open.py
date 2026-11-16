"""Grade H Appraisal: the EARLY OPENING of the HOD's review and the BU CEO's sign-off (Chris, 2026-11-02).

The rule, per HOD and per unit (never per person):
  * HOD: a stage (potential, performance) is open for an HOD when the date is inside the part's calendar cell AND (every Grade H person
    whose HOD stage is theirs has acknowledged: on their own, in person or deemed, OR the HOD fallback date has come).
  * BU CEO: the sign-off for a unit is open when the date is inside the gradeh_buceo cell AND (every Grade H person in the unit has finished
    the HOD stage: both stages signed off by their HOD, or no HOD stage (no HOD, their own unit's BU CEO, or a calibrator) OR the BU
    fallback date has come).
  * A blank fallback is no early opening: the cell alone decides (everything as before). Closing stays the cell's end.
  * A person whose line manager never submitted has nothing to acknowledge: their HOD waits for the fallback. Private-company rows and
    leavers never count.
What this suite holds: both readers (the gates and the words), every falsifying case, one batched read (the query count does not grow with
the people), the reminder reads them, the pages say it in one line, the Settings card saves / refuses (super admin only, double-confirmed),
and the KB rows are reworded once.
Synthetic (ZZ9EO-*) on a fresh scratch database; the suite puts back what it changes.
"""
import os
import re
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Grade H Appraisal: early opening for HODs and BU CEOs")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, EMP = H.actors(a)
PFX, BG, CO, COB = "ZZ9EO-", "ZZEO Group", "ZZEO Unit A", "ZZEO Unit B"
U, P = {}, {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
BASE = "/calibration/gradeh"
import sqlite3  # noqa: E402

db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
FMT = "%Y-%m-%d %H:%M"
UTCF = "%Y-%m-%d %H:%M:%S"


def one(sql, args=()):
    r = db.execute(sql, args).fetchone()
    return r[0] if r else None


def run(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        r = fn(d)
        d.commit()
        return r


def text(resp):
    h = resp.get_data(as_text=True)
    h = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", h)
    m = re.search(r'<main id="main"[\s\S]*', h)
    h = m.group(0) if m else h
    h = re.sub(r"<[^>]+>", " ", h)
    return " ".join(h.replace("&#39;", "'").replace("&amp;", "&").replace("&quot;", '"').split())


def csrf(**kw):
    d = {"csrf_token": "tok"}
    d.update(kw)
    return d


def mk(k, grade="H", hod=None, co=CO, dept="ZZEO Dept"):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, job_title, hod_id, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?,?,?, 'Driver', ?, '2020-01-01')",
        ((PFX + k).lower(), "ZZ EO " + k, PFX + k, BG, co, dept, grade, hod)).lastrowid


def person(k, submitted=True, ack=None):
    """A Grade H person. ack: None | 'self' | 'person' | 'deemed' (the recorded ways of having acknowledged)."""
    pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route) VALUES (?,?,?,'B')", (CID, PFX + k, U[k])).lastrowid
    P[k] = pid
    db.execute(
        "INSERT INTO gradeh_appraisals (cycle_id, person_id, lm_submitted_at, perf_band, pot_band, perf_rating, pot_score, "
        "b_achievements, b_strengths, b_development, conversation_held, acknowledged_at, ack_in_person, deemed_at) "
        "VALUES (?,?,?,?,?,3.2,9.0,'a','s','d',1,?,?,?)",
        (CID, pid, (NOW - timedelta(days=3)).strftime(UTCF) if submitted else None, "ME" if submitted else None,
         "Mid" if submitted else None, NOW_UTC if ack == "self" else None, 1 if ack == "person" else 0, NOW_UTC if ack == "deemed" else None))
    return pid


def set_ack(k, ack):
    db.execute("UPDATE gradeh_appraisals SET acknowledged_at=?, ack_in_person=?, deemed_at=? WHERE person_id=?",
               (NOW_UTC if ack == "self" else None, 1 if ack == "person" else 0, NOW_UTC if ack == "deemed" else None, P[k]))
    db.commit()


def urow(k):
    return db.execute("SELECT * FROM users WHERE id=?", (U[k],)).fetchone()


def setting(name, value):
    run(lambda d: a.gradeh_set_setting(d, name, value, None))


def clear_settings():
    run(lambda d: d.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'"))


def utc(dt_myt):
    return (dt_myt - timedelta(hours=8)).strftime(UTCF) if dt_myt else ""


def fallback(hod=None, bu=None):
    """Set (a MYT datetime) or clear (None) the two fallbacks."""
    setting("gradeh_hod_fallback_at", utc(hod))
    setting("gradeh_bu_fallback_at", utc(bu))


def cells(hod=None, bu=None, perf=None):
    """The calendar: hod / bu = (opens, closes) MYT datetimes, or None for undated; perf = the HOD performance cell's own dates (default: hod's)."""
    def _w(d):
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell LIKE 'gradeh_%'", (CID,))
        for cell, w in (("gradeh_hod_pot", hod), ("gradeh_hod_perf", perf or hod), ("gradeh_buceo", bu)):
            if w:
                d.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                          (CID, cell, w[0].strftime(FMT), w[1].strftime(FMT)))
    run(_w)


def hod_open(k, stage="pot", now=None):
    return run(lambda d: a.gradeh_hod_open_for(d, CID, U[k], stage, now))


def hod_gate(k, stage="pot", now=None):
    return run(lambda d: a.gradeh_hod_gate(d, CID, U[k], stage, now))


def bu_open(co=CO, bg=BG, now=None):
    return run(lambda d: a.gradeh_bu_open_for(d, CID, co, bg, now))


def bu_gate(co=CO, bg=BG, now=None):
    return run(lambda d: a.gradeh_bu_gate(d, CID, bg, co, now))


def hsign_row(k, stages=("pot", "perf")):
    for stg in stages:
        db.execute("INSERT INTO gradeh_signoffs(cycle_id, tier, stage, scope_key, signed_by) VALUES (?,?,?,?,?)",
                   (CID, "hod", stg, str(U[k]), U[k]))
    db.commit()


def unsign(k):
    db.execute("DELETE FROM gradeh_signoffs WHERE cycle_id=? AND tier='hod' AND scope_key=?", (CID, str(U[k])))
    db.commit()


if True:
    CID = run(lambda d: a.active_cycle_id(d))
    HALF0 = db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()["half"]
    OBD0 = one("SELECT open_by_date FROM cycles WHERE id=?", (CID,))
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
    db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
    for c_ in (CO, COB):
        db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, c_))
    NOW = a._now_myt()
    NOW_UTC = utc(NOW)
    # seats
    U["BCA"] = mk("BCA", "21", dept="ZZEO Division")                       # unit A's BU CEO (not on the list)
    U["CAL"] = mk("CAL", "22", dept="ZZEO Division")                       # a calibrator (a BG CEO seat): holds no HOD role
    db.execute("UPDATE users SET bgceo_bg=? WHERE id=?", (BG, U["CAL"]))
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, U["BCA"]))
    U["BCB"] = mk("BCB", "21", co=COB, dept="ZZEO Division")               # unit B's BU CEO
    db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, COB, U["BCB"]))
    for k_ in ("HOD1", "HOD2", "HOD3", "HOD4"):
        U[k_] = mk(k_, "19", hod=U["BCA"], dept="ZZEO " + k_)
    U["HODB"] = mk("HODB", "19", hod=U["BCB"], co=COB, dept="ZZEO Dept B")
    # HOD1: S1 self, S2 in person, S3 deemed, S4 submitted but NOT acknowledged; a private-company row and a leaver, both unacknowledged
    for k_, ack in (("S1", "self"), ("S2", "person"), ("S3", "deemed"), ("S4", None)):
        U[k_] = mk(k_, hod=U["HOD1"], dept="ZZEO HOD1")
        person(k_, ack=ack)
    U["PRV"] = mk("PRV", hod=U["HOD1"], dept="ZZEO HOD1")
    person("PRV")
    db.execute("UPDATE gradeh_people SET private_company=1 WHERE id=?", (P["PRV"],))
    U["LFT"] = mk("LFT", hod=U["HOD1"], dept="ZZEO HOD1")
    person("LFT")
    db.execute("UPDATE users SET left_at=datetime('now') WHERE id=?", (U["LFT"],))
    # HOD2: two people, both acknowledged
    for k_, ack in (("T1", "self"), ("T2", "person")):
        U[k_] = mk(k_, hod=U["HOD2"], dept="ZZEO HOD2")
        person(k_, ack=ack)
    # HOD3: one person whose line manager never submitted (nothing to acknowledge)
    U["V1"] = mk("V1", hod=U["HOD3"], dept="ZZEO HOD3")
    person("V1", submitted=False)
    # HOD4: one person, submitted, not acknowledged (so unit A's BU CEO has an HOD who never signs)
    U["W1"] = mk("W1", hod=U["HOD4"], dept="ZZEO HOD4")
    person("W1")
    # no HOD stage: no HOD at all; the calibrator's person; the BU CEO's own direct report (their HOD is the unit's BU CEO)
    U["N1"] = mk("N1", dept="ZZEO None")
    person("N1")
    U["C1"] = mk("C1", hod=U["CAL"], dept="ZZEO Cal")
    person("C1")
    U["D1"] = mk("D1", hod=U["BCA"], dept="ZZEO BCA")
    person("D1")
    # unit B: HODB with two people, one acknowledged
    U["B1"] = mk("B1", hod=U["HODB"], co=COB, dept="ZZEO Dept B")
    person("B1", ack="self")
    U["B2"] = mk("B2", hod=U["HODB"], co=COB, dept="ZZEO Dept B")
    person("B2")
    # a private-company person whose HOD never signs, in unit A (must never hold the unit back)
    U["HODX"] = mk("HODX", "19", hod=U["BCA"], dept="ZZEO HODX")
    U["X1"] = mk("X1", hod=U["HODX"], dept="ZZEO HODX")
    person("X1")
    db.execute("UPDATE gradeh_people SET private_company=1 WHERE id=?", (P["X1"],))
    U["X2"] = mk("X2", hod=U["HODX"], dept="ZZEO HODX")
    person("X2")
    db.execute("UPDATE users SET left_at=datetime('now') WHERE id=?", (U["X2"],))
    # the journey gives an HOD a Dept view only with someone in the NORMAL review: a JG 15 report with a KPI under each HOD
    PID_ = run(lambda d: a.active_pm_period(d)["id"])
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','calibration','pm','tm')")
    for k_ in ("ai_calib", "review_unified"):
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,'1')", (k_,))
    db.commit()
    clear_settings()

C = {k: H.client_as(a, U[k]) for k in U}
CSU = H.client_as(a, SU["id"])
CBG = H.client_as(a, BGA["id"]) if BGA else None
_real_avail = a.ai_draft.review_agent_available
a.ai_draft.review_agent_available = lambda: True

DAY = timedelta(days=1)
INSIDE = (NOW - DAY, NOW + 10 * DAY)        # the date is inside the cell
BEFORE = (NOW + 2 * DAY, NOW + 12 * DAY)    # the cell has not opened
AFTER = (NOW - 12 * DAY, NOW - 2 * DAY)     # the cell has closed
FUTURE = NOW + 5 * DAY
PAST = NOW - timedelta(hours=1)


def agree(label, k=None, stage="pot", unit=None, now=None):
    """The reader that says 'open' agrees with the gate that lets a write through, for the HOD or for the unit."""
    if unit:
        return bu_open(unit, now=now)["open"] == (bu_gate(unit, now=now) is None)
    return hod_open(k, stage, now)["open"] == (hod_gate(k, stage, now) is None)


try:
    cells(INSIDE, INSIDE)
    fallback(None, None)

    # ======================================================================================================================
    s.section("the HOD: blank fallback means the cell alone decides (everything as before)")
    r = hod_open("HOD1")
    s.check("inside the cell, no fallback set: open, though HOD1's people have not all acknowledged", r["open"] and r["inside"] and r["fallback_at"] is None, r)
    s.check("...and the gate lets the write through (None)", hod_gate("HOD1") is None and hod_gate("HOD1", "perf") is None)
    cells(BEFORE, BEFORE)
    s.check("a cell not yet open stays closed with no fallback (even HOD2, who has everyone acknowledged)",
            not hod_open("HOD2")["open"] and "opens on" in (hod_gate("HOD2") or ""), hod_gate("HOD2"))
    cells(AFTER, AFTER)
    s.check("a closed cell stays closed with no fallback", not hod_open("HOD2")["open"] and "closed on" in (hod_gate("HOD2") or ""), hod_gate("HOD2"))
    cells(INSIDE, INSIDE)

    # ======================================================================================================================
    s.section("the HOD: inside the cell, before the fallback")
    fallback(hod=FUTURE)
    r = hod_open("HOD1")
    s.check("HOD1: S1 (own sign-in), S2 (in person), S3 (deemed) acknowledged, S4 not: closed, 3 of 4 (the private-company row and the leaver are not counted)",
            not r["open"] and r["done"] == 3 and r["total"] == 4 and r["inside"], r)
    g = hod_gate("HOD1")
    s.check("...the gate says so in one line, with the fallback date and the count", g and g.startswith("Opens on %d %s" % (FUTURE.day, FUTURE.strftime("%b")))
            and "sooner once all your Grade H people have acknowledged" in g and "3 of 4 so far" in g, g)
    s.check("...the performance stage reads the same (its own cell, the same rule)", not hod_open("HOD1", "perf")["open"] and hod_gate("HOD1", "perf") == g)
    s.check("HOD2, everyone acknowledged (own sign-in, in person): open, 2 of 2", hod_open("HOD2")["open"] and hod_open("HOD2")["done"] == 2
            and hod_open("HOD2")["total"] == 2 and hod_gate("HOD2") is None)
    s.check("per HOD, never per person: HOD2 being open does not open HOD1", not hod_open("HOD1")["open"] and hod_open("HOD2")["open"])
    s.check("HOD3, whose person's line manager never submitted: nothing to acknowledge, so they wait: closed, 0 of 1",
            not hod_open("HOD3")["open"] and hod_open("HOD3")["done"] == 0 and hod_open("HOD3")["total"] == 1, hod_open("HOD3"))
    s.check("HOD4 (one person submitted, not acknowledged): closed, 0 of 1", not hod_open("HOD4")["open"] and hod_open("HOD4")["total"] == 1)
    s.check("the reader agrees with the gate for every HOD, both stages", all(agree("x", k_, st_) for k_ in ("HOD1", "HOD2", "HOD3", "HOD4") for st_ in ("pot", "perf")))
    # an acknowledgement opens it at once; take it back and it shuts again
    set_ack("S4", "self")
    s.check("S4 acknowledges: HOD1 opens (4 of 4)", hod_open("HOD1")["open"] and hod_open("HOD1")["done"] == 4 and hod_gate("HOD1") is None, hod_open("HOD1"))
    set_ack("S4", "person")
    s.check("...an in-person acknowledgement counts too", hod_open("HOD1")["open"])
    set_ack("S4", "deemed")
    s.check("...a recorded deemed acknowledgement counts too", hod_open("HOD1")["open"])
    set_ack("S4", None)
    s.check("...and un-acknowledged it is closed again (the guard is real)", not hod_open("HOD1")["open"])

    # ======================================================================================================================
    s.section("the HOD: the fallback date, and the cell still decides")
    fallback(hod=PAST)
    s.check("the fallback has passed: HOD1 (3 of 4) is open", hod_open("HOD1")["open"] and hod_gate("HOD1") is None, hod_open("HOD1"))
    s.check("...and HOD3 (nothing to acknowledge) opens on the fallback", hod_open("HOD3")["open"] and hod_gate("HOD3") is None)
    s.check("the fallback is read against the clock given: a moment before it, closed; at it, open",
            not hod_open("HOD1", now=PAST - timedelta(minutes=1))["open"] and hod_open("HOD1", now=PAST)["open"])
    cells(BEFORE, BEFORE)
    s.check("the fallback has passed but the cell has not opened: closed (the fallback never opens a part before its cell)",
            not hod_open("HOD1")["open"] and not hod_open("HOD2")["open"] and "opens on" in (hod_gate("HOD2") or ""), hod_gate("HOD2"))
    cells(AFTER, AFTER)
    s.check("the cell has closed: closed, though everyone acknowledged and the fallback passed",
            not hod_open("HOD2")["open"] and "closed on" in (hod_gate("HOD2") or ""), hod_gate("HOD2"))
    cells(INSIDE, INSIDE)
    cells(INSIDE, INSIDE, perf=BEFORE)
    s.check("each stage follows its own cell: potential's is open for HOD1, performance's has not opened",
            hod_open("HOD1", "pot")["open"] and not hod_open("HOD1", "perf")["open"] and hod_gate("HOD1", "pot") is None
            and "opens on" in (hod_gate("HOD1", "perf") or ""), (hod_gate("HOD1", "pot"), hod_gate("HOD1", "perf")))
    cells(INSIDE, INSIDE)
    fallback(None, None)

    # ======================================================================================================================
    s.section("the HOD: deemed by the deadline counts even before the deemed step has marked it")
    fallback(hod=FUTURE)
    setting("gradeh_deemed_on", 1)
    setting("gradeh_deemed_mode", "fixed")
    setting("gradeh_deemed_at", utc(NOW - timedelta(hours=2)))
    s.check("deemed deadline passed for S4 (submitted, not acknowledged, nothing recorded): counted, so HOD1 is open (4 of 4)",
            hod_open("HOD1")["open"] and hod_open("HOD1")["done"] == 4, hod_open("HOD1"))
    s.check("...HOD3's person was never submitted: still nothing to acknowledge, so HOD3 stays closed", not hod_open("HOD3")["open"])
    setting("gradeh_deemed_at", utc(NOW + 2 * DAY))
    s.check("deemed deadline still ahead: S4 does not count", not hod_open("HOD1")["open"] and hod_open("HOD1")["done"] == 3)
    setting("gradeh_deemed_mode", "days")
    setting("gradeh_deemed_days", 1)    # submitted 3 days ago: 1 day after submission has passed
    s.check("'N days after submit' mode: counted when submitted + N days has passed", hod_open("HOD1")["open"] and hod_open("HOD1")["done"] == 4)
    setting("gradeh_deemed_days", 7)
    s.check("...and not while it is still ahead", not hod_open("HOD1")["open"])
    setting("gradeh_deemed_on", 0)
    setting("gradeh_deemed_mode", "fixed")
    setting("gradeh_deemed_at", utc(NOW - timedelta(hours=2)))
    s.check("deemed switched OFF: no deadline, so S4 does not count (the switch holds here too)", not hod_open("HOD1")["open"] and hod_open("HOD1")["done"] == 3)
    s.check("the deemed rule read once agrees with gradeh_deemed_deadline, per mode",
            run(lambda d: a.gradeh_deemed_deadline(d, CID, "2026-11-01 00:00:00")) is None and run(lambda d: a.gradeh_deemed_rule(CID)("2026-11-01 00:00:00")) is None)
    setting("gradeh_deemed_on", 1)
    s.check("...fixed: the fixed time, none for a person not submitted",
            run(lambda d: a.gradeh_deemed_deadline(d, CID, "2026-11-01 00:00:00")) == utc(NOW - timedelta(hours=2))
            and run(lambda d: a.gradeh_deemed_deadline(d, CID, None)) is None and run(lambda d: a.gradeh_deemed_rule(CID)(None)) is None)
    setting("gradeh_deemed_mode", "days")
    setting("gradeh_deemed_days", 3)
    s.check("...days: submission + N days", run(lambda d: a.gradeh_deemed_deadline(d, CID, "2026-11-01 08:30:00")) == "2026-11-04 08:30:00"
            and run(lambda d: a.gradeh_deemed_rule(CID)("2026-11-01 08:30:00")) == "2026-11-04 08:30:00")
    clear_settings()

    # ======================================================================================================================
    s.section("the BU CEO: blank fallback means the cell alone decides")
    s.check("inside the cell, no fallback: open although no HOD has signed off", bu_open()["open"] and bu_gate() is None, bu_open())
    cells(INSIDE, BEFORE)
    s.check("the cell not yet open: closed", not bu_open()["open"] and "opens on" in (bu_gate() or ""), bu_gate())
    cells(INSIDE, AFTER)
    s.check("the cell closed: closed", not bu_open()["open"] and "closed on" in (bu_gate() or ""), bu_gate())
    cells(INSIDE, INSIDE)

    # ======================================================================================================================
    s.section("the BU CEO: inside the cell, before the fallback")
    fallback(bu=FUTURE)
    r = bu_open()
    # unit A's people (not private, not left): S1-S4 (HOD1), T1-T2 (HOD2), V1 (HOD3), W1 (HOD4), N1 (no HOD), C1 (calibrator's), D1 (the BU CEO's own report)
    s.check("no HOD has signed off: closed; only the three with no HOD stage count as done, of the 11 people (the private-company row and the leaver are not in it)",
            not r["open"] and r["done"] == 3 and r["total"] == 11 and r["inside"], r)
    g = bu_gate()
    s.check("...the gate says so in one line: the fallback, the cell's first day, the unit and the count",
            g and g.startswith("Opens on %d %s" % (FUTURE.day, FUTURE.strftime("%b"))) and ", or from %d %s" % (INSIDE[0].day, INSIDE[0].strftime("%b")) in g
            and " once every HOD in " in g and "Unit A" in g and g.endswith("has signed off: 3 of 11 people done."), g)
    hsign_row("HOD1", ("pot",))
    s.check("an HOD with only potential signed has not finished: HOD1's four stay not done", bu_open()["done"] == 3 and not bu_open()["open"], bu_open())
    hsign_row("HOD1", ("perf",))
    s.check("both stages signed: HOD1's four are done (7 of 11)", bu_open()["done"] == 7 and not bu_open()["open"], bu_open())
    hsign_row("HOD2")
    hsign_row("HOD3")
    s.check("HOD2 and HOD3 sign off (the person nobody submitted for is done once their HOD has signed): 10 of 11, closed", bu_open()["done"] == 10 and not bu_open()["open"], bu_open())
    s.check("the reader agrees with the gate", agree("x", unit=CO))
    hsign_row("HOD4")
    r = bu_open()
    s.check("every HOD signed off: open, 11 of 11, and the gate lets the write through", r["open"] and r["done"] == 11 and r["total"] == 11 and bu_gate() is None, r)
    unsign("HOD4")
    s.check("take one HOD's sign-off away: closed again (the guard is real)", not bu_open()["open"] and bu_open()["done"] == 10)
    hsign_row("HOD4")
    s.check("per unit: unit B (HODB has not signed) is closed while unit A is open",
            not bu_open(COB)["open"] and bu_open(COB)["done"] == 0 and bu_open(COB)["total"] == 2 and bu_open(CO)["open"], (bu_open(COB), bu_open(CO)))
    s.check("...the private-company person and the leaver whose HOD (HODX) never signed never held unit A back (still open above)", bu_open()["open"])
    s.check("a unit the BU CEO leaves business_group out of reads the same", bu_open(CO, None)["done"] == bu_open()["done"])
    for k_ in ("HOD1", "HOD2", "HOD3", "HOD4"):
        unsign(k_)
    fallback(bu=PAST)
    s.check("the fallback has passed: open with no HOD signed off", bu_open()["open"] and bu_gate() is None and bu_open()["done"] == 3, bu_open())
    cells(INSIDE, BEFORE)
    s.check("...but not before the cell opens", not bu_open()["open"])
    cells(INSIDE, AFTER)
    s.check("...nor after it closes (even with every HOD signed off)", not bu_open()["open"] and "closed on" in (bu_gate() or ""))
    cells(INSIDE, INSIDE)
    fallback(None, None)

    # ======================================================================================================================
    s.section("the writes obey the gates")
    n0 = one("SELECT COUNT(*) FROM gradeh_band_moves")
    fallback(hod=FUTURE, bu=FUTURE)
    ok, msg = run(lambda d: a.gradeh_hod_move(d, urow("HOD1"), P["S1"], "pot", "High", "A fair reason."))
    s.check("an HOD not yet open: the move is refused with the words, nothing saved", not ok and "so far" in msg and one("SELECT COUNT(*) FROM gradeh_band_moves") == n0, msg)
    ok, msg = run(lambda d: a.gradeh_hod_agree(d, urow("HOD1"), "pot", [P["S1"]], {P["S1"]}))
    s.check("...the ticks too", not ok and "so far" in msg)
    ok, msg = run(lambda d: a.gradeh_hod_signoff(d, urow("HOD1"), "pot", None))
    s.check("...and the sign-off", not ok and "so far" in msg and one("SELECT COUNT(*) FROM gradeh_signoffs") == 0, msg)
    ok, msg = run(lambda d: a.gradeh_hod_move(d, urow("HOD2"), P["T1"], "pot", "High", "A fair reason."))
    s.check("an HOD who is open (HOD2, everyone acknowledged) moves a person", ok and one("SELECT COUNT(*) FROM gradeh_band_moves") == n0 + 1, msg)
    db.execute("DELETE FROM gradeh_band_moves WHERE person_id=?", (P["T1"],))
    db.commit()
    ok, msg = run(lambda d: a.gradeh_buceo_move(d, urow("BCA"), P["N1"], "AE", None, "A fair reason."))
    s.check("a BU CEO not yet open: the move is refused with the words, nothing saved", not ok and "people done" in msg and one("SELECT COUNT(*) FROM gradeh_band_moves") == n0, msg)
    ok, msg = run(lambda d: a.gradeh_buceo_signoff(d, urow("BCA"), CO, None))
    s.check("...and the sign-off", not ok and "people done" in msg and one("SELECT COUNT(*) FROM gradeh_signoffs") == 0, msg)
    for k_ in ("HOD1", "HOD2", "HOD3", "HOD4"):
        hsign_row(k_)
    ok, msg = run(lambda d: a.gradeh_buceo_move(d, urow("BCA"), P["N1"], "AE", None, "A fair reason."))
    s.check("every HOD signed off: the BU CEO's move goes through", ok and one("SELECT COUNT(*) FROM gradeh_band_moves") == n0 + 1, msg)
    db.execute("DELETE FROM gradeh_band_moves WHERE person_id=?", (P["N1"],))
    for k_ in ("HOD1", "HOD2", "HOD3", "HOD4"):
        unsign(k_)
    db.commit()
    # a blank fallback: nothing changes from before
    fallback(None, None)
    ok, msg = run(lambda d: a.gradeh_hod_move(d, urow("HOD1"), P["S1"], "pot", "High", "A fair reason."))
    s.check("blank fallbacks: HOD1 (not everyone acknowledged) moves a person as before", ok, msg)
    ok2, msg2 = run(lambda d: a.gradeh_buceo_move(d, urow("BCA"), P["N1"], "AE", None, "A fair reason."))
    s.check("...and the BU CEO (no HOD signed) moves as before", ok2, msg2)
    db.execute("DELETE FROM gradeh_band_moves WHERE person_id IN (?,?)", (P["S1"], P["N1"]))
    db.commit()

    # ======================================================================================================================
    s.section("one batched read: the query count does not grow with the people")

    def count_queries(fn):
        n = [0]
        with a.app.test_request_context("/"):
            d = a.get_db()
            d.set_trace_callback(lambda sql: n.__setitem__(0, n[0] + 1) if sql.lstrip().upper().startswith("SELECT") else None)
            fn(d)
            d.set_trace_callback(None)
        return n[0]
    fallback(hod=FUTURE, bu=FUTURE)
    h0 = count_queries(lambda d: a.gradeh_hod_open_for(d, CID, U["HOD1"], "pot"))
    b0 = count_queries(lambda d: a.gradeh_bu_open_for(d, CID, CO, BG))
    for i in range(40):   # forty more people, half acknowledged, spread over more HODs
        U["M%d" % i] = mk("M%d" % i, hod=U["HOD1"] if i % 2 else U["HOD2"], dept="ZZEO bulk")
        person("M%d" % i, ack="self" if i % 2 else None)
    db.commit()
    h1 = count_queries(lambda d: a.gradeh_hod_open_for(d, CID, U["HOD1"], "pot"))
    b1 = count_queries(lambda d: a.gradeh_bu_open_for(d, CID, CO, BG))
    s.check("the HOD's reader runs the same number of reads for 4 people and for 24 (%d, %d)" % (h0, h1), h0 == h1 and h0 < 24, (h0, h1))
    s.check("the BU CEO's reader runs the same number of reads for 11 people and for 51 (%d, %d)" % (b0, b1), b0 == b1 and b0 < 40, (b0, b1))
    s.check("...and the counts reflect the new people", hod_open("HOD1")["total"] == 24 and bu_open()["total"] == 51, (hod_open("HOD1"), bu_open()))
    for i in range(40):
        db.execute("DELETE FROM gradeh_appraisals WHERE person_id=?", (P["M%d" % i],))
        db.execute("DELETE FROM gradeh_people WHERE id=?", (P["M%d" % i],))
        db.execute("DELETE FROM users WHERE id=?", (U["M%d" % i],))
    db.commit()
    fallback(None, None)

    # ======================================================================================================================
    s.section("the readers say the same thing: the reminder, the pages")
    fallback(hod=FUTURE, bu=FUTURE)

    def lead(k):
        return run(lambda d: a._gradeh_lead_rows(d, urow(k), CID))

    s.check("the reminder lists no Grade H review for an HOD whose part is not open for them (HOD1)", not any(r_[0] == "gradeh_hod" for r_ in lead("HOD1")), lead("HOD1"))
    s.check("...but lists it for one whose part is open (HOD2)", any(r_[0] == "gradeh_hod" for r_ in lead("HOD2")), lead("HOD2"))
    s.check("...and no sign-off line for a BU CEO whose unit is not open for them", not any(r_[0] == "gradeh_buceo" for r_ in lead("BCA")), lead("BCA"))
    for k_ in ("HOD1", "HOD2", "HOD3", "HOD4"):
        hsign_row(k_, ("pot",))
    s.check("...(potential alone signed: still no sign-off line)", not any(r_[0] == "gradeh_buceo" for r_ in lead("BCA")))
    for k_ in ("HOD1", "HOD2", "HOD3", "HOD4"):
        hsign_row(k_, ("perf",))
    s.check("...and the line once every HOD has signed off", any(r_[0] == "gradeh_buceo" for r_ in lead("BCA")), lead("BCA"))
    for k_ in ("HOD1", "HOD2", "HOD3", "HOD4"):
        unsign(k_)
    s.check("a blank fallback lists them all as before", (fallback(None, None) or True) and any(r_[0] == "gradeh_hod" for r_ in lead("HOD1"))
            and any(r_[0] == "gradeh_buceo" for r_ in lead("BCA")))
    fallback(hod=FUTURE, bu=FUTURE)
    t = text(C["HOD1"].get(BASE + "/hod"))
    s.check("the HOD's page says it in one line: opens on, or sooner once all your Grade H people have acknowledged, 3 of 4", "Opens on" in t and
            "sooner once all your Grade H people have acknowledged: 3 of 4 so far." in t, t[:400])
    s.check("...the page's agree boxes are disabled while it is not open", re.search(r'name="agree"[^>]*disabled', C["HOD1"].get(BASE + "/hod").get_data(as_text=True)))
    t = text(C["HOD2"].get(BASE + "/hod"))
    s.check("an HOD whose part is open sees no such line", "Opens on" not in t and "so far" not in t, t[:300])
    h = C["BCA"].get(BASE + "/unit").get_data(as_text=True)
    t = text(C["BCA"].get(BASE + "/unit"))
    s.check("the BU CEO's page says it in one line, with the unit and the count", "once every HOD in" in t and "has signed off: 3 of 11 people done." in t and "Opens on" in t, t[:500])
    s.check("...and its Sign off button is disabled with the same words", re.search(r'<button type="submit" class="ghc-btn" disabled title="Opens on', h))
    p_t = text(C["BCA"].get("%s/unit?p=%d" % (BASE, P["N1"])))
    s.check("...a person's page says the call can't be made yet, with the words", "You can't change this person's bands now: opens on" in p_t, p_t[-300:])
    for k_ in ("HOD1", "HOD2", "HOD3", "HOD4"):
        hsign_row(k_)
    h = C["BCA"].get(BASE + "/unit").get_data(as_text=True)
    t = text(C["BCA"].get(BASE + "/unit"))
    s.check("every HOD signed off: no such line, and Sign off is enabled", "once every HOD in" not in t and not re.search(r'class="ghc-btn" disabled title="Opens', h), t[:300])
    for k_ in ("HOD1", "HOD2", "HOD3", "HOD4"):
        unsign(k_)
    fallback(None, None)
    t = text(C["HOD1"].get(BASE + "/hod")) + text(C["BCA"].get(BASE + "/unit"))
    s.check("blank fallbacks: neither page says anything about opening", "Opens on" not in t and "so far" not in t and "people done" not in t)

    # ======================================================================================================================
    s.section("Settings: two dates, super admin only, double-confirmed, checked against the part's dates")
    SET = "/admin/gradeh/settings"
    inside_d = (NOW + 3 * DAY)
    cells((NOW + 10 * DAY, NOW + 19 * DAY), (NOW + 17 * DAY, NOW + 21 * DAY))
    hod_ok = (NOW + 15 * DAY).replace(hour=0, minute=0, second=0, microsecond=0)
    bu_ok = (NOW + 19 * DAY).replace(hour=19, minute=30, second=0, microsecond=0)
    page = CSU.get("/admin/gradeh?tab=settings")
    ph = page.get_data(as_text=True)
    s.check("the Settings tab has the card, with each part's dates and a double-confirmed save form", page.status_code == 200
            and "Early opening for HODs and BU CEOs" in ph and 'name="hod_date"' in ph and 'name="bu_date"' in ph
            and re.search(r'<form method="post" action="/admin/gradeh/settings" class="gh-early-form" data-confirm="[^"]+" data-confirm-ok="Save dates">', ph)
            and "part dates %s)" % a._rw_span((NOW + 10 * DAY).date(), (NOW + 19 * DAY).date()) in text(page)
            and "part dates %s)" % a._rw_span((NOW + 17 * DAY).date(), (NOW + 21 * DAY).date()) in text(page), text(page)[:200])
    r = CSU.post(SET, data=csrf(action="early", hod_date=hod_ok.strftime("%Y-%m-%d"), hod_time="00:00", bu_date=bu_ok.strftime("%Y-%m-%d"), bu_time="19:30"),
                 follow_redirects=True)
    saved = lambda n: run(lambda d: a.gradeh_setting(n, CID))   # noqa: E731
    s.check("inside both parts' dates: saved, stored as UTC (MYT minus 8 hours), says so in MYT", saved("gradeh_hod_fallback_at") == utc(hod_ok)
            and saved("gradeh_bu_fallback_at") == utc(bu_ok) and "Saved." in text(r) and "MYT" in text(r), (saved("gradeh_hod_fallback_at"), text(r)[:200]))
    s.check("...audited", one("SELECT COUNT(*) FROM activity_log WHERE action='gradeh_settings' AND detail LIKE 'Early-opening fallback dates:%'") == 1)
    pt = text(CSU.get("/admin/gradeh?tab=settings"))
    s.check("...and the card shows what is saved", 'value="%s"' % hod_ok.strftime("%Y-%m-%d") in CSU.get("/admin/gradeh?tab=settings").get_data(as_text=True)
            and 'value="19:30"' in CSU.get("/admin/gradeh?tab=settings").get_data(as_text=True), pt[:100])
    keep = (saved("gradeh_hod_fallback_at"), saved("gradeh_bu_fallback_at"))
    r = CSU.post(SET, data=csrf(action="early", hod_date=(NOW + 25 * DAY).strftime("%Y-%m-%d"), hod_time="00:00", bu_date=bu_ok.strftime("%Y-%m-%d"), bu_time="10:00"),
                 follow_redirects=True)
    s.check("an HOD date outside its part's dates is refused with the dates, and NOTHING is saved (not even the valid BU date)",
            "must be inside the part's dates" in text(r) and (saved("gradeh_hod_fallback_at"), saved("gradeh_bu_fallback_at")) == keep, text(r)[:200])
    r = CSU.post(SET, data=csrf(action="early", hod_date=hod_ok.strftime("%Y-%m-%d"), hod_time="00:00", bu_date=(NOW + 1 * DAY).strftime("%Y-%m-%d"), bu_time="10:00"),
                 follow_redirects=True)
    s.check("a BU CEO date before its part opens is refused, nothing saved", "must be inside the part's dates" in text(r)
            and (saved("gradeh_hod_fallback_at"), saved("gradeh_bu_fallback_at")) == keep, text(r)[:200])
    for bad in ({"hod_date": "19/11/2026", "hod_time": "00:00"}, {"hod_date": "2026-11-19", "hod_time": "25:00"}, {"hod_date": "", "hod_time": "10:00"}):
        r = CSU.post(SET, data=csrf(action="early", bu_date="", bu_time="", **bad), follow_redirects=True)
        s.check("a bad date or time (%s) is refused, nothing saved" % bad, "Pick the date and the time of the HOD fallback" in text(r)
                and (saved("gradeh_hod_fallback_at"), saved("gradeh_bu_fallback_at")) == keep, text(r)[:200])
    r = CSU.post(SET, data=csrf(action="early", hod_date=hod_ok.strftime("%Y-%m-%d"), hod_time="", bu_date="", bu_time=""), follow_redirects=True)
    s.check("a blank time means 00:00; both BU boxes blank clears the BU date (no early opening)", saved("gradeh_hod_fallback_at") == utc(hod_ok)
            and saved("gradeh_bu_fallback_at") == "" and "BU CEO: none" in text(r), text(r)[:200])
    r = CSU.post(SET, data=csrf(action="early", hod_date="", hod_time="", bu_date="", bu_time=""), follow_redirects=True)
    s.check("both rows blank clears both", saved("gradeh_hod_fallback_at") == "" and saved("gradeh_bu_fallback_at") == "")
    cells(None, None)
    r = CSU.post(SET, data=csrf(action="early", hod_date=hod_ok.strftime("%Y-%m-%d"), hod_time="09:00", bu_date="", bu_time=""), follow_redirects=True)
    s.check("a part with no dates on the calendar: saved, and the answer says it was not checked", saved("gradeh_hod_fallback_at") == utc(hod_ok + timedelta(hours=9))
            and "has no dates on the calendar yet" in text(r), text(r)[:300])
    r = CSU.post(SET, data={"action": "early", "hod_date": "2026-11-19", "hod_time": "00:00"})
    s.check("no CSRF token: refused (400), nothing changes", r.status_code == 400 and saved("gradeh_hod_fallback_at") == utc(hod_ok + timedelta(hours=9)))
    before = saved("gradeh_hod_fallback_at")
    if CBG:
        r = CBG.post(SET, data=csrf(action="early", hod_date=hod_ok.strftime("%Y-%m-%d"), hod_time="01:00"))
        s.check("a BG admin cannot save it (403), nothing changes", r.status_code == 403 and saved("gradeh_hod_fallback_at") == before, r.status_code)
    r = H.client_as(a, U["HOD1"]).post(SET, data=csrf(action="early", hod_date=hod_ok.strftime("%Y-%m-%d"), hod_time="01:00"))
    s.check("an HOD cannot save it, nothing changes", r.status_code != 200 and saved("gradeh_hod_fallback_at") == before, r.status_code)
    s.check("the route is classified 'super' in the access map", a.admin_access_need("admin_gradeh_settings", {}) == "super")
    s.check("the writer itself refuses a non-super account", not run(lambda d: a.gradeh_save_early(d, dict(urow("HOD1")), CID, {"hod_date": "2026-11-19"}))[0]
            and saved("gradeh_hod_fallback_at") == before)
    clear_settings()

    # ======================================================================================================================
    s.section("what the agents and the first sign-in know: the KB rows are reworded once, an admin's edit is never overwritten")
    cells(INSIDE, INSIDE)
    s.check("the new rows say when the part opens, the old rows are kept to match",
            "fallback date" in a._KB_GRADEH_HOD_BODY and "fallback date" in a._KB_GRADEH_BUCEO_BODY
            and a._KB_GRADEH_HOD_BODY != a._KB_GRADEH_HOD_BODY_BEFORE_EARLY and a._KB_GRADEH_BUCEO_BODY != a._KB_GRADEH_BUCEO_BODY_BEFORE_EARLY
            and "fallback" not in a._KB_GRADEH_HOD_BODY_BEFORE_EARLY and "fallback" not in a._KB_GRADEH_BUCEO_BODY_BEFORE_EARLY)
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-hod'", (a._KB_GRADEH_HOD_BODY_BEFORE_EARLY,))
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-bu-ceo'", (a._KB_GRADEH_BUCEO_BODY_BEFORE_EARLY + " An admin's addition.",))
    db.commit()
    a._ensure_runtime_schema()
    s.check("a database seeded before: the HOD row holding the exact old text is reworded once", one("SELECT body FROM kb_entries WHERE slug='gradeh-hod'") == a._KB_GRADEH_HOD_BODY)
    s.check("...an admin's edited BU CEO row is left alone", one("SELECT body FROM kb_entries WHERE slug='gradeh-bu-ceo'") == a._KB_GRADEH_BUCEO_BODY_BEFORE_EARLY + " An admin's addition.")
    db.execute("UPDATE kb_entries SET body=? WHERE slug='gradeh-bu-ceo'", (a._KB_GRADEH_BUCEO_BODY_BEFORE_EARLY,))
    db.commit()
    a._ensure_runtime_schema()
    a._ensure_runtime_schema()
    s.check("...the BU CEO row at the exact old text is reworded too, and a second run changes nothing",
            one("SELECT body FROM kb_entries WHERE slug='gradeh-bu-ceo'") == a._KB_GRADEH_BUCEO_BODY
            and one("SELECT body FROM kb_entries WHERE slug='gradeh-hod'") == a._KB_GRADEH_HOD_BODY)
    s.check("Help's answers (the BU CEO's, the HOD's) and the agent's prompt say it too",
            "fallback date" in a.HELP_QA["gh_bu_signoff"][1] and "fallback date" in a.HELP_QA["gh_hod_nolm"][1]
            and "fallback date" in a._journey_gradeh_prompt(frozenset({"hod"})) and "fallback date" in a._journey_gradeh_prompt(frozenset({"buceo"})))
    def _facts(k):
        with a.app.test_request_context("/"):
            d = a.get_db()
            u = dict(urow(k))
            u = a.get_user_by_id(d, u["id"]) if hasattr(a, "get_user_by_id") else urow(k)
            return " ".join(a._ask_facts(d, u, a._dash_context(d, u))[0])
    fh, fb_ = _facts("HOD1"), _facts("BCA")
    s.check("Ask OneHR's facts for an HOD and for a BU CEO say when the part opens",
            "Grade H calibration" in fh and "opens once all your Grade H people have acknowledged" in fh
            and "Grade H calibration" in fb_ and "sign-off opens once its HODs have signed off" in fb_, (fh[-300:], fb_[-300:]))

finally:
    a.ai_draft.review_agent_available = _real_avail
    os.environ["ONEHR_GRADEH"] = _ENV0 if _ENV0 is not None else ""
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    with a.app.test_request_context("/"):
        d = a.get_db()
        d.execute("UPDATE cycles SET half=?, open_by_date=? WHERE id=?", (HALF0, OBD0, CID))
        d.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell LIKE 'gradeh_%'", (CID,))
        d.execute("DELETE FROM leader_role_access WHERE ability LIKE '%.gradeh'")
        d.commit()

sys.exit(s.done())
