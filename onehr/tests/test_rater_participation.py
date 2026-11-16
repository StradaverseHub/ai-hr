"""A rater sees, counts and submits a 360 only for a colleague who takes part in the 360 (Chris, 2026-10-30: "out means out").

Production had 19 people who are not taking part (not confirmed, so on the Basic user role) and still carried an active
panel row each, so from 2 Nov their raters would have seen them on the journey list, counted them in every "N to rate",
and been able to open, save and submit a 360 for someone who is not being reviewed. The rule is participant_sql(..,
"tm_rated") for a list (rater_task_sql, ANDed into every rater-facing reader of a person's OWN assessor rows) and
_report_takes_part for one row (_rater_task_refusal, the one-row gate the journey tools, /rate, the shared submit and the
AI draft route all ask). A panel row of another cycle is history and always passes; admin pages keep every row.

What this suite holds, with one Full rater R who rates five colleagues and a second rater R2 whose only row is out:
  * IN (confirmed, Full) and ADDED (Basic, added by an admin on Participants) are rated; OUT (not confirmed), TAKEN_OUT
    (taken out on Participants, row left active), LEFT and LOW (below the cycle's minimum grade) are not
  * the journey list (_feedback_assignments), the pending count, the journey stage's n_total / n_open, the dashboard task,
    the record view's count, leader progress counts (lp_counts) and the release-window email's raters follow it, by
    relationship; the MCP's own-360 count too (when it is reachable)
  * R2, whose only row is out, owes nothing: no 360 task, no 360 cell on the pill
  * every one-row door refuses an out colleague with the plain sentence and writes nothing: the journey submit route, the
    two submit functions called directly, /rate (GET, POST, autosave POST: no responses row created) and the AI draft
    route (the model is never called); the same route DOES submit an in-colleague's fully answered row (the control)
  * the admin side still sees the out rows (the person's panel and the owing list are untouched)
Synthetic ZZRP people only; a fresh_db suite, so Suite.done() puts the scratch copy back.
"""
import atexit
import contextlib
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
import ai_draft  # noqa: E402
_FINISHED = False
atexit.register(lambda: None if _FINISHED else H.restore_db())   # a crash must not leave its ZZRP people for the next suite
s = H.Suite("A rater's 360 lists and writers follow the colleague's participation")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)

# the AI draft route's guard sits behind the "feature on" gate and before the model: switch the gate on, and make the model
# a sentinel that records a call (the guard must stop an out colleague before it)
_ai0 = (ai_draft.is_configured, ai_draft.draft, ai_draft.review_agent_available)
DRAFT_CALLS = []
ai_draft.is_configured = lambda: True
ai_draft.draft = lambda *x, **k: (DRAFT_CALLS.append(x), "ZZ reworded")[1]
ai_draft.review_agent_available = lambda: False   # the classic /rate page is served (with the AI+ way on it is a redirect)


@contextlib.contextmanager
def D():
    """A request context of its own: nothing cached across checks (the roles map, windows, the leader abilities)."""
    with a.app.test_request_context("/"):
        yield a.get_db()


def post(c, url, **form):
    form.setdefault("csrf_token", "tok")
    return c.post(url, data=form)


