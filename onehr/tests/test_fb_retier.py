"""A 360 rating follows its subject's tier (Chris, 2026-11-08; ticket OH-H-0083).

The bug: a rater answered every behaviour on a colleague's 360 card, but Submit said "12 behaviour(s) still unanswered".
The colleague's job grade had moved JG 14 -> 15 (tier 1 -> tier 2) after the rater first opened the card.
ensure_responses only INSERTs the CURRENT tier's rows and never removed the old tier's, so the rating held both; the card
showed the current tier only, while the gate (_fb_completion) and assignment_score counted every row.

Chris's rule: "If a person already answered the 360 before admin changes the JG, leave the result as is, but the 360
should move to the right tier after admin changes, so the next person answering will not hit the bug."
  * a SUBMITTED rating is never touched (its rows, score and status stay as they were)
  * a PENDING rating moves to the subject's CURRENT tier: rows for another tier's behaviours are deleted (answered or
    blank), the current tier's rows are created

What this suite holds (synthetic ZZFR-* people on a fresh scratch database; Suite.done() puts it back):
  * the shared function _fb_retier_pending: pending moves, submitted stays, a rating nobody opened stays lazily empty, an
    archived one is left alone, a same-tier move deletes nothing, and it is ONE batched write however many people move
  * the real writers call it: the admin person page's Edit details, the People roster import (once, batched), a cycle's
    own tier bands (set / clear) and the default tier bands in Settings
  * the OH-H-0083 case itself: 2 old answered + 12 old blank + 14 current answered -> the gate says nothing unanswered and
    Submit goes through; the old rows go before the rating is locked, so its stored score is one tier's
  * the lazy net: a grade changed by raw SQL (no hook) is right on every read (card, gate, progress, score, tallies, the
    export) and the next answer prunes
  * a submitted rating of the old tier is byte-identical after a grade move AND after anything opens its card
  * every guard is falsified by hand (see the report that came with the commit): the pending check, the prune, each
    reader's tier filter and each writer's hook turn this suite red
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
s = H.Suite("A 360 rating follows its subject's tier -- pending moves, submitted stays")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)

# the model is never called here
_avail0, _agent0 = ai_draft.review_agent_available, ai_draft.review_agent
ai_draft.review_agent_available = lambda: True
ai_draft.review_agent = lambda *x, **k: (_ for _ in ()).throw(AssertionError("the model was called"))


def post(client, url, **form):
    form.setdefault("csrf_token", "tok")
    return client.post(url, data=form)


def q(sql, args=()):
    return [tuple(r) for r in H.rows(a, sql, args)]


def one(sql, args=()):
    return H.one(a, sql, args)


with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','tm','pm','idp')")
    db.execute("UPDATE cycles SET kind='mid_year', starts_on=NULL, tiers_json=NULL WHERE id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
    UNIT = db.execute("SELECT business_group, company FROM org_units WHERE company!='' ORDER BY business_group, company "
                      "LIMIT 1").fetchone()
    BG, CO = UNIT[0], UNIT[1]
    TIERS0 = a.effective_tiers(db.execute("SELECT * FROM cycles WHERE id=?", (CID,)).fetchone())

    def mk(eid, name, grade=14, mgr=None):
        return db.execute(
            "INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, "
            "department, job_title, job_grade, manager_id, confirmation_date, years_of_service, joined_date) "
            "VALUES (?,?,'x','user',?,?,?,?,?,?,?,?,?,?)",
            (eid.lower(), name, eid, BG, CO, "ZZFR Ops", "Executive", grade, mgr, "2013-12-18", 4.0, "2013-11-18")).lastrowid
    RATER = mk("ZZFR-RATER", "ZZ FR Rater", 16)
    MGR = mk("ZZFR-MGR", "ZZ FR Manager", 16)
    SUBJ = {k: mk("ZZFR-" + k, "ZZ FR " + k, 14, MGR) for k in
            ("OLD", "SUB", "RAW", "RAW2", "SAME", "NEVER", "ARCH", "ROS1", "ROS2", "ROS3", "BAND", "BANDSUB", "DEF", "ONE")}
    db.commit()
    N = {tn: db.execute("SELECT COUNT(*) FROM cycle_statements WHERE cycle_id=? AND tier_n=?", (CID, tn)).fetchone()[0]
         for tn in (1, 2, 3, 4)}
    ST = {tn: [r[0] for r in db.execute("SELECT id FROM cycle_statements WHERE cycle_id=? AND tier_n=? ORDER BY id",
                                        (CID, tn))] for tn in (1, 2, 3, 4)}
s.check("fixture: tiers 1 and 2 each have behaviours to rate, and they are different sets",
        N[1] > 2 and N[2] > 2 and not set(ST[1]) & set(ST[2]), N)
s.check("fixture: the default bands put JG 14 in tier 1 and JG 15 in tier 2",
        TIERS0[0]["max"] == 14 and TIERS0[1]["min"] == 15, TIERS0)

SUP = H.client_as(a, SU["id"])
RAT = H.client_as(a, RATER)


def ctx(fn):
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = RATER
        d = a.get_db()
        return fn(d)


def assign(subj, status="pending", archived=0):
    with a.app.app_context():
        d = a.get_db()
        aid = d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, archived, "
                        "submitted_at) VALUES (?,?,?,'peer',?,?,?)",
                        (CID, SUBJ[subj], RATER, status, archived,
                         "2026-11-01 09:00:00" if status == "submitted" else None)).lastrowid
        d.commit()
        return aid


def open_card(aid, subj):
    """What the first answer does: ensure_responses (the one path that creates rows)."""
    with a.app.app_context():
        d = a.get_db()
        a.ensure_responses(d, aid, d.execute("SELECT * FROM users WHERE id=?", (SUBJ[subj],)).fetchone(), CID)


def answer(aid, stmts, vals="yes"):
    """Raw answers on rows that exist (a seeded state), alternating when vals is a list."""
    with a.app.app_context():
        d = a.get_db()
        for i, sid in enumerate(stmts):
            v = vals if isinstance(vals, str) else vals[i % len(vals)]
            d.execute("UPDATE responses SET answer=? WHERE assignment_id=? AND statement_id=?", (v, aid, sid))
        d.commit()


def set_grade_raw(subj, jg):
    with a.app.app_context():
        d = a.get_db()
        d.execute("UPDATE users SET job_grade=? WHERE id=?", (jg, SUBJ[subj]))
        d.commit()


def tier_rows(aid):
    """{tier_n: [rows]} held by one rating."""
    out = {}
    for sid, ans in q("SELECT r.statement_id, r.answer FROM responses r WHERE r.assignment_id=? ORDER BY r.id", (aid,)):
        out.setdefault(one("SELECT tier_n FROM cycle_statements WHERE id=?", (sid,)), []).append(ans)
    return out


def snapshot(aid):
    return (q("SELECT id, assignment_id, statement_id, answer FROM responses WHERE assignment_id=? ORDER BY id", (aid,)),
            q("SELECT status, submitted_at, archived FROM assignments WHERE id=?", (aid,)))


def counts(aid):
    return ctx(lambda d: (a._fb_completion(d, aid), a.assignment_score(d, aid)))


def details_form(subj, grade):
    with a.app.app_context():
        p = a.get_db().execute("SELECT * FROM users WHERE id=?", (SUBJ[subj],)).fetchone()
    return {"csrf_token": "tok", "action": "details_apply", "company": p["company"] or "", "department": p["department"] or "",
            "job_title": p["job_title"] or "", "job_grade": str(grade)}


def edit_grade(subj, grade):
    """The REAL admin writer: the person page's Edit details, Save."""
    return SUP.post("/admin/users/%d/lines" % SUBJ[subj], data=details_form(subj, grade), follow_redirects=True)


