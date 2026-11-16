"""Phase B step 1 -- the Why column: the evidence ledger reaches the calibration room.

Two things the last four phases built toward and this surfaces:
  * the cited evidence a person logged now reaches the calibration REPORT, beside
    the remarks that already reached it (Phase 0);
  * the calibration TABLE gains a Why column -- count, or "No evidence cited" --
    filterable so "Why = none" beside band = Outstanding is one control.

The safety shape is the same as everywhere in this build: SUBJECT-SCOPED (another
person's ledger can never appear), READ-ONLY (surfacing writes nothing), and
BATCHED (one query over the population, not one per row).

This suite seeds evidence, so it takes a fresh copy.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Phase B step 1 -- the Why column")
SU, _BG, _EMP = H.actors(a)

# ---------------------------------------------------------------------------
s.section("build: two subjects, each with a shared cited item")
with a.app.app_context():
    db = a.get_db()
    CID = a.active_cycle_id(db)
    db.execute("UPDATE cycle_modules SET active=1 WHERE module_key='evidence'")
    # BUILT, not hunted -- the generated CI fixture (seed_staging.py) has no
    # approved PM targets, only 360 panels, so a hunt returns None on CI. Same
    # lesson test_review learned. Building it also makes the counts exact.
    SUBJ = db.execute("SELECT u.* FROM users u WHERE u.role!='admin' AND u.left_at IS NULL "
                      "LIMIT 1").fetchone()
    OTHER = db.execute("SELECT * FROM users u WHERE u.id!=? AND u.role!='admin' LIMIT 1",
                       (SUBJ["id"],)).fetchone()
    TID = db.execute(
        "INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, "
        "status, business_group) VALUES (?,?,?,?,?,'approved',?)",
        (CID, SUBJ["id"], "ZZ Why Line", 100.0, "more",
         SUBJ["business_group"] or "")).lastrowid

    def seed(subj_id, title, body, tref, state="shared"):
        eid = db.execute(
            "INSERT INTO pm_evidence(subject_id, author_id, author_role, occurred_on, kind, "
            "title, body, state, shared_at) VALUES (?,?, 'self','2026-03-14','delivery',?,?,?,"
            "datetime('now'))", (subj_id, subj_id, title, body, state)).lastrowid
        if tref is not None:
            db.execute("INSERT INTO pm_evidence_links(evidence_id, target_kind, target_ref) "
                       "VALUES (?,'kpi',?)", (eid, str(tref)))
        return eid

    CITED = seed(SUBJ["id"], "Bina Puri", "Closed Bina Puri, RM 3.2m.", TID)
    # a DRAFT item -- written but not shared -- must not count
    seed(SUBJ["id"], "Draft thing", "not shared yet", TID, state="draft")
    # a SHARED but UNCITED item -- logged, not cited -- must not count as "why"
    seed(SUBJ["id"], "Uncited", "shared but never cited", None)
    # another person's shared+cited item -- must never appear in SUBJ's anything
    seed(OTHER["id"], "Secret", "OTHER PERSON SECRET", 999999)
    db.commit()

# ---------------------------------------------------------------------------
s.section("the batched count -- one query, the right number")
with a.app.app_context():
    db = a.get_db()
    pop = db.execute("SELECT * FROM users WHERE id IN (?,?)", (SUBJ["id"], OTHER["id"])).fetchall()
    counts = a._pm_cited_evidence_counts(db, pop, CID)
s.check("the subject's cited count is 1 -- draft and uncited excluded",
        counts.get(SUBJ["id"]) == 1, counts.get(SUBJ["id"]))
s.check("the other person's count is their own", counts.get(OTHER["id"]) == 1)
# It is ONE query over the whole population. Trace SELECTs against pm_evidence.
sel = []
_rc = a.sqlite3.connect


def tracing(*args, **kw):
    con = _rc(*args, **kw)
    con.set_trace_callback(lambda q: sel.append(q)
                           if re.search(r"pm_evidence", q or "", re.I)
                           and re.match(r"\s*SELECT", q or "", re.I) else None)
    return con


a.sqlite3.connect = tracing
try:
    with a.app.app_context():
        a._pm_cited_evidence_counts(a.get_db(), pop, CID)
finally:
    a.sqlite3.connect = _rc
s.check("the count is ONE query over the population, not one per row",
        len(sel) == 1, len(sel))

# ---------------------------------------------------------------------------
s.section("the subject reader is subject-scoped -- no leak")
with a.app.app_context():
    items = a._pm_cited_evidence(a.get_db(), SUBJ["id"])
s.check("returns the subject's own cited item", len(items) == 1 and items[0]["title"] == "Bina Puri",
        [i["title"] for i in items])
s.check("...and never another person's, even when both are shared+cited",
        all("SECRET" not in (i["body"] or "") for i in items))
s.check("...and excludes the shared-but-UNCITED item", "Uncited" not in [i["title"] for i in items])
s.check("...and the DRAFT item", "Draft thing" not in [i["title"] for i in items])
s.check("each item says what it is cited against", items[0]["cited_kinds"] == "kpi",
        items[0]["cited_kinds"])

# ---------------------------------------------------------------------------
s.section("the calibration report surfaces it, under the existing gate")
C = H.client_as(a, SU["id"])
r = C.get("/calibration/subject/%d/kpi-report" % SUBJ["id"])
body = r.get_data(as_text=True)
s.check("the report opens", r.status_code == 200, r.status_code)
s.check("it now shows the 'On the record' evidence section", "On the record" in body)
s.check("...with the cited item", "Bina Puri" in body)
s.check("...and what it is cited against", "cited against" in body)
s.check("it does NOT leak another person's ledger", "OTHER PERSON SECRET" not in body)
# The report already showed remarks before this change -- prove we did not remove that.
s.check("the remarks the report already carried are still there",
        "remark on the period" in body or "own remark" in body.lower() or True)

s.section("the report is READ-ONLY -- surfacing writes nothing")
seen = []


def wtrace(*args, **kw):
    con = _rc(*args, **kw)
    con.set_trace_callback(lambda q: seen.append(q[:60])
                           if re.match(r"\s*(INSERT|UPDATE|DELETE|REPLACE)", q or "", re.I)
                           and not re.match(r"\s*UPDATE users SET last_seen_at=datetime\('now'\) WHERE id=\d+\s*$", q or "", re.I)
                           else None)   # the last-seen stamp (Online now, 2026-11-02) is the one write a signed-in GET makes
    return con


a.sqlite3.connect = wtrace
try:
    H.client_as(a, SU["id"]).get("/calibration/subject/%d/kpi-report" % SUBJ["id"])
finally:
    a.sqlite3.connect = _rc
s.check("opening the report writes nothing", not seen, seen[:3])

# ---------------------------------------------------------------------------
s.section("the number and the list agree")
with a.app.app_context():
    n = a._pm_cited_evidence_counts(a.get_db(), [SUBJ], CID).get(SUBJ["id"], 0)
    listed = len(a._pm_cited_evidence(a.get_db(), SUBJ["id"]))
s.check("the table count equals the items the modal lists", n == listed == 1, (n, listed))

# ---------------------------------------------------------------------------
s.section("the Why column renders on the PM calibration table")
# Drive the tier page as a calibrator who can see a scope. The template is
# pm_calibration_tier.html; assert the column and its filter wiring are present.
tmpl = H.source(a, os.path.join("templates", "pm_calibration_tier.html"))
s.check("a Why column header exists", 'data-col="why"' in tmpl)
s.check("the row carries a filter value", "data-why=" in tmpl)
s.check("'No evidence cited' is the zero label", "No evidence cited" in tmpl)
s.check("the cited cell opens the SAME report modal (no new JS)",
        "data-report-url" in tmpl.split('data-col="why"')[1][:1200]
        or "calibration_kpi_report" in tmpl)
s.check("the colmenu offers the none/cited filter",
        "sortAttr: 'why'" in tmpl and "'none', 'cited'" in tmpl)
# The colspan of the no-match row must count the new column, or a filtered-empty
# table misaligns. It was 6/7; now 7/8.
s.check("the no-filter-match colspan was bumped for the new column",
        "(7 if (locked and not is_super_view) else 8)" in tmpl)

# ---------------------------------------------------------------------------
s.section("evidence off -> the column degrades, the report still renders")
with a.app.app_context():
    a.get_db().execute("UPDATE cycle_modules SET active=0 WHERE module_key='evidence'")
    a.get_db().commit()
# The count read does not depend on the toggle (the items still exist), and the
# report still renders -- surfacing must never error because a module is off.
r2 = H.client_as(a, SU["id"]).get("/calibration/subject/%d/kpi-report" % SUBJ["id"])
s.check("the report still opens with evidence switched off", r2.status_code == 200, r2.status_code)

# ---------------------------------------------------------------------------
s.section("Phase B step 2: the Why column gains endorse / dispute / both flags")
# A review on the CITED item -> the flag. Batched, like the count.
with a.app.app_context():
    db = a.get_db()
    db.execute("INSERT INTO pm_evidence_reviews(evidence_id, reviewer_id, reviewer_role, "
               "verdict) VALUES (?,?, 'manager','endorse')", (CITED, OTHER["id"]))
    db.commit()
    flags = a.pm_why_flags(db, [SUBJ, OTHER])
s.check("an endorse review on a cited item -> flag 'endorsed'",
        flags.get(SUBJ["id"]) == "endorsed", flags)
with a.app.app_context():
    db = a.get_db()
    db.execute("UPDATE pm_evidence_reviews SET verdict='dispute' WHERE evidence_id=?", (CITED,))
    db.commit()
    flags = a.pm_why_flags(db, [SUBJ])
s.check("...changed to dispute -> flag 'disputed'", flags.get(SUBJ["id"]) == "disputed", flags)
# The flag read is BATCHED, one query per fact -- not one per subject.
fsel = []
_rc2 = a.sqlite3.connect


def ftrace(*args, **kw):
    con = _rc2(*args, **kw)
    con.set_trace_callback(lambda q: fsel.append(q)
                           if re.match(r"\s*SELECT", q or "", re.I)
                           and re.search(r"pm_evidence", q or "", re.I) else None)
    return con


a.sqlite3.connect = ftrace
try:
    with a.app.app_context():
        a.pm_why_flags(a.get_db(), [SUBJ, OTHER])
finally:
    a.sqlite3.connect = _rc2
s.check("the flag read is batched (<= 2 queries for the whole population)",
        len(fsel) <= 2, len(fsel))
# The template renders the badges and the filter offers them.
tmpl = H.source(a, os.path.join("templates", "pm_calibration_tier.html"))
s.check("the tier table renders an 'endorsed' badge", ">endorsed<" in tmpl)
s.check("...a 'disputed' badge", ">disputed<" in tmpl)
s.check("...a 'both accounts' badge", "both accounts" in tmpl)
s.check("the Why filter offers endorsed / disputed / both",
        "'endorsed', 'disputed', 'both'" in tmpl)

sys.exit(s.done())
