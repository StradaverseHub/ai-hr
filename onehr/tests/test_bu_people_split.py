"""BU CEOs tab: the People count's breakdown (info icon) -- 2026-10-27, Chris.

The count stays the unit's headcount. When someone in it is not in the review, an info icon beside it says who:
"29 in the review, 35 on IDP user, 2 not confirmed, Total 66". The parts come from ONE grouped read that mirrors
participation()'s order, so they add up to the shown count and "in the review" equals calibration_population_sql().

What it holds:
  * no icon when everyone in the count is in the review
  * with an unconfirmed person, a no-review role, a grade below the floor, a person taken out and a left-out department:
    each is a part with its own words (a role by its name), in the review first, Total last, every part non-zero
  * the parts sum to the shown count; "in the review" equals a direct calibration_population_sql() count of the unit
  * participation() agrees person by person with the SQL (so the two can't drift)
  * giving a person a no-review role moves them from "in the review" to the role's part; the count does not change
  * falsified: a broken sum is caught by the same check
"""
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("BU CEOs tab: People count breakdown")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG = "ZZBPS Group"
CO = "ZZBPS Alpha"
ROLE = "ZZBPS IDP only"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9BPS-%'")]
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM cycle_exclusions WHERE business_group=?", (BG,))
    db.execute("DELETE FROM user_role_modules WHERE role_id IN (SELECT id FROM user_roles WHERE name=?)", (ROLE,))
    db.execute("DELETE FROM user_roles WHERE name=?", (ROLE,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, dept, grade="15", confirmed=True, role_id=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, is_demo, confirmation_date, user_role_id) "
                      "VALUES (?,?, 'x', 'user', ?,?,?,?, 'ZZBPS Officer', ?, 0, ?, ?)",
                      (eid.lower(), "ZZ Bps " + eid[-4:], eid, BG, CO, dept, grade,
                       "2020-01-01" if confirmed else None, role_id)).lastrowid


with a.app.app_context():
    db = a.get_db()
    _cleanup(db)
    cyc = a.active_cycle(db)
    assert cyc, "the harness copy needs an active cycle"
    saved = (cyc["id"], cyc["min_job_grade"])
    db.execute("UPDATE cycles SET min_job_grade=12 WHERE id=?", (cyc["id"],))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    db.execute("INSERT INTO user_roles(name) VALUES (?)", (ROLE,))
    RID = db.execute("SELECT id FROM user_roles WHERE name=?", (ROLE,)).fetchone()[0]
    db.execute("INSERT INTO user_role_modules(role_id, module) VALUES (?, 'idp')", (RID,))
    U = {}
    for tag, kw in (("IN1", {}), ("IN2", {}), ("IN3", {}), ("NC1", {"confirmed": False}), ("NC2", {"confirmed": False}),
                    ("RL1", {"role_id": RID}), ("RL2", {"role_id": RID}), ("RL3", {"role_id": RID}),
                    ("LOW", {"grade": "8"}), ("OUT", {}), ("DEP", {})):
        U[tag] = person(db, "ZZ9BPS-" + tag, "ZZBPS Gone" if tag == "DEP" else "ZZBPS Dept", **kw)
    db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?, 'remove')", (cyc["id"], U["OUT"]))
    db.execute("INSERT INTO cycle_exclusions(cycle_id, business_group, company, department) VALUES (?,?,?,?)",
               (cyc["id"], BG, CO, "ZZBPS Gone"))
    db.commit()

C_SU = H.client_as(a, SU["id"])


def page():
    return html.unescape(C_SU.get("/admin/leaders?tab=buceo&bg=" + BG.replace(" ", "+")).get_data(as_text=True))


def people_cell(pg):
    m = re.search(r'<tr class="data-row[^"]*" data-bu="%s".*?</td>\s*<td>(.*?)</td>' % re.escape(CO), pg, re.S)
    return m.group(1) if m else ""


def read_cell(cell):
    """(shown count, [parts], total) from the People cell."""
    n = int(re.match(r"\s*(?:<span class=\"ld-pn\">)?\s*(\d+)", cell).group(1))
    body = re.search(r'<span class="info-tip-body">(.*?</b></span>)', cell, re.S)
    if not body:
        return n, None, None
    txt = re.sub(r"<[^>]+>", "", body.group(1))
    segs = [x.strip() for x in txt.split("·")]
    total = int(re.match(r"Total (\d+)", segs[-1]).group(1))
    return n, segs[:-1], total


