"""Every import in four steps (Chris, 2026-10-26: "for all our import function, we should have the 4 steps flow, first
is the file upload, second is QC, third is to mark the changes (preview on how it will affect the production data) and
get the inputs from the super admin, lastly is final preview and apply"; "super admin only, KPI targets first then the
rest"). The People import has its own suite (test_roster_quality) and the KPI targets import its own
(test_kpi_import_steps); this one holds the rest on the shared engine (_imp_*):

  * Import job codes: the quality step, each person's job now and the file's, and the super admin's answer for someone
    whose competency list is held and whose job the file moves (move the job, their list as it is; or leave them)
  * Set passwords: the kept file holds hashes only, never a password; the super admin's answer for someone who has
    signed in before (replace it or leave it)
  * Clear 360 panels: each panel, and the super admin's answer for someone whose raters have already given feedback
    (clear it too, that feedback archived; or keep it)
  * Import 360 panels: each panel before and after, and the super admin's answer for a pairing archived earlier
    (bring it back, or leave it out)
  * The KPI library import: what each KPI does, and the super admin's answers for a new name close to a KPI the library
    has (merge it in, its name an alias; or add it as new) and a BU-level change on a KPI people carry (change it, or
    leave it as it is)

Synthetic (ZZ9IS-*) on the shared suite database; everything is put back at the end.
"""
import csv as _csv
import hashlib
import io
import os
import re
import sys

from werkzeug.security import check_password_hash

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Imports in four steps: job codes, passwords, clear panels, 360 panels, the KPI library")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
PFX, BG, CO = "ZZ9IS-", "ZZIS Group", "ZZIS Unit"
U, P = {}, {}


def _cleanup(db):
    db.execute("DELETE FROM pm_kpi_library_people WHERE library_id IN (SELECT id FROM pm_kpi_library WHERE business_group=?)", (BG,))
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE ?", (PFX + "%",))]
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM tc_assessments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM tc_assignments WHERE subject_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM assignments WHERE subject_id IN (%s) OR assessor_id IN (%s)" % (ph, ph), ul + ul)
        db.execute("DELETE FROM ja_people WHERE employee_id LIKE ?", (PFX + "%",))
        db.execute("UPDATE users SET manager_id=NULL WHERE id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM tc_job_profile_skills WHERE profile_id IN (SELECT id FROM tc_job_profiles WHERE job_code "
               "LIKE 'ZIS-%')")
    db.execute("DELETE FROM tc_job_profiles WHERE job_code LIKE 'ZIS-%'")
    db.execute("DELETE FROM tc_skills WHERE skill_code LIKE 'ZZIS-%'")
    db.execute("DELETE FROM ja_taxonomy WHERE code LIKE 'ZIS%'")
    db.execute("DELETE FROM pm_kpi_targets WHERE business_group=?", (BG,))
    for t in ("pm_kpi_aliases", "pm_kpi_library", "pm_bg_config", "org_units"):
        db.execute("DELETE FROM %s WHERE business_group=?" % t, (BG,))
    db.commit()


def xfile(head, rows):
    buf = io.StringIO()
    w = _csv.writer(buf)
    w.writerow(head)
    w.writerows(rows)
    return io.BytesIO(buf.getvalue().encode())


def stage(url, f, **extra):
    """Step 1: choose the file (preview=1): the token of the kept file."""
    r = C.post(url, data=dict({"csrf_token": "tok", "preview": "1", "file": (f, "is.csv")}, **extra),
               content_type="multipart/form-data")
    return (re.search(r"check=([0-9a-f]{32})", r.headers.get("Location", "")) or [None, ""])[1]


def step(url, tok, action, **form):
    return C.post(url, data=dict({"csrf_token": "tok", "token": tok, "action": action}, **form))


def page(url, tok, st=None):
    return C.get(url + "?check=%s%s" % (tok, ("&step=" + st) if st else "")).get_data(as_text=True)


def answer(url, tok, picks, action="to_apply"):
    return step(url, tok, action, **{"d_" + hashlib.sha1(k.encode()).hexdigest()[:10]: v for k, v in picks.items()})


