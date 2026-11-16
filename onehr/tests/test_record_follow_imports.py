"""The rating record follows the KPI targets import and the BU KPI page (Chris, 2026-11-08: "Fix these too"; the same rule as the
person page's KPI edits, `_kpe_record_follow`, commit 61d85667).

A person's stored rating record is a snapshot (rating_records). Two writers changed what it reads and rebuilt nothing, and asked the
AI pre-run for nothing: the KPI targets import (`_kti_apply`) and the BU KPI page's adds, take-offs, re-weights and moves (`_bu_kpi_apply`
for lines without a result: a line WITH a result whose figures moved was already rebuilt, "bu_kpi_retarget").

What this suite holds (every guard falsified, the batched guard compared with the old per-person one, nothing left behind):
  * `_kpe_records_follow`: ONE guard over a population (a record row, a result or a check-in, a draft too; the same answer the old
    per-person guard gave, person by person), people who pass are rebuilt under the event, the others only ask the pre-run, an Early
    Year does nothing, nobody outside the list is touched, a list past the chunk size gives the same answer
  * the KPI targets import (Year-End): a person with a record, a result or a check-in has the stored record rebuilt (equal to the live
    reader `_rating_record_row`, last_event "kpi_import", by the importer) and it differs from the record before the import; a person with
    neither gets NO row and the pre-run is asked; someone outside the file is untouched; each person once; an Early Year import does nothing
  * the BU KPI page (Year-End): adding a person, taking one off, a target change, the KPI taken off: each person whose line changed is
    rebuilt once (a retarget keeps "bu_kpi_retarget", every other change is "bu_kpi_change"), a person with no record and nothing entered gets
    no row but the pre-run, a person the save did not change is untouched; a weight alone moves a record (also on a line with a result)
  * the writers that follow pass the touched people through ONE collector, so a person changed by two KPIs of one save, or retargeted and
    re-weighted, is rebuilt once
"""
import atexit
import html
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("The rating record follows the KPI targets import and the BU KPI page")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, CO, BGI, COI = "ZZRF Group", "ZZRF Unit", "ZZRI Group", "ZZRI Unit"
U = {}
PAT, SALES = "ZZRF PAT", "ZZRF Sales"
KURL = "/admin/performance/import"
BURL = "/admin/performance/bu-kpis?fbg=%s&fbu=%s" % (BG.replace(" ", "+"), CO.replace(" ", "+"))
KHEAD = "Employee ID,KPI,Focus,KPI Description,Unit of Measure,Weightage,Method,Rate 1,Rate 2,Rate 3,Rate 4,Rate 5,Matrix manager ID\n"


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9RF-%' OR employee_id LIKE 'ZZ9RI-%'")]
    if ul:
        ph = ",".join("?" * len(ul))
        ids = "SELECT id FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph
        for tb in ("pm_kpi_approvals", "pm_kpi_results", "pm_checkins", "pm_kpi_target_approvers", "pm_kpi_moderation_drafts"):
            db.execute("DELETE FROM %s WHERE kpi_target_id IN (%s)" % (tb, ids), ul)
        db.execute("DELETE FROM pm_review_chat WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM pm_manager_chat WHERE reviewer_id IN (%s) OR report_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM rating_records WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM ai_prerun_jobs WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM pm_kpi_targets WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM cycle_participants WHERE subject_id IN (%s)" % ph, ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action IN ('pm_kpi_import','pm_bu_kpi') AND (detail LIKE '%ZZRF%' OR detail LIKE '%ZZRI%')")
    for g_ in (BG, BGI):
        db.execute("DELETE FROM pm_bu_kpis WHERE business_group=?", (g_,))
        db.execute("DELETE FROM pm_kpi_library WHERE business_group=?", (g_,))
        db.execute("DELETE FROM pm_bg_config WHERE business_group=?", (g_,))
        db.execute("DELETE FROM org_units WHERE business_group=?", (g_,))
    db.commit()


def n_of(sql, *args):
    return H.one(a, sql, args)


def rec(eid):
    """The stored record's (last_event, last_event_by, updated_at, the _RR_WRITE_COLS values), or None."""
    r = H.rows(a, "SELECT last_event, last_event_by, updated_at, %s FROM rating_records WHERE cycle_id=? AND subject_id=?"
               % ", ".join(a._RR_WRITE_COLS), (CID, U[eid]))
    return tuple(r[0]) if r else None


def live(eid):
    """What the live reader says now, in _RR_WRITE_COLS order."""
    with a.app.app_context():
        db = a.get_db()
        r = a._rating_record_row(db, CID, db.execute("SELECT * FROM users WHERE id=?", (U[eid],)).fetchone())
        return tuple(r.get(c) for c in a._RR_WRITE_COLS)


def current(eid):
    r = rec(eid)
    return r is not None and tuple(r[3:]) == live(eid)


def stored(eid):
    r = rec(eid)
    return tuple(r[3:]) if r else None


def prime(who):
    with a.app.app_context():
        db = a.get_db()
        a._rating_record_refresh(db, CID, [U[e] for e in who], "zzrf_prime", SU["id"], commit=True)


ASKS = []   # (event, tuple of people) for every _prerun_on_event call, and REFRESH: every _rating_record_refresh call
REFRESH = []
_real_prerun, _real_refresh = a._prerun_on_event, a._rating_record_refresh


def _prerun_spy(db, cycle_id, subject_ids, event):
    ASKS.append((event, tuple(sorted({int(x) for x in subject_ids if x}))))
    return _real_prerun(db, cycle_id, subject_ids, event)


def _refresh_spy(db, cycle_id, subject_ids, event, actor_id=None, commit=False):
    REFRESH.append((event, tuple(sorted({int(x) for x in subject_ids if x}))))
    return _real_refresh(db, cycle_id, subject_ids, event, actor_id, commit)


a._prerun_on_event, a._rating_record_refresh = _prerun_spy, _refresh_spy


def reset_spy():
    del ASKS[:]
    del REFRESH[:]


def asked(eid, event=None):
    """How many times the pre-run was asked for this person (under this event)."""
    return sum(1 for ev, ids in ASKS if U[eid] in ids and (event is None or ev == event))


def refreshed(eid, event=None):
    return sum(1 for ev, ids in REFRESH if U[eid] in ids and (event is None or ev == event))


def lines(eid, name=None):
    q = "SELECT t.* FROM pm_kpi_targets t WHERE t.cycle_id=? AND t.subject_id=?" + (" AND t.kpi_name=?" if name else "")
    return [dict(r) for r in H.rows(a, q, (CID, U[eid]) + ((name,) if name else ()))]


def line(eid, name):
    r = lines(eid, name)
    return r[0] if r else None


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    CID = a.active_cycle_id(db)
    PREV = dict(db.execute("SELECT kind, year, half, min_job_grade FROM cycles WHERE id=?", (CID,)).fetchone())
    W0 = db.execute("SELECT opens_at, closes_at FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'", (CID,)).fetchone()

    def _put_back():
        with a.app.app_context():
            d_ = a.get_db()
            d_.execute("UPDATE cycles SET kind=?, year=?, half=?, min_job_grade=? WHERE id=?",
                       (PREV["kind"], PREV["year"], PREV["half"], PREV["min_job_grade"], CID))
            d_.execute("DELETE FROM cycle_windows WHERE cycle_id=? AND cell='pm_hod'", (CID,))
            if W0:
                d_.execute("INSERT INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', ?, ?)",
                           (CID, W0[0], W0[1]))
            _cleanup(d_)
    atexit.register(_put_back)
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_hod', "
               "'2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
    for g_, c_ in ((BG, CO), (BGI, COI)):
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (g_, c_))
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (g_,))
    LIB = {}
    for nm, bu in ((PAT, 1), (SALES, 0)):
        LIB[nm] = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, unit, "
                             "method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level) VALUES (?, '*', '*', 0, '*', ?, "
                             "'Financial', '%', 'more', 90, 95, 100, 105, 110, 20, ?)", (BG, nm, bu)).lastrowid
    U["M"] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
                        "job_grade, confirmation_date) VALUES ('zz9rf-m', 'ZZ RF Manager', 'x', 'user', 'ZZ9RF-M', ?, ?, 'Management', "
                        "'21', '2020-01-01')", (BG, CO)).lastrowid

    def person(e, bg, co, prefix):
        U[e] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, department, "
                          "job_grade, confirmation_date, manager_id, hod_id) VALUES (?,?, 'x', 'user', ?,?,?, 'Sales', '14', '2020-01-01', ?, ?)",
                          (prefix.lower() + e.lower(), "ZZ RF " + e, prefix + e, bg, co, U["M"], U["M"])).lastrowid

    def put(e, name, w, bg, co, rates=(90, 95, 100, 105, 110), lib=None):
        return db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, unit, category, rate1, rate2, rate3, "
                          "rate4, rate5, business_group, company, library_id) VALUES (?,?,?,?, 'more', '%', 'Financial', ?,?,?,?,?, ?,?,?)",
                          (CID, U[e], name, w) + tuple(rates) + (bg, co, lib)).lastrowid
    # the import's unit (no BU KPI there): A has a record only, B a result, C neither, E a check-in, D a record and a result but is not in the file
    TK = {}
    for e in "ABCDE":
        person(e, BGI, COI, "ZZ9RI-")
        TK[e] = put(e, "ZZRI K1", 100, BGI, COI)
    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) VALUES (?, 97, 'n', ?, 0, 0)",
               (TK["B"], U["B"]))
    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) VALUES (?, 97, 'n', ?, 0, 0)",
               (TK["D"], U["D"]))
    db.execute("INSERT INTO pm_checkins(kpi_target_id, answer, answered_by) VALUES (?, 'on_track', ?)", (TK["E"], U["E"]))
    # a draft result is input too (the old guard counted it): F, in the import's unit
    person("F", BGI, COI, "ZZ9RI-")
    TK["F"] = put("F", "ZZRI K1", 100, BGI, COI)
    db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) VALUES (?, 90, 'd', ?, 1, 0)",
               (TK["F"], U["F"]))
    db.commit()
