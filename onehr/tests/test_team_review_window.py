"""A line manager's dashboard follows THEIR dates (Chris, 2026-11-06): the rail showed "Team review . 1 waiting" (red dot) and
You are here offered "Move on to AI+ team review" on 2 Nov although the line manager's dates (pm_approve / tc_approve /
idp_review) open 9 Nov; every write was already refused by window_closed. DISPLAY only; dates come from the cycle's windows.

What this suite holds, on dash_team_card -> dash_rail / dash_here / dash_calm / dash_not_in:
  * the LM cell's start in the FUTURE: the Team review step is 'later' and its short text is "Opens <date>" (read back from the
    window), team['turn'] == 0, team['opens'] set, no team act, no calm row, nobody counted as a turn in the not-in summary
  * the start in the PAST: the step is 'turn' with the count, the acts are back (falsifies the guard)
  * an open_by_date cycle with no start date: "Not open yet"
  * one part open and one not: only the open part counts, and the not-open part's `turn` list stays whole (the reminder reads it)
The team's people come from a stand-in for _journey_team_reports (the real one needs a full KPI / Career Plan fixture); the
windows, the cell mapping and every dashboard reader are real. Synthetic ZZTR-* only; windows and the cycle are put back."""
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
s = H.Suite("Team review -- the dashboard says 'Opens <date>' until the line manager's dates start")
_real = {k: getattr(a, k) for k in ("_review_manages_team", "_review_unified_on", "_journey_team_live_stages",
                                    "_journey_team_reports", "cycle_row_is_early_year")}
CELLS = {"pm_review": "pm_approve", "tm_review": "tc_approve", "plan_review": "idp_review"}
STAGES = [{"key": k, "short": n} for k, n in (("pm_review", "KPI review"), ("tm_review", "Competency review"),
                                              ("plan_review", "Plan review"))]
ROWS = {"pm_review": [("Ann", True), ("Bob", True), ("Cy", False)],      # (name, has an action for the LM)
        "tm_review": [("Dee", True)],
        "plan_review": [("Eve", True), ("Fay", False)]}


def reports(db, u, key):
    return [{"id": hash(n) % 100000, "name": n, "meta": "m", "done": False, "action": "Review" if act else None}
            for n, act in ROWS[key]]


a._review_manages_team = lambda db, u: True
a._review_unified_on = lambda u: True
a._journey_team_live_stages = lambda st, view=None: STAGES
a._journey_team_reports = reports
a.cycle_row_is_early_year = lambda p: False

with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    ORIG = {"windows": [dict(r) for r in db.execute("SELECT * FROM cycle_windows WHERE cycle_id=?", (CID,))],
            "open_by_date": db.execute("SELECT open_by_date FROM cycles WHERE id=?", (CID,)).fetchone()[0]}
    LM = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone())
    NOW = a._now_myt()


def stamp(dt):
    return dt.strftime("%Y-%m-%d %H:%M")


def fmt(dt):
    return "%d %s%s" % (dt.day, dt.strftime("%b"), "" if dt.year == NOW.year else " %d" % dt.year)


def run(fn):
    with a.app.test_request_context("/"):
        d = a.get_db()
        return fn(d, dict(d.execute("SELECT * FROM users WHERE id=?", (LM["id"],)).fetchone()))


def setwins(opens, closes, cells=tuple(CELLS.values())):
    def f(d, _u):
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell IN (%s)" % ",".join("?" * len(CELLS)),
                  (CID,) + tuple(CELLS.values()))
        for c in cells:
            d.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)", (CID, c, opens, closes))
        d.commit()
    run(f)


def everything(d, u):
    team = a.dash_team_card(d, u, {"st": {"period": None}})
    rail = a.dash_rail(d, u, None, team, [])
    here = a.dash_here(None, team, [])
    ni = a.dash_not_in(d, u, {"participant": False}, {"id": CID, "name": "x", "starts_on": "2020-01-01", "created_at": None},
                       team, [], None)
    step = next(x for x in rail["steps"] if x["name"] == "Team review")
    return team, step, here, ni


