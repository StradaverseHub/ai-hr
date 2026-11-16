"""Adding a library competency by hand on the person's Competency tab (Chris, 2026-11-07): the same competency never
becomes two current lines. One shared rule (_tc_add_level_problem) is called by the writer and read by the find list.

What this suite holds:
  * Add as CURRENT is refused when they already hold a current line of that competency at any level (a higher level
    names "For their future role"); Add as NEXT LEVEL is refused when they already have a next level of it, or hold it
    now at the same or a higher level; everything else passes (a next level with no current beside it still works)
  * a refusal writes nothing; each guard is falsified (the call removed: the refused add goes through)
  * the find list never shows a button the server refuses: a person holding L3 sees "Add as their next level
    (L3 -> L4)" and no plain Add, its form posts future=1; an unrelated skill keeps both buttons
  * after the next-level add the tab shows one "L3 -> L4" line
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Competency add: one current line per competency, next level above it")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA_ADMIN, EMP = H.actors(a)
BG = "ZZAL Group"
UNAME = "ZZ AL One"


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9AL-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM tc_assignments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM tc_skills WHERE title LIKE 'ZZAL %'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


SK = {}
with a.app.app_context():
    db = a.get_db()
    _cleanup(db)
    CID = a.active_cycle_id(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'UD')", (BG,))
    for lvl in (3, 4, 5):
        SK[lvl] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, active) "
                             "VALUES (?, 'ZZAL Planning', ?, 'TSC', 'ZZAL Cat', 1)",
                             ("ZQN-PLN-%d001-1.1" % lvl, lvl)).lastrowid
    SK["o"] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, active) "
                         "VALUES ('ZQN-OTH-3002-1.1', 'ZZAL Unrelated', 3, 'TSC', 'ZZAL Cat', 1)").lastrowid
    UID = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                     "job_grade, confirmation_date) VALUES ('zz9al-1', ?, 'x', 'user', 'ZZ9AL-1', ?, 'UD', '16', "
                     "'2020-01-01')", (UNAME, BG)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
PERSON = "/admin/users/%d?tab=competency" % UID
POST = "/admin/users/%d/competency" % UID
FIND = "/admin/users/%d/competency/find" % UID


def hold(cur=(), fut=()):
    """Put the person's list back to exactly these levels of the Planning competency."""
    with a.app.app_context():
        d = a.get_db()
        d.execute("DELETE FROM tc_assignments WHERE subject_id=?", (UID,))
        for i, (lvl, f) in enumerate([(l, 0) for l in cur] + [(l, 1) for l in fut]):
            d.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, seq, source) "
                      "VALUES (?,?,?,?,?, 'profile')", (CID, UID, SK[lvl], f, i + 1))
        d.commit()


def rows():
    with a.app.app_context():
        return sorted((r[0], r[1]) for r in a.get_db().execute(
            "SELECT skill_id, is_future FROM tc_assignments WHERE subject_id=?", (UID,)))


def add(lvl, fut, with_next=False):
    d = {"csrf_token": "tok", "action": "add", "skill_id": str(SK[lvl])}
    if fut:
        d["future"] = "1"
    if with_next:
        d["with_next"] = "1"
    return SUP.post(POST, data=d, follow_redirects=True).get_data(as_text=True)


def flat(t):
    return t.replace("&#39;", "'").replace("&rarr;", "\u2192")


def check_case(label, cur, fut, lvl, as_fut, refused):
    """refused = a fragment of the flash, or None when it must go through; a refusal writes nothing."""
    hold(cur, fut)
    before = rows()
    pg = flat(add(lvl, as_fut))
    after = rows()
    if refused:
        s.check("%s: refused (%s)" % (label, refused), refused in pg and after == before)
    else:
        s.check("%s: goes through" % label, after != before and len(after) == len(before) + 1)


