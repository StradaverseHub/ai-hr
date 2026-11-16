"""The 360 Responses download names no rater to anyone but the super admin (Chris, 2026-11-11, "Masked, no relationship"):
Reports > 360 Feedback > Responses gave every admin with 360 read access, inside their scope, each answer with the assessor's
ID, name, email and relationship. Now ONE route, ONE Reports row:

  * the super admin (system admin included): unchanged, Assessor ID / Assessor / Assessor Email / Relationship
  * every other admin (BG admin, BU admin, a whole-company custom role): the same rows and the same scope, the assessor columns
    replaced by ONE column, Rater, "Rater N" -- N by the order the raters SUBMITTED (submitted_at, then the assignment id); a
    draft (a rater not yet submitted) is private to its author: its rows are not in the masked file, so no number shifts when it
    is submitted (the super admin's file keeps them); no Assessor ID / name / email / Relationship column, and no cell of any
    sheet (About included) carries a rater's Employee ID, name, email or relationship
  * the same N as the Results download's "Rater N remark" (a rater with no remark leaves that cell blank)
  * rows by subject, then rater number, then the criterion / statement order -- never by the rater's name
  * the old .csv address answers the same as the .xlsx

Self-contained: its own group (ZZRM), two units, subjects, raters and three admins on the SHARED suite database, all put back
at the end. The model is never called.
"""
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from openpyxl import load_workbook  # noqa: E402

a = H.setup()
s = H.Suite("The 360 Responses download: raters masked for every admin but the super admin")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
BG, CO1, CO2 = "ZZRM Group", "ZZRM Unit One", "ZZRM Unit Two"
PFX = "ZZRM-"
ROLE_NAME = "ZZRM Role"
XLSX, CSV = "/admin/export/responses.xlsx", "/admin/export/responses.csv"
RELS = ("line_manager", "matrix_manager", "peer", "direct_report")


def cleanup(db):
    ids = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE ?", (PFX + "%",))]
    if ids:
        ph = ",".join("?" * len(ids))
        aids = [r[0] for r in db.execute("SELECT id FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ids * 2)]
        if aids:
            ap = ",".join("?" * len(aids))
            for t in ("responses", "criterion_comments", "feedback_remarks"):
                db.execute("DELETE FROM %s WHERE assignment_id IN (%s)" % (t, ap), aids)
            db.execute("DELETE FROM assignments WHERE id IN (%s)" % ap, aids)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ids)
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids * 2)
        db.execute("UPDATE users SET manager_id=NULL, hod_id=NULL WHERE id IN (%s)" % ph, ids)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
    db.execute("DELETE FROM admin_role_access WHERE role_id IN (SELECT id FROM admin_roles WHERE name=?)", (ROLE_NAME,))
    db.execute("DELETE FROM admin_roles WHERE name=?", (ROLE_NAME,))
    db.execute("DELETE FROM org_units WHERE business_group=?", (BG,))
    db.commit()


def workbook(resp):
    wb = load_workbook(io.BytesIO(resp.get_data()), read_only=True)
    return {w.title: [list(r) for r in w.iter_rows(values_only=True)] for w in wb.worksheets}


def sheet1(resp):
    wb = workbook(resp)
    rows = wb["360 responses"]
    return rows[0], rows[1:], wb