# ------------------------------------------------------------------------------------------------ the people
with D() as db:
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key IN ('review','tm','idp','pm')")
    db.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES('review_unified','1')")
    MG = a.active_cycle(db)["min_job_grade"]
    if MG is None:
        db.execute("UPDATE cycles SET min_job_grade=12 WHERE id=?", (CID,))
        MG = 12
    base = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 AND business_group "
                      "IN (SELECT business_group FROM pm_bg_config WHERE mechanism='A') LIMIT 1").fetchone()
    if base is None:   # the generated fixture (a worktree has no leadership360.db): give one group the 1-5 ladder
        base = db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL AND is_demo=0 LIMIT 1").fetchone()
        db.execute("INSERT OR REPLACE INTO pm_bg_config(business_group, mechanism, variant) VALUES (?, 'A', NULL)",
                   (base["business_group"],))
    base = dict(base)
    cols = [c for c in base if c != "id"]
    GRADE, LOW_GRADE = str(max(int(MG), 14)), str(int(MG) - 1)

    def mk(tag, confirmed=True, grade=None, left=False):
        eid = "ZZRP-" + tag
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ Rater " + tag, display_name=None, email=None,
                 manager_id=None, hod_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, role="user", is_demo=0,
                 confirmation_date="2020-01-01" if confirmed else None, years_of_service=5 if confirmed else 0.5,
                 left_at="2026-10-01" if left else None, job_grade=grade or GRADE, user_role_id=None)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v.get(c) for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    R, R2 = mk("R"), mk("R2", confirmed=False)
    IN = mk("IN")
    ADDED = mk("ADDED", confirmed=False)
    OUT = mk("OUT", confirmed=False)        # fully answered: only the guard can stop its submit
    OUT2 = mk("OUT2", confirmed=False)      # never opened: /rate must not create its responses
    TAKEN_OUT = mk("TAKENOUT")
    LEFT = mk("LEFT", left=True)
    LOW = mk("LOW", grade=LOW_GRADE)
    db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode, set_by) VALUES (?,?,'add',?)",
               (CID, ADDED, SU["id"]))
    db.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode, set_by) VALUES (?,?,'remove',?)",
               (CID, TAKEN_OUT, SU["id"]))
    OUTS = [OUT, OUT2, TAKEN_OUT, LEFT, LOW]
    RATED = [IN, ADDED]
    NAME = {R: "R", R2: "R2", IN: "IN", ADDED: "ADDED", OUT: "OUT", OUT2: "OUT2", TAKEN_OUT: "TAKEN_OUT", LEFT: "LEFT",
            LOW: "LOW"}
    AID = {}
    for sid in RATED + OUTS:
        db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) "
                   "VALUES (?,?,?,'peer','pending')", (CID, sid, R))
        AID[sid] = db.execute("SELECT id FROM assignments WHERE cycle_id=? AND subject_id=? AND assessor_id=?",
                              (CID, sid, R)).fetchone()[0]
    db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) "
               "VALUES (?,?,?,'peer','pending')", (CID, OUT2, R2))
    AID2 = db.execute("SELECT id FROM assignments WHERE cycle_id=? AND subject_id=? AND assessor_id=?",
                      (CID, OUT2, R2)).fetchone()[0]

    def answer_all(sid):
        """Every behaviour answered (one Yes, the rest No: no overall remark is needed): the row is ready to submit."""
        subj = db.execute("SELECT * FROM users WHERE id=?", (sid,)).fetchone()
        a.ensure_responses(db, AID[sid], subj, CID)
        ids = [r[0] for r in db.execute("SELECT id FROM responses WHERE assignment_id=? ORDER BY id", (AID[sid],))]
        for i, rid in enumerate(ids):
            db.execute("UPDATE responses SET answer=? WHERE id=?", ("yes" if i == 0 else "no", rid))
        return len(ids)
    N_IN, N_OUT = answer_all(IN), answer_all(OUT)
    db.commit()
s.check("fixture: the colleagues have behaviours to rate", N_IN > 1 and N_OUT > 1, (N_IN, N_OUT))

NOW = None
with D() as db:
    NOW = a._now_myt()
fmt = lambda d: d.strftime("%Y-%m-%d %H:%M")  # noqa: E731


def windows():
    """Only the 360 is open (the raters' window); every other part of the calendar is closed."""
    with D() as db:
        db.execute("DELETE FROM cycle_windows WHERE cycle_id=?", (CID,))
        for cell in a.WINDOW_KEYS:
            op, cl = ((NOW - timedelta(days=2), NOW + timedelta(days=5)) if cell == "f360" else
                      (NOW - timedelta(days=9), NOW - timedelta(days=1)))
            db.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?,?,?,?)",
                       (CID, cell, fmt(op), fmt(cl)))
        db.commit()


windows()


def names(ids):
    return sorted(NAME.get(i, i) for i in ids)


def counts():
    """How much of each out colleague's work is on file: (responses, comments, remarks, assignments still pending)."""
    with D() as db:
        return {sid: tuple(db.execute(q, (AID[sid],)).fetchone()[0] for q in (
            "SELECT COUNT(*) FROM responses WHERE assignment_id=?",
            "SELECT COUNT(*) FROM responses WHERE assignment_id=? AND answer IS NOT NULL",
            "SELECT COUNT(*) FROM feedback_remarks WHERE assignment_id=?",
            "SELECT COUNT(*) FROM assignments WHERE id=? AND status='pending' AND submitted_at IS NULL"))
                for sid in OUTS}


def user(i):
    with D() as db:
        return dict(db.execute("SELECT * FROM users WHERE id=?", (i,)).fetchone())


EXPECT = len(RATED)