# ---------------------------------------------------------------------------------------------------------------------
s.section("the shared function on its own: pending moves, submitted stays")
A_OPEN = assign("OLD")                    # opened at tier 1, answered 2, then the grade moves
A_SUBM = assign("SUB", "submitted")       # submitted at tier 1
A_NEVER = assign("NEVER")                 # nobody opened it
A_ARCH = assign("ARCH", "pending", 1)     # archived
for aid, who in ((A_OPEN, "OLD"), (A_SUBM, "SUB"), (A_ARCH, "ARCH")):
    open_card(aid, who)
answer(A_OPEN, ST[1][:2], "yes")
answer(A_SUBM, ST[1], ["yes", "no"])
answer(A_ARCH, ST[1][:1], "no")
for who in ("OLD", "SUB", "NEVER", "ARCH"):
    set_grade_raw(who, 15)
snap_subm, snap_arch, snap_never = snapshot(A_SUBM), snapshot(A_ARCH), snapshot(A_NEVER)
res = ctx(lambda d: (a._fb_retier_pending(d, subject_id=SUBJ["OLD"]), d.commit())[0])
s.check("the pending rating now holds exactly the subject's current tier, every row blank (an answer to another tier's "
        "behaviour does not carry over)", tier_rows(A_OPEN) == {2: [None] * N[2]}, {k: len(v) for k, v in tier_rows(A_OPEN).items()})
