"""The 360 Results download carries each rater's overall remark (Chris, 2026-11-11: "add it to the 360 Feedback Results
excel export, add column like assessor 1 remark, assessor 2 remark", "we don't use the name of the rater who gave the
remark, just generic name like rater 1 remark, rater 2 remark").

What this suite holds:
  * after the last existing column the file has "Rater 1 remark" ... "Rater N remark", N = the highest n at which any subject
    IN THAT FILE has a remark (none in the file = no remark columns); a subject with fewer has blank cells
  * column n is the remark of the n-th SUBMITTED rater (submitted_at, then the assignment id as the tie-break: the order
    the Responses download numbers "Rater n" by), blank where that rater left none; text stripped
  * a pending rater's remark, an archived assignment's, a blank one and another cycle's are not in the file
  * the rater is never in the file: no name, Employee ID or email anywhere in the sheet or its About sheet
  * the super admin and a business-group admin download the same route; the group admin's file holds their own group's
    people only (so its remark columns count their own people's remarks)
  * a remark that starts with = is written as text, never a formula; a pure decimal remark becomes a number, a longer
    text that merely starts with one stays text
  * the query is batched (one a 900 subjects), not one a person; the Reports row and About sheet say the file has remarks

Self-contained: its own two groups (ZZRK Alpha, ZZRK Beta), people (ZZ9RK-) and an old cycle, deleted at the end.
"""
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from openpyxl import load_workbook  # noqa: E402

a = H.setup()
s = H.Suite("The 360 Results download: each rater's remark, no names")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA0, _E = H.actors(a)
PFX = "ZZ9RK-"
GA, GB = "ZZRK Alpha", "ZZRK Beta"
CO = "ZZRK Unit"
OLD_CODE = "ZZ9RK-OLD"
URL = {}
with a.app.test_request_context("/"):
    URL["res"] = a.url_for("admin_export_results")
    URL["rows"] = {ep: d for _s, _l, _f, ep, d in a.ADMIN_REPORTS}


def cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9RK-%'")]
    ph = ",".join("?" * len(ul))
    if ul:
        aid = "SELECT id FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph)
        db.execute("DELETE FROM feedback_remarks WHERE assignment_id IN (%s)" % aid, ul + ul)
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM assignments WHERE cycle_id IN (SELECT id FROM cycles WHERE code=?)", (OLD_CODE,))
    db.execute("DELETE FROM cycles WHERE code=?", (OLD_CODE,))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (GA, GB))
    db.execute("DELETE FROM activity_log WHERE action='export' AND detail LIKE 'AI+OneHR_ZZRK%'")
    db.commit()


def sheets_of(resp):
    wb = load_workbook(io.BytesIO(resp.get_data()))   # not read-only: a cell's data_type tells a formula from text
    return wb


def table(wb):
    ws = wb[wb.sheetnames[0]]
    rows = [list(r) for r in ws.iter_rows()]
    return ws, [[c.value for c in r] for r in rows[:1]][0], rows[1:]


def rem_cols(header):
    return [i for i, h in enumerate(header) if isinstance(h, str) and re.fullmatch(r"Rater \d+ remark", h)]