# ================================================================================================ the rule itself
s.section("who takes part in the 360: the rule the lists and the gates share")
with D() as db:
    tp = {sid: a._report_takes_part(db, sid, "tm_rated") for sid in RATED + OUTS}
    sql_in = {sid: db.execute("SELECT 1 FROM users WHERE id=? AND " + a.participant_sql("", "tm_rated"),
                              (sid,)).fetchone() is not None for sid in RATED + OUTS}
    s.check("IN and ADDED take part; OUT, TAKEN_OUT, LEFT and LOW do not (Python rule)",
            all(tp[x] for x in RATED) and not any(tp[x] for x in OUTS), {NAME[k]: v for k, v in tp.items()})
    s.check("SQL and Python agree for every colleague", sql_in == tp, {NAME[k]: v for k, v in sql_in.items()})
    on_list = {r[0] for r in db.execute("SELECT subject_id FROM assignments WHERE assessor_id=? AND cycle_id=? AND archived=0 "
                                        "AND " + a.rater_task_sql("assignments"), (R, CID))}
    on_list_a = {r[0] for r in db.execute("SELECT a.subject_id FROM assignments a WHERE a.assessor_id=? AND a.cycle_id=? "
                                          "AND a.archived=0 AND " + a.rater_task_sql("a"), (R, CID))}
    s.check("rater_task_sql keeps exactly the colleagues who take part (both with an alias and with the table name)",
            on_list == set(RATED) == on_list_a, names(on_list))
    other = db.execute("SELECT id FROM cycles WHERE id!=? LIMIT 1", (CID,)).fetchone()
    if other is None:
        db.execute("INSERT INTO cycles(name, year, half, is_active) VALUES ('ZZRP old', 2020, 2, 0)")
        other = db.execute("SELECT id FROM cycles WHERE name='ZZRP old'").fetchone()
    OLD = other[0]
    db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) "
               "VALUES (?,?,?,'peer','submitted')", (OLD, OUT, R))
    old_ok = db.execute("SELECT 1 FROM assignments WHERE cycle_id=? AND subject_id=? AND assessor_id=? AND "
                        + a.rater_task_sql("assignments"), (OLD, OUT, R)).fetchone()
    old_row = db.execute("SELECT * FROM assignments WHERE cycle_id=? AND subject_id=? AND assessor_id=?",
                         (OLD, OUT, R)).fetchone()
    s.check("a panel row of another cycle is history: it passes the list gate and the one-row gate, whoever the subject",
            old_ok is not None and a._rater_task_refusal(db, old_row) is None)
    s.check("the one-row gate gives the plain sentence for an out colleague and nothing for one who takes part",
            all(a._rater_task_refusal(db, db.execute("SELECT * FROM assignments WHERE id=?", (AID[x],)).fetchone())
                == "The 360 isn't part of this person's review this cycle." for x in OUTS)
            and not any(a._rater_task_refusal(db, db.execute("SELECT * FROM assignments WHERE id=?", (AID[x],)).fetchone())
                        for x in RATED))
    db.execute("DELETE FROM assignments WHERE cycle_id=? AND subject_id=? AND assessor_id=?", (OLD, OUT, R))
    db.commit()

# ================================================================================================ the lists and counts
s.section("R's lists and counts hold the colleagues who take part, and none who is out")
with D() as db:
    ru = db.execute("SELECT * FROM users WHERE id=?", (R,)).fetchone()
    cyc = a.active_cycle(db)
    fa = a._feedback_assignments(db, ru, CID)
    got = {x["subject_id"] for x in fa}
    s.check("the journey list (_feedback_assignments) holds IN and ADDED and none of the out ones",
            got == set(RATED) and not got & set(OUTS), names(got))
    s.check("the pending count (_assessor_pending_count) equals the colleagues who take part",
            a._assessor_pending_count(db, ru) == EXPECT, a._assessor_pending_count(db, ru))
    st = a.review_state(db, ru)
    fb = next(x for x in st["stages"] if x["key"] == "feedback")
    s.check("the journey's 360 stage counts only them (n_total and n_open)", fb["n_total"] == EXPECT and fb["n_open"] == EXPECT,
            (fb["n_total"], fb["n_open"]))
    tk = [t for t in a.dash_tasks(db, ru) if t.get("key") == "360"]
    s.check("the dashboard's 360 task totals only them", len(tk) == 1 and tk[0]["total"] == EXPECT,
            [(t.get("key"), t.get("total")) for t in a.dash_tasks(db, ru)])
    steps = [x for x in a.dash_journey_done(db, ru, CID) if x.get("name") == "360 Feedback"]
    s.check("the record view's 360 count is out of only them", len(steps) == 1 and steps[0]["count"].endswith(" of %d" % EXPECT),
            [x.get("count") for x in steps])
    lp = a.lp_counts(db, cyc, ["f360"])
    s.check("leader progress counts (lp_counts f360) count only them for R", (lp["_by"]["f360"].get(R) or (0, 0))[0] == EXPECT,
            lp["_by"]["f360"].get(R))
    s.check("the 360 cell is on R's pill", "f360" in a._pill_my_cells(db, ru, cyc))
    s.check("R is still a rater of this cycle (the Mine tab's gate)", a._review_gives_360(db, ru) and a._review_owes_360(db, ru))
    got_n = {r["id"] for r in (u for u, _l in a.notice_recipients(db, cyc, NOW))}
    s.check("the release-window email's raters include R", R in got_n)

    r2u = db.execute("SELECT * FROM users WHERE id=?", (R2,)).fetchone()
    s.check("R2, whose only row is out, owes nothing: not a giver, not an owner of a 360",
            not a._review_gives_360(db, r2u) and not a._review_owes_360(db, r2u))
    s.check("R2 has no 360 cell on the pill", "f360" not in a._pill_my_cells(db, db.execute(
        "SELECT * FROM users WHERE id=?", (R2,)).fetchone(), cyc))
    s.check("R2 has nothing on the journey list and nothing pending", not a._feedback_assignments(db, r2u, CID)
            and a._assessor_pending_count(db, r2u) == 0)
    s.check("R2 gets no 360 task on the dashboard", not [t for t in a.dash_tasks(db, r2u) if t.get("key") == "360"])
    s.check("R2 is not among the release-window email's raters", R2 not in {u["id"] for u, _l in a.notice_recipients(db, cyc, NOW)})
    lp2 = a.lp_counts(db, cyc, ["f360"])
    s.check("R2 has no leader-progress count", not lp2["_by"]["f360"].get(R2), lp2["_by"]["f360"].get(R2))

