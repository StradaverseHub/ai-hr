"""One-person reports and files: out means out, and a draft file is its author's (security tests 1b-03 and 1b-04, 2026-10-31).

1b-03  The one-person readers skipped `_report_takes_part`: the two calibration subject reports (`/calibration/subject/<uid>/
       kpi-report` and `.../potential-report`) and the two attachment downloads (a KPI file and an evidence file) opened for
       the HOD, BU CEO, BG CEO and line manager of a person an admin took out of the review. They now ask
       (`_one_person_report_refusal`) and answer the plain sentence from `_report_part_refusal()`. A past cycle's file passes
       the report's own cycle, so history still opens; the person's own reads and an admin's stay open (Chris, 31 Oct).
1b-04  A draft evidence file and a draft KPI file opened by direct URL for the line manager. A draft is its author's (and,
       for a manager's note about them, the person's own: the ledger shows it to them by design, 1b-05), nobody else's in the
       chain; once shared / submitted it opens.

Its own synthetic business group; the suite writes, so it takes a fresh copy.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Out means out for one-person reports and files; a draft file is its author's (1b-03, 1b-04)")
BG, CA = "ZZRF Group", "ZZRF Alpha Sdn Bhd"

with a.app.test_request_context("/"):
    db = a.get_db()
    CID = a.active_cycle_id(db)
    PER = a.active_pm_period(db)["id"]
    PAST = db.execute("SELECT id FROM cycles WHERE is_active=0 AND id<>? ORDER BY id LIMIT 1", (CID,)).fetchone()[0]
    db.execute("UPDATE cycles SET half=2 WHERE id=?", (CID,))
    db.execute("UPDATE cycle_modules SET active=1 WHERE cycle_id=?", (CID,))
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]

    def person(eid, name, **over):
        v = dict(base, username=eid.lower(), employee_id=eid, full_name=name, email=None, hod_id=None, manager_id=None,
                 buceo_bg=None, buceo_company=None, bgceo_bg=None, business_group=BG, company=CA)
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE username=?", (eid.lower(),)).fetchone()[0]
    LM = person("ZZRF-LM", "ZZ RF Line Manager")
    HODU = person("ZZRF-HOD", "ZZ RF Dept Head")
    BUC = person("ZZRF-BUC", "ZZ RF Unit CEO", buceo_bg=BG, buceo_company=CA)
    BGC = person("ZZRF-BGC", "ZZ RF Group CEO", bgceo_bg=BG)
    OTHER = person("ZZRF-OTH", "ZZ RF Another Approver")
    S = person("ZZRF-S", "ZZ RF Subject", manager_id=LM, hod_id=HODU)
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) SELECT ?, 'A' WHERE NOT EXISTS "
               "(SELECT 1 FROM pm_bg_config WHERE business_group=?)", (BG, BG))

    def kpi(cycle, name, draft, uploaded_by):
        tid = db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, status, business_group, "
                         "company, rate1, rate2, rate3, rate4, rate5) VALUES (?,?,?,100,'more','approved',?,?,1,2,3,4,5)",
                         (cycle, S, name, BG, CA)).lastrowid
        db.execute("INSERT INTO pm_kpi_target_approvers(kpi_target_id, seq, approver_id) VALUES (?,1,?)", (tid, LM))
        path, backend = a.pm_store_attachment(cycle, tid, ".txt", b"ZZRF file " + name.encode(), "text/plain")
        db.execute("INSERT INTO pm_attachments(kpi_target_id, filename, stored_path, content_type, size_bytes, uploaded_by, "
                   "storage_backend, draft) VALUES (?,?,?,?,?,?,?,?)",
                   (tid, "f.txt", path, "text/plain", 12, uploaded_by, backend, draft))
        return tid
    K_NOW = kpi(PER, "ZZRF now", 0, S)
    K_PAST = kpi(PAST, "ZZRF past", 0, S)
    K_DRAFT = kpi(PER, "ZZRF draft", 1, S)
    K_BEHALF = kpi(PER, "ZZRF behalf", 1, LM)

    def ev(author, role, state, label):
        eid = db.execute("INSERT INTO pm_evidence(subject_id, author_id, author_role, occurred_on, body, state, cycle_id) "
                         "VALUES (?,?,?,date('now'),?,?,?)", (S, author, role, "ZZRF " + label, state, PER)).lastrowid
        stored, backend = a.evidence_store_attachment(eid, "txt", b"ZZRF evidence " + label.encode(), "text/plain")
        aid = db.execute("INSERT INTO pm_evidence_attachments(evidence_id, filename, stored_path, content_type, size_bytes, "
                         "storage_backend, uploaded_by) VALUES (?,?,?,?,?,?,?)",
                         (eid, "e.txt", stored, "text/plain", 12, backend, author)).lastrowid
        return eid, aid
    E_SHARED = ev(S, "self", "shared", "shared")
    E_DRAFT = ev(S, "self", "draft", "draft")
    E_MGR_DRAFT = ev(LM, "manager", "draft", "manager draft")
    db.commit()

C = {n: H.client_as(a, u) for n, u in (("lm", LM), ("hod", HODU), ("bu", BUC), ("bg", BGC), ("s", S), ("other", OTHER))}
SU = H.one(a, "SELECT id FROM users WHERE role='admin' AND COALESCE(admin_bg,'')='' LIMIT 1")
C["su"] = H.client_as(a, SU)
kfile = lambda who, tid: C[who].get("/performance/kpi/%d/attachment" % tid)
efile = lambda who, pair: C[who].get("/evidence/attachment/%d" % pair[1])
kreport = lambda who: C[who].get("/calibration/subject/%d/kpi-report" % S)
preport = lambda who: C[who].get("/calibration/subject/%d/potential-report" % S)
PM_WORDS = "Performance isn't part of this person's review this cycle."
CP_WORDS = "The competency review isn't part of this person's review this cycle."


def text(r):
    return r.get_data(as_text=True)


# ---------------------------------------------------------------------------
s.section("1b-03 control: S takes part -- every leader opens the report and the files")
s.check("the line manager opens the KPI file and the shared evidence file",
        kfile("lm", K_NOW).status_code == 200 and efile("lm", E_SHARED).status_code == 200)
s.check("the HOD, BU CEO and BG CEO open the KPI report",
        all(kreport(w).status_code == 200 for w in ("hod", "bu", "bg")), [kreport(w).status_code for w in ("hod", "bu", "bg")])
s.check("...and the potential report", all(preport(w).status_code == 200 for w in ("hod", "bu", "bg")),
        [preport(w).status_code for w in ("hod", "bu", "bg")])

# ---------------------------------------------------------------------------
s.section("1b-03 S is taken out of the review")
with a.app.test_request_context("/"):
    d = a.get_db()
    d.execute("INSERT INTO cycle_participants(cycle_id, subject_id, mode) VALUES (?,?, 'remove') "
              "ON CONFLICT(cycle_id, subject_id) DO UPDATE SET mode='remove'", (CID, S))
    d.commit()
    out_now = a._report_takes_part(d, S, "pm")
s.check("the fixture works: S no longer takes part in Performance", out_now is False)
r = kfile("lm", K_NOW)
s.check("the line manager's KPI file download is refused with the plain sentence", r.status_code == 403 and text(r) == PM_WORDS,
        (r.status_code, text(r)[:80]))
r = efile("lm", E_SHARED)
s.check("...and the shared evidence file", r.status_code == 403 and text(r) == PM_WORDS, (r.status_code, text(r)[:80]))
for who in ("hod", "bu", "bg"):
    r = kreport(who)
    s.check("%s: the KPI report is refused with the sentence, no data" % who,
            r.status_code == 403 and text(r) == PM_WORDS and "ZZRF" not in text(r), (r.status_code, text(r)[:80]))
    r = preport(who)
    s.check("%s: the potential report is refused with the sentence" % who,
            r.status_code == 403 and text(r) == CP_WORDS, (r.status_code, text(r)[:80]))
s.check("the person's own file still opens", kfile("s", K_NOW).status_code == 200 and efile("s", E_SHARED).status_code == 200)
s.check("an admin's still opens (admin pages keep every row)", kfile("su", K_NOW).status_code == 200)
s.check("a past cycle's file still opens for the line manager (the report's own cycle: S was in the review then)",
        kfile("lm", K_PAST).status_code == 200, kfile("lm", K_PAST).status_code)
s.check("a person still out of the cycle is not the only gate: someone with no way to see the file still gets nothing",
        kfile("other", K_PAST).status_code == 403 and efile("other", E_SHARED).status_code == 404)
with a.app.test_request_context("/"):
    d = a.get_db()
    d.execute("DELETE FROM cycle_participants WHERE cycle_id=? AND subject_id=?", (CID, S))   # put back
    d.commit()
s.check("put back: the line manager opens the file again", kfile("lm", K_NOW).status_code == 200)

# ---------------------------------------------------------------------------
s.section("1b-04 a draft file is its author's")
r = efile("lm", E_DRAFT)
s.check("the line manager cannot open the subject's DRAFT evidence file by its URL", r.status_code == 404, r.status_code)
s.check("...the subject, its author, can", efile("s", E_DRAFT).status_code == 200)
s.check("...and nobody else in the chain (another approver, the HOD)", efile("other", E_DRAFT).status_code == 404
        and efile("hod", E_DRAFT).status_code == 404)
s.check("a manager's DRAFT note's file: the manager (author) opens it, and so does the person it is about (it is on their "
        "ledger by design, 1b-05)", efile("lm", E_MGR_DRAFT).status_code == 200 and efile("s", E_MGR_DRAFT).status_code == 200)
s.check("...but another leader in the chain does not (the HOD)", efile("hod", E_MGR_DRAFT).status_code == 404)
with a.app.test_request_context("/"):
    d = a.get_db()
    d.execute("UPDATE pm_evidence SET state='shared' WHERE id=?", (E_DRAFT[0],))
    d.commit()
s.check("once the subject shares it, the line manager opens it", efile("lm", E_DRAFT).status_code == 200)

r = kfile("lm", K_DRAFT)
s.check("the line manager (an approver of the line) cannot open a DRAFT KPI file by its URL", r.status_code == 403, r.status_code)
s.check("...the subject can", kfile("s", K_DRAFT).status_code == 200)
s.check("...an admin cannot either: a draft is its author's", kfile("su", K_DRAFT).status_code == 403, kfile("su", K_DRAFT).status_code)
s.check("a file the line manager attached on the person's behalf is theirs while a draft", kfile("lm", K_BEHALF).status_code == 200
        and kfile("s", K_BEHALF).status_code == 200)
with a.app.test_request_context("/"):
    d = a.get_db()
    d.execute("UPDATE pm_attachments SET draft=0 WHERE kpi_target_id=?", (K_DRAFT,))
    d.commit()
s.check("once the result is submitted (draft cleared), the line manager opens it", kfile("lm", K_DRAFT).status_code == 200)

sys.exit(s.done())
