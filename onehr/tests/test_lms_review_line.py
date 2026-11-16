"""AI+ Learning S12: Learning's line at the competency review (Chris, 2026-10-22: "ok, build all of it on staging";
board 4F).

What this suite holds:
  * the evidence: for each competency family, the latest learning the person's line manager confirmed -- applied at
    3 months (the programme, its dates, their example, the level confirmed) or learning on the job
  * the line manager's review card: the line on the level confirmed (else the next level), with the level, "evidence
    only"; nothing on a competency without confirmed learning
  * the person's own card: the same line without the level
  * only while Learning is on; written by the two cards' builders only, so never in calibration
Everything here is synthetic (ZZLR / ZZ9LR-) and removed at the end.
"""
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI+ Learning S12: Learning's line at the competency review")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG = "ZZLR Group"
_ENV0 = os.environ.get("ONEHR_LMS")


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LR-%'")]
    db.execute("DELETE FROM lms_programmes WHERE title LIKE 'ZZLR %'")
    if ul:
        ph = ",".join("?" * len(ul))
        for t in ("lms_registrations", "lms_ojt"):
            db.execute("DELETE FROM %s WHERE user_id IN (%s)" % (t, ph), ul)
        db.execute("DELETE FROM tc_assessments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM tc_assignments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZLR-%'")
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def person(db, eid, grade="15", mgr=None):
    return db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                      "department, job_title, job_grade, manager_id) VALUES (?,?, 'x', 'user', ?,?, 'ZZLR U1', "
                      "'ZZLR Sales', 'ZZLR Officer', ?, ?)", (eid.lower(), "ZZ LR " + eid.split("-")[1], eid, BG, grade,
                                                               mgr)).lastrowid


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'ZZLR U1')", (BG,))
    sk = {}
    for code, title in (("PRC001", "ZZLR Pricing"), ("STK002", "ZZLR Stakeholders"), ("DAT003", "ZZLR Data")):
        for lv in (3, 4):
            sk[(code, lv)] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, skill_category, "
                                        "proficiency_description, active) VALUES (?,?,?,?,?,?,1)",
                                        ("ZZLR-%s-%d%s-1.0" % (code[:3], lv, code[3:]), title, lv, "tsc", "ZZLR Cat",
                                         "%s at L%d." % (title, lv))).lastrowid
    K1, K2 = "ZZLR-PRC-001", "ZZLR-STK-002"
    M = person(db, "ZZ9LR-M", "18")
    E = person(db, "ZZ9LR-E", "15", mgr=M)
    CID = a.active_cycle_id(db)
    for i, (code, lv, fut) in enumerate((("PRC001", 3, 0), ("PRC001", 4, 1), ("STK002", 3, 0), ("STK002", 4, 1),
                                         ("DAT003", 3, 0))):
        db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id, is_future, seq) VALUES (?,?,?,?,?)",
                   (CID, E, sk[(code, lv)], fut, i))
    db.execute("INSERT INTO tc_assessments(cycle_id, subject_id, status) VALUES (?,?, 'submitted')", (CID, E))
    P = db.execute("INSERT INTO lms_programmes(title, kind, status) VALUES ('ZZLR Negotiation', 'inhouse', 'published')"
                   ).lastrowid
    db.execute("INSERT INTO lms_programme_competencies(programme_id, comp_key, level, confirmed) VALUES (?,?,4,1)", (P, K1))
    day = (a._today_myt() - timedelta(days=100)).isoformat()
    S = db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, seats) VALUES (?, 'ZZLR run', "
                   "?, ?, 10)", (P, day, day)).lastrowid
    R = db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, outcome) VALUES "
                   "(?,?,?, 'approved', '[]', 'attended')", (E, S, P)).lastrowid
    db.execute("INSERT INTO lms_evaluations(registration_id, kind, due_on, status, words_json, mgr_level, mgr_action, "
               "confirmed_by, confirmed_at) VALUES (?, 'm3', ?, 'confirmed', ?, 4, 'confirm', ?, datetime('now'))",
               (R, day, '{"changed": "I set the price bands myself.", "example": "Set the Southern dealers\' bands."}', M))
    # a 3-month check-in sent but not confirmed yet (ZZLR Data): never evidence
    P3 = db.execute("INSERT INTO lms_programmes(title, kind, status) VALUES ('ZZLR Data Course', 'inhouse', 'published')"
                    ).lastrowid
    db.execute("INSERT INTO lms_programme_competencies(programme_id, comp_key, level, confirmed) VALUES (?, "
               "'ZZLR-DAT-003', 3, 1)", (P3,))
    S3 = db.execute("INSERT INTO lms_sessions(programme_id, run_label, starts_on, ends_on, seats) VALUES (?, 'ZZLR run', "
                    "?, ?, 10)", (P3, day, day)).lastrowid
    R3 = db.execute("INSERT INTO lms_registrations(user_id, session_id, programme_id, status, chain_json, outcome) VALUES "
                    "(?,?,?, 'approved', '[]', 'attended')", (E, S3, P3)).lastrowid
    db.execute("INSERT INTO lms_evaluations(registration_id, kind, due_on, status, words_json, self_level) VALUES "
               "(?, 'm3', ?, 'self_done', '{\"example\": \"Built the dashboard.\"}', 3)", (R3, day))
    db.execute("INSERT INTO lms_ojt(user_id, kind, what, example, comp_key, status, manager_id, decided_by, decided_at) "
               "VALUES (?, 'others', 'Mentoring a new joiner', 'Went through two dealer quotes with her.', ?, 'confirmed', "
               "?, ?, datetime('now'))", (E, K2, M, M))
    db.commit()