s.check("...and it says what it did", res == {"assignments": 1, "removed": N[1], "created": N[2]}, res)
ctx(lambda d: (a._fb_retier_pending(d), d.commit()))   # the whole cycle
s.check("a SUBMITTED rating is never touched by it: rows, status and score identical",
        snapshot(A_SUBM) == snap_subm and counts(A_SUBM)[1][1] == sum(
            (a.SCORE_FUTURE if f else a.SCORE_CURRENT) for (f,) in q(
                "SELECT cs.is_future FROM responses r JOIN cycle_statements cs ON cs.id=r.statement_id "
                "WHERE r.assignment_id=?", (A_SUBM,))))
s.check("an ARCHIVED rating is left alone", snapshot(A_ARCH) == snap_arch)
s.check("a rating nobody opened stays lazily empty (no rows are made for it)", snapshot(A_NEVER) == snap_never
        and one("SELECT COUNT(*) FROM responses WHERE assignment_id=?", (A_NEVER,)) == 0)
res2 = ctx(lambda d: (a._fb_retier_pending(d), d.commit())[0])
s.check("run again it changes nothing (idempotent)", res2["removed"] == 0 and res2["created"] == 0, res2)
s.check("no active cycle, or a cycle with no ratings: nothing happens, no error",
        ctx(lambda d: a._fb_retier_pending(d, cycle_id=10 ** 7)) == {"assignments": 0, "removed": 0, "created": 0})

# ---------------------------------------------------------------------------------------------------------------------
s.section("a same-tier grade change deletes nothing")
A_SAME = assign("SAME")
open_card(A_SAME, "SAME")
answer(A_SAME, ST[1][:3], "yes")
before = snapshot(A_SAME)
r = edit_grade("SAME", 13)
s.check("the Edit details save went through (grade 14 -> 13, still tier 1)",
        one("SELECT job_grade FROM users WHERE id=?", (SUBJ["SAME"],)) in (13, "13"), r.status_code)
s.check("...and the rating's rows are byte-identical", snapshot(A_SAME) == before)
s.check("a tier-moved test says so both ways", ctx(lambda d: (a._fb_tier_moved(d, 14, 13), a._fb_tier_moved(d, 14, 15),
                                                              a._fb_tier_moved(d, "H", 12))) == (False, True, False))

# ---------------------------------------------------------------------------------------------------------------------
s.section("the admin person page's Edit details moves a pending rating and leaves a submitted one (the real writer)")
A_P = assign("ONE")
open_card(A_P, "ONE")
answer(A_P, ST[1][:2], "yes")
# a second rater, so ONE subject carries a pending AND a submitted rating at tier 1
with a.app.app_context():
    d = a.get_db()
    R2 = d.execute("INSERT INTO users(username, full_name, password_hash, role, employee_id, business_group, company, "
                   "department, job_title, job_grade, confirmation_date, years_of_service, joined_date) VALUES "
                   "('zzfr-r2','ZZ FR Rater Two','x','user','ZZFR-R2',?,?,'ZZFR Ops','Executive',16,'2013-12-18',4.0,"
                   "'2013-11-18')", (BG, CO)).lastrowid
    A_S = d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, submitted_at) "
                    "VALUES (?,?,?,'peer','submitted','2026-11-01 09:00:00')", (CID, SUBJ["ONE"], R2)).lastrowid
    d.commit()
open_card(A_S, "ONE")
answer(A_S, ST[1], ["yes", "no", "yes"])
snap_s = snapshot(A_S)
score_s = counts(A_S)
r = edit_grade("ONE", 15)
s.check("the save went through (14 -> 15)", one("SELECT job_grade FROM users WHERE id=?", (SUBJ["ONE"],)) in (15, "15"))
s.check("the PENDING rating moved at once: tier 2's rows only, none of tier 1's, the old answers gone",
        tier_rows(A_P) == {2: [None] * N[2]}, tier_rows(A_P))