with a.app.test_request_context("/"):
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    cleanup(db)
    CID = a.viewed_cycle_id(db) or a.active_cycle_id(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO1))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, ?)", (BG, CO2))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, co=CO1, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=eid.lower() + "@example.test", hod_id=None,
                 manager_id=None, buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=co,
                 years_of_service=5, left_at=None, is_demo=0, job_grade="16", role="user", admin_bg=None, admin_role_id=None,
                 confirmation_date="2020-01-01", is_system_admin=0, display_name=None)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]

    # three subjects: two in unit one, one in unit two; five raters (one in another unit)
    S1 = person(PFX + "S1", "ZZ RM Subject Alpha")
    S2 = person(PFX + "S2", "ZZ RM Subject Beta")
    S3 = person(PFX + "S3", "ZZ RM Subject Gamma", CO2)
    R = {k: person(PFX + k, "ZZ RM Rater " + n, CO2 if k == "R4" else CO1)
         for k, n in (("R1", "Zulu"), ("R2", "Yankee"), ("R3", "Xray"), ("R4", "Whiskey"), ("R5", "Victor"))}
    # admins: a BG admin, a BU admin (unit one only) and a whole-company custom role
    ROLE = {r["builtin"]: r["id"] for r in db.execute("SELECT id, builtin FROM admin_roles WHERE builtin IS NOT NULL")}
    db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES (?, 'company')", (ROLE_NAME,))
    ROLE["custom"] = db.execute("SELECT id FROM admin_roles WHERE name=?", (ROLE_NAME,)).fetchone()[0]
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)",
                   [(ROLE["custom"], i) for i in sorted(a.role_preset_items("full"))])
    BGA = person(PFX + "BGA", "ZZ RM Admin BG", role="admin", admin_bg=BG, admin_role_id=ROLE["bg"])
    BUA = person(PFX + "BUA", "ZZ RM Admin BU", role="admin", admin_bg=BG, admin_role_id=ROLE["bu"])
    db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?,?)", (BUA, CO1))
    CRA = person(PFX + "CRA", "ZZ RM Admin Custom", role="admin", admin_bg=a.ADMIN_COMPANY_SCOPE, admin_role_id=ROLE["custom"])
    SU = db.execute("SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' AND left_at IS NULL LIMIT 1").fetchone()[0]

    tier = a._cycle_tier_n(db, "16", CID)
    stm = [r[0] for r in db.execute("SELECT id FROM cycle_statements WHERE cycle_id=? AND tier_n=? ORDER BY id LIMIT 3", (CID, tier))]
    assert len(stm) == 3, "the cycle needs three statements of the grade-16 tier"

    # each rater answers in a pattern of their own, so a row's rater can be told from its answers alone
    SIG = {"R1": ("yes", "yes", "yes"), "R2": ("no", "no", "no"), "R3": ("yes", "no", "no"), "R4": ("no", "yes", "no"),
           "R5": ("no", "no", "yes")}

    def assign(subj, rater, rel, status, at=None, archived=0):
        aid = db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status, submitted_at, archived) "
                         "VALUES (?,?,?,?,?,?,?)", (CID, subj, rater, rel, status, at, archived)).lastrowid
        key = [k for k, v in R.items() if v == rater][0]
        for sid, ans in zip(stm, SIG[key]):
            db.execute("INSERT INTO responses(assignment_id, statement_id, answer) VALUES (?,?,?)", (aid, sid, ans))
        return aid
    # S1: ids go R1, R2, R3, R4, R5 but they SUBMITTED R2, R4, R1; R3 has not (pending, rows of the current tier); R5 archived
    assign(S1, R["R1"], "peer", "submitted", "2026-11-05 10:00:00")
    assign(S1, R["R2"], "line_manager", "submitted", "2026-11-03 09:00:00")
    assign(S1, R["R3"], "direct_report", "pending")
    assign(S1, R["R4"], "matrix_manager", "submitted", "2026-11-04 08:00:00")
    assign(S1, R["R5"], "peer", "submitted", "2026-11-01 08:00:00", archived=1)
    # S2: two raters submitting at the same second: the assignment id breaks the tie
    assign(S2, R["R3"], "peer", "submitted", "2026-11-02 12:00:00")
    assign(S2, R["R1"], "direct_report", "submitted", "2026-11-02 12:00:00")
    # S3 (unit two): out of the BU admin's scope
    assign(S3, R["R2"], "peer", "submitted", "2026-11-06 12:00:00")
    assign(S3, R["R5"], "line_manager", "submitted", "2026-11-06 13:00:00")
    # S1's remarks: the first to submit (R2) left none; R4 (second) and R1 (third) did; the pending R3 has a draft remark
    for key, text in (("R4", "ZZRM remark by the second to submit"), ("R1", "ZZRM remark by the third to submit"),
                      ("R3", "ZZRM draft remark")):
        aid = db.execute("SELECT id FROM assignments WHERE cycle_id=? AND subject_id=? AND assessor_id=?",
                         (CID, S1, R[key])).fetchone()[0]
        db.execute("INSERT INTO feedback_remarks(assignment_id, remark) VALUES (?,?)", (aid, text))
    db.commit()
    IDS = {"S1": S1, "S2": S2, "S3": S3}
    EID = {k: PFX + k for k in ("S1", "S2", "S3")}

