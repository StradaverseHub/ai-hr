"""No import applies without its steps (security finding 1a-01, Chris 2026-10-31: "fix the import shortcut").

Every import goes in four steps (File, Quality, Changes with the super admin's answers, final preview and Apply, the
database backed up first: `_imp_post`). The routes used to keep an old path as well: a file POSTed with no `preview` and
no `token` applied at once, so a role-ticked BG admin could close a whole group with one request. It is gone: such a
post is refused and changes nothing.

For each of the seven routes (roster, panels, KPI targets, job codes, KPI library, passwords, clear panels), on a
synthetic group, as the super admin and a role-ticked BG admin (403 now: imports are the super admin's alone, 1a-04):
  * a valid file posted with the CSRF token and no step fields: refused with the one message, and the rows it would
    have written (and the people it would have closed) are exactly as they were
  * the same file with preview=1 is kept and has no errors, so the refusal above is the guard, not a bad file
  * the roster's four steps still apply, and so do the others' (a person is created, a password set, a line written ...)
Synthetic (ZZ9NS-*) in ZZNS Group; the suite takes a fresh database copy, put back at the end.
"""
import csv as _csv
import hashlib
import html
import io
import json
import os
import re
import sys

from werkzeug.security import check_password_hash

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("No import applies without its steps (1a-01)")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
PFX, BG, CO = "ZZ9NS-", "ZZNS Group", "ZZNS Unit"
REFUSAL = "Nothing was imported: choose the file on this page and go through its steps"
U = {}
RC = {c.lower(): c for c in a.ROSTER_COLUMNS}

with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    CID = a.active_cycle_id(db)
    ACT = a.active_cycle(db)
    # the KPI targets import reads the active cycle as a Year-End with its results check-in window ahead
    db.execute("UPDATE cycles SET kind='year_end', half=2, min_job_grade=NULL WHERE id=?", (CID,))
    db.execute("INSERT OR REPLACE INTO cycle_windows(cycle_id, cell, opens_at, closes_at) VALUES (?, 'pm_results', "
               "'2099-11-02 00:00', '2099-11-08 23:59')", (CID,))
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?,?)", (BG, CO))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A')", (BG,))
    db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, category, "
               "unit, method, rate1, rate2, rate3, rate4, rate5, weightage_default, bu_level) VALUES "
               "(?, '*', '*', 0, '*', 'ZZNS Sales', 'Financial', '%', 'more', 80, 90, 100, 110, 120, 100, 0)", (BG,))
    for k, conf in (("M", "2019-01-01"), ("A", "2020-01-01"), ("B", "2020-01-01"), ("R", "2020-01-01")):
        U[k] = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                          "company, department, job_grade, confirmation_date, email) VALUES (?,?, 'x', 'user', ?,?,?, "
                          "'ZZNS Dept', '14', ?, ?)", ((PFX + k).lower(), "ZZ NS " + k, PFX + k, BG, CO, conf,
                                                       "zzns-%s@example.com" % k.lower())).lastrowid
    for k in ("A", "B", "R"):
        db.execute("UPDATE users SET manager_id=? WHERE id=?", (U["M"], U[k]))
    # a job profile for the job-codes import
    sk = {}
    for lv in (3, 4):
        sk[lv] = db.execute("INSERT INTO tc_skills(skill_code, title, level, skill_type, active) VALUES (?,?,?, 'tsc', 1)",
                            ("ZZNS-S1-%d" % lv, "ZZNS Skill", lv)).lastrowid
    pid = db.execute("INSERT INTO tc_job_profiles(department, job_title, job_grade, job_code, plan_mode, source, active) "
                     "VALUES ('ZZNS Dept', 'Senior Executive, Zisns', '14', 'ZNS-OPS-01-14', 'explicit', "
                     "'architecture', 1)").lastrowid
    for fut, lv in ((0, 3), (1, 4)):
        db.execute("INSERT INTO tc_job_profile_skills(profile_id, skill_id, required_level, sort_order, is_future) "
                   "VALUES (?,?,?,0,?)", (pid, sk[lv], lv, fut))
    for code, lvl, parent in (("ZNS", "family", None), ("ZNS-OPS", "sub", "ZNS"), ("ZNS-OPS-01", "spec", "ZNS-OPS")):
        db.execute("INSERT INTO ja_taxonomy(code, level, parent_code, name) VALUES (?,?,?,?)", (code, lvl, parent, code))
    # a role-ticked BG admin: the ticks the imports used to need (View only on production). people.roster and pm.import
    # are no longer items (1a-04: every import is the super admin's), so those two rows are stale and must do nothing.
    ROLE = db.execute("INSERT INTO admin_roles(name, scope_kind) VALUES ('ZZNS role', 'group')").lastrowid
    db.executemany("INSERT INTO admin_role_access(role_id, item) VALUES (?,?)",
                   [(ROLE, i) for i in ("people.read", "people.roster", "f360.add", "pm.read", "pm.import",
                                        "competency.job")])
    BGADM = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                       "admin_bg, admin_role_id) VALUES ('zz9ns-adm', 'ZZ NS Admin', 'x', 'admin', 'ZZ9NS-ADM', ?, ?, ?)",
                       (BG, BG, ROLE)).lastrowid
    db.commit()