s.check("the SUBMITTED rating is byte-identical, and so is its score",
        snapshot(A_S) == snap_s and counts(A_S) == score_s, (counts(A_S), score_s))
s.check("nothing else was written to it: still tier 1's rows", set(tier_rows(A_S)) == {1})

# ---------------------------------------------------------------------------------------------------------------------
s.section("OH-H-0083: 2 old answered + 12 old blank + 14 current answered -> the gate passes and Submit goes through")
A_83 = assign("RAW")
open_card(A_83, "RAW")
answer(A_83, ST[1][:2], "yes")                                   # 2 old answered, the rest of tier 1 blank
set_grade_raw("RAW", 15)                                          # moved after the rater opened the card, no hook
with a.app.app_context():
    d = a.get_db()
    for i, sid in enumerate(ST[2]):                               # ...and the rater answered every current behaviour
        d.execute("INSERT INTO responses(assignment_id, statement_id, answer) VALUES (?,?,?)",
                  (A_83, sid, "yes" if i % 3 else "no"))
    d.commit()
held = tier_rows(A_83)
s.check("precondition: the rating holds both tiers, as production's 95579 did",
        len(held.get(1, [])) == N[1] and len(held.get(2, [])) == N[2] and held[1].count(None) == N[1] - 2, {k: len(v) for k, v in held.items()})
(tot, un), (sc, mx, ans_n) = counts(A_83)
indep_max = sum((a.SCORE_FUTURE if f else a.SCORE_CURRENT) for (f,) in q(
    "SELECT is_future FROM cycle_statements WHERE cycle_id=? AND tier_n=2", (CID,)))
s.check("the gate counts the CURRENT tier only: nothing unanswered", (tot, un) == (N[2], 0), (tot, un))
s.check("...and so does the score (max and answered are tier 2's)", mx == indep_max and ans_n == N[2], (mx, indep_max, ans_n))
with a.app.app_context():
    d = a.get_db()
    arow = d.execute("SELECT * FROM assignments WHERE id=?", (A_83,)).fetchone()
    blk = a._fb_submit_blockers(d, dict(d.execute("SELECT * FROM users WHERE id=?", (RATER,)).fetchone()), CID, arow)
s.check("_fb_submit_blockers no longer says '%d behaviour(s) still unanswered'", "still unanswered" not in str(blk[1]), blk)
# the card's own tool: nothing listed as unanswered
with a.app.test_request_context("/"):
    from flask import session
    session["user_id"] = RATER
    d = a.get_db()
    ru = dict(d.execute("SELECT * FROM users WHERE id=?", (RATER,)).fetchone())
    pr = a._FEEDBACK_TOOLS["prepare_feedback_submit"](d, ru, CID, {"assignment_id": A_83})
s.check("prepare_feedback_submit does not list an unanswered behaviour (an old-tier one would have been named)",
        not pr.get("unanswered_statement_ids") and "unanswered" not in str(pr.get("error") or ""), pr)
rem_need = pr.get("ok") is False
if rem_need:   # a remark was asked for: write it (the rating's band decides), then the human Submit
    with a.app.test_request_context("/"):
        from flask import session
        session["user_id"] = RATER
        d = a.get_db()
        ru = dict(d.execute("SELECT * FROM users WHERE id=?", (RATER,)).fetchone())
        a._FEEDBACK_TOOLS["set_feedback_remark"](d, ru, CID, {"assignment_id": A_83, "text":
            "They rebuilt the delivery schedule with the warehouse team and called the client daily until it shipped, "
            "and the account renewed."})
rj = post(RAT, "/review/feedback/submit", assignment_id=str(A_83)).get_json()
s.check("Submit goes through (the human route, the gate and the write)", rj and rj.get("ok") and rj.get("submitted"), rj)
s.check("...the rating is submitted holding ONE tier (the old rows went before it was locked)",
        one("SELECT status FROM assignments WHERE id=?", (A_83,)) == "submitted" and set(tier_rows(A_83)) == {2}
        and len(tier_rows(A_83)[2]) == N[2], {k: len(v) for k, v in tier_rows(A_83).items()})