try:
    URLQ = "?cycle=%d" % CID
    C_SU = H.client_as(a, SU)
    C_BG = H.client_as(a, BGA)
    C_BU = H.client_as(a, BUA)
    C_CR = H.client_as(a, CRA)

    def db_rows(sql, args=()):
        return H.rows(a, sql, args)

    # what each admin may see: the rows' subjects in scope, the rater facts straight from the database
    def subjects_in(units):
        return [k for k, v in IDS.items() if db_rows("SELECT company FROM users WHERE id=?", (v,))[0][0] in units]

    def expected_order(subj):
        """The rater order from the database alone: SUBMITTED raters by submitted_at then id; not archived, no draft."""
        rs = db_rows("SELECT id, status, submitted_at FROM assignments WHERE cycle_id=? AND subject_id=? AND archived=0",
                     (CID, IDS[subj]))
        sub = sorted((r for r in rs if r["status"] == "submitted"), key=lambda r: (r["submitted_at"] or "", r["id"]))
        return [r["id"] for r in sub]

    def rater_facts(subj):
        """Every assessor of this subject (not archived): ID, name, email."""
        return db_rows("SELECT u.employee_id, u.full_name, u.email, a.id FROM assignments a JOIN users u ON u.id=a.assessor_id "
                       "WHERE a.cycle_id=? AND a.subject_id=? AND a.archived=0", (CID, IDS[subj]))

    # ------------------------------------------------------------------------------------------------ the super admin
    s.section("the super admin: the full file, unchanged")
    r = C_SU.get(XLSX + URLQ)
    head, body, wb = sheet1(r)
    s.check("status 200 and the assessor columns are all there", r.status_code == 200 and all(
        h in head for h in ("Assessor ID", "Assessor", "Assessor Email", "Relationship", "Status", "Principle", "Level Type",
                            "Statement", "Answer")) and "Rater" not in head, head)
    ci = {h: i for i, h in enumerate(head)}
    mine = [row for row in body if row[ci["Employee ID"]] in EID.values()]
    s.check("...its rows name the assessors and their relationship (a real name and a relationship are in the S1 rows)",
            any(row[ci["Assessor"]] == "ZZ RM Rater Yankee" and row[ci["Relationship"]] == "line_manager"
                and row[ci["Assessor ID"]] == PFX + "R2" and row[ci["Assessor Email"]] == (PFX + "R2").lower() + "@example.test"
                for row in mine if row[ci["Employee ID"]] == EID["S1"]), len(mine))

    sup_s1 = [row for row in mine if row[ci["Employee ID"]] == EID["S1"]]
    s.check("...and keeps the pending rater's rows (the draft is in the super admin's file, as before): 4 assessors, one pending",
            len({row[ci["Assessor ID"]] for row in sup_s1}) == 4 and {row[ci["Status"]] for row in sup_s1} == {"submitted", "pending"}
            and sum(row[ci["Status"]] == "pending" for row in sup_s1) == 3,
            (len({row[ci["Assessor ID"]] for row in sup_s1}), {row[ci["Status"]] for row in sup_s1}))

    # ------------------------------------------------------------------------------------------------ the masked admins
    def masked_checks(label, client, units):
        s.section("%s: raters by number, no name, ID, email or relationship" % label)
        r = client.get(XLSX + URLQ)
        head, body, wb = sheet1(r)
        s.check("%s: status 200" % label, r.status_code == 200, r.status_code)
        s.check("%s: the header holds Rater and none of Assessor ID / Assessor / Assessor Email / Relationship" % label,
                "Rater" in head and not any(h in head for h in ("Assessor ID", "Assessor", "Assessor Email", "Relationship")),
                head)
        ci = {h: i for i, h in enumerate(head)}
        s.check("%s: the other columns are kept (Status, Principle, Level Type, Statement, Answer)" % label,
                all(h in ci for h in ("Status", "Principle", "Level Type", "Statement", "Answer")), head)
        subs = subjects_in(units)
        rows = [row for row in body if row[ci["Employee ID"]] in EID.values()]
        s.check("%s: this test's rows are in the file (rows > 0)" % label, len(rows) > 0, len(rows))
        s.check("%s: exactly the subjects in this admin's scope" % label,
                {row[ci["Employee ID"]] for row in rows} == {EID[k] for k in subs}, sorted({row[ci["Employee ID"]] for row in rows}))
        # the same rows as the super admin's file, only the subjects in scope: one row per answer
        want = sum(db_rows(
            "SELECT COUNT(*) FROM responses r JOIN assignments a ON a.id=r.assignment_id WHERE a.cycle_id=? AND a.subject_id=? "
            "AND a.archived=0 AND a.status='submitted'", (CID, IDS[k]))[0][0] for k in subs)
        s.check("%s: one row for every SUBMITTED answer of the rated people in scope (the full file less the drafts)" % label,
                len(rows) == want, (len(rows), want))
        s.check("%s: every Rater value is 'Rater N'" % label,
                all(re.fullmatch(r"Rater \d+", str(row[ci["Rater"]])) for row in rows), {row[ci["Rater"]] for row in rows})
        # the numbering: 1..n per subject, no gaps, in submission order (read from the database)
        for k in subs:
            got = [row for row in rows if row[ci["Employee ID"]] == EID[k]]
            nums = sorted({int(row[ci["Rater"]].split()[1]) for row in got})
            order = [x for x in expected_order(k) if x in {r_[0] for r_ in db_rows(
                "SELECT DISTINCT assignment_id FROM responses WHERE assignment_id IN (SELECT id FROM assignments WHERE subject_id=?)",
                (IDS[k],))}]
            s.check("%s: %s numbered 1..n with no gaps (n = %d raters with answers)" % (label, k, len(order)),
                    nums == list(range(1, len(nums) + 1)) and len(nums) == len(order), (nums, len(order)))
            # the rater number of each assignment in the file: Rater n's (statement, answer) pairs are the ones the database
            # gives the assignment in place n of the submission order
            by_num = {}
            for row in got:
                by_num.setdefault(int(row[ci["Rater"]].split()[1]), set()).add((row[ci["Statement"]], row[ci["Answer"]]))
            exp_rank = {aid: i + 1 for i, aid in enumerate(expected_order(k))}
            pairs = {aid: {(t, ans) for t, ans in db_rows(
                "SELECT st.text, r.answer FROM responses r JOIN cycle_statements st ON st.id=r.statement_id "
                "WHERE r.assignment_id=?", (aid,))} for aid in order}
            s.check("%s: %s numbering follows the submission order (each Rater n holds the answers of the n-th to submit)" % (label, k),
                    all(by_num.get(exp_rank[aid]) == pairs[aid] for aid in order) and len({frozenset(v) for v in pairs.values()}) == len(order),
                    (k, sorted(by_num)))
            # rows are grouped by rater number in ascending order, never by name
            seq = [int(row[ci["Rater"]].split()[1]) for row in got]
            s.check("%s: %s rows run by rater number, statements in their own order" % (label, k), seq == sorted(seq), seq)
        s.check("%s: no draft: every row's Status is submitted, and S1's pending rater (with answers in the database) is not in" % label,
                {row[ci["Status"]] for row in rows} == {"submitted"} and sorted({int(row[ci["Rater"]].split()[1]) for row in rows
                if row[ci["Employee ID"]] == EID["S1"]}) == [1, 2, 3], {row[ci["Status"]] for row in rows})
        # subjects stay together and in the full file's subject order
        eids = [row[ci["Employee ID"]] for row in rows]
        s.check("%s: each subject's rows are together" % label,
                [k for i, k in enumerate(eids) if i == 0 or k != eids[i - 1]] == list(dict.fromkeys(eids)), None)
        # no cell carries a rater's identity: the data columns of every row, and every cell of every sheet, About included
        leaks = []
        data_from = ci["Rater"]
        for k in IDS:
            for ident in rater_facts(k):
                for sheet_name, rws in wb.items():
                    for row in rws[1:]:
                        for j, cell in enumerate(row):
                            if sheet_name == "360 responses" and j < data_from and row[ci["Employee ID"]] in (ident[0],):
                                continue   # a subject's own identity block (a rater may be rated too): not a rater cell
                            if cell is None:
                                continue
                            c = str(cell)
                            if c in (ident[0], ident[1], ident[2]) or ident[1] in c or ident[2] in c:
                                leaks.append((k, sheet_name, j))
        s.check("%s: no cell of any sheet carries a rater's ID, name or email" % label, not leaks, leaks[:5])
        rel_hits = [(sn, j) for sn, rws in wb.items() for row in rws[1:] for j, cell in enumerate(row)
                    if isinstance(cell, str) and (cell in RELS or any(x in cell.lower() for x in ("line_manager", "direct_report",
                                                                                                   "matrix_manager")))]
        s.check("%s: no cell gives a relationship" % label, not rel_hits, rel_hits[:5])
        about = {row[0]: row[1] for row in wb["About"][1:]}
        s.check("%s: the About sheet says the raters are numbered by submission order, without names" % label,
                "order" in str(about.get("What this is", "")) and "no rater is named" in str(about.get("What this is", "")),
                about.get("What this is"))
        disp = r.headers.get("Content-Disposition", "")
        s.check("%s: the file name carries no rater" % label, not any(x in disp for x in ("Rater", "Assessor", "ZZRM-R")), disp)
        return head, body

    h_bg, b_bg = masked_checks("BG admin", C_BG, (CO1, CO2))
    h_bu, b_bu = masked_checks("BU admin (unit one)", C_BU, (CO1,))
    masked_checks("whole-company custom role", C_CR, (CO1, CO2))

    # ------------------------------------------------------------------------------------------------ the old address
    s.section("the old .csv address behaves the same for the BG admin")
    r2 = C_BG.get(CSV + URLQ)
    head2, body2, wb2 = sheet1(r2)
    mine_a = [row for row in b_bg if row[h_bg.index("Employee ID")] in EID.values()]
    mine_b = [row for row in body2 if row[head2.index("Employee ID")] in EID.values()]
    s.check("status 200 and the same header", r2.status_code == 200 and head2 == h_bg, head2)
    s.check("...the same rows, in the same order, with the same rater numbers", mine_a == mine_b and len(mine_a) > 0, (len(mine_a), len(mine_b)))

    # ------------------------------------------------------------------------------------------------ falsify the numbering
    s.section("the number is the submission order, not the assignment order")
    ids1 = [r_["id"] for r_ in db_rows("SELECT id FROM assignments WHERE cycle_id=? AND subject_id=? AND archived=0 ORDER BY id", (CID, S1))]
    s.check("S1's assignment ids are NOT in submission order here (the test would pass by accident otherwise)",
            expected_order("S1") != ids1, (expected_order("S1"), ids1))
    with a.app.test_request_context("/"):
        got_order = a._rater_order(a.get_db(), [S1, S2], CID)
    s.check("_rater_order returns the same order as the database read: submitted raters only, no archived, no draft",
            got_order[S1] == expected_order("S1") and got_order[S2] == expected_order("S2"), got_order)
    s.check("...S2's tie at one second falls to the assignment id", got_order[S2] == sorted(got_order[S2]), got_order[S2])
    s.check("...S1's draft (pending) rater is not in it: three raters", len(got_order[S1]) == 3, got_order[S1])

    # ------------------------------------------------------------------------------------------------ Results lines up
    s.section("Results' Rater n remark sits at the same n as that rater's answers in Responses")
    rr = C_BG.get("/admin/export/results.xlsx" + URLQ)
    wbr = workbook(rr)
    rrows = wbr[list(wbr)[0]]
    rh = rrows[0]
    res_s1 = [x for x in rrows[1:] if x[rh.index("Employee ID")] == EID["S1"]]
    s.check("Results downloads for the BG admin and has S1's row", rr.status_code == 200 and len(res_s1) == 1, rr.status_code)
    rem_cols = {int(re.fullmatch(r"Rater (\d+) remark", h).group(1)): i for i, h in enumerate(rh)
                if isinstance(h, str) and re.fullmatch(r"Rater \d+ remark", h)}
    cell = lambda n: (res_s1[0][rem_cols[n]] if n in rem_cols else None) or ""
    s.check("column 1 is blank (the first to submit left no remark), column 2 and 3 hold the next two raters' remarks, no draft",
            cell(1) == "" and cell(2) == "ZZRM remark by the second to submit" and cell(3) == "ZZRM remark by the third to submit"
            and len(rem_cols) >= 3 and not any("draft" in str(c) for c in res_s1[0] if c), [cell(n) for n in sorted(rem_cols)])
    head_m, body_m, _wb = sheet1(C_BG.get(XLSX + URLQ))
    cm = {h: i for i, h in enumerate(head_m)}
    s1_rows = [row for row in body_m if row[cm["Employee ID"]] == EID["S1"]]

    def answers_at(n):
        return {(row[cm["Statement"]], row[cm["Answer"]]) for row in s1_rows if row[cm["Rater"]] == "Rater %d" % n}

    def pairs_of(key):
        return {(t, ans) for t, ans in db_rows(
            "SELECT st.text, r.answer FROM responses r JOIN cycle_statements st ON st.id=r.statement_id JOIN assignments a "
            "ON a.id=r.assignment_id WHERE a.cycle_id=? AND a.subject_id=? AND a.assessor_id=?", (CID, S1, R[key]))}
    s.check("the rater whose remark is in Results' column 2 has their answers at Rater 2 in the masked Responses file (R4)",
            answers_at(2) == pairs_of("R4") != set(), None)
    s.check("...and column 3's remark rater (R1) is Rater 3, the blank slot's rater (R2) is Rater 1",
            answers_at(3) == pairs_of("R1") and answers_at(1) == pairs_of("R2"), None)
finally:
    with a.app.test_request_context("/"):
        d = a.get_db()
        cleanup(d)

sys.exit(s.done())