SUP = H.client_as(a, SU["id"])
BGA = H.client_as(a, BGADM)


def csv_bytes(head, rows):
    buf = io.StringIO()
    w = _csv.writer(buf)
    w.writerow(head)
    w.writerows(rows)
    return buf.getvalue().encode()


def post(client, url, data, body, follow=True):
    """A file posted with the CSRF token in the form and whatever step fields `data` carries."""
    return client.post(url, data=dict({"csrf_token": "tok", "file": (io.BytesIO(body), "ns.csv")}, **data),
                       content_type="multipart/form-data", follow_redirects=follow)


def text(r):
    return html.unescape(r.get_data(as_text=True))


def snap(*queries):
    return [[tuple(x) for x in H.rows(a, q)] for q in queries]


def valid_through_steps(client, url, kind, body, who, **data):
    """The same file with preview=1: kept (a token), and the engine finds no error in it."""
    r = post(client, url, dict(data, preview="1"), body, follow=False)
    tok = (re.search(r"check=([0-9a-f]{32})", r.headers.get("Location", "")) or [None, ""])[1]
    if not tok:
        return False, None
    with a.app.test_request_context("/"):
        db = a.get_db()
        me = dict(db.execute("SELECT * FROM users WHERE id=?", (who,)).fetchone())
        if kind == "kti":
            got = a._kti_load(db, me, a.active_pm_period(db), tok)
            return bool(got) and not got[1]["errors"], tok
        got = a._imp_load(kind, db, me, tok)
        return bool(got) and not got[2]["errors"], tok


def refuse(label, client, url, kind, body, state, who, expect_refusal=True, denied=False, **data):
    """Direct post (no preview, no token): the refusal says so and `state()` is exactly as before; the file is valid.
    `denied`: the person's role can't reach the import at all (the super admin's alone, 1a-04): a 403, nothing changed."""
    ok, _tok = valid_through_steps(SUP, url, kind, body, SU["id"], **data)
    s.check("%s: the file passes the engine's own check (so what follows is the guard, not a bad file)" % label, ok)
    before = state()
    r = post(client, url, data, body, follow=not denied)
    after = state()
    if denied:
        s.check("%s: the route answers 403 (a role can't import, the tick or not)" % label, r.status_code == 403,
                r.status_code)
        s.check("%s: ...and the same file can't be staged either" % label, post(
            client, url, dict(data, preview="1"), body, follow=False).status_code == 403)
        s.check("%s: ...nothing changed" % label, before == after and all(before), (before, after))
        return
    s.check("%s: a post without the step fields changes nothing" % label, before == after and all(before), (before, after))
    if expect_refusal:
        s.check("%s: ...and says why, sending them back to step 1" % label, REFUSAL in text(r))