s.check("...so its stored score is one tier's: max is tier 2's", counts(A_83)[1][1] == indep_max, counts(A_83)[1])

# ---------------------------------------------------------------------------------------------------------------------
s.section("the lazy net: a grade changed with no hook is right on every read; the next answer prunes")
A_L = assign("RAW2")
open_card(A_L, "RAW2")
answer(A_L, ST[1][:5], "yes")
set_grade_raw("RAW2", 15)
rows_before = snapshot(A_L)
(tot, un), (sc, mx, ans_n) = counts(A_L)
s.check("with only the old tier's rows left: nothing to rate counts (0 total), never 'N still unanswered'",
        (tot, un) == (0, 0) and ans_n == 0 and mx == 0, ((tot, un), (sc, mx, ans_n)))
fa = ctx(lambda d: a._feedback_assignments(d, dict(d.execute("SELECT * FROM users WHERE id=?", (RATER,)).fetchone()), CID))
mine = [x for x in fa if x["assignment_id"] == A_L]
s.check("the colleague list's progress falls back to the framework size for the NEW tier, nothing answered",
        mine and mine[0]["total"] == N[2] and mine[0]["answered"] == 0, mine)
with a.app.test_request_context("/"):
    from flask import session
    session["user_id"] = RATER
    d = a.get_db()
    ru = dict(d.execute("SELECT * FROM users WHERE id=?", (RATER,)).fetchone())
    ov = a._feedback_overview(d, ru, A_L)
s.check("a GET writes nothing: reading the card, gate and progress left every row as it was", snapshot(A_L) == rows_before)
# then the rater answers one behaviour: the lazy net moves the rating
with a.app.test_request_context("/"):
    from flask import session
    session["user_id"] = RATER
    d = a.get_db()
    ru = dict(d.execute("SELECT * FROM users WHERE id=?", (RATER,)).fetchone())
    rr = a._FEEDBACK_TOOLS["rate_behaviour"](d, ru, CID, {"assignment_id": A_L, "statement_id": ST[2][0], "answer": "yes"})
s.check("the next answer succeeds, reports progress on the new tier (1 of the tier's total)",
        rr.get("ok") and rr.get("answered") == 1 and rr.get("total") == N[2], rr)
s.check("...and pruned the old tier's rows", tier_rows(A_L) == {2: ["yes"] + [None] * (N[2] - 1)}, tier_rows(A_L))

# the card's own "still unanswered" list names this colleague's current tier only (25 old blanks must not be named)
set_grade_raw("SAME", 15)
with a.app.app_context():
    d = a.get_db()
    d.execute("INSERT INTO responses(assignment_id, statement_id, answer) VALUES (?,?,NULL)", (A_SAME, ST[2][0]))
    d.commit()
with a.app.test_request_context("/"):
    from flask import session
    session["user_id"] = RATER
    d = a.get_db()
    ru = dict(d.execute("SELECT * FROM users WHERE id=?", (RATER,)).fetchone())
    pu = a._FEEDBACK_TOOLS["prepare_feedback_submit"](d, ru, CID, {"assignment_id": A_SAME})
s.check("prepare_feedback_submit names only the current tier's unanswered behaviour (1), not the 25 blank old-tier ones",
        pu.get("unanswered_statement_ids") == [ST[2][0]] and "1 behaviour(s) still unanswered" in (pu.get("error") or ""), pu)
set_grade_raw("SAME", 13)
with a.app.app_context():
    d = a.get_db()
    d.execute("DELETE FROM responses WHERE assignment_id=? AND statement_id=?", (A_SAME, ST[2][0]))
    d.commit()

# a half-moved rating (old rows AND some current rows): every reader counts the current tier only
A_H = assign("ROS1")
open_card(A_H, "ROS1")
answer(A_H, ST[1], "no")                                         # tier 1 all answered 'no'
set_grade_raw("ROS1", 15)
with a.app.app_context():
    d = a.get_db()
    d.execute("INSERT INTO responses(assignment_id, statement_id, answer) VALUES (?,?,'yes')", (A_H, ST[2][0]))
    d.execute("INSERT INTO responses(assignment_id, statement_id, answer) VALUES (?,?,NULL)", (A_H, ST[2][1]))
    d.commit()
