"""The potential page's strengths summary reads the 360 tier the SUBMITTED answers hold (Chris, 9 Nov 2026; HANDOFF "Profile-change
guards: open, not built", the reader near `_pot_sw_gap`).

`_pot_strengths` tallies the submitted ratings but used to LIST `statements_for_grade(db, live grade)`: after a grade change moved the
person to another 360 tier, their raters' answers sat on the old tier's statements and the strengths and development areas went
empty. It now lists the statements of the tier the person's submitted, non-archived ratings hold (`_pot_held_tiers`, over
`_fb_assignment_tiers`): the tier holding the most ratings, a tie to the lower tier; no submitted rating that holds rows -> the live
tier as before. `min_valid_submissions` stays on the live grade (the 360 threshold). Two reads for the whole scope, never one per person.

Synthetic ZZST-* people on a fresh scratch database; Suite.done() puts it back.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Strengths summary: the tier the submitted answers hold")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
GRADE_T1, GRADE_T2 = 14, 16   # tier 1 is JG 12-14 and tier 2 JG 15-17 in the cycle's bands (asserted below)

with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    CYC = a.active_cycle(db)
    TN1, TN2 = a._cycle_tier_n(db, GRADE_T1, CID), a._cycle_tier_n(db, GRADE_T2, CID)
    s.check("the fixture's two grades sit on two tiers", TN1 != TN2 and a.statements_for_tier(db, TN1, CID)
            and a.statements_for_tier(db, TN2, CID), (TN1, TN2))
    ST = {tn: [r["statement_id"] for r in a.statements_for_tier(db, tn, CID)] for tn in (TN1, TN2)}

    def mk(eid, grade):
        return a.get_db().execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, department, "
                          "job_title, job_grade, confirmation_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                          (eid.lower(), "ZZ ST " + eid, "x", "user", eid, "ZZST Group", "ZZST Unit", "Ops", "ZZ Officer", grade,
                           "2020-01-01")).lastrowid

    def rate(subject, assessor, tn, status="submitted", archived=0, answer="yes"):
        """One rating of `subject` by `assessor`, its answers on tier `tn`'s statements."""
        aid = a.get_db().execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, archived) VALUES (?,?,?,?,?,?)",
                         (CID, subject, assessor, "peer", status, archived)).lastrowid
        for st in ST[tn]:
            a.get_db().execute("INSERT INTO responses(assignment_id, statement_id, answer) VALUES (?,?,?)", (aid, st, answer))
        return aid
    RATERS = [mk("ZZST-R%d" % i, GRADE_T1) for i in range(1, 6)]
    # S: three submitted ratings on tier 1, then promoted to tier 2's grade
    S = mk("ZZST-S", GRADE_T1)
    for r in RATERS[:3]:
        rate(S, r, TN1)
    # T: the same ratings, no grade move
    T = mk("ZZST-T", GRADE_T1)
    for r in RATERS[:3]:
        rate(T, r, TN1)
    # U: a tie (one rating each tier); V: a majority on tier 2; W: pending and archived ratings only
    U, V, W = mk("ZZST-U", GRADE_T1), mk("ZZST-V", GRADE_T1), mk("ZZST-W", GRADE_T1)
    rate(U, RATERS[0], TN1)
    rate(U, RATERS[1], TN2)
    rate(V, RATERS[0], TN1)
    rate(V, RATERS[1], TN2)
    rate(V, RATERS[2], TN2)
    rate(W, RATERS[0], TN1, status="pending")
    rate(W, RATERS[1], TN2, archived=1)
    db.commit()
    db.execute("UPDATE users SET job_grade=? WHERE id=?", (GRADE_T2, S))
    db.commit()


def strengths(uids, held=True):
    """_pot_strengths for these people as rows, with or without the new reader (False = the live tier, the old behaviour)."""
    with a.app.app_context():
        d = a.get_db()
        rows = [{"valid": True, "user": dict(d.execute("SELECT * FROM users WHERE id=?", (u,)).fetchone())} for u in uids]
        real = a._pot_held_tiers
        try:
            if not held:
                a._pot_held_tiers = lambda *x, **k: {}
            return a._pot_strengths(d, rows, CID)
        finally:
            a._pot_held_tiers = real


def listed(blk):
    """Every principle a person's summary names (strengths, development areas, the 'seen the same' line), or the empty set."""
    if not blk:
        return set()
    out = {i["name"] for i in blk.get("top", []) + blk.get("bottom", []) + blk.get("more_items", [])}
    return out | ({blk["even"]["name"]} if blk.get("even") and blk["even"].get("name") else set())


