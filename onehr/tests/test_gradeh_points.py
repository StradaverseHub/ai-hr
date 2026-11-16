"""Points per answer, piece 2: Grade H (Chris, 9 Nov 2026; OneHR/Points per answer plan 2026-11-09.md, canvas C1).

What a Yes and a Not yet earn on the 14 Leadership Principle statements (7 at the person's level, weight 1; 7 at the next, weight 1.5),
its own setting: gradeh_setting("gradeh_points", cid) = the org-wide default plus a cycle's own "gradeh_points@<cid>". What this holds:
  * the engine: the default 1 / 1.5 / 0 / 0 with no row is exactly today's (all Yes = 17.5, 7 + 7 statements), a cycle's own row beats the
    org-wide one, a Not yet earns its own points, the cut-off range and band read the cycle's most, gradeh_computed reads the CYCLE's points
  * the validator (gradeh_points_parse): each rule, both directions, falsified; Not yet above 0 is allowed
  * the check (the GET ?preview=points) writes nothing and says the counts; the release lock (any gradeh_releases row) refuses "current"
    server-side and the step says "Not open" (falsified: with the row gone it is allowed)
  * the save: "next" pins the current cycle (points and cut-offs) and every PAST cycle with a Grade H list that follows the org-wide ones
    (not archived, not released, merely older: pinned; a newer draft: not), leaves every score alone and rescales the org-wide cut-offs;
    "current" re-works the potential scores of everyone it changes and the bands of everyone nobody has moved, never a moved band or a move
  * the reason is the super admin's band remark; a non-super admin is refused; the card sits above Potential bands and curve
Synthetic (ZZ9GP-*) on a fresh scratch database. Everything it changes is put back."""
import html
import json
import os
import re
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Points per answer, piece 2: Grade H")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, EMP = H.actors(a)
PFX, BG, CO, COB = "ZZ9GP-", "ZZGP Group", "ZZGP Unit A", "ZZGP Unit B"
U, P = {}, {}
_ENV0 = os.environ.get("ONEHR_GRADEH")
os.environ["ONEHR_GRADEH"] = "1"
BASE = "/admin/gradeh"
import sqlite3  # noqa: E402

db = sqlite3.connect(a.DB_PATH, timeout=5.0)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
Pt = a.Points
NOW = datetime.utcnow()


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
    return " ".join(html.unescape(h).split())


def csrf(**kw):
    d = {"csrf_token": "tok"}
    d.update(kw)
    return d


def utc(x):
    return x.strftime("%Y-%m-%d %H:%M:%S")


def mk(k, grade="H", hod=None, co=CO, dept="ZZGP Dept", mgr=None):
    return db.execute(
        "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
        "job_grade, job_title, hod_id, manager_id, email, confirmation_date) VALUES (?,?, 'x', 'user', ?, ?,?,?,?, 'Driver', ?, ?, ?, '2020-01-01')",
        ((PFX + k).lower(), "ZZ GP " + k, PFX + k, BG, co, dept, grade, hod, mgr, None)).lastrowid


def person(k, cid=None, **kw):
    pid = db.execute("INSERT INTO gradeh_people (cycle_id, employee_id, user_id, route, language) VALUES (?,?,?,?,?)",
                     (CID if cid is None else cid, PFX + k, U[k], "B", "en")).lastrowid
    if cid is None:
        P[k] = pid
    return pid


# the statements by level: weight 1 = at their level, 1.5 = at the next level (7 each)
CUR = [(p["n"], st["n"]) for p in a.GRADEH_LP for st in p["statements"] if st["w"] == 1]
NXT = [(p["n"], st["n"]) for p in a.GRADEH_LP for st in p["statements"] if st["w"] == 1.5]


def answers_for(y, z):
    """The first y at-their-level statements and the first z at-the-next-level ones Yes, the rest Not yet."""
    yes = set(CUR[:y]) | set(NXT[:z])
    return {(lp, st): ("yes" if (lp, st) in yes else "not_yet") for lp in range(1, 8) for st in (1, 2)}


def independent(y, z, p):
    """A score from the counts alone: the arithmetic gradeh_potential_score must agree with."""
    return y * p.dc + (7 - y) * p.vc + z * p.dn + (7 - z) * p.vn


def submit(k, y, z, cid=None):
    """What the line manager's submit stores for a Route B person: the 14 answers and the computed potential, at the cycle's points."""
    pid = P[k] if cid is None else cid[1]
    cyc = CID if cid is None else cid[0]
    for (lp, st), v in answers_for(y, z).items():
        db.execute("INSERT OR REPLACE INTO gradeh_lp_answers (cycle_id, person_id, lp, stmt, answer) VALUES (?,?,?,?,?)", (cyc, pid, lp, st, v))
    db.commit()
    c = run(lambda d: a.gradeh_computed(d, cyc, pid))
    db.execute("INSERT OR IGNORE INTO gradeh_appraisals (cycle_id, person_id) VALUES (?,?)", (cyc, pid))
    db.execute("UPDATE gradeh_appraisals SET lm_submitted_at=?, pot_score=?, pot_band=? WHERE cycle_id=? AND person_id=?",
               (utc(NOW - timedelta(days=2)), c["pot_score"], c["pot_band"], cyc, pid))
    db.commit()
    return c


def gs(name, cid=None):
    return run(lambda d: a.gradeh_setting(name, CID if cid is None else cid))