def sum_ok(n, parts, total):
    """The guard: the parts add up to the shown count and to the Total."""
    return sum(int(p.split()[0]) for p in parts) == n == total


def direct_in(db):
    return db.execute("SELECT COUNT(*) FROM users WHERE business_group=? AND company=? AND role!='admin' AND "
                      + a.calibration_population_sql(), (BG, CO)).fetchone()[0]


try:
    pg = page()
    n, parts, total = read_cell(people_cell(pg))
    with a.app.app_context():
        db = a.get_db()
        head = db.execute("SELECT COUNT(*) FROM users WHERE business_group=? AND company=? AND role!='admin' AND left_at "
                          "IS NULL AND COALESCE(is_demo,0)=0", (BG, CO)).fetchone()[0]
        in_direct = direct_in(db)
    s.section("the count and its icon")
    s.check("the number is still the headcount", n == head == len(U), (n, head))
    s.check("the icon is there, keyboard-focusable", 'class="info-tip ld-pn-tip" tabindex="0"' in people_cell(pg))
    s.check("parts found", parts is not None and len(parts) >= 3, parts)
    s.check("the parts sum to the shown count and to Total", sum_ok(n, parts, total), (n, parts, total))
    s.check("in the review comes first and equals a direct calibration_population_sql() count",
            parts[0] == "%d in the review" % in_direct, (parts, in_direct))
    s.check("every part is non-zero and in its own words (a role by its name)",
            all(int(p.split()[0]) > 0 for p in parts)
            and "3 on %s" % ROLE in parts and "2 not confirmed" in parts and "1 taken out" in parts
            and "1 below the cycle's job grade" in parts and "1 unit or department left out" in parts, parts)
    s.check("Total is last", re.search(r"Total %d</b>" % n, people_cell(pg)) is not None)

    s.section("participation() agrees with the SQL, person by person")
    with a.app.app_context():
        db = a.get_db()
        split = a._headcount_split_rows(db, BG)
        want = {"IN1": "in", "NC1": "not_confirmed", "RL1": "role", "LOW": "below_min_grade", "OUT": "removed",
                "DEP": "unit_out"}
        got = {t: split[U[t]][1] for t in want}
        s.check("each kind of person lands in the part participation() names", got == want, got)
        for tag in U:
            u = db.execute("SELECT * FROM users WHERE id=?", (U[tag],)).fetchone()
            tp, why = a.participation(db, u)
            s.check("%s: in the review iff participation() says taking part" % tag, (split[U[tag]][1] == "in") == tp, why)

    s.section("giving a person a no-review role moves them from the review to the role's part")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET user_role_id=? WHERE id=?", (RID, U["IN1"]))
        db.commit()
    n2, parts2, total2 = read_cell(people_cell(page()))
    s.check("the count is unchanged", n2 == n, (n, n2))
    s.check("one fewer in the review, one more on the role", parts2[0] == "%d in the review" % (in_direct - 1)
            and "4 on %s" % ROLE in parts2, parts2)
    s.check("still sums", sum_ok(n2, parts2, total2), parts2)
    with a.app.app_context():   # put it back
        db = a.get_db()
        db.execute("UPDATE users SET user_role_id=NULL WHERE id=?", (U["IN1"],))
        db.commit()

    s.section("falsify: a broken sum is caught")
    broken = [parts[0].replace(parts[0].split()[0], str(int(parts[0].split()[0]) + 1), 1)] + parts[1:]
    s.check("the guard fails when a part is off by one", not sum_ok(n, broken, total), broken)

    s.section("no icon when everyone is in the review")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE users SET user_role_id=NULL, confirmation_date='2020-01-01', job_grade='15' WHERE "
                   "employee_id LIKE 'ZZ9BPS-%'")
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZ9BPS-%')")
        db.execute("DELETE FROM cycle_exclusions WHERE business_group=?", (BG,))
        db.commit()
    cell = people_cell(page())
    s.check("a unit that is all in the review shows the bare number", "info-tip" not in cell and cell.strip() == str(len(U)), cell)
finally:
    with a.app.app_context():
        db = a.get_db()
        _cleanup(db)
        db.execute("UPDATE cycles SET min_job_grade=? WHERE id=?", (saved[1], saved[0]))
        db.commit()

sys.exit(s.done())
