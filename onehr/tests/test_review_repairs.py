"""Phase C, step 1 -- the repairs the conversation would have triggered.

FOUR OF THE FIVE SHARE ONE SHAPE: a caller posts PART of a form and the server
treats the absence of a field as an instruction to delete it. Every current page
posts every field, so all four are latent -- and a turn-by-turn conversation
posts one answer per turn, which is exactly what turns them live. That is why
they land before the stage engine rather than after it.

    absent  = unchanged
    present and empty = cleared

Those are different, and the code did not distinguish them.

The fifth is dash_tasks() learning the module gate, which it had never called.

This suite WRITES, so it takes a fresh database copy.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Phase C step 1 -- absent is not empty")
SU, _BG, _EMP = H.actors(a)
SRC = H.code_without_docstrings(H.source(a))

# ---------------------------------------------------------------------------
s.section("1. pm_idp_can_check_in() could never return True")
# The vocabulary migration renamed the statuses and rewrote every row; this
# predicate still read the old ones, so POST /idp/progress has always 409'd.
# The same 2 == "HY2" class the Phase 0 sweep fixed, in a second place.
CHECK_ALLOWS = ("draft", "shared", "closed")
s.check("the CHECK constraint still allows exactly these three",
        "CHECK(status IN ('draft','shared','closed'))" in H.source(a))
for status, want in [("shared", True), ("closed", True), ("draft", False)]:
    got = a.pm_idp_can_check_in({"status": status}, True)
    s.check("status %-7s -> can check in: %s" % (status, want), got is want, got)
s.check("an inactive period still refuses",
        a.pm_idp_can_check_in({"status": "shared"}, False) is False)
s.check("no plan at all refuses", a.pm_idp_can_check_in(None, True) is False)
# The real assertion: SOME allowed status must work, or the helper is dead again.
s.check("at least one status the CHECK permits returns True",
        any(a.pm_idp_can_check_in({"status": st}, True) for st in CHECK_ALLOWS))
s.check("it no longer reads a status the CHECK forbids",
        "\"submitted\", \"agreed\"" not in SRC and "'submitted', 'agreed'" not in SRC)

# ---------------------------------------------------------------------------
s.section("2. submit-all must not destroy the employee's own remark")
# THE ONE THAT MATTERS -- the only defect here whose damage is permanent AND
# silent: an omitted field wrote '' and set draft=0, past pm_can_self_edit(),
# so the employee could not put it back.
#
# THIS SECTION MUST DRIVE THE ROUTE ALL THE WAY THROUGH. The first version of it
# posted to /performance/submit-all with no KPI line to submit, so the route
# bailed at "Nothing to submit" long before the remark code -- and every check
# passed with the fix REVERTED. A test that cannot reach the line it is about is
# not a test. `draft` flipping to 0 is the proof the route got there.
with a.app.app_context():
    db = a.get_db()
    cid = a.active_cycle_id(db)
    subj = db.execute("SELECT u.* FROM users u WHERE u.role!='admin' "
                      "AND u.left_at IS NULL LIMIT 1").fetchone()
    db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id IN "
               "(SELECT id FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?)",
               (cid, subj["id"]))
    db.execute("DELETE FROM pm_kpi_targets WHERE cycle_id=? AND subject_id=?",
               (cid, subj["id"]))
    # business_group is NOT NULL; take the subject's own so the row is coherent.
    TID = db.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, unit, "
        "method, target, threshold, excellence, rate1, rate2, rate3, rate4, rate5, "
        "status, business_group, company, department) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved',?,?,?)",
        (cid, subj["id"], "ZZ Review Repair Line", 100.0, "%", "more", 90.0,
         70.0, 100.0, 70.0, 80.0, 90.0, 95.0, 100.0,
         subj["business_group"] or "", subj["company"] or "",
         subj["department"] or "")).lastrowid
    db.commit()

REMARK = "Ran the plant changeover single-handed in March."


def seed_remark(text=REMARK, draft=1):
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_overall_remarks WHERE cycle_id=? AND subject_id=?",
                   (cid, subj["id"]))
        db.execute("INSERT INTO pm_overall_remarks(cycle_id, subject_id, remark, "
                   "submitted_by, draft) VALUES (?,?,?,?,?)",
                   (cid, subj["id"], text, subj["id"], draft))
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (TID,))
        db.commit()


def remark_now():
    r = H.rows(a, "SELECT remark, draft FROM pm_overall_remarks WHERE cycle_id=? "
                  "AND subject_id=?", (cid, subj["id"]))
    return (r[0]["remark"], r[0]["draft"]) if r else (None, None)


E = H.client_as(a, subj["id"])
SUBMIT = {"csrf_token": "tok", "actual_value_%d" % TID: "95"}
# follow_redirects=False throughout: what the POST WROTE is under test, and the
# page it redirects to renders the whole scorecard, which is not.

# --- the field is ABSENT -----------------------------------------------------
seed_remark()
r = E.post("/performance/submit-all", data=dict(SUBMIT), follow_redirects=False)
text_absent, draft_absent = remark_now()
s.note("absent  -> %r draft=%s" % (text_absent, draft_absent))
# The anti-vacuity guard: if draft is still 1 the route never reached the remark
# block and everything below this line proves nothing.
s.check("the route REACHED the remark code (draft promoted to 0)", draft_absent == 0,
        "draft=%s (1 would mean the route bailed early and this section is vacuous)"
        % (draft_absent,))
s.check("the employee's words are untouched", text_absent == REMARK, text_absent)

# --- the field is PRESENT with a new value -----------------------------------
seed_remark()
E.post("/performance/submit-all", data=dict(SUBMIT, overall_remark="Rewritten by me."),
       follow_redirects=False)
text_new, draft_new = remark_now()
s.check("sending a new value still writes it", text_new == "Rewritten by me.", text_new)
s.check("...and still promotes it", draft_new == 0, draft_new)

# --- the field is PRESENT and EMPTY ------------------------------------------
# The fix must not become a lock: an explicit empty string is a real instruction.
seed_remark()
E.post("/performance/submit-all", data=dict(SUBMIT, overall_remark=""), follow_redirects=False)
text_empty, _d = remark_now()
s.check("sending an EMPTY value still clears", text_empty == "", repr(text_empty))
s.check("so absence and empty are genuinely different",
        text_absent == REMARK and text_empty == "", (text_absent, text_empty))

s.section("3. autosave must not wipe the note")
# Behavioural, for the same reason. Save a note, then post only the number.
seed_remark()
AUTO = "/performance/kpi/%d/autosave" % TID
E.post(AUTO, data={"csrf_token": "tok", "actual_value": "91",
                   "note": "Weather delayed it."})
note1 = H.one(a, "SELECT note FROM pm_kpi_results WHERE kpi_target_id=?", (TID,))
s.check("the note was saved", note1 == "Weather delayed it.", note1)
E.post(AUTO, data={"csrf_token": "tok", "actual_value": "93"})
note2 = H.one(a, "SELECT note FROM pm_kpi_results WHERE kpi_target_id=?", (TID,))
val2 = H.one(a, "SELECT actual_value FROM pm_kpi_results WHERE kpi_target_id=?", (TID,))
s.check("posting only the number kept the note", note2 == "Weather delayed it.", note2)
s.check("...and did update the number", val2 == 93.0, val2)
E.post(AUTO, data={"csrf_token": "tok", "actual_value": "94", "note": ""})
note3 = H.one(a, "SELECT note FROM pm_kpi_results WHERE kpi_target_id=?", (TID,))
s.check("an explicit empty note still clears", note3 in (None, ""), note3)

s.section("4. _evidence_clean must not blank the slots it was not sent")
FULL = {"body": "Closed the ARI backlog.", "impact": "Two weeks of overtime avoided.",
        "who": "Site team", "title": "Backlog", "kind": "delivery",
        "occurred_on": "2026-03-14", "occurred_precision": "day",
        "metric_value": "12", "metric_unit": "days"}
base, err = a._evidence_clean(FULL)
s.check("a full form still cleans", err is None and base["body"].startswith("Closed"), err)
s.check("...and keeps the date the human stated", base["occurred_on"] == "2026-03-14")

# The conversation's shape: one field at a time, against the stored row.
partial, err = a._evidence_clean({"impact": "Rewritten."}, base=base)
s.check("a PARTIAL write cleans", err is None, err)
s.check("the changed slot changed", partial["impact"] == "Rewritten.")
for k in ("body", "who", "title", "kind", "occurred_precision", "metric_unit"):
    s.check("  %-20s survives" % k, partial[k] == base[k], (base[k], partial[k]))
# occurred_on is NOT NULL and is the one field a human stated and nobody can
# re-derive. This is the check that would have caught the whole class.
s.check("occurred_on survives -- it is NOT NULL and unrecoverable",
        partial["occurred_on"] == "2026-03-14", partial["occurred_on"])
s.check("the numeric measure survives", partial["metric_value"] == base["metric_value"],
        (base["metric_value"], partial["metric_value"]))
# ...and an explicit empty string still clears, or the fix would be a lock.
cleared, err = a._evidence_clean({"who": ""}, base=base)
s.check("present-and-empty still CLEARS", err is None and cleared["who"] == "", cleared["who"])
s.check("...while its neighbours are untouched", cleared["body"] == base["body"])
# With no base there is nothing to fall back to, and absence really is empty.
bare, err = a._evidence_clean({"body": "x"})
s.check("no base -> absence is empty, as evidence_new() needs", bare["who"] == "")

# ---------------------------------------------------------------------------
s.section("5. dash_tasks() knows about the module gate")
s.check("DASH_TASK_MODULE exists", hasattr(a, "DASH_TASK_MODULE"))
# COVERAGE: every key the function can emit must be classified, or a task nobody
# thought about ships ungated. Same discipline as the URL-map assertion.
import ast  # noqa: E402
import re  # noqa: E402
_src = H.source(a)
_i = _src.find("def dash_tasks(db, u):")
_body = _src[_i:_src.find("\ndef ", _i + 10)]
EMITTED = set(re.findall(r'_dash_task\(\s*"([a-z0-9_]+)"', _body))
# the leadership block passes its key as a variable, from a literal tuple
EMITTED |= set(re.findall(r'\(\s*"(calib_[a-z]+|talent_box)"', _body))
s.note("keys dash_tasks can emit: %s" % ", ".join(sorted(EMITTED)))
s.check("every emitted key is classified", EMITTED <= set(a.DASH_TASK_MODULE),
        sorted(EMITTED - set(a.DASH_TASK_MODULE)))
s.check("...and nothing is classified that cannot be emitted",
        set(a.DASH_TASK_MODULE) <= EMITTED, sorted(set(a.DASH_TASK_MODULE) - EMITTED))
s.check("every module named is a real one",
        set(a.DASH_TASK_MODULE.values()) <= set(a.CYCLE_MODULE_KEYS),
        sorted(set(a.DASH_TASK_MODULE.values()) - set(a.CYCLE_MODULE_KEYS)))

# Behaviour: switch a module off and its tasks must go.
with a.app.test_request_context("/"):
    from flask import session
    session["user_id"] = subj["id"]
    db = a.get_db()
    cid = a.active_cycle_id(db)
    before = a.dash_tasks(db, subj)
    before_keys = {t["key"] for t in before}
s.note("tasks before: %s" % (", ".join(sorted(before_keys)) or "(none)"))

VICTIM = next((m for m in ("pm", "tm", "idp")
               if any(a.DASH_TASK_MODULE.get(k) == m for k in before_keys)), None)
if VICTIM:
    try:
        with a.app.test_request_context("/"):
            from flask import session as _s
            _s["user_id"] = subj["id"]
            db = a.get_db()
            db.execute("INSERT INTO cycle_modules(cycle_id, module_key, active) "
                       "VALUES (?,?,0) ON CONFLICT(cycle_id, module_key) "
                       "DO UPDATE SET active=0", (cid, VICTIM))
            db.commit()
            after_keys = {t["key"] for t in a.dash_tasks(db, subj)}
        gone = {k for k in before_keys if a.DASH_TASK_MODULE.get(k) == VICTIM}
        s.note("switched '%s' off; expected to lose: %s" % (VICTIM, ", ".join(sorted(gone))))
        s.check("its tasks are gone", not (after_keys & gone), sorted(after_keys & gone))
        s.check("no OTHER module's task was lost",
                (before_keys - gone) == (after_keys - gone),
                sorted((before_keys - gone) ^ (after_keys - gone)))
    finally:
        with a.app.app_context():
            db = a.get_db()
            db.execute("DELETE FROM cycle_modules WHERE cycle_id=? AND module_key=?",
                       (cid, VICTIM))
            db.commit()
else:
    s.check("a gateable task exists to switch off", False,
            "no task from pm/tm/idp on this data -- the check proved nothing")

s.section("every surviving task points somewhere real")
# The defect was a live sign over a dead door, so assert the door opens.
with a.app.test_request_context("/"):
    from flask import session as _s2
    _s2["user_id"] = subj["id"]
    urls = [t["url"] for t in a.dash_tasks(a.get_db(), subj)]
bad = []
for u in urls:
    r = H.client_as(a, subj["id"]).get(u)
    if r.status_code >= 400:
        bad.append((u, r.status_code))
s.check("no task links to a 4xx/5xx", not bad, bad)

sys.exit(s.done())
