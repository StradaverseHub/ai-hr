"""The technical-competency progress count ignores orphaned scores.

WHY
---
Staging carried 446 rows in tc_scores whose tc_assignments parent had been
deleted -- 84% of the table -- left by a seeder running on a raw connection
where SQLite defaults foreign_keys OFF, so the schema's ON DELETE CASCADE was
inert.

The employee-side count did `COUNT(*) FROM tc_scores WHERE assessment_id=?`,
with no join, so it counted them. Measured on the VM: a subject with 10
competencies and ZERO answers counted 14, `done >= total`, and the submit gate
opened on an empty assessment. Two others counted 220 and 230 against a total
of 10, which the autosave endpoint returned to the browser as "answered".

The orphans are demo-only and the source is closed, but the COUNT was wrong BY
CONSTRUCTION -- correct only on a database that happens to be clean. This suite
holds the construction, not the cleanliness: it MAKES an orphan and requires the
count to ignore it.

It writes, so it takes a fresh database copy.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Technical competency -- progress ignores orphaned scores")
SU, _BG, _EMP = H.actors(a)


def rowcount(sql, args=()):
    return H.one(a, sql, args)


s.section("the helper exists and is the only implementation")
s.check("_tc_progress present", hasattr(a, "_tc_progress"))
SRC = H.code_without_docstrings(H.source(a))
# The dangerous form: counting tc_scores by assessment alone.
s.check("no unjoined read of tc_scores anywhere in the code",
        "FROM tc_scores WHERE assessment_id" not in SRC)
# Count CALLS, not the definition -- "def _tc_progress(db," matches the same text.
# Originally 2 (the autosave counter + the submit gate); the competency chat agent
# (2026-09-04) added more callers (_tc_context, set_competency, _tc_submit), all
# routing through the ONE helper -- which is the point. So assert every site uses it
# (>= the original two) rather than a brittle exact count; the no-unjoined-read lint
# above is what actually guards against a divergent re-implementation.
_calls = SRC.count("_tc_progress(db,") - SRC.count("def _tc_progress(db,")
s.check("the employee-side sites all route through the one helper", _calls >= 2, _calls)

s.section("build a subject with competencies, answers, and an orphan")
with a.app.app_context():
    db = a.get_db()
    cid = a.active_cycle_id(db)
    # A subject who has no technical assignments yet, so the numbers are ours.
    subj = db.execute(
        "SELECT u.* FROM users u WHERE u.role!='admin' AND u.left_at IS NULL "
        "AND NOT EXISTS(SELECT 1 FROM tc_assignments t WHERE t.subject_id=u.id) "
        "LIMIT 1").fetchone()
    other = db.execute(
        "SELECT u.* FROM users u WHERE u.role!='admin' AND u.left_at IS NULL "
        "AND u.id!=? LIMIT 1", (subj["id"],)).fetchone()
    # FIVE distinct skills: four live plus one for the ghost. tc_assignments is
    # UNIQUE(cycle_id, subject_id, skill_id), so the ghost cannot reuse one.
    skills = [r["id"] for r in db.execute("SELECT id FROM tc_skills ORDER BY id LIMIT 5")]
    if len(skills) < 5:
        for i in range(5 - len(skills)):
            skills.append(db.execute(
                "INSERT INTO tc_skills(skill_code, title, level, skill_category) "
                "VALUES (?,?,?,?)",
                ("ZZTEST%d" % i, "Test skill %d" % i, 1, "Test")).lastrowid)
    asm = db.execute(
        "INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?,'pending')",
        (cid, subj["id"])).lastrowid
    live = []
    for seq, sk in enumerate(skills[:4], 1):
        live.append(db.execute(
            "INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, seq, "
            "source) VALUES (?,?,?,0,?,'test')", (cid, subj["id"], sk, seq)).lastrowid)
    # Answer exactly TWO of the four.
    for aid in live[:2]:
        db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer) "
                   "VALUES (?,?,'yes')", (asm, aid))
    # THE ORPHAN: an assignment, a score against it, then delete the assignment
    # with foreign_keys OFF -- reproducing exactly what the seeder did.
    ghost = db.execute(
        "INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, seq, source) "
        "VALUES (?,?,?,0,99,'test')", (cid, subj["id"], skills[4])).lastrowid
    db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer) "
               "VALUES (?,?,'yes')", (asm, ghost))
    # COMMIT FIRST. `PRAGMA foreign_keys` is a NO-OP inside an open transaction,
    # so without this the pragma is ignored, the DELETE cascades, and the orphan
    # this suite exists to create is silently removed -- the test then passes for
    # the wrong reason. (Which is also the shape of the original bug: a pragma
    # that did not take.)
    db.commit()
    db.execute("PRAGMA foreign_keys = OFF")
    db.execute("DELETE FROM tc_assignments WHERE id=?", (ghost,))
    db.commit()
    db.execute("PRAGMA foreign_keys = ON")
    # And a score filed against ANOTHER subject's assignment, same assessment.
    other_asg = db.execute(
        "INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, seq, source) "
        "VALUES (?,?,?,0,1,'test')", (cid, other["id"], skills[1])).lastrowid
    db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer) "
               "VALUES (?,?,'yes')", (asm, other_asg))
    db.commit()

s.note("subject %s: 4 live competencies, 2 answered, +1 orphan, +1 cross-subject score"
       % subj["employee_id"])
s.check("the orphan really is orphaned",
        rowcount("SELECT COUNT(*) FROM tc_scores sc LEFT JOIN tc_assignments t "
                 "ON t.id=sc.assignment_id WHERE sc.assessment_id=? AND t.id IS NULL",
                 (asm,)) == 1)
s.check("the naive count would say 4", rowcount(
    "SELECT COUNT(*) FROM tc_scores WHERE assessment_id=? AND answer IS NOT NULL",
    (asm,)) == 4, rowcount("SELECT COUNT(*) FROM tc_scores WHERE assessment_id=? "
                           "AND answer IS NOT NULL", (asm,)))

s.section("what _tc_progress actually reports")
with a.app.app_context():
    done, total = a._tc_progress(a.get_db(), cid, subj["id"], asm)
s.note("_tc_progress -> done=%d total=%d" % (done, total))
s.check("total is the live competency count", total == 4, total)
s.check("done is 2 -- the orphan is NOT counted", done == 2, done)
s.check("...nor is the cross-subject score", done == 2, done)
# The defect exactly: naive 4 >= total 4 would have opened the gate.
s.check("done < total, so the gate must REFUSE", done < total)

s.section("the gate refuses, and says the right number")
E = H.client_as(a, subj["id"])
r = E.post("/technical/submit", data={"csrf_token": "tok"}, follow_redirects=True)
body = r.get_data(as_text=True)
s.check("submit does not go through",
        H.one(a, "SELECT status FROM tc_assessments WHERE id=?", (asm,)) == "pending",
        H.one(a, "SELECT status FROM tc_assessments WHERE id=?", (asm,)))
s.check("it names 2 still blank, not 0", "2 still blank" in body,
        [l.strip() for l in body.splitlines() if "still blank" in l][:1])

s.section("both call sites agree")
# They must not be able to disagree -- that is why there is one helper.
r = E.post("/technical/autosave", data={"csrf_token": "tok",
                                        "assignment_id": str(live[2]), "answer": "yes"})
j = r.get_json() or {}
s.check("autosave answers", r.status_code == 200 and j.get("ok"), (r.status_code, j))
with a.app.app_context():
    done2, total2 = a._tc_progress(a.get_db(), cid, subj["id"], asm)
s.check("the endpoint's counter == the helper", (j.get("answered"), j.get("total")) == (done2, total2),
        ((j.get("answered"), j.get("total")), (done2, total2)))
s.check("answering a third moves it to 3 of 4", (done2, total2) == (3, 4), (done2, total2))

s.section("answer the last one and the gate opens")
E.post("/technical/autosave", data={"csrf_token": "tok",
                                    "assignment_id": str(live[3]), "answer": "no"})
r = E.post("/technical/submit", data={"csrf_token": "tok"}, follow_redirects=True)
s.check("now it submits",
        H.one(a, "SELECT status FROM tc_assessments WHERE id=?", (asm,)) == "submitted",
        H.one(a, "SELECT status FROM tc_assessments WHERE id=?", (asm,)))

s.section("the orphan was never touched -- this is a READ fix, not a cleanup")
s.check("the orphaned score row still exists",
        rowcount("SELECT COUNT(*) FROM tc_scores sc LEFT JOIN tc_assignments t "
                 "ON t.id=sc.assignment_id WHERE sc.assessment_id=? AND t.id IS NULL",
                 (asm,)) == 1)

sys.exit(s.done())