(tot, un), (sc, mx, ans_n) = counts(A_H)
w2 = [(a.SCORE_FUTURE if f else a.SCORE_CURRENT) for (f,) in q(
    "SELECT cs.is_future FROM responses r JOIN cycle_statements cs ON cs.id=r.statement_id WHERE r.assignment_id=? "
    "AND cs.tier_n=2 ORDER BY r.id", (A_H,))]
s.check("gate: 2 rows, 1 unanswered (the 'no' answers to tier 1 do not count)", (tot, un) == (2, 1), (tot, un))
s.check("score: only the one current 'yes' (not 'all answered no')", (sc, mx, ans_n) == (w2[0], sum(w2), 1), (sc, mx, ans_n))
s.check("all-developing: the old tier's 'no' answers do not make it so",
        ctx(lambda d: a._fb_all_developing(d, A_H)) is False)
ov_ = ctx(lambda d: a._fb_row_counts(d, [A_H, A_SUBM, A_83]))
s.check("the shared counts: pending -> current tier only; submitted -> every row it holds",
        ov_[A_H] == {"t": 2, "d": 1, "y": 1, "n": 0}
        and ov_[A_SUBM]["t"] == N[1] and ov_[A_83]["t"] == N[2], ov_)

sr = ctx(lambda d: a.subject_result(d, d.execute("SELECT * FROM users WHERE id=?", (SUBJ["ROS1"],)).fetchone(), CID))
sr_a = [x for x in sr["assessors"] if x["assignment_id"] == A_H]
s.check("the subject's result page row for the pending rating counts the current tier only (1 answered, not 29)",
        sr_a and sr_a[0]["answered"] == 1, sr_a and sr_a[0]["answered"])

# the Excel download leaves another tier's rows of a pending rating out (they are not answers to the subject's behaviours)
xl = SUP.get("/admin/export/responses.xlsx?cycle=%d" % CID)
try:
    import io
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(xl.data), read_only=True)
    mine_rows = [row for ws in wb.worksheets for row in ws.iter_rows(values_only=True) if "ZZFR-ROS1" in [str(c) for c in row]]
    t1 = {one("SELECT text FROM cycle_statements WHERE id=?", (sid,)) for sid in ST[1]}
    t2 = {one("SELECT text FROM cycle_statements WHERE id=?", (sid,)) for sid in ST[2]}
    s.check("the responses download: the half-moved rating shows its 2 tier-2 rows and none of its 28 tier-1 rows",
            len(mine_rows) == 2 and all(any(str(c) in t2 for c in row) for row in mine_rows)
            and not any(str(c) in t1 - t2 for row in mine_rows for c in row), len(mine_rows))
except ImportError:
    s.note("openpyxl is not installed here: the download check is skipped")

# ---------------------------------------------------------------------------------------------------------------------
s.section("a submitted rating of the old tier: untouched by a grade move and by anything that opens its card")
snap = snapshot(A_SUBM)
sc0 = counts(A_SUBM)
with a.app.app_context():
    d = a.get_db()
    a.ensure_responses(d, A_SUBM, d.execute("SELECT * FROM users WHERE id=?", (SUBJ["SUB"],)).fetchone(), CID)   # the /rate GET
s.check("ensure_responses on a submitted rating that has its rows adds nothing (it used to insert the new tier's blanks)",
        snapshot(A_SUBM) == snap)
edit_grade("SUB", 17)
s.check("...nor does a further grade move through the real writer", snapshot(A_SUBM) == snap and counts(A_SUBM) == sc0)

# ---------------------------------------------------------------------------------------------------------------------
s.section("the People roster import moves pending ratings once, batched, and not submitted ones")
A_R1, A_R2, A_R3 = assign("ROS2"), assign("ROS3"), None
open_card(A_R1, "ROS2")
open_card(A_R2, "ROS3")
answer(A_R1, ST[1][:4], "yes")
answer(A_R2, ST[1][:1], "no")
# ROS3 has its own submitted rating by another rater, to show the import leaves it
with a.app.app_context():
    d = a.get_db()
    A_R3 = d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, submitted_at) "
                     "VALUES (?,?,?,'peer','submitted','2026-11-01 09:00:00')", (CID, SUBJ["ROS3"], R2)).lastrowid
    d.commit()
open_card(A_R3, "ROS3")
answer(A_R3, ST[1], "yes")
snap_r3 = snapshot(A_R3)