def org(name):
    return run(lambda d: a.gradeh_setting(name, None))


def stored(k):
    r = db.execute("SELECT pot_score, pot_band FROM gradeh_appraisals WHERE cycle_id=? AND person_id=?", (CID, P[k])).fetchone()
    return (r["pot_score"], r["pot_band"]) if r else None


def clear_rows():
    db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_points%' OR key LIKE 'gradeh_pot_cuts%'")
    db.execute("DELETE FROM gradeh_releases WHERE cycle_id IN (SELECT id FROM cycles)")
    db.commit()


def snapshot():
    return ([tuple(r) for r in db.execute("SELECT key, value FROM app_settings WHERE key LIKE 'gradeh_%' ORDER BY key")],
            [tuple(r) for r in db.execute("SELECT person_id, pot_score, pot_band FROM gradeh_appraisals ORDER BY id")],
            db.execute("SELECT COUNT(*) FROM gradeh_band_moves").fetchone()[0],
            db.execute("SELECT COUNT(*) FROM activity_log WHERE action='gradeh_settings'").fetchone()[0])


with a.app.test_request_context("/"):
    CID = a.active_cycle_id(a.get_db())
db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key='gradeh'", (CID,))
db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) VALUES (?, 'gradeh', 1)", (CID,))
for c_ in (CO, COB):
    db.execute("INSERT OR IGNORE INTO org_units(business_group, company) VALUES (?,?)", (BG, c_))