s.section("the person's own MCP count follows it too")
with D() as db:
    n_mcp = db.execute("SELECT COUNT(*) AS n FROM assignments WHERE assessor_id=? AND cycle_id=? AND archived=0 AND "
                       + a.rater_task_sql("assignments"), (R, CID)).fetchone()["n"]
    s.check("the statement the MCP's own-360 count runs (rater_task_sql with the table name) counts only them", n_mcp == EXPECT, n_mcp)
src_mcp = open(os.path.join(H.REPO, "onehr_mcp.py"), encoding="utf-8").read()
s.check("onehr_mcp.py's own-360 count carries the helper", 'A.rater_task_sql("assignments")' in src_mcp)

# ================================================================================================ the submit path
s.section("the submit path refuses an out colleague with the sentence, and writes nothing")
WORDS = a._report_part_refusal("tm_rated")
C_R = H.client_as(a, R)
before = counts()
r = post(C_R, "/review/feedback/submit", assignment_id=str(AID[OUT]))
j = r.get_json() or {}
s.check("POST /review/feedback/submit for OUT: refused with the sentence, not submitted",
        r.status_code == 400 and j.get("ok") is False and j.get("error") == WORDS, (r.status_code, j))
with D() as db:
    row = db.execute("SELECT status FROM assignments WHERE id=?", (AID[OUT],)).fetchone()
    ru = db.execute("SELECT * FROM users WHERE id=?", (R,)).fetchone()
    ok1, err1 = a._fb_do_submit(db, ru, AID[OUT])
    arow = db.execute("SELECT * FROM assignments WHERE id=?", (AID[OUT],)).fetchone()
    subj = db.execute("SELECT * FROM users WHERE id=?", (OUT,)).fetchone()
    ok2, err2 = a._feedback_submit(db, arow, subj)
    own, e3 = a._feedback_own_assignment(db, ru, CID, AID[OUT])
s.check("the row is still pending after the route", row["status"] == "pending")
s.check("_fb_do_submit called directly refuses with the sentence", (ok1, err1) == (False, WORDS), (ok1, err1))
s.check("_feedback_submit (the one submit authority) called directly refuses with the sentence", (ok2, err2) == (False, WORDS),
        (ok2, err2))
s.check("_feedback_own_assignment (every journey tool, save-all and remark) gives the sentence and no row",
        own is None and e3 == {"ok": False, "error": WORDS}, e3)
rs = post(C_R, "/review/feedback/save-all", assignment_id=str(AID[OUT2]), **{"answer_1": "yes"})
rk = post(C_R, "/review/feedback/remark", assignment_id=str(AID[OUT2]), remark="ZZ remark about someone who is out")
js, jk = rs.get_json() or {}, rk.get_json() or {}
s.check("the journey's save-all (every answer refused with the sentence) and remark for an out colleague are refused",
        bool(js.get("errors")) and all(e.get("error") == WORDS for e in js["errors"])
        and jk.get("ok") is False and jk.get("error") == WORDS, (js.get("errors"), jk))