T_OPEN = NOW + timedelta(days=3)
try:
    s.section("not open yet: 'Opens <date>', grey, not a turn, no act")
    setwins(stamp(T_OPEN), stamp(NOW + timedelta(days=20)))
    team, step, here, ni = run(everything)
    s.check("the team card: every part says when it opens, nobody's turn, the card says when",
            team["turn"] == 0 and all(p["opens"] == "Opens " + fmt(T_OPEN) for p in team["parts"])
            and team["opens"] == "Opens " + fmt(T_OPEN), (team["turn"], team["opens"], [p["opens"] for p in team["parts"]]))
    s.check("...each part's own turn list stays whole (the reminder builder reads it)",
            [len(p["turn"]) for p in team["parts"]] == [sum(1 for _n, act in ROWS[p["key"]] if act) for p in team["parts"]]
            and all(p["turn"] for p in team["parts"]))
    s.check("the rail: 'later' with 'Opens <date>' as its short text (never 'Your turn')",
            step["state"] == "later" and step["short"] == "Opens " + fmt(T_OPEN) and step["full"].startswith("Not yet"), step)
    s.check("...You are here has no team act and no calm row", not [x for x in here["acts"] if x["kind"] == "team"]
            and not [x for x in [here["calm"]["next"]] + here["calm"]["rest"] if x and x.get("kind") == "team"]
            and here["head"] == "Nothing needs you right now" and not here["waits"], (here["acts"], here["head"], here["waits"]))
    s.check("...the not-in-this-cycle summary counts nobody as a turn, and done stays right",
            ni and ni["team"]["turn"] == 0 and ni["team"]["wait"] + ni["team"]["done"] + ni["team"]["turn"] == team["people"]
            and ni["team"]["wait"] == len({n for v in ROWS.values() for n, _ in v}), ni and ni["team"])

    s.section("the window's start moves: the words follow; the earliest start of the parts is used")
    setwins(stamp(T_OPEN + timedelta(days=5)), stamp(NOW + timedelta(days=20)), cells=("tc_approve", "idp_review"))
    run(lambda d, u: (d.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                                (CID, "pm_approve", stamp(T_OPEN), stamp(NOW + timedelta(days=20)))), d.commit()))
    team, step, here, ni = run(everything)
    s.check("earliest start wins on the card and the rail", team["opens"] == "Opens " + fmt(T_OPEN)
            and step["short"] == "Opens " + fmt(T_OPEN), (team["opens"], step["short"]))

    s.section("one part open, one not: only the open part counts")
    setwins(stamp(T_OPEN), stamp(NOW + timedelta(days=20)))
    run(lambda d, u: (d.execute("UPDATE cycle_windows SET opens_at=?, closes_at=? WHERE cycle_id=? AND cell='pm_approve'",
                                (stamp(NOW - timedelta(days=1)), stamp(NOW + timedelta(days=10)), CID)), d.commit()))
    team, step, here, ni = run(everything)
    open_n = sum(1 for _n, act in ROWS["pm_review"] if act)
    s.check("the open part's count only; no 'opens' on the card", team["turn"] == open_n and team["opens"] is None
            and [bool(p["opens"]) for p in team["parts"]] == [False, True, True], (team["turn"], team["opens"]))
    s.check("...the rail is 'turn' with that count, and the acts name only the open part",
            step["state"] == "turn" and step["line"] == "%d waiting on you" % open_n
            and [x["tag"] for x in here["acts"] if x["kind"] == "team"] and
            all(x["tag"] == "KPI review" for x in here["acts"] if x["kind"] == "team"), (step, here["acts"]))

    s.section("opens in the PAST: the turn and the acts are back (falsifies the guard)")
    setwins(stamp(NOW - timedelta(days=1)), stamp(NOW + timedelta(days=10)))
    team, step, here, ni = run(everything)
    want = sum(1 for v in ROWS.values() for _n, act in v if act)
    s.check("all parts open: every turn counted, no 'opens'", team["turn"] == want and team["opens"] is None
            and not any(p["opens"] for p in team["parts"]), (team["turn"], team["opens"]))
    s.check("...the step is 'turn' with the count; the team acts are back",
            step["state"] == "turn" and step["line"] == "%d waiting on you" % want
            and len([x for x in here["acts"] if x["kind"] == "team"]) == 3, (step, here["acts"]))
    s.check("...the not-in summary counts the turn", ni["team"]["turn"] == len({n for v in ROWS.values() for n, act in v if act}), ni["team"])

    s.section("an open_by_date cycle with no start date: 'Not open yet'")
    setwins(None, None, cells=())
    run(lambda d, u: (d.execute("UPDATE cycles SET open_by_date=1 WHERE id=?", (CID,)), d.commit()))
    team, step, here, ni = run(everything)
    s.check("'Not open yet' on the card and the rail, still not a turn", team["opens"] == "Not open yet" and team["turn"] == 0
            and step["state"] == "later" and step["short"] == "Not yet", (team["opens"], step))
    s.check("...no act", not [x for x in here["acts"] if x["kind"] == "team"])
finally:
    for k, v in _real.items():
        setattr(a, k, v)

    def back(d, _u):
        d.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for r in ORIG["windows"]:
            d.execute("INSERT INTO cycle_windows(%s) VALUES (%s)" % (",".join(r), ",".join("?" * len(r))), list(r.values()))
        d.execute("UPDATE cycles SET open_by_date=? WHERE id=?", (ORIG["open_by_date"], CID))
        d.commit()
    run(back)
sys.exit(s.done())