SUP = H.client_as(a, SU["id"])
IDS = {e: U[e] for e in "ABCDEF"}


def kline(eid, kpi, w, rates=(80, 85, 90, 95, 100)):
    return '%s,%s,,"",%%,%s,More,%s,\n' % (eid, kpi, w, ",".join(str(r) for r in rates))


def kti_import(text, name="rf.csv", fn="kpi_targets"):
    r = SUP.post(KURL, data={"csrf_token": "tok", "preview": "1", "file": (io.BytesIO(text.encode()), name)}, content_type="multipart/form-data")
    m = re.search(r"check=([0-9a-f]{32})", r.headers.get("Location", ""))
    tok = m.group(1) if m else ""

    def step(action, **form):
        return SUP.post(KURL, data=dict({"csrf_token": "tok", "token": tok, "action": action}, **form), follow_redirects=True)
    step("quality_ok", ack="1")
    step("to_apply")
    out = step("apply").get_data(as_text=True)
    return tok, out


try:
    # ---------------------------------------------------------------------------------------------------------------
    s.section("the batched guard gives the answer the per-person guard gave")
    def old_guard(db_, uid):   # the guard of 61d85667, one person at a time
        return bool(db_.execute(
            "SELECT 1 FROM rating_records WHERE cycle_id=? AND subject_id=? UNION "
            "SELECT 1 FROM pm_kpi_results r JOIN pm_kpi_targets t ON t.id=r.kpi_target_id WHERE t.cycle_id=? AND t.subject_id=? UNION "
            "SELECT 1 FROM pm_checkins c JOIN pm_kpi_targets t ON t.id=c.kpi_target_id WHERE t.cycle_id=? AND t.subject_id=? LIMIT 1",
            (CID, uid, CID, uid, CID, uid)).fetchone())
    prime("A")
    reset_spy()
    with a.app.app_context():
        db = a.get_db()
        want = {e: old_guard(db, U[e]) for e in "ABCDEF"}
        got = a._kpe_records_follow(db, SU, CID, list(IDS.values()), "kpi_edit")
        db.commit()
    s.check("A (record), B (result), D (result), E (check-in), F (a draft) pass; C (nothing) does not: the old guard's answer person by person",
            want == {"A": True, "B": True, "C": False, "D": True, "E": True, "F": True}, want)
    s.check("...so five are rebuilt and one only asks the pre-run", got == (5, 1, 0), got)
    s.check("...C gets NO record row (the page does not gain a blank line), the others do and equal the live reader",
            rec("C") is None and all(current(e) for e in "ABDEF"), [e for e in "ABCDEF" if rec(e) is None])
    s.check("...the rebuild is one call and the pre-run is asked once for each person (for C by itself, for the rest by the refresh)",
            len(REFRESH) == 1 and set(REFRESH[0][1]) == {U[e] for e in "ABDEF"} and all(asked(e) == 1 for e in "ABCDEF"),
            (REFRESH, ASKS))
    s.check("...last_event is the event the caller gave, by the actor", rec("B")[0] == "kpi_edit" and rec("B")[1] == SU["id"], rec("B")[:2])
    reset_spy()
    with a.app.app_context():
        db = a.get_db()
        a._kpe_record_follow(db, SU, CID, U["C"], "kpi_edit")
        a._kpe_record_follow(db, SU, CID, U["A"], "kpi_edit")
        db.commit()
    s.check("the one-person wrapper gives the same answer (C asks the pre-run only, A is rebuilt)", rec("C") is None and refreshed("A") == 1 and refreshed("C") == 0
            and asked("C") == 1, (REFRESH, ASKS))
    reset_spy()
    with a.app.app_context():
        db = a.get_db()
        r0 = a._kpe_records_follow(db, SU, CID, [], "kpi_edit"), a._kpe_records_follow(db, SU, CID, [0, None], "kpi_edit")
        a._KPE_FOLLOW_CHUNK, keep = 2, a._KPE_FOLLOW_CHUNK
        try:
            r2 = a._kpe_records_follow(db, SU, CID, list(IDS.values()), "kpi_edit")
        finally:
            a._KPE_FOLLOW_CHUNK = keep
        db.commit()
    s.check("an empty list does nothing; a list past the chunk size (2) gives the same answer in several queries",
            r0 == ((0, 0, 0), (0, 0, 0)) and r2 == (5, 1, 0), (r0, r2))
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET kind='early_year', half=0 WHERE id=?", (CID,))
        db.commit()
        reset_spy()
        e0 = a._kpe_records_follow(db, SU, CID, list(IDS.values()), "kpi_edit")
        db.execute("UPDATE cycles SET kind='year_end', half=2 WHERE id=?", (CID,))
        db.commit()
    s.check("an Early Year does nothing: no rebuild, no pre-run", e0 == (0, 0, 0) and not REFRESH and not ASKS, (e0, REFRESH, ASKS))
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM rating_records WHERE subject_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZ9R_-%')")
        db.commit()

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the KPI targets import (Year-End): records rebuilt in the import's own transaction")
    prime("A")
    prime("D")
    before = {e: stored(e) for e in "AD"}
    d_before = rec("D")
    reset_spy()
    # A: K1 from 100 down to 60 (total 60%: the file's own quality note), B (result), C (nothing), E (check-in), F (draft): the same; D not in the file
    FILE = KHEAD + "".join(kline("ZZ9RI-" + e, "ZZRI K1", 60) for e in "ABCEF")
    tok, out = kti_import(FILE)
    s.check("nothing was left over (4 people to rebuild, far under a Capture click's worth): the result says nothing about Capture",
            "will update at the next Capture" not in out and a._records_left_note(0) == "", "")
    s.check("the import applied (the lines changed)", all(line(e, "ZZRI K1")["weightage"] == 60 for e in "ABCEF"),
            [(e, line(e, "ZZRI K1")["weightage"]) for e in "ABCEF"])
    s.check("A (a record) is rebuilt: the stored record equals the live reader, last_event kpi_import, by the importer, and it is not the record from before",
            current("A") and rec("A")[0] == "kpi_import" and rec("A")[1] == SU["id"] and stored("A") != before["A"], (rec("A") or ())[:3])
    for e, why in (("B", "a result"), ("E", "a check-in"), ("F", "a draft result")):
        s.check("%s (%s) has a record built and equal to the live reader, last_event kpi_import" % (e, why),
                current(e) and rec(e)[0] == "kpi_import", rec(e) and rec(e)[:3])
    s.check("C (no record, nothing entered) gets NO row; the pre-run is asked for them once, under kpi_import",
            rec("C") is None and asked("C", "kpi_import") == 1 and asked("C") == 1, (asked("C"), rec("C")))
    s.check("D (not in the file) is untouched: the same row, the same time, the pre-run not asked, no rebuild",
            rec("D") == d_before and asked("D") == 0 and refreshed("D") == 0, (rec("D"), d_before))
    s.check("each person in the file is rebuilt once and asked once (no second pass)",
            all(refreshed(e) == 1 and asked(e) == 1 for e in "ABEF") and refreshed("C") == 0 and asked("C") == 1,
            [(e, refreshed(e), asked(e)) for e in "ABCEF"])
    n_rr = n_of("SELECT COUNT(*) FROM rating_records WHERE cycle_id=? AND subject_id IN (%s)" % ",".join(str(U[e]) for e in "ABCDEF"), CID)
    s.check("the rating records page gained no blank line: exactly the people with a record or an input have a row (A, B, D, E, F)", n_rr == 5, n_rr)

    s.section("the import: a people-count of one query, the transaction, the people outside")
    src = H.source(a)
    body = src[src.index("def _kti_apply("):src.index("def _kti_make_setup(")]
    s.check("the follow runs inside `_kti_apply`, before the caller's commit (one follow, at the end, from one collector)",
            body.count("_bu_follow_flush(") == 1 and body.index("_bu_follow_flush(") > body.index("tid_of[(r[\"subject_id\"], r[\"kpi_name\"])] = tid"), "")
    post = src[src.index("res = _kti_apply(db, me, period, chk, m, decisions)"):]
    s.check("...and `_kti_apply`'s caller commits after it (the refresh is in the import's transaction)", post[:200].count("db.commit()") == 1, post[:120])

    # a second import: nobody in the file has changed their lines but A's weight; the Early Year import does nothing
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET kind='early_year', half=0 WHERE id=?", (CID,))
        db.commit()
    rows_before = n_of("SELECT COUNT(*) FROM rating_records WHERE cycle_id=?", CID)
    snap = {e: rec(e) for e in "ABDEF"}
    reset_spy()
    kti_import(KHEAD + "".join(kline("ZZ9RI-" + e, "ZZRI K1", 70) for e in "ABCEF"), "early.csv")
    with a.app.app_context():
        db = a.get_db()
        db.execute("UPDATE cycles SET kind='year_end', half=2 WHERE id=?", (CID,))
        db.commit()
    s.check("an Early Year import changes the lines and rebuilds nothing, asks nothing: records and row count as they were",
            all(line(e, "ZZRI K1")["weightage"] == 70 for e in "ABCEF") and {e: rec(e) for e in "ABDEF"} == snap
            and n_of("SELECT COUNT(*) FROM rating_records WHERE cycle_id=?", CID) == rows_before and not REFRESH and not ASKS,
            (REFRESH, ASKS))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the cap: one request rebuilds no more than a Capture click does; the rest wait for Capture")
    CAP_KEEP = a._RR_CAPTURE_BATCH
    a._RR_CAPTURE_BATCH = 2
    try:
        def no_records():
            with a.app.app_context():
                db_ = a.get_db()
                db_.execute("DELETE FROM rating_records WHERE subject_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZ9R_-%')")
                db_.commit()
        no_records()
        reset_spy()
        with a.app.app_context():
            db = a.get_db()
            got = a._kpe_records_follow(db, SU, CID, list(IDS.values()), "kpi_edit")
            db.commit()
        # no records now: B (result), D (result), E (check-in), F (draft) pass the guard; A and C have neither
        s.check("with a cap of 2 and four people who pass the guard: exactly two are rebuilt, the lowest ids (B, D); (rebuilt, only the pre-run, left over) = (2, 2, 2)",
                got == (2, 2, 2) and current("B") and current("D") and rec("E") is None and rec("F") is None and rec("A") is None, got)
        s.check("...the two over the cap (E, F) have no rebuild but the pre-run is asked for them, once each, with the rest",
                refreshed("E") == 0 and refreshed("F") == 0 and asked("E") == 1 and asked("F") == 1 and asked("A") == 1 and asked("C") == 1
                and len(REFRESH) == 1 and set(REFRESH[0][1]) == {U["B"], U["D"]}, (REFRESH, ASKS))
        with a.app.app_context():
            db = a.get_db()
            under = a._kpe_records_follow(db, SU, CID, list(IDS.values()), "kpi_edit", cap=10)
            db.commit()
        s.check("a cap above the number who pass rebuilds them all and leaves nothing over", under == (4, 2, 0) and all(current(e) for e in "BDEF"), under)
        no_records()
        with a.app.app_context():
            db = a.get_db()
            zero = a._kpe_records_follow(db, SU, CID, list(IDS.values()), "kpi_edit", cap=0)
            db.commit()
        s.check("a cap of 0 rebuilds nobody: four left over, no row appears", zero == (0, 2, 4) and all(rec(e) is None for e in "ABCDEF"), zero)
        s.check("the sentence: empty at 0, singular at 1, plural after, Group People's words",
                a._records_left_note(0) == "" and a._records_left_note(1) == "1 person's rating record will update at the next Capture on Ratings record."
                and a._records_left_note(7) == "7 people's rating records will update at the next Capture on Ratings record."
                and "HR" not in a._records_left_note(3), (a._records_left_note(1), a._records_left_note(7)))

        # the KPI targets import with the cap at 2: A (a record), B (a result), E (a check-in), F (a draft) pass; C does not
        no_records()
        prime("A")
        reset_spy()
        tok, out = kti_import(KHEAD + "".join(kline("ZZ9RI-" + e, "ZZRI K1", 50) for e in "ABCEF"), "cap.csv")
        say = html.unescape(out)
        s.check("the import: exactly two records are rebuilt (A, B: the lowest ids), under kpi_import",
                all(current(e) and rec(e)[0] == "kpi_import" for e in "AB") and rec("E") is None and rec("F") is None
                and [e for e in "ABCEF" if rec(e) is not None] == ["A", "B"], [(e, rec(e) and rec(e)[0]) for e in "ABCEF"])
        s.check("...E and F (past the cap) have no rebuild, but the pre-run is asked for them once each (and C, who has nothing)",
                refreshed("E") == 0 and refreshed("F") == 0 and asked("E", "kpi_import") == 1 and asked("F", "kpi_import") == 1
                and asked("C", "kpi_import") == 1, (REFRESH, ASKS))
        s.check("...the result names how many wait: '2 people's rating records will update at the next Capture on Ratings record.' (the flash)",
                say.count("2 people's rating records will update at the next Capture on Ratings record.") >= 1, re.findall(r"[^<>]*next Capture[^<>]*", say)[:3])
        res_ = a._imp_meta("kpi_targets", tok).get("result") or {}
        done_pg = html.unescape(SUP.get(KURL + "?done=" + tok).get_data(as_text=True))
        s.check("...and the stored result holds the count and the sentence, and the done page lists it as a line of its own (beside the flash)",
                res_.get("records_left") == 2 and res_.get("records_note") == a._records_left_note(2)
                and "<li>2 people's rating records will update at the next Capture on Ratings record.</li>" in done_pg,
                (res_.get("records_left"), res_.get("records_note")))
    finally:
        a._RR_CAPTURE_BATCH = CAP_KEEP

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the BU KPI page (Year-End): set up, then each change")
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM rating_records WHERE subject_id IN (SELECT id FROM users WHERE employee_id LIKE 'ZZ9R_-%')")
        db.commit()
    with a.app.app_context():
        db = a.get_db()
        for e in "ABCDEFGH":
            person(e + "x", BG, CO, "ZZ9RF-")   # employee IDs ZZ9RF-Ax ...
        # A, B, F carry PAT (lines of their own, adopted by the first save); B and D hold SALES at 70; E is the bystander with a record
        put("Ax", PAT, 30, BG, CO, lib=LIB[PAT])
        put("Bx", PAT, 30, BG, CO, lib=LIB[PAT])
        put("Fx", PAT, 30, BG, CO, lib=LIB[PAT])
        put("Gx", PAT, 30, BG, CO, lib=LIB[PAT])
        put("Bx", SALES, 70, BG, CO, lib=LIB[SALES])
        put("Dx", SALES, 70, BG, CO, lib=LIB[SALES])
        put("Ex", SALES, 100, BG, CO, lib=LIB[SALES])
        db.commit()
    K = "k%d_" % LIB[PAT]

    def card(holders, adds=None, rates=(80, 90, 100, 110, 120)):
        f = {K + "rate%d" % i: str(v) for i, v in enumerate(rates, 1)}
        f.update({K + "carriers": "holders", K + "wmode": "own", K + "unit": "%", K + "holder_set": "1"})
        f[K + "holder"] = ["ZZ9RF-" + x + "x" for x in holders]
        if adds:
            f[K + "addp"] = ["ZZ9RF-" + x + "x" for x in adds]
            for x, w in adds.items():
                f[K + "addw_" + a.ja_eid("ZZ9RF-" + x + "x")] = str(w)
        return f

    def post(action, form):
        d = {"csrf_token": "tok", "action": action, "kpi": str(LIB[PAT])}
        d.update(form)
        out = SUP.post(BURL, data=d, follow_redirects=True).get_data(as_text=True)
        m = re.search(r'class="flash[^>]*>([^<]{0,700})', out)
        return m.group(1).replace("&#39;", "'") if m else out[:200]   # what the page said

    reset_spy()
    out = post("save_kpi", card("ABF"))   # Gx is not a holder: its line stays its own
    SETUP = H.rows(a, "SELECT id FROM pm_bu_kpis WHERE business_group=? AND kpi_name=?", (BG, PAT))[0][0]
    s.check("set up: A, B, F adopt the unit's PAT; nobody has a record yet", all(
        line(e + "x", PAT)["bu_kpi_id"] == SETUP for e in "ABF") and n_of(
        "SELECT COUNT(*) FROM rating_records WHERE subject_id IN (%s)" % ",".join(str(U[e + "x"]) for e in "ABF"), ) == 0,
        out[:300])
    s.check("...so the first save gave NO record row to anyone (nothing to follow), and asked the pre-run once each for A, B, F",
            not REFRESH and all(asked(e + "x") == 1 for e in "ABF") and asked("Gx") == 0 and asked("Ex") == 0, (REFRESH, ASKS))
    # A enters a result (a line with a result), then A, B, D, E have a record
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) VALUES (?, 99, 'n', ?, 0, 0)",
                   (line("Ax", PAT)["id"], U["Ax"]))
        db.commit()
    prime(["Ax", "Bx", "Dx", "Ex"])
    snapE = rec("Ex")

    s.section("adding people on the BU KPI card: a person with a record is rebuilt, one with nothing only asks the pre-run")
    reset_spy()
    out = post("save_kpi", card("ABF", adds={"C": 30, "D": 30}))
    s.check("C and D were added (a PAT line each, linked)", all(line(e + "x", PAT) and line(e + "x", PAT)["bu_kpi_id"] == SETUP for e in "CD"), out[:300])
    s.check("D (a record, SALES at 70) is rebuilt: equals the live reader, last_event bu_kpi_change, by the super admin",
            current("Dx") and rec("Dx")[0] == "bu_kpi_change" and rec("Dx")[1] == SU["id"], rec("Dx") and rec("Dx")[:3])
    s.check("C (no record, nothing entered) gets no row; the pre-run is asked for them once", rec("Cx") is None and asked("Cx", "bu_kpi_change") == 1
            and refreshed("Cx") == 0, (rec("Cx"), asked("Cx")))
    s.check("nobody the save did not change is touched: A, B (same target, same weight) and E keep their rows, and are not asked",
            rec("Ex") == snapE and all(refreshed(e + "x") == 0 and asked(e + "x") == 0 for e in "ABE"), [(e, refreshed(e + "x"), asked(e + "x")) for e in "ABE"])
    s.check("each changed person is rebuilt once and asked once", refreshed("Dx") == 1 and asked("Dx") == 1 and asked("Cx") == 1, (REFRESH, ASKS))

    s.section("a target change: a line with a result keeps bu_kpi_retarget, the rest bu_kpi_change; nobody twice")
    reset_spy()
    out = post("save_kpi", card("ABCDF", rates=(70, 80, 90, 100, 110)))
    s.check("every carrier's line took the new target", all(line(e + "x", PAT)["rate1"] == 70 for e in "ABCDF"), [(e, line(e + "x", PAT)["rate1"]) for e in "ABCDF"])
    s.check("A (a result, the target moved): rebuilt by the retarget, last_event bu_kpi_retarget, equal to the live reader",
            current("Ax") and rec("Ax")[0] == "bu_kpi_retarget", rec("Ax") and rec("Ax")[:2])
    s.check("B and D (records, no result): rebuilt as bu_kpi_change; C and F (nothing entered): no row, the pre-run only",
            all(current(e + "x") and rec(e + "x")[0] == "bu_kpi_change" for e in "BD") and rec("Cx") is None and rec("Fx") is None
            and asked("Cx", "bu_kpi_change") == 1 and asked("Fx", "bu_kpi_change") == 1, [(e, rec(e + "x") and rec(e + "x")[0]) for e in "BCDF"])
    s.check("nobody twice: one rebuild each (A by the retarget, not again), the pre-run asked once each; E and G untouched",
            all(refreshed(e + "x") == 1 and asked(e + "x") == 1 for e in "ABD") and refreshed("Ex") == 0 and asked("Ex") == 0 and asked("Gx") == 0
            and rec("Ex") == snapE, [(e, refreshed(e + "x"), asked(e + "x")) for e in "ABCDEFG"])

    s.section("taking people off: the line comes off or goes back, their record follows")
    reset_spy()
    out = post("save_kpi", card("AB", rates=(70, 80, 90, 100, 110)))   # C, D (added by the setup: the line goes) and F (adopted: goes back as it was) come off
    s.check("C's and D's added lines are gone, F's own line is back as it was (30%, its own target)", line("Cx", PAT) is None and line("Dx", PAT) is None
            and line("Fx", PAT)["bu_kpi_id"] is None and line("Fx", PAT)["rate1"] == 90 and line("Fx", PAT)["weightage"] == 30,
            (line("Fx", PAT) and (line("Fx", PAT)["bu_kpi_id"], line("Fx", PAT)["rate1"])))
    s.check("D (a record): rebuilt, equal to the live reader (SALES at 70 alone now), last_event bu_kpi_change",
            current("Dx") and rec("Dx")[0] == "bu_kpi_change", rec("Dx") and rec("Dx")[:2])
    s.check("C and F (nothing entered): no row, the pre-run asked once each; A, B, E not touched",
            rec("Cx") is None and rec("Fx") is None and asked("Cx") == 1 and asked("Fx") == 1 and all(
                refreshed(e + "x") == 0 and asked(e + "x") == 0 for e in "ABE"), (REFRESH, ASKS))
    prime(["Dx"])

    s.section("the KPI taken off the unit")
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_kpi_results WHERE kpi_target_id=?", (line("Ax", PAT)["id"],))
        db.commit()
    reset_spy()
    out = post("take_off", {"setup": str(SETUP)})
    s.check("the KPI is off: A's and B's lines are their own again", H.rows(a, "SELECT 1 FROM pm_bu_kpis WHERE id=?", (SETUP,)) == []
            and line("Bx", PAT)["bu_kpi_id"] is None and line("Ax", PAT)["bu_kpi_id"] is None, out[:200])
    s.check("B (a record): rebuilt and equal to the live reader, last_event bu_kpi_change; A (a record from the retarget): the same",
            all(current(e + "x") and rec(e + "x")[0] == "bu_kpi_change" for e in "AB"), [(e, rec(e + "x") and rec(e + "x")[0]) for e in "AB"])
    s.check("...once each; D and E (not on it) untouched", all(refreshed(e + "x") == 1 for e in "AB") and refreshed("Dx") == 0 and refreshed("Ex") == 0
            and rec("Ex") == snapE, [(e, refreshed(e + "x")) for e in "ABDE"])

    # ---------------------------------------------------------------------------------------------------------------
    s.section("a weight alone moves the record (a setup that gives one weight to all), a line with a result too")
    with a.app.app_context():
        db = a.get_db()
        # H: PAT at 30 on the setup's own figures, with a result: only the weight can change
        tH = put("Hx", PAT, 30, BG, CO, rates=(80, 90, 100, 110, 120), lib=LIB[PAT])
        db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) VALUES (?, 99, 'n', ?, 0, 0)", (tH, U["Hx"]))
        sid2 = db.execute("INSERT INTO pm_bu_kpis(cycle_id, business_group, company, kpi_name, category, unit, method, rate1, rate2, rate3, rate4, "
                          "rate5, carriers, carriers_json, weight_mode, weight, library_id, updated_by) VALUES (?,?,?,?, 'Financial', '%', 'more', "
                          "80, 90, 100, 110, 120, 'holders', ?, 'one', 25, ?, ?)",
                          (CID, BG, CO, PAT, json.dumps({"people": [a.ja_eid("ZZ9RF-Bx"), a.ja_eid("ZZ9RF-Hx")]}), LIB[PAT], SU["id"])).lastrowid
        db.execute("UPDATE pm_kpi_targets SET bu_kpi_id=? WHERE id=?", (sid2, tH))
        db.commit()
    prime(["Bx", "Hx"])
    reset_spy()
    with a.app.app_context():
        db = a.get_db()
        act = a.active_cycle(db)
        srow = db.execute("SELECT * FROM pm_bu_kpis WHERE id=?", (sid2,)).fetchone()
        ppl = [dict(db.execute("SELECT * FROM users WHERE id=?", (U[e],)).fetchone()) for e in ("Bx", "Hx")]
        me = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        t0 = {}
        n = a._bu_kpi_apply(db, me, act, srow, ppl, locked_ok=True, touched=t0)
        db.commit()
    s.check("B (no result) and H (a result, no figure moved) took the weight 25: both noted, neither as a retarget",
            n["updated"] == 2 and t0 == {U["Bx"]: False, U["Hx"]: False}, (n, t0))
    with a.app.app_context():
        db = a.get_db()
        me = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        done = a._bu_follow_flush(db, me, CID, t0, "bu_kpi_change")
        db.commit()
    s.check("...the flush rebuilds both once, under bu_kpi_change, equal to the live reader", done == (2, 0, 0) and all(
        current(e) and rec(e)[0] == "bu_kpi_change" for e in ("Bx", "Hx")), (done, [rec(e)[:2] for e in ("Bx", "Hx")]))
    reset_spy()
    with a.app.app_context():
        db = a.get_db()
        me = db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        mixed = {U["Bx"]: True, U["Hx"]: False, U["Ex"]: False}
        a._bu_follow_flush(db, me, CID, mixed, "bu_kpi_change")
        db.commit()
    s.check("a retarget is kept over a change: B (True) under bu_kpi_retarget, H and E under bu_kpi_change", rec("Bx")[0] == "bu_kpi_retarget"
            and rec("Hx")[0] == "bu_kpi_change" and rec("Ex")[0] == "bu_kpi_change", [rec(e)[0] for e in ("Bx", "Hx", "Ex")])
    t1 = {}
    a._bu_touch(t1, 5)
    a._bu_touch(t1, 5, True)
    a._bu_touch(t1, 5)
    a._bu_touch(None, 6)
    a._bu_touch(t1, 0)
    s.check("`_bu_touch`: a retarget sticks over later plain notes; None collects nothing; no person id notes nothing", t1 == {5: True}, t1)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the whole-unit save follows too, and what a record would be without the follow")
    with a.app.app_context():
        db = a.get_db()
        db.execute("DELETE FROM pm_bu_kpis WHERE id=?", (sid2,))
        db.execute("UPDATE pm_kpi_targets SET bu_kpi_id=NULL WHERE bu_kpi_id=?", (sid2,))
        db.commit()
    prime(["Ax", "Bx", "Dx", "Ex"])
    reset_spy()
    out = post("save", dict(card("AB", adds={"D": 30}), kpi=[str(LIB[PAT])]))
    s.check("the whole-unit save put PAT on A, B (their own lines adopted) and D (a new line)", all(
        line(e + "x", PAT) and line(e + "x", PAT)["bu_kpi_id"] for e in "ABD"), out[:200])
    s.check("A, B and D (records) are rebuilt once each, equal to the live reader, last_event bu_kpi_change; E untouched",
            all(current(e + "x") and rec(e + "x")[0] == "bu_kpi_change" and refreshed(e + "x") == 1 and asked(e + "x") == 1 for e in "ABD")
            and refreshed("Ex") == 0 and rec("Ex")[0] == "zzrf_prime", [(e, rec(e + "x")[0], refreshed(e + "x")) for e in "ABDE"])
    post("save_kpi", card("AB"))   # D comes off again: a record only moves where the weights do, so D is the one to watch
    prime(["Ax", "Bx", "Dx"])
    keep_flush = a._bu_follow_flush
    a._bu_follow_flush = lambda *x, **k: (0, 0, 0)
    try:
        post("save_kpi", card("AB", adds={"D": 30}))
    finally:
        a._bu_follow_flush = keep_flush
    s.check("with the flush switched off the same add leaves D's record stale (D's weights now add up to 100, the record says 70): the checks above "
            "do not pass by accident", line("Dx", PAT) is not None and rec("Dx")[0] == "zzrf_prime" and not current("Dx"),
            (rec("Dx") and rec("Dx")[0], current("Dx")))
    prime("A")
    a._bu_follow_flush = lambda *x, **k: (0, 0, 0)
    try:
        kti_import(KHEAD + kline("ZZ9RI-A", "ZZRI K1", 55), "off.csv")
    finally:
        a._bu_follow_flush = keep_flush
    s.check("...and the KPI targets import with it off leaves A's record stale too", line("A", "ZZRI K1")["weightage"] == 55
            and rec("A")[0] == "zzrf_prime" and not current("A"), (rec("A") and rec("A")[0], current("A")))
    kti_import(KHEAD + kline("ZZ9RI-A", "ZZRI K1", 45), "on.csv")
    s.check("...switched on again, the import rebuilds it", current("A") and rec("A")[0] == "kpi_import", rec("A") and rec("A")[:2])

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the cap on the BU KPI page: the retargeted first, then by id; the message only when some are left")
    CAP_KEEP = a._RR_CAPTURE_BATCH
    a._RR_CAPTURE_BATCH = 2
    try:
        with a.app.app_context():   # D (the highest id of the three) has a result: its line is retargeted; A and B have records only
            db = a.get_db()
            db.execute("INSERT INTO pm_kpi_results(kpi_target_id, actual_value, note, submitted_by, draft, admin_filled) VALUES (?, 99, 'n', ?, 0, 0)",
                       (line("Dx", PAT)["id"], U["Dx"]))
            db.commit()
        prime(["Ax", "Bx", "Dx"])
        reset_spy()
        msg = post("save_kpi", card("ABD", rates=(65, 75, 85, 95, 105)))
        s.check("the three lines took the new target", all(line(e + "x", PAT)["rate1"] == 65 for e in "ABD"), [(e, line(e + "x", PAT)["rate1"]) for e in "ABD"])
        s.check("a cap of 2: D (retargeted, the highest id) is rebuilt first as bu_kpi_retarget, then A (the lowest id of the rest) as bu_kpi_change",
                current("Dx") and rec("Dx")[0] == "bu_kpi_retarget" and current("Ax") and rec("Ax")[0] == "bu_kpi_change", (rec("Dx")[0], rec("Ax")[0]))
        s.check("...B (over the cap) is not rebuilt: its record and time are as they were, but the pre-run is asked for it, once",
                rec("Bx")[0] == "zzrf_prime" and refreshed("Bx") == 0 and asked("Bx", "bu_kpi_change") == 1 and
                sum(len(ids) for _e, ids in REFRESH) == 2, (rec("Bx")[0], REFRESH, ASKS))
        s.check("...the page's flash says how many wait: '1 person's rating record will update at the next Capture on Ratings record.'",
                msg.count("1 person's rating record will update at the next Capture on Ratings record.") == 1, msg)
        a._RR_CAPTURE_BATCH = CAP_KEEP
        reset_spy()
        msg = post("save_kpi", card("ABD", rates=(66, 76, 86, 96, 106)))
        s.check("with the cap back at a Capture click's worth, the same save rebuilds all three and says nothing about Capture",
                "Capture" not in msg and "saved for" in msg and all(current(e + "x") for e in "ABD") and refreshed("Bx") == 1, msg)
    finally:
        a._RR_CAPTURE_BATCH = CAP_KEEP

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the lint reads the new call sites")
    ev = {"kpi_import", "bu_kpi_change"}
    s.check("both events are classified as queueing, with a branch in _prerun_for_event",
            ev <= set(a._PRERUN_EVENTS) and not (ev & set(a._PRERUN_NO_EVENTS)) and all(
                '"%s"' % e in src[src.index("def _prerun_for_event("):src.index("def _prerun_idp_ready(")] for e in ev), "")
    s.check("every BU KPI writer that follows names its event as a literal at the call (the ai_prerun lint reads them)",
            src.count('_bu_follow_flush(db, me, act["id"], touched, "bu_kpi_change")') == 6   # 6: Bring them onto this setup and the super admin's late amendment (2026-11-14) follow too
            and src.count('_bu_follow_flush(db, me, period["id"], touched, "kpi_import")') == 1, "")
finally:
    a._prerun_on_event, a._rating_record_refresh = _real_prerun, _real_refresh

sys.exit(s.done())