# ---------------------------------------------------------------------------------------------------------------------------
s.section("a person whose grade moved to another tier after the raters answered")
with a.app.app_context():
    d = a.get_db()
    live = a._cycle_tier_n(d, d.execute("SELECT job_grade FROM users WHERE id=?", (S,)).fetchone()[0], CID)
s.check("S now sits on the other tier than their ratings hold", live == TN2, live)
base = strengths([T])[T]
got = strengths([S])[S]
s.check("the baseline (no move) lists principles: the fixture's answers are all 'yes' so every one is fully demonstrated", base and
        base["n"] == base["n_full"] and base["n"] > 0 and listed(base), (base or {}).get("n"))
s.check("S, moved to tier 2, still lists what their tier-1 answers say: the same summary as T who did not move",
        got and got["n"] == base["n"] and got["n_full"] == base["n_full"] and listed(got) == listed(base)
        and [i["name"] for i in got["top"]] == [i["name"] for i in base["top"]], (got or {}).get("n"))
old = strengths([S], held=False)
s.check("falsified: with the live tier (the old reader) the same person's summary is empty or wrong -- the answers sit on the old tier",
        not listed(old.get(S)) and (old.get(S) or {}).get("n", 0) == 0 and listed(got), (old.get(S) or {}).get("n"))
s.check("a person with no tier move is unchanged by the new reader (their summary equals the live-tier one)",
        strengths([T])[T] == strengths([T], held=False)[T], "")

# ---------------------------------------------------------------------------------------------------------------------------
s.section("which tier: the most ratings, a tie to the lower tier, submitted and live ones only")
with a.app.app_context():
    d = a.get_db()
    held = a._pot_held_tiers(d, CID, [S, T, U, V, W])
s.check("S and T hold tier 1, V (two ratings on tier 2 against one) holds tier 2, U (one each) the LOWER tier",
        held.get(S) == TN1 and held.get(T) == TN1 and held.get(V) == TN2 and held.get(U) == min(TN1, TN2), held)
s.check("W (a pending and an archived rating only) holds nothing: the live tier is used, as before", W not in held, held)
with a.app.app_context():
    d = a.get_db()
    rw = strengths([W])[W]
s.check("...and W's summary is the live tier's, which holds no answers: nothing to list",
        rw is None or not listed(rw), rw and rw.get("n"))
rv = strengths([V])[V]
s.check("V (tier 2 holds most ratings) is read on tier 2: the two tier-2 raters' answers, never the tier-1 one's",
        rv and rv["n"] == strengths([T])[T]["n"] and listed(rv), (rv or {}).get("n"))

# the threshold stays on the live grade: S's `letter` flag reads their live grade, not the tier
with a.app.app_context():
    d = a.get_db()
    s.check("the 360 threshold (min_valid_submissions) stays on the live grade, never the held tier",
            a.min_valid_submissions(GRADE_T2) == a.min_valid_submissions(
                d.execute("SELECT job_grade FROM users WHERE id=?", (S,)).fetchone()[0]) and got["letter"] == (a.min_valid_submissions(GRADE_T2) == 1))

# ---------------------------------------------------------------------------------------------------------------------------
s.section("batched: two reads for the whole scope, never one per person")
with a.app.app_context():
    d = a.get_db()
    many = [mk("ZZST-M%d" % i, GRADE_T1) for i in range(40)]
    for m in many:
        for r in RATERS[:2]:
            rate(m, r, TN1)
    d.commit()
    seen = []
    d.set_trace_callback(lambda sql: seen.append(sql))
    a._pot_held_tiers(d, CID, many)
    d.set_trace_callback(None)
    n_sel = sum(1 for q in seen if q.lstrip().upper().startswith("SELECT"))
    s.check("40 people cost a fixed handful of reads (not one each)", 1 <= n_sel <= 4, n_sel)
    seen.clear()
    d.set_trace_callback(lambda sql: seen.append(sql))
    rows = [{"valid": True, "user": dict(d.execute("SELECT * FROM users WHERE id=?", (m,)).fetchone())} for m in many]
    seen.clear()
    a._pot_strengths(d, rows, CID)
    d.set_trace_callback(None)
    n_data = sum(1 for q in seen if q.lstrip().upper().startswith("SELECT") and ("FROM assignments" in q or "FROM responses" in q))
    s.check("the whole summary for 40 people reads the ratings in a fixed number of queries (the tally and the held tiers), never one per person",
            1 <= n_data <= 5, n_data)

# the unopened-rating total is untouched (an unopened rating is pending, the live tier is right; every tier has 28 statements)
s.check("every tier holds the same number of statements, which is why the unopened total needs no change",
        len({len(v) for v in ST.values()}) == 1)
sys.exit(s.done())
