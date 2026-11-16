"""The Matrix manager chip counts only lines someone moderates (Chris, 4 Nov 2026: "Fix the chip").

A line Group People owns is never moderated: a BU-level line (a company-wide figure like PAT, by name) or a line with an
HR-filled result (pm_kpi_results.admin_filled=1) is final the moment it is filled. `_person_roles` (the admin person
page's chip, the person views' "Matrix manager of N KPIs") reads `_matrix_moderated_lines`, which leaves those out.

What this suite holds, in the active cycle, for a matrix manager X of a subject whose line manager is someone else:
  * a normal personal line is counted; an admin_filled line is not; a BU-level-by-name line is not
  * falsified: the admin_filled line counts once admin_filled=0; the BU-level line counts once its library row is not BU-level
  * a subject whose line manager IS X is never counted
  * the admin person page's chip says the same count (and is absent at 0)
"""
import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The Matrix manager chip: only lines someone moderates")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, DEPT = "ZZMX Group", "ZZMX Unit", "ZZMX Dept"
RATES = (10, 20, 30, 40, 50)


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9MX-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE subject_id "
                   "IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets WHERE "
                   "subject_id IN (%s))" % ph, ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (BG,))
    db.commit()


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    LIB = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, "
                     "category, unit, method, bu_level, active) VALUES (?, '*', '*', 0, '*', 'ZZMX Unit PAT', 'F', "
                     "'RM', 'more', 1, 1)", (BG,)).lastrowid

    def mk(eid, name, mgr=None):
        return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                          "company, department, job_title, job_grade, confirmation_date, manager_id) VALUES (?,?, 'x', "
                          "'user', ?,?,?,?, 'ZZ Analyst', '14', '2020-01-01', ?)",
                          (eid.lower(), name, eid, BG, CO, DEPT, mgr)).lastrowid
    M = mk("ZZ9MX-M", "ZZ MX Manager")
    X = mk("ZZ9MX-X", "ZZ MX Matrix")
    P = mk("ZZ9MX-P", "ZZ MX Person", M)       # line manager is M, not X
    W = mk("ZZ9MX-W", "ZZ MX Report", X)       # line manager IS X
    db.commit()
SUP = H.client_as(a, SU["id"])


def line(subject, name, approver=None, filled=None):
    """A one-step matrix line on `subject`; `filled` = admin_filled flag of a result (None = no result)."""
    with a.app.app_context():
        db = a.get_db()
        t = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, rate1, rate2, rate3, "
                       "rate4, rate5, business_group, company, department) VALUES (?,?,?,20,'more',?,?,?,?,?,?,?,?)",
                       (CID, subject, name) + RATES + (BG, CO, DEPT)).lastrowid
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)",
                   (t, approver or X))
        if filled is not None:
            db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, admin_filled) VALUES (?,?,?)",
                       (t, 5, filled))
        db.commit()
        return t


def roles():
    with a.app.app_context():
        db = a.get_db()
        p = db.execute("SELECT * FROM users WHERE id=?", (X,)).fetchone()
        r = a._person_roles(db, p, CID)
        return r["matrix_kpis"], r["matrix_people"]


def chip():
    t = html.unescape(SUP.get("/admin/users/%d" % X).get_data(as_text=True))
    m = re.search(r"Matrix manager · (\d+) KPI", t)
    return int(m.group(1)) if m else 0


try:
    s.section("The base: nothing yet")
    base_k, base_p = roles()
    s.check("a matrix manager with no lines has a zero count and no chip", base_k == 0 and base_p == 0 and chip() == 0,
            "%s %s" % (base_k, base_p))

    s.section("A personal line is counted; an HR-owned one is not")
    t_a = line(P, "ZZMX Personal")
    s.check("(a) a normal personal line is counted: one line, one person", roles() == (base_k + 1, base_p + 1), str(roles()))
    s.check("...and the admin person page's chip says the same", chip() == base_k + 1, str(chip()))
    t_b = line(P, "ZZMX Filled", filled=1)
    s.check("(b) a line with an HR-filled result is not counted", roles() == (base_k + 1, base_p + 1), str(roles()))
    t_c = line(P, "zzmx  UNIT   pat")
    s.check("(c) a line whose name is BU-level for the subject (any case or spacing) is not counted",
            roles() == (base_k + 1, base_p + 1), str(roles()))
    s.check("...the chip still matches", chip() == base_k + 1, str(chip()))

    s.section("Falsify the guards")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE pm_kpi_results SET admin_filled=0 WHERE kpi_target_id=?", (t_b,))
        db.commit()
    s.check("(b) with admin_filled=0 the line is counted", roles() == (base_k + 2, base_p + 1), str(roles()))
    s.check("...and the chip follows", chip() == base_k + 2, str(chip()))
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE pm_kpi_results SET admin_filled=1 WHERE kpi_target_id=?", (t_b,))
        db.execute("UPDATE pm_kpi_library SET bu_level=0 WHERE id=?", (LIB,))
        db.commit()
    s.check("(c) with the library row no longer BU-level the line is counted", roles() == (base_k + 2, base_p + 1),
            str(roles()))
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE pm_kpi_library SET bu_level=1 WHERE id=?", (LIB,))
        db.commit()

    s.section("A line manager's own report is never the matrix manager's")
    line(W, "ZZMX Own report")
    s.check("a subject whose line manager is X adds nothing", roles() == (base_k + 1, base_p + 1), str(roles()))

    s.section("More people count as people")
    P2 = None
    with a.app.app_context():
        db = a.get_db()
        P2 = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                        "company, department, job_title, job_grade, confirmation_date, manager_id) VALUES "
                        "('zz9mx-p2','ZZ MX Person 2','x','user','ZZ9MX-P2',?,?,?,'ZZ Analyst','14','2020-01-01',?)",
                        (BG, CO, DEPT, M)).lastrowid
        db.commit()
    line(P2, "ZZMX Second")
    line(P2, "ZZMX Second b")
    s.check("two lines on a second person: lines add two, people add one",
            roles() == (base_k + 3, base_p + 2), str(roles()))
    s.check("...and the chip says 3 KPIs", chip() == base_k + 3, str(chip()))
finally:
    with a.app.app_context():
        db = a.get_db()
        _cleanup(db)

sys.exit(s.done())
