"""Units and departments not taking part (Chris, 2026-10-21: "for CHGB, super admin wants to exclude stradaverse in the
year end review"; canvas [design canvas link removed]; "go with your suggestions and build it").

What this suite holds:
  * a rule per cycle (cycle_exclusions), the super admin's alone: everyone in the unit, or the named departments of it,
    is out of the cycle altogether -- no review of their own, not rated, rating nobody, moderating nobody
  * the rule reads live: a joiner to the unit is out with no step, and nobody in it is added back by hand
  * saving it archives their 360 rows both ways (kept, not counted) and moves the KPI lines nobody has acted on whose
    moderator is now out one level up; the competency and Career Plan reviews skip a left-out line manager
  * a left-out leader can do nothing a leader does (leader_can), and has no Team tab
  * Bring back removes the rule only: the archived rows and the moved lines stay
  * the Participants card, its side panel's preview and the double confirmation say all of this before it happens
Everything here runs on the scratch copy, on synthetic ZZUX people, and puts back what it changed.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Units and departments not taking part -- the cycle's rule, fully out")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, BGA, _E = H.actors(a)
BG, KEEP, OUT = "ZZUX Group", "ZZUX KEEP SDN BHD", "ZZUX OUT SDN BHD"


def _cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZUX-%'")]
    db.execute("DELETE FROM cycle_exclusions WHERE business_group=?", (BG,))
    if ids:
        ph = ",".join("?" * len(ids))
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids + ids)
        db.execute("DELETE FROM pm_kpi_target_approvers WHERE kpi_target_id IN (SELECT id FROM pm_kpi_targets "
                   "WHERE subject_id IN (%s))" % ph, ids)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM tc_assignments WHERE subject_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE target_user_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM activity_log WHERE action='participant_exclusion' AND detail LIKE '%ZZUX%'")
    db.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    CYC = dict(a.active_cycle(db))
    MG = CYC.get("min_job_grade")
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND COALESCE(is_demo,0)=0 "
                           "LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]
    grade = str(max(int(MG or 0), 14))

    def mk(eid, unit, mgr=None, dept="ZZ Ops"):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ " + eid, email=None, business_group=BG,
                 company=unit, department=dept, job_grade=grade, manager_id=mgr, hod_id=None, buceo_bg=None,
                 buceo_company=None, bgceo_bg=None, confirmation_date="2020-01-01", left_at=None, is_demo=0,
                 user_role_id=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v.get(c) for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    M0 = mk("ZZUX-M0", KEEP)                  # the manager one level up, taking part
    M1 = mk("ZZUX-M1", OUT, M0)               # a manager inside the unit left out
    E1 = mk("ZZUX-E1", KEEP, M1)              # their report OUTSIDE the unit: reviewed one level up, by M0
    E2 = mk("ZZUX-E2", OUT, M1)               # their report inside it: out
    E3 = mk("ZZUX-E3", OUT, M1, "ZZ Dept X")  # inside it, another department: for the department rule
    R1 = mk("ZZUX-R1", KEEP, M0)              # a peer, untouched
    E5 = mk("ZZUX-E5", KEEP, M1)              # another report outside the unit, with no KPI line: the skip-level alone
    _sk = db.execute("SELECT id FROM tc_skills LIMIT 1").fetchone()
    if _sk:   # a competency to review, so the competency review's own population can be checked
        db.execute("INSERT INTO tc_assignments(cycle_id, subject_id, skill_id) VALUES (?,?,?)", (CID, E5, _sk[0]))
    # a KPI line of E1's moderated by M1, nobody has acted on it
    db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company) "
               "VALUES (?,?,?,?,?,?,?)", (CID, E1, "ZZUX KPI", 100, "more", BG, KEEP))
    T1 = db.execute("SELECT id FROM pm_kpi_targets WHERE subject_id=? AND kpi_name='ZZUX KPI'", (E1,)).fetchone()[0]
    db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (T1, M1))
    # 360 rows: E2 rates E1 (their place on another's panel), R1 rates E2 (their own panel), E1 rates R1 (untouched)
    for subj, ass, rel in ((E1, E2, "peer"), (E2, R1, "peer"), (R1, E1, "peer")):
        db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship) VALUES (?,?,?,?)",
                   (CID, subj, ass, rel))
    db.commit()


def mine(db):
    """This suite's own rules: other suites (or a QC run) may have left rules of theirs on the shared copy."""
    return [x for x in a.cycle_exclusions(db, CID) if x["business_group"] == BG]