try:
    with a.app.app_context():
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        cleanup(db)
        CID = a.active_cycle(db)["id"]
        OLD = db.execute("INSERT INTO cycles(code, name, is_active) VALUES (?, 'ZZ9RK old cycle', 0)",
                         (OLD_CODE,)).lastrowid
        for g_ in (GA, GB):
            db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (g_, CO))

        def mk(eid, bg, name, role="user", admin_bg=None):
            return db.execute(
                "INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, company, "
                "department, job_grade, job_title, confirmation_date, email, admin_bg) VALUES (?,?, 'x', ?, ?,?,?, "
                "'ZZRK Dept', '14', 'ZZRK Title', '2020-01-01', ?, ?)",
                (eid.lower(), name, role, eid, bg, CO, eid.lower() + "@zz.example", admin_bg)).lastrowid
        S1 = mk(PFX + "S1", GA, "ZZ RK Subject One")
        S3 = mk(PFX + "S3", GA, "ZZ RK Subject Three")
        S4 = mk(PFX + "S4", GA, "ZZ RK Subject Four")
        S2 = mk(PFX + "S2", GB, "ZZ RK Subject Two")
        RN = {k: "ZZ RK Rater " + k.upper() for k in "abcdefgh"}
        R = {k: mk(PFX + "R" + k.upper(), GA, RN[k]) for k in "abcdefgh"}
        ADM = mk(PFX + "ADM", GA, "ZZ RK Group Admin", role="admin", admin_bg=GA)

        def asg(cycle, subj, rater, status="submitted", at=None, remark=None, archived=0):
            aid = db.execute(
                "INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, submitted_at, archived) "
                "VALUES (?,?,?, 'peer', ?,?,?)",
                (cycle, subj, R[rater], status, at, archived)).lastrowid
            if remark is not None:
                db.execute("INSERT INTO feedback_remarks(assignment_id, remark) VALUES (?,?)", (aid, remark))
            return aid
        # S1: rows are inserted in an order that is NOT the submission order, and two raters submitted in the same second
        asg(CID, S1, "a", at="2026-11-03 12:00:00", remark="alpha late")                  # id order 1, submitted last
        asg(CID, S1, "b", at="2026-11-03 09:00:00", remark="bravo early")                 # submitted first
        asg(CID, S1, "c", at="2026-11-03 10:00:00", remark="=SUM(1,1) charlie formula")   # a formula if unguarded
        asg(CID, S1, "d", status="pending", remark="delta pending draft")                 # not submitted
        asg(CID, S1, "e", at="2026-11-03 08:00:00", remark="echo archived", archived=1)   # archived
        asg(CID, S1, "f", at="2026-11-03 07:00:00", remark="   ")                         # blank
        asg(OLD, S1, "g", at="2026-10-01 07:00:00", remark="foxtrot other cycle")         # another cycle
        asg(CID, S1, "h", at="2026-11-03 10:00:00", remark="hotel tie")                   # same second as c, later id
        # S3: a pure decimal, a text that starts with one, padding
        asg(CID, S3, "a", at="2026-11-03 08:00:00", remark="4.50")
        asg(CID, S3, "b", at="2026-11-03 08:30:00", remark="4.50 is high")
        asg(CID, S3, "c", at="2026-11-03 09:00:00", remark="  padded text  ")
        # S4: a panel with nothing submitted
        asg(CID, S4, "d", status="pending", remark="delta pending on four")
        # S2 (the other group): five remarks, so the whole-company file has more columns than the Alpha admin's
        for i, k in enumerate("abcdef"):
            asg(CID, S2, k, at="2026-11-04 0%d:00:00" % (i + 1), remark="beta remark %d" % (i + 1))
        db.commit()
        EID = {S1: PFX + "S1", S2: PFX + "S2", S3: PFX + "S3", S4: PFX + "S4"}
        ADM_ROW = db.execute("SELECT * FROM users WHERE id=?", (ADM,)).fetchone()
        OUR = (S1, S2, S3, S4)

    C_SU = H.client_as(a, SU["id"])
    C_BG = H.client_as(a, ADM)
    Q = "?cycle=%d" % CID

    def get(client, extra=""):
        r = client.get(URL["res"] + Q + extra)
        wb = sheets_of(r) if r.status_code == 200 else None
        return r, wb

    # S1's first submitter (07:00, rater f) left only spaces: slot 1 is blank, so the others sit at 2..5
    WANT = {PFX + "S1": ["", "bravo early", "=SUM(1,1) charlie formula", "hotel tie", "alpha late"],
            PFX + "S3": ["4.50", "4.50 is high", "padded text"], PFX + "S4": [],
            PFX + "S2": ["beta remark %d" % i for i in range(1, 7)]}
    LEAK = ["alpha late", "bravo early", "charlie", "delta pending", "echo archived", "foxtrot other", "hotel tie",
            "beta remark"]

    # ------------------------------------------------------------------------------------------ the columns and order
    s.section("Rater 1 remark ... Rater N remark after the last existing column, N = the most any one subject has")
    r, wb = get(C_SU, "&fbg=" + GA.replace(" ", "+"))
    s.check("the super admin's Alpha file downloads", r.status_code == 200, r.status_code)
    ws, header, rows = table(wb)
    rc = rem_cols(header)
    s.check("the remark columns are named Rater 1 remark, Rater 2 remark, ... in order",
            [header[i] for i in rc] == ["Rater %d remark" % (k + 1) for k in range(len(rc))], header)
    s.check("...and they come after the last existing column, Extreme-Assessor Adjustment",
            rc and rc[0] == header.index("Extreme-Assessor Adjustment") + 1 and rc == list(range(rc[0], len(header))), rc)
    exp_n = max(len(v) for k, v in WANT.items() if k != PFX + "S2")
    s.check("the number of remark columns is the highest n holding a remark (Alpha file: %d)" % exp_n,
            len(rc) == exp_n, (len(rc), exp_n))
    P = {r_[header.index("Employee ID")].value: r_ for r_ in ws.iter_rows(min_row=2)}
    s.check("only this group's people are in the Alpha file", {PFX + "S1", PFX + "S3", PFX + "S4"} <= set(P)
            and PFX + "S2" not in P, sorted(k for k in P if str(k).startswith(PFX)))

    def cells(row):
        return [row[i].value for i in rc]
    c1 = cells(P[PFX + "S1"])
    s.check("column n is the n-th submitted rater's remark (a tie goes by the assignment id); blank where that rater left none",
            [v or "" for v in c1[:5]] == ["", "bravo early", "'=SUM(1,1) charlie formula", "hotel tie", "alpha late"], c1)
    s.check("a subject with fewer remarks than the file's maximum has blank cells after them",
            all(v in (None, "") for v in cells(P[PFX + "S3"])[3:]) and all(v in (None, "") for v in cells(P[PFX + "S4"])), 
            (cells(P[PFX + "S3"]), cells(P[PFX + "S4"])))
    c3 = cells(P[PFX + "S3"])
    s.check("a remark is stripped of its padding", c3[2] == "padded text", c3)

    # ------------------------------------------------------------------------------------------ what is left out
    s.section("a pending, archived, blank and other-cycle remark is not in the file")
    text = " | ".join(str(c.value) for r_ in ws.iter_rows(min_row=2) for c in r_ if c.value is not None)
    for what, needle in (("a pending rater's remark", "delta pending"), ("an archived assignment's remark", "echo archived"),
                         ("another cycle's remark", "foxtrot other")):
        s.check("%s is absent (S1 and S4)" % what, needle not in text, needle)
    s.check("a blank (spaces only) remark leaves its own cell empty: S1 has four remarks in five columns, the blank first",
            sum(v not in (None, "") for v in c1) == 4 and c1[0] in (None, ""), c1)
    s.check("the subject with nothing submitted has no remark cells", all(v in (None, "") for v in cells(P[PFX + "S4"])))

    # ------------------------------------------------------------------------------------------ no rater anywhere
    s.section("the rater is never in the file")
    def whole(wbk):
        return " | ".join(str(c.value) for w in wbk.worksheets for r_ in w.iter_rows() for c in r_ if c.value is not None)
    allt = whole(wb)
    hits = [x for k in "abcdefgh" for x in (RN[k], PFX + "R" + k.upper(), (PFX + "R" + k.upper()).lower() + "@zz.example")
            if x.lower() in allt.lower()]
    s.check("no rater name, Employee ID or email is anywhere in the workbook (data and About sheet)", not hits, hits)
    s.check("no header names a rater or a relationship", not [h for h in header if re.search(r"rater \D|relationship|assessor name", str(h), re.I)], header)
    s.check("the About sheet says the file carries the raters' remarks, numbered by submission, without the name",
            "remark" in whole(wb) and "without the rater's name" in whole(wb), None)

    # ------------------------------------------------------------------------------------------ the whole-company file
    s.section("the super admin's file, picked to the other group and unpicked")
    r2, wb2 = get(C_SU, "&fbg=" + GB.replace(" ", "+"))
    ws2, h2, rows2 = table(wb2)
    s.check("the Beta file has six remark columns, the Alpha file five: N follows the file's own people",
            len(rem_cols(h2)) == 6 and len(rc) == 5, (len(rem_cols(h2)), len(rc)))
    P2 = {r_[h2.index("Employee ID")].value: [c.value for c in r_] for r_ in ws2.iter_rows(min_row=2)}
    s.check("the Beta subject's six remarks are in submission order",
            [P2[PFX + "S2"][i] for i in rem_cols(h2)] == WANT[PFX + "S2"], None)
    r3, wb3 = get(C_SU)
    ws3, h3, rows3 = table(wb3)
    rc3 = rem_cols(h3)
    last = max((max((j for j, i in enumerate(rc3) if r_[i].value not in (None, "")), default=-1) + 1) for r_ in rows3)
    s.check("unpicked, the number of remark columns equals the most remarks one row of the file has", len(rc3) == last, (len(rc3), last))
    s.check("...and it takes in the Beta subject's six", len(rc3) >= 6, len(rc3))
    P3 = {r_[h3.index("Employee ID")].value: [c.value for c in r_] for r_ in ws3.iter_rows(min_row=2)}
    s.check("the same subject has the same remarks in the whole-company file as in the picked one",
            [P3[PFX + "S1"][i] for i in rc3][:5] == [P[PFX + "S1"][i].value for i in rc][:5])

    # ------------------------------------------------------------------------------------------ the group admin
    s.section("a business-group admin downloads it too, for their own people only")
    r4, wb4 = get(C_BG)
    s.check("the group admin's download works (the route's own access, nothing new)", r4.status_code == 200, r4.status_code)
    ws4, h4, rows4 = table(wb4)
    P4 = {r_[h4.index("Employee ID")].value: [c.value for c in r_] for r_ in ws4.iter_rows(min_row=2)}
    s.check("their file has their group's people and not the other group's subject",
            {PFX + "S1", PFX + "S3", PFX + "S4"} <= set(P4) and PFX + "S2" not in P4, sorted(P4))
    t4 = whole(wb4)
    s.check("no remark of the other group is in their file", "beta remark" not in t4, None)
    s.check("their remark columns count their own people's remarks (5), not the company's 6", len(rem_cols(h4)) == 5, len(rem_cols(h4)))
    s.check("their S1 remarks are the same, in the same order",
            [P4[PFX + "S1"][i] for i in rem_cols(h4)] == [P[PFX + "S1"][i].value for i in rc])
    hits4 = [x for k in "abcdefgh" for x in (RN[k], PFX + "R" + k.upper()) if x.lower() in t4.lower()]
    s.check("the group admin's file has no rater name or ID either", not hits4, hits4)

    # ------------------------------------------------------------------------------------------ cell safety
    s.section("a remark that starts with = is text; only a pure decimal becomes a number")
    colS1 = [P[PFX + "S1"][i] for i in rc]
    f = colS1[2]
    s.check("the = remark is written as a string cell that starts with an apostrophe, not a formula",
            f.data_type == "s" and isinstance(f.value, str) and f.value.startswith("'="), (f.data_type, f.value))
    s.check("no cell anywhere in the workbook is a formula",
            not [(w.title, c.coordinate) for w in wb.worksheets for r_ in w.iter_rows() for c in r_ if c.data_type == "f"])
    c3c = [P[PFX + "S3"][i] for i in rc]
    s.check("a remark that is only a decimal (4.50) comes out as the number 4.5", c3c[0].value == 4.5, c3c[0].value)
    s.check("a remark that merely starts with one (4.50 is high) stays text", c3c[1].value == "4.50 is high", c3c[1].value)

    # ------------------------------------------------------------------------------------------ batched, wording
    s.section("one query a 900 subjects, and the words say it")
    src = H.source(a)
    fn = src[src.index("def admin_export_results"):src.index("def _results_rater_remarks")]
    s.check("the route reads the remarks once, through one helper, outside its per-subject loop",
            fn.count("_results_rater_remarks(") == 1 and fn.index("_results_rater_remarks(") < fn.index("for s in subjects:\n"), None)
    hel = src[src.index("def _results_rater_remarks"):]
    hel = hel[:hel.index("\n\n\n")]
    s.check("the helper's query is chunked (900) and takes a whole list of subjects (IN), with no loop query inside the per-subject path",
            "range(0, len(ids), 900)" in hel and "a.subject_id IN" in hel and hel.count("db.execute(") == 1, None)
    # count the real SQL calls made for the Alpha+Beta+company file: the remark query runs ceil(subjects/900) times
    import sqlite3
    calls = []
    orig = a.get_db
    class Spy:
        def __init__(self, d):
            self._d = d
        def execute(self, sql, *args):
            if "feedback_remarks" in sql and "JOIN assignments" in sql:
                calls.append(sql)
            return self._d.execute(sql, *args)
        def __getattr__(self, n):
            return getattr(self._d, n)
    with a.app.test_request_context("/"):
        dbx = orig()
        with a.app.app_context():
            rem_a = a._results_rater_remarks(Spy(dbx), [S1, S3, S4, S2], CID)
            n_a = len(calls)
            calls.clear()
            a._results_rater_remarks(Spy(dbx), list(range(1, 2000)), CID)
            n_b = len(calls)
    s.check("four subjects are one query; 1,999 subjects are three (a query a 900), never one a person", (n_a, n_b) == (1, 3), (n_a, n_b))
    s.check("the helper returns only text, keyed by the subject", all(isinstance(x, str) for v in rem_a.values() for x in v)
            and rem_a[S1] == WANT[PFX + "S1"] and rem_a[S3] == WANT[PFX + "S3"] and S4 not in rem_a, rem_a)
    about_row = URL["rows"]["admin_export_results"]
    s.check("the Reports row mentions the raters' remarks", "remark" in about_row, about_row)

    # ------------------------------------------------------------------------------------------ falsify: each guard bites
    s.section("falsified: with each guard dropped, the seeded rows would be in the file (the data reaches every line)")
    base = ("SELECT fr.remark FROM feedback_remarks fr JOIN assignments a ON a.id=fr.assignment_id "
            "WHERE a.subject_id IN (%d,%d) %s")
    with a.app.app_context():
        db = a.get_db()
        def run(extra, cyc=True):
            w = ("AND a.cycle_id=%d " % CID if cyc else "") + extra
            return {r[0].strip() for r in db.execute(base % (S1, S4, w))}
        full = "AND a.archived=0 AND a.status='submitted' AND TRIM(fr.remark)<>''"
        s.check("with the full filter the four of S1 remain and nothing else", run(full) == {"alpha late", "bravo early",
                "=SUM(1,1) charlie formula", "hotel tie"}, None)
        s.check("without the status filter the pending remark would appear", "delta pending draft" in run("AND a.archived=0 AND TRIM(fr.remark)<>''")
                and "delta pending on four" in run("AND a.archived=0 AND TRIM(fr.remark)<>''"), None)
        s.check("without the archived filter the archived remark would appear", "echo archived" in run("AND a.status='submitted' AND TRIM(fr.remark)<>''"), None)
        s.check("without the blank filter a blank cell would take a column", "" in run("AND a.archived=0 AND a.status='submitted'"), None)
        s.check("without the cycle filter the other cycle's remark would appear", "foxtrot other cycle" in run(full, cyc=False), None)
        s.check("without the scope (the group admin's bg_scope) the Beta subject would be in the group admin's file",
                a.bg_scope(ADM_ROW, "business_group")[1] == [GA], None)
finally:
    with a.app.app_context():
        cleanup(a.get_db())
sys.exit(s.done())
