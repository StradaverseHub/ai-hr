"""Proposals to the KPI library (Chris, 2026-10-18: "super edits the libraries and approves BG / unit admins'
proposals"; the libraries canvas boards 10-11).

What this suite holds:
  * the library and its bulk import are the super admin's to change: a BG admin's add or import is refused, and their
    page offers Propose instead of Add, Bulk import, Edit or Retire
  * a BG admin proposes a new KPI (their group, one of its units, or a job family; never Global), with a definition
    and a reason; a name already in their library is refused; the closest library KPI is noted; a unit admin
    proposes for their own units or a job family, not the whole group or another unit; a definition change too
  * the super admin decides on Requests -- approve (a new KPI goes into that group's library; a definition changes in
    every library that has the KPI), point to an existing KPI, or reject with a reason (required) -- each in the
    trail; a BG admin sees only their own proposals and can't decide
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
s = H.Suite("Proposals to the KPI library: BG and unit admins propose, the super admin decides")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)
BG, BG2 = "ZZLR Group", "ZZLR Other"


def _cleanup(db):
    ul = [r[0] for r in db.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZ9LR-%'")]
    db.execute("DELETE FROM pm_library_requests WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM pm_kpi_library WHERE business_group IN (?,?) OR kpi_name LIKE 'ZZLR %'", (BG, BG2))
    if ul:
        ph = ",".join("?" * len(ul))
        db.execute("DELETE FROM activity_log WHERE user_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM admin_companies WHERE admin_id IN (%s)" % ph, ul)
        db.execute("DELETE FROM users WHERE id IN (%s)" % ph, ul)
    db.execute("DELETE FROM activity_log WHERE action='pm_kpi_library' AND detail LIKE '%ZZLR%'")
    db.execute("DELETE FROM pm_kpi_library WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM pm_bg_config WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM org_units WHERE business_group IN (?,?)", (BG, BG2))
    db.execute("DELETE FROM ja_taxonomy WHERE code LIKE 'ZQL%'")
    db.commit()


def req(name):
    r = H.rows(a, "SELECT id, status, kind, payload_json, decision_note FROM pm_library_requests WHERE payload_json "
                  "LIKE ?", ('%' + name + '%',))
    return r[0] if r else None


with a.app.app_context():
    db = a.get_db()
    db.execute("PRAGMA foreign_keys=ON")
    _cleanup(db)
    db.execute("INSERT INTO org_units(business_group, company) VALUES (?, 'U1'),(?, 'U2'),(?, 'U9')", (BG, BG, BG2))
    db.execute("INSERT INTO pm_bg_config(business_group, mechanism) VALUES (?, 'A'),(?, 'A')", (BG, BG2))
    db.execute("INSERT INTO ja_taxonomy(code, level, parent_code, name) VALUES ('ZQL', 'family', NULL, 'ZQL'),"
               "('ZQL-SAL', 'sub', 'ZQL', 'ZQL Sales')")
    for bg in (BG, BG2):
        db.execute("INSERT INTO pm_kpi_library(business_group, company, department, tier_n, job_grade, kpi_name, "
                   "description, unit, method) VALUES (?, '*', '*', 0, '*', 'ZZLR Collection achievement', "
                   "'old words', '%', 'more')", (bg,))
    BGA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                     "admin_bg, email) VALUES ('zz9lr-bga', 'ZZ LR Groupadmin', 'x', 'admin', 'ZZ9LR-BGA', ?, ?, "
                     "'zz9lr@example.invalid')", (BG, BG)).lastrowid
    UNA = db.execute("INSERT INTO users (username, full_name, password_hash, role, employee_id, business_group, "
                     "admin_bg) VALUES ('zz9lr-una', 'ZZ LR Unitadmin', 'x', 'admin', 'ZZ9LR-UNA', ?, ?)",
                     (BG, BG)).lastrowid
    db.execute("INSERT INTO admin_companies(admin_id, company) VALUES (?, 'U1')", (UNA,))
    db.commit()
SUP = H.client_as(a, SU["id"])
BA = H.client_as(a, BGA)
UA = H.client_as(a, UNA)


def propose(client, **kw):
    d = {"csrf_token": "tok", "kind": "new_kpi", "scope": "bg", "name": "ZZLR Collection rate", "method": "more",
         "definition": "Cash collected against invoices due, as a percentage", "unit": "%", "reason": "Sales carry it"}
    d.update(kw)
    return client.post("/admin/performance/library/propose", data=d, follow_redirects=True)


try:
    s.section("the library is the super admin's to change")
    r = BA.post("/admin/performance/library", data={"csrf_token": "tok", "action": "add", "business_group": BG,
                                                    "kpi_name": "ZZLR Sneaky", "method": "more", "tier_n": "0"})
    s.check("a BG admin's add is refused", r.status_code == 403 and not H.rows(
        a, "SELECT 1 FROM pm_kpi_library WHERE kpi_name='ZZLR Sneaky'"))
    r = BA.post("/admin/performance/library/import", data={"csrf_token": "tok", "file": (io.BytesIO(
        b"Business Group,KPI,Method\nZZLR Group,ZZLR Imported,More\n"), "l.csv")}, content_type="multipart/form-data")
    s.check("...and so is their bulk import", r.status_code == 403)
    pg = BA.get("/admin/performance/library?node=bg:" + BG).get_data(as_text=True)
    s.check("their page offers Propose, not Add or Bulk import", "Propose a KPI" in pg and ">Add a KPI</a>" not in pg
            and "Bulk import" not in pg)
    pg = BA.get("/admin/performance/library?panel=kpi&kpi=zzlr+collection+achievement&node=global").get_data(
        as_text=True)
    s.check("...and in a KPI's panel, Propose a change rather than Edit or Retire", "Propose a change to the definition"
            in pg and 'value="toggle_active"' not in pg and 'value="update"' not in pg)
    pg = SUP.get("/admin/performance/library?panel=kpi&kpi=zzlr+collection+achievement&node=global").get_data(
        as_text=True)
    s.check("the super admin's panel keeps Edit and Retire", 'value="toggle_active"' in pg and 'value="update"' in pg)

    s.section("proposing")
    propose(BA, reason="")
    s.check("a proposal needs a reason", req("ZZLR Collection rate") is None)
    propose(BA, name="ZZLR Collection achievement")
    s.check("a name already in their library is refused", req('"name": "ZZLR Collection achievement"') is None)
    propose(BA)
    r_ = req("ZZLR Collection rate")
    s.check("a new KPI for their group waits for the super admin", r_ and r_[1] == "waiting" and r_[2] == "new_kpi")
    s.check("...with the closest library KPI noted", r_ and "ZZLR Collection achievement" in r_[3])
    propose(BA, name="ZZLR Global thing", scope="global")
    s.check("Global isn't theirs to propose", req("ZZLR Global thing") is None)
    propose(UA, name="ZZLR Unit wide", scope="bg")
    s.check("a unit admin can't propose for the whole group", req("ZZLR Unit wide") is None)
    propose(UA, name="ZZLR Other unit", scope="unit", company="U2")
    s.check("...nor for another unit", req("ZZLR Other unit") is None)
    propose(UA, name="ZZLR Unit one", scope="unit", company="U1")
    propose(UA, name="ZZLR Family one", scope="jf", family="ZQL-SAL")
    s.check("...but for their own unit, or a job family", req("ZZLR Unit one") and req("ZZLR Family one"))
    BA.post("/admin/performance/library/propose", data={"csrf_token": "tok", "kind": "change_def",
                                                       "kpi": "zzlr collection achievement",
                                                       "definition": "Cash collected against the collection target",
                                                       "reason": "The old words say nothing"})
    s.check("a definition change waits too", req("against the collection target"))
    r = SUP.post("/admin/performance/library/propose", data={"csrf_token": "tok", "kind": "new_kpi", "name": "x",
                                                            "reason": "y"})
    s.check("the super admin edits directly, so doesn't propose", r.status_code == 403)

    s.section("who sees and decides")
    pg = SUP.get("/admin/performance/library/requests").get_data(as_text=True)
    s.check("the super admin sees every waiting proposal, each decided through a confirm box",
            "ZZLR Collection rate" in pg and "ZZLR Unit one" in pg and pg.count('data-confirm="') >= 8)
    pg = BA.get("/admin/performance/library/requests").get_data(as_text=True)
    s.check("a BG admin sees only their own, and no buttons", "ZZLR Collection rate" in pg and "ZZLR Unit one" not in pg
            and 'value="approve"' not in pg)
    r = BA.post("/admin/performance/library/requests", data={"csrf_token": "tok", "request_id": req(
        "ZZLR Collection rate")[0], "action": "approve"})
    s.check("...and can't decide", r.status_code == 403 and req("ZZLR Collection rate")[1] == "waiting")

    s.section("deciding")
    out = SUP.post("/admin/performance/library/requests", data={"csrf_token": "tok", "request_id": req(
        "ZZLR Collection rate")[0], "action": "approve"}, follow_redirects=True).get_data(as_text=True)
    row = H.rows(a, "SELECT business_group, company, description, unit, method FROM pm_kpi_library WHERE "
                    "kpi_name='ZZLR Collection rate'")
    s.check("approve: into that group's library, as proposed", row and tuple(row[0]) == (
        BG, "*", "Cash collected against invoices due, as a percentage", "%", "more") and req(
        "ZZLR Collection rate")[1] == "approved", row and tuple(row[0]))
    s.check("...the email said for (none on this server)", "No email" in out)
    SUP.post("/admin/performance/library/requests", data={"csrf_token": "tok", "request_id": req("ZZLR Unit one")[0],
                                                          "action": "approve"})
    s.check("a unit's KPI goes in for that unit", H.one(a, "SELECT company FROM pm_kpi_library WHERE kpi_name="
                                                          "'ZZLR Unit one'") == "U1")
    SUP.post("/admin/performance/library/requests", data={"csrf_token": "tok", "request_id": req(
        "ZZLR Family one")[0], "action": "reject"})
    s.check("reject without a reason changes nothing", req("ZZLR Family one")[1] == "waiting")
    SUP.post("/admin/performance/library/requests", data={"csrf_token": "tok", "request_id": req(
        "ZZLR Family one")[0], "action": "reject", "note": "Too close to an existing one"})
    s.check("...with one, rejected and the reason kept", tuple(req("ZZLR Family one")[1::3]) == (
        "rejected", "Too close to an existing one"))
    propose(BA, name="ZZLR Cash in")
    SUP.post("/admin/performance/library/requests", data={"csrf_token": "tok", "request_id": req("ZZLR Cash in")[0],
                                                          "action": "merge", "into": "ZZLR Collection achievement"})
    s.check("point to an existing KPI: nothing added, the proposer told which", req("ZZLR Cash in")[1] == "merged"
            and "ZZLR Collection achievement" in (req("ZZLR Cash in")[4] or "") and not H.rows(
                a, "SELECT 1 FROM pm_kpi_library WHERE kpi_name='ZZLR Cash in'"))
    SUP.post("/admin/performance/library/requests", data={"csrf_token": "tok", "request_id": req(
        "against the collection target")[0], "action": "approve"})
    defs = {r[0] for r in H.rows(a, "SELECT description FROM pm_kpi_library WHERE kpi_name="
                                    "'ZZLR Collection achievement'")}
    s.check("a definition change reaches every library that has the KPI", defs == {
        "Cash collected against the collection target"}, defs)
    s.check("every decision is in the trail", H.one(a, "SELECT COUNT(*) FROM activity_log WHERE action="
                                                      "'pm_kpi_library' AND detail LIKE 'request %'") >= 5)
    pg = BA.get("/admin/performance/library/requests?tab=decided").get_data(as_text=True)
    s.check("the proposer sees the answers", "Approved" in pg and "Pointed to a KPI" in pg)
finally:
    with a.app.app_context():
        _db = a.get_db()
        _db.execute("PRAGMA foreign_keys=ON")
        _cleanup(_db)

sys.exit(s.done())