s.section("/rate for an out colleague: GET, POST and an autosave are refused, nothing is created")
g = C_R.get("/rate/%d" % OUT2)
with D():
    MY_URL = a.url_for("my_assessments")
s.check("GET /rate/<OUT2> redirects to My Assessments", g.status_code == 302 and g.headers["Location"].endswith(MY_URL),
        (g.status_code, g.headers.get("Location"), MY_URL))
with C_R.session_transaction() as sess:
    flashed = [m for _c, m in sess.get("_flashes", [])]
s.check("...and the sentence is what it flashed", WORDS in flashed, flashed)
p1 = post(C_R, "/rate/%d" % OUT2, action="submit", ajax="0")
p2 = post(C_R, "/rate/%d" % OUT2, ajax="1", ans_1="yes")
s.check("POST /rate/<OUT2> (a normal save) redirects away, an ajax autosave answers 403 with the words",
        p1.status_code == 302 and p2.status_code == 403 and WORDS in p2.get_data(as_text=True),
        (p1.status_code, p2.status_code, p2.get_data(as_text=True)[:80]))
g3 = C_R.get("/rate/%d" % OUT)
p3 = post(C_R, "/rate/%d" % OUT, action="submit")
after = counts()
s.check("nothing was written for any out colleague: no responses row created, nothing answered, still pending",
        after == before and after[OUT2][0] == 0 and g3.status_code == 302 and p3.status_code == 302,
        {NAME[k]: (before[k], after[k]) for k in OUTS})
s.check("the shown /rate page for OUT's fully answered row did not submit it", after[OUT][3] == 1)

s.section("the AI draft route: refused before the model for an out colleague")
before_draft = len(DRAFT_CALLS)
rd = post(C_R, "/api/draft-feedback", subject_id=str(OUT), criterion_id="1", draft="ZZ draft", instruction="shorter")
jd = rd.get_json() or {}
s.check("/api/draft-feedback for OUT answers 403 with the sentence, the model is never called",
        rd.status_code == 403 and jd.get("ok") is False and jd.get("error") == WORDS and len(DRAFT_CALLS) == before_draft,
        (rd.status_code, jd, len(DRAFT_CALLS)))
with D() as db:
    used = db.execute("SELECT COUNT(*) FROM ai_draft_usage WHERE assessor_id=? AND subject_id=?", (R, OUT)).fetchone()[0]
s.check("...and no draft was counted against the cap", used == 0, used)

s.section("the admin side still sees the out rows")
with D() as db:
    n_admin = db.execute("SELECT COUNT(*) FROM assignments WHERE assessor_id=? AND cycle_id=? AND archived=0",
                         (R, CID)).fetchone()[0]
    panel_out = db.execute("SELECT COUNT(*) FROM assignments WHERE subject_id=? AND cycle_id=? AND archived=0",
                           (OUT, CID)).fetchone()[0]
s.check("the rows are on file (admin readers keep them): R has all of them, OUT's panel is intact",
        n_admin == len(RATED) + len(OUTS) and panel_out == 1, (n_admin, panel_out))
page = H.client_as(a, SU["id"]).get("/admin/users/%d?tab=f360" % R)
s.check("the admin's person page for R still opens", page.status_code == 200, page.status_code)

# ================================================================================================ the control
s.section("control: the same route DOES submit a colleague who takes part (the path is reachable)")
g_in = C_R.get("/rate/%d" % IN)
r_in = post(C_R, "/review/feedback/submit", assignment_id=str(AID[IN]))
j_in = r_in.get_json() or {}
with D() as db:
    st_in = db.execute("SELECT status FROM assignments WHERE id=?", (AID[IN],)).fetchone()["status"]
s.check("IN's fully answered row submits through POST /review/feedback/submit", r_in.status_code == 200
        and j_in.get("ok") is True and st_in == "submitted", (r_in.status_code, j_in, st_in))
s.check("/rate/<IN> opens (200)", g_in.status_code == 200, g_in.status_code)
with D() as db:
    ru = db.execute("SELECT * FROM users WHERE id=?", (R,)).fetchone()
    s.check("after it, R still lists exactly the colleagues who take part, one now submitted",
            {x["subject_id"] for x in a._feedback_assignments(db, ru, CID)} == set(RATED)
            and sum(1 for x in a._feedback_assignments(db, ru, CID) if x["status"] == "submitted") == 1)

ai_draft.is_configured, ai_draft.draft, ai_draft.review_agent_available = _ai0
_FINISHED = True
sys.exit(s.done())