def env(v):
    if v is None:
        os.environ.pop("ONEHR_LMS", None)
    else:
        os.environ["ONEHR_LMS"] = v


def mgr_card():
    with a.app.test_request_context():
        db = a.get_db()
        d = a._journey_team_tm_data(db, a._lms_user(db, M), E, "ZZ LR E")
    return {(it["title"], it["level"]): it for g in d["groups"] for it in g["items"]}


try:
    env("1")
    s.section("the evidence")
    with a.app.app_context():
        db = a.get_db()
        ev = a.lms_review_learning(db, a._lms_user(db, E))
    s.check("applied at 3 months: the programme, their example, the level confirmed", ev.get(K1, {}).get("title") ==
            "ZZLR Negotiation" and ev[K1]["level"] == 4 and ev[K1]["words"] == "Set the Southern dealers' bands.", ev)
    s.check("...learning on the job, as confirmed", ev.get(K2, {}).get("ojt") and ev[K2]["title"] ==
            "Mentoring a new joiner", ev.get(K2))

    s.section("the line manager's card")
    c = mgr_card()
    nxt = c[("ZZLR Pricing", "next")].get("learning")
    s.check("on the level confirmed (L4, the next level), with the level, evidence only", nxt and
            "You confirmed L4 on" in nxt["text"] and "ZZLR Negotiation" in nxt["text"] and
            "\u201cSet the Southern dealers' bands\u201d." in nxt["text"] and nxt["note"].startswith("Evidence only"), nxt)
    s.check("...not on its current level as well", "learning" not in c[("ZZLR Pricing", "current")])
    oj = c[("ZZLR Stakeholders", "next")].get("learning")
    s.check("learning on the job: on its next level", oj and oj["text"].startswith("Learned on the job: Mentoring"), oj)
    s.check("a competency without confirmed learning (a check-in not confirmed yet): nothing",
            "learning" not in c[("ZZLR Data", "current")])

    s.section("the person's own card")
    with a.app.app_context():
        db = a.get_db()
        groups = [{"items": [{"title": "ZZLR Pricing", "level": 3, "is_future": False},
                             {"title": "ZZLR Pricing", "level": 4, "is_future": True}]}]
        rk = {id(groups[0]["items"][0]): sk[("PRC001", 3)], id(groups[0]["items"][1]): sk[("PRC001", 4)]}
        a.lms_review_attach(db, a._lms_user(db, E), groups, rk, False)
    own = groups[0]["items"][1].get("learning")
    s.check("the same line without the level", own and own["text"] ==
            "You attended ZZLR Negotiation, and your line manager confirmed you applied it." and not own["note"]
            and not re.search(r"\bL\d\b", own["text"]), own)
    src = open(os.path.join(os.path.dirname(a.__file__), "app.py")).read()
    s.check("...the person's card builder puts it there", "lms_review_attach(db, u, groups, _rk, False)" in src)

    s.section("never in calibration; only while Learning is on")
    s.check("written by the two cards' builders only", [m.start() for m in re.finditer(r"lms_review_attach\(", src)]
            and len(re.findall(r"\n\s+lms_review_attach\(db, ", src)) == 2)
    env(None)
    c = mgr_card()
    s.check("Learning off: no line", all("learning" not in it for it in c.values()))
finally:
    env(_ENV0)
    with a.app.app_context():
        _cleanup(a.get_db())

sys.exit(s.done())