try:
    # ---------------------------------------------------------------------------------------------------------------
    s.section("People roster (people.roster): authoritative file, no steps")
    URL = "/admin/import/roster"
    base = {RC["business group"]: BG, RC["company"]: CO}

    def rrow(eid, name, **kw):
        r = dict.fromkeys(a.ROSTER_COLUMNS, "")
        r.update(base)
        r.update({RC["employee id"]: eid, RC["employee name"]: name, RC["manager"]: PFX + "M", RC["hod"]: PFX + "M",
                  RC["job grade"]: "14", RC["joined date"]: "2025-01-06"})
        for k, v in kw.items():
            r[RC[k.replace("_", " ")]] = v
        return [r[c] for c in a.ROSTER_COLUMNS]
    # the file names ONE existing person and a new joiner: authoritative, so everyone else in the group would be closed
    roster = csv_bytes(a.ROSTER_COLUMNS, [rrow(PFX + "A", "ZZ NS A"), rrow(PFX + "N1", "ZZ NS New One")])
    roster_state = lambda: snap(  # noqa: E731
        "SELECT employee_id, left_at IS NOT NULL FROM users WHERE business_group='%s' ORDER BY id" % BG,
        "SELECT COUNT(*) FROM users", "SELECT COUNT(*) FROM users WHERE left_at IS NOT NULL")
    left_n = lambda: H.one(a, "SELECT COUNT(*) FROM users WHERE business_group=? AND left_at IS NOT NULL", (BG,))  # noqa: E731
    refuse("roster, super admin", SUP, URL, "roster", roster, roster_state, SU["id"], mode="authoritative")
    refuse("roster, role-ticked BG admin", BGA, URL, "roster", roster, roster_state, BGADM, denied=True,
           mode="authoritative")
    s.check("   nobody in the group was closed and the joiner was not created", left_n() == 0
            and H.one(a, "SELECT COUNT(*) FROM users WHERE employee_id=?", (PFX + "N1",)) == 0)
    # the four steps still apply: the super admin answers who is kept, and the new joiner is created
    tok = (re.search(r"check=([0-9a-f]{32})", post(SUP, URL, {"preview": "1", "mode": "authoritative"}, roster,
                                                   follow=False).headers["Location"]) or [None, ""])[1]
    SUP.post(URL, data={"csrf_token": "tok", "token": tok, "action": "quality_ok", "ack": "1"})
    with a.app.test_request_context("/"):
        db = a.get_db()
        me = dict(db.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone())
        spec, meta, ctx, q = a._imp_load("roster", db, me, tok)
        picks = {i["fid"]: "keep" for i in a._imp_items(a._rimp_changes(db, me, ctx, {}))}
    SUP.post(URL, data=dict({"csrf_token": "tok", "token": tok, "action": "to_apply"}, **picks))
    SUP.post(URL, data={"csrf_token": "tok", "token": tok, "action": "apply"})
    s.check("through the four steps the same file still applies: the joiner is created, the people left out are kept",
            H.one(a, "SELECT COUNT(*) FROM users WHERE employee_id=?", (PFX + "N1",)) == 1 and bool(picks)
            and left_n() == 0, (len(picks), left_n()))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("the roster page's headcount is the admin's own scope (1a-03)")

    def shown(client):
        m = re.search(r"Today: <b>([\d,]+)</b> active(?:, ([\d,]+) left)?", client.get(URL).get_data(as_text=True))
        return (int(m.group(1).replace(",", "")), int((m.group(2) or "0").replace(",", ""))) if m else None
    mine = lambda left: H.one(  # noqa: E731
        a, "SELECT COUNT(*) FROM users WHERE role='user' AND is_demo=0 AND business_group=? AND left_at IS %s" % left,
        (BG,))
    co_a, co_l = (H.one(a, "SELECT COUNT(*) FROM users WHERE role='user' AND is_demo=0 AND left_at IS %s" % w)
                  for w in ("NULL", "NOT NULL"))
    s.check("the super admin sees the whole company's count", shown(SUP) == (co_a, co_l) and co_a > mine("NULL") > 0,
            (shown(SUP), co_a, co_l))
    s.check("a group admin sees their own group's count, never the company's", shown(BGA) == (mine("NULL"), mine(
        "NOT NULL")) and shown(BGA)[0] < co_a, (shown(BGA), mine("NULL")))

    # ---------------------------------------------------------------------------------------------------------------
    s.section("360 panels (f360.add)")
    URL = "/admin/import"
    phead = list(a.PANEL_IMPORT_COLUMNS)
    panels = csv_bytes(phead, [[PFX + "A", PFX + "R", "peer"]])
    panel_state = lambda: snap("SELECT COUNT(*) FROM assignments WHERE cycle_id=%d" % CID)  # noqa: E731
    refuse("panels, super admin", SUP, URL, "panels", panels, panel_state, SU["id"])
    refuse("panels, role-ticked BG admin", BGA, URL, "panels", panels, panel_state, BGADM, denied=True)
    s.check("   R is not on A's panel", H.one(a, "SELECT COUNT(*) FROM assignments WHERE cycle_id=? AND subject_id=? AND "
                                                 "assessor_id=?", (CID, U["A"], U["R"])) == 0)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("KPI targets (pm.import)")
    URL = "/admin/performance/import"
    kpi = (b"Employee ID,KPI,Focus,Unit of Measure,Weightage,Method,Rate 1,Rate 2,Rate 3,Rate 4,Rate 5,Matrix manager ID\n"
           b"ZZ9NS-A,ZZNS Sales,,%,100,More,80,90,100,110,120,\n")
    kpi_state = lambda: snap("SELECT COUNT(*) FROM pm_kpi_targets WHERE cycle_id=%d" % CID,  # noqa: E731
                             "SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=%d" % U["A"])
    refuse("KPI targets, super admin", SUP, URL, "kti", kpi, kpi_state, SU["id"])
    refuse("KPI targets, role-ticked BG admin", BGA, URL, "kti", kpi, kpi_state, BGADM, denied=True)
    s.check("   A has no KPI line", H.one(a, "SELECT COUNT(*) FROM pm_kpi_targets WHERE subject_id=?", (U["A"],)) == 0)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("Job codes (competency.job)")
    URL = "/admin/competency/import-jobs"
    jobs = csv_bytes(list(a.JOB_IMPORT_COLUMNS), [[PFX + "A", "ZNS-OPS-01-14", ""]])
    job_state = lambda: snap("SELECT COUNT(*) FROM tc_assignments WHERE cycle_id=%d" % CID,  # noqa: E731
                             "SELECT COUNT(*) FROM ja_people WHERE employee_id LIKE 'ZZ9NS-%'")
    refuse("job codes, super admin", SUP, URL, "jobs", jobs, job_state, SU["id"])
    refuse("job codes, role-ticked BG admin", BGA, URL, "jobs", jobs, job_state, BGADM, denied=True)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("KPI library, passwords, clear panels (the super admin's)")
    URL = "/admin/performance/library/import"
    lhead = ["Business Group", "Company", "Department", "Tier", "Job Grade", "KPI", "Strategic Thrust / Category",
             "KPI Description", "Unit of Measure", "Method", "Rate 1", "Rate 2", "Rate 3", "Rate 4", "Rate 5",
             "Weightage Default", "BU Level"]
    lib = csv_bytes(lhead, [[BG, "", "", "", "", "ZZNS Customer complaints closed", "Financial", "", "RM", "More", 1, 2, 3,
                             4, 5, 20, ""]])
    lib_state = lambda: snap("SELECT COUNT(*) FROM pm_kpi_library")  # noqa: E731
    refuse("KPI library, super admin", SUP, URL, "library", lib, lib_state, SU["id"])
    refuse("KPI library, role-ticked BG admin", BGA, URL, "library", lib, lib_state, BGADM, denied=True)
    s.check("   the new KPI is not in the library", H.one(
        a, "SELECT COUNT(*) FROM pm_kpi_library WHERE kpi_name='ZZNS Customer complaints closed'") == 0)

    URL = "/admin/import/passwords"
    pw = csv_bytes(["Employee ID", "Password"], [[PFX + "B", "ZzNs-Pass-9!q"]])
    pw_state = lambda: snap("SELECT password_hash FROM users WHERE id=%d" % U["B"])  # noqa: E731
    refuse("passwords, super admin", SUP, URL, "passwords", pw, pw_state, SU["id"])
    s.check("   B's password is not the file's", not check_password_hash(
        H.one(a, "SELECT password_hash FROM users WHERE id=?", (U["B"],)), "ZzNs-Pass-9!q"))
    ok_, _t = valid_through_steps(SUP, URL, "passwords", pw, SU["id"])
    SUP.post(URL, data={"csrf_token": "tok", "token": _t, "action": "quality_ok"})
    SUP.post(URL, data={"csrf_token": "tok", "token": _t, "action": "to_apply"})
    SUP.post(URL, data={"csrf_token": "tok", "token": _t, "action": "apply"})
    s.check("   through the four steps the same file sets it", check_password_hash(
        H.one(a, "SELECT password_hash FROM users WHERE id=?", (U["B"],)), "ZzNs-Pass-9!q"))

    URL = "/admin/clear-panels"
    with a.app.app_context():   # B has one rater not rated yet
        db = a.get_db()
        db.execute("INSERT INTO assignments(cycle_id, subject_id, assessor_id, relationship, status) VALUES "
                   "(?,?,?, 'peer', 'pending')", (CID, U["B"], U["R"]))
        db.commit()
    clear = csv_bytes(["Employee ID"], [[PFX + "B"]])
    clear_state = lambda: snap("SELECT COUNT(*) FROM assignments WHERE cycle_id=%d" % CID,  # noqa: E731
                               "SELECT COUNT(*) FROM assignments WHERE subject_id=%d" % U["B"])
    refuse("clear panels, super admin", SUP, URL, "clear", clear, clear_state, SU["id"])
    s.check("   B still has the rater", H.one(a, "SELECT COUNT(*) FROM assignments WHERE subject_id=?", (U["B"],)) == 1)

    # ---------------------------------------------------------------------------------------------------------------
    s.section("every route refuses by its own guard, falsified")
    src = H.code_without_docstrings(H.source(a))
    s.check("the helper is the only way a step-less post leaves these routes (no apply left behind it)",
            "_kti_direct" not in src and "_roster_done_flash" not in src and "applies at once" not in H.source(a))
    s.check("a post with no step fields and no file is refused the same way (the file is not what decides)",
            REFUSAL in text(SUP.post("/admin/import/roster", data={"csrf_token": "tok"}, follow_redirects=True)))
except BaseException:
    H.restore_db()   # a failed run leaves nothing for the next suite
    raise

sys.exit(s.done())