def spec_of(eid):
    r = H.rows(a, "SELECT spec_code FROM ja_people WHERE employee_id=?", (eid,))
    return r[0][0] if r else None


def n_set(k):
    return H.one(a, "SELECT COUNT(*) FROM tc_assignments WHERE cycle_id=? AND subject_id=?", (CID, U[k]))


try:
    with a.app.test_request_context("/"):
        db = a.get_db()
        db.execute("PRAGMA foreign_keys=ON")
        _cleanup(db)
        CID = a.active_cycle_id(db)
        ACT = a.active_cycle(db)
        db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
        SK = {}
        for t in ("S1", "S2", "S3", "S4", "S5"):
            for lv in (3, 4):
                SK[(t, lv)] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, active) VALUES "
                                         "(?,?,?, 'tsc', 1)", ("ZZIS-%s-%d" % (t, lv), "ZZIS Skill " + t, lv)).lastrowid

        def prof(code, title):
            pid = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, plan_mode, source, "
                             "active) VALUES ('ZZIS Dept', ?, ?, ?, 'explicit', 'architecture', 1)",
                             (title, code.rsplit("-", 1)[1], code)).lastrowid
            for i, t in enumerate(("S1", "S2", "S3", "S4", "S5")):
                for fut, lv in ((0, 3), (1, 4)):
                    db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, "
                               "is_future) VALUES (?,?,?,?,?)", (pid, SK[(t, lv)], lv, i, fut))
            P[code] = pid
        prof("ZIS-OPS-01-14", "Senior Executive, Zisops")
        prof("ZIS-OPS-02-14", "Senior Executive, Zisplan")
        for code, lvl, parent in (("ZIS", "family", None), ("ZIS-OPS", "sub", "ZIS"), ("ZIS-OPS-01", "spec", "ZIS-OPS"),
                                  ("ZIS-OPS-02", "spec", "ZIS-OPS")):
            db.execute("INSERT INTO ja_taxonomy(code, level, parent_code, name) VALUES (?,?,?,?)",
                       (code, lvl, parent, code))
        for k, conf in (("A", "2020-01-01"), ("B", "2020-01-01"), ("C", None)):
            U[k] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                              "company, department, job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?, "
                              "'ZZIS Dept', '14', ?)", ((PFX + k).lower(), "ZZ IS " + k, PFX + k, BG, CO, conf)).lastrowid
        me = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        pb = db.execute("SELECT * FROM users WHERE id=?", (U["B"],)).fetchone()
        prow = db.execute("SELECT * FROM tc_job_profiles WHERE id=?", (P["ZIS-OPS-01-14"],)).fetchone()
        a._place_job_assign(db, me, pb, ACT, prow)   # B is on the Zisops job and has started their self-assessment
        asm = db.execute("INSERT INTO tc_assessments(cycle_id, subject_id) VALUES (?,?)", (CID, U["B"])).lastrowid
        first = db.execute("SELECT id FROM tc_assignments WHERE cycle_id=? AND subject_id=? ORDER BY id LIMIT 1",
                           (CID, U["B"])).fetchone()[0]
        db.execute("INSERT INTO tc_scores(assessment_id, assignment_id, answer) VALUES (?,?, 'yes')", (asm, first))
        db.commit()
    C = H.client_as(a, SU["id"])

    s.section("Import job codes")
    J = "/admin/competency/import-jobs"
    head = list(a.JOB_IMPORT_COLUMNS)
    rows = [[PFX + "A", "ZIS-OPS-01-14", ""], [PFX + "B", "ZIS-OPS-02-14", ""], [PFX + "C", "ZIS-OPS-01-14", ""]]
    tok = stage(J, xfile(head, rows))
    pg = page(J, tok)
    s.check("choosing the file keeps it and checks it: someone not taking part is worth a look, nothing placed",
            bool(tok) and "2 · Quality" in pg and "person isn" in pg and "ZZ9IS-C: their job is placed" in pg
            and spec_of(PFX + "A") is None)
    step(J, tok, "quality_ok", ack="1")
    pg = page(J, tok, "changes")
    s.check("the changes: each person's job now and the file's, and B asked about (their list is held, the job moves)",
            "Each person&#39;s job" in pg and "Their competency list is held, and the file moves their job (1)" in pg
            and "Move the job" in pg and "Leave them" in pg and "ZIS-OPS-01-14" in pg and "Super admin answers" in pg)
    step(J, tok, "to_apply")
    s.check("unanswered, Continue goes nowhere", not a._imp_meta("jobs", tok).get("changes")
            and "Apply this file" not in page(J, tok, "apply"))
    answer(J, tok, {"job:" + PFX + "B": "leave"})
    pg = page(J, tok, "apply")
    s.check("the final preview: A placed with the job's competencies, B left on their current job, C placed with none",
            "Left on their current job" in pg and "Placed as Senior Executive, Zisops, with that job" in pg
            and "no competencies this cycle (not taking part)" in pg and 'data-confirm-ok="Apply this file"' in pg)
    dl = C.get(J + "/check/%s.xlsx?what=final" % tok)
    s.check("...and downloads as Excel", dl.status_code == 200 and dl.data[:2] == b"PK")
    r = step(J, tok, "apply")
    s.check("applied: A placed with 10 competencies, C placed with none, B still on Zisops with their started list",
            spec_of(PFX + "A") == "ZIS-OPS-01" and n_set("A") == 10 and spec_of(PFX + "C") == "ZIS-OPS-01"
            and n_set("C") == 0 and spec_of(PFX + "B") == "ZIS-OPS-01" and n_set("B") == 10,
            (spec_of(PFX + "A"), n_set("A"), spec_of(PFX + "C"), n_set("C"), spec_of(PFX + "B")))
    done = C.get(r.headers.get("Location", "")).get_data(as_text=True)
    s.check("...the done page says so, with the answer counted", "Applied is.csv" in done and "1 answered" in done
            and "left on their current job, as you answered" in done)
    s.check("...the audit trail names who was left", "left 1 on their current job (ZZ9IS-B)" in (H.one(
        a, "SELECT detail FROM activity_log WHERE action='job_import' AND user_id=? ORDER BY id DESC LIMIT 1",
        (SU["id"],)) or ""))
    tok = stage(J, xfile(head, [[PFX + "B", "ZIS-OPS-02-14", ""]]))
    step(J, tok, "quality_ok")
    answer(J, tok, {"job:" + PFX + "B": "move"})
    step(J, tok, "apply")
    s.check("answered Move the job: B is placed on Zisplan, and their started list stays as it was",
            spec_of(PFX + "B") == "ZIS-OPS-02" and n_set("B") == 10 and H.one(
                a, "SELECT COUNT(*) FROM tc_scores sc JOIN tc_assignments t ON t.id=sc.assignment_id WHERE "
                   "t.subject_id=?", (U["B"],)) == 1)

    s.section("Set passwords")
    PW = "/admin/import/passwords"
    with a.app.app_context():   # A has signed in before; B never has
        db = a.get_db()
        db.execute("INSERT INTO activity_log(user_id, action) VALUES (?, 'login')", (U["A"],))
        db.commit()
    hash_a = H.one(a, "SELECT password_hash FROM users WHERE id=?", (U["A"],))
    tok = stage(PW, xfile(["Employee ID", "Password"], [[PFX + "A", "ZzIs-Pass-1!x"], [PFX + "B", "ZzIs-Pass-2!y"]]))
    kept = open(os.path.join(a._imp_dir("passwords"), tok + ".bin"), "rb").read()
    s.check("the kept file holds each password's hash, never the password", bool(tok) and b"ZzIs-Pass" not in kept
            and b"pbkdf2:sha256" in kept)
    step(PW, tok, "quality_ok")
    pg = page(PW, tok, "changes")
    s.check("the changes: whose password, never the password; A asked about (has signed in before)",
            "They have signed in before (1)" in pg and "Replace it" in pg and "Leave it" in pg and "ZZ IS A" in pg
            and "Never signed in" in pg and "ZzIs-Pass" not in pg)
    answer(PW, tok, {"pw:" + PFX + "A": "leave"})
    pg = page(PW, tok, "apply")
    s.check("the final preview: B's set, A's left as it is", "Left as it is" in pg and "Password set" in pg
            and "leaving 1 as they are" in pg)
    step(PW, tok, "apply")
    s.check("applied: B's password is the file's; A keeps theirs", check_password_hash(H.one(
        a, "SELECT password_hash FROM users WHERE id=?", (U["B"],)), "ZzIs-Pass-2!y") and H.one(
        a, "SELECT password_hash FROM users WHERE id=?", (U["A"],)) == hash_a)
    s.check("...the hashes are gone from the server, and the audit trail names who", not os.path.exists(
        os.path.join(a._imp_dir("passwords"), tok + ".bin")) and "left 1 as they were (ZZ9IS-A)" in (H.one(
            a, "SELECT detail FROM activity_log WHERE action='password_import' AND user_id=? ORDER BY id DESC LIMIT 1",
            (SU["id"],)) or ""))

    s.section("Clear 360 panels")
    CL = "/admin/clear-panels"
    with a.app.app_context():   # A: one rater not rated yet; B: one given, one not yet; C: no panel
        db = a.get_db()
        for k in ("R1", "R2"):
            U[k] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                              "company, job_grade, confirmation_date) VALUES (?,?, 'x', 'user', ?,?,?, '14', "
                              "'2020-01-01')", ((PFX + k).lower(), "ZZ IS " + k, PFX + k, BG, CO)).lastrowid
        db.executemany("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) VALUES "
                       "(?,?,?, 'peer', ?)", [(CID, U["A"], U["R1"], "pending"), (CID, U["B"], U["R1"], "submitted"),
                                              (CID, U["B"], U["R2"], "pending")])
        db.commit()
    rows_of = lambda k: sorted(tuple(r) for r in H.rows(  # noqa: E731
        a, "SELECT assessor_id, status, archived FROM assignments WHERE cycle_id=? AND subject_id=?", (CID, U[k])))
    tok = stage(CL, xfile(["Employee ID"], [[PFX + "A"], [PFX + "B"], [PFX + "C"]]))
    pg = page(CL, tok)
    s.check("the quality step: C has no panel to clear (worth a look), nothing cleared",
            "person has no panel" in pg and "ZZ9IS-C has no panel to clear" in pg and len(rows_of("A")) == 1)
    step(CL, tok, "quality_ok", ack="1")
    pg = page(CL, tok, "changes")
    s.check("the changes: each panel, and B asked about (feedback already given)",
            "Their raters have already given feedback (1)" in pg and "Clear it too" in pg and "Keep it" in pg)
    answer(CL, tok, {"clear:" + PFX + "B": "keep"})
    step(CL, tok, "apply")
    s.check("applied, B kept: A's rater not rated yet removed, B's panel as it was",
            rows_of("A") == [] and rows_of("B") == sorted([(U["R1"], "submitted", 0), (U["R2"], "pending", 0)]),
            rows_of("B"))
    tok = stage(CL, xfile(["Employee ID"], [[PFX + "B"]]))
    step(CL, tok, "quality_ok")
    answer(CL, tok, {"clear:" + PFX + "B": "clear"})
    step(CL, tok, "apply")
    s.check("answered Clear it too: B's given feedback archived (restorable), the rest removed",
            rows_of("B") == [(U["R1"], "submitted", 1)], rows_of("B"))

    s.section("Import 360 panels")
    PN = "/admin/import"
    phead = list(a.PANEL_IMPORT_COLUMNS)
    prow = lambda subj, assr: [{"Subject Employee ID": subj, "Assessor Employee ID": assr, "Relationship": "peer"}.get(  # noqa: E731
        c, "") for c in phead]
    pair = lambda k, r: tuple((H.rows(a, "SELECT status, archived FROM assignments WHERE cycle_id=? AND subject_id=? "  # noqa: E731
                                         "AND assessor_id=?", (CID, U[k], U[r])) or [(None, None)])[0])
    tok = stage(PN, xfile(phead, [prow(PFX + "B", PFX + "R1"), prow(PFX + "B", PFX + "R2"), prow(PFX + "A", PFX + "R2")]))
    step(PN, tok, "quality_ok", ack="1")
    pg = page(PN, tok, "changes")
    s.check("the changes: each panel before and after, and B's pairing with R1 (archived earlier) asked about",
            "Each person&#39;s panel" in pg and "A pairing archived earlier (1)" in pg and "Bring it back" in pg
            and "Leave it out" in pg and "2 raters to add" not in pg, re.findall(r"ri-tile[^>]*><b>(\d+)</b><span>([^<]*)", pg))
    answer(PN, tok, {"back:%sB:%sR1" % (PFX, PFX): "out"})
    pg = page(PN, tok, "apply")
    s.check("the final preview: B gains R2, R1 left out", "1 left out" in pg and "1 added" in pg)
    step(PN, tok, "apply")
    s.check("applied: R2 rates A and B; B's pairing with R1 stays archived", pair("A", "R2") == ("pending", 0)
            and pair("B", "R2") == ("pending", 0) and pair("B", "R1") == ("submitted", 1), (pair("B", "R1"),))
    tok = stage(PN, xfile(phead, [prow(PFX + "B", PFX + "R1")]))
    step(PN, tok, "quality_ok")
    answer(PN, tok, {"back:%sB:%sR1" % (PFX, PFX): "back"})
    step(PN, tok, "apply")
    s.check("answered Bring it back: R1 is on B's panel again, their feedback with it", pair("B", "R1") == ("submitted", 0))

    s.section("The KPI library import")
    LB = "/admin/performance/library/import"
    with a.app.app_context():
        db = a.get_db()
        db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
        for nm in ("ZZIS Monthly sales revenue", "ZZIS Gross profit (GP)"):
            db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, "
                       "category, unit, method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level) VALUES "
                       "(?, '*', '*', 0, '*', ?, 'Financial', 'RM', 'more', 1, 2, 3, 4, 5, 20, 0)", (BG, nm))
        db.execute("INSERT INTO pm_kpi_targets(cycle_id, subject_id, kpi_name, weightage, method, business_group, company) "
                   "VALUES (?,?, 'ZZIS Gross profit (GP)', 20, 'more', ?, ?)", (CID, U["A"], BG, CO))   # A carries GP
        db.commit()
    lhead = ["Business Group", "Company", "Department", "Tier", "Job Grade", "KPI", "Strategic Thrust / Category",
             "KPI Description", "Unit of Measure", "Method", "Perspective", "BU Level"]   # no number columns (2026-11-02)
    lrow = lambda nm, bu="": [BG, "", "", "", "", nm, "Financial", "", "RM", "More", "Financial", bu]  # noqa: E731
    bu_of = lambda nm: H.one(a, "SELECT bu_level FROM pm_kpi_library WHERE business_group=? AND kpi_name=?", (BG, nm))  # noqa: E731
    n_lib = lambda nm: H.one(a, "SELECT COUNT(*) FROM pm_kpi_library WHERE business_group=? AND kpi_name=?", (BG, nm))  # noqa: E731
    tok = stage(LB, xfile(lhead, [lrow("ZZIS Monthly sales revenue total"), lrow("ZZIS Gross profit (GP)", "Yes"),
                                  lrow("ZZIS Customer complaints closed")]))
    step(LB, tok, "quality_ok")
    pg = page(LB, tok, "changes")
    s.check("the changes: each KPI, a new name close to one the library has, and a BU-level change on a KPI A carries",
            "A new name close to a KPI the library has (1)" in pg and "ZZIS Monthly sales revenue" in pg
            and "BU level changes on a KPI people carry (1)" in pg and "Merge it in" in pg and "Change it" in pg)
    answer(LB, tok, {"near:2": "merge", "bu:3": "no"})
    pg = page(LB, tok, "apply")
    s.check("the final preview: merged into the library's KPI, BU level left as it is, the third added",
            "Merged into ZZIS Monthly sales revenue" in pg and "BU level left as it is" in pg and "Added" in pg)
    step(LB, tok, "apply")
    s.check("applied: no new KPI for the merged name, which becomes an alias of the library's",
            n_lib("ZZIS Monthly sales revenue total") == 0 and H.one(
                a, "SELECT into_name FROM pm_kpi_aliases WHERE business_group=? AND alias_name=?",
                (BG, "ZZIS Monthly sales revenue total")) == "ZZIS Monthly sales revenue")
    s.check("...GP stays personal, and the new KPI is added", bu_of("ZZIS Gross profit (GP)") == 0
            and n_lib("ZZIS Customer complaints closed") == 1)
    tok = stage(LB, xfile(lhead, [lrow("ZZIS Gross profit (GP)", "Yes")]))
    step(LB, tok, "quality_ok")
    answer(LB, tok, {"bu:2": "yes"})
    step(LB, tok, "apply")
    s.check("answered Change it: GP is BU-level now", bu_of("ZZIS Gross profit (GP)") == 1)
    # a library row that names people is a person's own KPI: a file that marks it BU-level leaves its mark and its people
    with a.app.app_context():
        db = a.get_db()
        for nm in ("ZZIS Names people", "ZZIS Names nobody"):
            lid_ = db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, "
                              "category, unit, method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level) VALUES "
                              "(?, '*', '*', 0, '*', ?, 'Financial', 'RM', 'more', 1, 2, 3, 4, 5, 20, 0)", (BG, nm)).lastrowid
            if nm == "ZZIS Names people":
                db.execute("INSERT INTO pm_kpi_library_people(library_id, user_id) VALUES (?,?)", (lid_, U["A"]))
        db.commit()
    people_of = lambda nm: H.one(a, "SELECT COUNT(*) FROM pm_kpi_library_people WHERE library_id=(SELECT id FROM pm_kpi_library "  # noqa: E731
                                 "WHERE business_group=? AND kpi_name=?)", (BG, nm))
    tok = stage(LB, xfile(lhead, [lrow("ZZIS Names people", "Yes"), lrow("ZZIS Names nobody", "Yes")]))
    step(LB, tok, "quality_ok")
    pg = page(LB, tok, "changes")
    s.check("the changes step says a row that names people keeps its mark", "names people: its BU-level mark stays as it is" in pg, pg[:80])
    answer(LB, tok, {})
    step(LB, tok, "apply")
    s.check("applied: the row that names people is not BU-level and keeps its people; the row naming nobody is marked",
            bu_of("ZZIS Names people") == 0 and people_of("ZZIS Names people") == 1 and bu_of("ZZIS Names nobody") == 1,
            (bu_of("ZZIS Names people"), people_of("ZZIS Names people"), bu_of("ZZIS Names nobody")))
    # the file posted without the steps applies at once, through the same writer
    r = C.post(LB, data={"csrf_token": "tok", "file": (xfile(lhead, [lrow("ZZIS Names people", "Yes")]), "is.csv")},
               content_type="multipart/form-data")
    s.check("...and the one-step upload leaves it the same", bu_of("ZZIS Names people") == 0 and people_of("ZZIS Names people") == 1)
    with a.app.app_context():   # put back: the people reference the suite's users, which _cleanup deletes first
        _p = a.get_db()
        _p.execute("DELETE FROM pm_kpi_library_people WHERE library_id IN (SELECT id FROM pm_kpi_library WHERE business_group=?)", (BG,))
        _p.commit()
    # an older file still carrying number columns goes in, those columns ignored and named on the Quality step
    lhead_old = lhead[:-2] + ["Rate 1", "Rate 5", "Weightage Default"] + lhead[-2:]
    lrow_old = lambda nm: lrow(nm)[:-2] + [1, 5, 20] + lrow(nm)[-2:]  # noqa: E731
    tok = stage(LB, xfile(lhead_old, [lrow_old("ZZIS Legacy file KPI")]))
    pg = page(LB, tok, "quality")
    s.check("a legacy file's Quality step says so in one line", "Ignored: Rate 1-5, Weightage (in 1 row)" in pg
            and "The library holds no numbers." in pg)
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