def user(uid):
    with a.app.test_request_context("/"):
        return dict(a.get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())


def arch(subj, ass):
    with a.app.test_request_context("/"):
        r = a.get_db().execute("SELECT archived, archive_reason FROM assignments WHERE cycle_id=? AND subject_id=? "
                               "AND assessor_id=?", (CID, subj, ass)).fetchone()
        return (r[0], r[1]) if r else (None, None)


def sql_in(pred, uid):
    with a.app.test_request_context("/"):
        return a.get_db().execute("SELECT 1 FROM users WHERE id=? AND " + pred, (uid,)).fetchone() is not None


try:
    s.section("before any rule")
    with a.app.test_request_context("/"):
        d = a.get_db()
        s.check("everyone takes part and may rate", a.participation(d, user(E2))[0] and a.participation(d, user(E1))[0]
                and sql_in(a.assessor_eligible_sql(), E2) and a.unit_out(d, user(E2)) is None,
                a.participation(d, user(E2)))
        s.check("the predicate qualifies its outer columns (unqualified, the subquery would read its own and match "
                "everyone)", "users.business_group" in a.unit_out_sql() and "u.company" in a.unit_out_sql("u"))

    s.section("only the super admin sets it")
    if BGA is not None:
        r = H.client_as(a, BGA["id"]).post("/admin/participants", data={
            "csrf_token": "tok", "action": "exclude_add", "ex_bg": BG, "ex_bu": OUT, "ex_scope": "unit"})
        with a.app.test_request_context("/"):
            s.check("a BG admin's leave-out is refused (403), nothing stored", r.status_code == 403
                    and not mine(a.get_db()), r.status_code)
    sa = H.client_as(a, SU["id"])
    pv = sa.get("/admin/participants?panel=exclude&ex_bg=%s&ex_bu=%s&ex_scope=unit" % (BG, OUT)).get_data(as_text=True)
    s.check("the side panel's preview says what changes before anything does: 3 people, 1 place on another's panel, "
            "2 reviewed one level up, and the double confirmation is red",
            "What changes in" in pv and "3 people take no part" in pv and "1 of their place" in pv
            and "2 people are reviewed one level up" in pv and "ZZ ZZUX-E1" in pv and "ZZ ZZUX-E5" in pv
            and "ZZ ZZUX-M0" in pv
            and 'data-confirm-tone="danger"' in pv and 'value="exclude_add"' in pv)
    with a.app.test_request_context("/"):
        s.check("...and the preview wrote nothing", not mine(a.get_db()) and arch(E1, E2)[0] == 0, mine(a.get_db()))

    s.section("leaving the whole unit out")
    r = sa.post("/admin/participants", data={"csrf_token": "tok", "action": "exclude_add", "ex_bg": BG, "ex_bu": OUT,
                                             "ex_scope": "unit"})
    with a.app.test_request_context("/"):
        d = a.get_db()
        rule = d.execute("SELECT * FROM cycle_exclusions WHERE cycle_id=? AND company=?", (CID, OUT)).fetchone()
        s.check("the rule is stored for this cycle, the whole unit, with who set it", r.status_code == 302 and rule
                and rule["department"] == "" and rule["created_by"] == SU["id"], dict(rule) if rule else r.status_code)
        s.check("...and in the audit log", d.execute("SELECT 1 FROM activity_log WHERE action='participant_exclusion' "
                                                     "AND detail LIKE ?", ("%" + OUT + " left out (3 people%",)).fetchone())
        s.check("they take no part: participation says why, before any admin override",
                a.participation(d, user(E2)) == (False, "unit_out") and a.participation(d, user(M1)) == (False, "unit_out")
                and a.participation(d, user(E1))[0], (a.participation(d, user(E2)), a.participation(d, user(E1))))
        s.check("...the SQL agrees everywhere it means 'takes part at all': review, Career Plan, rating others",
                not sql_in(a.participant_sql(), E2) and not sql_in(a.idp_participant_sql(), E2)
                and not sql_in(a.assessor_eligible_sql(), E2) and sql_in(a.participant_sql(), E1)
                and sql_in(a.assessor_eligible_sql(), E1))
        s.check("...and the Career Plan's mirror", a.idp_participation(d, user(E2)) == (False, "unit_out"),
                a.idp_participation(d, user(E2)))
        s.check("their 360 rows are archived both ways, with the reason; nobody else's", arch(E1, E2)[0] == 1
                and arch(E2, R1)[0] == 1 and arch(R1, E1)[0] == 0 and OUT in (arch(E1, E2)[1] or ""),
                (arch(E1, E2), arch(E2, R1), arch(R1, E1)))
        s.check("...and the panel tools never put them back: the panel build's pool leaves them out",
                "ZZUX-E2" in a._unit_out_eids(d, CID) and "ZZUX-E1" not in a._unit_out_eids(d, CID))
        chain = [r[0] for r in d.execute("SELECT approver_id FROM pm_kpi_target_approvers WHERE kpi_target_id=?",
                                         (T1,))]
        s.check("E1's KPI line, moderated by M1 and untouched, moved one level up to M0", chain == [M0], chain)

    s.section("a left-out leader leads nobody; their reports go one level up")
    with a.app.test_request_context("/"):
        d = a.get_db()
        m1, m0 = user(M1), user(M0)
        s.check("every leader ability is off for M1, with the reason", not a.leader_can(m1, "lm.moderate", d)
                and not a.leader_can(m1, "hod.view", d) and OUT in (a.leader_ability_off(d, m1, "lm.competency") or ""),
                a.leader_ability_off(d, m1, "lm.competency"))
        s.check("...no Team tab, no KPI lines to moderate", not a._review_manages_team(d, m1)
                and a._pm_approver_subject_ids(d, m1, CID) == [] and not a._pm_is_approver_of(d, m1, E1, CID))
        s.check("M0 reviews M1's reports this cycle (one level up); M1 reviews nobody",
                a._cycle_review_managers(d, M0) == [M0, M1] and a._cycle_review_managers(d, M1) == [],
                (a._cycle_review_managers(d, M0), a._cycle_review_managers(d, M1)))
        s.check("...the Career Plan review follows: M0 reviews E1, M1 doesn't, and E2 (out) has no plan to review",
                a._idp_is_reviewer_of(d, m0, E1, CID) and not a._idp_is_reviewer_of(d, m1, E1, CID)
                and E1 in a._idp_review_subject_ids(d, m0, CID) and E2 not in a._idp_review_subject_ids(d, m0, CID))
        s.check("...and M0's KPI moderation lists E1 now", E1 in a._pm_approver_subject_ids(d, m0, CID))
        s.check("the skip-level alone (E5 has no KPI line): M0 reviews E5's Career Plan and competencies, M1 neither",
                a._idp_is_reviewer_of(d, m0, E5, CID) and not a._idp_is_reviewer_of(d, m1, E5, CID)
                and E5 in a._idp_review_subject_ids(d, m0, CID)
                and (not _sk or (E5 in [r["id"] for r in a._tc_reports_for(d, M0, CID)]
                                 and E5 not in [r["id"] for r in a._tc_reports_for(d, M1, CID)])))

    s.section("the rule reads live")
    with a.app.test_request_context("/"):
        d = a.get_db()
        J = None
        base2 = dict(d.execute("SELECT * FROM users WHERE id=?", (E2,)).fetchone())
        v = dict(base2, username="zzux-j1", employee_id="ZZUX-J1", full_name="ZZ ZZUX-J1")
        cols2 = [c for c in v.keys() if c != "id"]
        d.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols2), ",".join("?" * len(cols2))),
                  [v[c] for c in cols2])
        d.commit()
        J = d.execute("SELECT id FROM users WHERE employee_id='ZZUX-J1'").fetchone()[0]
        s.check("a joiner to the unit is out with no step", a.participation(d, user(J)) == (False, "unit_out"))
    r = sa.post("/admin/participants", data={"csrf_token": "tok", "action": "add", "ids": str(E2)})
    with a.app.test_request_context("/"):
        s.check("nobody in it is added back by hand: the Add is refused, nothing stored", r.status_code == 302
                and not a.get_db().execute("SELECT 1 FROM cycle_participants WHERE cycle_id=? AND subject_id=?",
                                           (CID, E2)).fetchone())
    pg = sa.get("/admin/participants?bg=%s&show=unit" % BG).get_data(as_text=True)
    s.check("Participants: the card lists the rule with Bring back, the filter counts them, their rows have no tick box",
            "Units and departments not taking part" in pg and "Bring back" in pg and "Out by a unit or department (4)"
            in pg and ('value="%d" class="pt-row"' % E2) not in pg and "ZZ ZZUX-E2" in pg)
    if BGA is not None:
        pb = H.client_as(a, BGA["id"]).get("/admin/participants").get_data(as_text=True)
        s.check("...a BG admin reads the card: no Leave out, no Bring back", "Units and departments not taking part"
                in pb and "Leave a unit or department out" not in pb and 'value="exclude_remove"' not in pb)

    s.section("Bring back, and a department rule")
    with a.app.test_request_context("/"):
        rid = a.get_db().execute("SELECT id FROM cycle_exclusions WHERE cycle_id=? AND company=?",
                                 (CID, OUT)).fetchone()[0]
    r = sa.post("/admin/participants", data={"csrf_token": "tok", "action": "exclude_remove", "ex_id": str(rid)})
    with a.app.test_request_context("/"):
        d = a.get_db()
        s.check("Bring back removes the rule: they take part again by the usual rule", r.status_code == 302
                and a.participation(d, user(E2))[0] and sql_in(a.assessor_eligible_sql(), E2)
                and a.leader_can(user(M1), "lm.moderate", d))
        chain = [x[0] for x in d.execute("SELECT approver_id FROM pm_kpi_target_approvers WHERE kpi_target_id=?",
                                         (T1,))]
        s.check("...the archived 360 rows and the moved KPI line stay as they are", arch(E1, E2)[0] == 1
                and chain == [M0], (arch(E1, E2), chain))
        s.check("...and it's in the audit log", d.execute("SELECT 1 FROM activity_log WHERE action='participant_exclusion' "
                                                          "AND detail LIKE ?", ("%" + OUT + " brought back%",)).fetchone())
    r = sa.post("/admin/participants", data={"csrf_token": "tok", "action": "exclude_add", "ex_bg": BG, "ex_bu": OUT,
                                             "ex_scope": "depts", "ex_dept": "ZZ Dept X"})
    with a.app.test_request_context("/"):
        d = a.get_db()
        s.check("a department rule leaves only that department out", r.status_code == 302
                and a.participation(d, user(E3)) == (False, "unit_out") and a.participation(d, user(E2))[0]
                and a.unit_out(d, user(E3))["label"] == OUT + " · ZZ Dept X")
    r = sa.post("/admin/participants", data={"csrf_token": "tok", "action": "exclude_add", "ex_bg": BG, "ex_bu": OUT,
                                             "ex_scope": "depts", "ex_dept": "Not One Of Theirs"})
    with a.app.test_request_context("/"):
        s.check("...a department that isn't the unit's is refused, nothing stored", a.get_db().execute(
            "SELECT COUNT(*) FROM cycle_exclusions WHERE cycle_id=? AND company=?", (CID, OUT)).fetchone()[0] == 1)

    s.section("the wiring")
    src = H.source(a, "app.py")
    s.check("the access grid says it stays the super admin's, and the rule follows an org rename",
            "units and departments not taking part" in src.split('("cycle", "Cycle"', 1)[1][:400]
            and "cycle_exclusions" in a._ORG_SETTINGS_TABLES)
    s.check("the reason reads in words wherever participation is shown", "unit_out" in a._PARTICIPATION_WORDS
            and "unit_out" in a._PERSON_WHY_OUT)
finally:
    with a.app.test_request_context("/"):
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
