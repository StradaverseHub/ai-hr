"""A line-manager change in the People roster import moves the person's unmoderated KPI lines (Chris, 2026-10-30).

The person page and Data integrity (`_apply_line_manager_change`) move a person's KPI lines that nobody has acted on to the
new line manager. The roster import wrote users.manager_id directly, so those lines stayed with the OLD manager. Now both
follow one rule: `_pm_lm_lines_to_move_many` (batched, one read per 500 people), which `_pm_lm_lines_to_move` calls.

What this suite holds:
  * the roster apply moves an unmoderated line whose one step is the old manager (and a line with no moderator) to the new
    manager; a line with a pm_kpi_approvals row, a line filled for the whole unit and a line routed to a matrix manager
    stay put; users.manager_id is the new manager
  * it touches no 360 panel: the subject's `assignments` rows (and the whole table) are identical before and after
  * nothing moves with no active cycle (only the reporting line changes), for a manager the file leaves as it is, or for a
    new joiner
  * the batched rule returns the same ids as the single-person one, reads the lines in ONE query for many people, and
    chunks past 500
  * a `set_manager` audit row is written per changed line manager, with the count of lines moved; the done message and
    the Changes step's chip say so
  * every guard is falsified: with the rule stubbed to "everything" the stay-put expectations fail, with the move stubbed
    out the move expectation fails, and the person page's own change DOES alter the panel (so the panel check can fail)

Synthetic (ZZRLM-*) people on a fresh scratch database; Suite.done() puts it back.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Roster import -- a line-manager change moves the unmoderated KPI lines")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)

ctx = a.app.test_request_context("/")
ctx.push()
db = a.get_db()
CID = a.active_cycle_id(db)
assert CID, "the scratch database has no active cycle"
UNIT = db.execute("SELECT business_group, company FROM org_units WHERE company!='' ORDER BY business_group, company "
                  "LIMIT 1").fetchone()
BG, CO = UNIT[0], UNIT[1]
ME = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())


def mk(eid, name, **kw):
    cols = dict(username=eid.lower(), full_name=name, password_hash="x", role="user", employee_id=eid,
                business_group=BG, company=CO, department="ZZRLM Ops", job_grade=14, joined_date="2013-11-18",
                confirmation_date="2013-12-18")
    cols.update(kw)
    db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), list(cols.values()))
    return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]


OLD = mk("ZZRLM-OLD", "ZZ RLM Old")
NEW = mk("ZZRLM-NEW", "ZZ RLM New")
MX = mk("ZZRLM-MX", "ZZ RLM Matrix")
PEER = mk("ZZRLM-PEER", "ZZ RLM Peer")
P1 = mk("ZZRLM-P1", "ZZ RLM Pone", manager_id=OLD)    # the one whose manager changes
P2 = mk("ZZRLM-P2", "ZZ RLM Ptwo", manager_id=OLD)    # the file leaves their manager alone
P3 = mk("ZZRLM-P3", "ZZ RLM Pthree", manager_id=OLD)  # a second person whose manager changes
db.commit()

PERIOD = db.execute("SELECT id FROM cycles WHERE id=?", (CID,)).fetchone()[0]


def line(subject, name, chain, **kw):
    db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company, "
               "unit, rate1, rate2, rate3, rate4, rate5, status) VALUES (?,?,?,?,?,?,?,?,1,2,3,4,5,'approved')",
               (PERIOD, subject, name, 20, "more", BG, CO, "%"))
    tid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    for seq, ap in enumerate(chain, start=1):
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,?,?)", (tid, seq, ap))
    if kw.get("approved"):
        db.execute("INSERT INTO pm_kpi_approvals(kpi_target_id, seq, action, original_value, acted_by) "
                   "VALUES (?,1,'confirm',3,?)", (tid, chain[0]))
    if kw.get("filled"):
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, submitted_by, admin_filled, draft) "
                   "VALUES (?,3,?,1,0)", (tid, SU["id"]))
    return tid


L = {}
for who in (P1, P2, P3):
    L[who] = {
        "plain": line(who, "ZZ plain", [OLD]),
        "none": line(who, "ZZ no moderator", []),
        "approved": line(who, "ZZ approved", [OLD], approved=True),
        "filled": line(who, "ZZ filled for the unit", [OLD], filled=True),
        "matrix": line(who, "ZZ matrix", [MX]),
    }
MOVES = {"plain", "none"}      # the rule: no action on them, and their one step is the old manager (or none)
db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) VALUES (?,?,?,?,'pending')",
           (CID, P1, OLD, "line_manager"))
db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) VALUES (?,?,?,?,'pending')",
           (CID, P1, PEER, "peer"))
db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) VALUES (?,?,?,?,'pending')",
           (CID, P3, PEER, "peer"))
db.commit()


def chain(tid):
    return [r[0] for r in db.execute("SELECT approver_id FROM pm_kpi_target_approvers WHERE kpi_target_id=? ORDER BY seq",
                                     (tid,))]


def mgr(uid):
    return db.execute("SELECT manager_id FROM users WHERE id=?", (uid,)).fetchone()[0]


def panel():
    return [tuple(r) for r in db.execute("SELECT * FROM assignments ORDER BY id")]


def rec(eid, name, manager, **kw):
    r = {"employee id": eid, "employee name": name, "business group": BG, "company": CO, "manager": manager,
         "job grade": "14", "joined date": "2013-11-18", "work email": eid.lower() + "@example.com"}
    r.update(kw)
    return r


def run(records, apply_fn=None):
    """check then apply as the four-step import does (the changes step's note, then _rimp_apply)."""
    chk = a._roster_check(db, ME, records, False)
    assert not chk["errors"], chk["errors"]
    return chk, (apply_fn or (lambda c: a._roster_apply(db, ME, c)))(chk)


def reset():
    """Back to the starting lines and managers (the lines the earlier run moved go back to the old manager)."""
    for who in (P1, P2, P3):
        db.execute("UPDATE users SET manager_id=? WHERE id=?", (OLD, who))
        for k, tid in L[who].items():
            a._pm_set_moderator(db, tid, [MX] if k == "matrix" else ([] if k == "none" else [OLD]))
    db.execute("DELETE FROM users WHERE employee_id='ZZRLM-J1'")
    db.execute("DELETE FROM activity_log WHERE action='set_manager' AND detail LIKE '%roster import%'")
    db.commit()


def audit():
    return [r[0] for r in db.execute("SELECT detail FROM activity_log WHERE action='set_manager' "
                                     "AND detail LIKE '%(roster import)%' ORDER BY id")]


# ---------------------------------------------------------------------------------------------------------------------
s.section("the batched rule is the single-person rule")
want = {t for k, t in L[P1].items() if k in MOVES}
single = a._pm_lm_lines_to_move(db, P1, NEW, CID)
many = a._pm_lm_lines_to_move_many(db, {P1: NEW, P2: NEW, P3: MX}, CID)
s.check("the single-person rule is exactly: unmoderated, not filled for the unit, one step the old manager (or none)",
        set(single) == want, (single, want))
s.check("the batched rule gives the same ids for the same person, and answers for each person asked about",
        sorted(many.get(P1, [])) == sorted(single) and set(many.get(P2, [])) == {t for k, t in L[P2].items() if k in MOVES}
        and set(many.get(P3, [])) == {t for k, t in L[P3].items() if k in MOVES}
        and a._pm_lm_lines_to_move(db, P3, MX, CID) == many.get(P3), many)
s.check("a manager that would not change (old == new) and a missing cycle give nothing",
        a._pm_lm_lines_to_move_many(db, {P1: OLD}, CID) == {} and a._pm_lm_lines_to_move(db, P1, OLD, CID) == []
        and a._pm_lm_lines_to_move_many(db, {P1: NEW}, None) == {} and a._pm_lm_lines_to_move(db, P1, NEW, None) == [])
seen_sql = []
db.set_trace_callback(lambda q: seen_sql.append(q))
a._pm_lm_lines_to_move_many(db, {P1: NEW, P2: NEW, P3: NEW}, CID)
db.set_trace_callback(None)
reads = [q for q in seen_sql if "pm_kpi_targets" in q]
s.check("it reads the lines of many people in ONE query", len(reads) == 1, len(reads))
big = {P1: NEW, P3: NEW}
big.update({10 ** 7 + i: NEW for i in range(1200)})
seen_sql.clear()
db.set_trace_callback(lambda q: seen_sql.append(q))
got = a._pm_lm_lines_to_move_many(db, big, CID)
db.set_trace_callback(None)
s.check("...chunked by 500, and a person past the first chunk is still answered",
        len([q for q in seen_sql if "pm_kpi_targets" in q]) == 3 and set(got) == {P1, P3}, set(got))
# falsified: the rule is not "everything"
s.check("   FALSIFY: the stay-put lines are really excluded (not just absent from the fixture)",
        all(L[P1][k] not in single for k in ("approved", "filled", "matrix")) and len(single) < len(L[P1]))

# ---------------------------------------------------------------------------------------------------------------------
s.section("the roster apply moves the lines by that rule, and leaves the panel alone")
reset()
panel_before = panel()
p1_assign_before = [tuple(r) for r in db.execute("SELECT * FROM assignments WHERE subject_id=? ORDER BY id", (P1,))]
records = [rec("ZZRLM-P1", "ZZ RLM Pone", "ZZRLM-NEW"),
           rec("ZZRLM-P2", "ZZ RLM Ptwo", "ZZRLM-OLD"),                     # the file repeats who they have
           rec("ZZRLM-P3", "ZZ RLM Pthree", "ZZRLM-MX")]                    # a second change, to a third person
chk = a._roster_check(db, ME, records, False)
res = a._roster_apply(db, ME, chk)
s.check("users.manager_id is the new line manager for the people whose line changed; the one who stayed, stayed",
        mgr(P1) == NEW and mgr(P3) == MX and mgr(P2) == OLD, (mgr(P1), mgr(P3), mgr(P2)))
s.check("an unmoderated line whose step was the old manager is now the new manager's; so is a line with no moderator",
        chain(L[P1]["plain"]) == [NEW] and chain(L[P1]["none"]) == [NEW], (chain(L[P1]["plain"]), chain(L[P1]["none"])))
s.check("a line with an approvals row stays with the old manager", chain(L[P1]["approved"]) == [OLD], chain(L[P1]["approved"]))
s.check("a line filled for the whole unit stays", chain(L[P1]["filled"]) == [OLD], chain(L[P1]["filled"]))
s.check("a line routed to a matrix manager stays", chain(L[P1]["matrix"]) == [MX], chain(L[P1]["matrix"]))
s.check("the second person's lines follow too (to their own new manager)",
        chain(L[P3]["plain"]) == [MX] and chain(L[P3]["none"]) == [MX] and chain(L[P3]["approved"]) == [OLD])
s.check("a person whose manager the file leaves as it is: no line moves",
        all(chain(L[P2][k]) == ([MX] if k == "matrix" else ([] if k == "none" else [OLD])) for k in L[P2]))
s.check("no 360 panel changes: the person's assignments (and the whole table) are identical",
        [tuple(r) for r in db.execute("SELECT * FROM assignments WHERE subject_id=? ORDER BY id", (P1,))] == p1_assign_before
        and panel() == panel_before)
s.check("the apply reports how many lines moved (a 6th figure, the others as before)",
        len(res) == 6 and res[5] == 4 and res[1] == 3, res)
log = audit()
s.check("a set_manager audit row for each changed line manager, naming both and the lines moved; none for the one who stayed",
        len(log) == 2 and any(d.startswith("ZZ RLM Pone -> ZZ RLM New (roster import); 2 KPI line(s) moved") for d in log)
        and any(d.startswith("ZZ RLM Pthree -> ZZ RLM Matrix (roster import); 2 KPI line(s) moved") for d in log)
        and not any("Ptwo" in d for d in log), log)
tgt = db.execute("SELECT target_user_id FROM activity_log WHERE action='set_manager' AND detail LIKE 'ZZ RLM Pone%'").fetchone()
s.check("...against the person's own record", tgt and tgt[0] == P1)
s.check("the Changes step lists a Line manager change, with its note",
        "Line manager" in chk["by_field"], dict(chk["by_field"]))

# ---------------------------------------------------------------------------------------------------------------------
s.section("nothing moves with no active cycle, with an unchanged manager, or for a new joiner")
reset()
db.execute("UPDATE cycles SET is_active=0 WHERE id=?", (CID,))
db.commit()
a.g._active_cycle = None
panel_b = panel()
chk, res = run([rec("ZZRLM-P1", "ZZ RLM Pone", "ZZRLM-NEW")])
s.check("no active cycle: the reporting line changes, nothing else does",
        mgr(P1) == NEW and chain(L[P1]["plain"]) == [OLD] and chain(L[P1]["none"]) == [] and res[5] == 0
        and panel() == panel_b and audit() != [], (mgr(P1), res))
db.execute("UPDATE cycles SET is_active=1 WHERE id=?", (CID,))
db.commit()
a.g._active_cycle = None
reset()
chk, res = run([rec("ZZRLM-P2", "ZZ RLM Ptwo", "ZZRLM-OLD")])
s.check("a manager the file leaves as it is: no line moves, no audit row, a zero count",
        chain(L[P2]["plain"]) == [OLD] and res[5] == 0 and audit() == [], (res, audit()))
chk, res = run([rec("ZZRLM-J1", "ZZ RLM Joiner", "ZZRLM-NEW")])
joiner = db.execute("SELECT id, manager_id FROM users WHERE employee_id='ZZRLM-J1'").fetchone()
s.check("a new joiner: their manager is linked, nothing moves, no line-manager audit row",
        joiner and joiner[1] == NEW and res[0] == 1 and res[5] == 0 and audit() == [], (res, audit()))
s.check("   FALSIFY: the same file for the existing person, with the cycle on, does move lines (the zeroes above are real)",
        a._roster_apply(db, ME, a._roster_check(db, ME, [rec("ZZRLM-P1", "ZZ RLM Pone", "ZZRLM-NEW")], False))[5] == 2)

# ---------------------------------------------------------------------------------------------------------------------
s.section("the done message")
reset()
chk = a._roster_check(db, ME, [rec("ZZRLM-P1", "ZZ RLM Pone", "ZZRLM-NEW")], False)
out = a._rimp_apply(db, ME, chk, {})
s.check("the four-step import's done lines say how many KPI lines nobody had moderated moved to the new line manager",
        any("2 KPI lines nobody had moderated moved to the new line manager" in x for x in out["lines"]), out)
reset()
chk = a._roster_check(db, ME, [rec("ZZRLM-P2", "ZZ RLM Ptwo", "ZZRLM-OLD")], False)
out0 = a._rimp_apply(db, ME, chk, {})
s.check("   FALSIFY: with nothing to move the line is absent", not any("KPI line" in x for x in out0["lines"]), out0)

# ---------------------------------------------------------------------------------------------------------------------
s.section("falsified: each guard fails when it is taken away")
orig_many, orig_set = a._pm_lm_lines_to_move_many, a._pm_set_moderator
# 1. the rule stubbed to "every line of the person": the stay-put expectations must fail
reset()
a._pm_lm_lines_to_move_many = lambda d_, ch, cid: {u: list(L[u].values()) for u in ch if u in L}
a._roster_apply(db, ME, a._roster_check(db, ME, [rec("ZZRLM-P1", "ZZ RLM Pone", "ZZRLM-NEW")], False))
a._pm_lm_lines_to_move_many = orig_many
s.check("with the rule stubbed to every line, the approved and matrix lines DO move (so the stay-put checks can fail)",
        chain(L[P1]["approved"]) == [NEW] and chain(L[P1]["matrix"]) == [NEW])
# 2. the move stubbed out: the move expectation must fail
reset()
a._pm_set_moderator = lambda d_, tid, ids: None
a._roster_apply(db, ME, a._roster_check(db, ME, [rec("ZZRLM-P1", "ZZ RLM Pone", "ZZRLM-NEW")], False))
a._pm_set_moderator = orig_set
s.check("with the move stubbed out, the plain line is left with the old manager (so the move check can fail)",
        chain(L[P1]["plain"]) == [OLD] and mgr(P1) == NEW)
# 3. the rule read AFTER manager_id changes finds nothing: why it is worked out first
reset()
db.execute("UPDATE users SET manager_id=? WHERE id=?", (NEW, P1))
s.check("the rule reads the OLD manager: asked after manager_id changed, it finds nothing (so it is asked before)",
        a._pm_lm_lines_to_move_many(db, {P1: NEW}, CID) == {})
# 4. the person page's own change DOES alter the panel: the panel comparison can fail
reset()
pb = panel()
a._apply_line_manager_change(db, P3, NEW, CID, disposition="reassign", actor_id=SU["id"])
db.commit()
s.check("the person page's change adds the panel row (so identical panels above mean something)", panel() != pb)

reset()
ctx.pop()
sys.exit(s.done())