def rec(eid, name, grade):
    return {"employee id": eid, "employee name": name, "business group": BG, "company": CO, "manager": "ZZFR-MGR",
            "job grade": str(grade), "joined date": "2013-11-18",
            "work email": eid.lower() + "@example.com"}


ME = None
ctx_ = a.app.test_request_context("/")
ctx_.push()
db = a.get_db()
ME = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
seen_sql = []
chk = a._roster_check(db, ME, [rec("ZZFR-ROS2", "ZZ FR ROS2", 15), rec("ZZFR-ROS3", "ZZ FR ROS3", 15)], False)
assert not chk["errors"], chk["errors"]
db.set_trace_callback(lambda x: seen_sql.append(x))
a._roster_apply(db, ME, chk)
db.set_trace_callback(None)
db.commit()
s.check("the file moved both people to JG 15", [r[0] for r in db.execute(
    "SELECT job_grade FROM users WHERE employee_id IN ('ZZFR-ROS2','ZZFR-ROS3') ORDER BY employee_id")] == [15, 15]
        or [str(r[0]) for r in db.execute("SELECT job_grade FROM users WHERE employee_id IN ('ZZFR-ROS2','ZZFR-ROS3')")] == ["15", "15"])
s.check("both PENDING ratings are on tier 2 now", tier_rows(A_R1) == {2: [None] * N[2]} and tier_rows(A_R2) == {2: [None] * N[2]},
        (tier_rows(A_R1), tier_rows(A_R2)))
s.check("the SUBMITTED rating the same person has is byte-identical", snapshot(A_R3) == snap_r3)
dels = [x for x in seen_sql if x.lstrip().upper().startswith("DELETE FROM RESPONSES")]
ins = [x for x in seen_sql if x.lstrip().upper().startswith("INSERT OR IGNORE INTO RESPONSES")]
s.check("it is ONE batched pass: one DELETE and one INSERT for the two people (not a pass per row)",
        len(dels) == 1 and len(ins) == 1, (len(dels), len(ins)))
# a file that changes no grade to another tier touches no ratings
seen_sql.clear()
chk = a._roster_check(db, ME, [rec("ZZFR-ROS2", "ZZ FR ROS2", 15)], False)
db.set_trace_callback(lambda x: seen_sql.append(x))
a._roster_apply(db, ME, chk)
db.set_trace_callback(None)
db.commit()
s.check("a file that moves nobody's tier writes no response rows",
        not [x for x in seen_sql if "INTO RESPONSES" in x.upper() or "FROM RESPONSES" in x.upper()
             and x.lstrip().upper().startswith("DELETE")])
# the batch: many subjects, still one DELETE and one INSERT per tier
many = [SUBJ[k] for k in ("ROS2", "ROS3", "ONE", "SAME")]
seen_sql.clear()
db.set_trace_callback(lambda x: seen_sql.append(x))
a._fb_retier_pending(db, subject_id=many)
db.set_trace_callback(None)
s.check("a list of subjects is read in one query and written in one DELETE + one INSERT per tier (not per person)",
        len([x for x in seen_sql if "FROM assignments a JOIN users" in x]) == 1
        and len([x for x in seen_sql if x.lstrip().upper().startswith("DELETE FROM RESPONSES")]) <= 2
        and len([x for x in seen_sql if x.lstrip().upper().startswith("INSERT OR IGNORE INTO RESPONSES")]) <= 2,
        [x[:70] for x in seen_sql])
ctx_.pop()

# ---------------------------------------------------------------------------------------------------------------------
s.section("a cycle's own tier bands: set and clear move pending ratings, leave submitted ones")
A_B, A_BS = assign("BAND"), None
set_grade_raw("BAND", 15)
set_grade_raw("BANDSUB", 15)
with a.app.app_context():
    d = a.get_db()
    A_BS = d.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, submitted_at) "
                     "VALUES (?,?,?,'peer','submitted','2026-11-01 09:00:00')", (CID, SUBJ["BANDSUB"], RATER)).lastrowid
    d.commit()
for aid, who in ((A_B, "BAND"), (A_BS, "BANDSUB")):
    open_card(aid, who)
