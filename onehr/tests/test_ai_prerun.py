"""The AI insights worked out ahead, and one read for a page's insights (Chris, 2026-10-09).

  "for production purpose, can we pre-run the AI insight and summary after users have keyed in for their respective
   part, and improve the AI insight load speed when said LM, HOD, BUCEO, and BGCEO view their respective page?"

What this holds:
  - the queue (ai_prerun_jobs): an event re-queues a job (and re-runs one that is running); a page's want never resets
    one (no restarted run, no cancelled backoff), and a failed / skipped one isn't asked again straight away;
  - the worker: a claim never exceeds the cap, a dead process's job is freed, each outcome lands where it should (done,
    skipped, retried with backoff, failed at the third, 'wait' without using up an attempt);
  - a job never writes a reading whose AI switch is off, never runs for another cycle, a moved person or a seat that
    is the person themselves, and runs as the reader's page would (signed in as them);
  - the events queue what they settle, the moment it is saved (Chris, 2026-10-14) -- at the check-in's confirm the
    first approver's read, its files (read then, never at upload) and every calibrating seat's read and summary of what
    was written (an HOD and a BU CEO read before the line manager approves; the BG CEO never waits); every seat again at
    the manager's lock and the seats above at each lock; competency, potential and the plan's fit; the Talent Box --
    for people taking part; the HOD's seat at Mid-Year too, the rest at Year-End;
  - an admin's KPI and competency changes, a reopen, an unlock and the person's redo of an added line work the insights
    out ahead too (2026-11-08), and every event the code sends is classified: _PRERUN_EVENTS (queues) or _PRERUN_NO_EVENTS
    (deliberately nothing), read from app.py's own source, so a NEW event fails until it is put in one of them;
  - the seats: a BU CEO's every unit, units calibrated together read under the lead's key, the Group Chief;
  - the summaries of what was written (pm_rem / pot_rem) and the Group Chief's Talent Box worked out like the rest;
  - a model outage shows the plain reading (marked retrying) instead of a spinner; two pages reading the same person
    never trip the queue's unique key; the batch read holds no write lock while it reads; a reader's request takes a
    queued job over so the worker never produces it a second time;
  - the one read (POST /review/team/insights): the same authority as each per-person route, someone outside it left
    out, the calibrator's reading cut to the table's needs, each miss handed to the worker, one bad record not
    emptying the rest; and a reader's own request waits for the worker's run instead of asking the model twice;
  - the page asks once and polls, and the person on screen goes first.

Its own synthetic people on the SHARED suite database (no fresh copy), everything put back at the end. The model is
never called: every generator is stubbed.
"""
import ast
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("AI insights worked out ahead -- the queue, the worker, the events and one read for a page")
BG, CO = "ZZPR Group", "ZZPR Co Sdn Bhd"
_REAL = {}


def stub(name, fn):
    if name not in _REAL:
        _REAL[name] = getattr(a, name)
    setattr(a, name, fn)


def unstub(*names):
    for n in names or list(_REAL):
        if n in _REAL:
            setattr(a, n, _REAL.pop(n))


with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("DELETE FROM pm_calibration_groups WHERE name='ZZPR group'")   # a run that died half-way
    db.execute("DELETE FROM calib_unit_joins WHERE business_group=?", (BG,))
    db.execute("DELETE FROM buceo_seats WHERE business_group=?", (BG,))
    db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZPR-%'")
    db.execute("DELETE FROM ai_prerun_jobs")
    _ORIG = {"half": db.execute("SELECT half FROM cycles WHERE id=?", (CID,)).fetchone()[0],
             "modules": {r[0]: r[1] for r in db.execute(
                 "SELECT module_key, active FROM cycle_modules WHERE cycle_id=? AND module_key IN "
                 "('review','calibration','pm','tm','idp')", (CID,))}}
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=? AND module_key IN "
               "('review','calibration','pm','tm','idp')", (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name="ZZ PR " + eid, email=None, hod_id=None,
                 manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CO,
                 years_of_service=5, left_at=None, is_demo=0)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))),
                   [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
    HOD = person("ZZPR-HOD")
    BU = person("ZZPR-BU", buceo_bg=BG, buceo_company=CO)
    BGC = person("ZZPR-BG", bgceo_bg=BG)
    M1 = person("ZZPR-M1", hod_id=HOD)
    M2 = person("ZZPR-M2", hod_id=HOD)
    S = person("ZZPR-S", hod_id=HOD, manager_id=M1)
    S2 = person("ZZPR-S2", hod_id=HOD, manager_id=M1)
    S3 = person("ZZPR-S3", hod_id=HOD, manager_id=M1)
    T = []
    for nm in ("Gross Profit", "Direct Cost"):
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group) "
                   "VALUES (?,?,?,50,'more','approved',?)", (CID, S, "ZZPR " + nm, BG))
        T.append(db.execute("SELECT last_insert_rowid()").fetchone()[0])
    for t in T:   # M1 first on each line, M2 second
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (t, M1))
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,2,?)", (t, M2))
    db.execute("INSERT INTO pm_evidence(subject_id, author_id, cycle_id, occurred_on, kind, title, state) "
               "VALUES (?,?,?,date('now'),'recognition','ZZPR sign-off','shared')", (S, S, CID))
    EV = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    db.execute("INSERT INTO pm_evidence_links(evidence_id, target_kind, target_ref) VALUES (?, 'kpi', ?)", (EV, str(T[0])))
    db.execute("INSERT INTO pm_evidence_attachments(evidence_id, filename, stored_path, size_bytes) "
               "VALUES (?, 'zzpr.pdf', 'zzpr/none.pdf', 10)", (EV,))
    AID = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    db.commit()

a._PRERUN["force"] = True
_real_configured = a.ai_draft.is_configured
a.ai_draft.is_configured = lambda: True   # a model "configured" -- every generator below is stubbed; none is called


def jobs(db, **w):
    q = "SELECT * FROM ai_prerun_jobs" + (" WHERE " + " AND ".join("%s=?" % k for k in w) if w else "")
    return [dict(r) for r in db.execute(q + " ORDER BY id", tuple(w.values())).fetchall()]


def clear(db):
    db.execute("DELETE FROM ai_prerun_jobs")
    db.commit()


# ---- the lint: every event sent to _rating_record_refresh / _prerun_on_event, read from the source ---------------------
_EVENT_SINKS = {"_rating_record_refresh": 3, "_prerun_on_event": 3}   # name -> where `event` sits (also event=)


class _Unresolved(Exception):
    pass


def events_sent(src, prefixes):
    """({event: [where]}, [problem]) for every event passed to the two functions in `src` (app.py). A literal is itself; a
    conditional is both of its arms; "x_%s" % tier and a bare name resolve through the enclosing function's parameter to what
    every caller passes (recursively, defaults too); "reopen_" + part expands over `prefixes["reopen_"]` (REOPEN_PARTS).
    Anything it cannot resolve is a problem, never skipped: it fails the suite until the call is made readable."""
    tree = ast.parse(src)
    calls = []   # (call, innermost enclosing def or None)

    class V(ast.NodeVisitor):
        fn = None

        def visit_FunctionDef(self, n):
            old, self.fn = self.fn, n
            self.generic_visit(n)
            self.fn = old
        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_Call(self, c):
            calls.append((c, self.fn))
            self.generic_visit(c)
    V().visit(tree)

    def arg_at(c, name, idx):
        for k in c.keywords:
            if k.arg == name:
                return k.value
        if any(isinstance(x, ast.Starred) for x in c.args[:idx + 1]):
            raise _Unresolved("a *args call")
        if len(c.args) > idx:
            return c.args[idx]
        if any(k.arg is None for k in c.keywords):
            raise _Unresolved("passed through **kwargs")
        return None

    def values(node, fn, seen=()):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return {node.value}
        if isinstance(node, ast.IfExp):
            return values(node.body, fn, seen) | values(node.orelse, fn, seen)
        if isinstance(node, ast.BinOp) and isinstance(node.left, ast.Constant) and isinstance(node.left.value, str):
            if isinstance(node.op, ast.Mod):
                return {node.left.value % v for v in values(node.right, fn, seen)}
            if isinstance(node.op, ast.Add):
                if node.left.value in prefixes:
                    return {node.left.value + k for k in prefixes[node.left.value]}
                return {node.left.value + v for v in values(node.right, fn, seen)}
        if isinstance(node, ast.Name) and fn is not None:
            a_ = fn.args
            pos = [x.arg for x in a_.posonlyargs + a_.args]
            if node.id in pos + [x.arg for x in a_.kwonlyargs] and (fn.name, node.id) not in seen:
                idx = pos.index(node.id) if node.id in pos else 10 ** 6
                defaults = dict(zip(pos[len(pos) - len(a_.defaults):], a_.defaults))
                defaults.update({x.arg: d for x, d in zip(a_.kwonlyargs, a_.kw_defaults) if d is not None})
                out, n_callers = set(), 0
                for c, cfn in calls:
                    if getattr(c.func, "id", None) != fn.name:
                        continue
                    n_callers += 1
                    got = arg_at(c, node.id, idx)
                    if got is None:
                        got, cfn = defaults.get(node.id), fn
                        if got is None:
                            raise _Unresolved("%s() called at line %d without %s" % (fn.name, c.lineno, node.id))
                    out |= values(got, cfn, seen + ((fn.name, node.id),))
                if not n_callers:
                    raise _Unresolved("%s() is never called, so %s has no value" % (fn.name, node.id))
                return out
        raise _Unresolved(ast.dump(node)[:90])

    found, problems = {}, []
    for c, fn in calls:
        nm = getattr(c.func, "id", None)
        if nm not in _EVENT_SINKS or (fn is not None and fn.name in _EVENT_SINKS):   # a sink's own forwarding isn't a sender
            continue
        where = "%s() at line %d in %s" % (nm, c.lineno, fn.name if fn is not None else "the module")
        try:
            node = arg_at(c, "event", _EVENT_SINKS[nm])
            if node is None:
                raise _Unresolved("no event argument")
            for ev in values(node, fn):
                found.setdefault(ev, []).append(where)
        except _Unresolved as e:
            problems.append("%s: cannot tell the event (%s)" % (where, e))
    return found, problems