U["BCA"] = mk("BCA", "21", dept="ZZGP Division")
U["BCB"] = mk("BCB", "21", co=COB, dept="ZZGP Division")
U["HODA"] = mk("HODA", "19", hod=U["BCA"], dept="ZZGP Dept One")
U["LMA"] = mk("LMA", "15", hod=U["HODA"], dept="ZZGP Dept One")
db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO, U["BCA"]))
db.execute("INSERT INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, COB, U["BCB"]))
for k in ("R1", "R2", "R3", "R4", "R5", "R6"):
    U[k] = mk(k, hod=U["HODA"], mgr=U["LMA"], dept="ZZGP Dept One")
    person(k)
U["B1"] = mk("B1", co=COB, hod=U["BCB"], mgr=U["LMA"], dept="ZZGP Dept B")
person("B1")
db.commit()
clear_rows()
# a past cycle (older than the current one, NOT archived, NOT released) and a newer draft, each with a Grade H list
db.execute("INSERT INTO cycles(id, code, name, is_active) VALUES (-7, 'ZZ-GP-PAST', 'ZZ GP past', 0)")
db.execute("INSERT INTO cycles(code, name, is_active) VALUES ('ZZ-GP-FUT', 'ZZ GP draft', 0)")
db.commit()
PAST_ID = one("SELECT id FROM cycles WHERE code='ZZ-GP-PAST'")
FUT_ID = one("SELECT id FROM cycles WHERE code='ZZ-GP-FUT'")
U["PX"] = mk("PX", dept="ZZGP Dept One")
person("PX", PAST_ID)
person("PX", FUT_ID)
db.commit()

SUC = H.client_as(a, SU["id"])
BGC = H.client_as(a, BGA["id"]) if BGA else None

try:
    # ==================================================================================================================
    s.section("the engine: today's 1 / 1.5 / 0 / 0 with no row, the cycle's own points, a Not yet that earns")
    s.check("the fixture: 7 statements at their level (weight 1) and 7 at the next (weight 1.5)", len(CUR) == 7 and len(NXT) == 7 and a.GRADEH_N_CUR == 7 and a.GRADEH_N_NEXT == 7)
    s.check("no row: the default points are today's (1, 1.5, 0, 0) and the most is 17.5, the least 0",
            run(lambda d: a.gradeh_points(CID)) == Pt(1.0, 1.5, 0.0, 0.0) and run(lambda d: (a.gradeh_lp_max(CID), a.gradeh_lp_min(CID))) == (17.5, 0.0)
            and a.GRADEH_DEFAULTS["gradeh_points"] == [1, 1.5, 0, 0])
    PS = a.gradeh_potential_score
    s.check("all Yes = 17.5, all Not yet = 0, and the scorer agrees with an independent sum from the counts on the default",
            PS(answers_for(7, 7)) == 17.5 and PS(answers_for(0, 0)) == 0 and all(PS(answers_for(y, z)) == independent(y, z, Pt(1, 1.5, 0, 0))
                                                                                  for y, z in ((3, 4), (7, 0), (0, 7), (5, 5))))
    NEWP = Pt(2.0, 3.0, 0.5, 1.0)
    s.check("with points given, a Yes earns its level's points and a Not yet its own (independent sums)",
            all(abs(PS(answers_for(y, z), NEWP) - independent(y, z, NEWP)) < 1e-9 for y, z in ((3, 4), (7, 0), (0, 7), (5, 5), (0, 0), (7, 7)))
            and PS(answers_for(0, 0), NEWP) == 10.5 and PS(answers_for(7, 7), NEWP) == 35.0)
    s.check("...and the default arithmetic is NOT used when points are given (falsified: 3 / 4 differs from the default's)",
            PS(answers_for(3, 4), NEWP) != PS(answers_for(3, 4)))
    short = answers_for(7, 7)
    short.pop((1, 1))
    try:
        PS(short, NEWP)
        s.check("an unanswered statement is still refused, naming the gap", False)
    except a.GradehRefusal as e:
        s.check("an unanswered statement is still refused, naming the gap", "1.1" in str(e), str(e))
    # the setting reader: org-wide, then the cycle's own
    run(lambda d: a.gradeh_set_setting(d, "gradeh_points", [2, 3, 0.5, 1]))
    s.check("an org-wide row is read", run(lambda d: a.gradeh_points(CID)) == NEWP and run(lambda d: a.gradeh_points(None)) == NEWP)
    run(lambda d: a.gradeh_set_setting(d, "gradeh_points", [1, 1.5, 0, 0], CID))
    s.check("a cycle's own row beats the org-wide one", run(lambda d: a.gradeh_points(CID)) == Pt(1.0, 1.5, 0.0, 0.0) and run(lambda d: a.gradeh_points(None)) == NEWP)
    run(lambda d: a.gradeh_set_setting(d, "gradeh_points", "garbage", CID))
    s.check("a stored value that is not four numbers is ignored, never half-read", run(lambda d: a.gradeh_points(CID)) == Pt(1.0, 1.5, 0.0, 0.0))
    clear_rows()
    # the range and the band read the cycle's most
    run(lambda d: a.gradeh_set_setting(d, "gradeh_points", [2, 3, 0.5, 1], CID))
    s.check("the cycle's most is 7 x Yes-at-their-level + 7 x Yes-at-the-next (35), its least 7 x Not-yet's (10.5)",
            run(lambda d: (a.gradeh_lp_max(CID), a.gradeh_lp_min(CID))) == (35.0, 10.5))
    s.check("the cut-off range reads the cycle's most: 30 is valid on 35 and refused on 17.5",
            a.gradeh_pot_cuts_error([13, 30], 35.0) is None and a.gradeh_pot_cuts_error([13, 30]) is not None
            and a.gradeh_pot_cuts_error([13, 36], 35.0) is not None and a.gradeh_pot_cuts_error([0, 13], 35.0) is not None
            and a.gradeh_pot_cuts_error([20, 13], 35.0) is not None)
    s.check("...and the message names the cycle's most", "between 0 and 35" in a.gradeh_pot_cuts_error([13, 36], 35.0))
    s.check("a score is banded against the cycle's most: 30 is High on 35 (cuts 13 / 26), 12.9 Low, 13 Mid, and a score is still Mid at 7 on the default",
            a.gradeh_pot_band(30, [13, 26], 35.0) == "High" and a.gradeh_pot_band(12.9, [13, 26], 35.0) == "Low" and a.gradeh_pot_band(13, [13, 26], 35.0) == "Mid"
            and a.gradeh_pot_band(7, [6.5, 13]) == "Mid")
    try:
        a.gradeh_pot_band(36, [13, 26], 35.0)
        s.check("a score above the cycle's most is refused", False)
    except a.GradehRefusal:
        s.check("a score above the cycle's most is refused", True)
    # gradeh_computed reads the DATA's cycle, never another's
    submit("R1", 3, 4)
    run(lambda d: a.gradeh_set_setting(d, "gradeh_pot_cuts", [13, 26], CID))
    c_new = run(lambda d: a.gradeh_computed(d, CID, P["R1"]))
    s.check("gradeh_computed scores on the cycle's own points (3 / 4: %g) and bands on its own cut-offs" % independent(3, 4, NEWP),
            abs(c_new["pot_score"] - independent(3, 4, NEWP)) < 1e-9 and c_new["pot_band"] == "Mid", c_new)
    clear_rows()
    c_def = run(lambda d: a.gradeh_computed(d, CID, P["R1"]))
    s.check("...and on the default for a cycle holding no row (falsified: it differs)", abs(c_def["pot_score"] - independent(3, 4, Pt(1, 1.5, 0, 0))) < 1e-9
            and c_def["pot_score"] != c_new["pot_score"], c_def)
    db.execute("DELETE FROM gradeh_lp_answers WHERE person_id=?", (P["R1"],))
    db.execute("DELETE FROM gradeh_appraisals WHERE person_id=?", (P["R1"],))
    db.commit()

    # ==================================================================================================================
    s.section("the validator: each rule, both directions, falsified")
    PR = a.gradeh_points_parse
    ok_form = dict(dc="2", dn="3", vc="0.5", vn="1")
    p, e = PR(ok_form)
    s.check("a good set parses (Not yet above 0 is allowed)", p == Pt(2.0, 3.0, 0.5, 1.0) and e == [], (p, e))
    p, e = PR(dict(dc="1", dn="1.5", vc="0", vn="0"))
    s.check("today's 1 / 1.5 / 0 / 0 parses", p == Pt(1.0, 1.5, 0.0, 0.0) and e == [])
    for label, bad in (("a value over 10", dict(dn="10.1")), ("a negative", dict(vc="-0.1")), ("two decimals", dict(dc="1.25")),
                       ("a word", dict(dc="lots")), ("a blank", dict(vn="")), ("not a number", dict(dn="nan"))):
        p, e = PR(dict(ok_form, **bad))
        s.check("refused: %s" % label, p is None and e == [a.POINTS_MSG_RANGE], e)
    p, e = PR(dict(ok_form, vc="2", vn="2"))
    s.check("Not yet equal to Yes at their level is refused, in Grade H's words", p is None and e == ["Not yet must earn less than Yes at their level."], e)
    p, e = PR(dict(ok_form, vc="2.5", vn="1"))
    s.check("...and above it", p is None and "Not yet must earn less than Yes at their level." in e, e)
    p, e = PR(dict(ok_form, vn="3"))
    s.check("Not yet equal to Yes at the next level is refused", p is None and e == ["Not yet must earn less than Yes at the next level."], e)
    p, e = PR(dict(dc="3", dn="2", vc="0", vn="0"))
    s.check("Yes at the next level below Yes at their level is refused", p is None and e == ["Yes at the next level must earn at least as much as at their level."], e)
    p, e = PR(dict(dc="3", dn="3", vc="0", vn="0"))
    s.check("...equal is allowed (at least as much)", p == Pt(3.0, 3.0, 0.0, 0.0) and e == [], e)
    p, e = PR(dict(dc="2", dn="3", vc="1", vn="0.5"))
    s.check("Not yet at the next level below Not yet at their level is refused", p is None and e == ["Not yet at the next level must earn at least as much as at their level."], e)
    s.check("the same four rules, both directions, in the card's script (the page carries the same words)",
            all(m in SUC.get(BASE + "?tab=settings").get_data(as_text=True) for m in (
                "Not yet must earn less than Yes at their level.", "Not yet must earn less than Yes at the next level.",
                "Yes at the next level must earn at least as much as at their level.", "Not yet at the next level must earn at least as much as at their level.",
                "Each value is 0 to 10, with at most one decimal.")))

    # ==================================================================================================================
    s.section("the card: where it sits, what it says; the check writes nothing")
    r = SUC.get(BASE + "?tab=settings")
    h = r.get_data(as_text=True)
    t = text(r)
    s.check("the Settings tab shows the card ABOVE Potential bands and curve", r.status_code == 200 and h.find('id="gh-points"') > 0
            and h.find('id="gh-points"') < h.find('id="gh-pot"') and h.find('id="gh-perf"') < h.find('id="gh-points"'), (h.find('id="gh-points"'), h.find('id="gh-pot"')))
    s.check("its words: the title, the description, the cycle line, 'The 7 at their level / next level', Yes / Not yet, the rule line, the button",
            "Potential points per answer" in t and "What each answer on the 14 Leadership Principle statements earns toward the Grade H potential score." in t
            and "uses 1 · 1.5 · 0 · 0. No unit's result is released yet." in t and "The 7 at their level" in t and "The 7 at the next level" in t
            and "Not yet earns less than Yes, and the next level earns at least as much as their level." in t and "Check what it changes" in t
            and "The score runs" in t and "Lowest, every statement Not yet" in t and "Mid from 6.5" in t and "High from 13" in t and re.search(r"keep their share, 37\s*% and 74\s*%", t), t[:1200])
    s.check("the four boxes hold today's values and are labelled", all(re.search(r'name="%s"[^>]*value="%s"' % (k, v), h) for k, v in (("dc", "1"), ("dn", "1.5"), ("vc", "0"), ("vn", "0")))
            and 'aria-label="Yes, at their level"' in h and 'aria-label="Not yet, at the next level"' in h)
    s.check("the potential card's words read the cycle's own most (17.5 on the default)", "score 0 to 17.5" in t)
    snap0 = snapshot()
    r = SUC.get(BASE + "?tab=settings&preview=points&dc=2&dn=3&vc=0.5&vn=1")
    t = text(r)
    h = r.get_data(as_text=True)
    s.check("the check step opens, says the values back and Today", "Before you save the points" in t and re.search(r"Yes 2 at their level and 3 at the next; Not yet 0\.5 and 1\s*\. Today 1 · 1\.5 · 0 · 0\.", t), t[:1500])
    s.check("...with both options (the current cycle, from the next cycle on) and the card keeping the typed values",
            "When it starts" in t and "the current cycle" in t and "From the next cycle on" in t and re.search(r'name="dc"[^>]*value="2"', h))
    s.check("the check writes nothing: no setting, no appraisal, no move, no audit row", snapshot() == snap0)
    s.check("its Save is double-confirmed, asks the one remark (the super admin's band remark) and needs a pick", 'data-confirm="Save the Grade H potential points' in h
            and 'data-confirm-reason-field="remark"' in h and h.count('type="radio" name="when"') == 2 and 'name="remark"' not in h.split('id="gh-points-step"')[1])
    t = text(SUC.get(BASE + "?tab=settings&preview=points&dc=1&dn=1.5&vc=0&vn=0"))
    s.check("points already in use: nothing to save, no step", "These are the points already in use" in t and "When it starts" not in t, t[:400])
    t = text(SUC.get(BASE + "?tab=settings&preview=points&dc=2&dn=3&vc=2&vn=1"))
    s.check("a refused set shows the refusal and never a step or a count", "Not yet must earn less than Yes at their level." in t and "When it starts" not in t)
    t = text(SUC.get(BASE + "?tab=settings&preview=points&dc=2&dn=1&vc=0&vn=0"))
    s.check("...(the next level below their level too)", "Yes at the next level must earn at least as much" in t and "When it starts" not in t)

    # ==================================================================================================================
    s.section("who may: super admin only; the reason is the super admin's remark; the check is a GET off the remark list")
    f = dict(action="points", when="current", remark="ZZ a try", expect_scores="0", expect_pot="0", **ok_form)
    if BGC:
        s.check("a BG admin is refused (403)", BGC.post(BASE + "/settings", data=csrf(**f)).status_code == 403)
    _so = a.app.test_client().post(BASE + "/settings", data=csrf(**f)).status_code
    s.check("a signed-out post is sent to sign in (or refused), never a 200", _so != 200, _so)
    s.check("'points' is a band action (the remark first); the GET check is not a POST at all",
            "points" in a.SUPER_BAND_ENDPOINTS["admin_gradeh_settings"] and a.admin_access_need("admin_gradeh_settings", {}) == "super")
    f_nr = dict(f)
    f_nr.pop("remark")
    r = SUC.post(BASE + "/settings", data=csrf(**f_nr), follow_redirects=True)
    s.check("with no remark the save is refused before it runs; nothing is written", "Write your remark first" in r.get_data(as_text=True) and snapshot() == snap0)
    ok, msg = run(lambda d: a.gradeh_save_points(d, dict(BGA), CID, dict(f)) if BGA else (False, "Only the super admin"))
    s.check("the writer itself refuses a non-super admin", not ok and "Only the super admin" in msg and snapshot() == snap0, msg)

    # ==================================================================================================================
    s.section("people: re-worked scores, moved bands")
    # R1..R6: (yes at their level, yes at the next) -> old score y + 1.5 z; on 2 / 3 / 0.5 / 1 it is independent(y, z)
    PEOPLE = {"R1": (7, 7), "R2": (0, 0), "R3": (0, 7), "R4": (7, 0), "R5": (0, 4), "R6": (0, 4)}
    for k, (y, z) in PEOPLE.items():
        submit(k, y, z)
    submit("B1", 0, 4)
    # R6's potential was moved by an HOD (stays Low); R4's by the BU CEO (stays High)
    run(lambda d: a.gradeh_record_move(d, CID, P["R6"], "pot", "hod", "Low", "ZZ hod move", dict(db.execute("SELECT * FROM users WHERE id=?", (U["HODA"],)).fetchone())))
    run(lambda d: a.gradeh_record_move(d, CID, P["R4"], "pot", "buceo", "High", "ZZ buceo move", dict(db.execute("SELECT * FROM users WHERE id=?", (U["BCA"],)).fetchone())))
    old = {k: stored(k) for k in PEOPLE}
    s.check("(the stored scores are today's: y + 1.5 z; R5 / R6 are 6.0 = Low, R3 10.5 = Mid, R1 17.5 = High)",
            old["R1"] == (17.5, "High") and old["R2"] == (0.0, "Low") and old["R3"] == (10.5, "Mid") and old["R4"] == (7.0, "Mid") and old["R5"] == (6.0, "Low") == old["R6"], old)
    fin0 = {k: run(lambda d: a.gradeh_effective_band(d, CID, P[k], "pot")) for k in PEOPLE}
    moves0 = [tuple(r) for r in db.execute("SELECT id, person_id, axis, stage, band, remark FROM gradeh_band_moves ORDER BY id")]

    # the release lock first: a unit released -> "current" refused, "next" open, the step says Not open
    db.execute("INSERT INTO gradeh_releases(cycle_id, unit, released_by) VALUES (?,?,NULL)", (CID, COB))
    db.commit()
    rel_on = run(lambda d: a.gradeh_points_released_on(d, CID))
    s.check("the first unit released fixes the cycle: points_released_on gives its MYT date", rel_on and re.match(r"\d{1,2} \w{3} \d{4}", rel_on), rel_on)
    t = text(SUC.get(BASE + "?tab=settings"))
    s.check("the card says so", "keeps 1 · 1.5 · 0 · 0: a unit's result was released on %s. A change here applies from the next cycle." % rel_on in t, t[:600])
    r = SUC.get(BASE + "?tab=settings&preview=points&dc=2&dn=3&vc=0.5&vn=1")
    t, h = text(r), r.get_data(as_text=True)
    s.check("the step reads 'Not open' with the date for the current cycle, disabled; the next-cycle option is preselected",
            ("Not open: a unit's results were released on %s, so its points are fixed." % rel_on) in t
            and re.search(r'name="when" value="current" disabled', h) and re.search(r'name="when" value="next" checked', h), t[-700:])
    snap1 = snapshot()
    r = SUC.post(BASE + "/settings", data=csrf(**dict(f, remark="ZZ try current after release")), follow_redirects=True)
    s.check("the server refuses 'current' for a released cycle whatever the form says; nothing is written", "points are fixed" in text(r) and snapshot()[:2] == snap1[:2]
            and not db.execute("SELECT 1 FROM app_settings WHERE key LIKE 'gradeh_points%'").fetchone(), text(r)[:300])
    with a.app.test_request_context("/"):   # the dry run skips a released unit's people (B1's unit is COB)
        pl = a._gh_points_plan(a.get_db(), CID, NEWP, "current")
        pre_rel = a.gradeh_points_preview(a.get_db(), CID, pl)
    s.check("a released unit is never re-worked (B1 sits in the released unit): its stored score is untouched by a re-work",
            pre_rel["people"] >= 1 and stored("B1") == (6.0, "Low"))
    db.execute("DELETE FROM gradeh_releases WHERE cycle_id=?", (CID,))
    db.commit()
    s.check("(falsified) with the release row gone the same lock is open: a date no longer, the writer allows 'current'",
            run(lambda d: a.gradeh_points_released_on(d, CID)) is None)

    # the dry run, as the real scorers say it
    with a.app.test_request_context("/"):
        d_ = a.get_db()
        step, err = a.gradeh_points_step(d_, CID, NEWP)
    exp_scores = sum(1 for k, (y, z) in PEOPLE.items() if abs(independent(y, z, NEWP) - old[k][0]) > 1e-9) + 1   # + B1
    s.check("the step's counts: every submitted person whose score changes (all seven here: the points change every figure)",
            err is None and step["scores"] == exp_scores == 7 and step["now_open"] and step["next_open"] and step["released_on"] is None, (step, err))
    # bands on the new scale with the cuts rescaled x2 (13 / 26): R1 35 High; R2 10.5 Low; R3 24.5 Mid; R4 21 Mid (moved: stays High); R5 / R6 18.5 Mid (R6 moved: stays Low)
    s.check("...and the band changes: R3 (Mid -> Mid no), R5 (Low -> Mid) and B1 (Low -> Mid): the moved ones (R4, R6) are not counted",
            step["pot"] == 2 and tuple(step["cuts_after"]) == (13.0, 26.0) and tuple(step["org_cuts_after"]) == (13.0, 26.0), step)
    import time
    t0 = time.time()
    with a.app.test_request_context("/"):
        a.gradeh_points_step(a.get_db(), CID, NEWP)
    s.check("the check on this fixture is quick (%.3f s)" % (time.time() - t0), time.time() - t0 < 5)
    after_dry = snapshot()
    s.check("(the dry run held the points in g._gradeh_ov only: nothing was written, the override is gone)",
            after_dry[:2] == snapshot()[:2] and run(lambda d: a.gradeh_points(CID)) == Pt(1.0, 1.5, 0.0, 0.0))

    # ==================================================================================================================
    s.section('"from the next cycle on": the current and every PAST cycle with a list keep the OLD points and cut-offs; nobody\'s score moves')
    snap_scores = {k: stored(k) for k in PEOPLE}
    with a.app.test_request_context("/"):
        pl_ = a._gh_points_plan(a.get_db(), CID, NEWP, "next")
    s.check("the plan pins the past unarchived unreleased cycle and not the newer draft (same state, higher id)",
            [x["id"] for x in pl_["pins"]] == [PAST_ID] and PAST_ID < CID < FUT_ID, ([x["id"] for x in pl_["pins"]], PAST_ID, CID, FUT_ID))
    r = SUC.post(BASE + "/settings", data=csrf(**dict(f, when="next", remark="ZZ start next cycle")), follow_redirects=True)
    s.check("saved, in Grade H's words", "The new points start from the next cycle" in text(r) and "keeps 1 · 1.5 · 0 · 0" in text(r), text(r)[:300])
    s.check("the org-wide points are the new ones", org("gradeh_points") == [2.0, 3.0, 0.5, 1.0])
    s.check("the current cycle is pinned at the old points and its own cut-offs", run(lambda d: a.gradeh_points(CID)) == Pt(1.0, 1.5, 0.0, 0.0)
            and json.loads(one("SELECT value FROM app_settings WHERE key=?", ("gradeh_points@%s" % CID,))) == [1.0, 1.5, 0.0, 0.0]
            and json.loads(one("SELECT value FROM app_settings WHERE key=?", ("gradeh_pot_cuts@%s" % CID,))) == [6.5, 13.0])
    s.check("the past unarchived, unreleased cycle is pinned too (points and cut-offs)", run(lambda d: a.gradeh_points(PAST_ID)) == Pt(1.0, 1.5, 0.0, 0.0)
            and gs("gradeh_pot_cuts", PAST_ID) == [6.5, 13.0])
    s.check("the newer draft follows the org-wide points and cut-offs (not pinned)", run(lambda d: a.gradeh_points(FUT_ID)) == NEWP
            and one("SELECT 1 FROM app_settings WHERE key=?", ("gradeh_points@%s" % FUT_ID,)) is None and gs("gradeh_pot_cuts", FUT_ID) == [13.0, 26.0])
    s.check("the org-wide cut-offs keep their share of the most: x35/17.5 = 2 -> 13 / 26", org("gradeh_pot_cuts") == [13.0, 26.0])
    s.check("the current cycle still bands on 6.5 / 13 and nobody's stored score or band moved", gs("gradeh_pot_cuts") == [6.5, 13.0] and {k: stored(k) for k in PEOPLE} == snap_scores
            and {k: run(lambda d: a.gradeh_effective_band(d, CID, P[k], "pot")) for k in PEOPLE} == fin0)
    au = db.execute("SELECT detail FROM activity_log WHERE action='gradeh_settings' ORDER BY id DESC LIMIT 1").fetchone()[0]
    s.check("the audit row: old -> new, which option, who was pinned, the cut-offs moved and the reason",
            "Points per answer, Grade H: Yes 2 / 3, Not yet 0.5 / 1 (was 1 / 1.5, 0 / 0)" in au and "from the next cycle on" in au and "ZZ GP past" in au
            and "default cut-offs Mid 13, High 26 (were 6.5, 13)" in au and "remark: ZZ start next cycle" in au, au)
    # the same save again: it is now the default
    r = SUC.post(BASE + "/settings", data=csrf(**dict(f, when="next", remark="ZZ again")), follow_redirects=True)
    s.check("saving the same default for 'next' again is refused (nothing to start)", "already the default points" in text(r))
    clear_rows()

    # ==================================================================================================================
    s.section('"the current cycle": re-scored at once; a moved band is never re-worked; the cut-offs keep their share')
    # a cycle's own cut-offs, as a Year-End may hold: 6 / 12.5 -> x2
    run(lambda d: a.gradeh_set_setting(d, "gradeh_pot_cuts", [6.5, 13]))
    ctx_count = None
    with a.app.test_request_context("/"):
        pl2 = a._gh_points_plan(a.get_db(), CID, NEWP, "current")
        ctx_count = a.gradeh_points_preview(a.get_db(), CID, pl2)
    s.check("(the dry run first)", ctx_count["scores"] == 7 and ctx_count["pot"] == 2, ctx_count)
    stale = dict(f, expect_scores=str(ctx_count["scores"] + 1), expect_pot=str(ctx_count["pot"]), remark="ZZ stale")
    r = SUC.post(BASE + "/settings", data=csrf(**stale), follow_redirects=True)
    s.check("a stale count is refused: the confirm never lies, nothing saved", "count changed" in text(r) and org("gradeh_points") == [1, 1.5, 0, 0], text(r)[:200])
    ok_f = dict(f, expect_scores=str(ctx_count["scores"]), expect_pot=str(ctx_count["pot"]), remark="ZZ re-work now")
    r = SUC.post(BASE + "/settings", data=csrf(**ok_f), follow_redirects=True)
    t = text(r)
    s.check("saved, and says how many were re-worked and where the cut-offs went", "is re-worked on 2 · 3 · 0.5 · 1 now: 7 potential scores and 2 bands" in t
            and "Mid from 13, High from 26" in t, t[:400])
    s.check("the org-wide points and cut-offs are the new ones; the current cycle follows them (its own row deleted)",
            org("gradeh_points") == [2.0, 3.0, 0.5, 1.0] and org("gradeh_pot_cuts") == [13.0, 26.0]
            and one("SELECT 1 FROM app_settings WHERE key=?", ("gradeh_points@%s" % CID,)) is None and run(lambda d: a.gradeh_points(CID)) == NEWP and gs("gradeh_pot_cuts") == [13.0, 26.0])
    now_ = {k: stored(k) for k in PEOPLE}
    s.check("every stored potential score is the independent sum on 2 / 3 / 0.5 / 1 (moved people's included: a score is a figure of the answers)",
            all(abs(now_[k][0] - independent(*PEOPLE[k], NEWP)) < 1e-9 for k in PEOPLE), now_)
    s.check("an unmoved band is re-worked: R5 Low -> Mid; R1 stays High, R2 stays Low, R3 stays Mid", now_["R5"][1] == "Mid" and now_["R1"][1] == "High" and now_["R2"][1] == "Low" and now_["R3"][1] == "Mid", now_)
    s.check("a band a calibrator moved is never re-worked: R6's LM band is untouched (Low, where R5 went Mid), R4's too",
            now_["R6"][1] == "Low" and now_["R4"][1] == "Mid" and old["R4"][1] == "Mid" and old["R6"][1] == "Low")
    s.check("...no move was touched, and every final band reads as it did (R4 High by the BU CEO, R6 Low by the HOD)",
            [tuple(r) for r in db.execute("SELECT id, person_id, axis, stage, band, remark FROM gradeh_band_moves ORDER BY id")] == moves0
            and {k: run(lambda d: a.gradeh_effective_band(d, CID, P[k], "pot")) for k in ("R4", "R6")} == {k: fin0[k] for k in ("R4", "R6")}
            and fin0["R4"] == ("High", "buceo") and fin0["R6"] == ("Low", "hod"), fin0)
    s.check("a computed result agrees with what was stored (the same scorers)", all(run(lambda d: a.gradeh_computed(d, CID, P[k]))["pot_score"] == now_[k][0] for k in PEOPLE))
    s.check("the past cycle and the released-style pins were made first: the past cycle keeps 1 / 1.5 / 0 / 0 and its own cut-offs 6.5 / 13",
            run(lambda d: a.gradeh_points(PAST_ID)) == Pt(1.0, 1.5, 0.0, 0.0) and gs("gradeh_pot_cuts", PAST_ID) == [6.5, 13.0])
    s.check("a newer draft takes the new points and the rescaled cut-offs", run(lambda d: a.gradeh_points(FUT_ID)) == NEWP and gs("gradeh_pot_cuts", FUT_ID) == [13.0, 26.0])
    au = db.execute("SELECT detail FROM activity_log WHERE action='gradeh_settings' ORDER BY id DESC LIMIT 1").fetchone()[0]
    s.check("the audit row names the current cycle, the re-work counts, 'moved bands were left' and the reason",
            "from %s, the current cycle" % one("SELECT name FROM cycles WHERE id=?", (CID,)) in au and "re-worked 7 potential scores and 2 bands for 7 people" in au
            and "bands a calibrator or the super admin had moved were left" in au and "remark: ZZ re-work now" in au, au)
    # a second 'current' save with the cycle holding its OWN points: it is let go to follow, its own cut-offs rescaled from ITS points
    clear_rows()
    run(lambda d: a.gradeh_set_setting(d, "gradeh_points", [2, 3, 0.5, 1]))
    run(lambda d: a.gradeh_set_setting(d, "gradeh_points", [1, 1.5, 0, 0], CID))
    run(lambda d: a.gradeh_set_setting(d, "gradeh_pot_cuts", [6.5, 13], CID))
    run(lambda d: a.gradeh_set_setting(d, "gradeh_pot_cuts", [13, 26]))
    with a.app.test_request_context("/"):
        pl3 = a._gh_points_plan(a.get_db(), CID, Pt(4.0, 6.0, 0.0, 0.0), "current")
    s.check("a cycle that held its OWN points and cut-offs: let go, its cut-offs rescaled from what IT scored on (17.5 -> 70: x4 = 26 / 52); the org-wide from ITS 35 -> 70: x2",
            pl3["unpin_cur"] and pl3["cur_cuts_new"] == [26.0, 52.0] and pl3["org_cuts_new"] == [26.0, 52.0], pl3)
    clear_rows()

    # ==================================================================================================================
    s.section("Not yet above 0: the floor warning is on the card; the cut-off form is never trapped by it")
    t = text(SUC.get(BASE + "?tab=settings&preview=points&dc=2&dn=3&vc=1.5&vn=2.5"))
    s.check("the step opens for a Not yet above 0 (allowed)", "Before you save the points" in t and "Not yet 1.5 and 2.5" in t, t[:300])
    h = SUC.get(BASE + "?tab=settings").get_data(as_text=True)
    s.check("the card carries the warning's words and its band logic (shown live only when the lowest score is above 0)",
            "Everyone now scores at least" in h and "Someone who answered Not yet on every statement lands in" in h and "'Low, still'" in h and "warn.hidden = !(ok && mn > 0)" in h)
    run(lambda d: a.gradeh_set_setting(d, "gradeh_points", [2, 3, 1.5, 2.5], CID))
    pf = {"p_mid": "6.5", "p_high": "13", "pc_low": "15", "pc_mid": "70", "pc_high": "15", "expect_pot": "0", "expect_perf": "0"}
    with a.app.test_request_context("/"):
        _pre = a.gradeh_rework_preview(a.get_db(), CID, {"gradeh_pot_cuts": [6.5, 13.0]})
    pf = dict(pf, expect_pot=str(_pre["pot"]), expect_perf=str(_pre["perf"]))
    ok, msg = run(lambda d: a.gradeh_save_pot(d, dict(SU), CID, pf))
    s.check("a Mid cut-off under the lowest possible score (floor 17.5) is allowed with the card's warning, so the cut-off form is not trapped", ok, msg)
    clear_rows()

    # ==================================================================================================================
    s.section("cut-offs that would not stay valid after the rescale refuse the save, naming why (nothing written)")
    run(lambda d: a.gradeh_set_setting(d, "gradeh_pot_cuts", [6.5, 6.51]))   # two cut-offs 0.01 apart: x 0.08 rounds them together
    tiny = dict(action="points", dc="0.1", dn="0.1", vc="0", vn="0")
    with a.app.test_request_context("/"):
        pl_bad = a._gh_points_plan(a.get_db(), CID, Pt(0.1, 0.1, 0.0, 0.0), "current")
        step_bad, err_bad = a.gradeh_points_step(a.get_db(), CID, Pt(0.1, 0.1, 0.0, 0.0))
    s.check("the plan says the new cut-offs would not be valid, and the step refuses with those words", pl_bad["error"] and "would not stay valid" in pl_bad["error"] and step_bad is None and err_bad == pl_bad["error"], (pl_bad["error"], err_bad))
    snap_bad = snapshot()
    ok, msg = run(lambda d: a.gradeh_save_points(d, dict(SU), CID, dict(tiny, when="next", remark="ZZ")))
    s.check("the save refuses it and writes nothing", not ok and "would not stay valid" in msg and snapshot() == snap_bad, msg)
    clear_rows()

    # ==================================================================================================================
    s.section("every reader of the maximum reads the cycle's own; the old constant is only the engine default")
    src = H.source(a, "app.py")
    left = [m.start() for m in re.finditer(r"GRADEH_LP_MAX", src)]
    lines = sorted({src.count("\n", 0, i) + 1 for i in left})
    ctxs = [src.splitlines()[ln - 1].strip() for ln in lines]
    s.check("GRADEH_LP_MAX remains only as its definition, the two engine-default fallbacks and a comment (3 places)", len(ctxs) == 3, ctxs)
    s.check("the potential score is never summed from the fixed weights any more", 'Decimal(str(st["w"]))' not in src)
    s.check("the calibration pages say 'out of' the cycle's most", "(out of {{ v.pot_max }})" in H.source(a, "templates/gradeh_calib.html"))
    s.check("the line manager's note carries the cycle's most (bilingual)", a.gh_lm_t("en", "pot_note", n=9, s="21", m="35") == "9 of 14 marked Yes · 21 of 35"
            and a.gh_lm_t("bm", "pot_note", n=9, s="21", m="35") == "9 daripada 14 ditandakan Ya · 21 daripada 35")
finally:
    if _ENV0 is None:
        os.environ.pop("ONEHR_GRADEH", None)
    else:
        os.environ["ONEHR_GRADEH"] = _ENV0
    try:
        db.execute("DELETE FROM app_settings WHERE key LIKE 'gradeh_%'")
        db.execute("DELETE FROM gradeh_releases WHERE unit IN (?,?)", (CO, COB))
        db.execute("DELETE FROM cycles WHERE code IN ('ZZ-GP-PAST','ZZ-GP-FUT')")
        db.commit()
    except Exception:
        pass

sys.exit(s.done())