answer(A_B, ST[2][:3], "yes")
answer(A_BS, ST[2], ["yes", "no"])
snap_bs = snapshot(A_BS)
rules = {"action": "set_rules", "cycle_id": str(CID), "panel_size": "6", "min_valid": "3",
         "tier1_min": "12", "tier1_max": "15", "tier2_min": "16", "tier2_max": "17",
         "tier3_min": "18", "tier3_max": "20", "tier4_min": "21", "tier4_max": "23"}
r = post(SUP, "/admin/cycles", **rules)
s.check("the cycle's own bands were saved (tier 1 now runs to JG 15)",
        q("SELECT tiers_json FROM cycles WHERE id=?", (CID,))[0][0] is not None
        and '"max": 15' in one("SELECT tiers_json FROM cycles WHERE id=?", (CID,)), r.status_code)
s.check("JG 15 is tier 1 now: the PENDING rating moved back to tier 1's behaviours, blank",
        tier_rows(A_B) == {1: [None] * N[1]}, {k: len(v) for k, v in tier_rows(A_B).items()})
s.check("the SUBMITTED rating of the same grade is byte-identical", snapshot(A_BS) == snap_bs)
post(SUP, "/admin/cycles", action="clear_rules", cycle_id=str(CID))
s.check("clearing the cycle's own bands moves it to tier 2 again", tier_rows(A_B) == {2: [None] * N[2]},
        {k: len(v) for k, v in tier_rows(A_B).items()})
s.check("...and the submitted one is still untouched", snapshot(A_BS) == snap_bs)
# a rules post that leaves the tier bands as they are does no retier (planted: a stray tier-1 row survives it)
rules_same = dict(rules, tier1_max="14", tier2_min="15", tier2_max="17")
post(SUP, "/admin/cycles", **rules_same)
with a.app.app_context():
    d = a.get_db()
    d.execute("INSERT OR IGNORE INTO responses(assignment_id, statement_id, answer) VALUES (?,?,'yes')", (A_B, ST[1][0]))
    d.commit()
post(SUP, "/admin/cycles", **dict(rules_same, panel_size="7"))
s.check("a rules post that leaves the tier bands as they are does not rewrite any rating",
        1 in tier_rows(A_B) and len(tier_rows(A_B)[1]) == 1, {k: len(v) for k, v in tier_rows(A_B).items()})
post(SUP, "/admin/cycles", action="clear_rules", cycle_id=str(CID))
with a.app.app_context():   # the planted row out again
    d = a.get_db()
    d.execute("DELETE FROM responses WHERE assignment_id=? AND statement_id=?", (A_B, ST[1][0]))
    d.commit()

# the DEFAULT bands (Settings): the active cycle with no override follows
A_D = assign("DEF")
set_grade_raw("DEF", 17)
open_card(A_D, "DEF")
answer(A_D, ST[2][:2], "yes")
dflt = dict(rules, action="rules", tier2_min="15", tier2_max="16", tier3_min="17", tier3_max="20")
dflt.pop("cycle_id")
dflt["tier1_max"] = "14"
dflt["tier2_min"], dflt["tier2_max"] = "15", "16"
dflt["tier3_min"], dflt["tier3_max"] = "17", "20"
dflt["remark"] = "ZZFR test"
post(SUP, "/admin/settings", **dflt)
s.check("the default bands saved (JG 17 is tier 3 now)", '"min": 17' in ((q("SELECT value FROM app_settings WHERE key='tiers'") or [("",)])[0][0]))
s.check("...and the active cycle's PENDING rating of a JG 17 person moved to tier 3", tier_rows(A_D) == {3: [None] * N[3]},
        {k: len(v) for k, v in tier_rows(A_D).items()})
with a.app.app_context():
    d = a.get_db()
    d.execute("DELETE FROM app_settings WHERE key='tiers'")   # put the defaults back (the fresh copy held none)
    d.commit()

# ---------------------------------------------------------------------------------------------------------------------
s.section("put everything back")
with a.app.app_context():
    d = a.get_db()
    d.execute("UPDATE cycles SET tiers_json=NULL WHERE id=?", (CID,))
    d.commit()
ai_draft.review_agent_available, ai_draft.review_agent = _avail0, _agent0
s.check("the cycle's tier bands are the defaults again", q("SELECT tiers_json FROM cycles WHERE id=?", (CID,))[0][0] is None
        and one("SELECT COUNT(*) FROM app_settings WHERE key='tiers'") == 0)
sys.exit(s.done())