def unclassified(found, queued, quiet):
    return sorted(e for e in found if e not in queued and e not in quiet)


try:
    # ------------------------------------------------------------------------------------------------------------------
    s.section("the switch: on only with a model (or forced by a suite), never started by the suites themselves")
    a._PRERUN["force"] = False
    s.check("ONEHR_PRERUN=0 (the harness sets it) keeps it off even with a model configured",
            not a._prerun_enabled() and os.environ.get("ONEHR_PRERUN") == "0")
    a._PRERUN["force"] = True
    s.check("...and a suite turns it on by hand", a._prerun_enabled())
    os.environ["ONEHR_PRERUN_CONCURRENCY"] = "two"
    s.check("a typo in ONEHR_PRERUN_CONCURRENCY falls back to the default instead of stopping the app",
            a._prerun_env_int("ONEHR_PRERUN_CONCURRENCY", 2) == 2)
    os.environ.pop("ONEHR_PRERUN_CONCURRENCY", None)
    _src = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
    s.check("time is imported at module level (the attachment job's deadline used it)",
            "\nimport time\n" in _src[:3000])

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the queue: an event re-queues; a page's want never resets a job")
    with a.app.test_request_context("/"):
        db = a.get_db(); clear(db)
        a._prerun_enqueue(db, "tc", S, CID, priority=5, delay_s=600); db.commit()
        j0 = jobs(db)[0]
        a._prerun_enqueue(db, "tc", S, CID, priority=2, delay_s=900); db.commit()
        j1 = jobs(db)
        s.check("queued again while due: one row, the higher priority and the later start",
                len(j1) == 1 and j1[0]["priority"] == 2 and j1[0]["not_before"] > j0["not_before"], j1)
        db.execute("UPDATE ai_prerun_jobs SET status='running', claim='x', claimed_at=datetime('now'), attempts=1")
        a._prerun_enqueue(db, "tc", S, CID, priority=2); db.commit()
        j2 = jobs(db)[0]
        s.check("queued again while it RUNS: still running, its claim cleared (so it runs again after)",
                j2["status"] == "running" and j2["claim"] is None, (j2["status"], j2["claim"]))
        # the run that held claim 'x' finishes: its update finds no claim, so the job goes back to queued
        _orig_run = a._prerun_run
        a._prerun_run = lambda db_, job: "ok"
        a._prerun_work(db, dict(j2, claim="x", attempts=1))
        a._prerun_run = _orig_run
        j3 = jobs(db)[0]
        s.check("...and when that run finishes, the job is queued again, not marked done", j3["status"] == "queued", j3)

        clear(db)
        st = a._prerun_want(db, "pm_lm", S, CID, viewer_id=M1); db.commit()
        j = jobs(db)
        s.check("a page's want inserts a missing job at the rows' priority", st == "queued" and len(j) == 1
                and j[0]["priority"] == a.PRERUN_PRI_ROWS and j[0]["viewer_id"] == M1, (st, j))
        db.execute("UPDATE ai_prerun_jobs SET not_before=datetime('now','+600 seconds'), priority=7")
        a._prerun_want(db, "pm_lm", S, CID, viewer_id=M1); db.commit()
        j = jobs(db)[0]
        s.check("a job waiting on a delay (no error) is pulled forward and up",
                j["priority"] == a.PRERUN_PRI_ROWS and j["not_before"] <= db.execute(
                    "SELECT datetime('now')").fetchone()[0], j)
        db.execute("UPDATE ai_prerun_jobs SET not_before=datetime('now','+240 seconds'), last_error='model unavailable', "
                   "attempts=2")
        a._prerun_want(db, "pm_lm", S, CID, viewer_id=M1); db.commit()
        j = jobs(db)[0]
        s.check("...but one backing off after a failure keeps its backoff and its attempts",
                j["not_before"] > db.execute("SELECT datetime('now')").fetchone()[0] and j["attempts"] == 2, j)
        db.execute("UPDATE ai_prerun_jobs SET status='running', claim='y', claimed_at=datetime('now'), attempts=1")
        st = a._prerun_want(db, "pm_lm", S, CID, viewer_id=M1); db.commit()
        j = jobs(db)[0]
        s.check("a RUNNING job is left running (a poll never restarts it mid-run)",
                st == "running" and j["claim"] == "y" and j["attempts"] == 1, (st, j))
        for status, ago, expect in (("failed", 5, "failed"), ("failed", 45, "queued"), ("skipped", 2, "skipped"),
                                    ("skipped", 10, "queued"), ("done", 1, "queued")):
            db.execute("UPDATE ai_prerun_jobs SET status=?, claim=NULL, finished_at=datetime('now', ?)",
                       (status, "-%d minutes" % ago))
            st = a._prerun_want(db, "pm_lm", S, CID, viewer_id=M1); db.commit()
            s.check("a job %s %d minutes ago -> the page hears '%s'" % (status, ago, expect), st == expect,
                    (st, jobs(db)[0]["status"]))
        a._PRERUN["force"] = False
        s.check("with the worker off, a page's want queues nothing (None)",
                a._prerun_want(db, "tc", S2, CID) is None and not jobs(db, kind="tc"))
        a._PRERUN["force"] = True

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the worker: the cap, a dead process's job, each outcome")
    with a.app.test_request_context("/"):
        db = a.get_db(); clear(db)
        for sid in (S, S2, S3):
            a._prerun_enqueue(db, "tc", sid, CID, priority=3)
        db.commit()
        a._PRERUN["swept"] = None
        j1, j2 = a._prerun_claim(db), a._prerun_claim(db)
        j3 = a._prerun_claim(db)
        s.check("at most PRERUN_MAX_RUNNING (2) run at once, across every process",
                j1 is not None and j2 is not None and j3 is None and a.PRERUN_MAX_RUNNING == 2)
        import subprocess
        _p = subprocess.Popen(["true"]); _p.wait()   # a process that has just ended: its pid names nobody now
        db.execute("UPDATE ai_prerun_jobs SET claim=? WHERE id=?", ("%d-1-dead" % _p.pid, j1["id"])); db.commit()
        a._PRERUN["swept"] = None
        j4 = a._prerun_claim(db)
        s.check("a job left 'running' by a process that has gone is freed and taken again",
                j4 is not None and j4["id"] == j1["id"], j4 and dict(j4))
        clear(db)
        a._prerun_enqueue(db, "tc", S, CID, priority=3); db.commit()
        db.execute("UPDATE ai_prerun_jobs SET status='running', claim='z', claimed_at=datetime('now','-6 minutes')")
        db.commit()
        a._PRERUN["swept"] = None
        j5 = a._prerun_claim(db)
        s.check("...and one claimed over five minutes ago is taken again", j5 is not None, j5 and dict(j5))

        outcomes = {}

        def run_as(outcome, fails=0, raise_it=False):
            clear(db)
            a._prerun_enqueue(db, "tc", S, CID, priority=3); db.commit()
            a._PRERUN["swept"] = None
            job = a._prerun_claim(db)

            def fake(db_, jb):
                a.ai_draft._TL.fails = fails
                if raise_it:
                    raise RuntimeError("boom")
                return outcome
            a._prerun_run = fake
            try:
                a._prerun_work(db, job)
            finally:
                a._prerun_run = _orig_run
            return jobs(db)[0]
        j = run_as("ok"); s.check("'ok' -> done", j["status"] == "done" and j["finished_at"], j)
        j = run_as("skip"); s.check("'skip' -> skipped", j["status"] == "skipped", j)
        j = run_as("wait")
        s.check("'wait' -> queued again ~30 s on, the attempt not used up",
                j["status"] == "queued" and j["attempts"] == 0 and j["not_before"] > db.execute(
                    "SELECT datetime('now','+20 seconds')").fetchone()[0], j)
        _bd = []
        stub("_prerun_backdate", lambda db_, jb: _bd.append(jb["kind"]))
        j = run_as("ok", fails=1)
        unstub("_prerun_backdate")
        s.check("a model that failed -> queued again 2 minutes on, and the plain reading marked due for the page",
                j["status"] == "queued" and j["last_error"] == "model unavailable" and _bd == ["tc"]
                and j["not_before"] > db.execute("SELECT datetime('now','+100 seconds')").fetchone()[0], (j, _bd))
        j = run_as("ok", raise_it=True)
        s.check("an exception -> rolled back, queued again with its error", j["status"] == "queued"
                and "boom" in (j["last_error"] or ""), j)
        db.execute("UPDATE ai_prerun_jobs SET attempts=2, not_before=datetime('now')"); db.commit()
        a._PRERUN["swept"] = None
        job = a._prerun_claim(db)
        a._prerun_run = lambda db_, jb: (setattr(a.ai_draft._TL, "fails", 1), "ok")[1]
        a._prerun_work(db, job)
        a._prerun_run = _orig_run
        j = jobs(db)[0]
        s.check("...the third failure ends it: failed", j["status"] == "failed" and j["attempts"] == 3, j)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("a job: its own AI switch, the cycle, the seat, the reader")
    calls = []
    stub("_pm_perf_summary_for", lambda db_, u, sid, generate=False, calib=None, **k: calls.append(
        ("pm", u["id"] if u else None, sid, generate, calib, (a.current_user() or {"id": None})["id"])) or
        {"summary": "x", "pending": False})
    stub("_tc_summary_for", lambda db_, sid, generate=False, **k: calls.append(("tc", sid, generate)) or {"pending": False})
    with a.app.test_request_context("/"):
        db = a.get_db()

        def job(kind, sid, **k):
            return dict({"id": 0, "kind": kind, "subject_id": sid, "cycle_id": CID, "tier": "", "scope_key": "",
                         "viewer_id": 0, "attempts": 1, "claim": None}, **k)
        real_ai_on = a.ai_on
        a.ai_on = lambda key: key != "ai_pm"
        del calls[:]
        r = a._prerun_run(db, job("pm_lm", S, viewer_id=M1))
        s.check("the PM switch off: the job is skipped and nothing is written (a plain PM reading would stick)",
                r == "skip" and not calls, (r, calls))
        a.ai_on = lambda key: True
        r = a._prerun_run(db, job("tc", S, cycle_id=CID + 999))
        s.check("a job for another cycle is skipped", r == "skip")
    with a.app.test_request_context("/"):
        db = a.get_db()
        stub("_pm_approver_subject_ids", lambda db_, u, cid: [S] if u and u["id"] == M1 else [])
        del calls[:]
        r = a._prerun_run(db, job("pm_lm", S, viewer_id=M1))
        s.check("a line manager's read runs as their page does: generate=True, signed in as them",
                r == "ok" and calls and calls[0][3] is True and calls[0][1] == M1 and calls[0][5] == M1, (r, calls))
        r = a._prerun_run(db, job("pm_lm", S, viewer_id=M2))
        s.check("...and not for someone who no longer approves them", r == "skip")
    with a.app.test_request_context("/"):
        db = a.get_db()
        del calls[:]
        r = a._prerun_run(db, job("pm_calib", S, tier="hod", scope_key=str(HOD)))
        s.check("a calibrator's read runs with the seat's own calib (tier, scope, reviewer) and no approver",
                r == "ok" and calls and calls[0][1] is None and calls[0][4]["tier"] == "hod"
                and calls[0][4]["scope_key"] == str(HOD), (r, calls))
        del calls[:]
        r = a._prerun_run(db, job("pm_calib", S, tier="hod", scope_key="12345"))
        s.check("...but not for a seat they've moved out of", r == "skip" and not calls)
        clear(db)
        a._prerun_enqueue(db, "attach", AID, CID, scope_key=str(S)); db.commit()
        del calls[:]
        r = a._prerun_run(db, job("pm_calib", S, tier="hod", scope_key=str(HOD)))
        s.check("while their files are first being read, the PM reads wait (no second model call on an image)",
                r == "wait" and not calls, r)
        db.execute("UPDATE ai_prerun_jobs SET attempts=1, last_error='model unavailable'"); db.commit()
        r = a._prerun_run(db, job("pm_calib", S, tier="hod", scope_key=str(HOD)))
        s.check("...but not behind a file read that is backing off after a failure", r == "ok", r)
        clear(db)
        a.ai_on = real_ai_on
    unstub("_pm_perf_summary_for", "_tc_summary_for", "_pm_approver_subject_ids")
    _t0 = _src.index("def talent_box_rows(db, ctx):")
    _tbr = _src[_t0:_src.index("    own = ctx.get(\"tier\") or \"scope\"", _t0)]
    s.check("talent_box_rows with nobody signed in (a background read) skips its own-tags read instead of failing",
            "if _me:   # a background read" in _tbr)
    _att = _src[_src.index("def _review_attach_one("):_src.index("def _review_attach_one(") + 4000]
    s.check("a file is no longer read for the model at UPLOAD (it could still be deleted before the confirm)",
            "_prerun_enqueue" not in _att.split("\ndef ", 1)[0])

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the events: what each sign-off and lock settles")
    with a.app.test_request_context("/"):
        db = a.get_db(); clear(db)
        a._prerun_on_event(db, CID, [S], "pm_self_confirm"); db.commit()
        got = {(j["kind"], j["subject_id"], j["viewer_id"], j["scope_key"]) for j in jobs(db)}
        s.check("the check-in's confirm: their files, read now (once each, keyed to them) ...",
                ("attach", AID, 0, str(S)) in got, got)
        s.check("...and every approver's read on them (one per line now; each step of a legacy two-step chain reads "
                "its own)", ("pm_lm", S, M1, "") in got and ("pm_lm", S, M2, "") in got, got)
        got = {(j["kind"], j["tier"], j["scope_key"]) for j in jobs(db)}
        SEATS = {("pm_calib", "hod", str(HOD)), ("pm_calib", "buceo", CO), ("pm_calib", "bgceo", BG),
                 ("pm_rem", "hod", ""), ("pm_rem", "buceo", ""), ("pm_rem", "bgceo", "")}
        s.check("...and, the moment they confirm, every seat that reads them: the HOD, the BU CEO, the BG CEO -- their "
                "performance insight and the summary of what was written (an HOD and a BU CEO read before the line "
                "manager approves; the BG CEO never waits)", SEATS <= got, got - SEATS)
        tbj = jobs(db, kind="tb")
        s.check("...and the BG CEO's Talent Box insight once the burst settles (a few minutes on, as them, for their "
                "group)", len(tbj) == 1 and tbj[0]["viewer_id"] == BGC and tbj[0]["tier"] == "bgceo"
                and tbj[0]["scope_key"] == BG
                and tbj[0]["not_before"] > db.execute("SELECT datetime('now','+120 seconds')").fetchone()[0], tbj)
        pri = {(j["kind"], j["tier"]): j["priority"] for j in jobs(db)}
        s.check("...the line manager's read first, then the HOD's, then up the tiers",
                pri[("pm_lm", "")] < pri[("pm_calib", "hod")] < pri[("pm_calib", "buceo")] < pri[("pm_calib", "bgceo")],
                pri)
        clear(db)
        a._prerun_on_event(db, CID, [S], "pm_manager_lock"); db.commit()
        got = {(j["kind"], j["tier"], j["scope_key"], j["viewer_id"]) for j in jobs(db)}
        s.check("every line locked: every seat reads them again (the moderation and the manager's remark are in), the "
                "plan's fit, and the approver's own read (their moderated band is in it)",
                {(k, t, sk, 0) for k, t, sk in SEATS} <= got and ("idp", "", "", 0) in got and ("pm_lm", "", "", M1) in got,
                got)
        clear(db)
        db.execute("UPDATE users SET hod_id=NULL WHERE id=?", (S,))
        a._prerun_on_event(db, CID, [S], "pm_manager_lock"); db.commit()
        got = {(j["kind"], j["tier"], j["scope_key"]) for j in jobs(db, kind="pm_calib")}
        s.check("...with no HOD, the BU CEO's and the BG CEO's", got == {("pm_calib", "buceo", CO),
                                                                        ("pm_calib", "bgceo", BG)}, got)
        db.execute("UPDATE users SET hod_id=? WHERE id=?", (HOD, S))
        clear(db)
        a._prerun_on_event(db, CID, [S], "pm_calib_lock_hod"); db.commit()
        got = {(j["kind"], j["tier"]) for j in jobs(db)}
        s.check("the HOD's submit: the seats above read them again (the HOD's move and remark are in now), never the HOD's",
                {("pm_calib", "buceo"), ("pm_calib", "bgceo"), ("pm_rem", "buceo"), ("pm_rem", "bgceo"), ("tb", "bgceo")}
                == got, got)
        clear(db)
        a._prerun_on_event(db, CID, [S], "pot_calib_lock_hod"); db.commit()
        got = {(j["kind"], j["tier"]) for j in jobs(db)}
        s.check("the HOD's potential submit: what was written about their potential, for the seats above",
                got == {("pot_rem", "buceo"), ("pot_rem", "bgceo"), ("tb", "bgceo")}, got)
        for ev, want in (("pm_calib_lock_buceo", {("pm_calib", "bgceo"), ("pm_rem", "bgceo"), ("tb", "bgceo")}),
                         ("talent_box_lock_buceo", {("pm_calib", "bgceo"), ("pm_rem", "bgceo"), ("pot_rem", "bgceo"),
                                                    ("tb", "bgceo")}),
                         ("pot_calib_lock_buceo", {("pot_rem", "bgceo"), ("tb", "bgceo")})):
            clear(db)
            a._prerun_on_event(db, CID, [S], ev); db.commit()
            got = {(j["kind"], j["tier"]) for j in jobs(db)}
            s.check("%s: the BG CEO's reads on them" % ev, got == want, got)
        clear(db)
        a._prerun_on_event(db, CID, [S], "tc_submit"); a._prerun_on_event(db, CID, [S2], "tc_review")
        a._prerun_on_event(db, CID, [S3], "f360_submit"); a._prerun_on_event(db, CID, [M1], "idp_share"); db.commit()
        got = {(j["kind"], j["subject_id"]) for j in jobs(db)}
        s.check("competency submitted -> their line manager's read, the potential read and what was written about it; "
                "reviewed -> those again and the plan's fit; a 360 in -> the potential read; the plan shared -> its fit",
                got == {("tc", S), ("pot", S), ("pot_rem", S), ("idp", S), ("tb", S), ("pot", S2), ("pot_rem", S2),
                        ("idp", S2),
                        ("tb", S2), ("pot", S3), ("tb", S3), ("idp", M1), ("tb", M1)}, got)
        f360 = jobs(db, kind="pot", subject_id=S3)[0]
        s.check("...the 360's potential read waits a couple of minutes for the rest of the panel",
                f360["not_before"] > db.execute("SELECT datetime('now','+100 seconds')").fetchone()[0], f360)
        clear(db)
        a._prerun_on_event(db, CID, [BU], "pm_calib_lock_hod"); db.commit()
        s.check("nobody's own band: a lock never queues a read on the BU CEO for their own seat",
                not jobs(db, tier="buceo") and jobs(db, kind="pm_calib", tier="bgceo"), jobs(db))
        clear(db)
        db.execute("UPDATE users SET left_at=date('now') WHERE id=?", (S,))
        a._prerun_on_event(db, CID, [S], "pm_manager_lock"); db.commit()
        s.check("someone not taking part (a leaver) gets no calibrator's read", not jobs(db, kind="pm_calib"), jobs(db))
        db.execute("UPDATE users SET left_at=NULL WHERE id=?", (S,))
        clear(db)
        a._prerun_on_event(db, CID, [S], "hod_change"); db.commit()
        got = {(j["kind"], j["tier"]) for j in jobs(db)}
        s.check("a new HOD: every seat reads them again (the HOD tier below the others changed), under the new key",
                {("pm_calib", "hod"), ("pm_calib", "buceo"), ("pm_calib", "bgceo"), ("pot_rem", "hod"),
                 ("pot_rem", "bgceo"), ("tb", "bgceo")} <= got, got)
        # ---- an admin's change, a reopen, an unlock, the person's redo (2026-11-08) ----------------------------------
        def settled(ev, sid=S):   # what one event queues for one person: (kind, tier, scope_key, viewer) for every job
            clear(db)
            a._prerun_on_event(db, CID, [sid], ev); db.commit()
            return {(j["kind"], j["tier"], j["scope_key"], j["viewer_id"]) for j in jobs(db)}
        lock_ref, submit_ref = settled("pm_manager_lock"), settled("pm_self_submit")
        s.check("(the references) a manager's lock queues the approvers' reads, every seat, the plan's fit and the box -- never a "
                "file; the check-in's submit queues their files too", lock_ref and not any(k == "attach" for k, *_ in lock_ref)
                and ("pm_lm", "", "", M1) in lock_ref and ("idp", "", "", 0) in lock_ref
                and any(k == "attach" for k, *_ in submit_ref), (lock_ref, submit_ref))
        for ev in ("kpi_edit", "kpi_method_change", "kpi_unit_change", "kpi_weight_change", "bg_kpi_set", "bu_kpi_retarget",
                   "bu_result_clear", "kpi_import", "bu_kpi_change", "reopen_pm_self", "reopen_pm_mod"):
            got = settled(ev)
            s.check("%s: the same reads as a manager's lock (the approvers', every seat, the plan's fit, the box)" % ev,
                    got == lock_ref, (got ^ lock_ref))
        s.check("reopen_pm_self / reopen_pm_mod queue no file read: the files can still change before the resubmit",
                not any(k == "attach" for k, *_ in settled("reopen_pm_self") | settled("reopen_pm_mod")))
        s.check("pm_self_added (the person's redo of a line an admin added) is the check-in's submit, their files too",
                settled("pm_self_added") == submit_ref and any(k == "attach" for k, *_ in submit_ref))
        tcs, tcr = settled("tc_submit"), settled("tc_review")
        s.check("(the references) a competency submit queues their read, the potential, what was written and the plan's fit; "
                "a review queues the potential, what was written and the plan's fit, but not their read",
                {("tc", "", "", 0), ("pot", "", "", 0), ("idp", "", "", 0)} <= tcs
                and {("pot", "", "", 0), ("idp", "", "", 0)} <= tcr and ("tc", "", "", 0) not in tcr, (tcs, tcr))
        for ev in ("tc_submit_added", "reopen_tc_self"):
            s.check("%s: the same as a competency submit" % ev, settled(ev) == tcs, settled(ev) ^ tcs)
        s.check("reopen_tc_review: the same as a review", settled("reopen_tc_review") == tcr, settled("reopen_tc_review") ^ tcr)
        for ev in ("tc_person_swap", "tc_person_remove_answered"):
            got = settled(ev)
            s.check("%s (an admin changes an answered competency): a review's reads, and their read of the answers again" % ev,
                    got == tcr | {("tc", "", "", 0)}, got ^ (tcr | {("tc", "", "", 0)}))
        s.check("reopen_f360: the same as a 360 in", settled("reopen_f360") == settled("f360_submit"))
        idps = settled("idp_share")
        s.check("reopen_idp_self / reopen_idp_review: the same as the plan shared (its fit, the box)", idps
                and settled("reopen_idp_self") == idps and settled("reopen_idp_review") == idps, idps)
        unl = settled("calib_unlock_hod")
        s.check("an HOD's unlock: the seats above read them again, both axes -- never the HOD's own",
                {(k, t) for k, t, _sk, _v in unl} == {("pm_calib", "buceo"), ("pm_calib", "bgceo"), ("pm_rem", "buceo"),
                                                      ("pm_rem", "bgceo"), ("pot_rem", "buceo"), ("pot_rem", "bgceo"),
                                                      ("tb", "bgceo")}, unl)
        for ev in ("calib_unlock_buceo", "calib_unlock_bugrp"):
            s.check("%s: the BG CEO's reads on them, both axes and the box" % ev,
                    {(k, t) for k, t, _sk, _v in settled(ev)} == {("pm_calib", "bgceo"), ("pm_rem", "bgceo"),
                                                                  ("pot_rem", "bgceo"), ("tb", "bgceo")}, settled(ev))
        s.check("a BG CEO's unlock with no Group Chief group over them: nothing above to read", not settled("calib_unlock_bgceo"))
        s.check("the dead names are gone: an unlock was never sent as pm_calib_unlock_* / pot_calib_unlock_*",
                not any(e.startswith(("pm_calib_unlock_", "pot_calib_unlock_")) for e in a._PRERUN_EVENTS))
        s.check("a Group Chief's own unlock settles nothing (no seat reads above it; its own reads hold the tiers below)",
                "calib_unlock_group" in a._PRERUN_NO_EVENTS and "calib_unlock_group" not in a._PRERUN_EVENTS
                and not settled("calib_unlock_group"))
        clear(db)
        a._prerun_on_event(db, CID, [S], "admin_capture"); a._prerun_on_event(db, CID, [S], "demo_reset_team")
        db.commit()
        s.check("an event that settles nothing (a capture, a demo reset) queues nothing", not jobs(db))
        db.execute("UPDATE cycles SET half=1 WHERE id=?", (CID,)); db.commit()
    with a.app.test_request_context("/"):   # the active cycle is cached per request
        db = a.get_db()
        a._prerun_on_event(db, CID, [S], "pm_manager_lock"); a._prerun_on_event(db, CID, [S], "f360_submit"); db.commit()
        got = {(j["kind"], j["tier"]) for j in jobs(db)}
        s.check("Mid-Year: the HOD's department review reads them (its insight, what was written, the potential) -- no "
                "BU CEO, BG CEO or Talent Box", {("pm_calib", "hod"), ("pm_rem", "hod"), ("pot", "")} <= got
                and not any(t in ("buceo", "bgceo") or k == "tb" for k, t in got), got)
        db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,)); db.commit()
    with a.app.test_request_context("/"):
        db = a.get_db()
        clear(db)
        a._PRERUN["force"] = False
        a._prerun_on_event(db, CID, [S], "pm_self_confirm"); db.commit()
        s.check("with the worker off, an event queues nothing", not jobs(db))
        a._PRERUN["force"] = True
        _bad = []
        stub("_prerun_for_event", lambda *x: (_ for _ in ()).throw(RuntimeError("boom")))
        try:
            a._prerun_on_event(db, CID, [S], "tc_submit")
            _bad.append("ok")
        except Exception as e:
            _bad.append(str(e))
        unstub("_prerun_for_event")
        s.check("an event never raises into the sign-off that sent it", _bad == ["ok"], _bad)

    # ------------------------------------------------------------------------------------------------------------------
    s.section("every event the code sends is classified: it queues something, or it deliberately queues nothing")
    _src = H.source(a)
    _pref = {"reopen_": list(a.REOPEN_PARTS)}
    found, problems = events_sent(_src, _pref)
    queued, quiet = set(a._PRERUN_EVENTS), set(a._PRERUN_NO_EVENTS)
    s.check("every call's event can be read from the source (a literal, a conditional, \"x_%%s\" %% tier, a parameter its callers "
            "fill): %d events from %d calls" % (len(found), sum(len(v) for v in found.values())), len(found) > 40 and not problems,
            problems)
    s.check("...and every one is in _PRERUN_EVENTS or _PRERUN_NO_EVENTS (a new event is classified, or this fails)",
            not unclassified(found, queued, quiet), unclassified(found, queued, quiet))
    s.check("...no event is in both sets", not (queued & quiet), queued & quiet)
    s.check("...and no name sits in either set that nothing sends (the old pm_calib_unlock_* names were sent by nothing "
            "for as long as unlocks went through _unlock_scope)", not sorted((queued | quiet) - set(found)),
            sorted((queued | quiet) - set(found)))
    _body = _src[_src.index("def _prerun_for_event("):_src.index("def _prerun_idp_ready(")]
    s.check("...and every event that queues has its branch in _prerun_for_event (listed in a set, handled nowhere = queues "
            "nothing, silently)", not [e for e in sorted(queued) if '"%s"' % e not in _body],
            [e for e in sorted(queued) if '"%s"' % e not in _body])
    s.check("...every reopen part is an event, and an unlock tier too (a new REOPEN_PARTS key or UNLOCK_TIERS entry needs a "
            "classification)", {"reopen_" + k for k in a.REOPEN_PARTS} <= queued
            and {"calib_unlock_" + t for t in a.UNLOCK_TIERS} <= (queued | quiet),
            ({"reopen_" + k for k in a.REOPEN_PARTS} - queued, {"calib_unlock_" + t for t in a.UNLOCK_TIERS} - queued - quiet))
    # falsify the lint itself: a new literal, a new tier, a computed event it cannot read, a dropped classification
    _f, _p = events_sent(_src + "\n_rating_record_refresh(db, 1, [1], 'zz_fake_event')\n", _pref)
    s.check("the lint fails on a NEW literal event", unclassified(_f, queued, quiet) == ["zz_fake_event"] and not _p,
            unclassified(_f, queued, quiet))
    _f, _p = events_sent(_src + "\ndef _zz(db, tier):\n    _prerun_on_event(db, 1, [1], 'zz_%s' % tier)\n_zz(1, 'a')\n", _pref)
    s.check("...on a NEW event built from a parameter its caller fills", unclassified(_f, queued, quiet) == ["zz_a"],
            unclassified(_f, queued, quiet))
    _f, _p = events_sent(_src + "\ndef _zz(db, x):\n    _prerun_on_event(db, 1, [1], x.lower())\n", _pref)
    s.check("...on an event it cannot read (never skipped silently)", len(_p) == 1, _p)
    _f, _p = events_sent(_src + "\ndef _zz(db, tier):\n    _prerun_on_event(db, 1, [1], 'zz_%s' % tier)\n", _pref)
    s.check("...on a computed event whose parameter nobody fills", len(_p) == 1, _p)
    s.check("...and on an event dropped from its set",
            unclassified(found, queued - {"kpi_edit"}, quiet) == ["kpi_edit"]
            and unclassified(found, queued, quiet - {"calib_unlock_group"}) == ["calib_unlock_group"])

    # ------------------------------------------------------------------------------------------------------------------
    s.section("one read for a page: POST /review/team/insights")
    seen = []

    def pm_gen(db_, u, rid, generate=False, calib=None, stale_ok=False):
        seen.append((rid, generate, bool(calib)))
        if rid == S3:
            raise RuntimeError("malformed line")
        if calib:
            return {"summary": "case", "pending": rid == S2, "source": "ai",
                    "data": {"verdict": "partly_justified", "paragraph": "P", "read": "R", "verdict_why": "W",
                             "discuss": ["one", "two", "three"], "kpis": [{"kpi": "x"}], "hr": []}}
        return {"summary": "ready" if rid == S else None, "data": None, "source": "ai" if rid == S else None,
                "pending": rid != S}
    stub("_pm_perf_summary_for", pm_gen)
    stub("_pm_approver_subject_ids", lambda db_, u, cid: [S, S2, S3] if u and u["id"] == M1 else [])
    stub("_review_manages_team", lambda db_, u: True)
    c = H.client_as(a, M1)
    with a.app.test_request_context("/"):
        clear(a.get_db())
    r = c.post("/review/team/insights", data={"csrf_token": "tok", "kind": "pm",
                                               "ids": "%d,%d,%d,999999,%d,x" % (S, S2, S3, M1)})
    j = r.get_json() or {}
    it = j.get("items") or {}
    s.check("a line manager's rows in ONE request: theirs answered, someone else's / a stranger / themselves left out",
            r.status_code == 200 and j.get("ok") and set(it) == {str(S), str(S2), str(S3)}, (r.status_code, j))
    s.check("...a reading already worked out comes back whole", it.get(str(S), {}).get("pending") is False
            and it.get(str(S), {}).get("summary") == "ready", it.get(str(S)))
    with a.app.test_request_context("/"):
        db = a.get_db()
        jj = jobs(db, kind="pm_lm", subject_id=S2)
    s.check("...one still to work out is handed to the worker (their read, as them) and the page told 'queued' -- "
            "among the page's first rows, ahead of a long roster",
            it.get(str(S2), {}).get("pending") and it.get(str(S2), {}).get("job") == "queued"
            and len(jj) == 1 and jj[0]["viewer_id"] == M1 and jj[0]["priority"] == a.PRERUN_PRI_PAGE, (it.get(str(S2)), jj))
    s.check("...one malformed record is an error for that person only", it.get(str(S3), {}).get("error") is True)
    s.check("...and nothing was worked out in the request itself (generate=False throughout)",
            all(g is False for _rid, g, _c in seen), seen)
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("UPDATE ai_prerun_jobs SET status='running', claim='w', claimed_at=datetime('now'), attempts=1")
        db.commit()
    j2 = (c.post("/review/team/insights", data={"csrf_token": "tok", "kind": "pm", "ids": str(S2)}).get_json() or {})
    with a.app.test_request_context("/"):
        jj = jobs(a.get_db(), kind="pm_lm", subject_id=S2)
    s.check("polling again while it runs: told 'running', the job untouched",
            (j2.get("items") or {}).get(str(S2), {}).get("job") == "running" and jj[0]["claim"] == "w"
            and jj[0]["attempts"] == 1, (j2, jj))
    _many = list(range(900001, 900014))   # 13 people: the 13th is past the page's first rows
    stub("_pm_approver_subject_ids", lambda db_, u, cid: [S, S2, S3] + _many if u and u["id"] == M1 else [])
    # the page reads the KPI review list (the approver chain less who is out of Performance, 2026-10-30), and these 13
    # are invented ids with no user row: stand in for it too, for this one request
    stub("_pm_review_subject_ids", lambda db_, u, cid: [S, S2, S3] + _many if u and u["id"] == M1 else [])
    c.post("/review/team/insights", data={"csrf_token": "tok", "kind": "pm", "ids": ",".join(map(str, _many))})
    unstub("_pm_review_subject_ids")
    with a.app.test_request_context("/"):
        _pr = {j["subject_id"]: j["priority"] for j in jobs(a.get_db(), kind="pm_lm")}
    s.check("a long page: its first twelve go ahead of every save's queue (priority 1), the rest wait their turn (3) -- "
            "a boss looking at the page never waits behind a deadline day's confirms",
            all(_pr[i] == a.PRERUN_PRI_PAGE for i in _many[:12]) and _pr[_many[12]] == a.PRERUN_PRI_ROWS
            and a.PRERUN_PRI_PAGE < a.PRERUN_PRI_SUBMIT,
            {k: v for k, v in _pr.items() if k in _many})
    r = c.post("/review/team/insights", data={"csrf_token": "tok", "kind": "nope", "ids": str(S)})
    s.check("an unknown kind is refused", r.status_code == 400)
    stub("_journey_calib_scope", lambda db_, u, *x, **k: ("hod", {}, {"population": [{"id": S}, {"id": S2}],
                                                                       "scope_key": str(HOD), "period": {"id": CID}}))
    del seen[:]
    jp = (c.post("/review/team/insights", data={"csrf_token": "tok", "kind": "perf", "view": "dept",
                                                "ids": "%d,%d,%d" % (S, S2, S3)}).get_json() or {})
    ip = jp.get("items") or {}
    d1 = (ip.get(str(S)) or {}).get("data") or {}
    s.check("a calibrator's curve: only their scope (the third person is outside it)", set(ip) == {str(S), str(S2)}, ip)
    s.check("...the reading cut to what the table needs -- verdict, paragraph, the first step -- marked light; the "
            "card asks for the whole of it", (ip.get(str(S)) or {}).get("light") is True and d1.get("verdict")
            and d1.get("paragraph") == "P" and d1.get("discuss") == ["one"] and "kpis" not in d1, d1)
    with a.app.test_request_context("/"):
        jj = jobs(a.get_db(), kind="pm_calib", subject_id=S2)
    s.check("...a miss is queued for the seat it came from (tier, scope), never from the form",
            len(jj) == 1 and jj[0]["tier"] == "hod" and jj[0]["scope_key"] == str(HOD) and jj[0]["viewer_id"] == 0, jj)
    a._PRERUN["force"] = False
    j3 = (c.post("/review/team/insights", data={"csrf_token": "tok", "kind": "pm", "ids": str(S2)}).get_json() or {})
    a._PRERUN["force"] = True
    s.check("with no worker (no model) the page is told so, and asks for them itself as before",
            j3.get("prerun") is False and "job" not in ((j3.get("items") or {}).get(str(S2)) or {}), j3)
    unstub("_journey_calib_scope")

    tbcalls = []
    stub("_journey_talent_box_scope", lambda db_, u, *x, **k: ("bgceo", {"bg": BG}, {
        "population": [{"id": S}, {"id": S2}], "cycle_id": CID, "tier": "bgceo", "scope_key": BG,
        "business_group": BG}))
    stub("_tb_insight_for", lambda db_, u, sc, p, generate=False, **k: tbcalls.append((p["id"], generate)) or (
        {"data": {"insight": "i", "decision": "d"}, "facts": {"box": "Star"}, "source": "ai", "pending": False}
        if p["id"] == S else {"data": None, "facts": {}, "source": None, "pending": True}))
    cb = H.client_as(a, BGC)
    jt = (cb.post("/review/team/insights", data={"csrf_token": "tok", "kind": "tb", "view": "bg",
                                                 "ids": "%d,%d,%d" % (S, S2, BGC)}).get_json() or {})
    itb = jt.get("items") or {}
    with a.app.test_request_context("/"):
        jj = jobs(a.get_db(), kind="tb", subject_id=S2)
    s.check("the Talent Box: the person's insight with its facts; a miss queued as the BG CEO's, for their group",
            (itb.get(str(S)) or {}).get("facts") == {"box": "Star"} and str(BGC) not in itb
            and len(jj) == 1 and jj[0]["viewer_id"] == BGC and jj[0]["scope_key"] == BG and jj[0]["tier"] == "bgceo",
            (itb, jj))
    unstub("_journey_talent_box_scope", "_tb_insight_for")

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the reader's own request waits for the worker's run instead of asking the model twice")
    with a.app.test_request_context("/"):
        db = a.get_db(); clear(db)
        reads = []
        real_sleep = a.time.sleep
        a.time.sleep = lambda x: None
        try:
            got = a._prerun_await(db, ("tc", S, CID), lambda: reads.append(1) or {"pending": True})
            s.check("nothing running: no wait, no read", got is None and not reads)
            a._prerun_enqueue(db, "tc", S, CID); db.commit()
            db.execute("UPDATE ai_prerun_jobs SET status='running', claim='q', claimed_at=datetime('now')"); db.commit()
            seq = [{"pending": True}, {"pending": False, "summary": "done"}]
            got = a._prerun_await(db, ("tc", S, CID), lambda: seq.pop(0) if seq else {"pending": True})
            s.check("running: it re-reads the cache until the worker's reading is there, then serves it",
                    got and got.get("summary") == "done", got)
        finally:
            a.time.sleep = real_sleep
        clear(db)
    pmcalls = []
    stub("_pm_perf_summary_for", lambda db_, u, rid, generate=False, calib=None, **k: pmcalls.append(generate) or (
        {"summary": "from the worker", "pending": False, "source": "ai"} if not generate else
        {"summary": "made here", "pending": False, "source": "ai"}))
    with a.app.test_request_context("/"):
        db = a.get_db()
        a._prerun_enqueue(db, "pm_lm", S, CID, viewer_id=M1); db.commit()
        db.execute("UPDATE ai_prerun_jobs SET status='running', claim='q', claimed_at=datetime('now')"); db.commit()
    a.time.sleep = lambda x: None
    try:
        rr = c.post("/review/team/pm-summary", data={"csrf_token": "tok", "report": str(S)}).get_json() or {}
    finally:
        a.time.sleep = real_sleep
    s.check("the per-person route served the worker's reading and never generated itself",
            rr.get("summary") == "from the worker" and True not in pmcalls, (rr, pmcalls))
    unstub()

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the worker end to end (stubbed model)")
    ran = []
    stub("_pm_approver_subject_ids", lambda db_, u, cid: [S] if u and u["id"] == M1 else [])
    stub("_pm_perf_summary_for", lambda db_, u, sid, generate=False, calib=None, **k: ran.append(
        (sid, generate, (a.current_user() or {"id": None})["id"])) or {"summary": "x", "pending": False})
    with a.app.test_request_context("/"):
        db = a.get_db(); clear(db)
        a._prerun_enqueue(db, "pm_lm", S, CID, viewer_id=M1); db.commit()
    a._PRERUN["swept"] = None
    n = a._prerun_drain(5)
    with a.app.test_request_context("/"):
        jj = jobs(a.get_db())
    s.check("a queued read is worked out in a fresh request context, signed in as its reader, and marked done",
            n == 1 and ran == [(S, True, M1)] and jj[0]["status"] == "done", (n, ran, jj))
    unstub()

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the seats: a BU CEO's every unit, units calibrated together, the Group Chief (2026-10-14)")
    CO2 = "ZZPR Second Sdn Bhd"
    with a.app.test_request_context("/"):
        db = a.get_db(); clear(db)
        P2 = person("ZZPR-P2", company=CO2, hod_id=HOD)
        db.execute("INSERT OR REPLACE INTO buceo_seats(business_group, company, user_id) VALUES (?,?,?)", (BG, CO2, BU))
        db.commit()
    with a.app.test_request_context("/"):
        db = a.get_db()
        st = a._prerun_seats(db, P2)
        s.check("a BU CEO's SECOND unit reads its people too (buceo_seats, not their first seat's columns)",
                ("buceo", CO2, BU) in st, st)
        db.execute("INSERT INTO calib_unit_joins(cycle_id, business_group, company, lead) VALUES (?,?,?,?)",
                   (CID, BG, CO, CO))
        db.execute("INSERT INTO calib_unit_joins(cycle_id, business_group, company, lead) VALUES (?,?,?,?)",
                   (CID, BG, CO2, CO))
        db.execute("DELETE FROM buceo_seats WHERE business_group=? AND company=?", (BG, CO2))
        db.commit()
    with a.app.test_request_context("/"):   # calib_join is cached per request
        db = a.get_db()
        st = a._prerun_seats(db, P2)
        s.check("units calibrated together: a member unit's person is read under the LEAD's key, by the lead's BU CEO "
                "(even with no BU CEO of their own unit)", ("buceo", CO, BU) in st
                and not any(t == "buceo" and k == CO2 for t, k, _h in st), st)
        s.check("...and a job keyed to the lead runs for them; one keyed to their own unit is skipped (no page reads it)",
                a._prerun_seat_ok(db, P2, "buceo", CO) and not a._prerun_seat_ok(db, P2, "buceo", CO2))
        db.execute("DELETE FROM calib_unit_joins WHERE cycle_id=? AND business_group=?", (CID, BG))
        GC = person("ZZPR-GC")
        GID = db.execute("INSERT INTO pm_calibration_groups(name, calibrator_id) VALUES ('ZZPR group', ?)",
                         (GC,)).lastrowid
        db.execute("INSERT INTO pm_calibration_group_members(group_id, subject_id) VALUES (?,?)", (GID, S))
        db.commit()
    with a.app.test_request_context("/"):   # the group map is cached per request
        db = a.get_db()
        st = a._prerun_seats(db, S)
        s.check("the Group Chief of their calibration group is a seat (scope = the group id)",
                ("group", str(GID), GC) in st, st)
        a._prerun_on_event(db, CID, [S], "talent_box_lock_bu"); db.commit()
        got = {(j["kind"], j["tier"], j["scope_key"], j["viewer_id"]) for j in jobs(db)}
        s.check("the BG CEO's lock of their unit: the Group Chief's reads -- performance, what was written, the box's "
                "insight (keyed group:<id>, as the Group Chief)",
                {("pm_calib", "group", str(GID), 0), ("pm_rem", "group", "", 0), ("pot_rem", "group", "", 0),
                 ("tb", "group", "group:%d" % GID, GC)} == got, got)
        clear(db)
        for ev, want in (("calib_unlock_bgceo", {("pm_calib", "group", str(GID), 0), ("pm_rem", "group", "", 0),
                                                 ("pot_rem", "group", "", 0), ("tb", "group", "group:%d" % GID, GC)}),
                         ("calib_unlock_group", set())):
            a._prerun_on_event(db, CID, [S], ev); db.commit()
            got = {(j["kind"], j["tier"], j["scope_key"], j["viewer_id"]) for j in jobs(db)}
            s.check("%s: %s" % (ev, "the Group Chief's reads on them (what came up through the BG CEO changed)" if want
                                else "a Group Chief's own unlock queues nothing"), got == want, got)
            clear(db)
        a._prerun_on_event(db, CID, [S], "calib_unlock_hod"); db.commit()
        got = {(j["kind"], j["tier"]) for j in jobs(db)}
        s.check("an HOD's unlock reaches the Group Chief's seat too (the seats above read them again)",
                {("pm_calib", "group"), ("pm_rem", "group"), ("pot_rem", "group"), ("tb", "group")} <= got, got)
        clear(db)
        db.execute("UPDATE cycles SET half=1 WHERE id=?", (CID,)); db.commit()
    with a.app.test_request_context("/"):
        db = a.get_db()
        st = a._prerun_seats(db, S)
        s.check("Mid-Year: only the HOD's seat (their department review); no BU CEO, BG CEO or Group Chief",
                [t for t, _k, _h in st] == ["hod"], st)
        db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,)); db.commit()

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the new readings: what was written (pm_rem / pot_rem), the Group Chief's Talent Box")
    rem = []
    stub("_pm_remark_entries", lambda db_, u, rid, tier: [{"role": "self", "text": "I did it"}] if rid == S else [])
    stub("_pot_remark_entries", lambda db_, people, cid, tier: {p["id"]: ([{"role": "lm", "text": "Solid"}]
                                                                          if p["id"] == S else []) for p in people})
    stub("_pot_remarks_summary_for", lambda db_, sid, cid, tier, ents, generate=False, axis="pot", **k: rem.append(
        (sid, tier, axis, generate, len(ents))) or {"summary": "s", "pending": False})
    with a.app.test_request_context("/"):
        db = a.get_db()
        def job2(kind, sid, **k):
            return dict({"id": 0, "kind": kind, "subject_id": sid, "cycle_id": CID, "tier": "", "scope_key": "",
                         "viewer_id": 0, "attempts": 1, "claim": None}, **k)
        r1 = a._prerun_run(db, job2("pm_rem", S, tier="hod"))
        r2 = a._prerun_run(db, job2("pot_rem", S, tier="buceo"))
        s.check("each seat's summary of what was written is the page's own call (its tier, its axis, generate=True)",
                r1 == "ok" and r2 == "ok" and rem == [(S, "hod", "pm", True, 1), (S, "buceo", "pot", True, 1)], (r1, r2, rem))
        del rem[:]
        r3 = a._prerun_run(db, job2("pm_rem", S2, tier="hod"))
        s.check("...nobody wrote anything: skipped (the page says so without the model)", r3 == "skip" and not rem, r3)
        db.execute("DELETE FROM pm_calibration_group_members WHERE subject_id=?", (S,)); db.commit()
    with a.app.test_request_context("/"):   # the group map is cached per request
        db = a.get_db()
        r4 = a._prerun_run(db, job2("pm_rem", S, tier="group"))
        s.check("...a seat that no longer reads them is skipped", r4 == "skip" and not rem, r4)
    unstub("_pm_remark_entries", "_pot_remark_entries", "_pot_remarks_summary_for")
    seen_tb = []

    def fake_scope(db_, u, *x, **k):
        seen_tb.append((k.get("tier"), a.request.values.get("view")))
        return ("group", {"group_id": GID}, {"population": [{"id": S}], "cycle_id": CID, "tier": "group",
                                            "scope_key": str(GID), "business_group": BG})
    stub("_journey_talent_box_scope", fake_scope)
    stub("_tb_insight_for", lambda db_, u, sc, p, generate=False, **k: seen_tb.append(("gen", p["id"], generate,
                                                                                      a.current_user()["id"])) or {})
    with a.app.test_request_context("/"):
        db = a.get_db()
        r5 = a._prerun_run(db, job2("tb", S, tier="group", scope_key="group:%d" % GID, viewer_id=GC))
        s.check("the Group Chief's box insight is built in the Group view (a background request has none of its own), "
                "as them", r5 == "ok" and seen_tb[0] == ("group", "group") and seen_tb[1] == ("gen", S, True, GC),
                (r5, seen_tb))
        del seen_tb[:]
        r6 = a._prerun_run(db, job2("tb", S, tier="group", scope_key="group:999", viewer_id=GC))
        s.check("...a job for another group's box is skipped", r6 == "skip", r6)
        a._prerun_enqueue(db, "idp", S, CID); db.commit()
        r7 = a._prerun_run(db, job2("tb", S, tier="group", scope_key="group:%d" % GID, viewer_id=GC))
        s.check("...and it waits while their plan's fit is still being read (the box's insight reads it)", r7 == "wait", r7)
        clear(db)
    _src2 = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
    _tc_ = _src2[_src2.index("def _tb_insight_case("):_src2.index("def _tb_insight_for(")]
    s.check("the Group Chief's box insight reads their group's potential and what was written at the group seat (it "
            "raised KeyError on kw['bg'] and said 'not enough feedback' for everyone)",
            'sbg if grp else kw["bg"]' in _tc_ and '"group" if grp else "bgceo"' in _tc_)
    stub("_pot_calib_scope", lambda db_, u, *x, **k: None)
    stub("_tbox_insight_scope", lambda db_, u: ("group", {"group_id": GID}, {"population": [{"id": S}], "cycle_id": CID}))
    stub("_pot_summary_for", lambda db_, u, rid, cid, rv, generate=False, **k: {"summary": "p", "pending": False,
                                                                               "source": "ai"})
    cg = H.client_as(a, GC)
    rg = cg.post("/review/team/pot-summary", data={"csrf_token": "tok", "report": str(S), "view": "group"})
    rgb = cg.post("/review/team/insights", data={"csrf_token": "tok", "kind": "pot", "view": "group", "ids": str(S)})
    s.check("a Group Chief's potential insight answers (it was a 500: their scope has no business group)",
            rg.status_code == 200 and (rg.get_json() or {}).get("summary") == "p"
            and rgb.status_code == 200 and ((rgb.get_json() or {}).get("items") or {}).get(str(S), {}).get("summary") == "p",
            (rg.status_code, rgb.status_code))
    unstub()

    # ------------------------------------------------------------------------------------------------------------------
    s.section("a model outage, two readers at once, the batch's write lock, a request taking a job over")
    stub("_pm_approver_subject_ids", lambda db_, u, cid: [S, S2] if u and u["id"] == M1 else [])
    stub("_review_manages_team", lambda db_, u: True)
    real_sr = a.ai_draft.summarise_remarks
    a.ai_draft.summarise_remarks = lambda *x, **k: (_ for _ in ()).throw(a.ai_draft.AIDraftError("model down"))
    try:
        with a.app.test_request_context("/"):
            db = a.get_db()
            ents = [{"role": "self", "who": "Their overall remark", "on": None, "move": None, "text": "I led the line.",
                     "src": "Their own overall remark"}]
            a._pot_remarks_summary_for(db, S, CID, "hod", ents, generate=True, axis="pm")
            db.execute("UPDATE pm_remark_summaries SET created_at=datetime('now','-11 minutes') WHERE subject_id=? "
                       "AND cycle_id=? AND tier='hod'", (S, CID)); db.commit()
            old = a._pot_remarks_summary_for(db, S, CID, "hod", ents, axis="pm")
            new = a._pot_remarks_summary_for(db, S, CID, "hod", ents, axis="pm", stale_ok=True)
            s.check("a plain reading the model failed on: a page's request still re-asks the model (pending) ...",
                    old.get("pending") is True, old)
            s.check("...but the batch read SERVES it, marked retrying -- the plain reading, not a spinner for the whole "
                    "outage", new.get("pending") is False and new.get("retrying") is True and new.get("summary"), new)
            db.execute("DELETE FROM pm_remark_summaries WHERE subject_id=? AND cycle_id=?", (S, CID)); db.commit()
    finally:
        a.ai_draft.summarise_remarks = real_sr

    def tc_gen(db_, rid, generate=False, stale_ok=False):
        if rid == S:
            return ({"summary": "plain", "source": "plain", "pending": False, "retrying": True} if stale_ok
                    else {"summary": None, "pending": True})
        return {"summary": None, "pending": True}
    stub("_tc_summary_for", tc_gen)
    stub("_tc_reports_for", lambda db_, uid, cid: [{"id": S}, {"id": S2}] if uid == M1 else [])
    with a.app.test_request_context("/"):
        clear(a.get_db())
    jt2 = (c.post("/review/team/insights", data={"csrf_token": "tok", "kind": "tm", "ids": "%d,%d" % (S, S2)})
           .get_json() or {}).get("items") or {}
    with a.app.test_request_context("/"):
        jj = jobs(a.get_db(), kind="tc", subject_id=S)
    s.check("the batch: the plain reading lands now, marked retrying, and the worker is asked the model again "
            "(the page keeps polling it for the model's reading)",
            (jt2.get(str(S)) or {}).get("summary") == "plain" and (jt2.get(str(S)) or {}).get("retrying")
            and (jt2.get(str(S)) or {}).get("job") == "queued" and len(jj) == 1, (jt2, jj))
    import sqlite3 as _sq
    lock_seen = []

    def tc_lock(db_, rid, generate=False, stale_ok=False):
        if rid == S2:   # another writer, while the batch is still reading: it must not find the database locked
            try:
                c2 = _sq.connect(a.DB_PATH, timeout=0.3)
                c2.execute("INSERT INTO ai_prerun_jobs(kind, subject_id, cycle_id, priority) VALUES ('tc', 1, ?, 9)",
                           (CID,))
                c2.commit(); c2.close()
                lock_seen.append("ok")
            except _sq.OperationalError as e:
                lock_seen.append(str(e))
        return {"summary": None, "pending": True}
    stub("_tc_summary_for", tc_lock)
    with a.app.test_request_context("/"):
        clear(a.get_db())
    c.post("/review/team/insights", data={"csrf_token": "tok", "kind": "tm", "ids": "%d,%d" % (S, S2)})
    s.check("the batch queues its misses AFTER its reads: another writer meanwhile isn't locked out (a want inside the "
            "loop held the write lock across up to 250 reads)", lock_seen == ["ok"], lock_seen)
    with a.app.test_request_context("/"):
        db = a.get_db(); clear(db)

        class Racer:   # a second reader inserts the same job between this one's look and its insert
            def __init__(self, d):
                self.d, self.done = d, False

            def execute(self, sql, *args):
                if not self.done and sql.lstrip().startswith("INSERT INTO ai_prerun_jobs"):
                    self.done = True
                    c3 = _sq.connect(a.DB_PATH, timeout=5)
                    c3.execute("INSERT INTO ai_prerun_jobs(kind, subject_id, cycle_id, tier, scope_key, viewer_id, "
                               "priority) VALUES ('tc', ?, ?, '', '', 0, 5)", (S, CID))
                    c3.commit(); c3.close()
                return self.d.execute(sql, *args)

            def __getattr__(self, n):
                return getattr(self.d, n)
        db.commit()
        try:
            st_ = a._prerun_want(Racer(db), "tc", S, CID)
            err = None
        except Exception as e:
            st_, err = None, repr(e)
        s.check("two pages reading the same person at once: the second's want gives way to the first's job (it raised "
                "the unique key's error, and the person was marked failed)", err is None and st_ == "queued", (st_, err))
        clear(db)
        a._prerun_enqueue(db, "tc", S, CID); db.commit()
        claimed = []

        def make():
            c4 = _sq.connect(a.DB_PATH, timeout=5); c4.row_factory = _sq.Row
            claimed.append(a._prerun_claim(c4)); c4.close()
            return {"summary": "made here", "pending": False}
        res = a._prerun_serve(db, ("tc", S, CID), lambda: {"pending": True}, make)
        jj = jobs(db, kind="tc", subject_id=S)
        s.check("a reader's request takes the queued job over: the worker can't pick it up halfway through (no second "
                "model call), and it is done when the request's reading is written",
                res.get("summary") == "made here" and claimed == [None] and jj[0]["status"] == "done", (claimed, jj))
        clear(db)
        a._prerun_enqueue(db, "tc", S, CID); db.commit()
        try:
            a._prerun_serve(db, ("tc", S, CID), lambda: {"pending": True},
                            lambda: (_ for _ in ()).throw(RuntimeError("boom")))
        except RuntimeError:
            pass
        jj = jobs(db, kind="tc", subject_id=S)
        s.check("...a request that fails hands it back to the queue", jj[0]["status"] == "queued" and not jj[0]["claim"], jj)
        clear(db)
        a._prerun_enqueue(db, "tc", S, CID); db.commit()
        made = []
        res = a._prerun_serve(db, ("tc", S, CID), lambda: {"pending": False, "summary": "ready"},
                              lambda: made.append(1) or {"pending": False})
        jj = jobs(db, kind="tc", subject_id=S)
        s.check("...a reading already there is served as it is: nothing generated, the queue not even written to",
                res.get("summary") == "ready" and not made and jj[0]["status"] == "queued" and not jj[0]["claim"], jj)
        db.execute("UPDATE ai_prerun_jobs SET last_error='model unavailable', attempts=1"); db.commit()
        s.check("...and a job backing off after a model failure is the worker's to retry: the page never takes it (it "
                "marked it done and cancelled the retries)", a._prerun_take(db, ("tc", S, CID)) is None
                and jobs(db, kind="tc", subject_id=S)[0]["status"] == "queued")
        clear(db)
    _src3 = open(os.path.join(H.REPO, "app.py"), encoding="utf-8").read()
    _cl = _src3[_src3.index("def _prerun_claim(db):"):_src3.index("def _prerun_work(db, job):")]
    s.check("the worker reads its claimed job back inside the claim's own write (a save re-queuing it between the "
            "commit and the read left it 'running' with no owner)",
            _cl.index('SELECT * FROM ai_prerun_jobs WHERE claim=?') < _cl.index("db.commit()"))
    _ta = _src3[_src3.index("def _talent_box_apply("):_src3.index("def _talent_box_apply(") + 12000]
    s.check("a Talent Box move queues its insight BEFORE log_activity, whose commit carries it (queued after it, the job "
            "was rolled back as the request closed)",
            _ta.index('"talent_box_move")') < _ta.index('log_activity(db, u["id"], "talent_box_move"'))
    _sv = _src3[_src3.index("def _prerun_serve("):_src3.index("def _prerun_loop():")]
    s.check("a busy database never turns a reading into an error: taking the job is best-effort",
            "except sqlite3.Error" in _sv)
    stub("_pm_approver_subject_ids", lambda db_, u, cid: [S] if u and u["id"] in (M1, M2) else [])
    stub("_idp_remark_owner", lambda db_, rid: M1)
    stub("_idp_summary_for", lambda db_, rid, generate=False, viewer=None, **k: {   # the owner's reading still to make
        "summary": "plain" if generate else None, "pending": not generate, "source": "plain" if generate else None})
    with a.app.test_request_context("/"):
        db = a.get_db(); clear(db)
        a._prerun_enqueue(db, "idp", S, CID); db.commit()
    rq = H.client_as(a, M2).post("/review/team/idp-summary", data={"csrf_token": "tok", "report": str(S)})
    with a.app.test_request_context("/"):
        jj = jobs(a.get_db(), kind="idp", subject_id=S)
    s.check("another approver (a matrix manager) reading the plan never takes the line manager's queued job (it was "
            "marked done with the owner's reading never made)", rq.status_code == 200 and jj[0]["status"] == "queued", jj)
    unstub("_pm_approver_subject_ids", "_idp_remark_owner", "_idp_summary_for")
    unstub()

    # ------------------------------------------------------------------------------------------------------------------
    s.section("the page: one read, polled; the person on screen first")
    js = open(os.path.join(H.REPO, "static", "journey_chat.js"), encoding="utf-8").read()
    _cp = js[js.index("function calPrefetchAll(d) {"):js.index("function pumpCalSummaries() {")]
    s.check("the curve and the department review ask for everyone in ONE read (no request per person)",
            'insWant(axis === "potential" ? "pot" : "perf", want);' in _cp and "queueCalSummary" not in _cp)
    _tw = js[js.index("function tbInsWant(people) {"):js.index("function tbInsFirst(id) {")]
    s.check("the Talent Box's list and panel too", 'insWant("tb", ids);' in _tw and "tbInsPump" not in _tw)
    s.check("the Team summary collects its pending rows and asks once, skipping one that already failed on this page",
            "if (kind && insIds.length) insWant(kind, insIds);" in js
            and "if (!store[r.id] && r.summary_pending && !rmkFails(kind)[r.id]) insIds.push(r.id);" in js)
    _if = js[js.index("function insFetch(kind) {"):js.index("function insLand(kind, id, it) {")]
    s.check("the read posts the ids together, keeps polling while the worker is on them, stops when they leave the "
            "part, drops a failed one, and asks for one itself when there's no worker",
            'fetch("/review/team/insights"' in _if and 'f.append("ids", ids.join(","));' in _if
            and 'if (it.job === "queued" || it.job === "running") return;' in _if
            and 'var inPart = kind === "tb" ? tbStage(curStage) : curStage === INS_STAGE[kind];' in _if
            and "if (!(isMgr && inPart))" in _if
            and 'if (it.job === "failed") { insDrop(kind, [id], true); return; }' in _if
            and "delete w[id]; insDirect(kind, id);" in _if and "t < 8 ? 2500" in _if)
    s.check("the person on screen goes ahead of the rest in every queue (the line manager's had none)",
            "queuePmSummary(prid, true)" in js and "queueTmSummary(rid, true)" in js and "queueIdpSummary(rid, true)" in js
            and "if (front) q.unshift(rid); else q.push(rid);" in js)
    s.check("hovering an icon whose reading isn't in yet asks for it now",
            "rmkWantNow(kind, r.id);" in js and "function rmkWantNow(kind, rid) {" in js)
    s.check("the line manager's queues stop when they leave the part (they kept running before)",
            'if (!(isMgr && curStage === "pm_review")) { lmQueueStop("pm", pmSumQueue); return; }' in js
            and 'if (!(isMgr && curStage === "tm_review")) { lmQueueStop("tm", tmSumQueue); return; }' in js
            and 'if (!(isMgr && curStage === "plan_review")) { lmQueueStop("idp", idpSumQueue); return; }' in js)
    s.check("a light reading on the person's card is asked again in full, never down-graded by the table's read",
            "(calSummaries[k] && !calSummaries[k].light)" in js
            and "if (old && !old.light && !old.retrying) return false;" in js
            and 'rest.appendChild(rmkEl("p", "rv-cal-soft", "Loading their KPI table…"));' in js)
    s.check("paging on: the next person's remarks are summarised ahead too",
            "if (!calRmkSums[nk]) { calRmkRows[nk] = nx; calRemarksFetch(nk); }" in js)
    s.check("the Group Chief's Talent Box asks in the one read too (it was dropped as 'not in the part')",
            'var inPart = kind === "tb" ? tbStage(curStage)' in _if)
    s.check("the ids go in the order shown (object keys come back in numeric order), so the first rows really are first",
            "w[id] = ++insSeq;" in js and "Object.keys(w).sort(function (a, b) { return w[a] - w[b]; })" in _if)
    _sel = js[js.index("function tbSelectCompany(co) {"):js.index("function tbSelectCompany(co) {") + 1500]
    s.check("another business unit clears the Talent Box's set IN PLACE (an in-flight read holds it) -- its people were "
            "stranded, never asked for", "insWantSet.tb = {}" not in _sel
            and "Object.keys(insWantSet.tb).forEach(function (k) { delete insWantSet.tb[k]; });" in _sel)
    s.check("...and a read asked for again meanwhile is never swallowed by the empty-set return",
            _if.index("if (again) { insFetch(kind); return; }") < _if.index("if (!Object.keys(w).length) return;")
            and "if (!w[id]) return; delete w[id]; insDirect(kind, id);" in _if)
    s.check("a retrying plain reading is shown and still polled for the model's", "it.retrying &&" in _if
            and "if (insLand(kind, id, it)) landed.push(id);" in _if)
    s.check("a Talent Box person's page asks for every tab's reading as it opens (insights, what was written, the plan)",
            "function tbPrefetchPerson(pid, f) {" in js and "if (j && j.ok) tbPrefetchPerson(pid, j);" in js)
    _wn = js[js.index("function rmkWantNow(kind, rid) {"):js.index("function rmkButton(kind, r) {")]
    s.check("a reading given up on (the ten-minute cut-off, or failing) is asked again on hover, as its comment says",
            "info.dropped" in _wn and "if (inf.pending) inf.dropped = true;" in js)
    s.check("...ids past one read's cap are tried again after a failed read, never left waiting",
            "else if (Object.keys(w).length) insTimer[kind] = setTimeout(function () { insFetch(kind); }, 5000);" in _if)
    s.check("...and a failed upgrade of a light reading shows it whole, never stuck on 'Loading their KPI table…'",
            js.count("else if (calSummaries[k].light) calSummaries[k].light = false;") == 2)
    s.check("a locked or closed curve / review still fills in its readings (read back after it goes up)",
            "if (live) calPrefetchAll(d);" not in js and "if (!d.locked) calPrefetchAll(d);" not in js
            and "if (!d.locked && !d.closed) calPrefetchAll(d);" not in js)
finally:
    unstub()
    a._PRERUN["force"] = False
    a.ai_draft.is_configured = _real_configured
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("DELETE FROM ai_prerun_jobs")
        db.execute("DELETE FROM pm_kpi_targets WHERE kpi_name LIKE 'ZZPR %'")
        db.execute("DELETE FROM pm_evidence WHERE title='ZZPR sign-off'")
        db.execute("DELETE FROM calib_unit_joins WHERE business_group=?", (BG,))
        db.execute("DELETE FROM buceo_seats WHERE business_group=?", (BG,))
        db.execute("DELETE FROM pm_calibration_groups WHERE name='ZZPR group'")
        db.execute("DELETE FROM pm_remark_summaries WHERE subject_id IN (SELECT id FROM users WHERE employee_id LIKE "
                   "'ZZPR-%')")
        db.execute("DELETE FROM users WHERE employee_id LIKE 'ZZPR-%'")
        db.execute("UPDATE cycles SET half=? WHERE id=?", (_ORIG["half"], CID))
        for k, v in _ORIG["modules"].items():
            db.execute("UPDATE cycle_modules SET active=? WHERE cycle_id=? AND module_key=?", (v, CID, k))
        db.commit()

sys.exit(s.done())