def run_cases():
    check_case("current: holds L3, add L4", [3], [], 4, False,
               "%s already holds ZZAL Planning at L3. Add L4 as their next level instead (For their future role)." % UNAME)
    check_case("current: holds L3, add L5", [3], [], 5, False, "Add L5 as their next level instead")
    check_case("current: holds L4, add L3", [4], [], 3, False, "%s already holds ZZAL Planning at L4 as a current competency." % UNAME)
    check_case("current: holds L3 and L4 as next, add L5", [3], [4], 5, False, "already holds ZZAL Planning at L3")
    check_case("current: holds nothing", [], [], 3, False, None)
    check_case("current: holds only a next level L4, add L3", [], [4], 3, False, None)
    check_case("current: an unrelated skill beside L3", [3], [], "o", False, None)
    check_case("next: has a next level L4, add L5", [], [4], 5, True, "%s already has ZZAL Planning L4 as their next level." % UNAME)
    check_case("next: holds L3 and L4 next, add L5", [3], [4], 5, True, "already has ZZAL Planning L4 as their next level")
    check_case("next: holds L4, add L4's level 3", [4], [], 3, True, "A next level must be above their current L4")
    check_case("next: holds exactly this skill as current", [4], [], 4, True, "already has ZZAL Planning L4")
    check_case("next: holds L3, add L4", [3], [], 4, True, None)
    check_case("next: holds L3, add L5 (two up)", [3], [], 5, True, None)
    check_case("next: holds nothing, a new competency as the next step", [], [], 4, True, None)
    check_case("next: an unrelated skill beside L3", [3], [], "o", True, None)


try:
    s.section("the server guard, every rule")
    run_cases()

    s.section("falsify: with the guard call removed the refused adds go through")
    real = a._tc_add_level_problem
    a._tc_add_level_problem = lambda *x, **k: None
    try:
        for label, cur, fut, lvl, as_fut in (("L3 held, add L4 as current", [3], [], 4, False),
                                             ("L3 held, add L3-level duplicate family as current", [3], [], 5, False),
                                             ("L4 held, add L3 as next", [4], [], 3, True),
                                             ("L4 next held, add L5 as next", [], [4], 5, True)):
            hold(cur, fut)
            n0 = len(rows())
            add(lvl, as_fut)
            s.check("guard off, %s: it is added (so the guard is what stops it)" % label, len(rows()) == n0 + 1)
    finally:
        a._tc_add_level_problem = real
    hold([3], [])
    s.check("guard back on: refused again", len(rows()) == 1 and (add(4, False), len(rows()))[1] == 1)
    with a.app.app_context():
        _d = a.get_db()
        s.check("the function itself answers a message or None",
                a._tc_add_level_problem(_d, CID, UID, _d.execute("SELECT * FROM tc_skills WHERE id=?", (SK[4],)).fetchone(), 0) is not None
                and a._tc_add_level_problem(_d, CID, UID, _d.execute("SELECT * FROM tc_skills WHERE id=?", (SK[4],)).fetchone(), 1) is None)

    s.section("the find list never offers what the server refuses")
    q = "&sq=ZZAL+Planning"
    hold([3], [])
    box = SUP.get(PERSON + q).get_data(as_text=True)
    rows_ = {int(m.group(1)): m.group(0) for m in re.finditer(r'<div class="pp-lr" data-sid="(\d+)">.*?</form>\s*</div>', box, re.S)}
    r4 = flat(rows_[SK[4]])
    s.check("holds L3: the L4 row reads Add as their next level (L3 -> L4)", "Add as their next level (L3 → L4)" in r4)
    s.check("holds L3: the L4 row has no plain Add, and its form posts future=1",
            "data-cd-rowadd" not in r4 and 'name="future" value="1"' in r4 and 'name="action" value="add"' in r4
            and 'name="csrf_token"' in r4 and 'value="%d"' % SK[4] in r4)
    s.check("holds L3: its confirm names the L3 and the L4 in the existing style",
            "Add ZZAL Planning L4 to %s as the next level of their L3?" % UNAME in r4 and 'data-confirm-ok="Add as next level"' in r4)
    s.check("holds L3: the L3 row says They have it, no buttons", "They have it" in rows_[SK[3]] and "<button" not in re.sub(r'<button type="button" class="pp-nm".*?</button>', "", rows_[SK[3]], flags=re.S))
    s.check("holds L3: the L5 row also offers the next level only (L3 -> L5)", "(L3 → L5)" in rows_[SK[5]] and "data-cd-rowadd" not in rows_[SK[5]])
    full = SUP.get(PERSON + "&sq=ZZAL+Unrelated").get_data(as_text=True)
    s.check("an unrelated skill still shows both buttons",
            "data-cd-rowadd" in full and "For their future role" in full and "data-lib-note" not in full)
    hold([], [])
    none = SUP.get(PERSON + q).get_data(as_text=True)
    s.check("holding nothing: every row has Add (or L-only) and For their future role; no notes",
            len(re.findall(r'<button type="submit" class="btn-link" data-cd-rowadd', none)) == 3
            and len(re.findall(r'data-cd-rowfuture', none)) == 3 and "data-lib-note" not in none)
    hold([3], [4])
    pair = {int(m.group(1)): flat(m.group(0)) for m in re.finditer(r'<div class="pp-lr" data-sid="(\d+)">.*?</form>\s*</div>',
                                                                  SUP.get(PERSON + q).get_data(as_text=True), re.S)}
    s.check("holds L3 -> L4: L5 shows a muted reason and no button; L4 says They have it as their next level",
            "They hold L3 → L4" in pair[SK[5]] and "data-cd-rowadd" not in pair[SK[5]] and "data-cd-rowfuture" not in pair[SK[5]]
            and "They have it as their next level" in pair[SK[4]])
    hold([5], [])
    low = {int(m.group(1)): flat(m.group(0)) for m in re.finditer(r'<div class="pp-lr" data-sid="(\d+)">.*?</form>\s*</div>',
                                                                 SUP.get(PERSON + q).get_data(as_text=True), re.S)}
    s.check("holds L5: L3 shows 'They hold L5 now' and no button", "They hold L5 now" in low[SK[3]] and "data-cd-rowfuture" not in low[SK[3]] and "data-cd-rowadd" not in low[SK[3]])
    hold([], [4])
    fo = {int(m.group(1)): flat(m.group(0)) for m in re.finditer(r'<div class="pp-lr" data-sid="(\d+)">.*?</form>\s*</div>',
                                                                SUP.get(PERSON + q).get_data(as_text=True), re.S)}
    s.check("only a next level L4: L5 keeps Add, withholds the next-level button with a reason",
            "data-cd-rowadd" in fo[SK[5]] and "data-cd-rowfuture" not in fo[SK[5]] and "Already their next level (L4)" in fo[SK[5]])
    # every shown button agrees with the server: press each one offered, for each state
    ok = True
    for cur, fut in (([3], []), ([], []), ([3], [4]), ([5], []), ([], [4]), ([4], [])):
        hold(cur, fut)
        box = SUP.get(FIND + "?kind=skills&q=ZZAL+Planning").get_data(as_text=True)
        for sid, blk in ((int(m.group(1)), m.group(0)) for m in re.finditer(r'<div class="pp-lr" data-sid="(\d+)">.*?</form>\s*</div>', box, re.S)):
            lvl = next(k for k, v in SK.items() if v == sid)
            for as_fut, marker in ((False, "data-cd-rowadd"), (True, "data-cd-rowfuture")):
                if marker in blk:
                    hold(cur, fut)
                    n0 = len(rows())
                    add(lvl, as_fut)
                    ok = ok and len(rows()) == n0 + 1
    s.check("every button the list shows is accepted by the server (6 states x each button)", ok)

    s.section("Add with next level: the suggestion and the write")
    hold([], [])
    rw = {int(m.group(1)): flat(m.group(0)) for m in re.finditer(r'<div class="pp-lr" data-sid="(\d+)">.*?</form>\s*</div>',
                                                               SUP.get(PERSON + q).get_data(as_text=True), re.S)}
    r3 = rw[SK[3]]
    s.check("an unheld L3 with an L4 in the library offers Add with next level (L3 -> L4), L3 only, and For their future role",
            "Add with next level (L3 \u2192 L4)" in r3 and "L3 only" in r3 and "For their future role" in r3
            and 'name="with_next" value="1"' in r3 and 'data-confirm-ok="Add L3 \u2192 L4"' in r3)
    s.check("its confirm names both levels and the L4 code, in the existing style",
            "Add ZZAL Planning L3 to %s, with L4 (ZQN-PLN-4001-1.1) as their next level? They see it at once and it goes in the trail." % UNAME in r3)
    s.check("a top-level skill (L5) and an unrelated one (no L+1) show today's Add and For their future role",
            "with_next" not in rw[SK[5]] and "data-cd-rowadd" in rw[SK[5]] and "L5 only" not in rw[SK[5]]
            and "with_next" not in flat(SUP.get(PERSON + "&sq=ZZAL+Unrelated").get_data(as_text=True)))
    hold([], [])
    pg = flat(add(3, False, True))
    s.check("with_next adds L3 current and L4 next, consecutive seq, one flash",
            "Added ZZAL Planning L3 \u2192 L4." in pg and len(rows()) == 2)
    with a.app.app_context():
        _d = a.get_db()
        _sq = [(r[0], r[1]) for r in _d.execute("SELECT is_future, seq FROM tc_assignments WHERE subject_id=? ORDER BY seq", (UID,))]
        _lg = _d.execute("SELECT COUNT(*) FROM activity_log WHERE target_user_id=? AND action='tc_person_add' AND detail LIKE "
                          "'%added ZZAL Planning L3 with L4 (ZQN-PLN-4001-1.1) as their next level%'", (UID,)).fetchone()[0]
        _tcv = a._person_competency(_d, _d.execute("SELECT * FROM users WHERE id=?", (UID,)).fetchone(), CID, True)
    s.check("current first, next second, seq 1 and 2; one log line; the tab shows one L3 -> L4 line",
            _sq == [(0, _sq[0][1]), (1, _sq[0][1] + 1)] and _lg == 1 and len(_tcv["lines"]) == 1
            and _tcv["lines"][0]["level"] == "L3 \u2192 L4")
    hold([], [])
    pg = flat(add(5, False, True))
    s.check("with_next on a top-level skill refuses and writes nothing", "no next level in the library" in pg and rows() == [])
    hold([], [5])
    before = rows()
    pg = flat(add(3, False, True))
    s.check("with_next when they already hold a future of it refuses and writes nothing",
            "already has ZZAL Planning L5 as their next level" in pg and rows() == before)
    hold([], [4])
    before = rows()
    pg = flat(add(3, False, True))
    s.check("with_next when they already hold that L4 refuses and writes nothing", "already has ZZAL Planning L4" in pg and rows() == before)
    hold([4], [])
    before = rows()
    add(3, False, True)
    s.check("with_next when they hold a current of it refuses and writes nothing", rows() == before)
    hold([], [])
    add(3, False, False)
    s.check("L3 only still adds just L3", len(rows()) == 1)
    real = a._tc_add_level_problem
    a._tc_add_level_problem = lambda *x, **k: None
    try:
        hold([], [5])
        add(3, False, True)
        s.check("guard off on the with_next path: it goes through (so the guard is what refuses)", len(rows()) == 3)
    finally:
        a._tc_add_level_problem = real
    hold([], [5])
    add(3, False, True)
    s.check("guard on again: refused", len(rows()) == 1)

    s.section("after the next-level add the tab shows one line")
    hold([3], [])
    add(4, True)
    pg = flat(SUP.get(PERSON).get_data(as_text=True))
    s.check("one 'L3 -> L4' line, not two rows", "L3 → L4" in pg and pg.count("ZZAL Planning") >= 1
            and len(re.findall(r'class="[^"]*pp-crow[^"]*"[^>]*>(?:(?!</tr>).)*ZZAL Planning', pg, re.S)) <= 1)
finally:
    with a.app.app_context():
        _db = a.get_db()
        _cleanup(_db)

sys.exit(s.done())
